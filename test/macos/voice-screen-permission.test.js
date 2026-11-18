'use strict';

// A Mac Voice whose screen process refused to start, because Screen Recording is off for it, sends a `dropped` mark
// on the screen track with detail `permission` and answers `screen.get` with `off`. Rukoo holds back its mail and
// booking notifications while a meeting records the screen; here it lets them through at the mark and keeps doing so
// after a reconnect. macOS CI runs this folder (`node --test "test/macos/*.test.js"`).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { tempDir } = require('../tmp');
const { startVoiceServer } = require('../fixtures/voice-server');
const { VoiceService } = require('../../src/main/voice');

const M1 = 'm-20261030-090000-0a1b';
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

async function setup(t) {
  const dir = tempDir('rukoo-voice-permission-');
  const file = path.join(dir, 'voice-bridge.json');
  const voice = await startVoiceServer({ file });
  t.after(() => voice.close());
  return { dir, file, voice };
}

function service(t, dir, file) {
  const s = new VoiceService({
    dataDir: path.join(dir, 'data'),
    discovery: file,
    appVersion: '9.9.9',
    hide: () => true,
    protect: () => {},
    bridge: FAST,
    emitMs: 10
  });
  t.after(() => s.close());
  return s;
}

test('a screen refused for want of Screen Recording lets the notifications through, also after a reconnect', async (t) => {
  const { dir, file, voice } = await setup(t);
  voice.writeDiscovery();
  let asked = 0;
  voice.handlers['screen.get'] = () => {
    asked += 1;
    return { screen: 'off', state: 'off', video: false, frames: false, monitor: null, monitors: [] };
  };
  const s = service(t, dir, file).init();
  await until(() => s.connected, 'the connection');
  voice.append('meeting.started', M1, { title: 'Refused', startedAt: Date.now(), tracks: ['mic', 'call'], screen: 'frames', startedBy: 'voice', context: null });
  voice.append('meeting.state', M1, { state: 'recording', at: 0 });
  await until(() => s.recording() === M1, 'the recording');
  assert.equal(s.screenRecording(), true, 'a frames meeting holds the notifications back');

  voice.append('mark', M1, { id: 'dropped-frames', kind: 'dropped', at: 0, until: null, track: 'screen', detail: 'permission', label: null });
  await until(() => !s.screenRecording(), 'the drop to let the notifications through');

  // Voice goes and comes back while the meeting records: the welcome asks screen.get again, which says off.
  const before = asked;
  voice.drop();
  await until(() => !s.connected, 'the drop');
  await until(() => s.connected, 'the reconnect');
  await until(() => asked > before, 'screen.get after the reconnect');
  await until(() => !s.screenRecording(), 'the notifications to stay let through');
  assert.equal(s.recording(), M1, 'the audio still records');
});
