const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');

let app;
let win;
let profile;

test.beforeEach(async () => {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'rukoo-i18n-e2e-'));
  const env = { ...process.env, SEM_DATA_DIR: profile, SEM_HIDDEN: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: ['.'], cwd: path.join(__dirname, '..', '..'), env });
  win = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1500, 950));
  await expect(win.locator('.provider-grid')).toBeVisible();
});

test.afterEach(async () => {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((window) => window.destroy())).catch(() => {});
  await app.close();
  fs.rmSync(profile, { recursive: true, force: true });
});

async function demo() {
  await win.click('[data-s="demo"]');
  await expect(win.locator('.list-title h1')).toHaveText('Inbox');
}

async function language(name) {
  await win.click('[data-action="settings"]');
  await win.click('[data-a="language"]');
  await win.getByRole('radio', { name, exact: true }).click();
  await expect(win.locator('.page.settings h1')).toHaveText(name === 'Nederlands' ? 'E-mailinstellingen' : 'Email settings');
  await win.click('.page.settings [data-a="back"]');
}

test('first run defaults to English and lets users choose Dutch before adding an account', async () => {
  await expect(win.locator('.setup h1')).toHaveText('Set up email');
  await expect(win.locator('html')).toHaveAttribute('lang', 'en');
  await win.locator('[data-s="language"]').selectOption('nl');
  await expect(win.locator('.setup h1')).toHaveText('E-mail instellen');
  await expect(win.locator('[data-provider="other"]')).toHaveText('Overige');
  await win.reload();
  await expect(win.locator('.setup h1')).toHaveText('E-mail instellen');
  await expect(win.locator('html')).toHaveAttribute('lang', 'nl');
  await win.locator('[data-s="language"]').selectOption('en');
  await expect(win.locator('.setup h1')).toHaveText('Set up email');
  await win.click('[data-provider="other"]');
  await expect(win.locator('.login-head h2')).toHaveText('Sign in to Other');
  await expect(win.locator('[name=email]')).toHaveAttribute('placeholder', 'name@example.com');
  await expect(win.locator('[name=password]')).toHaveAttribute('placeholder', 'Password or app password');
});

test('mailbox, reader, menus, folder visibility, and persisted settings switch languages', async () => {
  await demo();
  await expect(win.locator('.group-head').first()).toContainText('Today');
  await expect(win.locator('.to-summary')).toHaveText('to me');
  const subject = await win.locator('.reader-subject').textContent();
  await language('Nederlands');
  await expect(win.locator('.list-title h1')).toHaveText('Postvak IN');
  await expect(win.locator('.to-summary')).toHaveText('aan mij');
  await expect(win.locator('.reader-subject')).toHaveText(subject);
  await win.click('[data-action="settings"]');
  await win.click('[data-a="folders"]');
  await expect(win.locator('.page.settings')).toContainText('Opgeslagen e-mails');
  await win.click('.page.settings [data-a="back"]');
  await win.click('.page.settings [data-a="back"]');
  await win.reload();
  await expect(win.locator('.list-title h1')).toHaveText('Postvak IN');
  await language('English');
  await expect(win.locator('.list-title h1')).toHaveText('Inbox');
  await expect(win.locator('.sidebar')).toHaveAttribute('aria-label', 'Folders');
  await win.click('[data-action="settings"]');
  await win.click('[data-a="folders"]');
  await expect(win.locator('.page.settings')).toContainText('Saved emails');
});

test('language changes preserve an inline draft and update a separate compose window', async () => {
  await demo();
  await win.click('[data-action="compose"]');
  await win.locator('[data-rinput="to"]').fill('friend@example.com');
  await win.locator('[data-rinput="to"]').press('Enter');
  await win.locator('#subject').fill('My unchanged subject');
  await win.locator('.editor').fill('My unchanged message');
  const attachment = path.join(profile, 'example.txt');
  fs.writeFileSync(attachment, 'An attachment');
  await app.evaluate(({ dialog }, filename) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filename] });
  }, attachment);
  await win.click('[data-c="attach"]');
  await expect(win.locator('.att-chip')).toContainText('example.txt');
  await language('Nederlands');
  await expect(win.locator('.send-btn span')).toHaveText('Verzenden');
  await expect(win.locator('.editor')).toHaveText('My unchanged message');
  await expect(win.locator('#subject')).toHaveValue('My unchanged subject');
  await expect(win.locator('[data-rfield="to"] .recipient')).toContainText('friend@example.com');
  await expect(win.locator('.att-chip')).toContainText('example.txt');
  const opened = app.waitForEvent('window');
  await win.click('[data-c="popout"]');
  const compose = await opened;
  await expect(compose.locator('.editor')).toHaveText('My unchanged message');
  await expect(compose.locator('.send-btn span')).toHaveText('Verzenden');
  await language('English');
  await expect(compose.locator('.send-btn span')).toHaveText('Send');
  await expect(compose.locator('html')).toHaveAttribute('lang', 'en');
  await expect(compose.locator('.editor')).toHaveAttribute('aria-label', 'Message body');
  await expect(compose.locator('.editor')).toHaveText('My unchanged message');
  await expect(compose.locator('#subject')).toHaveValue('My unchanged subject');
  await expect(compose.locator('[data-rfield="to"] .recipient')).toContainText('friend@example.com');
  await expect(compose.locator('.att-chip')).toContainText('example.txt');
});

for (const separate of [false, true]) {
  test(`recipient input labels switch languages without losing an unfinished address in the ${separate ? 'separate' : 'inline'} composer`, async () => {
    await demo();
    await win.click('[data-action="compose"]');
    let compose = win;
    if (separate) {
      const opened = app.waitForEvent('window');
      await win.click('[data-c="popout"]');
      compose = await opened;
    }
    await compose.click('[data-c="cc"]');
    await compose.click('[data-c="bcc"]');
    const recipient = compose.locator('[data-rinput="to"]');
    await recipient.fill('unfinished@');
    const originalInput = await recipient.elementHandle();
    for (const [code, toLabel] of [['en', 'To'], ['nl', 'Aan'], ['en', 'To']]) {
      // Apply the same settings API without blurring and committing the unfinished recipient.
      await win.evaluate((language) => window.mail.call('updateSettings', { language }), code);
      await expect(compose.locator('html')).toHaveAttribute('lang', code);
      for (const [field, label] of [['to', toLabel], ['cc', 'Cc'], ['bcc', 'Bcc']]) {
        await expect(compose.locator(`[data-rinput="${field}"]`)).toHaveAttribute('aria-label', label);
      }
      await expect(recipient).toHaveValue('unfinished@');
      expect(await originalInput.evaluate((element) => element.isConnected)).toBe(true);
      await expect(recipient).toBeFocused();
    }
  });
}

test('English reply quotes stay behind the quote pill after reopening in Dutch', async () => {
  await demo();
  await win.locator('.item', { hasText: 'Sanne de Vries' }).first().click();
  await win.click('[data-reader="reply"]');
  await win.click('[data-c="quote"]');
  await expect(win.locator('.quote-head')).toContainText('Original message');
  await expect(win.locator('.quote-head')).toContainText('From: Sanne de Vries');
  await win.locator('.editor').fill('A reply to keep');
  await win.locator('.editor').press('Control+s');
  await expect(win.locator('.save-state')).toHaveText('Draft saved');
  await win.click('[data-c="close"]');
  await expect(win.locator('.composer')).toHaveCount(0);
  await language('Nederlands');
  await win.click('[data-view="drafts"]');
  await win.locator('.item', { hasText: 'Re: Call on Thursday' }).dblclick();
  await expect(win.locator('.editor')).toHaveText('A reply to keep');
  await expect(win.locator('.quote-pill')).toBeVisible();
  await expect(win.locator('.quote-head')).toContainText('Original message');
});
