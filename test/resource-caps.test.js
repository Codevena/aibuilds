'use strict';

// Spawned-server integration tests for T7 (resource caps, caches, response bounds) of
// docs/superpowers/plans/2026-09-23-abuse-authz-hardening.md. Unit tests for the shared cache
// primitives (generation cache, semaphore, LRU-bytes cache, single-flight) live in
// test/read-cache.test.js and already cover: generation invalidation on bump(), semaphore waiter
// cap (limit 2 / 16 waiters / 17th rejected), and single-flight de-duplication (the diff cache's
// "one git execution for concurrent requests" guarantee).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { once } = require('node:events');

const execFileAsync = promisify(execFile);

// Trailing \s is load-bearing (NEXT_SESSION.md "Fallen" #2).
const SERVER_PORT_PATTERN = /Server:\s+http:\/\/localhost:(\d+)\s/;

async function waitForRealServer(child, logs) {
  const deadline = Date.now() + 15_000;
  let baseUrl = null;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Server exited early:\n${logs.join('')}`);
    if (!baseUrl) {
      const match = logs.join('').match(SERVER_PORT_PATTERN);
      if (match) baseUrl = `http://127.0.0.1:${match[1]}`;
    }
    if (baseUrl) {
      try {
        if ((await fetch(`${baseUrl}/api/stats`, { signal: AbortSignal.timeout(1000) })).ok) return baseUrl;
      } catch { /* retry */ }
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Server did not start:\n${logs.join('')}`);
}

async function spawnServer(t, { root, preloadState, worldFiles = {} } = {}) {
  const dirRoot = root || await fs.mkdtemp(path.join(os.tmpdir(), 'aibuilds-resource-caps-'));
  const worldDir = path.join(dirRoot, 'world');
  const dataDir = path.join(dirRoot, 'data');
  const backupDir = path.join(dirRoot, 'backups');
  await fs.mkdir(worldDir, { recursive: true });
  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(backupDir, { recursive: true });

  // World files must exist BEFORE the server starts: init()'s one-time startup migration stamps
  // any history entry lacking a stored publicationStatus using what it can see at that moment.
  for (const [relPath, content] of Object.entries(worldFiles)) {
    const fullPath = path.join(worldDir, relPath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content);
  }
  if (preloadState) {
    await fs.writeFile(path.join(dataDir, 'state.json'), JSON.stringify(preloadState));
  }

  const logs = [];
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: '0',
      POW_DIFFICULTY: '0',
      ADMIN_RESET_SECRET: 'operator-secret',
      AIBUILDS_WORLD_DIR: worldDir,
      AIBUILDS_DATA_DIR: dataDir,
      AIBUILDS_BACKUP_DIR: backupDir,
      CLIENT_IP_MODE: 'cloudflare',
      TRUSTED_PROXY_CIDRS: '127.0.0.1/32,::1/128',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', chunk => logs.push(chunk.toString()));
  child.stderr.on('data', chunk => logs.push(chunk.toString()));
  // Kill, wait for actual exit, THEN remove the directory - all in one hook. node:test runs
  // t.after() hooks in registration order (FIFO); two separate hooks left the kill-vs-rm order
  // unspecified relative to each other, which raced fs.rm's recursive readdir against the child's
  // own in-flight shutdown writes and produced an intermittent ENOTEMPTY on data/.
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGTERM');
    if (child.exitCode === null) await once(child, 'exit');
    if (!root) await fs.rm(dirRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
  });
  const baseUrl = await waitForRealServer(child, logs);
  return { baseUrl, logs, worldDir, dataDir, backupDir, root: dirRoot };
}

async function requestJson(baseUrl, requestPath, options = {}) {
  const response = await fetch(baseUrl + requestPath, options);
  let body;
  try { body = await response.json(); } catch { body = null; }
  return { response, body };
}

function cfHeaders(ip, extra = {}) {
  return { 'CF-Connecting-IP': ip, ...extra };
}

async function challenge(baseUrl, ip) {
  const { response, body } = await requestJson(baseUrl, '/api/challenge', { headers: cfHeaders(ip) });
  assert.equal(response.status, 200);
  return body;
}

async function powHeaders(baseUrl, ip, extra = {}) {
  const ch = await challenge(baseUrl, ip);
  return cfHeaders(ip, {
    'Content-Type': 'application/json',
    'X-Challenge-Id': ch.id,
    'X-Challenge-Nonce': '0',
    ...extra,
  });
}

async function gitRevCount(worldDir) {
  const { stdout } = await execFileAsync('git', ['-C', worldDir, 'rev-list', '--count', 'HEAD']);
  return stdout.trim();
}

function namedList(count, prefix) {
  return Array.from({ length: count }, (_, i) => `${prefix}${i}`);
}

// --- reactions cap (§3: agent_name 1-100 chars, <=1000/type/contribution, removal always allowed) --

test('reactions: 101-char agent_name -> 400; a name at the per-type cap can still be removed', async (t) => {
  const contributionId = 'reaction-cap-target';
  const cappedNames = namedList(1000, 'Fan');
  const { baseUrl } = await spawnServer(t, {
    worldFiles: { 'pages/reaction-target.html': '<main><h1>Reaction target</h1></main>' },
    preloadState: {
      history: [{
        id: contributionId, timestamp: '2026-09-01T00:00:00.000Z', agent_name: 'Author',
        action: 'create', file_path: 'pages/reaction-target.html', message: 'seed',
        publicationStatus: 'published',
        reactions: { fire: [...cappedNames], heart: [], rocket: [], eyes: [] },
        commentCount: 0,
      }],
    },
  });

  const tooLongName = 'X'.repeat(101);
  const badName = await requestJson(baseUrl, `/api/contributions/${contributionId}/reactions`, {
    method: 'POST',
    headers: await powHeaders(baseUrl, '203.0.113.1'),
    body: JSON.stringify({ agent_name: tooLongName, type: 'fire' }),
  });
  assert.equal(badName.response.status, 400);

  const overCap = await requestJson(baseUrl, `/api/contributions/${contributionId}/reactions`, {
    method: 'POST',
    headers: await powHeaders(baseUrl, '203.0.113.2'),
    body: JSON.stringify({ agent_name: 'OneTooMany', type: 'fire' }),
  });
  assert.equal(overCap.response.status, 409);

  const removal = await requestJson(baseUrl, `/api/contributions/${contributionId}/reactions`, {
    method: 'POST',
    headers: await powHeaders(baseUrl, '203.0.113.3'),
    body: JSON.stringify({ agent_name: cappedNames[0], type: 'fire' }),
  });
  assert.equal(removal.response.status, 200, 'removing an existing reaction must always be allowed, even at the cap');
  assert.equal(removal.body.action, 'removed');
});

test('reactions: the 50,000 global cap rejects an addition (409) once reached, from a fresh contribution', async (t) => {
  const REACTION_TYPES = ['fire', 'heart', 'rocket', 'eyes'];
  // 49 contributions x 1,000 reactions (spread evenly across the 4 types, 250 each - well under the
  // 1,000/type/contribution cap) = 49,000, plus a 50th with 999 = 49,999 total: one addition away
  // from the 50,000 global cap without ever tripping the per-type cap.
  const history = [];
  const worldFiles = {};
  for (let c = 0; c < 50; c += 1) {
    const filePath = `pages/reaction-global-${c}.html`;
    worldFiles[filePath] = `<main><h1>Global reaction target ${c}</h1></main>`;
    const reactions = { fire: [], heart: [], rocket: [], eyes: [] };
    for (const type of REACTION_TYPES) {
      // Contribution 49 gets one fewer 'fire' reaction (249 instead of 250) so the 50 contributions
      // total exactly 49,999: 49*1,000 + 999.
      const perTypeCount = (c === 49 && type === 'fire') ? 249 : 250;
      reactions[type] = namedList(perTypeCount, `C${c}-${type}-`);
    }
    history.push({
      id: `reaction-global-${c}`, timestamp: '2026-09-01T00:00:00.000Z', agent_name: 'Author',
      action: 'create', file_path: filePath, message: 'seed', publicationStatus: 'published',
      reactions, commentCount: 0,
    });
  }
  const { baseUrl } = await spawnServer(t, { worldFiles, preloadState: { history } });

  // Reaching exactly 50,000: add one more distinct name to contribution 49's 'fire' type (249 -> 250,
  // still far under the 1,000/type cap), which is the 50,000th reaction entry overall.
  const reachingCap = await requestJson(baseUrl, '/api/contributions/reaction-global-49/reactions', {
    method: 'POST',
    headers: await powHeaders(baseUrl, '203.0.113.5'),
    body: JSON.stringify({ agent_name: 'FiftyThousandth', type: 'fire' }),
  });
  assert.equal(reachingCap.response.status, 200, 'the 50,000th reaction entry must still be accepted');

  // A brand-new contribution with zero reactions - nowhere near the per-type cap - still gets 409
  // globally, proving the rejection is the GLOBAL counter, not a per-type/per-contribution one.
  const overGlobalCap = await requestJson(baseUrl, '/api/contributions/reaction-global-0/reactions', {
    method: 'POST',
    headers: await powHeaders(baseUrl, '203.0.113.6'),
    body: JSON.stringify({ agent_name: 'FiftyThousandFirst', type: 'heart' }),
  });
  assert.equal(overGlobalCap.response.status, 409);
});

test('reactions (R1-W7): /api/admin/moderate delete decrements the global counter by the purged contribution\'s reaction entries', async (t) => {
  const victimPath = 'pages/reaction-purge-victim.html';
  const targetPath = 'pages/reaction-purge-target.html';
  const { baseUrl } = await spawnServer(t, {
    worldFiles: {
      [victimPath]: '<main><h1>Victim</h1></main>',
      [targetPath]: '<main><h1>Target</h1></main>',
    },
    preloadState: {
      history: [
        {
          id: 'reaction-purge-victim', timestamp: '2026-09-01T00:00:00.000Z', agent_name: 'Author',
          action: 'create', file_path: victimPath, message: 'seed', publicationStatus: 'published',
          // 49,900 reactions on a type this test never touches for this contribution again - a cap
          // that only applies at insert TIME for that (contribution, type) pair, not at load.
          reactions: { fire: namedList(49900, 'V'), heart: [], rocket: [], eyes: [] },
          commentCount: 0,
        },
        {
          id: 'reaction-purge-target', timestamp: '2026-09-01T00:00:01.000Z', agent_name: 'Author',
          action: 'create', file_path: targetPath, message: 'seed', publicationStatus: 'published',
          reactions: { fire: [], heart: [], rocket: namedList(100, 'T'), eyes: [] },
          commentCount: 0,
        },
      ],
    },
  });

  // Preloaded total is exactly 50,000 (49,900 + 100): the global cap is already reached.
  const beforePurge = await requestJson(baseUrl, '/api/contributions/reaction-purge-target/reactions', {
    method: 'POST',
    headers: await powHeaders(baseUrl, '203.0.113.7'),
    body: JSON.stringify({ agent_name: 'BeforePurge', type: 'eyes' }),
  });
  assert.equal(beforePurge.response.status, 409, 'the preloaded total is already at the 50,000 cap');

  const purge = await requestJson(baseUrl, '/api/admin/moderate', {
    method: 'POST',
    headers: cfHeaders('203.0.113.8', { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ secret: 'operator-secret', action: 'delete', target: victimPath }),
  });
  assert.equal(purge.response.status, 200);

  // Without R1-W7, the counter never drops and this stays 409 forever, even though the
  // contribution (and its 49,900 reactions) is gone.
  const afterPurge = await requestJson(baseUrl, '/api/contributions/reaction-purge-target/reactions', {
    method: 'POST',
    headers: await powHeaders(baseUrl, '203.0.113.9'),
    body: JSON.stringify({ agent_name: 'AfterPurge', type: 'eyes' }),
  });
  assert.equal(
    afterPurge.response.status, 200,
    'purging 49,900 reactions must free capacity for a new addition - the global counter must be decremented, not just the contribution removed',
  );
});

// --- R2-W2: MAX_HISTORY trim keeps the global reaction counter in sync --------------------------

test(
  'reactions (R2-W2): MAX_HISTORY trim subtracts the evicted contribution\'s reactions; '
  + 'a failed, rolled-back trim leaves the counter unchanged; a real trim frees capacity',
  async (t) => {
    const REACTION_TYPES = ['fire', 'heart', 'rocket', 'eyes'];
    const OLDEST_PER_TYPE = 512; // 4 * 512 = 2,048
    const OTHER_COUNT = 999;
    const OTHER_PER_ENTRY = 48; // 999 * 48 = 47,952; 47,952 + 2,048 = 50,000 exactly

    const worldFiles = {};
    const history = [];

    // Index 0 is the OLDEST entry (preloadState.history preserves array order, and history.shift()
    // always evicts index 0) - it is the one MAX_HISTORY trimming will evict first.
    const oldestPath = 'pages/r2w2-trim-0.html';
    worldFiles[oldestPath] = '<main><h1>Oldest (will be trimmed)</h1></main>';
    history.push({
      id: 'r2w2-trim-0', timestamp: '2026-09-01T00:00:00.000Z', agent_name: 'Author',
      action: 'create', file_path: oldestPath, message: 'seed', publicationStatus: 'published',
      reactions: Object.fromEntries(
        REACTION_TYPES.map(type => [type, namedList(OLDEST_PER_TYPE, `Oldest-${type}-`)]),
      ),
      commentCount: 0,
    });

    // All 999 "other" entries share ONE real file (multiple contribution IDs against the same
    // path, like successive edits) - MAX_FILES (1000, checked against the REAL world directory on
    // 'create', server/index.js ~4365) is a completely separate cap from MAX_HISTORY and must not
    // be exhausted by this test's preload, or the contributions this test makes below to exercise
    // the trim would themselves be rejected with 400 before ever reaching it.
    const sharedOtherPath = 'pages/r2w2-trim-other.html';
    worldFiles[sharedOtherPath] = '<main><h1>Shared entry</h1></main>';
    for (let i = 1; i <= OTHER_COUNT; i += 1) {
      history.push({
        id: `r2w2-trim-${i}`, timestamp: '2026-09-01T00:00:00.000Z', agent_name: 'Author',
        action: 'create', file_path: sharedOtherPath, message: 'seed', publicationStatus: 'published',
        reactions: { fire: namedList(OTHER_PER_ENTRY, `E${i}-`), heart: [], rocket: [], eyes: [] },
        commentCount: 0,
      });
    }
    assert.equal(history.length, 1000, 'test setup: exactly MAX_HISTORY entries, totalling 50,000 reactions');

    const { baseUrl, dataDir } = await spawnServer(t, { worldFiles, preloadState: { history } });

    // Baseline: the preloaded total is exactly the 50,000 global cap.
    const atCap = await requestJson(baseUrl, '/api/contributions/r2w2-trim-1/reactions', {
      method: 'POST',
      headers: await powHeaders(baseUrl, '203.0.113.230'),
      body: JSON.stringify({ agent_name: 'AtCap', type: 'heart' }),
    });
    assert.equal(atCap.response.status, 409, 'test setup: the preloaded total is already at the 50,000 cap');

    // A contribution that trims the oldest entry but then fails (its own state save fails) must
    // roll back the ENTIRE transaction, including the trim - same root-safe technique as the D5
    // rollback tests: state.json.tmp pre-created as a directory.
    const tmpStateFile = path.join(dataDir, 'state.json.tmp');
    await fs.mkdir(tmpStateFile);
    t.after(() => fs.rm(tmpStateFile, { recursive: true, force: true }).catch(() => {}));
    const failedContribute = await requestJson(baseUrl, '/api/contribute', {
      method: 'POST',
      headers: await powHeaders(baseUrl, '203.0.113.231'),
      body: JSON.stringify({
        agent_name: 'R2W2RollbackAgent', action: 'create', file_path: 'pages/r2w2-rollback-attempt.html',
        content: '<main><h1>Should roll back</h1></main>', message: 'triggers a trim, then fails',
      }),
    });
    assert.equal(failedContribute.response.status, 500);
    await fs.rm(tmpStateFile, { recursive: true, force: true });

    // Rollback must have restored the trimmed (oldest) contribution...
    const oldestAfterRollback = await requestJson(baseUrl, '/api/contributions/r2w2-trim-0');
    assert.equal(
      oldestAfterRollback.response.status, 200,
      'a rolled-back trim must restore the evicted contribution',
    );

    // ...and the global counter must be back at exactly the 50,000 cap - not left short by the
    // trimmed contribution's 2,048 reactions (which would wrongly let this addition through).
    const stillAtCap = await requestJson(baseUrl, '/api/contributions/r2w2-trim-1/reactions', {
      method: 'POST',
      headers: await powHeaders(baseUrl, '203.0.113.232'),
      body: JSON.stringify({ agent_name: 'StillAtCap', type: 'heart' }),
    });
    assert.equal(
      stillAtCap.response.status, 409,
      'a failed, rolled-back trim must leave the global reaction counter unchanged - still at the 50,000 cap',
    );

    // A contribution that actually succeeds trims the oldest for real, freeing exactly its 2,048
    // reactions and making the next addition (on an entry the trim never touches) succeed.
    const realContribute = await requestJson(baseUrl, '/api/contribute', {
      method: 'POST',
      headers: await powHeaders(baseUrl, '203.0.113.233'),
      body: JSON.stringify({
        agent_name: 'R2W2RealAgent', action: 'create', file_path: 'pages/r2w2-real.html',
        content: '<main><h1>Real trim</h1></main>', message: 'trims the oldest for real',
      }),
    });
    assert.equal(realContribute.response.status, 200);

    const oldestGone = await requestJson(baseUrl, '/api/contributions/r2w2-trim-0');
    assert.equal(
      oldestGone.response.status, 404,
      'the oldest contribution must have been evicted for real this time',
    );

    const freedCapacity = await requestJson(baseUrl, '/api/contributions/r2w2-trim-1/reactions', {
      method: 'POST',
      headers: await powHeaders(baseUrl, '203.0.113.234'),
      body: JSON.stringify({ agent_name: 'FreedCapacity', type: 'rocket' }),
    });
    assert.equal(
      freedCapacity.response.status, 200,
      'trimming the oldest contribution\'s 2,048 reactions must free capacity for a new addition - '
      + 'the global counter must be decremented, not just the contribution removed',
    );
  },
);

// --- R1-W9/R2-W1: the read-generation cache is bumped only for requests that could plausibly ------
// mutate state - never for a 404, a PoW-less 403, an unrouted /api/admin/* path, or an admin
// request rejected by its own rate limiter.

test('read-generation cache (R1-W9/R2-W1): 404s, a PoW-less 403, an unrouted admin path and an admin 429 do not invalidate the cache; an admin request that clears the limiter and a real write do', async (t) => {
  const { baseUrl, worldDir } = await spawnServer(t);

  const first = await requestJson(baseUrl, '/api/stats');
  assert.equal(first.response.status, 200);
  const baselineFileCount = first.body.fileCount;
  // `dropCounter` is the TOTAL number of marker files written so far, whether or not a bump has
  // revealed them yet - a bump reveals every accumulated drop at once (it forces a fresh
  // `listWorldFiles`), not just the one dropped since the last check. `visibleFileCount` tracks
  // what /api/stats is expected to show RIGHT NOW given which bumps have (not) happened.
  let dropCounter = 0;
  let visibleFileCount = baselineFileCount;
  async function dropFile() {
    dropCounter += 1;
    // A file that exists on disk right away but is invisible to a live-but-stale cache within the
    // 5s TTL - a bumped generation picks it up on the very next /api/stats call, an un-bumped one
    // keeps serving the stale count.
    await fs.writeFile(path.join(worldDir, `sneaked-in-${dropCounter}.html`), '<main>x</main>');
  }
  async function assertStatsStillStale(message) {
    const { body } = await requestJson(baseUrl, '/api/stats');
    assert.equal(body.fileCount, visibleFileCount, message);
  }
  async function assertStatsCaughtUp(message) {
    visibleFileCount = baselineFileCount + dropCounter;
    const { body } = await requestJson(baseUrl, '/api/stats');
    assert.equal(body.fileCount, visibleFileCount, message);
  }

  await dropFile();
  const notFound = await fetch(`${baseUrl}/api/this-route-does-not-exist`, { method: 'POST' });
  assert.equal(notFound.status, 404);

  const guestbookNoChallenge = await fetch(`${baseUrl}/api/guestbook`, {
    method: 'POST',
    headers: cfHeaders('203.0.113.198', { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ agent_name: 'NoPow', message: 'no challenge attached' }),
  });
  assert.equal(guestbookNoChallenge.status, 403);
  await assertStatsStillStale('a 404 and a PoW-less 403 must not invalidate the read cache');

  // R2-W1: an unrouted /api/admin/* path matches no route at all, so it never reaches the admin
  // rate limiter - it must never bump. This is the exact defect class R2-W1 fixed: the old
  // app-wide `app.use('/api/admin', ...)` bump ran before any route or limiter and matched this
  // path too, so an unauthenticated, unlimited burst of `POST /api/admin/<anything>` (404) could
  // defeat the cache for everyone.
  await dropFile();
  const adminUnrouted = await fetch(`${baseUrl}/api/admin/nope`, {
    method: 'POST',
    headers: cfHeaders('203.0.113.200', { 'Content-Type': 'application/json' }),
    body: JSON.stringify({}),
  });
  assert.equal(adminUnrouted.status, 404);
  await assertStatsStillStale('an unrouted /api/admin/* 404 must not invalidate the read cache');

  // An admin request that CLEARS the 5/min admin rate limiter bumps regardless of whether its own
  // secret check then succeeds or fails - bounded by that limiter, unlike the unrouted case above
  // which never reaches it. /api/admin/moderation is read-only when the secret is right and a
  // harmless 403 when it is wrong, so this exercises the bump without side effects.
  await dropFile();
  const adminWrongSecret = await requestJson(baseUrl, '/api/admin/moderation', {
    method: 'POST',
    headers: cfHeaders('203.0.113.200', { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ secret: 'wrong-secret' }),
  });
  assert.equal(adminWrongSecret.response.status, 403);
  await assertStatsCaughtUp(
    'an admin request that passed the 5/min limiter must invalidate the read cache, even with the wrong secret',
  );

  // 4 more hits (2nd-5th of the 5/min budget, same identity) - each still under the limiter, each
  // still bumping.
  for (let i = 0; i < 4; i += 1) {
    await dropFile();
    const hit = await requestJson(baseUrl, '/api/admin/moderation', {
      method: 'POST',
      headers: cfHeaders('203.0.113.200', { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ secret: 'wrong-secret' }),
    });
    assert.equal(hit.response.status, 403);
    await assertStatsCaughtUp(`admin hit ${i + 2} of 5 (still under the limiter) must also bump`);
  }

  // The 6th admin request within the 1-minute window is rate-limited (429) and must not bump.
  await dropFile();
  const adminRateLimited = await requestJson(baseUrl, '/api/admin/moderation', {
    method: 'POST',
    headers: cfHeaders('203.0.113.200', { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ secret: 'wrong-secret' }),
  });
  assert.equal(adminRateLimited.response.status, 429, 'the 6th admin request within the window must be rate-limited');
  await assertStatsStillStale('an admin request rejected with 429 must not invalidate the read cache');

  await dropFile();
  const ch = await challenge(baseUrl, '203.0.113.199');
  const guestbookOk = await requestJson(baseUrl, '/api/guestbook', {
    method: 'POST',
    headers: cfHeaders('203.0.113.199', {
      'Content-Type': 'application/json',
      'X-Challenge-Id': ch.id,
      'X-Challenge-Nonce': '0',
    }),
    body: JSON.stringify({ agent_name: 'RealGuest', message: 'a real successful write' }),
  });
  assert.equal(guestbookOk.response.status, 200);
  await assertStatsCaughtUp('a successful write must invalidate the read cache');
});

// --- R2-W3: the finish/close read-generation bump fires unconditionally, even for a failed --------
// and rolled-back mutation, so a read cached strictly WHILE it was in flight cannot keep serving
// that provisional snapshot for up to 5s afterward (Gate R1 F16).

test('read-generation cache (R2-W3): a read cached while a comment POST is in flight is recomputed once that POST fails and rolls back, even though it never succeeded', async (t) => {
  const targetPath = 'pages/r2w3-target.html';
  const { baseUrl, worldDir, dataDir } = await spawnServer(t, {
    worldFiles: { [targetPath]: '<main><h1>R2-W3 target</h1></main>' },
  });

  const before = await requestJson(baseUrl, '/api/stats');
  assert.equal(before.response.status, 200);
  const baselineCount = before.body.fileCount;

  // Same root-safe technique as the D5 rollback tests: state.json.tmp pre-created as a directory
  // makes every saveState() call (the initial persist AND the rollback's own re-persist) fail with
  // EISDIR, for anyone, root included.
  const tmpStateFile = path.join(dataDir, 'state.json.tmp');
  await fs.mkdir(tmpStateFile);
  t.after(() => fs.rm(tmpStateFile, { recursive: true, force: true }).catch(() => {}));

  let settled = false;
  const postPromise = requestJson(baseUrl, `/api/files/${targetPath}/comments`, {
    method: 'POST',
    headers: await powHeaders(baseUrl, '203.0.113.221'),
    body: JSON.stringify({ agent_name: 'R2W3Commenter', content: 'must not persist' }),
  }).then((result) => {
    settled = true;
    return result;
  });

  // A file that only becomes visible to /api/stats once its cache is (re)computed at a generation
  // at or after the comment POST's own start bump (armed inside requireProofOfWork, right after
  // its PoW check succeeds - before this handler does any of its own, slower work: lock
  // acquisition, moderation checks, insertCommentWithCap, and the two saveState() attempts that
  // are about to fail).
  await fs.writeFile(path.join(worldDir, 'r2w3-mid.html'), '<main>mid</main>');

  // Poll /api/stats as fast as possible while the comment POST is still in flight, trying to catch
  // a read cached strictly AFTER the start bump (r2w3-mid.html becomes visible) but BEFORE the
  // POST's failure/rollback triggers its own finish bump.
  let sawMidFlight = false;
  const pollDeadline = Date.now() + 5000;
  while (!settled && !sawMidFlight && Date.now() < pollDeadline) {
    const probe = await requestJson(baseUrl, '/api/stats');
    if (!settled && probe.body.fileCount === baselineCount + 1) sawMidFlight = true;
  }

  const failed = await postPromise;
  assert.equal(failed.response.status, 500);
  assert.equal(
    failed.body.error, 'Failed to persist comment',
    'the failure must be the comment-persist error (state save), proving insertCommentWithCap() actually ran',
  );
  await fs.rm(tmpStateFile, { recursive: true, force: true });

  assert.equal(
    sawMidFlight, true,
    'test setup: no read was cached strictly during the failing mutation - the race window needs '
    + 'widening (this is a test-infrastructure finding, not a claim about server/index.js)',
  );

  // The failed request must have restored the exact prior comment set (D5/R1-W4 semantics still hold).
  const afterFailureList = await requestJson(baseUrl, `/api/files/${targetPath}/comments`);
  assert.equal(afterFailureList.body.total, 0, 'a failed comment save must roll back the insert');

  // R2-W3: the finish/close bump must have fired UNCONDITIONALLY for the failed request above,
  // invalidating the snapshot cached mid-flight - a fresh disk change made only AFTER that request
  // settled must be visible on the very next /api/stats call, not hidden behind the stale,
  // mid-flight-cached generation for up to 5s.
  await fs.writeFile(path.join(worldDir, 'r2w3-after.html'), '<main>after</main>');
  const after = await requestJson(baseUrl, '/api/stats');
  assert.equal(
    after.body.fileCount, baselineCount + 2,
    'a read cached while a mutation was in flight must be recomputed once that mutation finishes '
    + '(unconditionally), even though the mutation failed and rolled back',
  );
});

// --- comments: D5 runtime eviction at 5,000 -----------------------------------------------------

// R1-W4: the state-save failure must be REAL and ISOLATED - only state.json's own write fails,
// while moderation.save() (recordAgentIpDurably, which both comment routes call BEFORE the insert)
// still succeeds. The original technique (chmod 0500 on the whole data dir) blocked EVERY write
// under the data dir, so recordAgentIpDurably (which persists to moderation.json, a completely
// different file) failed FIRST - insertCommentWithCap() never even ran, and the eviction rollback
// this test claims to guard was never exercised (measured: the mutation
// `restoreCommentsOrder(...)` -> `comments.delete(comment.id)` stayed GREEN on both paths). Fix,
// root-safe (a chmod-only technique is a no-op for a process running as root): pre-create
// `state.json.tmp` as a DIRECTORY. `fs.writeFile` to an existing directory always fails with
// EISDIR, for anyone, root included - and moderation.json.tmp is an unrelated path, left
// untouched, so recordAgentIpDurably still succeeds and the request reaches
// insertCommentWithCap().
async function assertD5RollbackIsReal(t, { baseUrl, dataDir, commentsPath, commentPayload, listPath }) {
  const flatten = (nodes) => nodes.flatMap(n => [n, ...flatten(n.replies || [])]);
  const oldestId = 'comment-00000';

  const beforeList = await requestJson(baseUrl, listPath);
  assert.equal(beforeList.body.total, 5000);

  const tmpStateFile = path.join(dataDir, 'state.json.tmp');
  await fs.mkdir(tmpStateFile);
  t.after(() => fs.rm(tmpStateFile, { recursive: true, force: true }).catch(() => {}));
  const failed = await requestJson(baseUrl, commentsPath, {
    method: 'POST',
    headers: await powHeaders(baseUrl, '203.0.113.11'),
    body: JSON.stringify(commentPayload('ShouldRollBack', 'this must not persist')),
  });
  assert.equal(failed.response.status, 500);
  assert.equal(
    failed.body.error, 'Failed to persist comment',
    'the failure must be the comment-persist error (state save), not the moderation-save error - proving recordAgentIpDurably succeeded and insertCommentWithCap() actually ran',
  );
  await fs.rm(tmpStateFile, { recursive: true, force: true });

  const afterFailureList = await requestJson(baseUrl, listPath);
  assert.equal(afterFailureList.body.total, 5000, 'a failed save must restore the exact prior comment set');
  const afterFailureIds = flatten(afterFailureList.body.comments).map(c => c.id);
  assert.equal(afterFailureIds.includes(oldestId), true, 'the evicted comment must be back after rollback');
  assert.equal(
    flatten(afterFailureList.body.comments).some(c => c.content === 'this must not persist'),
    false,
    'the failed comment must not appear after rollback',
  );

  // Now the same insert succeeds (the directory is gone): comment-00000 is evicted for real and
  // the in-memory total stays at 5,000.
  const posted = await requestJson(baseUrl, commentsPath, {
    method: 'POST',
    headers: await powHeaders(baseUrl, '203.0.113.10'),
    body: JSON.stringify(commentPayload('NewCommenter', 'the real next comment')),
  });
  assert.equal(posted.response.status, 200);

  const afterList = await requestJson(baseUrl, listPath);
  assert.equal(afterList.body.total, 5000, 'the in-memory total must stay capped at 5,000');
  const afterIds = flatten(afterList.body.comments).map(c => c.id);
  assert.equal(afterIds.includes(oldestId), false, 'the oldest comment must have been evicted');
  assert.equal(afterIds.includes(posted.body.comment.id), true);
}

test('comments (R1-W4, /api/files path): at the 5,000 cap the oldest is evicted at insert time; a REAL, isolated saveState failure rolls the eviction back', async (t) => {
  const targetPath = 'pages/comments-target.html';
  const preloadedComments = {};
  for (let i = 0; i < 5000; i += 1) {
    const id = `comment-${String(i).padStart(5, '0')}`;
    preloadedComments[id] = {
      id, targetType: 'file', targetId: targetPath, agentName: 'Seeder',
      content: `seed comment ${i}`, parentId: null, timestamp: '2026-09-01T00:00:00.000Z',
    };
  }
  const { baseUrl, dataDir } = await spawnServer(t, {
    worldFiles: { [targetPath]: '<main><h1>Comments target</h1></main>' },
    preloadState: { comments: preloadedComments },
  });

  await assertD5RollbackIsReal(t, {
    baseUrl,
    dataDir,
    commentsPath: `/api/files/${targetPath}/comments`,
    listPath: `/api/files/${targetPath}/comments`,
    commentPayload: (agent_name, content) => ({ agent_name, content }),
  });
});

test('comments (R1-W4, /api/contributions path): at the 5,000 cap the oldest is evicted at insert time; a REAL, isolated saveState failure rolls the eviction back', async (t) => {
  const contributionId = 'comments-target-contribution';
  const contributionPath = 'pages/comments-target-contribution.html';
  const preloadedComments = {};
  for (let i = 0; i < 5000; i += 1) {
    const id = `comment-${String(i).padStart(5, '0')}`;
    preloadedComments[id] = {
      id, targetType: 'contribution', targetId: contributionId, agentName: 'Seeder',
      content: `seed comment ${i}`, parentId: null, timestamp: '2026-09-01T00:00:00.000Z',
    };
  }
  const { baseUrl, dataDir } = await spawnServer(t, {
    worldFiles: { [contributionPath]: '<main><h1>Comments target</h1></main>' },
    preloadState: {
      history: [{
        id: contributionId, timestamp: '2026-09-01T00:00:00.000Z', agent_name: 'Author',
        action: 'create', file_path: contributionPath, message: 'seed', publicationStatus: 'published',
        reactions: { fire: [], heart: [], rocket: [], eyes: [] }, commentCount: 0,
      }],
      comments: preloadedComments,
    },
  });

  await assertD5RollbackIsReal(t, {
    baseUrl,
    dataDir,
    commentsPath: `/api/contributions/${contributionId}/comments`,
    listPath: `/api/contributions/${contributionId}/comments`,
    commentPayload: (agent_name, content) => ({ agent_name, content }),
  });
});

// --- line_number validation --------------------------------------------------------------------

test('file comments: line_number must be null or an integer 1..1,000,000', async (t) => {
  const targetPath = 'pages/line-number-target.html';
  const { baseUrl } = await spawnServer(t, {
    worldFiles: { [targetPath]: '<main><h1>Line number target</h1></main>' },
  });

  const badObject = await requestJson(baseUrl, `/api/files/${targetPath}/comments`, {
    method: 'POST',
    headers: await powHeaders(baseUrl, '203.0.113.20'),
    body: JSON.stringify({ agent_name: 'Liner', content: 'bad line number', line_number: { a: 1 } }),
  });
  assert.equal(badObject.response.status, 400);

  const good = await requestJson(baseUrl, `/api/files/${targetPath}/comments`, {
    method: 'POST',
    headers: await powHeaders(baseUrl, '203.0.113.21'),
    body: JSON.stringify({ agent_name: 'Liner', content: 'good line number', line_number: 42 }),
  });
  assert.equal(good.response.status, 200);
  assert.equal(good.body.comment.lineNumber, 42);
});

// --- votes cap: <=5,000 distinct voters per section across up+down ------------------------------

test('votes: preloaded 5,000 voters on a section - the 5,001st distinct voter is rejected with 409', async (t) => {
  const sectionPath = 'sections/voted.html';
  const upVoters = namedList(5000, 'Voter');
  const { baseUrl } = await spawnServer(t, {
    worldFiles: { [sectionPath]: '<section data-section-title="Voted"><h2>Voted</h2></section>' },
    preloadState: {
      sectionVotes: { [sectionPath]: { up: upVoters, down: [] } },
    },
  });

  const overCap = await requestJson(baseUrl, '/api/vote', {
    method: 'POST',
    headers: await powHeaders(baseUrl, '203.0.113.30'),
    body: JSON.stringify({ agent_name: 'OneTooManyVoter', section_file: sectionPath, vote: 'up' }),
  });
  assert.equal(overCap.response.status, 409);

  // An existing voter toggling their own vote must still work at the cap.
  const toggle = await requestJson(baseUrl, '/api/vote', {
    method: 'POST',
    headers: await powHeaders(baseUrl, '203.0.113.31'),
    body: JSON.stringify({ agent_name: upVoters[0], section_file: sectionPath, vote: 'up' }),
  });
  assert.equal(toggle.response.status, 200);
  assert.equal(toggle.body.action, 'removed_upvote');
});

// --- agents cap: <=20,000 agent records, checked before any Git work -----------------------------

test('agents: preloaded 20,000 agents - a contribution from a new name is rejected with 503 before any Git work', async (t) => {
  const preloadedAgents = {};
  // A full, realistic agent shape - trackAgentContribution() dereferences fileTypeStats,
  // recentContributionTimes, etc. unconditionally on an EXISTING agent, so a bare `{}` (as a real
  // agent record can never be) would throw a TypeError deep in production code, not exercise the cap.
  for (let i = 0; i < 20000; i += 1) {
    const id = `fake-id-${i}`;
    preloadedAgents[`FakeAgent${i}`] = {
      id, name: `FakeAgent${i}`, bio: '', avatar: { type: 'generated', seed: id },
      specializations: [], profileSpecializations: [], contributions: 0, creates: 0, edits: 0,
      deletes: 0, reactionsReceived: 0, reactionsGiven: 0, commentsCount: 0, fileTypeStats: {},
      collaborators: [], nightContributions: 0, recentContributionTimes: [],
      speedDemonUnlocked: false, firstSeen: '2026-01-01T00:00:00.000Z', lastSeen: '2026-01-01T00:00:00.000Z',
    };
  }
  const { baseUrl, worldDir } = await spawnServer(t, {
    preloadState: { agents: preloadedAgents },
  });

  const beforeRevCount = await gitRevCount(worldDir);
  const result = await requestJson(baseUrl, '/api/contribute', {
    method: 'POST',
    headers: await powHeaders(baseUrl, '203.0.113.40'),
    body: JSON.stringify({
      agent_name: 'BrandNewAgent', action: 'create', file_path: 'pages/brand-new.html',
      content: '<main><h1>New</h1></main>', message: 'should be rejected',
    }),
  });
  assert.equal(result.response.status, 503);
  const afterRevCount = await gitRevCount(worldDir);
  assert.equal(afterRevCount, beforeRevCount, 'a rejected over-cap contribution must not create a commit');

  // An existing agent name (already counted) must still be allowed to contribute.
  const existing = await requestJson(baseUrl, '/api/contribute', {
    method: 'POST',
    headers: await powHeaders(baseUrl, '203.0.113.41'),
    body: JSON.stringify({
      agent_name: 'FakeAgent0', action: 'create', file_path: 'pages/existing-agent.html',
      content: '<main><h1>Existing</h1></main>', message: 'existing agent still works',
    }),
  });
  assert.equal(existing.response.status, 200);
});

// --- /api/search validation: q must be a plain string of 2-100 chars ----------------------------

test('/api/search: array/object q (500 before this hardening) and an over-long q both -> 400', async (t) => {
  const { baseUrl } = await spawnServer(t);

  const arrayQuery = await fetch(`${baseUrl}/api/search?q[]=ab&q[]=cd`, { headers: cfHeaders('203.0.113.50') });
  assert.equal(arrayQuery.status, 400);

  const objectQuery = await fetch(`${baseUrl}/api/search?q[a]=xyz`, { headers: cfHeaders('203.0.113.50') });
  assert.equal(objectQuery.status, 400);

  const tooLong = await fetch(`${baseUrl}/api/search?q=${'a'.repeat(101)}`, { headers: cfHeaders('203.0.113.50') });
  assert.equal(tooLong.status, 400);

  const valid = await fetch(`${baseUrl}/api/search?q=ab`, { headers: cfHeaders('203.0.113.50') });
  assert.equal(valid.status, 200);
});

// --- generation cache: a mutation must invalidate the cached read within its 5s TTL --------------

test('the read-cache generation bump makes a fresh contribution visible on /api/network/graph immediately (not after 5s)', async (t) => {
  const { baseUrl } = await spawnServer(t);

  const before = await requestJson(baseUrl, '/api/network/graph', { headers: cfHeaders('203.0.113.60') });
  assert.equal(before.response.status, 200);
  const beforeCount = before.body.nodes.length;

  const result = await requestJson(baseUrl, '/api/contribute', {
    method: 'POST',
    headers: await powHeaders(baseUrl, '203.0.113.61'),
    body: JSON.stringify({
      agent_name: 'FreshGraphAgent', action: 'create', file_path: 'pages/fresh-graph-agent.html',
      content: '<main><h1>Fresh</h1></main>', message: 'must invalidate the cached graph',
    }),
  });
  assert.equal(result.response.status, 200);

  // Immediately after the mutation, well inside the 5s TTL: without the generation bump this would
  // still serve the pre-mutation cached graph.
  const after = await requestJson(baseUrl, '/api/network/graph', { headers: cfHeaders('203.0.113.60') });
  assert.equal(after.response.status, 200);
  assert.equal(after.body.nodes.length, beforeCount + 1,
    'the generation bump on a mutation must invalidate the cached graph within its TTL');
});

// --- INFO (c): diff single-flight must sit OUTSIDE the semaphore --------------------------------

test('diff (INFO c): 25 concurrent requests over 3 keys never 503 - followers of an in-flight key must not consume a semaphore slot/waiter', async (t) => {
  // Fake gitHash values never match a real commit, so computeContributionDiff() short-circuits
  // through `git log` quickly ('Failed to get diff' or 'No git diff available') without needing a
  // real git history - this test only cares about the semaphore/single-flight admission path
  // ahead of that computation, not its result. Before the fix, single-flight ran INSIDE the
  // semaphore, so every one of the 25 requests (leader or follower) queued on the semaphore first;
  // with only 3 distinct keys needing real work, that could exhaust the semaphore's 2+16 capacity
  // (measured: 18x200, 7x503) even though a follower never needed a slot of its own.
  const contributionIds = ['diff-key-a', 'diff-key-b', 'diff-key-c'];
  const worldFiles = {};
  const history = contributionIds.map((id, i) => {
    worldFiles[`pages/diff-${i}.html`] = `<main>${id}</main>`;
    return {
      id, timestamp: '2026-09-01T00:00:00.000Z', agent_name: 'Author',
      action: 'create', file_path: `pages/diff-${i}.html`, message: 'seed', publicationStatus: 'published',
      gitHash: 'a'.repeat(40),
      reactions: { fire: [], heart: [], rocket: [], eyes: [] }, commentCount: 0,
    };
  });
  const { baseUrl } = await spawnServer(t, { worldFiles, preloadState: { history } });

  const requests = [];
  for (let i = 0; i < 25; i += 1) {
    const id = contributionIds[i % 3];
    requests.push(requestJson(baseUrl, `/api/contributions/${id}/diff`, { headers: cfHeaders(`203.0.113.${20 + i}`) }));
  }
  const results = await Promise.all(requests);
  const statuses = results.map(r => r.response.status);
  assert.equal(statuses.every(s => s === 200), true, `expected all 200, got: ${statuses.join(',')}`);
});

// --- INFO (i): untested resource bounds, exercised where feasible within seconds ------------------

test('sections (INFO i): the 4 MiB content budget sets truncated:true and omits content beyond it', async (t) => {
  const worldFiles = {};
  for (let i = 1; i <= 5; i += 1) {
    const header = `<section data-section-title="S${i}">`;
    const footer = '</section>';
    const padLen = 1_000_000 - header.length - footer.length;
    worldFiles[`sections/s${i}.html`] = header + 'x'.repeat(padLen) + footer;
  }
  const { baseUrl } = await spawnServer(t, { worldFiles });

  const { response, body } = await requestJson(baseUrl, '/api/world/sections');
  assert.equal(response.status, 200);
  assert.equal(body.truncated, true);
  const byFile = new Map(body.sections.map(s => [s.file, s]));
  // 4 files x 1,000,000 bytes = 4,000,000, still under the 4,194,304-byte (4 MiB) budget; the 5th
  // pushes the running total over it.
  assert.notEqual(byFile.get('s1.html').content, undefined);
  assert.notEqual(byFile.get('s4.html').content, undefined);
  assert.equal(byFile.get('s5.html').content, undefined, 'the 5th file exceeds the 4 MiB running budget and must omit content');
});

test('network graph (INFO i): more than 5,000 edges sets truncated:true and caps the edges array at 5,000', async (t) => {
  const filePath = 'pages/shared.html';
  const agentCount = 101; // C(101,2) = 5,050 edges from one shared file - just over the 5,000 cap
  const history = Array.from({ length: agentCount }, (_, i) => ({
    id: `graph-edge-${i}`, timestamp: '2026-09-01T00:00:00.000Z', agent_name: `GraphAgent${i}`,
    action: 'create', file_path: filePath, message: 'seed', publicationStatus: 'published',
    reactions: { fire: [], heart: [], rocket: [], eyes: [] }, commentCount: 0,
  }));
  const { baseUrl } = await spawnServer(t, {
    worldFiles: { [filePath]: '<main><h1>Shared</h1></main>' },
    preloadState: { history },
  });

  const { response, body } = await requestJson(baseUrl, '/api/network/graph');
  assert.equal(response.status, 200);
  assert.equal(body.truncated, true);
  assert.equal(body.edges.length, 5000);
  assert.equal(body.stats.totalConnections, 5050);
});

test('/api/stats (INFO i): served from the 5s generation-bound cache - two calls within 5s see the same snapshot even after a direct disk change', async (t) => {
  const { baseUrl, worldDir } = await spawnServer(t);
  const first = await requestJson(baseUrl, '/api/stats');
  assert.equal(first.response.status, 200);

  await fs.writeFile(path.join(worldDir, 'cache-probe.html'), '<main>probe</main>');

  const second = await requestJson(baseUrl, '/api/stats');
  assert.equal(
    second.body.fileCount, first.body.fileCount,
    'within the 5s TTL and with no generation bump, /api/stats must keep serving the cached snapshot',
  );
});

// --- R3-W1 (guards R2-W4): the admin profile-token route must wait for CONTRIBUTION_STATE_LOCK ----
// like every other credentials mutation - R2-W4 fixed this (server/index.js ~2686), but round 3
// found no regression test could see it (R3-W1). Technique: a blocking World `pre-commit` hook holds
// a concurrent /api/contribute inside git commit (and therefore inside CONTRIBUTION_STATE_LOCK,
// acquired well before the commit call) while an admin issue request for an unrelated, already-
// existing agent is in flight. Without the lock the admin request finishes first; with it, it cannot
// finish until the hook is released.

async function waitForMarker(markerPath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { await fs.access(markerPath); return true; } catch { /* retry */ }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return false;
}

test('admin profile-token issue (R3-W1/R2-W4): waits for CONTRIBUTION_STATE_LOCK while a concurrent /api/contribute holds it inside git commit', async (t) => {
  const dirRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aibuilds-lock-order-'));
  const worldDir = path.join(dirRoot, 'world');
  const dataDir = path.join(dirRoot, 'data');
  await fs.mkdir(path.join(worldDir, 'pages'), { recursive: true });
  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(path.join(dirRoot, 'backups'), { recursive: true });

  const existingPath = 'pages/lock-order-existing.html';
  await fs.writeFile(path.join(worldDir, existingPath), '<main><h1>Existing</h1></main>');
  await fs.writeFile(path.join(dataDir, 'state.json'), JSON.stringify({
    history: [{
      id: 'lock-order-existing', timestamp: '2026-09-01T00:00:00.000Z', agent_name: 'Existing',
      action: 'create', file_path: existingPath, message: 'seed',
      reactions: { fire: [], heart: [], rocket: [], eyes: [] }, commentCount: 0,
    }],
    agents: {
      Existing: { name: 'Existing', contributions: 1, commentsCount: 0, reactionsReceived: 0 },
    },
  }));

  // Pre-create the World git repo, WITH its seed commit, before the server ever starts: the
  // server's own startup init() only runs `git.status()` (no commit of its own) once a repo with
  // history already exists, so the seed commit below never touches the hook installed later. A
  // core.hooksPath in the developer's global Git config would otherwise replace .git/hooks outright
  // and silently disarm that hook - pinning it to this repo's own hooks dir keeps the throwaway repo
  // hermetic regardless of the host's config (same footgun documented in
  // test/git-index-confinement.test.js and test/admin-quarantine.test.js).
  const git = (...args) => execFileAsync('git', args, { cwd: worldDir, encoding: 'utf8' });
  await execFileAsync('git', ['init'], { cwd: worldDir });
  await git('config', 'user.email', 'test@example.invalid');
  await git('config', 'user.name', 'Lock Order Test');
  await git('config', 'core.hooksPath', path.join(worldDir, '.git', 'hooks'));
  await git('add', '.');
  await git('commit', '-m', 'seed world');

  // Registered before spawnServer's own kill-and-wait hook (FIFO t.after order, see spawnServer
  // above) so a failing or hanging run always releases the hook FIRST - a hung git-commit child
  // would otherwise survive its parent's SIGTERM and block forever, and the temp dir below would
  // never be removable.
  const enteredMarker = path.join(dirRoot, 'hook-entered');
  const releaseMarker = path.join(dirRoot, 'hook-release');
  t.after(() => fs.writeFile(releaseMarker, '').catch(() => {}));

  const { baseUrl, logs } = await spawnServer(t, { root: dirRoot });
  t.after(() => fs.rm(dirRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {}));

  // Installed only now, after the server is up and its startup git.status() has already found an
  // initialized repo - only the /api/contribute commit below ever runs this hook.
  const hookPath = path.join(worldDir, '.git', 'hooks', 'pre-commit');
  await fs.writeFile(hookPath, [
    '#!/bin/sh',
    `touch '${enteredMarker}'`,
    // Also stop once the temp dir is gone: cleanup removes it right after writing the release
    // marker, and a hook that misses the marker between two polls would otherwise spin forever.
    `while [ ! -f '${releaseMarker}' ] && [ -d '${dirRoot}' ]; do`,
    '  sleep 0.05',
    'done',
    'exit 0',
    '',
  ].join('\n'));
  await fs.chmod(hookPath, 0o755);

  const order = [];
  const contributePromise = requestJson(baseUrl, '/api/contribute', {
    method: 'POST',
    headers: await powHeaders(baseUrl, '203.0.113.240'),
    body: JSON.stringify({
      agent_name: 'NewLockOrderAgent', action: 'create', file_path: 'pages/lock-order-new.html',
      content: '<main><h1>New</h1></main>', message: 'blocks inside the pre-commit hook',
    }),
  }).then((result) => { order.push('contribute'); return result; });

  const enteredHook = await waitForMarker(enteredMarker, 5000);
  assert.equal(enteredHook, true,
    'test setup: the contribute request must reach the blocking pre-commit hook (still holding CONTRIBUTION_STATE_LOCK)');

  const adminPromise = requestJson(baseUrl, '/api/admin/agents/Existing/profile-token', {
    method: 'POST',
    headers: cfHeaders('203.0.113.241', { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ secret: 'operator-secret', action: 'issue' }),
  }).then((result) => { order.push('admin'); return result; });

  // The admin request must still be pending 1s after the hook was entered - if it had already
  // finished, it did not wait for CONTRIBUTION_STATE_LOCK.
  const raceOutcome = await Promise.race([
    adminPromise.then(() => 'admin-settled'),
    new Promise(resolve => setTimeout(() => resolve('timeout'), 1000)),
  ]);
  assert.equal(raceOutcome, 'timeout',
    'the admin issue request must still be blocked on the lock 1s after the contribute request entered the hook');

  await fs.writeFile(releaseMarker, '');

  const [contributeResult, adminResult] = await Promise.all([contributePromise, adminPromise]);
  assert.equal(contributeResult.response.status, 200, logs.join(''));
  assert.equal(adminResult.response.status, 200, logs.join(''));
  assert.deepEqual(order, ['contribute', 'admin'],
    'the admin issue request must not complete before the concurrent /api/contribute holding CONTRIBUTION_STATE_LOCK inside git commit does');
});
