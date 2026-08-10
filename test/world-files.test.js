const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  isPrivateWorldPath,
  resolveWorldPath,
  resolveExistingWorldFile,
  listWorldFiles,
  WorldPathError,
} = require('../server/world-files');

async function createWorldTree() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aibuilds-world-files-'));
  const outside = path.join(path.dirname(root), 'outside.txt');

  await Promise.all([
    fs.mkdir(path.join(root, 'pages', '.draft'), { recursive: true }),
    fs.mkdir(path.join(root, 'assets'), { recursive: true }),
    fs.mkdir(path.join(root, '.git'), { recursive: true }),
  ]);
  await Promise.all([
    fs.writeFile(path.join(root, 'pages', 'home.html'), '<main>Home</main>'),
    fs.writeFile(path.join(root, 'assets', 'logo.svg'), '<svg/>'),
    fs.writeFile(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main'),
    fs.writeFile(path.join(root, 'pages', '.draft', 'secret.html'), '<main>Secret</main>'),
    fs.writeFile(outside, 'outside'),
  ]);
  await fs.symlink('../../outside.txt', path.join(root, 'assets', 'outside.txt'));

  return { root, outside };
}

async function removeWorldTree({ root, outside }) {
  await Promise.all([
    fs.rm(root, { recursive: true, force: true }),
    fs.rm(outside, { force: true }),
  ]);
}

test('private and traversal paths never resolve inside the public world', async (t) => {
  // Mutation caught: allowing a dot-prefixed segment or traversal exposes repository data.
  const fixture = await createWorldTree();
  t.after(() => removeWorldTree(fixture));

  assert.equal(isPrivateWorldPath('.git/HEAD'), true);
  assert.equal(isPrivateWorldPath('pages/.draft/secret.html'), true);
  assert.throws(() => resolveWorldPath(fixture.root, '../outside.txt'), WorldPathError);
  assert.throws(() => resolveWorldPath(fixture.root, '.git/HEAD'), WorldPathError);
});

test('backslashes are normalized before private-path policy is evaluated', () => {
  // Mutation caught: treating backslashes as harmless filename characters exposes private paths on Windows-style input.
  assert.equal(isPrivateWorldPath('.git\\HEAD'), true);
  assert.equal(isPrivateWorldPath('pages\\.draft\\secret.html'), true);
});

test('existing-file resolution rejects symlink segments and targets', async (t) => {
  // Mutation caught: following an out-of-root symlink reads files outside the public world.
  const fixture = await createWorldTree();
  t.after(() => removeWorldTree(fixture));

  await assert.rejects(
    resolveExistingWorldFile(fixture.root, 'assets/outside.txt'),
    WorldPathError,
  );
});

test('world listings exclude private directories and symbolic links', async (t) => {
  // Mutation caught: skipping private-directory filtering or following symbolic links leaks non-public files.
  const fixture = await createWorldTree();
  t.after(() => removeWorldTree(fixture));

  const files = await listWorldFiles(fixture.root);
  assert.deepEqual(files.map(file => file.path), ['assets/logo.svg', 'pages/home.html']);
});

test('internal file caps include moderated files without exposing them publicly', async (t) => {
  // Mutation caught: filtering moderated files even for the internal file cap lets quarantining bypass the cap.
  const fixture = await createWorldTree();
  t.after(() => removeWorldTree(fixture));

  const options = { isHidden: relativePath => relativePath === 'pages/home.html' };
  const publicFiles = await listWorldFiles(fixture.root, options);
  const internalFiles = await listWorldFiles(fixture.root, { ...options, includeHidden: true });

  assert.deepEqual(publicFiles.map(file => file.path), ['assets/logo.svg']);
  assert.deepEqual(internalFiles.map(file => file.path), ['assets/logo.svg', 'pages/home.html']);
});
