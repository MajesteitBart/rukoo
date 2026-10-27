// The availability panel beside the calendar and Settings > Calendar, in the real app on the demo account: the open
// time main works out, shown by day and on the grid, copied as text; and the week, working hours and calendars set in
// Settings, kept across a reload and followed by the grid.
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { tempDir, removeDir } = require('../tmp');
const { closeApp } = require('./close');

let app;
let win;
let dataDir;

async function launch() {
  const env = { ...process.env, SEM_DATA_DIR: dataDir, SEM_HIDDEN: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: ['.'], cwd: path.join(__dirname, '..', '..'), env });
  win = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1500, 950));
}

test.beforeEach(async () => {
  dataDir = tempDir('rukoo-free-e2e-');
  await launch();
  await win.waitForSelector('.provider-grid');
  await win.click('[data-s="demo"]');
  await expect(win.locator('.item').first()).toBeVisible({ timeout: 15000 });
});

test.afterEach(async () => {
  await closeApp(app);
  removeDir(dataDir);
});

const panel = () => win.locator('.calendar .cal-panel');
const settingsPage = () => win.locator('.page.settings');
const calendarState = () => win.evaluate(() => window.mail.call('state').then((s) => s.settings.calendar));
const clipboard = () => app.evaluate(({ clipboard }) => clipboard.readText());

async function openCalendar() {
  await win.click('[data-mode="calendar"]');
  await expect(win.locator('.calendar [data-ev]').first()).toBeVisible({ timeout: 10000 });
}

// The panel on the next 14 days, so a test run on a weekend evening still finds working hours ahead.
async function openPanel() {
  await win.click('[data-cal-panel="free"]');
  await expect(panel().locator('h2')).toHaveText('Availability');
  await panel().locator('[data-free="range"]').selectOption('days14');
  await expect(panel().locator('.free-slot').first()).toBeVisible({ timeout: 10000 });
  await expect(panel().locator('.free-days')).not.toHaveClass(/busy/);
}

// The times of each day in the panel, as main's lines write them ("09:00–09:30, 11:30–12:30").
const panelTimes = () =>
  panel()
    .locator('.free-day')
    .evaluateAll((days) => days.map((d) => [...d.querySelectorAll('.free-time')].map((x) => x.textContent.replace(/\s/g, '')).join(',')));

test('the panel lists open time from main by day, shows it on the grid and copies it as text', async () => {
  await openCalendar();
  await openPanel();
  // The demo account's own calendars count; the read-only birthdays don't.
  const counted = await win.evaluate(() => window.mail.call('calendarList').then((list) => list.flatMap((a) => a.calendars).filter((c) => c.availability).length));
  expect(counted).toBe(2);
  await expect(panel().locator('[data-free-act="checked"]')).toHaveText('Checked: 2 calendars');
  await panel().locator('[data-free-act="checked"]').click();
  await expect(panel().locator('.free-checked li')).toHaveCount(3);
  await expect(panel().locator('.free-checked')).toContainText('Work');
  await expect(panel().locator('.free-checked')).not.toContainText('Birthdays');

  // Copy as text: main's lines and the zone, which are the same times the panel shows.
  await panel().locator('[data-free-act="copy"]').click();
  await expect(win.locator('#toast')).toHaveText('Open times copied');
  const text = await clipboard();
  const lines = text.split('\n');
  const zone = await win.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  expect(lines.pop()).toBe(`Times in ${zone}`);
  expect(lines.length).toBeGreaterThan(2);
  expect(lines.map((l) => l.replace(/^[^:]*: /, '').replace(/\s/g, ''))).toEqual(await panelTimes());

  // A click on an open time takes the grid to that day, where the open time shows in green.
  const first = panel().locator('.free-slot').first();
  const day = new Date(Number(await first.getAttribute('data-free-day')));
  day.setHours(0, 0, 0, 0);
  await first.click();
  await expect(win.locator(`.cal-col[data-cal-col="${day.getTime()}"] .cal-hl`).first()).toBeVisible();
  // Closing the panel takes the highlight away.
  await panel().locator('[data-cal="panel-close"]').click();
  await expect(win.locator('.cal-hl')).toHaveCount(0);
});

test('length and hours ask main again', async () => {
  await openCalendar();
  await openPanel();
  const before = await panelTimes();
  // Every open time is at least as long as the chosen length.
  await panel().locator('[data-free-length="90"]').click();
  await expect(panel().locator('[data-free-length="90"]')).toHaveAttribute('aria-checked', 'true');
  await expect(panel().locator('.free-days')).not.toHaveClass(/busy/);
  await expect.poll(panelTimes).not.toEqual(before);
  const minutes = await panel()
    .locator('.free-time')
    .evaluateAll((list) =>
      list.map((x) => {
        const [a, b] = x.textContent.split('–').map((s) => s.trim().split(':').map(Number));
        return (b[0] * 60 + b[1]) - (a[0] * 60 + a[1]);
      })
    );
  expect(minutes.length).toBeGreaterThan(0);
  for (const m of minutes) expect(m).toBeGreaterThanOrEqual(90);
  // Any time opens the evenings: some open time now runs to midnight.
  await panel().locator('[data-free="hours"]').selectOption('any');
  await expect.poll(() => panel().locator('.free-time', { hasText: '24:00' }).count()).toBeGreaterThan(0);
  // The choices are kept for the next time the panel opens.
  await panel().locator('[data-cal="panel-close"]').click();
  await win.click('[data-cal-panel="free"]');
  await expect(panel().locator('[data-free-length="90"]')).toHaveAttribute('aria-checked', 'true');
  await expect(panel().locator('[data-free="hours"]')).toHaveValue('any');
  await expect(panel().locator('[data-free="range"]')).toHaveValue('days14');
});

test('accounts that could not be read are named, all-day events show under their day, and text stays text', async () => {
  await openCalendar();
  // main's answer, with a failed account and an all-day event whose title is markup.
  await app.evaluate(({ BrowserWindow, ipcMain }) => {
    const original = ipcMain._invokeHandlers.get('mail:call');
    BrowserWindow.getAllWindows()[0].webContents.ipc.handle('mail:call', async (event, method, args) => {
      const answer = await original(event, method, args);
      if (method !== 'calendarFree' || !answer.ok) return answer;
      const first = answer.result.windows[0];
      const d = new Date(first[0]);
      const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
      const end = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}-${String(next.getDate()).padStart(2, '0')}`;
      answer.result.failed = [{ accountId: 'x', email: 'work@example.com', code: 'network' }];
      answer.result.allDay = [{ id: 'h', accountId: 'x', calendarId: 'c', startDate: date, endDate: end, title: '<img src=x onerror="window.__pwned=1">Holiday', busy: false }];
      return answer;
    });
  });
  await openPanel();
  await expect(panel().locator('.free-note.warn')).toHaveText("Couldn't check work@example.com. These times may be wrong.");
  const allDay = panel().locator('.free-day').first().locator('.free-allday');
  await expect(allDay).toHaveText('All day: <img src=x onerror="window.__pwned=1">Holiday');
  await expect(panel().locator('img')).toHaveCount(0);
  expect(await win.evaluate(() => window.__pwned)).toBeUndefined();
});

test('Settings → Calendar opens from the reminders notice, and its choices persist and change the grid', async () => {
  // The one-time notice shows on a profile from before reminders: Rukoo again on settings without its flag.
  await closeApp(app);
  const file = path.join(dataDir, 'data', 'settings.json');
  const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete settings.calendar.notifiedUpgrade;
  fs.writeFileSync(file, JSON.stringify(settings));
  await launch();
  await expect(win.locator('.item').first()).toBeVisible({ timeout: 15000 });
  await openCalendar();
  // Its Open settings leads to this page, not a blank one.
  await win.locator('.cal-notice', { hasText: 'Rukoo now reminds you' }).locator('button', { hasText: 'Open settings' }).click();
  await expect(settingsPage().locator('h1')).toHaveText('Calendar');
  await expect(settingsPage().locator('.calset-cal')).toHaveCount(3);

  // Weekends off, the week from Sunday.
  await settingsPage().locator('[data-a="calset-weekends"]').click();
  await expect(settingsPage().locator('[data-a="calset-weekends"] .switch')).not.toHaveClass(/\bon\b/);
  await settingsPage().locator('[data-a="calset-weekstart"]').click();
  await win.locator('.scrim .radio-row', { hasText: 'Sunday' }).click();
  await expect(settingsPage().locator('[data-a="calset-weekstart"] .value')).toHaveText('Sunday');
  // Working days: Friday off; working hours: both ends in one change.
  await settingsPage().locator('.calset-day[aria-label="Friday"]').click();
  await expect(settingsPage().locator('.calset-day[aria-label="Friday"]')).toHaveAttribute('aria-pressed', 'false');
  await settingsPage().locator('[data-calset-time="start"]').fill('08:30');
  await settingsPage().locator('[data-calset-time="start"]').dispatchEvent('change');
  await expect.poll(async () => (await calendarState()).workStart).toBe('08:30');
  // An end before the start is refused and changes nothing.
  await settingsPage().locator('[data-calset-time="end"]').fill('07:00');
  await settingsPage().locator('[data-calset-time="end"]').dispatchEvent('change');
  await expect(settingsPage().locator('[data-calset-error]')).toHaveText('The end of the day has to come after its start.');
  await settingsPage().locator('[data-calset-time="end"]').fill('16:00');
  await settingsPage().locator('[data-calset-time="end"]').dispatchEvent('change');
  await expect.poll(async () => (await calendarState()).workEnd).toBe('16:00');
  // Default length and reminder.
  await settingsPage().locator('[data-a="calset-duration"]').click();
  await win.locator('.scrim .radio-row .rl').getByText('30 mins', { exact: true }).click();
  await settingsPage().locator('[data-a="calset-reminder"]').click();
  await win.locator('.scrim .radio-row .rl').getByText('None', { exact: true }).click();
  // Work no longer counts toward availability; it gets the green swatch.
  const work = settingsPage().locator('.calset-cal', { hasText: 'Work' });
  await work.locator('.calset-switch').click();
  await expect(work.locator('.calset-switch')).toHaveAttribute('aria-checked', 'false');
  await work.locator('.calset-swatch').click();
  await win.locator('.scrim [data-color="#3fbf72"]').click();
  await expect(settingsPage().locator('.calset-cal', { hasText: 'Work' }).locator('.calset-swatch')).toHaveAttribute('style', /#3fbf72/);

  const saved = await calendarState();
  expect(saved).toMatchObject({ weekends: false, weekStart: 0, workDays: [1, 2, 3, 4], workStart: '08:30', workEnd: '16:00', duration: 30, reminder: null });
  const accountId = await win.evaluate(() => window.mail.call('state').then((s) => s.accounts[0].id));
  expect(saved.availability[`${accountId}\nwork`]).toBe(false);
  expect(saved.colors[`${accountId}\nwork`]).toBe('#3fbf72');

  // The grid follows: five days from Monday (weekends hidden), and the panel checks one calendar.
  await settingsPage().locator('[data-a="back"]').click();
  await settingsPage().locator('[data-a="back"]').click();
  await expect(win.locator('.cal-dayhead')).toHaveCount(5);
  await expect(win.locator('.cal-dayhead .dow')).toHaveText(['Mon', 'Tue', 'Wed', 'Thu', 'Fri']);
  await win.click('[data-cal-panel="free"]');
  await expect(panel().locator('[data-free-act="checked"]')).toHaveText('Checked: 1 calendar', { timeout: 10000 });

  // After a reload everything is as it was set; with weekends back, the week starts on Sunday.
  await win.reload();
  await expect(win.locator('.item, .calendar').first()).toBeVisible({ timeout: 15000 });
  expect(await calendarState()).toMatchObject({ weekends: false, weekStart: 0, workStart: '08:30', workEnd: '16:00' });
  await win.evaluate(() => document.querySelector('[data-action="settings"]').click());
  await settingsPage().locator('[data-a="calset-open"]').click();
  await expect(settingsPage().locator('[data-a="calset-weekstart"] .value')).toHaveText('Sunday');
  await expect(settingsPage().locator('[data-calset-time="start"]')).toHaveValue('08:30');
  await settingsPage().locator('[data-a="calset-weekends"]').click();
  await settingsPage().locator('[data-a="back"]').click();
  await settingsPage().locator('[data-a="back"]').click();
  await openCalendar();
  await expect(win.locator('.cal-dayhead')).toHaveCount(7);
  await expect(win.locator('.cal-dayhead .dow').first()).toHaveText('Sun');
});

test('the panel and Settings → Calendar are in Dutch with the rest of the app', async () => {
  await win.evaluate(() => window.mail.call('updateSettings', { language: 'nl' }));
  await win.reload();
  await expect(win.locator('.item').first()).toBeVisible({ timeout: 15000 });
  await win.click('[data-mode="calendar"]');
  await expect(win.locator('.calendar [data-ev]').first()).toBeVisible({ timeout: 10000 });
  await win.click('[data-cal-panel="free"]');
  await expect(panel().locator('h2')).toHaveText('Beschikbaarheid');
  await expect(panel().locator('[data-free-act="checked"]')).toHaveText("Bekeken: 2 agenda's", { timeout: 10000 });
  await expect(panel().locator('[data-free-act="copy"]')).toHaveText('Kopiëren als tekst');
  await win.evaluate(() => document.querySelector('[data-action="settings"]')?.click());
  await settingsPage().locator('[data-a="calset-open"]').click();
  await expect(settingsPage().locator('h1')).toHaveText('Agenda');
  await expect(settingsPage().locator('[data-a="calset-weekends"] .title')).toHaveText('Weekenden tonen');
});
