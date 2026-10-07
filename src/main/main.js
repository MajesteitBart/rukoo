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
  Menu
} = require('electron');
const { Engine } = require('./engine');
const { GoogleAuth } = require('./google');
const { RISKY, safeName, markOfTheWeb } = require('./files');
const { WindowState } = require('./windowstate');
const { Logos, siteOf } = require('./logos');
const { oneClickUnsubscribe } = require('./net');
// ---- agents ----
const { clipboard } = require('electron');
const { AgentHub } = require('./agents');
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
let google = null;
let syncTimer = null;
let newSinceFocus = 0;
// ---- agents ----
let hub = null;
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
  // Errors are stored per account and shown in the list; nothing to do with them here.
  if (minutes > 0) syncTimer = setInterval(() => engine.syncAll().catch(() => {}), minutes * 60000);
}

function badgeCount() {
  if (engine.settings.badge === 'none') return 0;
  if (engine.settings.badge === 'unread') return engine.counts('all').all;
  return newSinceFocus;
}

function refreshBadge() {
  send('badge', badgeCount());
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

// Test mode: a never-shown window does not paint, so park it off-screen without focus.
function reveal(w, maximized = false) {
  w.once('ready-to-show', () => {
    if (process.env.SEM_HIDDEN) {
      w.setPosition(-5000, -5000);
      w.showInactive();
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
  saveDraft: (payload) => engine.saveDraft(payload),
  discardDraft: (id) => engine.discardDraft(id),
  addAccount: (input) => engine.addAccount(input),
  updateAccount: (id, patch) => engine.updateAccount(id, patch),
  removeAccount: (id) => engine.removeAccount(id),
  updateSettings: (patch) => {
    const s = engine.updateSettings(patch);
    if ('theme' in patch) applyTheme();
    if ('language' in patch) broadcast('language');
    if ('syncInterval' in patch) scheduleSync();
    if ('badge' in patch) refreshBadge();
    return s;
  },
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
    return engine.addGoogleAccount(grant, { reauthId: accountId });
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
  appInfo: () => ({ version: app.getVersion(), dataDir: app.getPath('userData') })
};

// ---- agents ----
// The chat panel's calls. Arguments are checked here; the hub checks structure and values again.
const agentText = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
const agentId = (v) => {
  if (typeof v !== 'string' || !v || v.length > 200) throw new Error('invalid');
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
  agentRotateToken: () => agentHub().rotateToken(),
  agentList: () => agentHub().list(),
  agentGet: (id) => agentHub().get(agentId(id)),
  agentFindFor: (ref) => {
    const r = agentPlain(ref);
    return agentHub().findFor({ id: agentText(r.id, 2000), messageId: agentText(r.messageId, 1000) });
  },
  agentCreate: (input) => {
    const i = agentPlain(input);
    return agentHub().create({ agent: agentText(i.agent, 20), message: agentMessage(i.message) });
  },
  agentSend: (id, input) => {
    const i = agentPlain(input);
    return agentHub().send(agentId(id), {
      text: agentText(i.text, 20000),
      action: agentText(i.action, 40) || null,
      display: agentText(i.display, 20000) || null
    });
  },
  agentStop: (id) => agentHub().stop(agentId(id)),
  agentDecide: (id, itemId, choiceId) => agentHub().decide(agentId(id), agentId(itemId), agentId(choiceId)),
  agentRemove: (id) => agentHub().remove(agentId(id)),
  agentView: (state) => agentHub().view(agentPlain(state)),
  agentUiReply: (requestId, ok, result) => agentHub().uiReply(agentId(requestId), ok === true, result === undefined ? null : result),
  agentUndo: (id, itemId) => agentHub().undo(agentId(id), agentId(itemId)),
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

function createWindow() {
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
  win.on('focus', () => {
    newSinceFocus = 0;
    refreshBadge();
  });
  win.on('closed', () => {
    win = null;
  });
  if (!process.env.SEM_HIDDEN) windowState.track('main', win);
  reveal(win, b.maximized);
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
  });
  engine.on('new-mail', notify);
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
      hasWindow: () => Boolean(win && !win.isDestroyed()),
      workspace: path.join(app.getPath('userData'), 'agent-workspace')
    }
  });
  hub.on('event', (payload) => send('agent', payload));
  if (process.env.SEM_HIDDEN) global.__semAgents = hub;
  hub.start().catch((err) => console.error('[agents] start failed:', err));
  // ---- /agents ----
  nativeTheme.on('updated', () => {
    applyTheme();
    broadcast('theme');
  });
  applyTheme();
  createWindow();
  scheduleSync();
  engine.syncAll().catch(() => {});
});

app.on('window-all-closed', () => app.quit());

app.on('before-quit', () => {
  clearInterval(syncTimer);
  if (engine) engine.flush();
});

// ---- agents ----
// dispose() stops turns, kills agent processes and flushes the conversations synchronously before its first
// await. The rest is network: Clark's runs only end with a stop request, which a process that exits right away
// never sends. So the quit waits once, until dispose is done or 2.5 s have passed.
let agentsDisposed = false;
app.on('before-quit', (event) => {
  if (!hub || agentsDisposed) return;
  agentsDisposed = true;
  event.preventDefault();
  Promise.race([hub.dispose(), new Promise((resolve) => setTimeout(resolve, 2500))])
    .catch(() => {})
    .finally(() => app.quit());
});
// ---- /agents ----
