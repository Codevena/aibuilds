'use strict';

const path = require('path');
const fs = require('fs').promises;
const { normalizeWorldPath } = require('./world-files');

// Moderation state lives in its OWN server-only file (gitignored) so agent IPs / banned IPs are
// never written into the shared/tracked state.json or its backups.
const DATA_DIR = process.env.AIBUILDS_DATA_DIR || path.join(__dirname, '../data');
const MODERATION_FILE = path.join(DATA_DIR, 'moderation.json');
const LEGACY_STATE_FILE = path.join(DATA_DIR, 'state.json');

// In-memory moderation state (persisted via serializeModeration / loadModeration).
const hiddenFiles = new Set();   // normalized world-relative paths
const bannedAgents = new Set();  // exact agent_name
const bannedIps = new Set();     // exact ip
const agentIps = new Map();      // agent_name -> last seen ip (private)
const quarantinedFiles = new Map(); // path -> public-safe quarantine metadata
const approvedFiles = new Map();    // path -> approved content hash
const gitRepairs = new Map();       // path -> private Git rollback transaction (server-only)

// Normalize any path input to a comparable, CANONICAL world-relative key. Canonicalization
// (path.posix.normalize) collapses ./ and ../ segments so a hidden "sections/x.html" can't be
// bypassed with "sections/../sections/x.html" (which path.join/express.static would resolve back
// to the same file).
function normalizePath(p) {
  if (typeof p !== 'string') return '';
  let n = p
    .replace(/\\/g, '/')      // backslashes -> slashes
    .replace(/^\/+/, '')      // strip leading slashes
    .replace(/^world\//i, ''); // strip a leading world/ prefix
  n = path.posix.normalize(n)        // collapse . and .. segments
    .replace(/^(\.\.\/)+/, '')       // drop any leading ../ that walked above the root
    .replace(/^\/+/, '');
  return n.toLowerCase();
}

// Publication paths use the exact Task-1 World identity. Unlike the legacy hide/ban key,
// quarantine decisions must preserve case and must not rewrite a legitimate `world/` directory.
function normalizePublicationPath(p) {
  try { return normalizeWorldPath(p); }
  catch { return ''; }
}

function normalizeGitEntry(entry, { allowStage = false } = {}) {
  if (!entry || typeof entry !== 'object' || !/^[0-7]{6}$/.test(entry.mode || '') ||
      !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(entry.hash || '')) return null;
  if (!allowStage) return { mode: entry.mode, hash: entry.hash };
  if (!Number.isInteger(entry.stage) || entry.stage < 0 || entry.stage > 3) return null;
  return { mode: entry.mode, hash: entry.hash, stage: entry.stage };
}

function normalizeGitRepairPublicationState(filePath, state) {
  if (state === undefined || state === null) return null;
  if (typeof state !== 'object' ||
      (state.approval !== null && typeof state.approval !== 'string')) return null;
  let quarantine = null;
  if (state.quarantine !== null) {
    const record = state.quarantine;
    const normalized = normalizePublicationPath(record?.filePath || filePath);
    if (!record || typeof record !== 'object' || normalized !== filePath ||
        typeof record.contentHash !== 'string' || !Array.isArray(record.reasons) ||
        record.reasons.some(reason => typeof reason !== 'string') ||
        typeof record.agentName !== 'string' || typeof record.timestamp !== 'string') return null;
    quarantine = {
      filePath: normalized,
      contentHash: record.contentHash,
      reasons: [...record.reasons],
      agentName: record.agentName,
      timestamp: record.timestamp,
    };
  }
  return { quarantine, approval: state.approval };
}

function normalizeGitRepairAgentIps(snapshot) {
  if (snapshot === undefined || snapshot === null) return null;
  if (!Array.isArray(snapshot) || snapshot.some(entry => (
    !Array.isArray(entry) || entry.length !== 2 ||
    typeof entry[0] !== 'string' || !entry[0] || typeof entry[1] !== 'string' || !entry[1]
  ))) return null;
  return snapshot.map(entry => [...entry]);
}

function normalizeGitRepair(filePath, repair, { fromDisk = false } = {}) {
  const normalized = normalizePublicationPath(repair?.filePath || filePath);
  const gitPathState = repair?.gitPathState;
  const indexState = gitPathState?.indexState;
  const rawFileState = repair?.fileState;
  const fileState = rawFileState === undefined || rawFileState === null
    ? null
    : {
        existed: rawFileState.existed === true,
        bytesBase64: rawFileState.existed === true ? rawFileState.bytesBase64 : null,
      };
  const gitHash = repair?.gitHash === null || repair?.gitHash === undefined
    ? null
    : repair.gitHash;
  const storedStatus = repair?.status || 'required';
  const status = fromDisk ? 'required' : storedStatus;
  const contributionId = repair?.contributionId === undefined || repair?.contributionId === null
    ? null
    : repair.contributionId;
  const publicationState = normalizeGitRepairPublicationState(normalized, repair?.publicationState);
  const agentIps = normalizeGitRepairAgentIps(repair?.agentIps);
  if (!normalized || !repair || typeof repair !== 'object' ||
      (gitHash !== null && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(gitHash)) ||
      !['armed', 'required'].includes(storedStatus) ||
      (contributionId !== null && (typeof contributionId !== 'string' || !contributionId)) ||
      (repair.publicationState !== undefined && repair.publicationState !== null && !publicationState) ||
      (repair.agentIps !== undefined && repair.agentIps !== null && !agentIps) ||
      (rawFileState !== undefined && rawFileState !== null &&
        (typeof rawFileState !== 'object' || typeof rawFileState.existed !== 'boolean' ||
          (rawFileState.existed && typeof rawFileState.bytesBase64 !== 'string'))) ||
      !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(gitPathState?.head || '') ||
      !indexState || !Array.isArray(indexState.entries)) return null;
  const treeEntry = gitPathState.treeEntry === null
    ? null
    : normalizeGitEntry(gitPathState.treeEntry);
  if (gitPathState.treeEntry !== null && !treeEntry) return null;
  const entries = indexState.entries.map(entry => normalizeGitEntry(entry, { allowStage: true }));
  if (entries.some(entry => !entry)) return null;
  return {
    filePath: normalized,
    gitHash,
    status,
    contributionId,
    publicationState,
    agentIps,
    fileState,
    gitPathState: {
      head: gitPathState.head,
      treeEntry,
      indexState: {
        entries,
        assumeUnchanged: indexState.assumeUnchanged === true,
        skipWorktree: indexState.skipWorktree === true,
      },
    },
  };
}

function cloneGitRepair(repair) {
  return {
    filePath: repair.filePath,
    gitHash: repair.gitHash,
    status: repair.status,
    contributionId: repair.contributionId,
    publicationState: repair.publicationState ? {
      quarantine: repair.publicationState.quarantine
        ? { ...repair.publicationState.quarantine, reasons: [...repair.publicationState.quarantine.reasons] }
        : null,
      approval: repair.publicationState.approval,
    } : null,
    agentIps: repair.agentIps ? repair.agentIps.map(entry => [...entry]) : null,
    fileState: repair.fileState ? { ...repair.fileState } : null,
    gitPathState: {
      head: repair.gitPathState.head,
      treeEntry: repair.gitPathState.treeEntry ? { ...repair.gitPathState.treeEntry } : null,
      indexState: {
        entries: repair.gitPathState.indexState.entries.map(entry => ({ ...entry })),
        assumeUnchanged: repair.gitPathState.indexState.assumeUnchanged,
        skipWorktree: repair.gitPathState.indexState.skipWorktree,
      },
    },
  };
}

function loadModeration(state) {
  hiddenFiles.clear(); bannedAgents.clear(); bannedIps.clear(); agentIps.clear();
  quarantinedFiles.clear(); approvedFiles.clear(); gitRepairs.clear();
  const m = (state && state.moderation) || {};
  for (const p of m.hiddenFiles || []) hiddenFiles.add(normalizePath(p));
  for (const a of m.bannedAgents || []) bannedAgents.add(a);
  for (const ip of m.bannedIps || []) bannedIps.add(ip);
  const ips = (state && state.agentIps) || {};
  for (const [name, ip] of Object.entries(ips)) agentIps.set(name, ip);
  for (const [filePath, record] of Object.entries(m.quarantinedFiles || {})) {
    const normalized = normalizePublicationPath(record?.filePath || filePath);
    if (!normalized || !record || typeof record !== 'object' || typeof record.contentHash !== 'string') continue;
    quarantinedFiles.set(normalized, {
      filePath: normalized,
      contentHash: record.contentHash,
      reasons: Array.isArray(record.reasons) ? record.reasons.filter(reason => typeof reason === 'string') : [],
      agentName: typeof record.agentName === 'string' ? record.agentName : '',
      timestamp: typeof record.timestamp === 'string' ? record.timestamp : '',
    });
  }
  for (const [filePath, contentHash] of Object.entries(m.approvedFiles || {})) {
    const normalized = normalizePublicationPath(filePath);
    if (normalized && typeof contentHash === 'string' && contentHash) approvedFiles.set(normalized, contentHash);
  }
  for (const [filePath, repair] of Object.entries((state && state.gitRepairs) || {})) {
    // A persisted write-ahead marker means the previous process did not durably finish the Git
    // transaction. Treat both legacy records and unfinished `armed` records as repair-required.
    const normalized = normalizeGitRepair(filePath, repair, { fromDisk: true });
    if (!normalized) throw new Error(`Invalid durable Git repair state for ${filePath}`);
    gitRepairs.set(normalized.filePath, normalized);
  }
}

function serializeModeration() {
  return {
    moderation: {
      hiddenFiles: Array.from(hiddenFiles),
      bannedAgents: Array.from(bannedAgents),
      bannedIps: Array.from(bannedIps),
      quarantinedFiles: Object.fromEntries(quarantinedFiles),
      approvedFiles: Object.fromEntries(approvedFiles),
    },
    agentIps: Object.fromEntries(agentIps),
    gitRepairs: Object.fromEntries(Array.from(gitRepairs, ([filePath, repair]) => [
      filePath,
      cloneGitRepair(repair),
    ])),
  };
}

// ---- file persistence (separate from state.json) ----
let saveChain = Promise.resolve();

// Load moderation state from its own file. Missing file => empty state, with a one-time migration
// from older builds that stored moderation inside data/state.json.
async function load() {
  try {
    loadModeration(JSON.parse(await fs.readFile(MODERATION_FILE, 'utf-8')));
    return;
  } catch (e) {
    if (e.code !== 'ENOENT') {
      loadModeration({});
      throw e;
    }
  }
  // One-time migration: pull moderation/agentIps out of a legacy state.json if present. Reading
  // an absent/invalid legacy file is optional; once valid security state is loaded, its required
  // persistence must reject on failure rather than being mistaken for "no legacy state".
  let legacy;
  try {
    legacy = JSON.parse(await fs.readFile(LEGACY_STATE_FILE, 'utf-8'));
  } catch (e) {
    if (e.code === 'ENOENT') {
      loadModeration({});
      return;
    }
    loadModeration({});
    throw e;
  }
  if (legacy && (legacy.moderation || legacy.agentIps)) {
    loadModeration(legacy);
    await save();
    console.warn('Migrated moderation state out of state.json into moderation.json');
    return;
  }
  loadModeration({});
}

// Persist moderation state atomically, serialized via a mutex to prevent interleaved writes.
function save() {
  const snapshot = serializeModeration();
  const operation = saveChain.then(() => _saveImpl(snapshot));
  // Keep the mutex usable after a failed operation, but return the original rejecting promise so
  // startup and security-critical routes cannot mistake a logged write failure for durability.
  saveChain = operation.catch(() => {});
  return operation;
}
async function _saveImpl(snapshot) {
  await fs.mkdir(path.dirname(MODERATION_FILE), { recursive: true });
  const tmp = MODERATION_FILE + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(snapshot, null, 2));
  await fs.rename(tmp, MODERATION_FILE);
}

function isHidden(path) { return hiddenFiles.has(normalizePath(path)); }
function hide(path) {
  const n = normalizePath(path);
  if (!n) return false;
  if (hiddenFiles.has(n)) return false;
  hiddenFiles.add(n);
  return true;
}
function unhide(path) { return hiddenFiles.delete(normalizePath(path)); }
function listHidden() { return Array.from(hiddenFiles); }

function quarantine(filePath, metadata = {}) {
  const normalized = normalizePublicationPath(filePath);
  if (!normalized || typeof metadata.contentHash !== 'string' || !metadata.contentHash) return false;
  const record = {
    filePath: normalized,
    contentHash: metadata.contentHash,
    reasons: Array.isArray(metadata.reasons) ? metadata.reasons.filter(reason => typeof reason === 'string') : [],
    agentName: typeof metadata.agentName === 'string' ? metadata.agentName : '',
    timestamp: typeof metadata.timestamp === 'string' ? metadata.timestamp : '',
  };
  const previous = quarantinedFiles.get(normalized);
  if (previous && JSON.stringify(previous) === JSON.stringify(record)) return false;
  quarantinedFiles.set(normalized, record);
  return true;
}

function releaseQuarantine(filePath) { return quarantinedFiles.delete(normalizePublicationPath(filePath)); }
function clearApproval(filePath) { return approvedFiles.delete(normalizePublicationPath(filePath)); }
function approve(filePath, hash) {
  const normalized = normalizePublicationPath(filePath);
  if (!normalized || typeof hash !== 'string' || !hash) return false;
  if (approvedFiles.get(normalized) === hash) return false;
  approvedFiles.set(normalized, hash);
  return true;
}
function reject(filePath) {
  const normalized = normalizePublicationPath(filePath);
  const removedQuarantine = quarantinedFiles.delete(normalized);
  const removedApproval = approvedFiles.delete(normalized);
  return removedQuarantine || removedApproval;
}
function isQuarantined(filePath) { return quarantinedFiles.has(normalizePublicationPath(filePath)); }
function isApproved(filePath, hash) {
  return typeof hash === 'string' && hash.length > 0 && approvedFiles.get(normalizePublicationPath(filePath)) === hash;
}
function listQuarantined() { return Array.from(quarantinedFiles.values()).map(record => ({ ...record, reasons: [...record.reasons] })); }

function setGitRepair(filePath, repair, status) {
  const normalized = normalizeGitRepair(filePath, { ...repair, status });
  if (!normalized) return false;
  const previous = gitRepairs.get(normalized.filePath);
  if (previous && JSON.stringify(previous) === JSON.stringify(normalized)) return false;
  gitRepairs.set(normalized.filePath, normalized);
  return true;
}
function armGitRepair(filePath, repair) {
  if (!repair?.fileState) return false;
  return setGitRepair(filePath, repair, 'armed');
}
function requireGitRepair(filePath, repair) { return setGitRepair(filePath, repair, 'required'); }
function clearGitRepair(filePath) { return gitRepairs.delete(normalizePublicationPath(filePath)); }
function isGitRepairRequired(filePath) {
  return gitRepairs.get(normalizePublicationPath(filePath))?.status === 'required';
}
function getGitRepair(filePath) {
  const repair = gitRepairs.get(normalizePublicationPath(filePath));
  return repair ? cloneGitRepair(repair) : null;
}
function listGitRepairs() { return Array.from(gitRepairs.values(), cloneGitRepair); }

const MAX_AGENT_IPS = 5000; // bound the IP map (GDPR data-minimization); evict oldest (LRU-ish)

function isBanned(agentName, ip) {
  return (typeof agentName === 'string' && bannedAgents.has(agentName)) ||
         (typeof ip === 'string' && bannedIps.has(ip));
}
function recordAgentIp(agentName, ip) {
  if (typeof agentName === 'string' && agentName && typeof ip === 'string' && ip) {
    if (agentIps.has(agentName)) agentIps.delete(agentName); // refresh insertion order (LRU)
    agentIps.set(agentName, ip);
    if (agentIps.size > MAX_AGENT_IPS) agentIps.delete(agentIps.keys().next().value);
  }
}
function resolveAgentIp(agentName) { return agentIps.get(agentName) || null; }
function snapshotAgentIps() { return Array.from(agentIps.entries()); }
function restoreAgentIps(snapshot) {
  if (!Array.isArray(snapshot)) return false;
  agentIps.clear();
  for (const entry of snapshot) {
    if (!Array.isArray(entry) || entry.length !== 2) continue;
    const [agentName, ip] = entry;
    if (typeof agentName === 'string' && agentName && typeof ip === 'string' && ip) {
      agentIps.set(agentName, ip);
    }
  }
  return true;
}
function restoreAgentIp(agentName, ip) {
  if (typeof agentName !== 'string' || !agentName) return false;
  if (typeof ip === 'string' && ip) {
    agentIps.delete(agentName);
    agentIps.set(agentName, ip);
    return true;
  }
  return agentIps.delete(agentName);
}
// Bans EXACTLY what is passed (no hidden IP auto-resolve — that decision lives in the endpoint,
// so "ban by name only" is always possible). See /api/admin/ban for the default-ban-IP behavior.
function ban({ agentName, ip } = {}) {
  if (agentName) bannedAgents.add(agentName);
  if (ip) bannedIps.add(ip);
  return listBans();
}
// Unban also drops the stored IP for that agent (honors the privacy promise: IPs removed on unban).
function unban({ agentName, ip } = {}) {
  let removed = false;
  if (agentName) {
    if (bannedAgents.delete(agentName)) removed = true;
    if (agentIps.delete(agentName)) removed = true;
  }
  if (ip && bannedIps.delete(ip)) removed = true;
  return removed;
}
function listBans() {
  return { bannedAgents: Array.from(bannedAgents), bannedIps: Array.from(bannedIps) };
}

// High-confidence scam/phishing markers (word-boundary, case-insensitive). Tuned for precision.
const BLOCKLIST = [
  /\bseed phrase\b/i,
  /\bconnect your wallet\b/i,
  /\bprivate key\b/i,
  /\bfree crypto\b/i,
  /\bclaim (your )?(free )?(airdrop|reward|prize)\b/i,
  /\bwallet validation\b/i,
];
// Operator-supplied hate/slur terms (locale-specific). Intentionally empty by default —
// extend this array in your deployment; the scanner runs regardless.
const SLUR_TERMS = [];

const MINER_RE = /(coinhive|cryptonight|eval\s*\(\s*atob\s*\(|new\s+function\s*\(\s*atob\s*\()/i;
const ALLOWED_SCRIPT_HOSTS = new Set(['analytics.codevena.dev']);

// Decode HTML numeric/named entities (incl. whitespace/zero-width ones attackers use to split a
// blocked phrase). Used both to normalize text for matching and to resolve a <script src> URL.
function decodeHtmlEntities(s) {
  return String(s || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ''; } })
    .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(parseInt(d, 10)); } catch { return ''; } })
    .replace(/&(amp|lt|gt|quot|apos|nbsp|ensp|emsp|thinsp|hairsp|zwnj|zwj|zwsp|ZeroWidthSpace|shy);/gi,
      (m, n) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ',
        thinsp: ' ', hairsp: ' ', zwnj: '', zwj: '', zwsp: '', zerowidthspace: '', shy: '' }[n.toLowerCase()] ?? m));
}

// Normalize text for blocklist/keyword matching: decode entities, strip HTML comments & inert tags
// (so `connect <span>your</span> wallet` and `connect<!--x--> your wallet` are caught), drop
// zero-width chars, NFKC, collapse whitespace.
function normalizeForScan(s) {
  return decodeHtmlEntities(s)
    .replace(/<!--[\s\S]*?-->/g, '')   // remove HTML comments (so wall<!--x-->et -> wallet)
    .replace(/<\/?[a-z][^>]*>/gi, '')  // remove inert tags (visible spacing comes from real whitespace, not tags)
    .replace(/[​-‍⁠﻿­]/g, '') // strip zero-width/joiner/word-joiner/BOM/soft-hyphen
    .normalize('NFKC')
    .replace(/\s+/g, ' '); // collapse NBSP/thin/en/em + runs to a single space so split phrases match
}

function scanContent({ content = '', message = '', agentName = '', filePath = '' } = {}) {
  const haystack = normalizeForScan(`${content}\n${message}\n${agentName}\n${filePath}`);
  for (const rule of BLOCKLIST) if (rule.test(haystack)) return { reason: 'blocklist', rule: rule.source };
  const lower = haystack.toLowerCase();
  for (const term of SLUR_TERMS) if (lower.includes(term.toLowerCase())) return { reason: 'blocklist', rule: 'slur' };
  if (MINER_RE.test(haystack)) return { reason: 'miner-or-obfuscation', rule: MINER_RE.source };
  // Find <script src=...> in raw content (the tag must be literal HTML). The URL VALUE, however,
  // is HTML-decoded by the browser, so decode + de-whitespace it before the host check — otherwise
  // `https:&#x2f;&#x2f;evil/x.js` (executable after decoding) would slip past the allowlist.
  const scriptSrcRe = /<script\b[^>]*\bsrc\s*=\s*["']?([^"'>\s]+)/gi;
  for (const m of content.matchAll(scriptSrcRe)) {
    let src = decodeHtmlEntities(m[1]).replace(/\s+/g, '');
    if (src.startsWith('//')) src = 'https:' + src;
    if (/^https?:\/\//i.test(src)) {
      let host;
      try { host = new URL(src).hostname.toLowerCase(); }
      catch { return { reason: 'external-script', rule: 'malformed-src' }; }
      if (!ALLOWED_SCRIPT_HOSTS.has(host)) return { reason: 'external-script', rule: host };
    }
  }
  return null;
}

module.exports = {
  loadModeration, serializeModeration, load, save,
  isHidden, hide, unhide, listHidden,
  quarantine, releaseQuarantine, clearApproval, approve, reject,
  isQuarantined, isApproved, listQuarantined,
  armGitRepair, requireGitRepair, clearGitRepair, isGitRepairRequired, getGitRepair, listGitRepairs,
  isBanned, recordAgentIp, resolveAgentIp, snapshotAgentIps, restoreAgentIps, restoreAgentIp,
  ban, unban, listBans,
  scanContent,
};
