// Settings > Meetings > Your other computers: Rukoo Voice's bucket shared through the Rukoo account. The real app with
// the demo account, the in-memory account server and a fake Rukoo Voice (test/fixtures/voice-server.js) paired
// through <SEM_DATA_DIR>/voice-bridge.json. The user's other computer is an AccountService in this process, signed in
// to the same account. The bucket is demo values: nothing reaches a real bucket or account. Screenshots for review go
// to tmp/screenshots-account in the checkout, which Git ignores.
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { tempDir, removeDir } = require('../tmp');
const { closeApp } = require('./close');
const { startAccountServer } = require('../fixtures/account-server');
const { startVoiceServer } = require('../fixtures/voice-server');
const { AccountService } = require('../../src/main/account');

const ROOT = path.join(__dirname, '..', '..');
const SHOTS = path.join(ROOT, 'tmp', 'screenshots-account');
const PASSWORD = 'a long enough password';
const EMAIL = 'share@example.com';
const BUCKET = {
  service: 'other',
  endpoint: 'https://s3.example.com',
  region: 'us-east-1',
  bucket: 'team-meetings',
  prefix: 'voice',
  accessKeyId: 'EXAMPLEKEYID',
  urlStyle: 'path',
  retention: 'keep',
  secret: 'example-secret-0123',
  key: 'RKV1-AAAAA-BBBBB-CCCCC-DDDDD-EEEEE-FFFFF-GGGGG-HHHHH-JJJJJ-KKKKK-MMMMM'
};
const plain = { encrypt: (s) => `plain:${Buffer.from(s).toString('base64')}`, decrypt: (s) => Buffer.from(String(s).slice(6), 'base64').toString() };

let app;
let win;
let dataDir;
let server;
let voice;
let other;

test.beforeEach(async () => {
  server = await startAccountServer();
  dataDir = tempDir('rukoo-share-e2e-');
  voice = await startVoiceServer({ file: path.join(dataDir, 'voice-bridge.json') });
  voice.writeDiscovery();
  const env = { ...process.env, SEM_DATA_DIR: dataDir, SEM_HIDDEN: '1', RUKOO_ACCOUNT_SERVER: server.url };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.RUKOO_VOICE_BRIDGE;
  // The session is stored with safeStorage, which needs the real keyring on Linux (see the account tests).
  const entry = process.platform === 'linux' ? path.join(__dirname, '..', 'fixtures', 'linux-keyring-app.js') : '.';
  app = await electron.launch({ args: [entry], cwd: ROOT, env });
  win = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1400, 950));
  await win.waitForSelector('.provider-grid');
  await win.click('[data-s="demo"]');
  await expect(win.locator('.item').first()).toBeVisible({ timeout: 15000 });
  await expect.poll(() => app.evaluate(() => global.__semVoice.connected), { timeout: 10000 }).toBe(true);
  other = null;
});

test.afterEach(async () => {
  await closeApp(app);
  if (other) other.close();
  await voice.close();
  await server.close();
  removeDir(dataDir);
});

const page = () => win.locator('.page.settings');
const shareSwitch = () => page().locator('[data-a="mtset-share"]');
const offer = () => page().locator('[data-share-offer]');
const useButton = () => page().locator('[data-a="mtset-share-use"]');

async function openMeetingSettings() {
  await win.click('[data-action="settings"]');
  await page().locator('[data-a="mtset-open"]').click();
  await expect(page().locator('h1')).toHaveText('Meetings');
}

// The user's other computer, signed in to the same account.
function otherComputer() {
  other = new AccountService({ dataDir: tempDir('rukoo-share-other-'), secrets: plain, defaultServer: server.url, deviceName: 'Desk', platform: 'linux' }).init();
  return other;
}

const signUpHere = () => app.evaluate((_, a) => global.__semAccount.signUp(a).then(() => true), { email: EMAIL, password: PASSWORD });
const signInHere = () => app.evaluate((_, a) => global.__semAccount.signIn(a).then(() => true), { email: EMAIL, password: PASSWORD });
const syncHere = () => app.evaluate(() => global.__semAccount.sync().then(() => true));
const recordHere = () => app.evaluate(() => global.__semAccount.get('voicesync', 'bucket') || null);
const sets = () => voice.commands.filter((c) => c.command === 'sync.settings.set').length;

// An open Settings page keeps the language it was drawn in, so the page is opened again from the overview.
async function setLook(theme, language) {
  await win.evaluate(([theme, language]) => window.mail.call('updateSettings', { theme, language }), [theme, language]);
  await expect(win.locator('html')).toHaveAttribute('lang', language);
  await page().locator('[data-a="back"]').click();
  await page().locator('[data-a="mtset-open"]').click();
  await expect(page().locator('.settings-group-title').last()).toHaveText(language === 'nl' ? 'Je andere computers' : 'Your other computers');
}

// The page in light and dark, English and Dutch; back to light English after.
async function shots(name) {
  fs.mkdirSync(SHOTS, { recursive: true });
  for (const [theme, language] of [
    ['light', 'en'],
    ['dark', 'en'],
    ['light', 'nl'],
    ['dark', 'nl']
  ]) {
    await setLook(theme, language);
    await win.waitForTimeout(300);
    await win.screenshot({ path: path.join(SHOTS, `${name}-${theme}-${language}.png`) });
  }
  await setLook('light', 'en');
}

test('without an account the section points to Rukoo Voice; signed in, the switch shares the bucket and turning it off removes it', async () => {
  voice.syncSettings = { ...BUCKET };
  await openMeetingSettings();
  await expect(page()).toContainText('Your other computers');
  await expect(page()).toContainText("open Rukoo Voice's Settings > Storage there");
  await expect(shareSwitch()).toHaveCount(0);
  await shots('no-account');

  await signUpHere();
  await expect(shareSwitch()).toBeVisible({ timeout: 10000 });
  await expect(shareSwitch()).toHaveAttribute('aria-checked', 'false');
  expect(await recordHere()).toBe(null);
  await shots('off');

  await shareSwitch().click();
  await expect(shareSwitch()).toHaveAttribute('aria-checked', 'true');
  expect((await recordHere()).settings).toEqual(BUCKET);
  await shots('on');

  // The other computer gets it from the account; the window's state never holds the secret or the key.
  const desk = otherComputer();
  await syncHere();
  await desk.signIn({ email: EMAIL, password: PASSWORD });
  await desk.sync();
  expect(desk.get('voicesync', 'bucket').settings).toEqual(BUCKET);
  const state = JSON.stringify(await win.evaluate(() => window.mail.call('voiceState')));
  expect(state).not.toContain(BUCKET.secret);
  expect(state).not.toContain(BUCKET.key);

  await shareSwitch().click();
  await expect(shareSwitch()).toHaveAttribute('aria-checked', 'false');
  expect(await recordHere()).toBe(null);
  await syncHere();
  await desk.sync();
  expect(desk.get('voicesync', 'bucket')).toBe(undefined);
});

test("another computer's bucket: a refusal says why, Use it here too connects, and a later change follows by itself", async () => {
  voice.syncSettings = null;
  const desk = otherComputer();
  await desk.signUp({ email: EMAIL, password: PASSWORD });
  desk.put('voicesync', 'bucket', { settings: BUCKET, at: Date.now(), device: 'Desk' });
  await desk.sync();
  await signInHere();
  await openMeetingSettings();
  await expect(offer()).toBeVisible({ timeout: 10000 });
  await expect(offer()).toContainText('Your other computer syncs meetings to a bucket');
  await expect(offer()).toContainText('Desk syncs to the bucket team-meetings');
  await expect(shareSwitch()).toHaveCount(0);
  await shots('offer');

  // Voice refuses: the reason shows, the button stays, and nothing changed in Voice.
  voice.syncRefusal = { code: 'busy', message: 'This computer already uploaded meetings with its own key, so it keeps that key.', reason: 'key_in_use' };
  await useButton().click();
  await expect(page().locator('.mtset-share-error')).toContainText('already uploaded meetings with its own encryption key');
  await expect(useButton()).toBeEnabled();
  expect(voice.syncSettings).toBe(null);
  await shots('error');

  // Voice tests the bucket before it answers: the button says it connects meanwhile.
  voice.syncRefusal = null;
  let answer;
  voice.handlers['sync.settings.set'] = (args) =>
    new Promise((resolve) => {
      answer = () => {
        voice.syncSettings = { ...args.settings };
        resolve({});
      };
    });
  await useButton().click();
  await expect(useButton()).toHaveText('Connecting…');
  await expect(useButton()).toBeDisabled();
  await shots('applying');
  await expect.poll(() => typeof answer).toBe('function');
  answer();
  await expect(offer()).toHaveCount(0);
  await expect(page().locator('.mtset-share-error')).toHaveCount(0);
  await expect(page()).toContainText('Rukoo Voice here uses the bucket your other computer shares.');
  expect(voice.syncSettings).toEqual(BUCKET);
  await shots('following');

  // A new secret on the other computer reaches this Voice without a click.
  delete voice.handlers['sync.settings.set'];
  const before = sets();
  desk.put('voicesync', 'bucket', { settings: { ...BUCKET, secret: 'a-newer-secret' }, at: Date.now(), device: 'Desk' });
  await desk.sync();
  await syncHere();
  await expect.poll(() => voice.syncSettings && voice.syncSettings.secret, { timeout: 10000 }).toBe('a-newer-secret');
  expect(sets()).toBe(before + 1);
  await expect(offer()).toHaveCount(0);

  // It stays after a restart of the share: the choice is kept for this account.
  const prefs = JSON.parse(fs.readFileSync(path.join(dataDir, 'data', 'voice-share.json'), 'utf8'));
  expect(prefs.follow).toBe(true);
  expect(JSON.stringify(prefs)).not.toContain(BUCKET.secret);
});

test('the offer says when Voice here would leave the bucket it syncs to now', async () => {
  voice.syncSettings = { ...BUCKET, bucket: 'laptop-meetings', key: 'RKV1-ZZZZZ' };
  const desk = otherComputer();
  await desk.signUp({ email: EMAIL, password: PASSWORD });
  desk.put('voicesync', 'bucket', { settings: BUCKET, at: Date.now(), device: 'Desk' });
  await desk.sync();
  await signInHere();
  await openMeetingSettings();
  await expect(offer()).toContainText('Rukoo Voice here then stops syncing to its current bucket.', { timeout: 10000 });
  // This computer's own bucket can still be shared.
  await expect(shareSwitch()).toHaveAttribute('aria-checked', 'false');
  await shots('offer-replaces');
});
