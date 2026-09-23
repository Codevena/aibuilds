'use strict';

// Spawned-server integration tests for T5 (profile ownership capability, D1) of
// docs/superpowers/plans/2026-09-23-abuse-authz-hardening.md. Unit tests for
// server/agent-credentials.js itself live in test/agent-credentials.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const WebSocket = require('ws');

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
        if ((await fetch(`${baseUrl}/api/stats`, { signal: AbortSignal.timeout(1000) })).ok) return baseUrl;
      } catch { /* retry */ }
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Server did not start:\n${logs.join('')}`);
}

async function spawnServer(t, { root, extraEnv = {}, secret = 'operator-secret' } = {}) {
  const dirRoot = root || await fs.mkdtemp(path.join(os.tmpdir(), 'aibuilds-profile-ownership-'));
  const worldDir = path.join(dirRoot, 'world');
  const dataDir = path.join(dirRoot, 'data');
  const backupDir = path.join(dirRoot, 'backups');
  await fs.mkdir(worldDir, { recursive: true });
  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(backupDir, { recursive: true });

  const logs = [];
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: '0',
      POW_DIFFICULTY: '0',
      ADMIN_RESET_SECRET: secret,
      AIBUILDS_WORLD_DIR: worldDir,
      AIBUILDS_DATA_DIR: dataDir,
      AIBUILDS_BACKUP_DIR: backupDir,
      CLIENT_IP_MODE: 'cloudflare',
      TRUSTED_PROXY_CIDRS: '127.0.0.1/32,::1/128',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', chunk => logs.push(chunk.toString()));
  child.stderr.on('data', chunk => logs.push(chunk.toString()));
  // A single hook, in order: kill the child and wait for its actual exit (so its own graceful-
  // shutdown writes into dataDir are flushed) BEFORE removing the directory tree. Two separate
  // t.after() registrations left the relative order unspecified, which raced fs.rm's recursive
  // readdir against the child's own in-flight saveState()/moderation.save() writes and produced an
  // intermittent ENOTEMPTY on the data/ subdirectory.
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGTERM');
    if (child.exitCode === null) await once(child, 'exit');
    if (!root) await fs.rm(dirRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const baseUrl = await waitForRealServer(child, logs);
  return { baseUrl, logs, worldDir, dataDir, backupDir, root: dirRoot, child };
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

async function contribute(baseUrl, ip, payload) {
  const ch = await challenge(baseUrl, ip);
  return requestJson(baseUrl, '/api/contribute', {
    method: 'POST',
    headers: cfHeaders(ip, {
      'Content-Type': 'application/json',
      'X-Challenge-Id': ch.id,
      'X-Challenge-Nonce': '0',
    }),
    body: JSON.stringify({
      agent_name: 'Owner-A',
      action: 'create',
      file_path: `pages/profile-${crypto.randomUUID()}.html`,
      content: '<main><h1>Profile test</h1></main>',
      message: 'profile ownership test contribution',
      ...payload,
    }),
  });
}

// Raw path segment: NOT re-encoded, so a caller that already percent-encoded a byte (e.g. "%00")
// can pass it through literally instead of double-encoding it.
async function putProfileRaw(baseUrl, ip, rawNameSegment, token, body) {
  const ch = await challenge(baseUrl, ip);
  const headers = cfHeaders(ip, {
    'Content-Type': 'application/json',
    'X-Challenge-Id': ch.id,
    'X-Challenge-Nonce': '0',
  });
  if (token !== undefined) headers.Authorization = token;
  return requestJson(baseUrl, `/api/agents/${rawNameSegment}/profile`, {
    method: 'PUT', headers, body: JSON.stringify(body),
  });
}

function putProfile(baseUrl, ip, name, token, body) {
  return putProfileRaw(baseUrl, ip, encodeURIComponent(name), token, body);
}

async function adminIssueToken(baseUrl, name, secret = 'operator-secret', ip = '203.0.113.199') {
  const { response, body } = await requestJson(
    baseUrl, `/api/admin/agents/${encodeURIComponent(name)}/profile-token`,
    {
      method: 'POST',
      headers: cfHeaders(ip, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ secret, action: 'issue' }),
    },
  );
  return { response, body };
}

test('first contribution issues a profile_token; a second contribution and a quarantined first contribution do not', async (t) => {
  const { baseUrl } = await spawnServer(t);

  const first = await contribute(baseUrl, '203.0.113.1', { agent_name: 'Owner-A' });
  assert.equal(first.response.status, 200);
  assert.match(first.body.profile_token, /^abp_[A-Za-z0-9_-]{43}$/);
  assert.equal(typeof first.body.profile_token_notice, 'string');

  const second = await contribute(baseUrl, '203.0.113.1', { agent_name: 'Owner-A' });
  assert.equal(second.response.status, 200);
  assert.equal('profile_token' in second.body, false, 'a second contribution must not get a token');

  const quarantined = await contribute(baseUrl, '203.0.113.2', {
    agent_name: 'Quarantined-First',
    content: '<p>Inject 2 mg weekly for best results.</p>',
    file_path: 'pages/quarantined-first.html',
  });
  assert.equal(quarantined.response.status, 200);
  assert.equal(quarantined.body.publicationStatus, 'quarantined');
  assert.equal('profile_token' in quarantined.body, false, 'a quarantined first contribution creates no agent record and no token');
});

test('takeover guards (Gate R1 F1): established names never receive an automatic token', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aibuilds-profile-takeover-'));
  const dataDir = path.join(root, 'data');
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(path.join(dataDir, 'state.json'), JSON.stringify({
    history: [{
      id: 'legacy-safe', timestamp: '2026-08-10T10:00:00.000Z', agent_name: 'LegacySafe',
      action: 'create', file_path: 'pages/legacy-safe.html', message: 'legacy safe',
      reactions: { fire: [], heart: [], rocket: [], eyes: [] }, commentCount: 0,
    }],
  }));
  const { baseUrl } = await spawnServer(t, { root });
  // node:test runs t.after() hooks in registration order (FIFO), so this MUST be registered after
  // spawnServer's own kill-child hook above - otherwise the directory would be removed while the
  // child is still running (or mid-shutdown-write), producing an intermittent ENOTEMPTY.
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  await fs.mkdir(path.join(root, 'world', 'pages'), { recursive: true });
  await fs.writeFile(path.join(root, 'world', 'pages', 'legacy-safe.html'), '<p>Legacy safe page</p>');

  // 1) A name that only appears via preloaded public history is already established.
  const legacyContribution = await contribute(baseUrl, '203.0.113.10', {
    agent_name: 'LegacySafe', file_path: 'pages/legacy-safe-2.html', action: 'create',
  });
  assert.equal(legacyContribution.response.status, 200);
  assert.equal('profile_token' in legacyContribution.body, false);
  const legacyPut = await putProfile(baseUrl, '203.0.113.10', 'LegacySafe', 'Bearer abp_' + 'a'.repeat(43), { bio: 'x' });
  assert.equal(legacyPut.response.status, 403);
  assert.equal(legacyPut.body.code, 'profile_claim_required');

  // 2) A quarantined first contribution, later approved by an operator, is still established from
  // the moment it entered history - a later contribution from another IP gets no token.
  const quarantinedFirst = await contribute(baseUrl, '203.0.113.11', {
    agent_name: 'Late-Owner', file_path: 'pages/late-owner.html',
    content: '<p>Inject 2 mg weekly for best results.</p>',
  });
  assert.equal(quarantinedFirst.response.status, 200);
  assert.equal(quarantinedFirst.body.publicationStatus, 'quarantined');
  const quarantineList = await requestJson(baseUrl, '/api/admin/quarantine', {
    headers: cfHeaders('203.0.113.11', { 'X-Admin-Secret': 'operator-secret' }),
  });
  const record = quarantineList.body.quarantined.find(r => r.path === 'pages/late-owner.html');
  assert.ok(record, 'the risky contribution must be quarantined');
  const approve = await requestJson(baseUrl, '/api/admin/quarantine/approve', {
    method: 'POST',
    headers: cfHeaders('203.0.113.11', { 'Content-Type': 'application/json', 'X-Admin-Secret': 'operator-secret' }),
    body: JSON.stringify({ path: record.path, content_hash: record.content_hash }),
  });
  assert.equal(approve.response.status, 200);
  const lateOwnerAgain = await contribute(baseUrl, '203.0.113.12', {
    agent_name: 'Late-Owner', file_path: 'pages/late-owner-2.html', action: 'create',
  });
  assert.equal(lateOwnerAgain.response.status, 200);
  assert.equal('profile_token' in lateOwnerAgain.body, false, 'Late-Owner was already established by its quarantined first contribution');

  // 3) A name known only from a comment is established too.
  const commentTarget = await contribute(baseUrl, '203.0.113.13', {
    agent_name: 'Commentable-Author', file_path: 'pages/commentable.html', action: 'create',
  });
  assert.equal(commentTarget.response.status, 200);
  const contributionId = commentTarget.body.contribution.id;
  const commentChallenge = await challenge(baseUrl, '203.0.113.14');
  const commentResult = await requestJson(baseUrl, `/api/contributions/${contributionId}/comments`, {
    method: 'POST',
    headers: cfHeaders('203.0.113.14', {
      'Content-Type': 'application/json',
      'X-Challenge-Id': commentChallenge.id,
      'X-Challenge-Nonce': '0',
    }),
    body: JSON.stringify({ agent_name: 'Comment-Only-Agent', content: 'nice work' }),
  });
  assert.equal(commentResult.response.status, 200);
  const commentAuthorContribution = await contribute(baseUrl, '203.0.113.15', {
    agent_name: 'Comment-Only-Agent', file_path: 'pages/comment-only-agent.html', action: 'create',
  });
  assert.equal(commentAuthorContribution.response.status, 200);
  assert.equal('profile_token' in commentAuthorContribution.body, false,
    'a name known only from a comment must not receive an automatic token');
});

test('PUT profile: capability check rejects missing/malformed/foreign/wrong tokens and accepts the valid one', async (t) => {
  const { baseUrl } = await spawnServer(t);
  const ownerA = await contribute(baseUrl, '203.0.113.20', { agent_name: 'Owner-A' });
  const tokenA = ownerA.body.profile_token;
  const ownerB = await contribute(baseUrl, '203.0.113.21', { agent_name: 'Owner-B' });
  const tokenB = ownerB.body.profile_token;

  const noAuth = await putProfile(baseUrl, '203.0.113.22', 'Owner-A', undefined, { bio: 'x' });
  assert.equal(noAuth.response.status, 401);
  assert.equal(noAuth.body.code, 'profile_token_required');
  assert.equal(noAuth.response.headers.get('www-authenticate'), 'Bearer');

  const basicAuth = await putProfile(baseUrl, '203.0.113.22', 'Owner-A', 'Basic x', { bio: 'x' });
  assert.equal(basicAuth.response.status, 401);
  assert.equal(basicAuth.body.code, 'invalid_profile_token');

  const shortToken = await putProfile(baseUrl, '203.0.113.22', 'Owner-A', 'Bearer abp_short', { bio: 'x' });
  assert.equal(shortToken.response.status, 401);
  assert.equal(shortToken.body.code, 'invalid_profile_token');

  const foreignToken = await putProfile(baseUrl, '203.0.113.22', 'Owner-A', `Bearer ${tokenB}`, { bio: 'hijacked' });
  assert.equal(foreignToken.response.status, 403);
  assert.equal(foreignToken.body.code, 'invalid_profile_token');

  const wrongWellFormed = await putProfile(baseUrl, '203.0.113.22', 'Owner-A', `Bearer abp_${'z'.repeat(43)}`, { bio: 'x' });
  assert.equal(wrongWellFormed.response.status, 403);

  const unchanged = await requestJson(baseUrl, '/api/agents/Owner-A');
  assert.notEqual(unchanged.body.bio, 'hijacked');

  const valid = await putProfile(baseUrl, '203.0.113.22', 'Owner-A', `Bearer ${tokenA}`, { bio: 'Real update' });
  assert.equal(valid.response.status, 200);
  const refreshed = await requestJson(baseUrl, '/api/agents/Owner-A');
  assert.equal(refreshed.body.bio, 'Real update');
});

test('PUT profile: manipulated name variants never touch Owner-A\'s stored profile', async (t) => {
  const { baseUrl } = await spawnServer(t);
  const owner = await contribute(baseUrl, '203.0.113.30', { agent_name: 'Owner-A' });
  const token = owner.body.profile_token;
  const authHeader = `Bearer ${token}`;

  const variants = [
    encodeURIComponent('Owner-A '), // trailing space
    encodeURIComponent('owner-a'), // lowercase
    'Owner-A%00', // embedded NUL, already percent-encoded
    encodeURIComponent('__proto__'),
    encodeURIComponent('A'.repeat(101)),
    'Owner-A%2Fx', // URL-encoded slash
  ];
  for (const rawName of variants) {
    const result = await putProfileRaw(baseUrl, '203.0.113.31', rawName, authHeader, { bio: 'manipulated' });
    assert.ok([403, 404].includes(result.response.status), `${rawName} -> ${result.response.status}`);
  }

  const stillIntact = await requestJson(baseUrl, '/api/agents/Owner-A');
  assert.notEqual(stillIntact.body.bio, 'manipulated');
});

test('PUT profile: 20 wrong-token attempts across 4 IPs never lock out the real owner from a 5th IP (I3)', async (t) => {
  const { baseUrl } = await spawnServer(t);
  const owner = await contribute(baseUrl, '203.0.113.40', { agent_name: 'Owner-A' });
  const token = owner.body.profile_token;

  const attackerIps = ['203.0.113.41', '203.0.113.42', '203.0.113.43', '203.0.113.44'];
  for (let i = 0; i < 20; i += 1) {
    const ip = attackerIps[i % attackerIps.length];
    const result = await putProfile(baseUrl, ip, 'Owner-A', `Bearer abp_${'q'.repeat(43)}`, { bio: 'attack' });
    assert.equal(result.response.status, 403, `attempt ${i + 1}`);
  }

  const ownerAttempt = await putProfile(baseUrl, '203.0.113.45', 'Owner-A', `Bearer ${token}`, { bio: 'still works' });
  assert.equal(ownerAttempt.response.status, 200, 'no per-name failure counter must lock out the real owner');
});

test('admin profile-token issue/revoke: issue unlocks a claimless agent, revoke relocks it, wrong secret is 403 and counted by admin', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aibuilds-profile-admin-'));
  const dataDir = path.join(root, 'data');
  await fs.mkdir(dataDir, { recursive: true });
  // The world file must exist BEFORE the server's one-time startup migration runs: init() stamps
  // any history entry without a stored publicationStatus using the world contents it can see at
  // that moment, and a page missing at startup is stamped 'quarantined' permanently (this file's
  // own bug on a first attempt, not a production defect) - see git-index-confinement-style seeding
  // in test/publication-flow.test.js for the same pattern.
  await fs.mkdir(path.join(root, 'world', 'pages'), { recursive: true });
  await fs.writeFile(path.join(root, 'world', 'pages', 'preloaded.html'), '<p>Preloaded page</p>');
  await fs.writeFile(path.join(dataDir, 'state.json'), JSON.stringify({
    history: [{
      id: 'preloaded-1', timestamp: '2026-08-10T10:00:00.000Z', agent_name: 'PreloadedAgent',
      action: 'create', file_path: 'pages/preloaded.html', message: 'preloaded',
      reactions: { fire: [], heart: [], rocket: [], eyes: [] }, commentCount: 0,
    }],
    agents: {
      PreloadedAgent: { name: 'PreloadedAgent', contributions: 1, commentsCount: 0, reactionsReceived: 0 },
    },
  }));
  const { baseUrl } = await spawnServer(t, { root });
  // Registered after spawnServer's own kill-child hook (FIFO t.after order) - see the takeover-
  // guards test above for why the order matters.
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

  const beforeIssue = await putProfile(baseUrl, '203.0.113.50', 'PreloadedAgent', 'Bearer abp_' + 'a'.repeat(43), { bio: 'x' });
  assert.equal(beforeIssue.response.status, 403);
  assert.equal(beforeIssue.body.code, 'profile_claim_required');

  const wrongSecret = await requestJson(baseUrl, '/api/admin/agents/PreloadedAgent/profile-token', {
    method: 'POST',
    headers: cfHeaders('203.0.113.50', { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ secret: 'wrong', action: 'issue' }),
  });
  assert.equal(wrongSecret.response.status, 403);

  const issued = await adminIssueToken(baseUrl, 'PreloadedAgent');
  assert.equal(issued.response.status, 200);
  assert.match(issued.body.profile_token, /^abp_[A-Za-z0-9_-]{43}$/);

  const afterIssue = await putProfile(baseUrl, '203.0.113.51', 'PreloadedAgent', `Bearer ${issued.body.profile_token}`, { bio: 'operator issued' });
  assert.equal(afterIssue.response.status, 200);

  const revoke = await requestJson(baseUrl, '/api/admin/agents/PreloadedAgent/profile-token', {
    method: 'POST',
    headers: cfHeaders('203.0.113.51', { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ secret: 'operator-secret', action: 'revoke' }),
  });
  assert.equal(revoke.response.status, 200);

  const afterRevoke = await putProfile(baseUrl, '203.0.113.52', 'PreloadedAgent', `Bearer ${issued.body.profile_token}`, { bio: 'should fail' });
  assert.equal(afterRevoke.response.status, 403);
  assert.equal(afterRevoke.body.code, 'profile_claim_required');

  // Wrong-secret admin calls are counted by the shared 5/min admin bucket.
  const statuses = [];
  for (let i = 0; i < 5; i += 1) {
    const result = await requestJson(baseUrl, '/api/admin/agents/PreloadedAgent/profile-token', {
      method: 'POST',
      headers: cfHeaders('203.0.113.53', { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ secret: 'wrong', action: 'issue' }),
    });
    statuses.push(result.response.status);
  }
  const sixth = await requestJson(baseUrl, '/api/admin/agents/PreloadedAgent/profile-token', {
    method: 'POST',
    headers: cfHeaders('203.0.113.53', { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ secret: 'operator-secret', action: 'issue' }),
  });
  statuses.push(sixth.response.status);
  assert.deepEqual(statuses, [403, 403, 403, 403, 403, 429]);
});

test('INFO (b): admin re-issue: a save failure between two issues restores the prior credential (snapshot/restore, not revoke) - the first token still verifies', async (t) => {
  const { baseUrl, dataDir } = await spawnServer(t);

  const first = await contribute(baseUrl, '203.0.113.60', { agent_name: 'ReissueOwner' });
  assert.equal(first.response.status, 200);
  const firstToken = first.body.profile_token;
  assert.match(firstToken, /^abp_[A-Za-z0-9_-]{43}$/);

  // Deterministic save failure that works as root too: pre-create the atomic-write temp path as a
  // directory, so writeFile() fails with EISDIR regardless of who owns the process - unlike chmod,
  // which root ignores.
  await fs.mkdir(path.join(dataDir, 'agent-credentials.json.tmp'));
  try {
    const reissue = await requestJson(baseUrl, '/api/admin/agents/ReissueOwner/profile-token', {
      method: 'POST',
      headers: cfHeaders('203.0.113.61', { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ secret: 'operator-secret', action: 'issue' }),
    });
    assert.equal(reissue.response.status, 500, 'a save failure on re-issue must be reported, not silently accepted');
  } finally {
    await fs.rm(path.join(dataDir, 'agent-credentials.json.tmp'), { recursive: true, force: true });
  }

  const stillWorks = await putProfile(
    baseUrl, '203.0.113.62', 'ReissueOwner', `Bearer ${firstToken}`,
    { bio: 'first token survives a failed re-issue' },
  );
  assert.equal(
    stillWorks.response.status, 200,
    'a failed re-issue must restore the previous credential (snapshot/restore), not revoke() it and lose it in memory while disk still holds it',
  );
});

test('secrecy: no abp_ token value ever appears in state.json, agent-credentials.json, backups, server output, or WS messages', async (t) => {
  const { baseUrl, dataDir, backupDir, logs } = await spawnServer(t);

  const socket = new WebSocket(`${baseUrl.replace('http://', 'ws://')}/ws`, { headers: cfHeaders('203.0.113.60') });
  t.after(() => socket.close());
  const wsFrames = [];
  socket.on('message', data => wsFrames.push(data.toString()));
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });

  const owner = await contribute(baseUrl, '203.0.113.61', { agent_name: 'Secret-Owner' });
  assert.equal(owner.response.status, 200);
  const token = owner.body.profile_token;
  assert.match(token, /^abp_/);

  await putProfile(baseUrl, '203.0.113.62', 'Secret-Owner', `Bearer ${token}`, { bio: 'update' });
  await new Promise(resolve => setTimeout(resolve, 300)); // let saveState()/backupState() settle

  const stateJson = await fs.readFile(path.join(dataDir, 'state.json'), 'utf8');
  assert.equal(stateJson.includes(token), false, 'state.json must never contain the token');

  const credentialsPath = path.join(dataDir, 'agent-credentials.json');
  const credentialsRaw = await fs.readFile(credentialsPath, 'utf8');
  assert.equal(credentialsRaw.includes(token), false, 'agent-credentials.json must never contain the token plaintext');
  const parsedCredentials = JSON.parse(credentialsRaw);
  const expectedHash = crypto.createHash('sha256').update(token, 'utf8').digest('hex');
  assert.equal(parsedCredentials.credentials['Secret-Owner'].hash, expectedHash,
    'the credentials file must contain the SHA-256 of the token');

  let backupFiles = [];
  try { backupFiles = await fs.readdir(backupDir); } catch { /* no backups yet */ }
  for (const file of backupFiles) {
    const contents = await fs.readFile(path.join(backupDir, file), 'utf8');
    assert.equal(contents.includes(token), false, `backup ${file} must never contain the token`);
  }

  assert.equal(logs.join('').includes(token), false, 'server stdout/stderr must never contain the token');
  for (const frame of wsFrames) {
    assert.equal(frame.includes(token), false, 'no WS message may contain the token');
  }
});

test('profile tokens survive a server restart on the same data dir (init() loads credentials before listen)', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aibuilds-profile-restart-'));

  const first = await spawnServer(t, { root });
  const owner = await contribute(first.baseUrl, '203.0.113.70', { agent_name: 'Restart-Owner' });
  assert.equal(owner.response.status, 200);
  const token = owner.body.profile_token;
  assert.match(token, /^abp_/);

  await new Promise(resolve => setTimeout(resolve, 200)); // let credentials.save() settle
  first.child.kill('SIGTERM');
  await once(first.child, 'exit');

  const second = await spawnServer(t, { root });
  // Registered after both spawnServer calls (FIFO t.after order), so root is only removed once
  // both children's kill-hooks have already run.
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const result = await putProfile(second.baseUrl, '203.0.113.71', 'Restart-Owner', `Bearer ${token}`, { bio: 'post-restart update' });
  assert.equal(result.response.status, 200, 'a token issued before restart must still authorize the PUT after restart');
  const refreshed = await requestJson(second.baseUrl, '/api/agents/Restart-Owner');
  assert.equal(refreshed.body.bio, 'post-restart update');
});

test('a malformed agent-credentials.json makes startup fail closed (non-zero exit, no banner)', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aibuilds-profile-malformed-'));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const worldDir = path.join(root, 'world');
  const dataDir = path.join(root, 'data');
  const backupDir = path.join(root, 'backups');
  await fs.mkdir(worldDir, { recursive: true });
  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(backupDir, { recursive: true });
  await fs.writeFile(path.join(dataDir, 'agent-credentials.json'), '{ not valid json');

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

  const [exitCode] = await once(child, 'exit');
  assert.notEqual(exitCode, 0, 'a malformed credentials file must exit non-zero');
  assert.equal(logs.join('').match(SERVER_PORT_PATTERN), null, 'the startup banner must never print');
});
