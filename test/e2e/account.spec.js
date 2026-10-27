// The Rukoo account in Settings: signing up with a recovery key, the devices, what's stored and shared, the export,
// signing out and in again. The real app with a throwaway profile, against the in-memory account server.
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { tempDir, removeDir } = require('../tmp');
const { closeApp } = require('./close');
const { startAccountServer } = require('../fixtures/account-server');

let app;
let win;
let dataDir;
let server;

const PASSWORD = 'a long enough password';

test.beforeEach(async () => {
  server = await startAccountServer();
  dataDir = tempDir('rukoo-account-e2e-');
  const env = { ...process.env, SEM_DATA_DIR: dataDir, SEM_HIDDEN: '1', RUKOO_ACCOUNT_SERVER: server.url };
  delete env.ELECTRON_RUN_AS_NODE;
  // The session is stored with safeStorage, which needs the real keyring on Linux (see the IMAP tests).
  const entry = process.platform === 'linux' ? path.join(__dirname, '..', 'fixtures', 'linux-keyring-app.js') : '.';
  app = await electron.launch({ args: [entry], cwd: path.join(__dirname, '..', '..'), env });
  win = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1400, 950));
  await win.waitForSelector('.provider-grid');
  await win.click('[data-s="demo"]');
  await expect(win.locator('.item').first()).toBeVisible({ timeout: 15000 });
});

test.afterEach(async () => {
  await closeApp(app);
  removeDir(dataDir);
  await server.close();
});

const page = () => win.locator('.page.settings');
const rowOf = (text) => page().locator('.row', { hasText: text }).first();

async function openAccount() {
  await win.click('[data-action="settings"]');
  await page().locator('[data-a="rukoo"]').click();
  await expect(page().locator('h1')).toHaveText('Rukoo account');
}

test('the page says what the account is, who runs the server and what it can see', async () => {
  await openAccount();
  await expect(page().locator('.settings-text').first()).toContainText('only your devices have the key');
  const serverRow = page().locator('[data-a="rukoo-server"]');
  await expect(serverRow).toContainText('127.0.0.1');
  await expect(serverRow).toContainText('Run by Test operator · Data stored in the EU');

  await page().locator('[data-a="rukoo-go:rukoo-privacy"]').click();
  await expect(page().locator('h1')).toHaveText("What's stored and shared");
  await expect(rowOf('Cloudflare, Inc.')).toContainText('from the United States. Data stored in the EU.');
  await expect(rowOf('Cloudflare, Inc.')).toContainText('As a US company it falls under US law');
  await expect(rowOf('Test operator')).toContainText('Gets your email address, your device names and your encrypted records.');
  await expect(page()).toContainText('Your IP address');
  await expect(page()).toContainText('Rukoo uses no analytics, advertising or tracking services.');
  await expect(page().locator('[data-a="rukoo-link:policy"]')).toBeVisible();
});

test('signing up shows the recovery key once, then the devices; signing out and in again works', async () => {
  await openAccount();
  await page().locator('[data-a="rukoo-go:rukoo-signup"]').click();
  const form = page().locator('form[data-form="rukoo-signup"]');
  await form.locator('[name="email"]').fill('bart@example.com');
  await form.locator('[name="password"]').fill(PASSWORD);
  await form.locator('[name="repeat"]').fill('something else entirely');
  await form.locator('button[type=submit]').click();
  await expect(form.locator('[data-error]')).toHaveText("The passwords don't match.");
  await form.locator('[name="repeat"]').fill(PASSWORD);
  await form.locator('button[type=submit]').click();
  await expect(form.locator('[data-error]')).toHaveText('Tick the box to confirm.');
  await form.locator('[name="understand"]').check();
  await form.locator('button[type=submit]').click();

  const dialog = win.locator('.scrim .dialog');
  await expect(dialog.locator('h2')).toHaveText('Save your recovery key', { timeout: 15000 });
  await expect(dialog.locator('[data-recovery-key]')).toHaveText(/^([0-9A-HJKMNP-TV-Z]{4}-){7}[0-9A-HJKMNP-TV-Z]{4}$/);
  await dialog.locator('.buttons button', { hasText: 'I saved it' }).click();

  await expect(page().locator('h1')).toHaveText('Rukoo account');
  await expect(page()).toContainText('bart@example.com');
  await expect(rowOf('This device')).toBeVisible({ timeout: 15000 });
  expect(server.accounts.has('bart@example.com')).toBe(true);
  expect(JSON.stringify(server.calls)).not.toContain(PASSWORD);

  // The export, through a save dialog that answers by itself.
  const file = path.join(dataDir, 'export.json');
  await app.evaluate(({ dialog: d }, target) => {
    d.showSaveDialog = async () => ({ canceled: false, filePath: target });
  }, file);
  await page().locator('[data-a="rukoo-export"]').click();
  await expect.poll(() => fs.existsSync(file)).toBe(true);
  const exported = JSON.parse(fs.readFileSync(file, 'utf8'));
  expect(exported.email).toBe('bart@example.com');
  expect(Array.isArray(exported.records)).toBe(true);

  await page().locator('[data-a="rukoo-signout"]').click();
  await win.locator('.scrim .buttons button', { hasText: 'Sign out' }).click();
  await expect(page().locator('[data-a="rukoo-go:rukoo-signin"]')).toBeVisible();

  await page().locator('[data-a="rukoo-go:rukoo-signin"]').click();
  const signIn = page().locator('form[data-form="rukoo-signin"]');
  await signIn.locator('[name="email"]').fill('bart@example.com');
  await signIn.locator('[name="password"]').fill('the wrong password');
  await signIn.locator('button[type=submit]').click();
  await expect(signIn.locator('[data-error]')).toHaveText('The email address, password or recovery key is wrong.', { timeout: 15000 });
  await signIn.locator('[name="password"]').fill(PASSWORD);
  await signIn.locator('button[type=submit]').click();
  await expect(page().locator('h1')).toHaveText('Rukoo account');
  await expect(page()).toContainText('bart@example.com', { timeout: 15000 });

  // The overview row says who is signed in.
  await page().locator('[data-a="back"]').click();
  await expect(page().locator('[data-a="rukoo"]')).toContainText('Signed in as bart@example.com');
});

test('another device can be signed out from here', async () => {
  await openAccount();
  await page().locator('[data-a="rukoo-go:rukoo-signup"]').click();
  const form = page().locator('form[data-form="rukoo-signup"]');
  await form.locator('[name="email"]').fill('two@example.com');
  await form.locator('[name="password"]').fill(PASSWORD);
  await form.locator('[name="repeat"]').fill(PASSWORD);
  await form.locator('[name="understand"]').check();
  await form.locator('button[type=submit]').click();
  await win.locator('.scrim .buttons button', { hasText: 'I saved it' }).click({ timeout: 15000 });

  // A laptop signs in on its own, straight at the server.
  const { AccountService } = require('../../src/main/account');
  const secrets = { encrypt: (s) => `plain:${Buffer.from(s).toString('base64')}`, decrypt: (s) => Buffer.from(String(s).slice(6), 'base64').toString() };
  const laptopDir = tempDir('rukoo-account-laptop-');
  const laptop = new AccountService({ dataDir: laptopDir, secrets, defaultServer: server.url, deviceName: 'Laptop', platform: 'darwin' }).init();
  await laptop.signIn({ email: 'two@example.com', password: PASSWORD });

  await page().locator('[data-a="back"]').click();
  await page().locator('[data-a="rukoo"]').click();
  const laptopRow = rowOf('Laptop');
  await expect(laptopRow).toContainText('macOS', { timeout: 15000 });
  await laptopRow.click();
  await win.locator('.scrim .buttons button', { hasText: 'Sign out' }).click();
  await expect(rowOf('Laptop')).toHaveCount(0, { timeout: 15000 });
  await expect(laptop.sync()).rejects.toMatchObject({ code: 'signed_out' });
  laptop.close();
  removeDir(laptopDir);
});

test('a server that compresses its answers anyway makes sync fail where it shows, and the next sync works', async () => {
  await openAccount();
  await page().locator('[data-a="rukoo-go:rukoo-signup"]').click();
  const form = page().locator('form[data-form="rukoo-signup"]');
  await form.locator('[name="email"]').fill('gzip@example.com');
  await form.locator('[name="password"]').fill(PASSWORD);
  await form.locator('[name="repeat"]').fill(PASSWORD);
  await form.locator('[name="understand"]').check();
  await form.locator('button[type=submit]').click();
  await win.locator('.scrim .buttons button', { hasText: 'I saved it' }).click({ timeout: 15000 });
  const sync = page().locator('[data-a="rukoo-sync"]');
  await expect(sync).toContainText('Last synced', { timeout: 15000 });

  // Like a proxy that compresses whatever the app asked for: Rukoo refuses the answer rather than reading it as empty.
  server.gzip = true;
  await sync.click();
  await expect(win.locator('#toast')).toHaveText('The server ran into a problem. Try again later.', { timeout: 15000 });
  await expect(sync.locator('.error')).toHaveText('The server ran into a problem. Try again later.');
  const pulls = server.calls.filter((c) => c.route === 'GET /v1/records');
  expect(pulls.length).toBeGreaterThan(1);
  expect(pulls.map((c) => c.acceptEncoding)).toEqual(pulls.map(() => 'identity'));
  await page().locator('[data-a="back"]').click();
  await expect(page().locator('[data-a="rukoo"]')).toContainText('The server ran into a problem.');

  server.gzip = false;
  await page().locator('[data-a="rukoo"]').click();
  await sync.click();
  await expect(win.locator('#toast')).toHaveText('Synced', { timeout: 15000 });
  await expect(sync.locator('.error')).toHaveCount(0);
  await expect(sync).toContainText('Last synced');
});
