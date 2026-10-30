'use strict';

// The calendar store's side of invitations by email (calendar/invitations.js): finding the event an invitation is
// about by its UID, for the right account and address, and answering it outside the weeks the view has cached.
const test = require('node:test');
const assert = require('node:assert/strict');
const { fakeCalendar, setup, settle, monday, at, iso, DAY } = require('./fixtures/google-calendar');

const theirs = { organizer: { email: 'joris@example.com' }, attendees: [{ email: 'joris@example.com', organizer: true }, { email: 'me@example.com', self: true, responseStatus: 'needsAction' }] };

test('an invitation months ahead is found by its UID for its own account, and answered through Google', async () => {
  const m = monday();
  const start = at(m, 90, 9).getTime();
  const fake = fakeCalendar({
    events: [
      { id: 'evt90', iCalUID: 'planning-1@example.com', summary: 'Planning', start: { dateTime: iso(at(m, 90, 9)) }, end: { dateTime: iso(at(m, 90, 10)) }, ...theirs },
      { id: 'other', summary: 'Something else', start: { dateTime: iso(at(m, 90, 9)) }, end: { dateTime: iso(at(m, 90, 10)) }, ...theirs },
      // The same meeting in a team calendar the account sees, where the team's address is the guest.
      {
        id: 'team90',
        calendarId: 'team@example.com',
        iCalUID: 'planning-1@example.com',
        summary: 'Planning',
        start: { dateTime: iso(at(m, 90, 9)) },
        end: { dateTime: iso(at(m, 90, 10)) },
        organizer: { email: 'joris@example.com' },
        attendees: [{ email: 'joris@example.com', organizer: true }, { email: 'team@example.com', self: true, responseStatus: 'needsAction' }]
      }
    ]
  });
  const { calendars } = setup(fake);
  calendars.view({ start: m, end: m + 7 * DAY });
  await settle(calendars);
  const query = { uid: 'planning-1@example.com', start, end: start + 3600000, organizer: 'Joris@Example.com' };

  const found = await calendars.findInvite({ ...query, accountId: 'g1', me: 'Me@Example.com' });
  assert.equal(found.eventId, 'evt90');
  assert.equal(found.calendarId, 'me@example.com', "not the team calendar, where the answer would be the team's");
  const team = await calendars.findInvite({ ...query, accountId: 'g1', me: 'team@example.com' });
  assert.equal(team && team.eventId, 'team90');
  assert.equal(found.canRespond, true);
  assert.equal((await calendars.findInvite({ ...query, me: 'me@example.com' })).eventId, 'evt90', 'by the invited address');
  assert.equal(await calendars.findInvite({ ...query, accountId: 'other-account' }), null, 'not for another account');
  assert.equal(await calendars.findInvite({ ...query, me: 'someone@example.com' }), null, 'not for another address');
  assert.equal(await calendars.findInvite({ ...query, uid: 'nope@example.com', accountId: 'g1' }), null);
  // A forged email with the meeting's UID but another organizer doesn't stand for it.
  assert.equal(await calendars.findInvite({ ...query, accountId: 'g1', me: 'me@example.com', organizer: 'mallory@example.com' }), null);
  assert.equal(await calendars.findInvite({ ...query, accountId: 'g1', me: 'me@example.com', organizer: null }), null);
  assert.equal(calendars.cache('g1').events.some((e) => e.eventId === 'evt90'), false, 'outside the cached weeks');

  // Answering it works although the view never showed that week, and Google tells the organizer.
  await calendars.respond(found.id, 'accepted');
  const patch = fake.requests.find((r) => r.method === 'PATCH');
  assert.match(patch.path, /evt90$/);
  assert.equal(patch.query.sendUpdates, 'all');
  assert.deepEqual(patch.body.attendees.map((a) => [a.email, a.responseStatus]), [['me@example.com', 'accepted']]);
});
