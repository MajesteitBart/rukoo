// End-to-end tests for the tray: closing and minimizing to the tray, the tray menu, quitting, and both settings off.
// Test mode (SEM_HIDDEN) puts no icon in the notification area: the tests click main's stand-in, global.__semTray,
// which has the real menu. The real icon is checked by hand.
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');

let app;
let win;
let dataDir;
let running;

async function launch() {
  const env = { ...process.env, SEM_DATA_DIR: dataDir, SEM_HIDDEN: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: ['.'], cwd: path.join(__dirname, '..', '..'), env });
  running = true;
  app.process().once('exit', () => (running = false));
  win = page(await app.firstWindow());
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.setSize(1500, 950);
    // isVisible() is false for a minimized window too; only a hidden one raises 'hide'.
    global.__hidden = false;
    w.on('hide', () => (global.__hidden = true));
    w.on('show', () => (global.__hidden = false));
  });
}

// The question about unsaved changes comes from beforeunload, which Electron answers by itself (it keeps the
// window). Without a listener of its own, Playwright tries to answer it too, and fails.
function page(p) {
  p.on('dialog', () => {});
  return p;
}

test.beforeEach(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sem-e2e-'));
  await launch();
  await win.waitForSelector('.provider-grid');
  await win.click('[data-s="demo"]');
  await expect(win.locator('.item').first()).toBeVisible({ timeout: 15000 });
});

test.afterEach(async () => {
  if (running) {
    // An editor with unsaved changes keeps its window open and asks first; skip that in tests.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.destroy())).catch(() => {});
    await app.close();
  }
  fs.rmSync(dataDir, { recursive: true, force: true });
});

// The main window as main sees it, or null once it is gone. hidden: in the tray, not on the taskbar.
const main = () =>
  app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().endsWith('index.html'));
    return w ? { visible: w.isVisible(), minimized: w.isMinimized(), hidden: global.__hidden, bounds: w.getBounds() } : null;
  });
const visible = async () => (await main())?.visible;
const windowCount = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
// What the close button does.
const closeMain = () =>
  app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().endsWith('index.html')).close());

const tray = () =>
  app.evaluate(() => {
    const t = global.__semTray;
    return t && { tooltip: t.tray.tooltip, dot: t.dot, labels: t.menu.items.filter((i) => i.type !== 'separator').map((i) => i.label) };
  });
const trayClick = () => app.evaluate(() => global.__semTray.tray.emit('click'));
const trayMenu = (id) => app.evaluate((_electron, id) => global.__semTray.menu.getMenuItemById(id).click(), id);

const saved = () => JSON.parse(fs.readFileSync(path.join(dataDir, 'data', 'settings.json'), 'utf8'));
const unread = () => app.evaluate(() => global.__semEngine.unreadCount());

// Notifications are recorded instead of shown, so the tests put no toasts on screen.
const recordNotifications = () =>
  app.evaluate(({ Notification }) => {
    global.__shown = [];
    Notification.prototype.show = function () {
      global.__shown.push(this);
    };
  });
const shown = () => app.evaluate(() => global.__shown.map((n) => n.title));

// New mail on the demo server. Only a sync brings it into Rukoo.
const deliver = (subject) =>
  app.evaluate(async (_electron, subject) => {
    const engine = global.__semEngine;
    const raw = [
      'From: Sanne de Vries <sanne@example.com>',
      'To: demo@example.com',
      `Subject: ${subject}`,
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: <${Date.now()}.tray@example.com>`,
      '',
      'Hello'
    ].join('\r\n');
    await engine.session(engine.accounts[0]).append('INBOX', raw);
  }, subject);
const hasMessage = (subject) => app.evaluate((_electron, subject) => global.__semEngine.listMessages({}).some((m) => m.subject === subject), subject);

// Sync every 1.2 seconds, through the same call Settings makes, so main sets its timer again.
const syncOften = () => win.evaluate(() => window.mail.call('updateSettings', { syncInterval: 0.02 }));

// Writes what happens during a quit to a file, because the app is gone afterwards.
const quitLog = path.join(os.tmpdir(), `rukoo-tray-quit-${process.pid}.log`);
async function watchQuit() {
  fs.rmSync(quitLog, { force: true });
  await app.evaluate(({ app }, file) => {
    const fs = process.mainModule.require('fs');
    const log = (what) => fs.appendFileSync(file, `${what}\n`);
    const wrap = (object, method, name) => {
      const orig = object[method].bind(object);
      object[method] = (...args) => {
        log(name);
        return orig(...args);
      };
    };
    app.on('before-quit', () => log('before-quit'));
    app.on('will-quit', () => log('will-quit'));
    wrap(global.__semEngine, 'flush', 'engine flushed');
    wrap(global.__semAgents, 'dispose', 'agents closed');
    if (global.__semTray) wrap(global.__semTray, 'destroy', 'tray removed');
  }, quitLog);
}
async function quitEvents() {
  // will-quit waits up to 5 s for the agents; a busy machine adds to that.
  await expect.poll(() => running, { timeout: 30000 }).toBe(false);
  const lines = fs.readFileSync(quitLog, 'utf8').trim().split('\n');
  fs.rmSync(quitLog, { force: true });
  return lines;
}

async function inlineDraft(subject, text) {
  await win.click('[data-action="compose"]');
  await win.waitForSelector('.composer .editor');
  await win.fill('.composer [data-field="subject"]', subject);
  await win.click('.composer .editor');
  await win.keyboard.type(text);
  await expect(win.locator('.composer')).toHaveAttribute('data-dirty', 'true');
}

test('closing the window hides it in the tray, where mail keeps syncing and notifying', async () => {
  const before = await main();
  const count = await unread();
  expect(await tray()).toEqual({
    tooltip: `Rukoo Mail: ${count} unread emails`,
    dot: false,
    labels: ['Open Rukoo', 'New message', 'Sync now', 'Quit']
  });
  await inlineDraft('Half written', 'Still here');
  await recordNotifications();
  await syncOften();

  await closeMain();
  await expect.poll(main).toMatchObject({ hidden: true, visible: false });
  // Hidden, not closed: the window and the unsaved draft in it are still there, and nothing asked about it.
  expect(await windowCount()).toBe(1);
  await expect(win.locator('.scrim')).toHaveCount(0);
  // The agents' tools that need the window still reach it.
  const draft = await app.evaluate(() => global.__semAgents.ui('getDraft'));
  expect(draft.subject).toBe('Half written');

  // The sync timer picks up new mail and notifies, with the window hidden.
  await deliver('Arrived while hidden');
  await expect.poll(shown, { timeout: 10000 }).toContain('Sanne de Vries');
  expect(await hasMessage('Arrived while hidden')).toBe(true);
  // The tray counts it, and its dot stands in for the taskbar badge.
  await expect.poll(tray).toMatchObject({ tooltip: `Rukoo Mail: ${count + 1} unread emails`, dot: true });

  // The tray icon brings the window back where it was, with the draft as it was.
  await trayClick();
  await expect.poll(visible).toBe(true);
  expect((await main()).bounds).toEqual(before.bounds);
  await expect(win.locator('.composer [data-field="subject"]')).toHaveValue('Half written');
  await expect(win.locator('.composer .editor')).toContainText('Still here');
  await expect(win.locator('.composer')).toHaveAttribute('data-dirty', 'true');
});

test('clicking a notification brings the hidden window back with the new email open', async () => {
  await recordNotifications();
  await closeMain();
  await expect.poll(main).toMatchObject({ hidden: true });
  await deliver('Open me from the notification');
  await trayMenu('sync');
  await expect.poll(shown).toContain('Sanne de Vries');
  await app.evaluate(() => global.__shown.find((n) => n.body.startsWith('Open me from the notification')).emit('click'));
  await expect.poll(main).toMatchObject({ hidden: false, visible: true });
  await expect(win.locator('.reader-subject')).toHaveText('Open me from the notification');
});

test('the tray menu opens Rukoo, starts a new message, syncs and follows the language', async () => {
  await closeMain();
  await expect.poll(visible).toBe(false);

  // New message opens a compose window; the main window stays in the tray.
  const [compose] = await Promise.all([app.waitForEvent('window'), trayMenu('compose')]);
  page(compose);
  await compose.waitForSelector('.compose .editor');
  expect(await visible()).toBe(false);

  // Open Rukoo shows the main window. Closing it to the tray again leaves the compose window alone.
  await trayMenu('open');
  await expect.poll(visible).toBe(true);
  await closeMain();
  await expect.poll(visible).toBe(false);
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('compose.html')).isVisible())).toBe(true);

  // Sync now fetches mail that arrived since the last sync.
  await deliver('Fetched from the tray');
  expect(await hasMessage('Fetched from the tray')).toBe(false);
  await trayMenu('sync');
  await expect.poll(() => hasMessage('Fetched from the tray')).toBe(true);

  // The menu and the tooltip switch language with the app.
  await win.evaluate(() => window.mail.call('updateSettings', { language: 'nl' }));
  const count = await unread();
  await expect.poll(tray).toMatchObject({
    tooltip: `Rukoo Mail: ${count} ongelezen e-mails`,
    labels: ['Rukoo openen', 'Nieuw bericht', 'Nu synchroniseren', 'Afsluiten']
  });
});

test('with minimize to the tray on, minimizing hides the window and the tray brings it back where it was', async () => {
  await win.click('[data-action="settings"]');
  const row = win.locator('.settings [data-a="toggle:minimizeToTray"]');
  await expect(row).toContainText('Minimize to the tray');
  await expect(row.locator('.switch')).not.toHaveClass(/\bon\b/);
  await expect(win.locator('.settings [data-a="toggle:closeToTray"] .switch')).toHaveClass(/\bon\b/);
  await row.click();
  await expect(row.locator('.switch')).toHaveClass(/\bon\b/);
  expect(saved().minimizeToTray).toBe(true);
  await win.click('.settings [data-a="back"]');

  const before = await main();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize());
  await expect.poll(main).toMatchObject({ hidden: true, minimized: true });
  await trayClick();
  await expect.poll(main).toMatchObject({ hidden: false, visible: true, minimized: false });
  expect((await main()).bounds).toEqual(before.bounds);
});

test('Quit in the tray menu goes through before-quit and will-quit', async () => {
  await closeMain();
  await expect.poll(visible).toBe(false);
  await watchQuit();
  await trayMenu('quit');
  // before-quit flushes the engine; will-quit removes the tray icon and closes the agents.
  expect(await quitEvents()).toEqual(['engine flushed', 'before-quit', 'tray removed', 'agents closed', 'will-quit']);
});

// The drafts on the demo server, read from its file, so this works after Rukoo has quit.
const savedDrafts = () => JSON.parse(fs.readFileSync(path.join(dataDir, 'data', 'demo-server.json'), 'utf8')).boxes.Drafts.messages.map((m) => m.subject);
// The quit asks once, holds while the question is open, and asks again once it is answered.
const QUIT_AFTER_QUESTION = ['engine flushed', 'before-quit', 'engine flushed', 'before-quit', 'tray removed', 'agents closed', 'will-quit'];

// A compose window from the tray menu with an unsaved subject; the main window goes to the tray.
async function composeDraft(subject) {
  const [compose] = await Promise.all([app.waitForEvent('window'), trayMenu('compose')]);
  page(compose);
  await compose.waitForSelector('.compose .editor');
  await compose.fill('[data-field="subject"]', subject);
  await expect(compose.locator('.composer')).toHaveAttribute('data-dirty', 'true');
  await closeMain();
  await expect.poll(visible).toBe(false);
  return compose;
}

test('Cancel in the question about a draft in the reading pane calls off a quit from the tray', async () => {
  await recordNotifications();
  await syncOften();
  await inlineDraft('Not saved yet', 'Some words');
  await closeMain();
  await expect.poll(visible).toBe(false);

  await trayMenu('quit');
  // The window comes out of the tray to ask about the draft.
  await expect.poll(visible).toBe(true);
  await expect(win.locator('.scrim')).toContainText('Save draft?');
  await win.click('.scrim .buttons button:text-is("Cancel")');
  await expect(win.locator('.composer .editor')).toContainText('Some words');

  // Not quitting any more: sync runs, and closing goes to the tray again.
  await deliver('After the cancelled quit');
  await expect.poll(shown, { timeout: 10000 }).toContain('Sanne de Vries');
  await closeMain();
  await expect.poll(visible).toBe(false);
  expect(await windowCount()).toBe(1);
  expect(await tray()).not.toBeNull();
  expect(running).toBe(true);
});

for (const [button, kept] of [["Don't save", false], ['Save', true]]) {
  test(`${button} in the question about a draft in the reading pane finishes a quit from the tray`, async () => {
    const subject = `Reading pane, ${button}`;
    await inlineDraft(subject, 'Some words');
    await closeMain();
    await expect.poll(visible).toBe(false);
    await watchQuit();

    await trayMenu('quit');
    await expect.poll(visible).toBe(true);
    await expect(win.locator('.scrim')).toContainText('Save draft?');
    await win.click(`.scrim .buttons button:text-is("${button}")`);
    expect(await quitEvents()).toEqual(QUIT_AFTER_QUESTION);
    expect(savedDrafts().includes(subject)).toBe(kept);
  });
}

test('a save that fails during a quit keeps Rukoo running with the draft', async () => {
  await inlineDraft('Cannot be saved', 'Some words');
  await app.evaluate(() => {
    global.__semEngine.saveDraft = async () => {
      throw new Error('Connection lost');
    };
  });
  await closeMain();
  await expect.poll(visible).toBe(false);

  await trayMenu('quit');
  await expect(win.locator('.scrim')).toContainText('Save draft?');
  await win.click('.scrim .buttons button:text-is("Save")');
  await expect(win.locator('.composer')).toHaveAttribute('data-dirty', 'true');
  await expect(win.locator('.composer .editor')).toContainText('Some words');
  // Called off: closing goes to the tray again instead of quitting.
  await closeMain();
  await expect.poll(visible).toBe(false);
  expect(running).toBe(true);
});

test('Cancel in a compose window calls off a quit; the tray then opens a new main window', async () => {
  const compose = await composeDraft('Popped out');
  await trayMenu('quit');
  // The main window had nothing to ask and closed; the compose window asks.
  await expect(compose.locator('.scrim')).toContainText('Save draft?');
  await expect.poll(main).toBeNull();
  await compose.click('.scrim .buttons button:text-is("Cancel")');
  await expect(compose.locator('.scrim')).toHaveCount(0);
  await expect(compose.locator('[data-field="subject"]')).toHaveValue('Popped out');
  expect(running).toBe(true);

  // Rukoo is running: the tray opens a fresh main window, and closing it goes to the tray.
  const [fresh] = await Promise.all([app.waitForEvent('window'), trayClick()]);
  win = page(fresh);
  await expect(win.locator('.item').first()).toBeVisible({ timeout: 15000 });
  expect(await visible()).toBe(true);
  await closeMain();
  await expect.poll(visible).toBe(false);
  expect(running).toBe(true);
});

for (const [button, kept] of [["Don't save", false], ['Save', true]]) {
  test(`${button} in a compose window finishes a quit from the tray`, async () => {
    const subject = `Compose window, ${button}`;
    const compose = await composeDraft(subject);
    await watchQuit();
    await trayMenu('quit');
    await expect(compose.locator('.scrim')).toContainText('Save draft?');
    await compose.click(`.scrim .buttons button:text-is("${button}")`);
    expect(await quitEvents()).toEqual(QUIT_AFTER_QUESTION);
    expect(savedDrafts().includes(subject)).toBe(kept);
  });
}

// A crashed page can't answer the question, so it can't hold up the quit either.
for (const where of ['reading pane', 'compose window']) {
  test(`a quit from the tray finishes when the ${where} crashes while it asks`, async () => {
    let asking = win;
    if (where === 'reading pane') {
      await inlineDraft('Lost in a crash', 'Some words');
      await closeMain();
      await expect.poll(visible).toBe(false);
    } else asking = await composeDraft('Lost in a crash');
    await watchQuit();
    await trayMenu('quit');
    await expect(asking.locator('.scrim')).toContainText('Save draft?');
    const page = where === 'reading pane' ? 'index.html' : 'compose.html';
    await app.evaluate(({ BrowserWindow }, page) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith(page)).webContents.forcefullyCrashRenderer(), page);
    expect(await quitEvents()).toEqual(QUIT_AFTER_QUESTION);
  });
}

test('the end of the Windows session cleans up while only a compose window asks', async () => {
  const compose = await composeDraft('Asking at sign-out');
  await trayMenu('quit');
  await expect(compose.locator('.scrim')).toContainText('Save draft?');
  await expect.poll(main).toBeNull();
  await watchQuit();
  // Only the compose window is left to hear it.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].emit('session-end'));
  const lines = () => (fs.existsSync(quitLog) ? fs.readFileSync(quitLog, 'utf8').trim().split(/\r?\n/) : []);
  await expect.poll(lines).toEqual(['engine flushed', 'tray removed', 'agents closed']);
  expect(await tray()).toBeNull();
  fs.rmSync(quitLog, { force: true });
});

test('with both settings off there is no tray icon, and closing the window quits as before', async () => {
  await win.click('[data-action="settings"]');
  const row = win.locator('.settings [data-a="toggle:closeToTray"]');
  await expect(row).toContainText('Close to the tray');
  await row.click();
  await expect(row.locator('.switch')).not.toHaveClass(/\bon\b/);
  expect(saved()).toMatchObject({ closeToTray: false, minimizeToTray: false });
  expect(await tray()).toBeNull();
  await win.click('.settings [data-a="back"]');

  // Minimizing leaves the window on the taskbar.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize());
  await expect.poll(main).toMatchObject({ hidden: false, minimized: true });

  await watchQuit();
  await closeMain();
  expect(await quitEvents()).toEqual(['engine flushed', 'before-quit', 'agents closed', 'will-quit']);
});

test('only minimize to the tray: closing quits, minimizing hides', async () => {
  await win.evaluate(() => window.mail.call('updateSettings', { closeToTray: false, minimizeToTray: true }));
  expect(await tray()).not.toBeNull();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize());
  await expect.poll(main).toMatchObject({ hidden: true, minimized: true });
  await trayClick();
  await expect.poll(main).toMatchObject({ hidden: false, visible: true, minimized: false });
  await watchQuit();
  await closeMain();
  expect(await quitEvents()).toEqual(['engine flushed', 'before-quit', 'tray removed', 'agents closed', 'will-quit']);
});

test('starting Rukoo again shows the hidden window, and the end of the Windows session lets it close', async () => {
  await closeMain();
  await expect.poll(visible).toBe(false);
  // What a second start sends to the running app (tests run without the single-instance lock).
  await app.evaluate(({ app }) => app.emit('second-instance', {}, [], process.cwd()));
  await expect.poll(visible).toBe(true);

  // Windows signs out: no before-quit follows, so main saves now, removes the tray icon and lets the window close.
  await watchQuit();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].emit('session-end'));
  expect(await tray()).toBeNull();
  await closeMain();
  const events = await quitEvents();
  expect(events.slice(0, 3)).toEqual(['engine flushed', 'tray removed', 'agents closed']);
  expect(events).toContain('will-quit');
});

test('a quit after the end of the Windows session still waits for the agents to close', async () => {
  await watchQuit();
  // Closing the agents takes a while, as a stop request to Hermes or the kill of a process tree can.
  await app.evaluate((_electron, file) => {
    const fs = process.mainModule.require('fs');
    const log = (what) => fs.appendFileSync(file, `${what}\n`);
    const calendars = global.__semCalendars;
    const flush = calendars.flush.bind(calendars);
    calendars.flush = () => {
      log('calendars flushed');
      return flush();
    };
    const hub = global.__semAgents;
    const dispose = hub.dispose.bind(hub);
    hub.dispose = () => dispose().then(() => new Promise((resolve) => setTimeout(resolve, 1200))).then(() => log('agents done'));
  }, quitLog);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].emit('session-end'));
  // Windows lets the window close, and the quit that follows waits for the agents session-end started closing.
  await closeMain();
  const events = await quitEvents();
  expect(events.slice(0, 4)).toEqual(['engine flushed', 'calendars flushed', 'tray removed', 'agents closed']);
  expect(events.slice(-2)).toEqual(['will-quit', 'agents done']);
});
