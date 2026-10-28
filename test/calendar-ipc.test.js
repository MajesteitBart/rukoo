'use strict';

// What a window may send to the calendar calls (src/main/calendar/ipc.js): today's fields keep their coercion, the
// newer ones pass through when they fit and are left out (undefined) when they don't, never turned into a default.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  calendarInput,
  calendarGuests,
  calendarReminders,
  calendarConflicts,
  calendarFreeOpts,
  calendarScope,
  calendarEtag,
  calendarSeriesEtag,
  calendarEventId,
  calendarCalendarId,
  calendarRange
} = require('../src/main/calendar/ipc');

const NEW = ['timeZone', 'guests', 'recurrence', 'reminders', 'busy', 'visibility', 'addMeet'];
const base = { accountId: 'g1', calendarId: 'me@example.com', title: 'Call', location: '', description: '', allDay: false, start: 1, end: 2 };

test("today's fields keep their coercion, and an event without the newer fields leaves them all undefined", () => {
  const out = calendarInput(base);
  for (const k of NEW) assert.equal(out[k], undefined, k);
  const odd = calendarInput({ title: 7, location: 'x'.repeat(1200), allDay: 'yes', start: '5', end: null, startDate: '2026-11-02T00', id: 3 });
  assert.deepEqual([odd.title, odd.location.length, odd.allDay, odd.start, odd.end, odd.startDate, odd.id], ['', 1000, false, 5, 0, '2026-11-02', '']);
  assert.deepEqual(calendarInput('nonsense').accountId, '');
});

test('newer fields that fit pass through as sent', () => {
  const sent = {
    ...base,
    timeZone: 'Europe/Amsterdam',
    guests: { add: [{ address: 'jane@example.com', name: 'Jane', optional: true }, { address: 'kim@example.com' }], remove: ['old@example.com'], optional: { 'joris@example.com': false } },
    recurrence: 'FREQ=WEEKLY;BYDAY=MO;WKST=MO',
    reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: -540 }, { method: 'email', minutes: 40320 }] },
    busy: false,
    visibility: 'confidential',
    addMeet: false
  };
  const out = calendarInput(sent);
  assert.deepEqual(
    Object.fromEntries(NEW.map((k) => [k, out[k]])),
    {
      timeZone: 'Europe/Amsterdam',
      guests: { add: [{ address: 'jane@example.com', name: 'Jane', optional: true }, { address: 'kim@example.com', name: '', optional: false }], remove: ['old@example.com'], optional: { 'joris@example.com': false } },
      recurrence: 'FREQ=WEEKLY;BYDAY=MO;WKST=MO',
      reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: -540 }, { method: 'email', minutes: 40320 }] },
      busy: false,
      visibility: 'confidential',
      addMeet: false
    }
  );
  assert.equal(calendarInput({ ...base, recurrence: null }).recurrence, null, 'null takes the rule off');
  // Copies: changing what was sent afterwards changes nothing.
  sent.guests.add[0].address = 'changed@example.com';
  sent.reminders.overrides[0].minutes = 5;
  assert.equal(out.guests.add[0].address, 'jane@example.com');
  assert.equal(out.reminders.overrides[0].minutes, -540);
});

test('newer fields that do not fit are left out, never given a default', () => {
  const bad = {
    timeZone: [7, 'x'.repeat(65), null],
    recurrence: [7, 'F'.repeat(501), {}],
    busy: ['yes', 0, 1, null, ''],
    visibility: ['secret', 'Default', 1],
    addMeet: ['true', 1, null],
    reminders: [
      'popup',
      { useDefault: 'no', overrides: [] },
      { useDefault: false },
      { useDefault: false, overrides: Array(6).fill({ method: 'popup', minutes: 5 }) },
      { useDefault: false, overrides: [{ method: 'sms', minutes: 5 }] },
      { useDefault: false, overrides: [{ method: 'popup', minutes: 1.5 }] },
      { useDefault: false, overrides: [{ method: 'popup', minutes: -1440 }] },
      { useDefault: false, overrides: [{ method: 'popup', minutes: 40321 }] },
      { useDefault: false, overrides: [null] }
    ],
    guests: [
      'jane',
      ['jane@example.com'],
      { add: 'jane@example.com' },
      { add: [{ address: 7 }] },
      { add: [{ address: 'x'.repeat(321) }] },
      { add: [{ address: 'a@b.c', name: 7 }] },
      { add: [{ address: 'a@b.c', optional: 'yes' }] },
      { add: Array(101).fill({ address: 'a@b.c' }) },
      { remove: 'a@b.c' },
      { remove: [7] },
      { optional: { 'a@b.c': 'yes' } },
      { optional: ['a@b.c'] },
      // One bad part drops the whole diff, so half a change never goes out.
      { add: [{ address: 'a@b.c' }], remove: [7] }
    ]
  };
  for (const [field, values] of Object.entries(bad)) {
    for (const v of values) assert.equal(calendarInput({ ...base, [field]: v })[field], undefined, `${field}: ${JSON.stringify(v)}`);
  }
  assert.equal(calendarGuests(undefined), undefined);
  assert.equal(calendarReminders(undefined), undefined);
  // An empty diff is a diff with nothing in it, not a default list.
  assert.deepEqual(calendarGuests({}), {});
});

test('a booking id or uid from a window is never passed on', () => {
  const out = calendarInput({ ...base, bookingId: 'Rf63vMqqWdS0MICDAHKmrw', uid: 'x@y', extendedProperties: { private: { rukooBooking: 'x' } } });
  assert.equal('bookingId' in out, false);
  assert.equal('uid' in out, false);
  assert.equal('extendedProperties' in out, false);
});

test('the other arguments: ids, versions, scope, ranges, conflicts and free time', () => {
  assert.deepEqual(['one', 'following', 'all', 'some', undefined].map((scope) => calendarScope({ scope })), ['one', 'following', 'all', 'one', 'one']);
  assert.equal(calendarScope(null), 'one');
  assert.deepEqual([calendarEtag({ etag: '"3"' }), calendarEtag({ etag: '' }), calendarEtag({ etag: 'x'.repeat(201) }), calendarEtag(null)], ['"3"', null, null, null]);
  assert.deepEqual([calendarSeriesEtag({ seriesEtag: '"4"' }), calendarSeriesEtag({ seriesEtag: 4 })], ['"4"', null]);
  assert.equal(calendarEventId('g1:a:b'), 'g1:a:b');
  for (const id of ['', 7, 'x'.repeat(3001)]) assert.throws(() => calendarEventId(id), /invalid/);
  assert.equal(calendarCalendarId('team@example.com'), 'team@example.com');
  for (const id of ['', 42, 'x'.repeat(1001)]) assert.throws(() => calendarCalendarId(id), /invalid/);
  assert.deepEqual(calendarRange({ start: 1, end: 2, extra: 3 }), { start: 1, end: 2 });
  for (const r of [{ start: 2, end: 1 }, { start: 0, end: 401 * 86400000 }, { start: '1', end: 2 }]) assert.throws(() => calendarRange(r), /invalid/);

  const ids = Array.from({ length: 25 }, (_, i) => `g1:c:${i}`);
  const conflicts = calendarConflicts({ start: 0, end: 3600000, exclude: [...ids.slice(0, 2), 7, '', 'x'.repeat(3001), ...ids.slice(2)] });
  assert.deepEqual(conflicts.exclude, ids.slice(0, 2).concat(ids.slice(2, 17)), 'the first 20 entries, of which the ones that are no id are dropped');
  assert.deepEqual(calendarConflicts({ start: 0, end: 1, exclude: 'g1:c:1' }).exclude, []);
  assert.throws(() => calendarConflicts({ start: 0, end: 32 * 86400000 }), /invalid/);

  assert.deepEqual(calendarFreeOpts({ start: 1, end: 2, length: '30', hours: 'booking', timeZone: 'Europe/Amsterdam', locale: 'nl', hour12: false }), { start: 1, end: 2, length: 30, hours: 'booking', timeZone: 'Europe/Amsterdam', locale: 'nl', hour12: false });
  assert.deepEqual(calendarFreeOpts({ hours: 'weekend', timeZone: 7, locale: 'de', hour12: 'yes' }), { start: NaN, end: NaN, length: NaN, hours: 'working', timeZone: undefined, locale: undefined, hour12: undefined });
});
