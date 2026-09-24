# Git error detection and follow-ups — implementation plan

Date: 2026-09-24 · Base: `main` = `1ebe4be` (local, not pushed) · Path: **High-Assurance**
(persistence/Git behaviour of every simple-git call, verification machinery).

Predecessor: Brain plan "AiBuilds Git-Fehlererkennung — Plan und Gate-Protokoll 2026-09-04"
(two gate rounds). Its Task 6 (consumer guard `assertIndexConfinedTo`) shipped in `ef96631`. This
plan re-derives the remaining tasks against the current tree; all line numbers below are measured
at `1ebe4be`.

Owner decisions taken under the standing instruction of 2026-09-23 ("follow your professional
recommendation"): D1 `moderate action=delete` reports a failed Git commit honestly (500), D2
Unicode comparison in `assertIndexConfinedTo` stays byte-exact, D3 `queueGitOperation` wrapping at
the moderate site stays, D4 the three remaining Git environment variables are dropped at startup.

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
  (untracked, e.g. quarantined-only), `git add` exits 128 with stderr today → caught → 200: that is
  the correct outcome for an untracked file and must stay 200.
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
  `GIT_COMMON_DIR`, `GIT_QUARANTINE_PATH` from the server environment.

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
rejects (without the option it resolves).

### T2 — silent-hook regression in the reject path (`test/git-error-detection.test.js`, new)

Spawned server over a pre-initialized World repo with `core.hooksPath` pinned (pattern of
`test/git-index-confinement.test.js`). Quarantine a tracked page (contribute risky content → quarantined
record), install a SILENT failing pre-commit hook (`exit 1`, no output), reject it:
- response 500; server log contains `exited with code 1` (G3) · without T1: log shows
  `Git rejection commit was not created`, not the exit code.
- `git diff --cached --name-only` is empty afterwards (G2) · without T1: lists the path.
- hook replaced by one that prints `hook says no` to stderr and exits 1 → 500 and the log contains
  `hook says no` verbatim (both with and without T1 — the separation is the verbatim text; a handler
  that replaces every message would turn it RED).
- remove the hook, reject a second, untracked quarantined path → 200, and the first (still
  quarantined, tracked) page remains in the HEAD tree (`git ls-tree HEAD -- <path>` non-empty).

### T3 — moderate delete: honest failure (D1)

`server/index.js` moderate delete branch, inside the existing `queueGitOperation`:
determine `tracked` with `git.raw(['ls-files', '--error-unmatch', '--', pathspec])` (catch → false).
Untracked → no Git operation, behaviour unchanged (200). Tracked → `assertIndexConfinedTo` →
`git.add` → `git.commit`; on failure `git.raw(['reset', '--', pathspec])` (catch-and-keep original)
and rethrow; the route's outer catch answers 500 `{ error: 'Moderation removal commit failed', code:
'git_commit_failed' }` after the disk deletion and state changes already happened (the response says
so in `detail`). Tests: tracked + silent failing hook → 500 with that code and index clean; tracked
normal → 200 and `git log -1 --format=%s` = `moderation: remove <path>`; untracked target → 200 and
HEAD unchanged · without T3: the failing case answers 200.

### T4 — drop remaining Git environment variables (D4)

`server/index.js` next to `:138-140`: also `delete process.env.GIT_OBJECT_DIRECTORY;`,
`delete process.env.GIT_COMMON_DIR;`, `delete process.env.GIT_QUARANTINE_PATH;` with one comment
line. Test (spawned server, env `GIT_OBJECT_DIRECTORY=<empty temp dir>`): a published contribution
succeeds and `git -C <world> cat-file -e HEAD` succeeds using the repo's own object store · without
T4: objects are written to the temp dir, `cat-file` in the repo fails (measure both).

### T5 — `waitForServer` per-attempt timeout (test infrastructure)

Add `{ signal: AbortSignal.timeout(1000) }` to the probe `fetch` in the five files listed in §0,
exactly as in `test/git-index-confinement.test.js:45`. No behaviour change in the server. Evidence:
full suite green 3× in a row; no guard test (a hanging probe is not deterministically constructible).

### T6 — verification

`node --check`; full suite (rc captured separately); mutation runs in a copy: remove `errors`
option; remove fallback text; remove `...result.stdOut`; remove the reset in T3; remove each T4
delete; T3 revert to swallow → every guarding test RED. Report any GREEN mutation.

## 3. Rollback

T1 is one constructor option (one-line revert); T3/T4 are local. No data format change.

## Findings mapping

(appended per gate round)

### Round 1 (executing Opus reviewer, 2026-09-24) — FAIL: 2 CRITICAL, 4 WARN, 5 INFO — NOT yet incorporated

Deferred to the next session by owner decision (2026-09-24). Incorporate all before round 2:

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
