'use strict';

// Busy and free time when the PC is in another zone than the schedule: this file puts the PC in New York, while the
// working hours, the booking page and the calendar are in Amsterdam. All-day events are cached at the PC's midnight;
// for availability they must block the day in the zone that is asked for.
process.env.TZ = 'America/New_York';

const test = require('node:test');
const assert = require('node:assert/strict');
const { zonedInstant } = require('../src/main/calendar/zone');
const { formatFreeTimes } = require('../src/main/calendar/availability');
const { free } = require('../src/main/calendar/free');
const { fakeCalendar, setup } = require('./fixtures/google-calendar');

const Z = 'Europe/Amsterdam';
const NY = 'America/New_York';
const ams = (date, time) => zonedInstant(date, time, Z);
const ny = (date, time) => zonedInstant(date, time, NY);
const mine = { organizer: { email: 'me@example.com', self: true } };
const events = [
  { id: 'call', summary: 'Call', start: { dateTime: new Date(ams('2026-11-05', '10:00')).toISOString(), timeZone: Z }, end: { dateTime: new Date(ams('2026-11-05', '11:00')).toISOString(), timeZone: Z }, ...mine },
  { id: 'vacation', summary: 'Vacation', start: { date: '2026-11-06' }, end: { date: '2026-11-07' }, ...mine }
];
const THU_FRI = { start: ams('2026-11-05', '00:00'), end: ams('2026-11-07', '00:00') };

test('the PC really is in New York for this file', () => {
  assert.equal(Intl.DateTimeFormat().resolvedOptions().timeZone, NY);
  assert.equal(new Date(2026, 10, 6).getTime(), ny('2026-11-06', '00:00'));
});

test('an all-day event blocks its date from midnight to midnight in the zone asked for, not on the PC clock it is cached at', async () => {
  const { calendars } = setup(fakeCalendar({ events }));
  const read = await calendars.read({ start: THU_FRI.start - 86400000, end: THU_FRI.end + 86400000 });
  const vacation = read.events.find((e) => e.title === 'Vacation');
  assert.equal(vacation.start, ny('2026-11-06', '00:00'), "cached at the PC's midnight");
  const amsterdam = await calendars.busyTimes({ ...THU_FRI, timeZone: Z });
  assert.deepEqual(amsterdam.intervals, [
    [ams('2026-11-05', '10:00'), ams('2026-11-05', '11:00')],
    [ams('2026-11-06', '00:00'), ams('2026-11-07', '00:00')]
  ]);
  assert.deepEqual(amsterdam.allDay.map((d) => [d.title, d.startDate, d.endDate, d.busy]), [['Vacation', '2026-11-06', '2026-11-07', true]]);
  // Asked in New York, the same day sits six hours later.
  const newYork = await calendars.busyTimes({ start: ny('2026-11-05', '00:00'), end: ny('2026-11-07', '00:00'), timeZone: NY });
  assert.deepEqual(newYork.intervals.at(-1), [ny('2026-11-06', '00:00'), ny('2026-11-07', '00:00')]);
});

test('free time in working hours in Amsterdam, shown in Amsterdam, while the PC is in New York', async () => {
  const { calendars, engine } = setup(fakeCalendar({ events }));
  const result = await free(calendars, engine.settings, null, { ...THU_FRI, length: 30, hours: 'working', timeZone: Z, locale: 'en' });
  assert.equal(result.timeZone, Z);
  assert.deepEqual(result.windows, [
    [ams('2026-11-05', '09:00'), ams('2026-11-05', '10:00')],
    [ams('2026-11-05', '11:00'), ams('2026-11-05', '17:00')]
  ], 'Friday is the vacation day there');
  assert.deepEqual(result.lines, ['Thu 5 Nov: 09:00–10:00, 11:00–17:00']);
  const dutch = await free(calendars, engine.settings, null, { ...THU_FRI, length: 30, hours: 'working', timeZone: Z, locale: 'nl' });
  assert.deepEqual(dutch.lines, formatFreeTimes(dutch.windows, { locale: 'nl-NL', timeZone: Z }));
  assert.notDeepEqual(dutch.lines, result.lines);
  const long = await free(calendars, engine.settings, null, { ...THU_FRI, length: 90, hours: 'working', timeZone: Z, locale: 'en' });
  assert.deepEqual(long.windows, [[ams('2026-11-05', '11:00'), ams('2026-11-05', '17:00')]], 'only windows of the length asked for');
});

test("booking hours keep the booking page's zone; the result is shown in the PC's zone by default", async () => {
  const { calendars, engine } = setup(fakeCalendar({ events }));
  const nine = [['09:00', '17:00']];
  const booking = { weekly: [[], nine, nine, nine, nine, nine, []], overrides: {}, timeZone: Z };
  const result = await free(calendars, engine.settings, booking, { ...THU_FRI, length: 30, hours: 'booking', locale: 'en' });
  assert.equal(result.timeZone, NY);
  assert.deepEqual(result.windows, [
    [ams('2026-11-05', '09:00'), ams('2026-11-05', '10:00')],
    [ams('2026-11-05', '11:00'), ams('2026-11-05', '17:00')]
  ], "the vacation blocks Friday in the booking page's zone, as the page itself does");
  assert.deepEqual(result.lines, ['Thu 5 Nov: 03:00–04:00, 05:00–11:00']);
  // Without a booking page, booking hours are the working hours, here in the PC's own zone.
  const fallback = await free(calendars, engine.settings, null, { ...THU_FRI, length: 30, hours: 'booking', locale: 'en' });
  assert.deepEqual(fallback.windows[0], [ny('2026-11-05', '09:00'), ny('2026-11-05', '17:00')]);
});
