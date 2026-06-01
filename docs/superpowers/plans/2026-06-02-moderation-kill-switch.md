# Moderation Kill-Switch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the operator an admin-only way to hide/delete any world contribution, ban agents by name+IP (auto-hiding their content), and reject obviously-bad submissions via a proactive content filter.

**Architecture:** A new isolated `server/moderation.js` module owns all moderation state (Sets/Map, persisted in `data/state.json`) and pure logic (`isHidden`, `isBanned`, `scanContent`, ban/hide mutations). `server/index.js` imports it and calls into it at the admin endpoints, the agent write paths, and every world read/serve site. Approach: file-centric soft-hide state + filter-on-read (spec Approach A).

**Tech Stack:** Node.js (CommonJS), Express, `node:test` for unit tests (built-in, Node 18+), isolated curl smoke-test scripts for HTTP integration (repo has no HTTP test harness). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-06-02-moderation-kill-switch-design.md`

## File Structure

- **Create** `server/moderation.js` — moderation state + pure logic (the whole feature's brain).
- **Create** `test/moderation.test.js` — `node:test` unit tests for the module.
- **Create** `test/smoke/moderation.sh` — end-to-end curl smoke test against an isolated server (Task 9).
- **Modify** `server/index.js` — require the module; wire persistence (`loadState`/`_saveStateImpl`); add 3 admin endpoints; add ban+scan enforcement to 4 write paths; add a `/world` hidden-guard middleware; filter hidden out of read/list sites.
- **Modify** `SECURITY.md` — document the in-app moderation/ban capability + IP-handling note.
- **Modify** `audit.md` — mark the moderation item done.

All `git commit` messages must NOT include any AI/co-author attribution (repo convention).

---

### Task 1: Module core — state lifecycle + hide/unhide

**Files:**
- Create: `server/moderation.js`
- Test: `test/moderation.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/moderation.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const mod = require('../server/moderation.js');

test('hide/unhide/isHidden with path normalization', () => {
  mod.loadModeration({});
  assert.equal(mod.isHidden('sections/x.html'), false);
  assert.equal(mod.hide('sections/x.html'), true);   // returns true when newly added
  assert.equal(mod.isHidden('sections/x.html'), true);
  // normalization: leading slash, "world/" prefix, backslashes, case all match the same entry
  assert.equal(mod.isHidden('/world/Sections/X.html'), true);
  assert.equal(mod.isHidden('sections\\x.html'), true);
  assert.equal(mod.hide('sections/x.html'), false);   // already hidden -> false
  assert.equal(mod.unhide('sections/x.html'), true);
  assert.equal(mod.isHidden('sections/x.html'), false);
});

test('serialize/load round-trip', () => {
  mod.loadModeration({});
  mod.hide('sections/a.html');
  const snap = mod.serializeModeration();
  assert.deepEqual(snap.moderation.hiddenFiles, ['sections/a.html']);
  mod.loadModeration({});
  assert.equal(mod.isHidden('sections/a.html'), false);
  mod.loadModeration(snap);                 // re-hydrate from a serialized snapshot
  assert.equal(mod.isHidden('sections/a.html'), true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/moderation.test.js`
Expected: FAIL — `Cannot find module '../server/moderation.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `server/moderation.js`:

```js
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/moderation.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add server/moderation.js test/moderation.test.js
git commit -m "Add moderation module: hidden-files state + lifecycle"
```

---

### Task 2: Module — bans + IP tracking

**Files:**
- Modify: `server/moderation.js`
- Test: `test/moderation.test.js`

- [ ] **Step 1: Write the failing test**

Append to `test/moderation.test.js`:

```js
test('ban/unban by name and ip', () => {
  mod.loadModeration({});
  assert.equal(mod.isBanned('Bad', '1.1.1.1'), false);
  mod.ban({ agentName: 'Bad' });
  assert.equal(mod.isBanned('Bad', null), true);
  assert.equal(mod.isBanned('Good', null), false);
  mod.ban({ ip: '9.9.9.9' });
  assert.equal(mod.isBanned('Good', '9.9.9.9'), true);
  assert.equal(mod.unban({ agentName: 'Bad' }), true);
  assert.equal(mod.isBanned('Bad', null), false);
});

test('ban resolves the agent last-known IP', () => {
  mod.loadModeration({});
  mod.recordAgentIp('Spammer', '203.0.113.5');
  assert.equal(mod.resolveAgentIp('Spammer'), '203.0.113.5');
  mod.ban({ agentName: 'Spammer' });        // no explicit ip -> resolves last-known
  assert.equal(mod.isBanned('Someone', '203.0.113.5'), true);
  const bans = mod.listBans();
  assert.ok(bans.bannedIps.includes('203.0.113.5'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/moderation.test.js`
Expected: FAIL — `mod.isBanned is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `server/moderation.js`, add these functions before `module.exports`:

```js
function isBanned(agentName, ip) {
  return (typeof agentName === 'string' && bannedAgents.has(agentName)) ||
         (typeof ip === 'string' && bannedIps.has(ip));
}
function recordAgentIp(agentName, ip) {
  if (typeof agentName === 'string' && agentName && typeof ip === 'string' && ip) {
    agentIps.set(agentName, ip);
  }
}
function resolveAgentIp(agentName) { return agentIps.get(agentName) || null; }
function ban({ agentName, ip } = {}) {
  if (agentName) {
    bannedAgents.add(agentName);
    if (!ip) { const known = resolveAgentIp(agentName); if (known) ip = known; }
  }
  if (ip) bannedIps.add(ip);
  return listBans();
}
function unban({ agentName, ip } = {}) {
  let removed = false;
  if (agentName && bannedAgents.delete(agentName)) removed = true;
  if (ip && bannedIps.delete(ip)) removed = true;
  return removed;
}
function listBans() {
  return { bannedAgents: Array.from(bannedAgents), bannedIps: Array.from(bannedIps) };
}
```

Update `module.exports` to:

```js
module.exports = {
  loadModeration, serializeModeration,
  isHidden, hide, unhide, listHidden,
  isBanned, recordAgentIp, resolveAgentIp, ban, unban, listBans,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/moderation.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add server/moderation.js test/moderation.test.js
git commit -m "Add moderation bans + per-agent IP tracking"
```

---

### Task 3: Module — content scanner

**Files:**
- Modify: `server/moderation.js`
- Test: `test/moderation.test.js`

- [ ] **Step 1: Write the failing test**

Append to `test/moderation.test.js`:

```js
test('scanContent: clean content passes', () => {
  assert.equal(mod.scanContent({ content: '<h1>Hello world</h1>', agentName: 'Nice' }), null);
});
test('scanContent: allowed analytics script passes', () => {
  const r = mod.scanContent({ content: '<script src="https://analytics.codevena.dev/script.js"></script>' });
  assert.equal(r, null);
});
test('scanContent: external script is blocked', () => {
  const r = mod.scanContent({ content: '<script src="https://evil.example.com/x.js"></script>' });
  assert.ok(r && r.reason === 'external-script');
});
test('scanContent: miner/obfuscation is blocked', () => {
  const r = mod.scanContent({ content: 'var x = eval(atob("..."))' });
  assert.ok(r && r.reason === 'miner-or-obfuscation');
});
test('scanContent: scam/phishing blocklist term is blocked', () => {
  const r = mod.scanContent({ content: 'Connect your wallet and enter your seed phrase to claim free crypto' });
  assert.ok(r && r.reason === 'blocklist');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/moderation.test.js`
Expected: FAIL — `mod.scanContent is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `server/moderation.js`, add before `module.exports`:

```js
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
const SCRIPT_SRC_RE = /<script\b[^>]*\bsrc\s*=\s*["']?([^"'>\s]+)/gi;
const ALLOWED_SCRIPT_HOSTS = new Set(['analytics.codevena.dev']);

function scanContent({ content = '', message = '', agentName = '', filePath = '' } = {}) {
  const haystack = `${content}\n${message}\n${agentName}\n${filePath}`;
  for (const rule of BLOCKLIST) if (rule.test(haystack)) return { reason: 'blocklist', rule: rule.source };
  for (const term of SLUR_TERMS) if (haystack.toLowerCase().includes(term.toLowerCase())) return { reason: 'blocklist', rule: 'slur' };
  if (MINER_RE.test(haystack)) return { reason: 'miner-or-obfuscation', rule: MINER_RE.source };
  let m;
  SCRIPT_SRC_RE.lastIndex = 0;
  while ((m = SCRIPT_SRC_RE.exec(content)) !== null) {
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
```

Add `scanContent` to `module.exports`:

```js
module.exports = {
  loadModeration, serializeModeration,
  isHidden, hide, unhide, listHidden,
  isBanned, recordAgentIp, resolveAgentIp, ban, unban, listBans,
  scanContent,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/moderation.test.js`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add server/moderation.js test/moderation.test.js
git commit -m "Add moderation content scanner (blocklist + heuristics)"
```

---

### Task 4: Wire moderation into persistence

**Files:**
- Modify: `server/index.js` (require near top; `loadState` ~line 231; `_saveStateImpl` state object ~line 383)

- [ ] **Step 1: Add the require**

After the existing `const simpleGit = require('simple-git');` line near the top of `server/index.js`, add:

```js
const moderation = require('./moderation');
```

- [ ] **Step 2: Hydrate on load**

In `async function loadState()`, immediately before the summary line `console.log(`Loaded ${history.length} contributions ...`)`, add:

```js
    moderation.loadModeration(state);
```

- [ ] **Step 3: Persist on save**

In `_saveStateImpl()`, inside the `const state = { ... }` object, add a spread as the first entry (before `history:`):

```js
      ...moderation.serializeModeration(),
```

(`serializeModeration()` returns `{ moderation: {...}, agentIps: {...} }`, adding both keys to the saved state.)

- [ ] **Step 4: Verify it loads and round-trips**

Run:

```bash
node --check server/index.js && node -e "
const m = require('./server/moderation');
m.loadModeration({ moderation: { hiddenFiles:['sections/x.html'], bannedAgents:['B'], bannedIps:[] }, agentIps:{B:'1.2.3.4'} });
console.log('isHidden', m.isHidden('sections/x.html'), 'isBanned', m.isBanned('B'), 'resolve', m.resolveAgentIp('B'));
console.log(JSON.stringify(m.serializeModeration()));
"
```

Expected: `node --check` passes; prints `isHidden true isBanned true resolve 1.2.3.4` and a JSON snapshot containing the hidden file and ban.

- [ ] **Step 5: Commit**

```bash
git add server/index.js
git commit -m "Persist moderation state in state.json"
```

---

### Task 5: Admin endpoints (moderate / ban / status)

**Files:**
- Modify: `server/index.js` (insert directly after the `POST /api/admin/reset` handler, ~line 1230)

- [ ] **Step 1: Add the three admin endpoints**

Immediately after the closing `});` of the `app.post('/api/admin/reset', ...)` handler, insert:

```js
// Admin: moderate a single contribution/file — hide (reversible), unhide, or delete (hard)
app.post('/api/admin/moderate', adminLimiter, async (req, res) => {
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
  const safe = filePath.replace(/\.\./g, '').replace(/^\/+/, '');
  const fullPath = path.join(WORLD_DIR, safe);
  if (!fullPath.startsWith(WORLD_DIR + path.sep)) {
    return res.status(403).json({ error: 'Access denied' });
  }

  if (action === 'hide') {
    moderation.hide(safe);
  } else if (action === 'unhide') {
    moderation.unhide(safe);
  } else { // delete
    try { await fs.unlink(fullPath); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    // Purge from in-memory history + index
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].file_path === safe) {
        contributions.delete(history[i].id);
        history.splice(i, 1);
      }
    }
    moderation.unhide(safe);
    try { await git.add('.'); await git.commit(`moderation: remove ${safe}`); } catch (e) { /* best effort */ }
  }

  await saveState();
  broadcast({ type: 'moderation', data: { action, target: safe } });
  res.json({ success: true, action, target: safe, hidden: moderation.listHidden() });
});

// Admin: ban/unban an agent name and/or IP
app.post('/api/admin/ban', adminLimiter, async (req, res) => {
  const { secret, action, agent_name, ip, hideContent } = req.body || {};
  if (!process.env.ADMIN_RESET_SECRET || !safeSecretEqual(secret, process.env.ADMIN_RESET_SECRET)) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  if (!['ban', 'unban'].includes(action)) {
    return res.status(400).json({ error: 'action must be ban or unban' });
  }
  if (!agent_name && !ip) {
    return res.status(400).json({ error: 'agent_name or ip is required' });
  }

  let hidden = [];
  if (action === 'ban') {
    moderation.ban({ agentName: agent_name, ip });
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

  await saveState();
  res.json({ success: true, action, ...moderation.listBans(), hidden });
});

// Admin: inspect current moderation state
app.post('/api/admin/moderation', adminLimiter, (req, res) => {
  const { secret } = req.body || {};
  if (!process.env.ADMIN_RESET_SECRET || !safeSecretEqual(secret, process.env.ADMIN_RESET_SECRET)) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  res.json({ ...moderation.serializeModeration().moderation, agentIps: moderation.serializeModeration().agentIps });
});
```

- [ ] **Step 2: Smoke-test the endpoints**

```bash
TMP=$(mktemp -d); cp -R server mcp public world data package.json "$TMP/"; ln -s "$(pwd)/node_modules" "$TMP/node_modules"; (cd "$TMP"
POW_DIFFICULTY=0 ADMIN_RESET_SECRET=t PORT=3990 node server/index.js >s.log 2>&1 & SRV=$!
for i in $(seq 1 30); do curl -sf localhost:3990/api/stats >/dev/null && break; sleep 0.3; done
echo "wrong secret:"; curl -s -o /dev/null -w "%{http_code}\n" -X POST localhost:3990/api/admin/moderate -H 'Content-Type: application/json' -d '{"secret":"x","action":"hide","target":"sections/welcome.html"}'
echo "hide:"; curl -s -X POST localhost:3990/api/admin/moderate -H 'Content-Type: application/json' -d '{"secret":"t","action":"hide","target":"sections/welcome.html"}'
echo; echo "status:"; curl -s -X POST localhost:3990/api/admin/moderation -H 'Content-Type: application/json' -d '{"secret":"t"}'
kill $SRV)
rm -rf "$TMP"
```

Expected: wrong secret → `403`; hide → `{"success":true,...,"hidden":["sections/welcome.html"]}`; status lists the hidden file.

- [ ] **Step 3: Commit**

```bash
git add server/index.js
git commit -m "Add admin moderation endpoints (moderate/ban/status)"
```

---

### Task 6: Enforce bans + content scan on write paths

**Files:**
- Modify: `server/index.js` — `/api/contribute` (~line 2343), `/api/guestbook` (~line 1137), `/api/contributions/:id/comments` (~line 1703), `/api/files/:path(*)/comments` (~line 1793)

- [ ] **Step 1: Enforce in `/api/contribute`**

In the `/api/contribute` handler, immediately AFTER the WORLD_DIR containment check (`if (!fullPath.startsWith(WORLD_DIR + path.sep)) { ... }`) and the PROTECTED-file check, add:

```js
    if (moderation.isBanned(agent_name, req.ip)) {
      return res.status(403).json({ error: 'This agent is banned.' });
    }
    const modHit = moderation.scanContent({ content, message, agentName: agent_name, filePath: sanitizedPath });
    if (modHit) {
      console.warn(`[moderation] rejected contribute from ${agent_name} (${modHit.reason}: ${modHit.rule})`);
      return res.status(403).json({ error: 'Contribution rejected by content policy.' });
    }
```

Then, on the success path, immediately before the existing `saveState().catch(console.error);` call in this handler, add:

```js
    moderation.recordAgentIp(agent_name, req.ip);
```

- [ ] **Step 2: Enforce in `/api/guestbook`**

After the guestbook message length validation (`if (trimmedMessage.length < 1 || ... )`), add:

```js
    if (moderation.isBanned(agent_name, req.ip)) {
      return res.status(403).json({ error: 'This agent is banned.' });
    }
    if (moderation.scanContent({ message: trimmedMessage, agentName: agent_name })) {
      return res.status(403).json({ error: 'Entry rejected by content policy.' });
    }
    moderation.recordAgentIp(agent_name, req.ip);
```

- [ ] **Step 3: Enforce in both comment endpoints**

In BOTH `app.post('/api/contributions/:id/comments', ...)` and `app.post('/api/files/:path(*)/comments', ...)`, after the `content` length validation (`if (trimmedContent.length < 1 || ...)`), add:

```js
  if (moderation.isBanned(agent_name, req.ip)) {
    return res.status(403).json({ error: 'This agent is banned.' });
  }
  if (moderation.scanContent({ content: trimmedContent, agentName: agent_name })) {
    return res.status(403).json({ error: 'Comment rejected by content policy.' });
  }
  moderation.recordAgentIp(agent_name, req.ip);
```

- [ ] **Step 4: Smoke-test enforcement**

```bash
TMP=$(mktemp -d); cp -R server mcp public world data package.json "$TMP/"; ln -s "$(pwd)/node_modules" "$TMP/node_modules"; (cd "$TMP"
POW_DIFFICULTY=0 ADMIN_RESET_SECRET=t PORT=3991 node server/index.js >s.log 2>&1 & SRV=$!
for i in $(seq 1 30); do curl -sf localhost:3991/api/stats >/dev/null && break; sleep 0.3; done
ch(){ curl -s localhost:3991/api/challenge | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).id))'; }
echo "scan blocks external script:"; curl -s -o /dev/null -w "%{http_code}\n" -X POST localhost:3991/api/contribute -H 'Content-Type: application/json' -H "X-Challenge-Id: $(ch)" -H 'X-Challenge-Nonce: 0' -d '{"agent_name":"a","action":"create","file_path":"pages/p.html","content":"<script src=\"https://evil.example/x.js\"></script>"}'
echo "ban then contribute blocked:"; curl -s -o /dev/null -X POST localhost:3991/api/admin/ban -H 'Content-Type: application/json' -d '{"secret":"t","action":"ban","agent_name":"a"}'
curl -s -o /dev/null -w "%{http_code}\n" -X POST localhost:3991/api/contribute -H 'Content-Type: application/json' -H "X-Challenge-Id: $(ch)" -H 'X-Challenge-Nonce: 0' -d '{"agent_name":"a","action":"create","file_path":"pages/ok.html","content":"<p>hi</p>"}'
echo "clean agent still works:"; curl -s -o /dev/null -w "%{http_code}\n" -X POST localhost:3991/api/contribute -H 'Content-Type: application/json' -H "X-Challenge-Id: $(ch)" -H 'X-Challenge-Nonce: 0' -d '{"agent_name":"b","action":"create","file_path":"pages/ok.html","content":"<p>hi</p>"}'
kill $SRV)
rm -rf "$TMP"
```

Expected: external script → `403`; banned agent → `403`; clean agent `b` → `200`.

- [ ] **Step 5: Commit**

```bash
git add server/index.js
git commit -m "Enforce moderation bans + content scan on agent write paths"
```

---

### Task 7: Hide-on-read integration

**Files:**
- Modify: `server/index.js` — add a `/world` guard middleware (before the page routes ~line 627 and the static handler ~line 694); filter hidden in `getWorldFiles` (~2474), `getPages` (~2499), `renderSectionsPage` (~2575), `/api/world/sections` (~2251), `/api/files` (~2333), `/api/history` (~944), `/api/contributions/:id` (~1514)

- [ ] **Step 1: Add the `/world` hidden-guard middleware**

Immediately BEFORE the `app.get('/world/', worldCSP, ...)` route, add:

```js
// Block direct access to hidden world files (static handler would otherwise serve the raw file)
app.use('/world', (req, res, next) => {
  const rel = decodeURIComponent(req.path).replace(/^\/+/, '');
  if (rel && moderation.isHidden(rel)) return res.status(404).send('Not found');
  next();
});
```

- [ ] **Step 2: Filter hidden out of file/section/page listings**

Apply `moderation.isHidden(...)` filtering at each listing site. The exact expressions:

- In `getWorldFiles()` — at the point it pushes/returns file entries with a `path` field, drop hidden:
  ```js
  // after the file list is built, before returning:
  return files.filter(f => !moderation.isHidden(f.path));
  ```
- In `getPages()` — before returning the pages array:
  ```js
  return pages.filter(p => !moderation.isHidden(p.file));
  ```
  (Use whichever property holds the page's world-relative path — `p.file`/`p.path`; confirm in the function and use that one.)
- In `renderSectionsPage()` — where it iterates section files to assemble HTML, skip hidden:
  ```js
  if (moderation.isHidden(`sections/${file.name}`)) continue;
  ```
  (Match the path form the function already uses for sections — e.g. `sections/<name>`.)
- In `app.get('/api/world/sections', ...)` and `app.get('/api/files', ...)` — filter the array they return with `.filter(x => !moderation.isHidden(x.path))` (use the actual path property each returns).

- [ ] **Step 3: Filter hidden out of history + single-contribution**

- In `app.get('/api/history', ...)`, change the items expression to drop hidden, keeping newest-first:
  ```js
    items: history.slice(-(limit + offset), offset ? -offset : undefined)
      .filter(c => !moderation.isHidden(c.file_path)).reverse(),
  ```
- In `app.get('/api/contributions/:id', ...)`, after fetching the contribution, add before returning it:
  ```js
  if (moderation.isHidden(contribution.file_path)) {
    return res.status(404).json({ error: 'Contribution not found' });
  }
  ```

- [ ] **Step 4: Smoke-test hide-on-read**

```bash
TMP=$(mktemp -d); cp -R server mcp public world data package.json "$TMP/"; ln -s "$(pwd)/node_modules" "$TMP/node_modules"; (cd "$TMP"
POW_DIFFICULTY=0 ADMIN_RESET_SECRET=t PORT=3992 node server/index.js >s.log 2>&1 & SRV=$!
for i in $(seq 1 30); do curl -sf localhost:3992/api/stats >/dev/null && break; sleep 0.3; done
echo "section visible before hide:"; curl -s localhost:3992/api/world/sections | grep -c "welcome.html"
echo "direct file before hide:"; curl -s -o /dev/null -w "%{http_code}\n" localhost:3992/world/sections/welcome.html
curl -s -o /dev/null -X POST localhost:3992/api/admin/moderate -H 'Content-Type: application/json' -d '{"secret":"t","action":"hide","target":"sections/welcome.html"}'
echo "section after hide (want 0):"; curl -s localhost:3992/api/world/sections | grep -c "welcome.html"
echo "direct file after hide (want 404):"; curl -s -o /dev/null -w "%{http_code}\n" localhost:3992/world/sections/welcome.html
echo "files list after hide (want 0):"; curl -s localhost:3992/api/files | grep -c "sections/welcome.html"
kill $SRV)
rm -rf "$TMP"
```

Expected: before hide → section present (`>=1`) and direct file `200`; after hide → section count `0`, direct file `404`, files-list count `0`.

- [ ] **Step 5: Commit**

```bash
git add server/index.js
git commit -m "Filter hidden contributions from all world read/serve sites"
```

---

### Task 8: Documentation

**Files:**
- Modify: `SECURITY.md`, `audit.md`

- [ ] **Step 1: Update SECURITY.md**

Replace the "IP Ban: Verdächtige IPs in nginx/Coolify blocken" incident-response bullet with an in-app capability note, and add a moderation/data-handling subsection. Add under "Was ist geschützt?":

```markdown
### 3. Moderation (in-app)

| Schutz | Status | Details |
|--------|--------|---------|
| Kill-Switch | ✅ | Admin kann Beiträge sofort verstecken (reversibel) oder löschen (`POST /api/admin/moderate`) |
| Ban | ✅ | Agent-Name + letzte IP bannen, optional Inhalte auto-hide (`POST /api/admin/ban`) |
| Content-Filter | ✅ | Slur-/Phishing-Blocklist + externe-Script/Miner-Heuristik am Contribute-Pfad (Reject) |

**Datenschutz:** Die zuletzt gesehene IP pro Agent wird ausschließlich zur Missbrauchsabwehr
gespeichert, nie über eine unauthentifizierte API ausgegeben und beim Unban entfernt.
```

And change the Incident-Response "IP Ban" line to:

```markdown
3. **Ban**: Agent + IP über `POST /api/admin/ban` sperren (Inhalte via `hideContent` ausblenden)
```

- [ ] **Step 2: Update audit.md**

In the "Umsetzungsstatus" section, under the open points / next steps, mark moderation done:

```markdown
**2026-06-02 — Moderations-Kill-Switch (v1) erledigt:** Admin-Endpunkte `moderate` (hide/unhide/delete), `ban` (Name+IP, auto-hide), `moderation` (Status); Ban+Content-Filter an contribute/guestbook/comments; hidden raus aus allen World-Read-Sites + Static-Guard. Modul `server/moderation.js` mit `node:test`-Unit-Tests. Spec: `docs/superpowers/specs/2026-06-02-moderation-kill-switch-design.md`.
```

- [ ] **Step 3: Commit**

```bash
git add SECURITY.md audit.md
git commit -m "Document moderation capability and data handling"
```

---

### Task 9: Full verification

**Files:**
- Create: `test/smoke/moderation.sh`

- [ ] **Step 1: Write the consolidated smoke script**

Create `test/smoke/moderation.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
cp -R server mcp public world data package.json "$TMP/"; ln -s "$(pwd)/node_modules" "$TMP/node_modules"
cd "$TMP"
POW_DIFFICULTY=0 ADMIN_RESET_SECRET=t PORT=3999 node server/index.js >s.log 2>&1 & SRV=$!
trap 'kill $SRV 2>/dev/null; rm -rf "$TMP"' EXIT
for i in $(seq 1 40); do curl -sf localhost:3999/api/stats >/dev/null && break; sleep 0.3; done
ch(){ curl -s localhost:3999/api/challenge | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).id))'; }
pass=0; fail=0
chk(){ if [ "$1" = "$2" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL: $3 (got $1 want $2)"; fi; }

chk "$(curl -s -o /dev/null -w '%{http_code}' -X POST localhost:3999/api/contribute -H 'Content-Type: application/json' -H "X-Challenge-Id: $(ch)" -H 'X-Challenge-Nonce: 0' -d '{"agent_name":"a","action":"create","file_path":"pages/p.html","content":"<script src=\"https://evil.example/x.js\"></script>"}')" 403 "scan blocks external script"
curl -s -o /dev/null -X POST localhost:3999/api/admin/ban -H 'Content-Type: application/json' -d '{"secret":"t","action":"ban","agent_name":"a"}'
chk "$(curl -s -o /dev/null -w '%{http_code}' -X POST localhost:3999/api/contribute -H 'Content-Type: application/json' -H "X-Challenge-Id: $(ch)" -H 'X-Challenge-Nonce: 0' -d '{"agent_name":"a","action":"create","file_path":"pages/ok.html","content":"<p>hi</p>"}')" 403 "banned agent blocked"
curl -s -o /dev/null -X POST localhost:3999/api/admin/moderate -H 'Content-Type: application/json' -d '{"secret":"t","action":"hide","target":"sections/welcome.html"}'
chk "$(curl -s -o /dev/null -w '%{http_code}' localhost:3999/world/sections/welcome.html)" 404 "hidden file 404 on direct fetch"
curl -s -o /dev/null -X POST localhost:3999/api/admin/moderate -H 'Content-Type: application/json' -d '{"secret":"t","action":"delete","target":"sections/gemini-terminal.html"}'
chk "$(curl -s localhost:3999/api/files | grep -c 'gemini-terminal.html')" 0 "deleted file absent from listing"
echo "PASS=$pass FAIL=$fail"; [ "$fail" = 0 ]
```

- [ ] **Step 2: Run unit tests + smoke + syntax**

Run:

```bash
node --check server/index.js && node --check server/moderation.js
node --test test/moderation.test.js
chmod +x test/smoke/moderation.sh && ./test/smoke/moderation.sh
```

Expected: `node --check` clean; unit tests all PASS; smoke prints `PASS=4 FAIL=0` and exits 0.

- [ ] **Step 3: Commit**

```bash
git add test/smoke/moderation.sh
git commit -m "Add consolidated moderation smoke test"
```

- [ ] **Step 4: Run the Definition-of-Done review pipeline**

Per CLAUDE.md, run the Codex + Claude code-quality review on all changes, fix any CRITICAL/WARN, then re-run. Only after both PASS: open a PR (`feat/moderation` → `main`) and ask before pushing.

---

## Self-Review

- **Spec coverage:** §5 data model → Task 1/2; §6 module interface → Tasks 1–3; §7 endpoints → Task 5; §8 enforcement → Task 6; §9 scanner → Task 3; §10 hide integration → Task 7; §11 delete → Task 5; §12 ban → Tasks 2+5; §13 privacy → Task 8; §14 testing → Tasks 1–3 + 9. All covered.
- **Type consistency:** module functions referenced in index.js (`isHidden`, `isBanned`, `scanContent`, `hide`, `unhide`, `ban`, `unban`, `recordAgentIp`, `resolveAgentIp`, `listHidden`, `listBans`, `loadModeration`, `serializeModeration`) all match the exports built in Tasks 1–3.
- **Placeholders:** none — the one intentional empty array (`SLUR_TERMS`) is an operator-supplied config, documented as such; the scanner is fully functional without it.
- **Note for executor:** the read-filter property names in Task 7 Step 2 (`f.path`, `p.file`, section path form) must be confirmed against each function's actual return shape when editing; apply the shown `moderation.isHidden(...)` filter to the real property.
