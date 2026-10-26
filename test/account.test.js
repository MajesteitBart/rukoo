'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const k = require('../src/main/account/crypto');
const { AccountService } = require('../src/main/account');
const { serverUrl } = require('../src/main/account/client');
const { startAccountServer } = require('./fixtures/account-server');
const vectors = require('./fixtures/account-vectors.json');

const secrets = { encrypt: (s) => `plain:${Buffer.from(s).toString('base64')}`, decrypt: (s) => Buffer.from(String(s).slice(6), 'base64').toString() };
const PASSWORD = 'a long enough password';

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rukoo-account-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function server(t, options) {
  const s = await startAccountServer(options);
  t.after(() => s.close());
  return s;
}

function device(t, srv, name = 'desk', dir = tmpDir(t)) {
  const acc = new AccountService({ dataDir: dir, secrets, defaultServer: srv.url, deviceName: name, platform: 'linux' }).init();
  t.after(() => acc.close());
  return acc;
}

test('the keys match the shared vectors', async () => {
  const salt = k.unb64u(vectors.salt, 16);
  assert.equal(k.normalizeEmail(vectors.email), vectors.normalizedEmail);
  assert.equal(k.b64u(await k.masterKey(vectors.password, salt, vectors.kdf)), vectors.masterKey);
  const { authKey, wrapKey } = await k.passwordKeys(vectors.password, salt, vectors.kdf);
  assert.equal(k.b64u(authKey), vectors.authKey);
  assert.equal(k.b64u(wrapKey), vectors.wrapKey);
  assert.equal(crypto.createHash('sha256').update(authKey).digest('base64url'), vectors.authVerifier);
  const dataKey = k.unwrapDataKey(wrapKey, k.unb64u(vectors.wrappedKey));
  assert.equal(k.b64u(dataKey), vectors.dataKey);
  assert.equal(k.b64u(k.seal(wrapKey, dataKey, 'rukoo/v1/data-key', k.unb64u(vectors.wrapNonce))), vectors.wrappedKey);
  const recovery = k.unb64u(vectors.recoveryKeyBytes);
  assert.equal(k.formatRecoveryKey(recovery), vectors.recoveryKey);
  const { recoveryAuth, recoveryWrap } = k.recoveryKeys(recovery);
  assert.equal(k.b64u(recoveryAuth), vectors.recoveryAuth);
  assert.equal(k.b64u(recoveryWrap), vectors.recoveryWrap);
  const rk = k.recordKeys(dataKey);
  assert.equal(k.b64u(rk.recordKey), vectors.recordKey);
  assert.equal(k.b64u(rk.indexKey), vectors.indexKey);
  assert.equal(k.recordId(rk.indexKey, vectors.record.c, vectors.record.k), vectors.recordId);
  assert.deepEqual(k.openRecord(rk, vectors.recordId, vectors.recordData), vectors.record);
  assert.deepEqual(k.sealRecord(rk, vectors.record, k.unb64u(vectors.recordNonce)), { id: vectors.recordId, data: vectors.recordData });
});

test('a sealed record refuses another id, other bytes and another key', () => {
  const keys = k.recordKeys(crypto.randomBytes(32));
  const { id, data } = k.sealRecord(keys, { c: 'sender', k: 'a@b.c', v: { category: 'x' }, t: 1 });
  assert.equal(k.openRecord(keys, id, data).k, 'a@b.c');
  const other = k.sealRecord(keys, { c: 'sender', k: 'd@e.f', v: null, t: 1 });
  assert.equal(k.openRecord(keys, other.id, data), null, 'the server swapped two records');
  const bytes = k.unb64u(data);
  bytes[bytes.length - 1] ^= 1;
  assert.equal(k.openRecord(keys, id, k.b64u(bytes)), null, 'a changed tag');
  assert.equal(k.openRecord(k.recordKeys(crypto.randomBytes(32)), id, data), null, 'another account');
  assert.equal(k.openRecord(keys, id, 'not base64url!'), null);
});

test('recovery keys read back however they were copied', () => {
  const bytes = crypto.randomBytes(20);
  const text = k.formatRecoveryKey(bytes);
  assert.match(text, /^([0-9A-HJKMNP-TV-Z]{4}-){7}[0-9A-HJKMNP-TV-Z]{4}$/);
  assert.deepEqual(k.parseRecoveryKey(text), bytes);
  assert.deepEqual(k.parseRecoveryKey(` ${text.toLowerCase().replace(/-/g, ' ')} `), bytes);
  assert.deepEqual(k.parseRecoveryKey('0O1I-L000-0000-0000-0000-0000-0000-0000'), k.parseRecoveryKey('0011-1000-0000-0000-0000-0000-0000-0000'));
  assert.equal(k.parseRecoveryKey('too short'), null);
  assert.equal(k.parseRecoveryKey(`${text}U`), null);
});

test('weak or odd key derivation settings are refused', () => {
  assert.throws(() => k.checkKdf({ alg: 'argon2id', m: 1024, t: 3, p: 1 }));
  assert.throws(() => k.checkKdf({ alg: 'argon2id', m: 65536, t: 1, p: 1 }));
  assert.throws(() => k.checkKdf({ alg: 'scrypt', m: 65536, t: 3, p: 1 }));
  assert.throws(() => k.checkKdf({ alg: 'argon2id', m: 65536, t: 3, p: 9 }));
  assert.deepEqual(k.checkKdf({ alg: 'argon2id', m: 65536, t: 3, p: 1, extra: true }), k.DEFAULT_KDF);
});

test('only https servers, or http on this computer', () => {
  assert.equal(serverUrl('https://sync.example.com/'), 'https://sync.example.com');
  assert.equal(serverUrl('https://example.com/rukoo/'), 'https://example.com/rukoo');
  assert.equal(serverUrl('http://127.0.0.1:8787'), 'http://127.0.0.1:8787');
  assert.equal(serverUrl('http://sync.example.com'), null);
  assert.equal(serverUrl('https://user:pw@example.com'), null);
  assert.equal(serverUrl('ftp://example.com'), null);
  assert.equal(serverUrl('nonsense'), null);
});

test('signing up sends no password and nothing readable, and gives a recovery key', async (t) => {
  const srv = await server(t);
  const desk = device(t, srv);
  desk.put('category', 'needs-you', { name: 'Needs you' });
  const { recoveryKey } = await desk.signUp({ email: ' Bart@Example.com ', password: PASSWORD });
  assert.ok(k.parseRecoveryKey(recoveryKey));
  assert.equal(desk.status().email, 'bart@example.com');
  await desk.sync();
  const sent = JSON.stringify(srv.calls);
  assert.ok(!sent.includes(PASSWORD), 'the password never leaves the device');
  assert.ok(!sent.includes('Needs you') && !sent.includes('needs-you'), 'records go up sealed');
  const stored = srv.accounts.get('bart@example.com');
  assert.equal(stored.records.size, 1);
  assert.equal(desk.status().pending, 0);
});

test('a second device signs in, gets the records and sends its own', async (t) => {
  const srv = await server(t);
  const desk = device(t, srv, 'desk');
  await desk.signUp({ email: 'b@example.com', password: PASSWORD });
  desk.put('category', 'money', { name: 'Money' });
  desk.put('sender', 'bank@example.com', { category: 'money' });
  await desk.sync();

  const laptop = device(t, srv, 'laptop');
  laptop.put('sender', 'shop@example.com', { category: 'promotions' });
  await laptop.signIn({ email: 'B@example.com', password: PASSWORD });
  await laptop.sync();
  assert.deepEqual(laptop.get('category', 'money'), { name: 'Money' });
  assert.deepEqual(laptop.get('sender', 'bank@example.com'), { category: 'money' });

  await desk.sync();
  assert.deepEqual(desk.get('sender', 'shop@example.com'), { category: 'promotions' }, "the laptop's own record went up");
  const details = await desk.details();
  assert.deepEqual(details.devices.map((d) => d.name).sort(), ['desk', 'laptop']);
});

test('the newest change wins, a deletion travels, and the first classification stays', async (t) => {
  const srv = await server(t);
  const desk = device(t, srv, 'desk');
  await desk.signUp({ email: 'c@example.com', password: PASSWORD });
  const laptop = device(t, srv, 'laptop');
  await laptop.signIn({ email: 'c@example.com', password: PASSWORD });

  desk.put('sender', 'x@example.com', { category: 'updates' });
  await desk.sync();
  await laptop.sync();
  laptop.put('sender', 'x@example.com', { category: 'needs-you' });
  await laptop.sync();
  await desk.sync();
  assert.deepEqual(desk.get('sender', 'x@example.com'), { category: 'needs-you' });

  desk.remove('sender', 'x@example.com');
  await desk.sync();
  await laptop.sync();
  assert.equal(laptop.get('sender', 'x@example.com'), undefined);

  desk.put('classification', 'c@example.com\n<m1@x>', { category: 'money' }, { ifAbsent: true });
  laptop.put('classification', 'c@example.com\n<m1@x>', { category: 'updates' }, { ifAbsent: true });
  await desk.sync();
  await laptop.sync();
  assert.deepEqual(laptop.get('classification', 'c@example.com\n<m1@x>'), { category: 'money' }, 'the server kept the first one');
  assert.equal(laptop.status().pending, 0);
});

test('signing in with a wrong password fails without signing in', async (t) => {
  const srv = await server(t);
  const desk = device(t, srv);
  await desk.signUp({ email: 'd@example.com', password: PASSWORD });
  const other = device(t, srv, 'other');
  await assert.rejects(other.signIn({ email: 'd@example.com', password: 'not the password!' }), { code: 'unauthorized' });
  await assert.rejects(other.signIn({ email: 'nobody@example.com', password: PASSWORD }), { code: 'unauthorized' });
  assert.equal(other.status().signedIn, false);
});

test('sign-up checks the address and the password length first', async (t) => {
  const srv = await server(t);
  const desk = device(t, srv);
  await assert.rejects(desk.signUp({ email: 'not an address', password: PASSWORD }), { code: 'invalid_email' });
  await assert.rejects(desk.signUp({ email: 'e@example.com', password: 'short' }), { code: 'weak_password' });
  assert.equal(srv.calls.length, 0);
});

test('a server that hands out a weak password hash is refused', async (t) => {
  const srv = await server(t, { kdf: { alg: 'argon2id', m: 1024, t: 1, p: 1 } });
  const desk = device(t, srv);
  await assert.rejects(desk.signIn({ email: 'f@example.com', password: PASSWORD }), { code: 'weak_kdf' });
});

test('invite-only and closed servers say so', async (t) => {
  const invite = await server(t, { signups: 'invite', invites: ['WELCOME'] });
  const a = device(t, invite);
  await assert.rejects(a.signUp({ email: 'g@example.com', password: PASSWORD }), { code: 'invite_required' });
  await a.signUp({ email: 'g@example.com', password: PASSWORD, invite: ' WELCOME ' });
  assert.equal(a.status().signedIn, true);
  const closed = await server(t, { signups: 'closed' });
  await assert.rejects(device(t, closed).signUp({ email: 'h@example.com', password: PASSWORD }), { code: 'signups_closed' });
});

test('a changed password signs other devices out, and a typo does not sign this one out', async (t) => {
  const srv = await server(t);
  const desk = device(t, srv, 'desk');
  await desk.signUp({ email: 'i@example.com', password: PASSWORD });
  desk.put('category', 'to-read', { name: 'To read' });
  await desk.sync();
  const laptop = device(t, srv, 'laptop');
  await laptop.signIn({ email: 'i@example.com', password: PASSWORD });

  await assert.rejects(desk.changePassword('wrong password!!', 'another long password'), { code: 'wrong_password' });
  assert.equal(desk.status().signedIn, true);
  await desk.changePassword(PASSWORD, 'another long password');
  await assert.rejects(laptop.sync(), { code: 'signed_out' });
  assert.equal(laptop.status().signedIn, false);
  assert.equal(laptop.status().error, 'signed_out');

  const phone = device(t, srv, 'phone');
  await phone.signIn({ email: 'i@example.com', password: 'another long password' });
  await phone.sync();
  assert.deepEqual(phone.get('category', 'to-read'), { name: 'To read' }, 'the same data key under the new password');
});

test('the recovery key sets a new password and keeps the data', async (t) => {
  const srv = await server(t);
  const desk = device(t, srv, 'desk');
  const { recoveryKey } = await desk.signUp({ email: 'j@example.com', password: PASSWORD });
  desk.put('sender', 'boss@example.com', { category: 'needs-you' });
  await desk.sync();

  const phone = device(t, srv, 'phone');
  await assert.rejects(phone.recover({ email: 'j@example.com', recoveryKey: 'nope', password: 'brand new password' }), { code: 'recovery_key' });
  await assert.rejects(
    phone.recover({ email: 'j@example.com', recoveryKey: k.formatRecoveryKey(crypto.randomBytes(20)), password: 'brand new password' }),
    { code: 'unauthorized' }
  );
  await phone.recover({ email: 'j@example.com', recoveryKey: recoveryKey.toLowerCase(), password: 'brand new password' });
  await phone.sync();
  assert.deepEqual(phone.get('sender', 'boss@example.com'), { category: 'needs-you' });
  await assert.rejects(desk.sync(), { code: 'signed_out' }, 'recovery signs every device out');

  const { recoveryKey: next } = await phone.newRecoveryKey('brand new password');
  assert.notEqual(next, recoveryKey);
  await phone.signOut();
  await assert.rejects(phone.recover({ email: 'j@example.com', recoveryKey, password: 'yet another password' }), { code: 'unauthorized' });
});

test('signing in again on this computer survives a restart, and signing out keeps local data', async (t) => {
  const srv = await server(t);
  const dir = tmpDir(t);
  const first = device(t, srv, 'desk', dir);
  await first.signUp({ email: 'k@example.com', password: PASSWORD });
  first.put('category', 'updates', { name: 'Updates' });
  await first.sync();
  first.close();

  const again = device(t, srv, 'desk', dir);
  assert.equal(again.status().signedIn, true);
  assert.deepEqual(again.get('category', 'updates'), { name: 'Updates' });
  again.put('category', 'promotions', { name: 'Promotions' });
  await again.sync();
  assert.equal(srv.accounts.get('k@example.com').records.size, 2);

  await again.signOut();
  assert.equal(again.status().signedIn, false);
  assert.deepEqual(again.get('category', 'promotions'), { name: 'Promotions' });
  const saved = fs.readFileSync(path.join(dir, 'account.json'), 'utf8');
  assert.ok(!saved.includes('token') && !saved.includes('dataKey'), 'no session left on disk');
});

test('a device that was removed elsewhere finds itself signed out', async (t) => {
  const srv = await server(t);
  const desk = device(t, srv, 'desk');
  await desk.signUp({ email: 'l@example.com', password: PASSWORD });
  const laptop = device(t, srv, 'laptop');
  await laptop.signIn({ email: 'l@example.com', password: PASSWORD });
  const { devices } = await desk.details();
  await desk.removeDevice(devices.find((d) => d.name === 'laptop').id);
  await assert.rejects(laptop.sync(), { code: 'signed_out' });
  assert.equal(laptop.status().signedIn, false);
});

test('deleting the account needs the password and clears the server', async (t) => {
  const srv = await server(t);
  const desk = device(t, srv);
  await desk.signUp({ email: 'm@example.com', password: PASSWORD });
  await assert.rejects(desk.deleteAccount('wrong password!!'), { code: 'wrong_password' });
  await desk.deleteAccount(PASSWORD);
  assert.equal(srv.accounts.has('m@example.com'), false);
  assert.equal(desk.status().signedIn, false);
});

test('many records go up and come down in pages', async (t) => {
  const srv = await server(t, { limit: 50 });
  const desk = device(t, srv, 'desk');
  await desk.signUp({ email: 'n@example.com', password: PASSWORD });
  for (let i = 0; i < 620; i++) desk.put('classification', `n@example.com\n<${i}@x>`, { category: 'updates' }, { ifAbsent: true });
  await desk.sync();
  const laptop = device(t, srv, 'laptop');
  await laptop.signIn({ email: 'n@example.com', password: PASSWORD });
  await laptop.sync();
  assert.equal(laptop.list('classification').length, 620);
  assert.equal(laptop.status().counts.classification, 620);
});

test('the export holds every record, readable', async (t) => {
  const srv = await server(t);
  const desk = device(t, srv);
  desk.put('category', 'money', { name: 'Money' });
  const data = desk.exportData();
  assert.equal(data.email, null);
  assert.deepEqual(data.records.map((r) => [r.collection, r.key, r.value]), [['category', 'money', { name: 'Money' }]]);
});

test('without a server the account says so', async (t) => {
  const desk = new AccountService({ dataDir: tmpDir(t), secrets, defaultServer: '', deviceName: 'desk' }).init();
  await assert.rejects(desk.signUp({ email: 'o@example.com', password: PASSWORD }), { code: 'no_server' });
  assert.throws(() => desk.setServer('http://example.com'), { code: 'no_server' });
  desk.setServer('https://sync.example.com');
  assert.equal(desk.status().server, 'https://sync.example.com');
});
