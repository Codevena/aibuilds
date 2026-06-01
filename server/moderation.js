'use strict';

// In-memory moderation state (persisted via serializeModeration / loadModeration).
const hiddenFiles = new Set();   // normalized world-relative paths
const bannedAgents = new Set();  // exact agent_name
const bannedIps = new Set();     // exact ip
const agentIps = new Map();      // agent_name -> last seen ip (private)

// Normalize any path input to a comparable world-relative key.
function normalizePath(p) {
  if (typeof p !== 'string') return '';
  return p
    .replace(/\\/g, '/')      // backslashes -> slashes
    .replace(/^\/+/, '')      // strip leading slashes
    .replace(/^world\//i, '') // strip a leading world/ prefix
    .toLowerCase();
}

function loadModeration(state) {
  hiddenFiles.clear(); bannedAgents.clear(); bannedIps.clear(); agentIps.clear();
  const m = (state && state.moderation) || {};
  for (const p of m.hiddenFiles || []) hiddenFiles.add(normalizePath(p));
  for (const a of m.bannedAgents || []) bannedAgents.add(a);
  for (const ip of m.bannedIps || []) bannedIps.add(ip);
  const ips = (state && state.agentIps) || {};
  for (const [name, ip] of Object.entries(ips)) agentIps.set(name, ip);
}

function serializeModeration() {
  return {
    moderation: {
      hiddenFiles: Array.from(hiddenFiles),
      bannedAgents: Array.from(bannedAgents),
      bannedIps: Array.from(bannedIps),
    },
    agentIps: Object.fromEntries(agentIps),
  };
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

module.exports = {
  loadModeration, serializeModeration,
  isHidden, hide, unhide, listHidden,
};
