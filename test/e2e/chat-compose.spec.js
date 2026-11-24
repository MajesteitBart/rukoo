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

// The member directory loads at the end of a run, after the rooms: on a slow first sign-in the room is on screen, and
// the picker open, before anyone has a name.
test('a directory that comes in late fills the open mention picker and names who made the channel', async () => {
  const { bart, ws } = await twoPeople(server);
  await server.seedMember(ws, await server.seedAccount(), 'Zoë');
  ({ app, win } = await launch(server, { dataDir }));
  await ready(bart);
  const intro = log().locator('.ch-intro .ch-intro-line');
  await expect(intro).toContainText('Olga Owner', { timeout: 15000 });
  // The directory as a first run has it before GET /members answers: none, and stale.
  const held = await holdRuns(app);
  await app.evaluate((_, id) => {
    const svc = global.__semChat;
    svc.store.tx(() => {
      svc.store.replaceMembers(id, []);
      svc.store.updateWs(id, { membersStale: 1 });
    });
    svc.emitChat({ kind: 'directory', ws: id });
  }, ws.id);
  await expect(intro).toContainText('Former member');
  const picker = win.locator('.ch-suggest');
  await write('Hoi @Zo', { send: false });
  await expect(picker.locator('.ch-suggest-none')).toHaveText('Nobody here by that name');
  // The run loads the directory: the picker and the intro take it without another key.
  await held.release();
  await expect(picker.locator('[role="option"] .mention-name').first()).toHaveText('Zoë', { timeout: 15000 });
  await expect(picker.locator('.ch-suggest-none')).toHaveCount(0);
  await expect(intro).toContainText('Olga Owner');
  await win.keyboard.press('Enter');
  await expect(composer(win).locator('.ch-chip')).toHaveText('@Zoë');
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

test('Undo of Discard from another room puts the message after the draft of its room, mentions and all', async () => {
  const { olga, bart, ws, bartMe } = await twoPeople(server);
  await server.seedChannel(olga, ws.id, { name: 'review', members: [bartMe.id] });
  const zoe = await server.seedMember(ws, await server.seedAccount(), 'Zoë');
  const joel = await server.seedMember(ws, await server.seedAccount(), 'Joël');
  ({ app, win } = await launch(server, { dataDir }));
  await ready(bart);
  const picker = win.locator('.ch-suggest [role="option"] .mention-name');
  // A message to Zoë that the server refuses, because she left general before it went.
  await write('Over to @Zo', { send: false });
  await expect(picker.first()).toHaveText('Zoë', { timeout: 10000 });
  await win.keyboard.press('Enter');
  await win.keyboard.type('for review');
  const out = await server.call('DELETE', `/v1/workspaces/${ws.id}/channels/${ws.general}/members/${zoe.id}`, { token: olga.token });
  expect([200, 204]).toContain(out.status);
  await win.keyboard.press('Enter');
  const row = message(log(), 'Over to @Zoë for review');
  await expect(row.locator('[data-ch-act="discard"]')).toBeVisible({ timeout: 15000 });
  // Bart starts a new draft in general, with a mention after accented letters (bytes and UTF-16 differ).
  await write('Één @Jo', { send: false });
  await expect(picker).toHaveText(['Joël'], { timeout: 10000 });
  await win.keyboard.press('Enter');
  await win.keyboard.type('kijk even');
  const draft = 'Één @Joël kijk even';
  await expect(composer(win)).toHaveJSProperty('value', draft);
  // Discard the refused message, go to #review, and Undo there.
  await row.locator('[data-ch-act="discard"]').click();
  await expect(row).toHaveCount(0);
  const toastEl = win.locator('#toast');
  await expect(toastEl).toContainText('Message discarded');
  await roomRow(win, 'review').click();
  await expect(pane().locator('.ch-title')).toHaveText('review');
  await toastEl.locator('button').click();
  // general's draft keeps what Bart wrote, with the message after it on a new line and both ranges in bytes.
  const text = `${draft}\nOver to @Zoë for review`;
  const shift = Buffer.byteLength(`${draft}\nOver to `);
  const joelAt = Buffer.byteLength('Één ');
  await expect
    .poll(() => win.evaluate(([w, c]) => window.mail.call('chatDraft', w, c, null), [ws.id, ws.general]), { timeout: 10000 })
    .toEqual({
      text,
      mentions: [
        { actor: joel.id, start: joelAt, end: joelAt + Buffer.byteLength('@Joël') },
        { actor: zoe.id, start: shift, end: shift + Buffer.byteLength('@Zoë') }
      ],
      // A draft also keeps its files (RUK-211 contract 4.5); this one has none.
      attachments: [],
      expired: 0
    });
  await expect(composer(win)).toHaveJSProperty('value', '');
  await roomRow(win, 'general').click();
  await expect(pane().locator('.ch-title')).toHaveText('general');
  await expect(composer(win)).toHaveJSProperty('value', text);
  await expect(composer(win).locator('.ch-chip')).toHaveText(['@Joël', '@Zoë']);
  await expect(composer(win).locator(`.ch-chip[data-member="${joel.id}"]`)).toHaveCount(1);
  await expect(composer(win).locator(`.ch-chip[data-member="${zoe.id}"]`)).toHaveCount(1);
});

test('a message written while the server is down waits for a connection and goes once it is back', async () => {
  const { olga, bart, ws } = await twoPeople(server);
  ({ app, win } = await launch(server, { dataDir }));
  await ready(bart);
  // The log has loaded: before that a message sent is drawn only once its first page comes, from the server.
  await expect(log().locator('li.ch-intro')).toBeVisible({ timeout: 15000 });
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
  await expect(log().locator('li.ch-intro')).toBeVisible({ timeout: 15000 });
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

test('replying in a thread: docked at 1400px, over the log at 900px, the reply only in the thread, and Escape back to the message', async () => {
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
  // The reply shows only in the thread (issue #376): the first message in the log counts it, without a dot, as it is
  // Bart's own.
  await expect(top.locator('.ch-replies-n')).toHaveText('1 reply');
  await expect(top.locator('.ch-replies')).not.toHaveClass(/has-new/);
  await expect(message(log(), "I'm in")).toHaveCount(0);
  await expect.poll(async () => (await serverMessages(server, olga, ws.id, ws.general, "I'm in"))[0]?.root, { timeout: 15000 }).toBe(root.messageId);
  // Escape in the thread's composer closes it, and the focus goes back to the first message in the log.
  await win.keyboard.press('Escape');
  await expect(threadPane()).toBeHidden();
  await expect(pane()).toHaveAttribute('data-thread', 'closed');
  expect(await win.evaluate(() => document.activeElement?.dataset?.id || null)).toBe(root.messageId);

  // Docked, the conversation beside it stays in reach.
  const covered = win.locator('section.chat .ch-main');
  await expect(covered).toHaveJSProperty('inert', false);

  // At 900px the view is narrower than 900px: the thread covers the log, with a back button.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(900, 950));
  // The width the container query reads: on Windows a shown window's page comes out 16px wider than setSize asks, so
  // innerWidth says too little.
  await expect.poll(() => win.evaluate(() => document.querySelector('section.chat').getBoundingClientRect().width)).toBeLessThan(900);
  await top.locator('.ch-replies').click();
  await expect(threadPane()).toBeVisible();
  await expect(threadPane()).toHaveCSS('position', 'absolute');
  // What it covers leaves the focus order: Shift+Tab from its composer stays out of the conversation under it.
  await expect(covered).toHaveJSProperty('inert', true);
  for (let i = 0; i < 6; i++) {
    await win.keyboard.press('Shift+Tab');
    expect(await win.evaluate(() => Boolean(document.activeElement?.closest('section.chat .ch-main')))).toBe(false);
  }
  await composer(win, { thread: true }).focus();
  // Wide again, it docks and the conversation comes back in reach; narrow, it covers it again.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1400, 950));
  await expect(threadPane()).toHaveCSS('position', 'relative');
  await expect(covered).toHaveJSProperty('inert', false);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(900, 950));
  await expect(threadPane()).toHaveCSS('position', 'absolute');
  await expect(covered).toHaveJSProperty('inert', true);
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
  await expect(covered).toHaveJSProperty('inert', false);
  expect(await win.evaluate(() => document.activeElement?.dataset?.id || null)).toBe(root.messageId);
});

test('a send main refuses after a switch to another room puts its text back in the draft, and one refused while typing on keeps both', async () => {
  const { olga, bart, ws, bartMe } = await twoPeople(server);
  await server.seedChannel(olga, ws.id, { name: 'review', members: [bartMe.id] });
  ({ app, win } = await launch(server, { dataDir }));
  await ready(bart);
  // Test hook: main's chatSend waits for the spec, then refuses as when the message couldn't be written to disk.
  const hold = () =>
    app.evaluate(() => {
      const outbox = global.__semChat.outbox;
      delete global.__refuseSend;
      outbox.send = () =>
        new Promise((_, reject) => {
          global.__refuseSend = () => {
            delete outbox.send;
            reject(Object.assign(new Error('not saved'), { code: 'not_saved' }));
          };
        });
    });
  const waiting = () => expect.poll(() => app.evaluate(() => typeof global.__refuseSend)).toBe('function');
  const draftOf = () => win.evaluate(([w, c]) => window.mail.call('chatDraft', w, c, null).then((d) => (d ? d.text : null)), [ws.id, ws.general]);

  await hold();
  await write('Keep this message, please');
  await expect(composer(win)).toHaveJSProperty('value', '');
  await waiting();
  // Bart goes on to review before main answers; the refusal still keeps the text, in general's draft.
  await roomRow(win, 'review').click();
  await expect(pane().locator('.ch-title')).toHaveText('review');
  await app.evaluate(() => global.__refuseSend());
  await expect.poll(draftOf, { timeout: 10000 }).toBe('Keep this message, please');
  await roomRow(win, 'general').click();
  await expect(pane().locator('.ch-title')).toHaveText('general');
  await expect(composer(win)).toHaveJSProperty('value', 'Keep this message, please', { timeout: 10000 });

  // Refused while Bart writes the next one: the refused text comes back first, then what he wrote since.
  await hold();
  await composer(win).click();
  await win.keyboard.press('End');
  await win.keyboard.press('Enter');
  await expect(composer(win)).toHaveJSProperty('value', '');
  await waiting();
  await win.keyboard.type('Next one');
  await app.evaluate(() => global.__refuseSend());
  await expect(composer(win)).toHaveJSProperty('value', 'Keep this message, please\nNext one');
  await expect.poll(draftOf, { timeout: 10000 }).toBe('Keep this message, please\nNext one');
  expect(await serverMessages(server, olga, ws.id, ws.general, 'Keep this message, please')).toHaveLength(0);
});

test('a late send answer for a composer that left keeps the draft written in the room since, taken or refused', async () => {
  const { olga, bart, ws, bartMe } = await twoPeople(server);
  await server.seedChannel(olga, ws.id, { name: 'review', members: [bartMe.id] });
  ({ app, win } = await launch(server, { dataDir }));
  await ready(bart);
  // Test hook: main's chatSend waits for the spec, then takes the message (sends it as usual) or refuses it.
  const hold = () =>
    app.evaluate(() => {
      const outbox = global.__semChat.outbox;
      delete global.__answerSend;
      const real = outbox.send;
      outbox.send = (...args) =>
        new Promise((resolve, reject) => {
          global.__answerSend = (ok) => {
            delete outbox.send;
            if (ok) resolve(real.apply(outbox, args));
            else reject(Object.assign(new Error('not saved'), { code: 'not_saved' }));
          };
        });
    });
  const waiting = () => expect.poll(() => app.evaluate(() => typeof global.__answerSend)).toBe('function');
  const draftOf = () => win.evaluate(([w, c]) => window.mail.call('chatDraft', w, c, null).then((d) => (d ? d.text : null)), [ws.id, ws.general]);
  // Bart writes a draft that gets saved, sends it while main holds the send, goes to review and back, and writes a new
  // draft over the one the send left behind before main answers.
  const sendAndRewrite = async (sent, next) => {
    await hold();
    await write(sent, { send: false });
    await expect.poll(draftOf, { timeout: 10000 }).toBe(sent);
    await win.keyboard.press('Enter');
    await expect(composer(win)).toHaveJSProperty('value', '');
    await waiting();
    await roomRow(win, 'review').click();
    await expect(pane().locator('.ch-title')).toHaveText('review');
    await roomRow(win, 'general').click();
    await expect(pane().locator('.ch-title')).toHaveText('general');
    await expect(composer(win)).toHaveJSProperty('value', sent, { timeout: 10000 });
    await composer(win).click();
    await win.keyboard.press('ControlOrMeta+a');
    await win.keyboard.type(next);
    await expect.poll(draftOf, { timeout: 10000 }).toBe(next);
  };

  // Taken: the message goes and the newer draft stays, in the composer and on disk.
  await sendAndRewrite('First message', 'Newer draft');
  await app.evaluate(() => global.__answerSend(true));
  await expect.poll(() => serverMessages(server, olga, ws.id, ws.general, 'First message').then((l) => l.length), { timeout: 15000 }).toBe(1);
  await expect(message(log(), 'First message')).toHaveAttribute('data-seq', /^\d+$/, { timeout: 15000 });
  await expect(composer(win)).toHaveJSProperty('value', 'Newer draft');
  expect(await draftOf()).toBe('Newer draft');

  // Refused: the refused text comes back before the newer draft, and both are saved.
  await composer(win).click();
  await win.keyboard.press('ControlOrMeta+a');
  await win.keyboard.press('Backspace');
  await sendAndRewrite('Second message', 'Latest draft');
  await app.evaluate(() => global.__answerSend(false));
  await expect(composer(win)).toHaveJSProperty('value', 'Second message\nLatest draft', { timeout: 10000 });
  await expect.poll(draftOf, { timeout: 10000 }).toBe('Second message\nLatest draft');
  expect(await serverMessages(server, olga, ws.id, ws.general, 'Second message')).toHaveLength(0);
});

test('Enter on a link in a message with replies opens the link, and Enter on the message opens its thread', async () => {
  const { olga, bart, ws } = await twoPeople(server);
  const root = await server.post(olga, ws.id, ws.general, 'The agenda is at https://example.com/agenda');
  await server.post(olga, ws.id, ws.general, 'Looks good', { root: root.messageId });
  ({ app, win } = await launch(server, { dataDir }));
  await ready(bart);
  await app.evaluate(({ shell }) => {
    global.__opened = [];
    shell.openExternal = async (url) => {
      global.__opened.push(url);
    };
  });
  const top = message(log(), 'The agenda is at');
  await expect(top.locator('.ch-replies-n')).toHaveText('1 reply', { timeout: 15000 });
  await top.locator('a.ch-link').focus();
  await win.keyboard.press('Enter');
  await expect.poll(() => app.evaluate(() => global.__opened)).toEqual(['https://example.com/agenda']);
  await expect(threadPane()).toBeHidden();
  await top.focus();
  await win.keyboard.press('Enter');
  await expect(threadPane()).toBeVisible();
  await expect(message(threadLog(), 'Looks good')).toBeVisible();
});

test('a removal confirmation closes when access to its channel goes, and removes nothing', async () => {
  const { olga, bart, ws, bartMe } = await twoPeople(server);
  const review = await server.seedChannel(olga, ws.id, { name: 'review', members: [bartMe.id] });
  const made = await server.call('PATCH', `/v1/workspaces/${ws.id}/channels/${review.id}/members/${bartMe.id}`, { token: olga.token, body: { role: 'manager' } });
  expect(made.status).toBe(200);
  await server.post(olga, ws.id, review.id, 'Olga wrote this');
  ({ app, win } = await launch(server, { dataDir }));
  await ready(bart);
  await roomRow(win, 'review').click();
  const hers = message(log(), 'Olga wrote this');
  await expect(hers).toBeVisible({ timeout: 15000 });
  // As a manager of review Bart may remove Olga's message: the confirmation quotes it.
  await hers.click({ button: 'right' });
  await win.locator('.menu [role="menuitem"]', { hasText: 'Remove message' }).click();
  const dialog = win.locator('.scrim .dialog');
  await expect(dialog.locator('h2')).toHaveText('Remove this message?');
  await expect(dialog.locator('.ch-remove-quote')).toHaveText('“Olga wrote this”');
  // Olga takes Bart out of review: the conversation goes, and its confirmation with what it quotes.
  const out = await server.call('DELETE', `/v1/workspaces/${ws.id}/channels/${review.id}/members/${bartMe.id}`, { token: olga.token });
  expect([200, 204]).toContain(out.status);
  await expect(pane().locator('[data-ch-empty="gone-ok"]')).toBeVisible({ timeout: 15000 });
  await expect(win.locator('.scrim')).toHaveCount(0);
  await expect(win.getByText('Olga wrote this')).toHaveCount(0);
  expect((await serverMessages(server, olga, ws.id, review.id, 'Olga wrote this')).length).toBe(1);
});

test('the mention picker drops someone taken out of the channel and offers who came in, the member count the same', async () => {
  const { olga, bart, ws, bartMe } = await twoPeople(server);
  const zoe = await server.seedMember(ws, await server.seedAccount(), 'Zoë');
  const yan = await server.seedMember(ws, await server.seedAccount(), 'Yannick');
  const review = await server.seedChannel(olga, ws.id, { name: 'review', members: [bartMe.id, zoe.id] });
  ({ app, win } = await launch(server, { dataDir }));
  await ready(bart);
  await roomRow(win, 'review').click();
  await expect(pane().locator('.ch-title')).toHaveText('review');
  const offered = () => win.locator('.ch-suggest [role="option"] .mention-name').allTextContents().then((names) => names.sort());
  await write('@', { send: false });
  await expect.poll(offered, { timeout: 10000 }).toEqual(['Olga Owner', 'Zoë']);
  await win.keyboard.press('Escape');
  await expect(win.locator('.ch-suggest')).toHaveCount(0);
  // Olga swaps Zoë for Yannick: review still has three members.
  const removed = await server.call('DELETE', `/v1/workspaces/${ws.id}/channels/${review.id}/members/${zoe.id}`, { token: olga.token });
  expect([200, 204]).toContain(removed.status);
  const added = await server.call('POST', `/v1/workspaces/${ws.id}/channels/${review.id}/members`, { token: olga.token, body: { member: yan.id } });
  expect([200, 201, 204]).toContain(added.status);
  await expect(log().locator('li.ch-sys', { hasText: 'Yannick' })).toBeVisible({ timeout: 15000 });
  await expect(pane().locator('.ch-members-n')).toHaveText('3');
  await composer(win).focus();
  await win.keyboard.press('End');
  await win.keyboard.type(' @');
  await expect.poll(offered, { timeout: 10000 }).toEqual(['Olga Owner', 'Yannick']);
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
  await expect(menu.locator('[role="menuitem"]')).toHaveText(['Reply in thread', 'Copy text', 'Mark unread', 'Remove message']);
  await menu.locator('[role="menuitem"]', { hasText: 'Remove message' }).click();
  const dialog = win.locator('.scrim .dialog');
  await expect(dialog.locator('h2')).toHaveText('Remove this message?');
  // The message is quoted first, as on Android, so it's clear which one goes.
  await expect(dialog.locator('p')).toHaveText(['“A message to take back”', "It's removed for everyone in #general. You can't undo this."]);
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
  await expect(menu.locator('[role="menuitem"]')).toHaveText(['Reply in thread', 'Copy text', 'Mark unread', 'Message Olga Owner', 'Block Olga Owner']);
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

// Start over empties the cache, and its pass from the start lists no removals: an open thread drops what it showed and
// loads again, so a reply removed on the server before it leaves the thread too (contract 3.6, 3.14). The room loads
// again only the range it showed, and the thread's first messages are more than a page older than that, so only the
// thread's own load can bring the removal.
test('an open thread loads again after Start over, without a reply removed before it', async () => {
  test.setTimeout(90000);
  const { olga, bart, ws } = await twoPeople(server);
  const root = await server.post(olga, ws.id, ws.general, 'Plans for the offsite');
  const gone = await server.post(olga, ws.id, ws.general, 'Reply removed while away', { root: root.messageId });
  // More than a page of messages after it, from four more people, as each one's send lane allows a burst of 30.
  const others = [];
  for (const name of ['Ann', 'Ben', 'Cas', 'Dee']) {
    const person = await server.seedAccount();
    await server.seedMember(ws, person, name);
    others.push(person);
  }
  await Promise.all(others.map(async (person, n) => {
    for (let i = 0; i < 27; i++) await server.post(person, ws.id, ws.general, `Filler ${n}.${i}`);
  }));
  const stays = await server.post(olga, ws.id, ws.general, 'Reply that stays', { root: root.messageId });
  ({ app, win } = await launch(server, { dataDir }));
  await ready(bart);
  await expect(message(log(), 'Filler 0.26')).toBeVisible({ timeout: 15000 });
  await expect(message(log(), 'Plans for the offsite')).toHaveCount(0);
  // A reply shows only in its thread (issue #376), and its first message isn't loaded: the pill for new replies opens
  // the thread at it, which pages back for its first message and the older reply.
  await expect(message(log(), 'Reply that stays')).toHaveCount(0);
  const pill = pane().locator('.ch-jump.is-thread');
  // Only the loaded reply counts: the older one is more than a page up.
  await expect(pill).toHaveText('1 new reply in a thread', { timeout: 15000 });
  await pill.click();
  await expect(threadLog().locator(`li.ch-msg[data-seq="${stays.seq}"]`)).toBeVisible({ timeout: 15000 });
  await expect(pill).toBeHidden();
  await expect(message(threadLog(), 'Plans for the offsite')).toBeVisible({ timeout: 15000 });
  await expect(message(threadLog(), 'Reply removed while away')).toBeVisible();
  await expect(message(threadLog(), 'Reply that stays')).toBeVisible();
  // Removed on the server while this device doesn't run: the thread still shows it.
  await holdRuns(app);
  await server.redact(olga, ws.id, ws.general, gone.messageId);
  await win.waitForTimeout(1500);
  await expect(message(threadLog(), 'Reply removed while away')).toBeVisible();
  await win.evaluate((id) => window.mail.call('chatReload', id), ws.id);
  await expect(message(threadLog(), 'Reply removed while away')).toHaveCount(0, { timeout: 15000 });
  await expect(threadPane()).toBeVisible();
  await expect(message(threadLog(), 'Plans for the offsite')).toBeVisible({ timeout: 15000 });
  await expect(message(threadLog(), 'Reply that stays')).toBeVisible();
  await expect(threadLog().locator(`li.ch-msg[data-id="${gone.messageId}"] .ch-removed`)).toHaveText('Message removed');
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
  await expect(win.locator('.titlebar-modes [data-mode="chat"]')).toHaveAttribute('aria-selected', 'true', { timeout: 15000 });
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
