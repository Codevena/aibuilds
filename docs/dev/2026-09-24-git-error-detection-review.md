# Review record — git error detection (2026-09-24)

Plan: `docs/superpowers/plans/2026-09-24-git-error-detection.md` (plan gate: round 1 FAIL 2C/4W,
round 2 FAIL 1C, round 3 PASS 0/0/1 — mappings at the end of the plan).

Static gates: `node --check` on changed server files; full suite `npm test` → 429 pass / 0 fail, rc=0
(baseline 414; +15 new tests).

Controller mutations (T6, in a copy): M1 remove `errors` option, M2 remove fallback text, M3 remove
`...result.stdOut`, M4 remove reset, M5 rethrow, M6 swallow, M7 guard refusal → 500 (8 RED in the
confinement suite), M8a–c remove each tested env delete → all RED. One additional mutation (delete
branch without `saveState()`) was GREEN: the state.json assertion read a non-existent
`state.contributions` key. Fixed (reads `history` ids with a precondition), now RED.

## DoD round 1

- Slot A (Claude Opus, executing) — `## VERDICT` FAIL (0 CRITICAL, 1 WARN, 5 INFO).
  WARN: own path staged only as an addition → false 500 "nothing to commit". Fixed test-first
  (RED 500 before, 200 after): commit only when the staged diff for the path is non-empty.
- Slot B (GLM `glm-5.3:cloud`, reading) — `## VERDICT` PASS (0/0/6).
- Reviewgate iteration 1 — FAIL, 2 CRITICAL from one low-precision reviewer; both rejected with
  evidence (env deletes run once at module load, nothing re-assigns them; bootstrap commit is inside
  try/catch). Slot A round 2 re-verified both rejections.

### Slot A round 1 — EVIDENCE
- ran: node --test test/git-errors.test.js (copy) -> 6 pass / 0 fail
- ran: node --test test/git-error-detection.test.js (copy) -> 8 pass / 0 fail
- ran: node --test test/git-index-confinement.test.js (copy) -> 12 pass / 0 fail
- ran: node --check server/index.js && node --check server/git-errors.js -> ok
- recomputed: simple-git@3.36.0 isTaskError at dist/cjs/index.js:1350 = `exitCode && stdErr.length`; config.errors plugin added at :4736 after the default handler (overwrite=true), so the detector receives the default GitError and passes it through -> confirmed
- recomputed: "guard refusal answered 500 -> exactly 8 RED in confinement suite" -> 8 not-ok lines
- recomputed: T2 step 2 "500 without T1 -> 200 with T1" -> with M1 and step-1 separating assertions removed from a test copy: step 2 expected 200 actual 500 (log: "Quarantine rejection commit: refusing pathspec-less commit over 1 unrelated staged path(s)")
- recomputed: T2 step 3 passes without T1 (plan "both sides") -> with M1 and the step-1/2 separating assertions removed: test ok
- recomputed: ghost-only moderate delete (own ADD staged, never committed): current tree -> 500 {"code":"git_commit_failed"}, staged [], HEAD unchanged; HEAD:server/index.js -> 200, staged [], HEAD unchanged
- mutation: git-errors.test.js, detector with default semantics (exitCode && stdErr) -> RED (tests 4,5,6) in copy $TMPDIR/slota-r1-MvbF
- mutation: git-errors.test.js, M2 no fallback -> RED (test 5 only) in copy $TMPDIR/slota-r1-MvbF
- mutation: git-errors.test.js, M3 no stdOut -> RED (test 4 only) in copy $TMPDIR/slota-r1-MvbF
- mutation: git-errors.test.js, drop `if (error) return error` -> RED (test 1) in copy $TMPDIR/slota-r1-MvbF
- mutation: git-errors.test.js, drop exit-0 check -> RED (test 2) in copy $TMPDIR/slota-r1-MvbF
- mutation: git-errors.test.js, return string instead of Buffer -> RED (tests 3,4,5) in copy $TMPDIR/slota-r1-MvbF
- mutation: git-error-detection.test.js, M1 remove errors option -> RED (T2 at log regex line 195; T3 failure test) in copy $TMPDIR/slota-r1-MvbF
- mutation: git-error-detection.test.js, M1 + test copy without the log assertion -> RED at T2 stagedPaths (line 196) in copy $TMPDIR/slota-r1-MvbF
- mutation: git-error-detection.test.js, M2 no fallback -> RED (T2 log regex) in copy $TMPDIR/slota-r1-MvbF
- mutation: git-error-detection.test.js, M3 no stdOut -> GREEN (covered only by the unit test) in copy $TMPDIR/slota-r1-MvbF
- mutation: git-error-detection.test.js, M4 remove reset in moderate-delete failure path -> RED at stagedPaths assertion (line 252; status and code passed) in copy $TMPDIR/slota-r1-MvbF
- mutation: git-error-detection.test.js, M5 rethrow instead of record -> RED at body.code (line 250) in copy $TMPDIR/slota-r1-MvbF
- mutation: git-error-detection.test.js, M5b rethrow + outer catch answering code git_commit_failed -> RED at state.json history assertion (line 255) in copy $TMPDIR/slota-r1-MvbF
- mutation: git-error-detection.test.js, M9 remove delete-branch saveState() -> RED at state.json assertion (line 255) in copy $TMPDIR/slota-r1-MvbF
- mutation: git-error-detection.test.js, M6 swallow -> RED (500 expected, 200 actual) in copy $TMPDIR/slota-r1-MvbF
- mutation: git-error-detection.test.js, M7 guard refusal sets commitError -> RED (guard-refusal test, 200 expected, 500 actual) in copy $TMPDIR/slota-r1-MvbF
- mutation: git-index-confinement.test.js, M7 -> RED, 8 tests in copy $TMPDIR/slota-r1-MvbF
- mutation: git-error-detection.test.js, M10 untracked branch proceeds to add/commit -> RED (never-committed test, 200 expected, 500 actual) in copy $TMPDIR/slota-r1-MvbF
- mutation: git-error-detection.test.js, M11 commitError 500 before moderation.save/broadcast -> GREEN in copy $TMPDIR/slota-r1-MvbF
- mutation: git-error-detection.test.js, M12 detector replaces every message with the exit-code fallback -> RED at T2 "hook says no" (only) in copy $TMPDIR/slota-r1-MvbF
- mutation: git-error-detection.test.js, M13 tracked check always false -> RED (T3 failure, T3 normal); guard-refusal test GREEN in copy $TMPDIR/slota-r1-MvbF
- mutation: git-index-confinement.test.js, M13 -> RED (tests 3,4,8,12; test 3 at :315 guard-specific log) in copy $TMPDIR/slota-r1-MvbF
- mutation: git-error-detection.test.js, M14 remove untracked warn -> GREEN in copy $TMPDIR/slota-r1-MvbF
- mutation: git-error-detection.test.js, M8a/M8b/M8c remove GIT_OBJECT_DIRECTORY/GIT_COMMON_DIR/GIT_QUARANTINE_PATH delete -> RED, each exactly its own test (500 instead of 200) in copy $TMPDIR/slota-r1-MvbF
- could-not-run: full suite 428/0 -> excluded by instruction (Step 1 already ran it)
- ran: git status --short before/after -> unchanged; copy removed; no leftover aibuilds-git-error-* temp dirs

## DoD round 2 (delta)

- Slot A (Claude Opus, executing) — `## VERDICT` PASS (0/0/5).
- Slot B (GLM `glm-5.3:cloud`, reading) — `## VERDICT` PASS (0/0/8).

Accepted INFO, not changed: a tracked path flagged `assume-unchanged` stages nothing on `git add`
and answers 200 without a commit (same as before this change; the server never sets the flag);
the order save/broadcast → 500 is correct but not asserted; the nothing-to-commit skip is not logged.

### Slot A round 2 — EVIDENCE
- ran: node --test test/git-error-detection.test.js (copy, unmutated) -> 9 pass / 0 fail
- ran: node --test test/git-index-confinement.test.js (copy, unmutated) -> 12 pass / 0 fail
- ran: node --test test/git-errors.test.js (copy, unmutated) -> 6 pass / 0 fail
- mutation: git-error-detection.test.js, MA staged check removed (unconditional commit) -> RED, only test 6 "path staged only as an addition"; log shows "Moderation removal commit failed: … nichts zum Commit vorgemerkt" (500 path), in copy $TMPDIR/slota-r2-xLYN
- mutation: git-error-detection.test.js, MB untracked warn removed -> RED, only test 5 "never-committed target", in copy $TMPDIR/slota-r2-xLYN
- mutation: git-error-detection.test.js, MC tracked check always false (ls-files replaced by a rejection) -> RED tests 2,3,4,6; test 3 (guard refusal) now RED on its own at :260: input did not match /…refusing pathspec-less commit/, in copy $TMPDIR/slota-r2-xLYN
- mutation: git-error-detection.test.js, MD staged check always false -> RED tests 2 and 4 (tracked deletion must commit), in copy $TMPDIR/slota-r2-xLYN
- recomputed: git 2.55.0 temp repo, tracked file with assume-unchanged, unlinked, `git add -- :(literal)a.html` -> rc=0, `diff --cached --name-only` empty
- recomputed: same repo, skip-worktree file -> `git add` rc=1 with sparse-checkout message on stderr, staged empty
- recomputed: `:494` shim reachability -> assertIndexConfinedTo → stagedIndexPaths runs `diff --cached` via execFile, which fails first, so the new call is unreachable
- recomputed: F-001 grep `GIT_DIR|GIT_OBJECT_DIRECTORY|GIT_COMMON_DIR|GIT_QUARANTINE_PATH|GIT_INDEX_FILE|process.env.GIT` over server/ -> only the deletes, comments and the :927 per-call extraEnv; `worker_threads` -> no hits
- recomputed: F-002 bootstrap commit location -> server/index.js:5134 inside try, catch (e2) at :5136
- ran: diff of original index.js after every mutation -> restored; copy removed; `git status --short` before/after -> unchanged
