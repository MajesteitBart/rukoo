// Native macOS verification. These tests run on both Intel and Apple Silicon CI.
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { tempDir, removeDir } = require('../tmp');

test.skip(process.platform !== 'darwin', 'Requires native macOS');
const root = path.join(__dirname, '../..');
const evidence = path.join(root, 'tmp/macos-evidence');
let app, win, profile;

test.beforeEach(async () => {
  profile = tempDir('rukoo-mac-');
  const env = { ...process.env, SEM_DATA_DIR: profile, SEM_AGENT_FAKE: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.SEM_HIDDEN;
  const executablePath = process.env.SEM_MAC_PACKAGED ? path.join(root, 'dist', process.arch === 'arm64' ? 'mac-arm64' : 'mac', 'Rukoo Mail.app', 'Contents', 'MacOS', 'Rukoo Mail') : undefined;
  app = await electron.launch({ executablePath, args: executablePath ? [] : ['.'], cwd: root, env });
  win = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1400, 950));
});
test.afterEach(async () => {
  if (app) {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.destroy())).catch(() => {});
    await app.close().catch(() => {});
  }
  removeDir(profile);
});
async function demo() {
  await win.click('[data-s="demo"]');
  await expect(win.locator('.item').first()).toBeVisible();
}
async function compose() {
  const next = app.waitForEvent('window');
  await win.evaluate(() => window.mail.call('openCompose', { mode: 'new' }));
  const page = await next;
  page.on('dialog', () => {});
  await expect(page.locator('.compose .editor')).toBeVisible();
  return page;
}

test('native Mac layout, localized Command hints and zoom work in both windows', async () => {
  await demo();
  fs.mkdirSync(evidence, { recursive: true });
  await expect(win.locator('html')).toHaveAttribute('data-platform', 'darwin');
  await win.screenshot({ path: path.join(evidence, 'inbox.png') });
  const editor = await compose();
  await editor.locator('[data-field="subject"]').fill('Mac desktop support');
  await editor.locator('.editor').fill('Hi Sanne,\n\nThis is a demo draft in Rukoo on macOS.');
  await win.click('[data-action="settings"]');
  for (const [theme, language, width, zoom] of [['dark', 'en', 1400, 100], ['light', 'nl', 1400, 100], ['dark', 'nl', 1000, 100], ['light', 'en', 1400, 150]]) {
    await win.evaluate((settings) => window.mail.call('updateSettings', settings), { theme, language });
    await win.evaluate((level) => window.mail.call('setZoom', level), zoom);
    await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('index.html')).setSize(width, 950), width);
    await expect(win.locator('html')).toHaveAttribute('lang', language);
    await expect(editor.locator('html')).toHaveAttribute('lang', language);
    await expect.poll(() => editor.evaluate(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--mac-titlebar-inset')))).toBeCloseTo(86 / (zoom / 100));
    await expect.poll(() => win.locator('[data-mailto-help]').textContent()).toContain('macOS');
    await win.waitForTimeout(300);
    await win.locator('[data-mailto]').scrollIntoViewIfNeeded();
    await win.screenshot({ path: path.join(evidence, `settings-${theme}-${language}-${zoom}.png`) });
    await editor.screenshot({ path: path.join(evidence, `compose-${theme}-${language}-${zoom}.png`) });
  }
});

test('closing the main window keeps its draft and Dock activation reopens the same window', async () => {
  await demo();
  expect(await win.evaluate(() => window.mail.call('state').then((s) => s.settings.closeToTray))).toBe(false);
  await win.keyboard.press('Meta+n');
  await win.locator('.composer .editor').fill('Keep my Mac draft');
  const id = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].id);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(false);
  await app.evaluate(({ app }) => app.emit('activate'));
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(true);
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].id)).toBe(id);
  await expect(win.locator('.composer .editor')).toHaveText('Keep my Mac draft');
});

test('macOS open-url fills a composer and a source profile cannot change the default mail app', async () => {
  await demo();
  const next = app.waitForEvent('window');
  expect(await app.evaluate(({ app }) => {
    let prevented = false;
    app.emit('open-url', { preventDefault() { prevented = true; } }, 'mailto:anna@example.com?subject=Mac%20link&body=Hello');
    return prevented;
  })).toBe(true);
  const editor = await next;
  await expect(editor.locator('[data-field="subject"]')).toHaveValue('Mac link');
  await expect(editor.locator('.editor')).toHaveText('Hello');
  const status = await win.evaluate(() => window.mail.call('mailtoStatus'));
  expect(status).toMatchObject({ available: false, platform: 'darwin' });
  await expect(win.evaluate(() => window.mail.call('useForMailto'))).rejects.toThrow();
});

test('Command zoom persists and native Edit menu selects mailbox messages', async () => {
  await demo();
  await win.evaluate(() => window.mail.call('updateSettings', { badge: 'unread' }));
  await expect.poll(() => app.evaluate(({ app }) => app.dock.getBadge())).toMatch(/^[1-9][0-9]*$/);
  await win.evaluate(() => window.mail.call('updateSettings', { badge: 'none' }));
  await expect.poll(() => app.evaluate(({ app }) => app.dock.getBadge())).toBe('');
  await win.keyboard.press('Meta+=');
  await expect.poll(() => win.evaluate(() => window.mail.call('state').then((s) => s.settings.zoomLevel))).toBe(110);
  await win.keyboard.press('Meta+0');
  await expect.poll(() => win.evaluate(() => window.mail.call('state').then((s) => s.settings.zoomLevel))).toBe(100);
  const menu = await app.evaluate(({ Menu }) => Menu.getApplicationMenu().items.map((item) => item.role?.toLowerCase() || item.label));
  expect(menu).toContain('appmenu');
  expect(menu).toContain('Edit');
  await win.keyboard.press('Meta+a');
  await expect(win.locator('.item.checked').first()).toBeVisible();
});

for (const answer of ["Don't save", 'Save']) {
  test(`quitting after a dirty composer answers ${answer} exits the app`, async () => {
    await demo();
    const editor = await compose();
    await editor.locator('[data-field="subject"]').fill('Mac quit verification');
    await editor.locator('.editor').fill('A demo draft with unsaved changes');
    await app.evaluate(({ app }) => app.quit());
    await expect(editor.locator('.scrim')).toContainText('Save draft?');
    const closed = app.waitForEvent('close');
    await editor.getByRole('button', { name: answer, exact: true }).click();
    await closed;
    app = null;
    if (answer === 'Save') {
      const env = { ...process.env, SEM_DATA_DIR: profile, SEM_AGENT_FAKE: '1' };
      delete env.ELECTRON_RUN_AS_NODE;
      delete env.SEM_HIDDEN;
      app = await electron.launch({ args: ['.'], cwd: root, env });
      win = await app.firstWindow();
      await expect(win.locator('.item').first()).toBeVisible();
      await win.click('[data-view="drafts"]');
      await expect(win.locator('.item', { hasText: 'Mac quit verification' })).toBeVisible();
    }
  });
}
