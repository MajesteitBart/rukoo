'use strict';

// What src/main/main.js and src/main/preload.js are for the desktop window, for the browser page: window.mail, its
// calls and its events. createHost() runs while web/bridge.js evaluates, before any module of the page, so
// window.mail exists synchronously as preload.js makes it; the chat engine and the account start behind one promise
// (ready) that every call waits for.
//
// The calls the page answers (the rest get { ok: false, error } and a console warning, never a throw):
// - chat*: every method of src/main/workspaces/ipc.js chatApi, over the web chat engine (src/web/engine). chatJoin
//   also clears the page's stored invitation once it is used. chatState and the state events carry what the page
//   adds to ChatState (webState below). Team chat's files run through the page's file host (src/web/files.js), which
//   does what main.js's chatHost does: chatPickFiles opens the browser's file chooser, and chatFile answers 'view'
//   with a blob: URL in place of desktop's rukoo-chat-file: link, 'open' with a new tab for an image and a download
//   for anything else, and 'save' with a download.
// - account*: the Rukoo account (src/web/account/service.js) with main.js's handlers around it: the invite field's
//   invitation link is split out at sign-up (main.js 1497-1508), and the page's invitation (src/web/join.js) becomes
//   a pending join after a sign-up, a sign-in or a recovery. Signing out clears it. accountStatus and the 'account'
//   event carry invitation and session too, and account errors their code.
// - webForgetInvitation (web only): the Join dialog the page's invitation opened was closed, so the page drops it.
// - webLostUnsentShown (web only): Chat's notice said what a session end this tab didn't ask for took, so the page
//   stops reporting it.
// - state, updateSettings, setZoom, setBadge, logRenderer, toastMain, openExternal, updatesOpen and
//   notificationState: the window's own, as far as a page has them.
//
// Events are main.js's { type, payload }: 'account' (the account's status, as main.js 2201 broadcasts it), 'chat'
// (the engine's payloads, and kind 'open' for a notification click), 'chat-toast', 'chat-toast-hide', 'language',
// 'theme' and 'toast'. As over IPC, arguments, answers and event payloads are copies (structuredClone), and events
// arrive after the call that caused them has returned.
const { chatApi } = require('../main/workspaces/ipc');
const { chatTiming, blankState, isAvailable } = require('../main/workspaces');
const { inviteLink, parseInviteLink } = require('../main/workspaces/wire');
const { AccountError } = require('./account/client');
const { createAccountService, ERRORS, SESSION_KEY } = require('./account/service');
const { createArgon2 } = require('./account/argon2');
const { createWebEngine } = require('./engine');
const { createJoin } = require('./join');
const { createWebFiles } = require('./files');
const { VIEW_SCHEME, VIEW_TYPES } = require('../main/workspaces/files');
const vfs = require('./engine/shims/vfs');

const { SETTINGS_KEY, firstLanguage } = require('./language');
// Each open tab's count of chat messages still to send, as { tag, count } under this prefix and the tab's own id.
// All tabs share the session, so a sign-out in one loses what the others hold too, and its confirmation counts them.
const UNSENT_PREFIX = 'rukoo.web.unsent.';
// 'unsupported' once the browser refused to construct a Notification: it refuses on every visit.
const NOTIFY_KEY = 'rukoo.web.notifications';
const THEMES = ['system', 'light', 'dark'];
const UNAVAILABLE = 'Not available in the browser';
const WORKSPACE_ID = /^w_[A-Za-z0-9_-]{22}$/;
const CONVERSATION_ID = /^c_[A-Za-z0-9_-]{22}$/;
// The most the page keeps of downloaded chat files, in memory (src/web/engine/shims/vfs.js), against desktop's 1 GiB
// on disk (TIMING.fileCacheMax); the least recently used go first, and come again from the server when asked for.
const FILE_CACHE_MAX = 256 * 1024 * 1024;
// Whether this browser parses the host of a URL whose scheme it doesn't know, as the URL standard says and Chromium
// does since version 130: files.js serve() reads a view link's token from new URL(link), which the older parser
// leaves without a host.
const VIEW_LINK = new RegExp(`^${VIEW_SCHEME}://view/([A-Za-z0-9_-]{1,64})$`);
const standardUrls = (() => {
  try {
    return new URL(`${VIEW_SCHEME}://view/x`).hostname === 'view';
  } catch (_) {
    return false;
  }
})();

// What main.js's IPC handlers make of the renderer's arguments (main.js 883-885).
const plainObject = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const accountText = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
// main.js safeUrl (518-520): what openExternal hands to the system.
const safeUrl = (url) => /^(https?:|mailto:)/i.test(String(url || ''));

// The page's storage, which a browser may refuse to hand out at all (blocked site data throws on access).
function storageOf(page, name) {
  try {
    return page[name] || null;
  } catch (_) {
    return null;
  }
}

// The account server: <meta name="rukoo-server" content="…"> when the page has one, else the page's own origin. The
// page can only talk to its own origin (the account server sends no CORS headers), so the meta is for a page served
// under a different address of the same server, such as a preview Worker in front of it.
function serverAddress(doc, location) {
  let meta = null;
  try {
    meta = doc && typeof doc.querySelector === 'function' ? doc.querySelector('meta[name="rukoo-server"]') : null;
  } catch (_) {
    meta = null;
  }
  const content = meta ? (typeof meta.getAttribute === 'function' ? meta.getAttribute('content') : meta.content) : '';
  return String(content || '').trim() || String((location && location.origin) || '');
}

// Chromium on Android (Chrome, Samsung Internet, a WebView) has Notification and its permission, but its constructor
// throws: only a service worker's showNotification shows one there. Firefox for Android isn't counted in: should its
// constructor throw too, the first alert learns that (showChatNotification).
function serviceWorkerOnly(navigator) {
  const ua = String((navigator && navigator.userAgent) || '');
  const data = navigator && navigator.userAgentData;
  const android = (data && data.platform === 'Android') || /Android/.test(ua);
  return Boolean(android && !/Firefox\//.test(ua));
}

// The keys a storage holds, or none when it can't list them.
function storedKeys(storage) {
  const keys = [];
  try {
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (typeof key === 'string') keys.push(key);
    }
  } catch (_) {
    // Blocked or missing storage: no other tab to count.
  }
  return keys;
}

// main.js windowError (1972-1996), its team chat branch (1983-1993): a ChatError (wire.js) passes its code and what
// the window words its text with, each checked and kept short. The voice, booking, video and mail ('auth') branches
// have no errors to pass on the web.
function chatDetails(err) {
  const out = { code: err.code.slice(0, 40) };
  if (typeof err.field === 'string') out.field = err.field.slice(0, 200);
  if (typeof err.scope === 'string') out.scope = err.scope.slice(0, 20);
  if (Number.isSafeInteger(err.retryAfter)) out.retryAfter = Math.min(Math.max(err.retryAfter, 0), 3600);
  if (Array.isArray(err.channels)) out.channels = err.channels.filter((c) => typeof c === 'string').slice(0, 100).map((c) => c.slice(0, 40));
  if (typeof err.member === 'string') out.member = err.member.slice(0, 40);
  if (typeof err.limit === 'string') out.limit = err.limit.slice(0, 40);
  return out;
}

// page: the window (globalThis in the bundle). Returns { mail, ready, account, join, engine() }.
function createHost(page) {
  const doc = page.document;
  const location = page.location;
  const i18n = page.RukooI18n;
  const log = page.console || console;
  const clone = typeof page.structuredClone === 'function' ? (v) => page.structuredClone(v) : (v) => v;
  const later = typeof page.queueMicrotask === 'function' ? (fn) => page.queueMicrotask(fn) : (fn) => Promise.resolve().then(fn);
  const local = storageOf(page, 'localStorage');
  const t = (key, params) => i18n.t(key, params);
  // A test page sets __rukooWebTest before this script: { chatFast, timing } speed the engine up as SEM_CHAT_FAST does
  // on desktop, and the object gets the account, the join, the engine and ready, as main.js's __semChat for specs.
  const test = page.__rukooWebTest && typeof page.__rukooWebTest === 'object' ? page.__rukooWebTest : null;

  // ---- events ----

  const listeners = new Set();
  // A listener's error surfaces as one nothing caught, as in a desktop window, without keeping the others from it.
  const report = (err) => {
    if (typeof page.reportError === 'function') page.reportError(err);
    else log.error(err);
  };
  function emit(type, payload) {
    let event;
    try {
      event = { type, payload: clone(payload) };
    } catch (err) {
      log.error(`[web] the ${type} event could not be copied`, err);
      return;
    }
    later(() => {
      for (const entry of [...listeners]) {
        try {
          entry.fn(event);
        } catch (err) {
          report(err);
        }
      }
    });
  }

  // ---- settings (desktop: settings.json, engine.js DEFAULT_SETTINGS and normalizeSettings) ----

  const firstVisit = firstLanguage(page.navigator);
  function normalize(s) {
    const v = plainObject(s);
    return {
      language: i18n.normalizeLanguage(typeof v.language === 'string' ? v.language : firstVisit),
      theme: THEMES.includes(v.theme) ? v.theme : 'system',
      chatNotifications: v.chatNotifications !== false
    };
  }
  function readSettings() {
    try {
      return normalize(JSON.parse((local && local.getItem(SETTINGS_KEY)) || 'null'));
    } catch (_) {
      return normalize(null);
    }
  }
  function saveSettings() {
    try {
      if (local) local.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch (_) {
      // Refused storage (a private window, a full quota): the choice holds while the page is open.
    }
  }
  let settings = readSettings();
  // bootstrap.js does this before any module builds a label; here it is before web-shell.js runs.
  i18n.setLanguage(settings.language);

  // ---- the account, the invitation and the engine ----

  const server = serverAddress(doc, location);
  const script = doc && doc.currentScript && doc.currentScript.src ? doc.currentScript.src : null;
  const account = createAccountService({
    server,
    // Called as a plain function: a browser's fetch refuses any other this than the window.
    fetch: (input, init) => page.fetch(input, init),
    storage: local,
    subtle: page.crypto && page.crypto.subtle,
    argon2: createArgon2({ Worker: page.Worker, url: script ? new URL('argon2-worker.js', script).href : 'web/argon2-worker.js' }),
    t
  });
  const join = createJoin({ location, history: page.history, storage: storageOf(page, 'sessionStorage'), server: location && location.origin });
  const webFiles = createWebFiles(page, { log });

  let engine = null;
  // Why createWebEngine failed (its message), or null: chat then can't start in this page (webState engineFailed).
  let engineError = null;
  const offline = chatApi(() => null);
  const chat = () => (engine ? engine.chatApi : offline);

  // ---- other tabs: their unsent messages, and what their sign-out cost this one ----

  // This tab's key among UNSENT_PREFIX: a random id per page load.
  const tabId = (() => {
    const bytes = new Uint8Array(8);
    try {
      page.crypto.getRandomValues(bytes);
    } catch (_) {
      for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    }
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  })();
  const unsentKey = UNSENT_PREFIX + tabId;
  let published = null;
  // Says how many messages this tab still has to send, for the session it has them in; nothing once there are none.
  function publishUnsent(count) {
    const tag = account.sessionTag;
    const n = Number.isSafeInteger(count) && count > 0 && tag ? count : 0;
    const text = n ? JSON.stringify({ tag, count: n }) : null;
    if (text === published) return;
    published = text;
    try {
      if (!local) return;
      if (text) local.setItem(unsentKey, text);
      else local.removeItem(unsentKey);
    } catch (_) {
      // Refused storage: a sign-out in another tab can't count these, and this tab's own warnings still do.
    }
  }
  // What the other tabs said for this session. A tab that crashed leaves its count until this session ends.
  function unsentElsewhere() {
    const tag = account.sessionTag;
    if (!local || !tag) return 0;
    let sum = 0;
    for (const key of storedKeys(local)) {
      if (!key.startsWith(UNSENT_PREFIX) || key === unsentKey) continue;
      try {
        const v = JSON.parse(local.getItem(key));
        if (v && v.tag === tag && Number.isSafeInteger(v.count) && v.count > 0) sum += Math.min(v.count, 10000);
      } catch (_) {
        // Not a count: skipped.
      }
    }
    return sum;
  }
  // After this tab's sign-out or deletion: the counts of that session are moot, also one a crashed tab left.
  function dropUnsentOf(tag) {
    if (!local || !tag) return;
    for (const key of storedKeys(local)) {
      if (!key.startsWith(UNSENT_PREFIX)) continue;
      try {
        const v = JSON.parse(local.getItem(key));
        if (!v || v.tag === tag) local.removeItem(key);
      } catch (_) {
        try {
          local.removeItem(key);
        } catch (__) {
          // Refused storage keeps it; it names a session that no longer exists.
        }
      }
    }
    if (published && published.includes(JSON.stringify(tag))) published = null;
  }

  // A session can end without this tab asking: another tab signs out or in to another account (the storage event), or
  // the server answers 401 because that sign-out already revoked the token. The engine then drops its cache with the
  // unsent messages in it, and unlike after this tab's own sign-out nobody warned this tab's user. So the count is kept
  // for chat.js's lost-unsent notice (webState lostUnsentElsewhere), in every chatState answer and state event, until
  // Chat says it showed it (webLostUnsentShown).
  // This tab's own sign-out or deletion was confirmed with the messages it had then, so when its request ended the
  // session (the account's 'ended' event, also after a 401 that request caused came first), only messages sent after it
  // started count. When it failed, or another tab or a 401 ended the session before it, they all count. That is known
  // only once it is done, so endHere() holds what the session's end took until then.
  // endingHere: by session tag, this tab's sign-outs and deletions running for it: { runs, warned (outbox ids at the
  // start), took (outbox ids when the session ended, or null), ended (its own request ended it) }.
  const endingHere = new Map();
  let lostElsewhere = 0;
  let statusTag = null;
  // Registered before the engine's own 'status' listener (svc.init()), so the engine still holds the old cache here.
  account.on('status', (status) => {
    const tag = status && status.signedIn ? account.sessionTag : null;
    if (statusTag && tag !== statusTag) webFiles.dropPicked();
    if (statusTag && tag !== statusTag && engine) {
      const own = endingHere.get(statusTag);
      if (own) own.took = engine.unsentIds();
      else {
        const n = engine.unsent();
        if (n > 0) lostElsewhere += n;
      }
    }
    statusTag = tag;
    // main.js 2201: Settings redraws its account pages from it (rukoo-account.js onStatus), also for another tab's
    // sign-in or sign-out and a session the server ended. session (web only): which session, since another tab can
    // replace it with another one of the same account, whose devices list another device as this one.
    emit('account', { ...status, invitation: Boolean(join.peek()), session: tag });
  });
  account.on('ended', (ended) => {
    const own = endingHere.get(ended.tag);
    if (own) own.ended = true;
  });
  // Chat couldn't start, and the server's info came only now: the shell hears whether the server has chat after all.
  account.on('info', () => {
    if (engine || engineError === null) return;
    emit('chat', { kind: 'state', state: webState(blankState()) });
  });

  // The page's invitation as the pending join of this session (manage.js rememberJoin), unless one waits already. It
  // is rebuilt for the account server, which invitation links are checked against: the page came to this origin's
  // /join, whose server is the one the page talks to. link: an invitation the sign-up form named itself instead.
  function offerJoin(link = null) {
    if (!engine) return;
    // A sign-in that worked stays one: the Join dialog not opening is the most this can cost.
    try {
      const manage = engine.svc.manage;
      const status = account.status();
      if (!status.signedIn || !account.sessionTag) return;
      let target = link;
      if (!target) {
        const stored = join.peek();
        if (!stored || manage.pendingJoin()) return;
        target = inviteLink(status.server, stored.workspace, stored.secret);
      }
      manage.rememberJoin(target);
    } catch (err) {
      log.error('[web] the invitation could not wait for the Join dialog', err);
    }
  }

  // After a join: the page's invitation is used when the join was for its secret (as manage.js join() treats the
  // pending one).
  function joined(input) {
    const stored = join.peek();
    if (!stored) return;
    try {
      if (parseInviteLink(String(plainObject(input).link || '')).secret === stored.secret) dropInvitation();
    } catch (_) {
      // Not a link chatJoin could have joined with.
    }
  }

  // The server's files are at another origin than the page's (/v1/info workspace.files.origin, an operator's
  // WORKSPACE_FILES_ORIGIN): the app's policy lets the page connect to its own origin only, and the file routes send no
  // CORS headers, so no upload or download could get there. Attach then hides (webState), and opening a file says why.
  function filesElsewhere() {
    let info = null;
    try {
      info = engine ? engine.svc.filesInfo() : null;
    } catch (_) {
      info = null;
    }
    return Boolean(info && info.origin && location && location.origin && info.origin !== location.origin);
  }
  function filesElsewhereError() {
    const host = (() => {
      try {
        return new URL(account.status().server).host;
      } catch (_) {
        return '';
      }
    })();
    let message;
    try {
      message = t('chat.errors.webFilesElsewhere', { host });
    } catch (_) {
      message = 'Files are kept at another address';
    }
    return Object.assign(new Error(message), { chat: true, code: 'files_web' });
  }

  // ChatState with what only the page knows (web only):
  // - invitation: the page holds an invitation link, so the signed-out chat pane says it is kept (chat-view.js)
  //   instead of asking for it;
  // - lostUnsentElsewhere: messages a session's end took from this tab that no confirmation here counted (see
  //   endingHere), also counted in lostUnsent, so chat.js says why they went; reported until chat.js showed it
  //   (webLostUnsentShown);
  // - engineFailed and engineError: team chat couldn't start in this page (createWebEngine failed, such as the
  //   WebAssembly not loading) while the server has it, and why. The shell offers a reload then.
  // - capabilities without 'files' when the server keeps its files where the page can't reach them (filesElsewhere).
  function webState(state) {
    if (!state || typeof state !== 'object') return state;
    const out = { ...state, invitation: Boolean(join.peek()) };
    if (Array.isArray(state.capabilities) && state.capabilities.includes('files') && filesElsewhere()) {
      out.capabilities = state.capabilities.filter((c) => c !== 'files');
    }
    if (lostElsewhere > 0) {
      out.lostUnsent = (Number(state.lostUnsent) || 0) + lostElsewhere;
      out.lostUnsentElsewhere = lostElsewhere;
    }
    if (engineError !== null) {
      out.engineFailed = isAvailable(account.status().info);
      out.engineError = engineError;
    }
    return out;
  }
  // The page's invitation was used or dropped: the pane hears it now, not at the next state the engine sends.
  function dropInvitation() {
    if (!join.peek()) return;
    join.clear();
    if (!engine) return;
    try {
      emit('chat', { kind: 'state', state: webState(engine.svc.state()) });
    } catch (err) {
      log.error('[web] the chat state could not be sent', err);
    }
  }

  // ---- focus, notifications ----

  const pageFocused = () => !doc || (doc.visibilityState !== 'hidden' && (typeof doc.hasFocus !== 'function' || doc.hasFocus()));

  // Whether this browser shows a Notification the page constructs. Not where only a service worker may show one
  // (serviceWorkerOnly), nor once a construction failed that way here, which is remembered for the next visits.
  // Probing up front would show a notification wherever it works, so a failure is learnt at the first alert.
  let notifyRefused = serviceWorkerOnly(page.navigator);
  try {
    notifyRefused = notifyRefused || Boolean(local && local.getItem(NOTIFY_KEY) === 'unsupported');
  } catch (_) {
    // Blocked storage: only the platform decides.
  }
  const notifySupported = () => typeof page.Notification === 'function' && !notifyRefused;

  const notices = new Map();
  function dropNotice(key) {
    const n = notices.get(key);
    if (!n) return;
    notices.delete(key);
    try {
      n.close();
    } catch (_) {
      // Gone already.
    }
  }

  // main.js openChatNotice (442-453): the page comes forward on Chat, at that conversation and message.
  function openChatNotice(open) {
    const o = plainObject(open);
    const id = (v, re) => (typeof v === 'string' && re.test(v) ? v : null);
    const payload = {
      kind: 'open',
      ws: id(o.ws, WORKSPACE_ID),
      conversation: id(o.conversation, CONVERSATION_ID),
      seq: Number.isSafeInteger(o.seq) && o.seq >= 0 ? o.seq : null
    };
    try {
      page.focus();
    } catch (_) {
      // A browser that won't raise the tab still opens the conversation in it.
    }
    if (payload.ws && payload.conversation) emit('chat', payload);
  }

  // main.js showChatNotification (457-485): a toast while the page is in front with focus; else a browser
  // notification when chat notifications are on and the browser allows them. The tab's title shows the unread count
  // meanwhile (web-shell.js, from chat.modeBadge()). Permission is never asked for here: the page asks when the user
  // turns notifications on.
  function showChatNotification(notice) {
    const { id, title, body, open } = plainObject(notice);
    const key = String(id || '').slice(0, 200);
    if (pageFocused()) {
      emit('chat-toast', { id: key, body: String(body || '').slice(0, 200) });
      return;
    }
    const N = page.Notification;
    if (!settings.chatNotifications || !notifySupported() || N.permission !== 'granted') return;
    emit('chat-toast-hide', key);
    dropNotice(key);
    let n;
    try {
      // tag: another tab's notification of the same alert is replaced, not shown twice.
      n = new N(String(title || '').slice(0, 200), { body: String(body || '').slice(0, 400), tag: key, silent: false });
    } catch (err) {
      log.warn('[web] chat notification not shown', err);
      // "Illegal constructor": a browser that only lets a service worker show one, which serviceWorkerOnly didn't
      // know. From now on notificationState says unsupported, so Settings stops offering them.
      if (err && err.name === 'TypeError') {
        notifyRefused = true;
        try {
          if (local) local.setItem(NOTIFY_KEY, 'unsupported');
        } catch (_) {
          // Remembered for this visit only.
        }
      }
      return;
    }
    notices.set(key, n);
    const drop = () => {
      if (notices.get(key) === n) notices.delete(key);
    };
    n.onclick = () => {
      drop();
      try {
        n.close();
      } catch (_) {
        // Closed already.
      }
      openChatNotice(open);
    };
    n.onclose = drop;
    n.onerror = drop;
  }

  // main.js closeChatNotification (487-500): a read, a removal, an eviction or a sign-out takes the alert back, the
  // toast too when it still shows.
  function closeChatNotification(id) {
    const key = String(id || '').slice(0, 200);
    emit('chat-toast-hide', key);
    dropNotice(key);
  }

  // ---- team chat's files ----

  // Whether a picked file (src/web/files.js) is still needed: files.js may stage its path for ten minutes after the
  // pick (PICK_TTL), and a staged file reads it until it leaves the tray, also for a Retry.
  function pickedInUse(name) {
    const files = engine && engine.svc.files;
    if (!files) return false;
    const until = files.picked.get(name);
    if (until && until >= engine.svc.now()) return true;
    for (const e of files.staged.values()) if (e.path === name) return true;
    return false;
  }
  const stagedCount = () => (engine && engine.svc.files ? engine.svc.files.staged.size : 0);
  // The page goes for good with files in a tray. Their reservations would count against the person's 20 open uploads
  // and the workspace's files for an hour (server/src/workspace.js), and nothing can send them any more: the page's
  // cache and drafts are in memory, where desktop's draft keeps its ready files over a restart. So each one is cancelled
  // as files.js does for a removed file, with requests the browser still sends after the page has gone. A file whose
  // reservation is still on its way, or a message in the outbox, isn't reached; beforeunload warned about those.
  function releaseStaged() {
    const files = engine && engine.svc.files;
    if (!files) return;
    for (const e of files.staged.values()) {
      if (!e.file) continue;
      account.workspaceCall('DELETE', `/v1/workspaces/${e.ws}/conversations/${e.conversation}/uploads/${e.file}`, undefined, { keepalive: true }).catch(() => {});
    }
  }

  // ---- start ----

  let timing = { fileCacheMax: FILE_CACHE_MAX };
  if (test && test.chatFast === true) timing = { ...timing, ...chatTiming({ SEM_HIDDEN: '1', SEM_CHAT_FAST: '1' }) };
  if (test && test.timing && typeof test.timing === 'object') timing = { ...timing, ...test.timing };

  const ready = (async () => {
    try {
      // The stored session first, so the engine's first look sees it (account/service.js init()).
      await account.init();
    } catch (err) {
      log.error('[web] the Rukoo account could not start', err);
    }
    try {
      engine = await createWebEngine({
        account,
        settings: () => settings,
        // main.js 2232-2234. Every state also says how many messages this tab still has to send, for the other tabs.
        onEvent: (payload) => {
          if (payload && payload.kind === 'state' && payload.state) {
            publishUnsent(payload.state.unsent);
            emit('chat', { ...payload, state: webState(payload.state) });
            return;
          }
          // A tray changed: a picked file it sent or let go of may be needed by nothing any more.
          if (payload && payload.kind === 'staged') webFiles.prunePicked(pickedInUse);
          emit('chat', payload);
        },
        onNotify: showChatNotification,
        onUnnotify: closeChatNotification,
        timing,
        host: webFiles.host
      });
    } catch (err) {
      // Chat stays unavailable (chatState is the blank state, as before main.js made the service, with engineFailed
      // while the server has chat); the account works.
      engineError = String((err && err.message) || err || 'unknown').slice(0, 500);
      log.error('[web] team chat could not start', err);
      return;
    }
    engine.setFocused(pageFocused());
    publishUnsent(engine.unsent());
    offerJoin();
  })();

  // ---- the calls ----

  const methods = {};
  for (const name of Object.keys(offline)) methods[name] = (...args) => chat()[name](...args);
  // unsentElsewhere (web only): what the other tabs still have to send in this session, which a sign-out here loses
  // too (rukoo-account.js adds it to the sign-out warning). The call takes the engine's own lostUnsent as on desktop,
  // but not lostUnsentElsewhere: any read, such as Settings counting for its sign-out warning, could come before Chat's
  // notice, which then would say nothing.
  methods.chatState = async (...args) => {
    const state = webState(await chat().chatState(...args));
    return state && typeof state === 'object' ? { ...state, unsentElsewhere: unsentElsewhere() } : state;
  };
  // Attach is hidden where the files are out of reach (webState); a drop or paste the renderer still sends says why.
  for (const name of ['chatPickFiles', 'chatStage']) {
    const run = methods[name];
    methods[name] = (...args) => {
      if (filesElsewhere()) throw filesElsewhereError();
      return run(...args);
    };
  }
  // A new pick: what earlier picks left that nothing needs any more goes (files.js has the new paths by now).
  const pick = methods.chatPickFiles;
  methods.chatPickFiles = async (...args) => {
    const res = await pick(...args);
    webFiles.prunePicked(pickedInUse);
    return res;
  };
  // chat.js noticeLostUnsent (web only): its toast said that count of lostUnsentElsewhere, so the page stops reporting
  // those. A loss that came after the toast stays for the next one. Answers what is left.
  methods.webLostUnsentShown = (count) => {
    if (Number.isSafeInteger(count) && count > 0) lostElsewhere -= Math.min(count, lostElsewhere);
    return lostElsewhere;
  };
  // chatFile (chat-view.js viewUrl and fileAction). 'view': main.js serves desktop's rukoo-chat-file: link
  // (serveChatFile), which no page can load, so the link becomes a blob: URL of the same file here, typed as serve()
  // types it. 'open': a page can't hand a file to an app, so an image of a type the viewer shows opens in a new tab and
  // anything else downloads, as 'save' does (src/web/files.js). Both answer 'download' or 'tab' instead of true: the
  // browser shows the download itself, and chat-view.js's "Saved" toast would say it twice.
  methods.chatFile = async (ws, c, file, action, ...rest) => {
    if (filesElsewhere()) throw filesElsewhereError();
    if (action === 'open') return openFile(ws, c, file);
    const res = await chat().chatFile(ws, c, file, action, ...rest);
    if (action === 'view') {
      const hit = res && typeof res.url === 'string' ? servedView(res.url) : null;
      return { url: hit ? webFiles.viewUrl(hit.path, hit.type) : null };
    }
    return res === true ? 'download' : res;
  };
  // The file's type is the one the server named, as the log decides whether it shows as an image (chat-model.js
  // VIEWABLE, files.js VIEW_TYPES). A tab the browser refused, after a download that outlasted the click's permission
  // to open one, becomes a download.
  async function openFile(ws, c, file) {
    const res = await chat().chatFile(ws, c, file, 'view');
    const hit = res && typeof res.url === 'string' ? servedView(res.url) : null;
    if (hit && VIEW_TYPES.has(hit.type) && webFiles.openTab(hit.path, hit.type)) return 'tab';
    const saved = await chat().chatFile(ws, c, file, 'save');
    return saved === true ? 'download' : saved;
  }
  methods.chatJoin = async (...args) => {
    const res = await chat().chatJoin(...args);
    joined(args[0]);
    return res;
  };
  // chat.js maybeTakeJoin: the Join dialog that the page's invitation opened closed, joined, opened or cancelled. The
  // person chose, so a reload doesn't offer the invitation again. link: the one chatTakePendingJoin gave; another
  // invitation stays. Answers whether the page dropped its invitation.
  methods.webForgetInvitation = (link) => {
    const stored = join.peek();
    if (!stored) return false;
    let secret = null;
    try {
      secret = parseInviteLink(String(link || '')).secret;
    } catch (_) {
      return false;
    }
    if (secret !== stored.secret) return false;
    dropInvitation();
    return true;
  };

  // What main.js's serveChatFile serves for a view link: files.js serve(link), which checks that the link's file is
  // still in the cache, of the same room and with the same bytes. A browser whose URL parser reads no host in a link of
  // a scheme it doesn't know (Chromium before 130) gets the same checks here, on the token read by its pattern: serve()
  // would refuse every link there.
  function servedView(link) {
    const svc = engine && engine.svc;
    if (!svc || !svc.files) return null;
    if (standardUrls) return svc.files.serve(link);
    const m = VIEW_LINK.exec(link);
    const v = m ? svc.files.views.get(m[1]) : null;
    if (!v || v.epoch !== svc.epoch || !svc.store) return null;
    const row = svc.store.getCachedFile(v.ws, v.file);
    if (!row || row.room !== v.room || row.sha256 !== v.sha256 || !vfs.get(v.path)) return null;
    return { path: v.path, type: VIEW_TYPES.has(v.type) ? v.type : 'application/octet-stream', name: v.name };
  }

  // The Rukoo account (main.js 1491-1523). The service cleans its input as main.js's handlers do.
  // invitation (web only): the page holds an invitation link (src/web/join.js) that a sign-up uses, so the sign-up form
  // asks for no invite code. session (web only): the session's tag, as in the 'account' event.
  methods.accountStatus = async () => {
    const status = await account.accountStatus();
    return { ...status, invitation: Boolean(join.peek()), session: status.signedIn ? account.sessionTag : null };
  };
  methods.accountServerInfo = () => account.accountServerInfo();
  // main.js 1497-1508: the invite field takes an invite code or a team chat invitation link; a link for this server
  // signs up with workspaceInvite and is remembered for the Join dialog. On the web an empty field takes the page's
  // invitation instead, which an invite-only server accepts in place of a code; an invite code the user typed goes as
  // it is, and the page's invitation still waits for the Join dialog afterwards.
  methods.accountSignUp = async (input) => {
    const i = plainObject(input);
    const field = accountText(i.invite, 2000);
    const split = engine ? engine.svc.manage.splitInvite(field) : { invite: field, workspaceInvite: null, link: null };
    let workspaceInvite = split.workspaceInvite;
    if (!split.link && !split.invite.trim()) {
      const stored = join.peek();
      if (stored) workspaceInvite = { workspace: stored.workspace, invite: stored.secret };
    }
    const res = await account.accountSignUp({
      email: accountText(i.email, 320),
      password: accountText(i.password, 1000),
      invite: accountText(split.invite, 200),
      workspaceInvite: workspaceInvite || undefined
    });
    offerJoin(split.link);
    return res;
  };
  methods.accountSignIn = async (input) => {
    const res = await account.accountSignIn(input);
    offerJoin();
    return res;
  };
  methods.accountRecover = async (input) => {
    const res = await account.accountRecover(input);
    offerJoin();
    return res;
  };
  // The sign-out and delete dialogs name the account they were opened for (rukoo-account.js, web only). Another tab
  // can sign this browser in to another account while one is open; the action then stops instead of ending that one.
  function sameAccount(expect) {
    const email = expect && typeof expect === 'object' ? expect.email : null;
    const status = account.status();
    if (typeof email === 'string' && status.signedIn && status.email !== email) {
      throw new AccountError('account_changed', 0, 'account_changed');
    }
  }
  // This tab's own ending of the session it has now: endingHere lets the status listener hold what the session's end
  // took until fn is done, and the account's 'ended' event says whether fn's request ended it (see endingHere).
  async function endHere(fn) {
    const tag = account.sessionTag;
    let own = tag ? endingHere.get(tag) : null;
    if (tag && !own) {
      own = { runs: 0, warned: new Set(), took: null, ended: false };
      endingHere.set(tag, own);
    }
    if (own) {
      own.runs += 1;
      if (engine) for (const id of engine.unsentIds()) own.warned.add(id);
    }
    try {
      const res = await fn();
      dropInvitation();
      dropUnsentOf(tag);
      return res;
    } finally {
      if (own && --own.runs === 0) {
        endingHere.delete(tag);
        settleEnding(own);
      }
    }
  }
  // What the session's end took and nobody confirmed goes to Chat's notice, with a state event that carries it.
  function settleEnding(own) {
    if (!own.took || !engine) return;
    const lost = own.ended ? own.took.filter((id) => !own.warned.has(id)).length : own.took.length;
    if (lost <= 0) return;
    lostElsewhere += lost;
    try {
      emit('chat', { kind: 'state', state: webState(engine.svc.state()) });
    } catch (err) {
      log.error('[web] the chat state could not be sent', err);
    }
  }
  methods.accountSignOut = async (expect) => {
    sameAccount(expect);
    const res = await endHere(() => account.accountSignOut());
    // Another tab signed this browser in to another account before the sign-out's answer came: it is not signed out,
    // so Settings and the chat-off page say that instead of "Signed out".
    if (res && res.signedIn) throw new AccountError('account_changed', 0, 'account_changed');
    return res;
  };
  methods.accountDetails = () => account.accountDetails();
  methods.accountRemoveDevice = (id) => account.accountRemoveDevice(id);
  methods.accountDelete = async (password, expect) => {
    sameAccount(expect);
    return endHere(() => account.accountDelete(password));
  };

  // The window's own (main.js api). No mail accounts, agents or Google here; web: true says which host this is.
  methods.state = () => ({ accounts: [], settings: { ...settings }, providers: [], googleAvailable: false, demoEmail: null, web: true });
  // main.js 1180-1203: language and theme go to the window as events, and chatNotifications to the engine.
  methods.updateSettings = (patch) => {
    const p = plainObject(patch);
    const next = { ...settings };
    for (const key of ['language', 'theme', 'chatNotifications']) if (Object.hasOwn(p, key)) next[key] = p[key];
    settings = normalize(next);
    saveSettings();
    if (Object.hasOwn(p, 'theme')) emit('theme');
    if (Object.hasOwn(p, 'language')) {
      i18n.setLanguage(settings.language);
      emit('language');
    }
    if (Object.hasOwn(p, 'chatNotifications') && engine) engine.settingsChanged();
    return { ...settings };
  };
  // The browser's own zoom and no taskbar badge.
  methods.setZoom = () => null;
  methods.setBadge = () => null;
  // diag.js reports what the window caught; the browser's console has the uncaught errors already.
  methods.logRenderer = (entry) => {
    const e = plainObject(entry);
    log.debug(`[renderer] ${accountText(e.kind, 40)}: ${accountText(e.message, 2000)}`);
    return null;
  };
  // main.js toastMain: a toast in the (one) window.
  methods.toastMain = (message) => {
    emit('toast', String(message || '').slice(0, 200));
  };
  methods.openExternal = (url) => {
    if (safeUrl(url)) page.open(String(url), '_blank', 'noopener,noreferrer');
  };
  // Check for updates: the page's code comes from the server, so a reload is the update.
  methods.updatesOpen = () => {
    location.reload();
  };
  // Desktop: { supported }. permission says whether the page may show one ('granted') or has to ask first, and is
  // 'unsupported' where the page can't show one (no Notification, or one it can't construct, as on Android's Chrome).
  methods.notificationState = () => {
    if (!notifySupported()) return { supported: false, permission: 'unsupported' };
    return { supported: true, permission: String(page.Notification.permission || 'default') };
  };

  function unavailable() {
    try {
      return t('web.unavailable');
    } catch (_) {
      return UNAVAILABLE;
    }
  }

  // An account error is worded here, as src/main/account/index.js fail() (74-77) words it before main.js passes the
  // message on (main.js 1998-2010); the service leaves its code as the message.
  const accountCode = (err) => (ERRORS.has(err.code) ? err.code : 'server');
  function accountMessage(err) {
    const known = accountCode(err);
    try {
      return t(`account.errors.${known}`);
    } catch (_) {
      return err.message || known;
    }
  }

  // main.js 1998-2010 (the mail:call handler): { ok: true, result } or { ok: false, error, ...windowError(err) }. An
  // account error also carries its code here (desktop passes none), so the sign-up form can tell a refused invitation.
  function answerError(err) {
    if (err && err.chat === true && typeof err.code === 'string') return { ok: false, error: (err && err.message) || String(err), ...chatDetails(err) };
    if (err instanceof AccountError) return { ok: false, error: accountMessage(err), code: accountCode(err) };
    return { ok: false, error: (err && err.message) || String(err) };
  }

  async function invoke(method, ...args) {
    const name = String(method);
    if (!Object.hasOwn(methods, name)) {
      log.warn(`[web] window.mail.${name} is not available in the browser`);
      return { ok: false, error: unavailable() };
    }
    const input = clone(args);
    await ready;
    try {
      const result = await methods[name](...input);
      return { ok: true, result: clone(result) };
    } catch (err) {
      return answerError(err);
    }
  }

  const mail = Object.freeze({
    platform: 'web',
    // preload.js call(): the result, or main's message thrown.
    async call(method, ...args) {
      const res = await invoke(method, ...args);
      if (!res.ok) throw new Error(res.error);
      return res.result;
    },
    invoke,
    on(listener) {
      if (typeof listener !== 'function') return () => {};
      const entry = { fn: listener };
      listeners.add(entry);
      return () => listeners.delete(entry);
    },
    // A page has no file paths: a dropped or pasted file has none, and chat-input.js stages its bytes instead.
    pathForFile() {
      return '';
    }
  });

  // ---- the page's events ----

  const on = (target, type, fn) => {
    if (target && typeof target.addEventListener === 'function') target.addEventListener(type, fn);
  };
  // main.js 2048-2068: focused when the window gains focus, shows or is restored; not when it blurs or hides.
  on(page, 'focus', () => {
    if (engine) engine.setFocused(!doc || doc.visibilityState !== 'hidden');
  });
  on(page, 'blur', () => {
    if (engine) engine.setFocused(false);
  });
  on(doc, 'visibilitychange', () => {
    if (engine) engine.setFocused(pageFocused());
    // main.js 2235-2236 nudges after a resume or an unlock; a tab coming back into view is the page's equivalent.
    if (engine && doc.visibilityState !== 'hidden') engine.nudge('resume');
  });
  on(page, 'online', () => {
    if (engine) engine.nudge('resume');
  });
  // Back from the browser's back-forward cache, with its sockets closed meanwhile.
  on(page, 'pageshow', (event) => {
    if (!event || !event.persisted || !engine) return;
    published = null;
    publishUnsent(engine.unsent());
    engine.setFocused(pageFocused());
    engine.nudge('resume');
  });
  // The tab closes, reloads or goes into the back-forward cache: its messages no longer count for the other tabs.
  // pagehide rather than beforeunload, which the person can still answer by staying. Unless the page waits in the
  // back-forward cache (persisted), it won't come back, and its staged files' reservations go (releaseStaged).
  on(page, 'pagehide', (event) => {
    published = null;
    try {
      if (local) local.removeItem(unsentKey);
    } catch (_) {
      // Refused storage held no count either.
    }
    if (!(event && event.persisted)) releaseStaged();
  });
  // Another tab signed in or out (key null: it cleared the site's storage), or changed the settings.
  on(page, 'storage', (event) => {
    const key = event ? event.key : null;
    if (key === SESSION_KEY || key === null) {
      account
        .storageChanged()
        .then(() => offerJoin())
        .catch((err) => log.error('[web] the session of another tab could not be read', err));
    }
    if (key === SETTINGS_KEY || key === null) {
      const before = settings;
      settings = readSettings();
      if (settings.theme !== before.theme) emit('theme');
      if (settings.language !== before.language) {
        i18n.setLanguage(settings.language);
        emit('language');
      }
      if (settings.chatNotifications !== before.chatNotifications && engine) engine.settingsChanged();
    }
  });
  // The chat cache is in memory, so unsent messages and the files in a tray go with the page: the browser asks first.
  on(page, 'beforeunload', (event) => {
    if (!engine || !(engine.unsent() > 0 || stagedCount() > 0)) return;
    event.preventDefault();
    event.returnValue = true;
  });
  // main.js 2312-2314: the system's dark or light mode changed.
  try {
    const query = typeof page.matchMedia === 'function' ? page.matchMedia('(prefers-color-scheme: dark)') : null;
    if (query && typeof query.addEventListener === 'function') query.addEventListener('change', () => emit('theme'));
    else if (query && typeof query.addListener === 'function') query.addListener(() => emit('theme'));
  } catch (_) {
    // No media queries: the theme follows only the setting.
  }

  const host = {
    mail,
    ready,
    account,
    join,
    engine: () => engine
  };
  if (test) {
    test.account = account;
    test.join = join;
    test.ready = ready;
    Object.defineProperty(test, 'engine', { get: () => engine, configurable: true });
  }
  return host;
}

module.exports = { createHost, chatDetails, firstLanguage, serverAddress, SETTINGS_KEY };
