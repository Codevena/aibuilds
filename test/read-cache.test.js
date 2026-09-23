'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createGenerationCache,
  createSemaphore,
  createLruBytesCache,
  createSingleFlight,
} = require('../server/read-cache.js');

function fakeClock(start = 0) {
  let t = start;
  return { now: () => t, advance(ms) { t += ms; } };
}

// ---- createGenerationCache ----

test('generation cache: miss on an unknown key', () => {
  const cache = createGenerationCache({ ttlMs: 1000 });
  assert.equal(cache.get('a'), undefined);
});

test('generation cache: set then get within TTL returns the value', () => {
  const clock = fakeClock();
  const cache = createGenerationCache({ ttlMs: 1000, now: clock.now });
  cache.set('a', 'value-a', cache.generation());
  assert.equal(cache.get('a'), 'value-a');
});

test('generation cache: entry expires after ttlMs', () => {
  const clock = fakeClock();
  const cache = createGenerationCache({ ttlMs: 1000, now: clock.now });
  cache.set('a', 'value-a', cache.generation());
  clock.advance(999);
  assert.equal(cache.get('a'), 'value-a');
  clock.advance(2);
  assert.equal(cache.get('a'), undefined);
});

test('generation cache: value computed before bump() is not served after it (with -> without)', () => {
  const cache = createGenerationCache({ ttlMs: 10_000 });
  const genAtStart = cache.generation();
  cache.bump(); // a mutation happens while "computation" was in flight
  cache.set('a', 'stale-value', genAtStart); // set() is called with the now-stale generation
  assert.equal(cache.get('a'), undefined, 'a set() against a stale generation must be ignored');
});

test('generation cache: without the generation check, a stale set would be served (documents the guard)', () => {
  // Same scenario, but simulating the mechanism being absent: passing the CURRENT generation
  // instead of the generation captured before the computation started shows the value that
  // WOULD be cached if nothing checked staleness.
  const cache = createGenerationCache({ ttlMs: 10_000 });
  cache.bump();
  cache.set('a', 'stale-value', cache.generation()); // generation matches "now" -> stored
  assert.equal(cache.get('a'), 'stale-value');
});

test('generation cache: bump() invalidates all previously-set entries immediately', () => {
  const cache = createGenerationCache({ ttlMs: 10_000 });
  cache.set('a', 1, cache.generation());
  cache.set('b', 2, cache.generation());
  assert.equal(cache.get('a'), 1);
  cache.bump();
  assert.equal(cache.get('a'), undefined);
  assert.equal(cache.get('b'), undefined);
});

test('generation cache: entries set after bump() with the new generation are servable', () => {
  const cache = createGenerationCache({ ttlMs: 10_000 });
  cache.bump();
  cache.set('a', 'fresh', cache.generation());
  assert.equal(cache.get('a'), 'fresh');
});

test('generation cache: maxEntries evicts the oldest entry (FIFO)', () => {
  const cache = createGenerationCache({ ttlMs: 10_000, maxEntries: 2 });
  const gen = cache.generation();
  cache.set('a', 1, gen);
  cache.set('b', 2, gen);
  cache.set('c', 3, gen); // evicts 'a'
  assert.equal(cache.get('a'), undefined);
  assert.equal(cache.get('b'), 2);
  assert.equal(cache.get('c'), 3);
});

test('generation cache: rejects invalid ttlMs/maxEntries', () => {
  assert.throws(() => createGenerationCache({ ttlMs: 0 }));
  assert.throws(() => createGenerationCache({ ttlMs: -1 }));
  assert.throws(() => createGenerationCache({ ttlMs: 1000, maxEntries: 0 }));
});

// ---- createSemaphore ----

test('semaphore: acquire up to the limit resolves immediately, active() tracks it', async () => {
  const sem = createSemaphore({ limit: 2, maxWaiters: 16 });
  const r1 = await sem.acquire();
  const r2 = await sem.acquire();
  assert.equal(sem.active(), 2);
  assert.equal(sem.waiting(), 0);
  r1();
  r2();
  assert.equal(sem.active(), 0);
});

test('semaphore: limit 2 with 16 max waiters -- 3rd call waits, 17th waiter is rejected', async () => {
  const sem = createSemaphore({ limit: 2, maxWaiters: 16 });
  const releases = [];
  // Fill the 2 active slots.
  releases.push(await sem.acquire());
  releases.push(await sem.acquire());

  // The 3rd through 18th acquire() calls (16 of them) become waiters -- all must be pending,
  // none rejected.
  const waiterPromises = [];
  for (let i = 0; i < 16; i++) {
    waiterPromises.push(sem.acquire());
  }
  assert.equal(sem.waiting(), 16, 'exactly 16 callers are queued');

  // The 17th waiter (19th acquire() overall) must be rejected with SEMAPHORE_FULL.
  await assert.rejects(
    () => sem.acquire(),
    (err) => err.code === 'SEMAPHORE_FULL',
  );
  assert.equal(sem.waiting(), 16, 'the rejected caller never joined the queue');

  // Draining: release the 2 active permits, the first two waiters should now become active.
  releases[0]();
  releases[1]();
  const [rel3, rel4] = await Promise.all([waiterPromises[0], waiterPromises[1]]);
  assert.equal(typeof rel3, 'function');
  assert.equal(typeof rel4, 'function');
  assert.equal(sem.active(), 2);
  assert.equal(sem.waiting(), 14);

  // Clean up remaining waiters/permits so the test does not leak pending promises.
  rel3();
  rel4();
  let cursor = 2;
  while (sem.waiting() > 0) {
    const release = await waiterPromises[cursor];
    cursor += 1;
    release();
  }
});

test('semaphore: without a maxWaiters check, the 17th waiter would also queue (documents the guard)', async () => {
  const sem = createSemaphore({ limit: 2, maxWaiters: 1_000_000 });
  const releases = [];
  releases.push(await sem.acquire());
  releases.push(await sem.acquire());
  for (let i = 0; i < 16; i++) sem.acquire();
  // The 17th waiter no longer rejects -- it queues instead (this is what M-style "guard removed"
  // looks like when the check is absent).
  const result = await Promise.race([
    sem.acquire().then(() => 'queued-or-resolved', () => 'rejected'),
    new Promise((resolve) => setImmediate(() => resolve('still-pending'))),
  ]);
  assert.notEqual(result, 'rejected');
  releases[0]();
  releases[1]();
});

test('semaphore: release is idempotent (calling it twice does not free two slots)', async () => {
  const sem = createSemaphore({ limit: 1, maxWaiters: 4 });
  const release = await sem.acquire();
  release();
  release(); // no-op
  assert.equal(sem.active(), 0);
});

test('semaphore: rejects invalid limit/maxWaiters', () => {
  assert.throws(() => createSemaphore({ limit: 0, maxWaiters: 1 }));
  assert.throws(() => createSemaphore({ limit: 1, maxWaiters: -1 }));
});

// ---- createLruBytesCache ----

test('lru cache: get on a missing key returns undefined', () => {
  const cache = createLruBytesCache({ maxEntries: 4, maxBytes: 1000 });
  assert.equal(cache.get('missing'), undefined);
});

test('lru cache: set then get returns the value; size()/bytes() track it', () => {
  const cache = createLruBytesCache({ maxEntries: 4, maxBytes: 1000, sizeOf: () => 10 });
  cache.set('a', 'hello');
  assert.equal(cache.get('a'), 'hello');
  assert.equal(cache.size(), 1);
  assert.equal(cache.bytes(), 10);
});

test('lru cache: evicts least-recently-used entry when maxEntries is exceeded', () => {
  const cache = createLruBytesCache({ maxEntries: 2, maxBytes: 100_000, sizeOf: () => 1 });
  cache.set('a', 1);
  cache.set('b', 2);
  cache.get('a'); // touch 'a' -> 'b' becomes least recently used
  cache.set('c', 3); // evicts 'b'
  assert.equal(cache.get('b'), undefined);
  assert.equal(cache.get('a'), 1);
  assert.equal(cache.get('c'), 3);
  assert.equal(cache.size(), 2);
});

test('lru cache: evicts oldest entries when maxBytes is exceeded', () => {
  const sizes = { a: 10, b: 10, c: 10 };
  const cache = createLruBytesCache({ maxEntries: 100, maxBytes: 25, sizeOf: (v) => sizes[v] });
  cache.set('a', 'a');
  cache.set('b', 'b');
  cache.set('c', 'c'); // total would be 30 > 25 -> evict oldest ('a') to fit
  assert.equal(cache.get('a'), undefined);
  assert.equal(cache.get('b'), 'b');
  assert.equal(cache.get('c'), 'c');
  assert.ok(cache.bytes() <= 25);
});

test('lru cache: re-setting an existing key updates its size accounting and recency', () => {
  const cache = createLruBytesCache({ maxEntries: 4, maxBytes: 1000, sizeOf: (v) => v.length });
  cache.set('a', 'short');
  cache.set('a', 'much-longer-value');
  assert.equal(cache.bytes(), 'much-longer-value'.length);
  assert.equal(cache.size(), 1);
});

test('lru cache: rejects invalid maxEntries/maxBytes', () => {
  assert.throws(() => createLruBytesCache({ maxEntries: 0, maxBytes: 10 }));
  assert.throws(() => createLruBytesCache({ maxEntries: 10, maxBytes: 0 }));
});

test('lru cache: default sizeOf measures UTF-8 byte length of strings', () => {
  const cache = createLruBytesCache({ maxEntries: 4, maxBytes: 1000 });
  cache.set('a', 'héllo'); // 'é' is 2 bytes in UTF-8
  assert.equal(cache.bytes(), Buffer.byteLength('héllo', 'utf8'));
});

// ---- createSingleFlight ----

test('single-flight: concurrent calls with the same key share one in-flight promise, fn runs once', async () => {
  const sf = createSingleFlight();
  let calls = 0;
  const fn = () => {
    calls += 1;
    return new Promise((resolve) => setTimeout(() => resolve('result'), 10));
  };
  const [r1, r2, r3] = await Promise.all([sf.run('key', fn), sf.run('key', fn), sf.run('key', fn)]);
  assert.equal(calls, 1, 'fn must run exactly once for concurrent calls sharing a key');
  assert.equal(r1, 'result');
  assert.equal(r2, 'result');
  assert.equal(r3, 'result');
});

test('single-flight: different keys run independently', async () => {
  const sf = createSingleFlight();
  let calls = 0;
  const fn = (key) => { calls += 1; return Promise.resolve(key); };
  const [ra, rb] = await Promise.all([sf.run('a', () => fn('a')), sf.run('b', () => fn('b'))]);
  assert.equal(calls, 2);
  assert.equal(ra, 'a');
  assert.equal(rb, 'b');
});

test('single-flight: after completion, a new call for the same key runs fn again', async () => {
  const sf = createSingleFlight();
  let calls = 0;
  const fn = () => { calls += 1; return Promise.resolve(calls); };
  const first = await sf.run('key', fn);
  const second = await sf.run('key', fn);
  assert.equal(first, 1);
  assert.equal(second, 2);
  assert.equal(calls, 2);
});

test('single-flight: a rejected fn is not cached -- the next call retries', async () => {
  const sf = createSingleFlight();
  let calls = 0;
  const fn = () => {
    calls += 1;
    return calls === 1 ? Promise.reject(new Error('boom')) : Promise.resolve('ok');
  };
  await assert.rejects(() => sf.run('key', fn));
  const result = await sf.run('key', fn);
  assert.equal(result, 'ok');
  assert.equal(calls, 2);
});

test('single-flight: concurrent calls that share a rejecting in-flight promise all reject', async () => {
  const sf = createSingleFlight();
  let calls = 0;
  const fn = () => { calls += 1; return Promise.reject(new Error('shared failure')); };
  const results = await Promise.allSettled([sf.run('key', fn), sf.run('key', fn)]);
  assert.equal(calls, 1);
  assert.equal(results[0].status, 'rejected');
  assert.equal(results[1].status, 'rejected');
});
