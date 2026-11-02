'use strict';

// Bookings with a video service as their location (src/main/booking with src/main/video), against the in-memory
// account server and the Google calendar fake: each booking gets its own meeting with its link in the invitation and
// nowhere on the page, a move or cancellation moves or deletes the meeting, a failed or expired connection keeps the
// booking and says what to do, and another computer says which services still need connecting there. A CalDAV
// calendar gets the same event, written to the CalDAV fixture.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { EventEmitter } = require('events');
const { startAccountServer } = require('./fixtures/account-server');
const { fakeCalendar, setup } = require('./fixtures/google-calendar');
const { caldavServer } = require('./fixtures/caldav-server');
const { AccountService } = require('../src/main/account');
const { Booking } = require('../src/main/booking');
const { calendarKey } = require('../src/main/calendar');
const { CalDavCalendar } = require('../src/main/calendar/caldav');
const { VideoServices, withMeeting } = require('../src/main/video');
const { tempDir } = require('./tmp');

const secrets = { encrypt: (s) => `plain:${Buffer.from(s).toString('base64')}`, decrypt: (s) => Buffer.from(String(s).slice(6), 'base64').toString() };
const PASSWORD = 'a long enough password';
const HOUR = 3600000;
const DAY = 24 * HOUR;
const ENABLE = { handle: 'bart', name: 'Bart', timeZone: 'Europe/Amsterdam', destination: calendarKey('g1', 'me@example.com') };
const ZOOM = { kind: 'video', service: 'zoom', label: '', value: '', public: false };

function slot(days, hour) {
  const d = new Date(Date.now() + days * DAY);
  while ([0, 6].includes(d.getUTCDay())) d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCHours(hour - 1, 0, 0, 0);
  return d.getTime();
}

async function server(t) {
  const s = await startAccountServer();
  t.after(() => s.close());
  return s;
}

// The video services of a computer, as the booking service sees them: statuses by service, and every call kept.
// fail[op]: an error the next calls of that kind throw.
function fakeVideo(statuses = {}) {
  const v = new EventEmitter();
  v.statuses = { jitsi: 'off', zoom: 'connected', teams: 'off', ...statuses };
  v.calls = [];
  v.fail = {};
  v.n = 0;
  const problem = (code, message) => Object.assign(new Error(message), { video: true, code });
  v.status = (id) => v.statuses[id] || 'off';
  v.manages = (id) => id !== 'jitsi';
  v.create = async (id, m) => {
    v.calls.push({ op: 'create', service: id, ...m });
    if (v.fail.create) throw v.fail.create;
    if (v.status(id) === 'renew') throw problem('renew', `The ${id} connection needs renewing in Settings → Video meetings.`);
    if (v.status(id) !== 'connected') throw problem('off', `${id} isn't connected on this computer.`);
    v.n += 1;
    return { service: id, id: `m${v.n}`, url: `https://us05web.zoom.us/j/${8100 + v.n}?pwd=p${v.n}` };
  };
  v.update = async (ref, m) => {
    v.calls.push({ op: 'update', ref, ...m });
    if (v.fail.update) throw v.fail.update;
  };
  v.remove = async (ref) => {
    v.calls.push({ op: 'remove', ref });
    if (v.fail.remove) throw v.fail.remove;
  };
  v.set = (id, status) => {
    v.statuses[id] = status;
    v.emit('changed');
  };
  return v;
}

async function computer(t, srv, { fake = fakeCalendar(), signUp = true, name = 'desk', video = fakeVideo() } = {}) {
  const { engine, calendars, dataDir } = setup(fake);
  const account = new AccountService({ dataDir, secrets, defaultServer: srv.url, deviceName: name, platform: 'linux' }).init();
  if (signUp) await account.signUp({ email: 'host@example.com', password: PASSWORD });
  else await account.signIn({ email: 'host@example.com', password: PASSWORD });
  const booking = new Booking({ account, calendars, engine, dataDir, video, notify: () => {}, timing: { auto: false, publishAfter: HOUR, reconcileAfter: HOUR } }).init();
  t.after(() => {
    booking.close();
    account.close();
    calendars.flush();
  });
  return { engine, calendars, account, booking, fake, video, dataDir };
}

// The page on with one type whose location is the given one.
async function pageWith(host, location) {
  await host.booking.enable(ENABLE);
  const type = host.booking.settings().types[0];
  await host.booking.save({ types: [{ ...type, location }] });
}

const bookingEvent = (fake, id) => fake.store.find((e) => e.extendedProperties && e.extendedProperties.private && e.extendedProperties.private.rukooBooking === id);
const mapOf = (host, id) => host.account.get('booking', `map:${host.account.acct}:${id}`);
const keptOf = (host, id) => host.account.get('booking', `meeting:${host.account.acct}:${id}`);
const ops = (video, op) => video.calls.filter((c) => c.op === op);

test('a booking whose type uses a video service gets its own meeting, with the link in the invitation and not on the page', async (t) => {
  const srv = await server(t);
  const host = await computer(t, srv);
  await pageWith(host, ZOOM);
  // The page shows the service's name; the server knows it as a link and has no address for it.
  assert.deepEqual(srv.pages.get('bart').profile.types[0].location, { kind: 'link', label: 'Zoom' });
  assert.deepEqual(host.booking.settings().types[0].location, ZOOM);

  const start = slot(3, 10);
  const a = await srv.book({ handle: 'bart', type: '30min', start, guest: { name: 'Jane Doe' } });
  const b = await srv.book({ handle: 'bart', type: '30min', start: start + DAY, guest: { name: 'Max Power', email: 'max@example.org' } });
  await host.booking.sync();

  const made = ops(host.video, 'create');
  assert.equal(made.length, 2, 'one meeting per booking');
  assert.deepEqual(made[0], { op: 'create', service: 'zoom', title: '30 minute meeting: Bart and Jane Doe', start, end: start + 30 * 60000, timeZone: 'Europe/Amsterdam' });
  const ev = bookingEvent(host.fake, a.id);
  const map = mapOf(host, a.id);
  // The meeting with the time it has.
  assert.deepEqual(map.video, { service: 'zoom', id: 'm1', url: 'https://us05web.zoom.us/j/8101?pwd=p1', start, end: start + 30 * 60000 });
  assert.equal(ev.location, map.video.url);
  assert.ok(ev.description.startsWith(`Join with Zoom: ${map.video.url}\n\n`), ev.description);
  // The guest's own links follow the meeting's.
  assert.match(ev.description, /\n\nPick another time: \S+\nCancel booking: \S+$/);
  assert.ok(!ev.description.includes('Booked via'));
  assert.equal(ev.conferenceData, undefined, 'no Google Meet besides');
  assert.equal(bookingEvent(host.fake, b.id).location, mapOf(host, b.id).video.url);
  assert.notEqual(mapOf(host, b.id).video.url, map.video.url);
  // The server never gets the link.
  assert.ok(!JSON.stringify([...srv.pages.get('bart').bookings.values()]).includes('zoom.us'));
  assert.ok(!JSON.stringify(srv.pages.get('bart').profile).includes('zoom.us'));
  assert.equal(srv.pages.get('bart').bookings.get(a.id).handledVersion, 1);
  assert.deepEqual(host.booking.state().notices, []);
  // Nothing is made twice.
  await host.booking.sync();
  assert.equal(ops(host.video, 'create').length, 2);
});

test('moving or cancelling a booking, by the guest or the host, moves or deletes its meeting', async (t) => {
  const srv = await server(t);
  const host = await computer(t, srv);
  await pageWith(host, ZOOM);
  const start = slot(3, 10);
  const a = await srv.book({ handle: 'bart', type: '30min', start, guest: { name: 'Jane Doe' } });
  const b = await srv.book({ handle: 'bart', type: '30min', start: start + DAY, guest: { name: 'Max Power', email: 'max@example.org' } });
  const c = await srv.book({ handle: 'bart', type: '30min', start: start + 2 * DAY, guest: { name: 'Ann Lee', email: 'ann@example.org' } });
  const d = await srv.book({ handle: 'bart', type: '30min', start: start + 3 * DAY, guest: { name: 'Bo Ek', email: 'bo@example.org' } });
  await host.booking.sync();
  const ref = (id) => {
    const { service, id: meeting, url } = mapOf(host, id).video;
    return { service, id: meeting, url };
  };
  const refA = ref(a.id);
  const refB = ref(b.id);
  const refC = ref(c.id);
  const refD = ref(d.id);

  // The guest picks another time: the event and the meeting move, and the link stays.
  srv.guestReschedule({ handle: 'bart', id: a.id, start: start + 2 * HOUR });
  await host.booking.sync();
  assert.deepEqual(ops(host.video, 'update').pop(), { op: 'update', ref: refA, start: start + 2 * HOUR, end: start + 2 * HOUR + 30 * 60000, timeZone: 'Europe/Amsterdam' });
  assert.equal(bookingEvent(host.fake, a.id).location, refA.url);
  assert.deepEqual(ref(a.id), refA);

  // The host moves the event in the calendar: the booking and the meeting follow.
  const evB = host.calendars.event(host.booking.state().bookings.find((x) => x.id === b.id).eventId);
  await host.calendars.update(evB.id, { accountId: evB.accountId, calendarId: evB.calendarId, title: evB.title, location: evB.location, description: evB.description, allDay: false, start: start + DAY + HOUR, end: start + DAY + HOUR + 30 * 60000 }, { etag: evB.etag, scope: 'one' });
  await host.booking.reconcile();
  assert.equal(srv.pages.get('bart').bookings.get(b.id).start, start + DAY + HOUR);
  assert.deepEqual(ops(host.video, 'update').pop(), { op: 'update', ref: refB, start: start + DAY + HOUR, end: start + DAY + HOUR + 30 * 60000, timeZone: 'Europe/Amsterdam' });

  // The guest cancels: the meeting goes with the event.
  srv.guestCancel({ handle: 'bart', id: a.id });
  await host.booking.sync();
  assert.deepEqual(ops(host.video, 'remove').map((x) => x.ref), [refA]);

  // The host cancels from Rukoo.
  await host.booking.action(c.id, 'cancel', { notify: true });
  assert.deepEqual(ops(host.video, 'remove').map((x) => x.ref), [refA, refC]);

  // The host deletes the event in the calendar.
  const evD = host.booking.state().bookings.find((x) => x.id === d.id).eventId;
  await host.calendars.remove(evD, { notify: true, etag: host.calendars.event(evD).etag });
  host.calendars.memos.clear();
  await host.booking.reconcile();
  assert.equal(srv.pages.get('bart').bookings.get(d.id).reason, 'host_deleted');
  assert.deepEqual(ops(host.video, 'remove').map((x) => x.ref), [refA, refC, refD]);
  assert.deepEqual(host.booking.state().notices.filter((n) => n.kind === 'video'), []);
});

test('a failed or expired connection keeps the booking: the event goes in without a link and a notice says what to do', async (t) => {
  const srv = await server(t);
  const host = await computer(t, srv);
  await pageWith(host, { ...ZOOM, label: 'Zoom call' });
  const start = slot(3, 10);

  // The sign-in stopped working on this computer.
  host.video.set('zoom', 'renew');
  let state = host.booking.state();
  const missing = state.notices.find((n) => n.id === 'videoMissing:zoom');
  assert.equal(missing.title, 'No Zoom links for new bookings');
  assert.equal(missing.text, 'The Zoom connection on this computer needs renewing, so new bookings of 30 minute meeting go in your calendar without a link. Renew it in Settings → Video meetings.');
  assert.deepEqual(missing.actions.map((x) => x.action), ['video', 'dismiss']);
  assert.deepEqual(state.video.missing, [{ service: 'zoom', name: 'Zoom', status: 'renew' }]);

  const a = await srv.book({ handle: 'bart', type: '30min', start, guest: { name: 'Jane Doe' } });
  await host.booking.sync();
  const ev = bookingEvent(host.fake, a.id);
  assert.ok(ev, 'the event is in the calendar');
  assert.equal(ev.location, 'Zoom call', "the type's own label, without a link");
  assert.ok(!/Join with/.test(ev.description));
  assert.equal(ev.attendees.filter((x) => !x.organizer).length, 1, 'the guest is invited');
  assert.equal(srv.pages.get('bart').bookings.get(a.id).handledVersion, 1, 'the booking is handled');
  assert.equal(mapOf(host, a.id).video, undefined);
  state = host.booking.state();
  const notice = state.notices.find((n) => n.id === `video:${a.id}`);
  assert.equal(notice.title, 'No Zoom link for a booking');
  assert.match(notice.text, /^Rukoo couldn't make a Zoom meeting for 30 minute meeting with Jane Doe on .+, so the booking is in your calendar without a link\. The Zoom connection on this computer needs renewing\. Add a link to the event yourself, or cancel the booking\.$/);
  assert.deepEqual(notice.actions.map((x) => x.action), ['video', 'open', 'dismiss']);

  // Renewed: the next booking gets its link again, and the condition's notice goes.
  host.video.set('zoom', 'connected');
  const b = await srv.book({ handle: 'bart', type: '30min', start: start + DAY, guest: { name: 'Max Power', email: 'max@example.org' } });
  await host.booking.sync();
  assert.ok(mapOf(host, b.id).video);
  assert.equal(host.booking.state().notices.some((n) => n.id === 'videoMissing:zoom'), false);

  // Zoom refuses the move: the event still moves, the link stays, and the notice says so.
  host.video.fail.update = Object.assign(new Error('Zoom refused the request: Meeting is locked.'), { video: true, code: 'refused' });
  srv.guestReschedule({ handle: 'bart', id: b.id, start: start + DAY + HOUR });
  await host.booking.sync();
  assert.equal(Date.parse(bookingEvent(host.fake, b.id).start.dateTime), start + DAY + HOUR);
  const moved = host.booking.state().notices.find((n) => n.id === `video:${b.id}`);
  assert.equal(moved.title, 'Zoom meeting not moved');
  assert.match(moved.text, /but Rukoo couldn't move its Zoom meeting\. Zoom refused the request: Meeting is locked\. The link in the invitation still works/);

  // Zoom can't be reached for the cancellation: the booking is cancelled, the meeting stays, and the notice says so.
  host.video.fail.remove = Object.assign(new Error("Rukoo couldn't reach Zoom. Check your internet connection and try again."), { video: true, code: 'network' });
  await host.booking.action(b.id, 'cancel', { notify: true });
  assert.equal(srv.pages.get('bart').bookings.get(b.id).status, 'cancelled');
  const kept = host.booking.state().notices.find((n) => n.id === `video:${b.id}`);
  assert.equal(kept.title, 'Zoom meeting not deleted');
  assert.match(kept.text, /is cancelled, but Rukoo couldn't delete its Zoom meeting\. Rukoo couldn't reach Zoom\. .* You can delete it in Zoom yourself\.$/);
  assert.deepEqual(kept.actions.map((x) => x.action), ['video', 'dismiss']);
});

test('a meeting made before the calendar write failed is the one the retry uses', async (t) => {
  const srv = await server(t);
  let down = false;
  const fake = fakeCalendar({ fail: ({ method, url }) => (down && method === 'POST' && /\/events$/.test(url.pathname) ? { status: 503, body: { error: { code: 503, message: 'Backend Error' } } } : null) });
  const host = await computer(t, srv, { fake });
  await pageWith(host, ZOOM);
  const start = slot(3, 10);
  const { id } = await srv.book({ handle: 'bart', type: '30min', start, guest: { name: 'Jane Doe' } });
  down = true;
  await host.booking.sync();
  assert.equal(bookingEvent(host.fake, id), undefined);
  assert.equal(srv.pages.get('bart').bookings.get(id).handledVersion, 0, 'not handled: tried again');
  assert.equal(ops(host.video, 'create').length, 1);
  // Kept in the Rukoo account, with the time it was made for.
  assert.deepEqual(keptOf(host, id), { service: 'zoom', id: 'm1', url: 'https://us05web.zoom.us/j/8101?pwd=p1', start, end: start + 30 * 60000 });

  // The guest moves the booking before the retry: the meeting moves along when the event is made.
  srv.guestReschedule({ handle: 'bart', id, start: start + HOUR });
  down = false;
  await host.booking.sync();
  assert.equal(ops(host.video, 'create').length, 1, 'no second meeting');
  assert.deepEqual(ops(host.video, 'update').map((x) => [x.ref.id, x.start, x.end]), [['m1', start + HOUR, start + HOUR + 30 * 60000]]);
  assert.equal(bookingEvent(host.fake, id).location, 'https://us05web.zoom.us/j/8101?pwd=p1');
  assert.equal(Date.parse(bookingEvent(host.fake, id).start.dateTime), start + HOUR);
  assert.deepEqual(mapOf(host, id).video, { service: 'zoom', id: 'm1', url: 'https://us05web.zoom.us/j/8101?pwd=p1', start: start + HOUR, end: start + HOUR + 30 * 60000 });
  assert.equal(keptOf(host, id), undefined, 'kept only until the event exists');

  // A booking cancelled while its event couldn't be written yet still takes its meeting with it.
  const other = await srv.book({ handle: 'bart', type: '30min', start: slot(4, 10), guest: { name: 'Max Power', email: 'max@example.org' } });
  down = true;
  await host.booking.sync();
  assert.equal(keptOf(host, other.id).id, 'm2');
  srv.guestCancel({ handle: 'bart', id: other.id });
  down = false;
  await host.booking.sync();
  assert.equal(bookingEvent(host.fake, other.id), undefined);
  assert.deepEqual(ops(host.video, 'remove').map((x) => x.ref.id), ['m2']);
  assert.equal(keptOf(host, other.id), undefined);
});

test('a kept meeting made for an earlier time moves once its event is written, and on a later pass when that fails', async (t) => {
  const srv = await server(t);
  let down = true;
  const fake = fakeCalendar({ fail: ({ method, url }) => (down && method === 'POST' && /\/events$/.test(url.pathname) ? { status: 503, body: { error: { code: 503, message: 'Backend Error' } } } : null) });
  const host = await computer(t, srv, { fake });
  await pageWith(host, ZOOM);
  const start = slot(3, 10);
  const end = start + 30 * 60000;
  const { id } = await srv.book({ handle: 'bart', type: '30min', start, guest: { name: 'Jane Doe' } });
  await host.booking.sync();
  srv.guestReschedule({ handle: 'bart', id, start: start + HOUR });
  await host.booking.sync();
  // No event yet: the meeting keeps its time until there is one.
  assert.equal(ops(host.video, 'update').length, 0);
  assert.equal(keptOf(host, id).start, start, 'still the time the meeting has');
  // The calendar takes the event; Zoom can't be reached for the move, here and when sync reconciles.
  down = false;
  host.video.fail.update = Object.assign(new Error("Rukoo couldn't reach Zoom."), { video: true, code: 'network' });
  await host.booking.sync();
  assert.equal(Date.parse(bookingEvent(host.fake, id).start.dateTime), start + HOUR);
  assert.equal(bookingEvent(host.fake, id).location, 'https://us05web.zoom.us/j/8101?pwd=p1');
  assert.equal(ops(host.video, 'update').length, 2);
  assert.deepEqual([mapOf(host, id).video.start, mapOf(host, id).video.end], [start, end]);
  assert.equal(keptOf(host, id), undefined, 'the mapping record has it');
  // Zoom answers again: the next pass moves it, and the mapping keeps its new time.
  host.video.fail.update = null;
  await host.booking.sync();
  assert.equal(ops(host.video, 'update').length, 3);
  assert.deepEqual([mapOf(host, id).video.start, mapOf(host, id).video.end], [start + HOUR, end + HOUR]);
  await host.booking.sync();
  assert.equal(ops(host.video, 'update').length, 3, 'nothing left to move');
  assert.equal(ops(host.video, 'create').length, 1);
});

test("a kept meeting stays the booking's when the type's location changes, or the type goes, before the retry", async (t) => {
  const srv = await server(t);
  let down = false;
  const fake = fakeCalendar({ fail: ({ method, url }) => (down && method === 'POST' && /\/events$/.test(url.pathname) ? { status: 503, body: { error: { code: 503, message: 'Backend Error' } } } : null) });
  const host = await computer(t, srv, { fake });
  await host.booking.enable(ENABLE);
  const first = host.booking.settings().types[0];
  const zoom = { ...first, location: ZOOM };
  const intro = { ...first, slug: 'intro', title: 'Intro', location: { kind: 'none', label: '', value: '', public: false } };
  const at = (location) => [{ ...zoom, location }, intro];
  const changes = [
    ['phone', at({ kind: 'phone', label: '', value: '+31 20 123 4567', public: false })],
    ['Teams', at({ ...ZOOM, service: 'teams' })],
    ['Google Meet', at({ kind: 'googleMeet', label: '', value: '', public: false })],
    ['none', at({ kind: 'none', label: '', value: '', public: false })],
    ['type deleted', [intro]]
  ];
  for (const [i, [change, types]] of changes.entries()) {
    await host.booking.save({ types: [zoom, intro] });
    const { id } = await srv.book({ handle: 'bart', type: '30min', start: slot(3, 10 + i), guest: { name: 'Jane Doe' } });
    const made = ops(host.video, 'create').length;
    // The meeting is made and kept; the calendar refuses the event.
    down = true;
    await host.booking.sync();
    const kept = keptOf(host, id);
    assert.ok(kept, change);
    assert.equal(bookingEvent(fake, id), undefined, change);
    // The host changes the type before the retry.
    await host.booking.save({ types });
    down = false;
    await host.booking.sync();
    assert.equal(ops(host.video, 'create').length, made + 1, `${change}: exactly one meeting`);
    assert.equal(mapOf(host, id).video.id, kept.id, `${change}: the mapping has the kept meeting`);
    assert.equal(keptOf(host, id), undefined, `${change}: kept until the mapping has it`);
    const ev = bookingEvent(fake, id);
    assert.equal(ev.location, kept.url, `${change}: the invitation has its link`);
    assert.equal(ev.conferenceData, undefined, `${change}: no Google Meet besides`);
    // Cancelling the booking deletes that meeting.
    await host.booking.action(id, 'cancel', { notify: true });
    assert.equal(ops(host.video, 'remove').at(-1).ref.id, kept.id, change);
  }
});

test("the kept meeting is on disk before the calendar write starts", async (t) => {
  const srv = await server(t);
  const host = await computer(t, srv);
  await pageWith(host, ZOOM);
  const { id } = await srv.book({ handle: 'bart', type: '30min', start: slot(3, 10), guest: { name: 'Jane Doe' } });
  const key = `meeting:${host.account.acct}:${id}`;
  const create = host.calendars.create.bind(host.calendars);
  let onDisk = null;
  host.calendars.create = (...args) => {
    // What a restart after a crash right now would find.
    const file = JSON.parse(require('fs').readFileSync(path.join(host.dataDir, 'account-records.json'), 'utf8'));
    onDisk = file.entries.find((e) => e.c === 'booking' && e.k === key && !e.deleted) || null;
    return create(...args);
  };
  await host.booking.sync();
  assert.ok(onDisk, 'the kept meeting was written to disk before calendars.create');
  assert.equal(onDisk.v.id, 'm1');
  assert.equal(mapOf(host, id).video.id, 'm1');
});

test('while the disk refuses the kept meeting, the event waits, also on a retry that reuses it', async (t) => {
  const srv = await server(t);
  const host = await computer(t, srv);
  await pageWith(host, ZOOM);
  const { id } = await srv.book({ handle: 'bart', type: '30min', start: slot(3, 10), guest: { name: 'Jane Doe' } });
  const flush = host.account.flush.bind(host.account);
  host.account.flush = () => false;
  await host.booking.sync();
  await host.booking.sync();
  assert.equal(bookingEvent(host.fake, id), undefined, 'no event while the meeting is only in memory');
  assert.equal(srv.pages.get('bart').bookings.get(id).handledVersion, 0, 'tried again');
  assert.equal(ops(host.video, 'create').length, 1, 'the retry reuses the kept meeting');
  assert.deepEqual(host.booking.state().notices.filter((n) => n.kind === 'video'), [], 'not a booking without a link');
  host.account.flush = flush;
  await host.booking.sync();
  assert.equal(bookingEvent(host.fake, id).location, 'https://us05web.zoom.us/j/8101?pwd=p1');
  assert.equal(mapOf(host, id).video.id, 'm1');
  assert.equal(keptOf(host, id), undefined);
  assert.equal(ops(host.video, 'create').length, 1);
});

test("a meeting the service couldn't delete keeps its notice when the booking's other meeting is deleted", async (t) => {
  const srv = await server(t);
  const host = await computer(t, srv);
  await pageWith(host, ZOOM);
  const start = slot(3, 10);
  const { id } = await srv.book({ handle: 'bart', type: '30min', start, guest: { name: 'Jane Doe' } });
  await host.booking.sync();
  // A second meeting kept for the booking besides the one in its mapping record.
  host.account.put('booking', `meeting:${host.account.acct}:${id}`, { service: 'zoom', id: 'm9', url: 'https://us05web.zoom.us/j/8109?pwd=p9', start, end: start + 30 * 60000 });
  const remove = host.video.remove;
  host.video.remove = async (ref) => {
    if (ref.id === 'm1') {
      host.video.calls.push({ op: 'remove', ref });
      throw Object.assign(new Error("Rukoo couldn't reach Zoom."), { video: true, code: 'network' });
    }
    return remove(ref);
  };
  await host.booking.action(id, 'cancel', { notify: true });
  assert.deepEqual(ops(host.video, 'remove').map((x) => x.ref.id), ['m1', 'm9']);
  assert.equal(keptOf(host, id), undefined, 'the deleted one is forgotten');
  assert.equal(host.booking.state().notices.find((n) => n.id === `video:${id}`).title, 'Zoom meeting not deleted');
});

test("a host's move moves the meeting when handled fails, and the mapping keeps the meeting's own time", async (t) => {
  const srv = await server(t);
  const host = await computer(t, srv);
  await pageWith(host, ZOOM);
  const start = slot(3, 10);
  const end = start + 30 * 60000;
  const { id } = await srv.book({ handle: 'bart', type: '30min', start, guest: { name: 'Jane Doe' } });
  await host.booking.sync();

  // The host moves the event; the server takes the move, then refuses handled once.
  const ev = host.calendars.event(host.booking.state().bookings.find((x) => x.id === id).eventId);
  await host.calendars.update(ev.id, { accountId: ev.accountId, calendarId: ev.calendarId, title: ev.title, location: ev.location, description: ev.description, allDay: false, start: start + HOUR, end: end + HOUR }, { etag: ev.etag, scope: 'one' });
  let refused = 0;
  srv.fail = ({ route, body }) => (route === 'POST /v1/booking/bookings' && body.action === 'handled' && refused++ === 0 ? [503, { error: 'unavailable', message: 'down' }] : null);
  await host.booking.reconcile();
  assert.equal(refused >= 1, true, 'handled was refused');
  assert.equal(srv.pages.get('bart').bookings.get(id).start, start + HOUR);
  await host.booking.reconcile();
  await host.booking.sync();
  srv.fail = null;
  await host.booking.sync();
  assert.deepEqual(ops(host.video, 'update').map((x) => [x.ref.id, x.start, x.end]), [['m1', start + HOUR, end + HOUR]], 'moved once');
  assert.deepEqual(mapOf(host, id).video, { service: 'zoom', id: 'm1', url: 'https://us05web.zoom.us/j/8101?pwd=p1', start: start + HOUR, end: end + HOUR });
});

test('a meeting whose move failed is moved on a later pass, and keeps its old time in the mapping until then', async (t) => {
  const srv = await server(t);
  const host = await computer(t, srv);
  await pageWith(host, ZOOM);
  const start = slot(3, 10);
  const end = start + 30 * 60000;
  const { id } = await srv.book({ handle: 'bart', type: '30min', start, guest: { name: 'Jane Doe' } });
  await host.booking.sync();
  // The guest moves the booking while Zoom can't be reached; sync tries again when it reconciles.
  const unreachable = Object.assign(new Error("Rukoo couldn't reach Zoom."), { video: true, code: 'network' });
  host.video.fail.update = unreachable;
  srv.guestReschedule({ handle: 'bart', id, start: start + HOUR });
  await host.booking.sync();
  assert.equal(ops(host.video, 'update').length, 2);
  assert.equal(srv.pages.get('bart').bookings.get(id).handledVersion, 2, 'the booking is handled');
  assert.equal(mapOf(host, id).start, start + HOUR);
  assert.deepEqual([mapOf(host, id).video.start, mapOf(host, id).video.end], [start, end], 'still the time the meeting has');
  const video = () => host.booking.state().notices.filter((n) => n.id === `video:${id}`);
  assert.deepEqual(video().map((n) => n.title), ['Zoom meeting not moved']);

  // Zoom answers again: the next pass moves the meeting once, keeps its new time, and the notice goes.
  host.video.fail.update = null;
  await host.booking.reconcile();
  await host.booking.sync();
  assert.equal(ops(host.video, 'update').length, 3, 'moved once');
  assert.deepEqual([mapOf(host, id).video.start, mapOf(host, id).video.end], [start + HOUR, end + HOUR]);
  assert.deepEqual(video(), []);

  // Another move that fails: its notice, once dismissed, stays away while later passes keep trying.
  host.video.fail.update = unreachable;
  srv.guestReschedule({ handle: 'bart', id, start: start + 2 * HOUR });
  await host.booking.sync();
  assert.equal(video().length, 1);
  await host.booking.action(`video:${id}`, 'dismiss');
  await host.booking.reconcile();
  assert.equal(ops(host.video, 'update').length, 6);
  assert.deepEqual(video(), []);
  assert.equal(mapOf(host, id).video.start, start + HOUR);
});

test('a video service chosen while another computer takes over is put back and refused', async (t) => {
  const srv = await server(t);
  const fake = fakeCalendar();
  const desk = await computer(t, srv, { fake, name: 'desk' });
  await desk.booking.enable(ENABLE);
  const laptop = await computer(t, srv, { fake, signUp: false, name: 'laptop' });
  await laptop.account.sync();
  const type = desk.booking.settings().types[0];
  const before = type.location;
  // The laptop takes over after the desk checked who handles bookings, before its change is up.
  const write = desk.booking.writeSettings.bind(desk.booking);
  let once = true;
  desk.booking.writeSettings = async (change) => {
    if (once) {
      once = false;
      await laptop.booking.takeover();
    }
    return write(change);
  };
  await assert.rejects(desk.booking.save({ types: [{ ...type, title: 'Chat', location: ZOOM }] }), (err) => err.code === 'invalid' && err.field === 'types[0].location.kind');
  assert.equal(desk.booking.thisDevice(), false);
  assert.deepEqual(desk.booking.settings().types[0].location, before, 'the location it had');
  assert.equal(desk.booking.settings().types[0].title, 'Chat', 'the rest of the change stays');
  // The laptop, which now handles bookings, reads the same.
  await laptop.account.sync();
  assert.deepEqual(laptop.booking.settings().types[0].location, before);
});

test('a video service chosen just after another computer took over is refused, also before this one noticed', async (t) => {
  const srv = await server(t);
  const fake = fakeCalendar();
  const desk = await computer(t, srv, { fake, name: 'desk' });
  await desk.booking.enable(ENABLE);
  const laptop = await computer(t, srv, { fake, signUp: false, name: 'laptop' });
  await laptop.account.sync();
  await laptop.booking.takeover();
  // The desk hasn't looked since; its copy of the page still names itself.
  assert.equal(desk.booking.thisDevice(), true);
  const type = desk.booking.settings().types[0];
  await assert.rejects(desk.booking.save({ types: [{ ...type, location: ZOOM }] }), (err) => err.code === 'invalid' && err.field === 'types[0].location.kind');
  assert.equal(desk.booking.thisDevice(), false);
  assert.notDeepEqual(desk.booking.settings().types[0].location, ZOOM);
});

test('a computer that takes over uses the meeting the other one made before the calendar write failed', async (t) => {
  const srv = await server(t);
  let down = false;
  const fake = fakeCalendar({ fail: ({ method, url }) => (down && method === 'POST' && /\/events$/.test(url.pathname) ? { status: 503, body: { error: { code: 503, message: 'Backend Error' } } } : null) });
  const desk = await computer(t, srv, { fake, name: 'desk' });
  await pageWith(desk, ZOOM);
  const { id } = await srv.book({ handle: 'bart', type: '30min', start: slot(3, 10), guest: { name: 'Jane Doe' } });
  down = true;
  await desk.booking.sync();
  await desk.account.sync();
  assert.equal(ops(desk.video, 'create').length, 1);

  const laptop = await computer(t, srv, { fake, signUp: false, name: 'laptop' });
  await laptop.account.sync();
  down = false;
  await laptop.booking.takeover();
  await laptop.booking.sync();
  assert.equal(ops(laptop.video, 'create').length, 0, 'no second meeting');
  assert.equal(bookingEvent(fake, id).location, 'https://us05web.zoom.us/j/8101?pwd=p1');
  assert.equal(mapOf(laptop, id).video.id, 'm1');
  // Cancelled from the laptop, the desk's meeting goes.
  await laptop.booking.action(id, 'cancel', { notify: true });
  assert.deepEqual(ops(laptop.video, 'remove').map((x) => x.ref.id), ['m1']);
});

test('another computer says which services it still needs before it takes over, and says so after', async (t) => {
  const srv = await server(t);
  const fake = fakeCalendar();
  const desk = await computer(t, srv, { fake, name: 'desk' });
  await pageWith(desk, ZOOM);
  const laptop = await computer(t, srv, { fake, signUp: false, name: 'laptop', video: fakeVideo({ zoom: 'off' }) });
  await laptop.account.sync();
  let state = await laptop.booking.load({ refresh: true });
  assert.deepEqual(state.video.missing, [{ service: 'zoom', name: 'Zoom', status: 'off' }]);
  const other = state.notices.find((n) => n.kind === 'otherDevice');
  assert.equal(other.text, 'That computer publishes your free times and adds bookings to your calendar. Before you use this computer instead, connect Zoom here in Settings → Video meetings.');
  assert.equal(state.notices.some((n) => n.kind === 'videoMissing'), false, 'the condition notice is for the computer that handles bookings');
  // A video service is chosen where bookings are handled; other changes are fine here, and keep the type's service.
  const type = state.settings.types[0];
  await assert.rejects(laptop.booking.save({ types: [{ ...type, location: { ...ZOOM, service: 'teams' } }] }), (err) => err.code === 'invalid' && err.field === 'types[0].location.kind' && /computer that handles your bookings/.test(err.message));
  await assert.rejects(laptop.booking.save({ types: [type, { ...type, slug: 'intro', title: 'Intro' }] }), (err) => err.field === 'types[1].location.kind');
  state = await laptop.booking.save({ intro: 'Hello there' });
  assert.deepEqual(state.settings.types[0].location, ZOOM);
  assert.equal(state.settings.intro, 'Hello there');

  state = await laptop.booking.takeover();
  assert.equal(state.thisDevice, true);
  const missing = state.notices.find((n) => n.id === 'videoMissing:zoom');
  assert.equal(missing.text, "Zoom isn't connected on this computer, so new bookings of 30 minute meeting go in your calendar without a link. Connect it in Settings → Video meetings.");
  // A booking now goes in without a link, with the notice; connected, the next one has one.
  const a = await srv.book({ handle: 'bart', type: '30min', start: slot(3, 10), guest: { name: 'Jane Doe' } });
  await laptop.booking.sync();
  assert.ok(bookingEvent(fake, a.id));
  assert.match(laptop.booking.state().notices.find((n) => n.id === `video:${a.id}`).text, /Zoom isn't connected on this computer\./);
  laptop.video.set('zoom', 'connected');
  assert.equal(laptop.booking.state().notices.some((n) => n.kind === 'videoMissing'), false);
});

test('services that only upcoming bookings still use count before and after a takeover too', async (t) => {
  const srv = await server(t);
  const fake = fakeCalendar();
  const desk = await computer(t, srv, { fake, name: 'desk', video: fakeVideo({ jitsi: 'connected' }) });
  await pageWith(desk, ZOOM);
  const { id } = await srv.book({ handle: 'bart', type: '30min', start: slot(3, 10), guest: { name: 'Jane Doe' } });
  await desk.booking.sync();
  // The type moves to Jitsi; the booking keeps its Zoom meeting.
  const type = desk.booking.settings().types[0];
  await desk.booking.save({ types: [{ ...type, location: { ...ZOOM, service: 'jitsi' } }] });
  await desk.account.sync();

  const laptop = await computer(t, srv, { fake, signUp: false, name: 'laptop', video: fakeVideo({ zoom: 'off', jitsi: 'connected' }) });
  await laptop.account.sync();
  let state = await laptop.booking.load({ refresh: true });
  assert.deepEqual(state.video.missing, [{ service: 'zoom', name: 'Zoom', status: 'off' }]);
  assert.match(state.notices.find((n) => n.kind === 'otherDevice').text, /connect Zoom here/);

  state = await laptop.booking.takeover();
  const notice = state.notices.find((n) => n.id === 'videoMissing:zoom');
  assert.equal(notice.title, "Zoom meetings can't follow their bookings");
  assert.equal(notice.text, "Zoom isn't connected on this computer. Until that's fixed, Rukoo can't move or delete the Zoom meeting of 1 upcoming booking.");
  laptop.video.set('zoom', 'connected');
  assert.deepEqual(laptop.booking.state().video.missing, []);
  assert.equal(mapOf(laptop, id).video.service, 'zoom');
});

test('Jitsi gives a booking a room on meet.jit.si without an account', async (t) => {
  const srv = await server(t);
  const host = await computer(t, srv, { video: new VideoServices({ dataDir: path.join(tempDir('rukoo-jitsi-'), 'data'), secrets, env: {} }).init() });
  host.video.setRoom('jitsi', { on: true });
  await pageWith(host, { kind: 'video', service: 'jitsi', label: '', value: '', public: false });
  assert.deepEqual(srv.pages.get('bart').profile.types[0].location, { kind: 'link', label: 'Jitsi Meet' });
  const { id } = await srv.book({ handle: 'bart', type: '30min', start: slot(3, 10), guest: { name: 'Jane Doe' } });
  await host.booking.sync();
  const ev = bookingEvent(host.fake, id);
  assert.match(ev.location, /^https:\/\/meet\.jit\.si\/rukoo-[a-z]{22}$/);
  assert.ok(ev.description.startsWith(`Join with Jitsi Meet: ${ev.location}`));
  // A cancellation has nothing to delete, and leaves no notice.
  await host.booking.action(id, 'cancel', { notify: true });
  assert.deepEqual(host.booking.state().notices.filter((n) => /video/i.test(n.kind)), []);
});

test("on a CalDAV calendar the booking's event carries the link as its location and in its description", async (t) => {
  const dav = await caldavServer({ scheduling: true });
  t.after(() => dav.close());
  const provider = new CalDavCalendar({ url: `${dav.url}/`, credentials: () => ({ user: 'me@example.com', password: 'secret' }), addresses: () => ['me@example.com'], invites: () => null, timeZone: () => 'Europe/Amsterdam' });
  provider.home = dav.home;
  const [home] = await provider.calendars();
  const srv = await server(t);
  const host = await computer(t, srv);
  await pageWith(host, ZOOM);
  const settings = host.booking.settings();
  const start = slot(3, 10);
  const row = { id: 'Rf63vMqqWdS0MICDAHKmrw', type: '30min', start, end: start + 30 * 60000 };
  const input = host.booking.eventInput(row, { name: 'Jane Doe', email: 'jane@example.com', manageKey: 'k'.repeat(43) }, settings, { accountId: 'c1', calendarId: home.id, conference: false });
  const meeting = { service: 'zoom', id: '81', url: 'https://us05web.zoom.us/j/81?pwd=abc' };
  await provider.create(home, withMeeting(input, meeting, { locale: settings.locale, name: 'Zoom' }), { bookingId: row.id, uid: `${row.id}@meet.example` });
  const [name] = dav.names();
  const unfolded = dav.object(name).data.replace(/\r\n[ \t]/g, '');
  assert.match(unfolded, /\r\nLOCATION:https:\/\/us05web\.zoom\.us\/j\/81\?pwd=abc\r\n/);
  assert.match(unfolded, /\r\nDESCRIPTION:Join with Zoom: https:\/\/us05web\.zoom\.us\/j\/81\?pwd=abc\\n\\nPick another time: [^\r]+\\nCancel booking: [^\r]+\r\n/);
  assert.match(unfolded, /ATTENDEE[^\r]*mailto:jane@example\.com/i);
});
