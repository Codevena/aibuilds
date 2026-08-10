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
        const child = require('node:child_process').execFile('git', ['log', '-2', '--pretty=%B'], { cwd: worldDir },
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

test('rollback byte-restore failure persists a fail-closed quarantine across restart', async (t) => {
  // Mutation caught: restoring the old public moderation boundary after byte rollback failure exposes risky bytes.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aibuilds-publication-restore-failure-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const worldDir = path.join(root, 'world');
  const dataDir = path.join(root, 'data');
  const backupDir = path.join(root, 'backups');
  const relativePath = 'pages/restore-failure.html';
  const fullPath = path.join(worldDir, relativePath);
  const originalBytes = '<main><h1>Original public bytes</h1></main>';
  const riskyBytes = '<p>Inject 11 mg weekly for best results.</p>';
  const armPath = path.join(root, 'arm-restore-failure');
  const preloadPath = path.join(root, 'fail-state-and-restore.cjs');
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(fullPath, originalBytes);
  await fs.writeFile(path.join(dataDir, 'state.json'), JSON.stringify({
    history: [{
      id: 'original-public-record', timestamp: '2026-08-10T10:00:00.000Z', agent_name: 'OriginalAgent',
      action: 'create', file_path: relativePath, message: 'original public record',
      publicationStatus: 'published', reactions: { fire: [], heart: [], rocket: [], eyes: [] },
    }],
  }));
  await fs.writeFile(preloadPath, `
    const fs = require('node:fs');
    const promises = fs.promises;
    const originalRename = promises.rename.bind(promises);
    let stateFailed = false;
    let worldRenames = 0;
    promises.rename = async function failStateAndRollback(source, target) {
      if (fs.existsSync(process.env.AIBUILDS_FAILURE_ARM)) {
        if (!stateFailed && String(target) === process.env.AIBUILDS_STATE_TARGET) {
          stateFailed = true;
          throw Object.assign(new Error('forced state persistence failure'), { code: 'EIO' });
        }
        if (String(target) === process.env.AIBUILDS_WORLD_TARGET) {
          worldRenames += 1;
          if (worldRenames === 2) {
            throw Object.assign(new Error('forced byte restore failure'), { code: 'EIO' });
          }
        }
      }
      return originalRename(source, target);
    };
  `);
  const extraEnv = {
    NODE_OPTIONS: `--require=${preloadPath}`,
    AIBUILDS_FAILURE_ARM: armPath,
    AIBUILDS_STATE_TARGET: path.join(dataDir, 'state.json'),
    AIBUILDS_WORLD_TARGET: fullPath,
  };
  let server = await startIsolatedServer(t, { worldDir, dataDir, backupDir, extraEnv });
  await fs.writeFile(armPath, 'armed');
  const result = await jsonRequest(server.baseUrl, '/api/contribute', {
    method: 'POST', headers: await challengeHeaders(server.baseUrl),
    body: JSON.stringify({
      agent_name: 'FailedRestoreAgent', action: 'edit', file_path: relativePath,
      content: riskyBytes, message: 'force restore failure',
    }),
  });
  assert.equal(result.response.status, 500, server.logs.join(''));
  assert.equal(await fs.readFile(fullPath, 'utf8'), riskyBytes);
  assert.equal((await jsonRequest(server.baseUrl, `/api/world/${relativePath}`)).response.status, 404);
  let listed = await jsonRequest(server.baseUrl, '/api/admin/quarantine', {
    headers: { 'X-Admin-Secret': 'test-secret' },
  });
  let record = listed.body.quarantined.find(item => item.path === relativePath);
  assert.ok(record);
  assert.deepEqual(record.reasons, ['rollback_failed']);
  assert.equal(record.content_hash, contentHash(riskyBytes));
  let gitResult = await execFileAsync('git', ['show', `HEAD:${relativePath}`], { cwd: worldDir });
  assert.equal(gitResult.stdout.trim(), originalBytes,
    'Git compensation must restore the public parent tree even when working-byte restore fails');
  gitResult = await execFileAsync('git', ['diff', '--cached', '--name-only'], { cwd: worldDir });
  assert.equal(gitResult.stdout, '');
  gitResult = await execFileAsync('git', ['status', '--porcelain'], { cwd: worldDir });
  assert.equal(gitResult.stdout.trim(), `M ${relativePath}`);
  await fs.rm(armPath, { force: true });
  await server.crash();

  server = await startIsolatedServer(t, { worldDir, dataDir, backupDir, extraEnv });
  assert.equal((await jsonRequest(server.baseUrl, `/api/world/${relativePath}`)).response.status, 404);
  listed = await jsonRequest(server.baseUrl, '/api/admin/quarantine', {
    headers: { 'X-Admin-Secret': 'test-secret' },
  });
  record = listed.body.quarantined.find(item => item.path === relativePath);
  assert.ok(record);
  assert.deepEqual(record.reasons, ['high_stakes_medical']);
  assert.equal(record.content_hash, contentHash(riskyBytes));
  const correction = await jsonRequest(server.baseUrl, '/api/contribute', {
    method: 'POST', headers: await challengeHeaders(server.baseUrl),
    body: JSON.stringify({
      agent_name: 'SafeRestoreAgent', action: 'edit', file_path: relativePath,
      content: '<main><h1>Safe correction after restore failure</h1></main>',
      message: 'safe correction after restore failure',
    }),
  });
  assert.equal(correction.response.status, 200, server.logs.join(''));
  assert.equal(correction.body.publicationStatus, 'published');
  const correctionDiff = await jsonRequest(
    server.baseUrl, `/api/contributions/${correction.body.contribution.id}/diff`,
  );
  assert.equal(correctionDiff.response.status, 200);
  assert.match(correctionDiff.body.diff || '', /Safe correction after restore failure/);
  assert.doesNotMatch(correctionDiff.body.diff || '', /Inject 11 mg weekly|force restore failure/);
  const timeline = (await jsonRequest(server.baseUrl, '/api/timeline')).body;
  assert.equal(timeline.some(item => item.message === 'force restore failure'), false);
  const persisted = JSON.parse(await fs.readFile(path.join(dataDir, 'state.json'), 'utf8'));
  const correctionRecord = persisted.history.find(item => item.id === correction.body.contribution.id);
  gitResult = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: worldDir });
  assert.equal(correctionRecord.gitHash, gitResult.stdout.trim());
  gitResult = await execFileAsync('git', ['status', '--porcelain', '--', relativePath], { cwd: worldDir });
  assert.equal(gitResult.stdout, '');
  await server.stop();
});

test('rollback restores an originally untracked quarantined path without committing private bytes', async (t) => {
  // Mutation caught: forcing tracked=true and adding restored bytes commits the private untracked parent.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aibuilds-publication-untracked-git-rollback-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const worldDir = path.join(root, 'world');
  const dataDir = path.join(root, 'data');
  const backupDir = path.join(root, 'backups');
  const relativePath = 'pages/private-untracked.html';
  const fullPath = path.join(worldDir, relativePath);
  const originalPrivateBytes = '<p>Inject 5 mg weekly for best results.</p>';
  const failedPrivateBytes = '<p>Inject 17 mg weekly for best results.</p>';
  const armPath = path.join(root, 'arm-state-failure');
  const preloadPath = path.join(root, 'fail-first-state-rename.cjs');
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(path.join(worldDir, 'pages', 'tracked-seed.html'),
    '<main><h1>Tracked seed</h1></main>');
  await execFileAsync('git', ['init'], { cwd: worldDir });
  await execFileAsync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: worldDir });
  await execFileAsync('git', ['config', 'user.name', 'Publication Test'], { cwd: worldDir });
  await execFileAsync('git', ['add', '.'], { cwd: worldDir });
  await execFileAsync('git', ['commit', '-m', 'tracked seed'], { cwd: worldDir });
  await fs.writeFile(fullPath, originalPrivateBytes);
  await fs.writeFile(preloadPath, `
    const fs = require('node:fs');
    const promises = fs.promises;
    const originalRename = promises.rename.bind(promises);
    let failed = false;
    promises.rename = async function failFirstStateRename(source, target) {
      if (!failed && fs.existsSync(process.env.AIBUILDS_FAILURE_ARM) &&
          String(target) === process.env.AIBUILDS_STATE_TARGET) {
        failed = true;
        throw Object.assign(new Error('forced state persistence failure'), { code: 'EIO' });
      }
      return originalRename(source, target);
    };
  `);
  const extraEnv = {
    NODE_OPTIONS: `--require=${preloadPath}`,
    AIBUILDS_FAILURE_ARM: armPath,
    AIBUILDS_STATE_TARGET: path.join(dataDir, 'state.json'),
  };
  let server = await startIsolatedServer(t, { worldDir, dataDir, backupDir, extraEnv });
  assert.equal((await jsonRequest(server.baseUrl, `/api/world/${relativePath}`)).response.status, 404);
  await assert.rejects(execFileAsync('git', ['ls-files', '--error-unmatch', '--', relativePath], { cwd: worldDir }));
  await fs.writeFile(armPath, 'armed');
  const failed = await jsonRequest(server.baseUrl, '/api/contribute', {
    method: 'POST', headers: await challengeHeaders(server.baseUrl),
    body: JSON.stringify({
      agent_name: 'PrivateUntrackedAgent', action: 'edit', file_path: relativePath,
      content: failedPrivateBytes, message: 'PRIVATE_UNTRACKED_FAILURE',
    }),
  });
  assert.equal(failed.response.status, 500, server.logs.join(''));
  assert.equal(await fs.readFile(fullPath, 'utf8'), originalPrivateBytes);
  assert.equal((await jsonRequest(server.baseUrl, `/api/world/${relativePath}`)).response.status, 404);
  await assert.rejects(execFileAsync('git', ['ls-files', '--error-unmatch', '--', relativePath], { cwd: worldDir }));
  await assert.rejects(execFileAsync('git', ['show', `HEAD:${relativePath}`], { cwd: worldDir }));
  let gitResult = await execFileAsync('git', ['diff', '--cached', '--name-only'], { cwd: worldDir });
  assert.equal(gitResult.stdout, '');
  gitResult = await execFileAsync('git', ['status', '--porcelain', '--', relativePath], { cwd: worldDir });
  assert.equal(gitResult.stdout.trim(), `?? ${relativePath}`);
  await fs.rm(armPath, { force: true });
  await server.crash();

  server = await startIsolatedServer(t, { worldDir, dataDir, backupDir, extraEnv });
  assert.equal((await jsonRequest(server.baseUrl, `/api/world/${relativePath}`)).response.status, 404);
  await assert.rejects(execFileAsync('git', ['ls-files', '--error-unmatch', '--', relativePath], { cwd: worldDir }));
  const correction = await jsonRequest(server.baseUrl, '/api/contribute', {
    method: 'POST', headers: await challengeHeaders(server.baseUrl),
    body: JSON.stringify({
      agent_name: 'SafeUntrackedAgent', action: 'edit', file_path: relativePath,
      content: '<main><h1>Safe formerly untracked page</h1></main>', message: 'SAFE_UNTRACKED_MARKER',
    }),
  });
  assert.equal(correction.response.status, 200, server.logs.join(''));
  assert.equal(correction.body.publicationStatus, 'published');
  const diff = await jsonRequest(server.baseUrl, `/api/contributions/${correction.body.contribution.id}/diff`);
  assert.equal(diff.response.status, 200);
  assert.match(diff.body.diff || '', /Safe formerly untracked page/);
  assert.doesNotMatch(diff.body.diff || '', /Inject (?:5|17) mg weekly|PRIVATE_UNTRACKED_FAILURE/);
  const timeline = (await jsonRequest(server.baseUrl, '/api/timeline')).body;
  assert.equal(timeline.some(item => item.message === 'PRIVATE_UNTRACKED_FAILURE'), false);
  assert.equal(timeline.some(item => item.message === 'SAFE_UNTRACKED_MARKER'), true);
  const persisted = JSON.parse(await fs.readFile(path.join(dataDir, 'state.json'), 'utf8'));
  const correctionRecord = persisted.history.find(item => item.id === correction.body.contribution.id);
  gitResult = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: worldDir });
  assert.equal(correctionRecord.gitHash, gitResult.stdout.trim());
  gitResult = await execFileAsync('git', ['status', '--porcelain'], { cwd: worldDir });
  assert.equal(gitResult.stdout, '');
  await server.stop();
});

test('post-Git state failure is compensated before a later public contribution diff', async (t) => {
  // Mutation caught: omitting the compensating commit makes the next public diff include failed risky bytes.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aibuilds-publication-git-compensation-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const worldDir = path.join(root, 'world');
  const dataDir = path.join(root, 'data');
  const backupDir = path.join(root, 'backups');
  const relativePath = 'pages/git-compensation.html';
  const fullPath = path.join(worldDir, relativePath);
  const originalBytes = '<main><h1>Original Git baseline</h1></main>';
  const riskyBytes = '<p>Inject 13 mg weekly for best results.</p>';
  const armPath = path.join(root, 'arm-state-failure');
  const preloadPath = path.join(root, 'fail-first-state-rename.cjs');
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(fullPath, originalBytes);
  await fs.writeFile(path.join(dataDir, 'state.json'), JSON.stringify({
    history: [{
      id: 'git-baseline-record', timestamp: '2026-08-10T10:00:00.000Z', agent_name: 'BaselineAgent',
      action: 'create', file_path: relativePath, message: 'git baseline',
      publicationStatus: 'published', reactions: { fire: [], heart: [], rocket: [], eyes: [] },
    }],
  }));
  await fs.writeFile(preloadPath, `
    const fs = require('node:fs');
    const promises = fs.promises;
    const originalRename = promises.rename.bind(promises);
    let failed = false;
    promises.rename = async function failFirstStateRename(source, target) {
      if (!failed && fs.existsSync(process.env.AIBUILDS_FAILURE_ARM) &&
          String(target) === process.env.AIBUILDS_STATE_TARGET) {
        failed = true;
        throw Object.assign(new Error('forced state persistence failure'), { code: 'EIO' });
      }
      return originalRename(source, target);
    };
  `);
  const extraEnv = {
    NODE_OPTIONS: `--require=${preloadPath}`,
    AIBUILDS_FAILURE_ARM: armPath,
    AIBUILDS_STATE_TARGET: path.join(dataDir, 'state.json'),
  };
  const server = await startIsolatedServer(t, { worldDir, dataDir, backupDir, extraEnv });
  await fs.writeFile(armPath, 'armed');
  let result = await jsonRequest(server.baseUrl, '/api/contribute', {
    method: 'POST', headers: await challengeHeaders(server.baseUrl),
    body: JSON.stringify({
      agent_name: 'FailedGitAgent', action: 'edit', file_path: relativePath,
      content: riskyBytes, message: 'FAILED_GIT_MARKER',
    }),
  });
  assert.equal(result.response.status, 500, server.logs.join(''));
  assert.equal(await fs.readFile(fullPath, 'utf8'), originalBytes);

  result = await jsonRequest(server.baseUrl, '/api/contribute', {
    method: 'POST', headers: await challengeHeaders(server.baseUrl),
    body: JSON.stringify({
      agent_name: 'SafeGitAgent', action: 'edit', file_path: relativePath,
      content: '<main><h1>Safe post-failure version</h1></main>', message: 'SAFE_GIT_MARKER',
    }),
  });
  assert.equal(result.response.status, 200, server.logs.join(''));
  const safeId = result.body.contribution.id;
  const diff = await jsonRequest(server.baseUrl, `/api/contributions/${safeId}/diff`);
  assert.equal(diff.response.status, 200);
  assert.match(diff.body.diff || '', /Safe post-failure version/);
  assert.doesNotMatch(diff.body.diff || '', /Inject 13 mg weekly|FAILED_GIT_MARKER/);
  const timeline = (await jsonRequest(server.baseUrl, '/api/timeline')).body;
  assert.equal(timeline.some(item => item.message === 'FAILED_GIT_MARKER'), false);
  assert.equal(timeline.some(item => item.message === 'SAFE_GIT_MARKER'), true);
  const persisted = JSON.parse(await fs.readFile(path.join(dataDir, 'state.json'), 'utf8'));
  const safeRecord = persisted.history.find(item => item.id === safeId);
  const { stdout: head } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: worldDir });
  const { stdout: treeBytes } = await execFileAsync('git', ['show', `HEAD:${relativePath}`], { cwd: worldDir });
  const { stdout: status } = await execFileAsync('git', ['status', '--porcelain'], { cwd: worldDir });
  assert.equal(safeRecord.gitHash, head.trim());
  assert.equal(treeBytes.trim(), '<main><h1>Safe post-failure version</h1></main>');
  assert.equal(status, '');
  await server.stop();
});

test('successful quarantine sanitizes its Git parent before a later public correction', async (t) => {
  // Mutation caught: retaining the quarantined commit as HEAD exposes its deleted bytes in the correction diff.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aibuilds-publication-normal-quarantine-git-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const worldDir = path.join(root, 'world');
  const dataDir = path.join(root, 'data');
  const backupDir = path.join(root, 'backups');
  const relativePath = 'pages/normal-quarantine-parent.html';
  const fullPath = path.join(worldDir, relativePath);
  const originalBytes = '<main><h1>Original public parent</h1></main>';
  const privateBytes = '<p>Inject 29 mg weekly PRIVATE_NORMAL_QUARANTINE.</p>';
  const safeBytes = '<main><h1>Safe correction after normal quarantine</h1></main>';
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(fullPath, originalBytes);
  await fs.writeFile(path.join(dataDir, 'state.json'), JSON.stringify({
    history: [{
      id: 'normal-quarantine-baseline', timestamp: '2026-08-10T10:00:00.000Z',
      agent_name: 'NormalQuarantineBaseline', action: 'create', file_path: relativePath,
      message: 'normal quarantine baseline', publicationStatus: 'published',
      reactions: { fire: [], heart: [], rocket: [], eyes: [] },
    }],
  }));
  await execFileAsync('git', ['init'], { cwd: worldDir });
  await execFileAsync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: worldDir });
  await execFileAsync('git', ['config', 'user.name', 'Publication Test'], { cwd: worldDir });
  await execFileAsync('git', ['add', '.'], { cwd: worldDir });
  await execFileAsync('git', ['commit', '-m', 'normal quarantine public baseline'], { cwd: worldDir });
  const server = await startIsolatedServer(t, { worldDir, dataDir, backupDir });

  const quarantined = await jsonRequest(server.baseUrl, '/api/contribute', {
    method: 'POST', headers: await challengeHeaders(server.baseUrl),
    body: JSON.stringify({
      agent_name: 'NormalPrivateAgent', action: 'edit', file_path: relativePath,
      content: privateBytes, message: 'PRIVATE_NORMAL_QUARANTINE',
    }),
  });
  assert.equal(quarantined.response.status, 200, server.logs.join(''));
  assert.equal(quarantined.body.publicationStatus, 'quarantined');
  assert.equal(await fs.readFile(fullPath, 'utf8'), privateBytes);
  assert.equal((await jsonRequest(server.baseUrl, `/api/world/${relativePath}`)).response.status, 404);
  let gitResult = await execFileAsync('git', ['show', `HEAD:${relativePath}`], { cwd: worldDir });
  assert.equal(gitResult.stdout.trim(), originalBytes);

  const correction = await jsonRequest(server.baseUrl, '/api/contribute', {
    method: 'POST', headers: await challengeHeaders(server.baseUrl),
    body: JSON.stringify({
      agent_name: 'NormalSafeAgent', action: 'edit', file_path: relativePath,
      content: safeBytes, message: 'SAFE_AFTER_NORMAL_QUARANTINE',
    }),
  });
  assert.equal(correction.response.status, 200, server.logs.join(''));
  assert.equal(correction.body.publicationStatus, 'published');
  const diff = await jsonRequest(
    server.baseUrl, `/api/contributions/${correction.body.contribution.id}/diff`,
  );
  assert.equal(diff.response.status, 200);
  assert.match(diff.body.diff || '', /Safe correction after normal quarantine/);
  assert.doesNotMatch(diff.body.diff || '', /PRIVATE_NORMAL_QUARANTINE|Inject 29 mg weekly/);
  const timeline = (await jsonRequest(server.baseUrl, '/api/timeline')).body;
  assert.equal(timeline.some(item => item.message === 'PRIVATE_NORMAL_QUARANTINE'), false);
  assert.equal(timeline.some(item => item.message === 'SAFE_AFTER_NORMAL_QUARANTINE'), true);
  gitResult = await execFileAsync('git', ['status', '--porcelain'], { cwd: worldDir });
  assert.equal(gitResult.stdout, '');
  await server.stop();
});

test('rollback restores every pre-existing conflict stage for the canonical path', async (t) => {
  // Mutation caught: restoring only a stage-0 entry removes the original stages 1/2/3.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aibuilds-publication-conflict-index-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const worldDir = path.join(root, 'world');
  const dataDir = path.join(root, 'data');
  const backupDir = path.join(root, 'backups');
  const relativePath = 'pages/conflicted.txt';
  const unrelatedPath = 'pages/unrelated-index.txt';
  const fullPath = path.join(worldDir, relativePath);
  const armPath = path.join(root, 'arm-state-failure');
  const preloadPath = path.join(root, 'fail-first-state-rename.cjs');
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(fullPath, 'base\n');
  await fs.writeFile(path.join(worldDir, unrelatedPath), 'unrelated base\n');
  await execFileAsync('git', ['init'], { cwd: worldDir });
  await execFileAsync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: worldDir });
  await execFileAsync('git', ['config', 'user.name', 'Publication Test'], { cwd: worldDir });
  await execFileAsync('git', ['add', relativePath, unrelatedPath], { cwd: worldDir });
  await execFileAsync('git', ['commit', '-m', 'conflict base'], { cwd: worldDir });
  const initialBranch = (await execFileAsync(
    'git', ['branch', '--show-current'], { cwd: worldDir },
  )).stdout.trim();
  await execFileAsync('git', ['checkout', '-b', 'conflict-side'], { cwd: worldDir });
  await fs.writeFile(fullPath, 'theirs\n');
  await execFileAsync('git', ['commit', '-am', 'theirs'], { cwd: worldDir });
  await execFileAsync('git', ['checkout', initialBranch], { cwd: worldDir });
  await fs.writeFile(fullPath, 'ours\n');
  await execFileAsync('git', ['commit', '-am', 'ours'], { cwd: worldDir });
  await assert.rejects(execFileAsync('git', ['merge', 'conflict-side'], { cwd: worldDir }));
  await fs.writeFile(path.join(worldDir, unrelatedPath), 'unrelated staged change\n');
  await execFileAsync('git', ['add', unrelatedPath], { cwd: worldDir });
  const conflictedBytes = await fs.readFile(fullPath, 'utf8');
  const beforeIndex = (await execFileAsync(
    'git', ['ls-files', '--stage', '-z', '--', relativePath], { cwd: worldDir },
  )).stdout;
  const beforeUnrelatedIndex = (await execFileAsync(
    'git', ['ls-files', '--stage', '-z', '--', unrelatedPath], { cwd: worldDir },
  )).stdout;
  assert.deepEqual(Array.from(beforeIndex.matchAll(/\s([123])\t/g), match => Number(match[1])), [1, 2, 3]);
  await fs.writeFile(preloadPath, `
    const fs = require('node:fs');
    const promises = fs.promises;
    const originalRename = promises.rename.bind(promises);
    let failed = false;
    promises.rename = async function failFirstStateRename(source, target) {
      if (!failed && fs.existsSync(process.env.AIBUILDS_FAILURE_ARM) &&
          String(target) === process.env.AIBUILDS_STATE_TARGET) {
        failed = true;
        throw Object.assign(new Error('forced state persistence failure'), { code: 'EIO' });
      }
      return originalRename(source, target);
    };
  `);
  const server = await startIsolatedServer(t, {
    worldDir,
    dataDir,
    backupDir,
    extraEnv: {
      NODE_OPTIONS: `--require=${preloadPath}`,
      AIBUILDS_FAILURE_ARM: armPath,
      AIBUILDS_STATE_TARGET: path.join(dataDir, 'state.json'),
    },
  });
  await fs.writeFile(armPath, 'armed');

  const failed = await jsonRequest(server.baseUrl, '/api/contribute', {
    method: 'POST', headers: await challengeHeaders(server.baseUrl),
    body: JSON.stringify({
      agent_name: 'ConflictRollbackAgent', action: 'edit', file_path: relativePath,
      content: 'temporary private resolution\n', message: 'force conflict rollback',
    }),
  });
  assert.equal(failed.response.status, 500, server.logs.join(''));
  assert.equal(await fs.readFile(fullPath, 'utf8'), conflictedBytes);
  const afterIndex = (await execFileAsync(
    'git', ['ls-files', '--stage', '-z', '--', relativePath], { cwd: worldDir },
  )).stdout;
  assert.equal(afterIndex, beforeIndex);
  const afterUnrelatedIndex = (await execFileAsync(
    'git', ['ls-files', '--stage', '-z', '--', unrelatedPath], { cwd: worldDir },
  )).stdout;
  assert.equal(afterUnrelatedIndex, beforeUnrelatedIndex);
  const { stdout: headBytes } = await execFileAsync('git', ['show', `HEAD:${relativePath}`], { cwd: worldDir });
  assert.equal(headBytes, 'ours\n');
  assert.doesNotMatch(headBytes, /temporary private resolution/);
  await server.stop();
});

test('rollback restores assume-unchanged and skip-worktree flags with the exact stage-0 entry', async (t) => {
  // Mutation caught: recreating cacheinfo with default flags changes the original `s` index tag to `H`.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aibuilds-publication-index-flags-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const worldDir = path.join(root, 'world');
  const dataDir = path.join(root, 'data');
  const backupDir = path.join(root, 'backups');
  const relativePath = 'pages/index-flags.txt';
  const fullPath = path.join(worldDir, relativePath);
  const originalBytes = 'public flag baseline\n';
  const armPath = path.join(root, 'arm-state-failure');
  const preloadPath = path.join(root, 'fail-first-state-rename.cjs');
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(fullPath, originalBytes);
  await execFileAsync('git', ['init'], { cwd: worldDir });
  await execFileAsync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: worldDir });
  await execFileAsync('git', ['config', 'user.name', 'Publication Test'], { cwd: worldDir });
  await execFileAsync('git', ['add', relativePath], { cwd: worldDir });
  await execFileAsync('git', ['commit', '-m', 'flag base'], { cwd: worldDir });
  await execFileAsync('git', ['update-index', '--assume-unchanged', relativePath], { cwd: worldDir });
  await execFileAsync('git', ['update-index', '--skip-worktree', relativePath], { cwd: worldDir });
  const beforeStage = (await execFileAsync(
    'git', ['ls-files', '--stage', '-z', '--', relativePath], { cwd: worldDir },
  )).stdout;
  const beforeFlags = (await execFileAsync(
    'git', ['ls-files', '-v', '-z', '--', relativePath], { cwd: worldDir },
  )).stdout;
  assert.equal(beforeFlags, `s ${relativePath}\0`);
  await fs.writeFile(preloadPath, `
    const fs = require('node:fs');
    const promises = fs.promises;
    const originalRename = promises.rename.bind(promises);
    let failed = false;
    promises.rename = async function failFirstStateRename(source, target) {
      if (!failed && fs.existsSync(process.env.AIBUILDS_FAILURE_ARM) &&
          String(target) === process.env.AIBUILDS_STATE_TARGET) {
        failed = true;
        throw Object.assign(new Error('forced state persistence failure'), { code: 'EIO' });
      }
      return originalRename(source, target);
    };
  `);
  const server = await startIsolatedServer(t, {
    worldDir,
    dataDir,
    backupDir,
    extraEnv: {
      NODE_OPTIONS: `--require=${preloadPath}`,
      AIBUILDS_FAILURE_ARM: armPath,
      AIBUILDS_STATE_TARGET: path.join(dataDir, 'state.json'),
    },
  });
  await fs.writeFile(armPath, 'armed');

  const failed = await jsonRequest(server.baseUrl, '/api/contribute', {
    method: 'POST', headers: await challengeHeaders(server.baseUrl),
    body: JSON.stringify({
      agent_name: 'FlagRollbackAgent', action: 'edit', file_path: relativePath,
      content: 'temporary private flag bytes\n', message: 'force flag rollback',
    }),
  });
  assert.equal(failed.response.status, 500, server.logs.join(''));
  assert.equal(await fs.readFile(fullPath, 'utf8'), originalBytes);
  const afterStage = (await execFileAsync(
    'git', ['ls-files', '--stage', '-z', '--', relativePath], { cwd: worldDir },
  )).stdout;
  const afterFlags = (await execFileAsync(
    'git', ['ls-files', '-v', '-z', '--', relativePath], { cwd: worldDir },
  )).stdout;
  assert.equal(afterStage, beforeStage);
  assert.equal(afterFlags, beforeFlags);
  const { stdout: latestSubject } = await execFileAsync(
    'git', ['log', '-1', '--format=%s'], { cwd: worldDir },
  );
  assert.match(latestSubject, /^rollback: /,
    'the test must reach post-commit compensation instead of passing on the original skip-worktree guard');
  const { stdout: headBytes } = await execFileAsync('git', ['show', `HEAD:${relativePath}`], { cwd: worldDir });
  assert.equal(headBytes, originalBytes);
  await server.stop();
});

test('Git transactions treat wildcard characters in canonical filenames literally', async (t) => {
  // Mutation caught: passing the raw path after `--` lets Git match and publish the staged neighbor.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aibuilds-publication-literal-pathspec-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const worldDir = path.join(root, 'world');
  const dataDir = path.join(root, 'data');
  const backupDir = path.join(root, 'backups');
  const literalPath = 'pages/exact*.txt';
  const neighborPath = 'pages/exact-neighbor.txt';
  const literalFullPath = path.join(worldDir, literalPath);
  const neighborFullPath = path.join(worldDir, neighborPath);
  const neighborPublicBytes = 'neighbor public baseline\n';
  const neighborPrivateBytes = 'PRIVATE_WILDCARD_NEIGHBOR\n';
  const armPath = path.join(root, 'arm-state-failure');
  const preloadPath = path.join(root, 'fail-first-state-rename.cjs');
  await fs.mkdir(path.dirname(literalFullPath), { recursive: true });
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(literalFullPath, 'literal public baseline\n');
  await fs.writeFile(neighborFullPath, neighborPublicBytes);
  await execFileAsync('git', ['init'], { cwd: worldDir });
  await execFileAsync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: worldDir });
  await execFileAsync('git', ['config', 'user.name', 'Publication Test'], { cwd: worldDir });
  await execFileAsync('git', ['add', '.'], { cwd: worldDir });
  await execFileAsync('git', ['commit', '-m', 'literal pathspec baseline'], { cwd: worldDir });
  await fs.writeFile(neighborFullPath, neighborPrivateBytes);
  await execFileAsync('git', ['add', '--', neighborPath], { cwd: worldDir });
  const neighborIndexBefore = (await execFileAsync(
    'git', ['ls-files', '--stage', '-z', '--', neighborPath], { cwd: worldDir },
  )).stdout;
  await fs.writeFile(preloadPath, `
    const fs = require('node:fs');
    const promises = fs.promises;
    const originalRename = promises.rename.bind(promises);
    let failed = false;
    promises.rename = async function failFirstStateRename(source, target) {
      if (!failed && fs.existsSync(process.env.AIBUILDS_FAILURE_ARM) &&
          String(target) === process.env.AIBUILDS_STATE_TARGET) {
        failed = true;
        throw Object.assign(new Error('forced state persistence failure'), { code: 'EIO' });
      }
      return originalRename(source, target);
    };
  `);
  const server = await startIsolatedServer(t, {
    worldDir,
    dataDir,
    backupDir,
    extraEnv: {
      NODE_OPTIONS: `--require=${preloadPath}`,
      AIBUILDS_FAILURE_ARM: armPath,
      AIBUILDS_STATE_TARGET: path.join(dataDir, 'state.json'),
    },
  });

  const result = await jsonRequest(server.baseUrl, '/api/contribute', {
    method: 'POST', headers: await challengeHeaders(server.baseUrl),
    body: JSON.stringify({
      agent_name: 'LiteralPathAgent', action: 'edit', file_path: literalPath,
      content: 'literal safe replacement\n', message: 'LITERAL_PATHSPEC_CONTRIBUTION',
    }),
  });
  assert.equal(result.response.status, 200, server.logs.join(''));
  assert.equal(result.body.publicationStatus, 'published');
  const { stdout: committedNeighbor } = await execFileAsync(
    'git', ['show', `HEAD:${neighborPath}`], { cwd: worldDir },
  );
  assert.equal(committedNeighbor, neighborPublicBytes);
  assert.equal(await fs.readFile(neighborFullPath, 'utf8'), neighborPrivateBytes);
  const neighborIndexAfter = (await execFileAsync(
    'git', ['ls-files', '--stage', '-z', '--', neighborPath], { cwd: worldDir },
  )).stdout;
  assert.equal(neighborIndexAfter, neighborIndexBefore);
  const diff = await jsonRequest(server.baseUrl, `/api/contributions/${result.body.contribution.id}/diff`);
  assert.equal(diff.response.status, 200);
  assert.match(diff.body.diff || '', /literal safe replacement/);
  assert.doesNotMatch(diff.body.diff || '', /PRIVATE_WILDCARD_NEIGHBOR|exact-neighbor/);

  const literalIndexBeforeRollback = (await execFileAsync(
    'git', ['ls-files', '--stage', '-z', '--', literalPath], { cwd: worldDir },
  )).stdout;
  await fs.writeFile(armPath, 'armed');
  const failed = await jsonRequest(server.baseUrl, '/api/contribute', {
    method: 'POST', headers: await challengeHeaders(server.baseUrl),
    body: JSON.stringify({
      agent_name: 'LiteralRollbackAgent', action: 'edit', file_path: literalPath,
      content: 'literal temporary failed replacement\n', message: 'LITERAL_PATHSPEC_ROLLBACK',
    }),
  });
  assert.equal(failed.response.status, 500, server.logs.join(''));
  const literalIndexAfterRollback = (await execFileAsync(
    'git', ['ls-files', '--stage', '-z', '--', literalPath], { cwd: worldDir },
  )).stdout;
  const neighborIndexAfterRollback = (await execFileAsync(
    'git', ['ls-files', '--stage', '-z', '--', neighborPath], { cwd: worldDir },
  )).stdout;
  assert.equal(literalIndexAfterRollback, literalIndexBeforeRollback);
  assert.equal(neighborIndexAfterRollback, neighborIndexBefore);
  const { stdout: rolledBackLiteral } = await execFileAsync(
    'git', ['show', `HEAD:${literalPath}`], { cwd: worldDir },
  );
  assert.equal(rolledBackLiteral, 'literal safe replacement\n');
  assert.equal(await fs.readFile(literalFullPath, 'utf8'), 'literal safe replacement\n');
  await server.stop();
});

test('failed Git compensation stays repair-required until a safe correction repairs its public parent', async (t) => {
  // Mutations caught: ignoring the repair guard publishes immediately; discarding repair state exposes on restart.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aibuilds-publication-durable-git-repair-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const worldDir = path.join(root, 'world');
  const dataDir = path.join(root, 'data');
  const backupDir = path.join(root, 'backups');
  const binDir = path.join(root, 'bin');
  const relativePath = 'pages/durable-git-repair.html';
  const fullPath = path.join(worldDir, relativePath);
  const originalBytes = '<main><h1>Exact public repair parent</h1></main>';
  const privateBytes = '<p>Inject 23 mg weekly PRIVATE_REPAIR_PARENT.</p>';
  const safeBytes = '<main><h1>Safe after durable Git repair</h1></main>';
  const stateArmPath = path.join(root, 'arm-state-failure');
  const gitArmPath = path.join(root, 'arm-git-compensation-failure');
  const walObservedPath = path.join(root, 'git-wal-observed');
  const repairSaveFailureObservedPath = path.join(root, 'repair-save-failure-observed');
  const preloadPath = path.join(root, 'fail-first-state-rename.cjs');
  const wrapperPath = path.join(binDir, 'git');
  const realGit = (await execFileAsync('which', ['git'])).stdout.trim();
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(binDir, { recursive: true });
  await fs.writeFile(fullPath, originalBytes);
  await fs.writeFile(path.join(dataDir, 'state.json'), JSON.stringify({
    history: [{
      id: 'repair-public-record', timestamp: '2026-08-10T10:00:00.000Z', agent_name: 'RepairBaseline',
      action: 'create', file_path: relativePath, message: 'repair public baseline',
      publicationStatus: 'published', reactions: { fire: [], heart: [], rocket: [], eyes: [] },
    }],
  }));
  await execFileAsync('git', ['init'], { cwd: worldDir });
  await execFileAsync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: worldDir });
  await execFileAsync('git', ['config', 'user.name', 'Publication Test'], { cwd: worldDir });
  await execFileAsync('git', ['add', '.'], { cwd: worldDir });
  await execFileAsync('git', ['commit', '-m', 'repair public baseline'], { cwd: worldDir });
  await fs.writeFile(preloadPath, `
    const fs = require('node:fs');
    const promises = fs.promises;
    const originalRename = promises.rename.bind(promises);
    let stateFailed = false;
    let repairSaveFailed = false;
    promises.rename = async function failFirstStateRename(source, target) {
      if (!stateFailed && fs.existsSync(process.env.AIBUILDS_STATE_FAILURE_ARM) &&
          String(target) === process.env.AIBUILDS_STATE_TARGET) {
        stateFailed = true;
        throw Object.assign(new Error('forced state persistence failure'), { code: 'EIO' });
      }
      if (!repairSaveFailed && fs.existsSync(process.env.AIBUILDS_STATE_FAILURE_ARM) &&
          String(target) === process.env.AIBUILDS_MODERATION_TARGET) {
        const snapshot = JSON.parse(fs.readFileSync(source, 'utf8'));
        const repair = snapshot.gitRepairs?.[process.env.AIBUILDS_REPAIR_PATH];
        if (repair?.status === 'required') {
          repairSaveFailed = true;
          fs.writeFileSync(process.env.AIBUILDS_REPAIR_SAVE_FAILURE_OBSERVED, 'failed');
          throw Object.assign(new Error('forced repair-state persistence failure'), { code: 'EIO' });
        }
      }
      return originalRename(source, target);
    };
  `);
  await fs.writeFile(wrapperPath, `#!/bin/sh
if [ "$1" = "commit" ] && [ -f "$AIBUILDS_GIT_WAL_CHECK_ARM" ]; then
  "$AIBUILDS_NODE_BINARY" -e '
    const fs = require("node:fs");
    const state = JSON.parse(fs.readFileSync(process.env.AIBUILDS_MODERATION_TARGET, "utf8"));
    const repair = state.gitRepairs?.[process.env.AIBUILDS_REPAIR_PATH];
    if (repair?.status !== "armed") process.exit(74);
  ' || { echo "missing durable pre-commit Git repair marker" >&2; exit 74; }
  : > "$AIBUILDS_GIT_WAL_OBSERVED"
fi
if [ "$1" = "commit-tree" ] && [ -f "$AIBUILDS_GIT_COMPENSATION_FAILURE_ARM" ]; then
  echo "forced Git compensation failure" >&2
  exit 75
fi
exec "$AIBUILDS_REAL_GIT" "$@"
`);
  await fs.chmod(wrapperPath, 0o755);
  const extraEnv = {
    NODE_OPTIONS: `--require=${preloadPath}`,
    PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
    AIBUILDS_REAL_GIT: realGit,
    AIBUILDS_STATE_FAILURE_ARM: stateArmPath,
    AIBUILDS_STATE_TARGET: path.join(dataDir, 'state.json'),
    AIBUILDS_MODERATION_TARGET: path.join(dataDir, 'moderation.json'),
    AIBUILDS_REPAIR_PATH: relativePath,
    AIBUILDS_REPAIR_SAVE_FAILURE_OBSERVED: repairSaveFailureObservedPath,
    AIBUILDS_NODE_BINARY: process.execPath,
    AIBUILDS_GIT_WAL_CHECK_ARM: stateArmPath,
    AIBUILDS_GIT_WAL_OBSERVED: walObservedPath,
    AIBUILDS_GIT_COMPENSATION_FAILURE_ARM: gitArmPath,
  };
  let server = await startIsolatedServer(t, { worldDir, dataDir, backupDir, extraEnv });
  await fs.writeFile(stateArmPath, 'armed');
  await fs.writeFile(gitArmPath, 'armed');

  const failed = await jsonRequest(server.baseUrl, '/api/contribute', {
    method: 'POST', headers: await challengeHeaders(server.baseUrl),
    body: JSON.stringify({
      agent_name: 'PrivateRepairAgent', action: 'edit', file_path: relativePath,
      content: privateBytes, message: 'PRIVATE_REPAIR_FAILURE',
    }),
  });
  assert.equal(failed.response.status, 500, server.logs.join(''));
  assert.equal(await fs.readFile(walObservedPath, 'utf8'), '');
  assert.equal(await fs.readFile(repairSaveFailureObservedPath, 'utf8'), 'failed');
  assert.equal(await fs.readFile(fullPath, 'utf8'), originalBytes);
  assert.equal((await jsonRequest(server.baseUrl, `/api/world/${relativePath}`)).response.status, 404);
  let moderationState = JSON.parse(await fs.readFile(path.join(dataDir, 'moderation.json'), 'utf8'));
  assert.ok(moderationState.gitRepairs?.[relativePath], 'the exact Git repair transaction must be durable');
  assert.deepEqual(moderationState.moderation.quarantinedFiles[relativePath].reasons, ['git_rollback_failed']);
  let gitResult = await execFileAsync('git', ['show', `HEAD:${relativePath}`], { cwd: worldDir });
  assert.equal(gitResult.stdout.trim(), privateBytes);
  await fs.rm(stateArmPath, { force: true });
  await server.crash();

  // Model a process that died immediately after the private Git commit: only the durable armed
  // write-ahead snapshot exists, and the private working bytes were never restored in-process.
  moderationState.gitRepairs[relativePath].status = 'armed';
  moderationState.gitRepairs[relativePath].gitHash = null;
  await fs.writeFile(path.join(dataDir, 'moderation.json'), JSON.stringify(moderationState, null, 2));
  await fs.writeFile(fullPath, privateBytes);

  server = await startIsolatedServer(t, { worldDir, dataDir, backupDir, extraEnv });
  assert.equal((await jsonRequest(server.baseUrl, `/api/world/${relativePath}`)).response.status, 404);
  assert.equal(await fs.readFile(fullPath, 'utf8'), privateBytes);
  moderationState = JSON.parse(await fs.readFile(path.join(dataDir, 'moderation.json'), 'utf8'));
  assert.ok(moderationState.gitRepairs?.[relativePath]);
  assert.ok(moderationState.moderation.quarantinedFiles[relativePath]);
  const rejectedCorrection = await jsonRequest(server.baseUrl, '/api/contribute', {
    method: 'POST', headers: await challengeHeaders(server.baseUrl),
    body: JSON.stringify({
      agent_name: 'BlockedSafeRepairAgent', action: 'edit', file_path: relativePath,
      content: safeBytes, message: 'BLOCKED_SAFE_REPAIR',
    }),
  });
  assert.equal(rejectedCorrection.response.status, 500, server.logs.join(''));
  assert.equal(await fs.readFile(fullPath, 'utf8'), privateBytes);
  assert.equal((await jsonRequest(server.baseUrl, `/api/world/${relativePath}`)).response.status, 404);
  assert.equal((await jsonRequest(server.baseUrl, '/api/timeline')).body
    .some(item => item.message === 'BLOCKED_SAFE_REPAIR'), false);
  moderationState = JSON.parse(await fs.readFile(path.join(dataDir, 'moderation.json'), 'utf8'));
  assert.ok(moderationState.gitRepairs?.[relativePath]);

  await fs.rm(gitArmPath, { force: true });
  const correction = await jsonRequest(server.baseUrl, '/api/contribute', {
    method: 'POST', headers: await challengeHeaders(server.baseUrl),
    body: JSON.stringify({
      agent_name: 'SafeRepairAgent', action: 'edit', file_path: relativePath,
      content: safeBytes, message: 'SAFE_AFTER_GIT_REPAIR',
    }),
  });
  assert.equal(correction.response.status, 200, server.logs.join(''));
  assert.equal(correction.body.publicationStatus, 'published');
  assert.equal(await fs.readFile(fullPath, 'utf8'), safeBytes);
  assert.equal((await jsonRequest(server.baseUrl, `/api/world/${relativePath}`)).response.status, 200);
  const diff = await jsonRequest(server.baseUrl, `/api/contributions/${correction.body.contribution.id}/diff`);
  assert.equal(diff.response.status, 200);
  assert.match(diff.body.diff || '', /Safe after durable Git repair/);
  assert.doesNotMatch(diff.body.diff || '', /PRIVATE_REPAIR_PARENT|PRIVATE_REPAIR_FAILURE/);
  const timeline = (await jsonRequest(server.baseUrl, '/api/timeline')).body;
  assert.equal(timeline.some(item => item.message === 'PRIVATE_REPAIR_FAILURE'), false);
  assert.equal(timeline.some(item => item.message === 'SAFE_AFTER_GIT_REPAIR'), true);
  moderationState = JSON.parse(await fs.readFile(path.join(dataDir, 'moderation.json'), 'utf8'));
  assert.equal(Object.hasOwn(moderationState.gitRepairs || {}, relativePath), false);
  assert.equal(Object.hasOwn(moderationState.moderation.quarantinedFiles, relativePath), false);
  gitResult = await execFileAsync('git', ['show', `HEAD:${relativePath}`], { cwd: worldDir });
  assert.equal(gitResult.stdout.trim(), safeBytes);
  await server.stop();
});

test('a failed repair on path A blocks path B until the global Git parent is sanitized', async (t) => {
  // Mutations caught: a target-only repair barrier lets B commit atop A's private unresolved HEAD.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aibuilds-publication-global-repair-barrier-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const worldDir = path.join(root, 'world');
  const dataDir = path.join(root, 'data');
  const backupDir = path.join(root, 'backups');
  const binDir = path.join(root, 'bin');
  const pathA = 'pages/repair-a.html';
  const pathB = 'pages/repair-b.html';
  const originalA = '<main><h1>Public A baseline</h1></main>';
  const originalB = '<main><h1>Public B baseline</h1></main>';
  const privateA = '<p>Inject 41 mg weekly PRIVATE_PATH_A_PARENT.</p>';
  const safeB = '<main><h1>Safe path B after global repair</h1></main>';
  const compensationArm = path.join(root, 'arm-compensation-failure');
  const wrapperPath = path.join(binDir, 'git');
  const realGit = (await execFileAsync('which', ['git'])).stdout.trim();
  await fs.mkdir(path.join(worldDir, 'pages'), { recursive: true });
  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(binDir, { recursive: true });
  await fs.writeFile(path.join(worldDir, pathA), originalA);
  await fs.writeFile(path.join(worldDir, pathB), originalB);
  await fs.writeFile(path.join(dataDir, 'state.json'), JSON.stringify({ history: [] }));
  await execFileAsync('git', ['init'], { cwd: worldDir });
  await execFileAsync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: worldDir });
  await execFileAsync('git', ['config', 'user.name', 'Publication Test'], { cwd: worldDir });
  await execFileAsync('git', ['add', '.'], { cwd: worldDir });
  await execFileAsync('git', ['commit', '-m', 'global repair baseline'], { cwd: worldDir });
  await fs.writeFile(wrapperPath, `#!/bin/sh
if [ "$1" = "commit-tree" ] && [ -f "$AIBUILDS_GIT_COMPENSATION_FAILURE_ARM" ]; then
  echo "forced global repair compensation failure" >&2
  exit 75
fi
exec "$AIBUILDS_REAL_GIT" "$@"
`);
  await fs.chmod(wrapperPath, 0o755);
  const server = await startIsolatedServer(t, {
    worldDir, dataDir, backupDir,
    extraEnv: {
      PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
      AIBUILDS_REAL_GIT: realGit,
      AIBUILDS_GIT_COMPENSATION_FAILURE_ARM: compensationArm,
    },
  });
  await fs.writeFile(compensationArm, 'armed');

  const failedA = await jsonRequest(server.baseUrl, '/api/contribute', {
    method: 'POST', headers: await challengeHeaders(server.baseUrl),
    body: JSON.stringify({
      agent_name: 'PrivatePathAAgent', action: 'edit', file_path: pathA,
      content: privateA, message: 'PRIVATE_PATH_A_FAILURE',
    }),
  });
  assert.equal(failedA.response.status, 500, server.logs.join(''));
  const privateHead = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: worldDir })).stdout.trim();
  assert.equal((await execFileAsync('git', ['show', `HEAD:${pathA}`], { cwd: worldDir })).stdout.trim(), privateA);
  assert.ok(JSON.parse(await fs.readFile(path.join(dataDir, 'moderation.json'), 'utf8'))
    .gitRepairs?.[pathA]);

  const blockedLegacyModeration = await jsonRequest(server.baseUrl, '/api/admin/moderate', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: 'test-secret', action: 'hide', target: pathB }),
  });
  assert.equal(blockedLegacyModeration.response.status, 500, server.logs.join(''));
  const moderationView = await jsonRequest(server.baseUrl, '/api/admin/moderation', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: 'test-secret' }),
  });
  assert.equal(moderationView.body.hiddenFiles.includes(pathB), false);

  const blockedB = await jsonRequest(server.baseUrl, '/api/contribute', {
    method: 'POST', headers: await challengeHeaders(server.baseUrl),
    body: JSON.stringify({
      agent_name: 'BlockedPathBAgent', action: 'edit', file_path: pathB,
      content: safeB, message: 'BLOCKED_PATH_B_WHILE_A_UNRESOLVED',
    }),
  });
  assert.equal(blockedB.response.status, 500, server.logs.join(''));
  assert.equal((await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: worldDir })).stdout.trim(), privateHead);
  assert.equal(await fs.readFile(path.join(worldDir, pathB), 'utf8'), originalB);
  assert.equal((await jsonRequest(server.baseUrl, '/api/timeline')).body
    .some(item => item.message === 'BLOCKED_PATH_B_WHILE_A_UNRESOLVED'), false);

  await fs.rm(compensationArm, { force: true });
  const publishedB = await jsonRequest(server.baseUrl, '/api/contribute', {
    method: 'POST', headers: await challengeHeaders(server.baseUrl),
    body: JSON.stringify({
      agent_name: 'SafePathBAgent', action: 'edit', file_path: pathB,
      content: safeB, message: 'SAFE_PATH_B_AFTER_GLOBAL_REPAIR',
    }),
  });
  assert.equal(publishedB.response.status, 200, server.logs.join(''));
  assert.equal(publishedB.body.publicationStatus, 'published');
  const diff = await jsonRequest(
    server.baseUrl,
    `/api/contributions/${publishedB.body.contribution.id}/diff`,
  );
  assert.equal(diff.response.status, 200);
  assert.match(diff.body.diff || '', /Safe path B after global repair/);
  assert.doesNotMatch(diff.body.diff || '', /PRIVATE_PATH_A_PARENT|PRIVATE_PATH_A_FAILURE/);
  assert.equal((await execFileAsync('git', ['show', `HEAD:${pathA}`], { cwd: worldDir })).stdout.trim(), originalA);
  assert.equal((await execFileAsync('git', ['show', `HEAD:${pathB}`], { cwd: worldDir })).stdout.trim(), safeB);
  const moderationState = JSON.parse(await fs.readFile(path.join(dataDir, 'moderation.json'), 'utf8'));
  assert.equal(Object.keys(moderationState.gitRepairs || {}).length, 0);
  await server.stop();
});

test('commit success followed by hash-association failure still sanitizes the advanced HEAD', async (t) => {
  // Mutation caught: compensating only when transaction.gitHash is assigned leaves the private commit as HEAD.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aibuilds-publication-unknown-commit-outcome-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const worldDir = path.join(root, 'world');
  const dataDir = path.join(root, 'data');
  const backupDir = path.join(root, 'backups');
  const binDir = path.join(root, 'bin');
  const relativePath = 'pages/unknown-outcome.html';
  const originalBytes = '<main><h1>Known public parent</h1></main>';
  const privateBytes = '<p>Inject 43 mg weekly PRIVATE_UNKNOWN_COMMIT_OUTCOME.</p>';
  const safeBytes = '<main><h1>Safe after unknown commit outcome</h1></main>';
  const logFailureArm = path.join(root, 'arm-log-failure');
  const logFailureObserved = path.join(root, 'log-failure-observed');
  const wrapperPath = path.join(binDir, 'git');
  const realGit = (await execFileAsync('which', ['git'])).stdout.trim();
  await fs.mkdir(path.dirname(path.join(worldDir, relativePath)), { recursive: true });
  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(binDir, { recursive: true });
  await fs.writeFile(path.join(worldDir, relativePath), originalBytes);
  await fs.writeFile(path.join(dataDir, 'state.json'), JSON.stringify({ history: [] }));
  await execFileAsync('git', ['init'], { cwd: worldDir });
  await execFileAsync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: worldDir });
  await execFileAsync('git', ['config', 'user.name', 'Publication Test'], { cwd: worldDir });
  await execFileAsync('git', ['add', '.'], { cwd: worldDir });
  await execFileAsync('git', ['commit', '-m', 'unknown outcome baseline'], { cwd: worldDir });
  const baselineHead = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: worldDir })).stdout.trim();
  await fs.writeFile(wrapperPath, `#!/bin/sh
if [ "$1" = "log" ] && [ -f "$AIBUILDS_GIT_LOG_FAILURE_ARM" ] && [ ! -f "$AIBUILDS_GIT_LOG_FAILURE_OBSERVED" ]; then
  : > "$AIBUILDS_GIT_LOG_FAILURE_OBSERVED"
  echo "forced post-commit log/hash association failure" >&2
  exit 76
fi
exec "$AIBUILDS_REAL_GIT" "$@"
`);
  await fs.chmod(wrapperPath, 0o755);
  const server = await startIsolatedServer(t, {
    worldDir, dataDir, backupDir,
    extraEnv: {
      PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
      AIBUILDS_REAL_GIT: realGit,
      AIBUILDS_GIT_LOG_FAILURE_ARM: logFailureArm,
      AIBUILDS_GIT_LOG_FAILURE_OBSERVED: logFailureObserved,
    },
  });
  await fs.writeFile(logFailureArm, 'armed');

  const failed = await jsonRequest(server.baseUrl, '/api/contribute', {
    method: 'POST', headers: await challengeHeaders(server.baseUrl),
    body: JSON.stringify({
      agent_name: 'UnknownOutcomeAgent', action: 'edit', file_path: relativePath,
      content: privateBytes, message: 'PRIVATE_UNKNOWN_OUTCOME_FAILURE',
    }),
  });
  assert.equal(failed.response.status, 500, server.logs.join(''));
  assert.equal(await fs.readFile(logFailureObserved, 'utf8'), '');
  const sanitizedHead = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: worldDir })).stdout.trim();
  assert.notEqual(sanitizedHead, baselineHead, 'the successful commit outcome must be detected and compensated');
  assert.equal(
    (await execFileAsync('git', ['show', `HEAD:${relativePath}`], { cwd: worldDir })).stdout.trim(),
    originalBytes,
  );
  assert.match(
    (await execFileAsync('git', ['log', '-1', '--pretty=%s'], { cwd: worldDir })).stdout.trim(),
    /^rollback: unfinished pages\/unknown-outcome\.html$/,
  );
  assert.equal(await fs.readFile(path.join(worldDir, relativePath), 'utf8'), originalBytes);
  let moderationState = JSON.parse(await fs.readFile(path.join(dataDir, 'moderation.json'), 'utf8'));
  assert.equal(Object.keys(moderationState.gitRepairs || {}).length, 0);

  const safe = await jsonRequest(server.baseUrl, '/api/contribute', {
    method: 'POST', headers: await challengeHeaders(server.baseUrl),
    body: JSON.stringify({
      agent_name: 'SafeUnknownOutcomeAgent', action: 'edit', file_path: relativePath,
      content: safeBytes, message: 'SAFE_AFTER_UNKNOWN_OUTCOME',
    }),
  });
  assert.equal(safe.response.status, 200, server.logs.join(''));
  const diff = await jsonRequest(server.baseUrl, `/api/contributions/${safe.body.contribution.id}/diff`);
  assert.equal(diff.response.status, 200);
  assert.match(diff.body.diff || '', /Safe after unknown commit outcome/);
  assert.doesNotMatch(diff.body.diff || '', /PRIVATE_UNKNOWN_COMMIT_OUTCOME|PRIVATE_UNKNOWN_OUTCOME_FAILURE/);
  moderationState = JSON.parse(await fs.readFile(path.join(dataDir, 'moderation.json'), 'utf8'));
  assert.equal(Object.keys(moderationState.gitRepairs || {}).length, 0);
  await server.stop();
});

test('failed WAL-clear persistence keeps the global barrier armed before path B can commit', async (t) => {
  // Mutation caught: clearing only the in-memory marker before its save lets B bypass durable WAL A.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aibuilds-publication-durable-clear-barrier-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const worldDir = path.join(root, 'world');
  const dataDir = path.join(root, 'data');
  const backupDir = path.join(root, 'backups');
  const binDir = path.join(root, 'bin');
  const pathA = 'pages/durable-clear-a.html';
  const pathB = 'pages/durable-clear-b.html';
  const originalA = '<main><h1>Durable clear A baseline</h1></main>';
  const originalB = '<main><h1>Durable clear B baseline</h1></main>';
  const privateA = '<main><h1>PRIVATE_DURABLE_CLEAR_A</h1></main>';
  const safeB = '<main><h1>Safe B after durable clear repair</h1></main>';
  const persistenceArm = path.join(root, 'arm-empty-repair-save-failure');
  const clearFailureObserved = path.join(root, 'empty-repair-save-failure-observed');
  const logFailureObserved = path.join(root, 'log-failure-observed');
  const bCommitObserved = path.join(root, 'path-b-commit-observed');
  const preloadPath = path.join(root, 'fail-empty-repair-save.cjs');
  const wrapperPath = path.join(binDir, 'git');
  const realGit = (await execFileAsync('which', ['git'])).stdout.trim();
  await fs.mkdir(path.join(worldDir, 'pages'), { recursive: true });
  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(binDir, { recursive: true });
  await fs.writeFile(path.join(worldDir, pathA), originalA);
  await fs.writeFile(path.join(worldDir, pathB), originalB);
  await fs.writeFile(path.join(dataDir, 'state.json'), JSON.stringify({ history: [] }));
  await execFileAsync('git', ['init'], { cwd: worldDir });
  await execFileAsync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: worldDir });
  await execFileAsync('git', ['config', 'user.name', 'Publication Test'], { cwd: worldDir });
  await execFileAsync('git', ['add', '.'], { cwd: worldDir });
  await execFileAsync('git', ['commit', '-m', 'durable clear baseline'], { cwd: worldDir });
  await fs.writeFile(preloadPath, `
    const fs = require('node:fs');
    const promises = fs.promises;
    const originalRename = promises.rename.bind(promises);
    promises.rename = async function failEmptyRepairSave(source, target) {
      if (fs.existsSync(process.env.AIBUILDS_CLEAR_PERSISTENCE_ARM) &&
          !fs.existsSync(process.env.AIBUILDS_PATH_B_COMMIT_OBSERVED) &&
          String(target) === process.env.AIBUILDS_MODERATION_TARGET) {
        const snapshot = JSON.parse(fs.readFileSync(source, 'utf8'));
        const repairs = snapshot.gitRepairs || {};
        if (!Object.hasOwn(repairs, process.env.AIBUILDS_REPAIR_PATH_A) &&
            Object.keys(repairs).length === 0) {
          fs.writeFileSync(process.env.AIBUILDS_CLEAR_FAILURE_OBSERVED, 'failed');
          throw Object.assign(new Error('forced empty repair-registry save failure'), { code: 'EIO' });
        }
      }
      return originalRename(source, target);
    };
  `);
  await fs.writeFile(wrapperPath, `#!/bin/sh
if [ "$1" = "log" ] && [ ! -f "$AIBUILDS_GIT_LOG_FAILURE_OBSERVED" ]; then
  : > "$AIBUILDS_GIT_LOG_FAILURE_OBSERVED"
  echo "forced post-commit log association failure" >&2
  exit 76
fi
if [ "$1" = "commit" ]; then
  case "$*" in
    *"$AIBUILDS_REPAIR_PATH_B"*) : > "$AIBUILDS_PATH_B_COMMIT_OBSERVED" ;;
  esac
fi
exec "$AIBUILDS_REAL_GIT" "$@"
`);
  await fs.chmod(wrapperPath, 0o755);
  const server = await startIsolatedServer(t, {
    worldDir, dataDir, backupDir,
    extraEnv: {
      NODE_OPTIONS: `--require=${preloadPath}`,
      PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
      AIBUILDS_REAL_GIT: realGit,
      AIBUILDS_MODERATION_TARGET: path.join(dataDir, 'moderation.json'),
      AIBUILDS_CLEAR_PERSISTENCE_ARM: persistenceArm,
      AIBUILDS_CLEAR_FAILURE_OBSERVED: clearFailureObserved,
      AIBUILDS_GIT_LOG_FAILURE_OBSERVED: logFailureObserved,
      AIBUILDS_REPAIR_PATH_A: pathA,
      AIBUILDS_REPAIR_PATH_B: pathB,
      AIBUILDS_PATH_B_COMMIT_OBSERVED: bCommitObserved,
    },
  });
  await fs.writeFile(persistenceArm, 'armed');

  const failedA = await jsonRequest(server.baseUrl, '/api/contribute', {
    method: 'POST', headers: await challengeHeaders(server.baseUrl),
    body: JSON.stringify({
      agent_name: 'DurableClearAAgent', action: 'edit', file_path: pathA,
      content: privateA, message: 'PRIVATE_DURABLE_CLEAR_FAILURE',
    }),
  });
  assert.equal(failedA.response.status, 500, server.logs.join(''));
  assert.equal(await fs.readFile(clearFailureObserved, 'utf8'), 'failed');
  const sanitizedHead = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: worldDir })).stdout.trim();
  assert.equal((await execFileAsync('git', ['show', `HEAD:${pathA}`], { cwd: worldDir })).stdout.trim(), originalA);
  assert.ok(JSON.parse(await fs.readFile(path.join(dataDir, 'moderation.json'), 'utf8')).gitRepairs?.[pathA]);

  const blockedB = await jsonRequest(server.baseUrl, '/api/contribute', {
    method: 'POST', headers: await challengeHeaders(server.baseUrl),
    body: JSON.stringify({
      agent_name: 'BlockedDurableClearBAgent', action: 'edit', file_path: pathB,
      content: safeB, message: 'BLOCKED_BY_DURABLE_CLEAR_A',
    }),
  });
  assert.equal(blockedB.response.status, 500, server.logs.join(''));
  assert.equal((await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: worldDir })).stdout.trim(), sanitizedHead);
  assert.equal(await fs.readFile(path.join(worldDir, pathB), 'utf8'), originalB);
  await assert.rejects(fs.access(bCommitObserved), error => error.code === 'ENOENT');

  await fs.rm(persistenceArm, { force: true });
  const publishedB = await jsonRequest(server.baseUrl, '/api/contribute', {
    method: 'POST', headers: await challengeHeaders(server.baseUrl),
    body: JSON.stringify({
      agent_name: 'SafeDurableClearBAgent', action: 'edit', file_path: pathB,
      content: safeB, message: 'SAFE_AFTER_DURABLE_CLEAR_REPAIR',
    }),
  });
  assert.equal(publishedB.response.status, 200, server.logs.join(''));
  const diff = await jsonRequest(
    server.baseUrl,
    `/api/contributions/${publishedB.body.contribution.id}/diff`,
  );
  assert.equal(diff.response.status, 200);
  assert.match(diff.body.diff || '', /Safe B after durable clear repair/);
  assert.doesNotMatch(diff.body.diff || '', /PRIVATE_DURABLE_CLEAR_A|PRIVATE_DURABLE_CLEAR_FAILURE/);
  assert.equal((await execFileAsync('git', ['show', `HEAD:${pathA}`], { cwd: worldDir })).stdout.trim(), originalA);
  assert.equal(Object.keys(JSON.parse(
    await fs.readFile(path.join(dataDir, 'moderation.json'), 'utf8'),
  ).gitRepairs || {}).length, 0);
  await server.stop();
});

test('WAL integrity hashes the exact non-UTF-8 working-file preimage bytes', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aibuilds-publication-raw-wal-hash-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const worldDir = path.join(root, 'world');
  const dataDir = path.join(root, 'data');
  const backupDir = path.join(root, 'backups');
  const relativePath = 'misc/raw-preimage.txt';
  const replacement = 'safe text after a raw byte preimage\n';
  await fs.mkdir(path.dirname(path.join(worldDir, relativePath)), { recursive: true });
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(path.join(worldDir, relativePath), Buffer.from([0xff, 0x00, 0x61, 0x0a]));
  await fs.writeFile(path.join(dataDir, 'state.json'), JSON.stringify({ history: [] }));
  await execFileAsync('git', ['init'], { cwd: worldDir });
  await execFileAsync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: worldDir });
  await execFileAsync('git', ['config', 'user.name', 'Publication Test'], { cwd: worldDir });
  await execFileAsync('git', ['add', '.'], { cwd: worldDir });
  await execFileAsync('git', ['commit', '-m', 'raw byte preimage baseline'], { cwd: worldDir });
  const server = await startIsolatedServer(t, { worldDir, dataDir, backupDir });

  const result = await jsonRequest(server.baseUrl, '/api/contribute', {
    method: 'POST', headers: await challengeHeaders(server.baseUrl),
    body: JSON.stringify({
      agent_name: 'RawPreimageAgent', action: 'edit', file_path: relativePath,
      content: replacement, message: 'replace non-UTF-8 preimage safely',
    }),
  });
  assert.equal(result.response.status, 200, server.logs.join(''));
  assert.equal(await fs.readFile(path.join(worldDir, relativePath), 'utf8'), replacement);
  assert.equal(Object.keys(JSON.parse(
    await fs.readFile(path.join(dataDir, 'moderation.json'), 'utf8'),
  ).gitRepairs || {}).length, 0);
  await server.stop();
});

test('unfinished correction restores its exact pretransaction moderation boundary on restart', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aibuilds-publication-repair-moderation-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const worldDir = path.join(root, 'world');
  const dataDir = path.join(root, 'data');
  const backupDir = path.join(root, 'backups');
  const binDir = path.join(root, 'bin');
  const relativePath = 'misc/private.html';
  const fullPath = path.join(worldDir, relativePath);
  const riskyBytes = '<p>Inject 31 mg weekly PRIVATE_PRETRANSACTION_BOUNDARY.</p>';
  const safeBytes = '<main><h1>Interrupted safe correction</h1></main>';
  const armPath = path.join(root, 'arm-git-commit-failure');
  const walSnapshotPath = path.join(root, 'armed-moderation.json');
  const wrapperPath = path.join(binDir, 'git');
  const realGit = (await execFileAsync('which', ['git'])).stdout.trim();
  const quarantine = {
    filePath: relativePath,
    contentHash: contentHash(riskyBytes),
    reasons: ['high_stakes_medical'],
    agentName: 'BoundaryBaseline',
    timestamp: '2026-08-10T10:00:00.000Z',
  };
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(binDir, { recursive: true });
  await fs.writeFile(fullPath, riskyBytes);
  await fs.writeFile(path.join(dataDir, 'state.json'), JSON.stringify({ history: [] }));
  await fs.writeFile(path.join(dataDir, 'moderation.json'), JSON.stringify({
    moderation: {
      hiddenFiles: [], bannedAgents: [], bannedIps: [],
      quarantinedFiles: { [relativePath]: quarantine }, approvedFiles: {},
    },
    agentIps: {}, gitRepairs: {},
  }));
  await execFileAsync('git', ['init'], { cwd: worldDir });
  await execFileAsync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: worldDir });
  await execFileAsync('git', ['config', 'user.name', 'Publication Test'], { cwd: worldDir });
  await execFileAsync('git', ['add', '.'], { cwd: worldDir });
  await execFileAsync('git', ['commit', '-m', 'private quarantined baseline'], { cwd: worldDir });
  await fs.writeFile(wrapperPath, `#!/bin/sh
if [ "$1" = "commit" ] && [ -f "$AIBUILDS_GIT_COMMIT_FAILURE_ARM" ]; then
  /bin/cp "$AIBUILDS_MODERATION_TARGET" "$AIBUILDS_WAL_SNAPSHOT"
  echo "forced Git commit failure after WAL snapshot" >&2
  exit 74
fi
exec "$AIBUILDS_REAL_GIT" "$@"
`);
  await fs.chmod(wrapperPath, 0o755);
  const extraEnv = {
    PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
    AIBUILDS_REAL_GIT: realGit,
    AIBUILDS_GIT_COMMIT_FAILURE_ARM: armPath,
    AIBUILDS_MODERATION_TARGET: path.join(dataDir, 'moderation.json'),
    AIBUILDS_WAL_SNAPSHOT: walSnapshotPath,
  };
  let server = await startIsolatedServer(t, { worldDir, dataDir, backupDir, extraEnv });
  assert.equal((await jsonRequest(server.baseUrl, `/api/world/${relativePath}`)).response.status, 404);
  await fs.writeFile(armPath, 'armed');
  const failed = await jsonRequest(server.baseUrl, '/api/contribute', {
    method: 'POST', headers: await challengeHeaders(server.baseUrl),
    body: JSON.stringify({
      agent_name: 'InterruptedBoundaryAgent', action: 'edit', file_path: relativePath,
      content: safeBytes, message: 'INTERRUPTED_BOUNDARY_CORRECTION',
    }),
  });
  assert.equal(failed.response.status, 500, server.logs.join(''));
  const armedState = JSON.parse(await fs.readFile(walSnapshotPath, 'utf8'));
  assert.deepEqual(
    armedState.gitRepairs?.[relativePath]?.publicationState?.quarantine,
    quarantine,
  );
  await server.crash();

  // Recreate the exact crash image from immediately before Git commit: the safe working bytes and
  // post-correction moderation file exist, but the durable WAL retains the old quarantine boundary.
  await fs.rm(armPath, { force: true });
  await fs.writeFile(fullPath, safeBytes);
  await fs.writeFile(path.join(dataDir, 'moderation.json'), JSON.stringify(armedState, null, 2));
  server = await startIsolatedServer(t, { worldDir, dataDir, backupDir, extraEnv });
  assert.equal((await jsonRequest(server.baseUrl, `/api/world/${relativePath}`)).response.status, 404);
  assert.equal(await fs.readFile(fullPath, 'utf8'), riskyBytes);
  const restoredModeration = JSON.parse(
    await fs.readFile(path.join(dataDir, 'moderation.json'), 'utf8'),
  );
  assert.deepEqual(restoredModeration.moderation.quarantinedFiles[relativePath], quarantine);
  assert.equal(Object.hasOwn(restoredModeration.gitRepairs || {}, relativePath), false);
  await server.stop();
});

test('failed repair-preimage persistence cannot discard the exact moderation rollback state', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aibuilds-publication-preimage-save-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const worldDir = path.join(root, 'world');
  const dataDir = path.join(root, 'data');
  const backupDir = path.join(root, 'backups');
  const relativePath = 'pages/preimage-save.html';
  const fullPath = path.join(worldDir, relativePath);
  const safeBytes = '<main><h1>Exact public preimage</h1></main>';
  const riskyBytes = '<p>Inject 37 mg weekly PRIVATE_PREIMAGE_SAVE.</p>';
  const failureArmPath = path.join(root, 'arm-preimage-save-failure');
  const failureObservedPath = path.join(root, 'preimage-save-failure-observed');
  const preloadPath = path.join(root, 'fail-preimage-save.cjs');
  const removedIpAgent = 'RemovedPreimageIp';
  const removedIp = '203.0.113.88';
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(fullPath, safeBytes);
  await fs.writeFile(path.join(dataDir, 'state.json'), JSON.stringify({ history: [] }));
  await execFileAsync('git', ['init'], { cwd: worldDir });
  await execFileAsync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: worldDir });
  await execFileAsync('git', ['config', 'user.name', 'Publication Test'], { cwd: worldDir });
  await execFileAsync('git', ['add', '.'], { cwd: worldDir });
  await execFileAsync('git', ['commit', '-m', 'exact public preimage'], { cwd: worldDir });
  const { stdout: originalHeadOutput } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: worldDir });
  const originalHead = originalHeadOutput.trim();
  const { stdout: treeOutput } = await execFileAsync(
    'git', ['ls-tree', originalHead, '--', relativePath], { cwd: worldDir },
  );
  const treeMatch = treeOutput.trim().match(/^(\d+)\s+blob\s+([0-9a-f]+)\t/);
  assert.ok(treeMatch);
  await fs.writeFile(fullPath, riskyBytes);
  await execFileAsync('git', ['add', '--', relativePath], { cwd: worldDir });
  await execFileAsync('git', ['commit', '-m', 'interrupted private commit'], { cwd: worldDir });
  const riskyQuarantine = {
    filePath: relativePath,
    contentHash: contentHash(riskyBytes),
    reasons: ['high_stakes_medical'],
    agentName: 'InterruptedPrivateAgent',
    timestamp: '2026-08-10T10:00:00.000Z',
  };
  const repairRecord = {
    filePath: relativePath,
    gitHash: null,
    status: 'armed',
    contributionId: 'missing-preimage-transaction',
    expectedGitSubject: `[InterruptedPrivateAgent] edit: ${relativePath}`,
    publicationState: { quarantine: null, approval: null },
    agentIps: [[removedIpAgent, removedIp]],
    fileState: {
      existed: true,
      bytesBase64: Buffer.from(safeBytes).toString('base64'),
      sha256: contentHash(safeBytes),
    },
    gitPathState: {
      head: originalHead,
      treeEntry: { mode: treeMatch[1], hash: treeMatch[2] },
      indexState: {
        entries: [{ mode: treeMatch[1], hash: treeMatch[2], stage: 0 }],
        assumeUnchanged: false,
        skipWorktree: false,
      },
    },
  };
  await fs.writeFile(path.join(dataDir, 'moderation.json'), JSON.stringify({
    moderation: {
      hiddenFiles: [], bannedAgents: [removedIpAgent], bannedIps: [],
      quarantinedFiles: { [relativePath]: riskyQuarantine }, approvedFiles: {},
    },
    agentIps: { [removedIpAgent]: removedIp }, gitRepairs: { [relativePath]: repairRecord },
  }));
  await fs.writeFile(preloadPath, `
    const fs = require('node:fs');
    const promises = fs.promises;
    const originalRename = promises.rename.bind(promises);
    let failed = false;
    promises.rename = async function failConsumedPreimage(source, target) {
      if (!failed && fs.existsSync(process.env.AIBUILDS_PREIMAGE_FAILURE_ARM) &&
          String(target) === process.env.AIBUILDS_MODERATION_TARGET) {
        const snapshot = JSON.parse(fs.readFileSync(source, 'utf8'));
        const repair = snapshot.gitRepairs?.[process.env.AIBUILDS_REPAIR_PATH];
        if (repair && repair.publicationState === null && repair.agentIps === null) {
          failed = true;
          fs.writeFileSync(process.env.AIBUILDS_PREIMAGE_FAILURE_OBSERVED, 'failed');
          throw Object.assign(new Error('forced repair preimage persistence failure'), { code: 'EIO' });
        }
      }
      return originalRename(source, target);
    };
  `);
  await fs.writeFile(failureArmPath, 'armed');
  const server = await startIsolatedServer(t, {
    worldDir, dataDir, backupDir,
    extraEnv: {
      NODE_OPTIONS: `--require=${preloadPath}`,
      AIBUILDS_PREIMAGE_FAILURE_ARM: failureArmPath,
      AIBUILDS_PREIMAGE_FAILURE_OBSERVED: failureObservedPath,
      AIBUILDS_MODERATION_TARGET: path.join(dataDir, 'moderation.json'),
      AIBUILDS_REPAIR_PATH: relativePath,
    },
  });
  assert.equal(await fs.readFile(failureObservedPath, 'utf8'), 'failed');
  const unrelatedSave = await jsonRequest(server.baseUrl, '/api/admin/ban', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: 'test-secret', action: 'unban', agent_name: removedIpAgent }),
  });
  assert.equal(unrelatedSave.response.status, 200, server.logs.join(''));
  const persistedRepair = JSON.parse(
    await fs.readFile(path.join(dataDir, 'moderation.json'), 'utf8'),
  ).gitRepairs[relativePath];
  assert.deepEqual(persistedRepair.publicationState, { quarantine: null, approval: null });
  assert.equal(persistedRepair.agentIps, null);

  const reject = await jsonRequest(server.baseUrl, '/api/admin/quarantine/reject', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Admin-Secret': 'test-secret' },
    body: JSON.stringify({ path: relativePath }),
  });
  assert.equal(reject.response.status, 404, server.logs.join(''));
  assert.equal(await fs.readFile(fullPath, 'utf8'), safeBytes);
  const publicFile = await jsonRequest(server.baseUrl, `/api/world/${relativePath}`);
  assert.equal(publicFile.response.status, 200);
  assert.equal(publicFile.body.content, safeBytes);
  const finalModeration = JSON.parse(await fs.readFile(path.join(dataDir, 'moderation.json'), 'utf8'));
  assert.equal(Object.hasOwn(finalModeration.agentIps, removedIpAgent), false);
  await server.stop();
});

test('restart finalizes a contribution durable before its WAL clear', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aibuilds-publication-finalize-wal-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const worldDir = path.join(root, 'world');
  const dataDir = path.join(root, 'data');
  const backupDir = path.join(root, 'backups');
  const relativePath = 'pages/finalize-wal.html';
  const fullPath = path.join(worldDir, relativePath);
  const originalBytes = '<main><h1>Finalize baseline</h1></main>';
  const safeBytes = '<main><h1>Durable before WAL clear</h1></main>';
  const armPath = path.join(root, 'arm-clear-crash');
  const observedPath = path.join(root, 'clear-crash-observed');
  const preloadPath = path.join(root, 'crash-before-wal-clear.cjs');
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(fullPath, originalBytes);
  await fs.writeFile(path.join(dataDir, 'state.json'), JSON.stringify({ history: [] }));
  await execFileAsync('git', ['init'], { cwd: worldDir });
  await execFileAsync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: worldDir });
  await execFileAsync('git', ['config', 'user.name', 'Publication Test'], { cwd: worldDir });
  await execFileAsync('git', ['add', '.'], { cwd: worldDir });
  await execFileAsync('git', ['commit', '-m', 'finalize WAL baseline'], { cwd: worldDir });
  await fs.writeFile(preloadPath, `
    const fs = require('node:fs');
    const promises = fs.promises;
    const originalRename = promises.rename.bind(promises);
    promises.rename = async function crashBeforeWalClear(source, target) {
      if (fs.existsSync(process.env.AIBUILDS_CLEAR_CRASH_ARM) &&
          String(target) === process.env.AIBUILDS_MODERATION_TARGET) {
        const snapshot = JSON.parse(fs.readFileSync(source, 'utf8'));
        if (!snapshot.gitRepairs?.[process.env.AIBUILDS_REPAIR_PATH]) {
          fs.writeFileSync(process.env.AIBUILDS_CLEAR_CRASH_OBSERVED, 'crashed');
          process.kill(process.pid, 'SIGKILL');
          await new Promise(() => {});
        }
      }
      return originalRename(source, target);
    };
  `);
  const extraEnv = {
    NODE_OPTIONS: `--require=${preloadPath}`,
    AIBUILDS_CLEAR_CRASH_ARM: armPath,
    AIBUILDS_CLEAR_CRASH_OBSERVED: observedPath,
    AIBUILDS_MODERATION_TARGET: path.join(dataDir, 'moderation.json'),
    AIBUILDS_REPAIR_PATH: relativePath,
  };
  let server = await startIsolatedServer(t, { worldDir, dataDir, backupDir, extraEnv });
  await fs.writeFile(armPath, 'armed');
  await assert.rejects(jsonRequest(server.baseUrl, '/api/contribute', {
    method: 'POST', headers: await challengeHeaders(server.baseUrl),
    body: JSON.stringify({
      agent_name: 'FinalizeWalAgent', action: 'edit', file_path: relativePath,
      content: safeBytes, message: 'CRASH_AFTER_STATE_BEFORE_WAL_CLEAR',
    }),
  }));
  assert.equal(await fs.readFile(observedPath, 'utf8'), 'crashed');
  const persistedBeforeRestart = JSON.parse(await fs.readFile(path.join(dataDir, 'state.json'), 'utf8'));
  const durableRecord = persistedBeforeRestart.history.find(
    item => item.message === 'CRASH_AFTER_STATE_BEFORE_WAL_CLEAR',
  );
  assert.ok(durableRecord);
  const armedState = JSON.parse(await fs.readFile(path.join(dataDir, 'moderation.json'), 'utf8'));
  assert.equal(armedState.gitRepairs?.[relativePath]?.contributionId, durableRecord.id);
  await fs.rm(armPath, { force: true });

  server = await startIsolatedServer(t, { worldDir, dataDir, backupDir, extraEnv });
  const publicFile = await jsonRequest(server.baseUrl, `/api/world/${relativePath}`);
  assert.equal(publicFile.response.status, 200, server.logs.join(''));
  assert.equal(publicFile.body.content, safeBytes);
  const timeline = (await jsonRequest(server.baseUrl, '/api/timeline')).body;
  assert.equal(
    timeline.some(item => item.message === 'CRASH_AFTER_STATE_BEFORE_WAL_CLEAR'),
    true,
  );
  const diff = await jsonRequest(server.baseUrl, `/api/contributions/${durableRecord.id}/diff`);
  assert.equal(diff.response.status, 200);
  assert.match(diff.body.diff || '', /Durable before WAL clear/);
  const restoredModeration = JSON.parse(
    await fs.readFile(path.join(dataDir, 'moderation.json'), 'utf8'),
  );
  assert.equal(Object.hasOwn(restoredModeration.gitRepairs || {}, relativePath), false);
  assert.equal(Object.hasOwn(restoredModeration.agentIps || {}, 'FinalizeWalAgent'), true);
  const gitResult = await execFileAsync('git', ['show', `HEAD:${relativePath}`], { cwd: worldDir });
  assert.equal(gitResult.stdout.trim(), safeBytes);
  await server.stop();
});

test('failed contribution restores an unrelated IP evicted at capacity durably', async (t) => {
  // Mutation caught: restoring only the submitter IP cannot reverse recordAgentIp's capacity eviction.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aibuilds-publication-ip-rollback-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const worldDir = path.join(root, 'world');
  const dataDir = path.join(root, 'data');
  const backupDir = path.join(root, 'backups');
  const relativePath = 'pages/ip-rollback.html';
  const originalBytes = '<main><h1>IP rollback baseline</h1></main>';
  const armPath = path.join(root, 'arm-state-failure');
  const preloadPath = path.join(root, 'fail-first-state-rename.cjs');
  await fs.mkdir(path.join(worldDir, 'pages'), { recursive: true });
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(path.join(worldDir, relativePath), originalBytes);
  await fs.writeFile(path.join(dataDir, 'state.json'), JSON.stringify({
    history: [{
      id: 'ip-baseline-record', timestamp: '2026-08-10T10:00:00.000Z', agent_name: 'BaselineAgent',
      action: 'create', file_path: relativePath, message: 'ip baseline',
      publicationStatus: 'published', reactions: { fire: [], heart: [], rocket: [], eyes: [] },
    }],
  }));
  const agentIps = { OldestAgent: '198.51.100.1' };
  for (let i = 1; i < 5000; i++) agentIps[`CapacityAgent${i}`] = `198.51.${Math.floor(i / 250)}.${i % 250}`;
  await fs.writeFile(path.join(dataDir, 'moderation.json'), JSON.stringify({
    moderation: {
      hiddenFiles: [], bannedAgents: [], bannedIps: [], quarantinedFiles: {}, approvedFiles: {},
    },
    agentIps,
  }));
  await fs.writeFile(preloadPath, `
    const fs = require('node:fs');
    const promises = fs.promises;
    const originalRename = promises.rename.bind(promises);
    let failed = false;
    promises.rename = async function failFirstStateRename(source, target) {
      if (!failed && fs.existsSync(process.env.AIBUILDS_FAILURE_ARM) &&
          String(target) === process.env.AIBUILDS_STATE_TARGET) {
        failed = true;
        throw Object.assign(new Error('forced state persistence failure'), { code: 'EIO' });
      }
      return originalRename(source, target);
    };
  `);
  const extraEnv = {
    NODE_OPTIONS: `--require=${preloadPath}`,
    AIBUILDS_FAILURE_ARM: armPath,
    AIBUILDS_STATE_TARGET: path.join(dataDir, 'state.json'),
  };
  let server = await startIsolatedServer(t, { worldDir, dataDir, backupDir, extraEnv });
  await fs.writeFile(armPath, 'armed');
  const result = await jsonRequest(server.baseUrl, '/api/contribute', {
    method: 'POST', headers: await challengeHeaders(server.baseUrl),
    body: JSON.stringify({
      agent_name: 'EvictingAgent', action: 'edit', file_path: relativePath,
      content: '<main><h1>Failed IP mutation</h1></main>', message: 'force IP rollback',
    }),
  });
  assert.equal(result.response.status, 500, server.logs.join(''));
  let persisted = JSON.parse(await fs.readFile(path.join(dataDir, 'moderation.json'), 'utf8'));
  assert.equal(Object.keys(persisted.agentIps).length, 5000);
  assert.equal(persisted.agentIps.OldestAgent, '198.51.100.1');
  assert.equal(Object.hasOwn(persisted.agentIps, 'EvictingAgent'), false);
  await fs.rm(armPath, { force: true });
  await server.crash();

  server = await startIsolatedServer(t, { worldDir, dataDir, backupDir, extraEnv });
  persisted = JSON.parse(await fs.readFile(path.join(dataDir, 'moderation.json'), 'utf8'));
  assert.equal(Object.keys(persisted.agentIps).length, 5000);
  assert.equal(persisted.agentIps.OldestAgent, '198.51.100.1');
  assert.equal(Object.hasOwn(persisted.agentIps, 'EvictingAgent'), false);
  await server.stop();
});

test('contribution rollback cannot resurrect an IP removed by a concurrent unban', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aibuilds-publication-unban-rollback-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const worldDir = path.join(root, 'world');
  const dataDir = path.join(root, 'data');
  const backupDir = path.join(root, 'backups');
  const relativePath = 'pages/concurrent-unban.html';
  const fullPath = path.join(worldDir, relativePath);
  const armPath = path.join(root, 'arm-state-delay');
  const reachedPath = path.join(root, 'state-delay-reached');
  const releasePath = path.join(root, 'release-state-delay');
  const preloadPath = path.join(root, 'delay-state-failure.cjs');
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(fullPath, '<main><h1>Concurrent unban baseline</h1></main>');
  await fs.writeFile(path.join(dataDir, 'state.json'), JSON.stringify({ history: [] }));
  await fs.writeFile(path.join(dataDir, 'moderation.json'), JSON.stringify({
    moderation: {
      hiddenFiles: [], bannedAgents: ['RemovedIpAgent'], bannedIps: [],
      quarantinedFiles: {}, approvedFiles: {},
    },
    agentIps: { RemovedIpAgent: '203.0.113.77' }, gitRepairs: {},
  }));
  await execFileAsync('git', ['init'], { cwd: worldDir });
  await execFileAsync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: worldDir });
  await execFileAsync('git', ['config', 'user.name', 'Publication Test'], { cwd: worldDir });
  await execFileAsync('git', ['add', '.'], { cwd: worldDir });
  await execFileAsync('git', ['commit', '-m', 'concurrent unban baseline'], { cwd: worldDir });
  await fs.writeFile(preloadPath, `
    const fs = require('node:fs');
    const promises = fs.promises;
    const originalRename = promises.rename.bind(promises);
    let delayed = false;
    promises.rename = async function delayStateFailure(source, target) {
      if (!delayed && fs.existsSync(process.env.AIBUILDS_UNBAN_DELAY_ARM) &&
          String(target) === process.env.AIBUILDS_STATE_TARGET) {
        delayed = true;
        await promises.writeFile(process.env.AIBUILDS_UNBAN_DELAY_REACHED, 'reached');
        while (!fs.existsSync(process.env.AIBUILDS_UNBAN_DELAY_RELEASE)) {
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        throw Object.assign(new Error('forced delayed state failure'), { code: 'EIO' });
      }
      return originalRename(source, target);
    };
  `);
  const extraEnv = {
    NODE_OPTIONS: `--require=${preloadPath}`,
    AIBUILDS_UNBAN_DELAY_ARM: armPath,
    AIBUILDS_UNBAN_DELAY_REACHED: reachedPath,
    AIBUILDS_UNBAN_DELAY_RELEASE: releasePath,
    AIBUILDS_STATE_TARGET: path.join(dataDir, 'state.json'),
  };
  const server = await startIsolatedServer(t, { worldDir, dataDir, backupDir, extraEnv });
  await fs.writeFile(armPath, 'armed');
  const pendingContribution = jsonRequest(server.baseUrl, '/api/contribute', {
    method: 'POST', headers: await challengeHeaders(server.baseUrl),
    body: JSON.stringify({
      agent_name: 'RollbackSubmitter', action: 'edit', file_path: relativePath,
      content: '<main><h1>Contribution that will roll back</h1></main>',
      message: 'ROLLBACK_DURING_UNBAN',
    }),
  });
  await waitFor(async () => {
    try { await fs.access(reachedPath); return true; } catch { return false; }
  });
  let unbanSettled = false;
  const pendingUnban = jsonRequest(server.baseUrl, '/api/admin/ban', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      secret: 'test-secret', action: 'unban', agent_name: 'RemovedIpAgent',
    }),
  }).then(result => { unbanSettled = true; return result; });
  await Promise.race([
    pendingUnban.then(() => {}),
    new Promise(resolve => setTimeout(resolve, 250)),
  ]);
  const unbanSettledBeforeRollback = unbanSettled;
  await fs.writeFile(releasePath, 'released');
  const [failedContribution, unban] = await Promise.all([pendingContribution, pendingUnban]);
  assert.equal(failedContribution.response.status, 500, server.logs.join(''));
  assert.equal(unban.response.status, 200, server.logs.join(''));
  assert.equal(unbanSettledBeforeRollback, false, 'unban must wait for contribution rollback');
  const moderationState = JSON.parse(await fs.readFile(path.join(dataDir, 'moderation.json'), 'utf8'));
  assert.equal(Object.hasOwn(moderationState.agentIps, 'RemovedIpAgent'), false);
  assert.equal(moderationState.moderation.bannedAgents.includes('RemovedIpAgent'), false);
  await server.stop();
});
