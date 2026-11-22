'use strict';

// The real Rukoo account server (server/src/index.js) in the local Workers runtime, for tests that need the team chat
// routes. It runs under wrangler's unstable_startWorker from server/node_modules, so `npm ci --prefix server` must have
// run; this file never installs anything. Each server binds 127.0.0.1 on a port from 38800 to 38899, which a lock file
// keeps from other test processes, and keeps its storage in a temporary folder that close() removes.
//
//   const server = await startRealServer();                      // { url, inviteCode, call, seed..., stop, start, close }
//   const olga = await server.seedAccount();                     // random keys: a person the app never signs in as
//   const bart = await server.seedAccount({ password: 'long enough password' }); // the app can sign in with it
//   const ws = await server.seedWorkspace(olga, { name: 'Acme', displayName: 'Olga Owner' });
//   await server.seedMember(ws, bart, 'Bart');
//   await server.post(olga, ws.id, ws.general, 'Hello');
//
// Rich messages: the Worker has a files bucket (unless startRealServer({ files: false })), and a page server on
// 127.0.0.1 that link cards may fetch (WORKSPACE_PREVIEW_HOSTS):
//
//   const file = await server.upload(olga, ws.id, ws.general, { name: 'a.png', type: 'image/png', bytes, width, height });
//   const sent = await server.post(olga, ws.id, ws.general, 'Look', { attachments: [file.id] });
//   await server.react(bart, ws.id, ws.general, sent.messageId, '👍');
//   const got = await server.download(bart, ws.id, ws.general, file.id);   // { status, headers, bytes }
//   const url = await server.previewPage({ title: 'Plan', description: 'Q3', image: true });
//
// In node:test files:
//
//   test.before(async () => { if (realServerAvailable()) server = await startRealServer(); });
//   test.after(() => server?.close());
//   test('...', async (t) => { if (skipWithoutServer(t)) return; ... });
//
// Without server/node_modules a test skips, unless CI or RUKOO_REQUIRE_REAL_SERVER=1 is set: then it fails, so a
// forgotten install step can't turn the chat tests green by skipping them.
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { createRequire } = require('module');
const { tempDir, removeDir } = require('../tmp');
const { serverUrl } = require('../../src/main/account/client.js');

const ROOT = path.resolve(__dirname, '..', '..');
const SERVER_DIR = path.join(ROOT, 'server');
// The pages link cards are made of, shared with the server's own tests. Plain Node, nothing from node_modules.
const PREVIEW_PAGES = path.join(SERVER_DIR, 'test', 'fixtures', 'preview-pages.cjs');

// Loaded on first use: crypto.js needs hash-wasm from the root node_modules, which Android's CI job doesn't install.
// Only seedAccount({ password }) needs it.
let keysModule = null;
const keys = () => (keysModule ||= require('../../src/main/account/crypto.js'));

const PEPPER = 'test-pepper-not-secret-0123456789';
const INVITE = 'test-invite';
const PROTOCOL = 'rukoo.workspace.v1';
const UNAVAILABLE = 'run npm ci in server/ to test chat against the real server';

// The range every fixed port of the chat tests comes from. 38850 is Android's live server and 38811 a hand-run
// `wrangler dev`, so the helper may pick them too: it locks and probes before it binds.
const PORT_FIRST = 38800;
const PORT_COUNT = 100;
const PORT_TRIES = 10;
// A cold start takes about a second here; a hosted CI runner's is unmeasured.
const START_TIMEOUT = 60000;

// The operator settings, as server/vitest.config.js sets them, with team chat on. vars may change any of them.
// SIGNUPS 'invite' with INVITE_USES '0' makes the one code work for any number of accounts.
const VARS = {
  SIGNUPS: 'invite',
  INVITE_USES: '0',
  JURISDICTION: '',
  OPERATOR_NAME: 'Test operator',
  OPERATOR_URL: 'https://example.test',
  OPERATOR_CONTACT: 'ops@example.test',
  PRIVACY_URL: '',
  BOOKING_ORIGIN: '',
  BOOKING_ALIASES: '',
  BOOKING_FORMER_ROOTS: '',
  BLOCKED_HANDLES: '',
  WORKSPACE_MODE: 'on',
  WORKSPACE_ORIGIN: ''
};

const realServerAvailable = () => fs.existsSync(path.join(SERVER_DIR, 'node_modules', 'wrangler', 'package.json'));
const realServerRequired = () => Boolean(process.env.CI) || process.env.RUKOO_REQUIRE_REAL_SERVER === '1';

function unavailableError() {
  const err = new Error(`The real account server is missing: ${UNAVAILABLE}`);
  err.code = 'REAL_SERVER_UNAVAILABLE';
  return err;
}

// For node:test: true after t.skip() when the server can't run here. Where the server is required, it throws, which
// fails the test.
function skipWithoutServer(t) {
  if (realServerAvailable()) return false;
  if (realServerRequired()) throw unavailableError();
  t.skip(UNAVAILABLE);
  return true;
}

// JSON with comments and trailing commas, as wrangler.jsonc is written. Strings are copied as they are, so a URL's
// "//" stays.
function parseJsonc(text) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (ch === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2) + 1;
      if (i === 0) break;
    } else {
      out += ch;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

// Whether nothing listens on 127.0.0.1:port right now. A probe alone can't keep two helpers apart: workerd binds a
// port another workerd took a moment earlier without an error, so both would start on it. The port lock below does.
function portFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.unref();
    probe.once('error', () => resolve(false));
    probe.listen({ host: '127.0.0.1', port, exclusive: true }, () => probe.close(() => resolve(true)));
  });
}

// The ports to try, from a random place in the range and wrapping within it. A start from the process ID would bunch
// up: Windows process IDs are multiples of 4, and node --test starts its files with consecutive IDs elsewhere.
function candidatePorts() {
  const start = crypto.randomInt(PORT_COUNT);
  return Array.from({ length: PORT_COUNT }, (_, i) => PORT_FIRST + ((start + i) % PORT_COUNT));
}

// A port lock across processes: a file in the system's temporary folder holding the process ID of the helper that
// owns the port, made with 'wx' so only one process can create it. The owner keeps it through stop() and start(),
// and close() or the process's exit removes it. A lock whose process is gone is taken over.
const lockFile = (port) => path.join(os.tmpdir(), `rukoo-real-server-${port}.lock`);
const heldLocks = new Set();

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// The process ID in a lock file, or null when it has none: just made and not yet written, or damaged.
function lockOwner(file) {
  try {
    const pid = Number(fs.readFileSync(file, 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch (_) {
    return null;
  }
}

// A lock without a living owner. An empty file counts only after a few seconds: its maker may be writing it now.
function lockStale(file) {
  const pid = lockOwner(file);
  if (pid !== null) return pid !== process.pid && !alive(pid);
  try {
    return Date.now() - fs.statSync(file).mtimeMs > 5000;
  } catch (_) {
    return false;
  }
}

// Makes file with 'wx', holding this process's ID: true, or false when it exists.
function makeLock(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'wx');
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    return false;
  }
  try {
    fs.writeSync(fd, String(process.pid));
  } finally {
    fs.closeSync(fd);
  }
  return true;
}

// A takeover guard older than this was left by a process that ended in the middle of a takeover, a few file
// operations. It stays: removing it could remove a newer one another process just made, since checking its age and
// removing it are two steps. The helper says where it is and uses another port.
const GUARD_STALE_MS = 10000;
const reportedGuards = new Set();

// True when this process now owns port's lock. False when another living process, or this one for another server,
// owns it, or another process is taking over a stale lock on it right now.
function claimPort(port) {
  const file = lockFile(port);
  if (makeLock(file)) {
    heldLocks.add(port);
    return true;
  }
  if (!lockStale(file)) return false;
  // One process at a time takes over a stale lock: the one that made the guard. While the guard exists nobody else
  // removes the lock, and nobody makes a new one while the stale one is there, so the lock checked again under the
  // guard is still the one that goes.
  const guard = `${file}.takeover`;
  if (!makeLock(guard)) {
    try {
      if (Date.now() - fs.statSync(guard).mtimeMs > GUARD_STALE_MS && !reportedGuards.has(guard)) {
        reportedGuards.add(guard);
        console.warn(`real-server: port ${port} stays unused while ${guard} exists. Delete it when no test is running.`);
      }
    } catch (_) {
      // Gone already.
    }
    return false;
  }
  try {
    if (!lockStale(file)) return false;
    fs.rmSync(file, { force: true });
    if (!makeLock(file)) return false;
    heldLocks.add(port);
    return true;
  } finally {
    fs.rmSync(guard, { force: true });
  }
}

function releasePort(port) {
  if (!heldLocks.delete(port)) return;
  const file = lockFile(port);
  if (lockOwner(file) === process.pid) fs.rmSync(file, { force: true });
}

// A test file that never calls close() still frees its ports when it ends.
process.on('exit', () => {
  for (const port of [...heldLocks]) releasePort(port);
});

// ---- codes by email ----
//
// The server mails codes through Resend (server/src/mail.js). With mail on, the Worker's entry is a wrapper that sends
// its requests to https://api.resend.com to a mail stand-in on 127.0.0.1 instead, which keeps every message and never
// mails anything. The server itself runs as it is. Its tests have the same stand-in in their own runtime
// (server/test/fixtures/fake-resend.js); this one serves a Worker in another process, and the tests that read the codes.
//
//   const server = await startRealServer({ vars: { SIGNUPS: 'verified' }, mail: true });
//   server.mail.code('bart@example.com')    // the six digits in the newest message to the address, or null
//   server.mail.token('bart@example.com')   // the long code in it, or null
//
// GET <mail origin>/messages?to=<address> answers the messages to an address as JSON, for a test in another process,
// such as Android's live tests (real-server-cli.js writes the origin to its ready file as mail).
const RESEND_ORIGIN = 'https://api.resend.com';
// What turns mail on in the Worker (server/README.md, Codes by email). Neither is a credential.
const MAIL_KEY = 're_test_not_a_real_key';
const MAIL_FROM = 'Rukoo test <codes@example.test>';

function startMailSink() {
  const sent = [];
  const server = require('http').createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://127.0.0.1');
      const answer = (status, json) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(json));
      };
      if (req.method === 'POST' && url.pathname === '/emails') {
        if (req.headers.authorization !== `Bearer ${MAIL_KEY}`) return answer(401, { name: 'missing_api_key' });
        let body = null;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch (_) {
          body = null;
        }
        if (!body || !Array.isArray(body.to) || typeof body.text !== 'string') return answer(422, { name: 'validation_error' });
        sent.push({ ...body, at: Date.now() });
        return answer(200, { id: crypto.randomUUID() });
      }
      if (req.method === 'GET' && url.pathname === '/messages') {
        const to = String(url.searchParams.get('to') || '').toLowerCase();
        return answer(200, { messages: sent.filter((m) => !to || m.to.includes(to)).map(read) });
      }
      answer(404, { name: 'not_found' });
    });
  });
  // A message as the tests read it: who it went to, its subject and text, and the codes in it.
  const read = (m) => ({
    to: m.to[0],
    subject: m.subject,
    text: m.text,
    code: m.text.match(/^\d{6}$/m)?.[0] ?? null,
    token: m.text.match(/^[A-Za-z0-9_-]{43}$/m)?.[0] ?? null,
    at: m.at
  });
  const to = (address) => sent.filter((m) => m.to.includes(String(address).toLowerCase())).map(read);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const origin = `http://127.0.0.1:${server.address().port}`;
      resolve({
        origin,
        sent,
        to,
        code: (address) => to(address).at(-1)?.code ?? null,
        token: (address) => to(address).at(-1)?.token ?? null,
        // Waits for a message to an address that a code request sends after its answer (server/src/codes.js deliver).
        async next(address, { after = 0, timeout = 10000 } = {}) {
          const until = Date.now() + timeout;
          for (;;) {
            const m = to(address).filter((x) => x.at > after).at(-1);
            if (m) return m;
            if (Date.now() > until) throw new Error(`No mail to ${address} within ${timeout} ms`);
            await new Promise((r) => setTimeout(r, 50));
          }
        },
        close: () => new Promise((r) => server.close(() => r()))
      });
    });
  });
}

// The Worker entry with mail: the server's own entry, its Durable Object classes and all, with requests to Resend sent
// to the mail stand-in at sink. Written into dir; index is the server's src/index.js. Returns the entry's path.
function writeMailEntry(dir, sink, index = path.join(SERVER_DIR, 'src', 'index.js')) {
  const from = JSON.stringify(index.split(path.sep).join('/'));
  const file = path.join(dir, 'mail-entry.mjs');
  fs.writeFileSync(
    file,
    `// Written by test/fixtures/real-server.js: the account server with its mail going to ${sink}.
import worker from ${from};
export * from ${from};
const SINK = ${JSON.stringify(sink)};
const RESEND = ${JSON.stringify(RESEND_ORIGIN)};
const real = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const address = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(address);
  if (url.origin === RESEND) return real(SINK + url.pathname, init);
  return real(input, init);
};
export default worker;
`
  );
  return file;
}

// The worker config, in the temporary folder: wrangler bundles into the config's folder, so server/.wrangler stays
// untouched. env and $schema go; ratelimits go unless limiters, as one spec makes more than 30 sign-ups, logins and
// joins a minute from 127.0.0.1 (limitRate() in server/src/config.js skips without its binding). files binds a local
// bucket as WORKSPACE_FILES, which wrangler.jsonc leaves commented out; previewHost lets link cards reach the page
// server. sink: the mail stand-in's origin, which turns codes by email on.
function writeConfig(dir, { vars, limiters, files, previewHost, sink }) {
  const config = parseJsonc(fs.readFileSync(path.join(SERVER_DIR, 'wrangler.jsonc'), 'utf8'));
  delete config.env;
  delete config.$schema;
  if (!limiters) delete config.ratelimits;
  // fallthrough: false silences wrangler's warning about the shadowed default .bin rule; bundling is the same.
  config.rules = (config.rules || []).map((rule) => ({ ...rule, fallthrough: false }));
  config.main = sink ? writeMailEntry(dir, sink) : path.join(SERVER_DIR, 'src', 'index.js');
  if (files) config.r2_buckets = [{ binding: 'WORKSPACE_FILES', bucket_name: 'rukoo-workspace-files-test' }];
  else delete config.r2_buckets;
  config.vars = {
    ...config.vars,
    ...VARS,
    ...(previewHost ? { WORKSPACE_PREVIEW_HOSTS: previewHost } : {}),
    ...(sink ? { MAIL_FROM } : {}),
    ...vars
  };
  const file = path.join(dir, 'wrangler.json');
  fs.writeFileSync(file, JSON.stringify(config));
  return file;
}

// The one place that maps the helper's options onto wrangler's, so a wrangler upgrade touches this function only.
async function startWorker(unstable_startWorker, { configPath, port, persist, logLevel, mail = false }) {
  const worker = await unstable_startWorker({
    config: configPath,
    bindings: {
      PEPPER: { type: 'secret_text', value: PEPPER },
      INVITE_CODES: { type: 'secret_text', value: INVITE },
      ...(mail ? { RESEND_API_KEY: { type: 'secret_text', value: MAIL_KEY } } : {})
    },
    // A developer's server/.dev.vars never reaches the tests.
    envFiles: [],
    dev: {
      server: { hostname: '127.0.0.1', port },
      inspector: false,
      watch: false,
      liveReload: false,
      persist,
      logLevel
    }
  });
  let timer = null;
  try {
    const late = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`The Worker wasn't ready after ${START_TIMEOUT / 1000} s`)), START_TIMEOUT);
    });
    await Promise.race([worker.ready, late]);
    clearTimeout(timer);
    const url = (await worker.url).href.replace(/\/$/, '');
    if (Number(new URL(url).port) !== port) throw new Error(`The Worker bound ${url} instead of port ${port}`);
    return { worker, url };
  } catch (err) {
    clearTimeout(timer);
    await worker.dispose().catch(() => {});
    throw err;
  }
}

// options.port: a fixed port, tried once; null picks one from the range. limiters: keep the per-address rate limiters,
// for a test of the app's 429 handling. vars: overrides such as { WORKSPACE_MODE: 'off' } or { SIGNUPS: 'verified' }.
// files: false starts the Worker without its files bucket, as a server whose operator made none: no files capability,
// and 403 files_off. mail: codes by email go to a mail stand-in (startMailSink), which the result has as mail.
async function startRealServer({ vars = {}, port = null, limiters = false, logLevel = 'error', files = true, mail = false } = {}) {
  if (!realServerAvailable()) throw unavailableError();
  // Miniflare otherwise fetches https://workers.cloudflare.com/cf.json and caches it in .wrangler/cache (or
  // node_modules/.mf) under the current folder. Its built-in request.cf is enough here, and offline.
  process.env.CLOUDFLARE_CF_FETCH_ENABLED = 'false';
  const { unstable_startWorker } = createRequire(path.join(SERVER_DIR, 'package.json'))('wrangler');
  // The page server binds 127.0.0.1 on a port the system picks, outside the helper's range; it lives as long as the
  // helper does, through stop() and start(). So does the mail stand-in.
  const pages = await require(PREVIEW_PAGES).startPreviewServer();
  const sink = mail ? await startMailSink() : null;
  const dir = tempDir('rukoo-real-server-');
  const settings = {
    configPath: writeConfig(dir, { vars, limiters, files, previewHost: pages.host, sink: sink && sink.origin }),
    persist: path.join(dir, 'state'),
    logLevel,
    mail: Boolean(sink)
  };

  let worker = null;
  let url = null;
  // Starts the Worker on at, holding at's lock, which is released again when the start fails. workerd binds a port
  // another server already listens on without an error, and the two would share requests, so each helper takes the
  // lock first and then probes for anything else on the port, such as a hand-run wrangler dev.
  async function startOn(at) {
    try {
      ({ worker, url } = await startWorker(unstable_startWorker, { ...settings, port: at }));
    } catch (err) {
      releasePort(at);
      throw err;
    }
  }
  try {
    if (port !== null) {
      const at = Number(port);
      if (!claimPort(at)) throw new Error(`Port ${at} on 127.0.0.1 is in use by another test server (${lockFile(at)})`);
      if (!(await portFree(at))) {
        releasePort(at);
        throw new Error(`Port ${at} on 127.0.0.1 is in use`);
      }
      await startOn(at);
    } else {
      let tries = 0;
      let last = null;
      for (const at of candidatePorts()) {
        if (tries >= PORT_TRIES) break;
        if (!claimPort(at)) continue;
        if (!(await portFree(at))) {
          releasePort(at);
          continue;
        }
        tries++;
        try {
          await startOn(at);
          break;
        } catch (err) {
          // Only a port something else took after the probe is worth another try; a bundle that doesn't build fails
          // at once.
          if (await portFree(at)) throw err;
          last = err;
        }
      }
      if (!worker) throw last || new Error(`No free port from ${PORT_FIRST} to ${PORT_FIRST + PORT_COUNT - 1}`);
    }
  } catch (err) {
    removeDir(dir);
    await pages.close();
    await sink?.close();
    throw err;
  }
  const boundPort = Number(new URL(url).port);

  // The server goes away and comes back on the same address with the same storage: a device sees it offline, then
  // online again, and sessions, workspaces and messages are still there.
  async function stop() {
    const w = worker;
    worker = null;
    if (w) await w.dispose();
  }
  async function start() {
    if (worker) return;
    // The port the server had, which another process may have taken while it was stopped.
    let free = await portFree(boundPort);
    for (let i = 0; !free && i < 20; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      free = await portFree(boundPort);
    }
    if (!free) throw new Error(`Port ${boundPort} on 127.0.0.1 was taken while the server was stopped`);
    ({ worker } = await startWorker(unstable_startWorker, { ...settings, port: boundPort }));
  }

  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    try {
      await stop();
    } finally {
      releasePort(boundPort);
      removeDir(dir);
      await pages.close();
      await sink?.close();
    }
  }

  return { ...seeding(url, { pages }), dir, lockFile: lockFile(boundPort), previewOrigin: pages.origin, mail: sink, stop, start, close };
}

// The seeding API against a server that already runs, such as one real-server-cli.js started for an emulator check.
// It has no stop, start or close: the server isn't this process's. previews: the page server's origin, which the CLI
// writes to its ready file, for previewPage().
function connectRealServer(url, { previews = null } = {}) {
  const base = serverUrl(url);
  if (!base) throw new Error(`Not a server address Rukoo may talk to: ${url}`);
  return seeding(base, { previews });
}

function seeding(url, { pages = null, previews = null } = {}) {
  // The address as the app normalizes it. Password keys and invitation links depend on it, so the app must be given
  // exactly server.url.
  const canonical = serverUrl(url);

  // timeout: a request the server never answers fails the test instead of hanging it.
  async function call(method, route, { body, token, headers = {}, timeout = 30000 } = {}) {
    const h = { accept: 'application/json', ...headers };
    if (body !== undefined) h['content-type'] = 'application/json';
    if (token) h.authorization = `Bearer ${token}`;
    const res = await fetch(url + route, {
      method,
      headers: h,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeout)
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch (_) {
      json = null;
    }
    return { status: res.status, body: json, text, headers: res.headers };
  }

  async function expect(statuses, promise, what) {
    const r = await promise;
    if (![].concat(statuses).includes(r.status)) throw new Error(`${what}: ${r.status} ${r.text}`);
    return r.body;
  }

  let counter = 0;
  const newEmail = () => `person-${++counter}-${crypto.randomBytes(4).toString('hex')}@example.com`;

  // With password: keys from the desktop's own code (src/main/account/crypto.js) for this server's address, so the
  // app signs in with { email, password } (Argon2id, about 140 ms). Without: random keys of the right shape, which
  // need nothing from the root's node_modules, so the CLI and the Android recorder run with server/ alone.
  async function seedAccount({ email = newEmail(), password = null, device = { name: 'Seeded', platform: 'linux' } } = {}) {
    let body;
    let recoveryKey = null;
    if (!password) {
      const b64 = (n) => crypto.randomBytes(n).toString('base64url');
      const sealedShape = () => {
        const bytes = crypto.randomBytes(61);
        bytes[0] = 1;
        return bytes.toString('base64url');
      };
      body = {
        email: email.trim().toLowerCase(),
        invite: INVITE,
        kdf: { alg: 'argon2id', m: 65536, t: 3, p: 1 },
        salt: b64(16),
        authKey: b64(32),
        wrappedKey: sealedShape(),
        recoveryAuth: b64(32),
        recoveryWrappedKey: sealedShape(),
        device
      };
    } else {
      const k = keys();
      const salt = crypto.randomBytes(16);
      const dataKey = crypto.randomBytes(32);
      const recovery = crypto.randomBytes(20);
      const { authKey, wrapKey } = await k.passwordKeys(password, salt, k.DEFAULT_KDF, canonical);
      const { recoveryAuth, recoveryWrap } = k.recoveryKeys(recovery, canonical);
      body = {
        email: k.normalizeEmail(email),
        invite: INVITE,
        kdf: k.DEFAULT_KDF,
        salt: k.b64u(salt),
        authKey: k.b64u(authKey),
        wrappedKey: k.b64u(k.wrapDataKey(wrapKey, dataKey)),
        recoveryAuth: k.b64u(recoveryAuth),
        recoveryWrappedKey: k.b64u(k.wrapDataKey(recoveryWrap, dataKey)),
        device
      };
      recoveryKey = k.formatRecoveryKey(recovery);
    }
    const made = await expect(201, call('POST', '/v1/signup', { body }), 'sign-up');
    return { email: body.email, password, token: made.token, account: made.account, recoveryKey };
  }

  const ws = (id, rest = '') => `/v1/workspaces/${id}${rest}`;
  const as = (person, extra = {}) => ({ token: person.token, ...extra });

  async function channels(person, wsId) {
    return (await expect(200, call('GET', ws(wsId, '/channels'), as(person)), 'channels')).channels;
  }

  async function seedWorkspace(person, { name = 'Acme', displayName = 'Olga Owner' } = {}) {
    const made = await expect(201, call('POST', '/v1/workspaces', as(person, { body: { name, displayName } })), 'workspace');
    const id = made.workspace.id;
    const general = (await channels(person, id)).find((c) => c.name === 'general');
    return { id, owner: person, me: made.me, general: general ? general.id : null };
  }

  // An invitation and its link in the format both apps parse (contract 3.2).
  async function createInvite(person, wsId, body = { role: 'member' }) {
    const made = await expect(201, call('POST', ws(wsId, '/invites'), as(person, { body })), 'invite');
    return { invite: made.invite, secret: made.secret, link: `${canonical}/join#w=${wsId}&i=${made.secret}` };
  }

  // person joins workspace w through a fresh invitation from its owner, then general unless they are in it already
  // (a server that grants it on joining) or joinGeneral is false. Guests don't join channels by themselves.
  async function seedMember(w, person, name, { role = 'member', channels: into = [], joinGeneral = true } = {}) {
    const { secret } = await createInvite(w.owner, w.id, { role, channels: into });
    const joined = await expect([200, 201], call('POST', ws(w.id, '/join'), as(person, { body: { invite: secret, name } })), 'join');
    if (joinGeneral && role !== 'guest' && w.general) {
      const general = (await channels(person, w.id)).find((c) => c.id === w.general);
      if (general && !general.joined) await expect(200, call('POST', ws(w.id, `/channels/${w.general}/join`), as(person)), 'join general');
    }
    return joined.me;
  }

  // A channel made by person, with each of members (member IDs) added. Returns the channel as the server answered it.
  async function seedChannel(person, wsId, { name = 'project', visibility = 'workspace', members = [] } = {}) {
    const made = await expect(201, call('POST', ws(wsId, '/channels'), as(person, { body: { name, visibility } })), 'channel');
    for (const member of members) {
      await expect([200, 201, 204], call('POST', ws(wsId, `/channels/${made.channel.id}/members`), as(person, { body: { member } })), 'add to channel');
    }
    return made.channel;
  }

  // A DM between person and memberIds (the other participants): new (201) or the open one for the set (200).
  async function seedDm(person, wsId, memberIds) {
    return (await expect([200, 201], call('POST', ws(wsId, '/dms'), as(person, { body: { members: memberIds } })), 'dm')).dm;
  }

  async function block(person, wsId, memberId) {
    return (await expect([200, 201], call('POST', ws(wsId, '/blocks'), as(person, { body: { member: memberId } })), 'block')).block;
  }

  // The grant a device holds in a conversation, from a full pass of the feed, and the workspace's generation and
  // time. Only HTTP, as a device does: unlike server/test/workspace-helpers.js it reads no SQL.
  async function access(person, wsId, conversation) {
    let cursor = null;
    let grant = null;
    for (;;) {
      const route = ws(wsId, `/changes${cursor ? `?after=${encodeURIComponent(cursor)}` : ''}`);
      const page = await expect(200, call('GET', route, as(person)), 'feed');
      const room = page.changes.find((c) => c.conversation === conversation);
      if (room) grant = room.grant;
      cursor = page.next;
      if (!page.more) break;
    }
    const meta = await expect(200, call('GET', ws(wsId), as(person)), 'workspace');
    return { grant, generation: meta.workspace.generation, time: meta.workspace.time };
  }

  // extra: mentions (from mention()), root (a thread's root message ID), or a fixed operationId.
  async function post(person, wsId, conversation, text, extra = {}) {
    const a = await access(person, wsId, conversation);
    const body = { operationId: uuidv7(a.time), grant: a.grant, generation: a.generation, text, ...extra };
    return expect(201, call('POST', ws(wsId, `/conversations/${conversation}/messages`), as(person, { body })), 'post');
  }

  async function redact(person, wsId, conversation, messageId) {
    return expect(200, call('POST', ws(wsId, `/conversations/${conversation}/messages/${messageId}/redact`), as(person)), 'redact');
  }

  async function read(person, wsId, conversation, seq) {
    return expect(200, call('POST', ws(wsId, `/conversations/${conversation}/read`), as(person, { body: { seq } })), 'read');
  }

  // ---- Rich messages ----
  //
  // Each takes the workspace as its ID or as what seedWorkspace() answered.
  const wid = (w) => (typeof w === 'string' ? w : w.id);

  // A reaction, or taking one back: { messageId, emoji, on, changed }.
  async function react(person, w, conversation, message, emoji, on = true) {
    const route = ws(wid(w), `/conversations/${conversation}/messages/${message}/react`);
    return expect(200, call('POST', route, as(person, { body: { emoji, on } })), 'react');
  }

  // Marks a message unread for person: { read, readMark }.
  async function markUnread(person, w, conversation, message) {
    return expect(200, call('POST', ws(wid(w), `/conversations/${conversation}/unread`), as(person, { body: { message } })), 'mark unread');
  }

  // Reserves an upload: { upload: { id, expiresAt }, put: { url, expiresAt } }. sha256 and size default to bytes'.
  async function reserveUpload(person, w, conversation, { name = 'file.bin', type, bytes = Buffer.alloc(0), size, sha256, width, height } = {}) {
    const body = {
      name,
      type,
      size: size ?? bytes.length,
      sha256: sha256 ?? crypto.createHash('sha256').update(bytes).digest('hex'),
      width,
      height
    };
    return expect(201, call('POST', ws(wid(w), `/conversations/${conversation}/uploads`), as(person, { body })), 'reserve upload');
  }

  // PUTs bytes to an upload link, with no session, as a device does: { status, body }.
  async function putUpload(link, bytes, { timeout = 30000 } = {}) {
    const res = await fetch(link, { method: 'PUT', body: bytes, signal: AbortSignal.timeout(timeout) });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch (_) {
      json = null;
    }
    return { status: res.status, body: json };
  }

  // Reserves and uploads a file, ready to name in post(…, { attachments }): { id, expiresAt, name, type, size, sha256 }.
  async function upload(person, w, conversation, { name = 'file.bin', type, bytes = Buffer.from('hello'), width, height } = {}) {
    const data = Buffer.from(bytes);
    const sha256 = crypto.createHash('sha256').update(data).digest('hex');
    const reserved = await reserveUpload(person, w, conversation, { name, type, bytes: data, sha256, width, height });
    const put = await putUpload(reserved.put.url, data);
    if (put.status !== 200) throw new Error(`upload: ${put.status} ${JSON.stringify(put.body)}`);
    return { id: reserved.upload.id, expiresAt: reserved.upload.expiresAt, name, type: type ?? 'application/octet-stream', size: data.length, sha256 };
  }

  async function cancelUpload(person, w, conversation, file) {
    return expect(204, call('DELETE', ws(wid(w), `/conversations/${conversation}/uploads/${file}`), as(person)), 'cancel upload');
  }

  // Downloads a file of a message as person: the download link, then its bytes with no session. { status, headers,
  // bytes, link }: bytes is a Buffer, and link what the download route answered. When the route refuses, status and
  // headers are its own, bytes is null and body its answer.
  async function download(person, w, conversation, file) {
    const asked = await call('POST', ws(wid(w), `/conversations/${conversation}/files/${file}/download`), as(person));
    if (asked.status !== 200) return { status: asked.status, headers: asked.headers, bytes: null, body: asked.body };
    const res = await fetch(asked.body.url, { signal: AbortSignal.timeout(30000) });
    const bytes = Buffer.from(await res.arrayBuffer());
    return { status: res.status, headers: res.headers, bytes, link: asked.body };
  }

  // The author takes a link card off a message: { previews }.
  async function removePreview(person, w, conversation, message, address) {
    const route = ws(wid(w), `/conversations/${conversation}/messages/${message}/previews`);
    return expect(200, call('POST', route, as(person, { body: { remove: address } })), 'remove link card');
  }

  // A page link cards can be made of, on the page server: its address. image: true for a 64 by 32 PNG, { width,
  // height } for one of that size, or an image address to put in og:image. Also site, video and titleTag.
  async function previewPage(spec = {}) {
    if (pages) return pages.page(spec);
    if (!previews) throw new Error('previewPage needs the page server: pass { previews } to connectRealServer');
    const res = await fetch(`${previews}/pages`, { method: 'POST', body: JSON.stringify(spec), signal: AbortSignal.timeout(10000) });
    return (await res.json()).url;
  }

  // The wake socket as a device opens it from Node: a ticket in the Authorization header (Node's WebSocket takes
  // headers in its init), and only the protocol's own name offered. frames collects the text frames.
  async function openSocket(person, wsId) {
    const { ticket } = await expect(200, call('POST', ws(wsId, '/socket-ticket'), as(person)), 'ticket');
    const socket = new WebSocket(`${url.replace(/^http/, 'ws')}${ws(wsId, '/socket')}`, {
      protocols: [PROTOCOL],
      headers: { authorization: `Ticket ${ticket}` }
    });
    const frames = [];
    socket.addEventListener('message', (e) => frames.push(String(e.data)));
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', () => reject(new Error('The server refused the socket')), { once: true });
    });
    return { socket, frames, close: () => socket.close(1000) };
  }

  return {
    url,
    inviteCode: INVITE,
    pepper: PEPPER,
    call,
    seedAccount,
    seedWorkspace,
    createInvite,
    seedMember,
    seedChannel,
    seedDm,
    block,
    channels,
    access,
    post,
    redact,
    read,
    openSocket,
    react,
    markUnread,
    reserveUpload,
    putUpload,
    upload,
    cancelUpload,
    download,
    removePreview,
    previewPage
  };
}

// A lowercase UUIDv7 for time: what the server takes as an operation ID.
function uuidv7(time = Date.now()) {
  const bytes = crypto.randomBytes(16);
  let t = BigInt(time);
  for (let i = 5; i >= 0; i--) {
    bytes[i] = Number(t & 0xffn);
    t >>= 8n;
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// A mention of actor at the first needle in text from character from, in UTF-8 byte offsets as the server takes them.
function mention(text, needle, actor, from = 0) {
  const i = text.indexOf(needle, from);
  if (i < 0) throw new Error(`"${needle}" isn't in the text`);
  return { actor, start: Buffer.byteLength(text.slice(0, i)), end: Buffer.byteLength(text.slice(0, i + needle.length)) };
}

module.exports = {
  startRealServer,
  connectRealServer,
  realServerAvailable,
  skipWithoutServer,
  uuidv7,
  mention,
  portLockFile: lockFile,
  // For the lock's own tests.
  claimPort,
  releasePort,
  INVITE,
  PEPPER,
  // For website/test/browser/harness.mjs, which writes its own copy of the server config: with mail, the stand-in,
  // the entry that sends the Worker's mail to it, and the settings that turn mail on.
  parseJsonc,
  startMailSink,
  writeMailEntry,
  MAIL_KEY,
  MAIL_FROM
};
