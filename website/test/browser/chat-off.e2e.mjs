// Rukoo Chat in the browser against an account server with team chat off (WORKSPACE_MODE off), as a server that runs
// no team chat has it: the page says so in the browser's language instead of showing an empty chat, and /join is the
// server's own page, not a redirect into the app.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { clean, expect, makeAccount, openPage, openTab, shot, startWorkers, tr } from './harness.mjs';

let env = null;

before(async () => {
  env = await startWorkers({ workspaceMode: 'off' });
});
after(() => env?.close());

test('e: a server without team chat shows the chat-off state, in English and in Dutch', async () => {
  const host = new URL(env.origin).host;
  for (const [locale, lang] of [['en-GB', 'en'], ['nl-NL', 'nl']]) {
    const view = await openPage(env.browser, { locale });
    const p = view.page;
    try {
      await p.goto(`${env.origin}/app/`);
      const gate = p.locator('.web-gate');
      await expect(gate.locator('.ch-empty-title')).toHaveText(tr(lang, 'chat.web.offTitle'));
      await expect(gate.locator('.ch-empty-body')).toHaveText(tr(lang, 'chat.web.offBody', { host }));
      await expect(gate.locator('[data-gate="settings"]')).toHaveText(tr(lang, 'chat.web.settings'));
      await expect(p.locator('.sidebar .sync-status .t')).toHaveText(tr(lang, 'chat.web.statusOff'));
      await expect(p.locator('section.chat')).toBeHidden();
      await shot(p, `e1-chat-off-${lang}`);
      clean(view);
    } finally {
      await view.context.close();
    }
  }
  // Without team chat the invitation page isn't served, so the site Worker has nothing to redirect.
  const join = await fetch(`${env.origin}/join`, { redirect: 'manual' });
  await join.body?.cancel();
  assert.notEqual(join.status, 302);
  assert.equal(join.headers.get('x-rukoo-workspace-invite'), null);
});

test('e3: a browser too old for team chat says so in its language, with nothing on the page that could not work', async () => {
  const view = await openPage(env.browser, { locale: 'nl-NL' });
  const p = view.page;
  try {
    // As Safari 16, Chrome 111 or Firefox 115 have it: no RegExp v flag, which the chat's emoji check needs.
    await view.context.addInitScript(() => {
      const Native = RegExp;
      window.RegExp = new Proxy(Native, {
        construct(target, args) {
          if (String(args[1] || '').includes('v')) throw new SyntaxError(`Invalid flags supplied to RegExp constructor '${args[1]}'`);
          return Reflect.construct(target, args);
        }
      });
    });
    await p.goto(`${env.origin}/app/`);
    const gate = p.locator('.web-gate');
    await expect(gate.locator('.ch-empty-title')).toHaveText(tr('nl', 'chat.web.oldTitle'));
    await expect(gate.locator('.ch-empty-body')).toHaveText(tr('nl', 'chat.web.oldBody'));
    await expect(gate.locator('[data-gate]')).toHaveCount(0);
    await expect(p.locator('.sidebar .sync-status .t')).toHaveText(tr('nl', 'chat.web.statusFailed'));
    // Settings neither: nothing in it works there.
    const gears = await p.locator('[data-web="settings"], .web-foot-settings').all();
    assert.ok(gears.length >= 2, 'the title bar and the sidebar foot each have one');
    for (const gear of gears) await expect(gear).toBeHidden();
    // No raw error in a toast either.
    await expect(p.locator('#toast.show')).toHaveCount(0);
    await shot(p, 'e3-old-browser-nl');
    clean(view);
  } finally {
    await view.context.close();
  }
});

// The account the page shows, as the bridge has it.
const signedInAs = (p) => p.evaluate(async () => (await window.mail.invoke('accountStatus')).result.email);

test("e2: the chat-off page's Sign out stops when another tab signed this browser in to another account meanwhile", async () => {
  const first = await makeAccount(env.origin, { email: 'gate-first@example.test' });
  const second = await makeAccount(env.origin, { email: 'gate-second@example.test' });
  const view = await openPage(env.browser);
  const p = view.page;
  try {
    await p.goto(`${env.origin}/app/`);
    const gate = p.locator('.web-gate');
    await expect(gate.locator('.ch-empty-title')).toHaveText(tr('en', 'chat.web.offTitle'));
    // Signed in through the gate's Settings, which closes on success.
    const settings = p.locator('#overlays .page.settings');
    await gate.locator('[data-gate="settings"]').click();
    await settings.locator('[data-a="rukoo"]').click();
    // The signed-out page has the server's privacy statement a row away, as the browser has no privacy page.
    await expect(settings.locator('[data-a="rukoo-link:policy"]')).toContainText(tr('en', 'settings.rukoo.policy'));
    await settings.locator('[data-a="rukoo-go:rukoo-signin"]').click();
    const form = settings.locator('form[data-form="rukoo-signin"]');
    await form.locator('input[name="email"]').fill(first.email);
    await form.locator('input[name="password"]').fill(first.password);
    await form.locator('button[type="submit"]').click();
    await expect(settings).toHaveCount(0);

    // The gate's Sign out asks first, for the first account.
    await gate.locator('[data-gate="sign-out"]').click();
    const confirm = p.locator('.scrim .dialog');
    await expect(confirm).toContainText(tr('en', 'settings.rukoo.webSignOutHelp'));
    // While it asks, another tab of this browser signs out and in to the second account.
    const other = await openTab(view);
    const q = other.page;
    try {
      await q.goto(`${env.origin}/app/`);
      await q.evaluate(async ({ email, password }) => {
        await window.mail.call('accountSignOut');
        await window.mail.call('accountSignIn', { email, password });
      }, second);
      await expect.poll(() => signedInAs(p)).toBe(second.email);
      await confirm.getByRole('button', { name: tr('en', 'settings.rukoo.signOut') }).click();
      // The sign-out was confirmed for the first account: the second one stays signed in, and the page says why.
      await expect(p.locator('#toast.show', { hasText: tr('en', 'account.errors.account_changed') })).toBeVisible();
      assert.equal(await signedInAs(p), second.email, 'still signed in to the second account here');
      assert.equal(await signedInAs(q), second.email, 'and in the other tab');
      // Asked again, the dialog is for the second account, and Sign out signs this browser out.
      await gate.locator('[data-gate="sign-out"]').click();
      await confirm.getByRole('button', { name: tr('en', 'settings.rukoo.signOut') }).click();
      await expect(p.locator('#toast.show', { hasText: tr('en', 'settings.rukoo.signedOut') })).toBeVisible();
      await expect.poll(() => signedInAs(q)).toBe(null);
      assert.equal(await signedInAs(p), null);
      await expect(gate.locator('[data-gate="sign-out"]')).toHaveCount(0);
      clean(view, other);
    } finally {
      await q.close();
    }
  } finally {
    await view.context.close();
  }
});
