// Server settings say who emails the invitations for a CalDAV calendar, in the real app: the server's own answer
// (its DAV header), or the user's when the server gets it wrong. A meeting with guests can only be changed where the
// server sends them. The CalDAV server is the test server in test/fixtures; the mail server doesn't exist.
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { tempDir, removeDir } = require('../tmp');
const { closeApp } = require('./close');
const { caldavServer } = require('../fixtures/caldav-server');

const ME = 'me@example.com';
let server;
let runs = [];

const pad = (n) => String(n).padStart(2, '0');
// A local day this week as an iCalendar date: 0 is Monday.
function day(n) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7) + n);
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}
const ics = (...lines) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN', 'BEGIN:VEVENT', 'DTSTAMP:20260101T000000Z', ...lines, 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');

async function launch(language = 'en') {
  const dataDir = tempDir('sem-e2e-caldav-invites-');
  fs.mkdirSync(path.join(dataDir, 'data'));
  const unreachable = { host: '127.0.0.1', port: 1, secure: false, user: ME };
  fs.writeFileSync(
    path.join(dataDir, 'data', 'accounts.json'),
    JSON.stringify([{ id: 'c1', type: 'imap', provider: 'other', email: ME, name: 'Me', color: '#4a7dff', secret: 'secret', imap: unreachable, smtp: unreachable, caldav: { url: `${server.url}/`, home: server.home }, createdAt: 1 }])
  );
  fs.writeFileSync(path.join(dataDir, 'data', 'settings.json'), JSON.stringify({ language, defaultAccountId: 'c1' }));
  const env = { ...process.env, SEM_DATA_DIR: dataDir, SEM_HIDDEN: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: ['.'], cwd: path.join(__dirname, '..', '..'), env });
  runs.push({ app, dataDir });
  const win = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1200, 860));
  await expect(win.locator('[data-mode="calendar"]')).toBeVisible({ timeout: 15000 });
  return { app, win, dataDir };
}

test.beforeEach(async () => {
  // Floating times, so the meeting sits at this hour whatever the PC's time zone is.
  server = await caldavServer({
    scheduling: true,
    objects: {
      'home/review.ics': ics('UID:review', `DTSTART:${day(2)}T140000`, `DTEND:${day(2)}T150000`, 'SUMMARY:Design review', `ORGANIZER;CN=Me:mailto:${ME}`, `ATTENDEE;CN=Me;PARTSTAT=ACCEPTED:mailto:${ME}`, 'ATTENDEE;CN=Joris Bakker;PARTSTAT=ACCEPTED:mailto:joris@example.com')
    }
  });
});

test.afterEach(async () => {
  for (const { app, dataDir } of runs) {
    await closeApp(app);
    removeDir(dataDir);
  }
  runs = [];
  await server.close();
});

async function serverSettings(win) {
  await win.click('[data-action="settings"]');
  await win.click(`.settings .row:has-text("${ME}")`);
  await win.click('[data-a="acc-server"]');
  await expect(win.locator('[name="caldavInvites"]')).toBeVisible();
}

test('the invitations choice in Server settings decides whether a meeting with guests can be changed', async () => {
  const { win, dataDir } = await launch();
  const accounts = () => JSON.parse(fs.readFileSync(path.join(dataDir, 'data', 'accounts.json'), 'utf8'))[0];
  const event = win.locator('.calendar [data-ev]', { hasText: 'Design review' }).first();
  const card = win.locator('.cal-pop');
  await win.click('[data-mode="calendar"]');
  await expect(event).toBeVisible({ timeout: 10000 });
  await event.click();
  // The server says it sends invitations: the user's meeting with a guest can be changed.
  await expect(card.locator('[data-pop="edit"]')).toBeVisible();
  await win.keyboard.press('Escape');

  // The first option is the server's own answer, read from its calendars.
  await serverSettings(win);
  const select = win.locator('[name="caldavInvites"]');
  await expect(select).toHaveValue('');
  await expect(select.locator('option[value=""]')).toHaveText('Automatic: the server sends them');
  await select.selectOption('none');
  await win.click('.settings button[type="submit"]');
  await expect(win.locator('#toast')).toHaveText('Server settings saved');
  expect(accounts().caldavInvites).toBe('none');
  // Opened again, the form shows the user's choice.
  await win.click('[data-a="acc-server"]');
  await expect(select).toHaveValue('none');
  await expect(select.locator('option[value=""]')).toHaveText('Automatic');
  for (let i = 0; i < 3; i++) await win.click('[data-a="back"]');

  // The calendars are read again with the user's answer: the meeting with a guest stays as it is.
  await win.click('[data-mode="calendar"]');
  await expect(event).toBeVisible({ timeout: 10000 });
  await event.click();
  await expect(card).toContainText('Joris Bakker');
  await expect(card.locator('[data-pop="edit"]')).toHaveCount(0);
  await win.keyboard.press('Escape');

  // Back to what the server says: the override goes from the account.
  await serverSettings(win);
  await select.selectOption('');
  await win.click('.settings button[type="submit"]');
  await expect(win.locator('#toast')).toHaveText('Server settings saved');
  expect(accounts().caldavInvites).toBeUndefined();
});

test('the invitations choice is in Dutch with the rest of Server settings', async () => {
  const { win } = await launch('nl');
  await win.click('[data-mode="calendar"]');
  await expect(win.locator('.calendar [data-ev]').first()).toBeVisible({ timeout: 10000 });
  await serverSettings(win);
  const select = win.locator('[name="caldavInvites"]');
  await expect(select.locator('option[value=""]')).toHaveText('Automatisch: de server verstuurt ze');
  await expect(select.locator('option')).toHaveText(['Automatisch: de server verstuurt ze', 'De server verstuurt ze', 'De server verstuurt ze niet']);
});
