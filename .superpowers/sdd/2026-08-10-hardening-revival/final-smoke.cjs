'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const WebSocket = require('ws');

const REPO_ROOT = path.resolve(__dirname, '../../..');

async function treeDigest(root) {
  const digest = crypto.createHash('sha256');
  try {
    await fs.access(root);
  } catch (error) {
    if (error.code === 'ENOENT') return 'absent';
    throw error;
  }
  async function visit(relativePath) {
    const absolutePath = path.join(root, relativePath);
    const entries = await fs.readdir(absolutePath, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const child = path.join(relativePath, entry.name);
      digest.update(`${entry.isDirectory() ? 'd' : entry.isSymbolicLink() ? 'l' : 'f'}\0${child}\0`);
      if (entry.isDirectory()) await visit(child);
      else if (entry.isSymbolicLink()) digest.update(await fs.readlink(path.join(root, child)));
      else digest.update(await fs.readFile(path.join(root, child)));
    }
  }
  await visit('');
  return digest.digest('hex');
}

async function getFreePort() {
  const listener = net.createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  return port;
}

async function waitForServer(baseUrl, child, logs) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Server exited early:\n${logs.join('')}`);
    try {
      if ((await fetch(`${baseUrl}/api/stats`)).ok) return;
    } catch { /* retry */ }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Server did not start:\n${logs.join('')}`);
}

async function waitFor(predicate, message) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(message);
}

async function jsonRequest(baseUrl, requestPath, options = {}) {
  const response = await fetch(baseUrl + requestPath, options);
  let body = null;
  try { body = await response.json(); } catch { /* non-JSON response */ }
  return { response, body };
}

function rawRequestStatus(port, requestPath) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, path: requestPath }, response => {
      response.resume();
      response.once('end', () => resolve(response.statusCode));
    });
    request.once('error', reject);
    request.end();
  });
}

async function challengeHeaders(baseUrl) {
  const challenge = await jsonRequest(baseUrl, '/api/challenge');
  assert.equal(challenge.response.status, 200);
  assert.equal(challenge.body.difficulty, 0);
  return {
    'Content-Type': 'application/json',
    'X-Challenge-Id': challenge.body.id,
    'X-Challenge-Nonce': '0',
  };
}

async function contribute(baseUrl, payload) {
  return jsonRequest(baseUrl, '/api/contribute', {
    method: 'POST',
    headers: await challengeHeaders(baseUrl),
    body: JSON.stringify({
      agent_name: 'Final-Smoke-Agent',
      action: 'create',
      message: 'isolated final smoke',
      ...payload,
    }),
  });
}

function independentlyCountMetrics(history, files, quarantinedFileCount) {
  const agents = new Set();
  const activeDays = new Set();
  const agentsByFile = new Map();
  let latest = null;
  for (const item of history) {
    agents.add(item.agent_name);
    activeDays.add(item.timestamp.slice(0, 10));
    if (!agentsByFile.has(item.file_path)) agentsByFile.set(item.file_path, new Set());
    agentsByFile.get(item.file_path).add(item.agent_name);
    if (latest === null || Date.parse(item.timestamp) > Date.parse(latest)) latest = item.timestamp;
  }
  return {
    totalContributions: history.length,
    fileCount: files.length,
    agentCount: agents.size,
    activeDays: activeDays.size,
    collaborativeFileCount: Array.from(agentsByFile.values()).filter(names => names.size >= 2).length,
    lastContributionAt: latest,
    isLive: latest !== null && Date.now() - Date.parse(latest) >= 0 && Date.now() - Date.parse(latest) <= 900_000,
    quarantinedFileCount,
  };
}

async function main() {
  const repoBefore = {
    world: await treeDigest(path.join(REPO_ROOT, 'world')),
    data: await treeDigest(path.join(REPO_ROOT, 'data')),
  };
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aibuilds-final-smoke-'));
  const worldDir = path.join(root, 'world');
  const dataDir = path.join(root, 'data');
  const backupDir = path.join(root, 'backups');
  const logs = [];
  let child;
  let socket;

  try {
    await Promise.all([
      fs.mkdir(path.join(worldDir, 'pages', '.draft'), { recursive: true }),
      fs.mkdir(path.join(worldDir, 'css'), { recursive: true }),
      fs.mkdir(path.join(worldDir, 'js'), { recursive: true }),
      fs.mkdir(dataDir, { recursive: true }),
      fs.mkdir(backupDir, { recursive: true }),
    ]);
    for (const relativePath of [
      'layout.html', 'WORLD.md', 'PROJECT.md', 'pages/home.html', 'css/theme.css', 'js/core.js',
    ]) {
      await fs.copyFile(path.join(REPO_ROOT, 'world', relativePath), path.join(worldDir, relativePath));
    }
    await fs.writeFile(path.join(worldDir, 'pages', 'hidden-smoke.html'),
      '<main><h1>Operator hidden smoke</h1></main>\n');
    await fs.writeFile(path.join(worldDir, 'pages', '.draft', 'secret.html'),
      '<main><h1>Nested dot secret</h1></main>\n');

    const port = await getFreePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, ['server/index.js'], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        PORT: String(port),
        POW_DIFFICULTY: '0',
        ADMIN_RESET_SECRET: 'final-smoke-secret',
        AIBUILDS_WORLD_DIR: worldDir,
        AIBUILDS_DATA_DIR: dataDir,
        AIBUILDS_BACKUP_DIR: backupDir,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', chunk => logs.push(chunk.toString()));
    child.stderr.on('data', chunk => logs.push(chunk.toString()));
    await waitForServer(baseUrl, child, logs);

    const frames = [];
    socket = new WebSocket(baseUrl.replace('http://', 'ws://'));
    socket.on('message', bytes => frames.push(JSON.parse(String(bytes))));
    await once(socket, 'open');
    await waitFor(() => frames.some(frame => frame.type === 'welcome'), 'WebSocket welcome timed out');

    const hidden = await jsonRequest(baseUrl, '/api/admin/moderate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        secret: 'final-smoke-secret',
        action: 'hide',
        target: 'pages/hidden-smoke.html',
      }),
    });
    assert.equal(hidden.response.status, 200, logs.join(''));

    const privatePaths = [
      '/world/.git/HEAD',
      '/api/world/.git/HEAD',
      '/api/world/%2egit/HEAD',
      '/api/world/pages/%2e%2e/PROJECT.md',
      '/api/world/pages%5c..%5cPROJECT.md',
      '/world/pages/.draft/secret.html',
      '/api/world/pages/.draft/secret.html',
      '/world/pages/hidden-smoke.html',
      '/api/world/pages/hidden-smoke.html',
    ];
    const privateStatuses = [];
    for (const requestPath of privatePaths) {
      const status = await rawRequestStatus(port, requestPath);
      privateStatuses.push(status);
      assert.equal(status, 404, requestPath);
    }

    assert.equal((await fetch(`${baseUrl}/world/css/theme.css`)).status, 200);
    assert.equal((await jsonRequest(baseUrl, '/api/world/pages/home.html')).response.status, 200);

    const worldResponse = await fetch(`${baseUrl}/world/`);
    assert.equal(worldResponse.status, 200, logs.join(''));
    const csp = worldResponse.headers.get('content-security-policy') || '';
    for (const directive of [
      'default-src', 'script-src', 'style-src', 'img-src', 'font-src', 'connect-src',
      'frame-ancestors', 'sandbox', 'form-action', 'object-src', 'base-uri',
    ]) assert.match(csp, new RegExp(`(?:^|;\\s*)${directive}\\b`), directive);
    assert.doesNotMatch(csp, /allow-same-origin/i);
    const liveHtml = await (await fetch(`${baseUrl}/live`)).text();
    assert.match(liveHtml, /sandbox="allow-scripts"/);
    assert.doesNotMatch(liveHtml, /sandbox="[^"]*allow-same-origin/i);

    const noChallenge = await jsonRequest(baseUrl, '/api/contribute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_name: 'No-Challenge', action: 'create', file_path: 'pages/no-challenge.html',
        content: '<main><h1>Must fail</h1></main>',
      }),
    });
    assert.ok(noChallenge.response.status >= 400 && noChallenge.response.status < 500,
      `missing challenge unexpectedly returned ${noChallenge.response.status}`);

    const publicFramesBeforeRisk = frames.filter(frame =>
      frame.type === 'contribution' || frame.type === 'achievement').length;
    const risky = await contribute(baseUrl, {
      file_path: 'pages/risky-smoke.html',
      content: '<main><h1>Unsafe dose</h1><p>Inject 7 mg once a week.</p></main>',
    });
    assert.equal(risky.response.status, 200, logs.join(''));
    assert.equal(risky.body.publicationStatus, 'quarantined');
    assert.deepEqual(risky.body.reasons, ['high_stakes_medical']);
    assert.equal((await jsonRequest(baseUrl, '/api/world/pages/risky-smoke.html')).response.status, 404);
    assert.equal((await fetch(`${baseUrl}/world/pages/risky-smoke.html`)).status, 404);
    await new Promise(resolve => setTimeout(resolve, 125));
    assert.equal(frames.filter(frame =>
      frame.type === 'contribution' || frame.type === 'achievement').length, publicFramesBeforeRisk);

    const safe = await contribute(baseUrl, {
      file_path: 'pages/safe-smoke.html',
      content: '<main><h1>Safe smoke</h1><p>A small public collaboration artifact.</p></main>',
    });
    assert.equal(safe.response.status, 200, logs.join(''));
    assert.equal(safe.body.publicationStatus, 'published');
    assert.deepEqual(safe.body.reasons, []);
    assert.equal((await jsonRequest(baseUrl, '/api/world/pages/safe-smoke.html')).response.status, 200);
    assert.equal((await fetch(`${baseUrl}/world/pages/safe-smoke.html`)).status, 200);
    await waitFor(() => frames.some(frame =>
      frame.type === 'contribution' && frame.data?.id === safe.body.contribution.id),
    'Safe contribution was not broadcast');

    const [historyResult, filesResult, statsResult] = await Promise.all([
      jsonRequest(baseUrl, '/api/history?limit=1000'),
      jsonRequest(baseUrl, '/api/files'),
      jsonRequest(baseUrl, '/api/stats'),
    ]);
    assert.equal(historyResult.response.status, 200);
    assert.equal(filesResult.response.status, 200);
    assert.equal(statsResult.response.status, 200);
    assert.equal(historyResult.body.items.some(item => item.id === risky.body.contribution.id), false);
    assert.equal(filesResult.body.some(file => file.path === 'pages/risky-smoke.html'), false);
    assert.equal(filesResult.body.some(file => file.path === 'pages/hidden-smoke.html'), false);
    const moderationState = JSON.parse(await fs.readFile(path.join(dataDir, 'moderation.json'), 'utf8'));
    const quarantineCount = Object.keys(moderationState.moderation.quarantinedFiles).length;
    const independentlyCounted = independentlyCountMetrics(
      historyResult.body.items,
      filesResult.body,
      quarantineCount,
    );
    for (const [field, value] of Object.entries(independentlyCounted)) {
      assert.deepEqual(statsResult.body[field], value, field);
    }

    const repoAfter = {
      world: await treeDigest(path.join(REPO_ROOT, 'world')),
      data: await treeDigest(path.join(REPO_ROOT, 'data')),
    };
    assert.deepEqual(repoAfter, repoBefore);

    process.stdout.write(`${JSON.stringify({
      privatePaths: `${privateStatuses.length}/${privateStatuses.length}`,
      safeAssets: '4/4',
      cspDirectives: '11/11',
      noChallengeStatus: noChallenge.response.status,
      riskyPublication: risky.body.publicationStatus,
      riskyPublicFrames: 0,
      safePublication: safe.body.publicationStatus,
      stats: independentlyCounted,
      repositoryDigestsUnchanged: true,
      tempRoot: root,
    }, null, 2)}\n`);
  } finally {
    if (socket && socket.readyState !== WebSocket.CLOSED) {
      socket.close();
      await once(socket, 'close').catch(() => {});
    }
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
      await once(child, 'exit').catch(() => {});
    }
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
