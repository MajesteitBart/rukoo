'use strict';

// Alerts for direct messages and mentions (src/main/workspaces/notify.js), the rule of contract 3.10, against the
// real account server (test/fixtures/real-server.js). Contract 8.4 lists the cases for chat-notify: DMs and mentions,
// mute, the setting, the room on screen, the first pass, the first run after a start, three rooms and a summary, and
// taking alerts back on a read here and on another device, on a removal and on an eviction. The workspace going and
// the end of the session take them back too.
//
// The history module calls notifier.onRead after this device read a room, and mute is a column it writes; these tests
// do both through the store and the hook, so they test the alerts alone.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startRealServer, realServerAvailable, skipWithoutServer, mention } = require('./fixtures/real-server');
const { attach, chatService, settled, until, sleep, watchCalls } = require('./fixtures/chat-app');
const { chatApi } = require('../src/main/workspaces/ipc');
const { alertText } = require('../src/main/workspaces/notify');
const sync = require('../src/main/workspaces/sync');
const wire = require('../src/main/workspaces/wire');

let server;
test.before(async () => {
  if (realServerAvailable() || process.env.CI || process.env.RUKOO_REQUIRE_REAL_SERVER === '1') server = await startRealServer();
});
test.after(() => server?.close());

const roomKey = (ws, room) => `chat:${ws}:${room}`;
const summaryKey = (ws) => `chat:${ws}:summary`;

// Olga's workspace with Bart in general, Bart's device with its alerts (svc.notices) and what it took back (hidden),
// and the settings it reads. before(olga, ws, bartMe) runs before Bart's device starts.
async function scene(t, { before } = {}) {
  const olga = await server.seedAccount();
  const bart = await server.seedAccount();
  const ws = await server.seedWorkspace(olga, { name: 'Acme', displayName: 'Olga' });
  const bartMe = await server.seedMember(ws, bart, 'Bart');
  if (before) await before(olga, ws, bartMe);
  const settings = { chatNotifications: true };
  const { account, dir } = attach(server, bart);
  const made = device(t, account, dir, settings);
  await settled(made.svc, ws.id);
  return { olga, bart, ws, bartMe, account, dir, settings, ...made };
}

function device(t, account, dir, settings) {
  const svc = chatService(account, dir, { settings: () => settings });
  const hidden = [];
  svc.on('unnotify', (id) => hidden.push(id));
  t.after(() => {
    svc.close();
    account.close();
  });
  return { svc, hidden };
}

const mentioning = (text, actor) => ({ mentions: [mention(text, '@Bart', actor)] });

test('the first pass alerts nothing; a DM message and a mention alert once each', async (t) => {
  if (skipWithoutServer(t)) return;
  const { olga, ws, bartMe, svc } = await scene(t, {
    before: (olga, ws, bartMe) => server.post(olga, ws.id, ws.general, 'Morning @Bart', mentioning('Morning @Bart', bartMe.id))
  });
  assert.deepEqual(svc.notices, []);
  const general = svc.store.getRoom(ws.id, ws.general);
  assert.equal(general.mentions, 1);
  assert.equal(general.notified, general.head, 'the first pass counts as notified');

  const dm = await server.seedDm(olga, ws.id, [bartMe.id]);
  const posted = await server.post(olga, ws.id, dm.conversation, 'Hoi Bart, heb je even?');
  await svc.sync(ws.id);
  assert.deepEqual(svc.notices, [
    {
      id: roomKey(ws.id, dm.conversation),
      title: 'Olga',
      body: 'Olga: Hoi Bart, heb je even?',
      open: { ws: ws.id, conversation: dm.conversation, seq: posted.seq }
    }
  ]);
  assert.deepEqual(svc.store.noticesForRoom(ws.id, dm.conversation), [{ message: posted.messageId, seq: posted.seq }]);
  assert.equal(svc.store.getRoom(ws.id, dm.conversation).notified, posted.seq);

  // A message in general that doesn't mention Bart: general still has the old mention, but nothing new to show.
  await server.post(olga, ws.id, ws.general, 'Lunch?');
  await svc.sync(ws.id);
  assert.equal(svc.notices.length, 1);
  assert.equal(svc.store.getRoom(ws.id, ws.general).notified, svc.store.getRoom(ws.id, ws.general).head);

  // A mention: the text as sent, the first 120 characters.
  const long = `@Bart ${'x'.repeat(150)}`;
  const posted2 = await server.post(olga, ws.id, ws.general, long, mentioning(long, bartMe.id));
  await svc.sync(ws.id);
  assert.equal(svc.notices.length, 2);
  assert.deepEqual(svc.notices[1], {
    id: roomKey(ws.id, ws.general),
    title: '#general',
    body: `Olga: @Bart ${'x'.repeat(114)}…`,
    open: { ws: ws.id, conversation: ws.general, seq: posted2.seq }
  });

  // Nothing new, nothing more.
  await svc.sync(ws.id);
  assert.equal(svc.notices.length, 2);

  // Two new DM messages show together, the older first; Bart's own doesn't count.
  await server.post(olga, ws.id, dm.conversation, 'Eerste');
  const last = await server.post(olga, ws.id, dm.conversation, 'Tweede');
  await svc.sync(ws.id);
  assert.equal(svc.notices.length, 3);
  assert.equal(svc.notices[2].body, 'Olga: Eerste\nOlga: Tweede');
  assert.equal(svc.notices[2].open.seq, last.seq);
  assert.equal(svc.store.noticesForRoom(ws.id, dm.conversation).length, 2, 'the new alert replaced the old one');
});

test('a mention shows as @Name, and the title names a group DM and the workspace when there are several', async (t) => {
  if (skipWithoutServer(t)) return;
  const { olga, ws, bartMe, svc } = await scene(t);
  const mila = await server.seedAccount();
  const sanne = await server.seedAccount();
  const milaMe = await server.seedMember(ws, mila, 'Mila');
  const sanneMe = await server.seedMember(ws, sanne, 'Sanne');
  await svc.sync(ws.id);
  const group = await server.seedDm(olga, ws.id, [bartMe.id, milaMe.id, sanneMe.id]);
  await server.post(olga, ws.id, group.conversation, 'Bart, Mila: kijk even', { mentions: [mention('Bart, Mila: kijk even', 'Bart', bartMe.id)] });
  await svc.sync(ws.id);
  assert.equal(svc.notices.length, 1);
  assert.equal(svc.notices[0].title, 'Olga, Mila and Sanne');
  assert.equal(svc.notices[0].body, 'Olga: @Bart, Mila: kijk even');

  // A second workspace: titles say which workspace.
  await chatApi(() => svc).chatCreateWorkspace({ name: 'Studio', displayName: 'Bart' });
  await server.post(olga, ws.id, group.conversation, 'Nog iets');
  await svc.sync(ws.id);
  assert.equal(svc.notices.length, 2);
  assert.equal(svc.notices[1].title, 'Olga, Mila and Sanne · Acme');

  assert.equal(alertText('Hoi\n\n  daar', []), 'Hoi daar');
  // A range that breaks the rules stays plain text.
  assert.equal(alertText('Zoë', [{ actor: bartMe.id, start: 0, end: 3 }]), 'Zoë');
});

test('mute, the setting and the room on screen keep alerts away, also afterwards', async (t) => {
  if (skipWithoutServer(t)) return;
  const { olga, bart, ws, bartMe, svc, settings, hidden } = await scene(t);
  const dm = (await server.seedDm(olga, ws.id, [bartMe.id])).conversation;
  await svc.sync(ws.id);
  assert.deepEqual(svc.notices, [], 'a DM without messages asks for nothing');

  // Muted: what chatMute stores.
  svc.store.setRoomFields(ws.id, dm, { muted: 1 });
  await server.post(olga, ws.id, dm, 'stil');
  await svc.sync(ws.id);
  assert.deepEqual(svc.notices, []);
  const muted = svc.store.getRoom(ws.id, dm);
  assert.equal(muted.notified, muted.head);
  svc.store.setRoomFields(ws.id, dm, { muted: 0 });
  await svc.sync(ws.id);
  assert.deepEqual(svc.notices, [], 'unmuting brings back no alert');

  // Settings > General > Team chat notifications off, then on again.
  settings.chatNotifications = false;
  await server.post(olga, ws.id, dm, 'uit');
  await svc.sync(ws.id);
  settings.chatNotifications = true;
  await svc.sync(ws.id);
  assert.deepEqual(svc.notices, []);
  assert.equal(svc.state().notifications, true);

  // Chat hidden in Settings > General > Tabs: no alert, and none for that message once Chat shows again.
  settings.hiddenModes = ['chat'];
  await server.post(olga, ws.id, dm, 'verborgen');
  await svc.sync(ws.id);
  assert.deepEqual(svc.notices, [], 'a hidden Chat alerts nothing');
  settings.hiddenModes = [];
  await svc.sync(ws.id);
  assert.deepEqual(svc.notices, [], 'turning Chat on again brings back no old alert');

  // On screen in the focused window.
  svc.setFocused(true);
  svc.setActive({ ws: ws.id, room: dm });
  await server.post(olga, ws.id, dm, 'gezien');
  await svc.sync(ws.id);
  assert.deepEqual(svc.notices, []);

  // Focused on another room: main.js shows a toast when its window has focus too. The alert is recorded all the same,
  // because main.js may find the window unfocused and show a desktop notification, which a read must take back.
  svc.setActive({ ws: ws.id, room: ws.general });
  const toast = await server.post(olga, ws.id, dm, 'toast');
  await svc.sync(ws.id);
  assert.equal(svc.notices.length, 1);
  assert.equal(svc.notices[0].body, 'Olga: toast');
  assert.deepEqual(svc.store.noticesForRoom(ws.id, dm), [{ message: toast.messageId, seq: toast.seq }]);
  await server.read(bart, ws.id, dm, toast.seq);
  await svc.sync(ws.id);
  assert.deepEqual(hidden, [roomKey(ws.id, dm)], 'the read takes it back');
  assert.deepEqual(svc.store.noticesForRoom(ws.id, dm), []);

  // Away from the window: an alert that a read can take back.
  svc.setFocused(false);
  await server.post(olga, ws.id, dm, 'weg');
  await svc.sync(ws.id);
  assert.equal(svc.notices.length, 2);
  assert.equal(svc.store.noticesForRoom(ws.id, dm).length, 1);
});

test('a mention that 20 or more messages followed before the run still alerts, through the summary', async (t) => {
  if (skipWithoutServer(t)) return;
  const { olga, bart, ws, bartMe, svc, hidden } = await scene(t);
  // A second author, as the server lets one member post 30 messages in a burst.
  const mila = await server.seedAccount();
  await server.seedMember(ws, mila, 'Mila');
  await svc.sync(ws.id);
  // Rukoo was closed, or the channel busy: the page of the newest 20 events doesn't reach back to the mention.
  await server.post(olga, ws.id, ws.general, '@Bart look', mentioning('@Bart look', bartMe.id));
  for (let i = 0; i < 25; i++) await server.post(olga, ws.id, ws.general, `chatter ${i}`);
  await svc.sync(ws.id);
  let general = svc.store.getRoom(ws.id, ws.general);
  assert.equal(general.mentions, 1);
  assert.deepEqual(svc.notices, [
    {
      id: summaryKey(ws.id),
      title: 'Team chat',
      body: 'New messages in 1 conversation',
      open: { ws: ws.id, conversation: ws.general, seq: general.head }
    }
  ]);
  assert.equal(general.notified, general.head);
  await svc.sync(ws.id);
  assert.equal(svc.notices.length, 1, 'once');
  await server.read(bart, ws.id, ws.general, general.head);
  await svc.sync(ws.id);
  assert.deepEqual(hidden, [summaryKey(ws.id)]);

  // A page that reaches back to the last alert settles it: an alerted mention and 19 messages after it alert nothing.
  await server.post(olga, ws.id, ws.general, '@Bart again', mentioning('@Bart again', bartMe.id));
  await svc.sync(ws.id);
  assert.equal(svc.notices.length, 2);
  assert.equal(svc.notices[1].id, roomKey(ws.id, ws.general));
  assert.equal(svc.notices[1].body, 'Olga: @Bart again');
  for (let i = 0; i < 19; i++) await server.post(mila, ws.id, ws.general, `more ${i}`);
  await svc.sync(ws.id);
  general = svc.store.getRoom(ws.id, ws.general);
  assert.equal(general.mentions, 1);
  assert.equal(svc.notices.length, 2);
  assert.equal(general.notified, general.head);
});

test('a room beyond three that the cache shows holds no new mention stays out of the summary', async (t) => {
  if (skipWithoutServer(t)) return;
  const { olga, ws, bartMe, svc } = await scene(t);
  const api = chatApi(() => svc);
  const busy = (await server.seedChannel(olga, ws.id, { name: 'busy', members: [bartMe.id] })).id;
  const channels = [];
  for (let i = 1; i <= 4; i++) channels.push((await server.seedChannel(olga, ws.id, { name: `room-${i}`, members: [bartMe.id] })).id);
  await svc.sync(ws.id);
  await server.post(olga, ws.id, busy, '@Bart once', mentioning('@Bart once', bartMe.id));
  await svc.sync(ws.id);
  assert.equal(svc.notices.length, 1, 'the mention in busy alerted');
  // Bart has busy open, unread, in a window without focus: the feed keeps its cache up to head.
  await api.chatOpen(ws.id, busy, { at: 1 });
  assert.ok(!svc.isOnScreen(ws.id, busy));

  // New chatter in busy, then a mention in each of four other rooms: five rooms ask for attention, busy the oldest.
  await server.post(olga, ws.id, busy, 'chatter');
  for (const [i, c] of channels.entries()) {
    const text = `@Bart, room ${i + 1}`;
    await server.post(olga, ws.id, c, text, mentioning(text, bartMe.id));
  }
  await svc.sync(ws.id);
  const room = svc.store.getRoom(ws.id, busy);
  assert.equal(room.mentions, 1);
  assert.equal(room.hi, room.head, 'the cache covers busy');
  assert.equal(room.notified, room.head);
  const fresh = svc.notices.slice(1);
  assert.equal(fresh.filter((n) => n.id !== summaryKey(ws.id)).length, 3);
  assert.ok(!fresh.some((n) => n.open.conversation === busy && n.id !== summaryKey(ws.id)));
  const summary = fresh.find((n) => n.id === summaryKey(ws.id));
  assert.equal(summary.body, 'New messages in 1 conversation', 'only the fourth mention room');
  assert.notEqual(summary.open.conversation, busy);
});

test('the first run after a start alerts what came while Rukoo was closed, once; signing out takes it back', async (t) => {
  if (skipWithoutServer(t)) return;
  const { olga, ws, bartMe, svc, account, dir, settings } = await scene(t);
  const dm = (await server.seedDm(olga, ws.id, [bartMe.id])).conversation;
  await svc.sync(ws.id);
  svc.close();

  await server.post(olga, ws.id, dm, 'while you were away');
  const next = device(t, account, dir, settings);
  await until(() => next.svc.notices.length > 0, 15000, 'the alert of the first run');
  assert.equal(next.svc.notices.length, 1);
  assert.equal(next.svc.notices[0].body, 'Olga: while you were away');
  await next.svc.sync(ws.id);
  await sleep(30);
  assert.equal(next.svc.notices.length, 1);

  await account.signOut();
  assert.deepEqual(next.hidden, [roomKey(ws.id, dm)]);
});

test('three rooms alert and more make one summary, which goes once those rooms are read', async (t) => {
  if (skipWithoutServer(t)) return;
  const { olga, bart, ws, bartMe, svc, hidden } = await scene(t);
  const channels = [];
  for (let i = 1; i <= 5; i++) channels.push((await server.seedChannel(olga, ws.id, { name: `room-${i}`, members: [bartMe.id] })).id);
  await svc.sync(ws.id);
  assert.deepEqual(svc.notices, []);
  const calls = [];
  const real = svc.account.workspaceCall.bind(svc.account);
  svc.account.workspaceCall = (method, path, body) => {
    calls.push(path);
    return real(method, path, body);
  };
  for (const [i, c] of channels.entries()) {
    const text = `@Bart, room ${i + 1}`;
    await server.post(olga, ws.id, c, text, mentioning(text, bartMe.id));
  }
  await svc.sync(ws.id);
  assert.equal(svc.notices.length, 4);
  const single = svc.notices.filter((n) => n.id !== summaryKey(ws.id));
  assert.equal(single.length, 3);
  const shown = single.map((n) => n.open.conversation);
  assert.equal(new Set(shown).size, 3);
  for (const n of single) {
    const i = channels.indexOf(n.open.conversation);
    assert.equal(n.title, `#room-${i + 1}`);
    assert.equal(n.body, `Olga: @Bart, room ${i + 1}`);
  }
  const summary = svc.notices.find((n) => n.id === summaryKey(ws.id));
  assert.equal(summary.title, 'Team chat');
  assert.equal(summary.body, 'New messages in 2 conversations');
  // Messages were loaded for three rooms only.
  assert.equal(calls.filter((p) => p.includes('/events?')).length, 3);
  for (const c of channels) {
    const room = svc.store.getRoom(ws.id, c);
    assert.equal(room.notified, room.head);
  }

  // Bart reads the two summarized rooms on another device: the summary goes.
  const summarized = channels.filter((c) => !shown.includes(c));
  await server.read(bart, ws.id, summarized[0], svc.store.getRoom(ws.id, summarized[0]).head);
  await svc.sync(ws.id);
  assert.ok(!hidden.includes(summaryKey(ws.id)), 'one room is still unread');
  await server.read(bart, ws.id, summarized[1], svc.store.getRoom(ws.id, summarized[1]).head);
  await svc.sync(ws.id);
  assert.deepEqual(hidden, [summaryKey(ws.id)]);
});

test('taking back: a read here and on another device, a removal, an eviction and the workspace going', async (t) => {
  if (skipWithoutServer(t)) return;
  const { olga, bart, ws, bartMe, svc, hidden } = await scene(t);
  const dm = (await server.seedDm(olga, ws.id, [bartMe.id])).conversation;
  await svc.sync(ws.id);
  const key = roomKey(ws.id, dm);
  const alertOnce = async (text, room = dm, extra = {}) => {
    const before = svc.notices.length;
    const posted = await server.post(olga, ws.id, room, text, extra);
    await svc.sync(ws.id);
    assert.equal(svc.notices.length, before + 1, `an alert for ${text}`);
    return posted;
  };

  // A read on this device, as the history module reports it, that doesn't reach the alert leaves it; one that does
  // takes it back.
  const one = await alertOnce('een');
  svc.store.setRoomFields(ws.id, dm, { readLocal: one.seq - 1 });
  svc.notifier.onRead(ws.id, dm);
  assert.deepEqual(hidden, []);
  svc.store.setRoomFields(ws.id, dm, { readLocal: one.seq });
  svc.notifier.onRead(ws.id, dm);
  assert.deepEqual(hidden, [key]);
  assert.deepEqual(svc.store.noticesForRoom(ws.id, dm), []);

  // A read on another device.
  const two = await alertOnce('twee');
  await server.read(bart, ws.id, dm, two.seq);
  await svc.sync(ws.id);
  assert.deepEqual(hidden, [key, key]);

  // Olga removes the message the alert showed.
  const three = await alertOnce('drie');
  await server.redact(olga, ws.id, dm, three.messageId);
  await svc.sync(ws.id);
  assert.deepEqual(hidden, [key, key, key]);
  assert.equal(svc.notices.length, 3, 'the removal alerts nothing');

  // Olga takes Bart out of a channel where she mentioned him.
  const side = (await server.seedChannel(olga, ws.id, { name: 'side', members: [bartMe.id] })).id;
  await svc.sync(ws.id);
  await alertOnce('@Bart hier', side, mentioning('@Bart hier', bartMe.id));
  const out = await server.call('DELETE', `/v1/workspaces/${ws.id}/channels/${side}/members/${bartMe.id}`, { token: olga.token });
  assert.equal(out.status, 204);
  await svc.sync(ws.id);
  assert.equal(svc.store.getRoom(ws.id, side), null);
  assert.deepEqual(hidden.slice(3), [roomKey(ws.id, side)]);

  // Olga removes Bart from the workspace.
  await alertOnce('vijf');
  const removed = await server.call('DELETE', `/v1/workspaces/${ws.id}/members/${bartMe.id}`, { token: olga.token });
  assert.equal(removed.status, 204);
  await svc.sync(ws.id);
  assert.equal(svc.store.getWs(ws.id), null);
  assert.deepEqual(hidden.slice(4), [key]);
});

test('a 410 reset takes back every alert of the workspace, as the removals it missed are unknown', async (t) => {
  if (skipWithoutServer(t)) return;
  const { olga, ws, bartMe, svc, hidden } = await scene(t);
  const dm = (await server.seedDm(olga, ws.id, [bartMe.id])).conversation;
  await svc.sync(ws.id);
  const posted = await server.post(olga, ws.id, dm, 'Soon unknown');
  await svc.sync(ws.id);
  assert.equal(svc.notices.length, 1);
  assert.equal(svc.store.noticesForRoom(ws.id, dm).length, 1);
  // Another member's cursor makes the server answer 410 reset_required.
  const theirs = await server.call('GET', `/v1/workspaces/${ws.id}/changes`, { token: olga.token });
  svc.store.updateWs(ws.id, { cursor: theirs.body.next });
  const outcome = await svc.sync(ws.id);
  assert.ok(!outcome.error, `the run got through: ${outcome.error && outcome.error.code}`);
  assert.deepEqual(hidden, [roomKey(ws.id, dm)]);
  assert.deepEqual(svc.store.noticesForRoom(ws.id, dm), []);
  assert.equal(svc.notices.length, 1, 'the pass after the reset alerts nothing new');
  assert.equal(svc.store.getRoom(ws.id, dm).notified, posted.seq);
});

// Start over, a restore and a new key start a pass from the start, which lists no removals either: an alert may show a
// message removed meanwhile, or one a restored backup lacks, so every alert of the workspace goes with its notice rows.
for (const [what, startPass] of [
  ['Start over', (svc, ws) => chatApi(() => svc).chatReload(ws)],
  [
    'a restore',
    async (svc, ws) => {
      svc.store.updateWs(ws, { generation: 'OldGenerationXXXXXXXXX' });
      await svc.details(ws);
    }
  ],
  [
    'a new key',
    async (svc, ws) => {
      svc.store.updateWs(ws, { keyId: 'an-old-key' });
      await svc.details(ws);
    }
  ]
]) {
  test(`${what} takes back every alert of the workspace`, async (t) => {
    if (skipWithoutServer(t)) return;
    const { olga, ws, bartMe, svc, hidden } = await scene(t);
    const dm = (await server.seedDm(olga, ws.id, [bartMe.id])).conversation;
    await svc.sync(ws.id);
    const posted = await server.post(olga, ws.id, dm, 'Removed after the alert');
    await svc.sync(ws.id);
    assert.equal(svc.notices.length, 1);
    assert.equal(svc.store.noticesForRoom(ws.id, dm).length, 1);
    await server.redact(olga, ws.id, dm, posted.messageId);
    await startPass(svc, ws.id);
    assert.deepEqual(hidden, [roomKey(ws.id, dm)]);
    assert.deepEqual(svc.store.noticesForRoom(ws.id, dm), []);
    await until(() => svc.store.getWs(ws.id).passing === 0 && !svc.runners.get(ws.id).running, 30000, `the pass after ${what}`);
    assert.equal(svc.notices.length, 1, 'the pass alerts nothing new');
    assert.deepEqual(hidden, [roomKey(ws.id, dm)]);
  });
}

// Holds the first answer of a request that match(url) picks, which the server already gave, until release().
function holdFirst(account, match) {
  const held = { waiting: false };
  const gate = new Promise((resolve) => (held.release = resolve));
  let armed = true;
  watchCalls(account, async (method, url, real) => {
    if (!armed || !match(url)) return undefined;
    armed = false;
    const answer = await real();
    held.waiting = true;
    await gate;
    return answer;
  });
  return held;
}

// Contract 3.6, 3.10: the page an alert loads belongs to the cache revision it was asked under. Start over while it
// was on its way drops it: it may hold a message removed meanwhile, which the pass from the start can't list.
test('an alert page that comes after Start over shows nothing, and the pass after it alerts nothing', async (t) => {
  if (skipWithoutServer(t)) return;
  const { olga, ws, bartMe, svc, account, hidden } = await scene(t);
  const dm = (await server.seedDm(olga, ws.id, [bartMe.id])).conversation;
  await svc.sync(ws.id);
  const removed = await server.post(olga, ws.id, dm, 'Removed while the alert loaded');
  const held = holdFirst(account, (url) => url.includes(`/conversations/${dm}/events?`));
  const run = svc.sync(ws.id);
  await until(() => held.waiting, 10000, 'the held alert page');
  await server.redact(olga, ws.id, dm, removed.messageId);
  await chatApi(() => svc).chatReload(ws.id);
  held.release();
  await run;
  await until(() => svc.store.getWs(ws.id).passing === 0 && !svc.runners.get(ws.id).running, 30000, 'the pass after Start over');
  await svc.sync(ws.id);
  assert.deepEqual(svc.notices, []);
  assert.ok(!svc.notifier.shown.has(roomKey(ws.id, dm)));
  assert.deepEqual(svc.store.noticesForRoom(ws.id, dm), []);
  assert.deepEqual(hidden, []);
});

// Contract 3.10: an alert shows messages after where the person read. A read while the page was on its way counts.
test('an alert page leaves out the messages read while it was on its way', async (t) => {
  if (skipWithoutServer(t)) return;
  const { olga, ws, bartMe, svc, account } = await scene(t);
  const dm = (await server.seedDm(olga, ws.id, [bartMe.id])).conversation;
  await svc.sync(ws.id);
  const read = await server.post(olga, ws.id, dm, 'Read meanwhile');
  const unread = await server.post(olga, ws.id, dm, 'Still unread');
  const held = holdFirst(account, (url) => url.includes(`/conversations/${dm}/events?`));
  const run = svc.sync(ws.id);
  await until(() => held.waiting, 10000, 'the held alert page');
  await chatApi(() => svc).chatRead(ws.id, dm, read.seq);
  held.release();
  await run;
  assert.equal(svc.notices.length, 1);
  assert.equal(svc.notices[0].body, 'Olga: Still unread');
  assert.deepEqual(svc.store.noticesForRoom(ws.id, dm), [{ message: unread.messageId, seq: unread.seq }]);
});

// Contract 3.10: retention takes back an alert whose message aged out, by the seq its notice row recorded, also when
// the cache never held that message (the alert loaded it).
test('a floor past a message an alert showed takes the alert back, also when the cache never held it', async (t) => {
  if (skipWithoutServer(t)) return;
  const { olga, ws, bartMe, svc, hidden } = await scene(t);
  const dm = (await server.seedDm(olga, ws.id, [bartMe.id])).conversation;
  await svc.sync(ws.id);
  const gone = await server.post(olga, ws.id, dm, 'Ages out');
  const kept = await server.post(olga, ws.id, dm, 'Stays');
  await svc.sync(ws.id);
  assert.equal(svc.notices.at(-1).body, 'Olga: Ages out\nOlga: Stays');
  assert.equal(svc.store.eventById(ws.id, gone.messageId), null, 'the alert loaded the message; the cache never held it');
  // A feed page with the floor at the kept message: one field of a real answer, as retention can't be made on demand.
  const page = wire.checkChanges(await svc.call(ws.id, 'GET', '/changes?limit=64'));
  const row = page.changes.find((c) => c.conversation === dm);
  const result = sync.applyPage(svc, ws.id, {
    ...page,
    changes: [{ ...row, floor: kept.seq }],
    evictions: [],
    inlineEvents: [],
    next: svc.store.getWs(ws.id).cursor
  });
  await sync.afterPage(svc, ws.id, result);
  assert.equal(svc.store.getRoom(ws.id, dm).floor, kept.seq);
  assert.deepEqual(hidden, [roomKey(ws.id, dm)]);
  assert.deepEqual(svc.store.noticesForRoom(ws.id, dm), []);
});
