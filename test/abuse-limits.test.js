'use strict';

// Unit and in-process tests for server/rate-limit-store.js and server/abuse-limits.js (T2 of
// docs/superpowers/plans/2026-09-23-abuse-authz-hardening.md).
//
// Everything below runs an in-process Express app on port 0 with a fake-clock store, per the
// plan's T2 test list. The spawned-server integration tests of T3 (real server/index.js,
// CLIENT_IP_MODE=cloudflare over loopback, actual routes) are appended to this same file later -
// keep new top-level test() blocks additive and avoid relying on file-scoped mutable state from
// this section.
//
// Per the plan: "fake-clock tests assert status codes only; Retry-After is computed by erl
// against the real clock and is asserted only in the spawned-server tests." The 503 responses
// this module sends itself (provenance/store failures) use a literal 'Retry-After: 30' and are
// asserted directly since they do not depend on erl's internal clock.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const { BoundedMemoryStore } = require('../server/rate-limit-store');
const { POLICIES, createAbuseLimits } = require('../server/abuse-limits');
const { parseClientIpConfig, createClientIpResolver } = require('../server/client-ip');

// --- shared test app fixture -------------------------------------------------

// Builds a fresh Express app wired with the abuse limiters, listening on 127.0.0.1:0. All
// requests must originate from loopback (the fixture connects via fetch to 127.0.0.1), which is
// declared as the trusted proxy CIDR; a CF-Connecting-IP header supplies the simulated client IP.
async function buildTestApp({
  enforcement = 'enforce',
  storeFactory,
  log = () => {},
  now,
} = {}) {
  const config = parseClientIpConfig({
    CLIENT_IP_MODE: 'cloudflare',
    ABUSE_ENFORCEMENT: enforcement,
    TRUSTED_PROXY_CIDRS: '127.0.0.1/32,::1/128',
  });
  const resolver = createClientIpResolver(config);
  const limits = createAbuseLimits({
    resolver,
    config,
    storeFactory: storeFactory || (() => new BoundedMemoryStore({ now })),
    log,
    now,
  });

  const app = express();
  app.use(express.json());

  const hits = { guestbook: 0, diff: 0, read: 0 };
  const ok = (req, res) => res.status(200).json({ ok: true });

  app.post('/api/guestbook', ...limits.routes.guestbook, (req, res) => {
    hits.guestbook += 1;
    res.status(200).json({ ok: true });
  });
  app.put('/api/agents/:name/profile', ...limits.routes.profile, ok);
  app.post('/api/vote', ...limits.routes.vote, ok);
  app.post('/api/contributions/:id/reactions', ...limits.routes.reaction, ok);
  app.post('/api/contributions/:id/comments', ...limits.routes.commentContribution, ok);
  app.post('/api/files/comments', ...limits.routes.commentFile, ok);
  app.post('/api/contribute', ...limits.routes.contribute, ok);
  app.get('/api/contributions/:id/diff', ...limits.routes.diff, (req, res) => {
    hits.diff += 1;
    res.status(200).json({ ok: true });
  });
  // Sections is mounted exactly once, matched exactly (not as a prefix - Gate R1-W2), per §3
  // ("only there" - Gate R2-6): the route handler below carries no second `read` call.
  app.get('/api/world/sections', limits.limit('read'), (req, res, next) => next());
  app.get('/api/world/sections', (req, res) => {
    hits.read += 1;
    res.status(200).json({ ok: true });
  });
  app.get('/api/network/graph', ...limits.routes.read, (req, res) => {
    hits.read += 1;
    res.status(200).json({ ok: true });
  });
  app.get('/api/search', ...limits.routes.read, (req, res) => {
    hits.read += 1;
    res.status(200).json({ ok: true });
  });
  app.get('/api/files', ...limits.routes.read, (req, res) => {
    hits.read += 1;
    res.status(200).json({ ok: true });
  });

  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();

  return {
    limits,
    hits,
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

function withCfIp(ip, extraHeaders = {}) {
  return { 'CF-Connecting-IP': ip, ...extraHeaders };
}

async function post(baseUrl, path, ip, extraHeaders) {
  return fetch(baseUrl + path, { method: 'POST', headers: withCfIp(ip, extraHeaders) });
}

async function put(baseUrl, path, ip, extraHeaders) {
  return fetch(baseUrl + path, { method: 'PUT', headers: withCfIp(ip, extraHeaders) });
}

async function get(baseUrl, path, ip, extraHeaders) {
  return fetch(baseUrl + path, { method: 'GET', headers: withCfIp(ip, extraHeaders) });
}

// --- POLICIES table ----------------------------------------------------------

test('POLICIES: exact §3 table (name, windowMs, max, failureClass, shadowable)', () => {
  const expected = {
    write: { windowMs: 60_000, max: 30, failureClass: 'closed', shadowable: false },
    admin: { windowMs: 60_000, max: 5, failureClass: 'closed', shadowable: false },
    challenge: { windowMs: 60_000, max: 60, failureClass: 'closed', shadowable: false },
    guestbook: { windowMs: 60_000, max: 6, failureClass: 'closed', shadowable: true },
    profile: { windowMs: 60_000, max: 6, failureClass: 'closed', shadowable: true },
    vote: { windowMs: 60_000, max: 12, failureClass: 'closed', shadowable: true },
    reaction: { windowMs: 60_000, max: 20, failureClass: 'closed', shadowable: true },
    'comment-contribution': { windowMs: 60_000, max: 10, failureClass: 'closed', shadowable: true },
    'comment-file': { windowMs: 60_000, max: 10, failureClass: 'closed', shadowable: true },
    'contribute-minute': { windowMs: 60_000, max: 6, failureClass: 'closed', shadowable: true },
    'contribute-hour': { windowMs: 3_600_000, max: 30, failureClass: 'closed', shadowable: true },
    diff: { windowMs: 60_000, max: 10, failureClass: 'open', shadowable: true },
    read: { windowMs: 60_000, max: 60, failureClass: 'open', shadowable: true },
    'ws-upgrade': { windowMs: 60_000, max: 20, failureClass: 'closed', shadowable: true },
  };
  assert.deepEqual(Object.keys(POLICIES).sort(), Object.keys(expected).sort());
  for (const [name, values] of Object.entries(expected)) {
    assert.deepEqual(POLICIES[name], values, name);
  }
  assert.equal(Object.isFrozen(POLICIES), true);
  assert.equal(Object.isFrozen(POLICIES.write), true);
});

// --- BoundedMemoryStore (pure unit) ------------------------------------------

test('BoundedMemoryStore: fixed window resets at windowMs', async () => {
  let currentTime = 1_000_000;
  const store = new BoundedMemoryStore({ now: () => currentTime });
  store.init({ windowMs: 1_000 });

  assert.equal((await store.increment('k')).totalHits, 1);
  assert.equal((await store.increment('k')).totalHits, 2);

  currentTime += 1_001; // window elapsed
  assert.equal((await store.increment('k')).totalHits, 1, 'window must reset, not accumulate');
});

test('BoundedMemoryStore: oldest-key eviction keeps size <= maxKeys (with -> without: 4 keys stay 3 vs grow to 4)', async () => {
  const store = new BoundedMemoryStore({ maxKeys: 3, now: () => 1_000_000 });
  store.init({ windowMs: 60_000 });

  await store.increment('a');
  await store.increment('b');
  await store.increment('c');
  assert.equal(store.size, 3);

  await store.increment('d'); // over capacity - oldest ('a') must be evicted
  assert.equal(store.size, 3, 'size must stay bounded at maxKeys');
  assert.equal(await store.get('a'), undefined, 'the oldest key must have been evicted');
  assert.notEqual(await store.get('d'), undefined, 'the newest key must survive');
});

test('BoundedMemoryStore: decrement, resetKey and resetAll', async () => {
  const store = new BoundedMemoryStore({ now: () => 1_000_000 });
  store.init({ windowMs: 60_000 });
  await store.increment('k');
  await store.increment('k');
  await store.decrement('k');
  assert.equal((await store.get('k')).totalHits, 1);
  await store.resetKey('k');
  assert.equal(await store.get('k'), undefined);
  await store.increment('x');
  await store.increment('y');
  await store.resetAll();
  assert.equal(await store.get('x'), undefined);
  assert.equal(await store.get('y'), undefined);
});

// --- exact limits, per policy -------------------------------------------------

test('guestbook: 6 -> 200, 7th -> 429 (with -> without: 7th is 429 vs 200)', async () => {
  const appCtx = await buildTestApp();
  try {
    for (let i = 0; i < 6; i += 1) {
      const res = await post(appCtx.baseUrl, '/api/guestbook', '203.0.113.10');
      assert.equal(res.status, 200, `request ${i + 1}`);
    }
    const seventh = await post(appCtx.baseUrl, '/api/guestbook', '203.0.113.10');
    assert.equal(seventh.status, 429);
    const body = await seventh.json();
    assert.equal(body.error, 'Too many requests. Please slow down.');
  } finally {
    await appCtx.close();
  }
});

test('profile: 6 -> 200, 7th -> 429', async () => {
  const appCtx = await buildTestApp();
  try {
    for (let i = 0; i < 6; i += 1) {
      const res = await put(appCtx.baseUrl, '/api/agents/Owner-A/profile', '203.0.113.11');
      assert.equal(res.status, 200, `request ${i + 1}`);
    }
    const seventh = await put(appCtx.baseUrl, '/api/agents/Owner-A/profile', '203.0.113.11');
    assert.equal(seventh.status, 429);
  } finally {
    await appCtx.close();
  }
});

test('vote: 12 -> 200, 13th -> 429', async () => {
  const appCtx = await buildTestApp();
  try {
    for (let i = 0; i < 12; i += 1) {
      const res = await post(appCtx.baseUrl, '/api/vote', '203.0.113.12');
      assert.equal(res.status, 200, `request ${i + 1}`);
    }
    const thirteenth = await post(appCtx.baseUrl, '/api/vote', '203.0.113.12');
    assert.equal(thirteenth.status, 429);
  } finally {
    await appCtx.close();
  }
});

test('reaction: 20 -> 200, 21st -> 429', async () => {
  const appCtx = await buildTestApp();
  try {
    for (let i = 0; i < 20; i += 1) {
      const res = await post(appCtx.baseUrl, '/api/contributions/abc/reactions', '203.0.113.13');
      assert.equal(res.status, 200, `request ${i + 1}`);
    }
    const twentyFirst = await post(appCtx.baseUrl, '/api/contributions/abc/reactions', '203.0.113.13');
    assert.equal(twentyFirst.status, 429);
  } finally {
    await appCtx.close();
  }
});

test('comment-contribution and comment-file: 10 -> 200 each, 11th -> 429, buckets independent', async () => {
  const appCtx = await buildTestApp();
  try {
    const ip = '203.0.113.14';
    for (let i = 0; i < 10; i += 1) {
      const res = await post(appCtx.baseUrl, '/api/contributions/abc/comments', ip);
      assert.equal(res.status, 200, `comment-contribution request ${i + 1}`);
    }
    const eleventh = await post(appCtx.baseUrl, '/api/contributions/abc/comments', ip);
    assert.equal(eleventh.status, 429);

    // comment-file must still be fresh for the same IP - independent bucket.
    for (let i = 0; i < 10; i += 1) {
      const res = await post(appCtx.baseUrl, '/api/files/comments', ip);
      assert.equal(res.status, 200, `comment-file request ${i + 1}`);
    }
    const fileEleventh = await post(appCtx.baseUrl, '/api/files/comments', ip);
    assert.equal(fileEleventh.status, 429);
  } finally {
    await appCtx.close();
  }
});

test('diff: 10 -> 200, 11th -> 429', async () => {
  const appCtx = await buildTestApp();
  try {
    for (let i = 0; i < 10; i += 1) {
      const res = await get(appCtx.baseUrl, '/api/contributions/abc/diff', '203.0.113.15');
      assert.equal(res.status, 200, `request ${i + 1}`);
    }
    const eleventh = await get(appCtx.baseUrl, '/api/contributions/abc/diff', '203.0.113.15');
    assert.equal(eleventh.status, 429);
  } finally {
    await appCtx.close();
  }
});

test('read: 60/min shared across graph+search+sections+files (with -> without: sections double-mount rejects at the 51st)', async () => {
  const appCtx = await buildTestApp();
  try {
    const ip = '203.0.113.16';
    for (let i = 0; i < 20; i += 1) {
      const res = await get(appCtx.baseUrl, '/api/network/graph', ip);
      assert.equal(res.status, 200, `graph request ${i + 1}`);
    }
    for (let i = 0; i < 20; i += 1) {
      const res = await get(appCtx.baseUrl, '/api/search', ip);
      assert.equal(res.status, 200, `search request ${i + 1}`);
    }
    for (let i = 0; i < 20; i += 1) {
      const res = await get(appCtx.baseUrl, '/api/world/sections', ip);
      // If sections were double-mounted (limit('read') both at app.use and at the route), this
      // would already 429 around the 11th sections request (51st overall hit) instead of all 20
      // succeeding - see the mount comment in buildTestApp.
      assert.equal(res.status, 200, `sections request ${i + 1}`);
    }
    const sixtyFirst = await get(appCtx.baseUrl, '/api/files', ip);
    assert.equal(sixtyFirst.status, 429, 'the 61st shared read request must be rejected');
  } finally {
    await appCtx.close();
  }
});

// --- contribute: chained minute + hour ---------------------------------------

test('contribute: 6/min then 429; after 5 fresh-minute batches of 6, the 31st is 429 from the hour limiter while the minute window is fresh', async () => {
  let currentTime = 1_700_000_000_000;
  const now = () => currentTime;
  const appCtx = await buildTestApp({ now });
  try {
    const ip = '203.0.113.17';

    // First minute window: 6 succeed, 7th is rejected by contribute-minute.
    for (let i = 0; i < 6; i += 1) {
      const res = await post(appCtx.baseUrl, '/api/contribute', ip);
      assert.equal(res.status, 200, `minute request ${i + 1}`);
    }
    const seventh = await post(appCtx.baseUrl, '/api/contribute', ip);
    assert.equal(seventh.status, 429, 'contribute-minute must reject the 7th request in the window');

    // 4 more fresh-minute batches of 6 (total 5 batches = 30 hour-hits).
    for (let batch = 0; batch < 4; batch += 1) {
      currentTime += 61_000;
      for (let i = 0; i < 6; i += 1) {
        const res = await post(appCtx.baseUrl, '/api/contribute', ip);
        assert.equal(res.status, 200, `batch ${batch + 2} request ${i + 1}`);
      }
    }

    // A 6th, fresh minute window: the minute limiter is fresh (1st hit), but the hour limiter has
    // now seen 31 passed-minute requests and must reject - without the hour limiter this would
    // be 200 (this is mutation M7: dropping contribute-hour from routes.contribute).
    currentTime += 61_000;
    const thirtyFirst = await post(appCtx.baseUrl, '/api/contribute', ip);
    assert.equal(thirtyFirst.status, 429, 'contribute-hour must reject the 31st passed-minute request');
  } finally {
    await appCtx.close();
  }
});

test('contribute: a request rejected by the minute limiter does not increment the hour counter', async () => {
  let currentTime = 1_700_000_000_000;
  const now = () => currentTime;
  const stores = new Map();
  const storeFactory = (name) => {
    const store = new BoundedMemoryStore({ now });
    stores.set(name, store);
    return store;
  };
  const appCtx = await buildTestApp({ now, storeFactory });
  try {
    const ip = '203.0.113.18';
    for (let i = 0; i < 6; i += 1) {
      const res = await post(appCtx.baseUrl, '/api/contribute', ip);
      assert.equal(res.status, 200, `request ${i + 1}`);
    }
    const seventh = await post(appCtx.baseUrl, '/api/contribute', ip);
    assert.equal(seventh.status, 429);

    // INFO (g): keys are namespaced aibuilds:rl:v1:<policy>:<identity> - the store itself never
    // sees the bare identity.
    const hourEntry = await stores.get('contribute-hour').get(`aibuilds:rl:v1:contribute-hour:${ip}`);
    assert.ok(hourEntry, 'the hour store must have an entry from the first 6 successes');
    assert.equal(hourEntry.totalHits, 6, 'the rejected 7th request must not have reached the hour limiter');
  } finally {
    await appCtx.close();
  }
});

// --- identity buckets ---------------------------------------------------------

test('different IPv4 addresses get independent buckets', async () => {
  const appCtx = await buildTestApp();
  try {
    for (let i = 0; i < 12; i += 1) {
      const res = await post(appCtx.baseUrl, '/api/vote', '198.51.100.20');
      assert.equal(res.status, 200, `IP A request ${i + 1}`);
    }
    const exceeded = await post(appCtx.baseUrl, '/api/vote', '198.51.100.20');
    assert.equal(exceeded.status, 429);

    const firstFromB = await post(appCtx.baseUrl, '/api/vote', '198.51.100.21');
    assert.equal(firstFromB.status, 200, 'a different IPv4 must have its own, fresh bucket');
  } finally {
    await appCtx.close();
  }
});

test('two IPv6 addresses in the same /64 share a bucket; a different /64 does not', async () => {
  const appCtx = await buildTestApp();
  try {
    const first = '2001:db8:1:2::1';
    const second = '2001:db8:1:2:ffff::9'; // same /64 as `first`
    const different = '2001:db8:1:3::1'; // different /64

    for (let i = 0; i < 12; i += 1) {
      const res = await post(appCtx.baseUrl, '/api/vote', first);
      assert.equal(res.status, 200, `first-address request ${i + 1}`);
    }
    const sharedBucketExceeded = await post(appCtx.baseUrl, '/api/vote', second);
    assert.equal(sharedBucketExceeded.status, 429, 'an address in the same /64 must share the exhausted bucket');

    const differentBucket = await post(appCtx.baseUrl, '/api/vote', different);
    assert.equal(differentBucket.status, 200, 'an address in a different /64 must have a fresh bucket');
  } finally {
    await appCtx.close();
  }
});

// --- provenance failures -------------------------------------------------------

test('enforce + no provenance on a closed policy -> 503 + Retry-After: 30, route handler never called', async () => {
  const appCtx = await buildTestApp({ enforcement: 'enforce' });
  try {
    // A trusted peer (loopback) without CF-Connecting-IP is a provenance failure
    // ('missing-cf-header'), not a trusted request.
    const res = await fetch(`${appCtx.baseUrl}/api/guestbook`, { method: 'POST' });
    assert.equal(res.status, 503);
    assert.equal(res.headers.get('retry-after'), '30');
    const body = await res.json();
    assert.equal(body.error, 'Client address could not be verified');
    assert.equal(appCtx.hits.guestbook, 0, 'the route handler must never run on a provenance failure');
  } finally {
    await appCtx.close();
  }
});

test('enforce + no provenance on an open policy -> handler called, nothing counted', async () => {
  const appCtx = await buildTestApp({ enforcement: 'enforce' });
  try {
    // diff allows 10/min when identified; without provenance it must simply pass through
    // (bounded elsewhere, not by this limiter) - sending more than the max must never 429.
    for (let i = 0; i < 15; i += 1) {
      const res = await fetch(`${appCtx.baseUrl}/api/contributions/abc/diff`, { method: 'GET' });
      assert.equal(res.status, 200, `request ${i + 1}`);
    }
    assert.equal(appCtx.hits.diff, 15);
  } finally {
    await appCtx.close();
  }
});

// --- store failures --------------------------------------------------------------

function throwingStore(message = 'store unavailable') {
  return {
    localKeys: true,
    init() {},
    async increment() { throw new Error(message); },
    async decrement() {},
    async resetKey() {},
    async get() { return undefined; },
    async resetAll() {},
  };
}

test('store failure on a closed policy -> 503 + Retry-After: 30', async () => {
  const appCtx = await buildTestApp({
    storeFactory: (name) => (name === 'guestbook' ? throwingStore() : new BoundedMemoryStore()),
  });
  try {
    const res = await post(appCtx.baseUrl, '/api/guestbook', '203.0.113.30');
    assert.equal(res.status, 503);
    assert.equal(res.headers.get('retry-after'), '30');
    const body = await res.json();
    assert.equal(body.error, 'Rate limiter unavailable');
  } finally {
    await appCtx.close();
  }
});

test('store failure on an open policy -> handler still called', async () => {
  const appCtx = await buildTestApp({
    storeFactory: (name) => (name === 'diff' ? throwingStore() : new BoundedMemoryStore()),
  });
  try {
    const res = await get(appCtx.baseUrl, '/api/contributions/abc/diff', '203.0.113.31');
    assert.equal(res.status, 200);
    assert.equal(appCtx.hits.diff, 1);
  } finally {
    await appCtx.close();
  }
});

// --- shadow mode -------------------------------------------------------------

test('shadow: guestbook never rejects and counts shadowWouldReject; write (not shadowable) still rejects the 31st', async () => {
  const appCtx = await buildTestApp({ enforcement: 'shadow' });
  try {
    const ip = '203.0.113.40';
    for (let i = 0; i < 6; i += 1) {
      const res = await post(appCtx.baseUrl, '/api/guestbook', ip);
      assert.equal(res.status, 200, `request ${i + 1}`);
    }
    const seventh = await post(appCtx.baseUrl, '/api/guestbook', ip);
    assert.equal(seventh.status, 200, 'a shadowable policy must never reject under shadow enforcement');

    const counters = appCtx.limits.counters();
    const guestbookCounters = counters.find(entry => entry.policy === 'guestbook');
    assert.equal(guestbookCounters.shadowWouldReject, 1);

    // `write` is shared across every PoW chain and is NOT shadowable - it must still reject at
    // its real 30/min limit even while every shadowable policy in the chain (here: vote, max 12)
    // never rejects.
    const voteIp = '203.0.113.41';
    for (let i = 0; i < 30; i += 1) {
      const res = await post(appCtx.baseUrl, '/api/vote', voteIp);
      assert.equal(res.status, 200, `write-bucket request ${i + 1}`);
    }
    const thirtyFirst = await post(appCtx.baseUrl, '/api/vote', voteIp);
    assert.equal(thirtyFirst.status, 429, 'write must still reject under shadow enforcement');
  } finally {
    await appCtx.close();
  }
});

test('R1-C1: shadow + NO provenance falls through on the fallback key for every policy, incl. write; the fallback bucket still has a real max; enforce is unchanged', async () => {
  // No CF-Connecting-IP header at all: the fixture's loopback peer is trusted (T2 fixture config)
  // but the header is missing -> provenance failure 'missing-cf-header', shadow fallback key
  // `peer:<loopback>`. Before the fix, `write` (shadowable:false) computed
  // `effectiveEnforcement = 'enforce'` here regardless of the global switch, so `canShadowFallback`
  // was always false and EVERY unverified request 503'd even under shadow - exactly the production
  // write outage Gate R1-C1 is about.
  const shadowApp = await buildTestApp({ enforcement: 'shadow' });
  try {
    const noProvenance = () => fetch(`${shadowApp.baseUrl}/api/guestbook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    for (let i = 0; i < 30; i += 1) {
      const res = await noProvenance();
      assert.equal(res.status, 200, `write-bucket request ${i + 1} without provenance under shadow`);
    }
    // `write` is NOT shadowable: once ITS OWN real bucket (here, the shared fallback peer key) is
    // exhausted, it still rejects - shadow only relaxed the provenance gate that used to keep this
    // request from ever reaching the erl limiter at all.
    const thirtyFirst = await noProvenance();
    assert.equal(thirtyFirst.status, 429, 'write must still reject once the fallback bucket is exhausted');

    const counters = shadowApp.limits.counters();
    const writeCounters = counters.find(entry => entry.policy === 'write');
    assert.equal(writeCounters.provenanceFailures['missing-cf-header'], 31, 'every fallback hit is still counted as a provenance failure');
  } finally {
    await shadowApp.close();
  }

  // enforce mode is unchanged: the very first unverified request still 503s before the handler.
  const enforceApp = await buildTestApp({ enforcement: 'enforce' });
  try {
    const res = await fetch(`${enforceApp.baseUrl}/api/guestbook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(res.status, 503);
    assert.equal(res.headers.get('retry-after'), '30');
    assert.equal(enforceApp.hits.guestbook, 0);
  } finally {
    await enforceApp.close();
  }
});

// --- counters() / log leak the aggregate only, never keys or IPs -------------------

test('counters() output and the log spy never contain a key or an IP', async () => {
  const logLines = [];
  const appCtx = await buildTestApp({ log: (line) => logLines.push(line) });
  try {
    const distinctiveIp = '203.0.113.99';
    for (let i = 0; i < 7; i += 1) {
      await post(appCtx.baseUrl, '/api/guestbook', distinctiveIp);
    }
    // also trigger a provenance failure, which records a reason (not an IP or key)
    await fetch(`${appCtx.baseUrl}/api/guestbook`, { method: 'POST' });

    const serializedCounters = JSON.stringify(appCtx.limits.counters());
    assert.equal(serializedCounters.includes(distinctiveIp), false);
    assert.equal(serializedCounters.includes('peer:'), false);

    appCtx.limits.startCounterLog(20);
    await new Promise(resolve => setTimeout(resolve, 120));
    appCtx.limits.stopCounterLog();

    assert.ok(logLines.length > 0, 'the counter log must have fired at least once');
    for (const line of logLines) {
      assert.equal(line.includes(distinctiveIp), false, line);
      assert.equal(line.includes('peer:'), false, line);
    }
  } finally {
    await appCtx.close();
  }
});

// ============================================================================================
// T3/T4 spawned-server integration tests: the real server/index.js process, not the in-process
// fixture above. CLIENT_IP_MODE=cloudflare over loopback, TRUSTED_PROXY_CIDRS=127.0.0.1/32,::1/128,
// POW_DIFFICULTY=0, unless a test explicitly asks for direct mode.
// ============================================================================================

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { once } = require('node:events');
const WebSocket = require('ws');

const execFileAsync = promisify(execFile);

// Trailing \s is load-bearing (NEXT_SESSION.md "Fallen" #2): without it a stdout chunk ending
// mid-number matches a truncated port, and the first (wrong) match is cached.
const SERVER_PORT_PATTERN = /Server:\s+http:\/\/localhost:(\d+)\s/;

async function waitForRealServer(child, logs) {
  const deadline = Date.now() + 10_000;
  let baseUrl = null;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Server exited early:\n${logs.join('')}`);
    if (!baseUrl) {
      const match = logs.join('').match(SERVER_PORT_PATTERN);
      if (match) baseUrl = `http://127.0.0.1:${match[1]}`;
    }
    if (baseUrl) {
      try {
        // Per-attempt timeout (NEXT_SESSION.md "Fallen" #3): fetch has none of its own.
        if ((await fetch(`${baseUrl}/api/stats`, { signal: AbortSignal.timeout(1000) })).ok) return baseUrl;
      } catch { /* retry */ }
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Server did not start:\n${logs.join('')}`);
}

async function spawnRealServer(t, { extraEnv = {}, cloudflare = true } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aibuilds-abuse-limits-'));
  const worldDir = path.join(root, 'world');
  const dataDir = path.join(root, 'data');
  const backupDir = path.join(root, 'backups');
  await fs.mkdir(worldDir, { recursive: true });
  await fs.mkdir(dataDir, { recursive: true });

  const env = {
    ...process.env,
    PORT: '0',
    POW_DIFFICULTY: '0',
    ADMIN_RESET_SECRET: 'operator-secret',
    AIBUILDS_WORLD_DIR: worldDir,
    AIBUILDS_DATA_DIR: dataDir,
    AIBUILDS_BACKUP_DIR: backupDir,
  };
  if (cloudflare) {
    env.CLIENT_IP_MODE = 'cloudflare';
    env.TRUSTED_PROXY_CIDRS = '127.0.0.1/32,::1/128';
  }
  Object.assign(env, extraEnv);

  const logs = [];
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: path.join(__dirname, '..'),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', chunk => logs.push(chunk.toString()));
  child.stderr.on('data', chunk => logs.push(chunk.toString()));
  // Kill, wait for exit, THEN remove the directory - all in one hook (node:test runs t.after()
  // hooks in registration order; two separate hooks left kill-vs-rm order unspecified and could
  // race fs.rm against the child's own in-flight shutdown writes, producing an intermittent
  // ENOTEMPTY on data/).
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGTERM');
    if (child.exitCode === null) await once(child, 'exit');
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const baseUrl = await waitForRealServer(child, logs);
  return { baseUrl, logs, worldDir, dataDir, child };
}

async function realRequestJson(baseUrl, requestPath, options = {}) {
  const response = await fetch(baseUrl + requestPath, options);
  let body;
  try { body = await response.json(); } catch { body = null; }
  return { response, body };
}

function cfHeaders(ip, extra = {}) {
  return { 'CF-Connecting-IP': ip, ...extra };
}

async function realChallenge(baseUrl, ip) {
  const { response, body } = await realRequestJson(baseUrl, '/api/challenge', { headers: cfHeaders(ip) });
  assert.equal(response.status, 200, 'challenge fetch must succeed');
  return body;
}

async function realContribute(baseUrl, ip, payload) {
  const challenge = await realChallenge(baseUrl, ip);
  return realRequestJson(baseUrl, '/api/contribute', {
    method: 'POST',
    headers: cfHeaders(ip, {
      'Content-Type': 'application/json',
      'X-Challenge-Id': challenge.id,
      'X-Challenge-Nonce': '0',
    }),
    body: JSON.stringify({
      agent_name: 'BudgetAgent',
      action: 'create',
      file_path: `pages/budget-${crypto.randomUUID()}.html`,
      content: '<main><h1>Budget test</h1></main>',
      message: 'budget test contribution',
      ...payload,
    }),
  });
}

async function realGuestbook(baseUrl, ip, extraHeaders = {}) {
  const challenge = await realChallenge(baseUrl, ip);
  return realRequestJson(baseUrl, '/api/guestbook', {
    method: 'POST',
    headers: cfHeaders(ip, {
      'Content-Type': 'application/json',
      'X-Challenge-Id': challenge.id,
      'X-Challenge-Nonce': '0',
      ...extraHeaders,
    }),
    body: JSON.stringify({ agent_name: 'GuestAgent', message: 'hello from the budget suite' }),
  });
}

async function gitRevCount(worldDir) {
  const { stdout } = await execFileAsync('git', ['-C', worldDir, 'rev-list', '--count', 'HEAD']);
  return stdout.trim();
}

async function sha256File(filePath) {
  try {
    const bytes = await fs.readFile(filePath);
    return crypto.createHash('sha256').update(bytes).digest('hex');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

test('spawned server: guestbook 6 -> 200, 7th -> 429 from IP A, 1st from IP B -> 200', async (t) => {
  const { baseUrl } = await spawnRealServer(t);
  for (let i = 0; i < 6; i += 1) {
    const { response } = await realGuestbook(baseUrl, '203.0.113.50');
    assert.equal(response.status, 200, `A request ${i + 1}`);
  }
  const seventh = await realGuestbook(baseUrl, '203.0.113.50');
  assert.equal(seventh.response.status, 429);
  const firstFromB = await realGuestbook(baseUrl, '203.0.113.51');
  assert.equal(firstFromB.response.status, 200);
});

test('spawned server (Gate R3-1): /api/world/sections read limiter mounted once - 31 requests from one IP are all 200', async (t) => {
  const { baseUrl } = await spawnRealServer(t);
  const ip = '203.0.113.52';
  for (let i = 0; i < 31; i += 1) {
    // A double mount (app.use + a second limit('read') in the route) would count 62 hits against
    // the shared 60/min budget and reject well before the 31st.
    const result = await realRequestJson(baseUrl, '/api/world/sections', { headers: cfHeaders(ip) });
    assert.equal(result.response.status, 200, `sections request ${i + 1}`);
  }
});

test('spawned server: contribute 6 -> 200, 7th -> 429 with no side effect (I6)', async (t) => {
  const { baseUrl, worldDir, dataDir } = await spawnRealServer(t);
  const ip = '203.0.113.53';

  const socket = new WebSocket(`${baseUrl.replace('http://', 'ws://')}/ws`, { headers: cfHeaders(ip) });
  t.after(() => socket.close());
  const frames = [];
  socket.on('message', data => { try { frames.push(JSON.parse(data.toString())); } catch { /* ignore */ } });
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });

  for (let i = 0; i < 6; i += 1) {
    const result = await realContribute(baseUrl, ip, { file_path: `pages/budget-fixed-${i}.html` });
    assert.equal(result.response.status, 200, `request ${i + 1}`);
  }
  const beforeRevCount = await gitRevCount(worldDir);
  const beforeSha = await sha256File(path.join(dataDir, 'state.json'));
  const rejectedPath = 'pages/budget-rejected.html';
  const seventh = await realContribute(baseUrl, ip, { file_path: rejectedPath });
  assert.equal(seventh.response.status, 429);

  await new Promise(resolve => setTimeout(resolve, 150));
  const afterRevCount = await gitRevCount(worldDir);
  const afterSha = await sha256File(path.join(dataDir, 'state.json'));
  assert.equal(afterRevCount, beforeRevCount, 'no git commit for the rejected contribution');
  assert.equal(afterSha, beforeSha, 'state.json must be unchanged by the rejected contribution');
  await assert.rejects(fs.access(path.join(worldDir, rejectedPath)), 'target file must not exist');
  assert.equal(
    frames.some(f => f.type === 'contribution' && f.data?.file_path === rejectedPath),
    false,
    'no contribution WS broadcast for the rejected request',
  );
});

test('spawned server: direct mode receiving X-Forwarded-For on POST /api/guestbook -> 503, and the same request without it -> 200', async (t) => {
  const { baseUrl, dataDir } = await spawnRealServer(t, { cloudflare: false });
  const beforeSha = await sha256File(path.join(dataDir, 'state.json'));
  const challenge = await realRequestJson(baseUrl, '/api/challenge');
  assert.equal(challenge.response.status, 200);
  const withHeader = await realRequestJson(baseUrl, '/api/guestbook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Forwarded-For': '198.51.100.5',
      'X-Challenge-Id': challenge.body.id,
      'X-Challenge-Nonce': '0',
    },
    body: JSON.stringify({ agent_name: 'DirectAgent', message: 'spoofed forwarded header' }),
  });
  assert.equal(withHeader.response.status, 503);
  assert.equal(withHeader.response.headers.get('retry-after'), '30');
  const afterSha = await sha256File(path.join(dataDir, 'state.json'));
  assert.equal(afterSha, beforeSha, 'state.json must be unchanged by the rejected request');

  const secondChallenge = await realRequestJson(baseUrl, '/api/challenge');
  const withoutHeader = await realRequestJson(baseUrl, '/api/guestbook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Challenge-Id': secondChallenge.body.id,
      'X-Challenge-Nonce': '0',
    },
    body: JSON.stringify({ agent_name: 'DirectAgent', message: 'plain direct request' }),
  });
  assert.equal(withoutHeader.response.status, 200);
});

test('spawned server: cloudflare mode with missing CF-Connecting-IP -> 503 on guestbook/challenge/admin, 200 on /api/stats and /api/files', async (t) => {
  const { baseUrl } = await spawnRealServer(t);
  const guestbookNoHeader = await fetch(`${baseUrl}/api/guestbook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent_name: 'X', message: 'no header' }),
  });
  assert.equal(guestbookNoHeader.status, 503);

  const challengeNoHeader = await fetch(`${baseUrl}/api/challenge`);
  assert.equal(challengeNoHeader.status, 503);

  const adminNoHeader = await fetch(`${baseUrl}/api/admin/moderation`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: 'operator-secret' }),
  });
  assert.equal(adminNoHeader.status, 503);

  const stats = await fetch(`${baseUrl}/api/stats`);
  assert.equal(stats.status, 200);

  const files = await fetch(`${baseUrl}/api/files`);
  assert.equal(files.status, 200);
});

test('spawned server: spoofed X-Forwarded-For rotation does not create new buckets - 7th guestbook post from the same CF IP is 429', async (t) => {
  const { baseUrl } = await spawnRealServer(t);
  const ip = '203.0.113.70';
  const statuses = [];
  for (let i = 0; i < 7; i += 1) {
    const result = await realGuestbook(baseUrl, ip, { 'X-Forwarded-For': `10.0.0.${i}` });
    statuses.push(result.response.status);
  }
  assert.deepEqual(statuses, [200, 200, 200, 200, 200, 200, 429]);
});

test('spawned server: /api/chaos/trigger shares the 5/min admin bucket with /api/admin/moderation', async (t) => {
  const { baseUrl } = await spawnRealServer(t);
  const ip = '203.0.113.80';
  const statuses = [];

  async function chaosWrongSecret() {
    const challenge = await realChallenge(baseUrl, ip);
    const result = await realRequestJson(baseUrl, '/api/chaos/trigger', {
      method: 'POST',
      headers: cfHeaders(ip, {
        'Content-Type': 'application/json',
        'X-Challenge-Id': challenge.id,
        'X-Challenge-Nonce': '0',
      }),
      body: JSON.stringify({ secret: 'wrong' }),
    });
    return result.response.status;
  }
  async function adminWrongSecret() {
    const result = await realRequestJson(baseUrl, '/api/admin/moderation', {
      method: 'POST',
      headers: cfHeaders(ip, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ secret: 'wrong' }),
    });
    return result.response.status;
  }

  statuses.push(await chaosWrongSecret());
  statuses.push(await chaosWrongSecret());
  statuses.push(await chaosWrongSecret());
  statuses.push(await adminWrongSecret());
  statuses.push(await adminWrongSecret());
  statuses.push(await chaosWrongSecret());

  assert.deepEqual(statuses, [403, 403, 403, 403, 403, 429]);
});

test('spawned server: admin failures and successes both count toward the 5/min bucket', async (t) => {
  const { baseUrl } = await spawnRealServer(t);
  const ip = '203.0.113.81';
  const statuses = [];
  for (let i = 0; i < 5; i += 1) {
    const result = await realRequestJson(baseUrl, '/api/admin/moderation', {
      method: 'POST',
      headers: cfHeaders(ip, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ secret: 'wrong' }),
    });
    statuses.push(result.response.status);
  }
  const correct = await realRequestJson(baseUrl, '/api/admin/moderation', {
    method: 'POST',
    headers: cfHeaders(ip, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ secret: 'operator-secret' }),
  });
  statuses.push(correct.response.status);
  assert.deepEqual(statuses, [403, 403, 403, 403, 403, 429]);
});

// --- T4: challenge caps, exercised end-to-end through the real /api/challenge route -----------

test('spawned server (T4): 61st open challenge from one CF IP -> 429; another IP -> 200; a different address in the same /64 -> 429', async (t) => {
  const { baseUrl } = await spawnRealServer(t);
  const ip = '203.0.113.60';
  for (let i = 0; i < 60; i += 1) {
    const { response } = await realRequestJson(baseUrl, '/api/challenge', { headers: cfHeaders(ip) });
    assert.equal(response.status, 200, `challenge ${i + 1}`);
  }
  const sixtyFirstSameIp = await realRequestJson(baseUrl, '/api/challenge', { headers: cfHeaders(ip) });
  assert.equal(sixtyFirstSameIp.response.status, 429);

  const otherIp = await realRequestJson(baseUrl, '/api/challenge', { headers: cfHeaders('203.0.113.61') });
  assert.equal(otherIp.response.status, 200);

  const ipv6First = '2001:db8:5:6::1';
  for (let i = 0; i < 60; i += 1) {
    const { response } = await realRequestJson(baseUrl, '/api/challenge', { headers: cfHeaders(ipv6First) });
    assert.equal(response.status, 200, `ipv6 challenge ${i + 1}`);
  }
  const ipv6SameSixtyFour = '2001:db8:5:6:ffff::9';
  const sixtyFirstSameSixtyFour = await realRequestJson(
    baseUrl, '/api/challenge', { headers: cfHeaders(ipv6SameSixtyFour) },
  );
  assert.equal(sixtyFirstSameSixtyFour.response.status, 429);
});

// --- replay safety: requireProofOfWork must not accept the same challenge twice ---------------

test('spawned server: a solved challenge used twice sequentially -> the second use is 403 with no side effect', async (t) => {
  const { baseUrl, worldDir, dataDir } = await spawnRealServer(t);
  const ip = '203.0.113.90';
  const challenge = await realChallenge(baseUrl, ip);
  const headers = cfHeaders(ip, {
    'Content-Type': 'application/json',
    'X-Challenge-Id': challenge.id,
    'X-Challenge-Nonce': '0',
  });
  const filePath = 'pages/replay-guard.html';
  const first = await realRequestJson(baseUrl, '/api/contribute', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      agent_name: 'ReplayAgent', action: 'create', file_path: filePath,
      content: '<main><h1>First</h1></main>', message: 'first use',
    }),
  });
  assert.equal(first.response.status, 200);
  const beforeRevCount = await gitRevCount(worldDir);
  const beforeSha = await sha256File(path.join(dataDir, 'state.json'));

  const second = await realRequestJson(baseUrl, '/api/contribute', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      agent_name: 'ReplayAgent', action: 'edit', file_path: filePath,
      content: '<main><h1>Second (replay)</h1></main>', message: 'replayed challenge',
    }),
  });
  assert.equal(second.response.status, 403);

  await new Promise(resolve => setTimeout(resolve, 150));
  const afterRevCount = await gitRevCount(worldDir);
  const afterSha = await sha256File(path.join(dataDir, 'state.json'));
  assert.equal(afterRevCount, beforeRevCount, 'a replayed challenge must not create a new commit');
  assert.equal(afterSha, beforeSha, 'a replayed challenge must not mutate state.json');
});

// --- bans must key on the resolved client identity, never on req.ip (trust proxy is off) --------

test('spawned server: an IP ban keys on the resolved CF-Connecting-IP identity, not req.ip', async (t) => {
  const { baseUrl } = await spawnRealServer(t);
  const bannedIp = '203.0.113.100';
  const otherIp = '203.0.113.101';

  const ban = await realRequestJson(baseUrl, '/api/admin/ban', {
    method: 'POST',
    headers: cfHeaders(otherIp, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ secret: 'operator-secret', action: 'ban', ip: bannedIp }),
  });
  assert.equal(ban.response.status, 200);

  // req.ip (with trust proxy off) is always the loopback socket peer here, never the
  // CF-Connecting-IP - a ban check on req.ip instead of the resolved identity would never match.
  const fromBannedIp = await realGuestbook(baseUrl, bannedIp);
  assert.equal(fromBannedIp.response.status, 403);

  const fromOtherIp = await realGuestbook(baseUrl, otherIp);
  assert.equal(fromOtherIp.response.status, 200);
});

// --- R1-C1: shadow mode with no provenance must fall through, not 503, on the real server --------

test('spawned server (R1-C1): shadow + cloudflare + no CF-Connecting-IP -> /api/challenge 200 and /api/guestbook 200 (fallback key, never a provenance 503)', async (t) => {
  const { baseUrl } = await spawnRealServer(t, { extraEnv: { ABUSE_ENFORCEMENT: 'shadow' } });

  const challengeRes = await fetch(`${baseUrl}/api/challenge`);
  assert.equal(challengeRes.status, 200, 'challenge must fall through under shadow, not 503');
  const challenge = await challengeRes.json();

  const guestbookRes = await fetch(`${baseUrl}/api/guestbook`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Challenge-Id': challenge.id,
      'X-Challenge-Nonce': '0',
    },
    body: JSON.stringify({ agent_name: 'ShadowGuest', message: 'no CF header under shadow' }),
  });
  assert.equal(guestbookRes.status, 200, 'write must fall through to the handler under shadow, not 503');
});

test('spawned server (R1-C1): the same missing-CF-header request under enforce (default) still 503s - unchanged control', async (t) => {
  const { baseUrl } = await spawnRealServer(t);
  const res = await fetch(`${baseUrl}/api/challenge`);
  assert.equal(res.status, 503);
  assert.equal(res.headers.get('retry-after'), '30');
});

// --- R1-W2: the sections read limiter must match GET /api/world/sections exactly ------------------

test('spawned server (R1-W2): /api/world/sections/<file>.html is exempt from the sections read limiter - 61 requests all 200, and the exact summary route keeps its own fresh budget', async (t) => {
  const { baseUrl, worldDir } = await spawnRealServer(t);
  const ip = '203.0.113.110';
  await fs.mkdir(path.join(worldDir, 'sections'), { recursive: true });
  await fs.writeFile(
    path.join(worldDir, 'sections', 'hero.html'),
    '<section data-section-title="Hero"><h2>Hero</h2></section>',
  );

  for (let i = 0; i < 61; i += 1) {
    const { response, body } = await realRequestJson(baseUrl, '/api/world/sections/hero.html', { headers: cfHeaders(ip) });
    assert.equal(response.status, 200, `sections/<file> request ${i + 1}`);
    assert.equal(body.content.includes('Hero'), true);
  }
  const summary = await realRequestJson(baseUrl, '/api/world/sections', { headers: cfHeaders(ip) });
  assert.equal(summary.response.status, 200, 'the exact-match summary route must still have its own, unexhausted budget');
});

// --- R1-W3: startup logs the parsed client-ip config (no addresses) -------------------------------

test('spawned server (R1-W3): startup logs mode/enforcement/trustedProxyRanges, no addresses', async (t) => {
  const { logs } = await spawnRealServer(t, { extraEnv: { ABUSE_ENFORCEMENT: 'shadow' } });
  const combined = logs.join('');
  assert.match(combined, /\[client-ip\] mode=cloudflare enforcement=shadow trustedProxyRanges=2/);
  assert.equal(combined.includes('127.0.0.1'), false, 'the startup log must never print a trusted CIDR address');
  assert.equal(combined.includes('::1'), false, 'the startup log must never print a trusted CIDR address');
});

test('spawned server (R1-W3): NODE_ENV=production without CLIENT_IP_MODE logs a console.warn naming CLIENT_IP_MODE', async (t) => {
  const { logs } = await spawnRealServer(t, { cloudflare: false, extraEnv: { NODE_ENV: 'production' } });
  const combined = logs.join('');
  assert.match(combined, /\[client-ip\] mode=direct enforcement=enforce trustedProxyRanges=0/);
  assert.match(combined, /CLIENT_IP_MODE/);
});

// --- R1-W5: T3 moderation canonicalization tests named in the plan --------------------------------

test('spawned server (R1-W5): ban of an expanded/uppercase IPv6 form matches a CF-Connecting-IP in canonical form', async (t) => {
  const { baseUrl } = await spawnRealServer(t);
  const bannedIpRaw = '2001:DB8::1';
  const canonicalBannedIp = '2001:db8::1';
  const otherIp = '203.0.113.111';

  const ban = await realRequestJson(baseUrl, '/api/admin/ban', {
    method: 'POST',
    headers: cfHeaders(otherIp, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ secret: 'operator-secret', action: 'ban', ip: bannedIpRaw }),
  });
  assert.equal(ban.response.status, 200);

  const fromBannedIp = await realGuestbook(baseUrl, canonicalBannedIp);
  assert.equal(fromBannedIp.response.status, 403);
});

test('spawned server (R1-W5): a persisted ::ffff:-mapped ban matches the plain IPv4 form of the same address', async (t) => {
  const { baseUrl } = await spawnRealServer(t);
  const otherIp = '203.0.113.112';
  const mappedBanIp = '::ffff:198.51.100.4';
  const plainIp = '198.51.100.4';

  const ban = await realRequestJson(baseUrl, '/api/admin/ban', {
    method: 'POST',
    headers: cfHeaders(otherIp, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ secret: 'operator-secret', action: 'ban', ip: mappedBanIp }),
  });
  assert.equal(ban.response.status, 200);

  const fromPlainIp = await realGuestbook(baseUrl, plainIp);
  assert.equal(fromPlainIp.response.status, 403);
});

// --- INFO (e): /api/admin/ban with a syntactically invalid ip -------------------------------------

test('spawned server (INFO e): /api/admin/ban with an invalid ip -> 400, never silently accepted', async (t) => {
  const { baseUrl } = await spawnRealServer(t);
  const result = await realRequestJson(baseUrl, '/api/admin/ban', {
    method: 'POST',
    headers: cfHeaders('203.0.113.113', { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ secret: 'operator-secret', action: 'ban', ip: 'not-an-ip' }),
  });
  assert.equal(result.response.status, 400);
  assert.equal(result.body.error, 'ip must be a valid IPv4 or IPv6 address');
});

// --- INFO (g): limiter keys are namespaced aibuilds:rl:v1:<policy>:<identity> ---------------------

test('INFO (g): limiter keys are namespaced aibuilds:rl:v1:<policy>:<identity> for both the Express middleware and consume()', async () => {
  const capturedKeys = [];
  function capturingStoreFactory() {
    const store = new BoundedMemoryStore();
    const originalIncrement = store.increment.bind(store);
    store.increment = (key) => {
      capturedKeys.push(key);
      return originalIncrement(key);
    };
    return store;
  }
  const appCtx = await buildTestApp({ storeFactory: capturingStoreFactory });
  try {
    await post(appCtx.baseUrl, '/api/vote', '203.0.113.114');
    assert.ok(
      capturedKeys.includes('aibuilds:rl:v1:vote:203.0.113.114'),
      `expected a namespaced vote key, got: ${capturedKeys.join(', ')}`,
    );
    assert.ok(
      capturedKeys.includes('aibuilds:rl:v1:write:203.0.113.114'),
      `expected a namespaced write key, got: ${capturedKeys.join(', ')}`,
    );

    await appCtx.limits.consume('ws-upgrade', '203.0.113.114');
    assert.ok(
      capturedKeys.includes('aibuilds:rl:v1:ws-upgrade:203.0.113.114'),
      `expected consume() to use the same namespace, got: ${capturedKeys.join(', ')}`,
    );
  } finally {
    await appCtx.close();
  }
});

// --- R1-W1: the diff cache must never pin a transient failure ------------------------------------

test('spawned server (R1-W1): a transient diff failure (git objects unreadable) is never cached - restoring access lets the next request see a real diff', async (t) => {
  const { baseUrl, worldDir } = await spawnRealServer(t);
  const ip = '203.0.113.121';
  const created = await realContribute(baseUrl, ip, { file_path: 'pages/diff-w1-target.html' });
  assert.equal(created.response.status, 200);
  const contributionId = created.body.contribution.id;

  const objectsDir = path.join(worldDir, '.git', 'objects');
  await fs.chmod(objectsDir, 0o000);
  try {
    const failing = await realRequestJson(baseUrl, `/api/contributions/${contributionId}/diff`, { headers: cfHeaders(ip) });
    assert.equal(failing.response.status, 200, 'the diff route always answers 200 with a null diff + message on failure');
    assert.equal(failing.body.diff, null);
    assert.match(failing.body.message, /Failed to get diff/);
  } finally {
    await fs.chmod(objectsDir, 0o755);
  }

  const recovered = await realRequestJson(baseUrl, `/api/contributions/${contributionId}/diff`, { headers: cfHeaders(ip) });
  assert.equal(recovered.response.status, 200);
  assert.notEqual(
    recovered.body.diff, null,
    'a transient failure must never be cached - the retried request after restoring access must see a real diff, not the stale cached failure',
  );
});
