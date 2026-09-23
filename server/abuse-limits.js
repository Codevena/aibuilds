'use strict';

// Per-endpoint abuse limits (§3 of
// docs/superpowers/plans/2026-09-23-abuse-authz-hardening.md), wired on top of a single client
// identity (server/client-ip.js) and a single bounded store (server/rate-limit-store.js).
//
// D3 shadow switch: under `ABUSE_ENFORCEMENT=shadow`, a request without verified provenance is
// never rejected for that reason alone - EVERY policy, including `write`/`admin`/`challenge`
// (`shadowable: false`), falls through and counts against the fallback peer key instead of 503ing.
// What `shadowable: false` still means is narrower: once that policy's own real bucket (fallback
// or verified) is exhausted, it keeps rejecting via the normal 429/503 path regardless of the
// switch - only a `shadowable: true` policy never rejects once its limit is hit under shadow (it
// counts the hit as `shadowWouldReject` and logs an aggregate instead).

const rateLimit = require('express-rate-limit');
const { BoundedMemoryStore } = require('./rate-limit-store');

const ONE_MINUTE_MS = 60_000;
const ONE_HOUR_MS = 60 * ONE_MINUTE_MS;

function policy({ windowMs, max, failureClass, shadowable }) {
  return Object.freeze({ windowMs, max, failureClass, shadowable });
}

// Names exactly as in §3 of the plan.
const POLICIES = Object.freeze({
  write: policy({ windowMs: ONE_MINUTE_MS, max: 30, failureClass: 'closed', shadowable: false }),
  admin: policy({ windowMs: ONE_MINUTE_MS, max: 5, failureClass: 'closed', shadowable: false }),
  challenge: policy({ windowMs: ONE_MINUTE_MS, max: 60, failureClass: 'closed', shadowable: false }),
  guestbook: policy({ windowMs: ONE_MINUTE_MS, max: 6, failureClass: 'closed', shadowable: true }),
  profile: policy({ windowMs: ONE_MINUTE_MS, max: 6, failureClass: 'closed', shadowable: true }),
  vote: policy({ windowMs: ONE_MINUTE_MS, max: 12, failureClass: 'closed', shadowable: true }),
  reaction: policy({ windowMs: ONE_MINUTE_MS, max: 20, failureClass: 'closed', shadowable: true }),
  'comment-contribution': policy({
    windowMs: ONE_MINUTE_MS, max: 10, failureClass: 'closed', shadowable: true,
  }),
  'comment-file': policy({
    windowMs: ONE_MINUTE_MS, max: 10, failureClass: 'closed', shadowable: true,
  }),
  'contribute-minute': policy({
    windowMs: ONE_MINUTE_MS, max: 6, failureClass: 'closed', shadowable: true,
  }),
  'contribute-hour': policy({
    windowMs: ONE_HOUR_MS, max: 30, failureClass: 'closed', shadowable: true,
  }),
  diff: policy({ windowMs: ONE_MINUTE_MS, max: 10, failureClass: 'open', shadowable: true }),
  read: policy({ windowMs: ONE_MINUTE_MS, max: 60, failureClass: 'open', shadowable: true }),
  'ws-upgrade': policy({ windowMs: ONE_MINUTE_MS, max: 20, failureClass: 'closed', shadowable: true }),
});

const MESSAGES = Object.freeze({
  write: 'Too many contributions. Please wait a moment.',
  admin: 'Too many requests. Please wait.',
  challenge: 'Too many challenge requests. Please wait.',
});
const DEFAULT_MESSAGE = 'Too many requests. Please slow down.';

function messageFor(name) {
  return MESSAGES[name] || DEFAULT_MESSAGE;
}

function requirePolicy(name) {
  const found = POLICIES[name];
  if (!found) throw new Error(`Unknown abuse policy: ${name}`);
  return found;
}

function respondProvenanceFailure(res) {
  res.status(503).set('Retry-After', '30').json({ error: 'Client address could not be verified' });
}

function respondStoreFailure(res) {
  res.status(503).set('Retry-After', '30').json({ error: 'Rate limiter unavailable' });
}

function emptyStats() {
  return { rejected: 0, shadowWouldReject: 0, provenanceFailures: {} };
}

function createAbuseLimits({
  resolver,
  config,
  storeFactory = () => new BoundedMemoryStore(),
  log = console.warn,
  now = Date.now,
}) {
  if (!resolver || typeof resolver.resolve !== 'function') {
    throw new Error('createAbuseLimits requires a resolver with a resolve(req) method');
  }
  if (!config) {
    throw new Error('createAbuseLimits requires a config');
  }

  const stores = new Map();
  const stats = new Map();
  const middlewares = new Map();

  function getStore(name) {
    if (!stores.has(name)) stores.set(name, storeFactory(name));
    return stores.get(name);
  }

  function getStats(name) {
    if (!stats.has(name)) stats.set(name, emptyStats());
    return stats.get(name);
  }

  function recordProvenanceFailure(policyStats, reason) {
    policyStats.provenanceFailures[reason] = (policyStats.provenanceFailures[reason] || 0) + 1;
  }

  // Resolved once per request (Gate R1 F12) and cached on req.abuseIdentity.
  function resolveIdentity(req) {
    if (req.abuseIdentity) return req.abuseIdentity;
    const result = resolver.resolve(req);
    let ident;
    if (result.ok) {
      ident = {
        key: result.key, ip: result.ip, provenance: 'verified', reason: null,
      };
    } else if (config.enforcement === 'shadow' && result.fallbackKey) {
      ident = {
        key: result.fallbackKey, ip: null, provenance: 'shadow-fallback', reason: result.reason,
      };
    } else {
      ident = {
        key: null, ip: null, provenance: 'none', reason: result.reason,
      };
    }
    req.abuseIdentity = ident;
    return ident;
  }

  // Canonical exact IP (not /64) for bans / agentIps; null when provenance is not verified.
  function identity(req) {
    const ident = resolveIdentity(req);
    return ident.provenance === 'verified' ? ident.ip : null;
  }

  function limit(name) {
    if (middlewares.has(name)) return middlewares.get(name);
    const policyDef = requirePolicy(name);
    const store = getStore(name);
    const policyStats = getStats(name);

    // §3: every limiter key is namespaced `aibuilds:rl:v1:<policy>:<identity>` - each policy has
    // its own store today (so a bare identity could not collide across policies either), but the
    // namespace is what keeps that true once D4's shared Redis/Valkey store lands and every policy
    // shares one keyspace. consume() below uses the identical namespacing for WS upgrades.
    const namespacedKey = (identityKey) => `aibuilds:rl:v1:${name}:${identityKey}`;

    const erlInstance = rateLimit({
      windowMs: policyDef.windowMs,
      max: policyDef.max,
      store,
      standardHeaders: true,
      legacyHeaders: false,
      passOnStoreError: false,
      validate: { xForwardedForHeader: false },
      keyGenerator: (req) => namespacedKey(req.abuseIdentity.key),
      handler: (req, res, handlerNext) => {
        if (policyDef.shadowable && config.enforcement === 'shadow') {
          policyStats.shadowWouldReject += 1;
          handlerNext();
          return;
        }
        policyStats.rejected += 1;
        res.status(429).json({ error: messageFor(name) });
      },
    });

    function middleware(req, res, next) {
      const ident = resolveIdentity(req);
      // A policy that isn't shadowable is always enforced for erl's own reject-at-max decision
      // (see the `handler` above, which only bypasses rejection for a *shadowable* policy) - but
      // whether an UNVERIFIED request gets a chance to reach erl at all is decided on the GLOBAL
      // switch, not on this policy's own shadowable flag (Gate R1-C1). Before the fix this used
      // `policyDef.shadowable ? config.enforcement : 'enforce'` here too, which meant `write`,
      // `admin` and `challenge` (shadowable:false) could NEVER fall back to the peer key - so
      // under shadow, with the exact broken header chain shadow exists to tolerate, every PoW
      // route (every one starts with `write`) and `/api/challenge` 503'd on every single request:
      // a production write outage, not a shadow window.
      const effectiveEnforcement = policyDef.shadowable ? config.enforcement : 'enforce';

      if (ident.provenance !== 'verified') {
        recordProvenanceFailure(policyStats, ident.reason);
        const canShadowFallback = config.enforcement === 'shadow' && Boolean(ident.key);
        if (!canShadowFallback) {
          if (policyDef.failureClass === 'closed') {
            respondProvenanceFailure(res);
          } else {
            next();
          }
          return;
        }
        // Shadow mode and a usable fallback key: fall through and count against the fallback
        // bucket for EVERY policy, including write/admin/challenge - a non-shadowable policy still
        // rejects once that fallback bucket hits its own real max (the erl `handler` above decides
        // that per-policy, not this gate). Never reached when config.enforcement is 'enforce'
        // (canShadowFallback is false there), so enforce-mode behavior is unchanged.
      }

      erlInstance(req, res, (err) => {
        if (!err) {
          next();
          return;
        }
        if (effectiveEnforcement === 'shadow') {
          log(`[abuse] store error on policy ${name} (shadow, not rejecting): ${err.message}`);
          next();
          return;
        }
        if (policyDef.failureClass === 'closed') {
          respondStoreFailure(res);
        } else {
          next();
        }
      });
    }

    middlewares.set(name, middleware);
    return middleware;
  }

  function chain(...names) {
    return names.map(name => limit(name));
  }

  const routes = Object.freeze({
    write: [limit('write')],
    admin: [limit('admin')],
    challenge: [limit('challenge')],
    guestbook: chain('write', 'guestbook'),
    profile: chain('write', 'profile'),
    vote: chain('write', 'vote'),
    reaction: chain('write', 'reaction'),
    commentContribution: chain('write', 'comment-contribution'),
    commentFile: chain('write', 'comment-file'),
    contribute: chain('write', 'contribute-minute', 'contribute-hour'),
    chaos: chain('write', 'admin'),
    diff: [limit('diff')],
    read: [limit('read')],
  });

  // Non-Express entry point for callers that resolve their own key (WS upgrades - T6).
  async function consume(name, key) {
    const policyDef = requirePolicy(name);
    const store = getStore(name);
    const policyStats = getStats(name);

    const result = await store.increment(`aibuilds:rl:v1:${name}:${key}`); // throws propagate to the caller
    if (result.totalHits <= policyDef.max) {
      return { allowed: true, retryAfterSeconds: undefined };
    }
    if (policyDef.shadowable && config.enforcement === 'shadow') {
      policyStats.shadowWouldReject += 1;
      return { allowed: true, retryAfterSeconds: undefined };
    }
    policyStats.rejected += 1;
    const resetAtMs = result.resetTime ? result.resetTime.getTime() : now() + policyDef.windowMs;
    const retryAfterSeconds = Math.max(1, Math.ceil((resetAtMs - now()) / 1000));
    return { allowed: false, retryAfterSeconds };
  }

  // Aggregate only - never keys or IPs.
  function counters() {
    return Object.keys(POLICIES).map((name) => {
      const policyStats = stats.get(name) || emptyStats();
      return {
        policy: name,
        rejected: policyStats.rejected,
        shadowWouldReject: policyStats.shadowWouldReject,
        provenanceFailures: { ...policyStats.provenanceFailures },
      };
    });
  }

  function resetCounters() {
    for (const name of Object.keys(POLICIES)) {
      stats.set(name, emptyStats());
    }
  }

  let counterLogTimer = null;

  function startCounterLog(intervalMs) {
    stopCounterLog();
    counterLogTimer = setInterval(() => {
      for (const entry of counters()) {
        const hasActivity = entry.rejected > 0
          || entry.shadowWouldReject > 0
          || Object.keys(entry.provenanceFailures).length > 0;
        if (hasActivity) {
          log(
            `[abuse] policy=${entry.policy} rejected=${entry.rejected} `
            + `shadowWouldReject=${entry.shadowWouldReject} `
            + `provenanceFailures=${JSON.stringify(entry.provenanceFailures)}`,
          );
        }
      }
      resetCounters();
    }, intervalMs);
    if (counterLogTimer.unref) counterLogTimer.unref();
  }

  function stopCounterLog() {
    if (counterLogTimer) {
      clearInterval(counterLogTimer);
      counterLogTimer = null;
    }
  }

  return {
    policies: POLICIES,
    limit,
    chain,
    routes,
    identity,
    consume,
    counters,
    startCounterLog,
    stopCounterLog,
  };
}

module.exports = { POLICIES, createAbuseLimits };
