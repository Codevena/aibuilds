'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseClientIpConfig,
  createClientIpResolver,
  canonicalIp,
  limiterKey,
} = require('../server/client-ip');

function fakeReq({ remoteAddress, headers = {} } = {}) {
  return { socket: { remoteAddress }, headers };
}

function directConfig(overrides = {}) {
  return parseClientIpConfig({ CLIENT_IP_MODE: 'direct', ABUSE_ENFORCEMENT: 'enforce', ...overrides });
}

function cloudflareConfig(overrides = {}) {
  return parseClientIpConfig({
    CLIENT_IP_MODE: 'cloudflare',
    ABUSE_ENFORCEMENT: 'enforce',
    TRUSTED_PROXY_CIDRS: '127.0.0.1/32,::1/128',
    ...overrides,
  });
}

// --- canonicalIp -----------------------------------------------------------

test('canonicalIp: IPv4-mapped IPv6 canonicalizes to IPv4 (with -> without canonicalization)', () => {
  assert.equal(canonicalIp('::ffff:1.2.3.4'), '1.2.3.4');
  assert.equal(canonicalIp('1.2.3.4'), '1.2.3.4');
});

test('canonicalIp: IPv6 lowercased and fully compressed', () => {
  assert.equal(canonicalIp('2001:DB8:1:2:3:4:5:6'), '2001:db8:1:2:3:4:5:6');
  assert.equal(canonicalIp('2001:0DB8:0000:0000:0000:0000:0000:0001'), '2001:db8::1');
  assert.equal(canonicalIp('::1'), '::1');
});

test('canonicalIp: invalid input returns null', () => {
  assert.equal(canonicalIp('not-an-ip'), null);
  assert.equal(canonicalIp(''), null);
  assert.equal(canonicalIp(null), null);
  assert.equal(canonicalIp(undefined), null);
  assert.equal(canonicalIp('999.1.1.1'), null);
  assert.equal(canonicalIp('fe80::1%eth0'), null);
  assert.equal(canonicalIp(' 1.2.3.4'), null);
});

// --- limiterKey --------------------------------------------------------------

test('limiterKey: IPv4 maps to itself, IPv6 maps to /64 prefix', () => {
  assert.equal(limiterKey('1.2.3.4'), '1.2.3.4');
  assert.equal(limiterKey('2001:db8:1:2:3:4:5:6'), '2001:db8:1:2::/64');
});

test('limiterKey: shared vs distinct /64 buckets', () => {
  const a = limiterKey('2001:db8:1:2::9');
  const b = limiterKey('2001:db8:1:2:ffff::1');
  const c = limiterKey('2001:db8:1:3::1');
  assert.equal(a, b, 'addresses in the same /64 must share a key');
  assert.notEqual(a, c, 'addresses in a different /64 must not share a key');
});

// --- parseClientIpConfig -----------------------------------------------------

test('parseClientIpConfig: direct mode is the default', () => {
  const config = parseClientIpConfig({});
  assert.equal(config.mode, 'direct');
  assert.equal(config.enforcement, 'enforce');
  assert.deepEqual(config.trustedProxies, []);
  assert.equal(config.wsAllowedOrigins, null);
  assert.equal(Object.isFrozen(config), true);
});

test('parseClientIpConfig: productionWarning true only when NODE_ENV=production and CLIENT_IP_MODE unset', () => {
  assert.equal(parseClientIpConfig({ NODE_ENV: 'production' }).productionWarning, true);
  assert.equal(parseClientIpConfig({ NODE_ENV: 'production', CLIENT_IP_MODE: 'direct' }).productionWarning, false);
  assert.equal(parseClientIpConfig({ NODE_ENV: 'development' }).productionWarning, false);
});

test('parseClientIpConfig: does not log anything itself', () => {
  const original = console.warn;
  let called = false;
  console.warn = () => { called = true; };
  try {
    parseClientIpConfig({ NODE_ENV: 'production' });
  } finally {
    console.warn = original;
  }
  assert.equal(called, false);
});

test('parseClientIpConfig: cloudflare mode requires non-empty TRUSTED_PROXY_CIDRS', () => {
  assert.throws(() => parseClientIpConfig({ CLIENT_IP_MODE: 'cloudflare' }));
  assert.throws(() => parseClientIpConfig({ CLIENT_IP_MODE: 'cloudflare', TRUSTED_PROXY_CIDRS: '' }));
  assert.throws(() => parseClientIpConfig({ CLIENT_IP_MODE: 'cloudflare', TRUSTED_PROXY_CIDRS: '   ' }));
});

test('parseClientIpConfig: rejects invalid CIDR entries, /0, unknown mode/enforcement', () => {
  assert.throws(() => parseClientIpConfig({ CLIENT_IP_MODE: 'cloudflare', TRUSTED_PROXY_CIDRS: '0.0.0.0/0' }));
  assert.throws(() => parseClientIpConfig({ CLIENT_IP_MODE: 'cloudflare', TRUSTED_PROXY_CIDRS: '::/0' }));
  assert.throws(() => parseClientIpConfig({ CLIENT_IP_MODE: 'cloudflare', TRUSTED_PROXY_CIDRS: '1.2.3.4/33' }));
  assert.throws(() => parseClientIpConfig({ CLIENT_IP_MODE: 'cloudflare', TRUSTED_PROXY_CIDRS: 'garbage' }));
  assert.throws(() => parseClientIpConfig({ CLIENT_IP_MODE: 'weird' }));
  assert.throws(() => parseClientIpConfig({ ABUSE_ENFORCEMENT: 'weird' }));
});

test('parseClientIpConfig: accepts a valid comma list of CIDRs', () => {
  const config = cloudflareConfig();
  assert.deepEqual(config.trustedProxies, ['127.0.0.1/32', '::1/128']);
  assert.equal(Object.isFrozen(config.trustedProxies), true);
});

test('parseClientIpConfig: WS_ALLOWED_ORIGINS parses to a frozen array or null when unset', () => {
  assert.equal(parseClientIpConfig({}).wsAllowedOrigins, null);
  const config = parseClientIpConfig({ WS_ALLOWED_ORIGINS: 'https://aibuilds.dev,https://www.aibuilds.dev' });
  assert.deepEqual(config.wsAllowedOrigins, ['https://aibuilds.dev', 'https://www.aibuilds.dev']);
  assert.equal(Object.isFrozen(config.wsAllowedOrigins), true);
  assert.throws(() => parseClientIpConfig({ WS_ALLOWED_ORIGINS: 'not-an-origin' }));
  assert.throws(() => parseClientIpConfig({ WS_ALLOWED_ORIGINS: 'https://aibuilds.dev/path' }));
});

test('parseClientIpConfig (INFO h): a WS_ALLOWED_ORIGINS entry with a trailing slash is normalized so it matches a real browser Origin header (with -> without normalization)', () => {
  const config = parseClientIpConfig({ WS_ALLOWED_ORIGINS: 'https://aibuilds.dev/,https://www.aibuilds.dev' });
  // A browser's Origin header never carries a trailing slash - without normalization the stored
  // entry would be 'https://aibuilds.dev/' and an exact Set lookup against 'https://aibuilds.dev'
  // (ws-admission.js's isOriginAllowed) would silently never match.
  assert.deepEqual(config.wsAllowedOrigins, ['https://aibuilds.dev', 'https://www.aibuilds.dev']);
});

// --- createClientIpResolver: direct mode ------------------------------------

test('direct mode: socket IPv4 resolves to itself', () => {
  const resolver = createClientIpResolver(directConfig());
  const result = resolver.resolve(fakeReq({ remoteAddress: '1.2.3.4' }));
  assert.deepEqual(result, { ok: true, ip: '1.2.3.4', key: '1.2.3.4', family: 4 });
});

test('direct mode: socket IPv4-mapped IPv6 canonicalizes to IPv4 (with -> without canonicalization)', () => {
  const resolver = createClientIpResolver(directConfig());
  const result = resolver.resolve(fakeReq({ remoteAddress: '::ffff:1.2.3.4' }));
  assert.equal(result.ok, true);
  assert.equal(result.ip, '1.2.3.4');
  assert.equal(result.key, '1.2.3.4');
  // without canonicalization this would be '::ffff:1.2.3.4' and would not equal the plain form
  assert.notEqual(result.ip, '::ffff:1.2.3.4');
});

test('direct mode: forwarded headers are a provenance failure (mutation guard: detector removed -> ok:true)', () => {
  const resolver = createClientIpResolver(directConfig());
  const cases = [
    { 'x-forwarded-for': '9.9.9.9' },
    { 'x-real-ip': '9.9.9.9' },
    { 'cf-connecting-ip': '9.9.9.9' },
    { forwarded: 'for=9.9.9.9' },
  ];
  for (const headers of cases) {
    const result = resolver.resolve(fakeReq({ remoteAddress: '1.2.3.4', headers }));
    assert.equal(result.ok, false, JSON.stringify(headers));
    assert.equal(result.reason, 'forwarded-header-in-direct-mode');
    assert.equal(result.fallbackKey, 'peer:1.2.3.4');
  }
  // WITHOUT the detector, the same requests would resolve ok:true with the socket IP -
  // this is exactly the behaviour a removed detector would produce (guarded by the loop above).
  const clean = resolver.resolve(fakeReq({ remoteAddress: '1.2.3.4', headers: {} }));
  assert.equal(clean.ok, true);
  assert.equal(clean.ip, '1.2.3.4');
});

test('direct mode: invalid socket address resolves invalid-peer with null fallbackKey', () => {
  const resolver = createClientIpResolver(directConfig());
  const result = resolver.resolve(fakeReq({ remoteAddress: 'not-an-ip' }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'invalid-peer');
  assert.equal(result.fallbackKey, null);
});

// --- createClientIpResolver: cloudflare mode --------------------------------

test('cloudflare mode: trusted peer with a valid CF-Connecting-IP resolves to that IP', () => {
  const resolver = createClientIpResolver(cloudflareConfig());
  const result = resolver.resolve(fakeReq({
    remoteAddress: '127.0.0.1',
    headers: { 'cf-connecting-ip': '203.0.113.9' },
  }));
  assert.deepEqual(result, { ok: true, ip: '203.0.113.9', key: '203.0.113.9', family: 4 });
});

test('cloudflare mode: untrusted peer with CF header is untrusted-peer (mutation guard: without peer check the spoof succeeds)', () => {
  const resolver = createClientIpResolver(cloudflareConfig());
  const result = resolver.resolve(fakeReq({
    remoteAddress: '198.51.100.7',
    headers: { 'cf-connecting-ip': '203.0.113.9' },
  }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'untrusted-peer');
  // WITHOUT the peer check, the spoofed IP 203.0.113.9 would be trusted - that is the regression
  // this test guards; the assertion above (ok:false) is what turns red under that mutation.
});

test('cloudflare mode: XFF from a trusted peer never overrides CF-Connecting-IP (mutation guard: XFF read instead of CF)', () => {
  const resolver = createClientIpResolver(cloudflareConfig());
  const result = resolver.resolve(fakeReq({
    remoteAddress: '127.0.0.1',
    headers: { 'cf-connecting-ip': '203.0.113.9', 'x-forwarded-for': '1.1.1.1' },
  }));
  assert.equal(result.ok, true);
  assert.equal(result.ip, '203.0.113.9');
  // WITHOUT reading CF first, and reading XFF instead, this would resolve to '1.1.1.1'.
  assert.notEqual(result.ip, '1.1.1.1');

  const multi = resolver.resolve(fakeReq({
    remoteAddress: '127.0.0.1',
    headers: { 'cf-connecting-ip': '203.0.113.9', 'x-forwarded-for': '1.1.1.1, 2.2.2.2' },
  }));
  assert.equal(multi.ip, '203.0.113.9');
});

test('cloudflare mode: missing CF header is missing-cf-header', () => {
  const resolver = createClientIpResolver(cloudflareConfig());
  const result = resolver.resolve(fakeReq({ remoteAddress: '127.0.0.1', headers: {} }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'missing-cf-header');
});

test('cloudflare mode: invalid CF header formats are invalid-cf-header', () => {
  const resolver = createClientIpResolver(cloudflareConfig());
  const invalidValues = [
    '1.2.3.4, 5.6.7.8',
    ' 1.2.3.4',
    '1.2.3',
    '999.1.1.1',
    'fe80::1%eth0',
    'abc',
    '',
    ['1.2.3.4'],
  ];
  for (const value of invalidValues) {
    const result = resolver.resolve(fakeReq({
      remoteAddress: '127.0.0.1',
      headers: { 'cf-connecting-ip': value },
    }));
    assert.equal(result.ok, false, JSON.stringify(value));
    assert.equal(result.reason, 'invalid-cf-header', JSON.stringify(value));
  }
});

test('cloudflare mode: IPv6 CF header canonicalizes and buckets by /64', () => {
  const resolver = createClientIpResolver(cloudflareConfig());
  const a = resolver.resolve(fakeReq({
    remoteAddress: '::1',
    headers: { 'cf-connecting-ip': '2001:DB8:1:2:3:4:5:6' },
  }));
  assert.equal(a.ok, true);
  assert.equal(a.ip, '2001:db8:1:2:3:4:5:6');
  assert.equal(a.key, '2001:db8:1:2::/64');
  assert.equal(a.family, 6);

  const b = resolver.resolve(fakeReq({
    remoteAddress: '::1',
    headers: { 'cf-connecting-ip': '2001:db8:1:2::9' },
  }));
  const c = resolver.resolve(fakeReq({
    remoteAddress: '::1',
    headers: { 'cf-connecting-ip': '2001:db8:1:2:ffff::1' },
  }));
  const d = resolver.resolve(fakeReq({
    remoteAddress: '::1',
    headers: { 'cf-connecting-ip': '2001:db8:1:3::1' },
  }));
  assert.equal(b.key, c.key, 'same /64 must share a key');
  assert.notEqual(b.key, d.key, 'different /64 must not share a key');
});

test('cloudflare mode: untrusted IPv6 peer outside trusted CIDRs is untrusted-peer', () => {
  const resolver = createClientIpResolver(cloudflareConfig());
  const result = resolver.resolve(fakeReq({
    remoteAddress: '2001:db8::9999',
    headers: { 'cf-connecting-ip': '203.0.113.9' },
  }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'untrusted-peer');
});

test('cloudflare mode: IPv4-mapped IPv6 trusted peer matches an IPv4 trusted CIDR', () => {
  const resolver = createClientIpResolver(cloudflareConfig());
  const result = resolver.resolve(fakeReq({
    remoteAddress: '::ffff:127.0.0.1',
    headers: { 'cf-connecting-ip': '203.0.113.9' },
  }));
  assert.equal(result.ok, true);
  assert.equal(result.ip, '203.0.113.9');
});
