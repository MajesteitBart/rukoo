'use strict';

// Rukoo's side of the Voice bridge protocol against the examples Voice's Rust tests read too
// (voice/fixtures/protocol-vectors.json, read where it is, not from a copy).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { validate, validateDiscovery, negotiate, replayPlan, PROTOCOL, MEDIA_KINDS, MEDIA_ID, MEDIA_SPAN_MAX, MEDIA_READ_MAX } = require('../src/main/voice/protocol');
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

test('the screen commands and screenDefault have the limits Voice checks', () => {
  const meeting = 'm-20261030-171203-4f2a';
  const command = (name, args) => validate('rukoo', { type: 'command', id: 'c-1', command: name, args });
  assert.equal(command('clip.get', { meeting, start: 5, end: 5 }).ok, true);
  assert.deepEqual(command('clip.get', { meeting, start: 6, end: 5 }), { ok: false, reason: 'end' });
  // A monitor id counts characters, as Voice does: 64 emoji fit, 65 letters don't.
  assert.equal(command('screen.select', { meeting, monitor: '😀'.repeat(64) }).ok, true);
  assert.deepEqual(command('screen.select', { meeting, monitor: 'm'.repeat(65) }), { ok: false, reason: 'monitor' });
  assert.deepEqual(command('meeting.protected', { meeting: 'meeting-1' }), { ok: false, reason: 'meeting' });

  const status = (data) => validate('voice', { type: 'event', seq: 5, event: 'status', createdAt: 0, data });
  // An older Voice leaves screenDefault out; null counts as left out.
  assert.equal(status({ recording: null, dictating: false }).ok, true);
  assert.equal(status({ recording: null, dictating: false, screenDefault: null }).ok, true);
  const starting = { type: 'event', seq: 5, event: 'meeting.starting', meeting, createdAt: 0, data: {} };
  assert.deepEqual(validate('voice', starting), { ok: false, reason: 'screen' });
});

test('media.open takes a range of an hour at most and checks its fields in Voice\'s order', () => {
  assert.deepEqual(MEDIA_KINDS, ['audio', 'frame', 'video']);
  assert.equal(MEDIA_SPAN_MAX, 3600000);
  const meeting = 'm-20261030-171203-4f2a';
  const open = (args) => validate('rukoo', { type: 'command', id: 'c-1', command: 'media.open', args });
  const reason = (args) => open(args).reason;
  assert.equal(open({ meeting, kind: 'audio', start: 600000, end: 1200000 }).ok, true);
  assert.equal(open({ meeting, kind: 'frame', start: 412500 }).ok, true);
  assert.equal(open({ meeting, kind: 'frame', start: 0, end: null }).ok, true);
  // An empty range and exactly an hour pass; the 300 s video cap is Voice's answer, not a check.
  assert.equal(open({ meeting, kind: 'audio', start: 5000, end: 5000 }).ok, true);
  assert.equal(open({ meeting, kind: 'video', start: 0, end: MEDIA_SPAN_MAX }).ok, true);
  assert.equal(reason({ meeting, kind: 'audio', start: 1, end: MEDIA_SPAN_MAX + 2 }), 'end');
  assert.equal(reason({ meeting, kind: 'audio', start: 5000, end: 4999 }), 'end');
  assert.equal(reason({ meeting, kind: 'audio', start: 0, end: 1.5 }), 'end');
  assert.equal(reason({ meeting, kind: 'audio', start: -1, end: 10 }), 'start');
  assert.equal(reason({ meeting, kind: 'audio', start: '0' }), 'start');
  assert.equal(reason({ meeting, kind: 'Audio', start: 0 }), 'kind');
  assert.equal(reason({ meeting: 'm-1', kind: 'x', end: 1 }), 'meeting');
  assert.equal(reason({ meeting, end: 1 }), 'kind');
  assert.equal(reason({ meeting, kind: 'audio', end: -1 }), 'start');
});

test('media.read reads one mebibyte at most from a media id', () => {
  assert.equal(MEDIA_READ_MAX, 1048576);
  const media = 'md-a1B2c3D4e5F6g7H8i9J0kL';
  const read = (args) => validate('rukoo', { type: 'command', id: 'c-1', command: 'media.read', args });
  const reason = (args) => read(args).reason;
  assert.equal(read({ media, offset: 0, length: 1 }).ok, true);
  assert.equal(read({ media, offset: 2 ** 40, length: MEDIA_READ_MAX }).ok, true);
  assert.equal(reason({ media, offset: 0, length: 0 }), 'length');
  assert.equal(reason({ media, offset: 0, length: MEDIA_READ_MAX + 1 }), 'length');
  assert.equal(reason({ media, offset: 0 }), 'length');
  assert.equal(reason({ media, offset: -1, length: 1 }), 'offset');
  assert.equal(reason({ media, offset: null, length: 1 }), 'offset');
  for (const id of ['md-short', 'MD-a1B2c3D4e5F6g7H8i9J0kL', 'md-a1B2c3D4e5F6g7H8i9J0k+', 'md-a1B2c3D4e5F6g7H8i9J0kLx', 'a1B2c3D4e5F6g7H8i9J0kL', 5]) {
    assert.equal(reason({ media: id, offset: 0, length: 1 }), 'media', String(id));
    if (typeof id === 'string') assert.equal(MEDIA_ID.test(id), false, id);
  }
  assert.equal(MEDIA_ID.test(media), true);
  assert.equal(reason({ offset: -1, length: 0 }), 'media');
  assert.equal(reason({ media, offset: -1, length: 0 }), 'offset');
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
