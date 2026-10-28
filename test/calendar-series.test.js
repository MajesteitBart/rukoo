'use strict';

// Changes to whole series on Google Calendar: all events (moved on the clock, with the rule following the day), this
// and following (a split with COUNT, moved and deleted occurrences, EXDATEs, and a rollback), and deleting this and
// following. The series live in Europe/Amsterdam around the clock change of 25 October 2026, whatever zone the PC is
// in.
const test = require('node:test');
const assert = require('node:assert/strict');
const { t } = require('../src/i18n');
const { moveRule, countBefore, shiftLines, splitId } = require('../src/main/calendar/google');
const { zonedInstant, zonedParts } = require('../src/main/calendar/zone');
const { fakeCalendar, setup, settle } = require('./fixtures/google-calendar');

const Z = 'Europe/Amsterdam';
const ams = (date, time) => zonedInstant(date, time, Z);
const iso = (ms) => new Date(ms).toISOString();
const basic = (ms) => iso(ms).replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const slot = (date, from, to) => ({ start: { dateTime: iso(ams(date, from)), timeZone: Z }, end: { dateTime: iso(ams(date, to)), timeZone: Z } });
const RANGE = { start: Date.UTC(2026, 8, 28), end: Date.UTC(2026, 11, 21) };
const mine = { organizer: { email: 'me@example.com', self: true } };
const guests = [
  { email: 'me@example.com', self: true, organizer: true, responseStatus: 'accepted' },
  { email: 'joris@example.com', responseStatus: 'accepted' }
];
const master = (extra = {}) => ({ id: 'sync', summary: 'Team sync', ...slot('2026-10-05', '10:00', '10:30'), recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=10'], attendees: guests, ...mine, ...extra });
const exception = (date, extra) => ({ id: `sync_${basic(ams(date, '10:00'))}`, recurringEventId: 'sync', originalStartTime: { dateTime: iso(ams(date, '10:00')), timeZone: Z }, summary: 'Team sync', ...slot(date, '10:00', '10:30'), attendees: guests, ...mine, ...extra });

async function open(events, opts = {}) {
  const fake = fakeCalendar({ events, ...opts });
  const ctx = setup(fake);
  ctx.fake = fake;
  ctx.calendars.view(RANGE);
  await settle(ctx.calendars);
  ctx.events = () => ctx.calendars.view(RANGE).events;
  // The occurrence on a date, as the Amsterdam clock reads it.
  ctx.on = (date) => ctx.events().find((e) => zonedParts(e.start, Z).date === date);
  ctx.clock = () => ctx.events().map((e) => `${zonedParts(e.start, Z).date} ${zonedParts(e.start, Z).time} ${e.title}`);
  ctx.changes = [];
  ctx.calendars.on('changed', (c) => ctx.changes.push(c));
  return ctx;
}

const input = (e, changes = {}) => ({ accountId: e.accountId, calendarId: e.calendarId, title: e.title, location: e.location, description: e.description, allDay: e.allDay, start: e.start, end: e.end, startDate: e.startDate, endDate: e.endDate, ...changes });
const requests = (fake, method, pathEnd) => fake.requests.filter((r) => r.method === method && (!pathEnd || r.path.endsWith(pathEnd)));

test('the rule helpers: a moved first occurrence takes its weekday, month day, nth weekday and month along', () => {
  assert.equal(moveRule('FREQ=WEEKLY;BYDAY=MO;WKST=MO', '2026-10-05', '2026-10-06'), 'FREQ=WEEKLY;BYDAY=TU;WKST=MO');
  assert.equal(moveRule('FREQ=WEEKLY;BYDAY=MO', '2026-10-05', '2026-10-12'), 'FREQ=WEEKLY;BYDAY=MO', 'a week later is the same weekday');
  assert.equal(moveRule('FREQ=WEEKLY;BYDAY=MO,WE', '2026-10-05', '2026-10-12'), 'FREQ=WEEKLY;BYDAY=MO,WE');
  assert.throws(() => moveRule('FREQ=WEEKLY;BYDAY=MO,WE', '2026-10-05', '2026-10-06'), (err) => err.code === 'refused' && err.message === t('errors.calendar.seriesDayChange'));
  assert.equal(moveRule('FREQ=MONTHLY;BYDAY=2TU', '2026-10-13', '2026-10-20'), 'FREQ=MONTHLY;BYDAY=3TU');
  assert.equal(moveRule('FREQ=MONTHLY;BYDAY=-1FR', '2026-10-30', '2026-10-29'), 'FREQ=MONTHLY;BYDAY=-1TH', 'still in the last week');
  assert.equal(moveRule('FREQ=MONTHLY;BYDAY=-1FR', '2026-10-30', '2026-10-16'), 'FREQ=MONTHLY;BYDAY=3FR');
  assert.equal(moveRule('FREQ=MONTHLY;BYMONTHDAY=15', '2026-10-15', '2026-10-16'), 'FREQ=MONTHLY;BYMONTHDAY=16');
  assert.throws(() => moveRule('FREQ=MONTHLY;BYMONTHDAY=1,15', '2026-10-15', '2026-10-16'), (err) => err.code === 'refused');
  assert.equal(moveRule('FREQ=YEARLY;BYMONTH=10;BYMONTHDAY=5', '2026-10-05', '2026-11-06'), 'FREQ=YEARLY;BYMONTH=11;BYMONTHDAY=6');
  assert.equal(moveRule('FREQ=DAILY;COUNT=5', '2026-10-05', '2026-10-09'), 'FREQ=DAILY;COUNT=5', 'nothing names the day');
  // COUNT counts occurrences an EXDATE took out, and all-day series count by date.
  assert.equal(countBefore('FREQ=WEEKLY;BYDAY=MO;COUNT=10', { date: '2026-10-05', minutes: 600 }, { date: '2026-10-26', minutes: 600 }, false), 3);
  assert.equal(countBefore('FREQ=WEEKLY;BYDAY=MO,WE;COUNT=10', { date: '2026-10-05', minutes: 600 }, { date: '2026-10-14', minutes: 600 }, false), 3);
  assert.equal(countBefore('FREQ=DAILY;COUNT=5', { date: '2026-11-02', minutes: 0 }, { date: '2026-11-04', minutes: 0 }, true), 2);
  assert.equal(splitId('sync', 1), splitId('sync', 1), 'a retry makes the same id');
  assert.match(splitId('sync', 1), /^[a-v0-9]{26}$/);
  assert.notEqual(splitId('sync', 1), splitId('sync', 2));
});

test('series() gives the rule, the other lines as they are, the EXDATEs and the version to send back', async () => {
  const lines = ['RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=10', 'EXDATE;TZID=Europe/Amsterdam:20261019T100000', 'RDATE;VALUE=DATE:20261231'];
  const { calendars, on } = await open([master({ recurrence: lines, etag: '"7"' })]);
  const info = await calendars.series(on('2026-10-12').id);
  assert.deepEqual(info, {
    rule: 'FREQ=WEEKLY;BYDAY=MO;COUNT=10',
    rules: ['FREQ=WEEKLY;BYDAY=MO;COUNT=10'],
    extra: lines.slice(1),
    exdates: [ams('2026-10-19', '10:00')],
    start: ams('2026-10-05', '10:00'),
    end: ams('2026-10-05', '10:30'),
    allDay: false,
    startDate: null,
    endDate: null,
    timeZone: Z,
    etag: '"7"'
  });
});

test('all events: a move by a week across the clock change keeps the series at 10:00, and a move by a day takes the rule along', async () => {
  const { calendars, fake, on, events, changes } = await open([master()]);
  assert.equal(events().length, 10);
  const opened = on('2026-10-19');
  const { etag } = await calendars.series(opened.id);
  // A week later on the clock is a week and an hour later in time, because the clocks go back on 25 October.
  const moved = await calendars.update(opened.id, input(opened, { start: ams('2026-10-26', '10:00'), end: ams('2026-10-26', '10:30') }), { scope: 'all', seriesEtag: etag, etag: opened.etag });
  const patch = requests(fake, 'PATCH').pop();
  assert.equal(patch.path, '/calendars/me@example.com/events/sync');
  assert.equal(patch.ifMatch, etag);
  assert.deepEqual([patch.body.start.dateTime, patch.body.end.dateTime], [iso(ams('2026-10-12', '10:00')), iso(ams('2026-10-12', '10:30'))]);
  assert.equal('summary' in patch.body, false, 'only what changed goes to the series');
  assert.equal('recurrence' in patch.body, false, 'Monday is still Monday');
  assert.equal(moved.start, ams('2026-10-26', '10:00'));
  assert.equal(moved.seriesId, 'sync');
  assert.ok(events().every((e) => zonedParts(e.start, Z).time === '10:00'), 'every occurrence on screen moved, at 10:00 on both sides of the change');
  assert.equal(events().length, 10, 'COUNT stays');
  assert.deepEqual([changes.at(-1).kind, changes.at(-1).scope, changes.at(-1).event.id], ['series', 'all', moved.id]);

  // To Tuesday at 11:00, from a drag that knows no version of the series: the store asks for it.
  const nov = on('2026-11-02');
  const version = fake.store[0].etag;
  const tuesday = await calendars.update(nov.id, input(nov, { start: ams('2026-11-03', '11:00'), end: ams('2026-11-03', '11:30') }), { scope: 'all', etag: nov.etag });
  const second = requests(fake, 'PATCH').pop();
  assert.equal(second.ifMatch, version, "the series' current version");
  assert.equal(second.body.start.dateTime, iso(ams('2026-10-13', '11:00')));
  assert.deepEqual(second.body.recurrence, ['RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=10']);
  assert.equal(tuesday.start, ams('2026-11-03', '11:00'));
  assert.ok(events().every((e) => zonedParts(e.start, Z).weekday === 2 && zonedParts(e.start, Z).time === '11:00'));
});

test("a new zone that puts the series' start on another date takes the rule along, for all events and for this and following", async () => {
  // Tuesdays at 08:00 in Amsterdam are Mondays at 23:00 in Los Angeles, where Google repeats the series after the change.
  const LA = 'America/Los_Angeles';
  const tuesdays = (extra = {}) => master({ ...slot('2026-11-03', '08:00', '08:30'), recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=6'], ...extra });
  const dates = ['2026-11-03', '2026-11-10', '2026-11-17', '2026-11-24', '2026-12-01', '2026-12-08'].map((d) => `${d} 08:00 Team sync`);

  const all = await open([tuesdays()]);
  const opened = all.on('2026-11-10');
  const { etag } = await all.calendars.series(opened.id);
  await all.calendars.update(opened.id, input(opened, { timeZone: LA }), { scope: 'all', seriesEtag: etag, etag: opened.etag });
  const patch = requests(all.fake, 'PATCH').pop();
  assert.deepEqual(patch.body.start, { date: null, dateTime: iso(ams('2026-11-03', '08:00')), timeZone: LA });
  assert.deepEqual(patch.body.recurrence, ['RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=6']);
  assert.deepEqual(all.clock(), dates, 'still Tuesday at 08:00 in Amsterdam');

  // This and following, with an EXDATE and a deleted occurrence after the split: both stay deleted in the new zone.
  const exdate = `EXDATE;TZID=${Z}:20261124T080000`;
  const gone = { id: `sync_${basic(ams('2026-12-01', '08:00'))}`, recurringEventId: 'sync', originalStartTime: { dateTime: iso(ams('2026-12-01', '08:00')), timeZone: Z }, ...slot('2026-12-01', '08:00', '08:30'), status: 'cancelled', ...mine };
  const following = await open([tuesdays({ recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=6', exdate] }), gone]);
  const split = following.on('2026-11-17');
  await following.calendars.update(split.id, input(split, { timeZone: LA }), { scope: 'following', etag: split.etag });
  const post = requests(following.fake, 'POST').pop();
  assert.deepEqual(post.body.start, { dateTime: iso(ams('2026-11-17', '08:00')), timeZone: LA });
  assert.deepEqual(post.body.recurrence, ['RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=4', `EXDATE;TZID=${LA}:20261123T230000`, `EXDATE;TZID=${LA}:20261130T230000`]);
  assert.deepEqual(following.clock(), [dates[0], dates[1], dates[2], dates[5]]);
});

test('the line helper moves EXDATE and RDATE values on the clock, into another zone, and between all-day and timed', () => {
  const lines = ['EXDATE;TZID=Europe/Amsterdam:20261019T100000,20261102T100000', 'RDATE;TZID=Europe/Amsterdam:20261231T100000', 'EXDATE:20261116T090000Z', 'EXRULE:FREQ=MONTHLY'];
  // An hour later, across the clock change of 25 October: still on the hour on the clock. A UTC value is read on it.
  assert.deepEqual(shiftLines(lines, Z, Z, false, 60), [
    'EXDATE;TZID=Europe/Amsterdam:20261019T110000,20261102T110000',
    'RDATE;TZID=Europe/Amsterdam:20261231T110000',
    'EXDATE;TZID=Europe/Amsterdam:20261116T110000',
    'EXRULE:FREQ=MONTHLY'
  ]);
  assert.deepEqual(shiftLines(lines, Z, Z, false, 0), lines, 'nothing moved, nothing rewritten');
  assert.deepEqual(shiftLines(lines.slice(0, 1), Z, Z, true, -600), ['EXDATE;VALUE=DATE:20261019,20261102'], 'timed to all-day');
  assert.deepEqual(shiftLines(['EXDATE;VALUE=DATE:20261019'], Z, Z, false, 1440 + 540), ['EXDATE;TZID=Europe/Amsterdam:20261020T090000'], 'all-day to timed, a day later');
  assert.deepEqual(shiftLines(lines.slice(0, 1), Z, 'Europe/London', false, -60), ['EXDATE;TZID=Europe/London:20261019T090000,20261102T090000'], 'the same meetings in London');
});

test('all events: a move keeps deleted occurrences deleted, the EXDATEs and the ones Google keeps as cancelled', async () => {
  const lines = ['RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=10', 'EXDATE;TZID=Europe/Amsterdam:20261019T100000'];
  const { calendars, fake, on, clock } = await open([master({ recurrence: lines }), exception('2026-11-09', { status: 'cancelled' })]);
  const before = ['2026-10-05', '2026-10-12', '2026-10-26', '2026-11-02', '2026-11-16', '2026-11-23', '2026-11-30', '2026-12-07'];
  assert.deepEqual(clock(), before.map((d) => `${d} 10:00 Team sync`));
  const opened = on('2026-10-12');
  await calendars.update(opened.id, input(opened, { start: ams('2026-10-12', '11:00'), end: ams('2026-10-12', '11:30') }), { scope: 'all', etag: opened.etag });
  const patch = requests(fake, 'PATCH').pop();
  assert.deepEqual(patch.body.recurrence, ['RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=10', 'EXDATE;TZID=Europe/Amsterdam:20261019T110000', 'EXDATE;TZID=Europe/Amsterdam:20261109T110000']);
  assert.deepEqual(clock(), before.map((d) => `${d} 11:00 Team sync`), 'the same weeks, an hour later');

  // Then to Tuesdays: the dates move along. Google's cancelled 9 November is at 10:00 now, so it stays out.
  const nov = on('2026-11-02');
  await calendars.update(nov.id, input(nov, { start: ams('2026-11-03', '11:00'), end: ams('2026-11-03', '11:30') }), { scope: 'all', etag: nov.etag });
  assert.deepEqual(requests(fake, 'PATCH').pop().body.recurrence, ['RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=10', 'EXDATE;TZID=Europe/Amsterdam:20261020T110000', 'EXDATE;TZID=Europe/Amsterdam:20261110T110000']);
  assert.deepEqual(clock(), ['2026-10-06', '2026-10-13', '2026-10-27', '2026-11-03', '2026-11-17', '2026-11-24', '2026-12-01', '2026-12-08'].map((d) => `${d} 11:00 Team sync`));

  // A longer meeting leaves the starts, and the lines, as they are.
  const reads = requests(fake, 'GET').length;
  const dec = on('2026-12-01');
  await calendars.update(dec.id, input(dec, { end: ams('2026-12-01', '12:00') }), { scope: 'all', etag: dec.etag });
  assert.equal(requests(fake, 'PATCH').pop().body.recurrence, undefined);
  assert.equal(requests(fake, 'GET').slice(reads).filter((r) => r.query.iCalUID).length, 0, 'no need to look for deleted occurrences');
});

test('all events: several weekdays and a day change are refused, and so is a version of the series that is out of date', async () => {
  const { calendars, fake, on, events } = await open([master({ recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=10'] })]);
  const opened = on('2026-10-07');
  const patches = requests(fake, 'PATCH').length;
  await assert.rejects(
    calendars.update(opened.id, input(opened, { start: ams('2026-10-08', '10:00'), end: ams('2026-10-08', '10:30') }), { scope: 'all', etag: opened.etag }),
    (err) => err.code === 'refused' && err.message === t('errors.calendar.seriesDayChange')
  );
  await assert.rejects(calendars.update(opened.id, input(opened, { title: 'Renamed' }), { scope: 'all', etag: opened.etag, seriesEtag: '"0"' }), (err) => err.code === 'changed');
  assert.equal(requests(fake, 'PATCH').length, patches, 'nothing went out');
  // Another time on the same days works.
  await calendars.update(opened.id, input(opened, { start: ams('2026-10-07', '14:00'), end: ams('2026-10-07', '14:30') }), { scope: 'all', etag: opened.etag });
  assert.ok(events().every((e) => zonedParts(e.start, Z).time === '14:00'));
  assert.equal(requests(fake, 'PATCH').pop().body.recurrence, undefined);
  // A new rule replaces the old one, keeping the series' other lines.
  fake.store[0].recurrence.push('EXDATE;TZID=Europe/Amsterdam:20261019T140000');
  const now = on('2026-10-12');
  await calendars.update(now.id, input(now, { recurrence: 'FREQ=WEEKLY;BYDAY=MO;COUNT=4;WKST=MO' }), { scope: 'all', etag: now.etag });
  assert.deepEqual(requests(fake, 'PATCH').pop().body.recurrence, ['RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=4;WKST=MO', 'EXDATE;TZID=Europe/Amsterdam:20261019T140000']);
});

test('this and following: COUNT goes on, a moved occurrence splits where it belonged, and changed and deleted occurrences move to the new series', async () => {
  const lines = ['RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=10', 'EXDATE;TZID=Europe/Amsterdam:20261019T100000', 'EXDATE;TZID=Europe/Amsterdam:20261116T100000'];
  const { calendars, fake, on, clock, changes } = await open([
    master({ recurrence: lines, conferenceData: { conferenceId: 'abc', conferenceSolution: { key: { type: 'hangoutsMeet' } }, entryPoints: [{ entryPointType: 'video', uri: 'https://meet.google.com/abc' }] }, hangoutLink: 'https://meet.google.com/abc', reminders: { useDefault: false, overrides: [{ method: 'email', minutes: 60 }] }, extendedProperties: { private: { rukooNote: 'x' } } }),
    exception('2026-10-12', { status: 'cancelled' }),
    // This week's meeting moved to Tuesday, and the one of 9 November moved and renamed.
    exception('2026-10-26', slot('2026-10-27', '10:00', '10:30')),
    exception('2026-11-09', { summary: 'Sync (moved)', ...slot('2026-11-10', '10:00', '10:30') }),
    exception('2026-11-23', { status: 'cancelled' })
  ]);
  assert.deepEqual(clock(), [
    '2026-10-05 10:00 Team sync',
    '2026-10-27 10:00 Team sync',
    '2026-11-02 10:00 Team sync',
    '2026-11-10 10:00 Sync (moved)',
    '2026-11-30 10:00 Team sync',
    '2026-12-07 10:00 Team sync'
  ]);
  const opened = on('2026-10-27');
  assert.equal(opened.originalStart, ams('2026-10-26', '10:00'));
  const edited = await calendars.update(opened.id, input(opened, { start: ams('2026-10-27', '11:00'), end: ams('2026-10-27', '11:30') }), { scope: 'following', notify: true, etag: opened.etag });

  const post = requests(fake, 'POST').pop();
  assert.equal(post.body.id, splitId('sync', ams('2026-10-26', '10:00')));
  assert.equal(post.query.sendUpdates, 'all');
  assert.equal(post.body.start.dateTime, iso(ams('2026-10-27', '11:00')));
  // Three occurrences came before the split, the deleted and the EXDATE'd one included; EXDATEs after it moved along.
  assert.deepEqual(post.body.recurrence, ['RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=7', 'EXDATE;TZID=Europe/Amsterdam:20261117T110000', 'EXDATE;TZID=Europe/Amsterdam:20261124T110000']);
  assert.deepEqual(post.body.conferenceData, { conferenceId: 'abc', conferenceSolution: { key: { type: 'hangoutsMeet' } }, entryPoints: [{ entryPointType: 'video', uri: 'https://meet.google.com/abc' }] }, 'the same Meet, no new request');
  assert.deepEqual(post.body.reminders, { useDefault: false, overrides: [{ method: 'email', minutes: 60 }] });
  assert.deepEqual(post.body.extendedProperties, { private: { rukooNote: 'x' } });
  assert.deepEqual(post.body.attendees.map((a) => a.email), ['me@example.com', 'joris@example.com']);

  const cut = requests(fake, 'PATCH', '/events/sync').pop();
  assert.deepEqual(cut.body.recurrence, ['RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20261026T085959Z', 'EXDATE;TZID=Europe/Amsterdam:20261019T100000']);
  assert.equal(cut.ifMatch, '"1"');
  assert.ok(requests(fake, 'POST').indexOf(post) >= 0 && fake.requests.indexOf(post) < fake.requests.indexOf(cut), 'the new series first');
  // The old series' moved occurrences are gone; the guests aren't told about that separately.
  const deleted = requests(fake, 'DELETE');
  assert.deepEqual(deleted.map((r) => r.path.split('/').pop()).sort(), [exception('2026-10-26').id, exception('2026-11-09').id].sort());
  assert.ok(deleted.every((r) => r.query.sendUpdates === 'none'));

  assert.deepEqual(clock(), [
    '2026-10-05 10:00 Team sync',
    '2026-10-27 11:00 Team sync',
    '2026-11-03 11:00 Team sync',
    '2026-11-10 10:00 Sync (moved)',
    '2026-12-01 11:00 Team sync',
    '2026-12-08 11:00 Team sync'
  ]);
  assert.deepEqual([edited.start, edited.seriesId], [ams('2026-10-27', '11:00'), post.body.id]);
  assert.match(edited.meeting, /meet\.google\.com\/abc/);
  assert.deepEqual([changes.at(-1).kind, changes.at(-1).scope, changes.at(-1).event.id], ['series', 'following', edited.id]);
});

test('this and following without new times keeps the rule, the start and the moved occurrence', async () => {
  const { calendars, fake, on, clock } = await open([master(), exception('2026-11-09', { summary: 'Sync (moved)', ...slot('2026-11-10', '10:00', '10:30') })]);
  const opened = on('2026-11-02');
  const edited = await calendars.update(opened.id, input(opened, { title: 'Team sync v2' }), { scope: 'following', etag: opened.etag });
  const post = requests(fake, 'POST').pop();
  assert.deepEqual([post.body.start.dateTime, post.body.summary], [iso(ams('2026-11-02', '10:00')), 'Team sync v2']);
  assert.deepEqual(post.body.recurrence, ['RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=6']);
  assert.deepEqual(requests(fake, 'PATCH', '/events/sync').pop().body.recurrence, ['RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20261102T085959Z']);
  // The renamed and moved occurrence keeps its own title and time in the new series.
  const copied = fake.requests.find((r) => r.path.endsWith(`/events/${post.body.id}/instances`));
  assert.equal(copied.query.originalStart, iso(ams('2026-11-09', '10:00')));
  assert.deepEqual(clock(), [
    '2026-10-05 10:00 Team sync',
    '2026-10-12 10:00 Team sync',
    '2026-10-19 10:00 Team sync',
    '2026-10-26 10:00 Team sync',
    '2026-11-02 10:00 Team sync v2',
    '2026-11-10 10:00 Sync (moved)',
    '2026-11-16 10:00 Team sync v2',
    '2026-11-23 10:00 Team sync v2',
    '2026-11-30 10:00 Team sync v2',
    '2026-12-07 10:00 Team sync v2'
  ]);
  assert.equal(edited.title, 'Team sync v2');
});

test('this and following without a repeat: the series ends before it and the occurrence becomes one event, also with changed occurrences after it', async () => {
  const { calendars, fake, on, clock, changes } = await open([master(), exception('2026-11-09', { summary: 'Renamed one' })]);
  const opened = on('2026-11-02');
  const single = await calendars.update(opened.id, input(opened, { recurrence: null }), { scope: 'following', etag: opened.etag });
  const post = requests(fake, 'POST').pop();
  assert.equal(post.body.id, splitId('sync', ams('2026-11-02', '10:00'), true));
  assert.notEqual(post.body.id, splitId('sync', ams('2026-11-02', '10:00')), 'not the id a new series would get');
  assert.equal('recurrence' in post.body, false);
  assert.equal(post.body.start.dateTime, iso(ams('2026-11-02', '10:00')));
  assert.equal(fake.requests.some((r) => r.path.endsWith('/instances')), false, 'one event has no occurrences to copy changes to');
  assert.deepEqual(requests(fake, 'PATCH', '/events/sync').pop().body.recurrence, ['RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20261102T085959Z']);
  assert.equal(requests(fake, 'DELETE').pop().path.split('/').pop(), exception('2026-11-09').id, 'the changed occurrence after it goes with the rest');
  assert.deepEqual(clock(), ['2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26', '2026-11-02'].map((d) => `${d} 10:00 Team sync`));
  assert.deepEqual([single.eventId, single.seriesId, single.recurring, single.start], [post.body.id, null, false, ams('2026-11-02', '10:00')]);
  assert.deepEqual([changes.at(-1).kind, changes.at(-1).scope, changes.at(-1).event.id], ['series', 'following', single.id]);
});

test('this and following without a repeat on an occurrence changed before: the one event keeps its own time and fields', async () => {
  const { calendars, fake, on, clock } = await open([master(), exception('2026-11-09', { summary: 'Sync (moved)', location: 'Room 2', ...slot('2026-11-10', '10:00', '10:30') })]);
  const opened = on('2026-11-10');
  const single = await calendars.update(opened.id, input(opened, { title: 'Last sync', recurrence: null }), { scope: 'following', etag: opened.etag });
  const post = requests(fake, 'POST').pop();
  assert.deepEqual([post.body.start.dateTime, post.body.summary, post.body.location], [iso(ams('2026-11-10', '10:00')), 'Last sync', 'Room 2']);
  assert.deepEqual(clock(), [...['2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26', '2026-11-02'].map((d) => `${d} 10:00 Team sync`), '2026-11-10 10:00 Last sync']);
  assert.deepEqual([single.title, single.location, single.recurring], ['Last sync', 'Room 2', false]);
  assert.equal(fake.find(exception('2026-11-09').id).status, 'cancelled');
});

test('this and following at the first occurrence changes the whole series', async () => {
  const { calendars, fake, on } = await open([master()]);
  const first = on('2026-10-05');
  await calendars.update(first.id, input(first, { title: 'Renamed' }), { scope: 'following', etag: first.etag });
  assert.equal(requests(fake, 'POST').length, 0);
  assert.equal(requests(fake, 'PATCH', '/events/sync').pop().body.summary, 'Renamed');
});

test('a split whose old half can\'t be cut takes the new half back, and a later try works with the same id', async () => {
  let cutFails = true;
  const { calendars, fake, on, clock } = await open([master()], {
    fail: ({ method, url }) => (cutFails && method === 'PATCH' && url.pathname.endsWith('/events/sync') ? { status: 403, body: { error: { code: 403, message: 'Forbidden' } } } : null)
  });
  const before = clock();
  const opened = on('2026-11-02');
  const change = input(opened, { start: ams('2026-11-02', '11:00'), end: ams('2026-11-02', '11:30') });
  await assert.rejects(calendars.update(opened.id, change, { scope: 'following', notify: true, etag: opened.etag }), (err) => err.code === 'split_failed' && err.message === t('errors.calendar.splitFailed'));
  const made = requests(fake, 'POST').pop().body.id;
  const undo = requests(fake, 'DELETE').pop();
  assert.equal(undo.path, `/calendars/me@example.com/events/${made}`);
  assert.equal(undo.query.sendUpdates, 'all', 'the guests who got the new series hear it is gone');
  assert.deepEqual(clock(), before, 'the series is as it was');

  cutFails = false;
  const again = on('2026-11-02');
  const edited = await calendars.update(again.id, input(again, { start: ams('2026-11-02', '11:00'), end: ams('2026-11-02', '11:30') }), { scope: 'following', etag: again.etag });
  // Google keeps a deleted event's id, so the second try finds it and brings it back.
  const restore = requests(fake, 'PATCH', `/events/${made}`).pop();
  assert.equal(restore.body.status, 'confirmed');
  assert.equal(edited.start, ams('2026-11-02', '11:00'));
  assert.equal(clock().filter((line) => line.includes(' 11:00 ')).length, 6);
  assert.equal(clock().length, 10);
});

test('a split whose old half changed in the meantime is taken back and says the series changed', async () => {
  const { calendars, fake, on, clock } = await open([master()], {
    fail: ({ method, url }) => (method === 'PATCH' && url.pathname.endsWith('/events/sync') ? { status: 412, body: { error: { code: 412, message: 'Precondition Failed' } } } : null)
  });
  const before = clock();
  const opened = on('2026-11-02');
  await assert.rejects(calendars.update(opened.id, input(opened, { title: 'x' }), { scope: 'following', etag: opened.etag }), (err) => err.code === 'changed');
  const made = requests(fake, 'POST').pop().body.id;
  assert.equal(fake.store.find((e) => e.id === made).status, 'cancelled');
  assert.deepEqual(clock(), before);
});

const isCut = (r) => r.method === 'PATCH' && r.path === '/calendars/me@example.com/events/sync';
const earlier = ['2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26'].map((d) => `${d} 10:00 Team sync`);
const later = ['2026-11-02', '2026-11-09', '2026-11-16', '2026-11-23', '2026-11-30', '2026-12-07'].map((d) => `${d} 11:00 Team sync`);

test('a split whose cut Google made without the answer arriving keeps the new series, so no occurrence goes missing', async () => {
  // The answer is lost on the way back: the connection drops, or a gateway answers 502 instead.
  for (const lost of [true, 502]) {
    const { calendars, fake, on, clock } = await open([master(), exception('2026-11-09', { summary: 'Renamed one' })], { lose: ({ method, url }) => method === 'PATCH' && url.pathname.endsWith('/events/sync') && lost });
    const opened = on('2026-11-02');
    const edited = await calendars.update(opened.id, input(opened, { start: ams('2026-11-02', '11:00'), end: ams('2026-11-02', '11:30') }), { scope: 'following', etag: opened.etag });
    const made = requests(fake, 'POST').pop().body.id;
    const cut = fake.requests.findIndex(isCut);
    assert.ok(fake.requests.slice(cut + 1).some((r) => r.method === 'GET' && r.path.endsWith('/events/sync')), `${lost}: the old series is read again`);
    assert.equal(fake.store.find((e) => e.id === made).status, 'confirmed', `${lost}: the new series stays`);
    assert.equal(requests(fake, 'DELETE', `/events/${made}`).length, 0);
    // The split finishes: the old series' changed occurrence after the cut goes, and its change is in the new series.
    assert.equal(fake.find(exception('2026-11-09').id).status, 'cancelled');
    assert.deepEqual(clock(), [...earlier, later[0], '2026-11-09 11:00 Renamed one', ...later.slice(2)], String(lost));
    assert.equal(edited.start, ams('2026-11-02', '11:00'));
  }
});

test("a split whose cut may have been made, when Google can't be asked again, keeps both halves and a sync shows every occurrence", async () => {
  // The connection drops after Google made the cut, and stays down for the requests after it.
  let down = false;
  const { calendars, fake, on, clock } = await open([master()], {
    lose: (r) => {
      if (isCut({ method: r.method, path: decodeURIComponent(r.url.pathname.replace('/calendar/v3', '')) })) down = true;
      return down;
    }
  });
  const opened = on('2026-11-02');
  await assert.rejects(calendars.update(opened.id, input(opened, { start: ams('2026-11-02', '11:00'), end: ams('2026-11-02', '11:30') }), { scope: 'following', etag: opened.etag }), (err) => err.code === 'unsure' && err.partial === true && err.reason === 'network');
  const made = requests(fake, 'POST').pop().body.id;
  assert.equal(requests(fake, 'DELETE').length, 0, 'nothing is deleted on an outcome nobody knows');
  assert.equal(fake.store.find((e) => e.id === made).status, 'confirmed');
  down = false;
  await calendars.syncAll();
  assert.deepEqual(clock(), [...earlier, ...later]);
});

test('a split whose cut failed with a server error before Google made it reads the old series again and then takes the new half back', async () => {
  const { calendars, fake, on, clock } = await open([master()], {
    fail: ({ method, url }) => (method === 'PATCH' && url.pathname.endsWith('/events/sync') ? { status: 503, body: { error: { code: 503, message: 'Backend Error', errors: [{ reason: 'backendError' }] } } } : null)
  });
  const before = clock();
  const opened = on('2026-11-02');
  await assert.rejects(calendars.update(opened.id, input(opened, { title: 'x' }), { scope: 'following', etag: opened.etag }), (err) => err.code === 'split_failed');
  const made = requests(fake, 'POST').pop().body.id;
  assert.ok(fake.requests.slice(fake.requests.findIndex(isCut) + 1).some((r) => r.method === 'GET' && r.path.endsWith('/events/sync')), 'read again first');
  assert.equal(fake.store.find((e) => e.id === made).status, 'cancelled');
  assert.deepEqual(clock(), before);
});

test('deleting this and following whose cut Google made without the answer arriving is done', async () => {
  const { calendars, fake, on, clock } = await open([master(), exception('2026-11-09', { summary: 'Renamed one' })], { lose: ({ method, url }) => method === 'PATCH' && url.pathname.endsWith('/events/sync') });
  const opened = on('2026-11-02');
  await calendars.remove(opened.id, { scope: 'following', etag: opened.etag });
  assert.equal(fake.find(exception('2026-11-09').id).status, 'cancelled', 'the changed occurrence after the end goes too');
  assert.deepEqual(clock(), earlier);
});

test("deleting this and following whose cut may have been made, when Google can't be asked again, lets the cached stretch go", async () => {
  let down = false;
  const { calendars, fake, on, clock } = await open([master()], {
    lose: (r) => {
      if (isCut({ method: r.method, path: decodeURIComponent(r.url.pathname.replace('/calendar/v3', '')) })) down = true;
      return down;
    }
  });
  const updated = [];
  calendars.on('updated', () => updated.push(true));
  const opened = on('2026-11-02');
  await assert.rejects(calendars.remove(opened.id, { scope: 'following', etag: opened.etag }), (err) => err.code === 'unsure' && err.partial === true);
  assert.ok(updated.length > 0, 'the view is told to look again');
  // Back online, the next view fetches the stretch again and shows the series as Google has it: cut at the split.
  down = false;
  const reads = requests(fake, 'GET').length;
  clock();
  await settle(calendars);
  assert.ok(requests(fake, 'GET').length > reads, 'the stretch is fetched again');
  assert.deepEqual(clock(), earlier);
});

test('deleting this and following ends the series before it, and at the first occurrence deletes it', async () => {
  const { calendars, fake, on, clock, changes } = await open([master(), exception('2026-11-09', { summary: 'Sync (moved)', ...slot('2026-11-10', '10:00', '10:30') })]);
  const opened = on('2026-11-02');
  await calendars.remove(opened.id, { scope: 'following', notify: true, etag: opened.etag });
  const cut = requests(fake, 'PATCH', '/events/sync').pop();
  assert.deepEqual(cut.body.recurrence, ['RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20261102T085959Z']);
  assert.equal(cut.query.sendUpdates, 'all');
  assert.equal(requests(fake, 'DELETE').pop().path.split('/').pop(), exception('2026-11-09').id, 'the moved occurrence after the end goes too');
  assert.deepEqual(clock(), ['2026-10-05 10:00 Team sync', '2026-10-12 10:00 Team sync', '2026-10-19 10:00 Team sync', '2026-10-26 10:00 Team sync']);
  assert.deepEqual([changes.at(-1).kind, changes.at(-1).scope, changes.at(-1).event, changes.at(-1).previous.id], ['series', 'following', null, opened.id]);

  const first = on('2026-10-05');
  await calendars.remove(first.id, { scope: 'following', etag: first.etag });
  assert.equal(requests(fake, 'DELETE').pop().path, '/calendars/me@example.com/events/sync');
  assert.deepEqual(clock(), []);
});

test('deleting all events sends the version of the series the user saw', async () => {
  const { calendars, fake, on } = await open([master({ etag: '"5"' })]);
  const opened = on('2026-10-12');
  await assert.rejects(calendars.remove(opened.id, { scope: 'all', etag: opened.etag, seriesEtag: '"4"' }), (err) => err.code === 'changed');
  assert.notEqual(fake.store[0].status, 'cancelled');
  await calendars.remove(opened.id, { scope: 'all', etag: opened.etag, seriesEtag: '"5"' });
  assert.equal(requests(fake, 'DELETE').pop().ifMatch, '"5"');
  assert.equal(fake.store[0].status, 'cancelled');
});

test('an all-day series splits on dates: UNTIL is the day before, COUNT goes on', async () => {
  const days = { id: 'conf', summary: 'Conference', start: { date: '2026-11-02' }, end: { date: '2026-11-03' }, recurrence: ['RRULE:FREQ=DAILY;COUNT=5'], ...mine };
  const { calendars, fake, events } = await open([days]);
  const third = events().find((e) => e.startDate === '2026-11-04');
  await calendars.update(third.id, input(third, { title: 'Conference, day 3 on' }), { scope: 'following', etag: third.etag });
  const post = requests(fake, 'POST').pop();
  assert.deepEqual([post.body.start, post.body.end, post.body.recurrence], [{ date: '2026-11-04' }, { date: '2026-11-05' }, ['RRULE:FREQ=DAILY;COUNT=3']]);
  assert.deepEqual(requests(fake, 'PATCH', '/events/conf').pop().body.recurrence, ['RRULE:FREQ=DAILY;UNTIL=20261103']);
  assert.deepEqual(events().map((e) => `${e.startDate} ${e.title}`), ['2026-11-02 Conference', '2026-11-03 Conference', '2026-11-04 Conference, day 3 on', '2026-11-05 Conference, day 3 on', '2026-11-06 Conference, day 3 on']);
});

test('only the organizer splits a series, or deletes this and following', async () => {
  const theirs = { ...master(), organizer: { email: 'joris@example.com' }, guestsCanModify: true, attendees: [{ email: 'joris@example.com', organizer: true }, { email: 'me@example.com', self: true }] };
  const { calendars, fake, on } = await open([theirs]);
  const opened = on('2026-11-02');
  assert.equal(opened.canEdit, true, 'guests may change this meeting');
  await assert.rejects(calendars.update(opened.id, input(opened, { title: 'x' }), { scope: 'following', etag: opened.etag }), (err) => err.code === 'refused' && err.message === t('errors.calendar.notOrganizer'));
  await assert.rejects(calendars.remove(opened.id, { scope: 'following', etag: opened.etag }), (err) => err.code === 'refused');
  assert.equal(fake.requests.filter((r) => r.method !== 'GET').length, 0);
});
