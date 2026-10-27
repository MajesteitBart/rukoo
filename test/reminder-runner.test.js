'use strict';

// The reminder runner (src/main/calendar/reminder-runner.js) with mock timers, a calendar store that hands out the
// events a test gives it, and a notifier that records what would show.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { tempDir } = require('./tmp');
const { ReminderRunner, reminderNotice, TICK, READ_EVERY } = require('../src/main/calendar/reminder-runner');

const MINUTE = 60000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
// A Monday 08:00 on the PC's clock, far from any clock change.
const BASE = new Date(2026, 5, 15, 8, 0, 0, 0).getTime();

function fakeCalendars(events, calendars = [{ id: 'cal', name: 'Work', primary: true, writable: true, visible: true, defaultReminders: [] }]) {
  const store = new EventEmitter();
  store.events = events;
  store.calendars = calendars;
  store.reads = [];
  store.read = async (o) => {
    store.reads.push(o);
    const keys = o.calendars ? new Set(o.calendars) : null;
    return { events: store.events.filter((e) => e.end > o.start && e.start < o.end && (!keys || keys.has(`${e.accountId}\n${e.calendarId}`))), failed: [] };
  };
  store.list = () => [{ id: 'a1', email: 'me@example.com', calendars: store.calendars }];
  return store;
}

const event = (over = {}) => ({
  id: 'e1',
  accountId: 'a1',
  calendarId: 'cal',
  uid: 'u1',
  title: 'Standup',
  location: '',
  meeting: null,
  allDay: false,
  start: BASE + HOUR,
  end: BASE + HOUR + 30 * MINUTE,
  startDate: null,
  originalStart: null,
  reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 10 }] },
  response: null,
  ...over
});

function runner(t, store, { dataDir = tempDir('rukoo-reminders-'), calendar = { notify: true, reminder: 10 }, power = new EventEmitter() } = {}) {
  const shown = [];
  const r = new ReminderRunner({ calendars: store, engine: { settings: { calendar } }, dataDir, notify: (list) => shown.push(list), powerMonitor: power });
  t.after(() => r.stop());
  return { r, shown, dataDir, power };
}

async function settle(r) {
  for (let i = 0; i < 5; i++) {
    if (r.running) await r.running;
    await new Promise((resolve) => setImmediate(resolve));
  }
}

// Moves the mocked clock on, tick by tick, letting each check finish.
async function advance(t, r, ms) {
  for (let done = 0; done < ms; done += TICK) {
    t.mock.timers.tick(Math.min(TICK, ms - done));
    await settle(r);
  }
}

test('a reminder shows once at its time, and not again after a restart', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: BASE });
  const store = fakeCalendars([event({ location: 'Room 4', meeting: 'https://meet.google.com/abc' })]);
  const { r, shown, dataDir } = runner(t, store);
  r.start();
  await settle(r);
  // The read reaches past the longest reminder, not just 48 hours.
  assert.ok(store.reads[0].end - store.reads[0].start >= 30 * DAY);
  await advance(t, r, 49 * MINUTE);
  assert.equal(shown.length, 0, 'not before 08:50');
  await advance(t, r, 2 * MINUTE);
  assert.equal(shown.length, 1);
  assert.equal(shown[0][0].minutes, 10);
  const note = reminderNotice(shown[0], Date.now());
  assert.equal(note.title, 'Standup');
  assert.equal(note.body, 'Starts in 9 minutes\nRoom 4\nClick to join');
  assert.deepEqual(note.open, { id: 'e1', start: BASE + HOUR });
  await advance(t, r, 5 * MINUTE);
  assert.equal(shown.length, 1);
  r.stop();
  const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'reminders.json'), 'utf8'));
  assert.equal(Object.keys(saved.fired).length, 1);

  const again = runner(t, store, { dataDir });
  again.r.start();
  await settle(again.r);
  await advance(t, again.r, 5 * MINUTE);
  assert.equal(again.shown.length, 0, 'remembered across a restart');
});

test('reminders.json is written when a reminder shows, and otherwise every few minutes, not at every check', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: BASE });
  const store = fakeCalendars([event()]);
  const { r, shown, dataDir } = runner(t, store);
  const saved = () => JSON.parse(fs.readFileSync(path.join(dataDir, 'reminders.json'), 'utf8'));
  r.start();
  await settle(r);
  assert.equal(saved().lastCheck, BASE);
  await advance(t, r, 2 * MINUTE);
  assert.equal(saved().lastCheck, BASE, 'four checks later, still the first one');
  await advance(t, r, 3 * MINUTE);
  assert.equal(saved().lastCheck, BASE + 5 * MINUTE);
  await advance(t, r, 45 * MINUTE + TICK);
  assert.equal(shown.length, 1);
  assert.equal(Object.keys(saved().fired).length, 1, 'a reminder that showed is written at once');
  assert.ok(saved().lastCheck >= BASE + 50 * MINUTE);
});

test('reminders that fall due together make one notification', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: BASE });
  const store = fakeCalendars([
    event(),
    event({ id: 'e2', uid: 'u2', title: 'Review', start: BASE + HOUR, end: BASE + 2 * HOUR }),
    event({ id: 'e3', uid: 'u3', title: '', start: BASE + HOUR, end: BASE + 2 * HOUR }),
    // The same meeting on a second calendar: one reminder.
    event({ id: 'e1-copy', calendarId: 'cal' })
  ]);
  const { r, shown } = runner(t, store);
  r.start();
  await settle(r);
  await advance(t, r, 51 * MINUTE);
  assert.equal(shown.length, 1);
  const note = reminderNotice(shown[0], BASE + 50 * MINUTE);
  assert.equal(note.title, '3 events coming up');
  assert.equal(note.body, 'Starts in 10 minutes: Standup\nStarts in 10 minutes: Review\nStarts in 10 minutes: (No title)');
});

test('after sleep, a reminder of a meeting that started less than 5 minutes ago still shows; older ones are dropped', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: BASE });
  const store = fakeCalendars([
    event({ id: 'early', uid: 'early', title: 'Early', start: BASE + 30 * MINUTE, end: BASE + HOUR }),
    event({ id: 'now', uid: 'now', title: 'Now', start: BASE + 3 * HOUR, end: BASE + 4 * HOUR })
  ]);
  const { r, shown, power } = runner(t, store);
  r.start();
  await settle(r);
  // Asleep: no ticks run while the clock moves on, then the computer wakes 3 minutes after 'Now' started.
  r.stop();
  t.mock.timers.tick(3 * HOUR + 3 * MINUTE);
  r.start();
  power.emit('resume');
  await settle(r);
  assert.equal(shown.length, 1);
  assert.deepEqual(shown[0].map((d) => d.id), ['now']);
  assert.equal(shown[0][0].late, 3);
  assert.equal(reminderNotice(shown[0], Date.now()).body, 'Started 3 minutes ago');
});

test('a moved event reminds at its new time, and its account is read again fresh', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: BASE });
  const before = event();
  const store = fakeCalendars([before]);
  const { r, shown } = runner(t, store);
  r.start();
  await settle(r);
  await advance(t, r, 51 * MINUTE);
  assert.equal(shown.length, 1);
  // Moved two hours later in Rukoo: the 'changed' event applies at once.
  const after = { ...before, start: BASE + 3 * HOUR, end: BASE + 3 * HOUR + 30 * MINUTE };
  store.events = [after];
  store.emit('changed', { accountId: 'a1', calendarId: 'cal', kind: 'update', scope: 'one', event: after, previous: before });
  await advance(t, r, 3000);
  const reread = store.reads.at(-1);
  assert.deepEqual([reread.calendars, reread.maxAgeMs], [['a1\ncal'], 0]);
  await advance(t, r, 2 * HOUR);
  assert.equal(shown.length, 2);
  assert.equal(shown[1][0].start, BASE + 3 * HOUR);
});

test('the fallback reminder applies only to timed events with unknown reminders on shown calendars', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: BASE });
  const store = fakeCalendars(
    [
      event({ id: 'unknown', uid: 'unknown', reminders: null }),
      event({ id: 'hidden', uid: 'hidden', calendarId: 'hidden', reminders: null }),
      event({ id: 'none', uid: 'none', reminders: { useDefault: false, overrides: [] } }),
      event({ id: 'declined', uid: 'declined', response: 'declined' })
    ],
    [
      { id: 'cal', name: 'Work', primary: true, writable: true, visible: true, defaultReminders: [] },
      { id: 'hidden', name: 'Hidden', primary: false, writable: true, visible: false, defaultReminders: [] }
    ]
  );
  const { r, shown } = runner(t, store, { calendar: { notify: true, reminder: 15 } });
  r.start();
  await settle(r);
  await advance(t, r, 50 * MINUTE);
  assert.deepEqual(shown.flat().map((d) => [d.id, d.minutes]), [['unknown', 15]]);
});

test('an all-day reminder says its day, never how long ago it started', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: BASE });
  const day = new Date(BASE);
  const date = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
  const midnight = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
  const store = fakeCalendars([event({ id: 'birthday', uid: 'birthday', title: 'Birthday', allDay: true, startDate: date, start: midnight, end: midnight + DAY, reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: -540 }] } })]);
  const { r, shown } = runner(t, store);
  r.start();
  await settle(r);
  await advance(t, r, HOUR + TICK);
  assert.equal(shown.length, 1);
  assert.equal(reminderNotice(shown[0], Date.now()).body, 'Today, all day');
});

test('with notifications off nothing shows, and turning them on later brings no pile of old ones', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: BASE });
  const calendar = { notify: false, reminder: 10 };
  const store = fakeCalendars([event()]);
  const { r, shown } = runner(t, store, { calendar });
  r.start();
  await settle(r);
  await advance(t, r, 52 * MINUTE);
  assert.equal(shown.length, 0);
  calendar.notify = true;
  await advance(t, r, 2 * MINUTE);
  assert.equal(shown.length, 0);
});

test('the events are read again every 15 minutes, and a week-ahead reminder fires', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: BASE });
  const store = fakeCalendars([event({ id: 'far', uid: 'far', start: BASE + 7 * DAY + HOUR, end: BASE + 7 * DAY + 2 * HOUR, reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 7 * 24 * 60 }] } })]);
  const { r, shown } = runner(t, store);
  r.start();
  await settle(r);
  const reads = store.reads.length;
  await advance(t, r, READ_EVERY + TICK);
  assert.equal(store.reads.length, reads + 1);
  // It fires a week before 09:00, at 09:00 today.
  await advance(t, r, 30 * MINUTE);
  assert.equal(shown.length, 0);
  await advance(t, r, 15 * MINUTE);
  assert.deepEqual(shown.flat().map((d) => d.id), ['far']);
  assert.equal(reminderNotice(shown[0], Date.now()).body, `${new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }).format(BASE + 7 * DAY + HOUR)} at 09:00`);
});
