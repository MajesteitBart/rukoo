'use strict';

// The desktop notifications main holds per mode (src/main/notices.js), so turning a mode off in Settings > General >
// Tabs takes them down, also those Windows keeps in Action Center after the banner timed out. A fake Notification
// stands in for Electron's: it counts close() and emits the events Electron emits.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { NoticeKeeper, LIMIT } = require('../src/main/notices');

class FakeNotice extends EventEmitter {
  constructor(name) {
    super();
    this.name = name;
    this.closed = 0;
  }
  close() {
    this.closed += 1;
  }
  // Electron's 'close' event: an Event with the reason Windows gave, if any.
  closeBy(reason) {
    this.emit('close', reason ? { reason } : {});
  }
}

test('on Windows a notification whose banner timed out stays held, and turning its mode off closes it', () => {
  const keeper = new NoticeKeeper({ platform: 'win32' });
  const timedOut = new FakeNotice('timed out');
  const live = new FakeNotice('on screen');
  const dismissed = new FakeNotice('dismissed');
  const clicked = new FakeNotice('clicked');
  const unknown = new FakeNotice('no reason');
  for (const n of [timedOut, live, dismissed, clicked, unknown]) keeper.keep('mail', n);
  timedOut.closeBy('timedOut');
  dismissed.closeBy('userCanceled');
  clicked.emit('click');
  unknown.closeBy(null);
  // In Action Center still: the one that timed out and the one Windows gave no reason for.
  assert.equal(keeper.size('mail'), 3);
  assert.equal(keeper.close('mail'), 3);
  assert.deepEqual([timedOut, live, dismissed, clicked, unknown].map((n) => n.closed), [1, 1, 0, 0, 1]);
  assert.equal(keeper.size('mail'), 0);
  // Closing again does nothing: they were let go.
  assert.equal(keeper.close('mail'), 0);
  assert.equal(timedOut.closed, 1);
});

test('elsewhere a closed notification is gone from the system, so it is let go', () => {
  const keeper = new NoticeKeeper({ platform: 'linux' });
  const timedOut = new FakeNotice('timed out');
  const live = new FakeNotice('on screen');
  keeper.keep('calendar', timedOut);
  keeper.keep('calendar', live);
  timedOut.closeBy('timedOut');
  assert.equal(keeper.size('calendar'), 1);
  keeper.close('calendar');
  assert.deepEqual([timedOut.closed, live.closed], [0, 1]);
});

test('a failed notification is let go, and one mode going leaves the others alone', () => {
  const keeper = new NoticeKeeper({ platform: 'win32' });
  const failed = new FakeNotice('failed');
  const event = new FakeNotice('reminder');
  keeper.keep('mail', failed);
  keeper.keep('calendar', event);
  failed.emit('failed', {}, 'denied');
  assert.equal(keeper.size('mail'), 0);
  keeper.close('mail');
  assert.equal(event.closed, 0);
  assert.equal(keeper.size('calendar'), 1);
  assert.equal(keeper.close('meeting'), 0, 'a mode with none');
});

test('at most LIMIT are held per mode: the oldest goes first and is closed as it goes', () => {
  const keeper = new NoticeKeeper({ platform: 'win32' });
  const all = Array.from({ length: LIMIT + 3 }, (_, i) => new FakeNotice(`mail ${i}`));
  for (const n of all) {
    keeper.keep('mail', n);
    n.closeBy('timedOut');
  }
  assert.equal(keeper.size('mail'), LIMIT);
  assert.deepEqual(all.slice(0, 3).map((n) => n.closed), [1, 1, 1], 'the three oldest left Action Center with their handles');
  assert.ok(all.slice(3).every((n) => n.closed === 0));
  // The chat mode has its own room.
  keeper.keep('chat', new FakeNotice('chat'), 'a1');
  assert.equal(keeper.size('chat'), 1);
  assert.equal(keeper.size('mail'), LIMIT);
  keeper.close('mail');
  assert.ok(all.every((n) => n.closed === 1));
});

test('a chat alert is taken back by its id, also after its banner timed out on Windows, and a newer one replaces it', () => {
  const keeper = new NoticeKeeper({ platform: 'win32' });
  const first = new FakeNotice('first');
  keeper.keep('chat', first, 'alert-1');
  first.closeBy('timedOut');
  const second = new FakeNotice('second');
  keeper.keep('chat', second, 'alert-1');
  assert.equal(first.closed, 1, 'the newer alert under the same id replaced it');
  assert.equal(keeper.size('chat'), 1);
  const other = new FakeNotice('other');
  keeper.keep('chat', other, 'alert-2');
  other.closeBy('timedOut');
  assert.equal(keeper.closeKey('chat', 'alert-2'), true, 'read meanwhile: taken back from Action Center');
  assert.equal(other.closed, 1);
  assert.equal(keeper.closeKey('chat', 'alert-2'), false);
  assert.equal(keeper.size('chat'), 1);
  assert.deepEqual(keeper.keys('chat'), ['alert-1']);
  assert.deepEqual(keeper.keys('mail'), []);
});
