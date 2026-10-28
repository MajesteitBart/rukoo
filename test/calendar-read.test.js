'use strict';

// The calendar store's reads for the rest of Rukoo (read, busyTimes, conflicts, list, event) and its events
// ('changed', 'synced'), plus the versions a provider whose series is one object hands back (#53).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { t } = require('../src/i18n');
const { zonedInstant } = require('../src/main/calendar/zone');
const { merge } = require('../src/main/calendar/availability');
const { fakeCalendar, setup, settle, monday, at, iso, day, DAY } = require('./fixtures/google-calendar');

const mine = { organizer: { email: 'me@example.com', self: true } };
const theirs = (response) => ({ organizer: { email: 'joris@example.com' }, attendees: [{ email: 'joris@example.com', organizer: true }, { email: 'me@example.com', self: true, responseStatus: response }] });
// A Google account whose calendar was never connected: it has no calendar, so it is never named as failed.
const NO_CALENDAR = { id: 'g2', type: 'imap', provider: 'google', auth: 'oauth2', email: 'old@example.com', secret: 'rt' };
// One whose grant lost the calendar: its cache still has the calendars it had, so its busy time is unknown.
const LOST = { id: 'g3', type: 'imap', provider: 'google', auth: 'oauth2', email: 'lost@example.com', secret: 'rt' };
function lostCache(dataDir) {
  fs.mkdirSync(path.join(dataDir, 'calendar'), { recursive: true });
  const cal = { id: 'lost@example.com', name: 'lost@example.com', primary: true, writable: true, selected: true, owned: true };
  fs.writeFileSync(path.join(dataDir, 'calendar', 'g3.json'), JSON.stringify({ calendars: [cal], events: [] }));
}

function watch(calendars) {
  const seen = { updated: 0, changed: [], synced: [] };
  calendars.on('updated', () => seen.updated++);
  calendars.on('changed', (c) => seen.changed.push(c));
  calendars.on('synced', (s) => seen.synced.push(s));
  return seen;
}

test('read() serves from the cached stretch, and reads outside it without touching the view, its spinner or its stretch', async () => {
  const m = monday();
  const fake = fakeCalendar({
    events: [
      { id: 'near', summary: 'This week', start: { dateTime: iso(at(m, 1, 9)) }, end: { dateTime: iso(at(m, 1, 10)) }, ...mine },
      { id: 'far', summary: 'Far ahead', start: { dateTime: iso(at(m, 90, 9)) }, end: { dateTime: iso(at(m, 90, 10)) }, ...mine },
      { id: 'edge', summary: 'Just after', start: { dateTime: iso(at(m, 92, 9)) }, end: { dateTime: iso(at(m, 92, 10)) }, ...mine },
      { id: 'team', calendarId: 'team@example.com', summary: 'Team thing', start: { dateTime: iso(at(m, 90, 14)) }, end: { dateTime: iso(at(m, 90, 15)) }, ...mine }
    ]
  });
  const { calendars } = setup(fake);
  const week = { start: m, end: m + 7 * DAY };
  calendars.view(week);
  await settle(calendars);
  const cache = calendars.cache('g1');
  const { range, view } = cache;
  const seen = watch(calendars);
  const count = fake.requests.length;

  const cached = await calendars.read(week);
  assert.equal(fake.requests.length, count, 'the cache covers the week');
  assert.deepEqual(cached.events.map((e) => e.eventId), ['near']);
  assert.deepEqual(cached.failed, []);

  const far = { start: at(m, 90, 0).getTime(), end: at(m, 91, 0).getTime() };
  const read = calendars.read(far);
  assert.equal(calendars.loading.size, 0, 'no spinner');
  const out = await read;
  assert.deepEqual(out.events.map((e) => e.eventId), ['far', 'team'], 'clipped to the range, by start');
  const lists = fake.requests.slice(count).filter((r) => r.path.endsWith('/events'));
  assert.equal(lists.length, 3, 'every calendar');
  assert.ok(lists.every((r) => Date.parse(r.query.timeMin) === far.start - 2 * DAY && Date.parse(r.query.timeMax) === far.end + 2 * DAY), 'two days more on each side');
  assert.deepEqual([cache.range, cache.view], [range, view]);
  assert.equal(cache.events.some((e) => e.eventId === 'far'), false, "the view's cache stays as it was");
  assert.equal(seen.updated, 0, "no 'updated'");

  // Read again: from what the first read fetched, until it is older than asked.
  const after = fake.requests.length;
  await calendars.read(far);
  await calendars.read({ ...far, calendars: ['g1\nme@example.com'] });
  assert.equal(fake.requests.length, after);
  await calendars.read({ ...far, maxAgeMs: 0 });
  assert.equal(fake.requests.length, after + 3);
  // Only the calendars asked for.
  const only = await calendars.read({ start: at(m, 60, 0).getTime(), end: at(m, 61, 0).getTime(), calendars: ['g1\nteam@example.com'] });
  assert.deepEqual(fake.requests.slice(after + 3).map((r) => r.path), ['/calendars/team@example.com/events']);
  assert.deepEqual(only.events, []);

  // An event a reminder points at is found outside the cached stretch while the read lives.
  const farId = out.events[0].id;
  assert.equal(calendars.event(farId).title, 'Far ahead');
  // A change makes what was read outside the view out of date.
  await calendars.create({ accountId: 'g1', calendarId: 'me@example.com', title: 'New', allDay: false, start: at(m, 90, 12).getTime(), end: at(m, 90, 13).getTime() });
  const fresh = await calendars.read(far);
  assert.deepEqual(fresh.events.map((e) => e.title), ['Far ahead', 'New', 'Team thing']);
  await assert.rejects(calendars.read({ start: 2, end: 1 }), (err) => err.code === 'invalid');
});

test("read() gets the calendars of an account whose calendar was never opened, and names the accounts it couldn't read", async () => {
  const m = monday();
  const fake = fakeCalendar({ events: [{ id: 'a', summary: 'Planning', start: { dateTime: iso(at(m, 1, 9)) }, end: { dateTime: iso(at(m, 1, 10)) }, ...mine }] });
  const { calendars, engine, dataDir } = setup(fake, { extra: [NO_CALENDAR, LOST] });
  lostCache(dataDir);
  const out = await calendars.read({ start: m, end: m + 7 * DAY });
  assert.equal(fake.requests[0].path, '/users/me/calendarList');
  assert.deepEqual(out.events.map((e) => e.title), ['Planning']);
  assert.deepEqual(out.failed, [{ accountId: 'g3', email: 'lost@example.com', code: 'reconnect' }], 'the account that never connected its calendar has none to fail');
  const named = await calendars.read({ start: m, end: m + 7 * DAY, calendars: ['g2\nold@example.com'] });
  assert.deepEqual(named.failed, [{ accountId: 'g2', email: 'old@example.com', code: 'reconnect' }], 'unless its calendar is asked for');
  const cache = calendars.cache('g1');
  assert.equal(cache.calendars.length, 3, 'kept for the view');
  assert.equal(cache.range, null);
  assert.deepEqual(calendars.list()[0].calendars.map((c) => c.name), ['me@example.com', 'Holidays', 'Team']);
  // The account still counts as never opened for syncing.
  const before = fake.requests.length;
  await calendars.syncAll();
  assert.equal(fake.requests.length, before);

  // A read that fails leaves the account out instead of passing it off as empty.
  calendars.fetch = async () => {
    throw new TypeError('fetch failed');
  };
  calendars.providers.clear();
  const failed = await calendars.read({ start: m + 60 * DAY, end: m + 61 * DAY });
  assert.deepEqual(failed.failed.sort((a, b) => a.accountId.localeCompare(b.accountId)), [
    { accountId: 'g1', email: 'me@example.com', code: 'network' },
    { accountId: 'g3', email: 'lost@example.com', code: 'reconnect' }
  ]);
  assert.deepEqual(failed.events, []);
  assert.equal(calendars.cache('g1').error, null, 'a background read leaves the view its own error state');
  assert.ok(engine.accounts[0].scopes.length > 1, 'and the grant as it is');
});

test('busy time: shown as busy and not declined, merged, without zero-length events, on the calendars that count', async () => {
  const m = monday();
  const slot = (d, h1, m1, h2, m2) => ({ start: { dateTime: iso(at(m, d, h1, m1)) }, end: { dateTime: iso(at(m, d, h2, m2)) } });
  const fake = fakeCalendar({
    events: [
      { id: 'a', summary: 'Busy', ...slot(1, 9, 0, 10, 0), ...mine },
      { id: 'b', summary: 'Overlaps', ...slot(1, 9, 30, 11, 0), ...mine },
      { id: 'free', summary: 'Free', transparency: 'transparent', ...slot(1, 13, 0, 14, 0), ...mine },
      { id: 'no', summary: 'Declined', ...slot(1, 15, 0, 16, 0), ...theirs('declined') },
      { id: 'maybe', summary: 'Not answered', ...slot(2, 9, 0, 10, 0), ...theirs('needsAction') },
      { id: 'tent', summary: 'Tentative', ...slot(2, 11, 0, 12, 0), ...theirs('tentative') },
      { id: 'zero', summary: 'Marker', ...slot(2, 13, 0, 13, 0), ...mine },
      { id: 'booked', summary: 'Booked', extendedProperties: { private: { rukooBooking: 'Rf63vMqqWdS0MICDAHKmrw' } }, ...slot(3, 9, 0, 9, 30), ...mine },
      { id: 'day', summary: 'Offsite', start: { date: day(at(m, 4, 0)) }, end: { date: day(at(m, 5, 0)) }, ...mine },
      { id: 'dayfree', summary: 'Holiday', transparency: 'transparent', start: { date: day(at(m, 3, 0)) }, end: { date: day(at(m, 4, 0)) }, ...mine },
      { id: 'team', calendarId: 'team@example.com', summary: 'Team', ...slot(2, 14, 0, 15, 0), ...mine }
    ]
  });
  const { calendars, engine, dataDir } = setup(fake, { extra: [NO_CALENDAR, LOST] });
  lostCache(dataDir);
  const week = { start: m, end: m + 7 * DAY };
  const zone = 'Pacific/Auckland';
  const midnight = (d) => zonedInstant(day(at(m, d, 0)), '00:00', zone);
  const busy = await calendars.busyTimes({ ...week, timeZone: zone });
  // Merged as the zone puts them: far east of the PC, Friday starts on Thursday.
  const expected = merge([
    [at(m, 1, 9).getTime(), at(m, 1, 11).getTime()],
    [at(m, 2, 9).getTime(), at(m, 2, 10).getTime()],
    [at(m, 2, 11).getTime(), at(m, 2, 12).getTime()],
    [at(m, 3, 9).getTime(), at(m, 3, 9, 30).getTime()],
    [midnight(4), midnight(5)]
  ]);
  assert.deepEqual(busy.intervals, expected, 'the all-day event from midnight to midnight in the zone asked for');
  assert.ok(busy.intervals.some(([s, e]) => s <= midnight(4) && e === midnight(5)));
  assert.deepEqual(busy.allDay.map((d) => [d.title, d.startDate, d.busy]), [['Holiday', day(at(m, 3, 0)), false], ['Offsite', day(at(m, 4, 0)), true]], 'free all-day events too, for the day headers');
  assert.deepEqual(busy.failed, [{ accountId: 'g3', email: 'lost@example.com', code: 'reconnect' }], 'only the account whose calendar counted');
  // A lost calendar that didn't count says nothing about free time.
  engine.calendarSettings({ availability: { 'g3\nlost@example.com': false } });
  assert.deepEqual((await calendars.busyTimes({ ...week, timeZone: zone })).failed, []);
  engine.calendarSettings({ availability: { 'g3\nlost@example.com': null } });

  const without = await calendars.busyTimes({ ...week, timeZone: zone, exclude: { bookings: 'all' } });
  assert.equal(without.intervals.some(([s]) => s === at(m, 3, 9).getTime()), false);
  const byId = await calendars.busyTimes({ ...week, timeZone: zone, exclude: { bookings: ['Rf63vMqqWdS0MICDAHKmrw'], ids: [busy.allDay[1].id] } });
  assert.equal(byId.intervals.length, 3);
  // The team calendar counts once the user says so.
  engine.calendarSettings({ availability: { 'g1\nteam@example.com': true } });
  const team = await calendars.busyTimes({ ...week, timeZone: zone });
  assert.ok(team.intervals.some(([s, e]) => s <= at(m, 2, 14).getTime() && e >= at(m, 2, 15).getTime()));
  const chosen = await calendars.busyTimes({ ...week, timeZone: zone, calendars: ['g1\nteam@example.com'] });
  assert.deepEqual(chosen.intervals, [[at(m, 2, 14).getTime(), at(m, 2, 15).getTime()]]);
  // Clipped to the range asked for.
  const clipped = await calendars.busyTimes({ start: at(m, 1, 9, 30).getTime(), end: at(m, 1, 10, 30).getTime(), timeZone: zone });
  assert.deepEqual(clipped.intervals, [[at(m, 1, 9, 30).getTime(), at(m, 1, 10, 30).getTime()]]);
  await assert.rejects(calendars.busyTimes({ ...week, timeZone: 'Nowhere/Land' }), (err) => err.code === 'invalid' && err.message === t('errors.calendar.invalidZone'));
});

test("read() takes the view's stretch only while it is as fresh as asked, so an event deleted elsewhere stops counting", async () => {
  const m = monday();
  const fake = fakeCalendar({ events: [{ id: 'a', summary: 'Call', start: { dateTime: iso(at(m, 1, 9)) }, end: { dateTime: iso(at(m, 1, 10)) }, ...mine }] });
  const { calendars, dataDir } = setup(fake);
  calendars.view({ start: m, end: m + 7 * DAY });
  await settle(calendars);
  const cache = calendars.cache('g1');
  const two = { start: m, end: m + 2 * DAY };
  let count = fake.requests.length;
  assert.deepEqual((await calendars.read(two)).events.map((e) => e.title), ['Call'], 'just fetched: from the cache');
  assert.equal(fake.requests.length, count);

  // Deleted on the phone, while sync is set to manual.
  fake.store[0].status = 'cancelled';
  assert.deepEqual((await calendars.read({ ...two, maxAgeMs: 0 })).events, [], 'fresher than the cache: from Google');
  assert.ok(fake.requests.length > count);
  assert.equal(cache.events.length, 1, "the view's stretch stays as it was until the next sync");
  // What that read found wins over the older stretch, also while the stretch is younger than five minutes.
  assert.deepEqual((await calendars.busyTimes({ ...two, timeZone: 'Europe/Amsterdam' })).intervals, []);
  // Older than the default five minutes: busy time comes from Google as well.
  for (const f of cache.fetched) f.at -= 6 * 60000;
  calendars.memos.clear();
  assert.deepEqual((await calendars.busyTimes({ ...two, timeZone: 'Europe/Amsterdam' })).intervals, []);
  // The conflict line asks at every change of the times, and takes what the grid shows for up to half an hour.
  calendars.memos.clear();
  count = fake.requests.length;
  await calendars.conflicts({ start: at(m, 1, 9).getTime(), end: at(m, 1, 10).getTime() });
  assert.equal(fake.requests.length, count);

  // A sync makes the stretch fresh again.
  await calendars.syncAccount('g1');
  count = fake.requests.length;
  assert.deepEqual((await calendars.read(two)).events, []);
  assert.equal(fake.requests.length, count);

  // A stretch saved by an older Rukoo has no fetch times: after a restart it serves no read until it is fetched again.
  calendars.flush();
  const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'calendar', 'g1.json'), 'utf8'));
  delete saved.fetched;
  fs.writeFileSync(path.join(dataDir, 'calendar', 'g1.json'), JSON.stringify(saved));
  calendars.caches.delete('g1');
  count = fake.requests.length;
  await calendars.read(two);
  assert.ok(fake.requests.length > count);
});

test('conflicts are busy events on the calendars that count, without the one being edited', async () => {
  const m = monday();
  const fake = fakeCalendar({
    events: [
      { id: 'a', summary: 'Roadmap review', start: { dateTime: iso(at(m, 1, 14)) }, end: { dateTime: iso(at(m, 1, 15)) }, ...mine },
      { id: 'b', summary: 'Free time', transparency: 'transparent', start: { dateTime: iso(at(m, 1, 14)) }, end: { dateTime: iso(at(m, 1, 15)) }, ...mine },
      { id: 'c', summary: 'Being edited', start: { dateTime: iso(at(m, 1, 14, 30)) }, end: { dateTime: iso(at(m, 1, 15, 30)) }, ...mine },
      { id: 'd', summary: 'Later', start: { dateTime: iso(at(m, 1, 16)) }, end: { dateTime: iso(at(m, 1, 17)) }, ...mine },
      { id: 'h', calendarId: 'nl#holiday@group.v.calendar.google.com', summary: 'Holiday', start: { dateTime: iso(at(m, 1, 14)) }, end: { dateTime: iso(at(m, 1, 15)) } }
    ]
  });
  const { calendars } = setup(fake);
  const all = await calendars.read({ start: m, end: m + 7 * DAY });
  const edited = all.events.find((e) => e.eventId === 'c');
  const out = await calendars.conflicts({ start: at(m, 1, 14, 30).getTime(), end: at(m, 1, 15, 30).getTime(), exclude: [edited.id] });
  assert.deepEqual(out, { events: [{ id: all.events.find((e) => e.eventId === 'a').id, title: 'Roadmap review', start: at(m, 1, 14).getTime(), end: at(m, 1, 15).getTime(), allDay: false }], failed: [] });
});

test("list() gives the accounts and their calendars without fetching, and the store says 'changed' and 'synced'", async () => {
  const m = monday();
  const fake = fakeCalendar({
    events: [
      { id: 'a', summary: 'Mine', start: { dateTime: iso(at(m, 1, 9)) }, end: { dateTime: iso(at(m, 1, 10)) }, ...mine },
      { id: 'inv', summary: 'Invite', start: { dateTime: iso(at(m, 2, 9)) }, end: { dateTime: iso(at(m, 2, 10)) }, ...theirs('needsAction') }
    ]
  });
  const { calendars } = setup(fake);
  const seen = watch(calendars);
  assert.deepEqual(calendars.list().map((a) => [a.id, a.kind, a.calendars.length, a.loading]), [['g1', 'google', 0, false]]);
  assert.equal(fake.requests.length, 0);
  assert.equal(calendars.cache('g1').view, null, 'the view stays unopened');
  // The settings pages load the calendars first (IPC calendarList), still without the view's fetch.
  assert.deepEqual(await calendars.loadCalendars(), []);
  assert.deepEqual(fake.requests.map((r) => r.path), ['/users/me/calendarList']);
  assert.deepEqual(calendars.list()[0].calendars.map((c) => c.name), ['me@example.com', 'Holidays', 'Team']);
  assert.deepEqual([calendars.cache('g1').view, calendars.cache('g1').range, calendars.loading.size, seen.updated], [null, null, 0, 0]);
  await calendars.loadCalendars();
  assert.equal(fake.requests.length, 1, 'once');
  const week = { start: m, end: m + 7 * DAY };
  calendars.view(week);
  await settle(calendars);
  assert.equal(calendars.list()[0].calendars.length, 3);
  assert.deepEqual(seen.synced, [], 'filling the view is no sync');
  await calendars.syncAccount('g1');
  assert.deepEqual(seen.synced, [{ accountId: 'g1' }]);

  const [a, inv] = calendars.view(week).events;
  // An answer says so too, with the event as answered, so the reminders and the booking page follow at once.
  await calendars.respond(inv.id, 'accepted');
  assert.equal(seen.changed.length, 1);
  assert.deepEqual([seen.changed[0].kind, seen.changed[0].scope, seen.changed[0].event.id, seen.changed[0].event.response, seen.changed[0].previous], ['respond', 'one', inv.id, 'accepted', null]);
  await calendars.remove(a.id, { etag: a.etag, notify: true });
  assert.equal(seen.changed.length, 2);
  assert.deepEqual([seen.changed[1].kind, seen.changed[1].scope, seen.changed[1].event, seen.changed[1].previous.id], ['remove', 'one', null, a.id]);
  // A failed sync says nothing.
  calendars.fetch = async () => ({ ok: false, status: 500, json: async () => ({ error: { message: 'down' } }) });
  calendars.providers.clear();
  await assert.rejects(calendars.syncAccount('g1'));
  assert.equal(seen.synced.length, 1);
});

// A CalDAV-style provider: the series is one object with one version, which every occurrence carries.
function oneObject() {
  const href = 'https://dav.example.com/home/standup.ics';
  const cal = { id: 'https://dav.example.com/home/', name: 'Home', primary: true, writable: true, selected: true, timeZone: null, scheduling: true };
  const m = monday();
  const state = { etag: '"e1"', calls: [] };
  const occurrence = (n) => ({
    calendarId: cal.id,
    eventId: `${href}#${n}`,
    etag: state.etag,
    eventType: 'default',
    seriesId: href,
    title: 'Stand-up',
    location: '',
    description: '',
    allDay: false,
    start: m + n * DAY + 9 * 3600000,
    end: m + n * DAY + 9.25 * 3600000,
    startDate: null,
    endDate: null,
    timeZone: null,
    endTimeZone: null,
    status: 'confirmed',
    busy: true,
    response: 'needsAction',
    canEdit: true,
    canDelete: true,
    canRespond: true,
    organizer: { name: '', address: 'sanne@example.com', self: false },
    attendees: [{ name: '', address: 'c@example.com', response: 'needsAction', self: true, organizer: false, optional: false }],
    moreAttendees: false,
    link: null,
    meeting: null,
    canInvite: 'edit'
  });
  return {
    cal,
    state,
    provider: {
      versioned: true,
      versionedSeries: true,
      calendars: async () => [cal],
      events: async () => [0, 1, 2].map(occurrence),
      get: async (c, id) => occurrence(Number(id.split('#')[1])),
      update: async (c, e, input, opts) => {
        state.calls.push(['update', opts]);
        state.etag = '"e2"';
        return { ...e, title: input.title, etag: state.etag };
      },
      remove: async (c, e, opts) => {
        state.calls.push(['remove', opts]);
        state.etag = '"e3"';
        return { etag: state.etag };
      },
      respond: async (c, e, response, opts) => {
        state.calls.push(['respond', opts]);
        state.etag = '"e4"';
        return { etag: state.etag };
      }
    }
  };
}

test('#53: on a provider whose series is one object, every cached occurrence gets the version a change hands back', async () => {
  const dav = oneObject();
  const { calendars } = setup(fakeCalendar(), { extra: [{ id: 'c1', type: 'imap', provider: 'other', email: 'c@example.com', color: '#ff8a3d', secret: 's', caldav: { url: 'https://dav.example.com/' } }] });
  calendars.providers.set('c1:caldav', dav.provider);
  const m = monday();
  const week = { start: m, end: m + 7 * DAY };
  calendars.view(week);
  await settle(calendars);
  const mineOnly = () => calendars.view(week).events.filter((e) => e.accountId === 'c1');
  const etags = () => mineOnly().map((e) => e.etag);
  const cal = calendars.view(week).accounts.find((a) => a.id === 'c1').calendars[0];
  assert.equal(cal.invites, 'provider', "a CalDAV calendar whose server schedules (the cached flag, before the server's own setting)");
  assert.equal(mineOnly()[0].canInvite, 'edit');

  let [first, second] = mineOnly();
  await calendars.update(first.id, { title: 'Stand-up (moved)', location: '', description: '', allDay: false, start: first.start, end: first.end }, { etag: first.etag });
  assert.deepEqual(dav.state.calls[0], ['update', { notify: false, etag: '"e1"', scope: 'one', seriesEtag: null }]);
  assert.deepEqual(etags(), ['"e2"', '"e2"', '"e2"']);
  second = mineOnly()[1];
  await calendars.remove(second.id, { etag: second.etag });
  assert.deepEqual(dav.state.calls[1], ['remove', { notify: false, scope: 'one', series: false, etag: '"e2"', seriesEtag: null }]);
  assert.deepEqual(etags(), ['"e3"', '"e3"']);
  [first] = mineOnly();
  await calendars.respond(first.id, 'accepted');
  assert.deepEqual(etags(), ['"e4"', '"e4"']);

  // A calendar whose server sends no invitations has no guests to edit.
  calendars.cache('c1').calendars[0].invites = 'none';
  assert.equal(calendars.view(week).accounts.find((a) => a.id === 'c1').calendars[0].invites, 'none');
  assert.equal(mineOnly()[0].canInvite, false);

  // A whole series goes on the version every occurrence carries, also without series().
  first = mineOnly()[0];
  await calendars.remove(first.id, { series: true, etag: first.etag });
  assert.deepEqual(dav.state.calls.at(-1), ['remove', { notify: false, scope: 'all', series: true, etag: '"e4"', seriesEtag: '"e4"' }]);
});
