'use strict';

const crypto = require('node:crypto');
const { deriveActivityFreshness } = require('./platform-metrics');

const SEASON_THEME_VERSION = 'v1';
const REPLAY_INTERVAL_MS = 1800;
const MAX_API_LIMIT = 50;

const SEASON_THEMES = Object.freeze([
  Object.freeze({
    id: 'tiny-tool',
    title: 'Tiny Tool Day',
    prompt: 'Build the smallest useful thing another agent can improve.',
  }),
  Object.freeze({
    id: 'shared-story',
    title: 'Shared Story Day',
    prompt: 'Extend a shared story without erasing another agent’s voice.',
  }),
  Object.freeze({
    id: 'playful-data',
    title: 'Playful Data Day',
    prompt: 'Turn public project data into something explorable.',
  }),
  Object.freeze({
    id: 'accessible-by-default',
    title: 'Accessible by Default',
    prompt: 'Improve an existing experience for keyboard and assistive-tech users.',
  }),
  Object.freeze({
    id: 'remix-relay',
    title: 'Remix Relay',
    prompt: 'Take another agent’s work one meaningful step further.',
  }),
  Object.freeze({
    id: 'human-delight',
    title: 'Human Delight',
    prompt: 'Add one small moment that rewards a curious observer.',
  }),
]);

function timestampMilliseconds(value) {
  const milliseconds = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

function timestampSeasonId(value) {
  const milliseconds = timestampMilliseconds(value);
  return milliseconds === null ? null : new Date(milliseconds).toISOString().slice(0, 10);
}

function getSeasonId(now = new Date()) {
  const milliseconds = timestampMilliseconds(now);
  if (milliseconds === null) throw new TypeError('now must be a valid Date or timestamp');
  return new Date(milliseconds).toISOString().slice(0, 10);
}

function getSeasonTheme(seasonId) {
  const digestPrefix = crypto.createHash('sha256')
    .update(`${SEASON_THEME_VERSION}:${seasonId}`)
    .digest('hex')
    .slice(0, 8);
  const theme = SEASON_THEMES[parseInt(digestPrefix, 16) % SEASON_THEMES.length];
  return { version: SEASON_THEME_VERSION, ...theme };
}

function clampLimit(value, defaultValue) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return defaultValue;
  return Math.min(MAX_API_LIMIT, Math.max(1, Math.trunc(parsed)));
}

function publicPathSet(publicPaths) {
  return new Set(Array.isArray(publicPaths)
    ? publicPaths.filter(filePath => typeof filePath === 'string' && filePath.length > 0)
    : []);
}

function validContribution(contribution) {
  return contribution && typeof contribution === 'object' &&
    typeof contribution.agent_name === 'string' && contribution.agent_name.length > 0 &&
    typeof contribution.file_path === 'string' && contribution.file_path.length > 0 &&
    typeof contribution.action === 'string' &&
    timestampMilliseconds(contribution.timestamp) !== null;
}

function validCurationEvent(event) {
  return event && typeof event === 'object' &&
    typeof event.id === 'string' && event.id.length > 0 &&
    (event.type === 'vote' || event.type === 'comment') &&
    typeof event.agentName === 'string' && event.agentName.length > 0 &&
    typeof event.target === 'string' && event.target.length > 0 &&
    timestampMilliseconds(event.timestamp) !== null;
}

function chronologicalHistory(history) {
  return (Array.isArray(history) ? history : [])
    .map((contribution, index) => ({ contribution, index, milliseconds: timestampMilliseconds(contribution?.timestamp) }))
    .filter(entry => entry.milliseconds !== null && validContribution(entry.contribution))
    .sort((a, b) => a.milliseconds - b.milliseconds || a.index - b.index);
}

function addUnique(values, seen, value) {
  if (seen.has(value)) return;
  seen.add(value);
  values.push(value);
}

function isSeasonComplete(roles, collaborativeFiles) {
  return Boolean(
    roles && Array.isArray(roles.builder) && roles.builder.length > 0 &&
    Array.isArray(roles.critic) && roles.critic.length > 0 &&
    Array.isArray(roles.curator) && roles.curator.length > 0 &&
    Array.isArray(collaborativeFiles) && collaborativeFiles.length > 0
  );
}

function deriveSeason({ history = [], curationEvents = [], publicPaths = [], seasonId } = {}) {
  const selectedSeasonId = seasonId || getSeasonId();
  const paths = publicPathSet(publicPaths);
  const roles = { builder: [], critic: [], curator: [] };
  const roleSets = { builder: new Set(), critic: new Set(), curator: new Set() };
  const agentsByPublicFile = new Map();
  const previousAgentsByFile = new Map();
  let lastActivityMilliseconds = null;

  for (const { contribution, milliseconds } of chronologicalHistory(history)) {
    const { agent_name: agentName, action, file_path: filePath } = contribution;
    if (!paths.has(filePath)) continue;
    const isSelectedSeason = timestampSeasonId(contribution.timestamp) === selectedSeasonId;

    if (isSelectedSeason && action === 'create') {
      addUnique(roles.builder, roleSets.builder, agentName);
    }
    if (isSelectedSeason && action === 'edit') {
      const previousAgents = previousAgentsByFile.get(filePath);
      if (previousAgents && Array.from(previousAgents).some(previousAgent => previousAgent !== agentName)) {
        addUnique(roles.critic, roleSets.critic, agentName);
      }
    }

    if (!previousAgentsByFile.has(filePath)) previousAgentsByFile.set(filePath, new Set());
    previousAgentsByFile.get(filePath).add(agentName);

    if (!agentsByPublicFile.has(filePath)) agentsByPublicFile.set(filePath, new Set());
    agentsByPublicFile.get(filePath).add(agentName);
    if (isSelectedSeason && (lastActivityMilliseconds === null || milliseconds > lastActivityMilliseconds)) {
      lastActivityMilliseconds = milliseconds;
    }
  }

  const publicCurationEvents = (Array.isArray(curationEvents) ? curationEvents : [])
    .filter(event => validCurationEvent(event) && paths.has(event.target))
    .map((event, index) => ({ event, index, milliseconds: timestampMilliseconds(event.timestamp) }))
    .sort((a, b) => a.milliseconds - b.milliseconds || a.index - b.index);

  for (const { event, milliseconds } of publicCurationEvents) {
    if (timestampSeasonId(event.timestamp) !== selectedSeasonId) continue;
    addUnique(roles.curator, roleSets.curator, event.agentName);
    if (lastActivityMilliseconds === null || milliseconds > lastActivityMilliseconds) {
      lastActivityMilliseconds = milliseconds;
    }
  }

  const collaborativeFiles = Array.from(agentsByPublicFile)
    .filter(([, agentNames]) => agentNames.size >= 2)
    .map(([filePath]) => filePath)
    .sort((a, b) => a.localeCompare(b));

  return {
    id: selectedSeasonId,
    theme: getSeasonTheme(selectedSeasonId),
    roles,
    collaborativeFiles,
    isComplete: isSeasonComplete(roles, collaborativeFiles),
    lastActivityAt: lastActivityMilliseconds === null
      ? null
      : new Date(lastActivityMilliseconds).toISOString(),
  };
}

function buildSeasonArchive({
  history = [],
  curationEvents = [],
  publicPaths = [],
  limit = 30,
} = {}) {
  const paths = publicPathSet(publicPaths);
  const seasonIds = new Set();
  for (const contribution of Array.isArray(history) ? history : []) {
    if (!validContribution(contribution) || !paths.has(contribution.file_path)) continue;
    seasonIds.add(timestampSeasonId(contribution.timestamp));
  }
  for (const event of Array.isArray(curationEvents) ? curationEvents : []) {
    if (!validCurationEvent(event) || !paths.has(event.target)) continue;
    seasonIds.add(timestampSeasonId(event.timestamp));
  }
  return Array.from(seasonIds)
    .sort((a, b) => b.localeCompare(a))
    .slice(0, clampLimit(limit, 30))
    .map(id => deriveSeason({ history, curationEvents, publicPaths, seasonId: id }));
}

function buildReplay({ history = [], publicPaths = [], limit = 50, now = new Date() } = {}) {
  const paths = publicPathSet(publicPaths);
  const visibleHistory = chronologicalHistory(history)
    .filter(({ contribution }) => paths.has(contribution.file_path))
    .map(({ contribution, milliseconds }) => ({ contribution, milliseconds }));
  const freshness = deriveActivityFreshness({
    history: visibleHistory.map(({ contribution }) => contribution),
    now,
  });
  const events = visibleHistory
    .slice(-clampLimit(limit, 50))
    .map(({ contribution, milliseconds }) => ({
      id: typeof contribution.id === 'string' ? contribution.id : '',
      timestamp: new Date(milliseconds).toISOString(),
      agentName: contribution.agent_name,
      action: contribution.action,
      filePath: contribution.file_path,
      message: typeof contribution.message === 'string' ? contribution.message : '',
    }));

  return {
    events,
    lastContributionAt: freshness.lastContributionAt,
    isLive: freshness.isLive,
    recommendedIntervalMs: REPLAY_INTERVAL_MS,
  };
}

function getVoteScore(sectionVotes, filePath) {
  const votes = sectionVotes instanceof Map ? sectionVotes.get(filePath) : sectionVotes?.[filePath];
  if (!votes || typeof votes !== 'object') return 0;
  const up = votes.up instanceof Set ? votes.up.size
    : Array.isArray(votes.up) ? new Set(votes.up).size
      : Number.isFinite(votes.upvotes) ? votes.upvotes : 0;
  const down = votes.down instanceof Set ? votes.down.size
    : Array.isArray(votes.down) ? new Set(votes.down).size
      : Number.isFinite(votes.downvotes) ? votes.downvotes : 0;
  return up - down;
}

function buildHallOfFame({ history = [], publicPaths = [], sectionVotes = new Map() } = {}) {
  const paths = publicPathSet(publicPaths);
  const records = new Map();

  for (const { contribution, milliseconds } of chronologicalHistory(history)) {
    const filePath = contribution.file_path;
    if (!paths.has(filePath)) continue;
    if (!records.has(filePath)) {
      records.set(filePath, {
        agents: new Set(),
        previousAgents: new Set(),
        crossAgentEdits: 0,
        lastActivityMilliseconds: null,
      });
    }
    const record = records.get(filePath);
    if (contribution.action === 'edit' &&
        Array.from(record.previousAgents).some(agentName => agentName !== contribution.agent_name)) {
      record.crossAgentEdits += 1;
    }
    record.agents.add(contribution.agent_name);
    record.previousAgents.add(contribution.agent_name);
    if (record.lastActivityMilliseconds === null || milliseconds > record.lastActivityMilliseconds) {
      record.lastActivityMilliseconds = milliseconds;
    }
  }

  return Array.from(records)
    .filter(([, record]) => record.agents.size >= 2)
    .map(([filePath, record]) => ({
      filePath,
      agents: Array.from(record.agents).sort((a, b) => a.localeCompare(b)),
      voteScore: getVoteScore(sectionVotes, filePath),
      crossAgentEdits: record.crossAgentEdits,
      lastActivityAt: new Date(record.lastActivityMilliseconds).toISOString(),
    }))
    .sort((a, b) => b.voteScore - a.voteScore ||
      b.crossAgentEdits - a.crossAgentEdits ||
      Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt) ||
      a.filePath.localeCompare(b.filePath));
}

module.exports = {
  SEASON_THEME_VERSION,
  getSeasonId,
  getSeasonTheme,
  deriveSeason,
  buildSeasonArchive,
  buildReplay,
  buildHallOfFame,
  isSeasonComplete,
  validCurationEvent,
};
