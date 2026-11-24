// A move, delete or Undo the mail server turns down (#308): the email comes back in the list at once, the notice says
// why, and a refused Undo can be tried again. The demo account refuses changes to a folder whose state has readOnly,
// as a server does a shared folder you may only read (demo.js refuse()); ImapAccount gives the same errors for a real
// server's NO, which test/imap.test.js covers.
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { tempDir, removeDir } = require('../tmp');
const { closeApp } = require('./close');

let app;
let win;
let dataDir;

test.beforeEach(async () => {
  dataDir = tempDir('sem-e2e-');
  fs.mkdirSync(path.join(dataDir, 'data'));
  fs.writeFileSync(path.join(dataDir, 'data', 'settings.json'), JSON.stringify({ language: 'en' }));
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

const REFUSED = "The mail server didn't move the email.";
const notice = () => win.locator('#toast');
// A row by its exact subject, so "Dinner on Saturday" doesn't also find its reply.
const row = (subject) => win.locator('.list-scroll .item').filter({ has: win.locator('.subject', { hasText: new RegExp(`^${subject}$`) }) });
// The demo server turns changes to folder down, or takes them again.
const readOnly = (folder, on) =>
  app.evaluate(
    (_, [folder, on]) => {
      const engine = global.__semEngine;
      engine.session(engine.accounts[0]).box(folder).readOnly = on;
    },
    [folder, on]
  );
// The subjects in a view as the engine has them.
const inView = (view) => win.evaluate(async (view) => (await window.mail.call('list', { scope: 'all', view })).map((m) => m.subject), view);

test('a delete or archive the server refuses puts the email back at once and says why', async ({}, testInfo) => {
  const bencompare = row('Sign in to Bencompare');
  await readOnly('Trash', true);
  await bencompare.click();
  await win.click('[data-reader="delete"]');
  await expect(notice()).toContainText(REFUSED);
  await expect(notice().locator('button')).toHaveCount(0);
  await expect(bencompare).toBeVisible();
  // The email that was open opens again, instead of the next one that took its place.
  await expect(win.locator('.reader-subject')).toHaveText('Sign in to Bencompare');
  await expect(bencompare).toHaveClass(/\bselected\b/);
  await win.screenshot({ path: testInfo.outputPath('refused-delete.png'), animations: 'disabled' });

  await readOnly('Archive', true);
  await bencompare.click();
  await win.click('[data-reader="archive"]');
  await expect(notice()).toContainText(REFUSED);
  await expect(bencompare).toBeVisible();
  await expect(win.locator('.reader-subject')).toHaveText('Sign in to Bencompare');
  expect(await inView('trash')).not.toContain('Sign in to Bencompare');
  expect(await inView('archive')).not.toContain('Sign in to Bencompare');

  // Once the server allows it, the same delete goes through.
  await readOnly('Trash', false);
  await bencompare.click();
  await win.click('[data-reader="delete"]');
  await expect(notice()).toContainText('Moved to Trash');
  await expect(bencompare).toHaveCount(0);
  await expect.poll(() => inView('trash')).toContain('Sign in to Bencompare');
});

test('when the server refuses one of several emails, the notice says why and its Undo brings back the rest', async ({}, testInfo) => {
  // Two starred emails in two folders: the reply in the inbox and the invitation it answers in Sent.
  await win.evaluate(async () => {
    const list = await window.mail.call('list', { scope: 'all', view: 'everything' });
    await window.mail.call('setFlags', list.find((m) => m.subject === 'Dinner on Saturday').id, { starred: true });
  });
  await readOnly('Sent', true);
  await win.click('.nav-item[data-view="starred"]');
  const reply = row('Re: Dinner on Saturday');
  const invitation = row('Dinner on Saturday');
  await reply.click();
  await invitation.click({ modifiers: ['ControlOrMeta'] });
  await expect(win.locator('.list-tools.selecting .sel-count')).toHaveText('2 selected');
  await win.click('.list-tools [data-bulk="delete"]');
  await expect(notice()).toContainText(`Moved 1 of 2 emails to Trash. ${REFUSED}`);
  await expect(notice().locator('button')).toHaveText('Undo');
  await expect(invitation).toBeVisible();
  await expect(reply).toHaveCount(0);
  await win.screenshot({ path: testInfo.outputPath('partial-bulk-delete.png'), animations: 'disabled' });

  await notice().locator('button').click();
  await expect(notice()).toContainText('Restored');
  await expect(reply).toBeVisible();
  await expect(invitation).toBeVisible();
  expect(await inView('trash')).not.toContain('Re: Dinner on Saturday');
});

test('an Undo the server refuses leaves the email archived and offers Undo again, which works once allowed', async ({}, testInfo) => {
  const bencompare = row('Sign in to Bencompare');
  await bencompare.click();
  await win.click('[data-reader="archive"]');
  await expect(notice()).toContainText('Moved to Archive');
  await expect(bencompare).toHaveCount(0);

  await readOnly('Archive', true);
  await notice().locator('button').click();
  await expect(notice()).toContainText(REFUSED);
  await expect(notice().locator('button')).toHaveText('Undo');
  await expect(bencompare).toHaveCount(0);
  expect(await inView('archive')).toContain('Sign in to Bencompare');
  await win.screenshot({ path: testInfo.outputPath('refused-undo.png'), animations: 'disabled' });

  await readOnly('Archive', false);
  await notice().locator('button').click();
  await expect(notice()).toContainText('Restored');
  await expect(bencompare).toBeVisible();
  await expect.poll(() => inView('archive')).not.toContain('Sign in to Bencompare');
});

test('Empty Trash reports a refused delete and leaves the email visible', async ({}, testInfo) => {
  const subject = 'Sign in to Bencompare';
  await row(subject).click();
  await win.click('[data-reader="delete"]');
  await expect.poll(() => inView('trash')).toContain(subject);
  await readOnly('Trash', true);

  await win.click('.nav-item[data-view="trash"]');
  await expect(row(subject)).toBeVisible();
  await win.click('.list-head [data-action="list-more"]');
  await win.getByRole('menuitem', { name: 'Empty Trash', exact: true }).click();
  await win.locator('.dialog').getByRole('button', { name: 'Empty', exact: true }).click();

  await expect(notice()).toContainText("The mail server didn't delete the email.");
  await expect(row(subject)).toBeVisible();
  await win.screenshot({ path: testInfo.outputPath('refused-empty-trash.png'), animations: 'disabled' });
});

test('a draft the server refuses to delete stays in Drafts, and the editor says why instead of Draft deleted', async ({}, testInfo) => {
  const subject = 'Holiday ideas';
  await win.click('.nav-item[data-view="drafts"]');
  await row(subject).dblclick();
  await expect(win.locator('.composer')).toBeVisible();
  await readOnly('Drafts', true);

  await win.click('[data-c="discard"]');
  await win.click('.scrim .buttons button:text-is("Delete")');
  await expect(win.locator('.composer')).toHaveCount(0);
  await expect(notice()).toContainText("The mail server didn't delete the email.");
  await expect(notice()).not.toContainText('Draft deleted');
  await expect(row(subject)).toBeVisible();
  expect(await inView('drafts')).toContain(subject);
  await win.screenshot({ path: testInfo.outputPath('refused-draft-discard.png'), animations: 'disabled' });

  // Once the server allows it, the same discard goes through and says so.
  await readOnly('Drafts', false);
  await row(subject).dblclick();
  await expect(win.locator('.composer')).toBeVisible();
  await win.click('[data-c="discard"]');
  await win.click('.scrim .buttons button:text-is("Delete")');
  await expect(notice()).toContainText('Draft deleted');
  await expect(row(subject)).toHaveCount(0);
  await expect.poll(() => inView('drafts')).not.toContain(subject);
});
