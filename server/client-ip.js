'use strict';

// Single source of client identity for the whole server (Security invariant I4).
// Untrusted X-Forwarded-For / X-Real-IP / Forwarded / CF-Connecting-IP never become an identity
// unless the request came from a peer we explicitly trust (cloudflare mode) - see D2 in
// docs/superpowers/plans/2026-09-23-abuse-authz-hardening.md.

const net = require('node:net');

const FORWARDED_HEADER_NAMES = ['cf-connecting-ip', 'x-forwarded-for', 'x-real-ip', 'forwarded'];

function hasForwardedHeaders(headers) {
  return FORWARDED_HEADER_NAMES.some(name => headers[name] !== undefined);
}

// Expands a syntactically valid (net.isIP === 6) IPv6 string into its 8 hextet groups,
// resolving a single '::' run. Assumes the input has already passed net.isIP.
function expandIPv6Groups(ip) {
  const doubleColonIndex = ip.indexOf('::');
  if (doubleColonIndex === -1) {
    return ip.split(':');
  }
  const head = ip.slice(0, doubleColonIndex);
  const tail = ip.slice(doubleColonIndex + 2);
  const headParts = head ? head.split(':').filter(Boolean) : [];
  const tailParts = tail ? tail.split(':').filter(Boolean) : [];
  const missing = 8 - headParts.length - tailParts.length;
  const middle = new Array(Math.max(missing, 0)).fill('0');
  return [...headParts, ...middle, ...tailParts];
}

function stripLeadingZeros(group) {
  const stripped = group.replace(/^0+(?=.)/, '');
  return stripped === '' ? '0' : stripped;
}

// '::ffff:1.2.3.4' -> '1.2.3.4'; IPv6 -> lowercase, fully compressed; null if invalid.
function canonicalIp(value) {
  if (typeof value !== 'string' || value === '') return null;
  if (value.trim() !== value) return null;

  const family = net.isIP(value);
  if (family === 4) return value;
  if (family !== 6) return null;
  if (value.includes('%')) return null; // zone IDs are not a client identity

  const mappedMatch = value.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
  if (mappedMatch && net.isIP(mappedMatch[1]) === 4) {
    return mappedMatch[1];
  }

  const groups = expandIPv6Groups(value.toLowerCase());
  if (groups.length !== 8) return null;
  const normalized = groups.map(group => stripLeadingZeros(group === '' ? '0' : group));

  let bestStart = -1;
  let bestLen = 0;
  let curStart = -1;
  let curLen = 0;
  for (let i = 0; i < normalized.length; i += 1) {
    if (normalized[i] === '0') {
      if (curStart === -1) curStart = i;
      curLen += 1;
      if (curLen > bestLen) {
        bestLen = curLen;
        bestStart = curStart;
      }
    } else {
      curStart = -1;
      curLen = 0;
    }
  }

  if (bestLen > 1) {
    const before = normalized.slice(0, bestStart);
    const after = normalized.slice(bestStart + bestLen);
    return `${before.join(':')}::${after.join(':')}`;
  }
  return normalized.join(':');
}

// IPv4 -> ip; IPv6 -> first 4 hextets + '::/64'.
function limiterKey(ip) {
  if (typeof ip !== 'string' || ip === '') return null;
  const family = net.isIP(ip);
  if (family === 4) return ip;
  if (family !== 6) return null;
  const groups = expandIPv6Groups(ip.toLowerCase()).map(stripLeadingZeros);
  if (groups.length !== 8) return null;
  return `${groups.slice(0, 4).join(':')}::/64`;
}

function parseCidr(cidr) {
  const parts = String(cidr).split('/');
  if (parts.length !== 2) {
    throw new Error(`Invalid TRUSTED_PROXY_CIDRS entry: ${cidr}`);
  }
  const [ip, prefixText] = parts;
  const family = net.isIP(ip);
  if (family === 0) {
    throw new Error(`Invalid TRUSTED_PROXY_CIDRS entry: ${cidr}`);
  }
  if (!/^\d+$/.test(prefixText)) {
    throw new Error(`Invalid TRUSTED_PROXY_CIDRS entry: ${cidr}`);
  }
  const prefix = Number(prefixText);
  const maxPrefix = family === 4 ? 32 : 128;
  // /0 is rejected: a trusted-proxy CIDR that matches every address defeats the peer check.
  if (prefix <= 0 || prefix > maxPrefix) {
    throw new Error(`Invalid TRUSTED_PROXY_CIDRS entry: ${cidr}`);
  }
  return { ip, prefix, family };
}

function isValidOrigin(origin) {
  let url;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (url.username || url.password) return false;
  if (url.search || url.hash) return false;
  if (url.pathname !== '/' && url.pathname !== '') return false;
  const rebuilt = `${url.protocol}//${url.host}`;
  return rebuilt === origin || `${rebuilt}/` === origin;
}

// isValidOrigin() accepts a configured entry with one trailing slash (a common operator typo,
// e.g. copy-pasting a URL bar's value), but a browser's Origin header never has a trailing slash -
// an unnormalized entry would pass validation yet never match the exact Set lookup in
// ws-admission.js's isOriginAllowed() (INFO h). Store the canonical `protocol//host` form always.
function normalizedOrigin(origin) {
  const url = new URL(origin);
  return `${url.protocol}//${url.host}`;
}

function parseWsAllowedOrigins(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const origins = String(raw).split(',').map(entry => entry.trim()).filter(Boolean);
  if (origins.length === 0) return null;
  for (const origin of origins) {
    if (!isValidOrigin(origin)) {
      throw new Error(`Invalid WS_ALLOWED_ORIGINS entry: ${origin}`);
    }
  }
  return Object.freeze(origins.map(normalizedOrigin));
}

// Throws on invalid config; returns a frozen configuration object. Never logs itself - the
// caller decides whether/how to surface `productionWarning`.
function parseClientIpConfig(env) {
  const source = env || {};

  const mode = source.CLIENT_IP_MODE === undefined ? 'direct' : source.CLIENT_IP_MODE;
  if (mode !== 'direct' && mode !== 'cloudflare') {
    throw new Error(`Invalid CLIENT_IP_MODE: ${source.CLIENT_IP_MODE}`);
  }

  const enforcement = source.ABUSE_ENFORCEMENT === undefined ? 'enforce' : source.ABUSE_ENFORCEMENT;
  if (enforcement !== 'enforce' && enforcement !== 'shadow') {
    throw new Error(`Invalid ABUSE_ENFORCEMENT: ${source.ABUSE_ENFORCEMENT}`);
  }

  let trustedProxies = [];
  if (mode === 'cloudflare') {
    const raw = source.TRUSTED_PROXY_CIDRS;
    if (typeof raw !== 'string' || raw.trim() === '') {
      throw new Error('TRUSTED_PROXY_CIDRS is required and must be non-empty in cloudflare mode');
    }
    trustedProxies = raw.split(',').map(entry => entry.trim()).filter(Boolean);
    if (trustedProxies.length === 0) {
      throw new Error('TRUSTED_PROXY_CIDRS is required and must be non-empty in cloudflare mode');
    }
    for (const cidr of trustedProxies) {
      parseCidr(cidr); // throws on invalid format, out-of-range prefix, or /0
    }
  }

  const wsAllowedOrigins = parseWsAllowedOrigins(source.WS_ALLOWED_ORIGINS);
  const productionWarning = source.NODE_ENV === 'production' && source.CLIENT_IP_MODE === undefined;

  return Object.freeze({
    mode,
    trustedProxies: Object.freeze(trustedProxies),
    enforcement,
    wsAllowedOrigins,
    productionWarning,
  });
}

function isValidSingleIpHeaderValue(value) {
  if (typeof value !== 'string' || value === '') return false;
  if (value.includes(',')) return false;
  if (/\s/.test(value)) return false;
  if (value.includes('%')) return false;
  return net.isIP(value) !== 0;
}

// resolve(req) -> { ok:true, ip, key, family } | { ok:false, reason, fallbackKey }
function createClientIpResolver(config) {
  let trustedBlockList = null;
  if (config.mode === 'cloudflare') {
    trustedBlockList = new net.BlockList();
    for (const cidr of config.trustedProxies) {
      const { ip, prefix, family } = parseCidr(cidr);
      trustedBlockList.addSubnet(ip, prefix, family === 4 ? 'ipv4' : 'ipv6');
    }
  }

  function resolve(req) {
    const headers = (req && req.headers) || {};
    const socketAddress = req && req.socket && req.socket.remoteAddress;
    const canonicalPeer = canonicalIp(socketAddress);

    if (!canonicalPeer) {
      return { ok: false, reason: 'invalid-peer', fallbackKey: null };
    }
    const fallbackKey = `peer:${limiterKey(canonicalPeer)}`;

    if (config.mode === 'direct') {
      if (hasForwardedHeaders(headers)) {
        return { ok: false, reason: 'forwarded-header-in-direct-mode', fallbackKey };
      }
      return {
        ok: true,
        ip: canonicalPeer,
        key: limiterKey(canonicalPeer),
        family: net.isIP(canonicalPeer),
      };
    }

    // cloudflare mode
    const peerFamily = net.isIP(canonicalPeer);
    const isTrustedPeer = trustedBlockList.check(canonicalPeer, peerFamily === 4 ? 'ipv4' : 'ipv6');
    if (!isTrustedPeer) {
      return { ok: false, reason: 'untrusted-peer', fallbackKey };
    }

    const cfHeader = headers['cf-connecting-ip'];
    if (cfHeader === undefined) {
      return { ok: false, reason: 'missing-cf-header', fallbackKey };
    }
    if (!isValidSingleIpHeaderValue(cfHeader)) {
      return { ok: false, reason: 'invalid-cf-header', fallbackKey };
    }
    const canonicalClientIp = canonicalIp(cfHeader);
    if (!canonicalClientIp) {
      return { ok: false, reason: 'invalid-cf-header', fallbackKey };
    }

    return {
      ok: true,
      ip: canonicalClientIp,
      key: limiterKey(canonicalClientIp),
      family: net.isIP(canonicalClientIp),
    };
  }

  return { resolve };
}

module.exports = {
  parseClientIpConfig,
  createClientIpResolver,
  canonicalIp,
  limiterKey,
};
