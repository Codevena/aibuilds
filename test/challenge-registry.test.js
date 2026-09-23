'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createChallengeRegistry } = require('../server/challenge-registry.js');

function fakeClock(start = 0) {
  let t = start;
  return {
    now: () => t,
    advance(ms) { t += ms; },
  };
}

function makeRegistry(overrides = {}) {
  const clock = overrides.clock || fakeClock();
  let counter = 0;
  const registry = createChallengeRegistry({
    ttlMs: overrides.ttlMs ?? 5 * 60 * 1000,
    maxPerOwner: overrides.maxPerOwner ?? 60,
    maxGlobal: overrides.maxGlobal ?? 5000,
    now: clock.now,
    randomUUID: overrides.randomUUID || (() => `id-${++counter}`),
    randomBytes: overrides.randomBytes || ((n) => Buffer.alloc(n, 1)),
  });
  return { registry, clock };
}

test('issue returns id, prefix (32 hex chars) and expiresAt', () => {
  const { registry, clock } = makeRegistry();
  const result = registry.issue('owner-a');
  assert.equal(typeof result.id, 'string');
  assert.match(result.prefix, /^[0-9a-f]{32}$/);
  assert.equal(result.expiresAt, clock.now() + 5 * 60 * 1000);
});

test('owner cap: 60 issues ok, 61st is owner-cap (with -> without)', () => {
  const { registry } = makeRegistry({ maxPerOwner: 60 });
  for (let i = 0; i < 60; i++) {
    const r = registry.issue('owner-a');
    assert.equal(r.error, undefined, `issue ${i + 1} should succeed`);
  }
  const blocked = registry.issue('owner-a');
  assert.deepEqual(blocked, { error: 'owner-cap' });
});

test('without the owner cap, the 61st issue would also succeed (documents the guard)', () => {
  // Same scenario as above but with a cap effectively disabled (very high) to show the guarded
  // quantity WITHOUT the mechanism: the 61st issue succeeds instead of being rejected.
  const { registry } = makeRegistry({ maxPerOwner: 1_000_000 });
  for (let i = 0; i < 60; i++) registry.issue('owner-a');
  const result = registry.issue('owner-a');
  assert.equal(result.error, undefined);
});

test('consuming one challenge frees an owner-cap slot', () => {
  const { registry } = makeRegistry({ maxPerOwner: 60 });
  const issued = [];
  for (let i = 0; i < 60; i++) issued.push(registry.issue('owner-a'));
  assert.deepEqual(registry.issue('owner-a'), { error: 'owner-cap' });
  assert.equal(registry.consume(issued[0].id), true);
  const afterConsume = registry.issue('owner-a');
  assert.equal(afterConsume.error, undefined);
});

test('expired challenges free capacity after TTL + 1ms', () => {
  const { registry, clock } = makeRegistry({ maxPerOwner: 60, ttlMs: 5 * 60 * 1000 });
  for (let i = 0; i < 60; i++) registry.issue('owner-a');
  assert.deepEqual(registry.issue('owner-a'), { error: 'owner-cap' });
  clock.advance(5 * 60 * 1000 + 1);
  for (let i = 0; i < 60; i++) {
    const r = registry.issue('owner-a');
    assert.equal(r.error, undefined, `post-expiry issue ${i + 1} should succeed`);
  }
});

test('get returns null for missing or expired ids and removes expired entries', () => {
  const { registry, clock } = makeRegistry({ ttlMs: 1000 });
  const { id } = registry.issue('owner-a');
  assert.notEqual(registry.get(id), null);
  assert.equal(registry.get('missing-id'), null);
  clock.advance(1001);
  assert.equal(registry.get(id), null);
  assert.equal(registry.size(), 0);
});

test('consume removes the id from its owner set (Gate R2-2)', () => {
  const { registry } = makeRegistry();
  const { id } = registry.issue('owner-a');
  assert.equal(registry.ownerOpen('owner-a'), 1);
  assert.equal(registry.consume(id), true);
  assert.equal(registry.ownerOpen('owner-a'), 0);
  assert.equal(registry.ownerCount(), 0);
  // consuming twice is not possible
  assert.equal(registry.consume(id), false);
});

test('consume on an expired id returns false and removes it', () => {
  const { registry, clock } = makeRegistry({ ttlMs: 1000 });
  const { id } = registry.issue('owner-a');
  clock.advance(1001);
  assert.equal(registry.consume(id), false);
  assert.equal(registry.size(), 0);
  assert.equal(registry.ownerCount(), 0);
});

test('sweep removes all expired entries and cleans owner sets', () => {
  const { registry, clock } = makeRegistry({ ttlMs: 1000 });
  registry.issue('owner-a');
  registry.issue('owner-b');
  clock.advance(1001);
  registry.sweep();
  assert.equal(registry.size(), 0);
  assert.equal(registry.ownerCount(), 0);
});

test('sweep leaves unexpired entries untouched', () => {
  const { registry, clock } = makeRegistry({ ttlMs: 1000 });
  const { id } = registry.issue('owner-a');
  clock.advance(500);
  registry.sweep();
  assert.notEqual(registry.get(id), null);
});

test('D7: at maxGlobal the globally oldest challenge is evicted before storing (with -> without)', () => {
  const { registry } = makeRegistry({ maxPerOwner: 1000, maxGlobal: 5000 });
  const owners = [];
  for (let o = 0; o < 84; o++) owners.push(`owner-${o}`);
  let firstId = null;
  let count = 0;
  outer:
  for (const owner of owners) {
    for (let i = 0; i < 60; i++) {
      const r = registry.issue(owner);
      assert.equal(r.error, undefined);
      if (firstId === null) firstId = r.id;
      count += 1;
      if (count >= 5000) break outer;
    }
  }
  assert.equal(count, 5000);
  assert.equal(registry.size(), 5000);

  // 5001st, from a brand-new owner, succeeds and evicts the globally oldest.
  const extra = registry.issue('owner-new');
  assert.equal(extra.error, undefined);
  assert.equal(registry.size(), 5000, 'registry size stays capped at maxGlobal');
  assert.equal(registry.consume(firstId), false, 'the evicted (oldest) id no longer consumes');
});

test('D7 eviction cleans the evicted owner\'s set and never leaves owners.size over live owners', () => {
  const { registry } = makeRegistry({ maxPerOwner: 1000, maxGlobal: 3 });
  registry.issue('owner-a'); // oldest, will be evicted
  registry.issue('owner-b');
  registry.issue('owner-c');
  assert.equal(registry.ownerOpen('owner-a'), 1);
  assert.equal(registry.ownerCount(), 3);

  const result = registry.issue('owner-d');
  assert.equal(result.error, undefined);
  assert.equal(registry.size(), 3);
  // owner-a's only challenge was the globally oldest and got evicted -> its set shrank to 0 and
  // its owner entry was removed entirely (not left behind as a phantom empty Set).
  assert.equal(registry.ownerOpen('owner-a'), 0);
  assert.equal(registry.ownerCount(), 3, 'owners.size never exceeds the number of owners with a live challenge');
});

test('two different owners have independent caps', () => {
  const { registry } = makeRegistry({ maxPerOwner: 2 });
  assert.equal(registry.issue('owner-a').error, undefined);
  assert.equal(registry.issue('owner-a').error, undefined);
  assert.deepEqual(registry.issue('owner-a'), { error: 'owner-cap' });
  assert.equal(registry.issue('owner-b').error, undefined, 'a different owner is not affected');
});

test('size() and ownerCount() reflect the live registry', () => {
  const { registry } = makeRegistry();
  assert.equal(registry.size(), 0);
  assert.equal(registry.ownerCount(), 0);
  registry.issue('owner-a');
  registry.issue('owner-a');
  registry.issue('owner-b');
  assert.equal(registry.size(), 3);
  assert.equal(registry.ownerCount(), 2);
});

test('prefix bytes come from the injected randomBytes(16)', () => {
  let requestedSize = null;
  const { registry } = makeRegistry({
    randomBytes: (n) => { requestedSize = n; return Buffer.alloc(n, 0xab); },
  });
  const { prefix } = registry.issue('owner-a');
  assert.equal(requestedSize, 16);
  assert.equal(prefix, 'ab'.repeat(16));
});
