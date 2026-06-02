'use strict';

const path = require('path');

// In-memory moderation state (persisted via serializeModeration / loadModeration).
const hiddenFiles = new Set();   // normalized world-relative paths
const bannedAgents = new Set();  // exact agent_name
const bannedIps = new Set();     // exact ip
const agentIps = new Map();      // agent_name -> last seen ip (private)

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

// Decode the tricks an attacker uses to render a blocked phrase while dodging raw-string regexes:
// HTML numeric/named entities, zero-width & soft-hyphen separators, and compatibility forms.
function normalizeForScan(s) {
  return String(s || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ''; } })
    .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(parseInt(d, 10)); } catch { return ''; } })
    // named entities, incl. whitespace/zero-width ones attackers use to split a blocked phrase
    .replace(/&(amp|lt|gt|quot|apos|nbsp|ensp|emsp|thinsp|hairsp|zwnj|zwj|zwsp|ZeroWidthSpace|shy);/gi,
      (m, n) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ',
        thinsp: ' ', hairsp: ' ', zwnj: '', zwj: '', zwsp: '', zerowidthspace: '', shy: '' }[n.toLowerCase()] ?? m))
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
  // Construct the script-src regex inline (fresh, no shared /g lastIndex state). Executable
  // <script src> must be literal HTML, so this scans raw content (not the entity-decoded haystack).
  const scriptSrcRe = /<script\b[^>]*\bsrc\s*=\s*["']?([^"'>\s]+)/gi;
  for (const m of content.matchAll(scriptSrcRe)) {
    let src = m[1];
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
  loadModeration, serializeModeration,
  isHidden, hide, unhide, listHidden,
  isBanned, recordAgentIp, resolveAgentIp, ban, unban, listBans,
  scanContent,
};
