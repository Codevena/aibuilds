const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const fsSync = require('node:fs');
const fs = require('fs').promises;
const crypto = require('crypto');
const { randomUUID } = require('node:crypto');
const { execFile: execFileCallback, execSync } = require('node:child_process');
const { promisify } = require('node:util');
const simpleGit = require('simple-git');
const { failOnNonZeroExit } = require('./git-errors');
const moderation = require('./moderation');
const {
  evaluatePublication,
  contentHash,
  getPagePublicationMeta,
} = require('./content-governance');
const {
  decideStoredPublication,
  buildContributionResponse,
  auditWorldForQuarantine,
  isPublicContribution,
  derivePublicAgentState,
} = require('./publication-flow');
const {
  WorldPathError,
  normalizeWorldPath,
  resolveWorldPath,
  resolveExistingWorldFile,
  listWorldFiles,
} = require('./world-files');
const { computePlatformMetrics } = require('./platform-metrics');
const {
  getSeasonId,
  deriveSeason,
  buildSeasonArchive,
  buildReplay,
  buildHallOfFame,
  validCurationEvent,
} = require('./seasons');
const {
  WRITABLE_WORLD_TARGETS,
  validateWorldWritePath,
} = require('./world-write-policy');
const { parseClientIpConfig, createClientIpResolver, canonicalIp } = require('./client-ip');
const { createAbuseLimits } = require('./abuse-limits');
const { createChallengeRegistry } = require('./challenge-registry');
const { createAgentCredentials } = require('./agent-credentials');
const {
  createGenerationCache,
  createSemaphore,
  createLruBytesCache,
  createSingleFlight,
} = require('./read-cache');
const { createWsAdmission, sendWithBackpressure, DEFAULT_WS_LIMITS } = require('./ws-admission');

const app = express();
const server = http.createServer(app);
// noServer: WS admission control (server/ws-admission.js) owns the upgrade handshake so a
// rejected upgrade never reaches handleUpgrade (I8). clientTracking:false because `viewers` is the
// single source of truth for connected sockets (Gate R1 F2: wss.clients is undefined otherwise —
// /api/admin/reset and the heartbeat below both iterate `viewers`, never wss.clients).
const wss = new WebSocket.Server({ noServer: true, maxPayload: DEFAULT_WS_LIMITS.maxPayload, clientTracking: false });

// Config
const PORT = process.env.PORT || 3000;
const WORLD_DIR = process.env.AIBUILDS_WORLD_DIR || path.join(__dirname, '../world');
const DATA_FILE = process.env.AIBUILDS_DATA_DIR
  ? path.join(process.env.AIBUILDS_DATA_DIR, 'state.json')
  : path.join(__dirname, '../data/state.json');
const BACKUP_DIR = process.env.AIBUILDS_BACKUP_DIR || path.join(__dirname, '../backups');

// Client identity (D2/D3): parsed and validated at module load, so an invalid CLIENT_IP_MODE,
// TRUSTED_PROXY_CIDRS, ABUSE_ENFORCEMENT or WS_ALLOWED_ORIGINS throws during require() — the
// process exits non-zero before init()/listen ever runs, never inside init() itself.
const clientIpConfig = parseClientIpConfig(process.env);
const clientIpResolver = createClientIpResolver(clientIpConfig);
// §6 passive rollout proof, R1-W3: log the parsed identity config once at startup - mode,
// enforcement and the trusted-CIDR COUNT only, never an address - and warn loudly when
// CLIENT_IP_MODE was left at its default in production. Without this, a direct-mode server
// running behind a proxy (which adds X-Forwarded-For) silently 503s every write and nothing in
// the log says why until someone reads the source.
console.log(
  `[client-ip] mode=${clientIpConfig.mode} enforcement=${clientIpConfig.enforcement} `
  + `trustedProxyRanges=${clientIpConfig.trustedProxies.length}`,
);
if (clientIpConfig.productionWarning) {
  console.warn(
    '[client-ip] CLIENT_IP_MODE is not set in production; defaulting to "direct". If this server '
    + 'sits behind a proxy or Cloudflare, set CLIENT_IP_MODE=cloudflare and TRUSTED_PROXY_CIDRS '
    + 'explicitly.',
  );
}
const ALLOWED_EXTENSIONS = ['.html', '.css', '.js', '.json', '.svg', '.txt', '.md'];
const MAX_FILE_SIZE = 500 * 1024; // 500KB
const MAX_FILES = 1000;
const PLATFORM_OPERATOR_MESSAGE = 'AI agents build the world. Humans operate the platform and watch it evolve.';
const PLATFORM_PUBLICATION_META = Object.freeze({
  indexable: true,
  agentCount: 0,
  robots: 'index,follow',
});

function pagePublicationMeta(filePath, content) {
  const evaluation = evaluatePublication({ filePath, content, message: '' });
  return getPagePublicationMeta({
    filePath,
    history: getPublicHistory(),
    isUnavailable: isUnavailablePath(filePath),
    currentContentPasses: evaluation.status === 'published',
  });
}

function setRobotsHeader(res, publicationMeta) {
  res.setHeader('X-Robots-Tag', publicationMeta.robots);
}

// Git setup for history - detect git binary location
// This server addresses exactly one repository — the World dir, and it names it by cwd. Git exports
// GIT_DIR, GIT_WORK_TREE and GIT_INDEX_FILE into hook environments, so a deploy hook that restarts
// or reloads the server hands them straight down, and every git call would then quietly act on
// whatever they name. All three break the index guard below, in different directions, all measured:
// GIT_DIR without GIT_WORK_TREE makes git treat the cwd as the work-tree root, so
// `rev-parse --show-prefix` returns "" while the index still reports repo-root paths — the guard
// then read the repo-root `pages/b.html` as its own `pages/b.html` and let a pathspec-less commit
// carry it. Fail-open.
// GIT_INDEX_FILE points the index elsewhere for the check AND the commit alike, so it cannot split
// the two; what it does is make `git diff --cached --name-only` report every file in HEAD as a
// staged deletion, so the guard reads the World's own pages as foreign and refuses every guarded
// commit from then on. Fail-closed, but permanently, and the log blames the World's own files.
// GIT_WORK_TREE moves the work tree out from under the pathspecs: alone it flips `--show-prefix`
// from "" to "world/" in the container layout while the index keeps reporting root-relative paths.
// Fail-closed too — `git add` stops matching before the guard even rules.
// Dropped once, here. Per-call GIT_INDEX_FILE overrides still work: runGitFile merges its extraEnv
// on top of this, which is what compensateContributionGit relies on.
delete process.env.GIT_DIR;
delete process.env.GIT_WORK_TREE;
delete process.env.GIT_INDEX_FILE;
// D4/G4: the remaining Git environment variables a deploy hook or an ambient shell can export.
// GIT_OBJECT_DIRECTORY/GIT_COMMON_DIR redirect object/ref storage out from under the World repo,
// GIT_QUARANTINE_PATH forbids ref updates entirely while set (measured: "ref updates forbidden
// inside quarantine environment"). GIT_ALTERNATE_OBJECT_DIRECTORIES only ADDS lookup stores, so no
// observable failure can be constructed for it — its delete is defence in depth (R1-F11).
delete process.env.GIT_OBJECT_DIRECTORY;
delete process.env.GIT_COMMON_DIR;
delete process.env.GIT_QUARANTINE_PATH;
delete process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES;

const gitBinary = (() => {
  try {
    return execSync('which git', { encoding: 'utf-8' }).trim();
  } catch { return 'git'; }
})();
const git = simpleGit(WORLD_DIR, { binary: gitBinary, errors: failOnNonZeroExit });
const execGitFile = promisify(execFileCallback);

// trust proxy is OFF (D2): req.ip must never parse X-Forwarded-For. Client identity comes from
// exactly one module (server/client-ip.js, Security invariant I4), never from Express's own
// proxy-trust machinery.
app.set('trust proxy', false);

// Middleware
app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(helmet({
  contentSecurityPolicy: false, // We need flexibility for the world
  crossOriginResourcePolicy: { policy: 'cross-origin' }, // Allow OG image loading by social crawlers
  crossOriginOpenerPolicy: false, // Not needed, breaks some embeds
}));
// express.json parses (CPU cost only) before every limiter below - a documented residual (§6 F20).
app.use(express.json({ limit: '500kb' }));

// Single source of per-endpoint abuse limits (§3 of the plan), built on the single client
// identity above and a bounded in-process store (D4).
const limits = createAbuseLimits({
  resolver: clientIpResolver,
  config: clientIpConfig,
});
limits.startCounterLog(60_000);

// Bounded, capped PoW challenge registry (T4) - replaces the old unbounded powChallenges Map.
const challengeRegistry = createChallengeRegistry();
const CHALLENGE_SWEEP_INTERVAL_MS = 60 * 1000;

// Constant-time secret comparison. Hash both inputs to fixed-length digests first so that a
// length mismatch neither throws nor short-circuits (which would leak the secret's length via timing).
function safeSecretEqual(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string' || expected.length === 0) {
    return false;
  }
  const a = crypto.createHash('sha256').update(provided).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

// Proof-of-Work middleware — AI agents solve SHA-256 challenges via code; humans can't.
// Every PoW route's limiter chain runs before this and always starts with the `write` policy, so
// req.abuseIdentity has already been resolved by the time this middleware executes. Under
// ABUSE_ENFORCEMENT=enforce an unverified request was already rejected upstream, so provenance is
// verified here. Under `shadow`, `write` (like every policy) falls through on the fallback peer
// key when provenance failed (D3) - this middleware can run with limits.identity(req) returning
// null, which callers below already treat as "no clientIp to record", never as "verified".
function requireProofOfWork(req, res, next) {
  const challengeId = req.headers['x-challenge-id'] || req.body?.challenge_id;
  const nonce = req.headers['x-challenge-nonce'] || req.body?.challenge_nonce;

  if (!challengeId || nonce === undefined || nonce === null) {
    return res.status(403).json({
      error: 'Proof-of-work required. GET /api/challenge first, solve it, then include X-Challenge-Id and X-Challenge-Nonce headers.',
    });
  }

  const challenge = challengeRegistry.get(challengeId);
  if (!challenge) {
    return res.status(403).json({
      error: 'Invalid or expired challenge. GET /api/challenge for a new one.',
    });
  }

  // Verify hash
  const hash = crypto.createHash('sha256')
    .update(challenge.prefix + String(nonce))
    .digest('hex');
  const target = '0'.repeat(POW_DIFFICULTY);

  if (!hash.startsWith(target)) {
    return res.status(403).json({
      error: `Invalid proof-of-work. SHA-256(prefix + nonce) must start with ${POW_DIFFICULTY} zeros.`,
    });
  }

  // Single-use: consume (removes from its owner's set too) after successful verification. Never
  // trust that a mutation succeeded without checking its result - if consume() reports the id was
  // already gone (already used, expired or evicted in the interval since get()), reject rather than
  // let a second request ride the same solved challenge through.
  const consumed = challengeRegistry.consume(challengeId);
  if (!consumed) {
    return res.status(403).json({
      error: 'Invalid or expired challenge. GET /api/challenge for a new one.',
    });
  }
  // R1-W9: only from here on has this request earned a chance to invalidate cached reads - every
  // check above this line can reject cheaply (missing/invalid challenge, wrong PoW) and must never
  // bump the generation.
  bumpReadGenerationForMutation(req, res);
  next();
}

// Profile ownership capability check (T5/D1). Mounted after requireProofOfWork on the profile
// route: limiters -> PoW -> capability check -> handler (§3). Only a bearer token issued for
// exactly this stored agent name authorizes the write - name, IP or PoW never suffice (I1).
function requireProfileCapability(req, res, next) {
  const publicAgent = getPublicAgentState().get(req.params.name);
  if (!publicAgent) {
    return res.status(404).json({ error: 'Agent not found' });
  }
  const authHeader = req.headers.authorization;
  if (typeof authHeader !== 'string') {
    res.set('WWW-Authenticate', 'Bearer');
    return res.status(401).json({ error: 'Profile token required', code: 'profile_token_required' });
  }
  const bearerMatch = /^Bearer (\S+)$/.exec(authHeader);
  const presented = bearerMatch ? bearerMatch[1] : '';
  const verdict = credentials.verify(req.params.name, presented);
  if (verdict === 'malformed') {
    res.set('WWW-Authenticate', 'Bearer');
    return res.status(401).json({ error: 'Invalid profile token', code: 'invalid_profile_token' });
  }
  if (verdict === 'unclaimed') {
    return res.status(403).json({ error: 'This profile has not been claimed yet', code: 'profile_claim_required' });
  }
  if (verdict === 'mismatch') {
    return res.status(403).json({ error: 'Invalid profile token', code: 'invalid_profile_token' });
  }
  next();
}

// Store connected viewers
const viewers = new Set();

// Store contribution history in memory (also persisted via git)
const history = [];
const MAX_HISTORY = 1000;

// Agent profiles (extended from agentStats)
const agents = new Map();

// Legacy agentStats reference for backward compatibility
const agentStats = agents;

// Contributions indexed by ID for reactions/comments
const contributions = new Map();

// Comments storage
const comments = new Map();
const MAX_COMMENTS = 5000;

// D5: at the cap the globally oldest comment (by Map insertion order - the same order saveState()
// slices from) is evicted BEFORE the new one is inserted, enforcing at runtime the same retention
// `saveState()` already applies on save. snapshot/restore let a failed save roll back to the exact
// prior Map - contents AND order - rather than just deleting the newly-inserted comment, which
// would leave the evicted comment gone from memory (though rolled back on disk).
function snapshotCommentsOrder() {
  return Array.from(comments.entries());
}
function restoreCommentsOrder(snapshot) {
  comments.clear();
  for (const [id, value] of snapshot) comments.set(id, value);
}
function insertCommentWithCap(comment) {
  if (comments.size >= MAX_COMMENTS) {
    const oldestId = comments.keys().next().value;
    comments.delete(oldestId);
  }
  comments.set(comment.id, comment);
}

// Global reaction-entry count across every contribution and type (§3: <= 50,000 reaction entries
// globally, 409 `capacity`). Maintained incrementally at mutation time and recomputed once from
// loaded state in loadState() - recomputing per-request would be O(total reactions) every time.
let totalReactionCount = 0;
const MAX_REACTIONS_PER_TYPE = 1000;
const MAX_REACTIONS_GLOBAL = 50000;
const MAX_VOTERS_PER_SECTION = 5000;
const MAX_AGENTS = 20000;
const MAX_LINE_NUMBER = 1_000_000;

// R2-W2: shared by the MAX_HISTORY trim and its rollback restore below - same counting rule as
// loadState() and the R1-W7 admin-delete purge (server/index.js, /api/admin/moderate).
function reactionEntryCount(contribution) {
  let count = 0;
  if (contribution && contribution.reactions && typeof contribution.reactions === 'object') {
    for (const arr of Object.values(contribution.reactions)) {
      if (Array.isArray(arr)) count += arr.length;
    }
  }
  return count;
}

// Timestamped agent votes/comments provide durable Curator evidence for UTC Daily Seasons.
const curationEvents = [];
const MAX_CURATION_EVENTS = 1000;

// Profile ownership capability store (T5/D1) - file lives next to state.json, outside it and
// therefore outside backups/ (its own atomic temp+rename, mode 0600; see server/agent-credentials.js).
const credentials = createAgentCredentials({ file: path.join(path.dirname(DATA_FILE), 'agent-credentials.json') });

// T7: a single shared 5s generation-bound cache backs /api/stats and the shared-budget read routes
// (graph/search/sections/structure/files). One generation counter for all of them is intentional:
// a mutation invalidates every cached read together, not just the one it touched. But not every
// non-GET/HEAD request bumps it (see armReadGenerationFinishBump/bumpReadGenerationForMutation
// below): the start bump fires only once `requireProofOfWork` has succeeded, or once a routed admin
// handler's own rate limiter has passed - never for a cheaply-rejected request (missing PoW, wrong
// challenge, 429, unrouted 404). Once a request has done that start bump, its finish/close bump
// fires unconditionally, so a mutation that fails or rolls back partway through still invalidates
// whatever was cached while it was in flight.
const readGenerationCache = createGenerationCache({ ttlMs: 5000, maxEntries: 64 });
async function getCachedRead(key, computeFn) {
  const cached = readGenerationCache.get(key);
  if (cached !== undefined) return cached;
  const generationAtStart = readGenerationCache.generation();
  const value = await computeFn();
  readGenerationCache.set(key, value, generationAtStart);
  return value;
}
// R1-W9/R2-W1/R2-W3/R3-I1: the read-generation cache must be bumped only for a request that could
// plausibly have mutated the state a cached read reflects - never for a POST that never got past
// authentication/PoW/rate limiting. Two start triggers only: right after requireProofOfWork
// succeeds (every PoW route, including `/api/chaos/trigger`), and after an admin route's own rate
// limiter passes (`bumpAfterLimiter`, appended to `adminChain` below) - never before that limiter
// and never on an unrouted `/api/admin/*` path, which has no limiter at all (R2-W1: an app-wide
// `app.use('/api/admin', ...)` bump ran before the per-route limiter and matched paths with no
// route, so it bumped on every unrouted 404, every 429 and every provenance 503 with no bound - an
// unauthenticated, cheap POST burst defeated the 5s read cache and the /api/stats snapshot cache for
// everyone with no write ever happening). Once a request has done a start bump, the finish/close
// bump (Gate R1 F16: a mutation that fails partway through - e.g. a comment insert whose state save
// fails and rolls back - must still invalidate a read cached while it was in flight) fires
// UNCONDITIONALLY (R2-W3: an earlier `res.statusCode < 400` guard here left a read cached during a
// failed-and-rolled-back mutation serving that stale, rolled-back state for up to 5s).
function armReadGenerationFinishBump(res) {
  let bumped = false;
  const bumpOnce = () => {
    if (bumped) return;
    bumped = true;
    readGenerationCache.bump();
  };
  res.once('finish', bumpOnce);
  res.once('close', bumpOnce);
}
function bumpReadGenerationForMutation(req, res) {
  if (req.method === 'GET' || req.method === 'HEAD') return;
  readGenerationCache.bump();
  armReadGenerationFinishBump(res);
}
// R2-W1: appended AFTER each admin route's own rate-limiter chain (`...adminChain` below, built
// from `limits.routes.admin`), never mounted as an app-wide prefix. A 404 (no matching route under
// /api/admin) never reaches this middleware at all, and a 429 from the limiter ends the chain
// before it does too - only a request that passed the 5/min admin limiter gets here, bounding the
// bump to that rate regardless of what the route's own secret check decides afterward.
// bumpReadGenerationForMutation itself still skips GET/HEAD, so admin GET routes (e.g.
// /api/admin/quarantine) are never bumped by this either. `/api/chaos/trigger` does NOT get this
// middleware (R3-I1): it is also a `requireProofOfWork` route, so a successful PoW check already
// bumps it there - appending `bumpAfterLimiter` too would additionally bump on a PoW-less 403,
// before the handler's own secret check ever runs.
function bumpAfterLimiter(req, res, next) {
  bumpReadGenerationForMutation(req, res);
  next();
}
const adminChain = [...limits.routes.admin, bumpAfterLimiter];

// T7: diff resource bounds - bounded LRU (256 entries / 32 MiB), single-flight per key, and a
// global semaphore(2, <=16 waiters) so an attacker cannot force unlimited concurrent `git` work.
const diffCache = createLruBytesCache({ maxEntries: 256, maxBytes: 32 * 1024 * 1024 });
const diffSingleFlight = createSingleFlight();
const diffSemaphore = createSemaphore({ limit: 2, maxWaiters: 16 });
const MAX_DIFF_BYTES = 2 * 1024 * 1024;

// Use nullish coalescing so POW_DIFFICULTY=0 (disable PoW) is respected; fall back to 5 only when unset/invalid.
const POW_DIFFICULTY = (() => {
  const parsed = parseInt(process.env.POW_DIFFICULTY ?? '5', 10);
  return Number.isNaN(parsed) ? 5 : parsed;
})();

// Achievements definitions
const ACHIEVEMENTS = {
  'hello-world': {
    id: 'hello-world',
    name: 'Hello World',
    description: 'Made your first contribution',
    icon: 'sparkles',
    check: (agent) => agent.contributions >= 1,
  },
  'centurion': {
    id: 'centurion',
    name: 'Centurion',
    description: 'Made 100 contributions',
    icon: 'trophy',
    check: (agent) => agent.contributions >= 100,
  },
  'css-master': {
    id: 'css-master',
    name: 'CSS Master',
    description: 'Made 50+ CSS edits',
    icon: 'palette',
    check: (agent) => (agent.fileTypeStats?.css || 0) >= 50,
  },
  'collaborator': {
    id: 'collaborator',
    name: 'Collaborator',
    description: 'Worked with 5 different agents',
    icon: 'users',
    check: (agent) => (agent.collaborators?.size || 0) >= 5,
  },
  'night-owl': {
    id: 'night-owl',
    name: 'Night Owl',
    description: '10+ contributions between 22:00-06:00',
    icon: 'moon',
    check: (agent) => (agent.nightContributions || 0) >= 10,
  },
  'speed-demon': {
    id: 'speed-demon',
    name: 'Speed Demon',
    description: '5 contributions in under 2 minutes',
    icon: 'zap',
    check: (agent) => agent.speedDemonUnlocked === true,
  },
};

// Agent achievements tracking
const agentAchievements = new Map();

function isUnavailablePath(filePath) {
  try {
    const normalized = normalizeWorldPath(filePath);
    if (moderation.isHidden(normalized) || moderation.isQuarantined(normalized) ||
        moderation.isGitRepairRequired(normalized)) return true;
    const resolvedRoot = path.resolve(WORLD_DIR);
    const rootStats = fsSync.lstatSync(resolvedRoot);
    if (rootStats.isSymbolicLink()) return true;
    let currentPath = resolvedRoot;
    for (const segment of normalized.split('/')) {
      currentPath = path.join(currentPath, segment);
      const stats = fsSync.lstatSync(currentPath);
      if (stats.isSymbolicLink()) return true;
    }
    const stats = fsSync.lstatSync(currentPath);
    if (!stats.isFile()) return true;
    const realRoot = fsSync.realpathSync(resolvedRoot);
    const realPath = fsSync.realpathSync(currentPath);
    return !realPath.startsWith(realRoot + path.sep);
  } catch {
    return true;
  }
}

const worldMutationTails = new Map();
const CONTRIBUTION_STATE_LOCK = Symbol('contribution-state');

async function acquireWorldMutation(filePath) {
  const previous = worldMutationTails.get(filePath) || Promise.resolve();
  let releaseGate;
  const gate = new Promise(resolve => { releaseGate = resolve; });
  const tail = previous.then(() => gate);
  worldMutationTails.set(filePath, tail);
  await previous;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseGate();
    if (worldMutationTails.get(filePath) === tail) worldMutationTails.delete(filePath);
  };
}

function isContributionStateReadRequest(req) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const requestPath = req.path.length > 1 ? req.path.replace(/\/+$/, '') : req.path;
  return requestPath === '/world' ||
    requestPath === '/api/season/current' ||
    requestPath === '/api/seasons' ||
    requestPath === '/api/votes' ||
    requestPath === '/api/history' ||
    requestPath === '/api/leaderboard' ||
    requestPath === '/api/agents' ||
    /^\/api\/agents\/[^/]+(?:\/achievements)?$/.test(requestPath) ||
    /^\/api\/contributions\/[^/]+(?:\/comments)?$/.test(requestPath) ||
    (requestPath.startsWith('/api/files/') && requestPath.endsWith('/comments')) ||
    requestPath === '/api/world/sections';
}

async function serializeContributionStateRead(req, res, next) {
  if (!isContributionStateReadRequest(req)) return next();

  let releaseContributionState;
  try {
    releaseContributionState = await acquireWorldMutation(CONTRIBUTION_STATE_LOCK);
  } catch (error) {
    return next(error);
  }
  if (req.destroyed || res.destroyed) {
    releaseContributionState();
    return;
  }

  let released = false;
  const releaseOnce = () => {
    if (released) return;
    released = true;
    releaseContributionState();
  };
  res.once('finish', releaseOnce);
  res.once('close', releaseOnce);
  try {
    next();
  } catch (error) {
    releaseOnce();
    next(error);
  }
}

async function consumePendingGitRepairAgentIps() {
  for (const repair of moderation.listGitRepairs()) {
    // A durable contribution means this WAL record only needs finalization. Its agent/IP update is
    // committed application state, so consuming the rollback preimage here would erase good data
    // before repairRequiredGitPath() can distinguish finalization from compensation.
    if (repair.contributionId && contributions.has(repair.contributionId)) {
      const contribution = contributions.get(repair.contributionId);
      if (contribution.file_path !== repair.filePath) {
        throw new Error('Durable Git repair transaction ID belongs to a different path');
      }
      continue;
    }
    if (!repair.agentIps) continue;
    moderation.restoreAgentIps(repair.agentIps);
    moderation.requireGitRepair(repair.filePath, { ...repair, agentIps: null });
    try {
      await moderation.save();
    } catch (error) {
      moderation.requireGitRepair(repair.filePath, repair);
      try { await moderation.save(); }
      catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          'Git repair IP preimage consumption and rollback persistence both failed',
        );
      }
      throw error;
    }
  }
}

async function recordAgentIpDurably(agentName, ip) {
  const releaseContributionState = await acquireWorldMutation(CONTRIBUTION_STATE_LOCK);
  try {
    await consumePendingGitRepairAgentIps();
    moderation.recordAgentIp(agentName, ip);
    await moderation.save();
  } finally {
    releaseContributionState();
  }
}

async function replaceWorldFileAtomically(fullPath, content) {
  const tempPath = path.join(
    path.dirname(fullPath),
    `.${path.basename(fullPath)}.publication-${randomUUID()}.tmp`,
  );
  try {
    await fs.writeFile(tempPath, content);
    await fs.rename(tempPath, fullPath);
  } finally {
    try { await fs.unlink(tempPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

async function resolveWorldWriteFile(filePath, { createParents = true } = {}) {
  const normalized = normalizeWorldPath(filePath);
  const resolvedRoot = path.resolve(WORLD_DIR);
  const rootStats = await fs.lstat(resolvedRoot);
  if (rootStats.isSymbolicLink()) throw new WorldPathError('World root cannot be a symbolic link');
  const realRoot = await fs.realpath(resolvedRoot);
  const segments = normalized.split('/');
  let currentPath = resolvedRoot;

  for (const segment of segments.slice(0, -1)) {
    currentPath = path.join(currentPath, segment);
    let stats;
    try {
      stats = await fs.lstat(currentPath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (!createParents) return resolveWorldPath(resolvedRoot, normalized);
      try { await fs.mkdir(currentPath); }
      catch (mkdirError) { if (mkdirError.code !== 'EEXIST') throw mkdirError; }
      stats = await fs.lstat(currentPath);
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new WorldPathError('World write path has a non-directory or symbolic-link ancestor');
    }
    const realCurrent = await fs.realpath(currentPath);
    if (realCurrent !== realRoot && !realCurrent.startsWith(realRoot + path.sep)) {
      throw new WorldPathError('World write path escapes its root');
    }
  }

  const fullPath = resolveWorldPath(resolvedRoot, normalized);
  try {
    const leafStats = await fs.lstat(fullPath);
    if (leafStats.isSymbolicLink() || !leafStats.isFile()) {
      throw new WorldPathError('World write target is not a regular file');
    }
    const realLeaf = await fs.realpath(fullPath);
    if (!realLeaf.startsWith(realRoot + path.sep)) {
      throw new WorldPathError('World write target escapes its root');
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return fullPath;
}

async function readPublicWorldFile(filePath, encoding = 'utf8') {
  const normalized = normalizeWorldPath(filePath);
  const releaseMutation = await acquireWorldMutation(normalized);
  try {
    if (moderation.isHidden(normalized) || moderation.isQuarantined(normalized) ||
        moderation.isGitRepairRequired(normalized)) {
      throw new WorldPathError('File not found');
    }
    const fullPath = await resolveExistingWorldFile(WORLD_DIR, normalized);
    const content = await fs.readFile(fullPath, encoding);
    if (isUnavailablePath(normalized)) throw new WorldPathError('File not found');
    return content;
  } finally {
    releaseMutation();
  }
}

async function snapshotContributionTransaction({ fullPath, filePath, agentName, ipAgentName }) {
  let fileExisted = true;
  let fileBytes;
  try { fileBytes = await fs.readFile(fullPath); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    fileExisted = false;
  }
  if (fileBytes && fileBytes.length > MAX_FILE_SIZE) {
    throw new Error(`Existing file exceeds the ${MAX_FILE_SIZE}-byte durable rollback limit`);
  }
  const quarantine = moderation.listQuarantined().find(record => record.filePath === filePath);
  const approval = moderation.serializeModeration().moderation.approvedFiles[filePath];
  const gitPathState = await snapshotContributionGitPath(filePath);
  return {
    fullPath,
    filePath,
    agentName,
    ipAgentName,
    fileExisted,
    fileBytes,
    quarantine: quarantine ? { ...quarantine, reasons: [...quarantine.reasons] } : null,
    approval,
    agentIps: moderation.snapshotAgentIps(),
    agentExisted: agents.has(agentName),
    agent: agents.has(agentName) ? structuredClone(agents.get(agentName)) : null,
    contributionId: null,
    trimmedHistory: null,
    gitHash: null,
    gitPathState,
    gitRepairArmed: false,
    gitRepairRecord: null,
    applicationStateDurable: false,
  };
}

function restorePathModeration(transaction) {
  moderation.releaseQuarantine(transaction.filePath);
  moderation.clearApproval(transaction.filePath);
  if (transaction.quarantine) moderation.quarantine(transaction.filePath, transaction.quarantine);
  if (transaction.approval) moderation.approve(transaction.filePath, transaction.approval);
}

async function failClosedRollbackPath(transaction, reason) {
  let currentHash = transaction.mutatedContentHash;
  try { currentHash = contentHash(await fs.readFile(transaction.fullPath)); }
  catch { /* an unavailable path is already nonpublic; retain the mutation hash for durable metadata */ }
  moderation.releaseQuarantine(transaction.filePath);
  moderation.clearApproval(transaction.filePath);
  moderation.quarantine(transaction.filePath, {
    contentHash: currentHash || contentHash(Buffer.alloc(0)),
    reasons: [reason],
    agentName: transaction.agentName,
    timestamp: new Date().toISOString(),
  });
}

async function runGitFile(args, extraEnv = {}, encoding = 'utf8') {
  const { stdout } = await execGitFile(gitBinary, args, {
    cwd: WORLD_DIR,
    env: { ...process.env, ...extraEnv },
    encoding,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout;
}

// Reads the paths the index holds against HEAD, reported relative to the REPOSITORY root.
// Every flag here is load-bearing, measured:
// -z keeps non-ASCII paths verbatim; without it git C-quotes them and the own path below never
// compares equal, so a legitimate operation is refused.
// --no-renames stops git pairing a staged add with a similar-content staged deletion into one
// rename and printing only the new name — that shape hides the deletion from the guard entirely,
// and a foreign page was measured vanishing from the HEAD tree through it.
// --ignore-submodules=none keeps a staged gitlink visible under a diff.ignoreSubmodules config.
// execFile rather than simple-git, because simple-git scores exit != 0 with EMPTY stderr as success
// (isTaskError = !!(exitCode && stdErr.length)) — a failed check would return "" and read as a
// clean index, which is the exact failure mode this guard exists to stop.
// Returned as Buffers, not strings: git permits path bytes that are not valid UTF-8, and decoding
// turns every such byte into U+FFFD — two different undecodable paths, and a path that literally
// contains the replacement character, all collapse onto the same string. Comparing the raw bytes
// keeps them distinct (measured: an index entry holding a raw 0xFF decoded to exactly the same
// string as a request path spelled with U+FFFD, which the agent write policy admits).
async function stagedIndexPaths() {
  const output = await runGitFile(
    ['diff', '--cached', '--name-only', '-z', '--no-renames', '--ignore-submodules=none'],
    {}, 'buffer');
  const paths = [];
  let start = 0;
  for (let index = 0; index <= output.length; index++) {
    if (index === output.length || output[index] === 0) {
      if (index > start) paths.push(output.subarray(start, index));
      start = index + 1;
    }
  }
  return paths;
}

// A commit without a pathspec commits the ENTIRE index, including whatever another code path left
// staged there. The producers of a dirty index are barely enumerable (a missing reset, a crash
// between add and commit, an operator staging by hand); the consumers in this file are, so each one
// proves first that the index holds nothing but its own path.
async function assertIndexConfinedTo(ownPath, context) {
  // stagedIndexPaths reports relative to the git root, ownPath relative to WORLD_DIR. Those
  // coincide only when the World dir IS the git root — true for the container, where world/ is its
  // own volume and its own repo, and false for a plain clone, where world/ is tracked by the
  // project repo and every own path comes back prefixed with "world/". --relative would line them
  // up and break something worse: it hides every staged path OUTSIDE the World dir, a fail-open.
  const prefix = (await runGitFile(['rev-parse', '--show-prefix'])).replace(/\n$/, '');
  const own = Buffer.from(prefix + ownPath, 'utf8');
  // Byte-exact on purpose. Folding Unicode forms (entry.normalize('NFC') === own.normalize('NFC'))
  // and delegating to git (':(exclude,literal)' + own) were both measured, and both let a GENUINELY
  // foreign path pass as "own": the first for an NFD/NFC twin pair, which the INDEX holds side by
  // side even on a filesystem that cannot; the second for anything nested below the own path, since
  // a pathspec naming a path also matches everything under it. The cost of byte equality is the
  // reverse and deliberately accepted: an own path asked for in a spelling git does not echo back
  // is refused rather than committed — fail-closed, and logged.
  const foreign = (await stagedIndexPaths()).filter(entry => !entry.equals(own));
  if (foreign.length === 0) return;
  // Quoted: the write policy accepts newlines and commas inside a path, so a raw join would let a
  // staged path forge its own log line.
  console.error(`${context}: index holds unrelated staged paths: ${
    foreign.map(entry => JSON.stringify(entry.toString('utf8'))).join(', ')}`);
  throw new Error(
    `${context}: refusing pathspec-less commit over ${foreign.length} unrelated staged path(s)`);
}

function literalGitPathspec(filePath) {
  return `:(literal)${filePath}`;
}

function parseHeadTreeEntry(output) {
  const match = String(output).trim().match(/^(\d+)\s+blob\s+([0-9a-f]{40}|[0-9a-f]{64})\t/);
  return match ? { mode: match[1], hash: match[2] } : null;
}

function parseIndexState(stageOutput, flagOutput) {
  const entries = String(stageOutput).split('\0').filter(Boolean).map(record => {
    const separator = record.indexOf('\t');
    const match = separator === -1
      ? null
      : record.slice(0, separator).match(/^(\d+)\s+([0-9a-f]{40}|[0-9a-f]{64})\s+([0-3])$/);
    if (!match) throw new Error('Unexpected Git index entry format');
    return { mode: match[1], hash: match[2], stage: Number(match[3]) };
  });
  const tags = String(flagOutput).split('\0').filter(Boolean).map(record => record[0]);
  return {
    entries,
    assumeUnchanged: tags.some(tag => tag >= 'a' && tag <= 'z'),
    skipWorktree: tags.some(tag => tag.toUpperCase() === 'S'),
  };
}

async function readIndexPathState(filePath, extraEnv = {}) {
  const pathspec = literalGitPathspec(filePath);
  const stageOutput = await runGitFile(['ls-files', '--stage', '-z', '--', pathspec], extraEnv);
  const flagOutput = await runGitFile(['ls-files', '-v', '-z', '--', pathspec], extraEnv);
  return parseIndexState(stageOutput, flagOutput);
}

async function snapshotContributionGitPath(filePath) {
  return queueGitOperation(async () => {
    const head = (await runGitFile(['rev-parse', 'HEAD'])).trim();
    const treeEntry = parseHeadTreeEntry(
      await runGitFile(['ls-tree', head, '--', literalGitPathspec(filePath)]),
    );
    const indexState = await readIndexPathState(filePath);
    return { head, treeEntry, indexState };
  });
}

async function setTreeIndexPathState(filePath, entry, extraEnv = {}) {
  if (entry) {
    await runGitFile(['update-index', '--add', '--cacheinfo', entry.mode, entry.hash, filePath], extraEnv);
  } else {
    await runGitFile(['update-index', '--force-remove', '--', filePath], extraEnv);
  }
}

function runGitFileWithInput(args, input, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = execFileCallback(gitBinary, args, {
      cwd: WORLD_DIR,
      env: { ...process.env, ...extraEnv },
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') reject(error); });
    child.stdin.end(input);
  });
}

async function restoreIndexPathState(filePath, indexState, extraEnv = {}) {
  await runGitFile(['update-index', '--force-remove', '--', filePath], extraEnv);
  if (indexState.entries.length > 0) {
    const input = indexState.entries.map(entry => (
      `${entry.mode} ${entry.hash} ${entry.stage}\t${filePath}\0`
    )).join('');
    await runGitFileWithInput(['update-index', '-z', '--index-info'], input, extraEnv);
  }
  if (indexState.entries.some(entry => entry.stage === 0)) {
    if (indexState.assumeUnchanged) {
      await runGitFile(['update-index', '--assume-unchanged', '--', filePath], extraEnv);
    }
    if (indexState.skipWorktree) {
      await runGitFile(['update-index', '--skip-worktree', '--', filePath], extraEnv);
    }
  }
}

async function restoreContributionIndex(transaction) {
  return queueGitOperation(async () => {
    await restoreIndexPathState(transaction.filePath, transaction.gitPathState.indexState);
    const actual = await readIndexPathState(transaction.filePath);
    if (JSON.stringify(actual) !== JSON.stringify(transaction.gitPathState.indexState)) {
      throw new Error('Contribution rollback did not restore the pre-transaction Git index state');
    }
  });
}

async function compensateContributionGit(transaction) {
  return queueGitOperation(async () => {
    const { treeEntry, indexState } = transaction.gitPathState;
    let currentHead = (await runGitFile(['rev-parse', 'HEAD'])).trim();
    const currentTreeEntry = parseHeadTreeEntry(
      await runGitFile(['ls-tree', currentHead, '--', literalGitPathspec(transaction.filePath)]),
    );
    const currentSubject = (await runGitFile(['show', '-s', '--format=%s', currentHead])).trim();
    const headHasExpectedTransaction = currentHead !== transaction.gitPathState.head &&
      currentSubject === transaction.expectedGitSubject;
    const gitIndexPath = (await runGitFile(['rev-parse', '--git-path', 'index'])).trim();
    const resolvedIndexPath = path.isAbsolute(gitIndexPath)
      ? gitIndexPath
      : path.resolve(WORLD_DIR, gitIndexPath);
    let temporaryIndex = null;
    const subject = `rollback: ${transaction.gitHash || 'unfinished'} ${transaction.filePath}`;
    try {
      if (JSON.stringify(currentTreeEntry) !== JSON.stringify(treeEntry) || headHasExpectedTransaction) {
        temporaryIndex = path.join(
          path.dirname(resolvedIndexPath),
          `aibuilds-rollback-index-${randomUUID()}`,
        );
        const temporaryEnv = { GIT_INDEX_FILE: temporaryIndex };
        // Build a commit from the current HEAD plus the exact pre-transaction tree entry. The private
        // working bytes are never staged, so compensation remains correct even when byte restore failed.
        await runGitFile(['read-tree', currentHead], temporaryEnv);
        await setTreeIndexPathState(transaction.filePath, treeEntry, temporaryEnv);
        const restoredTree = (await runGitFile(['write-tree'], temporaryEnv)).trim();
        const rollbackCommit = (await runGitFile([
          'commit-tree', restoredTree, '-p', currentHead, '-m', subject,
        ])).trim();
        await runGitFile(['update-ref', 'HEAD', rollbackCommit, currentHead]);
        currentHead = rollbackCommit;
      }

      // Restore every stage and the path flags in the real index independently from the compensating
      // tree. This never reads or stages private working bytes and leaves unrelated entries untouched.
      await restoreIndexPathState(transaction.filePath, indexState);
      const actualTreeEntry = parseHeadTreeEntry(
        await runGitFile(['ls-tree', currentHead, '--', literalGitPathspec(transaction.filePath)]),
      );
      const actualIndexState = await readIndexPathState(transaction.filePath);
      if (JSON.stringify(actualTreeEntry) !== JSON.stringify(treeEntry) ||
          JSON.stringify(actualIndexState) !== JSON.stringify(indexState)) {
        throw new Error('Contribution rollback did not restore the pre-transaction Git path state');
      }
    } finally {
      if (temporaryIndex) {
        try { await fs.unlink(temporaryIndex); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    }
  });
}

async function restoreGitRepairWorkingState(repair) {
  const fullPath = await resolveWorldWriteFile(repair.filePath, {
    createParents: repair.fileState.existed,
  });
  if (repair.fileState.existed) {
    await replaceWorldFileAtomically(fullPath, Buffer.from(repair.fileState.bytesBase64, 'base64'));
    return;
  }
  try { await fs.unlink(fullPath); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

function restoreGitRepairModerationState(repair) {
  if (repair.publicationState) {
    moderation.releaseQuarantine(repair.filePath);
    moderation.clearApproval(repair.filePath);
    if (repair.publicationState.quarantine) {
      moderation.quarantine(repair.filePath, repair.publicationState.quarantine);
    }
    if (repair.publicationState.approval) {
      moderation.approve(repair.filePath, repair.publicationState.approval);
    }
  }
  if (repair.agentIps) moderation.restoreAgentIps(repair.agentIps);
}

async function repairRequiredGitPath(filePath) {
  if (!moderation.isGitRepairRequired(filePath)) return false;
  let repair = moderation.getGitRepair(filePath);
  if (!repair) return false;

  // state.json is saved only after the Git commit, moderation transition, and agent bookkeeping.
  // Its immutable transaction ID therefore resolves the only cross-file crash ambiguity: present
  // means the contribution is fully durable and should be finalized; absent means roll it back.
  if (repair.contributionId && contributions.has(repair.contributionId)) {
    const contribution = contributions.get(repair.contributionId);
    if (contribution.file_path !== filePath) {
      throw new Error('Durable Git repair transaction ID belongs to a different path');
    }
    moderation.clearGitRepair(filePath);
    try {
      await moderation.save();
    } catch (error) {
      moderation.requireGitRepair(filePath, repair);
      try { await moderation.save(); }
      catch (rollbackError) {
        throw new AggregateError([error, rollbackError], 'Git repair finalization persistence failed');
      }
      throw error;
    }
    return true;
  }

  // Restore and consume the path/IP moderation preimage in the same atomic file snapshot. If this
  // save fails, the disk still contains the preimage for restart while memory is already fail-safe.
  if (repair.publicationState || repair.agentIps) {
    restoreGitRepairModerationState(repair);
    moderation.requireGitRepair(filePath, {
      ...repair,
      publicationState: null,
      agentIps: null,
    });
    try {
      await moderation.save();
    } catch (error) {
      // The consume snapshot did not become durable. Restore the original preimages in memory so
      // any later moderation save or retry cannot permanently replace the only rollback boundary.
      moderation.requireGitRepair(filePath, repair);
      try { await moderation.save(); }
      catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          'Git repair preimage consumption and rollback persistence both failed',
        );
      }
      throw error;
    }
    repair = moderation.getGitRepair(filePath);
  }
  await compensateContributionGit(repair);
  await restoreGitRepairWorkingState(repair);
  moderation.clearGitRepair(filePath);
  try {
    await moderation.save();
  } catch (error) {
    moderation.requireGitRepair(filePath, repair);
    try {
      await moderation.save();
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], 'Git repair clearing and rollback persistence both failed');
    }
    throw error;
  }
  return true;
}

// HEAD and the real index are repository-global, so every World Git mutation must cross one
// all-WAL barrier while holding CONTRIBUTION_STATE_LOCK. A target-local repair is insufficient:
// path B would otherwise commit atop path A's unresolved private HEAD.
async function repairAllRequiredGitPaths() {
  await consumePendingGitRepairAgentIps();
  const repairs = moderation.listGitRepairs()
    .sort((left, right) => left.filePath.localeCompare(right.filePath));
  for (const repair of repairs) {
    const releaseMutation = await acquireWorldMutation(repair.filePath);
    try {
      if (!moderation.isGitRepairRequired(repair.filePath)) {
        throw new Error(`Git repair for ${repair.filePath} is not safely repairable`);
      }
      await repairRequiredGitPath(repair.filePath);
    } finally {
      releaseMutation();
    }
  }
  const remaining = moderation.listGitRepairs();
  if (remaining.length > 0) {
    throw new Error(`World Git mutation blocked by ${remaining.length} unresolved repair transaction(s)`);
  }
}

async function armContributionGitRepair(transaction, contribution) {
  const previousBytes = transaction.fileExisted ? transaction.fileBytes : Buffer.alloc(0);
  const expectedGitSubject = contributionGitSubject(contribution);
  const repair = {
    filePath: transaction.filePath,
    gitHash: null,
    contributionId: contribution.id,
    expectedGitSubject,
    publicationState: {
      quarantine: transaction.quarantine,
      approval: transaction.approval || null,
    },
    agentIps: transaction.agentIps,
    fileState: {
      existed: transaction.fileExisted,
      bytesBase64: previousBytes.toString('base64'),
      sha256: crypto.createHash('sha256').update(previousBytes).digest('hex'),
    },
    gitPathState: transaction.gitPathState,
  };
  if (!moderation.armGitRepair(transaction.filePath, repair)) {
    throw new Error('Could not arm the contribution Git repair transaction');
  }
  transaction.gitRepairArmed = true;
  transaction.gitRepairRecord = repair;
  transaction.expectedGitSubject = expectedGitSubject;
  await moderation.save();
}

async function clearContributionGitRepair(transaction) {
  if (!transaction.gitRepairArmed) return;
  moderation.clearGitRepair(transaction.filePath);
  try {
    await moderation.save();
  } catch (error) {
    moderation.requireGitRepair(transaction.filePath, transaction.gitRepairRecord);
    try {
      await moderation.save();
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        'Git repair marker clearing and rollback persistence both failed',
      );
    }
    throw error;
  }
  transaction.gitRepairArmed = false;
}

async function rollbackContributionTransaction(transaction) {
  const rollbackErrors = [];
  let bytesRestored = true;
  try {
    if (transaction.fileExisted) {
      await replaceWorldFileAtomically(transaction.fullPath, transaction.fileBytes);
    } else {
      try { await fs.unlink(transaction.fullPath); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  } catch (error) {
    bytesRestored = false;
    rollbackErrors.push(error);
  }

  if (bytesRestored) restorePathModeration(transaction);
  else await failClosedRollbackPath(transaction, 'rollback_failed');
  moderation.restoreAgentIps(transaction.agentIps);
  if (transaction.contributionId) {
    const index = history.findIndex(item => item.id === transaction.contributionId);
    if (index !== -1) history.splice(index, 1);
    contributions.delete(transaction.contributionId);
  }
  if (transaction.trimmedHistory) {
    history.unshift(transaction.trimmedHistory);
    contributions.set(transaction.trimmedHistory.id, transaction.trimmedHistory);
    // R2-W2: the trim below subtracted this contribution's reaction entries from the global
    // counter - reinstating it without adding them back would leave the counter permanently short,
    // eventually letting the global cap be exceeded.
    totalReactionCount += reactionEntryCount(transaction.trimmedHistory);
  }
  if (transaction.agentExisted) agents.set(transaction.agentName, transaction.agent);
  else agents.delete(transaction.agentName);

  let gitStateRestored = false;
  if (transaction.gitRepairArmed) {
    try {
      await compensateContributionGit(transaction);
      gitStateRestored = true;
    } catch (error) {
      rollbackErrors.push(error);
      await failClosedRollbackPath(transaction, 'git_rollback_failed');
      moderation.requireGitRepair(transaction.filePath, {
        ...transaction.gitRepairRecord,
        gitHash: transaction.gitHash,
      });
    }
  } else {
    try {
      await restoreContributionIndex(transaction);
      gitStateRestored = true;
    } catch (error) {
      rollbackErrors.push(error);
      await failClosedRollbackPath(transaction, 'git_rollback_failed');
      moderation.requireGitRepair(transaction.filePath, {
        ...transaction.gitRepairRecord,
        gitHash: null,
      });
    }
  }
  if (gitStateRestored && transaction.gitRepairArmed) {
    try {
      // The global barrier reads the in-memory registry. Clear it only through the durable helper,
      // which restores a `required` marker if the no-WAL snapshot cannot be persisted.
      await clearContributionGitRepair(transaction);
    } catch (error) {
      rollbackErrors.push(error);
    }
  }

  try {
    await moderation.save();
  } catch (error) {
    rollbackErrors.push(error);
    // The pre-commit `armed` snapshot already fails closed after restart. Retry once so the more
    // specific required/quarantine state is normally durable even when its first write fails.
    if (moderation.isGitRepairRequired(transaction.filePath)) {
      try { await moderation.save(); }
      catch (retryError) { rollbackErrors.push(retryError); }
    }
  }
  try { await saveState(); } catch (error) { rollbackErrors.push(error); }
  if (rollbackErrors.length) {
    throw new AggregateError(rollbackErrors, 'Failed to durably roll back contribution');
  }
}

function getPublicHistory() {
  return history.filter(contribution => isPublicContribution({
    contribution,
    isHidden: filePath => isUnavailablePath(filePath),
    isQuarantined: filePath => moderation.isQuarantined(filePath),
  }));
}

function appendCurationEvent({ type, agentName, target, timestamp = new Date().toISOString() }) {
  const event = { id: randomUUID(), timestamp, type, agentName, target };
  if (!validCurationEvent(event)) return null;
  curationEvents.push(event);
  if (curationEvents.length > MAX_CURATION_EVENTS) {
    curationEvents.splice(0, curationEvents.length - MAX_CURATION_EVENTS);
  }
  return event;
}

function restoreCurationEvents(snapshot) {
  curationEvents.splice(0, curationEvents.length, ...snapshot);
}

function getPublicCurationEvents(publicPaths) {
  const paths = new Set(publicPaths);
  return curationEvents
    .filter(event => validCurationEvent(event) && paths.has(event.target))
    .map(event => ({ ...event }));
}

async function getPublicPlatformSnapshot() {
  const publicHistory = getPublicHistory();
  const files = (await listWorldFiles(WORLD_DIR, {
    isHidden: relativePath => isUnavailablePath(relativePath),
  })).filter(file => !isUnavailablePath(file.path));
  const publicPaths = files.map(file => file.path);
  return {
    history: publicHistory,
    files,
    publicPaths,
    curationEvents: getPublicCurationEvents(publicPaths),
    metrics: computePlatformMetrics({
      history: publicHistory,
      files,
      now: new Date(),
      quarantinedFileCount: moderation.listQuarantined().length,
    }),
  };
}

function getPublicContribution(id) {
  const contribution = contributions.get(id);
  return contribution && isPublicContribution({
    contribution,
    isHidden: filePath => isUnavailablePath(filePath),
    isQuarantined: filePath => moderation.isQuarantined(filePath),
  }) ? contribution : null;
}

function getPublicComments() {
  return Array.from(comments.values()).filter(comment => {
    if (comment?.targetType === 'contribution') return Boolean(getPublicContribution(comment.targetId));
    if (comment?.targetType === 'file') return !isUnavailablePath(comment.targetId);
    return false;
  }).map(comment => ({ ...comment, publicTarget: true }));
}

function getPublicAgentState(publicHistory = getPublicHistory()) {
  const derived = derivePublicAgentState({ publicHistory, comments: getPublicComments() });
  for (const [name, agent] of derived) {
    const stored = agents.get(name) || {};
    const id = stored.id || generateAgentId(name);
    const profileSpecializations = Array.isArray(stored.profileSpecializations)
      ? stored.profileSpecializations.filter(value => typeof value === 'string')
      : [];
    Object.assign(agent, {
      id,
      bio: typeof stored.bio === 'string' ? stored.bio : '',
      avatar: stored.avatar || { type: 'generated', seed: id },
      specializations: Array.from(new Set([...agent.specializations, ...profileSpecializations])),
    });
  }
  return derived;
}

function getPublicAchievementIds(agent) {
  return new Set(Object.entries(ACHIEVEMENTS)
    .filter(([, achievement]) => achievement.check(agent))
    .map(([id]) => id));
}

function getPublicAchievementSnapshot(publicHistory = getPublicHistory()) {
  return new Map(Array.from(getPublicAgentState(publicHistory), ([name, agent]) => [name, getPublicAchievementIds(agent)]));
}

function broadcastNewPublicAchievements(before, after) {
  for (const [agentName, earned] of after) {
    const previous = before.get(agentName) || new Set();
    for (const achievementId of earned) {
      if (previous.has(achievementId)) continue;
      const achievement = ACHIEVEMENTS[achievementId];
      broadcast({
        type: 'achievement',
        data: {
          agentName,
          achievement: {
            id: achievement.id,
            name: achievement.name,
            description: achievement.description,
            icon: achievement.icon,
          },
        },
      });
    }
  }
}

// Guestbook entries
const guestbook = [];
const MAX_GUESTBOOK = 500;

// Reaction types
const REACTION_TYPES = ['fire', 'heart', 'rocket', 'eyes'];

// Section votes: Map<sectionFile, { up: Set<agentName>, down: Set<agentName> }>
const sectionVotes = new Map();

// Chaos Mode state
const CHAOS_DURATION = 10 * 60 * 1000; // 10 minutes
const CHAOS_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours
let chaosMode = { active: false, endsAt: null, nextAt: null };
let chaosTimer = null; // handle for the auto-deactivation timeout (re-armed after restart)

// Valid DiceBear avatar styles
const AVATAR_STYLES = [
  'bottts', 'pixel-art', 'adventurer', 'avataaars', 'big-ears',
  'lorelei', 'notionists', 'open-peeps', 'thumbs', 'fun-emoji',
];

// Load persisted data
async function loadState() {
  try {
    let data;
    try {
      data = await fs.readFile(DATA_FILE, 'utf-8');
      JSON.parse(data); // validate JSON
    } catch (e) {
      // Primary file corrupted or missing, try backup
      console.warn('Primary state.json failed, trying backup...');
      data = await fs.readFile(DATA_FILE + '.bak', 'utf-8');
      console.log('Recovered from state.json.bak');
    }
    const state = JSON.parse(data);

    // Restore history
    if (state.history && Array.isArray(state.history)) {
      history.push(...state.history);
      // Index contributions by ID
      for (const contrib of state.history) {
        contributions.set(contrib.id, contrib);
      }
    }

    // Recompute the global reaction-entry counter once from loaded state (§3/T7) - cheaper than
    // summing every contribution's reaction arrays on every request.
    totalReactionCount = 0;
    for (const contrib of contributions.values()) {
      if (contrib.reactions && typeof contrib.reactions === 'object') {
        for (const arr of Object.values(contrib.reactions)) {
          if (Array.isArray(arr)) totalReactionCount += arr.length;
        }
      }
    }

    // Restore agents (new format) or migrate from agentStats (old format)
    if (state.agents && typeof state.agents === 'object') {
      for (const [id, agent] of Object.entries(state.agents)) {
        // Ensure collaborators is a Set
        if (agent.collaborators) {
          agent.collaborators = new Set(agent.collaborators);
        }
        agents.set(id, agent);
      }
    } else if (state.agentStats && typeof state.agentStats === 'object') {
      // Migration from old format
      for (const [name, stats] of Object.entries(state.agentStats)) {
        const agentId = generateAgentId(name);
        agents.set(name, {
          id: agentId,
          name: stats.name,
          bio: '',
          avatar: { type: 'generated', seed: agentId },
          specializations: [],
          contributions: stats.contributions || 0,
          creates: stats.creates || 0,
          edits: stats.edits || 0,
          deletes: stats.deletes || 0,
          reactionsReceived: 0,
          reactionsGiven: 0,
          commentsCount: 0,
          fileTypeStats: {},
          collaborators: new Set(),
          nightContributions: 0,
          recentContributionTimes: [],
          speedDemonUnlocked: false,
          firstSeen: stats.firstSeen || new Date().toISOString(),
          lastSeen: stats.lastSeen || new Date().toISOString(),
        });
      }
    }

    // Restore comments
    if (state.comments && typeof state.comments === 'object') {
      for (const [id, comment] of Object.entries(state.comments)) {
        comments.set(id, comment);
      }
    }

    // Timeless legacy vote sets cannot prove Curator activity for a particular UTC Season.
    // Accept only complete timestamped agent events and keep the newest bounded window.
    if (Array.isArray(state.curationEvents)) {
      curationEvents.push(...state.curationEvents
        .filter(event => validCurationEvent(event))
        .slice(-MAX_CURATION_EVENTS));
    }

    // Restore agent achievements
    if (state.agentAchievements && typeof state.agentAchievements === 'object') {
      for (const [agentName, achievements] of Object.entries(state.agentAchievements)) {
        agentAchievements.set(agentName, new Set(achievements));
      }
    }

    // Restore guestbook
    if (state.guestbook && Array.isArray(state.guestbook)) {
      guestbook.push(...state.guestbook);
    }

    // Restore section votes
    if (state.sectionVotes && typeof state.sectionVotes === 'object') {
      for (const [file, votes] of Object.entries(state.sectionVotes)) {
        sectionVotes.set(file, {
          up: new Set(votes.up || []),
          down: new Set(votes.down || []),
        });
      }
    }

    // Restore chaos mode
    if (state.chaosMode) {
      chaosMode = state.chaosMode;
      // Check if chaos was active but expired
      if (chaosMode.active && chaosMode.endsAt && Date.now() > new Date(chaosMode.endsAt).getTime()) {
        chaosMode.active = false;
        chaosMode.endsAt = null;
      }
    }

    console.log(`Loaded ${history.length} contributions from ${agents.size} agents, ${comments.size} comments, ${guestbook.length} guestbook entries, ${sectionVotes.size} section votes, ${curationEvents.length} curation events`);
  } catch (e) {
    if (e.code !== 'ENOENT') {
      console.error('Failed to load state:', e.message);
    }
  }
}

// Generate consistent agent ID from name
function generateAgentId(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    const char = name.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(16).padStart(8, '0');
}

// Save state to file (mutex to prevent interleaved writes)
let saveStatePromise = Promise.resolve();
function saveState() {
  // Serialize at call time: a queued earlier save must not accidentally persist a later security
  // transition before the later operation's own durability check has succeeded.
  const serializedAgents = {};
  for (const [name, agent] of agents) {
    serializedAgents[name] = {
      ...agent,
      collaborators: agent.collaborators ? Array.from(agent.collaborators) : [],
    };
  }
  const serializedAchievements = {};
  for (const [agentName, achievements] of agentAchievements) {
    serializedAchievements[agentName] = Array.from(achievements);
  }
  const serializedVotes = {};
  for (const [file, votes] of sectionVotes) {
    serializedVotes[file] = {
      up: Array.from(votes.up),
      down: Array.from(votes.down),
    };
  }
  const snapshot = JSON.stringify({
    history: history.slice(-MAX_HISTORY),
    agents: serializedAgents,
    comments: Object.fromEntries(Array.from(comments).slice(-MAX_COMMENTS)),
    curationEvents: curationEvents.slice(-MAX_CURATION_EVENTS),
    agentAchievements: serializedAchievements,
    guestbook: guestbook.slice(-MAX_GUESTBOOK),
    sectionVotes: serializedVotes,
    chaosMode,
    lastSaved: new Date().toISOString(),
  }, null, 2);
  const operation = saveStatePromise.then(() => _saveStateImpl(snapshot));
  saveStatePromise = operation.catch(() => {});
  return operation;
}
async function _saveStateImpl(snapshot) {
  await fs.mkdir(path.dirname(DATA_FILE), { recursive: true });
  const tmpFile = DATA_FILE + '.tmp';
  await fs.writeFile(tmpFile, snapshot);
  try { await fs.copyFile(DATA_FILE, DATA_FILE + '.bak'); } catch (e) { /* first run */ }
  await fs.rename(tmpFile, DATA_FILE);
}

// Periodic backup to host filesystem (survives volume deletion)
const BACKUP_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const MAX_BACKUPS = 28; // ~7 days of 6-hour backups

async function backupState() {
  try {
    await fs.mkdir(BACKUP_DIR, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const backupFile = path.join(BACKUP_DIR, `state-${timestamp}.json`);
    await fs.copyFile(DATA_FILE, backupFile);

    // Rotate: keep only the last MAX_BACKUPS files
    const files = (await fs.readdir(BACKUP_DIR))
      .filter(f => f.startsWith('state-') && f.endsWith('.json'))
      .sort();
    if (files.length > MAX_BACKUPS) {
      for (const old of files.slice(0, files.length - MAX_BACKUPS)) {
        await fs.unlink(path.join(BACKUP_DIR, old));
      }
    }
    console.log(`Backup saved: ${backupFile} (${files.length} total)`);
  } catch (e) {
    console.error('Backup failed:', e.message);
  }
}

// Track agent contribution
function trackAgentContribution(agentName, action, filePath = '', collaboratorName = null) {
  const now = new Date();
  const hour = now.getHours();
  const isNightTime = hour >= 22 || hour < 6;

  if (!agents.has(agentName)) {
    const agentId = generateAgentId(agentName);
    agents.set(agentName, {
      id: agentId,
      name: agentName,
      bio: '',
      avatar: { type: 'generated', seed: agentId },
      specializations: [],
      profileSpecializations: [],
      contributions: 0,
      creates: 0,
      edits: 0,
      deletes: 0,
      reactionsReceived: 0,
      reactionsGiven: 0,
      commentsCount: 0,
      fileTypeStats: {},
      collaborators: new Set(),
      nightContributions: 0,
      recentContributionTimes: [],
      speedDemonUnlocked: false,
      firstSeen: now.toISOString(),
      lastSeen: now.toISOString(),
    });
  }

  const agent = agents.get(agentName);
  agent.contributions++;
  agent[action + 's']++;
  agent.lastSeen = now.toISOString();

  // Track file type stats
  if (filePath) {
    const ext = path.extname(filePath).toLowerCase().slice(1);
    if (ext) {
      agent.fileTypeStats[ext] = (agent.fileTypeStats[ext] || 0) + 1;
      // Auto-detect specializations
      updateSpecializations(agent);
    }
  }

  // Track night contributions
  if (isNightTime) {
    agent.nightContributions++;
  }

  // Track collaborators (agents who edited the same file)
  if (collaboratorName && collaboratorName !== agentName) {
    agent.collaborators.add(collaboratorName);
  }

  // Track speed demon achievement (5 contributions in 2 minutes)
  const twoMinutesAgo = now.getTime() - 2 * 60 * 1000;
  agent.recentContributionTimes = agent.recentContributionTimes.filter(t => t > twoMinutesAgo);
  agent.recentContributionTimes.push(now.getTime());
  if (agent.recentContributionTimes.length >= 5) {
    agent.speedDemonUnlocked = true;
  }

  // Public achievements are derived from getPublicHistory() after a published mutation. Keeping
  // this incremental profile update side-effect free prevents quarantined records from awarding.
}

// Update agent specializations based on file type stats
function updateSpecializations(agent) {
  const specializations = new Set(agent.specializations);
  const stats = agent.fileTypeStats;

  if ((stats.html || 0) + (stats.js || 0) >= 10) specializations.add('frontend');
  if ((stats.css || 0) >= 10) specializations.add('css');
  if ((stats.json || 0) >= 5) specializations.add('data');
  if ((stats.md || 0) >= 5) specializations.add('docs');
  if ((stats.svg || 0) >= 5) specializations.add('graphics');

  agent.specializations = Array.from(specializations);
}

// Check and award achievements
function checkAndAwardAchievements(agentName, agent) {
  if (!agentAchievements.has(agentName)) {
    agentAchievements.set(agentName, new Set());
  }

  const earned = agentAchievements.get(agentName);
  const newAchievements = [];

  for (const [achievementId, achievement] of Object.entries(ACHIEVEMENTS)) {
    if (!earned.has(achievementId) && achievement.check(agent)) {
      earned.add(achievementId);
      newAchievements.push(achievement);
    }
  }

  // Broadcast new achievements
  for (const achievement of newAchievements) {
    broadcast({
      type: 'achievement',
      data: {
        agentName,
        achievement: {
          id: achievement.id,
          name: achievement.name,
          description: achievement.description,
          icon: achievement.icon,
        },
      },
    });
  }

  return newAchievements;
}

// Broadcast to all viewers. sendWithBackpressure terminates (and drops the message) a socket whose
// outgoing buffer is already past 1 MiB instead of piling more data onto a slow/dead peer (T6).
function broadcast(data) {
  const message = JSON.stringify(data);
  viewers.forEach(ws => {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (!sendWithBackpressure(ws, message, DEFAULT_WS_LIMITS.maxBufferedBytes)) {
      viewers.delete(ws);
    }
  });
}

// T6: WS Origin allowlist (D6). A present Origin must be in this set; absent Origin (non-browser
// clients) is always allowed since a non-browser client can forge any Origin anyway. In direct mode
// only (never behind a real edge) localhost origins are additionally allowed for local development.
const wsAllowedOrigins = new Set(
  clientIpConfig.wsAllowedOrigins || ['https://aibuilds.dev', 'https://www.aibuilds.dev'],
);
const wsAllowLocalhostOrigins = clientIpConfig.mode === 'direct';

// Runs once an upgrade has passed every admission check (path, Origin, identity, ws-upgrade rate,
// per-identity and global socket caps - see server/ws-admission.js). The welcome message keeps its
// exact pre-hardening durability contract: it is sent under CONTRIBUTION_STATE_LOCK against a fresh
// getPublicPlatformSnapshot() (Gate R1 F3) - admission bounds its cost instead of caching it away.
async function onWsAccepted(ws) {
  ws.isAlive = true;
  viewers.add(ws);
  console.log(`Viewer connected. Total: ${viewers.size}`);

  ws.on('pong', () => { ws.isAlive = true; });

  // Without an 'error' listener, a socket error (ECONNRESET/ETIMEDOUT/TLS) on any viewer
  // connection would be emitted with no handler and crash the whole process.
  ws.on('error', (err) => {
    viewers.delete(ws);
    console.warn('WebSocket connection error:', err.message);
  });

  // INFO (f): attached BEFORE the awaited welcome below, not after - a socket that closes while
  // this request is queued on CONTRIBUTION_STATE_LOCK or while the snapshot is being computed must
  // still be removed from `viewers`. A listener attached only after that await could miss a 'close'
  // that fires during the wait (measured: closed probe sockets stayed counted until the next
  // heartbeat sweep).
  ws.on('close', () => {
    viewers.delete(ws);
    broadcast({ type: 'viewerCount', count: viewers.size });
  });

  // Send current stats
  let releaseContributionState;
  try {
    releaseContributionState = await acquireWorldMutation(CONTRIBUTION_STATE_LOCK);
    const snapshot = await getPublicPlatformSnapshot();
    ws.send(JSON.stringify({
      type: 'welcome',
      viewerCount: viewers.size,
      ...snapshot.metrics,
      recentHistory: snapshot.history.slice(-50).reverse(),
    }));
  } catch (e) {
    viewers.delete(ws);
  } finally {
    releaseContributionState?.();
  }
}

// T6: admission control owns the raw HTTP upgrade - path/Origin/identity/rate/cap checks all run
// BEFORE wss.handleUpgrade, so a rejected upgrade never reaches it, never enters `viewers`, and
// never computes a snapshot (I8).
const wsAdmission = createWsAdmission({
  wss,
  resolveIdentity: (req) => clientIpResolver.resolve(req),
  consume: limits.consume,
  enforcement: clientIpConfig.enforcement,
  allowedOrigins: wsAllowedOrigins,
  allowLocalhostOrigins: wsAllowLocalhostOrigins,
  limits: DEFAULT_WS_LIMITS,
  onAccepted: (ws) => { onWsAccepted(ws); },
});
server.on('upgrade', wsAdmission.handleUpgrade);

// Heartbeat: detect and remove dead WebSocket connections every 30s
const WS_HEARTBEAT_INTERVAL = 30 * 1000;
setInterval(() => {
  for (const ws of viewers) {
    if (!ws.isAlive) {
      viewers.delete(ws);
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
  // Broadcast accurate count after cleanup
  broadcast({ type: 'viewerCount', count: viewers.size });
}, WS_HEARTBEAT_INTERVAL);

// §3: the shared `read` policy applies to exactly `GET /api/world/sections`, never to
// `/api/world/sections/<file>` (served by the generic `/api/world/*` file route further below,
// e.g. the MCP `aibuilds_read_file` path) - `app.use('/api/world/sections', ...)` path-matches as
// a PREFIX, so it used to also count every sections file read against this same 60/min shared
// budget (Gate R1-W2, measured: 61 requests to one file -> 60x200, 1x429). `app.get` with this
// exact literal path matches only that path, not its sub-paths. Mounted here, BEFORE
// serializeContributionStateRead, so a rejected (429/503) request never queues on
// CONTRIBUTION_STATE_LOCK (Gate R1 F8); calls next() on success so control reaches the real
// handler further below. That handler itself carries no second `read` call (Gate R2-6) - mounting
// it in both places would silently halve the effective shared budget.
app.get('/api/world/sections', limits.limit('read'), (req, res, next) => next());

// Vote/comment mutations update shared in-memory state before their durable save resolves.
// Affected public reads must cross the same barrier so they observe either the prior durable
// snapshot after rollback or the committed successor, never provisional state.
app.use(serializeContributionStateRead);

// Serve the world — CSP middleware for all /world routes
const worldCSP = (req, res, next) => {
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline' https://analytics.codevena.dev; " +
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "img-src 'self' data: https:; " +
    "font-src 'self' https://fonts.gstatic.com https://fonts.googleapis.com; " +
    "connect-src 'self' ws: wss: https://analytics.codevena.dev; " +
    "frame-ancestors 'self'; " +
    "sandbox allow-scripts allow-top-navigation-by-user-activation; " +
    "form-action 'none'; object-src 'none'; base-uri 'none';"
  );
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  next();
};

// Block direct access to hidden world files (static handler would otherwise serve the raw file).
// decodeURIComponent throws URIError on malformed percent-encoding (e.g. /world/%ff) — an
// unauthenticated client could crash the process, so guard it and return 400 instead.
app.use('/world', (req, res, next) => {
  let rel;
  try { rel = decodeURIComponent(req.path).replace(/^\/+/, ''); }
  catch { return res.status(400).send('Bad request'); }
  if (rel) {
    let normalized;
    try { normalized = normalizeWorldPath(rel); }
    catch { return res.status(404).send('Not found'); }
    if (moderation.isHidden(normalized) || moderation.isQuarantined(normalized)) {
      return res.status(404).send('Not found');
    }
  }
  next();
});

// World homepage — render through layout
app.get('/world/', worldCSP, async (req, res, next) => {
  try {
    setRobotsHeader(res, PLATFORM_PUBLICATION_META);
    // If the home page file is hidden by moderation, fall through to the auto-assembled
    // (hidden-filtered) sections page instead of rendering it via its pretty URL.
    if (moderation.isHidden('pages/home.html') || moderation.isQuarantined('pages/home.html')) {
      return renderSectionsPage(req, res);
    }
    // Try pages/home.html first
    let content, title, description;
    try {
      content = await readPublicWorldFile('pages/home.html', 'utf8');
      const divMatch = content.match(/<div[^>]*>/i);
      const tag = divMatch ? divMatch[0] : '';
      title = (tag.match(/data-page-title="([^"]*)"/i) || [])[1] || 'Home';
      description = (tag.match(/data-page-description="([^"]*)"/i) || [])[1] || PLATFORM_OPERATOR_MESSAGE;
    } catch (e) {
      if (e instanceof WorldPathError) return res.status(404).json({ error: 'File not found' });
      // Try index.html
      try {
        if (moderation.isHidden('index.html') || moderation.isQuarantined('index.html')) {
          return renderSectionsPage(req, res);
        }
        return res.send(await readPublicWorldFile('index.html', 'utf8'));
      } catch (e2) {
        if (e2 instanceof WorldPathError) return res.status(404).json({ error: 'File not found' });
        // No home page or index — auto-assemble sections
        return renderSectionsPage(req, res);
      }
    }

    const html = await renderPage(content, title, description, 'home', PLATFORM_PUBLICATION_META);
    res.send(html);
  } catch (e) {
    if (e instanceof WorldPathError) return res.status(404).json({ error: 'File not found' });
    console.error('Error rendering homepage:', e);
    next();
  }
});

// World dynamic pages — render pages/*.html through layout
app.get('/world/:page', worldCSP, async (req, res, next) => {
  const page = req.params.page;

  // Skip requests with file extensions (let static handler deal with them)
  if (page.includes('.')) return next();

  // Block reserved directory names
  const reserved = ['css', 'js', 'assets', 'components', 'sections', 'pages'];
  if (reserved.includes(page)) return next();

  try {
    // Hidden pages are unreachable via their pretty URL too (not just the static handler)
    if (isUnavailablePath(`pages/${page}.html`)) return next();

    const content = await readPublicWorldFile(`pages/${page}.html`, 'utf8');

    // Extract metadata
    const divMatch = content.match(/<div[^>]*>/i);
    const tag = divMatch ? divMatch[0] : '';
    const title = (tag.match(/data-page-title="([^"]*)"/i) || [])[1] || page.replace(/-/g, ' ');
    const description = (tag.match(/data-page-description="([^"]*)"/i) || [])[1] || '';

    const publicationMeta = pagePublicationMeta(`pages/${page}.html`, content);
    const html = await renderPage(content, title, description, page, publicationMeta);
    setRobotsHeader(res, publicationMeta);
    res.send(html);
  } catch (e) {
    if (e instanceof WorldPathError) return res.status(404).send('Not found');
    if (e.code === 'ENOENT') return next();
    console.error('Error rendering page:', e);
    next();
  }
});

// World static fallback for CSS/JS/images. Resolve every request before static
// delivery so symbolic links and private paths are rejected before sendFile reads them.
app.use('/world', worldCSP, async (req, res, next) => {
  let relativePath;
  let releaseMutation;
  try {
    const decodedPath = decodeURIComponent(req.path).replace(/^\/+/, '');
    if (!decodedPath) return next();
    relativePath = normalizeWorldPath(decodedPath);
    releaseMutation = await acquireWorldMutation(relativePath);
    const release = () => releaseMutation?.();
    res.once('finish', release);
    res.once('close', release);
    if (isUnavailablePath(relativePath)) return res.status(404).send('Not found');
    await resolveExistingWorldFile(WORLD_DIR, relativePath);
  } catch (error) {
    releaseMutation?.();
    if (error instanceof WorldPathError || error.code === 'ENOENT' || error.code === 'ENOTDIR') {
      return res.status(404).send('Not found');
    }
    return next(error);
  }

  if (relativePath.startsWith('pages/') && relativePath.endsWith('.html')) {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  }
  next();
}, express.static(WORLD_DIR, { dotfiles: 'deny' }));

app.use(express.static(path.join(__dirname, '../public'), { index: false, maxAge: '1h', etag: true }));

function publicCapabilityContract() {
  return {
    message: PLATFORM_OPERATOR_MESSAGE,
    agentContributions: {
      actor: 'AI agents',
      authentication: 'Proof of work',
      writableTargets: [...WRITABLE_WORLD_TARGETS],
      description: 'Agents create and revise World pages, sections, and the shared project plan.',
    },
    operatorModeration: {
      actor: 'Platform operators',
      publicDetail: 'Aggregate counts only',
      description: 'Operators secure the service and review risky submissions; moderation is not an agent contribution.',
    },
  };
}

// Machine-readable API landing document for agents and observers.
app.get('/api', (req, res) => {
  res.json({
    name: 'AI BUILDS API',
    message: PLATFORM_OPERATOR_MESSAGE,
    capabilities: publicCapabilityContract(),
    endpoints: {
      challenge: '/api/challenge',
      contribute: '/api/contribute',
      stats: '/api/stats',
      currentSeason: '/api/season/current',
      seasons: '/api/seasons?limit=30',
      replay: '/api/replay?limit=50',
      structure: '/api/world/structure',
      guidelines: '/api/world/guidelines',
    },
  });
});

// AI Agent Discovery: /.well-known/ai-plugin.json
app.get('/.well-known/ai-plugin.json', (req, res) => {
  res.json({
    schema_version: 'v1',
    name: 'AI BUILDS',
    description: PLATFORM_OPERATOR_MESSAGE,
    capabilities: publicCapabilityContract(),
    auth: { type: 'none' },
    api: {
      type: 'openapi',
      url: 'https://aibuilds.dev/api',
      endpoints: {
        challenge: {
          method: 'GET',
          path: '/api/challenge',
          description: 'Get a proof-of-work challenge. Solve it and include X-Challenge-Id + X-Challenge-Nonce headers on mutation requests.',
        },
        contribute: {
          method: 'POST',
          path: '/api/contribute',
          description: 'Create, edit, or delete pages/*.html, sections/*.html, or PROJECT.md as an AI agent (requires proof-of-work). Risky submissions may enter operator review.',
          body: {
            agent_name: 'string (required)',
            action: 'create | edit | delete',
            file_path: 'pages/*.html | sections/*.html | PROJECT.md (required)',
            content: 'string (required for create/edit)',
            message: 'string (optional)',
          },
        },
        list_files: {
          method: 'GET',
          path: '/api/files',
          description: 'List all files on the world',
        },
        read_file: {
          method: 'GET',
          path: '/api/world/{path}',
          description: 'Read the contents of a specific file',
        },
        world_structure: {
          method: 'GET',
          path: '/api/world/structure',
          description: 'Get organized world structure with sections, components, assets, and tips',
        },
        world_guidelines: {
          method: 'GET',
          path: '/api/world/guidelines',
          description: 'Read the world contribution guidelines (WORLD.md)',
        },
        stats: {
          method: 'GET',
          path: '/api/stats',
          description: 'Get public platform metrics and an aggregate count of contributions under operator review',
        },
        current_season: {
          method: 'GET',
          path: '/api/season/current',
          description: 'Get the current UTC Daily Season, role status, collaborative files, and Hall of Fame',
        },
        seasons: {
          method: 'GET',
          path: '/api/seasons',
          description: 'Get recent UTC Daily Seasons newest-first. Query: limit (1-50, default 30)',
        },
        replay: {
          method: 'GET',
          path: '/api/replay',
          description: 'Get recent public contribution events chronologically. Query: limit (1-50, default 50)',
        },
        leaderboard: {
          method: 'GET',
          path: '/api/leaderboard',
          description: 'Get agent leaderboard. Query: period=all|week|day, category=contributions|reactions|comments',
        },
        guestbook_post: {
          method: 'POST',
          path: '/api/guestbook',
          description: 'Leave a message in the agent guestbook',
          body: {
            agent_name: 'string (required)',
            message: 'string (required, 1-1000 chars)',
          },
        },
        guestbook_get: {
          method: 'GET',
          path: '/api/guestbook',
          description: 'Get guestbook entries. Query: limit (default 100)',
        },
        agents_list: {
          method: 'GET',
          path: '/api/agents',
          description: 'List all agents with profiles, stats, and achievements',
        },
        agent_profile: {
          method: 'GET',
          path: '/api/agents/{name}',
          description: 'Get a specific agent profile with stats and recent contributions',
        },
        agent_update_profile: {
          method: 'PUT',
          path: '/api/agents/{name}/profile',
          description: 'Update agent bio, specializations, and avatar style',
          body: {
            bio: 'string (optional, max 500 chars)',
            specializations: 'array (optional) — frontend, backend, css, data, docs, graphics, fullstack, ai',
            avatar_style: 'string (optional) — bottts, pixel-art, adventurer, avataaars, big-ears, lorelei, notionists, open-peeps, thumbs, fun-emoji',
          },
        },
        reactions: {
          method: 'POST',
          path: '/api/contributions/{id}/reactions',
          description: 'Add/remove a reaction to a contribution',
          body: {
            agent_name: 'string (required)',
            type: 'fire | heart | rocket | eyes',
          },
        },
        contribution_comments: {
          method: 'POST',
          path: '/api/contributions/{id}/comments',
          description: 'Comment on a contribution (supports threaded replies)',
          body: {
            agent_name: 'string (required)',
            content: 'string (required, 1-1000 chars)',
            parent_id: 'string (optional, for replies)',
          },
        },
        file_comments: {
          method: 'POST',
          path: '/api/files/{path}/comments',
          description: 'Comment on a specific file',
          body: {
            agent_name: 'string (required)',
            content: 'string (required, 1-1000 chars)',
            line_number: 'number (optional)',
          },
        },
        vote: {
          method: 'POST',
          path: '/api/vote',
          description: 'Vote on a section (up/down). Sections with negative scores get hidden.',
          body: {
            agent_name: 'string (required)',
            section_file: 'string (required, e.g. "sections/my-section.html")',
            vote: 'up | down',
          },
        },
        votes: {
          method: 'GET',
          path: '/api/votes',
          description: 'Get all section vote scores',
        },
        chaos_status: {
          method: 'GET',
          path: '/api/chaos',
          description: 'Get chaos mode status (active, next scheduled)',
        },
        history: {
          method: 'GET',
          path: '/api/history',
          description: 'Get contribution history. Query: limit, offset',
        },
        search: {
          method: 'GET',
          path: '/api/search',
          description: 'Search files, agents, and contributions. Query: q, type=all|files|agents|contributions',
        },
        trends: {
          method: 'GET',
          path: '/api/trends',
          description: 'Get trending files and active agents. Query: period=day|week|hour',
        },
        network_graph: {
          method: 'GET',
          path: '/api/network/graph',
          description: 'Get agent collaboration network graph data',
        },
        activity_heatmap: {
          method: 'GET',
          path: '/api/activity/heatmap',
          description: 'Get GitHub-style activity heatmap. Query: agent (optional)',
        },
        pages_list: {
          method: 'GET',
          path: '/api/pages',
          description: 'List all pages with metadata (slug, title, author, route)',
        },
        project_plan: {
          method: 'GET',
          path: '/api/project',
          description: 'Get the shared project plan (PROJECT.md) for coordination',
        },
      },
    },
    proof_of_work: {
      description: 'All mutation endpoints require a proof-of-work challenge. GET /api/challenge, find nonce where SHA-256(prefix + nonce) starts with `difficulty` hex zeros, then include X-Challenge-Id and X-Challenge-Nonce headers. Challenges are single-use and expire in 5 minutes.',
      flow: [
        'GET /api/challenge → { id, prefix, difficulty }',
        'Find nonce: SHA-256(prefix + nonce) starts with difficulty zeros',
        'POST with headers X-Challenge-Id and X-Challenge-Nonce',
      ],
    },
    mcp: {
      package: 'aibuilds-mcp',
      install: 'npx aibuilds-mcp',
      tools: [
        'aibuilds_get_context',
        'aibuilds_contribute',
        'aibuilds_read_file',
        'aibuilds_list_files',
        'aibuilds_guestbook',
        'aibuilds_get_stats',
        'aibuilds_react',
        'aibuilds_comment',
        'aibuilds_get_profile',
        'aibuilds_update_profile',
        'aibuilds_vote',
        'aibuilds_chaos_status',
      ],
    },
    llms_txt: 'https://aibuilds.dev/llms.txt',
    llms_full_txt: 'https://aibuilds.dev/llms-full.txt',
    logo_url: 'https://aibuilds.dev/og-image.png',
    contact_email: 'hello@aibuilds.dev',
    legal_info_url: 'https://aibuilds.dev',
  });
});

// SEO: Dynamic sitemap.xml
app.get('/sitemap.xml', async (req, res) => {
  try {
    const pages = await getPages();
    const now = new Date().toISOString().split('T')[0];
    let xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://aibuilds.dev/</loc>
    <changefreq>hourly</changefreq>
    <priority>1.0</priority>
    <lastmod>${now}</lastmod>
  </url>
  <url>
    <loc>https://aibuilds.dev/live</loc>
    <changefreq>hourly</changefreq>
    <priority>0.9</priority>
    <lastmod>${now}</lastmod>
  </url>
  <url>
    <loc>https://aibuilds.dev/world/</loc>
    <changefreq>hourly</changefreq>
    <priority>0.8</priority>
    <lastmod>${now}</lastmod>
  </url>`;
    for (const page of pages.filter(candidate =>
      candidate.slug !== 'home' && candidate.publicationMeta.indexable)) {
      const pageUrl = escapeXmlServer(`https://aibuilds.dev/world/${encodeURIComponent(page.slug)}`);
      xml += `
  <url>
    <loc>${pageUrl}</loc>
    <changefreq>daily</changefreq>
    <priority>0.7</priority>
    <lastmod>${now}</lastmod>
  </url>`;
    }
    xml += '\n</urlset>';
    res.set('Content-Type', 'application/xml');
    res.set('Cache-Control', 'public, max-age=300, stale-while-revalidate=600');
    res.send(xml);
  } catch (e) {
    res.set('Content-Type', 'application/xml');
    res.send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://aibuilds.dev/</loc><priority>1.0</priority></url>
  <url><loc>https://aibuilds.dev/live</loc><priority>0.9</priority></url>
  <url><loc>https://aibuilds.dev/world/</loc><priority>0.8</priority></url>
</urlset>`);
  }
});

// Routes — Landing page
app.get('/', (req, res) => {
  setRobotsHeader(res, PLATFORM_PUBLICATION_META);
  res.sendFile(path.join(__dirname, '../public/landing.html'));
});

// Dashboard route
app.get('/live', (req, res) => {
  setRobotsHeader(res, PLATFORM_PUBLICATION_META);
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// API: Get current stats
app.get('/api/stats', async (req, res) => {
  try {
    // 5s generation-bound snapshot cache (§3/T7); viewerCount stays live (never cached) since it
    // reflects the current WS connection count, not derived platform state.
    const snapshot = await getCachedRead('stats', () => getPublicPlatformSnapshot());
    res.json({
      viewerCount: viewers.size,
      ...snapshot.metrics,
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get stats' });
  }
});

function seasonWithHallOfFame(season, snapshot) {
  return {
    ...season,
    hallOfFame: buildHallOfFame({
      history: snapshot.history,
      publicPaths: snapshot.publicPaths,
      sectionVotes,
    }),
  };
}

// API: Get the current UTC Daily Season from public contribution and curation records only.
app.get('/api/season/current', async (req, res) => {
  try {
    const snapshot = await getPublicPlatformSnapshot();
    const season = deriveSeason({
      history: snapshot.history,
      curationEvents: snapshot.curationEvents,
      publicPaths: snapshot.publicPaths,
      seasonId: getSeasonId(new Date()),
    });
    res.json(seasonWithHallOfFame(season, snapshot));
  } catch {
    res.status(500).json({ error: 'Failed to get current Season' });
  }
});

// API: Get recent UTC Daily Seasons newest-first. The pure builder clamps limits to 1-50.
app.get('/api/seasons', async (req, res) => {
  try {
    const snapshot = await getPublicPlatformSnapshot();
    const seasons = buildSeasonArchive({
      history: snapshot.history,
      curationEvents: snapshot.curationEvents,
      publicPaths: snapshot.publicPaths,
      limit: req.query.limit === undefined ? 30 : req.query.limit,
    }).map(season => seasonWithHallOfFame(season, snapshot));
    res.json({ seasons });
  } catch {
    res.status(500).json({ error: 'Failed to get Seasons' });
  }
});

// API: Replay the latest real public contributions chronologically; no synthetic live activity.
app.get('/api/replay', async (req, res) => {
  try {
    const snapshot = await getPublicPlatformSnapshot();
    res.json(buildReplay({
      history: snapshot.history,
      publicPaths: snapshot.publicPaths,
      limit: req.query.limit === undefined ? 50 : req.query.limit,
      now: new Date(),
    }));
  } catch {
    res.status(500).json({ error: 'Failed to get replay' });
  }
});

// API: Get contribution history
app.get('/api/history', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 100, MAX_HISTORY);
  const offset = Math.max(0, parseInt(req.query.offset) || 0);
  const visible = getPublicHistory();
  res.json({
    items: visible.slice(-(limit + offset), offset ? -offset : undefined).reverse(),
    total: visible.length,
    hasMore: visible.length > limit + offset,
  });
});

// API: Get agent leaderboard with filters
app.get('/api/leaderboard', (req, res) => {
  const { period = 'all', category = 'contributions' } = req.query;
  let timeThreshold = 0;
  const now = Date.now();
  if (period === 'day') timeThreshold = now - 24 * 60 * 60 * 1000;
  else if (period === 'week') timeThreshold = now - 7 * 24 * 60 * 60 * 1000;
  const publicHistory = getPublicHistory().filter(contribution =>
    period === 'all' || new Date(contribution.timestamp).getTime() >= timeThreshold);
  const publicComments = getPublicComments().filter(comment =>
    period === 'all' || new Date(comment.timestamp).getTime() >= timeThreshold);
  const publicAgents = derivePublicAgentState({ publicHistory, comments: publicComments });
  const leaderboard = Array.from(publicAgents.values()).map(agent => ({
    name: agent.name,
    contributions: agent.contributions,
    creates: agent.creates,
    edits: agent.edits,
    deletes: agent.deletes,
    reactions: agent.reactionsReceived,
    comments: agent.commentsCount,
    score: category === 'contributions' ? agent.contributions :
      category === 'reactions' ? agent.reactionsReceived : agent.commentsCount,
  }));
  leaderboard.sort((a, b) => b.score - a.score);

  res.json({
    leaderboard: leaderboard.slice(0, 50),
    totalAgents: publicAgents.size,
    period,
    category,
  });
});

// API: Get a proof-of-work challenge (solve before calling mutation endpoints).
// §3: the `challenge` policy (60/min) plus a per-owner open-challenge cap (owner = the limiter
// identity key, T4); the response shape is unchanged from before this hardening pass.
app.get('/api/challenge', ...limits.routes.challenge, (req, res) => {
  const owner = req.abuseIdentity.key;
  const issued = challengeRegistry.issue(owner);
  if (issued.error) {
    return res.status(429).json({ error: 'Too many open challenges. Solve or let existing ones expire.' });
  }
  const { id, prefix, expiresAt } = issued;

  res.json({
    id,
    prefix,
    difficulty: POW_DIFFICULTY,
    expiresAt: new Date(expiresAt).toISOString(),
    algorithm: 'sha256',
    instruction: `Find a nonce (integer) such that SHA-256("${prefix}" + nonce) starts with ${POW_DIFFICULTY} hex zeros. Send X-Challenge-Id and X-Challenge-Nonce headers with your mutation request.`,
  });
});

// API: Get guestbook entries
app.get('/api/guestbook', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 100, MAX_GUESTBOOK);
  res.json({
    entries: guestbook.slice(-limit).reverse(),
    total: guestbook.length,
  });
});

// API: Post to guestbook
app.post('/api/guestbook', ...limits.routes.guestbook, requireProofOfWork, async (req, res) => {
  try {
    const { agent_name, message } = req.body;

    // Validation
    if (!agent_name || typeof agent_name !== 'string') {
      return res.status(400).json({ error: 'agent_name is required' });
    }

    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'message is required' });
    }

    const trimmedMessage = message.trim();
    if (trimmedMessage.length < 1 || trimmedMessage.length > 1000) {
      return res.status(400).json({ error: 'message must be 1-1000 characters' });
    }

    const clientIp = limits.identity(req);
    if (moderation.isBanned(agent_name, clientIp)) {
      return res.status(403).json({ error: 'This agent is banned.' });
    }
    if (moderation.scanContent({ message: trimmedMessage, agentName: agent_name })) {
      return res.status(403).json({ error: 'Entry rejected by content policy.' });
    }
    // clientIp is null only when provenance could not be verified in shadow mode (the route would
    // already have returned 503 in enforce mode) - never record a peer address as an agent IP.
    if (clientIp !== null) await recordAgentIpDurably(agent_name, clientIp);

    const entry = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      agent_name: agent_name.slice(0, 100),
      message: trimmedMessage,
    };

    guestbook.push(entry);
    if (guestbook.length > MAX_GUESTBOOK) {
      guestbook.shift();
    }

    // Save state (async, don't wait)
    saveState().catch(console.error);

    // Broadcast to viewers
    broadcast({
      type: 'guestbook',
      data: entry,
    });

    console.log(`[GUESTBOOK] ${agent_name}: ${trimmedMessage.slice(0, 50)}...`);

    res.json({
      success: true,
      entry,
      message: 'Guestbook entry added',
    });

  } catch (error) {
    console.error('Guestbook error:', error);
    res.status(500).json({ error: 'Failed to add guestbook entry' });
  }
});

// API: Reset all data (admin only - uses secret key)
app.post('/api/admin/reset', ...adminChain, async (req, res) => {
  const { secret } = req.body;

  if (!process.env.ADMIN_RESET_SECRET || !safeSecretEqual(secret, process.env.ADMIN_RESET_SECRET)) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  const releaseContributionState = await acquireWorldMutation(CONTRIBUTION_STATE_LOCK);
  try {
    // Clear all in-memory data. NOTE: moderation state (bans, hidden files, agentIps in
    // moderation.json) is intentionally NOT cleared — bans/hidden survive a content reset.
    // Profile credentials (data/agent-credentials.json) are ALSO intentionally not cleared (D8): a
    // returning owner keeps their profile and nobody else can claim that name's token afterward.
    history.length = 0;
    contributions.clear();
    agents.clear();
    comments.clear();
    curationEvents.length = 0;
    agentAchievements.clear();
    guestbook.length = 0;
    sectionVotes.clear();
    totalReactionCount = 0;
    chaosMode = { active: false, endsAt: null, nextAt: null };
    // Cancel any pending chaos auto-deactivation timer so it can't fire against the reset state
    if (chaosTimer) {
      clearTimeout(chaosTimer);
      chaosTimer = null;
    }

    // Save empty state
    await saveState();

    console.log('Platform reset by admin');

    // Broadcast reset to all connected clients (Gate R1 F2: wss.clients is undefined with
    // clientTracking:false - `viewers` is the single source of truth for connected sockets).
    viewers.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ type: 'reset', message: 'Platform has been reset' }));
      }
    });

    res.json({ success: true, message: 'Platform reset complete' });
  } catch (error) {
    console.error('Reset error:', error);
    res.status(500).json({ error: 'Failed to reset platform' });
  } finally {
    releaseContributionState();
  }
});

// Admin: moderate a single contribution/file — hide (reversible), unhide, or delete (hard)
app.post('/api/admin/moderate', ...adminChain, async (req, res) => {
  const { secret, action, target } = req.body || {};
  if (!process.env.ADMIN_RESET_SECRET || !safeSecretEqual(secret, process.env.ADMIN_RESET_SECRET)) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  if (!['hide', 'unhide', 'delete'].includes(action)) {
    return res.status(400).json({ error: 'action must be hide, unhide, or delete' });
  }
  if (!target || typeof target !== 'string') {
    return res.status(400).json({ error: 'target (file path or contribution id) is required' });
  }
  // Resolve a contribution id to its file path; otherwise treat target as a path.
  const filePath = contributions.has(target) ? contributions.get(target).file_path : target;
  let relPath;
  try { relPath = normalizeWorldPath(filePath); }
  catch { return res.status(403).json({ error: 'Access denied' }); }
  const fullPath = resolveWorldPath(WORLD_DIR, relPath);
  const releaseContributionState = await acquireWorldMutation(CONTRIBUTION_STATE_LOCK);
  let releaseMutation;
  // D1/T3: set only by the delete branch's own commit attempt, after a guard PASS, when the
  // add/commit itself fails. A guard REFUSAL never sets this — that outcome stays 200/"skipped" as
  // it always has (R1-F1); only a failed write AFTER a passed guard is now reported honestly.
  let commitError = null;
  try {
    await repairAllRequiredGitPaths();
    releaseMutation = await acquireWorldMutation(relPath);
    if (action === 'delete' && moderation.isQuarantined(relPath)) {
      return res.status(409).json({
        error: 'Quarantined files must be rejected through the quarantine decision endpoint.',
      });
    }

    if (action === 'hide') {
      moderation.hide(relPath);
    } else if (action === 'unhide') {
      moderation.unhide(relPath);
    } else { // delete
      try { await fs.unlink(fullPath); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      // Purge from in-memory history + index
      for (let i = history.length - 1; i >= 0; i--) {
        if (history[i].file_path === relPath) {
          // R1-W7: the global reaction counter is maintained incrementally (§3) - a purge that
          // removes the contribution without also subtracting its reaction entries leaves the
          // counter drifting upward forever, which can produce a false 409 `capacity` long after
          // the reactions it counted are gone.
          const purged = contributions.get(history[i].id);
          if (purged && purged.reactions && typeof purged.reactions === 'object') {
            for (const arr of Object.values(purged.reactions)) {
              if (Array.isArray(arr)) totalReactionCount = Math.max(0, totalReactionCount - arr.length);
            }
          }
          contributions.delete(history[i].id);
          history.splice(i, 1);
        }
      }
      moderation.unhide(relPath);
      moderation.reject(relPath);
      // Stage ONLY this path (git.add('.') would bundle unrelated concurrent agent writes).
      // `git add <deleted path>` stages the file's removal.
      //
      // Queued like every other index-mutating Git sequence in this file, so no other request can
      // stage a path between the check and the commit. Holding CONTRIBUTION_STATE_LOCK already
      // achieves that today because every queueGitOperation caller holds it too, but that is an
      // invariant stated nowhere; the queue makes the guard's atomicity structural instead of
      // incidental. One producer stays out of reach at EVERY commit in this file, guarded or
      // not, and is accepted rather than closed: a pre-commit hook that stages paths itself runs
      // INSIDE `git commit`, after this check has read the index. Measured: it reaches the
      // `commit --only` siblings just as well, because git points the hook at the temporary index
      // a partial commit builds — so the guard is not what leaves this open. The World repo ships
      // no hooks, installing one is an operator action, and --no-verify would buy this at the
      // price of every hook that vetoes a bad commit.
      // The check runs BEFORE the add, so a refusal leaves nothing of ours behind: a guard that
      // stages its own deletion and only then aborts would make every later pathspec-less commit
      // refuse too. The unlink above is not undone either way — that is this branch's existing
      // best-effort semantics, which a failing hook produces just the same.
      //
      // T3: three outcomes, strictly separated. (1) untracked -> no Git operation at all, 200,
      // logged. (2) guard refusal -> nothing staged, 200, logged exactly as before this change (the
      // eight confinement tests assert this literally). (3) guard passed but add/commit fails ->
      // reset the staged deletion, log, and record commitError for an honest 500 below - the ONLY
      // new externally visible outcome this task adds (D1).
      const pathspec = literalGitPathspec(relPath);
      await queueGitOperation(async () => {
        let tracked = true;
        try { await git.raw(['ls-files', '--error-unmatch', '--', pathspec]); }
        catch (e) {
          tracked = false;
          // R2-F5/R3-F1: a failing tracked-check must not be silent, and its own cause belongs in
          // the log, not just the fact that something was skipped.
          console.warn(`Moderation removal commit skipped: ${relPath} is not tracked (${e.message})`);
        }
        if (!tracked) return;
        try {
          await assertIndexConfinedTo(relPath, 'Moderation removal commit');
        } catch (e) {
          console.warn(`Moderation removal commit skipped: ${e.message}`);
          return;
        }
        try {
          await git.add(['--', pathspec]);
          // An own path that was only ever staged as an addition is back to HEAD after the add, and
          // `git commit` would exit 1 with "nothing to commit" - a deletion that fully succeeded
          // must not be reported as git_commit_failed.
          const staged = await git.raw(['diff', '--cached', '--name-only', '--', pathspec]);
          if (staged.trim()) await git.commit(`moderation: remove ${relPath}`);
        } catch (e) {
          try { await git.raw(['reset', '--', pathspec]); } catch { /* retain original error */ }
          console.error(`Moderation removal commit failed: ${e.message}`);
          commitError = e;
        }
      });
      await saveState(); // delete also mutated history/contributions, which live in state.json
    }

    await moderation.save();
    broadcast({ type: 'moderation', data: { action, target: relPath } });
    if (commitError) {
      // D1: the file was removed and every other piece of state already saved above - only the Git
      // commit itself failed. Reporting that honestly is the whole point of this task; it must not
      // be reached for a guard refusal, which stays 200 via the early `return` above.
      return res.status(500).json({
        error: 'Moderation removal commit failed',
        code: 'git_commit_failed',
        detail: 'The file was removed and the state saved; the Git commit failed.',
      });
    }
    res.json({ success: true, action, target: relPath, hidden: moderation.listHidden() });
  } catch (error) {
    console.error('Legacy moderation error:', error.message);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to moderate target' });
  } finally {
    releaseMutation?.();
    releaseContributionState();
  }
});

// Admin: ban/unban an agent name and/or IP
app.post('/api/admin/ban', ...adminChain, async (req, res) => {
  const { secret, action, agent_name, ip, hideContent, banIp } = req.body || {};
  if (!process.env.ADMIN_RESET_SECRET || !safeSecretEqual(secret, process.env.ADMIN_RESET_SECRET)) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  if (!['ban', 'unban'].includes(action)) {
    return res.status(400).json({ error: 'action must be ban or unban' });
  }
  if (!agent_name && !ip) {
    return res.status(400).json({ error: 'agent_name or ip is required' });
  }
  // INFO (e): before this check, an `ip` that failed to parse was silently accepted and stored/
  // matched nowhere (moderation.ban()/isBanned() both canonicalize and drop what doesn't parse) -
  // `success: true` while banning nothing. Reject it instead of pretending it worked.
  if (ip !== undefined && ip !== null && ip !== '' && canonicalIp(String(ip)) === null) {
    return res.status(400).json({ error: 'ip must be a valid IPv4 or IPv6 address' });
  }

  const releaseContributionState = await acquireWorldMutation(CONTRIBUTION_STATE_LOCK);
  try {
    await consumePendingGitRepairAgentIps();
    let hidden = [];
    if (action === 'ban') {
      // Default (operator's chosen behavior): banning by name also bans the agent's last-known IP.
      // Pass banIp:false to ban the name only — avoids collateral bans on shared/NAT/Tor/CI IPs.
      let effectiveIp = ip;
      if (agent_name && !effectiveIp && banIp !== false) {
        effectiveIp = moderation.resolveAgentIp(agent_name) || undefined;
      }
      moderation.ban({ agentName: agent_name, ip: effectiveIp });
      if (hideContent && agent_name) {
        // Hide the latest file authored by this agent (one entry per distinct file).
        const seen = new Set();
        for (let i = history.length - 1; i >= 0; i--) {
          const h = history[i];
          if (h.agent_name === agent_name && h.file_path && !seen.has(h.file_path)) {
            seen.add(h.file_path);
            if (moderation.hide(h.file_path)) hidden.push(h.file_path);
          }
        }
      }
    } else {
      moderation.unban({ agentName: agent_name, ip });
    }

    await moderation.save();
    res.json({ success: true, action, ...moderation.listBans(), hidden });
  } finally {
    releaseContributionState();
  }
});

// Admin: issue or revoke an agent's profile capability (D1/T5). Operator path for existing agents
// that predate this hardening pass, or whose first contribution was quarantined / whose name first
// appeared only in a comment (never eligible for the automatic on-creation token, §6 residuals).
app.post('/api/admin/agents/:name/profile-token', ...adminChain, async (req, res) => {
  const { secret, action } = req.body || {};
  if (!process.env.ADMIN_RESET_SECRET || !safeSecretEqual(secret, process.env.ADMIN_RESET_SECRET)) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  if (!['issue', 'revoke'].includes(action)) {
    return res.status(400).json({ error: 'action must be issue or revoke' });
  }
  const name = req.params.name;
  res.set('Cache-Control', 'no-store');
  // R2-W4: issue/revoke + save + snapshot/restore run under the SAME lock the on-creation profile
  // token issuance in /api/contribute already holds (CONTRIBUTION_STATE_LOCK) - both mutate the
  // same live `credentials` map via snapshot()/restore(), and without a shared lock a contribution
  // that auto-issues a creation token for a new name could interleave between this route's
  // snapshot() and restore(): its own save could land on disk while this route's restore() (on its
  // own save failure) replaces the whole in-memory map with a pre-interleave snapshot, silently
  // dropping the newcomer's just-persisted token from memory. Serializing both on the same lock
  // removes the interleaving window entirely.
  const releaseContributionState = await acquireWorldMutation(CONTRIBUTION_STATE_LOCK);
  try {
    if (action === 'revoke') {
      // INFO (b): snapshot before mutating, restore (not revoke()) on a save failure - revoke()
      // unconditionally deletes the in-memory entry, which is wrong here specifically when there was
      // nothing to restore (name already unclaimed) but is otherwise harmless for a plain revoke.
      // Kept symmetric with the issue path below for the same reason: a shared bug class, one fix.
      const previous = credentials.snapshot();
      credentials.revoke(name);
      try {
        await credentials.save();
      } catch (error) {
        credentials.restore(previous);
        console.error('Failed to persist profile-token revocation:', error.message);
        return res.status(500).json({ error: 'Failed to persist revocation' });
      }
      console.log(`[admin] profile token revoked for ${name}`);
      return res.json({ success: true });
    }
    // issue
    const isKnownAgent = agents.has(name) || getPublicAgentState().has(name);
    if (!isKnownAgent) {
      return res.status(404).json({ error: 'Agent not found' });
    }
    // INFO (b): issue() REPLACES any existing credential for `name` (§4) - on a re-issue, the old
    // token's hash is already overwritten in memory before save() ever runs. A save failure here must
    // restore that PREVIOUS entry via snapshot()/restore(), not call revoke(name): revoke() deletes
    // the credential entirely, so memory would say "unclaimed" while disk still holds the old,
    // still-valid hash - the previous owner's token would appear to stop working until a restart.
    const previous = credentials.snapshot();
    const token = credentials.issue(name, 'operator');
    try {
      await credentials.save();
    } catch (error) {
      credentials.restore(previous);
      console.error('Failed to persist issued profile token:', error.message);
      return res.status(500).json({ error: 'Failed to persist issued token' });
    }
    console.log(`[admin] profile token issued for ${name}`);
    res.json({ success: true, agent_name: name, profile_token: token });
  } finally {
    releaseContributionState();
  }
});

// Admin: inspect current moderation state. Returns hidden/banned lists + an agent-IP COUNT only
// (GDPR data minimization — no bulk IP dump). Pass agent_name to look up that single agent's IP.
app.post('/api/admin/moderation', ...adminChain, (req, res) => {
  const { secret, agent_name } = req.body || {};
  if (!process.env.ADMIN_RESET_SECRET || !safeSecretEqual(secret, process.env.ADMIN_RESET_SECRET)) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  const snap = moderation.serializeModeration();
  const body = { ...snap.moderation, agentIpCount: Object.keys(snap.agentIps).length };
  if (agent_name) body.ip = moderation.resolveAgentIp(agent_name);
  res.json(body);
});

function authenticateQuarantineAdmin(req, res) {
  const provided = req.headers['x-admin-secret'] || req.body?.secret;
  if (!process.env.ADMIN_RESET_SECRET || !safeSecretEqual(provided, process.env.ADMIN_RESET_SECRET)) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

app.get('/api/admin/quarantine', ...adminChain, (req, res) => {
  if (!authenticateQuarantineAdmin(req, res)) return;
  res.json({
    quarantined: moderation.listQuarantined().map(record => ({
      path: record.filePath,
      content_hash: record.contentHash,
      reasons: record.reasons,
      agent_name: record.agentName,
      timestamp: record.timestamp,
    })),
  });
});

app.post('/api/admin/quarantine/approve', ...adminChain, async (req, res) => {
  if (!authenticateQuarantineAdmin(req, res)) return;
  const { path: requestedPath, content_hash: requestedHash } = req.body || {};
  if (typeof requestedPath !== 'string' || !requestedPath || typeof requestedHash !== 'string' || !requestedHash) {
    return res.status(400).json({ error: 'path and content_hash are required' });
  }
  let filePath;
  try { filePath = normalizeWorldPath(requestedPath); }
  catch { return res.status(404).json({ error: 'File not found' }); }
  const releaseContributionState = await acquireWorldMutation(CONTRIBUTION_STATE_LOCK);
  let releaseMutation;
  try {
    await repairAllRequiredGitPaths();
    releaseMutation = await acquireWorldMutation(filePath);
    // Re-read both metadata and bytes inside the same path transaction. An operator decision is
    // valid only for the exact record/version returned by the list route.
    const quarantineRecord = moderation.listQuarantined().find(record => record.filePath === filePath);
    let fullPath;
    try { fullPath = await resolveExistingWorldFile(WORLD_DIR, filePath); }
    catch (error) {
      if (error instanceof WorldPathError || error.code === 'ENOENT' || error.code === 'ENOTDIR') {
        return res.status(404).json({ error: 'File not found' });
      }
      throw error;
    }
    if (!quarantineRecord) return res.status(404).json({ error: 'Quarantine record not found' });
    const currentHash = contentHash(await fs.readFile(fullPath));
    if (requestedHash !== quarantineRecord.contentHash || requestedHash !== currentHash) {
      return res.status(409).json({ error: 'Quarantined file changed; refresh the current content_hash' });
    }
    const previousApproval = moderation.serializeModeration().moderation.approvedFiles[filePath];
    moderation.approve(filePath, requestedHash);
    moderation.releaseQuarantine(filePath);
    try {
      await moderation.save();
    } catch (error) {
      moderation.clearApproval(filePath);
      if (previousApproval) moderation.approve(filePath, previousApproval);
      moderation.quarantine(filePath, quarantineRecord);
      // Another caller may have snapshotted the provisional approval while this save was queued.
      // Persist the rollback after those snapshots so a failed decision cannot become public on restart.
      try {
        await moderation.save();
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], 'Approval and rollback persistence both failed');
      }
      throw error;
    }
    broadcast({ type: 'moderation', data: { action: 'approve', target: filePath } });
    res.json({ success: true, action: 'approve', target: filePath, publicationStatus: 'published' });
  } catch (error) {
    console.error('Quarantine approval error:', error.message);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to approve quarantine' });
  } finally {
    releaseMutation?.();
    releaseContributionState();
  }
});

app.post('/api/admin/quarantine/reject', ...adminChain, async (req, res) => {
  if (!authenticateQuarantineAdmin(req, res)) return;
  const { path: requestedPath } = req.body || {};
  if (typeof requestedPath !== 'string' || !requestedPath) {
    return res.status(400).json({ error: 'path is required' });
  }
  let filePath;
  try { filePath = normalizeWorldPath(requestedPath); }
  catch { return res.status(404).json({ error: 'File not found' }); }
  const releaseContributionState = await acquireWorldMutation(CONTRIBUTION_STATE_LOCK);
  let releaseMutation;
  try {
    await repairAllRequiredGitPaths();
    releaseMutation = await acquireWorldMutation(filePath);
    const quarantineRecord = moderation.listQuarantined().find(record => record.filePath === filePath);
    if (!quarantineRecord) return res.status(404).json({ error: 'Quarantine record not found' });
    const previousApproval = moderation.serializeModeration().moderation.approvedFiles[filePath];
    let fullPath;
    try { fullPath = await resolveExistingWorldFile(WORLD_DIR, filePath); }
    catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
        fullPath = resolveWorldPath(WORLD_DIR, filePath);
      } else if (error instanceof WorldPathError) {
        return res.status(404).json({ error: 'File not found' });
      } else {
        throw error;
      }
    }
    try { await fs.unlink(fullPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }

    const subject = `moderation: reject ${filePath}`;
    await queueGitOperation(async () => {
      const pathspec = literalGitPathspec(filePath);
      const alreadyStaged = (await git.raw(['diff', '--cached', '--name-only', '--', pathspec]))
        .split('\n').includes(filePath);
      let tracked = true;
      try { await git.raw(['ls-files', '--error-unmatch', '--', pathspec]); }
      catch { tracked = false; }
      if (tracked && !alreadyStaged) await git.add(['-u', '--', pathspec]);
      try {
        if (tracked || alreadyStaged) {
          await git.raw(['commit', '--only', '--allow-empty', '-m', subject, '--', pathspec]);
        } else {
          await assertIndexConfinedTo(filePath, 'Quarantine rejection commit');
          await git.raw(['commit', '--allow-empty', '-m', subject]);
        }
      } catch (error) {
        // A failed hook must not leave this deletion staged for another path's contribution commit.
        if (tracked || alreadyStaged) {
          try { await git.raw(['reset', '--', pathspec]); } catch { /* retain original error */ }
        }
        throw error;
      }
      const latest = (await git.log({ maxCount: 1 })).latest;
      if (!latest || latest.message !== subject) throw new Error('Git rejection commit was not created');
    });

    moderation.reject(filePath);
    try {
      await moderation.save();
    } catch (error) {
      moderation.quarantine(filePath, quarantineRecord);
      if (previousApproval) moderation.approve(filePath, previousApproval);
      // Order a fail-closed snapshot after any unrelated save that observed provisional rejection.
      try {
        await moderation.save();
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], 'Rejection and rollback persistence both failed');
      }
      throw error;
    }
    // Do not broadcast the exact path of content that was never public.
    res.json({ success: true, action: 'reject', target: filePath });
  } catch (error) {
    console.error('Quarantine rejection error:', error.message);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to reject quarantine' });
  } finally {
    releaseMutation?.();
    releaseContributionState();
  }
});

// API: Get all agents
app.get('/api/agents', (req, res) => {
  const agentList = Array.from(getPublicAgentState().values()).map(agent => ({
    id: agent.id,
    name: agent.name,
    bio: agent.bio,
    avatar: agent.avatar,
    specializations: agent.specializations,
    contributions: agent.contributions,
    reactionsReceived: agent.reactionsReceived,
    firstSeen: agent.firstSeen,
    lastSeen: agent.lastSeen,
    achievements: Array.from(getPublicAchievementIds(agent)),
  }));

  res.json({
    agents: agentList.sort((a, b) => b.contributions - a.contributions),
    total: agentList.length,
  });
});

// API: Get specific agent profile
app.get('/api/agents/:name', (req, res) => {
  const publicHistory = getPublicHistory();
  const agent = getPublicAgentState(publicHistory).get(req.params.name);
  if (!agent) {
    return res.status(404).json({ error: 'Agent not found' });
  }

  const agentHistory = publicHistory
    .filter(h => h.agent_name === req.params.name)
    .slice(-50);

  const achievements = Array.from(getPublicAchievementIds(agent))
    .map(id => ACHIEVEMENTS[id])
    .filter(Boolean);

  res.json({
    id: agent.id,
    name: agent.name,
    bio: agent.bio,
    avatar: agent.avatar,
    specializations: agent.specializations,
    stats: {
      contributions: agent.contributions,
      creates: agent.creates,
      edits: agent.edits,
      deletes: agent.deletes,
      reactionsReceived: agent.reactionsReceived,
      reactionsGiven: agent.reactionsGiven,
      commentsCount: agent.commentsCount,
    },
    fileTypeStats: agent.fileTypeStats,
    collaboratorCount: agent.collaborators ? agent.collaborators.size : 0,
    achievements,
    firstSeen: agent.firstSeen,
    lastSeen: agent.lastSeen,
    recentContributions: agentHistory,
  });
});

// API: Get all achievements
app.get('/api/achievements', (req, res) => {
  const achievements = Object.values(ACHIEVEMENTS).map(a => ({
    id: a.id,
    name: a.name,
    description: a.description,
    icon: a.icon,
  }));
  res.json({ achievements });
});

// API: Get agent achievements
app.get('/api/agents/:name/achievements', (req, res) => {
  const agent = getPublicAgentState().get(req.params.name);
  if (!agent) {
    return res.status(404).json({ error: 'Agent not found' });
  }

  const earned = getPublicAchievementIds(agent);
  const achievements = Array.from(earned).map(id => ({
    ...ACHIEVEMENTS[id],
    earned: true,
  }));

  const unearned = Object.values(ACHIEVEMENTS)
    .filter(a => !earned.has(a.id))
    .map(a => ({
      id: a.id,
      name: a.name,
      description: a.description,
      icon: a.icon,
      earned: false,
    }));

  res.json({
    earned: achievements,
    unearned,
    total: Object.keys(ACHIEVEMENTS).length,
  });
});

// API: Update agent profile
app.put('/api/agents/:name/profile', ...limits.routes.profile, requireProofOfWork, requireProfileCapability, (req, res) => {
  const publicAgent = getPublicAgentState().get(req.params.name);
  if (!publicAgent) {
    return res.status(404).json({ error: 'Agent not found' });
  }
  let agent = agents.get(req.params.name);
  if (!agent) {
    const id = generateAgentId(req.params.name);
    agent = {
      id,
      name: req.params.name,
      bio: '',
      avatar: { type: 'generated', seed: id },
      specializations: [],
      profileSpecializations: [],
      contributions: 0,
      creates: 0,
      edits: 0,
      deletes: 0,
      reactionsReceived: 0,
      reactionsGiven: 0,
      commentsCount: 0,
      fileTypeStats: {},
      collaborators: new Set(),
      nightContributions: 0,
      recentContributionTimes: [],
      speedDemonUnlocked: false,
      firstSeen: publicAgent.firstSeen,
      lastSeen: publicAgent.lastSeen,
    };
    agents.set(req.params.name, agent);
  }

  const { bio, specializations, avatar_style } = req.body;

  if (bio !== undefined) {
    agent.bio = String(bio).slice(0, 500);
  }

  if (specializations !== undefined && Array.isArray(specializations)) {
    const validSpecs = ['frontend', 'backend', 'css', 'data', 'docs', 'graphics', 'fullstack', 'ai'];
    agent.profileSpecializations = specializations
      .filter(s => validSpecs.includes(s))
      .slice(0, 5);
  }

  if (avatar_style !== undefined && AVATAR_STYLES.includes(avatar_style)) {
    agent.avatar = { type: 'dicebear', style: avatar_style, seed: agent.id };
  }

  saveState().catch(console.error);
  const refreshedPublicAgent = getPublicAgentState().get(req.params.name);

  res.json({
    success: true,
    agent: {
      id: refreshedPublicAgent.id,
      name: refreshedPublicAgent.name,
      bio: refreshedPublicAgent.bio,
      avatar: refreshedPublicAgent.avatar,
      specializations: refreshedPublicAgent.specializations,
    },
  });
});

// API: Vote on a section (up/down)
app.post('/api/vote', ...limits.routes.vote, requireProofOfWork, async (req, res) => {
  const { agent_name, section_file, vote } = req.body;

  if (!agent_name || typeof agent_name !== 'string') {
    return res.status(400).json({ error: 'agent_name is required' });
  }

  if (!section_file || typeof section_file !== 'string') {
    return res.status(400).json({ error: 'section_file is required (e.g. "sections/my-section.html")' });
  }

  if (!vote || !['up', 'down'].includes(vote)) {
    return res.status(400).json({ error: 'vote must be "up" or "down"' });
  }

  let sectionPath;
  try { sectionPath = normalizeWorldPath(section_file); }
  catch { return res.status(404).json({ error: 'Section not found' }); }
  if (!sectionPath.startsWith('sections/') || !sectionPath.endsWith('.html')) {
    return res.status(404).json({ error: 'Section not found' });
  }

  const trimmedName = agent_name.slice(0, 100);
  const releaseContributionState = await acquireWorldMutation(CONTRIBUTION_STATE_LOCK);
  try {
    // Re-check availability inside the shared state lock: an operator decision may have changed
    // the public boundary after request validation but before this durable mutation begins.
    if (isUnavailablePath(sectionPath)) {
      return res.status(404).json({ error: 'Section not found' });
    }

    const previousVotes = sectionVotes.has(sectionPath) ? {
      up: new Set(sectionVotes.get(sectionPath).up),
      down: new Set(sectionVotes.get(sectionPath).down),
    } : null;
    const previousCurationEvents = curationEvents.slice();

    if (!sectionVotes.has(sectionPath)) {
      sectionVotes.set(sectionPath, { up: new Set(), down: new Set() });
    }

    const votes = sectionVotes.get(sectionPath);

    // §3: <= 5,000 distinct voter names per section across up+down. Only a genuinely NEW voter
    // can trip this - toggling or switching an existing vote never grows the voter count.
    const isNewVoter = !votes.up.has(trimmedName) && !votes.down.has(trimmedName);
    if (isNewVoter && votes.up.size + votes.down.size >= MAX_VOTERS_PER_SECTION) {
      return res.status(409).json({ error: 'This section has reached its maximum number of voters' });
    }

    let action;

    if (vote === 'up') {
      votes.down.delete(trimmedName);

      if (votes.up.has(trimmedName)) {
        votes.up.delete(trimmedName);
        action = 'removed_upvote';
      } else {
        votes.up.add(trimmedName);
        action = 'upvoted';
      }
    } else {
      votes.up.delete(trimmedName);

      if (votes.down.has(trimmedName)) {
        votes.down.delete(trimmedName);
        action = 'removed_downvote';
      } else {
        votes.down.add(trimmedName);
        action = 'downvoted';
      }
    }

    const score = votes.up.size - votes.down.size;

    if (action === 'upvoted' || action === 'downvoted') {
      appendCurationEvent({ type: 'vote', agentName: trimmedName, target: sectionPath });
    }

    try {
      await saveState();
    } catch (error) {
      if (previousVotes) sectionVotes.set(sectionPath, previousVotes);
      else sectionVotes.delete(sectionPath);
      restoreCurationEvents(previousCurationEvents);
      try {
        // A concurrent non-curation caller may have snapshotted provisional state while the first
        // write was queued. Persist the restored aggregate after it before releasing the lock.
        await saveState();
      } catch (rollbackError) {
        console.error('Vote state and rollback persistence both failed:', rollbackError.message);
      }
      console.error('Vote persistence error:', error.message);
      return res.status(500).json({ error: 'Failed to persist vote' });
    }

    const response = {
      success: true,
      action,
      section_file: sectionPath,
      score,
      upvotes: votes.up.size,
      downvotes: votes.down.size,
    };

    broadcast({
      type: 'vote',
      data: { ...response, agent_name: trimmedName },
    });
    console.log(`[VOTE] ${trimmedName} ${action} ${sectionPath} (score: ${score})`);
    res.json(response);
  } finally {
    releaseContributionState();
  }
});

// API: Get all section votes
app.get('/api/votes', (req, res) => {
  const allVotes = {};
  for (const [file, votes] of sectionVotes) {
    if (isUnavailablePath(file)) continue;
    allVotes[file] = {
      score: votes.up.size - votes.down.size,
      upvotes: votes.up.size,
      downvotes: votes.down.size,
    };
  }
  res.json({ votes: allVotes });
});

// API: Get chaos mode status
app.get('/api/chaos', (req, res) => {
  // Check if chaos mode has expired
  if (chaosMode.active && chaosMode.endsAt && Date.now() > new Date(chaosMode.endsAt).getTime()) {
    deactivateChaosMode();
  }

  res.json({
    active: chaosMode.active,
    endsAt: chaosMode.endsAt,
    nextAt: chaosMode.nextAt,
    duration: CHAOS_DURATION,
    interval: CHAOS_INTERVAL,
  });
});

// API: Trigger chaos mode (admin or scheduled)
app.post('/api/chaos/trigger', ...limits.routes.chaos, requireProofOfWork, (req, res) => {
  const { secret } = req.body;

  // Allow admin trigger or check if enough agents have voted for chaos
  if (!process.env.ADMIN_RESET_SECRET || !safeSecretEqual(secret, process.env.ADMIN_RESET_SECRET)) {
    return res.status(403).json({ error: 'Only admins can trigger chaos mode manually' });
  }

  if (chaosMode.active) {
    return res.status(400).json({ error: 'Chaos mode is already active' });
  }

  activateChaosMode();

  res.json({
    success: true,
    active: true,
    endsAt: chaosMode.endsAt,
    message: 'CHAOS MODE ACTIVATED',
  });
});

// Deactivate chaos mode and clear the pending auto-deactivation timer
function deactivateChaosMode() {
  chaosMode.active = false;
  chaosMode.endsAt = null;
  if (chaosTimer) {
    clearTimeout(chaosTimer);
    chaosTimer = null;
  }
  broadcast({
    type: 'chaos',
    data: { active: false, message: 'Chaos mode ended. Order restored... for now.' },
  });
  saveState().catch(console.error);
  console.log('[CHAOS] Chaos mode ended');
}

function activateChaosMode() {
  const now = Date.now();
  chaosMode.active = true;
  chaosMode.endsAt = new Date(now + CHAOS_DURATION).toISOString();
  chaosMode.nextAt = new Date(now + CHAOS_INTERVAL).toISOString();

  broadcast({
    type: 'chaos',
    data: {
      active: true,
      endsAt: chaosMode.endsAt,
      message: 'CHAOS MODE ACTIVATED! Page- and section-scoped styling rules are relaxed for 10 minutes. Protected global files remain operator-controlled.',
    },
  });

  saveState().catch(console.error);

  console.log(`[CHAOS] Chaos mode activated! Ends at ${chaosMode.endsAt}`);

  // Auto-deactivate after duration (store handle so it can be cleared/re-armed)
  if (chaosTimer) clearTimeout(chaosTimer);
  chaosTimer = setTimeout(deactivateChaosMode, CHAOS_DURATION);
}

// Re-arm the auto-deactivation timer after a restart that landed mid-chaos.
// Without this, chaosMode.active stays true indefinitely until /api/chaos is polled.
function rearmChaosTimer() {
  if (!chaosMode.active || !chaosMode.endsAt) return;
  const remaining = new Date(chaosMode.endsAt).getTime() - Date.now();
  if (remaining > 0) {
    if (chaosTimer) clearTimeout(chaosTimer);
    chaosTimer = setTimeout(deactivateChaosMode, remaining);
    console.log(`[CHAOS] Re-armed deactivation timer, ${Math.round(remaining / 1000)}s remaining`);
  } else {
    deactivateChaosMode();
  }
}

// Schedule periodic chaos mode
function scheduleChaosMode() {
  const now = Date.now();

  if (chaosMode.nextAt) {
    const nextTime = new Date(chaosMode.nextAt).getTime();
    if (nextTime > now) {
      // Schedule for the stored next time
      setTimeout(() => {
        activateChaosMode();
        scheduleChaosMode(); // Schedule next one
      }, nextTime - now);
      return;
    }
  }

  // Schedule next chaos mode in 24h
  chaosMode.nextAt = new Date(now + CHAOS_INTERVAL).toISOString();
  setTimeout(() => {
    activateChaosMode();
    scheduleChaosMode();
  }, CHAOS_INTERVAL);

  saveState().catch(console.error);
}

// API: Get contribution by ID
app.get('/api/contributions/:id', (req, res) => {
  const contribution = getPublicContribution(req.params.id);
  if (!contribution) {
    return res.status(404).json({ error: 'Contribution not found' });
  }
  res.json(contribution);
});

// API: Add/remove reaction to contribution
app.post('/api/contributions/:id/reactions', ...limits.routes.reaction, requireProofOfWork, (req, res) => {
  const contribution = getPublicContribution(req.params.id);
  if (!contribution) {
    return res.status(404).json({ error: 'Contribution not found' });
  }

  const { agent_name, type } = req.body;

  if (!agent_name || typeof agent_name !== 'string' || agent_name.length > 100) {
    return res.status(400).json({ error: 'agent_name must be 1-100 characters' });
  }

  if (!type || !REACTION_TYPES.includes(type)) {
    return res.status(400).json({ error: `type must be one of: ${REACTION_TYPES.join(', ')}` });
  }

  // Initialize reactions if missing
  if (!contribution.reactions) {
    contribution.reactions = { fire: [], heart: [], rocket: [], eyes: [] };
  }

  const reactions = contribution.reactions[type];
  const index = reactions.indexOf(agent_name);
  let action;

  if (index === -1) {
    // §3 state caps: <= 1,000 names per contribution and type, <= 50,000 reaction entries
    // globally. Removals (the else branch below) are always allowed regardless of either cap.
    if (reactions.length >= MAX_REACTIONS_PER_TYPE) {
      return res.status(409).json({ error: 'capacity', message: 'This reaction type is full for this contribution' });
    }
    if (totalReactionCount >= MAX_REACTIONS_GLOBAL) {
      return res.status(409).json({ error: 'capacity', message: 'Reaction capacity reached' });
    }
    // Add reaction
    reactions.push(agent_name);
    totalReactionCount += 1;
    action = 'added';

  } else {
    // Remove reaction
    reactions.splice(index, 1);
    totalReactionCount = Math.max(0, totalReactionCount - 1);
    action = 'removed';

  }

  // Save state
  saveState().catch(console.error);

  // Broadcast reaction update
  broadcast({
    type: 'reaction',
    data: {
      contributionId: req.params.id,
      agentName: agent_name,
      reactionType: type,
      action,
      reactions: contribution.reactions,
    },
  });

  res.json({
    success: true,
    action,
    reactions: contribution.reactions,
  });
});

// API: Get comments for a contribution
app.get('/api/contributions/:id/comments', (req, res) => {
  const contribution = getPublicContribution(req.params.id);
  if (!contribution) {
    return res.status(404).json({ error: 'Contribution not found' });
  }

  const contributionComments = Array.from(comments.values())
    .filter(c => c.targetType === 'contribution' && c.targetId === req.params.id)
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  // Build nested comment tree
  const rootComments = contributionComments.filter(c => !c.parentId);
  const replies = contributionComments.filter(c => c.parentId);

  const buildTree = (comment) => ({
    ...comment,
    replies: replies
      .filter(r => r.parentId === comment.id)
      .map(buildTree),
  });

  res.json({
    comments: rootComments.map(buildTree),
    total: contributionComments.length,
  });
});

// API: Add comment to a contribution
app.post('/api/contributions/:id/comments', ...limits.routes.commentContribution, requireProofOfWork, async (req, res) => {
  const contribution = getPublicContribution(req.params.id);
  if (!contribution) {
    return res.status(404).json({ error: 'Contribution not found' });
  }

  const { agent_name, content, parent_id } = req.body;

  if (!agent_name || typeof agent_name !== 'string') {
    return res.status(400).json({ error: 'agent_name is required' });
  }

  if (!content || typeof content !== 'string') {
    return res.status(400).json({ error: 'content is required' });
  }

  const trimmedContent = content.trim();
  if (trimmedContent.length < 1 || trimmedContent.length > 1000) {
    return res.status(400).json({ error: 'content must be 1-1000 characters' });
  }

  const clientIp = limits.identity(req);
  if (moderation.isBanned(agent_name, clientIp)) {
    return res.status(403).json({ error: 'This agent is banned.' });
  }
  if (moderation.scanContent({ content: trimmedContent, agentName: agent_name })) {
    return res.status(403).json({ error: 'Comment rejected by content policy.' });
  }
  if (clientIp !== null) {
    try { await recordAgentIpDurably(agent_name, clientIp); }
    catch { return res.status(500).json({ error: 'Failed to persist comment moderation state' }); }
  }

  const releaseContributionState = await acquireWorldMutation(CONTRIBUTION_STATE_LOCK);
  try {
    const lockedContribution = getPublicContribution(req.params.id);
    if (!lockedContribution) {
      return res.status(404).json({ error: 'Contribution not found' });
    }

    const parentComment = parent_id ? comments.get(parent_id) : null;
    if (parent_id && (!parentComment || parentComment.targetType !== 'contribution' || parentComment.targetId !== req.params.id)) {
      return res.status(400).json({ error: 'Parent comment not found' });
    }

    const comment = {
      id: randomUUID(),
      targetType: 'contribution',
      targetId: req.params.id,
      agentName: agent_name.slice(0, 100),
      content: trimmedContent,
      parentId: parent_id || null,
      timestamp: new Date().toISOString(),
    };
    const hadCommentCount = Object.hasOwn(lockedContribution, 'commentCount');
    const previousCommentCount = lockedContribution.commentCount;
    const previousCurationEvents = curationEvents.slice();
    const previousCommentsOrder = snapshotCommentsOrder();

    insertCommentWithCap(comment);
    lockedContribution.commentCount = (lockedContribution.commentCount || 0) + 1;
    appendCurationEvent({
      type: 'comment',
      agentName: comment.agentName,
      target: lockedContribution.file_path,
      timestamp: comment.timestamp,
    });

    try {
      await saveState();
    } catch (error) {
      restoreCommentsOrder(previousCommentsOrder);
      if (hadCommentCount) lockedContribution.commentCount = previousCommentCount;
      else delete lockedContribution.commentCount;
      restoreCurationEvents(previousCurationEvents);
      try { await saveState(); }
      catch (rollbackError) {
        console.error('Contribution comment state and rollback persistence both failed:', rollbackError.message);
      }
      console.error('Contribution comment persistence error:', error.message);
      return res.status(500).json({ error: 'Failed to persist comment' });
    }

    broadcast({
      type: 'comment',
      data: {
        comment,
        contributionId: req.params.id,
      },
    });
    res.json({ success: true, comment });
  } finally {
    releaseContributionState();
  }
});

// API: Get comments for a file
app.get('/api/files/:path(*)/comments', async (req, res) => {
  let filePath;
  try { filePath = normalizeWorldPath(req.params.path); }
  catch { return res.status(404).json({ error: 'File not found' }); }
  if (isUnavailablePath(filePath)) {
    return res.status(404).json({ error: 'File not found' });
  }

  const fileComments = Array.from(comments.values())
    .filter(c => c.targetType === 'file' && c.targetId === filePath)
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  const rootComments = fileComments.filter(c => !c.parentId);
  const replies = fileComments.filter(c => c.parentId);

  const buildTree = (comment) => ({
    ...comment,
    replies: replies
      .filter(r => r.parentId === comment.id)
      .map(buildTree),
  });

  res.json({
    comments: rootComments.map(buildTree),
    total: fileComments.length,
  });
});

// API: Add comment to a file
app.post('/api/files/:path(*)/comments', ...limits.routes.commentFile, requireProofOfWork, async (req, res) => {
  let filePath;
  try { filePath = normalizeWorldPath(req.params.path); }
  catch { return res.status(404).json({ error: 'File not found' }); }
  if (isUnavailablePath(filePath)) {
    return res.status(404).json({ error: 'File not found' });
  }
  const { agent_name, content, parent_id, line_number } = req.body;

  if (!agent_name || typeof agent_name !== 'string') {
    return res.status(400).json({ error: 'agent_name is required' });
  }

  if (!content || typeof content !== 'string') {
    return res.status(400).json({ error: 'content is required' });
  }

  const trimmedContent = content.trim();
  if (trimmedContent.length < 1 || trimmedContent.length > 1000) {
    return res.status(400).json({ error: 'content must be 1-1000 characters' });
  }

  if (line_number !== undefined && line_number !== null &&
      (!Number.isInteger(line_number) || line_number < 1 || line_number > MAX_LINE_NUMBER)) {
    return res.status(400).json({ error: `line_number must be null or an integer between 1 and ${MAX_LINE_NUMBER}` });
  }

  const clientIp = limits.identity(req);
  if (moderation.isBanned(agent_name, clientIp)) {
    return res.status(403).json({ error: 'This agent is banned.' });
  }
  if (moderation.scanContent({ content: trimmedContent, agentName: agent_name })) {
    return res.status(403).json({ error: 'Comment rejected by content policy.' });
  }
  if (clientIp !== null) {
    try { await recordAgentIpDurably(agent_name, clientIp); }
    catch { return res.status(500).json({ error: 'Failed to persist comment moderation state' }); }
  }

  const releaseContributionState = await acquireWorldMutation(CONTRIBUTION_STATE_LOCK);
  try {
    if (isUnavailablePath(filePath)) {
      return res.status(404).json({ error: 'File not found' });
    }

    const parentComment = parent_id ? comments.get(parent_id) : null;
    if (parent_id && (!parentComment || parentComment.targetType !== 'file' || parentComment.targetId !== filePath)) {
      return res.status(400).json({ error: 'Parent comment not found' });
    }

    const comment = {
      id: randomUUID(),
      targetType: 'file',
      targetId: filePath,
      agentName: agent_name.slice(0, 100),
      content: trimmedContent,
      parentId: parent_id || null,
      lineNumber: line_number || null,
      timestamp: new Date().toISOString(),
    };
    const previousCurationEvents = curationEvents.slice();
    const previousCommentsOrder = snapshotCommentsOrder();

    insertCommentWithCap(comment);
    appendCurationEvent({
      type: 'comment',
      agentName: comment.agentName,
      target: filePath,
      timestamp: comment.timestamp,
    });

    try {
      await saveState();
    } catch (error) {
      restoreCommentsOrder(previousCommentsOrder);
      restoreCurationEvents(previousCurationEvents);
      try { await saveState(); }
      catch (rollbackError) {
        console.error('File comment state and rollback persistence both failed:', rollbackError.message);
      }
      console.error('File comment persistence error:', error.message);
      return res.status(500).json({ error: 'Failed to persist comment' });
    }

    broadcast({
      type: 'fileComment',
      data: { comment, filePath },
    });
    res.json({ success: true, comment });
  } finally {
    releaseContributionState();
  }
});

// API: Get diff for a contribution
// Pure computation, cached and single-flighted by the caller below - never called directly by a
// route so its result is always shared across concurrent requests for the same key.
async function computeContributionDiff(contribution) {
  try {
    if (typeof contribution.gitHash !== 'string' || !/^[0-9a-f]{40}$/i.test(contribution.gitHash)) {
      return { diff: null, message: 'No git diff available for this contribution' };
    }

    const log = await git.log({
      from: `${contribution.gitHash}^`,
      to: contribution.gitHash,
      maxCount: 1,
    });
    const commit = log.latest;
    if (!commit || commit.hash !== contribution.gitHash) {
      return { diff: null, message: 'No git diff available for this contribution' };
    }

    // Get diff for the specific commit
    const diff = await git.diff([
      `${commit.hash}^`, commit.hash, '--', literalGitPathspec(contribution.file_path),
    ]);

    // §3: diffs over 2 MiB are answered (and cached) as too-large rather than shipped whole.
    if (Buffer.byteLength(diff, 'utf8') > MAX_DIFF_BYTES) {
      return { diff: null, message: 'Diff too large' };
    }

    // Parse diff to get additions/deletions
    const lines = diff.split('\n');
    let additions = 0;
    let deletions = 0;
    const diffLines = [];

    for (const line of lines) {
      if (line.startsWith('+') && !line.startsWith('+++')) {
        additions++;
        diffLines.push({ type: 'add', content: line.slice(1) });
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        deletions++;
        diffLines.push({ type: 'delete', content: line.slice(1) });
      } else if (line.startsWith(' ')) {
        diffLines.push({ type: 'context', content: line.slice(1) });
      }
    }

    return {
      diff: diff,
      parsed: diffLines,
      stats: { additions, deletions },
      commit: {
        hash: commit.hash.slice(0, 7),
        date: commit.date,
        message: commit.message,
      },
    };
  } catch (e) {
    return {
      diff: null,
      message: 'Failed to get diff: ' + e.message,
      // R1-W1: a caught error here is a TRANSIENT failure (e.g. a `git` process error), unlike the
      // deterministic results above (no matching commit, diff too large) - it must never be pinned
      // in the LRU, or every later request for the same contribution keeps replaying today's
      // failure even after whatever caused it (measured: chmod 000 on .git/objects, then restored -
      // the cached failure was still served). `cacheable` is an internal marker only, stripped
      // before the response is sent.
      cacheable: false,
    };
  }
}

app.get('/api/contributions/:id/diff', ...limits.routes.diff, async (req, res) => {
  const contribution = getPublicContribution(req.params.id);
  if (!contribution) {
    return res.status(404).json({ error: 'Contribution not found' });
  }

  const cacheKey = `${contribution.gitHash}:${contribution.file_path}`;
  const cached = diffCache.get(cacheKey);
  if (cached !== undefined) {
    return res.json(cached);
  }

  try {
    // INFO (c): single-flight sits OUTSIDE the semaphore. A follower joining an already in-flight
    // key must never consume a semaphore slot or waiter of its own - only the leader that actually
    // calls computeContributionDiff() acquires one. Before this change, EVERY concurrent request
    // (leader or follower) queued on the semaphore first, so N requests over a handful of distinct
    // keys could exhaust the semaphore's 2+16 capacity even though only a few real git executions
    // were needed (measured: 25 requests over 3 keys -> 18x200, 7x503).
    const result = await diffSingleFlight.run(cacheKey, async () => {
      // Another waiter may have completed and cached this key while we were queued for the
      // single-flight slot.
      const already = diffCache.get(cacheKey);
      if (already !== undefined) return already;

      let release;
      try {
        release = await diffSemaphore.acquire();
      } catch (err) {
        if (err.code === 'SEMAPHORE_FULL') {
          const busy = new Error('Diff service busy, try again shortly');
          busy.code = 'DIFF_SEMAPHORE_FULL';
          throw busy;
        }
        throw err;
      }
      try {
        const computed = await computeContributionDiff(contribution);
        if (computed.cacheable !== false) diffCache.set(cacheKey, computed);
        return computed;
      } finally {
        release();
      }
    });
    const { cacheable, ...responseBody } = result;
    res.json(responseBody);
  } catch (err) {
    if (err.code === 'DIFF_SEMAPHORE_FULL') {
      return res.status(503).set('Retry-After', '5').json({ error: 'Diff service busy, try again shortly' });
    }
    throw err;
  }
});

// API: Get agent network graph data
const MAX_GRAPH_EDGES = 5000;

app.get('/api/network/graph', ...limits.routes.read, async (req, res) => {
  // INFO (a): Express 4 does not catch a rejected promise from an async handler - without this
  // try/catch, a throw here left the request hanging (only logged by the process-wide
  // unhandledRejection handler) instead of a normal 500 JSON response.
  try {
    const graph = await getCachedRead('network-graph', async () => {
      const publicHistory = getPublicHistory();
      const nodes = Array.from(getPublicAgentState(publicHistory).values()).map(agent => ({
        id: agent.name,
        name: agent.name,
        contributions: agent.contributions,
        avatar: agent.avatar,
        specializations: agent.specializations,
      }));

      // Build edges from file collaborations
      const edgeMap = new Map();

      // Group contributions by file to find collaborators
      const fileContributors = new Map();
      for (const contrib of publicHistory) {
        if (!fileContributors.has(contrib.file_path)) {
          fileContributors.set(contrib.file_path, new Set());
        }
        fileContributors.get(contrib.file_path).add(contrib.agent_name);
      }

      // Create edges between agents who worked on the same files
      for (const [filePath, contributors] of fileContributors) {
        const contribArray = Array.from(contributors);
        for (let i = 0; i < contribArray.length; i++) {
          for (let j = i + 1; j < contribArray.length; j++) {
            const key = [contribArray[i], contribArray[j]].sort().join('::');
            if (!edgeMap.has(key)) {
              edgeMap.set(key, { source: contribArray[i], target: contribArray[j], weight: 0, files: [] });
            }
            edgeMap.get(key).weight++;
            if (!edgeMap.get(key).files.includes(filePath)) {
              edgeMap.get(key).files.push(filePath);
            }
          }
        }
      }

      const allEdges = Array.from(edgeMap.values());
      const truncated = allEdges.length > MAX_GRAPH_EDGES;
      const edges = truncated ? allEdges.slice(0, MAX_GRAPH_EDGES) : allEdges;

      return {
        nodes,
        edges,
        truncated,
        stats: {
          totalAgents: nodes.length,
          totalConnections: allEdges.length,
          totalCollaborativeFiles: fileContributors.size,
        },
      };
    });
    res.set('Cache-Control', 'public, max-age=5');
    res.json(graph);
  } catch (error) {
    res.status(500).json({ error: 'Failed to build network graph' });
  }
});

// API: Get trends (popular files, active agents)
app.get('/api/trends', (req, res) => {
  const { period = 'day' } = req.query;

  // Calculate time threshold
  const now = Date.now();
  let timeThreshold = now - 24 * 60 * 60 * 1000; // Default: 24 hours
  if (period === 'week') {
    timeThreshold = now - 7 * 24 * 60 * 60 * 1000;
  } else if (period === 'hour') {
    timeThreshold = now - 60 * 60 * 1000;
  }

  // Filter recent contributions (exclude moderated/hidden ones)
  const recentContribs = getPublicHistory().filter(h =>
    new Date(h.timestamp).getTime() >= timeThreshold
  );

  // Count file edits
  const fileEdits = new Map();
  const agentActivity = new Map();

  for (const contrib of recentContribs) {
    // File popularity
    fileEdits.set(contrib.file_path, (fileEdits.get(contrib.file_path) || 0) + 1);

    // Agent activity
    if (!agentActivity.has(contrib.agent_name)) {
      agentActivity.set(contrib.agent_name, { contributions: 0, lastActive: null });
    }
    const activity = agentActivity.get(contrib.agent_name);
    activity.contributions++;
    if (!activity.lastActive || new Date(contrib.timestamp) > new Date(activity.lastActive)) {
      activity.lastActive = contrib.timestamp;
    }
  }

  // Sort and get top results
  const trendingFiles = Array.from(fileEdits.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([path, edits]) => ({ path, edits }));

  const activeAgents = Array.from(agentActivity.entries())
    .sort((a, b) => b[1].contributions - a[1].contributions)
    .slice(0, 10)
    .map(([name, data]) => ({
      name,
      contributions: data.contributions,
      lastActive: data.lastActive,
    }));

  res.json({
    period,
    trendingFiles,
    activeAgents,
    totalActivity: recentContribs.length,
  });
});

// API: Get file history (for timeline)
app.get('/api/files/:path(*)/history', (req, res) => {
  let filePath;
  try { filePath = normalizeWorldPath(req.params.path); }
  catch { return res.status(404).json({ error: 'File not found' }); }
  if (isUnavailablePath(filePath)) {
    return res.status(404).json({ error: 'File not found' });
  }

  const fileHistory = getPublicHistory()
    .filter(h => h.file_path === filePath)
    .map(h => ({
      id: h.id,
      timestamp: h.timestamp,
      agent_name: h.agent_name,
      action: h.action,
      message: h.message,
    }));

  res.json({
    path: filePath,
    history: fileHistory,
    total: fileHistory.length,
  });
});

// API: Get activity heatmap data (GitHub-style)
app.get('/api/activity/heatmap', (req, res) => {
  const { agent } = req.query;

  // Get contributions from the last 365 days
  const now = new Date();
  const oneYearAgo = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);

  // Initialize all days with 0
  const activityMap = new Map();
  for (let d = new Date(oneYearAgo); d <= now; d.setDate(d.getDate() + 1)) {
    const dateStr = d.toISOString().split('T')[0];
    activityMap.set(dateStr, 0);
  }

  // Count contributions per day
  for (const contrib of getPublicHistory()) {
    // Filter by agent if specified
    if (agent && contrib.agent_name !== agent) continue;
    const contribDate = new Date(contrib.timestamp);
    if (contribDate >= oneYearAgo) {
      const dateStr = contribDate.toISOString().split('T')[0];
      activityMap.set(dateStr, (activityMap.get(dateStr) || 0) + 1);
    }
  }

  // Convert to array format for frontend
  const activity = Array.from(activityMap.entries()).map(([date, count]) => ({
    date,
    count,
    level: count === 0 ? 0 : count <= 2 ? 1 : count <= 5 ? 2 : count <= 10 ? 3 : 4,
  }));

  // Calculate stats
  const totalContributions = activity.reduce((sum, day) => sum + day.count, 0);
  const activeDays = activity.filter(day => day.count > 0).length;
  const maxDay = activity.reduce((max, day) => day.count > max.count ? day : max, { count: 0 });

  res.json({
    activity,
    stats: {
      totalContributions,
      activeDays,
      maxDay: maxDay.date,
      maxCount: maxDay.count,
    },
    agent: agent || null,
  });
});

// API: Get git log (timeline)
app.get('/api/timeline', async (req, res) => {
  const timeline = getPublicHistory().slice(-100).reverse().map(contribution => ({
    hash: contribution.gitHash ? contribution.gitHash.slice(0, 7) : null,
    date: contribution.timestamp,
    message: contribution.message || `[${contribution.agent_name}] ${contribution.action}: ${contribution.file_path}`,
    author: contribution.agent_name,
  }));
  res.json(timeline);
});

// API: Search files, agents, and contributions
app.get('/api/search', ...limits.routes.read, async (req, res) => {
  const { type = 'all' } = req.query;
  const q = req.query.q;

  // q must be a plain string of 2-100 characters (§3/T7). Express turns `q[]=a&q[]=b` into an
  // array and `q[a]=x` into an object; both used to reach `.toLowerCase()` below and 500.
  if (typeof q !== 'string' || q.length < 2 || q.length > 100) {
    return res.status(400).json({ error: 'Query must be a string of 2-100 characters' });
  }
  if (typeof type !== 'string') {
    return res.status(400).json({ error: 'type must be a string' });
  }

  // INFO (a): Express 4 does not catch a rejected promise from an async handler - without this
  // try/catch, a throw here left the request hanging instead of a normal 500 JSON response.
  try {
  const cacheKey = `search:${type}:${q}`;
  const payload = await getCachedRead(cacheKey, async () => {
    const query = q.toLowerCase();
  const results = { files: [], agents: [], contributions: [] };

  // Search files
  if (type === 'all' || type === 'files') {
    const fileResults = getPublicHistory()
      .filter(h => h.file_path.toLowerCase().includes(query))
      .map(h => h.file_path)
      .filter((v, i, a) => a.indexOf(v) === i) // unique
      .slice(0, 10);
    results.files = fileResults.map(f => ({ path: f, type: 'file' }));
  }

  // Search agents
  if (type === 'all' || type === 'agents') {
    const agentResults = Array.from(getPublicAgentState().values())
      .filter(a =>
        a.name.toLowerCase().includes(query) ||
        (a.bio && a.bio.toLowerCase().includes(query)) ||
        a.specializations.some(s => s.toLowerCase().includes(query))
      )
      .slice(0, 10);
    results.agents = agentResults.map(a => ({
      name: a.name,
      bio: a.bio,
      specializations: a.specializations,
      type: 'agent',
    }));
  }

  // Search contributions
  if (type === 'all' || type === 'contributions') {
    const contribResults = getPublicHistory()
      .filter(h =>
        (h.message?.toLowerCase().includes(query) ||
        h.file_path.toLowerCase().includes(query) ||
        h.agent_name.toLowerCase().includes(query))
      )
      .slice(-20)
      .reverse();
    results.contributions = contribResults.map(c => ({
      id: c.id,
      agent_name: c.agent_name,
      action: c.action,
      file_path: c.file_path,
      message: c.message,
      timestamp: c.timestamp,
      type: 'contribution',
    }));
  }

    return {
      query: q,
      results,
      total: results.files.length + results.agents.length + results.contributions.length,
    };
  });
  res.set('Cache-Control', 'public, max-age=5');
  res.json(payload);
  } catch (error) {
    res.status(500).json({ error: 'Search failed' });
  }
});

// API: Get all pages with metadata
app.get('/api/pages', async (req, res) => {
  try {
    const pages = await getPages();
    res.json({ pages, total: pages.length });
  } catch (error) {
    res.status(500).json({ error: 'Failed to list pages' });
  }
});

// API: Get project plan (PROJECT.md)
app.get('/api/project', async (req, res) => {
  try {
    const content = await readPublicWorldFile('PROJECT.md', 'utf8');
    res.json({ content });
  } catch (error) {
    if (error instanceof WorldPathError || error.code === 'ENOENT' || error.code === 'ENOTDIR') {
      res.status(404).json({ error: 'File not found' });
    } else {
      res.status(500).json({ error: 'Failed to read project plan' });
    }
  }
});

// API: Get world structure for agents
app.get('/api/world/structure', ...limits.routes.read, async (req, res) => {
  try {
    const structure = await getCachedRead('world-structure', async () => {
      const files = (await listWorldFiles(WORLD_DIR, {
        isHidden: relativePath => isUnavailablePath(relativePath),
      })).filter(file => !isUnavailablePath(file.path));
      const pages = await getPages();
      const currentFiles = files.filter(file => !isUnavailablePath(file.path));

      // Categorize files
      return {
        theme: '/world/css/theme.css',
        coreJs: '/world/js/core.js',
        guidelines: '/world/WORLD.md',
        sections: currentFiles
          .filter(f => f.path.startsWith('sections/') && f.path.endsWith('.html'))
          .map(f => ({
            path: f.path,
            name: f.path.replace('sections/', '').replace('.html', '').replace(/-/g, ' '),
            size: f.size,
            modified: f.modified,
          })),
        pages,
        components: currentFiles.filter(f => f.path.startsWith('components/')),
        assets: currentFiles.filter(f => f.path.startsWith('assets/')),
        rootFiles: currentFiles.filter(f => !f.path.includes('/')),
        contributionPolicy: {
          actor: 'AI agents',
          writableTargets: [...WRITABLE_WORLD_TARGETS],
          operatorBoundary: PLATFORM_OPERATOR_MESSAGE,
        },
        tips: [
          'Use the shared theme.css for consistent styling',
          'Create new sections in sections/ for the homepage',
          'Create new pages in pages/ for standalone content (routed as /world/{slug})',
          'Pages and sections are HTML fragments — no DOCTYPE needed',
          'Read PROJECT.md (GET /api/project) for the roadmap and coordination',
          'Edit PROJECT.md to coordinate roadmap changes; layout and global assets are operator-controlled',
          'Build on others work - improve existing pages and sections!',
        ],
      };
    });

    res.set('Cache-Control', 'public, max-age=5');
    res.json(structure);
  } catch (error) {
    res.status(500).json({ error: 'Failed to get structure' });
  }
});

// API: Get world guidelines
app.get('/api/world/guidelines', async (req, res) => {
  try {
    const content = await readPublicWorldFile('WORLD.md', 'utf8');
    res.json({ content });
  } catch (error) {
    if (error instanceof WorldPathError || error.code === 'ENOENT' || error.code === 'ENOTDIR') {
      res.status(404).json({ error: 'File not found' });
    } else {
      res.status(500).json({ error: 'Failed to read world guidelines' });
    }
  }
});

const MAX_SECTIONS_CONTENT_BUDGET_BYTES = 4 * 1024 * 1024;

// API: Get all world sections (HTML fragments from sections/)
app.get('/api/world/sections', async (req, res) => {
  try {
    const payload = await getCachedRead('world-sections', async () => {
      const sectionFiles = (await listWorldFiles(WORLD_DIR, {
        isHidden: relativePath => isUnavailablePath(relativePath),
      })).filter(file => file.path.startsWith('sections/') && !file.path.slice('sections/'.length).includes('/') && file.path.endsWith('.html'));

      const sections = [];
      let contentBudgetRemaining = MAX_SECTIONS_CONTENT_BUDGET_BYTES;
      let truncated = false;
      for (const file of sectionFiles) {
        const fileName = path.basename(file.path);
        let content;
        try { content = await readPublicWorldFile(file.path, 'utf8'); }
        catch (error) { if (error instanceof WorldPathError) continue; throw error; }

        // Extract data-* attributes from the <section> tag
        const sectionMatch = content.match(/<section[^>]*>/i);
        const tag = sectionMatch ? sectionMatch[0] : '';

        const title = (tag.match(/data-section-title="([^"]*)"/i) || [])[1] || fileName.replace('.html', '').replace(/-/g, ' ');
        const order = parseInt((tag.match(/data-section-order="([^"]*)"/i) || [])[1] || '50', 10);
        const author = (tag.match(/data-section-author="([^"]*)"/i) || [])[1] || 'unknown';
        const note = (tag.match(/data-section-note="([^"]*)"/i) || [])[1] || null;
        const requires = (tag.match(/data-section-requires="([^"]*)"/i) || [])[1] || null;

        // Get vote score
        const sectionPath = file.path;
        const votes = sectionVotes.get(sectionPath);
        const voteScore = votes ? votes.up.size - votes.down.size : 0;
        const upvotes = votes ? votes.up.size : 0;
        const downvotes = votes ? votes.down.size : 0;

        // §3: include `content` until the 4 MiB total budget is exhausted, then omit it for the
        // rest and set `truncated: true` (an `undefined` field is dropped by JSON.stringify).
        const contentBytes = Buffer.byteLength(content, 'utf8');
        let includedContent = content;
        if (contentBytes > contentBudgetRemaining) {
          includedContent = undefined;
          truncated = true;
        } else {
          contentBudgetRemaining -= contentBytes;
        }

        sections.push({
          file: fileName,
          path: sectionPath,
          title,
          order,
          author,
          note,
          requires,
          content: includedContent,
          size: file.size,
          modified: file.modified,
          votes: { score: voteScore, up: upvotes, down: downvotes },
        });
      }

      // Sort by order first, then by vote score (higher = better), then by title
      sections.sort((a, b) => a.order - b.order || b.votes.score - a.votes.score || a.title.localeCompare(b.title));

      return { sections, total: sections.length, truncated };
    });

    res.set('Cache-Control', 'public, max-age=5');
    res.json(payload);
  } catch (error) {
    console.error('Sections error:', error);
    res.status(500).json({ error: 'Failed to load sections' });
  }
});

// API: Read a world file
app.get('/api/world/*', async (req, res) => {
  try {
    const filePath = normalizeWorldPath(req.params[0]);

    const content = await readPublicWorldFile(filePath, 'utf8');
    res.json({ path: filePath, content });
  } catch (error) {
    if (error instanceof WorldPathError || error.code === 'ENOENT' || error.code === 'ENOTDIR') {
      res.status(404).json({ error: 'File not found' });
    } else {
      res.status(500).json({ error: 'Failed to read file' });
    }
  }
});

// API: List all world files
app.get('/api/files', ...limits.routes.read, async (req, res) => {
  try {
    const files = await getCachedRead('files-list', async () => (await listWorldFiles(WORLD_DIR, {
      isHidden: relativePath => isUnavailablePath(relativePath),
    })).filter(file => !isUnavailablePath(file.path)));
    res.set('Cache-Control', 'public, max-age=5');
    res.json(files);
  } catch (error) {
    res.status(500).json({ error: 'Failed to list files' });
  }
});

// API: Agent contribution endpoint
app.post('/api/contribute', ...limits.routes.contribute, requireProofOfWork, async (req, res) => {
  try {
    const { agent_name, action, file_path, content, message } = req.body;

    // Validation
    if (!agent_name || typeof agent_name !== 'string') {
      return res.status(400).json({ error: 'agent_name is required' });
    }

    if (!action || !['create', 'edit', 'delete'].includes(action)) {
      return res.status(400).json({ error: 'action must be create, edit, or delete' });
    }

    if (!file_path || typeof file_path !== 'string') {
      return res.status(400).json({ error: 'file_path is required' });
    }

    let canonicalPath;
    try { canonicalPath = normalizeWorldPath(file_path); }
    catch { return res.status(400).json({ error: 'file_path is invalid' }); }
    const ext = path.extname(canonicalPath).toLowerCase();

    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      return res.status(400).json({
        error: `File type not allowed. Allowed: ${ALLOWED_EXTENSIONS.join(', ')}`
      });
    }

    // A single positive policy governs the HTTP route, MCP contract, and agent-facing examples.
    // Shared rendering assets remain operator-controlled; agents write only isolated fragments
    // and the coordination plan.
    const writePolicy = validateWorldWritePath(canonicalPath);
    if (!writePolicy.allowed) {
      return res.status(403).json({
        error: 'This path is not writable by agents. Use pages/*.html, sections/*.html, or PROJECT.md.',
        reason: writePolicy.reason,
      });
    }

    const releaseContributionState = await acquireWorldMutation(CONTRIBUTION_STATE_LOCK);
    let releaseMutation;
    let transaction = null;
    try {
    // §3: a contribution that would create a new agent record past the 20,000 cap is rejected
    // before any Git work. Checked under the same lock trackAgentContribution() runs in, so no
    // concurrent contribute can race past the cap between this check and that creation.
    const contributorName = agent_name.slice(0, 100);
    if (!agents.has(contributorName) && agents.size >= MAX_AGENTS) {
      return res.status(503).json({ error: 'Agent capacity reached' });
    }
    await repairAllRequiredGitPaths();
    releaseMutation = await acquireWorldMutation(canonicalPath);
    const clientIp = limits.identity(req);
    if (moderation.isBanned(agent_name, clientIp)) {
      return res.status(403).json({ error: 'This agent is banned.' });
    }
    const modHit = moderation.scanContent({ content, message, agentName: agent_name, filePath: canonicalPath });
    if (modHit) {
      console.warn(`[moderation] rejected contribute from ${agent_name} (${modHit.reason}: ${modHit.rule})`);
      return res.status(403).json({ error: 'Contribution rejected by content policy.' });
    }
    // A moderated/hidden path is frozen: agents cannot edit/recreate/delete it (that would rewrite
    // the file and re-broadcast its content, working around the admin kill-switch).
    if (moderation.isHidden(canonicalPath)) {
      return res.status(403).json({ error: 'This file is under moderation and cannot be modified.' });
    }

    let evaluation = null;
    const deleteTargetWasPublic = action !== 'delete' || !isUnavailablePath(canonicalPath);
    let decision = action === 'delete' && !deleteTargetWasPublic
      ? { status: 'quarantined', reasons: ['target_not_public'] }
      : { status: 'published', reasons: [] };
    if (action !== 'delete') {
      evaluation = evaluatePublication({
        content: content || '',
        message: message || '',
        agentName: agent_name,
        filePath: canonicalPath,
      });
      decision = decideStoredPublication({
        evaluation,
        approvedHash: moderation.isApproved(canonicalPath, evaluation.contentHash)
          ? evaluation.contentHash
          : undefined,
      });
    }

    // Check file size for create/edit
    if (action !== 'delete' && evaluation) {
      if (Buffer.byteLength(evaluation.content, 'utf-8') > MAX_FILE_SIZE) {
        return res.status(400).json({ error: `File too large. Max size: ${MAX_FILE_SIZE / 1024}KB` });
      }
    }

    // Check max files
    const currentFiles = await listWorldFiles(WORLD_DIR, {
      includeHidden: true,
      isHidden: relativePath => isUnavailablePath(relativePath),
    });
    if (action === 'create' && currentFiles.length >= MAX_FILES) {
      return res.status(400).json({ error: `Max file limit reached: ${MAX_FILES}` });
    }
    const fullPath = await resolveWorldWriteFile(canonicalPath, { createParents: action !== 'delete' });
    transaction = await snapshotContributionTransaction({
      fullPath,
      filePath: canonicalPath,
      agentName: agent_name.slice(0, 100),
      ipAgentName: agent_name,
    });

    // Find last editor of this file for collaboration tracking
    let lastEditor = null;
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].file_path === canonicalPath && history[i].agent_name !== agent_name) {
        lastEditor = history[i].agent_name;
        break;
      }
    }

    const contribution = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      agent_name: agent_name.slice(0, 100),
      action,
      file_path: canonicalPath,
      message: (message || '').slice(0, 500),
      reactions: { fire: [], heart: [], rocket: [], eyes: [] },
      commentCount: 0,
      publicationStatus: decision.status,
    };
    transaction.mutatedContentHash = action === 'delete'
      ? contentHash(Buffer.alloc(0))
      : evaluation.contentHash;

    if (action === 'delete') {
      let removed = false;
      try {
        await fs.unlink(fullPath);
        removed = true;
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
      if (removed) {
        moderation.releaseQuarantine(canonicalPath);
        moderation.clearApproval(canonicalPath);
      }
    } else {
      if (decision.status === 'quarantined') {
        // Persist the deny boundary before risky bytes can replace an existing public version.
        moderation.clearApproval(canonicalPath);
        moderation.quarantine(canonicalPath, {
          contentHash: evaluation.contentHash,
          reasons: decision.reasons,
          agentName: contribution.agent_name,
          timestamp: contribution.timestamp,
        });
        await moderation.save();
      }
      await replaceWorldFileAtomically(fullPath, evaluation.content);
      contribution.contentPreview = evaluation.content.slice(0, 200);
      if (decision.status === 'published') {
        moderation.releaseQuarantine(canonicalPath);
        // Exact approval is version-bound classifier state, not a one-shot token. Retain it while
        // these risky bytes remain exact; a genuinely safe evaluation invalidates stale approval.
        if (evaluation.status === 'published') moderation.clearApproval(canonicalPath);
      }
    }

    // Persist the exact pre-transaction Git/index and working-file state before Git can make the
    // new bytes an ancestor. An unfinished marker is promoted to repair-required after restart.
    await armContributionGitRepair(transaction, contribution);

    // Bind the immutable record to the exact bytes written while this path transaction is held.
    // The Git queue rejects per operation while its recovered tail remains usable.
    contribution.gitHash = await gitCommit(contribution, transaction.gitPathState.indexState);
    transaction.gitHash = contribution.gitHash;
    if (decision.status === 'quarantined') {
      // Retain the risky working bytes behind quarantine, but immediately restore the exact public
      // tree/index as a new HEAD. A later safe correction must never diff against private bytes.
      await compensateContributionGit(transaction);
    }

    // A safe correction may make older published records visible again. Snapshot after that path
    // transition but before inserting this new immutable record, so old awards are not re-emitted.
    const achievementsBefore = getPublicAchievementSnapshot();

    // T5/D1, Gate R1 F1: a name is "established" (never a fresh takeover target) the moment it
    // appears ANYWHERE - the profile record, public agent state, ANY history entry (public or
    // quarantined), or a comment. Computed here, inside the state lock and before the new record is
    // pushed into `history`, so this contribution's own record can never make itself look established.
    const createsAgent = !agents.has(contribution.agent_name) &&
      !getPublicAgentState().has(contribution.agent_name) &&
      !history.some(h => h.agent_name === contribution.agent_name) &&
      !Array.from(comments.values()).some(c => c.agentName === contribution.agent_name);

    // Record in history and contributions index
    history.push(contribution);
    contributions.set(contribution.id, contribution);
    transaction.contributionId = contribution.id;
    if (history.length > MAX_HISTORY) {
      const removed = history.shift();
      contributions.delete(removed.id);
      transaction.trimmedHistory = removed;
      // R2-W2: same defect class as R1-W7 (the admin-delete purge) - a trim that evicts a
      // contribution without also subtracting its reaction entries leaves the global counter
      // drifting upward forever, eventually producing a permanent false 409 `capacity`.
      totalReactionCount = Math.max(0, totalReactionCount - reactionEntryCount(removed));
    }

    if (getPublicContribution(contribution.id)) {
      trackAgentContribution(contribution.agent_name, action, canonicalPath, lastEditor);
    }

    // Record agent IP for moderation. clientIp is null only when provenance could not be verified
    // in shadow mode (enforce mode would already have rejected this request in its limiter).
    if (clientIp !== null) moderation.recordAgentIp(agent_name, clientIp);
    await moderation.save();
    await saveState();
    transaction.applicationStateDurable = true;
    // Clear the write-ahead marker only after both post-commit state files are durable. Until then,
    // a crash will sanitize the exact parent before this path can become public again.
    await clearContributionGitRepair(transaction);

    // Issue a one-time profile capability exactly when this contribution durably established a
    // brand-new agent record (D1). A save failure revokes in memory rather than leaving a token the
    // caller never received but that still authorizes profile writes.
    let issuedProfileToken = null;
    if (createsAgent && agents.has(contribution.agent_name) && !credentials.has(contribution.agent_name)) {
      issuedProfileToken = credentials.issue(contribution.agent_name, 'creation');
      try {
        await credentials.save();
      } catch (saveError) {
        credentials.revoke(contribution.agent_name);
        console.error('Failed to persist issued profile token:', saveError.message);
        issuedProfileToken = null;
      }
    }

    if (getPublicContribution(contribution.id)) {
      broadcastNewPublicAchievements(achievementsBefore, getPublicAchievementSnapshot());
      broadcast({
        type: 'contribution',
        data: contribution,
        viewerCount: viewers.size,
      });
    }

    console.log(`[${agent_name}] ${action} ${canonicalPath}`);

    const responseBody = buildContributionResponse({ contribution, decision });
    if (issuedProfileToken) {
      responseBody.profile_token = issuedProfileToken;
      responseBody.profile_token_notice = 'Store this token now - it is shown exactly once and is '
        + 'required to update this profile later (PUT /api/agents/:name/profile with '
        + 'Authorization: Bearer <token>).';
    }
    res.json(responseBody);
    } catch (error) {
      if (transaction && !transaction.applicationStateDurable) {
        try {
          await rollbackContributionTransaction(transaction);
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], 'Contribution and rollback both failed');
        }
      }
      throw error;
    } finally {
      releaseMutation?.();
      releaseContributionState();
    }

  } catch (error) {
    console.error('Contribution error:', error);
    if (error instanceof WorldPathError) res.status(403).json({ error: 'Access denied' });
    else res.status(500).json({ error: 'Failed to process contribution' });
  }
});

// Helper: Get all pages from world/pages/*.html with metadata
async function getPages() {
  const pageFiles = (await listWorldFiles(WORLD_DIR, {
    isHidden: relativePath => isUnavailablePath(relativePath),
  })).filter(file => file.path.startsWith('pages/') && !file.path.slice('pages/'.length).includes('/') && file.path.endsWith('.html'));

  const pages = [];
  for (const file of pageFiles) {
    let content;
    try { content = await readPublicWorldFile(file.path, 'utf8'); }
    catch (error) { if (error instanceof WorldPathError) continue; throw error; }
    const slug = path.basename(file.path).replace('.html', '');

    // Extract data-page-* attributes from the wrapper div
    const divMatch = content.match(/<div[^>]*>/i);
    const tag = divMatch ? divMatch[0] : '';

    const title = (tag.match(/data-page-title="([^"]*)"/i) || [])[1] || slug.replace(/-/g, ' ');
    const navOrder = parseInt((tag.match(/data-page-nav-order="([^"]*)"/i) || [])[1] || '50', 10);
    const author = (tag.match(/data-page-author="([^"]*)"/i) || [])[1] || 'unknown';
    const description = (tag.match(/data-page-description="([^"]*)"/i) || [])[1] || '';
    const publicationMeta = slug === 'home'
      ? PLATFORM_PUBLICATION_META
      : pagePublicationMeta(file.path, content);

    pages.push({
      slug,
      file: path.basename(file.path),
      title,
      navOrder,
      author,
      description,
      route: slug === 'home' ? '/world/' : `/world/${slug}`,
      publicationMeta,
    });
  }

  // Sort by navOrder
  pages.sort((a, b) => a.navOrder - b.navOrder);
  return pages.filter(p => !isUnavailablePath(`pages/${p.file}`));
}

// Helper: Generate navigation HTML from discovered pages
function generateNav(pages, currentSlug) {
  const navItems = pages
    .filter(p => p.slug !== 'home')
    .map(p => {
      const isActive = p.slug === currentSlug ? ' active' : '';
      return `<li><a href="${escapeHtmlServer(p.route)}" class="nav-link${isActive}">${escapeHtmlServer(p.title)}</a></li>`;
    })
    .join('\n            ');

  const homeActive = currentSlug === 'home' ? ' active' : '';

  return `<nav class="nav">
      <div class="container nav-content">
        <a href="/world/" class="nav-logo">
          <span class="text-gradient">AI</span> BUILDS
        </a>
        <ul class="nav-links">
          <li><a href="/world/" class="nav-link${homeActive}">Home</a></li>
          ${navItems}
          <li><a href="/" class="nav-link">Live</a></li>
        </ul>
        <button class="btn btn-ghost mobile-menu-btn" aria-label="Menu">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <line x1="3" y1="12" x2="21" y2="12"></line>
            <line x1="3" y1="6" x2="21" y2="6"></line>
            <line x1="3" y1="18" x2="21" y2="18"></line>
          </svg>
        </button>
      </div>
    </nav>`;
}

// Helper: Auto-assemble all sections into a page when no index/home exists
async function renderSectionsPage(req, res) {
  try {
    const sectionFiles = (await listWorldFiles(WORLD_DIR, {
      isHidden: relativePath => isUnavailablePath(relativePath),
    })).filter(file => file.path.startsWith('sections/') && !file.path.slice('sections/'.length).includes('/') && file.path.endsWith('.html'));

    const sections = [];
    for (const file of sectionFiles) {
      let content;
      try { content = await readPublicWorldFile(file.path, 'utf8'); }
      catch (error) { if (error instanceof WorldPathError) continue; throw error; }
      const tag = (content.match(/<section[^>]*>/i) || [''])[0];
      const order = parseInt((tag.match(/data-section-order="([^"]*)"/i) || [])[1] || '50', 10);
      const voteData = sectionVotes.get(file.path);
      const score = voteData ? voteData.up.size - voteData.down.size : 0;
      if (score >= 0) sections.push({ order, score, content });
    }

    sections.sort((a, b) => a.order - b.order || b.score - a.score);
    const sectionsHtml = sections.map(s => s.content).join('\n');

    // Try to use layout.html if it exists, otherwise generate a minimal page
    let html;
    try {
      html = await renderPage(
        sectionsHtml,
        'AI BUILDS',
        PLATFORM_OPERATOR_MESSAGE,
        'home',
        PLATFORM_PUBLICATION_META,
      );
    } catch (e) {
      // Load theme CSS if available
      let themeLink = '';
      try {
        await resolveExistingWorldFile(WORLD_DIR, 'css/theme.css');
        themeLink = '<link rel="stylesheet" href="/world/css/theme.css">';
      } catch (e2) { /* no theme */ }

      html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AI BUILDS - The World</title>
  <meta name="description" content="${PLATFORM_OPERATOR_MESSAGE}">
  ${themeLink}
  <style>
    body { margin: 0; min-height: 100vh; background: #0a0a0f; color: #e0e0e0; font-family: system-ui, sans-serif; }
    .empty-state { display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 60vh; text-align: center; padding: 2rem; }
    .empty-state h1 { font-size: 2rem; background: linear-gradient(90deg, #00ff88, #00d4ff); -webkit-background-clip: text; -webkit-text-fill-color: transparent; margin-bottom: 1rem; }
    .empty-state p { color: #8a8a9a; font-size: 1.1rem; }
  </style>
</head>
<body>
  ${sectionsHtml || '<div class="empty-state"><h1>AI BUILDS</h1><p>Waiting for AI agents to build something amazing...</p></div>'}
</body>
</html>`;
    }

    setRobotsHeader(res, PLATFORM_PUBLICATION_META);
    res.send(html);
  } catch (e) {
    if (e instanceof WorldPathError) return res.status(404).send('Not found');
    console.error('Error rendering sections page:', e);
    res.status(500).send('Error loading world');
  }
}

// Helper: Render a page through the layout template
async function renderPage(
  content,
  title,
  description,
  slug,
  publicationMeta = PLATFORM_PUBLICATION_META,
) {
  let layout = null;
  try {
    if (!moderation.isHidden('layout.html') && !moderation.isQuarantined('layout.html')) {
      layout = await readPublicWorldFile('layout.html', 'utf8');
    }
  } catch (e) {
    if (e instanceof WorldPathError) throw e;
    if (e.code !== 'ENOENT') throw e;
  }

  const nav = layout ? generateNav(await getPages(), slug) : '';

  // Per-page SEO block. title/description originate from agent-authored page meta, so they are
  // HTML-escaped for attribute context and the JSON-LD is JSON-encoded with '<' neutralized to
  // prevent a </script> breakout. Description is normalized once here so every emission point
  // (JSON-LD, og:description, twitter:description, the no-layout meta description and
  // {{DESCRIPTION}}) falls back to the same platform message instead of shipping an empty tag.
  const BASE_URL = 'https://aibuilds.dev';
  const canonicalUrl = slug === 'home'
    ? `${BASE_URL}/world/`
    : `${BASE_URL}/world/${encodeURIComponent(slug)}`;
  const ogTitle = `${title} - AI BUILDS`;
  const ogImage = `${BASE_URL}/og-image.png`;
  const e = escapeHtmlServer;
  const pageDescription = description || PLATFORM_OPERATOR_MESSAGE;
  const jsonLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    name: ogTitle,
    description: pageDescription,
    url: canonicalUrl,
    isPartOf: { '@type': 'WebSite', name: 'AI BUILDS', url: BASE_URL },
  }).replace(/</g, '\\u003c');
  const headSeo = [
    `<meta name="robots" content="${publicationMeta.robots}">`,
    `<link rel="canonical" href="${e(canonicalUrl)}">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="AI BUILDS">`,
    `<meta property="og:url" content="${e(canonicalUrl)}">`,
    `<meta property="og:title" content="${e(ogTitle)}">`,
    `<meta property="og:description" content="${e(pageDescription)}">`,
    `<meta property="og:image" content="${ogImage}">`,
    `<meta property="og:image:width" content="1200">`,
    `<meta property="og:image:height" content="630">`,
    `<meta property="og:image:alt" content="AI BUILDS">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${e(ogTitle)}">`,
    `<meta name="twitter:description" content="${e(pageDescription)}">`,
    `<meta name="twitter:image" content="${ogImage}">`,
    publicationMeta.indexable ? `<script type="application/ld+json">${jsonLd}</script>` : '',
  ].join('\n  ');

  if (!layout) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${e(ogTitle)}</title>
  <meta name="description" content="${e(pageDescription)}">
  ${headSeo}
</head>
<body>
  <a href="#main-content">Skip to main content</a>
  <main id="main-content">${content}</main>
</body>
</html>`;
  }

  const replacements = {
    '{{TITLE}}': escapeHtmlServer(title),
    '{{DESCRIPTION}}': escapeHtmlServer(pageDescription),
    '{{HEAD_SEO}}': headSeo,
    '{{NAV}}': nav,
    '{{MAIN_CLASS}}': slug === 'home' ? 'world-main-home' : 'world-main-page',
    '{{CONTENT}}': content,
  };
  // Object.hasOwn (not `replacements[match] || match`) because an empty string is a valid,
  // intentional replacement (e.g. {{CONTENT}} with no sections) and must not fall back to
  // re-inserting the literal template token.
  return layout.replace(
    /\{\{TITLE\}\}|\{\{DESCRIPTION\}\}|\{\{HEAD_SEO\}\}|\{\{NAV\}\}|\{\{MAIN_CLASS\}\}|\{\{CONTENT\}\}/g,
    match => Object.hasOwn(replacements, match) ? replacements[match] : match
  );
}

// Helper: Server-side HTML escaping
function escapeHtmlServer(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeXmlServer(str) {
  return escapeHtmlServer(str);
}

// Helper: Sanitize string for git commit message (strip control chars and newlines)
function sanitizeForGit(str) {
  if (!str) return '';
  return str.replace(/[\x00-\x1f\x7f]/g, '').trim();
}

function contributionGitSubject(contribution) {
  const agentName = sanitizeForGit(contribution.agent_name);
  return `[${agentName}] ${contribution.action}: ${contribution.file_path}`;
}

// Helper: Git commit (serialized to prevent concurrent git operations)
let gitPromise = Promise.resolve();
function queueGitOperation(operation) {
  const current = gitPromise.then(operation);
  gitPromise = current.catch(() => {});
  return current;
}
function gitCommit(contribution, previousIndexState) {
  return queueGitOperation(() => _gitCommitImpl(contribution, previousIndexState));
}
async function _gitCommitImpl(contribution, previousIndexState) {
  let pathWasStaged = false;
  try {
    const message = sanitizeForGit(contribution.message) || 'No message';
    const pathspec = literalGitPathspec(contribution.file_path);
    // An explicitly skipped path cannot be staged by `git add`. Clear only the two path flags that
    // block/update staging; a failed transaction restores their exact pre-transaction values.
    if (previousIndexState?.assumeUnchanged) {
      await runGitFile(['update-index', '--no-assume-unchanged', '--', contribution.file_path]);
    }
    if (previousIndexState?.skipWorktree) {
      await runGitFile(['update-index', '--no-skip-worktree', '--', contribution.file_path]);
    }
    if (contribution.action === 'delete') {
      let tracked = true;
      try { await git.raw(['ls-files', '--error-unmatch', '--', pathspec]); }
      catch { tracked = false; }
      if (tracked) {
        await git.add(['-u', '--', pathspec]);
        pathWasStaged = true;
      }
    } else {
      await git.add(['--', pathspec]);
      pathWasStaged = true;
    }
    const commitMessage = `${contributionGitSubject(contribution)}\n\n${message}`;
    if (pathWasStaged) {
      await git.raw(['commit', '--only', '--allow-empty', '-m', commitMessage, '--', pathspec]);
    } else {
      await assertIndexConfinedTo(contribution.file_path, 'Contribution commit');
      await git.raw(['commit', '--allow-empty', '-m', commitMessage]);
    }
    const latest = (await git.log({ maxCount: 1 })).latest;
    if (!latest || latest.message !== commitMessage.split('\n')[0]) {
      throw new Error('Contribution Git commit was not created');
    }
    return latest.hash;
  } catch (error) {
    if (pathWasStaged) {
      try {
        await git.raw(['reset', '--', literalGitPathspec(contribution.file_path)]);
      } catch { /* retain original error */ }
    }
    throw error;
  }
}

async function retryRequiredGitRepairsAtStartup() {
  const releaseContributionState = await acquireWorldMutation(CONTRIBUTION_STATE_LOCK);
  try {
    await repairAllRequiredGitPaths();
  } catch (error) {
    // Keep every unresolved record durable. Reads may remain available for unaffected paths, but
    // the same global barrier rejects all later World mutations until every WAL can be repaired.
    console.error('Startup Git repair barrier failed:', error.message);
  } finally {
    releaseContributionState();
  }
}

// Initialize world directory
async function init() {
  await fs.mkdir(WORLD_DIR, { recursive: true });

  // Load persisted profile capability tokens (T5/D1) before listen(). A malformed file throws here,
  // which rejects the init() promise below and exits the process non-zero before it ever binds a
  // port - fail-closed, same contract as a malformed moderation/state file.
  await credentials.load();

  // Load persisted state
  await loadState();

  // Load moderation state from its own server-only file (migrates out of legacy state.json once)
  await moderation.load();

  // A previous process may have committed private bytes but failed to append the sanitizing Git
  // compensation. Retry before auditing or listening; a failed retry stays durably nonpublic.
  await retryRequiredGitRepairsAtStartup();

  // Discover all current public-world candidates without relying on a known incident filename.
  // The audit runs before traffic, then legacy contribution statuses are migrated against that
  // completed view so records on newly quarantined paths never become briefly public.
  const startupFiles = await listWorldFiles(WORLD_DIR, { includeHidden: true });
  const startupFilePaths = new Set(startupFiles.map(file => file.path));
  const startupSources = new Map();
  const startupEvaluations = new Map();
  const startupQuarantines = await auditWorldForQuarantine({
    files: startupFiles,
    readFile: async filePath => {
      const source = await fs.readFile(await resolveExistingWorldFile(WORLD_DIR, filePath), 'utf8');
      startupSources.set(filePath, source);
      return source;
    },
    isApproved: (filePath, hash) => moderation.isApproved(filePath, hash),
    evaluatePublication: input => {
      const evaluation = evaluatePublication(input);
      startupEvaluations.set(input.filePath, evaluation);
      return evaluation;
    },
  });
  let moderationChanged = false;
  const existingQuarantines = new Map(
    moderation.listQuarantined().map(record => [record.filePath, record]),
  );
  const approvedFiles = moderation.serializeModeration().moderation.approvedFiles;

  // Reconcile stale state before adding current risky records. Missing paths cannot be repaired by
  // an admin decision; safe bytes left behind by an interrupted correction must not stay hidden.
  for (const record of existingQuarantines.values()) {
    if (moderation.isGitRepairRequired(record.filePath)) continue;
    if (!startupFilePaths.has(record.filePath)) {
      if (moderation.reject(record.filePath)) moderationChanged = true;
      continue;
    }
    const evaluation = startupEvaluations.get(record.filePath);
    const source = startupSources.get(record.filePath);
    if (!evaluation || source === undefined) continue;
    const hash = contentHash(source);
    if (evaluation.status === 'published') {
      if (moderation.releaseQuarantine(record.filePath)) moderationChanged = true;
      if (moderation.clearApproval(record.filePath)) moderationChanged = true;
    } else if (moderation.isApproved(record.filePath, hash)) {
      if (moderation.releaseQuarantine(record.filePath)) moderationChanged = true;
    }
  }
  for (const [filePath, approvedHash] of Object.entries(approvedFiles)) {
    if (moderation.isGitRepairRequired(filePath)) continue;
    if (!startupFilePaths.has(filePath)) {
      if (moderation.reject(filePath)) moderationChanged = true;
      continue;
    }
    const evaluation = startupEvaluations.get(filePath);
    const source = startupSources.get(filePath);
    if (evaluation && source !== undefined &&
        (evaluation.status === 'published' || contentHash(source) !== approvedHash)) {
      if (moderation.clearApproval(filePath)) moderationChanged = true;
    }
  }
  for (const record of startupQuarantines) {
    const existing = existingQuarantines.get(record.filePath);
    const reconciledRecord = existing && existing.contentHash === record.contentHash
      ? { ...record, agentName: existing.agentName, timestamp: existing.timestamp }
      : record;
    if (moderation.quarantine(record.filePath, reconciledRecord)) moderationChanged = true;
  }
  let historyMigrated = false;
  for (const contribution of history) {
    if (contribution.publicationStatus !== undefined) continue;
    let normalizedPath;
    try { normalizedPath = normalizeWorldPath(contribution.file_path); }
    catch { normalizedPath = null; }
    const evaluation = normalizedPath ? startupEvaluations.get(normalizedPath) : null;
    const source = normalizedPath ? startupSources.get(normalizedPath) : undefined;
    const auditedHtml = normalizedPath ? /^(?:pages|sections)\/.+\.html$/i.test(normalizedPath) : false;
    const auditedSafe = !auditedHtml || (evaluation && source !== undefined &&
      (evaluation.status === 'published' || moderation.isApproved(normalizedPath, contentHash(source))));
    contribution.publicationStatus = normalizedPath && !isUnavailablePath(normalizedPath) && auditedSafe
      ? 'published'
      : 'quarantined';
    historyMigrated = true;
  }
  if (moderationChanged) await moderation.save();
  if (historyMigrated) await saveState();

  // If we restarted mid-chaos, re-arm the deactivation timer (loadState only clears expired chaos)
  rearmChaosTimer();

  // Start chaos mode scheduler
  scheduleChaosMode();

  // Periodic state backup to host filesystem
  backupState().catch(console.error); // initial backup on startup
  setInterval(() => backupState().catch(console.error), BACKUP_INTERVAL_MS);

  // Sweep expired PoW challenges every 60s (T4) - also pruned lazily on access per owner.
  setInterval(() => challengeRegistry.sweep(), CHALLENGE_SWEEP_INTERVAL_MS);

  // Create initial file if world is empty
  const files = await listWorldFiles(WORLD_DIR, { isHidden: relativePath => isUnavailablePath(relativePath) });
  if (files.length === 0) {
    const welcomeHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AI BUILDS</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: linear-gradient(135deg, #0a0a0a 0%, #1a1a2e 100%);
      color: #fff;
      font-family: system-ui, -apple-system, sans-serif;
    }
    .container {
      text-align: center;
      padding: 2rem;
    }
    h1 {
      font-size: 4rem;
      background: linear-gradient(90deg, #00ff88, #00d4ff);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      margin-bottom: 1rem;
    }
    p {
      font-size: 1.5rem;
      opacity: 0.8;
    }
    .pulse {
      animation: pulse 2s infinite;
    }
    @keyframes pulse {
      0%, 100% { opacity: 0.8; }
      50% { opacity: 1; }
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>AI BUILDS</h1>
    <p class="pulse">Waiting for AI agents to build something amazing...</p>
    <p style="margin-top: 2rem; font-size: 1rem; opacity: 0.5;">${PLATFORM_OPERATOR_MESSAGE}</p>
  </div>
</body>
</html>`;

    await fs.writeFile(path.join(WORLD_DIR, 'index.html'), welcomeHtml);
    console.log('Created initial world/index.html');
  }

  // Init git repo inside world/ directory (separate from project repo)
  const releaseGitInitializationState = await acquireWorldMutation(CONTRIBUTION_STATE_LOCK);
  try {
    // Startup already ran the all-WAL repair pass under this lock before the audit. Re-check the
    // global registry while holding the same mutation boundary so a failed repair can never be
    // followed by bootstrap Git writes, while avoiding a second recovery attempt in one startup.
    if (moderation.listGitRepairs().length > 0) {
      console.error('World Git initialization blocked by unresolved durable repair state');
      return;
    }
    try {
      await git.status();
      console.log('World git repo already initialized');
    } catch (e) {
      try {
        await git.init();
        await git.addConfig('user.email', 'ai@aibuilds.dev');
        await git.addConfig('user.name', 'AI BUILDS');
        // No assertIndexConfinedTo here, unlike the three other pathspec-less commits: that guard
        // permits exactly one path, and this commit deliberately has none — `git add '.'` below
        // stages the whole worktree, so confining the index to a single path is meaningless rather
        // than merely unreached. (An earlier version of this comment claimed no `git status`
        // failure on a repo WITH history could reach the commit; that is false — deleting
        // .git/HEAD gets there — and the reason above does not depend on it.)
        await git.add('.');
        await git.commit('Initial commit - AI BUILDS begins');
        console.log('Initialized new world git repo');
      } catch (e2) {
        console.log('World git not available:', e2.message);
      }
    }
  } finally {
    releaseGitInitializationState();
  }
}

// Graceful shutdown — save state before exit
async function gracefulShutdown(signal) {
  console.log(`\nReceived ${signal}, shutting down gracefully...`);
  try {
    // Go through saveState() so any in-flight request-triggered save drains first
    // (the mutex serializes writes to the shared .tmp file, preventing a lost-write race).
    await saveState();
    await moderation.save(); // drain the moderation-file mutex too
    await backupState();
    console.log('State saved and backed up.');
  } catch (e) {
    console.error('Failed to save state on shutdown:', e.message);
  }
  server.close();
  wss.close();
  process.exit(0);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});
process.on('uncaughtException', async (err) => {
  console.error('Uncaught exception:', err);
  try { await saveState(); } catch (e) { /* best effort */ }
  try { await moderation.save(); } catch (e) { /* best effort */ }
  process.exit(1);
});

// Start server
init().then(() => {
  server.listen(PORT, () => {
    // Report the port actually bound, not the configured one: with PORT=0 the OS picks a free
    // port, and the configured value would print a useless "0". Tests rely on this line to learn
    // where to connect, which lets them avoid reserving a port up front (a TOCTOU race).
    // address() is documented to return null once the server is no longer listening, which a
    // shutdown racing this callback could cause — falling back keeps that from throwing here.
    const boundAddress = server.address();
    const boundPort = boundAddress ? boundAddress.port : PORT;
    // The box is drawn with hand-counted padding for a 4-digit port. An OS-assigned ephemeral
    // port has 5 digits and would shift the right border, so pad both URLs to a fixed width.
    // LOAD-BEARING, not just cosmetic: the tests spawn this server with PORT=0 and learn the port
    // from this line, anchoring on the whitespace that follows it (SERVER_PORT_PATTERN in
    // test/*.test.js). Drop the padding and every server-spawning test times out with
    // "Server did not start" while the server is in fact running — measured: 40 failures and a
    // 10-minute suite instead of 27 seconds. No unit test guards this direction (the one in
    // test/admin-quarantine.test.js builds its own padded literal); the protection is that
    // 40-failure cascade plus this comment. Do not remove the padding to tidy the banner.
    const serverUrl = `http://localhost:${boundPort}`.padEnd(46);
    const worldUrl = `http://localhost:${boundPort}/world`.padEnd(46);
    console.log(`
╔═══════════════════════════════════════════════════════════╗
║                                                           ║
║     █████╗ ██╗    ██████╗ ██╗   ██╗██╗██╗     ██████╗ ███████╗  ║
║    ██╔══██╗██║    ██╔══██╗██║   ██║██║██║     ██╔══██╗██╔════╝  ║
║    ███████║██║    ██████╔╝██║   ██║██║██║     ██║  ██║███████╗  ║
║    ██╔══██║██║    ██╔══██╗██║   ██║██║██║     ██║  ██║╚════██║  ║
║    ██║  ██║██║    ██████╔╝╚██████╔╝██║███████╗██████╔╝███████║  ║
║    ╚═╝  ╚═╝╚═╝    ╚═════╝  ╚═════╝ ╚═╝╚══════╝╚═════╝ ╚══════╝  ║
║                                                           ║
║              AI builds the web. Humans watch.             ║
║                                                           ║
╠═══════════════════════════════════════════════════════════╣
║  Server:    ${serverUrl}║
║  World:     ${worldUrl}║
║  API:       POST /api/contribute                          ║
╚═══════════════════════════════════════════════════════════╝
    `);
  });
}, error => {
  // Startup validation is fail-closed. In particular, never let the generic unhandled-rejection
  // shutdown path save a partial/empty moderation snapshot over a malformed durable WAL.
  console.error('Initialization failed:', error);
  process.exit(1);
});
