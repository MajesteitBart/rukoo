'use strict';

// free(): open time on the calendars that count toward availability, for the availability panel, the composer and
// find_free_time. Zone cases with the PC elsewhere are in calendar-zones.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { t, setLanguage } = require('../src/i18n');
const { zonedInstant } = require('../src/main/calendar/zone');
const { free } = require('../src/main/calendar/free');
const { fakeCalendar, setup } = require('./fixtures/google-calendar');

const Z = 'Europe/Amsterdam';
const ams = (date, time) => zonedInstant(date, time, Z);
const iso = (ms) => new Date(ms).toISOString();
const mine = { organizer: { email: 'me@example.com', self: true } };
const timed = (id, date, from, to, extra = {}) => ({ id, summary: id, start: { dateTime: iso(ams(date, from)), timeZone: Z }, end: { dateTime: iso(ams(date, to)), timeZone: Z }, ...mine, ...extra });
const WEEK = { start: ams('2026-11-02', '00:00'), end: ams('2026-11-09', '00:00') };
// A Google account whose calendar was never connected, and one whose grant lost it (its cache still has the calendar).
const NO_CALENDAR = { id: 'g2', type: 'imap', provider: 'google', auth: 'oauth2', email: 'old@example.com', secret: 'rt' };
const LOST = { id: 'g3', type: 'imap', provider: 'google', auth: 'oauth2', email: 'lost@example.com', secret: 'rt' };
function lostCache(dataDir) {
  fs.mkdirSync(path.join(dataDir, 'calendar'), { recursive: true });
  const cal = { id: 'lost@example.com', name: 'lost@example.com', primary: true, writable: true, selected: true, owned: true };
  fs.writeFileSync(path.join(dataDir, 'calendar', 'g3.json'), JSON.stringify({ calendars: [cal], events: [] }));
}

test('working hours from the settings, busy time taken out, with the calendars checked and the accounts that failed', async () => {
  const fake = fakeCalendar({
    events: [
      timed('Standup', '2026-11-02', '09:00', '09:30'),
      timed('Lunch', '2026-11-02', '12:00', '13:00'),
      timed('Free slot', '2026-11-02', '14:00', '15:00', { transparency: 'transparent' }),
      { id: 'Team day', summary: 'Team day', start: { date: '2026-11-03' }, end: { date: '2026-11-04' }, transparency: 'transparent', ...mine },
      { id: 'other', calendarId: 'team@example.com', summary: 'Not counted', start: { dateTime: iso(ams('2026-11-02', '15:00')) }, end: { dateTime: iso(ams('2026-11-02', '16:00')) }, ...mine }
    ]
  });
  const { calendars, engine, dataDir } = setup(fake, { extra: [NO_CALENDAR, LOST] });
  lostCache(dataDir);
  engine.calendarSettings({ workDays: [1, 2], workStart: '09:00', workEnd: '17:00' });
  const result = await free(calendars, engine.settings, null, { start: WEEK.start, end: WEEK.end, length: 60, hours: 'working', timeZone: Z, locale: 'en' });
  assert.deepEqual(result.windows, [
    [ams('2026-11-02', '09:30'), ams('2026-11-02', '12:00')],
    [ams('2026-11-02', '13:00'), ams('2026-11-02', '17:00')],
    [ams('2026-11-03', '09:00'), ams('2026-11-03', '17:00')]
  ]);
  assert.deepEqual(result.lines, ['Mon 2 Nov: 09:30–12:00, 13:00–17:00', 'Tue 3 Nov: 09:00–17:00']);
  assert.deepEqual(result.allDay.map((d) => [d.title, d.busy]), [['Team day', false]], 'shown in the day header, though free');
  assert.deepEqual(result.checked, [{ accountId: 'g1', calendarId: 'me@example.com', name: 'me@example.com', email: 'me@example.com' }], 'not the calendar that failed');
  assert.deepEqual(result.failed, [{ accountId: 'g3', email: 'lost@example.com', code: 'reconnect' }], 'never taken as free; the account without a calendar has nothing to check');

  // A read that fails takes its calendars out of checked too.
  const down = setup(fakeCalendar({ fail: ({ url }) => (url.pathname.endsWith('/events') ? { status: 500, body: { error: { message: 'down' } } } : null) }));
  const none = await free(down.calendars, down.engine.settings, null, { start: WEEK.start, end: WEEK.end, length: 60, hours: 'working', timeZone: Z, locale: 'en' });
  assert.deepEqual([none.checked, none.failed.map((f) => [f.accountId, f.code])], [[], [['g1', 'request']]]);
  assert.equal(result.timeZone, Z);

  // Any time: the whole range, still without the busy time; a 12-hour clock when asked.
  const any = await free(calendars, engine.settings, null, { start: ams('2026-11-02', '08:00'), end: ams('2026-11-02', '18:00'), length: 30, hours: 'any', timeZone: Z, locale: 'en', hour12: true });
  assert.deepEqual(any.windows[0], [ams('2026-11-02', '08:00'), ams('2026-11-02', '09:00')]);
  assert.match(any.lines[0], /^Mon 2 Nov: 8:00 am – 9:00 am, /i);
});

test("the language of the lines follows the request, or Rukoo's own", async () => {
  const { calendars, engine } = setup(fakeCalendar());
  const opts = { start: ams('2026-11-02', '00:00'), end: ams('2026-11-03', '00:00'), length: 60, hours: 'working', timeZone: Z };
  const english = await free(calendars, engine.settings, null, { ...opts, locale: 'en' });
  const dutch = await free(calendars, engine.settings, null, { ...opts, locale: 'nl' });
  assert.deepEqual(english.lines, ['Mon 2 Nov: 09:00–17:00']);
  assert.match(dutch.lines[0], /^ma 2 nov\.?: 09:00–17:00$/);
  setLanguage('nl');
  try {
    assert.deepEqual((await free(calendars, engine.settings, null, opts)).lines, dutch.lines);
  } finally {
    setLanguage('en');
  }
});

test('free time refuses lengths and ranges it does not look at, and zones it does not know', async () => {
  const { calendars, engine } = setup(fakeCalendar());
  const ok = { start: WEEK.start, end: WEEK.end, length: 30, hours: 'working', timeZone: Z };
  const refused = (err) => err.code === 'invalid' && err.message === t('errors.calendar.invalidFree');
  await assert.rejects(free(calendars, engine.settings, null, { ...ok, length: 4 }), refused);
  await assert.rejects(free(calendars, engine.settings, null, { ...ok, length: 481 }), refused);
  await assert.rejects(free(calendars, engine.settings, null, { ...ok, length: 30.5 }), refused);
  await assert.rejects(free(calendars, engine.settings, null, { ...ok, end: ok.start + 32 * 86400000 }), refused);
  await assert.rejects(free(calendars, engine.settings, null, { ...ok, end: ok.start }), refused);
  await assert.rejects(free(calendars, engine.settings, null, { ...ok, timeZone: 'Nowhere/Land' }), (err) => err.code === 'invalid' && err.message === t('errors.calendar.invalidZone'));
  await assert.rejects(free(calendars, engine.settings, { weekly: 'nope', overrides: {}, timeZone: Z }, { ...ok, hours: 'booking' }), refused);
  // Booking overrides block a day or give it other hours.
  const nine = [['09:00', '17:00']];
  const booking = { weekly: [[], nine, nine, nine, nine, nine, []], overrides: { '2026-11-02': [], '2026-11-03': [['13:00', '14:00']] }, timeZone: Z };
  const result = await free(calendars, engine.settings, booking, { start: ams('2026-11-02', '00:00'), end: ams('2026-11-04', '00:00'), length: 30, hours: 'booking', timeZone: Z, locale: 'en' });
  assert.deepEqual(result.windows, [[ams('2026-11-03', '13:00'), ams('2026-11-03', '14:00')]]);
});
