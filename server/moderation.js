'use strict';

const path = require('path');
const fs = require('fs').promises;
const crypto = require('node:crypto');
const net = require('node:net');
const { normalizeWorldPath } = require('./world-files');

// Moderation state lives in its OWN server-only file (gitignored) so agent IPs / banned IPs are
// never written into the shared/tracked state.json or its backups.
const DATA_DIR = process.env.AIBUILDS_DATA_DIR || path.join(__dirname, '../data');
const MODERATION_FILE = path.join(DATA_DIR, 'moderation.json');
const LEGACY_STATE_FILE = path.join(DATA_DIR, 'state.json');
const MAX_REPAIR_FILE_BYTES = 500 * 1024;
const MAX_GIT_REPAIRS = 1000;
const MAX_TOTAL_REPAIR_FILE_BYTES = 8 * 1024 * 1024;
const MAX_MODERATION_FILE_BYTES = 16 * 1024 * 1024;
const MAX_AGENT_IPS = 5000;
const MAX_INDEX_ENTRIES = 4;
const MAX_WORLD_PATH_BYTES = 1024;
const MAX_WORLD_PATH_SEGMENTS = 64;
const MAX_WORLD_PATH_SEGMENT_BYTES = 255;
const MAX_AGENT_NAME_BYTES = 100;
const MAX_IP_BYTES = 64;
const MAX_TRANSACTION_ID_BYTES = 128;
const MAX_GIT_SUBJECT_BYTES = 2048;
const MAX_QUARANTINE_REASONS = 16;
const MAX_REASON_BYTES = 128;
const MAX_TIMESTAMP_BYTES = 64;
const GIT_OBJECT_ID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const GIT_MODE_RE = /^(?:100644|100755|120000|160000)$/;

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

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value, expected) {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value).sort();
  const expectedKeys = [...expected].sort();
  return actual.length === expectedKeys.length &&
    actual.every((key, index) => key === expectedKeys[index]);
}

function isBoundedString(value, maxBytes, { allowEmpty = false } = {}) {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0) ||
      Buffer.byteLength(value, 'utf8') > maxBytes || /[\x00-\x1f\x7f]/.test(value)) return false;
  // Reject unpaired UTF-16 surrogates: Node would otherwise map them to U+FFFD, letting two
  // distinct moderation/lock keys resolve to the same filesystem bytes.
  return Buffer.from(value, 'utf8').toString('utf8') === value;
}

function strictPublicationPath(value) {
  if (!isBoundedString(value, MAX_WORLD_PATH_BYTES)) return '';
  const segments = value.split('/');
  if (segments.length > MAX_WORLD_PATH_SEGMENTS ||
      segments.some(segment => Buffer.byteLength(segment, 'utf8') > MAX_WORLD_PATH_SEGMENT_BYTES)) return '';
  const normalized = normalizePublicationPath(value);
  return normalized === value ? normalized : '';
}

function normalizeCanonicalBase64(value) {
  const maxEncodedLength = Math.ceil(MAX_REPAIR_FILE_BYTES / 3) * 4;
  if (typeof value !== 'string' || value.length > maxEncodedLength ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return null;
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > MAX_REPAIR_FILE_BYTES || bytes.toString('base64') !== value) return null;
  return bytes;
}

function canonicalBase64ByteLength(value) {
  if (!value) return 0;
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

function normalizeGitEntry(entry, { allowStage = false } = {}) {
  const expectedKeys = allowStage ? ['hash', 'mode', 'stage'] : ['hash', 'mode'];
  if (!hasExactKeys(entry, expectedKeys) || !GIT_MODE_RE.test(entry.mode) ||
      !GIT_OBJECT_ID_RE.test(entry.hash)) return null;
  if (!allowStage) return { mode: entry.mode, hash: entry.hash };
  if (!Number.isInteger(entry.stage) || entry.stage < 0 || entry.stage > 3) return null;
  return { mode: entry.mode, hash: entry.hash, stage: entry.stage };
}

function normalizeGitRepairPublicationState(filePath, state) {
  if (state === null) return null;
  if (!hasExactKeys(state, ['approval', 'quarantine']) ||
      (state.approval !== null && !SHA256_RE.test(state.approval))) return null;
  let quarantine = null;
  if (state.quarantine !== null) {
    const record = state.quarantine;
    const normalized = strictPublicationPath(record?.filePath);
    if (!hasExactKeys(record, ['agentName', 'contentHash', 'filePath', 'reasons', 'timestamp']) ||
        normalized !== filePath || !SHA256_RE.test(record.contentHash) ||
        !Array.isArray(record.reasons) || record.reasons.length > MAX_QUARANTINE_REASONS ||
        record.reasons.some(reason => !isBoundedString(reason, MAX_REASON_BYTES)) ||
        !isBoundedString(record.agentName, MAX_AGENT_NAME_BYTES) ||
        !isBoundedString(record.timestamp, MAX_TIMESTAMP_BYTES)) return null;
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
  if (snapshot === null) return null;
  if (!Array.isArray(snapshot) || snapshot.length > MAX_AGENT_IPS || snapshot.some(entry => (
    !Array.isArray(entry) || entry.length !== 2 ||
    !isBoundedString(entry[0], MAX_AGENT_NAME_BYTES) ||
    !isBoundedString(entry[1], MAX_IP_BYTES) || net.isIP(entry[1]) === 0
  ))) return null;
  if (new Set(snapshot.map(entry => entry[0])).size !== snapshot.length) return null;
  return snapshot.map(entry => [...entry]);
}

function normalizeGitRepair(filePath, repair, { fromDisk = false } = {}) {
  const normalizedKey = strictPublicationPath(filePath);
  const normalized = strictPublicationPath(repair?.filePath);
  const gitPathState = repair?.gitPathState;
  const indexState = gitPathState?.indexState;
  const rawFileState = repair?.fileState;
  const fileBytes = hasExactKeys(rawFileState, ['bytesBase64', 'existed', 'sha256'])
    ? normalizeCanonicalBase64(rawFileState.bytesBase64)
    : null;
  const fileState = fileBytes === null ? null : {
    existed: rawFileState.existed,
    bytesBase64: rawFileState.bytesBase64,
    sha256: rawFileState.sha256,
  };
  const gitHash = repair?.gitHash;
  const storedStatus = repair?.status;
  const status = fromDisk ? 'required' : storedStatus;
  const contributionId = repair?.contributionId;
  const expectedGitSubject = repair?.expectedGitSubject;
  const publicationState = normalizeGitRepairPublicationState(normalized, repair?.publicationState);
  const agentIps = normalizeGitRepairAgentIps(repair?.agentIps);
  if (!hasExactKeys(repair, [
    'agentIps', 'contributionId', 'expectedGitSubject', 'filePath', 'fileState', 'gitHash',
    'gitPathState', 'publicationState', 'status',
  ]) || !normalizedKey || normalized !== normalizedKey ||
      (gitHash !== null && !GIT_OBJECT_ID_RE.test(gitHash)) ||
      !['armed', 'required'].includes(storedStatus) ||
      (contributionId !== null && !isBoundedString(contributionId, MAX_TRANSACTION_ID_BYTES)) ||
      !isBoundedString(expectedGitSubject, MAX_GIT_SUBJECT_BYTES) ||
      (repair.publicationState !== null && !publicationState) ||
      (repair.agentIps !== null && !agentIps) || !fileState ||
      typeof rawFileState.existed !== 'boolean' ||
      (!rawFileState.existed && rawFileState.bytesBase64 !== '') ||
      !SHA256_RE.test(rawFileState.sha256) ||
      crypto.createHash('sha256').update(fileBytes || Buffer.alloc(0)).digest('hex') !== rawFileState.sha256 ||
      !hasExactKeys(gitPathState, ['head', 'indexState', 'treeEntry']) ||
      !GIT_OBJECT_ID_RE.test(gitPathState.head) ||
      !hasExactKeys(indexState, ['assumeUnchanged', 'entries', 'skipWorktree']) ||
      !Array.isArray(indexState.entries) || indexState.entries.length > MAX_INDEX_ENTRIES ||
      typeof indexState.assumeUnchanged !== 'boolean' || typeof indexState.skipWorktree !== 'boolean') return null;
  const treeEntry = gitPathState.treeEntry === null
    ? null
    : normalizeGitEntry(gitPathState.treeEntry);
  if (gitPathState.treeEntry !== null && !treeEntry) return null;
  const entries = indexState.entries.map(entry => normalizeGitEntry(entry, { allowStage: true }));
  if (entries.some(entry => !entry)) return null;
  const stages = entries.map(entry => entry.stage);
  const hasStageZero = stages.includes(0);
  if (new Set(stages).size !== stages.length ||
      stages.some((stage, index) => index > 0 && stage <= stages[index - 1]) ||
      (hasStageZero && entries.length !== 1) ||
      (!hasStageZero && (indexState.assumeUnchanged || indexState.skipWorktree))) return null;
  return {
    filePath: normalized,
    gitHash,
    status,
    contributionId,
    expectedGitSubject,
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
    expectedGitSubject: repair.expectedGitSubject,
    publicationState: repair.publicationState ? {
      quarantine: repair.publicationState.quarantine
        ? { ...repair.publicationState.quarantine, reasons: [...repair.publicationState.quarantine.reasons] }
        : null,
      approval: repair.publicationState.approval,
    } : null,
    agentIps: repair.agentIps ? repair.agentIps.map(entry => [...entry]) : null,
    fileState: { ...repair.fileState },
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
  // Validate into isolated collections first. A malformed durable repair must never partially
  // replace live security state or become a truncated snapshot through a later save.
  const nextHiddenFiles = new Set();
  const nextBannedAgents = new Set();
  const nextBannedIps = new Set();
  const nextAgentIps = new Map();
  const nextQuarantinedFiles = new Map();
  const nextApprovedFiles = new Map();
  const nextGitRepairs = new Map();
  let totalRepairFileBytes = 0;
  const m = (state && state.moderation) || {};
  for (const p of m.hiddenFiles || []) nextHiddenFiles.add(normalizePath(p));
  for (const a of m.bannedAgents || []) nextBannedAgents.add(a);
  for (const ip of m.bannedIps || []) nextBannedIps.add(ip);
  const ips = (state && state.agentIps) || {};
  if (!isPlainObject(ips)) throw new Error('Invalid persisted agent IP state');
  const normalizedAgentIps = normalizeGitRepairAgentIps(Object.entries(ips));
  if (!normalizedAgentIps) throw new Error('Invalid persisted agent IP state');
  for (const [name, ip] of normalizedAgentIps) nextAgentIps.set(name, ip);
  for (const [filePath, record] of Object.entries(m.quarantinedFiles || {})) {
    const normalized = normalizePublicationPath(record?.filePath || filePath);
    if (!normalized || !record || typeof record !== 'object' || typeof record.contentHash !== 'string') continue;
    nextQuarantinedFiles.set(normalized, {
      filePath: normalized,
      contentHash: record.contentHash,
      reasons: Array.isArray(record.reasons) ? record.reasons.filter(reason => typeof reason === 'string') : [],
      agentName: typeof record.agentName === 'string' ? record.agentName : '',
      timestamp: typeof record.timestamp === 'string' ? record.timestamp : '',
    });
  }
  for (const [filePath, contentHash] of Object.entries(m.approvedFiles || {})) {
    const normalized = normalizePublicationPath(filePath);
    if (normalized && typeof contentHash === 'string' && contentHash) nextApprovedFiles.set(normalized, contentHash);
  }
  const persistedRepairs = state && Object.hasOwn(state, 'gitRepairs') ? state.gitRepairs : {};
  if (!isPlainObject(persistedRepairs)) throw new Error('Invalid durable Git repair registry');
  const repairEntries = Object.entries(persistedRepairs);
  if (repairEntries.length > MAX_GIT_REPAIRS) {
    throw new Error(`Durable Git repair registry exceeds ${MAX_GIT_REPAIRS} records`);
  }
  for (const [filePath, repair] of repairEntries) {
    // A persisted write-ahead marker means the previous process did not durably finish the Git
    // transaction. Treat both unfinished `armed` and explicit `required` records as repair-required.
    const normalized = normalizeGitRepair(filePath, repair, { fromDisk: true });
    if (!normalized) throw new Error(`Invalid durable Git repair state for ${filePath}`);
    totalRepairFileBytes += canonicalBase64ByteLength(normalized.fileState.bytesBase64);
    if (totalRepairFileBytes > MAX_TOTAL_REPAIR_FILE_BYTES) {
      throw new Error(`Durable Git repair preimages exceed ${MAX_TOTAL_REPAIR_FILE_BYTES} bytes`);
    }
    nextGitRepairs.set(normalized.filePath, normalized);
  }

  hiddenFiles.clear(); bannedAgents.clear(); bannedIps.clear(); agentIps.clear();
  quarantinedFiles.clear(); approvedFiles.clear(); gitRepairs.clear();
  for (const value of nextHiddenFiles) hiddenFiles.add(value);
  for (const value of nextBannedAgents) bannedAgents.add(value);
  for (const value of nextBannedIps) bannedIps.add(value);
  for (const entry of nextAgentIps) agentIps.set(...entry);
  for (const entry of nextQuarantinedFiles) quarantinedFiles.set(...entry);
  for (const entry of nextApprovedFiles) approvedFiles.set(...entry);
  for (const entry of nextGitRepairs) gitRepairs.set(...entry);
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

function moderationFileTooLargeError() {
  const error = new Error(`Moderation state exceeds ${MAX_MODERATION_FILE_BYTES} bytes`);
  error.code = 'ERR_MODERATION_FILE_TOO_LARGE';
  return error;
}

async function readModerationFile() {
  const stats = await fs.stat(MODERATION_FILE);
  if (stats.size > MAX_MODERATION_FILE_BYTES) throw moderationFileTooLargeError();
  const source = await fs.readFile(MODERATION_FILE, 'utf-8');
  if (Buffer.byteLength(source, 'utf8') > MAX_MODERATION_FILE_BYTES) {
    throw moderationFileTooLargeError();
  }
  return source;
}

// Load moderation state from its own file. Missing file => empty state, with a one-time migration
// from older builds that stored moderation inside data/state.json.
async function load() {
  try {
    loadModeration(JSON.parse(await readModerationFile()));
    return;
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
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
  let serialized;
  try {
    serialized = JSON.stringify(snapshot, null, 2);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_MODERATION_FILE_BYTES) {
      throw moderationFileTooLargeError();
    }
  } catch (error) {
    return Promise.reject(error);
  }
  const operation = saveChain.then(() => _saveImpl(serialized));
  // Keep the mutex usable after a failed operation, but return the original rejecting promise so
  // startup and security-critical routes cannot mistake a logged write failure for durability.
  saveChain = operation.catch(() => {});
  return operation;
}
async function _saveImpl(serialized) {
  await fs.mkdir(path.dirname(MODERATION_FILE), { recursive: true });
  const tmp = MODERATION_FILE + '.tmp';
  await fs.writeFile(tmp, serialized);
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
  if (!previous && gitRepairs.size >= MAX_GIT_REPAIRS) return false;
  let totalRepairFileBytes = canonicalBase64ByteLength(normalized.fileState.bytesBase64);
  for (const [existingPath, existing] of gitRepairs) {
    if (existingPath !== normalized.filePath) {
      totalRepairFileBytes += canonicalBase64ByteLength(existing.fileState.bytesBase64);
    }
  }
  if (totalRepairFileBytes > MAX_TOTAL_REPAIR_FILE_BYTES) return false;
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

function isBanned(agentName, ip) {
  return (typeof agentName === 'string' && bannedAgents.has(agentName)) ||
         (typeof ip === 'string' && bannedIps.has(ip));
}
function recordAgentIp(agentName, ip) {
  if (isBoundedString(agentName, MAX_AGENT_NAME_BYTES) &&
      isBoundedString(ip, MAX_IP_BYTES) && net.isIP(ip) !== 0) {
    if (agentIps.has(agentName)) agentIps.delete(agentName); // refresh insertion order (LRU)
    agentIps.set(agentName, ip);
    if (agentIps.size > MAX_AGENT_IPS) agentIps.delete(agentIps.keys().next().value);
  }
}
function resolveAgentIp(agentName) { return agentIps.get(agentName) || null; }
function snapshotAgentIps() { return Array.from(agentIps.entries()); }
function restoreAgentIps(snapshot) {
  const normalized = normalizeGitRepairAgentIps(snapshot);
  if (!normalized) return false;
  agentIps.clear();
  for (const [agentName, ip] of normalized) agentIps.set(agentName, ip);
  return true;
}
function restoreAgentIp(agentName, ip) {
  if (!isBoundedString(agentName, MAX_AGENT_NAME_BYTES)) return false;
  if (isBoundedString(ip, MAX_IP_BYTES) && net.isIP(ip) !== 0) {
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
