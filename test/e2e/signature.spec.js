// HTML signatures: written and pasted in Settings, and carried into the inline editor, the compose window,
// drafts and sent mail. The real app with a throwaway profile and the demo account, in English.
const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('path');
const { tempDir, removeDir } = require('../tmp');

let app;
let win;
let dataDir;

// A 1x1 PNG.
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const SIGNATURE =
  `<table cellpadding="0"><tr><td style="padding-right:10px"><img src="${PNG}" alt="Logo" width="32" height="32"></td>` +
  '<td><b style="color:#1c2340">Demo Sender</b><br><span style="color:#6b7280">Customer success</span><br>' +
  '<a href="https://example.com/team">example.com/team</a></td></tr></table>';

test.beforeEach(async () => {
  dataDir = tempDir('rukoo-sig-e2e-');
  const env = { ...process.env, SEM_DATA_DIR: dataDir, SEM_HIDDEN: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: ['.'], cwd: path.join(__dirname, '..', '..'), env });
  win = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1500, 950));
  await win.waitForSelector('.provider-grid');
  await win.click('[data-s="demo"]');
  await expect(win.locator('.item').first()).toBeVisible({ timeout: 15000 });
});

test.afterEach(async () => {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.destroy())).catch(() => {});
  await app.close().catch(() => {});
  removeDir(dataDir);
});

const item = (text) => win.locator('.item', { hasText: text }).first();
const settings = () => win.evaluate(() => window.mail.call('state').then((s) => s.settings));
const account = () => win.evaluate(() => window.mail.call('state').then((s) => s.accounts[0]));
// Stored through main, then the window is reloaded so the editor starts from the stored settings.
async function setSettings(patch) {
  await win.evaluate((p) => window.mail.call('updateSettings', p), patch);
  await win.reload();
  await expect(win.locator('.item').first()).toBeVisible({ timeout: 15000 });
}
const setSignature = (html) => setSettings({ signatureHtml: html });

// Pastes HTML into the focused editor the way the clipboard does.
const paste = (selector, html) =>
  win.locator(selector).evaluate((el, value) => {
    const data = new DataTransfer();
    data.setData('text/html', value);
    data.setData('text/plain', 'plain');
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, html);

async function expectSignature(editor) {
  const sig = editor.locator('.signature');
  await expect(sig.locator('b')).toHaveText('Demo Sender');
  await expect(sig.locator('b')).toHaveCSS('color', 'rgb(28, 35, 64)');
  await expect(sig.locator('a[href="https://example.com/team"]')).toHaveText('example.com/team');
  await expect(sig.locator('img[alt="Logo"]')).toHaveAttribute('src', /^data:image\/png;base64,/);
  expect(await sig.locator('img').evaluate((img) => img.complete && img.naturalWidth)).toBe(1);
}

test('a pasted signature is cleaned, previewed and saved; its HTML can be edited', async () => {
  await win.click('[data-action="settings"]');
  await expect(win.locator('[data-a="signature"] .value')).toHaveText('None');
  await win.click('[data-a="signature"]');
  const editor = win.locator('.sig-editor');
  await expect(editor).toBeFocused();
  await paste('.sig-editor', `<meta charset="utf-8"><style>p{display:none}</style><p class="MsoNormal" onclick="alert(1)"><b>Pasted</b> <a href="javascript:alert(1)">bad</a> <a href="https://example.com/a">good</a></p><script>window.__pwned = 1</script><img src="https://example.com/x.png" onerror="window.__pwned = 1"><iframe src="https://example.com"></iframe>`);
  await expect(editor.locator('b')).toHaveText('Pasted');
  await expect(editor.locator('a')).toHaveCount(1);
  await expect(editor.locator('a')).toHaveAttribute('href', 'https://example.com/a');
  await expect(editor.locator('script, iframe, style, [onclick], [onerror], .MsoNormal')).toHaveCount(0);
  await expect(editor).toContainText('bad');

  // The HTML source: what is typed there is cleaned when switching back.
  await win.click('.sig-toolbar [data-c="source"]');
  await expect(win.locator('.sig-source')).toBeVisible();
  await expect(win.locator('.sig-source')).toHaveValue(/<b>Pasted<\/b>/);
  await expect(win.locator('.sig-toolbar [data-cmd="bold"]')).toBeDisabled();
  await win.locator('.sig-source').fill(`${SIGNATURE}<script>window.__pwned = 1</script><a href="javascript:x()">js</a>`);
  await win.click('.sig-toolbar [data-c="source"]');
  await expect(win.locator('.sig-source')).toBeHidden();
  await expect(editor.locator('script')).toHaveCount(0);
  await expect(editor.locator('a')).toHaveCount(1);
  await expect(editor.locator('table img[alt="Logo"]')).toBeVisible();

  await win.click('.scrim .buttons button:text-is("Save")');
  await expect(win.locator('.scrim')).toHaveCount(0);
  const preview = win.locator('[data-a="signature"] .sig-preview');
  await expect(preview.locator('b')).toHaveText('Demo Sender');
  await expect(preview.locator('img')).toHaveCount(1);
  await expect(preview).toHaveAttribute('inert', '');
  const s = await settings();
  expect(s.signatureHtml).toContain('<b style="color:#1c2340">Demo Sender</b>');
  expect(s.signatureHtml).not.toMatch(/script|javascript/);
  // The text for the plain-text part and earlier versions; the unsafe link kept its text.
  expect(s.signature).toMatch(/^Demo Sender\nCustomer success\nexample\.com\/team\s+js$/);
  expect(await win.evaluate(() => window.__pwned)).toBeUndefined();

  // Formatting from the toolbar.
  await win.click('[data-a="signature"]');
  await win.locator('.sig-editor b').selectText();
  await win.click('.sig-toolbar [data-cmd="italic"]');
  await win.click('.scrim .buttons button:text-is("Save")');
  await expect(win.locator('[data-a="signature"] .sig-preview i, [data-a="signature"] .sig-preview [style*="italic"]')).toHaveCount(1);
});

test('an account signature can be formatted, and set back to the general one', async () => {
  await setSignature('<i>General one</i>');
  await win.click('[data-action="settings"]');
  await win.click('.row:has-text("demo@example.com")');
  const row = win.locator('[data-a="acc-signature"]');
  await expect(row.locator('.value')).toHaveText('Uses the general signature');
  await expect(row.locator('.sig-preview i')).toHaveText('General one');
  await row.click();
  await expect(win.locator('.sig-editor i')).toHaveText('General one');
  await win.click('.sig-toolbar [data-c="source"]');
  await win.locator('.sig-source').fill('<p><u>Only for demo</u> <a href="mailto:team@example.com">mail us</a></p>');
  await win.click('.scrim .buttons button:text-is("Save")');
  await expect(row.locator('.sig-preview u')).toHaveText('Only for demo');
  await expect(row.locator('.value')).toHaveCount(0);
  expect((await account()).signatureHtml).toBe('<p><u>Only for demo</u> <a href="mailto:team@example.com">mail us</a></p>');

  await row.click();
  await win.click('.scrim .buttons button:text-is("Use general signature")');
  await expect(row.locator('.value')).toHaveText('Uses the general signature');
  const acc = await account();
  expect(acc.signature).toBeNull();
  expect(acc.signatureHtml).toBeNull();
});

test('a plain-text signature still shows as before', async () => {
  await setSettings({ signature: 'Regards,\n<Demo>' });
  await win.click('[data-action="compose"]');
  const sig = win.locator('.composer .editor .signature');
  await expect(sig).toHaveText('Regards,<Demo>');
  expect(await sig.innerHTML()).toBe('Regards,<br>&lt;Demo&gt;');
});

test('the signature is formatted in new mail, replies, forwards and the compose window', async () => {
  await setSignature(SIGNATURE);
  const editor = win.locator('.composer .editor');
  await win.click('[data-action="compose"]');
  await expectSignature(editor);
  await win.keyboard.press('Escape');
  await expect(win.locator('.composer')).toHaveCount(0);

  await item('Sanne de Vries').click();
  await win.click('[data-reader="reply"]');
  await expectSignature(editor);
  await win.keyboard.press('Escape');
  await win.click('[data-reader="forward"]');
  await expectSignature(editor);

  const [popped] = await Promise.all([app.waitForEvent('window'), win.click('[data-c="popout"]')]);
  await popped.waitForSelector('.compose .editor');
  await expectSignature(popped.locator('.compose .editor'));
});

test('a draft keeps the signature, and sent mail carries it with its image and text', async () => {
  await setSignature(SIGNATURE);
  await win.click('[data-action="compose"]');
  const editor = win.locator('.composer .editor');
  await win.fill('[data-rinput="to"]', 'demo@example.com');
  await win.keyboard.press('Enter');
  await win.fill('[data-field="subject"]', 'Signed mail');
  await editor.click({ position: { x: 4, y: 4 } });
  await win.keyboard.type('Hello there.');
  await win.keyboard.press('Control+s');
  await expect(win.locator('.composer .save-state')).toHaveText('Draft saved');
  await win.keyboard.press('Escape');
  await expect(win.locator('.composer')).toHaveCount(0);

  await win.click('[data-view="drafts"]');
  await item('Signed mail').click();
  await win.click('[data-reader="edit"]');
  await expectSignature(editor);
  await expect(editor).toContainText('Hello there.');
  // The image went into the draft as an inline part, not as an attachment.
  await expect(win.locator('.composer .compose-attachments .att-chip')).toHaveCount(0);

  // Keeps what the account sends, as it goes on the wire. (The demo mailbox stores mail parsed, with images as data.)
  await app.evaluate(() => {
    const engine = global.__semEngine;
    const session = engine.session(engine.accounts[0]);
    const send = session.send.bind(session);
    session.send = async (mail) => {
      const raw = await send(mail);
      global.__sentRaw = raw.toString('utf8');
      return raw;
    };
  });
  await win.click('[data-c="send"]');
  await expect(win.locator('.composer')).toHaveCount(0, { timeout: 10000 });
  await win.click('[data-view="inbox"]');
  await expect(item('Signed mail')).toBeVisible({ timeout: 10000 });
  await item('Signed mail').click();
  const frame = win.frameLocator('.mail-frame');
  await expect(frame.locator('body')).toContainText('Hello there.');
  await expect(frame.locator('b')).toHaveText('Demo Sender');
  await expect(frame.locator('a[href="https://example.com/team"]')).toBeVisible();
  expect(await frame.locator('img[alt="Logo"]').evaluate((img) => img.naturalWidth)).toBe(1);

  // On the wire: the image is a Content-ID part, the plain-text part has the signature as text.
  const raw = await app.evaluate(() => global.__sentRaw);
  expect(raw).toMatch(/Content-Type: multipart\/related/);
  expect(raw).toMatch(/Content-ID: <[0-9a-f]+@rukoo>/);
  expect(raw).toMatch(/Content-Disposition: inline/);
  expect(raw).toMatch(/src=3D"cid:[0-9a-f]+@rukoo"/);
  expect(raw).not.toContain('data:image');
  expect(raw).toMatch(/Demo Sender\r?\nCustomer success\r?\nexample\.com\/team/);
});

test('the signature editor is in Dutch with the rest of the app', async () => {
  await setSettings({ language: 'nl' });
  await win.click('[data-action="settings"]');
  await win.click('.row:has-text("demo@example.com")');
  await expect(win.locator('[data-a="acc-signature"] .value')).toHaveText('Algemeen: geen');
  await win.click('[data-a="acc-signature"]');
  await expect(win.locator('.sig-help')).toHaveText('Plak een handtekening uit een andere mailapp of van een webpagina, of schrijf en maak hem hier op.');
  await expect(win.locator('.sig-editor')).toHaveAttribute('data-placeholder', 'Je naam, functie en contactgegevens');
  await expect(win.locator('.sig-toolbar [data-c="source"]')).toHaveAttribute('title', 'HTML bewerken');
  await expect(win.locator('.scrim .buttons button')).toHaveText(['Algemene gebruiken', 'Annuleren', 'Opslaan']);
});
