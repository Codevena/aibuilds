'use strict';

// Regression coverage for the Git error-detection work (docs/superpowers/plans/2026-09-24-git-error-
// detection.md, T2-T4). T1 (server/git-errors.js) makes simple-git reject a Git child that exits
// non-zero even with empty stderr; T2 pins that a silent pre-commit hook is now caught as a rejection
// on the quarantine-reject path instead of silently resolving. T3 makes the legacy moderate-delete
// route report a failed commit honestly (500) while a guard REFUSAL still answers 200 as it always
// has. T4 drops the remaining ambient Git environment variables at startup.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFile, execFileSync } = require('node:child_process');
const { promisify } = require('node:util');
const { once } = require('node:events');

const execFileAsync = promisify(execFile);
const NUL = String.fromCharCode(0);

// Same anchor as test/git-index-confinement.test.js: the trailing \s matters (a truncated stdout
// chunk must not match a truncated port number, and the first match wins).
const SERVER_PORT_PATTERN = /Server:\s+http:\/\/localhost:(\d+)\s/;

async function waitForServer(child, logs) {
  const deadline = Date.now() + 12_000;
  let baseUrl = null;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Server exited early:\n${logs.join('')}`);
    if (!baseUrl) {
      const match = logs.join('').match(SERVER_PORT_PATTERN);
      if (match) baseUrl = `http://127.0.0.1:${match[1]}`;
    }
    if (baseUrl) {
      try {
        if ((await fetch(`${baseUrl}/api/stats`, { signal: AbortSignal.timeout(1000) })).ok) {
          return baseUrl;
        }
      } catch { /* retry */ }
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Server did not start:\n${logs.join('')}`);
}

async function requestJson(baseUrl, requestPath, options = {}) {
  const response = await fetch(baseUrl + requestPath, {
    ...options,
    headers: {
      'CF-Connecting-IP': '203.0.113.9',
      ...(options.headers || {}),
    },
  });
  let body;
  try { body = await response.json(); } catch { body = null; }
  return { response, body };
}

function adminPost(baseUrl, requestPath, body) {
  return requestJson(baseUrl, requestPath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.51.100.9' },
    body: JSON.stringify(body),
  });
}

async function contribute(baseUrl, payload) {
  const challenge = await requestJson(baseUrl, '/api/challenge');
  assert.equal(challenge.response.status, 200);
  return requestJson(baseUrl, '/api/contribute', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Challenge-Id': challenge.body.id,
      'X-Challenge-Nonce': '0',
    },
    body: JSON.stringify({ agent_name: 'GitErrorAgent', message: 'test contribution', ...payload }),
  });
}

// Boots a server on an isolated World repo, pinning core.hooksPath/core.quotePath as REPOSITORY
// config (R1-F5 / hard rule: a global core.hooksPath would make every hook-based injection below
// wirkungslos and the guard tests vacuous).
async function startWorld(t, {
  files = {}, riskyAfterSeed = {}, adminSecret = 'operator-secret', extraEnv = {},
} = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aibuilds-git-error-detection-'));
  const worldDir = path.join(root, 'world');
  const dataDir = path.join(root, 'data');
  const hooksDir = path.join(worldDir, '.git', 'hooks');
  await fs.mkdir(path.join(worldDir, 'pages'), { recursive: true });
  await fs.mkdir(path.join(worldDir, 'sections'), { recursive: true });
  await fs.mkdir(dataDir, { recursive: true });
  for (const [relPath, content] of Object.entries(files)) {
    await fs.writeFile(path.join(worldDir, relPath), content);
  }

  const git = (...args) => execFileAsync('git', args, { cwd: worldDir, encoding: 'utf8' });
  await execFileAsync('git', ['init'], { cwd: worldDir });
  await git('config', 'user.email', 'test@example.invalid');
  await git('config', 'user.name', 'Git Error Detection Test');
  await git('config', 'core.hooksPath', hooksDir);
  await git('config', 'core.quotePath', 'true');
  await git('add', '.');
  // --allow-empty: some cases (T3/T4) seed no files at all and create their target through
  // POST /api/contribute at runtime, so the seed commit itself may have nothing staged.
  await git('commit', '--allow-empty', '-m', 'seed world');
  for (const [relPath, content] of Object.entries(riskyAfterSeed)) {
    await fs.writeFile(path.join(worldDir, relPath), content);
  }

  const logs = [];
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: '0',
      POW_DIFFICULTY: '0',
      ADMIN_RESET_SECRET: adminSecret,
      AIBUILDS_WORLD_DIR: worldDir,
      AIBUILDS_DATA_DIR: dataDir,
      AIBUILDS_BACKUP_DIR: path.join(root, 'backups'),
      CLIENT_IP_MODE: 'cloudflare',
      TRUSTED_PROXY_CIDRS: '127.0.0.1/32,::1/128',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', chunk => logs.push(chunk.toString()));
  child.stderr.on('data', chunk => logs.push(chunk.toString()));
  // Single t.after hook: kill -> wait for exit -> rm. node:test runs t.after in FIFO order; a
  // separate rm hook can race the still-writing server and hit ENOTEMPTY (NEXT_SESSION.md #10).
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGTERM');
    if (child.exitCode === null) await once(child, 'exit');
    await fs.rm(root, { recursive: true, force: true });
  });
  const baseUrl = await waitForServer(child, logs);

  const stagedPaths = async () => (await git('diff', '--cached', '--name-only', '-z'))
    .stdout.split(NUL).filter(Boolean);
  const headSubject = async () => (await git('log', '-1', '--pretty=%s')).stdout.trim();
  const inHeadTree = async relPath =>
    (await git('ls-tree', 'HEAD', '--', `:(literal)${relPath}`)).stdout.trim() !== '';

  return { root, worldDir, dataDir, hooksDir, baseUrl, logs, git, stagedPaths, headSubject, inHeadTree };
}

async function installHook(world, script) {
  await fs.mkdir(world.hooksDir, { recursive: true });
  const hookPath = path.join(world.hooksDir, 'pre-commit');
  await fs.writeFile(hookPath, script);
  await fs.chmod(hookPath, 0o755);
}

async function removeHook(world) {
  await fs.rm(path.join(world.hooksDir, 'pre-commit'), { force: true });
}

const RISKY_CONTENT = '<p>Invest 80% of your savings in this token.</p>';
const SAFE_CONTENT = relPath =>
  `<div data-page-title="Safe"><p>Harmlose Seite ${relPath}.</p></div>`;

// ---------------------------------------------------------------------------------------------
// T2 - silent-hook regression on the quarantine-reject path
// ---------------------------------------------------------------------------------------------

test('a silent failing pre-commit hook on quarantine reject is caught as a rejection, not resolved', async (t) => {
  const trackedRisky = 'pages/TrackedRisky.html';
  const untrackedRisky = 'pages/UntrackedRisky.html';
  const world = await startWorld(t, {
    files: { [trackedRisky]: RISKY_CONTENT },
    riskyAfterSeed: { [untrackedRisky]: RISKY_CONTENT },
  });

  // Setup (R1-F7): the tracked risky page must be quarantined AND stay in HEAD - if it were rolled
  // back (untracked) this test would not exercise the "tracked" branch of the reject handler at all.
  const listed = await requestJson(world.baseUrl, '/api/admin/quarantine',
    { headers: { 'X-Admin-Secret': 'operator-secret' } });
  assert.equal(listed.response.status, 200, world.logs.join(''));
  const quarantinedPaths = listed.body.quarantined.map(r => r.path);
  assert.ok(quarantinedPaths.includes(trackedRisky), 'setup: the tracked risky page must be quarantined');
  assert.ok(quarantinedPaths.includes(untrackedRisky), 'setup: the untracked risky page must be quarantined');
  assert.equal(await world.inHeadTree(trackedRisky), true,
    'setup: the tracked risky page must still be part of HEAD, not rolled back');

  // Step 1: silent failing hook (exit 1, no output at all) on the TRACKED page.
  await installHook(world, '#!/bin/sh\nexit 1\n');
  const subjectBeforeTracked = await world.headSubject();
  const trackedReject = await adminPost(world.baseUrl, '/api/admin/quarantine/reject',
    { secret: 'operator-secret', path: trackedRisky });
  assert.equal(trackedReject.response.status, 500, world.logs.join(''));
  // G3: the log must name the exit code, not just "commit was not created".
  assert.match(world.logs.join(''), /exited with code 1/,
    'the rejected commit\'s message must survive into the route\'s error log');
  // G2: a failed commit must leave no staged entry for its path.
  assert.deepEqual(await world.stagedPaths(), [],
    'the failed reject must not leave a staged deletion behind');
  assert.equal(await world.headSubject(), subjectBeforeTracked, 'no commit may have been created');

  // Step 2 (F4 - must come directly after step 1, before the stderr-hook step, which resets the
  // index itself on either side): remove the hook and reject the UNTRACKED quarantined page. With
  // T1's cleanup in place the index is clean, so this pathspec-less commit succeeds.
  await removeHook(world);
  const untrackedReject = await adminPost(world.baseUrl, '/api/admin/quarantine/reject',
    { secret: 'operator-secret', path: untrackedRisky });
  assert.equal(untrackedReject.response.status, 200, world.logs.join(''));
  assert.equal(await world.inHeadTree(trackedRisky), true,
    'the tracked risky page must remain in the HEAD tree - only its reject failed, not the file');

  // Step 3: the tracked page's quarantine record is still there (moderation.reject never ran after
  // the 500 above) - reject it again, this time with a hook that prints to stderr and exits 1. Both
  // with and without T1 this must answer 500 with the verbatim hook text in the log; the only thing
  // T1 changes is that an EMPTY-stderr hook is now also caught.
  await installHook(world, "#!/bin/sh\necho 'hook says no' >&2\nexit 1\n");
  const verbatimReject = await adminPost(world.baseUrl, '/api/admin/quarantine/reject',
    { secret: 'operator-secret', path: trackedRisky });
  assert.equal(verbatimReject.response.status, 500, world.logs.join(''));
  assert.match(world.logs.join(''), /hook says no/,
    'a hook that DOES write stderr must still have its message logged verbatim');
});

// ---------------------------------------------------------------------------------------------
// T3 - legacy moderate delete: honest failure, guard refusal unchanged
// ---------------------------------------------------------------------------------------------

test('moderate delete reports a failed commit honestly after a passed guard', async (t) => {
  const target = 'pages/Doomed.html';
  const world = await startWorld(t, { files: {} });

  const created = await contribute(world.baseUrl, {
    action: 'create', file_path: target, content: SAFE_CONTENT(target),
  });
  assert.equal(created.response.status, 200, world.logs.join(''));
  const contributionId = created.body.contribution.id;
  // state.json persists contributions as `history` entries, not as a `contributions` map. The
  // precondition proves the post-condition below can see the id at all - without it a wrong key
  // makes the purge assertion pass unconditionally (measured: a lookup in `state.contributions`
  // stayed green with the delete branch's saveState() removed).
  const readHistoryIds = async () => JSON.parse(
    await fs.readFile(path.join(world.dataDir, 'state.json'), 'utf8')).history.map(entry => entry.id);
  assert.ok((await readHistoryIds()).includes(contributionId),
    'setup: the created contribution must be persisted in state.json before the moderation');

  await installHook(world, '#!/bin/sh\nexit 1\n');
  const moderated = await adminPost(world.baseUrl, '/api/admin/moderate',
    { secret: 'operator-secret', action: 'delete', target });
  assert.equal(moderated.response.status, 500, world.logs.join(''));
  assert.equal(moderated.body.code, 'git_commit_failed');

  assert.deepEqual(await world.stagedPaths(), [],
    'the reset after a failed commit must leave no staged entry for the deleted path');

  assert.equal((await readHistoryIds()).includes(contributionId), false,
    'the contribution must still be purged from state.json even though the Git commit failed - ' +
    'saveState()/moderation.save()/broadcast all ran before the 500 was decided');
});

test('moderate delete still answers 200 when a guard refusal blocks the commit', async (t) => {
  // Companion to the confinement suite's own moderate-delete refusal test: pins that T3 did not turn
  // guard refusals into 500s (F1). A foreign staged deletion makes assertIndexConfinedTo refuse.
  const victim = 'pages/Victim.html';
  const doomed = 'pages/Doomed.html';
  const world = await startWorld(t, {
    files: { [victim]: SAFE_CONTENT(victim), [doomed]: SAFE_CONTENT(doomed) },
  });
  await fs.unlink(path.join(world.worldDir, victim));
  await world.git('add', '-u', '--', `:(literal)${victim}`);
  assert.deepEqual(await world.stagedPaths(), [victim], 'setup: index must hold the foreign path');
  const subjectBefore = await world.headSubject();

  const moderated = await adminPost(world.baseUrl, '/api/admin/moderate',
    { secret: 'operator-secret', action: 'delete', target: doomed });
  assert.equal(moderated.response.status, 200, world.logs.join(''));
  assert.equal(await world.headSubject(), subjectBefore, 'a guard refusal must not commit');
  // The guard's own wording, not just the shared prefix: the untracked branch logs the same prefix,
  // so the prefix alone would stay green if the tracked check misfired on this tracked target.
  assert.match(world.logs.join(''),
    /Moderation removal commit skipped: Moderation removal commit: refusing pathspec-less commit/);
});

test('moderate delete commits normally when the guard passes and the commit succeeds', async (t) => {
  const target = 'pages/Doomed.html';
  const world = await startWorld(t, { files: {} });
  const created = await contribute(world.baseUrl, {
    action: 'create', file_path: target, content: SAFE_CONTENT(target),
  });
  assert.equal(created.response.status, 200, world.logs.join(''));

  const moderated = await adminPost(world.baseUrl, '/api/admin/moderate',
    { secret: 'operator-secret', action: 'delete', target });
  assert.equal(moderated.response.status, 200, world.logs.join(''));
  assert.equal(await world.headSubject(), `moderation: remove ${target}`);
});

test('moderate delete on a never-committed target still answers 200 and leaves HEAD unchanged', async (t) => {
  const untracked = 'pages/NeverCommitted.html';
  const world = await startWorld(t, {
    files: {}, riskyAfterSeed: { [untracked]: SAFE_CONTENT(untracked) },
  });
  const subjectBefore = await world.headSubject();

  const moderated = await adminPost(world.baseUrl, '/api/admin/moderate',
    { secret: 'operator-secret', action: 'delete', target: untracked });
  assert.equal(moderated.response.status, 200, world.logs.join(''));
  assert.equal(await world.headSubject(), subjectBefore, 'an untracked target commits nothing');
  assert.match(world.logs.join(''),
    /Moderation removal commit skipped: pages\/NeverCommitted\.html is not tracked \(/,
    'the untracked branch must say why it skipped, including the ls-files cause');
});

test('moderate delete of a path staged only as an addition answers 200, not a false commit failure', async (t) => {
  // Own path staged as an ADD, never committed, nothing foreign in the index. The unlink plus
  // `git add` turns the index back into HEAD, so there is nothing left to commit; `git commit`
  // then exits 1 with "nothing to commit" on stdout. Before the errors detector simple-git resolved
  // that silently (200); with it, the moderation would report git_commit_failed for a deletion that
  // fully succeeded. Measured: 500 without the staged-diff check, 200 with it.
  const ghost = 'pages/Ghost.html';
  const world = await startWorld(t, { files: {} });
  await fs.writeFile(path.join(world.worldDir, ghost), SAFE_CONTENT(ghost));
  await world.git('add', '--', `:(literal)${ghost}`);
  assert.deepEqual(await world.stagedPaths(), [ghost], 'setup: own path staged as an addition only');
  const subjectBefore = await world.headSubject();

  const moderated = await adminPost(world.baseUrl, '/api/admin/moderate',
    { secret: 'operator-secret', action: 'delete', target: ghost });
  assert.equal(moderated.response.status, 200, world.logs.join(''));
  assert.equal(await world.headSubject(), subjectBefore, 'nothing to commit, so no commit');
  assert.deepEqual(await world.stagedPaths(), [], 'the addition is gone from the index');
  await assert.rejects(fs.access(path.join(world.worldDir, ghost)));
});

// ---------------------------------------------------------------------------------------------
// T4 - drop the remaining ambient Git environment variables at startup (D4)
// ---------------------------------------------------------------------------------------------

for (const varName of ['GIT_OBJECT_DIRECTORY', 'GIT_COMMON_DIR', 'GIT_QUARANTINE_PATH']) {
  test(`an ambient ${varName} does not survive into the World git child`, async (t) => {
    const target = 'pages/Fresh.html';
    const bogusDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aibuilds-git-error-detection-env-'));
    t.after(() => fs.rm(bogusDir, { recursive: true, force: true }));
    const world = await startWorld(t, { files: {}, extraEnv: { [varName]: bogusDir } });

    const created = await contribute(world.baseUrl, {
      action: 'create', file_path: target, content: SAFE_CONTENT(target),
    });
    assert.equal(created.response.status, 200, world.logs.join(''));
    const expectedSubject = `[GitErrorAgent] create: ${target}`;
    assert.equal(await world.headSubject(), expectedSubject,
      `an ambient ${varName} must not stop the World git child from committing`);
  });
}
