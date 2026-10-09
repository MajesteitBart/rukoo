'use strict';

// Google sign-in against a fake Google: the "browser" follows the redirect, the token endpoint is stubbed.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { GoogleAuth, CALENDAR_SCOPES } = require('../src/main/google');
const { Engine } = require('../src/main/engine');
const { ImapAccount } = require('../src/main/imap');

const CLIENT = { client_id: 'test-client.apps.googleusercontent.com', client_secret: 'test-secret' };

function configFile() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sem-g-')), 'google-oauth.json');
  fs.writeFileSync(file, JSON.stringify(CLIENT));
  return file;
}

function idToken(claims) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${enc({ alg: 'none' })}.${enc(claims)}.sig`;
}

// Fake token endpoint; records requests and checks PKCE against the challenge the browser saw.
function fakeGoogle({ scope = 'openid email profile https://mail.google.com/', refreshError = null } = {}) {
  const seen = { authUrl: null, tokenForms: [] };
  const fetchImpl = async (url, opts) => {
    const form = Object.fromEntries(new URLSearchParams(opts.body));
    seen.tokenForms.push(form);
    const json = (status, body) => ({ ok: status === 200, status, json: async () => body });
    if (form.grant_type === 'authorization_code') {
      const challenge = new URL(seen.authUrl).searchParams.get('code_challenge');
      const expected = crypto.createHash('sha256').update(form.code_verifier).digest('base64url');
      if (challenge !== expected || form.code !== 'the-code' || form.client_secret !== CLIENT.client_secret) {
        return json(400, { error: 'invalid_grant' });
      }
      return json(200, {
        access_token: 'access-1',
        refresh_token: 'refresh-1',
        expires_in: 3599,
        scope,
        id_token: idToken({ email: 'Bart@Example.com', name: 'Bart' })
      });
    }
    if (refreshError) return json(400, { error: refreshError });
    return json(200, { access_token: `access-${seen.tokenForms.length}`, expires_in: 3599 });
  };
  const browser = ({ deny = false, badState = false } = {}) => async (url) => {
    seen.authUrl = url;
    const u = new URL(url);
    const back = new URL(u.searchParams.get('redirect_uri'));
    back.searchParams.set('state', badState ? 'forged' : u.searchParams.get('state'));
    if (deny) back.searchParams.set('error', 'access_denied');
    else back.searchParams.set('code', 'the-code');
    const res = await fetch(back);
    seen.page = await res.text();
  };
  return { seen, fetchImpl, browser };
}

test('sign-in: loopback redirect, PKCE, offline access and Gmail scope', async () => {
  const g = fakeGoogle();
  const auth = new GoogleAuth({ configPath: configFile(), openBrowser: g.browser(), fetchImpl: g.fetchImpl });
  assert.equal(auth.available(), true);
  const grant = await auth.signIn('bart@example.com');
  assert.equal(grant.email, 'Bart@Example.com');
  assert.equal(grant.refreshToken, 'refresh-1');
  assert.equal(grant.accessToken, 'access-1');
  const u = new URL(g.seen.authUrl);
  assert.match(u.searchParams.get('redirect_uri'), /^http:\/\/127\.0\.0\.1:\d+\/$/);
  assert.equal(u.searchParams.get('access_type'), 'offline');
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(u.searchParams.get('login_hint'), 'bart@example.com');
  assert.ok(u.searchParams.get('scope').split(' ').includes('https://mail.google.com/'));
  for (const scope of CALENDAR_SCOPES) assert.ok(u.searchParams.get('scope').split(' ').includes(scope), scope);
  // Signing in again for the calendar keeps what the account granted before.
  assert.equal(u.searchParams.get('include_granted_scopes'), 'true');
  assert.deepEqual(grant.scopes, ['openid', 'email', 'profile', 'https://mail.google.com/']);
  for (let i = 0; i < 50 && !g.seen.page; i++) await new Promise((r) => setTimeout(r, 10));
  assert.match(g.seen.page, /You are signed in/);
});

test('sign-in keeps the granted scopes with the account; a refresh updates them', async () => {
  const granted = ['openid', 'email', 'https://mail.google.com/', ...CALENDAR_SCOPES];
  const g = fakeGoogle({ scope: granted.join(' ') });
  const auth = new GoogleAuth({ configPath: configFile(), openBrowser: g.browser(), fetchImpl: g.fetchImpl });
  const grant = await auth.signIn();
  assert.deepEqual(grant.scopes, granted);

  let refreshScopes = null;
  const google = { available: () => true, refresh: async () => ({ accessToken: 'access-2', expiresAt: Date.now() + 3600000, ...(refreshScopes ? { scopes: refreshScopes } : {}) }) };
  const engine = new Engine({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'sem-gs-')), google }).init();
  let added = null;
  engine.finishAdd = async (acc) => (added = acc);
  await engine.addGoogleAccount(grant);
  assert.deepEqual(added.scopes, [...granted].sort());

  // Signing in again replaces them: here without the calendar, which the user may leave out on Google's screen.
  engine.accounts.push(added);
  engine.syncAccount = async () => [];
  await engine.addGoogleAccount({ ...grant, scopes: ['https://mail.google.com/'] }, { reauthId: added.id });
  assert.deepEqual(added.scopes, ['https://mail.google.com/']);

  // Access withdrawn in the Google account shows up at the next refresh, and is saved.
  engine.tokens.clear();
  refreshScopes = ['openid'];
  await engine.accessToken(added);
  assert.deepEqual(added.scopes, ['openid']);
  const saved = JSON.parse(fs.readFileSync(path.join(engine.dataDir, 'accounts.json'), 'utf8'));
  assert.deepEqual(saved.find((a) => a.id === added.id).scopes, ['openid']);
});

test('a token answer that stops halfway is a connection error, and the request has a deadline', async () => {
  let signal = null;
  const fetchImpl = async (url, opts) => {
    signal = opts.signal;
    return { ok: true, status: 200, json: async () => Promise.reject(new Error('aborted')) };
  };
  const auth = new GoogleAuth({ configPath: configFile(), openBrowser: () => {}, fetchImpl });
  await assert.rejects(auth.refresh('rt'), (err) => err.oauth && err.code === 'network');
  assert.ok(signal instanceof AbortSignal);
});

test('a token refresh from before signing in again does not overwrite the new grant', async () => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const google = {
    available: () => true,
    refresh: async () => {
      await gate;
      return { accessToken: 'old-access', expiresAt: Date.now() + 3600000, scopes: ['https://mail.google.com/'] };
    }
  };
  const engine = new Engine({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'sem-gr-')), google }).init();
  const acc = { id: 'a1', type: 'imap', provider: 'google', auth: 'oauth2', email: 'bart@example.com', secret: 'rt-1', scopes: ['https://mail.google.com/'] };
  engine.accounts.push(acc);
  engine.syncAccount = async () => [];
  const old = engine.accessToken(acc);
  const scopes = ['https://mail.google.com/', ...CALENDAR_SCOPES].sort();
  await engine.addGoogleAccount({ email: 'bart@example.com', refreshToken: 'rt-2', accessToken: 'new-access', expiresAt: Date.now() + 3600000, scopes }, { reauthId: 'a1' });
  assert.equal(engine.grant('a1'), 1);
  release();
  assert.equal(await old, 'old-access', 'the old caller still gets its answer');
  assert.equal(await engine.accessToken(acc), 'new-access');
  assert.deepEqual(acc.scopes, scopes);
});

test('refresh reports the scopes Google lists', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ access_token: 'a', expires_in: 3599, scope: 'openid https://mail.google.com/' }) });
  const auth = new GoogleAuth({ configPath: configFile(), openBrowser: () => {}, fetchImpl });
  const grant = await auth.refresh('rt');
  assert.deepEqual(grant.scopes, ['openid', 'https://mail.google.com/']);
});

test('sign-in: forged state is ignored, denial and missing Gmail scope are reported', async () => {
  const forged = fakeGoogle();
  const auth1 = new GoogleAuth({ configPath: configFile(), openBrowser: forged.browser({ badState: true }), fetchImpl: forged.fetchImpl });
  const pending = auth1.signIn();
  await new Promise((r) => setTimeout(r, 200));
  assert.match(forged.seen.page, /Invalid request/);
  assert.equal(forged.seen.tokenForms.length, 0, 'no token exchange for a forged redirect');
  auth1.cancel();
  await assert.rejects(pending, /cancelled/);

  const denied = fakeGoogle();
  const auth2 = new GoogleAuth({ configPath: configFile(), openBrowser: denied.browser({ deny: true }), fetchImpl: denied.fetchImpl });
  await assert.rejects(auth2.signIn(), /did not grant access/);

  const noScope = fakeGoogle({ scope: 'openid email' });
  const auth3 = new GoogleAuth({ configPath: configFile(), openBrowser: noScope.browser(), fetchImpl: noScope.fetchImpl });
  await assert.rejects(auth3.signIn(), /access Gmail/);
});

test('refresh: revoked grants give a clear message; missing config disables Google', async () => {
  const g = fakeGoogle({ refreshError: 'invalid_grant' });
  const auth = new GoogleAuth({ configPath: configFile(), openBrowser: g.browser(), fetchImpl: g.fetchImpl });
  await assert.rejects(auth.refresh('old'), /Sign in again/);
  const none = new GoogleAuth({ configPath: path.join(os.tmpdir(), 'does-not-exist.json'), openBrowser: () => {} });
  assert.equal(none.available(), false);
  await assert.rejects(none.signIn(), /not configured/);
});

test('importClient accepts the Google Cloud download format', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sem-gi-'));
  const download = path.join(dir, 'client_secret_x.json');
  fs.writeFileSync(download, JSON.stringify({ installed: { ...CLIENT, redirect_uris: ['http://localhost'] } }));
  const auth = new GoogleAuth({ configPath: path.join(dir, 'google-oauth.json'), openBrowser: () => {} });
  assert.equal(auth.available(), false);
  auth.importClient(download);
  assert.equal(auth.available(), true);
});

test('engine: OAuth accounts get XOAUTH2 credentials and refresh tokens once, in parallel', async () => {
  let refreshes = 0;
  const google = {
    available: () => true,
    refresh: async (rt) => {
      assert.equal(rt, 'refresh-1');
      refreshes++;
      await new Promise((r) => setTimeout(r, 20));
      return { accessToken: `access-${refreshes}`, expiresAt: Date.now() + 3600000 };
    }
  };
  const engine = new Engine({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'sem-ge-')), google }).init();
  const acc = { id: 'a1', type: 'imap', provider: 'google', auth: 'oauth2', email: 'bart@example.com', secret: 'refresh-1', imap: { host: 'imap.gmail.com', port: 993, secure: true, user: 'bart@example.com' }, smtp: { host: 'smtp.gmail.com', port: 465, secure: true } };
  const [t1, t2] = await Promise.all([engine.accessToken(acc), engine.accessToken(acc)]);
  assert.equal(t1, 'access-1');
  assert.equal(t2, 'access-1');
  assert.equal(refreshes, 1, 'concurrent callers share one refresh');
  assert.equal(await engine.accessToken(acc), 'access-1', 'cached until close to expiry');

  const session = new ImapAccount(acc, engine.credentials(acc));
  const opts = await session.imapOptions();
  assert.deepEqual(opts.auth, { user: 'bart@example.com', accessToken: 'access-1' });
  const transport = await session.transport();
  assert.equal(transport.options.auth.type, 'OAuth2');
  assert.equal(transport.options.auth.accessToken, 'access-1');
  transport.close();
  assert.equal(engine.state().googleAvailable, true);
});
