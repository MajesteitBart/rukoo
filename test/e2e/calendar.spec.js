// The calendar view in the real app, on the demo account's calendar.
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { tempDir, removeDir } = require('../tmp');
const { closeApp } = require('./close');

let app;
let win;
let dataDir;

// Starts Rukoo on the test's profile.
async function launch() {
  // A Google OAuth client makes the reconnect notice appear; nothing here signs in.
  const env = { ...process.env, SEM_DATA_DIR: dataDir, SEM_HIDDEN: '1', SEM_GOOGLE_CLIENT_ID: 'test-client.apps.googleusercontent.com', SEM_GOOGLE_CLIENT_SECRET: 'test-secret' };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: ['.'], cwd: path.join(__dirname, '..', '..'), env });
  win = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1500, 950));
}

test.beforeEach(async () => {
  dataDir = tempDir('sem-e2e-cal-');
  await launch();
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

async function openCalendar() {
  await win.click('[data-mode="calendar"]');
  await expect(win.locator('.calendar')).toBeVisible();
  await expect(event('Roadmap review')).toBeVisible({ timeout: 10000 });
}

test('switches between mail and calendar, by the sidebar and by Ctrl+1 and Ctrl+2', async () => {
  await openCalendar();
  await expect(win.locator('.listpane')).toBeHidden();
  await expect(win.locator('[data-mode="calendar"]')).toHaveAttribute('aria-selected', 'true');
  // Screen readers hear what the sidebar holds now.
  await expect(win.locator('.sidebar')).toHaveAttribute('aria-label', 'Calendars');
  await expect(win.locator('.sidebar .cal-toggle')).toHaveCount(3);
  await expect(win.locator('.cal-dayhead')).toHaveCount(7);
  await expect(win.locator('.cal-dayhead.today')).toHaveCount(1);

  await win.keyboard.press('Control+1');
  await expect(win.locator('.listpane')).toBeVisible();
  await expect(win.locator('.sidebar')).toHaveAttribute('aria-label', 'Folders');
  await expect(win.locator('.calendar')).toBeHidden();
  await win.keyboard.press('Control+2');
  await expect(win.locator('.calendar')).toBeVisible();

  // The mode survives a restart of the window.
  await win.reload();
  await expect(win.locator('.calendar')).toBeVisible({ timeout: 10000 });
  await expect(event('Roadmap review')).toBeVisible();
});

test('answers an invitation from its card', async () => {
  await openCalendar();
  const invite = event('Quarterly planning');
  await expect(invite).toHaveClass(/needs/);
  await invite.click();
  await expect(card().locator('h2')).toHaveText('Quarterly planning');
  await expect(card()).toContainText('3 guests');
  await expect(card()).toContainText('Joris Bakker');
  await card().locator('[data-rsvp="accepted"]').click();
  await expect(win.locator('#toast')).toHaveText('Invitation accepted');
  await expect(card().locator('[data-rsvp="accepted"]')).toHaveClass(/active/);
  await expect(invite).not.toHaveClass(/needs/);
  await win.keyboard.press('Escape');
  await expect(card()).toHaveCount(0);

  // A series asks whether the answer is for this one event or all of them.
  await event('Stand-up').click();
  await card().locator('[data-rsvp="declined"]').click();
  await win.locator('.radio-row', { hasText: 'All events in the series' }).click();
  await expect(win.locator('#toast')).toHaveText('Invitation declined');
  await win.keyboard.press('Escape');
  await expect(win.locator('.calendar .cal-ev.declined', { hasText: 'Stand-up' })).toHaveCount(5);
});

test('creates, edits and deletes an event', async () => {
  await openCalendar();
  await win.click('[data-cal="new"]');
  await win.fill('.cal-form [name="title"]', 'Gym class');
  await win.fill('.cal-form [name="startTime"]', '18:00');
  await win.locator('.cal-form [name="startTime"]').dispatchEvent('change');
  // Moving the start moves the end along: the event keeps its hour.
  await expect(win.locator('.cal-form [name="endTime"]')).toHaveValue('19:00');
  await win.fill('.cal-form [name="location"]', 'Sportcentrum');
  await win.click('.dialog .buttons button.primary');
  await expect(win.locator('#toast')).toHaveText('Event created');
  await expect(event('Gym class')).toContainText('18:00 – 19:00');

  await event('Gym class').click();
  await card().locator('[data-pop="edit"]').click();
  await expect(win.locator('.cal-form [name="title"]')).toHaveValue('Gym class');
  await win.fill('.cal-form [name="title"]', 'Yoga class');
  await win.fill('.cal-form [name="endTime"]', '17:00');
  await win.click('.dialog .buttons button.primary');
  await expect(win.locator('.cal-form .error')).toHaveText('The event ends before it starts.');
  await win.fill('.cal-form [name="endTime"]', '19:30');
  await win.keyboard.press('Enter');
  await expect(event('Yoga class')).toContainText('18:00 – 19:30');
  await expect(event('Gym class')).toHaveCount(0);

  await event('Yoga class').click();
  await win.keyboard.press('Delete');
  await win.locator('.dialog .buttons button.danger').click();
  await expect(win.locator('#toast')).toHaveText('Event deleted');
  await expect(event('Yoga class')).toHaveCount(0);

  // An event with guests in the demo account changes without asking to email them: nobody gets those emails.
  await event('Roadmap review').click();
  await card().locator('[data-pop="edit"]').click();
  await win.fill('.cal-form [name="title"]', 'Roadmap review (moved)');
  await win.click('.dialog .buttons button.primary');
  await expect(event('Roadmap review (moved)')).toBeVisible();
  await expect(win.locator('.dialog')).toHaveCount(0);

  // A one-day all-day event turned into a timed one becomes nine to ten instead of ending where it starts.
  await win.locator('.cal-allday-cell').first().click();
  // A click or drag on the grid opens the quick popover (calendar-event.js); More options opens the dialog with its times.
  await win.locator('.cal-quick [data-quick="more"]').click();
  await expect(win.locator('.cal-form [name="allDay"]')).toBeChecked();
  await win.fill('.cal-form [name="title"]', 'Workshop prep');
  await win.uncheck('.cal-form [name="allDay"]');
  await expect(win.locator('.cal-form [name="startTime"]')).toHaveValue('09:00');
  await expect(win.locator('.cal-form [name="endTime"]')).toHaveValue('10:00');
  await expect(win.locator('.cal-form [name="endDate"]')).toHaveValue(await win.locator('.cal-form [name="startDate"]').inputValue());
  await win.click('.dialog .buttons button.primary');
  await expect(win.locator('.cal-form')).toHaveCount(0);
  await expect(event('Workshop prep')).toContainText('09:00 – 10:00');

  // An empty spot in the grid starts an event at that half hour.
  await win.locator('.cal-scroll').evaluate((el) => (el.scrollTop = 0));
  const col = win.locator('.cal-col').nth(2);
  const box = await col.boundingBox();
  await win.mouse.click(box.x + 20, box.y + 6 * 56 + 30);
  // A click or drag on the grid opens the quick popover (calendar-event.js); More options opens the dialog with its times.
  await win.locator('.cal-quick [data-quick="more"]').click();
  await expect(win.locator('.cal-form [name="startTime"]')).toHaveValue('06:30');
  await expect(win.locator('.cal-form [name="endTime"]')).toHaveValue('07:30');
  await win.keyboard.press('Escape');
  await expect(win.locator('.cal-form')).toHaveCount(0);
});

test('hides a calendar, switches views and moves through the weeks by keyboard', async () => {
  await openCalendar();
  const work = win.locator('.sidebar .cal-toggle', { hasText: 'Work' });
  await work.click();
  await expect(work).toHaveAttribute('aria-checked', 'false');
  await expect(event('Quarterly planning')).toHaveCount(0);
  await expect(event('Lunch with Sanne')).toBeVisible();
  await work.click();
  await expect(event('Quarterly planning')).toBeVisible();

  const title = win.locator('.cal-title');
  const thisWeek = await win.locator('.cal-dayhead').first().getAttribute('data-cal-day');
  // The keyboard leaves the sidebar: a click on the empty corner above the hours (the title opens Go to date).
  await win.locator('.cal-days .cal-gutter').click();
  await win.keyboard.press('ArrowRight');
  await expect(win.locator('.cal-dayhead').first()).not.toHaveAttribute('data-cal-day', thisWeek);
  await expect(event('KL1691 Amsterdam to Lisbon')).toBeVisible();
  await win.keyboard.press('t');
  await expect(win.locator('.cal-dayhead').first()).toHaveAttribute('data-cal-day', thisWeek);

  await win.keyboard.press('d');
  await expect(win.locator('.cal-dayhead')).toHaveCount(1);
  await expect(win.locator('[data-cal-view="day"]')).toHaveAttribute('aria-selected', 'true');
  await win.keyboard.press('u');
  await expect(title).toHaveText('Upcoming');
  await expect(win.locator('.cal-list-day').first()).toBeVisible();
  const flight = win.locator('.cal-row', { hasText: 'KL1691 Amsterdam to Lisbon' });
  await expect(flight).toBeVisible();
  // A row hangs from its first line: the time and the title start at the same height.
  const tops = await flight.evaluate((row) => [row.querySelector('.cal-row-time > span').getBoundingClientRect().top, row.querySelector('.cal-row-title').getBoundingClientRect().top]);
  expect(Math.abs(tops[0] - tops[1])).toBeLessThan(1);
  await expect(flight.locator('.cal-row-time .rel')).toHaveText('2 hrs, 40 mins');
  await expect(flight.locator('.cal-row-sub')).toContainText('Amsterdam Airport Schiphol');
  // The stand-up's guests besides the user show as faces.
  await expect(win.locator('.cal-row', { hasText: 'Stand-up' }).first().locator('.cal-people .avatar')).toHaveCount(2);
  await win.click('[data-cal-view="week"]');
  await expect(win.locator('.cal-dayhead')).toHaveCount(7);

  await win.keyboard.press('n');
  await expect(win.locator('.cal-form')).toBeVisible();
  await win.keyboard.press('Escape');
});

test('a calendar gets another colour from its menu in the sidebar, everywhere it shows and after a restart', async () => {
  await openCalendar();
  const toggle = (name) => win.locator('.sidebar .cal-toggle', { hasText: name });
  const varOf = (locator) => locator.evaluate((el) => el.style.getPropertyValue('--c'));
  const check = (name) => varOf(toggle(name).locator('.cal-check'));
  const colour = (title) => varOf(event(title));
  // The page changes with the restart below; each lookup goes to the current one.
  const menu = () => win.locator('.menu');
  // The demo's calendars have no colour of their own, so they show in the account's.
  expect(await check('Work')).toBe('#2fd6c0');
  expect(await colour('Roadmap review')).toBe('#2fd6c0');

  // Without a pick, Default color has nothing to undo; its dot shows the colour it goes back to.
  const fallback = () => menu().locator('button', { hasText: 'Default color' });
  await toggle('Work').click({ button: 'right' });
  await expect(fallback()).toBeDisabled();
  expect(await varOf(fallback().locator('.mi .cal-dot'))).toBe('#2fd6c0');
  await expect(menu().locator('[aria-checked="true"][data-color="#2fd6c0"]')).toBeFocused();
  await menu().locator('.cal-swatch-btn[aria-label="Purple"]').click();
  await expect(menu()).toHaveCount(0);
  // Work's events, its box in the sidebar, its events' cards and the new-event dialog take the colour. The other
  // calendars keep theirs, and the calendar stays shown.
  await expect.poll(() => colour('Roadmap review')).toBe('#c56cf0');
  expect(await check('Work')).toBe('#c56cf0');
  await expect(toggle('Work')).toHaveAttribute('aria-checked', 'true');
  expect(await colour('Lunch with Sanne')).toBe('#2fd6c0');
  expect(await colour('Team offsite')).toBe('#c56cf0');
  await event('Roadmap review').click();
  expect(await varOf(card().locator('.cal-swatch'))).toBe('#c56cf0');
  expect(await varOf(card().locator('.cal-pop-row .cal-dot'))).toBe('#c56cf0');
  await win.keyboard.press('Escape');
  await win.click('[data-cal="new"]');
  const work = await win.locator('.cal-form [name="calendar"] option', { hasText: 'Work' }).getAttribute('value');
  await win.selectOption('.cal-form [name="calendar"]', work);
  await expect.poll(() => varOf(win.locator('.cal-form .cal-pick'))).toBe('#c56cf0');
  await win.keyboard.press('Escape');
  await win.keyboard.press('u');
  await expect.poll(() => varOf(win.locator('.cal-row', { hasText: 'Quarterly planning follow-up' }))).toBe('#c56cf0');
  await win.keyboard.press('w');

  // The colour is kept with the calendar's other choices, and is still there after a restart.
  await closeApp(app);
  await launch();
  await expect(event('Roadmap review')).toBeVisible({ timeout: 15000 });
  expect(await colour('Roadmap review')).toBe('#c56cf0');
  expect(await check('Work')).toBe('#c56cf0');

  // From the keyboard, the menu key opens the same menu on the calendar that has the focus, at its colour. Default
  // color, just above the last item, goes back to the account's colour, and the focus returns to the calendar.
  await toggle('Work').focus();
  await win.keyboard.press('Shift+F10');
  await expect(menu().locator('[aria-checked="true"][data-color="#c56cf0"]')).toBeFocused();
  expect(await varOf(fallback().locator('.mi .cal-dot'))).toBe('#2fd6c0');
  await win.keyboard.press('End');
  await win.keyboard.press('ArrowUp');
  await expect(fallback()).toBeFocused();
  await win.keyboard.press('Enter');
  await expect.poll(() => colour('Roadmap review')).toBe('#2fd6c0');
  expect(await check('Work')).toBe('#2fd6c0');
  await expect(toggle('Work')).toBeFocused();
});

// The next clock changes in the PC's time zone, found in the window: the night that has an hour twice (a day of
// 25 hours) and the day of 23 hours. Null where the zone has no clock changes.
const clockChanges = () =>
  win.evaluate(() => {
    const midnight = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const out = { back: null, forward: null };
    const day = new Date();
    for (let i = 0; i < 400 && (!out.back || !out.forward); i++) {
      const start = midnight(day);
      day.setDate(day.getDate() + 1);
      const hours = (midnight(day) - start) / 3600000;
      if (hours === 25 && !out.back) out.back = start;
      if (hours === 23 && !out.forward) out.forward = start;
    }
    return out;
  });

test('renaming an event in the hour the clocks go back keeps its time', async () => {
  await openCalendar();
  const { back } = await clockChanges();
  test.skip(!back, 'the time zone has no clock changes');
  // The second time the clock shows the repeated hour: an hour after the first.
  const second = await win.evaluate((day) => {
    for (let t = day; t < day + 25 * 3600000; t += 900000) {
      const a = new Date(t);
      const b = new Date(t + 3600000);
      if (a.getHours() === b.getHours() && a.getMinutes() === b.getMinutes()) return t + 3600000;
    }
    return null;
  }, back);
  await win.evaluate(
    ([start]) => window.mail.call('calendarCreate', { accountId: document.querySelector('.sidebar [data-cal-toggle]').dataset.calToggle.split('\n')[0], calendarId: 'personal', title: 'Night shift', allDay: false, start, end: start + 3600000 }),
    [second]
  );
  // Walk to that week.
  const weeks = await win.evaluate((target) => {
    const first = Number(document.querySelector('.cal-dayhead').dataset.calDay);
    return Math.floor((target - first) / (7 * 86400000));
  }, back);
  await win.locator('.cal-days .cal-gutter').click();
  for (let i = 0; i < weeks; i++) await win.keyboard.press('j');
  await event('Night shift').click({ timeout: 15000 });
  await card().locator('[data-pop="edit"]').click();
  await win.fill('.cal-form [name="title"]', 'Night shift (renamed)');
  await win.click('.dialog .buttons button.primary');
  await expect(event('Night shift (renamed)')).toBeVisible();
  const saved = await win.evaluate(
    (range) => window.mail.call('calendarView', range).then((v) => v.events.find((e) => e.title === 'Night shift (renamed)')),
    { start: back, end: back + 2 * 86400000 }
  );
  expect(saved.start).toBe(second);
  expect(saved.end).toBe(second + 3600000);

  // Moving it keeps its real length of an hour, though the clock showed its start twice.
  await event('Night shift (renamed)').click();
  await card().locator('[data-pop="edit"]').click();
  await win.fill('.cal-form [name="startTime"]', '04:00');
  await win.locator('.cal-form [name="startTime"]').dispatchEvent('change');
  await expect(win.locator('.cal-form [name="endTime"]')).toHaveValue('05:00');
  await win.keyboard.press('Escape');
});

test('moving an all-day event over the day the clocks go forward keeps its number of days', async () => {
  await openCalendar();
  const { forward } = await clockChanges();
  test.skip(!forward, 'the time zone has no clock changes');
  const day = (offset) => win.evaluate(([d, n]) => {
    const x = new Date(d);
    x.setDate(x.getDate() + n);
    return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
  }, [forward, offset]);
  await win.click('[data-cal="new"]');
  await win.check('.cal-form [name="allDay"]');
  const set = async (name, value) => {
    await win.fill(`.cal-form [name="${name}"]`, value);
    await win.locator(`.cal-form [name="${name}"]`).dispatchEvent('change');
  };
  // Three days around the 23-hour day, then three days later.
  await set('startDate', await day(-1));
  await set('endDate', await day(1));
  await set('startDate', await day(4));
  await expect(win.locator('.cal-form [name="endDate"]')).toHaveValue(await day(6));
  await win.keyboard.press('Escape');
});

test("a card opened at a multi-day event's later day stays with that day while the list scrolls", async () => {
  await openCalendar();
  await win.evaluate(() => {
    const d = new Date();
    const day = (n) => {
      const x = new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
      return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
    };
    const accountId = document.querySelector('.sidebar [data-cal-toggle]').dataset.calToggle.split('\n')[0];
    return window.mail.call('calendarCreate', { accountId, calendarId: 'personal', title: 'Holiday in Lisbon', allDay: true, startDate: day(1), endDate: day(4) });
  });
  await win.keyboard.press('u');
  const rows = win.locator('.cal-row', { hasText: 'Holiday in Lisbon' });
  await expect(rows).toHaveCount(3);
  // In the middle of the list, whatever the demo has on the days before: near the window's bottom a card moves up
  // to fit, and would sit beside neither row.
  await rows.nth(1).evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await rows.nth(1).click();
  await expect(card()).toBeVisible();
  await win.locator('.cal-scroll').evaluate((el) => (el.scrollTop += 1));
  await win.waitForTimeout(200);
  await expect(card()).toBeVisible();
  await expect(rows.nth(1)).toHaveClass(/\bopen\b/);
  // The card sits beside the row that was clicked, not beside the event's first day.
  const top = async (locator) => (await locator.boundingBox()).y;
  expect(Math.abs((await top(card())) - (await top(rows.nth(1))))).toBeLessThan(2);
  await win.keyboard.press('Escape');
  await expect(card()).toHaveCount(0);
  await expect(rows.nth(1)).toBeFocused();
});

// A Google account in the main process, its token cached and Google Calendar replaced by a stand-in.
async function addGoogleAccount() {
  await app.evaluate(() => {
    const engine = global.__semEngine;
    const monday = new Date();
    monday.setHours(0, 0, 0, 0);
    monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
    const at = (day, h) => new Date(monday.getTime() + day * 86400000 + h * 3600000).toISOString();
    const store = [
      { id: 'g1', etag: '"1"', summary: 'Board meeting', start: { dateTime: at(1, 9), timeZone: 'Europe/Amsterdam' }, end: { dateTime: at(1, 10) }, organizer: { email: 'work@gmail.com', self: true } },
      {
        id: 'g2',
        etag: '"1"',
        summary: 'Partner call',
        start: { dateTime: at(3, 13) },
        end: { dateTime: at(3, 14) },
        organizer: { email: 'partner@example.com' },
        attendees: [{ email: 'partner@example.com', organizer: true, responseStatus: 'accepted' }, { email: 'work@gmail.com', self: true, responseStatus: 'needsAction' }]
      },
      // A flight Gmail found in a booking email: Google takes no new title or times for it, and locks it.
      { id: 'g3', etag: '"1"', eventType: 'fromGmail', locked: true, summary: 'Flight to Lisbon', start: { dateTime: at(4, 7) }, end: { dateTime: at(4, 9) }, organizer: { email: 'work@gmail.com', self: true } },
      { id: 'f1', etag: '"1"', calendarId: 'family@group.calendar.google.com', summary: 'School play', start: { dateTime: at(2, 16) }, end: { dateTime: at(2, 17) }, organizer: { email: 'work@gmail.com', self: true } }
    ];
    global.__google = { store, requests: [] };
    const json = (status, body) => ({ ok: status < 300, status, json: async () => body });
    let version = 1;
    // Two calendars, each in the colour it has in Google Calendar.
    const calendarList = [
      { id: 'work@gmail.com', summary: 'work@gmail.com', primary: true, accessRole: 'owner', selected: true, backgroundColor: '#16a765' },
      { id: 'family@group.calendar.google.com', summary: 'Family', accessRole: 'owner', selected: true, backgroundColor: '#9a9cff' }
    ];
    global.__semCalendars.fetch = async (url, opts = {}) => {
      const u = new URL(url);
      const method = opts.method || 'GET';
      const body = opts.body ? JSON.parse(opts.body) : null;
      const ifMatch = opts.headers['if-match'] || null;
      global.__google.requests.push({ method, path: decodeURIComponent(u.pathname), query: Object.fromEntries(u.searchParams), body, ifMatch });
      if (u.pathname.endsWith('/users/me/calendarList')) return json(200, { items: calendarList });
      const calendarId = decodeURIComponent((u.pathname.match(/\/calendars\/([^/]+)\/events/) || [])[1] || '');
      const id = decodeURIComponent(u.pathname.split('/events/')[1] || '');
      if (!id && method === 'GET') return json(200, { items: store.filter((e) => (e.calendarId || 'work@gmail.com') === calendarId) });
      if (!id && method === 'POST') {
        const item = { ...body, calendarId, id: `n${store.length}`, etag: `"${++version}"`, organizer: { email: 'work@gmail.com', self: true } };
        store.push(item);
        return json(200, item);
      }
      const item = store.find((e) => e.id === id);
      if (!item) return json(404, { error: { code: 404, message: 'Not Found' } });
      if (method === 'GET') return json(200, item);
      // A change sent for an older version than this one, as Google answers it.
      if (ifMatch && ifMatch !== item.etag) return json(412, { error: { code: 412, message: 'Precondition Failed' } });
      if (method === 'PATCH') return json(200, Object.assign(item, body, { etag: `"${++version}"` }));
      if (method === 'DELETE') {
        store.splice(store.indexOf(item), 1);
        return { ok: true, status: 204, json: async () => ({}) };
      }
      return json(400, {});
    };
    engine.accounts.push({
      id: 'g-work',
      type: 'imap',
      provider: 'google',
      auth: 'oauth2',
      email: 'work@gmail.com',
      name: 'Work account',
      color: '#ff8a3d',
      secret: 'plain:',
      scopes: ['https://mail.google.com/', 'https://www.googleapis.com/auth/calendar.calendarlist.readonly', 'https://www.googleapis.com/auth/calendar.events'],
      imap: { host: 'imap.gmail.com', port: 993, secure: true, user: 'work@gmail.com' },
      smtp: { host: 'smtp.gmail.com', port: 465, secure: true, user: 'work@gmail.com' }
    });
    engine.caches.set('g-work', { folders: [], boxes: {}, lastSync: null });
    engine.tokens.set('g-work', { accessToken: 'token', expiresAt: Date.now() + 3600000 });
    engine.emit('updated');
  });
}

test('a Google calendar shows beside the demo calendar in its own colour, and changes reach Google', async () => {
  await openCalendar();
  await addGoogleAccount();
  const board = event('Board meeting');
  await expect(board).toBeVisible({ timeout: 10000 });
  // Each calendar in its own colour: the Google calendars in theirs from Google, the demo's in the account's.
  const colour = (title) => event(title).evaluate((el) => el.style.getPropertyValue('--c'));
  expect(await colour('Board meeting')).toBe('#16a765');
  expect(await colour('School play')).toBe('#9a9cff');
  expect(await colour('Roadmap review')).toBe('#2fd6c0');
  await expect(win.locator('.sidebar .nav-section', { hasText: 'work@gmail.com' })).toBeVisible();
  // The primary calendar carries the account's name rather than its address again.
  await expect(win.locator('.sidebar .cal-toggle', { hasText: 'Work account' })).toHaveCount(1);

  // A new event goes to the calendar chosen in the dialog.
  await win.click('[data-cal="new"]');
  await win.fill('.cal-form [name="title"]', 'Hiring sync');
  const value = await win.locator('.cal-form [name="calendar"] optgroup[label="work@gmail.com"] option', { hasText: 'Work account' }).getAttribute('value');
  await win.selectOption('.cal-form [name="calendar"]', value);
  await win.click('.dialog .buttons button.primary');
  await expect(event('Hiring sync')).toBeVisible();
  const posts = await app.evaluate(() => global.__google.requests.filter((r) => r.method === 'POST'));
  expect(posts).toHaveLength(1);
  expect(posts[0].path).toBe('/calendar/v3/calendars/work@gmail.com/events');
  expect(posts[0].body.summary).toBe('Hiring sync');

  // A change made in Google Calendar shows after the next sync.
  await app.evaluate(() => (global.__google.store[0].summary = 'Board meeting (moved room)'));
  await win.locator('.cal-days .cal-gutter').click();
  await win.keyboard.press('F5');
  await expect(event('Board meeting (moved room)')).toBeVisible({ timeout: 10000 });

  // Accepting an invitation updates the answer in Google.
  await event('Partner call').click();
  await card().locator('[data-rsvp="accepted"]').click();
  await expect(win.locator('#toast')).toHaveText('Invitation accepted');
  const patch = await app.evaluate(() => global.__google.requests.filter((r) => r.method === 'PATCH').pop());
  expect(patch.query.sendUpdates).toBe('all');
  expect(patch.body.attendees.find((a) => a.self).responseStatus).toBe('accepted');
});

test('an event Gmail made can be deleted from its card, but not edited', async () => {
  await openCalendar();
  await addGoogleAccount();
  await event('Flight to Lisbon').click();
  await expect(card().locator('[data-pop="delete"]')).toBeVisible();
  await expect(card().locator('[data-pop="edit"]')).toHaveCount(0);
  // E doesn't open the dialog either. Delete asks first, then deletes the event in Google.
  await win.keyboard.press('e');
  await expect(win.locator('.cal-form')).toHaveCount(0);
  await win.keyboard.press('Delete');
  await win.locator('.dialog .buttons button.danger').click();
  await expect(win.locator('#toast')).toHaveText('Event deleted');
  await expect(event('Flight to Lisbon')).toHaveCount(0);
  const del = await app.evaluate(() => global.__google.requests.find((r) => r.method === 'DELETE'));
  expect(del.path).toBe('/calendar/v3/calendars/work@gmail.com/events/g3');
  expect(del.ifMatch).toBe('"1"');
});

test("a change made in Google while the dialog is open is kept, and the next Save puts the user's changes on top", async () => {
  await openCalendar();
  await addGoogleAccount();
  await event('Board meeting').click();
  await card().locator('[data-pop="edit"]').click();
  await win.fill('.cal-form [name="title"]', 'Board meeting (budget)');
  // Meanwhile someone moves the meeting to next week, in another room, in Google Calendar.
  const moved = await app.evaluate(() => {
    const e = global.__google.store[0];
    const week = (t) => new Date(Date.parse(t) + 7 * 86400000).toISOString();
    Object.assign(e, { location: 'Room 4.2', etag: '"40"', start: { ...e.start, dateTime: week(e.start.dateTime) }, end: { ...e.end, dateTime: week(e.end.dateTime) } });
    return e.start.dateTime;
  });
  const day = new Date(moved);
  const movedDate = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
  await win.click('.dialog .buttons button.primary');
  await expect(win.locator('.cal-form .error')).toContainText('changed elsewhere while you edited it');
  await expect(win.locator('.cal-form [name="title"]')).toHaveValue('Board meeting (budget)');
  await expect(win.locator('.cal-form [name="location"]')).toHaveValue('Room 4.2');
  await expect(win.locator('.cal-form [name="startDate"]')).toHaveValue(movedDate);
  expect(await app.evaluate(() => global.__google.store[0].summary)).toBe('Board meeting');

  await win.click('.dialog .buttons button.primary');
  await expect(win.locator('.dialog')).toHaveCount(0);
  await expect(event('Board meeting (budget)')).toBeVisible();
  const saved = await app.evaluate(() => global.__google.store[0]);
  expect([saved.summary, saved.location, saved.start.dateTime]).toEqual(['Board meeting (budget)', 'Room 4.2', moved]);
  const versions = await app.evaluate(() => global.__google.requests.filter((r) => r.method === 'PATCH').map((r) => r.ifMatch));
  expect(versions).toEqual(['"1"', '"40"']);

  // A deletion is refused as well when the event changed in Google since Rukoo loaded it, and the change shows.
  await app.evaluate(() => Object.assign(global.__google.store[0], { summary: 'Board meeting (renamed in Google)', etag: '"41"' }));
  await event('Board meeting (budget)').click();
  await win.keyboard.press('Delete');
  await win.locator('.dialog .buttons button.danger').click();
  await expect(win.locator('#toast')).toContainText('changed elsewhere');
  await expect(event('Board meeting (renamed in Google)')).toBeVisible();
  expect(await app.evaluate(() => global.__google.store.some((e) => e.id === 'g1'))).toBe(true);
});

test('a Google account without calendar access offers to connect it instead of an error', async () => {
  await openCalendar();
  await app.evaluate(() => {
    const engine = global.__semEngine;
    engine.accounts.push({
      id: 'g-test',
      type: 'imap',
      provider: 'google',
      auth: 'oauth2',
      email: 'someone@gmail.com',
      color: '#ff8a3d',
      secret: 'plain:',
      scopes: ['https://mail.google.com/'],
      imap: { host: 'imap.gmail.com', port: 993, secure: true, user: 'someone@gmail.com' },
      smtp: { host: 'smtp.gmail.com', port: 465, secure: true, user: 'someone@gmail.com' }
    });
    engine.caches.set('g-test', { folders: [], boxes: {}, lastSync: null });
    engine.emit('updated');
  });
  // The account's own notice; the one-time notice about reminders may show beside it.
  const notice = win.locator('.cal-notice', { hasText: 'someone@gmail.com' });
  await expect(notice).toContainText('Show the calendar of someone@gmail.com', { timeout: 10000 });
  await expect(notice.locator('[data-cal-reconnect="g-test"]')).toHaveText('Connect calendar');
  await expect(win.locator('.sidebar [data-cal-reconnect="g-test"]')).toBeVisible();
  await expect(win.locator('.cal-notice.error')).toHaveCount(0);
  await notice.locator('[data-cal-dismiss]').click();
  await expect(notice).toHaveCount(0);
  await expect(win.locator('.sidebar [data-cal-reconnect="g-test"]')).toBeVisible();
});
