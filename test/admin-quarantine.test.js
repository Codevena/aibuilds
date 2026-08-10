'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { once } = require('node:events');
const WebSocket = require('ws');

const execFileAsync = promisify(execFile);

async function getFreePort() {
  const listener = net.createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  return port;
}

async function waitForServer(baseUrl, child, logs) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Server exited early:\n${logs.join('')}`);
    try {
      if ((await fetch(`${baseUrl}/api/stats`)).ok) return;
    } catch { /* retry */ }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Server did not start:\n${logs.join('')}`);
}

async function requestJson(baseUrl, requestPath, options = {}) {
  const response = await fetch(baseUrl + requestPath, options);
  let body;
  try { body = await response.json(); } catch { body = null; }
  return { response, body };
}

test('admin quarantine decisions authenticate, bind approval to bytes, and reject with cleanup', async (t) => {
  // Mutations caught: missing auth, compare-free approval, metadata-only reject, and omitted Git await.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aibuilds-admin-quarantine-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const worldDir = path.join(root, 'world');
  const dataDir = path.join(root, 'data');
  const backupDir = path.join(root, 'backups');
  await fs.mkdir(path.join(worldDir, 'pages'), { recursive: true });
  await fs.mkdir(path.join(worldDir, 'sections'), { recursive: true });
  await fs.mkdir(dataDir, { recursive: true });
  const approvePath = 'pages/MixedApprove.html';
  const rejectPath = 'sections/MixedReject.html';
  const untrackedRejectPath = 'pages/UntrackedReject.html';
  const approveBytes = '<p>Inject 2 mg weekly for best results.</p>';
  await fs.writeFile(path.join(worldDir, approvePath), approveBytes);
  await fs.writeFile(path.join(worldDir, rejectPath), '<p>Invest 80% of your savings in this token.</p>');
  await fs.writeFile(path.join(dataDir, 'state.json'), JSON.stringify({
    history: [
      {
        id: 'audit-approve', timestamp: '2026-08-10T10:00:00.000Z', agent_name: 'RiskAgent',
        action: 'create', file_path: approvePath, message: 'internal approval audit',
      },
      {
        id: 'audit-reject', timestamp: '2026-08-10T10:05:00.000Z', agent_name: 'RiskAgent',
        action: 'create', file_path: rejectPath, message: 'internal rejection audit',
      },
    ],
  }));
  await execFileAsync('git', ['init'], { cwd: worldDir });
  await execFileAsync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: worldDir });
  await execFileAsync('git', ['config', 'user.name', 'Quarantine Test'], { cwd: worldDir });
  await execFileAsync('git', ['add', '.'], { cwd: worldDir });
  await execFileAsync('git', ['commit', '-m', 'seed risky world'], { cwd: worldDir });
  await fs.writeFile(path.join(worldDir, untrackedRejectPath),
    '<p>File this lawsuit under statute 123 to win your case.</p>');

  const port = await getFreePort();
  const logs = [];
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      POW_DIFFICULTY: '0',
      ADMIN_RESET_SECRET: 'operator-secret',
      AIBUILDS_WORLD_DIR: worldDir,
      AIBUILDS_DATA_DIR: dataDir,
      AIBUILDS_BACKUP_DIR: backupDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', chunk => logs.push(chunk.toString()));
  child.stderr.on('data', chunk => logs.push(chunk.toString()));
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGTERM');
    if (child.exitCode === null) await once(child, 'exit');
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForServer(baseUrl, child, logs);
  let requestIp = 1;
  const adminRequest = (requestPath, options = {}) => requestJson(baseUrl, requestPath, {
    ...options,
    headers: {
      'X-Forwarded-For': `198.51.100.${requestIp++}`,
      ...(options.headers || {}),
    },
  });

  let result = await adminRequest('/api/admin/quarantine');
  assert.equal(result.response.status, 401);
  result = await adminRequest('/api/admin/quarantine', { headers: { 'X-Admin-Secret': 'wrong' } });
  assert.equal(result.response.status, 401);
  result = await adminRequest('/api/admin/quarantine', { headers: { 'X-Admin-Secret': 'operator-secret' } });
  assert.equal(result.response.status, 200, logs.join(''));
  assert.equal(result.body.quarantined.length, 3);
  assert.equal(JSON.stringify(result.body).includes('agentIps'), false);
  const approveRecord = result.body.quarantined.find(record => record.path === approvePath);
  assert.ok(approveRecord, 'quarantine list preserves the exact case-sensitive World path');
  assert.match(approveRecord.content_hash, /^[a-f0-9]{64}$/);

  result = await adminRequest('/api/admin/quarantine/approve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Admin-Secret': 'operator-secret' },
    body: JSON.stringify({}),
  });
  assert.equal(result.response.status, 400);
  result = await adminRequest('/api/admin/quarantine/approve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Admin-Secret': 'operator-secret' },
    body: JSON.stringify({ path: 'pages/missing.html', content_hash: 'hash-missing' }),
  });
  assert.equal(result.response.status, 404);

  await fs.writeFile(path.join(worldDir, approvePath), '<p>Changed after listing</p>');
  result = await adminRequest('/api/admin/quarantine/approve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Admin-Secret': 'operator-secret' },
    body: JSON.stringify({ path: approvePath, content_hash: approveRecord.content_hash }),
  });
  assert.equal(result.response.status, 409);

  await fs.writeFile(path.join(worldDir, approvePath), approveBytes);
  result = await adminRequest('/api/admin/quarantine/approve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Admin-Secret': 'operator-secret' },
    body: JSON.stringify({ path: approvePath, content_hash: approveRecord.content_hash }),
  });
  assert.equal(result.response.status, 200);
  assert.deepEqual(result.body, {
    success: true, action: 'approve', target: approvePath, publicationStatus: 'published',
  });
  assert.equal((await requestJson(baseUrl, `/api/world/${approvePath}`)).response.status, 200);

  const hookPath = path.join(worldDir, '.git', 'hooks', 'pre-commit');
  await fs.writeFile(hookPath, '#!/bin/sh\nexit 1\n');
  await fs.chmod(hookPath, 0o755);
  result = await adminRequest('/api/admin/quarantine/reject', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: 'operator-secret', path: rejectPath }),
  });
  assert.equal(result.response.status, 500);
  result = await adminRequest('/api/admin/quarantine', { headers: { 'X-Admin-Secret': 'operator-secret' } });
  assert.equal(result.body.quarantined.some(record => record.path === rejectPath), true);
  await fs.unlink(hookPath);
  const challenge = await requestJson(baseUrl, '/api/challenge');
  result = await requestJson(baseUrl, '/api/contribute', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Challenge-Id': challenge.body.id,
      'X-Challenge-Nonce': '0',
    },
    body: JSON.stringify({
      agent_name: 'InterveningAgent', action: 'create', file_path: 'pages/intervening.html',
      content: '<main><h1>Intervening safe contribution</h1></main>', message: 'intervening contribution',
    }),
  });
  assert.equal(result.response.status, 200);

  result = await adminRequest('/api/admin/quarantine/reject', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: 'operator-secret', path: rejectPath }),
  });
  assert.equal(result.response.status, 200, logs.join(''));
  assert.deepEqual(result.body, { success: true, action: 'reject', target: rejectPath });
  await assert.rejects(fs.access(path.join(worldDir, rejectPath)));

  result = await adminRequest('/api/admin/quarantine/reject', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: 'operator-secret', path: untrackedRejectPath }),
  });
  assert.equal(result.response.status, 200, logs.join(''));
  assert.deepEqual(result.body, { success: true, action: 'reject', target: untrackedRejectPath });
  await assert.rejects(fs.access(path.join(worldDir, untrackedRejectPath)));
  const moderationState = JSON.parse(await fs.readFile(path.join(dataDir, 'moderation.json'), 'utf8'));
  assert.equal(Object.hasOwn(moderationState.moderation.quarantinedFiles, rejectPath), false);
  assert.equal(Object.hasOwn(moderationState.moderation.approvedFiles, rejectPath), false);
  const persistedState = JSON.parse(await fs.readFile(path.join(dataDir, 'state.json'), 'utf8'));
  assert.equal(persistedState.history.some(item => item.id === 'audit-reject'), true);
  const { stdout: subject } = await execFileAsync('git', ['log', '-1', '--pretty=%s'], { cwd: worldDir });
  assert.equal(subject.trim(), `moderation: reject ${untrackedRejectPath}`);

  const recreatedChallenge = await requestJson(baseUrl, '/api/challenge');
  result = await requestJson(baseUrl, '/api/contribute', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Challenge-Id': recreatedChallenge.body.id,
      'X-Challenge-Nonce': '0',
    },
    body: JSON.stringify({
      agent_name: 'RepeatedRiskAgent', action: 'create', file_path: untrackedRejectPath,
      content: '<p>File this lawsuit under statute 456 to win your case.</p>',
      message: 'recreated risky untracked file',
    }),
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.publicationStatus, 'quarantined');
  await execFileAsync('git', ['rm', '--cached', '--', untrackedRejectPath], { cwd: worldDir });
  await execFileAsync('git', ['commit', '-m', `moderation: reject ${untrackedRejectPath}`], { cwd: worldDir });
  const { stdout: auditsBefore } = await execFileAsync('git', [
    'log', '--format=%s', '--fixed-strings', '--grep', `moderation: reject ${untrackedRejectPath}`,
  ], { cwd: worldDir });

  result = await adminRequest('/api/admin/quarantine/reject', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: 'operator-secret', path: untrackedRejectPath }),
  });
  assert.equal(result.response.status, 200, logs.join(''));
  const { stdout: auditsAfter } = await execFileAsync('git', [
    'log', '--format=%s', '--fixed-strings', '--grep', `moderation: reject ${untrackedRejectPath}`,
  ], { cwd: worldDir });
  assert.equal(auditsAfter.trim().split('\n').length, auditsBefore.trim().split('\n').length + 1);

  result = await adminRequest('/api/admin/quarantine', { headers: { 'X-Admin-Secret': 'operator-secret' } });
  assert.equal(result.body.quarantined.length, 0);
});

test('failed admin decisions persist rollback after concurrent moderation saves', async (t) => {
  // Mutations caught: restoring only memory lets queued call-time snapshots persist failed decisions.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aibuilds-admin-approval-rollback-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const worldDir = path.join(root, 'world');
  const dataDir = path.join(root, 'data');
  const backupDir = path.join(root, 'backups');
  const riskyPath = 'pages/risky.html';
  const armPath = path.join(root, 'arm-moderation-rename');
  const markerPath = path.join(root, 'moderation-rename-count');
  const preloadPath = path.join(root, 'fail-first-moderation-rename.cjs');
  await fs.mkdir(path.join(worldDir, 'pages'), { recursive: true });
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(path.join(worldDir, riskyPath), '<p>Inject 3 mg weekly for best results.</p>');
  await fs.writeFile(preloadPath, `
    const fs = require('node:fs');
    const promises = fs.promises;
    const originalRename = promises.rename.bind(promises);
    const originalWriteFile = promises.writeFile.bind(promises);
    let cycleToken = '';
    let moderationRenames = 0;
    promises.rename = async function failFirstModerationRename(source, target) {
      if (String(target) === process.env.AIBUILDS_MODERATION_TARGET &&
          fs.existsSync(process.env.AIBUILDS_MODERATION_ARM)) {
        const token = fs.readFileSync(process.env.AIBUILDS_MODERATION_ARM, 'utf8');
        if (token !== cycleToken) {
          cycleToken = token;
          moderationRenames = 0;
        }
        moderationRenames += 1;
        if (moderationRenames === 1) {
          await originalWriteFile(process.env.AIBUILDS_MODERATION_MARKER, token + ':' + moderationRenames);
          await new Promise(resolve => setTimeout(resolve, 250));
          throw Object.assign(new Error('forced approval persistence failure'), { code: 'EIO' });
        }
        const result = await originalRename(source, target);
        await originalWriteFile(process.env.AIBUILDS_MODERATION_MARKER, token + ':' + moderationRenames);
        return result;
      }
      return originalRename(source, target);
    };
  `);
  await execFileAsync('git', ['init'], { cwd: worldDir });
  await execFileAsync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: worldDir });
  await execFileAsync('git', ['config', 'user.name', 'Quarantine Test'], { cwd: worldDir });
  await execFileAsync('git', ['add', '.'], { cwd: worldDir });
  await execFileAsync('git', ['commit', '-m', 'seed risky world'], { cwd: worldDir });

  const port = await getFreePort();
  const logs = [];
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      POW_DIFFICULTY: '0',
      ADMIN_RESET_SECRET: 'operator-secret',
      AIBUILDS_WORLD_DIR: worldDir,
      AIBUILDS_DATA_DIR: dataDir,
      AIBUILDS_BACKUP_DIR: backupDir,
      NODE_OPTIONS: `--require=${preloadPath}`,
      AIBUILDS_MODERATION_TARGET: path.join(dataDir, 'moderation.json'),
      AIBUILDS_MODERATION_ARM: armPath,
      AIBUILDS_MODERATION_MARKER: markerPath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', chunk => logs.push(chunk.toString()));
  child.stderr.on('data', chunk => logs.push(chunk.toString()));
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGTERM');
    if (child.exitCode === null) await once(child, 'exit');
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForServer(baseUrl, child, logs);
  const listed = await requestJson(baseUrl, '/api/admin/quarantine', {
    headers: { 'X-Admin-Secret': 'operator-secret' },
  });
  const record = listed.body.quarantined.find(item => item.path === riskyPath);
  assert.ok(record);
  const challenge = await requestJson(baseUrl, '/api/challenge');
  await fs.writeFile(armPath, 'approval');

  const approval = requestJson(baseUrl, '/api/admin/quarantine/approve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Admin-Secret': 'operator-secret' },
    body: JSON.stringify({ path: riskyPath, content_hash: record.content_hash }),
  });
  while (true) {
    try {
      if ((await fs.readFile(markerPath, 'utf8')) === 'approval:1') break;
    } catch { /* wait for the failing rename to start */ }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const unrelatedSave = requestJson(baseUrl, '/api/guestbook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Challenge-Id': challenge.body.id,
      'X-Challenge-Nonce': '0',
    },
    body: JSON.stringify({ agent_name: 'UnrelatedAgent', message: 'Unrelated safe guestbook entry' }),
  });
  const [approvalResult, unrelatedResult] = await Promise.all([approval, unrelatedSave]);
  assert.equal(approvalResult.response.status, 500);
  assert.equal(unrelatedResult.response.status, 200);
  while ((await fs.readFile(markerPath, 'utf8')) === 'approval:1') {
    await new Promise(resolve => setTimeout(resolve, 10));
  }

  let disk = JSON.parse(await fs.readFile(path.join(dataDir, 'moderation.json'), 'utf8'));
  assert.ok(disk.moderation.quarantinedFiles[riskyPath]);
  assert.equal(Object.hasOwn(disk.moderation.approvedFiles, riskyPath), false);

  const rejectChallenge = await requestJson(baseUrl, '/api/challenge');
  await fs.writeFile(armPath, 'rejection');
  const rejection = requestJson(baseUrl, '/api/admin/quarantine/reject', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Admin-Secret': 'operator-secret' },
    body: JSON.stringify({ path: riskyPath }),
  });
  while (true) {
    try {
      if ((await fs.readFile(markerPath, 'utf8')) === 'rejection:1') break;
    } catch { /* wait for the failing rename to start */ }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const rejectionUnrelatedSave = requestJson(baseUrl, '/api/guestbook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Challenge-Id': rejectChallenge.body.id,
      'X-Challenge-Nonce': '0',
    },
    body: JSON.stringify({ agent_name: 'SecondUnrelatedAgent', message: 'Another safe guestbook entry' }),
  });
  const [rejectionResult, rejectionUnrelatedResult] = await Promise.all([rejection, rejectionUnrelatedSave]);
  assert.equal(rejectionResult.response.status, 500);
  assert.equal(rejectionUnrelatedResult.response.status, 200);
  while ((await fs.readFile(markerPath, 'utf8')) === 'rejection:1') {
    await new Promise(resolve => setTimeout(resolve, 10));
  }

  disk = JSON.parse(await fs.readFile(path.join(dataDir, 'moderation.json'), 'utf8'));
  assert.ok(disk.moderation.quarantinedFiles[riskyPath]);
  assert.equal(Object.hasOwn(disk.moderation.approvedFiles, riskyPath), false);
});

test('legacy moderate delete refuses quarantined paths without purging audit or broadcasting the target', async (t) => {
  // Mutation caught: the legacy delete branch unlinks bytes, deletes history, clears quarantine, and broadcasts.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aibuilds-admin-legacy-private-delete-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const worldDir = path.join(root, 'world');
  const dataDir = path.join(root, 'data');
  const backupDir = path.join(root, 'backups');
  const riskyPath = 'pages/private-admin-delete.html';
  await fs.mkdir(path.join(worldDir, 'pages'), { recursive: true });
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(path.join(worldDir, riskyPath), '<p>Inject 4 mg weekly for best results.</p>');
  await fs.writeFile(path.join(dataDir, 'state.json'), JSON.stringify({
    history: [{
      id: 'private-audit-record', timestamp: '2026-08-10T10:00:00.000Z', agent_name: 'PrivateAgent',
      action: 'create', file_path: riskyPath, message: 'private audit record',
      publicationStatus: 'quarantined', reactions: { fire: [], heart: [], rocket: [], eyes: [] },
    }],
  }));
  await execFileAsync('git', ['init'], { cwd: worldDir });
  await execFileAsync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: worldDir });
  await execFileAsync('git', ['config', 'user.name', 'Quarantine Test'], { cwd: worldDir });
  await execFileAsync('git', ['add', '.'], { cwd: worldDir });
  await execFileAsync('git', ['commit', '-m', 'seed private world'], { cwd: worldDir });

  const port = await getFreePort();
  const logs = [];
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      POW_DIFFICULTY: '0',
      ADMIN_RESET_SECRET: 'operator-secret',
      AIBUILDS_WORLD_DIR: worldDir,
      AIBUILDS_DATA_DIR: dataDir,
      AIBUILDS_BACKUP_DIR: backupDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', chunk => logs.push(chunk.toString()));
  child.stderr.on('data', chunk => logs.push(chunk.toString()));
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGTERM');
    if (child.exitCode === null) await once(child, 'exit');
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForServer(baseUrl, child, logs);
  const frames = [];
  const socket = new WebSocket(baseUrl.replace('http:', 'ws:'));
  socket.on('message', data => frames.push(JSON.parse(data.toString())));
  await once(socket, 'open');
  t.after(() => socket.close());
  frames.length = 0;

  const result = await requestJson(baseUrl, '/api/admin/moderate', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: 'operator-secret', action: 'delete', target: riskyPath }),
  });
  assert.equal(result.response.status, 409);
  assert.equal(await fs.readFile(path.join(worldDir, riskyPath), 'utf8'),
    '<p>Inject 4 mg weekly for best results.</p>');
  const persisted = JSON.parse(await fs.readFile(path.join(dataDir, 'state.json'), 'utf8'));
  assert.equal(persisted.history.some(item => item.id === 'private-audit-record'), true);
  const listed = await requestJson(baseUrl, '/api/admin/quarantine', {
    headers: { 'X-Admin-Secret': 'operator-secret' },
  });
  assert.equal(listed.body.quarantined.some(item => item.path === riskyPath), true);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(frames.some(frame => JSON.stringify(frame).includes(riskyPath)), false);
});
