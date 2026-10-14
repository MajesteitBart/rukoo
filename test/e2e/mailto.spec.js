// mailto: links: a link Rukoo is started with or handed while it runs (as Windows does for the app the user picked),
// a link in a message, the compose window before any account exists, and Settings > Email links.
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');

const LINK =
  'mailto:anna@example.com,%22Doe%2C%20Jane%22%20%3Cjane@example.com%3E?cc=joris@example.com&bcc=sanne@example.com&subject=1+1%3D2&body=First%20line%0D%0ASecond%20line';

let app;
let dataDir;

async function launch(args = [], settings = {}) {
  fs.mkdirSync(path.join(dataDir, 'data'), { recursive: true });
  const file = path.join(dataDir, 'data', 'settings.json');
  const current = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  fs.writeFileSync(file, JSON.stringify({ ...current, ...settings }));
  const env = { ...process.env, SEM_DATA_DIR: dataDir, SEM_HIDDEN: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: ['.', ...args], cwd: path.join(__dirname, '..', '..'), env });
  const win = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1500, 950));
  return win;
}

async function quit() {
  if (!app) return;
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.destroy())).catch(() => {});
  await app.close();
  app = null;
}

// A profile with the demo account, ready for the next launch.
async function withDemo() {
  const win = await launch();
  await win.waitForSelector('.provider-grid');
  await win.click('[data-s="demo"]');
  await expect(win.locator('.item').first()).toBeVisible({ timeout: 15000 });
  return win;
}

// The separate compose window, once it is there.
async function composeWindow() {
  let page = null;
  await expect.poll(() => (page = app.windows().find((p) => p.url().endsWith('compose.html')) || null)).not.toBeNull();
  return page;
}

async function expectFilled(compose) {
  await compose.waitForSelector('.compose .editor');
  await expect(compose.locator('[data-rfield="to"] .recipient')).toHaveText(['anna@example.com', 'Doe, Jane']);
  await expect(compose.locator('[data-rfield="cc"] .recipient')).toHaveText(['joris@example.com']);
  await expect(compose.locator('[data-rfield="bcc"] .recipient')).toHaveText(['sanne@example.com']);
  await expect(compose.locator('[data-field="subject"]')).toHaveValue('1+1=2');
  expect(await compose.locator('.editor').evaluate((e) => e.innerText.trim())).toBe('First line\nSecond line');
}

const mainVisible = () =>
  app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().endsWith('index.html'));
    return Boolean(w && w.isVisible());
  });

// What Windows does when Rukoo already runs: start it again with the link, which the first instance receives.
const startAgain = (args) => app.evaluate(({ app }, args) => app.emit('second-instance', {}, args, process.cwd()), args);

test.beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sem-e2e-mailto-'));
});

test.afterEach(async () => {
  await quit();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('a link Rukoo is started with opens a filled-in compose window over the main window', async () => {
  await withDemo();
  await quit();
  await launch([LINK]);
  await expectFilled(await composeWindow());
  expect(await mainVisible()).toBe(true);
});

test('a link for a running Rukoo opens only its compose window, and a main window in the tray stays there', async () => {
  await withDemo();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
  await startAgain(['Rukoo Mail.exe', '--', LINK]);
  await expectFilled(await composeWindow());
  expect(await mainVisible()).toBe(false);
  // Started again without a link, Rukoo shows its main window as before.
  await startAgain(['Rukoo Mail.exe']);
  await expect.poll(mainVisible).toBe(true);
});

test('a link before any account is added says so, and becomes the message once there is one', async () => {
  const win = await launch();
  await win.waitForSelector('.provider-grid');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
  await startAgain(['Rukoo Mail.exe', '--', LINK]);
  const compose = await composeWindow();
  await expect(compose.locator('[data-compose-empty]')).toHaveText('Add an email account in Rukoo Mail before you write an email.');
  await expect.poll(mainVisible).toBe(true);
  // It follows the language like the editor does.
  await win.evaluate(() => window.mail.call('updateSettings', { language: 'nl' }));
  await expect(compose.locator('[data-compose-empty]')).toHaveText('Voeg in Rukoo Mail eerst een e-mailaccount toe voordat je een e-mail schrijft.');
  await win.evaluate(() => window.mail.call('updateSettings', { language: 'en' }));
  // Add an account in the main window, come back: the link's message is ready to write.
  await win.click('[data-s="demo"]');
  await expect(win.locator('.item').first()).toBeVisible({ timeout: 15000 });
  await compose.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expectFilled(compose);
});

test('the compose window for a link before any account can be closed', async () => {
  const win = await launch();
  await win.waitForSelector('.provider-grid');
  await startAgain(['Rukoo Mail.exe', '--', LINK]);
  const compose = await composeWindow();
  await compose.click('.compose-error button');
  await expect.poll(() => app.windows().some((p) => p.url().endsWith('compose.html'))).toBe(false);
});

test('a link still opens after the main window closed while a compose window stayed open', async () => {
  await withDemo();
  await quit();
  const win = await launch([], { closeToTray: false, minimizeToTray: false });
  await expect(win.locator('.item').first()).toBeVisible({ timeout: 15000 });
  await startAgain(['Rukoo Mail.exe', '--', LINK]);
  await expectFilled(await composeWindow());
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('index.html')).close());
  await expect.poll(() => app.windows().some((p) => p.url().endsWith('index.html'))).toBe(false);
  await startAgain(['Rukoo Mail.exe', '--', 'mailto:second@example.com?subject=Second']);
  await expect.poll(() => app.windows().filter((p) => p.url().endsWith('compose.html')).length).toBe(2);
});

test('a mailto: link in a message opens a compose window with its Cc and Bcc', async () => {
  const win = await withDemo();
  const state = await win.evaluate(() => window.mail.call('state'));
  await win.evaluate(
    ([accountId, link]) => window.mail.call('saveDraft', { accountId, to: ['a@example.com'], subject: 'Has a link', html: `<p><a href="${link}">Write to us</a></p>` }),
    [state.accounts[0].id, LINK]
  );
  await win.click('[data-view="drafts"]');
  await win.locator('.item', { hasText: 'Has a link' }).first().click();
  await win.frameLocator('.mail-frame').locator('a', { hasText: 'Write to us' }).click();
  await expectFilled(await composeWindow());
});

for (const [language, title, value] of [
  ['en', 'Email links', 'Only in the installed or portable app'],
  ['nl', 'E-maillinks', 'Alleen in de geïnstalleerde of draagbare app']
]) {
  test(`Settings shows Email links, and a run from source can't offer itself (${language})`, async () => {
    await withDemo();
    await quit();
    const win = await launch([], { language });
    await expect(win.locator('.item').first()).toBeVisible({ timeout: 15000 });
    await win.click('[data-action="settings"]');
    const row = win.locator('[data-mailto]');
    await expect(row.locator('.title')).toHaveText(title);
    await expect(row.locator('[data-mailto-value]')).toHaveText(value);
    await expect(row.locator('[data-a="mailto-use"]')).toBeDisabled();
    // Main answers the same for a direct call, and writes nothing.
    await expect(win.evaluate(() => window.mail.call('useForMailto'))).rejects.toThrow(value);
  });
}
