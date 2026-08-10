'use strict';

const LIVE_MAX_AGE_MS = 15 * 60 * 1000;

function timestampValue(value) {
  const milliseconds = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

function timestampString(value, milliseconds) {
  return typeof value === 'string' ? value : new Date(milliseconds).toISOString();
}

function deriveActivityFreshness({ history = [], now = new Date() } = {}) {
  const nowMilliseconds = now instanceof Date ? now.getTime() : Number(now);
  let latestMilliseconds = null;
  let lastContributionAt = null;

  for (const contribution of history) {
    const milliseconds = timestampValue(contribution && contribution.timestamp);
    if (milliseconds === null || (latestMilliseconds !== null && milliseconds <= latestMilliseconds)) continue;
    latestMilliseconds = milliseconds;
    lastContributionAt = timestampString(contribution.timestamp, milliseconds);
  }

  if (latestMilliseconds === null || !Number.isFinite(nowMilliseconds)) {
    return { lastContributionAt: null, isLive: false };
  }
  const age = nowMilliseconds - latestMilliseconds;
  return {
    lastContributionAt,
    isLive: age >= 0 && age <= LIVE_MAX_AGE_MS,
  };
}

function computePlatformMetrics({
  history = [],
  files = [],
  now = new Date(),
  quarantinedFileCount = 0,
} = {}) {
  const agentNames = new Set();
  const activeDates = new Set();
  const agentsByFile = new Map();
  let latestMilliseconds = null;
  let lastContributionAt = null;

  for (const contribution of history) {
    if (!contribution || typeof contribution !== 'object') continue;
    const agentName = typeof contribution.agent_name === 'string' && contribution.agent_name.length > 0
      ? contribution.agent_name
      : null;
    const filePath = typeof contribution.file_path === 'string' && contribution.file_path.length > 0
      ? contribution.file_path
      : null;
    const milliseconds = timestampValue(contribution.timestamp);

    if (agentName) agentNames.add(agentName);
    if (agentName && filePath) {
      if (!agentsByFile.has(filePath)) agentsByFile.set(filePath, new Set());
      agentsByFile.get(filePath).add(agentName);
    }
    if (milliseconds !== null) {
      activeDates.add(new Date(milliseconds).toISOString().slice(0, 10));
      if (latestMilliseconds === null || milliseconds > latestMilliseconds) {
        latestMilliseconds = milliseconds;
        lastContributionAt = timestampString(contribution.timestamp, milliseconds);
      }
    }
  }

  let collaborativeFileCount = 0;
  for (const contributors of agentsByFile.values()) {
    if (contributors.size >= 2) collaborativeFileCount += 1;
  }

  const nowMilliseconds = now instanceof Date ? now.getTime() : Number(now);
  const age = latestMilliseconds === null ? null : nowMilliseconds - latestMilliseconds;
  const safeQuarantineCount = Number.isSafeInteger(quarantinedFileCount) && quarantinedFileCount >= 0
    ? quarantinedFileCount
    : 0;

  return {
    totalContributions: history.length,
    fileCount: Array.isArray(files) ? files.length : 0,
    agentCount: agentNames.size,
    activeDays: activeDates.size,
    collaborativeFileCount,
    lastContributionAt,
    isLive: age !== null && Number.isFinite(age) && age >= 0 && age <= LIVE_MAX_AGE_MS,
    quarantinedFileCount: safeQuarantineCount,
  };
}

module.exports = {
  LIVE_MAX_AGE_MS,
  deriveActivityFreshness,
  computePlatformMetrics,
};
