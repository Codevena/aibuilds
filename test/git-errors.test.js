'use strict';

// Guards `server/git-errors.js`'s `failOnNonZeroExit`, the simple-git `errors` detector installed on
// the World git instance (`server/index.js`). simple-git@3.36.0 treats a command as failed only when
// `exitCode && stdErr.length` (`node_modules/simple-git/dist/cjs/index.js:1350`); a silent failing
// hook (exit != 0, empty stderr) resolves as success without this detector. See §0 of
// docs/superpowers/plans/2026-09-24-git-error-detection.md.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const simpleGit = require('simple-git');
const { failOnNonZeroExit } = require('../server/git-errors');

const execFileAsync = promisify(execFile);

function result({ exitCode = 0, stdOut = [], stdErr = [] } = {}) {
  return { exitCode, stdOut, stdErr };
}

test('an existing error passes through unchanged', () => {
  const existingError = new Error('pre-existing task error');
  const returned = failOnNonZeroExit(existingError, result({ exitCode: 1, stdErr: [Buffer.from('x')] }));
  assert.equal(returned, existingError, 'the detector must never replace an error the pipeline already produced');
});

test('exit code 0 produces no error', () => {
  const returned = failOnNonZeroExit(undefined, result({ exitCode: 0 }));
  assert.equal(returned, undefined);
});

test('exit code 1 with stderr carries the stderr text verbatim', () => {
  const returned = failOnNonZeroExit(undefined, result({
    exitCode: 1, stdErr: [Buffer.from('hook says no')],
  }));
  assert.ok(Buffer.isBuffer(returned), 'the errors config must return a Buffer for simple-git to wrap');
  assert.match(returned.toString('utf8'), /hook says no/);
});

test('exit code 1 with stdout only carries the stdout text', () => {
  // Without `...result.stdOut` in the concat this collapses to the empty-output fallback instead of
  // the stdout text — RED per plan §T1.
  const returned = failOnNonZeroExit(undefined, result({
    exitCode: 1, stdOut: [Buffer.from('nothing to commit')],
  }));
  assert.ok(Buffer.isBuffer(returned));
  assert.match(returned.toString('utf8'), /nothing to commit/);
});

test('exit code 1 with no output falls back to a message naming the exit code', () => {
  // Without the fallback branch this is an empty Buffer/empty message — RED per plan §T1.
  const returned = failOnNonZeroExit(undefined, result({ exitCode: 1 }));
  assert.ok(Buffer.isBuffer(returned));
  assert.match(returned.toString('utf8'), /exited with code 1/);
});

test('a real git commit with nothing staged rejects under the detector, resolves without it', async (t) => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'aibuilds-git-errors-'));
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  const plainGit = simpleGit(repo);
  await plainGit.init();
  // R1-F5: pin core.hooksPath to an empty directory as REPOSITORY config, not `git -c` — the
  // developer's global gitleaks hook writes to stderr, which would make the "without" side reject
  // too and the test vacuous.
  const emptyHooksDir = path.join(repo, '.git', 'empty-hooks');
  await fs.mkdir(emptyHooksDir, { recursive: true });
  // simple-git's own addConfig refuses core.hooksPath (`allowUnsafeHooksPath`) — set it via a plain
  // git invocation instead, as REPOSITORY config, exactly as test/git-index-confinement.test.js does.
  await execFileAsync('git', ['config', 'core.hooksPath', emptyHooksDir], { cwd: repo });
  await plainGit.addConfig('user.email', 'test@example.invalid');
  await plainGit.addConfig('user.name', 'Git Errors Test');

  // WITHOUT the detector: nothing staged, `git commit` exits non-zero with the "nothing to commit"
  // text on STDOUT (empty stderr) — simple-git's default isTaskError (exitCode && stdErr.length) is
  // false, so this resolves.
  await assert.doesNotReject(() => plainGit.commit('nothing staged, no detector'));

  // WITH the detector: the same repo state rejects.
  const guardedGit = simpleGit(repo, { errors: failOnNonZeroExit });
  await assert.rejects(guardedGit.commit('nothing staged, with detector'));
});
