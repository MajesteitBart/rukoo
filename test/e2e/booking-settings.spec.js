// Settings > Booking page in the real app, against the in-memory account server with its booking routes: signed out
// it leads to an account and back, one screen turns the page on, and then the meeting types, the hours, requests
// and bookings are handled from the page. The demo account is the destination calendar.
const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('path');
const { tempDir, removeDir } = require('../tmp');
const { closeApp } = require('./close');
const { startAccountServer } = require('../fixtures/account-server');

let app;
let win;
let dataDir;
let server;

const PASSWORD = 'a long enough password';
const HANDLE = 'demo-user';
const DAY = 86400000;

test.beforeEach(async () => {
  server = await startAccountServer();
  dataDir = tempDir('rukoo-booking-e2e-');
  const env = { ...process.env, SEM_DATA_DIR: dataDir, SEM_HIDDEN: '1', RUKOO_ACCOUNT_SERVER: server.url };
  delete env.ELECTRON_RUN_AS_NODE;
  // The session is stored with safeStorage, which needs the real keyring on Linux (see the IMAP tests).
  const entry = process.platform === 'linux' ? path.join(__dirname, '..', 'fixtures', 'linux-keyring-app.js') : '.';
  app = await electron.launch({ args: [entry], cwd: path.join(__dirname, '..', '..'), env });
  win = await app.firstWindow();
  await app.evaluate(({ BrowserWindow, shell }) => {
    BrowserWindow.getAllWindows()[0].setSize(1400, 950);
    // Preview page opens the browser; here it only notes the address.
    shell.openExternal = async (url) => {
      global.__opened = url;
    };
  });
  await win.waitForSelector('.provider-grid');
  await win.click('[data-s="demo"]');
  await expect(win.locator('.item').first()).toBeVisible({ timeout: 15000 });
});

test.afterEach(async () => {
  await closeApp(app);
  removeDir(dataDir);
  await server.close();
});

const page = () => win.locator('.page.settings');
const call = (method, ...args) => win.evaluate(([m, a]) => window.mail.call(m, ...a), [method, args]);
const booking = () => call('bookingState');
const published = () => server.pages.get(HANDLE);

async function openBookingPage() {
  await win.evaluate(() => document.querySelector('[data-action="settings"]').click());
  await page().locator('[data-a="booking-open"]').click();
  await expect(page().locator('h1')).toHaveText('Booking page');
}

// Signed up and the page on, through main, with one of the demo account's calendars (personal unless said) as the
// destination.
async function pageOn({ handle = HANDLE, timeZone = 'Europe/Amsterdam', calendar = 'personal' } = {}) {
  await call('accountSignUp', { email: 'host@example.com', password: PASSWORD, invite: '' });
  const accountId = (await call('state')).accounts[0].id;
  const state = await call('bookingEnable', { handle, name: 'Demo Host', timeZone, destination: `${accountId}\n${calendar}` });
  expect(state.status).toBe('on');
  return state;
}

// 10:00 on a weekday at least three days ahead, in this computer's zone.
function slot(days = 3, hour = 10) {
  const d = new Date(Date.now() + days * DAY);
  while ([0, 6].includes(d.getDay())) d.setDate(d.getDate() + 1);
  d.setHours(hour, 0, 0, 0);
  return d.getTime();
}

test('signed out, the page leads to a new account and back to the setup, which checks the handle and turns the page on', async () => {
  await openBookingPage();
  await expect(page().locator('.settings-text').first()).toContainText('It runs on your Rukoo account');
  await page().locator('[data-a="booking-account:rukoo-signup"]').click();
  const form = page().locator('form[data-form="rukoo-signup"]');
  await form.locator('[name="email"]').fill('host@example.com');
  await form.locator('[name="password"]').fill(PASSWORD);
  await form.locator('[name="repeat"]').fill(PASSWORD);
  await form.locator('[name="understand"]').check();
  await form.locator('button[type=submit]').click();
  await win.locator('.scrim .buttons button', { hasText: 'I saved it' }).click({ timeout: 20000 });

  // Back on the booking page, now the setup: the handle comes from the default account's name and is free.
  await expect(page().locator('h1')).toHaveText('Booking page');
  const setup = page().locator('form[data-form="booking-setup"]');
  await expect(setup).toBeVisible();
  await expect(setup.locator('[name="handle"]')).toHaveValue(HANDLE);
  await expect(setup.locator('[data-handle-status]')).toHaveText('Available');
  // The address before the handle, as the server reports it: this one keeps its pages under /meet.
  await expect(setup.locator('.booking-handle-base')).toHaveText(`${server.url.replace(/^https?:\/\//, '')}/meet/`);
  await expect(setup.locator('[name="name"]')).toHaveValue('Demo User');
  await expect(setup.locator('[data-destination-note]')).toHaveText("This calendar sends no invitations. Guests only get the booking page's confirmation.");
  // The handle is checked as it is typed.
  await setup.locator('[name="handle"]').fill('ab');
  await expect(setup.locator('[data-handle-status]')).toHaveText('3 to 32 lowercase letters, digits or hyphens.');
  await setup.locator('[name="handle"]').fill('api');
  await expect(setup.locator('[data-handle-status]')).toHaveText('This name is reserved');
  // Turning on with a bad handle marks the field and asks nothing of the server.
  await setup.locator('button[type=submit]').click();
  await expect(setup.locator('[name="handle"]')).toHaveAttribute('aria-invalid', 'true');
  await expect(setup.locator('[data-error]')).toHaveText('This name is reserved');
  expect(server.pages.size).toBe(0);

  await setup.locator('[name="handle"]').fill(HANDLE);
  await expect(setup.locator('[data-handle-status]')).toHaveText('Available');
  // Work doesn't count for this page.
  await setup.locator('.booking-cal', { hasText: 'Work' }).locator('input').uncheck();
  await setup.locator('button[type=submit]').click();

  // On: the link, and the three things to do with it.
  const done = page().locator('.booking-done');
  await expect(done).toBeVisible({ timeout: 20000 });
  const url = `${server.url}/meet/${HANDLE}`;
  await expect(done.locator('.booking-url')).toHaveText(url);
  expect(published().enabled).toBe(true);
  expect(published().profile.name).toBe('Demo User');
  const accountId = (await call('state')).accounts[0].id;
  expect((await call('state')).settings.calendar.availability[`${accountId}\nwork`]).toBe(false);

  await done.locator('[data-a="booking-copy"]').click();
  await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe(url);
  await done.locator('[data-a="booking-preview"]').click();
  await expect.poll(() => app.evaluate(() => global.__opened)).toBe(url);
  await done.locator('[data-a="booking-signature"]').click();
  await expect(done.locator('.booking-added')).toHaveText('In your signature');
  expect((await call('state')).settings.bookingFooter).toBe(true);

  // The overview says the page is on.
  await page().locator('[data-a="back"]').click();
  await expect(page().locator('[data-a="booking-open"] .desc')).toHaveText(`On · ${url.replace(/^https?:\/\//, '')}`);
});

test('a handle the server refuses is said on the setup screen, which keeps what was typed', async () => {
  await call('accountSignUp', { email: 'host@example.com', password: PASSWORD, invite: '' });
  server.fail = ({ route }) => (route === 'PUT /v1/booking' ? [409, { error: 'handle_taken', message: 'taken' }] : null);
  // A server whose pages live at the root of their own address, as meet.rukoo.io's do.
  server.bookingOrigin = 'https://book.example';
  await openBookingPage();
  const setup = page().locator('form[data-form="booking-setup"]');
  await expect(setup.locator('.booking-handle-base')).toHaveText('book.example/');
  await setup.locator('[name="name"]').fill('Demo Host');
  await setup.locator('button[type=submit]').click();
  await expect(setup.locator('[data-error]')).not.toHaveText('', { timeout: 15000 });
  await expect(setup.locator('[name="name"]')).toHaveValue('Demo Host');
  expect((await booking()).status).toBe('off');
});

test('meeting types and available hours are edited on the page and published', async () => {
  await pageOn();
  await openBookingPage();
  const types = page().locator('[data-a^="booking-type:"]:not([data-a="booking-type:new"])');
  await expect(types.first().locator('.title')).toHaveText('30 minute meeting');
  await expect(types.first().locator('.desc')).toHaveText('30 mins');

  // The first type: another title and length, a private phone number with a public label, approval needed.
  await types.first().click();
  const form = page().locator('form[data-form="booking-type"]');
  await expect(form.locator('[name="slug"]')).toHaveValue('30min');
  await form.locator('[name="title"]').fill('Intro call');
  // An existing type keeps its link name when the title changes.
  await expect(form.locator('[name="slug"]')).toHaveValue('30min');
  await form.locator('[name="duration"]').selectOption('45');
  await expect(form.locator('[data-location]')).toBeHidden();
  await form.locator('[name="locationKind"]').selectOption('phone');
  await expect(form.locator('[data-location]')).toBeVisible();
  await form.locator('[name="locationValue"]').fill('+31 6 1234 5678');
  await form.locator('[name="locationLabel"]').fill('Phone call');
  await form.locator('.booking-more summary').click();
  await form.locator('[name="minNotice"]').selectOption('1440');
  await form.locator('[name="confirm"]').check();
  await form.locator('button[type=submit]').click();
  await expect(page().locator('h1')).toHaveText('Booking page');
  await expect(types.first().locator('.title')).toHaveText('Intro call');
  await expect(types.first().locator('.desc')).toHaveText('45 mins · Phone call · Needs your approval');
  const saved = (await booking()).settings.types[0];
  expect(saved).toMatchObject({ slug: '30min', title: 'Intro call', duration: 45, minNotice: 1440, confirm: true, location: { kind: 'phone', value: '+31 6 1234 5678', label: 'Phone call', public: false } });
  // Published without the private number.
  await expect.poll(() => published().profile.types[0].duration).toBe(45);
  expect(published().profile.types[0].location).toEqual({ kind: 'phone', label: 'Phone call' });
  expect(published().profile.types[0].confirm).toBe(true);

  // A second type: its link name follows the title; then it goes again.
  await page().locator('[data-a="booking-type:new"]').click();
  await expect(page().locator('h1')).toHaveText('New meeting type');
  await form.locator('[name="title"]').fill('Quick chat');
  await expect(form.locator('[name="slug"]')).toHaveValue('quick-chat');
  await expect(form.locator('[data-slug-url]')).toHaveText(`${server.url}/meet/${HANDLE}/quick-chat`);
  await form.locator('[name="duration"]').selectOption('15');
  await form.locator('button[type=submit]').click();
  await expect(types).toHaveCount(2);
  await expect.poll(() => published().profile.types.map((x) => x.slug)).toEqual(['30min', 'quick-chat']);
  // A link name another type has is refused on the field.
  await types.nth(1).click();
  await form.locator('[name="slug"]').fill('30min');
  await form.locator('button[type=submit]').click();
  await expect(form.locator('[name="slug"]')).toHaveAttribute('aria-invalid', 'true');
  await expect(form.locator('[data-error]')).toHaveText('Another meeting type already uses this name.');
  await form.locator('[data-a="booking-type-delete"]').click();
  await win.locator('.scrim .buttons button', { hasText: 'Delete' }).click();
  await expect(types).toHaveCount(1);
  await expect.poll(() => published().profile.types.length).toBe(1);

  // Hours of its own: Monday mornings and afternoons, Wednesday off, and one date blocked.
  await page().locator('[data-a="booking-hours"]').click();
  await expect(page().locator('h1')).toHaveText('Available hours');
  await page().locator('[data-a="booking-hours-custom"]').click();
  const monday = page().locator('.booking-day', { hasText: 'Monday' });
  await monday.locator('[data-range="w1:0:1"]').fill('12:00');
  await monday.locator('[data-a="booking-range-add:w1"]').click();
  await monday.locator('[data-range="w1:1:0"]').fill('14:00');
  await monday.locator('[data-range="w1:1:1"]').fill('16:00');
  await page().locator('.booking-day', { hasText: 'Wednesday' }).locator('[data-a="booking-range-del:w3:0"]').click();
  await expect(page().locator('.booking-day', { hasText: 'Wednesday' })).toContainText('Unavailable');
  // Tuesday runs to midnight: another range goes before it, not after.
  const tuesday = page().locator('.booking-day', { hasText: 'Tuesday' });
  await tuesday.locator('[data-range="w2:0:1"]').fill('00:00');
  await tuesday.locator('[data-a="booking-range-add:w2"]').click();
  await expect(tuesday.locator('[data-range="w2:0:0"]')).toHaveValue('08:00');
  await expect(tuesday.locator('[data-range="w2:0:1"]')).toHaveValue('09:00');
  await expect(tuesday.locator('[data-range="w2:1:1"]')).toHaveValue('00:00');
  const blocked = new Date(slot(8));
  const date = `${blocked.getFullYear()}-${String(blocked.getMonth() + 1).padStart(2, '0')}-${String(blocked.getDate()).padStart(2, '0')}`;
  await page().locator('[data-a="booking-override-add"]').click();
  await win.locator('.scrim [name="date"]').fill(date);
  await win.locator('.scrim .buttons button', { hasText: 'Add' }).click();
  await expect(page().locator('.booking-blocked')).toHaveText('Blocked');
  // Overlapping hours are refused before anything is saved.
  await monday.locator('[data-range="w1:1:0"]').fill('11:00');
  await page().locator('form[data-form="booking-hours"] button[type=submit]').click();
  await expect(page().locator('form[data-form="booking-hours"] [data-error]')).toContainText("ranges on one day can't overlap");
  await monday.locator('[data-range="w1:1:0"]').fill('14:00');
  await page().locator('form[data-form="booking-hours"] button[type=submit]').click();
  await expect(page().locator('h1')).toHaveText('Booking page');
  await expect(page().locator('[data-a="booking-hours"] .value')).toHaveText('Own schedule · 1 date with other hours');
  const s = (await booking()).settings;
  expect(s.hours.custom).toBe(true);
  expect(s.hours.weekly[1]).toEqual([['09:00', '12:00'], ['14:00', '16:00']]);
  expect(s.hours.weekly[2]).toEqual([['08:00', '09:00'], ['09:00', '24:00']]);
  expect(s.hours.weekly[3]).toEqual([]);
  expect(s.overrides[date]).toEqual([]);
  // The published open time has nothing on the blocked date.
  const from = new Date(`${date}T00:00:00`).getTime();
  await expect.poll(() => published().windows.default.some(([a, b]) => a < from + DAY && b > from)).toBe(false);
});

test('requests are accepted or declined and bookings cancelled from the page; guest text stays text', async () => {
  await pageOn();
  const first = await server.book({ handle: HANDLE, type: '30min', start: slot(3, 10), guest: { name: '<b>Ann</b> Example', notes: '<img src=x onerror="window.__pwned=1">', via: 'Calendar helper' }, status: 'pending' });
  const second = await server.book({ handle: HANDLE, type: '30min', start: slot(4, 11), guest: { name: 'Bob Example' }, status: 'pending' });
  await call('bookingSync');
  await openBookingPage();
  const requests = page().locator('.booking-list').first();
  await expect(requests.locator('.booking-item')).toHaveCount(2);
  const ann = requests.locator('.booking-item').first();
  await expect(ann.locator('.booking-guest')).toHaveText('<b>Ann</b> Example');
  await expect(ann.locator('.booking-notes')).toHaveText('<img src=x onerror="window.__pwned=1">');
  await expect(ann).toContainText('via Calendar helper');
  await expect(page().locator('.booking-list b, .booking-list img')).toHaveCount(0);

  await ann.locator('[data-a^="booking-accept:"]').click();
  await expect(win.locator('#toast')).toHaveText('Request accepted', { timeout: 15000 });
  expect(published().bookings.get(first.id).status).toBe('confirmed');
  await expect(page().locator('.booking-item', { hasText: 'Ann' }).locator('[data-a^="booking-cancel:"]')).toBeVisible();

  await page().locator('.booking-item', { hasText: 'Bob Example' }).locator('[data-a^="booking-decline:"]').click();
  await win.locator('.scrim textarea').fill('Sorry, that week is full.');
  await win.locator('.scrim .buttons button', { hasText: 'Decline' }).click();
  await expect(win.locator('#toast')).toHaveText('Request declined', { timeout: 15000 });
  expect(published().bookings.get(second.id).status).toBe('declined');
  expect(published().bookings.get(second.id).message).toBe('Sorry, that week is full.');

  await page().locator('.booking-item', { hasText: 'Ann' }).locator('[data-a^="booking-cancel:"]').click();
  await expect(win.locator('.scrim [name="check"]')).toBeChecked();
  await win.locator('.scrim .buttons button', { hasText: 'Cancel booking' }).click();
  await expect(win.locator('#toast')).toHaveText('Booking cancelled', { timeout: 15000 });
  expect(published().bookings.get(first.id)).toMatchObject({ status: 'cancelled', reason: 'host_cancelled' });
  await expect(page().locator('.booking-empty')).toHaveText('No bookings yet.');
  expect(await win.evaluate(() => window.__pwned)).toBeUndefined();
});

test('the availability panel uses booking hours while the page is on and blocks a day as a date override', async () => {
  // The page in another zone than this computer's: its dates are days there, so the panel blocks days only when it
  // shows them in that zone.
  const here = await win.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  const zone = here === 'America/Los_Angeles' ? 'Asia/Tokyo' : 'America/Los_Angeles';
  await pageOn({ timeZone: zone });
  await win.click('[data-mode="calendar"]');
  await expect(win.locator('.calendar [data-ev]').first()).toBeVisible({ timeout: 10000 });
  await win.click('[data-cal-panel="free"]');
  const panel = win.locator('.calendar .cal-panel');
  await expect(panel.locator('[data-free="hours"]')).toHaveValue('booking');
  await panel.locator('[data-free="range"]').selectOption('days14');
  await expect(panel.locator('.free-slot').first()).toBeVisible({ timeout: 10000 });
  await expect(panel.locator('[data-free-block]')).toHaveCount(0);
  const note = panel.locator('.free-zone-note');
  await expect(note).toContainText("Days on your booking page are blocked in its time zone. Show times in " + zone.replace(/_/g, ' '));
  await note.locator('[data-free-act="booking-zone"]').click();
  await expect(panel.locator('[data-free="zone"]')).toHaveValue(zone);
  await expect(note).toHaveCount(0);
  const block = panel.locator('[data-free-block]').first();
  await expect(block).toBeVisible({ timeout: 10000 });
  const date = await block.getAttribute('data-free-block');
  // The day blocked is the one the panel names, in the page's zone.
  const title = await block.evaluate((b) => b.closest('.free-day').querySelector('h3').textContent);
  await block.click();
  await expect.poll(async () => (await booking()).settings.overrides[date]).toEqual([]);
  await expect(panel.locator(`[data-free-block="${date}"]`)).toHaveCount(0);
  await expect(win.locator('#toast')).toContainText(`${title} is blocked on your booking page`);
  // Undo gives the day back.
  await win.locator('#toast button').click();
  await expect.poll(async () => (await booking()).settings.overrides[date]).toBeUndefined();
  await expect(panel.locator(`[data-free-block="${date}"]`)).toHaveCount(1);
  // Copy booking link puts the page's address on the clipboard.
  await panel.locator('[data-free-act="link"]').click();
  await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe(`${server.url}/meet/${HANDLE}`);
});

test('turning the page off asks first, then shows the setup again with the same settings', async () => {
  // Bookings went to Work, not the default account's main calendar.
  await pageOn({ calendar: 'work' });
  const accountId = (await call('state')).accounts[0].id;
  await openBookingPage();
  await page().locator('[data-a="booking-off"]').click();
  await expect(win.locator('.scrim h2')).toHaveText('Turn off your booking page?');
  await win.locator('.scrim .buttons button', { hasText: 'Turn off' }).click();
  await expect(win.locator('#toast')).toHaveText('Your booking page is off', { timeout: 15000 });
  const setup = page().locator('form[data-form="booking-setup"]');
  await expect(setup).toBeVisible();
  await expect(page().locator('.settings-text').first()).toHaveText('Your booking page is off. Turn it on again with these settings, or change them first.');
  await expect(setup.locator('[name="handle"]')).toHaveValue(HANDLE);
  await expect(setup.locator('[name="name"]')).toHaveValue('Demo Host');
  await expect(setup.locator('[name="destination"]')).toHaveValue(`${accountId}\nwork`);
  expect((await booking()).status).toBe('off');
});

test('the page and the overview keep their place while the booking state comes in', async () => {
  await pageOn();
  for (let i = 0; i < 4; i++) await server.book({ handle: HANDLE, type: '30min', start: slot(3 + i, 10), guest: { name: `Guest ${i}` }, status: 'pending' });
  await call('bookingSync');
  await openBookingPage();
  await expect(page().locator('.booking-list').first().locator('.booking-item')).toHaveCount(4);
  const scroller = page().locator('.page-scroll');
  const top = () => scroller.evaluate((el) => el.scrollTop);
  await scroller.evaluate((el) => (el.scrollTop = el.scrollHeight));
  const bottom = await top();
  expect(bottom).toBeGreaterThan(100);

  // A state that changes only the publish time, as main sends after a publish, draws nothing; the line is written in
  // place.
  const state = await booking();
  state.publishing.lastAt = Date.now() - 3 * 60000;
  await win.evaluate(() => (window.__hoursRow = document.querySelector('.page.settings [data-a="booking-hours"]')));
  await app.evaluate(({ BrowserWindow }, s) => BrowserWindow.getAllWindows()[0].webContents.send('mail:event', { type: 'booking', payload: s }), state);
  await expect(page().locator('[data-booking-publish]')).toHaveText('Last updated from this computer: 3 minutes ago');
  expect(await win.evaluate(() => window.__hoursRow === document.querySelector('.page.settings [data-a="booking-hours"]'))).toBe(true);
  expect(await top()).toBe(bottom);
  // Under a minute ago is "just now", not Intl's "this minute" ("binnen een minuut" in Dutch).
  state.publishing.lastAt = Date.now() - 10000;
  await app.evaluate(({ BrowserWindow }, s) => BrowserWindow.getAllWindows()[0].webContents.send('mail:event', { type: 'booking', payload: s }), state);
  await expect(page().locator('[data-booking-publish]')).toHaveText('Last updated from this computer: just now');

  // A new request is drawn, and the page stays where it was.
  await server.book({ handle: HANDLE, type: '30min', start: slot(9, 10), guest: { name: 'Eve Example' }, status: 'pending' });
  await call('bookingSync');
  await expect(page().locator('.booking-item', { hasText: 'Eve Example' })).toHaveCount(1);
  expect(await top()).toBe(bottom);
  // So does a switch near the bottom (clicked where it is: Playwright's click would scroll it into view first).
  await page().locator('[data-a="booking-footer"]').evaluate((el) => el.click());
  await expect.poll(async () => (await call('state')).settings.bookingFooter).toBe(true);
  await expect(page().locator('[data-a="booking-footer-text"]')).toBeVisible();
  expect(await top()).toBe(bottom);

  // The overview, with the page off: a state it doesn't show doesn't redraw it or move it.
  await call('bookingDisable');
  await page().locator('[data-a="back"]').click();
  await expect(page().locator('[data-a="booking-open"] .desc')).toHaveText('Let people and their AI assistants book time with you');
  await scroller.evaluate((el) => (el.scrollTop = el.scrollHeight));
  const overview = await top();
  expect(overview).toBeGreaterThan(100);
  await win.evaluate(() => {
    window.__bookingRow = document.querySelector('.page.settings [data-a="booking-open"]');
    window.__bookingEvents = 0;
    window.mail.on(({ type }) => type === 'booking' && window.__bookingEvents++);
  });
  const off = await booking();
  off.busy = !off.busy;
  await app.evaluate(({ BrowserWindow }, s) => BrowserWindow.getAllWindows()[0].webContents.send('mail:event', { type: 'booking', payload: s }), off);
  await expect.poll(() => win.evaluate(() => window.__bookingEvents)).toBe(1);
  await win.waitForTimeout(300);
  expect(await win.evaluate(() => window.__bookingRow === document.querySelector('.page.settings [data-a="booking-open"]'))).toBe(true);
  expect(await top()).toBe(overview);
});

test('in Dutch, a date inside a sentence keeps its lowercase weekday, and a publish a moment ago is "zojuist"', async () => {
  await pageOn();
  await server.book({ handle: HANDLE, type: '30min', start: slot(4, 10), guest: { name: 'Ann Example' }, status: 'pending' });
  await call('bookingSync');
  await win.evaluate(() => window.mail.call('updateSettings', { language: 'nl' }));
  await win.evaluate(() => document.querySelector('[data-action="settings"]').click());
  await page().locator('[data-a="booking-open"]').click();
  await expect(page().locator('h1')).toHaveText('Afsprakenpagina');
  const ann = page().locator('.booking-item', { hasText: 'Ann Example' });
  await expect(ann).toContainText('wacht op je tot ');
  expect(await ann.textContent()).toMatch(/wacht op je tot (maandag|dinsdag|woensdag|donderdag|vrijdag|zaterdag|zondag) \d+ /);
  const state = await booking();
  state.publishing.lastAt = Date.now() - 10000;
  await app.evaluate(({ BrowserWindow }, s) => BrowserWindow.getAllWindows()[0].webContents.send('mail:event', { type: 'booking', payload: s }), state);
  await expect(page().locator('[data-booking-publish]')).toHaveText('Laatst bijgewerkt vanaf deze computer: zojuist');
});

test('a notice button acts on its own notice, named by id', async () => {
  await pageOn();
  const first = await server.book({ handle: HANDLE, type: '30min', start: slot(3, 10), guest: { name: 'Ann Example' } });
  const second = await server.book({ handle: HANDLE, type: '30min', start: slot(4, 11), guest: { name: 'Bob Example' } });
  await call('bookingSync');
  await server.guestCancel({ handle: HANDLE, id: first.id });
  await server.guestCancel({ handle: HANDLE, id: second.id });
  await call('bookingSync');
  await openBookingPage();
  const notices = page().locator('.booking-notice');
  await expect(notices).toHaveCount(2);
  const bob = page().locator(`[data-a="booking-notice:${encodeURIComponent(`guestCancelled:${second.id}`)}:dismiss"]`);
  await expect(bob).toHaveCount(1);
  await bob.click();
  await expect(notices).toHaveCount(1);
  const left = (await booking()).notices.map((n) => n.id);
  expect(left).toEqual([`guestCancelled:${first.id}`]);

  // An overlap notice's Cancel booking asks first, as the bookings list does.
  const third = await server.book({ handle: HANDLE, type: '30min', start: slot(5, 10), guest: { name: 'Cleo Example' } });
  await call('bookingSync');
  await app.evaluate(({}, id) => {
    const b = global.__semBooking;
    b.addNotice('overlap', b.file.rows[id], 'Cleo');
    b.changed();
  }, third.id);
  const cancel = page().locator(`[data-a="booking-notice:${encodeURIComponent(`overlap:${third.id}`)}:cancel"]`);
  await expect(cancel).toHaveCount(1);
  await cancel.click();
  await expect(win.locator('.scrim [name="check"]')).toBeChecked();
  expect(published().bookings.get(third.id).status).toBe('confirmed');
  await win.locator('.scrim .buttons button', { hasText: 'Cancel booking' }).click();
  await expect(win.locator('#toast')).toHaveText('Booking cancelled', { timeout: 15000 });
  expect(published().bookings.get(third.id)).toMatchObject({ status: 'cancelled', reason: 'host_cancelled' });
});
