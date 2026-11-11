// Dragging a recipient between To, Cc and Bcc, in the editor in the reading pane and in a compose window: onto a
// field that is open, onto the Cc or Bcc link that opens one, and onto a field that already has that address.
// The real app with a throwaway profile and the demo account.
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { tempDir, removeDir } = require('../tmp');
const { closeApp } = require('./close');

let app;
let win;
let dataDir;

test.beforeEach(async () => {
  dataDir = tempDir('rukoo-compose-recipients-e2e-');
  fs.mkdirSync(path.join(dataDir, 'data'));
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
  await closeApp(app);
  removeDir(dataDir);
});

const chips = (page, field) => page.locator(`[data-rfield="${field}"] .recipient`);
const type = async (page, field, text) => {
  await page.locator(`[data-rinput="${field}"]`).fill(text);
  await page.locator(`[data-rinput="${field}"]`).press('Enter');
};

test('recipients move between To, Cc and Bcc by dragging, inline and in the compose window', async () => {
  await win.click('[data-action="compose"]');
  await win.waitForSelector('.composer .editor');
  for (const a of ['anna@test.invalid', 'joris@test.invalid', 'sanne@test.invalid']) await type(win, 'to', a);
  await expect(chips(win, 'to')).toHaveText(['anna@test.invalid', 'joris@test.invalid', 'sanne@test.invalid']);
  await expect(win.locator('[data-rfield="cc"]')).toBeHidden();

  // Onto the Cc link while Cc is closed: it opens with the address in it.
  await chips(win, 'to').nth(1).dragTo(win.locator('[data-c="cc"]'));
  await expect(win.locator('[data-rfield="cc"]')).toBeVisible();
  await expect(win.locator('[data-c="cc"]')).toBeHidden();
  await expect(chips(win, 'cc')).toHaveText(['joris@test.invalid']);
  await expect(chips(win, 'to')).toHaveText(['anna@test.invalid', 'sanne@test.invalid']);

  // Onto an open field.
  await chips(win, 'to').first().dragTo(win.locator('[data-rfield="cc"]'));
  await expect(chips(win, 'cc')).toHaveText(['joris@test.invalid', 'anna@test.invalid']);
  await expect(chips(win, 'to')).toHaveText(['sanne@test.invalid']);

  // Onto its own field nothing changes; onto the Bcc link it moves there.
  await chips(win, 'to').first().dragTo(win.locator('[data-rinput="to"]'));
  await expect(chips(win, 'to')).toHaveText(['sanne@test.invalid']);
  await chips(win, 'to').first().dragTo(win.locator('[data-c="bcc"]'));
  await expect(chips(win, 'bcc')).toHaveText(['sanne@test.invalid']);
  await expect(chips(win, 'to')).toHaveCount(0);

  // An address the field already has isn't added twice.
  await type(win, 'to', 'joris@test.invalid');
  await chips(win, 'to').first().dragTo(win.locator('[data-rfield="cc"]'));
  await expect(chips(win, 'cc')).toHaveText(['joris@test.invalid', 'anna@test.invalid']);
  await expect(chips(win, 'to')).toHaveCount(0);

  // The compose window gets the fields as they are, and dragging works there too.
  const [compose] = await Promise.all([app.waitForEvent('window'), win.click('[data-c="popout"]')]);
  compose.on('dialog', () => {});
  await compose.waitForSelector('.compose .editor');
  await expect(chips(compose, 'cc')).toHaveText(['joris@test.invalid', 'anna@test.invalid']);
  await expect(chips(compose, 'bcc')).toHaveText(['sanne@test.invalid']);
  await chips(compose, 'bcc').first().dragTo(compose.locator('[data-rfield="to"]'));
  await expect(chips(compose, 'to')).toHaveText(['sanne@test.invalid']);
  await expect(chips(compose, 'bcc')).toHaveCount(0);
  await chips(compose, 'cc').last().dragTo(compose.locator('[data-rfield="bcc"]'));
  await expect(chips(compose, 'bcc')).toHaveText(['anna@test.invalid']);
  await expect(chips(compose, 'cc')).toHaveText(['joris@test.invalid']);
});
