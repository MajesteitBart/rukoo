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
  await expect(dialog.locator('[data-ready]')).toContainText('It works once.');
  await expect(dialog.locator('.buttons button').last()).toHaveText('Done');
  await dialog.locator('[data-copy]').click();
  await expect(toast()).toHaveText('Link copied');
  await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe(link);

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
  await expect(row.locator('.ch-invite-meta')).toContainText('1 channel');
  await expect(row.locator('.ch-invite-meta')).toContainText('By Bart');
  await row.locator('[data-withdraw]').click();
  await expect(dialog.locator('.ch-invites-none')).toHaveText('No open invitations', { timeout: 15000 });
  expect((await serverGet(server, bart, ws.id, '/invites')).invites).toHaveLength(0);
  await dialog.locator('.buttons button').last().click();
  await expect(win.locator('.scrim')).toHaveCount(0);
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

  // The real link: its card, the host, and the name to use.
  await dialog.locator('[name="link"]').fill(link);
  await expect(dialog.locator('[data-other]')).toBeHidden();
  await primary.click();
  const card = dialog.locator('[data-preview]');
  await expect(card.locator('.ch-join-ws')).toHaveText('Acme', { timeout: 15000 });
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

test('leaving a workspace as the only manager of a channel asks to hand it over first', async () => {
  const olga = await server.seedAccount();
  const bart = await server.seedAccount({ password: PASSWORD });
  const ws = await server.seedWorkspace(olga, { name: 'Acme', displayName: 'Olga Owner' });
  const bartMe = await server.seedMember(ws, bart, 'Bart');
  const design = await server.seedChannel(bart, ws.id, { name: 'design', members: [ws.me.id] });
  await ready(bart);
  await expect(roomRow(win, 'design')).toBeVisible({ timeout: 15000 });

  await workspaceMenu(win, 'Leave workspace');
  const dialog = dialogBox(win);
  await expect(dialog.locator('h2')).toHaveText('Leave Acme?');
  await expect(dialog.locator('p')).toHaveText('You lose access to its channels and direct messages. Messages you wrote stay.');
  await dialog.locator('.buttons button').last().click();
  // The server answers last_manager with the channel: it opens its members dialog.
  await expect(dialog.locator('p')).toHaveText("You're the only manager of these channels. Hand each one over before you leave.", { timeout: 15000 });
  await dialog.locator('.ch-browse-row', { hasText: 'design' }).locator('[data-room]').click();
  await expect(dialog.locator('h2')).toHaveText('Members of #design', { timeout: 15000 });
  await expect(pane().locator('.ch-title')).toHaveText('design');
  const olgaRow = dialog.locator('.ch-person', { hasText: 'Olga Owner' });
  await olgaRow.locator('[data-person]').click();
  await menuItem(win, 'Make manager').click();
  await expect(olgaRow.locator('.ch-pill')).toHaveText('Manager', { timeout: 15000 });
  await dialog.locator('.buttons button').last().click();

  // Now leaving works: the workspace goes, and with no other one the window offers to make or join one.
  await workspaceMenu(win, 'Leave workspace');
  await dialogBox(win).locator('.buttons button').last().click();
  await expect(pane().locator('.ch-empty-title')).toHaveText('No workspace yet', { timeout: 15000 });
  await expect(win.locator('.sidebar [data-ch-side="make"]')).toBeVisible();
  const { members } = await serverGet(server, olga, ws.id, '/members');
  expect(members.find((m) => m.id === bartMe.id)?.state).toBe('left');
  const roles = (await serverGet(server, olga, ws.id, `/channels/${design.id}/members`)).members;
  expect(roles).toEqual([{ member: ws.me.id, role: 'manager' }]);
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
  await expect(dialog.locator('.ch-set-why')).toHaveText("You can delete a workspace when you're its only member. Remove everyone else first.");
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
