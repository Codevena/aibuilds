'use strict';

// In-process tests for server/ws-admission.js: an own http server on port 0, real `ws`
// clients and raw `net` sockets, injected fakes for identity resolution and rate
// consumption. No spawned child process here — see the "spawned server" block appended
// at the end of this file (added separately; keep new in-process tests above that marker).

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');
const WebSocket = require('ws');

const {
  createWsAdmission,
  sendWithBackpressure,
  DEFAULT_WS_LIMITS,
} = require('../server/ws-admission');

// ---------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------

// The caller (server/index.js in production) is responsible for constructing the
// WebSocket.Server this way; tests reproduce that contract so mutation M11 (maxPayload not
// honoured) can be exercised by changing what this helper passes.
function createTestWss({ maxPayload = DEFAULT_WS_LIMITS.maxPayload } = {}) {
  return new WebSocket.Server({ noServer: true, maxPayload, clientTracking: false });
}

function spy(impl) {
  const fn = (...args) => {
    fn.calls.push(args);
    return impl ? impl(...args) : undefined;
  };
  fn.calls = [];
  return fn;
}

function fixedIdentity(key) {
  return () => ({ ok: true, key });
}

// Reads the identity key from a test-controlled header so a single resolveIdentity fake
// can simulate distinct clients (including several "addresses" sharing one IPv6 /64
// limiter key) without needing real distinct source addresses.
function headerIdentity(headerName = 'x-test-key', fallbackKey = 'peer:fallback') {
  return (req) => {
    const value = req.headers[headerName];
    if (value) return { ok: true, key: String(value) };
    return { ok: false, fallbackKey };
  };
}

function allowAllConsume() {
  return async () => ({ allowed: true });
}

function delayedConsume(ms, result = { allowed: true }) {
  return () => new Promise((resolve) => setTimeout(() => resolve(result), ms));
}

function countingConsume(limit) {
  const counts = new Map();
  return async (_policy, key) => {
    const n = (counts.get(key) || 0) + 1;
    counts.set(key, n);
    if (n > limit) return { allowed: false, retryAfterSeconds: 7 };
    return { allowed: true };
  };
}

async function startServer(admission) {
  const server = http.createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  // `server.closeAllConnections()` explicitly excludes upgraded (WebSocket) sockets — a
  // connection a test forgot to close (e.g. because an assertion threw first) would then
  // hang `server.close()` forever. Tracking raw sockets ourselves, at the TCP level, before
  // any HTTP/upgrade handling happens, lets cleanup force-close everything regardless.
  const rawSockets = new Set();
  server.on('connection', (socket) => {
    rawSockets.add(socket);
    socket.once('close', () => rawSockets.delete(socket));
  });
  server.on('upgrade', admission.handleUpgrade);
  await new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', (err) => (err ? reject(err) : resolve()));
  });
  const { port } = server.address();
  const baseUrl = `ws://127.0.0.1:${port}`;
  return { server, port, baseUrl, url: `${baseUrl}/ws`, rawSockets };
}

function stopServer(server, rawSockets) {
  if (rawSockets) {
    for (const socket of rawSockets) {
      try {
        socket.destroy();
      } catch {
        // Already gone.
      }
    }
  }
  return new Promise((resolve) => server.close(resolve));
}

function once(emitter, event) {
  return new Promise((resolve, reject) => {
    const onEvent = (...args) => {
      emitter.removeListener('error', onError);
      resolve(args);
    };
    const onError = (err) => {
      emitter.removeListener(event, onEvent);
      reject(err);
    };
    emitter.once(event, onEvent);
    if (event !== 'error') emitter.once('error', onError);
  });
}

// Resolves with a normalized outcome for a `ws` client attempting to connect: either the
// handshake succeeded ('open') or the server answered with a non-101 HTTP response
// ('rejected', with status/headers/body), or the connection errored out before a full HTTP
// response could be parsed ('error' — used only for the raw-socket abort tests).
function waitForOutcome(ws, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('timed out waiting for connection outcome'));
    }, timeoutMs);

    ws.once('open', () => {
      clearTimeout(timer);
      resolve({ type: 'open' });
    });

    ws.once('unexpected-response', (_req, res) => {
      clearTimeout(timer);
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          type: 'rejected',
          statusCode: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });

    ws.once('error', (err) => {
      clearTimeout(timer);
      resolve({ type: 'error', error: err });
    });
  });
}

function waitForClose(ws, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for close')), timeoutMs);
    ws.once('close', (code, reason) => {
      clearTimeout(timer);
      resolve({ code, reason: reason ? reason.toString() : '' });
    });
  });
}

async function waitUntil(conditionFn, { timeoutMs = 2000, intervalMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await conditionFn()) return;
    if (Date.now() > deadline) {
      throw new Error('timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildRawUpgradeRequest({ host, path = '/ws', origin, extraHeaders = '' }) {
  const key = crypto.randomBytes(16).toString('base64');
  let req =
    `GET ${path} HTTP/1.1\r\n` +
    `Host: ${host}\r\n` +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Key: ${key}\r\n` +
    'Sec-WebSocket-Version: 13\r\n';
  if (origin !== undefined) req += `Origin: ${origin}\r\n`;
  req += extraHeaders;
  req += '\r\n';
  return req;
}

function rawConnect(port) {
  return net.connect({ port, host: '127.0.0.1' });
}

function closeAll(sockets) {
  for (const ws of sockets) {
    try {
      ws.terminate();
    } catch {
      // ignore
    }
  }
}

// ---------------------------------------------------------------------------------------
// Path
// ---------------------------------------------------------------------------------------

test('ws-admission: wrong path is rejected with 404, handleUpgrade never called, stats stay 0', async () => {
  const wss = createTestWss();
  const handleUpgradeSpy = spy(wss.handleUpgrade.bind(wss));
  wss.handleUpgrade = handleUpgradeSpy;
  const onAccepted = spy();

  const admission = createWsAdmission({
    wss,
    resolveIdentity: fixedIdentity('k'),
    consume: allowAllConsume(),
    enforcement: 'enforce',
    allowedOrigins: new Set(),
    allowLocalhostOrigins: true,
    onAccepted,
  });

  const { server, baseUrl, rawSockets } = await startServer(admission);
  try {
    for (const path of ['/', '/ws/x']) {
      const ws = new WebSocket(`${baseUrl}${path}`);
      const outcome = await waitForOutcome(ws);
      assert.equal(outcome.type, 'rejected');
      assert.equal(outcome.statusCode, 404);
    }
    assert.equal(handleUpgradeSpy.calls.length, 0);
    assert.equal(onAccepted.calls.length, 0);
    assert.deepEqual(admission.stats(), { total: 0, perKey: {} });
  } finally {
    await stopServer(server, rawSockets);
  }
});

// ---------------------------------------------------------------------------------------
// Origin
// ---------------------------------------------------------------------------------------

test('ws-admission: Origin allowlist — evil and null rejected 403, allowed and absent accepted', async () => {
  const wss = createTestWss();
  const onAccepted = spy((ws) => ws.close());

  const admission = createWsAdmission({
    wss,
    resolveIdentity: fixedIdentity('k'),
    consume: allowAllConsume(),
    enforcement: 'enforce',
    allowedOrigins: new Set(['https://aibuilds.dev']),
    allowLocalhostOrigins: false,
    onAccepted,
  });

  const { server, url, rawSockets } = await startServer(admission);
  try {
    const evil = new WebSocket(url, { headers: { Origin: 'https://evil.example' } });
    const evilOutcome = await waitForOutcome(evil);
    assert.equal(evilOutcome.type, 'rejected');
    assert.equal(evilOutcome.statusCode, 403);

    const nullOrigin = new WebSocket(url, { headers: { Origin: 'null' } });
    const nullOutcome = await waitForOutcome(nullOrigin);
    assert.equal(nullOutcome.type, 'rejected');
    assert.equal(nullOutcome.statusCode, 403);

    const allowed = new WebSocket(url, { headers: { Origin: 'https://aibuilds.dev' } });
    const allowedOutcome = await waitForOutcome(allowed);
    assert.equal(allowedOutcome.type, 'open');
    allowed.close();

    const absent = new WebSocket(url);
    const absentOutcome = await waitForOutcome(absent);
    assert.equal(absentOutcome.type, 'open');
    absent.close();
  } finally {
    await stopServer(server, rawSockets);
  }
});

// ---------------------------------------------------------------------------------------
// maxPayload
// ---------------------------------------------------------------------------------------

test('ws-admission: maxPayload — 64 KiB + 1 closes with 1009, exactly 64 KiB stays open', async () => {
  const wss = createTestWss({ maxPayload: 64 * 1024 });
  const onAccepted = spy((ws) => ws.on('error', () => {}));

  const admission = createWsAdmission({
    wss,
    resolveIdentity: fixedIdentity('k'),
    consume: allowAllConsume(),
    enforcement: 'enforce',
    allowedOrigins: new Set(),
    allowLocalhostOrigins: true,
    onAccepted,
  });

  const { server, url, rawSockets } = await startServer(admission);
  try {
    const overLimit = new WebSocket(url);
    await waitForOutcome(overLimit);
    overLimit.send(Buffer.alloc(64 * 1024 + 1));
    const closeEvent = await waitForClose(overLimit);
    assert.equal(closeEvent.code, 1009);

    const atLimit = new WebSocket(url);
    await waitForOutcome(atLimit);
    atLimit.send(Buffer.alloc(64 * 1024));
    await sleep(150);
    assert.equal(atLimit.readyState, WebSocket.OPEN);
    atLimit.close();
  } finally {
    await stopServer(server, rawSockets);
  }
});

// ---------------------------------------------------------------------------------------
// Per-identity cap
// ---------------------------------------------------------------------------------------

test('ws-admission: per-identity cap 5 — 6th is 429, a different identity still gets 101', async () => {
  const wss = createTestWss();
  const onAccepted = spy();

  const admission = createWsAdmission({
    wss,
    resolveIdentity: headerIdentity(),
    consume: allowAllConsume(),
    enforcement: 'enforce',
    allowedOrigins: new Set(),
    allowLocalhostOrigins: true,
    limits: { ...DEFAULT_WS_LIMITS, perIdentity: 5, global: 1000 },
    onAccepted,
  });

  const { server, url, rawSockets } = await startServer(admission);
  const opened = [];
  try {
    for (let i = 0; i < 5; i += 1) {
      const ws = new WebSocket(url, { headers: { 'x-test-key': 'k1' } });
      const outcome = await waitForOutcome(ws);
      assert.equal(outcome.type, 'open');
      opened.push(ws);
    }

    const sixth = new WebSocket(url, { headers: { 'x-test-key': 'k1' } });
    const sixthOutcome = await waitForOutcome(sixth);
    assert.equal(sixthOutcome.type, 'rejected');
    assert.equal(sixthOutcome.statusCode, 429);

    const otherKey = new WebSocket(url, { headers: { 'x-test-key': 'k2' } });
    const otherOutcome = await waitForOutcome(otherKey);
    assert.equal(otherOutcome.type, 'open');
    opened.push(otherKey);
  } finally {
    closeAll(opened);
    await stopServer(server, rawSockets);
  }
});

test('ws-admission: 6 addresses in one IPv6 /64 (same limiter key) — 6th is 429', async () => {
  const wss = createTestWss();
  const groupKey = '2001:db8:1:2::/64';

  const admission = createWsAdmission({
    wss,
    resolveIdentity: headerIdentity(),
    consume: allowAllConsume(),
    enforcement: 'enforce',
    allowedOrigins: new Set(),
    allowLocalhostOrigins: true,
    limits: { ...DEFAULT_WS_LIMITS, perIdentity: 5, global: 1000 },
    onAccepted: spy(),
  });

  const { server, url, rawSockets } = await startServer(admission);
  const opened = [];
  try {
    for (let i = 0; i < 5; i += 1) {
      const ws = new WebSocket(url, { headers: { 'x-test-key': groupKey } });
      const outcome = await waitForOutcome(ws);
      assert.equal(outcome.type, 'open');
      opened.push(ws);
    }

    const sixth = new WebSocket(url, { headers: { 'x-test-key': groupKey } });
    const sixthOutcome = await waitForOutcome(sixth);
    assert.equal(sixthOutcome.type, 'rejected');
    assert.equal(sixthOutcome.statusCode, 429);
  } finally {
    closeAll(opened);
    await stopServer(server, rawSockets);
  }
});

// ---------------------------------------------------------------------------------------
// Global cap
// ---------------------------------------------------------------------------------------

test('ws-admission: global cap (configured to 3) rejects the 4th with 503', async () => {
  const wss = createTestWss();

  const admission = createWsAdmission({
    wss,
    resolveIdentity: fixedIdentity('same-key'),
    consume: allowAllConsume(),
    enforcement: 'enforce',
    allowedOrigins: new Set(),
    allowLocalhostOrigins: true,
    limits: { ...DEFAULT_WS_LIMITS, perIdentity: 100, global: 3 },
    onAccepted: spy(),
  });

  const { server, url, rawSockets } = await startServer(admission);
  const opened = [];
  try {
    for (let i = 0; i < 3; i += 1) {
      const ws = new WebSocket(url);
      const outcome = await waitForOutcome(ws);
      assert.equal(outcome.type, 'open');
      opened.push(ws);
    }

    const fourth = new WebSocket(url);
    const fourthOutcome = await waitForOutcome(fourth);
    assert.equal(fourthOutcome.type, 'rejected');
    assert.equal(fourthOutcome.statusCode, 503);
    assert.equal(fourthOutcome.headers['retry-after'], '30');
  } finally {
    closeAll(opened);
    await stopServer(server, rawSockets);
  }
});

// ---------------------------------------------------------------------------------------
// Counters return to zero
// ---------------------------------------------------------------------------------------

test('ws-admission: counters return to zero after close/terminate', async () => {
  const wss = createTestWss();
  const accepted = [];

  const admission = createWsAdmission({
    wss,
    resolveIdentity: headerIdentity(),
    consume: allowAllConsume(),
    enforcement: 'enforce',
    allowedOrigins: new Set(),
    allowLocalhostOrigins: true,
    onAccepted: (ws) => accepted.push(ws),
  });

  const { server, url, rawSockets } = await startServer(admission);
  try {
    const a = new WebSocket(url, { headers: { 'x-test-key': 'ka' } });
    await waitForOutcome(a);
    const b = new WebSocket(url, { headers: { 'x-test-key': 'kb' } });
    await waitForOutcome(b);

    assert.equal(admission.stats().total, 2);

    a.close();
    // terminate the second one server-side to also cover the terminate() path
    const serverSideB = accepted[1];
    serverSideB.terminate();

    await waitUntil(() => admission.stats().total === 0);
    assert.deepEqual(admission.stats(), { total: 0, perKey: {} });
  } finally {
    await stopServer(server, rawSockets);
  }
});

// ---------------------------------------------------------------------------------------
// Aborted upgrades (FIN and RST) while consume() is pending
// ---------------------------------------------------------------------------------------

test('ws-admission: aborted upgrade (FIN) while the upgrade limiter is pending leaks nothing', async () => {
  const wss = createTestWss();

  const admission = createWsAdmission({
    wss,
    resolveIdentity: fixedIdentity('abort-key'),
    consume: delayedConsume(100),
    enforcement: 'enforce',
    allowedOrigins: new Set(),
    allowLocalhostOrigins: true,
    onAccepted: spy(),
  });

  const { server, port, rawSockets } = await startServer(admission);
  try {
    const socket = rawConnect(port);
    await once(socket, 'connect');
    socket.write(buildRawUpgradeRequest({ host: `127.0.0.1:${port}` }));
    socket.destroy();

    await sleep(200);
    assert.deepEqual(admission.stats(), { total: 0, perKey: {} });
  } finally {
    await stopServer(server, rawSockets);
  }
});

test('ws-admission: aborted upgrade (RST) while the upgrade limiter is pending leaks nothing', async () => {
  const wss = createTestWss();

  const admission = createWsAdmission({
    wss,
    resolveIdentity: fixedIdentity('abort-key'),
    consume: delayedConsume(100),
    enforcement: 'enforce',
    allowedOrigins: new Set(),
    allowLocalhostOrigins: true,
    onAccepted: spy(),
  });

  const { server, port, rawSockets } = await startServer(admission);
  try {
    const socket = rawConnect(port);
    await once(socket, 'connect');
    socket.write(buildRawUpgradeRequest({ host: `127.0.0.1:${port}` }));
    socket.resetAndDestroy();

    await sleep(200);
    assert.deepEqual(admission.stats(), { total: 0, perKey: {} });
  } finally {
    await stopServer(server, rawSockets);
  }
});

// ---------------------------------------------------------------------------------------
// Upgrade rate limiting (consume) vs. per-identity socket cap
// ---------------------------------------------------------------------------------------

test('ws-admission: upgrade rate limit — 20 succeed, 21st is 429 from consume()', async () => {
  const wss = createTestWss();

  const admission = createWsAdmission({
    wss,
    resolveIdentity: fixedIdentity('rate-key'),
    consume: countingConsume(20),
    enforcement: 'enforce',
    allowedOrigins: new Set(),
    allowLocalhostOrigins: true,
    limits: { ...DEFAULT_WS_LIMITS, perIdentity: 100, global: 1000 },
    onAccepted: spy(),
  });

  const { server, url, rawSockets } = await startServer(admission);
  const opened = [];
  try {
    for (let i = 0; i < 20; i += 1) {
      const ws = new WebSocket(url);
      const outcome = await waitForOutcome(ws);
      assert.equal(outcome.type, 'open');
      opened.push(ws);
    }

    const twentyFirst = new WebSocket(url);
    const outcome = await waitForOutcome(twentyFirst);
    assert.equal(outcome.type, 'rejected');
    assert.equal(outcome.statusCode, 429);
    assert.equal(outcome.headers['retry-after'], '7');
  } finally {
    closeAll(opened);
    await stopServer(server, rawSockets);
  }
});

test('ws-admission: consume() throwing rejects the new upgrade with 503 while an already-open socket still receives a message', async () => {
  const wss = createTestWss();
  let shouldThrow = false;
  const consume = async (_policy, _key) => {
    if (shouldThrow) throw new Error('store unavailable');
    return { allowed: true };
  };
  const acceptedSockets = [];

  const admission = createWsAdmission({
    wss,
    resolveIdentity: fixedIdentity('k'),
    consume,
    enforcement: 'enforce',
    allowedOrigins: new Set(),
    allowLocalhostOrigins: true,
    onAccepted: (ws) => acceptedSockets.push(ws),
  });

  const { server, url, rawSockets } = await startServer(admission);
  try {
    const client = new WebSocket(url);
    await waitForOutcome(client);
    assert.equal(acceptedSockets.length, 1);

    shouldThrow = true;
    const rejected = new WebSocket(url);
    const outcome = await waitForOutcome(rejected);
    assert.equal(outcome.type, 'rejected');
    assert.equal(outcome.statusCode, 503);
    assert.equal(outcome.headers['retry-after'], '30');

    const messageArrived = once(client, 'message');
    const delivered = sendWithBackpressure(acceptedSockets[0], JSON.stringify({ type: 'ping' }), DEFAULT_WS_LIMITS.maxBufferedBytes);
    assert.equal(delivered, true);
    const [data] = await messageArrived;
    assert.equal(JSON.parse(data.toString()).type, 'ping');
    client.close();
  } finally {
    await stopServer(server, rawSockets);
  }
});

// ---------------------------------------------------------------------------------------
// Identity resolution: enforce rejects, shadow falls back (D3)
// ---------------------------------------------------------------------------------------

test('ws-admission: no provenance in enforce mode is 503, handler never called', async () => {
  const wss = createTestWss();
  const onAccepted = spy();

  const admission = createWsAdmission({
    wss,
    resolveIdentity: () => ({ ok: false, fallbackKey: 'peer:1.2.3.4' }),
    consume: allowAllConsume(),
    enforcement: 'enforce',
    allowedOrigins: new Set(),
    allowLocalhostOrigins: true,
    onAccepted,
  });

  const { server, url, rawSockets } = await startServer(admission);
  try {
    const ws = new WebSocket(url);
    const outcome = await waitForOutcome(ws);
    assert.equal(outcome.type, 'rejected');
    assert.equal(outcome.statusCode, 503);
    assert.equal(outcome.headers['retry-after'], '30');
    assert.equal(onAccepted.calls.length, 0);
    assert.deepEqual(admission.stats(), { total: 0, perKey: {} });
  } finally {
    await stopServer(server, rawSockets);
  }
});

test('ws-admission: no provenance in shadow mode uses the fallback key and still connects', async () => {
  const wss = createTestWss();

  const admission = createWsAdmission({
    wss,
    resolveIdentity: () => ({ ok: false, fallbackKey: 'peer:1.2.3.4' }),
    consume: allowAllConsume(),
    enforcement: 'shadow',
    allowedOrigins: new Set(),
    allowLocalhostOrigins: true,
    onAccepted: spy(),
  });

  const { server, url, rawSockets } = await startServer(admission);
  try {
    const ws = new WebSocket(url);
    const outcome = await waitForOutcome(ws);
    assert.equal(outcome.type, 'open');
    assert.deepEqual(admission.stats(), { total: 1, perKey: { 'peer:1.2.3.4': 1 } });
    ws.close();
  } finally {
    await stopServer(server, rawSockets);
  }
});

test('ws-admission (item 1 alignment): no provenance AND no fallback key (invalid-peer) is 503 even in shadow mode - never a key of undefined', async () => {
  const wss = createTestWss();
  const onAccepted = spy();

  const admission = createWsAdmission({
    wss,
    // reason 'invalid-peer': the socket address itself could not be canonicalized, so
    // client-ip.js's resolve() returns fallbackKey: null - there is nothing to count against even
    // under shadow.
    resolveIdentity: () => ({ ok: false, reason: 'invalid-peer', fallbackKey: null }),
    consume: allowAllConsume(),
    enforcement: 'shadow',
    allowedOrigins: new Set(),
    allowLocalhostOrigins: true,
    onAccepted,
  });

  const { server, url, rawSockets } = await startServer(admission);
  try {
    const ws = new WebSocket(url);
    const outcome = await waitForOutcome(ws);
    assert.equal(outcome.type, 'rejected');
    assert.equal(outcome.statusCode, 503);
    assert.equal(onAccepted.calls.length, 0);
    // Never a shared `undefined` bucket: no key was reserved anywhere.
    assert.deepEqual(admission.stats(), { total: 0, perKey: {} });
  } finally {
    await stopServer(server, rawSockets);
  }
});

// ---------------------------------------------------------------------------------------
// Rejections never call onAccepted (I8)
// ---------------------------------------------------------------------------------------

test('ws-admission: rejected upgrades never call onAccepted, a subsequent valid one does', async () => {
  const wss = createTestWss();
  // Deliberately does not close accepted sockets here (cleanup happens via closeAll in
  // `finally`): closing `first` immediately would release its reserved counter before the
  // global-cap assertion below runs, undoing the very state the test depends on.
  const onAccepted = spy();

  const admission = createWsAdmission({
    wss,
    resolveIdentity: headerIdentity(),
    consume: countingConsume(1),
    enforcement: 'enforce',
    allowedOrigins: new Set(['https://aibuilds.dev']),
    allowLocalhostOrigins: false,
    limits: { ...DEFAULT_WS_LIMITS, perIdentity: 1, global: 1 },
    onAccepted,
  });

  const { server, url, rawSockets } = await startServer(admission);
  const opened = [];
  try {
    // bad path
    assert.equal((await waitForOutcome(new WebSocket(`${url}/nope`))).type, 'rejected');
    // bad origin
    assert.equal(
      (await waitForOutcome(new WebSocket(url, { headers: { Origin: 'https://evil.example' } }))).type,
      'rejected',
    );

    // exhaust global cap with one accepted connection under a fresh identity, then a second
    // attempt under a different identity trips the global cap (still a rejection).
    const first = new WebSocket(url, { headers: { 'x-test-key': 'g1' } });
    assert.equal((await waitForOutcome(first)).type, 'open');
    opened.push(first);
    assert.equal(
      (await waitForOutcome(new WebSocket(url, { headers: { 'x-test-key': 'g2' } }))).type,
      'rejected',
    );

    assert.equal(onAccepted.calls.length, 1);
  } finally {
    closeAll(opened);
    await stopServer(server, rawSockets);
  }
});

// ---------------------------------------------------------------------------------------
// sendWithBackpressure (fake ws objects)
// ---------------------------------------------------------------------------------------

test('sendWithBackpressure: over the buffered-bytes limit terminates and never sends', () => {
  const terminate = spy();
  const send = spy();
  const fakeWs = { readyState: WebSocket.OPEN, bufferedAmount: 2 * 1024 * 1024, terminate, send };

  const result = sendWithBackpressure(fakeWs, 'hello', 1024 * 1024);

  assert.equal(result, false);
  assert.equal(terminate.calls.length, 1);
  assert.equal(send.calls.length, 0);
});

test('sendWithBackpressure: under the buffered-bytes limit sends and never terminates', () => {
  const terminate = spy();
  const send = spy();
  const fakeWs = { readyState: WebSocket.OPEN, bufferedAmount: 0, terminate, send };

  const result = sendWithBackpressure(fakeWs, 'hello', 1024 * 1024);

  assert.equal(result, true);
  assert.equal(send.calls.length, 1);
  assert.equal(send.calls[0][0], 'hello');
  assert.equal(terminate.calls.length, 0);
});

test('sendWithBackpressure: only sends while readyState is OPEN', () => {
  const terminate = spy();
  const send = spy();
  const fakeWs = { readyState: WebSocket.CONNECTING, bufferedAmount: 0, terminate, send };

  const result = sendWithBackpressure(fakeWs, 'hello', 1024 * 1024);

  assert.equal(result, false);
  assert.equal(send.calls.length, 0);
  assert.equal(terminate.calls.length, 0);
});

test('sendWithBackpressure: a throwing send() terminates and returns false', () => {
  const terminate = spy();
  const send = spy(() => {
    throw new Error('boom');
  });
  const fakeWs = { readyState: WebSocket.OPEN, bufferedAmount: 0, terminate, send };

  const result = sendWithBackpressure(fakeWs, 'hello', 1024 * 1024);

  assert.equal(result, false);
  assert.equal(terminate.calls.length, 1);
});

// ---------------------------------------------------------------------------------------
// Spawned-server tests (T6): the real server/index.js, wired through server.on('upgrade', ...)
// and the real WebSocket.Server({ noServer: true, clientTracking: false }) - not the local test
// wss fixtures above.
// ---------------------------------------------------------------------------------------

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
// `once` is the local helper defined above (not node:events - it also treats 'error' specially).

// Trailing \s is load-bearing (see NEXT_SESSION.md "Fallen" #2): without it a stdout chunk ending
// mid-number matches a truncated port and the first (wrong) match is cached.
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

async function spawnRealServer(t, extraEnv = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aibuilds-ws-admission-'));
  const worldDir = path.join(root, 'world');
  const dataDir = path.join(root, 'data');
  const backupDir = path.join(root, 'backups');
  await fs.mkdir(worldDir, { recursive: true });
  await fs.mkdir(dataDir, { recursive: true });

  const logs = [];
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: '0',
      POW_DIFFICULTY: '0',
      AIBUILDS_WORLD_DIR: worldDir,
      AIBUILDS_DATA_DIR: dataDir,
      AIBUILDS_BACKUP_DIR: backupDir,
      ADMIN_RESET_SECRET: 'operator-secret',
      CLIENT_IP_MODE: 'cloudflare',
      TRUSTED_PROXY_CIDRS: '127.0.0.1/32,::1/128',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', chunk => logs.push(chunk.toString()));
  child.stderr.on('data', chunk => logs.push(chunk.toString()));
  // Kill, wait for exit, THEN remove the directory - all in one hook (node:test runs t.after()
  // hooks in registration order, so two separate hooks left kill-vs-rm order unspecified and
  // could race fs.rm against the child's own in-flight shutdown writes).
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGTERM');
    if (child.exitCode === null) await once(child, 'exit');
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const baseUrl = await waitForRealServer(child, logs);
  return { baseUrl, logs };
}

function connectWs(baseUrl, ip = '203.0.113.9') {
  return new WebSocket(`${baseUrl.replace('http://', 'ws://')}/ws`, {
    headers: { 'CF-Connecting-IP': ip },
  });
}

test('ws-admission spawned server: welcome arrives on /ws', async (t) => {
  const { baseUrl } = await spawnRealServer(t);
  const socket = connectWs(baseUrl);
  t.after(() => socket.close());
  const [welcomeBytes] = await once(socket, 'message');
  const welcome = JSON.parse(String(welcomeBytes));
  assert.equal(welcome.type, 'welcome');
  assert.equal(typeof welcome.viewerCount, 'number');
  assert.equal(Array.isArray(welcome.recentHistory), true);
});

test('ws-admission spawned server: connecting to / (not /ws) is rejected, no welcome', async (t) => {
  const { baseUrl } = await spawnRealServer(t);
  const socket = new WebSocket(baseUrl.replace('http://', 'ws://'), {
    headers: { 'CF-Connecting-IP': '203.0.113.10' },
  });
  const [err] = await once(socket, 'error');
  assert.match(String(err.message || err), /404|Unexpected server response/);
});

test('ws-admission spawned server: /api/admin/reset loops over `viewers` (Gate R1 F2) - an open socket gets 200 and receives {type: reset}', async (t) => {
  const { baseUrl } = await spawnRealServer(t);
  const socket = connectWs(baseUrl, '203.0.113.11');
  t.after(() => socket.close());
  await once(socket, 'message'); // welcome

  const resetMessage = once(socket, 'message').then(([data]) => JSON.parse(String(data)));
  const response = await fetch(`${baseUrl}/api/admin/reset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.12' },
    body: JSON.stringify({ secret: 'operator-secret' }),
  });
  assert.equal(response.status, 200);
  const resetFrame = await resetMessage;
  assert.equal(resetFrame.type, 'reset');
});

test('ws-admission spawned server (R1-W6): a message over 64 KiB closes with code 1009 on the real server (maxPayload is actually wired into WebSocket.Server)', { timeout: 5000 }, async (t) => {
  // The in-process unit test above ("64 KiB + 1 byte message -> close code 1009") builds its own
  // `wss` with an explicit maxPayload and can never catch server/index.js forgetting to pass one to
  // the REAL `new WebSocket.Server(...)` - `ws`'s own default there is 100 MiB. Only a real spawned
  // server exercises that wiring. `timeout` turns a regression into a clean failure instead of a
  // hang (a removed maxPayload never closes the socket, so the 'close' await would wait forever).
  const { baseUrl } = await spawnRealServer(t);
  const socket = connectWs(baseUrl, '203.0.113.13');
  t.after(() => socket.close());
  await once(socket, 'message'); // welcome

  const closed = once(socket, 'close');
  socket.send(Buffer.alloc(64 * 1024 + 1));
  const [code] = await closed;
  assert.equal(code, 1009);
});
