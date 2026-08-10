const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const mod = require('../server/moderation.js');

const execFileAsync = promisify(execFile);

test('hide/unhide/isHidden with path normalization', () => {
  mod.loadModeration({});
  assert.equal(mod.isHidden('sections/x.html'), false);
  assert.equal(mod.hide('sections/x.html'), true);   // returns true when newly added
  assert.equal(mod.isHidden('sections/x.html'), true);
  // normalization: leading slash, "world/" prefix, backslashes, case all match the same entry
  assert.equal(mod.isHidden('/world/Sections/X.html'), true);
  assert.equal(mod.isHidden('sections\\x.html'), true);
  assert.equal(mod.hide('sections/x.html'), false);   // already hidden -> false
  assert.equal(mod.unhide('sections/x.html'), true);
  assert.equal(mod.isHidden('sections/x.html'), false);
});

test('serialize/load round-trip', () => {
  mod.loadModeration({});
  mod.hide('sections/a.html');
  const snap = mod.serializeModeration();
  assert.deepEqual(snap.moderation.hiddenFiles, ['sections/a.html']);
  mod.loadModeration({});
  assert.equal(mod.isHidden('sections/a.html'), false);
  mod.loadModeration(snap);                 // re-hydrate from a serialized snapshot
  assert.equal(mod.isHidden('sections/a.html'), true);
});

test('quarantine and approval records serialize and load with exact hashes', () => {
  const quarantineRecord = {
    filePath: 'pages/risky.html',
    contentHash: 'hash-a',
    reasons: ['high_stakes_medical'],
    agentName: 'Risk Agent',
    timestamp: '2026-08-10T12:00:00.000Z',
  };
  mod.loadModeration({
    moderation: {
      quarantinedFiles: { 'pages/risky.html': quarantineRecord },
      approvedFiles: { 'pages/risky.html': 'hash-a' },
    },
  });

  assert.equal(mod.isQuarantined('pages/risky.html'), true);
  assert.equal(mod.isApproved('pages/risky.html', 'hash-a'), true);
  assert.equal(mod.isApproved('pages/risky.html', 'hash-b'), false);
  assert.deepEqual(mod.listQuarantined(), [quarantineRecord]);
  assert.deepEqual(mod.serializeModeration().moderation.quarantinedFiles, {
    'pages/risky.html': quarantineRecord,
  });
  assert.deepEqual(mod.serializeModeration().moderation.approvedFiles, {
    'pages/risky.html': 'hash-a',
  });
});

test('approval is bound to one version and corrective release clears stale state', () => {
  mod.loadModeration({});
  assert.equal(mod.quarantine('pages/risky.html', {
    contentHash: 'hash-a',
    reasons: ['high_stakes_medical'],
    agentName: 'Risk Agent',
    timestamp: '2026-08-10T12:00:00.000Z',
  }), true);
  assert.equal(mod.approve('pages/risky.html', 'hash-a'), true);
  assert.equal(mod.isApproved('pages/risky.html', 'hash-a'), true);
  assert.equal(mod.isApproved('pages/risky.html', 'hash-b'), false);

  assert.equal(mod.quarantine('pages/risky.html', {
    contentHash: 'hash-b',
    reasons: ['high_stakes_medical'],
    agentName: 'Risk Agent',
    timestamp: '2026-08-10T12:05:00.000Z',
  }), true);
  assert.equal(mod.isApproved('pages/risky.html', 'hash-b'), false);
  assert.equal(mod.releaseQuarantine('pages/risky.html'), true);
  assert.equal(mod.clearApproval('pages/risky.html'), true);
  assert.equal(mod.isQuarantined('pages/risky.html'), false);
  assert.equal(mod.isApproved('pages/risky.html', 'hash-a'), false);
  assert.deepEqual(mod.serializeModeration().moderation.quarantinedFiles, {});
  assert.deepEqual(mod.serializeModeration().moderation.approvedFiles, {});
});

test('reject removes quarantine and approval records together', () => {
  mod.loadModeration({});
  mod.quarantine('sections/rejected.html', {
    contentHash: 'hash-a',
    reasons: ['promotional_external_link'],
    agentName: 'Risk Agent',
    timestamp: '2026-08-10T12:00:00.000Z',
  });
  mod.approve('sections/rejected.html', 'hash-a');

  assert.equal(mod.reject('sections/rejected.html'), true);
  assert.equal(mod.isQuarantined('sections/rejected.html'), false);
  assert.equal(mod.isApproved('sections/rejected.html', 'hash-a'), false);
  assert.deepEqual(mod.serializeModeration().moderation.quarantinedFiles, {});
  assert.deepEqual(mod.serializeModeration().moderation.approvedFiles, {});
});

test('quarantine and approval preserve exact case-sensitive World paths', () => {
  mod.loadModeration({});
  const record = {
    contentHash: 'hash-a',
    reasons: ['high_stakes_medical'],
    agentName: 'Risk Agent',
    timestamp: '2026-08-10T12:00:00.000Z',
  };

  assert.equal(mod.quarantine('pages/MixedCase.html', record), true);
  assert.equal(mod.approve('pages/MixedCase.html', 'hash-a'), true);
  assert.equal(mod.isQuarantined('pages/MixedCase.html'), true);
  assert.equal(mod.isQuarantined('pages/mixedcase.html'), false);
  assert.equal(mod.isApproved('pages/MixedCase.html', 'hash-a'), true);
  assert.equal(mod.isApproved('pages/mixedcase.html', 'hash-a'), false);
  assert.equal(mod.listQuarantined()[0].filePath, 'pages/MixedCase.html');
  assert.deepEqual(Object.keys(mod.serializeModeration().moderation.quarantinedFiles), ['pages/MixedCase.html']);

  assert.equal(mod.quarantine('world/pages/MixedCase.html', { ...record, contentHash: 'hash-b' }), true);
  assert.equal(mod.isQuarantined('world/pages/MixedCase.html'), true);
  assert.equal(mod.isQuarantined('pages/MixedCase.html'), true);
  assert.deepEqual(mod.listQuarantined().map(item => item.filePath), [
    'pages/MixedCase.html', 'world/pages/MixedCase.html',
  ]);
});

test('awaited moderation persistence rejects instead of reporting a false success', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aibuilds-moderation-save-failure-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const blockedDataDir = path.join(root, 'not-a-directory');
  await fs.writeFile(blockedDataDir, 'blocked');
  const script = `
    const moderation = require('./server/moderation');
    moderation.loadModeration({});
    moderation.quarantine('pages/risky.html', {
      contentHash: 'hash-a', reasons: ['high_stakes_medical'], agentName: 'Risk', timestamp: 'now'
    });
    moderation.save().then(() => process.exit(42), () => process.exit(0));
  `;

  await execFileAsync(process.execPath, ['-e', script], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, AIBUILDS_DATA_DIR: blockedDataDir },
  });
});

test('legacy moderation migration propagates a persistence failure', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aibuilds-moderation-migration-failure-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dataDir, 'state.json'), JSON.stringify({
    moderation: { hiddenFiles: ['pages/frozen.html'] },
  }));
  const script = `
    const fs = require('node:fs').promises;
    const originalRename = fs.rename.bind(fs);
    fs.rename = (source, target) => String(target).endsWith('/moderation.json')
      ? Promise.reject(Object.assign(new Error('forced migration persistence failure'), { code: 'EIO' }))
      : originalRename(source, target);
    const moderation = require('./server/moderation');
    moderation.load().then(() => process.exit(42), () => process.exit(0));
  `;

  await execFileAsync(process.execPath, ['-e', script], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, AIBUILDS_DATA_DIR: dataDir },
  });
});

test('queued moderation saves persist the immutable call-time snapshot', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aibuilds-moderation-snapshot-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const script = `
    const fs = require('node:fs').promises;
    const path = require('node:path');
    const moderation = require('./server/moderation');
    moderation.loadModeration({});
    moderation.quarantine('pages/risky.html', {
      contentHash: 'risk-hash', reasons: ['high_stakes_medical'], agentName: 'Risk', timestamp: 'now'
    });
    const pending = moderation.save();
    moderation.releaseQuarantine('pages/risky.html');
    moderation.approve('pages/risky.html', 'risk-hash');
    pending.then(async () => {
      const disk = JSON.parse(await fs.readFile(path.join(process.env.AIBUILDS_DATA_DIR, 'moderation.json')));
      const preserved = disk.moderation.quarantinedFiles['pages/risky.html'];
      const leakedApproval = disk.moderation.approvedFiles['pages/risky.html'];
      process.exit(preserved && !leakedApproval ? 0 : 42);
    }, () => process.exit(43));
  `;

  await execFileAsync(process.execPath, ['-e', script], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, AIBUILDS_DATA_DIR: dataDir },
  });
});

test('ban/unban by name and ip', () => {
  mod.loadModeration({});
  assert.equal(mod.isBanned('Bad', '1.1.1.1'), false);
  mod.ban({ agentName: 'Bad' });
  assert.equal(mod.isBanned('Bad', null), true);
  assert.equal(mod.isBanned('Good', null), false);
  mod.ban({ ip: '9.9.9.9' });
  assert.equal(mod.isBanned('Good', '9.9.9.9'), true);
  assert.equal(mod.unban({ agentName: 'Bad' }), true);
  assert.equal(mod.isBanned('Bad', null), false);
});

test('ban bans exactly what is passed; resolveAgentIp is separate', () => {
  mod.loadModeration({});
  mod.recordAgentIp('Spammer', '203.0.113.5');
  assert.equal(mod.resolveAgentIp('Spammer'), '203.0.113.5');
  mod.ban({ agentName: 'Spammer' });                 // name only -> IP NOT auto-banned
  assert.equal(mod.isBanned('Other', '203.0.113.5'), false);
  mod.ban({ agentName: 'Spammer', ip: '203.0.113.5' }); // explicit IP
  assert.equal(mod.isBanned('Other', '203.0.113.5'), true);
});

test('unban clears the stored agent IP (privacy promise)', () => {
  mod.loadModeration({});
  mod.recordAgentIp('Temp', '198.51.100.9');
  mod.ban({ agentName: 'Temp', ip: '198.51.100.9' });
  mod.unban({ agentName: 'Temp', ip: '198.51.100.9' });
  assert.equal(mod.resolveAgentIp('Temp'), null);
  assert.equal(mod.isBanned('Temp', '198.51.100.9'), false);
});

test('scanContent: clean content passes', () => {
  assert.equal(mod.scanContent({ content: '<h1>Hello world</h1>', agentName: 'Nice' }), null);
});
test('scanContent: allowed analytics script passes', () => {
  const r = mod.scanContent({ content: '<script src="https://analytics.codevena.dev/script.js"></script>' });
  assert.equal(r, null);
});
test('scanContent: external script is blocked', () => {
  const r = mod.scanContent({ content: '<script src="https://evil.example.com/x.js"></script>' });
  assert.ok(r && r.reason === 'external-script');
});
test('scanContent: miner/obfuscation is blocked', () => {
  const r = mod.scanContent({ content: 'var x = eval(atob("..."))' });
  assert.ok(r && r.reason === 'miner-or-obfuscation');
});
test('scanContent: scam/phishing blocklist term is blocked', () => {
  const r = mod.scanContent({ content: 'Connect your wallet and enter your seed phrase to claim free crypto' });
  assert.ok(r && r.reason === 'blocklist');
});
test('scanContent: HTML-entity-encoded blocklist term is still blocked (normalization)', () => {
  const r = mod.scanContent({ content: 'please connect your w&#97;llet now' });
  assert.ok(r && r.reason === 'blocklist');
});
test('scanContent: named-entity (&nbsp;) separated blocklist term is still blocked', () => {
  const r = mod.scanContent({ content: 'connect&nbsp;your&nbsp;wallet right now' });
  assert.ok(r && r.reason === 'blocklist');
});
test('scanContent: inert markup between blocklist words is still blocked', () => {
  assert.ok(mod.scanContent({ content: 'connect <span>your</span> wallet' }) !== null);
  assert.ok(mod.scanContent({ content: 'connect<!--x--> your wallet' }) !== null);
});
test('scanContent: markup splitting a single word is still blocked', () => {
  // tags carry no visible spacing, so wall<span>et</span> renders "wallet"
  assert.ok(mod.scanContent({ content: 'connect your wall<span>et</span> now' }) !== null);
  assert.ok(mod.scanContent({ content: 'enter your seed phr<!--z-->ase here' }) !== null);
});
test('scanContent: entity-encoded external script URL is blocked', () => {
  const r = mod.scanContent({ content: '<script src="https:&#x2f;&#x2f;evil.example/x.js"></script>' });
  assert.ok(r && r.reason === 'external-script');
});
test('scanContent: allowed analytics host with entity-encoded slashes still passes', () => {
  const r = mod.scanContent({ content: '<script src="https:&#x2f;&#x2f;analytics.codevena.dev/script.js"></script>' });
  assert.equal(r, null);
});
