'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const { resolveAgentName } = require('../mcp/identity');

const FIXED_UUID = '12345678-aaaa-bbbb-cccc-123456789012';

async function waitForPath(filePath) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try { await fs.access(filePath); return; } catch { /* retry */ }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

function startConcurrentResolver({ home, uuid, signalPath, releasePath }) {
  const script = String.raw`
    const fs = require('node:fs/promises');
    const { resolveAgentName } = require(process.env.IDENTITY_MODULE);
    const instrumentedFs = {
      ...fs,
      async writeFile(filePath, data, options) {
        if (!String(filePath).includes('agent-id')) return fs.writeFile(filePath, data, options);
        const handle = await fs.open(filePath, options.flag, options.mode);
        try {
          await fs.writeFile(process.env.IDENTITY_SIGNAL, 'ready');
          while (true) {
            try { await fs.access(process.env.IDENTITY_RELEASE); break; }
            catch { await new Promise(resolve => setTimeout(resolve, 5)); }
          }
          await handle.writeFile(data);
        } finally {
          await handle.close();
        }
      },
    };
    resolveAgentName({
      env: {},
      homedir: () => process.env.IDENTITY_HOME,
      fsImpl: instrumentedFs,
      randomUUID: () => process.env.IDENTITY_UUID,
      warn: message => process.stderr.write(message + '\n'),
    }).then(name => process.stdout.write(name), error => {
      process.stderr.write(error.stack + '\n');
      process.exitCode = 1;
    });
  `;
  const child = spawn(process.execPath, ['-e', script], {
    env: {
      ...process.env,
      IDENTITY_MODULE: path.join(__dirname, '../mcp/identity.js'),
      IDENTITY_HOME: home,
      IDENTITY_UUID: uuid,
      IDENTITY_SIGNAL: signalPath,
      IDENTITY_RELEASE: releasePath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', chunk => stdout.push(String(chunk)));
  child.stderr.on('data', chunk => stderr.push(String(chunk)));
  const completion = once(child, 'exit');
  return {
    child,
    async result() {
      const [code, signal] = await completion;
      assert.equal(code, 0, `${signal || ''}\n${stderr.join('')}`);
      return { name: stdout.join(''), warnings: stderr.join('') };
    },
  };
}

test('AGENT_NAME wins without touching identity storage', async () => {
  // Mutation caught: resolving disk identity before the explicit environment override performs I/O.
  const diskTrap = new Proxy({}, {
    get() {
      throw new Error('identity storage must not be touched');
    },
  });

  const name = await resolveAgentName({
    env: { AGENT_NAME: '  Explicit-Agent  ' },
    homedir: () => '/must/not/be/read',
    fsImpl: diskTrap,
    randomUUID: () => FIXED_UUID,
    warn: () => assert.fail('explicit identity must not warn'),
  });

  assert.equal(name, 'Explicit-Agent');
});

test('unnamed identity is persisted privately and reused', async (t) => {
  // Mutation caught: regenerating instead of reading agent-id produces two identities across starts.
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'aibuilds-mcp-identity-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  let generated = 0;

  const first = await resolveAgentName({
    env: {},
    homedir: () => home,
    fsImpl: fs,
    randomUUID: () => {
      generated += 1;
      return FIXED_UUID;
    },
    warn: () => assert.fail('successful persistence must not warn'),
    hostname: () => 'secret-hostname',
    username: () => 'secret-username',
  });
  const second = await resolveAgentName({
    env: {},
    homedir: () => home,
    fsImpl: fs,
    randomUUID: () => {
      generated += 1;
      return '87654321-aaaa-bbbb-cccc-123456789012';
    },
    warn: () => assert.fail('stored identity must not warn'),
    hostname: () => 'secret-hostname',
    username: () => 'secret-username',
  });

  const identityPath = path.join(home, '.aibuilds', 'agent-id');
  const [stored, directoryStat, fileStat] = await Promise.all([
    fs.readFile(identityPath, 'utf8'),
    fs.stat(path.dirname(identityPath)),
    fs.stat(identityPath),
  ]);
  assert.equal(first, 'Agent-12345678');
  assert.equal(second, first);
  assert.equal(stored.trim(), first);
  assert.equal(generated, 1);
  assert.equal(directoryStat.mode & 0o777, 0o700);
  assert.equal(fileStat.mode & 0o777, 0o600);
  assert.equal(`${first}${second}`.includes('secret-hostname'), false);
  assert.equal(`${first}${second}`.includes('secret-username'), false);
});

test('denied identity-file write uses one cached process fallback and warns once', async (t) => {
  // Mutation caught: uncached fallback generation emits two identities and two warnings.
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'aibuilds-mcp-denied-write-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  let generated = 0;
  const warnings = [];
  const deniedFs = {
    ...fs,
    async writeFile() { throw Object.assign(new Error('denied'), { code: 'EACCES' }); },
  };
  const options = {
    env: {},
    homedir: () => home,
    fsImpl: deniedFs,
    randomUUID: () => {
      generated += 1;
      return generated === 1 ? FIXED_UUID : '87654321-aaaa-bbbb-cccc-123456789012';
    },
    warn: message => warnings.push(message),
    hostname: () => 'secret-hostname',
    username: () => 'secret-username',
  };

  const first = await resolveAgentName(options);
  const second = await resolveAgentName(options);

  assert.equal(first, 'Agent-12345678');
  assert.equal(second, first);
  assert.equal(new Set([first, second]).size, 1);
  assert.equal(generated, 1);
  assert.equal(warnings.length, 1);
  assert.equal(first.includes('secret-hostname'), false);
  assert.equal(first.includes('secret-username'), false);
});

test('concurrent processes publish one complete identity without exposing a partial winner', async (t) => {
  // Mutation caught: writing directly to the final identity path lets a loser read partial bytes
  // or replace the winner, producing two names across concurrently starting MCP processes.
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'aibuilds-mcp-identity-race-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const firstSignal = path.join(home, 'first-ready');
  const secondSignal = path.join(home, 'second-ready');
  const releasePath = path.join(home, 'release');

  const first = startConcurrentResolver({
    home,
    uuid: '11111111-aaaa-bbbb-cccc-123456789012',
    signalPath: firstSignal,
    releasePath,
  });
  t.after(() => { if (first.child.exitCode === null) first.child.kill('SIGTERM'); });
  await waitForPath(firstSignal);

  const second = startConcurrentResolver({
    home,
    uuid: '22222222-aaaa-bbbb-cccc-123456789012',
    signalPath: secondSignal,
    releasePath,
  });
  t.after(() => { if (second.child.exitCode === null) second.child.kill('SIGTERM'); });
  await waitForPath(secondSignal);
  await fs.writeFile(releasePath, 'go');

  const [firstResult, secondResult] = await Promise.all([first.result(), second.result()]);
  const stored = (await fs.readFile(path.join(home, '.aibuilds', 'agent-id'), 'utf8')).trim();
  assert.equal(firstResult.name, stored);
  assert.equal(secondResult.name, stored);
  assert.equal(new Set([firstResult.name, secondResult.name, stored]).size, 1);
  assert.equal(firstResult.warnings, '');
  assert.equal(secondResult.warnings, '');
  assert.deepEqual(await fs.readdir(path.join(home, '.aibuilds')), ['agent-id']);
});

test('concurrent processes replace one invalid stored identity with one shared winner', async (t) => {
  // Mutation caught: independently renaming candidate temps over an invalid identity lets two
  // recovery processes return different names even though only the last rename remains stored.
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'aibuilds-mcp-invalid-race-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const identityDirectory = path.join(home, '.aibuilds');
  await fs.mkdir(identityDirectory, { mode: 0o700 });
  await fs.writeFile(path.join(identityDirectory, 'agent-id'), '\n', { mode: 0o600 });
  const firstSignal = path.join(home, 'first-ready');
  const secondSignal = path.join(home, 'second-ready');
  const releasePath = path.join(home, 'release');

  const first = startConcurrentResolver({
    home,
    uuid: '33333333-aaaa-bbbb-cccc-123456789012',
    signalPath: firstSignal,
    releasePath,
  });
  t.after(() => { if (first.child.exitCode === null) first.child.kill('SIGTERM'); });
  await waitForPath(firstSignal);

  const second = startConcurrentResolver({
    home,
    uuid: '44444444-aaaa-bbbb-cccc-123456789012',
    signalPath: secondSignal,
    releasePath,
  });
  t.after(() => { if (second.child.exitCode === null) second.child.kill('SIGTERM'); });
  await waitForPath(secondSignal);
  await fs.writeFile(releasePath, 'go');

  const [firstResult, secondResult] = await Promise.all([first.result(), second.result()]);
  const stored = (await fs.readFile(path.join(identityDirectory, 'agent-id'), 'utf8')).trim();
  assert.equal(firstResult.name, stored);
  assert.equal(secondResult.name, stored);
  assert.equal(new Set([firstResult.name, secondResult.name, stored]).size, 1);
  assert.equal(firstResult.warnings, '');
  assert.equal(secondResult.warnings, '');
  assert.deepEqual((await fs.readdir(identityDirectory)).sort(), ['agent-id', 'agent-id.recovery']);
  const [recoveryName, recoveryStat] = await Promise.all([
    fs.readFile(path.join(identityDirectory, 'agent-id.recovery'), 'utf8'),
    fs.stat(path.join(identityDirectory, 'agent-id.recovery')),
  ]);
  assert.equal(recoveryName.trim(), stored);
  assert.equal(recoveryStat.mode & 0o777, 0o600);
});
