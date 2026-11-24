// Settings > General > Tabs: turning Mail, Calendar, Meet and Chat on and off (src/renderer/modes.js,
// src/main/modes.js). A hidden mode loses its tab, its shortcut, its notifications, sound and badges, and its ways in
// from outside; its account, data and sync stay. The demo account stands in for a real one, and desktop notifications
// are recorded instead of shown. Team chat isn't available in these tests (no account server), so Chat has no tab.
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
  win.on('dialog', () => {});
  await app.evaluate(({ BrowserWindow, Notification }) => {
    BrowserWindow.getAllWindows()[0].setSize(1500, 950);
    // In the background, where new mail gets a desktop notification.
    BrowserWindow.getAllWindows()[0].isFocused = () => false;
    global.__shown = [];
    Notification.prototype.show = function () {
      global.__shown.push({ title: this.title, body: this.body });
    };
  });
  await win.evaluate(() => {
    window.__badges = [];
    window.__newMail = [];
    window.mail.on(({ type, payload }) => {
      if (type === 'badge') window.__badges.push(payload);
      if (type === 'new-mail') window.__newMail.push(payload);
    });
  });
}

test.beforeEach(async () => {
  dataDir = tempDir('rukoo-modes-e2e-');
  fs.mkdirSync(path.join(dataDir, 'data'), { recursive: true });
  // The tray, so its count and menu can be checked.
  fs.writeFileSync(path.join(dataDir, 'data', 'settings.json'), JSON.stringify({ closeToTray: true }));
  await launch();
  await win.waitForSelector('.provider-grid');
  await win.click('[data-s="demo"]');
  await expect(win.locator('.item').first()).toBeVisible({ timeout: 15000 });
});

test.afterEach(async () => {
  await closeApp(app);
  removeDir(dataDir);
});

const tab = (mode) => win.locator(`.titlebar-modes [data-mode="${mode}"]`);
const shell = () => win.locator('#app .shell');
const settingsPage = () => win.locator('.page.settings');
const modeSwitch = (mode) => settingsPage().locator(`[data-a="mode:${mode}"]`);

// Escape goes back a page at a time: Tabs, then General, then the window.
async function closeSettings() {
  while (await settingsPage().count()) await win.keyboard.press('Escape');
  await expect(settingsPage()).toHaveCount(0);
}

async function openTabsSettings() {
  await win.click('[data-action="settings"]');
  await settingsPage().locator('[data-a="tabs"]').click();
  await expect(modeSwitch('mail')).toBeVisible();
}

// An email lands in the demo inbox, and a sync finds it.
const arrive = (subject) =>
  app.evaluate(async (_e, subject) => {
    const engine = global.__semEngine;
    const raw = [
      'From: Sanne de Vries <sanne@example.com>',
      'To: demo@example.com',
      `Subject: ${subject}`,
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: <${Date.now()}.${Math.random().toString(36).slice(2)}@example.com>`,
      '',
      'Hallo'
    ].join('\r\n');
    await engine.session(engine.accounts[0]).append('INBOX', raw);
    await engine.syncAll();
  }, subject);

const tray = () => app.evaluate(() => ({ tooltip: global.__semTray.tray.tooltip, dot: global.__semTray.dot, compose: Boolean(global.__semTray.menu.getMenuItemById('compose')) }));

test('hidden Mail leaves the tabs, the shortcut, notifications, badges and the tray, and comes back as it was', async () => {
  await expect(tab('mail')).toBeVisible();
  await expect(shell()).not.toHaveClass(/calendar-mode/);
  await openTabsSettings();
  await expect(modeSwitch('chat')).toHaveCount(0);
  await modeSwitch('mail').click();
  await expect(modeSwitch('mail').locator('.switch')).not.toHaveClass(/\bon\b/);
  await closeSettings();

  // The window left Mail for the first mode that shows, and Mail's tab and shortcut are gone.
  await expect(tab('mail')).toHaveCount(0);
  await expect(tab('calendar')).toHaveAttribute('aria-selected', 'true');
  await expect(shell()).toHaveClass(/calendar-mode/);
  await win.keyboard.press('Control+1');
  await expect(shell()).toHaveClass(/calendar-mode/);

  // New mail: no notification, no new-mail cue in the window, no badge count, no tray dot or count.
  await win.evaluate(() => (window.__badges = []));
  await arrive('While Mail is hidden');
  await expect.poll(() => app.evaluate(() => global.__semHiddenMail || 0)).toBeGreaterThan(0);
  expect(await app.evaluate(() => global.__shown)).toEqual([]);
  expect(await win.evaluate(() => window.__newMail)).toEqual([]);
  expect((await win.evaluate(() => window.__badges)).filter((n) => n > 0)).toEqual([]);
  expect(await tray()).toEqual({ tooltip: 'Rukoo Mail', dot: false, compose: false });

  // An email link opened with Rukoo: no compose window, and a notice that offers to turn Mail on.
  await app.evaluate(({ app }) => app.emit('second-instance', {}, ['Rukoo Mail.exe', '--', 'mailto:sanne@example.com?subject=Hoi'], process.cwd()));
  await expect(win.locator('#toast')).toContainText('Mail is turned off');
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);

  // The notice's Turn on brings Mail back, with what came in meanwhile, and its notifications.
  await win.locator('#toast button').click();
  await expect(tab('mail')).toBeVisible();
  await expect(shell()).not.toHaveClass(/calendar-mode/);
  await expect(win.locator('.item', { hasText: 'While Mail is hidden' })).toBeVisible();
  expect((await tray()).compose).toBe(true);
  await arrive('Mail is back');
  await expect.poll(() => app.evaluate(() => global.__shown.length)).toBeGreaterThan(0);
});

test('the last tab that shows stays on; a restart keeps the choice and starts in a mode that shows', async () => {
  await openTabsSettings();
  await modeSwitch('mail').click();
  await expect(modeSwitch('mail').locator('.switch')).not.toHaveClass(/\bon\b/);
  await modeSwitch('calendar').click();
  await expect(modeSwitch('calendar').locator('.switch')).not.toHaveClass(/\bon\b/);
  // Meet is the only one left: its switch can't go off.
  await expect(modeSwitch('meeting')).toBeDisabled();
  await expect(modeSwitch('meeting')).toContainText('The only tab that shows');
  await modeSwitch('meeting').click({ force: true });
  await expect(modeSwitch('meeting').locator('.switch')).toHaveClass(/\bon\b/);
  expect(await app.evaluate(() => global.__semEngine.settings.hiddenModes)).toEqual(['mail', 'calendar']);
  await closeSettings();
  // One mode: no tabs at all, and the window is in it.
  await expect(win.locator('.titlebar-modes .mode-tabs')).toHaveCount(0);
  await expect(shell()).toHaveClass(/meeting-mode/);

  // The window was in Mail when it last closed; after the restart it starts in Meet.
  await win.evaluate(() => {
    const prefs = JSON.parse(localStorage.getItem('rukoo.layout') || '{}');
    localStorage.setItem('rukoo.layout', JSON.stringify({ ...prefs, mode: 'mail' }));
  });
  await closeApp(app);
  await launch();
  await expect(shell()).toHaveClass(/meeting-mode/, { timeout: 15000 });
  await expect(win.locator('.titlebar-modes .mode-tabs')).toHaveCount(0);
  await expect(win.locator('.list-scroll')).toBeHidden();

  // Calendar back on: two tabs again, in their order.
  await openTabsSettings();
  await expect(modeSwitch('meeting')).toBeDisabled();
  await modeSwitch('calendar').click();
  await expect(modeSwitch('meeting')).toBeEnabled();
  await closeSettings();
  await expect(win.locator('.titlebar-modes [role="tab"]')).toHaveText(['Calendar', 'Meet']);
  await win.keyboard.press('Control+2');
  await expect(shell()).toHaveClass(/calendar-mode/);
});
