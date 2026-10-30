// Calendar invitations in email and .ics files: the card in the reader, answering through the calendar or by email,
// adding the event to a calendar, and opening an .ics file with Rukoo. The real app with a throwaway profile and the
// demo account; invitations go in through the demo engine as Google sends them (nodemailer's icalEvent gives the same
// shape: a text/calendar alternative with its METHOD, and invite.ics). Mail that goes out is recorded, not sent.
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const MailComposer = require('nodemailer/lib/mail-composer');
const { tempDir, removeDir } = require('../tmp');
const { closeApp } = require('./close');

let app;
let win;
let dataDir;

const stamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

// An iCalendar object from Joris, inviting the demo user (and Sanne), in UTC.
function ics({ method = 'REQUEST', uid, title, start, end, status = 'CONFIRMED', sequence = 0 }) {
  return [
    'BEGIN:VCALENDAR',
    'PRODID:-//Google Inc//Google Calendar 70.9054//EN',
    'VERSION:2.0',
    `METHOD:${method}`,
    'BEGIN:VEVENT',
    `DTSTART:${stamp(start)}`,
    `DTEND:${stamp(end)}`,
    `DTSTAMP:${stamp(Date.now())}`,
    'ORGANIZER;CN=Joris Bakker:mailto:joris@example.com',
    `UID:${uid}`,
    'ATTENDEE;CN=Joris Bakker;PARTSTAT=ACCEPTED:mailto:joris@example.com',
    'ATTENDEE;CN=Demo User;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:demo@example.com',
    'ATTENDEE;CN=Sanne de Vries;PARTSTAT=ACCEPTED:mailto:sanne@example.com',
    `SEQUENCE:${sequence}`,
    `STATUS:${status}`,
    `SUMMARY:${title}`,
    'LOCATION:Room 4.12',
    'URL:https://meet.google.com/abc-defg-hij',
    'END:VEVENT',
    'END:VCALENDAR',
    ''
  ].join('\r\n');
}

async function invitation(subject, calendar) {
  const raw = await new MailComposer({
    from: 'Joris Bakker <joris@example.com>',
    to: 'demo@example.com',
    subject,
    date: new Date(),
    text: `${subject}\n\nJoris Bakker invited you.`,
    html: `<p>${subject}</p><p>Joris Bakker invited you.</p>`,
    icalEvent: { method: /METHOD:(\w+)/.exec(calendar)[1], content: calendar }
  })
    .compile()
    .build();
  await app.evaluate(async (_, mail) => {
    const engine = global.__semEngine;
    await engine.session(engine.accounts[0]).append('INBOX', mail);
    await engine.syncAll();
  }, raw.toString());
}

async function launch(args = []) {
  const env = { ...process.env, SEM_DATA_DIR: dataDir, SEM_HIDDEN: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: ['.', ...args], cwd: path.join(__dirname, '..', '..'), env });
  win = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1500, 950));
}

async function demo() {
  await win.waitForSelector('.provider-grid');
  await win.click('[data-s="demo"]');
  await expect(win.locator('.item').first()).toBeVisible({ timeout: 15000 });
  // Mail that would go out is kept here, and still delivered by the demo account (its Sent copy included).
  await app.evaluate(() => {
    const engine = global.__semEngine;
    const s = engine.session(engine.accounts[0]);
    const send = s.send.bind(s);
    global.__sent = [];
    s.send = async (mail) => {
      global.__sent.push({ to: mail.to, subject: mail.subject, icalEvent: mail.icalEvent || null });
      return send(mail);
    };
  });
}

// The demo calendar's invitation to the demo user: this week's Tuesday at 14:00, which may have passed.
const planning = () =>
  app.evaluate(async () => {
    const day = 86400000;
    const { events } = await global.__semCalendars.read({ start: Date.now() - 8 * day, end: Date.now() + 8 * day });
    const e = events.find((x) => x.title === 'Quarterly planning');
    return { uid: e.uid, start: e.start, end: e.end, response: e.response };
  });

const openMail = async (subject) => {
  await win.locator('.item', { hasText: subject }).first().click();
  await expect(win.locator('.reader-subject')).toHaveText(subject);
};
const card = () => win.locator('.reader .invite');
const sent = () => app.evaluate(() => global.__sent);

test.beforeEach(() => {
  dataDir = tempDir('rukoo-invite-e2e-');
});

test.afterEach(async () => {
  await closeApp(app);
  removeDir(dataDir);
});

test('an invitation that is in the calendar is answered there, and no email goes out', async () => {
  await launch();
  await demo();
  const e = await planning();
  expect(e.response).toBe('needsAction');
  await invitation('Invitation: Quarterly planning', ics({ uid: e.uid, title: 'Quarterly planning', start: e.start, end: e.end }));
  await openMail('Invitation: Quarterly planning');
  await expect(card().locator('.invite-kind')).toHaveText('Invitation from Joris Bakker');
  await expect(card().locator('.invite-title')).toHaveText('Quarterly planning');
  await expect(card().locator('.invite-row')).toContainText(['Room 4.12', '3 guests']);
  await expect(card().locator('.invite-note')).toHaveText('This event is in your calendar, which sends your answer to the organizer.');
  // The calendar part is the card; invite.ics stays an attachment.
  await expect(win.locator('.reader .att-name')).toHaveText(['invite.ics']);

  await card().locator('[data-invite-answer="accepted"]').click();
  await expect(win.locator('#toast')).toHaveText('Invitation accepted');
  await expect(card().locator('[data-invite-answer="accepted"]')).toHaveAttribute('aria-pressed', 'true');
  expect((await planning()).response).toBe('accepted');
  expect(await sent()).toEqual([]);

  await card().locator('[data-invite="open"]').click();
  await expect(win.locator('.cal-pop #cal-pop-title')).toHaveText('Quarterly planning');
});

test('an invitation no calendar has is answered by email, stays answered, and can be added to a calendar', async () => {
  await launch();
  await demo();
  const start = Date.now() + 3 * 86400000;
  await invitation('Invitation: Lunch talk', ics({ uid: 'lunch-talk-1@example.com', title: 'Lunch talk', start, end: start + 3600000 }));
  await openMail('Invitation: Lunch talk');
  await expect(card().locator('.invite-note')).toHaveText('Your answer goes to joris@example.com by email.');

  await card().locator('[data-invite-answer="tentative"]').click();
  await expect(win.locator('#toast')).toHaveText('Your answer went to joris@example.com');
  const [reply] = await sent();
  expect(reply.to).toEqual([{ name: 'Joris Bakker', address: 'joris@example.com' }]);
  expect(reply.subject).toBe('Tentatively accepted: Lunch talk');
  expect(reply.icalEvent.method).toBe('REPLY');
  expect(reply.icalEvent.content.replace(/\r\n /g, '')).toMatch(/ATTENDEE;CN=Demo User;PARTSTAT=TENTATIVE:mailto:demo@example\.com/);
  await expect(card().locator('[data-invite-answer="tentative"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(card().locator('.invite-note')).toHaveText('Your answer went to joris@example.com by email.');
  await expect(card().locator('.invite-row').last()).toHaveText('3 guests Joris Bakker (organizer), you, Sanne de Vries');

  // The answer is in Sent, and the card still shows it after another email was open.
  await win.locator('.nav-item[data-view="sent"]').click();
  await expect(win.locator('.item', { hasText: 'Tentatively accepted: Lunch talk' })).toHaveCount(1);
  await win.locator('.nav-item[data-view="inbox"]').first().click();
  await openMail('Invitation: Lunch talk');
  await expect(card().locator('[data-invite-answer="tentative"]')).toHaveAttribute('aria-pressed', 'true');

  await card().locator('[data-invite="add"]').click();
  await win.locator('.menu button', { hasText: 'Work' }).click();
  await expect(win.locator('#toast')).toHaveText('Added to Work');
  const added = await app.evaluate(async (_, at) => {
    const { events } = await global.__semCalendars.read({ start: at - 3600000, end: at + 7200000 });
    return events.filter((x) => x.title === 'Lunch talk').map((x) => ({ start: x.start, calendarId: x.calendarId }));
  }, start);
  expect(added).toEqual([{ start: Math.floor(start / 1000) * 1000, calendarId: 'work' }]);
  await expect(card().locator('[data-invite="open"]')).toBeVisible();
});

test('an invitation sent to a mailing list can be answered, as the account it came to', async () => {
  await launch();
  await demo();
  const start = Date.now() + 3 * 86400000;
  const list = ics({ uid: 'all-hands-1@example.com', title: 'All hands', start, end: start + 3600000 }).replace(
    'ATTENDEE;CN=Demo User;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:demo@example.com',
    'ATTENDEE;CN=Everyone;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:everyone@lists.example.com'
  );
  await invitation('Invitation: All hands', list);
  await openMail('Invitation: All hands');
  await expect(card().locator('.invite-note')).toHaveText('Your answer goes to joris@example.com by email.');
  await card().locator('[data-invite-answer="accepted"]').click();
  await expect(win.locator('#toast')).toHaveText('Your answer went to joris@example.com');
  const [reply] = await sent();
  expect(reply.icalEvent.content.replace(/\r\n /g, '')).toMatch(/ATTENDEE;CN=Demo User;PARTSTAT=ACCEPTED:mailto:demo@example\.com/);
});

test('a cancellation shows as cancelled, without answers', async () => {
  await launch();
  await demo();
  const start = Date.now() + 2 * 86400000;
  await invitation('Cancelled: Lunch talk', ics({ method: 'CANCEL', status: 'CANCELLED', sequence: 1, uid: 'lunch-talk-2@example.com', title: 'Lunch talk', start, end: start + 3600000 }));
  await openMail('Cancelled: Lunch talk');
  await expect(card()).toHaveClass(/cancelled/);
  await expect(card().locator('.invite-kind')).toHaveText('Cancelled by Joris Bakker');
  await expect(card().locator('.invite-pill')).toHaveText('Cancelled');
  await expect(card().locator('[data-invite-answer]')).toHaveCount(0);
  await expect(card().locator('[data-invite="add"]')).toHaveCount(0);
  await expect(card().locator('[data-invite="join"]')).toHaveCount(0);
});

test('an .ics file opens as a card: from a second start, and from an attachment', async () => {
  await launch();
  await demo();
  const start = Date.now() + 5 * 86400000;
  const file = path.join(dataDir, 'Concert.ics');
  fs.writeFileSync(file, ics({ method: 'PUBLISH', uid: 'concert-1@example.com', title: 'Concert', start, end: start + 7200000 }));
  // Windows starts a second Rukoo with the file, which hands it to this one.
  await app.evaluate(({ app }, [args, cwd]) => app.emit('second-instance', {}, args, cwd), [['Rukoo Mail.exe', '--', 'Concert.ics'], dataDir]);
  const dialog = win.locator('.scrim .dialog');
  await expect(dialog.locator('h2')).toHaveText('Calendar file');
  await expect(dialog.locator('.invite-kind')).toHaveText('Event');
  await expect(dialog.locator('.invite-title')).toHaveText('Concert');
  await expect(dialog.locator('[data-invite-answer]')).toHaveCount(0);
  await dialog.locator('[data-invite="add"]').click();
  await win.locator('.menu button', { hasText: 'Work' }).click();
  await expect(win.locator('#toast')).toHaveText('Added to Work');
  await expect(dialog.locator('.invite-note')).toHaveText('You added this event to your calendar.');
  await dialog.locator('[data-invite="open"]').click();
  await expect(dialog).toHaveCount(0);
  await expect(win.locator('.cal-pop #cal-pop-title')).toHaveText('Concert');

  // An invitation's invite.ics opens the same card in Rukoo, not in another app.
  await app.evaluate(({ shell }) => {
    shell.openPath = async () => {
      throw new Error('opened outside Rukoo');
    };
  });
  await win.keyboard.press('Escape');
  await win.locator('[data-mode="mail"], .mode-switch [data-mode="mail"]').first().click();
  await invitation('Invitation: Lunch talk', ics({ uid: 'lunch-talk-3@example.com', title: 'Lunch talk', start, end: start + 3600000 }));
  await openMail('Invitation: Lunch talk');
  await win.locator('.reader .att', { hasText: 'invite.ics' }).locator('[data-open-att]').click();
  await expect(dialog.locator('.invite-title')).toHaveText('Lunch talk');
  await expect(dialog.locator('.invite-kind')).toHaveText('Invitation from Joris Bakker');
});

test('Rukoo started with an .ics file shows its card once the window is up', async () => {
  const start = Date.now() + 86400000;
  const file = path.join(dataDir, 'Dentist.ics');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file, ics({ method: 'PUBLISH', uid: 'dentist-1@example.com', title: 'Dentist', start, end: start + 1800000 }));
  await launch(['--', file]);
  await expect(win.locator('.scrim .dialog .invite-title')).toHaveText('Dentist', { timeout: 15000 });
});
