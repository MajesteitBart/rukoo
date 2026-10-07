// Dev helper: launches the app with a temp profile and saves screenshots of the main screens, once in
// light and once in dark, to <dir>/light and <dir>/dark.
// Usage: node scripts/screenshots.js <dir>   (THEME=dark|light for one theme only)
const { _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');

async function capture(theme, out) {
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
  const resize = (height) => app.evaluate(({ BrowserWindow }, h) => BrowserWindow.getAllWindows()[0].setSize(1600, h), height);
  // Keep the pointer off the list, so no row shows its hover state.
  const shot = async (name, wait = 800) => {
    await win.mouse.move(1595, 995);
    await win.waitForTimeout(wait);
    await win.screenshot({ path: path.join(out, name) });
  };
  const item = (subject) => win.locator('.item', { hasText: subject }).first();

  await resize(1000);
  await win.waitForSelector('.provider-grid', { timeout: 15000 });
  await win.evaluate((t) => window.mail.call('updateSettings', { theme: t }), theme);
  await shot('01-setup.png', 400);
  await win.click('[data-s="demo"]');
  await win.waitForSelector('.item', { timeout: 15000 });

  // The newest message opens by itself. Wait for the logos and for the "account added" notice to fade.
  await win.waitForSelector('.mail-frame', { timeout: 15000 });
  await shot('02-inbox.png', 3500);

  // Scrolled down, the subject moves into the toolbar. The newsletter fits a full-height window, so shorten it.
  await resize(640);
  await win.waitForTimeout(500);
  await win.locator('.reader-scroll').evaluate((el) => el.scrollTo(0, 400));
  await shot('03-reader-scrolled.png');
  await resize(1000);
  await win.waitForTimeout(500);

  await item('Afspraak donderdag').click();
  await win.waitForSelector('.reader-subject:text-is("Afspraak donderdag")');
  await shot('04-reader.png');
  await win.click('[data-reader="details"]');
  await shot('05-reader-details.png');

  await win.click('.stack-btn');
  await shot('06-stack-open.png');
  await win.click('.stack-btn.open');

  // Replies open in the reading pane.
  await item('Afspraak donderdag').click();
  await win.click('[data-reader="reply"]');
  await win.waitForSelector('.composer .editor', { timeout: 15000 });
  await win.keyboard.type('Hoi Sanne, donderdag om 10:00 is goed. Ik bel je dan.');
  await shot('07-reply.png');
  // Select the last words, so the formatting bar shows above them.
  await win.keyboard.down('Shift');
  for (let i = 0; i < 12; i++) await win.keyboard.press('ArrowLeft');
  await win.keyboard.up('Shift');
  await shot('08-reply-format.png', 300);
  await win.keyboard.press('End');
  await win.click('.composer [data-c="quote"]');
  await shot('09-reply-quote.png');
  await win.click('.composer [data-c="close"]');
  if (await win.$('.scrim')) await win.click('.scrim .buttons button:text-is("Niet opslaan")');
  await win.waitForTimeout(300);

  await win.click('[data-action="settings"]');
  await win.waitForSelector('.settings .card');
  await shot('10-settings.png', 400);
  console.log(`${theme}: ${logs.join('\n') || 'no console output'}`);
  await app.close();
}

(async () => {
  const out = path.resolve(process.argv[2] || 'shots');
  const themes = process.env.THEME ? [process.env.THEME] : ['light', 'dark'];
  for (const theme of themes) await capture(theme, path.join(out, theme));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
