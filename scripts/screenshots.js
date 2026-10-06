// Dev helper: launches the app with a temp profile and saves screenshots of the main screens.
// Usage: node scripts/screenshots.js <dir>   (THEME=dark|light to force a theme)
const { _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');

(async () => {
  const out = path.resolve(process.argv[2] || 'shots');
  fs.mkdirSync(out, { recursive: true });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sem-shot-'));
  const env = (({ ELECTRON_RUN_AS_NODE, ...rest }) => ({ ...rest, SEM_DATA_DIR: dataDir }))(process.env);
  const app = await electron.launch({ args: ['.'], cwd: path.join(__dirname, '..'), env });
  const win = await app.firstWindow();
  const logs = [];
  const watch = (page) => {
    page.on('console', (m) => m.type() !== 'log' && logs.push(`${m.type()}: ${m.text()}`));
    page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`));
  };
  watch(win);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1600, 1000));
  await win.waitForSelector('.provider-grid', { timeout: 15000 });
  if (process.env.THEME) await win.evaluate((t) => window.mail.call('updateSettings', { theme: t }), process.env.THEME);
  await win.waitForTimeout(400);
  await win.screenshot({ path: path.join(out, '1-setup.png') });
  await win.click('[data-s="demo"]');
  await win.waitForSelector('.item', { timeout: 15000 });
  // Let the "account added" notice fade and keep the pointer off the list, so no row shows its hover state.
  await win.mouse.move(1590, 990);
  await win.waitForTimeout(3000);
  await win.screenshot({ path: path.join(out, '2-inbox.png') });
  await win.click('.item >> nth=0');
  await win.waitForSelector('.mail-frame', { timeout: 15000 });
  await win.mouse.move(1590, 990);
  await win.waitForTimeout(1200);
  await win.screenshot({ path: path.join(out, '3-reader.png') });

  // Compose opens in its own window.
  const [compose] = await Promise.all([app.waitForEvent('window'), win.click('[data-reader="forward"]')]);
  watch(compose);
  await compose.waitForSelector('.compose .editor', { timeout: 15000 });
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('compose.html'));
    w.setSize(940, 820);
  });
  await compose.waitForTimeout(1200);
  await compose.screenshot({ path: path.join(out, '4-compose.png') });
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()
      .filter((x) => x.webContents.getURL().includes('compose.html'))
      .forEach((x) => x.destroy());
  });

  await win.click('[data-action="settings"]');
  await win.waitForSelector('.settings .card');
  await win.waitForTimeout(400);
  await win.screenshot({ path: path.join(out, '5-settings.png') });
  console.log(logs.join('\n') || 'no console output');
  await app.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
