'use strict';

// Alerts for conversations this device has never synced (src/main/workspaces/notify.js, contract 3.10), against the
// real account server: someone starts a DM or a group DM with you, adds you to a channel and mentions you there, or a
// member who joined after Rukoo started writes to you. Each arrives the way it does in the app: a wake on the socket
// while Rukoo runs with its window away, the first run after Rukoo starts, and the window hiding in the tray with a
// conversation on screen. A workspace joined on another device has a first pass that alerts nothing, also for the
// messages that came before it; the next message alerts.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startRealServer, realServerAvailable, skipWithoutServer, mention } = require('./fixtures/real-server');
const { attach, chatService, settled, until, sleep } = require('./fixtures/chat-app');

let server;
test.before(async () => {
  if (realServerAvailable() || process.env.CI || process.env.RUKOO_REQUIRE_REAL_SERVER === '1') server = await startRealServer();
});
test.after(() => server?.close());

const roomKey = (ws, room) => `chat:${ws}:${room}`;
const FAST = { socketBackoff: [100, 200, 400, 800, 1600, 3200, 6000], syncBackoff: [100, 200, 400, 800, 1600] };

// Olga's workspace with Bart in general, and Bart's device: with a real wake socket when socket is true, else runs
// happen only when the test asks.
async function scene(t, { socket = false } = {}) {
  const olga = await server.seedAccount();
  const bart = await server.seedAccount();
  const ws = await server.seedWorkspace(olga, { name: 'Acme', displayName: 'Olga' });
  const bartMe = await server.seedMember(ws, bart, 'Bart');
  const settings = { chatNotifications: true };
  const { account, dir } = attach(server, bart);
  const made = device(t, account, dir, settings, socket);
  await settled(made.svc, ws.id);
  if (socket) await until(() => made.svc.socketState(ws.id) === 'open', 10000, 'the socket to open');
  return { olga, bart, ws, bartMe, account, dir, settings, ...made };
}

function device(t, account, dir, settings, socket = false) {
  const svc = chatService(account, dir, { settings: () => settings, timing: FAST, WebSocket: socket ? globalThis.WebSocket : null });
  t.after(() => {
    svc.close();
    account.close();
  });
  return { svc };
}

const mentioning = (text, needle, actor) => ({ mentions: [mention(text, needle, actor)] });

test('a DM, a group DM and a channel this device never saw alert their first message, woken by the socket', async (t) => {
  if (skipWithoutServer(t)) return;
  const { olga, ws, bartMe, svc } = await scene(t, { socket: true });
  assert.deepEqual(svc.notices, []);

  // Olga starts a DM: the room comes in empty and alerts nothing, its first message alerts.
  const dm = await server.seedDm(olga, ws.id, [bartMe.id]);
  await until(() => svc.store.getRoom(ws.id, dm.conversation), 10000, 'the new DM on this device');
  await sleep(300);
  assert.deepEqual(svc.notices, [], 'an empty DM asks for nothing');
  const first = await server.post(olga, ws.id, dm.conversation, 'Hoi Bart, nieuw gesprek');
  await until(() => svc.notices.length === 1, 10000, 'the alert of the first DM message');
  assert.deepEqual(svc.notices[0], {
    id: roomKey(ws.id, dm.conversation),
    title: 'Olga',
    body: 'Olga: Hoi Bart, nieuw gesprek',
    open: { ws: ws.id, conversation: dm.conversation, seq: first.seq }
  });

  // Mila joins the workspace after Bart's device started and writes to him first: the directory she isn't in yet
  // loads in the same run, so the alert names her.
  const mila = await server.seedAccount();
  const milaMe = await server.seedMember(ws, mila, 'Mila');
  const own = await server.seedDm(mila, ws.id, [bartMe.id]);
  await server.post(mila, ws.id, own.conversation, 'Hoi, ik ben Mila');
  await until(() => svc.notices.length === 2, 10000, 'the alert of a new member\'s first DM');
  assert.equal(svc.notices[1].id, roomKey(ws.id, own.conversation));
  assert.equal(svc.notices[1].title, 'Mila');
  assert.equal(svc.notices[1].body, 'Mila: Hoi, ik ben Mila');

  // A group DM started and written to.
  const group = await server.seedDm(mila, ws.id, [bartMe.id, ws.me.id]);
  await server.post(mila, ws.id, group.conversation, 'Met z\'n drieën');
  await until(() => svc.notices.length === 3, 10000, 'the alert of a new group DM');
  assert.equal(svc.notices[2].id, roomKey(ws.id, group.conversation));
  assert.equal(svc.notices[2].title, 'Olga and Mila');

  // Added to a private channel and mentioned there.
  const design = await server.seedChannel(olga, ws.id, { name: 'design', visibility: 'private', members: [bartMe.id, milaMe.id] });
  const text = '@Bart kijk je even mee?';
  await server.post(olga, ws.id, design.id, text, mentioning(text, '@Bart', bartMe.id));
  await until(() => svc.notices.length === 4, 10000, 'the alert of a mention in a new channel');
  assert.equal(svc.notices[3].id, roomKey(ws.id, design.id));
  assert.equal(svc.notices[3].title, '#design');
  assert.equal(svc.notices[3].body, 'Olga: @Bart kijk je even mee?');

  // Added to a channel without a mention: unread, but no alert, as for any channel.
  const quiet = await server.seedChannel(olga, ws.id, { name: 'quiet', members: [bartMe.id] });
  await server.post(olga, ws.id, quiet.id, 'Gewoon een bericht');
  await until(() => (svc.store.getRoom(ws.id, quiet.id) || {}).unread === 1, 10000, 'the new channel with its message');
  await sleep(500);
  assert.equal(svc.notices.length, 4);
});

test('conversations started while Rukoo was closed alert at the first run after it starts', async (t) => {
  if (skipWithoutServer(t)) return;
  const { olga, ws, bartMe, svc, account, dir, settings } = await scene(t);
  svc.close();

  const dm = await server.seedDm(olga, ws.id, [bartMe.id]);
  await server.post(olga, ws.id, dm.conversation, 'Terwijl je weg was');
  const channel = await server.seedChannel(olga, ws.id, { name: 'launch', members: [bartMe.id] });
  const text = 'Welkom @Bart';
  await server.post(olga, ws.id, channel.id, text, mentioning(text, '@Bart', bartMe.id));

  const next = device(t, account, dir, settings);
  await until(() => next.svc.notices.length === 2, 15000, 'the alerts of the first run');
  assert.deepEqual(next.svc.notices.map((n) => n.id).sort(), [roomKey(ws.id, dm.conversation), roomKey(ws.id, channel.id)].sort());
  await next.svc.sync(ws.id);
  await sleep(30);
  assert.equal(next.svc.notices.length, 2, 'once');
});

test('with the window hidden in the tray, the conversation that was on screen and new ones alert', async (t) => {
  if (skipWithoutServer(t)) return;
  const { olga, ws, bartMe, svc } = await scene(t);
  // The main window has focus with general on screen.
  svc.setFocused(true);
  svc.setActive({ ws: ws.id, room: ws.general });
  const text = '@Bart hier?';
  await server.post(olga, ws.id, ws.general, text, mentioning(text, '@Bart', bartMe.id));
  await svc.sync(ws.id);
  assert.deepEqual(svc.notices, [], 'the room on screen with focus');

  // Close to the tray: main.js turns the window's hide into setFocused(false); the room stays the active one.
  svc.setFocused(false);
  const again = '@Bart nog steeds?';
  await server.post(olga, ws.id, ws.general, again, mentioning(again, '@Bart', bartMe.id));
  const dm = await server.seedDm(olga, ws.id, [bartMe.id]);
  await server.post(olga, ws.id, dm.conversation, 'Even apart');
  await svc.sync(ws.id);
  assert.deepEqual(svc.notices.map((n) => n.id).sort(), [roomKey(ws.id, ws.general), roomKey(ws.id, dm.conversation)].sort());
  assert.equal(svc.notices.find((n) => n.id === roomKey(ws.id, ws.general)).body, 'Olga: @Bart nog steeds?');
});

test('a workspace joined on another device alerts nothing in its first pass here, and its next message alerts', async (t) => {
  if (skipWithoutServer(t)) return;
  const { olga, bart, svc } = await scene(t);
  // Bart joins Studio on his phone; Olga welcomes him before this computer lists his workspaces again.
  const studio = await server.seedWorkspace(olga, { name: 'Studio', displayName: 'Olga' });
  const bartStudio = await server.seedMember(studio, bart, 'Bart');
  const dm = await server.seedDm(olga, studio.id, [bartStudio.id]);
  await server.post(olga, studio.id, dm.conversation, 'Welkom in Studio');

  await svc.syncNow();
  await settled(svc, studio.id);
  assert.equal(svc.store.getRoom(studio.id, dm.conversation).unread, 1, 'the DM shows as unread');
  assert.deepEqual(svc.notices, [], 'the first pass of a workspace alerts nothing, also a message from after the join');

  const next = await server.post(olga, studio.id, dm.conversation, 'Ben je er al?');
  await svc.sync(studio.id);
  assert.equal(svc.notices.length, 1);
  assert.equal(svc.notices[0].title, 'Olga · Studio');
  assert.equal(svc.notices[0].body, 'Olga: Ben je er al?', 'only what came after the first pass');
  assert.equal(svc.notices[0].open.seq, next.seq);
});
