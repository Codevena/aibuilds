'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const REPO_ROOT = path.join(__dirname, '..');
const OPERATOR_MESSAGE = 'AI agents build the world. Humans operate the platform and watch it evolve.';
const CHAOS_BOUNDARY = 'page- and section-scoped styling rules are relaxed; protected global files remain operator-controlled';
const LEGACY_PROHIBITED_PHRASES = [
  'zero human intervention',
  'no human intervention',
  'no intervention possible',
  'no overrides',
  'no control',
  'humans can only watch',
];
const CHAOS_PROHIBITED_PHRASES = [
  'all rules suspended',
  'global css allowed',
];
const PROHIBITED_PHRASES = [
  ...LEGACY_PROHIBITED_PHRASES,
  'built entirely by ai agents',
  ...CHAOS_PROHIBITED_PHRASES,
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

// Reads the bound port from the server's own startup banner instead of reserving one up front.
// The trailing \s matters: without it a stdout chunk ending mid-number matches a TRUNCATED port,
// and since the first match is cached that is terminal - the test then fails as a connection
// timeout while the log shows the correct banner. Self-camouflaging, so anchor on the padding.
// Pre-reserving (listen(0), close, reuse) is a TOCTOU race: between close and the child's bind the
// port can be taken, which surfaced as sporadic EADDRINUSE and looked like a regression.
const SERVER_PORT_PATTERN = /Server:\s+http:\/\/localhost:(\d+)\s/;

async function waitForServer(child, logs) {
  // 12s rather than 10s: these harnesses start the server with a pre-populated state.json or git
  // history, so loadState and auditWorldForQuarantine run during startup.
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
        if ((await fetch(`${baseUrl}/api/stats`)).ok) return baseUrl;
      } catch { /* retry */ }
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Server did not start:\n${logs.join('')}`);
}

test('delivered public copy states the operator boundary without absolute intervention claims', async (t) => {
  // Mutation caught: restoring the six legacy absolute phrases changes the prohibited count 0 -> 6;
  // restoring the committed default World footer/meta or global-CSS Chaos claims makes the
  // copied index/layout corpus prohibited and breaks each surface-specific boundary assertion.
  const negativeFixture = LEGACY_PROHIBITED_PHRASES.join(' | ');
  assert.equal(countProhibitedPhrases(negativeFixture), 6);
  const chaosNegativeFixture = CHAOS_PROHIBITED_PHRASES.join(' | ');
  assert.equal(countProhibitedPhrases(chaosNegativeFixture), 2);

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aibuilds-public-copy-'));
  const worldDir = path.join(root, 'world');
  const dataDir = path.join(root, 'data');
  const backupDir = path.join(root, 'backups');
  await Promise.all([
    fs.mkdir(worldDir, { recursive: true }),
    fs.mkdir(dataDir, { recursive: true }),
    fs.mkdir(backupDir, { recursive: true }),
  ]);
  await Promise.all([
    fs.copyFile(path.join(REPO_ROOT, 'world/layout.html'), path.join(worldDir, 'layout.html')),
    fs.copyFile(path.join(REPO_ROOT, 'world/index.html'), path.join(worldDir, 'index.html')),
  ]);

  const logs = [];
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PORT: '0',
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

  const baseUrl = await waitForServer(child, logs);
  const paths = ['/', '/live', '/world/', '/api', '/api/world/structure', '/llms.txt', '/llms-full.txt'];
  const responses = await Promise.all(paths.map(async requestPath => {
    const response = await fetch(baseUrl + requestPath);
    assert.equal(response.status, 200, `${requestPath}\n${logs.join('')}`);
    return response.text();
  }));
  assert.ok(responses[0].includes('AGENT_NAME'));
  assert.ok(responses[0].includes('~/.aibuilds/agent-id'));

  // Exercise the actual default layout through normal page rendering and the assembled sections
  // renderer. This keeps both committed World surfaces in the spawned server contract.
  await Promise.all([
    fs.mkdir(path.join(worldDir, 'pages'), { recursive: true }),
    fs.mkdir(path.join(worldDir, 'sections'), { recursive: true }),
  ]);
  await fs.writeFile(path.join(worldDir, 'pages/home.html'),
    '<div data-page-title="Home"><h1>Normal rendered page</h1></div>');
  const normalPage = await fetch(`${baseUrl}/world/`);
  assert.equal(normalPage.status, 200, logs.join(''));
  const normalPageText = await normalPage.text();
  responses.push(normalPageText);

  await Promise.all([
    fs.unlink(path.join(worldDir, 'pages/home.html')),
    fs.unlink(path.join(worldDir, 'index.html')),
  ]);
  await fs.writeFile(path.join(worldDir, 'sections/demo.html'),
    '<section data-section-title="Demo"><h2>Assembled section</h2></section>');
  const assembledPage = await fetch(`${baseUrl}/world/`);
  assert.equal(assembledPage.status, 200, logs.join(''));
  const assembledPageText = await assembledPage.text();
  responses.push(assembledPageText);

  const corpus = normalizePublicCorpus(responses.join('\n'));
  const defaultWorldText = responses[paths.indexOf('/world/')];

  assert.ok(corpus.includes(OPERATOR_MESSAGE));
  for (const [surface, delivered] of [
    ['world/index.html', defaultWorldText],
    ['world/layout.html normal renderer', normalPageText],
    ['world/layout.html assembled renderer', assembledPageText],
  ]) {
    assert.ok(delivered.includes(OPERATOR_MESSAGE), surface);
    assert.ok(normalizePublicCorpus(delivered).toLowerCase().includes(CHAOS_BOUNDARY), surface);
  }
  assert.equal(countProhibitedPhrases(corpus), 0);
});

module.exports = { countProhibitedPhrases, normalizePublicCorpus };
