// Settings > Video meetings and video services on the booking page, in the real app against the in-memory account
// server, with the demo account's calendar as the destination: Jitsi turns on and gives a booking its own room link,
// Zoom with a client starts the browser sign-in (which is cancelled here, as there is no real Zoom), Teams without
// one says what it needs, and a type whose service isn't connected brings a notice that leads to the page.
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
  dataDir = tempDir('rukoo-video-e2e-');
  // A Zoom client from the environment, as a fork or the maintainer would give it; no Teams client.
  const env = { ...process.env, SEM_DATA_DIR: dataDir, SEM_HIDDEN: '1', RUKOO_ACCOUNT_SERVER: server.url, SEM_ZOOM_CLIENT_ID: 'zoom-test-client' };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.SEM_TEAMS_CLIENT_ID;
  delete env.SEM_ZOOM_CLIENT_SECRET;
  const entry = process.platform === 'linux' ? path.join(__dirname, '..', 'fixtures', 'linux-keyring-app.js') : '.';
  app = await electron.launch({ args: [entry], cwd: path.join(__dirname, '..', '..'), env });
  win = await app.firstWindow();
  await app.evaluate(({ BrowserWindow, shell }) => {
    BrowserWindow.getAllWindows()[0].setSize(1400, 950);
    // The sign-in page would open in the browser; here it only notes the address.
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
const service = (id) => page().locator(`[data-video="${id}"]`);

async function openSettings() {
  await win.evaluate(() => document.querySelector('[data-action="settings"]').click());
  await expect(page().locator('h1')).toHaveText('Email settings');
}

async function pageOn() {
  await call('accountSignUp', { email: 'host@example.com', password: PASSWORD, invite: '' });
  const accountId = (await call('state')).accounts[0].id;
  const state = await call('bookingEnable', { handle: HANDLE, name: 'Demo Host', timeZone: 'Europe/Amsterdam', destination: `${accountId}\npersonal` });
  expect(state.status).toBe('on');
}

function slot(days = 3, hour = 10) {
  const d = new Date(Date.now() + days * DAY);
  while ([0, 6].includes(d.getDay())) d.setDate(d.getDate() + 1);
  d.setHours(hour, 0, 0, 0);
  return d.getTime();
}

test('Video meetings turns Jitsi on, starts the Zoom sign-in, and says what Teams needs', async () => {
  await openSettings();
  const row = page().locator('[data-a="video-open"]');
  await expect(row.locator('.desc')).toHaveText('Give each booking its own Zoom, Teams or Jitsi link');
  await row.click();
  await expect(page().locator('h1')).toHaveText('Video meetings');

  // Jitsi: a switch; on, it shows the server, which can be the host's own.
  const jitsi = page().locator('[data-a="video-room:jitsi"]');
  await expect(jitsi.locator('.switch')).not.toHaveClass(/on/);
  await jitsi.click();
  await expect(page().locator('[data-a="video-room:jitsi"] .switch')).toHaveClass(/on/);
  await expect(page().locator('[data-a="video-server:jitsi"] .value')).toHaveText('meet.jit.si');
  await page().locator('[data-a="video-server:jitsi"]').click();
  await win.locator('.scrim .form-input').fill('http://jitsi.example.org');
  await win.locator('.scrim .buttons button', { hasText: 'Save' }).click();
  await expect(win.locator('#toast')).toHaveText('Enter the address of a Jitsi server, starting with https://.');
  await page().locator('[data-a="video-server:jitsi"]').click();
  await win.locator('.scrim .form-input').fill('jitsi.example.org');
  await win.locator('.scrim .buttons button', { hasText: 'Save' }).click();
  await expect(page().locator('[data-a="video-server:jitsi"] .value')).toHaveText('jitsi.example.org');
  await page().locator('[data-a="video-server:jitsi"]').click();
  await win.locator('.scrim .form-input').fill('');
  await win.locator('.scrim .buttons button', { hasText: 'Save' }).click();
  await expect(page().locator('[data-a="video-server:jitsi"] .value')).toHaveText('meet.jit.si');

  // Teams has no client in this copy: one sentence, and a way to add one, but no Connect.
  await expect(service('teams').locator('.desc')).toHaveText('This copy of Rukoo has no Microsoft Teams app to sign in with. Add a client file, as the booking page guide explains.');
  await expect(service('teams').locator('[data-a="video-connect:teams"]')).toHaveCount(0);
  await expect(service('teams').locator('[data-a="video-import:teams"]')).toHaveText('Add client file…');
  await expect(service('teams').locator('.video-dot')).toHaveAttribute('data-state', 'unavailable');

  // Zoom has one: Connect opens Zoom's sign-in with PKCE and waits; Cancel stops it.
  await expect(service('zoom').locator('.desc')).toHaveText('Makes a meeting in your Zoom account for each booking.');
  await service('zoom').locator('[data-a="video-connect:zoom"]').click();
  await expect(service('zoom').locator('.desc')).toHaveText('Finish signing in to Zoom in your browser.');
  const opened = new URL(await app.evaluate(() => global.__opened));
  expect(`${opened.origin}${opened.pathname}`).toBe('https://zoom.us/oauth/authorize');
  expect(opened.searchParams.get('client_id')).toBe('zoom-test-client');
  expect(opened.searchParams.get('code_challenge_method')).toBe('S256');
  expect(opened.searchParams.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  await service('zoom').locator('[data-a="video-cancel"]').click();
  await expect(service('zoom').locator('[data-a="video-connect:zoom"]')).toBeVisible();
  // A cancelled sign-in is no error.
  await expect(win.locator('#toast')).not.toHaveText(/cancelled/);
  expect((await call('videoState')).services.find((s) => s.id === 'zoom').status).toBe('off');

  // The overview names what is connected, after a restart of the page too.
  await page().locator('[data-a="back"]').click();
  await expect(page().locator('[data-a="video-open"] .desc')).toHaveText('Connected: Jitsi Meet');
});

test('a meeting type with Jitsi gives each booking its own room in the event, and the page only its name', async () => {
  await pageOn();
  await call('videoRoom', 'jitsi', { on: true });
  await openSettings();
  await page().locator('[data-a="booking-open"]').click();
  await page().locator('[data-a="booking-type:0"]').click();
  const form = page().locator('form[data-form="booking-type"]');
  const kind = form.locator('[name="locationKind"]');
  // Connected services come after Google Meet; Zoom isn't connected, so it isn't offered.
  await expect(kind.locator('option')).toHaveText(['Google Meet', 'Jitsi Meet', 'Phone call', 'In person', 'Meeting link', 'No location']);
  await kind.selectOption('video:jitsi');
  await expect(form.locator('[data-video-help]')).toHaveText("Each booking gets its own Jitsi Meet link in the guest's invitation. The page shows only the label.");
  await expect(form.locator('[data-location]')).toBeHidden();
  await expect(form.locator('[name="locationLabel"]')).toHaveAttribute('placeholder', 'Jitsi Meet');
  await form.locator('button[type=submit]').click();
  await expect(win.locator('#toast')).toHaveText('Saved', { timeout: 15000 });
  await expect(page().locator('[data-a="booking-type:0"] .desc')).toHaveText(/ · Jitsi Meet$/);
  expect(server.pages.get(HANDLE).profile.types[0].location).toEqual({ kind: 'link', label: 'Jitsi Meet' });

  const start = slot(3, 10);
  const { id } = await server.book({ handle: HANDLE, type: '30min', start, guest: { name: 'Ann Example', email: 'ann@example.org' } });
  await call('bookingSync');
  const item = (await call('bookingState')).bookings.find((b) => b.id === id);
  const ev = await call('calendarEvent', item.eventId);
  expect(ev.location).toMatch(/^https:\/\/meet\.jit\.si\/rukoo-[a-z]{22}$/);
  expect(ev.description.startsWith(`Join with Jitsi Meet: ${ev.location}`)).toBe(true);
  // The demo calendar recognises the room as a meeting, so the event's card offers to join it.
  expect(ev.meeting).toBe(ev.location);
  expect(JSON.stringify(server.pages.get(HANDLE))).not.toContain(ev.location);
});

test("a type whose service isn't connected here brings a notice that opens Video meetings", async () => {
  await pageOn();
  const state = await call('bookingState');
  await call('bookingSave', { types: [{ ...state.settings.types[0], location: { kind: 'video', service: 'zoom', label: '', value: '', public: false } }] });
  await openSettings();
  await page().locator('[data-a="booking-open"]').click();
  const notice = page().locator('.booking-notice', { hasText: 'No Zoom links for new bookings' });
  await expect(notice).toContainText("Zoom isn't connected on this computer, so new bookings of 30 minute meeting go in your calendar without a link.");
  // The type keeps its location, shown as not connected here.
  await page().locator('[data-a="booking-type:0"]').click();
  await expect(page().locator('[name="locationKind"] option:checked')).toHaveText('Zoom (not connected here)');
  await page().locator('form[data-form="booking-type"] [data-a="back"]').click();
  await page().locator('.booking-notice', { hasText: 'No Zoom links' }).locator('button', { hasText: 'Video meetings' }).click();
  await expect(page().locator('h1')).toHaveText('Video meetings');
});
