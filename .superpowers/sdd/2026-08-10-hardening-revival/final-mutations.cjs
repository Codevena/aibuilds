'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '../../..');

const mutations = [
  {
    task: 1,
    name: 'dot-segment privacy guard removed',
    file: 'server/world-files.js',
    test: 'test/world-files.test.js',
    pattern: 'private and traversal paths never resolve',
    from: "if (segments.some(segment => segment.length === 0 || segment === '..' || segment.startsWith('.'))) {",
    to: "if (segments.some(segment => segment.length === 0 || segment === '..')) {",
  },
  {
    task: 2,
    name: 'medical high-stakes branch disabled',
    file: 'server/content-governance.js',
    test: 'test/content-governance.test.js',
    pattern: 'medical dosing instructions are quarantined',
    from: "return /\\binject(?:ion)?\\b[^.]{0,80}\\b\\d+(?:\\.\\d+)?\\s*(?:mg|mcg|ml|units?)\\b[^.]{0,80}\\b(?:daily|weekly|once\\s+(?:a|per)?\\s*week)\\b/i.test(text);",
    to: 'return false;',
  },
  {
    task: 3,
    name: 'moderation pre-read size cap removed',
    file: 'server/moderation.js',
    test: 'test/moderation.test.js',
    pattern: 'oversized moderation state is rejected before its bytes are read',
    from: 'if (stats.size > MAX_MODERATION_FILE_BYTES) throw moderationFileTooLargeError();',
    to: 'void stats.size;',
  },
  {
    task: 4,
    name: 'inclusive liveness boundary changed to exclusive',
    file: 'server/platform-metrics.js',
    test: 'test/platform-metrics.test.js',
    pattern: 'liveness includes exactly the 15-minute boundary',
    from: 'isLive: age >= 0 && age <= LIVE_MAX_AGE_MS,',
    to: 'isLive: age >= 0 && age < LIVE_MAX_AGE_MS,',
  },
  {
    task: 5,
    name: 'votes read removed from durability barrier',
    file: 'server/index.js',
    test: 'test/seasons.test.js',
    pattern: 'curation mutations hide provisional reads',
    from: "    requestPath === '/api/votes' ||\n",
    to: '',
  },
  {
    task: 6,
    name: 'Replay event cap raised from 50 to 51',
    file: 'public/js/replay.js',
    test: 'test/replay.test.js',
    pattern: 'the full replay payload is rejected beyond 50 events',
    from: 'if (replay.events.length > 50)',
    to: 'if (replay.events.length > 51)',
  },
  {
    task: 7,
    name: 'SEO publication threshold lowered from two agents to one',
    file: 'server/content-governance.js',
    test: 'test/seo-publication.test.js',
    pattern: 'page publication requires two visible agents',
    from: 'agentCount >= 2',
    to: 'agentCount >= 1',
  },
];

function runTest(cwd, mutation) {
  return new Promise(resolve => {
    const args = [
      '--test',
      `--test-name-pattern=${mutation.pattern}`,
      mutation.test,
    ];
    const child = spawn(process.execPath, args, {
      cwd,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const output = [];
    child.stdout.on('data', chunk => output.push(chunk.toString()));
    child.stderr.on('data', chunk => output.push(chunk.toString()));
    child.on('close', code => {
      const text = output.join('');
      const matches = Array.from(text.matchAll(/^# fail (\d+)$/gm));
      resolve({
        code,
        failures: matches.length ? Number(matches.at(-1)[1]) : null,
        output: text,
        command: `${process.execPath} ${args.map(value => JSON.stringify(value)).join(' ')}`,
      });
    });
  });
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aibuilds-final-mutations-'));
  try {
    await fs.cp(REPO_ROOT, root, {
      recursive: true,
      filter(source) {
        return !['.git', '.superpowers', 'node_modules'].includes(path.basename(source));
      },
    });
    await fs.symlink(path.join(REPO_ROOT, 'node_modules'), path.join(root, 'node_modules'), 'dir');

    const results = [];
    for (const mutation of mutations) {
      const baseline = await runTest(root, mutation);
      assert.equal(baseline.code, 0,
        `Task ${mutation.task} baseline failed:\n${baseline.output}`);
      assert.equal(baseline.failures, 0);

      const target = path.join(root, mutation.file);
      const source = await fs.readFile(target, 'utf8');
      assert.equal(source.split(mutation.from).length - 1, 1,
        `Task ${mutation.task} mutation target was not unique`);
      await fs.writeFile(target, source.replace(mutation.from, mutation.to));
      const mutant = await runTest(root, mutation);
      await fs.writeFile(target, source);
      assert.notEqual(mutant.code, 0,
        `Task ${mutation.task} mutant survived:\n${mutant.output}`);
      assert.ok(mutant.failures >= 1,
        `Task ${mutation.task} mutant did not report a test failure:\n${mutant.output}`);
      results.push({
        task: mutation.task,
        mutation: mutation.name,
        command: mutant.command,
        withoutFailures: baseline.failures,
        withFailures: mutant.failures,
      });
    }
    process.stdout.write(`${JSON.stringify({ score: `${results.length}/${results.length}`, results }, null, 2)}\n`);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
