'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { createRequire } = require('node:module');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const WebSocket = require('ws');

const { validateWorldWritePath } = require('../server/world-write-policy');
const { CONTRIBUTE_CONTRACT } = require('../mcp/tool-contracts');

const REPO_ROOT = path.join(__dirname, '..');
const requireFromMcp = createRequire(path.join(REPO_ROOT, 'mcp/package.json'));
const { Client } = requireFromMcp('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = requireFromMcp('@modelcontextprotocol/sdk/client/stdio.js');

async function getFreePort() {
  const listener = net.createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  return port;
}

async function waitForServer(baseUrl, child, logs) {
  const deadline = Date.now() + 12_000;
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

async function contribute(baseUrl, payload) {
  const challenge = await requestJson(baseUrl, '/api/challenge');
  assert.equal(challenge.response.status, 200);
  return requestJson(baseUrl, '/api/contribute', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Challenge-Id': challenge.body.id,
      'X-Challenge-Nonce': '0',
    },
    body: JSON.stringify({
      agent_name: 'Contract-Agent',
      message: 'contract test contribution',
      ...payload,
    }),
  });
}

function fencedBlocks(source) {
  return Array.from(source.matchAll(/```[^\n]*\n([\s\S]*?)```/g), match => match[1]);
}

function filePathsFromMachineExamples(source) {
  return fencedBlocks(source).flatMap(block => Array.from(
    block.matchAll(/["']?file_path["']?\s*[:=]\s*["']([^"']+)["']/g),
    match => match[1],
  ));
}

test('write policy and machine-readable MCP examples expose only approved targets', () => {
  // Mutation caught: protected literals leaking into the positive contract yields five rejected examples.
  const protectedPaths = ['layout.html', 'index.html', 'js/core.js', 'css/theme.css', 'WORLD.md'];
  const writablePaths = ['PROJECT.md', 'pages/demo.html', 'sections/demo.html'];

  for (const filePath of protectedPaths) {
    assert.equal(validateWorldWritePath(filePath).allowed, false, filePath);
  }
  for (const filePath of writablePaths) {
    assert.deepEqual(validateWorldWritePath(filePath), { allowed: true }, filePath);
  }
  assert.ok(Array.isArray(CONTRIBUTE_CONTRACT.examples));
  assert.ok(CONTRIBUTE_CONTRACT.examples.length >= 3);
  for (const example of CONTRIBUTE_CONTRACT.examples) {
    assert.equal(validateWorldWritePath(example.file_path).allowed, true, example.file_path);
  }
});

test('static agent instruction configs use the production write policy', async () => {
  // Mutation caught: stale protected file_path values in fenced machine configs bypass contract review.
  const instructionFiles = [
    'README.md',
    'mcp/README.md',
    'world/WORLD.md',
    'world/PROJECT.md',
    'public/llms.txt',
    'public/llms-full.txt',
    'public/index.html',
    'public/landing.html',
  ];
  let examples = 0;
  for (const relativePath of instructionFiles) {
    const source = await fs.readFile(path.join(REPO_ROOT, relativePath), 'utf8');
    for (const filePath of filePathsFromMachineExamples(source)) {
      examples += 1;
      assert.equal(validateWorldWritePath(filePath).allowed, true, `${relativePath}: ${filePath}`);
    }
  }
  assert.ok(examples >= 4, `expected multiple machine-readable file_path examples, found ${examples}`);
});

test('MCP get_context preserves the operator-owned Chaos boundary', async (t) => {
  // Mutation caught: restoring "all scoping rules are off" or a global-CSS allowance changes
  // the real MCP tool response and violates the protected-global-files contract.
  const backend = http.createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/api/world/structure') {
      response.end(JSON.stringify({ sections: [] }));
      return;
    }
    if (request.url === '/api/pages') {
      response.end(JSON.stringify({ pages: [] }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: 'not found' }));
  });
  await new Promise((resolve, reject) => {
    backend.once('error', reject);
    backend.listen(0, '127.0.0.1', resolve);
  });

  const backendUrl = `http://127.0.0.1:${backend.address().port}`;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['mcp/index.js'],
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      AGENT_NAME: 'MCP-Contract-Agent',
      AI_BUILDS_URL: backendUrl,
    },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'aibuilds-contract-test', version: '1.0.0' });
  const stderr = [];
  transport.stderr.on('data', chunk => stderr.push(chunk.toString()));
  t.after(async () => {
    await client.close().catch(() => {});
    await new Promise(resolve => backend.close(resolve));
  });

  await client.connect(transport);
  const result = await client.callTool({ name: 'aibuilds_get_context', arguments: {} });
  assert.equal(result.isError, undefined, stderr.join(''));
  const context = result.content.map(item => item.type === 'text' ? item.text : '').join('\n');
  assert.ok(context.includes(
    'page- and section-scoped styling rules are relaxed; protected global files remain operator-controlled',
  ));
  assert.equal(context.toLowerCase().includes('all scoping rules are off'), false);
  assert.equal(context.toLowerCase().includes('global css allowed'), false);
});

test('real API publishes complete metrics and enforces the shared write contract', async (t) => {
  // Mutation caught: retaining the old protected-only route allows five non-writable contract targets.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aibuilds-public-contract-'));
  const worldDir = path.join(root, 'world');
  const dataDir = path.join(root, 'data');
  const backupDir = path.join(root, 'backups');
  await Promise.all([
    fs.mkdir(worldDir, { recursive: true }),
    fs.mkdir(dataDir, { recursive: true }),
    fs.mkdir(backupDir, { recursive: true }),
  ]);

  const port = await getFreePort();
  const logs = [];
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      POW_DIFFICULTY: '0',
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
    await fs.rm(root, { recursive: true, force: true });
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForServer(baseUrl, child, logs);

  const [discovery, stats] = await Promise.all([
    requestJson(baseUrl, '/api'),
    requestJson(baseUrl, '/api/stats'),
  ]);
  assert.equal(discovery.response.status, 200, logs.join(''));
  assert.equal(discovery.body.capabilities.agentContributions.actor, 'AI agents');
  assert.equal(discovery.body.capabilities.operatorModeration.actor, 'Platform operators');
  assert.deepEqual(discovery.body.capabilities.agentContributions.writableTargets,
    ['pages/*.html', 'sections/*.html', 'PROJECT.md']);

  assert.equal(stats.response.status, 200, logs.join(''));
  const expectedTypes = {
    viewerCount: 'number',
    totalContributions: 'number',
    fileCount: 'number',
    agentCount: 'number',
    activeDays: 'number',
    collaborativeFileCount: 'number',
    lastContributionAt: 'object',
    isLive: 'boolean',
    quarantinedFileCount: 'number',
  };
  for (const [field, expectedType] of Object.entries(expectedTypes)) {
    assert.equal(typeof stats.body[field], expectedType, field);
  }
  assert.equal(stats.body.lastContributionAt, null);

  const socket = new WebSocket(baseUrl.replace('http://', 'ws://'));
  const welcomeMessage = once(socket, 'message');
  await once(socket, 'open');
  const [welcomeBytes] = await welcomeMessage;
  const welcome = JSON.parse(String(welcomeBytes));
  socket.close();
  await once(socket, 'close');
  assert.equal(welcome.type, 'welcome');
  for (const [field, expectedType] of Object.entries(expectedTypes)) {
    assert.equal(typeof welcome[field], expectedType, `welcome.${field}`);
  }
  assert.equal(welcome.lastContributionAt, null);
  assert.equal(welcome.totalContributions, stats.body.totalContributions);
  assert.equal(welcome.fileCount, stats.body.fileCount);
  assert.equal(Array.isArray(welcome.recentHistory), true);

  const rejected = [];
  for (const filePath of ['layout.html', 'index.html', 'js/core.js', 'css/theme.css', 'WORLD.md']) {
    const result = await contribute(baseUrl, {
      action: 'edit',
      file_path: filePath,
      content: '<p>must remain protected</p>',
    });
    rejected.push(result.response.status);
  }
  assert.deepEqual(rejected, [403, 403, 403, 403, 403]);

  const accepted = [];
  for (const [filePath, content] of [
    ['PROJECT.md', '# Shared plan\n'],
    ['pages/demo.html', '<div data-page-title="Demo"><h1>Demo</h1></div>'],
    ['sections/demo.html', '<section data-section-title="Demo"><h2>Demo</h2></section>'],
  ]) {
    const result = await contribute(baseUrl, { action: 'create', file_path: filePath, content });
    accepted.push(result.response.status);
  }
  assert.deepEqual(accepted, [200, 200, 200], logs.join(''));
});
