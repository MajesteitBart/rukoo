// Rukoo Chat in the browser, end to end: the real site and account Workers (harness.mjs), headless Chromium, and only
// the interface a person uses. The tests run in order and build on each other: an invitation brings Maya in (a), she
// and the owner, Olga, write to each other live through the wake socket (b), Maya reloads (c), signs out and in again
// (d), a Dutch browser gets Dutch (f), a phone shows the list or the conversation and its back gesture closes what is
// on top (g), a used invitation says so (h), a Join dialog that was cancelled stays gone (i), an engine that can't start
// offers a reload (j), a sign-out in one tab reaches the other (k), and Settings follows another tab into another
// account (l) or another session of the same one (m). Each test fails on a console or page error and on horizontal
// overflow.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import {
  NO_CATCHUP,
  PASSWORD,
  anotherSession,
  browserBack,
  clean,
  expect,
  makeAccount,
  message,
  noOverflow,
  openPage,
  openRoom,
  openTab,
  recordRuns,
  row,
  runs,
  send,
  shot,
  signIn,
  startWorkers,
  targets,
  toastOver,
  tr
} from './harness.mjs';

const MAYA = { email: 'maya@example.test', password: PASSWORD, name: 'Maya Member' };
const WORKSPACE = 'Acme Studio';
// A message that arrives live is on screen within this; the catch-up timer of the pages in b would take half an hour.
const LIVE_MS = 10000;

let env = null;
let olga = null;
let ws = null;
let owner = null;
let member = null;
// Olga's invitation link, which Maya's sign-up used.
let invitation = null;

before(async () => {
  env = await startWorkers();
  // The owner can sign in through the page; Piet is someone the page never signs in as.
  olga = await makeAccount(env.origin, { email: 'olga@example.test' });
  const piet = await env.seed.seedAccount();
  ws = await env.seed.seedWorkspace(olga, { name: WORKSPACE, displayName: 'Olga Owner' });
  await env.seed.seedMember(ws, piet, 'Piet de Vries');
  await env.seed.post(olga, ws.id, ws.general, 'Morning all. The new onboarding flow is on staging.');
  await env.seed.post(piet, ws.id, ws.general, 'Looked at it on my phone: the second step cuts off the button.');
});

after(async () => {
  for (const view of [owner, member]) await view?.context.close().catch(() => {});
  await env?.close();
});

test('a: the owner makes an invitation, and the link signs a new person up and into the workspace', async () => {
  // Olga's and Maya's pages catch up only through their wake socket (NO_CATCHUP), for b.
  owner = await openPage(env.browser, { timing: NO_CATCHUP });
  const o = owner.page;
  await owner.context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: env.origin });
  const app = await o.goto(`${env.origin}/app/`);
  // The Worker's policy for the app, with the socket's address spelled out.
  const policy = app.headers()['content-security-policy'] || '';
  const host = new URL(env.origin).host;
  assert.match(policy, new RegExp(`connect-src 'self' wss://${host} ws://${host}`));
  assert.match(policy, /script-src 'self' 'wasm-unsafe-eval'/);
  await signIn(o, olga);
  await expect(o.locator('.ch-ws-switch')).toContainText(WORKSPACE);

  // Invite people, in the workspace menu: the link shows once and is copied.
  await o.locator('.ch-ws-switch').click();
  await o.getByRole('menuitem', { name: tr('en', 'chat.workspace.invite') }).click();
  const dialog = o.locator('.scrim .dialog');
  await dialog.getByRole('button', { name: tr('en', 'chat.invite.make') }).click();
  const field = dialog.locator('[data-step="made"] input[name="link"]');
  await expect(field).toHaveValue(new RegExp(`^${env.origin}/join#w=w_[A-Za-z0-9_-]{22}&i=[A-Za-z0-9_-]+$`));
  const link = await field.inputValue();
  invitation = link;
  await dialog.locator('[data-copy]').click();
  await expect(o.locator('#toast.show', { hasText: tr('en', 'chat.invite.copied') })).toBeVisible();
  await dialog.getByRole('button', { name: tr('en', 'chat.invite.done') }).click();
  await expect(o.locator('.scrim')).toHaveCount(0);

  // A fresh browser opens the link: the server's /join sends it to /app/, which keeps the invitation and takes the
  // secret out of the address bar.
  member = await openPage(env.browser, { timing: NO_CATCHUP });
  const m = member.page;
  const landed = await m.goto(link);
  const hop = landed.request().redirectedFrom();
  assert.ok(hop, 'the link was redirected');
  assert.equal(new URL(hop.url()).pathname, '/join');
  assert.equal((await hop.response()).status(), 302);
  // The signed-out pane says where team chat runs, that the link is kept, and offers creating an account first.
  await expect(m.locator('.chat .ch-empty-body')).toHaveText(tr('en', 'chat.empty.webInvitedBody', { host }));
  await expect(m.locator('.chat .ch-empty-hint')).toHaveText(tr('en', 'chat.empty.webInvitedHint'));
  await expect(m.locator('[data-ch-empty="sign-up"]')).toHaveClass(/\bprimary\b/);
  await expect(m.locator('[data-ch-empty="sign-in"]')).toHaveClass(/\bsecondary\b/);
  assert.equal(m.url(), `${env.origin}/app/`, 'the invitation left the address bar');
  await shot(m, 'a1-invitation-landing');

  // Sign-up: no invite code to type, the form says the link is used.
  await m.locator('[data-ch-empty="sign-up"]').click();
  const form = m.locator('form[data-form="rukoo-signup"]');
  await expect(form.locator('[data-invitation]')).toHaveText(tr('en', 'settings.rukoo.webInvitation'));
  await expect(form.locator('input[name="invite"]')).toBeHidden();
  await expect(form.locator('button[type="submit"]')).toHaveClass(/\bprimary\b/);
  // The server's privacy statement is a row away before the account exists: the browser has no privacy page.
  const policyRow = m.locator('#overlays .page.settings [data-a="rukoo-link:policy"]');
  await expect(policyRow).toContainText(tr('en', 'settings.rukoo.policy'));
  const statement = m.waitForEvent('popup');
  await policyRow.click();
  const opened = await statement;
  assert.equal(opened.url(), `${env.origin}/privacy`);
  await opened.close();
  await shot(m, 'a2-sign-up-invitation');
  await form.locator('input[name="email"]').fill(MAYA.email);
  await form.locator('input[name="password"]').fill(MAYA.password);
  await form.locator('input[name="repeat"]').fill(MAYA.password);
  await form.locator('input[name="understand"]').check();
  await form.locator('button[type="submit"]').click();

  // The recovery key shows once, after the account exists.
  const key = m.locator('.scrim [data-recovery-key]');
  await expect(key).toHaveText(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){7}$/);
  await shot(m, 'a3-recovery-key');
  await m.locator('.scrim').getByRole('button', { name: tr('en', 'settings.rukoo.keySaved') }).click();

  // Settings closes and the Join dialog opens with the workspace the link is for.
  await expect(m.locator('#overlays .page.settings')).toHaveCount(0);
  const join = m.locator('.scrim .dialog');
  await expect(join.locator('.ch-join-ws')).toHaveText(WORKSPACE);
  // The workspace's card lays its lines out one under the other, the name on one line (not a link card's two columns).
  const card = await join.locator('[data-preview]').boundingBox();
  const head = await join.locator('[data-preview] .ch-join-head').boundingBox();
  assert.ok(head.width > card.width - 40, `the card's head spans the card (${head.width} of ${card.width})`);
  assert.ok((await join.locator('.ch-join-ws').boundingBox()).height < 32, 'the name on one line');
  await join.locator('input[name="name"]').fill(MAYA.name);
  await shot(m, 'a4-join-dialog');
  await join.getByRole('button', { name: tr('en', 'chat.join.submit', { name: WORKSPACE }) }).click();
  await expect(m.locator('.scrim')).toHaveCount(0);
  await expect(m.locator('.ch-ws-switch')).toContainText(WORKSPACE);
  await expect(row(m, 'general')).toBeVisible();
  assert.equal(m.url(), `${env.origin}/app/`);
  // In the workspace, the page lists the Rukoo apps in the order to get them, once (apps.e2e.mjs covers the notice).
  await expect(m.locator('.web-apps-slot:not([hidden]) .web-apps')).toHaveCount(1);
  await expect(m.locator('.web-apps-title')).toHaveText(tr('en', 'chat.web.apps.title'));
  await shot(m, 'a5-joined-apps-notice');
  clean(owner, member);
});

// What act() sends reaches view's page live: within LIVE_MS, and its engine ran for a 'wake' from the socket. The
// page's catch-up timer is half an hour (NO_CATCHUP) and it does nothing meanwhile (its open room has loaded), so only
// the wake socket can bring it in that time.
async function arrivesLive(view, locator, act) {
  const before = (await runs(view.page)).length;
  await act();
  await expect(locator).toBeVisible({ timeout: LIVE_MS });
  await expect
    .poll(async () => (await runs(view.page)).slice(before), { message: 'the engine ran for a wake from the socket', timeout: LIVE_MS })
    .toContain('wake');
}

test('b: channel messages, a direct message and a thread reply arrive live both ways', async () => {
  const o = owner.page;
  const m = member.page;
  await recordRuns(o);
  await recordRuns(m);
  // Both rooms have loaded before anything is sent: what comes next comes live.
  await openRoom(m, 'general');
  await expect(message(m, 'Morning all.')).toBeVisible();
  await openRoom(o, 'general');
  await expect(message(o, 'Morning all.')).toBeVisible();

  await arrivesLive(owner, message(o, 'Hello everyone, Maya here.'), () => send(m, 'Hello everyone, Maya here.'));
  await arrivesLive(member, message(m, 'Welcome, Maya! Glad you are here.'), () => send(o, 'Welcome, Maya! Glad you are here.'));
  // The wake socket of each page is open, and the server's wake frames came through it.
  for (const view of [owner, member]) {
    assert.ok(view.sockets.opened.length >= 1, 'a wake socket opened');
    assert.ok(view.sockets.frames.some((f) => f.includes('"wake"')), 'the server sent the page a wake');
  }
  await shot(o, 'b1-channel-light');
  await o.emulateMedia({ colorScheme: 'dark' });
  await expect(o.locator('html')).not.toHaveClass(/\blight\b/);
  await shot(o, 'b2-channel-dark');
  await o.emulateMedia({ colorScheme: 'light' });
  await expect(o.locator('html')).toHaveClass(/\blight\b/);

  // A direct message from New message, answered.
  await o.locator('[data-ch-side="new-message"]').click();
  const pick = o.locator('.scrim .dialog');
  await pick.locator('input[name="to"]').fill('Maya');
  await pick.locator('.ch-new-row[data-pick]', { hasText: MAYA.name }).click();
  await pick.locator('.buttons button').last().click();
  await expect(o.locator('.ch-head .ch-title')).toHaveText(MAYA.name);
  await arrivesLive(member, row(m, 'Olga Owner'), () => send(o, 'Can you review the agenda before ten?'));
  await openRoom(m, 'Olga Owner');
  await expect(message(m, 'Can you review the agenda before ten?')).toBeVisible();
  await arrivesLive(owner, message(o, 'Reviewed, two notes in the doc.'), () => send(m, 'Reviewed, two notes in the doc.'));
  await shot(o, 'b3-direct-message');

  // A thread reply on Olga's welcome; she sees the reply count come in and answers in the thread.
  await openRoom(m, 'general');
  await openRoom(o, 'general');
  await expect(message(o, 'Welcome, Maya!')).toBeVisible();
  const root = message(m, 'Welcome, Maya!');
  await root.hover();
  await root.locator('[data-ch-tool="reply"]').click();
  await expect(m.locator('.ch-thread:not([hidden])')).toBeVisible();
  const summary = message(o, 'Welcome, Maya!').locator('.ch-replies', { hasText: tr('en', 'chat.log.replies', { count: 1 }) });
  await arrivesLive(owner, summary, () => send(m, 'Thanks! I will start on the onboarding review.', { compose: '.ch-thread-compose', log: '.ch-thread-log' }));
  await summary.click();
  await expect(message(o, 'Thanks! I will start on the onboarding review.', '.ch-thread-log')).toBeVisible();
  await expect(message(m, 'Thanks! I will start on the onboarding review.', '.ch-thread-log')).toBeVisible();
  await arrivesLive(member, message(m, 'Perfect, ping me when it is ready.', '.ch-thread-log'), () =>
    send(o, 'Perfect, ping me when it is ready.', { compose: '.ch-thread-compose', log: '.ch-thread-log' })
  );
  await shot(o, 'b4-thread');
  clean(owner, member);
});

test('c: after a reload the member is still signed in, the history is there and the invitation is gone', async () => {
  const m = member.page;
  await m.reload();
  await expect(m.locator('.ch-ws-switch')).toContainText(WORKSPACE);
  await expect(m.locator('[data-ch-empty="sign-in"]')).toHaveCount(0);
  // The last conversation opens again, with its history from the server.
  await expect(m.locator('.ch-head .ch-title')).toHaveText('general');
  for (const text of ['Morning all.', 'Hello everyone, Maya here.', 'Welcome, Maya!']) await expect(message(m, text)).toBeVisible();
  await expect(message(m, 'Welcome, Maya!').locator('.ch-replies')).toContainText(tr('en', 'chat.log.replies', { count: 2 }));
  // The invitation was used: nothing offers it again.
  assert.equal(await m.evaluate(() => sessionStorage.getItem('rukoo.web.join')), null);
  await expect(m.locator('.scrim')).toHaveCount(0);
  clean(member);
});

test('d: signing out and in again through Settings brings the history back', async () => {
  const m = member.page;
  const settings = m.locator('#overlays .page.settings');
  // At a desktop width a room is no history entry, but Settings is: the browser's back closes it and stays on the page.
  const depth = () => m.evaluate(() => (history.state && history.state.depth) || 0);
  assert.equal(await depth(), 0, 'an open room pushes nothing at a desktop width');
  await m.locator('.web-foot-settings').click();
  await expect(settings).toHaveCount(1);
  await browserBack(m);
  await expect(settings).toHaveCount(0);
  assert.equal(m.url(), `${env.origin}/app/`, 'back closed Settings and kept the page');

  await m.locator('.web-foot-settings').click();
  await expect(settings.locator('[data-a="toggle:chatNotifications"]')).toBeVisible();
  await expect(settings.locator('[data-a="rukoo"]')).toContainText(MAYA.email);
  await shot(m, 'd1-settings-signed-in');
  await settings.locator('[data-a="rukoo"]').click();
  await settings.locator('[data-a="rukoo-signout"]').click();
  const before = member.problems.length;
  await m.locator('.scrim').getByRole('button', { name: tr('en', 'settings.rukoo.signOut') }).click();
  await expect(settings.locator('[data-a="rukoo-go:rukoo-signin"]')).toBeVisible();
  // A sync the engine had on its way when the sign-out ended the session gets a 401 from the workspace route, which
  // the engine takes as the end it already knows of; Chromium logs every 4xx answer as a console error. Only that one,
  // in this window, is allowed.
  const raced = member.problems.slice(before).filter((p) => /status of 401 .*\/v1\/workspaces\/w_[\w-]+\/(changes|conversations\/)/.test(p));
  member.problems.splice(before, member.problems.length - before, ...member.problems.slice(before).filter((p) => !raced.includes(p)));
  member.allowed.push(...raced);
  await settings.locator('[data-a="back"]').click();
  await settings.locator('[data-a="back"]').click();
  await expect(settings).toHaveCount(0);
  await expect(m.locator('.chat .ch-empty-title')).toHaveText(tr('en', 'chat.empty.signedOutTitle'));
  // No invitation is waiting any more: the usual hint, and Sign in first.
  await expect(m.locator('.chat .ch-empty-hint')).toHaveText(tr('en', 'chat.empty.inviteHint'));
  await expect(m.locator('[data-ch-empty="sign-in"]')).toHaveClass(/\bprimary\b/);

  await signIn(m, MAYA);
  await openRoom(m, 'general');
  for (const text of ['Morning all.', 'Hello everyone, Maya here.', 'Welcome, Maya!']) await expect(message(m, text)).toBeVisible();
  await openRoom(m, 'Olga Owner');
  await expect(message(m, 'Reviewed, two notes in the doc.')).toBeVisible();
  clean(member);
});

test('f: a Dutch browser gets the Dutch interface on its first visit', async () => {
  const dutch = await openPage(env.browser, { locale: 'nl-NL' });
  const p = dutch.page;
  try {
    await p.goto(`${env.origin}/app/`);
    await expect(p.locator('html')).toHaveAttribute('lang', 'nl');
    await expect(p.locator('.chat .ch-empty-title')).toHaveText(tr('nl', 'chat.empty.signedOutTitle'));
    await expect(p.locator('[data-ch-empty="sign-in"]')).toHaveText(tr('nl', 'chat.empty.signInAction'));
    await signIn(p, olga);
    await openRoom(p, 'general');
    await expect(message(p, 'Hello everyone, Maya here.')).toBeVisible();
    await expect(message(p, 'Welcome, Maya!').locator('.ch-replies')).toContainText(tr('nl', 'chat.log.replies', { count: 2 }));
    await shot(p, 'f1-channel-nl');
    clean(dutch);
  } finally {
    await dutch.context.close();
  }
});

// Olga writes in general with an @mention of Maya, picked from the composer's list, and waits until it is sent.
async function mentionMaya(o, text) {
  await o.locator('.ch-compose .ch-input').click();
  await o.keyboard.type('@Maya');
  await expect(o.locator('[role="listbox"] [role="option"]', { hasText: MAYA.name })).toBeVisible();
  await o.keyboard.press('Enter');
  await o.keyboard.type(text);
  await o.keyboard.press('Enter');
  await expect(message(o, text)).toHaveAttribute('data-seq', /\d+/);
}

// The notice showing now ends above what selector matches: the composer of a conversation, the list's foot.
async function toastAbove(p, selector, label) {
  const at = await toastOver(p, selector);
  assert.ok(at.below, `${label}: ${selector} is on screen`);
  assert.ok(at.toast.bottom <= at.below.top, `${label}: the notice (${at.toast.top}-${at.toast.bottom}) ends above ${selector} (from ${at.below.top})`);
}

test('g: a phone shows the list or the conversation, with Back, and its back gesture closes what is on top', async () => {
  // Offline, Chromium logs each request and socket the page can't make.
  const phone = await openPage(env.browser, { width: 390, height: 844, phone: true, allow: [/ERR_INTERNET_DISCONNECTED/] });
  const p = phone.page;
  const o = owner.page;
  const settings = p.locator('#overlays .page.settings');
  try {
    // A page before Rukoo, as the mail an invitation came in: a back that leaves Rukoo would land there.
    await p.goto(`${env.origin}/`);
    await p.goto(`${env.origin}/app/`);
    await expect(p.locator('[data-ch-empty="sign-in"]')).toBeVisible();
    await targets(p, 'the phone signed-out pane');

    // Create an account opens Settings on its form, over the overview: back goes where Settings' Back goes, then
    // closes it, and the page stays.
    await p.locator('[data-ch-empty="sign-up"]').tap();
    await expect(p.locator('form[data-form="rukoo-signup"]')).toBeVisible();
    await targets(p, 'the phone sign-up form');
    await browserBack(p);
    await expect(p.locator('form[data-form="rukoo-signup"]')).toHaveCount(0);
    await expect(settings).toHaveCount(1);
    await browserBack(p);
    await expect(settings).toHaveCount(0);
    await expect(p.locator('[data-ch-empty="sign-in"]')).toBeVisible();
    assert.equal(p.url(), `${env.origin}/app/`, 'back closed Settings and kept the page');

    await signIn(p, MAYA);
    // The list, with no conversation opened by itself behind it.
    await expect(p.locator('body')).toHaveAttribute('data-web-pane', 'list');
    await expect(row(p, 'general')).toBeVisible();
    await expect(p.locator('.sidebar .ch-row[aria-current="page"]')).toHaveCount(0);
    await shot(p, 'g1-phone-list');
    await targets(p, 'the phone list');

    // Olga mentions Maya in general. Nothing has general open on the phone, so the mention comes as a toast, above the
    // list's status line.
    await openRoom(o, 'general');
    await mentionMaya(o, 'can you check the phone layout?');
    await expect(p.locator('#toast.show', { hasText: 'can you check the phone layout?' })).toBeVisible();
    await toastAbove(p, '.sidebar-foot', 'the phone list');

    // Settings from the list: the back gesture closes it, the list shows, the page stays.
    await p.locator('.web-bar-settings').tap();
    await expect(settings.locator('[data-a="rukoo"]')).toContainText(MAYA.email);
    await shot(p, 'g3-phone-settings');
    await targets(p, 'phone Settings');
    await browserBack(p);
    await expect(settings).toHaveCount(0);
    await expect(p.locator('body')).toHaveAttribute('data-web-pane', 'list');
    assert.equal(p.url(), `${env.origin}/app/`, 'back closed Settings and kept the page');

    // Open the conversation, answer, and go Back to the list.
    await row(p, 'general').click();
    await expect(p.locator('body')).toHaveAttribute('data-web-pane', 'main');
    await expect(p.locator('.ch-head .ch-title')).toHaveText('general');
    await expect(message(p, 'can you check the phone layout?')).toBeVisible();
    await expect(p.locator('.web-back')).toBeVisible();
    await send(p, 'On it, checking at 390 pixels now.');
    await expect(message(o, 'On it, checking at 390 pixels now.')).toBeVisible();
    await targets(p, 'the phone conversation');
    // A direct message comes in while general is open: its notice sits above the composer.
    await openRoom(o, MAYA.name);
    await send(o, 'Quick one: are you free at three?');
    await expect(p.locator('#toast.show', { hasText: 'are you free at three?' })).toBeVisible();
    await toastAbove(p, '.ch-main > .ch-compose .ch-box', 'the phone conversation');
    await shot(p, 'g2-phone-conversation');
    // Offline, the banner over the conversation offers Try now: a 44px target too, which takes a tap at its edges,
    // where its touch area reaches past the banner over the header and the log.
    await phone.context.setOffline(true);
    const tryNow = p.locator('.ch-banner [data-ch-banner]');
    await expect(tryNow).toHaveText(tr('en', 'chat.banner.tryNow'));
    await expect(p.locator('.ch-banner .ch-banner-text')).toHaveText(tr('en', 'chat.banner.offline', { host: new URL(env.origin).host }));
    await targets(p, 'the phone offline banner');
    const edges = await tryNow.evaluate((b) => {
      const r = b.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const middle = r.top + r.height / 2;
      return [middle - 21, middle + 21].map((y) => {
        const hit = document.elementFromPoint(x, y);
        return Boolean(hit) && (hit === b || b.contains(hit));
      });
    });
    assert.deepEqual(edges, [true, true], 'Try now takes a tap 21px above and below its middle');
    await shot(p, 'g4-phone-offline');
    await phone.context.setOffline(false);
    await expect(p.locator('.ch-banner')).toBeHidden();
    assert.ok(phone.allowed.length > 0, 'the offline requests were the errors allowed');
    // Settings over the conversation: back closes Settings and the conversation stays.
    await p.locator('.web-bar-settings').tap();
    await expect(settings).toHaveCount(1);
    await browserBack(p);
    await expect(settings).toHaveCount(0);
    await expect(p.locator('body')).toHaveAttribute('data-web-pane', 'main');
    await p.locator('.web-back').click();
    await expect(p.locator('body')).toHaveAttribute('data-web-pane', 'list');
    await expect(row(p, 'general')).toBeVisible();
    await noOverflow(p, 'the phone list after Back');

    // A wider window shows the conversation again, as on a desktop. Narrow again, the list hides it, and a new
    // mention in it comes as a toast once more.
    await p.setViewportSize({ width: 1280, height: 800 });
    await expect(p.locator('.ch-head .ch-title')).toHaveText('general');
    await expect(message(p, 'On it, checking at 390 pixels now.')).toBeVisible();
    await noOverflow(p, 'the phone page at a desktop width');
    await p.setViewportSize({ width: 390, height: 844 });
    await expect(p.locator('body')).toHaveAttribute('data-web-pane', 'list');
    await openRoom(o, 'general');
    await mentionMaya(o, 'and the tablet width too, please.');
    await expect(p.locator('#toast.show', { hasText: 'and the tablet width too, please.' })).toBeVisible();
    // With nothing of Rukoo's on top, the back gesture leaves for the page before.
    await browserBack(p);
    await expect.poll(() => new URL(p.url()).pathname).toBe('/');
    clean(phone, owner);
  } finally {
    await phone.context.close();
  }
});

test('h: an invitation link that was used already says so and brings back the invite code field', async () => {
  // The server refuses the sign-up with 403 invite_required, which Chromium logs as a failed resource.
  const late = await openPage(env.browser, { allow: [/Failed to load resource: the server responded with a status of 403/] });
  const p = late.page;
  try {
    await p.goto(invitation);
    await expect(p.locator('.chat .ch-empty-hint')).toHaveText(tr('en', 'chat.empty.webInvitedHint'));
    await p.locator('[data-ch-empty="sign-up"]').click();
    const form = p.locator('form[data-form="rukoo-signup"]');
    await expect(form.locator('[data-invitation]')).toBeVisible();
    await form.locator('input[name="email"]').fill('late@example.test');
    await form.locator('input[name="password"]').fill(PASSWORD);
    await form.locator('input[name="repeat"]').fill(PASSWORD);
    await form.locator('input[name="understand"]').check();
    await form.locator('button[type="submit"]').click();
    // The page's own invitation was refused: the link stopped working, which the server's text doesn't say.
    await expect(form.locator('[data-error]')).toHaveText(tr('en', 'settings.rukoo.webInvitationGone'));
    await expect(form.locator('input[name="invite"]')).toBeVisible();
    await expect(form.locator('input[name="invite"]')).toBeFocused();
    await expect(form.locator('[data-invitation]')).toHaveCount(0);
    await shot(p, 'h1-used-invitation');
    // A code the person typed gets the server's own text.
    await form.locator('input[name="invite"]').fill('not-a-code');
    await form.locator('button[type="submit"]').click();
    await expect(form.locator('[data-error]')).toHaveText(tr('en', 'account.errors.invite_required'));
    assert.equal(late.allowed.length, 2, 'the two refused sign-ups');
    clean(late);
  } finally {
    await late.context.close();
  }
});

test('i: a Join dialog the person cancelled is not offered again after a reload', async () => {
  const m = member.page;
  const second = await env.seed.seedWorkspace(olga, { name: 'Second Studio', displayName: 'Olga Owner' });
  const { link } = await env.seed.createInvite(olga, second.id);
  // Signed in already: the link opens the Join dialog at once.
  await m.goto(link);
  const join = m.locator('.scrim .dialog');
  await expect(join.locator('.ch-join-ws')).toHaveText('Second Studio');
  assert.equal(m.url(), `${env.origin}/app/`);
  // Cancel, the dialog's first button.
  await m.locator('.scrim .buttons button').first().click();
  await expect(m.locator('.scrim')).toHaveCount(0);
  await expect.poll(() => m.evaluate(() => sessionStorage.getItem('rukoo.web.join'))).toBeNull();

  await m.reload();
  await expect(m.locator('.ch-ws-switch')).toContainText(WORKSPACE);
  // The engine is up and has no join waiting, so the dialog can't come back.
  await expect.poll(() => m.evaluate(async () => (await window.mail.invoke('chatState')).result.pendingJoin)).toBe(false);
  await expect(m.locator('.scrim')).toHaveCount(0);
  clean(member);
});

test("j: when team chat's engine can't start, the page offers a reload instead of a spinner", async () => {
  // The WebAssembly answers 404, which Chromium logs, and the bridge logs why chat couldn't start.
  const broken = await openPage(env.browser, { allow: [/status of 404/, /team chat could not start/] });
  const p = broken.page;
  const wasm = '**/app/web/sql-wasm.wasm';
  try {
    await p.route(wasm, (route) => route.fulfill({ status: 404, contentType: 'text/plain', body: 'Not found' }));
    await p.goto(`${env.origin}/app/`);
    const gate = p.locator('.web-gate');
    await expect(gate.locator('.ch-empty-title')).toHaveText(tr('en', 'chat.empty.storageTitle'));
    await expect(gate.locator('.ch-empty-body')).toHaveText(tr('en', 'chat.empty.webStorageBody'));
    await expect(gate.locator('.spinner')).toHaveCount(0);
    await expect(p.locator('.sidebar-foot .sync-status .t')).toHaveText(tr('en', 'chat.web.statusFailed'));
    await expect(p.locator('section.chat')).toBeHidden();
    const state = await p.evaluate(async () => (await window.mail.invoke('chatState')).result);
    assert.equal(state.engineFailed, true);
    assert.match(state.engineError, /404/);
    await shot(p, 'j1-engine-failed');
    assert.ok(broken.allowed.some((text) => /status of 404/.test(text)), 'the 404 was the failure');

    // Reload page, with the file back: chat starts.
    await p.unroute(wasm);
    await Promise.all([p.waitForEvent('load'), gate.locator('[data-gate="reload"]').click()]);
    await expect(p.locator('.chat .ch-empty-title')).toHaveText(tr('en', 'chat.empty.signedOutTitle'));
    await expect(gate).toBeHidden();
    clean(broken);
  } finally {
    await broken.context.close();
  }
});

test('k: a sign-out in one tab counts the unsent messages of the other, which then says it lost them', async () => {
  const tara = await makeAccount(env.origin, { email: 'tara@example.test' });
  await env.seed.seedMember(ws, tara, 'Tara Tabs');
  const first = await openPage(env.browser);
  const a = first.page;
  try {
    await a.goto(`${env.origin}/app/`);
    await signIn(a, tara);
    // A second tab of the same browser is signed in through the shared storage.
    const second = await openTab(first);
    const b = second.page;
    await b.goto(`${env.origin}/app/`);
    await expect(b.locator('.ch-ws-switch')).toContainText(WORKSPACE);
    await openRoom(b, 'general');
    // The second tab's messages don't reach the server: the request stays open, as on a network that went away.
    await b.route(/\/conversations\/[^/]+\/messages$/, (route) => (route.request().method() === 'POST' ? undefined : route.continue()));
    await b.locator('.ch-compose .ch-input').click();
    await b.keyboard.type('This one waits for the network.');
    await b.keyboard.press('Enter');
    await expect(message(b, 'This one waits for the network.')).toBeVisible();
    await expect.poll(() => b.evaluate(async () => (await window.mail.invoke('chatState')).result.unsent)).toBe(1);
    // The second tab has its Rukoo account page open.
    const bSettings = b.locator('#overlays .page.settings');
    await b.locator('.web-foot-settings').click();
    await bSettings.locator('[data-a="rukoo"]').click();
    await expect(bSettings.locator('[data-a="rukoo-signout"]')).toBeVisible();

    // The first tab signs out: its confirmation counts the message the second tab holds.
    const aSettings = a.locator('#overlays .page.settings');
    await a.locator('.web-foot-settings').click();
    await aSettings.locator('[data-a="rukoo"]').click();
    await aSettings.locator('[data-a="rukoo-signout"]').click();
    const confirm = a.locator('.scrim .dialog');
    await expect(confirm).toContainText(tr('en', 'settings.rukoo.webUnsentChat', { count: 1 }));
    await confirm.getByRole('button', { name: tr('en', 'settings.rukoo.signOut') }).click();
    await expect(aSettings.locator('[data-a="rukoo-go:rukoo-signin"]')).toBeVisible();

    // The second tab follows: its account page shows the signed-out rows, and a notice says what was lost and why.
    await expect(bSettings.locator('[data-a="rukoo-go:rukoo-signin"]')).toBeVisible();
    await expect(b.locator('#toast.show', { hasText: tr('en', 'chat.webLostUnsentSignedOut', { count: 1 }) })).toBeVisible();
    await expect.poll(() => b.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('rukoo.web.unsent.')))).toEqual([]);
    // The notice told the bridge it showed them (chat.js noticeLostUnsent), so the state no longer reports them.
    await expect.poll(() => b.evaluate(async () => (await window.mail.invoke('chatState')).result.lostUnsent)).toBe(0);
    clean(first, second);
  } finally {
    await first.context.close();
  }
});

test("l: Settings follows another tab's sign-in to another account, with that account's devices", async () => {
  const xavier = await makeAccount(env.origin, { email: 'xavier@example.test', deviceName: 'Xavier laptop' });
  const yara = await makeAccount(env.origin, { email: 'yara@example.test', deviceName: 'Yara phone' });
  await env.seed.seedMember(ws, xavier, 'Xavier Tabs');
  await env.seed.seedMember(ws, yara, 'Yara Tabs');
  const first = await openPage(env.browser);
  const a = first.page;
  try {
    await a.goto(`${env.origin}/app/`);
    await signIn(a, xavier);
    // Xavier's devices come from the server, and that answer reaches the page only once the account changed (release).
    let release = null;
    const hold = new Promise((resolve) => (release = resolve));
    let fetched = null;
    const answered = new Promise((resolve) => (fetched = resolve));
    let held = false;
    await a.route('**/v1/account', async (route) => {
      if (route.request().method() !== 'GET' || held) return route.continue();
      held = true;
      const response = await route.fetch();
      fetched();
      await hold;
      await route.fulfill({ response });
    });
    const settings = a.locator('#overlays .page.settings');
    const device = (name) => settings.locator('.row', { hasText: name });
    await a.locator('.web-foot-settings').click();
    await settings.locator('[data-a="rukoo"]').click();
    await expect(settings).toContainText(xavier.email);
    await answered;

    // Another tab of this browser stores a session of Yara's in one step, as a sign-in there does, with no sign-out
    // first for this tab to hear.
    const second = await openTab(first);
    const b = second.page;
    try {
      await b.goto(`${env.origin}/`);
      await b.evaluate(
        ({ origin, email, token }) => localStorage.setItem('rukoo.web.session', JSON.stringify({ v: 1, server: origin, email, token, at: Date.now() })),
        { origin: env.origin, email: yara.email, token: yara.token }
      );
      // The page shows Yara's account and asks the server for her devices at once: well within the 15 seconds after
      // which a redraw asks again anyway (rukoo-account.js FILL_AGAIN_AFTER), and the account's 20 second request
      // timeout that would end the held answer.
      await expect(settings).toContainText(yara.email);
      await expect(device('Yara phone')).toBeVisible({ timeout: 5000 });
      await expect(device('Xavier laptop')).toHaveCount(0);
      await expect(settings).not.toContainText(xavier.email);
      // Xavier's late answer is dropped: the devices stay Yara's.
      const late = a.waitForResponse((r) => new URL(r.url()).pathname === '/v1/account' && r.request().method() === 'GET');
      release();
      await late;
      await a.waitForTimeout(1000);
      await expect(device('Yara phone')).toBeVisible();
      await expect(device('Xavier laptop')).toHaveCount(0);
      await shot(a, 'l1-settings-other-account');
      clean(first, second);
    } finally {
      await b.close();
    }
  } finally {
    await first.context.close();
  }
});

test('m: Settings follows another session of the same account, and drops a devices answer it asked for before', async () => {
  const zed = await makeAccount(env.origin, { email: 'zed@example.test', deviceName: 'Zed laptop' });
  await env.seed.seedMember(ws, zed, 'Zed Sessions');
  // The devices request this test fails on purpose is one Chromium logs.
  const first = await openPage(env.browser, { allow: [/Failed to load resource/] });
  const a = first.page;
  const THIS = tr('en', 'settings.rukoo.thisDevice');
  const UNAVAILABLE = tr('en', 'settings.rukoo.devicesUnavailable');
  try {
    await a.goto(`${env.origin}/app/`);
    await signIn(a, zed);
    // What the page's GET /v1/account requests meet, in order: hold (the answer waits for release), fail, else through.
    const plan = [];
    const hold = () => {
      const h = { do: 'hold' };
      h.gate = new Promise((resolve) => (h.release = resolve));
      h.at = new Promise((resolve) => (h.fetched = resolve));
      return h;
    };
    await a.route('**/v1/account', async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const step = plan.shift();
      if (!step) return route.continue();
      if (step.do === 'fail') return route.abort('failed');
      const response = await route.fetch();
      step.fetched();
      await step.gate;
      await route.fulfill({ response });
    });
    const settings = a.locator('#overlays .page.settings');
    const device = (name) => settings.locator('.row', { hasText: name });
    const toStorage = (page, token) =>
      page.evaluate(
        ({ origin, email, token: t }) => {
          if (t) localStorage.setItem('rukoo.web.session', JSON.stringify({ v: 1, server: origin, email, token: t, at: Date.now() }));
          else localStorage.removeItem('rukoo.web.session');
        },
        { origin: env.origin, email: zed.email, token }
      );
    // The answer for this browser's own session waits.
    const firstAnswer = hold();
    plan.push(firstAnswer);
    await a.locator('.web-foot-settings').click();
    await settings.locator('[data-a="rukoo"]').click();
    await expect(settings).toContainText(zed.email);
    await firstAnswer.at;

    const second = await openTab(first);
    const b = second.page;
    try {
      await b.goto(`${env.origin}/`);
      // Another tab signs this browser out and in again to the same account: the page asks for the new session's
      // devices, and the answer still out for the session before is dropped when it comes.
      await toStorage(b, null);
      await expect(settings.locator('[data-a="rukoo-go:rukoo-signin"]')).toBeVisible();
      await toStorage(b, await anotherSession(env.origin, zed, 'Zed second'));
      await expect(device('Zed second')).toContainText(THIS);
      const late = a.waitForResponse((r) => new URL(r.url()).pathname === '/v1/account' && r.request().method() === 'GET');
      firstAnswer.release();
      await late;
      await a.waitForTimeout(1000);
      await expect(device('Zed second')).toContainText(THIS);

      // A racing sign-in there stores another session of the same account in one step: the page asks again, also when
      // that fails.
      plan.push({ do: 'fail' });
      await toStorage(b, await anotherSession(env.origin, zed, 'Zed third'));
      await expect(settings).toContainText(UNAVAILABLE, { timeout: 5000 });
      // The next session's devices are on their way: a spinner, not the failure of the session before.
      const fourthAnswer = hold();
      plan.push(fourthAnswer);
      await toStorage(b, await anotherSession(env.origin, zed, 'Zed fourth'));
      await fourthAnswer.at;
      await expect(settings).not.toContainText(UNAVAILABLE);
      await expect(settings.locator('.card .spinner')).toBeVisible();
      fourthAnswer.release();
      await expect(device('Zed fourth')).toContainText(THIS);
      await expect(device('Zed third')).not.toContainText(THIS);
      await shot(a, 'm1-settings-other-session');
      assert.ok(first.allowed.length > 0, 'the failed devices request was the error allowed');
      clean(first, second);
    } finally {
      await b.close();
    }
  } finally {
    await first.context.close();
  }
});
