'use strict';

// Which reminders fire when: due() over events, sleep and restarts, moved and duplicated events, all-day reminders
// across clock changes, and the reminders.json state.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { due, readRange, emptyState, normalizeState, loadState, saveState, since, unfired, record, LATE, MAX_MINUTES } = require('../src/main/calendar/reminders');
const { zonedParts, zonedInstant, addDays } = require('../src/main/calendar/zone');
const { tempDir } = require('./tmp');

const MINUTE = 60000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const ZONE = 'Europe/Amsterdam';
const z = (iso) => Date.parse(iso);
const START = z('2026-11-03T10:00:00Z');

const calendar = (o = {}) => ({ id: 'primary', name: 'Me', primary: true, writable: true, defaultReminders: [], ...o });
const popup = (...minutes) => ({ useDefault: false, overrides: minutes.map((m) => ({ method: 'popup', minutes: m })) });
let count = 0;
function event(o = {}) {
  count++;
  return {
    id: `a:primary:e${count}`, accountId: 'a', calendarId: 'primary', uid: `e${count}@example.com`, originalStart: null,
    title: `Event ${count}`, location: '', meeting: null, allDay: false, start: START, end: START + HOUR,
    startDate: null, endDate: null, status: 'confirmed', response: 'accepted', reminders: popup(10), ...o
  };
}
function allDay(date, o = {}, zone = ZONE) {
  const start = zonedInstant(date, '00:00', zone);
  return event({ allDay: true, start, end: zonedInstant(addDays(date, 1), '00:00', zone), startDate: date, endDate: addDays(date, 1), ...o });
}
// Defaults for every call: a shown, writable primary calendar, a 10-minute fallback, all-day events in Amsterdam.
const check = (events, o) => due(events, { fallback: 10, isShown: () => true, calendarOf: () => calendar(), timeZone: ZONE, now: o.to, ...o });
const keys = (list) => list.map((d) => d.key);
const ats = (list) => list.map((d) => new Date(d.at).toISOString());

// The same pseudo-random numbers on every run, so a failure can be replayed.
function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('a popup reminder fires once its time is in (from, to]; email reminders are the provider\'s', () => {
  const e = event({ title: 'Roadmap', location: 'Room 4', meeting: 'https://meet.example.com/x', reminders: { useDefault: false, overrides: [{ method: 'email', minutes: 30 }, { method: 'popup', minutes: 10 }] } });
  const list = check([e], { from: START - 15 * MINUTE, to: START - 10 * MINUTE });
  assert.deepEqual(list, [{
    key: `${e.uid}\n${START}\n${START}\n10`, id: e.id, title: 'Roadmap', location: 'Room 4', meeting: 'https://meet.example.com/x',
    start: START, end: START + HOUR, allDay: false, minutes: 10, at: START - 10 * MINUTE, late: 0
  }]);
  assert.deepEqual(check([e], { from: START - 10 * MINUTE, to: START }), [], 'from is exclusive');
  assert.deepEqual(check([e], { from: START - 40 * MINUTE, to: START - 10 * MINUTE - 1 }), [], 'to is inclusive, and email never fires');
  assert.deepEqual(check([e], { from: START, to: START - HOUR }), []);
  assert.throws(() => check([e], { from: null, to: START }), RangeError);
});

test('calendar defaults apply with useDefault; useDefault: false with no overrides means none', () => {
  const e = event({ reminders: { useDefault: true, overrides: [] } });
  const defaults = calendar({ defaultReminders: [{ method: 'popup', minutes: 30 }, { method: 'email', minutes: 60 }, { method: 'popup', minutes: 30 }] });
  const list = check([e], { from: START - 2 * HOUR, to: START, calendarOf: () => defaults });
  assert.deepEqual(list.map((d) => d.minutes), [30]);
  assert.deepEqual(check([e], { from: START - 2 * HOUR, to: START, calendarOf: () => null }), []);
  assert.deepEqual(check([event({ reminders: { useDefault: false, overrides: [] } })], { from: START - 2 * HOUR, to: START, calendarOf: () => defaults }), [], 'not the defaults, not the fallback');
});

test('the fallback covers only timed events with unknown reminders on the user\'s own or primary calendars', () => {
  const unknown = event({ reminders: null });
  const range = { from: START - HOUR, to: START };
  assert.deepEqual(check([unknown], { ...range, fallback: 15 }).map((d) => d.minutes), [15]);
  assert.deepEqual(check([unknown], { ...range, fallback: 0 }).map((d) => d.at), [START]);
  assert.deepEqual(check([unknown], { ...range, calendarOf: () => calendar({ primary: true, writable: false }) }).length, 1, 'read-only primary');
  assert.deepEqual(check([unknown], { ...range, calendarOf: () => calendar({ primary: false, writable: true }) }).length, 1, 'own writable');
  assert.deepEqual(check([unknown], { ...range, calendarOf: () => calendar({ primary: false, writable: false }) }), [], 'subscribed calendar');
  assert.deepEqual(check([unknown], { ...range, calendarOf: () => null }), [], 'calendar unknown');
  for (const fallback of [null, undefined, -5, 1.5, '10', 40321]) {
    assert.deepEqual(check([unknown], { ...range, fallback }), [], `fallback ${fallback}`);
  }
  const holiday = allDay('2026-11-04', { reminders: null });
  assert.deepEqual(check([holiday], { from: z('2026-11-02T00:00:00Z'), to: z('2026-11-05T00:00:00Z'), now: z('2026-11-02T00:00:00Z') }), [], 'never on all-day events');
});

test('hidden calendars and declined events stay quiet', () => {
  const range = { from: START - HOUR, to: START };
  const e = event();
  assert.deepEqual(check([e], { ...range, isShown: () => false }), []);
  assert.deepEqual(check([event({ response: 'declined' })], range), []);
  assert.deepEqual(check([event({ response: 'needsAction' }), event({ response: 'tentative' })], range).length, 2);
  // isShown sees the event itself.
  const seen = [];
  check([e], { ...range, isShown: (x) => { seen.push(x); return true; } });
  assert.equal(seen[0], e);
});

test('after sleep a reminder still shows until 5 minutes after the start, saying how late it is', () => {
  const e = event();
  const asleep = START - 30 * MINUTE;
  const at = (now) => check([e], { from: asleep, to: now });
  assert.deepEqual(at(START - 2 * MINUTE).map((d) => d.late), [0]);
  assert.deepEqual(at(START).map((d) => d.late), [0]);
  assert.deepEqual(at(START + 3 * MINUTE + 20000).map((d) => d.late), [3]);
  assert.deepEqual(at(START + LATE - 1).map((d) => d.late), [4]);
  assert.deepEqual(at(START + LATE), [], 'started 5 minutes ago: dropped');
  assert.deepEqual(at(START + 6 * HOUR), []);
  // A reminder a week ahead still shows after a day asleep: its event hasn't started.
  const week = event({ start: START + 7 * 24 * HOUR, end: START + 7 * 24 * HOUR + HOUR, reminders: popup(10080) });
  assert.deepEqual(check([week], { from: START - 24 * HOUR, to: START + HOUR }).map((d) => [d.at, d.late]), [[START, 0]]);
});

test('a restart shows what it missed and nothing that already showed', () => {
  const dir = tempDir('rukoo-reminders-');
  const file = path.join(dir, 'data', 'reminders.json');
  const a = event({ start: START, end: START + HOUR });
  const b = event({ start: START + 5 * MINUTE, end: START + HOUR });
  // A tick at 09:50:10 shows a's reminder; then Rukoo quits.
  let state = loadState(file);
  assert.deepEqual(state, emptyState(), 'no file yet');
  const first = unfired(check([a, b], { from: since(state, START - 10 * MINUTE + 10000) - MINUTE, to: START - 10 * MINUTE + 10000 }), state);
  assert.deepEqual(keys(first), [keys(check([a], { from: START - HOUR, to: START }))[0]]);
  state = record(state, first, START - 10 * MINUTE + 10000);
  saveState(file, state);
  assert.equal(fs.existsSync(`${file}.tmp`), false);
  // It starts again at 09:58 and looks back from its last check, and further for good measure.
  const back = loadState(file);
  assert.deepEqual(back, state);
  assert.equal(since(back, START - 2 * MINUTE), START - 10 * MINUTE + 10000);
  const candidates = check([a, b], { from: since(back, START - 2 * MINUTE) - 15 * MINUTE, to: START - 2 * MINUTE });
  assert.equal(candidates.length, 2);
  const shown = unfired(candidates, back);
  assert.deepEqual(shown.map((d) => d.id), [b.id]);
  // A damaged file starts empty rather than failing.
  fs.writeFileSync(file, '{"v":1,"fired":');
  assert.deepEqual(loadState(file), emptyState());
});

test('a moved event reminds again; a series occurrence is keyed by its original start', () => {
  const e = event();
  let state = emptyState();
  const before = check([e], { from: START - 11 * MINUTE, to: START - 10 * MINUTE });
  state = record(state, before, START - 10 * MINUTE);
  // Moved from 10:00 to 11:00 at 09:55.
  const moved = { ...e, start: START + HOUR, end: START + 2 * HOUR };
  const after = unfired(check([moved], { from: START + 49 * MINUTE, to: START + 50 * MINUTE }), state);
  assert.deepEqual(after.map((d) => d.id), [e.id]);
  assert.notEqual(after[0].key, before[0].key);
  // Unmoved, the same reminder found again is filtered out.
  assert.deepEqual(unfired(check([e], { from: START - 20 * MINUTE, to: START }), state), []);
  // Occurrences of one series share a uid; their original starts tell them apart, and the start re-arms a moved one.
  const day = 24 * HOUR;
  const monday = event({ uid: 'series@example.com', originalStart: START, start: START });
  const tuesday = event({ uid: 'series@example.com', originalStart: START + day, start: START + day + 30 * MINUTE, end: START + day + 90 * MINUTE });
  const list = check([monday, tuesday], { from: START - HOUR, to: START + 2 * day, now: START - HOUR });
  assert.deepEqual(keys(list), [`series@example.com\n${START}\n${START}\n10`, `series@example.com\n${START + day}\n${START + day + 30 * MINUTE}\n10`]);
  // Monday's occurrence reminded at 09:50, then moved to 10:30 on the same day: it reminds again at 10:20.
  state = record(emptyState(), check([monday], { from: START - HOUR, to: START - 10 * MINUTE }), START - 10 * MINUTE);
  const later = { ...monday, start: START + 30 * MINUTE, end: START + 90 * MINUTE };
  assert.deepEqual(unfired(check([later], { from: START - 10 * MINUTE, to: START + 20 * MINUTE }), state).map((d) => d.at), [START + 20 * MINUTE]);
});

test('duplicates give one reminder: the same meeting on two calendars, the same event read twice, a repeated override', () => {
  const range = { from: START - HOUR, to: START };
  const mine = event({ uid: 'meeting@example.com' });
  const team = event({ uid: 'meeting@example.com', accountId: 'b', calendarId: 'team', id: 'b:team:x' });
  assert.deepEqual(check([mine, team], range).map((d) => d.id), [mine.id]);
  assert.deepEqual(check([mine, { ...mine }], range).length, 1);
  assert.deepEqual(check([event({ reminders: popup(10, 10, 30) })], range).map((d) => d.minutes), [30, 10]);
  // Different minutes on the two copies are two reminders; so are copies at different times.
  assert.deepEqual(check([mine, { ...team, reminders: popup(30) }], range).map((d) => d.minutes), [30, 10]);
  assert.equal(check([mine, { ...team, start: START + 5 * MINUTE }], { ...range, to: START + 5 * MINUTE, now: START }).length, 2);
  // Without a uid the id is the key, so two such events stay apart.
  assert.equal(check([event({ uid: null }), event({ uid: null })], range).length, 2);
});

test('reminders come out by fire time, then start', () => {
  const list = check([
    event({ start: START + 30 * MINUTE, reminders: popup(5) }),
    event({ start: START, reminders: popup(10) }),
    event({ start: START + 20 * MINUTE, reminders: popup(30) })
  ], { from: START - HOUR, to: START + HOUR, now: START - HOUR });
  assert.deepEqual(ats(list), ['2026-11-03T09:50:00.000Z', '2026-11-03T09:50:00.000Z', '2026-11-03T10:25:00.000Z']);
  assert.deepEqual(list.map((d) => d.start), [START, START + 20 * MINUTE, START + 30 * MINUTE]);
});

test('all-day reminders count back from 00:00 of the first day, on the wall clock', () => {
  const e = allDay('2026-11-04', { reminders: popup(900, -540, 0, 10, 2340, 10080) });
  const list = check([e], { from: z('2026-10-20T00:00:00Z'), to: z('2026-11-05T00:00:00Z'), now: z('2026-10-20T00:00:00Z') });
  const local = list.map((d) => [d.minutes, `${zonedParts(d.at, ZONE).date} ${zonedParts(d.at, ZONE).time}`, d.late]);
  assert.deepEqual(local, [
    [10080, '2026-10-28 00:00', 0],
    [2340, '2026-11-02 09:00', 0],
    [900, '2026-11-03 09:00', 0],
    [10, '2026-11-03 23:50', 0],
    [0, '2026-11-04 00:00', 0],
    [-540, '2026-11-04 09:00', 0]
  ]);
  // Out of range, negative on a timed event, or not whole minutes: ignored.
  assert.deepEqual(check([allDay('2026-11-04', { reminders: popup(-1440, 40321, 1.5) })], { from: z('2026-10-01T00:00:00Z'), to: z('2026-11-05T00:00:00Z'), now: z('2026-10-01T00:00:00Z') }), []);
  assert.deepEqual(check([event({ reminders: popup(-5) })], { from: START - HOUR, to: START + HOUR, now: START }), []);
  // Calendar defaults are for timed events only.
  const defaults = calendar({ defaultReminders: [{ method: 'popup', minutes: 10 }] });
  assert.deepEqual(check([allDay('2026-11-04', { reminders: { useDefault: true, overrides: [] } })], { from: z('2026-11-03T00:00:00Z'), to: z('2026-11-05T00:00:00Z'), now: z('2026-11-03T00:00:00Z'), calendarOf: () => defaults }), []);
  // Without startDate the cached start gives the date.
  assert.deepEqual(ats(check([{ ...e, startDate: null, reminders: popup(-540) }], { from: z('2026-11-04T00:00:00Z'), to: z('2026-11-05T00:00:00Z'), now: z('2026-11-04T00:00:00Z') })), ['2026-11-04T08:00:00.000Z']);
});

test('all-day dates come from startDate, so a cache made in another zone still reminds on the right day', () => {
  // Cached in Amsterdam, read after a flight to New York, where 00:00 Amsterdam is 18:00 the evening before.
  const NY = 'America/New_York';
  const trip = allDay('2026-11-04', { reminders: popup(-540, 900) });
  assert.equal(zonedParts(trip.start, NY).date, '2026-11-03');
  const range = { from: z('2026-11-02T00:00:00Z'), to: z('2026-11-06T00:00:00Z'), now: z('2026-11-02T00:00:00Z'), timeZone: NY };
  assert.deepEqual(check([trip], range).map((d) => [d.minutes, new Date(d.at).toISOString()]), [
    [900, '2026-11-03T14:00:00.000Z'],
    [-540, '2026-11-04T14:00:00.000Z']
  ]);
  // A startDate that isn't a real date, or no date at all: the cached start gives the date.
  for (const startDate of ['2026-02-30', '4 Nov 2026', 20261104]) {
    const odd = allDay('2026-11-04', { startDate, reminders: popup(-540) }, NY);
    assert.deepEqual(ats(check([odd], range)), ['2026-11-04T14:00:00.000Z'], String(startDate));
  }
});

test('an all-day reminder after sleep shows until the first day is over', () => {
  const trip = allDay('2026-11-04', { end: zonedInstant('2026-11-08', '00:00', ZONE), endDate: '2026-11-08', reminders: popup(-540, 900) });
  const asleep = z('2026-11-03T06:00:00Z');
  const wake = (now) => check([trip], { from: asleep, to: now }).map((d) => d.minutes);
  assert.deepEqual(wake(zonedInstant('2026-11-04', '20:00', ZONE)), [900, -540]);
  assert.deepEqual(wake(zonedInstant('2026-11-04', '23:59', ZONE)), [900, -540]);
  assert.deepEqual(wake(zonedInstant('2026-11-05', '00:00', ZONE)), []);
  assert.deepEqual(wake(zonedInstant('2026-11-06', '12:00', ZONE)), [], 'day 3 of the trip');
});

test('all-day reminder times on clock-change days in five zones', () => {
  const at = (zone, date, minutes) => check([allDay(date, { reminders: popup(minutes) }, zone)], { from: zonedInstant(addDays(date, -3), '00:00', zone), to: zonedInstant(addDays(date, 1), '00:00', zone), now: zonedInstant(addDays(date, -3), '00:00', zone), timeZone: zone })[0].at;
  // Amsterdam, 29 March: 09:00 is 07:00 UTC in summer time, not the 08:00 that nine hours after midnight would give.
  assert.equal(at('Europe/Amsterdam', '2026-03-29', -540), z('2026-03-29T07:00:00Z'));
  assert.equal(at('Europe/Amsterdam', '2026-10-25', -540), z('2026-10-25T08:00:00Z'));
  assert.equal(at('Europe/Amsterdam', '2026-10-26', 900), z('2026-10-25T08:00:00Z'));
  assert.equal(at('America/New_York', '2026-11-01', -540), z('2026-11-01T14:00:00Z'));
  assert.equal(at('America/New_York', '2026-03-08', 10), z('2026-03-08T04:50:00Z'));
  assert.equal(at('Australia/Sydney', '2026-04-05', 900), z('2026-04-03T22:00:00Z'));
  assert.equal(at('Australia/Sydney', '2026-10-04', -540), z('2026-10-03T22:00:00Z'));
  // Santiago, 6 September: there is no 00:00, the day starts at 01:00.
  assert.equal(at('America/Santiago', '2026-09-06', 0), z('2026-09-06T04:00:00Z'));
  // 4 April shows 23:00 to 23:59 twice; the first 23:50 counts.
  assert.equal(at('America/Santiago', '2026-04-05', 10), z('2026-04-05T02:50:00Z'));
  assert.equal(at('Australia/Lord_Howe', '2026-10-04', -540), z('2026-10-03T22:00:00Z'));
  assert.equal(at('Australia/Lord_Howe', '2026-04-05', -540), z('2026-04-04T22:30:00Z'));
});

test('every all-day reminder of 2026 keeps its wall-clock time in five zones', () => {
  const cases = [[-540, 0, '09:00'], [0, 0, '00:00'], [10, -1, '23:50'], [900, -1, '09:00'], [2340, -2, '09:00'], [10080, -7, '00:00'], [-1439, 0, '23:59']];
  for (const zone of ['Europe/Amsterdam', 'America/New_York', 'Australia/Sydney', 'America/Santiago', 'Australia/Lord_Howe']) {
    const events = [];
    for (let date = '2026-01-01'; date < '2027-01-01'; date = addDays(date, 1)) events.push(allDay(date, { reminders: popup(...cases.map((c) => c[0])) }, zone));
    const from = zonedInstant('2025-12-20', '00:00', zone);
    const list = check(events, { from, to: zonedInstant('2027-01-02', '00:00', zone), now: from, timeZone: zone });
    assert.equal(list.length, events.length * cases.length, zone);
    const byId = new Map(events.map((e) => [e.id, e]));
    for (const d of list) {
      const [, days, time] = cases.find((c) => c[0] === d.minutes);
      const p = zonedParts(d.at, zone);
      const date = addDays(byId.get(d.id).startDate, days);
      // Santiago's skipped midnight is the one time that moves (to 01:00, the day's first moment).
      const want = zone === 'America/Santiago' && date === '2026-09-06' && time === '00:00' ? '01:00' : time;
      assert.deepEqual([p.date, p.time], [date, want], `${zone} ${byId.get(d.id).startDate} ${d.minutes}`);
    }
  }
});

test('tick by tick, with sleeps, every reminder shows once, on time or not at all', () => {
  const next = random(42);
  for (let round = 0; round < 200; round++) {
    const t0 = START - 6 * HOUR;
    const uids = ['a@x', 'b@x', 'c@x', null];
    const events = Array.from({ length: 1 + Math.floor(next() * 12) }, () => {
      const start = t0 + Math.floor(next() * 12 * 12) * 5 * MINUTE;
      const uid = uids[Math.floor(next() * uids.length)];
      return event({ uid, start, end: start + Math.floor(next() * 4) * 15 * MINUTE, reminders: next() < 0.2 ? null : popup(...Array.from({ length: Math.floor(next() * 4) }, () => [0, 5, 10, 30, 60, 1440][Math.floor(next() * 6)])) });
    });
    // Ticks every 30 s, with a few gaps of up to 40 minutes where the computer slept.
    const ticks = [];
    for (let t = t0; t < t0 + 14 * HOUR;) {
      t += next() < 0.03 ? Math.floor(next() * 40 * MINUTE) : 30000;
      ticks.push(t);
    }
    const lookback = next() < 0.5 ? 0 : 15 * MINUTE;
    let state = record(emptyState(), [], t0);
    const shown = [];
    for (const t of ticks) {
      const list = unfired(check(events, { from: Math.max(t0, since(state, t) - lookback), to: t }), state);
      for (const d of list) shown.push({ ...d, tick: t });
      state = record(state, list, t);
    }
    const label = `round ${round}`;
    assert.equal(new Set(keys(shown)).size, shown.length, `${label}: shown twice`);
    // Everything that could fire after t0, and whether its first tick came early enough.
    const all = check(events, { from: t0, to: ticks[ticks.length - 1], now: t0 });
    const want = all.filter((d) => ticks.find((t) => t >= d.at) < d.start + LATE).map((d) => d.key).sort();
    assert.deepEqual(keys(shown).sort(), want, label);
    for (const d of shown) {
      assert.ok(d.at <= d.tick && d.tick < d.start + LATE, `${label}: ${d.key} shown at ${d.tick}`);
      assert.equal(d.late, d.tick > d.start ? Math.floor((d.tick - d.start) / MINUTE) : 0);
    }
  }
});

test('a read of readRange() every 15 minutes finds every reminder, four weeks ahead and across zones', () => {
  assert.deepEqual(readRange({ to: START, now: START }), { start: START - 2 * DAY, end: START + MAX_MINUTES * MINUTE + 2 * DAY });
  assert.equal(readRange({ to: START - 60 * DAY, now: START }).end, START + MAX_MINUTES * MINUTE + 2 * DAY, 'never behind now');
  assert.throws(() => readRange({ to: NaN, now: START }), RangeError);
  assert.throws(() => readRange(), RangeError);

  const t0 = z('2026-10-20T00:00:00Z');
  const READ = 15 * MINUTE;
  const TICK = 30000;
  const timed = Array.from({ length: 40 }, (_, i) => {
    const start = t0 + HOUR + i * 20 * HOUR + i * 7 * MINUTE;
    return event({ start, end: start + HOUR, reminders: popup(0, 10, 1440, 2880, 10080, MAX_MINUTES) });
  });
  const dates = Array.from({ length: 12 }, (_, i) => addDays('2026-10-21', i * 3));
  // Cached in one zone and read in another, up to the 26 hours between Kiritimati and the last zone west.
  const zones = [[ZONE, ZONE], ['Pacific/Kiritimati', 'Etc/GMT+12'], ['Etc/GMT+12', 'Pacific/Kiritimati'], ['Australia/Lord_Howe', 'America/Santiago']];
  for (const [cached, zone] of zones) {
    const days = dates.map((date) => allDay(date, { reminders: popup(-1439, -540, 0, 900, 9540, MAX_MINUTES) }, cached));
    const events = [...timed, ...days];
    const byId = new Map(events.map((e) => [e.id, e]));
    const o = { fallback: 10, isShown: () => true, calendarOf: () => calendar(), timeZone: zone };
    // The runner's read at r serves its ticks until the next one, 15 minutes later.
    const read = (r) => {
      const { start, end } = readRange({ to: r + READ, now: r });
      return events.filter((e) => e.start < end && e.end > start);
    };
    const servedBy = (t) => t0 + Math.floor((t - t0) / READ) * READ;
    const all = due(events, { ...o, from: t0, to: t0 + 40 * DAY, now: t0 });
    const kinds = (allDayOnly) => [...new Set(all.filter((d) => d.allDay === allDayOnly).map((d) => d.minutes))].sort((a, b) => a - b);
    assert.deepEqual(kinds(false), [0, 10, 1440, 2880, 10080, MAX_MINUTES]);
    assert.deepEqual(kinds(true), [-1439, -540, 0, 900, 9540, MAX_MINUTES]);
    for (const d of all) {
      const label = `${cached} to ${zone}: ${byId.get(d.id).title}, ${d.minutes}`;
      // Whether a tick at `to`, with the read that serves it, shows d (due() takes events one by one).
      const shows = (from, to) => keys(due(read(servedBy(to)).filter((e) => e.id === d.id), { ...o, from, to, now: to })).includes(d.key);
      // On time: the first tick at or after the fire time.
      const tick = t0 + Math.ceil((d.at - t0) / TICK) * TICK;
      assert.ok(shows(tick - TICK, tick), `${label}, on time`);
      // Asleep from just before the fire time until the last moment it may still show.
      const last = d.allDay ? zonedInstant(addDays(byId.get(d.id).startDate, 1), '00:00', zone) - 1 : d.start + LATE - 1;
      assert.ok(shows(d.at - 1, last), `${label}, late`);
    }
  }
});

test('reminders.json: bad content is left out, ended events go, and the file is bounded', () => {
  for (const junk of [null, 'x', [], { v: 2, fired: { a: 1 } }, { v: 1, lastCheck: 'soon', fired: [] }]) {
    assert.deepEqual(normalizeState(junk), emptyState(), JSON.stringify(junk));
  }
  assert.deepEqual(normalizeState({ v: 1, lastCheck: 5, fired: { good: 10, bad: 'x', nan: null, [`${'k'.repeat(4001)}`]: 1 } }), { v: 1, lastCheck: 5, fired: { good: 10 } });
  const now = START;
  const state = { v: 1, lastCheck: now - MINUTE, fired: { old: now - LATE, recent: now - LATE + 1, later: now + HOUR } };
  const shown = check([event()], { from: now - HOUR, to: now });
  const after = record(state, shown, now);
  assert.equal(after.lastCheck, now);
  assert.deepEqual(Object.keys(after.fired).sort(), [shown[0].key, 'later', 'recent'].sort());
  assert.equal(after.fired[shown[0].key], START + HOUR, 'the value is the event\'s end');
  assert.deepEqual(state.fired, { old: now - LATE, recent: now - LATE + 1, later: now + HOUR }, 'record leaves its input alone');
  // Over the limit, the keys whose events end first go.
  const many = { v: 1, lastCheck: now, fired: Object.fromEntries(Array.from({ length: 5100 }, (_, i) => [`k${i}`, now + i * MINUTE])) };
  const bounded = record(many, [], now);
  assert.equal(Object.keys(bounded.fired).length, 5000);
  assert.equal('k99' in bounded.fired, false);
  assert.equal('k100' in bounded.fired, true);
  // since: the last check, or now when there is none or it lies ahead (the clock went back).
  assert.equal(since(emptyState(), now), now);
  assert.equal(since({ ...emptyState(), lastCheck: now - HOUR }, now), now - HOUR);
  assert.equal(since({ ...emptyState(), lastCheck: now + HOUR }, now), now);
});
