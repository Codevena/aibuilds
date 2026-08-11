'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const parse5 = require('parse5');
const postcss = require('postcss');
const { AIBuildsDashboard } = require('../public/js/app');

const ROOT = path.join(__dirname, '..');

function walk(node, visit) {
  visit(node);
  for (const child of node.childNodes || []) walk(child, visit);
  if (node.content) walk(node.content, visit);
}

function attribute(node, name) {
  return (node.attrs || []).find(item => item.name === name)?.value;
}

function textContent(node) {
  const values = [];
  walk(node, current => {
    if (current.nodeName === '#text') values.push(current.value);
  });
  return values.join(' ').replace(/\s+/g, ' ').trim();
}

function elements(document, predicate) {
  const matches = [];
  walk(document, node => {
    if (node.tagName && predicate(node)) matches.push(node);
  });
  return matches;
}

function headingLevels(document) {
  return elements(document, node => /^h[1-6]$/.test(node.tagName))
    .map(node => Number(node.tagName.slice(1)));
}

function splitSelectorList(selector) {
  const members = [];
  let current = '';
  let depth = 0;
  for (const character of selector) {
    if (character === '(') depth += 1;
    if (character === ')') depth -= 1;
    if (character === ',' && depth === 0) {
      members.push(current.trim());
      current = '';
    } else {
      current += character;
    }
  }
  if (current.trim()) members.push(current.trim());
  return members.flatMap(member => {
    const where = member.match(/^:where\(([\s\S]*)\)$/);
    return where ? splitSelectorList(where[1]) : [member];
  });
}

function accessibleName(node, document) {
  const aria = attribute(node, 'aria-label');
  if (aria?.trim()) return aria.trim();
  const ownText = textContent(node);
  if (ownText) return ownText;
  const title = attribute(node, 'title');
  if (title?.trim()) return title.trim();
  const id = attribute(node, 'id');
  if (!id) return '';
  const label = elements(document, candidate =>
    candidate.tagName === 'label' && attribute(candidate, 'for') === id)[0];
  return label ? textContent(label) : '';
}

function renderedLayout(source) {
  return source
    .replace('{{TITLE}}', 'Contract page')
    .replace('{{DESCRIPTION}}', 'Contract fixture')
    .replace('{{HEAD_SEO}}', '<meta name="robots" content="index,follow">')
    .replace('{{MAIN_CLASS}}', 'world-main-page')
    .replace('{{NAV}}', '<nav aria-label="World"><a href="/world/">World</a></nav>')
    .replace('{{CONTENT}}', '<section><h1>Contract page</h1><p>Safe content.</p></section>');
}

async function loadShells() {
  const [landing, dashboard, worldIndex, layout] = await Promise.all([
    fs.readFile(path.join(ROOT, 'public/landing.html'), 'utf8'),
    fs.readFile(path.join(ROOT, 'public/index.html'), 'utf8'),
    fs.readFile(path.join(ROOT, 'world/index.html'), 'utf8'),
    fs.readFile(path.join(ROOT, 'world/layout.html'), 'utf8'),
  ]);
  return new Map([
    ['landing', parse5.parse(landing)],
    ['dashboard', parse5.parse(dashboard)],
    ['world index', parse5.parse(worldIndex)],
    ['world layout', parse5.parse(renderedLayout(layout))],
  ]);
}

async function loadCssRoots() {
  const files = [
    'public/css/style.css',
    'world/css/theme.css',
    'public/landing.html',
    'world/index.html',
    'world/layout.html',
    'world/pages/home.html',
  ];
  const roots = [];
  for (const relativePath of files) {
    const source = await fs.readFile(path.join(ROOT, relativePath), 'utf8');
    if (relativePath.endsWith('.css')) {
      roots.push({ relativePath, root: postcss.parse(source, { from: relativePath }) });
      continue;
    }
    const document = parse5.parse(source);
    const styles = elements(document, node => node.tagName === 'style');
    for (const [index, style] of styles.entries()) {
      roots.push({
        relativePath: `${relativePath}#style-${index + 1}`,
        root: postcss.parse(textContent(style), { from: relativePath }),
      });
    }
  }
  return roots;
}

test('each delivered shell has one valid skip target and a hierarchical single h1', async () => {
  // Mutations caught: remove a skip link/target, add a second h1, or restore landing h3 cards.
  const shells = await loadShells();
  for (const [name, document] of shells) {
    const skipLinks = elements(document, node =>
      node.tagName === 'a' && attribute(node, 'href') === '#main-content');
    const targets = elements(document, node => attribute(node, 'id') === 'main-content');
    assert.equal(skipLinks.length, 1, `${name}: skip links`);
    assert.equal(textContent(skipLinks[0]), 'Skip to main content', `${name}: skip label`);
    assert.equal(targets.length, 1, `${name}: skip target`);
    assert.equal(targets[0].tagName, 'main', `${name}: target landmark`);

    const levels = headingLevels(document);
    assert.equal(levels.filter(level => level === 1).length, 1, `${name}: h1 count`);
    for (let index = 1; index < levels.length; index += 1) {
      assert.ok(levels[index] <= levels[index - 1] + 1,
        `${name}: h${levels[index - 1]} must not jump to h${levels[index]}`);
    }
  }
});

test('static controls, decorative icons, statuses, and errors expose accessible semantics', async () => {
  // Mutations caught: remove a control name, icon aria-hidden, live status, or alert role.
  const shells = await loadShells();
  for (const [name, document] of shells) {
    const controls = elements(document, node =>
      ['button', 'input', 'select', 'textarea'].includes(node.tagName));
    const unnamed = controls.filter(node => !accessibleName(node, document));
    assert.deepEqual(unnamed.map(node => `${node.tagName}#${attribute(node, 'id') || ''}`), [],
      `${name}: unnamed controls`);
  }

  const dashboard = shells.get('dashboard');
  const lucideIcons = elements(dashboard, node =>
    node.tagName === 'i' && attribute(node, 'data-lucide'));
  assert.ok(lucideIcons.length > 20, 'dashboard fixture exercises decorative icons');
  assert.deepEqual(lucideIcons.filter(node => attribute(node, 'aria-hidden') !== 'true')
    .map(node => attribute(node, 'data-lucide')), []);

  const dashboardSource = await fs.readFile(path.join(ROOT, 'public/index.html'), 'utf8');
  const dynamicLucideIcons = [...dashboardSource.matchAll(/this\.innerHTML='([^']*data-lucide[^']*)'/g)]
    .map(match => match[1]);
  assert.ok(dynamicLucideIcons.length >= 2, 'dashboard fixture exercises transient icons');
  assert.deepEqual(dynamicLucideIcons.filter(icon => !icon.includes('aria-hidden=&quot;true&quot;')), []);

  const landing = shells.get('landing');
  const landingGraphics = elements(landing, node => node.tagName === 'svg');
  assert.ok(landingGraphics.length >= 4);
  assert.deepEqual(landingGraphics.filter(node => attribute(node, 'aria-hidden') !== 'true'), []);

  for (const id of ['connectionStatus', 'dashboardStatus', 'replayStatus']) {
    const status = elements(dashboard, node => attribute(node, 'id') === id)[0];
    assert.equal(attribute(status, 'aria-live'), 'polite', id);
  }
  const freshness = elements(landing, node => attribute(node, 'id') === 'stat-last-build')[0];
  assert.equal(attribute(freshness, 'aria-live'), 'polite');
  const error = elements(dashboard, node => attribute(node, 'id') === 'dashboardError')[0];
  assert.equal(attribute(error, 'role'), 'alert');
});

test('embedded content and transient updates have names without exposing decorative canvases', async () => {
  // Mutations caught: remove the iframe title, status semantics, or decorative-canvas hiding.
  const shells = await loadShells();
  const dashboard = shells.get('dashboard');
  const frame = elements(dashboard, node => node.tagName === 'iframe')[0];
  assert.equal(attribute(frame, 'title'), 'AI-built world preview');
  for (const id of ['achievementPopup', 'reconnectToast']) {
    const status = elements(dashboard, node => attribute(node, 'id') === id)[0];
    assert.equal(attribute(status, 'role'), 'status', id);
    assert.equal(attribute(status, 'aria-live'), 'polite', id);
  }
  for (const name of ['world index', 'world layout']) {
    const canvases = elements(shells.get(name), node => node.tagName === 'canvas');
    assert.ok(canvases.length >= 1, `${name}: canvas fixture`);
    assert.deepEqual(canvases.filter(node => attribute(node, 'aria-hidden') !== 'true'), [], name);
  }
  const chaos = elements(shells.get('world layout'), node => attribute(node, 'id') === 'chaosBanner')[0];
  assert.equal(attribute(chaos, 'role'), 'status');
  assert.equal(attribute(chaos, 'aria-live'), 'polite');
});

test('reachable CSS provides focus, touch, and reduced-motion behavior without broad transitions', async () => {
  // Mutations caught: restore any of the 4 outline:none / 24 transition:all declarations,
  // remove the 2px focus ring, 44px mobile sizing, or reduced-motion fallbacks.
  const roots = await loadCssRoots();
  const forbidden = [];
  let hasTwoPixelFocus = false;
  let reducedMotionBlocks = 0;
  const mobileTouchSelectors = new Map();

  for (const { relativePath, root } of roots) {
    root.walkDecls(declaration => {
      const property = declaration.prop.toLowerCase();
      const value = declaration.value.trim().toLowerCase();
      if (property === 'outline' && value === 'none') forbidden.push(`${relativePath}: outline:none`);
      if (property === 'transition' && /^all(?:\s|$)/.test(value)) {
        forbidden.push(`${relativePath}: transition:${value}`);
      }
      const selector = declaration.parent?.selector || '';
      if (selector.includes(':focus-visible') && property === 'outline' && /(?:^|\s)2px(?:\s|$)/.test(value)) {
        hasTwoPixelFocus = true;
      }
    });
    root.walkAtRules('media', atRule => {
      if (/prefers-reduced-motion\s*:\s*reduce/i.test(atRule.params)) reducedMotionBlocks += 1;
      if (!/max-width/i.test(atRule.params)) return;
      atRule.walkRules(rule => {
        const declarations = Object.fromEntries(rule.nodes
          .filter(node => node.type === 'decl')
          .map(node => [node.prop.toLowerCase(), node.value.trim().toLowerCase()]));
        if (declarations['min-width'] === '44px' && declarations['min-height'] === '44px') {
          const selectors = mobileTouchSelectors.get(relativePath) || [];
          selectors.push(rule.selector);
          mobileTouchSelectors.set(relativePath, selectors);
        }
      });
    });
  }

  assert.deepEqual(forbidden, []);
  assert.equal(hasTwoPixelFocus, true);
  const requiredMobileTargets = new Map([
    ['public/css/style.css', ['a', 'button', 'input:not([type="checkbox"])', 'select', 'textarea',
      '[role="button"]', '.checkbox-label']],
    ['public/landing.html#style-1', ['a', 'button']],
    ['world/css/theme.css', ['a', 'button', 'input', 'select', 'textarea', '[role="button"]']],
    ['world/index.html#style-1', ['.toc-link', '.vote-btn']],
    ['world/pages/home.html#style-1', ['.toc-link', '.vote-btn']],
  ]);
  for (const [surface, targets] of requiredMobileTargets) {
    const selectors = mobileTouchSelectors.get(surface) || [];
    const exactMembers = new Set(selectors.flatMap(splitSelectorList));
    for (const target of targets) {
      assert.equal(exactMembers.has(target), true,
        `${surface}: missing 44x44 contract for ${target}`);
    }
  }
  assert.ok(reducedMotionBlocks >= 5, `reduced-motion blocks: ${reducedMotionBlocks}`);

  const baseline = postcss.parse(`
    a { outline: none; transition: all .2s; }
    button { outline: none; transition: all .2s; }
    input { outline: none; transition: all .2s; }
    select { outline: none; transition: all .2s; }
    ${Array.from({ length: 20 }, (_, index) => `.legacy-${index}{transition:all .2s}`).join('\n')}
  `);
  let outlineNone = 0;
  let transitionAll = 0;
  baseline.walkDecls(declaration => {
    if (declaration.prop === 'outline' && declaration.value === 'none') outlineNone += 1;
    if (declaration.prop === 'transition' && declaration.value.startsWith('all')) transitionAll += 1;
  });
  assert.deepEqual({ outlineNone, transitionAll }, { outlineNone: 4, transitionAll: 24 });
});

test('dark surfaces, skip links, headings, and overlays retain interaction-safe CSS', async () => {
  // Mutations caught: remove dark color-scheme, focus-visible skip behavior, touch handling,
  // balanced headings, modal overscroll containment, or SVG transform-box semantics.
  const roots = await loadCssRoots();
  const byPath = new Map(roots.map(entry => [entry.relativePath, entry.root]));
  for (const surface of ['public/css/style.css', 'public/landing.html#style-1', 'world/css/theme.css']) {
    const root = byPath.get(surface);
    let colorScheme = false;
    let touchManipulation = false;
    let balancedHeadings = false;
    let skipFocusVisible = false;
    root.walkDecls(declaration => {
      const selector = declaration.parent?.selector || '';
      if (declaration.prop === 'color-scheme' && declaration.value.trim() === 'dark') colorScheme = true;
      if (declaration.prop === 'touch-action' && declaration.value.trim() === 'manipulation') touchManipulation = true;
      if (/h1/.test(selector) && declaration.prop === 'text-wrap' && declaration.value.trim() === 'balance') {
        balancedHeadings = true;
      }
      if (selector.includes('.skip-link:focus-visible')) skipFocusVisible = true;
    });
    assert.equal(colorScheme, true, `${surface}: color-scheme`);
    assert.equal(touchManipulation, true, `${surface}: touch-action`);
    assert.equal(balancedHeadings, true, `${surface}: heading balance`);
    assert.equal(skipFocusVisible, true, `${surface}: skip focus-visible`);
  }

  let modalOverscroll = false;
  byPath.get('public/css/style.css').walkDecls(declaration => {
    if (declaration.parent?.selector === '.modal' && declaration.prop === 'overscroll-behavior' &&
        declaration.value.trim() === 'contain') modalOverscroll = true;
  });
  assert.equal(modalOverscroll, true);

  const landing = byPath.get('public/landing.html#style-1');
  const transformBoxSelectors = new Set();
  landing.walkDecls(declaration => {
    if (declaration.prop === 'transform-box' && declaration.value.trim() === 'fill-box') {
      transformBoxSelectors.add(declaration.parent?.selector);
    }
  });
  assert.deepEqual([...transformBoxSelectors].sort(), ['.hex-inner', '.hex-outer']);
});

test('World activity rows can shrink and wrap long public file paths on mobile', async () => {
  // Mutation caught: removing min-width, wrapping, or anywhere-breaking recreates the 19px
  // horizontal overflow observed at the 375px browser gate.
  const roots = await loadCssRoots();
  const byPath = new Map(roots.map(entry => [entry.relativePath, entry.root]));
  for (const surface of ['world/index.html#style-1', 'world/pages/home.html#style-1']) {
    const declarations = new Map();
    byPath.get(surface).walkRules(rule => {
      if (!['.activity-content', '.activity-header', '.activity-file'].includes(rule.selector)) return;
      declarations.set(rule.selector, {
        ...(declarations.get(rule.selector) || {}),
        ...Object.fromEntries(rule.nodes
          .filter(node => node.type === 'decl')
          .map(node => [node.prop, node.value.trim()])),
      });
    });
    assert.equal(declarations.get('.activity-content')?.['min-width'], '0', surface);
    assert.equal(declarations.get('.activity-header')?.['flex-wrap'], 'wrap', surface);
    assert.equal(declarations.get('.activity-file')?.['overflow-wrap'], 'anywhere', surface);
  }
});

test('generic World pages clear the fixed navigation without shifting the home hero', async () => {
  // Mutation caught: removing the page-only top padding lets the fixed nav cover a generic h1.
  const shells = await loadShells();
  const layoutMain = elements(shells.get('world layout'), node => attribute(node, 'id') === 'main-content')[0];
  assert.match(attribute(layoutMain, 'class') || '', /\bworld-main-page\b/);

  const roots = await loadCssRoots();
  const layoutCss = roots.find(entry => entry.relativePath === 'world/layout.html#style-1').root;
  const declarations = {};
  layoutCss.walkRules(rule => {
    if (rule.selector !== '.world-main-page') return;
    for (const declaration of rule.nodes.filter(node => node.type === 'decl')) {
      declarations[declaration.prop] = declaration.value.trim();
    }
  });
  assert.equal(declarations['padding-top'], '5rem');
});

test('timeline versions render as named native buttons with keyboard activation', () => {
  // Mutation caught: restoring click-only div markers removes native keyboard semantics.
  const dashboard = Object.create(AIBuildsDashboard.prototype);
  dashboard.escapeHtml = value => String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  const markup = dashboard.renderTimelineVersions([
    { agent_name: 'KeyboardBuilder', action: 'create' },
    { agent_name: 'KeyboardCritic', action: 'edit' },
  ]);
  const fragment = parse5.parseFragment(markup);
  const versions = elements(fragment, node =>
    (attribute(node, 'class') || '').split(/\s+/).includes('timeline-version'));
  assert.equal(versions.length, 2);
  assert.deepEqual(versions.map(node => node.tagName), ['button', 'button']);
  assert.deepEqual(versions.map(node => attribute(node, 'type')), ['button', 'button']);
  assert.ok(versions.every(node => accessibleName(node, fragment)));
});

test('World analytics loads top-level only and stays absent from the opaque iframe sandbox', async () => {
  // Mutation caught: restoring the unconditional external script recreates the localStorage SecurityError.
  const source = await fs.readFile(path.join(ROOT, 'world/layout.html'), 'utf8');
  const document = parse5.parse(source);
  const externalAnalytics = elements(document, node =>
    node.tagName === 'script' && /analytics\.codevena\.dev/.test(attribute(node, 'src') || ''));
  assert.equal(externalAnalytics.length, 0);
  const loader = elements(document, node =>
    node.tagName === 'script' && attribute(node, 'data-analytics-src'))[0];
  assert.ok(loader, 'guarded analytics loader');

  const execute = ({ topLevel, origin = 'https://aibuilds.dev', hostname = 'aibuilds.dev' }) => {
    const appended = [];
    const window = {};
    window.top = topLevel ? window : {};
    window.origin = origin;
    window.location = { hostname };
    const currentScript = {
      dataset: {
        analyticsSrc: attribute(loader, 'data-analytics-src'),
        websiteId: attribute(loader, 'data-website-id'),
      },
    };
    const document = {
      currentScript,
      createElement: () => ({ dataset: {} }),
      head: { appendChild: script => appended.push(script) },
    };
    vm.runInNewContext(textContent(loader), { window, document });
    return appended;
  };

  assert.equal(execute({ topLevel: false }).length, 0, 'nested iframe must not load analytics');
  assert.equal(execute({ topLevel: true, origin: 'null' }).length, 0,
    'opaque sandbox must not load analytics even if the host reports it as top-level');
  assert.equal(execute({ topLevel: true, hostname: '127.0.0.1' }).length, 0,
    'local browser QA must not emit third-party analytics errors');
  const topLevelScripts = execute({ topLevel: true });
  assert.equal(topLevelScripts.length, 1);
  assert.equal(topLevelScripts[0].src, 'https://analytics.codevena.dev/script.js');
});
