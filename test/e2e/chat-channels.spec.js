// Team chat's channel dialogs (contract 5.4, 5.5, 5.10, 8.5): making a visible and a private channel, browsing and
// joining, archiving, renaming, leaving as the only manager, and muting. The real app on a throwaway profile against
// the real account server, with Olga acted for over HTTP. One server for the file, the app per test.
const { test, expect } = require('@playwright/test');
const { tempDir, removeDir } = require('../tmp');
const { closeApp } = require('./close');
const { skipWithoutServer, startServer, launch, signIn, openChat, twoPeople, roomRow, dialogBox, menuItem, roomMenu, serverGet, connected } = require('./chat-helpers');

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
  dataDir = tempDir('rukoo-chat-ch-e2e-');
});

test.afterEach(async () => {
  await closeApp(app);
  app = null;
  removeDir(dataDir);
});

const pane = () => win.locator('section.chat');
const title = () => pane().locator('.ch-main .ch-title');
const bar = () => pane().locator('.ch-main .ch-bar');
const toast = () => win.locator('#toast');

async function ready(person) {
  ({ app, win } = await launch(server, { dataDir }));
  await signIn(win, person);
  await openChat(win);
  await expect(roomRow(win, 'general')).toBeVisible({ timeout: 15000 });
}

async function makeChannel(name, { visibility = 'workspace' } = {}) {
  await win.locator('.sidebar [data-ch-side="channel-add"]').click();
  await menuItem(win, 'Make a channel').click();
  const dialog = dialogBox(win);
  await expect(dialog.locator('h2')).toHaveText('Make a channel');
  await dialog.locator('[name="name"]').fill(name);
  if (visibility === 'private') await dialog.locator('[name="visibility"][value="private"]').check();
  await dialog.locator('.buttons button').last().click();
  return dialog;
}

test("making a visible and a private channel; the private one asks who to add and stays out of Olga's directory", async () => {
  const { olga, bart, ws } = await twoPeople(server);
  await ready(bart);

  const dialog = await makeChannel('roadmap');
  await expect(win.locator('.scrim')).toHaveCount(0, { timeout: 15000 });
  await expect(title()).toHaveText('roadmap', { timeout: 15000 });
  await expect(roomRow(win, 'roadmap')).toHaveAttribute('aria-current', 'page');
  await expect(pane().locator('.ch-main .ch-meta')).toHaveText('1 member');

  // The same name again is refused under the field, and the dialog stays.
  await makeChannel('Roadmap');
  await expect(dialog.locator('[data-error="name"]')).toHaveText("There's already a channel with that name.", { timeout: 15000 });
  await dialog.locator('.buttons button').first().click();
  await expect(win.locator('.scrim')).toHaveCount(0);

  // A private channel opens on Add people, since nobody else is in it yet.
  await makeChannel('secret plans', { visibility: 'private' });
  await expect(title()).toHaveText('secret plans', { timeout: 15000 });
  await expect(pane().locator('.ch-main .ch-meta')).toHaveText('1 member · Private');
  const members = dialogBox(win);
  await expect(members.locator('h2')).toHaveText('Members of #secret plans', { timeout: 15000 });
  await expect(members.locator('.ch-sub')).toHaveText('Add people to #secret plans');
  await expect(members.locator('[data-pick] .ch-check-row', { hasText: 'Olga Owner' })).toBeVisible();
  await members.locator('.buttons button').last().click();
  await expect(win.locator('.scrim')).toHaveCount(0);

  // Olga's directory has roadmap and not the private channel.
  const { channels } = await serverGet(server, olga, ws.id, '/channels');
  expect(channels.map((c) => c.name).sort()).toEqual(['general', 'roadmap']);
});

test('browsing finds a channel, previews it with a Join bar, and joining opens it', async () => {
  const { olga, bart, ws, bartMe } = await twoPeople(server);
  const design = await server.seedChannel(olga, ws.id, { name: 'design' });
  const ops = await server.seedChannel(olga, ws.id, { name: 'ops' });
  await server.post(olga, ws.id, design.id, 'Mockups are up');
  await ready(bart);

  await win.locator('.sidebar [data-ch-side="browse"]').click();
  const dialog = dialogBox(win);
  await expect(dialog.locator('h2')).toHaveText('Channels in Acme');
  await expect(dialog.locator('[data-list] .ch-browse-name')).toHaveText(['design', 'general', 'ops']);
  await expect(dialog.locator('.ch-browse-row', { hasText: 'general' }).locator('.ch-pill')).toHaveText('Joined');
  await dialog.locator('[name="search"]').fill('zzz');
  await expect(dialog.locator('.ch-browse-none')).toHaveText('No channels match.');
  await dialog.locator('[name="search"]').fill('DES');
  await expect(dialog.locator('[data-list] .ch-browse-name')).toHaveText(['design']);

  // A channel Bart isn't in opens with its header and a Join bar in place of the composer.
  await dialog.locator('[data-open]', { hasText: 'design' }).click();
  await expect(win.locator('.scrim')).toHaveCount(0);
  await expect(title()).toHaveText('design');
  await expect(bar().locator('.ch-bar-text')).toHaveText("You're not in #design yet.");
  await expect(pane().locator('.ch-main .ch-box')).toBeHidden();
  await expect(pane().locator('.ch-empty-title')).toHaveText('This is the start of #design');
  await bar().locator('[data-ch-bar="join"]').click();
  await expect(roomRow(win, 'design')).toHaveAttribute('aria-current', 'page', { timeout: 15000 });
  await expect(pane().locator('.ch-main .ch-log li.ch-msg .ch-text', { hasText: 'Mockups are up' })).toBeVisible({ timeout: 15000 });
  await expect(pane().locator('.ch-main .ch-box')).toBeVisible();
  const designMembers = (await serverGet(server, olga, ws.id, `/channels/${design.id}/members`)).members;
  expect(designMembers.map((m) => m.member)).toContain(bartMe.id);

  // Join in the dialog joins and opens at once.
  await win.locator('.sidebar [data-ch-side="browse"]').click();
  await dialog.locator('.ch-browse-row', { hasText: 'ops' }).locator('[data-join]').click();
  await expect(win.locator('.scrim')).toHaveCount(0, { timeout: 15000 });
  await expect(title()).toHaveText('ops', { timeout: 15000 });
  await expect(roomRow(win, 'ops')).toHaveAttribute('aria-current', 'page');
  expect((await serverGet(server, olga, ws.id, `/channels/${ops.id}/members`)).members.map((m) => m.member)).toContain(bartMe.id);
});

test('archiving a channel asks first and shows the archived bar', async () => {
  const { bart, ws } = await twoPeople(server);
  await server.seedChannel(bart, ws.id, { name: 'launch' });
  await ready(bart);
  await roomRow(win, 'launch').click();
  await expect(title()).toHaveText('launch');
  await roomMenu(win, 'Archive channel');
  const dialog = dialogBox(win);
  await expect(dialog.locator('h2')).toHaveText('Archive #launch?');
  await dialog.locator('.buttons button').last().click();
  await expect(bar().locator('.ch-bar-text')).toHaveText('#launch is archived. You can still read it.', { timeout: 15000 });
  await expect(pane().locator('.ch-main .ch-box')).toBeHidden();
  await expect(pane().locator('.ch-main .ch-log li.ch-sys').last()).toContainText('archived');
  // An archived channel has nothing left to archive, rename or add people to.
  await roomMenu(win);
  await expect(menuItem(win, 'Archive channel')).toHaveCount(0);
  await expect(menuItem(win, 'Rename channel')).toHaveCount(0);
  await expect(menuItem(win, 'Add people')).toHaveCount(0);
  await win.keyboard.press('Escape');
});

test('renaming a channel changes its name in the header, the sidebar and for Olga', async () => {
  const { olga, bart, ws } = await twoPeople(server);
  const channel = await server.seedChannel(bart, ws.id, { name: 'misc' });
  await ready(bart);
  await roomRow(win, 'misc').click();
  await roomMenu(win, 'Rename channel');
  const dialog = dialogBox(win);
  await expect(dialog.locator('h2')).toHaveText('Rename #misc');
  await expect(dialog.locator('[name="name"]')).toHaveValue('misc');
  // The name the general channel has is taken.
  await dialog.locator('[name="name"]').fill('General');
  await dialog.locator('.buttons button').last().click();
  await expect(dialog.locator('[data-error="name"]')).toHaveText("There's already a channel with that name.", { timeout: 15000 });
  await dialog.locator('[name="name"]').fill('Café talk');
  await dialog.locator('.buttons button').last().click();
  await expect(win.locator('.scrim')).toHaveCount(0, { timeout: 15000 });
  await expect(title()).toHaveText('Café talk', { timeout: 15000 });
  await expect(roomRow(win, 'Café talk')).toHaveAttribute('aria-current', 'page');
  const { channels } = await serverGet(server, olga, ws.id, '/channels');
  expect(channels.find((c) => c.id === channel.id)?.name).toBe('Café talk');
});

test('leaving a channel as its only manager asks for a successor', async () => {
  const { olga, bart, ws, bartMe } = await twoPeople(server);
  const channel = await server.seedChannel(bart, ws.id, { name: 'handover', members: [ws.me.id] });
  await ready(bart);
  await roomRow(win, 'handover').click();
  await expect(title()).toHaveText('handover');
  await roomMenu(win, 'Leave channel');
  const dialog = dialogBox(win);
  await expect(dialog.locator('h2')).toHaveText('Leave #handover?');
  await expect(dialog.locator('p')).toHaveText('You can join again from Browse channels.');
  await dialog.locator('.buttons button').last().click();
  await expect(dialog.locator('h2')).toHaveText('Choose a new manager for #handover', { timeout: 15000 });
  await expect(dialog.locator('.ch-person-pick .ch-check-label')).toHaveText(['Olga Owner'], { timeout: 15000 });
  await expect(dialog.locator('[name="successor"]')).toBeChecked();
  await dialog.locator('.buttons button').last().click();
  await expect(win.locator('.scrim')).toHaveCount(0, { timeout: 15000 });
  // The room leaves the sidebar and the next conversation opens; Olga manages it now.
  await expect(roomRow(win, 'handover')).toHaveCount(0, { timeout: 15000 });
  await expect(title()).toHaveText('general');
  await expect(pane().locator('.ch-empty-title')).toBeHidden();
  const roles = (await serverGet(server, olga, ws.id, `/channels/${channel.id}/members`)).members;
  expect(roles).toEqual([{ member: ws.me.id, role: 'manager' }]);
  expect(roles.some((m) => m.member === bartMe.id)).toBe(false);
});

test('removing someone from a channel asks about that channel only, and Escape there keeps the members dialog', async () => {
  const { bart, ws, bartMe } = await twoPeople(server);
  const channel = await server.seedChannel(bart, ws.id, { name: 'design', members: [ws.me.id] });
  await ready(bart);
  await roomRow(win, 'design').click();
  await expect(title()).toHaveText('design');
  await roomMenu(win, 'Members');
  const dialog = dialogBox(win);
  await expect(dialog.locator('h2')).toHaveText('Members of #design');
  const olgaRow = dialog.locator('.ch-person', { hasText: 'Olga Owner' });
  await olgaRow.locator('[data-person]').click({ timeout: 15000 });
  await menuItem(win, 'Remove from #design').click();
  // The confirmation opens over the members dialog and speaks of this channel, not the workspace.
  await expect(win.locator('.scrim')).toHaveCount(2);
  await expect(dialog.locator('h2')).toHaveText('Remove Olga Owner from #design?');
  await expect(dialog.locator('p')).toHaveText("Olga Owner won't be in #design anymore. What they wrote stays.");
  // Escape closes the confirmation alone.
  await win.keyboard.press('Escape');
  await expect(win.locator('.scrim')).toHaveCount(1);
  await expect(dialog.locator('h2')).toHaveText('Members of #design');
  await expect(olgaRow).toHaveCount(1);

  // Removing her for real takes her out of the channel, and she stays in the workspace.
  await olgaRow.locator('[data-person]').click();
  await menuItem(win, 'Remove from #design').click();
  await dialog.locator('.buttons button').last().click();
  await expect(win.locator('.scrim')).toHaveCount(1);
  await expect(olgaRow).toHaveCount(0, { timeout: 15000 });
  const roles = (await serverGet(server, bart, ws.id, `/channels/${channel.id}/members`)).members;
  expect(roles.map((m) => m.member)).toEqual([bartMe.id]);
  const { members } = await serverGet(server, bart, ws.id, '/members');
  expect(members.find((m) => m.id === ws.me.id)?.state).toBe('active');
  await dialog.locator('.buttons button').last().click();
  await expect(win.locator('.scrim')).toHaveCount(0);
});

test('muting a conversation dims its row and silences the mode badge', async () => {
  const { olga, bart, ws, bartMe } = await twoPeople(server);
  const dm = await server.seedDm(olga, ws.id, [bartMe.id]);
  await server.post(olga, ws.id, dm.conversation, 'Hello there');
  await ready(bart);
  await connected(win);
  const row = roomRow(win, 'Olga Owner');
  await row.click();
  await expect(title()).toHaveText('Olga Owner');
  await roomMenu(win, 'Mute');
  await expect(toast()).toHaveText('Muted Olga Owner');
  await expect(row).toHaveClass(/is-muted/, { timeout: 10000 });
  await expect(row).toHaveAttribute('aria-label', 'Olga Owner, muted');
  await expect(pane().locator('.ch-head-muted')).toBeVisible();
  await roomRow(win, 'general').click();
  await expect(title()).toHaveText('general');

  // Olga writes again: the muted row stays quiet, and the Chat segment shows nothing.
  await server.post(olga, ws.id, dm.conversation, 'Are you there?');
  await expect
    .poll(() => win.evaluate(([w, c]) => window.mail.call('chatView', w).then((v) => v.rooms.find((r) => r.id === c)?.unread || 0), [ws.id, dm.conversation]), { timeout: 15000 })
    .toBe(1);
  await expect(row).not.toHaveClass(/is-unread/);
  await expect(row.locator('.ch-badge, .count')).toHaveCount(0);
  const seg = win.locator('.sidebar-mode [data-mode="chat"]');
  await expect(seg.locator('.seg-badge, .seg-dot')).toHaveCount(0);
  expect(await win.evaluate(() => window.mail.call('chatState').then((s) => [s.attention, s.unread]))).toEqual([0, false]);

  // Unmuted (here without opening it, which would read it), the row and the Chat segment count her message again.
  await win.evaluate(([w, c]) => window.mail.call('chatMute', w, c, false), [ws.id, dm.conversation]);
  await expect(row).not.toHaveClass(/is-muted/, { timeout: 10000 });
  await expect(row.locator('.ch-badge')).toHaveText('1');
  await expect(seg.locator('.seg-badge')).toHaveText('1');
  // And the menu offers Mute again.
  await row.click();
  await roomMenu(win);
  await expect(menuItem(win, /^Mute$/)).toHaveCount(1);
  await expect(menuItem(win, /^Unmute$/)).toHaveCount(0);
  await win.keyboard.press('Escape');
});
