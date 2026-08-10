'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const WebSocket = require('ws');

const {
  getSeasonId,
  getSeasonTheme,
  deriveSeason,
  buildSeasonArchive,
  buildReplay,
  buildHallOfFame,
  isSeasonComplete,
} = require('../server/seasons');

const PUBLIC_PATHS = [
  'pages/new.html',
  'pages/shared.html',
  'sections/voted.html',
];
const REPO_ROOT = path.join(__dirname, '..');

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

async function requestJson(baseUrl, requestPath, options = {}) {
  const response = await fetch(baseUrl + requestPath, options);
  let body;
  try { body = await response.json(); } catch { body = null; }
  return { response, body };
}

async function mutationRequest(baseUrl, requestPath, body) {
  const challenge = await requestJson(baseUrl, '/api/challenge');
  assert.equal(challenge.response.status, 200);
  return requestJson(baseUrl, requestPath, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Challenge-Id': challenge.body.id,
      'X-Challenge-Nonce': '0',
    },
    body: JSON.stringify(body),
  });
}

async function waitForPersistedState(statePath, predicate) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
      if (predicate(state)) return state;
    } catch { /* retry queued atomic write */ }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for persisted state');
}

async function waitForFileValue(filePath, expected) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      if ((await fs.readFile(filePath, 'utf8')) === expected) return;
    } catch { /* retry */ }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${filePath}=${expected}`);
}

function createJsonRpcClient(child, logs) {
  let nextId = 1;
  let buffer = '';
  const pending = new Map();
  child.stdout.on('data', chunk => {
    buffer += chunk.toString();
    while (buffer.includes('\n')) {
      const newline = buffer.indexOf('\n');
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); }
      catch { logs.push(`Invalid MCP stdout: ${line}\n`); continue; }
      const waiter = pending.get(message.id);
      if (!waiter) continue;
      pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
      else waiter.resolve(message.result);
    }
  });

  return {
    notify(method, params = {}) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
    },
    request(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`MCP request timed out: ${method}\n${logs.join('')}`));
        }, 8_000);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    },
  };
}

test('season IDs roll over at UTC midnight and theme selection is frozen and deterministic', () => {
  // Mutations caught: local-date conversion returns 2026-08-10 at midnight in America/Los_Angeles;
  // constant theme index 0 returns tiny-tool instead of the hand-derived SHA-256 index 4.
  assert.equal(getSeasonId(new Date('2026-08-10T23:59:59.999Z')), '2026-08-10');
  assert.equal(getSeasonId(new Date('2026-08-11T00:00:00.000Z')), '2026-08-11');
  assert.deepEqual(getSeasonTheme('2026-08-10'), {
    version: 'v1',
    id: 'remix-relay',
    title: 'Remix Relay',
    prompt: 'Take another agent’s work one meaningful step further.',
  });
  assert.deepEqual(getSeasonTheme('2026-08-03'), {
    version: 'v1',
    id: 'shared-story',
    title: 'Shared Story Day',
    prompt: 'Extend a shared story without erasing another agent’s voice.',
  });
  assert.deepEqual(getSeasonTheme('2026-08-10'), getSeasonTheme('2026-08-10'));
});

test('season roles require in-day creates, cross-agent edits, and timestamped curation events', () => {
  // Mutations caught: accepting an out-of-day create adds OldBuilder; accepting same-agent edits
  // adds Solo as Critic; deriving curators from timeless vote sets adds Phantom.
  const history = [
    { id: 'old-create', timestamp: '2026-08-09T23:59:59.999Z', agent_name: 'OldBuilder', action: 'create', file_path: 'pages/old.html' },
    { id: 'new-create', timestamp: '2026-08-10T00:00:00.000Z', agent_name: 'Builder', action: 'create', file_path: 'pages/new.html' },
    { id: 'solo-edit', timestamp: '2026-08-10T01:00:00.000Z', agent_name: 'Builder', action: 'edit', file_path: 'pages/new.html' },
    { id: 'shared-create', timestamp: '2026-08-09T10:00:00.000Z', agent_name: 'Original', action: 'create', file_path: 'pages/shared.html' },
    { id: 'shared-edit', timestamp: '2026-08-10T02:00:00.000Z', agent_name: 'Critic', action: 'edit', file_path: 'pages/shared.html' },
    { id: 'private-create', timestamp: '2026-08-10T02:10:00.000Z', agent_name: 'HiddenBuilder', action: 'create', file_path: 'pages/private.html' },
    { id: 'private-original', timestamp: '2026-08-09T02:20:00.000Z', agent_name: 'HiddenOriginal', action: 'create', file_path: 'pages/private-shared.html' },
    { id: 'private-edit', timestamp: '2026-08-10T02:30:00.000Z', agent_name: 'HiddenCritic', action: 'edit', file_path: 'pages/private-shared.html' },
    { id: 'late-edit', timestamp: '2026-08-11T00:00:00.000Z', agent_name: 'LateCritic', action: 'edit', file_path: 'pages/shared.html' },
  ];
  const curationEvents = [
    { id: 'old-vote', timestamp: '2026-08-09T23:59:59.999Z', type: 'vote', agentName: 'OldCurator', target: 'sections/voted.html' },
    { id: 'vote', timestamp: '2026-08-10T03:00:00.000Z', type: 'vote', agentName: 'Curator', target: 'sections/voted.html' },
    { id: 'comment', timestamp: '2026-08-10T04:00:00.000Z', type: 'comment', agentName: 'Commenter', target: 'pages/shared.html' },
    { id: 'private-comment', timestamp: '2026-08-10T05:00:00.000Z', type: 'comment', agentName: 'PrivateCurator', target: 'pages/private.html' },
    { id: 'timeless-vote', type: 'vote', agentName: 'Phantom', target: 'sections/voted.html' },
  ];

  const season = deriveSeason({ history, curationEvents, publicPaths: PUBLIC_PATHS, seasonId: '2026-08-10' });

  assert.deepEqual(season.roles, {
    builder: ['Builder'],
    critic: ['Critic'],
    curator: ['Curator', 'Commenter'],
  });
  assert.deepEqual(season.collaborativeFiles, ['pages/shared.html']);
  assert.equal(season.isComplete, true);
  assert.equal(season.lastActivityAt, '2026-08-10T04:00:00.000Z');

  const sameAgentOnly = deriveSeason({
    history: [
      { id: 'create', timestamp: '2026-08-10T00:00:00.000Z', agent_name: 'Solo', action: 'create', file_path: 'pages/new.html' },
      { id: 'edit', timestamp: '2026-08-10T01:00:00.000Z', agent_name: 'Solo', action: 'edit', file_path: 'pages/new.html' },
    ],
    curationEvents: [],
    publicPaths: ['pages/new.html'],
    seasonId: '2026-08-10',
  });
  assert.equal(sameAgentOnly.roles.critic.length, 0);
});

test('season completeness independently requires all roles and a collaborative public file', () => {
  // Mutation caught: omitting the collaboration predicate changes false to true for three roles
  // whose only currently public files are single-agent files.
  const roles = { builder: ['Builder'], critic: ['Critic'], curator: ['Curator'] };
  assert.equal(isSeasonComplete(roles, []), false);
  assert.equal(isSeasonComplete(roles, ['pages/shared.html']), true);
  assert.equal(isSeasonComplete({ ...roles, curator: [] }, ['pages/shared.html']), false);
});

test('season archive is newest first and respects a clamped 1-50 limit', () => {
  // Mutation caught: input-order archives return 2026-08-08 first; omitting the 50 cap returns 51.
  const history = Array.from({ length: 52 }, (_, index) => {
    const timestamp = new Date(Date.UTC(2026, 5, index + 1, 12)).toISOString();
    return {
      id: `h-${index + 1}`,
      timestamp,
      agent_name: `Builder-${index + 1}`,
      action: 'create',
      file_path: 'pages/new.html',
    };
  });
  const recent = buildSeasonArchive({ history, curationEvents: [], publicPaths: ['pages/new.html'], limit: 2 });
  assert.deepEqual(recent.map(season => season.id), ['2026-07-22', '2026-07-21']);
  assert.equal(buildSeasonArchive({ history, curationEvents: [], publicPaths: ['pages/new.html'], limit: 500 }).length, 50);
  assert.equal(buildSeasonArchive({ history, curationEvents: [], publicPaths: ['pages/new.html'], limit: 0 }).length, 1);
});

test('replay returns the latest public events chronologically with truthful freshness metadata', () => {
  // Mutations caught: sorting newest-first reverses the IDs; omitting the cap returns 51 events;
  // failing to filter current public paths leaks private-event.
  const history = Array.from({ length: 51 }, (_, index) => ({
    id: `event-${index + 1}`,
    timestamp: new Date(Date.UTC(2026, 7, 10, 10, index)).toISOString(),
    agent_name: `Agent-${index + 1}`,
    action: index === 0 ? 'create' : 'edit',
    file_path: 'pages/shared.html',
    message: `Message ${index + 1}`,
  }));
  history.push({
    id: 'private-event',
    timestamp: '2026-08-10T11:00:00.000Z',
    agent_name: 'Private',
    action: 'create',
    file_path: 'pages/private.html',
    message: 'must not leak',
  });

  const replay = buildReplay({
    history,
    publicPaths: ['pages/shared.html'],
    limit: 500,
    now: new Date('2026-08-10T10:50:00.000Z'),
  });

  assert.equal(replay.events.length, 50);
  assert.equal(replay.events[0].id, 'event-2');
  assert.equal(replay.events[49].id, 'event-51');
  assert.deepEqual(replay.events[0], {
    id: 'event-2',
    timestamp: '2026-08-10T10:01:00.000Z',
    agentName: 'Agent-2',
    action: 'edit',
    filePath: 'pages/shared.html',
    message: 'Message 2',
  });
  assert.equal(replay.lastContributionAt, '2026-08-10T10:50:00.000Z');
  assert.equal(replay.isLive, true);
  assert.equal(replay.recommendedIntervalMs, 1800);
  assert.equal(buildReplay({ history, publicPaths: ['pages/shared.html'], limit: 0 }).events.length, 1);
  assert.deepEqual(buildReplay({ history: [], publicPaths: [], now: new Date('2026-08-10T12:00:00.000Z') }), {
    events: [],
    lastContributionAt: null,
    isLive: false,
    recommendedIntervalMs: 1800,
  });
});

test('Hall of Fame excludes non-public and single-agent files and sorts by votes, edits, recency, then path', () => {
  // Mutation caught: agent-count/path-only ordering puts sections/a-tie.html before the higher-voted
  // sections/z-voted.html; removing public/collaborative guards exposes private and solo paths.
  const history = [
    { id: 'z1', timestamp: '2026-08-09T08:00:00.000Z', agent_name: 'Ada', action: 'create', file_path: 'sections/z-voted.html' },
    { id: 'z2', timestamp: '2026-08-10T08:00:00.000Z', agent_name: 'Bea', action: 'edit', file_path: 'sections/z-voted.html' },
    { id: 'a1', timestamp: '2026-08-09T09:00:00.000Z', agent_name: 'Cal', action: 'create', file_path: 'sections/a-tie.html' },
    { id: 'a2', timestamp: '2026-08-10T09:00:00.000Z', agent_name: 'Dee', action: 'edit', file_path: 'sections/a-tie.html' },
    { id: 'solo', timestamp: '2026-08-10T10:00:00.000Z', agent_name: 'Solo', action: 'create', file_path: 'pages/solo.html' },
    { id: 'p1', timestamp: '2026-08-10T10:01:00.000Z', agent_name: 'HiddenA', action: 'create', file_path: 'pages/private.html' },
    { id: 'p2', timestamp: '2026-08-10T10:02:00.000Z', agent_name: 'HiddenB', action: 'edit', file_path: 'pages/private.html' },
  ];
  const sectionVotes = new Map([
    ['sections/z-voted.html', { up: new Set(['V1', 'V2']), down: new Set() }],
    ['sections/a-tie.html', { up: new Set(['V1']), down: new Set() }],
    ['pages/private.html', { up: new Set(['V1', 'V2', 'V3']), down: new Set() }],
  ]);

  const hall = buildHallOfFame({
    history,
    publicPaths: ['sections/z-voted.html', 'sections/a-tie.html', 'pages/solo.html'],
    sectionVotes,
  });

  assert.deepEqual(hall, [
    {
      filePath: 'sections/z-voted.html',
      agents: ['Ada', 'Bea'],
      voteScore: 2,
      crossAgentEdits: 1,
      lastActivityAt: '2026-08-10T08:00:00.000Z',
    },
    {
      filePath: 'sections/a-tie.html',
      agents: ['Cal', 'Dee'],
      voteScore: 1,
      crossAgentEdits: 1,
      lastActivityAt: '2026-08-10T09:00:00.000Z',
    },
  ]);
  assert.doesNotThrow(() => JSON.stringify(hall));
});

test('real server persists bounded curation events and exposes only public Season, archive, replay, and Hall data', async (t) => {
  // Mutations caught: omitting the save-time cap persists 1001 events instead of 1000;
  // accepting removed/private votes adds curator evidence; raw-history APIs leak private records.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aibuilds-seasons-'));
  const worldDir = path.join(root, 'world');
  const dataDir = path.join(root, 'data');
  const backupDir = path.join(root, 'backups');
  const statePath = path.join(dataDir, 'state.json');
  await Promise.all([
    fs.mkdir(path.join(worldDir, 'pages'), { recursive: true }),
    fs.mkdir(path.join(worldDir, 'sections'), { recursive: true }),
    fs.mkdir(dataDir, { recursive: true }),
    fs.mkdir(backupDir, { recursive: true }),
  ]);
  await Promise.all([
    fs.writeFile(path.join(worldDir, 'pages/new.html'), '<div data-page-title="New"><h1>New</h1></div>'),
    fs.writeFile(path.join(worldDir, 'pages/shared.html'), '<div data-page-title="Shared"><h1>Shared</h1></div>'),
    fs.writeFile(path.join(worldDir, 'sections/voted.html'), '<section data-section-title="Voted"><h2>Voted</h2></section>'),
    fs.writeFile(path.join(worldDir, 'sections/private.html'), '<section><p>Inject 2 mg weekly for best results.</p></section>'),
    fs.writeFile(path.join(worldDir, 'PROJECT.md'), '# Test plan\n'),
  ]);

  const now = new Date();
  const today = getSeasonId(now);
  const previousDay = getSeasonId(new Date(Date.parse(`${today}T00:00:00.000Z`) - 1));
  const history = [
    {
      id: 'old-shared', timestamp: `${previousDay}T12:00:00.000Z`, agent_name: 'Original',
      action: 'create', file_path: 'pages/shared.html', message: 'original',
      publicationStatus: 'published', reactions: { fire: [], heart: [], rocket: [], eyes: [] }, commentCount: 0,
    },
    {
      id: 'today-builder', timestamp: `${today}T00:30:00.000Z`, agent_name: 'Builder',
      action: 'create', file_path: 'pages/new.html', message: 'new page',
      publicationStatus: 'published', reactions: { fire: [], heart: [], rocket: [], eyes: [] }, commentCount: 0,
    },
    {
      id: 'today-critic', timestamp: `${today}T01:00:00.000Z`, agent_name: 'Critic',
      action: 'edit', file_path: 'pages/shared.html', message: 'improved shared page',
      publicationStatus: 'published', reactions: { fire: [], heart: [], rocket: [], eyes: [] }, commentCount: 0,
    },
    {
      id: 'private-original', timestamp: `${previousDay}T13:00:00.000Z`, agent_name: 'PrivateA',
      action: 'create', file_path: 'sections/private.html', message: 'private',
      publicationStatus: 'published', reactions: { fire: [], heart: [], rocket: [], eyes: [] }, commentCount: 0,
    },
    {
      id: 'private-edit', timestamp: `${today}T02:00:00.000Z`, agent_name: 'PrivateB',
      action: 'edit', file_path: 'sections/private.html', message: 'must not leak',
      publicationStatus: 'published', reactions: { fire: [], heart: [], rocket: [], eyes: [] }, commentCount: 0,
    },
  ];
  const curationEvents = Array.from({ length: 1000 }, (_, index) => ({
    id: `seed-${index + 1}`,
    timestamp: `${previousDay}T12:00:00.000Z`,
    type: 'comment',
    agentName: 'SeedCurator',
    target: 'sections/voted.html',
  }));
  curationEvents.push(
    { id: 'invalid-type', timestamp: `${today}T03:00:00.000Z`, type: 'reaction', agentName: 'Invalid', target: 'sections/voted.html' },
    { id: 'invalid-timestamp', type: 'vote', agentName: 'Invalid', target: 'sections/voted.html' },
  );
  await fs.writeFile(statePath, JSON.stringify({ history, curationEvents, sectionVotes: {} }));

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

  let result = await mutationRequest(baseUrl, '/api/vote', {
    agent_name: 'VoteCurator', section_file: 'sections/voted.html', vote: 'up',
  });
  assert.equal(result.response.status, 200, logs.join(''));
  assert.equal(result.body.action, 'upvoted');

  let persisted = await waitForPersistedState(statePath, state =>
    state.curationEvents?.some(event => event.agentName === 'VoteCurator'));
  assert.equal(persisted.curationEvents.length, 1000);
  assert.equal(persisted.curationEvents[0].id, 'seed-2');
  assert.equal(persisted.curationEvents.filter(event => event.agentName === 'VoteCurator').length, 1);
  assert.equal(persisted.curationEvents.some(event => event.id.startsWith('invalid-')), false);

  result = await mutationRequest(baseUrl, '/api/vote', {
    agent_name: 'VoteCurator', section_file: 'sections/voted.html', vote: 'up',
  });
  assert.equal(result.response.status, 200, logs.join(''));
  assert.equal(result.body.action, 'removed_upvote');
  persisted = await waitForPersistedState(statePath, state => state.sectionVotes?.['sections/voted.html']?.up?.length === 0);
  assert.equal(persisted.curationEvents.filter(event => event.agentName === 'VoteCurator').length, 1);

  result = await mutationRequest(baseUrl, '/api/vote', {
    agent_name: 'PrivateCurator', section_file: 'sections/private.html', vote: 'up',
  });
  assert.equal(result.response.status, 404, logs.join(''));

  result = await mutationRequest(baseUrl, '/api/contributions/today-critic/comments', {
    agent_name: 'CommentCurator', content: 'Useful improvement.',
  });
  assert.equal(result.response.status, 200, logs.join(''));
  result = await mutationRequest(baseUrl, '/api/files/sections/voted.html/comments', {
    agent_name: 'FileCurator', content: 'Consider clearer labels.',
  });
  assert.equal(result.response.status, 200, logs.join(''));
  persisted = await waitForPersistedState(statePath, state =>
    state.curationEvents?.some(event => event.agentName === 'FileCurator'));
  assert.equal(persisted.curationEvents.length, 1000);
  assert.deepEqual(persisted.curationEvents.slice(-2).map(event => [event.type, event.agentName, event.target]), [
    ['comment', 'CommentCurator', 'pages/shared.html'],
    ['comment', 'FileCurator', 'sections/voted.html'],
  ]);

  const [currentSeason, archive, replay, replayMin, discovery] = await Promise.all([
    requestJson(baseUrl, '/api/season/current'),
    requestJson(baseUrl, '/api/seasons?limit=500'),
    requestJson(baseUrl, '/api/replay?limit=500'),
    requestJson(baseUrl, '/api/replay?limit=0'),
    requestJson(baseUrl, '/api'),
  ]);
  assert.equal(currentSeason.response.status, 200, logs.join(''));
  assert.equal(currentSeason.body.id, today);
  assert.deepEqual(currentSeason.body.roles.builder, ['Builder']);
  assert.deepEqual(currentSeason.body.roles.critic, ['Critic']);
  assert.deepEqual(currentSeason.body.roles.curator, ['VoteCurator', 'CommentCurator', 'FileCurator']);
  assert.deepEqual(currentSeason.body.collaborativeFiles, ['pages/shared.html']);
  assert.equal(currentSeason.body.isComplete, true);
  assert.deepEqual(currentSeason.body.hallOfFame.map(entry => entry.filePath), ['pages/shared.html']);
  assert.equal(JSON.stringify(currentSeason.body).includes('sections/private.html'), false);

  assert.equal(archive.response.status, 200, logs.join(''));
  assert.ok(archive.body.seasons.length >= 1 && archive.body.seasons.length <= 50);
  assert.deepEqual([...archive.body.seasons.map(season => season.id)].sort().reverse(),
    archive.body.seasons.map(season => season.id));
  assert.ok(archive.body.seasons.every(season => Array.isArray(season.hallOfFame)));

  assert.equal(replay.response.status, 200, logs.join(''));
  assert.deepEqual(replay.body.events.map(event => event.id), ['old-shared', 'today-builder', 'today-critic']);
  assert.equal(JSON.stringify(replay.body).includes('private-edit'), false);
  assert.equal(replay.body.recommendedIntervalMs, 1800);
  assert.equal(replayMin.body.events.length, 1);
  assert.equal(replayMin.body.events[0].id, 'today-critic');
  assert.equal(discovery.body.endpoints.currentSeason, '/api/season/current');
  assert.equal(discovery.body.endpoints.seasons, '/api/seasons?limit=30');
  assert.equal(discovery.body.endpoints.replay, '/api/replay?limit=50');

  const mcpLogs = [];
  const mcp = spawn(process.execPath, ['mcp/index.js'], {
    cwd: REPO_ROOT,
    env: { ...process.env, AI_BUILDS_URL: baseUrl, AGENT_NAME: 'Context-Agent' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  mcp.stderr.on('data', chunk => mcpLogs.push(chunk.toString()));
  t.after(async () => {
    if (mcp.exitCode === null) mcp.kill('SIGTERM');
    if (mcp.exitCode === null) await once(mcp, 'exit');
  });
  const rpc = createJsonRpcClient(mcp, mcpLogs);
  await rpc.request('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'season-test', version: '1.0.0' },
  });
  rpc.notify('notifications/initialized');
  const context = await rpc.request('tools/call', { name: 'aibuilds_get_context', arguments: {} });
  const contextText = context.content[0].text;
  assert.match(contextText, new RegExp(`Today\\'s Season: ${currentSeason.body.theme.title}`));
  assert.match(contextText, /Role vacancies:/);
  assert.match(contextText, /Collaborative file candidates:[\s\S]*pages\/shared\.html/);
  assert.match(contextText, /Latest replay events:[\s\S]*Critic/);
  assert.match(contextText, /Critic edited pages\/shared\.html/);
  assert.match(contextText, /Improve another agent's existing work before starting another isolated page\./);
  assert.match(contextText, /Optional theme prompt \(suggestion, not a requirement\):/);
});

test('curation mutations roll back on state failure and serialize a failed A before successful B', async (t) => {
  // Mutations caught: fire-and-forget saves return 200 and leak Curator/broadcast state; removing
  // the shared mutation lock lets B settle while A's failed provisional state is still active.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aibuilds-curation-atomic-'));
  const worldDir = path.join(root, 'world');
  const dataDir = path.join(root, 'data');
  const backupDir = path.join(root, 'backups');
  const statePath = path.join(dataDir, 'state.json');
  const armPath = path.join(root, 'arm-state-failure');
  const markerPath = path.join(root, 'state-failure-marker');
  const releasePath = path.join(root, 'release-state-failure');
  const preloadPath = path.join(root, 'fail-state-rename.cjs');
  await Promise.all([
    fs.mkdir(path.join(worldDir, 'pages'), { recursive: true }),
    fs.mkdir(path.join(worldDir, 'sections'), { recursive: true }),
    fs.mkdir(dataDir, { recursive: true }),
    fs.mkdir(backupDir, { recursive: true }),
  ]);
  await Promise.all([
    fs.writeFile(path.join(worldDir, 'pages/shared.html'), '<div data-page-title="Shared"><h1>Shared</h1></div>'),
    fs.writeFile(path.join(worldDir, 'sections/voted.html'), '<section data-section-title="Voted"><h2>Voted</h2></section>'),
  ]);
  const today = getSeasonId(new Date());
  await fs.writeFile(statePath, JSON.stringify({
    history: [{
      id: 'public-contribution', timestamp: `${today}T00:00:00.000Z`, agent_name: 'Builder',
      action: 'create', file_path: 'pages/shared.html', message: 'public baseline',
      publicationStatus: 'published', reactions: { fire: [], heart: [], rocket: [], eyes: [] }, commentCount: 0,
    }],
    curationEvents: [],
    sectionVotes: {},
  }));
  await fs.writeFile(preloadPath, `
    const fs = require('node:fs');
    const promises = fs.promises;
    const originalRename = promises.rename.bind(promises);
    const originalWriteFile = promises.writeFile.bind(promises);
    let cycleToken = '';
    let failed = false;
    promises.rename = async function failArmedStateRename(source, target) {
      if (String(target) === process.env.AIBUILDS_STATE_TARGET &&
          fs.existsSync(process.env.AIBUILDS_STATE_ARM)) {
        const token = fs.readFileSync(process.env.AIBUILDS_STATE_ARM, 'utf8');
        if (token !== cycleToken) {
          cycleToken = token;
          failed = false;
        }
        if (!failed) {
          failed = true;
          await originalWriteFile(process.env.AIBUILDS_STATE_MARKER, token);
          if (token.endsWith('concurrent')) {
            while (!fs.existsSync(process.env.AIBUILDS_STATE_RELEASE)) {
              await new Promise(resolve => setTimeout(resolve, 10));
            }
          }
          throw Object.assign(new Error('forced curation state failure'), { code: 'EIO' });
        }
      }
      return originalRename(source, target);
    };
  `);

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
      NODE_OPTIONS: `--require=${preloadPath}`,
      AIBUILDS_STATE_TARGET: statePath,
      AIBUILDS_STATE_ARM: armPath,
      AIBUILDS_STATE_MARKER: markerPath,
      AIBUILDS_STATE_RELEASE: releasePath,
      ADMIN_RESET_SECRET: 'task-5-reset-secret',
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

  const frames = [];
  const ws = new WebSocket(baseUrl.replace('http', 'ws'));
  t.after(() => ws.close());
  await once(ws, 'open');
  await once(ws, 'message');
  ws.on('message', data => {
    try { frames.push(JSON.parse(data.toString())); } catch { /* ignore */ }
  });

  await fs.writeFile(armPath, 'vote');
  let result = await mutationRequest(baseUrl, '/api/vote', {
    agent_name: 'FailedVote', section_file: 'sections/voted.html', vote: 'up',
  });
  assert.equal(result.response.status, 500, logs.join(''));
  assert.deepEqual((await requestJson(baseUrl, '/api/votes')).body.votes['sections/voted.html'], undefined);
  assert.deepEqual((await requestJson(baseUrl, '/api/season/current')).body.roles.curator, []);

  await fs.writeFile(armPath, 'contribution-comment');
  result = await mutationRequest(baseUrl, '/api/contributions/public-contribution/comments', {
    agent_name: 'FailedComment', content: 'This must roll back.',
  });
  assert.equal(result.response.status, 500, logs.join(''));
  assert.equal((await requestJson(baseUrl, '/api/contributions/public-contribution/comments')).body.total, 0);
  assert.deepEqual((await requestJson(baseUrl, '/api/season/current')).body.roles.curator, []);

  await fs.writeFile(armPath, 'file-comment');
  result = await mutationRequest(baseUrl, '/api/files/pages/shared.html/comments', {
    agent_name: 'FailedFileComment', content: 'This must also roll back.',
  });
  assert.equal(result.response.status, 500, logs.join(''));
  assert.equal((await requestJson(baseUrl, '/api/files/pages/shared.html/comments')).body.total, 0);
  assert.deepEqual((await requestJson(baseUrl, '/api/season/current')).body.roles.curator, []);

  await fs.writeFile(armPath, 'contribution-comment-concurrent');
  await fs.rm(releasePath, { force: true });
  const failedContributionComment = mutationRequest(baseUrl, '/api/contributions/public-contribution/comments', {
    agent_name: 'FailedConcurrentComment', content: 'This concurrent comment must roll back.',
  });
  await waitForFileValue(markerPath, 'contribution-comment-concurrent');
  let contributionFollowerSettled = false;
  const contributionFollower = mutationRequest(baseUrl, '/api/vote', {
    agent_name: 'CommentFollower', section_file: 'sections/voted.html', vote: 'up',
  }).then(value => {
    contributionFollowerSettled = true;
    return value;
  });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(contributionFollowerSettled, false, 'vote must wait for contribution-comment rollback');
  await fs.writeFile(releasePath, 'release');
  const [failedContributionCommentResult, contributionFollowerResult] =
    await Promise.all([failedContributionComment, contributionFollower]);
  assert.equal(failedContributionCommentResult.response.status, 500, logs.join(''));
  assert.equal(contributionFollowerResult.response.status, 200, logs.join(''));
  assert.deepEqual((await requestJson(baseUrl, '/api/season/current')).body.roles.curator, ['CommentFollower']);

  await fs.writeFile(armPath, 'file-comment-concurrent');
  await fs.rm(releasePath, { force: true });
  const failedFileComment = mutationRequest(baseUrl, '/api/files/pages/shared.html/comments', {
    agent_name: 'FailedConcurrentFileComment', content: 'This concurrent file comment must roll back.',
  });
  await waitForFileValue(markerPath, 'file-comment-concurrent');
  let fileFollowerSettled = false;
  const fileFollower = mutationRequest(baseUrl, '/api/vote', {
    agent_name: 'FileCommentFollower', section_file: 'sections/voted.html', vote: 'down',
  }).then(value => {
    fileFollowerSettled = true;
    return value;
  });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(fileFollowerSettled, false, 'vote must wait for file-comment rollback');
  await fs.writeFile(releasePath, 'release');
  const [failedFileCommentResult, fileFollowerResult] = await Promise.all([failedFileComment, fileFollower]);
  assert.equal(failedFileCommentResult.response.status, 500, logs.join(''));
  assert.equal(fileFollowerResult.response.status, 200, logs.join(''));
  assert.deepEqual((await requestJson(baseUrl, '/api/season/current')).body.roles.curator,
    ['CommentFollower', 'FileCommentFollower']);

  await fs.writeFile(armPath, 'concurrent');
  await fs.rm(releasePath, { force: true });
  const failedA = mutationRequest(baseUrl, '/api/vote', {
    agent_name: 'FailedA', section_file: 'sections/voted.html', vote: 'up',
  });
  await waitForFileValue(markerPath, 'concurrent');
  let successfulBSettled = false;
  const successfulB = mutationRequest(baseUrl, '/api/vote', {
    agent_name: 'SuccessfulB', section_file: 'sections/voted.html', vote: 'up',
  }).then(value => {
    successfulBSettled = true;
    return value;
  });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(successfulBSettled, false, 'B must wait for A rollback and lock release');
  await fs.writeFile(releasePath, 'release');
  const [aResult, bResult] = await Promise.all([failedA, successfulB]);
  assert.equal(aResult.response.status, 500, logs.join(''));
  assert.equal(bResult.response.status, 200, logs.join(''));

  const season = (await requestJson(baseUrl, '/api/season/current')).body;
  assert.deepEqual(season.roles.curator, ['CommentFollower', 'FileCommentFollower', 'SuccessfulB']);
  const votes = (await requestJson(baseUrl, '/api/votes')).body.votes['sections/voted.html'];
  assert.deepEqual(votes, { score: 1, upvotes: 2, downvotes: 1 });
  const persisted = await waitForPersistedState(statePath, state =>
    state.curationEvents?.some(event => event.agentName === 'SuccessfulB'));
  assert.deepEqual(persisted.curationEvents.map(event => event.agentName),
    ['CommentFollower', 'FileCommentFollower', 'SuccessfulB']);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(frames.filter(frame => frame.type === 'vote').length, 3);
  assert.equal(frames.some(frame => ['comment', 'fileComment'].includes(frame.type)), false);

  await fs.writeFile(armPath, 'reset-concurrent');
  await fs.rm(releasePath, { force: true });
  const failedBeforeReset = mutationRequest(baseUrl, '/api/vote', {
    agent_name: 'FailedBeforeReset', section_file: 'sections/voted.html', vote: 'down',
  });
  await waitForFileValue(markerPath, 'reset-concurrent');
  const reset = requestJson(baseUrl, '/api/admin/reset', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: 'task-5-reset-secret' }),
  });
  await fs.writeFile(releasePath, 'release');
  const [failedBeforeResetResult, resetResult] = await Promise.all([failedBeforeReset, reset]);
  assert.equal(failedBeforeResetResult.response.status, 500, logs.join(''));
  assert.equal(resetResult.response.status, 200, logs.join(''));
  assert.deepEqual((await requestJson(baseUrl, '/api/votes')).body.votes, {});
  assert.deepEqual((await requestJson(baseUrl, '/api/season/current')).body.roles, {
    builder: [], critic: [], curator: [],
  });
  const resetState = await waitForPersistedState(statePath, state =>
    state.history?.length === 0 && state.curationEvents?.length === 0 &&
    Object.keys(state.sectionVotes || {}).length === 0);
  assert.equal(resetState.history.length, 0);
});
