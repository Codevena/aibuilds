'use strict';

// In-memory registry for outstanding PoW challenges (T4). Bounded per owner (limiter identity)
// and globally, so an attacker cannot exhaust memory by requesting unbounded open challenges.
// No timers live inside this module: the server calls sweep() on its own interval (60s).

const crypto = require('node:crypto');

function defaultRandomUUID() {
  return crypto.randomUUID();
}

function defaultRandomBytes(size) {
  return crypto.randomBytes(size);
}

function createChallengeRegistry({
  ttlMs = 5 * 60 * 1000,
  maxPerOwner = 60,
  maxGlobal = 5000,
  now = Date.now,
  randomUUID = defaultRandomUUID,
  randomBytes = defaultRandomBytes,
} = {}) {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new TypeError('ttlMs must be a positive number');
  }
  if (!Number.isInteger(maxPerOwner) || maxPerOwner <= 0) {
    throw new TypeError('maxPerOwner must be a positive integer');
  }
  if (!Number.isInteger(maxGlobal) || maxGlobal <= 0) {
    throw new TypeError('maxGlobal must be a positive integer');
  }

  // id -> { prefix, expiresAt, ownerKey }. Map insertion order == global age order (D7).
  const challenges = new Map();
  // ownerKey -> Set<id>
  const owners = new Map();

  // Removes an id from both maps, keeping owner sets consistent. This is the single removal
  // path shared by consume(), expiry pruning, sweep() and the D7 global eviction (Gate R2-2):
  // every caller that removes a challenge cleans its owner's Set and drops the owner entry once
  // that Set is empty, so `owners.size` never outlives the last challenge it held.
  function removeChallenge(id) {
    const entry = challenges.get(id);
    if (!entry) return false;
    challenges.delete(id);
    const set = owners.get(entry.ownerKey);
    if (set) {
      set.delete(id);
      if (set.size === 0) owners.delete(entry.ownerKey);
    }
    return true;
  }

  function pruneOwnerExpired(ownerKey) {
    const set = owners.get(ownerKey);
    if (!set) return;
    const nowTs = now();
    for (const id of Array.from(set)) {
      const entry = challenges.get(id);
      if (!entry || entry.expiresAt <= nowTs) {
        removeChallenge(id);
      }
    }
  }

  function evictGloballyOldest() {
    const oldestId = challenges.keys().next().value;
    if (oldestId === undefined) return;
    removeChallenge(oldestId);
  }

  function issue(ownerKey) {
    pruneOwnerExpired(ownerKey);
    const openSet = owners.get(ownerKey);
    const openCount = openSet ? openSet.size : 0;
    if (openCount >= maxPerOwner) {
      return { error: 'owner-cap' };
    }
    if (challenges.size >= maxGlobal) {
      evictGloballyOldest();
    }
    const id = randomUUID();
    const prefix = randomBytes(16).toString('hex');
    const expiresAt = now() + ttlMs;
    challenges.set(id, { prefix, expiresAt, ownerKey });
    let set = owners.get(ownerKey);
    if (!set) {
      set = new Set();
      owners.set(ownerKey, set);
    }
    set.add(id);
    return { id, prefix, expiresAt };
  }

  function get(id) {
    const entry = challenges.get(id);
    if (!entry) return null;
    if (entry.expiresAt <= now()) {
      removeChallenge(id);
      return null;
    }
    return { prefix: entry.prefix, expiresAt: entry.expiresAt, ownerKey: entry.ownerKey };
  }

  function consume(id) {
    const entry = challenges.get(id);
    if (!entry) return false;
    const expired = entry.expiresAt <= now();
    removeChallenge(id);
    return !expired;
  }

  function sweep() {
    const nowTs = now();
    for (const [id, entry] of challenges) {
      if (entry.expiresAt <= nowTs) {
        removeChallenge(id);
      }
    }
  }

  function size() {
    return challenges.size;
  }

  function ownerCount() {
    return owners.size;
  }

  function ownerOpen(ownerKey) {
    pruneOwnerExpired(ownerKey);
    const set = owners.get(ownerKey);
    return set ? set.size : 0;
  }

  return { issue, get, consume, sweep, size, ownerCount, ownerOpen };
}

module.exports = { createChallengeRegistry };
