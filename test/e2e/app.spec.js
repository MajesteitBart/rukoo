// End-to-end tests: launch the real Electron app with a throwaway profile and the demo account.
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');

let app;
let win;

test.beforeEach(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sem-e2e-'));
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
  await app.close();
});

const item = (text) => win.locator('.item', { hasText: text }).first();

test('first run shows the demo inbox like the phone app', async () => {
  await expect(win.locator('.list-title h1')).toHaveText('Postvak IN');
  await expect(win.locator('.list-title .sub')).toHaveText('demo@voorbeeld.nl');
  await expect(item('ANWB Nieuwsbrief')).toHaveClass(/unread/);
  await expect(win.locator('.drawer-item.active .badge')).toHaveText('7');
  await expect(win.locator('.group-head').first()).toContainText('Vandaag');
});

test('opening a message renders it and marks it read', async () => {
  await item('ANWB Nieuwsbrief').click();
  await expect(win.locator('.reader-subject')).toHaveText('Dit kost een verkeersboete in 2027');
  await expect(win.frameLocator('.mail-frame').locator('h1')).toContainText('laagstaande zon');
  await expect(item('ANWB Nieuwsbrief')).not.toHaveClass(/unread/);
  await expect(win.locator('.drawer-item.active .badge')).toHaveText('6');
  await win.click('[data-reader="details"]');
  await expect(win.locator('.details')).toContainText('nieuwsbrieven@anwb.nl');
  await win.click('[data-reader="next"]');
  await expect(win.locator('.reader-subject')).toContainText('music industry');
});

test('attachments are listed for messages that have them', async () => {
  await item('Vandebron').click();
  await expect(win.locator('.attachment .name')).toHaveText('Contractbevestiging.pdf');
});

test('star toggles and shows up under Sterren', async () => {
  await item('Bencompare').locator('[data-star]').click();
  await expect(item('Bencompare').locator('[data-star]')).toHaveClass(/on/);
  await win.click('[data-view="starred"]');
  await expect(win.locator('.list-title h1')).toHaveText('Sterren');
  await expect(item('Bencompare')).toBeVisible();
});

test('delete moves to Prullenbak', async () => {
  await item('Bencompare').click();
  await win.click('[data-reader="delete"]');
  await expect(win.locator('#toast')).toContainText('Prullenbak');
  await expect(win.locator('.item', { hasText: 'Bencompare' })).toHaveCount(0);
  await win.click('[data-view="trash"]');
  await expect(item('Bencompare')).toBeVisible();
});

test('compose and send to self delivers to the inbox and Verzonden', async () => {
  await win.click('.fab');
  await win.fill('[data-rinput="to"]', 'demo@voorbeeld.nl');
  await win.keyboard.press('Enter');
  await expect(win.locator('[data-rfield="to"] .recipient')).toHaveCount(1);
  await win.fill('[data-field="subject"]', 'Hallo vanaf Windows');
  await win.click('.editor');
  await win.keyboard.type('Dit is een test.');
  await win.click('[data-c="send"]');
  await expect(win.locator('.compose')).toHaveCount(0);
  await expect(win.locator('#toast')).toContainText('verzonden');
  await expect(item('Hallo vanaf Windows')).toBeVisible({ timeout: 10000 });
  await item('Hallo vanaf Windows').click();
  await expect(win.frameLocator('.mail-frame').locator('body')).toContainText('Dit is een test.');
  await win.click('[data-view="sent"]');
  await expect(item('Hallo vanaf Windows')).toBeVisible();
});

test('reply all prefills recipients, subject and quote', async () => {
  await item('Sanne de Vries').click();
  await expect(win.locator('.reader-subject')).toHaveText('Afspraak donderdag');
  await win.click('[data-reader="replyAll"]');
  await expect(win.locator('[data-field="subject"]')).toHaveValue('Re: Afspraak donderdag');
  await expect(win.locator('[data-rfield="to"] .recipient')).toHaveText(['Sanne de Vries']);
  await expect(win.locator('[data-rfield="cc"] .recipient')).toHaveText(['Joris Bakker']);
  await expect(win.locator('.quote-head')).toContainText('Oorspronkelijk bericht');
  await expect(win.locator('.include-row')).toContainText('Inclusief vorige berichten');
});

test('forward keeps the original attachment', async () => {
  await item('Sanne de Vries').click();
  await expect(win.locator('.attachment .name')).toHaveText('Voorstel-v3.pdf');
  await win.click('[data-reader="forward"]');
  await expect(win.locator('[data-field="subject"]')).toHaveValue('Fwd: Afspraak donderdag');
  await expect(win.locator('.compose-attachments')).toContainText('Voorstel-v3.pdf');
  await win.fill('[data-rinput="to"]', 'demo@voorbeeld.nl');
  await win.click('[data-c="send"]');
  await expect(win.locator('.compose')).toHaveCount(0);
  await item('Fwd: Afspraak donderdag').click();
  await expect(win.locator('.attachment .name')).toHaveText('Voorstel-v3.pdf');
});

test('closing a dirty compose can save to Concepten', async () => {
  await win.click('.fab');
  await win.fill('[data-field="subject"]', 'Half af');
  await win.click('[data-c="close"]');
  await win.click('.scrim .buttons button:has-text("Opslaan")');
  await expect(win.locator('#toast')).toContainText('Concepten');
  await win.click('[data-view="drafts"]');
  await expect(item('Half af')).toBeVisible();
  await expect(win.locator('[data-view="drafts"] .count')).toHaveText('4');
});

test('search filters the list', async () => {
  await win.click('[data-action="search"]');
  await win.fill('#search', 'wachtwoord');
  await expect(win.locator('.item')).toHaveCount(3);
  await win.keyboard.press('Escape');
  await expect(win.locator('.list-title h1')).toHaveText('Postvak IN');
});

test('user folders load on demand', async () => {
  await win.click('[data-folder="Facturen"]');
  await expect(win.locator('.list-title h1')).toHaveText('Facturen');
  await expect(item('Ziggo')).toBeVisible();
});

test('settings: theme switch and account page', async () => {
  await win.click('[data-action="settings"]');
  await expect(win.locator('.settings h1')).toHaveText('E-mailinstellingen');
  await win.click('[data-a="theme"]');
  await win.click('.radio-row:has-text("Licht")');
  await expect(win.locator('html')).toHaveClass(/light/);
  await win.click('[data-a="theme"]');
  await win.click('.radio-row:has-text("Donker")');
  await expect(win.locator('html')).not.toHaveClass(/light/);
  await win.click('.row:has-text("demo@voorbeeld.nl")');
  await expect(win.locator('.settings h1')).toHaveText('demo@voorbeeld.nl');
  await win.click('[data-a="back"]');
  await win.click('[data-a="back"]');
  await expect(win.locator('.settings')).toHaveCount(0);
});

test('swipe right toggles read, swipe left deletes', async () => {
  const row = () => item('Je wachtwoord is gewijzigd');
  const swipe = async (from, to) => {
    await expect(row()).toBeVisible();
    const box = await row().boundingBox();
    const y = box.y + box.height / 2;
    await win.mouse.move(box.x + from, y);
    await win.mouse.down();
    await win.mouse.move(box.x + (from + to) / 2, y, { steps: 8 });
    await win.mouse.move(box.x + to, y, { steps: 8 });
    await win.mouse.up();
  };
  await expect(row()).toHaveClass(/unread/);
  await swipe(60, 240);
  await expect(row()).not.toHaveClass(/unread/);
  await swipe(300, 60);
  await expect(win.locator('.item', { hasText: 'Je wachtwoord is gewijzigd' })).toHaveCount(0);
  await expect(win.locator('#toast')).toContainText('Prullenbak');
});

test('keyboard: arrows navigate, Ctrl+N composes, Escape closes', async () => {
  await win.locator('.list-scroll').focus();
  await win.keyboard.press('ArrowDown');
  await expect(win.locator('.reader-subject')).toHaveText('Dit kost een verkeersboete in 2027');
  await win.keyboard.press('ArrowDown');
  await expect(win.locator('.reader-subject')).toContainText('music industry');
  await win.keyboard.press('Control+n');
  await expect(win.locator('.compose')).toBeVisible();
  await win.keyboard.press('Escape');
  await expect(win.locator('.compose')).toHaveCount(0);
});
