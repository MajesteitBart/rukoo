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
const { Calendars } = require('./calendar');
const { GoogleAuth } = require('./google');
const { RISKY, safeName, markOfTheWeb } = require('./files');
const { WindowState } = require('./windowstate');
const { Logos, siteOf } = require('./logos');
const { oneClickUnsubscribe } = require('./net');
const { nextZoom, zoomKey } = require('./zoom');
const { TrayIcon } = require('./tray');
// ---- agents ----
const { clipboard, powerMonitor } = require('electron');
const { AgentHub } = require('./agents');
const { PanelGate } = require('./agents/gate');
// ---- /agents ----

const APP_ID = 'nl.bvdm.rukoo-mail';
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
app.setAppUserModelId(APP_ID);

let win = null;
// Open compose windows by webContents id, with the options they were opened with.
const composeWindows = new Map();
let windowState = null;
let logos = null;
let engine = null;
let calendars = null;
let google = null;
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

if (!process.env.SEM_DATA_DIR && !app.requestSingleInstanceLock()) {
  app.quit();
}

const secrets = {
  encrypt(text) {
    if (safeStorage.isEncryptionAvailable()) return `enc:${safeStorage.encryptString(text).toString('base64')}`;
    return `plain:${Buffer.from(text).toString('base64')}`;
  },
  decrypt(value) {
    const s = String(value || '');
    if (s.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(s.slice(4), 'base64'));
    if (s.startsWith('plain:')) return Buffer.from(s.slice(6), 'base64').toString();
    return s;
  }
};

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
  if (process.platform !== 'win32') return;
  const { bar, background } = themeColors();
  for (const w of windows()) {
    w.setTitleBarOverlay(bar);
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
  send('badge', badgeCount());
  refreshTray();
}

// The tray icon is there while closing or minimizing hides the main window, so the window can always come back.
function updateTray() {
  const wanted = engine.settings.closeToTray || engine.settings.minimizeToTray;
  if (wanted && !tray) {
    tray = new TrayIcon({
      icon: ICON,
      // Windows draws tray icons at 16 px at 100% scaling; an image of exactly that size stays sharp.
      size: Math.round(16 * screen.getPrimaryDisplay().scaleFactor),
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

function notify(messages) {
  newSinceFocus += messages.length;
  refreshBadge();
  if (!engine.settings.notifications || !Notification.isSupported()) return;
  if (win && win.isFocused()) return;
  const list = messages.slice(0, 3);
  for (const m of list) {
    const n = new Notification({
      title: m.from.name || m.from.address,
      body: [m.subject, m.preview].filter(Boolean).join('\n').slice(0, 180),
      // nativeImage can read from inside app.asar; a plain path cannot.
      icon: nativeImage.createFromPath(ICON),
      silent: false
    });
    n.on('click', () => {
      showWindow();
      send('open-message', m.id);
    });
    n.show();
  }
  if (messages.length > list.length) {
    new Notification({ title: 'Rukoo Mail', body: t('native.notifications.newCount', { count: messages.length }) }).show();
  }
}

function showWindow() {
  if (!win || win.isDestroyed()) {
    createWindow();
    return;
  }
  // Test mode keeps the window off-screen and leaves the focus alone; see reveal().
  if (process.env.SEM_HIDDEN) {
    win.showInactive();
    return;
  }
  // Minimized to the tray, the window is minimized and hidden; restoring brings it back where it was.
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function safeUrl(url) {
  return /^(https?:|mailto:)/i.test(String(url || ''));
}

function parseMailto(url) {
  try {
    const u = new URL(url);
    const to = decodeURIComponent(u.pathname || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((address) => ({ name: '', address }));
    return { mode: 'new', to, subject: u.searchParams.get('subject') || '', body: u.searchParams.get('body') || '' };
  } catch (_) {
    return { mode: 'new' };
  }
}

function openUrl(url) {
  if (/^mailto:/i.test(url)) {
    openComposeWindow(parseMailto(url));
    return;
  }
  if (safeUrl(url)) shell.openExternal(url);
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
}

// One zoom level for the main window and every compose window. Settings follows it through the 'zoom' event;
// nothing else in the windows depends on it, so it is saved without the 'updated' redraw.
function setZoom(level) {
  if (level === engine.settings.zoomLevel) return level;
  const { zoomLevel } = engine.updateSettings({ zoomLevel: level }, { quiet: true });
  for (const w of windows()) w.webContents.setZoomFactor(zoomLevel / 100);
  send('zoom', zoomLevel);
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
    if (!win && engine.settings.closeToTray) createWindow({ hidden: true });
    return;
  }
  // Without windows left, window-all-closed has quit already; a second quit would cut will-quit's wait short.
  if (!quitAsks.size) setImmediate(() => windows().length && app.quit());
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
    titleBarStyle: 'hidden',
    titleBarOverlay: bar,
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
function calendarRange(range) {
  const { start, end } = plainObject(range);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > 400 * 86400000) throw new Error('invalid');
  return { start, end };
}
function calendarInput(input) {
  const i = plainObject(input);
  const text = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
  return {
    accountId: text(i.accountId, 200),
    calendarId: text(i.calendarId, 1000),
    title: text(i.title, 1000),
    location: text(i.location, 1000),
    description: text(i.description, 20000),
    allDay: i.allDay === true,
    start: Number(i.start),
    end: Number(i.end),
    startDate: text(i.startDate, 10),
    endDate: text(i.endDate, 10),
    id: text(i.id, 1024)
  };
}
function calendarEventId(id) {
  if (typeof id !== 'string' || !id || id.length > 3000) throw new Error('invalid');
  return id;
}

// Every renderer call goes through this table; nothing else is reachable from the UI.
const api = {
  state: () => engine.state(),
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
    return { mailto: u.mail };
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
  calendarCreate: (input) => calendars.create(calendarInput(input)),
  calendarUpdate: (id, input, opts) => calendars.update(calendarEventId(id), calendarInput(input), { notify: plainObject(opts).notify === true }),
  calendarDelete: (id, opts) => calendars.remove(calendarEventId(id), { notify: plainObject(opts).notify === true, series: plainObject(opts).series === true }),
  calendarRespond: (id, response, opts) => calendars.respond(calendarEventId(id), String(response), { series: plainObject(opts).series === true }),
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
  appInfo: () => ({ version: app.getVersion(), dataDir: app.getPath('userData') })
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
      skill: agentText(i.skill, 64) || null
    });
  },
  agentSkills: () => agentHub().skillList(),
  agentStop: (id) => agentHub().stop(agentId(id)),
  agentDecide: (id, itemId, choiceId) => agentHub().decide(agentId(id), agentId(itemId), agentId(choiceId)),
  agentRemove: (id) => agentHub().remove(agentId(id)),
  agentView: (state) => agentHub().view(agentPlain(state)),
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

ipcMain.handle('mail:call', async (event, method, args) => {
  const own = Object.prototype.hasOwnProperty;
  if (!own.call(api, method) && !own.call(windowApi, method)) return { ok: false, error: `Onbekende actie: ${method}` };
  const started = Date.now();
  try {
    const result = own.call(windowApi, method) ? await windowApi[method](event.sender, ...(args || [])) : await api[method](...(args || []));
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  } finally {
    if (process.env.SEM_TRACE) console.log(`[ipc] ${method} ${Date.now() - started}ms`);
  }
});

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
    titleBarStyle: 'hidden',
    titleBarOverlay: bar,
    webPreferences: WEB_PREFERENCES
  });
  Menu.setApplicationMenu(null);
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
    if ((quitting && !quitAsks.size) || !engine.settings.closeToTray) return;
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

app.on('second-instance', showWindow);

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
    send('updated');
    if (engine.settings.badge === 'unread') refreshBadge();
    else refreshTray();
  });
  engine.on('new-mail', notify);
  calendars = new Calendars({ engine });
  if (process.env.SEM_HIDDEN) global.__semCalendars = calendars;
  calendars.on('updated', () => send('calendar'));
  // ---- agents ----
  // Starts in the background: the panel shows "starting" until the first 'agents' status event.
  hub = new AgentHub({
    engine,
    dataDir: path.join(app.getPath('userData'), 'data'),
    secrets,
    deps: {
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
  updateTray();
  scheduleSync();
  engine.syncAll().catch(() => {});
  calendars.syncAll().catch(() => {});
});

// With "Close to the tray" the main window only closes in a quit. If a compose window then cancels that quit,
// Rukoo stays in the tray after the compose window closes, and the tray opens a new main window.
app.on('window-all-closed', () => {
  if (quitting || !engine || !engine.settings.closeToTray) app.quit();
});

// Quit in the tray menu, the last window closing, and the e2e teardown all come through here.
app.on('before-quit', () => {
  quitting = true;
  // Every quit asks the windows afresh; one that still has a question open says so again from its beforeunload.
  quitAsks.clear();
  clearInterval(syncTimer);
  if (engine) engine.flush();
  if (calendars) calendars.flush();
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
