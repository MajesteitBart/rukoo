'use strict';

// Codes by email in the desktop account (src/main/account/index.js requestCode, emailCodeFor, settleCode), against the
// in-memory server (test/fixtures/account-server.js): a sign-up on a server that checks addresses, the long code from
// another device, wrong and expired codes, invite codes and workspace invitations beside a code, and a locked account
// that signs in and recovers with an unlock code. test/account-codes-live.test.js runs the same against the real one.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const i18n = require('../src/i18n');
const { AccountService, codesFor } = require('../src/main/account');
const { errorDetails } = require('../src/main/account/client');
const { startAccountServer } = require('./fixtures/account-server');

const secrets = { encrypt: (s) => `plain:${Buffer.from(s).toString('base64')}`, decrypt: (s) => Buffer.from(String(s).slice(6), 'base64').toString() };
const PASSWORD = 'a long enough password';
const WS = { workspace: 'w_AAAAAAAAAAAAAAAAAAAAAA', invite: 'i'.repeat(43) };

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rukoo-codes-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function server(t, options) {
  const s = await startAccountServer(options);
  t.after(() => s.close());
  return s;
}

function device(t, srv, name = 'desk') {
  const acc = new AccountService({ dataDir: tmpDir(t), secrets, defaultServer: srv.url, deviceName: name, platform: 'linux' }).init();
  t.after(() => acc.close());
  return acc;
}

const fails = (code, extra = {}) => (err) => {
  assert.equal(err.code, code, `${err.code}: ${err.message}`);
  for (const [k, v] of Object.entries(extra)) assert.deepEqual(err.details && err.details[k], v, k);
  return true;
};
const routes = (srv, route) => srv.calls.filter((c) => c.route === route);

test('a server without codes by email signs up as before, and says it sends none', async (t) => {
  const srv = await server(t, { signups: 'invite', invites: ['welcome'] });
  const desk = device(t, srv);
  const info = await desk.serverInfo();
  assert.equal(codesFor(info, 'signup'), false);
  assert.equal(codesFor(info, 'unlock'), false);
  await assert.rejects(desk.requestCode({ email: 'nocodes@example.com', purpose: 'signup' }), fails('mail_unavailable'));
  await desk.signUp({ email: 'nocodes@example.com', password: PASSWORD, invite: 'welcome' });
  assert.equal(desk.status().signedIn, true);
  assert.equal(routes(srv, 'POST /v1/signup')[0].body.emailCode, undefined);
});

test('a server that sends only unlock codes takes sign-ups as before', async (t) => {
  // rukoo.io today: invite-only, with unlock codes.
  const srv = await server(t, { signups: 'invite', invites: ['welcome'], codes: true });
  const desk = device(t, srv);
  const info = await desk.serverInfo();
  assert.equal(info.signups, 'invite');
  assert.equal(codesFor(info, 'signup'), false);
  assert.equal(codesFor(info, 'unlock'), true);
  await assert.rejects(desk.signUp({ email: 'invited@example.com', password: PASSWORD }), fails('invite_required'));
  await desk.signUp({ email: 'invited@example.com', password: PASSWORD, invite: 'welcome' });
  assert.equal(desk.status().signedIn, true);
});

test('on a server that checks addresses, a sign-up gets a code first and goes through with it', async (t) => {
  const srv = await server(t, { signups: 'verified', codes: true });
  const desk = device(t, srv);
  const info = await desk.serverInfo();
  assert.equal(info.signups, 'invite', 'reported as invite for older apps');
  assert.equal(codesFor(info, 'signup'), true);

  // Without a code it stops before the password's keys are made or anything is sent.
  await assert.rejects(desk.signUp({ email: ' New@Example.com ', password: PASSWORD }), fails('code_required'));
  assert.equal(routes(srv, 'POST /v1/signup').length, 0);

  const sent = await desk.requestCode({ email: ' New@Example.com ', purpose: 'signup' });
  assert.deepEqual(sent, { email: 'new@example.com', expiresIn: 600 });
  const asked = routes(srv, 'POST /v1/email-code')[0].body;
  assert.deepEqual(asked, { email: 'new@example.com', purpose: 'signup', lang: 'en' });
  const code = srv.codeFor('new@example.com');
  assert.match(code, /^\d{6}$/);

  const wrong = code === '000000' ? '111111' : '000000';
  await assert.rejects(desk.signUp({ email: 'new@example.com', password: PASSWORD, emailCode: wrong }), fails('code_wrong', { attemptsLeft: 4 }));
  assert.equal(desk.status().signedIn, false);

  // Spaces and a dash, as people type a code.
  const { recoveryKey } = await desk.signUp({ email: 'new@example.com', password: PASSWORD, emailCode: ` ${code.slice(0, 3)}-${code.slice(3)} ` });
  assert.ok(recoveryKey);
  assert.equal(desk.status().signedIn, true);
  const body = routes(srv, 'POST /v1/signup').at(-1).body;
  assert.equal(body.emailCode.code, code);
  assert.match(body.emailCode.challenge, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(body.invite, undefined);
  // The code is used up here as on the server: nothing is kept for the next sign-up.
  assert.equal(desk.codes.has('signup'), false);
});

test('the long code from the email works on a device that never asked, and six digits there do not', async (t) => {
  const srv = await server(t, { signups: 'verified', codes: true });
  const asker = device(t, srv, 'asker');
  const phone = device(t, srv, 'other');
  await asker.requestCode({ email: 'long@example.com', purpose: 'signup' });
  const token = srv.tokenFor('long@example.com');
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);

  // The six digits count only with the challenge, which only the asking device has.
  const before = srv.calls.length;
  await assert.rejects(phone.signUp({ email: 'long@example.com', password: PASSWORD, emailCode: srv.codeFor('long@example.com') }), fails('code_expired'));
  assert.equal(routes(srv, 'POST /v1/signup').length, 0, 'refused here, before the password keys');
  assert.ok(srv.calls.length - before <= 1, 'at most the server info was fetched');
  await assert.rejects(phone.signUp({ email: 'long@example.com', password: PASSWORD, emailCode: 'not a code' }), fails('code_format'));

  // Pasted with a line break in it, as a mail program may wrap it.
  await phone.signUp({ email: 'long@example.com', password: PASSWORD, emailCode: `${token.slice(0, 20)}\n${token.slice(20)}` });
  assert.equal(phone.status().signedIn, true);
  assert.deepEqual(routes(srv, 'POST /v1/signup').at(-1).body.emailCode, { token });
});

test('five wrong codes end the six digits; the long code in the same email still works', async (t) => {
  const srv = await server(t, { signups: 'verified', codes: true });
  const desk = device(t, srv);
  await desk.requestCode({ email: 'typo@example.com', purpose: 'signup' });
  const code = srv.codeFor('typo@example.com');
  const wrong = code === '123456' ? '654321' : '123456';
  for (const left of [4, 3, 2, 1, 0]) {
    await assert.rejects(desk.signUp({ email: 'typo@example.com', password: PASSWORD, emailCode: wrong }), fails('code_wrong', { attemptsLeft: left }));
  }
  // The challenge is gone here too, so even the right six digits are refused before anything is sent.
  const signups = routes(srv, 'POST /v1/signup').length;
  await assert.rejects(desk.signUp({ email: 'typo@example.com', password: PASSWORD, emailCode: code }), fails('code_expired'));
  assert.equal(routes(srv, 'POST /v1/signup').length, signups);
  await desk.signUp({ email: 'typo@example.com', password: PASSWORD, emailCode: srv.tokenFor('typo@example.com') });
  assert.equal(desk.status().signedIn, true);
});

test('a new code replaces the one before, a code for another address is refused, and a second one waits a minute', async (t) => {
  const srv = await server(t, { signups: 'verified', codes: true });
  const desk = device(t, srv);
  await desk.requestCode({ email: 'again@example.com', purpose: 'signup' });
  const first = srv.codeFor('again@example.com');
  await assert.rejects(desk.requestCode({ email: 'again@example.com', purpose: 'signup' }), fails('rate_limited'));
  srv.allowCode('again@example.com', 'signup');
  await desk.requestCode({ email: 'again@example.com', purpose: 'signup' });
  const second = srv.codeFor('again@example.com');
  // Typed for another address than the code went to: there is no request for that one here.
  await assert.rejects(desk.signUp({ email: 'other@example.com', password: PASSWORD, emailCode: second }), fails('code_expired'));
  if (first !== second) {
    await assert.rejects(desk.signUp({ email: 'again@example.com', password: PASSWORD, emailCode: first }), fails('code_wrong'));
  }
  await desk.signUp({ email: 'again@example.com', password: PASSWORD, emailCode: second });
  assert.equal(desk.status().signedIn, true);
});

test('a code waits for the server Retry-After: up to an hour as retryAfter, longer as waitSeconds', () => {
  const at = (header) => errorDetails({ error: 'rate_limited' }, { headers: { 'retry-after': header } });
  assert.deepEqual(at('42'), { retryAfter: 42 });
  assert.deepEqual(at('18000'), { retryAfter: 3600, waitSeconds: 18000 });
  assert.deepEqual(at('999999'), { retryAfter: 3600, waitSeconds: 86400 });
  assert.deepEqual(errorDetails({ error: 'code_wrong', attemptsLeft: 2 }, { headers: {} }), { attemptsLeft: 2 });
});

test('an invite code needs no emailed code; a wrong one asks the server for a code instead', async (t) => {
  const srv = await server(t, { signups: 'verified', codes: true, invites: ['welcome'] });
  const desk = device(t, srv);
  await desk.signUp({ email: 'invited@example.com', password: PASSWORD, invite: 'welcome' });
  assert.equal(desk.status().signedIn, true);
  assert.equal(routes(srv, 'POST /v1/signup').at(-1).body.emailCode, undefined);
  assert.equal(srv.mail.length, 0);

  const other = device(t, srv, 'other');
  await assert.rejects(other.signUp({ email: 'wrong@example.com', password: PASSWORD, invite: 'nope' }), fails('code_required'));
  assert.equal(routes(srv, 'POST /v1/signup').at(-1).body.invite, 'nope', 'the server, not the app, judged the invite code');
});

test('a workspace invitation needs the emailed code too where the server says so', async (t) => {
  const srv = await server(t, { signups: 'verified', codes: true, workspaceInvites: [WS] });
  const desk = device(t, srv);
  const info = await desk.serverInfo();
  assert.equal(info.workspace.inviteSignupsNeedCode, true);
  await assert.rejects(desk.signUp({ email: 'joiner@example.com', password: PASSWORD, workspaceInvite: WS }), fails('code_required'));
  assert.equal(routes(srv, 'POST /v1/signup').length, 0);
  await desk.requestCode({ email: 'joiner@example.com', purpose: 'signup' });
  await desk.signUp({ email: 'joiner@example.com', password: PASSWORD, workspaceInvite: WS, emailCode: srv.codeFor('joiner@example.com') });
  const body = routes(srv, 'POST /v1/signup').at(-1).body;
  assert.deepEqual(body.workspaceInvite, WS);
  assert.equal(body.emailCode.code, srv.codeFor('joiner@example.com'));
});

test('a code goes out in the language Rukoo shows', async (t) => {
  const srv = await server(t, { signups: 'verified', codes: true });
  const desk = device(t, srv);
  i18n.setLanguage('nl');
  t.after(() => i18n.setLanguage('en'));
  await desk.requestCode({ email: 'dutch@example.com', purpose: 'signup' });
  assert.equal(routes(srv, 'POST /v1/email-code')[0].body.lang, 'nl');
  await assert.rejects(desk.requestCode({ email: 'dutch@example.com', purpose: 'other' }), fails('invalid'));
  await assert.rejects(desk.requestCode({ email: 'not an address', purpose: 'signup' }), fails('invalid_email'));
});

test('a locked account signs in with an unlock code, and a wrong password costs the code a try, not the lock', async (t) => {
  const srv = await server(t, { signups: 'open', codes: true });
  const first = device(t, srv, 'first');
  await first.signUp({ email: 'locked@example.com', password: PASSWORD });
  await first.signOut();
  srv.lock('locked@example.com');

  const desk = device(t, srv, 'desk');
  await assert.rejects(desk.signIn({ email: 'locked@example.com', password: PASSWORD }), (err) => {
    assert.equal(err.code, 'locked');
    assert.ok(err.details.retryAfter > 0);
    return true;
  });
  await desk.requestCode({ email: 'locked@example.com', purpose: 'unlock' });
  const code = srv.codeFor('locked@example.com');
  await assert.rejects(desk.signIn({ email: 'locked@example.com', password: 'not the password at all', emailCode: code }), fails('unauthorized'));
  // The code is still good for the right password.
  await desk.signIn({ email: 'locked@example.com', password: PASSWORD, emailCode: code });
  assert.equal(desk.status().signedIn, true);
  assert.equal(routes(srv, 'POST /v1/login').at(-1).body.emailCode.code, code);
  assert.equal(desk.codes.has('unlock'), false);

  // Everyone else is still locked out.
  const third = device(t, srv, 'third');
  await assert.rejects(third.signIn({ email: 'locked@example.com', password: PASSWORD }), fails('locked'));
});

test('a locked account recovers with an unlock code sent with both steps', async (t) => {
  const srv = await server(t, { signups: 'open', codes: true });
  const first = device(t, srv, 'first');
  const { recoveryKey } = await first.signUp({ email: 'recover@example.com', password: PASSWORD });
  srv.lock('recover@example.com');
  const desk = device(t, srv, 'desk');
  await assert.rejects(desk.recover({ email: 'recover@example.com', recoveryKey, password: 'a brand new password' }), fails('locked'));
  await desk.requestCode({ email: 'recover@example.com', purpose: 'unlock' });
  const token = srv.tokenFor('recover@example.com');
  await desk.recover({ email: 'recover@example.com', recoveryKey, password: 'a brand new password', emailCode: token });
  assert.equal(desk.status().signedIn, true);
  assert.deepEqual(routes(srv, 'POST /v1/recover/start').at(-1).body.emailCode, { token });
  assert.deepEqual(routes(srv, 'POST /v1/recover/finish').at(-1).body.emailCode, { token });
});

// Rukoo's former default address and today's, both reaching the test server, as account.test.js release() has them.
const OLD_DEFAULT = 'https://rukoo-account.bvdm.ai';
const NEW_DEFAULT = 'https://rukoo.io';
function release(t, srv, defaultServer, dir) {
  const { request } = require('../src/main/account/client');
  const acc = new AccountService({
    dataDir: dir,
    secrets,
    defaultServer,
    deviceName: 'desk',
    platform: 'linux',
    request: (server, ...rest) => request([OLD_DEFAULT, NEW_DEFAULT].includes(server) ? srv.url : server, ...rest)
  }).init();
  t.after(() => acc.close());
  return acc;
}

test('an account made at the former default signs in past the lock there, with the unlock code', async (t) => {
  const srv = await server(t, { signups: 'open', codes: true });
  const dir = tmpDir(t);
  const before = release(t, srv, OLD_DEFAULT, dir);
  await before.signUp({ email: 'former@example.com', password: PASSWORD });
  before.close();
  // The update moves the device to the new default, and signing out leaves the former address to try once.
  const after = release(t, srv, NEW_DEFAULT, dir);
  await after.signOut();
  assert.equal(after.status().server, NEW_DEFAULT);
  srv.lock('former@example.com');
  await assert.rejects(after.signIn({ email: 'former@example.com', password: PASSWORD }), fails('locked'));
  await after.requestCode({ email: 'former@example.com', purpose: 'unlock' });
  await after.signIn({ email: 'former@example.com', password: PASSWORD, emailCode: srv.codeFor('former@example.com') });
  assert.equal(after.status().signedIn, true);
  assert.equal(after.status().server, OLD_DEFAULT, 'the account stays at the address it was made at');
  assert.equal(routes(srv, 'POST /v1/login').at(-1).body.emailCode.code, srv.codeFor('former@example.com'));
});

test('with one try left on the code, the right password at the former default still signs in', async (t) => {
  const srv = await server(t, { signups: 'open', codes: true });
  const dir = tmpDir(t);
  const before = release(t, srv, OLD_DEFAULT, dir);
  await before.signUp({ email: 'lasttry@example.com', password: PASSWORD });
  before.close();
  const after = release(t, srv, NEW_DEFAULT, dir);
  await after.signOut();
  srv.lock('lasttry@example.com');
  await after.requestCode({ email: 'lasttry@example.com', purpose: 'unlock' });
  const code = srv.codeFor('lasttry@example.com');
  // Two wrong passwords, each tried at both addresses: four of the code's five tries.
  for (let i = 0; i < 2; i++) {
    await assert.rejects(after.signIn({ email: 'lasttry@example.com', password: 'not the password at all', emailCode: code }), fails('unauthorized'));
  }
  // The former address goes first for this account, so its right password uses the last try there.
  await after.signIn({ email: 'lasttry@example.com', password: PASSWORD, emailCode: code });
  assert.equal(after.status().signedIn, true);
  assert.equal(after.status().server, OLD_DEFAULT);
});

test("a typed code that can't be sent doesn't stop an invite code, and comes back when the server still wants a code", async (t) => {
  const srv = await server(t, { signups: 'verified', codes: true, invites: ['welcome'] });
  const desk = device(t, srv);
  // Six digits without a request here, beside the operator's invite code: the invite code goes, and works.
  await desk.signUp({ email: 'inv@example.com', password: PASSWORD, invite: 'welcome', emailCode: '123456' });
  assert.equal(desk.status().signedIn, true);
  assert.equal(routes(srv, 'POST /v1/signup').at(-1).body.emailCode, undefined);
  // With a wrong invite code the server still asks for a code, and the code's own problem is what the form says.
  const other = device(t, srv, 'other');
  await assert.rejects(other.signUp({ email: 'inv2@example.com', password: PASSWORD, invite: 'nope', emailCode: 'abc' }), fails('code_format'));
});

test('a late answer for another address leaves the code of this one alone', async (t) => {
  const srv = await server(t, { signups: 'verified', codes: true });
  const desk = device(t, srv);
  await desk.requestCode({ email: 'b@example.com', purpose: 'signup' });
  // The answer for an address typed before comes after it.
  await desk.requestCode({ email: 'a@example.com', purpose: 'signup' });
  await desk.signUp({ email: 'b@example.com', password: PASSWORD, emailCode: srv.codeFor('b@example.com') });
  assert.equal(desk.status().signedIn, true);
});
