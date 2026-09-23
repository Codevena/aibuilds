'use strict';

// T7 resource-cap primitives: a generation-bound TTL cache for cheap read invalidation, a
// counting semaphore with a bounded wait queue, an LRU cache with a byte budget (for the diff
// cache), and a single-flight helper so concurrent identical reads share one computation.

function createGenerationCache({ ttlMs, maxEntries = 256, now = Date.now }) {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new TypeError('ttlMs must be a positive number');
  }
  if (!Number.isInteger(maxEntries) || maxEntries <= 0) {
    throw new TypeError('maxEntries must be a positive integer');
  }

  let gen = 0;
  // key -> { value, expiresAt, generation }. Map insertion order doubles as FIFO eviction order.
  const store = new Map();

  function generation() {
    return gen;
  }

  function bump() {
    gen += 1;
  }

  function get(key) {
    const entry = store.get(key);
    if (!entry) return undefined;
    if (entry.generation !== gen || entry.expiresAt <= now()) {
      store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  function set(key, value, generationAtStart) {
    // A mutation that started (bump()) while the value was being computed makes the result
    // stale: discard it instead of caching data that no longer reflects current state.
    if (generationAtStart !== gen) return;
    if (!store.has(key) && store.size >= maxEntries) {
      const oldestKey = store.keys().next().value;
      if (oldestKey !== undefined) store.delete(oldestKey);
    }
    store.set(key, { value, expiresAt: now() + ttlMs, generation: gen });
  }

  return { generation, bump, get, set };
}

function createSemaphore({ limit, maxWaiters }) {
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new TypeError('limit must be a positive integer');
  }
  if (!Number.isInteger(maxWaiters) || maxWaiters < 0) {
    throw new TypeError('maxWaiters must be a non-negative integer');
  }

  let activeCount = 0;
  const queue = []; // pending resolve functions, FIFO

  function makeRelease() {
    let released = false;
    return function release() {
      if (released) return;
      released = true;
      activeCount -= 1;
      if (queue.length > 0) {
        const resolveNext = queue.shift();
        activeCount += 1;
        resolveNext(makeRelease());
      }
    };
  }

  function acquire() {
    if (activeCount < limit) {
      activeCount += 1;
      return Promise.resolve(makeRelease());
    }
    if (queue.length >= maxWaiters) {
      const err = new Error('Semaphore wait queue is full');
      err.code = 'SEMAPHORE_FULL';
      return Promise.reject(err);
    }
    return new Promise((resolve) => {
      queue.push(resolve);
    });
  }

  function active() {
    return activeCount;
  }

  function waiting() {
    return queue.length;
  }

  return { acquire, active, waiting };
}

function defaultSizeOf(value) {
  if (typeof value === 'string') return Buffer.byteLength(value, 'utf8');
  if (Buffer.isBuffer(value)) return value.length;
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    return 0;
  }
}

function createLruBytesCache({ maxEntries, maxBytes, sizeOf }) {
  if (!Number.isInteger(maxEntries) || maxEntries <= 0) {
    throw new TypeError('maxEntries must be a positive integer');
  }
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
    throw new TypeError('maxBytes must be a positive integer');
  }
  const computeSize = typeof sizeOf === 'function' ? sizeOf : defaultSizeOf;

  // key -> { value, size }. Map insertion/re-insertion order is the LRU recency order (oldest
  // first = least recently used).
  const store = new Map();
  let totalBytes = 0;

  function evictIfNeeded() {
    while (store.size > maxEntries || totalBytes > maxBytes) {
      const oldestKey = store.keys().next().value;
      if (oldestKey === undefined) break;
      const entry = store.get(oldestKey);
      store.delete(oldestKey);
      totalBytes -= entry.size;
    }
  }

  function get(key) {
    const entry = store.get(key);
    if (!entry) return undefined;
    store.delete(key);
    store.set(key, entry); // move to most-recently-used position
    return entry.value;
  }

  function set(key, value) {
    const size = computeSize(value);
    if (store.has(key)) {
      totalBytes -= store.get(key).size;
      store.delete(key);
    }
    store.set(key, { value, size });
    totalBytes += size;
    evictIfNeeded();
  }

  function size() {
    return store.size;
  }

  function bytes() {
    return totalBytes;
  }

  return { get, set, size, bytes };
}

function createSingleFlight() {
  const inFlight = new Map(); // key -> Promise

  async function run(key, fn) {
    if (inFlight.has(key)) {
      return inFlight.get(key);
    }
    const promise = Promise.resolve().then(() => fn());
    inFlight.set(key, promise);
    try {
      return await promise;
    } finally {
      inFlight.delete(key);
    }
  }

  return { run };
}

module.exports = { createGenerationCache, createSemaphore, createLruBytesCache, createSingleFlight };
