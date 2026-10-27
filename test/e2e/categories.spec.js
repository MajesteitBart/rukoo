// Inbox categories: turned on in Settings, the tabs above the inbox, moving an email and its sender, and editing,
// reordering and renaming categories. The real app with a throwaway profile, the demo account and no Rukoo account.
const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('path');
const { tempDir, removeDir } = require('../tmp');
const { closeApp } = require('./close');

let app;
let win;
let dataDir;

test.beforeEach(async () => {
  dataDir = tempDir('rukoo-categories-e2e-');
  // No account server: categories work without one, on this computer.
  const env = { ...process.env, SEM_DATA_DIR: dataDir, SEM_HIDDEN: '1', RUKOO_ACCOUNT_SERVER: 'http://127.0.0.1:9' };
  delete env.ELECTRON_RUN_AS_NODE;
  // The TypeSafe key is stored with safeStorage, which needs the real keyring on Linux (see the IMAP tests).
  const entry = process.platform === 'linux' ? path.join(__dirname, '..', 'fixtures', 'linux-keyring-app.js') : '.';
  app = await electron.launch({ args: [entry], cwd: path.join(__dirname, '..', '..'), env });
  win = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1500, 950));
  await win.waitForSelector('.provider-grid');
  await win.click('[data-s="demo"]');
  await expect(win.locator('.item').first()).toBeVisible({ timeout: 15000 });
});

test.afterEach(async () => {
  await closeApp(app);
  removeDir(dataDir);
});

const settings = () => win.locator('.page.settings');
const tabs = () => win.locator('.category-tabs .ctab .name');

async function turnOn() {
  await win.click('[data-action="settings"]');
  await expect(settings().locator('[data-a="categories"] .value')).toHaveText('Off');
  await settings().locator('[data-a="categories"]').click();
  await expect(settings().locator('h1')).toHaveText('Inbox categories');
  await settings().locator('[data-a="cat-toggle"]').click();
  await expect(settings().locator('.cat-row')).toHaveCount(5);
}

async function closeSettings() {
  while (await settings().count()) await settings().locator('[data-a="back"]').click();
}

test('turning categories on gives the inbox tabs, and each tab shows its mail', async () => {
  await expect(win.locator('.category-tabs')).toBeHidden();
  await turnOn();
  await expect(settings().locator('.settings-text').first()).toContainText('These stay on this computer');
  await closeSettings();

  await expect(tabs()).toHaveText(['All', 'Needs you', 'To read', 'Money', 'Updates', 'Promotions']);
  await win.locator('.ctab', { hasText: 'Promotions' }).click();
  await expect(win.locator('.ctab.active')).toContainText('Promotions');
  const promotions = win.locator('.list-scroll .item');
  await expect(promotions.filter({ hasText: 'ANWB Newsletter' })).toHaveCount(1);
  await expect(promotions.filter({ hasText: 'Forward Future' })).toHaveCount(1);
  await expect(promotions.filter({ hasText: 'Sanne de Vries' })).toHaveCount(0);

  await win.locator('.ctab', { hasText: 'To read' }).click();
  await expect(win.locator('.list-scroll .empty')).toContainText('Nothing in To read');
  await win.locator('.ctab', { hasText: 'All' }).click();
  await expect(win.locator('.list-scroll .item').filter({ hasText: 'Sanne de Vries' })).toHaveCount(1);

  // Nothing moved on the server: the demo inbox holds the same messages.
  const inbox = await win.evaluate(() => window.mail.call('list', { scope: 'all', view: 'inbox' }).then((l) => l.length));
  expect(inbox).toBeGreaterThan(10);
});

test('an email moves to another category, and its sender follows on request', async () => {
  await turnOn();
  await closeSettings();
  await win.locator('.ctab', { hasText: 'Promotions' }).click();
  await win.locator('.list-scroll .item', { hasText: 'ANWB Newsletter' }).click({ button: 'right' });
  await win.locator('.menu button', { hasText: 'Move to category' }).click();
  await win.locator('.scrim .radio-row', { hasText: 'To read' }).click();
  await expect(win.locator('#toast')).toContainText('Moved to To read');
  await expect(win.locator('.list-scroll .item', { hasText: 'ANWB Newsletter' })).toHaveCount(0);
  await win.locator('#toast button', { hasText: 'Also future mail' }).click();
  await expect(win.locator('#toast')).toContainText('Mail from ANWB Newsletter goes to To read from now on');

  await win.locator('.ctab', { hasText: 'To read' }).click();
  await expect(win.locator('.list-scroll .item', { hasText: 'ANWB Newsletter' })).toHaveCount(1);

  await win.click('[data-action="settings"]');
  await settings().locator('[data-a="categories"]').click();
  const rule = settings().locator('.row', { hasText: 'newsletter@anwb.nl' });
  await expect(rule).toContainText('Goes to To read');
  await rule.click();
  await win.locator('.scrim .buttons button', { hasText: 'Delete' }).click();
  await expect(settings().locator('.row', { hasText: 'newsletter@anwb.nl' })).toHaveCount(0);
});

test('categories can be renamed, added, moved up and kept after a restart', async () => {
  await turnOn();
  await settings().locator('[data-a="cat-edit:money"]').click();
  const dialog = win.locator('.scrim .dialog');
  await dialog.locator('[name="name"]').fill('Finance');
  await dialog.locator('.cat-swatch').nth(4).click();
  await dialog.locator('.buttons button', { hasText: 'Save' }).click();
  await expect(settings().locator('[data-a="cat-edit:money"]')).toContainText('Finance');

  await settings().locator('[data-a="cat-add"]').click();
  await dialog.locator('[name="name"]').fill('Kids');
  await dialog.locator('[name="description"]').fill('School, sports clubs and birthday parties');
  await dialog.locator('.buttons button', { hasText: 'Add' }).click();
  await expect(settings().locator('.cat-row')).toHaveCount(6);
  await expect(settings().locator('.cat-row').last()).toContainText('Kids');

  await settings().locator('[data-a="cat-up:promotions"]').click();
  await expect(settings().locator('.cat-row').nth(3)).toContainText('Promotions');

  await settings().locator('[data-a="cat-unsure"]').click();
  await win.locator('.scrim .radio-row', { hasText: 'Kids' }).click();
  await expect(settings().locator('[data-a="cat-unsure"] .value')).toHaveText('Kids');
  await closeSettings();
  await expect(tabs()).toHaveText(['All', 'Needs you', 'To read', 'Finance', 'Promotions', 'Updates', 'Kids']);

  await win.reload();
  await expect(win.locator('.item').first()).toBeVisible({ timeout: 15000 });
  await expect(tabs()).toHaveText(['All', 'Needs you', 'To read', 'Finance', 'Promotions', 'Updates', 'Kids']);
});

test('Jev needs a key and says what it shares', async () => {
  await turnOn();
  await settings().locator('[data-a="cat-jev"]').click();
  await expect(win.locator('#toast')).toContainText('Add your TypeSafe API key first.');
  const dialog = win.locator('.scrim .dialog');
  await expect(dialog).toContainText('TypeSafe, Inc. in the United States');
  await dialog.locator('input').fill('not-a-real-key');
  await dialog.locator('.buttons button', { hasText: 'Save' }).click();
  await expect(settings().locator('[data-a="cat-key"] .value')).toHaveText('Set on this computer');
  await expect(settings().locator('[data-a="cat-jev"] .switch')).toHaveClass(/on/);

  // The account's privacy page names TypeSafe while Jev is on.
  await settings().locator('[data-a="back"]').click();
  await settings().locator('[data-a="rukoo"]').click();
  await settings().locator('[data-a="rukoo-go:rukoo-privacy"]').click();
  await expect(settings().locator('.row', { hasText: 'TypeSafe, Inc.' })).toContainText('Sorts your inbox with Jev');
});
