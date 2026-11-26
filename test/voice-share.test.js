'use strict';

// Rukoo Voice's bucket on the user's other computers (src/main/voice/share.js): two computers, each with its own
// Rukoo profile signed in to one account on the fake account server and its own fake Voice. Voice's side of
// sync.settings.* is the fake's (test/fixtures/voice-server.js); Voice's real behavior is tested in voice-engine.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tempDir } = require('./tmp');
const { startVoiceServer } = require('./fixtures/voice-server');
const { startAccountServer } = require('./fixtures/account-server');
const { AccountService } = require('../src/main/account');
const { VoiceService } = require('../src/main/voice');
const { VoiceShare } = require('../src/main/voice/share');
const keys = require('../src/main/account/crypto');

const secrets = { encrypt: (s) => `plain:${Buffer.from(s).toString('base64')}`, decrypt: (s) => Buffer.from(String(s).slice(6), 'base64').toString() };
const PASSWORD = 'a long enough password';
const EMAIL = 'share@example.com';
const OTHER = 'someone-else@example.com';
const FAST = { backoffMs: [30], pollMs: 50, heartbeatMs: 0 };

// What Voice on the first computer syncs to. Demo values: no real bucket.
const BUCKET = {
  service: 'other',
  endpoint: 'http://127.0.0.1:9000',
  region: 'us-east-1',
  bucket: 'test',
  prefix: '',
  accessKeyId: 'test',
  urlStyle: 'path',
  retention: 'keep',
  secret: 'test-secret-4711',
  key: 'RKV1-AAAAA-BBBBB-CCCCC-DDDDD-EEEEE-FFFFF-GGGGG-HHHHH-JJJJJ-KKKKK-MMMMM'
};

async function until(check, what, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 15));
  }
}

// One computer: a Rukoo profile with its account, its Voice service and the share, and a fake Voice. options: the
// share's own (setTimeoutMs, retryMs).
async function computer(t, srv, name, syncSettings, options = {}) {
  const dir = tempDir('rukoo-voice-share-');
  const file = path.join(dir, 'voice-bridge.json');
  const fake = await startVoiceServer({ file });
  fake.syncSettings = syncSettings;
  fake.writeDiscovery();
  t.after(() => fake.close());
  const account = new AccountService({ dataDir: path.join(dir, 'data'), secrets, defaultServer: srv.url, deviceName: name, platform: 'linux' }).init();
  t.after(() => account.close());
  const voice = new VoiceService({ dataDir: path.join(dir, 'data'), discovery: file, appVersion: '9.9.9', bridge: FAST, emitMs: 10 }).init();
  t.after(() => voice.close());
  const share = new VoiceShare({ account, voice, dataDir: path.join(dir, 'data'), ...options }).init();
  t.after(() => share.close());
  await until(() => voice.connected, `${name} connects to Voice`);
  return { dir, fake, account, voice, share };
}

async function server(t) {
  const srv = await startAccountServer();
  t.after(() => srv.close());
  return srv;
}

const sets = (c) => c.fake.commands.filter((m) => m.command === 'sync.settings.set');

// The records the server holds for email, opened with the keys of account, signed in to it: what any device of the
// account reads before it knows the collection.
const opened = (srv, email, account) => [...srv.accounts.get(email).records.entries()].filter(([, r]) => r.data).map(([id, r]) => keys.openRecord(account.session.keys, id, r.data));

test('another computer uses the bucket one computer shares, and follows it after that', async (t) => {
  const srv = await server(t);
  const desk = await computer(t, srv, 'Desk', { ...BUCKET });
  const laptop = await computer(t, srv, 'Laptop', null);
  await desk.account.signUp({ email: EMAIL, password: PASSWORD });
  await laptop.account.signIn({ email: EMAIL, password: PASSWORD });

  // Off by default: nothing goes into the account.
  await desk.share.check();
  assert.deepEqual(
    { share: desk.share.state().share, syncHere: desk.share.state().syncHere, offer: desk.share.state().offer },
    { share: false, syncHere: true, offer: null }
  );
  assert.equal(desk.account.get('voicesync', 'bucket'), undefined);

  // On: the bucket, its secret and its key go into the account, sealed by the account on the way.
  const on = await desk.share.setShare(true);
  assert.equal(on.share, true);
  assert.equal(on.error, null);
  const record = desk.account.getSealed('voicesync', 'bucket');
  assert.deepEqual(record.settings, BUCKET);
  assert.equal(record.device, 'Desk');
  await desk.account.sync();
  const stored = [...srv.accounts.get(EMAIL).records.values()];
  assert.ok(stored.length > 0);
  for (const r of stored) assert.ok(!Buffer.from(r.data || '', 'base64url').toString('latin1').includes(BUCKET.secret), 'the server holds sealed bytes only');

  // The laptop's Voice syncs nowhere: it offers the desk's bucket, naming the computer and the bucket only.
  await laptop.account.sync();
  await until(() => laptop.share.state().offer, 'the offer');
  const offered = laptop.share.state();
  assert.deepEqual(offered.offer && { device: offered.offer.device, bucket: offered.offer.bucket }, { device: 'Desk', bucket: 'test' });
  assert.ok(!JSON.stringify(offered).includes(BUCKET.secret) && !JSON.stringify(offered).includes(BUCKET.key), 'the renderer never gets the secret or the key');

  // Use it here too: Voice takes the settings, and the offer goes.
  const used = await laptop.share.use();
  assert.equal(used.error, null, JSON.stringify(used));
  assert.equal(used.follow, true);
  assert.equal(used.offer, null);
  assert.deepEqual(laptop.fake.syncSettings, BUCKET);
  assert.equal(sets(laptop).length, 1);

  // A new secret on the desk reaches the laptop's Voice by itself.
  desk.fake.syncSettings = { ...BUCKET, secret: 'a-new-secret' };
  await desk.share.check();
  assert.equal(desk.account.getSealed('voicesync', 'bucket').settings.secret, 'a-new-secret');
  await desk.account.sync();
  await laptop.account.sync();
  await until(() => laptop.fake.syncSettings.secret === 'a-new-secret', 'the new secret on the laptop');
  assert.equal(laptop.share.state().offer, null);

  // Nothing changed: no command goes to Voice again.
  const before = sets(laptop).length;
  await laptop.share.check();
  assert.equal(sets(laptop).length, before);

  // Off on the desk: the record goes from the account.
  await desk.share.setShare(false);
  assert.equal(desk.account.get('voicesync', 'bucket'), undefined);
  await desk.account.sync();
  await laptop.account.sync();
  await until(() => laptop.account.get('voicesync', 'bucket') === undefined, 'the record gone on the laptop');
});

test('a refusal leaves the offer with its reason; an automatic use tries again after a failure that may pass, not after a refusal', async (t) => {
  const srv = await server(t);
  const desk = await computer(t, srv, 'Desk', { ...BUCKET });
  const laptop = await computer(t, srv, 'Laptop', { ...BUCKET, bucket: 'own', key: 'RKV1-OWN' }, { retryMs: [150, 600] });
  await desk.account.signUp({ email: EMAIL, password: PASSWORD });
  await laptop.account.signIn({ email: EMAIL, password: PASSWORD });
  await desk.share.setShare(true);
  await desk.account.sync();
  await laptop.account.sync();
  // The laptop syncs to another bucket: still an offer.
  await until(() => laptop.share.state().offer, 'the offer');

  laptop.fake.syncRefusal = { code: 'busy', message: 'This computer already uploaded meetings with its own key, so it keeps that key.', reason: 'key_in_use' };
  const refused = await laptop.share.use();
  assert.deepEqual(refused.error, { action: 'use', code: 'busy', reason: 'key_in_use' });
  assert.ok(refused.offer, 'the offer stays');
  assert.equal(refused.follow, false);
  assert.equal(laptop.fake.syncSettings.bucket, 'own', 'nothing changed');

  // Once it works, later changes apply by themselves.
  laptop.fake.syncRefusal = null;
  assert.equal((await laptop.share.use()).follow, true);

  // The bucket is down for a while: Test connection fails, and Rukoo tries again later by itself, waiting longer.
  laptop.fake.syncRefusal = { code: 'failed', message: "Rukoo Voice couldn't reach the bucket.", reason: 'test' };
  desk.fake.syncSettings = { ...BUCKET, secret: 'another' };
  await desk.share.check();
  await desk.account.sync();
  await laptop.account.sync();
  await until(() => laptop.share.state().error, 'the failed automatic use');
  assert.equal(laptop.share.state().error.reason, 'test');
  assert.ok(laptop.share.state().offer, 'offered again after a failed automatic use');
  const first = sets(laptop).length;
  await laptop.share.check();
  assert.equal(sets(laptop).length, first, 'not at once');
  // The retry timer makes the try due when it fires (see the next test); the wait leaves room for a loaded runner.
  await until(() => sets(laptop).length > first, 'the second try', 10000);
  laptop.fake.syncRefusal = null;
  await until(() => laptop.fake.syncSettings.secret === 'another', 'the use once the bucket is back', 5000);
  await until(() => laptop.share.state().error === null, 'the error gone');
  assert.equal(laptop.share.state().offer, null);

  // A refusal for good (Voice keeps its own key now) waits for the record to change, however long.
  laptop.fake.syncRefusal = { code: 'busy', message: 'This computer already uploaded meetings with its own key, so it keeps that key.', reason: 'key_in_use' };
  desk.fake.syncSettings = { ...BUCKET, secret: 'a-third' };
  await desk.share.check();
  await desk.account.sync();
  await laptop.account.sync();
  await until(() => laptop.share.state().error, 'the refused automatic use');
  const tries = sets(laptop).length;
  await new Promise((r) => setTimeout(r, 800));
  await laptop.share.check();
  assert.equal(sets(laptop).length, tries);
});

test('an automatic use goes again when its timer fires, also when the clock reads a little behind the timer', async (t) => {
  const srv = await server(t);
  const desk = await computer(t, srv, 'Desk', { ...BUCKET });
  // A clock at half speed: each timer fires before this.now() reaches the time the retry was due, as a real timer
  // can by a millisecond. The try must still go.
  const start = Date.now();
  const slow = () => start + Math.floor((Date.now() - start) / 2);
  const laptop = await computer(t, srv, 'Laptop', null, { retryMs: [150, 600], now: slow });
  await desk.account.signUp({ email: EMAIL, password: PASSWORD });
  await laptop.account.signIn({ email: EMAIL, password: PASSWORD });
  await desk.share.setShare(true);
  await desk.account.sync();
  await laptop.account.sync();
  await until(() => laptop.share.state().offer, 'the offer');
  assert.equal((await laptop.share.use()).follow, true);

  laptop.fake.syncRefusal = { code: 'failed', message: "Rukoo Voice couldn't reach the bucket." };
  desk.fake.syncSettings = { ...BUCKET, secret: 'behind' };
  await desk.share.check();
  await desk.account.sync();
  await laptop.account.sync();
  await until(() => laptop.share.state().error, 'the failed automatic use');
  const first = sets(laptop).length;
  await until(() => sets(laptop).length > first, 'the second try', 10000);
  await until(() => sets(laptop).length > first + 1, 'the third try, after a longer wait', 10000);
  laptop.fake.syncRefusal = null;
  await until(() => laptop.fake.syncSettings.secret === 'behind', 'the use once the bucket is back', 10000);
});

test('while Voice takes or puts back settings it hands over none: Rukoo shares nothing, changes no choice and looks again soon', async (t) => {
  const srv = await server(t);
  const desk = await computer(t, srv, 'Desk', { ...BUCKET }, { againMs: 100 });
  const laptop = await computer(t, srv, 'Laptop', null, { againMs: 100 });
  await desk.account.signUp({ email: EMAIL, password: PASSWORD });
  await laptop.account.signIn({ email: EMAIL, password: PASSWORD });
  const applying = () => ({ error: { code: 'busy', message: 'Voice is changing its bucket settings; ask again later.', reason: 'applying' } });

  // Turning sharing on then says why, and puts nothing in the account.
  desk.fake.handlers['sync.settings.get'] = applying;
  const refused = await desk.share.setShare(true);
  assert.deepEqual({ share: refused.share, error: refused.error }, { share: false, error: { action: 'share', code: 'busy', reason: 'applying' } });
  assert.equal(desk.account.get('voicesync', 'bucket'), undefined);
  delete desk.fake.handlers['sync.settings.get'];
  assert.equal((await desk.share.setShare(true)).share, true);
  await desk.account.sync();
  await laptop.account.sync();
  await until(() => laptop.share.state().offer, 'the offer');
  assert.equal((await laptop.share.use()).follow, true);

  // The desk's Voice is in the middle of a change: its settings stay out of the account until it answers again.
  desk.fake.handlers['sync.settings.get'] = applying;
  desk.fake.syncSettings = { ...BUCKET, secret: 'after-the-change' };
  await desk.share.check();
  assert.equal(desk.account.getSealed('voicesync', 'bucket').settings.secret, BUCKET.secret, 'not shared while Voice changes');
  assert.deepEqual({ share: desk.share.state().share, error: desk.share.state().error }, { share: true, error: null });

  // The laptop's Voice too: Rukoo sends nothing and keeps following.
  laptop.fake.handlers['sync.settings.get'] = applying;
  const before = sets(laptop).length;
  const seen = laptop.share.prefs.seen;
  delete desk.fake.handlers['sync.settings.get'];
  // The desk looks again by itself and shares the settings Voice uses once it is done.
  await until(() => desk.account.getSealed('voicesync', 'bucket').settings.secret === 'after-the-change', 'the desk shares after the change');
  await desk.account.sync();
  await laptop.account.sync();
  await laptop.share.check();
  assert.equal(sets(laptop).length, before, 'nothing sent while Voice changes');
  assert.deepEqual({ follow: laptop.share.state().follow, error: laptop.share.state().error }, { follow: true, error: null });
  assert.equal(laptop.share.prefs.seen, seen, "Voice's refusal isn't taken for a change made there");
  delete laptop.fake.handlers['sync.settings.get'];
  // The laptop looks again by itself, and uses the new secret.
  await until(() => laptop.fake.syncSettings.secret === 'after-the-change', 'the laptop uses the new secret');
  assert.equal(laptop.share.state().follow, true);
});

test('a use whose answer was lost counts once Voice says it uses the bucket', async (t) => {
  const srv = await server(t);
  const desk = await computer(t, srv, 'Desk', { ...BUCKET });
  const laptop = await computer(t, srv, 'Laptop', null, { setTimeoutMs: 100 });
  await desk.account.signUp({ email: EMAIL, password: PASSWORD });
  await laptop.account.signIn({ email: EMAIL, password: PASSWORD });
  await desk.share.setShare(true);
  await desk.account.sync();
  await laptop.account.sync();
  await until(() => laptop.share.state().offer, 'the offer');
  // Test connection takes longer than Rukoo waits; Voice finishes anyway.
  laptop.fake.syncSetMs = 400;
  const late = await laptop.share.use();
  assert.equal(late.error && late.error.code, 'timeout');
  assert.equal(late.follow, false);
  await until(() => laptop.fake.syncSettings, 'Voice to finish');
  await laptop.share.check();
  const state = laptop.share.state();
  assert.deepEqual({ follow: state.follow, error: state.error, offer: state.offer }, { follow: true, error: null, offer: null });
  assert.equal(sets(laptop).length, 1, 'used once');
});

test('a use whose answer was lost waits for Voice to finish, also past looks that come first, for a while only', async (t) => {
  const srv = await server(t);
  const desk = await computer(t, srv, 'Desk', { ...BUCKET });
  const laptop = await computer(t, srv, 'Laptop', null, { setTimeoutMs: 100, unsureMs: 2000 });
  await desk.account.signUp({ email: EMAIL, password: PASSWORD });
  await laptop.account.signIn({ email: EMAIL, password: PASSWORD });
  await desk.share.setShare(true);
  await desk.account.sync();
  await laptop.account.sync();
  await until(() => laptop.share.state().offer, 'the offer');

  // Rukoo stops waiting, then looks while Voice is still testing the bucket: Voice says it syncs nowhere yet.
  laptop.fake.syncSetMs = 600;
  assert.equal((await laptop.share.use()).error.code, 'timeout');
  await laptop.share.check();
  assert.equal(laptop.fake.syncSettings, null, 'Voice is still at it');
  await laptop.share.check();
  // Voice finishes: the next look counts the use, and Rukoo follows the record.
  await until(() => laptop.fake.syncSettings, 'Voice to finish');
  await laptop.share.check();
  const state = laptop.share.state();
  assert.deepEqual({ follow: state.follow, error: state.error, offer: state.offer }, { follow: true, error: null, offer: null });
  assert.equal(sets(laptop).length, 1, 'used once');

  // A use that never shows in Voice stops counting once the time is up: the error and the offer stay.
  desk.fake.syncSettings = { ...BUCKET, secret: 'never-used' };
  await desk.share.check();
  await desk.account.sync();
  laptop.fake.syncSetMs = 400;
  laptop.fake.syncRefusal = { code: 'failed', message: 'The bucket is down.', reason: 'test' };
  await laptop.account.sync();
  await until(() => laptop.share.state().error, 'the lost automatic use');
  assert.equal(laptop.share.state().error.code, 'timeout');
  const tries = sets(laptop).length;
  await laptop.share.check();
  assert.equal(sets(laptop).length, tries, 'not sent again while Voice may still be at it');
  assert.ok(laptop.share.unsure, 'still waiting for Voice');
  await new Promise((r) => setTimeout(r, 2100));
  await laptop.share.check();
  assert.equal(laptop.share.unsure, null, 'no longer waiting');
  assert.ok(laptop.share.state().error);
});

test('a computer whose sync was off for a while shares the bucket it uses once sync is back', async (t) => {
  const srv = await server(t);
  const desk = await computer(t, srv, 'Desk', { ...BUCKET });
  const laptop = await computer(t, srv, 'Laptop', { ...BUCKET });
  await desk.account.signUp({ email: EMAIL, password: PASSWORD });
  await laptop.account.signIn({ email: EMAIL, password: PASSWORD });
  await desk.share.setShare(true);
  await laptop.share.setShare(true);

  // Sync off in the desk's Voice, and back on with a new secret: the account gets the new secret.
  desk.fake.syncSettings = null;
  await desk.share.check();
  assert.equal(desk.account.getSealed('voicesync', 'bucket').settings.secret, BUCKET.secret);
  desk.fake.syncSettings = { ...BUCKET, secret: 'after-a-pause' };
  await desk.share.check();
  assert.equal(desk.account.getSealed('voicesync', 'bucket').settings.secret, 'after-a-pause');
  await desk.account.sync();

  // Sharing off on the desk removes the record. Sync off and on again on the laptop with the same settings doesn't
  // bring it back; a moved bucket there does.
  await desk.share.setShare(false);
  await desk.account.sync();
  await laptop.account.sync();
  await until(() => laptop.account.get('voicesync', 'bucket') === undefined, 'the removal on the laptop');
  await laptop.share.check();
  laptop.fake.syncSettings = null;
  await laptop.share.check();
  laptop.fake.syncSettings = { ...BUCKET };
  await laptop.share.check();
  assert.equal(laptop.account.get('voicesync', 'bucket'), undefined, 'the same bucket is not shared again');
  laptop.fake.syncSettings = null;
  await laptop.share.check();
  laptop.fake.syncSettings = { ...BUCKET, bucket: 'moved' };
  await laptop.share.check();
  assert.equal(laptop.account.getSealed('voicesync', 'bucket').settings.bucket, 'moved');
});

test('a computer that changes its own bucket stops following, and an older Voice shows as such', async (t) => {
  const srv = await server(t);
  const desk = await computer(t, srv, 'Desk', { ...BUCKET });
  const laptop = await computer(t, srv, 'Laptop', null);
  await desk.account.signUp({ email: EMAIL, password: PASSWORD });
  await laptop.account.signIn({ email: EMAIL, password: PASSWORD });
  await desk.share.setShare(true);
  await desk.account.sync();
  await laptop.account.sync();
  await until(() => laptop.share.state().offer, 'the offer');
  await laptop.share.use();
  // The user turned sync off in the laptop's Voice: Rukoo doesn't turn it back on, and offers the bucket again.
  laptop.fake.syncSettings = null;
  await laptop.share.check();
  assert.equal(laptop.share.state().follow, false);
  assert.ok(laptop.share.state().offer);
  assert.equal(sets(laptop).length, 1);

  // The desk doesn't offer its own bucket back, also once its Voice stopped syncing to it.
  desk.fake.syncSettings = null;
  await desk.share.check();
  assert.equal(desk.share.state().offer, null);

  // An older Voice answers unknown_command.
  laptop.fake.handlers['sync.settings.get'] = () => ({ error: { code: 'unknown_command', message: 'sync.settings.get' } });
  await laptop.share.check();
  assert.equal(laptop.share.state().supported, false);
  await laptop.share.check();
  // Voice was updated and connects again: Rukoo asks again, without a restart of its own.
  delete laptop.fake.handlers['sync.settings.get'];
  laptop.fake.drop();
  await until(() => laptop.share.state().supported === true, 'the new Voice asked again');
});

test('turned off on one computer, the record stays removed until the bucket changes where it is still on', async (t) => {
  const srv = await server(t);
  const desk = await computer(t, srv, 'Desk', { ...BUCKET });
  const laptop = await computer(t, srv, 'Laptop', { ...BUCKET });
  await desk.account.signUp({ email: EMAIL, password: PASSWORD });
  await laptop.account.signIn({ email: EMAIL, password: PASSWORD });
  await desk.share.setShare(true);
  await desk.account.sync();
  await laptop.account.sync();
  assert.equal((await laptop.share.setShare(true)).share, true);
  await laptop.account.sync();

  await desk.share.setShare(false);
  await desk.account.sync();
  await laptop.account.sync();
  await until(() => laptop.account.get('voicesync', 'bucket') === undefined, 'the removal on the laptop');
  await laptop.share.check();
  assert.equal(laptop.account.get('voicesync', 'bucket'), undefined, 'not shared again by itself');
  await laptop.account.sync();
  await desk.account.sync();
  assert.equal(desk.account.get('voicesync', 'bucket'), undefined);

  // A new secret on the laptop, where sharing is still on: shared again.
  laptop.fake.syncSettings = { ...BUCKET, secret: 'laptop-secret' };
  await laptop.share.check();
  assert.equal(laptop.account.getSealed('voicesync', 'bucket').settings.secret, 'laptop-secret');
});

test('an older Rukoo or the phone that keeps every record holds only sealed bytes of the bucket', async (t) => {
  const srv = await server(t);
  const desk = await computer(t, srv, 'Desk', { ...BUCKET });
  await desk.account.signUp({ email: EMAIL, password: PASSWORD });
  await desk.share.setShare(true);
  await desk.account.sync();

  // A device of the same account that reads records the generic way: keys.openRecord on what the server sends, as
  // every Rukoo and the Android app do before they look at the collection.
  const records = opened(srv, EMAIL, desk.account).filter((r) => r && r.c === 'voicesync');
  assert.equal(records.length, 1);
  assert.deepEqual(Object.keys(records[0].v), ['sealed']);
  const text = JSON.stringify(records[0]);
  for (const secret of [BUCKET.secret, BUCKET.key, BUCKET.accessKeyId === 'test' ? BUCKET.endpoint : BUCKET.accessKeyId]) assert.ok(!text.includes(secret), `no ${secret.slice(0, 8)}… in the record`);

  // Such a device keeps the record and its export lists every record it keeps: still only sealed bytes. An
  // AccountService without the share reads it so, signed in to the account.
  const dir = tempDir('rukoo-voice-share-older-');
  const older = new AccountService({ dataDir: dir, secrets, defaultServer: srv.url, deviceName: 'Older', platform: 'linux' }).init();
  t.after(() => older.close());
  await older.signIn({ email: EMAIL, password: PASSWORD });
  await older.sync();
  const kept = older.get('voicesync', 'bucket');
  assert.equal(typeof kept.sealed, 'string');
  const everything = JSON.stringify([...older.entries.values()].map((e) => ({ collection: e.c, key: e.k, value: e.v })));
  assert.ok(everything.includes('voicesync'));
  assert.ok(!everything.includes(BUCKET.secret) && !everything.includes(BUCKET.key), 'an export of every record holds no secret');
  // The inner seal is bound to its collection and key: it doesn't open as another record.
  assert.equal(keys.openInner(older.session.dataKey, 'voicesync', 'other', kept.sealed), undefined);
  assert.deepEqual(keys.openInner(older.session.dataKey, 'voicesync', 'bucket', kept.sealed).settings, BUCKET);
});

test('a share or a use that outlives its account writes nothing into the next one', async (t) => {
  const srv = await server(t);
  const desk = await computer(t, srv, 'Desk', { ...BUCKET });
  await desk.account.signUp({ email: EMAIL, password: PASSWORD });

  // Voice answers late; meanwhile the user signs out and into another account.
  const waiting = [];
  const fake = desk.fake;
  // Answers wait until release(); the ones after it don't.
  const release = () => {
    delete fake.handlers['sync.settings.get'];
    waiting.splice(0).forEach((resolve) => resolve({ settings: fake.syncSettings }));
  };
  fake.handlers['sync.settings.get'] = () => new Promise((resolve) => waiting.push(resolve));
  const pending = desk.share.setShare(true);
  await until(() => waiting.length, 'Voice asked');
  await desk.account.signOut();
  await desk.account.signUp({ email: OTHER, password: PASSWORD });
  release();
  const after = await pending;
  assert.equal(after.share, false);
  assert.equal(desk.account.get('voicesync', 'bucket'), undefined);
  await desk.account.sync();
  assert.ok(!opened(srv, OTHER, desk.account).some((r) => r && r.c === 'voicesync'), 'nothing reached the other account');

  // A use whose answer comes after the switch keeps no choice for the account signed in then.
  const laptop = await computer(t, srv, 'Laptop', null);
  await desk.account.signOut();
  await desk.account.signIn({ email: EMAIL, password: PASSWORD });
  await desk.share.setShare(true);
  await desk.account.sync();
  await laptop.account.signIn({ email: EMAIL, password: PASSWORD });
  await laptop.account.sync();
  await until(() => laptop.share.state().offer, 'the offer');
  laptop.fake.syncSetMs = 300;
  const using = laptop.share.use();
  await until(() => sets(laptop).length === 1, 'Voice asked to use it');
  await laptop.account.signOut();
  await laptop.account.signIn({ email: OTHER, password: PASSWORD });
  const used = await using;
  assert.equal(used.follow, false);
  assert.equal(used.error, null);
  assert.equal(laptop.share.prefs.follow, undefined, 'no choice kept for the other account');
});

test('the choices and the record go when the account signs out, and stay out of the export', async (t) => {
  const srv = await server(t);
  const desk = await computer(t, srv, 'Desk', { ...BUCKET });
  await desk.account.signUp({ email: EMAIL, password: PASSWORD });
  await desk.share.setShare(true);
  await desk.account.sync();
  const exported = JSON.stringify(desk.account.exportData());
  assert.ok(!exported.includes('voicesync') && !exported.includes(BUCKET.secret), 'not in Export my data');
  await desk.account.signOut();
  assert.equal(desk.account.get('voicesync', 'bucket'), undefined);
  await until(() => desk.share.state().share === false, 'the choice gone');
  desk.account.flush();
  const kept = fs.readFileSync(path.join(desk.dir, 'data', 'account-records.json'), 'utf8');
  assert.ok(!kept.includes(BUCKET.secret), 'the secret left this computer with the session');
  assert.equal(desk.share.state().signedIn, false);

  // Signing in again brings the record back from the account; the switch starts off on this computer.
  await desk.account.signIn({ email: EMAIL, password: PASSWORD });
  await desk.account.sync();
  assert.deepEqual(desk.account.getSealed('voicesync', 'bucket').settings, BUCKET);
  assert.equal(desk.share.state().share, false);
});

test('on disk the record is sealed with the keystore, and a restart opens it again', async (t) => {
  const srv = await server(t);
  const desk = await computer(t, srv, 'Desk', { ...BUCKET });
  await desk.account.signUp({ email: EMAIL, password: PASSWORD });
  await desk.share.setShare(true);
  await desk.account.sync();
  desk.account.flush();
  const file = path.join(desk.dir, 'data', 'account-records.json');
  const kept = JSON.parse(fs.readFileSync(file, 'utf8')).entries.find((e) => e.c === 'voicesync');
  assert.equal(kept.v, undefined, 'no readable value');
  assert.ok(kept.sv.startsWith('plain:'), 'sealed through secrets.encrypt (the test keystore is plain:)');
  assert.ok(!JSON.stringify(kept).includes(BUCKET.key));

  desk.account.close();
  const again = new AccountService({ dataDir: path.join(desk.dir, 'data'), secrets, defaultServer: srv.url, deviceName: 'Desk', platform: 'linux' }).init();
  t.after(() => again.close());
  assert.deepEqual(again.getSealed('voicesync', 'bucket').settings, BUCKET);

  // A keystore that no longer opens it (another user or computer): the record stays out until the account brings it.
  const locked = {
    encrypt: secrets.encrypt,
    decrypt: (s) => {
      if (s === kept.sv) throw new Error('locked');
      return secrets.decrypt(s);
    }
  };
  again.close();
  const elsewhere = new AccountService({ dataDir: path.join(desk.dir, 'data'), secrets: locked, defaultServer: srv.url, deviceName: 'Desk', platform: 'linux' }).init();
  t.after(() => elsewhere.close());
  assert.equal(elsewhere.get('voicesync', 'bucket'), undefined);
  // Its cursor went back to the beginning, so the next pull brings the record again.
  assert.equal(elsewhere.state.cursor, 0);
  await elsewhere.sync();
  assert.deepEqual(elsewhere.getSealed('voicesync', 'bucket').settings, BUCKET);
});

test('a keystore that refuses a newer value keeps the last sealed copy and the cursor before it, and tries again', async (t) => {
  const srv = await server(t);
  const desk = await computer(t, srv, 'Desk', { ...BUCKET });
  const laptop = await computer(t, srv, 'Laptop', null);
  await desk.account.signUp({ email: EMAIL, password: PASSWORD });
  await laptop.account.signIn({ email: EMAIL, password: PASSWORD });
  await desk.share.setShare(true);
  await desk.account.sync();
  await laptop.account.sync();
  assert.equal(laptop.account.flush(), true);
  const dir = path.join(laptop.dir, 'data');
  const onDisk = () => JSON.parse(fs.readFileSync(path.join(dir, 'account-records.json'), 'utf8')).entries.find((e) => e.c === 'voicesync');
  const cursor = () => JSON.parse(fs.readFileSync(path.join(dir, 'account.json'), 'utf8')).cursor;
  const first = onDisk();
  const before = cursor();
  assert.ok(first && first.sv && before > 0);

  // The keystore refuses from now on (the keyring went away); a newer value arrives.
  let refuse = true;
  laptop.account.secrets = {
    encrypt: (text) => {
      if (refuse) throw new Error('locked');
      return secrets.encrypt(text);
    },
    decrypt: secrets.decrypt
  };
  desk.fake.syncSettings = { ...BUCKET, secret: 'newer' };
  await desk.share.check();
  await desk.account.sync();
  await laptop.account.sync();
  assert.equal(laptop.account.getSealed('voicesync', 'bucket').settings.secret, 'newer');
  assert.equal(laptop.account.flush(), false, 'not written');
  assert.deepEqual(onDisk(), first, 'the last sealed copy stays');
  assert.equal(cursor(), before, "the cursor on disk doesn't pass the value that isn't there");

  // The keystore works again: the retry writes the newer value, and the cursor moves on.
  refuse = false;
  assert.equal(laptop.account.flush(), true);
  assert.notDeepEqual(onDisk(), first);
  laptop.account.saveState();
  assert.ok(cursor() > before);
  const again = new AccountService({ dataDir: dir, secrets, defaultServer: srv.url, deviceName: 'Laptop', platform: 'linux' });
  laptop.account.close();
  again.init();
  t.after(() => again.close());
  assert.equal(again.getSealed('voicesync', 'bucket').settings.secret, 'newer');
});

test('while a meeting records the screen, the switch says so and nothing goes into the account', async (t) => {
  const srv = await server(t);
  const desk = await computer(t, srv, 'Desk', { ...BUCKET });
  await desk.account.signUp({ email: EMAIL, password: PASSWORD });
  desk.fake.handlers['sync.settings.get'] = () => ({ error: { code: 'busy', message: "Stop the meeting's screen recording first.", reason: 'screen' } });
  const refused = await desk.share.setShare(true);
  assert.deepEqual({ share: refused.share, error: refused.error }, { share: false, error: { action: 'share', code: 'busy', reason: 'screen' } });
  assert.equal(desk.account.get('voicesync', 'bucket'), undefined);
  delete desk.fake.handlers['sync.settings.get'];
  const on = await desk.share.setShare(true);
  assert.deepEqual({ share: on.share, error: on.error }, { share: true, error: null });
});
