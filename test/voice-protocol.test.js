'use strict';

// Rukoo's side of the Voice bridge protocol against the examples Voice's Rust tests read too
// (voice/fixtures/protocol-vectors.json, read where it is, not from a copy).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { validate, validateDiscovery, negotiate, replayPlan, PROTOCOL } = require('../src/main/voice/protocol');
const { bridgePath, bridgePathHere } = require('../src/main/voice/paths');

const VECTORS = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'voice', 'fixtures', 'protocol-vectors.json'), 'utf8'));

test('the vectors describe the version Rukoo speaks', () => {
  assert.equal(VECTORS.protocol, PROTOCOL);
});

test('every valid message is accepted from its sender', () => {
  assert.ok(VECTORS.valid.length > 20);
  for (const v of VECTORS.valid) {
    const res = validate(v.from, v.message);
    assert.equal(res.ok, true, `${v.name}: ${res.reason}`);
  }
});

test('every invalid message is refused for the reason the vector gives', () => {
  for (const v of VECTORS.invalid) {
    const res = validate(v.from, v.message);
    assert.deepEqual({ ok: res.ok, reason: res.reason }, { ok: false, reason: v.reason }, v.name);
  }
});

test('a command without args gets {} and a message from the wrong side is refused', () => {
  const start = VECTORS.valid.find((v) => v.name === 'start a meeting with the defaults');
  assert.deepEqual(validate('rukoo', start.message).message.args, {});
  const welcome = VECTORS.valid.find((v) => v.name === 'welcome');
  assert.deepEqual(validate('rukoo', welcome.message), { ok: false, reason: 'type' });
  assert.deepEqual(validate('voice', 'not an object'), { ok: false, reason: 'type' });
});

test('discovery files are checked by the same rules', () => {
  for (const v of VECTORS.discovery.valid) assert.equal(validateDiscovery(v.file).ok, true, v.name);
  for (const v of VECTORS.discovery.invalid) assert.deepEqual(validateDiscovery(v.file), { ok: false, reason: v.reason }, v.name);
});

test('every path vector, with the separators of its platform', () => {
  for (const v of VECTORS.paths) {
    assert.equal(bridgePath(v.side, v.platform, (name) => v.env[name]), v.expected, v.name);
  }
});

test('this Rukoo uses RUKOO_VOICE_BRIDGE, then its own profile, and never Voice\'s data folder', () => {
  assert.equal(bridgePathHere({ RUKOO_VOICE_BRIDGE: '/pair/bridge.json', SEM_DATA_DIR: '/p' }, 'linux'), '/pair/bridge.json');
  assert.equal(bridgePathHere({ SEM_DATA_DIR: '/p', RUKOO_VOICE_DATA_DIR: '/v' }, 'linux'), '/p/voice-bridge.json');
  // No LOCALAPPDATA: the user's profile folder from the OS.
  assert.match(bridgePathHere({}, 'win32'), /AppData\\Local\\Rukoo Voice\\bridge\.json$/);
});

test('negotiation picks the highest shared version, or none', () => {
  for (const v of VECTORS.negotiation) assert.equal(negotiate(v.rukoo, v.voice), v.expected, v.name);
});

test('the replay plan matches the table', () => {
  for (const v of VECTORS.replay) {
    assert.deepEqual(replayPlan(v.hello.instance, v.hello.after, v.voice.instance, v.voice.head, v.voice.oldest), v.expected, v.name);
  }
});
