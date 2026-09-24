# Review record — follow-ups after git error detection (2026-09-24)

Plan: `docs/superpowers/plans/2026-09-24-followups.md` (plan gate: round 1 FAIL 0/2/5, round 2 PASS
0/0/2 — mappings at the end of the plan).

Static gates: `node --check server/index.js`; full suite `npm test` with a private TMPDIR → 432 pass /
0 fail, rc=0, 0 `aibuilds-*` dirs left afterwards (baseline 429).

## DoD round 1
- Slot A (Claude Opus, executing) — `## VERDICT` PASS (0/0/6). Recomputed every plan number.
- Slot B (GLM `glm-5.3:cloud`, reading, payload split in two parts) — rest `## VERDICT` PASS (0/0/8);
  T1 part `## VERDICT` FAIL (0/1/3). The WARN (race test registers its root hook after "awaited
  setup") was rejected: only synchronous `path.join` assignments sit between `mkdtemp` and the hook;
  Slot A round 2 confirmed. Adopted INFO: status/layout assertions in the empty-world test, icon.svg
  checks in the manifest test, plan call-site count 38.

## DoD round 2 (delta)
- Slot A — `## VERDICT` FAIL (0/1/3): `/<main/` also matched the no-layout fallback page. Fixed with a
  layout-specific regex; mutation (layout not copied) RED at that assertion.
- Slot B — `## VERDICT` PASS (0/0/5).

## DoD round 3 (delta)
- Slot A — `## VERDICT` PASS (0/0/1): comment said "above" instead of "below" (fixed after the round;
  tree binding re-checked: the only difference to the reviewed payload is that word).
- Slot B — `## VERDICT` PASS (0/0/4).

### Slot A round 1 — EVIDENCE
- recomputed: T1 leftovers per green run, private TMPDIR each, HEAD tree (git archive) vs working tree copy -> git-index-confinement 12 -> 0 (12/12 pass both), admin-quarantine 4 -> 0 (5/5 pass both), publication-flow 0 -> 0 (37/37 pass both)
- recomputed: T1 failure injection (a) throw right after the only start in "contribution diff is bound to the requested contribution git hash" -> HEAD 1 leftover, new 0 leftovers
- recomputed: T1 failure injection (b) throw right after the SECOND start in "startup audit reconciles stale state..." -> HEAD 1 leftover, new 0 leftovers; `pgrep -f server/index.js` = 0 afterwards in both (no orphan)
- recomputed: startIsolatedServer call sites -> 38 calls, 0 without trailing `children` argument (brace-matching parse); 29 `const children = []` = 28 server tests + 1 parametrized loop test; the only mkdtemp without a children list is the server-less startup-audit test
- mutation: publication-flow root hook with its kill loop removed + injection (b) -> 1 leftover (mechanism RED) in copy scratchpad/copy.3eVH
- mutation: git-index-confinement root hook reordered to rm-before-kill -> 12 leftovers again (mechanism RED; the tests themselves stay green, as expected for hygiene) in copy scratchpad/copy.3eVH
- ran: git diff -U0 of the three T1 files, removed/added non-comment lines grouped -> only t.after/kill/rm/spawn-assignment/children-arg lines; no assert line removed or added
- ran: crash()/SIGKILL restart tests inside publication-flow -> green; root hook skips children with signalCode set (no hang)
- mutation: T2 test, 500 returned before moderation.save() -> RED at "moderation.save() must run before the 500" 3/3 runs in copy scratchpad/copy.3eVH
- mutation: T2 test, 500 after save but before broadcast -> RED at "the moderation broadcast must be sent before the 500" 3/3 runs in copy scratchpad/copy.3eVH
- ran: T2 test unmodified 3x -> GREEN 3/3 (deterministic)
- mutation: T3 normalization reverted (`pageDescription = description`) -> RED, test 2 fails with og/twitter/meta description content="" in copy scratchpad/copy.3eVH
- mutation: T3 callback reverted to `replacements[match] || match` -> RED, test 3 fails, body contains literal `{{CONTENT}}` in copy scratchpad/copy.3eVH
- ran: T3 unmodified seo-publication.test.js -> 3/3 pass, 0 leftovers
- recomputed: which replacements can be '' after T3 -> TITLE never (all callers fall back to a page name/'Home'/'AI BUILDS'), DESCRIPTION never (normalized), HEAD_SEO/NAV/MAIN_CLASS never with a layout; only CONTENT (empty page file or no sections). Object.hasOwn therefore changes visible output only where the literal token used to leak
- recomputed: escaping -> every description output still goes through escapeHtmlServer (escapes & < > " '), JSON-LD still JSON.stringify + `<` -> <; the fallback constant has no HTML-sensitive characters; the test constant equals server/index.js:100
- mutation: web-manifest test with manifest + icons removed -> RED; icon-192.png replaced by the 180px file -> RED; manifest link removed from landing.html / index.html / world/layout.html (each alone) -> RED in all three, in copy scratchpad/copy.3eVH
- ran: served the copy with an empty world, curl -D -> /manifest.webmanifest 200 application/manifest+json; icon-192/512/apple-touch-icon 200 image/png; icon.svg 200 image/svg+xml; all with ACAO *, CORP cross-origin, max-age=3600
- ran: file public/icons/*.png -> 192x192, 512x512, 180x180 RGBA; chunk list IHDR IDAT IEND only (no tEXt/tIME)
- recomputed: byte reproducibility -> `magick -background none public/icons/icon.svg -resize NxN -strip` gives byte-identical output (cmp) to all three committed PNGs, and a second run is identical too
- ran: viewed icon-192.png -> renders the green-to-cyan double diamond on a dark background
- recomputed: copy manifest -> git diff numstat 4+/2- per HTML file; the changed lines, deduplicated, are exactly: theme-color #0a0a0a -> #0a0a0f, data-URI icon link -> svg icon link, + manifest link, + apple-touch-icon link (3x each), nothing else; no other public/ or world/ HTML carries the old data URI or #0a0a0a
- ran: npm pack --dry-run in mcp/ (copy) -> rc 0, 6 files, no warnings; the diff contains only bin `./index.js` -> `index.js` and repository url `git+` prefix (metadata)
- ran: git-error-detection + web-manifest + seo-publication in the copy with a private TMPDIR -> 14/14 pass, 0 aibuilds-* leftovers, 0 surviving servers
- ran: git status --short before/after (excluding .review/) -> unchanged; scratchpad copies removed; the 17 aibuilds-* dirs in the system TMPDIR were there before this review (all runs used private TMPDIRs)


### Slot A round 2 — EVIDENCE
- ran: TMPDIR=<private> node --test test/seo-publication.test.js test/web-manifest.test.js -> rc=0, 4 pass / 0 fail
- mutation: server /world/ handler returns 404 immediately -> RED in copy /var/folders/vn/6v_2mqg97193kr9ht7gpdg140000gn/T/tmp.ZjmP0MEVkv (empty-world test: "404 !== 200" at the new status assertion; the pretty-pages test also red)
- mutation: remove the layout.html copyFile from the empty-world test's world (line 216) -> GREEN in copy /var/folders/vn/6v_2mqg97193kr9ht7gpdg140000gn/T/tmp.t38w2W0kxC (fallback page contains `<main`) — see WARN
- mutation: (first attempt hit line 100's copyFile in the other test by mistake; that run is not counted) -> RED in copy /var/folders/vn/6v_2mqg97193kr9ht7gpdg140000gn/T/tmp.vWmJKIUVfl (other test)
- mutation: candidate fix `/<main id="main-content" class="world-main world-main-home">/` with layout present -> GREEN; with layout copy removed -> RED ("the layout must actually have been rendered") in copy /var/folders/vn/6v_2mqg97193kr9ht7gpdg140000gn/T/tmp.dqfNR0v07u
- mutation: rm public/icons/icon.svg -> RED in copy /var/folders/vn/6v_2mqg97193kr9ht7gpdg140000gn/T/tmp.tdi5exTewu ("404 !== 200" at the icon.svg status assertion)
- mutation: remove `<link rel="icon" type="image/svg+xml" href="/icons/icon.svg">` from public/index.html -> RED in copy /var/folders/vn/6v_2mqg97193kr9ht7gpdg140000gn/T/tmp.tA0O1l42K1 (assertion message 'dashboard (public/index.html)', link regex)
- ran: grep -c "startIsolatedServer(" test/publication-flow.test.js -> 39 (1 definition + 38 calls)
- ran: git status --short before/after -> identical; all my copies removed (an older copy /var/folders/vn/6v_2mqg97193kr9ht7gpdg140000gn/T/tmp.cyTV7TMrPQ, 18:39, is not from this round and was left in place)

### Slot A round 3 — EVIDENCE
- ran: T=$(mktemp -d); TMPDIR=$T node --test test/seo-publication.test.js -> rc=0, tests 3, pass 3, fail 0
- mutation: removed the second copyFile of world/layout.html (line 216, empty-world test) -> RED in copy /var/folders/vn/6v_2mqg97193kr9ht7gpdg140000gn/T/tmp.I8UBudKm9Y (not ok 3, failure message 'the layout must actually have been rendered'; tests 1-2 still pass)
- mutation: server/index.js:4841 renderPage callback reverted to `match => replacements[match] || match` -> RED in copy /var/folders/vn/6v_2mqg97193kr9ht7gpdg140000gn/T/tmp.iRTikVT8MI (not ok 3, failure at assert.doesNotMatch for /\{\{/; layout assertion passed)
- ran: diff of each copy against the repo showed exactly the one intended line changed; both copies removed afterwards
- ran: git status --short before/after compared -> identical apart from .review/
