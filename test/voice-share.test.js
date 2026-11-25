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

const secrets = { encrypt: (s) => `plain:${Buffer.from(s).toString('base64')}`, decrypt: (s) => Buffer.from(String(s).slice(6), 'base64').toString() };
const PASSWORD = 'a long enough password';
const EMAIL = 'share@example.com';
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

// One computer: a Rukoo profile with its account, its Voice service and the share, and a fake Voice.
async function computer(t, srv, name, syncSettings) {
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
  const share = new VoiceShare({ account, voice, dataDir: path.join(dir, 'data') }).init();
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
  const record = desk.account.get('voicesync', 'bucket');
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
  assert.equal(desk.account.get('voicesync', 'bucket').settings.secret, 'a-new-secret');
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

test("a refusal leaves the offer with its reason, and a failed automatic use isn't repeated", async (t) => {
  const srv = await server(t);
  const desk = await computer(t, srv, 'Desk', { ...BUCKET });
  const laptop = await computer(t, srv, 'Laptop', { ...BUCKET, bucket: 'own', key: 'RKV1-OWN' });
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

  // Once it works, later changes apply by themselves; one that fails isn't tried again until the record changes.
  laptop.fake.syncRefusal = null;
  assert.equal((await laptop.share.use()).follow, true);
  laptop.fake.syncRefusal = { code: 'failed', message: 'The bucket refused the access key.', reason: 'test' };
  desk.fake.syncSettings = { ...BUCKET, secret: 'another' };
  await desk.share.check();
  await desk.account.sync();
  await laptop.account.sync();
  await until(() => laptop.share.state().error, 'the failed automatic use');
  assert.equal(laptop.share.state().error.reason, 'test');
  assert.ok(laptop.share.state().offer, 'offered again after a failed automatic use');
  const tries = sets(laptop).length;
  await laptop.share.check();
  assert.equal(sets(laptop).length, tries);
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
  assert.deepEqual(desk.account.get('voicesync', 'bucket').settings, BUCKET);
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
  assert.deepEqual(again.get('voicesync', 'bucket').settings, BUCKET);

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
