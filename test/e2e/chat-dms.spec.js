// Team chat's direct messages (contract 3.12, 5.10, 8.5): New message for one person and a group, opening an existing
// set, a notification that opens the conversation at its message, blocking from a DM and unblocking from Workspace
// settings, leaving a group, and what a guest doesn't get. The real app on a throwaway profile against the real
// account server, with Olga and Sanne acted for over HTTP. One server for the file, the app per test.
const { test, expect } = require('@playwright/test');
const { tempDir, removeDir } = require('../tmp');
const { closeApp } = require('./close');
const {
  PASSWORD,
  skipWithoutServer,
  startServer,
  launch,
  signIn,
  openChat,
  twoPeople,
  notices,
  roomRow,
  dialogBox,
  roomMenu,
  workspaceMenu,
  serverDms,
  serverRoom,
  serverGet,
  connected
} = require('./chat-helpers');

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
  dataDir = tempDir('rukoo-chat-dm-e2e-');
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
const dmRow = (text) => win.locator('.sidebar .ch-row').filter({ hasText: text });

async function ready(person, opts = {}) {
  ({ app, win } = await launch(server, { dataDir, ...opts }));
  await signIn(win, person);
  await openChat(win);
  await expect(roomRow(win, 'general')).toBeVisible({ timeout: 15000 });
}

// Olga, Bart and Sanne in Acme.
async function threePeople() {
  const people = await twoPeople(server);
  const sanne = await server.seedAccount();
  const sanneMe = await server.seedMember(people.ws, sanne, 'Sanne');
  return { ...people, sanne, sanneMe };
}

test('New message starts a conversation with one person and with a group of three', async () => {
  const { olga, bart, ws, bartMe, sanneMe } = await threePeople();
  await ready(bart);

  await win.locator('.sidebar [data-ch-side="new-message"]').click();
  const dialog = dialogBox(win);
  await expect(dialog.locator('h2')).toHaveText('New message');
  await expect(dialog.locator('.ch-host')).toContainText('can read direct messages');
  const primary = dialog.locator('.buttons button').last();
  await expect(primary).toHaveText('Start conversation');
  await expect(primary).toBeDisabled();
  // Everyone else who is a full member, and nobody else: not Bart himself.
  await expect(dialog.locator('.ch-new-row .ch-person-name')).toHaveText(['Olga Owner', 'Sanne']);
  await dialog.locator('[name="to"]').fill('olg');
  await expect(dialog.locator('.ch-new-row .ch-person-name')).toHaveText(['Olga Owner']);
  await win.keyboard.press('Enter');
  await expect(dialog.locator('.ch-to-chip .ch-to-name')).toHaveText(['Olga Owner']);
  await primary.click();
  await expect(win.locator('.scrim')).toHaveCount(0, { timeout: 15000 });
  await expect(title()).toHaveText('Olga Owner', { timeout: 15000 });
  await expect(roomRow(win, 'Olga Owner')).toHaveAttribute('aria-current', 'page');
  const one = (await serverDms(server, olga, ws.id)).find((d) => d.participants.length === 2);
  expect(one.participants.sort()).toEqual([ws.me.id, bartMe.id].sort());

  // Ctrl+N, two people, and Backspace takes the last one off again.
  await pane().locator('.ch-main .ch-input').click();
  await win.keyboard.press('Control+n');
  await expect(dialog.locator('h2')).toHaveText('New message');
  await dialog.locator('.ch-new-row', { hasText: 'Olga Owner' }).click();
  await dialog.locator('[name="to"]').fill('san');
  await win.keyboard.press('Enter');
  await expect(dialog.locator('.ch-to-chip .ch-to-name')).toHaveText(['Olga Owner', 'Sanne']);
  await win.keyboard.press('Backspace');
  await expect(dialog.locator('.ch-to-chip .ch-to-name')).toHaveText(['Olga Owner']);
  // With only Olga picked, her conversation exists: the button opens it.
  await expect(primary).toHaveText('Open conversation');
  await dialog.locator('.ch-new-row', { hasText: 'Sanne' }).click();
  await expect(primary).toHaveText('Start conversation');
  await primary.click();
  await expect(win.locator('.scrim')).toHaveCount(0, { timeout: 15000 });
  await expect(title()).toContainText('Olga Owner', { timeout: 15000 });
  await expect(title()).toContainText('Sanne');
  await expect(pane().locator('.ch-main [data-ch="members"]')).toBeVisible();
  const group = (await serverDms(server, olga, ws.id)).find((d) => d.participants.length === 3);
  expect(group.participants.sort()).toEqual([ws.me.id, bartMe.id, sanneMe.id].sort());
  expect(await win.locator('.sidebar .nav-section span').allTextContents()).toEqual(['Channels', 'Direct messages']);
});

test('New message with people who already have a conversation opens it', async () => {
  const { olga, bart, ws, bartMe } = await twoPeople(server);
  const dm = await server.seedDm(olga, ws.id, [bartMe.id]);
  await server.post(olga, ws.id, dm.conversation, 'Our old thread');
  await ready(bart);
  await expect(roomRow(win, 'Olga Owner')).toBeVisible({ timeout: 15000 });
  await win.locator('.sidebar [data-ch-side="dm-add"]').click();
  const dialog = dialogBox(win);
  await dialog.locator('.ch-new-row', { hasText: 'Olga Owner' }).click();
  const primary = dialog.locator('.buttons button').last();
  await expect(primary).toHaveText('Open conversation');
  await primary.click();
  await expect(win.locator('.scrim')).toHaveCount(0);
  await expect(title()).toHaveText('Olga Owner');
  await expect(pane().locator('.ch-main .ch-log .ch-text', { hasText: 'Our old thread' })).toBeVisible({ timeout: 15000 });
  const dms = await serverDms(server, olga, ws.id);
  expect(dms.map((d) => d.conversation)).toEqual([dm.conversation]);
});

test("a notification for Olga's direct message opens the conversation at that message", async () => {
  const { olga, bart, ws, bartMe } = await twoPeople(server);
  const dm = await server.seedDm(olga, ws.id, [bartMe.id]);
  for (let i = 1; i <= 30; i++) await server.post(olga, ws.id, dm.conversation, `Earlier note ${i}`);
  await ready(bart, { focus: false });
  await connected(win);
  // The window counts as unfocused, so an alert is a notification (recorded under SEM_HIDDEN), not a toast.
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.isFocused = () => false;
    global.__semChat.setFocused(false);
  });
  await expect(title()).toHaveText('general', { timeout: 15000 });
  const posted = await server.post(olga, ws.id, dm.conversation, 'Can you call me?');
  await expect.poll(async () => (await notices(app)).find((n) => String(n.body).includes('Can you call me?')), { timeout: 20000 }).toBeTruthy();
  const notice = (await notices(app)).find((n) => String(n.body).includes('Can you call me?'));
  expect(notice.title).toBe('Olga Owner');
  expect(notice.body).toBe('Olga Owner: Can you call me?');
  expect(notice.open).toMatchObject({ ws: ws.id, conversation: dm.conversation, seq: posted.seq });

  // Clicking it: Chat opens the conversation with that message in view and outlined.
  await app.evaluate((_, open) => global.__semChatOpen(open), notice.open);
  await expect(title()).toHaveText('Olga Owner', { timeout: 15000 });
  const target = pane().locator(`.ch-main .ch-log li.ch-msg[data-seq="${posted.seq}"]`);
  await expect(target).toBeVisible({ timeout: 15000 });
  await expect(target).toHaveClass(/is-target/);
  await expect(target.locator('.ch-text')).toHaveText('Can you call me?');
});

test('blocking from the conversation closes it with its bar, and Workspace settings unblocks', async () => {
  const { olga, bart, ws, bartMe } = await twoPeople(server);
  const dm = await server.seedDm(olga, ws.id, [bartMe.id]);
  await server.post(olga, ws.id, dm.conversation, 'Hi Bart');
  await ready(bart);
  await roomRow(win, 'Olga Owner').click();
  await expect(title()).toHaveText('Olga Owner');
  await roomMenu(win, 'Block Olga Owner');
  const dialog = dialogBox(win);
  await expect(dialog.locator('h2')).toHaveText('Block Olga Owner?');
  await expect(dialog.locator('p')).toContainText("Olga Owner isn't told, but may notice that your conversation closed.");
  await dialog.locator('.buttons button').last().click();
  await expect(toast()).toHaveText('Blocked Olga Owner', { timeout: 15000 });
  await expect(bar().locator('.ch-bar-text')).toHaveText('This conversation is closed. You can still read it.', { timeout: 15000 });
  await expect(bar().locator('[data-ch-bar]')).toHaveText(['Start a new conversation', 'Remove from list']);
  await expect(pane().locator('.ch-main .ch-log .ch-text', { hasText: 'Hi Bart' })).toBeVisible();
  await expect(roomRow(win, 'Olga Owner')).toHaveClass(/is-closed/);
  expect((await serverGet(server, bart, ws.id, '/blocks')).blocks.map((b) => b.member)).toEqual([ws.me.id]);
  expect((await serverRoom(server, olga, ws.id, dm.conversation)).closedReason).toBe('closed');

  // Workspace settings lists her under Blocked people, and Unblock takes the block off; the conversation stays closed.
  await workspaceMenu(win, 'Workspace settings');
  const row = dialog.locator('.ch-person', { hasText: 'Olga Owner' });
  await expect(row).toBeVisible();
  await row.locator('[data-unblock]').click();
  await expect(toast()).toHaveText('Unblocked Olga Owner. Start a new conversation to talk again.', { timeout: 15000 });
  await expect(dialog.locator('.ch-set', { hasText: 'Blocked people' })).toContainText("You haven't blocked anyone.", { timeout: 15000 });
  expect((await serverGet(server, bart, ws.id, '/blocks')).blocks).toEqual([]);
  await dialog.locator('.buttons button').last().click();
  await expect(bar().locator('.ch-bar-text')).toHaveText('This conversation is closed. You can still read it.');
});

test('leaving a group conversation closes it for Olga', async () => {
  const { olga, bart, ws, bartMe, sanneMe } = await threePeople();
  const group = await server.seedDm(olga, ws.id, [bartMe.id, sanneMe.id]);
  await server.post(olga, ws.id, group.conversation, 'Plans for Friday');
  await ready(bart);
  const row = dmRow('Sanne');
  await expect(row).toBeVisible({ timeout: 15000 });
  await row.click();
  await expect(pane().locator('.ch-main .ch-log .ch-text', { hasText: 'Plans for Friday' })).toBeVisible({ timeout: 15000 });
  await roomMenu(win, 'Leave conversation');
  const dialog = dialogBox(win);
  await expect(dialog.locator('h2')).toHaveText('Leave this conversation?');
  await expect(dialog.locator('p')).toHaveText('It closes for everyone in it. They can still read it.');
  await dialog.locator('.buttons button').last().click();
  await expect(win.locator('.scrim')).toHaveCount(0);
  // It leaves Bart's list and the next conversation opens, without the gone state.
  await expect(row).toHaveCount(0, { timeout: 15000 });
  await expect(title()).toHaveText('general', { timeout: 15000 });
  await expect(pane().locator('.ch-empty-title')).toBeHidden();
  const theirs = await serverRoom(server, olga, ws.id, group.conversation);
  expect(theirs).toMatchObject({ closedReason: 'left', archived: true });
});

test('a guest sees no New message, no channel actions and nobody to message', async () => {
  const olga = await server.seedAccount();
  const bart = await server.seedAccount({ password: PASSWORD });
  const ws = await server.seedWorkspace(olga, { name: 'Acme', displayName: 'Olga Owner' });
  await server.seedMember(ws, bart, 'Bart', { role: 'guest', channels: [ws.general] });
  await ready(bart);
  await expect(win.locator('.sidebar .ch-ws-switch .email')).toContainText('Guest');
  await expect(win.locator('.sidebar [data-ch-side="new-message"]')).toHaveCount(0);
  await expect(win.locator('.sidebar [data-ch-side="dm-add"]')).toHaveCount(0);
  await expect(win.locator('.sidebar [data-ch-side="channel-add"]')).toHaveCount(0);
  await expect(win.locator('.sidebar [data-ch-side="browse"]')).toHaveCount(0);
  expect(await win.locator('.sidebar .nav-section span').allTextContents()).toEqual(['Channels']);
  // Ctrl+N opens nothing.
  await pane().locator('.ch-main .ch-input').click();
  await win.keyboard.press('Control+n');
  await expect(win.locator('.scrim')).toHaveCount(0);
  // The workspace's members: no Message or Block for anyone, and no menu at all.
  await workspaceMenu(win, 'Members');
  const dialog = dialogBox(win);
  await expect(dialog.locator('h2')).toHaveText('Members of Acme');
  await expect(dialog.locator('.ch-person', { hasText: 'Olga Owner' })).toBeVisible();
  await expect(dialog.locator('[data-person]')).toHaveCount(0);
  await dialog.locator('.buttons button').last().click();
  // A message from Olga offers no Block to a guest.
  await server.post(olga, ws.id, ws.general, 'Welcome, guest');
  const msg = pane().locator('.ch-main .ch-log li.ch-msg').filter({ has: win.locator('.ch-text', { hasText: 'Welcome, guest' }) });
  await expect(msg).toBeVisible({ timeout: 15000 });
  await msg.click({ button: 'right' });
  await expect(win.locator('.menu [role="menuitem"]')).toHaveText(['Reply in thread', 'Copy text']);
  await win.keyboard.press('Escape');
});
