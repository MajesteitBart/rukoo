'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Invitations } = require('../src/main/calendar/invitations');

function ics({ method = 'REQUEST', uid = 'uid-1@example.com', status = 'CONFIRMED', organizer = 'daniel@example.com', sequence = 0, guests = ['sanne@example.com'] } = {}) {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Test//EN',
    `METHOD:${method}`,
    'BEGIN:VEVENT',
    `UID:${uid}`,
    'DTSTAMP:20261029T120000Z',
    'DTSTART:20261103T090000Z',
    'DTEND:20261103T100000Z',
    'SUMMARY:Planning',
    `SEQUENCE:${sequence}`,
    `STATUS:${status}`,
    `ORGANIZER;CN=Daniel:mailto:${organizer}`,
    `ATTENDEE;CN=Daniel;PARTSTAT=ACCEPTED:mailto:${organizer}`,
    ...guests.map((g) => `ATTENDEE;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${g}`),
    'END:VEVENT',
    'END:VCALENDAR',
    ''
  ].join('\r\n');
}

// A mail engine with Sanne's account (and her work account, when asked), whose invitations are kept by id; send()
// records what would go out.
const SANNE = { id: 'acc1', email: 'sanne@example.com', name: 'Sanne de Vries' };
const WORK = { id: 'acc2', email: 'sanne@work.example', name: 'Sanne de Vries' };
function fakeEngine(sources, accounts = [SANNE]) {
  const sent = [];
  return {
    sent,
    accounts,
    identities: (a) => [{ address: a.email, name: a.name }],
    identity: (a, address) => (!address || address.toLowerCase() === a.email ? { address: a.email, name: a.name } : null),
    ownAddresses: (id) => accounts.filter((a) => !id || a.id === id).map((a) => a.email),
    inviteSource: async (id) => sources[id] || null,
    send: async (payload, opts) => sent.push({ payload, opts })
  };
}

// A calendar store that has the given event (or none) and records answers and new events.
function fakeCalendars(found) {
  const calls = { respond: [], create: [], find: [] };
  return {
    calls,
    findInvite: async (query) => {
      calls.find.push(query);
      return found;
    },
    respond: async (id, response, opts) => calls.respond.push({ id, response, opts }),
    event: (id) => (found && found.id === id ? { ...found, response: calls.respond.at(-1).response } : null),
    create: async (input) => {
      calls.create.push(input);
      return { id: 'acc1:cal:new', start: input.start };
    }
  };
}

const dataDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rukoo-invites-'));

test('an invitation in a calendar that can answer it is answered there, and no email goes out', async () => {
  const engine = fakeEngine({ m1: { text: ics(), method: 'REQUEST', accountId: 'acc1' } });
  const calendars = fakeCalendars({ id: 'acc1:primary:evt1', canRespond: true, response: 'needsAction' });
  const inv = new Invitations({ engine, calendars, dataDir: dataDir() });
  const state = await inv.state({ id: 'm1' });
  assert.equal(state.event.id, 'acc1:primary:evt1');
  assert.equal(state.invite.me, 'sanne@example.com');
  // Only this account's event, for this address, is the one to answer.
  assert.equal(calendars.calls.find[0].accountId, 'acc1');
  assert.equal(calendars.calls.find[0].me, 'sanne@example.com');
  const res = await inv.answer({ id: 'm1' }, 'accepted');
  assert.equal(res.via, 'calendar');
  assert.deepEqual(calendars.calls.respond, [{ id: 'acc1:primary:evt1', response: 'accepted', opts: { series: false } }]);
  assert.equal(engine.sent.length, 0);
});

test('otherwise the answer goes to the organizer by email, from the account it came to, and is remembered', async () => {
  const dir = dataDir();
  const engine = fakeEngine({ m1: { text: ics(), method: 'REQUEST', accountId: 'acc1' } });
  const calendars = fakeCalendars(null);
  const inv = new Invitations({ engine, calendars, dataDir: dir });
  const res = await inv.answer({ id: 'm1' }, 'tentative');
  assert.deepEqual(res, { via: 'email', to: 'daniel@example.com' });
  const [{ payload, opts }] = engine.sent;
  assert.equal(payload.accountId, 'acc1');
  assert.equal(payload.from, 'sanne@example.com');
  assert.deepEqual(payload.to, [{ name: 'Daniel', address: 'daniel@example.com' }]);
  assert.equal(payload.subject, 'Tentatively accepted: Planning');
  assert.equal(opts.icalEvent.method, 'REPLY');
  assert.match(opts.icalEvent.content, /METHOD:REPLY/);
  assert.match(opts.icalEvent.content.replace(/\r\n /g, ''), /ATTENDEE;PARTSTAT=TENTATIVE:mailto:sanne@example.com/);
  assert.equal(calendars.calls.respond.length, 0);
  // A new run reads the answer back from data/invitations.json.
  const again = new Invitations({ engine, calendars, dataDir: dir });
  assert.equal((await again.state({ id: 'm1' })).answered, 'tentative');
});

test('a calendar that has the event but cannot answer it leaves the answer to email', async () => {
  const engine = fakeEngine({ m1: { text: ics(), method: 'REQUEST', accountId: 'acc1' } });
  const calendars = fakeCalendars({ id: 'acc1:dav:evt', canRespond: false });
  const res = await new Invitations({ engine, calendars, dataDir: dataDir() }).answer({ id: 'm1' }, 'declined');
  assert.equal(res.via, 'email');
  assert.equal(engine.sent[0].payload.subject, 'Declined: Planning');
});

test('cancellations, the user\'s own invitations and other methods are not answered', async () => {
  const engine = fakeEngine({
    gone: { text: ics({ method: 'CANCEL', status: 'CANCELLED' }), method: 'CANCEL', accountId: 'acc1' },
    own: { text: ics({ organizer: 'sanne@example.com' }), method: 'REQUEST', accountId: 'acc1' },
    pub: { text: ics({ method: 'PUBLISH' }), method: null, accountId: 'acc1' }
  });
  const inv = new Invitations({ engine, calendars: fakeCalendars(null), dataDir: dataDir() });
  for (const id of ['gone', 'own', 'pub']) await assert.rejects(inv.answer({ id }, 'accepted'), /can't answer this invitation/, id);
  await assert.rejects(inv.answer({ id: 'gone' }, 'maybe'));
  assert.equal(engine.sent.length, 0);
});

test('an .ics file is kept by token for its card, and its event is added to a chosen calendar', async () => {
  const dir = dataDir();
  const file = path.join(dir, 'Planning.ics');
  fs.writeFileSync(file, ics({ method: 'PUBLISH' }));
  const engine = fakeEngine({});
  const calendars = fakeCalendars(null);
  const inv = new Invitations({ engine, calendars, dataDir: dir });
  const token = inv.openFile(file);
  const state = await inv.state({ file: token });
  assert.equal(state.name, 'Planning.ics');
  assert.equal(state.invite.method, 'PUBLISH');
  // The file invites Sanne, so her account answers it.
  assert.deepEqual(state.account, { id: 'acc1', email: 'sanne@example.com' });
  const made = await inv.add({ file: token }, { accountId: 'acc1', calendarId: 'primary' });
  assert.equal(made.id, 'acc1:cal:new');
  assert.deepEqual(calendars.calls.create[0], {
    accountId: 'acc1',
    calendarId: 'primary',
    title: 'Planning',
    location: '',
    description: '',
    allDay: false,
    start: Date.UTC(2026, 10, 3, 9),
    end: Date.UTC(2026, 10, 3, 10),
    timeZone: 'UTC'
  });
  assert.deepEqual((await inv.state({ file: token })).added, { id: 'acc1:cal:new', start: Date.UTC(2026, 10, 3, 9) });
  // Not a calendar: refused with a message, and no token.
  fs.writeFileSync(file, 'not a calendar');
  assert.throws(() => inv.openFile(file), /can't read this calendar file/);
  await assert.rejects(inv.state({ file: 'unknown' }), /can't read this calendar file/);
});

test('a meeting that invites two of the user\'s accounts keeps an answer for each', async () => {
  const both = ics({ guests: ['sanne@example.com', 'sanne@work.example'] });
  const engine = fakeEngine({ home: { text: both, method: 'REQUEST', accountId: 'acc1' }, work: { text: both, method: 'REQUEST', accountId: 'acc2' } }, [SANNE, WORK]);
  const inv = new Invitations({ engine, calendars: fakeCalendars(null), dataDir: dataDir() });
  await inv.answer({ id: 'work' }, 'accepted');
  assert.equal(engine.sent[0].payload.from, 'sanne@work.example');
  assert.match(engine.sent[0].opts.icalEvent.content.replace(/\r\n /g, ''), /PARTSTAT=ACCEPTED;RSVP=TRUE:mailto:sanne@work.example|PARTSTAT=ACCEPTED:mailto:sanne@work.example/);
  assert.equal((await inv.state({ id: 'work' })).answered, 'accepted');
  assert.equal((await inv.state({ id: 'home' })).answered, null, 'the home address has not answered');
});

test('an .ics attachment keeps the account of its email, also when another account is invited too', async () => {
  const engine = fakeEngine({}, [SANNE, WORK]);
  const inv = new Invitations({ engine, calendars: fakeCalendars(null), dataDir: dataDir() });
  const token = inv.openText(ics({ guests: ['sanne@example.com', 'sanne@work.example'] }), 'invite.ics', 'acc2');
  const state = await inv.state({ file: token });
  assert.deepEqual(state.account, { id: 'acc2', email: 'sanne@work.example' });
  assert.equal(state.invite.me, 'sanne@work.example');
  await inv.answer({ file: token }, 'declined');
  assert.equal(engine.sent[0].payload.accountId, 'acc2');
});

test('an updated invitation asks again, also after its event was added to a calendar', async () => {
  const sources = { v0: { text: ics(), method: 'REQUEST', accountId: 'acc1' }, v1: { text: ics({ sequence: 1 }), method: 'REQUEST', accountId: 'acc1' } };
  const engine = fakeEngine(sources);
  const inv = new Invitations({ engine, calendars: fakeCalendars(null), dataDir: dataDir() });
  await inv.answer({ id: 'v0' }, 'accepted');
  assert.equal((await inv.state({ id: 'v0' })).answered, 'accepted');
  assert.equal((await inv.state({ id: 'v1' })).answered, null);
  await inv.add({ id: 'v1' }, { accountId: 'acc1', calendarId: 'primary' });
  const after = await inv.state({ id: 'v1' });
  assert.equal(after.answered, null, 'adding is no answer to the update');
  assert.equal(after.added.id, 'acc1:cal:new');
});
