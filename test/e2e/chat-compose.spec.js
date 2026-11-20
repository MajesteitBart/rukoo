// Team chat's composer, sending, threads and message actions (contract 3.8, 3.13, 3.14, 3.17, 5.5, 5.6, 8.5): the real
// app on a throwaway profile against the real account server, with Olga acted for over HTTP and every outcome checked
// from her side too. One server for the file, the app per test.
const path = require('path');
const { test, expect } = require('@playwright/test');
const { tempDir, removeDir } = require('../tmp');
const { closeApp } = require('./close');
const { skipWithoutServer, startServer, launch, signIn, openChat, twoPeople, roomRow, composer, serverMessages, connected, holdRuns } = require('./chat-helpers');
const vectors = require(path.join(__dirname, '..', 'fixtures', 'chat-vectors.json'));

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
  dataDir = tempDir('rukoo-chat-compose-');
});

test.afterEach(async () => {
  await closeApp(app);
  app = null;
  removeDir(dataDir);
});

const pane = () => win.locator('section.chat');
const log = () => win.locator('section.chat .ch-main .ch-log');
const threadPane = () => win.locator('section.chat .ch-thread');
const threadLog = () => threadPane().locator('.ch-thread-log');
// A message row by its own text (a reply's context line quotes its thread's first message).
const message = (list, text) => list.locator('li.ch-msg').filter({ has: win.locator('.ch-text', { hasText: text }) });

// Bart signed in, Chat open on general, connected.
async function ready(person) {
  await signIn(win, person);
  await openChat(win);
  await expect(pane().locator('.ch-title')).toHaveText('general', { timeout: 15000 });
  await connected(win);
}

// Types into the composer: Enter at the end sends unless send is false.
async function write(text, { thread = false, send = true } = {}) {
  const input = composer(win, { thread });
  await input.click();
  await win.keyboard.type(text);
  if (send) await win.keyboard.press('Enter');
}

// A message's tools show on hover: the tool's button.
async function tool(row, name) {
  await row.hover();
  const b = row.locator(`[data-ch-tool="${name}"]`);
  await expect(b).toBeVisible();
  return b;
}

test('Enter sends a message: it shows as pending, becomes the sent message in place, and the server has it once', async () => {
  const { olga, bart, ws } = await twoPeople(server);
  ({ app, win } = await launch(server, { dataDir }));
  await ready(bart);
  // Every state a row with a local ID goes through, by key.
  await win.evaluate(() => {
    const list = document.querySelector('section.chat .ch-main .ch-log');
    window.__rows = [];
    const note = () => {
      for (const li of list.querySelectorAll('li.ch-msg[data-local]')) window.__rows.push({ key: li.dataset.key, state: li.dataset.state || null, seq: li.dataset.seq || null });
    };
    new MutationObserver(note).observe(list, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-state', 'data-seq'] });
  });
  await write('Hello from Bart');
  await expect(composer(win)).toHaveJSProperty('value', '');
  const sent = message(log(), 'Hello from Bart');
  await expect(sent).toHaveCount(1);
  await expect(sent).toHaveAttribute('data-seq', /^\d+$/, { timeout: 15000 });
  await expect(sent).not.toHaveClass(/is-pending/);
  const rows = await win.evaluate(() => window.__rows);
  const pendingRow = rows.find((r) => r.state);
  expect(pendingRow, 'the message showed as pending first').toBeTruthy();
  expect(pendingRow.seq).toBeNull();
  // The same row, by key: the pending row turned into the sent one in place.
  expect(await sent.getAttribute('data-key')).toBe(pendingRow.key);
  await expect.poll(async () => (await serverMessages(server, olga, ws.id, ws.general, 'Hello from Bart')).length, { timeout: 15000 }).toBe(1);
  // Nothing is left to send.
  await expect.poll(() => win.evaluate(() => window.mail.call('chatState').then((s) => s.unsent))).toBe(0);
});

test('Shift+Enter starts a new line, and the message goes with it', async () => {
  const { olga, bart, ws } = await twoPeople(server);
  ({ app, win } = await launch(server, { dataDir }));
  await ready(bart);
  await write('Line one', { send: false });
  await win.keyboard.press('Shift+Enter');
  await win.keyboard.type('Line two');
  await expect(composer(win)).toHaveJSProperty('value', 'Line one\nLine two');
  await win.keyboard.press('Enter');
  const sent = message(log(), 'Line two');
  await expect(sent).toHaveAttribute('data-seq', /^\d+$/, { timeout: 15000 });
  await expect(sent.locator('.ch-text')).toHaveText('Line one\nLine two');
  await expect.poll(async () => (await serverMessages(server, olga, ws.id, ws.general, 'Line one\nLine two')).length, { timeout: 15000 }).toBe(1);
});

test('mentions of Zoë and Joël picked from the list reach the server with the byte ranges the vectors predict', async () => {
  const { olga, bart, ws } = await twoPeople(server);
  const zoe = await server.seedMember(ws, await server.seedAccount(), 'Zoë');
  const joel = await server.seedMember(ws, await server.seedAccount(), 'Joël');
  ({ app, win } = await launch(server, { dataDir }));
  await ready(bart);
  const picker = win.locator('.ch-suggest');
  await write('Hoi @Zo', { send: false });
  await expect(picker.locator('[role="option"] .mention-name').first()).toHaveText('Zoë', { timeout: 10000 });
  await expect(composer(win)).toHaveAttribute('aria-activedescendant', /.+/);
  await win.keyboard.press('Enter');
  await expect(picker).toHaveCount(0);
  await expect(composer(win).locator(`.ch-chip[data-member="${zoe.id}"]`)).toHaveText('@Zoë');
  await win.keyboard.type('en @Jo');
  await expect(picker.locator('[role="option"] .mention-name')).toHaveText(['Joël']);
  await win.keyboard.press('Tab');
  // The "!" takes the place of the space that came with the chip.
  await win.keyboard.type('!');
  const vector = vectors.mentions.find((v) => v.name === 'two names with accents');
  await expect(composer(win)).toHaveJSProperty('value', vector.text);
  await win.keyboard.press('Enter');
  const sent = message(log(), 'Hoi');
  await expect(sent).toHaveAttribute('data-seq', /^\d+$/, { timeout: 15000 });
  await expect(sent.locator('.ch-mention')).toHaveText(['@Zoë', '@Joël']);
  let stored;
  await expect
    .poll(async () => {
      stored = (await serverMessages(server, olga, ws.id, ws.general, vector.text))[0];
      return Boolean(stored);
    }, { timeout: 15000 })
    .toBe(true);
  const actors = [zoe.id, joel.id];
  expect(stored.mentions).toEqual(vector.bytes.map((m, i) => ({ actor: actors[i], start: m.start, end: m.end })));
});

test('a chip goes with one Backspace, and @ typed by hand stays plain text', async () => {
  const { olga, bart, ws } = await twoPeople(server);
  await server.seedMember(ws, await server.seedAccount(), 'Zoë');
  ({ app, win } = await launch(server, { dataDir }));
  await ready(bart);
  await write('Ask @Zo', { send: false });
  await expect(win.locator('.ch-suggest [role="option"] .mention-name').first()).toHaveText('Zoë', { timeout: 10000 });
  await win.keyboard.press('Enter');
  await expect(composer(win).locator('.ch-chip')).toHaveCount(1);
  // The space after the chip, then the chip as one piece.
  await win.keyboard.press('Backspace');
  await win.keyboard.press('Backspace');
  await expect(composer(win).locator('.ch-chip')).toHaveCount(0);
  await expect(composer(win)).toHaveJSProperty('value', 'Ask ');
  // Escape closes the list for this @, and the text stays plain.
  await win.keyboard.type('@Zoë');
  await expect(win.locator('.ch-suggest')).toHaveCount(1);
  await win.keyboard.press('Escape');
  await expect(win.locator('.ch-suggest')).toHaveCount(0);
  await win.keyboard.press('Enter');
  const sent = message(log(), 'Ask @Zoë');
  await expect(sent).toHaveAttribute('data-seq', /^\d+$/, { timeout: 15000 });
  await expect(sent.locator('.ch-mention')).toHaveCount(0);
  await expect.poll(async () => (await serverMessages(server, olga, ws.id, ws.general, 'Ask @Zoë'))[0]?.mentions, { timeout: 15000 }).toEqual([]);
});

test('a mention of someone who left the channel is refused: Discard can be undone, and Send without mentions posts it', async () => {
  const { olga, bart, ws } = await twoPeople(server);
  const zoe = await server.seedMember(ws, await server.seedAccount(), 'Zoë');
  ({ app, win } = await launch(server, { dataDir }));
  await ready(bart);
  await write('Over to @Zo', { send: false });
  await expect(win.locator('.ch-suggest [role="option"] .mention-name').first()).toHaveText('Zoë', { timeout: 10000 });
  await win.keyboard.press('Enter');
  await win.keyboard.type('for review');
  // Zoë leaves general before the message goes.
  const out = await server.call('DELETE', `/v1/workspaces/${ws.id}/channels/${ws.general}/members/${zoe.id}`, { token: olga.token });
  expect([200, 204]).toContain(out.status);
  await win.keyboard.press('Enter');
  const row = message(log(), 'Over to @Zoë for review');
  const state = row.locator('.ch-state.is-failed');
  await expect(state).toContainText("Not sent: Someone you mentioned isn't in this conversation any more.", { timeout: 15000 });
  await expect(row).toHaveAttribute('data-state', 'failed');
  await expect(state.locator('[data-ch-act]')).toHaveText(['Send without mentions', 'Discard']);
  // Discard, then Undo: the text and the chip come back in the composer.
  await state.locator('[data-ch-act="discard"]').click();
  await expect(row).toHaveCount(0);
  const toastEl = win.locator('#toast');
  await expect(toastEl).toContainText('Message discarded');
  await toastEl.locator('button').click();
  await expect(composer(win)).toHaveJSProperty('value', 'Over to @Zoë for review');
  await expect(composer(win).locator(`.ch-chip[data-member="${zoe.id}"]`)).toHaveText('@Zoë');
  // Sent again, refused again, then sent without the mention.
  await composer(win).click();
  await win.keyboard.press('Enter');
  await expect(row.locator('[data-ch-act="without-mentions"]')).toBeVisible({ timeout: 15000 });
  await row.locator('[data-ch-act="without-mentions"]').click();
  await expect(row).toHaveAttribute('data-seq', /^\d+$/, { timeout: 15000 });
  await expect(row.locator('.ch-mention')).toHaveCount(0);
  await expect.poll(async () => (await serverMessages(server, olga, ws.id, ws.general, 'Over to @Zoë for review')).map((e) => e.mentions), { timeout: 15000 }).toEqual([[]]);
});

test('a message written while the server is down waits for a connection and goes once it is back', async () => {
  const { olga, bart, ws } = await twoPeople(server);
  ({ app, win } = await launch(server, { dataDir }));
  await ready(bart);
  await server.stop();
  let row;
  try {
    await write('Written offline');
    row = message(log(), 'Written offline');
    await expect(row).toHaveClass(/is-pending/);
    await expect(row.locator('.ch-state.is-waiting')).toContainText('Waits for a connection', { timeout: 15000 });
    expect(await row.getAttribute('data-seq')).toBeNull();
  } finally {
    await server.start();
  }
  await expect(row).toHaveAttribute('data-seq', /^\d+$/, { timeout: 30000 });
  await expect(row.locator('.ch-state')).toHaveCount(0);
  await expect.poll(async () => (await serverMessages(server, olga, ws.id, ws.general, 'Written offline')).length, { timeout: 15000 }).toBe(1);
});

test('a message held because Bart left and came back before it went offers Send and Discard, and Send posts it once', async () => {
  const { olga, bart, ws } = await twoPeople(server);
  // The retry after the server comes back waits 8 s: time to leave and rejoin first.
  ({ app, win } = await launch(server, { dataDir, env: { SEM_CHAT_RETRY_DELAY: '8000' } }));
  await ready(bart);
  await server.stop();
  let row;
  try {
    await write('Held for a while');
    row = message(log(), 'Held for a while');
    await expect(row.locator('.ch-state.is-waiting')).toBeVisible({ timeout: 15000 });
  } finally {
    await server.start();
  }
  await connected(win);
  // Bart leaves general on another device and joins it again: a new grant. Main's runs wait meanwhile, so the room
  // never shows as left in between (that would drop the message with the room).
  const held = await holdRuns(app);
  const left = await server.call('DELETE', `/v1/workspaces/${ws.id}/channels/${ws.general}/members/me`, { token: bart.token });
  expect(left.status).toBe(204);
  const back = await server.call('POST', `/v1/workspaces/${ws.id}/channels/${ws.general}/join`, { token: bart.token });
  expect(back.status).toBe(200);
  await held.release();
  // The retry goes with the old grant, and the server holds it back.
  await expect(row.locator('.ch-state.is-stale')).toContainText('You left or were taken out of this conversation', { timeout: 30000 });
  await expect(row).toHaveAttribute('data-state', 'held');
  await expect(row.locator('[data-ch-act="send"]')).toHaveText('Send');
  await expect(row.locator('[data-ch-act="discard"]')).toHaveText('Discard');
  expect((await serverMessages(server, olga, ws.id, ws.general, 'Held for a while')).length).toBe(0);
  await row.locator('[data-ch-act="send"]').click();
  await expect(message(log(), 'Held for a while')).toHaveAttribute('data-seq', /^\d+$/, { timeout: 15000 });
  await expect.poll(async () => (await serverMessages(server, olga, ws.id, ws.general, 'Held for a while')).length, { timeout: 15000 }).toBe(1);
});

test('replying in a thread: docked at 1400px, over the log at 900px, the reply in the main log, and Escape back to the message', async () => {
  const { olga, bart, ws } = await twoPeople(server);
  const root = await server.post(olga, ws.id, ws.general, 'Lunch on Friday?');
  ({ app, win } = await launch(server, { dataDir }));
  await ready(bart);
  const top = message(log(), 'Lunch on Friday?');
  await expect(top).toBeVisible({ timeout: 15000 });
  await (await tool(top, 'reply')).click();
  await expect(threadPane()).toBeVisible();
  await expect(pane()).toHaveAttribute('data-thread', 'open');
  // Docked: beside the log, with a close button and no back button.
  await expect(threadPane()).toHaveCSS('position', 'relative');
  await expect(threadPane().locator('.ch-thread-close')).toBeVisible();
  await expect(threadPane().locator('.ch-thread-back')).toBeHidden();
  const mainBox = await win.locator('section.chat .ch-main').boundingBox();
  const threadBox = await threadPane().boundingBox();
  expect(threadBox.x).toBeGreaterThanOrEqual(mainBox.x + mainBox.width - 1);
  await expect(threadPane().locator('.ch-thread-title')).toHaveText('Thread');
  await expect(threadPane().locator('.ch-thread-meta')).toHaveText('in #general');
  await expect(message(threadLog(), 'Lunch on Friday?')).toBeVisible();
  // The focus is in the thread's composer.
  expect(await win.evaluate(() => Boolean(document.activeElement?.matches('.ch-thread .ch-input')))).toBe(true);
  await win.keyboard.type("I'm in");
  await win.keyboard.press('Enter');
  const reply = message(threadLog(), "I'm in");
  await expect(reply).toHaveAttribute('data-seq', /^\d+$/, { timeout: 15000 });
  await expect(threadLog().locator('.ch-thread-div')).toHaveText('1 reply');
  // The reply shows in the main log too, as a reply row with its context, and the first message counts it.
  const inMain = message(log(), "I'm in");
  await expect(inMain).toHaveClass(/is-reply/);
  await expect(inMain.locator('.ch-context')).toHaveText('replied to Olga Owner: Lunch on Friday?');
  await expect(top.locator('.ch-replies-n')).toHaveText('1 reply');
  await expect.poll(async () => (await serverMessages(server, olga, ws.id, ws.general, "I'm in"))[0]?.root, { timeout: 15000 }).toBe(root.messageId);
  // Escape in the thread's composer closes it, and the focus goes back to the first message in the log.
  await win.keyboard.press('Escape');
  await expect(threadPane()).toBeHidden();
  await expect(pane()).toHaveAttribute('data-thread', 'closed');
  expect(await win.evaluate(() => document.activeElement?.dataset?.id || null)).toBe(root.messageId);

  // At 900px the view is narrower than 900px: the thread covers the log, with a back button.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(900, 950));
  await expect.poll(() => win.evaluate(() => window.innerWidth)).toBeLessThan(910);
  await top.locator('.ch-replies').click();
  await expect(threadPane()).toBeVisible();
  await expect(threadPane()).toHaveCSS('position', 'absolute');
  await expect(threadPane().locator('.ch-thread-back')).toBeVisible();
  await expect(threadPane().locator('.ch-thread-back')).toHaveAttribute('aria-label', 'Back to #general');
  await expect(threadPane().locator('.ch-thread-close')).toBeHidden();
  const overlay = await threadPane().boundingBox();
  const under = await win.locator('section.chat .ch-main').boundingBox();
  expect(Math.abs(overlay.x - under.x)).toBeLessThan(2);
  expect(Math.abs(overlay.width - under.width)).toBeLessThan(2);
  await expect(message(threadLog(), "I'm in")).toBeVisible();
  await threadPane().locator('.ch-thread-back').click();
  await expect(threadPane()).toBeHidden();
  expect(await win.evaluate(() => document.activeElement?.dataset?.id || null)).toBe(root.messageId);
});

test('removing a message asks first, shows "Message removed" here, and Olga sees it removed', async () => {
  const { olga, bart, ws } = await twoPeople(server);
  ({ app, win } = await launch(server, { dataDir }));
  await ready(bart);
  await write('A message to take back');
  const row = message(log(), 'A message to take back');
  await expect(row).toHaveAttribute('data-seq', /^\d+$/, { timeout: 15000 });
  const id = await row.getAttribute('data-id');
  await (await tool(row, 'menu')).click();
  const menu = win.locator('.menu');
  await expect(menu.locator('[role="menuitem"]')).toHaveText(['Reply in thread', 'Copy text', 'Remove message']);
  await menu.locator('[role="menuitem"]', { hasText: 'Remove message' }).click();
  const dialog = win.locator('.scrim .dialog');
  await expect(dialog.locator('h2')).toHaveText('Remove this message?');
  await expect(dialog.locator('p')).toHaveText("It's removed for everyone in #general. You can't undo this.");
  await dialog.locator('.buttons button').last().click();
  const removed = log().locator(`li.ch-msg[data-id="${id}"]`);
  await expect(removed.locator('.ch-removed')).toHaveText('Message removed', { timeout: 15000 });
  await expect(removed).toHaveClass(/is-removed/);
  await expect(removed.locator('.ch-name')).toHaveText('Bart');
  await expect.poll(async () => (await serverMessages(server, olga, ws.id, ws.general)).find((e) => e.id === id)?.redacted, { timeout: 15000 }).toBe(true);
  // Someone else's message offers no Remove to a member who doesn't manage the channel; a full member can block its
  // author (contract 5.5).
  await server.post(olga, ws.id, ws.general, 'Olga stays');
  const hers = message(log(), 'Olga stays');
  await expect(hers).toBeVisible({ timeout: 15000 });
  await hers.click({ button: 'right' });
  await expect(menu.locator('[role="menuitem"]')).toHaveText(['Reply in thread', 'Copy text', 'Block Olga Owner']);
  await win.keyboard.press('Escape');
});

test('a thread whose first message is removed swaps its composer for a note', async () => {
  const { olga, bart, ws } = await twoPeople(server);
  const root = await server.post(olga, ws.id, ws.general, 'Topic to discuss');
  await server.post(olga, ws.id, ws.general, 'First answer', { root: root.messageId });
  ({ app, win } = await launch(server, { dataDir }));
  await ready(bart);
  const top = message(log(), 'Topic to discuss');
  await expect(top.locator('.ch-replies-n')).toHaveText('1 reply', { timeout: 15000 });
  await top.locator('.ch-replies').click();
  await expect(message(threadLog(), 'First answer')).toBeVisible();
  await expect(threadPane().locator('.ch-box')).toBeVisible();
  await server.redact(olga, ws.id, ws.general, root.messageId);
  const bar = threadPane().locator('.ch-bar');
  await expect(bar).toBeVisible({ timeout: 15000 });
  await expect(bar.locator('.ch-bar-text')).toHaveText('This message was removed, so nobody can reply to it.');
  await expect(threadPane().locator('.ch-box')).toBeHidden();
  await expect(threadLog().locator(`li.ch-msg[data-id="${root.messageId}"] .ch-removed`)).toHaveText('Message removed');
  // Its replies stay readable, and the summary under the removed message stays.
  await expect(message(threadLog(), 'First answer')).toBeVisible();
  await expect(log().locator(`li.ch-msg[data-id="${root.messageId}"] .ch-replies-n`)).toHaveText('1 reply');
});

test('a draft with a mention survives switching rooms and a restart', async () => {
  const { bart, ws, olga, bartMe } = await twoPeople(server);
  await server.seedChannel(olga, ws.id, { name: 'review', members: [bartMe.id] });
  const zoe = await server.seedMember(ws, await server.seedAccount(), 'Zoë');
  ({ app, win } = await launch(server, { dataDir }));
  await ready(bart);
  await write('Draft for later, @Zo', { send: false });
  await expect(win.locator('.ch-suggest [role="option"] .mention-name').first()).toHaveText('Zoë', { timeout: 10000 });
  await win.keyboard.press('Enter');
  await win.keyboard.type('and more');
  await expect(composer(win)).toHaveJSProperty('value', 'Draft for later, @Zoë and more');
  await roomRow(win, 'review').click();
  await expect(pane().locator('.ch-title')).toHaveText('review');
  await expect(composer(win)).toHaveJSProperty('value', '');
  await roomRow(win, 'general').click();
  await expect(pane().locator('.ch-title')).toHaveText('general');
  await expect(composer(win)).toHaveJSProperty('value', 'Draft for later, @Zoë and more');
  await expect(composer(win).locator(`.ch-chip[data-member="${zoe.id}"]`)).toHaveText('@Zoë');
  await closeApp(app);
  ({ app, win } = await launch(server, { dataDir }));
  await expect(win.locator('.sidebar-mode [data-mode="chat"]')).toHaveAttribute('aria-selected', 'true', { timeout: 15000 });
  await expect(pane().locator('.ch-title')).toHaveText('general', { timeout: 15000 });
  await expect(composer(win)).toHaveJSProperty('value', 'Draft for later, @Zoë and more', { timeout: 15000 });
  await expect(composer(win).locator(`.ch-chip[data-member="${zoe.id}"]`)).toHaveText('@Zoë');
  // Sending it clears the draft for good.
  await composer(win).click();
  await win.keyboard.press('Enter');
  await expect(message(log(), 'Draft for later')).toHaveAttribute('data-seq', /^\d+$/, { timeout: 15000 });
  await closeApp(app);
  ({ app, win } = await launch(server, { dataDir }));
  await expect(pane().locator('.ch-title')).toHaveText('general', { timeout: 15000 });
  await expect(message(log(), 'Draft for later')).toBeVisible({ timeout: 15000 });
  await expect(composer(win)).toHaveJSProperty('value', '');
});
