'use strict';

// WebSocket upgrade admission control.
//
// This module owns nothing about transport (the caller creates the `WebSocket.Server`
// with `noServer: true` and the desired `maxPayload`) and nothing about identity or rate
// storage (both are injected). Its only job is the fixed order of checks a raw HTTP
// upgrade must pass before `wss.handleUpgrade` is ever called, and the bookkeeping that
// lets every accepted or aborted socket release exactly the counters it reserved.

const WebSocket = require('ws');

const DEFAULT_WS_LIMITS = Object.freeze({
  path: '/ws',
  maxPayload: 64 * 1024,
  perIdentity: 5,
  global: 1000,
  maxBufferedBytes: 1024 * 1024,
});

const REASON_PHRASES = Object.freeze({
  403: 'Forbidden',
  404: 'Not Found',
  429: 'Too Many Requests',
  503: 'Service Unavailable',
});

// Writes a minimal, self-contained HTTP response on a still-writable socket, then
// destroys it. Never throws — a socket that already went away mid-write is not an error
// here, it is exactly the abort case the caller is guarding against.
function writeRejection(socket, status, body, retryAfterSeconds) {
  if (!socket || socket.destroyed) return;
  const reason = REASON_PHRASES[status] || 'Error';
  const payload = body != null ? String(body) : reason;
  const bodyBuf = Buffer.from(payload, 'utf8');
  let head =
    `HTTP/1.1 ${status} ${reason}\r\n` +
    'Connection: close\r\n' +
    'Content-Type: text/plain; charset=utf-8\r\n' +
    `Content-Length: ${bodyBuf.length}\r\n`;
  if (retryAfterSeconds != null) {
    head += `Retry-After: ${retryAfterSeconds}\r\n`;
  }
  head += '\r\n';
  try {
    if (socket.writable) socket.write(head + payload);
  } catch {
    // Socket already gone: nothing left to write to.
  }
  try {
    socket.destroy();
  } catch {
    // Already destroyed.
  }
}

const LOCALHOST_ORIGIN_PATTERN = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

function isLocalhostOrigin(origin) {
  return LOCALHOST_ORIGIN_PATTERN.test(origin);
}

// Absent Origin (non-browser clients) is allowed by design (D6): a non-browser client can
// forge any Origin, so this check only ever defends browsers. 'null' is always rejected,
// even when localhost origins are otherwise allowed.
function isOriginAllowed(origin, allowedOrigins, allowLocalhostOrigins) {
  if (origin === undefined || origin === null) return true;
  if (origin === 'null') return false;
  if (allowedOrigins && allowedOrigins.has(origin)) return true;
  if (allowLocalhostOrigins && isLocalhostOrigin(origin)) return true;
  return false;
}

function parsePathname(url) {
  try {
    return new URL(url, 'http://ws-admission.invalid').pathname;
  } catch {
    return null;
  }
}

function createWsAdmission({
  wss,
  resolveIdentity,
  consume,
  enforcement,
  allowedOrigins,
  allowLocalhostOrigins,
  limits = DEFAULT_WS_LIMITS,
  onAccepted,
  log = console.warn,
}) {
  const perKeyCounts = new Map();
  let total = 0;

  function reserve(key) {
    perKeyCounts.set(key, (perKeyCounts.get(key) || 0) + 1);
    total += 1;
  }

  function release(key) {
    const current = perKeyCounts.get(key) || 0;
    if (current <= 1) {
      perKeyCounts.delete(key);
    } else {
      perKeyCounts.set(key, current - 1);
    }
    total = total > 0 ? total - 1 : 0;
  }

  async function admit(req, socket, head, state) {
    const pathname = parsePathname(req.url);
    if (pathname !== limits.path) {
      writeRejection(socket, 404, 'Not Found');
      return;
    }

    const origin = req.headers && req.headers.origin;
    if (!isOriginAllowed(origin, allowedOrigins, allowLocalhostOrigins)) {
      writeRejection(socket, 403, 'Forbidden');
      return;
    }

    const identity = resolveIdentity(req);
    let key;
    if (identity && identity.ok) {
      key = identity.key;
    } else if (enforcement === 'enforce') {
      writeRejection(socket, 503, 'Client address could not be verified', 30);
      return;
    } else {
      const fallbackKey = identity && identity.fallbackKey;
      if (!fallbackKey) {
        // No usable fallback (e.g. reason 'invalid-peer': the socket address itself could not be
        // canonicalized) - even shadow mode has no key to count against here, so this is 503
        // regardless of the switch. Never fall through with `key === undefined`: that would put
        // every such connection in one shared, unbounded bucket instead of rejecting it.
        writeRejection(socket, 503, 'Client address could not be verified', 30);
        return;
      }
      key = fallbackKey;
      log('ws-admission: accepting upgrade without verified client identity (shadow mode)');
    }

    let consumeResult;
    try {
      consumeResult = await consume('ws-upgrade', key);
    } catch {
      writeRejection(socket, 503, 'Service temporarily unavailable', 30);
      return;
    }

    if (!consumeResult || !consumeResult.allowed) {
      const retryAfterSeconds = (consumeResult && consumeResult.retryAfterSeconds) || 30;
      writeRejection(socket, 429, 'Too many upgrade attempts', retryAfterSeconds);
      return;
    }

    // The upgrade rate check above awaits; the socket may have been aborted (FIN or RST)
    // while it was pending. The close listener attached synchronously at the very top of
    // handleUpgrade already recorded that in `state.aborted`. Checking it here — before any
    // counter is reserved — is what keeps an aborted upgrade from ever leaking a counter.
    if (state.aborted || socket.destroyed || !socket.readable) {
      try {
        socket.destroy();
      } catch {
        // Already gone.
      }
      return;
    }

    const currentForKey = perKeyCounts.get(key) || 0;
    if (currentForKey >= limits.perIdentity) {
      if (enforcement === 'enforce') {
        writeRejection(socket, 429, 'Too many connections for this address');
        return;
      }
      log('ws-admission: per-identity socket cap exceeded (shadow mode), allowing');
    }

    // The global cap is always enforced, independent of the shadow switch (§6 residuals):
    // the WS welcome cost is bounded only by this cap when the identity-based controls are
    // shadowable.
    if (total >= limits.global) {
      writeRejection(socket, 503, 'Server is at capacity', 30);
      return;
    }

    state.key = key;
    state.reserved = true;
    reserve(key);

    wss.handleUpgrade(req, socket, head, (ws) => {
      onAccepted(ws, req);
    });
  }

  function handleUpgrade(req, socket, head) {
    const state = { aborted: false, reserved: false, released: false, key: null };

    const onClose = () => {
      state.aborted = true;
      if (state.reserved && !state.released) {
        state.released = true;
        release(state.key);
      }
    };

    // Attached synchronously, before any async work starts: an abort (FIN or RST) that
    // arrives while a later `await` is pending must still be observed.
    socket.on('error', () => {});
    socket.once('close', onClose);

    admit(req, socket, head, state).catch(() => {
      try {
        if (!socket.destroyed) socket.destroy();
      } catch {
        // Already gone.
      }
    });
  }

  function stats() {
    return { total, perKey: Object.fromEntries(perKeyCounts) };
  }

  return { handleUpgrade, stats };
}

// Returns false and terminates the socket (dropping the message) when the outgoing buffer
// is already past `maxBufferedBytes`, instead of piling more data onto a slow or dead peer.
// Only ever sends while the socket is OPEN.
function sendWithBackpressure(ws, message, maxBufferedBytes) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;

  if (ws.bufferedAmount > maxBufferedBytes) {
    try {
      ws.terminate();
    } catch {
      // Already gone.
    }
    return false;
  }

  try {
    ws.send(message);
    return true;
  } catch {
    try {
      ws.terminate();
    } catch {
      // Already gone.
    }
    return false;
  }
}

module.exports = { createWsAdmission, sendWithBackpressure, DEFAULT_WS_LIMITS };
