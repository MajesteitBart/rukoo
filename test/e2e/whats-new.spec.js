// Rukoo 2.0's "What's new" guide, the keyboard schemes and the update check, in the real app with a throwaway
// profile and the demo account.
const { test, expect, _electron: electron } = require('@playwright/test');
const http = require('http');
const path = require('path');
const { tempDir, removeDir } = require('../tmp');
const { closeApp } = require('./close');
const { startAccountServer } = require('../fixtures/account-server');

let app;
let win;
let dataDir;
let github;

// GitHub's releases API, with a Rukoo newer than this one.
function fakeGitHub() {
  const body = JSON.stringify([
    { tag_name: 'v9.1.0', name: 'v9.1.0', html_url: 'https://github.com/MajesteitBart/rukoo/releases/tag/v9.1.0', draft: false, prerelease: false }
  ]);
  const server = http.createServer((req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end(body));
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

async function launch(extra = {}) {
  const env = { ...process.env, SEM_DATA_DIR: dataDir, SEM_HIDDEN: '1', RUKOO_ACCOUNT_SERVER: 'http://127.0.0.1:9', ...extra };
  delete env.ELECTRON_RUN_AS_NODE;
  const entry = process.platform === 'linux' ? path.join(__dirname, '..', 'fixtures', 'linux-keyring-app.js') : '.';
  app = await electron.launch({ args: [entry], cwd: path.join(__dirname, '..', '..'), env });
  win = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1500, 950));
}

test.beforeEach(async () => {
  dataDir = tempDir('rukoo-whats-new-e2e-');
  github = await fakeGitHub();
});

test.afterEach(async () => {
  await closeApp(app);
  removeDir(dataDir);
  github.close();
});

const guide = () => win.locator('.wn');
const next = () => guide().locator('[data-wn="next"]').click();

test('the guide explains categories first, sorts only at the end, and shows once', async () => {
  await launch({ SEM_WHATS_NEW: '1' });
  await win.waitForSelector('.provider-grid');
  await win.click('[data-s="demo"]');
  await expect(guide().locator('h2')).toHaveText("What's new in Rukoo 2.0", { timeout: 15000 });
  await expect(win.locator('.nav-item.nav-sub')).toHaveCount(0);
  // The first step also names the calendar and the booking page, which ship in the same release.
  await expect(guide().locator('.wn-feature b')).toHaveText(['Inbox categories', 'The same on every device', 'Smarter sorting, if you want it', 'Calendar and booking page']);

  await next();
  await expect(guide().locator('h2')).toHaveText('Choose your categories');
  await guide().locator('.wn-cat', { hasText: 'Promotions' }).click();
  await expect(guide().locator('.wn-cat', { hasText: 'Promotions' }).locator('.switch')).not.toHaveClass(/on/);
  await next();

  await expect(guide().locator('h2')).toHaveText('Keep them the same on every device');
  await expect(guide()).toContainText('End-to-end encrypted');
  await guide().locator('[data-choice="local"]').click();
  await next();

  await expect(guide().locator('h2')).toHaveText('Smarter sorting with Jev');
  await expect(guide()).toContainText('TypeSafe, Inc. in the United States');
  await next();

  await expect(guide().locator('h2')).toHaveText("You're all set");
  await expect(guide()).toContainText('4 categories');
  await expect(guide()).toContainText('Only on this computer');
  // Nothing is sorted until the last button.
  expect(await win.evaluate(() => window.mail.call('categoriesState').then((s) => s.enabled))).toBe(false);
  await next();
  await expect(guide()).toHaveCount(0);
  await expect(win.locator('.nav-item.nav-sub .label')).toHaveText(['Needs you', 'To read', 'Money', 'Updates']);

  // Once seen, it doesn't come back by itself; Settings opens it again.
  await closeApp(app);
  await launch({ SEM_WHATS_NEW: '1' });
  await expect(win.locator('.item').first()).toBeVisible({ timeout: 15000 });
  await win.waitForTimeout(800);
  await expect(guide()).toHaveCount(0);
  await win.click('[data-action="settings"]');
  await win.locator('.page.settings [data-a="whats-new"]').click();
  await expect(guide().locator('h2')).toHaveText("What's new in Rukoo 2.0");
  await next();
  await expect(guide()).toContainText('These are your categories');
});

test('signing in during the guide keeps the categories the account already has', async () => {
  const server = await startAccountServer();
  try {
    // Another computer made the account, renamed Money and deleted Promotions.
    await launch({ RUKOO_ACCOUNT_SERVER: server.url, SEM_WHATS_NEW: '0' });
    await win.waitForSelector('.provider-grid');
    await win.click('[data-s="demo"]');
    await expect(win.locator('.item').first()).toBeVisible({ timeout: 15000 });
    await win.evaluate(async () => {
      await window.mail.call('accountSignUp', { email: 'bart@example.com', password: 'a long enough password', invite: '' });
      await window.mail.call('categoriesSetEnabled', true);
      await window.mail.call('categoriesSave', { id: 'money', name: 'Bills' });
      await window.mail.call('categoriesRemove', 'promotions');
      await window.mail.call('accountSync');
    });
    await closeApp(app);
    removeDir(dataDir);
    dataDir = tempDir('rukoo-whats-new-e2e-');

    // This computer's guide, with Money turned off before signing in.
    await launch({ RUKOO_ACCOUNT_SERVER: server.url, SEM_WHATS_NEW: '1' });
    await win.waitForSelector('.provider-grid');
    await win.click('[data-s="demo"]');
    await expect(guide().locator('h2')).toHaveText("What's new in Rukoo 2.0", { timeout: 15000 });
    await next();
    await guide().locator('.wn-cat', { hasText: 'Money' }).click();
    await next();
    await guide().locator('[data-choice="signin"]').click();
    await guide().locator('input[name="email"]').fill('bart@example.com');
    await guide().locator('input[name="password"]').fill('a long enough password');
    await next();
    await expect(guide().locator('h2')).toHaveText('Smarter sorting with Jev', { timeout: 15000 });
    await next();
    await expect(guide()).toContainText('4 categories');
    await next();
    await expect(guide()).toHaveCount(0);
    // The account's categories as they were: nothing it had was deleted.
    await expect(win.locator('.nav-item.nav-sub .label')).toHaveText(['Needs you', 'To read', 'Bills', 'Updates']);
  } finally {
    await server.close();
  }
});

test("with Gmail's shortcuts, E archives and the menus say so", async () => {
  await launch();
  await win.waitForSelector('.provider-grid');
  await win.click('[data-s="demo"]');
  await expect(win.locator('.item').first()).toBeVisible({ timeout: 15000 });
  const page = win.locator('.page.settings');
  await win.click('[data-action="settings"]');
  await page.locator('[data-a="keyboard"]').click();
  await page.locator('[data-a="keymap:gmail"]').click();
  await expect(page.locator('[data-a="keymap:gmail"] .radio')).toHaveClass(/on/);
  while (await page.count()) await page.locator('[data-a="back"]').click();
  const first = win.locator('.list-scroll .item').first();
  const subject = (await first.locator('.subject').textContent()).trim();
  await first.click();
  await first.click({ button: 'right' });
  await expect(win.locator('.menu button', { hasText: 'Archive' }).locator('kbd')).toHaveText('E');
  await expect(win.locator('.menu button', { hasText: 'Reply all' }).locator('kbd')).toHaveText('A');
  await win.keyboard.press('Escape');
  await win.locator('.list-scroll').focus();
  await win.keyboard.press('e');
  await expect(win.locator('.list-scroll .item .subject', { hasText: subject })).toHaveCount(0);

  await win.click('[data-action="settings"]');
  await page.locator('[data-a="keyboard"]').click();
  await page.locator('[data-a="keymap:outlook"]').click();
  await expect(page.locator('.row', { hasText: 'Archive' }).last().locator('kbd')).toHaveText('Backspace');
});

test('a newer release on GitHub shows a button above the sync status that opens its page', async () => {
  await launch({ RUKOO_RELEASES_URL: `http://127.0.0.1:${github.address().port}/releases` });
  await win.waitForSelector('.provider-grid');
  await win.click('[data-s="demo"]');
  await expect(win.locator('.item').first()).toBeVisible({ timeout: 15000 });
  await app.evaluate(({ shell }) => {
    global.__opened = [];
    shell.openExternal = async (url) => global.__opened.push(url);
  });
  await app.evaluate(() => global.__semUpdates.check({ force: true }));
  const button = win.locator('.update-btn');
  await expect(button).toHaveText('Update to 9.1.0');
  await button.click();
  await expect.poll(() => app.evaluate(() => global.__opened)).toEqual(['https://github.com/MajesteitBart/rukoo/releases/tag/v9.1.0']);

  // Switched off in Settings, Rukoo stops asking; Check now still asks.
  await win.click('[data-action="settings"]');
  const page = win.locator('.page.settings');
  await page.locator('[data-a="toggle:checkUpdates"]').click();
  await expect(page.locator('[data-a="toggle:checkUpdates"] .switch')).not.toHaveClass(/on/);
  await page.locator('[data-a="updates-check"]').click();
  await expect(page.locator('[data-a="updates-check"] .value')).toHaveText('Rukoo 9.1.0 is available');
});

test("after the guide, the sidebar and a panel show what Jev is doing, and when it has to wait", async () => {
  await launch({ SEM_WHATS_NEW: '1' });
  await win.waitForSelector('.provider-grid');
  await win.click('[data-s="demo"]');
  await expect(guide().locator('h2')).toHaveText("What's new in Rukoo 2.0", { timeout: 15000 });
  // Jev, answering each email after a moment; Money unless told it's busy.
  await app.evaluate(() => {
    global.__busy = false;
    global.__semCategories.jev = {
      MODEL: 'jev-test',
      classify: (key, m, list) =>
        new Promise((resolve, reject) =>
          setTimeout(() => (global.__busy ? reject(Object.assign(new Error('busy'), { code: 'busy' })) : resolve({ category: 'money', confidence: 0.83, model: 'jev-test' })), 700)
        )
    };
  });
  await next();
  await next();
  await guide().locator('[data-choice="local"]').click();
  await next();
  await guide().locator('[data-jev="use"]').click();
  await guide().locator('input[name="jevKey"]').fill('ts_test_key');
  await next();
  await next();
  await expect(guide()).toHaveCount(0);

  // The panel opens by itself and counts along; the line above the sync status does too.
  const panel = win.locator('.sort-panel');
  await expect(panel.locator('h3')).toHaveText('Jev is sorting your inbox');
  await expect(panel.locator('.sa-count')).toContainText(/\d+ of 16 sorted/);
  await expect(win.locator('.sort-status.sorting .t')).toHaveText('Jev is sorting');
  const first = panel.locator('.sa-item').first();
  await expect(first.locator('.sa-cat')).toHaveText('Money');
  await expect(first.locator('.sa-meta')).toContainText('83% sure');
  await expect(panel.locator('h3')).toHaveText('Your inbox is sorted', { timeout: 20000 });
  await expect(win.locator('.sort-status.done .t')).toHaveText(/^Sorted \d+ emails$/);

  // Keys in the panel stay there: Delete on a decision leaves the open email alone.
  const open = (await win.locator('.reader-subject').textContent()).trim();
  const count = await win.locator('.list-scroll .item').count();
  await panel.locator('.sa-item').first().focus();
  await win.keyboard.press('Delete');
  await win.waitForTimeout(500);
  await expect(win.locator('.list-scroll .item')).toHaveCount(count);
  await expect(win.locator('.reader-subject')).toHaveText(open);

  // An email in the list opens in Money.
  const subject = (await panel.locator('.sa-item .sa-subject').last().textContent()).trim();
  await panel.locator('.sa-item').last().click();
  await expect(panel).toHaveCount(0);
  await expect(win.locator('.list-title h1')).toHaveText('Money');
  await expect(win.locator('.reader-subject')).toHaveText(subject);

  // TypeSafe busy: the line says until when, and the panel why.
  await app.evaluate(() => {
    global.__busy = true;
  });
  await win.evaluate(() => {
    window.mail.call('categoriesSortAgain');
  });
  await expect(win.locator('.sort-status.waiting .t')).toHaveText(/^Jev waits until \d{1,2}:\d{2}/, { timeout: 10000 });
  await win.click('[data-action="sort-activity"]');
  await expect(panel.locator('h3')).toHaveText('Jev is waiting');
  await expect(panel).toContainText('TypeSafe is busy.');
  await win.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
});
