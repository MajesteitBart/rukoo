'use strict';

// Team chat in the browser: the desktop's WorkspaceService (src/main/workspaces) bundled as it is, with the web's
// dependencies in place of Node's. The web build (src/web/build-options.mjs) aliases node:sqlite to ./sqlite.js (sql.js
// in memory), fs, path, events, crypto, http and https to ./shims, src/main/account/client.js to
// shims/account-client.js and src/i18n/index.js to shims/i18n.js, and injects shims/buffer.js for Buffer. The page's
// account service stands in for the desktop's AccountService, ./websocket.js for Node's WebSocket, and the page's file
// host (src/web/files.js) for main.js's chatHost.
//
// createWebEngine wires the service the way src/main/main.js does; each step below names the lines it follows. The
// bridge (src/web/bridge.js) calls setFocused, nudge and settingsChanged from the page's own events and serves
// chatApi as window.mail's chat* methods.
const sqlite = require('./sqlite');
const { webSocketAdapter } = require('./websocket');
const { WorkspaceService } = require('../../main/workspaces');
const { chatApi } = require('../../main/workspaces/ipc');

// The cache's "folder". No disk is involved: sqlite.js keeps every database in memory, and the cache's files (chat-files/
// and chat-uploads/ beside chat.db, files.js) live in shims/vfs.js, so history and files come back from the server
// after a reload.
const DATA_DIR = 'rukoo-web';
// The sql.js WebAssembly file, next to web/bridge.js (src/web/build-options.mjs copies it there under this name).
const SQL_WASM_FILE = 'sql-wasm.wasm';

// document.currentScript is the bridge's <script> only while that script runs, which is when the bundle evaluates this
// module, so the base is read now rather than at the first createWebEngine.
const scriptBase = typeof document !== 'undefined' && document.currentScript && document.currentScript.src ? document.currentScript.src : null;

function wasmUrl() {
  if (scriptBase) return new URL(SQL_WASM_FILE, scriptBase).href;
  // Loaded some other way: the app's layout, web/ under the page.
  if (typeof document !== 'undefined' && document.baseURI) return new URL(`web/${SQL_WASM_FILE}`, document.baseURI).href;
  return `web/${SQL_WASM_FILE}`;
}

const noop = () => {};

// account: the web account service, with the interface the service uses (status(), the sessionTag getter, on and
// removeListener for 'status' and 'info', serverInfo(), workspaceCall()). settings: () => { chatNotifications, ... }.
// onEvent(payload), onNotify(notice) and onUnnotify(id) get what main.js sends as 'chat' and shows as alerts.
// sqlite: what sqlite.init() takes, by default the wasm next to the bridge. host: what main.js's chatHost does for
// files.js (src/web/files.js on the page; without one, Attach answers no files and Save and Open do nothing). WebSocket,
// now, random and timers replace the service's own, for tests.
async function createWebEngine({
  account,
  settings = () => ({}),
  onEvent = noop,
  onNotify = noop,
  onUnnotify = noop,
  timing = {},
  host = {},
  sqlite: sqlSource = null,
  WebSocket = webSocketAdapter(),
  now,
  random,
  timers
} = {}) {
  if (!account || typeof account.status !== 'function' || typeof account.on !== 'function') {
    throw new TypeError('createWebEngine needs the account service');
  }
  // The store opens synchronously inside the service (store.js openStore), so sql.js has to be there first.
  await sqlite.init(sqlSource || { locateFile: () => wasmUrl() });

  // main.js 2306-2312: the service follows the account, with the settings as a function, the timing overrides and the
  // file host. main.js passes chatTiming(process.env), which is {} outside SEM_HIDDEN tests; the page passes its own.
  const svc = new WorkspaceService({
    account,
    dataDir: DATA_DIR,
    settings,
    timing,
    host,
    WebSocket,
    ...(now ? { now } : {}),
    ...(random ? { random } : {}),
    ...(timers ? { timers } : {})
  });
  // main.js 2232-2234: 'event' goes to the window as 'chat', 'notify' and 'unnotify' to the alert code. main.js
  // attaches them after init(); init() emits nothing synchronously (its state goes out on the coalesce timer), so
  // attaching first changes nothing and can't lose an event.
  svc.on('event', onEvent);
  svc.on('notify', onNotify);
  svc.on('unnotify', onUnnotify);
  svc.init();

  let disposed = false;
  return {
    // main.js 1611: every chat* method, over the service until dispose(); after it, chatState is the blank state
    // and the rest throw signed_out, as before main.js made the service.
    chatApi: chatApi(() => (disposed ? null : svc)),
    svc,
    // main.js 2052-2067: true when the window gains focus, shows or is restored; false when it blurs or hides.
    setFocused: (on) => {
      if (!disposed) svc.setFocused(on);
    },
    // main.js 2235-2236: 'resume' after the computer wakes or unlocks; the page's equivalents are going online and
    // becoming visible again.
    nudge: (why = 'resume') => {
      if (!disposed) svc.nudge(why);
    },
    // main.js 1201: the chatNotifications setting changed, which ChatState carries.
    settingsChanged: () => {
      if (!disposed) svc.settingsChanged();
    },
    // How many messages wait to be sent (index.js state(): ChatState.unsent), for the page's beforeunload warning:
    // the cache is in memory, so they go with the page.
    unsent: () => (disposed ? 0 : Number(svc.outbox.unsent()) || 0),
    // Those messages by their outbox id, for telling the ones a sign-out's confirmation counted from any sent after it.
    unsentIds: () => (disposed || !svc.store ? [] : svc.store.all('SELECT local FROM outbox').map((row) => row.local)),
    // main.js 707: the service closes at quit, with its timers, sockets and cache.
    dispose() {
      if (disposed) return;
      disposed = true;
      svc.removeListener('event', onEvent);
      svc.removeListener('notify', onNotify);
      svc.removeListener('unnotify', onUnnotify);
      svc.close();
    }
  };
}

module.exports = { createWebEngine, DATA_DIR, SQL_WASM_FILE };
