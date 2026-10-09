'use strict';

// The calendar store against a fake Google Calendar API, and the demo calendar.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Engine } = require('../src/main/engine');
const { Calendars } = require('../src/main/calendar');
const { DemoCalendar } = require('../src/main/calendar/demo');
const { toEvent, GoogleCalendar } = require('../src/main/calendar/google');
const { CALENDAR_SCOPES } = require('../src/main/google');

const DAY = 86400000;
const API = 'https://www.googleapis.com/calendar/v3';

// A Google Calendar with two calendars, answering the calls Rukoo makes and recording them.
function fakeCalendar({ events = [], fail = null } = {}) {
  const calendars = [
    { id: 'me@example.com', summary: 'me@example.com', primary: true, accessRole: 'owner', timeZone: 'Europe/Amsterdam' },
    { id: 'nl#holiday@group.v.calendar.google.com', summary: 'Holidays', accessRole: 'reader', selected: false },
    { id: 'busy@example.com', summary: 'Free/busy only', accessRole: 'freeBusyReader' }
  ];
  const store = events.map((e) => ({ calendarId: 'me@example.com', ...e }));
  const requests = [];
  let next = 1;
  const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
  const fetchImpl = async (url, opts = {}) => {
    const u = new URL(url);
    const method = opts.method || 'GET';
    const body = opts.body ? JSON.parse(opts.body) : null;
    requests.push({ method, path: decodeURIComponent(u.pathname.replace('/calendar/v3', '')), query: Object.fromEntries(u.searchParams), body, auth: opts.headers.authorization });
    if (fail) {
      const answer = fail({ method, url: u, body });
      if (answer) return json(answer.status, answer.body);
    }
    const parts = u.pathname.replace('/calendar/v3/', '').split('/').map(decodeURIComponent);
    if (parts[0] === 'users') return json(200, { items: calendars });
    const calendarId = parts[1];
    const eventId = parts[3];
    if (!eventId && method === 'GET') {
      const from = Date.parse(u.searchParams.get('timeMin'));
      const to = Date.parse(u.searchParams.get('timeMax'));
      const at = (t) => (t.date ? new Date(`${t.date}T00:00:00`).getTime() : Date.parse(t.dateTime));
      return json(200, { items: store.filter((e) => e.calendarId === calendarId && at(e.start) < to && at(e.end) > from) });
    }
    if (!eventId && method === 'POST') {
      if (body.id && store.some((e) => e.calendarId === calendarId && e.id === body.id)) {
        return json(409, { error: { code: 409, message: 'The requested identifier already exists.', errors: [{ reason: 'duplicate' }] } });
      }
      const item = { ...body, calendarId, id: body.id || `new${next++}`, status: 'confirmed', organizer: { email: 'me@example.com', self: true }, htmlLink: 'https://www.google.com/calendar/event?eid=x' };
      store.push(item);
      return json(200, item);
    }
    const item = store.find((e) => e.calendarId === calendarId && e.id === eventId);
    if (!item) return json(404, { error: { code: 404, message: 'Not Found' } });
    if (method === 'GET') return json(200, item);
    if (method === 'PATCH') {
      for (const [k, v] of Object.entries(body)) item[k] = v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries({ ...item[k], ...v }).filter(([, x]) => x !== null)) : v;
      return json(200, item);
    }
    if (method === 'DELETE') {
      store.splice(store.indexOf(item), 1);
      return { ok: true, status: 204, json: async () => ({}) };
    }
    return json(400, {});
  };
  return { fetchImpl, requests, store };
}

function setup(fake, { scopes = CALENDAR_SCOPES, extra = [] } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sem-cal-'));
  fs.writeFileSync(
    path.join(dataDir, 'accounts.json'),
    JSON.stringify([{ id: 'g1', type: 'imap', provider: 'google', auth: 'oauth2', email: 'me@example.com', color: '#4a7dff', secret: 'rt', scopes: ['https://mail.google.com/', ...scopes] }, ...extra])
  );
  const google = { available: () => true, refresh: async () => ({ accessToken: 'token-1', expiresAt: Date.now() + 3600000 }) };
  const engine = new Engine({ dataDir, google }).init();
  const calendars = new Calendars({ engine, fetchImpl: fake.fetchImpl });
  return { engine, calendars, dataDir };
}

// Waits for the background fetches a view started.
async function settle(calendars) {
  for (let i = 0; i < 5; i++) await Promise.all([...calendars.queues.values()]);
}

function monday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getTime();
}
const at = (base, days, h, m = 0) => {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  d.setHours(h, m, 0, 0);
  return d;
};
const iso = (d) => d.toISOString();
const day = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

test('which accounts have a calendar: Google with the grant, Google without it, the demo, and no others', () => {
  const fake = fakeCalendar();
  const { calendars } = setup(fake, {
    extra: [
      { id: 'g2', type: 'imap', provider: 'google', auth: 'oauth2', email: 'old@example.com', secret: 'rt' },
      { id: 'g3', type: 'imap', provider: 'google', auth: 'password', email: 'pw@example.com', secret: 'pw' },
      { id: 'y1', type: 'imap', provider: 'yahoo', auth: 'password', email: 'me@yahoo.com', secret: 'pw' },
      { id: 'd1', type: 'demo', provider: 'demo', email: 'demo@example.com', name: 'Demo User' }
    ]
  });
  const view = calendars.view({ start: monday(), end: monday() + 7 * DAY });
  const states = Object.fromEntries(view.accounts.map((a) => [a.id, a.state]));
  assert.deepEqual(states, { g1: 'ready', g2: 'reconnect', g3: 'reconnect', d1: 'ready' });
  // Accounts without the calendar never reach Google.
  return settle(calendars).then(() => assert.ok(fake.requests.every((r) => r.auth === 'Bearer token-1')));
});

test('a view fetches its weeks once, with expanded recurring events, and later only the missing weeks', async () => {
  const m = monday();
  const fake = fakeCalendar({
    events: [
      { id: 'e1', summary: 'Planning', start: { dateTime: iso(at(m, 1, 14)), timeZone: 'Europe/Amsterdam' }, end: { dateTime: iso(at(m, 1, 15, 30)) } },
      { id: 'e2', summary: 'Offsite', start: { date: day(at(m, 3, 0)) }, end: { date: day(at(m, 5, 0)) } },
      { id: 'e3', summary: 'Office', eventType: 'workingLocation', start: { date: day(at(m, 2, 0)) }, end: { date: day(at(m, 3, 0)) } },
      { id: 'far', summary: 'Next month', start: { dateTime: iso(at(m, 30, 9)) }, end: { dateTime: iso(at(m, 30, 10)) } }
    ]
  });
  const { calendars } = setup(fake);
  const week = { start: m, end: m + 7 * DAY };
  const first = calendars.view(week);
  assert.equal(first.accounts[0].loading, true);
  assert.deepEqual(first.events, []);
  await settle(calendars);

  const second = calendars.view(week);
  assert.equal(second.accounts[0].loading, false);
  assert.deepEqual(second.accounts[0].calendars.map((c) => [c.name, c.writable, c.selected]), [
    ['me@example.com', true, true],
    ['Holidays', false, false]
  ]);
  const titles = second.events.map((e) => e.title).sort();
  assert.deepEqual(titles, ['Offsite', 'Planning'], 'working locations are left out');
  const offsite = second.events.find((e) => e.title === 'Offsite');
  assert.equal(offsite.allDay, true);
  assert.equal(offsite.start, at(m, 3, 0).getTime(), 'all-day events start at local midnight');
  assert.equal(offsite.endDate, day(at(m, 5, 0)));

  const lists = fake.requests.filter((r) => r.path.endsWith('/events'));
  assert.equal(lists.length, 2, 'one list per calendar; free/busy-only calendars are skipped');
  assert.equal(lists[0].query.singleEvents, 'true');
  assert.equal(lists[0].query.orderBy, 'startTime');
  // Two weeks around the view, and two days more on each side for calendars in another time zone.
  assert.equal(Date.parse(lists[0].query.timeMin), m - 16 * DAY);
  assert.equal(Date.parse(lists[0].query.timeMax), m + 23 * DAY);

  // Next week lies inside the fetched stretch: no request.
  fake.requests.length = 0;
  calendars.view({ start: m + 7 * DAY, end: m + 14 * DAY });
  await settle(calendars);
  assert.equal(fake.requests.length, 0);

  // A month ahead: only the weeks after the cached stretch are fetched, and the calendars are not listed again.
  calendars.view({ start: m + 28 * DAY, end: m + 35 * DAY });
  await settle(calendars);
  assert.ok(fake.requests.every((r) => r.path.endsWith('/events')));
  assert.ok(fake.requests.every((r) => Date.parse(r.query.timeMin) === m + 19 * DAY));
  const later = calendars.view({ start: m + 28 * DAY, end: m + 35 * DAY });
  assert.deepEqual(later.events.map((e) => e.title), ['Next month']);
});

test('Google events: times, guests, answers and what the user may change', () => {
  const cal = { id: 'me@example.com', writable: true, timeZone: 'Europe/Amsterdam' };
  const invite = toEvent(
    {
      id: 'i1',
      recurringEventId: 'series',
      summary: 'Quarterly planning',
      description: '<p>Agenda in the <a href="https://docs.example.com/agenda">doc</a>.</p>',
      start: { dateTime: '2026-10-13T14:00:00+02:00' },
      end: { dateTime: '2026-10-13T15:30:00+02:00' },
      organizer: { email: 'joris@example.com', displayName: 'Joris' },
      attendees: [
        { email: 'joris@example.com', organizer: true, responseStatus: 'accepted' },
        { email: 'me@example.com', self: true, responseStatus: 'needsAction' },
        { email: 'room@resource.calendar.google.com', resource: true, responseStatus: 'accepted' }
      ],
      hangoutLink: 'https://meet.google.com/abc-defg-hij',
      htmlLink: 'https://www.google.com/calendar/event?eid=i1'
    },
    cal
  );
  assert.equal(invite.start, Date.parse('2026-10-13T12:00:00Z'));
  assert.equal(invite.timeZone, 'Europe/Amsterdam', "the calendar's zone when the event names none");
  assert.equal(invite.response, 'needsAction');
  assert.equal(invite.canRespond, true);
  assert.equal(invite.canEdit, false, "someone else's meeting");
  assert.equal(invite.seriesId, 'series');
  assert.deepEqual(invite.attendees.map((a) => a.address), ['joris@example.com', 'me@example.com'], 'rooms are not guests');
  assert.equal(invite.meeting, 'https://meet.google.com/abc-defg-hij');
  assert.match(invite.description, /doc \[https:\/\/docs\.example\.com\/agenda\]/);

  const own = toEvent({ id: 'o1', start: { dateTime: '2026-10-13T09:00:00Z' }, end: { dateTime: '2026-10-13T10:00:00Z' }, organizer: { email: 'me@example.com', self: true } }, cal);
  assert.equal(own.canEdit, true);
  assert.equal(own.canRespond, false);
  assert.equal(own.response, null);
  assert.equal(toEvent({ id: 'r1', start: { date: '2026-10-13' }, end: { date: '2026-10-14' } }, { ...cal, writable: false }).canEdit, false);
  assert.equal(toEvent({ id: 'l1', locked: true, start: { date: '2026-10-13' }, end: { date: '2026-10-14' } }, cal).canEdit, false);
});

test('creating, changing and deleting send what Google expects and keep the cache in step', async () => {
  const m = monday();
  const fake = fakeCalendar({
    events: [
      {
        id: 'm1',
        summary: 'Review',
        start: { dateTime: iso(at(m, 2, 10)), timeZone: 'America/New_York' },
        end: { dateTime: iso(at(m, 2, 11)), timeZone: 'America/New_York' },
        organizer: { email: 'me@example.com', self: true },
        attendees: [{ email: 'me@example.com', self: true, organizer: true, responseStatus: 'accepted' }, { email: 'joris@example.com', responseStatus: 'accepted' }]
      },
      {
        id: 'f1',
        summary: 'Flight',
        description: '<p><b>Agenda</b>: <a href="https://example.com/doc">read here</a></p>',
        start: { dateTime: iso(at(m, 4, 7)), timeZone: 'Europe/Amsterdam' },
        end: { dateTime: iso(at(m, 4, 9)), timeZone: 'Europe/London' },
        organizer: { email: 'me@example.com', self: true }
      }
    ]
  });
  const { calendars } = setup(fake);
  const week = { start: m, end: m + 7 * DAY };
  calendars.view(week);
  await settle(calendars);

  // A rename leaves the formatted description alone and keeps both time zones of the flight.
  const flight = calendars.view(week).events.find((e) => e.title === 'Flight');
  assert.equal(flight.description, 'Agenda: read here [https://example.com/doc]');
  await calendars.update(flight.id, { title: 'Flight to London', description: flight.description, allDay: false, start: flight.start, end: flight.end });
  const rename = fake.requests.filter((r) => r.method === 'PATCH').pop();
  assert.equal('description' in rename.body, false);
  assert.equal(rename.body.start.timeZone, 'Europe/Amsterdam');
  assert.equal(rename.body.end.timeZone, 'Europe/London');
  await calendars.update(flight.id, { title: 'Flight to London', description: 'Gate D7', allDay: false, start: flight.start, end: flight.end });
  assert.equal(fake.requests.filter((r) => r.method === 'PATCH').pop().body.description, 'Gate D7');
  fake.requests.length = 0;

  const created = await calendars.create({ accountId: 'g1', calendarId: 'me@example.com', title: ' Dentist ', location: '', description: '', allDay: false, start: at(m, 3, 8, 30).getTime(), end: at(m, 3, 9, 15).getTime() });
  const post = fake.requests.find((r) => r.method === 'POST');
  assert.equal(post.body.summary, 'Dentist');
  assert.equal(post.body.start.dateTime, iso(at(m, 3, 8, 30)));
  assert.equal(post.body.start.timeZone, Intl.DateTimeFormat().resolvedOptions().timeZone, "new events take the PC's zone");
  assert.ok(calendars.view(week).events.some((e) => e.id === created.id));

  await calendars.create({ accountId: 'g1', calendarId: 'me@example.com', title: 'Offsite', allDay: true, startDate: day(at(m, 4, 0)), endDate: day(at(m, 6, 0)) });
  const allDay = fake.requests.filter((r) => r.method === 'POST')[1].body;
  assert.deepEqual(allDay.start, { date: day(at(m, 4, 0)) });
  assert.deepEqual(allDay.end, { date: day(at(m, 6, 0)) }, 'the end date is the day after the last');

  await assert.rejects(calendars.create({ accountId: 'g1', calendarId: 'nl#holiday@group.v.calendar.google.com', title: 'x', start: 1, end: 2 }), /doesn't take new events/);
  await assert.rejects(calendars.create({ accountId: 'g1', calendarId: 'me@example.com', title: 'x', start: 2, end: 1 }), /start before its end/);

  const review = calendars.view(week).events.find((e) => e.title === 'Review');
  await calendars.update(review.id, { title: 'Design review', allDay: false, start: at(m, 2, 10, 30).getTime(), end: at(m, 2, 11, 30).getTime() }, { notify: true });
  const patch = fake.requests.find((r) => r.method === 'PATCH');
  assert.equal(patch.query.sendUpdates, 'all');
  assert.equal(patch.body.start.timeZone, 'America/New_York', 'an edited event keeps its own zone');
  assert.equal(patch.body.start.date, null);
  assert.equal(calendars.view(week).events.find((e) => e.id === review.id).title, 'Design review');

  await calendars.update(review.id, { title: 'Design review', allDay: true, startDate: day(at(m, 2, 0)), endDate: day(at(m, 3, 0)) });
  const toAllDay = fake.requests.filter((r) => r.method === 'PATCH')[1];
  assert.equal(toAllDay.query.sendUpdates, 'none');
  assert.deepEqual(toAllDay.body.start, { dateTime: null, timeZone: null, date: day(at(m, 2, 0)) });

  await calendars.remove(review.id, { notify: false });
  const del = fake.requests.find((r) => r.method === 'DELETE');
  assert.equal(del.path, '/calendars/me@example.com/events/m1');
  assert.equal(del.query.sendUpdates, 'none');
  assert.ok(!calendars.view(week).events.some((e) => e.id === review.id));
});

test('answering an invitation patches only the guest list, for one event or the series', async () => {
  const m = monday();
  const guests = () => [
    { email: 'joris@example.com', organizer: true, responseStatus: 'accepted' },
    { email: 'me@example.com', self: true, responseStatus: 'needsAction' }
  ];
  const fake = fakeCalendar({
    events: [
      { id: 'series', summary: 'Weekly', start: { dateTime: iso(at(m, 0, 9)) }, end: { dateTime: iso(at(m, 0, 10)) }, organizer: { email: 'joris@example.com' }, attendees: guests() },
      ...[0, 1].map((n) => ({
        id: `series_${n}`,
        recurringEventId: 'series',
        summary: 'Weekly',
        start: { dateTime: iso(at(m, n, 9)) },
        end: { dateTime: iso(at(m, n, 10)) },
        organizer: { email: 'joris@example.com' },
        attendees: guests()
      }))
    ]
  });
  const { calendars } = setup(fake);
  const week = { start: m, end: m + 7 * DAY };
  calendars.view(week);
  await settle(calendars);
  const [first] = calendars.view(week).events.filter((e) => e.eventId === 'series_0');

  await calendars.respond(first.id, 'accepted');
  let patch = fake.requests.filter((r) => r.method === 'PATCH').pop();
  assert.equal(patch.path, '/calendars/me@example.com/events/series_0');
  assert.equal(patch.query.sendUpdates, 'all', 'the organizer hears the answer');
  assert.deepEqual(Object.keys(patch.body), ['attendees']);
  assert.deepEqual(patch.body.attendees.map((a) => a.responseStatus), ['accepted', 'accepted']);
  assert.equal(calendars.view(week).events.find((e) => e.id === first.id).response, 'accepted');

  await calendars.respond(first.id, 'declined', { series: true });
  patch = fake.requests.filter((r) => r.method === 'PATCH').pop();
  assert.equal(patch.path, '/calendars/me@example.com/events/series', 'the whole series answers through its first event');
  const answers = calendars.view(week).events.filter((e) => e.seriesId === 'series').map((e) => e.response);
  assert.deepEqual(answers, ['declined', 'declined']);

  await assert.rejects(calendars.respond(first.id, 'maybe'), /isn't an answer/);
});

test('missing grants ask to reconnect; a disabled API and gone events say so', async () => {
  const m = monday();
  const week = { start: m, end: m + 7 * DAY };
  const scope = fakeCalendar({
    fail: () => ({ status: 403, body: { error: { code: 403, message: 'Request had insufficient authentication scopes.', errors: [{ reason: 'insufficientPermissions' }], details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }] } } })
  });
  const a = setup(scope);
  a.calendars.view(week);
  await settle(a.calendars);
  const after = a.calendars.view(week).accounts[0];
  assert.equal(after.state, 'reconnect');
  assert.equal(after.error, null);
  assert.ok(!a.engine.accounts[0].scopes.some((s) => CALENDAR_SCOPES.includes(s)), 'the grant is known to lack the calendar');
  assert.ok(a.engine.accounts[0].scopes.includes('https://mail.google.com/'), 'mail keeps working');

  const activation = 'https://console.developers.google.com/apis/api/calendar-json.googleapis.com/overview?project=123';
  const disabled = fakeCalendar({
    fail: () => ({
      status: 403,
      body: { error: { code: 403, message: 'Google Calendar API has not been used in project 123', errors: [{ reason: 'accessNotConfigured' }], details: [{ reason: 'SERVICE_DISABLED', metadata: { activationUrl: activation } }] } }
    })
  });
  const b = setup(disabled);
  b.calendars.view(week);
  await settle(b.calendars);
  const failed = b.calendars.view(week).accounts[0];
  assert.equal(failed.state, 'error');
  assert.equal(failed.error.code, 'api_disabled');
  assert.equal(failed.error.url, activation);
  const count = disabled.requests.length;
  b.calendars.view(week);
  await settle(b.calendars);
  assert.equal(disabled.requests.length, count, 'views wait a minute before asking again');

  let gone = false;
  const deleted = fakeCalendar({
    events: [{ id: 'x', summary: 'Gone soon', start: { dateTime: iso(at(m, 1, 9)) }, end: { dateTime: iso(at(m, 1, 10)) }, organizer: { email: 'me@example.com', self: true } }],
    fail: ({ method }) => (gone && method === 'PATCH' ? { status: 404, body: { error: { code: 404 } } } : null)
  });
  const c = setup(deleted);
  c.calendars.view(week);
  await settle(c.calendars);
  const [event] = c.calendars.view(week).events;
  gone = true;
  await assert.rejects(c.calendars.update(event.id, { title: 'x', start: event.start, end: event.end }), /no longer exists/);
  assert.deepEqual(c.calendars.view(week).events, [], 'the cache forgets an event that is gone');
});

test('a Save tried again after a lost answer finds the event it made instead of making a second one', async () => {
  const m = monday();
  const fake = fakeCalendar();
  const { calendars } = setup(fake);
  const week = { start: m, end: m + 7 * DAY };
  calendars.view(week);
  await settle(calendars);
  // Google makes the event, but its answer never arrives.
  const real = fake.fetchImpl;
  let lose = true;
  calendars.fetch = async (url, opts) => {
    const res = await real(url, opts);
    if (lose && opts.method === 'POST') {
      lose = false;
      throw new TypeError('fetch failed');
    }
    return res;
  };
  calendars.providers.clear();
  const input = { accountId: 'g1', calendarId: 'me@example.com', title: 'Dentist', allDay: false, start: at(m, 3, 8).getTime(), end: at(m, 3, 9).getTime(), id: 'abcdefghij0123456789' };
  await assert.rejects(calendars.create(input), /Can't reach Google Calendar/);
  // The user changes the title and saves again: the same event gets it.
  const saved = await calendars.create({ ...input, title: 'Dentist (moved)' });
  assert.equal(fake.store.filter((e) => e.id === 'abcdefghij0123456789').length, 1);
  assert.equal(fake.store.length, 1);
  assert.equal(fake.store[0].summary, 'Dentist (moved)');
  assert.equal(saved.eventId, 'abcdefghij0123456789');
  assert.equal(calendars.view(week).events.filter((e) => e.eventId === 'abcdefghij0123456789').length, 1);
  // An id in another format is not sent: Google picks one.
  await calendars.create({ ...input, id: 'Not-Base32!' });
  assert.equal(fake.requests.filter((r) => r.method === 'POST').pop().body.id, undefined);
});

test('an answer that stops halfway fails the fetch and leaves the cached events alone', async () => {
  const m = monday();
  const fake = fakeCalendar({ events: [{ id: 'a', summary: 'Kept', start: { dateTime: iso(at(m, 1, 9)) }, end: { dateTime: iso(at(m, 1, 10)) } }] });
  const { calendars } = setup(fake);
  const week = { start: m, end: m + 7 * DAY };
  calendars.view(week);
  await settle(calendars);
  const real = fake.fetchImpl;
  calendars.fetch = async (url, opts) => {
    const res = await real(url, opts);
    return { ok: res.ok, status: res.status, json: async () => Promise.reject(new Error('aborted')) };
  };
  calendars.providers.clear();
  await assert.rejects(calendars.syncAll(), /Can't reach Google Calendar/);
  assert.deepEqual(calendars.view(week).events.map((e) => e.title), ['Kept']);
});

test('a scope failure from before signing in again does not undo the new grant', async () => {
  const m = monday();
  const fake = fakeCalendar();
  const { calendars, engine } = setup(fake);
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const scope = { error: { code: 403, errors: [{ reason: 'insufficientPermissions' }] } };
  calendars.fetch = async (url, opts) => {
    if (new URL(url).pathname.endsWith('/events')) {
      await gate;
      return { ok: false, status: 403, json: async () => scope };
    }
    return fake.fetchImpl(url, opts);
  };
  const week = { start: m, end: m + 7 * DAY };
  calendars.view(week);
  await new Promise((resolve) => setTimeout(resolve, 20));
  // While the request with the old grant waits, the user signs in again. The new grant is in place while the old
  // mail session still logs out, and that is when the old request fails.
  let closed;
  const closing = new Promise((resolve) => (closed = resolve));
  engine.sessions.set('g1', { close: () => closing });
  engine.syncAccount = async () => [];
  const signedIn = engine.addGoogleAccount(
    { email: 'me@example.com', refreshToken: 'rt-2', accessToken: 'token-2', expiresAt: Date.now() + 3600000, scopes: ['https://mail.google.com/', ...CALENDAR_SCOPES] },
    { reauthId: 'g1' }
  );
  release();
  await settle(calendars);
  closed();
  await signedIn;
  calendars.reconnected('g1');
  assert.ok(CALENDAR_SCOPES.every((s) => engine.accounts[0].scopes.includes(s)), 'the new grant stays');
  assert.equal(calendars.view(week).accounts[0].state, 'ready');
});

test('a list that keeps going past the page limit fails instead of passing for complete', async () => {
  let pages = 0;
  const google = new GoogleCalendar({
    token: async () => 'token',
    fetchImpl: async () => {
      pages++;
      return { ok: true, status: 200, json: async () => ({ items: [], nextPageToken: `p${pages}` }) };
    }
  });
  await assert.rejects(google.events({ id: 'me@example.com', writable: true }, 0, DAY), /more events in this period/);
  assert.equal(pages, 50);
});

test('a sync fetches the cached stretch again, and an account that never opened its calendar waits', async () => {
  const m = monday();
  const fake = fakeCalendar({ events: [{ id: 'a', summary: 'Before', start: { dateTime: iso(at(m, 1, 9)) }, end: { dateTime: iso(at(m, 1, 10)) } }] });
  const { calendars, dataDir } = setup(fake);
  await calendars.syncAll();
  assert.equal(fake.requests.length, 0);
  const week = { start: m, end: m + 7 * DAY };
  calendars.view(week);
  await settle(calendars);
  fake.store[0].summary = 'Changed in Google';
  await calendars.syncAll();
  assert.equal(calendars.view(week).events[0].title, 'Changed in Google');
  calendars.flush();
  const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'calendar', 'g1.json'), 'utf8'));
  assert.equal(saved.events[0].title, 'Changed in Google');
});

test('the demo calendar seeds a week of sample events and keeps changes', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sem-dc-')), 'demo-calendar.json');
  const demo = new DemoCalendar(file, { name: 'Demo User' });
  const cals = await demo.calendars();
  assert.deepEqual(cals.map((c) => [c.id, c.writable]), [['personal', true], ['work', true], ['birthdays', false]]);
  const m = monday();
  const work = await demo.events(cals[1], m, m + 7 * DAY);
  const invite = work.find((e) => e.title === 'Quarterly planning');
  assert.equal(invite.response, 'needsAction');
  assert.equal(work.filter((e) => e.seriesId === 'standup').length, 5);

  await demo.respond(cals[1], invite, 'accepted');
  const made = await demo.create(cals[0], { title: 'Gym', location: '', description: '', allDay: false, start: m + DAY, end: m + DAY + 3600000 });
  await demo.update(cals[0], made, { title: 'Gym class', location: 'Downtown', description: '', allDay: false, start: m + DAY, end: m + DAY + 3600000 });
  const standup = work.find((e) => e.seriesId === 'standup');
  await demo.remove(cals[1], standup, { series: true });
  // A Save tried again with the same id changes the event it made.
  await demo.create(cals[0], { id: 'retry12345', title: 'Swim', location: '', description: '', allDay: false, start: m + 2 * DAY, end: m + 2 * DAY + 3600000 });
  await demo.create(cals[0], { id: 'retry12345', title: 'Swim lesson', location: '', description: '', allDay: false, start: m + 2 * DAY, end: m + 2 * DAY + 3600000 });
  assert.deepEqual((await demo.events(cals[0], m, m + 7 * DAY)).filter((e) => e.eventId === 'retry12345').map((e) => e.title), ['Swim lesson']);

  const again = new DemoCalendar(file, { name: 'Demo User' });
  const personal = await again.events(cals[0], m, m + 7 * DAY);
  assert.equal(personal.find((e) => e.eventId === made.eventId).title, 'Gym class');
  const workAgain = await again.events(cals[1], m - 14 * DAY, m + 42 * DAY);
  assert.equal(workAgain.find((e) => e.title === 'Quarterly planning').response, 'accepted');
  assert.equal(workAgain.filter((e) => e.seriesId === 'standup').length, 0);
});
