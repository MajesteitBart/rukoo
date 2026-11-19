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
  block,
  changes,
  channels,
  events,
  fillers,
  invite,
  newMember,
  newWorkspace,
  openDmLane,
  openSocket,
  post,
  send,
  startDm,
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
    // Not general: every member gets that one on joining, whatever the invitation says.
    const project = await channel(ws, 'project');
    const ada = await newMember(ws, 'Ada', { channels: [project] });
    await api('PATCH', `/v1/workspaces/${ws.id}/members/${ada.me.id}`, { token: ws.person.token, body: { role: 'admin' } });
    const role = (value) => api('PATCH', `/v1/workspaces/${ws.id}/channels/${project}/members/${ada.me.id}`, { token: ws.person.token, body: { role: value } });
    await role('manager');
    const demoted = await invite(ada.person, ws.id, { role: 'member', channels: [project] });
    const left = await invite(ada.person, ws.id, { role: 'member', channels: [project] });
    const join = async (secret) => {
      const person = await signup();
      const res = await api('POST', `/v1/workspaces/${ws.id}/join`, { token: person.token, body: { invite: secret, name: 'P' } });
      expect(res.status).toBe(201);
      return (await channels(person, ws.id)).map((c) => [c.name, c.joined]);
    };

    // Demoted and promoted again.
    await role('member');
    await role('manager');
    expect(await join(demoted.secret)).toEqual([['general', true], ['project', false]]);
    // Out of the channel and back in as its manager, under a new grant.
    await api('DELETE', `/v1/workspaces/${ws.id}/channels/${project}/members/me`, { token: ada.person.token });
    await api('POST', `/v1/workspaces/${ws.id}/channels/${project}/join`, { token: ada.person.token });
    await role('manager');
    expect(await join(left.secret)).toEqual([['general', true], ['project', false]]);
    // One issued now does lead in.
    const fresh = await invite(ada.person, ws.id, { role: 'member', channels: [project] });
    expect(await join(fresh.secret)).toEqual([['general', true], ['project', true]]);
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

describe('what an invitation and a guest are told, kept current', () => {
  it('counts only the channels an invitation still leads into', async () => {
    const ws = await newWorkspace();
    const side = await channel(ws, 'side');
    const made = await invite(ws.person, ws.id, { role: 'member', channels: [ws.general, side] });
    const count = async () => {
      const listed = (await api('GET', `/v1/workspaces/${ws.id}/invites`, { token: ws.person.token })).body.invites[0];
      const preview = await api('POST', `/v1/workspaces/${ws.id}/invites/preview`, { token: (await signup()).token, body: { invite: made.secret } });
      return [listed.channelCount, listed.channels.length, preview.body.channels];
    };
    expect(await count()).toEqual([2, 2, 2]);
    await api('PATCH', `/v1/workspaces/${ws.id}/channels/${side}`, { token: ws.person.token, body: { archived: true } });
    expect(await count()).toEqual([1, 1, 1]);
  });

  it('counts the default channel a member invitation leads into, as joining does', async () => {
    const ws = await newWorkspace();
    const side = await channel(ws, 'side');
    const told = async (made) => {
      const listed = (await api('GET', `/v1/workspaces/${ws.id}/invites`, { token: ws.person.token })).body.invites.find(
        (i) => i.id === made.invite.id
      );
      const preview = await api('POST', `/v1/workspaces/${ws.id}/invites/preview`, { token: (await signup()).token, body: { invite: made.secret } });
      return [made.invite.channelCount, listed.channelCount, listed.channels, preview.body.channels];
    };
    // A member invitation that names no channel still leads into general.
    expect(await told(await invite(ws.person, ws.id, { role: 'member' }))).toEqual([1, 1, [ws.general], 1]);
    // One that names another channel leads into both, and general isn't counted twice when it's named.
    expect(await told(await invite(ws.person, ws.id, { role: 'member', channels: [side] }))).toEqual([2, 2, [side, ws.general], 2]);
    expect(await told(await invite(ws.person, ws.id, { role: 'member', channels: [ws.general] }))).toEqual([1, 1, [ws.general], 1]);
    // A guest gets only what the invitation names.
    expect(await told(await invite(ws.person, ws.id, { role: 'guest', channels: [side] }))).toEqual([1, 1, [side], 1]);
    // And joining puts the member where the count said.
    const made = await invite(ws.person, ws.id, { role: 'member', channels: [side] });
    const mila = await signup();
    await api('POST', `/v1/workspaces/${ws.id}/join`, { token: mila.token, body: { invite: made.secret, name: 'Mila' } });
    const rooms = (await api('GET', `/v1/workspaces/${ws.id}/channels`, { token: mila.token })).body.channels;
    expect(rooms.filter((c) => c.joined).length).toBe(made.invite.channelCount);
  });

  it('tells a guest who lost their only room that the people they could see are gone', async () => {
    const ws = await newWorkspace();
    const project = await channel(ws, 'project');
    const guest = await newMember(ws, 'Gus', { role: 'guest', channels: [project] });
    const start = await sync(guest.person, ws.id);
    await api('DELETE', `/v1/workspaces/${ws.id}/channels/${project}/members/${guest.me.id}`, { token: ws.person.token });
    const after = await sync(guest.person, ws.id, start.cursor);
    expect(after.evictions).toEqual([project]);
    expect(after.last.directory.members).toBe(true);
    // In no room at all, the guest still hears of their own name changing on another device.
    await api('PATCH', `/v1/workspaces/${ws.id}/members/me`, { token: guest.person.token, body: { name: 'Gus G.' } });
    expect((await sync(guest.person, ws.id, after.cursor)).last.directory.members).toBe(true);
    expect((await sync(guest.person, ws.id, after.cursor)).last.directory.members).toBe(true);
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

  it('gives a place back at once when a join is refused', async () => {
    const full = await newWorkspace('Full');
    const open = await newWorkspace('Open');
    const person = await signup();
    // The first workspace has no room: the account's reference to it is recorded, then the join is refused.
    await runInDurableObject(workspaceStub(full.id), (instance, state) => {
      for (let i = 0; i < 99; i++) {
        state.storage.sql.exec(
          "INSERT INTO member (id, incarnation, account, role, state, name, joinedAt) VALUES (?, ?, ?, 'member', 'active', 'Filler', 0)",
          `u_filler${i}`,
          `filler-${i}`,
          `filler-${i}`
        );
      }
    });
    const refused = await api('POST', `/v1/workspaces/${full.id}/join`, { token: person.token, body: { invite: (await invite(full.person, full.id)).secret, name: 'P' } });
    expect(refused.status).toBe(413);
    const kept = await runInDurableObject(await accountStub(person.email), (instance, state) => state.storage.sql.exec('SELECT id FROM workspaces').toArray());
    expect(kept).toEqual([]);
    // So with room for one membership, the next join still fits.
    await runInDurableObject(workspaceStub(open.id), (instance) => {
      const settings = {};
      for (const name of Object.keys(env)) settings[name] = env[name];
      instance.env = { ...settings, MAX_WORKSPACE_MEMBERSHIPS: '1' };
    });
    const joined = await api('POST', `/v1/workspaces/${open.id}/join`, { token: person.token, body: { invite: (await invite(open.person, open.id)).secret, name: 'P' } });
    expect(joined.status).toBe(201);
  });

  it('keeps the note of a workspace someone left when their way back in is refused', async () => {
    const ws = await newWorkspace();
    const mila = await newMember(ws, 'Mila');
    await api('DELETE', `/v1/workspaces/${ws.id}/members/me`, { token: mila.person.token });
    const back = await invite(ws.person, ws.id);
    // The workspace fills up, so her join gets as far as the account's reference and is then refused.
    await runInDurableObject(workspaceStub(ws.id), (instance, state) => {
      for (let i = 0; i < 100; i++) {
        state.storage.sql.exec(
          "INSERT INTO member (id, incarnation, account, role, state, name, joinedAt) VALUES (?, ?, ?, 'member', 'active', 'Filler', 0)",
          `u_filler${i}`,
          `filler-${i}`,
          `filler-${i}`
        );
      }
    });
    const refused = await api('POST', `/v1/workspaces/${ws.id}/join`, { token: mila.person.token, body: { invite: back.secret, name: 'Mila' } });
    expect(refused.status).toBe(413);
    const kept = await runInDurableObject(await accountStub(mila.person.email), (instance, state) => state.storage.sql.exec('SELECT id, former FROM workspaces').toArray());
    expect(kept).toEqual([{ id: ws.id, former: 1 }]);
  });

  it('keeps the newest reference on a member when one account joins twice at once', async () => {
    const ws = await newWorkspace();
    const person = await signup();
    const { secret } = await invite(ws.person, ws.id);
    const join = () => api('POST', `/v1/workspaces/${ws.id}/join`, { token: person.token, body: { invite: secret, name: 'Twice' } });
    const both = await Promise.all([join(), join()]);
    expect(both.map((res) => res.status).sort()).toEqual([200, 201]);
    const [account] = await runInDurableObject(await accountStub(person.email), (instance, state) => state.storage.sql.exec('SELECT version, former FROM workspaces').toArray());
    const [member] = await workspaceSql(ws.id, "SELECT ref FROM member WHERE name = 'Twice'");
    expect(member.ref).toBe(account.version);
    // So leaving marks the reference the account actually holds.
    await api('DELETE', `/v1/workspaces/${ws.id}/members/me`, { token: person.token });
    const after = await runInDurableObject(await accountStub(person.email), (instance, state) => state.storage.sql.exec('SELECT former FROM workspaces').one().former);
    expect(after).toBe(1);
  });
});

describe('a place under the server limit', () => {
  const registry = () => env.REGISTRY.get(env.REGISTRY.idFromName('registry'));
  const places = (id) => runInDurableObject(registry(), (instance, state) => state.storage.sql.exec('SELECT made FROM workspace WHERE id = ?', id).toArray());

  it('is confirmed when the workspace is made, and can be taken or given back twice without counting twice', async () => {
    const ws = await newWorkspace();
    expect(await places(ws.id)).toEqual([{ made: 1 }]);
    await runInDurableObject(registry(), async (instance) => {
      await instance.reserveWorkspace(ws.id, 0);
      await instance.releaseWorkspace(ws.id);
    });
    expect(await places(ws.id)).toEqual([{ made: 1 }]);
  });

  it('is settled by asking the workspace when nobody confirmed it or gave it back', async () => {
    const real = await newWorkspace();
    const never = 'w_neverMadeNeverMadeAAAA';
    // Two places from ten minutes ago that were left open: one whose workspace exists, one whose doesn't.
    await runInDurableObject(registry(), (instance, state) => {
      const old = Date.now() - 10 * 60 * 1000;
      state.storage.sql.exec('UPDATE workspace SET made = 0, at = ? WHERE id = ?', old, real.id);
      state.storage.sql.exec('INSERT INTO workspace (id, at, made) VALUES (?, ?, 0)', never, old);
    });
    // The next workspace anyone makes settles them first.
    await newWorkspace('Next');
    expect(await places(real.id)).toEqual([{ made: 1 }]);
    expect(await places(never)).toEqual([]);
  });
});

describe('leaving a workspace and the channels left behind', () => {
  const state = async (ws, id) => (await workspaceSql(ws.id, 'SELECT archivedAt, (SELECT COUNT(*) FROM grants WHERE conversation = c.n) AS people FROM conversation c WHERE id = ?', id))[0];

  it('archives a channel whose only member leaves the workspace, so its place comes free', async () => {
    const ws = await newWorkspace();
    const mila = await newMember(ws, 'Mila');
    const made = await api('POST', `/v1/workspaces/${ws.id}/channels`, { token: mila.person.token, body: { name: 'notes', visibility: 'private' } });
    const notes = made.body.channel.id;
    expect((await api('DELETE', `/v1/workspaces/${ws.id}/members/me`, { token: mila.person.token })).status).toBe(204);
    const left = await state(ws, notes);
    expect(left.people).toBe(0);
    expect(left.archivedAt).toBeGreaterThan(0);
    // Retention collects it like any archived channel.
    await workspaceSql(ws.id, 'UPDATE event SET at = ? WHERE conversation = (SELECT n FROM conversation WHERE id = ?)', Date.now() - 91 * DAY, notes);
    await runInDurableObject(workspaceStub(ws.id), (instance) => instance.alarm());
    expect(await workspaceSql(ws.id, 'SELECT id FROM conversation WHERE id = ?', notes)).toEqual([]);
  });

  it('asks someone who is the only manager of a shared channel to hand it over before they leave', async () => {
    const ws = await newWorkspace();
    const mila = await newMember(ws, 'Mila');
    const tess = await newMember(ws, 'Tess');
    const made = await api('POST', `/v1/workspaces/${ws.id}/channels`, { token: mila.person.token, body: { name: 'project', visibility: 'workspace' } });
    const project = made.body.channel.id;
    await api('POST', `/v1/workspaces/${ws.id}/channels/${project}/join`, { token: tess.person.token });
    const leave = () => api('DELETE', `/v1/workspaces/${ws.id}/members/me`, { token: mila.person.token });

    const refused = await leave();
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ error: 'last_manager', channels: [project] });
    // Still a member, still in the channel.
    expect((await channels(mila.person, ws.id)).find((c) => c.id === project)).toMatchObject({ joined: true, role: 'manager' });
    await api('PATCH', `/v1/workspaces/${ws.id}/channels/${project}/members/${tess.me.id}`, { token: mila.person.token, body: { role: 'manager' } });
    expect((await leave()).status).toBe(204);
    expect(await state(ws, project)).toMatchObject({ archivedAt: null, people: 1 });
  });

  it('lets a manager be removed without waiting for them, and archives what they leave empty', async () => {
    const ws = await newWorkspace();
    const mila = await newMember(ws, 'Mila');
    const tess = await newMember(ws, 'Tess');
    const make = async (name) => (await api('POST', `/v1/workspaces/${ws.id}/channels`, { token: mila.person.token, body: { name, visibility: 'workspace' } })).body.channel.id;
    const shared = await make('shared');
    const alone = await make('alone');
    await api('POST', `/v1/workspaces/${ws.id}/channels/${shared}/join`, { token: tess.person.token });

    expect((await api('DELETE', `/v1/workspaces/${ws.id}/members/${mila.me.id}`, { token: ws.person.token })).status).toBe(204);
    // The shared channel goes on without a manager; the other one had nobody else.
    expect(await state(ws, shared)).toMatchObject({ archivedAt: null, people: 1 });
    expect((await post(tess.person, ws.id, shared, 'still here')).status).toBe(201);
    expect((await state(ws, alone)).archivedAt).toBeGreaterThan(0);
    // The last one out of a channel without a manager archives it too.
    expect((await api('DELETE', `/v1/workspaces/${ws.id}/channels/${shared}/members/me`, { token: tess.person.token })).status).toBe(204);
    expect((await state(ws, shared)).archivedAt).toBeGreaterThan(0);
    const log = (await workspaceSql(ws.id, "SELECT COUNT(*) AS n FROM event WHERE kind = 'channel.archived' AND conversation = (SELECT n FROM conversation WHERE id = ?)", shared))[0];
    expect(log.n).toBe(1);
  });

  it('archives the channels a deleted account leaves empty', async () => {
    const ws = await newWorkspace();
    const mila = await newMember(ws, 'Mila');
    const made = await api('POST', `/v1/workspaces/${ws.id}/channels`, { token: mila.person.token, body: { name: 'mine', visibility: 'private' } });
    const res = await call('DELETE', '/v1/account', { token: mila.person.token, body: { authKey: mila.person.authKey } });
    expect(res.status).toBe(204);
    expect(await until(async () => (await state(ws, made.body.channel.id)).archivedAt > 0)).toBe(true);
  });
});

describe('the alarm behind an account deletion', () => {
  it('fails the deletion when its alarm cannot be set, and has one again whenever the object starts with a list', async () => {
    const ws = await newWorkspace();
    const mila = await newMember(ws, 'Mila');
    const stub = await accountStub(mila.person.email);
    // The alarm can't be stored.
    await runInDurableObject(stub, (instance, state) => {
      state.storage.setAlarm = () => Promise.reject(new Error('storage is unavailable'));
    });
    const failed = await call('DELETE', '/v1/account', { token: mila.person.token, body: { authKey: mila.person.authKey } });
    expect(failed.status).toBe(500);
    await runInDurableObject(stub, (instance, state) => {
      delete state.storage.setAlarm;
    });
    // On the platform the account's tables and the alarm are one write, so a failure keeps both. Here only the alarm
    // was made to fail, which leaves what the safeguard is for: a list of workspaces to tell and no alarm.
    const waiting = await runInDurableObject(stub, async (instance, state) => ({
      rows: state.storage.sql.exec('SELECT COUNT(*) AS n FROM cleanup').one().n,
      alarm: await state.storage.getAlarm()
    }));
    expect(waiting).toEqual({ rows: 1, alarm: null });

    // The object starts again on the same storage, as after any restart.
    const alarm = await runInDurableObject(stub, async (instance, state) => {
      const again = new instance.constructor(state, instance.env);
      await new Promise((resolve) => setTimeout(resolve, 50));
      return state.storage.getAlarm();
    });
    expect(alarm).toBeGreaterThan(Date.now());
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await until(async () => (await workspaceSql(ws.id, 'SELECT state FROM member WHERE id = ?', mila.me.id))[0].state === 'deleted')).toBe(true);
  });
});

describe('small things that go wrong late', () => {
  it('never gives a new channel the inner number of one that was collected', async () => {
    const ws = await newWorkspace();
    const done = await channel(ws, 'done');
    const [{ n: old }] = await workspaceSql(ws.id, 'SELECT n FROM conversation WHERE id = ?', done);
    await api('PATCH', `/v1/workspaces/${ws.id}/channels/${done}`, { token: ws.person.token, body: { archived: true } });
    await workspaceSql(ws.id, 'UPDATE event SET at = ? WHERE conversation = ?', Date.now() - 91 * DAY, old);
    await runInDurableObject(workspaceStub(ws.id), (instance) => instance.alarm());
    expect(await workspaceSql(ws.id, 'SELECT n FROM conversation WHERE id = ?', done)).toEqual([]);
    const next = await channel(ws, 'next');
    const [{ n: fresh }] = await workspaceSql(ws.id, 'SELECT n FROM conversation WHERE id = ?', next);
    expect(fresh).toBeGreaterThan(old);
  });

  it('keeps a member in their own request allowance when an older self of the same account is retired', async () => {
    const ws = await newWorkspace();
    const mila = await newMember(ws, 'Mila');
    const first = (await call('GET', '/v1/account', { token: mila.person.token })).body.incarnation;
    // The same account is a member twice over: once from before, as someone who left, and once now.
    await runInDurableObject(workspaceStub(ws.id), (instance, state) => {
      const sql = state.storage.sql;
      const row = sql.exec('SELECT account FROM member WHERE incarnation = ?', first).one();
      sql.exec(
        "INSERT INTO member (id, incarnation, account, role, state, name, joinedAt, endedAt) VALUES ('u_olderSelfOlderSelfAAAA', 'older-incarnation', ?, 'member', 'left', 'Older', 0, 1)",
        row.account
      );
    });
    await runInDurableObject(workspaceStub(ws.id), (instance) => instance.retire('older-incarnation'));
    const inside = await runInDurableObject(workspaceStub(ws.id), (instance, state) => {
      const account = state.storage.sql.exec('SELECT account FROM member WHERE incarnation = ?', first).one().account;
      return instance.accounts.has(account);
    });
    expect(inside).toBe(true);
  });

  it('opens one socket when the same ticket arrives twice at once', async () => {
    const ws = await newWorkspace();
    const issued = (await api('POST', `/v1/workspaces/${ws.id}/socket-ticket`, { token: ws.person.token })).body.ticket;
    const both = await Promise.all([openSocket(ws.person, ws.id, { ticket: issued }), openSocket(ws.person, ws.id, { ticket: issued })]);
    expect(both.map((socket) => socket.status).sort()).toEqual([101, 401]);
    both.find((socket) => socket.status === 101).socket.close(1000);
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

  it('answers a socket whose workspace was deleted while its session was checked as a missing workspace', async () => {
    const ws = await newWorkspace();
    await api('POST', `/v1/workspaces/${ws.id}/socket-ticket`, { token: ws.person.token });
    const status = await runInDurableObject(workspaceStub(ws.id), async (instance, state) => {
      const nonce = state.storage.sql.exec('SELECT nonce FROM ticket').one().nonce;
      // The account answers only once the workspace is gone.
      let answer;
      const held = new Promise((resolve) => (answer = resolve));
      const real = instance.env;
      const accounts = { idFromName: (name) => name, get: () => ({ session: () => held }) };
      instance.env = Object.assign(Object.create(real), { ACCOUNTS: accounts });
      try {
        const upgrade = instance.fetch(new Request('https://accounts.example/socket', { headers: { upgrade: 'websocket', 'x-ticket': nonce } }));
        instance.present = false;
        await state.storage.deleteAll();
        answer(true);
        return (await upgrade).status;
      } finally {
        instance.env = real;
      }
    });
    expect(status).toBe(426);
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

describe('direct messages, in an awkward order', () => {
  // Open DMs whose people include both sides of a block. There must never be one.
  const blockedOpen = (ws) =>
    workspaceSql(
      ws.id,
      `SELECT COUNT(*) AS n FROM conversation c JOIN block b
       WHERE c.kind = 'dm' AND c.archivedAt IS NULL
         AND (',' || c.dmSet || ',') LIKE ('%,' || b.blocker || ',%')
         AND (',' || c.dmSet || ',') LIKE ('%,' || b.blocked || ',%')`
    );

  // A DM with a message in it, so that closing it keeps it.
  async function talking(ws, person, members) {
    const dm = (await startDm(person, ws.id, members)).body.dm.conversation;
    expect((await post(person, ws.id, dm, 'first')).status).toBe(201);
    return dm;
  }

  it('opens one DM when both people start it at once', async () => {
    const ws = await newWorkspace();
    const mila = await newMember(ws, 'Mila');
    const both = await Promise.all([startDm(ws.person, ws.id, [mila.me.id]), startDm(mila.person, ws.id, [ws.me.id])]);
    expect(both.map((res) => res.status).sort()).toEqual([200, 201]);
    expect(both[0].body.dm.conversation).toBe(both[1].body.dm.conversation);
    expect(await workspaceSql(ws.id, "SELECT COUNT(*) AS n FROM conversation WHERE kind = 'dm'")).toEqual([{ n: 1 }]);
  });

  it('never leaves an open DM between two people when a start and a block cross', async () => {
    const ws = await newWorkspace();
    const people = [];
    for (const name of ['Mila', 'Tess', 'Una']) people.push(await newMember(ws, name));
    // Each person starts a DM with the owner while the owner blocks them, in both directions.
    await Promise.all(
      people.flatMap((person, i) =>
        i % 2 === 0
          ? [startDm(person.person, ws.id, [ws.me.id]), block(ws.person, ws.id, person.me.id)]
          : [startDm(ws.person, ws.id, [person.me.id]), block(person.person, ws.id, ws.me.id)]
      )
    );
    expect(await workspaceSql(ws.id, 'SELECT COUNT(*) AS n FROM block')).toEqual([{ n: 3 }]);
    expect(await blockedOpen(ws)).toEqual([{ n: 0 }]);
  });

  it('puts no message in a DM after a block closed it', async () => {
    const ws = await newWorkspace();
    const mila = await newMember(ws, 'Mila');
    const dm = await talking(ws, ws.person, [mila.me.id]);
    const [sent] = await Promise.all([post(mila.person, ws.id, dm, 'crossing'), block(ws.person, ws.id, mila.me.id)]);
    const [row] = await workspaceSql(ws.id, 'SELECT archivedAt, closedWhy FROM conversation WHERE id = ?', dm);
    expect(row.closedWhy).toBe('closed');
    if (sent.status === 201) {
      // It committed first, so it is in the history the block closed.
      const log = (await events(ws.person, ws.id, dm)).body.events;
      expect(log.at(-1)).toMatchObject({ seq: sent.body.seq, text: 'crossing' });
    } else {
      expect(sent.status).toBe(409);
      expect(sent.body).toMatchObject({ error: 'archived', scope: 'conversation' });
    }
  });

  it('closes the DM when a role change to guest and a post cross', async () => {
    const ws = await newWorkspace();
    const mila = await newMember(ws, 'Mila');
    const dm = await talking(ws, ws.person, [mila.me.id]);
    const [, sent] = await Promise.all([
      api('PATCH', `/v1/workspaces/${ws.id}/members/${mila.me.id}`, { token: ws.person.token, body: { role: 'guest' } }),
      post(mila.person, ws.id, dm, 'crossing')
    ]);
    expect(await workspaceSql(ws.id, 'SELECT closedWhy FROM conversation WHERE id = ?', dm)).toEqual([{ closedWhy: 'ineligible' }]);
    if (sent.status === 201) {
      expect((await events(ws.person, ws.id, dm)).body.events.at(-1)).toMatchObject({ seq: sent.body.seq, text: 'crossing' });
    } else {
      expect(sent.status).toBe(409);
      expect(sent.body.error).toBe('archived');
    }
  });

  it('holds one initiator to twenty new DMs a day when twenty-two start at once', async () => {
    const ws = await newWorkspace();
    const people = await fillers(ws.id, 22);
    await openDmLane(ws.person, ws.id);
    const all = await Promise.all(people.map((id) => startDm(ws.person, ws.id, [id])));
    const statuses = all.map((res) => res.status);
    expect(statuses.filter((status) => status === 201)).toHaveLength(20);
    expect(statuses.filter((status) => status === 429)).toHaveLength(2);
    expect(await workspaceSql(ws.id, "SELECT COUNT(*) AS n FROM conversation WHERE kind = 'dm'")).toEqual([{ n: 20 }]);
  });
});

describe('deleting a workspace, in an awkward order', () => {
  it('lets a delete and a join at once end one way or the other, never both', async () => {
    for (let round = 0; round < 3; round++) {
      const ws = await newWorkspace();
      const { secret } = await invite(ws.person, ws.id);
      const joiner = await signup();
      const [deleted, joined] = await Promise.all([
        api('DELETE', `/v1/workspaces/${ws.id}`, { token: ws.person.token }),
        api('POST', `/v1/workspaces/${ws.id}/join`, { token: joiner.token, body: { invite: secret, name: 'P' } })
      ]);
      const mine = (await api('GET', '/v1/workspaces', { token: joiner.token })).body.workspaces;
      if (joined.status === 201) {
        // The join won: the workspace stays, with its new member.
        expect(deleted.status).toBe(409);
        expect(deleted.body.error).toBe('members_remain');
        expect(mine.map((w) => w.id)).toEqual([ws.id]);
      } else {
        expect(deleted.status).toBe(204);
        expect(joined.status).toBe(404);
        expect(joined.body.scope).toBe('workspace');
        expect(mine).toEqual([]);
      }
    }
  });
});
