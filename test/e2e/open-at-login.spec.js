// End-to-end tests for Settings > General > Open when you sign in (src/main/loginitem.js) and the hidden start it sets
// up. Test mode never touches the system's login items: on Linux the autostart entry goes to the test profile's
// autostart folder, on Windows and macOS main keeps the login item in memory (memoryLogin). A real sign-in is checked by
// hand on an installed build.
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { tempDir, removeDir } = require('../tmp');
const { closeApp } = require('./close');

const MAC = process.platform === 'darwin';
const LINUX = process.platform === 'linux';

let app;
let win;
let dataDir;
let running;

async function launch(args = []) {
  const env = { ...process.env, SEM_DATA_DIR: dataDir, SEM_HIDDEN: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: ['.', ...args], cwd: path.join(__dirname, '..', '..'), env });
  running = true;
  app.process().once('exit', () => (running = false));
  win = await app.firstWindow();
}

test.beforeEach(async () => {
  dataDir = tempDir('sem-e2e-');
  await launch();
  await win.waitForSelector('.provider-grid');
  await win.click('[data-s="demo"]');
  await expect(win.locator('.item').first()).toBeVisible({ timeout: 15000 });
});

test.afterEach(async () => {
  if (running) await closeApp(app);
  removeDir(dataDir);
});

const entryFile = () => path.join(dataDir, 'autostart', 'rukoo-mail.desktop');
// What the system has: Linux's autostart entry in the profile, or the login item main keeps in memory.
const registered = async () => {
  if (LINUX) return fs.existsSync(entryFile()) ? fs.readFileSync(entryFile(), 'utf8') : null;
  return app.evaluate(() => {
    const { state } = global.__semLoginItem.system;
    return state.openAtLogin && state.enabled ? `${state.path} ${state.args.join(' ')}` : null;
  });
};
// What the system's own settings do: GNOME and KDE turn the entry off in place, Windows' Startup apps and macOS's
// Login Items turn the item off.
const turnOffInSystem = async () => {
  if (LINUX) fs.appendFileSync(entryFile(), 'Hidden=true\n');
  else await app.evaluate(() => global.__semLoginItem.system.off());
};

const row = () => win.locator('.settings [data-a="open-at-login"]');

test('the switch turns the login item on and off, starts off, and shows what the system has', async () => {
  await win.click('[data-action="settings"]');
  await expect(row()).toContainText(MAC ? 'Open at login' : 'Open when you sign in');
  await expect(row()).toContainText('new mail and team chat notify you without opening Rukoo first');
  await expect(row().locator('.switch')).not.toHaveClass(/\bon\b/);
  expect(await registered()).toBeNull();

  await row().click();
  await expect(row().locator('.switch')).toHaveClass(/\bon\b/);
  await expect(row()).toBeFocused();
  // Started hidden, by this profile's program; the test run never registers Electron or its own folder.
  const entry = await registered();
  expect(entry).toContain('--start-hidden');
  if (LINUX) expect(entry).toContain(`Exec="${path.join(dataDir, 'Rukoo Mail')}" --start-hidden`);

  // Turned off in the system's own settings: coming back to Rukoo shows it off.
  await turnOffInSystem();
  await win.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(row().locator('.switch')).not.toHaveClass(/\bon\b/);

  // On again here, and off.
  await row().click();
  await expect(row().locator('.switch')).toHaveClass(/\bon\b/);
  expect(await registered()).toContain('--start-hidden');
  await row().click();
  await expect(row().locator('.switch')).not.toHaveClass(/\bon\b/);
  expect(await registered()).toBeNull();
});

test('a copy that may not register shows why, without a switch, and main refuses it too', async () => {
  // What loginTarget() gives a portable or unpacked copy and a run from source.
  await app.evaluate(() => (global.__semLoginItem.target = null));
  await win.click('[data-action="settings"]');
  const line = win.locator('.settings [data-login]');
  await expect(line).toContainText(MAC ? 'Move Rukoo Mail to Applications and open it there first.' : 'Only the installed app can open when you sign in.');
  await expect(line.locator('.switch')).toHaveCount(0);
  await expect(row()).toHaveCount(0);
  const refused = await win.evaluate(() => window.mail.call('setOpenAtLogin', true).then(() => 'set', (err) => err.message));
  expect(refused).toContain('Only the installed app');
  expect(await registered()).toBeNull();
});

// The main window, as main sees it.
const main = () =>
  app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().endsWith('index.html'));
    return w ? { visible: w.isVisible(), focused: w.isFocused() } : null;
  });

test('started by the login item, the window stays hidden with a tray icon, also with close to tray off', async () => {
  // Close to tray and minimize to tray off, as on Linux by default.
  await win.evaluate(() => window.mail.call('updateSettings', { closeToTray: false, minimizeToTray: false }));
  await closeApp(app);
  await launch(['--start-hidden']);
  await win.waitForLoadState('domcontentloaded');
  await expect(win.locator('.item').first()).toBeAttached({ timeout: 15000 });
  // It stays hidden, and nothing took the focus.
  await win.waitForTimeout(1500);
  expect(await main()).toEqual({ visible: false, focused: false });
  if (!MAC) expect(await app.evaluate(() => Boolean(global.__semTray))).toBe(true);

  // The login item starting Rukoo again changes nothing; the person starting it shows the window.
  await app.evaluate(({ app }) => app.emit('second-instance', {}, ['rukoo', '--start-hidden'], process.cwd()));
  await win.waitForTimeout(500);
  expect((await main()).visible).toBe(false);
  await app.evaluate(({ app }) => app.emit('second-instance', {}, ['rukoo'], process.cwd()));
  await expect.poll(async () => (await main()).visible).toBe(true);
  // The tray icon stays for this run.
  if (!MAC) expect(await app.evaluate(() => Boolean(global.__semTray))).toBe(true);

  // With close to tray off, closing the window quits, as that setting says.
  if (!MAC) {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().endsWith('index.html')).close());
    await expect.poll(() => running, { timeout: 30000 }).toBe(false);
  }
});

test('a normal start shows the window and leaves the tray as the settings say', async () => {
  await win.evaluate(() => window.mail.call('updateSettings', { closeToTray: false, minimizeToTray: false }));
  await closeApp(app);
  await launch();
  await expect(win.locator('.item').first()).toBeVisible({ timeout: 15000 });
  expect((await main()).visible).toBe(true);
  expect(await app.evaluate(() => Boolean(global.__semTray))).toBe(false);
});
