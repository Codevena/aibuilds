const { test } = require('node:test');
const assert = require('node:assert');
const mod = require('../server/moderation.js');

test('hide/unhide/isHidden with path normalization', () => {
  mod.loadModeration({});
  assert.equal(mod.isHidden('sections/x.html'), false);
  assert.equal(mod.hide('sections/x.html'), true);   // returns true when newly added
  assert.equal(mod.isHidden('sections/x.html'), true);
  // normalization: leading slash, "world/" prefix, backslashes, case all match the same entry
  assert.equal(mod.isHidden('/world/Sections/X.html'), true);
  assert.equal(mod.isHidden('sections\\x.html'), true);
  assert.equal(mod.hide('sections/x.html'), false);   // already hidden -> false
  assert.equal(mod.unhide('sections/x.html'), true);
  assert.equal(mod.isHidden('sections/x.html'), false);
});

test('serialize/load round-trip', () => {
  mod.loadModeration({});
  mod.hide('sections/a.html');
  const snap = mod.serializeModeration();
  assert.deepEqual(snap.moderation.hiddenFiles, ['sections/a.html']);
  mod.loadModeration({});
  assert.equal(mod.isHidden('sections/a.html'), false);
  mod.loadModeration(snap);                 // re-hydrate from a serialized snapshot
  assert.equal(mod.isHidden('sections/a.html'), true);
});
