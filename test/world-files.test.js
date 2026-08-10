const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

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

async function availablePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

function request(port, requestPath) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: requestPath }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
  });
}

async function startWorldServer(hiddenFiles) {
  const fixture = await createWorldTree();
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aibuilds-data-'));
  const backupDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aibuilds-backups-'));
  const port = await availablePort();
  const launcher = [
    "const moderation = require('./server/moderation');",
    "moderation.loadModeration({ moderation: { hiddenFiles: JSON.parse(process.env.AIBUILDS_TEST_HIDDEN_FILES) } });",
    'moderation.load = async () => {};',
    'moderation.save = async () => {};',
    "require('./server/index');",
  ].join(' ');
  const child = spawn(process.execPath, ['-e', launcher], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      AIBUILDS_WORLD_DIR: fixture.root,
      AIBUILDS_DATA_DIR: dataDir,
      AIBUILDS_BACKUP_DIR: backupDir,
      AIBUILDS_TEST_HIDDEN_FILES: JSON.stringify(hiddenFiles),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Server did not start: ${output}`)), 10_000);
    const ready = () => {
      if (output.includes(`Server:    http://localhost:${port}`)) {
        clearTimeout(timeout);
        resolve();
      }
    };
    child.stdout.on('data', ready);
    child.stderr.on('data', ready);
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`Server exited before startup (${code}): ${output}`)));
  });

  return {
    fixture,
    dataDir,
    backupDir,
    port,
    child,
  };
}

async function stopWorldServer(server) {
  server.child.kill('SIGTERM');
  await once(server.child, 'exit');
  await Promise.all([
    removeWorldTree(server.fixture),
    fs.rm(server.dataDir, { recursive: true, force: true }),
    fs.rm(server.backupDir, { recursive: true, force: true }),
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

test('World API aliases and typed resolver failures return generic 404 responses', async (t) => {
  // Mutation caught: checking moderation before canonicalization or swallowing typed resolver failures leaks hidden/private World content.
  const server = await startWorldServer(['pages/quarantined.html']);
  t.after(() => stopWorldServer(server));
  await Promise.all([
    fs.writeFile(path.join(server.fixture.root, 'pages', 'quarantined.html'), '<main>Quarantined</main>'),
    fs.writeFile(path.join(server.fixture.root, 'pages', 'home.html'), '<div>Home</div>'),
    fs.symlink('../outside.txt', path.join(server.fixture.root, 'PROJECT.md')),
    fs.symlink('../outside.txt', path.join(server.fixture.root, 'WORLD.md')),
    fs.symlink('../outside.txt', path.join(server.fixture.root, 'layout.html')),
  ]);

  const [hiddenAlias, publicAlias, project, guidelines, prettyPage] = await Promise.all([
    request(server.port, '/api/world/pages%5Cquarantined.html'),
    request(server.port, '/api/world/pages%5Chome.html'),
    request(server.port, '/api/project'),
    request(server.port, '/api/world/guidelines'),
    request(server.port, '/world/home'),
  ]);

  assert.deepEqual(hiddenAlias, { status: 404, body: '{"error":"File not found"}' });
  assert.deepEqual({ status: publicAlias.status, body: JSON.parse(publicAlias.body) }, {
    status: 200,
    body: { path: 'pages/home.html', content: '<div>Home</div>' },
  });
  assert.deepEqual(project, { status: 404, body: '{"error":"File not found"}' });
  assert.deepEqual(guidelines, { status: 404, body: '{"error":"File not found"}' });
  assert.equal(prettyPage.status, 404);
});
