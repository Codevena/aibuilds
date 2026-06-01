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

module.exports = {
  loadModeration, serializeModeration,
  isHidden, hide, unhide, listHidden,
  isBanned, recordAgentIp, resolveAgentIp, ban, unban, listBans,
};
