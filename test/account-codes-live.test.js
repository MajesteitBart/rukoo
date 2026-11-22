'use strict';

// Codes by email in the desktop account against the real account server (server/src, in the local Workers runtime)
// set to SIGNUPS=verified with team chat on, its mail going to the stand-in of test/fixtures/real-server.js. This is
// the protocol check of src/main/account/index.js: what the app sends is what server/src/codes.js takes, and what the
// server answers is what the app reads. Needs npm ci --prefix server; without it the tests skip, or fail in CI.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { AccountService, codesFor } = require('../src/main/account');
const { startRealServer, realServerAvailable, skipWithoutServer } = require('./fixtures/real-server');

const secrets = { encrypt: (s) => `plain:${Buffer.from(s).toString('base64')}`, decrypt: (s) => Buffer.from(String(s).slice(6), 'base64').toString() };
const PASSWORD = 'a long enough password';

let srv = null;
test.before(async () => {
  if (realServerAvailable()) srv = await startRealServer({ vars: { SIGNUPS: 'verified' }, mail: true });
});
test.after(() => srv?.close());

function device(t, name = 'desk') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rukoo-codes-live-'));
  const acc = new AccountService({ dataDir: dir, secrets, defaultServer: srv.url, deviceName: name, platform: 'linux' }).init();
  t.after(() => {
    acc.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return acc;
}

const fails = (code, extra = {}) => (err) => {
  assert.equal(err.code, code, `${err.code}: ${err.message}`);
  for (const [k, v] of Object.entries(extra)) assert.deepEqual(err.details && err.details[k], v, k);
  return true;
};
const address = (name) => `${name}-${crypto.randomBytes(4).toString('hex')}@example.com`;

// Asks for a code and waits for its email, which the server sends after its answer.
async function codeFor(acc, email, purpose) {
  const after = Date.now() - 1;
  await acc.requestCode({ email, purpose });
  return srv.mail.next(email, { after });
}

// Ten failed sign-ins lock the account (PROTOCOL.md, POST /v1/login); the tenth already gets 429 locked.
async function lockOut(email) {
  let last = null;
  for (let i = 0; i < 10; i++) {
    last = await srv.call('POST', '/v1/login', { body: { email, authKey: crypto.randomBytes(32).toString('base64url'), device: { name: 'Stranger', platform: 'linux' } } });
  }
  assert.equal(last.status, 429);
  assert.equal(last.body.error, 'locked');
}

test('the server reports codes for sign-ups and locked accounts, and invitations that need one', async (t) => {
  if (skipWithoutServer(t)) return;
  const info = await device(t).serverInfo();
  assert.equal(info.signups, 'invite');
  assert.equal(codesFor(info, 'signup'), true);
  assert.equal(codesFor(info, 'unlock'), true);
  assert.equal(info.workspace.inviteSignupsNeedCode, true);
});

test('a sign-up asks for a code, refuses a wrong one with the tries left, and goes through with the right one', async (t) => {
  if (skipWithoutServer(t)) return;
  const desk = device(t);
  const email = address('new');
  await assert.rejects(desk.signUp({ email, password: PASSWORD }), fails('code_required'));
  const mail = await codeFor(desk, email, 'signup');
  assert.match(mail.code, /^\d{6}$/);
  assert.match(mail.token, /^[A-Za-z0-9_-]{43}$/);
  const wrong = mail.code === '000000' ? '111111' : '000000';
  await assert.rejects(desk.signUp({ email, password: PASSWORD, emailCode: wrong }), fails('code_wrong', { attemptsLeft: 4 }));
  await desk.signUp({ email, password: PASSWORD, emailCode: mail.code });
  assert.equal(desk.status().signedIn, true);
  assert.equal(desk.status().email, email);
});

test('the long code signs up on another device; a second code within the minute waits', async (t) => {
  if (skipWithoutServer(t)) return;
  const asker = device(t, 'asker');
  const other = device(t, 'other');
  const email = address('long');
  const mail = await codeFor(asker, email, 'signup');
  await assert.rejects(asker.requestCode({ email, purpose: 'signup' }), (err) => {
    assert.equal(err.code, 'rate_limited');
    assert.ok(err.details.retryAfter > 0 && err.details.retryAfter <= 60, String(err.details.retryAfter));
    return true;
  });
  await other.signUp({ email, password: PASSWORD, emailCode: mail.token });
  assert.equal(other.status().signedIn, true);
  // Both codes in an email are one code: the six digits were used up with the long one.
  await assert.rejects(asker.signUp({ email, password: PASSWORD, emailCode: mail.code }), fails('code_expired'));
});

test('an invite code needs no emailed code, and a wrong one gets code_required from the server', async (t) => {
  if (skipWithoutServer(t)) return;
  const desk = device(t);
  await desk.signUp({ email: address('invited'), password: PASSWORD, invite: srv.inviteCode });
  assert.equal(desk.status().signedIn, true);
  await assert.rejects(device(t, 'other').signUp({ email: address('wrong'), password: PASSWORD, invite: 'not-the-code' }), fails('code_required'));
});

test('a sign-up with a workspace invitation needs the emailed code too, and takes both', async (t) => {
  if (skipWithoutServer(t)) return;
  const owner = await srv.seedAccount();
  const ws = await srv.seedWorkspace(owner, { name: 'Codes' });
  const { secret } = await srv.createInvite(owner, ws.id);
  const workspaceInvite = { workspace: ws.id, invite: secret };
  const desk = device(t);
  const email = address('joiner');
  await assert.rejects(desk.signUp({ email, password: PASSWORD, workspaceInvite }), fails('code_required'));
  const mail = await codeFor(desk, email, 'signup');
  await desk.signUp({ email, password: PASSWORD, workspaceInvite, emailCode: mail.code });
  assert.equal(desk.status().signedIn, true);
});

test('a locked account signs in with an unlock code; a wrong password with it answers as a wrong password', async (t) => {
  if (skipWithoutServer(t)) return;
  const person = await srv.seedAccount({ email: address('locked'), password: PASSWORD });
  await lockOut(person.email);
  const desk = device(t);
  await assert.rejects(desk.signIn({ email: person.email, password: PASSWORD }), fails('locked'));
  const mail = await codeFor(desk, person.email, 'unlock');
  await assert.rejects(desk.signIn({ email: person.email, password: 'not the password at all', emailCode: mail.code }), fails('unauthorized'));
  await desk.signIn({ email: person.email, password: PASSWORD, emailCode: mail.code });
  assert.equal(desk.status().signedIn, true);
  // The lock stays for everyone else.
  await assert.rejects(device(t, 'other').signIn({ email: person.email, password: PASSWORD }), fails('locked'));
});

test('a locked account recovers with the long code of an unlock email', async (t) => {
  if (skipWithoutServer(t)) return;
  const person = await srv.seedAccount({ email: address('recover'), password: PASSWORD });
  await lockOut(person.email);
  const desk = device(t);
  await assert.rejects(desk.recover({ email: person.email, recoveryKey: person.recoveryKey, password: 'a brand new password' }), fails('locked'));
  const mail = await codeFor(desk, person.email, 'unlock');
  await desk.recover({ email: person.email, recoveryKey: person.recoveryKey, password: 'a brand new password', emailCode: mail.token });
  assert.equal(desk.status().signedIn, true);
});

test('an invite code that has been used up gets a code instead, and the emailed code goes without it', async (t) => {
  if (skipWithoutServer(t)) return;
  // One account per invite code, so the second sign-up with it finds it used up.
  const once = await startRealServer({ vars: { SIGNUPS: 'verified', INVITE_USES: '1' }, mail: true });
  t.after(() => once.close());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rukoo-codes-live-'));
  const at = (name) => {
    const acc = new AccountService({ dataDir: path.join(dir, name), secrets, defaultServer: once.url, deviceName: name, platform: 'linux' }).init();
    t.after(() => acc.close());
    return acc;
  };
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await at('first').signUp({ email: address('first'), password: PASSWORD, invite: once.inviteCode });
  const desk = at('desk');
  const email = address('second');
  // The server answers invite_required for the used-up code and doesn't look for an emailed one.
  await assert.rejects(desk.signUp({ email, password: PASSWORD, invite: once.inviteCode }), fails('code_required'));
  const after = Date.now() - 1;
  await desk.requestCode({ email, purpose: 'signup' });
  const mail = await once.mail.next(email, { after });
  await desk.signUp({ email, password: PASSWORD, invite: once.inviteCode, emailCode: mail.code });
  assert.equal(desk.status().signedIn, true);
});
