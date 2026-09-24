'use strict';

// simple-git@3.36.0 treats a command as failed only when `exitCode && stdErr.length`
// (node_modules/simple-git/dist/cjs/index.js:1350). A pre-commit hook that exits non-zero with EMPTY
// stderr therefore resolves as success — Git rejects the commit, but the caller never sees a
// rejection. Installed as the constructor's `errors` option
// (node_modules/simple-git/dist/cjs/index.js:4736), this detector treats
// ANY non-zero exit as a failure, whether or not stderr is non-empty, and always returns a non-empty
// message: hook output verbatim when present, otherwise a fallback naming the exit code.
function failOnNonZeroExit(error, result) {
  if (error) return error;
  if (!result.exitCode) return error;
  const output = Buffer.concat([...result.stdOut, ...result.stdErr]);
  return output.length ? output : Buffer.from(`git exited with code ${result.exitCode} without output`);
}

module.exports = { failOnNonZeroExit };
