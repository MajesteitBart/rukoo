'use strict';

// The desktop's account code against a real account server: the Worker in server/ under `npm run dev`, or a deployed
// one. Set RUKOO_ACCOUNT_TEST_SERVER to its address (http://127.0.0.1:8787 for `wrangler dev`); without it these
// tests skip. They make throwaway accounts and delete them again. The server must allow sign-ups ("open"), or take
// the invite code in RUKOO_ACCOUNT_TEST_INVITE.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { AccountService } = require('../src/main/account');
const k = require('../src/main/account/crypto');

const SERVER = process.env.RUKOO_ACCOUNT_TEST_SERVER || '';
const INVITE = process.env.RUKOO_ACCOUNT_TEST_INVITE || '';
const skip = SERVER ? false : 'set RUKOO_ACCOUNT_TEST_SERVER to run against a real account server';
const secrets = { encrypt: (s) => `plain:${Buffer.from(s).toString('base64')}`, decrypt: (s) => Buffer.from(String(s).slice(6), 'base64').toString() };
const PASSWORD = 'a long enough password';

const email = () => `test-${crypto.randomBytes(6).toString('hex')}@example.com`;

function device(t, name, platform = 'linux') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rukoo-account-live-'));
  const acc = new AccountService({ dataDir: dir, secrets, defaultServer: SERVER, deviceName: name, platform }).init();
  t.after(() => {
    acc.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return acc;
}

test('the server describes itself', { skip }, async (t) => {
  const info = await device(t, 'desk').serverInfo();
  assert.equal(info.protocol, 1);
  assert.ok(['open', 'invite', 'closed'].includes(info.signups));
  assert.ok(info.limits.batch > 0);
});

test('two devices share records, conflicts settle, and the account goes away', { skip }, async (t) => {
  const address = email();
  const desk = device(t, 'desk');
  desk.put('category', 'needs-you', { name: 'Needs you', order: 0 });
  const { recoveryKey } = await desk.signUp({ email: address, password: PASSWORD, invite: INVITE });
  await desk.sync();

  const laptop = device(t, 'laptop', 'darwin');
  laptop.put('sender', 'shop@example.com', { category: 'promotions' });
  await laptop.signIn({ email: address.toUpperCase(), password: PASSWORD });
  await laptop.sync();
  assert.deepEqual(laptop.get('category', 'needs-you'), { name: 'Needs you', order: 0 });
  await desk.sync();
  assert.deepEqual(desk.get('sender', 'shop@example.com'), { category: 'promotions' });

  // The first classification stays; the newest sender rule wins; a deletion travels.
  const key = `${address}\n<m1@example.com>`;
  desk.put('classification', key, { category: 'money' }, { ifAbsent: true });
  laptop.put('classification', key, { category: 'updates' }, { ifAbsent: true });
  await desk.sync();
  await laptop.sync();
  assert.deepEqual(laptop.get('classification', key), { category: 'money' });
  laptop.put('sender', 'shop@example.com', { category: 'to-read' });
  await laptop.sync();
  await desk.sync();
  assert.deepEqual(desk.get('sender', 'shop@example.com'), { category: 'to-read' });
  desk.remove('category', 'needs-you');
  await desk.sync();
  await laptop.sync();
  assert.equal(laptop.get('category', 'needs-you'), undefined);

  // Many records, in pages both ways.
  for (let i = 0; i < 1200; i++) desk.put('classification', `${address}\n<bulk-${i}@example.com>`, { category: 'updates' }, { ifAbsent: true });
  await desk.sync();
  await laptop.sync();
  assert.equal(laptop.list('classification').length, 1201);

  const details = await desk.details();
  assert.deepEqual(details.devices.map((d) => d.name).sort(), ['desk', 'laptop']);
  assert.equal(details.usage.records, 1202, 'a sender rule and 1201 classifications; the deleted category is a tombstone');

  // A wrong password on a signed-in call is a typo, not an ended session.
  await assert.rejects(desk.changePassword('not the password!', 'another long password'), { code: 'wrong_password' });
  assert.equal(desk.status().signedIn, true);
  await desk.changePassword(PASSWORD, 'another long password');
  await assert.rejects(laptop.sync(), { code: 'signed_out' });

  // The recovery key brings the account back under a new password, with the data.
  const phone = device(t, 'phone', 'android');
  await phone.recover({ email: address, recoveryKey, password: 'a recovered password' });
  await phone.sync();
  assert.deepEqual(phone.get('sender', 'shop@example.com'), { category: 'to-read' });
  await assert.rejects(desk.sync(), { code: 'signed_out' });

  // Signing another device out.
  const tablet = device(t, 'tablet');
  await tablet.signIn({ email: address, password: 'a recovered password' });
  const listed = await phone.details();
  await phone.removeDevice(listed.devices.find((d) => d.name === 'tablet').id);
  await assert.rejects(tablet.sync(), { code: 'signed_out' });

  await phone.deleteAccount('a recovered password');
  const again = device(t, 'again');
  await assert.rejects(again.signIn({ email: address, password: 'a recovered password' }), { code: 'unauthorized' });
});

test('prelogin hides whether an account exists', { skip }, async (t) => {
  const desk = device(t, 'desk');
  const address = email();
  const first = await desk.call('POST', '/v1/prelogin', { email: address });
  const second = await desk.call('POST', '/v1/prelogin', { email: address });
  assert.deepEqual(first, second, 'the same made-up salt each time');
  assert.equal(k.unb64u(first.salt).length, 16);
  assert.deepEqual(k.checkKdf(first.kdf), k.DEFAULT_KDF);
});

test('a wrong password and a wrong recovery key are refused, and too many lock the account', { skip }, async (t) => {
  const address = email();
  const desk = device(t, 'desk');
  await desk.signUp({ email: address, password: PASSWORD, invite: INVITE });
  const other = device(t, 'other');
  await assert.rejects(other.recover({ email: address, recoveryKey: k.formatRecoveryKey(crypto.randomBytes(20)), password: 'a different password' }), { code: 'unauthorized' });
  // The account locks after ten failures; the server's limit per address (30 a minute) may stop the guessing first.
  let stopped = false;
  for (let i = 0; i < 12 && !stopped; i++) {
    try {
      await other.signIn({ email: address, password: `wrong password ${i}` });
    } catch (err) {
      if (err.code === 'locked' || err.code === 'rate_limited') stopped = true;
      else assert.equal(err.code, 'unauthorized');
    }
  }
  assert.ok(stopped, 'repeated failures are stopped');
  // The lock may still refuse this; a throwaway server doesn't mind the leftover account.
  await desk.deleteAccount(PASSWORD).catch(() => {});
});
