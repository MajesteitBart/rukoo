// The event card, the quick popover for a new event, the full event dialog and a booking request's card, in the real
// app on the demo account. Guests and Google Meet need a calendar whose provider sends invitations, so those run on a
// Google account whose calendar is the shared stand-in from test/fixtures/google-calendar.js.
const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('path');
const { tempDir, removeDir } = require('../tmp');
const { closeApp } = require('./close');
const { caldavServer } = require('../fixtures/caldav-server');

let app;
let win;
let dataDir;

test.beforeEach(async () => {
  dataDir = tempDir('sem-e2e-calevent-');
  const env = { ...process.env, SEM_DATA_DIR: dataDir, SEM_HIDDEN: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: ['.'], cwd: path.join(__dirname, '..', '..'), env });
  win = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1500, 950));
  await win.waitForSelector('.provider-grid');
  await win.click('[data-s="demo"]');
  await expect(win.locator('.item').first()).toBeVisible({ timeout: 15000 });
});

test.afterEach(async () => {
  await closeApp(app);
  removeDir(dataDir);
});

const event = (title) => win.locator('.calendar [data-ev]', { hasText: title }).first();
const card = () => win.locator('.cal-pop');
const quick = () => win.locator('.cal-quick');
const form = () => win.locator('.dialog .cal-form');
const toast = () => win.locator('#toast');
const save = () => win.click('.dialog .buttons button.primary');
const remindersNotice = () => win.locator('.cal-notice', { hasText: 'Rukoo now reminds you of events' });

// The calendar in week view, without the one-time notice about reminders.
async function openCalendar() {
  await win.click('[data-mode="calendar"]');
  await expect(win.locator('.calendar')).toBeVisible();
  await expect(event('Roadmap review')).toBeVisible({ timeout: 10000 });
  if (await remindersNotice().count()) {
    await remindersNotice().locator('button', { hasText: 'Got it' }).click();
    await expect(remindersNotice()).toHaveCount(0);
  }
}

// The events as the calendar store holds them, from a week before this one to five weeks after.
const stored = () =>
  win.evaluate(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7) - 7);
    return window.mail.call('calendarView', { start: d.getTime(), end: d.getTime() + 49 * 86400000 }).then((v) => v.events);
  });
const storedOne = async (title) => (await stored()).find((e) => e.title === title) || null;
const storedAll = async (title) => (await stored()).filter((e) => e.title === title).sort((a, b) => a.start - b.start);

const dateText = (ms) =>
  win.evaluate((ms) => {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }, ms);
const timeOn = (day, h, m = 0) =>
  win.evaluate(([day, h, m]) => {
    const d = new Date(day);
    d.setHours(h, m, 0, 0);
    return d.getTime();
  }, [day, h, m]);
const shiftDays = (ms, n) =>
  win.evaluate(([ms, n]) => {
    const d = new Date(ms);
    d.setDate(d.getDate() + n);
    return d.getTime();
  }, [ms, n]);
const demoAccount = () => win.evaluate(() => document.querySelector('.sidebar [data-cal-toggle]').dataset.calToggle.split('\n')[0]);
const columnOf = (locator) => locator.evaluate((el) => Number(el.closest('[data-cal-col]').dataset.calCol));
const column = (n) => win.locator('.cal-col').nth(n);
const scrollGrid = (hour) => win.locator('.cal-scroll').evaluate((el, top) => (el.scrollTop = top), hour * 56);

// Where an element is once the view stopped redrawing: the same box twice in a row.
async function settledBox(locator) {
  let last = null;
  for (let i = 0; i < 30; i++) {
    const box = await locator.boundingBox();
    if (box && last && ['x', 'y', 'width', 'height'].every((k) => Math.abs(box[k] - last[k]) < 0.5)) return box;
    last = box;
    await win.waitForTimeout(80);
  }
  throw new Error('The element kept moving');
}

// A point in a day column at a time of day.
async function gridPoint(n, h, m) {
  const box = await settledBox(column(n));
  return { x: box.x + 30, y: box.y + ((h * 60 + m) / 60) * 56 };
}

async function drag(from, to) {
  await win.mouse.move(from.x, from.y);
  await win.mouse.down();
  await win.mouse.move(from.x + 3, from.y + 5, { steps: 2 });
  await win.mouse.move(to.x, to.y, { steps: 10 });
  await win.mouse.up();
}

// Sets a date or time field as a person does: the value, then the change event the dialog listens to.
async function set(name, value) {
  await win.fill(`.cal-form [name="${name}"]`, value);
  await win.locator(`.cal-form [name="${name}"]`).dispatchEvent('change');
}

async function openMore() {
  const toggle = win.locator('.cal-form [data-extras]');
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  await expect(win.locator('.cal-form .cal-extras-body')).not.toHaveAttribute('inert', '');
}

// The calls the window makes, seen in main (global.__calls). Booking calls are answered here, because the booking
// service may not be running in this build: bookingAction is recorded, bookingDetails answers from global.__details.
// A method in global.__fail fails its next call, after a delay (failNext).
async function watchCalls() {
  await app.evaluate(({ BrowserWindow, ipcMain }) => {
    const original = ipcMain._invokeHandlers.get('mail:call');
    global.__calls = [];
    global.__booking = [];
    global.__details = {};
    global.__fail = {};
    for (const w of BrowserWindow.getAllWindows()) {
      w.webContents.ipc.removeHandler('mail:call');
      w.webContents.ipc.handle('mail:call', async (event, method, args) => {
        global.__calls.push([method, JSON.parse(JSON.stringify(args || []))]);
        const fail = global.__fail[method];
        if (fail) {
          delete global.__fail[method];
          await new Promise((done) => setTimeout(done, fail.delay));
          return { ok: false, error: fail.error };
        }
        if (method === 'bookingAction') {
          global.__booking.push(args);
          return { ok: true, result: null };
        }
        if (method === 'bookingDetails') return { ok: true, result: global.__details[args[0]] || null };
        return original(event, method, args);
      });
    }
  });
}
const fakeBooking = watchCalls;
const failNext = (method, error, delay = 0) => app.evaluate(({}, [method, error, delay]) => (global.__fail[method] = { error, delay }), [method, error, delay]);
const bookingCalls = () => app.evaluate(() => global.__booking);
const callsTo = (method) => app.evaluate(({}, method) => global.__calls.filter(([m]) => m === method).map(([, args]) => args), method);
const setBooking = (state) => win.evaluate(async (state) => (await import('./calendar.js')).setBooking(state), state);

// A Google account whose calendar is the stand-in Google Calendar, with these events on its primary calendar.
async function addGoogle(events) {
  await app.evaluate(({ app: electronApp }, events) => {
    const path = process.mainModule.require('path');
    const root = electronApp.getAppPath();
    const { fakeCalendar } = process.mainModule.require(path.join(root, 'test', 'fixtures', 'google-calendar.js'));
    const { CALENDAR_SCOPES } = process.mainModule.require(path.join(root, 'src', 'main', 'google.js'));
    const fake = fakeCalendar({ events });
    global.__fake = fake;
    global.__semCalendars.fetch = fake.fetchImpl;
    const engine = global.__semEngine;
    engine.accounts.push({
      id: 'g1',
      type: 'imap',
      provider: 'google',
      auth: 'oauth2',
      email: 'me@example.com',
      name: 'Me at Google',
      color: '#ff8a3d',
      secret: 'plain:',
      scopes: ['https://mail.google.com/', ...CALENDAR_SCOPES],
      imap: { host: 'imap.gmail.com', port: 993, secure: true, user: 'me@example.com' },
      smtp: { host: 'smtp.gmail.com', port: 465, secure: true, user: 'me@example.com' }
    });
    engine.caches.set('g1', { folders: [], boxes: {}, lastSync: null });
    engine.tokens.set('g1', { accessToken: 'token', expiresAt: Date.now() + 3600000 });
    engine.emit('updated');
  }, events);
}
const googleRequests = (method) => app.evaluate(({}, method) => global.__fake.requests.filter((r) => r.method === method), method);

// An account whose calendar is on the CalDAV test server; its mail server doesn't exist.
async function addCaldav(server) {
  await app.evaluate(({}, { url, home }) => {
    const engine = global.__semEngine;
    const unreachable = { host: '127.0.0.1', port: 1, secure: false, user: 'me@example.com' };
    engine.accounts.push({ id: 'c1', type: 'imap', provider: 'other', email: 'me@example.com', name: 'Me on CalDAV', color: '#4a7dff', secret: `plain:${Buffer.from('secret').toString('base64')}`, imap: unreachable, smtp: unreachable, caldav: { url: `${url}/`, home } });
    engine.caches.set('c1', { folders: [], boxes: {}, lastSync: null });
    engine.emit('updated');
  }, { url: server.url, home: server.home });
}
// A local day this week as an iCalendar date, 0 being Monday, and an event object around some lines.
function icsDay(n) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7) + n);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}
const ics = (...lines) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN', 'BEGIN:VEVENT', 'DTSTAMP:20260101T000000Z', ...lines, 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');

test('a click on the grid opens the quick popover at the half hour, and Enter saves the event there', async () => {
  await openCalendar();
  await scrollGrid(12);
  const wednesday = await column(2).evaluate((el) => Number(el.dataset.calCol));
  const at = await gridPoint(2, 14, 40);
  await win.mouse.click(at.x, at.y);
  await expect(quick()).toBeVisible();
  await expect(quick().locator('.cal-quick-when')).toContainText('14:30 – 15:30');
  await expect(quick().locator('[name="title"]')).toBeFocused();
  // Beside the click, not over it.
  const box = await quick().boundingBox();
  expect(box.x > at.x || box.x + box.width < at.x).toBe(true);
  // The demo's calendars send no invitations and have no Google Meet, so neither is offered.
  await expect(quick().locator('[data-guests]')).toBeHidden();
  await expect(quick().locator('[data-meet]')).toBeHidden();
  // Tab stays inside the popover.
  const stops = await quick().evaluate((el) => [...el.querySelectorAll('input, select, button')].filter((x) => x.getClientRects().length).length);
  for (let i = 0; i < stops; i++) await win.keyboard.press('Tab');
  await expect(quick().locator('[name="title"]')).toBeFocused();
  // The calendar's own keys don't act behind it: D would switch to the day view.
  await win.keyboard.type('Piano tuning d');
  await expect(win.locator('.cal-dayhead')).toHaveCount(7);
  await win.keyboard.press('Backspace');
  await win.keyboard.press('Backspace');
  await win.keyboard.press('Enter');
  await expect(toast()).toHaveText('Event created');
  await expect(quick()).toHaveCount(0);
  await expect(event('Piano tuning')).toContainText('14:30 – 15:30');
  expect(await columnOf(event('Piano tuning'))).toBe(wednesday);
  const saved = await storedOne('Piano tuning');
  expect(saved.calendarId).toBe('personal');
  // A timed event shows as busy.
  expect(saved.busy).toBe(true);

  // A click on the all-day row: an all-day event, which shows as free.
  await win.locator(`.cal-allday-cell[data-cal-allday="${wednesday}"]`).click();
  await expect(quick()).toBeVisible();
  await win.keyboard.type('Library day');
  await win.keyboard.press('Enter');
  await expect(quick()).toHaveCount(0);
  await expect.poll(async () => (await storedOne('Library day'))?.busy).toBe(false);
  expect((await storedOne('Library day')).allDay).toBe(true);

  // A click elsewhere closes the popover without making another event there.
  await win.mouse.click(at.x, at.y + 3 * 56);
  await expect(quick()).toBeVisible();
  await win.mouse.click(at.x, at.y + 5 * 56);
  await expect(quick()).toHaveCount(0);
  await expect(win.locator('.dialog')).toHaveCount(0);
});

test('a drag opens the popover beside its ghost; Enter saves, Escape lets go, and More options carries what was typed', async () => {
  await openCalendar();
  await scrollGrid(5);
  const wednesday = await column(2).evaluate((el) => Number(el.dataset.calCol));
  await drag(await gridPoint(2, 6, 5), await gridPoint(2, 7, 20));
  await expect(quick()).toBeVisible();
  await expect(quick().locator('.cal-quick-when')).toContainText('06:00 – 07:30');
  // The ghost stays as the new event's place while the popover is open, and the popover is beside it.
  await expect(win.locator('.cal-ghost')).toHaveCount(1);
  const ghost = await win.locator('.cal-ghost').boundingBox();
  const pop = await quick().boundingBox();
  expect(pop.x >= ghost.x + ghost.width || pop.x + pop.width <= ghost.x).toBe(true);
  await win.keyboard.type('Focus time');
  await win.keyboard.press('Enter');
  await expect(event('Focus time')).toContainText('06:00 – 07:30');
  await expect(win.locator('.cal-ghost')).toHaveCount(0);
  expect(await columnOf(event('Focus time'))).toBe(wednesday);

  // Escape: nothing is saved and the ghost goes.
  await drag(await gridPoint(1, 6, 5), await gridPoint(1, 6, 50));
  await expect(quick()).toBeVisible();
  await win.keyboard.press('Escape');
  await expect(quick()).toHaveCount(0);
  await expect(win.locator('.cal-ghost')).toHaveCount(0);

  // More options: the dialog takes the title, the calendar and the times; the ghost stays until it closes.
  await drag(await gridPoint(2, 7, 50), await gridPoint(2, 8, 20));
  await expect(quick().locator('.cal-quick-when')).toContainText('07:45 – 08:30');
  await quick().locator('[name="title"]').fill('Planning block');
  await quick().locator('[name="calendar"]').selectOption({ label: 'Work' });
  await quick().locator('[data-quick="more"]').click();
  await expect(quick()).toHaveCount(0);
  await expect(form().locator('[name="title"]')).toHaveValue('Planning block');
  await expect(form().locator('[name="calendar"] option:checked')).toHaveText('Work');
  await expect(form().locator('[name="startTime"]')).toHaveValue('07:45');
  await expect(form().locator('[name="endTime"]')).toHaveValue('08:30');
  await expect(win.locator('.cal-ghost')).toHaveCount(1);
  await save();
  await expect(form()).toHaveCount(0);
  // A short block shows only its start; its name says the rest.
  await expect(event('Planning block')).toHaveAttribute('aria-label', /07:45 – 08:30, Work$/);
  await expect(win.locator('.cal-ghost')).toHaveCount(0);
  expect((await storedOne('Planning block')).calendarId).toBe('work');
});

test('the conflict line names an overlapping event, follows the times, and leaves out the event itself', async () => {
  await openCalendar();
  await scrollGrid(8);
  // Monday 10:30 to 11:30 overlaps the roadmap review at 11:00.
  const at = await gridPoint(0, 10, 40);
  await win.mouse.click(at.x, at.y);
  const line = quick().locator('[data-conflict]');
  await expect(line).toBeVisible();
  await expect(line).toHaveText('Overlaps Roadmap review 11:00–12:00');
  await quick().locator('[name="title"]').fill('Hiring sync');
  await quick().locator('[data-quick="more"]').click();
  const dialogLine = form().locator('[data-conflict]');
  await expect(dialogLine).toHaveText('Overlaps Roadmap review 11:00–12:00');
  // Later the same day nothing overlaps.
  await set('startTime', '15:00');
  await expect(dialogLine).toBeHidden();
  await set('startTime', '11:15');
  await expect(dialogLine).toHaveText('Overlaps Roadmap review 11:00–12:00');
  await win.keyboard.press('Escape');

  // The review itself has nothing to overlap with.
  await event('Roadmap review').click();
  await card().locator('[data-pop="edit"]').click();
  await expect(form()).toBeVisible();
  await win.waitForTimeout(700);
  await expect(form().locator('[data-conflict]')).toBeHidden();
});

test('a weekly series from the repeat presets; a change to this and following, then to all events', async () => {
  await openCalendar();
  await watchCalls();
  const thursday = await column(3).evaluate((el) => Number(el.dataset.calCol));
  await win.click('[data-cal="new"]');
  await form().locator('[name="title"]').fill('Weekly sync');
  await set('startDate', await dateText(thursday));
  await set('startTime', '17:30');
  await openMore();
  const repeat = form().locator('[name="repeat"]');
  // The presets follow the start date.
  await expect(repeat.locator('option[value="weekly"]')).toHaveText('Weekly on Thursday');
  await expect(repeat.locator('option[value="none"]')).toHaveText('Does not repeat');
  await repeat.selectOption('weekly');
  await expect(form().locator('[data-extras-sum]')).toHaveText('Weekly on Thursday');
  await save();
  await expect(form()).toHaveCount(0);
  await expect.poll(async () => (await storedAll('Weekly sync')).length).toBeGreaterThanOrEqual(5);
  const first = (await storedAll('Weekly sync'))[0];
  expect(first.start).toBe(await timeOn(thursday, 17, 30));
  // The rule names the week's first day (Monday in English), as the editor always writes it. The calendar may
  // leave out WKST=MO, Monday being the default.
  expect((await callsTo('calendarCreate'))[0][0].recurrence).toBe('FREQ=WEEKLY;BYDAY=TH;WKST=MO');
  const series = await win.evaluate((id) => window.mail.call('calendarSeries', id), first.id);
  expect(series.rule).toMatch(/^FREQ=WEEKLY;BYDAY=TH(;WKST=MO)?$/);

  // Two weeks on: this and following.
  await win.locator('.cal-days .cal-gutter').click();
  await win.keyboard.press('j');
  await win.keyboard.press('j');
  await scrollGrid(16);
  await event('Weekly sync').click();
  await card().locator('[data-pop="edit"]').click();
  await expect(form().locator('.note')).toHaveText('This event repeats. When you save, you choose which events change.');
  // The rule shows as its preset once the series is read.
  await openMore();
  await expect(form().locator('[name="repeat"]')).toHaveValue('weekly');
  await form().locator('[name="title"]').fill('Weekly sync (new room)');
  await save();
  const choice = win.locator('.dialog .radio-row');
  await expect(choice).toHaveText(['This event', 'This and following events', 'All events in the series']);
  await choice.filter({ hasText: 'This and following events' }).click();
  await expect(form()).toHaveCount(0);
  await expect.poll(async () => (await storedAll('Weekly sync (new room)')).length).toBeGreaterThanOrEqual(3);
  const before = await storedAll('Weekly sync');
  expect(before.map((e) => e.start)).toEqual([await timeOn(thursday, 17, 30), await timeOn(await shiftDays(thursday, 7), 17, 30)]);
  expect((await storedAll('Weekly sync (new room)'))[0].start).toBe(await timeOn(await shiftDays(thursday, 14), 17, 30));
  // The rule wasn't touched, so it wasn't sent; the series' version came from calendarSeries.
  const [, input, opts] = (await callsTo('calendarUpdate')).pop();
  expect(input.title).toBe('Weekly sync (new room)');
  expect('recurrence' in input).toBe(false);
  expect(opts.scope).toBe('following');
  expect(await callsTo('calendarSeries')).not.toHaveLength(0);

  // A new rule is for the series: this and following, or all, never this one event.
  await event('Weekly sync (new room)').click();
  await card().locator('[data-pop="edit"]').click();
  await openMore();
  await expect(form().locator('[name="repeat"]')).toHaveValue('weekly');
  await form().locator('[name="repeat"]').selectOption('daily');
  await save();
  await expect(choice).toHaveText(['This and following events', 'All events in the series']);
  await win.locator('.dialog .buttons button', { hasText: 'Cancel' }).last().click();
  // Cancelling the question goes back to the dialog with what was chosen.
  await expect(form().locator('[name="repeat"]')).toHaveValue('daily');
  await win.keyboard.press('Escape');

  // Back to this week: all events of the first half.
  await win.keyboard.press('t');
  await scrollGrid(16);
  await event('Weekly sync').click();
  await card().locator('[data-pop="edit"]').click();
  await form().locator('[name="location"]').fill('Room 2.04');
  await save();
  await choice.filter({ hasText: 'All events in the series' }).click();
  await expect(form()).toHaveCount(0);
  await expect.poll(async () => (await storedAll('Weekly sync')).map((e) => e.location)).toEqual(['Room 2.04', 'Room 2.04']);
  expect((await storedAll('Weekly sync (new room)')).every((e) => e.location === '')).toBe(true);
});

test('the custom repeat form writes its rule, and the presets know the month', async () => {
  await openCalendar();
  await watchCalls();
  await win.click('[data-cal="new"]');
  await form().locator('[name="title"]').fill('Book club');
  // 31 March 2027 is a Wednesday in its month's last week: "last" is offered, a "fifth" isn't.
  await set('startDate', '2027-03-31');
  await set('startTime', '19:00');
  await openMore();
  const repeat = form().locator('[name="repeat"]');
  await expect(repeat.locator('option[value="monthlyLast"]')).toHaveText('Monthly on the last Wednesday');
  await expect(repeat.locator('option[value="monthlyNth"]')).toHaveCount(0);
  await repeat.selectOption('monthlyDay');
  await expect(form().locator('[data-repeat-warn]')).toHaveText('Months with fewer than 31 days are skipped.');
  await repeat.selectOption('custom');
  const custom = form().locator('[data-custom]');
  await expect(custom).toBeVisible();
  await custom.locator('[name="rFreq"]').selectOption('WEEKLY');
  await custom.locator('[name="rInterval"]').fill('2');
  await custom.locator('[name="rInterval"]').dispatchEvent('change');
  await expect(custom.locator('[name="rFreq"] option:checked')).toHaveText('weeks');
  // Wednesday is on; Friday goes on too.
  await expect(custom.locator('[data-wd="3"]')).toHaveAttribute('aria-pressed', 'true');
  await custom.locator('[data-wd="5"]').click();
  await expect(custom.locator('[data-wd="5"]')).toHaveAttribute('aria-pressed', 'true');
  await custom.locator('[name="rEnds"][value="after"]').check();
  await custom.locator('[name="rCount"]').fill('3');
  await custom.locator('[name="rCount"]').dispatchEvent('change');
  // No day at all can't be saved.
  await custom.locator('[data-wd="3"]').click();
  await custom.locator('[data-wd="5"]').click();
  await save();
  await expect(form().locator('[data-error]')).toHaveText('Choose at least one day.');
  await custom.locator('[data-wd="3"]').click();
  await custom.locator('[data-wd="5"]').click();
  await save();
  await expect(form()).toHaveCount(0);
  const made = await win.evaluate(() => window.mail.call('calendarView', { start: new Date(2027, 2, 28).getTime(), end: new Date(2027, 4, 1).getTime() }).then((v) => v.events.filter((e) => e.title === 'Book club')));
  expect(made).toHaveLength(3);
  expect((await callsTo('calendarCreate'))[0][0].recurrence).toBe('FREQ=WEEKLY;INTERVAL=2;BYDAY=WE,FR;COUNT=3;WKST=MO');
  const series = await win.evaluate((id) => window.mail.call('calendarSeries', id), made[0].id);
  expect(series.rule.split(';').filter((p) => p !== 'WKST=MO').sort()).toEqual(['BYDAY=WE,FR', 'COUNT=3', 'FREQ=WEEKLY', 'INTERVAL=2']);
  // Opened again, the rule shows in the custom form as it was made.
  await win.locator('.cal-title').click();
  await win.fill('.dialog [name="date"]', '2027-03-31');
  await win.keyboard.press('Enter');
  await scrollGrid(18);
  await event('Book club').click();
  await card().locator('[data-pop="edit"]').click();
  await openMore();
  await expect(form().locator('[name="repeat"]')).toHaveValue('custom');
  await expect(form().locator('[name="rInterval"]')).toHaveValue('2');
  await expect(form().locator('[name="rCount"]')).toHaveValue('3');
  await expect(form().locator('[data-wd="5"]')).toHaveAttribute('aria-pressed', 'true');
});

test("a weekly series in another time zone repeats on the weekday the dialog shows, from its first day", async () => {
  await openCalendar();
  await watchCalls();
  // 01:00 on the PC is the day before in Pago Pago (UTC-11), wherever east of UTC-10 the PC is.
  const thursday = await column(3).evaluate((el) => Number(el.dataset.calCol));
  await win.click('[data-cal="new"]');
  await form().locator('[name="title"]').fill('Night call');
  await set('startDate', await dateText(thursday));
  await set('startTime', '01:00');
  await openMore();
  await form().locator('[name="timeZone"]').fill('Pacific/Pago_Pago');
  await form().locator('[name="timeZone"]').dispatchEvent('input');
  const repeat = form().locator('[name="repeat"]');
  await expect(repeat.locator('option[value="weekly"]')).toHaveText('Weekly on Thursday');
  await repeat.selectOption('weekly');
  await save();
  await expect(form()).toHaveCount(0);
  // The rule names the day as Pago Pago has it, and the week starts there on Sunday, the PC's Monday.
  expect((await callsTo('calendarCreate'))[0][0].recurrence).toBe('FREQ=WEEKLY;BYDAY=WE;WKST=SU');
  await expect.poll(async () => (await storedAll('Night call')).length).toBeGreaterThanOrEqual(3);
  const made = await storedAll('Night call');
  expect(made[0].start).toBe(await timeOn(thursday, 1, 0));
  const clock = await win.evaluate((list) => list.map((ms) => `${new Date(ms).getDay()} ${new Date(ms).getHours()}`), made.map((e) => e.start));
  expect(new Set(clock)).toEqual(new Set(['4 1']));
  // Opened again, the rule is the preset it was made with.
  await scrollGrid(0);
  await event('Night call').click();
  await card().locator('[data-pop="edit"]').click();
  await openMore();
  await expect(form().locator('[name="repeat"]')).toHaveValue('weekly');
  await expect(form().locator('[name="repeat"] option:checked')).toHaveText('Weekly on Thursday');
});

test('reminders, the time zone and show as are saved and come back in the dialog', async () => {
  await openCalendar();
  await win.click('[data-cal="new"]');
  await form().locator('[name="title"]').fill('Board call');
  await set('startTime', '16:00');
  await openMore();
  const reminders = form().locator('[data-reminders]');
  // Without reminders of its own, the default from Settings → Calendar applies.
  await expect(reminders.locator('.field-help')).toHaveText('Rukoo reminds you 10 minutes before, as set in Settings → Calendar.');
  await reminders.locator('[data-rem-add]').click();
  await reminders.locator('[data-rem="0"]').selectOption('30');
  await reminders.locator('[data-rem-add]').click();
  await reminders.locator('[data-rem="1"]').selectOption('1440');
  await expect(reminders.locator('[data-rem="1"] option:checked')).toHaveText('1 day before');
  // The time zone list searches as you type; the times show on that clock too.
  await form().locator('[name="timeZone"]').fill('America/New_York');
  await form().locator('[name="timeZone"]').dispatchEvent('input');
  await expect(form().locator('[data-zone-note]')).toContainText('in America/New York');
  await form().locator('[name="visibility"]').selectOption('private');
  await expect(form().locator('[data-extras-sum]')).toHaveText('2 reminders · America/New York · Private');
  // With everything open the fields scroll, while the title and Save stay inside the window.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1500, 700));
  await expect.poll(() => win.evaluate(() => window.innerHeight)).toBeLessThan(720);
  const inView = await win.evaluate(() => {
    const save = document.querySelector('.scrim .dialog .buttons button.primary');
    const title = document.querySelector('.scrim .dialog h2');
    const r = save.getBoundingClientRect();
    return r.bottom <= window.innerHeight && r.top >= 0 && title.getBoundingClientRect().top >= 0;
  });
  expect(inView).toBe(true);
  await save();
  await expect(form()).toHaveCount(0);
  await expect.poll(() => storedOne('Board call')).not.toBeNull();
  const saved = await storedOne('Board call');
  expect(saved.timeZone).toBe('America/New_York');
  expect(saved.visibility).toBe('private');
  expect(saved.busy).toBe(true);
  expect(saved.reminders.overrides.map((o) => [o.method, o.minutes]).sort((a, b) => a[1] - b[1])).toEqual([['popup', 30], ['popup', 1440]]);
  expect(await win.evaluate((ms) => new Date(ms).getHours(), saved.start)).toBe(16);

  // Opened again, the dialog shows what was saved; one reminder less is saved too.
  await event('Board call').click();
  await card().locator('[data-pop="edit"]').click();
  await openMore();
  await expect(form().locator('[name="timeZone"]')).toHaveValue('America/New_York');
  await expect(form().locator('[name="visibility"]')).toHaveValue('private');
  const values = await form().locator('[data-reminders] select').evaluateAll((list) => list.map((s) => Number(s.value)).sort((a, b) => a - b));
  expect(values).toEqual([30, 1440]);
  await form().locator('[data-rem-remove]').first().click();
  await save();
  await expect(form()).toHaveCount(0);
  await expect.poll(async () => (await storedOne('Board call')).reminders.overrides.length).toBe(1);
  expect((await storedOne('Board call')).timeZone).toBe('America/New_York');

  // An all-day event shows as free, and its reminders are times on its days.
  await win.click('[data-cal="new"]');
  await form().locator('[name="title"]').fill('Conference');
  await form().locator('[name="allDay"]').check();
  await openMore();
  await expect(form().locator('[name="busy"]')).toHaveValue('free');
  await expect(form().locator('[data-zone-field]')).toBeHidden();
  await form().locator('[data-rem-add]').click();
  await expect(form().locator('[data-rem="0"] option:checked')).toHaveText('The day before at 09:00');
  await form().locator('[data-rem="0"]').selectOption({ label: 'On the day at 09:00' });
  await save();
  await expect(form()).toHaveCount(0);
  await expect.poll(() => storedOne('Conference')).not.toBeNull();
  const allDay = await storedOne('Conference');
  expect(allDay.busy).toBe(false);
  expect(allDay.reminders.overrides).toEqual([{ method: 'popup', minutes: -540 }]);
});

test('Duplicate opens a new event with the same fields, and the calendar field moves an event to another calendar', async () => {
  await openCalendar();
  await scrollGrid(8);
  await event('Lunch with Sanne').click();
  await card().locator('[data-pop="duplicate"]').click();
  await expect(win.locator('.dialog h2')).toHaveText('New event');
  await expect(form().locator('[name="title"]')).toHaveValue('Lunch with Sanne');
  await expect(form().locator('[name="location"]')).toHaveValue('Café de Jaren, Nieuwe Doelenstraat 20, Amsterdam');
  await expect(form().locator('[name="startTime"]')).toHaveValue('12:30');
  const original = await storedOne('Lunch with Sanne');
  await set('startDate', await dateText(await shiftDays(original.start, 1)));
  await save();
  await expect(form()).toHaveCount(0);
  await expect.poll(async () => (await storedAll('Lunch with Sanne')).length).toBe(2);
  const [a, b] = await storedAll('Lunch with Sanne');
  expect(b.start - a.start).toBe((await shiftDays(a.start, 1)) - a.start);
  expect(b.location).toBe(a.location);

  // The dentist moves from the personal calendar to Work.
  await event('Dentist').click();
  await card().locator('[data-pop="edit"]').click();
  const calendar = form().locator('[name="calendar"]');
  await expect(calendar).toBeEnabled();
  await expect(calendar.locator('option')).toHaveText(['Demo User', 'Work']);
  await calendar.selectOption({ label: 'Work' });
  await expect(form().locator('[data-move-note]')).toHaveText('Saving moves the event to Work.');
  await save();
  await expect(toast()).toHaveText('Moved to Work');
  await expect.poll(async () => (await storedOne('Dentist')).calendarId).toBe('work');
  await event('Dentist').click();
  await expect(card()).toContainText('Work');
});

test('guests on a Google calendar: suggestions, optional and removed guests, Google Meet, and the question about invitations', async () => {
  await openCalendar();
  const monday = await column(0).evaluate((el) => Number(el.dataset.calCol));
  const iso = async (day, h) => new Date(await timeOn(await shiftDays(monday, day), h)).toISOString();
  await addGoogle([{ id: 'gboard', summary: 'Board meeting', start: { dateTime: await iso(1, 9) }, end: { dateTime: await iso(1, 10) }, organizer: { email: 'me@example.com', self: true } }]);
  await scrollGrid(8);
  await expect(event('Board meeting')).toBeVisible({ timeout: 10000 });
  await event('Board meeting').click();
  await card().locator('[data-pop="edit"]').click();
  const guests = form().locator('[data-guests]');
  await expect(guests).toBeVisible();
  const input = guests.locator('[data-guest-input]');
  // Suggestions come from addresses in synced mail.
  await input.fill('sanne');
  const suggest = win.locator('.cal-gsuggest');
  await expect(suggest.locator('button').first()).toContainText('sanne@example.com');
  await input.press('Enter');
  await expect(suggest).toHaveCount(0);
  await expect(guests.locator('.cal-gchip')).toHaveCount(1);
  await input.fill('new.person@example.com,');
  await expect(guests.locator('.cal-gchip')).toHaveCount(2);
  await input.fill('joris');
  await expect(suggest).toBeVisible();
  // Escape closes only the suggestions, not the dialog.
  await input.press('Escape');
  await expect(suggest).toHaveCount(0);
  await expect(form()).toBeVisible();
  await input.fill('not an address');
  await input.press('Enter');
  await expect(guests.locator('[data-guest-error]')).toHaveText('"not an address" isn\'t an email address.');
  await input.fill('');
  // The new person is optional, from the chip's menu.
  await guests.locator('.cal-gchip', { hasText: 'new.person@example.com' }).locator('[data-guest-menu]').click();
  await win.locator('.menu button', { hasText: 'Optional' }).click();
  await expect(guests.locator('.cal-gchip.optional')).toHaveText(/new\.person@example\.com/);
  // Google Meet is offered on this calendar.
  const meet = form().locator('[data-meet]');
  await expect(meet).toBeVisible();
  await meet.click();
  await expect(meet).toHaveAttribute('aria-checked', 'true');
  await save();
  await expect(win.locator('.dialog h2')).toHaveText('Send the change to the guests?');
  await win.locator('.dialog .buttons button.primary', { hasText: 'Send' }).click();
  await expect(form()).toHaveCount(0);
  await expect.poll(async () => (await googleRequests('PATCH')).length).toBeGreaterThan(0);
  const patch = (await googleRequests('PATCH')).pop();
  expect(patch.query.sendUpdates).toBe('all');
  expect(patch.query.conferenceDataVersion).toBe('1');
  expect(patch.body.conferenceData.createRequest).toBeTruthy();
  const people = Object.fromEntries(patch.body.attendees.map((a) => [a.email, Boolean(a.optional)]));
  expect(people['sanne@example.com']).toBe(false);
  expect(people['new.person@example.com']).toBe(true);

  // Opened again: the guests are there with their answers; one goes.
  await expect(event('Board meeting')).toBeVisible();
  await event('Board meeting').click();
  await expect(card()).toContainText('Sanne');
  await card().locator('[data-pop="edit"]').click();
  await expect(guests.locator('.cal-gchip')).toHaveCount(2);
  await expect(meet).toHaveAttribute('aria-checked', 'true');
  await guests.locator('.cal-gchip', { hasText: 'Sanne' }).locator('[data-guest-remove]').click();
  await expect(guests.locator('.cal-gchip')).toHaveCount(1);
  await save();
  await win.locator('.dialog .buttons button', { hasText: "Don't send" }).click();
  await expect(form()).toHaveCount(0);
  await expect.poll(async () => (await googleRequests('PATCH')).length).toBeGreaterThan(1);
  const second = (await googleRequests('PATCH')).pop();
  expect(second.query.sendUpdates).toBe('none');
  expect(second.body.attendees.map((a) => a.email)).not.toContain('sanne@example.com');

  // The quick popover offers guests and Meet once the Google calendar is chosen, and asks before inviting.
  await win.locator('.cal-days .cal-gutter').click();
  await scrollGrid(12);
  const at = await gridPoint(4, 13, 10);
  await win.mouse.click(at.x, at.y);
  await expect(quick()).toBeVisible();
  await expect(quick().locator('[data-guests]')).toBeHidden();
  await quick().locator('[name="calendar"]').selectOption('g1\nme@example.com');
  await expect(quick().locator('[data-guests]')).toBeVisible();
  await expect(quick().locator('[data-meet]')).toBeVisible();
  await quick().locator('[name="title"]').fill('Partner intro');
  await quick().locator('[data-guest-input]').fill('partner@example.com');
  await quick().locator('[data-guest-input]').press('Enter');
  await quick().locator('[data-meet]').click();
  await quick().locator('[name="title"]').press('Enter');
  await expect(win.locator('.dialog h2')).toHaveText('Send invitations to the guests?');
  await win.locator('.dialog .buttons button.primary', { hasText: 'Send' }).click();
  await expect(quick()).toHaveCount(0);
  await expect.poll(async () => (await googleRequests('POST')).filter((r) => r.body && r.body.summary === 'Partner intro').length).toBe(1);
  const post = (await googleRequests('POST')).find((r) => r.body && r.body.summary === 'Partner intro');
  expect(post.query.sendUpdates).toBe('all');
  expect(post.body.attendees.map((a) => a.email)).toEqual(['partner@example.com']);
  expect(post.body.conferenceData.createRequest).toBeTruthy();
});

test('a booking request opens its card from the grid: Accept, and Decline with a message', async () => {
  await openCalendar();
  await fakeBooking();
  const thursday = await column(3).evaluate((el) => Number(el.dataset.calCol));
  const start = await timeOn(thursday, 11);
  const state = (thisDevice) => ({
    status: 'on',
    thisDevice,
    device: { id: 'd1', name: 'Office PC', current: thisDevice },
    resolved: { availability: [], destination: { key: null, portable: '', name: 'Demo', email: 'demo@example.com', found: true, invites: 'none', conference: false } },
    bookings: [],
    requests: [
      {
        id: 'Rf63vMqqWdS0MICDAHKmrw',
        status: 'pending',
        type: '30min',
        typeTitle: '30 minute meeting',
        start,
        end: start + 1800000,
        expiresAt: start - 3600000,
        channel: 'web',
        guest: { name: 'Jane <b>Doe</b>', email: 'jane@example.com', notes: 'About <i>pricing</i>', timeZone: 'Europe/London', locale: 'en', via: 'An assistant <script>window.__xss = 1</script>' }
      }
    ]
  });
  await setBooking(state(true));
  await scrollGrid(8);
  const block = win.locator(`.cal-col[data-cal-col="${thursday}"] .cal-req`);
  await block.click();
  const req = win.locator('.cal-reqcard');
  await expect(req).toBeVisible();
  // What the guest wrote is text, never markup.
  await expect(req.locator('h2')).toHaveText('Booking request from Jane <b>Doe</b>');
  await expect(req).toContainText('About <i>pricing</i>');
  await expect(req).toContainText('Assistant: An assistant <script>window.__xss = 1</script>');
  await expect(req).toContainText('30 minute meeting');
  expect(await req.locator('b, i, script').count()).toBe(0);
  expect(await win.evaluate(() => window.__xss)).toBeUndefined();
  // The meeting on the guest's own clock.
  const there = await win.evaluate(([a, b]) => {
    const f = (ms) => new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'Europe/London' }).format(ms);
    return `${f(a)} – ${f(b)}`;
  }, [start, start + 1800000]);
  await expect(req).toContainText(`Guest's time: ${there} (Europe/London)`);
  await expect(req.locator('[data-req="accept"]')).toBeFocused();
  await req.locator('[data-req="accept"]').click();
  await expect(toast()).toHaveText('Request accepted');
  await expect(req).toHaveCount(0);
  expect(await bookingCalls()).toEqual([['Rf63vMqqWdS0MICDAHKmrw', 'accept']]);

  // Decline: a message for the guest's confirmation page, and the email only when asked for.
  await block.click();
  await req.locator('[data-req="decline"]').click();
  await expect(win.locator('.dialog h2')).toHaveText('Decline this request?');
  await expect(win.locator('.dialog')).toContainText('Jane <b>Doe</b> sees on their confirmation page that the request was declined.');
  await expect(win.locator('.dialog [name="email"]')).not.toBeChecked();
  await expect(win.locator('.dialog label', { hasText: 'Also email the message from demo@example.com' })).toBeVisible();
  await win.fill('.dialog [name="message"]', 'Sorry, that week is full.');
  await win.check('.dialog [name="email"]');
  // A failure shows in the dialog, which stays open with what the host wrote.
  await failNext('bookingAction', 'The account server could not be reached.', 1000);
  await win.locator('.dialog .buttons button.danger').click();
  await expect(win.locator('.dialog .buttons button.danger')).toBeDisabled();
  await expect(win.locator('.dialog [data-message-error]')).toHaveText('The account server could not be reached.');
  await expect(win.locator('.dialog [name="message"]')).toHaveValue('Sorry, that week is full.');
  await expect(win.locator('.dialog [name="email"]')).toBeChecked();
  await expect(win.locator('.dialog [name="message"]')).toBeFocused();
  await expect(req.locator('[data-req="decline"]')).toBeEnabled();
  await win.locator('.dialog .buttons button.danger').click();
  await expect(toast()).toHaveText('Request declined');
  await expect(win.locator('.dialog')).toHaveCount(0);
  expect((await bookingCalls())[1]).toEqual(['Rf63vMqqWdS0MICDAHKmrw', 'decline', { message: 'Sorry, that week is full.', email: true }]);

  // Escape closes the card and the keyboard goes back to the block.
  await block.click();
  await expect(req).toBeVisible();
  await win.keyboard.press('Escape');
  await expect(req).toHaveCount(0);
  await expect(block).toBeFocused();

  // On a computer that doesn't handle the bookings, the card says where to answer.
  await setBooking(state(false));
  await block.click();
  await expect(req.locator('[data-req="accept"]')).toHaveCount(0);
  await expect(req).toContainText('Office PC handles your bookings. Answer the request there.');
});

test("a booked event's card shows the guest's details as text, and Cancel booking takes the place of Delete", async () => {
  await openCalendar();
  await fakeBooking();
  const accountId = await demoAccount();
  const thursday = await column(3).evaluate((el) => Number(el.dataset.calCol));
  const make = (title, start, bookingId) =>
    app.evaluate(({}, [accountId, title, start, bookingId]) => global.__semCalendars.create({ accountId, calendarId: 'personal', title, location: '', description: '', allDay: false, start, end: start + 1800000 }, { bookingId }), [accountId, title, start, bookingId]);
  const start = await timeOn(thursday, 12);
  await make('Intro call', start, 'Kq0bAAAAAAAAAAAAAAAAAA');
  const older = await timeOn(thursday, 13, 30);
  await make('Earlier intro', older, 'Zz9zAAAAAAAAAAAAAAAAAA');
  const hostile = { name: '<img src=x onerror="window.__xss=1">Eve', email: 'eve@example.com', notes: '<b>Bring</b> the numbers https://evil.example/x', timeZone: 'Europe/London', locale: 'en', via: '<script>window.__xss=2</script>' };
  const booking = { id: 'Kq0bAAAAAAAAAAAAAAAAAA', status: 'confirmed', type: 'intro', typeTitle: 'Intro call', start, end: start + 1800000, channel: 'api', eventId: null, guest: hostile, customLength: false };
  const state = (thisDevice) => ({ status: 'on', thisDevice, device: { id: 'd1', name: 'Office PC', current: thisDevice }, bookings: [booking], requests: [] });
  await setBooking(state(true));
  await scrollGrid(10);
  await event('Intro call').click();
  await expect(card()).toContainText('Booked through your booking page');
  await expect(card()).toContainText('<img src=x onerror="window.__xss=1">Eve');
  await expect(card()).toContainText('<b>Bring</b> the numbers https://evil.example/x');
  await expect(card()).toContainText('Assistant: <script>window.__xss=2</script>');
  await expect(card()).toContainText("Guest's time:");
  // Nothing of it became markup or a link.
  expect(await card().locator('img, b, script, [data-href]').count()).toBe(0);
  expect(await win.evaluate(() => window.__xss)).toBeUndefined();
  const del = card().locator('[data-pop="delete"]');
  await expect(del).toHaveAttribute('title', 'Cancel booking (Delete)');
  await del.click();
  await expect(win.locator('.dialog h2')).toHaveText('Cancel this booking?');
  await expect(win.locator('.dialog')).toContainText('<img src=x onerror="window.__xss=1">Eve gets a cancellation for');
  await win.fill('.dialog [name="message"]', 'Something came up, sorry.');
  // A failure keeps the dialog and the message; trying again cancels.
  await failNext('bookingAction', 'The account server could not be reached.', 1000);
  await win.locator('.dialog .buttons button.danger').click();
  await expect(win.locator('.dialog .buttons button.danger')).toBeDisabled();
  await expect(win.locator('.dialog [data-message-error]')).toHaveText('The account server could not be reached.');
  await expect(win.locator('.dialog [name="message"]')).toHaveValue('Something came up, sorry.');
  await win.locator('.dialog .buttons button.danger').click();
  await expect(toast()).toHaveText('Booking cancelled');
  await expect(win.locator('.dialog')).toHaveCount(0);
  expect(await bookingCalls()).toEqual([['Kq0bAAAAAAAAAAAAAAAAAA', 'cancel', { notify: true, message: 'Something came up, sorry.' }]]);
  // Cancelling is the booking service's job: the event is still there for it.
  expect(await storedOne('Intro call')).not.toBeNull();

  // A booking older than the page's own list: main still knows it.
  await app.evaluate(({}, start) => {
    global.__details.Zz9zAAAAAAAAAAAAAAAAAA = { id: 'Zz9zAAAAAAAAAAAAAAAAAA', status: 'confirmed', type: 'intro', typeTitle: 'Intro call', start, end: start + 1800000, channel: 'web', eventId: null, guest: { name: 'Old Guest', email: 'old@example.com', notes: '', timeZone: 'Europe/Amsterdam', locale: 'nl', via: '' }, customLength: true };
  }, older);
  await event('Earlier intro').click();
  await expect(card()).toContainText('Old Guest');
  await expect(card()).toContainText('Length changed in your calendar');

  // On another computer the event is deleted as usual, and the booking goes when the booking computer syncs.
  await win.keyboard.press('Escape');
  await setBooking(state(false));
  await event('Intro call').click();
  await expect(card().locator('[data-pop="delete"]')).toHaveAttribute('title', 'Delete (Delete)');
  await win.keyboard.press('Delete');
  await expect(win.locator('.dialog h2')).toHaveText('Delete this booked event?');
  await expect(win.locator('.dialog')).toContainText('The booking is cancelled when Office PC, which handles your bookings, syncs next.');
  await win.locator('.dialog .buttons button.danger').click();
  await expect(toast()).toHaveText('Event deleted');
  await expect.poll(() => storedOne('Intro call')).toBeNull();
  expect(await bookingCalls()).toHaveLength(1);
});

test("the overlap notice asks before it cancels a booking, and a booked event that is over is deleted as an ordinary one", async () => {
  await openCalendar();
  await fakeBooking();
  const accountId = await demoAccount();
  const thursday = await column(3).evaluate((el) => Number(el.dataset.calCol));
  const start = await timeOn(thursday, 12);
  const guest = { name: 'Jane Doe', email: 'jane@example.com', notes: '', timeZone: 'Europe/Amsterdam', locale: 'en', via: '' };
  const booking = { id: 'Ov3rAAAAAAAAAAAAAAAAAA', status: 'confirmed', type: 'intro', typeTitle: 'Intro call', start, end: start + 1800000, channel: 'web', eventId: null, guest, customLength: false };
  const device = { id: 'd1', name: 'Office PC', current: true };
  const overlap = { id: `overlap:${booking.id}`, kind: 'overlap', tone: 'warn', bookingId: booking.id, title: 'A booking overlaps another event', text: 'Keep both, or cancel the booking.', actions: [{ action: 'keep', label: 'Keep' }, { action: 'cancel', label: 'Cancel booking' }, { action: 'open', label: 'Open' }] };
  await win.evaluate(async (state) => (await import('./calendar-free.js')).applyBooking(state), { status: 'on', thisDevice: true, device, bookings: [booking], requests: [], notices: [overlap] });
  const notice = win.locator('.cal-notice', { hasText: 'A booking overlaps another event' });
  await notice.locator('button', { hasText: 'Cancel booking' }).click();
  await expect(win.locator('.dialog h2')).toHaveText('Cancel this booking?');
  await expect(win.locator('.dialog')).toContainText('Jane Doe gets a cancellation for');
  await win.locator('.dialog .buttons button', { hasText: 'Keep booking' }).click();
  await expect(win.locator('.dialog')).toHaveCount(0);
  expect(await bookingCalls()).toEqual([]);
  await notice.locator('button', { hasText: 'Cancel booking' }).click();
  await win.locator('.dialog .buttons button.danger').click();
  await expect(toast()).toHaveText('Booking cancelled');
  expect(await bookingCalls()).toEqual([[booking.id, 'cancel', { notify: true }]]);

  // Last week's booked meeting: Delete is a plain delete, and the booking isn't cancelled.
  const past = await shiftDays(start, -7);
  await app.evaluate(({}, [accountId, start]) => global.__semCalendars.create({ accountId, calendarId: 'personal', title: 'Last week intro', location: '', description: '', allDay: false, start, end: start + 1800000 }, { bookingId: 'Pa5tAAAAAAAAAAAAAAAAAA' }), [accountId, past]);
  await setBooking({ status: 'on', thisDevice: true, device, bookings: [{ ...booking, id: 'Pa5tAAAAAAAAAAAAAAAAAA', start: past, end: past + 1800000 }], requests: [] });
  await win.locator('.cal-days .cal-gutter').click();
  await win.keyboard.press('k');
  await scrollGrid(10);
  await event('Last week intro').click();
  await expect(card()).toContainText('Booked through your booking page');
  await expect(card().locator('[data-pop="delete"]')).toHaveAttribute('title', 'Delete (Delete)');
  await win.keyboard.press('Delete');
  await expect(win.locator('.dialog h2')).toHaveText('Delete this event?');
  await win.locator('.dialog .buttons button.danger').click();
  await expect(toast()).toHaveText('Event deleted');
  expect(await bookingCalls()).toHaveLength(1);
});

test('after "changed elsewhere" the guest and reminder added on top are saved, and a change only for the user asks nobody', async () => {
  await openCalendar();
  const monday = await column(0).evaluate((el) => Number(el.dataset.calCol));
  const iso = async (day, h) => new Date(await timeOn(await shiftDays(monday, day), h)).toISOString();
  await addGoogle([
    {
      id: 'gboard',
      summary: 'Board meeting',
      start: { dateTime: await iso(1, 9) },
      end: { dateTime: await iso(1, 10) },
      organizer: { email: 'me@example.com', self: true },
      attendees: [
        { email: 'me@example.com', self: true, organizer: true, responseStatus: 'accepted' },
        { email: 'ann@example.com', responseStatus: 'accepted' }
      ],
      reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 10 }] }
    }
  ]);
  await scrollGrid(8);
  await expect(event('Board meeting')).toBeVisible({ timeout: 10000 });
  await event('Board meeting').click();
  await card().locator('[data-pop="edit"]').click();
  await expect(form()).toBeVisible();
  // Someone changes the event in Google Calendar while the dialog is open.
  await app.evaluate(() => {
    const item = global.__fake.find('gboard');
    item.location = 'Room 4';
    item.etag = '"77"';
  });
  await form().locator('[name="title"]').fill('Board meeting v2');
  await save();
  await win.locator('.dialog .buttons button', { hasText: "Don't send" }).click();
  await expect(form().locator('[data-error]')).toHaveText(/changed elsewhere/);
  // The latest version with the user's change on top.
  await expect(form().locator('[name="location"]')).toHaveValue('Room 4');
  await expect(form().locator('[name="title"]')).toHaveValue('Board meeting v2');
  // A guest and a reminder, after the conflict.
  const input = form().locator('[data-guest-input]');
  await input.fill('bob@example.com');
  await input.press('Enter');
  await expect(form().locator('.cal-gchip')).toHaveCount(2);
  await openMore();
  await form().locator('[data-rem="0"]').selectOption('30');
  await save();
  await expect(win.locator('.dialog h2')).toHaveText('Send the change to the guests?');
  await win.locator('.dialog .buttons button', { hasText: "Don't send" }).click();
  await expect(form()).toHaveCount(0);
  const patch = (await googleRequests('PATCH')).pop();
  expect(patch.body.summary).toBe('Board meeting v2');
  expect(patch.body.attendees.map((a) => a.email)).toEqual(expect.arrayContaining(['ann@example.com', 'bob@example.com']));
  expect(patch.body.reminders.overrides).toEqual([{ method: 'popup', minutes: 30 }]);
  const kept = await app.evaluate(() => {
    const item = global.__fake.find('gboard');
    return { location: item.location, attendees: item.attendees.map((a) => a.email), reminders: item.reminders.overrides };
  });
  expect(kept.location).toBe('Room 4');
  expect(kept.attendees).toEqual(expect.arrayContaining(['ann@example.com', 'bob@example.com']));
  expect(kept.reminders).toEqual([{ method: 'popup', minutes: 30 }]);

  // Only a reminder: the guests don't hear about it, and nothing asks.
  await expect(event('Board meeting v2')).toBeVisible();
  await event('Board meeting v2').click();
  await card().locator('[data-pop="edit"]').click();
  await openMore();
  await form().locator('[data-rem="0"]').selectOption('60');
  const patches = (await googleRequests('PATCH')).length;
  await save();
  await expect(form()).toHaveCount(0);
  await expect.poll(async () => (await googleRequests('PATCH')).length).toBe(patches + 1);
  await expect(win.locator('.dialog')).toHaveCount(0);
  const last = (await googleRequests('PATCH')).pop();
  expect(last.query.sendUpdates).toBe('none');
  expect(last.body.reminders.overrides).toEqual([{ method: 'popup', minutes: 60 }]);
});

test('moving one occurrence of a "last Friday" series keeps the rule and offers this event alone', async () => {
  await openCalendar();
  await watchCalls();
  const accountId = await demoAccount();
  // Friday 29 January 2027 is its month's last Friday; the next one is 26 February.
  const first = await win.evaluate(() => new Date(2027, 0, 29, 15, 0).getTime());
  await win.evaluate(
    ([accountId, start]) => window.mail.call('calendarCreate', { accountId, calendarId: 'personal', title: 'Month close', location: '', description: '', allDay: false, start, end: start + 3600000, recurrence: 'FREQ=MONTHLY;BYDAY=-1FR;WKST=MO' }, { notify: false }),
    [accountId, first]
  );
  const feb = await win.evaluate(() => new Date(2027, 1, 26, 15, 0).getTime());
  // A stretch the store hasn't read yet can answer empty the first time.
  const occurrenceOn = (s) => win.evaluate((s) => window.mail.call('calendarView', { start: s - 86400000, end: s + 86400000 }).then((v) => v.events.find((e) => e.title === 'Month close') || null), s);
  await expect.poll(async () => (await occurrenceOn(feb))?.start).toBe(feb);
  const occurrence = await occurrenceOn(feb);
  await win.evaluate(async ([id, start]) => (await import('./calendar.js')).openEvent(id, start), [occurrence.id, feb]);
  await card().locator('[data-pop="edit"]').click();
  await openMore();
  const repeat = form().locator('[name="repeat"]');
  await expect(repeat).toHaveValue('monthlyLast');
  // This one meeting moves to Friday 19 February, which isn't in its month's last week: the series' rule stays.
  await set('startDate', '2027-02-19');
  await expect(repeat).toHaveValue('monthlyLast');
  await expect(repeat.locator('option:checked')).toHaveText('Monthly on the last Friday');
  await expect(form().locator('[data-extras-sum]')).toContainText('Monthly on the last Friday');
  await save();
  const choice = win.locator('.dialog .radio-row');
  await expect(choice).toHaveText(['This event', 'This and following events', 'All events in the series']);
  await choice.first().click();
  await expect(form()).toHaveCount(0);
  const [, input, opts] = (await callsTo('calendarUpdate')).pop();
  expect('recurrence' in input).toBe(false);
  expect(opts.scope).toBe('one');
  // The meeting moved; the series still meets on the last Fridays around it.
  const meetings = () =>
    win.evaluate(() =>
      window.mail.call('calendarView', { start: new Date(2027, 0, 1).getTime(), end: new Date(2027, 3, 1).getTime() }).then((v) => v.events.filter((e) => e.title === 'Month close').sort((a, b) => a.start - b.start))
    );
  const expected = await win.evaluate(() => [new Date(2027, 0, 29, 15).getTime(), new Date(2027, 1, 19, 15).getTime(), new Date(2027, 2, 26, 15).getTime()]);
  await expect.poll(async () => (await meetings()).map((e) => e.start)).toEqual(expected);
  const series = await win.evaluate((id) => window.mail.call('calendarSeries', id), (await meetings())[0].id);
  expect(series.rule).toMatch(/^FREQ=MONTHLY;BYDAY=-1FR(;WKST=MO)?$/);
});

test('a quick save on its way keeps the popover: a failure shows in it with the title, or as a toast once the view moved on', async () => {
  await openCalendar();
  await watchCalls();
  await scrollGrid(12);
  const at = await gridPoint(2, 14, 40);
  await win.mouse.click(at.x, at.y);
  await expect(quick()).toBeVisible();
  await win.keyboard.type('Lost title');
  await failNext('calendarCreate', 'The calendar refused it.', 1500);
  await win.keyboard.press('Enter');
  await expect(quick()).toHaveClass(/saving/);
  // Escape and a click elsewhere on the grid leave it while the save is on its way, and make no other event.
  await win.keyboard.press('Escape');
  await win.mouse.click(at.x + 300, at.y + 150);
  await expect(quick()).toHaveCount(1);
  await expect(quick().locator('[data-error]')).toHaveText('The calendar refused it.');
  await expect(quick()).not.toHaveClass(/saving/);
  await expect(quick().locator('[name="title"]')).toHaveValue('Lost title');
  await expect(quick().locator('[name="title"]')).toBeFocused();
  // Tried again, it saves.
  await win.keyboard.press('Enter');
  await expect(toast()).toHaveText('Event created');
  await expect(quick()).toHaveCount(0);
  await expect.poll(() => storedOne('Lost title')).not.toBeNull();

  // The week changes while a save is on its way: the popover goes with the old week, and the failure is a toast.
  const second = await gridPoint(3, 13, 10);
  await win.mouse.click(second.x, second.y);
  await expect(quick()).toBeVisible();
  await win.keyboard.type('Second try');
  await failNext('calendarCreate', 'The calendar refused it again.', 1500);
  await win.keyboard.press('Enter');
  await expect(quick()).toHaveClass(/saving/);
  await win.locator('[data-cal="next"]').click();
  await expect(quick()).toHaveCount(0);
  await expect(toast()).toHaveText('The calendar refused it again.');
});

test('the quick popover opens at its full height and stays, with its title, through a window resize', async () => {
  await openCalendar();
  await scrollGrid(8);
  // Note what the popover holds at the moment it shows.
  await win.evaluate(() => {
    window.__shown = null;
    const watch = new MutationObserver(() => {
      const q = document.querySelector('.cal-quick');
      if (!q || q.classList.contains('measuring')) return;
      window.__shown = { conflict: !q.querySelector('[data-conflict]').hidden };
      watch.disconnect();
    });
    watch.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
  });
  // Monday 10:30 to 11:30 overlaps the roadmap review: the conflict line is there when the popover shows.
  const at = await gridPoint(0, 10, 40);
  await win.mouse.click(at.x, at.y);
  await expect(win.locator('.cal-quick:not(.measuring)')).toBeVisible();
  expect(await win.evaluate(() => window.__shown)).toEqual({ conflict: true });
  const saveButton = quick().locator('[data-quick="save"]');
  const shown = await settledBox(saveButton);
  await win.waitForTimeout(600);
  expect(await saveButton.boundingBox()).toEqual(shown);

  // A narrower window keeps the popover, its title and the keyboard in it, inside the window.
  await win.keyboard.type('Half typed');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1100, 900));
  await expect.poll(() => win.evaluate(() => window.innerWidth)).toBeLessThan(1200);
  await win.waitForTimeout(300);
  await expect(quick()).toHaveCount(1);
  await expect(quick().locator('[name="title"]')).toHaveValue('Half typed');
  await expect(quick().locator('[name="title"]')).toBeFocused();
  const box = await settledBox(quick());
  expect(box.x + box.width).toBeLessThanOrEqual(await win.evaluate(() => window.innerWidth));

  // A drag's popover keeps its ghost through a resize, and still saves there.
  await win.keyboard.press('Escape');
  await expect(quick()).toHaveCount(0);
  await drag(await gridPoint(2, 14, 5), await gridPoint(2, 15, 20));
  await expect(quick()).toBeVisible();
  await win.keyboard.type('Dragged block');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1300, 900));
  await expect.poll(() => win.evaluate(() => window.innerWidth)).toBeGreaterThan(1200);
  await win.waitForTimeout(300);
  await expect(quick()).toHaveCount(1);
  await expect(win.locator('.cal-ghost')).toHaveCount(1);
  await win.keyboard.press('Enter');
  await expect(event('Dragged block')).toContainText('14:00 – 15:30');
  await expect(win.locator('.cal-ghost')).toHaveCount(0);
});

test('a meeting on a CalDAV calendar whose server sends the invitations saves without asking about them', async () => {
  // Floating times, so the meeting sits at this hour whatever the PC's time zone is.
  const server = await caldavServer({
    scheduling: true,
    objects: {
      'home/supplier.ics': ics('UID:supplier', `DTSTART:${icsDay(3)}T140000`, `DTEND:${icsDay(3)}T150000`, 'SUMMARY:Supplier review', 'ORGANIZER;CN=Me:mailto:me@example.com', 'ATTENDEE;CN=Me;PARTSTAT=ACCEPTED:mailto:me@example.com', 'ATTENDEE;CN=Joris Bakker;PARTSTAT=ACCEPTED:mailto:joris@example.com')
    }
  });
  try {
    await openCalendar();
    await watchCalls();
    await addCaldav(server);
    await scrollGrid(12);
    await expect(event('Supplier review')).toBeVisible({ timeout: 15000 });
    await event('Supplier review').click();
    await card().locator('[data-pop="edit"]').click();
    await form().locator('[name="title"]').fill('Supplier review round 2');
    const input = form().locator('[data-guest-input]');
    await input.fill('new.person@example.com');
    await input.press('Enter');
    await expect(form().locator('.cal-gchip')).toHaveCount(2);
    await save();
    // Saved without a question in between: the server emails the guests whatever Rukoo says.
    await expect(form()).toHaveCount(0);
    await expect.poll(() => (server.object('home/supplier.ics') || { data: '' }).data).toContain('SUMMARY:Supplier review round 2');
    await expect(win.locator('.dialog')).toHaveCount(0);
    expect(server.object('home/supplier.ics').data).toContain('mailto:new.person@example.com');
    const [, , opts] = (await callsTo('calendarUpdate')).pop();
    expect(opts.notify).toBe(true);
    expect(server.sent.filter((s) => s.method === 'REQUEST').map((s) => s.to)).toEqual(expect.arrayContaining(['new.person@example.com']));
  } finally {
    await server.close();
  }
});
