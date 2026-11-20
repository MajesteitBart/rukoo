// Team chat's mode, sidebar and conversation log (contract 5.2 to 5.4, 8.5): the real app on a throwaway profile
// against the real account server, with Olga acted for over HTTP. One server for the file, the app per test.
const { test, expect } = require('@playwright/test');
const { tempDir, removeDir } = require('../tmp');
const { closeApp } = require('./close');
const { mention } = require('../fixtures/real-server');
const { PASSWORD, skipWithoutServer, startServer, launch, signIn, openChat, twoPeople, serverRead, roomRow } = require('./chat-helpers');

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
  dataDir = tempDir('rukoo-chat-e2e-');
});

test.afterEach(async () => {
  await closeApp(app);
  app = null;
  removeDir(dataDir);
});

const pane = () => win.locator('section.chat');
const log = () => win.locator('section.chat .ch-log');
// A message row by its own text (a reply's context line quotes its thread's first message).
const message = (text) => log().locator('li.ch-msg').filter({ has: win.locator('.ch-text', { hasText: text }) });

// Settings, from wherever: back out of every page.
async function closeSettings() {
  for (let i = 0; i < 6 && (await win.locator('.page.settings').count()); i++) await win.keyboard.press('Escape');
  await expect(win.locator('.page.settings')).toHaveCount(0);
}

async function restart() {
  await closeApp(app);
  ({ app, win } = await launch(server, { dataDir }));
}

test('without team chat on the server the mode switch keeps its three segments and Ctrl+4 does nothing', async () => {
  const off = await startServer({ vars: { WORKSPACE_MODE: 'off' } });
  try {
    ({ app, win } = await launch(off, { dataDir }));
    const person = await off.seedAccount({ password: PASSWORD });
    await signIn(win, person);
    // The server's info is in: it says what it offers, and team chat isn't among it.
    await expect.poll(() => win.evaluate(() => window.mail.call('accountStatus').then((s) => Boolean(s.info))), { timeout: 15000 }).toBe(true);
    expect(await win.evaluate(() => window.mail.call('chatState').then((s) => s.available))).toBe(false);
    const sw = win.locator('.sidebar-mode .segmented');
    await expect(sw.locator('[role="tab"]')).toHaveCount(3);
    await expect(sw).not.toHaveClass(/is-stacked/);
    await expect(sw).toHaveAttribute('aria-label', 'Mail, calendar or meetings');
    await expect(sw.locator('[data-mode="chat"]')).toHaveCount(0);
    await expect(sw.locator('.seg-label')).toHaveText(['Mail', 'Calendar', 'Meet']);
    await win.locator('.list-scroll').focus();
    await win.keyboard.press('Control+4');
    await expect(sw.locator('[data-mode="mail"]')).toHaveAttribute('aria-selected', 'true');
    await expect(win.locator('.shell')).not.toHaveClass(/chat-mode/);
  } finally {
    await closeApp(app);
    app = null;
    await off.close();
  }
});

test('signed out, Chat offers to create an account or sign in', async () => {
  ({ app, win } = await launch(server, { dataDir }));
  // The account page loads the server's info, which says it has team chat.
  await win.click('[data-action="settings"]');
  await win.locator('.page.settings [data-a="rukoo"]').click();
  await expect(win.locator('.page.settings h1')).toHaveText('Rukoo account');
  await closeSettings();
  await openChat(win);
  const sw = win.locator('.sidebar-mode .segmented');
  await expect(sw).toHaveClass(/is-stacked/);
  await expect(sw).toHaveAttribute('aria-label', 'Mail, calendar, meetings or chat');
  await expect(pane().locator('.ch-empty-title')).toHaveText('Sign in to use team chat');
  await expect(pane().locator('.ch-empty-body')).toContainText('127.0.0.1');
  await expect(pane().locator('[data-ch-empty="sign-up"]')).toHaveText('Create an account');
  await expect(pane().locator('[data-ch-empty="sign-in"]')).toHaveText('Sign in');
  const state = await win.evaluate(() => window.mail.call('chatState'));
  if (state.inviteSignups) await expect(pane().locator('.ch-empty-hint')).toContainText('invitation link');
  await expect(win.locator('.sidebar .sync-status .t')).toHaveText('Signed out');
  await pane().locator('[data-ch-empty="sign-in"]').click();
  await expect(win.locator('.page.settings h1')).toHaveText('Sign in');
  await closeSettings();
  await pane().locator('[data-ch-empty="sign-up"]').click();
  await expect(win.locator('.page.settings h1')).toHaveText('Create an account');
});

test('first run through the UI: sign up with the invite code, make a workspace, see general', async () => {
  ({ app, win } = await launch(server, { dataDir }));
  await win.click('[data-action="settings"]');
  const page = win.locator('.page.settings');
  await page.locator('[data-a="rukoo"]').click();
  await page.locator('[data-a="rukoo-go:rukoo-signup"]').click();
  const form = page.locator('form[data-form="rukoo-signup"]');
  await form.locator('[name="email"]').fill(`first-run-${Date.now()}@example.com`);
  await form.locator('[name="password"]').fill(PASSWORD);
  await form.locator('[name="repeat"]').fill(PASSWORD);
  await form.locator('[name="invite"]').fill(server.inviteCode);
  await form.locator('[name="understand"]').check();
  await form.locator('button[type=submit]').click();
  const key = win.locator('.scrim .dialog');
  await expect(key.locator('h2')).toHaveText('Save your recovery key', { timeout: 20000 });
  await key.locator('.buttons button').last().click();
  await closeSettings();

  await openChat(win);
  await expect(pane().locator('.ch-empty-title')).toHaveText('No workspace yet', { timeout: 15000 });
  await pane().locator('[data-ch-empty="make"]').click();
  const dialog = win.locator('.scrim .dialog');
  await expect(dialog.locator('h2')).toHaveText('Make a workspace');
  await expect(dialog.locator('.ch-host')).toContainText('Test operator');
  await dialog.locator('[name="name"]').fill('');
  await dialog.locator('[name="displayName"]').fill('Bart');
  await dialog.locator('.buttons button').last().click();
  await expect(dialog.locator('[data-error="name"]')).toHaveText('Use 1 to 80 characters.');
  await dialog.locator('[name="name"]').fill('Acme');
  await dialog.locator('.buttons button').last().click();
  await expect(win.locator('.scrim')).toHaveCount(0, { timeout: 15000 });

  await expect(roomRow(win, 'general')).toBeVisible({ timeout: 15000 });
  await expect(roomRow(win, 'general')).toHaveAttribute('aria-current', 'page');
  await expect(pane().locator('.ch-title')).toHaveText('general');
  await expect(log().locator('.ch-intro-title')).toHaveText('This is the start of #general');
  await expect(win.locator('.sidebar .ch-ws-switch .name')).toHaveText('Acme');
  await expect(win.locator('.sidebar .ch-ws-switch .email')).toContainText('Owner');
});

test('a seeded workspace lists its rooms with unread counts and mentions, and the mode badge counts what asks for you', async () => {
  const { olga, bart, ws, bartMe } = await twoPeople(server);
  const review = await server.seedChannel(olga, ws.id, { name: 'review', members: [bartMe.id] });
  const dm = await server.seedDm(olga, ws.id, [bartMe.id]);
  await server.post(olga, ws.id, ws.general, 'Morning all');
  await server.post(olga, ws.id, ws.general, 'Standup at ten');
  const text = 'Could @Bart look at this?';
  await server.post(olga, ws.id, review.id, text, { mentions: [mention(text, '@Bart', bartMe.id)] });
  await server.post(olga, ws.id, dm.conversation, 'Hi Bart');

  ({ app, win } = await launch(server, { dataDir }));
  await signIn(win, bart);
  // In Mail, the Chat segment counts the mention and the direct message.
  const seg = win.locator('.sidebar-mode [data-mode="chat"]');
  await expect(seg.locator('.seg-badge')).toHaveText('2', { timeout: 15000 });
  await expect(seg.locator('.seg-badge')).toHaveClass(/is-mention/);
  await expect(seg).toHaveAttribute('aria-label', 'Chat, 2 messages for you');

  await openChat(win);
  await expect(roomRow(win, 'review').locator('.ch-badge')).toHaveText('1', { timeout: 15000 });
  await expect(roomRow(win, 'review')).toHaveAttribute('aria-label', 'review, 1 mention');
  await expect(roomRow(win, 'Olga Owner').locator('.ch-badge')).toHaveText('1');
  await expect(roomRow(win, 'Olga Owner')).toHaveAttribute('aria-label', 'Olga Owner, 1 unread message');
  // Channels by name, then direct messages.
  await expect(win.locator('.sidebar .ch-row .label')).toHaveText(['general', 'review', 'Olga Owner']);
  await expect(win.locator('.sidebar .nav-section span')).toHaveText(['Channels', 'Direct messages']);
});

test('opening a room clears its unread count, and the server learns the read position', async () => {
  const { olga, bart, ws, bartMe } = await twoPeople(server);
  const dm = await server.seedDm(olga, ws.id, [bartMe.id]);
  const posted = await server.post(olga, ws.id, dm.conversation, 'Are you around?');

  ({ app, win } = await launch(server, { dataDir }));
  await signIn(win, bart);
  await openChat(win);
  const row = roomRow(win, 'Olga Owner');
  await expect(row.locator('.ch-badge')).toHaveText('1', { timeout: 15000 });
  await expect(row).toHaveClass(/is-unread/);
  await row.click();
  await expect(pane().locator('.ch-title')).toHaveText('Olga Owner');
  await expect(pane().locator('.ch-meta')).toContainText('Direct message');
  await expect(message('Are you around?')).toBeVisible();
  await expect(log().locator('li.ch-new')).toBeVisible();
  await expect(row.locator('.ch-badge')).toHaveCount(0, { timeout: 10000 });
  await expect(row).not.toHaveClass(/is-unread/);
  await expect(win.locator('.sidebar-mode [data-mode="chat"] .seg-badge')).toHaveCount(0);
  await expect.poll(() => serverRead(server, bart, ws.id, dm.conversation), { timeout: 15000 }).toBeGreaterThanOrEqual(posted.seq);
});

test('a message Olga posts shows in the open room within five seconds', async () => {
  const { olga, bart, ws } = await twoPeople(server);
  await server.post(olga, ws.id, ws.general, 'Before you came');
  ({ app, win } = await launch(server, { dataDir }));
  await signIn(win, bart);
  await openChat(win);
  await expect(message('Before you came')).toBeVisible({ timeout: 15000 });
  await expect(win.locator('.sidebar .sync-status .t')).toHaveText('Connected', { timeout: 15000 });
  await server.post(olga, ws.id, ws.general, 'Live from Olga');
  await expect(message('Live from Olga')).toBeVisible({ timeout: 5000 });
  // Two messages from Olga within five minutes form one group: the second has no name line of its own.
  await expect(message('Live from Olga')).toHaveClass(/is-cont/);
  await expect(message('Live from Olga').locator('.ch-vh')).toContainText('Olga Owner');
});

test('replies show in the main log with their context, and the first message sums up its thread', async () => {
  const { olga, bart, ws } = await twoPeople(server);
  const root = await server.post(olga, ws.id, ws.general, 'Plan for Friday: lunch at noon');
  await server.post(olga, ws.id, ws.general, 'I can bring snacks', { root: root.messageId });
  await server.post(bart, ws.id, ws.general, 'Count me in', { root: root.messageId });
  ({ app, win } = await launch(server, { dataDir }));
  await signIn(win, bart);
  await openChat(win);
  const top = message('Plan for Friday');
  await expect(top).toBeVisible({ timeout: 15000 });
  await expect(top).not.toHaveClass(/is-reply/);
  const summary = top.locator('.ch-replies');
  await expect(summary.locator('.ch-replies-n')).toHaveText('2 replies');
  await expect(summary.locator('.ch-replies-av .avatar')).toHaveCount(2);
  await expect(summary.locator('.ch-replies-at')).toContainText('Last reply');
  const first = message('I can bring snacks');
  await expect(first).toHaveClass(/is-reply/);
  await expect(first.locator('.ch-context')).toHaveText('replied to Olga Owner: Plan for Friday: lunch at noon');
  const mine = message('Count me in');
  await expect(mine).toHaveClass(/is-reply/);
  await expect(mine.locator('.ch-name')).toHaveText('Bart');
  await expect(mine.locator('.ch-context')).toContainText('replied to Olga Owner');
});

test('older messages load while scrolling up, down to the note that older ones were removed', async () => {
  const { olga, bart, ws } = await twoPeople(server);
  const posts = [];
  for (let i = 1; i <= 14; i++) posts.push(await server.post(olga, ws.id, ws.general, `Message ${i}`));
  // The window has no focus here, so nothing is read: a read would bring the room's real floor back from the feed.
  ({ app, win } = await launch(server, { dataDir, focus: false }));
  await signIn(win, bart);
  await expect
    .poll(async () => {
      const d = await app.evaluate(() => global.__semChat.debugState());
      const w = d && d.workspaces[0];
      return Boolean(w && !w.passing && w.rooms.some((r) => r.kind === 'channel'));
    }, { timeout: 15000 })
    .toBe(true);
  // Small pages, and a retention floor the local server can't produce on demand (contract 8.1): messages before
  // Message 3 aged out.
  const floor = posts[2].seq;
  await app.evaluate(
    (_, { wsId, room, floorSeq }) => {
      const svc = global.__semChat;
      svc.timing.eventsNewest = 5;
      svc.store.tx(() => {
        svc.store.dropRoomCache(wsId, room);
        svc.store.setRoomFields(wsId, room, { floor: floorSeq });
      });
      svc.roomsChanged(wsId, [room]);
    },
    { wsId: ws.id, room: ws.general, floorSeq: floor }
  );
  await openChat(win);
  await expect(message('Message 14')).toBeVisible({ timeout: 15000 });
  const note = log().locator('li.ch-floor');
  await expect(note).toBeVisible({ timeout: 15000 });
  await expect(note).toContainText('were removed');
  await expect(message('Message 3')).toBeVisible();
  await expect(message('Message 2')).toHaveCount(0);
  await expect(log().locator('li.ch-intro')).toHaveCount(0);
  // Fourteen messages came in pages of five: nothing shows twice.
  await expect(log().locator('li.ch-msg')).toHaveCount(12);
});

test('the server going away shows the offline banner, and coming back clears it', async () => {
  const { olga, bart, ws } = await twoPeople(server);
  await server.post(olga, ws.id, ws.general, 'Still here');
  ({ app, win } = await launch(server, { dataDir }));
  await signIn(win, bart);
  await openChat(win);
  await expect(message('Still here')).toBeVisible({ timeout: 15000 });
  await expect(win.locator('.sidebar .sync-status .t')).toHaveText('Connected', { timeout: 15000 });
  const banner = pane().locator('.ch-banner');
  await server.stop();
  try {
    await expect(banner).toBeVisible({ timeout: 20000 });
    await expect(banner).toContainText("You're offline");
    await expect(win.locator('.sidebar .sync-status .t')).toHaveText('Offline');
  } finally {
    await server.start();
  }
  await expect(banner).toBeHidden({ timeout: 20000 });
  await expect(win.locator('.sidebar .sync-status .t')).toHaveText('Connected', { timeout: 20000 });
  await server.post(olga, ws.id, ws.general, 'Back again');
  await expect(message('Back again')).toBeVisible({ timeout: 10000 });
});

test('after a restart the cached rooms and messages show before the server answers', async () => {
  const { olga, bart, ws } = await twoPeople(server);
  await server.post(olga, ws.id, ws.general, 'Cached hello');
  ({ app, win } = await launch(server, { dataDir }));
  await signIn(win, bart);
  await openChat(win);
  await expect(message('Cached hello')).toBeVisible({ timeout: 15000 });
  await closeApp(app);
  await server.stop();
  try {
    ({ app, win } = await launch(server, { dataDir }));
    // Chat was the mode: the window comes back to it, from the cache, with the server down.
    await expect(win.locator('.sidebar-mode [data-mode="chat"]')).toHaveAttribute('aria-selected', 'true', { timeout: 15000 });
    await expect(roomRow(win, 'general')).toBeVisible();
    await expect(message('Cached hello')).toBeVisible();
    await expect(win.locator('.sidebar .sync-status .t')).not.toHaveText('Connected');
  } finally {
    await server.start();
  }
  await expect(win.locator('.sidebar .sync-status .t')).toHaveText('Connected', { timeout: 20000 });
});

test('Ctrl+4 opens Chat, and Chat stays the mode across a restart', async () => {
  const { bart } = await twoPeople(server);
  ({ app, win } = await launch(server, { dataDir }));
  await signIn(win, bart);
  const chatSeg = win.locator('.sidebar-mode [data-mode="chat"]');
  await expect(chatSeg).toBeVisible({ timeout: 15000 });
  await expect(chatSeg).toHaveAttribute('title', 'Chat (Ctrl+4)');
  await win.locator('.list-scroll').focus();
  await win.keyboard.press('Control+4');
  await expect(chatSeg).toHaveAttribute('aria-selected', 'true');
  await expect(win.locator('.shell')).toHaveClass(/chat-mode/);
  await expect(roomRow(win, 'general')).toBeVisible({ timeout: 15000 });
  await win.keyboard.press('Control+1');
  await expect(win.locator('.sidebar-mode [data-mode="mail"]')).toHaveAttribute('aria-selected', 'true');
  await win.keyboard.press('Control+4');
  await expect(chatSeg).toHaveAttribute('aria-selected', 'true');
  await restart();
  await expect(win.locator('.sidebar-mode [data-mode="chat"]')).toHaveAttribute('aria-selected', 'true', { timeout: 15000 });
  await expect(pane().locator('.ch-title')).toHaveText('general', { timeout: 15000 });
});
