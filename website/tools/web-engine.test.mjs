// The chat engine of the browser build (src/web/engine): src/main/workspaces bundled for the browser with the options
// of src/web/build-options.mjs. The bundle is checked for what Node would have left in it, then run the way the page
// runs it: in a context with the page's globals and nothing of Node's (no require, process or Buffer), after the
// i18n scripts, on sql.js. Once against a fake account, and once against the real account server
// (test/fixtures/real-server.js), where the wake socket opens with its ticket as a subprotocol.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { builtinModules, createRequire } from 'node:module';
import * as esbuild from 'esbuild';
import { webEngineOptions, webBuildOptions, webAssets, sqlWasm, SQL_WASM_FILE } from '../../src/web/build-options.mjs';

const root = path.resolve(import.meta.dirname, '..', '..');
const websiteDir = path.join(root, 'website');
const require = createRequire(import.meta.url);
const engineEntry = path.join(root, 'src', 'web', 'engine', 'index.js');
const wasmBinary = fs.readFileSync(sqlWasm({ websiteDir }).from);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'rukoo-web-engine-'));
test.after(() => fs.rmSync(temp, { recursive: true, force: true }));

const build = (options) => esbuild.build({ ...webEngineOptions({ root, websiteDir }), write: false, logLevel: 'silent', ...options });
const rel = (file) => path.relative(root, path.resolve(file)).replaceAll('\\', '/');

// The engine as the page gets it: one IIFE, exposed here as RukooWebEngine so the test can call it.
const engineBuild = await build({ entryPoints: [engineEntry], format: 'iife', globalName: 'RukooWebEngine', metafile: true });
const engineText = engineBuild.outputFiles[0].text;

async function until(check, ms = 15000, what = 'the condition') {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`Timed out after ${ms} ms waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test('the engine bundles src/main/workspaces for the browser with nothing of Node left', () => {
  const inputs = Object.keys(engineBuild.metafile.inputs).map(rel);
  // One source of truth: every module of the desktop's chat engine is in the bundle, unchanged.
  for (const file of fs.readdirSync(path.join(root, 'src', 'main', 'workspaces'))) {
    assert.ok(inputs.includes(`src/main/workspaces/${file}`), `${file} is bundled`);
  }
  for (const file of ['sqlite.js', 'websocket.js', 'shims/fs.js', 'shims/path.js', 'shims/events.js', 'shims/crypto.js', 'shims/buffer.js', 'shims/i18n.js', 'shims/account-client.js']) {
    assert.ok(inputs.includes(`src/web/engine/${file}`), `${file} is bundled`);
  }
  // The catalogs come from the page's scripts, and Node's HTTP client never comes along.
  for (const file of ['src/i18n/index.js', 'src/i18n/en.js', 'src/i18n/nl.js', 'src/main/account/client.js']) assert.ok(!inputs.includes(file), `${file} is not bundled`);
  assert.ok(!engineText.includes('errors.invite.unreadable'), 'no catalog text in the bundle');

  const names = builtinModules.map((m) => m.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')).join('|');
  const nodeRequire = new RegExp(String.raw`\brequire\(\s*["'](?:node:)?(?:${names}|sqlite)["']\s*\)`);
  assert.equal(nodeRequire.exec(engineText), null, 'no require of a Node built-in');
  assert.ok(!engineText.includes('Dynamic require of'), "no require esbuild couldn't bundle");
  assert.ok(!/\bprocess\.env\b/.test(engineText), 'process.env.SEM_TRACE is defined away');
});

test('the build options name the two bundles and the files to copy', () => {
  const outdir = path.join(temp, 'app');
  const [bridge, worker] = webBuildOptions({ root, websiteDir, outdir, minify: true });
  assert.deepEqual(bridge.entryPoints, [path.join(root, 'src', 'web', 'bridge.js')]);
  assert.equal(bridge.outfile, path.join(outdir, 'web', 'bridge.js'));
  assert.equal(bridge.format, 'iife');
  assert.equal(bridge.platform, 'browser');
  assert.equal(bridge.minify, true);
  assert.deepEqual(bridge.nodePaths, [path.join(websiteDir, 'node_modules')]);
  assert.deepEqual(bridge.plugins.map((p) => p.name), ['rukoo-web-engine', 'rukoo-website-modules']);
  assert.deepEqual(worker.plugins.map((p) => p.name), ['rukoo-website-modules']);
  assert.deepEqual(worker.entryPoints, [path.join(root, 'src', 'web', 'account', 'argon2-worker.js')]);
  assert.equal(worker.outfile, path.join(outdir, 'web', 'argon2-worker.js'));
  assert.equal(worker.format, 'iife');
  const assets = webAssets({ websiteDir });
  assert.deepEqual(assets.map((a) => a.to), [`web/${SQL_WASM_FILE}`, 'web/sql-wasm.LICENSE.txt', 'web/hash-wasm.LICENSE.txt']);
  for (const a of assets) assert.ok(fs.existsSync(a.from), `${a.from} exists`);
  // The wasm that matches the JavaScript esbuild bundles: sql.js's browser entry.
  assert.match(assets[0].from.replaceAll('\\', '/'), /sql\.js\/dist\/sql-wasm-browser\.wasm$/);
  assert.ok(Object.keys(engineBuild.metafile.inputs).map(rel).includes('website/node_modules/sql.js/dist/sql-wasm-browser.js'));
});

test('a bundle that imports a translation catalog fails to build', async () => {
  await assert.rejects(
    build({ stdin: { contents: "require('./src/i18n/en.js');", resolveDir: root, sourcefile: 'catalog.js' }, format: 'iife' }),
    /translation catalog/
  );
});

test('wire.js and notify.js give the desktop answers through the Buffer and crypto shims', async () => {
  const result = await build({
    stdin: {
      contents:
        "module.exports = { wire: require('./src/main/workspaces/wire.js'), notify: require('./src/main/workspaces/notify.js'), websocket: require('./src/web/engine/websocket.js') };",
      resolveDir: root,
      sourcefile: 'web-wire-entry.js'
    },
    format: 'cjs'
  });
  const file = path.join(temp, 'web-wire.cjs');
  fs.writeFileSync(file, result.outputFiles[0].text);
  globalThis.RukooI18n = require('../../src/i18n/index.js');
  const web = require(file);
  const desktop = { wire: require('../../src/main/workspaces/wire.js'), notify: require('../../src/main/workspaces/notify.js') };
  const vectors = require('../../test/fixtures/chat-vectors.json');

  for (const v of [...vectors.mentions, ...vectors.badMentions]) {
    assert.equal(web.wire.mentionRule(v.text, v.bytes), desktop.wire.mentionRule(v.text, v.bytes), v.name);
    assert.equal(web.notify.alertText(v.text, v.bytes), desktop.notify.alertText(v.text, v.bytes), v.name);
  }
  for (const v of vectors.uuidv7) {
    const random = Uint8Array.from(v.random.match(/../g).map((h) => parseInt(h, 16)));
    assert.equal(web.wire.uuidv7(v.ms, random), v.id, v.name);
  }
  const ids = new Set(Array.from({ length: 50 }, () => web.wire.localId()));
  assert.equal(ids.size, 50);
  for (const id of ids) assert.match(id, /^[A-Za-z0-9_-]{22}$/);
  assert.match(web.wire.uuidv7(Date.now()), desktop.wire.patterns.UUID_V7);

  // The socket's init, as socket.js writes it, becomes the protocol list a browser can send.
  const { protocolsFor, webSocketAdapter } = web.websocket;
  assert.deepEqual(protocolsFor({ protocols: ['rukoo.workspace.v1'], headers: { authorization: 'Ticket abc.def' } }), ['rukoo.workspace.v1', 'rukoo.ticket.abc.def']);
  assert.deepEqual(protocolsFor(['a', 'b']), ['a', 'b']);
  assert.throws(() => protocolsFor({ headers: { cookie: 'x' } }), /can't send the cookie header/);
  assert.throws(() => protocolsFor({ headers: { authorization: 'Bearer token' } }), /only a socket ticket/);
  assert.equal(webSocketAdapter(null), null);
  class Native {
    constructor(url, protocols) {
      Object.assign(this, { url, protocols });
    }
  }
  const Adapter = webSocketAdapter(Native);
  const made = new Adapter('wss://chat.example.test/v1/workspaces/w/socket', { protocols: ['rukoo.workspace.v1'], headers: { authorization: 'Ticket t.u' } });
  assert.ok(made instanceof Native);
  assert.deepEqual(made.protocols, ['rukoo.workspace.v1', 'rukoo.ticket.t.u']);
});

// A context with the globals a page has and none of Node's, with the i18n scripts and the engine loaded as the
// page's <script> tags load them.
function pageContext({ WebSocket } = {}) {
  const context = vm.createContext({
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    TextEncoder,
    TextDecoder,
    URL,
    URLSearchParams,
    AbortController,
    AbortSignal,
    btoa,
    atob,
    crypto: globalThis.crypto,
    ...(WebSocket ? { WebSocket } : {})
  });
  for (const file of ['en.js', 'nl.js', 'index.js']) {
    vm.runInContext(fs.readFileSync(path.join(root, 'src', 'i18n', file), 'utf8'), context, { filename: `i18n/${file}` });
  }
  vm.runInContext(engineText, context, { filename: 'web/engine.js' });
  for (const name of ['require', 'process', 'Buffer', 'module', 'exports', 'global']) {
    assert.equal(vm.runInContext(`typeof ${name}`, context), 'undefined', `the page has no ${name}`);
  }
  return context;
}

const tagOf = (token) => createHash('sha256').update(token, 'utf8').digest('base64url').slice(0, 22);

// The interface the WorkspaceService uses of the account service, with nothing behind it but answers.
function fakeAccount({ server = 'https://chat.example.test', token = 'fake-session-token' } = {}) {
  const listeners = { status: new Set(), info: new Set() };
  const info = { features: ['workspaces-v1'], workspace: { versions: [1] }, signups: 'invite' };
  let signedIn = true;
  const calls = [];
  return {
    calls,
    status: () => ({ signedIn, server, email: signedIn ? 'me@example.test' : null, info }),
    get sessionTag() {
      return signedIn ? tagOf(token) : null;
    },
    on(name, fn) {
      listeners[name].add(fn);
      return this;
    },
    removeListener(name, fn) {
      listeners[name].delete(fn);
      return this;
    },
    serverInfo: async () => info,
    async workspaceCall(method, route) {
      calls.push(`${method} ${route}`);
      if (method === 'GET' && route === '/v1/workspaces') return { workspaces: [] };
      throw Object.assign(new Error('Not here'), { code: 'not_found', status: 404, details: null });
    },
    signOut() {
      signedIn = false;
      for (const fn of listeners.status) fn();
    }
  };
}

test('createWebEngine reaches chatState in a page and follows the account until it signs out', async () => {
  const made = [];
  class RecordingSocket {
    constructor(...args) {
      made.push(args);
    }
  }
  const page = pageContext({ WebSocket: RecordingSocket });
  assert.equal(page.RukooWebEngine.SQL_WASM_FILE, SQL_WASM_FILE, 'the engine asks for the file the build copies');
  const account = fakeAccount();
  const events = [];
  let notifications = true;
  const engine = await page.RukooWebEngine.createWebEngine({
    account,
    settings: () => ({ chatNotifications: notifications }),
    onEvent: (e) => events.push(e),
    timing: { coalesce: 5 },
    sqlite: { wasmBinary }
  });
  try {
    const state = await until(async () => {
      const s = await engine.chatApi.chatState();
      return s.connection === 'online' && s;
    }, 15000, 'the first listing');
    assert.equal(state.available, true);
    assert.equal(state.signedIn, true);
    assert.equal(state.storage, true, 'the cache opened on sql.js');
    assert.equal(state.host, 'chat.example.test');
    assert.equal(state.workspaces.length, 0);
    assert.equal(state.unsent, 0);
    assert.equal(engine.unsent(), 0);
    assert.ok(account.calls.includes('GET /v1/workspaces'));
    assert.equal(engine.svc.store.db.constructor.name, 'DatabaseSync');
    assert.equal(engine.svc.store.getMeta('session'), account.sessionTag);
    assert.equal(made.length, 0, 'no workspace, no socket');
    await until(() => events.some((e) => e.kind === 'state' && e.state.connection === 'online'), 5000, 'a state event');

    // The arguments are checked before anything else, as on desktop.
    await assert.rejects(engine.chatApi.chatView('not-a-workspace'), (err) => err.chat === true && err.code === 'invalid');
    // The invitation of a sign-up waits for the Chat view (manage.js rememberJoin), which the bridge sets.
    const link = `https://chat.example.test/join#w=w_${'A'.repeat(22)}&i=${'s'.repeat(43)}`;
    engine.svc.manage.rememberJoin(link);
    assert.equal((await engine.chatApi.chatState()).pendingJoin, true);
    assert.deepEqual({ ...(await engine.chatApi.chatTakePendingJoin()) }, { link });
    // A setting the state carries.
    notifications = false;
    engine.settingsChanged();
    await until(() => events.some((e) => e.kind === 'state' && e.state.notifications === false), 5000, 'the setting in a state event');
    engine.setFocused(true);
    engine.nudge('resume');

    // Signed out: the cache goes (store.wipe() on the adapter), and nothing is left to read.
    account.signOut();
    const out = await engine.chatApi.chatState();
    assert.equal(out.signedIn, false);
    assert.equal(out.storage, true);
    assert.equal(engine.svc.store, null);
    await assert.rejects(engine.chatApi.chatSync(null), (err) => err.code === 'signed_out');
  } finally {
    engine.dispose();
  }
  assert.equal((await engine.chatApi.chatState()).available, false, 'after dispose, the blank state');
  assert.equal(engine.unsent(), 0);
});

// The account service against a real server, as the web one behaves for the engine: Bearer token, the workspace
// protocol header, the server's error code with its details.
function serverAccount(server, person) {
  const listeners = { status: new Set(), info: new Set() };
  let info = null;
  return {
    status: () => ({ signedIn: true, server: server.url, email: person.email, info }),
    sessionTag: tagOf(person.token),
    on(name, fn) {
      listeners[name].add(fn);
      return this;
    },
    removeListener(name, fn) {
      listeners[name].delete(fn);
      return this;
    },
    async serverInfo() {
      info = await (await fetch(`${server.url}/v1/info`)).json();
      for (const fn of listeners.info) fn(info);
      return info;
    },
    async workspaceCall(method, route, body) {
      const headers = { accept: 'application/json', authorization: `Bearer ${person.token}`, 'rukoo-workspace-version': '1' };
      if (body !== undefined) headers['content-type'] = 'application/json';
      const res = await fetch(server.url + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await res.text();
      const json = text ? JSON.parse(text) : null;
      if (res.ok) return json;
      const wait = Number(res.headers.get('retry-after'));
      const details = { ...(json && json.scope ? { scope: json.scope } : {}), ...(Number.isSafeInteger(wait) && wait > 0 ? { retryAfter: wait } : {}) };
      throw Object.assign(new Error((json && json.message) || `HTTP ${res.status}`), { code: (json && json.error) || 'server', status: res.status, details });
    }
  };
}

test('against the real server: the socket opens with its ticket as a subprotocol, a message arrives live, and a send goes out', async (t) => {
  const { startRealServer, skipWithoutServer } = require('../../test/fixtures/real-server.js');
  if (skipWithoutServer(t)) return;
  const server = await startRealServer();
  let engine = null;
  try {
    const olga = await server.seedAccount();
    const bart = await server.seedAccount();
    const ws = await server.seedWorkspace(olga, { name: 'Acme', displayName: 'Olga Owner' });
    await server.seedMember(ws, bart, 'Bart');

    const offered = [];
    class RecordingSocket extends WebSocket {
      constructor(url, protocols) {
        super(url, protocols);
        offered.push({ url, protocols });
      }
    }
    const page = pageContext({ WebSocket: RecordingSocket });
    const events = [];
    engine = await page.RukooWebEngine.createWebEngine({
      account: serverAccount(server, bart),
      settings: () => ({ chatNotifications: true }),
      onEvent: (e) => events.push(e),
      timing: { coalesce: 5 },
      sqlite: { wasmBinary }
    });
    const api = engine.chatApi;
    const ready = await until(async () => {
      const s = await api.chatState();
      const w = s.workspaces.find((x) => x.id === ws.id);
      return w && w.status === 'ok' && w.socket === 'open' && s;
    }, 30000, 'the first pass and an open socket');
    assert.equal(ready.connection, 'online');
    assert.equal(offered.length, 1);
    assert.equal(offered[0].url, `${server.url.replace(/^http/, 'ws')}/v1/workspaces/${ws.id}/socket`);
    assert.equal(offered[0].protocols.length, 2);
    assert.equal(offered[0].protocols[0], 'rukoo.workspace.v1');
    assert.match(offered[0].protocols[1], /^rukoo\.ticket\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

    const view = await api.chatView(ws.id);
    assert.ok(view.rooms.some((r) => r.id === ws.general), 'general is in the cache');
    await api.chatOpen(ws.id, ws.general);

    // Olga writes; the socket's wake starts a sync, and the open room hears the message.
    await server.post(olga, ws.id, ws.general, 'Hello from Olga');
    await until(
      () => events.some((e) => e.kind === 'events' && e.conversation === ws.general && e.events.some((x) => x.text === 'Hello from Olga')),
      20000,
      "Olga's message"
    );

    // Bart writes from the browser engine: the outbox sends it and the server gives it a sequence number.
    const sent = await api.chatSend(ws.id, ws.general, { text: 'Hello from the browser' });
    const done = await until(() => events.find((e) => e.kind === 'sent' && e.local === sent.local), 20000, 'the send');
    assert.match(done.messageId, /^e_[A-Za-z0-9_-]{22}$/);
    assert.ok(Number.isSafeInteger(done.seq));
    assert.equal(engine.unsent(), 0);
    const reopened = await api.chatOpen(ws.id, ws.general);
    // Spread: the page's arrays have the page's Array prototype.
    assert.deepEqual(
      [...reopened.events.filter((e) => e.kind === 'message.posted').map((e) => e.text)],
      ['Hello from Olga', 'Hello from the browser']
    );
  } finally {
    if (engine) engine.dispose();
    await server.close();
  }
});

test('bare imports resolve from website/node_modules, whatever node_modules lie nearer the importing file', async () => {
  // hash-wasm is in the root's node_modules too; the account code imports it from src/web.
  const result = await build({
    stdin: { contents: "require('hash-wasm'); require('sql.js/dist/sql-wasm-browser.js');", resolveDir: path.join(root, 'src', 'web'), sourcefile: 'bare.js' },
    format: 'iife',
    metafile: true
  });
  const inputs = Object.keys(result.metafile.inputs).map(rel);
  assert.ok(inputs.some((f) => f.startsWith('website/node_modules/hash-wasm/')), 'hash-wasm from website/node_modules');
  assert.ok(inputs.includes('website/node_modules/sql.js/dist/sql-wasm-browser.js'));
  assert.ok(!inputs.some((f) => /(^|\/)node_modules\//.test(f) && !f.startsWith('website/node_modules/')), inputs.join(', '));
});
