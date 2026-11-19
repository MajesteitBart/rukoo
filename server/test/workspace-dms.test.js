// Direct messages and blocks: who may start a DM, the one open DM per set of people, how a DM closes and when it is
// deleted, and what a block does (WORKSPACES.md, Gate 1 routes: Direct messages and Blocks).

import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { call, signup } from './helpers.js';
import {
  api,
  block,
  blocks,
  channels,
  events,
  fillers,
  guest,
  invite,
  leaveDm,
  newMember,
  newWorkspace,
  openDmLane,
  post,
  send,
  startDm,
  sync,
  unblock,
  uuidv7,
  workspaceSql,
  workspaceStub
} from './workspace-helpers.js';

const DAY = 24 * 60 * 60 * 1000;
const NOBODY = 'u_AAAAAAAAAAAAAAAAAAAAAA';
const UNAVAILABLE = { error: 'dm_unavailable', message: "You can't start a conversation with these people.", field: 'members' };

function redact(person, id, conversation, message) {
  return api('POST', `/v1/workspaces/${id}/conversations/${conversation}/messages/${message}/redact`, { token: person.token });
}

function read(person, id, conversation, seq) {
  return api('POST', `/v1/workspaces/${id}/conversations/${conversation}/read`, { token: person.token, body: { seq } });
}

// A DM as one of its people sees it now in the feed, from a pass that starts over.
async function dmRow(person, id, conversation) {
  return (await sync(person, id)).rooms.get(conversation);
}

// Starts a DM and writes in it, so that closing it keeps it: a DM nobody wrote in is deleted when it closes.
async function talking(person, id, members, text = 'hello') {
  const started = await startDm(person, id, members);
  expect(started.status).toBe(201);
  const dm = started.body.dm.conversation;
  expect((await post(person, id, dm, text)).status).toBe(201);
  return dm;
}

async function incarnation(person) {
  return (await call('GET', '/v1/account', { token: person.token })).body.incarnation;
}

describe('starting a direct message', () => {
  it('opens a DM between two full members at once', async () => {
    const ws = await newWorkspace('Acme', 'Olga');
    const mila = await newMember(ws, 'Mila');
    const started = await startDm(ws.person, ws.id, [mila.me.id]);
    expect(started.status).toBe(201);
    const dm = started.body.dm;
    expect(dm).toEqual({
      conversation: expect.stringMatching(/^c_[A-Za-z0-9_-]{22}$/),
      kind: 'dm',
      name: null,
      visibility: 'dm',
      archived: false,
      participants: [ws.me.id, mila.me.id],
      startedBy: ws.me.id,
      closedReason: null,
      grant: expect.stringMatching(/^g_/),
      role: 'member',
      members: 2,
      head: 1,
      floor: 1,
      lastAt: expect.any(Number),
      read: 1,
      unread: 0,
      mentions: 0,
      removed: [],
      removedMore: false
    });

    // One event opens it, and both grants start there with the read position.
    const log = (await events(mila.person, ws.id, dm.conversation)).body;
    expect(log.events).toEqual([
      { seq: 1, id: expect.stringMatching(/^e_/), kind: 'dm.started', actor: ws.me.id, at: dm.lastAt, members: [ws.me.id, mila.me.id] }
    ]);
    const grants = await workspaceSql(
      ws.id,
      'SELECT m.id AS member, g.role, g.startSeq, g.readSeq FROM grants g JOIN member m ON m.n = g.member WHERE g.conversation = (SELECT n FROM conversation WHERE id = ?) ORDER BY m.n',
      dm.conversation
    );
    expect(grants).toEqual([
      { member: ws.me.id, role: 'member', startSeq: 1, readSeq: 1 },
      { member: mila.me.id, role: 'member', startSeq: 1, readSeq: 1 }
    ]);

    // The room is in both feeds, each under its own grant.
    expect(await dmRow(ws.person, ws.id, dm.conversation)).toEqual(dm);
    const hers = await dmRow(mila.person, ws.id, dm.conversation);
    expect(hers).toMatchObject({ kind: 'dm', name: null, participants: [ws.me.id, mila.me.id], startedBy: ws.me.id, members: 2, read: 1 });
    expect(hers.grant).not.toBe(dm.grant);
  });

  it('answers the open DM when either participant starts it again', async () => {
    const ws = await newWorkspace();
    const mila = await newMember(ws, 'Mila');
    const first = await startDm(ws.person, ws.id, [mila.me.id]);
    const hers = await startDm(mila.person, ws.id, [ws.me.id]);
    expect(hers.status).toBe(200);
    expect(hers.body.dm).toMatchObject({ conversation: first.body.dm.conversation, startedBy: ws.me.id });
    const mine = await startDm(ws.person, ws.id, [mila.me.id]);
    expect(mine.status).toBe(200);
    expect(mine.body.dm.conversation).toBe(first.body.dm.conversation);
    expect(await workspaceSql(ws.id, "SELECT COUNT(*) AS n FROM conversation WHERE kind = 'dm'")).toEqual([{ n: 1 }]);
    // Only the first start counts against the daily cap.
    expect(await workspaceSql(ws.id, 'SELECT COUNT(*) AS n FROM dm_start')).toEqual([{ n: 1 }]);
  });

  it('treats the list as a set in any order', async () => {
    const ws = await newWorkspace();
    const mila = await newMember(ws, 'Mila');
    const tess = await newMember(ws, 'Tess');
    const one = await startDm(ws.person, ws.id, [mila.me.id, tess.me.id]);
    const two = await startDm(ws.person, ws.id, [tess.me.id, mila.me.id]);
    const three = await startDm(tess.person, ws.id, [mila.me.id, ws.me.id]);
    expect([one.status, two.status, three.status]).toEqual([201, 200, 200]);
    expect(new Set([one, two, three].map((res) => res.body.dm.conversation)).size).toBe(1);
    expect(one.body.dm.participants).toEqual([ws.me.id, mila.me.id, tess.me.id]);
    // A smaller set is another DM.
    expect((await startDm(ws.person, ws.id, [mila.me.id])).status).toBe(201);
  });

  it('opens a group of eight and refuses nine', async () => {
    const ws = await newWorkspace();
    const people = await fillers(ws.id, 8);
    const eight = await startDm(ws.person, ws.id, people.slice(0, 7));
    expect(eight.status).toBe(201);
    expect(eight.body.dm.members).toBe(8);
    expect(eight.body.dm.participants).toEqual([ws.me.id, ...people.slice(0, 7)]);
    const nine = await startDm(ws.person, ws.id, people);
    expect(nine.status).toBe(400);
    expect(nine.body).toMatchObject({ error: 'invalid', field: 'members' });
  });

  it('refuses an empty list, duplicates, the caller and malformed IDs', async () => {
    const ws = await newWorkspace();
    const mila = await newMember(ws, 'Mila');
    const bad = async (members) => {
      const res = await api('POST', `/v1/workspaces/${ws.id}/dms`, { token: ws.person.token, body: members === undefined ? {} : { members } });
      expect(res.status, JSON.stringify(members)).toBe(400);
      expect(res.body).toMatchObject({ error: 'invalid', field: 'members' });
    };
    await bad(undefined);
    await bad([]);
    await bad([mila.me.id, mila.me.id]);
    await bad([ws.me.id]);
    await bad([mila.me.id, ws.me.id]);
    await bad(['u_short']);
    await bad([42]);
    await bad(mila.me.id);
    await bad(['c_AAAAAAAAAAAAAAAAAAAAAA']);
    expect(await workspaceSql(ws.id, "SELECT COUNT(*) AS n FROM conversation WHERE kind = 'dm'")).toEqual([{ n: 0 }]);
  });

  it('refuses guests, former members and unknown IDs alike', async () => {
    const ws = await newWorkspace();
    const mila = await newMember(ws, 'Mila', { channels: [ws.general] });
    const gita = await guest(ws, 'Gita', [ws.general]);
    const tess = await newMember(ws, 'Tess');
    await api('DELETE', `/v1/workspaces/${ws.id}/members/me`, { token: tess.person.token });

    const answers = [
      await startDm(gita.person, ws.id, [mila.me.id]),
      await startDm(gita.person, ws.id, [ws.me.id, mila.me.id]),
      await startDm(ws.person, ws.id, [gita.me.id]),
      await startDm(ws.person, ws.id, [mila.me.id, gita.me.id]),
      await startDm(ws.person, ws.id, [tess.me.id]),
      await startDm(ws.person, ws.id, [NOBODY]),
      await startDm(ws.person, ws.id, [mila.me.id, NOBODY])
    ];
    for (const res of answers) {
      expect(res.status).toBe(403);
      expect(res.body).toEqual(UNAVAILABLE);
    }
    expect(await workspaceSql(ws.id, "SELECT COUNT(*) AS n FROM conversation WHERE kind = 'dm'")).toEqual([{ n: 0 }]);
    // Someone outside the workspace gets the workspace's 404, as on every route.
    const outsider = await startDm((await newWorkspace('Other')).person, ws.id, [mila.me.id]);
    expect(outsider.status).toBe(404);
    expect(outsider.body.scope).toBe('workspace');
  });

  it('keeps DMs out of the channel directory and routes', async () => {
    const ws = await newWorkspace();
    const mila = await newMember(ws, 'Mila');
    const dm = (await startDm(ws.person, ws.id, [mila.me.id])).body.dm.conversation;
    // The owner is in the DM and may do everything to a channel; to the channel routes the DM doesn't exist.
    expect((await channels(ws.person, ws.id)).map((c) => c.id)).toEqual([ws.general]);
    expect((await channels(mila.person, ws.id)).map((c) => c.id)).toEqual([ws.general]);
    const missing = 'c_AAAAAAAAAAAAAAAAAAAAAA';
    const probe = async (method, path, body) => {
      const real = await api(method, `/v1/workspaces/${ws.id}${path(dm)}`, { token: ws.person.token, body });
      const none = await api(method, `/v1/workspaces/${ws.id}${path(missing)}`, { token: ws.person.token, body });
      expect(real.status, `${method} ${path(dm)}`).toBe(404);
      expect(real.body, `${method} ${path(dm)}`).toEqual(none.body);
      expect(real.body).toMatchObject({ error: 'not_found', scope: 'conversation' });
    };
    await probe('PATCH', (c) => `/channels/${c}`, { name: 'renamed' });
    await probe('PATCH', (c) => `/channels/${c}`, { archived: true });
    await probe('POST', (c) => `/channels/${c}/join`);
    await probe('GET', (c) => `/channels/${c}/members`);
    await probe('POST', (c) => `/channels/${c}/members`, { member: mila.me.id });
    await probe('PATCH', (c) => `/channels/${c}/members/${mila.me.id}`, { role: 'manager' });
    await probe('DELETE', (c) => `/channels/${c}/members/${mila.me.id}`);
    await probe('DELETE', (c) => `/channels/${c}/members/me`);
    await probe('POST', () => '/invites', { role: 'member', channels: [dm] });
    // Nothing changed: still open, still the same two people.
    expect(await workspaceSql(ws.id, 'SELECT name, archivedAt, (SELECT COUNT(*) FROM grants WHERE conversation = c.n) AS people FROM conversation c WHERE id = ?', dm)).toEqual([
      { name: '', archivedAt: null, people: 2 }
    ]);
    // And the DM routes take no channel.
    const leave = await leaveDm(ws.person, ws.id, ws.general);
    expect(leave.status).toBe(404);
    expect(leave.body.scope).toBe('conversation');
  });

  it('counts DMs against the conversation limit', async () => {
    const ws = await newWorkspace();
    const mila = await newMember(ws, 'Mila');
    const limit = (await api('GET', `/v1/workspaces/${ws.id}`, { token: ws.person.token })).body.workspace.limits.conversations;
    await runInDurableObject(workspaceStub(ws.id), (instance, state) => {
      const sql = state.storage.sql;
      const have = sql.exec('SELECT COUNT(*) AS n FROM conversation').one().n;
      for (let i = have; i < limit; i++) {
        sql.exec(
          "INSERT INTO conversation (id, kind, visibility, name, createdBy, createdAt, head, floor, rev) VALUES (?, 'channel', 'private', 'Filler', 1, 0, 0, 1, 0)",
          `c_filler${i}`
        );
      }
    });
    const full = await startDm(ws.person, ws.id, [mila.me.id]);
    expect(full.status).toBe(413);
    expect(full.body).toMatchObject({ error: 'quota', scope: 'workspace', limit: 'conversations' });
    const channel = await api('POST', `/v1/workspaces/${ws.id}/channels`, { token: ws.person.token, body: { name: 'one more', visibility: 'workspace' } });
    expect(channel.status).toBe(413);
    expect(channel.body).toMatchObject({ error: 'quota', limit: 'conversations' });
    // A refused start doesn't count against the daily cap.
    expect(await workspaceSql(ws.id, 'SELECT COUNT(*) AS n FROM dm_start')).toEqual([{ n: 0 }]);
  });

  it('names the limit in every quota answer', async () => {
    const ws = await newWorkspace();
    const { secret } = await invite(ws.person, ws.id);
    await runInDurableObject(workspaceStub(ws.id), (instance, state) => {
      const sql = state.storage.sql;
      for (let i = 0; i < 99; i++) {
        sql.exec(
          "INSERT INTO member (id, incarnation, account, role, state, name, joinedAt) VALUES (?, ?, ?, 'member', 'active', 'Filler', 0)",
          `u_quota${i}`,
          `quota-${i}`,
          `quota-${i}`
        );
      }
      for (let i = 0; i < 99; i++) {
        sql.exec(
          "INSERT INTO invite (id, hash, issuer, role, channels, createdAt, expiresAt) VALUES (?, randomblob(32), 1, 'member', '[]', 0, ?)",
          `i_quota${i}`,
          Date.now() + DAY
        );
      }
      sql.exec('UPDATE workspace SET bytes = ?', 1073741824);
    });
    const people = await api('POST', `/v1/workspaces/${ws.id}/join`, { token: (await signup()).token, body: { invite: secret, name: 'P' } });
    expect(people.status).toBe(413);
    expect(people.body).toMatchObject({ error: 'quota', scope: 'workspace', limit: 'members' });
    const invites = await api('POST', `/v1/workspaces/${ws.id}/invites`, { token: ws.person.token, body: { role: 'member' } });
    expect(invites.status).toBe(413);
    expect(invites.body).toMatchObject({ error: 'quota', limit: 'invites' });
    const text = await post(ws.person, ws.id, ws.general, 'one byte too many');
    expect(text.status).toBe(413);
    expect(text.body).toMatchObject({ error: 'quota', limit: 'bytes' });
  });

  it('holds an initiator to twenty new DMs a day', async () => {
    const ws = await newWorkspace();
    const people = await fillers(ws.id, 22);
    await openDmLane(ws.person, ws.id);
    for (let i = 0; i < 20; i++) expect((await startDm(ws.person, ws.id, [people[i]])).status).toBe(201);
    const over = await startDm(ws.person, ws.id, [people[20]]);
    expect(over.status).toBe(429);
    expect(over.body).toMatchObject({ error: 'rate_limited', limit: 'dailyDms' });
    // The wait is until the oldest of those starts is a day old.
    const wait = Number(over.headers.get('retry-after'));
    expect(wait).toBeGreaterThan(DAY / 1000 - 120);
    expect(wait).toBeLessThanOrEqual(DAY / 1000);
    // Opening one of them again costs nothing, also now.
    expect((await startDm(ws.person, ws.id, [people[3]])).status).toBe(200);

    // A day later the oldest start no longer counts, and lets one more in.
    await workspaceSql(ws.id, 'UPDATE dm_start SET at = at - ? WHERE rowid = (SELECT rowid FROM dm_start ORDER BY at LIMIT 1)', 25 * 60 * 60 * 1000);
    expect((await startDm(ws.person, ws.id, [people[20]])).status).toBe(201);
    expect((await startDm(ws.person, ws.id, [people[21]])).status).toBe(429);
    // Someone else has a cap of their own.
    const mila = await newMember(ws, 'Mila');
    expect((await startDm(mila.person, ws.id, [people[21]])).status).toBe(201);
    // The alarm forgets starts older than a day.
    await runInDurableObject(workspaceStub(ws.id), (instance) => instance.alarm());
    expect(await workspaceSql(ws.id, 'SELECT COUNT(*) AS n FROM dm_start')).toEqual([{ n: 21 }]);
  });

  it('sheds a burst of starts before doing any work', async () => {
    const ws = await newWorkspace();
    const mila = await newMember(ws, 'Mila');
    const statuses = [];
    for (let i = 0; i < 11; i++) statuses.push((await startDm(ws.person, ws.id, [mila.me.id])).status);
    expect(statuses).toEqual([201, ...Array(9).fill(200), 429]);
    const shed = await startDm(ws.person, ws.id, [mila.me.id]);
    expect(shed.body).toMatchObject({ error: 'rate_limited', scope: 'workspace' });
    expect(Number(shed.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    // Starting is a lane of its own: the same person still reads and writes.
    expect((await post(ws.person, ws.id, ws.general, 'still here')).status).toBe(201);
  });
});

describe('messages in a direct message', () => {
  it('posts, threads, mentions, reads and redacts in a DM', async () => {
    const ws = await newWorkspace('Acme', 'Olga');
    const mila = await newMember(ws, 'Mila');
    const tess = await newMember(ws, 'Tess');
    const dm = (await startDm(ws.person, ws.id, [mila.me.id])).body.dm.conversation;

    const sent = await send(ws.person, ws.id, dm, { operationId: uuidv7(), text: '@Mila look', mentions: [{ actor: mila.me.id, start: 0, end: 5 }] });
    expect(sent.status).toBe(201);
    expect(await dmRow(mila.person, ws.id, dm)).toMatchObject({ head: sent.body.seq, unread: 1, mentions: 1 });
    // Someone outside the DM can't be mentioned in it, read it or write in it.
    const outside = await send(ws.person, ws.id, dm, { operationId: uuidv7(), text: '@Tess', mentions: [{ actor: tess.me.id, start: 0, end: 5 }] });
    expect(outside.status).toBe(400);
    expect(outside.body.field).toBe('mentions');
    expect((await events(tess.person, ws.id, dm)).status).toBe(404);
    expect((await post(tess.person, ws.id, dm, 'let me in')).status).toBe(404);

    expect((await read(mila.person, ws.id, dm, sent.body.seq)).body).toEqual({ read: sent.body.seq });
    expect(await dmRow(mila.person, ws.id, dm)).toMatchObject({ read: sent.body.seq, unread: 0, mentions: 0 });
    const reply = await post(mila.person, ws.id, dm, 'seen', { root: sent.body.messageId });
    expect(reply.status).toBe(201);
    expect((await events(ws.person, ws.id, dm, `?after=${sent.body.seq}`)).body.events[0]).toMatchObject({ text: 'seen', root: sent.body.messageId, actor: mila.me.id });

    // Only the author removes a message: nobody manages a DM.
    expect((await redact(mila.person, ws.id, dm, sent.body.messageId)).status).toBe(403);
    expect((await redact(ws.person, ws.id, dm, sent.body.messageId)).status).toBe(200);
    expect((await redact(mila.person, ws.id, dm, reply.body.messageId)).status).toBe(200);
  });

  it('gives every room its member count and last activity', async () => {
    const ws = await newWorkspace();
    const mila = await newMember(ws, 'Mila');
    const newest = async (conversation) => (await events(ws.person, ws.id, conversation)).body.events.at(-1).at;
    const room = async (conversation) => (await sync(ws.person, ws.id)).rooms.get(conversation);

    expect(await room(ws.general)).toMatchObject({ members: 1, lastAt: await newest(ws.general) });
    await api('POST', `/v1/workspaces/${ws.id}/channels/${ws.general}/join`, { token: mila.person.token });
    expect(await room(ws.general)).toMatchObject({ members: 2, lastAt: await newest(ws.general) });
    await api('DELETE', `/v1/workspaces/${ws.id}/channels/${ws.general}/members/me`, { token: mila.person.token });
    expect(await room(ws.general)).toMatchObject({ members: 1, lastAt: await newest(ws.general) });

    const dm = await talking(ws.person, ws.id, [mila.me.id]);
    expect(await room(dm)).toMatchObject({ members: 2, lastAt: await newest(dm) });

    // Once retention took the newest event, there is no time to give.
    await workspaceSql(ws.id, 'UPDATE event SET at = ?', Date.now() - 91 * DAY);
    await runInDurableObject(workspaceStub(ws.id), (instance) => instance.alarm());
    expect(await room(ws.general)).toMatchObject({ members: 1, lastAt: null });
    expect(await room(dm)).toMatchObject({ members: 2, lastAt: null });
  });
});

describe('closing a direct message', () => {
  it('closes when a participant leaves the workspace, and the rest keep reading', async () => {
    const ws = await newWorkspace();
    const mila = await newMember(ws, 'Mila');
    const dm = await talking(ws.person, ws.id, [mila.me.id], 'before you go');
    const before = await sync(ws.person, ws.id);

    expect((await api('DELETE', `/v1/workspaces/${ws.id}/members/me`, { token: mila.person.token })).status).toBe(204);
    const after = await sync(ws.person, ws.id, before.cursor);
    expect(after.rooms.get(dm)).toMatchObject({ archived: true, closedReason: 'left', members: 1, participants: [ws.me.id, mila.me.id] });
    // The leaver's devices were told to drop it.
    const evicted = await workspaceSql(ws.id, 'SELECT e.conversation FROM evicted e JOIN member m ON m.n = e.member WHERE m.id = ?', mila.me.id);
    expect(evicted.map((row) => row.conversation)).toContain(dm);
    // The history stays readable; writing in it is over.
    const log = (await events(ws.person, ws.id, dm)).body.events;
    expect(log.map((e) => e.kind)).toEqual(['dm.started', 'message.posted', 'member.left']);
    expect(log[2]).toMatchObject({ member: mila.me.id, actor: mila.me.id });
    const refused = await post(ws.person, ws.id, dm, 'still there?');
    expect(refused.status).toBe(409);
    expect(refused.body).toEqual({ error: 'archived', message: 'This conversation is closed.', scope: 'conversation' });
  });

  it('closes when a participant is removed or their account is deleted', async () => {
    const ws = await newWorkspace();
    const mila = await newMember(ws, 'Mila');
    const tess = await newMember(ws, 'Tess');
    const withMila = await talking(ws.person, ws.id, [mila.me.id]);
    const withTess = await talking(ws.person, ws.id, [tess.me.id]);
    const before = await sync(ws.person, ws.id);

    expect((await api('DELETE', `/v1/workspaces/${ws.id}/members/${mila.me.id}`, { token: ws.person.token })).status).toBe(204);
    const gone = await incarnation(tess.person);
    await runInDurableObject(workspaceStub(ws.id), (instance) => instance.retire(gone));

    const after = await sync(ws.person, ws.id, before.cursor);
    expect(after.rooms.get(withMila)).toMatchObject({ archived: true, closedReason: 'left', members: 1 });
    expect(after.rooms.get(withTess)).toMatchObject({ archived: true, closedReason: 'left', members: 1, participants: [ws.me.id, tess.me.id] });
    expect((await events(ws.person, ws.id, withMila)).body.events.at(-1)).toMatchObject({ kind: 'member.left', member: mila.me.id, actor: ws.me.id });
    expect((await events(ws.person, ws.id, withTess)).body.events.at(-1)).toMatchObject({ kind: 'member.left', member: tess.me.id });
  });

  it('closes when a participant becomes a guest', async () => {
    const ws = await newWorkspace();
    const mila = await newMember(ws, 'Mila');
    const dm = await talking(ws.person, ws.id, [mila.me.id]);
    const before = await sync(ws.person, ws.id);
    expect((await api('PATCH', `/v1/workspaces/${ws.id}/members/${mila.me.id}`, { token: ws.person.token, body: { role: 'guest' } })).status).toBe(200);
    expect((await sync(ws.person, ws.id, before.cursor)).rooms.get(dm)).toMatchObject({ archived: true, closedReason: 'ineligible', members: 2 });
    // She still reads what was said, and can't write.
    expect((await events(mila.person, ws.id, dm)).status).toBe(200);
    expect((await post(mila.person, ws.id, dm, 'hello?')).status).toBe(409);
    // Made a member again, nothing reopens; a new start is a new DM.
    await api('PATCH', `/v1/workspaces/${ws.id}/members/${mila.me.id}`, { token: ws.person.token, body: { role: 'member' } });
    const again = await startDm(ws.person, ws.id, [mila.me.id]);
    expect(again.status).toBe(201);
    expect(again.body.dm.conversation).not.toBe(dm);
  });

  it('lets a participant leave a group DM', async () => {
    const ws = await newWorkspace();
    const mila = await newMember(ws, 'Mila');
    const tess = await newMember(ws, 'Tess');
    const dm = await talking(ws.person, ws.id, [mila.me.id, tess.me.id]);
    const owner = await sync(ws.person, ws.id);
    const hers = await sync(tess.person, ws.id);

    expect((await leaveDm(tess.person, ws.id, dm)).status).toBe(204);
    expect((await sync(tess.person, ws.id, hers.cursor)).evictions).toEqual([dm]);
    expect((await events(tess.person, ws.id, dm)).status).toBe(404);
    expect((await leaveDm(tess.person, ws.id, dm)).status).toBe(404);
    expect((await sync(ws.person, ws.id, owner.cursor)).rooms.get(dm)).toMatchObject({ archived: true, closedReason: 'left', members: 2 });
    expect((await events(mila.person, ws.id, dm)).body.events.at(-1)).toMatchObject({ kind: 'member.left', member: tess.me.id, actor: tess.me.id });
  });

  it('deletes a DM that closes before anyone posted', async () => {
    const ws = await newWorkspace();
    const mila = await newMember(ws, 'Mila');
    const slots = async () => (await workspaceSql(ws.id, 'SELECT COUNT(*) AS n FROM conversation'))[0].n;
    const empty = await slots();
    const dm = (await startDm(ws.person, ws.id, [mila.me.id])).body.dm.conversation;
    expect(await slots()).toBe(empty + 1);
    const owner = await sync(ws.person, ws.id);

    expect((await leaveDm(mila.person, ws.id, dm)).status).toBe(204);
    expect((await sync(ws.person, ws.id, owner.cursor)).evictions).toEqual([dm]);
    expect(await slots()).toBe(empty);
    expect(await workspaceSql(ws.id, 'SELECT COUNT(*) AS n FROM grants g JOIN conversation c ON c.n = g.conversation WHERE c.id = ?', dm)).toEqual([{ n: 0 }]);
    expect((await events(ws.person, ws.id, dm)).status).toBe(404);

    // The same happens to one a participant leaves by becoming a guest before anyone wrote.
    const again = (await startDm(ws.person, ws.id, [mila.me.id])).body.dm.conversation;
    const before = await sync(ws.person, ws.id);
    await api('PATCH', `/v1/workspaces/${ws.id}/members/${mila.me.id}`, { token: ws.person.token, body: { role: 'guest' } });
    expect((await sync(ws.person, ws.id, before.cursor)).evictions).toEqual([again]);
    expect(await slots()).toBe(empty);
  });

  it('deletes a closed DM once nobody holds it', async () => {
    const ws = await newWorkspace();
    const mila = await newMember(ws, 'Mila');
    const dm = await talking(ws.person, ws.id, [mila.me.id], 'x'.repeat(100));
    const stored = (await workspaceSql(ws.id, 'SELECT bytes FROM workspace'))[0].bytes;
    expect((await leaveDm(mila.person, ws.id, dm)).status).toBe(204);
    expect(await workspaceSql(ws.id, 'SELECT closedWhy FROM conversation WHERE id = ?', dm)).toEqual([{ closedWhy: 'left' }]);
    expect((await leaveDm(ws.person, ws.id, dm)).status).toBe(204);
    expect(await workspaceSql(ws.id, 'SELECT id FROM conversation WHERE id = ?', dm)).toEqual([]);
    expect(await workspaceSql(ws.id, "SELECT COUNT(*) AS n FROM event WHERE kind = 'dm.started'")).toEqual([{ n: 0 }]);
    // What was written in it no longer counts against the workspace's storage.
    expect((await workspaceSql(ws.id, 'SELECT bytes FROM workspace'))[0].bytes).toBe(stored - 100);
  });

  it('starts a new DM with a new ID after one closed', async () => {
    const ws = await newWorkspace();
    const mila = await newMember(ws, 'Mila');
    const old = await talking(ws.person, ws.id, [mila.me.id]);
    await leaveDm(mila.person, ws.id, old);
    const fresh = await startDm(mila.person, ws.id, [ws.me.id]);
    expect(fresh.status).toBe(201);
    expect(fresh.body.dm).toMatchObject({ archived: false, startedBy: mila.me.id, members: 2 });
    expect(fresh.body.dm.conversation).not.toBe(old);
    const rooms = (await sync(ws.person, ws.id)).rooms;
    expect(rooms.get(old)).toMatchObject({ archived: true, closedReason: 'left' });
    expect(rooms.get(fresh.body.dm.conversation)).toMatchObject({ archived: false, closedReason: null });
  });

  it('lets an author remove a message in a closed DM', async () => {
    const ws = await newWorkspace();
    const mila = await newMember(ws, 'Mila');
    const started = await startDm(ws.person, ws.id, [mila.me.id]);
    const dm = started.body.dm.conversation;
    const oops = await post(ws.person, ws.id, dm, 'oops');
    const before = await sync(ws.person, ws.id);
    await leaveDm(mila.person, ws.id, dm);

    const removed = await redact(ws.person, ws.id, dm, oops.body.messageId);
    expect(removed.status).toBe(200);
    expect((await sync(ws.person, ws.id, before.cursor)).rooms.get(dm)).toMatchObject({ archived: true, removed: [oops.body.messageId] });
  });

  it('replays a message that committed before the close and refuses a new one', async () => {
    const ws = await newWorkspace();
    const mila = await newMember(ws, 'Mila');
    const dm = (await startDm(ws.person, ws.id, [mila.me.id])).body.dm.conversation;
    const operationId = uuidv7();
    const first = await send(ws.person, ws.id, dm, { operationId, text: 'sent in time' });
    expect(first.status).toBe(201);
    await leaveDm(mila.person, ws.id, dm);

    const retry = await send(ws.person, ws.id, dm, { operationId, text: 'sent in time' });
    expect(retry.status).toBe(200);
    expect(retry.body).toEqual(first.body);
    const late = await send(ws.person, ws.id, dm, { operationId: uuidv7(), text: 'too late' });
    expect(late.status).toBe(409);
    expect(late.body).toMatchObject({ error: 'archived', message: 'This conversation is closed.', scope: 'conversation' });
  });

  it('collects a closed DM when retention removed its history', async () => {
    const ws = await newWorkspace();
    const mila = await newMember(ws, 'Mila');
    const dm = await talking(ws.person, ws.id, [mila.me.id]);
    await leaveDm(mila.person, ws.id, dm);
    const before = await sync(ws.person, ws.id);
    await workspaceSql(ws.id, 'UPDATE event SET at = ? WHERE conversation = (SELECT n FROM conversation WHERE id = ?)', Date.now() - 91 * DAY, dm);
    await runInDurableObject(workspaceStub(ws.id), (instance) => instance.alarm());

    expect(await workspaceSql(ws.id, 'SELECT id FROM conversation WHERE id = ?', dm)).toEqual([]);
    expect(await workspaceSql(ws.id, "SELECT COUNT(*) AS n FROM grants g JOIN conversation c ON c.n = g.conversation WHERE c.kind = 'dm'")).toEqual([{ n: 0 }]);
    expect((await sync(ws.person, ws.id, before.cursor)).evictions).toEqual([dm]);
  });
});

describe('blocks', () => {
  it('block closes every open DM between the two, groups included', async () => {
    const ws = await newWorkspace();
    const mila = await newMember(ws, 'Mila');
    const tess = await newMember(ws, 'Tess');
    const pair = await talking(ws.person, ws.id, [mila.me.id]);
    const group = await talking(ws.person, ws.id, [mila.me.id, tess.me.id]);
    const mine = await talking(ws.person, ws.id, [tess.me.id]);
    const theirs = await talking(mila.person, ws.id, [tess.me.id]);
    const before = await sync(ws.person, ws.id);

    const made = await block(ws.person, ws.id, mila.me.id);
    expect(made.status).toBe(201);
    expect(made.body).toEqual({ block: { member: mila.me.id, at: expect.any(Number) } });
    const rooms = (await sync(ws.person, ws.id, before.cursor)).rooms;
    expect(rooms.get(pair)).toMatchObject({ archived: true, closedReason: 'closed' });
    expect(rooms.get(group)).toMatchObject({ archived: true, closedReason: 'closed' });
    // A DM with only one of the two in it goes on.
    expect((await dmRow(ws.person, ws.id, mine)).archived).toBe(false);
    expect((await dmRow(tess.person, ws.id, theirs)).archived).toBe(false);
    // The others see the close, and nothing in the DM says who blocked whom.
    expect(await dmRow(tess.person, ws.id, group)).toMatchObject({ archived: true, closedReason: 'closed' });
    expect((await events(mila.person, ws.id, pair)).body.events.map((e) => e.kind)).toEqual(['dm.started', 'message.posted']);
  });

  it('block refuses new DMs in either direction', async () => {
    const ws = await newWorkspace();
    const mila = await newMember(ws, 'Mila');
    const tess = await newMember(ws, 'Tess');
    await block(ws.person, ws.id, mila.me.id);

    const mine = await startDm(ws.person, ws.id, [mila.me.id]);
    expect(mine.status).toBe(409);
    expect(mine.body).toEqual({ error: 'blocked', message: 'You blocked someone in this conversation. Unblock them first.', member: mila.me.id });
    const group = await startDm(ws.person, ws.id, [tess.me.id, mila.me.id]);
    expect(group.status).toBe(409);
    expect(group.body.member).toBe(mila.me.id);
    // Everyone else gets the answer an id nobody has gets.
    const unknown = await startDm(mila.person, ws.id, [NOBODY]);
    for (const res of [await startDm(mila.person, ws.id, [ws.me.id]), await startDm(tess.person, ws.id, [ws.me.id, mila.me.id]), await startDm(mila.person, ws.id, [tess.me.id, ws.me.id])]) {
      expect(res.status).toBe(403);
      expect(res.body).toEqual(unknown.body);
    }
    // Without the blocker, the blocked person starts DMs as before.
    expect((await startDm(mila.person, ws.id, [tess.me.id])).status).toBe(201);
  });

  it('block removes the blocked person’s mentions of the blocker', async () => {
    const ws = await newWorkspace('Acme', 'Olga');
    const mila = await newMember(ws, 'Mila', { channels: [ws.general] });
    const tess = await newMember(ws, 'Tess', { channels: [ws.general] });
    const mention = (person, who, text) => send(person, ws.id, ws.general, { operationId: uuidv7(), text, mentions: [{ actor: who, start: 0, end: 5 }] });
    await mention(mila.person, ws.me.id, '@Olga first');
    await mention(tess.person, ws.me.id, '@Olga from Tess');
    const before = await sync(ws.person, ws.id);
    expect(before.rooms.get(ws.general)).toMatchObject({ unread: 2, mentions: 2 });

    await block(ws.person, ws.id, mila.me.id);
    const next = await sync(ws.person, ws.id, before.cursor);
    expect(next.rooms.get(ws.general)).toMatchObject({ unread: 2, mentions: 1 });
    // Her new mentions don't count either; her messages still do.
    await mention(mila.person, ws.me.id, '@Olga again');
    expect((await sync(ws.person, ws.id, next.cursor)).rooms.get(ws.general)).toMatchObject({ unread: 3, mentions: 1 });
    // The text keeps the mention as written, and anyone else she names is still called.
    expect((await events(ws.person, ws.id, ws.general)).body.events.at(-1).mentions).toEqual([{ actor: ws.me.id, start: 0, end: 5 }]);
    await mention(mila.person, tess.me.id, '@Tess hi');
    expect((await sync(tess.person, ws.id)).rooms.get(ws.general).mentions).toBe(1);
  });

  it('block tells only the blocker’s devices', async () => {
    const ws = await newWorkspace();
    const mila = await newMember(ws, 'Mila');
    const mine = await sync(ws.person, ws.id);
    const hers = await sync(mila.person, ws.id);
    expect(mine.last.directory.blocks).toBe(true);

    await block(ws.person, ws.id, mila.me.id);
    const told = await sync(ws.person, ws.id, mine.cursor);
    expect(told.last.directory.blocks).toBe(true);
    expect((await sync(mila.person, ws.id, hers.cursor)).last.directory.blocks).toBe(false);
    // Once, and again when the block goes.
    expect((await sync(ws.person, ws.id, told.cursor)).last.directory.blocks).toBe(false);
    await unblock(ws.person, ws.id, mila.me.id);
    expect((await sync(ws.person, ws.id, told.cursor)).last.directory.blocks).toBe(true);
    expect((await sync(mila.person, ws.id, hers.cursor)).last.directory.blocks).toBe(false);
  });

  it('unblock reopens nothing', async () => {
    const ws = await newWorkspace('Acme', 'Olga');
    const mila = await newMember(ws, 'Mila', { channels: [ws.general] });
    const dm = await talking(ws.person, ws.id, [mila.me.id]);
    await send(mila.person, ws.id, ws.general, { operationId: uuidv7(), text: '@Olga', mentions: [{ actor: ws.me.id, start: 0, end: 5 }] });
    await block(ws.person, ws.id, mila.me.id);
    expect((await unblock(ws.person, ws.id, mila.me.id)).status).toBe(204);

    const rooms = (await sync(ws.person, ws.id)).rooms;
    expect(rooms.get(dm)).toMatchObject({ archived: true, closedReason: 'closed' });
    expect(rooms.get(ws.general)).toMatchObject({ unread: 1, mentions: 0 });
    const fresh = await startDm(ws.person, ws.id, [mila.me.id]);
    expect(fresh.status).toBe(201);
    expect(fresh.body.dm.conversation).not.toBe(dm);
    expect((await blocks(ws.person, ws.id)).body).toEqual({ blocks: [] });
  });

  it('lists only the caller’s own blocks and refuses odd targets', async () => {
    const ws = await newWorkspace();
    const project = (await api('POST', `/v1/workspaces/${ws.id}/channels`, { token: ws.person.token, body: { name: 'project', visibility: 'workspace' } })).body.channel.id;
    const mila = await newMember(ws, 'Mila');
    const tess = await newMember(ws, 'Tess');
    const gita = await guest(ws, 'Gita', [project]);

    const first = await block(ws.person, ws.id, mila.me.id);
    const second = await block(ws.person, ws.id, tess.me.id);
    expect((await blocks(ws.person, ws.id)).body.blocks).toEqual([
      { member: tess.me.id, at: second.body.block.at },
      { member: mila.me.id, at: first.body.block.at }
    ]);
    expect((await blocks(mila.person, ws.id)).body).toEqual({ blocks: [] });

    // Again: the same block, the same time.
    const again = await block(ws.person, ws.id, mila.me.id);
    expect(again.status).toBe(200);
    expect(again.body).toEqual(first.body);

    const self = await block(ws.person, ws.id, ws.me.id);
    expect(self.status).toBe(400);
    expect(self.body).toMatchObject({ error: 'invalid', field: 'member' });
    const bent = await block(ws.person, ws.id, 'u_short');
    expect(bent.status).toBe(400);
    expect(bent.body.field).toBe('member');
    // A guest can block only someone they share a room with; anyone else is an id nobody has.
    const outside = await block(gita.person, ws.id, mila.me.id);
    const nobody = await block(gita.person, ws.id, NOBODY);
    expect(outside.status).toBe(404);
    expect(outside.body).toEqual(nobody.body);
    expect(outside.body.scope).toBeUndefined();
    expect((await block(gita.person, ws.id, ws.me.id)).status).toBe(201);
    // A former member can't be blocked any more.
    await api('DELETE', `/v1/workspaces/${ws.id}/members/me`, { token: tess.person.token });
    expect((await block(mila.person, ws.id, tess.me.id)).body).toEqual(nobody.body);

    expect((await unblock(ws.person, ws.id, mila.me.id)).status).toBe(204);
    expect((await unblock(ws.person, ws.id, mila.me.id)).status).toBe(204);
    expect((await unblock(ws.person, ws.id, NOBODY)).status).toBe(204);
    expect((await blocks(ws.person, ws.id)).body.blocks.map((b) => b.member)).toEqual([tess.me.id]);
  });

  it('forgets the blocks of a deleted account', async () => {
    const ws = await newWorkspace();
    const mila = await newMember(ws, 'Mila');
    const tess = await newMember(ws, 'Tess');
    await block(ws.person, ws.id, mila.me.id);
    await block(mila.person, ws.id, tess.me.id);
    const before = await sync(ws.person, ws.id);

    const gone = await incarnation(mila.person);
    await runInDurableObject(workspaceStub(ws.id), (instance) => instance.retire(gone));
    const [{ n }] = await workspaceSql(ws.id, 'SELECT n FROM member WHERE id = ?', mila.me.id);
    expect(await workspaceSql(ws.id, 'SELECT COUNT(*) AS n FROM block WHERE blocker = ? OR blocked = ?', n, n)).toEqual([{ n: 0 }]);
    // Whoever had blocked the account loads their list again, and finds it gone.
    expect((await sync(ws.person, ws.id, before.cursor)).last.directory.blocks).toBe(true);
    expect((await blocks(ws.person, ws.id)).body).toEqual({ blocks: [] });
  });
});
