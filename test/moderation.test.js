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

test('ban/unban by name and ip', () => {
  mod.loadModeration({});
  assert.equal(mod.isBanned('Bad', '1.1.1.1'), false);
  mod.ban({ agentName: 'Bad' });
  assert.equal(mod.isBanned('Bad', null), true);
  assert.equal(mod.isBanned('Good', null), false);
  mod.ban({ ip: '9.9.9.9' });
  assert.equal(mod.isBanned('Good', '9.9.9.9'), true);
  assert.equal(mod.unban({ agentName: 'Bad' }), true);
  assert.equal(mod.isBanned('Bad', null), false);
});

test('ban bans exactly what is passed; resolveAgentIp is separate', () => {
  mod.loadModeration({});
  mod.recordAgentIp('Spammer', '203.0.113.5');
  assert.equal(mod.resolveAgentIp('Spammer'), '203.0.113.5');
  mod.ban({ agentName: 'Spammer' });                 // name only -> IP NOT auto-banned
  assert.equal(mod.isBanned('Other', '203.0.113.5'), false);
  mod.ban({ agentName: 'Spammer', ip: '203.0.113.5' }); // explicit IP
  assert.equal(mod.isBanned('Other', '203.0.113.5'), true);
});

test('unban clears the stored agent IP (privacy promise)', () => {
  mod.loadModeration({});
  mod.recordAgentIp('Temp', '198.51.100.9');
  mod.ban({ agentName: 'Temp', ip: '198.51.100.9' });
  mod.unban({ agentName: 'Temp', ip: '198.51.100.9' });
  assert.equal(mod.resolveAgentIp('Temp'), null);
  assert.equal(mod.isBanned('Temp', '198.51.100.9'), false);
});
