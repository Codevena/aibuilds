'use strict';

// A `git commit` WITHOUT a pathspec commits the entire index — including whatever an unrelated code
// path left staged there. Measured against e9021cf, all three consumers leaked: a PoW-only
// /api/contribute delete on an untracked path made a foreign public file vanish from the HEAD tree
// under the contributor's own subject line. These tests guard the consumer-side check that refuses
// such a commit; the producers of a dirty index are not enumerable, the consumers are.

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

// Reads the bound port from the server's own startup banner instead of reserving one up front.
// The trailing \s matters: without it a stdout chunk ending mid-number matches a TRUNCATED port,
// and since the first match is cached that is terminal - the test then fails as a connection
// timeout while the log shows the correct banner. Self-camouflaging, so anchor on the padding.
const SERVER_PORT_PATTERN = /Server:\s+http:\/\/localhost:(\d+)\s/;

async function waitForServer(child, logs) {
  // 12s rather than 10s: these harnesses start the server with pre-populated git history, so
  // loadState and auditWorldForQuarantine run during startup.
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
        // Per-attempt timeout, without which the deadline above is decorative: fetch has none of
        // its own, so a single hung probe blocks the loop past the deadline and the failure
        // surfaces minutes later as "Server did not start". Measured once at 301s under a full
        // parallel suite run, green on the re-run. The other four copies of this helper share the
        // gap; this file starts eleven servers, so it is the one that trips over it.
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
  const response = await fetch(baseUrl + requestPath, options);
  let body;
  try { body = await response.json(); } catch { body = null; }
  return { response, body };
}

// Boots a server on an isolated World repo. `seed` receives the git helper and the world dir after
// the initial commit, so each case can install the exact index state it needs.
async function startWorld(t, {
  files, riskyAfterSeed = {}, adminSecret = 'operator-secret', gitRootAboveWorld = false,
  extraEnv = {}, seed = null,
}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aibuilds-index-confinement-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  // gitRootAboveWorld reproduces a plain clone: world/ is tracked by the project repo and has no
  // .git of its own, so git reports every path prefixed with "world/" while the server addresses
  // them relative to WORLD_DIR. The data dir stays outside that repo so the seed commit cannot
  // pick it up.
  const projectDir = gitRootAboveWorld ? path.join(root, 'project') : root;
  const worldDir = path.join(projectDir, 'world');
  const dataDir = path.join(root, 'data');
  await fs.mkdir(path.join(worldDir, 'pages'), { recursive: true });
  await fs.mkdir(path.join(worldDir, 'sections'), { recursive: true });
  await fs.mkdir(dataDir, { recursive: true });
  for (const [relPath, content] of Object.entries(files)) {
    await fs.writeFile(path.join(worldDir, relPath), content);
  }

  const gitRoot = gitRootAboveWorld ? projectDir : worldDir;
  // cwd stays the World dir even when the repo root is above it — that is exactly how the server
  // runs git, and it is what makes the path-prefix mismatch observable.
  const git = (...args) => execFileAsync('git', args, { cwd: worldDir, encoding: 'utf8' });
  await execFileAsync('git', ['init'], { cwd: gitRoot });
  await git('config', 'user.email', 'test@example.invalid');
  await git('config', 'user.name', 'Index Confinement Test');
  // A core.hooksPath in the developer's global Git config replaces .git/hooks outright; pinning it
  // keeps each throwaway repo hermetic whatever the host is set to.
  await git('config', 'core.hooksPath', path.join(gitRoot, '.git', 'hooks'));
  // core.quotePath is what makes the -z in stagedIndexPaths load-bearing: under a global
  // core.quotePath=false the non-ASCII case below would pass without -z and its mutation would go
  // green. Same class of silently-disarmed assumption as core.hooksPath above.
  await git('config', 'core.quotePath', 'true');
  await git('add', '.');
  await git('commit', '-m', 'seed world');
  // Files written after the seed commit stay untracked, which is what drives the pathspec-less
  // branch (a delete on an untracked path stages nothing).
  for (const [relPath, content] of Object.entries(riskyAfterSeed)) {
    await fs.writeFile(path.join(worldDir, relPath), content);
  }

  // seed() runs after the seed commit and before the server starts, and may return env additions -
  // some cases need a path that only exists once the temp root has been created.
  const seedEnv = (seed ? await seed({ root, projectDir, worldDir, git }) : null) || {};

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
      ...extraEnv,
      ...seedEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', chunk => logs.push(chunk.toString()));
  child.stderr.on('data', chunk => logs.push(chunk.toString()));
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGTERM');
    if (child.exitCode === null) await once(child, 'exit');
  });
  const baseUrl = await waitForServer(child, logs);

  const stagedPaths = async () => (await git('diff', '--cached', '--name-only', '-z'))
    .stdout.split(NUL).filter(Boolean);
  const headSubject = async () => (await git('log', '-1', '--pretty=%s')).stdout.trim();
  const inHeadTree = async relPath =>
    (await git('ls-tree', 'HEAD', '--', `:(literal)${relPath}`)).stdout.trim() !== '';

  return { root, worldDir, dataDir, baseUrl, logs, git, stagedPaths, headSubject, inHeadTree };
}

// Stages the deletion of a path the caller does not own — exactly what a moderation commit that
// died on a silent pre-commit hook leaves behind (simple-git scores exit!=0 with empty stderr as
// success, so the compensating reset never runs).
async function stageForeignDeletion(world, relPath) {
  await fs.unlink(path.join(world.worldDir, relPath));
  await world.git('add', '-u', '--', `:(literal)${relPath}`);
  assert.deepEqual(await world.stagedPaths(), [relPath], 'setup: index must hold the foreign path');
}

// Puts an entry into the index directly, bypassing the filesystem entirely. Needed for the two
// shapes a working tree cannot hold: a path whose bytes are not valid UTF-8, and an NFC/NFD twin
// pair on a normalisation-insensitive filesystem such as APFS.
// execFileSync, not the promisified execFile: only the sync form accepts `input`, and the async
// one leaves stdin open so `update-index --index-info` waits on it forever.
function stageRawIndexEntry(world, rawPath, { content = 'fremd', mode = '100644' } = {}) {
  const object = mode === '160000'
    // A gitlink needs a real object id (git rejects a null sha1 outright); the World repo's own
    // HEAD serves, since nothing ever resolves it.
    ? execFileSync('git', ['rev-parse', 'HEAD'], { cwd: world.worldDir, encoding: 'utf8' }).trim()
    : execFileSync('git', ['hash-object', '-w', '--stdin'],
      { cwd: world.worldDir, input: content, encoding: 'utf8' }).trim();
  const record = Buffer.concat([
    Buffer.from(`${mode} ${object}\t`), rawPath, Buffer.from([0x00]),
  ]);
  execFileSync('git', ['update-index', '-z', '--index-info'],
    { cwd: world.worldDir, input: record });
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
    body: JSON.stringify({ agent_name: 'DeleterAgent', message: 'raeumt auf', ...payload }),
  });
}

function adminPost(baseUrl, requestPath, body) {
  return requestJson(baseUrl, requestPath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.100.9' },
    body: JSON.stringify(body),
  });
}

const VICTIM = 'pages/PublicPage.html';
const VICTIM_BYTES = '<div data-page-title="Public"><p>Eine oeffentliche Seite.</p></div>';

test('a contribution delete on an untracked path never commits a foreign staged deletion', async (t) => {
  // Mutations caught: guard call removed at the _gitCommitImpl else branch (T1b + T1c red),
  // guard neutralised to never throw (same), guard made to always throw (T1a red).
  const world = await startWorld(t, {
    files: { [VICTIM]: VICTIM_BYTES },
    riskyAfterSeed: { 'pages/Scratch.html': '<div data-page-title="Scratch"><p>Notizzettel.</p></div>' },
  });

  // T1a - control, the over-blocking direction: with a clean index the delete must still work.
  // This is the direction of the guard's own failure mode, so it needs its own mutation (M7).
  const clean = await contribute(world.baseUrl, { action: 'delete', file_path: 'pages/Scratch.html' });
  assert.equal(clean.response.status, 200, world.logs.join(''));
  assert.equal(await world.headSubject(), '[DeleterAgent] delete: pages/Scratch.html');

  // T1b - the leak itself. Measured against e9021cf without the guard: status 200, HEAD subject
  // "[DeleterAgent] delete: pages/Scratch2.html", HEAD files "D pages/PublicPage.html", and
  // ls-tree HEAD -- pages/PublicPage.html empty. The victim is a public file and the request
  // carries no admin secret, only proof of work.
  await fs.writeFile(path.join(world.worldDir, 'pages/Scratch2.html'), '<p>Noch ein Zettel.</p>');
  await stageForeignDeletion(world, VICTIM);
  const subjectBefore = await world.headSubject();

  const leaked = await contribute(world.baseUrl, { action: 'delete', file_path: 'pages/Scratch2.html' });
  assert.equal(leaked.response.status, 500, world.logs.join(''));
  assert.equal(await world.headSubject(), subjectBefore, 'no commit may be created at all');
  assert.equal(await world.inHeadTree(VICTIM), true, 'the foreign public file stays in the HEAD tree');
  assert.deepEqual(await world.stagedPaths(), [VICTIM],
    'the guard refuses, it does not clean up somebody else\'s index');

  // T1c - what the refusal must NOT leave behind. The refusal happens after the write-ahead marker
  // is armed, so this pins that the rollback disarms it again: an armed repair barrier would turn
  // one dirty-index event into a permanent lockout for every later contribution.
  const moderationState = JSON.parse(
    await fs.readFile(path.join(world.dataDir, 'moderation.json'), 'utf8'));
  assert.deepEqual(moderationState.gitRepairs, {}, 'no durable repair state may survive the refusal');
  assert.deepEqual(moderationState.moderation.quarantinedFiles, {}, 'and nothing may be quarantined');
  await fs.access(path.join(world.worldDir, 'pages/Scratch2.html'));
  const followUp = await contribute(world.baseUrl, {
    action: 'create',
    file_path: 'pages/Follow.html',
    content: '<div data-page-title="Follow"><p>Danach.</p></div>',
  });
  assert.equal(followUp.response.status, 200, 'later contributions must not be locked out');
});

test('a quarantine rejection on an untracked path never commits a foreign staged deletion', async (t) => {
  // Mutation caught: guard call removed at the reject handler's else branch.
  // Without the guard, measured: status 200 and a commit "moderation: reject <path>" whose only
  // change is "D pages/PublicPage.html" - a foreign public file deleted under a subject naming a
  // different, never-public path.
  const risky = '<p>Invest 80% of your savings in this token.</p>';
  const world = await startWorld(t, {
    files: { [VICTIM]: VICTIM_BYTES },
    riskyAfterSeed: { 'pages/UntrackedRisky.html': risky },
  });

  const listed = await requestJson(world.baseUrl, '/api/admin/quarantine',
    { headers: { 'X-Admin-Secret': 'operator-secret' } });
  assert.equal(listed.response.status, 200, world.logs.join(''));
  assert.equal(listed.body.quarantined.some(record => record.path === 'pages/UntrackedRisky.html'),
    true, 'setup: the untracked risky file must be quarantined at startup');

  await stageForeignDeletion(world, VICTIM);
  const subjectBefore = await world.headSubject();

  const rejected = await adminPost(world.baseUrl, '/api/admin/quarantine/reject',
    { secret: 'operator-secret', path: 'pages/UntrackedRisky.html' });
  assert.equal(rejected.response.status, 500, world.logs.join(''));
  assert.equal(await world.headSubject(), subjectBefore);
  assert.equal(await world.inHeadTree(VICTIM), true);
  // What the refusal leaves behind, pinned like its two siblings do: the foreign index entry is
  // untouched, and the quarantine record survives so a retry after an operator clears the index
  // still has something to reject. The risky file's bytes are gone - fs.unlink runs before the
  // commit and is not undone, exactly as a failing hook would leave it.
  assert.deepEqual(await world.stagedPaths(), [VICTIM],
    'the guard refuses, it does not clean up somebody else\'s index');
  const stillQuarantined = await requestJson(world.baseUrl, '/api/admin/quarantine',
    { headers: { 'X-Admin-Secret': 'operator-secret' } });
  assert.equal(stillQuarantined.body.quarantined.some(r => r.path === 'pages/UntrackedRisky.html'),
    true, 'a refused rejection must not silently drop the quarantine record');
});

test('a moderation delete never bundles a foreign staged deletion into its commit', async (t) => {
  // Mutations caught: guard call removed at /api/admin/moderate (the commit then carries two D
  // lines), and the guard moved BEHIND the git.add (the index then keeps our own path too, which
  // would make every later pathspec-less commit refuse as well).
  const doomed = 'pages/Doomed.html';
  const world = await startWorld(t, {
    files: { [VICTIM]: VICTIM_BYTES, [doomed]: '<div data-page-title="Doomed"><p>Wird moderiert.</p></div>' },
  });

  await stageForeignDeletion(world, VICTIM);
  const subjectBefore = await world.headSubject();

  const moderated = await adminPost(world.baseUrl, '/api/admin/moderate',
    { secret: 'operator-secret', action: 'delete', target: doomed });
  // The endpoint keeps its best-effort semantics; whether it should answer 500 instead is a
  // product decision and deliberately not changed here.
  assert.equal(moderated.response.status, 200, world.logs.join(''));
  assert.equal(await world.headSubject(), subjectBefore, 'no moderation commit may be created');
  assert.equal(await world.inHeadTree(VICTIM), true);
  assert.deepEqual(await world.stagedPaths(), [VICTIM],
    'the guard runs before the add, so the refusal stages nothing of its own');
  assert.match(world.logs.join(''), /Moderation removal commit skipped:/,
    'a guard nobody can see in the log is barely a guard');
  assert.match(world.logs.join(''), /index holds unrelated staged paths: "pages\/PublicPage\.html"/,
    'the log quotes the path - the write policy admits newlines and commas inside one');
  // What the refusal does NOT repair, stated rather than left implicit: the unlink runs long before
  // the guard and is never undone, so the file is gone from the worktree and still in the HEAD tree.
  // That is this branch's pre-existing best-effort behaviour, which a failing hook produces too.
  await assert.rejects(fs.access(path.join(world.worldDir, doomed)));
  assert.equal(await world.inHeadTree(doomed), true);
});

test('a moderation delete still commits when the index holds only its own staged change', async (t) => {
  // Guards the -z in stagedIndexPaths, i.e. the direction where the guard wrongly refuses. Without
  // -z git C-quotes the non-ASCII path ("pages/\346\227\245\346\234\254\350\252\236.html"), it no
  // longer equals the request path, and the guard rejects a legitimate moderation.
  //
  // The staged state is a MODIFICATION, not a staged deletion: a staged deletion is not an index
  // entry, so the handler's own `git add` would then fail with rc=128 and no commit would be
  // created either way - the test would be red on both sides and prove nothing. A staged
  // modification is what _gitCommitImpl leaves behind for create/edit when the commit afterwards
  // fails, so this is the realistic retry.
  const target = 'pages/日本語.html';
  const world = await startWorld(t, {
    files: { [target]: '<div data-page-title="JP"><p>Alt.</p></div>' },
  });

  await fs.writeFile(path.join(world.worldDir, target), '<div data-page-title="JP"><p>Neu.</p></div>');
  await world.git('add', '--', `:(literal)${target}`);
  assert.deepEqual(await world.stagedPaths(), [target], 'setup: only our own path is staged');

  const moderated = await adminPost(world.baseUrl, '/api/admin/moderate',
    { secret: 'operator-secret', action: 'delete', target });
  assert.equal(moderated.response.status, 200, world.logs.join(''));
  assert.equal(await world.headSubject(), `moderation: remove ${target}`);
  assert.equal(await world.inHeadTree(target), false);
  assert.deepEqual(await world.stagedPaths(), [], 'the commit consumed the staged change');
});

test('the guard sees a staged deletion that git would otherwise fold into a rename', async (t) => {
  // Guards --no-renames. Without it git pairs the own staged ADD with a similar-content foreign
  // staged DELETION into one R100 rename and prints only the new name, so the deletion is invisible
  // to the guard. Measured on a copy with the flag removed: the request below answered 200 and
  // produced a commit whose only change was "D pages/Victim.html", victim gone from the HEAD tree.
  // The shape is reachable over HTTP: _gitCommitImpl stages a create exactly like this, and a
  // commit that fails afterwards leaves the add behind.
  const victim = 'pages/Victim.html';
  const ghost = 'pages/Ghost.html';
  const shared = '<div data-page-title="Twins"><p>Zwei Seiten, gleicher Inhalt.</p></div>';
  const world = await startWorld(t, { files: { [victim]: shared } });

  await fs.writeFile(path.join(world.worldDir, ghost), shared);
  await world.git('add', '--', `:(literal)${ghost}`);          // own path staged as an ADD
  await fs.unlink(path.join(world.worldDir, victim));
  await world.git('add', '-u', '--', `:(literal)${victim}`);   // foreign path staged as a DELETION
  const subjectBefore = await world.headSubject();

  const moderated = await adminPost(world.baseUrl, '/api/admin/moderate',
    { secret: 'operator-secret', action: 'delete', target: ghost });
  assert.equal(moderated.response.status, 200, world.logs.join(''));
  assert.equal(await world.headSubject(), subjectBefore, 'no commit may be created');
  assert.equal(await world.inHeadTree(victim), true, 'the foreign deletion must not be committed');
});

test('the guard treats an index twin that differs only in Unicode form as foreign', async (t) => {
  // Guards the byte-exact comparison itself - the single most load-bearing line of the guard, and
  // the one two reviewers wanted replaced by NFC folding. The index holds both spellings side by
  // side even on APFS, which the filesystem could not, so this runs on macOS and Linux alike.
  // Measured with NFC folding in place of byte equality: foreign = [] and the guard passes.
  const nfc = ('pages/' + 'Übung.html').normalize('NFC');
  const nfd = ('pages/' + 'Übung.html').normalize('NFD');
  const world = await startWorld(t, { files: { [nfc]: '<div data-page-title="U"><p>Eigen.</p></div>' } });

  stageRawIndexEntry(world, Buffer.from(nfd, 'utf8'));
  assert.equal((await world.stagedPaths()).length, 1, 'setup: the twin is a separate index entry');
  const subjectBefore = await world.headSubject();

  const moderated = await adminPost(world.baseUrl, '/api/admin/moderate',
    { secret: 'operator-secret', action: 'delete', target: nfc });
  assert.equal(moderated.response.status, 200, world.logs.join(''));
  assert.equal(await world.headSubject(), subjectBefore, 'the twin is a different file, not our own');
  assert.equal(await world.inHeadTree(nfc), true);
});

test('the guard treats an index path that is not valid UTF-8 as foreign', async (t) => {
  // Guards the RAW-BYTE comparison. Git permits path bytes that are not valid UTF-8; decoding one
  // turns every such byte into U+FFFD, so an index entry holding a raw 0xFF collapses onto exactly
  // the string of a request path that carries the replacement character literally - which the agent
  // write policy admits. Measured with a string comparison in place of Buffer.equals: foreign = []
  // and the pathspec-less commit swept the undecodable entry in.
  const own = 'pages/\uFFFD.html';
  const world = await startWorld(t, { files: { [own]: '<div data-page-title="R"><p>Eigen.</p></div>' } });

  const rawForeign = Buffer.concat([
    Buffer.from('pages/'), Buffer.from([0xFF]), Buffer.from('.html'),
  ]);
  stageRawIndexEntry(world, rawForeign);
  assert.deepEqual(await world.stagedPaths(), [own],
    'setup: the foreign entry decodes to exactly the own path');
  const subjectBefore = await world.headSubject();

  const moderated = await adminPost(world.baseUrl, '/api/admin/moderate',
    { secret: 'operator-secret', action: 'delete', target: own });
  assert.equal(moderated.response.status, 200, world.logs.join(''));
  assert.equal(await world.headSubject(), subjectBefore, 'an undecodable path is never our own');
  assert.equal(await world.inHeadTree(own), true);
});

test('the guard compares against the repo-root path when the World dir is not the git root', async (t) => {
  // Guards the `git rev-parse --show-prefix` prefix. `git diff --cached --name-only` reports
  // relative to the REPOSITORY root, while the server addresses paths relative to WORLD_DIR. Those
  // coincide only when the World dir IS the git root - the container layout, where world/ is its
  // own volume and repo. A plain clone is the other case: world/ is tracked by the project repo,
  // git.status() succeeds against it, and the guard would see "world/pages/Doomed.html" while the
  // own path is "pages/Doomed.html". Measured without the prefix: the moderation below was refused
  // with `index holds unrelated staged paths: "world/pages/Doomed.html"` and no commit at all,
  // although the same request commits correctly before this change.
  const doomed = 'pages/Doomed.html';
  const second = 'pages/Second.html';
  const world = await startWorld(t, {
    gitRootAboveWorld: true,
    files: {
      [doomed]: '<div data-page-title="Doomed"><p>Alt.</p></div>',
      [second]: '<div data-page-title="Second"><p>Alt.</p></div>',
    },
  });
  assert.deepEqual(await world.stagedPaths(), [], 'setup: the seed commit left the index clean');

  // The own path must be staged for the prefix to matter at all - with an empty index the guard
  // passes either way. A create whose commit failed leaves exactly this state behind.
  await fs.writeFile(path.join(world.worldDir, doomed), '<div data-page-title="Doomed"><p>Neu.</p></div>');
  await world.git('add', '--', `:(literal)${doomed}`);
  assert.deepEqual(await world.stagedPaths(), [`world/${doomed}`],
    'setup: git reports the own path prefixed, which is the whole point of this case');

  const moderated = await adminPost(world.baseUrl, '/api/admin/moderate',
    { secret: 'operator-secret', action: 'delete', target: doomed });
  assert.equal(moderated.response.status, 200, world.logs.join(''));
  assert.equal(await world.headSubject(), `moderation: remove ${doomed}`,
    'the moderation must still commit - the guard may not mistake its own path for a foreign one');
  assert.equal(await world.inHeadTree(doomed), false);

  // The obvious way to align the two path spaces is --relative, and it is a fail-open: it reports
  // only what lies under the cwd, so a foreign path staged ELSEWHERE in the repo becomes invisible
  // to the guard while a pathspec-less commit still carries it. Measured with --relative in place
  // of the prefix: the moderation below answered 200 and its commit contained project-notes.md.
  const outsideWorld = path.join(world.worldDir, '..', 'project-notes.md');
  await fs.writeFile(outsideWorld, '# fremd, ausserhalb von world/\n');
  await world.git('add', '--', ':(literal)../project-notes.md');
  const subjectBeforeSecond = await world.headSubject();

  const blocked = await adminPost(world.baseUrl, '/api/admin/moderate',
    { secret: 'operator-secret', action: 'delete', target: second });
  assert.equal(blocked.response.status, 200, world.logs.join(''));
  assert.equal(await world.headSubject(), subjectBeforeSecond,
    'a foreign path staged outside the World dir must still block the commit');
  assert.match(world.logs.join(''), /index holds unrelated staged paths: "project-notes\.md"/);
});

test('the guard refuses when it cannot read the index at all', async (t) => {
  // Guards the choice of execFile over simple-git, which is the reason the comment gives for it:
  // simple-git scores exit != 0 with EMPTY stderr as success, so a failed index read would return
  // "" and be indistinguishable from a clean index. A git shim on PATH makes exactly that shape.
  // Measured with the read swallowed (`catch { return []; }`): the moderation answered 200 and
  // committed "moderation: remove pages/Doomed.html" with the victim gone from the HEAD tree.
  const doomed = 'pages/Doomed.html';
  const world = await startWorld(t, {
    files: { [VICTIM]: VICTIM_BYTES, [doomed]: '<div data-page-title="Doomed"><p>Alt.</p></div>' },
    seed: async ({ root }) => {
      const binDir = path.join(root, 'fakebin');
      await fs.mkdir(binDir, { recursive: true });
      const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
      // Fails ONLY the index read, with an empty stderr, and forwards everything else untouched.
      await fs.writeFile(path.join(binDir, 'git'),
        `#!/bin/sh\nfor a in "$@"; do [ "$a" = "--cached" ] && exit 1; done\nexec ${realGit} "$@"\n`);
      await fs.chmod(path.join(binDir, 'git'), 0o755);
      return { PATH: `${binDir}${path.delimiter}${process.env.PATH}` };
    },
  });
  const subjectBefore = await world.headSubject();

  await stageForeignDeletion(world, VICTIM);
  const moderated = await adminPost(world.baseUrl, '/api/admin/moderate',
    { secret: 'operator-secret', action: 'delete', target: doomed });
  assert.equal(moderated.response.status, 200, world.logs.join(''));
  assert.equal(await world.headSubject(), subjectBefore, 'an unreadable index must never commit');
  assert.equal(await world.inHeadTree(VICTIM), true);
});

test('the guard sees a staged gitlink even under diff.ignoreSubmodules', async (t) => {
  // Guards --ignore-submodules=none. A repo-, global- or system-level diff.ignoreSubmodules=all
  // hides a staged gitlink from `git diff --cached --name-only` entirely; without the flag the
  // guard would report a clean index and let the pathspec-less commit carry the submodule change.
  const doomed = 'pages/Doomed.html';
  const world = await startWorld(t, {
    files: { [doomed]: '<div data-page-title="Doomed"><p>Alt.</p></div>' },
  });
  await world.git('config', 'diff.ignoreSubmodules', 'all');
  stageRawIndexEntry(world, Buffer.from('vendor-sub', 'utf8'), { mode: '160000' });
  const subjectBefore = await world.headSubject();

  const moderated = await adminPost(world.baseUrl, '/api/admin/moderate',
    { secret: 'operator-secret', action: 'delete', target: doomed });
  assert.equal(moderated.response.status, 200, world.logs.join(''));
  assert.equal(await world.headSubject(), subjectBefore,
    'a staged gitlink is a staged path like any other');
  assert.equal(await world.inHeadTree(doomed), true);
});

test('an ambient GIT_DIR cannot make the guard read a different repository', async (t) => {
  // Guards the three delete(process.env...) lines at startup. Git exports GIT_DIR into hook
  // environments, so a deploy hook that restarts the server passes it down. With GIT_DIR set and no
  // GIT_WORK_TREE, git treats the cwd as the work tree root: rev-parse --show-prefix returns "" and
  // the index still reports repo-root paths, so the repo-root pages/Doomed.html and the World's own
  // pages/Doomed.html become the same string. Measured without the deletes: foreign = [] and the
  // guard passed over a file that is not the caller's.
  const doomed = 'pages/Doomed.html';
  const world = await startWorld(t, {
    gitRootAboveWorld: true,
    files: { [doomed]: '<div data-page-title="Doomed"><p>Welt.</p></div>' },
    seed: async ({ projectDir, git }) => {
      // Same relative path, one directory up: the collision the ambient GIT_DIR would create.
      await fs.mkdir(path.join(projectDir, 'pages'), { recursive: true });
      await fs.writeFile(path.join(projectDir, 'pages', 'Doomed.html'), '<p>Nicht die Welt.</p>');
      await git('add', '--', ':(literal)../pages/Doomed.html');
      return { GIT_DIR: path.join(projectDir, '.git') };   // no GIT_WORK_TREE, exactly as a hook leaves it
    },
  });
  const subjectBefore = await world.headSubject();

  const moderated = await adminPost(world.baseUrl, '/api/admin/moderate',
    { secret: 'operator-secret', action: 'delete', target: doomed });
  assert.equal(moderated.response.status, 200, world.logs.join(''));
  assert.equal(await world.headSubject(), subjectBefore,
    'the repo-root file of the same name is not the World file');
  assert.deepEqual(await world.stagedPaths(), ['pages/Doomed.html'],
    'the repo-root path is still staged, uncommitted - the guard refused rather than swept it');
});

test('an ambient GIT_INDEX_FILE cannot make the guard read a different index', async (t) => {
  // The mirror of the test above, and the reason the third startup delete exists. An ambient
  // GIT_INDEX_FILE naming a file that is not there makes `git diff --cached --name-only` report
  // EVERY file in HEAD as a staged deletion, so the guard reads the repository's own contents as
  // foreign and refuses for good - with a log line blaming the World's own pages. Measured with
  // only that delete removed: `index holds unrelated staged paths: "pages/Keep.html"`, HEAD stuck
  // at `seed world`. The same variable is exported into hook environments as GIT_DIR is.
  const doomed = 'pages/Doomed.html';
  const keep = 'pages/Keep.html';
  const world = await startWorld(t, {
    files: {
      [doomed]: '<div data-page-title="Doomed"><p>Weg damit.</p></div>',
      [keep]: '<div data-page-title="Keep"><p>Bleibt.</p></div>',
    },
    seed: async ({ root }) => ({ GIT_INDEX_FILE: path.join(root, 'ambient-index') }),
  });

  const moderated = await adminPost(world.baseUrl, '/api/admin/moderate',
    { secret: 'operator-secret', action: 'delete', target: doomed });
  assert.equal(moderated.response.status, 200, world.logs.join(''));
  assert.equal(await world.headSubject(), `moderation: remove ${doomed}`,
    'the moderation must commit - an ambient index must not turn the World into its own foreigner');
  assert.equal(await world.inHeadTree(doomed), false);
  assert.equal(await world.inHeadTree(keep), true, 'and nothing else may be swept along');
});
