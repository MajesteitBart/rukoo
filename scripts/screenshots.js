// Dev helper: launches the app with a temp profile and saves screenshots of the main screens.
const { _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');

(async () => {
  const out = path.resolve(process.argv[2] || 'shots');
  fs.mkdirSync(out, { recursive: true });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sem-shot-'));
  const app = await electron.launch({ args: ['.'], cwd: path.join(__dirname, '..'), env: (({ ELECTRON_RUN_AS_NODE, ...rest }) => ({ ...rest, SEM_DATA_DIR: dataDir }))(process.env) });
  const win = await app.firstWindow();
  const logs = [];
  win.on('console', (m) => logs.push(`${m.type()}: ${m.text()}`));
  win.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`));
  await win.setViewportSize({ width: 1600, height: 1000 }).catch(() => {});
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1600, 1000));
  await win.waitForSelector('.provider-grid', { timeout: 15000 });
  if (process.env.THEME) await win.evaluate((t) => window.mail.call('updateSettings', { theme: t }), process.env.THEME);
  await win.waitForTimeout(400);
  await win.screenshot({ path: path.join(out, '1-setup.png') });
  await win.click('[data-s="demo"]');
  await win.waitForSelector('.item', { timeout: 15000 });
  await win.waitForTimeout(500);
  await win.screenshot({ path: path.join(out, '2-inbox.png') });
  await win.click('.item >> nth=0');
  await win.waitForSelector('.mail-frame', { timeout: 15000 });
  await win.waitForTimeout(1200);
  await win.screenshot({ path: path.join(out, '3-reader.png') });
  await win.click('[data-reader="forward"]');
  await win.waitForSelector('.compose', { timeout: 5000 });
  await win.waitForTimeout(1000);
  await win.screenshot({ path: path.join(out, '4-compose.png') });
  await win.click('[data-c="close"]');
  await win.waitForTimeout(300);
  if (await win.$('.scrim')) await win.click('.scrim .buttons button >> text=Verwijderen');
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
