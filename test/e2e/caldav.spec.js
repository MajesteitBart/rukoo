// An IMAP account gets its calendar from a CalDAV server entered in Server settings, in the real app. The CalDAV
// server is the test server in test/fixtures; the account's mail server doesn't exist, so mail stays empty.
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { tempDir, removeDir } = require('../tmp');
const { closeApp } = require('./close');
const { caldavServer } = require('../fixtures/caldav-server');

const ME = 'me@example.com';
let app;
let win;
let dataDir;
let server;

const pad = (n) => String(n).padStart(2, '0');
// A local day this week as an iCalendar date: 0 is Monday.
function day(n) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7) + n);
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}
const ics = (...lines) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN', 'BEGIN:VEVENT', 'DTSTAMP:20260101T000000Z', ...lines, 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');

test.beforeEach(async () => {
  // Floating times, so the events sit at these hours whatever the PC's time zone is.
  server = await caldavServer({
    scheduling: true,
    objects: {
      'home/standup.ics': ics('UID:standup', `DTSTART:${day(-14)}T093000`, `DTEND:${day(-14)}T094500`, 'RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', 'SUMMARY:Stand-up'),
      'home/review.ics': ics(
        'UID:review',
        `DTSTART:${day(2)}T140000`,
        `DTEND:${day(2)}T150000`,
        'SUMMARY:Design review',
        'ORGANIZER;CN=Joris Bakker:mailto:joris@example.com',
        'ATTENDEE;CN=Joris Bakker;PARTSTAT=ACCEPTED:mailto:joris@example.com',
        `ATTENDEE;CN=Me;PARTSTAT=NEEDS-ACTION:mailto:${ME}`
      ),
      'shared/offsite.ics': ics('UID:offsite', `DTSTART;VALUE=DATE:${day(3)}`, `DTEND;VALUE=DATE:${day(5)}`, 'SUMMARY:Team offsite')
    }
  });
  dataDir = tempDir('sem-e2e-caldav-');
  fs.mkdirSync(path.join(dataDir, 'data'));
  const unreachable = { host: '127.0.0.1', port: 1, secure: false, user: ME };
  fs.writeFileSync(
    path.join(dataDir, 'data', 'accounts.json'),
    JSON.stringify([{ id: 'c1', type: 'imap', provider: 'other', email: ME, name: 'Me', color: '#4a7dff', secret: 'secret', imap: unreachable, smtp: unreachable, createdAt: 1 }])
  );
  fs.writeFileSync(path.join(dataDir, 'data', 'settings.json'), JSON.stringify({ language: 'en', defaultAccountId: 'c1' }));
  const env = { ...process.env, SEM_DATA_DIR: dataDir, SEM_HIDDEN: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: ['.'], cwd: path.join(__dirname, '..', '..'), env });
  win = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1500, 950));
  await expect(win.locator('[data-mode="calendar"]')).toBeVisible({ timeout: 15000 });
});

test.afterEach(async () => {
  await closeApp(app);
  await server.close();
  removeDir(dataDir);
});

const event = (title) => win.locator('.calendar [data-ev]', { hasText: title }).first();
const card = () => win.locator('.cal-pop');

async function addCalendarServer(address) {
  await win.click('[data-action="settings"]');
  await win.click(`.settings .row:has-text("${ME}")`);
  await win.click('[data-a="acc-server"]');
  await expect(win.locator('.settings h1')).toHaveText('Server settings');
  const field = win.locator('[name="caldavUrl"]');
  await expect(field).toHaveAttribute('placeholder', 'Optional, for example caldav.example.com');
  await field.fill(address);
  await win.click('.settings button[type="submit"]');
}

test('a CalDAV server in Server settings brings the account calendar: read, create and answer', async () => {
  test.setTimeout(60000);
  // Without a calendar server, the calendar says where to add one.
  await win.click('[data-mode="calendar"]');
  await expect(win.locator('.calendar .empty')).toContainText('CalDAV server in their Server settings');

  // Plain http to another host is refused with the reason, and nothing is saved.
  await addCalendarServer('http://dav.example.com/');
  await expect(win.locator('.settings [data-error]')).toHaveText(/Use an https:\/\/ address/);
  await win.locator('[name="caldavUrl"]').fill(`${server.url}/`);
  await win.click('.settings button[type="submit"]');
  await expect(win.locator('#toast')).toHaveText('Server settings saved');
  // Back on the account page, the server row names the calendar server too.
  await expect(win.locator('.settings .row', { hasText: 'Server settings' })).toContainText(new URL(server.url).host);
  // Saving only checked the calendar server; the account's mail server doesn't exist and would have failed it.
  expect(server.requests.some((r) => r.method === 'PROPFIND')).toBe(true);
  await win.click('[data-a="back"]');
  await win.click('[data-a="back"]');
  await expect(win.locator('.settings')).toHaveCount(0);

  await expect(win.locator('.sidebar .cal-toggle')).toHaveCount(2);
  await expect(win.locator('.sidebar .cal-toggle', { hasText: 'Home' })).toBeVisible();
  await expect(win.locator('.sidebar .cal-toggle', { hasText: 'Shared with me' })).toBeVisible();
  await expect(event('Stand-up')).toBeVisible({ timeout: 10000 });
  await expect(win.locator('.calendar [data-ev]', { hasText: 'Stand-up' })).toHaveCount(5);
  await expect(event('Team offsite')).toBeVisible();
  // Each calendar shows in the colour the server gives it (calendar-color), not in the account's.
  const colour = (locator) => locator.evaluate((el) => el.style.getPropertyValue('--c'));
  expect(await colour(event('Stand-up'))).toBe('#7b61ff');
  expect(await colour(event('Team offsite'))).toBe('#16a765');
  expect(await colour(win.locator('.sidebar .cal-toggle', { hasText: 'Home' }).locator('.cal-check'))).toBe('#7b61ff');

  // An invitation: answered on the server, which tells the organizer.
  await event('Design review').click();
  await expect(card()).toContainText('Joris Bakker');
  await expect(card().locator('[data-pop="edit"]')).toHaveCount(0);
  await card().locator('[data-rsvp="accepted"]').click();
  await expect(win.locator('#toast')).toHaveText('Invitation accepted');
  expect(server.object('home/review.ics').data).toContain(`PARTSTAT=ACCEPTED:mailto:${ME}`);
  await win.keyboard.press('Escape');

  // A new event goes to the first calendar that takes events.
  await win.click('[data-cal="new"]');
  await expect(win.locator('.cal-form [name="calendar"] option:checked')).toHaveText('Home');
  await win.fill('.cal-form [name="title"]', 'Dentist');
  await win.click('.dialog .buttons button.primary');
  await expect(win.locator('#toast')).toHaveText('Event created');
  await expect(event('Dentist')).toBeVisible();
  const made = server.names().find((n) => n.startsWith('home/') && !['home/standup.ics', 'home/review.ics'].includes(n));
  expect(server.object(made).data).toContain('SUMMARY:Dentist');

  // The shared calendar's event can't be changed.
  await event('Team offsite').click();
  await expect(card().locator('[data-pop="edit"]')).toHaveCount(0);
  await expect(card().locator('[data-pop="delete"]')).toHaveCount(0);
  await win.keyboard.press('Escape');

  // The password changed at the provider: the calendar says so and leads to Server settings.
  server.setPassword('changed');
  await win.click('[data-cal="sync"]');
  const notice = win.locator('.cal-notice.error');
  await expect(notice).toContainText('turned down the username or password', { timeout: 10000 });
  await notice.locator('[data-cal-server]').click();
  await expect(win.locator('.settings h1')).toHaveText('Server settings');
  await expect(win.locator('[name="caldavUrl"]')).toHaveValue(`${server.url}/`);
  await win.click('[data-a="back"]');
  await expect(win.locator('.settings h1')).toHaveText(ME);
});

test('two occurrences of a series changed one after the other both save, without a conflict', async () => {
  test.setTimeout(60000);
  await win.click('[data-mode="calendar"]');
  await addCalendarServer(`${server.url}/`);
  await expect(win.locator('#toast')).toHaveText('Server settings saved');
  await win.click('[data-a="back"]');
  await win.click('[data-a="back"]');
  await expect(win.locator('.calendar [data-ev]', { hasText: 'Stand-up' })).toHaveCount(5, { timeout: 10000 });

  // The occurrences still called just Stand-up; an event's text holds its time as well, so its title is matched.
  const plain = () => win.locator('.calendar [data-ev]').filter({ has: win.locator('.t', { hasText: /^Stand-up$/ }) });
  const rename = async (occurrence, title) => {
    await occurrence.click();
    await card().locator('[data-pop="edit"]').click();
    await expect(win.locator('.cal-form .note')).toBeVisible();
    await win.fill('.cal-form [name="title"]', title);
    await win.click('.dialog .buttons button.primary');
    // Saved: the dialog closes, without saying the event changed elsewhere.
    await expect(win.locator('.dialog')).toHaveCount(0);
    await expect(event(title)).toBeVisible();
  };
  await expect(plain()).toHaveCount(5);
  await rename(plain().nth(0), 'Stand-up one');
  await rename(plain().nth(1), 'Stand-up two');
  // Then one occurrence is deleted, again without a sync in between, and after that another one changed.
  await plain().first().click();
  await win.keyboard.press('Delete');
  await win.locator('.radio-row', { hasText: 'This event' }).click();
  await expect(win.locator('#toast')).toHaveText('Event deleted');
  await expect(plain()).toHaveCount(2);
  await rename(plain().first(), 'Stand-up three');
  const data = server.object('home/standup.ics').data;
  expect(data).toContain('SUMMARY:Stand-up one');
  expect(data).toContain('SUMMARY:Stand-up two');
  expect(data).toContain('SUMMARY:Stand-up three');
  expect(data).toMatch(/EXDATE/);
  // Every change went out on the version the one before it made: none was refused.
  expect(server.requests.filter((r) => r.method === 'PUT').length).toBe(4);
});
