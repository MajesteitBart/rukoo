// Codes by email in the browser (src/renderer/email-code.js over src/web/account/service.js), end to end on the real
// Workers (harness.mjs) with SIGNUPS=verified and the mail going to the stand-in of test/fixtures/real-server.js: an
// invitation link's sign-up asks for the emailed code and keeps what was typed, a wrong code says how many tries are
// left, and a locked account gets a code to sign in now. At a desktop width in English and light, and at a phone width
// in Dutch and dark. Each page fails on a console or page error and on horizontal overflow.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, before, test } from 'node:test';
import { clean, expect, makeAccount, openPage, PASSWORD, shot, startWorkers, targets, tr } from './harness.mjs';

const WORKSPACE = 'Acme Studio';
const views = [];
let env = null;
let olga = null;
let ws = null;

before(async () => {
  env = await startWorkers({ signups: 'verified', mail: true });
  olga = await makeAccount(env.origin, { email: 'olga@example.test' });
  ws = await env.seed.seedWorkspace(olga, { name: WORKSPACE, displayName: 'Olga Owner' });
});

after(async () => {
  for (const view of views) await view.context.close().catch(() => {});
  await env?.close();
});

// The wrong code and the locked sign-in are answers the test asks for (403 code_wrong, 429 locked); the browser logs
// each refused request as a console error.
const REFUSED = [/status of 40[39]|status of 429/];

async function open(options) {
  const view = await openPage(env.browser, { ...options, allow: REFUSED });
  views.push(view);
  return view;
}

const signedIn = (p) => p.evaluate(() => window.mail.call('accountStatus').then((s) => s.signedIn));

const VARIANTS = [
  { name: 'desktop-light-en', lang: 'en', options: { locale: 'en-GB', colorScheme: 'light' } },
  { name: 'phone-dark-nl', lang: 'nl', options: { locale: 'nl-NL', colorScheme: 'dark', width: 390, height: 844, phone: true } }
];

for (const v of VARIANTS) {
  test(`${v.name}: an invitation link's sign-up asks for the emailed code, keeps the form, and joins with it`, async () => {
    const { link } = await env.seed.createInvite(olga, ws.id, { role: 'member' });
    const view = await open(v.options);
    const p = view.page;
    await p.goto(link);
    await p.locator('[data-ch-empty="sign-up"]').click();
    const form = p.locator('form[data-form="rukoo-signup"]');
    await expect(form.locator('[data-invitation]')).toHaveText(tr(v.lang, 'settings.rukoo.webInvitation'));
    const email = `${v.name}-${Date.now()}@example.test`;
    await form.locator('input[name="email"]').fill(email);
    await form.locator('input[name="password"]').fill(PASSWORD);
    await form.locator('input[name="repeat"]').fill(PASSWORD);
    await form.locator('input[name="understand"]').check();
    const asked = Date.now() - 1;
    await form.locator('button[type="submit"]').click();

    // The server needs the code with an invitation too: the step shows, and nothing typed is lost.
    await expect(form.locator('[data-code-sent]')).toHaveText(tr(v.lang, 'settings.rukoo.code.sent', { email }));
    await expect(form.locator('input[name="email"]')).toHaveValue(email);
    await expect(form.locator('input[name="password"]')).toHaveValue(PASSWORD);
    await expect(form.locator('input[name="understand"]')).toBeChecked();
    await expect(form.locator('[data-code-resend]')).toBeDisabled();
    await shot(p, `codes-${v.name}-1-code-sent`);
    if (v.options.phone) await targets(p, `${v.name} code step`);

    const mail = await env.mail.next(email, { after: asked });
    await form.locator('input[name="emailCode"]').fill(mail.code === '000000' ? '111111' : '000000');
    await form.locator('button[type="submit"]').click();
    await expect(form.locator('[data-error]')).toHaveText(tr(v.lang, 'settings.rukoo.code.wrong', { count: 4 }));
    await shot(p, `codes-${v.name}-2-code-wrong`);

    await form.locator('input[name="emailCode"]').fill(mail.code);
    await form.locator('button[type="submit"]').click();
    await expect(p.locator('.scrim [data-recovery-key]')).toHaveText(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){7}$/);
    await p.locator('.scrim').getByRole('button', { name: tr(v.lang, 'settings.rukoo.keySaved') }).click();
    await expect(p.locator('#overlays .page.settings')).toHaveCount(0);
    await expect(p.locator('.scrim .dialog .ch-join-ws')).toHaveText(WORKSPACE);
    clean(view);
  });

  test(`${v.name}: a locked account offers a code by email and signs in with it`, async () => {
    const person = await makeAccount(env.origin, { email: `locked-${v.name}-${Date.now()}@example.test` });
    for (let i = 0; i < 10; i++) {
      await fetch(`${env.origin}/v1/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: person.email, authKey: crypto.randomBytes(32).toString('base64url'), device: { name: 'Stranger', platform: 'web' } })
      });
    }
    const view = await open(v.options);
    const p = view.page;
    await p.goto(`${env.origin}/app/`);
    await p.locator('[data-ch-empty="sign-in"]').click();
    const form = p.locator('form[data-form="rukoo-signin"]');
    await form.locator('input[name="email"]').fill(person.email);
    await form.locator('input[name="password"]').fill(PASSWORD);
    await form.locator('button[type="submit"]').click();
    await expect(form.locator('[data-error]')).toContainText(tr(v.lang, 'settings.rukoo.code.locked'));
    const offer = form.locator('[data-code-offer]');
    await expect(offer).toHaveText(tr(v.lang, 'settings.rukoo.code.emailMe'));
    await shot(p, `codes-${v.name}-3-locked`);
    if (v.options.phone) await targets(p, `${v.name} locked`);

    const asked = Date.now() - 1;
    await offer.click();
    await expect(form.locator('[data-code-sent]')).toHaveText(tr(v.lang, 'settings.rukoo.code.sent', { email: person.email }));
    const mail = await env.mail.next(person.email, { after: asked });
    assert.match(mail.subject, /\S/);
    await shot(p, `codes-${v.name}-4-unlock-code-sent`);
    await form.locator('input[name="emailCode"]').fill(mail.token);
    await form.locator('button[type="submit"]').click();
    await expect(p.locator('#overlays .page.settings')).toHaveCount(0);
    await expect.poll(() => signedIn(p)).toBe(true);
    clean(view);
  });
}
