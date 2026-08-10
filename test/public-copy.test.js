'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const REPO_ROOT = path.join(__dirname, '..');
const OPERATOR_MESSAGE = 'AI agents build the world. Humans operate the platform and watch it evolve.';
const LEGACY_PROHIBITED_PHRASES = [
  'zero human intervention',
  'no human intervention',
  'no intervention possible',
  'no overrides',
  'no control',
  'humans can only watch',
];
const PROHIBITED_PHRASES = [
  ...LEGACY_PROHIBITED_PHRASES,
  'built entirely by ai agents',
];

function normalizePublicCorpus(value) {
  return String(value).replace(/\s+/g, ' ').trim();
}

function countProhibitedPhrases(value) {
  const normalized = normalizePublicCorpus(value).toLowerCase();
  return PROHIBITED_PHRASES.reduce((total, phrase) => {
    let count = 0;
    let offset = 0;
    while ((offset = normalized.indexOf(phrase, offset)) !== -1) {
      count += 1;
      offset += phrase.length;
    }
    return total + count;
  }, 0);
}

async function getFreePort() {
  const listener = net.createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  return port;
}

async function waitForServer(baseUrl, child, logs) {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Server exited early:\n${logs.join('')}`);
    try {
      if ((await fetch(`${baseUrl}/api/stats`)).ok) return;
    } catch { /* retry */ }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Server did not start:\n${logs.join('')}`);
}

test('delivered public copy states the operator boundary without absolute intervention claims', async (t) => {
  // Mutation caught: restoring the six legacy absolute phrases changes the prohibited count 0 -> 6;
  // restoring the rendered "built entirely" metadata fallback also makes the delivered count nonzero.
  const negativeFixture = LEGACY_PROHIBITED_PHRASES.join(' | ');
  assert.equal(countProhibitedPhrases(negativeFixture), 6);

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aibuilds-public-copy-'));
  const worldDir = path.join(root, 'world');
  const dataDir = path.join(root, 'data');
  const backupDir = path.join(root, 'backups');
  await Promise.all([
    fs.mkdir(worldDir, { recursive: true }),
    fs.mkdir(dataDir, { recursive: true }),
    fs.mkdir(backupDir, { recursive: true }),
  ]);

  const port = await getFreePort();
  const logs = [];
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      POW_DIFFICULTY: '0',
      AIBUILDS_WORLD_DIR: worldDir,
      AIBUILDS_DATA_DIR: dataDir,
      AIBUILDS_BACKUP_DIR: backupDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', chunk => logs.push(chunk.toString()));
  child.stderr.on('data', chunk => logs.push(chunk.toString()));
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGTERM');
    if (child.exitCode === null) await once(child, 'exit');
    await fs.rm(root, { recursive: true, force: true });
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForServer(baseUrl, child, logs);
  const paths = ['/', '/live', '/world/', '/api', '/api/world/structure', '/llms.txt', '/llms-full.txt'];
  const responses = await Promise.all(paths.map(async requestPath => {
    const response = await fetch(baseUrl + requestPath);
    assert.equal(response.status, 200, `${requestPath}\n${logs.join('')}`);
    return response.text();
  }));
  assert.ok(responses[0].includes('AGENT_NAME'));
  assert.ok(responses[0].includes('~/.aibuilds/agent-id'));

  // Exercise normal page rendering without an agent-authored description, then the assembled
  // sections renderer. Both must use the same operator-honest metadata default as empty init.
  await Promise.all([
    fs.mkdir(path.join(worldDir, 'pages'), { recursive: true }),
    fs.mkdir(path.join(worldDir, 'sections'), { recursive: true }),
  ]);
  await fs.writeFile(path.join(worldDir, 'layout.html'), `<!doctype html><html><head>
    <title>{{TITLE}}</title><meta name="description" content="{{DESCRIPTION}}">
    </head><body>{{NAV}}<main>{{CONTENT}}</main></body></html>`);
  await fs.writeFile(path.join(worldDir, 'pages/home.html'),
    '<div data-page-title="Home"><h1>Normal rendered page</h1></div>');
  const normalPage = await fetch(`${baseUrl}/world/`);
  assert.equal(normalPage.status, 200, logs.join(''));
  responses.push(await normalPage.text());

  await Promise.all([
    fs.unlink(path.join(worldDir, 'pages/home.html')),
    fs.unlink(path.join(worldDir, 'index.html')),
  ]);
  await fs.writeFile(path.join(worldDir, 'sections/demo.html'),
    '<section data-section-title="Demo"><h2>Assembled section</h2></section>');
  const assembledPage = await fetch(`${baseUrl}/world/`);
  assert.equal(assembledPage.status, 200, logs.join(''));
  responses.push(await assembledPage.text());

  const corpus = normalizePublicCorpus(responses.join('\n'));

  assert.ok(corpus.includes(OPERATOR_MESSAGE));
  assert.equal(countProhibitedPhrases(corpus), 0);
});

module.exports = { countProhibitedPhrases, normalizePublicCorpus };
