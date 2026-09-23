'use strict';

const test = require('node:test');
const { mock } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { createAgentCredentials, TOKEN_PATTERN } = require('../server/agent-credentials.js');

function createFakeFs(initial = {}) {
  const files = new Map(Object.entries(initial));
  return {
    files,
    async readFile(target, _enc) {
      if (!files.has(target)) {
        const err = new Error('ENOENT');
        err.code = 'ENOENT';
        throw err;
      }
      return files.get(target);
    },
    async writeFile(target, data, _opts) {
      files.set(target, data);
    },
    async rename(from, to) {
      if (!files.has(from)) {
        const err = new Error('ENOENT');
        err.code = 'ENOENT';
        throw err;
      }
      files.set(to, files.get(from));
      files.delete(from);
    },
  };
}

test('load on a missing file leaves credentials empty', async () => {
  const fsImpl = createFakeFs();
  const store = createAgentCredentials({ file: '/data/agent-credentials.json', fsImpl });
  await store.load();
  assert.equal(store.has('Anyone'), false);
});

test('issue returns a token matching TOKEN_PATTERN and records has()', () => {
  const fsImpl = createFakeFs();
  const store = createAgentCredentials({ file: '/data/agent-credentials.json', fsImpl });
  const token = store.issue('Owner-A', 'creation');
  assert.match(token, TOKEN_PATTERN);
  assert.equal(store.has('Owner-A'), true);
});

test('verify: ok for the exact issued token', () => {
  const store = createAgentCredentials({ file: '/data/x.json', fsImpl: createFakeFs() });
  const token = store.issue('Owner-A', 'creation');
  assert.equal(store.verify('Owner-A', token), 'ok');
});

test('verify: mismatch for a wrong well-formed token on a claimed name', () => {
  const store = createAgentCredentials({ file: '/data/x.json', fsImpl: createFakeFs() });
  store.issue('Owner-A', 'creation');
  const other = store.issue('Owner-B', 'creation');
  assert.equal(store.verify('Owner-A', other), 'mismatch');
});

test('verify: unclaimed for a name with no credential', () => {
  const store = createAgentCredentials({ file: '/data/x.json', fsImpl: createFakeFs() });
  const wellFormedToken = `abp_${'A'.repeat(43)}`;
  assert.equal(store.verify('Nobody', wellFormedToken), 'unclaimed');
});

test('verify: malformed for non-token strings and wrong shapes', () => {
  const store = createAgentCredentials({ file: '/data/x.json', fsImpl: createFakeFs() });
  store.issue('Owner-A', 'creation');
  for (const bad of [undefined, null, '', 'abp_short', 'not-a-token', `abp_${'A'.repeat(42)}`, `abp_${'A'.repeat(44)}`, `xyz_${'A'.repeat(43)}`]) {
    assert.equal(store.verify('Owner-A', bad), 'malformed', `expected malformed for ${JSON.stringify(bad)}`);
  }
});

test('revoke removes a credential; verify then reports unclaimed', () => {
  const store = createAgentCredentials({ file: '/data/x.json', fsImpl: createFakeFs() });
  const token = store.issue('Owner-A', 'creation');
  assert.equal(store.revoke('Owner-A'), true);
  assert.equal(store.verify('Owner-A', token), 'unclaimed');
  assert.equal(store.has('Owner-A'), false);
});

test('revoke on an unknown name returns false', () => {
  const store = createAgentCredentials({ file: '/data/x.json', fsImpl: createFakeFs() });
  assert.equal(store.revoke('Ghost'), false);
});

test('issue twice for the same name: only the second token verifies', () => {
  const store = createAgentCredentials({ file: '/data/x.json', fsImpl: createFakeFs() });
  const first = store.issue('Owner-A', 'creation');
  const second = store.issue('Owner-A', 'operator');
  assert.notEqual(first, second);
  assert.equal(store.verify('Owner-A', first), 'mismatch');
  assert.equal(store.verify('Owner-A', second), 'ok');
});

test('unit: verify calls crypto.timingSafeEqual exactly once for well-formed tokens, zero for malformed', () => {
  const store = createAgentCredentials({ file: '/data/x.json', fsImpl: createFakeFs() });
  const token = store.issue('Owner-A', 'creation');

  const spy = mock.method(crypto, 'timingSafeEqual');
  try {
    spy.mock.resetCalls();
    store.verify('Owner-A', token); // claimed, matching
    assert.equal(spy.mock.callCount(), 1, 'claimed-matching case should call timingSafeEqual once');

    spy.mock.resetCalls();
    store.verify('Owner-A', `abp_${'z'.repeat(43)}`); // claimed, mismatching
    assert.equal(spy.mock.callCount(), 1, 'claimed-mismatching case should call timingSafeEqual once');

    spy.mock.resetCalls();
    store.verify('Nobody', `abp_${'z'.repeat(43)}`); // unclaimed, well-formed
    assert.equal(spy.mock.callCount(), 1, 'unclaimed well-formed case should call timingSafeEqual once (dummy compare)');

    spy.mock.resetCalls();
    store.verify('Owner-A', 'not-a-token');
    assert.equal(spy.mock.callCount(), 0, 'malformed input must never reach timingSafeEqual');
  } finally {
    spy.mock.restore();
  }
});

test('save() writes atomically via tmp+rename and file never contains the token plaintext', async () => {
  const fsImpl = createFakeFs();
  const file = '/data/agent-credentials.json';
  const store = createAgentCredentials({ file, fsImpl });
  const token = store.issue('Owner-A', 'creation');
  await store.save();

  assert.equal(fsImpl.files.has(file), true);
  assert.equal(fsImpl.files.has(`${file}.tmp`), false, 'tmp file must be renamed away, not left behind');
  const raw = fsImpl.files.get(file);
  assert.doesNotMatch(raw, /abp_/, 'persisted file must never contain the token plaintext');

  const parsed = JSON.parse(raw);
  assert.equal(parsed.version, 1);
  assert.match(parsed.credentials['Owner-A'].hash, /^[0-9a-f]{64}$/);
  assert.equal(parsed.credentials['Owner-A'].source, 'creation');
});

test('save() writes the file with mode 0600 (real filesystem)', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aibuilds-agent-credentials-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'agent-credentials.json');
  const store = createAgentCredentials({ file, fsImpl: fs });
  store.issue('Owner-A', 'creation');
  await store.save();
  const stat = await fs.stat(file);
  assert.equal(stat.mode & 0o777, 0o600);
  const raw = await fs.readFile(file, 'utf8');
  assert.doesNotMatch(raw, /abp_/);
});

test('save() calls are serialized: two concurrent saves never interleave', async () => {
  const fsImpl = createFakeFs();
  const file = '/data/agent-credentials.json';
  const store = createAgentCredentials({ file, fsImpl });
  store.issue('Owner-A', 'creation');
  const p1 = store.save();
  store.issue('Owner-B', 'creation');
  const p2 = store.save();
  await Promise.all([p1, p2]);
  const parsed = JSON.parse(fsImpl.files.get(file));
  assert.deepEqual(Object.keys(parsed.credentials).sort(), ['Owner-A', 'Owner-B']);
});

test('round-trip: save() then load() into a fresh store restores verification', async () => {
  const fsImpl = createFakeFs();
  const file = '/data/agent-credentials.json';
  const store1 = createAgentCredentials({ file, fsImpl });
  const token = store1.issue('Owner-A', 'creation');
  await store1.save();

  const store2 = createAgentCredentials({ file, fsImpl });
  await store2.load();
  assert.equal(store2.has('Owner-A'), true);
  assert.equal(store2.verify('Owner-A', token), 'ok');
});

test('load of a malformed JSON file throws', async () => {
  const file = '/data/agent-credentials.json';
  const fsImpl = createFakeFs({ [file]: '{ not json' });
  const store = createAgentCredentials({ file, fsImpl });
  await assert.rejects(() => store.load());
});

test('load rejects an invalid shape (missing version, non-object credentials, bad hash)', async () => {
  const cases = [
    JSON.stringify({ credentials: {} }), // missing version
    JSON.stringify({ version: 1, credentials: [] }), // credentials not an object
    JSON.stringify({ version: 1, credentials: { A: { hash: 'not-hex', issuedAt: 1, source: 'creation' } } }),
    JSON.stringify({ version: 1, credentials: { A: { hash: 'a'.repeat(64), issuedAt: 'nope', source: 'creation' } } }),
    JSON.stringify({ version: 1, credentials: { A: { hash: 'a'.repeat(64), issuedAt: 1, source: 'bogus' } } }),
    JSON.stringify({ version: 2, credentials: {} }),
    JSON.stringify([1, 2, 3]),
  ];
  for (const raw of cases) {
    const file = '/data/agent-credentials.json';
    const fsImpl = createFakeFs({ [file]: raw });
    const store = createAgentCredentials({ file, fsImpl });
    await assert.rejects(() => store.load(), undefined, `expected rejection for ${raw}`);
  }
});

test('load supports a credential literally named "__proto__" without prototype pollution', async () => {
  const file = '/data/agent-credentials.json';
  const hash = crypto.createHash('sha256').update('x').digest('hex');
  // Build the raw JSON as a STRING (not a JS object literal with a literal __proto__ key --
  // that would set the prototype instead of a property). JSON.parse creates "__proto__" as a
  // genuine own data property, which is exactly the case this module must survive.
  const raw = JSON.stringify({ version: 1, credentials: { ['__proto__']: { hash, issuedAt: 1, source: 'operator' } } });
  assert.match(raw, /"__proto__"/, 'sanity check: the fixture JSON actually contains the key');
  const fsImpl = createFakeFs({ [file]: raw });
  const store = createAgentCredentials({ file, fsImpl });
  await store.load();
  assert.equal(store.has('__proto__'), true);
  assert.equal(Object.getPrototypeOf({}), Object.prototype, 'global Object.prototype must be untouched');
});

test('issue() and save() round-trip a credential named "__proto__"', async () => {
  const file = '/data/agent-credentials.json';
  const fsImpl = createFakeFs();
  const store = createAgentCredentials({ file, fsImpl });
  const token = store.issue('__proto__', 'creation');
  await store.save();
  const raw = fsImpl.files.get(file);
  assert.match(raw, /"__proto__"/, 'the persisted JSON must contain the literal key');
  const parsed = JSON.parse(raw);
  assert.equal(Object.prototype.hasOwnProperty.call(parsed.credentials, '__proto__'), true);
  assert.match(parsed.credentials.__proto__.hash, /^[0-9a-f]{64}$/);
  assert.equal(Object.getPrototypeOf({}), Object.prototype, 'global Object.prototype must be untouched');

  const store2 = createAgentCredentials({ file, fsImpl });
  await store2.load();
  assert.equal(store2.verify('__proto__', token), 'ok');
});

test('snapshot()/restore() roll back an in-memory issue', () => {
  const store = createAgentCredentials({ file: '/data/x.json', fsImpl: createFakeFs() });
  store.issue('Existing', 'creation');
  const before = store.snapshot();
  const token = store.issue('New-Agent', 'creation');
  assert.equal(store.has('New-Agent'), true);
  store.restore(before);
  assert.equal(store.has('New-Agent'), false);
  assert.equal(store.has('Existing'), true);
  assert.equal(store.verify('New-Agent', token), 'unclaimed');
});

test('issue rejects an invalid source', () => {
  const store = createAgentCredentials({ file: '/data/x.json', fsImpl: createFakeFs() });
  assert.throws(() => store.issue('Owner-A', 'bogus'));
});
