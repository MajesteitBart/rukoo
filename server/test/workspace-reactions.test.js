// Reactions and marking a message unread (WORKSPACES.md, Rich messages).

import { runDurableObjectAlarm } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  api,
  changes,
  events,
  markUnread,
  newMember,
  newWorkspace,
  post,
  react,
  sync,
  workspaceSql,
  workspaceStub
} from './workspace-helpers.js';

const DAY = 24 * 60 * 60 * 1000;

// A workspace with Olga, its owner, and Mila in general, and one message of Olga's there.
async function room() {
  const ws = await newWorkspace('Acme', 'Olga');
  const mila = await newMember(ws, 'Mila', { channels: [ws.general] });
  const sent = (await post(ws.person, ws.id, ws.general, 'Lunch?')).body;
  return { ws, mila, message: sent.messageId, seq: sent.seq };
}

const roomOf = async (person, id, conversation) => (await sync(person, id)).rooms.get(conversation);
const messageIn = (log, id) => log.events.find((e) => e.id === id);

describe('reactions', () => {
  it('adds and takes back a reaction, once each, as events in the room', async () => {
    const { ws, mila, message, seq } = await room();
    const added = await react(mila.person, ws.id, ws.general, message, '👍');
    expect(added.status).toBe(200);
    expect(added.body).toEqual({ messageId: message, emoji: '👍', on: true, changed: true });
    // The same again changes nothing and appends nothing.
    const head = (await events(ws.person, ws.id, ws.general)).body.head;
    expect((await react(mila.person, ws.id, ws.general, message, '👍')).body).toMatchObject({ changed: false });
    expect((await events(ws.person, ws.id, ws.general)).body.head).toBe(head);

    const taken = await react(mila.person, ws.id, ws.general, message, '👍', false);
    expect(taken.body).toEqual({ messageId: message, emoji: '👍', on: false, changed: true });
    expect((await react(mila.person, ws.id, ws.general, message, '👍', false)).body.changed).toBe(false);

    const log = (await events(ws.person, ws.id, ws.general, `?after=${seq}`)).body.events;
    expect(log).toEqual([
      { seq: seq + 1, id: expect.stringMatching(/^e_/), kind: 'reaction.added', actor: mila.me.id, at: expect.any(Number), target: message, targetSeq: seq, emoji: '👍' },
      { seq: seq + 2, id: expect.stringMatching(/^e_/), kind: 'reaction.removed', actor: mila.me.id, at: expect.any(Number), target: message, targetSeq: seq, emoji: '👍' }
    ]);
  });

  it('carries every reaction on the message, in the order people reacted', async () => {
    const { ws, mila, message } = await room();
    const tess = await newMember(ws, 'Tess', { channels: [ws.general] });
    await react(mila.person, ws.id, ws.general, message, '🎉');
    await react(ws.person, ws.id, ws.general, message, '👍🏽');
    await react(tess.person, ws.id, ws.general, message, '🎉');
    await react(ws.person, ws.id, ws.general, message, '🎉');
    await react(tess.person, ws.id, ws.general, message, '❤️');
    await react(tess.person, ws.id, ws.general, message, '❤️', false);

    const expected = [
      { emoji: '🎉', actors: [mila.me.id, tess.me.id, ws.me.id] },
      { emoji: '👍🏽', actors: [ws.me.id] }
    ];
    // A page of history and the open room's inline events carry the state as it is now.
    expect(messageIn((await events(tess.person, ws.id, ws.general)).body, message).reactions).toEqual(expected);
    const inline = (await changes(tess.person, ws.id, `?active=${ws.general}&roomAfter=0`)).body.inlineEvents;
    expect(messageIn({ events: inline }, message).reactions).toEqual(expected);
    // A message nobody reacted to has an empty list.
    const other = (await post(ws.person, ws.id, ws.general, 'Quiet')).body.messageId;
    expect(messageIn((await events(tess.person, ws.id, ws.general)).body, other)).toMatchObject({ reactions: [], attachments: [], previews: [] });
  });

  it('takes any single emoji and nothing else', async () => {
    const { ws, mila, message } = await room();
    for (const emoji of ['👍', '👨‍👩‍👧', '🏳️‍🌈', '🇳🇱', '❤️', '1️⃣', '👋🏿']) {
      expect((await react(mila.person, ws.id, ws.general, message, emoji)).status, emoji).toBe(200);
    }
    for (const emoji of ['', 'a', ':+1:', '👍👍', '👍 ', '❤', 7, null]) {
      const res = await react(mila.person, ws.id, ws.general, message, emoji);
      expect(res.status, String(emoji)).toBe(400);
      expect(res.body.field).toBe('emoji');
    }
    const res = await api('POST', `/v1/workspaces/${ws.id}/conversations/${ws.general}/messages/${message}/react`, {
      token: mila.person.token,
      body: { emoji: '👍', on: 'yes' }
    });
    expect(res.status).toBe(400);
    expect(res.body.field).toBe('on');
  });

  it('holds a message to twenty different emoji', async () => {
    const { ws, mila, message } = await room();
    const twenty = ['😀', '😁', '😂', '🤣', '😃', '😄', '😅', '😆', '😉', '😊', '😋', '😎', '😍', '😘', '🥰', '😗', '😙', '🥲', '😚', '🙂'];
    for (const emoji of twenty) expect((await react(ws.person, ws.id, ws.general, message, emoji)).status).toBe(200);
    const more = await react(mila.person, ws.id, ws.general, message, '🤔');
    expect(more.status).toBe(409);
    expect(more.body.error).toBe('reaction_limit');
    // One of the twenty still takes more people.
    expect((await react(mila.person, ws.id, ws.general, message, '😀')).body.changed).toBe(true);
    // Taking one away makes room for another.
    await react(ws.person, ws.id, ws.general, message, '🙂', false);
    expect((await react(mila.person, ws.id, ws.general, message, '🤔')).status).toBe(200);
  });

  it('answers 404 for a removed message, a non-message and someone outside the room', async () => {
    const { ws, mila, message } = await room();
    const log = (await events(ws.person, ws.id, ws.general)).body.events;
    const joined = log.find((e) => e.kind === 'member.joined').id;
    expect((await react(mila.person, ws.id, ws.general, joined, '👍')).status).toBe(404);
    const outsider = await newMember(ws, 'Tess');
    await api('DELETE', `/v1/workspaces/${ws.id}/channels/${ws.general}/members/me`, { token: outsider.person.token });
    const out = await react(outsider.person, ws.id, ws.general, message, '👍');
    expect(out.status).toBe(404);
    expect(out.body.scope).toBe('conversation');
    await api('POST', `/v1/workspaces/${ws.id}/conversations/${ws.general}/messages/${message}/redact`, { token: ws.person.token });
    const gone = await react(mila.person, ws.id, ws.general, message, '👍');
    expect(gone.status).toBe(404);
    expect(gone.body.error).toBe('not_found');
  });

  it('refuses reactions in an archived channel', async () => {
    const { ws, mila, message } = await room();
    await api('PATCH', `/v1/workspaces/${ws.id}/channels/${ws.general}`, { token: ws.person.token, body: { archived: true } });
    const res = await react(mila.person, ws.id, ws.general, message, '👍');
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: 'archived', scope: 'conversation' });
  });

  it('never counts as unread or a mention and leaves lastAt alone', async () => {
    const { ws, mila, message } = await room();
    const before = await roomOf(mila.person, ws.id, ws.general);
    expect(before.unread).toBe(1);
    const owner = await roomOf(ws.person, ws.id, ws.general);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await react(mila.person, ws.id, ws.general, message, '👍');
    await react(ws.person, ws.id, ws.general, message, '🎉');
    const after = await roomOf(mila.person, ws.id, ws.general);
    expect(after).toMatchObject({ unread: 1, mentions: 0, lastAt: before.lastAt });
    expect(after.head).toBe(before.head + 2);
    expect(await roomOf(ws.person, ws.id, ws.general)).toMatchObject({ unread: 0, lastAt: owner.lastAt });
  });

  it('goes with its message, by removal or retention, without events', async () => {
    const { ws, mila, message } = await room();
    await react(mila.person, ws.id, ws.general, message, '👍');
    const head = (await events(ws.person, ws.id, ws.general)).body.head;
    await api('POST', `/v1/workspaces/${ws.id}/conversations/${ws.general}/messages/${message}/redact`, { token: ws.person.token });
    expect(await workspaceSql(ws.id, 'SELECT * FROM reaction')).toEqual([]);
    const log = (await events(ws.person, ws.id, ws.general, `?after=${head}`)).body.events;
    expect(log.map((e) => e.kind)).toEqual(['message.redacted']);

    const kept = (await post(ws.person, ws.id, ws.general, 'Old news')).body.messageId;
    await react(mila.person, ws.id, ws.general, kept, '👍');
    expect(await workspaceSql(ws.id, 'SELECT emoji FROM reaction')).toEqual([{ emoji: '👍' }]);
    await workspaceSql(ws.id, 'UPDATE event SET at = ?', Date.now() - 100 * DAY);
    await runDurableObjectAlarm(workspaceStub(ws.id));
    expect(await workspaceSql(ws.id, 'SELECT * FROM reaction')).toEqual([]);
  });
});

describe('marking unread', () => {
  it('moves the read position back to just before the message, and never forward', async () => {
    const { ws, mila, message, seq } = await room();
    const second = (await post(ws.person, ws.id, ws.general, 'Anyone?')).body;
    await api('POST', `/v1/workspaces/${ws.id}/conversations/${ws.general}/read`, { token: mila.person.token, body: { seq: second.seq } });
    const start = await sync(mila.person, ws.id);
    expect(start.rooms.get(ws.general)).toMatchObject({ read: second.seq, readMark: 0, unread: 0 });

    const marked = await markUnread(mila.person, ws.id, ws.general, message);
    expect(marked.status).toBe(200);
    expect(marked.body).toEqual({ read: seq - 1, readMark: 1 });
    // The member's other devices hear of it in the feed, with the counter that says to follow it down.
    const next = await sync(mila.person, ws.id, start.cursor);
    expect(next.rooms.get(ws.general)).toMatchObject({ read: seq - 1, readMark: 1, unread: 2 });

    // Marking the later message would move the position forward: nothing changes.
    expect((await markUnread(mila.person, ws.id, ws.general, second.messageId)).body).toEqual({ read: seq - 1, readMark: 1 });
    // Nor does marking the same message again.
    expect((await markUnread(mila.person, ws.id, ws.general, message)).body).toEqual({ read: seq - 1, readMark: 1 });
    // Reading works as before afterwards.
    expect((await api('POST', `/v1/workspaces/${ws.id}/conversations/${ws.general}/read`, { token: mila.person.token, body: { seq: second.seq } })).body).toEqual({ read: second.seq, readMark: 1 });
    expect((await markUnread(mila.person, ws.id, ws.general, second.messageId)).body).toEqual({ read: second.seq - 1, readMark: 2 });
  });

  it('lets no read from before a mark of unread move the position forward again', async () => {
    const { ws, mila, message, seq } = await room();
    const read = (body) => api('POST', `/v1/workspaces/${ws.id}/conversations/${ws.general}/read`, { token: mila.person.token, body });
    expect((await read({ seq, readMark: 0 })).body).toEqual({ read: seq, readMark: 0 });
    expect((await markUnread(mila.person, ws.id, ws.general, message)).body).toEqual({ read: seq - 1, readMark: 1 });
    // A read the device sent while it knew readMark 0 arrives after the mark: nothing moves.
    expect((await read({ seq, readMark: 0 })).body).toEqual({ read: seq - 1, readMark: 1 });
    expect((await roomOf(mila.person, ws.id, ws.general)).read).toBe(seq - 1);
    // One that knows the mark reads as before, and so does one without readMark.
    expect((await read({ seq, readMark: 1 })).body).toEqual({ read: seq, readMark: 1 });
    await markUnread(mila.person, ws.id, ws.general, message);
    expect((await read({ seq })).body).toEqual({ read: seq, readMark: 2 });
    expect((await read({ seq, readMark: -1 })).body.field).toBe('readMark');
    expect((await read({ seq, readMark: '2' })).body.field).toBe('readMark');
  });

  it('starts a grant made by joining again at readMark 0', async () => {
    const { ws, mila, message, seq } = await room();
    await api('POST', `/v1/workspaces/${ws.id}/conversations/${ws.general}/read`, { token: mila.person.token, body: { seq } });
    await markUnread(mila.person, ws.id, ws.general, message);
    expect((await roomOf(mila.person, ws.id, ws.general)).readMark).toBe(1);
    await api('DELETE', `/v1/workspaces/${ws.id}/channels/${ws.general}/members/me`, { token: mila.person.token });
    await api('POST', `/v1/workspaces/${ws.id}/channels/${ws.general}/join`, { token: mila.person.token });
    expect((await roomOf(mila.person, ws.id, ws.general)).readMark).toBe(0);
  });

  it('stays at or above what the room still holds', async () => {
    const { ws, mila, message } = await room();
    await workspaceSql(ws.id, 'UPDATE conversation SET floor = 50 WHERE id = ?', ws.general);
    await workspaceSql(ws.id, 'UPDATE grants SET readSeq = 60');
    expect((await markUnread(mila.person, ws.id, ws.general, message)).body).toEqual({ read: 49, readMark: 1 });
  });

  it('takes only a message of the conversation', async () => {
    const { ws, mila } = await room();
    const log = (await events(ws.person, ws.id, ws.general)).body.events;
    const created = log.find((e) => e.kind === 'channel.created').id;
    expect((await markUnread(mila.person, ws.id, ws.general, created)).status).toBe(404);
    expect((await markUnread(mila.person, ws.id, ws.general, 'e_short')).body.field).toBe('message');
    const elsewhere = (await api('POST', `/v1/workspaces/${ws.id}/channels`, { token: ws.person.token, body: { name: 'design', visibility: 'workspace' } })).body.channel.id;
    const there = (await post(ws.person, ws.id, elsewhere, 'Here')).body.messageId;
    expect((await markUnread(ws.person, ws.id, ws.general, there)).status).toBe(404);
  });
});
