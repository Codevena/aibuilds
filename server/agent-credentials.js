'use strict';

// Profile ownership capability store (T5 / D1). Tokens are generated from 32 CSPRNG bytes,
// persisted only as a SHA-256 hash, and compared with crypto.timingSafeEqual. The token plaintext
// is never stored, logged or returned anywhere except issue()'s own return value.

const crypto = require('node:crypto');

const TOKEN_PATTERN = /^abp_[A-Za-z0-9_-]{43}$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const VALID_SOURCES = new Set(['creation', 'operator']);

// Fixed dummy hash so verify() for an unclaimed name performs the exact same shape of comparison
// as a claimed one (one crypto.timingSafeEqual call), independent of whether the name exists.
const DUMMY_HASH = crypto.createHash('sha256').update('aibuilds-agent-credentials-dummy-hash').digest('hex');
const DUMMY_HASH_BUFFER = Buffer.from(DUMMY_HASH, 'hex');

function hashToken(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

function invalidFile(reason) {
  return new Error(`Invalid agent credentials file: ${reason}`);
}

function validateEntry(name, entry) {
  if (typeof name !== 'string' || name.length === 0) {
    throw invalidFile('entry has a non-string or empty name');
  }
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw invalidFile(`entry for "${name}" is not an object`);
  }
  if (typeof entry.hash !== 'string' || !HASH_PATTERN.test(entry.hash)) {
    throw invalidFile(`entry for "${name}" has an invalid hash`);
  }
  if (typeof entry.issuedAt !== 'number' || !Number.isFinite(entry.issuedAt)) {
    throw invalidFile(`entry for "${name}" has an invalid issuedAt`);
  }
  if (!VALID_SOURCES.has(entry.source)) {
    throw invalidFile(`entry for "${name}" has an invalid source`);
  }
}

function createAgentCredentials({ file, fsImpl = require('node:fs/promises') }) {
  if (typeof file !== 'string' || file.length === 0) {
    throw new TypeError('createAgentCredentials requires a file path');
  }

  // name -> { hash, issuedAt, source }
  let credentials = new Map();
  // Serializes save() calls so two concurrent saves never interleave temp-file writes.
  let saveChain = Promise.resolve();

  async function load() {
    let raw;
    try {
      raw = await fsImpl.readFile(file, 'utf8');
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        credentials = new Map();
        return;
      }
      throw err;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw invalidFile('malformed JSON');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw invalidFile('root is not an object');
    }
    if (parsed.version !== 1) {
      throw invalidFile('unsupported version');
    }
    if (!parsed.credentials || typeof parsed.credentials !== 'object' || Array.isArray(parsed.credentials)) {
      throw invalidFile('credentials is not an object');
    }
    const next = new Map();
    // Object.entries() reads own enumerable properties, including a literal "__proto__" key
    // that JSON.parse creates as a genuine own data property (never touching the prototype) --
    // so a stored credential named "__proto__" round-trips like any other name.
    for (const [name, entry] of Object.entries(parsed.credentials)) {
      validateEntry(name, entry);
      next.set(name, { hash: entry.hash, issuedAt: entry.issuedAt, source: entry.source });
    }
    credentials = next;
  }

  async function writeFile() {
    // Object.create(null) has no inherited "__proto__" accessor, so obj['__proto__'] = value
    // below creates a genuine own data property instead of mutating the prototype -- required to
    // safely persist a credential literally named "__proto__".
    const plain = Object.create(null);
    for (const [name, entry] of credentials) {
      plain[name] = { hash: entry.hash, issuedAt: entry.issuedAt, source: entry.source };
    }
    const payload = JSON.stringify({ version: 1, credentials: plain }, null, 2);
    const tmpFile = `${file}.tmp`;
    await fsImpl.writeFile(tmpFile, payload, { mode: 0o600 });
    await fsImpl.rename(tmpFile, file);
  }

  function save() {
    const operation = saveChain.then(() => writeFile());
    // Keep the chain usable after a failed save, but hand the caller the real rejecting promise
    // so a logged write failure is never mistaken for durability.
    saveChain = operation.catch(() => {});
    return operation;
  }

  function issue(name, source) {
    if (typeof name !== 'string' || name.length === 0) {
      throw new TypeError('issue requires a non-empty name');
    }
    if (!VALID_SOURCES.has(source)) {
      throw new TypeError("issue requires source 'creation' or 'operator'");
    }
    const token = `abp_${crypto.randomBytes(32).toString('base64url')}`;
    credentials.set(name, { hash: hashToken(token), issuedAt: Date.now(), source });
    return token;
  }

  function revoke(name) {
    return credentials.delete(name);
  }

  function has(name) {
    return credentials.has(name);
  }

  function verify(name, presented) {
    if (typeof presented !== 'string' || !TOKEN_PATTERN.test(presented)) {
      return 'malformed';
    }
    const presentedHash = Buffer.from(hashToken(presented), 'hex');
    const entry = credentials.get(name);
    if (!entry) {
      // Always do exactly one timingSafeEqual call, even when the name is unclaimed, so the
      // response timing does not reveal whether a name has a credential at all.
      crypto.timingSafeEqual(presentedHash, DUMMY_HASH_BUFFER);
      return 'unclaimed';
    }
    const storedHash = Buffer.from(entry.hash, 'hex');
    const matches = crypto.timingSafeEqual(presentedHash, storedHash);
    return matches ? 'ok' : 'mismatch';
  }

  function snapshot() {
    return new Map(credentials);
  }

  function restore(snap) {
    credentials = new Map(snap);
  }

  return { load, save, issue, revoke, has, verify, snapshot, restore };
}

module.exports = { createAgentCredentials, TOKEN_PATTERN };
