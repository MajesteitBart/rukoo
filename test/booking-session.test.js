'use strict';

// A booking job that is still waiting for a calendar or the server when this computer signs out of the Rukoo account
// and into another one: it stops, and nothing of the first account reaches the second (its records, booking.json,
// notices, notifications or the server under its session). And the calendar UID a failed 'handled' was meant to
// report still goes to the server when it is tried again.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startAccountServer } = require('./fixtures/account-server');
const { fakeCalendar, setup } = require('./fixtures/google-calendar');
const { AccountService, bookingAcct } = require('../src/main/account');
const { Booking } = require('../src/main/booking');
const { calendarKey } = require('../src/main/calendar');

const secrets = { encrypt: (s) => `plain:${Buffer.from(s).toString('base64')}`, decrypt: (s) => Buffer.from(String(s).slice(6), 'base64').toString() };
const PASSWORD = 'a long enough password';
const HOUR = 3600000;
const DAY = 24 * HOUR;
const ENABLE = { handle: 'bart', name: 'Bart', timeZone: 'Europe/Amsterdam', destination: calendarKey('g1', 'me@example.com') };
const ONE = bookingAcct('one@example.com');
const TWO = bookingAcct('two@example.com');

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

// A computer signed up as one@example.com. calls: every booking route it calls, with the account signed in then.
async function computer(t, srv, { email = 'one@example.com', fake = fakeCalendar() } = {}) {
  const { engine, calendars, dataDir } = setup(fake);
  const account = new AccountService({ dataDir, secrets, defaultServer: srv.url, deviceName: 'desk', platform: 'linux' }).init();
  await account.signUp({ email, password: PASSWORD });
  const calls = [];
  const bookingCall = account.bookingCall.bind(account);
  account.bookingCall = (method, route, body) => {
    calls.push({ method, route, body, acct: account.acct });
    return bookingCall(method, route, body);
  };
  const shown = [];
  const booking = new Booking({ account, calendars, engine, dataDir, notify: (n) => shown.push(n), timing: { auto: false, publishAfter: HOUR, reconcileAfter: HOUR } }).init();
  t.after(() => {
    booking.close();
    account.close();
    calendars.flush();
  });
  return { engine, calendars, account, booking, shown, fake, dataDir, calls };
}

// The first call of obj[name] that match() accepts answers only after release(), as a slow calendar or server
// would: the work itself is done, the answer waits. started resolves when it is waiting.
function slow(obj, name, match = () => true) {
  const original = obj[name];
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  let reached;
  const started = new Promise((resolve) => (reached = resolve));
  let waited = false;
  obj[name] = async (...args) => {
    const out = await original.apply(obj, args);
    if (!waited && match(...args)) {
      waited = true;
      reached();
      await gate;
    }
    return out;
  };
  return { started, release };
}

async function switchTo(desk, email) {
  await desk.account.signOut();
  await desk.account.signUp({ email, password: PASSWORD });
}

const bookingEvents = (fake, id) => fake.store.filter((e) => e.extendedProperties && e.extendedProperties.private && e.extendedProperties.private.rukooBooking === id && e.status !== 'cancelled');

// Nothing of the first account in the second: no records under its <acct>, nothing in its booking.json, no
// notification and no booking route called while it was signed in.
async function assertNothingFor(desk, { shownBefore }) {
  assert.equal(desk.account.acct, TWO);
  const theirs = [...desk.account.entries.values()].filter((e) => !e.deleted && (e.c === 'booking' || e.c === 'bookingkey') && e.k.includes(TWO));
  assert.deepEqual(theirs.map((e) => `${e.c}:${e.k}`), [], 'no booking records for the second account');
  const file = desk.booking.file;
  assert.equal(file.acct, TWO);
  assert.deepEqual([file.rows, file.handled, file.seen, file.unopened, file.busy, file.notices, file.unchecked, file.lost, file.page], [{}, {}, {}, {}, {}, [], [], false, null]);
  assert.deepEqual(file.publish, { at: 0, lastOk: null, hash: null, ok: true, error: null });
  const onDisk = JSON.parse(fs.readFileSync(path.join(desk.dataDir, 'booking.json'), 'utf8'));
  assert.equal(onDisk.acct, TWO);
  assert.deepEqual([onDisk.rows, onDisk.notices], [{}, []]);
  assert.deepEqual(desk.calls.filter((c) => c.acct === TWO).map((c) => `${c.method} ${c.route}`), [], 'no booking route under the second account');
  assert.equal(desk.shown.length, shownBefore, 'no notification about the first account');
  await desk.account.sync();
}

test("a booking whose event is still being made when another account signs in doesn't reach that account", async (t) => {
  const srv = await server(t);
  const desk = await computer(t, srv);
  await desk.booking.enable(ENABLE);
  const { id } = await srv.book({ handle: 'bart', type: '30min', start: slot(3, 10), guest: { name: 'Jane Doe', email: 'jane@example.com', notes: 'Private notes' } });

  const create = slow(desk.calendars, 'create');
  const job = desk.booking.sync();
  await create.started;
  const shownBefore = desk.shown.length;
  await switchTo(desk, 'two@example.com');
  create.release();
  const state = await job;

  assert.deepEqual([state.signedIn, state.email, state.status, state.bookings], [true, 'two@example.com', 'off', []], "the stopped job answers with the second account's state");
  await assertNothingFor(desk, { shownBefore });
  assert.equal(srv.accounts.get('two@example.com').records.size, 0, 'nothing went up to the second account');
  assert.equal(desk.account.get('booking', `map:${ONE}:${id}`), undefined, 'the first account gets its record when it processes the booking itself');
  assert.equal(srv.pages.get('bart').bookings.get(id).handledVersion, 0);

  // Back in the first account, the booking gets the event the stopped job made, not a second one.
  await desk.account.signOut();
  await desk.account.signIn({ email: 'one@example.com', password: PASSWORD });
  await desk.account.sync();
  await desk.booking.takeover();
  const events = bookingEvents(desk.fake, id);
  assert.equal(events.length, 1);
  const map = desk.account.get('booking', `map:${ONE}:${id}`);
  assert.equal(map.eventId, events[0].id);
  assert.equal(map.guest.notes, 'Private notes');
  assert.equal(srv.pages.get('bart').bookings.get(id).handledVersion, 1);
});

test('turning the page on while another account signs in publishes nothing and writes no settings for that account', async (t) => {
  const srv = await server(t);
  const desk = await computer(t, srv);
  const busy = slow(desk.calendars, 'availabilitySet');
  const job = desk.booking.enable(ENABLE);
  await busy.started;
  await switchTo(desk, 'two@example.com');
  busy.release();
  const state = await job;

  assert.deepEqual([state.email, state.status, state.settings], ['two@example.com', 'off', null]);
  await assertNothingFor(desk, { shownBefore: 0 });
  assert.deepEqual(desk.calls.filter((c) => c.method === 'PUT').length, 0, 'no page was published');
  assert.equal(srv.pages.size, 0);
  assert.equal(srv.accounts.get('two@example.com').records.size, 0);
});

test('an action asked for while another job held the queue stops when another account signed in before it started', async (t) => {
  const srv = await server(t);
  const desk = await computer(t, srv);
  // A slow job holds the queue; the first account asks to turn its page on behind it.
  const hold = slow(desk.calendars, 'availabilitySet');
  const first = desk.booking.enable({ ...ENABLE, name: 'First account' });
  await hold.started;
  const queued = desk.booking.enable({ ...ENABLE, handle: 'bart-private', name: 'Account one private name' });
  await switchTo(desk, 'two@example.com');
  hold.release();
  const [a, b] = await Promise.all([first, queued]);

  for (const state of [a, b]) assert.deepEqual([state.email, state.status, state.settings], ['two@example.com', 'off', null]);
  await assertNothingFor(desk, { shownBefore: 0 });
  assert.equal(desk.calls.filter((c) => c.method === 'PUT').length, 0, 'neither page was published');
  assert.equal(srv.pages.size, 0);
  assert.equal(srv.accounts.get('two@example.com').records.size, 0);
});

test('an account deletion that waited in the queue while its session ended stops before the account goes', async (t) => {
  const srv = await server(t);
  const desk = await computer(t, srv);
  await desk.booking.enable(ENABLE);
  await srv.book({ handle: 'bart', type: '30min', start: slot(3, 10), guest: { name: 'Jane Doe', email: 'jane@example.com' } });
  // A booking being processed holds the queue; the deletion waits behind it while the session is replaced.
  const create = slow(desk.calendars, 'create');
  const job = desk.booking.sync();
  await create.started;
  const deletion = desk.booking.disableForDelete();
  await desk.account.signOut();
  await desk.account.signIn({ email: 'one@example.com', password: PASSWORD });
  create.release();
  await job;
  await assert.rejects(deletion, (err) => err.code === 'deleteFirst');
  assert.equal(desk.calls.filter((c) => c.method === 'DELETE' && c.route === '/v1/booking').length, 0, 'the page was not deleted');
  assert.ok(srv.pages.get('bart'), 'the page is still there');
});

test("a host cancellation from reconciliation that answers after another account signed in stops there", async (t) => {
  const srv = await server(t);
  const desk = await computer(t, srv);
  await desk.booking.enable(ENABLE);
  const { id } = await srv.book({ handle: 'bart', type: '30min', start: slot(3, 10), guest: { name: 'Jane Doe', email: 'jane@example.com' } });
  await desk.booking.sync();
  // Deleted from the calendar: reconciliation cancels the booking as host_deleted.
  const eventId = desk.booking.state().bookings[0].eventId;
  await desk.calendars.remove(eventId, { notify: true, etag: desk.calendars.event(eventId).etag });
  desk.calendars.memos.clear();

  const cancel = slow(desk.account, 'bookingCall', (method, route, body) => Boolean(body && body.action === 'cancel'));
  desk.booking.soon('reconcile', 0);
  await cancel.started;
  const shownBefore = desk.shown.length;
  await switchTo(desk, 'two@example.com');
  cancel.release();
  await desk.booking.queue;

  await assertNothingFor(desk, { shownBefore });
  const row = srv.pages.get('bart').bookings.get(id);
  assert.deepEqual([row.status, row.reason], ['cancelled', 'host_deleted'], 'the cancellation itself went out under the first account');
});

test('declining a request while another account signs in sends nothing further and keeps nothing for that account', async (t) => {
  const srv = await server(t);
  const desk = await computer(t, srv);
  await desk.booking.enable(ENABLE);
  const sent = [];
  desk.engine.send = async (payload) => {
    sent.push(payload);
    return true;
  };
  const { id } = await srv.book({ handle: 'bart', type: '30min', start: slot(3, 10), status: 'pending', guest: { name: 'Jane Doe', email: 'jane@example.com' } });
  await desk.booking.sync();

  const decline = slow(desk.account, 'bookingCall', (method, route, body) => Boolean(body && body.action === 'decline'));
  const job = desk.booking.action(id, 'decline', { message: 'Not this week.', email: true });
  await decline.started;
  const shownBefore = desk.shown.length;
  await switchTo(desk, 'two@example.com');
  decline.release();
  const state = await job;

  assert.equal(state.email, 'two@example.com');
  await assertNothingFor(desk, { shownBefore });
  assert.deepEqual(sent, [], 'no mail to the guest');
});

test("a 'handled' that failed is tried again with the UID the calendar gave the event", async (t) => {
  const srv = await server(t);
  // The fake gives an inserted event a UID of its own, as Google may.
  const desk = await computer(t, srv);
  await desk.booking.enable(ENABLE);
  const start = slot(3, 10);
  const { id } = await srv.book({ handle: 'bart', type: '30min', start, guest: { name: 'Jane Doe' } });
  const row = srv.pages.get('bart').bookings.get(id);
  const bookedUid = row.uid;
  const handled = () => srv.calls.filter((c) => c.route === 'POST /v1/booking/bookings' && c.body.action === 'handled');

  srv.fail = ({ route, body }) => (route === 'POST /v1/booking/bookings' && body.action === 'handled' ? [500, { error: 'server', message: 'down' }] : null);
  await desk.booking.sync();
  const ev = bookingEvents(desk.fake, id)[0];
  assert.ok(ev, 'the event was made');
  assert.notEqual(ev.iCalUID, bookedUid);
  assert.equal(handled().length, 1);
  assert.equal(handled()[0].body.uid, ev.iCalUID);
  assert.deepEqual([row.handledVersion, row.uid], [0, bookedUid], 'the server took none of it');
  assert.equal(desk.account.get('booking', `map:${ONE}:${id}`).uid, ev.iCalUID, 'the mapping record has the UID before the server does');

  srv.fail = null;
  await desk.booking.sync();
  assert.equal(handled().length, 2);
  assert.equal(handled()[1].body.uid, ev.iCalUID, 'the retry carries the UID');
  assert.deepEqual([row.handledVersion, row.uid], [1, ev.iCalUID]);
  assert.equal(bookingEvents(desk.fake, id).length, 1);

  // Once the server has it, a later 'handled' leaves it out.
  srv.guestReschedule({ handle: 'bart', id, start: start + 2 * HOUR });
  await desk.booking.sync();
  assert.equal(handled().length, 3);
  assert.equal(handled()[2].body.uid, undefined);
  assert.deepEqual([row.handledVersion, row.uid], [2, ev.iCalUID]);
});
