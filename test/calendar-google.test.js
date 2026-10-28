'use strict';

// Google Calendar's newer fields in the calendar store: colours, Meet, reminders, guests, show as, visibility,
// booking events, moves and search, against the fake Google Calendar API.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { t } = require('../src/i18n');
const { toEvent, applyGuests } = require('../src/main/calendar/google');
const { fakeCalendar, setup, settle, monday, at, iso, day, DAY } = require('./fixtures/google-calendar');

const mine = { organizer: { email: 'me@example.com', self: true } };
const DEMO = { id: 'd1', type: 'demo', provider: 'demo', email: 'demo@example.com', name: 'Demo User' };

async function opened(fake, extra = []) {
  const ctx = setup(fake, { extra });
  const m = monday();
  ctx.week = { start: m, end: m + 7 * DAY };
  ctx.calendars.view(ctx.week);
  await settle(ctx.calendars);
  ctx.find = (eventId) => ctx.calendars.view(ctx.week).events.find((e) => e.eventId === eventId);
  ctx.m = m;
  ctx.changes = [];
  ctx.calendars.on('changed', (c) => ctx.changes.push(c));
  return ctx;
}

const input = (e, changes = {}) => ({ accountId: e.accountId, calendarId: e.calendarId, title: e.title, location: e.location, description: e.description, allDay: e.allDay, start: e.start, end: e.end, startDate: e.startDate, endDate: e.endDate, ...changes });
const last = (fake, method) => fake.requests.filter((r) => r.method === method).pop();
const refusedWith = (key) => (err) => err.code === 'refused' && err.message === t(key);
const invalidWith = (key) => (err) => err.code === 'invalid' && err.message === t(key);

test('calendars carry their colour, Meet, default reminders and ownership, and the user chooses shown, availability and colour', async () => {
  const fake = fakeCalendar();
  const { calendars, engine, week } = await opened(fake);
  const cals = () => Object.fromEntries(calendars.view(week).accounts[0].calendars.map((c) => [c.name, c]));
  let c = cals();
  assert.deepEqual(
    [c['me@example.com'].color, c['me@example.com'].providerColor, c['me@example.com'].conference, c['me@example.com'].invites, c['me@example.com'].owned],
    ['#9fe1e7', '#9fe1e7', true, 'provider', true]
  );
  assert.deepEqual(c['me@example.com'].defaultReminders, [{ method: 'popup', minutes: 10 }, { method: 'email', minutes: 1440 }], 'email defaults keep their method');
  assert.equal(c['me@example.com'].timeZone, 'Europe/Amsterdam');
  // Shown and availability follow Google and the default rule until the user chooses.
  assert.deepEqual([c['me@example.com'].visible, c['me@example.com'].availability], [true, true]);
  assert.deepEqual([c.Holidays.visible, c.Holidays.availability, c.Holidays.owned], [false, false, false], 'a read-only calendar never counts by default');
  assert.deepEqual([c.Team.color, c.Team.conference, c.Team.owned, c.Team.availability], ['#fa573c', false, false, false], "a shared calendar counts only when the user says so; this one's account has no Meet");

  engine.calendarSettings({ colors: { 'g1\nme@example.com': '#112233', 'g1\nteam@example.com': 'red' }, availability: { 'g1\nteam@example.com': true }, visible: { 'g1\nnl#holiday@group.v.calendar.google.com': true } });
  c = cals();
  assert.equal(c['me@example.com'].color, '#112233');
  assert.equal(c['me@example.com'].providerColor, '#9fe1e7');
  assert.equal(c.Team.color, '#fa573c', 'a colour that is no #rrggbb is ignored');
  assert.deepEqual([c.Team.availability, c.Holidays.visible, c.Holidays.availability], [true, true, false], 'the eye toggle never changes availability');
  engine.calendarSettings({ colors: { 'g1\nme@example.com': null } });
  assert.equal(cals()['me@example.com'].color, '#9fe1e7', 'null takes the choice back');
});

test('a cache from before the newer fields gives calendars and events their defaults', () => {
  const fake = fakeCalendar();
  const { calendars, dataDir } = setup(fake, { extra: [{ id: 'c1', type: 'imap', provider: 'other', email: 'c@example.com', color: '#ff8a3d', secret: 's', caldav: { url: 'https://dav.example.com/' } }] });
  const m = monday();
  const old = { id: 'e1', calendarId: 'me@example.com', eventId: 'e1', etag: '"1"', seriesId: 's1', title: 'Old', allDay: false, start: m + 9 * 3600000, end: m + 10 * 3600000, canEdit: true, attendees: [] };
  fs.mkdirSync(path.join(dataDir, 'calendar'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'calendar', 'g1.json'), JSON.stringify({ calendars: [{ id: 'me@example.com', name: 'me@example.com', primary: true, writable: true, selected: true }], events: [old], range: { start: m - 30 * DAY, end: m + 30 * DAY } }));
  fs.writeFileSync(
    path.join(dataDir, 'calendar', 'c1.json'),
    JSON.stringify({
      calendars: [
        { id: 'https://dav.example.com/home/', name: 'Home', primary: true, writable: true, selected: true, scheduling: true },
        { id: 'https://dav.example.com/other/', name: 'Other', primary: false, writable: true, selected: true, scheduling: false }
      ],
      events: [],
      range: { start: m - 30 * DAY, end: m + 30 * DAY }
    })
  );
  const view = calendars.view({ start: m, end: m + 7 * DAY });
  const [g, c] = view.accounts;
  assert.deepEqual(
    [g.calendars[0].providerColor, g.calendars[0].color, g.calendars[0].conference, g.calendars[0].defaultReminders, g.calendars[0].owned, g.calendars[0].availability],
    [null, '#4a7dff', false, [], true, true],
    'the account colour when the provider gave none'
  );
  assert.deepEqual(c.calendars.map((x) => x.invites), ['provider', 'none'], 'a CalDAV calendar cached with the old scheduling flag');
  const [e] = view.events;
  assert.deepEqual(
    { uid: e.uid, originalStart: e.originalStart, recurring: e.recurring, reminders: e.reminders, visibility: e.visibility, bookingId: e.bookingId, canInvite: e.canInvite, canMove: e.canMove, conference: e.conference, busy: e.busy },
    { uid: null, originalStart: null, recurring: true, reminders: null, visibility: 'default', bookingId: null, canInvite: false, canMove: false, conference: null, busy: true }
  );
});

test('Google events: uid, original start, reminders, visibility, booking, guests, moving and Meet', () => {
  const cal = { id: 'me@example.com', writable: true, timeZone: 'Europe/Amsterdam' };
  const base = { start: { dateTime: '2026-11-03T09:00:00Z' }, end: { dateTime: '2026-11-03T10:00:00Z' }, ...mine };
  const e = toEvent(
    {
      id: 'r_20261103T090000Z',
      iCalUID: 'r@google.com',
      recurringEventId: 'r',
      originalStartTime: { dateTime: '2026-11-02T09:00:00Z' },
      reminders: { useDefault: false, overrides: [{ method: 'email', minutes: 1440 }, { method: 'popup', minutes: 10 }, { method: 'sms', minutes: 5 }] },
      visibility: 'private',
      extendedProperties: { private: { rukooBooking: 'Rf63vMqqWdS0MICDAHKmrw' } },
      conferenceData: { createRequest: { requestId: 'x', status: { statusCode: 'pending' } } },
      ...base
    },
    cal
  );
  assert.deepEqual(
    [e.uid, e.originalStart, e.recurring, e.visibility, e.bookingId, e.canInvite, e.canMove],
    ['r@google.com', Date.parse('2026-11-02T09:00:00Z'), true, 'private', 'Rf63vMqqWdS0MICDAHKmrw', 'edit', true]
  );
  assert.deepEqual(e.reminders, { useDefault: false, overrides: [{ method: 'email', minutes: 1440 }, { method: 'popup', minutes: 10 }] }, 'reminders keep their method');
  assert.deepEqual(e.conference, { solution: 'other', pending: true }, 'a request on its way, of a kind it doesn\'t name');
  const meet = toEvent({ id: 'p', conferenceData: { createRequest: { requestId: 'x', conferenceSolutionKey: { type: 'hangoutsMeet' }, status: { statusCode: 'pending' } } }, ...base }, cal);
  assert.deepEqual(meet.conference, { solution: 'hangoutsMeet', pending: true });
  assert.equal(toEvent({ id: 'a', originalStartTime: { date: '2026-11-02' }, start: { date: '2026-11-03' }, end: { date: '2026-11-04' } }, cal).originalStart, new Date(2026, 10, 2).getTime(), 'all-day: local midnight');
  assert.deepEqual(toEvent({ id: 'n', ...base }, cal).reminders, { useDefault: true, overrides: [] }, 'no reminders field means the defaults');
  assert.deepEqual(toEvent({ id: 'h', hangoutLink: 'https://meet.google.com/a-b-c', ...base }, cal).conference, { solution: 'hangoutsMeet', pending: false });
  assert.deepEqual(toEvent({ id: 'z', conferenceData: { conferenceSolution: { key: { type: 'addOn' } }, entryPoints: [{ entryPointType: 'video', uri: 'https://zoom.us/j/1' }] }, ...base }, cal).conference, { solution: 'other', pending: false });
  assert.equal(toEvent({ id: 'f', conferenceData: { createRequest: { status: { statusCode: 'failure' } } }, ...base }, cal).conference, null);

  // Who may change the guest list.
  const invited = { start: base.start, end: base.end, organizer: { email: 'joris@example.com' }, attendees: [{ email: 'me@example.com', self: true }] };
  assert.equal(toEvent({ id: 'i1', ...invited }, cal).canInvite, 'add', 'a guest may invite others unless the organizer said no');
  assert.equal(toEvent({ id: 'i2', guestsCanInviteOthers: false, ...invited }, cal).canInvite, false);
  assert.equal(toEvent({ id: 'i3', guestsCanModify: true, ...invited }, cal).canInvite, 'edit');
  assert.equal(toEvent({ id: 'i4', attendeesOmitted: true, ...base }, cal).canInvite, false, 'a list Google left partly out');
  assert.equal(toEvent({ id: 'i5', ...base }, { ...cal, writable: false }).canInvite, false);
  assert.equal(toEvent({ id: 'i6', guestsCanModify: true, ...invited }, cal).canMove, false, 'only the organizer moves an event');
  assert.equal(toEvent({ id: 'i7', eventType: 'outOfOffice', ...base }, cal).canMove, false);

  // #43: Google's own events stay deletable when locked; a locked ordinary event doesn't.
  for (const eventType of ['fromGmail', 'birthday']) {
    const made = toEvent({ id: eventType, eventType, locked: true, ...base }, cal);
    assert.deepEqual([made.canEdit, made.canDelete], [false, true], eventType);
  }
  const locked = toEvent({ id: 'l', locked: true, ...base }, cal);
  assert.deepEqual([locked.canEdit, locked.canDelete], [false, false]);
});

test('a new event takes guests, a rule, reminders, show as, visibility and Meet, with conferenceDataVersion=1', async () => {
  const fake = fakeCalendar();
  const { calendars, m, week, changes } = await opened(fake);
  const order = [];
  calendars.on('updated', () => order.push('updated'));
  calendars.on('changed', () => order.push('changed'));
  const made = await calendars.create(
    {
      accountId: 'g1',
      calendarId: 'me@example.com',
      id: 'abcdefghij0123',
      title: 'Kickoff',
      allDay: false,
      start: at(m, 2, 14).getTime(),
      end: at(m, 2, 15).getTime(),
      timeZone: 'America/New_York',
      guests: { add: [{ address: 'Jane@Example.com', name: 'Jane' }, { address: 'bob@example.com', optional: true }] },
      reminders: { useDefault: false, overrides: [{ method: 'email', minutes: 60 }] },
      visibility: 'private',
      addMeet: true
    },
    { notify: true }
  );
  const post = last(fake, 'POST');
  assert.deepEqual([post.query.conferenceDataVersion, post.query.sendUpdates], ['1', 'all']);
  assert.equal(post.body.start.timeZone, 'America/New_York');
  assert.deepEqual(post.body.attendees, [
    { email: 'jane@example.com', displayName: 'Jane', responseStatus: 'needsAction' },
    { email: 'bob@example.com', optional: true, responseStatus: 'needsAction' }
  ]);
  assert.deepEqual(post.body.reminders, { useDefault: false, overrides: [{ method: 'email', minutes: 60 }] });
  assert.equal(post.body.transparency, 'opaque', 'timed events show as busy');
  assert.deepEqual(post.body.conferenceData, { createRequest: { requestId: 'abcdefghij0123', conferenceSolutionKey: { type: 'hangoutsMeet' } } }, "the request id is the event's id, so a retry makes no second link");
  assert.match(made.meeting, /^https:\/\/meet\.google\.com\//);
  assert.deepEqual(made.conference, { solution: 'hangoutsMeet', pending: false });
  assert.deepEqual(made.attendees.map((a) => a.address), ['me@example.com', 'jane@example.com', 'bob@example.com']);
  assert.deepEqual(order, ['updated', 'changed'], "'changed' follows 'updated'");
  assert.deepEqual(changes[0], { accountId: 'g1', calendarId: 'me@example.com', kind: 'create', scope: 'one', event: made, previous: null });

  await calendars.create({ accountId: 'g1', calendarId: 'me@example.com', title: 'Offsite', allDay: true, startDate: day(at(m, 4, 0)), endDate: day(at(m, 5, 0)) });
  assert.equal(last(fake, 'POST').body.transparency, 'transparent', 'new all-day events show as free');
  assert.equal(last(fake, 'POST').query.sendUpdates, 'none');
  await calendars.create({ accountId: 'g1', calendarId: 'me@example.com', title: 'Busy day', allDay: true, startDate: day(at(m, 4, 0)), endDate: day(at(m, 5, 0)), busy: true });
  assert.equal(last(fake, 'POST').body.transparency, 'opaque');

  // A repeating event comes back as its first occurrence, and its other occurrences are in the cache.
  const weekly = await calendars.create({ accountId: 'g1', calendarId: 'me@example.com', title: 'Gym', allDay: false, start: at(m, 1, 18).getTime(), end: at(m, 1, 19).getTime(), recurrence: 'FREQ=WEEKLY;BYDAY=TU;WKST=MO' });
  assert.deepEqual(last(fake, 'POST').body.recurrence, ['RRULE:FREQ=WEEKLY;BYDAY=TU;WKST=MO']);
  assert.equal(weekly.start, at(m, 1, 18).getTime());
  assert.equal(weekly.recurring, true);
  assert.ok(weekly.seriesId);
  assert.equal(calendars.view({ start: week.start, end: week.end + 14 * DAY }).events.filter((e) => e.seriesId === weekly.seriesId).length, 3);
  assert.deepEqual([changes.at(-1).kind, changes.at(-1).event.id], ['create', weekly.id]);
});

test("changes the store refuses: input it can't keep, Meet where there is none, guests where nobody sends invitations", async () => {
  const fake = fakeCalendar();
  const { calendars, m } = await opened(fake, [DEMO]);
  const event = { accountId: 'g1', calendarId: 'me@example.com', title: 'x', allDay: false, start: at(m, 1, 9).getTime(), end: at(m, 1, 10).getTime() };
  await assert.rejects(calendars.create({ ...event, timeZone: 'Mars/Olympus' }), invalidWith('errors.calendar.invalidZone'));
  await assert.rejects(calendars.create({ ...event, timeZone: '+01:00' }), invalidWith('errors.calendar.invalidZone'));
  for (const rule of ['FREQ=WEEKLY;COUNT=3;UNTIL=20261231T000000Z', 'FREQ=MONTHLY;BYSETPOS=-1', 'INTERVAL=2;FREQ=DAILY', 'FREQ=WEEKLY;BYHOUR=9', 'FREQ=HOURLY', 'RRULE:FREQ=DAILY', 'x'.repeat(501)]) {
    await assert.rejects(calendars.create({ ...event, recurrence: rule }), invalidWith('errors.calendar.invalidRule'), rule);
  }
  await assert.rejects(calendars.create({ ...event, guests: { add: [{ address: 'not an address' }] } }), invalidWith('errors.calendar.invalidGuests'));
  await assert.rejects(calendars.create({ ...event, guests: { remove: ['a@example.com'], optional: { 'b@example.com': 'yes' } } }), invalidWith('errors.calendar.invalidGuests'));
  const six = Array.from({ length: 6 }, (_, i) => ({ method: 'popup', minutes: i }));
  await assert.rejects(calendars.create({ ...event, reminders: { useDefault: false, overrides: six } }), invalidWith('errors.calendar.invalidReminders'));
  await assert.rejects(calendars.create({ ...event, reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: -60 }] } }), invalidWith('errors.calendar.invalidReminders'), 'a time after the start only exists for all-day events');
  // Google can't keep "on the day at 09:00".
  const allDay = { ...event, allDay: true, startDate: day(at(m, 1, 0)), endDate: day(at(m, 2, 0)) };
  await assert.rejects(calendars.create({ ...allDay, reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: -540 }] } }), invalidWith('errors.calendar.invalidReminders'));
  assert.equal(fake.requests.filter((r) => r.method === 'POST').length, 0, 'nothing went out');

  await assert.rejects(calendars.create({ ...event, calendarId: 'team@example.com', addMeet: true }), refusedWith('errors.calendar.noMeet'));
  // The demo account's calendars send no invitations.
  await assert.rejects(calendars.create({ ...event, accountId: 'd1', calendarId: 'personal', guests: { add: [{ address: 'jane@example.com' }] } }), refusedWith('errors.calendar.noGuests'));
  // A booking keeps its guest in the booking record there, so its event is made without one.
  const booked = await calendars.create({ ...event, accountId: 'd1', calendarId: 'personal', guests: { add: [{ address: 'jane@example.com' }] } }, { bookingId: 'Rf63vMqqWdS0MICDAHKmrw' });
  assert.equal(booked.title, 'x');
  assert.equal(booked.canInvite, false, 'no guests to edit where invitations don\'t go out');
});

const BOOKING_ID = 'Rf63vMqqWdS0MICDAHKmrw';
const BOOKING_UID = `${BOOKING_ID}@meet.example`;
const bookingInput = (m) => ({
  accountId: 'g1',
  calendarId: 'me@example.com',
  id: 'abcdefghij0123',
  title: '30 minute meeting: Bart and Jane',
  location: '',
  description: 'Booked through the booking page',
  allDay: false,
  start: at(m, 3, 10).getTime(),
  end: at(m, 3, 10, 30).getTime(),
  guests: { add: [{ address: 'jane@example.com', name: 'Jane' }] },
  addMeet: true
});
const bookingOpts = { notify: true, bookingId: BOOKING_ID, uid: BOOKING_UID };
const ofBooking = (fake) => fake.store.filter((e) => e.extendedProperties && e.extendedProperties.private && e.extendedProperties.private.rukooBooking === BOOKING_ID);

test('a booking event is made with the booking uid, found again on a retry by its booking id, and brought back after it was deleted', async () => {
  // Google's insert reference doesn't list iCalUID, so this fake gives the event a uid of its own.
  const fake = fakeCalendar();
  const { calendars, m } = await opened(fake);
  const booking = bookingInput(m);
  const made = await calendars.create(booking, bookingOpts);
  const post = last(fake, 'POST');
  assert.equal(post.body.iCalUID, BOOKING_UID);
  assert.equal(post.body.id, undefined, 'no client id next to the uid');
  assert.deepEqual(post.body.extendedProperties, { private: { rukooBooking: BOOKING_ID } });
  assert.equal(post.body.conferenceData.createRequest.requestId, BOOKING_ID, "Meet's request id is the booking id");
  assert.equal(made.bookingId, BOOKING_ID);
  assert.equal(made.uid, ofBooking(fake)[0].iCalUID, 'the event says which uid Google gave it');
  assert.notEqual(made.uid, BOOKING_UID);
  // Looked for first by the booking id, then by the uid, deleted events included.
  const lookups = fake.requests.filter((r) => r.method === 'GET' && r.path.endsWith('/events') && !r.query.singleEvents);
  assert.deepEqual(lookups.map((r) => [r.query.privateExtendedProperty, r.query.iCalUID, r.query.showDeleted]), [
    [`rukooBooking=${BOOKING_ID}`, undefined, 'true'],
    [undefined, BOOKING_UID, 'true']
  ]);

  // A retry after a lost answer: the event is found by its booking id, no second one is made, and nobody is mailed again.
  const posts = fake.requests.filter((r) => r.method === 'POST').length;
  const again = await calendars.create({ ...booking, title: 'Renamed' }, bookingOpts);
  assert.equal(fake.requests.filter((r) => r.method === 'POST').length, posts);
  assert.equal(again.eventId, made.eventId);
  assert.equal(last(fake, 'PATCH').query.sendUpdates, 'none');
  assert.equal('conferenceData' in last(fake, 'PATCH').body, false, 'the Meet link it has stays');
  assert.equal(ofBooking(fake).length, 1);

  // Deleted in Google Calendar since: the same event comes back, confirmed, with every field.
  await calendars.remove(again.id, { etag: again.etag });
  assert.equal(ofBooking(fake)[0].status, 'cancelled');
  const back = await calendars.create(booking, bookingOpts);
  const restore = last(fake, 'PATCH');
  assert.equal(restore.body.status, 'confirmed');
  assert.equal(restore.query.sendUpdates, 'all');
  assert.equal(restore.body.summary, booking.title);
  assert.deepEqual(restore.body.attendees.map((a) => a.email), ['jane@example.com']);
  assert.deepEqual(restore.body.extendedProperties, { private: { rukooBooking: BOOKING_ID } });
  assert.equal(back.eventId, made.eventId);
  assert.equal(calendars.event(back.id).title, booking.title);
  assert.equal(ofBooking(fake).length, 1);
});

test('where Google keeps the booking uid, the event has it, and a create that collides with it finds the event instead', async () => {
  // The next lookups miss the event, as when two tries run at once.
  let hide = 0;
  const lookup = (method, url) => method === 'GET' && url.pathname.endsWith('/events') && url.searchParams.get('showDeleted') === 'true';
  const fake = fakeCalendar({ insertUid: 'keep', fail: ({ method, url }) => (lookup(method, url) && hide > 0 && hide-- ? { status: 200, body: { items: [] } } : null) });
  const { calendars, m } = await opened(fake);
  const booking = bookingInput(m);
  const made = await calendars.create(booking, bookingOpts);
  assert.equal(made.uid, BOOKING_UID);

  // Both lookups before the insert miss it; the insert answers 409 for the uid it has; the lookup after that finds it.
  hide = 2;
  const from = fake.requests.length;
  const again = await calendars.create({ ...booking, title: 'Second try' }, bookingOpts);
  const sent = fake.requests.slice(from);
  assert.deepEqual(sent.filter((r) => r.method !== 'GET' || r.query.showDeleted).map((r) => [r.method, r.query.privateExtendedProperty || r.query.iCalUID || null]), [
    ['GET', `rukooBooking=${BOOKING_ID}`],
    ['GET', BOOKING_UID],
    ['POST', null],
    ['GET', `rukooBooking=${BOOKING_ID}`],
    ['PATCH', null]
  ]);
  assert.equal(again.eventId, made.eventId);
  assert.equal(again.title, 'Second try');
  assert.equal(ofBooking(fake).length, 1);
});

test('a client id that already exists as a deleted event is restored instead of patched blind', async () => {
  const fake = fakeCalendar({ events: [{ id: 'abcdefghij0123', summary: 'Old', status: 'cancelled', start: { dateTime: iso(at(monday(), 2, 9)) }, end: { dateTime: iso(at(monday(), 2, 10)) } }] });
  const { calendars, m } = await opened(fake);
  const made = await calendars.create({ accountId: 'g1', calendarId: 'me@example.com', id: 'abcdefghij0123', title: 'Dentist', allDay: false, start: at(m, 2, 9).getTime(), end: at(m, 2, 10).getTime() });
  const patch = last(fake, 'PATCH');
  assert.equal(patch.body.status, 'confirmed');
  assert.equal(patch.body.summary, 'Dentist');
  assert.equal(made.title, 'Dentist');
  assert.equal(fake.store[0].status, 'confirmed');
});

test('a Meet link Google is still making is read again until it is there', async () => {
  const fake = fakeCalendar({ conference: 'pending', pendingReads: 2 });
  const { calendars, m } = await opened(fake);
  calendars.conferenceDelays = [5, 10, 40];
  const made = await calendars.create({ accountId: 'g1', calendarId: 'me@example.com', title: 'Call', allDay: false, start: at(m, 2, 9).getTime(), end: at(m, 2, 10).getTime(), addMeet: true });
  assert.deepEqual([made.conference, made.meeting], [{ solution: 'hangoutsMeet', pending: true }, null]);
  await new Promise((resolve) => setTimeout(resolve, 100));
  await settle(calendars);
  const now = calendars.event(made.id);
  assert.deepEqual(now.conference, { solution: 'hangoutsMeet', pending: false });
  assert.match(now.meeting, /^https:\/\/meet\.google\.com\//);
  assert.equal(fake.requests.filter((r) => r.method === 'GET' && r.path.endsWith(`/events/${made.eventId}`)).length, 2, 'read until it was ready, then no more');
});

test('a change to the guests is a diff applied to a fresh copy with every guest, room and answer', async () => {
  const fake = fakeCalendar({
    events: [
      {
        id: 'q1',
        summary: 'Quarterly review',
        start: { dateTime: iso(at(monday(), 2, 14)) },
        end: { dateTime: iso(at(monday(), 2, 15)) },
        ...mine,
        attendees: [
          { email: 'me@example.com', self: true, organizer: true, responseStatus: 'accepted' },
          { email: 'joris@example.com', responseStatus: 'accepted', comment: 'See you there' },
          { email: 'sanne@example.com', responseStatus: 'tentative' },
          { email: 'room-1@resource.calendar.google.com', resource: true, responseStatus: 'accepted' }
        ]
      },
      {
        id: 'inv',
        summary: 'Their meeting',
        start: { dateTime: iso(at(monday(), 3, 14)) },
        end: { dateTime: iso(at(monday(), 3, 15)) },
        organizer: { email: 'joris@example.com' },
        attendees: [{ email: 'joris@example.com', organizer: true }, { email: 'me@example.com', self: true, responseStatus: 'accepted' }]
      },
      { id: 'part', summary: 'Big town hall', attendeesOmitted: true, start: { dateTime: iso(at(monday(), 4, 14)) }, end: { dateTime: iso(at(monday(), 4, 15)) }, ...mine }
    ]
  });
  const { calendars, find, changes } = await opened(fake);
  const review = find('q1');
  assert.equal(review.canInvite, 'edit');
  // The cached list has no room; the change still keeps it.
  assert.deepEqual(review.attendees.map((a) => a.address), ['me@example.com', 'joris@example.com', 'sanne@example.com']);
  const saved = await calendars.update(review.id, input(review, { guests: { add: [{ address: 'kim@example.com', name: 'Kim' }], remove: ['sanne@example.com'], optional: { 'joris@example.com': true } } }), { notify: true, etag: review.etag });
  const get = fake.requests.find((r) => r.method === 'GET' && r.path.endsWith('/events/q1'));
  assert.equal(get.query.maxAttendees, '1000');
  const patch = last(fake, 'PATCH');
  assert.equal(patch.query.sendUpdates, 'all');
  assert.deepEqual(patch.body.attendees, [
    { email: 'me@example.com', self: true, organizer: true, responseStatus: 'accepted' },
    { email: 'joris@example.com', responseStatus: 'accepted', comment: 'See you there', optional: true },
    { email: 'room-1@resource.calendar.google.com', resource: true, responseStatus: 'accepted' },
    { email: 'kim@example.com', displayName: 'Kim', responseStatus: 'needsAction' }
  ]);
  assert.deepEqual(saved.attendees.map((a) => [a.address, a.optional]), [['me@example.com', false], ['joris@example.com', true], ['kim@example.com', false]]);
  assert.equal(changes.pop().kind, 'update');

  // A guest may add to the list but not take anyone off it.
  const theirs = find('inv');
  assert.equal(theirs.canInvite, 'add');
  await assert.rejects(calendars.update(theirs.id, input(theirs, { guests: { remove: ['joris@example.com'] } }), { etag: theirs.etag }), refusedWith('errors.calendar.notOrganizer'));
  await assert.rejects(calendars.update(theirs.id, input(theirs, { title: 'Mine now', guests: { add: [{ address: 'kim@example.com' }] } }), { etag: theirs.etag }), (err) => err.code === 'read_only');
  const added = await calendars.update(theirs.id, input(theirs, { guests: { add: [{ address: 'kim@example.com' }] } }), { etag: theirs.etag });
  assert.deepEqual(Object.keys(last(fake, 'PATCH').body), ['attendees'], 'nothing but the guest list goes out');
  assert.deepEqual(added.attendees.map((a) => a.address), ['joris@example.com', 'me@example.com', 'kim@example.com']);
  // A list Google leaves partly out can't be edited.
  const part = find('part');
  await assert.rejects(calendars.update(part.id, input(part, { guests: { add: [{ address: 'kim@example.com' }] } }), { etag: part.etag }), refusedWith('errors.calendar.guestListPartial'));
  // ...also when the cache didn't know: the fresh copy decides.
  fake.store.find((e) => e.id === 'q1').attendeesOmitted = true;
  const latest = calendars.event(saved.id);
  await assert.rejects(calendars.update(latest.id, input(latest, { guests: { add: [{ address: 'lee@example.com' }] } }), { etag: latest.etag }), refusedWith('errors.calendar.guestListPartial'));
  // Removing never takes the organizer or a room off.
  assert.equal(applyGuests([{ email: 'me@example.com', organizer: true }, { email: 'r@resource.calendar.google.com', resource: true }], { remove: ['me@example.com', 'r@resource.calendar.google.com'] }).length, 2);
});

test('a guest list longer than Google sends is never edited: refused when the fresh copy still leaves guests out', async () => {
  const people = (n) => Array.from({ length: n }, (_, i) => ({ email: `guest${i}@example.com`, responseStatus: 'accepted' }));
  const me = { email: 'me@example.com', self: true, organizer: true, responseStatus: 'accepted' };
  const fake = fakeCalendar({
    attendeeCap: 4,
    events: [
      { id: 'small', summary: 'Small', start: { dateTime: iso(at(monday(), 2, 9)) }, end: { dateTime: iso(at(monday(), 2, 10)) }, ...mine, attendees: [me, ...people(3)] },
      { id: 'big', summary: 'Town hall', start: { dateTime: iso(at(monday(), 3, 9)) }, end: { dateTime: iso(at(monday(), 3, 10)) }, ...mine, attendees: [me, ...people(9)] }
    ]
  });
  const { calendars, find } = await opened(fake);
  const big = find('big');
  assert.deepEqual([big.moreAttendees, big.canInvite, big.attendees.map((a) => a.address)], [true, false, ['me@example.com']], 'Google sent only the user');
  const patches = fake.requests.filter((r) => r.method === 'PATCH').length;
  await assert.rejects(calendars.update(big.id, input(big, { guests: { add: [{ address: 'kim@example.com' }] } }), { etag: big.etag }), refusedWith('errors.calendar.guestListPartial'));

  // Fine when the list fit, until someone adds guests elsewhere: the fresh copy with maxAttendees=1000 still leaves
  // them out, so the change is refused instead of dropping them.
  const small = find('small');
  assert.equal(small.canInvite, 'edit');
  fake.store.find((e) => e.id === 'small').attendees.push(...people(5).slice(3));
  await assert.rejects(calendars.update(small.id, input(small, { guests: { add: [{ address: 'kim@example.com' }] } }), { etag: small.etag }), refusedWith('errors.calendar.guestListPartial'));
  assert.equal(fake.requests.filter((r) => r.method === 'GET' && r.path.endsWith('/events/small')).pop().query.maxAttendees, '1000');
  assert.equal(fake.requests.filter((r) => r.method === 'PATCH').length, patches, 'nothing went out');
});

test('a guest may add a guest to an invitation whose title ends with a space', async () => {
  const fake = fakeCalendar({
    events: [
      {
        id: 'inv',
        summary: 'Planning ',
        location: ' Room 4 ',
        start: { dateTime: iso(at(monday(), 1, 9)) },
        end: { dateTime: iso(at(monday(), 1, 10)) },
        organizer: { email: 'boss@example.com' },
        attendees: [{ email: 'boss@example.com', organizer: true, responseStatus: 'accepted' }, { email: 'me@example.com', self: true, responseStatus: 'accepted' }]
      }
    ]
  });
  const { calendars, find } = await opened(fake);
  const e = find('inv');
  assert.deepEqual([e.canEdit, e.canInvite, e.title], [false, 'add', 'Planning ']);
  const saved = await calendars.update(e.id, input(e, { guests: { add: [{ address: 'x@example.com' }] } }), { etag: e.etag });
  assert.deepEqual(Object.keys(last(fake, 'PATCH').body), ['attendees']);
  assert.equal(saved.title, 'Planning ', 'the title stays as the organizer wrote it');
  assert.ok(saved.attendees.some((a) => a.address === 'x@example.com'));
  await assert.rejects(calendars.update(e.id, input(saved, { title: 'Planning!', guests: { add: [{ address: 'y@example.com' }] } }), { etag: saved.etag }), (err) => err.code === 'read_only');
});

test('show as, visibility, reminders and Meet on a change, and a rule asked for one occurrence', async () => {
  const fake = fakeCalendar({
    events: [
      { id: 'c1', summary: 'Call', start: { dateTime: iso(at(monday(), 1, 9)) }, end: { dateTime: iso(at(monday(), 1, 10)) }, ...mine, reminders: { useDefault: false, overrides: [{ method: 'email', minutes: 1440 }] } },
      { id: 'rep', summary: 'Weekly', start: { dateTime: iso(at(monday(), 0, 9)), timeZone: 'Europe/Amsterdam' }, end: { dateTime: iso(at(monday(), 0, 10)), timeZone: 'Europe/Amsterdam' }, recurrence: ['RRULE:FREQ=DAILY;COUNT=5'], ...mine }
    ]
  });
  const { calendars, find, week } = await opened(fake);
  const call = find('c1');
  assert.deepEqual(call.reminders, { useDefault: false, overrides: [{ method: 'email', minutes: 1440 }] });
  const reminders = { useDefault: false, overrides: [{ method: 'email', minutes: 1440 }, { method: 'popup', minutes: 10 }] };
  let saved = await calendars.update(call.id, input(call, { busy: false, visibility: 'private', reminders, addMeet: true }), { etag: call.etag });
  let patch = last(fake, 'PATCH');
  assert.equal(patch.query.conferenceDataVersion, '1');
  assert.deepEqual([patch.body.transparency, patch.body.visibility], ['transparent', 'private']);
  assert.deepEqual(patch.body.reminders, reminders, 'the email reminder stays');
  assert.equal(patch.body.conferenceData.createRequest.conferenceSolutionKey.type, 'hangoutsMeet');
  assert.match(saved.meeting, /^https:\/\/meet\.google\.com\//);
  assert.deepEqual([saved.busy, saved.visibility], [false, 'private']);
  // Fields left out stay as they are.
  saved = await calendars.update(saved.id, input(saved, { title: 'Call with Kim' }), { etag: saved.etag });
  patch = last(fake, 'PATCH');
  assert.deepEqual(['transparency', 'visibility', 'reminders', 'conferenceData'].filter((k) => k in patch.body), []);
  assert.notEqual(saved.meeting, null);
  saved = await calendars.update(saved.id, input(saved, { addMeet: false, reminders: { useDefault: true, overrides: [] } }), { etag: saved.etag });
  patch = last(fake, 'PATCH');
  assert.equal(patch.body.conferenceData, null);
  assert.deepEqual(patch.body.reminders, { useDefault: true });
  assert.deepEqual([saved.meeting, saved.conference], [null, null]);
  // Meet added again after it was taken off gets a request Google hasn't seen.
  saved = await calendars.update(saved.id, input(saved, { addMeet: true }), { etag: saved.etag });
  assert.match(saved.meeting, /^https:\/\/meet\.google\.com\//);

  const occurrence = calendars.view(week).events.find((e) => e.seriesId === 'rep');
  await assert.rejects(calendars.update(occurrence.id, input(occurrence, { recurrence: 'FREQ=WEEKLY;BYDAY=MO' }), { etag: occurrence.etag }), refusedWith('errors.calendar.ruleKept'));
});

test('a rule on a single event makes it a series, and the store returns its occurrence', async () => {
  const m = monday();
  const fake = fakeCalendar({ events: [{ id: 'gym', summary: 'Gym', start: { dateTime: iso(at(m, 1, 18)), timeZone: 'Europe/Amsterdam' }, end: { dateTime: iso(at(m, 1, 19)), timeZone: 'Europe/Amsterdam' }, ...mine }] });
  const { calendars, find, changes, week } = await opened(fake);
  const gym = find('gym');
  const series = await calendars.update(gym.id, input(gym, { recurrence: 'FREQ=WEEKLY;BYDAY=TU;WKST=MO' }), { etag: gym.etag });
  assert.deepEqual(last(fake, 'PATCH').body.recurrence, ['RRULE:FREQ=WEEKLY;BYDAY=TU;WKST=MO']);
  assert.equal(series.seriesId, 'gym');
  assert.equal(series.start, gym.start);
  assert.equal(calendars.event(gym.id), null, 'the single event is an occurrence now');
  assert.equal(calendars.view({ start: week.start, end: week.end + 14 * DAY }).events.filter((e) => e.seriesId === 'gym').length, 3);
  const c = changes.pop();
  assert.deepEqual([c.kind, c.scope, c.event.id, c.previous.id], ['series', 'all', series.id, gym.id]);
  // Taking the rule off a single event changes nothing at all.
  const other = await calendars.create({ accountId: 'g1', calendarId: 'me@example.com', title: 'Once', allDay: false, start: at(m, 3, 9).getTime(), end: at(m, 3, 10).getTime() });
  await calendars.update(other.id, input(other, { recurrence: null }), { etag: other.etag });
  assert.equal('recurrence' in last(fake, 'PATCH').body, false);
});

test('moving an event or a whole series to another calendar of the account', async () => {
  const m = monday();
  const fake = fakeCalendar({
    events: [
      { id: 'one', summary: 'Lunch', start: { dateTime: iso(at(m, 1, 12)) }, end: { dateTime: iso(at(m, 1, 13)) }, ...mine },
      { id: 'rep', summary: 'Daily', start: { dateTime: iso(at(m, 0, 9)), timeZone: 'Europe/Amsterdam' }, end: { dateTime: iso(at(m, 0, 9, 15)), timeZone: 'Europe/Amsterdam' }, recurrence: ['RRULE:FREQ=DAILY;COUNT=3'], ...mine },
      { id: 'bday', summary: 'Birthday', eventType: 'birthday', start: { date: day(at(m, 2, 0)) }, end: { date: day(at(m, 3, 0)) }, ...mine },
      { id: 'inv', summary: 'Theirs', start: { dateTime: iso(at(m, 3, 12)) }, end: { dateTime: iso(at(m, 3, 13)) }, organizer: { email: 'joris@example.com' }, attendees: [{ email: 'me@example.com', self: true }] }
    ]
  });
  const { calendars, find, changes, week } = await opened(fake);
  const lunch = find('one');
  assert.equal(lunch.canMove, true);
  const moved = await calendars.move(lunch.id, 'team@example.com', { notify: true });
  const post = last(fake, 'POST');
  assert.equal(post.path, '/calendars/me@example.com/events/one/move');
  assert.deepEqual([post.query.destination, post.query.sendUpdates], ['team@example.com', 'all']);
  assert.deepEqual([moved.calendarId, moved.eventId, moved.title], ['team@example.com', 'one', 'Lunch']);
  assert.equal(calendars.event(lunch.id), null);
  assert.equal(calendars.view(week).events.filter((e) => e.eventId === 'one').length, 1);
  const c = changes.pop();
  assert.deepEqual([c.kind, c.scope, c.calendarId, c.previous.calendarId, c.event.id], ['move', 'one', 'team@example.com', 'me@example.com', moved.id]);

  // An occurrence takes its series along.
  const occurrence = calendars.view(week).events.find((e) => e.seriesId === 'rep' && e.start === at(m, 1, 9).getTime());
  const series = await calendars.move(occurrence.id, 'team@example.com');
  assert.equal(last(fake, 'POST').path, '/calendars/me@example.com/events/rep/move');
  assert.deepEqual([series.calendarId, series.start], ['team@example.com', occurrence.start]);
  assert.deepEqual(calendars.view(week).events.filter((e) => e.seriesId === 'rep').map((e) => e.calendarId), ['team@example.com', 'team@example.com', 'team@example.com']);

  const posts = fake.requests.filter((r) => r.method === 'POST').length;
  await assert.rejects(calendars.move(find('bday').id, 'team@example.com'), refusedWith('errors.calendar.cannotMove'));
  await assert.rejects(calendars.move(find('inv').id, 'team@example.com'), refusedWith('errors.calendar.cannotMove'));
  await assert.rejects(calendars.move(moved.id, 'nl#holiday@group.v.calendar.google.com'), (err) => err.code === 'read_only');
  assert.equal(fake.requests.filter((r) => r.method === 'POST').length, posts, 'nothing went out');
});

test('search: Google looks a year back and ahead itself; the demo calendar is searched in what Rukoo reads', async () => {
  const m = monday();
  const fake = fakeCalendar({
    events: [
      { id: 's1', summary: 'Roadmap review', start: { dateTime: iso(at(m, 40, 10)) }, end: { dateTime: iso(at(m, 40, 11)) }, ...mine },
      { id: 's2', summary: 'Lunch', description: 'about the roadmap', start: { dateTime: iso(at(m, -100, 12)) }, end: { dateTime: iso(at(m, -100, 13)) }, ...mine },
      { id: 's3', summary: 'Gym', start: { dateTime: iso(at(m, 1, 18)) }, end: { dateTime: iso(at(m, 1, 19)) }, ...mine }
    ]
  });
  const { calendars } = setup(fake, { extra: [DEMO] });
  const found = await calendars.search('  Roadmap ');
  const google = found.events.filter((e) => e.accountId === 'g1');
  assert.deepEqual(google.map((e) => e.eventId), ['s2', 's1'], 'by start');
  const list = fake.requests.find((r) => r.query.q);
  assert.equal(list.query.q, 'Roadmap');
  assert.equal(list.query.singleEvents, 'true');
  const year = 365 * DAY;
  assert.ok(Math.abs(Date.parse(list.query.timeMax) - Date.now() - year) < 60000 && Math.abs(Date.now() - Date.parse(list.query.timeMin) - year) < 60000);
  // The demo account's "Roadmap review" comes from its own calendar, read without opening the view.
  assert.ok(found.events.some((e) => e.accountId === 'd1' && /Roadmap/.test(e.title)));
  assert.deepEqual(found.failed, []);
  assert.equal(calendars.loading.size, 0);
  // A result far outside anything read yet still opens its card, until a change lets go of what was read outside.
  const far = google.find((e) => e.eventId === 's1');
  assert.equal(calendars.event(far.id)?.title, 'Roadmap review');
  calendars.dropMemos('g1');
  assert.equal(calendars.event(far.id), null);
  await assert.rejects(calendars.search('   '), invalidWith('errors.calendar.invalidQuery'));
  await assert.rejects(calendars.search('x'.repeat(201)), invalidWith('errors.calendar.invalidQuery'));
});
