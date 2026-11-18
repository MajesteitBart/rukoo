'use strict';

// read_meeting_transcript's lines for the marks only a Mac Voice sends: a call that held only silence while another
// app played, a screen recording that stopped because macOS' screen capture kept stopping, and one that never started
// because Screen Recording was off. macOS CI runs this folder (`node --test "test/macos/*.test.js"`); the rest of the
// meeting tools are in test/agent-tools-meeting.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { tempDir } = require('../tmp');
const { Engine } = require('../../src/main/engine');
const { AgentHub } = require('../../src/main/agents/hub');
const { untag } = require('../../src/main/agents/context');
const { VoiceService } = require('../../src/main/voice');

const M = 'm-20261030-171203-4f2a';
const T0 = Date.now() - 10 * 60 * 1000;
let seq = 0;
const ev = (event, meeting, data) => ({ type: 'event', seq: ++seq, event, ...(meeting ? { meeting } : {}), createdAt: Date.now(), data });
const startedEv = (id = M, extra = {}) => ev('meeting.started', id, { title: 'Weekly with Anna', startedAt: T0, tracks: ['mic', 'call'], screen: 'off', startedBy: 'voice', context: null, ...extra });

// A real voice service with no Voice connected, fed with scripted events, as in test/agent-tools-meeting.test.js.
async function setup(t) {
  const dir = tempDir('rukoo-meeting-tools-mac-');
  const engine = new Engine({ dataDir: dir }).init();
  const voice = new VoiceService({ dataDir: path.join(dir, 'voice'), discovery: null }).init();
  const hub = new AgentHub({ engine, dataDir: dir, deps: { appVersion: '1.0.0', tempDir: path.join(dir, 'agent-tmp'), voice }, adapters: {}, listen: false });
  await hub.start();
  t.after(async () => {
    await hub.dispose();
    voice.close();
    await engine.close();
  });
  const feed = (events) => events.forEach((e) => voice.onEvent(e));
  const call = (name, args = {}) => hub.callTool({ agent: 'claude', conversationId: null, remote: false }, name, args);
  return { feed, call };
}

const data = (res) => {
  assert.ok(!res.isError, res.content && res.content[0].text);
  return res.structuredContent;
};

test('the transcript says when the call held only silence while another app played', async (t) => {
  const { feed, call } = await setup(t);
  feed([
    startedEv(M),
    ev('mark', M, { id: 'silent-call-30', kind: 'silent', at: 30, until: null, track: 'call', detail: null, label: null })
  ]);
  const ended = await setup(t);
  ended.feed([
    startedEv(M),
    ev('mark', M, { id: 'silent-call-30', kind: 'silent', at: 30, until: null, track: 'call', detail: null, label: null }),
    ev('mark', M, { id: 'silent-call-30', kind: 'silent', at: 30, until: 61030, track: 'call', detail: null, label: null })
  ]);
  assert.deepEqual(untag(data(await ended.call('read_meeting_transcript', { meeting_id: M })).transcript).trim().split('\n'), [
    '[00:00:00] [No sound on the call audio for 61 s while another app had its audio output open; then it had sound]'
  ]);
  const res = data(await call('read_meeting_transcript', { meeting_id: M }));
  assert.deepEqual(untag(res.transcript).trim().split('\n'), [
    '[00:00:00] [No sound on the call audio from here while another app had its audio output open; if people were talking, the computer may not have let Rukoo Voice record it]'
  ]);
});

test('the transcript says the screen recording stopped when the screen capture kept stopping', async (t) => {
  const { feed, call } = await setup(t);
  feed([
    startedEv(M, { screen: 'frames' }),
    ev('mark', M, { id: 'dropped-frames', kind: 'dropped', at: 65000, until: null, track: 'screen', detail: 'capture', label: null })
  ]);
  const res = data(await call('read_meeting_transcript', { meeting_id: M }));
  assert.deepEqual(untag(res.transcript).trim().split('\n'), [
    '[00:01:05] [Rukoo Voice stopped recording the screen: the screen capture kept stopping]'
  ]);
});

test('the transcript says no screen was recorded when Screen Recording was off', async (t) => {
  const { feed, call } = await setup(t);
  feed([
    startedEv(M, { screen: 'frames' }),
    ev('mark', M, { id: 'dropped-frames', kind: 'dropped', at: 0, until: null, track: 'screen', detail: 'permission', label: null })
  ]);
  const res = data(await call('read_meeting_transcript', { meeting_id: M }));
  assert.deepEqual(untag(res.transcript).trim().split('\n'), [
    "[00:00:00] [Rukoo Voice records no screen in this meeting: the computer doesn't let it record the screen]"
  ]);
});
