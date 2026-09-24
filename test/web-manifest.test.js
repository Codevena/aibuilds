'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const ROOT = path.join(__dirname, '..');

// Reads the bound port from the server's own startup banner instead of reserving one up front.
// The trailing \s matters: without it a stdout chunk ending mid-number matches a TRUNCATED port,
// and since the first match is cached that is terminal - the test then fails as a connection
// timeout while the log shows the correct banner. Self-camouflaging, so anchor on the padding.
// Pre-reserving (listen(0), close, reuse) is a TOCTOU race: between close and the child's bind the
// port can be taken, which surfaced as sporadic EADDRINUSE and looked like a regression.
// (Copied verbatim from test/seo-publication.test.js - this file needs its own spawned server.)
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
        if ((await fetch(`${baseUrl}/api/stats`, { signal: AbortSignal.timeout(1000) })).ok) return baseUrl;
      } catch { /* retry */ }
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Server did not start:\n${logs.join('')}`);
}

// PNG signature (8 bytes) + IHDR chunk length (4 bytes) + "IHDR" (4 bytes) + width (4, BE) +
// height (4, BE) - the IHDR chunk is always first, so this offset is fixed for any valid PNG.
function pngDimensions(buffer) {
  assert.equal(buffer.toString('ascii', 12, 16), 'IHDR');
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

// This lives in its own file (rather than folded into public-contract.test.js or
// public-copy.test.js) because it needs a spawned server to exercise real static-file serving
// (content-type, caching headers) and the world layout's template substitution around the
// hand-added <link> line, not just a fs.readFile-level content check.
test('web app manifest and icons are served correctly and linked from every entry page', async (t) => {
  // Mutations caught: a missing/unregistered manifest route, an icon PNG whose raster size
  // doesn't match its declared manifest size, or an entry HTML file missing the manifest link.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aibuilds-web-manifest-'));
  const worldDir = path.join(root, 'world');
  const dataDir = path.join(root, 'data');
  const backupDir = path.join(root, 'backups');
  await Promise.all([
    fs.mkdir(path.join(worldDir, 'css'), { recursive: true }),
    fs.mkdir(dataDir, { recursive: true }),
    fs.mkdir(backupDir, { recursive: true }),
  ]);
  await Promise.all([
    fs.copyFile(path.join(ROOT, 'world/layout.html'), path.join(worldDir, 'layout.html')),
    fs.copyFile(path.join(ROOT, 'world/css/theme.css'), path.join(worldDir, 'css/theme.css')),
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

  const manifestResponse = await fetch(`${baseUrl}/manifest.webmanifest`);
  assert.equal(manifestResponse.status, 200, logs.join(''));
  assert.match(manifestResponse.headers.get('content-type') || '', /manifest\+json/);
  const manifest = await manifestResponse.json();
  assert.ok(Array.isArray(manifest.icons) && manifest.icons.length >= 2, JSON.stringify(manifest));

  for (const icon of manifest.icons) {
    const response = await fetch(`${baseUrl}${icon.src}`);
    assert.equal(response.status, 200, icon.src);
    assert.equal(response.headers.get('content-type'), 'image/png', icon.src);
    const { width, height } = pngDimensions(Buffer.from(await response.arrayBuffer()));
    const [declaredWidth, declaredHeight] = icon.sizes.split('x').map(Number);
    assert.equal(width, declaredWidth, icon.src);
    assert.equal(height, declaredHeight, icon.src);
  }

  const appleTouchIconResponse = await fetch(`${baseUrl}/icons/apple-touch-icon.png`);
  assert.equal(appleTouchIconResponse.status, 200);
  assert.equal(appleTouchIconResponse.headers.get('content-type'), 'image/png');
  assert.deepEqual(
    pngDimensions(Buffer.from(await appleTouchIconResponse.arrayBuffer())),
    { width: 180, height: 180 },
  );

  // The SVG favicon every entry page now links instead of the old inline data URI.
  const svgIconResponse = await fetch(`${baseUrl}/icons/icon.svg`);
  assert.equal(svgIconResponse.status, 200);
  assert.equal(svgIconResponse.headers.get('content-type'), 'image/svg+xml');
  assert.match(await svgIconResponse.text(), /^<svg[\s>]/);

  const [landingHtml, dashboardHtml, worldHomeHtml] = await Promise.all([
    fetch(`${baseUrl}/`).then(r => r.text()),
    fetch(`${baseUrl}/live`).then(r => r.text()),
    fetch(`${baseUrl}/world/`).then(r => r.text()),
  ]);
  for (const [name, html] of [
    ['landing (public/landing.html)', landingHtml],
    ['dashboard (public/index.html)', dashboardHtml],
    ['world layout (world/layout.html)', worldHomeHtml],
  ]) {
    assert.match(html, /<link rel="manifest" href="\/manifest\.webmanifest">/, name);
    assert.match(html, /<link rel="icon" type="image\/svg\+xml" href="\/icons\/icon\.svg">/, name);
  }
});
