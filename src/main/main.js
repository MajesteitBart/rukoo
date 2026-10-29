'use strict';

const { t } = require('../i18n');

const path = require('path');
const fs = require('fs');
const os = require('os');
const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  safeStorage,
  nativeTheme,
  nativeImage,
  Notification,
  Menu,
  screen
} = require('electron');
const { Engine } = require('./engine');
const { cleanSignatureHtml } = require('./signature');
const { Calendars } = require('./calendar');
const { GoogleAuth } = require('./google');
const { RISKY, safeName, markOfTheWeb } = require('./files');
const { WindowState } = require('./windowstate');
const { Logos, siteOf } = require('./logos');
const { oneClickUnsubscribe } = require('./net');
const { nextZoom, zoomKey } = require('./zoom');
const { TrayIcon } = require('./tray');
const mailto = require('./mailto');
const { MailClient, SETTINGS_URL } = require('./mailclient');
const { LinuxMailClient, DESKTOP } = require('./linux-mailclient');
const { windowChrome, MailtoQueue, MacMailClient, macMenu } = require('./desktop');
// ---- agents ----
const { clipboard, powerMonitor } = require('electron');
const { AgentHub } = require('./agents');
const { AccountService } = require('./account');
const { Categories } = require('./categories');
const { MailNotices } = require('./categories/notices');
const { rukoo: PACKAGE_RUKOO = {} } = require('../../package.json');
const { UpdateChecker } = require('./updates');
// The version whose "What's new" guide everyone sees once, on the first start of it.
const WHATS_NEW = '2.1.0';
const { PanelGate } = require('./agents/gate');
// ---- /agents ----
const { free: freeTime } = require('./calendar/free');
const { Booking } = require('./booking');
const { ReminderRunner, reminderNotice } = require('./calendar/reminder-runner');

// Windows takes the taskbar icon and the handler for notification clicks from the Start menu shortcut with this ID,
// and Electron writes such a shortcut the first time it shows a notification. A run from a checkout gets its own ID,
// or its shortcut (named Electron, pointing at the checkout) takes over the installed app's icon.
const APP_ID = app.isPackaged ? 'nl.bvdm.rukoo-mail' : 'nl.bvdm.rukoo-mail.dev';
const ICON = path.join(__dirname, '..', '..', 'build', 'icon.png');
const DARK_BAR = { color: '#141519', symbolColor: '#e6e8ee', height: 40 };
const LIGHT_BAR = { color: '#f4f5f7', symbolColor: '#1a1c22', height: 40 };
const RENDERER = path.join(__dirname, '..', 'renderer');
const WEB_PREFERENCES = {
  preload: path.join(__dirname, 'preload.js'),
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  spellcheck: true
};

// Before the rename to Rukoo Mail the app kept its data in %APPDATA%\E-mail. Electron has already created an
// empty folder under the new name by now, so swap it for the old one. If the old folder is in use, keep using it
// for this run and try again next launch.
function adoptLegacyData() {
  const legacy = path.join(app.getPath('appData'), 'E-mail');
  const target = app.getPath('userData');
  if (!fs.existsSync(path.join(legacy, 'data'))) return;
  if (fs.existsSync(target) && fs.readdirSync(target).length) return;
  try {
    if (fs.existsSync(target)) fs.rmdirSync(target);
    fs.renameSync(legacy, target);
  } catch {
    app.setPath('userData', legacy);
  }
}

if (process.env.SEM_DATA_DIR) app.setPath('userData', process.env.SEM_DATA_DIR);
else adoptLegacyData();
if (process.platform === 'win32') app.setAppUserModelId(APP_ID);
if (process.platform === 'linux') app.setDesktopName(DESKTOP);

let win = null;
// Open compose windows by webContents id, with the options they were opened with.
const composeWindows = new Map();
let windowState = null;
let logos = null;
let engine = null;
let calendars = null;
let google = null;
let account = null;
let categories = null;
let mailNotices = null;
let updates = null;
let syncTimer = null;
let newSinceFocus = 0;
let tray = null;
// Set once Rukoo really quits, so the main window closes instead of hiding in the tray. A window with unsaved
// changes holds the quit while it asks about them, and can call it off; see watchQuit().
let quitting = false;
// The windows (by webContents id) that hold the quit while they ask.
const quitAsks = new Set();
// ---- agents ----
let hub = null;
// Holds the agent events the chat panel must not miss until it listens; see agents/gate.js.
let agentGate = null;
// ---- /agents ----
// The booking service and the reminder runner. Null until they are made after the categories, so calendarFree can already ask.
let booking = null;
let reminders = null;

if (!process.env.SEM_DATA_DIR && !app.requestSingleInstanceLock()) {
  app.quit();
}

const secrets = require('./secrets').createSecrets(safeStorage);

// Events for the main window only.
function send(type, payload) {
  if (win && !win.isDestroyed()) win.webContents.send('mail:event', { type, payload });
}

function windows() {
  return [win, ...[...composeWindows.values()].map((c) => c.win)].filter((w) => w && !w.isDestroyed());
}

function broadcast(type, payload) {
  for (const w of windows()) w.webContents.send('mail:event', { type, payload });
}

function themeColors() {
  const dark = nativeTheme.shouldUseDarkColors;
  return { bar: dark ? DARK_BAR : LIGHT_BAR, background: dark ? DARK_BAR.color : LIGHT_BAR.color };
}

function applyTheme() {
  nativeTheme.themeSource = engine.settings.theme === 'light' ? 'light' : engine.settings.theme === 'dark' ? 'dark' : 'system';
  const { bar, background } = themeColors();
  for (const w of windows()) {
    if (process.platform !== 'darwin') w.setTitleBarOverlay(bar);
    w.setBackgroundColor(background);
  }
}

function scheduleSync() {
  clearInterval(syncTimer);
  const minutes = Number(engine.settings.syncInterval) || 0;
  // Errors are stored per account and shown in the list and the calendar; nothing to do with them here.
  if (minutes > 0) {
    syncTimer = setInterval(() => {
      engine.syncAll().catch(() => {});
      calendars.syncAll().catch(() => {});
    }, minutes * 60000);
  }
}

function badgeCount() {
  if (engine.settings.badge === 'none') return 0;
  if (engine.settings.badge === 'unread') return engine.unreadCount();
  return newSinceFocus;
}

function refreshBadge() {
  if (process.platform === 'darwin') app.dock?.setBadge(badgeCount() ? String(badgeCount()) : '');
  send('badge', badgeCount());
  refreshTray();
}

// The tray icon is there while closing or minimizing hides the main window, so the window can always come back.
function updateTray() {
  const wanted = engine.settings.closeToTray || engine.settings.minimizeToTray;
  if (wanted && !tray) {
    tray = new TrayIcon({
      icon: ICON,
      platform: process.platform,
      scaleFactor: screen.getPrimaryDisplay().scaleFactor,
      test: Boolean(process.env.SEM_HIDDEN),
      actions: {
        open: showWindow,
        compose: () => openComposeWindow({ mode: 'new' }),
        sync: () => engine.syncAll().catch(() => {}),
        quit: () => app.quit()
      }
    });
    refreshTray();
  }
  if (!wanted && tray) destroyTray();
  if (process.env.SEM_HIDDEN) global.__semTray = tray;
}

// The tooltip counts unread mail. The icon gets a dot while the taskbar badge has a count, because the badge
// isn't visible while the window is hidden.
function refreshTray() {
  if (tray) tray.update({ unread: engine.unreadCount(), dot: badgeCount() > 0 });
}

// Removed before Rukoo exits; an icon left behind stays in the notification area until the mouse passes over it.
function destroyTray() {
  if (tray) tray.destroy();
  tray = null;
  if (process.env.SEM_HIDDEN) global.__semTray = null;
}

// The badge counts first. The notifications get the whole batch: they skip the categories muted on this computer, and
// mail Jev is about to sort waits for its category (categories/notices.js).
function notify(messages) {
  newSinceFocus += messages.length;
  refreshBadge();
  if (!engine.settings.notifications || !Notification.isSupported()) return;
  if (win && win.isFocused()) return;
  mailNotices.add(messages);
}

// Now, or once Jev sorted the mail, so the window may have come forward meanwhile.
function showMailNotices(list) {
  if (!engine.settings.notifications || (win && win.isFocused())) return;
  for (const { id, title, body } of list) {
    if (!id) {
      new Notification({ title, body }).show();
      continue;
    }
    // nativeImage can read from inside app.asar; a plain path cannot.
    const n = new Notification({ title, body, icon: nativeImage.createFromPath(ICON), silent: false });
    n.on('click', () => {
      showWindow();
      send('open-message', id);
    });
    n.show();
  }
}

// Shown notifications stay referenced until they close, or Windows can drop their click handler with the object.
const liveNotices = new Set();

// A desktop notification whose click brings the main window forward on the calendar, at the event or request.
// Test mode records them instead of showing them, so a test run never puts toasts on the screen.
function calendarNotice({ title, body, open }) {
  if (process.env.SEM_HIDDEN) {
    (global.__semNotices ||= []).push({ title, body, open });
    return;
  }
  if (!Notification.isSupported()) return;
  const n = new Notification({ title: String(title).slice(0, 200), body: String(body).slice(0, 400), icon: nativeImage.createFromPath(ICON), silent: false });
  liveNotices.add(n);
  const drop = () => liveNotices.delete(n);
  n.on('click', () => {
    drop();
    showWindow();
    if (open) send('calendar-open', open);
  });
  n.on('close', drop);
  n.on('failed', drop);
  n.show();
}

// Calendar reminders: always a desktop notification, also while Rukoo is focused (design 2.8).
function showReminders(list) {
  if (list.length) calendarNotice(reminderNotice(list));
}

// Booking news (design 1.2): a toast while the main window is focused, a desktop notification otherwise. open:
// { id, start } for an event, { request } for a request, { start } for the day a cancelled booking was on.
function showBookingNotification({ title, body, open }) {
  if (win && !win.isDestroyed() && win.isFocused() && !process.env.SEM_HIDDEN) {
    send('toast', String(body).slice(0, 200));
    return;
  }
  calendarNotice({ title, body, open });
}

function showWindow() {
  if (!win || win.isDestroyed()) {
    createWindow();
    return;
  }
  // showInactive() does not restore minimized windows on Linux. Restore in both launch modes.
  if (win.isMinimized()) win.restore();
  // Test mode keeps the window off-screen and leaves the focus alone; see reveal().
  if (process.env.SEM_HIDDEN) {
    win.showInactive();
    return;
  }
  win.show();
  win.focus();
}

function safeUrl(url) {
  return /^(https?:|mailto:)/i.test(String(url || ''));
}

// A mailto: link, from a message, an agent or another app, opens a filled-in compose window; the user sends it.
// Without an account the compose window says so, and the main window comes forward to add one.
function openMailto(url) {
  if (!engine.accounts.length) showWindow();
  openComposeWindow({ mode: 'new', ...mailto.parse(url) });
}

function openUrl(url) {
  if (mailto.isMailto(url)) {
    openMailto(url);
    return;
  }
  if (safeUrl(url)) shell.openExternal(url);
}

// Windows can only offer the installed or portable app for mailto: links. A run from a checkout or a test profile
// leaves the registration alone.
function mailClient() {
  if (process.platform !== 'win32' || !app.isPackaged || process.env.SEM_DATA_DIR) return null;
  // The portable build runs from a temporary copy; Windows has to start the .exe the user keeps.
  const exe = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
  return new MailClient({ exe, description: t('settings.general.mailtoAppDescription') });
}

// See MailClient.refresh(): the installed app offers itself to Windows at startup, a portable copy when asked.
async function refreshMailClient() {
  const client = mailClient();
  if (client) await client.refresh({ portable: Boolean(process.env.PORTABLE_EXECUTABLE_FILE) });
}

// Links never navigate an app window; they open in the browser or, for mailto:, in a compose window.
function harden(w) {
  w.webContents.setWindowOpenHandler(({ url }) => {
    openUrl(url);
    return { action: 'deny' };
  });
  w.webContents.on('will-navigate', (e, url) => {
    if (url !== w.webContents.getURL()) {
      e.preventDefault();
      openUrl(url);
    }
  });
  w.webContents.on('will-frame-navigate', (e) => {
    // Clicks inside a mail frame must never replace the frame contents.
    if (!e.isMainFrame && !/^(about:|data:)/.test(e.url)) {
      e.preventDefault();
      openUrl(e.url);
    }
  });
  // Electron's own listener for these events asks the window whether it is visible, which throws once the window is
  // destroyed. macOS can still report a visibility change for a window that just closed, and the error then opens
  // Electron's error box, which holds up the main process, a quit included, until it is closed. A closed window needs
  // none of these events.
  w.once('closed', () => {
    for (const event of ['show', 'hide', 'minimize', 'maximize', 'restore']) w.removeAllListeners(event);
  });
}

// One zoom level for the main window and every compose window. Settings follows it through the 'zoom' event;
// nothing else in the windows depends on it, so it is saved without the 'updated' redraw.
function setZoom(level) {
  if (level === engine.settings.zoomLevel) return level;
  const { zoomLevel } = engine.updateSettings({ zoomLevel: level }, { quiet: true });
  for (const w of windows()) w.webContents.setZoomFactor(zoomLevel / 100);
  broadcast('zoom', zoomLevel);
  return zoomLevel;
}

// The main process sees the zoom keys before the page does, also with the focus inside an email's frame,
// whose keydown events never reach the page's own handler. Stopping them here keeps them from the page.
// Ctrl+mouse wheel only raises zoom-changed: Electron doesn't zoom by itself. A page starts at the zoom
// Chromium keeps for its file, so the stored level is applied once the page commits.
function watchZoom(w) {
  const contents = w.webContents;
  contents.on('before-input-event', (event, input) => {
    const action = zoomKey(input);
    if (!action) return;
    event.preventDefault();
    setZoom(nextZoom(engine.settings.zoomLevel, action));
  });
  contents.on('zoom-changed', (_event, direction) => setZoom(nextZoom(engine.settings.zoomLevel, direction)));
  contents.on('did-navigate', () => contents.setZoomFactor(engine.settings.zoomLevel / 100));
}

// How a window takes part in a quit. A window with unsaved changes stops a quit from its beforeunload and asks
// what to do with them; Electron then stops quitting. Rukoo holds the quit until every window that asks has
// answered (see answered()) and keeps syncing meanwhile. The main window shows, because its question could
// otherwise wait in the tray.
function watchQuit(w) {
  const id = w.webContents.id;
  w.webContents.on('will-prevent-unload', () => {
    if (!quitting) return;
    quitAsks.add(id);
    scheduleSync();
    if (w === win) showWindow();
  });
  // A window that closes has answered: its changes are saved or let go.
  w.on('closed', () => answered(id, true));
  // A crashed page can't answer any more, and its unsaved changes are gone with it.
  w.webContents.on('render-process-gone', () => answered(id, true));
  w.on('session-end', endSession);
}

// closed: the editor closed after Save or Don't save, so the quit goes on once no other window still asks.
// Otherwise (Cancel, or a save that failed) the window stays open and Rukoo stays running.
function answered(id, closed) {
  if (!quitAsks.delete(id)) return;
  if (!closed) {
    quitAsks.clear();
    quitting = false;
    // The main window closed before the quit was called off. Rukoo stays in the tray with a hidden main window, as
    // after any close: the agents' tools need it, and only a window hears that the Windows session ends.
    if (!win && (process.platform === 'darwin' || engine.settings.closeToTray)) createWindow({ hidden: true });
    return;
  }
  // Without windows left, window-all-closed has quit already; a second quit would cut will-quit's wait short.
  if (!quitAsks.size) setImmediate(() => (process.platform === 'darwin' || windows().length) && app.quit());
}

// Windows is signing out or shutting down. No before-quit or will-quit follows, and Windows ends Rukoo soon after,
// so save now, stop waiting for answers and take the tray icon away. Every window hears it, and the main window may
// already be gone; this runs once, for the first.
let sessionEnded = false;
function endSession() {
  if (sessionEnded) return;
  sessionEnded = true;
  quitting = true;
  quitAsks.clear();
  clearInterval(syncTimer);
  engine.flush();
  if (calendars) calendars.flush();
  if (account) account.close();
  if (categories) categories.close();
  if (mailNotices) mailNotices.close();
  if (reminders) reminders.stop();
  if (booking) booking.close();
  if (updates) updates.stop();
  destroyTray();
  // ---- agents ----
  // dispose() saves the chats before its first await; see will-quit.
  if (hub) closeAgents();
  // ---- /agents ----
}

// Test mode: a never-shown window does not paint, so park it off-screen without focus. hidden: the window starts in
// the tray and shows later, through showWindow().
function reveal(w, maximized = false, hidden = false) {
  w.once('ready-to-show', () => {
    if (process.env.SEM_HIDDEN) {
      w.setPosition(-5000, -5000);
      if (!hidden) w.showInactive();
      return;
    }
    if (hidden) {
      if (maximized) w.once('show', () => w.maximize());
      return;
    }
    if (maximized) w.maximize();
    w.show();
  });
}

const COMPOSE_MODES = new Set(['new', 'reply', 'replyAll', 'forward', 'draft']);

function composeOptions(input = {}) {
  const text = (v, max) => String(v || '').slice(0, max);
  const people = (list) =>
    (Array.isArray(list) ? list : []).slice(0, 100).map((a) => ({ name: text(a && a.name, 200), address: text(a && a.address, 320) }));
  return {
    mode: COMPOSE_MODES.has(input.mode) ? input.mode : 'new',
    id: input.id ? text(input.id, 2000) : null,
    accountId: input.accountId ? text(input.accountId, 200) : null,
    to: people(input.to),
    cc: people(input.cc),
    bcc: people(input.bcc),
    subject: text(input.subject, 1000),
    body: text(input.body, 20000)
  };
}

function openComposeWindow(input) {
  const opts = composeOptions(input);
  if (opts.mode === 'draft' && opts.id) {
    const open = [...composeWindows.values()].find((c) => c.draftId === opts.id && !c.win.isDestroyed());
    if (open) {
      open.win.show();
      open.win.focus();
      return true;
    }
  }
  const b = windowState.bounds('compose', { width: 880, height: 780, minWidth: 560, minHeight: 460 });
  // A second compose window opens slightly offset, so the first stays visible behind it.
  const others = windows().filter((w) => w !== win);
  const last = others[others.length - 1];
  const pos = last ? { x: last.getBounds().x + 28, y: last.getBounds().y + 28 } : Number.isFinite(b.x) ? { x: b.x, y: b.y } : {};
  const { bar, background } = themeColors();
  const w = new BrowserWindow({
    width: b.width,
    height: b.height,
    ...pos,
    minWidth: 560,
    minHeight: 460,
    show: false,
    title: t('composer.titles.new'),
    icon: fs.existsSync(ICON) ? ICON : undefined,
    backgroundColor: background,
    ...windowChrome(process.platform, bar),
    webPreferences: WEB_PREFERENCES
  });
  const id = w.webContents.id;
  composeWindows.set(id, { win: w, opts, draftId: opts.mode === 'draft' ? opts.id : null });
  w.on('closed', () => composeWindows.delete(id));
  harden(w);
  watchZoom(w);
  watchQuit(w);
  if (!process.env.SEM_HIDDEN) windowState.track('compose', w);
  reveal(w);
  w.loadFile(path.join(RENDERER, 'compose.html'));
  return true;
}

async function saveAllAttachments(id) {
  const full = await engine.getMessage(id);
  const list = full.attachments || [];
  if (!list.length) return 0;
  const res = await dialog.showOpenDialog(win, {
    title: t('native.attachments.directory'),
    defaultPath: app.getPath('downloads'),
    properties: ['openDirectory', 'createDirectory']
  });
  if (res.canceled || !res.filePaths[0]) return 0;
  const dir = res.filePaths[0];
  for (const att of list) {
    const a = await engine.attachment(id, att.index);
    const name = safeName(a.filename);
    const ext = path.extname(name);
    let file = path.join(dir, name);
    for (let n = 2; fs.existsSync(file); n++) file = path.join(dir, `${path.basename(name, ext)} (${n})${ext}`);
    fs.writeFileSync(file, a.content);
    markOfTheWeb(file);
  }
  return list.length;
}

async function tempAttachment(id, index) {
  const a = await engine.attachment(id, index);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rukoo-mail-'));
  const file = path.join(dir, safeName(a.filename));
  fs.writeFileSync(file, a.content);
  markOfTheWeb(file);
  return file;
}

async function printHtml(html) {
  const printer = new BrowserWindow({ show: false, webPreferences: { javascript: false, sandbox: true } });
  await printer.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  await new Promise((resolve) => printer.webContents.print({}, () => resolve()));
  printer.destroy();
}

// The calendar view's arguments. The calendar store checks the fields of an event again.
const plainObject = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
// Text from the renderer for the account calls; anything else reads as empty, which the account refuses.
const accountText = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
// The calendar calls' arguments, checked in calendar/ipc.js (which has its own tests).
const {
  calendarRange,
  calendarInput,
  calendarScope,
  calendarEtag,
  calendarSeriesEtag,
  calendarEventId,
  calendarCalendarId,
  calendarConflicts,
  calendarFreeOpts
} = require('./calendar/ipc');

// Every renderer call goes through this table; nothing else is reachable from the UI.
const api = {
  // The booking page's address while it is on, and its language, for the footer and the composer (contracts f).
  state: () => ({ ...engine.state(), bookingUrl: booking ? booking.url() : null, bookingLocale: booking ? booking.locale() : null }),
  list: (opts) => engine.listMessages(opts),
  counts: (scope) => engine.counts(scope),
  contacts: () => engine.contacts(),
  get: (id) => engine.getMessage(id),
  setFlags: (id, flags) => engine.setFlags(id, flags),
  archive: (id) => engine.archive(id),
  canUndo: (id) => engine.canUndo(id),
  undoMove: (id) => engine.undoMove(id),
  markAllRead: (scope, view, folder) => engine.markAllRead(scope, view, folder),
  move: (id, dest) => engine.move(id, dest),
  remove: (id, opts) => (String(id).startsWith('saved:') ? engine.deleteSaved(id) : engine.remove(id, opts)),
  emptyFolder: (accountId, folder) => engine.emptyFolder(accountId, folder),
  toggleVip: (address) => engine.toggleVip(address),
  markSpam: (id) => engine.markSpam(id),
  removeSpam: (address) => engine.updateSettings({ spam: engine.settings.spam.filter((a) => a !== address) }),
  saveToDevice: (id) => engine.saveToDevice(id),
  send: async (payload) => {
    await engine.send(payload);
    // Sending removed the draft; an agent's draft cards that pointed at it keep none.
    if (hub && payload && payload.draftId) hub.draftMoved(String(payload.draftId), null);
    send('toast', t('composer.status.sent'));
    return true;
  },
  openCompose: (opts) => openComposeWindow(opts),
  // A draft already open in a compose window is brought forward there instead of opening twice.
  draftWindow: (id) => {
    const open = [...composeWindows.values()].find((c) => c.draftId && c.draftId === id && !c.win.isDestroyed());
    if (!open) return false;
    open.win.show();
    open.win.focus();
    return true;
  },
  toastMain: (message) => send('toast', String(message || '').slice(0, 200)),
  // A save replaces the stored draft; an agent's draft cards follow it, also from a compose window.
  saveDraft: async (payload) => {
    const id = await engine.saveDraft(payload);
    if (hub && payload && payload.draftId && id) hub.draftMoved(String(payload.draftId), id);
    return id;
  },
  discardDraft: async (id) => {
    const result = await engine.discardDraft(id);
    if (hub && id) hub.draftMoved(String(id), null);
    return result;
  },
  addAccount: (input) => engine.addAccount(input),
  updateAccount: (id, patch) => engine.updateAccount(id, patch),
  // The signature editor in Settings shows pasted HTML the way it will be stored.
  cleanSignature: (html) => cleanSignatureHtml(typeof html === 'string' ? html : ''),
  removeAccount: (id) => engine.removeAccount(id),
  updateSettings: (patch) => {
    const s = engine.updateSettings(patch);
    if ('theme' in patch) applyTheme();
    if ('language' in patch) {
      broadcast('language');
      if (tray) tray.relabel();
    }
    if ('syncInterval' in patch) scheduleSync();
    if ('closeToTray' in patch || 'minimizeToTray' in patch) updateTray();
    if ('badge' in patch) refreshBadge();
    return s;
  },
  // Settings → General resets it; the keys and the wheel go through watchZoom.
  setZoom: (level) => setZoom(level),
  sync: (accountId) => (accountId ? engine.syncAccount(accountId) : engine.syncAll()).then(() => true),
  openFolder: (accountId, folder) => engine.openFolder(accountId, folder),
  pickFiles: async () => {
    const res = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'], title: t('composer.attachments.pick') });
    if (res.canceled) return [];
    return res.filePaths.map((p) => ({ path: p, filename: path.basename(p), size: fs.statSync(p).size }));
  },
  pickImage: async () => {
    const res = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      title: t('composer.attachments.image'),
      filters: [{ name: t('native.attachments.images'), extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }]
    });
    if (res.canceled || !res.filePaths[0]) return null;
    const file = res.filePaths[0];
    const ext = path.extname(file).slice(1).toLowerCase().replace('jpg', 'jpeg');
    return `data:image/${ext};base64,${fs.readFileSync(file).toString('base64')}`;
  },
  openAttachment: async (id, index) => {
    const a = await engine.attachment(id, index);
    if (RISKY.test(safeName(a.filename))) {
      const res = await dialog.showMessageBox(win, {
        type: 'warning',
        title: t('native.attachments.open'),
        message: t('native.attachments.riskyTitle', { filename: safeName(a.filename) }),
        detail: t('native.attachments.riskyHelp'),
        buttons: [t('common.actions.cancel'), t('native.attachments.save')],
        defaultId: 0,
        cancelId: 0
      });
      if (res.response === 1) return api.saveAttachment(id, index);
      return false;
    }
    const file = await tempAttachment(id, index);
    const err = await shell.openPath(file);
    if (err) throw new Error(err);
    return true;
  },
  saveAttachment: async (id, index) => {
    const a = await engine.attachment(id, index);
    const res = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath('downloads'), safeName(a.filename)) });
    if (res.canceled || !res.filePath) return false;
    fs.writeFileSync(res.filePath, a.content);
    markOfTheWeb(res.filePath);
    return res.filePath;
  },
  saveAllAttachments: (id) => saveAllAttachments(id),
  // A thumbnail for image attachments; other types (and SVG, which can carry script) get none.
  attachmentPreview: async (id, index) => {
    const a = await engine.attachment(id, index);
    const type = String(a.contentType || '').toLowerCase();
    if (!/^image\/(png|jpe?g|gif|webp)$/.test(type) || a.content.length > 8 * 1024 * 1024) return null;
    return `data:${type};base64,${a.content.toString('base64')}`;
  },
  unsubscribe: async (id) => {
    const m = await engine.getMessage(id);
    const u = m.unsubscribe;
    if (!u) throw new Error(t('errors.unsubscribe.missing'));
    const acc = engine.messageAccount(id);
    if (acc && acc.type === 'demo') return { done: true };
    // Only a 2xx from the endpoint itself counts; a redirect or failure falls back to the page in the browser.
    if (u.oneClick && (await oneClickUnsubscribe(u.url))) return { done: true };
    if (u.url) {
      shell.openExternal(u.url);
      return { opened: true };
    }
    // The link for agents, which open it themselves; its fields for the reader's composer.
    return { mailto: u.mail, message: mailto.parse(u.mail) };
  },
  createFolder: (accountId, name) => engine.createFolder(accountId, name),
  senderLogos: (addresses) => {
    if (engine.settings.senderLogos === false) return {};
    const bySite = {};
    for (const a of (Array.isArray(addresses) ? addresses : []).slice(0, 300)) {
      const site = siteOf(a);
      if (site) bySite[a] = site;
    }
    return logos.get(Object.values(bySite)).then((found) => {
      const out = {};
      for (const [address, site] of Object.entries(bySite)) out[address] = found[site] || null;
      return out;
    });
  },
  exportEml: async (id) => {
    const full = await engine.getMessage(id);
    const name = `${(full.subject || t('native.export.defaultName')).replace(/[<>:"/\\|?*]/g, '_').slice(0, 80)}.eml`;
    const res = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath('documents'), name) });
    if (res.canceled || !res.filePath) return false;
    fs.writeFileSync(res.filePath, await engine.rawSource(id));
    return res.filePath;
  },
  openExternal: (url) => openUrl(url),
  updatesState: () => updates.state(),
  updatesCheck: () => updates.check({ force: true }),
  // Only the release page that was found opens; the renderer can't pass another address.
  updatesOpen: () => {
    const found = updates.available;
    if (found && /^https:\/\/github\.com\//.test(found.url)) shell.openExternal(found.url);
  },
  // The "What's new" guide shows once per version. Hidden test windows skip it unless they ask (SEM_WHATS_NEW=1);
  // visible ones, such as the macOS tests, say SEM_WHATS_NEW=0.
  whatsNewState: () => ({
    version: WHATS_NEW,
    show:
      engine.settings.whatsNewSeen !== WHATS_NEW &&
      process.env.SEM_WHATS_NEW !== '0' &&
      (!process.env.SEM_HIDDEN || process.env.SEM_WHATS_NEW === '1')
  }),
  whatsNewDone: () => {
    engine.updateSettings({ whatsNewSeen: WHATS_NEW }, { quiet: true });
    return true;
  },
  // Which app opens mailto: links now, for Settings. available: false where Rukoo can't offer itself.
  mailtoStatus: async () => {
    if (process.platform === 'darwin') return new MacMailClient(app, Boolean(process.env.SEM_DATA_DIR)).status();
    if (process.platform === 'linux') {
      const client = new LinuxMailClient();
      const status = await client.status();
      return { ...status, available: status.available && app.isPackaged && !process.env.SEM_DATA_DIR, linux: true };
    }
    const client = mailClient();
    const own = client ? path.resolve(client.exe).toLowerCase() : null;
    let handler = null;
    try {
      handler = await app.getApplicationInfoForProtocol('mailto:');
    } catch (_) {
      // No app opens them.
    }
    return {
      available: Boolean(client),
      app: handler && handler.name ? String(handler.name) : null,
      rukoo: Boolean(own && handler && handler.path && path.resolve(handler.path).toLowerCase() === own)
    };
  },
  // Offers Rukoo for mailto: links and opens the Windows page where the user picks it.
  useForMailto: async () => {
    if (process.platform === 'darwin') {
      const client = new MacMailClient(app, Boolean(process.env.SEM_DATA_DIR));
      if (!client.available) throw new Error(t('settings.general.mailtoMacUnavailable'));
      if (!client.register()) throw new Error(t('settings.general.mailtoMacFailed'));
      return true;
    }
    if (process.platform === 'linux') {
      if (!app.isPackaged || process.env.SEM_DATA_DIR) throw new Error(t('settings.general.mailtoLinuxUnavailable'));
      if (!await new LinuxMailClient().register()) throw new Error(t('settings.general.mailtoLinuxFailed'));
      return true;
    }
    const client = mailClient();
    if (!client) throw new Error(t('settings.general.mailtoUnavailable'));
    await client.register();
    await shell.openExternal(SETTINGS_URL);
    return true;
  },
  print: (html) => printHtml(html),
  setBadge: (dataUrl, count) => {
    if (!win || process.platform !== 'win32') return;
    if (!dataUrl || !count) win.setOverlayIcon(null, '');
    else win.setOverlayIcon(nativeImage.createFromDataURL(dataUrl), t('native.notifications.newCount', { count }));
  },
  googleSignIn: async () => {
    const grant = await google.signIn();
    showWindow();
    return engine.addGoogleAccount(grant);
  },
  googleReauth: async (accountId) => {
    const grant = await google.signIn(engine.account(accountId).email);
    showWindow();
    const acc = await engine.addGoogleAccount(grant, { reauthId: accountId });
    calendars.reconnected(accountId);
    return acc;
  },
  calendarView: (range) => calendars.view(calendarRange(range)),
  calendarSync: (accountId) => (accountId ? calendars.syncAccount(String(accountId)) : calendars.syncAll()).then(() => true),
  calendarEvent: (id) => calendars.event(calendarEventId(id)),
  // A booking id or uid never comes from a window: only the booking service makes booking events.
  calendarCreate: (input, opts) => calendars.create(calendarInput(input), { notify: plainObject(opts).notify === true }),
  calendarUpdate: (id, input, opts) =>
    calendars.update(calendarEventId(id), calendarInput(input), { notify: plainObject(opts).notify === true, etag: calendarEtag(opts), scope: calendarScope(opts), seriesEtag: calendarSeriesEtag(opts) }),
  calendarDelete: (id, opts) =>
    calendars.remove(calendarEventId(id), {
      notify: plainObject(opts).notify === true,
      series: plainObject(opts).series === true,
      scope: plainObject(opts).scope === undefined ? undefined : calendarScope(opts),
      etag: calendarEtag(opts),
      seriesEtag: calendarSeriesEtag(opts)
    }),
  calendarRespond: (id, response, opts) => calendars.respond(calendarEventId(id), String(response), { series: plainObject(opts).series === true }),
  calendarSeries: (id) => calendars.series(calendarEventId(id)),
  calendarMove: (id, calendarId, opts) => calendars.move(calendarEventId(id), calendarCalendarId(calendarId), { notify: plainObject(opts).notify === true }),
  calendarSearch: (query) => calendars.search(typeof query === 'string' && query.length <= 200 ? query : ''),
  calendarFree: (opts) => freeTime(calendars, engine.settings, booking ? booking.hours() : null, calendarFreeOpts(opts)),
  // Settings pages and the booking setup may open before the calendar view ever did: accounts whose calendars were
  // never read get them first, without the view's fetch.
  calendarList: () => calendars.loadCalendars().then(() => calendars.list()),
  calendarConflicts: (opts) => calendars.conflicts(calendarConflicts(opts)),
  calendarSettings: (patch) => {
    const settings = engine.calendarSettings(plainObject(patch));
    // Colours and shown calendars are drawn by the calendar view.
    calendars.emit('updated');
    return settings;
  },
  googleCancel: () => google.cancel(),
  fetchGmailAliases: (accountId) => engine.fetchGmailAliases(accountId),
  googleImportClient: async () => {
    const res = await dialog.showOpenDialog(win, {
      title: t('setup.google.import'),
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    if (res.canceled || !res.filePaths[0]) return false;
    google.importClient(res.filePaths[0]);
    engine.emit('updated');
    return true;
  },
  appInfo: () => ({ version: app.getVersion(), dataDir: app.getPath('userData') }),
  // The Rukoo account (account/index.js). Passwords stay in main: only their keys leave, and only to the server.
  accountStatus: () => account.status(),
  accountServerInfo: () => account.serverInfo(),
  accountSetServer: (url) => account.setServer(accountText(url, 2000)),
  accountSignUp: (input) => {
    const i = plainObject(input);
    return account.signUp({ email: accountText(i.email, 320), password: accountText(i.password, 1000), invite: accountText(i.invite, 200) });
  },
  accountSignIn: (input) => {
    const i = plainObject(input);
    return account.signIn({ email: accountText(i.email, 320), password: accountText(i.password, 1000) });
  },
  accountRecover: (input) => {
    const i = plainObject(input);
    return account.recover({ email: accountText(i.email, 320), recoveryKey: accountText(i.recoveryKey, 200), password: accountText(i.password, 1000) });
  },
  accountSignOut: () => account.signOut(),
  accountDetails: () => account.details(),
  accountRemoveDevice: (id) => account.removeDevice(accountText(id, 200)),
  accountChangePassword: (current, next) => account.changePassword(accountText(current, 1000), accountText(next, 1000)),
  accountNewRecoveryKey: (password) => account.newRecoveryKey(accountText(password, 1000)),
  accountDelete: (password) => account.deleteAccount(accountText(password, 1000)),
  accountSync: () => account.sync(),
  // Inbox categories (categories/index.js).
  categoriesState: () => categories.state(),
  // Prototype for the "What's new" guide.
  categoriesPreview: () => categories.preview(),
  categoriesSeed: () => {
    categories.seed();
    return categories.state();
  },
  categoriesSetEnabled: (on) => categories.setEnabled(on === true),
  categoriesSetUnsure: (id) => categories.setUnsure(accountText(id, 100)),
  categoriesSave: (input) => {
    const i = plainObject(input);
    const optional = (v, max) => (v === null ? null : typeof v === 'string' ? v.slice(0, max) : undefined);
    return categories.saveCategory({ id: accountText(i.id, 100) || null, name: optional(i.name, 100), description: optional(i.description, 1000), color: accountText(i.color, 20) || undefined });
  },
  categoriesRemove: (id) => categories.removeCategory(accountText(id, 100)),
  // Notifications for a category's new mail, on this computer only.
  categoriesSetNotify: (id, on) => categories.setNotify(accountText(id, 100), on === true),
  categoriesReorder: (ids) => categories.reorder((Array.isArray(ids) ? ids : []).slice(0, 50).map((id) => accountText(id, 100))),
  categoriesMove: (ids, category, opts) =>
    // Every selected email: a unified inbox can show several hundred per account.
    categories.move((Array.isArray(ids) ? ids : []).slice(0, 100000).map((id) => accountText(id, 4000)), accountText(category, 100), { sender: plainObject(opts).sender === true }),
  categoriesForgetSender: (address) => categories.forgetSender(accountText(address, 320)),
  categoriesSetJev: (input) => {
    const i = plainObject(input);
    return categories.setJev({ on: typeof i.on === 'boolean' ? i.on : undefined, key: i.key === null ? null : accountText(i.key, 500) || undefined });
  },
  categoriesSortAgain: () => categories.sortAgain(),
  // The booking page (booking/index.js), which checks every field again.
  bookingState: (opts) => booking.load({ refresh: plainObject(opts).refresh === true }),
  bookingEnable: (input) => booking.enable(plainObject(input)),
  bookingSave: (patch) => booking.save(plainObject(patch)),
  bookingDisable: () => booking.disable(),
  bookingCheckHandle: (handle) => booking.checkHandle(accountText(handle, 64)),
  // accept, decline and cancel name a booking; keep and dismiss a notice.
  bookingAction: (id, action, opts) => {
    const kind = accountText(action, 20);
    const pattern = kind === 'keep' || kind === 'dismiss' ? /^[A-Za-z0-9_:.@-]{1,120}$/ : /^[A-Za-z0-9_-]{22}$/;
    const o = plainObject(opts);
    const options = { message: typeof o.message === 'string' ? o.message.slice(0, 2000) : undefined, email: o.email === true, notify: o.notify !== false };
    return booking.action(typeof id === 'string' && pattern.test(id) ? id : '', kind, options);
  },
  bookingDetails: (id) => booking.details(typeof id === 'string' && /^[A-Za-z0-9_-]{22}$/.test(id) ? id : ''),
  bookingSync: () => booking.sync(),
  bookingTakeover: () => booking.takeover(),
  categoriesActivity: () => categories.activity(),
  accountExport: async () => {
    const res = await dialog.showSaveDialog(win, {
      title: t('settings.rukoo.export'),
      defaultPath: path.join(app.getPath('documents'), 'rukoo-account.json'),
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    if (res.canceled || !res.filePath) return false;
    fs.writeFileSync(res.filePath, JSON.stringify(account.exportData(), null, 2));
    return res.filePath;
  }
};

// ---- agents ----
// The chat panel's calls. Arguments are checked here; the hub checks structure and values again.
const agentText = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
const agentId = (v) => {
  if (typeof v !== 'string' || !v || v.length > 200) throw new Error('invalid');
  return v;
};
// A mail id carries its folder path URI-encoded, so it can be far longer than a chat or item id.
const agentMailId = (v) => {
  if (typeof v !== 'string' || !v || v.length > 4000) throw new Error('invalid');
  return v;
};
const agentPlain = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
// A list from the renderer, bounded; the hub checks how many it takes.
const agentList = (v) => (Array.isArray(v) ? v.slice(0, 50) : []);
function agentHub() {
  if (!hub) throw new Error('unknown');
  return hub;
}
function agentMessage(m) {
  if (!m || typeof m !== 'object' || typeof m.id !== 'string' || !m.id) return null;
  const from = m.from && typeof m.from === 'object' ? { name: agentText(m.from.name, 200), address: agentText(m.from.address, 320) } : null;
  return {
    id: m.id.slice(0, 2000),
    messageId: agentText(m.messageId, 1000) || null,
    accountId: agentText(m.accountId, 200) || null,
    subject: agentText(m.subject, 1000),
    from,
    date: Number(m.date) || null,
    unsubscribe: m.unsubscribe === true
  };
}
Object.assign(api, {
  agentConfig: () => agentHub().config(),
  agentUpdateConfig: (patch) => agentHub().updateConfig(agentPlain(patch)),
  agentSetSecret: (agent, value) => agentHub().setSecret(agentId(agent), agentText(value, 4000)),
  agentTest: (agent) => agentHub().test(agentId(agent)),
  agentStatus: () => agentHub().status(),
  agentCopyHermesSetup: () => agentHub().copyHermesSetup(),
  agentCopyOpenClawSetup: () => agentHub().copyOpenClawSetup(),
  // A phone that runs Claude Code and Codex chats here (agents/phonehost.js).
  agentPhonePair: (opts) => agentHub().phonePairStart({ allowExport: agentPlain(opts).allowExport === true }),
  agentPhonePairCancel: () => agentHub().phonePairCancel(),
  agentPhoneUnpair: (id) => agentHub().phoneUnpair(agentId(id)),
  agentPhoneAllowExport: (id) => agentHub().phoneAllowExport(agentId(id)),
  agentList: () => agentHub().list(),
  agentGet: (id) => agentHub().get(agentId(id)),
  agentFindFor: (ref) => {
    const r = agentPlain(ref);
    return agentHub().findFor({ id: agentText(r.id, 2000), messageId: agentText(r.messageId, 1000), accountId: agentText(r.accountId, 200) || null });
  },
  agentRelatedFor: (ref) => {
    const r = agentPlain(ref);
    // A long thread's References can name many emails; the newest are at the end.
    const references = (Array.isArray(r.references) ? r.references : []).slice(-100).map((v) => agentText(v, 1000)).filter(Boolean);
    return agentHub().relatedFor({
      id: agentText(r.id, 2000),
      messageId: agentText(r.messageId, 1000),
      accountId: agentText(r.accountId, 200) || null,
      inReplyTo: agentText(r.inReplyTo, 1000) || null,
      references,
      date: Number(r.date) || null
    });
  },
  agentContinue: (id, message) => agentHub().continueFrom(agentId(id), agentMessage(message)),
  agentLocate: (ref) => {
    const r = agentPlain(ref);
    return agentHub().locate({ id: agentText(r.id, 2000), messageHeader: agentText(r.messageHeader, 1000), accountId: agentText(r.accountId, 200) || null });
  },
  agentCreate: (input) => {
    const i = agentPlain(input);
    return agentHub().create({ agent: agentText(i.agent, 20), message: agentMessage(i.message), model: agentText(i.model, 300) || null, effort: agentText(i.effort, 20) || null });
  },
  agentModels: (agent, options) => agentHub().models(agentId(agent), { refresh: agentPlain(options).refresh === true }),
  // A chat's model and effort; a key that is left out stays as it is, null goes back to the agent's default.
  agentSetChoice: (id, choice) => {
    const c = agentPlain(choice);
    const pick = {};
    if ('model' in c) pick.model = agentText(c.model, 300) || null;
    if ('effort' in c) pick.effort = agentText(c.effort, 20) || null;
    return agentHub().setChoice(agentId(id), pick);
  },
  agentSend: (id, input) => {
    const i = agentPlain(input);
    return agentHub().send(agentId(id), {
      text: agentText(i.text, 20000),
      action: agentText(i.action, 40) || null,
      display: agentText(i.display, 20000) || null,
      skill: agentText(i.skill, 64) || null,
      // Tokens of staged files (agentPickFiles, agentAddFile) and Rukoo ids of emails.
      files: agentList(i.files).map(agentId),
      emails: agentList(i.emails).map(agentMailId)
    });
  },
  // The chat's paperclip opens main's own dialog, so Rukoo reads only what the user picked there. room: how many
  // more files the message takes (chatfiles.stagePaths). Read one by one, in the order picked, without blocking: a
  // file on a slow or network drive must not hold up the windows or any other request.
  agentPickFiles: async (room) => {
    const res = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'], title: t('agent.panel.attach') });
    if (res.canceled) return [];
    return agentHub().stagePaths(res.filePaths, room);
  },
  // A file dropped on the chat or pasted into it. The sandboxed renderer sends its bytes, never a path to open.
  agentAddFile: (input) => {
    const i = agentPlain(input);
    if (!(i.data instanceof Uint8Array)) throw new Error('invalid');
    const name = agentText(i.name, 1000);
    const refused = agentHub().refuseFile(name, i.data.byteLength);
    return refused ? { name, error: refused } : agentHub().stageFile(name, Buffer.from(i.data));
  },
  agentDropFile: (id) => agentHub().unstageFile(agentId(id)),
  agentSkills: () => agentHub().skillList(),
  // The skills of the agent itself, for the $ menu (Rukoo's own are agentSkills).
  agentOwnSkills: (agent, options) => agentHub().ownSkills(agentId(agent), { refresh: agentPlain(options).refresh === true }),
  agentStop: (id) => agentHub().stop(agentId(id)),
  agentDecide: (id, itemId, choiceId) => agentHub().decide(agentId(id), agentId(itemId), agentId(choiceId)),
  agentRemove: (id) => agentHub().remove(agentId(id)),
  agentView: (state) => agentHub().view(agentPlain(state)),
  // The chat the open panel shows, or null; showing a chat reads its answer.
  agentWatch: (id) => agentHub().watch(id == null ? null : agentId(id)),
  agentUiReply: (requestId, ok, result) => agentHub().uiReply(agentId(requestId), ok === true, result === undefined ? null : result),
  agentPanelReady: () => {
    if (agentGate) agentGate.open();
  },
  agentUndo: (id, itemId) => agentHub().undo(agentId(id), agentId(itemId)),
  agentKeepDraft: (composerKey, draftId, was) =>
    agentHub().keepDraft(agentId(composerKey), draftId == null ? null : agentMailId(draftId), was == null ? null : agentMailId(was)),
  agentPatchItem: (id, itemId, patch) => {
    const p = agentPlain(patch);
    if (Object.keys(p).length !== 1 || typeof p.undone !== 'boolean') throw new Error('invalid');
    return agentHub().patchItem(agentId(id), agentId(itemId), { undone: p.undone });
  },
  // Links in agent cards (sources, plan tasks). Besides what any link may open, an Obsidian note can open
  // here; mail frames keep using openExternal, so a link in an email never starts an Obsidian action.
  openAgentLink: (url) => {
    const u = agentText(url, 2000).trim();
    if (/^obsidian:\/\/(open|search)\b/i.test(u)) return shell.openExternal(u);
    return openUrl(u);
  }
});
// ---- /agents ----

// Calls that act on the window that makes them.
const windowApi = {
  nativeEdit: (sender, action) => {
    if (['undo', 'redo', 'selectAll'].includes(action)) sender[action]();
  },
  composeInit: (sender) => {
    const c = composeWindows.get(sender.id);
    return c ? c.opts : null;
  },
  // Lets a compose window claim its draft once autosave created one, so the draft cannot open twice.
  composeDraft: (sender, draftId) => {
    const c = composeWindows.get(sender.id);
    if (c) c.draftId = draftId ? String(draftId) : null;
  },
  // What the question about unsaved changes after a close or quit came to: true once the editor has closed.
  unloadAnswer: (sender, closed) => answered(sender.id, closed === true),
  // Closes without asking again; the compose window has already handled unsaved changes.
  composeClose: (sender) => {
    const w = BrowserWindow.fromWebContents(sender);
    if (w && w !== win) w.destroy();
  }
};

// Error codes a window acts on, passed on with the message. 'auth': the mail server turned the sign-in down, so the
// setup form keeps its server fields closed and, with appPasswordProvider, links to that provider's app password
// page. Other codes stay here: Node's ENOSPC or a calendar's 'password' would otherwise reach the chat panel, which
// reads a code as one of the agent's own.
const WINDOW_CODES = new Set(['auth']);

// What a window gets besides the message: an allowed code, and for 'auth' the provider whose app password page helps.
// Booking errors (booking/rules.js bookingError) pass their code, and for a refused field its name (contracts f).
function windowError(err) {
  if (err && err.booking === true && typeof err.code === 'string') {
    return typeof err.field === 'string' ? { code: err.code.slice(0, 40), field: err.field.slice(0, 200) } : { code: err.code.slice(0, 40) };
  }
  const code = err && WINDOW_CODES.has(err.code) ? err.code : null;
  if (!code) return {};
  return code === 'auth' && typeof err.appPasswordProvider === 'string' ? { code, appPasswordProvider: err.appPasswordProvider } : { code };
}

ipcMain.handle('mail:call', async (event, method, args) => {
  const own = Object.prototype.hasOwnProperty;
  if (!own.call(api, method) && !own.call(windowApi, method)) return { ok: false, error: `Onbekende actie: ${method}` };
  const started = Date.now();
  try {
    const result = own.call(windowApi, method) ? await windowApi[method](event.sender, ...(args || [])) : await api[method](...(args || []));
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err), ...windowError(err) };
  } finally {
    if (process.env.SEM_TRACE) console.log(`[ipc] ${method} ${Date.now() - started}ms`);
  }
});

let menuLanguage = null;
function updateApplicationMenu() {
  if (process.platform !== 'darwin') { Menu.setApplicationMenu(null); return; }
  if (menuLanguage === engine.settings.language) return;
  menuLanguage = engine.settings.language;
  Menu.setApplicationMenu(Menu.buildFromTemplate(macMenu(t, (action) => {
    const focused = BrowserWindow.getFocusedWindow();
    if (focused) focused.webContents.send('mail:event', { type: 'menu-edit', payload: { action } });
  }, (action) => setZoom(nextZoom(engine.settings.zoomLevel, action)))));
}

function createWindow({ hidden = false } = {}) {
  const b = windowState.bounds('main', { width: 1440, height: 920, minWidth: 760, minHeight: 560 });
  const { bar, background } = themeColors();
  win = new BrowserWindow({
    width: b.width,
    height: b.height,
    ...(Number.isFinite(b.x) ? { x: b.x, y: b.y } : {}),
    minWidth: 760,
    minHeight: 560,
    show: false,
    title: 'Rukoo Mail',
    icon: fs.existsSync(ICON) ? ICON : undefined,
    backgroundColor: background,
    ...windowChrome(process.platform, bar),
    webPreferences: WEB_PREFERENCES
  });
  updateApplicationMenu();
  harden(win);
  watchZoom(win);
  watchQuit(win);
  win.on('focus', () => {
    newSinceFocus = 0;
    refreshBadge();
  });
  // Close to the tray: the window hides before its page hears of the close, so nothing asks about unsaved
  // changes and a draft in the reading pane stays as it is. The agents' tools keep their window too.
  win.on('close', (event) => {
    // While its page asks about unsaved changes for a quit, the window stays in view with the question.
    if (quitAsks.has(win.webContents.id)) {
      event.preventDefault();
      return;
    }
    if ((quitting && !quitAsks.size) || (process.platform !== 'darwin' && !engine.settings.closeToTray)) return;
    event.preventDefault();
    win.hide();
  });
  win.on('minimize', () => {
    if (engine.settings.minimizeToTray) win.hide();
  });
  win.on('closed', () => {
    win = null;
    if (agentGate) agentGate.close();
  });
  // A reload starts a new panel, which says again when it listens. Only the page itself counts: an email's frame
  // loads too, and the panel that opened it keeps listening.
  win.webContents.on('did-start-navigation', (details) => {
    if (agentGate && details && details.isMainFrame && !details.isSameDocument) agentGate.close();
  });
  if (!process.env.SEM_HIDDEN) windowState.track('main', win);
  reveal(win, b.maximized, hidden);
  win.loadFile(path.join(RENDERER, 'index.html'));
}

// A mailto: link Rukoo was started with, opened once the main window is up.
const mailtoQueue = new MailtoQueue(openMailto);
mailtoQueue.accept(mailto.fromArgs(process.argv));
app.on('open-url', (event, url) => {
  if (mailtoQueue.accept(url)) event.preventDefault();
});
app.on('activate', () => {
  if (engine && windowState) showWindow();
});

// Rukoo started again. For a mailto: link (Windows starts the app with it) only its compose window comes up, and
// the main window stays where it was, in the tray too.
app.on('second-instance', (e, argv) => {
  const link = mailto.fromArgs(argv);
  if (link) mailtoQueue.accept(link);
  else if (engine && windowState) showWindow();
});

app.whenReady().then(() => {
  windowState = new WindowState(path.join(app.getPath('userData'), 'window-state.json'));
  // Tests run offline: no logo downloads unless asked for.
  logos = new Logos(path.join(app.getPath('userData'), 'logos'), { enabled: !process.env.SEM_HIDDEN || Boolean(process.env.SEM_LOGOS) });
  google = new GoogleAuth({
    configPath: path.join(app.getPath('userData'), 'google-oauth.json'),
    openBrowser: (url) => shell.openExternal(url)
  });
  engine = new Engine({ dataDir: path.join(app.getPath('userData'), 'data'), secrets, google }).init();
  // Test mode only: lets end-to-end tests simulate server conditions.
  if (process.env.SEM_HIDDEN) global.__semEngine = engine;
  engine.on('updated', () => {
    // The Mac menu follows the language; elsewhere the menu stays off and needs no update.
    if (process.platform === 'darwin') updateApplicationMenu();
    send('updated');
    if (engine.settings.badge === 'unread') refreshBadge();
    else refreshTray();
  });
  engine.on('new-mail', notify);
  calendars = new Calendars({ engine });
  if (process.env.SEM_HIDDEN) global.__semCalendars = calendars;
  calendars.on('updated', () => send('calendar'));
  // A fork points the app at its own account server with package.json's rukoo.accountServer; tests and development
  // use RUKOO_ACCOUNT_SERVER.
  account = new AccountService({
    dataDir: path.join(app.getPath('userData'), 'data'),
    secrets,
    defaultServer: process.env.RUKOO_ACCOUNT_SERVER || PACKAGE_RUKOO.accountServer || ''
  }).init();
  if (process.env.SEM_HIDDEN) global.__semAccount = account;
  account.on('status', (status) => broadcast('account', status));
  account.sync().catch(() => {});
  categories = new Categories({ engine, account, secrets, dataDir: path.join(app.getPath('userData'), 'data') }).init();
  if (process.env.SEM_HIDDEN) global.__semCategories = categories;
  categories.on('changed', () => broadcast('categories', categories.state()));
  categories.on('progress', (activity) => broadcast('categories-progress', activity));
  mailNotices = new MailNotices({ categories, show: showMailNotices });
  booking = new Booking({ account, calendars, engine, secrets, dataDir: path.join(app.getPath('userData'), 'data'), notify: showBookingNotification }).init();
  if (process.env.SEM_HIDDEN) global.__semBooking = booking;
  booking.on('state', (s) => broadcast('booking', s));
  // Deleting the Rukoo account turns the booking page off first, and stops when that fails (decision 22).
  account.beforeDelete = () => booking.disableForDelete();
  reminders = new ReminderRunner({ calendars, engine, dataDir: path.join(app.getPath('userData'), 'data'), notify: showReminders, powerMonitor });
  if (process.env.SEM_HIDDEN) global.__semReminders = reminders;
  reminders.start();
  // New releases on GitHub (package.json's rukoo.releases). Tests and development profiles (SEM_HIDDEN, SEM_DATA_DIR)
  // don't ask GitHub; a test points it at its own server with RUKOO_RELEASES_URL.
  updates = new UpdateChecker({
    current: app.getVersion(),
    repo: (process.env.SEM_HIDDEN || process.env.SEM_DATA_DIR) && !process.env.RUKOO_RELEASES_URL ? null : PACKAGE_RUKOO.releases,
    url: process.env.RUKOO_RELEASES_URL,
    enabled: () => engine.settings.checkUpdates !== false
  }).start();
  if (process.env.SEM_HIDDEN) global.__semUpdates = updates;
  updates.on('changed', (state) => broadcast('updates', state));
  // ---- agents ----
  // Starts in the background: the panel shows "starting" until the first 'agents' status event.
  hub = new AgentHub({
    engine,
    dataDir: path.join(app.getPath('userData'), 'data'),
    secrets,
    deps: {
      // The calendar tools: list_events and create_event use the store, find_free_time the same free time as the
      // availability panel, get_booking_link the booking page while it is on (link() and hours() are null when off).
      calendars,
      calendarFree: (opts) => freeTime(calendars, engine.settings, booking ? booking.hours() : null, opts),
      bookingHours: () => (booking ? booking.hours() : null),
      bookingLink: () => (booking ? booking.link() : null),
      unsubscribe: (id) => api.unsubscribe(id),
      // A mailto-only unsubscribe opens a filled-in compose window; the user sends it.
      openMailto: (url) => openUrl(url),
      appVersion: app.getVersion(),
      clipboard,
      // With Rukoo open on several devices, Clark's bridge picks the one the user touched last.
      idleSeconds: () => powerMonitor.getSystemIdleTime(),
      hasWindow: () => Boolean(win && !win.isDestroyed()),
      workspace: path.join(app.getPath('userData'), 'agent-workspace'),
      // Rukoo's own skills ship inside the app (package.json build.files); the user's own replace them by name.
      skills: { bundled: path.join(app.getAppPath(), 'skills'), user: path.join(app.getPath('userData'), 'skills') }
    }
  });
  agentGate = new PanelGate((payload) => send('agent', payload));
  hub.on('event', (payload) => agentGate.event(payload));
  if (process.env.SEM_HIDDEN) global.__semAgents = hub;
  hub.start().catch((err) => console.error('[agents] start failed:', err));
  // ---- /agents ----
  nativeTheme.on('updated', () => {
    applyTheme();
    broadcast('theme');
  });
  applyTheme();
  createWindow();
  // After the main window shows, so the compose window comes up in front of it.
  win.once('ready-to-show', () => mailtoQueue.start());
  refreshMailClient().catch(() => {});
  updateTray();
  scheduleSync();
  engine.syncAll().catch(() => {});
  calendars.syncAll().catch(() => {});
});

// With "Close to the tray" the main window only closes in a quit. If a compose window then cancels that quit,
// Rukoo stays in the tray after the compose window closes, and the tray opens a new main window.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && (quitting || !engine || !engine.settings.closeToTray)) app.quit();
});

// Quit in the tray menu, the last window closing, and the e2e teardown all come through here.
app.on('before-quit', () => {
  quitting = true;
  // Every quit asks the windows afresh; one that still has a question open says so again from its beforeunload.
  quitAsks.clear();
  clearInterval(syncTimer);
  if (engine) engine.flush();
  if (calendars) calendars.flush();
  if (account) account.close();
  if (categories) categories.close();
  if (mailNotices) mailNotices.close();
  if (reminders) reminders.stop();
  if (booking) booking.close();
});

// Every window has closed, so the quit goes through.
app.on('will-quit', destroyTray);

// ---- agents ----
// dispose() stops turns and flushes the conversations before its first await, and starts the kills of the
// agent processes right after, before any timer can fire; none of that blocks. A kill only finishes while
// Rukoo runs: Node puts its child processes, taskkill included, in a job that Windows ends together with
// Rukoo, and that would leave the agents' own commands running. Clark's runs only end with a stop request
// (each with a 2 s timeout), which a process that exits right away never sends. So the quit waits once,
// until dispose is done or QUIT_WAIT has passed, the time each taskkill had when it still blocked.
// will-quit, not before-quit: a window can still cancel the quit after before-quit (a pop-out composer that
// asks to save), and the agents must keep running then. will-quit comes once every window has closed.
const QUIT_WAIT = 5000;
// Closing the agents starts once, at the end of the Windows session or in will-quit, and a quit waits for it
// either way: dispose() a second time returns at once.
let agentsClosing = null;
function closeAgents() {
  if (!agentsClosing) agentsClosing = hub.dispose().catch(() => {});
  return agentsClosing;
}
let quitWaited = false;
app.on('will-quit', (event) => {
  if (!hub || quitWaited) return;
  quitWaited = true;
  event.preventDefault();
  // Every window is closed and the engine flushed by now, so exit outright: app.quit() after a prevented
  // will-quit does not finish quitting.
  Promise.race([closeAgents(), new Promise((resolve) => setTimeout(resolve, QUIT_WAIT))]).finally(() => app.exit(0));
});
// ---- /agents ----
