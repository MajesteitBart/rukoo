'use strict';

// CalDAV calendars against a small CalDAV server on this PC (test/fixtures/caldav-server.js): finding the calendars,
// reading events and series, the changes Rukoo writes, and an IMAP account with a calendar server in the store.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { caldavServer } = require('./fixtures/caldav-server');
const { CalDavCalendar, discoverCalDav, serverUrl } = require('../src/main/calendar/caldav');
const { Engine } = require('../src/main/engine');
const { Calendars } = require('../src/main/calendar');

const DAY = 86400000;
const ME = 'me@example.com';
const VTIMEZONE = [
  'BEGIN:VTIMEZONE',
  'TZID:Europe/Amsterdam',
  'BEGIN:DAYLIGHT',
  'TZOFFSETFROM:+0100',
  'TZOFFSETTO:+0200',
  'TZNAME:CEST',
  'DTSTART:19700329T020000',
  'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU',
  'END:DAYLIGHT',
  'BEGIN:STANDARD',
  'TZOFFSETFROM:+0200',
  'TZOFFSETTO:+0100',
  'TZNAME:CET',
  'DTSTART:19701025T030000',
  'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU',
  'END:STANDARD',
  'END:VTIMEZONE'
];
const ics = (...lines) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN', ...lines.flat(), 'END:VCALENDAR', ''].join('\r\n');
const vevent = (...lines) => ['BEGIN:VEVENT', 'DTSTAMP:20260101T000000Z', ...lines, 'END:VEVENT'];

// A weekly stand-up on Mondays and Thursdays in Amsterdam, across the change to summer time on 29 March 2026. The
// one on 26 March is excluded and the one on 30 March moved to 11:00.
const STANDUP = ics(
  VTIMEZONE,
  vevent('UID:standup', 'DTSTART;TZID=Europe/Amsterdam:20260316T093000', 'DTEND;TZID=Europe/Amsterdam:20260316T094500', 'RRULE:FREQ=WEEKLY;BYDAY=MO,TH', 'EXDATE;TZID=Europe/Amsterdam:20260326T093000', 'SUMMARY:Stand-up'),
  vevent('UID:standup', 'RECURRENCE-ID;TZID=Europe/Amsterdam:20260330T093000', 'DTSTART;TZID=Europe/Amsterdam:20260330T110000', 'DTEND;TZID=Europe/Amsterdam:20260330T111500', 'SUMMARY:Stand-up, later')
);
// Organised by someone else, with the user as a guest who hasn't answered yet.
const INVITE = ics(
  vevent(
    'UID:review',
    'DTSTART:20260325T130000Z',
    'DTEND:20260325T140000Z',
    'SUMMARY:Design review',
    'ORGANIZER;CN=Joris Bakker:mailto:joris@example.com',
    'ATTENDEE;CN=Joris Bakker;PARTSTAT=ACCEPTED:mailto:joris@example.com',
    `ATTENDEE;CN=Me;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${ME}`,
    'ATTENDEE;CUTYPE=ROOM;CN=Room 4.12:mailto:room@example.com',
    'LOCATION:https://teams.microsoft.com/l/meetup-join/abc'
  )
);
const OFFSITE = ics(vevent('UID:offsite', 'DTSTART;VALUE=DATE:20260326', 'DTEND;VALUE=DATE:20260328', 'SUMMARY:Team offsite', 'TRANSP:TRANSPARENT'));
// Named zone without its VTIMEZONE: looked up by name. And a floating time: the same clock time on any PC.
const NEW_YORK = ics(vevent('UID:ny', 'DTSTART;TZID=America/New_York:20260324T100000', 'DURATION:PT90M', 'SUMMARY:Call with New York'));
const FLOATING = ics(vevent('UID:floating', 'DTSTART:20260327T080000', 'DTEND:20260327T083000', 'SUMMARY:Run'));

async function withServer(options, fn) {
  const server = await caldavServer(options);
  try {
    await fn(server);
  } finally {
    await server.close();
  }
}

function provider(server, { password = 'secret' } = {}) {
  return new CalDavCalendar({ url: `${server.url}/`, credentials: () => ({ user: ME, password }), addresses: () => [ME] });
}

const WEEK = { start: Date.UTC(2026, 2, 23), end: Date.UTC(2026, 3, 1) };

test('the calendar server address: a host name means https, plain http only for a server on this PC', () => {
  assert.equal(serverUrl('dav.example.net'), 'https://dav.example.net/');
  assert.equal(serverUrl(' https://dav.example.net/caldav/ '), 'https://dav.example.net/caldav/');
  assert.equal(serverUrl('https://me:pw@dav.example.com/x#y'), 'https://dav.example.com/x');
  assert.equal(serverUrl('http://127.0.0.1:5232/'), 'http://127.0.0.1:5232/');
  assert.equal(serverUrl('http://localhost:5232'), 'http://localhost:5232/');
  assert.equal(serverUrl(''), null);
  assert.throws(() => serverUrl('http://dav.example.com/'), { code: 'insecure' });
  assert.throws(() => serverUrl('ftp://dav.example.com/'), { code: 'invalid_url' });
  assert.throws(() => serverUrl('https://'), { code: 'invalid_url' });
});

test('finds the calendars from the server address alone, through /.well-known/caldav and the principal', async () => {
  await withServer({}, async (server) => {
    const found = await discoverCalDav({ url: `${server.url}/`, user: ME, password: 'secret' });
    assert.deepEqual(found, { url: `${server.url}/`, home: server.home });
    assert.deepEqual(
      server.requests.filter((r) => r.method === 'PROPFIND').map((r) => r.path).slice(0, 3),
      ['/.well-known/caldav', '/dav/', '/dav/principals/me/']
    );

    const p = provider(server);
    p.home = found.home;
    const calendars = await p.calendars();
    // Task lists and the scheduling inbox aren't calendars for events; the first one Rukoo may write to is primary.
    assert.deepEqual(
      calendars.map((c) => ({ id: c.id, name: c.name, primary: c.primary, writable: c.writable, scheduling: c.scheduling })),
      [
        { id: server.calendarUrl('home'), name: 'Home', primary: true, writable: true, scheduling: false },
        { id: server.calendarUrl('shared'), name: 'Shared with me', primary: false, writable: false, scheduling: false }
      ]
    );
  });
});

test('a wrong password, an address without CalDAV and a server that is gone each say so', async () => {
  await withServer({}, async (server) => {
    await assert.rejects(discoverCalDav({ url: `${server.url}/`, user: ME, password: 'wrong' }), { code: 'password', message: /username or password/ });
    await withServer({ fail: ({ path }) => (path === '/.well-known/caldav' || path === '/' ? { status: 404 } : null) }, async (empty) => {
      await assert.rejects(discoverCalDav({ url: `${empty.url}/`, user: ME, password: 'secret' }), { code: 'not_caldav' });
    });
  });
  // Nothing listens on this port any more.
  const gone = await caldavServer();
  await gone.close();
  await assert.rejects(discoverCalDav({ url: `${gone.url}/`, user: ME, password: 'secret' }), { code: 'network' });
});

test('reads a series in its own time zone across a clock change, without excluded occurrences and with moved ones', async () => {
  await withServer({ objects: { 'home/standup.ics': STANDUP, 'home/review.ics': INVITE, 'home/offsite.ics': OFFSITE, 'home/ny.ics': NEW_YORK, 'home/floating.ics': FLOATING, 'home/broken.ics': 'BEGIN:VCALENDAR\r\nnonsense' } }, async (server) => {
    const p = provider(server);
    p.home = server.home;
    const [home] = await p.calendars();
    const events = (await p.events(home, WEEK.start, WEEK.end)).sort((a, b) => a.start - b.start);
    const query = server.requests.find((r) => r.method === 'REPORT');
    assert.match(query.body, /<c:time-range start="20260323T000000Z" end="20260401T000000Z"\/>/);
    assert.equal(query.depth, '1');

    const standups = events.filter((e) => e.seriesId);
    // 23 March is winter time (UTC+1), 2 April summer time (UTC+2). 26 March is excluded; 30 March moved to 11:00.
    assert.deepEqual(
      standups.map((e) => [new Date(e.start).toISOString(), e.title]),
      [
        ['2026-03-23T08:30:00.000Z', 'Stand-up'],
        ['2026-03-30T09:00:00.000Z', 'Stand-up, later']
      ]
    );
    const [monday, moved] = standups;
    assert.equal(monday.end - monday.start, 15 * 60000);
    assert.equal(monday.seriesId, `${server.calendarUrl('home')}standup.ics`);
    assert.equal(monday.eventId, `${monday.seriesId}#20260323T083000Z`);
    assert.equal(moved.eventId, `${monday.seriesId}#20260330T073000Z`);
    assert.equal(monday.timeZone, 'Europe/Amsterdam');
    assert.ok(monday.canEdit && monday.canDelete);
    assert.equal(monday.etag, moved.etag);

    const invite = events.find((e) => e.title === 'Design review');
    assert.equal(invite.response, 'needsAction');
    assert.deepEqual(invite.organizer, { name: 'Joris Bakker', address: 'joris@example.com', self: false });
    // The room isn't a guest.
    assert.deepEqual(invite.attendees.map((a) => [a.address, a.response, a.self, a.organizer]), [
      ['joris@example.com', 'accepted', false, true],
      [ME, 'needsAction', true, false]
    ]);
    assert.equal(invite.meeting, 'https://teams.microsoft.com/l/meetup-join/abc');
    // Someone else's meeting can't be changed, and this server doesn't tell organizers about answers.
    assert.equal(invite.canEdit, false);
    assert.equal(invite.canRespond, false);

    const offsite = events.find((e) => e.title === 'Team offsite');
    assert.equal(offsite.allDay, true);
    assert.deepEqual([offsite.startDate, offsite.endDate], ['2026-03-26', '2026-03-28']);
    assert.equal(offsite.start, new Date(2026, 2, 26).getTime());
    assert.equal(offsite.busy, false);

    const ny = events.find((e) => e.title === 'Call with New York');
    assert.equal(new Date(ny.start).toISOString(), '2026-03-24T14:00:00.000Z');
    assert.equal(ny.end - ny.start, 90 * 60000);
    const run = events.find((e) => e.title === 'Run');
    assert.equal(run.start, new Date(2026, 2, 27, 8, 0).getTime());

    // The broken object is left out; the rest of the calendar still shows.
    assert.equal(events.length, 6);
    // The same event fetched on its own.
    const again = await p.get(home, moved.eventId);
    assert.equal(again.start, moved.start);
    await assert.rejects(p.get(home, `${monday.seriesId}#20260326T083000Z`), { code: 'not_found' });
  });
});

test('changing one occurrence of a series writes it as an exception, on the version the user saw', async () => {
  await withServer({ objects: { 'home/standup.ics': STANDUP } }, async (server) => {
    const p = provider(server);
    p.home = server.home;
    const [home] = await p.calendars();
    const [monday] = await p.events(home, WEEK.start, WEEK.start + DAY);
    const input = { title: 'Stand-up, longer', location: 'Room 2', description: '', allDay: false, start: monday.start, end: monday.start + 30 * 60000 };
    const changed = await p.update(home, monday, input, { etag: monday.etag });
    assert.equal(changed.eventId, monday.eventId);
    assert.equal(changed.title, 'Stand-up, longer');
    assert.equal(changed.end - changed.start, 30 * 60000);
    assert.notEqual(changed.etag, monday.etag);
    const put = server.requests.find((r) => r.method === 'PUT');
    assert.equal(put.ifMatch, monday.etag);
    const stored = server.object('home/standup.ics').data;
    // The exception names the occurrence in the series' own zone and keeps writing times in it.
    assert.match(stored, /RECURRENCE-ID;TZID=Europe\/Amsterdam:20260323T093000/);
    assert.match(stored, /DTSTART;TZID=Europe\/Amsterdam:20260323T093000/);
    assert.match(stored, /DTEND;TZID=Europe\/Amsterdam:20260323T100000/);
    assert.match(stored, /SEQUENCE:1/);
    // The rest of the series is untouched.
    const thursday = (await p.events(home, WEEK.start, WEEK.end)).find((e) => e.title === 'Stand-up, later');
    assert.ok(thursday);

    // A change made on the old version is refused.
    await assert.rejects(p.update(home, monday, input, { etag: monday.etag }), { code: 'changed' });
  });
});

test('deleting one occurrence excludes it from the series; deleting the series removes the object', async () => {
  await withServer({ objects: { 'home/standup.ics': STANDUP } }, async (server) => {
    const p = provider(server);
    p.home = server.home;
    const [home] = await p.calendars();
    const [, moved] = (await p.events(home, WEEK.start, WEEK.end)).sort((a, b) => a.start - b.start);
    await p.remove(home, moved, { etag: moved.etag });
    const stored = server.object('home/standup.ics').data;
    assert.match(stored, /EXDATE;TZID=Europe\/Amsterdam:20260330T093000/);
    assert.doesNotMatch(stored, /Stand-up, later/);
    assert.deepEqual((await p.events(home, WEEK.start, WEEK.end)).map((e) => new Date(e.start).toISOString()), ['2026-03-23T08:30:00.000Z']);

    // The series is one object with one version, which every occurrence carries: deleting it on an older version is
    // refused, and on the version the user saw it goes.
    const [monday] = await p.events(home, WEEK.start, WEEK.end);
    await assert.rejects(p.remove(home, monday, { series: true, etag: '"older"' }), { code: 'changed' });
    assert.ok(server.object('home/standup.ics'));
    await p.remove(home, monday, { series: true, etag: monday.etag });
    const del = server.requests.filter((r) => r.method === 'DELETE').pop();
    assert.equal(del.ifMatch, monday.etag);
    assert.equal(server.object('home/standup.ics'), null);
  });
});

test('a series changed elsewhere is not deleted from an older version, and the store shows the latest one', async () => {
  await withServer({ objects: { 'home/standup.ics': STANDUP } }, async (server) => {
    const { calendars } = setup(server, { caldav: { url: `${server.url}/`, home: server.home } });
    calendars.view(WEEK);
    await settle(calendars);
    const monday = calendars.view(WEEK).events.find((e) => e.title === 'Stand-up');
    // Another app renames the series.
    server.put('home/standup.ics', STANDUP.replace('SUMMARY:Stand-up\r\n', 'SUMMARY:Daily sync\r\n'));
    await assert.rejects(calendars.remove(monday.id, { series: true, etag: monday.etag }), { code: 'changed' });
    assert.ok(server.object('home/standup.ics'));
    const latest = calendars.event(monday.id);
    assert.equal(latest.title, 'Daily sync');
    assert.notEqual(latest.etag, monday.etag);
    // On the version now shown, the series goes.
    await calendars.remove(monday.id, { series: true, etag: latest.etag });
    assert.equal(server.object('home/standup.ics'), null);
    assert.equal(calendars.view(WEEK).events.length, 0);
  });
});

test('deleting a series whose opened occurrence was removed elsewhere keeps the series and drops only that occurrence', async () => {
  await withServer({ objects: { 'home/standup.ics': STANDUP } }, async (server) => {
    const { calendars } = setup(server, { caldav: { url: `${server.url}/`, home: server.home } });
    calendars.view(WEEK);
    await settle(calendars);
    const monday = calendars.view(WEEK).events.find((e) => e.title === 'Stand-up');
    // Another app removes just this occurrence.
    server.put('home/standup.ics', STANDUP.replace('EXDATE;TZID=Europe/Amsterdam:20260326T093000', 'EXDATE;TZID=Europe/Amsterdam:20260326T093000\r\nEXDATE;TZID=Europe/Amsterdam:20260323T093000'));
    await assert.rejects(calendars.remove(monday.id, { series: true, etag: monday.etag }), { code: 'changed' });
    assert.ok(server.object('home/standup.ics'));
    assert.equal(calendars.event(monday.id), null);
    // The rest of the series is still in the calendar.
    assert.deepEqual(calendars.view(WEEK).events.map((e) => e.title), ['Stand-up, later']);
  });
});

test('a meeting with only a room or resource booked stays as it is, and the room is not shown as a guest', async () => {
  const booked = ics(vevent('UID:booked', 'DTSTART:20260325T100000Z', 'DTEND:20260325T110000Z', 'SUMMARY:Focus time', `ORGANIZER:mailto:${ME}`, `ATTENDEE;PARTSTAT=ACCEPTED:mailto:${ME}`, 'ATTENDEE;CUTYPE=ROOM;CN=Room 4.12:mailto:room@example.com'));
  const alone = ics(vevent('UID:alone', 'DTSTART:20260325T120000Z', 'DTEND:20260325T130000Z', 'SUMMARY:Lunch', `ORGANIZER:mailto:${ME}`, `ATTENDEE;PARTSTAT=ACCEPTED:mailto:${ME}`));
  await withServer({ objects: { 'home/booked.ics': booked, 'home/alone.ics': alone } }, async (server) => {
    const p = provider(server);
    p.home = server.home;
    const [home] = await p.calendars();
    const events = await p.events(home, WEEK.start, WEEK.end);
    const room = events.find((e) => e.title === 'Focus time');
    assert.deepEqual(room.attendees.map((a) => a.address), [ME]);
    assert.equal(room.canEdit, false);
    assert.equal(room.canDelete, false);
    // With only the user as attendee, the event can still be changed.
    assert.equal(events.find((e) => e.title === 'Lunch').canEdit, true);
  });
});

test('a request the old calendar server still had running gets no password once another server is entered', async () => {
  await withServer({ objects: { 'home/standup.ics': STANDUP } }, async (server) => {
    const { engine, calendars } = setup(server, { caldav: { url: `${server.url}/`, home: server.home } });
    const old = calendars.provider(engine.account('c1'));
    // The user enters another server with a new password; the old provider may still be on its way.
    const acc = engine.account('c1');
    acc.caldav = { url: 'https://new.example/', home: 'https://new.example/home/' };
    acc.secret = 'new-password';
    const before = server.requests.length;
    await assert.rejects(old.request('PROPFIND', server.home, { depth: 0, body: '<x/>' }), { code: 'reconfigured' });
    assert.equal(server.requests.length, before);
  });
});

test('a new event is written once: a Save tried again after a lost answer gives the first one the latest fields', async () => {
  await withServer({ etagOnPut: false }, async (server) => {
    const p = provider(server);
    p.home = server.home;
    const [home] = await p.calendars();
    const input = { id: 'a1b2c3d4e5f6g7h8i9j0k1l2m3', title: 'Dentist', location: 'Main street 1', description: 'Bring the card', allDay: false, start: Date.UTC(2026, 2, 25, 7, 30), end: Date.UTC(2026, 2, 25, 8, 15) };
    const made = await p.create(home, input);
    assert.equal(made.eventId, `${server.calendarUrl('home')}a1b2c3d4e5f6g7h8i9j0k1l2m3.ics`);
    assert.equal(made.title, 'Dentist');
    assert.equal(made.start, input.start);
    assert.ok(made.canEdit);
    // The server didn't send the new version with the PUT, so Rukoo fetched it.
    assert.equal(made.etag, server.object('home/a1b2c3d4e5f6g7h8i9j0k1l2m3.ics').etag);
    const first = server.requests.find((r) => r.method === 'PUT');
    assert.equal(first.ifNoneMatch, '*');
    assert.match(first.body, /UID:a1b2c3d4e5f6g7h8i9j0k1l2m3/);
    assert.match(first.body, /DTSTART:20260325T073000Z/);
    assert.match(first.body, /DESCRIPTION:Bring the card/);

    const again = await p.create(home, { ...input, title: 'Dentist, 2nd floor' });
    assert.equal(again.eventId, made.eventId);
    assert.equal(again.title, 'Dentist, 2nd floor');
    assert.deepEqual(server.names(), ['home/a1b2c3d4e5f6g7h8i9j0k1l2m3.ics']);

    // To all day, then gone.
    const allDay = await p.update(home, again, { ...input, allDay: true, startDate: '2026-03-26', endDate: '2026-03-27' }, { etag: again.etag });
    assert.deepEqual([allDay.allDay, allDay.startDate, allDay.endDate], [true, '2026-03-26', '2026-03-27']);
    assert.match(server.object('home/a1b2c3d4e5f6g7h8i9j0k1l2m3.ics').data, /DTSTART;VALUE=DATE:20260326/);
    await p.remove(home, allDay, { etag: allDay.etag });
    assert.deepEqual(server.names(), []);

    // A read-only calendar refuses.
    const shared = { id: server.calendarUrl('shared'), writable: true };
    await assert.rejects(p.create(shared, { ...input, id: 'zzzzzzzzzz' }), { code: 'read_only' });
  });
});

test('an invitation can be answered where the server tells the organizer, for one occurrence or the series', async () => {
  const series = ics(
    vevent(
      'UID:weekly',
      'DTSTART:20260323T120000Z',
      'DTEND:20260323T130000Z',
      'RRULE:FREQ=WEEKLY;COUNT=4',
      'SUMMARY:Weekly sync',
      'ORGANIZER:mailto:joris@example.com',
      'ATTENDEE;PARTSTAT=ACCEPTED:mailto:joris@example.com',
      `ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:${ME}`,
      'ATTENDEE;PARTSTAT=TENTATIVE:mailto:sanne@example.com'
    )
  );
  await withServer({ scheduling: true, objects: { 'home/review.ics': INVITE, 'home/weekly.ics': series } }, async (server) => {
    const p = provider(server);
    p.home = server.home;
    const [home] = await p.calendars();
    assert.equal(home.scheduling, true);
    const events = await p.events(home, WEEK.start, WEEK.end + 7 * DAY);
    const invite = events.find((e) => e.title === 'Design review');
    assert.equal(invite.canRespond, true);
    await p.respond(home, invite, 'accepted');
    const stored = server.object('home/review.ics').data;
    assert.match(stored, new RegExp(`ATTENDEE;CN=Me;PARTSTAT=ACCEPTED;RSVP=TRUE:mailto:${ME}`));
    // Only the user's own answer changes.
    assert.match(stored, /ATTENDEE;CN=Joris Bakker;PARTSTAT=ACCEPTED:mailto:joris@example.com/);

    const [first, second] = events.filter((e) => e.title === 'Weekly sync').sort((a, b) => a.start - b.start);
    await p.respond(home, second, 'declined');
    let data = server.object('home/weekly.ics').data;
    assert.match(data, /RECURRENCE-ID:20260330T120000Z/);
    const after = await p.events(home, WEEK.start, WEEK.end + 7 * DAY);
    // 23 and 30 March and 6 April; only the second has an answer.
    assert.deepEqual(
      after.filter((e) => e.title === 'Weekly sync').sort((a, b) => a.start - b.start).map((e) => e.response),
      ['needsAction', 'declined', 'needsAction']
    );
    await p.respond(home, first, 'tentative', { series: true });
    data = server.object('home/weekly.ics').data;
    assert.doesNotMatch(data, new RegExp(`NEEDS-ACTION:mailto:${ME}`));
    assert.match(data, /PARTSTAT=TENTATIVE:mailto:sanne@example.com/);
  });
});

test('the password only goes to the server entered: a redirect or an address on another host is refused first', async () => {
  // A fake network that records where the password went, and redirects or points wherever a test says.
  const net = (answer) => {
    const sent = [];
    const fetchImpl = async (url, opts) => {
      sent.push({ host: new URL(url).host, auth: Boolean(opts.headers.authorization) });
      const a = answer(new URL(url), opts.method);
      return new Response(a.body || '', { status: a.status, headers: a.headers || {} });
    };
    return { sent, fetchImpl };
  };
  const make = (url, fetchImpl) => new CalDavCalendar({ url, credentials: () => ({ user: ME, password: 'secret' }), fetchImpl });
  const home = (href) => ({
    status: 207,
    body: `<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/</d:href><d:propstat><d:prop><c:calendar-home-set><d:href>${href}</d:href></c:calendar-home-set></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`
  });

  // A redirect to another site is refused before the request goes there.
  const away = net((u) => (u.host === 'dav.example.com' ? { status: 302, headers: { location: 'https://collector.example.net/caldav/' } } : { status: 500 }));
  await assert.rejects(make('https://dav.example.com/caldav/', away.fetchImpl).discover(), { code: 'elsewhere', message: /collector\.example\.net/ });
  assert.ok(away.sent.every((s) => s.host === 'dav.example.com'));

  // A calendar home on another site isn't used either, and the user hears where it is.
  const pointed = net(() => home('https://other.example.org/home/'));
  await assert.rejects(discoverCalDav({ url: 'https://dav.example.com/', user: ME, password: 'secret', fetchImpl: pointed.fetchImpl }), { code: 'elsewhere', message: /other\.example\.org/ });
  assert.ok(pointed.sent.every((s) => s.host === 'dav.example.com'));

  // Not even to a host with a similar name: alice.me.uk and mallory.me.uk, or two workers.dev sites, belong to
  // different people. The user can enter the other host if they trust it.
  for (const [mine, theirs] of [['https://alice.me.uk/', 'https://mallory.me.uk/home/'], ['https://cal.alice.workers.dev/', 'https://cal.mallory.workers.dev/home/'], ['https://caldav.provider.example/', 'https://p52-caldav.provider.example/home/']]) {
    const lookalike = net(() => home(theirs));
    await assert.rejects(make(mine, lookalike.fetchImpl).discover(), { code: 'elsewhere', message: new RegExp(new URL(theirs).host.replace(/\./g, '\\.')) });
    assert.ok(lookalike.sent.every((s) => s.host === new URL(mine).host));
  }

  // A home on the same host, by a relative or an absolute address, is used.
  const same = net(() => home('/calendars/alex/'));
  assert.equal(await make('https://dav.example.com/', same.fetchImpl).discover(), 'https://dav.example.com/calendars/alex/');
});

test('in a zone named without its definition, an EXDATE or RDATE in UTC still lines up with the occurrences', async () => {
  // 09:30 in Amsterdam is 08:30 UTC in March before the clocks change. 24 March is excluded in UTC and an extra
  // occurrence is added at 09:00 UTC that day.
  const series = ics(vevent('UID:nozone', 'DTSTART;TZID=Europe/Amsterdam:20260323T093000', 'DTEND;TZID=Europe/Amsterdam:20260323T094500', 'RRULE:FREQ=DAILY;COUNT=4', 'EXDATE:20260324T083000Z', 'RDATE:20260324T090000Z', 'SUMMARY:Check-in'));
  await withServer({ objects: { 'home/nozone.ics': series } }, async (server) => {
    const p = provider(server);
    p.home = server.home;
    const [home] = await p.calendars();
    const events = (await p.events(home, WEEK.start, WEEK.end)).sort((a, b) => a.start - b.start);
    assert.deepEqual(events.map((e) => new Date(e.start).toISOString()), ['2026-03-23T08:30:00.000Z', '2026-03-24T09:00:00.000Z', '2026-03-25T08:30:00.000Z', '2026-03-26T08:30:00.000Z']);
    // Each one can be opened on its own, also the ones after the extra date.
    for (const e of events) assert.equal((await p.get(home, e.eventId)).start, e.start);
    await p.remove(home, events[2], { etag: events[2].etag });
    assert.deepEqual((await p.events(home, WEEK.start, WEEK.end)).map((e) => e.eventId).sort(), [events[0], events[1], events[3]].map((e) => e.eventId).sort());
  });

  // The same with the excluded and extra dates in a third zone, also named without its definition: 04:30 in New York
  // is 08:30 UTC, 05:00 is 09:00 UTC. And a series in a zone the object defines, with them in a named zone.
  for (const [start, end] of [
    ['DTSTART;TZID=Europe/Amsterdam:20260323T093000', 'DTEND;TZID=Europe/Amsterdam:20260323T094500'],
    ['DTSTART;TZID=Europe/Amsterdam:20260323T093000', 'DTEND;TZID=Europe/Amsterdam:20260323T094500', VTIMEZONE]
  ].map(([s, e, zone]) => [s, zone ? [zone, e] : [e]])) {
    const other = ics(...(end.length > 1 ? [end[0]] : []), vevent('UID:other', start, end[end.length - 1], 'RRULE:FREQ=DAILY;COUNT=3', 'EXDATE;TZID=America/New_York:20260324T043000', 'RDATE;TZID=America/New_York:20260324T050000', 'SUMMARY:Check-in'));
    await withServer({ objects: { 'home/other.ics': other } }, async (server) => {
      const p = provider(server);
      p.home = server.home;
      const [home] = await p.calendars();
      const events = (await p.events(home, WEEK.start, WEEK.end)).sort((a, b) => a.start - b.start);
      assert.deepEqual(events.map((e) => new Date(e.start).toISOString()), ['2026-03-23T08:30:00.000Z', '2026-03-24T09:00:00.000Z', '2026-03-25T08:30:00.000Z']);
    });
  }
});

test('a series with more occurrences than Rukoo steps through fails the fetch instead of going missing', async () => {
  // Every hour since 2023: about 28,000 occurrences before the week asked for, which Rukoo still reaches.
  const hourly = ics(vevent('UID:hourly', 'DTSTART:20230101T000000Z', 'DTEND:20230101T001500Z', 'RRULE:FREQ=HOURLY', 'SUMMARY:Hourly'));
  // Every second since the day before: far more than that.
  const secondly = ics(vevent('UID:secondly', 'DTSTART:20260321T000000Z', 'DTEND:20260321T000001Z', 'RRULE:FREQ=SECONDLY', 'SUMMARY:Too often'));
  await withServer({ objects: { 'home/hourly.ics': hourly } }, async (server) => {
    const p = provider(server);
    p.home = server.home;
    const [home] = await p.calendars();
    assert.equal((await p.events(home, Date.UTC(2026, 2, 24), Date.UTC(2026, 2, 25))).length, 24);
    server.put('home/secondly.ics', secondly);
    await assert.rejects(p.events(home, Date.UTC(2026, 2, 24), Date.UTC(2026, 2, 25)), { code: 'too_many' });
  });
});

test('a series with a change to this and every later occurrence shows it, and Rukoo leaves that series as it is', async () => {
  const series = ics(
    vevent('UID:split', 'DTSTART:20260316T093000Z', 'DTEND:20260316T094500Z', 'RRULE:FREQ=WEEKLY', 'SUMMARY:Weekly'),
    vevent('UID:split', 'RECURRENCE-ID;RANGE=THISANDFUTURE:20260330T093000Z', 'DTSTART:20260330T110000Z', 'DTEND:20260330T111500Z', 'SUMMARY:Weekly, later')
  );
  await withServer({ objects: { 'home/split.ics': series } }, async (server) => {
    const p = provider(server);
    p.home = server.home;
    const [home] = await p.calendars();
    const events = (await p.events(home, Date.UTC(2026, 2, 23), Date.UTC(2026, 3, 14))).sort((a, b) => a.start - b.start);
    assert.deepEqual(
      events.map((e) => [new Date(e.start).toISOString(), e.title]),
      [
        ['2026-03-23T09:30:00.000Z', 'Weekly'],
        ['2026-03-30T11:00:00.000Z', 'Weekly, later'],
        ['2026-04-06T11:00:00.000Z', 'Weekly, later'],
        ['2026-04-13T11:00:00.000Z', 'Weekly, later']
      ]
    );
    assert.ok(events.every((e) => !e.canEdit && !e.canDelete && !e.canRespond));
    assert.equal((await p.get(home, events[2].eventId)).start, events[2].start);
  });

  const variants = {
    // The series in a zone it only names, the change in UTC: 09:30 Amsterdam becomes 09:00 UTC from 30 March on.
    zones: ics(
      vevent('UID:split', 'DTSTART;TZID=Europe/Amsterdam:20260316T093000', 'DTEND;TZID=Europe/Amsterdam:20260316T094500', 'RRULE:FREQ=WEEKLY', 'SUMMARY:Weekly'),
      vevent('UID:split', 'RECURRENCE-ID;RANGE=THISANDFUTURE:20260330T073000Z', 'DTSTART:20260330T090000Z', 'DTEND:20260330T091500Z', 'SUMMARY:Weekly, later')
    ),
    // A daily series moved a week earlier from 13 April on.
    earlier: ics(
      vevent('UID:split', 'DTSTART:20260401T090000Z', 'DTEND:20260401T093000Z', 'RRULE:FREQ=DAILY', 'SUMMARY:Daily'),
      vevent('UID:split', 'RECURRENCE-ID;RANGE=THISANDFUTURE:20260413T090000Z', 'DTSTART:20260406T090000Z', 'DTEND:20260406T093000Z', 'SUMMARY:Daily, earlier')
    ),
    // Cancelled from 30 March on.
    cancelled: ics(
      vevent('UID:split', 'DTSTART:20260316T093000Z', 'DTEND:20260316T094500Z', 'RRULE:FREQ=WEEKLY', 'SUMMARY:Weekly'),
      vevent('UID:split', 'RECURRENCE-ID;RANGE=THISANDFUTURE:20260330T093000Z', 'DTSTART:20260330T093000Z', 'DTEND:20260330T094500Z', 'STATUS:CANCELLED', 'SUMMARY:Weekly')
    )
  };
  const seen = async (data, from, to) =>
    withServer({ objects: { 'home/split.ics': data } }, async (server) => {
      const p = provider(server);
      p.home = server.home;
      const [home] = await p.calendars();
      seen.events = (await p.events(home, from, to)).sort((a, b) => a.start - b.start);
      seen.get = (id) => p.get(home, id);
    });
  await seen(variants.zones, Date.UTC(2026, 2, 23), Date.UTC(2026, 3, 14));
  assert.deepEqual(seen.events.map((e) => new Date(e.start).toISOString()), ['2026-03-23T08:30:00.000Z', '2026-03-30T09:00:00.000Z', '2026-04-06T09:00:00.000Z', '2026-04-13T09:00:00.000Z']);
  // The occurrences from 13 April on now fall on 6 to 12 April, beside the ones the rule had there already: all of
  // them show, though the moved ones come from after the period.
  await seen(variants.earlier, Date.UTC(2026, 3, 6), Date.UTC(2026, 3, 13));
  const days = (title) => seen.events.filter((e) => e.title === title).map((e) => new Date(e.start).toISOString().slice(0, 10));
  const week = ['2026-04-06', '2026-04-07', '2026-04-08', '2026-04-09', '2026-04-10', '2026-04-11', '2026-04-12'];
  assert.deepEqual(days('Daily'), week);
  assert.deepEqual(days('Daily, earlier'), week);
  await seen(variants.cancelled, Date.UTC(2026, 2, 16), Date.UTC(2026, 3, 14));
  assert.deepEqual(seen.events.map((e) => new Date(e.start).toISOString().slice(0, 10)), ['2026-03-16', '2026-03-23']);

  // Moved a week later from 23 March, across the change to summer time on 29 March: 09:30 in Amsterdam stays 09:30,
  // which is 07:30 UTC from then on. Once with the zone's definition in the object, once with the zone only named.
  for (const zone of [[VTIMEZONE], []]) {
    const week = ics(
      ...zone,
      vevent('UID:split', 'DTSTART;TZID=Europe/Amsterdam:20260316T093000', 'DTEND;TZID=Europe/Amsterdam:20260316T094500', 'RRULE:FREQ=WEEKLY', 'SUMMARY:Weekly'),
      vevent('UID:split', 'RECURRENCE-ID;RANGE=THISANDFUTURE;TZID=Europe/Amsterdam:20260323T093000', 'DTSTART;TZID=Europe/Amsterdam:20260330T093000', 'DTEND;TZID=Europe/Amsterdam:20260330T094500', 'SUMMARY:Weekly, a week later')
    );
    await seen(week, Date.UTC(2026, 2, 16), Date.UTC(2026, 3, 14));
    assert.deepEqual(
      seen.events.map((e) => new Date(e.start).toISOString()),
      ['2026-03-16T08:30:00.000Z', '2026-03-30T07:30:00.000Z', '2026-04-06T07:30:00.000Z', '2026-04-13T07:30:00.000Z'],
      zone.length ? 'with VTIMEZONE' : 'named only'
    );
    assert.ok(seen.events.slice(1).every((e) => e.end - e.start === 15 * 60000));
  }

  // A week earlier from 11 October in Antarctica/Troll, whose clocks go back two hours on 25 October: that day's
  // 09:30 (09:30 UTC) lands on 18 October at 09:30, 07:30 UTC, and an hour around it finds it.
  const troll = ics(
    vevent('UID:troll', 'DTSTART;TZID=Antarctica/Troll:20261004T093000', 'DTEND;TZID=Antarctica/Troll:20261004T094500', 'RRULE:FREQ=WEEKLY', 'SUMMARY:Weekly'),
    vevent('UID:troll', 'RECURRENCE-ID;RANGE=THISANDFUTURE;TZID=Antarctica/Troll:20261011T093000', 'DTSTART;TZID=Antarctica/Troll:20261004T093000', 'DTEND;TZID=Antarctica/Troll:20261004T094500', 'SUMMARY:Weekly, a week earlier')
  );
  await seen(troll, Date.UTC(2026, 9, 18, 7), Date.UTC(2026, 9, 18, 8));
  assert.deepEqual(seen.events.map((e) => [new Date(e.start).toISOString(), e.title]), [['2026-10-18T07:30:00.000Z', 'Weekly, a week earlier']]);
});

test('an occurrence cancelled from some date on can no longer be opened', async () => {
  const series = ics(
    vevent('UID:split', 'DTSTART:20260316T093000Z', 'DTEND:20260316T094500Z', 'RRULE:FREQ=WEEKLY', 'SUMMARY:Weekly'),
    vevent('UID:split', 'RECURRENCE-ID;RANGE=THISANDFUTURE:20260330T093000Z', 'DTSTART:20260330T093000Z', 'DTEND:20260330T094500Z', 'STATUS:CANCELLED', 'SUMMARY:Weekly')
  );
  await withServer({ objects: { 'home/split.ics': series } }, async (server) => {
    const p = provider(server);
    p.home = server.home;
    const [home] = await p.calendars();
    const href = `${server.calendarUrl('home')}split.ics`;
    assert.equal((await p.get(home, `${href}#20260323T093000Z`)).title, 'Weekly');
    await assert.rejects(p.get(home, `${href}#20260406T093000Z`), { code: 'not_found' });
  });
});

test('answering one occurrence of a series written with DURATION makes an exception with only a DTEND', async () => {
  const series = ics(
    vevent('UID:dur', 'DTSTART:20260323T120000Z', 'DURATION:PT1H', 'RRULE:FREQ=WEEKLY;COUNT=3', 'SUMMARY:Sync', 'ORGANIZER:mailto:joris@example.com', `ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:${ME}`)
  );
  await withServer({ scheduling: true, objects: { 'home/dur.ics': series } }, async (server) => {
    const p = provider(server);
    p.home = server.home;
    const [home] = await p.calendars();
    const [first] = await p.events(home, WEEK.start, WEEK.end);
    await p.respond(home, first, 'accepted');
    const [, , exception] = server.object('home/dur.ics').data.split('BEGIN:VEVENT');
    assert.match(exception, /RECURRENCE-ID:20260323T120000Z/);
    assert.match(exception, /DTEND:20260323T130000Z/);
    assert.doesNotMatch(exception, /DURATION/);
  });
});

// ---------- the account and the calendar store ----------

function setup(server, extra = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sem-caldav-'));
  const account = { id: 'c1', type: 'imap', provider: 'other', email: ME, color: '#4a7dff', secret: 'secret', imap: { host: '127.0.0.1', port: 1, secure: false, user: ME }, smtp: { host: '127.0.0.1', port: 1, secure: false, user: ME }, ...extra };
  fs.writeFileSync(path.join(dataDir, 'accounts.json'), JSON.stringify([account]));
  const engine = new Engine({ dataDir }).init();
  const calendars = new Calendars({ engine });
  return { engine, calendars, dataDir };
}

async function settle(calendars) {
  for (let i = 0; i < 5; i++) await Promise.all([...calendars.queues.values()]);
}

test('Server settings check the calendar server before saving it, and the account then shows its calendars', async () => {
  await withServer({ objects: { 'home/standup.ics': STANDUP } }, async (server) => {
    const { engine, calendars } = setup(server);
    // Without a calendar server the account has no calendar.
    assert.deepEqual(calendars.view(WEEK).accounts, []);

    // A wrong address is refused and nothing is saved. The mail servers aren't asked: only the calendar changed.
    await assert.rejects(engine.updateAccount('c1', { caldav: { url: 'http://dav.example.com/' } }), { code: 'insecure' });
    assert.equal(engine.account('c1').caldav, undefined);

    let changed = 0;
    engine.on('calendar-changed', () => changed++);
    const saved = await engine.updateAccount('c1', { caldav: { url: `${server.url}/` } });
    assert.deepEqual(saved.caldav, { url: `${server.url}/` });
    assert.deepEqual(engine.account('c1').caldav, { url: `${server.url}/`, home: server.home });
    assert.equal(changed, 1);
    // The same address again isn't checked again.
    const before = server.requests.length;
    await engine.updateAccount('c1', { caldav: { url: `${server.url}/` } });
    assert.equal(server.requests.length, before);
    assert.equal(changed, 1);

    calendars.view(WEEK);
    await settle(calendars);
    const view = calendars.view(WEEK);
    assert.deepEqual(view.accounts.map((a) => [a.id, a.kind, a.state, a.calendars.map((c) => c.name).join(',')]), [['c1', 'caldav', 'ready', 'Home,Shared with me']]);
    assert.deepEqual(view.events.map((e) => e.title).sort(), ['Stand-up', 'Stand-up, later']);

    // A new event through the store, then a change to one occurrence.
    const made = await calendars.create({ accountId: 'c1', calendarId: server.calendarUrl('home'), id: 'q1w2e3r4t5', title: 'Lunch', location: '', description: '', allDay: false, start: Date.UTC(2026, 2, 24, 11), end: Date.UTC(2026, 2, 24, 12) });
    assert.equal(made.title, 'Lunch');
    const occurrence = view.events.find((e) => e.title === 'Stand-up');
    const moved = await calendars.update(occurrence.id, { title: 'Stand-up', location: '', description: '', allDay: false, start: occurrence.start + 3600000, end: occurrence.end + 3600000 }, { etag: occurrence.etag });
    assert.equal(moved.start, occurrence.start + 3600000);

    // Emptying the field takes the calendar away again, with what was cached.
    await engine.updateAccount('c1', { caldav: { url: '' } });
    assert.equal(engine.account('c1').caldav, null);
    assert.equal(changed, 2);
    assert.deepEqual(calendars.view(WEEK).accounts, []);
  });
});

test('a password the calendar server turns down shows as an error to fix in Server settings, not a Google sign-in', async () => {
  await withServer({ password: 'changed' }, async (server) => {
    const { calendars } = setup(server, { caldav: { url: `${server.url}/`, home: server.home } });
    calendars.view(WEEK);
    await settle(calendars).catch(() => {});
    const [acc] = calendars.view(WEEK).accounts;
    assert.equal(acc.kind, 'caldav');
    assert.equal(acc.state, 'error');
    assert.equal(acc.error.code, 'password');
  });
});

test('a calendar home that moved is found again and remembered, but not once another server was entered', async () => {
  await withServer({ objects: { 'home/standup.ics': STANDUP } }, async (server) => {
    const { engine, calendars } = setup(server, { caldav: { url: `${server.url}/`, home: `${server.url}/old-home/` } });
    calendars.view(WEEK);
    await settle(calendars);
    assert.equal(engine.account('c1').caldav.home, server.home);
    assert.equal(calendars.view(WEEK).accounts[0].state, 'ready');

    // A search that started on the old server finishes after the user entered a new one: its home is ignored, also
    // when it reaches the account through the provider made for the old server.
    const old = calendars.provider(engine.account('c1'));
    engine.account('c1').caldav = { url: 'https://new.example/', home: 'https://new.example/home/' };
    old.onHome(`${server.url}/somewhere/`);
    engine.setCalDavHome('c1', `${server.url}/somewhere/`, `${server.url}/`);
    assert.deepEqual(engine.account('c1').caldav, { url: 'https://new.example/', home: 'https://new.example/home/' });
  });
});
