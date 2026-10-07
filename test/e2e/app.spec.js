// End-to-end tests: launch the real Electron app with a throwaway profile and the demo account.
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');

let app;
let win;

test.beforeEach(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sem-e2e-'));
  // Keep the existing Dutch interaction suite as coverage for the supported Dutch locale.
  fs.mkdirSync(path.join(dataDir, 'data'));
  fs.writeFileSync(path.join(dataDir, 'data', 'settings.json'), JSON.stringify({ language: 'nl' }));
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
  // An editor with unsaved changes keeps its window open and asks first; skip that in tests.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.destroy())).catch(() => {});
  await app.close();
});

const item = (text) => win.locator('.item', { hasText: text }).first();

// The editor opens in the reading pane.
async function composer(trigger) {
  await trigger();
  await win.waitForSelector('.composer .editor');
  return win;
}
const composerGone = () => expect(win.locator('.composer')).toHaveCount(0, { timeout: 10000 });

// Makes engine calls slow or failing in the main process, to reach the race windows.
const slowDown = (method, ms) =>
  app.evaluate(
    (_, [method, ms]) => {
      const engine = global.__semEngine;
      const orig = engine[method].bind(engine);
      global.__calls = global.__calls || {};
      global.__calls[method] = 0;
      engine[method] = async (...args) => {
        global.__calls[method]++;
        await new Promise((r) => setTimeout(r, ms));
        return orig(...args);
      };
    },
    [method, ms]
  );
const calls = (method) => app.evaluate((_, m) => (global.__calls || {})[m] || 0, method);

// ---------- reading ----------

test('first run shows the demo inbox with the newest message open, still unread', async () => {
  await expect(win.locator('.list-title h1')).toHaveText('Postvak IN');
  await expect(win.locator('.list-title .sub')).toContainText('demo@example.com');
  await expect(win.locator('.reader-subject')).toHaveText('Traffic fines in 2027: what you will pay');
  await expect(item('ANWB Newsletter')).toHaveClass(/unread/);
  await expect(win.locator('.nav-item.active .count')).toHaveText('7');
  await expect(win.locator('.group-head').first()).toContainText('Vandaag');
  await expect(win.locator('.sync-status')).toContainText('bijgewerkt');
});

test('opening a message renders it and marks it read', async () => {
  await item('ANWB Newsletter').click();
  await expect(win.frameLocator('.mail-frame').locator('h1')).toContainText('low sun');
  await expect(item('ANWB Newsletter')).not.toHaveClass(/unread/);
  await expect(item('ANWB Newsletter')).toHaveClass(/selected/);
  await expect(win.locator('.nav-item.active .count')).toHaveText('6');
  await expect(win.locator('.msg-from')).toContainText('newsletter@anwb.nl');
  await expect(win.locator('.to-summary')).toHaveText('aan mij');
  await win.click('[data-reader="next"]');
  await expect(win.locator('.reader-subject')).toContainText('music industry');
});

test('previews skip "view in browser" lines and greetings', async () => {
  await expect(item('ANWB Newsletter').locator('.preview')).not.toContainText('View email in browser');
  await expect(item('Vandebron').locator('.preview')).toContainText('Customer number');
  await expect(item('Vandebron').locator('.preview')).not.toContainText('Dear');
});

test('the header summarises recipients and shows the details on request', async () => {
  await item('Sanne de Vries').click();
  await expect(win.locator('.to-summary')).toHaveText('aan mij, Joris Bakker');
  await expect(win.locator('.details')).toHaveCount(0);
  await win.click('.to-summary');
  await expect(win.locator('.details')).toContainText('joris@example.com');
  await expect(win.locator('[data-reader="unsubscribe"]')).toHaveCount(0);
});

test('newsletters can be unsubscribed from in one click', async () => {
  await expect(win.locator('.reader-subject')).toHaveText('Traffic fines in 2027: what you will pay');
  await win.click('[data-reader="unsubscribe"]');
  await expect(win.locator('.scrim')).toContainText('Uitschrijven bij ANWB Newsletter?');
  await win.click('.scrim .buttons button:text-is("Uitschrijven")');
  await expect(win.locator('#toast')).toContainText('Uitgeschreven bij ANWB Newsletter');
});

test('a run of mail from one sender folds into a stack', async () => {
  const head = item('Your password has changed');
  await expect(head.locator('.stack-btn')).toHaveText('+3');
  await expect(win.locator('.item', { hasText: 'Your sign-in details have been updated' })).toHaveCount(0);
  await head.locator('.stack-btn').click();
  await expect(item('Your sign-in details have been updated')).toBeVisible();
  await item('Your password has changed').locator('.stack-btn').click();
  await expect(win.locator('.item', { hasText: 'Your sign-in details have been updated' })).toHaveCount(0);
});

test('attachments are listed for messages that have them', async () => {
  await item('Vandebron').click();
  await expect(win.locator('.att-name')).toHaveText('Contract-confirmation.pdf');
  await expect(win.locator('.att .ftype')).toHaveText('PDF');
  await expect(win.locator('.atts-head')).toHaveCount(0);
});

test('star toggles and shows up under Sterren', async () => {
  await item('Bencompare').hover();
  await item('Bencompare').locator('[data-star]').click();
  await expect(item('Bencompare').locator('[data-star]')).toHaveClass(/on/);
  await win.click('[data-view="starred"]');
  await expect(win.locator('.list-title h1')).toHaveText('Sterren');
  await expect(item('Bencompare')).toBeVisible();
});

// ---------- acting on mail ----------

test('delete moves to Prullenbak and can be undone', async () => {
  await item('Bencompare').click();
  await win.click('[data-reader="delete"]');
  await expect(win.locator('#toast')).toContainText('Prullenbak');
  await expect(win.locator('.item', { hasText: 'Bencompare' })).toHaveCount(0);
  await win.click('#toast button:has-text("Ongedaan maken")');
  await expect(win.locator('#toast')).toContainText('Teruggezet');
  await expect(item('Bencompare')).toBeVisible();
  await expect(win.locator('.reader-subject')).toHaveText('Sign in to Bencompare');
  await win.click('[data-reader="delete"]');
  await win.click('[data-view="trash"]');
  await expect(item('Bencompare')).toBeVisible();
});

test('archive from the toolbar, undo with Ctrl+Z', async () => {
  await item('Bencompare').click();
  await win.click('[data-reader="archive"]');
  await expect(win.locator('#toast')).toContainText('Archief');
  await expect(win.locator('.item', { hasText: 'Bencompare' })).toHaveCount(0);
  await win.locator('.list-scroll').focus();
  await win.keyboard.press('Control+z');
  await expect(item('Bencompare')).toBeVisible();
});

test('Ctrl+click selects several messages for one action', async () => {
  await item('Bencompare').click();
  await item('You updated some of your Google Account details').click({ modifiers: ['Control'] });
  await expect(win.locator('.list-tools.selecting .sel-count')).toHaveText('2 geselecteerd');
  await expect(win.locator('.reader .multi .t')).toHaveText('2 e-mails geselecteerd');
  await win.click('.list-tools [data-bulk="delete"]');
  await expect(win.locator('#toast')).toContainText('2 e-mails verplaatst naar Prullenbak');
  await expect(win.locator('.item', { hasText: 'Bencompare' })).toHaveCount(0);
  await expect(win.locator('.list-tools.selecting')).toHaveCount(0);
  await win.click('#toast button');
  await expect(item('Bencompare')).toBeVisible();
  await expect(item('You updated some of your Google Account details')).toBeVisible();
});

test('dragging a message onto a folder moves it', async () => {
  const dt = await win.evaluateHandle(() => new DataTransfer());
  await item('Bencompare').dispatchEvent('dragstart', { dataTransfer: dt });
  const target = win.locator('[data-folder="Invoices"]');
  await target.dispatchEvent('dragover', { dataTransfer: dt });
  await target.dispatchEvent('drop', { dataTransfer: dt });
  await expect(win.locator('#toast')).toContainText('Verplaatst naar Invoices');
  await expect(win.locator('.item', { hasText: 'Bencompare' })).toHaveCount(0);
  await win.click('[data-folder="Invoices"]');
  await expect(item('Bencompare')).toBeVisible();
});

test('a new folder can be made from the sidebar', async () => {
  await win.click('[data-action="new-folder"]');
  await win.fill('.scrim .form-input', 'Projects');
  await win.click('.scrim .buttons button:text-is("Opslaan")');
  await expect(win.locator('#toast')).toContainText('Map Projects aangemaakt');
  await expect(win.locator('.list-title h1')).toHaveText('Projects');
  await expect(win.locator('[data-folder="Projects"]')).toBeVisible();
});

// ---------- writing ----------

test('compose and send to self delivers to the inbox and Verzonden', async () => {
  const c = await composer(() => win.click('[data-action="compose"]'));
  await expect(c.locator('.composer .from-static')).toContainText('demo@example.com');
  await c.fill('[data-rinput="to"]', 'demo@example.com');
  await c.keyboard.press('Enter');
  await expect(c.locator('[data-rfield="to"] .recipient')).toHaveCount(1);
  await c.fill('[data-field="subject"]', 'Hello from Windows');
  await c.click('.editor');
  await c.keyboard.type('This is a test.');
  await c.click('[data-c="send"]');
  await composerGone();
  await expect(win.locator('#toast')).toContainText('verzonden');
  await expect(item('Hello from Windows')).toBeVisible({ timeout: 10000 });
  await item('Hello from Windows').click();
  await expect(win.frameLocator('.mail-frame').locator('body')).toContainText('This is a test.');
  await expect(win.frameLocator('.mail-frame').locator('body')).not.toContainText('Verzonden vanaf mijn pc');
  await win.click('[data-view="sent"]');
  await expect(item('Hello from Windows')).toBeVisible();
});

test('reply all prefills recipients and subject; earlier mail waits behind the pill', async () => {
  await item('Sanne de Vries').click();
  await expect(win.locator('.reader-subject')).toHaveText('Call on Thursday');
  const c = await composer(() => win.click('[data-reader="replyAll"]'));
  await expect(c.locator('[data-field="subject"]')).toHaveValue('Re: Call on Thursday');
  await expect(c.locator('[data-rfield="to"] .recipient')).toHaveText(['Sanne de Vries']);
  await expect(c.locator('[data-rfield="cc"] .recipient')).toHaveText(['Joris Bakker']);
  await expect(c.locator('.quote')).toBeHidden();
  await c.click('.quote-pill');
  await expect(c.locator('.quote-head')).toContainText('Oorspronkelijk bericht');
  await c.click('[data-c="include"]');
  await expect(c.locator('.quote-pill')).toHaveText('··· niet meegestuurd');
});

test('selected text gets a floating formatting bar', async () => {
  const c = await composer(() => win.click('[data-action="compose"]'));
  await c.click('.editor');
  await c.keyboard.type('Important');
  await expect(c.locator('.float-bar')).toBeHidden();
  await c.keyboard.press('Shift+Home');
  await expect(c.locator('.float-bar')).toBeVisible();
  await c.click('.float-bar [data-cmd="bold"]');
  await expect(c.locator('.float-bar [data-cmd="bold"]')).toHaveClass(/on/);
});

test('forward keeps the original attachment', async () => {
  await item('Sanne de Vries').click();
  await expect(win.locator('.att-name')).toHaveText('Proposal-v3.pdf');
  const c = await composer(() => win.click('[data-reader="forward"]'));
  await expect(c.locator('[data-field="subject"]')).toHaveValue('Fwd: Call on Thursday');
  await expect(c.locator('.compose-attachments')).toContainText('Proposal-v3.pdf');
  await c.fill('[data-rinput="to"]', 'demo@example.com');
  await c.click('[data-c="send"]');
  await composerGone();
  await item('Fwd: Call on Thursday').click();
  await expect(win.locator('.att-name')).toHaveText('Proposal-v3.pdf');
});

test('closing a dirty editor asks and can save to Concepten', async () => {
  const c = await composer(() => win.click('[data-action="compose"]'));
  await c.fill('[data-field="subject"]', 'Half finished');
  await c.keyboard.press('Escape');
  await c.click('.scrim .buttons button:text-is("Opslaan")');
  await composerGone();
  await expect(win.locator('#toast')).toContainText('Concepten');
  await win.click('[data-view="drafts"]');
  await expect(item('Half finished')).toBeVisible();
  await expect(win.locator('[data-view="drafts"] .count')).toHaveText('4');
});

test('Ctrl+S saves a draft; closing afterwards keeps it without asking', async () => {
  const c = await composer(() => win.click('[data-action="compose"]'));
  await c.fill('[data-field="subject"]', 'Saved along the way');
  await expect(c.locator('.save-state')).toHaveText('');
  await c.keyboard.press('Control+s');
  await expect(c.locator('.save-state')).toHaveText('Concept opgeslagen');
  await c.keyboard.press('Escape');
  await composerGone();
  await expect(win.locator('#toast')).toContainText('Concept bewaard');
  await win.click('[data-view="drafts"]');
  await expect(item('Saved along the way')).toBeVisible();
});

test('opening another message keeps what you wrote as a draft', async () => {
  const c = await composer(() => win.click('[data-action="compose"]'));
  await c.fill('[data-field="subject"]', 'Away for a moment');
  await item('Bencompare').click();
  await composerGone();
  await expect(win.locator('.reader-subject')).toHaveText('Sign in to Bencompare');
  await expect(win.locator('#toast')).toContainText('Concept opgeslagen');
  await win.click('[data-view="drafts"]');
  await expect(item('Away for a moment')).toBeVisible();
});

test('the editor can move into a window of its own', async () => {
  const c = await composer(() => win.click('[data-action="compose"]'));
  await c.fill('[data-field="subject"]', 'Separate window');
  const [popped] = await Promise.all([app.waitForEvent('window'), c.click('[data-c="popout"]')]);
  await popped.waitForSelector('.compose .editor');
  await expect(popped.locator('[data-field="subject"]')).toHaveValue('Separate window');
  await expect(popped.locator('#compose-title')).toHaveText('Separate window');
  await composerGone();
});

test('a draft opens only once', async () => {
  await win.click('[data-view="drafts"]');
  await win.locator('.item').first().click();
  await composer(() => win.click('[data-reader="edit"]'));
  await win.locator('.item').first().dblclick();
  await win.waitForTimeout(400);
  await expect(win.locator('.composer')).toHaveCount(1);
});

test('a reopened draft cannot restyle or cover the app', async () => {
  const state = await win.evaluate(() => window.mail.call('state'));
  await win.evaluate(
    (accountId) =>
      window.mail.call('saveDraft', {
        accountId,
        to: ['a@example.com'],
        subject: 'Malicious draft',
        html: '<sty<style></style>le>body{display:none}</style><div class="page scrim" style="position:fixed;inset:0;background:red">X</div><p>text</p>'
      }),
    state.accounts[0].id
  );
  await win.click('[data-view="drafts"]');
  await item('Malicious draft').click();
  await expect(win.locator('[data-reader="edit"]')).toBeVisible();
  const c = await composer(() => win.click('[data-reader="edit"]'));
  await expect(c.locator('.compose .editor')).toContainText('text');
  await expect(c.locator('.compose .editor style')).toHaveCount(0);
  await expect(c.locator('.compose .editor .scrim')).toHaveCount(0);
  const fixed = await c.locator('.compose .editor div').first().evaluate((el) => getComputedStyle(el).position);
  expect(fixed).not.toBe('fixed');
  await expect(c.locator('.sidebar')).toBeVisible();
  await expect(c.locator('[data-c="send"]')).toBeVisible();
});

test('a reopened draft keeps its attachment', async () => {
  await item('Sanne de Vries').click();
  const c = await composer(() => win.click('[data-reader="forward"]'));
  await c.fill('[data-rinput="to"]', 'joris@example.com');
  // Enter commits the address; Escape would first close the suggestions.
  await c.keyboard.press('Enter');
  await expect(c.locator('[data-rfield="to"] .recipient')).toHaveCount(1);
  await c.keyboard.press('Escape');
  await c.click('.scrim .buttons button:text-is("Opslaan")');
  await composerGone();
  await win.click('[data-view="drafts"]');
  await item('Fwd: Call on Thursday').click();
  const again = await composer(() => win.click('[data-reader="edit"]'));
  await expect(again.locator('.compose-attachments')).toContainText('Proposal-v3.pdf');
});

test('default sender: add an alias, make it default, compose and send from it', async () => {
  await win.click('[data-action="settings"]');
  await win.click('.row:has-text("demo@example.com")');
  await expect(win.locator('[data-a="acc-from"] .value')).toHaveText('demo@example.com');
  await win.click('[data-a="acc-aliases"]');
  await expect(win.locator('.settings h1')).toHaveText('Afzenderadressen');
  await win.click('[data-a="alias-add"]');
  await win.fill('.scrim .form-input', 'bart@bvdm.ai');
  await win.click('.scrim .buttons button:text-is("Opslaan")');
  await expect(win.locator('.settings .row', { hasText: 'bart@bvdm.ai' })).toBeVisible();
  await win.click('.settings .row:has-text("bart@bvdm.ai")');
  await win.click('.scrim .buttons button:has-text("Standaard maken")');
  await expect(win.locator('.settings .row', { hasText: 'bart@bvdm.ai (standaard)' })).toBeVisible();
  await win.click('[data-a="back"]');
  await expect(win.locator('[data-a="acc-from"] .value')).toHaveText('bart@bvdm.ai');
  await win.click('[data-a="back"]');
  await win.click('[data-a="back"]');

  const c = await composer(() => win.click('[data-action="compose"]'));
  const from = c.locator('[data-field="account"]');
  await expect(from).toBeVisible();
  expect(await from.evaluate((s) => s.selectedOptions[0].textContent)).toContain('bart@bvdm.ai');
  await c.fill('[data-rinput="to"]', 'demo@example.com');
  await c.fill('[data-field="subject"]', 'From my alias');
  await c.click('[data-c="send"]');
  await composerGone();
  await item('From my alias').click();
  await expect(win.locator('.msg-head')).toContainText('bart@bvdm.ai');

  // Replying to mail that came from one of your own addresses keeps that address.
  const reply = await composer(() => win.click('[data-reader="reply"]'));
  expect(await reply.locator('[data-field="account"]').evaluate((s) => s.selectedOptions[0].textContent)).toContain('bart@bvdm.ai');
});

// ---------- finding and layout ----------

test('search filters the list; Escape clears it', async () => {
  await win.fill('#search', 'password');
  await expect(win.locator('.item')).toHaveCount(3);
  await expect(win.locator('.list-title h1')).toHaveText('Zoekresultaten');
  await win.keyboard.press('Escape');
  await expect(win.locator('.list-title h1')).toHaveText('Postvak IN');
});

test('search can cover all folders', async () => {
  await win.fill('#search', 'quote');
  await expect(win.locator('.empty')).toContainText('Niets gevonden');
  await win.click('.search-scope');
  await win.click('.menu button:has-text("Alle mappen")');
  await expect(win.locator('.item').first()).toBeVisible();
  await expect(win.locator('.item .pill').first()).toBeVisible();
});

test('user folders load on demand', async () => {
  await win.click('[data-folder="Invoices"]');
  await expect(win.locator('.list-title h1')).toHaveText('Invoices');
  await expect(item('Ziggo')).toBeVisible();
});

test('quick filters narrow the list', async () => {
  await win.click('[data-filter="attachments"]');
  await expect(win.locator('.item')).toHaveCount(3);
  await win.click('[data-filter="all"]');
  await expect(win.locator('.item').nth(5)).toBeVisible();
});

test('the message list can be resized from the keyboard', async () => {
  const before = (await win.locator('.listpane').boundingBox()).width;
  await win.locator('.divider').focus();
  await win.keyboard.press('ArrowRight');
  await win.keyboard.press('ArrowRight');
  await expect.poll(async () => Math.round((await win.locator('.listpane').boundingBox()).width)).toBe(Math.round(before + 48));
  const saved = await win.evaluate(() => JSON.parse(localStorage.getItem('rukoo.layout')).listWidth);
  expect(saved).toBe(Math.round(before + 48));
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
  await win.click('.row:has-text("demo@example.com")');
  await expect(win.locator('.settings h1')).toHaveText('demo@example.com');
  await win.click('[data-a="back"]');
  await win.click('[data-a="back"]');
  await expect(win.locator('.settings')).toHaveCount(0);
});

test('swipe on a touch screen toggles read and deletes', async () => {
  const row = () => item('Your password has changed');
  const swipe = async (from, to) => {
    await expect(row()).toBeVisible();
    // The list may re-render after a sync; wait for a stable row.
    let box = null;
    await expect.poll(async () => (box = await row().boundingBox())).not.toBeNull();
    const y = box.y + box.height / 2;
    const el = row();
    const fire = (type, x) =>
      el.dispatchEvent(type, { pointerType: 'touch', pointerId: 7, isPrimary: true, button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: x, clientY: y });
    await fire('pointerdown', box.x + from);
    for (let i = 1; i <= 8; i++) await fire('pointermove', box.x + from + ((to - from) * i) / 8);
    await fire('pointerup', box.x + to);
  };
  await expect(row()).toHaveClass(/unread/);
  await swipe(60, 240);
  await expect(row()).not.toHaveClass(/unread/);
  await swipe(300, 60);
  await expect(win.locator('.item', { hasText: 'Your password has changed' })).toHaveCount(0);
  await expect(win.locator('#toast')).toContainText('Prullenbak');
});

test('keyboard: arrows navigate, Ctrl+N composes, Escape closes', async () => {
  await win.locator('.list-scroll').focus();
  await win.keyboard.press('ArrowDown');
  await expect(win.locator('.reader-subject')).toContainText('music industry');
  await win.keyboard.press('ArrowUp');
  await expect(win.locator('.reader-subject')).toHaveText('Traffic fines in 2027: what you will pay');
  await win.keyboard.press('Shift+ArrowDown');
  await expect(win.locator('.sel-count')).toHaveText('2 geselecteerd');
  await win.keyboard.press('Escape');
  await expect(win.locator('.list-tools.selecting')).toHaveCount(0);
  await composer(() => win.keyboard.press('Control+n'));
  await win.keyboard.press('Escape');
  await composerGone();
});

// ---------- regressions ----------

test('after Shift+Down and Escape, Delete removes the message on screen', async () => {
  await item('Bencompare').click();
  await win.locator('.list-scroll').focus();
  await win.keyboard.press('Shift+ArrowDown');
  await expect(win.locator('.sel-count')).toHaveText('2 geselecteerd');
  await win.keyboard.press('Escape');
  await expect(win.locator('.reader-subject')).toHaveText('Sign in to Bencompare');
  await win.keyboard.press('Delete');
  await expect(win.locator('.item', { hasText: 'Bencompare' })).toHaveCount(0);
  await expect(item('You updated some of your Google Account details')).toBeVisible();
});

test('shrinking a selection to one message leaves the multi-message panel', async () => {
  await item('Bencompare').click();
  await win.locator('.list-scroll').focus();
  await win.keyboard.press('Shift+ArrowDown');
  await expect(win.locator('.reader .multi')).toBeVisible();
  await win.keyboard.press('Shift+ArrowUp');
  await expect(win.locator('.sel-count')).toHaveText('1 geselecteerd');
  await expect(win.locator('.reader .multi')).toHaveCount(0);
  await expect(win.locator('.reader-subject')).toHaveText('Sign in to Bencompare');
});

test('clicking Send twice during a save sends once', async () => {
  const c = await composer(() => win.click('[data-action="compose"]'));
  await c.fill('[data-rinput="to"]', 'demo@example.com');
  await c.keyboard.press('Enter');
  await c.fill('[data-field="subject"]', 'Only once');
  await slowDown('saveDraft', 1500);
  await slowDown('send', 0);
  await c.keyboard.press('Control+s');
  await c.locator('[data-c="send"]').click({ force: true, noWaitAfter: true });
  await c.locator('[data-c="send"]').click({ force: true, noWaitAfter: true }).catch(() => {});
  await composerGone();
  expect(await calls('send')).toBe(1);
});

test('removing a recipient during a save keeps the editor dirty', async () => {
  const c = await composer(() => win.click('[data-action="compose"]'));
  await c.fill('[data-rinput="to"]', 'a@example.com, b@example.com,');
  await expect(c.locator('[data-rfield="to"] .recipient')).toHaveCount(2);
  await c.fill('[data-field="subject"]', 'Recipients');
  await slowDown('saveDraft', 1200);
  await c.keyboard.press('Control+s');
  await expect(c.locator('.save-state')).toHaveText('Opslaan...');
  await c.locator('[data-rfield="to"] .recipient').first().locator('button').click();
  await expect(c.locator('[data-rfield="to"] .recipient')).toHaveCount(1);
  await expect(c.locator('.save-state')).not.toHaveText('Opslaan...', { timeout: 5000 });
  await expect(c.locator('.composer')).toHaveAttribute('data-dirty', 'true');
  await c.keyboard.press('Escape');
  await expect(c.locator('.scrim')).toContainText('Concept opslaan?');
});

test('an attachment removed during a save stays removed', async () => {
  await item('Sanne de Vries').click();
  const c = await composer(() => win.click('[data-reader="forward"]'));
  await expect(c.locator('.att-chip')).toHaveCount(1);
  await slowDown('saveDraft', 1200);
  await c.keyboard.press('Control+s');
  await c.locator('.att-chip button').click();
  await expect(c.locator('.att-chip')).toHaveCount(0);
  await expect(c.locator('.save-state')).not.toHaveText('Opslaan...', { timeout: 5000 });
  await expect(c.locator('.composer')).toHaveAttribute('data-dirty', 'true');
  await c.waitForTimeout(300);
  await expect(c.locator('.att-chip')).toHaveCount(0);
});

test('a failed read-back after saving is retried before sending', async () => {
  await item('Sanne de Vries').click();
  const c = await composer(() => win.click('[data-reader="forward"]'));
  await c.fill('[data-rinput="to"]', 'demo@example.com');
  await c.keyboard.press('Enter');
  // The first read of the new draft fails, as on a dropped connection.
  await app.evaluate(() => {
    const engine = global.__semEngine;
    const orig = engine.getMessage.bind(engine);
    let failed = false;
    engine.getMessage = async (id) => {
      if (!failed && decodeURIComponent(String(id)).includes('Drafts')) {
        failed = true;
        throw new Error('Verbinding verbroken');
      }
      return orig(id);
    };
  });
  await c.keyboard.press('Control+s');
  await expect(c.locator('.save-state')).toHaveText('Concept opgeslagen');
  await c.click('[data-c="send"]');
  await composerGone();
  await item('Fwd: Call on Thursday').click();
  await expect(win.locator('.att-name')).toHaveText('Proposal-v3.pdf');
});

test('the window cannot be closed while the editor is sending', async () => {
  const c = await composer(() => win.click('[data-action="compose"]'));
  await c.fill('[data-rinput="to"]', 'demo@example.com');
  await c.keyboard.press('Enter');
  await c.fill('[data-field="subject"]', 'Do not close');
  await c.keyboard.press('Control+s');
  await expect(c.locator('.save-state')).toHaveText('Concept opgeslagen');
  await slowDown('send', 1500);
  await c.click('[data-c="send"]');
  // The window's close button fires beforeunload; a prevented one keeps an Electron window open.
  const blocksClose = () =>
    win.evaluate(() => {
      const e = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(e);
      return e.defaultPrevented;
    });
  expect(await blocksClose()).toBe(true);
  await composerGone();
  expect(await calls('send')).toBe(1);
});

test('saving before closing locks the editor until the save is done', async () => {
  const c = await composer(() => win.click('[data-action="compose"]'));
  await c.fill('[data-field="subject"]', 'Latest version');
  await c.click('.editor');
  await c.keyboard.type('first line');
  await c.keyboard.press('Escape');
  await slowDown('saveDraft', 1200);
  await c.click('.scrim .buttons button:text-is("Opslaan")');
  expect(await c.evaluate(() => document.querySelector('.compose').inert)).toBe(true);
  await composerGone();
  await win.click('[data-view="drafts"]');
  await item('Latest version').click();
  await expect(win.frameLocator('.mail-frame').locator('body')).toContainText('first line');
});

test('Ctrl+Enter during save-and-close sends nothing and keeps the editor locked', async () => {
  const c = await composer(() => win.click('[data-action="compose"]'));
  await c.fill('[data-field="subject"]', 'No recipient');
  await c.keyboard.press('Escape');
  await slowDown('saveDraft', 1200);
  await slowDown('send', 0);
  await c.click('.scrim .buttons button:text-is("Opslaan")');
  await c.keyboard.press('Control+Enter');
  expect(await c.evaluate(() => document.querySelector('.compose').inert)).toBe(true);
  await composerGone();
  expect(await calls('send')).toBe(0);
});

test('without a Prullenbak, delete asks before removing for good', async () => {
  const state = await win.evaluate(() => window.mail.call('state'));
  // Simulate a server whose trash folder was not recognised.
  await app.evaluate((_, id) => {
    const engine = global.__semEngine;
    const cache = engine.caches.get(id);
    cache.folders = cache.folders.filter((f) => f.role !== 'trash');
  }, state.accounts[0].id);
  await item('Bencompare').click();
  await win.click('[data-reader="delete"]');
  await expect(win.locator('.scrim')).toContainText('geen Prullenbak');
  await win.click('.scrim .buttons button:has-text("Annuleren")');
  await expect(item('Bencompare')).toBeVisible();
  await item('Bencompare').click();
  await win.click('[data-reader="delete"]');
  await win.click('.scrim .buttons button:has-text("Verwijderen")');
  await expect(win.locator('#toast')).toContainText('Verwijderd');
  await expect(win.locator('.item', { hasText: 'Bencompare' })).toHaveCount(0);
});

test('a mail frame settles at its content height and keeps the scroll position', async () => {
  const height = () => win.locator('.mail-frame').evaluate((f) => f.offsetHeight);
  const settled = async () => {
    await win.waitForTimeout(400);
    const a = await height();
    await win.waitForTimeout(800);
    expect(await height()).toBe(a);
    return a;
  };
  await item('ANWB Newsletter').click();
  await win.waitForSelector('.mail-frame');
  const h = await settled();
  expect(await win.frameLocator('.mail-frame').locator('html').evaluate((d) => d.scrollHeight)).toBeLessThanOrEqual(h);

  // Mail that sizes itself to the window must not feed on the frame's own height either.
  const state = await win.evaluate(() => window.mail.call('state'));
  await win.evaluate(
    (accountId) =>
      window.mail.call('saveDraft', {
        accountId,
        to: ['a@example.com'],
        subject: 'Full window',
        html: '<table height="100%" width="100%"><tr><td>a</td></tr></table><div style="min-height:100vh">b</div><p id="footer" style="height:50px">footer</p>'
      }),
    state.accounts[0].id
  );
  await win.click('[data-view="drafts"]');
  await item('Full window').click();
  await win.waitForSelector('.mail-frame');
  const frameHeight = await settled();
  expect(frameHeight).toBeLessThan(400);
  // Such mail has no height that fits, so it scrolls inside the frame and its end stays reachable.
  const reach = await win.frameLocator('.mail-frame').locator('html').evaluate((d) => ({
    overflow: d.scrollHeight > d.clientHeight + 1,
    scrollable: getComputedStyle(d.ownerDocument.body).overflowY === 'auto'
  }));
  expect(!reach.overflow || reach.scrollable).toBe(true);

  // Resizing the window refits the mail without moving the reader's scroll position.
  await win.click('[data-view="inbox"]');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1500, 600));
  await item('ANWB Newsletter').click();
  await win.waitForSelector('.mail-frame');
  await settled();
  await win.locator('.reader-scroll').evaluate((s) => (s.scrollTop = 300));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1380, 600));
  await settled();
  expect(await win.locator('.reader-scroll').evaluate((s) => s.scrollTop)).toBe(300);
});

test('newsletter canvases are cleared so the mail sits on the reader', async () => {
  await win.waitForSelector('.mail-frame');
  await expect
    .poll(() => win.frameLocator('.mail-frame').locator('body').evaluate((b) => getComputedStyle(b).backgroundColor))
    .toBe('rgba(0, 0, 0, 0)');
});

test('a reopened reply keeps the earlier mail behind the pill, and still sends it', async () => {
  await item('Sanne de Vries').click();
  const c = await composer(() => win.click('[data-reader="reply"]'));
  await c.click('.editor');
  await c.keyboard.type('See you on Thursday!');
  await c.keyboard.press('Escape');
  await c.click('.scrim .buttons button:text-is("Opslaan")');
  await composerGone();
  await win.click('[data-view="drafts"]');
  await item('Re: Call on Thursday').click();
  await composer(() => win.click('[data-reader="edit"]'));
  await expect(win.locator('.composer .editor')).toContainText('See you on Thursday!');
  await expect(win.locator('.composer .editor')).not.toContainText('Oorspronkelijk bericht');
  await expect(win.locator('.quote-pill')).toBeVisible();
  await win.click('.quote-pill');
  await expect(win.locator('.quote-head')).toContainText('Van: Sanne de Vries');
  await win.fill('[data-rinput="to"]', 'demo@example.com');
  await win.keyboard.press('Enter');
  await win.click('[data-c="send"]');
  await composerGone();
  await win.click('[data-view="inbox"]');
  await item('Re: Call on Thursday').click();
  await expect(win.frameLocator('.mail-frame').locator('body')).toContainText('Oorspronkelijk bericht');
  await expect(win.frameLocator('.mail-frame').locator('body')).toContainText('Shall we have a call on Thursday');
});

// ---------- regressions from the critique review ----------

test('a reply that is still loading cannot replace a new message', async () => {
  await item('Sanne de Vries').click();
  await expect(win.locator('.reader-subject')).toHaveText('Call on Thursday');
  await slowDown('getMessage', 1500);
  await win.click('[data-reader="reply"]');
  await composer(() => win.click('[data-action="compose"]'));
  await win.fill('[data-field="subject"]', 'Not saved yet');
  await win.waitForTimeout(2000);
  await expect(win.locator('.composer')).toHaveCount(1);
  await expect(win.locator('.composer-title')).toHaveText('Nieuw bericht');
  await expect(win.locator('[data-field="subject"]')).toHaveValue('Not saved yet');
});

test('a draft open in its own window is not opened again inline', async () => {
  await win.click('[data-view="drafts"]');
  await win.locator('.item').first().click();
  await composer(() => win.click('[data-reader="edit"]'));
  const [popped] = await Promise.all([app.waitForEvent('window'), win.click('[data-c="popout"]')]);
  await popped.waitForSelector('.compose .editor');
  await composerGone();
  await win.locator('.item').first().click();
  await win.click('[data-reader="edit"]');
  await win.waitForTimeout(500);
  await expect(win.locator('.composer')).toHaveCount(0);
  expect(app.windows().length).toBe(2);
});

test('while writing, Delete in the list does not touch the hidden message', async () => {
  await expect(win.locator('.reader-subject')).toHaveText('Traffic fines in 2027: what you will pay');
  await composer(() => win.click('[data-action="compose"]'));
  await win.locator('.list-scroll').focus();
  await win.keyboard.press('Delete');
  await win.waitForTimeout(400);
  await expect(item('ANWB Newsletter')).toBeVisible();
  await expect(win.locator('.composer')).toHaveCount(1);
});

test('the newest message opens even when the list is sorted oldest first', async () => {
  await win.evaluate(() => window.mail.call('updateSettings', { sort: 'date-asc' }));
  await win.click('[data-view="drafts"]');
  await win.click('[data-view="inbox"]');
  await expect(win.locator('.reader-subject')).toHaveText('Traffic fines in 2027: what you will pay');
});

test('the newest message opens even when it is folded into a stack', async () => {
  const state = await win.evaluate(() => window.mail.call('state'));
  for (const subject of ['Stack 1', 'Stack 2', 'Stack 3']) {
    // A Date header counts whole seconds; apart, the three have a clear newest.
    if (subject !== 'Stack 1') await win.waitForTimeout(1100);
    await win.evaluate(
      ([accountId, subject]) => window.mail.call('send', { accountId, to: ['demo@example.com'], subject, html: '<p>x</p>' }),
      [state.accounts[0].id, subject]
    );
  }
  await win.evaluate(() => window.mail.call('sync'));
  await win.evaluate(() => window.mail.call('updateSettings', { sort: 'date-asc' }));
  await win.click('[data-view="drafts"]');
  await win.click('[data-view="inbox"]');
  await expect(win.locator('.reader-subject')).toHaveText('Stack 3');
  await expect(item('Stack 3')).toHaveClass(/selected/);
});
