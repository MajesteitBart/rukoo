'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { simpleParser } = require('mailparser');
const MailComposer = require('nodemailer/lib/mail-composer');
const { calendarPart, readInvite, replyText } = require('../src/main/calendar/invite');
const { icsFromArgs } = require('../src/main/desktop');

const ZONE = [
  'BEGIN:VTIMEZONE',
  'TZID:Europe/Amsterdam',
  'BEGIN:STANDARD',
  'TZOFFSETFROM:+0200',
  'TZOFFSETTO:+0100',
  'DTSTART:19701025T030000',
  'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU',
  'END:STANDARD',
  'BEGIN:DAYLIGHT',
  'TZOFFSETFROM:+0100',
  'TZOFFSETTO:+0200',
  'DTSTART:19700329T020000',
  'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU',
  'END:DAYLIGHT',
  'END:VTIMEZONE'
];

// An invitation as Google Calendar sends it: the organizer has accepted, the user hasn't answered yet.
function ics({ method = 'REQUEST', uid = 'abc123@google.com', sequence = 1, extra = [], event = [], status = 'CONFIRMED' } = {}) {
  return [
    'BEGIN:VCALENDAR',
    'PRODID:-//Google Inc//Google Calendar 70.9054//EN',
    'VERSION:2.0',
    `METHOD:${method}`,
    ...ZONE,
    'BEGIN:VEVENT',
    'DTSTART;TZID=Europe/Amsterdam:20261030T130000',
    'DTEND;TZID=Europe/Amsterdam:20261030T140000',
    'DTSTAMP:20261029T153400Z',
    'ORGANIZER;CN=Daniel Schafrat:mailto:daniel@example.com',
    `UID:${uid}`,
    'ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;RSVP=TRUE;CN=Daniel Schafrat:mailto:daniel@example.com',
    'ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN=bart@example.com:mailto:bart@example.com',
    `SEQUENCE:${sequence}`,
    `STATUS:${status}`,
    'SUMMARY:Cycle 16: agents & demo account',
    'LOCATION:Room 4',
    ...event,
    'END:VEVENT',
    ...extra,
    'END:VCALENDAR',
    ''
  ].join('\r\n');
}

test('an invitation reads as its event, its organizer and the user among the guests', () => {
  const inv = readInvite(ics(), { me: ['Bart@Example.com'] });
  assert.equal(inv.method, 'REQUEST');
  assert.equal(inv.uid, 'abc123@google.com');
  assert.equal(inv.sequence, 1);
  assert.equal(inv.title, 'Cycle 16: agents & demo account');
  assert.equal(inv.location, 'Room 4');
  assert.equal(inv.start, Date.UTC(2026, 9, 30, 12));
  assert.equal(inv.end, Date.UTC(2026, 9, 30, 13));
  assert.equal(inv.timeZone, 'Europe/Amsterdam');
  assert.deepEqual(inv.organizer, { name: 'Daniel Schafrat', address: 'daniel@example.com', self: false });
  assert.equal(inv.me, 'bart@example.com');
  assert.equal(inv.response, 'needsAction');
  assert.equal(inv.series, false);
  assert.equal(inv.rid, null);
  assert.equal(inv.cancelled, false);
  // Someone else's copy: no place among the guests.
  assert.equal(readInvite(ics(), { me: ['someone@example.com'] }).me, null);
});

test('the METHOD of the email part wins; a cancellation still shows what was cancelled', () => {
  assert.equal(readInvite(ics({ method: 'PUBLISH' }), { method: 'request' }).method, 'REQUEST');
  const gone = readInvite(ics({ method: 'CANCEL', status: 'CANCELLED', sequence: 2 }), { me: ['bart@example.com'] });
  assert.equal(gone.method, 'CANCEL');
  assert.equal(gone.cancelled, true);
  assert.equal(gone.title, 'Cycle 16: agents & demo account');
});

test('a series starts at its first occurrence, with its rule; one occurrence carries its original start', () => {
  const series = readInvite(ics({ event: ['RRULE:FREQ=WEEKLY;BYDAY=FR;COUNT=4'] }));
  assert.equal(series.series, true);
  assert.equal(series.rule, 'FREQ=WEEKLY;COUNT=4;BYDAY=FR');
  assert.equal(series.start, Date.UTC(2026, 9, 30, 12));
  const one = readInvite(ics({ event: ['RECURRENCE-ID;TZID=Europe/Amsterdam:20261106T130000'] }));
  assert.equal(one.rid, Date.UTC(2026, 10, 6, 12));
  assert.equal(one.series, false);
});

test('text that is no calendar, or a calendar without an event, is no invitation', () => {
  assert.equal(readInvite('hello'), null);
  assert.equal(readInvite(''), null);
  assert.equal(readInvite('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n'), null);
  assert.equal(readInvite('x'.repeat(2 * 1024 * 1024)), null);
});

test('the reply names the user as the one guest, with the answer, and keeps the event as the organizer knows it', () => {
  const text = replyText(ics({ event: ['RECURRENCE-ID;TZID=Europe/Amsterdam:20261030T130000'] }), {
    address: 'bart@example.com',
    response: 'tentative',
    now: Date.UTC(2026, 9, 30, 8)
  });
  const lines = text.replace(/\r\n /g, '').split('\r\n');
  assert.ok(lines.includes('METHOD:REPLY'));
  assert.ok(lines.includes('UID:abc123@google.com'));
  assert.ok(lines.includes('SEQUENCE:1'));
  assert.ok(lines.includes('RECURRENCE-ID;TZID=Europe/Amsterdam:20261030T130000'));
  assert.ok(lines.includes('DTSTAMP:20261030T080000Z'));
  assert.ok(lines.includes('ORGANIZER;CN=Daniel Schafrat:mailto:daniel@example.com'));
  assert.ok(lines.includes('TZID:Europe/Amsterdam'), 'the zone its times name');
  const guests = lines.filter((l) => l.startsWith('ATTENDEE'));
  assert.equal(guests.length, 1);
  assert.match(guests[0], /PARTSTAT=TENTATIVE/);
  assert.match(guests[0], /mailto:bart@example\.com$/);
  assert.doesNotMatch(guests[0], /RSVP/);
  assert.equal(readInvite(text, { me: ['bart@example.com'] }).response, 'tentative');
});

test('a user invited through a list answers with their own address', () => {
  const text = replyText(ics(), { address: 'team-member@example.com', name: 'Team Member', response: 'declined' });
  const guest = text.replace(/\r\n /g, '').split('\r\n').find((l) => l.startsWith('ATTENDEE'));
  assert.equal(guest, 'ATTENDEE;CN=Team Member;PARTSTAT=DECLINED:mailto:team-member@example.com');
  assert.throws(() => replyText(ics(), { address: 'a@example.com', response: 'maybe' }));
});

test('in an email, the body part says the method and stays out of the attachments; invite.ics stays listed', async () => {
  // How Google sends it: text, HTML and the calendar as alternatives, and the same calendar as invite.ics.
  const raw = await new MailComposer({
    from: 'daniel@example.com',
    to: 'bart@example.com',
    subject: 'Invitation',
    text: 'You are invited',
    html: '<p>You are invited</p>',
    icalEvent: { method: 'REQUEST', content: ics() },
    attachments: [{ filename: 'agenda.pdf', content: Buffer.from('%PDF-1.4') }]
  })
    .compile()
    .build();
  const parsed = await simpleParser(raw);
  const part = calendarPart(parsed.attachments);
  const at = (i) => parsed.attachments[i];
  assert.equal(part.method, 'REQUEST');
  assert.equal(at(part.index).contentType, 'text/calendar');
  assert.deepEqual(part.hidden, [part.index]);
  assert.ok(parsed.attachments.some((a, i) => a.filename === 'invite.ics' && !part.hidden.includes(i)));
  assert.equal(calendarPart([{ contentType: 'application/pdf', filename: 'a.pdf' }]), null);
  // Only an .ics attachment, as some booking systems send: that file is the invitation, and stays listed.
  assert.deepEqual(calendarPart([{ contentType: 'application/octet-stream', filename: 'Meeting.ICS', contentDisposition: 'attachment' }]), { index: 0, method: null, hidden: [] });
});

test('the .ics file Rukoo is started with: a path or file URL, never a switch', () => {
  const files = new Set(['C:\\Users\\me\\Downloads\\invite.ics', '/home/me/invite.ics', 'C:\\Work\\team.ICS']);
  const isFile = (f) => files.has(f);
  if (process.platform === 'win32') {
    assert.equal(icsFromArgs(['Rukoo Mail.exe', '--', 'C:\\Users\\me\\Downloads\\invite.ics'], 'C:\\', isFile), 'C:\\Users\\me\\Downloads\\invite.ics');
    assert.equal(icsFromArgs(['electron.exe', '.', 'team.ICS'], 'C:\\Work', isFile), 'C:\\Work\\team.ICS');
    assert.equal(icsFromArgs(['Rukoo Mail.exe', 'file:///C:/Users/me/Downloads/invite.ics'], 'C:\\', isFile), 'C:\\Users\\me\\Downloads\\invite.ics');
  } else {
    assert.equal(icsFromArgs(['rukoo-mail', 'file:///home/me/invite.ics'], '/', isFile), '/home/me/invite.ics');
  }
  assert.equal(icsFromArgs(['Rukoo Mail.exe', '--flag=x.ics', '--', 'mailto:a@example.com'], 'C:\\', () => true), null);
  assert.equal(icsFromArgs(['Rukoo Mail.exe', 'missing.ics'], 'C:\\', isFile), null);
  assert.equal(icsFromArgs(['Rukoo Mail.exe'], 'C:\\', isFile), null);
});

test('a value that only breaks when read makes no invitation, and throws nothing', () => {
  const broken = ics().replace('DTSTART;TZID=Europe/Amsterdam:20261030T130000', 'DTSTART:bad');
  assert.equal(readInvite(broken, { me: ['bart@example.com'] }), null);
});

test('a series with one occurrence called off is still an invitation, and that occurrence stays out', () => {
  const text = ics({
    event: ['RRULE:FREQ=WEEKLY;BYDAY=FR;COUNT=4'],
    extra: [
      'BEGIN:VEVENT',
      'UID:abc123@google.com',
      'RECURRENCE-ID;TZID=Europe/Amsterdam:20261030T130000',
      'DTSTART;TZID=Europe/Amsterdam:20261030T130000',
      'DTEND;TZID=Europe/Amsterdam:20261030T140000',
      'SUMMARY:Cycle 16: agents & demo account',
      'STATUS:CANCELLED',
      'SEQUENCE:1',
      'END:VEVENT'
    ]
  });
  const inv = readInvite(text, { me: ['bart@example.com'] });
  assert.equal(inv.cancelled, false);
  assert.equal(inv.series, true);
  // The first occurrence was called off, so the card starts at the next one.
  assert.equal(inv.start, Date.UTC(2026, 10, 6, 12));
  // Cancelling that one occurrence on its own is a cancellation of it.
  const one = readInvite(text.replace('METHOD:REQUEST', 'METHOD:CANCEL').replace(/BEGIN:VEVENT[\s\S]*?END:VEVENT\r\n/, ''), {});
  assert.equal(one.cancelled, true);
  assert.equal(one.rid, Date.UTC(2026, 9, 30, 12));
});

test('a cancelled series whose occurrences were all called off one by one still shows what was cancelled', () => {
  const exception = (day) => [
    'BEGIN:VEVENT',
    'UID:abc123@google.com',
    `RECURRENCE-ID;TZID=Europe/Amsterdam:202610${day}T130000`,
    `DTSTART;TZID=Europe/Amsterdam:202610${day}T130000`,
    `DTEND;TZID=Europe/Amsterdam:202610${day}T140000`,
    'SUMMARY:Cycle 16: agents & demo account',
    'STATUS:CANCELLED',
    'END:VEVENT'
  ];
  const text = ics({ method: 'CANCEL', status: 'CANCELLED', event: ['RRULE:FREQ=DAILY;COUNT=2'], extra: [...exception('30'), ...exception('31')] });
  const inv = readInvite(text, { me: ['bart@example.com'] });
  assert.equal(inv.cancelled, true);
  assert.equal(inv.title, 'Cycle 16: agents & demo account');
  assert.equal(inv.start, Date.UTC(2026, 9, 30, 12));
});
