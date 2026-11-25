// Team chat's mode, sidebar and conversation log (contract 5.2 to 5.4, 8.5): the real app on a throwaway profile
// against the real account server, with Olga acted for over HTTP. One server for the file, the app per test.
const { test, expect } = require('@playwright/test');
const { tempDir, removeDir } = require('../tmp');
const { closeApp } = require('./close');
const { mention } = require('../fixtures/real-server');
const { PASSWORD, skipWithoutServer, startServer, launch, signIn, openChat, twoPeople, serverRead, roomRow, notices } = require('./chat-helpers');

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
// A message row by its own text.
const message = (text) => log().locator('li.ch-msg').filter({ has: win.locator('.ch-text', { hasText: text }) });
const threadLog = () => win.locator('section.chat .ch-thread .ch-thread-log');
// Scrolls a row into view. The conversation draws again after a thread closes or a message comes in, so the row
// found first can be gone by the time it would scroll: try until one stays.
const intoView = (row) => expect(() => row.scrollIntoViewIfNeeded({ timeout: 2000 })).toPass({ timeout: 15000 });

// Settings, from wherever: back out of every page.
async function closeSettings() {
  for (let i = 0; i < 6 && (await win.locator('.page.settings').count()); i++) await win.keyboard.press('Escape');
  await expect(win.locator('.page.settings')).toHaveCount(0);
}

async function restart() {
  await closeApp(app);
  ({ app, win } = await launch(server, { dataDir }));
}

test('without team chat on the server the title bar has three mode tabs and Ctrl+4 does nothing', async () => {
  const off = await startServer({ vars: { WORKSPACE_MODE: 'off' } });
  try {
    ({ app, win } = await launch(off, { dataDir }));
    const person = await off.seedAccount({ password: PASSWORD });
    await signIn(win, person);
    // The server's info is in: it says what it offers, and team chat isn't among it.
    await expect.poll(() => win.evaluate(() => window.mail.call('accountStatus').then((s) => Boolean(s.info))), { timeout: 15000 }).toBe(true);
    expect(await win.evaluate(() => window.mail.call('chatState').then((s) => s.available))).toBe(false);
    const sw = win.locator('.titlebar-modes .mode-tabs');
    await expect(sw.locator('[role="tab"]')).toHaveCount(3);
    await expect(sw).toHaveAttribute('aria-label', 'Mail, calendar or meetings');
    await expect(sw.locator('[data-mode="chat"]')).toHaveCount(0);
    await expect(sw.locator('.mode-label')).toHaveText(['Mail', 'Calendar', 'Meet']);
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
  const sw = win.locator('.titlebar-modes .mode-tabs');
  await expect(sw.locator('.mode-label')).toHaveText(['Mail', 'Calendar', 'Meet', 'Chat']);
  await expect(sw).toHaveAttribute('aria-label', 'Mail, calendar, meetings or chat');
  await expect(pane().locator('.ch-empty-title')).toHaveText('Sign in to use team chat');
  await expect(pane().locator('.ch-empty-body')).toContainText('127.0.0.1');
  await expect(pane().locator('[data-ch-empty="sign-up"]')).toHaveText('Create an account');
  await expect(pane().locator('[data-ch-empty="sign-in"]')).toHaveText('Sign in');
  // An invitation link has its own way in: the setup page's team chat steps (chat-invitee.spec.js).
  await expect(pane().locator('[data-ch-empty="join"]')).toHaveText('Join with an invitation link');
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
  // In Mail, the Chat tab counts the mention and the direct message.
  const seg = win.locator('.titlebar-modes [data-mode="chat"]');
  await expect(seg.locator('.mode-badge')).toHaveText('2', { timeout: 15000 });
  await expect(seg.locator('.mode-badge')).toHaveClass(/is-mention/);
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
  await expect(win.locator('.titlebar-modes [data-mode="chat"] .mode-badge')).toHaveCount(0);
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

// Issue #376: a reply shows only under the message it answers, in its thread.
test('replies stay in their thread, and the first message sums them up, with a dot for new ones, also as they come in', async () => {
  const { olga, bart, ws } = await twoPeople(server);
  const root = await server.post(olga, ws.id, ws.general, 'Plan for Friday: lunch at noon');
  await server.post(olga, ws.id, ws.general, 'I can bring snacks', { root: root.messageId });
  await server.post(bart, ws.id, ws.general, 'Count me in', { root: root.messageId });
  const monday = await server.post(olga, ws.id, ws.general, 'Also, the office is closed on Monday');
  await server.read(bart, ws.id, ws.general, monday.seq);
  ({ app, win } = await launch(server, { dataDir }));
  await signIn(win, bart);
  await openChat(win);
  const top = message('Plan for Friday');
  await expect(top).toBeVisible({ timeout: 15000 });
  const summary = top.locator('.ch-replies');
  await expect(summary.locator('.ch-replies-n')).toHaveText('2 replies');
  await expect(summary.locator('.ch-replies-av .avatar')).toHaveCount(2);
  await expect(summary.locator('.ch-replies-at')).toContainText('Last reply');
  // Bart had read them all: no dot.
  await expect(summary).not.toHaveClass(/has-new/);
  await expect(message('I can bring snacks')).toHaveCount(0);
  await expect(message('Count me in')).toHaveCount(0);
  await expect(log().locator('li.ch-msg')).toHaveCount(2);
  await expect(win.locator('section.chat .ch-main .ch-context')).toHaveCount(0);
  await expect(win.locator('.sidebar .sync-status .t')).toHaveText('Connected', { timeout: 15000 });

  // Olga answers again: the count and the time of the last reply follow at once, with the dot for something new, and
  // the log doesn't move or count it as a new message below.
  const noon = await server.post(olga, ws.id, ws.general, 'Noon works', { root: root.messageId });
  await expect(summary.locator('.ch-replies-n')).toHaveText('3 replies', { timeout: 5000 });
  await expect(summary).toHaveClass(/has-new/);
  await expect(summary).toHaveAttribute('aria-label', /3 replies, some new/);
  await expect(message('Noon works')).toHaveCount(0);
  await expect(log().locator('li.ch-msg').last().locator('.ch-text')).toHaveText('Also, the office is closed on Monday');
  await expect(pane().locator('.ch-jump.is-down')).toBeHidden();
  // The first message is in view, so no pill points at it.
  await expect(pane().locator('.ch-jump.is-thread')).toBeHidden();
  // Reading the conversation reads the reply too, here and on the server (it has no row of its own to read).
  await expect.poll(() => serverRead(server, bart, ws.id, ws.general), { timeout: 15000 }).toBeGreaterThanOrEqual(noon.seq);
  await expect(roomRow(win, 'general')).not.toHaveClass(/is-unread/);
  // The dot stays for this visit, as the New line does; the thread shows the replies, and then it goes.
  await expect(summary).toHaveClass(/has-new/);
  await summary.click();
  await expect(threadLog().locator('li.ch-msg .ch-text')).toHaveText(['Plan for Friday: lunch at noon', 'I can bring snacks', 'Count me in', 'Noon works'], { timeout: 15000 });
  await expect(summary).not.toHaveClass(/has-new/);
});

// Issue #376: the author of a thread's first message hears of a reply, which the conversation doesn't show.
test('a reply to your message notifies "Name replied", and the notification opens the thread at it', async () => {
  const { olga, bart, ws, bartMe } = await twoPeople(server);
  await server.seedChannel(olga, ws.id, { name: 'review', members: [bartMe.id] });
  const mine = await server.post(bart, ws.id, ws.general, 'Lunch on Friday?');
  const hers = await server.post(olga, ws.id, ws.general, 'Who reviews the draft?');
  ({ app, win } = await launch(server, { dataDir }));
  await signIn(win, bart);
  await openChat(win);
  await expect(message('Who reviews the draft?')).toBeVisible({ timeout: 15000 });
  await expect(win.locator('.sidebar .sync-status .t')).toHaveText('Connected', { timeout: 15000 });
  await expect.poll(() => serverRead(server, bart, ws.id, ws.general), { timeout: 15000 }).toBeGreaterThanOrEqual(hers.seq);
  // Bart moves to review, and the window counts as unfocused, so an alert is a notification.
  await roomRow(win, 'review').click();
  await expect(pane().locator('.ch-title')).toHaveText('review');
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].isFocused = () => false;
    global.__semChat.setFocused(false);
  });

  // Olga answers Bart's question: general counts it as unread, and the notification says she replied.
  const answer = await server.post(olga, ws.id, ws.general, 'Yes, at noon', { root: mine.messageId });
  await expect(roomRow(win, 'general').locator('.count')).toHaveText('1', { timeout: 15000 });
  await expect.poll(async () => (await notices(app)).find((n) => String(n.body).includes('Yes, at noon')), { timeout: 20000 }).toBeTruthy();
  const notice = (await notices(app)).find((n) => String(n.body).includes('Yes, at noon'));
  expect(notice).toMatchObject({ title: '#general', body: 'Olga Owner replied: Yes, at noon', open: { ws: ws.id, conversation: ws.general, seq: answer.seq } });
  // A reply in Olga's own thread is nothing for Bart: no notification.
  await server.post(olga, ws.id, ws.general, 'I can', { root: hers.messageId });
  await expect(roomRow(win, 'general').locator('.count')).toHaveText('2', { timeout: 15000 });
  await win.waitForTimeout(1500);
  expect((await notices(app)).filter((n) => String(n.body).includes('I can'))).toEqual([]);

  // Clicking it opens general with the thread beside it at the reply, which isn't in the log.
  await app.evaluate((_, open) => global.__semChatOpen(open), notice.open);
  await expect(pane().locator('.ch-title')).toHaveText('general', { timeout: 15000 });
  await expect(threadLog().locator(`li.ch-msg[data-seq="${answer.seq}"]`)).toBeVisible({ timeout: 15000 });
  await expect(threadLog().locator(`li.ch-msg[data-id="${mine.messageId}"]`)).toBeVisible();
  await expect(message('Yes, at noon')).toHaveCount(0);
  await expect(message('Lunch on Friday?').locator('.ch-replies-n')).toHaveText('1 reply');
  await expect(message('Lunch on Friday?').locator('.ch-replies')).not.toHaveClass(/has-new/);
});

// Issue #376: replies whose first message is out of view get a pill that opens their thread, the oldest first.
test('new replies in threads out of view show a pill that opens each thread in turn, and goes once all showed', async () => {
  const { olga, bart, ws } = await twoPeople(server);
  const sanne = await server.seedAccount();
  await server.seedMember(ws, sanne, 'Sanne');
  const question = await server.post(bart, ws.id, ws.general, 'Lunch on Friday?');
  const plan = await server.post(sanne, ws.id, ws.general, 'Draft plan for the offsite');
  // Forty messages Bart read, then two answers in the two threads, far above where he read.
  for (let i = 1; i <= 40; i++) await server.post(i % 2 ? olga : sanne, ws.id, ws.general, `News ${i}`);
  const read = await server.post(sanne, ws.id, ws.general, 'News 41');
  await server.read(bart, ws.id, ws.general, read.seq);
  const answer = await server.post(olga, ws.id, ws.general, 'Yes, at noon', { root: question.messageId });
  const note = await server.post(olga, ws.id, ws.general, 'Looks good', { root: plan.messageId });
  await server.post(olga, ws.id, ws.general, 'One more thing', { root: plan.messageId });
  await server.post(sanne, ws.id, ws.general, 'News 42');
  ({ app, win } = await launch(server, { dataDir }));
  await signIn(win, bart);
  await openChat(win);
  await expect(message('News 42')).toBeVisible({ timeout: 15000 });
  await expect(message('Yes, at noon')).toHaveCount(0);
  const pill = pane().locator('.ch-jump.is-thread');
  await expect(pill).toHaveText('3 new replies in 2 threads', { timeout: 15000 });
  await expect(pill).toHaveAttribute('aria-label', '3 new replies in 2 threads, open the thread');
  // The oldest new reply first: Bart's question.
  await pill.click();
  await expect(threadLog().locator(`li.ch-msg[data-seq="${answer.seq}"]`)).toBeVisible({ timeout: 15000 });
  await expect(threadLog().locator(`li.ch-msg[data-id="${question.messageId}"]`)).toBeVisible();
  await expect(pill).toHaveText('2 new replies in a thread');
  await pill.click();
  await expect(threadLog().locator(`li.ch-msg[data-seq="${note.seq}"]`)).toBeVisible({ timeout: 15000 });
  await expect(pill).toBeHidden();
  await win.locator('section.chat .ch-thread [data-ch="thread-close"]').click();
  await expect(pill).toBeHidden();
  // Scrolled up to the question, its dot is gone too: its thread showed the reply.
  await intoView(message('Lunch on Friday?'));
  await expect(message('Lunch on Friday?').locator('.ch-replies')).not.toHaveClass(/has-new/);

  // A new reply later in a thread out of view brings the pill back.
  await server.post(sanne, ws.id, ws.general, 'News 43');
  await intoView(message('News 43'));
  await server.post(olga, ws.id, ws.general, 'Actually, half past twelve', { root: question.messageId });
  await expect(pill).toHaveText('1 new reply in a thread', { timeout: 15000 });
});

// Main has the seeded workspace and its channels: the cache can be changed under it.
async function roomsReady() {
  await expect
    .poll(async () => {
      const d = await app.evaluate(() => global.__semChat.debugState());
      const w = d && d.workspaces[0];
      return Boolean(w && !w.passing && w.rooms.some((r) => r.kind === 'channel'));
    }, { timeout: 15000 })
    .toBe(true);
}

test('the keyboard stays on a sidebar row when the sidebar draws again; Enter opens its room in the composer, a click stays on the row', async () => {
  const { olga, bart, ws, bartMe } = await twoPeople(server);
  const review = await server.seedChannel(olga, ws.id, { name: 'review', members: [bartMe.id] });
  await server.post(olga, ws.id, ws.general, 'Morning');
  ({ app, win } = await launch(server, { dataDir }));
  await signIn(win, bart);
  await openChat(win);
  await expect(pane().locator('.ch-title')).toHaveText('general', { timeout: 15000 });
  await expect(win.locator('.sidebar .sync-status .t')).toHaveText('Connected', { timeout: 15000 });
  const row = roomRow(win, 'review');
  const focused = () => win.evaluate(() => document.activeElement?.dataset?.chOpen || document.activeElement?.tagName || null);
  await row.focus();
  expect(await focused()).toBe(review.id);
  // Olga posts in review: its count shows, so the sidebar was drawn again, and the focus is on the row's new copy.
  await server.post(olga, ws.id, review.id, 'Something to review');
  await expect(row.locator('.count')).toHaveText('1', { timeout: 10000 });
  await expect(row).toHaveClass(/is-unread/);
  expect(await focused()).toBe(review.id);
  // Enter opens the room with the focus in its composer, to write (desktop-ui 9.3); the redraws for the open room and
  // its read leave it there.
  const inComposer = () => win.evaluate(() => Boolean(document.activeElement?.matches('section.chat .ch-main .ch-input')));
  await win.keyboard.press('Enter');
  await expect(pane().locator('.ch-title')).toHaveText('review');
  await expect(row).toHaveAttribute('aria-current', 'page');
  await expect(row).not.toHaveClass(/is-unread/, { timeout: 10000 });
  expect(await inComposer()).toBe(true);
  // A click opens the room and leaves the focus on its row.
  await roomRow(win, 'general').click();
  await expect(pane().locator('.ch-title')).toHaveText('general');
  await expect(roomRow(win, 'general')).toHaveAttribute('aria-current', 'page');
  await win.waitForTimeout(300);
  expect(await focused()).toBe(ws.general);
});

test('a workspace that needs a newer Rukoo keeps its upgrade state when a conversation is clicked', async () => {
  const { olga, bart, ws, bartMe } = await twoPeople(server);
  await server.seedChannel(olga, ws.id, { name: 'review', members: [bartMe.id] });
  ({ app, win } = await launch(server, { dataDir }));
  await signIn(win, bart);
  await openChat(win);
  await expect(pane().locator('.ch-title')).toHaveText('general', { timeout: 15000 });
  // Main parks the workspace as after a 426 from its server.
  await app.evaluate((_, id) => global.__semChat.park(id), ws.id);
  const empty = pane().locator('.ch-empty');
  await expect(empty.locator('[data-ch-empty="updates"]')).toBeVisible({ timeout: 10000 });
  const title = await empty.locator('.ch-empty-title').textContent();
  await roomRow(win, 'review').click();
  await expect(roomRow(win, 'review')).toHaveAttribute('aria-current', 'page');
  await win.waitForTimeout(1000);
  await expect(empty.locator('.ch-empty-title')).toHaveText(title);
  await expect(empty.locator('[data-ch-empty="updates"]')).toBeVisible();
  await expect(pane().locator('.ch-head')).toBeHidden();
  await expect(pane().locator('.ch-main .ch-input')).toBeHidden();
});

test('a stopped workspace with no conversation open still offers Start over, which loads it again', async () => {
  const olga = await server.seedAccount();
  const bart = await server.seedAccount({ password: PASSWORD });
  const ws = await server.seedWorkspace(olga, { name: 'Acme', displayName: 'Olga Owner' });
  // Bart is in none of its conversations, so nothing opens: he left general, which joining gave him.
  await server.seedMember(ws, bart, 'Bart', { joinGeneral: false });
  const left = await server.call('DELETE', `/v1/workspaces/${ws.id}/channels/${ws.general}/members/me`, { token: bart.token });
  expect([200, 204]).toContain(left.status);
  ({ app, win } = await launch(server, { dataDir }));
  await signIn(win, bart);
  await openChat(win);
  const empty = pane().locator('.ch-empty');
  await expect(win.locator('.sidebar .ch-ws-switch')).toBeVisible({ timeout: 15000 });
  await expect(empty).toBeVisible({ timeout: 15000 });
  await expect(empty.locator('.ch-empty-title')).toHaveText('Nothing open', { timeout: 15000 });
  await expect(pane().locator('.ch-head')).toBeHidden();
  // Main stops the workspace as after a 409 history_regressed.
  await app.evaluate((_, id) => {
    const svc = global.__semChat;
    svc.store.updateWs(id, { state: 'quarantined' });
    svc.stateChanged();
  }, ws.id);
  const banner = pane().locator('.ch-banner');
  await expect(banner).toBeVisible({ timeout: 10000 });
  await expect(banner.locator('.ch-banner-text')).toHaveText(/^Rukoo stopped syncing Acme/);
  await expect(empty).toBeVisible();
  await expect(empty.locator('.ch-empty-title')).toHaveText('Nothing open');
  await banner.locator('[data-ch-banner]').click();
  await expect(banner).toBeHidden({ timeout: 15000 });
  await expect.poll(() => win.evaluate((id) => window.mail.call('chatState').then((s) => s.workspaces.find((w) => w.id === id)?.status), ws.id), { timeout: 15000 }).not.toBe('quarantined');
});

test('messages that age out leave the open conversation at once, with the note that older ones were removed', async () => {
  const { olga, bart, ws } = await twoPeople(server);
  for (const text of ['Oldest note', 'Middle note', 'Newest note']) await server.post(olga, ws.id, ws.general, text);
  // The window has no focus, so nothing is read: a read would bring the room's real floor back from the feed.
  ({ app, win } = await launch(server, { dataDir, focus: false }));
  await signIn(win, bart);
  await openChat(win);
  await expect(message('Newest note')).toBeVisible({ timeout: 15000 });
  await expect(message('Oldest note')).toBeVisible();
  await expect(log().locator('li.ch-intro')).toHaveCount(1);
  const floor = Number(await message('Middle note').getAttribute('data-seq'));
  // Retention moved general's floor to the middle message (contract 8.1: the local server can't do that on demand).
  // Main sends the room's row alone when the log shows nothing below it that main pushed; the renderer has to drop
  // what aged out itself.
  await app.evaluate(
    (_, { wsId, room, floorSeq }) => {
      const svc = global.__semChat;
      svc.store.setRoomFields(wsId, room, { floor: floorSeq });
      svc.roomsChanged(wsId, [room]);
    },
    { wsId: ws.id, room: ws.general, floorSeq: floor }
  );
  await expect(message('Oldest note')).toHaveCount(0);
  await expect(message('Middle note')).toBeVisible();
  await expect(message('Newest note')).toBeVisible();
  await expect(log().locator('li.ch-intro')).toHaveCount(0);
  await expect(log().locator('li.ch-floor')).toHaveCount(1);
});

test('a cached message with a time a Date cannot hold still shows, without a time', async () => {
  const { olga, bart, ws, bartMe } = await twoPeople(server);
  await server.seedChannel(olga, ws.id, { name: 'review', members: [bartMe.id] });
  await server.post(olga, ws.id, ws.general, 'From the far future');
  await server.post(olga, ws.id, ws.general, 'From today');
  ({ app, win } = await launch(server, { dataDir }));
  await signIn(win, bart);
  await openChat(win);
  await expect(message('From today')).toBeVisible({ timeout: 15000 });
  const seq = Number(await message('From the far future').getAttribute('data-seq'));
  // A cache from before main refused such times holds one past 8.64e15 ms, where toISOString() throws.
  await app.evaluate((_, [w, c, s]) => global.__semChat.store.run('UPDATE event SET at = ? WHERE ws = ? AND room = ? AND seq = ?', 8.64e15 + 1, w, c, s), [ws.id, ws.general, seq]);
  await roomRow(win, 'review').click();
  await expect(pane().locator('.ch-title')).toHaveText('review');
  await roomRow(win, 'general').click();
  await expect(pane().locator('.ch-title')).toHaveText('general');
  await expect(message('From the far future')).toBeVisible({ timeout: 10000 });
  await expect(message('From today')).toBeVisible();
  await expect(message('From the far future').locator('time').first()).toHaveAttribute('datetime', '');
});

test('older messages load when scrolling up, with the view kept in place, down to the note that older ones were removed', async () => {
  const { olga, bart, ws } = await twoPeople(server);
  // Each message is taller than a third of the log, so a page of five overflows it by more than the 400px at which
  // older messages load by themselves: a further page comes from scrolling up.
  const lines = Array.from({ length: 16 }, (_, i) => `line ${i + 1}`).join('\n');
  const posts = [];
  for (let i = 1; i <= 14; i++) posts.push(await server.post(olga, ws.id, ws.general, `Message ${i}\n${lines}`));
  // The window has no focus here, so nothing is read: a read would bring the room's real floor back from the feed.
  ({ app, win } = await launch(server, { dataDir, focus: false }));
  await signIn(win, bart);
  await roomsReady();
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
  const scroller = pane().locator('.ch-scroll');
  const note = log().locator('li.ch-floor');
  let scrolls = 0;
  for (let i = 0; i < 6 && !(await note.count()); i++) {
    await expect(pane().locator('.ch-older .spinner')).toHaveCount(0, { timeout: 15000 });
    // Scrolled to the top: the first message and where its text shows in the log, read before the page can arrive.
    const before = await scroller.evaluate((el) => {
      el.scrollTop = 0;
      const first = el.querySelector('.ch-log li.ch-msg');
      const text = first.querySelector('.ch-text');
      return { seq: Number(first.dataset.seq), top: text.getBoundingClientRect().top - el.getBoundingClientRect().top };
    });
    scrolls++;
    await expect
      .poll(() => scroller.evaluate((el) => Number(el.querySelector('.ch-log li.ch-msg').dataset.seq)), { timeout: 15000 })
      .toBeLessThan(before.seq);
    // The older page came in above it, and its text stays where it was, though its name line went to the group's new
    // first message.
    const after = await scroller.evaluate((el, seq) => {
      const row = el.querySelector(`.ch-log li.ch-msg[data-seq="${seq}"]`);
      const text = row.querySelector('.ch-text');
      return { top: text.getBoundingClientRect().top - el.getBoundingClientRect().top, scrollTop: el.scrollTop };
    }, before.seq);
    expect(Math.abs(after.top - before.top)).toBeLessThan(3);
    expect(after.scrollTop).toBeGreaterThan(400);
  }
  expect(scrolls).toBeGreaterThan(0);
  await expect(note).toBeVisible({ timeout: 15000 });
  await expect(note).toContainText('were removed');
  await expect(message('Message 3')).toBeVisible();
  await expect(message('Message 2')).toHaveCount(0);
  await expect(log().locator('li.ch-intro')).toHaveCount(0);
  // Fourteen messages came in pages of five: nothing shows twice.
  await expect(log().locator('li.ch-msg')).toHaveCount(12);
});

test('an older page main dropped waits for Retry or the room coming again, instead of asking at once', async () => {
  const { olga, bart, ws } = await twoPeople(server);
  for (let i = 1; i <= 8; i++) await server.post(olga, ws.id, ws.general, `Note ${i}`);
  ({ app, win } = await launch(server, { dataDir, focus: false }));
  await signIn(win, bart);
  await roomsReady();
  // Small pages from an empty cache, and chatOlder answering as main does when the room's grant moved meanwhile:
  // nothing, with more to come.
  await app.evaluate(
    (_, { wsId, room }) => {
      const svc = global.__semChat;
      svc.timing.eventsNewest = 5;
      svc.store.tx(() => svc.store.dropRoomCache(wsId, room));
      svc.roomsChanged(wsId, [room]);
      global.__olderCalls = 0;
      svc.history.older = async (w, c, before) => {
        global.__olderCalls++;
        return { events: [], lo: before, hasOlder: true };
      };
    },
    { wsId: ws.id, room: ws.general }
  );
  const calls = () => app.evaluate(() => global.__olderCalls);
  await openChat(win);
  await expect(message('Note 8')).toBeVisible({ timeout: 15000 });
  const older = pane().locator('.ch-older');
  await expect(older.locator('.ch-older-text')).toHaveText("Couldn't load older messages.");
  await win.waitForTimeout(1500);
  expect(await calls()).toBe(1);
  // Retry asks once more, and only once.
  await older.locator('button').click();
  await expect.poll(calls).toBe(2);
  await expect(older.locator('.ch-older-text')).toHaveText("Couldn't load older messages.");
  await win.waitForTimeout(1000);
  expect(await calls()).toBe(2);
  // The room comes again as a replacing push, as it does after a moved grant: older history loads by itself.
  await app.evaluate(
    (_, { wsId, room }) => {
      const svc = global.__semChat;
      delete svc.history.older;
      svc.history.showAgain(wsId, room);
    },
    { wsId: ws.id, room: ws.general }
  );
  await expect(log().locator('li.ch-intro')).toBeVisible({ timeout: 15000 });
  await expect(message('Note 1')).toBeVisible();
  await expect(log().locator('li.ch-msg')).toHaveCount(8);
  await expect(older.locator('.ch-older-text')).toHaveCount(0);
});

test('choosing a workspace or clicking a notification opens one conversation, once', async () => {
  const { olga, bart, ws, bartMe } = await twoPeople(server);
  const review = await server.seedChannel(olga, ws.id, { name: 'review', members: [bartMe.id] });
  const beta = await server.seedWorkspace(olga, { name: 'Beta', displayName: 'Olga Owner' });
  const bartBeta = await server.seedMember(beta, bart, 'Bart');
  const ops = await server.seedChannel(olga, beta.id, { name: 'ops', members: [bartBeta.id] });
  const spaces = {
    Acme: { id: ws.id, name: 'Acme', general: ws.general, other: { id: review.id, name: 'review' } },
    Beta: { id: beta.id, name: 'Beta', general: beta.general, other: { id: ops.id, name: 'ops' } }
  };
  ({ app, win } = await launch(server, { dataDir }));
  await signIn(win, bart);
  await openChat(win);
  await expect(pane().locator('.ch-title')).toHaveText('general', { timeout: 15000 });
  const switcher = win.locator('.sidebar .ch-ws-switch');
  const here = spaces[(await switcher.locator('.name').textContent()).trim()];
  const there = here === spaces.Acme ? spaces.Beta : spaces.Acme;
  // Both first runs are through, directories and all: a directory that comes in later loads the view again (one
  // chatView more), which is right but not what is counted here.
  await expect
    .poll(() => app.evaluate(() => global.__semChat.debugState().workspaces.every((w) => w.syncedAt && !w.syncing && !w.stale.members && !w.stale.channels && !w.stale.blocks)), { timeout: 15000 })
    .toBe(true);
  await win.waitForTimeout(600);
  // Every chatView and chatOpen main answers from here on.
  await app.evaluate(() => {
    const svc = global.__semChat;
    global.__chatCalls = [];
    const view = svc.view;
    svc.view = function (w) {
      global.__chatCalls.push(['view', w]);
      return view.call(this, w);
    };
    const openRoom = svc.history.openRoom;
    svc.history.openRoom = function (w, c, opts) {
      global.__chatCalls.push(['open', w, c]);
      return openRoom.call(this, w, c, opts);
    };
  });
  const calls = () => app.evaluate(() => global.__chatCalls.splice(0));
  const opens = (list) => list.filter((x) => x[0] === 'open');

  // The workspace menu: one chatView, then one chatOpen, for the first room of the other workspace.
  await switcher.click();
  await win.locator('.menu [role="menuitem"]', { hasText: there.name }).click();
  await expect(switcher.locator('.name')).toHaveText(there.name, { timeout: 15000 });
  await expect(pane().locator('.ch-title')).toHaveText('general', { timeout: 15000 });
  await win.waitForTimeout(1500);
  let list = await calls();
  expect(opens(list)).toEqual([['open', there.id, there.general]]);
  // Counted for the workspace being opened: a directory reload of the one on screen that fires late isn't the switch's.
  expect(list.slice(0, list.findIndex((x) => x[0] === 'open')).filter((x) => x[0] === 'view' && x[1] === there.id)).toEqual([['view', there.id]]);

  // A notification for the other room of the first workspace opens that room, without its saved room (general) first.
  await app.evaluate((_, open) => global.__semChatOpen(open), { ws: here.id, conversation: here.other.id });
  await expect(switcher.locator('.name')).toHaveText(here.name, { timeout: 15000 });
  await expect(pane().locator('.ch-title')).toHaveText(here.other.name, { timeout: 15000 });
  await win.waitForTimeout(1500);
  list = await calls();
  expect(opens(list)).toEqual([['open', here.id, here.other.id]]);
  expect(list.slice(0, list.findIndex((x) => x[0] === 'open')).filter((x) => x[0] === 'view' && x[1] === here.id)).toEqual([['view', here.id]]);
});

test('leaving the open channel elsewhere shows the gone state, and a language change redraws it', async () => {
  const { olga, bart, ws, bartMe } = await twoPeople(server);
  const project = await server.seedChannel(olga, ws.id, { name: 'project', members: [bartMe.id] });
  await server.post(olga, ws.id, project.id, 'Project kickoff');
  ({ app, win } = await launch(server, { dataDir }));
  await signIn(win, bart);
  await openChat(win);
  await expect(roomRow(win, 'project')).toBeVisible({ timeout: 15000 });
  await roomRow(win, 'project').click();
  await expect(message('Project kickoff')).toBeVisible({ timeout: 15000 });
  await expect(win.locator('.sidebar .sync-status .t')).toHaveText('Connected', { timeout: 15000 });
  // Bart leaves on another device.
  const left = await server.call('DELETE', `/v1/workspaces/${ws.id}/channels/${project.id}/members/me`, { token: bart.token });
  expect(left.status).toBe(204);
  const empty = pane().locator('.ch-empty');
  await expect(empty.locator('.ch-empty-title')).toHaveText("You're no longer in project", { timeout: 15000 });
  await expect(log().locator('li')).toHaveCount(0);
  await expect(roomRow(win, 'project')).toHaveCount(0);
  await win.evaluate(() => window.mail.call('updateSettings', { language: 'nl' }));
  await expect(empty.locator('.ch-empty-title')).toHaveText('Je bent niet meer in project');
  await expect(empty.locator('.ch-empty-body')).toContainText('Je bent uit dit gesprek gehaald');
  await empty.locator('[data-ch-empty="gone-ok"]').click();
  await expect(pane().locator('.ch-title')).toHaveText('general');
});

test('a 404 for the workspace from opening a room or loading the workspace shows the gone workspace', async () => {
  const { olga, bart, ws, bartMe } = await twoPeople(server);
  await server.seedChannel(olga, ws.id, { name: 'review', members: [bartMe.id] });
  ({ app, win } = await launch(server, { dataDir }));
  await signIn(win, bart);
  await openChat(win);
  await expect(pane().locator('.ch-title')).toHaveText('general', { timeout: 15000 });
  const empty = pane().locator('.ch-empty');
  // Main answers the next chatOpen as it does for a workspace the person is no longer in.
  await app.evaluate(() => {
    global.__semChat.history.openRoom = async () => {
      throw Object.assign(new Error('gone'), { code: 'not_found', status: 404, details: { scope: 'workspace' } });
    };
  });
  await roomRow(win, 'review').click();
  await expect(empty.locator('.ch-empty-title')).toHaveText("You're no longer in Acme");
  await expect(pane().locator('.ch-older-text')).toHaveCount(0);
  await expect(win.locator('.sidebar [data-ch-side="make"]')).toBeVisible();
  // With main back to normal, OK selects the workspace again.
  await app.evaluate(() => {
    delete global.__semChat.history.openRoom;
  });
  await empty.locator('[data-ch-empty="gone-ok"]').click();
  await expect(pane().locator('.ch-title')).toHaveText('review', { timeout: 15000 });
  // The same answer to chatView, which a directory change asks for.
  await app.evaluate((_, wsId) => {
    const svc = global.__semChat;
    svc.view = () => {
      throw Object.assign(new Error('gone'), { code: 'not_found', status: 404, details: { scope: 'workspace' } });
    };
    svc.emitChat({ kind: 'directory', ws: wsId });
  }, ws.id);
  await expect(empty.locator('.ch-empty-title')).toHaveText("You're no longer in Acme", { timeout: 10000 });
  await app.evaluate(() => {
    delete global.__semChat.view;
  });
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
    // It names the server Rukoo can't reach, since mail may still work, and offers the reconnecting banner's Try now.
    const host = await win.evaluate(() => window.mail.call('chatState').then((s) => s.host));
    await expect(banner.locator('.ch-banner-text')).toHaveText(`Rukoo can't reach ${host}. Messages you send wait until it reconnects.`);
    await expect(win.locator('.sidebar .sync-status .t')).toHaveText('Offline');
    // Try now runs a sync at once (chatSync), as on the reconnecting banner; the server is still down, so it stays.
    await app.evaluate(() => {
      const svc = global.__semChat;
      const syncNow = svc.syncNow.bind(svc);
      svc.tries = [];
      svc.syncNow = (ws) => {
        svc.tries.push(ws || null);
        return syncNow(ws);
      };
    });
    const tryNow = banner.locator('[data-ch-banner]');
    await expect(tryNow).toHaveText('Try now');
    await tryNow.click();
    await expect.poll(() => app.evaluate(() => global.__semChat.tries.length)).toBe(1);
    expect(await app.evaluate(() => global.__semChat.tries[0])).toBe(ws.id);
    await app.evaluate(() => {
      delete global.__semChat.syncNow;
      delete global.__semChat.tries;
    });
    await expect(banner).toBeVisible();
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
    await expect(win.locator('.titlebar-modes [data-mode="chat"]')).toHaveAttribute('aria-selected', 'true', { timeout: 15000 });
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
  const chatSeg = win.locator('.titlebar-modes [data-mode="chat"]');
  await expect(chatSeg).toBeVisible({ timeout: 15000 });
  await expect(chatSeg).toHaveAttribute('title', 'Chat (Ctrl+4)');
  await win.locator('.list-scroll').focus();
  await win.keyboard.press('Control+4');
  await expect(chatSeg).toHaveAttribute('aria-selected', 'true');
  await expect(win.locator('.shell')).toHaveClass(/chat-mode/);
  await expect(roomRow(win, 'general')).toBeVisible({ timeout: 15000 });
  await win.keyboard.press('Control+1');
  await expect(win.locator('.titlebar-modes [data-mode="mail"]')).toHaveAttribute('aria-selected', 'true');
  await win.keyboard.press('Control+4');
  await expect(chatSeg).toHaveAttribute('aria-selected', 'true');
  await restart();
  await expect(win.locator('.titlebar-modes [data-mode="chat"]')).toHaveAttribute('aria-selected', 'true', { timeout: 15000 });
  await expect(pane().locator('.ch-title')).toHaveText('general', { timeout: 15000 });
});

// Breaks the closed app's chat cache as a newer Rukoo's file would be, with count unsent messages in it: the next start
// replaces it and reports them through ChatState.lostUnsent (contract 3.4).
function breakCache(count) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(require('path').join(dataDir, 'data', 'chat.db'));
  try {
    db.exec(`UPDATE meta SET value = '99' WHERE key = 'schema'`);
    const room = db.prepare('SELECT ws, id, grantId FROM room LIMIT 1').get();
    for (let i = 0; i < count; i++) {
      db.prepare(`INSERT INTO outbox (local, ws, room, actor, grantId, generation, text, mentions, state, createdAt) VALUES (?, ?, ?, 'u', ?, 'x', 'lost words', '[]', 'queued', 1)`).run(
        String.fromCharCode(65 + i).repeat(22),
        room.ws,
        room.id,
        room.grantId
      );
    }
  } finally {
    db.close();
  }
}

test('a chat cache made again with unsent messages in it says once how many were lost', async () => {
  const { bart } = await twoPeople(server);
  ({ app, win } = await launch(server, { dataDir }));
  await signIn(win, bart);
  await openChat(win);
  await expect(pane().locator('.ch-title')).toHaveText('general', { timeout: 15000 });
  await closeApp(app);
  breakCache(2);
  ({ app, win } = await launch(server, { dataDir }));
  const toast = win.locator('#toast');
  const lost = "2 chat messages hadn't been sent yet and were lost when Rukoo had to repair its chat storage.";
  await expect(toast).toHaveText(lost, { timeout: 15000 });
  await expect(toast).toHaveClass(/show/);
  // Taken: main reports it no more, and the state events that follow don't show it again.
  await expect.poll(() => win.evaluate(() => window.mail.call('chatState').then((s) => s.lostUnsent))).toBe(0);
  const shownAgain = await win.evaluate(
    (text) =>
      new Promise((resolve) => {
        const el = document.getElementById('toast');
        const seen = new MutationObserver(() => {
          if (el.textContent === text) resolve(true);
        });
        seen.observe(el, { childList: true, subtree: true, characterData: true });
        window.mail.call('chatSync').catch(() => {});
        setTimeout(() => resolve(false), 3000);
      }),
    lost
  );
  expect(shownAgain).toBe(false);
  // The next start has nothing to say.
  await restart();
  await openChat(win);
  await expect(pane().locator('.ch-title')).toHaveText('general', { timeout: 15000 });
  await expect(win.locator('.sidebar .sync-status .t')).toHaveText('Connected', { timeout: 15000 });
  await expect(win.locator('#toast')).not.toHaveText(lost);
});

// Review of #376, finding 3: replies whose first message retention took, while the server keeps them, keep a row
// where it was, which says so and opens their thread.
test('replies whose first message aged out show under a row saying it is no longer kept, which opens their thread', async () => {
  const { olga, bart, ws } = await twoPeople(server);
  const root = await server.post(olga, ws.id, ws.general, 'Old plan for the offsite');
  const first = await server.post(olga, ws.id, ws.general, 'Still on', { root: root.messageId });
  await server.post(olga, ws.id, ws.general, 'Newer note');
  const last = await server.post(olga, ws.id, ws.general, 'Yes, Friday', { root: root.messageId });
  // The window has no focus, so nothing is read: a read would bring the room's real floor back from the feed.
  ({ app, win } = await launch(server, { dataDir, focus: false }));
  await signIn(win, bart);
  await openChat(win);
  await expect(message('Newer note')).toBeVisible({ timeout: 15000 });
  await expect(message('Old plan for the offsite').locator('.ch-replies-n')).toHaveText('2 replies');
  // Retention moved general's floor past the first message, not its replies (contract 8.1: the local server can't do
  // that on demand).
  await app.evaluate(
    (_, { wsId, room, floorSeq }) => {
      const svc = global.__semChat;
      // As a feed page's floor does: what is below it goes from the cache.
      svc.store.applyFloor(wsId, room, floorSeq);
      svc.roomsChanged(wsId, [room]);
    },
    { wsId: ws.id, room: ws.general, floorSeq: first.seq }
  );
  await expect(message('Old plan for the offsite')).toHaveCount(0);
  const row = log().locator('li.is-thread-row');
  await expect(row).toHaveCount(1);
  await expect(row.locator('.ch-removed')).toHaveText('This message is no longer kept');
  await expect(row.locator('.ch-replies-n')).toHaveText('2 replies');
  // Where the first message was: right under the note that older messages were removed.
  await expect(log().locator('li').nth(0)).toHaveClass(/ch-floor/);
  await expect(log().locator('li').nth(1)).toHaveClass(/is-thread-row/);
  await row.locator('.ch-replies').click();
  await expect(threadLog().locator(`li.ch-msg[data-seq="${last.seq}"]`)).toBeVisible({ timeout: 15000 });
  await expect(threadLog().locator(`li.ch-msg[data-seq="${first.seq}"]`)).toBeVisible();
  await expect(win.locator('section.chat .ch-thread .ch-thread-note')).toBeVisible();
  // Closing it gives the keyboard focus back to the row it opened from (review finding 6).
  await win.locator('section.chat .ch-thread [data-ch="thread-close"]').click();
  await expect.poll(() => win.evaluate(() => Boolean(document.activeElement && document.activeElement.matches('section.chat .ch-log li.is-thread-row')))).toBe(true);
});

// Review of #376, finding 4: the pill goes by the reply line with the dot, not by the first message's row.
test('the pill for new replies shows while their reply line is out of view, also with the first message partly in view', async () => {
  const { olga, bart, ws } = await twoPeople(server);
  const tall = Array.from({ length: 40 }, (_, i) => `step ${i + 1}`).join('\n');
  const root = await server.post(olga, ws.id, ws.general, `The long plan\n${tall}`);
  // Enough after it that its reply line is above the view when the conversation opens at the bottom.
  for (let i = 1; i <= 20; i++) await server.post(olga, ws.id, ws.general, `After ${i}`);
  const read = await server.post(olga, ws.id, ws.general, 'Read up to here');
  await server.read(bart, ws.id, ws.general, read.seq);
  await server.post(olga, ws.id, ws.general, 'Looks good to me', { root: root.messageId });
  ({ app, win } = await launch(server, { dataDir }));
  await signIn(win, bart);
  await openChat(win);
  await expect(message('Read up to here')).toBeVisible({ timeout: 15000 });
  const pill = pane().locator('.ch-jump.is-thread');
  await expect(pill).toHaveText('1 new reply in a thread', { timeout: 15000 });
  // The first message's top in view at the bottom of the log, its reply line below the view: the pill stays.
  await win.evaluate((id) => {
    const scroll = document.querySelector('section.chat .ch-scroll');
    const li = document.querySelector(`section.chat .ch-log li.ch-msg[data-id="${id}"]`);
    scroll.scrollTop += li.getBoundingClientRect().top - (scroll.getBoundingClientRect().bottom - 80);
  }, root.messageId);
  const top = message('The long plan');
  await expect(top).toBeInViewport();
  await expect(top.locator('.ch-replies')).not.toBeInViewport();
  await expect(pill).toBeVisible();
  // The reply line in view: the pill goes.
  await intoView(top.locator('.ch-replies'));
  await expect(top.locator('.ch-replies')).toHaveClass(/has-new/);
  await expect(pill).toBeHidden();
});

// Review of #376, finding 5: a thread marks as seen only the replies it showed in view.
test('a thread opened at its oldest new reply keeps the dot for the replies below the view, also for one that comes in', async () => {
  const { olga, bart, ws } = await twoPeople(server);
  const sanne = await server.seedAccount();
  await server.seedMember(ws, sanne, 'Sanne');
  const question = await server.post(bart, ws.id, ws.general, 'Lunch on Friday?');
  for (let i = 1; i <= 30; i++) await server.post(i % 2 ? olga : sanne, ws.id, ws.general, `News ${i}`);
  const read = await server.post(sanne, ws.id, ws.general, 'News 31');
  await server.read(bart, ws.id, ws.general, read.seq);
  const lines = Array.from({ length: 6 }, (_, i) => `point ${i + 1}`).join('\n');
  const replies = [];
  for (let i = 1; i <= 12; i++) replies.push(await server.post(i % 2 ? olga : sanne, ws.id, ws.general, `Answer ${i}\n${lines}`, { root: question.messageId }));
  ({ app, win } = await launch(server, { dataDir }));
  await signIn(win, bart);
  await openChat(win);
  await expect(message('News 31')).toBeVisible({ timeout: 15000 });
  const pill = pane().locator('.ch-jump.is-thread');
  await expect(pill).toHaveText('12 new replies in a thread', { timeout: 15000 });
  // The pill opens the thread at the oldest new reply: the newest are below the view.
  await pill.click();
  const oldest = threadLog().locator(`li.ch-msg[data-seq="${replies[0].seq}"]`);
  await expect(oldest).toBeInViewport({ timeout: 15000 });
  const newest = threadLog().locator(`li.ch-msg[data-seq="${replies[11].seq}"]`);
  await expect(newest).not.toBeInViewport();
  // Those it didn't show stay new: the pill still counts them.
  await expect(pill).toBeVisible();
  await expect(pill).not.toHaveText('12 new replies in a thread');
  await win.locator('section.chat .ch-thread [data-ch="thread-close"]').click();
  await intoView(message('Lunch on Friday?'));
  const line = message('Lunch on Friday?').locator('.ch-replies');
  await expect(line).toHaveClass(/has-new/);
  // Opened again at its newest replies, the ones between were never in view: the dot stays until they were.
  await line.click();
  await expect(newest).toBeInViewport({ timeout: 15000 });
  await expect(line).toHaveClass(/has-new/);
  await win.evaluate(async () => {
    const scroll = document.querySelector('section.chat .ch-thread .ch-thread-scroll');
    for (let top = scroll.scrollTop; top > 0; top -= scroll.clientHeight / 3) {
      scroll.scrollTop = top;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }
    scroll.scrollTop = 0;
  });
  await expect(line).not.toHaveClass(/has-new/);
  // Scrolled up in the thread, a new reply comes in below the view: it keeps its cue.
  await win.evaluate(() => {
    document.querySelector('section.chat .ch-thread .ch-thread-scroll').scrollTop = 0;
  });
  const late = await server.post(olga, ws.id, ws.general, 'One more: half past twelve', { root: question.messageId });
  const lateRow = threadLog().locator(`li.ch-msg[data-seq="${late.seq}"]`);
  await expect(lateRow).toHaveCount(1, { timeout: 15000 });
  await expect(lateRow).not.toBeInViewport();
  await expect(line).toHaveClass(/has-new/);
  await intoView(lateRow);
  await expect(line).not.toHaveClass(/has-new/);
});

// Issue #376: a reply for you alerts as a message for you would. With its conversation on screen in the focused window
// nothing alerts, and the dot is the cue; from another conversation it shows a toast, whose Open opens the thread.
test('a reply for you shows no toast while its conversation is on screen, and from another one a toast whose Open opens its thread', async () => {
  const { olga, bart, ws, bartMe } = await twoPeople(server);
  await server.seedChannel(olga, ws.id, { name: 'review', members: [bartMe.id] });
  const mine = await server.post(bart, ws.id, ws.general, 'Lunch on Friday?');
  ({ app, win } = await launch(server, { dataDir }));
  await signIn(win, bart);
  await openChat(win);
  await expect(message('Lunch on Friday?')).toBeVisible({ timeout: 15000 });
  await expect(win.locator('.sidebar .sync-status .t')).toHaveText('Connected', { timeout: 15000 });
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].isFocused = () => true;
    global.__semChat.setFocused(true);
  });
  const toast = win.locator('#toast');
  const first = await server.post(olga, ws.id, ws.general, 'Yes, at noon', { root: mine.messageId });
  const line = message('Lunch on Friday?').locator('.ch-replies');
  await expect(line.locator('.ch-replies-n')).toHaveText('1 reply', { timeout: 15000 });
  await expect(line).toHaveClass(/has-new/);
  await win.waitForTimeout(1500);
  await expect(toast).not.toContainText('Yes, at noon');
  expect((await notices(app)).filter((n) => String(n.body).includes('Yes, at noon'))).toEqual([]);

  // Bart read general and moved to review: the next reply shows a toast with Open.
  await expect.poll(() => serverRead(server, bart, ws.id, ws.general), { timeout: 15000 }).toBeGreaterThanOrEqual(first.seq);
  await roomRow(win, 'review').click();
  await expect(pane().locator('.ch-title')).toHaveText('review');
  const answer = await server.post(olga, ws.id, ws.general, 'Half past twelve works too', { root: mine.messageId });
  await expect(toast).toContainText('Olga Owner replied: Half past twelve works too', { timeout: 20000 });
  await toast.locator('button', { hasText: 'Open' }).click();
  await expect(pane().locator('.ch-title')).toHaveText('general', { timeout: 15000 });
  await expect(threadLog().locator(`li.ch-msg[data-seq="${answer.seq}"]`)).toBeVisible({ timeout: 15000 });
  await expect(message('Half past twelve works too')).toHaveCount(0);
});

// Review of #376, finding 3: a thread opened at its newest replies leaves the older new replies above the view new.
test('a thread opened at its newest replies keeps the dot for the new replies above the view, until they were in view', async () => {
  const { olga, bart, ws } = await twoPeople(server);
  const question = await server.post(bart, ws.id, ws.general, 'Lunch on Friday?');
  const lines = Array.from({ length: 6 }, (_, i) => `point ${i + 1}`).join('\n');
  const replies = [];
  for (let i = 1; i <= 12; i++) replies.push(await server.post(olga, ws.id, ws.general, `Answer ${i}\n${lines}`, { root: question.messageId }));
  ({ app, win } = await launch(server, { dataDir }));
  await signIn(win, bart);
  await openChat(win);
  const line = message('Lunch on Friday?').locator('.ch-replies');
  await expect(line).toHaveClass(/has-new/, { timeout: 15000 });
  // The reply line opens the thread at its newest replies; the oldest are above the view.
  await line.click();
  const newest = threadLog().locator(`li.ch-msg[data-seq="${replies[11].seq}"]`);
  const oldest = threadLog().locator(`li.ch-msg[data-seq="${replies[0].seq}"]`);
  await expect(newest).toBeInViewport({ timeout: 15000 });
  await expect(oldest).not.toBeInViewport();
  await win.locator('section.chat .ch-thread [data-ch="thread-close"]').click();
  await expect(line).toHaveClass(/has-new/);
  // Scrolled to the top of the thread, every new reply was in view: the dot goes.
  await line.click();
  await expect(newest).toBeInViewport({ timeout: 15000 });
  await win.evaluate(async () => {
    const scroll = document.querySelector('section.chat .ch-thread .ch-thread-scroll');
    for (let top = scroll.scrollTop; top > 0; top -= scroll.clientHeight / 3) {
      scroll.scrollTop = top;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }
    scroll.scrollTop = 0;
  });
  await expect(oldest).toBeInViewport();
  await expect(line).not.toHaveClass(/has-new/);
});

// A thread left open in a window nobody looks at shows its replies to no one: they stay new until the window is back.
test('a reply that comes into an open thread while the window has no focus stays new until the window has it again', async () => {
  const { olga, bart, ws } = await twoPeople(server);
  const question = await server.post(bart, ws.id, ws.general, 'Lunch on Friday?');
  await server.post(olga, ws.id, ws.general, 'I do', { root: question.messageId });
  ({ app, win } = await launch(server, { dataDir }));
  await signIn(win, bart);
  await openChat(win);
  const line = message('Lunch on Friday?').locator('.ch-replies');
  await expect(line).toHaveClass(/has-new/, { timeout: 15000 });
  await line.click();
  await expect(threadLog().locator('li.ch-msg', { hasText: 'I do' })).toBeInViewport({ timeout: 15000 });
  await expect(line).not.toHaveClass(/has-new/);
  // The window loses the focus with the thread still open, and a reply comes in. The test window's focus is emulated
  // for the whole run, so the page is told it has none.
  await win.evaluate(() => {
    document.hasFocus = () => false;
  });
  await server.post(olga, ws.id, ws.general, 'Me too', { root: question.messageId });
  await expect(threadLog().locator('li.ch-msg', { hasText: 'Me too' })).toBeInViewport({ timeout: 15000 });
  await expect(line).toHaveClass(/has-new/);
  // Back in the window, the reply in view counts as seen.
  await win.evaluate(() => {
    delete document.hasFocus;
    window.dispatchEvent(new Event('focus'));
  });
  await expect(line).not.toHaveClass(/has-new/);
});
