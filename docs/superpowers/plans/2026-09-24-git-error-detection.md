# Git error detection and follow-ups — implementation plan

Date: 2026-09-24 · Base: `main` = `1ebe4be`; line numbers re-checked unchanged at `0d8e7ac` · Path: **High-Assurance**
(persistence/Git behaviour of every simple-git call, verification machinery).

Predecessor: Brain plan "AiBuilds Git-Fehlererkennung — Plan und Gate-Protokoll 2026-09-04"
(two gate rounds). Its Task 6 (consumer guard `assertIndexConfinedTo`) shipped in `ef96631`. This
plan re-derives the remaining tasks against the current tree; all line numbers below are measured
at `1ebe4be`.

Owner decisions taken under the standing instruction of 2026-09-23 ("follow your professional
recommendation"): D1 `moderate action=delete` reports a failed Git commit honestly (500), D2
Unicode comparison in `assertIndexConfinedTo` stays byte-exact, D3 `queueGitOperation` wrapping at
the moderate site stays, D4 the remaining Git environment variables are dropped at startup (three tested, plus
`GIT_ALTERNATE_OBJECT_DIRECTORIES` untested, R1-F11).

## 0. Confirmed facts

- `simple-git@3.36.0` treats a command as failed only when `exitCode && stdErr.length`
  (`node_modules/simple-git/dist/cjs/index.js:1350`). Exit ≠ 0 with empty stderr resolves.
  A custom detector is installed via the constructor option `errors`
  (`index.js:4736`: `config.errors && plugins.add(errorDetectionPlugin(config.errors))`).
- `server/index.js:147`: `const git = simpleGit(WORLD_DIR, { binary: gitBinary });` — no detector.
- Reject handler (`server/index.js:2825`–`2905`): commit failure → `catch` → `git reset -- <path>`
  (`:2874`) → rethrow. With a SILENT failing pre-commit hook simple-git resolves, the catch is never
  entered, the staged deletion stays, and only the `latest.message !== subject` guard (`:2879`)
  produces the 500 — the index keeps the deletion (producer of a dirty index; the consumer guard
  from `ef96631` turns the NEXT pathspec-less commit into a fail-closed 500).
- Moderate delete (`server/index.js:2520`–`2605`): `assertIndexConfinedTo` → `git.add -- <path>` →
  `git.commit(...)` inside `queueGitOperation`; ANY failure is caught with
  `console.warn('Moderation removal commit skipped: …')` and the route answers 200. After a commit
  failure the deletion stays staged (same producer). For a path that was never committed
  (NOT a quarantined one: quarantined targets are answered 409 at
  `server/index.js:2544` before any Git operation, R1-F8), `git add` exits 128 with stderr today →
  caught → 200: that is the correct outcome for an untracked file and must stay 200.
- R1-F10: the bootstrap commit (`server/index.js:5080`, `git commit` over an empty worktree) resolves
  today with "nothing to commit" on stdout; with T1 it rejects into its own catch and logs
  `World git not available: <stdout text>` instead of `Initialized new world git repo`. The repo is
  initialized either way (init + config ran); only the log line changes. Accepted, documented here.
- R1-F10: a Git child killed by a signal (`exitCode` null) still resolves under T1 — out of scope,
  documented.
- `server/index.js:138-140` delete `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`; `GIT_OBJECT_DIRECTORY`,
  `GIT_COMMON_DIR`, `GIT_QUARANTINE_PATH` are still inherited by every Git child.
- `waitForServer` without a per-attempt timeout: `test/admin-quarantine.test.js`,
  `test/public-contract.test.js`, `test/public-copy.test.js`, `test/seasons.test.js`,
  `test/seo-publication.test.js` (`fetch(`${baseUrl}/api/stats`)` without `signal`);
  `test/git-index-confinement.test.js:45` already uses `AbortSignal.timeout(1000)`.
- Measured 04.09. (Brain plan §3, to be re-measured by the gate): the only simple-git calls that can
  end with exit ≠ 0 AND empty stderr are (1) a completely silent failing hook and (2) `git commit`
  without `--allow-empty` when nothing is staged (message on stdout). Class 2 sites are inside
  catch blocks (moderate delete; bootstrap `:5080`).

## 1. Invariants

- G1 Every simple-git call whose Git process exits ≠ 0 rejects, whether or not stderr is empty.
- G2 A failed commit in the reject and moderate-delete paths leaves no staged entry for its path.
- G3 A rejected Git operation's error message is never empty: hook output verbatim when present,
  otherwise `git exited with code <n> without output`.
- G4 Git children never inherit `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_OBJECT_DIRECTORY`,
  `GIT_COMMON_DIR`, `GIT_QUARANTINE_PATH`, `GIT_ALTERNATE_OBJECT_DIRECTORIES` from the server
  environment.

## 2. Tasks (test-first)

Implementer instruction (verbatim): **„Wenn im Brief etwas widersprüchlich oder unvollständig ist:
frag, bevor du rätst.“**

### T1 — `server/git-errors.js` (new) + `test/git-errors.test.js` (new)

```js
// unverified until T1 — plugin order and Buffer semantics per simple-git 3.36.0 errorDetectionPlugin
function failOnNonZeroExit(error, result) {
  if (error) return error;
  if (!result.exitCode) return error;
  const output = Buffer.concat([...result.stdOut, ...result.stdErr]);
  return output.length ? output : Buffer.from(`git exited with code ${result.exitCode} without output`);
}
module.exports = { failOnNonZeroExit };
```
`server/index.js:147` → `simpleGit(WORLD_DIR, { binary: gitBinary, errors: failOnNonZeroExit })`.

Unit tests (with → without): existing error passes through unchanged; exit 0 → no error; exit 1 +
stderr "hook says no" → error text contains "hook says no"; exit 1 + stdout only → contains the
stdout text (without `...result.stdOut` → empty/other text: RED); exit 1, no output → contains
`exited with code 1` (without the fallback → empty message: RED). Plus a real-git unit test:
`simpleGit(tmpRepo, { errors: failOnNonZeroExit }).commit('x')` on a repo with nothing staged
rejects (without the option it resolves). The temp repo pins `core.hooksPath` to an empty directory
(R1-F5): the developer's global gitleaks hook writes stderr, which would make the "without" side
reject too and the test vacuous.

### T2 — silent-hook regression in the reject path (`test/git-error-detection.test.js`, new)

Spawned server over a pre-initialized World repo with `core.hooksPath` pinned (pattern of
`test/git-index-confinement.test.js`). Setup (R1-F7): the risky page is part of the SEED commit, so the
startup audit (`auditWorldForQuarantine`) quarantines it while it stays tracked; the test asserts
`inHead === true` before the first reject (a risky page contributed at runtime is quarantined AND
rolled back, i.e. untracked, which would not exercise the tracked branch). A second risky page is
written after the seed commit (untracked, quarantined by the same audit). Install a SILENT failing
pre-commit hook (`exit 1`, no output) and reject the tracked page:
- response 500; server log contains `exited with code 1` (G3) · without T1: log shows
  `Git rejection commit was not created`, not the exit code.
- `git diff --cached --name-only` is empty afterwards (G2) · without T1: lists the path.
- Directly afterwards (R1-F4 — this step must come BEFORE the stderr-hook step, which resets the
  index itself on either side): remove the hook, reject the untracked quarantined page → 200, and the
  tracked page remains in the HEAD tree (`git ls-tree HEAD -- <path>` non-empty) · without T1: 500,
  because the left-over staged deletion makes `assertIndexConfinedTo` refuse the pathspec-less commit.
- Last, on the first page again (a tracked risky page cannot be created at runtime; after its 500 the
  quarantine record is still there because `moderation.reject` never ran): hook that prints `hook says no` to stderr and exits 1 → 500 and
  the log contains `hook says no` verbatim (both with and without T1 — the separation is the verbatim
  text; a handler that replaces every message would turn it RED).

### T3 — moderate delete: honest failure (D1), guard refusal unchanged (R1-F1), persistence first (R1-F2)

Three outcomes, strictly separated, inside the existing `queueGitOperation`:

1. `tracked` via `git.raw(['ls-files', '--error-unmatch', '--', pathspec])` (catch → false; index-based
   like the reject handler, so an own path staged only as an ADD counts as tracked and reaches the
   guard — `test/git-index-confinement.test.js` "ghost" case). Untracked → no Git operation, 200, with
   `console.warn('Moderation removal commit skipped: <path> is not tracked (<e.message>)')` in the catch (R2-F5: a
   failing `ls-files` must not become silent).
2. `assertIndexConfinedTo` in its OWN try: any throw (refusal or unreadable index, `:494` shim case)
   → `console.warn('Moderation removal commit skipped: …')`, nothing staged, **200 as today**. The
   eight refusal tests in `test/git-index-confinement.test.js` (starting at `:290,349,374,394,418,469,
   499,519`; R2-F2) and the log pattern at `:311` stay untouched and green; the comment at `:304-305`
   gets one sentence noting that a
   commit failure AFTER a passed guard is now 500 (T3), a refusal is not.
3. Guard passed → `git.add` → `git.commit` in a try; on failure `git.raw(['reset', '--', pathspec])`
   (catch-and-keep original; runs ONLY in this branch, never after a guard refusal), `console.error(
   'Moderation removal commit failed: …')`, and a local `commitError` is recorded — NOT rethrown.

After the queue: `saveState()`, `moderation.save()`, `broadcast(...)` run exactly as today (disk
unlink, history splice, reaction counter and `moderation.reject` already happened). Only then:
`commitError` set → `res.status(500).json({ error: 'Moderation removal commit failed', code:
'git_commit_failed', detail: 'The file was removed and the state saved; the Git commit failed.' })`,
else the existing 200.

F9 (INFO), revised by DoD round 1 (Slot A WARN): an own path staged only as an addition is back to
HEAD after the add, and `git commit` exits 1 with "nothing to commit" — under T1 that became a false
500. Outcome 3 therefore commits only when `git diff --cached --name-only -- <pathspec>` is non-empty
after the add; otherwise 200 with nothing committed. Guarded by a test (500 without the check, 200
with it).

Tests (in `test/git-error-detection.test.js`), each with/without. The target is created through
`POST /api/contribute` (PoW, as in the existing spawned-server tests), so it is both tracked in HEAD
and a contribution in `state.json`; `state.json` is read right after the response, before any later
save could mask a skipped one.
- tracked target + silent failing hook → 500 `git_commit_failed` · without T3: 200.
- same case: `git diff --cached --name-only` empty · without the reset line: lists the path.
- same case: `data/state.json` no longer contains the contribution id (R2-F1: moderation keeps no
  "rejected" list — `reject()` only drops the path from `quarantinedFiles`/`approvedFiles`,
  `server/moderation.js:462`, so no moderation assertion is made) · with a rethrow instead of recording (the R1-F2 defect): the id is still in
  state.json.
- tracked normal → 200 and `git log -1 --format=%s` = `moderation: remove <path>` (both sides).
- never-committed target → 200 and HEAD unchanged (both sides).

### T4 — drop remaining Git environment variables (D4)

`server/index.js` next to `:138-140`: also `delete process.env.GIT_OBJECT_DIRECTORY;`,
`delete process.env.GIT_COMMON_DIR;`, `delete process.env.GIT_QUARANTINE_PATH;`,
`delete process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES;` (R1-F11) with one comment line.

Test (R1-F3), parametrized over `GIT_OBJECT_DIRECTORY`, `GIT_COMMON_DIR`, `GIT_QUARANTINE_PATH`, each
set to an empty temp dir for the spawned server: a published contribution answers **200** and
`git log -1 --format=%s` is the contribution subject · without the matching delete: **500** and HEAD
stays `seed world` (measured by the round-1 reviewer for each of the three; the implementer re-measures
the red side before adding the delete). `GIT_ALTERNATE_OBJECT_DIRECTORIES` gets no test: it only ADDS
lookup stores, so no observable failure can be constructed; its delete is defence in depth and is
excluded from the mutation list.

### T5 — `waitForServer` per-attempt timeout (test infrastructure)

Add `{ signal: AbortSignal.timeout(1000) }` to the probe `fetch` in the five files listed in §0 plus
`test/publication-flow.test.js:73` (R1-F6; `test/abuse-limits.test.js:641` already has it), exactly
as in `test/git-index-confinement.test.js:45`. No behaviour change in the server. Evidence:
full suite green 3× in a row; no guard test (a hanging probe is not deterministically constructible).

### T6 — verification

`node --check`; full suite (rc captured separately); `test/git-index-confinement.test.js` explicitly
green (R1-F1). Mutation runs in a copy, production and tests mutated separately: remove `errors`
option; remove fallback text; remove `...result.stdOut`; remove the reset in T3; T3 rethrow instead
of recording (R1-F2); T3 swallow as today (200); T3 guard refusal answered 500 (must turn the eight
confinement tests RED); remove each of the three tested T4 deletes → every guarding test RED. Report
any GREEN mutation.

## 3. Rollback

T1 is one constructor option (one-line revert); T3/T4 are local. No data format change.

## Findings mapping

(appended per gate round)

### Round 1 (executing Opus reviewer, 2026-09-24) — FAIL: 2 CRITICAL, 4 WARN, 5 INFO — incorporated 2026-09-24 (session 2)

Incorporation: F1 → T3 outcome 2 + T6 · F2 → T3 "after the queue" + state.json test · F3 → T4
parametrized, numbers 500→200 · F4 → T2 step order · F5 → T1 hooksPath pin · F6 → T5 sixth file ·
F7 → T2 seed setup · F8 → §0 example · F9 → T3, first not adopted, then adopted in DoD round 1 (staged-diff check) · F10 → §0 documented ·
F11 → T4 delete without test (reason there).

| Finding | Required change |
|---|---|
| F1 CRITICAL T3 turns guard refusals into 500 and breaks eight tests (`test/git-index-confinement.test.js:305,382,402,426,494,530,551,575`, log pattern `:311`; `:303` records 500-vs-200 as a product decision) | decide explicitly: guard refusal stays 200/"skipped" and only a failed add/commit after a passed guard becomes 500 — or list the eight tests with their new assertions; run the reset only after the guard passed |
| F2 CRITICAL T3 rethrow skips `saveState()` (`server/index.js:2598`), `moderation.save()` and `broadcast` although file deletion, history splice, reaction counter and `moderation.reject` already happened | record the commit failure, still persist and broadcast, then answer 500 `git_commit_failed` directly; assert `state.json` no longer contains the contribution |
| F3 WARN T4 "without" number wrong: with `GIT_OBJECT_DIRECTORY` set the contribution answers 500 and HEAD stays `seed world`, `cat-file -e HEAD` succeeds on both sides; only one of three variables tested | parametrize over all three variables; assert 200 + HEAD subject (500 → 200 measured for each) |
| F4 WARN T2 last step does not separate in the planned order (stderr hook already resets) | move "remove hook, reject untracked" directly after the silent-hook case (measured 500 without T1 → 200 with T1) |
| F5 WARN T1 real-git unit test vacuous without pinned `core.hooksPath` (global gitleaks hook writes stderr) | pin `core.hooksPath` to an empty dir in the temp repo |
| F6 WARN T5 inventory misses `test/publication-flow.test.js:73` | add as sixth file |
| F7 INFO T2 setup: a risky create is quarantined AND rolled back (untracked) | seed the risky page in the initial commit; startup audit quarantines it; assert `inHead === true` |
| F8 INFO §0 example: quarantined-only targets get 409 at `server/index.js:2544` before Git | use a never-committed path as the untracked example |
| F9 INFO staged-addition-only edge case in T3 | optional `diff --cached --quiet` before commit |
| F10 INFO bootstrap commit now throws into its catch (log text changes); signal-terminated git still resolves | document |
| F11 INFO also drop `GIT_ALTERNATE_OBJECT_DIRECTORIES` | extend T4 |

### Round 2 (executing Opus reviewer, delta, 2026-09-24) — FAIL: 1 CRITICAL, 0 WARN, 5 INFO

R1-F1…F11 confirmed resolved by measurement (worktree with T1+T3+T4: confinement suite 12/12, guard
refusal→500 mutation turns exactly 8 RED; T2 order 500→200; T4 500→200 for all three variables;
state.json separates rethrow from record).

| Finding | Change | Where |
|---|---|---|
| R2-F1 CRITICAL `moderation.json` "rejected" assertion — no such list exists | assertion removed, reason stated | T3 tests |
| R2-F2 INFO line numbers of the eight refusal tests stale (file has 573 lines) | replaced by test start lines `:290,349,374,394,418,469,499,519`, comment `:304-305` | T3 outcome 2 |
| R2-F3 INFO state.json separator confirmed | — | — |
| R2-F4 INFO R1-F1 fix confirmed | — | — |
| R2-F5 INFO untracked branch silent on a failing `ls-files` | `console.warn` in the tracked-check catch | T3 outcome 1 |
| R2-F6 INFO ~384 leftover `aibuilds-index-confinement-*` temp dirs | out of scope, listed as open item | — |

### Round 3 (executing Opus reviewer, delta, 2026-09-24) — PASS: 0 CRITICAL, 0 WARN, 1 INFO

| Finding | Change | Where |
|---|---|---|
| R3-F1 INFO untracked warn hides the `ls-files` cause | `e.message` appended to the warn | T3 outcome 1 |

Plan gate closed. Implementation may start.

## DoD (post-implementation) summary

Round 1: Slot A FAIL 0/1/5 (ghost ADD → false 500, fixed test-first), Slot B PASS 0/0/6, Reviewgate
2 CRITICAL rejected with evidence. Round 2 (delta): Slot A PASS 0/0/5, Slot B PASS 0/0/8. Full record:
`docs/dev/2026-09-24-git-error-detection-review.md`.
