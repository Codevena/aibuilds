# Chaos schedule survives an admin reset — implementation plan

Date: 2026-09-24 · Base: `main` = `20bb76f` · Path: **High-Assurance** (new timer control flow, new
guard test). Source: June audit item 5 (Brain report "AiBuilds Audit und Umsetzungsplan 2026-06-01").

## 0. Confirmed facts

- `scheduleChaosMode()` (`server/index.js:3355-3375`) arms two `setTimeout`s whose handles are never
  stored. `/api/admin/reset` (`:2478ff`) sets `chaosMode = { active: false, endsAt: null, nextAt: null }`
  and clears only `chaosTimer` (the auto-deactivation handle), not the pending activation. The old
  activation therefore still fires after a reset, activates chaos on the reset platform and re-schedules
  from there; between reset and that moment `/api/chaos` reports `nextAt: null`.
- Audit sub-item "deactivateChaosMode saves twice on a double call": not reachable today. Every caller
  checks `chaosMode.active` first (`/api/chaos` `:3264`, `rearmChaosTimer` `:3342`), and the timer
  callback's handle is cleared by any earlier `deactivateChaosMode` (`:3304-3307`). No change.
- Audit sub-item "`allow-forms` hint for World authors in SECURITY.md": `/world/*` carries the CSP
  `sandbox allow-scripts allow-top-navigation-by-user-activation` and `form-action 'none'`
  (`server/index.js:1805-1806`), so forms never submit, whether the page is framed or opened directly.
  `SECURITY.md:74` still says a direct `/world/` visit is "ungesandboxed" — stale since that CSP.
- `CHAOS_DURATION`/`CHAOS_INTERVAL` are constants (10 min / 24 h); state is preloadable through
  `state.json` (`chaosMode` is restored in `loadState`, `:1463ff`), pattern `spawnServer({ preloadState })`
  in `test/resource-caps.test.js:44-61`.

## 1. Tasks

Implementer instruction (verbatim): **„Wenn im Brief etwas widersprüchlich oder unvollständig ist:
frag, bevor du rätst.“**

### T1 — store and cancel the scheduled activation (test-first)

- `let chaosScheduleTimer = null;` next to `chaosTimer`. `scheduleChaosMode()` clears a pending
  handle before arming and stores the new one (both branches).
- `scheduleChaosMode()` is the single owner of that handle (R1-F1): it clears the pending activation
  in both branches before arming; no other site clears it.
- `/api/admin/reset`: after the existing `chaosTimer` clear, call `scheduleChaosMode()` BEFORE the reset's `await saveState()`, so the reset platform gets a fresh 24 h
  schedule and the new `nextAt` is part of the snapshot that save persists (`saveState` snapshots the
  state synchronously when called, `:1514ff`).
- `/api/chaos/trigger` (R1-F3): after `activateChaosMode()` call `scheduleChaosMode()`, so the pending
  activation armed for the old `nextAt` is replaced by one for the new `nextAt` (today the old one still
  fires: two activations within 24 h, and `/api/chaos` reports a `nextAt` that is not the real one).
Tests (new file, spawned server with preloaded `state.json`, lead `L = 5000 ms` written right before
spawn — R1-F2):
1. Reset: `chaosMode = { active: false, endsAt: null, nextAt: t0 + L }`; `POST /api/admin/reset` → 200,
   precondition: the response arrived before `t0 + L`; right after, `GET /api/chaos` → `nextAt` ≈ now +
   24 h (± 1 min); at `t0 + L + 1500 ms`, `GET /api/chaos` → `active === false`. Numbers (measured by the
   gate reviewer with L = 2000): without T1 `nextAt: null` and `active: true`; with T1 `nextAt ≈ +86397 s`
   and `active: false`.
2. Trigger: same preload; `POST /api/chaos/trigger` (PoW difficulty 0, valid secret) → 200, precondition
   before `t0 + L`; at `t0 + L + 1500 ms` the server log contains exactly ONE `[CHAOS] Chaos mode
   activated!` line and `/api/chaos` `nextAt` = trigger time + 24 h within ± 2 s (R2-F1: a ± 1 min window
   does not separate — without the change `nextAt` drifts by L). Numbers: without the trigger change
   2 lines, with it 1 (to be measured RED first by the implementer).
Mutations (in a copy): drop the clear in `scheduleChaosMode`'s 24 h branch → test 1 `active: true` RED
(measured by the gate reviewer); drop the `scheduleChaosMode()` call in reset → `nextAt: null` RED; drop
the clear in the stored-time branch → test 2 two activations RED; drop the call in the trigger route →
test 2 RED.

### T2 — SECURITY.md

Rewrite the stale bullets in English — `SECURITY.md:74` and the "Cookie Stealing (nur World-Domain)" line
(`:61`, R1-F4: the opaque origin gives no cookie access): the `/world/*` CSP sandboxes every World page,
framed or opened directly (opaque origin, no same-origin access); the separate-origin recommendation
stays as the stronger isolation. Add one bullet for World authors: forms do not submit (`form-action
'none'`, no `allow-forms`), use JavaScript and the public API instead. No other lines change; the
surrounding German prose stays as it is (only touched lines become English).

### T3 — verification

`node --check`, full suite (private TMPDIR, rc captured, 0 leftover dirs), the four mutations listed in T1, in a copy.

## Findings mapping

(appended per gate round)

### Round 1 (executing Opus reviewer, 2026-09-24) — FAIL: 0 CRITICAL, 1 WARN, 4 INFO

| Finding | Change | Where |
|---|---|---|
| R1-F1 WARN reset-clear mutation stays GREEN (scheduleChaosMode clears too) | single owner of the handle = scheduleChaosMode; mutation replaced by "drop clear in 24 h branch" (measured RED) | T1 |
| R1-F2 INFO timing lead vs. boot under load | L = 5000 ms, precondition "response before t0 + L" | T1 tests |
| R1-F3 INFO trigger leaves the old scheduled activation armed | adopted: trigger calls scheduleChaosMode(); test 2 + mutations | T1 |
| R1-F4 INFO SECURITY.md:61 cookie line also stale | included | T2 |
| R1-F5 INFO line refs, unreachable double save, snapshot order, shutdown confirmed | — | — |

### Round 2 (executing Opus reviewer, delta, 2026-09-24) — PASS: 0 CRITICAL, 0 WARN, 3 INFO

| Finding | Change | Where |
|---|---|---|
| R2-F1 INFO test 2 nextAt ± 1 min does not separate (drift = L) | tightened to ± 2 s; log-line count stays the guard | T1 test 2 |
| R2-F2 INFO one clear at the top of scheduleChaosMode merges the two branch mutations | acceptable; implementer reports which shape was chosen and runs the merged mutation | T1 |
| R2-F3 INFO no side effects; activateChaosMode has exactly 3 callers | — | — |

Plan gate closed. Implementation may start.

## DoD (post-implementation) summary

Round 1: Slot A PASS 0/0/6, Slot B PASS 0/0/5. Suite 434/0. Record:
`docs/dev/2026-09-24-chaos-schedule-review.md`.
