# Review record — chaos schedule after reset/trigger (2026-09-24)

Plan: `docs/superpowers/plans/2026-09-24-chaos-schedule-reset.md` (plan gate: round 1 FAIL 0/1/4, round 2
PASS 0/0/3 — mappings at the end of the plan).

Static gates: `node --check server/index.js`; full suite with a private TMPDIR → 434 pass / 0 fail, rc=0,
0 leftover temp dirs (baseline 432).

## DoD round 1
- Slot A (Claude Opus, executing) — `## VERDICT` PASS (0/0/6).
- Slot B (GLM `glm-5.3:cloud`, reading) — `## VERDICT` PASS (0/0/5).
- After the round, one SECURITY.md word adjusted per Slot A INFO ("blocks all cookie access" → "blocks
  script access to cookies"); tree binding re-checked: that line is the only difference to the reviewed
  payload.

### Slot A round 1 — EVIDENCE
- ran: node --check server/index.js -> ok
- ran: 3x `T=$(mktemp -d); TMPDIR=$T node --test test/chaos-schedule.test.js; ls $T; rm -rf $T` on the tree -> each rc=0, pass 2 / fail 0, 0 leftover entries in $T
- recomputed: test 1 RED on HEAD server/index.js (copy) -> not ok, "nextAt ... (got null ...)" expected true actual false
- recomputed: HEAD active after stale activation (probe copy of test 1 without the nextAt assertion) -> PROBE nextAt null; `active` expected false actual true
- recomputed: test 2 RED on HEAD (copy) -> not ok, "expected exactly one activation line, got 2" (actual 2)
- mutation: drop the single clear at top of scheduleChaosMode -> RED in copy scratchpad/copy.X60H (test 1 active expected false actual true; test 2 activation lines 2)
- mutation: drop scheduleChaosMode() in /api/admin/reset -> RED in copy scratchpad/copy.X60H (test 1 nextAt got null; test 2 green, as expected)
- mutation: drop scheduleChaosMode() in /api/chaos/trigger -> RED in copy scratchpad/copy.X60H (test 2 activation lines 2; test 1 green, as expected)
- ran: every copy run with private TMPDIR -> 0 leftover entries; copy server/index.js restored and diffed identical before the copy was deleted
- ran: git status --short before/after -> unchanged (M SECURITY.md, M server/index.js, ?? NEXT_SESSION.md, ?? plan, ?? test); copy and scratch files removed; no aibuilds-* dirs left in $TMPDIR
