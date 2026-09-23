'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');

const { readJsonResponse, ApiResponseError } = require('../mcp/http-response');

const REPO_ROOT = path.join(__dirname, '..');
const requireFromMcp = createRequire(path.join(REPO_ROOT, 'mcp/package.json'));
const { Client } = requireFromMcp('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = requireFromMcp('@modelcontextprotocol/sdk/client/stdio.js');

// ---------------------------------------------------------------------------------------------
// Unit tests: readJsonResponse / ApiResponseError
// ---------------------------------------------------------------------------------------------

test('HTML 429 with a numeric Retry-After produces a safe rate-limit message', async () => {
  // Mutation caught (M15): parsing the body before checking status/content-type would throw a
  // raw "Unexpected token '<'" SyntaxError here instead of a clear ApiResponseError.
  const response = new Response('<html><body>Too many requests</body></html>', {
    status: 429,
    headers: { 'Content-Type': 'text/html', 'Retry-After': '10' },
  });

  await assert.rejects(readJsonResponse(response, 'contributing'), (error) => {
    assert.ok(error instanceof ApiResponseError);
    assert.match(error.message, /rate limit/i);
    assert.match(error.message, /10 seconds/);
    assert.doesNotMatch(error.message, /<html/i);
    assert.equal(error.status, 429);
    assert.equal(error.retryAfterSeconds, 10);
    return true;
  });
});

test('HTML 429 without a Retry-After header omits the retry sentence', async () => {
  const response = new Response('rate limited', {
    status: 429,
    headers: { 'Content-Type': 'text/plain' },
  });

  await assert.rejects(readJsonResponse(response, 'contributing'), (error) => {
    assert.equal(error.message, 'AI BUILDS rate limit reached while contributing.');
    assert.equal(error.retryAfterSeconds, null);
    return true;
  });
});

test('HTML 429 with an invalid Retry-After value omits the retry sentence', async () => {
  // with -> without: an invalid header ("garbage") must behave exactly like an absent one, not
  // like a parsed number.
  const response = new Response('rate limited', {
    status: 429,
    headers: { 'Content-Type': 'text/plain', 'Retry-After': 'garbage' },
  });

  await assert.rejects(readJsonResponse(response, 'contributing'), (error) => {
    assert.equal(error.message, 'AI BUILDS rate limit reached while contributing.');
    assert.equal(error.retryAfterSeconds, null);
    return true;
  });
});

test('an HTTP-date Retry-After is converted to seconds', async () => {
  const future = new Date(Date.now() + 10_000);
  const response = new Response('rate limited', {
    status: 429,
    headers: { 'Content-Type': 'text/plain', 'Retry-After': future.toUTCString() },
  });

  await assert.rejects(readJsonResponse(response, 'contributing'), (error) => {
    assert.ok(
      error.retryAfterSeconds >= 8 && error.retryAfterSeconds <= 11,
      `expected ~10 seconds, got ${error.retryAfterSeconds}`,
    );
    return true;
  });
});

test('a JSON 429 body surfaces the server error text', async () => {
  const response = new Response(JSON.stringify({ error: 'Too many contributions, slow down.' }), {
    status: 429,
    headers: { 'Content-Type': 'application/json' },
  });

  await assert.rejects(readJsonResponse(response, 'contributing'), (error) => {
    assert.equal(error.message, 'Too many contributions, slow down.');
    assert.equal(error.status, 429);
    return true;
  });
});

test('a JSON error body carries the server code', async () => {
  const response = new Response(JSON.stringify({ error: 'no token', code: 'profile_token_required' }), {
    status: 401,
    headers: { 'Content-Type': 'application/json' },
  });

  await assert.rejects(readJsonResponse(response, 'updating your profile'), (error) => {
    assert.equal(error.message, 'no token');
    assert.equal(error.code, 'profile_token_required');
    assert.equal(error.status, 401);
    return true;
  });
});

test('a 200 JSON response is returned unchanged', async () => {
  const response = new Response(JSON.stringify({ ok: true, value: 42 }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

  const data = await readJsonResponse(response, 'reading');
  assert.deepEqual(data, { ok: true, value: 42 });
});

test('a 200 text/html response is treated as an error, not parsed as JSON', async () => {
  const response = new Response('<html>ok</html>', {
    status: 200,
    headers: { 'Content-Type': 'text/html' },
  });

  await assert.rejects(readJsonResponse(response, 'reading'), ApiResponseError);
});

test('a 500 HTML response names the status without leaking the body', async () => {
  const response = new Response('<html><body>boom</body></html>', {
    status: 500,
    headers: { 'Content-Type': 'text/html' },
  });

  await assert.rejects(readJsonResponse(response, 'loading stats'), (error) => {
    assert.match(error.message, /HTTP 500/);
    assert.doesNotMatch(error.message, /<html/i);
    assert.equal(error.status, 500);
    return true;
  });
});

test('a long JSON error string is truncated to 300 characters', async () => {
  const longError = 'x'.repeat(400);
  const response = new Response(JSON.stringify({ error: longError }), {
    status: 400,
    headers: { 'Content-Type': 'application/json' },
  });

  await assert.rejects(readJsonResponse(response, 'contributing'), (error) => {
    assert.equal(error.message.length, 300);
    return true;
  });
});

// ---------------------------------------------------------------------------------------------
// MCP integration: the real mcp/index.js against a local stub server
// ---------------------------------------------------------------------------------------------

function createStubServer() {
  const requests = [];
  const routes = {};
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      const handler = routes[`${req.method} ${req.url}`];
      if (!handler) {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'not found' }));
        return;
      }
      handler(req, res, body);
    });
  });
  return { server, requests, routes };
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

function jsonRoute(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function envWithoutProfileToken(overrides) {
  const { AIBUILDS_PROFILE_TOKEN: _drop, ...rest } = process.env;
  return { ...rest, ...overrides };
}

async function connectMcpClient(t, { env }) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['mcp/index.js'],
    cwd: REPO_ROOT,
    env,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'mcp-http-response-test', version: '1.0.0' });
  const stderr = [];
  transport.stderr.on('data', (chunk) => stderr.push(chunk.toString()));
  t.after(async () => { await client.close().catch(() => {}); });
  await client.connect(transport);
  return { client, stderr };
}

function textOf(result) {
  return result.content.map((item) => (item.type === 'text' ? item.text : '')).join('\n');
}

async function waitFor(predicate, description) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for: ${description}`);
}

test('an HTML 429 from Cloudflare on contribute produces a safe rate-limit error', async (t) => {
  // Mutation caught (M15): without the status-first check the tool text would be a raw JSON
  // parse error instead of a rate-limit message, and would risk echoing response internals.
  const { server, requests, routes } = createStubServer();
  routes['GET /api/challenge'] = (req, res) => jsonRoute(res, 200, { id: 'ch_test_12345', prefix: 'seed', difficulty: 0 });
  routes['POST /api/contribute'] = (req, res) => {
    res.statusCode = 429;
    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Retry-After', '10');
    res.end('<html><body>Too many requests</body></html>');
  };
  const baseUrl = await listen(server);
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const { client, stderr } = await connectMcpClient(t, {
    env: envWithoutProfileToken({ AGENT_NAME: 'Rate-Limited-Agent', AI_BUILDS_URL: baseUrl }),
  });

  const result = await client.callTool({
    name: 'aibuilds_contribute',
    arguments: {
      action: 'create',
      file_path: 'pages/marker.html',
      content: 'SECRET_MARKER_CONTENT_XYZ',
      message: 'test contribution',
    },
  });

  const text = textOf(result);
  assert.equal(result.isError, true, stderr.join(''));
  assert.match(text, /rate limit/i);
  assert.doesNotMatch(text, /<html/i);
  assert.equal(text.includes('ch_test_12345'), false, 'must not leak the challenge id');
  assert.equal(text.includes('SECRET_MARKER_CONTENT_XYZ'), false, 'must not leak request content');
  assert.equal(text.includes('abp_'), false, 'must not leak a token');

  const contributePosts = requests.filter((r) => r.method === 'POST' && r.url === '/api/contribute');
  assert.equal(contributePosts.length, 1, 'exactly one POST must reach the server, no retries');
});

test('a profile token returned on contribute is stored, never printed', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'aibuilds-mcp-http-response-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const token = `abp_${crypto.randomBytes(32).toString('base64url')}`;
  assert.match(token, /^abp_[A-Za-z0-9_-]{43}$/);

  const { server, routes } = createStubServer();
  routes['GET /api/challenge'] = (req, res) => jsonRoute(res, 200, { id: 'ch-2', prefix: 'seed', difficulty: 0 });
  routes['POST /api/contribute'] = (req, res) => jsonRoute(res, 200, {
    publicationStatus: 'published',
    contribution: { id: 'contrib-9', timestamp: '2026-01-01T00:00:00.000Z' },
    profile_token: token,
    profile_token_notice: 'A profile token was issued for this new agent.',
  });
  const baseUrl = await listen(server);
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const agentName = 'Token-Agent';
  const { client, stderr } = await connectMcpClient(t, {
    env: envWithoutProfileToken({ AGENT_NAME: agentName, AI_BUILDS_URL: baseUrl, HOME: home }),
  });

  const result = await client.callTool({
    name: 'aibuilds_contribute',
    arguments: { action: 'create', file_path: 'pages/demo.html', content: '<div>x</div>', message: 'demo' },
  });

  const text = textOf(result);
  assert.equal(result.isError, undefined, stderr.join(''));
  assert.equal(text.includes('abp_'), false, 'the raw token must never appear in tool output');
  assert.equal(text.includes(token), false);

  const tokenFileName = `profile-token-${crypto.createHash('sha256').update(agentName, 'utf8').digest('hex').slice(0, 16)}`;
  const tokenPath = path.join(home, '.aibuilds', tokenFileName);
  await waitFor(async () => {
    try { await fs.access(tokenPath); return true; } catch { return false; }
  }, `token file at ${tokenPath}`);

  const [stat, stored] = await Promise.all([fs.stat(tokenPath), fs.readFile(tokenPath, 'utf8')]);
  assert.equal(stat.mode & 0o777, 0o600);
  assert.equal(stored.trim(), token);
});

test('update_profile without a stored token fails closed and sends nothing', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'aibuilds-mcp-http-response-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));

  const { server, requests, routes } = createStubServer();
  routes['GET /api/challenge'] = (req, res) => jsonRoute(res, 200, { id: 'ch-3', prefix: 'seed', difficulty: 0 });
  routes['PUT /api/agents/No-Token-Agent/profile'] = (req, res) => jsonRoute(res, 200, {
    agent: { bio: 'should never happen', specializations: [] },
  });
  const baseUrl = await listen(server);
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const { client, stderr } = await connectMcpClient(t, {
    env: envWithoutProfileToken({ AGENT_NAME: 'No-Token-Agent', AI_BUILDS_URL: baseUrl, HOME: home }),
  });

  const result = await client.callTool({
    name: 'aibuilds_update_profile',
    arguments: { bio: 'hello' },
  });

  const text = textOf(result);
  assert.equal(result.isError, true, stderr.join(''));
  assert.match(text, /AIBUILDS_PROFILE_TOKEN/);
  assert.equal(requests.length, 0, 'no request of any kind should reach the server without a token');
  assert.equal(requests.filter((r) => r.method === 'PUT').length, 0);
});

test('update_profile with a stored token sends it as a bearer credential', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'aibuilds-mcp-http-response-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const token = `abp_${crypto.randomBytes(32).toString('base64url')}`;

  const { server, requests, routes } = createStubServer();
  routes['GET /api/challenge'] = (req, res) => jsonRoute(res, 200, { id: 'ch-4', prefix: 'seed', difficulty: 0 });
  routes['PUT /api/agents/With-Token-Agent/profile'] = (req, res) => jsonRoute(res, 200, {
    agent: { bio: 'hello', specializations: [] },
  });
  const baseUrl = await listen(server);
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const { client, stderr } = await connectMcpClient(t, {
    env: envWithoutProfileToken({
      AGENT_NAME: 'With-Token-Agent',
      AI_BUILDS_URL: baseUrl,
      HOME: home,
      AIBUILDS_PROFILE_TOKEN: token,
    }),
  });

  const result = await client.callTool({
    name: 'aibuilds_update_profile',
    arguments: { bio: 'hello' },
  });

  assert.equal(result.isError, undefined, stderr.join(''));
  const putRequests = requests.filter((r) => r.method === 'PUT');
  assert.equal(putRequests.length, 1);
  assert.equal(putRequests[0].headers.authorization, `Bearer ${token}`);
});
