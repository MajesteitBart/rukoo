// Linux desktop defaults, window controls and localized integration guidance.
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { tempDir, removeDir } = require('../tmp');
const { closeApp } = require('./close');
const { titlebar, clearance } = require('./titlebar');

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
    // The quits above are what the test checks, so they stay plain. This one only ends what is left.
    await closeApp(app);
    removeDir(dataDir);
  }
});

// GNOME's button-layout "close,minimize,maximize:" puts the window buttons on the left. Chromium reads it from GTK's
// gtk-decoration-layout, which a desktop without a settings daemon, like this test's, takes from settings.ini.
test('Linux keeps the title bar clear of window buttons on the left, in both windows and at every zoom', async () => {
  test.skip(process.platform !== 'linux');
  const dataDir = tempDir('rukoo-linux-');
  const config = tempDir('rukoo-gtk-');
  for (const gtk of ['gtk-3.0', 'gtk-4.0']) {
    fs.mkdirSync(path.join(config, gtk));
    fs.writeFileSync(path.join(config, gtk, 'settings.ini'), '[Settings]\ngtk-decoration-layout=close,minimize,maximize:\n');
  }
  const env = { ...process.env, SEM_DATA_DIR: dataDir, SEM_HIDDEN: '1', XDG_CONFIG_HOME: config };
  delete env.ELECTRON_RUN_AS_NODE;
  let app;
  try {
    app = await electron.launch({ args: ['.'], cwd: path.join(__dirname, '../..'), env });
    const win = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1500, 950));
    await win.click('[data-s="demo"]');
    await expect(win.locator('.item').first()).toBeVisible();
    // The buttons take the left end of the bar and leave the right end free.
    await expect.poll(() => titlebar(win).then((g) => g.area.left)).toBeGreaterThan(40);
    expect(await win.evaluate(() => innerWidth - navigator.windowControlsOverlay.getTitlebarAreaRect().right)).toBe(0);
    const next = app.waitForEvent('window');
    await win.evaluate(() => window.mail.call('openCompose', { mode: 'new' }));
    const editor = await next;
    editor.on('dialog', () => {});
    await expect(editor.locator('.compose .editor')).toBeVisible();
    for (const zoom of [100, 80, 150]) {
      await win.evaluate((level) => window.mail.call('setZoom', level), zoom);
      await expect.poll(() => clearance(win), `main window at ${zoom}%`).toEqual({ icon: 22, actions: 12 });
      await expect.poll(() => clearance(editor), `compose window at ${zoom}%`).toEqual({ icon: 16, actions: null });
      const main = await titlebar(win);
      expect(main.search.left).toBeGreaterThan(main.area.left);
      const compose = await titlebar(editor);
      expect(compose.title.left).toBeGreaterThan(compose.area.left);
    }
    // The icon rail is narrower than the buttons: the search still starts after them.
    await win.evaluate((level) => window.mail.call('setZoom', level), 100);
    await win.click('[data-action="collapse"]');
    await expect(win.locator('body')).toHaveClass(/collapsed-sidebar/);
    await expect.poll(() => titlebar(win).then((g) => Math.round(g.search.left - g.area.left))).toBe(22);
  } finally {
    await closeApp(app);
    removeDir(dataDir);
    removeDir(config);
  }
});
