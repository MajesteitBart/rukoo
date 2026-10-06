'use strict';

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

const APP_ID = 'nl.bvdm.rukoo-mail';
const ICON = path.join(__dirname, '..', '..', 'build', 'icon.png');
const DARK_BAR = { color: '#000000', symbolColor: '#f2f2f2', height: 40 };
const LIGHT_BAR = { color: '#f4f4f4', symbolColor: '#1a1a1a', height: 40 };

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
let engine = null;
let google = null;
let syncTimer = null;
let newSinceFocus = 0;

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

function send(type, payload) {
  if (win && !win.isDestroyed()) win.webContents.send('mail:event', { type, payload });
}

function applyTheme() {
  nativeTheme.themeSource = engine.settings.theme === 'light' ? 'light' : engine.settings.theme === 'dark' ? 'dark' : 'system';
  if (win && !win.isDestroyed() && process.platform === 'win32') {
    win.setTitleBarOverlay(nativeTheme.shouldUseDarkColors ? DARK_BAR : LIGHT_BAR);
    win.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#000000' : '#f4f4f4');
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
    new Notification({ title: 'Rukoo Mail', body: `${messages.length} nieuwe e-mails` }).show();
  }
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function safeUrl(url) {
  return /^(https?:|mailto:)/i.test(String(url || ''));
}

function openUrl(url) {
  if (/^mailto:/i.test(url)) {
    send('compose-mailto', url);
    showWindow();
    return;
  }
  if (safeUrl(url)) shell.openExternal(url);
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
  markAllRead: (scope, view, folder) => engine.markAllRead(scope, view, folder),
  move: (id, dest) => engine.move(id, dest),
  remove: (id, opts) => (String(id).startsWith('saved:') ? engine.deleteSaved(id) : engine.remove(id, opts)),
  emptyFolder: (accountId, folder) => engine.emptyFolder(accountId, folder),
  toggleVip: (address) => engine.toggleVip(address),
  markSpam: (id) => engine.markSpam(id),
  removeSpam: (address) => engine.updateSettings({ spam: engine.settings.spam.filter((a) => a !== address) }),
  saveToDevice: (id) => engine.saveToDevice(id),
  send: (payload) => engine.send(payload),
  saveDraft: (payload) => engine.saveDraft(payload),
  discardDraft: (id) => engine.discardDraft(id),
  addAccount: (input) => engine.addAccount(input),
  updateAccount: (id, patch) => engine.updateAccount(id, patch),
  removeAccount: (id) => engine.removeAccount(id),
  updateSettings: (patch) => {
    const s = engine.updateSettings(patch);
    if ('theme' in patch) applyTheme();
    if ('syncInterval' in patch) scheduleSync();
    if ('badge' in patch) refreshBadge();
    return s;
  },
  sync: (accountId) => (accountId ? engine.syncAccount(accountId) : engine.syncAll()).then(() => true),
  openFolder: (accountId, folder) => engine.openFolder(accountId, folder),
  pickFiles: async () => {
    const res = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'], title: 'Bestanden bijvoegen' });
    if (res.canceled) return [];
    return res.filePaths.map((p) => ({ path: p, filename: path.basename(p), size: fs.statSync(p).size }));
  },
  pickImage: async () => {
    const res = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      title: 'Afbeelding invoegen',
      filters: [{ name: 'Afbeeldingen', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }]
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
        title: 'Bijlage openen',
        message: `${safeName(a.filename)} kan een programma starten.`,
        detail: 'Dit type bestand wordt niet vanuit e-mail geopend. Sla het op en open het alleen als je de afzender vertrouwt.',
        buttons: ['Annuleren', 'Opslaan...'],
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
  exportEml: async (id) => {
    const full = await engine.getMessage(id);
    const name = `${(full.subject || 'bericht').replace(/[<>:"/\\|?*]/g, '_').slice(0, 80)}.eml`;
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
    else win.setOverlayIcon(nativeImage.createFromDataURL(dataUrl), count === 1 ? '1 nieuwe e-mail' : `${count} nieuwe e-mails`);
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
      title: 'Google OAuth-client importeren',
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

ipcMain.handle('mail:call', async (_event, method, args) => {
  if (!Object.prototype.hasOwnProperty.call(api, method)) return { ok: false, error: `Onbekende actie: ${method}` };
  const started = Date.now();
  try {
    return { ok: true, result: await api[method](...(args || [])) };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  } finally {
    if (process.env.SEM_TRACE) console.log(`[ipc] ${method} ${Date.now() - started}ms`);
  }
});

function createWindow() {
  const dark = nativeTheme.shouldUseDarkColors;
  win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 760,
    minHeight: 560,
    show: false,
    title: 'Rukoo Mail',
    icon: fs.existsSync(ICON) ? ICON : undefined,
    backgroundColor: dark ? '#000000' : '#f4f4f4',
    titleBarStyle: 'hidden',
    titleBarOverlay: dark ? DARK_BAR : LIGHT_BAR,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true
    }
  });
  Menu.setApplicationMenu(null);
  win.webContents.setWindowOpenHandler(({ url }) => {
    openUrl(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win.webContents.getURL()) {
      e.preventDefault();
      openUrl(url);
    }
  });
  win.webContents.on('will-frame-navigate', (e) => {
    // Clicks inside the reader frame must never replace the frame contents.
    if (!e.isMainFrame && !/^(about:|data:)/.test(e.url)) {
      e.preventDefault();
      openUrl(e.url);
    }
  });
  win.on('focus', () => {
    newSinceFocus = 0;
    refreshBadge();
  });
  win.once('ready-to-show', () => {
    if (!process.env.SEM_HIDDEN) return win.show();
    // Test mode: a never-shown window does not paint, so park it off-screen without focus.
    win.setPosition(-5000, -5000);
    win.showInactive();
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

app.on('second-instance', showWindow);

app.whenReady().then(() => {
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
  nativeTheme.on('updated', () => {
    applyTheme();
    send('theme');
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
