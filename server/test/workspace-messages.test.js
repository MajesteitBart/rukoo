// Messages and the feed devices sync from: sending and retrying, history, mentions, threads, redaction, read
// positions, cursors and retention (WORKSPACES.md, Messaging and sync). These are the vectors for WK-4 and for the
// parts of WK-7 a server can show without a client.

import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { toBase64url } from '../src/bytes.js';
import { random } from './helpers.js';
import {
  api,
  changes,
  channels,
  events,
  newMember,
  newWorkspace,
  post,
  send,
  sync,
  uuidv7,
  workspaceSql,
  workspaceStub
} from './workspace-helpers.js';

const DAY = 24 * 60 * 60 * 1000;
const bytes = (text) => new TextEncoder().encode(text).length;

describe('sending', () => {
  it('orders messages and answers a retry with the first result', async () => {
    const ws = await newWorkspace();
    const operationId = uuidv7();
    const first = await send(ws.person, ws.id, ws.general, { operationId, text: 'one' });
    expect(first.status).toBe(201);
    expect(first.body).toEqual({ operationId, messageId: expect.stringMatching(/^e_[A-Za-z0-9_-]{22}$/), seq: 3 });

    // The answer was lost and the device sends again: same message, nothing new.
    const retry = await send(ws.person, ws.id, ws.general, { operationId, text: 'one' });
    expect(retry.status).toBe(200);
    expect(retry.body).toEqual(first.body);
    const second = await post(ws.person, ws.id, ws.general, 'two');
    expect(second.body.seq).toBe(4);
    const log = (await events(ws.person, ws.id, ws.general)).body;
    expect(log.events.filter((e) => e.kind === 'message.posted').map((e) => [e.seq, e.text])).toEqual([
      [3, 'one'],
      [4, 'two']
    ]);
    expect(log).toMatchObject({ head: 4, floor: 1, more: false });
    expect(log.events[2]).toEqual({ seq: 3, id: first.body.messageId, kind: 'message.posted', actor: ws.me.id, at: expect.any(Number), text: 'one', mentions: [] });

    // The same id with other words is a conflict, not a second message.
    const changed = await send(ws.person, ws.id, ws.general, { operationId, text: 'one, edited' });
    expect(changed.status).toBe(409);
    expect(changed.body.error).toBe('operation_conflict');
    // Another member may use the same id: it is theirs.
    const member = await newMember(ws, 'Mila', { channels: [ws.general] });
    expect((await send(member.person, ws.id, ws.general, { operationId, text: 'mine' })).status).toBe(201);
  });

  it('finds a message by its operation id after the id became too old to send', async () => {
    const ws = await newWorkspace();
    const old = uuidv7(Date.now() - 31 * DAY);
    // A device held this message for a month.
    const late = await send(ws.person, ws.id, ws.general, { operationId: old, text: 'late' });
    expect(late.status).toBe(409);
    expect(late.body.error).toBe('submission_expired');
    const lookup = (operationId) =>
      api('GET', `/v1/workspaces/${ws.id}/conversations/${ws.general}/operations/${operationId}`, { token: ws.person.token });
    expect((await lookup(old)).status).toBe(404);

    // One that did arrive, 29 days ago by its id, is still answered as a retry and can be looked up.
    const operationId = uuidv7(Date.now() - 29 * DAY);
    const sent = await send(ws.person, ws.id, ws.general, { operationId, text: 'made it' });
    expect(sent.status).toBe(201);
    expect((await lookup(operationId)).body).toEqual({ messageId: sent.body.messageId, seq: sent.body.seq, visible: true });
    await api('POST', `/v1/workspaces/${ws.id}/conversations/${ws.general}/messages/${sent.body.messageId}/redact`, { token: ws.person.token });
    expect((await lookup(operationId)).body.visible).toBe(false);
    // Someone else's operation isn't there to find.
    const member = await newMember(ws, 'Mila', { channels: [ws.general] });
    const theirs = await api('GET', `/v1/workspaces/${ws.id}/conversations/${ws.general}/operations/${operationId}`, { token: member.person.token });
    expect(theirs.status).toBe(404);

    const ahead = await send(ws.person, ws.id, ws.general, { operationId: uuidv7(Date.now() + 10 * 60 * 1000), text: 'from the future' });
    expect(ahead.status).toBe(400);
    expect(ahead.body.field).toBe('operationId');
  });

  it('checks what a message may be', async () => {
    const ws = await newWorkspace();
    const bad = async (body, field) => {
      const res = await send(ws.person, ws.id, ws.general, { operationId: uuidv7(), text: 'ok', ...body });
      expect(res.status, JSON.stringify(body).slice(0, 80)).toBe(400);
      expect(res.body.field).toBe(field);
    };
    await bad({ text: '' }, 'text');
    await bad({ text: 7 }, 'text');
    await bad({ text: 'x'.repeat(16385) }, 'text');
    await bad({ text: 'é'.repeat(8193) }, 'text');
    await bad({ text: 'half \ud83d' }, 'text');
    await bad({ operationId: 'not-a-uuid' }, 'operationId');
    await bad({ operationId: '0189f7a0-0000-4000-8000-000000000000' }, 'operationId');
    await bad({ operationId: uuidv7().toUpperCase() }, 'operationId');
    await bad({ root: 'e_short' }, 'root');
    // Exactly 16 KiB is fine, and the text comes back as sent, not normalized.
    expect((await send(ws.person, ws.id, ws.general, { operationId: uuidv7(), text: 'x'.repeat(16384) })).status).toBe(201);
    const raw = '  é  \r\n\ttabs  ';
    const kept = await send(ws.person, ws.id, ws.general, { operationId: uuidv7(), text: raw });
    const log = (await events(ws.person, ws.id, ws.general, `?after=${kept.body.seq - 1}`)).body.events;
    expect(log[0].text).toBe(raw);
  });

  it('holds a workspace to its storage limit and frees room when messages go', async () => {
    const ws = await newWorkspace();
    const sent = await post(ws.person, ws.id, ws.general, 'x'.repeat(1000));
    expect((await workspaceSql(ws.id, 'SELECT bytes FROM workspace'))[0].bytes).toBe(1000);
    await workspaceSql(ws.id, 'UPDATE workspace SET bytes = ?', 1073741824 - 10);
    const full = await post(ws.person, ws.id, ws.general, 'eleven bytes');
    expect(full.status).toBe(413);
    expect(full.body).toMatchObject({ error: 'quota', scope: 'workspace' });
    expect((await post(ws.person, ws.id, ws.general, 'ten bytes!')).status).toBe(201);
    await workspaceSql(ws.id, 'UPDATE workspace SET bytes = 1010');
    await api('POST', `/v1/workspaces/${ws.id}/conversations/${ws.general}/messages/${sent.body.messageId}/redact`, { token: ws.person.token });
    expect((await workspaceSql(ws.id, 'SELECT bytes FROM workspace'))[0].bytes).toBe(10);
  });
});

describe('history', () => {
  it('pages forward from a sequence and backward from the newest', async () => {
    const ws = await newWorkspace();
    for (let i = 1; i <= 7; i++) await post(ws.person, ws.id, ws.general, `m${i}`);
    // Sequences 1 and 2 are the channel being made and its maker joining.
    const page = (query) => events(ws.person, ws.id, ws.general, query);
    const first = (await page('?limit=4')).body;
    expect(first.events.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(first).toMatchObject({ head: 9, more: true });
    const rest = (await page('?after=4&limit=100')).body;
    expect(rest.events.map((e) => e.seq)).toEqual([5, 6, 7, 8, 9]);
    expect(rest.more).toBe(false);

    const newest = (await page('?before=10&limit=3')).body;
    expect(newest.events.map((e) => e.text)).toEqual(['m5', 'm6', 'm7']);
    expect(newest.more).toBe(true);
    const older = (await page('?before=7&limit=100')).body;
    expect(older.events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(older.more).toBe(false);

    expect((await page('?after=2&before=5')).status).toBe(400);
    expect((await page('?limit=101')).status).toBe(400);
    expect((await page('?after=-1')).status).toBe(400);
  });

  // A grant starts at its member.joined event, but joining a channel gives its earlier history: someone who left and
  // came back reads what was said before, while they were away and since, under the new grant (contract 3.6).
  it('gives someone who left a channel and came back its whole history', async () => {
    const ws = await newWorkspace();
    const mila = await newMember(ws, 'Mila', { channels: [ws.general] });
    const priv = (await api('POST', `/v1/workspaces/${ws.id}/channels`, { token: ws.person.token, body: { name: 'design', visibility: 'private' } })).body.channel.id;
    const add = () => api('POST', `/v1/workspaces/${ws.id}/channels/${priv}/members`, { token: ws.person.token, body: { member: mila.me.id } });
    expect((await add()).status).toBe(200);

    const texts = (body) => body.events.filter((e) => e.kind === 'message.posted').map((e) => e.text);
    for (const [room, rejoin, leave] of [
      [ws.general, () => api('POST', `/v1/workspaces/${ws.id}/channels/${ws.general}/join`, { token: mila.person.token }), mila.person],
      [priv, add, ws.person]
    ]) {
      await post(ws.person, ws.id, room, 'before');
      const first = (await sync(mila.person, ws.id)).rooms.get(room);
      const out = await api('DELETE', `/v1/workspaces/${ws.id}/channels/${room}/members/${leave === mila.person ? 'me' : mila.me.id}`, { token: leave.token });
      expect(out.status).toBe(204);
      await post(ws.person, ws.id, room, 'while away');
      expect((await events(mila.person, ws.id, room)).status).toBe(404);
      expect([200, 201]).toContain((await rejoin()).status);
      await post(ws.person, ws.id, room, 'after');

      const row = (await sync(mila.person, ws.id)).rooms.get(room);
      expect(row.grant).not.toBe(first.grant);
      expect(row.floor).toBe(1);
      const page = (await events(mila.person, ws.id, room, `?before=${row.head + 1}&limit=50`)).body;
      expect(page).toMatchObject({ head: row.head, floor: 1, more: false });
      expect(page.events[0].seq).toBe(1);
      expect(texts(page)).toEqual(['before', 'while away', 'after']);
      // Forward paging from the floor and the open room's inline events see the same history.
      expect(texts((await events(mila.person, ws.id, room, '?after=0&limit=50')).body)).toEqual(['before', 'while away', 'after']);
      const inline = (await changes(mila.person, ws.id, `?active=${room}&roomAfter=0`)).body.inlineEvents;
      expect(texts({ events: inline })).toEqual(['before', 'while away', 'after']);
      // The read position starts at the new member.joined, so only what came after it is unread.
      const joined = page.events.findLast((e) => e.kind === 'member.joined' && e.member === mila.me.id);
      expect(row.read).toBe(joined.seq);
      expect(row.unread).toBe(1);
    }
  });
});

describe('mentions and threads', () => {
  it('takes mentions as byte ranges of people in the conversation', async () => {
    const ws = await newWorkspace('Acme', 'Olga');
    const mila = await newMember(ws, 'Mila', { channels: [ws.general] });
    const outsider = await newMember(ws, 'Tess');
    // Tess got general on joining the workspace. Out of it again, she is an outsider there.
    await api('DELETE', `/v1/workspaces/${ws.id}/channels/${ws.general}/members/me`, { token: outsider.person.token });
    const text = 'Héé @Mila, kijk 👀 @Olga';
    const at = (needle) => ({ start: bytes(text.slice(0, text.indexOf(needle))), end: bytes(text.slice(0, text.indexOf(needle) + needle.length)) });
    const mentions = [
      { actor: mila.me.id, ...at('@Mila') },
      { actor: ws.me.id, ...at('@Olga') }
    ];
    const sent = await send(ws.person, ws.id, ws.general, { operationId: uuidv7(), text, mentions });
    expect(sent.status).toBe(201);
    const stored = (await events(mila.person, ws.id, ws.general, `?after=${sent.body.seq - 1}`)).body.events[0];
    expect(stored.mentions).toEqual(mentions);
    // The ranges cut the names out of the text's bytes.
    const raw = new TextEncoder().encode(stored.text);
    expect(new TextDecoder().decode(raw.slice(mentions[0].start, mentions[0].end))).toBe('@Mila');

    // Mila has a mention waiting; the sender doesn't get one for naming themselves.
    expect((await sync(mila.person, ws.id)).rooms.get(ws.general)).toMatchObject({ unread: 1, mentions: 1 });
    expect((await sync(ws.person, ws.id)).rooms.get(ws.general)).toMatchObject({ unread: 0, mentions: 0 });

    const bad = async (list) => {
      const res = await send(ws.person, ws.id, ws.general, { operationId: uuidv7(), text, mentions: list });
      expect(res.status, JSON.stringify(list)).toBe(400);
      expect(res.body.field).toBe('mentions');
    };
    // Someone who isn't in the channel, someone who doesn't exist, a range inside "é", past the end, out of order.
    await bad([{ actor: outsider.me.id, ...at('@Mila') }]);
    await bad([{ actor: 'u_AAAAAAAAAAAAAAAAAAAAAA', ...at('@Mila') }]);
    await bad([{ actor: mila.me.id, start: 2, end: 5 }]);
    await bad([{ actor: mila.me.id, start: 0, end: bytes(text) + 1 }]);
    await bad([mentions[1], mentions[0]]);
    await bad([{ actor: mila.me.id, start: 3, end: 3 }]);
    await bad('everyone');

    // Once she has left the channel she can't be mentioned there.
    await api('DELETE', `/v1/workspaces/${ws.id}/channels/${ws.general}/members/me`, { token: mila.person.token });
    await bad([{ actor: mila.me.id, ...at('@Mila') }]);
  });

  it('threads a reply under a top-level message only', async () => {
    const ws = await newWorkspace();
    const top = await post(ws.person, ws.id, ws.general, 'topic');
    const reply = await post(ws.person, ws.id, ws.general, 'reply', { root: top.body.messageId });
    expect(reply.status).toBe(201);
    const log = (await events(ws.person, ws.id, ws.general, `?after=${top.body.seq}`)).body.events;
    expect(log[0]).toMatchObject({ text: 'reply', root: top.body.messageId });

    const other = (await api('POST', `/v1/workspaces/${ws.id}/channels`, { token: ws.person.token, body: { name: 'other', visibility: 'workspace' } })).body.channel.id;
    const elsewhere = await post(ws.person, ws.id, other, 'elsewhere');
    const bad = async (root) => {
      const res = await post(ws.person, ws.id, ws.general, 'x', { root });
      expect(res.status).toBe(400);
      expect(res.body.field).toBe('root');
    };
    await bad(reply.body.messageId);
    await bad(elsewhere.body.messageId);
    await bad('e_AAAAAAAAAAAAAAAAAAAAAA');
    await api('POST', `/v1/workspaces/${ws.id}/conversations/${ws.general}/messages/${top.body.messageId}/redact`, { token: ws.person.token });
    await bad(top.body.messageId);
  });
});

describe('removing a message', () => {
  it('is for its author and the channel manager, and takes the text away for everyone', async () => {
    const ws = await newWorkspace();
    const mila = await newMember(ws, 'Mila', { channels: [ws.general] });
    const tess = await newMember(ws, 'Tess', { channels: [ws.general] });
    const hers = await post(mila.person, ws.id, ws.general, 'a typo', { mentions: [] });
    const redact = (person, message) =>
      api('POST', `/v1/workspaces/${ws.id}/conversations/${ws.general}/messages/${message}/redact`, { token: person.token });

    expect((await redact(tess.person, hers.body.messageId)).status).toBe(403);
    expect((await redact(mila.person, 'e_AAAAAAAAAAAAAAAAAAAAAA')).status).toBe(404);
    const done = await redact(mila.person, hers.body.messageId);
    expect(done.body).toEqual({ messageId: hers.body.messageId, redacted: true });
    // Asking again is the same answer and no second event.
    expect((await redact(mila.person, hers.body.messageId)).status).toBe(200);

    const log = (await events(tess.person, ws.id, ws.general, `?after=${hers.body.seq - 1}`)).body.events;
    expect(log).toEqual([
      { seq: hers.body.seq, id: hers.body.messageId, kind: 'message.posted', actor: mila.me.id, at: expect.any(Number), redacted: true },
      { seq: hers.body.seq + 1, id: expect.any(String), kind: 'message.redacted', actor: mila.me.id, at: expect.any(Number), target: hers.body.messageId, targetSeq: hers.body.seq }
    ]);
    // Nothing of the text is left in the database either.
    const row = await workspaceSql(ws.id, 'SELECT text, data, size FROM event WHERE seq = ? AND conversation = (SELECT n FROM conversation WHERE id = ?)', hers.body.seq, ws.general);
    expect(row[0]).toEqual({ text: null, data: null, size: 0 });

    // The manager removes someone else's message.
    const theirs = await post(tess.person, ws.id, ws.general, 'off topic');
    expect((await redact(ws.person, theirs.body.messageId)).status).toBe(200);
    // A removed mention no longer counts.
    const pinged = await send(tess.person, ws.id, ws.general, { operationId: uuidv7(), text: '@Mila', mentions: [{ actor: mila.me.id, start: 0, end: 5 }] });
    expect((await sync(mila.person, ws.id)).rooms.get(ws.general).mentions).toBe(1);
    await redact(tess.person, pinged.body.messageId);
    expect((await sync(mila.person, ws.id)).rooms.get(ws.general)).toMatchObject({ mentions: 0, unread: 0 });
  });
});

describe('the feed', () => {
  it('starts a device with every room it is in, then tells it only what changed', async () => {
    const ws = await newWorkspace();
    const mila = await newMember(ws, 'Mila', { channels: [ws.general] });
    const start = await sync(mila.person, ws.id);
    expect([...start.rooms.values()]).toEqual([
      {
        conversation: ws.general,
        kind: 'channel',
        name: 'general',
        visibility: 'workspace',
        archived: false,
        grant: expect.stringMatching(/^g_/),
        role: 'member',
        members: 2,
        head: 3,
        floor: 1,
        lastAt: expect.any(Number),
        read: 3,
        unread: 0,
        mentions: 0,
        removed: [],
        removedMore: false
      }
    ]);
    expect(start.last.directory).toEqual({ members: true, channels: true, blocks: true });
    expect(start.cursor).toMatch(/^[A-Za-z0-9_-]{40,}$/);

    // Nothing happened: nothing to tell, and the cursor still works.
    const quiet = await sync(mila.person, ws.id, start.cursor);
    expect(quiet.rooms.size).toBe(0);
    expect(quiet.last).toMatchObject({ changes: [], evictions: [], inlineEvents: [], directory: { members: false, channels: false }, more: false });

    await post(ws.person, ws.id, ws.general, 'one');
    await post(ws.person, ws.id, ws.general, 'two');
    const next = await sync(mila.person, ws.id, quiet.cursor);
    expect(next.rooms.get(ws.general)).toMatchObject({ head: 5, read: 3, unread: 2 });
    // The sender's own position moved with their message; nothing is unread for them.
    expect((await sync(ws.person, ws.id)).rooms.get(ws.general)).toMatchObject({ head: 5, read: 5, unread: 0 });

    // A channel made meanwhile reaches the member's directory flag, not their rooms.
    await api('POST', `/v1/workspaces/${ws.id}/channels`, { token: ws.person.token, body: { name: 'new', visibility: 'workspace' } });
    const flagged = await sync(mila.person, ws.id, next.cursor);
    expect(flagged.rooms.size).toBe(0);
    expect(flagged.last.directory).toEqual({ members: false, channels: true, blocks: false });
  });

  it('brings the open conversation its new events with the same answer', async () => {
    const ws = await newWorkspace();
    const mila = await newMember(ws, 'Mila', { channels: [ws.general] });
    const start = await sync(mila.person, ws.id);
    for (let i = 1; i <= 3; i++) await post(ws.person, ws.id, ws.general, `m${i}`);
    const page = await changes(mila.person, ws.id, `?after=${start.cursor}&active=${ws.general}&roomAfter=3`);
    expect(page.body.inlineEvents.map((e) => [e.seq, e.text])).toEqual([
      [4, 'm1'],
      [5, 'm2'],
      [6, 'm3']
    ]);
    expect(page.body.changes[0]).toMatchObject({ head: 6, unread: 3 });
    // At most 20 come along; the rest is the events route's.
    for (let i = 0; i < 22; i++) await post(ws.person, ws.id, ws.general, `bulk ${i}`);
    const many = await changes(mila.person, ws.id, `?after=${page.body.next}&active=${ws.general}&roomAfter=6`);
    expect(many.body.inlineEvents.map((e) => e.seq)).toEqual(Array.from({ length: 20 }, (_, i) => 7 + i));
    // A room the caller isn't in brings nothing, and says nothing.
    const hidden = (await api('POST', `/v1/workspaces/${ws.id}/channels`, { token: ws.person.token, body: { name: 'board', visibility: 'private' } })).body.channel.id;
    await post(ws.person, ws.id, hidden, 'secret');
    const probe = await changes(mila.person, ws.id, `?after=${many.body.next}&active=${hidden}&roomAfter=0`);
    expect(probe.status).toBe(200);
    expect(probe.body.inlineEvents).toEqual([]);
    expect(probe.body.changes).toEqual([]);
  });

  it('keeps a read position per member, forward only, across their devices', async () => {
    const ws = await newWorkspace();
    const mila = await newMember(ws, 'Mila', { channels: [ws.general] });
    for (let i = 0; i < 5; i++) await post(ws.person, ws.id, ws.general, `m${i}`);
    const read = (seq) => api('POST', `/v1/workspaces/${ws.id}/conversations/${ws.general}/read`, { token: mila.person.token, body: { seq } });
    const phone = await sync(mila.person, ws.id);
    expect(phone.rooms.get(ws.general)).toMatchObject({ head: 8, read: 3, unread: 5 });

    expect((await read(6)).body).toEqual({ read: 6 });
    // The other device learns of it without a new message.
    const desktop = await sync(mila.person, ws.id, phone.cursor);
    expect(desktop.rooms.get(ws.general)).toMatchObject({ read: 6, unread: 2 });
    // Never backward, never past what exists.
    expect((await read(4)).body).toEqual({ read: 6 });
    expect((await read(999)).body).toEqual({ read: 8 });
    expect((await sync(mila.person, ws.id, desktop.cursor)).rooms.get(ws.general)).toMatchObject({ read: 8, unread: 0 });
    // Nobody else's position moved.
    expect((await sync(ws.person, ws.id)).rooms.get(ws.general).read).toBe(8);
    expect((await read(-1)).status).toBe(400);
    expect((await read('3')).status).toBe(400);
  });

  it('tells a device which messages to drop, and only those', async () => {
    const ws = await newWorkspace();
    const mila = await newMember(ws, 'Mila', { channels: [ws.general] });
    const kept = await post(ws.person, ws.id, ws.general, 'keep');
    const gone = await post(ws.person, ws.id, ws.general, 'drop');
    const start = await sync(mila.person, ws.id);
    await api('POST', `/v1/workspaces/${ws.id}/conversations/${ws.general}/messages/${gone.body.messageId}/redact`, { token: ws.person.token });

    const next = await sync(mila.person, ws.id, start.cursor);
    expect(next.rooms.get(ws.general)).toMatchObject({ removed: [gone.body.messageId], removedMore: false, floor: 1 });
    expect(next.rooms.get(ws.general).removed).not.toContain(kept.body.messageId);
    // Told once: the next page has nothing to remove.
    await post(ws.person, ws.id, ws.general, 'later');
    expect((await sync(mila.person, ws.id, next.cursor)).rooms.get(ws.general).removed).toEqual([]);
    // A device that was away for both still hears of the removal.
    expect((await sync(mila.person, ws.id, start.cursor)).rooms.get(ws.general).removed).toEqual([gone.body.messageId]);
  });

  it('says so when more was removed than it lists', async () => {
    const ws = await newWorkspace();
    const start = await sync(ws.person, ws.id);
    // 66 redactions since the device last looked, written straight into the feed: sending that many messages in a
    // moment is what the send limit stops.
    const ids = await runInDurableObject(workspaceStub(ws.id), (instance, state) => {
      const sql = state.storage.sql;
      const c = sql.exec('SELECT n FROM conversation WHERE id = ?', ws.general).one().n;
      const made = [];
      for (let i = 0; i < 66; i++) {
        const id = random(16);
        const rev = sql.exec('UPDATE workspace SET rev = rev + 1 WHERE id = 1 RETURNING rev').one().rev;
        sql.exec('INSERT INTO removal (conversation, rev, id, at) VALUES (?, ?, ?, ?)', c, rev, id.buffer, Date.now());
        sql.exec('UPDATE conversation SET rev = ? WHERE n = ?', rev, c);
        made.push(`e_${toBase64url(id)}`);
      }
      return made;
    });
    const room = (await sync(ws.person, ws.id, start.cursor)).rooms.get(ws.general);
    expect(room.removed).toEqual(ids.slice(0, 64));
    expect(room.removedMore).toBe(true);
  });

  it('evicts a member from a room they lost, and from nothing else', async () => {
    const ws = await newWorkspace();
    const mila = await newMember(ws, 'Mila', { channels: [ws.general] });
    const side = (await api('POST', `/v1/workspaces/${ws.id}/channels`, { token: ws.person.token, body: { name: 'side', visibility: 'private' } })).body.channel.id;
    const start = await sync(mila.person, ws.id);
    expect(start.evictions).toEqual([]);

    await api('DELETE', `/v1/workspaces/${ws.id}/channels/${ws.general}/members/${mila.me.id}`, { token: ws.person.token });
    const after = await sync(mila.person, ws.id, start.cursor);
    expect(after.evictions).toEqual([ws.general]);
    expect(after.rooms.size).toBe(0);
    // The private channel she never was in is nowhere in what she gets.
    expect(JSON.stringify(after.last)).not.toContain(side);

    // Let back in, the room returns under a new grant and the eviction is gone.
    await api('POST', `/v1/workspaces/${ws.id}/channels/${ws.general}/join`, { token: mila.person.token });
    const back = await sync(mila.person, ws.id, start.cursor);
    expect(back.evictions).toEqual([]);
    expect(back.rooms.get(ws.general).grant).not.toBe(start.rooms.get(ws.general).grant);
    // A pass from the start lists no evictions: rooms it doesn't return are gone.
    await api('DELETE', `/v1/workspaces/${ws.id}/channels/${ws.general}/members/me`, { token: mila.person.token });
    const fresh = await sync(mila.person, ws.id, back.cursor);
    expect(fresh.evictions).toEqual([ws.general]);
  });

  it('covers every room across pages, also one that changes while a device is paging', async () => {
    const ws = await newWorkspace();
    const made = [ws.general];
    for (let i = 0; i < 6; i++) {
      made.push((await api('POST', `/v1/workspaces/${ws.id}/channels`, { token: ws.person.token, body: { name: `room-${i}`, visibility: 'workspace' } })).body.channel.id);
    }
    const mila = await newMember(ws, 'Mila', { channels: made });
    const whole = await sync(mila.person, ws.id, null, 2);
    expect(whole.pages).toBe(4);
    expect([...whole.rooms.keys()].sort()).toEqual([...made].sort());

    // WK-7: more rooms than fit a page, a redaction in the last room, a post in the first, a pause between pages.
    const last = made.at(-1);
    const doomed = await post(ws.person, ws.id, last, 'will go');
    const base = await sync(mila.person, ws.id, null, 100);
    for (const room of made) await post(ws.person, ws.id, room, 'tick');
    const first = await changes(mila.person, ws.id, `?after=${base.cursor}&limit=2`);
    expect(first.body.more).toBe(true);
    const seen = new Map(first.body.changes.map((room) => [room.conversation, room]));
    await api('POST', `/v1/workspaces/${ws.id}/conversations/${last}/messages/${doomed.body.messageId}/redact`, { token: ws.person.token });
    await post(ws.person, ws.id, made[0], 'tock');
    const rest = await sync(mila.person, ws.id, first.body.next, 2);
    for (const [id, room] of rest.rooms) seen.set(id, room);
    expect([...seen.keys()].sort()).toEqual([...made].sort());
    // The page boundary didn't pass the redaction, and the first room came back with its newer state.
    expect(seen.get(last).removed).toEqual([doomed.body.messageId]);
    expect(seen.get(made[0]).head).toBe((await sync(mila.person, ws.id)).rooms.get(made[0]).head);
    // Finished: the cursor certifies everything, so nothing more comes.
    expect((await sync(mila.person, ws.id, rest.cursor)).rooms.size).toBe(0);
  });

  it('binds a cursor to its member and its workspace generation', async () => {
    const ws = await newWorkspace();
    const mila = await newMember(ws, 'Mila', { channels: [ws.general] });
    const mine = await sync(ws.person, ws.id);
    const reset = async (person, cursor) => {
      const res = await changes(person, ws.id, `?after=${cursor}`);
      expect(res.status).toBe(410);
      expect(res.body).toMatchObject({ error: 'reset_required', scope: 'workspace' });
    };
    // Someone else's cursor, one that was tampered with, and one that never was a cursor.
    await reset(mila.person, mine.cursor);
    await reset(ws.person, `${mine.cursor.slice(0, -2)}${mine.cursor.endsWith('AA') ? 'BB' : 'AA'}`);
    await reset(ws.person, 'A'.repeat(60));
    expect((await changes(ws.person, ws.id, '?after=not%20a%20cursor')).status).toBe(400);
    // A cursor doesn't show the workspace's revision counter.
    expect(mine.cursor).not.toMatch(/^[0-9]+$/);
    const again = await sync(ws.person, ws.id);
    expect(again.cursor).not.toBe(mine.cursor);

    // After a restore the generation differs, and every device starts over.
    await workspaceSql(ws.id, "UPDATE workspace SET generation = 'restored'");
    await reset(ws.person, mine.cursor);
  });

  it('notices a workspace that went back in time', async () => {
    const ws = await newWorkspace();
    await post(ws.person, ws.id, ws.general, 'seen by the device');
    const seen = await sync(ws.person, ws.id);
    // The database is rolled back to before that message.
    await workspaceSql(ws.id, 'UPDATE workspace SET rev = rev - 3');
    const res = await changes(ws.person, ws.id, `?after=${seen.cursor}`);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: 'history_regressed', scope: 'workspace' });
  });
});

describe('retention', () => {
  it('removes old messages, raises the floor and leaves the rest of the room alone', async () => {
    const ws = await newWorkspace();
    const mila = await newMember(ws, 'Mila', { channels: [ws.general] });
    const old = await post(ws.person, ws.id, ws.general, 'ninety-one days old');
    const young = await post(ws.person, ws.id, ws.general, 'from yesterday');
    const start = await sync(mila.person, ws.id);
    // Everything up to the old message happened 91 days ago.
    await workspaceSql(ws.id, 'UPDATE event SET at = ? WHERE seq <= ?', Date.now() - 91 * DAY, old.body.seq);
    await runInDurableObject(workspaceStub(ws.id), (instance) => instance.alarm());

    const log = (await events(mila.person, ws.id, ws.general)).body;
    expect(log.floor).toBe(old.body.seq + 1);
    expect(log.events.map((e) => e.seq)).toEqual([young.body.seq]);
    expect((await workspaceSql(ws.id, 'SELECT bytes FROM workspace'))[0].bytes).toBe(bytes('from yesterday'));
    // A device hears the new floor and nothing about dropping the room.
    const room = (await sync(mila.person, ws.id, start.cursor)).rooms.get(ws.general);
    expect(room).toMatchObject({ floor: old.body.seq + 1, head: young.body.seq, removed: [], removedMore: false });
    // The alarm set itself again for tomorrow.
    const alarm = await runInDurableObject(workspaceStub(ws.id), (instance, state) => state.storage.getAlarm());
    expect(alarm - Date.now()).toBeGreaterThan(23 * 60 * 60 * 1000);
    expect(await runDurableObjectAlarm(workspaceStub(ws.id))).toBe(true);
  });

  it('collects an archived channel once its history is gone, and frees its place', async () => {
    const ws = await newWorkspace();
    const made = await api('POST', `/v1/workspaces/${ws.id}/channels`, { token: ws.person.token, body: { name: 'done', visibility: 'workspace' } });
    const done = made.body.channel.id;
    await post(ws.person, ws.id, done, 'last words');
    await api('PATCH', `/v1/workspaces/${ws.id}/channels/${done}`, { token: ws.person.token, body: { archived: true } });
    const start = await sync(ws.person, ws.id);
    await workspaceSql(ws.id, 'UPDATE event SET at = ? WHERE conversation = (SELECT n FROM conversation WHERE id = ?)', Date.now() - 91 * DAY, done);
    await runInDurableObject(workspaceStub(ws.id), (instance) => instance.alarm());

    expect(await workspaceSql(ws.id, 'SELECT id FROM conversation WHERE id = ?', done)).toEqual([]);
    expect((await channels(ws.person, ws.id)).map((c) => c.name)).toEqual(['general']);
    expect((await sync(ws.person, ws.id, start.cursor)).evictions).toEqual([done]);
    expect((await events(ws.person, ws.id, done)).status).toBe(404);
  });

  it('asks a device that was away longer than the feed remembers to start over', async () => {
    const ws = await newWorkspace();
    const mila = await newMember(ws, 'Mila', { channels: [ws.general] });
    const sent = await post(ws.person, ws.id, ws.general, 'x');
    const stale = await sync(mila.person, ws.id);
    await api('POST', `/v1/workspaces/${ws.id}/conversations/${ws.general}/messages/${sent.body.messageId}/redact`, { token: ws.person.token });
    const recent = await sync(mila.person, ws.id);
    // Fifteen days pass: the feed forgets that redaction.
    await workspaceSql(ws.id, 'UPDATE removal SET at = ?', Date.now() - 15 * DAY);
    await runInDurableObject(workspaceStub(ws.id), (instance) => instance.alarm());
    expect(await workspaceSql(ws.id, 'SELECT * FROM removal')).toEqual([]);

    const away = await changes(mila.person, ws.id, `?after=${stale.cursor}`);
    expect(away.status).toBe(410);
    expect(away.body.error).toBe('reset_required');
    // A device that already heard of it carries on.
    expect((await changes(mila.person, ws.id, `?after=${recent.cursor}`)).status).toBe(200);
  });
});
