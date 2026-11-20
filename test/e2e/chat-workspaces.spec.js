// Team chat's workspace dialogs (contract 3.3, 5.10, 8.5): inviting people, joining with a link, signing up with a
// link in the invite field, leaving with channels to hand over, and deleting a workspace. The real app on a throwaway
// profile against the real account server, with Olga acted for over HTTP. One server for the file, the app per test.
const { test, expect } = require('@playwright/test');
const { tempDir, removeDir } = require('../tmp');
const { closeApp } = require('./close');
const { PASSWORD, skipWithoutServer, startServer, launch, signIn, openChat, twoPeople, composer, roomRow, dialogBox, menuItem, workspaceMenu, serverGet } = require('./chat-helpers');

skipWithoutServer();

let server;
let app;
let win;
let dataDir;

test.beforeAll(async () => {
  server = await startServer();
});

test.afterAll(async () => {
  await server?.close();
});

test.beforeEach(() => {
  dataDir = tempDir('rukoo-chat-ws-e2e-');
});

test.afterEach(async () => {
  await closeApp(app);
  app = null;
  removeDir(dataDir);
});

const pane = () => win.locator('section.chat');
const switcherName = () => win.locator('.sidebar .ch-ws-switch .name');
const toast = () => win.locator('#toast');

// The app signed in as person, in Chat.
async function ready(person) {
  ({ app, win } = await launch(server, { dataDir }));
  await signIn(win, person);
  await openChat(win);
}

async function closeSettings() {
  for (let i = 0; i < 6 && (await win.locator('.page.settings').count()); i++) await win.keyboard.press('Escape');
  await expect(win.locator('.page.settings')).toHaveCount(0);
}

test('inviting as a guest needs a channel, the link copies, and withdrawing it removes it', async () => {
  const bart = await server.seedAccount({ password: PASSWORD });
  const ws = await server.seedWorkspace(bart, { name: 'Acme', displayName: 'Bart' });
  await ready(bart);
  await expect(switcherName()).toHaveText('Acme', { timeout: 15000 });
  await expect(roomRow(win, 'general')).toBeVisible({ timeout: 15000 });

  await workspaceMenu(win, 'Invite people');
  const dialog = dialogBox(win);
  await expect(dialog.locator('h2')).toHaveText('Invite people to Acme');
  const make = dialog.locator('.buttons button').last();
  await expect(make).toHaveText('Make link');
  await expect(dialog.locator('[data-role-hint]')).toHaveText('Members see every channel the workspace can see, and can join them.');
  // A guest sees only the channels picked for them, so one is needed.
  await dialog.locator('[data-role="guest"]').click();
  await expect(dialog.locator('[data-role-hint]')).toHaveText('Guests see only the channels you pick.');
  await expect(dialog.locator('[data-guest-need]')).toHaveText('Pick at least one channel for a guest.');
  await expect(make).toBeDisabled();
  await dialog.locator('.ch-check-row', { hasText: 'general' }).locator('input').check();
  await expect(dialog.locator('[data-guest-need]')).toBeHidden();
  await expect(make).toBeEnabled();
  await dialog.locator('[name="expires"]').selectOption('3');
  await make.click();

  const field = dialog.locator('[data-step="made"] [name="link"]');
  await expect(field).toBeVisible({ timeout: 15000 });
  const link = await field.inputValue();
  expect(link).toMatch(new RegExp(`^${server.url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/join#w=${ws.id}&i=[A-Za-z0-9_-]{43}$`));
  // The line under the link says what it grants; Copy link is the filled button until the link is copied.
  await expect(dialog.locator('[data-ready]')).toHaveText(/^One person can join as a guest, only in #general, until .+\.$/);
  await expect(dialog.locator('[data-once]')).toHaveText("You'll see this link only once.");
  await expect(dialog.locator('.buttons button').last()).toHaveText('Done');
  await expect(dialog.locator('[data-copy]')).toHaveClass(/\bprimary\b/);
  await expect(dialog).toHaveClass(/\bch-quiet-close\b/);
  // Closing before copying asks first; Go back keeps the link on screen.
  await win.keyboard.press('Escape');
  const ask = win.locator('.scrim').last().locator('.dialog');
  await expect(ask.locator('h2')).toHaveText('Close without copying the link?');
  await expect(ask).toContainText('The invitation stays open until it expires. You can withdraw it under Open invitations.');
  await expect(ask.locator('.buttons button')).toHaveText(['Go back', 'Close']);
  await ask.locator('.buttons button', { hasText: 'Go back' }).click();
  await expect(win.locator('.scrim')).toHaveCount(1);
  await expect(field).toHaveValue(link);
  await dialog.locator('[data-copy]').click();
  await expect(toast()).toHaveText('Link copied');
  await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe(link);
  await expect(dialog.locator('[data-copy]')).toHaveClass(/\bsecondary\b/);
  await expect(dialog).not.toHaveClass(/\bch-quiet-close\b/);

  // The server has it as a guest invitation into general, open for three days.
  const { invites } = await serverGet(server, bart, ws.id, '/invites');
  expect(invites).toHaveLength(1);
  expect(invites[0]).toMatchObject({ role: 'guest', channels: [ws.general] });
  expect(invites[0].expiresAt - invites[0].createdAt).toBeGreaterThan(2.9 * 86400000);

  // Open invitations lists it, and Withdraw takes it away here and on the server.
  await dialog.locator('.ch-open-invites summary').click();
  const row = dialog.locator('.ch-invite');
  await expect(row).toHaveCount(1, { timeout: 15000 });
  await expect(row.locator('.ch-invite-role')).toHaveText('Guest');
  await expect(row.locator('.ch-invite-meta')).toHaveText(/^#general · Until .+ · By Bart$/);
  await row.locator('[data-withdraw]').click();
  await expect(dialog.locator('.ch-invites-none')).toHaveText('No open invitations', { timeout: 15000 });
  expect((await serverGet(server, bart, ws.id, '/invites')).invites).toHaveLength(0);
  // It was the link on screen: it says so, and nothing copies it any more.
  await expect(dialog.locator('[data-ready]')).toHaveText('Withdrawn. This link no longer works.');
  await expect(dialog.locator('[data-copy]')).toBeDisabled();
  await expect(field).toBeDisabled();
  await expect(dialog.locator('[data-once]')).toBeHidden();
  await dialog.locator('.buttons button').last().click();
  await expect(win.locator('.scrim')).toHaveCount(0);
});

test('closing a new link before copying it asks, the invitation stays open, and open rows name their channels', async () => {
  const bart = await server.seedAccount({ password: PASSWORD });
  const ws = await server.seedWorkspace(bart, { name: 'Acme', displayName: 'Bart' });
  for (const name of ['design', 'sales', 'support']) await server.seedChannel(bart, ws.id, { name });
  await ready(bart);
  await expect(roomRow(win, 'support')).toBeVisible({ timeout: 15000 });

  await workspaceMenu(win, 'Invite people');
  const dialog = dialogBox(win);
  for (const name of ['design', 'general', 'sales', 'support']) await dialog.locator('.ch-check-row', { hasText: name }).locator('input').check();
  await dialog.locator('.buttons button').last().click();
  await expect(dialog.locator('[data-ready]')).toHaveText(/^One person can join as a member, with #design, #general, #sales and 1 more, until .+\.$/, { timeout: 15000 });

  // Done before copying asks; Close closes, and the invitation is still open on the server.
  await dialog.locator('.buttons button', { hasText: 'Done' }).click();
  const ask = win.locator('.scrim').last().locator('.dialog');
  await expect(ask.locator('h2')).toHaveText('Close without copying the link?');
  await ask.locator('.buttons button', { hasText: 'Close' }).click();
  await expect(win.locator('.scrim')).toHaveCount(0);
  const { invites } = await serverGet(server, bart, ws.id, '/invites');
  expect(invites).toHaveLength(1);
  expect(invites[0].channels).toHaveLength(4);

  // Its row names two channels and counts the rest.
  await workspaceMenu(win, 'Invite people');
  await dialog.locator('.ch-open-invites summary').click();
  await expect(dialog.locator('.ch-invite .ch-invite-meta')).toHaveText(/^#design, #general \+2 · Until .+ · By Bart$/, { timeout: 15000 });
  // Nothing was made here, so Cancel closes without asking.
  await dialog.locator('.buttons button', { hasText: 'Cancel' }).click();
  await expect(win.locator('.scrim')).toHaveCount(0);
});

test('Invite people stays open while its link is made, and Tab from Done goes round the controls that show', async () => {
  const bart = await server.seedAccount({ password: PASSWORD });
  const ws = await server.seedWorkspace(bart, { name: 'Acme', displayName: 'Bart' });
  await ready(bart);
  await expect(roomRow(win, 'general')).toBeVisible({ timeout: 15000 });
  // Test hook: main holds the new invitation's answer until the spec lets it go.
  await app.evaluate(() => {
    const manage = global.__semChat.manage;
    const make = Object.getPrototypeOf(manage).createInvite;
    manage.createInvite = function (...args) {
      return new Promise((resolve, reject) => {
        global.__releaseInvite = () => {
          delete manage.createInvite;
          make.apply(this, args).then(resolve, reject);
        };
      });
    };
  });
  await workspaceMenu(win, 'Invite people');
  const dialog = dialogBox(win);
  await dialog.locator('.buttons button').last().click();
  await expect.poll(() => app.evaluate(() => typeof global.__releaseInvite)).toBe('function');
  // Escape and a click beside the dialog while the link is made leave it open: the link shows only once.
  await win.keyboard.press('Escape');
  await expect(win.locator('.scrim')).toHaveCount(1);
  await win.locator('.scrim').last().click({ position: { x: 4, y: 300 } });
  await expect(win.locator('.scrim')).toHaveCount(1);
  await app.evaluate(() => global.__releaseInvite());
  const field = dialog.locator('[data-step="made"] [name="link"]');
  await expect(field).toBeVisible({ timeout: 15000 });
  expect((await serverGet(server, bart, ws.id, '/invites')).invites).toHaveLength(1);
  // Tab from Done goes to the link, the first control that shows (the step that made it is hidden), and Shift+Tab
  // from there back to Done.
  const active = () => win.evaluate(() => document.activeElement?.getAttribute('name') || document.activeElement?.textContent || null);
  await dialog.locator('.buttons button', { hasText: 'Done' }).focus();
  await win.keyboard.press('Tab');
  expect(await active()).toBe('link');
  await win.keyboard.press('Shift+Tab');
  expect(await active()).toBe('Done');
  // Open invitations' summary is in the order too.
  await field.focus();
  await win.keyboard.press('Tab');
  await win.keyboard.press('Tab');
  expect(await active()).toBe('Open invitations');
  // Now Escape asks first, as the link isn't copied.
  await win.keyboard.press('Escape');
  await expect(win.locator('.scrim').last().locator('h2')).toHaveText('Close without copying the link?');
});

test("a late answer to blocking someone in one workspace doesn't replace the block list of the next", async () => {
  const { olga, bart, ws } = await twoPeople(server);
  await server.post(olga, ws.id, ws.general, 'Hello from Acme');
  // Beta, where Bart blocked Zed.
  const zed = await server.seedAccount();
  const beta = await server.seedWorkspace(zed, { name: 'Beta', displayName: 'Zed' });
  await server.seedMember(beta, bart, 'Bart');
  await server.post(zed, beta.id, beta.general, 'Hello from Beta');
  await server.block(bart, beta.id, beta.me.id);
  await ready(bart);
  await expect(switcherName()).toHaveText('Acme', { timeout: 15000 });
  const row = (text) => pane().locator('.ch-log li.ch-msg').filter({ has: win.locator('.ch-text', { hasText: text }) });
  const menuOf = async (text) => {
    await row(text).click({ button: 'right' });
    const items = await win.locator('.menu [role="menuitem"]').allTextContents();
    await win.keyboard.press('Escape');
    return items;
  };
  await expect(row('Hello from Acme')).toBeVisible({ timeout: 15000 });
  // Test hook: main holds the block's answer until the spec lets it go.
  await app.evaluate(() => {
    const manage = global.__semChat.manage;
    const block = Object.getPrototypeOf(manage).block;
    manage.block = function (...args) {
      return new Promise((resolve, reject) => {
        global.__releaseBlock = () => {
          delete manage.block;
          return block.apply(this, args).then(
            (r) => (resolve(r), true),
            (e) => (reject(e), false)
          );
        };
      });
    };
  });
  await row('Hello from Acme').click({ button: 'right' });
  await menuItem(win, 'Block Olga Owner').click();
  await dialogBox(win).locator('.buttons button').last().click();
  await expect.poll(() => app.evaluate(() => typeof global.__releaseBlock)).toBe('function');
  // Bart goes to Beta before the answer comes: Zed is blocked there, so his message offers no Block.
  await workspaceMenu(win, 'Beta');
  await expect(switcherName()).toHaveText('Beta', { timeout: 15000 });
  await expect(row('Hello from Beta')).toBeVisible({ timeout: 15000 });
  expect(await menuOf('Hello from Beta')).not.toContain('Block Zed');
  expect(await app.evaluate(() => global.__releaseBlock())).toBe(true);
  await win.waitForTimeout(500);
  expect(await menuOf('Hello from Beta')).not.toContain('Block Zed');
  // Acme has the block on the server all the same.
  expect((await serverGet(server, bart, ws.id, '/blocks')).blocks.map((b) => b.member)).toEqual([ws.me.id]);
});

test('closing a member menu in a dialog with the mouse leaves no key listener behind', async () => {
  const bart = await server.seedAccount({ password: PASSWORD });
  const ws = await server.seedWorkspace(bart, { name: 'Acme', displayName: 'Bart' });
  await server.seedMember(ws, await server.seedAccount(), 'Mila Bakker');
  await ready(bart);
  await expect(switcherName()).toHaveText('Acme', { timeout: 15000 });
  const cdp = await win.context().newCDPSession(win);
  const keyListeners = async () => {
    const { result } = await cdp.send('Runtime.evaluate', { expression: 'window' });
    const { listeners } = await cdp.send('DOMDebugger.getEventListeners', { objectId: result.objectId });
    return listeners.filter((l) => l.type === 'keydown').length;
  };
  await workspaceMenu(win, 'Members');
  const dialog = dialogBox(win);
  const person = dialog.locator('.ch-person', { hasText: 'Mila Bakker' }).locator('[data-person]');
  await expect(person).toBeVisible({ timeout: 15000 });
  const before = await keyListeners();
  for (let i = 0; i < 5; i++) {
    await person.click();
    await expect(win.locator('.menu')).toBeVisible();
    // A click elsewhere in the dialog closes the menu.
    await dialog.locator('h2').click();
    await expect(win.locator('.menu')).toHaveCount(0);
  }
  expect(await keyListeners()).toBeLessThanOrEqual(before + 1);
  // Escape still closes a menu alone, and the dialog with the next one.
  await person.click();
  await win.keyboard.press('Escape');
  await expect(win.locator('.menu')).toHaveCount(0);
  await expect(win.locator('.scrim')).toHaveCount(1);
  await win.keyboard.press('Escape');
  await expect(win.locator('.scrim')).toHaveCount(0);
});

test('an admin who manages no channel is told how to invite a guest, and New channel opens Make a channel', async () => {
  const { olga, bart, ws, bartMe } = await twoPeople(server);
  await server.call('PATCH', `/v1/workspaces/${ws.id}/members/${bartMe.id}`, { token: olga.token, body: { role: 'admin' } });
  await ready(bart);
  await expect(roomRow(win, 'general')).toBeVisible({ timeout: 15000 });

  await workspaceMenu(win, 'Invite people');
  const dialog = dialogBox(win);
  await expect(dialog.locator('[data-none-member]')).toHaveText("You don't manage any channels yet.");
  await expect(dialog.locator('[data-new-channel]')).toBeHidden();
  await dialog.locator('[data-role="guest"]').click();
  await expect(dialog.locator('[data-none-member]')).toBeHidden();
  await expect(dialog.locator('[data-none-guest]')).toContainText("Guests can only be added to channels you manage. Make a channel, or ask a channel's manager to make you one.");
  await expect(dialog.locator('[data-guest-need]')).toBeHidden();
  await expect(dialog.locator('.buttons button').last()).toBeDisabled();
  await dialog.locator('[data-new-channel]').click();
  await expect(dialogBox(win).locator('h2')).toHaveText('Make a channel');
  await expect(win.locator('.scrim')).toHaveCount(1);
});

test("joining Olga's workspace with a link from the Join dialog opens its first channel", async () => {
  const olga = await server.seedAccount();
  const bart = await server.seedAccount({ password: PASSWORD });
  const ws = await server.seedWorkspace(olga, { name: 'Acme', displayName: 'Olga Owner' });
  const { link, secret } = await server.createInvite(olga, ws.id, { role: 'member' });
  await ready(bart);
  await expect(pane().locator('.ch-empty-title')).toHaveText('No workspace yet', { timeout: 15000 });
  await pane().locator('[data-ch-empty="join"]').click();
  const dialog = dialogBox(win);
  await expect(dialog.locator('h2')).toHaveText('Join a workspace');
  const primary = dialog.locator('.buttons button').last();

  // Text that isn't an invitation link is refused here, without a request.
  await dialog.locator('[name="link"]').fill('see you on Monday');
  await primary.click();
  await expect(dialog.locator('[data-error="link"]')).toHaveText("This isn't a Rukoo invitation link.");
  // A link for another server only explains, with Close.
  await dialog.locator('[name="link"]').fill(`https://chat.example.org/join#w=${ws.id}&i=${secret}`);
  await primary.click();
  await expect(dialog.locator('[data-other]')).toHaveText(/This invitation is for chat\.example\.org\. Rukoo joins workspaces on 127\.0\.0\.1:\d+/);
  await expect(dialog.locator('.buttons button:visible')).toHaveText(['Close']);

  // The real link, pasted with the sentence around it and its full stop: it's checked at once, and the field shows
  // only the link, with its card, the host, and the name to use.
  await dialog.locator('[name="link"]').fill('');
  await expect(dialog.locator('[data-other]')).toBeHidden();
  await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), `Join Acme here: ${link}.`);
  await dialog.locator('[name="link"]').focus();
  await win.keyboard.press('Control+V');
  const card = dialog.locator('[data-preview]');
  await expect(card.locator('.ch-join-ws')).toHaveText('Acme', { timeout: 15000 });
  await expect(dialog.locator('[name="link"]')).toHaveValue(link);
  await expect(card).toContainText('Olga Owner invited you as a member.');
  await expect(card).toContainText('Joining a channel lets you read its earlier messages.');
  await expect(dialog.locator('[data-host] .ch-host')).toContainText('Test operator');
  await expect(primary).toHaveText('Join Acme');
  await dialog.locator('[name="name"]').fill('Bart');
  await primary.click();
  await expect(win.locator('.scrim')).toHaveCount(0, { timeout: 15000 });

  // The workspace opens on its first channel, and Olga sees Bart as a member.
  await expect(switcherName()).toHaveText('Acme', { timeout: 15000 });
  await expect(roomRow(win, 'general')).toHaveAttribute('aria-current', 'page', { timeout: 15000 });
  await expect(pane().locator('.ch-title')).toHaveText('general');
  const { members } = await serverGet(server, olga, ws.id, '/members');
  expect(members.find((m) => m.name === 'Bart')).toMatchObject({ role: 'member', state: 'active' });

  // The same link again: the card says Bart is in already, and Open opens it.
  await workspaceMenu(win, 'Join with an invitation link');
  await dialog.locator('[name="link"]').fill(link);
  await primary.click();
  await expect(card).toContainText("You're already in Acme.", { timeout: 15000 });
  await expect(dialog.locator('[name="name"]')).toBeHidden();
  await expect(primary).toHaveText('Open');
  await primary.click();
  await expect(win.locator('.scrim')).toHaveCount(0);
  await expect(toast()).toHaveText("You're already in Acme.");
});

test('signing up with an invitation link in the invite field ends in the Join dialog, and the workspace opens its first channel', async () => {
  const olga = await server.seedAccount();
  const ws = await server.seedWorkspace(olga, { name: 'Acme', displayName: 'Olga Owner' });
  const { link } = await server.createInvite(olga, ws.id, { role: 'member' });
  ({ app, win } = await launch(server, { dataDir }));
  await win.click('[data-action="settings"]');
  const page = win.locator('.page.settings');
  await page.locator('[data-a="rukoo"]').click();
  await page.locator('[data-a="rukoo-go:rukoo-signup"]').click();
  const form = page.locator('form[data-form="rukoo-signup"]');
  // The server takes workspace invitations as invite codes, and the form says so.
  await expect(form.locator('#rukoo-invite-help')).toHaveText('An invitation link to a team chat workspace works as an invite code too.');
  await form.locator('[name="email"]').fill(`newcomer-${Date.now()}@example.com`);
  await form.locator('[name="password"]').fill(PASSWORD);
  await form.locator('[name="repeat"]').fill(PASSWORD);
  await form.locator('[name="invite"]').fill(link);
  await form.locator('[name="understand"]').check();
  await form.locator('button[type=submit]').click();
  const key = dialogBox(win);
  await expect(key.locator('h2')).toHaveText('Save your recovery key', { timeout: 20000 });
  await key.locator('.buttons button').last().click();

  // Settings closes back to Chat, which opens the Join dialog with the link and its card.
  await expect(page).toHaveCount(0, { timeout: 15000 });
  await expect(win.locator('.sidebar-mode [data-mode="chat"]')).toHaveAttribute('aria-selected', 'true', { timeout: 15000 });
  const dialog = dialogBox(win);
  await expect(dialog.locator('h2')).toHaveText('Join a workspace', { timeout: 15000 });
  await expect(dialog.locator('[name="link"]')).toHaveValue(link);
  await expect(dialog.locator('[data-preview] .ch-join-ws')).toHaveText('Acme', { timeout: 15000 });
  await dialog.locator('[name="name"]').fill('Newcomer');
  await dialog.locator('.buttons button').last().click();
  await expect(win.locator('.scrim')).toHaveCount(0, { timeout: 15000 });
  await expect(switcherName()).toHaveText('Acme', { timeout: 15000 });
  await expect(roomRow(win, 'general')).toHaveAttribute('aria-current', 'page', { timeout: 15000 });
  await expect(pane().locator('.ch-title')).toHaveText('general');
  const { members } = await serverGet(server, olga, ws.id, '/members');
  expect(members.some((m) => m.name === 'Newcomer' && m.state === 'active')).toBe(true);
  // The pending join was used up.
  expect(await win.evaluate(() => window.mail.call('chatState').then((s) => s.pendingJoin))).toBe(false);
});

test('a pending join waits while another dialog is open and opens the Join dialog once it closes', async () => {
  const olga = await server.seedAccount();
  const bart = await server.seedAccount({ password: PASSWORD });
  await server.seedWorkspace(bart, { name: 'Home', displayName: 'Bart' });
  const ws = await server.seedWorkspace(olga, { name: 'Acme', displayName: 'Olga Owner' });
  const { link } = await server.createInvite(olga, ws.id, { role: 'member' });
  await ready(bart);
  await expect(switcherName()).toHaveText('Home', { timeout: 15000 });
  await workspaceMenu(win, 'Workspace settings');
  const dialog = dialogBox(win);
  await expect(dialog.locator('h2')).toHaveText('Workspace settings');

  // Test hook: main remembers the join as a sign-up with a link does (contract 3.3), while Workspace settings is open.
  await app.evaluate((_, l) => global.__semChat.manage.rememberJoin(l), link);
  await expect.poll(() => win.evaluate(() => window.mail.call('chatState').then((s) => s.pendingJoin))).toBe(true);
  await win.waitForTimeout(1000);
  await expect(win.locator('.scrim')).toHaveCount(1);
  await expect(dialog.locator('h2')).toHaveText('Workspace settings');

  // Closing it brings the Join dialog with the link.
  await dialog.locator('.buttons button').last().click();
  await expect(dialog.locator('h2')).toHaveText('Join a workspace', { timeout: 5000 });
  await expect(dialog.locator('[name="link"]')).toHaveValue(link);
  await expect(dialog.locator('[data-preview] .ch-join-ws')).toHaveText('Acme', { timeout: 15000 });
  expect(await win.evaluate(() => window.mail.call('chatState').then((s) => s.pendingJoin))).toBe(false);
  await dialog.locator('.buttons button').first().click();
  await expect(win.locator('.scrim')).toHaveCount(0);
});

test('leaving a workspace as the only manager of channels picks a successor for each, then hands over and leaves', async () => {
  const olga = await server.seedAccount();
  const bart = await server.seedAccount({ password: PASSWORD });
  const ws = await server.seedWorkspace(olga, { name: 'Acme', displayName: 'Olga Owner' });
  const bartMe = await server.seedMember(ws, bart, 'Bart');
  const mila = await server.seedMember(ws, await server.seedAccount(), 'Mila Bakker');
  const design = await server.seedChannel(bart, ws.id, { name: 'design', members: [ws.me.id] });
  const ads = await server.seedChannel(bart, ws.id, { name: 'ads', members: [ws.me.id, mila.id] });
  await ready(bart);
  await expect(roomRow(win, 'design')).toBeVisible({ timeout: 15000 });

  // No confirmation first: one dialog with a picker per channel, nobody picked.
  await workspaceMenu(win, 'Leave workspace');
  const dialog = dialogBox(win);
  await expect(dialog.locator('h2')).toHaveText('Leave Acme?', { timeout: 15000 });
  await expect(win.locator('.scrim')).toHaveCount(1);
  await expect(dialog.locator('.dialog-body > p:not(.error)')).toHaveText([
    "You're the only manager of these channels. Choose who manages each one after you.",
    "You lose access to its channels and direct messages, and the group conversations you're in close for the others too. Messages you wrote stay."
  ]);
  await expect(dialog.locator('.ch-handover-name')).toHaveText(['ads', 'design']);
  await expect(dialog.locator('input[type="radio"]:checked')).toHaveCount(0);
  const submit = dialog.locator('.buttons button').last();
  await expect(submit).toHaveText('Hand over and leave');
  await expect(submit).toBeDisabled();
  const section = (name) => dialog.locator('.ch-handover', { has: win.locator('.ch-handover-name', { hasText: name }) });
  await section('design').locator('.ch-person-pick', { hasText: 'Olga Owner' }).click();
  await expect(submit).toBeDisabled();
  await section('ads').locator('.ch-person-pick', { hasText: 'Mila Bakker' }).click();
  await expect(submit).toBeEnabled();
  await submit.click();

  // The picks manage the channels, and the workspace goes; with no other one the window offers to make or join one.
  await expect(pane().locator('.ch-empty-title')).toHaveText('No workspace yet', { timeout: 15000 });
  await expect(win.locator('.sidebar [data-ch-side="make"]')).toBeVisible();
  const { members } = await serverGet(server, olga, ws.id, '/members');
  expect(members.find((m) => m.id === bartMe.id)?.state).toBe('left');
  const roles = (await serverGet(server, olga, ws.id, `/channels/${design.id}/members`)).members;
  expect(roles).toEqual([{ member: ws.me.id, role: 'manager' }]);
  const adsRoles = (await serverGet(server, olga, ws.id, `/channels/${ads.id}/members`)).members;
  expect(adsRoles.find((m) => m.member === mila.id)?.role).toBe('manager');
  expect(adsRoles.find((m) => m.member === ws.me.id)?.role).toBe('member');
});

test('the only owner is told before any confirmation, and the menu and Workspace settings say so under Leave', async () => {
  const bart = await server.seedAccount({ password: PASSWORD });
  const ws = await server.seedWorkspace(bart, { name: 'Team', displayName: 'Bart' });
  await server.seedMember(ws, await server.seedAccount(), 'Olga');
  await ready(bart);
  await expect(switcherName()).toHaveText('Team', { timeout: 15000 });

  await workspaceMenu(win);
  await expect(menuItem(win, 'Leave workspace')).toContainText('Make someone else an owner first.');
  await menuItem(win, 'Leave workspace').click();
  const dialog = dialogBox(win);
  await expect(dialog.locator('p')).toHaveText("You're the only owner. Make someone else an owner first.", { timeout: 15000 });
  await expect(dialog.locator('.buttons button')).toHaveText(['Close', 'Members']);
  await dialog.locator('.buttons button').last().click();
  await expect(dialog.locator('h2')).toHaveText('Members of Team', { timeout: 15000 });
  await dialog.locator('.buttons button').last().click();
  await expect(win.locator('.scrim')).toHaveCount(0);

  await workspaceMenu(win, 'Workspace settings');
  await expect(dialog.locator('#ch-leave-why')).toHaveText('Make someone else an owner first.');
  await expect(dialog.locator('[data-set="leave"]')).toHaveAttribute('aria-describedby', 'ch-leave-why');
});

test('Owner and Guest ask first in a member menu, and Admin and Member apply with Undo that sets the role back', async () => {
  const bart = await server.seedAccount({ password: PASSWORD });
  const ws = await server.seedWorkspace(bart, { name: 'Acme', displayName: 'Bart' });
  const mila = await server.seedMember(ws, await server.seedAccount(), 'Mila Bakker');
  const roleOf = async () => (await serverGet(server, bart, ws.id, '/members')).members.find((m) => m.id === mila.id)?.role;
  await ready(bart);
  await expect(switcherName()).toHaveText('Acme', { timeout: 15000 });

  await workspaceMenu(win, 'Members');
  const dialog = dialogBox(win);
  await expect(dialog.locator('h2')).toHaveText('Members of Acme');
  const milaRow = dialog.locator('.ch-person', { hasText: 'Mila Bakker' });
  const pick = async (role) => {
    await milaRow.locator('[data-person]').click({ timeout: 15000 });
    await menuItem(win, role).first().click();
  };

  // Admin applies at once and says so; Undo makes her a member again.
  await pick('Admin');
  await expect(win.locator('.scrim')).toHaveCount(1);
  await expect(toast().locator('span')).toHaveText('Mila Bakker is now an admin');
  await expect.poll(roleOf, { timeout: 15000 }).toBe('admin');
  await toast().locator('button').click();
  await expect.poll(roleOf, { timeout: 15000 }).toBe('member');

  // Owner asks first, and Escape keeps her a member.
  await pick('Owner');
  await expect(win.locator('.scrim')).toHaveCount(2);
  await expect(dialog.locator('h2')).toHaveText('Make Mila Bakker an owner?');
  await expect(dialog.locator('p')).toHaveText('Owners can change everything in Acme, including removing you.');
  await expect(dialog.locator('.buttons button').last()).toHaveText('Make owner');
  await win.keyboard.press('Escape');
  await expect(win.locator('.scrim')).toHaveCount(1);
  expect(await roleOf()).toBe('member');
  await pick('Owner');
  await dialog.locator('.buttons button').last().click();
  await expect.poll(roleOf, { timeout: 15000 }).toBe('owner');

  // Member from owner: Undo sets owner back, not member.
  await pick('Member');
  await expect(toast().locator('span')).toHaveText('Mila Bakker is now a member');
  await expect.poll(roleOf, { timeout: 15000 }).toBe('member');
  await toast().locator('button').click();
  await expect.poll(roleOf, { timeout: 15000 }).toBe('owner');

  // Guest asks first and says what closes.
  await pick('Guest');
  await expect(win.locator('.scrim')).toHaveCount(2);
  await expect(dialog.locator('h2')).toHaveText('Make Mila Bakker a guest?');
  await expect(dialog.locator('p')).toHaveText(
    'Mila Bakker will only see the channels someone adds them to. The direct messages Mila Bakker is in close for everyone in them.'
  );
  await expect(dialog.locator('.buttons button').last()).toHaveText('Make guest');
  await dialog.locator('.buttons button').last().click();
  await expect(win.locator('.scrim')).toHaveCount(1);
  await expect.poll(roleOf, { timeout: 15000 }).toBe('guest');
  await dialog.locator('.buttons button').last().click();
  await expect(win.locator('.scrim')).toHaveCount(0);
});

test('an owner deletes a workspace when alone in it, and Delete stays off while someone else is in it', async () => {
  const bart = await server.seedAccount({ password: PASSWORD });
  const olga = await server.seedAccount();
  const team = await server.seedWorkspace(bart, { name: 'Team', displayName: 'Bart' });
  await server.seedMember(team, olga, 'Olga');
  const solo = await server.seedWorkspace(bart, { name: 'Solo', displayName: 'Bart' });
  await ready(bart);
  await expect(switcherName()).toBeVisible({ timeout: 15000 });

  // In Team, with Olga in it, Workspace settings says why Delete is off.
  await workspaceMenu(win, 'Team');
  await expect(switcherName()).toHaveText('Team', { timeout: 15000 });
  await workspaceMenu(win, 'Workspace settings');
  const dialog = dialogBox(win);
  await expect(dialog.locator('h2')).toHaveText('Workspace settings');
  await expect(dialog.locator('[data-set="delete"]')).toBeDisabled();
  await expect(dialog.locator('#ch-delete-why')).toHaveText("You can delete a workspace when you're its only member. Remove everyone else first.");
  await expect(dialog.locator('.ch-set-title')).toHaveText(['You', 'Host', 'Invitations', 'Blocked people']);
  await expect(dialog.locator('.ch-set-leave button')).toHaveText(['Leave workspace', 'Delete workspace']);
  // Your name opens over Workspace settings, and Escape closes only that dialog.
  await dialog.locator('[data-set="name"]').click();
  await expect(win.locator('.scrim')).toHaveCount(2);
  await win.keyboard.press('Escape');
  await expect(win.locator('.scrim')).toHaveCount(1);
  await expect(dialog.locator('h2')).toHaveText('Workspace settings');
  await dialog.locator('.buttons button').last().click();
  await expect(win.locator('.scrim')).toHaveCount(0);
  // The workspace menu has no Delete while Olga is in Team.
  await workspaceMenu(win);
  await expect(menuItem(win, 'Leave workspace')).toBeVisible();
  await expect(menuItem(win, 'Delete workspace')).toHaveCount(0);
  await win.keyboard.press('Escape');

  // Solo has only Bart: the menu offers Delete, which asks, then the workspace goes and Team opens.
  await workspaceMenu(win, 'Solo');
  await expect(switcherName()).toHaveText('Solo', { timeout: 15000 });
  await workspaceMenu(win);
  await expect(menuItem(win, 'Delete workspace')).toHaveCount(1);
  await win.keyboard.press('Escape');
  await workspaceMenu(win, 'Workspace settings');
  await expect(dialog.locator('[data-set="delete"]')).toBeEnabled();
  await dialog.locator('[data-set="delete"]').click();
  await expect(dialog.locator('h2')).toHaveText('Delete Solo?');
  await expect(dialog.locator('p')).toHaveText("This deletes every channel and message in it. You can't undo this.");
  await dialog.locator('.buttons button').last().click();
  await expect(toast()).toHaveText('Deleted Solo', { timeout: 15000 });
  await expect(switcherName()).toHaveText('Team', { timeout: 15000 });
  await expect(roomRow(win, 'general')).toBeVisible();
  const listed = await server.call('GET', '/v1/workspaces', { token: bart.token });
  expect(listed.body.workspaces.map((w) => w.id)).toEqual([team.id]);
  expect((await server.call('GET', `/v1/workspaces/${solo.id}`, { token: bart.token })).status).toBe(404);
});

test('Settings has the team chat notifications switch, and the account page counts unsent messages and explains deletion', async () => {
  const { bart } = await twoPeople(server);
  await ready(bart);
  await expect(roomRow(win, 'general')).toBeVisible({ timeout: 15000 });
  // Test hook: main's outbox doesn't send, so the message stays unsent on this computer.
  await app.evaluate(() => {
    global.__semChat.outbox.pump = () => {};
  });
  await composer(win).click();
  await win.keyboard.type('Waiting to go out');
  await win.keyboard.press('Enter');
  await expect(win.locator('section.chat .ch-main .ch-log li.ch-msg.is-pending')).toHaveCount(1, { timeout: 15000 });
  await expect.poll(() => win.evaluate(() => window.mail.call('chatState').then((s) => s.unsent))).toBe(1);

  await win.click('[data-action="settings"]');
  const page = win.locator('.page.settings');
  const row = page.locator('[data-a="toggle:chatNotifications"]');
  await expect(row).toContainText('Team chat notifications', { timeout: 15000 });
  await expect(row).toContainText('Direct messages and mentions in your workspaces.');
  await expect(row.locator('.switch')).toHaveAttribute('aria-checked', 'true');
  await row.click();
  await expect(page.locator('[data-a="toggle:chatNotifications"] .switch')).toHaveAttribute('aria-checked', 'false');
  await expect.poll(() => win.evaluate(() => window.mail.call('chatState').then((s) => s.notifications))).toBe(false);

  await page.locator('[data-a="rukoo"]').click();
  await page.locator('[data-a="rukoo-signout"]').click();
  const dialog = dialogBox(win);
  await expect(dialog.locator('p')).toContainText("1 chat message hasn't been sent yet and is lost when you sign out.");
  await dialog.locator('.buttons button').first().click();
  await page.locator('[data-a="rukoo-delete"]').click();
  await expect(dialog.locator('[data-note]')).toHaveText("Messages you wrote in team chat stay in their workspaces under a deleted member, until each workspace's retention removes them.");
  await dialog.locator('.buttons button').first().click();
  await expect(win.locator('.scrim')).toHaveCount(0);
  await closeSettings();
});
