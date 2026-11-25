// Settings > General > Tabs with team chat: Chat as a tab you can turn off, and the person it matters most to, who
// uses Rukoo for team chat only, with a Rukoo account and no mail account. The real app on throwaway profiles against
// the real account server (test/fixtures/real-server.js); Olga, who writes and invites, is acted for over HTTP.
const path = require('path');
const { test, expect, _electron: electron } = require('@playwright/test');
const { tempDir, removeDir } = require('../tmp');
const { closeApp } = require('./close');
const { skipWithoutServer, startServer, launch, signIn, openChat, twoPeople, notices, emulateFocus, dialogBox, connected } = require('./chat-helpers');

skipWithoutServer();

let server;
let app;
let win;
let dataDir;

test.beforeAll(async () => {
  server = await startServer();
});

test.afterAll(async () => {
  await server?.close();
});

test.beforeEach(() => {
  dataDir = tempDir('rukoo-modes-chat-e2e-');
});

test.afterEach(async () => {
  await closeApp(app);
  app = null;
  removeDir(dataDir);
});

const tab = (mode) => win.locator(`.titlebar-modes [data-mode="${mode}"]`);
const tabs = () => win.locator('.titlebar-modes [role="tab"]');
const settingsPage = () => win.locator('.page.settings');
const modeSwitch = (mode) => settingsPage().locator(`[data-a="mode:${mode}"]`);
const setup = () => win.locator('.page.setup');
const notice = () => win.locator('#toast');
const hiddenModes = () => app.evaluate(() => global.__semEngine.settings.hiddenModes);

async function closeSettings() {
  while (await settingsPage().count()) await win.keyboard.press('Escape');
  await expect(settingsPage()).toHaveCount(0);
}

async function openTabsSettings() {
  await win.click('[data-action="settings"]');
  await settingsPage().locator('[data-a="tabs"]').click();
  await expect(modeSwitch('mail')).toBeVisible();
}

// Rukoo on dataDir against the server without a mail account: the setup page on a new profile, Chat after a restart
// with a Rukoo account.
async function startWithoutMail() {
  const env = { ...process.env, SEM_DATA_DIR: dataDir, SEM_HIDDEN: '1', SEM_CHAT_FAST: '1', RUKOO_ACCOUNT_SERVER: server.url };
  delete env.ELECTRON_RUN_AS_NODE;
  const entry = process.platform === 'linux' ? path.join(__dirname, '..', 'fixtures', 'linux-keyring-app.js') : '.';
  app = await electron.launch({ args: [entry], cwd: path.join(__dirname, '..', '..'), env });
  win = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 860));
  await emulateFocus(win);
  await win.waitForFunction(() => document.querySelector('.provider-grid, .item, section.chat .ch-empty, section.chat .ch-main'), null, { timeout: 30000 });
}

async function restartWithoutMail() {
  await closeApp(app);
  app = null;
  await startWithoutMail();
}

// Olga writes Bart in their direct messages, and Bart's device syncs it.
async function dmFromOlga(olga, ws, dm, text) {
  await server.post(olga, ws.id, dm, text);
  await app.evaluate((_e, id) => global.__semChat.sync(id), ws.id);
}

test('Chat turned off has no tab, alerts or badge, and turned on again brings no old alerts', async () => {
  const { olga, bart, ws, bartMe } = await twoPeople(server);
  const dm = (await server.seedDm(olga, ws.id, [bartMe.id])).conversation;
  // Unfocused, so an alert is a desktop notification (recorded in test mode) rather than a toast.
  ({ app, win } = await launch(server, { dataDir, focus: false }));
  await signIn(win, bart);
  await openChat(win);
  await connected(win);

  await openTabsSettings();
  await expect(modeSwitch('chat')).toBeVisible();
  await expect(modeSwitch('chat')).toHaveAttribute('aria-checked', 'true');
  await expect(modeSwitch('chat')).toBeEnabled();
  await modeSwitch('chat').click();
  await expect(modeSwitch('chat')).toHaveAttribute('aria-checked', 'false');
  expect(await hiddenModes()).toEqual(['chat']);
  await closeSettings();

  // The tab is gone and the window left Chat for Mail.
  await expect(tab('chat')).toHaveCount(0);
  await expect(tabs()).toHaveText(['Mail', 'Calendar', 'Meet']);
  await expect(tab('mail')).toHaveAttribute('aria-selected', 'true');
  await expect(win.locator('section.chat')).toBeHidden();
  expect(await app.evaluate(() => global.__semClosedModes)).toEqual(['chat']);

  // A direct message while Chat is off: no alert, and nothing to carry a badge.
  await dmFromOlga(olga, ws, dm, 'Hoi Bart, ben je er?');
  await expect.poll(() => app.evaluate(() => global.__semChat.debugState().workspaces.every((w) => w.syncedAt && !w.syncing))).toBe(true);
  expect(await notices(app)).toEqual([]);
  await expect(win.locator('.titlebar-modes .ch-badge, .titlebar-modes [data-mode="chat"]')).toHaveCount(0);

  // Chat on again: the tab is back with the message, and no alert for what came in meanwhile.
  await win.evaluate(() => window.mail.call('updateSettings', { hiddenModes: [] }));
  await expect(tab('chat')).toBeVisible();
  await app.evaluate((_e, id) => global.__semChat.sync(id), ws.id);
  await win.waitForTimeout(500);
  expect(await notices(app)).toEqual([]);
  // A new message alerts as before.
  await dmFromOlga(olga, ws, dm, 'En nu?');
  await expect.poll(async () => (await notices(app)).map((n) => n.body)).toEqual(['Olga Owner: En nu?']);
});

test('with only a Rukoo account, Use Chat only lands in Chat, survives a restart, and Chat cannot be turned off', async ({}, testInfo) => {
  const { bart } = await twoPeople(server);
  await startWithoutMail();
  await signIn(win, bart);
  // A Rukoo account alone runs the window in Chat; Mail, Calendar and Meet lead to the setup page.
  await expect(tab('chat')).toHaveAttribute('aria-selected', 'true', { timeout: 15000 });
  await expect(win.locator('section.chat')).toBeVisible();
  await tab('mail').click();
  const chatOnly = setup().locator('[data-s="chat-only"]');
  await expect(chatOnly).toHaveText('Use Chat only, without email');
  await chatOnly.click();
  await expect(setup()).toHaveCount(0);
  await expect(notice()).toContainText('Mail, Calendar and Meet are off.');
  expect(await hiddenModes()).toEqual(['mail', 'calendar', 'meeting']);
  // Only Chat: no tabs at all, and the window is in Chat.
  await expect(win.locator('.titlebar-modes .mode-tabs')).toHaveCount(0);
  await expect(win.locator('section.chat')).toBeVisible();

  await restartWithoutMail();
  await expect(setup()).toHaveCount(0);
  await expect(win.locator('section.chat')).toBeVisible({ timeout: 15000 });
  await expect(win.locator('.titlebar-modes .mode-tabs')).toHaveCount(0);

  // Settings opens on General, without mail accounts, and its Tabs page keeps Chat on.
  await win.click('[data-action="settings"]');
  await expect(settingsPage().locator('[data-a="add"]')).toHaveCount(0);
  await expect(settingsPage().locator('.settings-group-title').first()).toHaveText('General');
  await settingsPage().locator('[data-a="tabs"]').click();
  await expect(modeSwitch('chat')).toBeDisabled();
  await expect(modeSwitch('chat')).toContainText('Without a mail account, Chat is the tab you can use, so it stays on.');

  // The sequence that used to lock people out: Calendar back on, then Chat off.
  await modeSwitch('calendar').click();
  await expect(modeSwitch('calendar')).toHaveAttribute('aria-checked', 'true');
  expect(await hiddenModes()).toEqual(['mail', 'meeting']);
  await expect(modeSwitch('chat')).toBeDisabled();
  await modeSwitch('chat').click({ force: true });
  await expect(modeSwitch('chat')).toHaveAttribute('aria-checked', 'true');
  expect(await hiddenModes()).toEqual(['mail', 'meeting']);
  await closeSettings();
  await expect(tabs()).toHaveText(['Calendar', 'Chat']);
  await expect(tab('chat')).toHaveAttribute('aria-selected', 'true');
  await expect(setup()).toHaveCount(0);

  // A setting stored by the first version, Chat off too, still lands in Chat, also after a restart.
  await win.evaluate(() => window.mail.call('updateSettings', { hiddenModes: ['mail', 'meeting', 'chat'] }));
  await win.waitForTimeout(500);
  await expect(win.locator('section.chat')).toBeVisible();
  await expect(setup()).toHaveCount(0);
  await restartWithoutMail();
  await expect(win.locator('section.chat')).toBeVisible({ timeout: 15000 });
  await expect(tab('chat')).toHaveAttribute('aria-selected', 'true');
  await expect(setup()).toHaveCount(0);

  // With that stored list Chat is locked, and Calendar's switch works: off, then on again. The change saves the list
  // as the tabs show it, with Chat on.
  await openTabsSettings();
  await expect(modeSwitch('chat')).toBeDisabled();
  await expect(modeSwitch('calendar')).toBeEnabled();
  await modeSwitch('calendar').click();
  await expect(modeSwitch('calendar')).toHaveAttribute('aria-checked', 'false');
  expect(await hiddenModes()).toEqual(['mail', 'calendar', 'meeting']);
  await modeSwitch('calendar').click();
  await expect(modeSwitch('calendar')).toHaveAttribute('aria-checked', 'true');
  expect(await hiddenModes()).toEqual(['mail', 'meeting']);
  await expect(modeSwitch('meeting')).toBeEnabled();
  await win.screenshot({ path: testInfo.outputPath('tabs-stored-chat-off-calendar-free.png') });
  await closeSettings();
  await expect(tabs()).toHaveText(['Calendar', 'Chat']);

  // Signed out, the first-run page shows, with team chat's way back and a way to Settings.
  await win.evaluate(() => window.mail.call('accountSignOut'));
  await expect(setup().locator('.provider-grid')).toBeVisible({ timeout: 15000 });
  await expect(setup().locator('[data-setup-chat]')).toBeVisible({ timeout: 15000 });
  await setup().locator('[data-s="settings"]').click();
  await expect(settingsPage().locator('[data-a="tabs"]')).toBeVisible();
  await closeSettings();
  await expect(setup().locator('.provider-grid')).toBeVisible();
});

test('a team chat invitation while Chat is off says so, and Turn on opens the Join dialog', async () => {
  const olga = await server.seedAccount();
  const bart = await server.seedAccount({ password: 'a long enough password' });
  const ws = await server.seedWorkspace(olga, { name: 'Acme', displayName: 'Olga Owner' });
  const { link } = await server.createInvite(olga, ws.id, { role: 'member' });
  ({ app, win } = await launch(server, { dataDir }));
  await expect(tab('chat')).toBeVisible({ timeout: 15000 });
  await win.evaluate(() => window.mail.call('updateSettings', { hiddenModes: ['chat'] }));
  await expect(tab('chat')).toHaveCount(0);

  // Signing in with the invitation link leaves a pending join; Chat is off, so the window says so.
  await win.evaluate((p) => window.mail.call('accountSignIn', p), { email: bart.email, password: bart.password, join: link });
  await expect(notice()).toContainText("Chat is turned off, so Rukoo can't open your invitation.", { timeout: 15000 });
  await expect(win.locator('.scrim')).toHaveCount(0);
  await notice().locator('button').click();
  await expect(tab('chat')).toHaveAttribute('aria-selected', 'true', { timeout: 15000 });
  const dialog = dialogBox(win);
  await expect(dialog.locator('h2')).toHaveText('Join a workspace', { timeout: 15000 });
  await expect(dialog.locator('[name="link"]')).toHaveValue(link);
  expect(await hiddenModes()).toEqual([]);
});
