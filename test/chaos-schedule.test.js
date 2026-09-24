'use strict';

// Regression coverage for T1 of docs/superpowers/plans/2026-09-24-chaos-schedule-reset.md: the
// activation scheduled by scheduleChaosMode() must not outlive an admin reset or a manual trigger
// with a stale handle. scheduleChaosMode() is the single owner of that handle
// (chaosScheduleTimer): it clears any pending activation before arming a new one, so a handle left
// over from before a reset or a trigger can never fire alongside the freshly-armed one.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

// Trailing \s is load-bearing (NEXT_SESSION.md "Fallen" #2).
const SERVER_PORT_PATTERN = /Server:\s+http:\/\/localhost:(\d+)\s/;

// Lead time between the preloaded nextAt and its scheduled firing - long enough for the server to
// boot and the test's own request to complete well before it, short enough to keep the test fast.
const L = 5000;
const DAY_MS = 24 * 60 * 60 * 1000;

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

async function spawnServer(t, { preloadState } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aibuilds-chaos-schedule-'));
  // Single root-owning t.after hook, registered right here at mkdtemp: it terminates the still-live
  // child (if any) and waits for its real exit before removing the tree - the repo's standard
  // pattern (test/git-error-detection.test.js, test/git-index-confinement.test.js). Registering it
  // this early means a failure during setup, before spawn ever runs, still cleans up (child stays
  // null, so the kill is a no-op).
  let child = null;
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await once(child, 'exit');
    }
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
  });

  const worldDir = path.join(root, 'world');
  const dataDir = path.join(root, 'data');
  const backupDir = path.join(root, 'backups');
  await fs.mkdir(worldDir, { recursive: true });
  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(backupDir, { recursive: true });
  if (preloadState) {
    await fs.writeFile(path.join(dataDir, 'state.json'), JSON.stringify(preloadState));
  }

  const logs = [];
  child = spawn(process.execPath, ['server/index.js'], {
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
  const baseUrl = await waitForRealServer(child, logs);
  return { baseUrl, logs };
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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function sleepUntil(deadline) {
  const remaining = deadline - Date.now();
  if (remaining > 0) await sleep(remaining);
}

// --- test 1: an admin reset must cancel the activation pending from before it -------------------

test(
  'admin reset cancels the chaos activation pending from before it and re-schedules from the '
  + 'reset platform\'s own clock',
  async (t) => {
    const t0 = Date.now();
    const nextAt = new Date(t0 + L).toISOString();
    const { baseUrl } = await spawnServer(t, {
      preloadState: { chaosMode: { active: false, endsAt: null, nextAt } },
    });

    const resetResult = await requestJson(baseUrl, '/api/admin/reset', {
      method: 'POST',
      headers: cfHeaders('203.0.113.1', { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ secret: 'operator-secret' }),
    });
    assert.equal(resetResult.response.status, 200, JSON.stringify(resetResult.body));
    assert.ok(
      Date.now() < t0 + L,
      'test precondition: the reset must complete before the preloaded activation would have fired',
    );

    const afterReset = await requestJson(baseUrl, '/api/chaos');
    assert.equal(afterReset.response.status, 200);
    const newNextAt = new Date(afterReset.body.nextAt).getTime();
    const now = Date.now();
    assert.ok(
      Math.abs(newNextAt - (now + DAY_MS)) <= 60_000,
      `nextAt must be re-armed to ~24h from now right after the reset (got ${afterReset.body.nextAt}, `
      + `now ${new Date(now).toISOString()})`,
    );

    // Past the moment the stale, preloaded activation was scheduled to fire: without T1 the old
    // handle survives the reset and activates chaos on the reset platform here.
    await sleepUntil(t0 + L + 1500);

    const settled = await requestJson(baseUrl, '/api/chaos');
    assert.equal(settled.response.status, 200);
    assert.equal(
      settled.body.active, false,
      'the activation pending from before the reset must not have fired on the reset platform',
    );
  },
);

// --- test 2: a manual trigger must replace the pending activation, not leave the old one armed ---

test(
  'a manual chaos trigger replaces the activation pending for the old nextAt - no stale '
  + 'double-activation and no drifted nextAt',
  async (t) => {
    const t0 = Date.now();
    const nextAt = new Date(t0 + L).toISOString();
    const { baseUrl, logs } = await spawnServer(t, {
      preloadState: { chaosMode: { active: false, endsAt: null, nextAt } },
    });

    const triggerHeaders = await powHeaders(baseUrl, '203.0.113.2', { 'Content-Type': 'application/json' });
    const triggerResult = await requestJson(baseUrl, '/api/chaos/trigger', {
      method: 'POST',
      headers: triggerHeaders,
      body: JSON.stringify({ secret: 'operator-secret' }),
    });
    const triggerTime = Date.now();
    assert.equal(triggerResult.response.status, 200, JSON.stringify(triggerResult.body));
    assert.ok(
      triggerTime < t0 + L,
      'test precondition: the trigger must complete before the preloaded activation would have fired',
    );

    // Past the moment the stale, preloaded activation was scheduled to fire: without T1 it still
    // fires here, on top of the one the trigger itself caused - a second activation line.
    await sleepUntil(t0 + L + 1500);

    const activationLines = logs.join('').split('\n')
      .filter(line => line.includes('[CHAOS] Chaos mode activated!'));
    assert.equal(
      activationLines.length, 1,
      `expected exactly one activation line, got ${activationLines.length}:\n${logs.join('')}`,
    );

    const after = await requestJson(baseUrl, '/api/chaos');
    assert.equal(after.response.status, 200);
    const gotNextAt = new Date(after.body.nextAt).getTime();
    const expectedNextAt = triggerTime + DAY_MS;
    assert.ok(
      Math.abs(gotNextAt - expectedNextAt) <= 2000,
      `nextAt must be trigger time + 24h within +-2s (got ${after.body.nextAt}, expected ~`
      + `${new Date(expectedNextAt).toISOString()})`,
    );
  },
);
