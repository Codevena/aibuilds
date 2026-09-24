'use strict';

// Loads world/js/core.js in an isolated vm context with minimal browser fakes, so the
// LiveActivity widget can be unit-tested without a real DOM.
// LiveActivity does NO network activity of its own (no WebSocket, no fetch, no timers): the
// server only accepts WebSocket upgrades on /ws from a non-null Origin, and world pages render
// inside a CSP sandbox with an opaque origin (Origin: null), so a WS connection here could never
// succeed. Both pages that contain a `.live-activity` container (world/index.html,
// world/pages/home.html) already poll /api/history themselves and render into the same
// container, so LiveActivity stays a pure renderer with no fetch/WebSocket/timer of its own.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const CORE_JS_PATH = path.join(__dirname, '..', 'world', 'js', 'core.js');
const SOURCE = fs.readFileSync(CORE_JS_PATH, 'utf8');

function createContainer() {
  const items = [];
  const container = {
    get children() {
      return items;
    },
    prepend(item) {
      item.remove = () => {
        const idx = items.indexOf(item);
        if (idx !== -1) items.splice(idx, 1);
      };
      items.unshift(item);
    },
    get lastChild() {
      return items.length ? items[items.length - 1] : null;
    },
  };
  return container;
}

function createFakeDocument() {
  return {
    hidden: false,
    createElement() {
      return { className: '', innerHTML: '' };
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    addEventListener() {},
    removeEventListener() {},
  };
}

// Loads a fresh copy of world/js/core.js into its own vm context (so module-level state and
// the fake DOM never leak between tests). WebSocket, fetch and setInterval are all recording
// fakes: LiveActivity must never call any of them.
function loadModule() {
  const wsState = { count: 0 };
  function FakeWebSocket() {
    wsState.count += 1;
    throw new Error('LiveActivity must never construct a WebSocket');
  }

  const fetchState = { count: 0 };
  async function fakeFetch() {
    fetchState.count += 1;
    throw new Error('LiveActivity must never call fetch');
  }

  const setIntervalState = { count: 0 };
  function fakeSetInterval() {
    setIntervalState.count += 1;
    return 1;
  }

  const fakeDocument = createFakeDocument();

  const sandbox = {
    console,
    module: { exports: {} },
    document: fakeDocument,
    window: {
      location: { protocol: 'https:', host: 'aibuilds.test', pathname: '/world/' },
      addEventListener() {},
      matchMedia() {
        return { matches: false, addListener() {}, addEventListener() {} };
      },
    },
    WebSocket: FakeWebSocket,
    IntersectionObserver: function () {
      return { observe() {}, unobserve() {} };
    },
    requestAnimationFrame() {},
    Math,
    JSON,
    encodeURIComponent,
    setTimeout,
    clearTimeout,
    clearInterval() {},
    fetch: fakeFetch,
    setInterval: fakeSetInterval,
  };

  const context = vm.createContext(sandbox);
  vm.runInContext(SOURCE, context, { filename: CORE_JS_PATH });

  return {
    exports: context.module.exports,
    wsState,
    fetchState,
    setIntervalState,
    fakeDocument,
  };
}

function contribution(id, overrides = {}) {
  return {
    id,
    agent_name: `agent-${id}`,
    action: 'create',
    file_path: `file-${id}.txt`,
    message: `message ${id}`,
    ...overrides,
  };
}

test('LiveActivity does no network activity: no WebSocket, no fetch, no setInterval', async () => {
  const { exports, wsState, fetchState, setIntervalState } = loadModule();
  const container = createContainer();

  new exports.LiveActivity(container);
  // Let deferred work run too: a poller started via setTimeout or a promise callback must also
  // be caught, not only synchronous calls in the constructor.
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(wsState.count, 0);
  assert.equal(fetchState.count, 0);
  assert.equal(setIntervalState.count, 0);
});

test('addActivity renders escaped markup and caps the feed at 10 items', async () => {
  const { exports, wsState, fetchState, setIntervalState } = loadModule();
  const container = createContainer();
  const activity = new exports.LiveActivity(container);

  const malicious = contribution(1, { agent_name: '<img src=x onerror=1>' });
  activity.addActivity({ data: malicious });

  assert.equal(container.children.length, 1);
  const html = container.children[0].innerHTML;
  assert.ok(!html.includes('<img src=x onerror=1>'), 'raw markup must not appear unescaped');
  assert.ok(html.includes('&lt;img src=x onerror=1&gt;'), 'escaped markup must be present');

  // Push 12 more items (13 total) and confirm the feed caps at 10, keeping the newest on top.
  for (let i = 2; i <= 13; i += 1) {
    activity.addActivity({ data: contribution(i) });
  }

  assert.equal(container.children.length, 10);
  assert.match(container.children[0].innerHTML, /agent-13/);
  assert.match(container.children[9].innerHTML, /agent-4/);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(wsState.count + fetchState.count + setIntervalState.count, 0, 'rendering must not touch the network');
});

test('renderContribution produces the same markup as addActivity({ data: c })', async () => {
  const { exports, wsState, fetchState, setIntervalState } = loadModule();
  const containerA = createContainer();
  const containerB = createContainer();
  const activityA = new exports.LiveActivity(containerA);
  const activityB = new exports.LiveActivity(containerB);

  const c = contribution(42, { agent_name: 'render-agent' });

  activityA.renderContribution(c);
  activityB.addActivity({ data: c });

  assert.equal(containerA.children.length, 1);
  assert.equal(containerB.children.length, 1);
  assert.equal(containerA.children[0].innerHTML, containerB.children[0].innerHTML);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(wsState.count + fetchState.count + setIntervalState.count, 0, 'rendering must not touch the network');
});

test('module.exports still exposes LiveActivity', () => {
  const { exports } = loadModule();
  assert.equal(typeof exports.LiveActivity, 'function');
  assert.equal(typeof exports.AIBuilds, 'object');
  assert.equal(typeof exports.ParticleBackground, 'function');
});
