// Undo send (#104): Send holds the email for the time in Settings > General > Undo send, the main window's notice
// takes it back, and its editor opens again with everything in it. Test runs send at once unless SEM_UNDO_SEND=1
// (main.js undoSendDelay), so this file turns it on. No test waits out a notice: they take the email back, or send
// it now through the outbox's flush(), which is what a quit does.
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { tempDir, removeDir } = require('../tmp');
const { closeApp } = require('./close');

let app;
let win;
let dataDir;

async function launch() {
  const env = { ...process.env, SEM_DATA_DIR: dataDir, SEM_HIDDEN: '1', SEM_UNDO_SEND: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: ['.'], cwd: path.join(__dirname, '..', '..'), env });
  win = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1500, 950));
}

test.beforeEach(async () => {
  dataDir = tempDir('sem-e2e-');
  fs.mkdirSync(path.join(dataDir, 'data'));
  // 30 seconds, so no notice runs out while a test looks at it.
  fs.writeFileSync(path.join(dataDir, 'data', 'settings.json'), JSON.stringify({ language: 'en', undoSend: 30 }));
  await launch();
  await win.waitForSelector('.provider-grid');
  await win.click('[data-s="demo"]');
  await expect(win.locator('.item').first()).toBeVisible({ timeout: 15000 });
});

test.afterEach(async () => {
  await closeApp(app);
  removeDir(dataDir);
});

const item = (text) => win.locator('.item', { hasText: text }).first();
const notice = () => win.locator('#toast');
const composer = () => win.locator('.composer');
const composerGone = () => expect(composer()).toHaveCount(0, { timeout: 10000 });
const waiting = () => app.evaluate(() => global.__semOutbox.size);
const sendWaiting = () => app.evaluate(() => global.__semOutbox.flush());
// The subjects in a view of the demo account, after a sync.
const subjects = (view) =>
  app.evaluate(async (_e, view) => {
    const engine = global.__semEngine;
    const id = engine.accounts[0].id;
    await engine.syncAccount(id);
    return engine.listMessages({ scope: id, view }).map((m) => m.subject);
  }, view);

async function newMessage(page, { to, subject, text }) {
  await page.click('[data-action="compose"]');
  const c = page.locator('.composer');
  await c.locator('[data-rinput="to"]').fill(to);
  await c.locator('[data-rinput="to"]').press('Enter');
  await c.locator('[data-field="subject"]').fill(subject);
  await c.locator('.editor').click();
  await page.keyboard.type(text);
  return c;
}

test('Undo in the notice brings a reply back in the reading pane as it was, and nothing goes', async () => {
  await item('Sanne de Vries').click();
  await expect(win.locator('.reader-subject')).toHaveText('Call on Thursday');
  await win.click('[data-reader="replyAll"]');
  const c = composer();
  await expect(c.locator('.editor')).toBeVisible();
  await c.locator('[data-field="subject"]').fill('Re: Call on Thursday, held');
  await c.locator('.editor').click();
  await win.keyboard.type('Thursday at ten works for me.');
  // The earlier mail is left out, and stays out.
  await c.locator('.quote-pill').click();
  await c.locator('[data-c="include"]').click();
  await c.locator('[data-c="send"]').click();
  await composerGone();
  await expect(notice()).toContainText('Sending email…');
  await expect(notice().locator('button')).toHaveText('Undo');
  expect((await notice().locator('button').boundingBox()).height).toBeGreaterThanOrEqual(24);
  expect(await waiting()).toBe(1);

  await notice().locator('button').click();
  await expect(c.locator('.editor')).toContainText('Thursday at ten works for me.');
  await expect(notice()).toContainText('Sending undone');
  await expect(c.locator('.composer-title')).toHaveText('Reply all');
  await expect(c.locator('[data-rfield="to"] .recipient')).toHaveText(['Sanne de Vries']);
  await expect(c.locator('[data-rfield="cc"] .recipient')).toHaveText(['Joris Bakker']);
  await expect(c.locator('[data-field="subject"]')).toHaveValue('Re: Call on Thursday, held');
  await expect(c.locator('.quote-pill')).toHaveText('··· excluded');
  // Back but not saved anywhere yet, so it counts as unsaved.
  await expect(c).toHaveAttribute('data-dirty', 'true');
  expect(await waiting()).toBe(0);
  expect(await subjects('sent')).not.toContain('Re: Call on Thursday, held');

  // Sent after all, it is still the reply: the email it answers is marked answered, and the Sent copy refers to it
  // without the earlier mail.
  await c.locator('[data-c="send"]').click();
  await composerGone();
  await sendWaiting();
  await expect(notice()).toContainText('Email sent');
  const sent = await app.evaluate(async () => {
    const engine = global.__semEngine;
    const id = engine.accounts[0].id;
    await engine.syncAccount(id);
    const original = engine.listMessages({ scope: id, view: 'inbox' }).find((m) => m.subject === 'Call on Thursday');
    const copy = engine.listMessages({ scope: id, view: 'sent' }).find((m) => m.subject === 'Re: Call on Thursday, held');
    const full = await engine.getMessage(copy.id);
    const source = await engine.getMessage(original.id);
    return { answered: original.answered, linked: full.inReplyTo === source.messageId, to: full.to.map((a) => a.address), cc: full.cc.map((a) => a.address), html: full.html };
  });
  expect(sent.answered).toBe(true);
  expect(sent.linked).toBe(true);
  expect(sent.to).toEqual(['sanne@example.com']);
  expect(sent.cc).toEqual(['joris@example.com']);
  expect(sent.html).toContain('Thursday at ten works for me.');
  expect(sent.html).not.toContain('Shall we have a call on Thursday');
});

test('a held email keeps its draft until it goes, and Ctrl+Z takes it back too', async () => {
  const c = await newMessage(win, { to: 'demo@example.com', subject: 'Held, then sent', text: 'On its way after the notice.' });
  await win.keyboard.press('Control+s');
  await expect(c).toHaveAttribute('data-dirty', 'false');
  await c.locator('[data-c="send"]').click();
  await composerGone();
  await expect(notice()).toContainText('Sending email…');
  expect(await subjects('drafts')).toContain('Held, then sent');

  // The keyboard path to the notice's Undo.
  await win.keyboard.press('Control+z');
  await expect(c.locator('[data-field="subject"]')).toHaveValue('Held, then sent');
  await expect(c.locator('.editor')).toContainText('On its way after the notice.');
  await expect(c.locator('[data-rfield="to"] .recipient')).toHaveText(['demo@example.com']);
  expect(await waiting()).toBe(0);

  await c.locator('[data-c="send"]').click();
  await composerGone();
  await expect(notice()).toContainText('Sending email…');
  expect(await subjects('drafts')).toContain('Held, then sent');
  expect(await subjects('sent')).not.toContain('Held, then sent');
  await sendWaiting();
  await expect(notice()).toContainText('Email sent');
  await expect(notice().locator('button')).toHaveCount(0);
  expect(await subjects('sent')).toContain('Held, then sent');
  expect(await subjects('drafts')).not.toContain('Held, then sent');
  await expect(item('Held, then sent')).toBeVisible({ timeout: 10000 });
});

test('an email from a compose window comes back in a new compose window, with its attachment', async () => {
  await item('Sanne de Vries').click();
  await expect(win.locator('.att-name')).toHaveText('Proposal-v3.pdf');
  await win.click('[data-reader="forward"]');
  await expect(composer().locator('.editor')).toBeVisible();
  const [popped] = await Promise.all([app.waitForEvent('window'), composer().locator('[data-c="popout"]').click()]);
  await popped.waitForSelector('.composer .editor');
  await popped.fill('[data-rinput="to"]', 'demo@example.com');
  await popped.press('[data-rinput="to"]', 'Enter');
  await popped.click('.editor');
  await popped.keyboard.type('Here is the proposal.');
  await Promise.all([popped.waitForEvent('close'), popped.click('[data-c="send"]')]);

  // The notice is in the main window, which also gets the editor back in a window of its own.
  await expect(notice()).toContainText('Sending email…');
  const [again] = await Promise.all([app.waitForEvent('window'), notice().locator('button').click()]);
  await again.waitForSelector('.composer .editor');
  await expect(again.locator('.editor')).toContainText('Here is the proposal.');
  await expect(again.locator('[data-rfield="to"] .recipient')).toHaveText(['demo@example.com']);
  await expect(again.locator('[data-field="subject"]')).toHaveValue('Fwd: Call on Thursday');
  await expect(again.locator('.compose-attachments')).toContainText('Proposal-v3.pdf');
  await expect(composer()).toHaveCount(0);
  expect(await waiting()).toBe(0);

  await Promise.all([again.waitForEvent('close'), again.click('[data-c="send"]')]);
  await sendWaiting();
  await expect(notice()).toContainText('Email sent');
  await expect(item('Fwd: Call on Thursday')).toBeVisible({ timeout: 10000 });
  await item('Fwd: Call on Thursday').click();
  await expect(win.locator('.att-name')).toHaveText('Proposal-v3.pdf');
});

test('Settings > General > Undo send offers Off to 30 seconds in English and Dutch, and Off sends at once', async () => {
  await win.click('[data-action="settings"]');
  const row = win.locator('[data-a="undo-send"]');
  await expect(row.locator('.title')).toHaveText('Undo send');
  await expect(row.locator('.value')).toHaveText('30 seconds');
  await row.click();
  await expect(win.locator('.radio-row')).toHaveText(['Off', '5 seconds', '10 seconds', '20 seconds', '30 seconds']);
  await win.click('.radio-row:has-text("Off")');
  await expect(row.locator('.value')).toHaveText('Off');
  expect(await app.evaluate(() => global.__semEngine.settings.undoSend)).toBe(0);

  await win.click('[data-a="language"]');
  await win.click('.radio-row:has-text("Nederlands")');
  await expect(row.locator('.title')).toHaveText('Verzenden ongedaan maken');
  await expect(row.locator('.value')).toHaveText('Uit');
  await row.click();
  await expect(win.locator('.radio-row')).toHaveText(['Uit', '5 seconden', '10 seconden', '20 seconden', '30 seconden']);
  await win.keyboard.press('Escape');
  await win.click('[data-a="back"]');

  await newMessage(win, { to: 'demo@example.com', subject: 'Straight out', text: 'No waiting.' });
  await composer().locator('[data-c="send"]').click();
  await composerGone();
  await expect(notice()).toContainText('E-mail verzonden');
  await expect(notice().locator('button')).toHaveCount(0);
  expect(await waiting()).toBe(0);
  expect(await subjects('sent')).toContain('Straight out');
});

test('quitting with an email that waits sends it before Rukoo exits, also when a second quit comes meanwhile', async () => {
  await newMessage(win, { to: 'demo@example.com', subject: 'Sent while quitting', text: 'Out before the exit.' });
  await composer().locator('[data-c="send"]').click();
  await composerGone();
  await expect(notice()).toContainText('Sending email…');
  expect(await waiting()).toBe(1);

  // The send holds until the test lets it go, so the second quit (Quit again in the tray) comes while it runs.
  await app.evaluate(() => {
    const engine = global.__semEngine;
    const send = engine.send.bind(engine);
    engine.send = async (...args) => {
      await new Promise((resolve) => (global.__releaseSend = resolve));
      return send(...args);
    };
  });
  const exited = app.waitForEvent('close');
  await app.evaluate(({ app }) => {
    app.quit();
  });
  await expect.poll(() => app.evaluate(() => typeof global.__releaseSend)).toBe('function');
  await app.evaluate(({ app }) => {
    app.quit();
  });
  expect(await waiting()).toBe(1);
  await app.evaluate(() => global.__releaseSend()).catch(() => {});
  await exited;
  await launch();
  await expect(win.locator('.item').first()).toBeVisible({ timeout: 15000 });
  await expect(item('Sent while quitting')).toBeVisible({ timeout: 10000 });
  await win.click('[data-view="sent"]');
  await expect(item('Sent while quitting')).toBeVisible();
});

test('an email a quit can neither send nor keep in Drafts opens again at the next start', async () => {
  await app.evaluate(() => {
    const engine = global.__semEngine;
    engine.send = async () => {
      throw new Error('Mailbox full');
    };
    engine.saveDraft = async () => {
      throw new Error('No connection');
    };
  });
  await newMessage(win, { to: 'someone@example.com', subject: 'Not lost on quit', text: 'Still here after the restart.' });
  await composer().locator('[data-c="send"]').click();
  await composerGone();
  await expect(notice()).toContainText('Sending email…');

  await closeApp(app);
  expect(fs.existsSync(path.join(dataDir, 'data', 'unsent.json'))).toBe(true);
  await launch();
  await expect.poll(() => app.windows().length, { timeout: 15000 }).toBe(2);
  const again = app.windows().find((w) => w !== win);
  await again.waitForSelector('.composer .editor');
  await expect(again.locator('.dialog')).toContainText("couldn't send this email while it was quitting");
  await expect(again.locator('.dialog')).toContainText('Mailbox full');
  await again.locator('.dialog .buttons button').click();
  await expect(again.locator('[data-field="subject"]')).toHaveValue('Not lost on quit');
  await expect(again.locator('.editor')).toContainText('Still here after the restart.');
  await expect(again.locator('[data-rfield="to"] .recipient')).toHaveText(['someone@example.com']);
  expect(fs.existsSync(path.join(dataDir, 'data', 'unsent.json'))).toBe(false);
});

test('an email that fails while a quit waits for an answer opens again when the quit is called off', async () => {
  await app.evaluate(() => {
    const engine = global.__semEngine;
    engine.send = async () => {
      throw new Error('Mailbox full');
    };
    engine.saveDraft = async () => {
      throw new Error('No connection');
    };
  });
  await newMessage(win, { to: 'someone@example.com', subject: 'Failed during a quit', text: 'Back after Cancel.' });
  await composer().locator('[data-c="send"]').click();
  await composerGone();
  // An editor with unsaved text holds the quit with its question. That comes from beforeunload, which Electron
  // answers by keeping the window; with a listener of its own, Playwright doesn't try to answer it too.
  await newMessage(win, { to: 'other@example.com', subject: 'Half written', text: 'Unsaved.' });
  win.on('dialog', () => {});
  await app.evaluate(({ app }) => {
    app.quit();
  });
  await expect(win.locator('.scrim')).toContainText('Save draft?');
  await sendWaiting();

  const [again] = await Promise.all([app.waitForEvent('window'), win.click('.scrim .buttons button:text-is("Cancel")')]);
  await again.waitForSelector('.composer .editor');
  await expect(again.locator('.dialog')).toContainText("couldn't send this email while it was quitting");
  await expect(again.locator('.dialog')).toContainText('Mailbox full');
  await again.locator('.dialog .buttons button').click();
  await expect(again.locator('[data-field="subject"]')).toHaveValue('Failed during a quit');
  await expect(again.locator('.editor')).toContainText('Back after Cancel.');
  await expect(composer().locator('[data-field="subject"]')).toHaveValue('Half written');
});

// The server refuses an email while a quit waits for another editor's answer, so it goes to Drafts, and the quit is
// called off before that save is done. ok: the save then stores the draft, or fails. The refused email opens again in
// the reading pane, which keeps the other editor's text as a draft.
async function refusedWhileQuitIsCalledOff(subject, text, ok) {
  await newMessage(win, { to: 'someone@example.com', subject, text });
  await composer().locator('[data-c="send"]').click();
  await composerGone();
  await app.evaluate((_e, subject) => {
    const engine = global.__semEngine;
    const saveDraft = engine.saveDraft.bind(engine);
    engine.send = async () => {
      throw new Error('Mailbox full');
    };
    // Only the quit's save of the refused email holds, until the test lets it go.
    engine.saveDraft = (payload) =>
      payload.subject === subject && !global.__settleSave
        ? new Promise((resolve, reject) => (global.__settleSave = (stored) => (stored ? resolve(saveDraft(payload)) : reject(new Error('No connection')))))
        : saveDraft(payload);
  }, subject);
  await newMessage(win, { to: 'other@example.com', subject: 'Half written', text: 'Unsaved.' });
  win.on('dialog', () => {});
  await app.evaluate(({ app }) => {
    app.quit();
  });
  await expect(win.locator('.scrim')).toContainText('Save draft?');
  await app.evaluate(() => {
    global.__semOutbox.flush();
  });
  await expect.poll(() => app.evaluate(() => typeof global.__settleSave)).toBe('function');
  await win.click('.scrim .buttons button:text-is("Cancel")');
  await expect(win.locator('.scrim')).toHaveCount(0);
  // A call from the window reaches main after the window's answer to the quit, so the quit is called off by now.
  await win.evaluate(() => window.mail.call('state'));
  await app.evaluate((_e, ok) => global.__settleSave(ok), ok);

  const dialog = win.locator('.dialog');
  await expect(dialog.locator('h2')).toHaveText('Sending failed');
  await expect(dialog).toContainText('Mailbox full');
  await dialog.locator('.buttons button').click();
  await expect(composer().locator('[data-field="subject"]')).toHaveValue(subject);
  await expect(composer().locator('.editor')).toContainText(text);
  await expect(composer().locator('[data-rfield="to"] .recipient')).toHaveText(['someone@example.com']);
  expect(await waiting()).toBe(0);
  expect(await subjects('drafts')).toContain('Half written');
}

test('an email whose Drafts save fails after the quit is called off opens again with its error', async () => {
  await refusedWhileQuitIsCalledOff('Called off, not saved', 'Nothing of this is lost.', false);
  expect(await subjects('drafts')).not.toContain('Called off, not saved');
});

test('an email that reached Drafts after the quit is called off opens again on that draft, with its error', async () => {
  await refusedWhileQuitIsCalledOff('Called off, saved', 'Kept in Drafts as well.', true);
  expect((await subjects('drafts')).filter((s) => s === 'Called off, saved')).toHaveLength(1);
  // Its editor goes on with the stored draft instead of keeping a second one.
  await composer().locator('.editor').click();
  await win.keyboard.type(' Edited.');
  await win.keyboard.press('Control+s');
  await expect(composer()).toHaveAttribute('data-dirty', 'false');
  expect((await subjects('drafts')).filter((s) => s === 'Called off, saved')).toHaveLength(1);
});

// The main window had nothing to ask and closed during the quit, so calling the quit off in a compose window brings
// a new one back from the tray. The Drafts save of the refused email fails while that window still loads, before its
// page listens to main: the email waits in main until the page takes it.
test('an email refused while a new main window still loads opens there once it is up', async () => {
  const subject = 'Refused while the window loads';
  await win.evaluate(() => window.mail.call('updateSettings', { closeToTray: true }));
  await newMessage(win, { to: 'someone@example.com', subject, text: 'Waits for the new window.' });
  await composer().locator('[data-c="send"]').click();
  await composerGone();
  await expect(notice()).toContainText('Sending email…');
  await app.evaluate((_e, subject) => {
    const engine = global.__semEngine;
    const saveDraft = engine.saveDraft.bind(engine);
    engine.send = async () => {
      throw new Error('Mailbox full');
    };
    // Only the quit's save of the refused email holds, until the test lets it fail.
    engine.saveDraft = (payload) =>
      payload.subject === subject && !global.__failSave
        ? new Promise((_resolve, reject) => (global.__failSave = () => reject(new Error('No connection'))))
        : saveDraft(payload);
  }, subject);
  // A compose window with unsaved text holds the quit.
  const [popped] = await Promise.all([app.waitForEvent('window'), win.evaluate(() => window.mail.call('openCompose', { mode: 'new' }))]);
  popped.on('dialog', () => {});
  await popped.waitForSelector('.composer .editor');
  await popped.fill('[data-field="subject"]', 'Half written');
  await expect(popped.locator('.composer')).toHaveAttribute('data-dirty', 'true');
  const mainWindow = () =>
    app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().endsWith('index.html'));
      return w ? { visible: w.isVisible() } : null;
    });
  await app.evaluate(({ app }) => {
    app.quit();
  });
  await expect(popped.locator('.scrim')).toContainText('Save draft?');
  await expect.poll(mainWindow).toBeNull();
  await app.evaluate(() => {
    global.__semOutbox.flush();
  });
  await expect.poll(() => app.evaluate(() => typeof global.__failSave)).toBe('function');
  // The save fails right after Cancel makes the new main window, and the test notes how far that window had got.
  await app.evaluate(({ app }) => {
    app.once('browser-window-created', (_event, w) =>
      setImmediate(() => {
        global.__atFailure = { url: w.webContents.getURL(), loading: w.webContents.isLoading() };
        global.__failSave();
      })
    );
  });
  const [fresh] = await Promise.all([app.waitForEvent('window'), popped.click('.scrim .buttons button:text-is("Cancel")')]);
  win = fresh;
  win.on('dialog', () => {});
  await expect.poll(() => app.evaluate(() => global.__atFailure)).toMatchObject({ loading: true });
  expect((await app.evaluate(() => global.__atFailure)).url).not.toMatch(/index\.html$/);

  const dialog = win.locator('.dialog');
  await expect(dialog.locator('h2')).toHaveText('Sending failed', { timeout: 15000 });
  await expect(dialog).toContainText('Mailbox full');
  await dialog.locator('.buttons button').click();
  await expect(composer().locator('[data-field="subject"]')).toHaveValue(subject);
  await expect(composer().locator('.editor')).toContainText('Waits for the new window.');
  await expect(composer().locator('[data-rfield="to"] .recipient')).toHaveText(['someone@example.com']);
  // The main window came out of the tray for it, and the other editor still holds its text.
  expect(await mainWindow()).toEqual({ visible: true });
  await expect(popped.locator('[data-field="subject"]')).toHaveValue('Half written');
  // No compose window opened for it instead.
  expect(app.windows()).toHaveLength(2);
  expect(await waiting()).toBe(0);
  expect(fs.existsSync(path.join(dataDir, 'data', 'unsent.json'))).toBe(false);
});

test('Undo brings back every recipient and the whole subject, past the limits on what an agent hands in', async () => {
  const many = Array.from({ length: 101 }, (_, i) => `person${i}@example.com`);
  const subject = `A long subject ${'x'.repeat(986)}`;
  expect(subject).toHaveLength(1001);
  await win.click('[data-action="compose"]');
  const c = composer();
  // A pasted list becomes one recipient per address.
  await c.locator('[data-rinput="to"]').fill(many.join(', '));
  await expect(c.locator('[data-rfield="to"] .recipient')).toHaveCount(101);
  await c.locator('[data-field="subject"]').fill(subject);
  await c.locator('.editor').click();
  await win.keyboard.type('For all of you.');
  await c.locator('[data-c="send"]').click();
  await composerGone();
  await notice().locator('button').click();

  await expect(c.locator('.editor')).toContainText('For all of you.');
  await expect(c.locator('[data-field="subject"]')).toHaveValue(subject);
  await expect(c.locator('[data-rfield="to"] .recipient')).toHaveCount(101);
  expect(await c.locator('[data-rfield="to"] .recipient').evaluateAll((els) => els.map((el) => el.title))).toEqual(many);
  expect(await waiting()).toBe(0);
});

test('an older email that goes leaves the Undo of a newer one in place', async () => {
  await newMessage(win, { to: 'demo@example.com', subject: 'First of two', text: 'One.' });
  await composer().locator('[data-c="send"]').click();
  await composerGone();
  await newMessage(win, { to: 'demo@example.com', subject: 'Second of two', text: 'Two.' });
  await composer().locator('[data-c="send"]').click();
  await composerGone();
  await expect(notice().locator('button')).toHaveText('Undo');
  expect(await waiting()).toBe(2);

  // The first one's time is up; the second still waits.
  await app.evaluate(async () => {
    const box = global.__semOutbox;
    const first = box.left().find((e) => e.payload.subject === 'First of two');
    await box.go(box.entries.get(first.id));
  });
  // A call from the window returns after main's events before it, 'send-done' included, have reached the window.
  await win.evaluate(() => window.mail.call('state'));
  expect(await subjects('sent')).toContain('First of two');
  await expect(notice()).toContainText('Sending email…');
  await expect(notice().locator('button')).toHaveText('Undo');

  await notice().locator('button').click();
  await expect(composer().locator('[data-field="subject"]')).toHaveValue('Second of two');
  expect(await waiting()).toBe(0);
  expect(await subjects('sent')).not.toContain('Second of two');
});

test('an email the server refuses after the wait opens again with its text and the error', async () => {
  await app.evaluate(() => {
    global.__semEngine.send = async () => {
      throw new Error('Mailbox full');
    };
  });
  await newMessage(win, { to: 'someone@example.com', subject: 'Refused later', text: 'Keep every word of this.' });
  await composer().locator('[data-c="send"]').click();
  await composerGone();
  await expect(notice()).toContainText('Sending email…');
  await sendWaiting();
  const dialog = win.locator('.dialog');
  await expect(dialog.locator('h2')).toHaveText('Sending failed');
  await expect(dialog).toContainText('Mailbox full');
  // The notice of the email that failed is gone with it.
  await expect(notice()).not.toHaveClass(/show/);
  await dialog.locator('.buttons button').click();
  await expect(composer().locator('[data-field="subject"]')).toHaveValue('Refused later');
  await expect(composer().locator('.editor')).toContainText('Keep every word of this.');
  await expect(composer().locator('[data-rfield="to"] .recipient')).toHaveText(['someone@example.com']);
});

test('a refused email still comes back when the main window holds an editor that is busy asking', async () => {
  await app.evaluate(() => {
    global.__semEngine.send = async () => {
      throw new Error('Mailbox full');
    };
  });
  await newMessage(win, { to: 'someone@example.com', subject: 'Refused while busy', text: 'Still here.' });
  await composer().locator('[data-c="send"]').click();
  await composerGone();
  // Another editor with unsaved text, asking whether to keep it: the reading pane can't take the refused email.
  await newMessage(win, { to: 'other@example.com', subject: 'Half written', text: 'Unsaved.' });
  await win.keyboard.press('Escape');
  await expect(win.locator('.scrim .dialog')).toBeVisible();
  const [popped] = await Promise.all([app.waitForEvent('window'), sendWaiting()]);
  await popped.waitForSelector('.composer .editor');
  await expect(popped.locator('.dialog')).toContainText('Mailbox full');
  await popped.locator('.dialog .buttons button').click();
  await expect(popped.locator('[data-field="subject"]')).toHaveValue('Refused while busy');
  await expect(popped.locator('.editor')).toContainText('Still here.');
  await expect(composer().locator('[data-field="subject"]')).toHaveValue('Half written');
});

test('Undo once the email is on its way says it is too late', async () => {
  await app.evaluate(() => {
    const engine = global.__semEngine;
    const send = engine.send.bind(engine);
    engine.send = async (...args) => {
      await new Promise((resolve) => (global.__releaseSend = resolve));
      return send(...args);
    };
  });
  await newMessage(win, { to: 'demo@example.com', subject: 'Too late', text: 'Already going.' });
  await composer().locator('[data-c="send"]').click();
  await composerGone();
  await expect(notice().locator('button')).toHaveText('Undo');
  // The wait is over and the send has started; it holds until released.
  await app.evaluate(() => {
    global.__semOutbox.flush();
  });
  await expect.poll(() => app.evaluate(() => typeof global.__releaseSend)).toBe('function');
  await notice().locator('button').click();
  await expect(notice()).toContainText('Too late to undo');
  await expect(composer()).toHaveCount(0);
  await app.evaluate(() => global.__releaseSend());
  await expect(notice()).toContainText('Email sent');
  expect(await subjects('sent')).toContain('Too late');
});
