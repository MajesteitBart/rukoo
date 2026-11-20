// window.mail in the browser (src/web/bridge.js, host.js, join.js): the bridge bundled as the app build bundles it
// (src/web/build-options.mjs) and run as the page runs it, in a context with a page's globals and none of Node's,
// after the i18n scripts. The page around it is a fake: storage, history, focus, the Notification API and a Worker
// that hashes with hash-wasm, and fetch, which serves sql-wasm.wasm and passes the rest to the network. The account
// and chat calls go to the real account server (test/fixtures/real-server.js) where server/node_modules is installed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import * as esbuild from 'esbuild';
import { webBuildOptions, sqlWasm } from '../../src/web/build-options.mjs';

const root = path.resolve(import.meta.dirname, '..', '..');
const websiteDir = path.join(root, 'website');
const require = createRequire(import.meta.url);
// From website/node_modules: the website's CI job installs no root packages.
const { argon2id } = require('hash-wasm');
const { handle } = require('../../src/web/account/argon2-worker.js');
const { startRealServer, realServerAvailable, skipWithoutServer } = require('../../test/fixtures/real-server.js');
// The desktop's table of chat* methods, for their names.
const { chatApi } = require('../../src/main/workspaces/ipc.js');
const i18n = require('../../src/i18n/index.js');

const PASSWORD = 'a long enough password';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const W = (ch) => `w_${ch.repeat(22)}`;
const C = (ch) => `c_${ch.repeat(22)}`;
const SECRET = 's'.repeat(43);
const CHAT_METHODS = Object.keys(chatApi(() => null));
const wasm = fs.readFileSync(sqlWasm({ websiteDir }).from);

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'rukoo-web-bridge-'));
const [bridgeOptions] = webBuildOptions({ root, websiteDir, outdir: temp });
await esbuild.build({ ...bridgeOptions, logLevel: 'silent' });
const bridgeText = fs.readFileSync(path.join(temp, 'web', 'bridge.js'), 'utf8');
const i18nText = ['en.js', 'nl.js', 'index.js'].map((f) => [f, fs.readFileSync(path.join(root, 'src', 'i18n', f), 'utf8')]);

const pages = new Set();
test.after(() => {
  for (const p of pages) p.close();
  fs.rmSync(temp, { recursive: true, force: true });
});

let real = null;
test.before(async () => {
  if (realServerAvailable()) real = await startRealServer();
});
test.after(() => real?.close());

async function until(check, ms = 15000, what = 'the condition') {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`Timed out after ${ms} ms waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function memoryStorage() {
  const map = new Map();
  return {
    map,
    get length() {
      return map.size;
    },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => void map.set(key, String(value)),
    removeItem: (key) => void map.delete(key)
  };
}

// The tabs' published unsent counts in a localStorage (src/web/host.js UNSENT_PREFIX).
const unsentCounts = (local) => [...local.map].filter(([key]) => key.startsWith('rukoo.web.unsent.')).map(([, value]) => JSON.parse(value).count);
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
// GET /v1/info of a server with team chat, or without it.
const chatInfo = (on = true) => ({
  protocol: 1,
  signups: 'open',
  features: on ? ['workspaces-v1'] : [],
  ...(on ? { workspace: { versions: [1], inviteSignups: false } } : {})
});

// addEventListener and a dispatch that returns the event, for the window, the document and a media query.
function eventTarget(target = {}) {
  const listeners = new Map();
  target.addEventListener = (type, fn) => {
    if (!listeners.has(type)) listeners.set(type, []);
    listeners.get(type).push(fn);
  };
  target.removeEventListener = (type, fn) => {
    const list = listeners.get(type) || [];
    if (list.includes(fn)) list.splice(list.indexOf(fn), 1);
  };
  target.dispatch = (type, fields = {}) => {
    const event = {
      type,
      defaultPrevented: false,
      returnValue: undefined,
      preventDefault() {
        this.defaultPrevented = true;
      },
      ...fields
    };
    for (const fn of [...(listeners.get(type) || [])]) fn(event);
    return event;
  };
  return target;
}

// A page at url that has loaded i18n/*.js and then web/bridge.js. local and session are its storage (share them for
// another tab or a reload); test is window.__rukooWebTest, which gives the test the engine to look into and close.
// serve(url, init): an answer of the test's own for a request, or undefined for the usual one. userAgent: the
// browser's. notificationThrows: Notification constructs none, as on Android's Chrome.
function openPage({
  url = 'https://rukoo.example/app/',
  local = memoryStorage(),
  session = memoryStorage(),
  languages = ['en-GB'],
  visible = true,
  focused = true,
  permission = 'default',
  meta = null,
  dark = true,
  network = false,
  catalogs = true,
  serve = null,
  userAgent = UA,
  notificationThrows = false,
  test: hook = { timing: { coalesce: 5 } }
} = {}) {
  let href = new URL(url);
  const state = { visible, focused, network };
  const logs = { warn: [], error: [], debug: [] };
  const record = { opened: [], focus: 0, reloads: 0, replaced: [], notifications: [], workers: [], asked: 0, fetched: [] };
  const events = [];
  let pageRealm = null;

  const location = {
    get origin() {
      return href.origin;
    },
    get pathname() {
      return href.pathname;
    },
    get search() {
      return href.search;
    },
    get hash() {
      return href.hash;
    },
    get href() {
      return href.href;
    },
    reload() {
      record.reloads += 1;
    }
  };
  const history = {
    state: null,
    replaceState(next, _title, to) {
      record.replaced.push(String(to));
      href = new URL(String(to), href);
      this.state = next;
    }
  };
  const metaElement = meta ? { getAttribute: (name) => (name === 'content' ? meta : null) } : null;
  const document = eventTarget({
    title: 'Rukoo',
    currentScript: null,
    get baseURI() {
      return href.href;
    },
    get visibilityState() {
      return state.visible ? 'visible' : 'hidden';
    },
    hasFocus: () => state.visible && state.focused,
    documentElement: { lang: '', dir: '' },
    querySelector: (selector) => (selector === 'meta[name="rukoo-server"]' ? metaElement : null)
  });
  const window = eventTarget({});
  const media = eventTarget({ matches: dark, media: '(prefers-color-scheme: dark)' });

  class Notification {
    static permission = permission;
    static requestPermission() {
      record.asked += 1;
      return Promise.resolve(Notification.permission);
    }
    constructor(title, options = {}) {
      if (notificationThrows) throw new TypeError("Failed to construct 'Notification': Illegal constructor. Use ServiceWorkerRegistration.showNotification() instead.");
      Object.assign(this, { title, body: options.body, tag: options.tag, closed: false });
      record.notifications.push(this);
    }
    close() {
      this.closed = true;
    }
  }

  // The Argon2id worker (src/web/account/argon2-worker.js) on hash-wasm, its messages copied as postMessage does.
  class Worker {
    constructor(workerUrl) {
      this.url = String(workerUrl);
      record.workers.push(this.url);
    }
    postMessage(data) {
      handle(structuredClone(data), argon2id).then((reply) => {
        const copy = structuredClone(reply);
        if (copy.hash) copy.hash = new pageRealm.Uint8Array(copy.hash);
        this.onmessage?.({ data: copy });
      });
    }
    terminate() {}
  }

  async function pageFetch(input, init) {
    const target = new URL(String(input), href);
    record.fetched.push(target.href);
    const own = serve ? await serve(target, init) : undefined;
    if (own) return own;
    if (target.pathname === '/app/web/sql-wasm.wasm') return new Response(wasm, { headers: { 'content-type': 'application/wasm' } });
    if (!state.network) throw new TypeError('Failed to fetch');
    return fetch(target, init);
  }

  const console = {
    log: () => {},
    info: () => {},
    debug: (...args) => logs.debug.push(args.join(' ')),
    warn: (...args) => logs.warn.push(args.map(String).join(' ')),
    error: (...args) => logs.error.push(args.map(String).join(' '))
  };

  const context = vm.createContext({
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    structuredClone,
    TextEncoder,
    TextDecoder,
    URL,
    URLSearchParams,
    AbortController,
    AbortSignal,
    btoa,
    atob,
    crypto: globalThis.crypto,
    WebSocket: globalThis.WebSocket,
    fetch: pageFetch,
    Response,
    Headers,
    document,
    location,
    history,
    localStorage: local,
    sessionStorage: session,
    navigator: { languages, language: languages[0], userAgent },
    Notification,
    Worker,
    matchMedia: () => media,
    open: (...args) => void record.opened.push(args),
    focus: () => void (record.focus += 1),
    addEventListener: window.addEventListener,
    removeEventListener: window.removeEventListener,
    ...(hook ? { __rukooWebTest: hook } : {})
  });
  vm.runInContext('globalThis.window = globalThis; globalThis.self = globalThis;', context);
  pageRealm = { Uint8Array: vm.runInContext('Uint8Array', context) };
  if (catalogs) for (const [file, text] of i18nText) vm.runInContext(text, context, { filename: `i18n/${file}` });
  document.currentScript = { src: new URL('web/bridge.js', href).href };
  vm.runInContext(bridgeText, context, { filename: 'web/bridge.js' });
  document.currentScript = null;

  const mail = context.mail;
  mail.on((event) => events.push(event));
  const page = {
    context,
    mail,
    window,
    document,
    media,
    Notification,
    local,
    session,
    record,
    logs,
    events,
    test: hook,
    location,
    call: (method, ...args) => mail.call(method, ...args),
    invoke: (method, ...args) => mail.invoke(method, ...args),
    chatState: () => mail.call('chatState'),
    // The tab goes to the back (visible false) or comes forward; focused: whether it has focus then.
    show(isVisible, isFocused = isVisible) {
      state.visible = isVisible;
      state.focused = isFocused;
      document.dispatch('visibilitychange');
    },
    setFocus(isFocused) {
      state.focused = isFocused;
      window.dispatch(isFocused ? 'focus' : 'blur');
    },
    // The network goes away (requests fail as a browser's fetch does offline) or comes back.
    setNetwork(on) {
      state.network = on;
    },
    eventsOf: (type) => events.filter((e) => e.type === type),
    async ready() {
      await hook.ready;
      return page;
    },
    close() {
      pages.delete(page);
      if (hook && hook.engine) hook.engine.dispose();
    }
  };
  pages.add(page);
  return page;
}

const serverPage = (options = {}) => openPage({ url: `${real.url}/app/`, network: true, ...options });
const inviteHash = (ws, secret) => `#w=${ws}&i=${secret}`;
const tr = (lang, key) => i18n.translate(lang, key);

test('window.mail is there as soon as the script has run, with the desktop surface and no Node in the page', async (t) => {
  const page = openPage({ languages: ['nl-NL', 'en'] });
  t.after(() => page.close());
  // Before anything was awaited: the bridge is synchronous, and the language is set for the shell's first labels.
  assert.equal(typeof page.mail.invoke, 'function');
  assert.deepEqual(Object.keys(page.mail).sort(), ['call', 'invoke', 'on', 'pathForFile', 'platform']);
  assert.equal(page.mail.platform, 'web');
  assert.ok(Object.isFrozen(page.mail));
  assert.equal(page.mail.pathForFile({ name: 'a.txt' }), '');
  assert.equal(page.document.documentElement.lang, 'nl');
  assert.equal(vm.runInContext('RukooI18n.getLanguage()', page.context), 'nl');
  for (const name of ['require', 'process', 'Buffer', 'module', 'exports', 'global']) {
    assert.equal(vm.runInContext(`typeof ${name}`, page.context), 'undefined', `the page has no ${name}`);
  }
  // The engine's module read the bridge's address while the script ran: the wasm comes from beside it.
  await page.ready();
  assert.ok(page.test.engine, 'the chat engine started on sql.js');
  assert.ok(page.record.fetched.includes('https://rukoo.example/app/web/sql-wasm.wasm'), page.record.fetched.join(', '));
  assert.deepEqual(page.logs.error, []);

  const state = await page.call('state');
  assert.deepEqual({ ...state, settings: { ...state.settings } }, {
    accounts: [],
    settings: { language: 'nl', theme: 'system', chatNotifications: true },
    providers: [],
    googleAvailable: false,
    demoEmail: null,
    web: true
  });
});

test('every chat*, account and host method answers; anything else says it is not in the browser and warns', async (t) => {
  const page = openPage();
  t.after(() => page.close());
  await page.ready();
  assert.equal(CHAT_METHODS.length, 43);
  for (const name of CHAT_METHODS) {
    const res = await page.invoke(name);
    if (name === 'chatState') {
      assert.equal(res.ok, true, name);
      assert.equal(res.result.signedIn, false);
      assert.equal(res.result.available, false, 'no /v1/info: team chat is unavailable');
    } else {
      // From chatApi itself: its argument check, or signed_out without a cache.
      assert.equal(res.ok, false, name);
      assert.ok(['invalid', 'signed_out'].includes(res.code), `${name}: ${res.code}`);
      assert.ok(res.error && res.error !== 'Not available in the browser', name);
    }
  }
  assert.deepEqual(page.logs.warn, [], 'no chat method is unknown');

  // The account: the network is down here, so info and a sign-in say network, worded in the page's language.
  assert.equal((await page.call('accountStatus')).signedIn, false);
  assert.equal((await page.call('accountStatus')).invitation, false, 'no invitation on this page');
  const info = await page.invoke('accountServerInfo');
  assert.deepEqual({ ...info }, { ok: false, error: tr('en', 'account.errors.network'), code: 'network' });
  assert.deepEqual({ ...(await page.invoke('accountSignIn', { email: 'nope', password: 'x' })) }, { ok: false, error: tr('en', 'account.errors.invalid_email'), code: 'invalid_email' });
  assert.deepEqual({ ...(await page.invoke('accountDetails')) }, { ok: false, error: tr('en', 'account.errors.signed_out'), code: 'signed_out' });
  assert.equal((await page.invoke('accountSignOut')).ok, true);
  assert.equal((await page.invoke('accountRemoveDevice', 'd')).error, tr('en', 'account.errors.signed_out'));
  assert.equal((await page.invoke('accountDelete', 'x')).error, tr('en', 'account.errors.signed_out'));
  assert.equal((await page.invoke('accountSignUp', { email: 'a@example.test', password: 'short' })).error, tr('en', 'account.errors.weak_password'));
  assert.equal((await page.invoke('accountRecover', { email: 'a@example.test', recoveryKey: 'x', password: PASSWORD })).error, tr('en', 'account.errors.recovery_key'));

  // The window's own.
  for (const name of ['setZoom', 'setBadge']) assert.deepEqual({ ...(await page.invoke(name, 120)) }, { ok: true, result: null });
  assert.deepEqual({ ...(await page.invoke('logRenderer', { kind: 'error', message: 'Boom' })) }, { ok: true, result: null });
  assert.ok(page.logs.debug.some((l) => l.includes('error: Boom')));
  await page.call('toastMain', 'Saved');
  await until(() => page.eventsOf('toast').length, 2000, 'the toast event');
  assert.deepEqual({ ...page.eventsOf('toast')[0] }, { type: 'toast', payload: 'Saved' });
  await page.call('openExternal', 'https://example.test/help');
  await page.call('openExternal', 'mailto:help@example.test');
  await page.call('openExternal', 'javascript:alert(1)');
  assert.deepEqual(page.record.opened, [
    ['https://example.test/help', '_blank', 'noopener,noreferrer'],
    ['mailto:help@example.test', '_blank', 'noopener,noreferrer']
  ]);
  await page.call('updatesOpen');
  assert.equal(page.record.reloads, 1, 'Check for updates reloads the page');
  assert.deepEqual({ ...(await page.call('notificationState')) }, { supported: true, permission: 'default' });

  // Mail, agents and the desktop-only account rows aren't here. Never a throw.
  for (const name of ['list', 'counts', 'agentConfig', 'accountSetServer', 'accountSync', 'accountChangePassword', 'accountNewRecoveryKey', 'accountExport', 'nativeEdit', '__proto__', 'constructor']) {
    assert.deepEqual({ ...(await page.invoke(name)) }, { ok: false, error: 'Not available in the browser' }, name);
    assert.ok(page.logs.warn.some((w) => w.includes(`window.mail.${name} `)), `${name} warns`);
  }
  await assert.rejects(page.call('list'), /Not available in the browser/);
  assert.deepEqual(page.logs.error, []);
});

test('a page without its catalogs still gets a window.mail, which says why nothing works', async () => {
  const page = openPage({ catalogs: false, test: null });
  assert.equal(page.mail.platform, 'web');
  const res = await page.invoke('state');
  assert.equal(res.ok, false);
  assert.match(res.error, /RukooI18n is missing/);
  await assert.rejects(page.call('chatState'), /RukooI18n is missing/);
  assert.ok(page.logs.error.some((l) => l.includes('[web] Rukoo could not start')));
  page.close();
});

// The calls the renderer modules the web app loads make, by name: each must reach a handler. The desktop-only rows of
// rukoo-account.js (hidden on the web) and ui.js's nativeEdit (for a desktop menu event the web never sends) get the
// "not in the browser" answer.
test('every method the chat, account, ui, i18n, diag and web shell modules call has an answer', async (t) => {
  const files = fs
    .readdirSync(path.join(root, 'src', 'renderer'))
    .filter((f) => /^chat.*\.js$/.test(f) || ['rukoo-account.js', 'ui.js', 'i18n.js', 'diag.js', 'web-shell.js'].includes(f));
  assert.ok(files.includes('chat.js') && files.includes('rukoo-account.js'));
  const called = new Set();
  for (const file of files) {
    const text = fs.readFileSync(path.join(root, 'src', 'renderer', file), 'utf8');
    for (const m of text.matchAll(/\b(?:api|invoke|call)\(\s*['"`]([A-Za-z]+)['"`]/g)) called.add(m[1]);
  }
  const desktopOnly = new Set(['accountSetServer', 'accountSync', 'accountChangePassword', 'accountNewRecoveryKey', 'accountExport', 'nativeEdit']);
  const page = openPage();
  t.after(() => page.close());
  await page.ready();
  assert.ok(called.size >= 60, `${called.size} methods found`);
  for (const name of [...called].sort()) {
    const res = await page.invoke(name);
    const unknown = !res.ok && res.error === 'Not available in the browser';
    assert.equal(unknown, desktopOnly.has(name), `${name}: ${JSON.stringify(res).slice(0, 200)}`);
  }
});

test('settings: the first visit takes the browser language, a choice persists, and language and theme come as events', async (t) => {
  for (const [languages, expected] of [
    [['de-DE', 'en-US', 'nl'], 'en'],
    [['fr-FR'], 'en'],
    [['NL-be', 'en'], 'nl'],
    [[], 'en']
  ]) {
    const p = openPage({ languages, test: null });
    assert.equal((await p.call('state')).settings.language, expected, languages.join(','));
    p.close();
  }

  const local = memoryStorage();
  const page = openPage({ local, languages: ['nl'] });
  t.after(() => page.close());
  await page.ready();
  assert.equal(local.map.has('rukoo.web.settings'), false, 'nothing is stored before a choice');
  const saved = await page.call('updateSettings', { language: 'en', theme: 'light', chatNotifications: false, zoomLevel: 150 });
  assert.deepEqual({ ...saved }, { language: 'en', theme: 'light', chatNotifications: false });
  assert.deepEqual(JSON.parse(local.map.get('rukoo.web.settings')), { language: 'en', theme: 'light', chatNotifications: false });
  assert.equal(vm.runInContext('RukooI18n.getLanguage()', page.context), 'en');
  assert.equal(page.document.documentElement.lang, 'en');
  await until(() => page.eventsOf('language').length && page.eventsOf('theme').length, 2000, 'language and theme events');
  // The engine heard chatNotifications (main.js 1201): its state says so.
  await until(() => page.events.some((e) => e.type === 'chat' && e.payload.kind === 'state' && e.payload.state.notifications === false), 5000, 'the setting in a chat state');
  // An answer in the new language at once.
  assert.equal((await page.invoke('accountDetails')).error, tr('en', 'account.errors.signed_out'));
  await page.call('updateSettings', { theme: 'bogus' });
  assert.equal((await page.call('state')).settings.theme, 'system');

  // The system's light or dark mode (main.js 2312-2314).
  const themes = page.eventsOf('theme').length;
  page.media.dispatch('change', { matches: false });
  await until(() => page.eventsOf('theme').length === themes + 1, 2000, 'a theme event for the system change');

  // A reload, with another browser language: the choice holds.
  const again = openPage({ local, languages: ['nl'], test: null });
  assert.equal(again.document.documentElement.lang, 'en');
  assert.deepEqual({ ...(await again.call('state')).settings }, { language: 'en', theme: 'system', chatNotifications: false });
  again.close();

  // Another tab changed them: language, theme and the engine follow.
  local.setItem('rukoo.web.settings', JSON.stringify({ language: 'nl', theme: 'dark', chatNotifications: true }));
  const before = { language: page.eventsOf('language').length, theme: page.eventsOf('theme').length };
  page.window.dispatch('storage', { key: 'rukoo.web.settings' });
  await until(() => page.eventsOf('language').length > before.language && page.eventsOf('theme').length > before.theme, 2000, 'events for the other tab');
  assert.equal(vm.runInContext('RukooI18n.getLanguage()', page.context), 'nl');
  assert.equal((await page.invoke('accountDetails')).error, tr('nl', 'account.errors.signed_out'));
  assert.deepEqual(page.logs.error, []);
});

test('an invitation in the address is kept for the tab and taken out of the address bar', async () => {
  const session = memoryStorage();
  const link = `https://rukoo.example/join#w=${W('A')}&i=${SECRET}`;
  const page = openPage({ url: `https://rukoo.example/app/${inviteHash(W('A'), SECRET)}`, session, test: null });
  assert.deepEqual(page.record.replaced, ['/app/']);
  assert.equal(page.location.hash, '');
  assert.equal(session.map.get('rukoo.web.join'), link);
  // Signed out, nothing waits for the Join dialog yet.
  assert.equal((await page.chatState()).pendingJoin, false);
  page.close();

  // A reload keeps it, and has nothing to take out of the address.
  const reloaded = openPage({ url: 'https://rukoo.example/app/', session, test: null });
  assert.deepEqual(reloaded.record.replaced, []);
  assert.equal(session.map.get('rukoo.web.join'), link);
  reloaded.close();

  // i and w in either order; a query stays.
  const other = memoryStorage();
  const swapped = openPage({ url: `https://rukoo.example/app/?from=mail#i=${SECRET}&w=${W('B')}`, session: other, test: null });
  assert.deepEqual(swapped.record.replaced, ['/app/?from=mail']);
  assert.equal(other.map.get('rukoo.web.join'), `https://rukoo.example/join#w=${W('B')}&i=${SECRET}`);
  swapped.close();

  // A broken invitation leaves the address bar too, but isn't kept; another fragment stays where it is.
  for (const hash of [`#w=${W('A')}&i=short`, `#w=${W('A')}&i=${SECRET}&x=1`, `#i=${SECRET}`]) {
    const s = memoryStorage();
    const p = openPage({ url: `https://rukoo.example/app/${hash}`, session: s, test: null });
    assert.deepEqual(p.record.replaced, ['/app/'], hash);
    assert.equal(s.map.has('rukoo.web.join'), false, hash);
    p.close();
  }
  const s = memoryStorage();
  const plain = openPage({ url: 'https://rukoo.example/app/#general', session: s, test: null });
  assert.deepEqual(plain.record.replaced, []);
  assert.equal(plain.location.hash, '#general');
  assert.equal(s.map.has('rukoo.web.join'), false);
  plain.close();

  // The server is the page's own origin, or the rukoo-server meta for the account; the link is the origin's.
  const metaSession = memoryStorage();
  const withMeta = openPage({ url: `https://rukoo.example/app/${inviteHash(W('C'), SECRET)}`, session: metaSession, meta: 'https://accounts.rukoo.example', test: null });
  assert.equal((await withMeta.call('accountStatus')).server, 'https://accounts.rukoo.example');
  assert.equal(metaSession.map.get('rukoo.web.join'), `https://rukoo.example/join#w=${W('C')}&i=${SECRET}`);
  withMeta.close();
});

test('notifications: a toast while the page is in front, else a browser notification only when allowed, and the title left to the shell', async (t) => {
  const page = openPage({ permission: 'granted' });
  t.after(() => page.close());
  await page.ready();
  const svc = page.test.engine.svc;
  const open = { ws: W('A'), conversation: C('D'), seq: 7 };
  const id = `chat:${W('A')}:${C('D')}`;

  // In front, with focus: the tagged toast (main.js showChatNotification).
  svc.show({ id, title: 'Olga', body: 'Olga: hi', open });
  await until(() => page.eventsOf('chat-toast').length, 2000, 'the toast');
  assert.deepEqual({ ...page.eventsOf('chat-toast')[0].payload }, { id, body: 'Olga: hi' });
  assert.equal(page.record.notifications.length, 0);

  // Visible but another window has focus: a browser notification, tagged with the alert's id.
  page.setFocus(false);
  svc.show({ id, title: 'Olga', body: 'Olga: are you there?', open });
  assert.equal(page.record.notifications.length, 1);
  const shown = page.record.notifications[0];
  assert.deepEqual({ title: shown.title, body: shown.body, tag: shown.tag }, { title: 'Olga', body: 'Olga: are you there?', tag: id });
  // Taken back (read elsewhere): the notification closes, and a toast of it goes.
  svc.hide(id);
  assert.equal(shown.closed, true);
  await until(() => page.eventsOf('chat-toast-hide').some((e) => e.payload === id), 2000, 'chat-toast-hide');

  // In the background: the click brings the tab forward on that conversation (main.js openChatNotice).
  page.show(false);
  svc.show({ id, title: 'Olga', body: 'Olga: hello?', open });
  svc.show({ id: 'chat:summary', title: 'Rukoo', body: 'New messages in 4 conversations', open: { ws: 'nope' } });
  assert.equal(page.record.notifications.length, 3);
  page.record.notifications[1].onclick({});
  assert.equal(page.record.focus, 1);
  await until(() => page.eventsOf('chat').some((e) => e.payload.kind === 'open'), 2000, 'the open event');
  assert.deepEqual({ ...page.eventsOf('chat').find((e) => e.payload.kind === 'open').payload }, { kind: 'open', ws: W('A'), conversation: C('D'), seq: 7 });
  // A notice that names no conversation brings the tab forward and opens nothing.
  page.record.notifications[2].onclick({});
  assert.equal(page.record.focus, 2);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(page.eventsOf('chat').filter((e) => e.payload.kind === 'open').length, 1);
  page.show(true);

  // Not allowed by the browser, or turned off: no notification, and permission is never asked for.
  page.show(false);
  page.Notification.permission = 'default';
  svc.show({ id: 'chat:a', title: 'A', body: 'a', open });
  page.Notification.permission = 'denied';
  svc.show({ id: 'chat:b', title: 'B', body: 'b', open });
  page.Notification.permission = 'granted';
  await page.call('updateSettings', { chatNotifications: false });
  svc.show({ id: 'chat:c', title: 'C', body: 'c', open });
  assert.equal(page.record.notifications.length, 3);
  assert.equal(page.record.asked, 0);
  // The tab's title is web-shell.js's (chat.modeBadge()); the bridge never writes it.
  assert.equal(page.document.title, 'Rukoo');
  assert.deepEqual(page.logs.error, []);
});

test('focus, visibility, going online and leaving with unsent messages reach the engine', async (t) => {
  const page = openPage();
  t.after(() => page.close());
  await page.ready();
  const engine = page.test.engine;
  assert.equal(engine.svc.focused, true, 'focused from the start (main.js shows the window focused)');
  const calls = [];
  const setFocused = engine.svc.setFocused.bind(engine.svc);
  engine.svc.setFocused = (on) => {
    calls.push(['focused', on]);
    setFocused(on);
  };
  engine.svc.nudge = (why) => calls.push(['nudge', why]);

  page.setFocus(false);
  page.setFocus(true);
  page.show(false);
  page.show(true);
  page.show(true, false);
  page.window.dispatch('online');
  page.window.dispatch('pageshow', { persisted: false });
  page.window.dispatch('pageshow', { persisted: true });
  // Gaining focus nudges by itself (index.js setFocused); a tab coming into view, going online and a page back from
  // the back-forward cache nudge 'resume', as a wake or an unlock does on desktop.
  assert.deepEqual(calls, [
    ['focused', false],
    ['focused', true],
    ['nudge', 'focus'],
    ['focused', false],
    ['focused', true],
    ['nudge', 'focus'],
    ['nudge', 'resume'],
    ['focused', false],
    ['nudge', 'resume'],
    ['nudge', 'resume'],
    ['focused', false],
    ['nudge', 'resume']
  ]);

  // The cache is in memory: with messages still to send, leaving asks first.
  assert.equal(page.window.dispatch('beforeunload').defaultPrevented, false);
  engine.unsent = () => 2;
  const leaving = page.window.dispatch('beforeunload');
  assert.equal(leaving.defaultPrevented, true);
  assert.ok(leaving.returnValue);
});

test('the account status reaches the page as main.js broadcasts it, also for another tab\'s sign-in and sign-out', async (t) => {
  const local = memoryStorage();
  const page = openPage({ url: `https://rukoo.example/app/${inviteHash(W('A'), SECRET)}`, local });
  t.after(() => page.close());
  await page.ready();
  const accountEvents = () => page.eventsOf('account').map((e) => e.payload);
  // The stored session (none) at the start.
  await until(() => accountEvents().length, 2000, 'the first account event');
  assert.equal(accountEvents()[0].signedIn, false);
  assert.equal(accountEvents()[0].invitation, true, 'with the page invitation, as accountStatus has it');

  // Another tab signs in: Settings hears it without asking (web-shell.js account.onStatus).
  const { server } = await page.call('accountStatus');
  local.setItem('rukoo.web.session', JSON.stringify({ v: 1, server, email: 'tabs@example.test', token: `t.${'a'.repeat(43)}`, at: 1 }));
  page.window.dispatch('storage', { key: 'rukoo.web.session' });
  await until(() => accountEvents().some((s) => s.signedIn && s.email === 'tabs@example.test'), 5000, 'the sign-in of the other tab');
  // Both name the session (web only), so Settings can tell another session of the same account (rukoo-account.js).
  const signedIn = accountEvents().find((s) => s.signedIn);
  assert.match(signedIn.session, /^[A-Za-z0-9_-]{22}$/);
  assert.equal((await page.call('accountStatus')).session, signedIn.session);
  local.setItem('rukoo.web.session', JSON.stringify({ v: 1, server, email: 'tabs@example.test', token: `t.${'b'.repeat(43)}`, at: 2 }));
  page.window.dispatch('storage', { key: 'rukoo.web.session' });
  await until(() => accountEvents().some((s) => s.signedIn && s.session !== signedIn.session), 5000, 'another session of the same account');
  assert.equal(accountEvents().at(-1).email, 'tabs@example.test');
  // And signs out again.
  const before = accountEvents().length;
  local.removeItem('rukoo.web.session');
  page.window.dispatch('storage', { key: 'rukoo.web.session' });
  await until(() => accountEvents().length > before && accountEvents().at(-1).signedIn === false, 5000, 'the sign-out of the other tab');
  assert.equal(accountEvents().at(-1).email, null);
  assert.equal(accountEvents().at(-1).session, null);
  assert.equal((await page.call('accountStatus')).session, null);
  assert.deepEqual(page.logs.error, []);
});

test('team chat that cannot start in the page says so once the server says it has chat', async (t) => {
  const missingWasm = (target) => (target.pathname === '/app/web/sql-wasm.wasm' ? new Response('Not found', { status: 404 }) : undefined);
  // The server has chat and the WebAssembly is missing: engineFailed with the reason, for the shell's reload state.
  const page = openPage({ serve: (target) => missingWasm(target) || (target.pathname === '/v1/info' ? json(chatInfo()) : undefined) });
  t.after(() => page.close());
  await page.ready();
  assert.equal(page.test.engine, null);
  // One error, from the bridge: sql.js neither logs its own nor leaves an abort unhandled (src/web/engine/sqlite.js).
  assert.equal(page.logs.error.length, 1, page.logs.error.join('\n'));
  assert.match(page.logs.error[0], /\[web\] team chat could not start/);
  await until(async () => (await page.call('accountStatus')).info, 5000, 'the server info');
  const state = await page.chatState();
  assert.equal(state.engineFailed, true);
  assert.match(state.engineError, /sql-wasm\.wasm answered 404/);
  assert.equal(state.available, false);
  // The account still works without chat.
  assert.equal((await page.invoke('accountDetails')).code, 'signed_out');

  // The server's info comes after the engine failed: a state event says so then.
  let answer;
  const late = new Promise((resolve) => (answer = resolve));
  const slow = openPage({ serve: (target) => missingWasm(target) || (target.pathname === '/v1/info' ? late.then(() => json(chatInfo())) : undefined) });
  t.after(() => slow.close());
  await slow.ready();
  const first = await slow.chatState();
  assert.equal(first.engineFailed, false, 'not before the server said it has chat');
  assert.ok(first.engineError);
  answer();
  await until(() => slow.events.some((e) => e.type === 'chat' && e.payload.kind === 'state' && e.payload.state.engineFailed === true), 5000, 'a state with engineFailed');
  assert.equal((await slow.chatState()).engineFailed, true);

  // A server without chat: nothing failed that the page would have shown.
  const off = openPage({ serve: (target) => missingWasm(target) || (target.pathname === '/v1/info' ? json(chatInfo(false)) : undefined) });
  t.after(() => off.close());
  await off.ready();
  await until(async () => (await off.call('accountStatus')).info, 5000, 'the server info');
  assert.equal((await off.chatState()).engineFailed, false);

  // An error page in place of the file is refused before anything compiles it.
  const html = openPage({ serve: (target) => (target.pathname === '/app/web/sql-wasm.wasm' ? new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } }) : undefined) });
  t.after(() => html.close());
  await html.ready();
  assert.match((await html.chatState()).engineError, /sql-wasm\.wasm is not WebAssembly/);
  assert.equal(html.logs.error.length, 1);

  // A page whose engine started has neither field.
  const fine = openPage();
  t.after(() => fine.close());
  await fine.ready();
  const ok = await fine.chatState();
  assert.equal('engineFailed' in ok, false);
  assert.equal('engineError' in ok, false);
});

test('a Join dialog that closed drops the page invitation it was opened with, and only that one', async (t) => {
  const session = memoryStorage();
  const page = openPage({ url: `https://rukoo.example/app/${inviteHash(W('A'), SECRET)}`, session, meta: 'https://accounts.rukoo.example' });
  t.after(() => page.close());
  await page.ready();
  assert.equal((await page.chatState()).invitation, true);
  // Another invitation, or no link at all, leaves it.
  assert.equal(await page.call('webForgetInvitation', `https://rukoo.example/join#w=${W('A')}&i=${'t'.repeat(43)}`), false);
  assert.equal(await page.call('webForgetInvitation', 'not a link'), false);
  assert.equal(await page.call('webForgetInvitation'), false);
  assert.ok(session.map.has('rukoo.web.join'));
  // The link chatTakePendingJoin gives is rebuilt for the account server; it is the same invitation.
  assert.equal(await page.call('webForgetInvitation', `https://accounts.rukoo.example/join#w=${W('A')}&i=${SECRET}`), true);
  assert.equal(session.map.has('rukoo.web.join'), false);
  assert.equal((await page.chatState()).invitation, false);
  assert.equal((await page.call('accountStatus')).invitation, false);
  assert.equal(await page.call('webForgetInvitation', `https://accounts.rukoo.example/join#w=${W('A')}&i=${SECRET}`), false);
  // A reload of the tab has nothing to offer.
  const reloaded = openPage({ session, test: null });
  assert.equal((await reloaded.call('accountStatus')).invitation, false);
  reloaded.close();
});

test('a browser that cannot construct a Notification reads as without notifications', async (t) => {
  const open = { ws: W('A'), conversation: C('D'), seq: 1 };
  const ANDROID_CHROME = 'Mozilla/5.0 (Linux; Android 15; SM-F966B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36';
  const ANDROID_FIREFOX = 'Mozilla/5.0 (Android 15; Mobile; rv:140.0) Gecko/140.0 Firefox/140.0';

  // Chrome on Android: Notification is there, granted even, and constructs none. Nothing is tried.
  const android = openPage({ userAgent: ANDROID_CHROME, permission: 'granted', notificationThrows: true, focused: false });
  t.after(() => android.close());
  await android.ready();
  assert.deepEqual({ ...(await android.call('notificationState')) }, { supported: false, permission: 'unsupported' });
  android.test.engine.svc.show({ id: 'chat:a', title: 'A', body: 'a', open });
  assert.deepEqual(android.logs.warn, []);
  assert.equal(android.record.notifications.length, 0);

  // Firefox on Android isn't ruled out by its platform; a constructor that throws there is learnt as below.
  const firefox = openPage({ userAgent: ANDROID_FIREFOX, permission: 'granted', test: null });
  assert.deepEqual({ ...(await firefox.call('notificationState')) }, { supported: true, permission: 'granted' });
  firefox.close();

  // Any other browser that refuses the constructor: learnt at the first alert, and remembered for the next visit.
  const local = memoryStorage();
  const other = openPage({ local, permission: 'granted', notificationThrows: true, focused: false });
  t.after(() => other.close());
  await other.ready();
  assert.deepEqual({ ...(await other.call('notificationState')) }, { supported: true, permission: 'granted' });
  other.test.engine.svc.show({ id: 'chat:b', title: 'B', body: 'b', open });
  assert.ok(other.logs.warn.some((w) => w.includes('[web] chat notification not shown')));
  assert.deepEqual({ ...(await other.call('notificationState')) }, { supported: false, permission: 'unsupported' });
  const warned = other.logs.warn.length;
  other.test.engine.svc.show({ id: 'chat:c', title: 'C', body: 'c', open });
  assert.equal(other.logs.warn.length, warned, 'not tried again');
  const again = openPage({ local, permission: 'granted', test: null });
  assert.deepEqual({ ...(await again.call('notificationState')) }, { supported: false, permission: 'unsupported' });
  again.close();

  // No Notification at all.
  const none = openPage({ test: null });
  vm.runInContext('delete globalThis.Notification', none.context);
  assert.deepEqual({ ...(await none.call('notificationState')) }, { supported: false, permission: 'unsupported' });
  none.close();
});

// ---- against the real account server ----

test('the real server: a sign-up through the page invitation joins its workspace, and the link is used up', async (t) => {
  if (skipWithoutServer(t)) return;
  const olga = await real.seedAccount();
  const ws = await real.seedWorkspace(olga, { name: 'Acme', displayName: 'Olga Owner' });
  const invitation = await real.createInvite(olga, ws.id);
  const session = memoryStorage();
  const page = serverPage({ url: `${real.url}/app/${inviteHash(ws.id, invitation.secret)}`, session });
  t.after(() => page.close());
  const link = `${real.url}/join#w=${ws.id}&i=${invitation.secret}`;
  assert.equal(session.map.get('rukoo.web.join'), link);
  await page.ready();
  await until(async () => (await page.chatState()).available, 15000, 'team chat on this server');
  // The sign-up form learns from the status that the page holds an invitation, and asks for no code.
  assert.equal((await page.call('accountStatus')).invitation, true);
  // The signed-out chat pane learns it from the chat state.
  assert.equal((await page.chatState()).invitation, true);
  const info = await page.call('accountServerInfo');
  assert.equal(info.signups, 'invite');
  assert.equal(info.workspace.inviteSignups, true);

  // No invite code on an invite-only server: the page's invitation stands in for one.
  const email = `web-${Date.now()}@example.com`;
  const signedUp = await page.call('accountSignUp', { email, password: PASSWORD, invite: '' });
  // Argon2id ran in the worker beside the bridge.
  assert.ok(page.record.workers.length >= 1);
  for (const url of page.record.workers) assert.equal(url, `${real.url}/app/web/argon2-worker.js`);
  assert.match(signedUp.recoveryKey, /^[0-9A-Z]{4}(-[0-9A-Z]{4}){7}$/);
  assert.equal(signedUp.account.email, email);
  // The Join dialog's turn (chat.js maybeTakeJoin): pendingJoin, then the link once.
  await until(() => page.events.some((e) => e.type === 'chat' && e.payload.kind === 'state' && e.payload.state.pendingJoin), 5000, 'pendingJoin in a state event');
  assert.equal((await page.chatState()).pendingJoin, true);
  assert.deepEqual({ ...(await page.call('chatTakePendingJoin')) }, { link });
  assert.equal(await page.call('chatTakePendingJoin'), null);
  assert.equal(session.map.get('rukoo.web.join'), link, 'kept until the join');

  const preview = await page.call('chatPreviewInvite', link);
  assert.equal(preview.workspace.id, ws.id);
  const done = await page.call('chatJoin', { link, name: 'Web Person' });
  assert.equal(done.ws, ws.id);
  assert.equal(done.already, false);
  assert.equal(session.map.has('rukoo.web.join'), false, 'the invitation is used up');
  assert.equal((await page.call('accountStatus')).invitation, false);
  assert.equal((await page.chatState()).invitation, false);

  // The same link in another browser: the server made its one account with it already, so the sign-up is refused
  // with a code the form can tell (rukoo-account.js shows the invite code field then).
  const late = serverPage({ url: `${real.url}/app/${inviteHash(ws.id, invitation.secret)}` });
  t.after(() => late.close());
  await late.ready();
  assert.equal((await late.call('accountStatus')).invitation, true);
  assert.deepEqual(
    { ...(await late.invoke('accountSignUp', { email: `late-${Date.now()}@example.com`, password: PASSWORD, invite: '' })) },
    { ok: false, error: tr('en', 'account.errors.invite_required'), code: 'invite_required' }
  );
  assert.equal((await late.call('accountStatus')).signedIn, false);
  await until(async () => (await page.chatState()).workspaces.some((w) => w.id === ws.id), 15000, 'the workspace in chatState');

  // A team chat error passes its code and details; an account error comes worded in the page's language.
  const missing = await page.invoke('chatView', W('Z'));
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'not_found');
  assert.equal(missing.scope, 'workspace');
  assert.ok(missing.error && missing.error !== 'not_found');
  const bad = await page.invoke('chatView', 'nope');
  assert.equal(bad.code, 'invalid');
  assert.equal(typeof bad.field, 'string');
  assert.deepEqual(Object.keys(bad).sort(), ['code', 'error', 'field', 'ok']);

  // Olga writes in general; the page's socket brings it live.
  const view = await page.call('chatView', ws.id);
  assert.ok(view.rooms.some((r) => r.id === ws.general));
  await page.call('chatOpen', ws.id, ws.general);
  await real.post(olga, ws.id, ws.general, 'Welcome, web person');
  await until(
    () => page.events.some((e) => e.type === 'chat' && e.payload.kind === 'events' && e.payload.events.some((x) => x.text === 'Welcome, web person')),
    20000,
    "Olga's message"
  );
  const sent = await page.call('chatSend', ws.id, ws.general, { text: 'Hello from the browser' });
  await until(() => page.events.some((e) => e.type === 'chat' && e.payload.kind === 'sent' && e.payload.local === sent.local), 20000, 'the send');

  await page.call('accountSignOut');
  assert.equal((await page.chatState()).signedIn, false);
  assert.deepEqual(page.logs.error, []);
});

test('the real server: sign-in and recovery set the pending join too, a signed-in page takes one at once, sign-out clears it', async (t) => {
  if (skipWithoutServer(t)) return;
  const olga = await real.seedAccount();
  const first = await real.seedWorkspace(olga, { name: 'First', displayName: 'Olga Owner' });
  const second = await real.seedWorkspace(olga, { name: 'Second', displayName: 'Olga Owner' });
  const third = await real.seedWorkspace(olga, { name: 'Third', displayName: 'Olga Owner' });
  const email = `web-in-${Date.now()}@example.com`;
  const NEW_PASSWORD = 'another long enough password';

  // An account made without an invitation (the operator's code), so nothing waits to join.
  const maker = serverPage();
  t.after(() => maker.close());
  await maker.ready();
  const { recoveryKey } = await maker.call('accountSignUp', { email, password: PASSWORD, invite: real.inviteCode });
  assert.equal((await maker.chatState()).pendingJoin, false);
  // A wrong password is an account error in the page's language.
  await maker.call('accountSignOut');
  assert.deepEqual({ ...(await maker.invoke('accountSignIn', { email, password: 'not the password at all' })) }, { ok: false, error: tr('en', 'account.errors.unauthorized'), code: 'unauthorized' });
  await maker.call('updateSettings', { language: 'nl' });
  assert.equal((await maker.invoke('accountSignIn', { email, password: 'still not the password' })).error, tr('nl', 'account.errors.unauthorized'));

  // Sign-in on a page opened with an invitation.
  const one = await real.createInvite(olga, first.id);
  const signInSession = memoryStorage();
  const signIn = serverPage({ url: `${real.url}/app/${inviteHash(first.id, one.secret)}`, session: signInSession });
  t.after(() => signIn.close());
  await signIn.ready();
  await signIn.call('accountSignIn', { email, password: PASSWORD });
  await until(async () => (await signIn.chatState()).pendingJoin, 5000, 'pendingJoin after the sign-in');
  const taken = await signIn.call('chatTakePendingJoin');
  assert.equal(taken.link, `${real.url}/join#w=${first.id}&i=${one.secret}`);
  assert.equal((await signIn.call('chatJoin', { link: taken.link, name: 'Web' })).ws, first.id);
  assert.equal(signInSession.map.has('rukoo.web.join'), false);
  await signIn.call('accountSignOut');

  // Recovery on a page opened with another invitation; it stays signed in.
  const two = await real.createInvite(olga, second.id);
  const local = memoryStorage();
  const session = memoryStorage();
  const recover = serverPage({ url: `${real.url}/app/${inviteHash(second.id, two.secret)}`, local, session });
  t.after(() => recover.close());
  await recover.ready();
  await recover.call('accountRecover', { email, recoveryKey, password: NEW_PASSWORD });
  await until(async () => (await recover.chatState()).pendingJoin, 5000, 'pendingJoin after the recovery');
  recover.close();

  // A reload of that tab: signed in from storage, the invitation still kept, so the Join dialog's turn comes at once.
  const reloaded = serverPage({ local, session });
  t.after(() => reloaded.close());
  await reloaded.ready();
  assert.equal((await reloaded.call('accountStatus')).signedIn, true);
  assert.equal((await reloaded.chatState()).pendingJoin, true, 'pending as soon as the engine runs');
  // The cache opens once /v1/info says team chat is on; until then taking the link fails as signed_out, and the
  // renderer tries again at the next state (chat.js maybeTakeJoin).
  await until(async () => {
    const s = await reloaded.chatState();
    return s.available && s.storage && s.pendingJoin;
  }, 5000, 'the cache open with the join pending');
  const again = await until(async () => {
    const res = await reloaded.invoke('chatTakePendingJoin');
    return res.ok && res.result;
  }, 5000, 'the link from the open cache');
  assert.equal(again.link, `${real.url}/join#w=${second.id}&i=${two.secret}`);
  // Taken, but the dialog still open: a reload now offers it again.
  assert.equal(session.map.get('rukoo.web.join'), again.link);
  // The dialog closed without a join (chat.js maybeTakeJoin): the page drops it, so the next reload doesn't offer it.
  assert.equal(await reloaded.call('webForgetInvitation', again.link), true);
  assert.equal(session.map.has('rukoo.web.join'), false);
  // The reload (a page on the same storage; this one stays open for the sign-out below).
  const after = serverPage({ local, session });
  t.after(() => after.close());
  await after.ready();
  await until(async () => {
    const s = await after.chatState();
    return s.available && s.storage;
  }, 5000, 'the cache open after the reload');
  assert.equal((await after.chatState()).pendingJoin, false, 'no Join dialog after a dismissed one');
  assert.equal(await after.call('chatTakePendingJoin'), null);
  after.close();
  // Signing out drops an invitation the tab still holds.
  session.setItem('rukoo.web.join', again.link);
  await reloaded.call('accountSignOut');
  assert.equal(session.map.has('rukoo.web.join'), false, 'sign-out clears the invitation');
  assert.equal((await reloaded.chatState()).pendingJoin, false);
  assert.equal((await reloaded.chatState()).invitation, false);
  // The pane hears it at once: the last state event says the invitation is gone.
  await until(() => {
    const states = reloaded.events.filter((e) => e.type === 'chat' && e.payload.kind === 'state');
    return states.length && states[states.length - 1].payload.state.invitation === false;
  }, 5000, 'a state event without the invitation');

  // Another tab signs in: this one follows through the storage event, and its own invitation waits to join.
  const three = await real.createInvite(olga, third.id);
  const shared = memoryStorage();
  const watching = serverPage({ url: `${real.url}/app/${inviteHash(third.id, three.secret)}`, local: shared });
  t.after(() => watching.close());
  await watching.ready();
  const other = serverPage({ local: shared });
  t.after(() => other.close());
  await other.ready();
  await other.call('accountSignIn', { email, password: NEW_PASSWORD });
  assert.equal((await watching.call('accountStatus')).signedIn, false, 'not before the event');
  watching.window.dispatch('storage', { key: 'rukoo.web.session' });
  await until(async () => (await watching.call('accountStatus')).signedIn, 5000, 'the other tab sign-in');
  await until(async () => (await watching.chatState()).pendingJoin, 5000, 'pendingJoin after the other tab signed in');
  assert.equal((await watching.call('chatTakePendingJoin')).link, `${real.url}/join#w=${third.id}&i=${three.secret}`);
  for (const p of [maker, signIn, reloaded, after, watching, other]) assert.deepEqual(p.logs.error, []);
});

test('the real server: a sign-out in one tab counts and then reports the unsent messages of another', async (t) => {
  if (skipWithoutServer(t)) return;
  const olga = await real.seedAccount();
  const ws = await real.seedWorkspace(olga, { name: 'Tabs', displayName: 'Olga Owner' });
  const invitation = await real.createInvite(olga, ws.id);
  const local = memoryStorage();
  // Tab B signs up and joins; tab A opens later in the same browser, signed in from storage.
  const b = serverPage({ local });
  t.after(() => b.close());
  await b.ready();
  await b.call('accountSignUp', { email: `tabs-${Date.now()}@example.com`, password: PASSWORD, invite: real.inviteCode });
  await until(async () => (await b.chatState()).available, 15000, 'team chat in tab B');
  await b.call('chatJoin', { link: invitation.link, name: 'Tab B' });
  const a = serverPage({ local });
  t.after(() => a.close());
  await a.ready();
  assert.equal((await a.call('accountStatus')).signedIn, true);
  await until(async () => (await a.chatState()).available, 15000, 'team chat in tab A');
  assert.equal((await a.chatState()).unsentElsewhere, 0);

  // B loses its network with a message in its outbox: it says so for the other tabs.
  b.setNetwork(false);
  await b.call('chatSend', ws.id, ws.general, { text: 'Stuck in tab B' });
  await until(async () => (await b.chatState()).unsent === 1, 5000, 'the unsent message in tab B');
  await until(() => unsentCounts(local).length === 1, 5000, "tab B's count in storage");
  assert.deepEqual(unsentCounts(local), [1]);
  const state = await a.chatState();
  assert.equal(state.unsent, 0, "A's own outbox is empty");
  assert.equal(state.unsentElsewhere, 1, "A's sign-out confirmation counts B's message (rukoo-account.js)");
  assert.equal((await b.chatState()).unsentElsewhere, 0, 'a tab does not count itself twice');
  // B goes into the back-forward cache and comes back: its count leaves storage and returns.
  b.window.dispatch('pagehide', { persisted: true });
  assert.deepEqual(unsentCounts(local), []);
  assert.equal((await a.chatState()).unsentElsewhere, 0);
  b.window.dispatch('pageshow', { persisted: true });
  assert.deepEqual(unsentCounts(local), [1]);

  // A signs out. B follows through the storage event and says what that cost it, once.
  await a.call('accountSignOut');
  assert.deepEqual(unsentCounts(local), [], 'the counts of the ended session are gone');
  b.window.dispatch('storage', { key: 'rukoo.web.session' });
  const lost = await until(
    () => b.events.find((e) => e.type === 'chat' && e.payload.kind === 'state' && !e.payload.state.signedIn && e.payload.state.lostUnsentElsewhere),
    5000,
    'the lost messages in a state event of tab B'
  );
  assert.equal(lost.payload.state.lostUnsent, 1);
  assert.equal(lost.payload.state.lostUnsentElsewhere, 1);
  // A read before Chat's notice, such as Settings counting for its sign-out warning, leaves the count to the notice:
  // the next read and the next state event still carry it.
  const read = await b.chatState();
  assert.equal(read.signedIn, false);
  assert.equal(read.unsent, 0);
  assert.equal(read.lostUnsent, 1);
  assert.equal(read.lostUnsentElsewhere, 1);
  const again = await b.chatState();
  assert.equal(again.lostUnsent, 1, 'a read does not take it');
  assert.equal(again.lostUnsentElsewhere, 1);
  const before = b.events.length;
  await b.call('updateSettings', { chatNotifications: false });
  const next = await until(() => b.events.slice(before).find((e) => e.type === 'chat' && e.payload.kind === 'state'), 5000, 'a state event after the reads');
  assert.equal(next.payload.state.lostUnsent, 1, 'the state event after a read still says it');
  assert.equal(next.payload.state.lostUnsentElsewhere, 1);
  // Chat showed its notice (chat.js noticeLostUnsent): only then is it gone.
  assert.equal(await b.call('webLostUnsentShown', 1), 0);
  const later = await b.chatState();
  assert.equal(later.lostUnsent, 0);
  assert.equal('lostUnsentElsewhere' in later, false);
  assert.deepEqual(unsentCounts(local), []);
  assert.equal(b.eventsOf('account').at(-1).payload.signedIn, false, 'Settings in B hears the sign-out');
  // A's own sign-out warned A's user first, so A reports nothing lost.
  assert.equal((await a.chatState()).lostUnsent, 0);
  assert.deepEqual(a.logs.error, []);
});

test("the real server: a 401 that ends a tab's session reports its unsent messages, and a dialog's account must still be the one signed in", async (t) => {
  if (skipWithoutServer(t)) return;
  const olga = await real.seedAccount();
  const ws = await real.seedWorkspace(olga, { name: 'Race', displayName: 'Olga Owner' });
  const invitation = await real.createInvite(olga, ws.id);
  const local = memoryStorage();
  const first = `race-${Date.now()}@example.com`;
  const b = serverPage({ local });
  t.after(() => b.close());
  await b.ready();
  await b.call('accountSignUp', { email: first, password: PASSWORD, invite: real.inviteCode });
  await until(async () => (await b.chatState()).available, 15000, 'team chat in tab B');
  await b.call('chatJoin', { link: invitation.link, name: 'Tab B' });
  const a = serverPage({ local });
  t.after(() => a.close());
  await a.ready();
  await until(async () => (await a.chatState()).available, 15000, 'team chat in tab A');

  // B holds a message it can't send. A signs out, which ends the token at the server, and B hears about it from the
  // server's 401 before any storage event: B still says what it lost.
  b.setNetwork(false);
  await b.call('chatSend', ws.id, ws.general, { text: 'Stuck before the 401' });
  await until(async () => (await b.chatState()).unsent === 1, 5000, 'the unsent message in tab B');
  await a.call('accountSignOut');
  b.setNetwork(true);
  assert.equal((await b.invoke('accountDetails')).code, 'signed_out', 'the server ended the session');
  const lost = await until(async () => {
    const state = await b.chatState();
    return state.lostUnsentElsewhere ? state : null;
  }, 5000, 'the lost message reported in tab B');
  assert.equal(lost.signedIn, false);
  assert.equal(lost.lostUnsent, 1);
  assert.equal(await b.call('webLostUnsentShown', 1), 0, "Chat's notice showed it");

  // A signs in to another account while B's Sign out and Delete account dialogs still name the first one: B stops.
  const second = `race-other-${Date.now()}@example.com`;
  await a.call('accountSignUp', { email: second, password: PASSWORD, invite: real.inviteCode });
  b.window.dispatch('storage', { key: 'rukoo.web.session' });
  await until(async () => (await b.call('accountStatus')).email === second, 5000, 'tab B following the new sign-in');
  const del = await b.invoke('accountDelete', PASSWORD, { email: first });
  assert.equal(del.ok, false);
  assert.equal(del.code, 'account_changed');
  assert.equal(del.error, tr('en', 'account.errors.account_changed'));
  const out = await b.invoke('accountSignOut', { email: first });
  assert.equal(out.code, 'account_changed');
  assert.equal((await b.call('accountStatus')).signedIn, true, 'nothing was signed out');
  assert.equal((await a.call('accountStatus')).email, second, 'nor deleted');
  // Named right, the action goes ahead; this tab's own sign-out isn't counted as lost messages.
  assert.equal((await b.invoke('accountSignOut', { email: second })).ok, true);
  assert.equal((await b.chatState()).lostUnsent, 0);
});

// What only the deletion or the sign-out of this tab took counts nothing: its confirmation counted it. One that another
// ending of the session beat to it (here a 401 after another tab's sign-out) still reports what that ending took.
test("the real server: a deletion that a 401 beat reports the lost messages, and this tab's own sign-out or deletion doesn't", async (t) => {
  if (skipWithoutServer(t)) return;
  const olga = await real.seedAccount();
  const ws = await real.seedWorkspace(olga, { name: 'Beaten', displayName: 'Olga Owner' });
  const invitation = await real.createInvite(olga, ws.id);
  const local = memoryStorage();
  const email = `beaten-${Date.now()}@example.com`;
  // hold: B's prelogin (a deletion's first request) waits for it, so the deletion is still running when something
  // else ends the session. blockSends: B's messages don't get out, as on a network that went away.
  let hold = null;
  let held = null;
  let blockSends = false;
  const b = serverPage({
    local,
    serve: async (target, init) => {
      const post = String((init && init.method) || 'GET').toUpperCase() === 'POST';
      if (blockSends && post && /\/conversations\/[^/]+\/messages$/.test(target.pathname)) throw new TypeError('Failed to fetch');
      if (!hold || target.pathname !== '/v1/prelogin') return undefined;
      held();
      await hold;
      return fetch(target, init);
    }
  });
  t.after(() => b.close());
  await b.ready();
  await b.call('accountSignUp', { email, password: PASSWORD, invite: real.inviteCode });
  await until(async () => (await b.chatState()).available, 15000, 'team chat in tab B');
  await b.call('chatJoin', { link: invitation.link, name: 'Tab B' });
  const a = serverPage({ local });
  t.after(() => a.close());
  await a.ready();
  await until(async () => (await a.chatState()).available, 15000, 'team chat in tab A');

  // B holds a message it can't send and starts deleting the account. While the deletion waits, A signs out, and a 401
  // ends B's session before the deletion gets to it.
  b.setNetwork(false);
  await b.call('chatSend', ws.id, ws.general, { text: 'Stuck behind the deletion' });
  await until(async () => (await b.chatState()).unsent === 1, 5000, 'the unsent message in tab B');
  let release;
  hold = new Promise((resolve) => (release = resolve));
  const atPrelogin = new Promise((resolve) => (held = resolve));
  const deletion = b.invoke('accountDelete', PASSWORD, { email });
  await atPrelogin;
  await a.call('accountSignOut');
  b.setNetwork(true);
  const since = b.events.length;
  assert.equal((await b.invoke('accountDetails')).code, 'signed_out', "the 401 ended B's session");
  release();
  const del = await deletion;
  hold = null;
  assert.equal(del.ok, false);
  assert.equal(del.code, 'signed_out', 'the deletion found the session ended already');
  const state = await b.chatState();
  assert.equal(state.signedIn, false);
  assert.equal(state.unsent, 0);
  assert.equal(state.lostUnsent, 1, 'the 401 took the message, not the deletion it was confirmed for');
  assert.equal(state.lostUnsentElsewhere, 1);
  // A signed-out state event carries it once the deletion failed, so Chat's toast shows.
  const event = await until(
    () => b.events.slice(since).find((e) => e.type === 'chat' && e.payload.kind === 'state' && !e.payload.state.signedIn && e.payload.state.lostUnsentElsewhere),
    5000,
    'the signed-out state event with the lost message'
  );
  assert.equal(event.payload.state.lostUnsentElsewhere, 1);
  assert.equal(event.payload.state.lostUnsent, 1);
  assert.equal(await b.call('webLostUnsentShown', 1), 0);

  // B's own sign-out ends the session it was confirmed for: the message it held counts as warned about.
  await b.call('accountSignIn', { email, password: PASSWORD });
  await until(async () => {
    const view = await b.invoke('chatView', ws.id);
    return view.ok && view.result.rooms.some((r) => r.id === ws.general);
  }, 15000, 'general after the sign-in');
  blockSends = true;
  await b.call('chatSend', ws.id, ws.general, { text: 'Stuck before the sign-out' });
  await until(async () => (await b.chatState()).unsent === 1, 5000, 'the unsent message before the sign-out');
  const out = b.events.length;
  assert.equal((await b.invoke('accountSignOut', { email })).ok, true);
  const signedOut = await b.chatState();
  assert.equal(signedOut.signedIn, false);
  assert.equal(signedOut.lostUnsent, 0);
  assert.equal('lostUnsentElsewhere' in signedOut, false);
  await until(() => b.events.slice(out).some((e) => e.type === 'chat' && e.payload.kind === 'state' && !e.payload.state.signedIn), 5000, 'the state event of the sign-out');
  assert.ok(b.events.slice(out).every((e) => e.type !== 'chat' || e.payload.kind !== 'state' || !e.payload.state.lostUnsentElsewhere));

  // And so does its own deletion.
  await b.call('accountSignIn', { email, password: PASSWORD });
  await until(async () => {
    const view = await b.invoke('chatView', ws.id);
    return view.ok && view.result.rooms.some((r) => r.id === ws.general);
  }, 15000, 'general after signing in again');
  await b.call('chatSend', ws.id, ws.general, { text: 'Stuck before the deletion' });
  await until(async () => (await b.chatState()).unsent === 1, 5000, 'the unsent message before the deletion');
  assert.equal((await b.invoke('accountDelete', PASSWORD, { email })).ok, true);
  const deleted = await b.chatState();
  assert.equal(deleted.signedIn, false);
  assert.equal(deleted.lostUnsent, 0);
  assert.equal('lostUnsentElsewhere' in deleted, false);
  assert.deepEqual(b.logs.error, []);
});

// A tab on the real server, signed up and in a workspace of Olga's with general open. ctl holds what its requests meet:
// blockSends (its messages fail as offline), before (one request waits before it reaches the server) and after (one
// answer waits after the server gave it), each a hold().
async function joinedTab(t, { local = memoryStorage(), ctl, prefix }) {
  const olga = await real.seedAccount();
  const ws = await real.seedWorkspace(olga, { name: prefix, displayName: 'Olga Owner' });
  const invitation = await real.createInvite(olga, ws.id);
  const email = `${prefix.toLowerCase()}-${Date.now()}@example.com`;
  const method = (init) => String((init && init.method) || 'GET').toUpperCase();
  const matches = (h, target, init) => h && h.path === target.pathname && h.method === method(init);
  const p = serverPage({
    local,
    serve: async (target, init) => {
      if (ctl.blockSends && method(init) === 'POST' && /\/conversations\/[^/]+\/messages$/.test(target.pathname)) throw new TypeError('Failed to fetch');
      if (matches(ctl.before, target, init)) {
        const h = ctl.before;
        ctl.before = null;
        h.reached();
        await h.gate;
        return fetch(target, init);
      }
      if (matches(ctl.after, target, init)) {
        const h = ctl.after;
        ctl.after = null;
        const res = await fetch(target, init);
        h.reached(res.status);
        await h.gate;
        return res;
      }
      return undefined;
    }
  });
  t.after(() => p.close());
  await p.ready();
  await p.call('accountSignUp', { email, password: PASSWORD, invite: real.inviteCode });
  await until(async () => (await p.chatState()).available, 15000, 'team chat');
  await p.call('chatJoin', { link: invitation.link, name: 'Tab' });
  await inGeneral(p, ws);
  return { p, ws, email };
}
const inGeneral = (p, ws) =>
  until(
    async () => {
      const view = await p.invoke('chatView', ws.id);
      return view.ok && view.result.rooms.some((r) => r.id === ws.general);
    },
    15000,
    'general'
  );
// A request joinedTab holds: at resolves when it got there (with the server's status, for an answer held after),
// release lets it go on.
function hold(path, method) {
  const h = { path, method };
  h.gate = new Promise((resolve) => (h.release = resolve));
  h.at = new Promise((resolve) => (h.reached = resolve));
  return h;
}
const lostEvents = (p, from) => p.events.slice(from).filter((e) => e.type === 'chat' && e.payload.kind === 'state' && e.payload.state.lostUnsentElsewhere);

// The server takes this tab's sign-out or deletion, and before its answer gets back the engine's next request meets the
// 401 that the ended token gets: that is still this tab's own ending, which its confirmation counted. A message sent
// while a sign-out runs was in no confirmation, so that one is reported.
test("the real server: this tab's own sign-out or deletion that a 401 it caused came before counts nothing, and a message sent meanwhile is reported", async (t) => {
  if (skipWithoutServer(t)) return;
  const ctl = {};
  const { p, ws, email } = await joinedTab(t, { ctl, prefix: 'Own' });
  const since = p.events.length;

  // Sign out: the server has ended the session and its answer is on the way when the network comes back (or a socket
  // frame comes in) and the outbox tries again with the ended token.
  ctl.blockSends = true;
  await p.call('chatSend', ws.id, ws.general, { text: 'Counted by the sign-out' });
  await until(async () => (await p.chatState()).unsent === 1, 5000, 'the unsent message');
  const logout = hold('/v1/logout', 'POST');
  ctl.after = logout;
  const out = p.invoke('accountSignOut', { email });
  assert.equal(await logout.at, 204);
  ctl.blockSends = false;
  p.window.dispatch('online');
  await until(async () => !(await p.call('accountStatus')).signedIn, 10000, 'the 401 that ended the session');
  logout.release();
  const signedOut = await out;
  assert.equal(signedOut.ok, true);
  assert.equal(signedOut.result.signedIn, false);
  let state = await p.chatState();
  assert.equal(state.lostUnsent, 0, 'the sign-out was confirmed with it');
  assert.equal('lostUnsentElsewhere' in state, false);
  // Nor does the account say the session ended elsewhere (a password changed, this device removed).
  assert.equal((await p.call('accountStatus')).error, null);
  assert.deepEqual(lostEvents(p, since), []);

  // Signs out again with a slow logout, and sends one more meanwhile: that one goes without a warning, so it is reported.
  await p.call('accountSignIn', { email, password: PASSWORD });
  await inGeneral(p, ws);
  ctl.blockSends = true;
  await p.call('chatSend', ws.id, ws.general, { text: 'Counted by the second sign-out' });
  await until(async () => (await p.chatState()).unsent === 1, 5000, 'the unsent message before the second sign-out');
  const slow = hold('/v1/logout', 'POST');
  ctl.before = slow;
  const from = p.events.length;
  const again = p.invoke('accountSignOut', { email });
  await slow.at;
  await p.call('chatSend', ws.id, ws.general, { text: 'Sent while the sign-out ran' });
  await until(async () => (await p.chatState()).unsent === 2, 5000, 'two unsent messages');
  slow.release();
  assert.equal((await again).ok, true);
  state = await p.chatState();
  assert.equal(state.signedIn, false);
  assert.equal(state.lostUnsent, 1, 'only the message sent after the sign-out started');
  assert.equal(state.lostUnsentElsewhere, 1);
  const event = await until(() => lostEvents(p, from)[0], 5000, 'a state event with the lost message');
  assert.equal(event.payload.state.lostUnsentElsewhere, 1);
  assert.equal(event.payload.state.signedIn, false);
  assert.equal(await p.call('webLostUnsentShown', 1), 0);

  // Deletes the account in the same race: nothing reported.
  await p.call('accountSignIn', { email, password: PASSWORD });
  await inGeneral(p, ws);
  await p.call('chatSend', ws.id, ws.general, { text: 'Counted by the deletion' });
  await until(async () => (await p.chatState()).unsent === 1, 5000, 'the unsent message before the deletion');
  const deletion = hold('/v1/account', 'DELETE');
  ctl.after = deletion;
  const last = p.events.length;
  const deleting = p.invoke('accountDelete', PASSWORD, { email });
  assert.equal(await deletion.at, 204);
  ctl.blockSends = false;
  p.window.dispatch('online');
  await until(async () => !(await p.call('accountStatus')).signedIn, 10000, 'the 401 after the deletion');
  deletion.release();
  assert.equal((await deleting).ok, true);
  state = await p.chatState();
  assert.equal(state.lostUnsent, 0, 'the deletion was confirmed with it');
  assert.equal('lostUnsentElsewhere' in state, false);
  assert.equal((await p.call('accountStatus')).error, null);
  assert.deepEqual(lostEvents(p, last), []);
  assert.deepEqual(p.logs.error, []);
});

// This tab's sign-out is on its way while another tab signs out and in to another account: the browser isn't signed
// out, so the call says the account changed instead of succeeding, and what the first session's end took is reported.
test("the real server: a sign-out that another tab's sign-in to another account overtook says the account changed", async (t) => {
  if (skipWithoutServer(t)) return;
  const ctl = {};
  const local = memoryStorage();
  const { p: a, ws, email } = await joinedTab(t, { local, ctl, prefix: 'Overtaken' });
  ctl.blockSends = true;
  await a.call('chatSend', ws.id, ws.general, { text: 'Held in tab A' });
  await until(async () => (await a.chatState()).unsent === 1, 5000, 'the unsent message in tab A');
  const b = serverPage({ local });
  t.after(() => b.close());
  await b.ready();
  assert.equal((await b.call('accountStatus')).email, email);

  const logout = hold('/v1/logout', 'POST');
  ctl.before = logout;
  const out = a.invoke('accountSignOut', { email });
  await logout.at;
  await b.call('accountSignOut');
  const other = `overtaking-${Date.now()}@example.com`;
  await b.call('accountSignUp', { email: other, password: PASSWORD, invite: real.inviteCode });
  const since = a.events.length;
  a.window.dispatch('storage', { key: 'rukoo.web.session' });
  await until(async () => (await a.call('accountStatus')).email === other, 5000, 'tab A following the sign-in');
  logout.release();
  const res = await out;
  assert.equal(res.ok, false);
  assert.equal(res.code, 'account_changed');
  assert.equal(res.error, tr('en', 'account.errors.account_changed'));
  const state = await a.chatState();
  assert.equal(state.signedIn, true);
  assert.equal(state.lostUnsent, 1, "tab B's sign-out ended the session before this one did");
  assert.equal(state.lostUnsentElsewhere, 1);
  const event = await until(() => lostEvents(a, since)[0], 5000, 'a state event with the lost message');
  assert.equal(event.payload.state.lostUnsentElsewhere, 1);
  assert.equal((await b.call('accountStatus')).email, other, 'the other account stays signed in');
  assert.deepEqual(a.logs.error, []);
});
