'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const replayApi = require('../public/js/replay');
const {
  QUARANTINE_NOTICE,
  createReplayController,
  createDashboardViewModel,
  createLandingFreshnessController,
  renderDashboardView,
  shouldAutoPlayReplay,
  millisecondsUntilLiveBoundary,
} = replayApi;
const { AIBuildsDashboard } = require('../public/js/app');

function createScheduler() {
  let nextId = 1;
  const timers = new Map();
  return {
    setInterval(callback, intervalMs) {
      const id = nextId++;
      timers.set(id, { callback, intervalMs });
      return id;
    },
    clearInterval(id) {
      timers.delete(id);
    },
    tick() {
      for (const timer of [...timers.values()]) timer.callback();
    },
  };
}

function createClockScheduler(startMilliseconds) {
  let nowMilliseconds = startMilliseconds;
  let nextId = 1;
  const timers = new Map();

  function addTimer(callback, delay, intervalMs) {
    const id = nextId++;
    timers.set(id, {
      callback,
      dueAt: nowMilliseconds + Number(delay),
      intervalMs,
    });
    return id;
  }

  return {
    now: () => nowMilliseconds,
    setTimeout: (callback, delay) => addTimer(callback, delay, null),
    clearTimeout: id => timers.delete(id),
    setInterval: (callback, intervalMs) => addTimer(callback, intervalMs, Number(intervalMs)),
    clearInterval: id => timers.delete(id),
    advance(milliseconds) {
      const target = nowMilliseconds + milliseconds;
      while (true) {
        const next = [...timers.entries()]
          .filter(([, timer]) => timer.dueAt <= target)
          .sort((left, right) => left[1].dueAt - right[1].dueAt || left[0] - right[0])[0];
        if (!next) break;
        const [id, timer] = next;
        nowMilliseconds = timer.dueAt;
        if (timer.intervalMs === null) timers.delete(id);
        else timer.dueAt += timer.intervalMs;
        timer.callback();
      }
      nowMilliseconds = target;
    },
    pendingCount: () => timers.size,
    pendingTimeouts: () => [...timers.values()].filter(timer => timer.intervalMs === null),
    pendingIntervals: () => [...timers.values()].filter(timer => timer.intervalMs !== null),
  };
}

function replayEvents() {
  return [
    {
      id: 'event-1', timestamp: '2026-08-10T10:00:00.000Z', agentName: 'Builder',
      action: 'create', filePath: 'pages/shared.html', message: 'Started the relay.',
    },
    {
      id: 'event-2', timestamp: '2026-08-10T10:02:00.000Z', agentName: 'Critic',
      action: 'edit', filePath: 'pages/shared.html', message: 'Improved the relay.',
    },
    {
      id: 'event-3', timestamp: '2026-08-10T10:04:00.000Z', agentName: 'Curator',
      action: 'edit', filePath: 'pages/shared.html', message: 'Polished the relay.',
    },
  ];
}

function createController(overrides = {}) {
  const scheduler = overrides.scheduler || createScheduler();
  const emitted = [];
  const states = [];
  const controller = createReplayController({
    events: replayEvents(),
    scheduler,
    onEvent: event => emitted.push(event),
    onStateChange: state => states.push(state),
    ...overrides,
  });
  return { controller, scheduler, emitted, states };
}

test('play advances from the first event and emits only the real next event', () => {
  // Mutation caught: a no-op timer leaves the controller at index 0 with no emitted event.
  const { controller, scheduler, emitted } = createController();
  controller.play();
  scheduler.tick();

  assert.equal(controller.getState().index, 1);
  assert.deepEqual(emitted, [replayEvents()[1]]);
});

test('pause cancels advancement and emits zero additional events', () => {
  // Mutation caught: retaining the timer after pause emits one additional event instead of zero.
  const { controller, scheduler, emitted } = createController();
  controller.play();
  controller.pause();
  scheduler.tick();

  assert.equal(controller.getState().index, 0);
  assert.equal(controller.getState().isPlaying, false);
  assert.equal(emitted.length, 0);
});

test('restart returns to and emits the first event while remaining paused', () => {
  // Mutation caught: restart that only pauses leaves the selected index at 2.
  const { controller, emitted } = createController();
  controller.seek(2);
  emitted.length = 0;
  controller.restart();

  assert.equal(controller.getState().index, 0);
  assert.equal(controller.getState().isPlaying, false);
  assert.deepEqual(emitted, [replayEvents()[0]]);
});

test('speed change reschedules playback without changing the selected event', () => {
  // Mutation caught: ignored speed keeps intervalMs at the 1800 ms default instead of 900 ms.
  const scheduler = createScheduler();
  const { controller, emitted } = createController({ scheduler });
  controller.play();
  controller.setSpeed(900);

  assert.deepEqual(controller.getState(), {
    index: 0,
    isPlaying: true,
    intervalMs: 900,
    eventCount: 3,
    currentEvent: replayEvents()[0],
  });
  scheduler.tick();
  assert.equal(controller.getState().index, 1);
  assert.equal(emitted.length, 1);
});

test('seek and manual navigation clamp to both event bounds', () => {
  // Mutation caught: missing clamps produce indices -10 and 99 instead of 0 and 2.
  const { controller } = createController();
  controller.seek(-10);
  assert.equal(controller.getState().index, 0);
  controller.previous();
  assert.equal(controller.getState().index, 0);
  controller.seek(99);
  assert.equal(controller.getState().index, 2);
  controller.next();
  assert.equal(controller.getState().index, 2);
});

test('replacing events pauses and resets safely without retaining caller-owned data', () => {
  // Mutation caught: preserving the prior index selects no event when a shorter list replaces it.
  const replacement = [replayEvents()[2]];
  const { controller } = createController();
  controller.seek(2);
  controller.play();
  controller.setEvents(replacement);
  replacement[0].agentName = 'mutated outside';

  assert.equal(controller.getState().index, 0);
  assert.equal(controller.getState().isPlaying, false);
  assert.equal(controller.getState().eventCount, 1);
  assert.equal(controller.getState().currentEvent.agentName, 'Curator');
});

test('empty input uses index -1 and remains paused across every command', () => {
  // Mutation caught: using index 0 for an empty list breaks the explicit no-selection sentinel.
  const { controller, scheduler, emitted } = createController({ events: [] });
  assert.equal(controller.getState().index, -1);
  controller.play();
  controller.next();
  controller.previous();
  controller.restart();
  controller.seek(4);
  scheduler.tick();

  assert.deepEqual(controller.getState(), {
    index: -1,
    isPlaying: false,
    intervalMs: 1800,
    eventCount: 0,
    currentEvent: null,
  });
  assert.equal(emitted.length, 0);
});

test('reaching the end pauses without wrapping or synthesizing an event', () => {
  // Mutation caught: end-of-list wrap returns to index 0 and emits a fourth event.
  const { controller, scheduler, emitted } = createController();
  controller.play();
  scheduler.tick();
  scheduler.tick();
  scheduler.tick();

  assert.equal(controller.getState().index, 2);
  assert.equal(controller.getState().isPlaying, false);
  assert.deepEqual(emitted.map(event => event.id), ['event-2', 'event-3']);
});

test('getState returns immutable snapshots rather than controller-owned references', () => {
  // Mutation caught: returning the internal event lets a consumer rewrite future state.
  const { controller } = createController();
  const snapshot = controller.getState();
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.currentEvent), true);
  assert.throws(() => { snapshot.index = 2; }, TypeError);
  assert.throws(() => { snapshot.currentEvent.agentName = 'tampered'; }, TypeError);

  assert.equal(controller.getState().index, 0);
  assert.equal(controller.getState().currentEvent.agentName, 'Builder');
});

const READY_STATS = Object.freeze({
  viewerCount: 12,
  totalContributions: 1234,
  fileCount: 27,
  agentCount: 8,
  activeDays: 6,
  collaborativeFileCount: 4,
  lastContributionAt: '2026-08-10T10:00:00.000Z',
  isLive: false,
  quarantinedFileCount: 1,
});

const READY_SEASON = Object.freeze({
  id: '2026-08-10',
  theme: {
    version: 'v1', id: 'remix-relay', title: 'Remix Relay',
    prompt: 'Take another agent’s work one meaningful step further.',
  },
  roles: { builder: ['Builder'], critic: ['Critic'], curator: [] },
  collaborativeFiles: ['pages/shared.html'],
  isComplete: false,
  lastActivityAt: '2026-08-10T10:02:00.000Z',
  hallOfFame: [{
    filePath: 'pages/shared.html', agents: ['Builder', 'Critic'], voteScore: 2,
    crossAgentEdits: 1, lastActivityAt: '2026-08-10T10:02:00.000Z',
  }],
});

const READY_REPLAY = Object.freeze({
  events: replayEvents(),
  lastContributionAt: '2026-08-10T10:00:00.000Z',
  isLive: false,
  recommendedIntervalMs: 1800,
});

test('the full replay payload is rejected beyond 50 events and for fractional intervals', () => {
  // Mutations caught: restoring slice(0, 50) hides an invalid 51st event; truncating 900.5 silently changes timing.
  const invalidFiftyFirst = [
    ...Array.from({ length: 50 }, (_, index) => ({
      ...replayEvents()[0],
      id: `event-${index + 1}`,
    })),
    { ...replayEvents()[0], id: 'event-51', timestamp: 'not-a-timestamp' },
  ];

  assert.throws(() => createDashboardViewModel({
    phase: 'ready', stats: READY_STATS, season: READY_SEASON,
    replay: { ...READY_REPLAY, events: invalidFiftyFirst },
  }), /at most 50/);
  assert.throws(() => createDashboardViewModel({
    phase: 'ready', stats: READY_STATS, season: READY_SEASON,
    replay: { ...READY_REPLAY, recommendedIntervalMs: 900.5 },
  }), /positive integer/);
  assert.throws(() => createReplayController({
    events: invalidFiftyFirst,
    scheduler: createScheduler(),
  }), /at most 50/);
  assert.throws(() => createReplayController({
    events: replayEvents(),
    intervalMs: 900.5,
    scheduler: createScheduler(),
  }), /positive integer/);
});

test('replay controller consumes normalized public events rather than caller-owned extra fields', () => {
  // Mutation caught: cloning raw controller input retains fields outside the public replay record.
  const event = { ...replayEvents()[0], operatorNote: 'must not reach playback' };
  const { controller } = createController({ events: [event] });

  assert.deepEqual(controller.getState().currentEvent, replayEvents()[0]);
  assert.equal(Object.hasOwn(controller.getState().currentEvent, 'operatorNote'), false);
});

test('dashboard view exposes every metric with Intl formatting and an honest replay state', () => {
  // Mutation caught: deriving mode from the socket instead of stats.isLive labels stale data live.
  const view = createDashboardViewModel({
    phase: 'ready', stats: READY_STATS, season: READY_SEASON, replay: READY_REPLAY,
    now: new Date('2026-08-10T12:00:00.000Z'), locale: 'en-US',
  });

  assert.equal(view.mode, 'replay');
  assert.equal(view.statusText, 'Replay · last build 2 hours ago');
  assert.equal(view.replay.controlsVisible, true);
  assert.equal(view.metrics.viewerCount, '12');
  assert.equal(view.metrics.totalContributions, '1,234');
  assert.equal(view.metrics.fileCount, '27');
  assert.equal(view.metrics.agentCount, '8');
  assert.equal(view.metrics.activeDays, '6');
  assert.equal(view.metrics.collaborativeFileCount, '4');
  assert.equal(view.metrics.lastContributionAt, 'Aug 10, 2026, 10:00 AM');
  assert.equal(view.metrics.isLive, 'Idle');
  assert.equal(view.metrics.quarantinedFileCount, '1');
  assert.equal(view.quarantineNotice, QUARANTINE_NOTICE);
  assert.deepEqual(view.season.roleStates, {
    builder: '1 credited', critic: '1 credited', curator: 'Open',
  });
  assert.equal(view.season.collaborationText, '1 collaborative file');
  assert.equal(view.season.hallOfFameText, 'pages/shared.html · Builder + Critic');
  assert.equal(view.season.completionText, 'Relay in progress');
});

test('live mode hides automatic replay controls and never treats a connected socket as liveness', () => {
  // Mutation caught: always showing replay controls lets playback masquerade beside real live activity.
  const view = createDashboardViewModel({
    phase: 'ready',
    stats: { ...READY_STATS, isLive: true },
    season: READY_SEASON,
    replay: { ...READY_REPLAY, isLive: true },
    offline: false,
    now: new Date('2026-08-10T10:05:00.000Z'),
  });

  assert.equal(view.mode, 'live');
  assert.equal(view.statusText, 'Live · last build 5 minutes ago');
  assert.equal(view.replay.controlsVisible, false);
  assert.equal(view.metrics.isLive, 'Live');
});

test('offline cached-live data exposes no inert replay control or play eligibility', () => {
  // Mutation caught: deriving controls from offline mode shows Play even though the same live bit blocks playback.
  const view = createDashboardViewModel({
    phase: 'ready',
    stats: { ...READY_STATS, isLive: true },
    season: READY_SEASON,
    replay: { ...READY_REPLAY, isLive: true },
    offline: true,
  });

  assert.equal(view.mode, 'offline');
  assert.equal(view.replay.controlsVisible, false);
  const replayControls = { hidden: false };
  renderDashboardView({ replayControls }, view);
  assert.equal(replayControls.hidden, true);
  assert.equal(shouldAutoPlayReplay({
    isLive: true, eventCount: view.replay.events.length, documentHidden: false, reducedMotion: false,
  }), false);
  assert.equal(shouldAutoPlayReplay({
    isLive: undefined, eventCount: view.replay.events.length, documentHidden: false, reducedMotion: false,
  }), false);
});

test('dashboard distinguishes loading, empty, error, and offline stale states with user retry', () => {
  // Mutations caught: collapsing error into empty hides retry; ignoring offline labels stale data Replay.
  const loading = createDashboardViewModel({ phase: 'loading' });
  assert.deepEqual([loading.mode, loading.statusText, loading.retryVisible], ['loading', 'Loading activity…', false]);

  const empty = createDashboardViewModel({
    phase: 'ready',
    stats: { ...READY_STATS, totalContributions: 0, lastContributionAt: null, quarantinedFileCount: 0 },
    season: { ...READY_SEASON, roles: { builder: [], critic: [], curator: [] }, collaborativeFiles: [], hallOfFame: [] },
    replay: { ...READY_REPLAY, events: [], lastContributionAt: null },
  });
  assert.deepEqual([empty.mode, empty.statusText, empty.replay.emptyText], [
    'empty', 'Idle · no public builds yet', 'No public builds are available to replay yet.',
  ]);

  const error = createDashboardViewModel({ phase: 'error', error: 'Network unavailable' });
  assert.deepEqual([error.mode, error.errorText, error.retryVisible], [
    'error', 'Activity could not be loaded. Network unavailable', true,
  ]);

  const offline = createDashboardViewModel({
    phase: 'ready', stats: READY_STATS, season: READY_SEASON, replay: READY_REPLAY,
    offline: true, now: new Date('2026-08-10T12:00:00.000Z'),
  });
  assert.equal(offline.mode, 'offline');
  assert.equal(offline.statusText, 'Offline · last build 2 hours ago');
  assert.equal(offline.replay.controlsVisible, true);
  assert.equal(offline.metrics.isLive, 'Stale');
});

test('privacy boundary emits one aggregate notice for count 1, none for 0, and rejects record-shaped data', () => {
  // Mutation caught: accepting quarantinedFiles would expose operator-only paths and reasons.
  const withNotice = createDashboardViewModel({
    phase: 'ready', stats: READY_STATS, season: READY_SEASON, replay: READY_REPLAY,
  });
  const withoutNotice = createDashboardViewModel({
    phase: 'ready', stats: { ...READY_STATS, quarantinedFileCount: 0 },
    season: READY_SEASON, replay: READY_REPLAY,
  });

  assert.equal(withNotice.quarantineNotice, QUARANTINE_NOTICE);
  assert.equal(withoutNotice.quarantineNotice, '');
  assert.throws(() => createDashboardViewModel({
    phase: 'ready',
    stats: {
      ...READY_STATS,
      quarantinedFileCount: [{ path: 'pages/private.html', reasons: ['medical'], agentName: 'Private' }],
    },
    season: READY_SEASON,
    replay: READY_REPLAY,
  }), /privacy-safe aggregate/);
  assert.throws(() => createDashboardViewModel({
    phase: 'ready',
    stats: { ...READY_STATS, quarantinedFiles: [{ path: 'pages/private.html' }] },
    season: READY_SEASON,
    replay: READY_REPLAY,
  }), /privacy-safe aggregate/);
});

test('render behavior uses textContent for hostile replay text and exposes state visibility', () => {
  // Mutation caught: assigning replay summary through innerHTML triggers the throwing setter.
  function element() {
    return {
      textContent: '', hidden: false,
      set innerHTML(_) { throw new Error('unsafe innerHTML write'); },
    };
  }
  const elements = {
    dashboardStatus: element(), dashboardError: element(), retryButton: element(),
    seasonPanel: element(), seasonTheme: element(), seasonPrompt: element(),
    builderStatus: element(), criticStatus: element(), curatorStatus: element(),
    collaborationStatus: element(), hallOfFame: element(), seasonCompletion: element(),
    replayPanel: element(), replayControls: element(), replayStatus: element(),
    replayProgress: element(), replaySummary: element(), quarantineNotice: element(),
  };
  const view = createDashboardViewModel({
    phase: 'ready', stats: READY_STATS, season: READY_SEASON,
    replay: {
      ...READY_REPLAY,
      events: [{
        ...replayEvents()[0],
        agentName: '<img src=x onerror=alert(1)>',
        message: '<script>steal()</script>',
      }],
    },
  });

  renderDashboardView(elements, view, { index: 0, eventCount: 1, isPlaying: false });

  assert.equal(elements.replaySummary.textContent,
    '<img src=x onerror=alert(1)> created pages/shared.html — <script>steal()</script>');
  assert.equal(elements.replayPanel.hidden, false);
  assert.equal(elements.replayControls.hidden, false);
  assert.equal(elements.retryButton.hidden, true);
  assert.equal(elements.quarantineNotice.textContent, QUARANTINE_NOTICE);
  assert.equal(Object.values(elements).filter(node => node.textContent === QUARANTINE_NOTICE).length, 1);
});

test('visibility and reduced-motion policy prevents replay auto-play', () => {
  // Mutations caught: ignoring either accessibility signal returns true instead of false.
  assert.equal(shouldAutoPlayReplay({ isLive: false, eventCount: 3, documentHidden: false, reducedMotion: false }), true);
  assert.equal(shouldAutoPlayReplay({ isLive: false, eventCount: 3, documentHidden: true, reducedMotion: false }), false);
  assert.equal(shouldAutoPlayReplay({ isLive: false, eventCount: 3, documentHidden: false, reducedMotion: true }), false);
  assert.equal(shouldAutoPlayReplay({ isLive: true, eventCount: 3, documentHidden: false, reducedMotion: false }), false);
  assert.equal(shouldAutoPlayReplay({ isLive: false, eventCount: 0, documentHidden: false, reducedMotion: false }), false);
});

test('live freshness schedules one boundary refresh just after the inclusive 15-minute window', () => {
  // Mutation caught: no boundary timer lets a once-live dashboard remain live forever.
  assert.equal(millisecondsUntilLiveBoundary({
    isLive: true,
    lastContributionAt: '2026-08-10T10:00:00.000Z',
  }, new Date('2026-08-10T10:05:00.000Z')), 600001);
  assert.equal(millisecondsUntilLiveBoundary({
    isLive: false,
    lastContributionAt: '2026-08-10T10:00:00.000Z',
  }, new Date('2026-08-10T10:05:00.000Z')), null);
  assert.equal(millisecondsUntilLiveBoundary({ isLive: true, lastContributionAt: null }), null);
});

test('landing freshness refreshes periodically and flips exactly one millisecond after the live boundary', () => {
  // Mutations caught: omitting +1 flips early; leaving timers active keeps hidden/destroyed pages updating.
  const scheduler = createClockScheduler(Date.parse('2026-08-10T10:05:00.000Z'));
  const renders = [];
  const controller = createLandingFreshnessController({
    scheduler,
    now: scheduler.now,
    refreshIntervalMs: 60000,
    onRender: snapshot => renders.push({ now: scheduler.now(), isLive: snapshot.isLive }),
  });
  controller.setStats({
    ...READY_STATS,
    isLive: true,
    lastContributionAt: '2026-08-10T10:00:00.000Z',
  });

  assert.deepEqual(scheduler.pendingTimeouts().map(timer => timer.dueAt - scheduler.now()), [600001]);
  assert.equal(scheduler.pendingIntervals().length, 1);
  const originalTimers = [...scheduler.pendingTimeouts(), ...scheduler.pendingIntervals()];
  controller.setStats({
    ...READY_STATS,
    isLive: true,
    lastContributionAt: '2026-08-10T10:00:00.000Z',
  });
  assert.equal(scheduler.pendingCount(), 2);
  assert.equal(
    [...scheduler.pendingTimeouts(), ...scheduler.pendingIntervals()]
      .some(timer => originalTimers.includes(timer)),
    false,
  );
  scheduler.advance(60000);
  assert.deepEqual(renders.at(-1), {
    now: Date.parse('2026-08-10T10:06:00.000Z'), isLive: true,
  });
  scheduler.advance(540000);
  assert.deepEqual(renders.at(-1), {
    now: Date.parse('2026-08-10T10:15:00.000Z'), isLive: true,
  });
  scheduler.advance(1);
  assert.deepEqual(renders.at(-1), {
    now: Date.parse('2026-08-10T10:15:00.001Z'), isLive: false,
  });

  controller.setHidden(true);
  assert.equal(scheduler.pendingCount(), 0);
  const hiddenRenderCount = renders.length;
  scheduler.advance(60000);
  assert.equal(renders.length, hiddenRenderCount);
  controller.setHidden(false);
  assert.equal(renders.length, hiddenRenderCount + 1);
  assert.equal(scheduler.pendingIntervals().length, 1);
  controller.setHidden(false);
  assert.equal(scheduler.pendingIntervals().length, 1);
  controller.destroy();
  assert.equal(scheduler.pendingCount(), 0);
});

test('landing wires the shared freshness controller to visibility and page lifecycle cleanup', () => {
  // Mutation caught: a one-shot landing render has no shared clock or lifecycle cleanup calls.
  const html = fs.readFileSync(require.resolve('../public/landing.html'), 'utf8');
  assert.match(html, /<script src="\/js\/replay\.js"><\/script>/);
  assert.match(html, /createLandingFreshnessController/);
  assert.match(html, /landingFreshness\.setStats\(stats\)/);
  assert.match(html, /setHidden\(document\.hidden\)/);
  assert.match(html, /addEventListener\('visibilitychange'/);
  assert.match(html, /addEventListener\('pagehide'/);
  assert.match(html, /addEventListener\('pageshow'/);
  assert.match(html, /event\.persisted/);
  assert.match(html, /\.destroy\(\)/);
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createDashboardHarness() {
  const dashboard = Object.create(AIBuildsDashboard.prototype);
  dashboard.dashboardData = {
    phase: 'ready', stats: READY_STATS, season: READY_SEASON, replay: READY_REPLAY, offline: false,
  };
  dashboard.replayApi = replayApi;
  dashboard.dashboardRequestGeneration = 0;
  dashboard.dashboardLoadToken = null;
  dashboard.dashboardRefreshPromise = null;
  dashboard.dashboardRefreshQueued = false;
  dashboard.pendingReplayContributions = new Map();
  dashboard.freshnessTimer = null;
  dashboard.replayController = {
    pause() {},
    setEvents() {},
    getState() { return { index: 0, isPlaying: false, eventCount: 3 }; },
  };
  dashboard.elements = { replaySpeed: { value: '' } };
  dashboard.renderDashboard = () => {};
  dashboard.updateStats = () => {};
  dashboard.initializeReplay = () => {};
  dashboard.scheduleFreshnessBoundary = () => {};
  return dashboard;
}

test('dashboard effects receive only the authoritative sanitized payload', async () => {
  // Mutation caught: validating a derived view but retaining raw API objects leaks extra fields into controller state.
  const dashboard = createDashboardHarness();
  const rawStats = { ...READY_STATS, operatorNote: 'not a public metric' };
  const rawSeason = { ...READY_SEASON, internalScore: 99 };
  const rawReplay = {
    ...READY_REPLAY,
    events: READY_REPLAY.events.map((event, index) => (
      index === 0 ? { ...event, operatorNote: 'not a public event field' } : event
    )),
    internalCursor: 'private-cursor',
  };
  let initializedReplay = null;
  dashboard.fetchJson = async url => {
    if (url === '/api/stats') return rawStats;
    if (url === '/api/season/current') return rawSeason;
    return rawReplay;
  };
  dashboard.initializeReplay = replay => { initializedReplay = replay; };

  await dashboard.fetchDashboardData();

  assert.equal(dashboard.dashboardData.phase, 'ready');
  assert.notEqual(dashboard.dashboardData.stats, rawStats);
  assert.notEqual(dashboard.dashboardData.season, rawSeason);
  assert.notEqual(dashboard.dashboardData.replay, rawReplay);
  assert.equal(Object.hasOwn(dashboard.dashboardData.stats, 'operatorNote'), false);
  assert.equal(Object.hasOwn(dashboard.dashboardData.season, 'internalScore'), false);
  assert.equal(Object.hasOwn(dashboard.dashboardData.replay, 'internalCursor'), false);
  assert.equal(Object.hasOwn(dashboard.dashboardData.replay.events[0], 'operatorNote'), false);
  assert.equal(initializedReplay, dashboard.dashboardData.replay);
});

test('manual replay playback obeys the same hidden/reduced-motion policy as auto-play', () => {
  // Mutation caught: unconditionally calling play starts animation after policy has rejected it.
  const dashboard = createDashboardHarness();
  let plays = 0;
  let pauses = 0;
  dashboard.replayController = {
    getState: () => ({ isPlaying: false }),
    play: () => { plays += 1; },
    pause: () => { pauses += 1; },
  };
  dashboard.canAutoPlayReplay = () => false;

  dashboard.toggleReplayPlayback();
  assert.deepEqual({ plays, pauses }, { plays: 0, pauses: 0 });

  dashboard.replayController.getState = () => ({ isPlaying: true });
  dashboard.toggleReplayPlayback();
  assert.deepEqual({ plays, pauses }, { plays: 0, pauses: 1 });
});

test('a contribution received during the full dashboard load survives its stale replay snapshot', async () => {
  // Mutation caught: replacing dashboardData with the load response drops the queued event.
  const dashboard = createDashboardHarness();
  const freshStats = { ...READY_STATS, totalContributions: READY_STATS.totalContributions + 1, isLive: true };
  const refreshedSeason = { ...READY_SEASON, lastActivityAt: '2026-08-10T10:05:00.000Z' };
  const calls = [];
  dashboard.fetchJson = async url => {
    calls.push(url);
    if (url === '/api/stats') return calls.filter(call => call === url).length === 1 ? READY_STATS : freshStats;
    if (url === '/api/season/current') {
      return calls.filter(call => call === url).length === 1 ? READY_SEASON : refreshedSeason;
    }
    return READY_REPLAY;
  };

  const load = dashboard.fetchDashboardData();
  const queuedContribution = {
    id: 'event-during-load', timestamp: '2026-08-10T10:05:00.000Z', agent_name: 'LateBuilder',
    action: 'edit', file_path: 'pages/shared.html', message: 'Arrived during the snapshot.',
  };
  dashboard.handleDashboardContribution(queuedContribution);
  await load;

  assert.equal(calls.filter(url => url === '/api/stats').length, 2);
  assert.equal(calls.filter(url => url === '/api/season/current').length, 2);
  assert.equal(calls.filter(url => url.startsWith('/api/replay')).length, 1);
  assert.equal(dashboard.dashboardData.stats.totalContributions, freshStats.totalContributions);
  assert.equal(dashboard.dashboardData.season.lastActivityAt, refreshedSeason.lastActivityAt);
  assert.equal(dashboard.dashboardData.replay.events.at(-1).id, queuedContribution.id);
});

test('rapid contribution refreshes serialize and coalesce without stale response overwrite', async () => {
  // Mutation caught: launching both refreshes immediately creates four concurrent API requests.
  const dashboard = createDashboardHarness();
  const requests = [];
  dashboard.fetchJson = url => {
    const pending = deferred();
    requests.push({ url, ...pending });
    return pending.promise;
  };
  const contributionOne = {
    id: 'event-4', timestamp: '2026-08-10T10:05:00.000Z', agent_name: 'BuilderTwo',
    action: 'edit', file_path: 'pages/shared.html', message: 'First rapid event.',
  };
  const contributionTwo = {
    ...contributionOne, id: 'event-5', timestamp: '2026-08-10T10:06:00.000Z', message: 'Second rapid event.',
  };

  const firstRefresh = dashboard.handleDashboardContribution(contributionOne);
  const secondRefresh = dashboard.handleDashboardContribution(contributionTwo);
  assert.equal(requests.length, 2);

  requests.find(request => request.url === '/api/stats').resolve({ ...READY_STATS, totalContributions: 1235 });
  requests.find(request => request.url === '/api/season/current').resolve(READY_SEASON);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(requests.length, 4);

  requests.filter(request => request.url === '/api/stats')[1]
    .resolve({ ...READY_STATS, totalContributions: 1236, isLive: true });
  requests.filter(request => request.url === '/api/season/current')[1]
    .resolve({ ...READY_SEASON, lastActivityAt: contributionTwo.timestamp });
  await Promise.all([firstRefresh, secondRefresh]);

  assert.equal(dashboard.dashboardData.stats.totalContributions, 1236);
  assert.equal(dashboard.dashboardData.season.lastActivityAt, contributionTwo.timestamp);
  assert.deepEqual(dashboard.dashboardData.replay.events.slice(-2).map(event => event.id), ['event-4', 'event-5']);
});

test('a stale contribution-refresh error cannot overwrite a newer full dashboard request', async () => {
  // Mutation caught: removing the generation check turns the rejected old request into error mode.
  const dashboard = createDashboardHarness();
  const requests = [];
  dashboard.fetchJson = url => {
    const pending = deferred();
    requests.push({ url, ...pending });
    return pending.promise;
  };
  const contribution = {
    id: 'event-before-reload', timestamp: '2026-08-10T10:07:00.000Z', agent_name: 'ReloadBuilder',
    action: 'edit', file_path: 'pages/shared.html', message: 'Refresh raced a reload.',
  };

  const oldRefresh = dashboard.handleDashboardContribution(contribution);
  const fullLoad = dashboard.fetchDashboardData();
  assert.equal(requests.length, 5);

  requests[0].reject(new Error('stale refresh failed'));
  requests[1].resolve(READY_SEASON);
  await oldRefresh;
  assert.notEqual(dashboard.dashboardData.phase, 'error');

  requests[2].resolve({ ...READY_STATS, totalContributions: 1235, isLive: true });
  requests[3].resolve({ ...READY_SEASON, lastActivityAt: contribution.timestamp });
  requests[4].resolve({ ...READY_REPLAY, events: [...READY_REPLAY.events, {
    id: contribution.id,
    timestamp: contribution.timestamp,
    agentName: contribution.agent_name,
    action: contribution.action,
    filePath: contribution.file_path,
    message: contribution.message,
  }] });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(requests.length, 7);

  requests[5].resolve({ ...READY_STATS, totalContributions: 1235, isLive: true });
  requests[6].resolve({ ...READY_SEASON, lastActivityAt: contribution.timestamp });
  await fullLoad;

  assert.equal(dashboard.dashboardData.phase, 'ready');
  assert.equal(dashboard.dashboardData.stats.totalContributions, 1235);
  assert.equal(dashboard.dashboardData.replay.events.at(-1).id, contribution.id);
});

test('retry and replay controls restore a visible keyboard focus indicator', () => {
  // Mutation caught: removing any focus selector leaves a new interactive control without a ring.
  const css = fs.readFileSync(require.resolve('../public/css/style.css'), 'utf8');
  assert.match(css, /\.relay-retry:focus-visible/);
  assert.match(css, /\.replay-control:focus-visible/);
  assert.match(css, /\.replay-speed select:focus-visible/);
});

test('WebSocket achievement fields cross the popup renderer only as text and safe attributes', () => {
  // Mutation caught: interpolating achievement.icon through innerHTML triggers the throwing setter.
  const dashboard = createDashboardHarness();
  const iconChildren = [];
  const iconContainer = {
    replaceChildren(...children) { iconChildren.splice(0, iconChildren.length, ...children); },
    set innerHTML(_) { throw new Error('unsafe achievement innerHTML write'); },
  };
  const name = { textContent: '' };
  const description = { textContent: '' };
  const popupClasses = [];
  dashboard.elements.achievementPopup = {
    classList: {
      add(value) { popupClasses.push(value); },
      remove() {},
    },
  };
  const originalDocument = global.document;
  const originalWindow = global.window;
  const originalSetTimeout = global.setTimeout;
  global.document = {
    getElementById(id) {
      return { achievementIcon: iconContainer, achievementName: name, achievementDesc: description }[id];
    },
    createElement(tagName) {
      return {
        tagName,
        className: '',
        attributes: {},
        setAttribute(key, value) { this.attributes[key] = String(value); },
      };
    },
  };
  global.window = { lucide: null };
  global.setTimeout = callback => { callback(); return 1; };
  try {
    dashboard.showAchievementPopup({
      agentName: '<img src=x onerror=steal()>',
      achievement: {
        icon: '\"><img src=x onerror=steal()>',
        name: '<script>name()</script>',
        description: '<svg onload=steal()>',
      },
    });
  } finally {
    global.document = originalDocument;
    global.window = originalWindow;
    global.setTimeout = originalSetTimeout;
  }

  assert.equal(iconChildren.length, 1);
  assert.equal(iconChildren[0].attributes['data-lucide'], 'award');
  assert.equal(name.textContent, '<script>name()</script>');
  assert.equal(description.textContent,
    '<img src=x onerror=steal()> earned: <svg onload=steal()>');
  assert.deepEqual(popupClasses, ['show']);
});

test('rejected API data causes zero replay-controller timers or emitted events', async () => {
  // Mutation caught: initializing replay before payload validation leaves one active timer in error state.
  const dashboard = createDashboardHarness();
  const timers = new Map();
  const emitted = [];
  let nextTimerId = 1;
  const originalWindow = global.window;
  const originalDocument = global.document;
  const originalConsoleError = console.error;
  global.window = {
    AIBuildsReplay: replayApi,
    setInterval(callback, intervalMs) {
      const id = nextTimerId++;
      timers.set(id, { callback, intervalMs });
      return id;
    },
    clearInterval(id) { timers.delete(id); },
  };
  global.document = { hidden: false };
  console.error = () => {};
  dashboard.reducedMotionQuery = { matches: false };
  dashboard.replayController = null;
  dashboard.renderReplayEvent = event => emitted.push(event);
  dashboard.initializeReplay = AIBuildsDashboard.prototype.initializeReplay;
  dashboard.fetchJson = async url => {
    if (url === '/api/stats') {
      return { ...READY_STATS, quarantinedFiles: [{ path: 'pages/private.html' }] };
    }
    if (url === '/api/season/current') return READY_SEASON;
    return READY_REPLAY;
  };

  try {
    await dashboard.fetchDashboardData();
  } finally {
    global.window = originalWindow;
    global.document = originalDocument;
    console.error = originalConsoleError;
  }

  assert.equal(dashboard.dashboardData.phase, 'error');
  assert.equal(dashboard.replayController, null);
  assert.equal(timers.size, 0);
  assert.equal(emitted.length, 0);
});
