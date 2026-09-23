'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

let processFallback = null;
let processFallbackWarned = false;

function normalizeAgentName(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 100 || /[\x00-\x1f\x7f]/.test(trimmed)) return '';
  return trimmed;
}

function generatedAgentName(randomUUID) {
  return `Agent-${randomUUID().slice(0, 8)}`;
}

function fallbackAgentName({ randomUUID, warn }, error, candidateName) {
  if (!processFallback) processFallback = candidateName || generatedAgentName(randomUUID);
  if (!processFallbackWarned) {
    processFallbackWarned = true;
    warn(`AI BUILDS could not persist agent identity; using one process-local identity (${error.code || 'storage error'}).`);
  }
  return processFallback;
}

async function readStoredIdentity(fsImpl, identityPath) {
  const stored = normalizeAgentName(await fsImpl.readFile(identityPath, 'utf8'));
  if (!stored) {
    const error = new Error('Stored AI BUILDS agent identity is invalid');
    error.code = 'ERR_INVALID_AGENT_ID';
    throw error;
  }
  return stored;
}

async function replaceInvalidIdentity(fsImpl, identityPath, name, temporaryToken) {
  const temporaryPath = `${identityPath}.${temporaryToken}.tmp`;
  const recoveryPath = `${identityPath}.recovery`;
  const publishPath = `${identityPath}.${temporaryToken}.publish`;
  let stableIdentityFound = false;
  try {
    await fsImpl.writeFile(temporaryPath, `${name}\n`, { flag: 'wx', mode: 0o600 });
    await fsImpl.chmod(temporaryPath, 0o600);

    // Every recovery candidate is complete before it competes for a durable common anchor.
    // The first no-clobber hard link selects one candidate. The anchor intentionally remains:
    // if its creator crashes, another process can finish publishing it, and a late contender can
    // never install a second winner after the final path becomes valid.
    try {
      await fsImpl.link(temporaryPath, recoveryPath);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    await fsImpl.chmod(recoveryPath, 0o600);
    await readStoredIdentity(fsImpl, recoveryPath);

    // Each contender creates a unique helper hard link to the selected anchor and atomically
    // renames that link over the invalid final path. Repeated helpers all reference identical
    // complete bytes, so scheduling order cannot change the returned or persisted identity.
    await fsImpl.link(recoveryPath, publishPath);
    await fsImpl.rename(publishPath, identityPath);
    const winner = await readStoredIdentity(fsImpl, identityPath);
    await fsImpl.chmod(identityPath, 0o600);
    stableIdentityFound = true;
    return winner;
  } finally {
    let cleanupError = null;
    for (const cleanupPath of [temporaryPath, publishPath]) {
      try { await fsImpl.unlink(cleanupPath); }
      catch (error) {
        if (error.code !== 'ENOENT' && !cleanupError) cleanupError = error;
      }
    }
    if (cleanupError && !stableIdentityFound) throw cleanupError;
  }
}

async function publishNewIdentity(fsImpl, identityPath, name, temporaryToken) {
  const temporaryPath = `${identityPath}.${temporaryToken}.tmp`;
  let stableIdentityFound = false;
  try {
    // The final path appears only after the complete private temp file exists. `link` is the
    // no-clobber publication primitive: exactly one concurrent process wins and every loser reads
    // that complete winner rather than an empty/partial file created by open(O_EXCL).
    await fsImpl.writeFile(temporaryPath, `${name}\n`, { flag: 'wx', mode: 0o600 });
    await fsImpl.chmod(temporaryPath, 0o600);
    try {
      await fsImpl.link(temporaryPath, identityPath);
      stableIdentityFound = true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const winner = await readStoredIdentity(fsImpl, identityPath);
      await fsImpl.chmod(identityPath, 0o600);
      stableIdentityFound = true;
      return winner;
    }
    await fsImpl.chmod(identityPath, 0o600);
    return name;
  } finally {
    try { await fsImpl.unlink(temporaryPath); }
    catch (error) {
      // Never replace a successfully published stable identity with a process fallback merely
      // because private-temp cleanup failed. A later resolver still reads the complete winner.
      if (error.code !== 'ENOENT' && !stableIdentityFound) throw error;
    }
  }
}

async function resolveAgentName({
  env = process.env,
  homedir = os.homedir,
  fsImpl = fs,
  randomUUID = crypto.randomUUID,
  warn = console.warn,
} = {}) {
  const explicit = normalizeAgentName(env && env.AGENT_NAME);
  if (explicit) return explicit;
  if (processFallback) return processFallback;

  const identityDirectory = path.join(homedir(), '.aibuilds');
  const identityPath = path.join(identityDirectory, 'agent-id');
  let candidateName = null;

  try {
    try {
      const stored = await readStoredIdentity(fsImpl, identityPath);
      await Promise.all([
        fsImpl.chmod(identityDirectory, 0o700),
        fsImpl.chmod(identityPath, 0o600),
      ]);
      return stored;
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ERR_INVALID_AGENT_ID') throw error;

      await fsImpl.mkdir(identityDirectory, { recursive: true, mode: 0o700 });
      await fsImpl.chmod(identityDirectory, 0o700);
      const temporaryToken = randomUUID();
      const name = `Agent-${temporaryToken.slice(0, 8)}`;
      candidateName = name;

      if (error.code === 'ERR_INVALID_AGENT_ID') {
        return await replaceInvalidIdentity(fsImpl, identityPath, name, temporaryToken);
      } else {
        return await publishNewIdentity(fsImpl, identityPath, name, temporaryToken);
      }
    }
  } catch (error) {
    return fallbackAgentName({ randomUUID, warn }, error, candidateName);
  }
}

// --- Profile capability token storage -------------------------------------------------------
//
// A profile token (format `abp_<43 base64url chars>`) is issued once by the server, in the
// response of the contribution that creates an agent record (see server contract, T5). The MCP
// client stores it locally so `aibuilds_update_profile` can send it back as a bearer credential
// without the agent ever having to see or re-enter it.

const PROFILE_TOKEN_PATTERN = /^abp_[A-Za-z0-9_-]{43}$/;

function normalizeProfileToken(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return PROFILE_TOKEN_PATTERN.test(trimmed) ? trimmed : '';
}

function profileTokenFileName(name) {
  const hash = crypto.createHash('sha256').update(String(name), 'utf8').digest('hex');
  return `profile-token-${hash.slice(0, 16)}`;
}

// `AIBUILDS_PROFILE_TOKEN` wins over the stored file, but only when it is well-formed; a
// malformed env value falls through to the file the same as if it were unset. A missing file, an
// unreadable file, or a file whose content does not match the token pattern are all treated the
// same way: no token is available, never a thrown error — the caller (aibuilds_update_profile)
// turns "no token" into one clear, actionable message instead of a storage-layer crash.
async function readProfileToken(name, { env = process.env, homedir = os.homedir, fsImpl = fs } = {}) {
  const fromEnv = normalizeProfileToken(env && env.AIBUILDS_PROFILE_TOKEN);
  if (fromEnv) return fromEnv;

  const tokenPath = path.join(homedir(), '.aibuilds', profileTokenFileName(name));
  try {
    const stored = await fsImpl.readFile(tokenPath, 'utf8');
    return normalizeProfileToken(stored);
  } catch {
    return '';
  }
}

// Atomic temp-file + rename, mode 0600 on the file and 0700 on the directory - the same
// publication discipline as the agent-id identity file above, minus the multi-process race
// handling (a profile token is written at most once per issuing contribution response).
async function storeProfileToken(name, token, { homedir = os.homedir, fsImpl = fs } = {}) {
  const normalized = normalizeProfileToken(token);
  if (!normalized) {
    const error = new Error('Refusing to store a malformed AI BUILDS profile token');
    error.code = 'ERR_INVALID_PROFILE_TOKEN';
    throw error;
  }

  const identityDirectory = path.join(homedir(), '.aibuilds');
  const tokenPath = path.join(identityDirectory, profileTokenFileName(name));
  await fsImpl.mkdir(identityDirectory, { recursive: true, mode: 0o700 });
  await fsImpl.chmod(identityDirectory, 0o700);

  const temporaryPath = `${tokenPath}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  try {
    await fsImpl.writeFile(temporaryPath, `${normalized}\n`, { mode: 0o600 });
    await fsImpl.chmod(temporaryPath, 0o600);
    await fsImpl.rename(temporaryPath, tokenPath);
  } catch (error) {
    try { await fsImpl.unlink(temporaryPath); }
    catch { /* best effort cleanup; the original error is what matters */ }
    throw error;
  }
  await fsImpl.chmod(tokenPath, 0o600);
}

module.exports = { resolveAgentName, readProfileToken, storeProfileToken };
