const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const mod = require('../server/moderation.js');

const execFileAsync = promisify(execFile);
const MAX_REPAIR_FILE_BYTES = 500 * 1024;
const MAX_REPAIR_AGENT_IPS = 5000;
const MAX_REPAIR_RECORDS = 1000;
const MAX_TOTAL_REPAIR_FILE_BYTES = 8 * 1024 * 1024;
const MAX_MODERATION_FILE_BYTES = 16 * 1024 * 1024;

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function validGitRepair(filePath = 'pages/recover.html', {
  bytes = Buffer.from('public bytes'),
  agentIps = [['RecoveryAgent', '203.0.113.10']],
  entries = [{ mode: '100644', hash: 'b'.repeat(40), stage: 0 }],
} = {}) {
  return {
    filePath,
    gitHash: null,
    status: 'armed',
    contributionId: 'recover-transaction',
    expectedGitSubject: `[RecoveryAgent] edit: ${filePath}`,
    publicationState: { quarantine: null, approval: null },
    agentIps,
    fileState: {
      existed: true,
      bytesBase64: bytes.toString('base64'),
      sha256: sha256(bytes),
    },
    gitPathState: {
      head: 'a'.repeat(40),
      treeEntry: { mode: '100644', hash: 'b'.repeat(40) },
      indexState: {
        entries,
        assumeUnchanged: false,
        skipWorktree: false,
      },
    },
  };
}

function moderationStateWithRepairs(repairs) {
  return {
    moderation: {
      hiddenFiles: [], bannedAgents: [], bannedIps: [], quarantinedFiles: {}, approvedFiles: {},
    },
    agentIps: {},
    gitRepairs: repairs,
  };
}

async function assertPersistedModerationRejected(t, state, label) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), `aibuilds-invalid-wal-${label}-`));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dataDir, 'moderation.json'), JSON.stringify(state));
  const script = `
    const moderation = require('./server/moderation');
    moderation.load().then(() => process.exit(42), () => process.exit(0));
  `;
  await execFileAsync(process.execPath, ['-e', script], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, AIBUILDS_DATA_DIR: dataDir },
  });
}

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

test('persisted Git repair records reject malformed or over-limit security state', async (t) => {
  const cases = [
    {
      name: 'missing-file-state',
      build() {
        const repair = validGitRepair();
        delete repair.fileState;
        return moderationStateWithRepairs({ [repair.filePath]: repair });
      },
    },
    {
      name: 'noncanonical-map-path',
      build() {
        const repair = validGitRepair();
        return moderationStateWithRepairs({ 'pages//recover.html': repair });
      },
    },
    {
      name: 'noncanonical-record-path',
      build() {
        const repair = validGitRepair();
        repair.filePath = 'pages\\recover.html';
        return moderationStateWithRepairs({ 'pages/recover.html': repair });
      },
    },
    {
      name: 'private-record-path',
      build() {
        const repair = validGitRepair();
        repair.filePath = 'pages/.private/recover.html';
        return moderationStateWithRepairs({ 'pages/.private/recover.html': repair });
      },
    },
    {
      name: 'invalid-base64',
      build() {
        const repair = validGitRepair();
        repair.fileState.bytesBase64 = 'not+base64$';
        return moderationStateWithRepairs({ [repair.filePath]: repair });
      },
    },
    {
      name: 'noncanonical-base64',
      build() {
        const repair = validGitRepair();
        repair.fileState.bytesBase64 = 'YQ';
        repair.fileState.sha256 = sha256(Buffer.from('a'));
        return moderationStateWithRepairs({ [repair.filePath]: repair });
      },
    },
    {
      name: 'file-hash-mismatch',
      build() {
        const repair = validGitRepair();
        repair.fileState.sha256 = '0'.repeat(64);
        return moderationStateWithRepairs({ [repair.filePath]: repair });
      },
    },
    {
      name: 'file-over-500kb',
      build() {
        const repair = validGitRepair('pages/oversize.html', {
          bytes: Buffer.alloc(MAX_REPAIR_FILE_BYTES + 1, 0x61),
        });
        return moderationStateWithRepairs({ [repair.filePath]: repair });
      },
    },
    {
      name: 'over-5000-agent-ips',
      build() {
        const agentIps = Array.from({ length: MAX_REPAIR_AGENT_IPS + 1 }, (_, index) => [
          `Agent${index}`,
          `198.18.${Math.floor(index / 256)}.${index % 256}`,
        ]);
        const repair = validGitRepair('pages/too-many-ips.html', { agentIps });
        return moderationStateWithRepairs({ [repair.filePath]: repair });
      },
    },
    {
      name: 'unbounded-agent-ip-string',
      build() {
        const repair = validGitRepair('pages/long-agent.html', {
          agentIps: [['A'.repeat(101), '203.0.113.10']],
        });
        return moderationStateWithRepairs({ [repair.filePath]: repair });
      },
    },
    {
      name: 'invalid-agent-ip',
      build() {
        const repair = validGitRepair('pages/invalid-ip.html', {
          agentIps: [['RecoveryAgent', 'not-an-ip']],
        });
        return moderationStateWithRepairs({ [repair.filePath]: repair });
      },
    },
    {
      name: 'over-four-index-entries',
      build() {
        const entries = Array.from({ length: 5 }, (_, index) => ({
          mode: '100644', hash: String(index + 1).repeat(40), stage: index % 4,
        }));
        const repair = validGitRepair('pages/too-many-index-entries.html', { entries });
        return moderationStateWithRepairs({ [repair.filePath]: repair });
      },
    },
    {
      name: 'invalid-index-stage',
      build() {
        const repair = validGitRepair();
        repair.gitPathState.indexState.entries[0].stage = 4;
        return moderationStateWithRepairs({ [repair.filePath]: repair });
      },
    },
    {
      name: 'duplicate-index-stage',
      build() {
        const repair = validGitRepair('pages/duplicate-stage.html', {
          entries: [
            { mode: '100644', hash: '1'.repeat(40), stage: 1 },
            { mode: '100644', hash: '2'.repeat(40), stage: 1 },
          ],
        });
        return moderationStateWithRepairs({ [repair.filePath]: repair });
      },
    },
    {
      name: 'stage-zero-with-conflict-stages',
      build() {
        const repair = validGitRepair('pages/mixed-stages.html', {
          entries: [
            { mode: '100644', hash: '1'.repeat(40), stage: 0 },
            { mode: '100644', hash: '2'.repeat(40), stage: 1 },
          ],
        });
        return moderationStateWithRepairs({ [repair.filePath]: repair });
      },
    },
    {
      name: 'noncanonical-index-stage-order',
      build() {
        const repair = validGitRepair('pages/stage-order.html', {
          entries: [
            { mode: '100644', hash: '2'.repeat(40), stage: 2 },
            { mode: '100644', hash: '1'.repeat(40), stage: 1 },
          ],
        });
        return moderationStateWithRepairs({ [repair.filePath]: repair });
      },
    },
    {
      name: 'index-flags-without-stage-zero',
      build() {
        const repair = validGitRepair('pages/conflict-flags.html', {
          entries: [
            { mode: '100644', hash: '1'.repeat(40), stage: 1 },
            { mode: '100644', hash: '2'.repeat(40), stage: 2 },
          ],
        });
        repair.gitPathState.indexState.skipWorktree = true;
        return moderationStateWithRepairs({ [repair.filePath]: repair });
      },
    },
    {
      name: 'invalid-index-flags',
      build() {
        const repair = validGitRepair();
        repair.gitPathState.indexState.assumeUnchanged = 'false';
        return moderationStateWithRepairs({ [repair.filePath]: repair });
      },
    },
    {
      name: 'invalid-index-mode',
      build() {
        const repair = validGitRepair();
        repair.gitPathState.indexState.entries[0].mode = '777777';
        return moderationStateWithRepairs({ [repair.filePath]: repair });
      },
    },
    {
      name: 'invalid-object-hash',
      build() {
        const repair = validGitRepair();
        repair.gitPathState.head = 'g'.repeat(40);
        return moderationStateWithRepairs({ [repair.filePath]: repair });
      },
    },
    {
      name: 'unbounded-reasons-array',
      build() {
        const repair = validGitRepair();
        repair.publicationState.quarantine = {
          filePath: repair.filePath,
          contentHash: 'c'.repeat(64),
          reasons: Array.from({ length: 17 }, (_, index) => `reason-${index}`),
          agentName: 'RecoveryAgent',
          timestamp: '2026-08-10T12:00:00.000Z',
        };
        return moderationStateWithRepairs({ [repair.filePath]: repair });
      },
    },
    {
      name: 'unbounded-transaction-id',
      build() {
        const repair = validGitRepair();
        repair.contributionId = 'x'.repeat(129);
        return moderationStateWithRepairs({ [repair.filePath]: repair });
      },
    },
    {
      name: 'over-1000-repair-records',
      build() {
        const repairs = {};
        for (let index = 0; index < MAX_REPAIR_RECORDS + 1; index++) {
          const filePath = `pages/recover-${index}.html`;
          repairs[filePath] = validGitRepair(filePath);
        }
        return moderationStateWithRepairs(repairs);
      },
    },
    {
      name: 'aggregate-repair-bytes-over-limit',
      build() {
        const repairs = {};
        const bytesPerRepair = Buffer.alloc(MAX_REPAIR_FILE_BYTES, 0x61);
        const repairCount = Math.floor(MAX_TOTAL_REPAIR_FILE_BYTES / MAX_REPAIR_FILE_BYTES) + 1;
        for (let index = 0; index < repairCount; index++) {
          const filePath = `pages/aggregate-${index}.html`;
          repairs[filePath] = validGitRepair(filePath, { bytes: bytesPerRepair, agentIps: [] });
        }
        return moderationStateWithRepairs(repairs);
      },
    },
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, async (t) => {
      await assertPersistedModerationRejected(t, fixture.build(), fixture.name);
    });
  }
});

test('valid Git repair boundary values round-trip without truncating recovery state', () => {
  const bytes = Buffer.alloc(MAX_REPAIR_FILE_BYTES, 0x61);
  const agentIps = Array.from({ length: MAX_REPAIR_AGENT_IPS }, (_, index) => [
    `Agent${index}`,
    `198.18.${Math.floor(index / 256)}.${index % 256}`,
  ]);
  const entries = [1, 2, 3].map(stage => ({
    mode: '100644', hash: String(stage + 1).repeat(40), stage,
  }));
  const repair = validGitRepair('pages/boundary.html', { bytes, agentIps, entries });

  mod.loadModeration(moderationStateWithRepairs({ [repair.filePath]: repair }));
  const serialized = mod.serializeModeration();
  assert.equal(serialized.gitRepairs[repair.filePath].fileState.bytesBase64, bytes.toString('base64'));
  assert.equal(serialized.gitRepairs[repair.filePath].fileState.sha256, sha256(bytes));
  assert.equal(serialized.gitRepairs[repair.filePath].agentIps.length, MAX_REPAIR_AGENT_IPS);
  assert.equal(serialized.gitRepairs[repair.filePath].gitPathState.indexState.entries.length, 3);

  mod.loadModeration(serialized);
  const recovered = mod.getGitRepair(repair.filePath);
  assert.equal(recovered.fileState.sha256, sha256(bytes));
  assert.equal(recovered.agentIps.length, MAX_REPAIR_AGENT_IPS);
  assert.equal(recovered.gitPathState.indexState.entries.length, 3);
});

test('exactly 1000 persisted Git repair records load without silent truncation', () => {
  const repairs = {};
  for (let index = 0; index < MAX_REPAIR_RECORDS; index++) {
    const filePath = `pages/boundary-${index}.html`;
    repairs[filePath] = validGitRepair(filePath, { agentIps: [] });
  }
  mod.loadModeration(moderationStateWithRepairs(repairs));
  assert.equal(mod.listGitRepairs().length, MAX_REPAIR_RECORDS);
  assert.equal(Object.keys(mod.serializeModeration().gitRepairs).length, MAX_REPAIR_RECORDS);
});

test('oversized moderation state is rejected before its bytes are read or parsed', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aibuilds-oversize-moderation-file-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const moderationPath = path.join(dataDir, 'moderation.json');
  const readObservedPath = path.join(dataDir, 'read-observed');
  await fs.writeFile(moderationPath, '');
  await fs.truncate(moderationPath, MAX_MODERATION_FILE_BYTES + 1);
  const script = `
    const fs = require('node:fs');
    const originalReadFile = fs.promises.readFile.bind(fs.promises);
    fs.promises.readFile = async function observeRead(filePath, ...args) {
      if (String(filePath) === process.env.AIBUILDS_MODERATION_TARGET) {
        fs.writeFileSync(process.env.AIBUILDS_READ_OBSERVED, 'read');
      }
      return originalReadFile(filePath, ...args);
    };
    const moderation = require('./server/moderation');
    moderation.load().then(
      () => process.exit(42),
      error => process.exit(error && error.code === 'ERR_MODERATION_FILE_TOO_LARGE' &&
        !fs.existsSync(process.env.AIBUILDS_READ_OBSERVED) ? 0 : 43),
    );
  `;
  await execFileAsync(process.execPath, ['-e', script], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      AIBUILDS_DATA_DIR: dataDir,
      AIBUILDS_MODERATION_TARGET: moderationPath,
      AIBUILDS_READ_OBSERVED: readObservedPath,
    },
  });
});

test('malformed persisted Git repair state exits before the HTTP server listens', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aibuilds-invalid-wal-startup-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const worldDir = path.join(root, 'world');
  const dataDir = path.join(root, 'data');
  const backupDir = path.join(root, 'backups');
  await fs.mkdir(worldDir, { recursive: true });
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(path.join(dataDir, 'state.json'), JSON.stringify({ history: [] }));
  const repair = validGitRepair();
  delete repair.fileState;
  await fs.writeFile(
    path.join(dataDir, 'moderation.json'),
    JSON.stringify(moderationStateWithRepairs({ [repair.filePath]: repair })),
  );

  await assert.rejects(execFileAsync(process.execPath, ['server/index.js'], {
    cwd: path.join(__dirname, '..'),
    timeout: 3000,
    env: {
      ...process.env,
      PORT: '0',
      AIBUILDS_WORLD_DIR: worldDir,
      AIBUILDS_DATA_DIR: dataDir,
      AIBUILDS_BACKUP_DIR: backupDir,
    },
  }), error => {
    assert.notEqual(error.killed, true, 'server listened until the test timeout instead of failing startup');
    assert.equal(error.code, 1);
    assert.doesNotMatch(error.stdout || '', /Server:\s+http:/);
    return true;
  });
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

test('missing moderation and legacy files initialize empty state', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aibuilds-moderation-empty-load-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const script = `
    const moderation = require('./server/moderation');
    moderation.load().then(() => {
      const state = moderation.serializeModeration();
      const empty = moderation.listQuarantined().length === 0 &&
        Object.keys(state.moderation.approvedFiles).length === 0;
      process.exit(empty ? 0 : 42);
    }, () => process.exit(43));
  `;
  await execFileAsync(process.execPath, ['-e', script], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, AIBUILDS_DATA_DIR: dataDir },
  });
});

test('malformed legacy moderation state aborts load', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aibuilds-moderation-malformed-legacy-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dataDir, 'state.json'), '{ malformed legacy JSON');
  const script = `
    const moderation = require('./server/moderation');
    moderation.load().then(() => process.exit(42), () => process.exit(0));
  `;
  await execFileAsync(process.execPath, ['-e', script], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, AIBUILDS_DATA_DIR: dataDir },
  });
});

test('non-ENOENT legacy moderation read failures abort load', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aibuilds-moderation-legacy-read-failure-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const script = `
    const fs = require('node:fs').promises;
    const originalReadFile = fs.readFile.bind(fs);
    fs.readFile = (target, ...args) => String(target).endsWith('/state.json')
      ? Promise.reject(Object.assign(new Error('forced legacy read failure'), { code: 'EACCES' }))
      : originalReadFile(target, ...args);
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
