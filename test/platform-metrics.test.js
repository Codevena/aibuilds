'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  deriveActivityFreshness,
  computePlatformMetrics,
} = require('../server/platform-metrics');

const NOW = new Date('2026-08-10T12:15:00.000Z');

test('liveness includes exactly the 15-minute boundary and excludes one millisecond beyond it', () => {
  // Mutation caught: changing the inclusive <= 900000 comparison to < marks the boundary idle.
  assert.deepEqual(deriveActivityFreshness({
    history: [{ timestamp: '2026-08-10T12:00:00.000Z' }],
    now: NOW,
  }), {
    lastContributionAt: '2026-08-10T12:00:00.000Z',
    isLive: true,
  });

  // Mutation caught: removing the maximum-age check keeps stale activity live.
  assert.deepEqual(deriveActivityFreshness({
    history: [{ timestamp: '2026-08-10T11:59:59.999Z' }],
    now: NOW,
  }), {
    lastContributionAt: '2026-08-10T11:59:59.999Z',
    isLive: false,
  });
});

test('collaboration counts unique agents per visible file rather than edit volume', () => {
  // Mutation caught: counting two edits as collaboration reports one false collaborative file.
  const repeated = computePlatformMetrics({
    history: [
      { agent_name: 'Solo', file_path: 'pages/solo.html', timestamp: '2026-08-10T12:00:00.000Z' },
      { agent_name: 'Solo', file_path: 'pages/solo.html', timestamp: '2026-08-10T12:01:00.000Z' },
    ],
    files: [{ path: 'pages/solo.html' }],
    now: NOW,
    quarantinedFileCount: 0,
  });
  assert.equal(repeated.collaborativeFileCount, 0);

  const collaborative = computePlatformMetrics({
    history: [
      { agent_name: 'Builder', file_path: 'sections/shared.html', timestamp: '2026-08-09T23:58:00.000Z' },
      { agent_name: 'Critic', file_path: 'sections/shared.html', timestamp: '2026-08-10T00:02:00.000Z' },
    ],
    files: [{ path: 'sections/shared.html' }],
    now: NOW,
    quarantinedFileCount: 0,
  });
  assert.equal(collaborative.collaborativeFileCount, 1);
  assert.equal(collaborative.activeDays, 2);
});

test('agent count derives only from visible history and file count from the supplied public list', () => {
  // Mutation caught: deriving agentCount from unrelated stored profiles inflates two visible agents to three.
  const metrics = computePlatformMetrics({
    history: [
      { agent_name: 'Builder', file_path: 'pages/a.html', timestamp: '2026-08-08T10:00:00.000Z' },
      { agent_name: 'Critic', file_path: 'pages/a.html', timestamp: '2026-08-09T10:00:00.000Z' },
    ],
    files: [{ path: 'pages/a.html' }, { path: 'PROJECT.md' }, { path: 'sections/b.html' }],
    agents: ['Builder', 'Critic', 'UnrelatedProfile'],
    quarantinedFiles: [{ path: 'pages/private.html', reasons: ['medical'] }],
    now: NOW,
    quarantinedFileCount: 2,
  });

  assert.deepEqual(metrics, {
    totalContributions: 2,
    fileCount: 3,
    agentCount: 2,
    activeDays: 2,
    collaborativeFileCount: 1,
    lastContributionAt: '2026-08-09T10:00:00.000Z',
    isLive: false,
    quarantinedFileCount: 2,
  });
  assert.equal(Object.keys(metrics).filter(key => key.toLowerCase().includes('quarant')).length, 1);
  assert.equal(JSON.stringify(metrics).includes('pages/private.html'), false);
});

test('empty visible history has no freshness or derived activity', () => {
  // Mutation caught: inventing a current timestamp makes an empty platform appear live.
  const metrics = computePlatformMetrics({
    history: [],
    files: [],
    now: NOW,
    quarantinedFileCount: 0,
  });

  assert.equal(metrics.lastContributionAt, null);
  assert.equal(metrics.isLive, false);
  assert.equal(metrics.totalContributions, 0);
  assert.equal(metrics.agentCount, 0);
  assert.equal(metrics.activeDays, 0);
  assert.equal(metrics.collaborativeFileCount, 0);
});
