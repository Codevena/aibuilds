'use strict';

// Bounded, injectable-clock implementation of the express-rate-limit v7 Store interface
// (see https://github.com/express-rate-limit/express-rate-limit, source/types.ts `Store`).
//
// Production runs exactly one replica (D4 in
// docs/superpowers/plans/2026-09-23-abuse-authz-hardening.md): this stays a local, in-process
// store, but with a hard key cap and O(1) oldest-key eviction so an attacker rotating identities
// cannot grow it without bound. Counters are lost on restart - a shared atomic store (Redis /
// Valkey) is mandatory before a second replica; there is no silent fallback to a local store.

const DEFAULT_MAX_KEYS = 100_000;
const DEFAULT_WINDOW_MS = 60_000;

class BoundedMemoryStore {
  constructor({ maxKeys = DEFAULT_MAX_KEYS, now = Date.now } = {}) {
    this.maxKeys = maxKeys;
    this.now = now;
    this.windowMs = DEFAULT_WINDOW_MS;
    this.hits = new Map();
    // Keys incremented on this instance cannot affect any other instance - used by
    // express-rate-limit's own double-count misconfiguration check.
    this.localKeys = true;
  }

  // Called by express-rate-limit with the options the middleware was built with.
  init(options) {
    this.windowMs = options.windowMs;
  }

  // Not part of the Store interface; a cheap introspection hook for tests and diagnostics.
  get size() {
    return this.hits.size;
  }

  _freshEntry() {
    return { totalHits: 0, resetTime: this.now() + this.windowMs };
  }

  _entry(key) {
    const nowMs = this.now();
    let entry = this.hits.get(key);
    if (!entry || entry.resetTime <= nowMs) {
      entry = this._freshEntry();
      // Delete-then-set moves the key to the end of the Map's insertion order, so a key whose
      // window just rolled over is treated as freshly active rather than as the oldest evictable.
      this.hits.delete(key);
      this.hits.set(key, entry);
      this._evictOldestIfOverCapacity();
    }
    return entry;
  }

  _evictOldestIfOverCapacity() {
    while (this.hits.size > this.maxKeys) {
      const oldestKey = this.hits.keys().next().value;
      this.hits.delete(oldestKey);
    }
  }

  async increment(key) {
    const entry = this._entry(key);
    entry.totalHits += 1;
    return { totalHits: entry.totalHits, resetTime: new Date(entry.resetTime) };
  }

  async decrement(key) {
    const entry = this.hits.get(key);
    if (entry && entry.totalHits > 0) entry.totalHits -= 1;
  }

  async resetKey(key) {
    this.hits.delete(key);
  }

  async get(key) {
    const entry = this.hits.get(key);
    if (!entry) return undefined;
    if (entry.resetTime <= this.now()) return undefined;
    return { totalHits: entry.totalHits, resetTime: new Date(entry.resetTime) };
  }

  async resetAll() {
    this.hits.clear();
  }
}

module.exports = { BoundedMemoryStore };
