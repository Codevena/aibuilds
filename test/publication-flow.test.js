'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { once } = require('node:events');
const WebSocket = require('ws');
const { evaluatePublication, contentHash } = require('../server/content-governance');
const { listWorldFiles } = require('../server/world-files');
const {
  decideStoredPublication,
  buildContributionResponse,
  auditWorldForQuarantine,
  isPublicContribution,
  derivePublicAgentState,
} = require('../server/publication-flow');

const safeContent = '<main><h1>Snake game</h1><p>Collect apples with the arrow keys.</p></main>';
const execFileAsync = promisify(execFile);

async function getFreePort() {
  const listener = net.createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  return port;
}

async function waitFor(condition, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await condition();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for condition');
}

async function startIsolatedServer(t, {
  worldDir, dataDir, backupDir, secret = 'test-secret', extraEnv = {},
}) {
  const port = await getFreePort();
  const logs = [];
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      POW_DIFFICULTY: '0',
      ADMIN_RESET_SECRET: secret,
      AIBUILDS_WORLD_DIR: worldDir,
      AIBUILDS_DATA_DIR: dataDir,
      AIBUILDS_BACKUP_DIR: backupDir,
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', chunk => logs.push(chunk.toString()));
  child.stderr.on('data', chunk => logs.push(chunk.toString()));
  let stopped = false;
  t.after(async () => {
    if (stopped) return;
    const exited = child.exitCode === null && child.signalCode === null ? once(child, 'exit') : null;
    if (exited) child.kill('SIGTERM');
    if (exited) await exited;
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await waitFor(async () => {
      if (child.exitCode !== null) throw new Error(`Server exited early:\n${logs.join('')}`);
      try { return (await fetch(`${baseUrl}/api/stats`)).ok; } catch { return false; }
    }, 10000);
  } catch (error) {
    error.message += `\nServer logs:\n${logs.join('')}`;
    throw error;
  }
  return {
    baseUrl,
    logs,
    async stop() {
      const exited = child.exitCode === null ? once(child, 'exit') : null;
      if (child.exitCode === null) child.kill('SIGTERM');
      if (exited) await exited;
      stopped = true;
    },
    async crash() {
      const exited = child.exitCode === null ? once(child, 'exit') : null;
      if (child.exitCode === null) child.kill('SIGKILL');
      if (exited) await exited;
      stopped = true;
    },
  };
}

async function jsonRequest(baseUrl, requestPath, options = {}) {
  const response = await fetch(baseUrl + requestPath, options);
  let body;
  try { body = await response.json(); } catch { body = null; }
  return { response, body };
}

async function challengeHeaders(baseUrl) {
  const { response, body } = await jsonRequest(baseUrl, '/api/challenge');
  assert.equal(response.status, 200);
  return {
    'Content-Type': 'application/json',
    'X-Challenge-Id': body.id,
    'X-Challenge-Nonce': '0',
  };
}

test('stored publication decisions publish safe bytes and quarantine risky bytes', () => {
  // Mutations caught: failing open or dropping the classifier decision would publish both inputs.
  const safe = evaluatePublication({ filePath: 'pages/snake.html', content: safeContent });
  const risky = evaluatePublication({
    filePath: 'pages/dose.html',
    content: '<p>Inject 2 mg weekly for best results.</p>',
  });

  assert.deepEqual(decideStoredPublication({ evaluation: safe }), {
    status: 'published', reasons: [],
  });
  assert.deepEqual(decideStoredPublication({ evaluation: risky }), {
    status: 'quarantined', reasons: ['high_stakes_medical'],
  });
});

test('only a matching approved hash bypasses a risky classification', () => {
  // Mutation caught: treating approval as path-only would publish the changed hash too.
  const versionA = evaluatePublication({
    filePath: 'pages/dose.html',
    content: '<p>Inject 2 mg weekly for best results.</p>',
  });
  const versionB = evaluatePublication({
    filePath: 'pages/dose.html',
    content: '<p>Inject 4 mg weekly for best results.</p>',
  });

  assert.deepEqual(decideStoredPublication({ evaluation: versionA, approvedHash: versionA.contentHash }), {
    status: 'published', reasons: [],
  });
  assert.deepEqual(decideStoredPublication({ evaluation: versionB, approvedHash: versionA.contentHash }), {
    status: 'quarantined', reasons: ['high_stakes_medical'],
  });
});

test('quarantine response carries immutable status and machine-readable reasons', () => {
  // Mutation caught: omitting status/reasons would make a quarantined 200 indistinguishable to clients.
  const contribution = { id: 'risk-1', publicationStatus: 'quarantined' };
  assert.deepEqual(buildContributionResponse({
    contribution,
    decision: { status: 'quarantined', reasons: ['high_stakes_medical'] },
  }), {
    success: true,
    publicationStatus: 'quarantined',
    reasons: ['high_stakes_medical'],
    contribution,
  });
});

test('startup audit discovers risky page fixtures once and skips safe or exactly approved files', async (t) => {
  // Mutations caught: hard-coding an incident path, skipping the scan, or ignoring exact approvals.
  const worldDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aibuilds-publication-audit-'));
  t.after(() => fs.rm(worldDir, { recursive: true, force: true }));
  await fs.mkdir(path.join(worldDir, 'pages'), { recursive: true });
  await fs.mkdir(path.join(worldDir, 'sections'), { recursive: true });
  await fs.copyFile(
    path.join(__dirname, 'fixtures', 'peptide-dosing-math.html'),
    path.join(worldDir, 'pages', 'peptide-dosing-math.html'),
  );
  await fs.writeFile(path.join(worldDir, 'pages', 'safe.html'), safeContent);
  const approvedContent = '<p>Invest 80% of your savings in this token.</p>';
  await fs.writeFile(path.join(worldDir, 'sections', 'approved.html'), approvedContent);
  await fs.writeFile(path.join(worldDir, 'outside.html'), '<p>Inject 9 mg weekly.</p>');

  const files = await listWorldFiles(worldDir, { includeHidden: true });
  const approvedHash = evaluatePublication({
    filePath: 'sections/approved.html', content: approvedContent,
  }).contentHash;
  const records = await auditWorldForQuarantine({
    files,
    readFile: filePath => fs.readFile(path.join(worldDir, filePath), 'utf8'),
    isApproved: (filePath, hash) => filePath === 'sections/approved.html' && hash === approvedHash,
    evaluatePublication,
  });

  assert.equal(records.length, 1);
  assert.equal(records[0].filePath, 'pages/peptide-dosing-math.html');
  assert.equal(records[0].contentHash, contentHash(await fs.readFile(
    path.join(worldDir, 'pages', 'peptide-dosing-math.html'), 'utf8',
  )));
  assert.deepEqual(records[0].reasons, ['high_stakes_medical']);
  assert.equal(records[0].agentName, 'startup-audit');
  assert.match(records[0].timestamp, /^\d{4}-\d{2}-\d{2}T/);
});

test('public contribution boundary excludes immutable quarantines and unavailable paths', () => {
  // Mutations caught: path-only history filtering, hidden-only availability, and mutable-status bypasses.
  const contribution = {
    id: 'published-1',
    file_path: 'pages/example.html',
    publicationStatus: 'published',
  };
  assert.equal(isPublicContribution({
    contribution,
    isHidden: () => false,
    isQuarantined: () => false,
  }), true);
  assert.equal(isPublicContribution({
    contribution,
    isHidden: () => true,
    isQuarantined: () => false,
  }), false);
  assert.equal(isPublicContribution({
    contribution,
    isHidden: () => false,
    isQuarantined: () => true,
  }), false);
  assert.equal(isPublicContribution({
    contribution: { ...contribution, publicationStatus: 'quarantined' },
    isHidden: () => false,
    isQuarantined: () => false,
  }), false);
});

test('public agent state derives counters only from public targets', () => {
  // Mutation caught: returning persisted incremental state would count the quarantined target's activity.
  const publicHistory = [
    {
      id: 'public-1', agent_name: 'Alice', action: 'create', file_path: 'pages/safe.html',
      timestamp: '2026-08-10T12:00:00.000Z', reactions: { fire: ['Bob'], heart: [], rocket: [], eyes: [] },
    },
    {
      id: 'public-2', agent_name: 'Bob', action: 'edit', file_path: 'pages/safe.html',
      timestamp: '2026-08-10T12:05:00.000Z', reactions: { fire: [], heart: [], rocket: [], eyes: [] },
    },
  ];
  const comments = [
    { id: 'comment-public', targetType: 'contribution', targetId: 'public-1', agentName: 'Bob' },
    { id: 'comment-public-file', targetType: 'file', targetId: 'WORLD.md', agentName: 'Bob', publicTarget: true },
    { id: 'comment-risky', targetType: 'contribution', targetId: 'risk-1', agentName: 'Alice' },
  ];
  const state = derivePublicAgentState({ publicHistory, comments });

  assert.equal(state.size, 2);
  assert.equal(state.get('Alice').contributions, 1);
  assert.equal(state.get('Alice').reactionsReceived, 1);
  assert.equal(state.get('Alice').commentsCount, 0);
  assert.equal(state.get('Bob').contributions, 1);
  assert.equal(state.get('Bob').reactionsGiven, 1);
  assert.equal(state.get('Bob').commentsCount, 2);
  assert.deepEqual(Array.from(state.get('Alice').collaborators), ['Bob']);
  assert.deepEqual(Array.from(state.get('Bob').collaborators), ['Alice']);
});

test('real server migrates legacy records and keeps risky history private through a safe correction', async (t) => {
  // Mutations caught: no startup migration, hidden/quarantine conflation, path-only public records,
  // persisted public-agent counters, and quarantined contribution/achievement broadcasts.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aibuilds-publication-server-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const worldDir = path.join(root, 'world');
  const dataDir = path.join(root, 'data');
  const backupDir = path.join(root, 'backups');
  await fs.mkdir(path.join(worldDir, 'pages'), { recursive: true });
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(path.join(worldDir, 'pages', 'legacy-safe.html'), '<p>Legacy safe page</p>');
  await fs.writeFile(path.join(worldDir, 'pages', 'frozen.html'), '<p>Operator controlled page</p>');
  await fs.copyFile(
    path.join(__dirname, 'fixtures', 'peptide-dosing-math.html'),
    path.join(worldDir, 'pages', 'peptide-dosing-math.html'),
  );
  await fs.writeFile(path.join(dataDir, 'state.json'), JSON.stringify({
    history: [
      {
        id: 'legacy-safe', timestamp: '2026-08-10T10:00:00.000Z', agent_name: 'LegacySafe',
        action: 'create', file_path: 'pages/legacy-safe.html', message: 'legacy safe',
        reactions: { fire: [], heart: [], rocket: [], eyes: [] }, commentCount: 0,
      },
      {
        id: 'legacy-risky', timestamp: '2026-08-10T10:05:00.000Z', agent_name: 'LegacyRisk',
        action: 'create', file_path: 'pages/peptide-dosing-math.html', message: 'legacy risky marker',
        reactions: { fire: ['LegacySafe'], heart: [], rocket: [], eyes: [] }, commentCount: 1,
      },
      {
        id: 'legacy-missing', timestamp: '2026-08-10T10:07:00.000Z', agent_name: 'LegacyMissing',
        action: 'create', file_path: 'pages/recreated.html', message: 'MISSING_LEGACY_PRIVATE_MARKER',
        reactions: { fire: [], heart: [], rocket: [], eyes: [] }, commentCount: 0,
      },
    ],
    agents: {
      LegacyRisk: { name: 'LegacyRisk', contributions: 99, commentsCount: 99, reactionsReceived: 99 },
    },
    agentAchievements: { LegacySafe: ['centurion'], LegacyRisk: ['centurion'] },
    comments: {
      'risk-internal-comment': {
        id: 'risk-internal-comment', targetType: 'contribution', targetId: 'legacy-risky',
        agentName: 'LegacySafe', content: 'internal only', parentId: null,
        timestamp: '2026-08-10T10:06:00.000Z',
      },
    },
  }));

  const server = await startIsolatedServer(t, { worldDir, dataDir, backupDir });
  const { baseUrl } = server;
  const migratedState = JSON.parse(await fs.readFile(path.join(dataDir, 'state.json'), 'utf8'));
  assert.equal(migratedState.history.find(item => item.id === 'legacy-safe').publicationStatus, 'published');
  assert.equal(migratedState.history.find(item => item.id === 'legacy-risky').publicationStatus, 'quarantined');
  assert.equal(migratedState.history.find(item => item.id === 'legacy-missing').publicationStatus, 'quarantined');

  let result = await jsonRequest(baseUrl, '/api/history');
  assert.equal(result.body.items.some(item => item.id === 'legacy-safe'), true);
  assert.equal(result.body.items.some(item => item.id === 'legacy-risky'), false);
  assert.equal(result.body.items.some(item => item.id === 'legacy-missing'), false);
  result = await jsonRequest(baseUrl, '/api/agents');
  assert.deepEqual(result.body.agents.map(agent => [agent.name, agent.contributions]), [['LegacySafe', 1]]);
  result = await jsonRequest(baseUrl, '/api/agents/LegacySafe/achievements');
  assert.deepEqual(result.body.earned.map(item => item.id), ['hello-world']);
  result = await jsonRequest(baseUrl, '/api/agents/LegacyRisk');
  assert.equal(result.response.status, 404);
  result = await jsonRequest(baseUrl, '/api/agents/LegacySafe/profile', {
    method: 'PUT', headers: await challengeHeaders(baseUrl),
    body: JSON.stringify({
      bio: 'Profile created from safe legacy history', specializations: ['backend', 'ai'],
    }),
  });
  assert.equal(result.response.status, 200);
  assert.deepEqual(result.body.agent.specializations, ['backend', 'ai']);
  assert.equal((await jsonRequest(baseUrl, '/api/agents/LegacySafe')).body.bio,
    'Profile created from safe legacy history');
  assert.deepEqual((await jsonRequest(baseUrl, '/api/agents/LegacySafe')).body.specializations, ['backend', 'ai']);
  assert.deepEqual((await jsonRequest(baseUrl, '/api/agents')).body.agents
    .find(agent => agent.name === 'LegacySafe').specializations, ['backend', 'ai']);
  assert.deepEqual((await jsonRequest(baseUrl, '/api/search?q=backend')).body.results.agents
    .map(agent => agent.name), ['LegacySafe']);
  assert.deepEqual((await jsonRequest(baseUrl, '/api/network/graph')).body.nodes
    .find(agent => agent.name === 'LegacySafe').specializations, ['backend', 'ai']);
  result = await jsonRequest(baseUrl, '/api/agents/LegacySafe/profile', {
    method: 'PUT', headers: await challengeHeaders(baseUrl),
    body: JSON.stringify({ specializations: ['ai'] }),
  });
  assert.equal(result.response.status, 200);
  assert.deepEqual(result.body.agent.specializations, ['ai']);
  assert.deepEqual((await jsonRequest(baseUrl, '/api/agents/LegacySafe')).body.specializations, ['ai']);
  assert.deepEqual((await jsonRequest(baseUrl, '/api/search?q=backend&type=agents')).body.results.agents, []);

  const frames = [];
  const socket = new WebSocket(baseUrl.replace('http:', 'ws:'));
  socket.on('message', data => frames.push(JSON.parse(data.toString())));
  await once(socket, 'open');
  await waitFor(() => frames.some(frame => frame.type === 'welcome'));
  t.after(() => socket.close());
  const welcome = frames.find(frame => frame.type === 'welcome');
  assert.equal(welcome.totalContributions, 1);
  assert.deepEqual(welcome.recentHistory.map(item => item.id), ['legacy-safe']);

  result = await jsonRequest(baseUrl, '/api/contribute', {
    method: 'POST', headers: await challengeHeaders(baseUrl),
    body: JSON.stringify({
      agent_name: 'AliasAgent', action: 'create', file_path: 'pages//alias.html',
      content: '<main><h1>Alias</h1></main>', message: 'must reject noncanonical path',
    }),
  });
  assert.equal(result.response.status, 400);
  await assert.rejects(fs.access(path.join(worldDir, 'pages', 'alias.html')));

  const beforeRiskAgents = (await jsonRequest(baseUrl, '/api/agents')).body.total;
  const beforeRiskGraph = (await jsonRequest(baseUrl, '/api/network/graph')).body.nodes.length;
  const riskyContent = await fs.readFile(path.join(__dirname, 'fixtures', 'peptide-dosing-math.html'), 'utf8');
  result = await jsonRequest(baseUrl, '/api/contribute', {
    method: 'POST',
    headers: await challengeHeaders(baseUrl),
    body: JSON.stringify({
      agent_name: 'RiskyAgent', action: 'edit', file_path: 'pages/peptide-dosing-math.html',
      content: riskyContent, message: 'RISKY_MUTATION_MARKER',
    }),
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.publicationStatus, 'quarantined');
  assert.deepEqual(result.body.reasons, ['high_stakes_medical']);
  const riskyId = result.body.contribution.id;
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal((await jsonRequest(baseUrl, '/api/world/pages/peptide-dosing-math.html')).response.status, 404);
  assert.equal((await jsonRequest(baseUrl, `/api/contributions/${riskyId}`)).response.status, 404);
  assert.equal((await jsonRequest(baseUrl, `/api/contributions/${riskyId}/diff`)).response.status, 404);
  assert.equal((await jsonRequest(baseUrl, `/api/contributions/${riskyId}/comments`)).response.status, 404);
  assert.equal((await jsonRequest(baseUrl, `/api/contributions/${riskyId}/reactions`, {
    method: 'POST', headers: await challengeHeaders(baseUrl),
    body: JSON.stringify({ agent_name: 'LegacySafe', type: 'fire' }),
  })).response.status, 404);
  const afterRiskAgents = (await jsonRequest(baseUrl, '/api/agents')).body.total;
  const afterRiskGraph = (await jsonRequest(baseUrl, '/api/network/graph')).body.nodes.length;
  const riskyProfileStatus = (await jsonRequest(baseUrl, '/api/agents/RiskyAgent')).response.status;
  const riskyAchievementsStatus = (await jsonRequest(baseUrl, '/api/agents/RiskyAgent/achievements')).response.status;
  const riskyLeaderboardRows = (await jsonRequest(baseUrl, '/api/leaderboard')).body.leaderboard
    .filter(row => row.name === 'RiskyAgent').length;
  const riskyPublicFrames = frames.filter(frame => frame.type === 'contribution' || frame.type === 'achievement').length;
  assert.deepEqual({
    agentDelta: afterRiskAgents - beforeRiskAgents,
    graphNodeDelta: afterRiskGraph - beforeRiskGraph,
    riskyProfileStatus,
    riskyAchievementsStatus,
    riskyLeaderboardRows,
    riskyPublicFrames,
  }, {
    agentDelta: 0,
    graphNodeDelta: 0,
    riskyProfileStatus: 404,
    riskyAchievementsStatus: 404,
    riskyLeaderboardRows: 0,
    riskyPublicFrames: 0,
  });

  const safeReplacement = '<main><h1>Health calculator retired</h1><p>Ask a qualified clinician for personal advice.</p></main>';
  result = await jsonRequest(baseUrl, '/api/contribute', {
    method: 'POST',
    headers: await challengeHeaders(baseUrl),
    body: JSON.stringify({
      agent_name: 'RiskyAgent', action: 'edit', file_path: 'pages/peptide-dosing-math.html',
      content: safeReplacement, message: 'SAFE_REPLACEMENT_MARKER',
    }),
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.publicationStatus, 'published');
  assert.deepEqual(result.body.reasons, []);
  const safeId = result.body.contribution.id;
  await waitFor(() => frames.filter(frame => frame.type === 'contribution' || frame.type === 'achievement').length >= 2);
  const readSafe = await jsonRequest(baseUrl, '/api/world/pages/peptide-dosing-math.html');
  assert.equal(readSafe.response.status, 200);
  assert.match(readSafe.body.content, /Health calculator retired/);
  assert.doesNotMatch(readSafe.body.content, /Inject|mg weekly/i);
  assert.equal((await jsonRequest(baseUrl, `/api/contributions/${riskyId}`)).response.status, 404);
  assert.equal((await jsonRequest(baseUrl, `/api/contributions/${riskyId}/diff`)).response.status, 404);
  assert.equal((await jsonRequest(baseUrl, `/api/contributions/${safeId}`)).response.status, 200);

  const publicHistory = (await jsonRequest(baseUrl, '/api/history')).body.items;
  assert.equal(publicHistory.some(item => item.id === riskyId || item.id === 'legacy-risky'), false);
  assert.equal(publicHistory.filter(item => item.file_path === 'pages/peptide-dosing-math.html').length, 1);
  const fileHistory = (await jsonRequest(baseUrl, '/api/files/pages/peptide-dosing-math.html/history')).body;
  assert.deepEqual(fileHistory.history.map(item => item.id), [safeId]);
  const profile = (await jsonRequest(baseUrl, '/api/agents/RiskyAgent')).body;
  assert.equal(profile.stats.contributions, 1);
  assert.deepEqual(profile.recentContributions.map(item => item.id), [safeId]);
  const leaderboard = (await jsonRequest(baseUrl, '/api/leaderboard')).body;
  assert.equal(leaderboard.leaderboard.find(row => row.name === 'RiskyAgent').contributions, 1);
  const graph = (await jsonRequest(baseUrl, '/api/network/graph')).body;
  assert.equal(graph.nodes.find(node => node.name === 'RiskyAgent').contributions, 1);
  const trends = (await jsonRequest(baseUrl, '/api/trends?period=week')).body;
  assert.equal(trends.trendingFiles.find(file => file.path === 'pages/peptide-dosing-math.html').edits, 1);
  const riskySearch = (await jsonRequest(baseUrl, '/api/search?q=RISKY_MUTATION_MARKER')).body;
  assert.equal(riskySearch.total, 0);
  const safeSearch = (await jsonRequest(baseUrl, '/api/search?q=SAFE_REPLACEMENT_MARKER')).body;
  assert.deepEqual(safeSearch.results.contributions.map(item => item.id), [safeId]);
  const timeline = (await jsonRequest(baseUrl, '/api/timeline')).body;
  assert.equal(timeline.every(item => Object.hasOwn(item, 'hash') && Object.hasOwn(item, 'date') &&
    Object.hasOwn(item, 'message') && Object.hasOwn(item, 'author')), true);
  assert.equal(timeline.find(item => item.message === 'legacy safe').hash, null);
  assert.equal(timeline.some(item => item.message.includes('RISKY_MUTATION_MARKER') || item.message.includes('legacy risky marker')), false);
  assert.equal(timeline.filter(item => item.message.includes('SAFE_REPLACEMENT_MARKER')).length, 1);
  assert.deepEqual(frames.filter(frame => frame.type === 'contribution').map(frame => frame.data.id), [safeId]);
  assert.deepEqual(frames.filter(frame => frame.type === 'achievement').map(frame => frame.data.achievement.id), ['hello-world']);

  result = await jsonRequest(baseUrl, '/api/contribute', {
    method: 'POST',
    headers: await challengeHeaders(baseUrl),
    body: JSON.stringify({
      agent_name: 'Recreator', action: 'create', file_path: 'pages/recreated.html',
      content: '<main><h1>Safe recreated page</h1></main>', message: 'SAFE_RECREATE_MARKER',
    }),
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.publicationStatus, 'published');
  assert.equal((await jsonRequest(baseUrl, '/api/contributions/legacy-missing')).response.status, 404);

  result = await jsonRequest(baseUrl, `/api/contributions/${safeId}/reactions`, {
    method: 'POST', headers: await challengeHeaders(baseUrl),
    body: JSON.stringify({ agent_name: 'LegacySafe', type: 'fire' }),
  });
  assert.equal(result.response.status, 200);
  result = await jsonRequest(baseUrl, `/api/contributions/${safeId}/comments`, {
    method: 'POST', headers: await challengeHeaders(baseUrl),
    body: JSON.stringify({ agent_name: 'LegacySafe', content: 'Public target only' }),
  });
  assert.equal(result.response.status, 200);
  const legacyProfile = (await jsonRequest(baseUrl, '/api/agents/LegacySafe')).body;
  assert.equal(legacyProfile.stats.reactionsGiven, 1);
  assert.equal(legacyProfile.stats.commentsCount, 1);
  const safeProfileAfterInteraction = (await jsonRequest(baseUrl, '/api/agents/RiskyAgent')).body;
  assert.equal(safeProfileAfterInteraction.stats.reactionsReceived, 1);

  result = await jsonRequest(baseUrl, '/api/admin/moderate', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: 'test-secret', action: 'hide', target: 'pages/frozen.html' }),
  });
  assert.equal(result.response.status, 200);
  result = await jsonRequest(baseUrl, '/api/contribute', {
    method: 'POST', headers: await challengeHeaders(baseUrl),
    body: JSON.stringify({
      agent_name: 'RiskyAgent', action: 'edit', file_path: 'pages/frozen.html',
      content: '<p>safe but frozen</p>', message: 'must stay frozen',
    }),
  });
  assert.equal(result.response.status, 403);

  await fs.unlink(path.join(worldDir, 'pages', 'legacy-safe.html'));
  assert.equal((await jsonRequest(baseUrl, '/api/contributions/legacy-safe')).response.status, 404);
  assert.equal((await jsonRequest(baseUrl, '/api/history')).body.items.some(item => item.id === 'legacy-safe'), false);
  const outsideFile = path.join(root, 'outside-private.html');
  await fs.writeFile(outsideFile, '<p>outside private bytes</p>');
  await fs.symlink('../../outside-private.html', path.join(worldDir, 'pages', 'legacy-safe.html'));
  assert.equal((await jsonRequest(baseUrl, '/api/contributions/legacy-safe')).response.status, 404);
  assert.equal((await jsonRequest(baseUrl, '/api/history')).body.items.some(item => item.id === 'legacy-safe'), false);

  const preservedDataDir = `${dataDir}-preserved`;
  await fs.rename(dataDir, preservedDataDir);
  await fs.writeFile(dataDir, 'block state persistence');
  result = await jsonRequest(baseUrl, '/api/admin/reset', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: 'test-secret' }),
  });
  assert.equal(result.response.status, 500);
  await fs.unlink(dataDir);
  await fs.rename(preservedDataDir, dataDir);

  await server.stop();
});

test('admin approval and corrective contribution serialize on the same World path', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aibuilds-publication-lock-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const worldDir = path.join(root, 'world');
  const dataDir = path.join(root, 'data');
  const backupDir = path.join(root, 'backups');
  const relativePath = 'pages/decision.html';
  const targetPath = path.join(worldDir, relativePath);
  const markerPath = path.join(root, 'read-captured');
  const armPath = path.join(root, 'arm-delay');
  const preloadPath = path.join(root, 'delay-admin-read.cjs');
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(targetPath, '<p>Inject 2 mg weekly for best results.</p>');
  await fs.writeFile(preloadPath, `
    const fs = require('node:fs');
    const promises = fs.promises;
    const originalReadFile = promises.readFile.bind(promises);
    const originalWriteFile = promises.writeFile.bind(promises);
    const target = process.env.AIBUILDS_DELAY_READ_TARGET;
    const marker = process.env.AIBUILDS_DELAY_READ_MARKER;
    const arm = process.env.AIBUILDS_DELAY_READ_ARM;
    promises.readFile = async function delayedRead(file, ...args) {
      const result = await originalReadFile(file, ...args);
      if (String(file) === target && fs.existsSync(arm)) {
        await originalWriteFile(marker, 'captured');
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      return result;
    };
  `);
  const server = await startIsolatedServer(t, {
    worldDir, dataDir, backupDir,
    extraEnv: {
      NODE_OPTIONS: `--require=${preloadPath}`,
      AIBUILDS_DELAY_READ_TARGET: targetPath,
      AIBUILDS_DELAY_READ_MARKER: markerPath,
      AIBUILDS_DELAY_READ_ARM: armPath,
    },
  });
  const listed = await jsonRequest(server.baseUrl, '/api/admin/quarantine', {
    headers: { 'X-Admin-Secret': 'test-secret' },
  });
  const listedRecord = listed.body.quarantined.find(record => record.path === relativePath);
  assert.ok(listedRecord);
  const correctionHeaders = await challengeHeaders(server.baseUrl);
  await fs.writeFile(armPath, 'armed');
  const pendingApproval = jsonRequest(server.baseUrl, '/api/admin/quarantine/approve', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Admin-Secret': 'test-secret' },
    body: JSON.stringify({ path: relativePath, content_hash: listedRecord.content_hash }),
  });
  await waitFor(async () => {
    try { await fs.access(markerPath); return true; } catch { return false; }
  });
  const pendingCorrection = jsonRequest(server.baseUrl, '/api/contribute', {
    method: 'POST', headers: correctionHeaders,
    body: JSON.stringify({
      agent_name: 'Corrector', action: 'edit', file_path: relativePath,
      content: '<p>Inject 4 mg weekly for best results.</p>', message: 'new risky version',
    }),
  });
  const [approval, correction] = await Promise.all([pendingApproval, pendingCorrection]);
  assert.equal(approval.response.status, 200);
  assert.equal(correction.response.status, 200);
  assert.equal(correction.body.publicationStatus, 'quarantined');
  assert.equal((await jsonRequest(server.baseUrl, `/api/world/${relativePath}`)).response.status, 404);
  const finalList = await jsonRequest(server.baseUrl, '/api/admin/quarantine', {
    headers: { 'X-Admin-Secret': 'test-secret' },
  });
  assert.equal(finalList.body.quarantined.length, 1);
  assert.notEqual(finalList.body.quarantined[0].content_hash, listedRecord.content_hash);
  await server.stop();
});

test('contribution diff is bound to the requested contribution git hash', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aibuilds-publication-diff-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const worldDir = path.join(root, 'world');
  const dataDir = path.join(root, 'data');
  const backupDir = path.join(root, 'backups');
  await fs.mkdir(worldDir, { recursive: true });
  await fs.mkdir(dataDir, { recursive: true });
  const server = await startIsolatedServer(t, { worldDir, dataDir, backupDir });
  const frames = [];
  const socket = new WebSocket(server.baseUrl.replace('http:', 'ws:'));
  socket.on('message', data => frames.push(JSON.parse(data.toString())));
  await once(socket, 'open');
  await waitFor(() => frames.some(frame => frame.type === 'welcome'));
  t.after(() => socket.close());
  async function contribute(agent, content, message, action = 'edit') {
    return jsonRequest(server.baseUrl, '/api/contribute', {
      method: 'POST', headers: await challengeHeaders(server.baseUrl),
      body: JSON.stringify({
        agent_name: agent, action, file_path: 'pages/versioned.html', content, message,
      }),
    });
  }
  let result = await contribute('Alice', '<main><h1>Original safe version</h1></main>', 'alice safe', 'create');
  assert.equal(result.response.status, 200);
  const aliceSafeId = result.body.contribution.id;
  await waitFor(async () => (await jsonRequest(server.baseUrl, `/api/contributions/${aliceSafeId}`)).body?.gitHash);
  result = await contribute('Alice', '<p>Inject 7 mg weekly for best results.</p>', 'alice risky');
  assert.equal(result.body.publicationStatus, 'quarantined');
  await waitFor(async () => {
    try {
      const { stdout } = await new Promise((resolve, reject) => {
        const child = require('node:child_process').execFile('git', ['log', '-1', '--pretty=%B'], { cwd: worldDir },
          (error, out, stderr) => error ? reject(error) : resolve({ stdout: out, stderr }));
        child.unref?.();
      });
      return stdout.includes('alice risky');
    } catch { return false; }
  });
  result = await contribute('Bob', '<main><h1>Corrected safe version</h1></main>', 'bob safe');
  assert.equal(result.body.publicationStatus, 'published');
  await waitFor(async () => (await jsonRequest(server.baseUrl, `/api/contributions/${result.body.contribution.id}`)).body?.gitHash);
  await waitFor(() => frames.filter(frame => frame.type === 'achievement').length >= 2);
  assert.deepEqual(frames.filter(frame => frame.type === 'achievement')
    .map(frame => [frame.data.agentName, frame.data.achievement.id]), [
    ['Alice', 'hello-world'],
    ['Bob', 'hello-world'],
  ]);

  const diff = await jsonRequest(server.baseUrl, `/api/contributions/${aliceSafeId}/diff`);
  assert.equal(diff.response.status, 200);
  assert.doesNotMatch(diff.body.diff || '', /Inject 7 mg weekly/);
  assert.match(diff.body.diff || '', /Original safe version/);
  await server.stop();
});

test('same-path mutation cannot change bytes staged for an earlier contribution hash', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aibuilds-publication-git-lock-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const worldDir = path.join(root, 'world');
  const dataDir = path.join(root, 'data');
  const backupDir = path.join(root, 'backups');
  const binDir = path.join(root, 'bin');
  const markerPath = path.join(root, 'git-add-started');
  const armPath = path.join(root, 'arm-git-delay');
  await fs.mkdir(worldDir, { recursive: true });
  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(binDir, { recursive: true });
  const { stdout: gitPathOutput } = await execFileAsync('which', ['git']);
  const wrapperPath = path.join(binDir, 'git');
  await fs.writeFile(wrapperPath, `#!/bin/sh
if [ "$1" = "add" ] && [ -f "${armPath}" ] && [ ! -f "${markerPath}" ]; then
  : > "${markerPath}"
  sleep 1
fi
exec "${gitPathOutput.trim()}" "$@"
`);
  await fs.chmod(wrapperPath, 0o755);
  const server = await startIsolatedServer(t, {
    worldDir, dataDir, backupDir,
    extraEnv: { PATH: `${binDir}:${process.env.PATH}` },
  });
  await fs.writeFile(armPath, 'armed');
  const safeHeaders = await challengeHeaders(server.baseUrl);
  const riskyHeaders = await challengeHeaders(server.baseUrl);
  const pendingSafe = jsonRequest(server.baseUrl, '/api/contribute', {
    method: 'POST', headers: safeHeaders,
    body: JSON.stringify({
      agent_name: 'Alice', action: 'create', file_path: 'pages/staged.html',
      content: '<main><h1>Safe staged version</h1></main>', message: 'safe staged version',
    }),
  });
  await waitFor(async () => {
    try { await fs.access(markerPath); return true; } catch { return false; }
  });
  const pendingRisky = jsonRequest(server.baseUrl, '/api/contribute', {
    method: 'POST', headers: riskyHeaders,
    body: JSON.stringify({
      agent_name: 'Alice', action: 'edit', file_path: 'pages/staged.html',
      content: '<p>Inject 9 mg weekly for best results.</p>', message: 'risky staged version',
    }),
  });
  const [safeResult, riskyResult] = await Promise.all([pendingSafe, pendingRisky]);
  assert.equal(safeResult.body.publicationStatus, 'published');
  assert.equal(riskyResult.body.publicationStatus, 'quarantined');
  const safeHash = await waitFor(async () => {
    try {
      const state = JSON.parse(await fs.readFile(path.join(dataDir, 'state.json'), 'utf8'));
      return state.history.find(item => item.id === safeResult.body.contribution.id)?.gitHash;
    } catch { return null; }
  });
  assert.match(safeHash, /^[a-f0-9]{40}$/);

  const correction = await jsonRequest(server.baseUrl, '/api/contribute', {
    method: 'POST', headers: await challengeHeaders(server.baseUrl),
    body: JSON.stringify({
      agent_name: 'Bob', action: 'edit', file_path: 'pages/staged.html',
      content: '<main><h1>Corrected staged version</h1></main>', message: 'corrected staged version',
    }),
  });
  assert.equal(correction.body.publicationStatus, 'published');
  const diff = await jsonRequest(server.baseUrl, `/api/contributions/${safeResult.body.contribution.id}/diff`);
  assert.equal(diff.response.status, 200);
  assert.match(diff.body.diff || '', /Safe staged version/);
  assert.doesNotMatch(diff.body.diff || '', /Inject 9 mg weekly/);
  await server.stop();
});

test('startup audit reconciles stale state and preserves unchanged quarantine provenance', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aibuilds-publication-reconcile-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const worldDir = path.join(root, 'world');
  const dataDir = path.join(root, 'data');
  const backupDir = path.join(root, 'backups');
  await fs.mkdir(path.join(worldDir, 'pages'), { recursive: true });
  await fs.mkdir(dataDir, { recursive: true });
  const unchangedPath = 'pages/UnchangedRisk.html';
  const safePath = 'pages/StaleSafe.html';
  const approvedPath = 'pages/ApprovedRisk.html';
  const missingPath = 'pages/MissingRisk.html';
  const unchangedBytes = '<p>Inject 2 mg weekly for best results.</p>';
  const safeBytes = '<main><h1>Corrected safe page</h1></main>';
  const approvedBytes = '<p>Invest 80% of your savings in this token.</p>';
  await fs.writeFile(path.join(worldDir, unchangedPath), unchangedBytes);
  await fs.writeFile(path.join(worldDir, safePath), safeBytes);
  await fs.writeFile(path.join(worldDir, approvedPath), approvedBytes);
  const record = (filePath, hash, agentName, timestamp) => ({
    filePath, contentHash: hash, reasons: ['high_stakes_medical'], agentName, timestamp,
  });
  await fs.writeFile(path.join(dataDir, 'moderation.json'), JSON.stringify({
    moderation: {
      hiddenFiles: [], bannedAgents: [], bannedIps: [],
      quarantinedFiles: {
        [unchangedPath]: record(unchangedPath, contentHash(unchangedBytes), 'OriginalAgent', '2026-08-09T10:00:00.000Z'),
        [safePath]: record(safePath, 'old-risky-hash', 'InterruptedAgent', '2026-08-09T11:00:00.000Z'),
        [approvedPath]: record(approvedPath, contentHash(approvedBytes), 'ApprovedAgent', '2026-08-09T12:00:00.000Z'),
        [missingPath]: record(missingPath, 'missing-hash', 'MissingAgent', '2026-08-09T13:00:00.000Z'),
      },
      approvedFiles: {
        [safePath]: 'old-risky-hash',
        [approvedPath]: contentHash(approvedBytes),
        [missingPath]: 'missing-hash',
      },
    },
    agentIps: {},
  }));

  let server = await startIsolatedServer(t, { worldDir, dataDir, backupDir });
  let list = await jsonRequest(server.baseUrl, '/api/admin/quarantine', {
    headers: { 'X-Admin-Secret': 'test-secret' },
  });
  assert.deepEqual(list.body.quarantined.map(item => ({
    path: item.path, agent_name: item.agent_name, timestamp: item.timestamp,
  })), [{
    path: unchangedPath, agent_name: 'OriginalAgent', timestamp: '2026-08-09T10:00:00.000Z',
  }]);
  assert.equal((await jsonRequest(server.baseUrl, `/api/world/${safePath}`)).response.status, 200);
  assert.equal((await jsonRequest(server.baseUrl, `/api/world/${approvedPath}`)).response.status, 200);
  let persisted = JSON.parse(await fs.readFile(path.join(dataDir, 'moderation.json'), 'utf8'));
  assert.deepEqual(persisted.moderation.approvedFiles, {
    [approvedPath]: contentHash(approvedBytes),
  });
  await server.stop();

  server = await startIsolatedServer(t, { worldDir, dataDir, backupDir });
  list = await jsonRequest(server.baseUrl, '/api/admin/quarantine', {
    headers: { 'X-Admin-Secret': 'test-secret' },
  });
  assert.equal(list.body.quarantined[0].agent_name, 'OriginalAgent');
  assert.equal(list.body.quarantined[0].timestamp, '2026-08-09T10:00:00.000Z');
  await server.stop();
});

test('risky replacement becomes unavailable before its delayed atomic write starts', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aibuilds-publication-atomic-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const worldDir = path.join(root, 'world');
  const dataDir = path.join(root, 'data');
  const backupDir = path.join(root, 'backups');
  const targetPath = path.join(worldDir, 'pages', 'public.html');
  const markerPath = path.join(root, 'write-started');
  const preloadPath = path.join(root, 'delay-world-write.cjs');
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(targetPath, '<main><h1>Existing safe page</h1></main>');
  await fs.writeFile(preloadPath, `
    const fs = require('node:fs');
    const promises = fs.promises;
    const originalWriteFile = promises.writeFile.bind(promises);
    const path = require('node:path');
    const target = process.env.AIBUILDS_DELAY_WRITE_TARGET;
    const marker = process.env.AIBUILDS_DELAY_WRITE_MARKER;
    const targetDir = path.dirname(target);
    const targetBase = path.basename(target);
    promises.writeFile = async function delayedWrite(file, ...args) {
      const candidate = String(file);
      if (candidate === target || (path.dirname(candidate) === targetDir &&
          path.basename(candidate).startsWith('.' + targetBase + '.publication-'))) {
        await originalWriteFile(marker, 'started');
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      return originalWriteFile(file, ...args);
    };
  `);

  const server = await startIsolatedServer(t, {
    worldDir, dataDir, backupDir,
    extraEnv: {
      NODE_OPTIONS: `--require=${preloadPath}`,
      AIBUILDS_DELAY_WRITE_TARGET: targetPath,
      AIBUILDS_DELAY_WRITE_MARKER: markerPath,
    },
  });
  const pendingContribution = jsonRequest(server.baseUrl, '/api/contribute', {
    method: 'POST',
    headers: await challengeHeaders(server.baseUrl),
    body: JSON.stringify({
      agent_name: 'RiskyWriter', action: 'edit', file_path: 'pages/public.html',
      content: '<p>Inject 2 mg weekly for best results.</p>', message: 'delayed risky replacement',
    }),
  });
  await waitFor(async () => {
    try { await fs.access(markerPath); return true; } catch { return false; }
  });

  assert.equal((await jsonRequest(server.baseUrl, '/api/world/pages/public.html')).response.status, 404);
  const result = await pendingContribution;
  assert.equal(result.response.status, 200);
  assert.equal(result.body.publicationStatus, 'quarantined');
  assert.equal((await jsonRequest(server.baseUrl, '/api/world/pages/public.html')).response.status, 404);
  await server.stop();
});

test('contribution writes reject symlinked ancestors without touching outside bytes', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aibuilds-publication-write-path-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const worldDir = path.join(root, 'world');
  const dataDir = path.join(root, 'data');
  const backupDir = path.join(root, 'backups');
  const outsideDir = path.join(root, 'outside');
  await fs.mkdir(path.join(worldDir, 'pages'), { recursive: true });
  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(outsideDir, { recursive: true });
  const server = await startIsolatedServer(t, { worldDir, dataDir, backupDir });
  await fs.symlink(outsideDir, path.join(worldDir, 'pages', 'link'));

  const result = await jsonRequest(server.baseUrl, '/api/contribute', {
    method: 'POST', headers: await challengeHeaders(server.baseUrl),
    body: JSON.stringify({
      agent_name: 'PathAgent', action: 'create', file_path: 'pages/link/escape.html',
      content: '<main><h1>Must stay inside</h1></main>', message: 'symlink ancestor probe',
    }),
  });
  assert.equal(result.response.status, 403);
  await assert.rejects(fs.access(path.join(outsideDir, 'escape.html')));
  await server.stop();
});

test('in-flight public reads never resume with a concurrently quarantined revision', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aibuilds-publication-read-lock-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const worldDir = path.join(root, 'world');
  const dataDir = path.join(root, 'data');
  const backupDir = path.join(root, 'backups');
  const targetPath = path.join(worldDir, 'pages', 'public.html');
  const markerPath = path.join(root, 'read-paused');
  const armPath = path.join(root, 'arm-read-delay');
  const preloadPath = path.join(root, 'delay-public-read.cjs');
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(targetPath, '<main><h1>Original safe public bytes</h1></main>');
  await fs.writeFile(preloadPath, `
    const fs = require('node:fs');
    const promises = fs.promises;
    const originalReadFile = promises.readFile.bind(promises);
    const originalWriteFile = promises.writeFile.bind(promises);
    let delayed = false;
    promises.readFile = async function delayedRead(file, ...args) {
      if (!delayed && String(file) === process.env.AIBUILDS_DELAY_PUBLIC_READ_TARGET &&
          fs.existsSync(process.env.AIBUILDS_DELAY_PUBLIC_READ_ARM)) {
        delayed = true;
        await originalWriteFile(process.env.AIBUILDS_DELAY_PUBLIC_READ_MARKER, 'paused');
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      return originalReadFile(file, ...args);
    };
  `);
  const server = await startIsolatedServer(t, {
    worldDir, dataDir, backupDir,
    extraEnv: {
      NODE_OPTIONS: `--require=${preloadPath}`,
      AIBUILDS_DELAY_PUBLIC_READ_TARGET: targetPath,
      AIBUILDS_DELAY_PUBLIC_READ_MARKER: markerPath,
      AIBUILDS_DELAY_PUBLIC_READ_ARM: armPath,
    },
  });
  await fs.writeFile(armPath, 'armed');
  const pendingRead = jsonRequest(server.baseUrl, '/api/world/pages/public.html');
  await waitFor(async () => {
    try { await fs.access(markerPath); return true; } catch { return false; }
  });
  const pendingRisky = jsonRequest(server.baseUrl, '/api/contribute', {
    method: 'POST', headers: await challengeHeaders(server.baseUrl),
    body: JSON.stringify({
      agent_name: 'ConcurrentRisk', action: 'edit', file_path: 'pages/public.html',
      content: '<p>Inject 11 mg weekly for best results.</p>', message: 'concurrent risky revision',
    }),
  });
  const [readResult, riskyResult] = await Promise.all([pendingRead, pendingRisky]);
  assert.equal(riskyResult.body.publicationStatus, 'quarantined');
  if (readResult.response.status === 200) {
    assert.match(readResult.body.content, /Original safe public bytes/);
    assert.doesNotMatch(readResult.body.content, /Inject 11 mg/);
  } else {
    assert.equal(readResult.response.status, 404);
  }
  await server.stop();
});

test('homepage and pretty routes render public pages when no layout exists', async (t) => {
  // Mutations caught: treating a missing optional layout or an extensionless pretty slug as an unavailable file.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aibuilds-publication-pretty-fallback-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const worldDir = path.join(root, 'world');
  const dataDir = path.join(root, 'data');
  const backupDir = path.join(root, 'backups');
  await fs.mkdir(path.join(worldDir, 'pages'), { recursive: true });
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(path.join(worldDir, 'pages', 'home.html'),
    '<main><h1>Fallback home page</h1></main>');
  await fs.writeFile(path.join(worldDir, 'pages', 'about.html'),
    '<main><h1>Fallback about page</h1></main>');

  const server = await startIsolatedServer(t, { worldDir, dataDir, backupDir });
  const homepage = await fetch(`${server.baseUrl}/world/`);
  const prettyPage = await fetch(`${server.baseUrl}/world/about`);

  assert.equal(homepage.status, 200);
  assert.match(await homepage.text(), /Fallback home page/);
  assert.equal(prettyPage.status, 200);
  assert.match(await prettyPage.text(), /Fallback about page/);
  await server.stop();
});

test('delete records for quarantined targets remain private after a safe recreation', async (t) => {
  // Mutation caught: assigning every delete `published` revives a private delete record with the path.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aibuilds-publication-private-delete-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const worldDir = path.join(root, 'world');
  const dataDir = path.join(root, 'data');
  const backupDir = path.join(root, 'backups');
  await fs.mkdir(path.join(worldDir, 'pages'), { recursive: true });
  await fs.mkdir(dataDir, { recursive: true });
  const server = await startIsolatedServer(t, { worldDir, dataDir, backupDir });
  const relativePath = 'pages/private-delete.html';

  let result = await jsonRequest(server.baseUrl, '/api/contribute', {
    method: 'POST', headers: await challengeHeaders(server.baseUrl),
    body: JSON.stringify({
      agent_name: 'RiskAuthor', action: 'create', file_path: relativePath,
      content: '<p>Inject 8 mg weekly for best results.</p>', message: 'private risky create',
    }),
  });
  assert.equal(result.body.publicationStatus, 'quarantined');
  result = await jsonRequest(server.baseUrl, '/api/contribute', {
    method: 'POST', headers: await challengeHeaders(server.baseUrl),
    body: JSON.stringify({
      agent_name: 'PrivateDeleter', action: 'delete', file_path: relativePath,
      message: 'delete private target',
    }),
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.publicationStatus, 'quarantined');
  const privateDeleteId = result.body.contribution.id;

  result = await jsonRequest(server.baseUrl, '/api/contribute', {
    method: 'POST', headers: await challengeHeaders(server.baseUrl),
    body: JSON.stringify({
      agent_name: 'SafeRecreator', action: 'create', file_path: relativePath,
      content: '<main><h1>Safe recreated page</h1></main>', message: 'safe recreation',
    }),
  });
  assert.equal(result.body.publicationStatus, 'published');
  assert.equal((await jsonRequest(server.baseUrl, `/api/contributions/${privateDeleteId}`)).response.status, 404);
  assert.equal((await jsonRequest(server.baseUrl, '/api/history')).body.items
    .some(item => item.id === privateDeleteId), false);
  assert.equal((await jsonRequest(server.baseUrl, '/api/agents/PrivateDeleter')).response.status, 404);
  await server.stop();
});

test('an exact risky approval survives resubmission and restart', async (t) => {
  // Mutation caught: clearing approval in the generic published branch re-quarantines on restart.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aibuilds-publication-approved-restart-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const worldDir = path.join(root, 'world');
  const dataDir = path.join(root, 'data');
  const backupDir = path.join(root, 'backups');
  const relativePath = 'pages/approved-risk.html';
  const riskyBytes = '<p>Inject 6 mg weekly for best results.</p>';
  await fs.mkdir(path.join(worldDir, 'pages'), { recursive: true });
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(path.join(worldDir, relativePath), riskyBytes);
  let server = await startIsolatedServer(t, { worldDir, dataDir, backupDir });
  const listed = await jsonRequest(server.baseUrl, '/api/admin/quarantine', {
    headers: { 'X-Admin-Secret': 'test-secret' },
  });
  const record = listed.body.quarantined.find(item => item.path === relativePath);
  assert.ok(record);
  let result = await jsonRequest(server.baseUrl, '/api/admin/quarantine/approve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Admin-Secret': 'test-secret' },
    body: JSON.stringify({ path: relativePath, content_hash: record.content_hash }),
  });
  assert.equal(result.response.status, 200);
  result = await jsonRequest(server.baseUrl, '/api/contribute', {
    method: 'POST', headers: await challengeHeaders(server.baseUrl),
    body: JSON.stringify({
      agent_name: 'ApprovedAgent', action: 'edit', file_path: relativePath,
      content: riskyBytes, message: 'exact approved resubmission',
    }),
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.publicationStatus, 'published');
  let moderationState = JSON.parse(await fs.readFile(path.join(dataDir, 'moderation.json'), 'utf8'));
  assert.equal(moderationState.moderation.approvedFiles[relativePath], record.content_hash);
  await server.stop();

  server = await startIsolatedServer(t, { worldDir, dataDir, backupDir });
  const afterRestart = await jsonRequest(server.baseUrl, '/api/admin/quarantine', {
    headers: { 'X-Admin-Secret': 'test-secret' },
  });
  assert.equal(afterRestart.body.quarantined.some(item => item.path === relativePath), false);
  assert.equal((await jsonRequest(server.baseUrl, `/api/world/${relativePath}`)).response.status, 200);
  moderationState = JSON.parse(await fs.readFile(path.join(dataDir, 'moderation.json'), 'utf8'));
  assert.equal(moderationState.moderation.approvedFiles[relativePath], record.content_hash);
  await server.stop();
});

for (const failureKind of ['moderation', 'state', 'git']) {
  test(`${failureKind} persistence failure rolls back contribution bytes, records, and public counters durably`, async (t) => {
    // Mutations caught: swallowing this failure or omitting compensation leaves the failed edit public/durable.
    const root = await fs.mkdtemp(path.join(os.tmpdir(), `aibuilds-publication-${failureKind}-rollback-`));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const worldDir = path.join(root, 'world');
    const dataDir = path.join(root, 'data');
    const backupDir = path.join(root, 'backups');
    const relativePath = 'pages/original.html';
    const originalBytes = '<main><h1>Original durable bytes</h1></main>';
    const failedAgentName = failureKind === 'state' ? 'F'.repeat(120) : 'FailedAgent';
    const storedFailedAgentName = failedAgentName.slice(0, 100);
    const armPath = path.join(root, 'arm-failure');
    const preloadPath = path.join(root, 'fail-first-persistence.cjs');
    await fs.mkdir(path.join(worldDir, 'pages'), { recursive: true });
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(path.join(worldDir, relativePath), originalBytes);
    await fs.writeFile(path.join(dataDir, 'state.json'), JSON.stringify({
      history: [{
        id: 'original-record', timestamp: '2026-08-10T10:00:00.000Z', agent_name: 'OriginalAgent',
        action: 'create', file_path: relativePath, message: 'original record',
        publicationStatus: 'published', reactions: { fire: [], heart: [], rocket: [], eyes: [] },
      }],
    }));
    await fs.writeFile(preloadPath, `
      const fs = require('node:fs');
      const promises = fs.promises;
      const originalRename = promises.rename.bind(promises);
      let failed = false;
      promises.rename = async function failFirstPersistenceRename(source, target) {
        if (!failed && fs.existsSync(process.env.AIBUILDS_FAILURE_ARM) &&
            String(target) === process.env.AIBUILDS_FAILURE_TARGET) {
          failed = true;
          throw Object.assign(new Error('forced persistence failure'), { code: 'EIO' });
        }
        return originalRename(source, target);
      };
    `);
    const extraEnv = failureKind === 'git' ? {} : {
      NODE_OPTIONS: `--require=${preloadPath}`,
      AIBUILDS_FAILURE_ARM: armPath,
      AIBUILDS_FAILURE_TARGET: path.join(dataDir,
        failureKind === 'moderation' ? 'moderation.json' : 'state.json'),
    };
    let server = await startIsolatedServer(t, { worldDir, dataDir, backupDir, extraEnv });
    if (failureKind === 'git') {
      const hookPath = path.join(worldDir, '.git', 'hooks', 'pre-commit');
      await fs.writeFile(hookPath, '#!/bin/sh\nexit 1\n');
      await fs.chmod(hookPath, 0o755);
    } else {
      await fs.writeFile(armPath, 'armed');
    }

    const result = await jsonRequest(server.baseUrl, '/api/contribute', {
      method: 'POST', headers: await challengeHeaders(server.baseUrl),
      body: JSON.stringify({
        agent_name: failedAgentName, action: 'edit', file_path: relativePath,
        content: '<main><h1>Failed replacement bytes</h1></main>', message: `failed ${failureKind} edit`,
      }),
    });
    assert.equal(result.response.status, 500, server.logs.join(''));
    assert.equal(await fs.readFile(path.join(worldDir, relativePath), 'utf8'), originalBytes);
    assert.equal((await jsonRequest(server.baseUrl, '/api/history')).body.items
      .some(item => item.agent_name === storedFailedAgentName), false);
    assert.equal((await jsonRequest(server.baseUrl,
      `/api/agents/${encodeURIComponent(storedFailedAgentName)}`)).response.status, 404);
    assert.equal((await jsonRequest(server.baseUrl, '/api/agents/OriginalAgent')).body.stats.contributions, 1);
    let persistedState = JSON.parse(await fs.readFile(path.join(dataDir, 'state.json'), 'utf8'));
    assert.equal(Object.hasOwn(persistedState.agents || {}, storedFailedAgentName), false);
    await fs.rm(armPath, { force: true });
    await server.crash();

    server = await startIsolatedServer(t, { worldDir, dataDir, backupDir, extraEnv });
    assert.equal(await fs.readFile(path.join(worldDir, relativePath), 'utf8'), originalBytes);
    assert.equal((await jsonRequest(server.baseUrl, '/api/history')).body.items
      .some(item => item.agent_name === storedFailedAgentName), false);
    assert.equal((await jsonRequest(server.baseUrl,
      `/api/agents/${encodeURIComponent(storedFailedAgentName)}`)).response.status, 404);
    assert.equal((await jsonRequest(server.baseUrl, '/api/agents/OriginalAgent')).body.stats.contributions, 1);
    persistedState = JSON.parse(await fs.readFile(path.join(dataDir, 'state.json'), 'utf8'));
    assert.equal(Object.hasOwn(persistedState.agents || {}, storedFailedAgentName), false);
    await server.stop();
  });
}
