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
  expectBodyFits,
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
  await expectBodyFits(dialog, '[name="to"]');
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

// Contract 3.4, 3.10: in the focused window an alert is a toast, and taking the alert back takes the toast down too.
test('a chat toast in the focused window goes when its alert is taken back', async () => {
  const { olga, bart, ws, bartMe } = await twoPeople(server);
  const dm = await server.seedDm(olga, ws.id, [bartMe.id]);
  await ready(bart);
  await connected(win);
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].isFocused = () => true;
  });
  await expect(title()).toHaveText('general', { timeout: 15000 });
  await expect(dmRow('Olga Owner')).toBeVisible({ timeout: 15000 });
  const posted = await server.post(olga, ws.id, dm.conversation, 'Can you call me?');
  await expect(toast()).toHaveText('Olga Owner: Can you call me?', { timeout: 20000 });
  await expect(toast()).toHaveClass(/show/);
  expect(await notices(app)).toEqual([]);
  // The pointer on the toast keeps it up, so only taking the alert back can take it down: Bart reads the
  // conversation on another device. (The composer's row lies over the toast's box, so the pointer is dispatched.)
  await toast().dispatchEvent('mouseenter');
  await server.read(bart, ws.id, dm.conversation, posted.seq);
  await app.evaluate((_, w) => global.__semChat.sync(w), ws.id);
  await expect(toast()).not.toHaveClass(/show/, { timeout: 15000 });
});

test("a notification clicked while history can't load opens the conversation at its newest cached message, unmarked", async () => {
  const { olga, bart, ws, bartMe } = await twoPeople(server);
  const dm = await server.seedDm(olga, ws.id, [bartMe.id]);
  for (let i = 1; i <= 10; i++) await server.post(olga, ws.id, dm.conversation, `Earlier note ${i}`);
  // The newest cached message is a reply, which an open at it as the notified message would open the thread for.
  const root = await server.post(olga, ws.id, dm.conversation, 'The plan');
  const reply = await server.post(olga, ws.id, dm.conversation, 'A reply in the plan', { root: root.messageId });
  await ready(bart, { focus: false });
  await connected(win);
  // Bart reads the conversation once, so it is cached through the reply, and goes back to general.
  await dmRow('Olga Owner').click();
  await expect(title()).toHaveText('Olga Owner', { timeout: 15000 });
  const newest = pane().locator(`.ch-main .ch-log li.ch-msg[data-seq="${reply.seq}"]`);
  await expect(newest).toBeVisible({ timeout: 15000 });
  await expect(newest).toHaveAttribute('data-root', root.messageId);
  await roomRow(win, 'general').click();
  await expect(title()).toHaveText('general', { timeout: 15000 });
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.isFocused = () => false;
    global.__semChat.setFocused(false);
    // History requests fail as they do offline; the feed still runs, so the notification comes.
    global.__semChat.history.fetchEvents = async () => {
      throw Object.assign(new Error('The server could not be reached.'), { code: 'network' });
    };
  });
  const posted = await server.post(olga, ws.id, dm.conversation, 'Can you call me?');
  await expect.poll(async () => (await notices(app)).find((n) => String(n.body).includes('Can you call me?')), { timeout: 20000 }).toBeTruthy();
  const notice = (await notices(app)).find((n) => String(n.body).includes('Can you call me?'));
  expect(notice.open.seq).toBe(posted.seq);
  const cache = await app.evaluate((_, [w, c]) => global.__semChat.store.getRoom(w, c), [ws.id, dm.conversation]);
  expect(cache.hi).toBe(reply.seq);
  expect(cache.head).toBeGreaterThanOrEqual(posted.seq);
  // The outline lasts two seconds, so the window records whether any row got it, or the thread pane opened.
  await win.evaluate(() => {
    window.__marked = [];
    const section = document.querySelector('section.chat');
    new MutationObserver(() => {
      if (section.querySelector('.is-target')) window.__marked.push('outline');
      if (section.dataset.thread === 'open') window.__marked.push('thread');
    }).observe(section, { subtree: true, attributes: true, attributeFilter: ['class', 'data-thread'] });
  });

  // Clicking it: the conversation opens at its end, with nothing outlined and no thread opened, as on Android.
  await app.evaluate((_, open) => global.__semChatOpen(open), notice.open);
  await expect(title()).toHaveText('Olga Owner', { timeout: 15000 });
  await expect(newest).toBeVisible({ timeout: 15000 });
  await expect(pane().locator('.ch-main .ch-log li.ch-msg', { hasText: 'Can you call me?' })).toHaveCount(0);
  await win.waitForTimeout(300);
  expect(await win.evaluate(() => [...new Set(window.__marked)])).toEqual([]);
  await expect(pane().locator('.ch-thread')).toBeHidden();
  const gap = await pane().locator('.ch-main .ch-scroll').evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
  expect(gap).toBeLessThan(2);
  await app.evaluate(() => {
    delete global.__semChat.history.fetchEvents;
  });
});

test('blocking from the conversation closes it with its bar, and Workspace settings unblocks', async () => {
  const { olga, bart, ws, bartMe } = await twoPeople(server);
  const dm = await server.seedDm(olga, ws.id, [bartMe.id]);
  await server.post(olga, ws.id, dm.conversation, 'Hi Bart');
  await ready(bart);
  await roomRow(win, 'Olga Owner').click();
  await expect(title()).toHaveText('Olga Owner');
  // Close conversation in a one-to-one DM names Olga and that it closes for everyone; Cancel keeps it open.
  await roomMenu(win, 'Close conversation');
  const dialog = dialogBox(win);
  await expect(dialog.locator('h2')).toHaveText('Close this conversation for everyone?');
  await expect(dialog.locator('p')).toHaveText('Olga Owner can still read it, but nobody can write in it again. To stop notifications only, use Mute.');
  await expect(dialog.locator('.buttons button')).toHaveText(['Cancel', 'Close for everyone']);
  await dialog.locator('.buttons button').first().click();
  await expect(win.locator('.scrim')).toHaveCount(0);

  await roomMenu(win, 'Block Olga Owner');
  await expect(dialog.locator('h2')).toHaveText('Block Olga Owner?');
  await expect(dialog.locator('p')).toHaveText(
    "Olga Owner can't start conversations with you in Acme. Every conversation you're both in closes for everyone in it, group ones too, and stays closed if you unblock. Olga Owner isn't told, but may notice that your conversations closed. Mentions from Olga Owner stop notifying you. You still see each other's posts in shared channels. Unblock in Workspace settings."
  );
  await dialog.locator('.buttons button').last().click();
  await expect(toast()).toHaveText('Blocked Olga Owner', { timeout: 15000 });
  // Bart blocked Olga himself: the bar says so and offers Unblock, not a new conversation the server would refuse.
  await expect(bar().locator('.ch-bar-text')).toHaveText('You blocked Olga Owner. You can still read this conversation.', { timeout: 15000 });
  await expect(bar().locator('[data-ch-bar]')).toHaveText(['Unblock', 'Remove from list']);
  await expect(pane().locator('.ch-main .ch-log .ch-text', { hasText: 'Hi Bart' })).toBeVisible();
  await expect(roomRow(win, 'Olga Owner')).toHaveClass(/is-closed/);
  await expect(roomRow(win, 'Olga Owner').locator('.ch-row-tag')).toHaveText('Closed');
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
  // With the block gone the bar is the neutral one again, and Olga can be asked for a new conversation.
  await expect(bar().locator('.ch-bar-text')).toHaveText('This conversation is closed. You can still read it.');
  await expect(bar().locator('[data-ch-bar]')).toHaveText(['Start a new conversation', 'Remove from list']);

  // Remove from list asks with the same name and says it can't be read afterwards; Remove takes it off the list.
  await bar().locator('[data-ch-bar]', { hasText: 'Remove from list' }).click();
  await expect(dialog.locator('h2')).toHaveText('Remove from your list?');
  await expect(dialog.locator('p')).toHaveText("You can't read it anymore after this.");
  await expect(dialog.locator('.buttons button')).toHaveText(['Cancel', 'Remove']);
  await dialog.locator('.buttons button').last().click();
  await expect(roomRow(win, 'Olga Owner')).toHaveCount(0, { timeout: 15000 });
});

test("a conversation closed by Bart's own block offers Unblock on its bar, and then a new conversation", async () => {
  const { olga, bart, ws, bartMe } = await twoPeople(server);
  const dm = await server.seedDm(olga, ws.id, [bartMe.id]);
  await server.post(olga, ws.id, dm.conversation, 'Hi Bart');
  await server.block(bart, ws.id, ws.me.id);
  await ready(bart);
  await roomRow(win, 'Olga Owner').click();
  await expect(bar().locator('.ch-bar-text')).toHaveText('You blocked Olga Owner. You can still read this conversation.', { timeout: 15000 });
  await bar().locator('[data-ch-bar="unblock"]').click();
  await expect(toast()).toHaveText('Unblocked Olga Owner. Start a new conversation to talk again.', { timeout: 15000 });
  await expect(bar().locator('.ch-bar-text')).toHaveText('This conversation is closed. You can still read it.');
  await expect(bar().locator('[data-ch-bar]')).toHaveText(['Start a new conversation', 'Remove from list']);
  expect((await serverGet(server, bart, ws.id, '/blocks')).blocks).toEqual([]);
  // The new one opens; the old one stays in the list, marked Closed.
  await bar().locator('[data-ch-bar="new-conversation"]').click();
  await expect(pane().locator('.ch-main .ch-bar')).toBeHidden({ timeout: 15000 });
  await expect(dmRow('Olga Owner')).toHaveCount(2, { timeout: 15000 });
  await expect(win.locator('.sidebar .ch-row.is-closed .ch-row-tag')).toHaveText(['Closed']);
  await expect(win.locator('.sidebar .ch-row[aria-current="page"] .ch-row-tag')).toHaveCount(0);
});

test('a conversation closed when someone became a guest offers no new conversation', async () => {
  const { olga, bart, ws, sanneMe } = await threePeople();
  const dm = await server.seedDm(bart, ws.id, [sanneMe.id]);
  await server.post(bart, ws.id, dm.conversation, 'Hi Sanne');
  const made = await server.call('PATCH', `/v1/workspaces/${ws.id}/members/${sanneMe.id}`, { token: olga.token, body: { role: 'guest' } });
  expect(made.status).toBe(200);
  expect((await serverRoom(server, bart, ws.id, dm.conversation)).closedReason).toBe('ineligible');
  await ready(bart);
  await dmRow('Sanne').click();
  await expect(bar().locator('.ch-bar-text')).toContainText('guest', { timeout: 15000 });
  // The server refuses a DM with a guest, so the bar only offers Remove from list.
  await expect(bar().locator('[data-ch-bar]')).toHaveText(['Remove from list']);
});

test('New message shows the people Bart blocked with Unblock and a guest with why, and Nobody found only for a search', async () => {
  const { bart, ws, sanneMe } = await threePeople();
  const gus = await server.seedAccount();
  await server.seedMember(ws, gus, 'Gus Guest', { role: 'guest', channels: [ws.general] });
  await server.block(bart, ws.id, sanneMe.id);
  await ready(bart);
  await win.locator('.sidebar [data-ch-side="new-message"]').click();
  const dialog = dialogBox(win);
  await expect(dialog.locator('h2')).toHaveText('New message');
  await expect(dialog.locator('[data-list] .ch-new-row .ch-person-name')).toHaveText(['Olga Owner']);
  const blocked = dialog.locator('[data-off-row="blocked"]');
  await expect(blocked.locator('.ch-person-name')).toHaveText(['You blocked Sanne']);
  await expect(blocked.locator('[data-unblock]')).toHaveText('Unblock');
  // The guest shows once searched for, switched off, with the reason.
  await expect(dialog.locator('[data-off-row="guest"]')).toHaveCount(0);
  await dialog.locator('[name="to"]').fill('gus');
  await expect(dialog.locator('[data-list]')).toBeHidden();
  await expect(dialog.locator('[data-off-row="guest"]')).toHaveText(/Gus Guest\s*Guests can't get direct messages\./);
  await expect(dialog.locator('[data-none]')).toBeHidden();
  await win.keyboard.press('Enter');
  await expect(dialog.locator('.ch-to-chip')).toHaveCount(0);
  await dialog.locator('[name="to"]').fill('nobody like this');
  await expect(dialog.locator('[data-none]')).toHaveText('Nobody found');
  // Unblock right here: Sanne can be picked again.
  await dialog.locator('[name="to"]').fill('');
  await blocked.locator('[data-unblock]').click();
  await expect(toast()).toHaveText('Unblocked Sanne. Start a new conversation to talk again.', { timeout: 15000 });
  await expect(dialog.locator('[data-list] .ch-new-row .ch-person-name')).toHaveText(['Olga Owner', 'Sanne']);
  await expect(dialog.locator('[data-off-row]')).toHaveCount(0);
  expect((await serverGet(server, bart, ws.id, '/blocks')).blocks).toEqual([]);
});

test('alone in a workspace, New message and Add people say nobody else is in it and offer Invite people', async () => {
  const bart = await server.seedAccount({ password: PASSWORD });
  const ws = await server.seedWorkspace(bart, { name: 'Solo', displayName: 'Bart' });
  await ready(bart);
  await win.locator('.sidebar [data-ch-side="new-message"]').click();
  const dialog = dialogBox(win);
  await expect(dialog.locator('[data-none]')).toContainText('Nobody else is in Solo yet');
  await expect(dialog.locator('[data-none] [data-invite]')).toHaveText('Invite people');
  await dialog.locator('[data-none] [data-invite]').click();
  await expect(dialog.locator('h2')).toHaveText('Invite people to Solo', { timeout: 15000 });
  await dialog.locator('.buttons button').first().click();
  await expect(win.locator('.scrim')).toHaveCount(0);

  // Add people to general: nobody else, then, once Olga joined, everyone is in it already.
  await roomRow(win, 'general').click();
  await roomMenu(win, 'Add people');
  await expect(dialog.locator('[data-empty="nobody"]')).toContainText('Nobody else is in Solo yet', { timeout: 15000 });
  await expect(dialog.locator('[data-empty="nobody"] [data-invite]')).toHaveText('Invite people');
  await dialog.locator('.buttons button').last().click();
  await expect(win.locator('.scrim')).toHaveCount(0);
  const olga = await server.seedAccount();
  await server.seedMember(ws, olga, 'Olga');
  // The directory learns about Olga from the feed; Add people asks again each time it opens.
  await expect(async () => {
    await roomMenu(win, 'Add people');
    try {
      await expect(dialog.locator('[data-empty="everyone"]')).toContainText('Everyone in Solo is already in #general', { timeout: 2000 });
    } finally {
      await dialog.locator('.buttons button').last().click();
    }
  }).toPass({ timeout: 20000 });
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
  await roomMenu(win, 'Close conversation');
  const dialog = dialogBox(win);
  await expect(dialog.locator('h2')).toHaveText('Close this conversation for everyone?');
  await expect(dialog.locator('p')).toHaveText(
    /^(Olga Owner and Sanne|Sanne and Olga Owner) can still read it, but nobody can write in it again\. To stop notifications only, use Mute\.$/
  );
  await expect(dialog.locator('.buttons button').last()).toHaveText('Close for everyone');
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
