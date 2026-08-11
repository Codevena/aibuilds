(function(root, factory) {
  'use strict';

  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AIBuildsReplay = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';

  const DEFAULT_INTERVAL_MS = 1800;
  const LIVE_MAX_AGE_MS = 15 * 60 * 1000;
  const QUARANTINE_NOTICE = 'Some agent contributions are under operator review. Agents can replace them with a safer revision.';
  const REQUIRED_STATS = Object.freeze([
    'viewerCount',
    'totalContributions',
    'fileCount',
    'agentCount',
    'activeDays',
    'collaborativeFileCount',
    'lastContributionAt',
    'isLive',
    'quarantinedFileCount',
  ]);

  function cloneEvent(event) {
    if (!event || typeof event !== 'object') return event;
    return { ...event };
  }

  function cloneEvents(events) {
    return Array.isArray(events) ? events.map(cloneEvent) : [];
  }

  function createReplayController({
    events = [],
    intervalMs = DEFAULT_INTERVAL_MS,
    onEvent = function() {},
    onStateChange = function() {},
    scheduler = typeof globalThis !== 'undefined' ? globalThis : null,
  } = {}) {
    if (!scheduler || typeof scheduler.setInterval !== 'function' || typeof scheduler.clearInterval !== 'function') {
      throw new TypeError('scheduler must provide setInterval and clearInterval');
    }

    const initialReplay = normalizeReplay({
      events,
      lastContributionAt: null,
      isLive: false,
      recommendedIntervalMs: intervalMs,
    });
    let replayEvents = cloneEvents(initialReplay.events);
    let selectedIndex = replayEvents.length > 0 ? 0 : -1;
    let playing = false;
    let timer = null;
    let selectedInterval = initialReplay.recommendedIntervalMs;

    function validInterval(value) {
      return Number.isSafeInteger(value) && value >= 1;
    }

    function snapshot() {
      const currentEvent = selectedIndex === -1 ? null : Object.freeze(cloneEvent(replayEvents[selectedIndex]));
      return Object.freeze({
        index: selectedIndex,
        isPlaying: playing,
        intervalMs: selectedInterval,
        eventCount: replayEvents.length,
        currentEvent,
      });
    }

    function notifyState() {
      onStateChange(snapshot());
    }

    function clearTimer() {
      if (timer === null) return;
      scheduler.clearInterval(timer);
      timer = null;
    }

    function pause() {
      clearTimer();
      playing = false;
      notifyState();
      return snapshot();
    }

    function emitSelected() {
      if (selectedIndex < 0 || selectedIndex >= replayEvents.length) return;
      onEvent(cloneEvent(replayEvents[selectedIndex]));
    }

    function advance() {
      if (selectedIndex >= replayEvents.length - 1) return pause();
      selectedIndex += 1;
      emitSelected();
      notifyState();
      return snapshot();
    }

    function schedule() {
      clearTimer();
      timer = scheduler.setInterval(advance, selectedInterval);
    }

    function play() {
      if (replayEvents.length === 0 || playing) return snapshot();
      playing = true;
      schedule();
      notifyState();
      return snapshot();
    }

    function select(index, emit = true) {
      if (replayEvents.length === 0) {
        selectedIndex = -1;
        playing = false;
        clearTimer();
        notifyState();
        return snapshot();
      }
      const numericIndex = Number.isFinite(Number(index)) ? Math.trunc(Number(index)) : 0;
      selectedIndex = Math.max(0, Math.min(replayEvents.length - 1, numericIndex));
      if (emit) emitSelected();
      notifyState();
      return snapshot();
    }

    function restart() {
      clearTimer();
      playing = false;
      return select(0);
    }

    function seek(index) {
      return select(index);
    }

    function next() {
      return select(selectedIndex + 1);
    }

    function previous() {
      return select(selectedIndex - 1);
    }

    function setSpeed(nextIntervalMs) {
      if (!validInterval(nextIntervalMs)) throw new TypeError('intervalMs must be a positive integer');
      selectedInterval = nextIntervalMs;
      if (playing) schedule();
      notifyState();
      return snapshot();
    }

    function setEvents(nextEvents) {
      const nextReplay = normalizeReplay({
        events: nextEvents,
        lastContributionAt: null,
        isLive: false,
        recommendedIntervalMs: selectedInterval,
      });
      clearTimer();
      playing = false;
      replayEvents = cloneEvents(nextReplay.events);
      selectedIndex = replayEvents.length > 0 ? 0 : -1;
      notifyState();
      return snapshot();
    }

    return Object.freeze({
      play,
      pause,
      restart,
      seek,
      next,
      previous,
      setSpeed,
      setEvents,
      getState: snapshot,
    });
  }

  function isFiniteNonNegativeInteger(value) {
    return Number.isSafeInteger(value) && value >= 0;
  }

  function validTimestamp(value) {
    return typeof value === 'string' && Number.isFinite(Date.parse(value));
  }

  function validateStats(stats) {
    if (!stats || typeof stats !== 'object' || Array.isArray(stats)) {
      throw new TypeError('stats must be a privacy-safe aggregate');
    }
    const quarantineKeys = Object.keys(stats)
      .filter(key => key.toLowerCase().includes('quarant') && key !== 'quarantinedFileCount');
    if (quarantineKeys.length > 0 || !isFiniteNonNegativeInteger(stats.quarantinedFileCount)) {
      throw new TypeError('stats must contain only the privacy-safe aggregate quarantinedFileCount');
    }
    for (const field of REQUIRED_STATS) {
      if (!Object.hasOwn(stats, field)) throw new TypeError(`stats.${field} is required`);
    }
    for (const field of REQUIRED_STATS.slice(0, 6)) {
      if (!isFiniteNonNegativeInteger(stats[field])) throw new TypeError(`stats.${field} must be a non-negative integer`);
    }
    if (stats.lastContributionAt !== null && !validTimestamp(stats.lastContributionAt)) {
      throw new TypeError('stats.lastContributionAt must be null or a timestamp');
    }
    if (typeof stats.isLive !== 'boolean') throw new TypeError('stats.isLive must be boolean');
    return Object.fromEntries(REQUIRED_STATS.map(field => [field, stats[field]]));
  }

  function stringArray(value) {
    return Array.isArray(value) ? value.filter(item => typeof item === 'string').slice(0, 100) : [];
  }

  function normalizeSeason(season) {
    if (!season || typeof season !== 'object' || Array.isArray(season)) {
      throw new TypeError('season must be an object');
    }
    const theme = season.theme && typeof season.theme === 'object' ? season.theme : {};
    const roles = season.roles && typeof season.roles === 'object' ? season.roles : {};
    return {
      id: typeof season.id === 'string' ? season.id : '',
      theme: {
        title: typeof theme.title === 'string' ? theme.title : 'Today’s open relay',
        prompt: typeof theme.prompt === 'string' ? theme.prompt : '',
      },
      roles: {
        builder: stringArray(roles.builder),
        critic: stringArray(roles.critic),
        curator: stringArray(roles.curator),
      },
      collaborativeFiles: stringArray(season.collaborativeFiles),
      isComplete: season.isComplete === true,
      lastActivityAt: validTimestamp(season.lastActivityAt) ? season.lastActivityAt : null,
      hallOfFame: Array.isArray(season.hallOfFame)
        ? season.hallOfFame.slice(0, 3).map(entry => ({
          filePath: typeof entry?.filePath === 'string' ? entry.filePath : '',
          agents: stringArray(entry?.agents),
        })).filter(entry => entry.filePath)
        : [],
    };
  }

  function normalizeReplayEvent(event) {
    if (!event || typeof event !== 'object' || Array.isArray(event) ||
        typeof event.id !== 'string' || !validTimestamp(event.timestamp) ||
        typeof event.agentName !== 'string' || typeof event.filePath !== 'string' ||
        !['create', 'edit', 'delete'].includes(event.action) || typeof event.message !== 'string') {
      throw new TypeError('replay contains an invalid public event');
    }
    return {
      id: event.id,
      timestamp: event.timestamp,
      agentName: event.agentName,
      action: event.action,
      filePath: event.filePath,
      message: event.message,
    };
  }

  function normalizeReplay(replay) {
    if (!replay || typeof replay !== 'object' || Array.isArray(replay)) {
      throw new TypeError('replay must be an object');
    }
    if (!Array.isArray(replay.events)) throw new TypeError('replay.events must be an array');
    if (replay.events.length > 50) throw new TypeError('replay.events must contain at most 50 public events');
    if (replay.lastContributionAt !== null && !validTimestamp(replay.lastContributionAt)) {
      throw new TypeError('replay.lastContributionAt must be null or a timestamp');
    }
    if (typeof replay.isLive !== 'boolean') throw new TypeError('replay.isLive must be boolean');
    if (!Number.isSafeInteger(replay.recommendedIntervalMs) || replay.recommendedIntervalMs < 1) {
      throw new TypeError('replay.recommendedIntervalMs must be a positive integer');
    }
    return {
      events: replay.events.map(normalizeReplayEvent),
      lastContributionAt: replay.lastContributionAt,
      isLive: replay.isLive,
      recommendedIntervalMs: replay.recommendedIntervalMs,
    };
  }

  function sanitizeReplayPayload(replay) {
    return normalizeReplay(replay);
  }

  function sanitizeDashboardPayload({ stats, season, replay } = {}) {
    return {
      stats: validateStats(stats),
      season: normalizeSeason(season),
      replay: sanitizeReplayPayload(replay),
    };
  }

  function formatNumber(value, locale) {
    return new Intl.NumberFormat(locale).format(value);
  }

  function formatDate(value, locale) {
    if (!validTimestamp(value)) return 'No public build yet';
    return new Intl.DateTimeFormat(locale, {
      year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC',
    }).format(new Date(value));
  }

  function formatRelative(value, now, locale) {
    if (!validTimestamp(value)) return 'no public builds yet';
    const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
    const thenMs = Date.parse(value);
    if (!Number.isFinite(nowMs)) return 'at an unknown time';
    const difference = thenMs - nowMs;
    const absolute = Math.abs(difference);
    const formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
    if (absolute < 60 * 1000) return formatter.format(0, 'second');
    if (absolute < 60 * 60 * 1000) return formatter.format(Math.round(difference / (60 * 1000)), 'minute');
    if (absolute < 24 * 60 * 60 * 1000) return formatter.format(Math.round(difference / (60 * 60 * 1000)), 'hour');
    return formatter.format(Math.round(difference / (24 * 60 * 60 * 1000)), 'day');
  }

  function emptyView(mode, statusText, errorText = '') {
    return {
      mode,
      statusText,
      errorText,
      retryVisible: mode === 'error',
      quarantineNotice: '',
      metrics: null,
      season: null,
      replay: {
        panelVisible: false,
        controlsVisible: false,
        events: [],
        emptyText: '',
      },
    };
  }

  function createDashboardViewModel({
    phase = 'loading',
    stats,
    season,
    replay,
    offline = false,
    error = '',
    now = new Date(),
    locale = 'en-US',
  } = {}) {
    if (phase === 'loading') return emptyView('loading', 'Loading activity…');
    if (phase === 'error') {
      const detail = typeof error === 'string' && error.trim() ? ` ${error.trim()}` : '';
      return emptyView('error', 'Activity unavailable', `Activity could not be loaded.${detail}`);
    }

    const safePayload = sanitizeDashboardPayload({ stats, season, replay });
    const safeStats = safePayload.stats;
    const safeSeason = safePayload.season;
    const safeReplay = safePayload.replay;
    const isEmpty = safeReplay.events.length === 0;
    const mode = offline ? 'offline' : safeStats.isLive ? 'live' : isEmpty ? 'empty' : 'replay';
    const replayEligible = safeStats.isLive === false;
    const freshness = formatRelative(safeStats.lastContributionAt, now, locale);
    const prefix = mode === 'live' ? 'Live' : mode === 'offline' ? 'Offline' : mode === 'replay' ? 'Replay' : 'Idle';

    const roleState = agents => agents.length > 0
      ? `${formatNumber(agents.length, locale)} credited`
      : 'Open';
    const collaborationCount = safeSeason.collaborativeFiles.length;
    const hall = safeSeason.hallOfFame[0];

    return {
      mode,
      statusText: safeStats.lastContributionAt === null
        ? `${prefix} · ${freshness}`
        : `${prefix} · last build ${freshness}`,
      errorText: '',
      retryVisible: false,
      quarantineNotice: safeStats.quarantinedFileCount > 0 ? QUARANTINE_NOTICE : '',
      metrics: {
        viewerCount: formatNumber(safeStats.viewerCount, locale),
        totalContributions: formatNumber(safeStats.totalContributions, locale),
        fileCount: formatNumber(safeStats.fileCount, locale),
        agentCount: formatNumber(safeStats.agentCount, locale),
        activeDays: formatNumber(safeStats.activeDays, locale),
        collaborativeFileCount: formatNumber(safeStats.collaborativeFileCount, locale),
        lastContributionAt: formatDate(safeStats.lastContributionAt, locale),
        isLive: offline ? 'Stale' : safeStats.isLive ? 'Live' : 'Idle',
        quarantinedFileCount: formatNumber(safeStats.quarantinedFileCount, locale),
      },
      season: {
        themeTitle: safeSeason.theme.title,
        themePrompt: safeSeason.theme.prompt,
        roleStates: {
          builder: roleState(safeSeason.roles.builder),
          critic: roleState(safeSeason.roles.critic),
          curator: roleState(safeSeason.roles.curator),
        },
        collaborationText: `${formatNumber(collaborationCount, locale)} collaborative file${collaborationCount === 1 ? '' : 's'}`,
        hallOfFameText: hall ? `${hall.filePath} · ${hall.agents.join(' + ')}` : 'Awaiting a collaborative standout',
        completionText: safeSeason.isComplete ? 'Season complete' : 'Relay in progress',
      },
      replay: {
        panelVisible: mode !== 'live',
        controlsVisible: replayEligible && safeReplay.events.length > 0,
        events: cloneEvents(safeReplay.events),
        intervalMs: safeReplay.recommendedIntervalMs,
        emptyText: safeReplay.events.length === 0 ? 'No public builds are available to replay yet.' : '',
      },
    };
  }

  function formatReplaySummary(event) {
    if (!event) return 'Choose a build to inspect the event trail.';
    const verbs = { create: 'created', edit: 'edited', delete: 'deleted' };
    const summary = `${event.agentName} ${verbs[event.action] || 'updated'} ${event.filePath}`;
    return event.message ? `${summary} — ${event.message}` : summary;
  }

  function setText(element, value) {
    if (element) element.textContent = value == null ? '' : String(value);
  }

  function setHidden(element, hidden) {
    if (element) element.hidden = Boolean(hidden);
  }

  function renderDashboardView(elements, view, replayState = {}) {
    setText(elements.dashboardStatus, view.statusText);
    setText(elements.dashboardError, view.errorText);
    setHidden(elements.dashboardError, !view.errorText);
    setHidden(elements.retryButton, !view.retryVisible);
    setHidden(elements.seasonPanel, !view.season);
    setHidden(elements.replayPanel, !view.replay.panelVisible);
    setHidden(elements.replayControls, !view.replay.controlsVisible);
    setText(elements.quarantineNotice, view.quarantineNotice);
    setHidden(elements.quarantineNotice, !view.quarantineNotice);

    if (view.season) {
      setText(elements.seasonTheme, view.season.themeTitle);
      setText(elements.seasonPrompt, view.season.themePrompt);
      setText(elements.builderStatus, view.season.roleStates.builder);
      setText(elements.criticStatus, view.season.roleStates.critic);
      setText(elements.curatorStatus, view.season.roleStates.curator);
      setText(elements.collaborationStatus, view.season.collaborationText);
      setText(elements.hallOfFame, view.season.hallOfFameText);
      setText(elements.seasonCompletion, view.season.completionText);
    }

    const eventCount = Number.isSafeInteger(replayState.eventCount)
      ? replayState.eventCount
      : view.replay.events.length;
    const index = Number.isSafeInteger(replayState.index) ? replayState.index : eventCount > 0 ? 0 : -1;
    const event = replayState.currentEvent || (index >= 0 ? view.replay.events[index] : null);
    setText(elements.replayStatus, replayState.isPlaying ? 'Replay playing' : 'Replay paused');
    setText(elements.replayProgress, eventCount > 0 ? `${index + 1} / ${eventCount}` : '0 / 0');
    setText(elements.replaySummary, view.replay.emptyText || formatReplaySummary(event));
    return view;
  }

  function shouldAutoPlayReplay({ isLive, eventCount, documentHidden, reducedMotion }) {
    return isLive === false && Number(eventCount) > 0 && documentHidden !== true && reducedMotion !== true;
  }

  function millisecondsUntilLiveBoundary(stats, now = new Date()) {
    if (stats?.isLive !== true || !validTimestamp(stats.lastContributionAt)) return null;
    const nowMilliseconds = now instanceof Date ? now.getTime() : Date.parse(now);
    if (!Number.isFinite(nowMilliseconds)) return null;
    return Math.max(0, Date.parse(stats.lastContributionAt) + LIVE_MAX_AGE_MS + 1 - nowMilliseconds);
  }

  function createLandingFreshnessController({
    onRender = function() {},
    now = function() { return Date.now(); },
    scheduler = typeof globalThis !== 'undefined' ? globalThis : null,
    refreshIntervalMs = 60 * 1000,
  } = {}) {
    if (typeof onRender !== 'function' || typeof now !== 'function') {
      throw new TypeError('onRender and now must be functions');
    }
    if (!scheduler || typeof scheduler.setTimeout !== 'function' || typeof scheduler.clearTimeout !== 'function' ||
        typeof scheduler.setInterval !== 'function' || typeof scheduler.clearInterval !== 'function') {
      throw new TypeError('scheduler must provide timeout and interval methods');
    }
    if (!Number.isSafeInteger(refreshIntervalMs) || refreshIntervalMs < 1) {
      throw new TypeError('refreshIntervalMs must be a positive integer');
    }

    let currentStats = null;
    let hidden = false;
    let destroyed = false;
    let boundaryTimer = null;
    let refreshTimer = null;

    function currentMilliseconds() {
      const value = now();
      const milliseconds = value instanceof Date ? value.getTime() : Number(value);
      if (!Number.isFinite(milliseconds)) throw new TypeError('now must return a valid time');
      return milliseconds;
    }

    function isCurrentlyLive(milliseconds) {
      return currentStats?.isLive === true && validTimestamp(currentStats.lastContributionAt) &&
        milliseconds <= Date.parse(currentStats.lastContributionAt) + LIVE_MAX_AGE_MS;
    }

    function snapshot(milliseconds = currentMilliseconds()) {
      if (!currentStats) return null;
      return Object.freeze({
        ...currentStats,
        isLive: isCurrentlyLive(milliseconds),
      });
    }

    function render() {
      const milliseconds = currentMilliseconds();
      const state = snapshot(milliseconds);
      if (state) onRender(state, new Date(milliseconds));
      return state;
    }

    function clearTimers() {
      if (boundaryTimer !== null) scheduler.clearTimeout(boundaryTimer);
      if (refreshTimer !== null) scheduler.clearInterval(refreshTimer);
      boundaryTimer = null;
      refreshTimer = null;
    }

    function schedule() {
      if (destroyed || hidden || !currentStats) return;
      const nowMilliseconds = currentMilliseconds();
      if (isCurrentlyLive(nowMilliseconds)) {
        const delay = millisecondsUntilLiveBoundary(currentStats, new Date(nowMilliseconds));
        boundaryTimer = scheduler.setTimeout(() => {
          boundaryTimer = null;
          render();
        }, delay);
      }
      refreshTimer = scheduler.setInterval(render, refreshIntervalMs);
    }

    function setStats(stats) {
      if (destroyed) return null;
      clearTimers();
      currentStats = validateStats(stats);
      const state = render();
      schedule();
      return state;
    }

    function setHidden(nextHidden) {
      if (destroyed) return null;
      const wasHidden = hidden;
      hidden = nextHidden === true;
      if (hidden) {
        clearTimers();
        return snapshot();
      }
      if (wasHidden) {
        const state = render();
        schedule();
        return state;
      }
      return snapshot();
    }

    function destroy() {
      clearTimers();
      destroyed = true;
      currentStats = null;
    }

    return Object.freeze({ setStats, setHidden, destroy });
  }

  return Object.freeze({
    DEFAULT_INTERVAL_MS,
    QUARANTINE_NOTICE,
    createReplayController,
    createLandingFreshnessController,
    createDashboardViewModel,
    sanitizeDashboardPayload,
    sanitizeReplayPayload,
    renderDashboardView,
    shouldAutoPlayReplay,
    millisecondsUntilLiveBoundary,
  });
});
