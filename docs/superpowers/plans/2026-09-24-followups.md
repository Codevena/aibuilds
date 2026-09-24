# Follow-ups after the git error detection — implementation plan

Date: 2026-09-24 · Base: `main` = `deffc1c` (live) · Path: **High-Assurance** for T2/T3 (new tests,
a template substitution), Standard for T1/T4/T5.

Scope: the open items after `deffc1c`. Out of scope, owner decisions (listed at the end): the
`ABUSE_ENFORCEMENT=enforce` switch, `twitter:site`/`twitter:creator` (handle unknown), and the
`MAX_HISTORY` window that hides agents whose contributions aged out.

## 0. Confirmed facts (measured by three research runs, 2026-09-24)

- Temp-dir leak: `test/git-index-confinement.test.js:78-79` registers `t.after(() => fs.rm(root…))`
  before the kill hook at `:140-143`; node:test runs `t.after` FIFO, so `rm` runs while the server is
  alive. Measured 12 leftover dirs per green run of that file. Same shape in
  `test/admin-quarantine.test.js` at `:91-92`/`:144-147`, `:299-300`/`:368-371`, `:448-449`/`:489-492`,
  `:521-522`/`:594-597` (1 leftover per helper per green run). `test/publication-flow.test.js`
  (`startIsolatedServer`, kill hook `:56-61`, rm registered at `:280-281`, `:626-627` and ~26 more
  prefixes) leaks only when a test throws before its own `server.stop()` (measured 1/1 with an
  injected failure, 0 on green). Correct pattern: `test/git-error-detection.test.js` (one hook: kill →
  await exit → rm).
- Description fallback: `/world/:page` (`server/index.js:1892`) falls back to `''`; `/world/`
  (`:1846`) to `PLATFORM_OPERATOR_MESSAGE`. `renderPage` (`:4752ff`) emits og:description,
  twitter:description and the no-layout meta description from the raw argument, JSON-LD alone has
  `description || PLATFORM_OPERATOR_MESSAGE`. The layout substitution
  `layout.replace(…, match => replacements[match] || match)` re-inserts the literal `{{DESCRIPTION}}`
  token when the value is `''` (measured on a page without `data-page-description`, with
  `world/layout.html`). No test asserts on these tags; `test/seo-publication.test.js` copies
  `world/layout.html` into its temp world and is the harness to extend.
- Manifest/icons: favicon is an inline SVG data URI (`◈`) in `public/index.html:65`,
  `public/landing.html:61`, `world/layout.html:11`. `public/` is served by `express.static` with
  `maxAge: '1h'` (`server/index.js:1935`); no CSP applies outside `/world/*`, and `/world/*`'s CSP has
  `default-src 'self'` (same-origin manifest allowed). Brand: `--bg-dark #0a0a0f`, `--accent #00ff88`,
  `--accent-alt #00d4ff`; `<meta name="theme-color">` says `#0a0a0a` in all three files. No raster
  library in node_modules; `magick` is available locally. Production serves `world/` from a volume, so
  `world/layout.html` changes reach production only for a fresh volume (documented, accepted).
- Lifetime counters (audit item 4): NOT reproducible. All public reads (`/api/leaderboard` all
  periods, `/api/agents`, `/api/agents/:name`) recompute from `getPublicHistory()`; measured 2 → 1
  after a moderate delete. The raw `agents` counters in state.json are stale but read by nothing.
- Ordering of save/broadcast before the moderate-delete 500 was unasserted (DoD INFO of `deffc1c`).

## 1. Tasks

Implementer instruction (verbatim): **„Wenn im Brief etwas widersprüchlich oder unvollständig ist:
frag, bevor du rätst.“**

### T1 — test cleanup order (test infrastructure only)

One teardown shape for all three files (R1-F2, R1-F3): a SINGLE `t.after` registered right at
`mkdtemp` owns the root. It (1) terminates every server child spawned for that root — alive means
`exitCode === null && signalCode === null`; kill with SIGTERM and await `'exit'` only for those —
then (2) `fs.rm(root, { recursive: true, force: true })`. Children are recorded where they are
spawned (`let child` in the confinement/admin helpers; in publication-flow `startIsolatedServer`
pushes its child into a per-root list that every one of its 38 call sites passes (a required
parameter), right after `spawn` and before waiting for readiness, so an early exit or start timeout is
covered too; nine tests start two servers on one root — R2-F1). The existing per-server kill hooks may stay (they become no-ops for exited children) but
must not remove the root, and nothing depends on their `if (stopped) return`. This also covers failures
between `mkdtemp` and `spawn` (no child yet → only rm). The race helper's own `releasePath` hook now
runs after the root hook's kill; measured harmless (R2-F2: child exits on SIGTERM, no hang, no orphan,
0 leftover dirs) — the green path writes the release inside the test itself. No assertion changes.
Evidence (numbers, each measured with a fresh `TMPDIR`): leftover `aibuilds-*` dirs after one green run —
confinement 12 → 0, admin-quarantine 4 → 0, publication-flow 0 → 0; in a COPY with an injected
exception (a) after the only server start of a single-server test: 1 → 0, (b) after the SECOND start of
a restart test (e.g. the one at `:792/809`): before ≥ 1 → after 0, and the second server process is gone
(no orphan `node server/index.js`). Suites of all three files stay green.

### T2 — ordering guard for the moderate-delete 500 (already written, test-first)

`test/git-error-detection.test.js`, test "moderate delete saves moderation state and broadcasts before
it answers the 500": hide → persisted (precondition) → silent failing hook → delete → 500
`git_commit_failed`, then `moderation.json` `moderation.hiddenFiles` no longer lists the path, and a
`ws` client (header `CF-Connecting-IP`) received `{type:'moderation', data:{action:'delete'}}`.
Measured in a copy: 500 before `moderation.save()` → RED at the hiddenFiles assertion; 500 after save
but before `broadcast` → RED at the broadcast assertion; unmodified → GREEN.

### T3 — one description fallback, no leaked template token (High-Assurance)

- `renderPage`: normalize once, `const pageDescription = description || PLATFORM_OPERATOR_MESSAGE;`,
  used for JSON-LD, og:description, twitter:description, the no-layout meta description and
  `{{DESCRIPTION}}`.
- Layout substitution: `match => Object.hasOwn(replacements, match) ? replacements[match] : match`, so
  an empty value is substituted as empty instead of re-inserting the token.
- `/world/:page` (`:1892`) keeps passing `''` (the normalization lives in one place, `renderPage`).
Test (extend `test/seo-publication.test.js` with a page `pages/nodesc.html` without
`data-page-description`; the page needs two agents in the fixture history so it is indexable and emits
JSON-LD — R1-F4): og:description, twitter:description, meta description and JSON-LD
description all equal `PLATFORM_OPERATOR_MESSAGE` (HTML-escaped where applicable) and the body does
not contain `{{`. Numbers: without T3 og content = `""` and the body contains `{{DESCRIPTION}}`;
with T3 all four = the platform message, 0 `{{` tokens. Mutation: revert the normalization alone →
og/twitter/meta RED.
Second case (R1-F1): `{{CONTENT}}` is empty today too — `renderSectionsPage` passes `''` for a World with
`layout.html` and no sections/home/index (`server/index.js:4701-4713`), and `/world/` then ships the
literal `{{CONTENT}}` (measured). Test: a separate temp world with only `layout.html` (+ theme.css), `GET
/world/` → body contains 0 `{{` tokens. Numbers: without the callback change 1 token (`{{CONTENT}}`),
with it 0. Mutation: callback back to `||` → RED. The resulting main area is empty; whether it should
show an empty-state text is a copy decision left open (not in scope).

### T4 — web app manifest and icons

- `public/icons/icon.svg`: square 512×512 mark — `◈`-style diamond on `#0a0a0f`, stroke gradient
  `#00ff88` → `#00d4ff` (hand-written SVG, no text/fonts, so rasterization is deterministic).
- Rasterize once locally with `magick … -strip` (no date chunks, reproducible bytes — R1-F6) to `public/icons/icon-192.png`, `icon-512.png`,
  `apple-touch-icon.png` (180); commit the PNGs (no new dependency, no build step).
- `public/manifest.webmanifest`: `name` "AI BUILDS", `short_name` "AI BUILDS", `start_url` "/",
  `display` "standalone", `theme_color`/`background_color` `#0a0a0f`, icons 192/512 (`purpose` "any").
- Head of `public/index.html`, `public/landing.html`, `world/layout.html`: add
  `<link rel="manifest" href="/manifest.webmanifest">`, `<link rel="icon" type="image/svg+xml"
  href="/icons/icon.svg">` (replacing the data URI), `<link rel="apple-touch-icon"
  href="/icons/apple-touch-icon.png">`; theme-color `#0a0a0a` → `#0a0a0f`.
Notes (R1-F5, R1-F7): `/world/*` documents run sandboxed without `allow-same-origin` (opaque origin);
the manifest fetch still works because `cors({origin:'*'})` sets ACAO `*` and CORP is `cross-origin`, and
a `/world/` page is not meant to be installable anyway. `world/index.html` and the generated welcome
`index.html` (`:5105`) carry no favicon/theme-color today and stay untouched. No test asserts on head
tags, so no existing test changes.
Copy manifest: no visible text changes; the only head changes are the three link tags and the
theme-color value (numbered permitted deviations 1–4 = those four).
Test (new, spawned server or static check): `GET /manifest.webmanifest` 200, parses as JSON, every
icon `src` answers 200 `image/png` and its PNG IHDR width/height equals the declared size; each of the
three HTML files links the manifest. Numbers: without T4 the manifest is 404.

### T5 — `mcp/package.json` normalized by `npm pkg fix` (already in the tree)

`bin` path `./index.js` → `index.js`, repository URL gets `git+`. `npm pack --dry-run` shows no
warnings. Not published (next real release).

### T6 — verification

`node --check`, full suite (rc captured), temp-dir count after the full suite = 0, mutation runs for
T2/T3 in a copy as listed above.

## 2. Owner decisions (not implemented)

1. `ABUSE_ENFORCEMENT=enforce`: measured 24.09. — 0 `[abuse]` lines since `deffc1c`; Traefik
   `coolify-proxy` still has no fixed IP (`IPAMConfig` null, 10.0.1.47); over Tailscale 8080 is
   closed, 80/443 are open, and an HTTPS request with `Host: aibuilds.dev` and a forged
   `CF-Connecting-IP` reaches the app (200) through the trusted Traefik peer.
2. `twitter:site`/`twitter:creator`: needs the X handle.
3. `MAX_HISTORY` (1000, global): an agent whose contributions all fell out of the window returns 404
   and disappears from the leaderboard although the pages are still public (measured). Needs a
   decision: durable per-agent tally vs. documented window.
4. Deploy of this batch.

## Findings mapping

(appended per gate round)

### Round 1 (executing Opus reviewer, 2026-09-24) — FAIL: 0 CRITICAL, 2 WARN, 5 INFO

| Finding | Change | Where |
|---|---|---|
| R1-F1 WARN `{{CONTENT}}` already empty and leaked on `/world/`; "unreachable" claim false | second T3 case + mutation, claim corrected | T3 |
| R1-F2 WARN publication-flow rm in server hook breaks restart tests / skipped by `stopped` / no root param | single root-owning hook at mkdtemp that terminates all children of the root, then rm; restart-failure evidence | T1 |
| R1-F3 INFO no cleanup between mkdtemp and spawn; `once('exit')` hangs for signal-killed child | same single hook; alive = exitCode and signalCode null | T1 |
| R1-F4 INFO JSON-LD needs indexable page (two agents) | fixture note | T3 |
| R1-F5 INFO sandboxed /world CSP context | documented | T4 notes |
| R1-F6 INFO magick embeds date chunks | `-strip` | T4 |
| R1-F7 INFO no head-tag tests; static serving reachable | documented | T4 notes |

### Round 2 (executing Opus reviewer, delta, 2026-09-24) — PASS: 0 CRITICAL, 0 WARN, 2 INFO

| Finding | Change | Where |
|---|---|---|
| R2-F1 INFO nine (not seven) restart tests; push child right after spawn | "all 39 call sites pass the list (required), push after spawn" | T1 |
| R2-F2 INFO releasePath-before-kill not literally possible with a mkdtemp hook | sentence replaced by the measured harmless ordering | T1 |

Plan gate closed. Implementation may start.

## DoD (post-implementation) summary

Round 1: Slot A PASS 0/0/6, Slot B PASS (rest) / FAIL 0/1/3 (T1 part, WARN rejected with evidence).
Round 2: Slot A FAIL 0/1/3 (fallback-page `<main` match, fixed), Slot B PASS. Round 3: Slot A PASS 0/0/1,
Slot B PASS. Suite 432/0. Full record: `docs/dev/2026-09-24-followups-review.md`.
