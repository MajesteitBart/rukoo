// Linux desktop defaults, window controls and localized integration guidance.
const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('path');
const { tempDir, removeDir } = require('../tmp');

test('Linux closes normally by default and persists opt-in tray settings', async () => {
  test.skip(process.platform !== 'linux');
  const dataDir = tempDir('rukoo-linux-');
  const env = { ...process.env, SEM_DATA_DIR: dataDir, SEM_HIDDEN: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  let app;
  const launch = async () => {
    app = await electron.launch({ args: ['.'], cwd: path.join(__dirname, '../..'), env });
    return app.firstWindow();
  };
  try {
    let win = await launch();
    await win.click('[data-s="demo"]');
    await expect(win.locator('.item').first()).toBeVisible();
    const settings = await win.evaluate(() => window.mail.call('state').then((s) => s.settings));
    expect(settings.closeToTray).toBe(false);
    expect(settings.minimizeToTray).toBe(false);
    expect(await app.evaluate(() => global.__semTray)).toBeNull();
    const exited = app.waitForEvent('close');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await exited;
    app = null;
    win = await launch();
    await expect(win.locator('.item').first()).toBeVisible();
    await win.evaluate(() => window.mail.call('updateSettings', { closeToTray: true }));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.destroy()));
    await app.close();
    app = null;
    win = await launch();
    await expect(win.locator('.item').first()).toBeVisible();
    expect(await win.evaluate(() => window.mail.call('state').then((s) => s.settings.closeToTray))).toBe(true);
    expect(await app.evaluate(() => Boolean(global.__semTray))).toBe(true);
  } finally {
    if (app) {
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.destroy())).catch(() => {});
      await app.close();
    }
    removeDir(dataDir);
  }
});
