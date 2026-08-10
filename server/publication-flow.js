'use strict';

const { contentHash } = require('./content-governance');

function decideStoredPublication({ evaluation, approvedHash } = {}) {
  if (!evaluation || typeof evaluation !== 'object') {
    return { status: 'quarantined', reasons: ['evaluation_failure'] };
  }
  if (typeof approvedHash === 'string' && approvedHash === evaluation.contentHash) {
    return { status: 'published', reasons: [] };
  }
  return {
    status: evaluation.status === 'published' ? 'published' : 'quarantined',
    reasons: Array.isArray(evaluation.reasons) ? [...evaluation.reasons] : [],
  };
}

function buildContributionResponse({ contribution, decision } = {}) {
  const publicationStatus = decision?.status === 'published' ? 'published' : 'quarantined';
  return {
    success: true,
    publicationStatus,
    reasons: Array.isArray(decision?.reasons) ? [...decision.reasons] : [],
    contribution,
  };
}

function isAuditedHtmlPath(filePath) {
  return typeof filePath === 'string' && /^(?:pages|sections)\/.+\.html$/i.test(filePath);
}

async function auditWorldForQuarantine({ files = [], readFile, isApproved, evaluatePublication } = {}) {
  const quarantines = [];
  for (const file of files) {
    const filePath = typeof file === 'string' ? file : file?.path;
    if (!isAuditedHtmlPath(filePath)) continue;
    const source = await readFile(filePath);
    const evaluation = evaluatePublication({ filePath, content: source });
    const hash = contentHash(source);
    if (evaluation.status === 'published' || isApproved(filePath, hash)) continue;
    const modified = file && typeof file === 'object' ? new Date(file.modified) : null;
    quarantines.push({
      filePath,
      contentHash: hash,
      reasons: Array.isArray(evaluation.reasons) ? [...evaluation.reasons] : [],
      agentName: 'startup-audit',
      timestamp: modified && !Number.isNaN(modified.getTime())
        ? modified.toISOString()
        : new Date().toISOString(),
    });
  }
  return quarantines;
}

function isPublicContribution({ contribution, isHidden, isQuarantined } = {}) {
  if (!contribution || contribution.publicationStatus !== 'published' || typeof contribution.file_path !== 'string') {
    return false;
  }
  return !isHidden(contribution.file_path) && !isQuarantined(contribution.file_path);
}

function deriveSpecializations(fileTypeStats) {
  const specializations = [];
  if ((fileTypeStats.html || 0) + (fileTypeStats.js || 0) >= 10) specializations.push('frontend');
  if ((fileTypeStats.css || 0) >= 10) specializations.push('css');
  if ((fileTypeStats.json || 0) >= 5) specializations.push('data');
  if ((fileTypeStats.md || 0) >= 5) specializations.push('docs');
  if ((fileTypeStats.svg || 0) >= 5) specializations.push('graphics');
  return specializations;
}

function derivePublicAgentState({ publicHistory = [], comments = [] } = {}) {
  const state = new Map();
  const byPath = new Map();
  const publicIds = new Set();
  const publicPaths = new Set();

  for (const contribution of publicHistory) {
    if (!contribution || typeof contribution.agent_name !== 'string' || !contribution.agent_name) continue;
    const name = contribution.agent_name;
    const timestamp = new Date(contribution.timestamp);
    const timestampMs = timestamp.getTime();
    if (!state.has(name)) {
      state.set(name, {
        name,
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
        specializations: [],
        firstSeen: contribution.timestamp,
        lastSeen: contribution.timestamp,
      });
    }
    const agent = state.get(name);
    agent.contributions += 1;
    const counter = `${contribution.action}s`;
    if (counter === 'creates' || counter === 'edits' || counter === 'deletes') agent[counter] += 1;
    if (!Number.isNaN(timestampMs)) {
      if (new Date(agent.firstSeen).getTime() > timestampMs) agent.firstSeen = contribution.timestamp;
      if (new Date(agent.lastSeen).getTime() < timestampMs) agent.lastSeen = contribution.timestamp;
      const hour = timestamp.getHours();
      if (hour >= 22 || hour < 6) agent.nightContributions += 1;
      agent.recentContributionTimes.push(timestampMs);
    }
    const extension = String(contribution.file_path || '').match(/\.([^.\/]+)$/)?.[1]?.toLowerCase();
    if (extension) agent.fileTypeStats[extension] = (agent.fileTypeStats[extension] || 0) + 1;
    if (typeof contribution.id === 'string') publicIds.add(contribution.id);
    if (typeof contribution.file_path === 'string') {
      publicPaths.add(contribution.file_path);
      if (!byPath.has(contribution.file_path)) byPath.set(contribution.file_path, new Set());
      byPath.get(contribution.file_path).add(name);
    }
  }

  for (const names of byPath.values()) {
    for (const name of names) {
      const agent = state.get(name);
      for (const collaborator of names) if (collaborator !== name) agent.collaborators.add(collaborator);
    }
  }

  for (const contribution of publicHistory) {
    const receiving = state.get(contribution?.agent_name);
    if (!receiving || !contribution.reactions || typeof contribution.reactions !== 'object') continue;
    for (const reactors of Object.values(contribution.reactions)) {
      if (!Array.isArray(reactors)) continue;
      receiving.reactionsReceived += reactors.length;
      for (const reactorName of reactors) {
        const reacting = state.get(reactorName);
        if (reacting) reacting.reactionsGiven += 1;
      }
    }
  }

  const commentValues = comments instanceof Map ? comments.values() : comments;
  for (const comment of commentValues || []) {
    const publicTarget = comment?.publicTarget === true || (comment?.targetType === 'contribution'
      ? publicIds.has(comment.targetId)
      : comment?.targetType === 'file' && publicPaths.has(comment.targetId));
    if (!publicTarget) continue;
    const agent = state.get(comment.agentName);
    if (agent) agent.commentsCount += 1;
  }

  for (const agent of state.values()) {
    agent.recentContributionTimes.sort((a, b) => a - b);
    for (let start = 0, end = 0; end < agent.recentContributionTimes.length; end += 1) {
      while (agent.recentContributionTimes[end] - agent.recentContributionTimes[start] > 120000) start += 1;
      if (end - start + 1 >= 5) agent.speedDemonUnlocked = true;
    }
    agent.specializations = deriveSpecializations(agent.fileTypeStats);
  }

  return state;
}

module.exports = {
  decideStoredPublication,
  buildContributionResponse,
  auditWorldForQuarantine,
  isPublicContribution,
  derivePublicAgentState,
};
