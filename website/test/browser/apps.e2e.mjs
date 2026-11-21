// The Rukoo apps notice in the browser (src/renderer/web-apps.js, web-shell.js renderApps), end to end on the real
// Workers (harness.mjs): it shows only while signed in, lists the apps in order in English and Dutch, light and dark, at
// a desktop and a phone width, and once closed it stays gone in every tab of the browser, after a reload and after
// signing in again. Each page fails on a console or page error and on horizontal overflow.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { clean, expect, makeAccount, openPage, openTab, shot, signIn, startWorkers, targets, tr } from './harness.mjs';

const WORKSPACE = 'Acme Studio';
const KEY = 'rukoo.web.apps';
const views = [];

let env = null;
let olga = null;
let ws = null;
let people = 0;

before(async () => {
  env = await startWorkers();
  olga = await makeAccount(env.origin, { email: 'olga@example.test' });
  const piet = await env.seed.seedAccount();
  ws = await env.seed.seedWorkspace(olga, { name: WORKSPACE, displayName: 'Olga Owner' });
  await env.seed.seedMember(ws, piet, 'Piet de Vries');
  await env.seed.post(olga, ws.id, ws.general, 'Morning all. The new onboarding flow is on staging.');
  await env.seed.post(piet, ws.id, ws.general, 'Looked at it on my phone: the second step cuts off the button.');
});

after(async () => {
  for (const view of views) await view.context.close().catch(() => {});
  await env?.close();
});

async function open(options) {
  const view = await openPage(env.browser, options);
  views.push(view);
  await view.page.goto(`${env.origin}/app/`);
  return view;
}

// A member of the workspace of their own for each page: the server limits how often one member asks for a socket.
async function member() {
  people += 1;
  const person = await makeAccount(env.origin, { email: `member${people}@example.test` });
  await env.seed.seedMember(ws, person, `Member ${people}`);
  return person;
}

const notice = (page) => page.locator('.web-apps-slot:not([hidden]) .web-apps');

// No two of the notice's links and buttons share a pixel, counting each one's whole box: a phone's 44px targets reach
// into the lines around them, so a tap on one must never land on its neighbour.
async function apart(page, label) {
  const boxes = await page.evaluate(() =>
    [...document.querySelectorAll('.web-apps a, .web-apps button')].map((el) => {
      const r = el.getBoundingClientRect();
      return { name: el.textContent.trim() || el.getAttribute('aria-label'), top: r.top, bottom: r.bottom, left: r.left, right: r.right };
    })
  );
  for (const [i, a] of boxes.entries()) {
    for (const b of boxes.slice(i + 1)) {
      const overlap = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5 && Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5;
      assert.ok(!overlap, `${label}: "${a.name}" and "${b.name}" overlap`);
    }
  }
}

// Signs out through Settings, once the conversation the sign-in opened has loaded.
async function signOut(view) {
  const page = view.page;
  const settings = page.locator('#overlays .page.settings');
  await expect(page.locator('.ch-head .ch-title')).toHaveText('general');
  await page.locator(page.viewportSize().width <= 700 ? '.web-bar-settings' : '.web-foot-settings').click();
  await settings.locator('[data-a="rukoo"]').click();
  await settings.locator('[data-a="rukoo-signout"]').click();
  const before = view.problems.length;
  await page.locator('.scrim').getByRole('button', { name: tr('en', 'settings.rukoo.signOut') }).click();
  await expect(settings.locator('[data-a="rukoo-go:rukoo-signin"]')).toBeVisible();
  // A request the page had on its way when the sign-out ended the session gets a 401, which it takes as the end it
  // already knows of; Chromium logs every 4xx answer as a console error (chat.e2e.mjs d allows the same). Only those,
  // in this window, are allowed.
  const raced = view.problems.slice(before).filter((p) => /status of 401 .*\/v1\/(account\b|workspaces\/w_[\w-]+\/)/.test(p));
  view.problems.splice(before, view.problems.length - before, ...view.problems.slice(before).filter((p) => !raced.includes(p)));
  view.allowed.push(...raced);
  await settings.locator('[data-a="back"]').click();
  await settings.locator('[data-a="back"]').click();
  await expect(settings).toHaveCount(0);
}

test('a: signed out, no notice; signed in, the apps in order, with the downloads for the system', async () => {
  const view = await open({});
  const p = view.page;
  await expect(p.locator('[data-ch-empty="sign-in"]')).toBeVisible();
  await expect(notice(p)).toHaveCount(0);
  await signIn(p, await member());
  const box = notice(p);
  await expect(box).toBeVisible();
  await expect(box.locator('.web-apps-title')).toHaveText(tr('en', 'chat.web.apps.title'));
  await expect(box.locator('.web-apps-step .web-apps-name')).toHaveText(['chat.web.apps.desktopName', 'chat.web.apps.phoneName', 'chat.web.apps.voiceName'].map((k) => tr('en', k)));
  // The desktop step's first link is the file for the system Chromium runs on (Windows on a desktop, Linux in CI); the
  // phone and Voice steps link the APK and the Voice release.
  const guess = await box.getAttribute('data-platform-guess');
  const first = { windows: 'https://rukoo.io/download/installer', mac: 'https://rukoo.io/download/mac-arm64', linux: 'https://rukoo.io/download/deb' }[guess];
  assert.ok(first, `a desktop system was recognised (${guess})`);
  await expect(box.locator('[data-step="desktop"] a').first()).toHaveAttribute('href', first);
  await expect(box.locator('[data-step="desktop"] a').last()).toHaveAttribute('href', 'https://rukoo.io/#download');
  await expect(box.locator('[data-step="phone"] a')).toHaveAttribute('href', 'https://rukoo.io/download/android');
  await expect(box.locator('[data-step="voice"] a')).toHaveAttribute('href', /\/releases\/tag\/voice-v\d+\.\d+\.\d+$/);
  for (const a of await box.locator('a').all()) await expect(a).toHaveAttribute('target', '_blank');
  // It sits above the chat, which keeps the rest of the window and its composer.
  const n = await box.boundingBox();
  const chat = await p.locator('.web-shell').boundingBox();
  assert.ok(n.y + n.height <= chat.y + 1, 'the notice is above the chat');
  await expect(p.locator('.ch-compose')).toBeInViewport();
  await shot(p, 'apps-1280-light-en');
  clean(view);
});

test('b: English and Dutch, light and dark, at a desktop and a phone width', async () => {
  for (const [width, height, phone] of [
    [1280, 800, false],
    [390, 844, true]
  ]) {
    for (const colorScheme of ['light', 'dark']) {
      for (const [locale, lang] of [
        ['en-GB', 'en'],
        ['nl-NL', 'nl']
      ]) {
        const label = `apps-${width}-${colorScheme}-${lang}`;
        const view = await open({ width, height, phone, colorScheme, locale });
        const p = view.page;
        await signIn(p, await member());
        const box = notice(p);
        await expect(box.locator('.web-apps-title')).toHaveText(tr(lang, 'chat.web.apps.title'));
        await expect(box.locator('.web-apps-intro')).toHaveText(tr(lang, 'chat.web.apps.intro'));
        await expect(box.locator('[data-web-apps="dismiss"]')).toHaveAttribute('aria-label', tr(lang, 'chat.web.apps.dismiss'));
        await apart(p, label);
        await shot(p, label);
        if (phone) {
          // Every link and the close button take a finger, and the list below still shows.
          await targets(p, label);
          await expect(p.locator('.sidebar .ch-row').first()).toBeInViewport();
          // The notice makes way while the keyboard is up for the composer.
          await p.locator('.sidebar .ch-row', { hasText: 'general' }).first().tap();
          await expect(box).toBeVisible();
          await p.locator('.ch-compose .ch-input').focus();
          await expect(p.locator('.web-apps-slot')).toBeHidden();
          await p.locator('.ch-compose .ch-input').blur();
          await expect(box).toBeVisible();
          // A tap on its close button leaves the composer alone, so no keyboard comes up.
          await box.locator('[data-web-apps="dismiss"]').tap();
          await expect(notice(p)).toHaveCount(0);
          assert.equal(await p.evaluate(() => Boolean(document.activeElement?.closest('.ch-compose'))), false, `${label}: the tap kept the focus off the composer`);
        }
        clean(view);
        await view.context.close();
      }
    }
  }
});

test('b2: on a narrow phone the links stay apart; a short screen keeps chat whole and shows the notice once taller', async () => {
  // A narrow phone: under half the window, the steps scroll under the title and the close button, and chat fits.
  {
    const label = 'apps-320x640-nl';
    const view = await open({ width: 320, height: 640, phone: true, locale: 'nl-NL' });
    const p = view.page;
    await signIn(p, await member());
    const box = notice(p);
    await expect(box.locator('.web-apps-title')).toHaveText(tr('nl', 'chat.web.apps.title'));
    await apart(p, label);
    await targets(p, label);
    const n = await box.boundingBox();
    assert.ok(n.height <= 640 * 0.45 + 1, `${label}: the notice is ${Math.round(n.height)}px of 640px`);
    await expect(box.locator('[data-web-apps="dismiss"]')).toBeInViewport();
    await box.locator('.web-apps-steps').evaluate((el) => (el.scrollTop = el.scrollHeight));
    await expect(box.locator('[data-step="voice"] a')).toBeInViewport();
    await shot(p, label);
    await p.locator('.sidebar .ch-row', { hasText: 'general' }).first().tap();
    await expect(p.locator('.ch-compose .ch-input')).toBeInViewport();
    clean(view);
    await view.context.close();
  }
  // A phone turned sideways: no notice, the conversation has the window; upright again, the notice is back.
  for (const [width, height] of [
    [844, 390],
    [667, 375]
  ]) {
    const label = `apps-${width}x${height}`;
    const view = await open({ width, height, phone: true });
    const p = view.page;
    await signIn(p, await member());
    await expect(p.locator('.ch-ws-switch')).toBeVisible();
    await expect(p.locator('.web-apps-slot')).toBeHidden();
    if (width <= 700) await p.locator('.sidebar .ch-row', { hasText: 'general' }).first().tap();
    await expect(p.locator('.ch-compose .ch-input')).toBeInViewport();
    await shot(p, label);
    await p.setViewportSize({ width: height, height: width });
    await expect(notice(p)).toBeVisible();
    await apart(p, `${label} upright`);
    clean(view);
    await view.context.close();
  }
});

test('c: a sign-out hides it until the next sign-in; closing it lasts in every tab, after a reload and a new sign-in', async () => {
  const view = await open({});
  const p = view.page;
  // Another member at each sign-in: the notice belongs to the browser, not to an account, and the server hands one
  // account no more than six socket tickets at once.
  await signIn(p, await member());
  await expect(notice(p)).toBeVisible();
  await signOut(view);
  await expect(notice(p)).toHaveCount(0);
  await signIn(p, await member());
  await expect(notice(p)).toBeVisible();

  // A second tab of the same browser shows it too, until the first one closes it.
  const other = await openTab(view);
  await other.page.goto(`${env.origin}/app/`);
  await expect(notice(other.page)).toBeVisible();
  await p.bringToFront();
  await notice(p).locator('[data-web-apps="dismiss"]').focus();
  await p.keyboard.press('Enter');
  await expect(notice(p)).toHaveCount(0);
  assert.equal(await p.evaluate((key) => localStorage.getItem(key), KEY), 'dismissed');
  // The keyboard goes on to the conversation's text.
  assert.ok(await p.evaluate(() => Boolean(document.activeElement && document.activeElement.closest('.ch-compose'))), 'the focus moved to the composer');
  await expect(notice(other.page)).toHaveCount(0);

  await p.reload();
  await expect(p.locator('.ch-ws-switch')).toContainText(WORKSPACE);
  await expect(notice(p)).toHaveCount(0);
  await signOut(view);
  await signIn(p, await member());
  await expect(notice(p)).toHaveCount(0);
  await shot(p, 'apps-closed-1280-light-en');
  clean(view, other);
});

test('d: storage that refuses the page still shows the notice, and closing it holds for the page', async () => {
  const view = await openPage(env.browser, {});
  views.push(view);
  // Only the apps key fails, so the sign-in still keeps its session.
  await view.context.addInitScript((key) => {
    const get = Storage.prototype.getItem;
    const set = Storage.prototype.setItem;
    Storage.prototype.getItem = function (k) {
      if (k === key) throw new Error('blocked');
      return get.call(this, k);
    };
    Storage.prototype.setItem = function (k, v) {
      if (k === key) throw new Error('blocked');
      return set.call(this, k, v);
    };
  }, KEY);
  const p = view.page;
  await p.goto(`${env.origin}/app/`);
  await signIn(p, await member());
  await expect(notice(p)).toBeVisible();
  await notice(p).locator('[data-web-apps="dismiss"]').click();
  await expect(notice(p)).toHaveCount(0);
  // A new sign-in in the same page doesn't bring it back.
  await signOut(view);
  await signIn(p, await member());
  await expect(notice(p)).toHaveCount(0);
  clean(view);
});
