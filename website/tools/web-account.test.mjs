// The Rukoo account in the browser (src/web/account/): the shared key vectors through Web Crypto and hash-wasm, the
// Argon2 worker and its client, the HTTP client, and the account service against the in-memory account server of
// the desktop tests and, where server/node_modules is installed, the real one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

// From website/tools, so hash-wasm comes from website/node_modules: the website's CI job installs no root packages.
const require = createRequire(import.meta.url);
const { argon2id } = require('hash-wasm');
const k = require('../../src/web/account/crypto.js');
const { AccountError, serverUrl, createRequest, MAX_BYTES } = require('../../src/web/account/client.js');
const { handle } = require('../../src/web/account/argon2-worker.js');
const { createArgon2 } = require('../../src/web/account/argon2.js');
const { createAccountService, SESSION_KEY, browserDevice, WORKSPACE_VERSIONS } = require('../../src/web/account/service.js');
const { startAccountServer } = require('../../test/fixtures/account-server.js');
const { startRealServer, realServerAvailable, skipWithoutServer } = require('../../test/fixtures/real-server.js');

const vectors = JSON.parse(await readFile(new URL('../../test/fixtures/account-vectors.json', import.meta.url), 'utf8'));
const subtle = globalThis.crypto.subtle;
const keys = k.createKeys({ argon2id, subtle });
const PASSWORD = 'a long enough password';
const FIREFOX = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0';
const utf8 = (text) => new TextEncoder().encode(text);
const sha256 = async (bytes) => new Uint8Array(await subtle.digest('SHA-256', bytes));
const U = `u_${'A'.repeat(22)}`;
const C = (n) => `c_${String(n).padStart(22, 'C')}`;

function memoryStorage() {
  const map = new Map();
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key)
  };
}

function browser(url, options = {}) {
  return createAccountService({ server: url, fetch: globalThis.fetch, storage: memoryStorage(), subtle, argon2: argon2id, userAgent: FIREFOX, ...options });
}

async function fixture(t, options) {
  const s = await startAccountServer(options);
  t.after(() => s.close());
  return s;
}

const routes = (srv) => srv.calls.map((c) => c.route);

test('the keys match the shared vectors in Web Crypto and hash-wasm', async () => {
  const salt = k.unb64u(vectors.salt, 16);
  assert.equal(k.normalizeEmail(vectors.email), vectors.normalizedEmail);
  assert.equal(k.b64u(await keys.masterKey(vectors.password, salt, vectors.kdf)), vectors.masterKey);
  const { authKey, wrapKey } = await keys.passwordKeys(vectors.password, salt, vectors.kdf, vectors.server);
  assert.equal(k.b64u(authKey), vectors.authKey);
  assert.equal(k.b64u(wrapKey), vectors.wrapKey);
  assert.equal(k.b64u(await sha256(authKey)), vectors.authVerifier);
  const dataKey = await keys.unwrapDataKey(wrapKey, k.unb64u(vectors.wrappedKey));
  assert.equal(k.b64u(dataKey), vectors.dataKey);
  assert.equal(k.b64u(await keys.seal(wrapKey, dataKey, 'rukoo/v1/data-key', k.unb64u(vectors.wrapNonce))), vectors.wrappedKey);
  const recovery = k.unb64u(vectors.recoveryKeyBytes, 20);
  assert.equal(k.formatRecoveryKey(recovery), vectors.recoveryKey);
  assert.deepEqual(k.parseRecoveryKey(vectors.recoveryKey), recovery);
  const { recoveryAuth, recoveryWrap } = await keys.recoveryKeys(recovery, vectors.server);
  assert.equal(k.b64u(recoveryAuth), vectors.recoveryAuth);
  assert.equal(k.b64u(recoveryWrap), vectors.recoveryWrap);
  const rk = await keys.recordKeys(dataKey);
  assert.equal(k.b64u(rk.recordKey), vectors.recordKey);
  assert.equal(k.b64u(rk.indexKey), vectors.indexKey);
  assert.equal(await keys.recordId(rk.indexKey, vectors.record.c, vectors.record.k), vectors.recordId);
  assert.deepEqual(await keys.openRecord(rk, vectors.recordId, vectors.recordData), vectors.record);
  assert.deepEqual(await keys.sealRecord(rk, vectors.record, k.unb64u(vectors.recordNonce)), { id: vectors.recordId, data: vectors.recordData });
  assert.equal(await keys.sessionTag('a.token'), k.b64u(await sha256(utf8('a.token'))).slice(0, 22));
});

test('the worker hashes as hash-wasm does and refuses what a sign-in could not ask for', async () => {
  const options = { password: vectors.password.normalize('NFC'), salt: k.unb64u(vectors.salt, 16), parallelism: 1, iterations: 3, memorySize: 65536, hashLength: 32 };
  const reply = await handle({ id: 7, options }, argon2id);
  assert.equal(reply.id, 7);
  assert.equal(k.b64u(reply.hash), vectors.masterKey);
  let called = 0;
  const counting = async (o) => (called++, argon2id(o));
  assert.deepEqual(await handle({ id: 8, options: { ...options, iterations: 1 } }, counting), { id: 8, error: 'kdf' });
  assert.deepEqual(await handle({ id: 9, options: { ...options, memorySize: 1048577 } }, counting), { id: 9, error: 'kdf' });
  assert.deepEqual(await handle({ id: 10, options: { ...options, salt: new Uint8Array(8) } }, counting), { id: 10, error: 'argon2' });
  assert.deepEqual(await handle({ id: 11, options: { ...options, hashLength: 64 } }, counting), { id: 11, error: 'argon2' });
  assert.deepEqual(await handle({ options }, counting), { id: null, error: 'argon2' });
  assert.equal(called, 0, 'nothing refused reaches Argon2');
});

test('the Argon2 client starts its worker at the first hash, answers by id and ends the worker when none waits', async () => {
  const workers = [];
  class FakeWorker {
    constructor(url) {
      this.url = url;
      this.sent = [];
      this.terminated = false;
      workers.push(this);
    }

    postMessage(message) {
      this.sent.push(structuredClone(message));
    }

    terminate() {
      this.terminated = true;
    }

    // Answers what was sent, last first, as the page's worker would through structured cloning.
    async answer() {
      for (const message of this.sent.splice(0).reverse()) this.onmessage({ data: structuredClone(await handle(message, argon2id)) });
    }
  }
  const client = createArgon2({ Worker: FakeWorker });
  assert.equal(workers.length, 0, 'nothing starts before the first hash');
  const kdf = vectors.kdf;
  const viaWorker = k.createKeys({ argon2id: client, subtle });
  const salt = k.unb64u(vectors.salt, 16);
  const first = viaWorker.masterKey(vectors.password, salt, kdf);
  const second = viaWorker.masterKey('another password, long enough', salt, kdf);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(workers.length, 1);
  assert.equal(workers[0].url, 'web/argon2-worker.js');
  await workers[0].answer();
  assert.equal(k.b64u(await first), vectors.masterKey);
  assert.equal(k.b64u(await second), k.b64u(await keys.masterKey('another password, long enough', salt, kdf)));
  assert.equal(workers[0].terminated, true, 'its WebAssembly memory goes with it');

  // A worker that fails to run fails what waits on it; the next hash starts another.
  const failing = client({ password: 'x', salt, parallelism: 1, iterations: 3, memorySize: 65536, hashLength: 32 });
  assert.equal(workers.length, 2);
  workers[1].onerror({ message: 'blocked by CSP', preventDefault() {} });
  await assert.rejects(failing, /argon2: blocked by CSP/);
  assert.equal(workers[1].terminated, true);
  const again = client({ password: 'x', salt, parallelism: 1, iterations: 3, memorySize: 65536, hashLength: 32 });
  assert.equal(workers.length, 3);
  await workers[2].answer();
  assert.equal((await again).length, 32);
  await assert.rejects(createArgon2({ Worker: undefined })({}), /no Worker/);
});

test('a sign-in proof made for one server address is no good at another', async (t) => {
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const a = await keys.passwordKeys(PASSWORD, salt, k.DEFAULT_KDF, 'https://one.example');
  const b = await keys.passwordKeys(PASSWORD, salt, k.DEFAULT_KDF, 'https://two.example');
  assert.notDeepEqual(a.authKey, b.authKey);
  assert.deepEqual(a.wrapKey, b.wrapKey, 'the data key opens the same everywhere');
  const ra = await keys.recoveryKeys(salt, 'https://one.example');
  const rb = await keys.recoveryKeys(salt, 'https://two.example');
  assert.notDeepEqual(ra.recoveryAuth, rb.recoveryAuth);
  assert.deepEqual(ra.recoveryWrap, rb.recoveryWrap);
  await assert.rejects(keys.passwordKeys(PASSWORD, salt, k.DEFAULT_KDF, ''), /server/);

  // The same server under another address, as a page whose origin isn't the account's address would use it.
  const srv = await fixture(t);
  const desk = browser(srv.url);
  const { recoveryKey } = await desk.signUp({ email: 'bound@example.com', password: PASSWORD });
  const other = browser(srv.url.replace('127.0.0.1', 'localhost'));
  await assert.rejects(other.signIn({ email: 'bound@example.com', password: PASSWORD }), { code: 'unauthorized' });
  await assert.rejects(other.recover({ email: 'bound@example.com', recoveryKey, password: 'some new password' }), { code: 'unauthorized' });
  assert.equal(other.status().signedIn, false);
});

test('a sealed record refuses another id, other bytes and another key', async () => {
  const rk = await keys.recordKeys(globalThis.crypto.getRandomValues(new Uint8Array(32)));
  const { id, data } = await keys.sealRecord(rk, { c: 'sender', k: 'a@b.c', v: { category: 'x' }, t: 1 });
  assert.equal((await keys.openRecord(rk, id, data)).k, 'a@b.c');
  const other = await keys.sealRecord(rk, { c: 'sender', k: 'd@e.f', v: null, t: 1 });
  assert.equal(await keys.openRecord(rk, other.id, data), null, 'the server swapped two records');
  const bytes = k.unb64u(data);
  bytes[bytes.length - 1] ^= 1;
  assert.equal(await keys.openRecord(rk, id, k.b64u(bytes)), null, 'a changed tag');
  assert.equal(await keys.openRecord(await keys.recordKeys(globalThis.crypto.getRandomValues(new Uint8Array(32))), id, data), null, 'another account');
  assert.equal(await keys.openRecord(rk, id, 'not base64url!'), null);
  const gone = await keys.sealRecord(rk, { c: 'sender', k: 'a@b.c', v: { left: 'out' }, t: 2, d: true });
  assert.deepEqual(await keys.openRecord(rk, gone.id, gone.data), { c: 'sender', k: 'a@b.c', v: null, t: 2, d: true });
  await assert.rejects(keys.open(rk.recordKey, new Uint8Array(20), 'x'), /sealed/);
  await assert.rejects(keys.unwrapDataKey(rk.recordKey, await keys.seal(rk.recordKey, new Uint8Array(16), 'rukoo/v1/data-key')), /sealed/);
});

test('recovery keys read back however they were copied', () => {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(20));
  const text = k.formatRecoveryKey(bytes);
  assert.match(text, /^([0-9A-HJKMNP-TV-Z]{4}-){7}[0-9A-HJKMNP-TV-Z]{4}$/);
  assert.deepEqual(k.parseRecoveryKey(text), bytes);
  assert.deepEqual(k.parseRecoveryKey(` ${text.toLowerCase().replace(/-/g, ' ')} `), bytes);
  assert.deepEqual(k.parseRecoveryKey('0O1I-L000-0000-0000-0000-0000-0000-0000'), k.parseRecoveryKey('0011-1000-0000-0000-0000-0000-0000-0000'));
  assert.equal(k.parseRecoveryKey('too short'), null);
  assert.equal(k.parseRecoveryKey(`${text}U`), null);
  assert.equal(k.parseRecoveryKey('U'.repeat(32)), null, 'U is not a Crockford digit');
  assert.equal(k.parseRecoveryKey(null), null);
});

test('weak or odd key derivation settings are refused before any hash', async () => {
  assert.throws(() => k.checkKdf({ alg: 'argon2id', m: 1024, t: 3, p: 1 }), /kdf/);
  assert.throws(() => k.checkKdf({ alg: 'argon2id', m: 65536, t: 1, p: 1 }), /kdf/);
  assert.throws(() => k.checkKdf({ alg: 'scrypt', m: 65536, t: 3, p: 1 }), /kdf/);
  assert.throws(() => k.checkKdf({ alg: 'argon2id', m: 65536, t: 3, p: 9 }), /kdf/);
  assert.throws(() => k.checkKdf({ alg: 'argon2id', m: 65536, t: 3, p: 0 }), /kdf/);
  assert.throws(() => k.checkKdf({ alg: 'argon2id', m: 1048577, t: 3, p: 1 }), /kdf/);
  assert.throws(() => k.checkKdf({ alg: 'argon2id', m: 65536, t: 11, p: 1 }), /kdf/);
  assert.throws(() => k.checkKdf({ alg: 'argon2id', m: 65536.5, t: 3, p: 1 }), /kdf/);
  assert.throws(() => k.checkKdf(null), /kdf/);
  assert.deepEqual(k.checkKdf({ alg: 'argon2id', m: 65536, t: 3, p: 1, extra: true }), k.DEFAULT_KDF);
  assert.deepEqual(k.checkKdf({ alg: 'argon2id', m: 19456, t: 2, p: 1 }), { alg: 'argon2id', m: 19456, t: 2, p: 1 });
  assert.deepEqual(k.checkKdf({ alg: 'argon2id', m: 1048576, t: 10, p: 4 }), { alg: 'argon2id', m: 1048576, t: 10, p: 4 });
  let called = 0;
  const counting = k.createKeys({ argon2id: async () => (called++, new Uint8Array(32)), subtle });
  await assert.rejects(counting.masterKey('password', new Uint8Array(16), { ...k.DEFAULT_KDF, t: 1 }), /kdf/);
  assert.equal(called, 0);
});

test('base64url is read strictly and round-trips every length', () => {
  for (let n = 0; n <= 40; n++) {
    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(n));
    const text = k.b64u(bytes);
    assert.equal(text, Buffer.from(bytes).toString('base64url'));
    assert.deepEqual(k.unb64u(text), bytes);
  }
  assert.throws(() => k.unb64u('ab+/'), /invalid base64url/);
  assert.throws(() => k.unb64u('abcd='), /invalid base64url/);
  assert.throws(() => k.unb64u('abcde'), /invalid base64url/);
  assert.throws(() => k.unb64u(42), /invalid base64url/);
  assert.throws(() => k.unb64u(vectors.salt, 15), /invalid length/);
});

test('only https servers, or http on this computer', () => {
  assert.equal(serverUrl('https://sync.example.com/'), 'https://sync.example.com');
  assert.equal(serverUrl('https://example.com/rukoo/'), 'https://example.com/rukoo');
  assert.equal(serverUrl('https://Rukoo.IO'), 'https://rukoo.io');
  assert.equal(serverUrl('http://127.0.0.1:8787'), 'http://127.0.0.1:8787');
  assert.equal(serverUrl('http://localhost:8787/'), 'http://localhost:8787');
  assert.equal(serverUrl('http://sync.example.com'), null);
  assert.equal(serverUrl('https://user:pw@example.com'), null);
  assert.equal(serverUrl('https://example.com/?a=1'), null);
  assert.equal(serverUrl('ftp://example.com'), null);
  assert.equal(serverUrl('nonsense'), null);
  assert.equal(createAccountService({ server: 'http://rukoo.example', fetch, subtle, argon2: argon2id }).status().server, '');
});

test('signing up posts first, sends no password, keeps neither password nor data key, then gives the recovery key', async (t) => {
  const srv = await fixture(t);
  const storage = memoryStorage();
  const desk = browser(srv.url, { storage });
  const statuses = [];
  desk.on('status', (s) => statuses.push(s));
  await desk.init();
  await desk.infoLoad;
  assert.equal(desk.status().info.signups, 'open');
  srv.calls.length = 0;
  const res = await desk.accountSignUp({ email: '  New@Example.com ', password: PASSWORD });
  assert.deepEqual(routes(srv), ['GET /v1/info', 'POST /v1/signup']);
  assert.match(res.recoveryKey, /^([0-9A-HJKMNP-TV-Z]{4}-){7}[0-9A-HJKMNP-TV-Z]{4}$/);
  assert.equal(res.account.email, 'new@example.com');
  const sent = srv.calls[1].body;
  assert.equal(JSON.stringify(srv.calls).includes(PASSWORD), false, 'the password never leaves');
  assert.deepEqual(sent.kdf, k.DEFAULT_KDF);
  assert.deepEqual(sent.device, { name: 'Firefox · Windows', platform: 'web' });
  assert.equal('invite' in sent, false);

  // Both the password and the printed recovery key open the same data key the server keeps wrapped.
  const acc = srv.accounts.get('new@example.com');
  const { wrapKey } = await keys.passwordKeys(PASSWORD, k.unb64u(acc.salt, 16), acc.kdf, srv.url);
  const { recoveryWrap } = await keys.recoveryKeys(k.parseRecoveryKey(res.recoveryKey), srv.url);
  assert.deepEqual(await keys.unwrapDataKey(wrapKey, k.unb64u(acc.wrappedKey)), await keys.unwrapDataKey(recoveryWrap, k.unb64u(acc.recoveryWrappedKey)));

  const status = desk.status();
  assert.equal(status.signedIn, true);
  assert.equal(status.email, 'new@example.com');
  assert.equal(status.server, srv.url);
  assert.equal(statuses.at(-1).signedIn, true);
  const stored = JSON.parse(storage.map.get(SESSION_KEY));
  assert.deepEqual(Object.keys(stored).sort(), ['at', 'email', 'server', 'token', 'v']);
  assert.equal(stored.v, 1);
  assert.equal(stored.server, srv.url);
  assert.equal(stored.email, 'new@example.com');
  assert.ok(srv.sessions.has(stored.token));
  assert.equal(storage.map.size, 1, 'nothing else is kept');
  assert.equal(desk.sessionTag, k.b64u(await sha256(utf8(stored.token))).slice(0, 22));
  await assert.rejects(desk.signUp({ email: 'again@example.com', password: PASSWORD }), { code: 'signed_in' });
});

test('sign-up checks the address and the password length first', async (t) => {
  const srv = await fixture(t);
  const desk = browser(srv.url);
  await assert.rejects(desk.signUp({ email: 'not an address', password: PASSWORD }), { code: 'invalid_email', message: 'invalid_email' });
  await assert.rejects(desk.signUp({ email: 'e@example.com', password: 'short' }), { code: 'weak_password' });
  // Twelve code points, not twelve UTF-16 units: eleven emoji are 22 units.
  await assert.rejects(desk.signUp({ email: 'e@example.com', password: '\u{1F600}'.repeat(11) }), { code: 'weak_password' });
  await assert.rejects(desk.accountSignUp({ email: 42, password: PASSWORD }), { code: 'invalid_email' });
  await assert.rejects(desk.signIn({ email: 'e@example.com', password: '' }), { code: 'unauthorized' });
  await assert.rejects(desk.recover({ email: 'e@example.com', recoveryKey: 'nope', password: PASSWORD }), { code: 'recovery_key' });
  assert.equal(srv.calls.length, 0);
  const none = createAccountService({ server: '', fetch, subtle, argon2: argon2id });
  await assert.rejects(none.signUp({ email: 'o@example.com', password: PASSWORD }), { code: 'no_server' });
  await assert.rejects(none.serverInfo(), { code: 'no_server' });
});

test('invite-only and closed servers say so, and a workspace invitation goes instead of an invite code', async (t) => {
  const invite = await fixture(t, { signups: 'invite', invites: ['WELCOME'] });
  const a = browser(invite.url);
  await assert.rejects(a.signUp({ email: 'g@example.com', password: PASSWORD }), { code: 'invite_required', status: 403 });
  await a.accountSignUp({ email: 'g@example.com', password: PASSWORD, invite: ' WELCOME ' });
  assert.equal(a.status().signedIn, true);
  const closed = await fixture(t, { signups: 'closed' });
  await assert.rejects(browser(closed.url).signUp({ email: 'h@example.com', password: PASSWORD }), { code: 'signups_closed' });

  const open = await fixture(t);
  const workspaceInvite = { workspace: `w_${'A'.repeat(22)}`, invite: 'B'.repeat(43) };
  await browser(open.url).accountSignUp({ email: 'joiner@example.com', password: PASSWORD, invite: 'a-code', workspaceInvite });
  await browser(open.url).accountSignUp({ email: 'coder@example.com', password: PASSWORD, invite: ' a-code ', workspaceInvite: { workspace: 1 } });
  const [linked, coded] = open.calls.filter((c) => c.route === 'POST /v1/signup').map((c) => c.body);
  assert.deepEqual(linked.workspaceInvite, workspaceInvite);
  assert.equal('invite' in linked, false);
  assert.equal(coded.invite, 'a-code');
  assert.equal('workspaceInvite' in coded, false);
  await assert.rejects(browser(open.url).signUp({ email: 'joiner@example.com', password: PASSWORD }), { code: 'exists' });
});

test('a second browser signs in; a wrong password or an unknown address does not', async (t) => {
  const srv = await fixture(t);
  await browser(srv.url).signUp({ email: 'd@example.com', password: PASSWORD });
  const laptop = browser(srv.url, { userAgent: 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36' });
  await assert.rejects(laptop.signIn({ email: 'd@example.com', password: 'not the password!' }), { code: 'unauthorized', status: 401 });
  await assert.rejects(laptop.signIn({ email: 'nobody@example.com', password: PASSWORD }), { code: 'unauthorized' });
  assert.equal(laptop.status().signedIn, false);
  await laptop.init();
  await laptop.infoLoad;
  srv.calls.length = 0;
  const { account } = await laptop.accountSignIn({ email: ' D@example.com', password: PASSWORD });
  assert.deepEqual(routes(srv), ['GET /v1/info', 'POST /v1/prelogin', 'POST /v1/login']);
  assert.equal(account.email, 'd@example.com');
  assert.deepEqual(srv.calls[2].body.device, { name: 'Chrome · Android', platform: 'web' });
  assert.equal(laptop.status().email, 'd@example.com');
  const me = account.devices.find((d) => d.current);
  assert.equal(me.platform, 'web');
});

test('a server that hands out a weak password hash, or a data key that does not open, gets no sign-in', async (t) => {
  const weak = await fixture(t, { kdf: { alg: 'argon2id', m: 1024, t: 1, p: 1 } });
  await assert.rejects(browser(weak.url).signIn({ email: 'f@example.com', password: PASSWORD }), { code: 'weak_kdf' });
  assert.equal(weak.calls.some((c) => c.route === 'POST /v1/login'), false);

  const srv = await fixture(t);
  await browser(srv.url).signUp({ email: 'w@example.com', password: PASSWORD });
  const acc = srv.accounts.get('w@example.com');
  const bytes = k.unb64u(acc.wrappedKey);
  bytes[bytes.length - 1] ^= 1;
  acc.wrappedKey = k.b64u(bytes);
  const before = srv.sessions.size;
  const other = browser(srv.url);
  await assert.rejects(other.signIn({ email: 'w@example.com', password: PASSWORD }), { code: 'server' });
  assert.equal(other.status().signedIn, false);
  // The session the server made for it is ended there.
  for (let i = 0; i < 50 && srv.sessions.size !== before; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(srv.sessions.size, before);
});

test('the stored session comes back after a reload, and signing out ends it on the server and here', async (t) => {
  const srv = await fixture(t);
  const storage = memoryStorage();
  const first = browser(srv.url, { storage });
  await first.signUp({ email: 'r@example.com', password: PASSWORD });
  const tag = first.sessionTag;
  const token = JSON.parse(storage.map.get(SESSION_KEY)).token;

  srv.calls.length = 0;
  const reloaded = browser(srv.url, { storage });
  assert.equal(reloaded.status().signedIn, false, 'not before init()');
  await reloaded.init();
  assert.equal(reloaded.status().signedIn, true);
  assert.equal(reloaded.status().email, 'r@example.com');
  assert.equal(reloaded.sessionTag, tag);
  await reloaded.infoLoad;
  assert.deepEqual(routes(srv), ['GET /v1/info'], 'no sign-in again');
  assert.equal((await reloaded.accountDetails()).email, 'r@example.com');

  const statuses = [];
  reloaded.on('status', (s) => statuses.push(s));
  const out = await reloaded.accountSignOut();
  assert.equal(out.signedIn, false);
  assert.equal(out.error, null);
  assert.equal(reloaded.sessionTag, null);
  assert.equal(storage.map.has(SESSION_KEY), false);
  assert.equal(srv.sessions.has(token), false, 'POST /v1/logout went out');
  assert.equal(statuses.at(-1).signedIn, false);
  assert.equal((await reloaded.signOut()).signedIn, false);
  await assert.rejects(reloaded.accountDetails(), { code: 'signed_out' });

  // A stored session for another server, or one damaged, is no session here.
  storage.map.set(SESSION_KEY, JSON.stringify({ v: 1, server: 'https://elsewhere.example', email: 'r@example.com', token, at: 1 }));
  const elsewhere = browser(srv.url, { storage });
  await elsewhere.init();
  assert.equal(elsewhere.status().signedIn, false);
  storage.map.set(SESSION_KEY, '{not json');
  const damaged = browser(srv.url, { storage });
  await damaged.init();
  assert.equal(damaged.status().signedIn, false);
});

test('a 401 ends the session, also from the workspace routes, which keep the server\'s own codes otherwise', async (t) => {
  const srv = await fixture(t);
  const storage = memoryStorage();
  const desk = browser(srv.url, { storage, t: (key) => `text of ${key}` });
  await assert.rejects(desk.workspaceCall('GET', '/v1/workspaces'), { code: 'signed_out' });
  await desk.signUp({ email: 'chat@example.com', password: PASSWORD });
  const post = 'POST /v1/workspaces/w_1/conversations/c_1/messages';
  srv.fail = ({ route }) => (route === post ? [409, { error: 'stale_grant', message: 'Check it first.', scope: 'conversation' }] : null);
  await assert.rejects(desk.workspaceCall('POST', '/v1/workspaces/w_1/conversations/c_1/messages', { text: 'hi' }), (err) => {
    assert.ok(err instanceof AccountError);
    assert.equal(err.code, 'stale_grant');
    assert.equal(err.status, 409);
    assert.equal(err.message, 'Check it first.');
    assert.deepEqual(err.details, { scope: 'conversation' });
    return true;
  });
  // Through call() the same answer is one of the account's own codes.
  await assert.rejects(desk.call('POST', '/v1/workspaces/w_1/conversations/c_1/messages', {}, { auth: true }), { code: 'server', status: 409 });
  assert.ok(srv.calls.some((c) => c.route === post && c.body.text === 'hi'));

  // A 401 from a workspace route ends the session, as from every other route. (The in-memory server has no workspace
  // routes, so it is told to answer one; the real server's test below has the device removed instead.)
  srv.fail = ({ route }) => (route === 'GET /v1/workspaces' ? [401, { error: 'unauthorized', scope: 'account' }] : null);
  const statuses = [];
  desk.on('status', (s) => statuses.push(s));
  await assert.rejects(desk.workspaceCall('GET', '/v1/workspaces'), { code: 'signed_out', status: 401 });
  srv.fail = null;
  assert.equal(desk.status().signedIn, false);
  assert.equal(desk.status().error, 'signed_out');
  assert.equal(desk.status().errorText, 'text of account.errors.signed_out');
  assert.equal(desk.sessionTag, null);
  assert.equal(storage.map.has(SESSION_KEY), false);
  assert.equal(statuses.length, 1);
  assert.equal(statuses[0].signedIn, false);
  // A sign-in clears the error.
  await desk.signIn({ email: 'chat@example.com', password: PASSWORD });
  assert.equal(desk.status().error, null);
});

test('the workspace routes go in the newest protocol version both the page and the server list, else 1', async (t) => {
  const srv = await fixture(t);
  const seen = [];
  const desk = browser(srv.url, {
    fetch: (input, init) => {
      seen.push({ url: String(input), headers: { ...((init && init.headers) || {}) } });
      return globalThis.fetch(input, init);
    }
  });
  await desk.signUp({ email: 'versions@example.com', password: PASSWORD });
  // GET /v1/info as the server answers it, with the workspace versions it lists; the workspace list answers empty (the
  // in-memory server has no workspace routes).
  let versions = null;
  srv.fail = ({ route }) => {
    if (route === 'GET /v1/info') return [200, { protocol: 1, signups: 'open', features: ['workspaces-v1'], ...(versions ? { workspace: { versions } } : {}) }];
    if (route === 'GET /v1/workspaces') return [200, { workspaces: [] }];
    return null;
  };
  const header = async () => {
    await desk.workspaceCall('GET', '/v1/workspaces');
    return seen.filter((r) => r.url.endsWith('/v1/workspaces')).at(-1).headers['rukoo-workspace-version'];
  };
  // Before the server said anything: version 1, which every server reads.
  assert.equal(await header(), '1');
  assert.deepEqual(WORKSPACE_VERSIONS, [1, 2]);
  for (const [listed, expected] of [
    [[1, 2], '2'],
    [[1], '1'],
    [[2, 3], '2'],
    [[3], '1'],
    [null, '1']
  ]) {
    versions = listed;
    await desk.serverInfo();
    assert.equal(await header(), expected, `the server lists ${JSON.stringify(listed)}`);
  }
  // The info of another server says nothing about this one's.
  versions = [1, 2];
  await desk.serverInfo();
  assert.equal(desk.workspaceVersion('https://elsewhere.example'), 1);
  assert.equal(desk.workspaceVersion(srv.url), 2);
  srv.fail = null;
});

test('a request sends only the workspace protocol header, and an error answer keeps its details and Retry-After', async () => {
  const seen = [];
  let next = null;
  const scripted = async (url, init) => {
    seen.push({ url, init });
    const [status, headers, body] = next;
    return new Response(body === undefined ? null : JSON.stringify(body), { status, headers });
  };
  const now = Date.parse('2026-11-20T12:00:00Z');
  const request = createRequest({ fetch: scripted, now: () => now });
  next = [200, {}, { ok: true }];
  assert.deepEqual(
    await request('https://rukoo.example', 'GET', '/v1/workspaces', {
      token: 'the-token',
      headers: { 'rukoo-workspace-version': '1', authorization: 'Bearer someone-else', 'x-other': 'yes' }
    }),
    { ok: true }
  );
  const first = seen[0];
  assert.equal(first.url, 'https://rukoo.example/v1/workspaces');
  assert.deepEqual(first.init.headers, { accept: 'application/json', 'rukoo-workspace-version': '1', authorization: 'Bearer the-token' });
  assert.equal(first.init.credentials, 'omit');
  assert.equal(first.init.redirect, 'manual');
  assert.equal(first.init.cache, 'no-store');
  assert.ok(first.init.signal instanceof AbortSignal);
  assert.equal('keepalive' in first.init, false, 'a request ends with the page unless asked');
  // keepalive: a request the page sends as it goes away (src/web/host.js releaseStaged).
  next = [204, {}, undefined];
  await request('https://rukoo.example', 'DELETE', '/v1/workspaces/w_1/conversations/c_1/uploads/f_1', { token: 'the-token', keepalive: true });
  assert.equal(seen.at(-1).init.keepalive, true);
  next = [201, {}, {}];
  await request('https://rukoo.example', 'POST', '/v1/signup', { body: { email: 'x' }, headers: { 'rukoo-workspace-version': 'a b' } });
  assert.deepEqual(seen.at(-1).init.headers, { accept: 'application/json', 'content-type': 'application/json' });
  assert.equal(seen.at(-1).init.body, '{"email":"x"}');

  const fails = async (status, headers, body) => {
    next = [status, headers, body];
    return request('https://rukoo.example', 'POST', '/v1/workspaces/w/dms', { body: {} }).then(
      () => assert.fail('the request should fail'),
      (err) => err
    );
  };
  let err = await fails(429, { 'retry-after': '7' }, {
    error: 'rate_limited',
    field: 'members',
    scope: 'workspace',
    limit: 'dailyDms',
    member: U,
    channels: [C(1), 'not-a-channel', C(2)],
    minVersion: 2
  });
  assert.ok(err instanceof AccountError);
  assert.equal(err.code, 'rate_limited');
  assert.equal(err.status, 429);
  assert.deepEqual(err.details, { field: 'members', scope: 'workspace', minVersion: 2, channels: [C(1), C(2)], member: U, limit: 'dailyDms', retryAfter: 7 });
  assert.equal((await fails(429, { 'retry-after': '0' }, { error: 'rate_limited' })).details.retryAfter, 1);
  assert.equal((await fails(429, { 'retry-after': '99999' }, { error: 'rate_limited' })).details.retryAfter, 3600);
  assert.equal((await fails(503, { 'retry-after': new Date(now + 30000).toUTCString() }, { error: 'server' })).details.retryAfter, 30);
  assert.equal((await fails(429, { 'retry-after': 'soon' }, { error: 'rate_limited' })).details, null);
  err = await fails(409, {}, { error: 'last_manager', channels: Array.from({ length: 150 }, (_, i) => C(i)) });
  assert.equal(err.details.channels.length, 100);
  err = await fails(403, {}, { error: 'forbidden', scope: 'everything', member: 'nobody', limit: 'x'.repeat(41), minVersion: -1 });
  assert.equal(err.details, null);
  err = await fails(500, {}, undefined);
  assert.equal(err.code, 'server');
  assert.equal(err.status, 500);
  err = await fails(502, { 'content-type': 'text/html' }, '<html>');
  assert.equal(err.code, 'server');
  err = await fails(302, { location: '/elsewhere' }, undefined);
  assert.equal(err.code, 'server');
  assert.equal(err.status, 302);
});

test('an answer past 32 MiB is refused, one that never comes times out, and a lost connection reads as network', async () => {
  let pulls = 0;
  const huge = () =>
    new ReadableStream({
      pull(controller) {
        pulls++;
        controller.enqueue(new Uint8Array(1024 * 1024));
        if (pulls > 64) controller.close();
      }
    });
  const big = createRequest({ fetch: async () => new Response(huge(), { status: 200 }) });
  await assert.rejects(big('https://rukoo.example', 'GET', '/v1/account'), { code: 'too_large', status: 200 });
  assert.ok(pulls <= MAX_BYTES / (1024 * 1024) + 3, `stopped reading after ${pulls} MiB`);
  const declared = createRequest({ fetch: async () => new Response('{}', { status: 200, headers: { 'content-length': String(MAX_BYTES + 1) } }) });
  await assert.rejects(declared('https://rukoo.example', 'GET', '/v1/account'), { code: 'too_large' });
  const small = createRequest({ fetch: async () => new Response('x'.repeat(2000), { status: 400 }), maxBytes: 1000 });
  await assert.rejects(small('https://rukoo.example', 'GET', '/v1/account'), { code: 'too_large', status: 400 });

  let aborted = null;
  const silent = (url, init) =>
    new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => {
        aborted = Date.now();
        reject(init.signal.reason);
      });
    });
  const started = Date.now();
  await assert.rejects(createRequest({ fetch: silent, timeout: 50 })('https://rukoo.example', 'GET', '/v1/info'), { code: 'network', status: 0, message: 'timeout' });
  assert.ok(aborted - started >= 40);
  // A body that stops coming is cut off by the same timeout.
  const stalled = (url, init) =>
    Promise.resolve(
      new Response(
        new ReadableStream({
          start(controller) {
            init.signal.addEventListener('abort', () => controller.error(init.signal.reason));
          }
        }),
        { status: 200 }
      )
    );
  await assert.rejects(createRequest({ fetch: stalled, timeout: 50 })('https://rukoo.example', 'GET', '/v1/info'), { code: 'network' });
  await assert.rejects(createRequest({ fetch: async () => Promise.reject(new TypeError('Failed to fetch')) })('https://rukoo.example', 'GET', '/v1/info'), {
    code: 'network',
    message: 'Failed to fetch'
  });
  // Unreachable, the page stays usable signed out; the account says why.
  const offline = createAccountService({ server: 'https://rukoo.example', fetch: async () => Promise.reject(new TypeError('offline')), subtle, argon2: argon2id });
  await offline.init();
  assert.equal(await offline.infoLoad, null);
  assert.equal(offline.status().info, null);
  await assert.rejects(offline.accountSignIn({ email: 'a@example.com', password: PASSWORD }), { code: 'network' });
});

test('recovery sets a new password; the old one and a wrong key stop working', async (t) => {
  const srv = await fixture(t);
  const { recoveryKey } = await browser(srv.url).signUp({ email: 'lost@example.com', password: PASSWORD });
  const fresh = browser(srv.url);
  const wrong = k.formatRecoveryKey(globalThis.crypto.getRandomValues(new Uint8Array(20)));
  await assert.rejects(fresh.recover({ email: 'lost@example.com', recoveryKey: wrong, password: 'a new password, long' }), { code: 'unauthorized' });
  await fresh.init();
  await fresh.infoLoad;
  srv.calls.length = 0;
  const copied = recoveryKey.toLowerCase().replace(/-/g, ' ');
  const { account } = await fresh.accountRecover({ email: 'lost@example.com', recoveryKey: copied, password: 'a new password, long' });
  assert.equal(account.email, 'lost@example.com');
  assert.deepEqual(routes(srv), ['GET /v1/info', 'POST /v1/recover/start', 'POST /v1/recover/finish']);
  assert.equal(JSON.stringify(srv.calls).includes('a new password, long'), false);
  assert.equal(fresh.status().signedIn, true);
  await assert.rejects(browser(srv.url).signIn({ email: 'lost@example.com', password: PASSWORD }), { code: 'unauthorized' });
  await browser(srv.url).signIn({ email: 'lost@example.com', password: 'a new password, long' });
  // The data key is the one the recovery key wrapped: the new password opens it too.
  const acc = srv.accounts.get('lost@example.com');
  const { wrapKey } = await keys.passwordKeys('a new password, long', k.unb64u(acc.salt, 16), acc.kdf, srv.url);
  const { recoveryWrap } = await keys.recoveryKeys(k.parseRecoveryKey(recoveryKey), srv.url);
  assert.deepEqual(await keys.unwrapDataKey(wrapKey, k.unb64u(acc.wrappedKey)), await keys.unwrapDataKey(recoveryWrap, k.unb64u(acc.recoveryWrappedKey)));
});

test('a device removed elsewhere is signed out; deleting the account needs the password and sends no handle key', async (t) => {
  const srv = await fixture(t);
  const storage = memoryStorage();
  const desk = browser(srv.url, { storage });
  await desk.signUp({ email: 'gone@example.com', password: PASSWORD });
  const other = browser(srv.url);
  await other.signIn({ email: 'gone@example.com', password: PASSWORD });
  const listed = (await other.accountDetails()).devices;
  assert.deepEqual(listed.map((d) => d.platform), ['web', 'web']);
  assert.equal(await other.accountRemoveDevice(listed.find((d) => !d.current).id), true);
  await assert.rejects(desk.accountDetails(), { code: 'signed_out', status: 401 });
  assert.equal(desk.status().error, 'signed_out');
  assert.equal(storage.map.has(SESSION_KEY), false);
  await desk.signIn({ email: 'gone@example.com', password: PASSWORD });
  await other.signOut();

  await assert.rejects(desk.accountDelete('not the password'), { code: 'wrong_password', status: 403 });
  assert.equal(desk.status().signedIn, true, 'a typo signs nothing out');
  await assert.rejects(desk.deleteAccount(''), { code: 'wrong_password' });
  const out = await desk.accountDelete(PASSWORD);
  assert.equal(out.signedIn, false);
  assert.equal(out.error, null);
  assert.equal(srv.accounts.has('gone@example.com'), false);
  assert.equal(storage.map.has(SESSION_KEY), false);
  const deletion = srv.calls.find((c) => c.route === 'DELETE /v1/account');
  assert.deepEqual(Object.keys(deletion.body), ['authKey']);
  await assert.rejects(desk.accountDelete(PASSWORD), { code: 'signed_out' });
  await assert.rejects(desk.accountRemoveDevice('x'), { code: 'signed_out' });
});

test('another tab\'s sign-in and sign-out reach this one through storage', async (t) => {
  const srv = await fixture(t);
  const storage = memoryStorage();
  const a = browser(srv.url, { storage });
  const b = browser(srv.url, { storage });
  await a.init();
  await b.init();
  await a.signUp({ email: 'tabs@example.com', password: PASSWORD });
  const statuses = [];
  b.on('status', (s) => statuses.push(s));
  await b.storageChanged();
  assert.equal(b.status().signedIn, true);
  assert.equal(b.status().email, 'tabs@example.com');
  assert.equal(b.sessionTag, a.sessionTag);
  await b.storageChanged();
  assert.equal(statuses.length, 1, 'nothing new, nothing said');
  srv.calls.length = 0;
  await a.signOut();
  await b.storageChanged();
  assert.equal(b.status().signedIn, false);
  assert.equal(statuses.at(-1).signedIn, false);
  assert.deepEqual(routes(srv), ['POST /v1/logout'], 'only the tab that signed out told the server');
  await b.storageChanged();
  assert.equal(statuses.length, 2);

  // A tab whose old session ends leaves the session another tab stored since.
  await a.signIn({ email: 'tabs@example.com', password: PASSWORD });
  const oldToken = JSON.parse(storage.map.get(SESSION_KEY)).token;
  const c = browser(srv.url, { storage: memoryStorage() });
  await c.signIn({ email: 'tabs@example.com', password: PASSWORD });
  const replaced = { ...JSON.parse(storage.map.get(SESSION_KEY)), token: JSON.parse(c.store.get(SESSION_KEY)).token };
  storage.map.set(SESSION_KEY, JSON.stringify(replaced));
  srv.sessions.delete(oldToken);
  await assert.rejects(a.details(), { code: 'signed_out' });
  assert.equal(a.status().signedIn, false);
  assert.equal(JSON.parse(storage.map.get(SESSION_KEY)).token, replaced.token);
});

test('storage that refuses everything keeps the session for as long as the page is open', async (t) => {
  const srv = await fixture(t);
  const broken = {
    getItem() {
      throw new Error('SecurityError');
    },
    setItem() {
      throw new Error('QuotaExceededError');
    },
    removeItem() {
      throw new Error('SecurityError');
    }
  };
  const desk = browser(srv.url, { storage: broken });
  await desk.init();
  await desk.signUp({ email: 'private@example.com', password: PASSWORD });
  assert.equal(desk.status().signedIn, true);
  assert.ok(desk.store.get(SESSION_KEY), 'kept in memory');
  await desk.signOut();
  assert.equal(desk.store.get(SESSION_KEY), null);
  const reloaded = browser(srv.url, { storage: broken });
  await reloaded.init();
  assert.equal(reloaded.status().signedIn, false);
  const without = browser(srv.url, { storage: undefined });
  await without.signUp({ email: 'nostorage@example.com', password: PASSWORD });
  assert.equal(without.status().signedIn, true);
});

test('the device is named after the browser and its system', () => {
  const chrome = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
  assert.equal(browserDevice(chrome), 'Chrome · Windows');
  assert.equal(browserDevice(`${chrome} Edg/140.0.0.0`), 'Edge · Windows');
  assert.equal(browserDevice('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15'), 'Safari · macOS');
  assert.equal(browserDevice('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0 Mobile/15E148 Safari/604.1'), 'Chrome · iOS');
  assert.equal(browserDevice(FIREFOX), 'Firefox · Windows');
  assert.equal(browserDevice(''), 'Browser');
  assert.equal(createAccountService({ server: 'https://rukoo.example', fetch, subtle, argon2: argon2id, deviceName: 'x'.repeat(200) }).device().name.length, 100);
});

// ---- the real account server (server/src in the local Workers runtime) ----

let real = null;
test.before(async () => {
  if (realServerAvailable()) real = await startRealServer();
});
test.after(() => real?.close());

test('the real server: a workspace invitation signs up, joins, lists the workspace, and a removed device is signed out', async (t) => {
  if (skipWithoutServer(t)) return;
  const olga = await real.seedAccount();
  const ws = await real.seedWorkspace(olga, { name: 'Acme', displayName: 'Olga Owner' });
  const invitation = await real.createInvite(olga, ws.id);

  const storage = memoryStorage();
  const web = browser(real.url, { storage });
  const infos = [];
  web.on('info', (i) => infos.push(i));
  await web.init();
  await web.infoLoad;
  const info = web.status().info;
  assert.ok(info.features.includes('workspaces-v1'));
  assert.equal(info.signups, 'invite');
  assert.equal(infos.length, 1);

  // No invite code: the invitation stands in for one on an invite-only server.
  const email = `web-${Date.now()}@example.com`;
  const { recoveryKey, account } = await web.accountSignUp({ email, password: PASSWORD, workspaceInvite: { workspace: ws.id, invite: invitation.secret } });
  assert.equal(account.email, email);
  assert.match(web.sessionTag, /^[A-Za-z0-9_-]{22}$/);
  const joined = await web.workspaceCall('POST', `/v1/workspaces/${ws.id}/join`, { invite: invitation.secret, name: 'Web Person' });
  assert.equal(joined.workspace.id, ws.id);
  const list = await web.workspaceCall('GET', '/v1/workspaces');
  assert.deepEqual(list.workspaces.map((w) => w.id), [ws.id]);
  // A refusal keeps the server's own code and its scope, which the engine acts on.
  await assert.rejects(web.workspaceCall('GET', `/v1/workspaces/w_${'Z'.repeat(22)}`), (err) => {
    assert.ok(err instanceof AccountError);
    assert.equal(err.code, 'not_found');
    assert.equal(err.status, 404);
    assert.equal(err.details && err.details.scope, 'workspace');
    return true;
  });

  // Signing out and in again, then a new password with the recovery key.
  await web.signOut();
  assert.equal(storage.map.has(SESSION_KEY), false);
  await web.signIn({ email, password: PASSWORD });
  assert.equal(web.status().signedIn, true);
  await web.signOut();
  await web.recover({ email, recoveryKey, password: 'a new password, long' });
  await assert.rejects(browser(real.url).signIn({ email, password: PASSWORD }), { code: 'unauthorized' });

  // Removed from another browser: the next workspace call finds the session ended, and the stored one is gone.
  const other = browser(real.url);
  await other.signIn({ email, password: 'a new password, long' });
  const devices = (await other.accountDetails()).devices;
  assert.equal(devices.length, 2);
  assert.ok(devices.every((d) => d.platform === 'web'));
  await other.accountRemoveDevice(devices.find((d) => !d.current).id);
  await assert.rejects(web.workspaceCall('GET', '/v1/workspaces'), { code: 'signed_out', status: 401 });
  assert.equal(web.status().signedIn, false);
  assert.equal(web.status().error, 'signed_out');
  assert.equal(storage.map.has(SESSION_KEY), false);

  await assert.rejects(other.accountDelete('not the password'), { code: 'wrong_password' });
  assert.equal((await other.accountDelete('a new password, long')).signedIn, false);
  await assert.rejects(browser(real.url).signIn({ email, password: 'a new password, long' }), { code: 'unauthorized' });
});

// ---- codes by email (src/web/account/service.js requestCode, as desktop's src/main/account/index.js) ----

test('codes by email: a sign-up on a server that checks addresses asks for one; the long code works where six digits do not', async (t) => {
  const srv = await fixture(t, { signups: 'verified', codes: true, invites: ['welcome'] });
  const web = browser(srv.url, { language: () => 'nl' });
  await assert.rejects(web.accountSignUp({ email: 'New@Example.com', password: PASSWORD }), { code: 'code_required' });
  assert.equal(routes(srv).includes('POST /v1/signup'), false, 'stopped before the password keys');
  assert.deepEqual(await web.accountEmailCode({ email: 'New@Example.com', purpose: 'signup' }), { email: 'new@example.com', expiresIn: 600 });
  assert.equal(srv.calls.find((c) => c.route === 'POST /v1/email-code').body.lang, 'nl');
  const code = srv.codeFor('new@example.com');
  await assert.rejects(web.accountSignUp({ email: 'new@example.com', password: PASSWORD, emailCode: code === '000000' ? '111111' : '000000' }), (err) => {
    assert.equal(err.code, 'code_wrong');
    assert.equal(err.details.attemptsLeft, 4);
    return true;
  });
  // Another browser has no challenge for the six digits, and can't read the code as anything else.
  const other = browser(srv.url);
  await assert.rejects(other.accountSignUp({ email: 'new@example.com', password: PASSWORD, emailCode: code }), { code: 'code_expired' });
  await assert.rejects(other.accountSignUp({ email: 'new@example.com', password: PASSWORD, emailCode: 'abc' }), { code: 'code_format' });
  await other.accountSignUp({ email: 'new@example.com', password: PASSWORD, emailCode: srv.tokenFor('new@example.com') });
  assert.equal(other.status().signedIn, true);
  // Both codes in an email are one: the six digits went with the long code.
  await assert.rejects(web.accountSignUp({ email: 'new@example.com', password: PASSWORD, emailCode: code }), { code: 'code_expired' });
  // The operator's invite code needs none.
  const invited = browser(srv.url);
  await invited.accountSignUp({ email: 'invited@example.com', password: PASSWORD, invite: 'welcome' });
  assert.equal(invited.status().signedIn, true);
});

test('codes by email: a locked account signs in and recovers with an unlock code; a second code waits a minute', async (t) => {
  const srv = await fixture(t, { signups: 'open', codes: true });
  const first = browser(srv.url);
  const { recoveryKey } = await first.accountSignUp({ email: 'locked@example.com', password: PASSWORD });
  await first.signOut();
  srv.lock('locked@example.com');
  const web = browser(srv.url);
  await assert.rejects(web.accountSignIn({ email: 'locked@example.com', password: PASSWORD }), { code: 'locked' });
  await web.accountEmailCode({ email: 'locked@example.com', purpose: 'unlock' });
  await assert.rejects(web.accountEmailCode({ email: 'locked@example.com', purpose: 'unlock' }), (err) => {
    assert.equal(err.code, 'rate_limited');
    assert.ok(err.details.retryAfter >= 1 && err.details.retryAfter <= 60);
    return true;
  });
  const code = srv.codeFor('locked@example.com');
  await assert.rejects(web.accountSignIn({ email: 'locked@example.com', password: 'not the password at all', emailCode: code }), { code: 'unauthorized' });
  await web.accountSignIn({ email: 'locked@example.com', password: PASSWORD, emailCode: code });
  assert.equal(web.status().signedIn, true);
  await web.signOut();

  srv.allowCode('locked@example.com', 'unlock');
  await web.accountEmailCode({ email: 'locked@example.com', purpose: 'unlock' });
  const token = srv.tokenFor('locked@example.com');
  await web.accountRecover({ email: 'locked@example.com', recoveryKey, password: 'a brand new password', emailCode: token });
  assert.equal(web.status().signedIn, true);
  const finish = srv.calls.filter((c) => c.route === 'POST /v1/recover/finish').at(-1).body;
  assert.deepEqual(finish.emailCode, { token });
});

test('codes by email on the real server: a sign-up with a workspace invitation needs the code, and an unlock code gets past the lock', async (t) => {
  if (skipWithoutServer(t)) return;
  const verified = await startRealServer({ vars: { SIGNUPS: 'verified' }, mail: true });
  t.after(() => verified.close());
  const olga = await verified.seedAccount();
  const ws = await verified.seedWorkspace(olga, { name: 'Acme', displayName: 'Olga Owner' });
  const invitation = await verified.createInvite(olga, ws.id);
  const web = browser(verified.url);
  await web.init();
  await web.infoLoad;
  const info = web.status().info;
  assert.deepEqual(info.emailCodes.purposes, ['signup', 'unlock']);
  assert.equal(info.workspace.inviteSignupsNeedCode, true);

  const email = `web-code-${Date.now()}@example.com`;
  const workspaceInvite = { workspace: ws.id, invite: invitation.secret };
  await assert.rejects(web.accountSignUp({ email, password: PASSWORD, workspaceInvite }), { code: 'code_required' });
  const asked = Date.now() - 1;
  await web.accountEmailCode({ email, purpose: 'signup' });
  const mail = await verified.mail.next(email, { after: asked });
  await web.accountSignUp({ email, password: PASSWORD, workspaceInvite, emailCode: mail.code });
  assert.equal(web.status().signedIn, true);
  const joined = await web.workspaceCall('POST', `/v1/workspaces/${ws.id}/join`, { invite: invitation.secret, name: 'Web Person' });
  assert.equal(joined.workspace.id, ws.id);
  await web.signOut();

  // Ten wrong passwords from a stranger lock the account; the owner's unlock code gets past it.
  for (let i = 0; i < 10; i++) {
    await verified.call('POST', '/v1/login', { body: { email, authKey: k.b64u(globalThis.crypto.getRandomValues(new Uint8Array(32))), device: { name: 'x', platform: 'web' } } });
  }
  await assert.rejects(web.accountSignIn({ email, password: PASSWORD }), { code: 'locked' });
  const unlockAsked = Date.now() - 1;
  await web.accountEmailCode({ email, purpose: 'unlock' });
  const unlock = await verified.mail.next(email, { after: unlockAsked });
  await web.accountSignIn({ email, password: PASSWORD, emailCode: unlock.code });
  assert.equal(web.status().signedIn, true);
});

test('codes by email: a used-up invite code gets a code instead, and the emailed code goes without it', async (t) => {
  const srv = await fixture(t, { signups: 'verified', codes: true, usedInvites: ['spent'] });
  const web = browser(srv.url);
  await assert.rejects(web.accountSignUp({ email: 'spent@example.com', password: PASSWORD, invite: 'spent' }), { code: 'code_required' });
  await web.accountEmailCode({ email: 'spent@example.com', purpose: 'signup' });
  const code = srv.codeFor('spent@example.com');
  const before = srv.calls.filter((c) => c.route === 'POST /v1/signup').length;
  await web.accountSignUp({ email: 'spent@example.com', password: PASSWORD, invite: 'spent', emailCode: code });
  assert.equal(web.status().signedIn, true);
  const [withInvite, without] = srv.calls.filter((c) => c.route === 'POST /v1/signup').slice(before);
  assert.equal(withInvite.body.invite, 'spent');
  assert.equal('invite' in without.body, false);
  assert.equal(without.body.emailCode.code, code);
  // On an invite-only server the same answer stays what it was.
  const only = await fixture(t, { signups: 'invite', codes: true, usedInvites: ['spent'] });
  await assert.rejects(browser(only.url).accountSignUp({ email: 'old@example.com', password: PASSWORD, invite: 'spent' }), { code: 'invite_required' });
});

test("codes by email: an older code request answered late doesn't replace the newer one's challenge", async (t) => {
  const srv = await fixture(t, { signups: 'verified', codes: true });
  const web = browser(srv.url);
  let letGo = null;
  const gate = new Promise((r) => (letGo = r));
  srv.hold = ({ route }) => (route === 'POST /v1/email-code' ? ((srv.hold = null), gate) : null);
  const older = web.accountEmailCode({ email: 'order@example.com', purpose: 'signup' });
  for (let i = 0; i < 200 && !srv.calls.some((c) => c.route === 'POST /v1/email-code'); i++) await new Promise((r) => setTimeout(r, 10));
  srv.allowCode('order@example.com', 'signup');
  await web.accountEmailCode({ email: 'order@example.com', purpose: 'signup' });
  const newest = srv.codeFor('order@example.com');
  letGo();
  await older;
  await web.accountSignUp({ email: 'order@example.com', password: PASSWORD, emailCode: newest });
  assert.equal(web.status().signedIn, true);
});
