'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const { getPagePublicationMeta } = require('../server/content-governance');
const ROOT = path.join(__dirname, '..');

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

function contribution(id, agentName, filePath) {
  return {
    id,
    timestamp: '2026-08-10T12:00:00.000Z',
    agent_name: agentName,
    action: 'create',
    file_path: filePath,
    message: 'Safe public work.',
    publicationStatus: 'published',
    reactions: { fire: [], heart: [], rocket: [], eyes: [] },
    commentCount: 0,
  };
}

test('page publication requires two visible agents, availability, and a passing current scan', () => {
  // Mutations caught: lower the threshold to one, trust history without rescanning, or ignore availability.
  const oneAgent = [
    contribution('one-a', 'Solo', 'pages/solo.html'),
    contribution('one-b', 'Solo', 'pages/solo.html'),
  ];
  const twoAgents = [
    contribution('two-a', 'Builder', 'pages/shared.html'),
    contribution('two-b', 'Critic', 'pages/shared.html'),
  ];

  assert.deepEqual(getPagePublicationMeta({
    filePath: 'pages/solo.html', history: oneAgent, isUnavailable: false, currentContentPasses: true,
  }), { indexable: false, agentCount: 1, robots: 'noindex,nofollow' });
  assert.deepEqual(getPagePublicationMeta({
    filePath: 'pages/shared.html', history: twoAgents, isUnavailable: false, currentContentPasses: true,
  }), { indexable: true, agentCount: 2, robots: 'index,follow' });
  assert.deepEqual(getPagePublicationMeta({
    filePath: 'pages/shared.html', history: twoAgents, isUnavailable: true, currentContentPasses: true,
  }), { indexable: false, agentCount: 2, robots: 'noindex,nofollow' });
  assert.deepEqual(getPagePublicationMeta({
    filePath: 'pages/shared.html', history: twoAgents, isUnavailable: false, currentContentPasses: false,
  }), { indexable: false, agentCount: 2, robots: 'noindex,nofollow' });
});

test('real pretty pages and sitemap promote only safe two-agent pages while raw HTML stays noindex', async (t) => {
  // Mutations caught: index all discovered pages, emit JSON-LD for solo pages, or omit raw X-Robots-Tag.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aibuilds-seo-publication-'));
  const worldDir = path.join(root, 'world');
  const dataDir = path.join(root, 'data');
  const backupDir = path.join(root, 'backups');
  await Promise.all([
    fs.mkdir(path.join(worldDir, 'pages'), { recursive: true }),
    fs.mkdir(path.join(worldDir, 'css'), { recursive: true }),
    fs.mkdir(dataDir, { recursive: true }),
    fs.mkdir(backupDir, { recursive: true }),
  ]);
  await Promise.all([
    fs.copyFile(path.join(ROOT, 'world/layout.html'), path.join(worldDir, 'layout.html')),
    fs.copyFile(path.join(ROOT, 'world/css/theme.css'), path.join(worldDir, 'css/theme.css')),
    fs.writeFile(path.join(worldDir, 'pages/solo.html'),
      '<div data-page-title="Solo" data-page-description="Solo page"><h1>Solo</h1></div>'),
    fs.writeFile(path.join(worldDir, 'pages/shared.html'),
      '<div data-page-title="Shared" data-page-description="Shared page"><h1>Shared</h1></div>'),
    fs.writeFile(path.join(worldDir, 'pages/a&b.html'),
      '<div data-page-title="Ampersand" data-page-description="Encoded route"><h1>A &amp; B</h1></div>'),
    fs.writeFile(path.join(dataDir, 'state.json'), JSON.stringify({ history: [
      contribution('solo-1', 'Solo', 'pages/solo.html'),
      contribution('shared-1', 'Builder', 'pages/shared.html'),
      contribution('shared-2', 'Critic', 'pages/shared.html'),
      contribution('encoded-1', 'Builder', 'pages/a&b.html'),
      contribution('encoded-2', 'Critic', 'pages/a&b.html'),
    ] })),
  ]);

  const logs = [];
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
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
  const [solo, shared, raw, sitemap, platformHome, platformLive, worldHome] = await Promise.all([
    fetch(`${baseUrl}/world/solo`),
    fetch(`${baseUrl}/world/shared`),
    fetch(`${baseUrl}/world/pages/shared.html`),
    fetch(`${baseUrl}/sitemap.xml`),
    fetch(`${baseUrl}/`),
    fetch(`${baseUrl}/live`),
    fetch(`${baseUrl}/world/`),
  ]);
  const [soloHtml, sharedHtml, sitemapXml, worldHomeHtml] = await Promise.all([
    solo.text(), shared.text(), sitemap.text(), worldHome.text(),
  ]);

  assert.equal(solo.headers.get('x-robots-tag'), 'noindex,nofollow');
  assert.match(soloHtml, /<meta name="robots" content="noindex,nofollow">/);
  assert.doesNotMatch(soloHtml, /application\/ld\+json/);
  assert.equal(shared.headers.get('x-robots-tag'), 'index,follow');
  assert.match(sharedHtml, /<meta name="robots" content="index,follow">/);
  assert.match(sharedHtml, /application\/ld\+json/);
  assert.match(sharedHtml, /<main id="main-content" class="world-main world-main-page">/);
  assert.match(worldHomeHtml, /<main id="main-content" class="world-main world-main-home">/);
  assert.equal(raw.headers.get('x-robots-tag'), 'noindex, nofollow');
  assert.match(sitemapXml, /<loc>https:\/\/aibuilds\.dev\/world\/shared<\/loc>/);
  assert.doesNotMatch(sitemapXml, /world\/solo/);
  assert.doesNotMatch(sitemapXml, /pages\/shared\.html/);
  assert.equal(platformHome.headers.get('x-robots-tag'), 'index,follow');
  assert.equal(platformLive.headers.get('x-robots-tag'), 'index,follow');
  assert.equal(worldHome.headers.get('x-robots-tag'), 'index,follow');

  await fs.unlink(path.join(worldDir, 'layout.html'));
  const noLayout = await fetch(`${baseUrl}/world/shared`);
  const noLayoutHtml = await noLayout.text();
  assert.equal(noLayout.headers.get('x-robots-tag'), 'index,follow');
  assert.match(noLayoutHtml, /<meta name="robots" content="index,follow">/);
  assert.match(noLayoutHtml, /<script type="application\/ld\+json">/);
  assert.match(noLayoutHtml, /<main id="main-content">[\s\S]*<h1>Shared<\/h1>[\s\S]*<\/main>/);
  assert.match(sitemapXml, /<loc>https:\/\/aibuilds\.dev\/world\/a%26b<\/loc>/);
  assert.doesNotMatch(sitemapXml, /world\/a&b/);
});
