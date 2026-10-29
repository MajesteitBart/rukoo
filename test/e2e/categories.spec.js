// Inbox categories: turned on in Settings, the categories under Inbox in the sidebar, moving an email and its sender, and editing,
// reordering and renaming categories, and their notifications. The real app with a throwaway profile, the demo account
// and no Rukoo account.
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { tempDir, removeDir } = require('../tmp');
const { closeApp } = require('./close');

let app;
let win;
let dataDir;

async function launch() {
  // No account server: categories work without one, on this computer.
  const env = { ...process.env, SEM_DATA_DIR: dataDir, SEM_HIDDEN: '1', RUKOO_ACCOUNT_SERVER: 'http://127.0.0.1:9' };
  delete env.ELECTRON_RUN_AS_NODE;
  // The TypeSafe key is stored with safeStorage, which needs the real keyring on Linux (see the IMAP tests).
  const entry = process.platform === 'linux' ? path.join(__dirname, '..', 'fixtures', 'linux-keyring-app.js') : '.';
  app = await electron.launch({ args: [entry], cwd: path.join(__dirname, '..', '..'), env });
  win = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1500, 950));
}

test.beforeEach(async () => {
  dataDir = tempDir('rukoo-categories-e2e-');
  await launch();
  await win.waitForSelector('.provider-grid');
  await win.click('[data-s="demo"]');
  await expect(win.locator('.item').first()).toBeVisible({ timeout: 15000 });
});

test.afterEach(async () => {
  await closeApp(app);
  removeDir(dataDir);
});

const settings = () => win.locator('.page.settings');
// The categories under Inbox in the sidebar, and Inbox itself for all of it.
const tabs = () => win.locator('.nav-item.nav-sub .label');
const inboxRow = () => win.locator('.nav-item[data-view="inbox"]:not(.nav-sub)');

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

test('turning categories on puts them under Inbox, and each shows its mail', async () => {
  await expect(win.locator('.nav-item.nav-sub')).toHaveCount(0);
  await turnOn();
  await expect(settings().locator('.settings-text').first()).toContainText('These stay on this computer');
  await closeSettings();

  await expect(tabs()).toHaveText(['Needs you', 'To read', 'Money', 'Updates', 'Promotions']);
  await win.locator('.nav-item.nav-sub', { hasText: 'Promotions' }).click();
  await expect(win.locator('.nav-item.nav-sub.active')).toContainText('Promotions');
  await expect(win.locator('.list-title h1')).toHaveText('Promotions');
  const promotions = win.locator('.list-scroll .item');
  await expect(promotions.filter({ hasText: 'ANWB Newsletter' })).toHaveCount(1);
  await expect(promotions.filter({ hasText: 'Forward Future' })).toHaveCount(1);
  await expect(promotions.filter({ hasText: 'Sanne de Vries' })).toHaveCount(0);

  // A selection stays with its category: switching clears it, so no action reaches emails out of sight.
  await win.locator('.list-scroll .item', { hasText: 'Forward Future' }).click({ modifiers: ['Control'] });
  await expect(win.locator('.list-tools.selecting')).toBeVisible();
  await win.locator('.nav-item.nav-sub', { hasText: 'To read' }).click();
  await expect(win.locator('.list-tools.selecting')).toHaveCount(0);
  await expect(win.locator('.list-scroll .empty')).toContainText('Nothing in To read');
  await inboxRow().click();
  await expect(win.locator('.list-scroll .item').filter({ hasText: 'Sanne de Vries' })).toHaveCount(1);

  // A category picked during a search ends the search and shows that category's mail.
  await win.fill('#search', 'contract');
  await expect(win.locator('.list-scroll .item').filter({ hasText: 'ANWB Newsletter' })).toHaveCount(0);
  await win.locator('.nav-item.nav-sub', { hasText: 'Promotions' }).click();
  await expect(win.locator('#search')).toHaveValue('');
  await expect(win.locator('.list-title h1')).toHaveText('Promotions');
  await expect(win.locator('.list-scroll .item').filter({ hasText: 'ANWB Newsletter' })).toHaveCount(1);
  await expect(win.locator('.list-scroll .item').filter({ hasText: 'Sanne de Vries' })).toHaveCount(0);

  // Nothing moved on the server: the demo inbox holds the same messages.
  const inbox = await win.evaluate(() => window.mail.call('list', { scope: 'all', view: 'inbox' }).then((l) => l.length));
  expect(inbox).toBeGreaterThan(10);
});

test('an email moves to another category, and its sender follows on request', async () => {
  await turnOn();
  await closeSettings();
  await win.locator('.nav-item.nav-sub', { hasText: 'Promotions' }).click();
  await win.locator('.list-scroll .item', { hasText: 'ANWB Newsletter' }).click({ button: 'right' });
  await win.locator('.menu button', { hasText: 'Move to category' }).click();
  await win.locator('.scrim .radio-row', { hasText: 'To read' }).click();
  await expect(win.locator('#toast')).toContainText('Moved to To read');
  await expect(win.locator('.list-scroll .item', { hasText: 'ANWB Newsletter' })).toHaveCount(0);
  await win.locator('#toast button', { hasText: 'Also future mail' }).click();
  await expect(win.locator('#toast')).toContainText('Mail from ANWB Newsletter goes to To read from now on');

  await win.locator('.nav-item.nav-sub', { hasText: 'To read' }).click();
  await expect(win.locator('.list-scroll .item', { hasText: 'ANWB Newsletter' })).toHaveCount(1);

  // Several selected and moved away: the selection doesn't keep them out of sight.
  await win.locator('.nav-item.nav-sub', { hasText: 'Promotions' }).click();
  await win.locator('.list-scroll .item', { hasText: 'Forward Future' }).click({ modifiers: ['Control'] });
  await win.locator('[data-bulk="more"]').click();
  await win.locator('.menu button', { hasText: 'Move to category' }).click();
  await win.locator('.scrim .radio-row', { hasText: 'Updates' }).click();
  await expect(win.locator('.list-scroll .item', { hasText: 'Forward Future' })).toHaveCount(0);
  await expect(win.locator('.list-tools.selecting')).toHaveCount(0);
  await win.locator('.nav-item.nav-sub', { hasText: 'To read' }).click();

  await win.click('[data-action="settings"]');
  await settings().locator('[data-a="categories"]').click();
  const rule = settings().locator('.row', { hasText: 'newsletter@anwb.nl' });
  await expect(rule).toContainText('Goes to To read');
  await rule.click();
  await win.locator('.scrim .buttons button', { hasText: 'Delete' }).click();
  await expect(settings().locator('.row', { hasText: 'newsletter@anwb.nl' })).toHaveCount(0);
});

test('moving a selection to another category clears it from the reader too', async () => {
  await turnOn();
  await closeSettings();
  await win.locator('.nav-item.nav-sub', { hasText: 'Promotions' }).click();
  await win.locator('.list-scroll .item', { hasText: 'ANWB Newsletter' }).click({ modifiers: ['Control'] });
  await win.locator('.list-scroll .item', { hasText: 'Forward Future' }).click({ modifiers: ['Control'] });
  await expect(win.locator('.reader .multi')).toBeVisible();
  await win.locator('[data-bulk="more"]').click();
  await win.locator('.menu button', { hasText: 'Move to category' }).click();
  await win.locator('.scrim .radio-row', { hasText: 'Updates' }).click();
  await expect(win.locator('.list-scroll .empty')).toContainText('Nothing in Promotions');
  await expect(win.locator('.list-tools.selecting')).toHaveCount(0);
  await expect(win.locator('.reader .multi')).toHaveCount(0);
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
  await expect(tabs()).toHaveText(['Needs you', 'To read', 'Finance', 'Promotions', 'Updates', 'Kids']);

  await win.reload();
  await expect(win.locator('.item').first()).toBeVisible({ timeout: 15000 });
  await expect(tabs()).toHaveText(['Needs you', 'To read', 'Finance', 'Promotions', 'Updates', 'Kids']);
});

test("a category's notifications turn off on this computer and stay off after a restart", async () => {
  await turnOn();
  // The window after the restart is another one.
  const dialog = () => win.locator('.scrim .dialog');
  const notify = () => dialog().locator('.cat-notify');
  await settings().locator('[data-a="cat-edit:promotions"]').click();
  await expect(notify()).toHaveAttribute('aria-checked', 'true');
  await expect(dialog()).toContainText('This choice stays on this computer.');
  await notify().click();
  await expect(notify()).toHaveAttribute('aria-checked', 'false');
  await dialog().locator('.buttons button', { hasText: 'Save' }).click();
  await expect(settings().locator('[data-a="cat-edit:promotions"] .cat-muted')).toHaveAttribute('aria-label', 'Notifications off');
  await expect(settings().locator('.cat-muted')).toHaveCount(1);

  // A new category can start with them off.
  await settings().locator('[data-a="cat-add"]').click();
  await dialog().locator('[name="name"]').fill('Kids');
  await notify().click();
  await dialog().locator('.buttons button', { hasText: 'Add' }).click();
  await expect(settings().locator('.cat-row').last()).toContainText('Kids');
  await expect(settings().locator('.cat-row').last().locator('.cat-muted')).toHaveCount(1);
  // Kept on this computer, beside the Jev key, not in the categories' synced records.
  const local = () => JSON.parse(fs.readFileSync(path.join(dataDir, 'data', 'categories.json'), 'utf8')).muted;
  expect(local()).toHaveLength(2);
  expect(local()).toContain('promotions');

  await closeApp(app);
  await launch();
  await expect(win.locator('.item').first()).toBeVisible({ timeout: 15000 });
  await win.click('[data-action="settings"]');
  await settings().locator('[data-a="categories"]').click();
  await expect(settings().locator('.cat-muted')).toHaveCount(2);
  await settings().locator('[data-a="cat-edit:promotions"]').click();
  await expect(notify()).toHaveAttribute('aria-checked', 'false');
  await notify().click();
  await dialog().locator('.buttons button', { hasText: 'Save' }).click();
  await expect(settings().locator('[data-a="cat-edit:promotions"] .cat-muted')).toHaveCount(0);
  expect(local()).toHaveLength(1);

  // "Use Rukoo's text" keeps a change to the switch.
  await settings().locator('[data-a="cat-edit:promotions"]').click();
  await dialog().locator('[name="name"]').fill('Offers');
  await dialog().locator('.buttons button', { hasText: 'Save' }).click();
  await expect(settings().locator('[data-a="cat-edit:promotions"]')).toContainText('Offers');
  await settings().locator('[data-a="cat-edit:promotions"]').click();
  await notify().click();
  await dialog().locator('.buttons button', { hasText: "Use Rukoo's text" }).click();
  await expect(settings().locator('[data-a="cat-edit:promotions"] .title')).toHaveText('Promotions');
  await expect(settings().locator('[data-a="cat-edit:promotions"] .cat-muted')).toHaveCount(1);
});

test('with notifications off for all mail, the category switch stays as it is and says why', async () => {
  await turnOn();
  const dialog = () => win.locator('.scrim .dialog');
  const notify = () => dialog().locator('.cat-notify');
  await win.evaluate(() => window.mail.call('updateSettings', { notifications: false }));
  await settings().locator('[data-a="cat-edit:promotions"]').click();
  await expect(notify()).toBeDisabled();
  await expect(notify()).toHaveAttribute('aria-checked', 'true');
  await expect(dialog().locator('#cat-notify-help')).toHaveText('Notifications are off for all new mail, so this category stays quiet too. Turn on Notifications in Settings first.');
  await notify().click({ force: true });
  await expect(notify()).toHaveAttribute('aria-checked', 'true');
  await dialog().locator('.buttons button', { hasText: 'Cancel' }).click();

  // On again, the switch works as before.
  await win.evaluate(() => window.mail.call('updateSettings', { notifications: true }));
  await settings().locator('[data-a="cat-edit:promotions"]').click();
  await expect(notify()).toBeEnabled();
  await expect(dialog().locator('#cat-notify-help')).toContainText('This choice stays on this computer.');
});

test('new mail in a muted category sends no notification', async () => {
  await turnOn();
  await settings().locator('[data-a="cat-edit:updates"]').click();
  await win.locator('.scrim .dialog .cat-notify').click();
  await win.locator('.scrim .dialog .buttons button', { hasText: 'Save' }).click();
  await expect(settings().locator('[data-a="cat-edit:updates"] .cat-muted')).toHaveCount(1);
  await closeSettings();
  const shown = await app.evaluate(async ({ Notification, BrowserWindow }) => {
    // Notifications are recorded instead of shown, as for a window in the background.
    BrowserWindow.getAllWindows()[0].isFocused = () => false;
    global.__shown = [];
    Notification.prototype.show = function () {
      global.__shown.push(this);
    };
    const engine = global.__semEngine;
    const raw = (from, subject, n) =>
      [`From: ${from}`, 'To: demo@example.com', `Subject: ${subject}`, `Date: ${new Date().toUTCString()}`, `Message-ID: <${Date.now()}.${n}@example.com>`, '', 'Hello'].join('\r\n');
    // A sign-in alert, which the rules put in Updates without a doubt, and an email from a person.
    await engine.session(engine.accounts[0]).append('INBOX', raw('App <noreply@app.example>', 'New sign-in', 1));
    await engine.session(engine.accounts[0]).append('INBOX', raw('Sanne de Vries <sanne@example.com>', 'Lunch on Friday?', 2));
    await engine.syncAll();
    return global.__shown.map((n) => n.title);
  });
  expect(shown).toEqual(['Sanne de Vries']);
  await expect(win.locator('.item', { hasText: 'New sign-in' })).toHaveCount(1);
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
