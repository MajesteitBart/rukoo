// Signs in through the setup form with a disposable Ethereal IMAP/SMTP account (skips when offline).
const { test, expect, _electron: electron } = require('@playwright/test');
const nodemailer = require('nodemailer');
const fs = require('fs');
const os = require('os');
const path = require('path');

test('sign in with "Overige" and read real IMAP mail', async () => {
  test.setTimeout(120000);
  let eth;
  try {
    eth = await nodemailer.createTestAccount();
  } catch (_) {
    test.skip(true, 'Ethereal not reachable');
  }
  // Seed one message so the inbox has something to show.
  const transport = nodemailer.createTransport({ ...eth.smtp, auth: { user: eth.user, pass: eth.pass } });
  await transport.sendMail({ from: eth.user, to: eth.user, subject: 'Welkom in je echte inbox', text: 'Dit bericht kwam via SMTP binnen.' });
  transport.close();

  const env = { ...process.env, SEM_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'sem-e2e-imap-')), SEM_HIDDEN: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: ['.'], cwd: path.join(__dirname, '..', '..'), env });
  try {
    const win = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1500, 950));
    await win.click('[data-provider="other"]');
    await expect(win.locator('.login-head h2')).toHaveText('Aanmelden bij Overige');

    await win.fill('[name=email]', eth.user);
    await win.fill('[name=password]', 'verkeerd');
    await win.click('[data-s="manual"]');
    await win.fill('[name=imapHost]', eth.imap.host);
    await win.fill('[name=imapPort]', String(eth.imap.port));
    await win.fill('[name=smtpHost]', eth.smtp.host);
    await win.fill('[name=smtpPort]', String(eth.smtp.port));
    await win.locator('[name=smtpSecure]').setChecked(eth.smtp.secure);
    await win.click('button[type=submit]');
    await expect(win.locator('[data-error]')).toContainText('Aanmelden mislukt', { timeout: 30000 });

    await win.fill('[name=password]', eth.pass);
    await win.click('button[type=submit]');
    await expect(win.locator('.list-title .sub')).toContainText(eth.user, { timeout: 30000 });
    const row = win.locator('.item', { hasText: 'Welkom in je echte inbox' });
    await expect(row).toBeVisible({ timeout: 30000 });
    await row.click();
    await expect(win.frameLocator('.mail-frame').locator('body')).toContainText('via SMTP binnen', { timeout: 30000 });
    await expect(win.locator('.sync-status')).toContainText(/bijgewerkt/i);
  } finally {
    await app.close();
  }
});
