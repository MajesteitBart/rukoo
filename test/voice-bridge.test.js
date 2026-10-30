'use strict';

// The Voice bridge client and the service around it, against the hand-written fake Voice in
// test/fixtures/voice-server.js: hello and welcome, replay after the cursor, a gap and meeting.get, a new Voice
// data folder, command timeouts, a connection cut halfway through a message, stale and changed discovery files, and
// hiding the windows before a meeting starts.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { tempDir } = require('./tmp');
const { startVoiceServer } = require('./fixtures/voice-server');
const { VoiceBridge } = require('../src/main/voice/bridge');
const { VoiceService } = require('../src/main/voice');

const M1 = 'm-20261030-090000-0a1b';
const M2 = 'm-20261030-100000-0c2d';
const FAST = { backoffMs: [30], pollMs: 50, heartbeatMs: 0 };

async function until(check, what, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 15));
  }
}

const started = (title, at = Date.now()) => ({ title, startedAt: at, tracks: ['mic', 'call'], screen: 'off', startedBy: 'voice', context: null });
const passage = (track, start, text, revision = 1, extra = {}) => ({ id: `${track}-${String(start).padStart(9, '0')}`, track, speaker: track === 'mic' ? 'mic' : 'call-1', start, end: start + 2000, text, revision, dictation: false, language: 'en', ...extra });

async function setup(t, opts = {}) {
  const dir = tempDir('rukoo-voice-bridge-');
  const file = path.join(dir, 'voice-bridge.json');
  const voice = await startVoiceServer({ file, ...opts });
  t.after(() => voice.close());
  return { dir, file, voice };
}

function service(t, dir, file, extra = {}) {
  const protects = [];
  const s = new VoiceService({
    dataDir: path.join(dir, 'data'),
    discovery: file,
    appVersion: '9.9.9',
    hide: () => true,
    protect: (on) => protects.push({ on, at: Date.now() }),
    bridge: FAST,
    emitMs: 10,
    ...extra
  });
  s.protects = protects;
  t.after(() => s.close());
  return s;
}

// A process id that was in use a moment ago and is free now.
function deadPid() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    child.on('exit', () => resolve(child.pid));
  });
}

test('the first hello carries the token, no cursor and no Origin, and the welcome connects', async (t) => {
  const { file, voice } = await setup(t);
  voice.writeDiscovery();
  const bridge = new VoiceBridge({ file, clientVersion: '2.2.0', ...FAST }).start();
  t.after(() => bridge.close());
  const welcome = await new Promise((resolve) => bridge.once('welcome', resolve));
  assert.equal(welcome.instance, voice.instance);
  assert.equal(welcome.replay, 'full');
  assert.deepEqual(voice.hellos[0], { type: 'hello', protocol: 1, token: voice.token, client: 'rukoo', clientVersion: '2.2.0', instance: null, after: 0 });
  assert.equal(voice.upgrades[0].url, '/bridge');
  assert.equal(voice.upgrades[0].headers.origin, undefined, "Rukoo's main process sends no Origin");
  assert.equal(bridge.state().status, 'connected');
  assert.equal(bridge.state().voiceVersion, '0.1.0');
  const status = await bridge.command('status.get');
  assert.deepEqual(status, { recording: null, dictating: false });
});

test('the fake Voice refuses a page that names an http Origin, as Voice does', async (t) => {
  const { voice } = await setup(t);
  const code = await new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: voice.port, path: '/bridge', headers: { Connection: 'Upgrade', Upgrade: 'websocket', Origin: 'https://evil.example', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version': '13' } });
    req.on('response', (res) => resolve(res.statusCode));
    req.on('upgrade', () => resolve(101));
    req.on('error', () => resolve('error'));
    req.end();
  });
  assert.equal(code, 403);
});

test('after a restart Rukoo asks for what came after the last event it applied, and gets only that', async (t) => {
  const { dir, file, voice } = await setup(t);
  voice.writeDiscovery();
  voice.append('meeting.started', M1, started('Weekly'));
  voice.append('passage', M1, passage('call', 1000, 'First.'));
  const first = service(t, dir, file).init();
  await until(() => first.store.cursor().after === 2, 'the first replay');
  first.close();
  assert.equal(first.bridge.connected, false);
  // Voice records on while Rukoo is closed.
  voice.append('passage', M1, passage('call', 4000, 'Second.'));
  voice.append('passage', M1, passage('call', 1000, 'First, again.', 2));
  const second = service(t, dir, file).init();
  await until(() => second.store.cursor().after === 4, 'the second replay');
  const hello = voice.hellos.at(-1);
  assert.equal(hello.instance, voice.instance);
  assert.equal(hello.after, 2);
  const m = second.get(M1);
  assert.deepEqual(m.passages.map((p) => [p.text, p.revision]), [['First, again.', 2], ['Second.', 1]]);
  assert.equal(m.meeting.title, 'Weekly');
});

test('a gap: Rukoo asks meeting.get for the meetings it has that may still change, and drops one Voice no longer has', async (t) => {
  const { dir, file, voice } = await setup(t);
  voice.writeDiscovery();
  voice.append('meeting.started', M1, started('Kept'));
  voice.append('meeting.started', M2, started('Deleted'));
  const s1 = service(t, dir, file).init();
  await until(() => s1.store.cursor().after === 2, 'the first replay');
  s1.close();
  for (let i = 0; i < 6; i++) voice.append('status', null, { recording: null, dictating: false });
  // Events Rukoo never saw are gone already.
  voice.forget(6);
  const snap = {
    meeting: { id: M1, ...started('Kept'), state: 'done', endedAt: Date.now() },
    speakers: [{ id: 'call-1', track: 'call', label: 'Speaker 1' }],
    passages: [passage('call', 1000, 'From the snapshot.', 3)],
    marks: [],
    head: voice.head
  };
  voice.handlers['meeting.get'] = (args) => (args.meeting === M1 ? snap : { error: { code: 'not_found', message: 'No such meeting.' } });
  const s2 = service(t, dir, file).init();
  await until(() => voice.commands.filter((c) => c.command === 'meeting.get').length === 2, 'two meeting.get');
  await until(() => !s2.store.entry(M2), 'the deleted meeting to go');
  assert.deepEqual(new Set(voice.commands.map((c) => c.args.meeting)), new Set([M1, M2]));
  const m = s2.get(M1);
  assert.equal(m.meeting.state, 'done');
  assert.deepEqual(m.passages.map((p) => p.text), ['From the snapshot.']);
  assert.equal(m.speakers[0].label, 'Speaker 1');
  assert.equal(s2.store.cursor().after, voice.head);
});

test("a meeting.get answer doesn't undo the meeting's events past its head that Voice sent before it", async (t) => {
  const { dir, file, voice } = await setup(t);
  voice.writeDiscovery();
  const at = Date.now();
  voice.append('meeting.started', M1, started('Racing', at));
  voice.append('passage', M1, passage('call', 1000, 'Before the head.'));
  const s1 = service(t, dir, file).init();
  await until(() => s1.store.cursor().after === 2, 'the first replay');
  s1.close();
  for (let i = 0; i < 3; i++) voice.append('status', null, { recording: null, dictating: false });
  voice.forget(5);
  // Voice reads the snapshot at its head, and the transcript goes on: those events go out before the answer.
  voice.handlers['meeting.get'] = function () {
    const head = this.head;
    this.append('passage', M1, passage('call', 4000, 'After the head.'));
    this.append('meeting.state', M1, { state: 'processing', at: 5000, endedAt: at + 5000, reason: 'user' });
    return { meeting: { id: M1, ...started('Racing', at), state: 'recording', endedAt: null }, speakers: [], passages: [passage('call', 1000, 'Before the head.')], marks: [], head };
  };
  const s2 = service(t, dir, file);
  let refetched = false;
  s2.on('meeting', (p) => {
    if (p.kind === 'list') refetched = true;
  });
  s2.init();
  await until(() => refetched, 'the snapshot');
  const m = s2.get(M1);
  assert.deepEqual(m.passages.map((p) => p.text), ['Before the head.', 'After the head.']);
  assert.equal(m.meeting.state, 'processing');
  assert.equal(s2.store.cursor().after, voice.head);
});

test('a title or label cut at its limit never ends in half an emoji, which Voice could not read', async (t) => {
  const { dir, file, voice } = await setup(t);
  voice.writeDiscovery();
  const s = service(t, dir, file, { hide: () => false }).init();
  await until(() => s.connected, 'the connection');
  const sent = [];
  const onText = voice.onText.bind(voice);
  voice.onText = (peer, text) => {
    sent.push(text);
    return onText(peer, text);
  };
  const emoji = '\u{1F600}';
  const first = await s.start({ title: `${'a'.repeat(199)}${emoji} and more` });
  await s.mark(first.meetingId, `${'b'.repeat(199)}${emoji}${emoji}`);
  await s.stop(first.meetingId);
  // main cuts in UTF-16 units first, which can leave the first half of an emoji at the end.
  await s.start({ title: `${emoji.repeat(149)}${emoji[0]}` });
  const args = voice.commands.filter((c) => c.command === 'meeting.start' || c.command === 'meeting.mark').map((c) => c.args.title || c.args.label);
  assert.deepEqual(args, [`${'a'.repeat(199)}${emoji}`, `${'b'.repeat(199)}${emoji}`, emoji.repeat(149)]);
  assert.equal(sent.length, 4);
  for (const text of sent) assert.doesNotMatch(text, /\\ud[89a-f][0-9a-f]{2}/i, 'no lone surrogate goes out');
});

test('a new Voice data folder: the cursor starts again from its first event, and Rukoo keeps the meetings it had', async (t) => {
  const { dir, file, voice } = await setup(t);
  voice.writeDiscovery();
  voice.append('meeting.started', M1, started('Old folder'));
  voice.append('passage', M1, passage('mic', 0, 'Old words.'));
  const s = service(t, dir, file).init();
  const lists = [];
  s.on('meeting', (p) => p.kind === 'list' && lists.push(p));
  await until(() => s.store.cursor().after === 2, 'the first replay');
  const old = voice.instance;
  voice.reset();
  voice.append('meeting.started', M2, started('New folder'));
  voice.drop();
  await until(() => s.store.cursor().instance === voice.instance && s.store.entry(M2), 'the new instance');
  assert.notEqual(voice.instance, old);
  assert.deepEqual(voice.hellos.at(-1), { ...voice.hellos.at(-1), instance: old, after: 2 });
  assert.equal(s.store.cursor().after, 1);
  assert.ok(s.get(M1), 'the old meeting stays');
  assert.equal(lists.length, 1);
});

test('a command Voice never answers fails with timeout, and the connection keeps working', async (t) => {
  const { file, voice } = await setup(t);
  voice.writeDiscovery();
  const bridge = new VoiceBridge({ file, ...FAST }).start();
  t.after(() => bridge.close());
  await until(() => bridge.connected, 'the connection');
  voice.silent.add('meeting.stop');
  const err = await bridge.command('meeting.stop', { meeting: M1 }, { timeoutMs: 80 }).then(() => null, (e) => e);
  assert.equal(err.code, 'timeout');
  assert.deepEqual(await bridge.command('status.get'), { recording: null, dictating: false });
  // An error reply carries Voice's code and meeting.
  voice.status = { recording: M2, dictating: false };
  const busy = await bridge.command('meeting.start', {}).then(() => null, (e) => e);
  assert.equal(busy.code, 'busy');
  assert.equal(busy.meeting, M2);
  // Commands that don't follow the protocol never leave Rukoo.
  const bad = await bridge.command('meeting.stop', {}).then(() => null, (e) => e);
  assert.equal(bad.code, 'bad_request');
});

test('a connection cut halfway through a message comes back, and the replay brings that message once', async (t) => {
  const { dir, file, voice } = await setup(t);
  voice.writeDiscovery();
  voice.append('meeting.started', M1, started('Cut'));
  const s = service(t, dir, file).init();
  await until(() => s.store.cursor().after === 1, 'the first event');
  const pending = s.bridge.command('status.get', {}, { timeoutMs: 5000 });
  voice.silent.add('status.get');
  const e = voice.append('passage', M1, passage('call', 2000, 'Halfway.'), { push: false });
  voice.drop(e);
  const err = await pending.then(() => null, (x) => x);
  assert.equal(err.code, 'offline', 'a command waiting on the dropped socket fails at once');
  await until(() => s.store.cursor().after === e.seq && s.bridge.connected, 'the replay');
  assert.equal(voice.hellos.at(-1).after, 1);
  assert.deepEqual(s.get(M1).passages.map((p) => p.text), ['Halfway.']);
});

test('a stale discovery file is left alone until Voice writes a new one, which connects at once', async (t) => {
  const { file, voice } = await setup(t);
  voice.writeDiscovery({ pid: await deadPid() });
  const bridge = new VoiceBridge({ file, backoffMs: [30000], pollMs: 50, heartbeatMs: 0 }).start();
  t.after(() => bridge.close());
  await until(() => bridge.state().reason === 'stale', 'the stale state');
  assert.equal(bridge.state().status, 'absent');
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(voice.upgrades.length, 0, 'Rukoo never connects to a dead Voice');
  assert.ok(fs.existsSync(file), 'and never deletes its file');
  voice.writeDiscovery();
  await until(() => bridge.connected, 'the connection to the new Voice', 2000);
});

test('Voice started again on another port: the changed file connects at once, without waiting for the backoff', async (t) => {
  const { file, voice } = await setup(t);
  voice.writeDiscovery();
  const bridge = new VoiceBridge({ file, backoffMs: [30000], pollMs: 50, heartbeatMs: 0 }).start();
  t.after(() => bridge.close());
  await until(() => bridge.connected, 'the first connection');
  await voice.close();
  await until(() => !bridge.connected, 'the close');
  const next = await startVoiceServer({ file });
  t.after(() => next.close());
  next.writeDiscovery();
  await until(() => bridge.connected && next.hellos.length === 1, 'the connection to the new Voice', 2000);
  assert.equal(next.hellos[0].token, next.token);
});

test('a missing file, a damaged one and a Voice that speaks only newer versions each say why Rukoo is not connected', async (t) => {
  const { file, voice } = await setup(t);
  const bridge = new VoiceBridge({ file, ...FAST }).start();
  t.after(() => bridge.close());
  assert.deepEqual([bridge.state().status, bridge.state().reason], ['absent', 'missing']);
  fs.writeFileSync(file, '{"port":');
  await until(() => bridge.state().reason === 'invalid', 'the invalid state');
  voice.writeDiscovery({ protocol: 3, minProtocol: 2 });
  await until(() => bridge.state().status === 'incompatible', 'the incompatible state');
  assert.equal(bridge.state().older, 'rukoo');
  assert.equal(voice.upgrades.length, 0);
  const none = new VoiceBridge({ file: null }).start();
  assert.deepEqual([none.state().status, none.state().reason], ['absent', 'none']);
});

test('a bad event is skipped and the ones after it still apply', async (t) => {
  const { dir, file, voice } = await setup(t);
  voice.writeDiscovery();
  voice.append('meeting.started', M1, started('Strict'));
  voice.append('passage', M1, { ...passage('call', 1000, 'Broken'), revision: 0 });
  voice.append('passage', M1, passage('call', 3000, 'Fine.'));
  voice.append('agent.suggestion', M1, { text: 'A newer Voice' });
  const s = service(t, dir, file);
  const invalid = [];
  s.bridge.on('invalid', (x) => invalid.push(x));
  s.init();
  await until(() => s.store.cursor().after === 4, 'the replay');
  assert.deepEqual(invalid, [{ type: 'event', reason: 'revision' }]);
  assert.deepEqual(s.get(M1).passages.map((p) => p.text), ['Fine.']);
});

test('a wrong token keeps Rukoo trying, never connected', async (t) => {
  const { file, voice } = await setup(t);
  voice.writeDiscovery({ token: 'x'.repeat(43) });
  const bridge = new VoiceBridge({ file, ...FAST }).start();
  t.after(() => bridge.close());
  await until(() => voice.hellos.length >= 2, 'a second attempt');
  assert.equal(bridge.connected, false);
  assert.equal(bridge.state().status, 'connecting');
});

test('starting from Rukoo hides the windows first, waits a frame, and they stay hidden until Voice says the meeting ended', async (t) => {
  const { dir, file, voice } = await setup(t);
  voice.writeDiscovery();
  const s = service(t, dir, file);
  const recording = [];
  s.on('recording', (id) => recording.push(id));
  s.init();
  await until(() => s.connected, 'the connection');
  assert.deepEqual(s.protects.map((p) => p.on), [false]);
  // When the command reaches Voice.
  let received = null;
  const onText = voice.onText.bind(voice);
  voice.onText = (peer, text) => {
    if (!received && text.includes('"meeting.start"')) received = Date.now();
    return onText(peer, text);
  };
  const { meetingId } = await s.start({ title: 'Stand-up', eventId: 'acc:cal:evt' });
  const command = voice.commands.find((c) => c.command === 'meeting.start');
  assert.deepEqual(command.args, { title: 'Stand-up', context: { calendarEvent: 'acc:cal:evt' } });
  const on = s.protects.find((p) => p.on);
  assert.ok(on, 'the windows were protected');
  // Protection takes effect with the next composition, so the command waits about 100 ms after it.
  assert.ok(received - on.at >= 90, `${received - on.at} ms between protecting and starting`);
  await until(() => s.store.entry(meetingId), 'the meeting');
  assert.equal(s.get(meetingId).meeting.eventId, 'acc:cal:evt');
  assert.equal(s.state().recording, meetingId);
  // The connection drops mid-meeting: Rukoo still believes it records, so the windows stay hidden.
  voice.drop();
  await until(() => !s.connected, 'the drop');
  assert.equal(s.protects.at(-1).on, true);
  await until(() => s.connected, 'the reconnect');
  await s.stop(meetingId);
  await until(() => s.protects.at(-1).on === false, 'protection to go');
  assert.deepEqual(recording, [meetingId, null]);
  assert.equal(s.get(meetingId).meeting.state, 'processing');
});

test('with the setting off nothing is hidden and nothing waits', async (t) => {
  const { dir, file, voice } = await setup(t);
  voice.writeDiscovery();
  const s = service(t, dir, file, { hide: () => false, protectDelayMs: 5000 });
  s.init();
  await until(() => s.connected, 'the connection');
  const t0 = Date.now();
  await s.start({});
  assert.ok(Date.now() - t0 < 2000);
  assert.ok(s.protects.every((p) => !p.on));
});

test('a meeting Voice started is recording as far as Rukoo knows after a restart without Voice: the windows start hidden', async (t) => {
  const { dir, file, voice } = await setup(t);
  voice.writeDiscovery();
  voice.append('meeting.started', M1, started('Live'));
  voice.append('meeting.state', M1, { state: 'recording', at: 0 });
  const s1 = service(t, dir, file).init();
  await until(() => s1.state().recording === M1, 'the recording');
  s1.close();
  voice.removeDiscovery();
  const s2 = service(t, dir, file).init();
  assert.deepEqual(s2.protects.map((p) => p.on), [true]);
  assert.equal(s2.state().status, 'absent');
});

test('a meeting Voice started: meeting.started, then meeting.state recording, tells the renderer and protects every window', (t) => {
  const dir = tempDir('rukoo-voice-started-');
  const s = service(t, dir, null).init();
  const states = [];
  const recording = [];
  s.on('state', (x) => states.push(x));
  s.on('recording', (id) => recording.push(id));
  assert.deepEqual(s.protects.map((p) => p.on), [false]);
  const now = Date.now();
  s.onEvent({ type: 'event', seq: 1, event: 'meeting.started', meeting: M1, createdAt: now, data: started('From Voice', now) });
  // meeting.started already marks the entry recording, so this event changes only what records now.
  s.onEvent({ type: 'event', seq: 2, event: 'meeting.state', meeting: M1, createdAt: now, data: { state: 'recording', at: 0 } });
  assert.equal(s.state().recording, M1);
  assert.ok(states.some((x) => x.recording === M1), 'a state event told the renderer');
  assert.deepEqual(recording, [M1]);
  assert.equal(s.protects.at(-1).on, true, 'the windows are protected');
  s.onEvent({ type: 'event', seq: 3, event: 'meeting.state', meeting: M1, createdAt: now, data: { state: 'processing', at: 5000, endedAt: now + 5000, reason: 'user' } });
  assert.equal(s.protects.at(-1).on, false);
  assert.deepEqual(recording, [M1, null]);
});

test('without a connection, meeting commands fail with offline', async (t) => {
  const dir = tempDir('rukoo-voice-off-');
  const s = service(t, dir, null).init();
  for (const call of [() => s.start({}), () => s.stop(M1), () => s.mark(M1, 'x'), () => s.frame(M1, 0)]) {
    const err = await call().then(() => null, (e) => e);
    assert.equal(err.code, 'offline');
  }
  assert.deepEqual(s.state(), { status: 'absent', reason: 'none', voiceVersion: null, protocol: null, older: null, recording: null, dictating: false });
});

test('a meeting Voice starts gets the one calendar event that fits, and a 1:1 gets the guest\'s name', async (t) => {
  const dir = tempDir('rukoo-voice-link-');
  const now = Date.now();
  const event = { id: 'acc:cal:e1', title: 'Sanne / Demo', start: now - 60000, end: now + 1740000, meeting: 'https://meet.example.com/x', attendees: [{ name: 'Demo User', address: 'demo@example.com', response: 'accepted', self: true }, { name: 'Sanne', address: 'sanne@example.com', response: 'accepted' }] };
  const calendars = { read: async () => ({ events: [event], failed: [] }), event: (id) => (id === event.id ? event : null) };
  const s = service(t, dir, null, { calendars }).init();
  s.onEvent({ type: 'event', seq: 1, event: 'meeting.started', meeting: M1, createdAt: now, data: started('', now) });
  await until(() => s.get(M1).meeting.eventId === event.id, 'the link');
  assert.deepEqual(s.get(M1).event, { id: event.id, title: 'Sanne / Demo', start: event.start, end: event.end, video: true });
  s.onEvent({ type: 'event', seq: 2, event: 'speaker', meeting: M1, createdAt: now, data: { id: 'call-1', track: 'call', label: 'Speaker 1' } });
  const speakers = s.speakers(M1);
  assert.equal(speakers[0].name, 'Sanne');
  assert.equal(speakers[0].from, 'auto');
  assert.deepEqual(speakers[0].suggestions.map((x) => x.address), ['sanne@example.com']);
  assert.deepEqual((await s.events(M1)).events.map((e) => e.id), [event.id]);
  // The user's own pick replaces it; unlinking keeps the name they gave.
  s.setSpeaker(M1, 'call-1', { name: 'Sanne de Vries', address: 'sanne@example.com' });
  assert.equal(s.setEvent(M1, null)[0].name, 'Sanne de Vries');
  // An old meeting from the first replay isn't worth a calendar read.
  s.onEvent({ type: 'event', seq: 3, event: 'meeting.started', meeting: M2, createdAt: now, data: started('Old', now - 2 * 86400000) });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(s.get(M2).meeting.eventId, null);
});
