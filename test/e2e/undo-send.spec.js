// Undo send (#104): Send holds the email for the time in Settings > General > Undo send, the main window's notice
// takes it back, and its editor opens again with everything in it. Test runs send at once unless SEM_UNDO_SEND=1
// (main.js undoSendDelay), so this file turns it on. No test waits out a notice: they take the email back, or send
// it now through the outbox's flush(), which is what a quit does.
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { tempDir, removeDir } = require('../tmp');
const { closeApp, kill } = require('./close');

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
  // A test that stopped halfway may still answer Don't quit, which would keep the instance from closing.
  await app
    .evaluate(() => {
      global.__semQuitAnswer = 0;
    })
    .catch(() => {});
  await closeApp(app);
  removeDir(dataDir);
});

const item = (text) => win.locator('.item', { hasText: text }).first();
const notice = () => win.locator('#toast');
const composer = () => win.locator('.composer');
const composerGone = () => expect(composer()).toHaveCount(0, { timeout: 10000 });
const waiting = () => app.evaluate(() => global.__semOutbox.size);
const sendWaiting = () => app.evaluate(() => global.__semOutbox.flush());
// Refused emails main holds for the main window until their editors are open (main.js refused).
const held = () => app.evaluate(() => global.__semRefused.size);
// What held.json in the profile lists (main.js heldMail): the emails in the outbox and the kept ones, by subject.
const heldFile = () => path.join(dataDir, 'data', 'held.json');
// The emails in it, without the ids it took from an older Rukoo's unsent.json. Read once: Rukoo removes the file when
// the last email goes, also between a check that it exists and the read.
const readHeld = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
};
const onDisk = () => readHeld(heldFile()).filter((e) => e.restore);
const kept = () => onDisk().map((e) => e.restore.state.subject);
// Ends Rukoo at once, without a quit, as a crash or Task Manager would.
async function crash() {
  const exited = app.waitForEvent('close');
  kill(app.process());
  await exited;
}
// The compose windows that open at a start, by subject, each once its editor is up. Saves fail until the test lets
// them (global.__allowSaves), so no autosave (8 s) settles an email before the test looks.
async function editorsAfterStart(count) {
  await app.evaluate(() => {
    const engine = global.__semEngine;
    const save = engine.saveDraft.bind(engine);
    engine.saveDraft = (payload) => (global.__allowSaves ? save(payload) : Promise.reject(new Error('No connection')));
  });
  await expect.poll(() => app.windows().length, { timeout: 15000 }).toBe(count + 1);
  const editors = app.windows().filter((w) => w !== win);
  const bySubject = {};
  for (const w of editors) {
    w.on('dialog', () => {});
    await w.waitForSelector('.composer .editor');
    bySubject[await w.locator('[data-field="subject"]').inputValue()] = w;
  }
  expect(Object.keys(bySubject)).toHaveLength(count);
  return bySubject;
}
// Nothing opens at a start: only the main window, a while after its list is up.
async function nothingReopens() {
  await expect(win.locator('.item').first()).toBeVisible({ timeout: 15000 });
  await win.waitForTimeout(2000);
  expect(app.windows()).toHaveLength(1);
}
// How often a quit asked about waiting email (main.js askQuitWithHeldMail), and how many emails' clocks stand still.
const quitQuestions = () => app.evaluate(() => global.__semQuitAsked || 0);
const paused = () => app.evaluate(() => [...global.__semOutbox.entries.values()].filter((e) => e.left !== undefined).length);
// The main window as main sees it, or null while there is none.
const mainWindow = () =>
  app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().endsWith('index.html'));
    return w ? { visible: w.isVisible() } : null;
  });
// What the main window's close button does: hide it in the tray with Close to the tray on, otherwise close it.
const closeMain = () =>
  app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().endsWith('index.html')).close());
// The background services a quit stops only once it can't be called off any more (main.js closeServices): the reminder
// runner's clock, and the mail notifications listening to the categories.
const services = () =>
  app.evaluate(() => ({
    closed: Boolean(global.__semServicesClosed),
    reminders: global.__semReminders.timer !== null,
    notices: global.__semCategories.listeners('sorted').includes(global.__semMailNotices.answered)
  }));
const RUNNING = { closed: false, reminders: true, notices: true };
// The subjects in a view of the demo account, after a sync.
const subjects = (view) =>
  app.evaluate(async (_e, view) => {
    const engine = global.__semEngine;
    const id = engine.accounts[0].id;
    await engine.syncAccount(id);
    return engine.listMessages({ scope: id, view }).map((m) => m.subject);
  }, view);

// Clicks a control that closes its own window, such as Send in a compose window, and waits for the close. Send can
// close the window before Playwright's click call returns; the click then fails with "Target page, context or browser
// has been closed" although Send ran (#313). The close event is the check, so only that failure is let through.
async function clickClosing(page, selector) {
  const closed = page.waitForEvent('close');
  closed.catch(() => {});
  try {
    await page.click(selector);
  } catch (err) {
    if (!page.isClosed() && !/has been closed/.test(err.message)) throw err;
  }
  await closed;
}

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
  await clickClosing(popped, '[data-c="send"]');

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

  await clickClosing(again, '[data-c="send"]');
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

test("quitting with an email that waits asks first, and Don't quit keeps it waiting for Undo", async () => {
  await newMessage(win, { to: 'demo@example.com', subject: 'Kept by the question', text: 'Still undoable.' });
  await composer().locator('[data-c="send"]').click();
  await composerGone();
  await expect(notice()).toContainText('Sending email…');
  expect(await waiting()).toBe(1);
  // Don't quit: Rukoo stays, the email still waits, and Undo still brings it back.
  await app.evaluate(({ app }) => {
    global.__semQuitAnswer = 1;
    app.quit();
  });
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBeGreaterThan(0);
  expect(await waiting()).toBe(1);
  await notice().locator('button').click();
  await expect(composer().locator('[data-field="subject"]')).toHaveValue('Kept by the question');
  expect(await waiting()).toBe(0);
  expect(await subjects('sent')).not.toContain('Kept by the question');
  await app.evaluate(() => {
    global.__semQuitAnswer = 0;
  });
});

// The main window waited in the tray when Quit in the tray menu asked. Don't quit brings it back, so the Undo notice
// is in view while the email waits.
test("Don't quit brings the main window back from the tray with the Undo notice", async () => {
  await win.evaluate(() => window.mail.call('updateSettings', { closeToTray: true }));
  await newMessage(win, { to: 'demo@example.com', subject: 'Back from the tray', text: 'Still undoable.' });
  await composer().locator('[data-c="send"]').click();
  await composerGone();
  await expect(notice()).toContainText('Sending email…');
  await closeMain();
  await expect.poll(mainWindow).toEqual({ visible: false });
  await app.evaluate(() => {
    global.__semQuitAnswer = 1;
    global.__semTray.menu.getMenuItemById('quit').click();
  });
  await expect.poll(mainWindow).toEqual({ visible: true });
  // The email's clock runs again, with its notice in the window.
  await expect.poll(paused).toBe(0);
  await expect(notice()).toContainText('Sending email…');
  expect(await waiting()).toBe(1);
  expect(await quitQuestions()).toBe(1);
  await notice().locator('button').click();
  await expect(composer().locator('[data-field="subject"]')).toHaveValue('Back from the tray');
  expect(await waiting()).toBe(0);
  expect(await subjects('sent')).not.toContain('Back from the tray');
});

// Without the tray, closing the last window quits, and Don't quit makes a new main window. Here that window starts
// loading its page 7 seconds late, longer than the 5 seconds Undo gets after the question: the email waits all the
// same, until the window can show its notice.
test("Don't quit after the last window closed keeps the email until the new main window offers Undo", async () => {
  test.skip(process.platform === 'darwin', 'closing the last window does not quit on macOS');
  const subject = 'Waits for the new window';
  // Close to the tray is on by default on Windows; this case is about closing the last window without it.
  await win.evaluate(() => window.mail.call('updateSettings', { closeToTray: false }));
  // 5 seconds, less than the new window's 7-second load: clocks that ran on during the load would send the email
  // before the window could offer Undo.
  await app.evaluate(() => (global.__semEngine.settings.undoSend = 5));
  await newMessage(win, { to: 'demo@example.com', subject, text: 'Still undoable.' });
  await composer().locator('[data-c="send"]').click();
  await composerGone();
  await expect(notice()).toContainText('Sending email…');
  await app.evaluate(({ app }) => {
    global.__semQuitAnswer = 1;
    // Only the new main window's page loads late; any other window made meanwhile loads as usual.
    const delay = (_event, w) => {
      const load = w.loadFile.bind(w);
      w.loadFile = (file, ...rest) => {
        if (!String(file).endsWith('index.html')) return load(file, ...rest);
        app.removeListener('browser-window-created', delay);
        return new Promise((resolve, reject) => setTimeout(() => load(file, ...rest).then(resolve, reject), 7000));
      };
    };
    app.on('browser-window-created', delay);
  });
  // Playwright reports the new window once its page has loaded, so the check during the load comes first.
  const fresh = app.waitForEvent('window', { timeout: 20000 });
  await closeMain();
  // Past the 5 seconds, with the page still loading: the email waits, its clock stopped.
  await new Promise((resolve) => setTimeout(resolve, 6000));
  const held = () =>
    app.evaluate(() => [...global.__semOutbox.entries.values()].map((e) => ({ state: e.state, paused: e.left !== undefined })));
  expect(await held()).toEqual([{ state: 'waiting', paused: true }]);
  win = await fresh;
  await expect(notice()).toContainText('Sending email…', { timeout: 20000 });
  expect(await waiting()).toBe(1);
  expect(await subjects('sent')).not.toContain(subject);
  expect(await mainWindow()).toEqual({ visible: true });
  expect(await quitQuestions()).toBe(1);
  await notice().locator('button').click();
  await expect(composer().locator('[data-field="subject"]')).toHaveValue(subject);
  expect(await waiting()).toBe(0);
  expect(await subjects('sent')).not.toContain(subject);
});

// A quit comes while Send waits for the editor's Drafts save. The editor holds that quit, queues the email once the
// save is done and lets the quit go on, which then asks about the email. Don't quit calls that earlier quit off too:
// a refused email opens again with its error, as it does without a quit, instead of going quietly to Drafts.
test("Don't quit also calls off a quit an editor held while its Send waited for the Drafts save", async () => {
  const subject = 'Sent while a quit waited';
  await app.evaluate((_e, subject) => {
    const engine = global.__semEngine;
    const saveDraft = engine.saveDraft.bind(engine);
    global.__saves = [];
    engine.saveDraft = (payload) =>
      payload.subject === subject ? new Promise((resolve, reject) => global.__saves.push(() => saveDraft(payload).then(resolve, reject))) : saveDraft(payload);
  }, subject);
  const c = await newMessage(win, { to: 'someone@example.com', subject, text: 'Queued while the quit waits.' });
  await win.keyboard.press('Control+s');
  await expect.poll(() => app.evaluate(() => global.__saves.length)).toBeGreaterThan(0);
  await c.locator('[data-c="send"]').click();
  win.on('dialog', () => {});
  await app.evaluate(({ app, BrowserWindow }) => {
    global.__semQuitAnswer = 1;
    global.__quits = 0;
    app.on('before-quit', () => (global.__quits += 1));
    const main = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('index.html'));
    main.webContents.once('will-prevent-unload', () => (global.__quitHeld = true));
    app.quit();
  });
  await expect.poll(() => app.evaluate(() => global.__quitHeld === true)).toBe(true);
  // The held save goes on, and later saves go at once.
  await app.evaluate(() => {
    delete global.__semEngine.saveDraft;
    global.__saves.splice(0).forEach((go) => go());
  });
  await composerGone();
  // The editor let the quit go on, and that asked about the email.
  await expect.poll(() => app.evaluate(() => global.__quits)).toBe(2);
  await expect(notice()).toContainText('Sending email…');
  expect(await waiting()).toBe(1);
  expect(await mainWindow()).toEqual({ visible: true });

  await app.evaluate(() => {
    global.__semEngine.send = async () => {
      throw new Error('Mailbox full');
    };
  });
  await sendWaiting();
  const dialog = win.locator('.dialog');
  await expect(dialog.locator('h2')).toHaveText('Sending failed');
  await expect(dialog).toContainText('Mailbox full');
  await dialog.locator('.buttons button').click();
  await expect(composer().locator('[data-field="subject"]')).toHaveValue(subject);
  await expect(composer().locator('.editor')).toContainText('Queued while the quit waits.');
  expect(await held()).toBe(0);
  expect(await quitQuestions()).toBe(1);
  // The first before-quit ran in full, before the editor held it; Don't quit leaves Rukoo running with its services.
  expect(await services()).toEqual(RUNNING);
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
  expect(kept()).toEqual(['Not lost on quit']);
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
  // Kept until its editor answers for it, so a crash now brings it back once more.
  expect(kept()).toEqual(['Not lost on quit']);
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
  // Kept at once, for a quit that goes through; the next start would open it.
  await expect.poll(kept).toEqual(['Failed during a quit']);

  const [again] = await Promise.all([app.waitForEvent('window'), win.click('.scrim .buttons button:text-is("Cancel")')]);
  await again.waitForSelector('.composer .editor');
  // Open again now, and still kept, once, until its editor answers for it.
  expect(kept()).toEqual(['Failed during a quit']);
  await expect(again.locator('.dialog')).toContainText("couldn't send this email while it was quitting");
  await expect(again.locator('.dialog')).toContainText('Mailbox full');
  await again.locator('.dialog .buttons button').click();
  await expect(again.locator('[data-field="subject"]')).toHaveValue('Failed during a quit');
  await expect(again.locator('.editor')).toContainText('Back after Cancel.');
  await expect(composer().locator('[data-field="subject"]')).toHaveValue('Half written');
});

// before-quit runs in full before an editor asks about its changes. Cancel there keeps Rukoo running, so it must keep
// its account service, categories, mail notifications, reminders and booking too; only will-quit stops them.
test('a quit called off in an editor leaves the background services running, and the next quit stops them', async () => {
  expect(await services()).toEqual(RUNNING);
  await newMessage(win, { to: 'other@example.com', subject: 'Half written', text: 'Unsaved.' });
  win.on('dialog', () => {});
  await app.evaluate(({ app }) => {
    global.__quits = 0;
    app.on('before-quit', () => (global.__quits += 1));
    app.quit();
  });
  await expect(win.locator('.scrim')).toContainText('Save draft?');
  expect(await app.evaluate(() => global.__quits)).toBe(1);
  await win.click('.scrim .buttons button:text-is("Cancel")');
  await expect(win.locator('.scrim')).toHaveCount(0);
  await expect(composer().locator('[data-field="subject"]')).toHaveValue('Half written');
  expect(await services()).toEqual(RUNNING);

  // A quit that goes through stops them once every window has closed. Rukoo then exits, so the test listens in main.
  await app.evaluate(({ app }) => {
    app.on('will-quit', () => {
      const fs = process.mainModule.require('fs');
      const path = process.mainModule.require('path');
      const out = { closed: Boolean(global.__semServicesClosed), reminders: global.__semReminders.timer !== null };
      fs.writeFileSync(path.join(app.getPath('userData'), 'services-at-exit.json'), JSON.stringify(out));
    });
  });
  await closeApp(app);
  expect(JSON.parse(fs.readFileSync(path.join(dataDir, 'services-at-exit.json'), 'utf8'))).toEqual({ closed: true, reminders: false });
});

// #256: Rukoo ends without a quit while emails wait out their notice: a crash, a killed process. held.json follows
// the outbox, and the next start opens each email in a compose window, unsent, with a note that says what happened.
test('emails that wait when Rukoo is killed open again at the next start, unsent, with a note', async () => {
  const file = path.join(dataDir, 'data', 'held.json');
  const kept = () => JSON.parse(fs.readFileSync(file, 'utf8')).map((e) => [e.state, e.restore.state.subject]);
  // The first is on its way when Rukoo dies, so nobody knows whether it went; the second still waits.
  await app.evaluate(() => {
    global.__semEngine.send = () => new Promise(() => {});
  });
  await newMessage(win, { to: 'someone@example.com', subject: 'On its way', text: 'Maybe sent.' });
  await composer().locator('[data-c="send"]').click();
  await composerGone();
  await expect(notice()).toContainText('Sending email…');
  expect(kept()).toEqual([['waiting', 'On its way']]);
  // On its way now; its send never ends, so the call doesn't wait for it.
  await app.evaluate(() => {
    global.__semOutbox.go([...global.__semOutbox.entries.values()][0]);
  });
  await newMessage(win, { to: 'someone@example.com', subject: 'Kept through a crash', text: 'Still here after the crash.' });
  await composer().locator('[data-c="send"]').click();
  await composerGone();
  expect(kept()).toEqual([
    ['sending', 'On its way'],
    ['waiting', 'Kept through a crash']
  ]);

  const exited = app.waitForEvent('close');
  kill(app.process());
  await exited;
  expect(fs.existsSync(file)).toBe(true);
  await launch();
  // Drafts can't be saved until the test says so, so no autosave (8 s) settles an email before the test looks.
  await app.evaluate(() => {
    const engine = global.__semEngine;
    const save = engine.saveDraft.bind(engine);
    engine.saveDraft = (payload) => (global.__allowSaves ? save(payload) : Promise.reject(new Error('No connection')));
  });
  await expect.poll(() => app.windows().length, { timeout: 15000 }).toBe(3);
  const editors = app.windows().filter((w) => w !== win);
  for (const w of editors) await w.waitForSelector('.composer .editor');
  const bySubject = async (subject) => {
    for (const w of editors) if ((await w.locator('[data-field="subject"]').inputValue()) === subject) return w;
    return null;
  };
  const waited = await bySubject('Kept through a crash');
  await expect(waited.locator('.dialog')).toContainText("Rukoo closed before this email was sent. Send it again when it's ready.");
  await waited.locator('.dialog .buttons button').click();
  await expect(waited.locator('.editor')).toContainText('Still here after the crash.');
  await expect(waited.locator('[data-rfield="to"] .recipient')).toHaveText(['someone@example.com']);
  const going = await bySubject('On its way');
  await expect(going.locator('.dialog')).toContainText('Check Sent before you send it again.');
  await going.locator('.dialog .buttons button').click();
  await expect(going.locator('.editor')).toContainText('Maybe sent.');
  // Opened, and sent by nobody: nothing waits or reached Sent. While their editors are only open, nothing else holds
  // them, so the profile keeps both.
  expect(await waiting()).toBe(0);
  const sent = await subjects('sent');
  expect(sent).not.toContain('Kept through a crash');
  expect(sent).not.toContain('On its way');
  expect(kept()).toEqual([
    ['sending', 'On its way'],
    ['waiting', 'Kept through a crash']
  ]);
  const ids = () => JSON.parse(fs.readFileSync(file, 'utf8')).map((e) => e.id);
  const [goingId, waitedId] = ids();

  // Sent again, it waits in the outbox under a new id, and its old record went in the same step. Undo takes it back.
  await Promise.all([waited.waitForEvent('close'), waited.click('[data-c="send"]')]);
  await expect(notice()).toContainText('Sending email…');
  expect(kept()).toEqual([
    ['sending', 'On its way'],
    ['waiting', 'Kept through a crash']
  ]);
  expect(ids()[0]).toBe(goingId);
  expect(ids()[1]).not.toBe(waitedId);
  await Promise.all([app.waitForEvent('window'), notice().locator('button').click()]);
  expect(kept()).toEqual([['sending', 'On its way']]);
  // Saved to Drafts, the other one is safe there, and the file goes.
  await app.evaluate(() => (global.__allowSaves = true));
  await going.locator('.editor').click();
  await going.keyboard.press('Control+s');
  await expect.poll(() => fs.existsSync(file)).toBe(false);
  expect(await subjects('drafts')).toContain('On its way');
});

// Mira on #306: an email reopened after a crash is in its editor's memory only until it is saved, sent or answered for.
// Another crash before that brings it back once more; after a save or a Send it doesn't come back.
test('an email reopened after a crash comes back after another crash, until its editor saves or sends it', async () => {
  test.setTimeout(120000);
  const file = path.join(dataDir, 'data', 'held.json');
  const kept = () => readHeld(file).map((e) => e.restore.state.subject);
  const crash = async () => {
    const exited = app.waitForEvent('close');
    kill(app.process());
    await exited;
  };
  const editorsAfterStart = async (count) => {
    await expect.poll(() => app.windows().length, { timeout: 15000 }).toBe(count + 1);
    const editors = app.windows().filter((w) => w !== win);
    for (const w of editors) await w.waitForSelector('.composer .editor');
    const bySubject = {};
    for (const w of editors) bySubject[await w.locator('[data-field="subject"]').inputValue()] = w;
    return bySubject;
  };
  await newMessage(win, { to: 'someone@example.com', subject: 'Saved after two crashes', text: 'To Drafts in the end.' });
  await composer().locator('[data-c="send"]').click();
  await composerGone();
  await newMessage(win, { to: 'someone@example.com', subject: 'Sent after two crashes', text: 'Out in the end.' });
  await composer().locator('[data-c="send"]').click();
  await composerGone();
  expect(kept()).toEqual(['Saved after two crashes', 'Sent after two crashes']);
  await crash();

  // Reopened, and nothing saves: the editors hold the emails in memory only, and Rukoo dies again.
  await launch();
  await app.evaluate(() => {
    global.__semEngine.saveDraft = () => new Promise(() => {});
  });
  const first = await editorsAfterStart(2);
  await expect(first['Saved after two crashes'].locator('.editor')).toContainText('To Drafts in the end.');
  expect(kept()).toEqual(['Saved after two crashes', 'Sent after two crashes']);
  await crash();

  // Both come back, once each. The one that is sent in the end can't be saved, so its autosave (8 s) can't settle it
  // first.
  await launch();
  await app.evaluate(() => {
    const engine = global.__semEngine;
    const save = engine.saveDraft.bind(engine);
    engine.saveDraft = (payload) => (payload.subject === 'Sent after two crashes' ? Promise.reject(new Error('No connection')) : save(payload));
  });
  const second = await editorsAfterStart(2);
  expect(kept()).toEqual(['Saved after two crashes', 'Sent after two crashes']);
  const saved = second['Saved after two crashes'];
  await expect(saved.locator('.dialog')).toContainText('Rukoo closed before this email was sent.');
  await saved.locator('.dialog .buttons button').click();
  await expect(saved.locator('.editor')).toContainText('To Drafts in the end.');
  await saved.locator('.editor').click();
  await saved.keyboard.press('Control+s');
  await expect.poll(kept).toEqual(['Sent after two crashes']);
  const out = second['Sent after two crashes'];
  await out.locator('.dialog .buttons button').click();
  await expect(out.locator('.editor')).toContainText('Out in the end.');
  await Promise.all([out.waitForEvent('close'), out.click('[data-c="send"]')]);
  await expect(notice()).toContainText('Sending email…');
  await sendWaiting();
  await expect(notice()).toContainText('Email sent');
  expect(kept()).toEqual([]);
  expect(await subjects('drafts')).toContain('Saved after two crashes');
  expect(await subjects('sent')).toContain('Sent after two crashes');

  // A third crash brings neither back.
  await crash();
  await launch();
  await expect(win.locator('.item').first()).toBeVisible({ timeout: 15000 });
  await win.waitForTimeout(2000);
  expect(app.windows()).toHaveLength(1);
});

// Windows ends the session while one email hangs on its way and another is refused and can't go to Drafts either. The
// session end waits for the hanging one, so the refused one is written down at once: Windows may end Rukoo first.
test('an email refused while the session ends is written down at once, though another is still on its way', async () => {
  await app.evaluate(() => {
    const engine = global.__semEngine;
    engine.send = (payload) => (payload.subject === 'Refused at the end' ? Promise.reject(new Error('Mailbox full')) : new Promise(() => {}));
    engine.saveDraft = async () => {
      throw new Error('No connection');
    };
  });
  await newMessage(win, { to: 'someone@example.com', subject: 'Hanging at the end', text: 'Never answered.' });
  await composer().locator('[data-c="send"]').click();
  await composerGone();
  await newMessage(win, { to: 'someone@example.com', subject: 'Refused at the end', text: 'Refused, every word.' });
  await composer().locator('[data-c="send"]').click();
  await composerGone();
  expect(await waiting()).toBe(2);

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].emit('session-end'));
  // The refused one is kept with its error the moment it is refused, ahead of the one still on its way.
  await expect.poll(kept).toEqual(['Refused at the end', 'Hanging at the end']);
  expect(onDisk()[0].error).toContain('Mailbox full');

  const exited = app.waitForEvent('close');
  kill(app.process());
  await exited;
  await launch();
  // No autosave settles the hanging one before the test looks.
  await app.evaluate(() => {
    global.__semEngine.saveDraft = () => Promise.reject(new Error('No connection'));
  });
  await expect.poll(() => app.windows().length, { timeout: 15000 }).toBe(3);
  const editors = app.windows().filter((w) => w !== win);
  for (const w of editors) await w.waitForSelector('.composer .editor');
  const bySubject = async (subject) => {
    for (const w of editors) if ((await w.locator('[data-field="subject"]').inputValue()) === subject) return w;
    return null;
  };
  const refusedOne = await bySubject('Refused at the end');
  await expect(refusedOne.locator('.dialog')).toContainText("couldn't send this email while it was quitting");
  await expect(refusedOne.locator('.dialog')).toContainText('Mailbox full');
  const hanging = await bySubject('Hanging at the end');
  await expect(hanging.locator('.dialog')).toContainText('Check Sent before you send it again.');
  // held.json keeps both while their editors only hold them in memory.
  expect(kept()).toEqual(['Refused at the end', 'Hanging at the end']);
});

// The server refuses an email while a quit waits for another editor's answer, so it goes to Drafts, and the quit is
// called off before that save is done. ok: the save then stores the draft, or fails. The refused email opens again in
// the reading pane, which keeps the other editor's text as a draft. write: writes the email to someone@example.com.
async function refusedWhileQuitIsCalledOff(subject, text, ok, write = () => newMessage(win, { to: 'someone@example.com', subject, text })) {
  await write();
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

// The quit's save replaces the draft the email's attachment was copied from; its editor copies it from the stored
// draft instead (outbox.js savedToDrafts), so the email still goes with it.
test('an email saved with an attachment that reached Drafts after the quit is called off still goes with it', async () => {
  const subject = 'Proposal, saved first';
  await refusedWhileQuitIsCalledOff(subject, 'Here is the proposal.', true, async () => {
    await item('Sanne de Vries').click();
    await expect(win.locator('.att-name')).toHaveText('Proposal-v3.pdf');
    await win.click('[data-reader="forward"]');
    const c = composer();
    await c.locator('[data-rinput="to"]').fill('someone@example.com');
    await c.locator('[data-rinput="to"]').press('Enter');
    await c.locator('[data-field="subject"]').fill(subject);
    await c.locator('.editor').click();
    await win.keyboard.type('Here is the proposal.');
    // Saved: from here on the attachment is copied from this draft.
    await win.keyboard.press('Control+s');
    await expect(c).toHaveAttribute('data-dirty', 'false');
  });
  const c = composer();
  await expect(c.locator('.compose-attachments')).toContainText('Proposal-v3.pdf');
  expect((await subjects('drafts')).filter((s) => s === subject)).toHaveLength(1);

  // The server takes it this time.
  await app.evaluate(() => {
    delete global.__semEngine.send;
  });
  await c.locator('[data-c="send"]').click();
  await composerGone();
  await sendWaiting();
  await expect(notice()).toContainText('Email sent');
  await expect(win.locator('.dialog')).toHaveCount(0);
  const attached = await app.evaluate(async (_e, subject) => {
    const engine = global.__semEngine;
    const id = engine.accounts[0].id;
    await engine.syncAccount(id);
    const copy = engine.listMessages({ scope: id, view: 'sent' }).find((m) => m.subject === subject);
    return copy ? (await engine.getMessage(copy.id)).attachments.map((a) => a.filename) : null;
  }, subject);
  expect(attached).toEqual(['Proposal-v3.pdf']);
  expect(await subjects('drafts')).not.toContain(subject);
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
  // Kept once, until the editor in the reading pane answers for it.
  expect(kept()).toEqual([subject]);
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
  // Its editor is open, so main let it go.
  await expect.poll(held).toBe(0);
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
  expect(await held()).toBe(0);
  // held.json keeps it while the compose window only has it open, and lets it go once that editor saves it.
  expect(kept()).toEqual(['Refused while busy']);
  await popped.locator('.editor').click();
  await popped.keyboard.press('Control+s');
  await expect.poll(kept).toEqual([]);
});

// The server refuses every email, and the Drafts saves of the editor with this subject hold until the test lets them
// go (global.__saves). The test also notes when the main window asks main for refused emails, and what its claims get.
async function refuseAndHoldSaves(subject) {
  await app.evaluate((_e, subject) => {
    const engine = global.__semEngine;
    const saveDraft = engine.saveDraft.bind(engine);
    engine.send = async () => {
      throw new Error('Mailbox full');
    };
    global.__saves = [];
    engine.saveDraft = (payload) =>
      payload.subject === subject ? new Promise((resolve, reject) => global.__saves.push(() => saveDraft(payload).then(resolve, reject))) : saveDraft(payload);
    const refused = global.__semRefused;
    const waiting = refused.waiting.bind(refused);
    const claim = refused.claim.bind(refused);
    global.__asked = 0;
    global.__claims = [];
    refused.waiting = () => {
      global.__asked += 1;
      return waiting();
    };
    refused.claim = (id) => {
      const ok = claim(id);
      global.__claims.push(ok);
      return ok;
    };
  }, subject);
}

async function sendRefused(subject) {
  await newMessage(win, { to: 'someone@example.com', subject, text: `${subject}, every word.` });
  await composer().locator('[data-c="send"]').click();
  await composerGone();
}

// Two emails are refused at once while the reading pane holds an editor whose Drafts save is slow, and the main
// window's page crashes while the first refused email waits for that save. Main still holds both, so each opens once,
// in a compose window.
test('refused emails the main window had not opened yet still open, once each, when its page crashes halfway', async () => {
  await refuseAndHoldSaves('Half written');
  await sendRefused('First refused');
  await sendRefused('Second refused');
  await newMessage(win, { to: 'other@example.com', subject: 'Half written', text: 'Unsaved.' });
  const opened = [];
  app.on('window', (page) => opened.push(page));
  await sendWaiting();
  // The page asked for both, and its reading pane waits for the other editor's save before it takes the first.
  await expect.poll(() => app.evaluate(() => global.__asked)).toBeGreaterThan(0);
  await expect.poll(() => app.evaluate(() => global.__saves.length)).toBeGreaterThan(0);
  expect(await held()).toBe(2);
  expect(await app.evaluate(() => global.__claims)).toEqual([]);
  expect(opened).toHaveLength(0);

  await app.evaluate(({ BrowserWindow }) => {
    const main = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('index.html'));
    main.webContents.forcefullyCrashRenderer();
  });
  await expect.poll(() => opened.length).toBe(2);
  const reopened = [];
  for (const page of opened) {
    page.on('dialog', () => {});
    await page.waitForSelector('.composer .editor');
    await expect(page.locator('.dialog')).toContainText('Mailbox full');
    await page.locator('.dialog .buttons button').click();
    const subject = await page.locator('[data-field="subject"]').inputValue();
    await expect(page.locator('.editor')).toContainText(`${subject}, every word.`);
    reopened.push(subject);
  }
  expect(reopened.sort()).toEqual(['First refused', 'Second refused']);
  expect(await held()).toBe(0);
  expect(opened).toHaveLength(2);
});

// The fallback opens a refused email in a compose window while the reading pane still waits for another editor's
// slow save. When that save is done, the pane's claim finds nothing, so the email doesn't open a second time there.
test('a refused email the fallback opened while the reading pane was busy saving does not open there too', async () => {
  await refuseAndHoldSaves('Half written');
  await sendRefused('Opened once');
  await newMessage(win, { to: 'other@example.com', subject: 'Half written', text: 'Unsaved.' });
  // 3 seconds instead of 15, for this test.
  await app.evaluate(() => {
    global.__semRefused.ms = 3000;
  });
  const opened = [];
  app.on('window', (page) => opened.push(page));
  await sendWaiting();
  await expect.poll(() => app.evaluate(() => global.__asked)).toBeGreaterThan(0);
  await expect.poll(() => opened.length, { timeout: 15000 }).toBe(1);
  const [popped] = opened;
  popped.on('dialog', () => {});
  await popped.waitForSelector('.composer .editor');
  await expect(popped.locator('.dialog')).toContainText('Mailbox full');
  expect(await held()).toBe(0);
  // The pane was still waiting for the save all along.
  expect(await app.evaluate(() => global.__claims)).toEqual([]);
  expect(await app.evaluate(() => global.__saves.length)).toBeGreaterThan(0);

  await app.evaluate(() => global.__saves.splice(0).forEach((go) => go()));
  // The other editor went to Drafts and closed; the refused email doesn't take its place.
  await composerGone();
  await expect.poll(() => app.evaluate(() => global.__claims)).toEqual([false]);
  await win.evaluate(() => window.mail.call('state'));
  await expect(composer()).toHaveCount(0);
  expect(opened).toHaveLength(1);
  await popped.locator('.dialog .buttons button').click();
  await expect(popped.locator('[data-field="subject"]')).toHaveValue('Opened once');
  await expect(popped.locator('.editor')).toContainText('Opened once, every word.');
  expect(await subjects('drafts')).toContain('Half written');
});

// Windows ends the session while the main window's reading pane waits to take a refused email. The email goes to the
// list for the next start, which opens it once, although the pane takes its turn after the session ended.
test('a refused email the main window had not opened when the Windows session ends opens at the next start', async () => {
  await refuseAndHoldSaves('Half written');
  await sendRefused('Cut off');
  await newMessage(win, { to: 'other@example.com', subject: 'Half written', text: 'Unsaved.' });
  await sendWaiting();
  await expect.poll(() => app.evaluate(() => global.__saves.length)).toBeGreaterThan(0);
  expect(await held()).toBe(1);

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].emit('session-end'));
  expect(await held()).toBe(0);
  expect(kept()).toEqual(['Cut off']);
  expect(JSON.stringify(onDisk())).toContain('Cut off, every word.');
  // The pane's turn comes after the session ended, and it finds nothing to open.
  await app.evaluate(() => global.__saves.splice(0).forEach((go) => go()));
  await expect.poll(() => app.evaluate(() => global.__claims)).toEqual([false]);
  await expect(composer()).toHaveCount(0);
  expect(app.windows()).toHaveLength(1);

  await closeApp(app);
  expect(kept()).toEqual(['Cut off']);
  await launch();
  await expect.poll(() => app.windows().length, { timeout: 15000 }).toBe(2);
  const again = app.windows().find((w) => w !== win);
  await again.waitForSelector('.composer .editor');
  await expect(again.locator('.dialog')).toContainText('Mailbox full');
  await again.locator('.dialog .buttons button').click();
  await expect(again.locator('[data-field="subject"]')).toHaveValue('Cut off');
  await expect(again.locator('.editor')).toContainText('Cut off, every word.');
  expect(kept()).toEqual(['Cut off']);
});

// #309: a refused email held for the reading pane lived only in main's memory until the pane opened it. held.json now
// keeps it from the moment the server refuses it, so a kill before the pane opens it, and another kill while the
// next start reopens it, bring each email back once.
test('refused emails the reading pane has not opened yet come back once each after a kill, and after a second kill', async () => {
  test.setTimeout(120000);
  await refuseAndHoldSaves('Half written');
  await sendRefused('First refused');
  await sendRefused('Second refused');
  await newMessage(win, { to: 'other@example.com', subject: 'Half written', text: 'Unsaved.' });
  await sendWaiting();
  // The pane waits for the other editor's save, so neither refused email is open anywhere yet.
  await expect.poll(() => app.evaluate(() => global.__saves.length)).toBeGreaterThan(0);
  expect(await held()).toBe(2);
  expect(app.windows()).toHaveLength(1);
  expect(kept().sort()).toEqual(['First refused', 'Second refused']);
  expect(onDisk().map((e) => e.error)).toEqual(['Mailbox full', 'Mailbox full']);
  await crash();

  await launch();
  const first = await editorsAfterStart(2);
  for (const subject of ['First refused', 'Second refused']) {
    await expect(first[subject].locator('.dialog')).toContainText('Mailbox full');
    await first[subject].locator('.dialog .buttons button').click();
    await expect(first[subject].locator('.editor')).toContainText(`${subject}, every word.`);
  }
  // Open, and answered for by neither editor yet: both stay kept, once.
  expect(kept().sort()).toEqual(['First refused', 'Second refused']);
  await crash();

  await launch();
  const second = await editorsAfterStart(2);
  expect(kept().sort()).toEqual(['First refused', 'Second refused']);
  // Saved, one goes from the file; the other stays for the next start.
  await app.evaluate(() => (global.__allowSaves = true));
  const saved = second['First refused'];
  await saved.locator('.dialog .buttons button').click();
  await saved.locator('.editor').click();
  await saved.keyboard.press('Control+s');
  await expect.poll(kept).toEqual(['Second refused']);
  await crash();

  await launch();
  const third = await editorsAfterStart(1);
  expect(Object.keys(third)).toEqual(['Second refused']);
});

// #309: a refused email open in the reading pane is kept until that editor answers for it. A crash of the main window's
// page opens it in a compose window; a kill of Rukoo brings it back once at the next start; once saved it stays away.
test('a refused email open in the reading pane survives a page crash and a kill, once, until its editor saves it', async () => {
  test.setTimeout(120000);
  // Saves fail until the test lets them, so no autosave (8 s) settles the email before the test looks.
  await app.evaluate(() => {
    const engine = global.__semEngine;
    const save = engine.saveDraft.bind(engine);
    engine.saveDraft = (payload) => (global.__allowSaves ? save(payload) : Promise.reject(new Error('No connection')));
    engine.send = async () => {
      throw new Error('Mailbox full');
    };
  });
  await newMessage(win, { to: 'someone@example.com', subject: 'Open in the pane', text: 'Typed in the main window.' });
  await composer().locator('[data-c="send"]').click();
  await composerGone();
  await sendWaiting();
  await expect(win.locator('.dialog')).toContainText('Mailbox full');
  await win.locator('.dialog .buttons button').click();
  await expect(composer().locator('[data-field="subject"]')).toHaveValue('Open in the pane');
  await expect.poll(held).toBe(0);
  expect(kept()).toEqual(['Open in the pane']);

  // The page dies with the editor: the email opens in a compose window, and the file still lists it once.
  const [popped] = await Promise.all([
    app.waitForEvent('window'),
    app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('index.html')).webContents.forcefullyCrashRenderer())
  ]);
  popped.on('dialog', () => {});
  await popped.waitForSelector('.composer .editor');
  await expect(popped.locator('.dialog')).toContainText('Mailbox full');
  await expect(popped.locator('[data-field="subject"]')).toHaveValue('Open in the pane');
  expect(kept()).toEqual(['Open in the pane']);
  await crash();

  await launch();
  const back = await editorsAfterStart(1);
  const again = back['Open in the pane'];
  await expect(again.locator('.dialog')).toContainText('Mailbox full');
  await again.locator('.dialog .buttons button').click();
  await expect(again.locator('.editor')).toContainText('Typed in the main window.');
  await app.evaluate(() => (global.__allowSaves = true));
  await again.locator('.editor').click();
  await again.keyboard.press('Control+s');
  await expect.poll(kept).toEqual([]);
  expect(await subjects('drafts')).toContain('Open in the pane');
  await crash();

  await launch();
  await nothingReopens();
});

// #309: what a quit left used to be read and deleted at the next start before the compose windows it opened had their
// editors. Now the file keeps each email until its editor answers for it, so a kill at that start, while the windows
// are there and their editors are not, brings them back once each at the one after. The test holds every compose
// window before it gets its editor (SEM_COMPOSE_HOLD, main.js composeInit), checks that both are in that state, and
// kills Rukoo then.
test('emails a quit left open again once each after a kill while their compose windows wait for their editors', async () => {
  test.setTimeout(120000);
  await app.evaluate(() => {
    const engine = global.__semEngine;
    engine.send = async () => {
      throw new Error('Mailbox full');
    };
    engine.saveDraft = async () => {
      throw new Error('No connection');
    };
  });
  for (const subject of ['Left by the quit', 'Also left by the quit']) {
    await newMessage(win, { to: 'someone@example.com', subject, text: `${subject}, every word.` });
    await composer().locator('[data-c="send"]').click();
    await composerGone();
  }
  await closeApp(app);
  expect(kept().sort()).toEqual(['Also left by the quit', 'Left by the quit']);

  // The next start, with both compose windows held before their editors.
  const env = { ...process.env, SEM_DATA_DIR: dataDir, SEM_HIDDEN: '1', SEM_UNDO_SEND: '1', SEM_COMPOSE_HOLD: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: ['.'], cwd: path.join(__dirname, '..', '..'), env });
  win = await app.firstWindow();
  await expect.poll(() => app.windows().length, { timeout: 15000 }).toBe(3);
  // Both windows have loaded their page and wait for their email from main; neither has an editor.
  await expect.poll(() => app.evaluate(() => global.__semComposeHeld || 0), { timeout: 15000 }).toBe(2);
  const waitingWindows = app.windows().filter((w) => w !== win);
  for (const w of waitingWindows) {
    await expect(w.locator('#app')).toBeAttached();
    await expect(w.locator('.composer')).toHaveCount(0);
    await expect(w.locator('.editor')).toHaveCount(0);
  }
  expect(await app.evaluate(() => global.__semComposeHeld)).toBe(2);
  await crash();
  expect(kept().sort()).toEqual(['Also left by the quit', 'Left by the quit']);

  await launch();
  const back = await editorsAfterStart(2);
  for (const subject of ['Left by the quit', 'Also left by the quit']) {
    await expect(back[subject].locator('.dialog')).toContainText("couldn't send this email while it was quitting");
    await expect(back[subject].locator('.dialog')).toContainText('Mailbox full');
    await back[subject].locator('.dialog .buttons button').click();
    await expect(back[subject].locator('.editor')).toContainText(`${subject}, every word.`);
  }
  expect(kept().sort()).toEqual(['Also left by the quit', 'Left by the quit']);
});

// #309: a profile from before held.json kept refused emails: unsent.json, which could list an email that held.json
// still had as on its way when Rukoo was killed during a quit. The next start opens it once, with its error.
test('an email in both unsent.json and held.json from an older Rukoo opens once, with the error unsent.json had', async () => {
  await app.evaluate(() => {
    global.__semEngine.send = () => new Promise(() => {});
  });
  await newMessage(win, { to: 'someone@example.com', subject: 'In both files', text: 'Listed twice, opened once.' });
  await composer().locator('[data-c="send"]').click();
  await composerGone();
  await app.evaluate(() => {
    global.__semOutbox.flush();
  });
  await expect.poll(() => onDisk().map((e) => e.state)).toEqual(['sending']);
  await crash();
  const [record] = onDisk();
  fs.writeFileSync(
    path.join(dataDir, 'data', 'unsent.json'),
    JSON.stringify([{ id: record.id, restore: record.restore, error: "Rukoo couldn't send this email while it was quitting, or keep it in Drafts: Mailbox full" }])
  );

  await launch();
  const back = await editorsAfterStart(1);
  await expect(back['In both files'].locator('.dialog')).toContainText('Mailbox full');
  expect(fs.existsSync(path.join(dataDir, 'data', 'unsent.json'))).toBe(false);
  expect(kept()).toEqual(['In both files']);
});

// A refused email open in the reading pane, after its error is closed. Saves fail until the test lets them
// (global.__allowSaves), so no autosave answers for it before the test does.
async function refusedInPane(subject, text) {
  await app.evaluate(() => {
    const engine = global.__semEngine;
    const save = engine.saveDraft.bind(engine);
    engine.saveDraft = (payload, hooks) => (global.__allowSaves ? save(payload, hooks) : Promise.reject(new Error('No connection')));
    engine.send = async () => {
      throw new Error('Mailbox full');
    };
  });
  await newMessage(win, { to: 'someone@example.com', subject, text });
  await composer().locator('[data-c="send"]').click();
  await composerGone();
  await sendWaiting();
  await expect(win.locator('.dialog')).toContainText('Mailbox full');
  await win.locator('.dialog .buttons button').click();
  await expect(composer().locator('[data-field="subject"]')).toHaveValue(subject);
  await expect.poll(held).toBe(0);
  expect(kept()).toEqual([subject]);
}
// Undo send off, and every send waits until the test answers it (global.__sends).
const holdSendsWithoutUndo = () =>
  app.evaluate(() => {
    global.__semEngine.updateSettings({ undoSend: 0 });
    global.__sends = [];
    global.__semEngine.send = (payload) => new Promise((resolve, reject) => global.__sends.push({ subject: payload.subject, resolve, reject }));
  });
// What a script finds in the main window's page, or null when the page doesn't answer within 2 seconds.
const mainPage = (script) =>
  app.evaluate(({ BrowserWindow }, script) => {
    const main = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('index.html'));
    return Promise.race([main.webContents.executeJavaScript(script), new Promise((resolve) => setTimeout(() => resolve(null), 2000))]);
  }, script);

// Review of #309: a send straight away from the reading pane settled, when it ended, whatever the pane held by then,
// and a page crash opened the email whose send still ran in a compose window, from which it could go a second time.
// Each send now names its email from start to end, and an email on its way opens nowhere else.
test('a retry sent straight away from the reading pane answers only for its own email, though the page crashed and took another', async () => {
  test.setTimeout(120000);
  await refusedInPane('Retried from the pane', 'First email.');
  await holdSendsWithoutUndo();
  await composer().locator('[data-c="send"]').click();
  await expect.poll(() => app.evaluate(() => global.__sends.length)).toBe(1);
  expect(onDisk().map((e) => [e.restore.state.subject, e.state])).toEqual([['Retried from the pane', 'sending']]);
  const opened = [];
  app.on('window', (page) => opened.push(page));

  // The page crashes while the send runs, and loads again.
  await app.evaluate(
    ({ BrowserWindow }) =>
      new Promise((resolve) => {
        const main = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('index.html'));
        main.webContents.once('render-process-gone', () => {
          main.webContents.once('did-finish-load', resolve);
          main.webContents.reload();
        });
        main.webContents.forcefullyCrashRenderer();
      })
  );
  expect(opened).toHaveLength(0);
  await expect.poll(() => mainPage('Boolean(document.querySelector(".item"))'), { timeout: 20000 }).toBe(true);
  // Another email is refused, and the new page's reading pane opens it.
  await app.evaluate(() => {
    global.__semEngine.send = async () => {
      throw new Error('Mailbox full');
    };
    const restore = {
      opts: { mode: 'new' },
      html: '<p>Second email.</p>',
      state: { subject: 'Taken by the new page', to: [{ name: '', address: 'other@example.com' }], cc: [], bcc: [], attachments: [] }
    };
    global.__semOutbox.queue({ payload: { subject: 'Taken by the new page' }, restore, origin: 'main', ms: 60000 });
    return global.__semOutbox.flush();
  });
  await expect
    .poll(() => mainPage('document.querySelector(".composer [data-field=subject]")?.value || ""'), { timeout: 20000 })
    .toBe('Taken by the new page');
  await expect.poll(held).toBe(0);
  expect(kept().sort()).toEqual(['Retried from the pane', 'Taken by the new page']);
  expect(opened).toHaveLength(0);

  // The first send goes through: its own email goes from the file, and the one in the pane stays.
  await app.evaluate(() => global.__sends[0].resolve(true));
  await expect.poll(kept).toEqual(['Taken by the new page']);
  expect(opened).toHaveLength(0);
  expect(await app.evaluate(() => global.__sends.length)).toBe(1);
});

// Review of #309: a send straight away wrote only that the email was on its way, so a kill brought back the version
// from before the edits. The file now has what was sent, from before it goes.
test('an email sent again straight away after edits comes back after a kill as it was sent, with the note to check Sent', async () => {
  test.setTimeout(120000);
  await refusedInPane('Before the edit', 'Written first.');
  await composer().locator('[data-field="subject"]').fill('After the edit');
  await composer().locator('.editor').click();
  await win.keyboard.press('End');
  await win.keyboard.type(' Added after the refusal.');
  await holdSendsWithoutUndo();
  await composer().locator('[data-c="send"]').click();
  await expect.poll(() => app.evaluate(() => global.__sends.length)).toBe(1);
  const [onItsWay] = onDisk();
  expect([onItsWay.restore.state.subject, onItsWay.state]).toEqual(['After the edit', 'sending']);
  expect(onItsWay.restore.html).toContain('Added after the refusal.');
  await crash();

  await launch();
  const back = await editorsAfterStart(1);
  const again = back['After the edit'];
  await expect(again.locator('.dialog')).toContainText('Check Sent before you send it again');
  await again.locator('.dialog .buttons button').click();
  await expect(again.locator('.editor')).toContainText('Added after the refusal.');

  // Second review of #309: after that note, one click on Send delivered it again. Send now asks first, and only Send
  // anyway lets it go.
  await holdSendsWithoutUndo();
  await again.locator('[data-c="send"]').click();
  await expect(again.locator('.scrim .dialog')).toContainText('This email may already have gone.');
  await again.click('.scrim .buttons button:text-is("Cancel")');
  await again.waitForTimeout(500);
  expect(await app.evaluate(() => global.__sends.length)).toBe(0);
  await again.locator('[data-c="send"]').click();
  await again.click('.scrim .buttons button:text-is("Send anyway")');
  await expect.poll(() => app.evaluate(() => global.__sends.length)).toBe(1);
});

// Review of #309: an editor's Drafts save let its kept email go only once the renderer heard back, after the save had
// removed the draft it replaced. Main now lets it go the moment the server has the draft, and a start after a kill
// right before that finds the draft by its Message-ID instead of opening the email a second time.
test('an email whose draft the server stored just before a kill does not open again, and Drafts has it once', async () => {
  test.setTimeout(120000);
  await refusedInPane('Saved before the kill', 'Kept as a draft.');
  // The server stores the draft, and Rukoo is killed before it hears back.
  await app.evaluate(() => {
    const engine = global.__semEngine;
    const session = engine.session(engine.accounts[0]);
    const append = session.append.bind(session);
    session.append = async (folder, raw, flags = []) => {
      const uid = await append(folder, raw, flags);
      if (!flags.includes('\\Draft')) return uid;
      global.__stored = uid;
      return new Promise(() => {});
    };
    global.__allowSaves = true;
  });
  await composer().locator('.editor').click();
  await win.keyboard.press('Control+s');
  await expect.poll(() => app.evaluate(() => global.__stored || null)).not.toBeNull();
  expect(kept()).toEqual(['Saved before the kill']);
  await crash();

  await launch();
  await nothingReopens();
  await expect.poll(kept).toEqual([]);
  expect((await subjects('drafts')).filter((s) => s === 'Saved before the kill')).toHaveLength(1);
});

// #309: an email the server refuses when it goes straight away stays in the profile for its editor, which names it
// from then on: a crash before that editor answers brings it back once, and Delete lets it go.
test('a compose window whose email is refused straight away keeps it until it answers, also across a kill', async () => {
  test.setTimeout(120000);
  await app.evaluate(() => {
    global.__semEngine.updateSettings({ undoSend: 0 });
    global.__semEngine.saveDraft = () => Promise.reject(new Error('No connection'));
    global.__semEngine.send = async () => {
      throw new Error('Mailbox full');
    };
  });
  const [page] = await Promise.all([app.waitForEvent('window'), win.evaluate(() => window.mail.call('openCompose', { mode: 'new' }))]);
  await page.waitForSelector('.composer .editor');
  page.on('dialog', () => {});
  await page.locator('[data-rinput="to"]').fill('someone@example.com');
  await page.locator('[data-rinput="to"]').press('Enter');
  await page.locator('[data-field="subject"]').fill('Refused at once');
  await page.locator('.editor').click();
  await page.keyboard.type('Every word stays.');
  await page.locator('[data-c="send"]').click();
  await expect(page.locator('.dialog')).toContainText('Mailbox full');
  expect(kept()).toEqual(['Refused at once']);
  expect(onDisk()[0].error).toBe('Mailbox full');
  await crash();

  await launch();
  const back = await editorsAfterStart(1);
  const again = back['Refused at once'];
  await expect(again.locator('.dialog')).toContainText('Mailbox full');
  await again.locator('.dialog .buttons button').click();
  await expect(again.locator('.editor')).toContainText('Every word stays.');
  // Refused again from this window: still kept once, under the same id.
  await app.evaluate(() => {
    global.__semEngine.updateSettings({ undoSend: 0 });
    global.__semEngine.send = async () => {
      throw new Error('Mailbox still full');
    };
  });
  const id = onDisk()[0].id;
  await again.locator('[data-c="send"]').click();
  await expect(again.locator('.dialog')).toContainText('Mailbox still full');
  expect(onDisk().map((e) => [e.id, e.error])).toEqual([[id, 'Mailbox still full']]);
  await again.locator('.dialog .buttons button').click();
  // Delete, and it goes, with its window.
  await again.click('[data-c="discard"]');
  await clickClosing(again, '.scrim .buttons button:text-is("Delete")');
  await expect.poll(kept, { timeout: 10000 }).toEqual([]);
  expect(app.windows()).toHaveLength(1);
});

// What a script finds in the compose window's page, or null when the page doesn't answer within 2 seconds.
const composePage = (script) =>
  app.evaluate(({ BrowserWindow }, script) => {
    const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().endsWith('compose.html'));
    if (!w) return null;
    return Promise.race([w.webContents.executeJavaScript(script), new Promise((resolve) => setTimeout(() => resolve(null), 2000))]);
  }, script);

// Second review of #309: a compose window whose page loaded again after a crash got the email and id it was first opened
// with. Once the server took the first send, that id counted as new, and Send delivered the email a second time. The
// page now gets the email as main has it, once the send has ended: here, that it went, with no editor to send it again.
test('a compose window whose page loads again during a send shows that the email went, and cannot send it a second time', async () => {
  test.setTimeout(120000);
  await app.evaluate(() => {
    global.__semEngine.saveDraft = () => Promise.reject(new Error('No connection'));
    global.__semEngine.send = async () => {
      throw new Error('Mailbox full');
    };
  });
  // Written in a compose window and refused after the wait: it opens again in a compose window of its own.
  const [page] = await Promise.all([app.waitForEvent('window'), win.evaluate(() => window.mail.call('openCompose', { mode: 'new' }))]);
  await page.waitForSelector('.composer .editor');
  page.on('dialog', () => {});
  await page.locator('[data-rinput="to"]').fill('someone@example.com');
  await page.locator('[data-rinput="to"]').press('Enter');
  await page.locator('[data-field="subject"]').fill('Sent once only');
  await page.locator('.editor').click();
  await page.keyboard.type('One copy.');
  await clickClosing(page, '[data-c="send"]');
  const [reopened] = await Promise.all([app.waitForEvent('window'), sendWaiting()]);
  reopened.on('dialog', () => {});
  await reopened.waitForSelector('.composer .editor');
  await expect(reopened.locator('.dialog')).toContainText('Mailbox full');
  await reopened.locator('.dialog .buttons button').click();
  expect(kept()).toEqual(['Sent once only']);

  // Sent again straight away; the server takes its time.
  await holdSendsWithoutUndo();
  await reopened.locator('[data-c="send"]').click();
  await expect.poll(() => app.evaluate(() => global.__sends.length)).toBe(1);
  // Its page crashes and loads again while the send runs.
  await app.evaluate(
    ({ BrowserWindow }) =>
      new Promise((resolve) => {
        const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().endsWith('compose.html'));
        w.webContents.once('render-process-gone', () => {
          w.webContents.once('did-finish-load', resolve);
          w.webContents.reload();
        });
        w.webContents.forcefullyCrashRenderer();
      })
  );
  // While the send waits for the server, the new page gets no editor, and says what it waits for.
  await expect.poll(() => composePage('document.readyState'), { timeout: 20000 }).toBe('complete');
  await expect
    .poll(() => composePage('document.querySelector("[data-compose-waiting]")?.textContent || ""'), { timeout: 20000 })
    .toBe('Waiting for the mail server to answer about this email…');
  expect(await composePage('Boolean(document.querySelector(".composer"))')).toBe(false);

  // The server takes it: the page says it went, under the email's subject, and has nothing to send it with.
  await app.evaluate(() => global.__sends[0].resolve(true));
  await expect.poll(() => composePage('document.querySelector("[data-compose-settled]")?.textContent || ""'), { timeout: 20000 }).toBe('Email sent');
  expect(await composePage('document.title')).toBe('Sent once only');
  expect(await composePage('Boolean(document.querySelector(".composer, [data-c=send]"))')).toBe(false);
  expect(await app.evaluate(() => global.__sends.length)).toBe(1);
  await expect.poll(kept).toEqual([]);
  // Close takes the window away.
  await composePage('setTimeout(() => document.querySelector(".compose-error button").click(), 0), true');
  await expect.poll(() => app.windows().length, { timeout: 10000 }).toBe(1);
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
