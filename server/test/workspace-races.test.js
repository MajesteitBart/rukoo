// Sequences that only go wrong in a particular order: a room that changes again while a device pages, a message
// written under access that has since ended, an account deleted twice, a reference recorded while another is given
// back. Each of these was a defect found in review before the first release of workspaces.

import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { accountStub, call, signup } from './helpers.js';
import {
  access,
  api,
  changes,
  channels,
  events,
  invite,
  newMember,
  newWorkspace,
  openSocket,
  post,
  send,
  sync,
  until,
  uuidv7,
  workspaceSql,
  workspaceStub
} from './workspace-helpers.js';

const DAY = 24 * 60 * 60 * 1000;

function redact(person, id, conversation, message) {
  return api('POST', `/v1/workspaces/${id}/conversations/${conversation}/messages/${message}/redact`, { token: person.token });
}

async function channel(ws, name, visibility = 'workspace') {
  const made = await api('POST', `/v1/workspaces/${ws.id}/channels`, { token: ws.person.token, body: { name, visibility } });
  return made.body.channel.id;
}

describe('the feed, in an awkward order', () => {
  it('lists a redaction the scan already passed, when its room changes again mid-pass', async () => {
    const ws = await newWorkspace();
    const other = await channel(ws, 'other');
    const mila = await newMember(ws, 'Mila', { channels: [ws.general, other] });
    const doomed = await post(ws.person, ws.id, ws.general, 'will go');
    const seen = await sync(mila.person, ws.id);

    // Redacted in general, then something in the other room, then general changes again.
    await redact(ws.person, ws.id, ws.general, doomed.body.messageId);
    await post(ws.person, ws.id, other, 'meanwhile');
    await post(ws.person, ws.id, ws.general, 'and again');

    // One room per page: the other room comes first, because general's latest change is newer.
    const first = await changes(mila.person, ws.id, `?after=${seen.cursor}&limit=1`);
    expect(first.body.changes.map((room) => room.conversation)).toEqual([other]);
    expect(first.body.more).toBe(true);
    const second = await changes(mila.person, ws.id, `?after=${first.body.next}&limit=1`);
    expect(second.body.changes.map((room) => room.conversation)).toEqual([ws.general]);
    // The redaction is older than where the scan is by now, and is listed all the same.
    expect(second.body.changes[0].removed).toEqual([doomed.body.messageId]);
    expect(second.body.more).toBe(false);
    // Once the pass is finished it isn't listed again.
    await post(ws.person, ws.id, ws.general, 'later');
    expect((await sync(mila.person, ws.id, second.body.next)).rooms.get(ws.general).removed).toEqual([]);
  });

  it('lets a device start over when quiet rooms are older than what the feed remembers', async () => {
    const ws = await newWorkspace();
    const rooms = [ws.general, await channel(ws, 'quiet-1'), await channel(ws, 'quiet-2')];
    const mila = await newMember(ws, 'Mila', { channels: rooms });
    const sent = await post(ws.person, ws.id, ws.general, 'x');
    await redact(ws.person, ws.id, ws.general, sent.body.messageId);
    await workspaceSql(ws.id, 'UPDATE removal SET at = ?', Date.now() - 15 * DAY);
    await runInDurableObject(workspaceStub(ws.id), (instance) => instance.alarm());
    // The quiet rooms last changed before the removal the feed just forgot.
    const [state] = await workspaceSql(ws.id, 'SELECT feedFloor, (SELECT MIN(rev) FROM conversation) AS oldest FROM workspace');
    expect(state.oldest).toBeLessThan(state.feedFloor);

    // A pass from the start, a room at a time, gets through all of them.
    const fresh = await sync(mila.person, ws.id, null, 1);
    expect(fresh.pages).toBe(3);
    expect([...fresh.rooms.keys()].sort()).toEqual([...rooms].sort());
    expect((await changes(mila.person, ws.id, `?after=${fresh.cursor}`)).status).toBe(200);
  });

  it('reports a redaction made while a device is still on its first pass', async () => {
    const ws = await newWorkspace();
    const other = await channel(ws, 'other');
    const mila = await newMember(ws, 'Mila', { channels: [ws.general, other] });
    const doomed = await post(ws.person, ws.id, ws.general, 'will go');
    await post(ws.person, ws.id, other, 'newer');
    const first = await changes(mila.person, ws.id, '?limit=1');
    expect(first.body.changes.map((room) => room.conversation)).toEqual([ws.general]);
    // The device has general and may have loaded its history. Then the message goes.
    await redact(ws.person, ws.id, ws.general, doomed.body.messageId);
    const rest = await sync(mila.person, ws.id, first.body.next, 1);
    expect(rest.rooms.get(ws.general).removed).toEqual([doomed.body.messageId]);
  });

  it('gives every cursor the same length, whatever the revision', async () => {
    const ws = await newWorkspace();
    const small = (await sync(ws.person, ws.id)).cursor;
    await workspaceSql(ws.id, 'UPDATE workspace SET rev = rev + 987654321');
    await post(ws.person, ws.id, ws.general, 'x');
    const large = (await sync(ws.person, ws.id)).cursor;
    expect(large.length).toBe(small.length);
  });

  it('tells a guest when the people they can see change, and about nobody else', async () => {
    const ws = await newWorkspace();
    const project = await channel(ws, 'project');
    const tess = await newMember(ws, 'Tess', { channels: [project] });
    const mila = await newMember(ws, 'Mila');
    const guest = await newMember(ws, 'Gus', { role: 'guest', channels: [project] });
    const rename = (person, name) => api('PATCH', `/v1/workspaces/${ws.id}/members/me`, { token: person.token, body: { name } });
    const flag = async (cursor) => {
      const next = await sync(guest.person, ws.id, cursor);
      return { members: next.last.directory.members, cursor: next.cursor };
    };
    let at = (await sync(guest.person, ws.id)).cursor;

    // Mila shares no room with the guest: her new name is none of the guest's business.
    await rename(mila.person, 'Mila M.');
    let seen = await flag(at);
    expect(seen.members).toBe(false);
    // Tess does.
    await rename(tess.person, 'Tess T.');
    seen = await flag(seen.cursor);
    expect(seen.members).toBe(true);
    // Mila joining the guest's room changes who the guest can see, without anyone's name or role changing.
    await api('POST', `/v1/workspaces/${ws.id}/channels/${project}/join`, { token: mila.person.token });
    seen = await flag(seen.cursor);
    expect(seen.members).toBe(true);
    const names = (await api('GET', `/v1/workspaces/${ws.id}/members`, { token: guest.person.token })).body;
    expect(names.members.map((m) => m.name).sort()).toEqual(['Gus', 'Mila M.', 'Olga Owner', 'Tess T.']);
    expect(names.more).toBe(false);
    // And nothing after that.
    expect((await flag(seen.cursor)).members).toBe(false);
    // A full member hears of every member change.
    const owner = await sync(ws.person, ws.id);
    await rename(mila.person, 'Mila');
    expect((await sync(ws.person, ws.id, owner.cursor)).last.directory.members).toBe(true);
  });
});

describe('a message and the access it was written under', () => {
  it('is refused when that grant has ended, also after the member got back in', async () => {
    const ws = await newWorkspace();
    const mila = await newMember(ws, 'Mila', { channels: [ws.general] });
    const before = await access(mila.person, ws.id, ws.general);
    const arrived = uuidv7();
    const first = await send(mila.person, ws.id, ws.general, { operationId: arrived, text: 'sent in time', ...before });
    expect(first.status).toBe(201);

    // Taken out of the channel, then back in: a new grant.
    await api('DELETE', `/v1/workspaces/${ws.id}/channels/${ws.general}/members/${mila.me.id}`, { token: ws.person.token });
    await api('POST', `/v1/workspaces/${ws.id}/channels/${ws.general}/join`, { token: mila.person.token });
    const after = await access(mila.person, ws.id, ws.general);
    expect(after.grant).not.toBe(before.grant);

    // What was still waiting on the device from before is not sent on the strength of the new grant.
    const queued = await send(mila.person, ws.id, ws.general, { operationId: uuidv7(), text: 'written before', ...before });
    expect(queued.status).toBe(409);
    expect(queued.body).toMatchObject({ error: 'stale_grant', scope: 'conversation' });
    // What did arrive under the old grant is still answered when its retry comes.
    const retry = await send(mila.person, ws.id, ws.general, { operationId: arrived, text: 'sent in time', ...before });
    expect(retry.status).toBe(200);
    expect(retry.body).toEqual(first.body);
    expect((await send(mila.person, ws.id, ws.general, { operationId: uuidv7(), text: 'written now', ...after })).status).toBe(201);
  });

  it('is refused when the workspace was restored since, and needs both to be named', async () => {
    const ws = await newWorkspace();
    const now = await access(ws.person, ws.id, ws.general);
    const old = await send(ws.person, ws.id, ws.general, { operationId: uuidv7(), text: 'x', grant: now.grant, generation: 'A'.repeat(22) });
    expect(old.status).toBe(409);
    expect(old.body).toMatchObject({ error: 'stale_generation', scope: 'workspace' });
    const raw = (body) => api('POST', `/v1/workspaces/${ws.id}/conversations/${ws.general}/messages`, { token: ws.person.token, body });
    expect((await raw({ operationId: uuidv7(), text: 'x', generation: now.generation })).body.field).toBe('grant');
    expect((await raw({ operationId: uuidv7(), text: 'x', grant: now.grant })).body.field).toBe('generation');
    expect((await raw({ operationId: uuidv7(), text: 'x', grant: 'g_nope', generation: now.generation })).status).toBe(400);
  });

  it('is not posted twice when retention removed it before its retry came', async () => {
    const ws = await newWorkspace();
    // This workspace keeps messages for a day, less than the 30 days a retry may take.
    await runInDurableObject(workspaceStub(ws.id), (instance) => {
      const settings = {};
      for (const name of Object.keys(env)) settings[name] = env[name];
      instance.env = { ...settings, WORKSPACE_RETENTION_DAYS: '1' };
    });
    const operationId = uuidv7(Date.now() - 2 * DAY);
    const known = await access(ws.person, ws.id, ws.general);
    const first = await send(ws.person, ws.id, ws.general, { operationId, text: 'answer lost', ...known });
    expect(first.status).toBe(201);
    await workspaceSql(ws.id, 'UPDATE event SET at = ? WHERE seq = ?', Date.now() - 2 * DAY, first.body.seq);
    await runInDurableObject(workspaceStub(ws.id), (instance) => instance.alarm());
    expect((await events(ws.person, ws.id, ws.general)).body.events.find((e) => e.id === first.body.messageId)).toBeUndefined();

    const retry = await send(ws.person, ws.id, ws.general, { operationId, text: 'answer lost', ...known });
    expect(retry.status).toBe(200);
    expect(retry.body).toEqual(first.body);
    const changed = await send(ws.person, ws.id, ws.general, { operationId, text: 'something else', ...known });
    expect(changed.body.error).toBe('operation_conflict');
    const lookup = await api('GET', `/v1/workspaces/${ws.id}/conversations/${ws.general}/operations/${operationId}`, { token: ws.person.token });
    expect(lookup.body).toEqual({ messageId: first.body.messageId, seq: first.body.seq, visible: false });
    // The receipt goes when no retry can come any more.
    await workspaceSql(ws.id, 'UPDATE receipt SET at = ?', Date.now() - 32 * DAY);
    await runInDurableObject(workspaceStub(ws.id), (instance) => instance.alarm());
    expect(await workspaceSql(ws.id, 'SELECT COUNT(*) AS n FROM receipt')).toEqual([{ n: 0 }]);
  });

  it('answers a message id that is spelled wrong like one that does not exist', async () => {
    const ws = await newWorkspace();
    // 22 characters of base64url whose last one sets bits no 16-byte id has.
    const bent = `e_${'A'.repeat(21)}B`;
    expect((await redact(ws.person, ws.id, ws.general, bent)).status).toBe(404);
    const reply = await post(ws.person, ws.id, ws.general, 'x', { root: bent });
    expect(reply.status).toBe(400);
    expect(reply.body.field).toBe('root');
  });
});

describe('invitations and the channels they lead into', () => {
  it('drops a channel its issuer stopped managing, also when they manage it again', async () => {
    const ws = await newWorkspace();
    const ada = await newMember(ws, 'Ada', { channels: [ws.general] });
    await api('PATCH', `/v1/workspaces/${ws.id}/members/${ada.me.id}`, { token: ws.person.token, body: { role: 'admin' } });
    const role = (value) => api('PATCH', `/v1/workspaces/${ws.id}/channels/${ws.general}/members/${ada.me.id}`, { token: ws.person.token, body: { role: value } });
    await role('manager');
    const demoted = await invite(ada.person, ws.id, { role: 'member', channels: [ws.general] });
    const left = await invite(ada.person, ws.id, { role: 'member', channels: [ws.general] });
    const join = async (secret) => {
      const person = await signup();
      const res = await api('POST', `/v1/workspaces/${ws.id}/join`, { token: person.token, body: { invite: secret, name: 'P' } });
      expect(res.status).toBe(201);
      return (await channels(person, ws.id)).map((c) => c.joined);
    };

    // Demoted and promoted again.
    await role('member');
    await role('manager');
    expect(await join(demoted.secret)).toEqual([false]);
    // Out of the channel and back in as its manager, under a new grant.
    await api('DELETE', `/v1/workspaces/${ws.id}/channels/${ws.general}/members/me`, { token: ada.person.token });
    await api('POST', `/v1/workspaces/${ws.id}/channels/${ws.general}/join`, { token: ada.person.token });
    await role('manager');
    expect(await join(left.secret)).toEqual([false]);
    // One issued now does lead in.
    const fresh = await invite(ada.person, ws.id, { role: 'member', channels: [ws.general] });
    expect(await join(fresh.secret)).toEqual([true]);
  });

  it('shows an admin outside a private channel that an invitation leads into one, not which', async () => {
    const ws = await newWorkspace();
    const ada = await newMember(ws, 'Ada');
    await api('PATCH', `/v1/workspaces/${ws.id}/members/${ada.me.id}`, { token: ws.person.token, body: { role: 'admin' } });
    const board = await channel(ws, 'board', 'private');
    await invite(ws.person, ws.id, { role: 'guest', channels: [board, ws.general] });
    const list = async (person) => (await api('GET', `/v1/workspaces/${ws.id}/invites`, { token: person.token })).body.invites[0];
    expect(await list(ws.person)).toMatchObject({ channels: [board, ws.general], channelCount: 2 });
    const outside = await list(ada.person);
    expect(outside).toMatchObject({ channels: [ws.general], channelCount: 2 });
    expect(JSON.stringify(outside)).not.toContain(board);
  });
});

describe('what an id tells someone who should not know it', () => {
  it('answers a member the same for an id that exists and one that does not', async () => {
    const ws = await newWorkspace();
    const hidden = await newMember(ws, 'Hidden');
    const guest = await newMember(ws, 'Gus', { role: 'guest', channels: [ws.general] });
    const member = await newMember(ws, 'Mila');
    for (const person of [guest.person, member.person]) {
      for (const id of [hidden.me.id, 'u_AAAAAAAAAAAAAAAAAAAAAA']) {
        const role = await api('PATCH', `/v1/workspaces/${ws.id}/members/${id}`, { token: person.token, body: { role: 'guest' } });
        const remove = await api('DELETE', `/v1/workspaces/${ws.id}/members/${id}`, { token: person.token });
        expect([role.status, remove.status], id).toEqual([403, 403]);
      }
    }
    // Leaving by one's own id works like "me".
    expect((await api('DELETE', `/v1/workspaces/${ws.id}/members/${member.me.id}`, { token: member.person.token })).status).toBe(204);
  });

  it('names the account as what ended when a session did', async () => {
    const ended = `${'a'.repeat(43)}.${'b'.repeat(43)}`;
    const list = await api('GET', '/v1/workspaces', { token: ended });
    const make = await api('POST', '/v1/workspaces', { token: ended, body: { name: 'A', displayName: 'B' } });
    expect([list.status, make.status]).toEqual([401, 401]);
    expect([list.body.scope, make.body.scope]).toEqual(['account', 'account']);
  });
});

describe('limits on what one account is in', () => {
  it('holds an account to a number of workspaces it is in at once', async () => {
    const one = await newWorkspace('One');
    const two = await newWorkspace('Two');
    // Making a second while one is the limit.
    const second = await api('POST', '/v1/workspaces', {
      token: one.person.token,
      body: { name: 'Another', displayName: 'P' },
      vars: { MAX_WORKSPACE_MEMBERSHIPS: '1' }
    });
    expect(second.status).toBe(403);
    expect(second.body.error).toBe('workspace_limit');
    // Joining one: the workspace reads the limit from its own settings.
    await runInDurableObject(workspaceStub(two.id), (instance) => {
      const settings = {};
      for (const name of Object.keys(env)) settings[name] = env[name];
      instance.env = { ...settings, MAX_WORKSPACE_MEMBERSHIPS: '1' };
    });
    const { secret } = await invite(two.person, two.id);
    const joined = await api('POST', `/v1/workspaces/${two.id}/join`, { token: one.person.token, body: { invite: secret, name: 'P' } });
    expect(joined.status).toBe(403);
    expect(joined.body.error).toBe('workspace_limit');
    // Someone who is in none gets in, and the invitation was not spent on the refusal.
    const free = await api('POST', `/v1/workspaces/${two.id}/join`, { token: (await signup()).token, body: { invite: secret, name: 'P' } });
    expect(free.status).toBe(201);
    const info = await api('GET', '/v1/info');
    expect(info.body.workspace.limits.membershipsPerAccount).toBe(50);
  });
});

describe('sockets and sessions', () => {
  it('opens no socket on a ticket whose session was signed out since', async () => {
    const ws = await newWorkspace();
    const second = await call('POST', '/v1/login', {
      body: { email: ws.person.email, authKey: ws.person.authKey, device: { name: 'Phone', platform: 'android' } }
    });
    const phone = { token: second.body.token };
    const issued = (await api('POST', `/v1/workspaces/${ws.id}/socket-ticket`, { token: phone.token })).body.ticket;
    // The desktop signs the phone out before the phone uses its ticket.
    const device = second.body.account.devices.find((d) => d.current).id;
    expect((await call('DELETE', `/v1/devices/${device}`, { token: ws.person.token })).status).toBe(204);
    expect((await openSocket(phone, ws.id, { ticket: issued })).status).toBe(401);
    // The refused ticket is spent, and the desktop's own still works.
    expect(await workspaceSql(ws.id, 'SELECT COUNT(*) AS n FROM ticket')).toEqual([{ n: 0 }]);
    const mine = await openSocket(ws.person, ws.id);
    expect(mine.status).toBe(101);
    mine.socket.close(1000);
  });

  it('takes nothing from what members share when a stranger is over their own allowance', async () => {
    const ws = await newWorkspace();
    const stranger = await signup();
    await runInDurableObject(workspaceStub(ws.id), (instance) => {
      const now = Date.now();
      Object.assign(instance.strangers, { tokens: 0, rate: 0.001, at: now });
      Object.assign(instance.ceiling, { tokens: 3, rate: 0.001, at: now });
    });
    for (let i = 0; i < 10; i++) {
      expect((await api('GET', `/v1/workspaces/${ws.id}`, { token: stranger.token })).status).toBe(429);
    }
    // The three requests the workspace had left are still there for its members.
    for (let i = 0; i < 3; i++) expect((await api('GET', `/v1/workspaces/${ws.id}`, { token: ws.person.token })).status).toBe(200);
    expect((await api('GET', `/v1/workspaces/${ws.id}`, { token: ws.person.token })).status).toBe(429);
  });
});

describe('account deletion, twice over', () => {
  const remove = (person) => call('DELETE', '/v1/account', { token: person.token, body: { authKey: person.authKey } });
  const tables = async (email) =>
    runInDurableObject(await accountStub(email), (instance, state) =>
      state.storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf%' ESCAPE '\\'").toArray().map((t) => t.name)
    );
  const memberState = async (ws, id) => (await workspaceSql(ws.id, 'SELECT state, name FROM member WHERE id = ?', id))[0];

  // The state a deletion leaves when its workspace couldn't be reached: the list of who to tell, nothing else.
  async function strand(person, ws) {
    const incarnation = (await call('GET', '/v1/account', { token: person.token })).body.incarnation;
    const stub = await accountStub(person.email);
    await runInDurableObject(stub, async (instance, state) => {
      const sql = state.storage.sql;
      for (const table of ['account', 'sessions', 'records', 'meta', 'booking', 'identity', 'workspaces']) sql.exec(`DROP TABLE IF EXISTS ${table}`);
      sql.exec(
        'CREATE TABLE cleanup (workspace TEXT NOT NULL, incarnation TEXT NOT NULL, createdAt INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (workspace, incarnation))'
      );
      sql.exec('INSERT INTO cleanup VALUES (?, ?, ?, 0)', ws.id, incarnation, Date.now());
      instance.present = false;
      instance.identity = null;
      await state.storage.setAlarm(Date.now() + 60 * 60 * 1000);
    });
    return stub;
  }

  it('still tells the workspace about the first account when the second one is deleted before it heard', async () => {
    const ws = await newWorkspace();
    const mila = await newMember(ws, 'Mila', { channels: [ws.general] });
    await strand(mila.person, ws);
    // The address signs up again, uses no workspace, and deletes that account too.
    const again = await signup({ email: mila.person.email });
    expect((await remove(again)).status).toBe(204);
    expect(await until(async () => (await memberState(ws, mila.me.id)).state === 'deleted')).toBe(true);
    expect(await until(async () => (await tables(mila.person.email)).length === 0)).toBe(true);
  });

  it('tells the workspace about both when the second account had joined it as well', async () => {
    const ws = await newWorkspace();
    const mila = await newMember(ws, 'Mila', { channels: [ws.general] });
    const stub = await strand(mila.person, ws);
    const again = await signup({ email: mila.person.email });
    const { secret } = await invite(ws.person, ws.id);
    const joined = await api('POST', `/v1/workspaces/${ws.id}/join`, { token: again.token, body: { invite: secret, name: 'Mila II' } });
    expect(joined.status).toBe(201);
    // The workspace now has both: the first still looks active, because nobody told it yet.
    expect((await memberState(ws, mila.me.id)).state).toBe('active');

    expect((await remove(again)).status).toBe(204);
    expect(await until(async () => (await memberState(ws, joined.body.me.id)).state === 'deleted')).toBe(true);
    expect(await until(async () => (await memberState(ws, mila.me.id)).state === 'deleted')).toBe(true);
    expect(await until(async () => (await tables(mila.person.email)).length === 0)).toBe(true);
    expect(await runInDurableObject(stub, (instance, state) => state.storage.getAlarm())).toBeNull();
  });

  it('takes the name of someone who left a workspace off it when they delete their account later', async () => {
    const ws = await newWorkspace();
    const mila = await newMember(ws, 'Mila', { channels: [ws.general] });
    await post(mila.person, ws.id, ws.general, 'hello');
    expect((await api('DELETE', `/v1/workspaces/${ws.id}/members/me`, { token: mila.person.token })).status).toBe(204);
    expect(await memberState(ws, mila.me.id)).toEqual({ state: 'left', name: 'Mila' });
    // No longer in their list, and still something the account remembers.
    expect((await api('GET', '/v1/workspaces', { token: mila.person.token })).body.workspaces).toEqual([]);
    const kept = await runInDurableObject(await accountStub(mila.person.email), (instance, state) =>
      state.storage.sql.exec('SELECT id, former FROM workspaces').toArray()
    );
    expect(kept).toEqual([{ id: ws.id, former: 1 }]);

    expect((await remove(mila.person)).status).toBe(204);
    expect(await until(async () => (await memberState(ws, mila.me.id)).state === 'deleted')).toBe(true);
    expect((await memberState(ws, mila.me.id)).name).toBe('');
  });

  it('gives back only the reference it looked at, so a join that recorded it again keeps its own', async () => {
    const ws = await newWorkspace();
    const person = await signup();
    const stub = await accountStub(person.email);
    const first = await runInDurableObject(stub, (instance) => instance.addWorkspace(person.token, ws.id));
    const second = await runInDurableObject(stub, (instance) => instance.addWorkspace(person.token, ws.id));
    expect(first.ref).not.toBe(second.ref);
    const refs = () => runInDurableObject(stub, (instance, state) => state.storage.sql.exec('SELECT version FROM workspaces').toArray());

    // A list that saw the first reference and found no membership gives that one back. The second stays.
    await runInDurableObject(stub, (instance) => instance.dropWorkspace(first.incarnation, ws.id, first.ref));
    expect(await refs()).toEqual([{ version: second.ref }]);
    await runInDurableObject(stub, (instance) => instance.leftWorkspace(first.incarnation, ws.id, first.ref));
    expect(await runInDurableObject(stub, (instance, state) => state.storage.sql.exec('SELECT former FROM workspaces').one().former)).toBe(0);
    await runInDurableObject(stub, (instance) => instance.dropWorkspace(first.incarnation, ws.id, second.ref));
    expect(await refs()).toEqual([]);
    // Another account's incarnation changes nothing.
    const third = await runInDurableObject(stub, (instance) => instance.addWorkspace(person.token, ws.id));
    await runInDurableObject(stub, (instance) => instance.dropWorkspace('someone-else', ws.id, third.ref));
    expect(await refs()).toEqual([{ version: third.ref }]);
  });

  it('does not make a workspace for an account that was deleted while it was being made', async () => {
    const id = 'w_raceRaceRaceRaceRaceRA';
    const stub = workspaceStub(id);
    // The account's deletion reaches the workspace-to-be first.
    expect(await runInDurableObject(stub, (instance) => instance.retire('gone-incarnation'))).toBe(true);
    const who = { incarnation: 'gone-incarnation', class: 'full', session: 's', name: 'a'.repeat(43), ref: 'r' };
    const made = await runInDurableObject(stub, (instance) => instance.create(who, { id, name: 'Late', displayName: 'Ghost' }));
    expect(made.status).toBe(401);
    expect(await runInDurableObject(stub, (instance) => instance.present)).toBe(false);
    // Anyone else's workspace is made as usual.
    const other = await runInDurableObject(stub, (instance) => instance.create({ ...who, incarnation: 'alive' }, { id, name: 'Fine', displayName: 'Owner' }));
    expect(other.status).toBe(201);
    await runDurableObjectAlarm(stub);
  });
});
