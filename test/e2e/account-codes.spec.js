// Codes by email in the desktop app (src/renderer/email-code.js): the sign-up form of a server that checks addresses
// asks for the emailed code and keeps what was typed, a locked account gets a code to sign in now, a server without
// codes shows its forms as before, and a fresh install that joins with an invitation link gives the code on the setup
// page. Settings runs against the in-memory server (test/fixtures/account-server.js); the setup page against the real
// one with its mail going to the stand-in of test/fixtures/real-server.js. Each state is saved as a screenshot in the
// test's output folder, in dark and light and in English and Dutch, for the review.
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { tempDir, removeDir } = require('../tmp');
const { closeApp } = require('./close');
const { startAccountServer } = require('../fixtures/account-server');
const { AccountService } = require('../../src/main/account');
const { skipWithoutServer, startServer, emulateFocus, dialogBox } = require('./chat-helpers');

const PASSWORD = 'a long enough password';
const secrets = { encrypt: (s) => `plain:${Buffer.from(s).toString('base64')}`, decrypt: (s) => Buffer.from(String(s).slice(6), 'base64').toString() };

let app;
let win;
let dataDir;

async function launch(serverUrl, { demo = true, size = [1400, 950] } = {}) {
  dataDir = tempDir('rukoo-codes-e2e-');
  const env = { ...process.env, SEM_DATA_DIR: dataDir, SEM_HIDDEN: '1', SEM_CHAT_FAST: '1', RUKOO_ACCOUNT_SERVER: serverUrl };
  delete env.ELECTRON_RUN_AS_NODE;
  const entry = process.platform === 'linux' ? path.join(__dirname, '..', 'fixtures', 'linux-keyring-app.js') : '.';
  app = await electron.launch({ args: [entry], cwd: path.join(__dirname, '..', '..'), env });
  win = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setSize(w, h), size);
  await win.waitForSelector('.provider-grid');
  if (demo) {
    await win.click('[data-s="demo"]');
    await expect(win.locator('.item').first()).toBeVisible({ timeout: 15000 });
  }
}

async function finish() {
  await closeApp(app);
  app = null;
  removeDir(dataDir);
}

const page = () => win.locator('.page.settings');
const shot = (testInfo, name) => win.screenshot({ path: testInfo.outputPath(`${name}.png`) });

async function openForm(view) {
  await win.click('[data-action="settings"]');
  await page().locator('[data-a="rukoo"]').click();
  await expect(page().locator('h1')).toHaveText(/Rukoo account|Rukoo-account/);
  await page().locator(`[data-a="rukoo-go:${view}"]`).click();
  return page().locator(`form[data-form="${view}"]`);
}

async function fillSignUp(form, email) {
  await form.locator('[name="email"]').fill(email);
  await form.locator('[name="password"]').fill(PASSWORD);
  await form.locator('[name="repeat"]').fill(PASSWORD);
  await form.locator('[name="understand"]').check();
}

// An account on the in-memory server, made over its API with the desktop's own code (no app window involved).
async function seedAccount(server, email) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rukoo-codes-seed-'));
  const acc = new AccountService({ dataDir: dir, secrets, defaultServer: server.url, deviceName: 'Seed', platform: 'linux' }).init();
  try {
    const { recoveryKey } = await acc.signUp({ email, password: PASSWORD, invite: 'welcome' });
    await acc.signOut();
    return recoveryKey;
  } finally {
    acc.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test.describe('Settings', () => {
  let server;

  test.beforeEach(async () => {
    server = await startAccountServer({ signups: 'verified', codes: true, invites: ['welcome'], usedInvites: ['spent'] });
    await launch(server.url);
    // Dark, whatever the system says, so the captures named dark are.
    await win.evaluate(() => window.mail.call('updateSettings', { theme: 'dark' }));
  });

  test.afterEach(async () => {
    await finish();
    await server.close();
  });

  test('a sign-up asks for the emailed code, keeps the form, refuses a wrong code and takes the right one', async ({}, testInfo) => {
    const form = await openForm('rukoo-signup');
    await expect(form.locator('label', { has: win.locator('[name="invite"]') })).toContainText('Invite code (optional)');
    await expect(form).toContainText('Without one, Rukoo emails you a code to check your address.');
    await fillSignUp(form, 'New@Example.com');
    await form.locator('button[type=submit]').click();

    const step = form.locator('[data-code-step]');
    await expect(step.locator('[data-code-sent]')).toHaveText('We sent a code to new@example.com.', { timeout: 15000 });
    await expect(form.locator('[name="emailCode"]')).toBeFocused();
    // Nothing typed before the step is lost.
    await expect(form.locator('[name="email"]')).toHaveValue('New@Example.com');
    await expect(form.locator('[name="password"]')).toHaveValue(PASSWORD);
    await expect(form.locator('[name="understand"]')).toBeChecked();
    await expect(step.locator('[data-code-resend]')).toBeDisabled();
    await expect(step.locator('[data-code-resend]')).toHaveText(/^New code in \d+ seconds?$/);
    expect(server.calls.filter((c) => c.route === 'POST /v1/signup')).toHaveLength(0);
    await shot(testInfo, 'signup-code-sent-dark-en');

    await form.locator('button[type=submit]').click();
    await expect(form.locator('[data-error]')).toHaveText('Enter the code from the email.');
    const code = server.codeFor('new@example.com');
    await form.locator('[name="emailCode"]').fill(code === '000000' ? '111111' : '000000');
    await form.locator('button[type=submit]').click();
    await expect(form.locator('[data-error]')).toHaveText('That code is wrong. You can try 4 more times.', { timeout: 15000 });
    await shot(testInfo, 'signup-code-wrong-dark-en');
    await form.locator('[name="emailCode"]').fill('12 34');
    await form.locator('button[type=submit]').click();
    await expect(form.locator('[data-error]')).toHaveText('Enter the 6-digit code, or paste the long code from the email.', { timeout: 15000 });

    await form.locator('[name="emailCode"]').fill(code);
    await form.locator('button[type=submit]').click();
    const dialog = win.locator('.scrim .dialog');
    await expect(dialog.locator('h2')).toHaveText('Save your recovery key', { timeout: 20000 });
    await dialog.locator('.buttons button', { hasText: 'I saved it' }).click();
    await expect(page()).toContainText('new@example.com', { timeout: 15000 });
    expect(server.accounts.has('new@example.com')).toBe(true);
    expect(JSON.stringify(server.calls)).not.toContain(PASSWORD);
  });

  test('a changed address drops the step; the long code from the email works; a code within the minute waits', async ({}, testInfo) => {
    const form = await openForm('rukoo-signup');
    await fillSignUp(form, 'first@example.com');
    await form.locator('button[type=submit]').click();
    await expect(form.locator('[data-code-step]')).toBeVisible({ timeout: 15000 });
    await form.locator('[name="email"]').fill('second@example.com');
    await expect(form.locator('[data-code-step]')).toHaveCount(0);

    await form.locator('button[type=submit]').click();
    await expect(form.locator('[data-code-sent]')).toHaveText('We sent a code to second@example.com.', { timeout: 15000 });
    // The button waits out the server's minute between two codes; pressed anyway, once the minute has passed it sends
    // a new code, and before that the server turns it down and the form says how long to wait.
    server.allowCode('second@example.com', 'signup');
    await form.locator('[data-code-resend]').evaluate((b) => {
      b.disabled = false;
    });
    await form.locator('[data-code-resend]').click();
    await expect(form.locator('[data-code-sent]')).toHaveText('We sent a new code to second@example.com. Use the one in the newest email.', { timeout: 15000 });
    await form.locator('[data-code-resend]').evaluate((b) => {
      b.disabled = false;
    });
    await form.locator('[data-code-resend]').click();
    await expect(form.locator('[data-error]')).toHaveText(/^You can ask for a new code in (\d+ seconds?|1 minute)\.$/, { timeout: 15000 });
    await shot(testInfo, 'signup-code-wait-dark-en');

    await form.locator('[name="emailCode"]').fill(server.tokenFor('second@example.com'));
    await form.locator('button[type=submit]').click();
    await expect(win.locator('.scrim .dialog h2')).toHaveText('Save your recovery key', { timeout: 20000 });
    await win.locator('.scrim .dialog .buttons button', { hasText: 'I saved it' }).click();
    expect(server.accounts.has('second@example.com')).toBe(true);
    expect(server.accounts.has('first@example.com')).toBe(false);
  });

  test('a code the server holds back leaves room for the long code; an invite code typed at the code step goes through', async ({}, testInfo) => {
    // Another device asked for a code a moment ago, so the server holds the next one back for a minute.
    await win.evaluate(() => window.mail.invoke('accountEmailCode', { email: 'held@example.com', purpose: 'signup' }));
    const form = await openForm('rukoo-signup');
    await fillSignUp(form, 'held@example.com');
    await form.locator('button[type=submit]').click();
    await expect(form.locator('[data-code-sent]')).toHaveText('No new code went to held@example.com yet. The long code from an earlier email works too.', { timeout: 15000 });
    await expect(form.locator('[data-error]')).toHaveText(/^You can ask for a new code in (\d+ seconds?|1 minute)\.$/);
    await expect(form.locator('[name="emailCode"]')).toBeFocused();
    await shot(testInfo, 'signup-code-held-dark-en');
    await form.locator('[name="emailCode"]').fill(server.tokenFor('held@example.com'));
    await form.locator('button[type=submit]').click();
    await expect(win.locator('.scrim .dialog h2')).toHaveText('Save your recovery key', { timeout: 20000 });
    await win.locator('.scrim .dialog .buttons button', { hasText: 'I saved it' }).click();
    expect(server.accounts.has('held@example.com')).toBe(true);
    await page().locator('[data-a="rukoo-signout"]').click();
    await win.locator('.scrim .buttons button', { hasText: 'Sign out' }).click();
    await expect(page().locator('[data-a="rukoo-go:rukoo-signup"]')).toBeVisible();

    // At the code step, an invite code needs no emailed code; a wrong one says the emailed code still works.
    await page().locator('[data-a="rukoo-go:rukoo-signup"]').click();
    const again = page().locator('form[data-form="rukoo-signup"]');
    await fillSignUp(again, 'invited@example.com');
    await again.locator('button[type=submit]').click();
    await expect(again.locator('[data-code-step]')).toBeVisible({ timeout: 15000 });
    await again.locator('[name="invite"]').fill('not-the-code');
    await again.locator('button[type=submit]').click();
    await expect(again.locator('[data-error]')).toHaveText("That invite code didn't work. Enter the code from the email instead.", { timeout: 20000 });
    await again.locator('[name="invite"]').fill('welcome');
    await again.locator('button[type=submit]').click();
    await expect(win.locator('.scrim .dialog h2')).toHaveText('Save your recovery key', { timeout: 20000 });
    await win.locator('.scrim .dialog .buttons button', { hasText: 'I saved it' }).click();
    expect(server.accounts.has('invited@example.com')).toBe(true);
    expect(server.calls.filter((c) => c.route === 'POST /v1/signup').at(-1).body.invite).toBe('welcome');
  });

  test('an invite code that has been used up gets a code instead, which then signs up with the invite code still typed', async ({}, testInfo) => {
    const form = await openForm('rukoo-signup');
    await fillSignUp(form, 'spent@example.com');
    await form.locator('[name="invite"]').fill('spent');
    await form.locator('button[type=submit]').click();
    await expect(form.locator('[data-code-sent]')).toHaveText('We sent a code to spent@example.com.', { timeout: 15000 });
    await expect(form.locator('[data-error]')).toHaveText("That invite code didn't work, so we sent a code to spent@example.com instead.");
    await shot(testInfo, 'signup-invite-spent-dark-en');
    await form.locator('[name="emailCode"]').fill(server.codeFor('spent@example.com'));
    await form.locator('button[type=submit]').click();
    await expect(win.locator('.scrim .dialog h2')).toHaveText('Save your recovery key', { timeout: 20000 });
    await win.locator('.scrim .dialog .buttons button', { hasText: 'I saved it' }).click();
    expect(server.accounts.has('spent@example.com')).toBe(true);
    const last = server.calls.filter((c) => c.route === 'POST /v1/signup').at(-1).body;
    expect(last.invite).toBeUndefined();
    expect(last.emailCode.code).toBe(server.codeFor('spent@example.com'));
  });

  test('once the lock is over, a sign-in with the code step showing goes without a code', async () => {
    await seedAccount(server, 'later@example.com');
    server.lock('later@example.com');
    const form = await openForm('rukoo-signin');
    await form.locator('[name="email"]').fill('later@example.com');
    await form.locator('[name="password"]').fill(PASSWORD);
    await form.locator('button[type=submit]').click();
    await form.locator('[data-code-offer]').click({ timeout: 15000 });
    await expect(form.locator('[data-code-sent]')).toBeVisible({ timeout: 15000 });
    // Still locked: the empty field goes to the server, which says so, and the step asks for the code.
    const logins = server.calls.filter((c) => c.route === 'POST /v1/login').length;
    await form.locator('button[type=submit]').click();
    await expect(form.locator('[data-error]')).toHaveText('Enter the code from the email.', { timeout: 15000 });
    await expect.poll(() => server.calls.filter((c) => c.route === 'POST /v1/login').length).toBe(logins + 1);
    await expect(form.locator('[data-code-step]')).toBeVisible();
    // The 15 minutes are over: the same empty field signs in.
    server.unlock('later@example.com');
    await form.locator('button[type=submit]').click();
    await expect(page().locator('h1')).toHaveText('Rukoo account', { timeout: 20000 });
    await expect(page()).toContainText('later@example.com', { timeout: 15000 });
    expect(server.calls.filter((c) => c.route === 'POST /v1/login').at(-1).body.emailCode).toBeUndefined();
  });

  test('a locked account offers a code by email and signs in or recovers with it', async ({}, testInfo) => {
    const recoveryKey = await seedAccount(server, 'locked@example.com');
    server.lock('locked@example.com');
    const form = await openForm('rukoo-signin');
    await form.locator('[name="email"]').fill('locked@example.com');
    await form.locator('[name="password"]').fill(PASSWORD);
    await form.locator('button[type=submit]').click();
    const err = form.locator('[data-error]');
    await expect(err).toContainText('Too many attempts on this account. Wait 15 minutes, or get a code by email and go on now.', { timeout: 15000 });
    await expect(err.locator('[data-code-offer]')).toHaveText('Email me a code');
    await shot(testInfo, 'signin-locked-dark-en');
    await err.locator('[data-code-offer]').click();
    await expect(form.locator('[data-code-sent]')).toHaveText('We sent a code to locked@example.com.', { timeout: 15000 });
    await expect(err).toBeEmpty();
    await shot(testInfo, 'signin-code-sent-dark-en');
    await form.locator('[name="emailCode"]').fill(server.codeFor('locked@example.com'));
    await form.locator('button[type=submit]').click();
    await expect(page().locator('h1')).toHaveText('Rukoo account', { timeout: 20000 });
    await expect(page()).toContainText('locked@example.com', { timeout: 15000 });
    expect(server.calls.filter((c) => c.route === 'POST /v1/login').at(-1).body.emailCode.code).toBe(server.codeFor('locked@example.com'));

    // Signed out again, the recovery form gets past the lock the same way, with the long code.
    await page().locator('[data-a="rukoo-signout"]').click();
    await win.locator('.scrim .buttons button', { hasText: 'Sign out' }).click();
    await expect(page().locator('[data-a="rukoo-go:rukoo-recover"]')).toBeVisible();
    server.lock('locked@example.com');
    server.allowCode('locked@example.com', 'unlock');
    await page().locator('[data-a="rukoo-go:rukoo-recover"]').click();
    const recover = page().locator('form[data-form="rukoo-recover"]');
    await recover.locator('[name="email"]').fill('locked@example.com');
    await recover.locator('[name="recoveryKey"]').fill(recoveryKey);
    await recover.locator('[name="password"]').fill('a brand new password');
    await recover.locator('[name="repeat"]').fill('a brand new password');
    await recover.locator('button[type=submit]').click();
    await expect(recover.locator('[data-error] [data-code-offer]')).toBeVisible({ timeout: 15000 });
    await recover.locator('[data-code-offer]').click();
    await expect(recover.locator('[data-code-sent]')).toBeVisible({ timeout: 15000 });
    await recover.locator('[name="emailCode"]').fill(server.tokenFor('locked@example.com'));
    await recover.locator('button[type=submit]').click();
    await expect(page()).toContainText('locked@example.com', { timeout: 20000 });
    expect(server.calls.filter((c) => c.route === 'POST /v1/recover/finish').at(-1).body.emailCode.token).toBe(server.tokenFor('locked@example.com'));
  });

  test('the code step reads in English and Dutch, in dark and light, and fits a narrow window', async ({}, testInfo) => {
    await seedAccount(server, 'shots@example.com');
    server.lock('shots@example.com');
    let n = 0;
    for (const [language, theme] of [
      ['en', 'light'],
      ['nl', 'dark'],
      ['nl', 'light']
    ]) {
      await win.evaluate((s) => window.mail.call('updateSettings', s), { language, theme });
      const nl = language === 'nl';
      const email = `shot${++n}@example.com`;
      const form = await openForm('rukoo-signup');
      await expect(form.locator('label', { has: win.locator('[name="invite"]') })).toContainText(nl ? 'Uitnodigingscode (optioneel)' : 'Invite code (optional)');
      await fillSignUp(form, email);
      await form.locator('button[type=submit]').click();
      await expect(form.locator('[data-code-sent]')).toHaveText(nl ? `We hebben een code gestuurd naar ${email}.` : `We sent a code to ${email}.`, { timeout: 15000 });
      await form.locator('[name="emailCode"]').fill(server.codeFor(email) === '000000' ? '111111' : '000000');
      await form.locator('button[type=submit]').click();
      await expect(form.locator('[data-error]')).toHaveText(nl ? 'Die code klopt niet. Je kunt het nog 4 keer proberen.' : 'That code is wrong. You can try 4 more times.', { timeout: 15000 });
      await shot(testInfo, `signup-code-wrong-${theme}-${language}`);

      await page().locator('[data-a="back"]').click();
      await page().locator('[data-a="rukoo-go:rukoo-signin"]').click();
      const signIn = page().locator('form[data-form="rukoo-signin"]');
      await signIn.locator('[name="email"]').fill('shots@example.com');
      await signIn.locator('[name="password"]').fill(PASSWORD);
      await signIn.locator('button[type=submit]').click();
      await expect(signIn.locator('[data-code-offer]')).toHaveText(nl ? 'Mail me een code' : 'Email me a code', { timeout: 15000 });
      await shot(testInfo, `signin-locked-${theme}-${language}`);
      server.allowCode('shots@example.com', 'unlock');
      await signIn.locator('[data-code-offer]').click();
      await expect(signIn.locator('[data-code-sent]')).toBeVisible({ timeout: 15000 });
      await shot(testInfo, `signin-code-sent-${theme}-${language}`);
      for (let i = 0; i < 4 && (await page().count()); i++) await win.keyboard.press('Escape');
      await expect(page()).toHaveCount(0);
    }

    // Narrow, at 760 px (the window's least width) and in Dutch: nothing runs out of the page sideways.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(760, 700));
    const form = await openForm('rukoo-signup');
    await fillSignUp(form, 'narrow@example.com');
    await form.locator('button[type=submit]').click();
    await expect(form.locator('[data-code-step]')).toBeVisible({ timeout: 15000 });
    const overflow = await page().evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await shot(testInfo, 'signup-code-sent-light-nl-narrow');
  });

  test('a server without sign-up codes shows its forms as before', async () => {
    const plain = await startAccountServer({ signups: 'invite', invites: ['welcome'], codes: true });
    try {
      await win.evaluate((url) => window.mail.call('accountSetServer', url), plain.url);
      const form = await openForm('rukoo-signup');
      await expect(form.locator('label', { has: win.locator('[name="invite"]') })).toHaveText('Invite code');
      await fillSignUp(form, 'plain@example.com');
      await form.locator('button[type=submit]').click();
      await expect(form.locator('[data-error]')).toHaveText('This server needs a valid invite code.', { timeout: 15000 });
      await expect(form.locator('[data-code-step]')).toHaveCount(0);
      expect(plain.calls.filter((c) => c.route === 'POST /v1/email-code')).toHaveLength(0);
    } finally {
      await plain.close();
    }
  });
});

test.describe('Setup page', () => {
  skipWithoutServer();
  let server;

  test.beforeAll(async () => {
    server = await startServer({ vars: { SIGNUPS: 'verified' }, mail: true });
  });

  test.afterAll(async () => {
    await server?.close();
  });

  test.afterEach(async () => {
    await finish();
  });

  test('a fresh install that joins with an invitation link confirms the address with the emailed code', async ({}, testInfo) => {
    const olga = await server.seedAccount();
    const ws = await server.seedWorkspace(olga, { name: 'Acme', displayName: 'Olga Owner' });
    const { link } = await server.createInvite(olga, ws.id, { role: 'member' });
    await launch(server.url, { demo: false, size: [1280, 860] });
    await emulateFocus(win);
    await win.evaluate(() => window.mail.call('updateSettings', { theme: 'dark' }));
    const setup = win.locator('.page.setup');
    const offer = setup.locator('[data-setup-chat]');
    await expect(offer).toBeVisible({ timeout: 15000 });
    await offer.locator('[data-s="chat-link"]').click();
    const linkForm = setup.locator('form[data-form="chat-link"]');
    await linkForm.locator('[name="link"]').fill(link);
    await linkForm.locator('button[type=submit]').click();

    const form = setup.locator('form[data-form="chat-signup"]');
    await expect(form.locator('[name="invite"]')).toHaveCount(0);
    const email = `invitee-${Date.now()}@example.com`;
    await form.locator('[name="email"]').fill(email);
    await form.locator('[name="password"]').fill(PASSWORD);
    await form.locator('[name="repeat"]').fill(PASSWORD);
    await form.locator('[name="understand"]').check();
    const asked = Date.now() - 1;
    await form.locator('button[type=submit]').click();
    await expect(form.locator('[data-code-sent]')).toHaveText(`We sent a code to ${email}.`, { timeout: 20000 });
    await shot(testInfo, 'setup-code-sent-dark-en');
    const mail = await server.mail.next(email, { after: asked });
    await form.locator('[name="emailCode"]').fill(mail.code);
    await form.locator('button[type=submit]').click();

    const key = dialogBox(win);
    await expect(key.locator('h2')).toHaveText('Save your recovery key', { timeout: 20000 });
    await key.locator('.buttons button').last().click();
    await expect(setup).toHaveCount(0, { timeout: 15000 });
    const dialog = dialogBox(win);
    await expect(dialog.locator('h2')).toHaveText('Join a workspace', { timeout: 15000 });
    await expect(dialog.locator('[name="link"]')).toHaveValue(link);
  });
});

test.describe("What's new", () => {
  let server;

  test.beforeEach(async () => {
    server = await startAccountServer({ signups: 'verified', codes: true, invites: ['welcome'] });
    await launch(server.url);
  });

  test.afterEach(async () => {
    await finish();
    await server.close();
  });

  test('the account step keeps its code step, held-back code and wait when the guide goes back and forth', async ({}, testInfo) => {
    const guide = win.locator('.wn');
    const next = () => guide.locator('[data-wn="next"]').click();
    await win.click('[data-action="settings"]');
    await win.locator('.page.settings [data-a="whats-new"]').click();
    await next();
    await next();
    await expect(guide.locator('h2')).toHaveText('Keep them the same on every device');
    await expect(guide.locator('[name="invite"]')).toHaveAttribute('placeholder', 'Invite code (optional)');
    await expect(guide.locator('.wn-choice.on')).toContainText('Free. Rukoo emails you a code to check your address.');
    // Another device asked a moment ago, so the server holds this guide's code back.
    await win.evaluate(() => window.mail.invoke('accountEmailCode', { email: 'guide@example.com', purpose: 'signup' }));
    const fill = async () => {
      await guide.locator('[name="email"]').fill('guide@example.com');
      await guide.locator('[name="password"]').fill(PASSWORD);
      await guide.locator('[name="understand"]').check();
    };
    await fill();
    await next();
    await expect(guide.locator('[data-code-sent]')).toHaveText('No new code went to guide@example.com yet. The long code from an earlier email works too.', { timeout: 15000 });
    await expect(guide.locator('[data-code-resend]')).toBeDisabled();
    await shot(testInfo, 'whats-new-code-held-light-en');

    // Back a page and forward again: the same step, still held back and still waiting.
    await guide.locator('[data-wn="back"]').click();
    await expect(guide.locator('h2')).toHaveText('Choose your categories');
    await next();
    await expect(guide.locator('[data-code-sent]')).toHaveText('No new code went to guide@example.com yet. The long code from an earlier email works too.');
    await expect(guide.locator('[data-code-resend]')).toBeDisabled();

    await guide.locator('[name="password"]').fill(PASSWORD);
    await guide.locator('[name="understand"]').check();
    await guide.locator('[name="emailCode"]').fill(server.tokenFor('guide@example.com'));
    await next();
    await expect(guide.locator('h2')).toHaveText('Save your recovery key', { timeout: 20000 });
    expect(server.accounts.has('guide@example.com')).toBe(true);
  });

  test('Email me a code and Send a new code are kept when the guide goes back and forth', async ({}, testInfo) => {
    await seedAccount(server, 'guide-locked@example.com');
    server.lock('guide-locked@example.com');
    // Another device asked a moment ago, so the server holds the guide's first code back.
    await win.evaluate(() => window.mail.invoke('accountEmailCode', { email: 'guide-locked@example.com', purpose: 'unlock' }));
    const guide = win.locator('.wn');
    const next = () => guide.locator('[data-wn="next"]').click();
    const backAndForth = async () => {
      await guide.locator('[data-wn="back"]').click();
      await expect(guide.locator('h2')).toHaveText('Choose your categories');
      await next();
      await expect(guide.locator('h2')).toHaveText('Keep them the same on every device');
    };
    await win.click('[data-action="settings"]');
    await win.locator('.page.settings [data-a="whats-new"]').click();
    await next();
    await next();
    await guide.locator('[data-choice="signin"]').click();
    await guide.locator('[name="email"]').fill('guide-locked@example.com');
    await guide.locator('[name="password"]').fill(PASSWORD);
    await next();
    await guide.locator('[data-code-offer]').click({ timeout: 15000 });
    const held = 'No new code went to guide-locked@example.com yet. The long code from an earlier email works too.';
    await expect(guide.locator('[data-code-sent]')).toHaveText(held, { timeout: 15000 });
    await backAndForth();
    await expect(guide.locator('[data-code-sent]')).toHaveText(held);
    await expect(guide.locator('[data-code-resend]')).toBeDisabled();

    // The minute is over and a new code goes out: back and forth, the step says it went and counts down again.
    server.allowCode('guide-locked@example.com', 'unlock');
    await guide.locator('[data-code-resend]').evaluate((b) => {
      b.disabled = false;
    });
    await guide.locator('[data-code-resend]').click();
    await expect(guide.locator('[data-code-sent]')).toHaveText('We sent a new code to guide-locked@example.com. Use the one in the newest email.', { timeout: 15000 });
    await backAndForth();
    await expect(guide.locator('[data-code-sent]')).toHaveText('We sent a code to guide-locked@example.com.');
    await expect(guide.locator('[data-code-resend]')).toBeDisabled();
    await expect(guide.locator('[data-code-resend]')).toHaveText(/^New code in \d+ seconds?$/);
    await shot(testInfo, 'whats-new-unlock-resent-light-en');

    await guide.locator('[name="password"]').fill(PASSWORD);
    await guide.locator('[name="emailCode"]').fill(server.codeFor('guide-locked@example.com'));
    await next();
    await expect(guide.locator('h2')).not.toHaveText('Keep them the same on every device', { timeout: 20000 });
    expect(server.calls.filter((c) => c.route === 'POST /v1/login').at(-1).body.emailCode.code).toBe(server.codeFor('guide-locked@example.com'));
  });

});
