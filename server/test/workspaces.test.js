// Workspaces: turning team chat on, making a workspace, invitations, members and channels. Who may see and do what
// is the subject of most of these (WORKSPACES.md, Invitations and authority).

import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { call, signup } from './helpers.js';
import { api, channels, events, invite, newMember, newWorkspace, post, workspaceSql, workspaceStub } from './workspace-helpers.js';

describe('turning team chat on', () => {
  it('is off unless the operator turns it on', async () => {
    const person = await signup();
    const info = await call('GET', '/v1/info');
    expect(info.body.features).toEqual(['booking']);
    expect(info.body.workspace).toBeUndefined();
    expect((await call('GET', '/v1/workspaces', { token: person.token })).status).toBe(404);
    expect((await call('POST', '/v1/workspaces', { token: person.token, body: { name: 'A', displayName: 'B' } })).status).toBe(404);
  });

  it('says what the server offers once it is on', async () => {
    const info = await api('GET', '/v1/info');
    expect(info.body.protocol).toBe(1);
    expect(info.body.features).toEqual(['booking', 'workspaces-v1']);
    expect(info.body.workspace).toMatchObject({
      versions: [1],
      home: { origin: 'https://accounts.example' },
      capabilities: [],
      recovery: 'basic',
      limits: { workspacesPerAccount: 3, members: 100, sockets: 200, conversations: 8192, textBytes: 16384 },
      retention: { contentDays: 90, feedDays: 14, platformHistoryDays: 30 }
    });
    // The installation id is made once and stays.
    const installation = info.body.workspace.home.installation;
    expect(installation).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect((await api('GET', '/v1/info')).body.workspace.home.installation).toBe(installation);
    const named = await api('GET', '/v1/info', { vars: { WORKSPACE_ORIGIN: 'https://rukoo.example/' } });
    expect(named.body.workspace.home.origin).toBe('https://rukoo.example');
  });

  it('refuses a version of the protocol it does not speak', async () => {
    const ws = await newWorkspace();
    const res = await api('GET', `/v1/workspaces/${ws.id}`, { token: ws.person.token, headers: { 'rukoo-workspace-version': '2' } });
    expect(res.status).toBe(426);
    expect(res.body).toMatchObject({ error: 'upgrade_required', minVersion: 1 });
    const ok = await api('GET', `/v1/workspaces/${ws.id}`, { token: ws.person.token, headers: { 'rukoo-workspace-version': '1' } });
    expect(ok.status).toBe(200);
  });
});

describe('making a workspace', () => {
  it('gives its maker the owner role and a first channel', async () => {
    const person = await signup();
    const before = await call('GET', '/v1/account', { token: person.token });
    expect(before.body).toMatchObject({ class: 'full', incarnation: null });

    const made = await api('POST', '/v1/workspaces', { token: person.token, body: { name: '  Acme  ', displayName: 'Olga' } });
    expect(made.status).toBe(201);
    expect(made.body.workspace).toMatchObject({ name: 'Acme', retention: { contentDays: 90, feedDays: 14 } });
    expect(made.body.workspace.id).toMatch(/^w_[A-Za-z0-9_-]{22}$/);
    expect(made.body.workspace.keyId).toMatch(/^[A-Za-z0-9_-]{11}$/);
    expect(Math.abs(made.body.workspace.time - Date.now())).toBeLessThan(5000);
    expect(made.body.me).toMatchObject({ name: 'Olga', role: 'owner', state: 'active', kind: 'human' });

    const list = await channels(person, made.body.workspace.id);
    expect(list).toEqual([
      { id: expect.stringMatching(/^c_/), name: 'general', visibility: 'workspace', archived: false, joined: true, role: 'manager', members: 1 }
    ]);

    // The account has an incarnation from its first use of a workspace, and it doesn't change.
    const after = await call('GET', '/v1/account', { token: person.token });
    expect(after.body.incarnation).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect((await call('GET', '/v1/account', { token: person.token })).body.incarnation).toBe(after.body.incarnation);
    // A member's id in the workspace is its own, so two workspaces can't tell they share a person.
    expect(made.body.me.id).not.toContain(after.body.incarnation);
  });

  it('lists the workspaces an account is in, for a device that just signed in', async () => {
    const ws = await newWorkspace('Acme');
    const other = await newWorkspace('Other');
    const member = await newMember(ws, 'Mila');
    expect((await api('GET', '/v1/workspaces', { token: ws.person.token })).body).toEqual({
      workspaces: [{ id: ws.id, name: 'Acme', role: 'owner' }]
    });
    expect((await api('GET', '/v1/workspaces', { token: member.person.token })).body).toEqual({
      workspaces: [{ id: ws.id, name: 'Acme', role: 'member' }]
    });
    expect((await api('GET', '/v1/workspaces', { token: other.person.token })).body.workspaces.map((w) => w.name)).toEqual(['Other']);
    expect((await api('GET', '/v1/workspaces')).status).toBe(401);
  });

  it('limits how many workspaces one account makes, and how many the server holds', async () => {
    const person = await signup();
    const make = (vars) => api('POST', '/v1/workspaces', { token: person.token, body: { name: 'Team', displayName: 'P' }, vars });
    for (let i = 0; i < 3; i++) expect((await make()).status).toBe(201);
    const fourth = await make();
    expect(fourth.status).toBe(403);
    expect(fourth.body.error).toBe('workspace_limit');
    // The refused one gave its place on the server back, and left no reference behind.
    expect((await api('GET', '/v1/workspaces', { token: person.token })).body.workspaces).toHaveLength(3);

    const registry = env.REGISTRY.get(env.REGISTRY.idFromName('registry'));
    const count = () => runInDurableObject(registry, (i, state) => state.storage.sql.exec('SELECT count FROM workspaces').one().count);
    const held = await count();
    const full = await api('POST', '/v1/workspaces', {
      token: (await signup()).token,
      body: { name: 'Team', displayName: 'P' },
      vars: { MAX_WORKSPACES: String(held) }
    });
    expect(full.status).toBe(403);
    expect(full.body.error).toBe('workspaces_full');
    expect(await count()).toBe(held);
  });

  it('checks names', async () => {
    const person = await signup();
    const make = (body) => api('POST', '/v1/workspaces', { token: person.token, body });
    for (const name of ['', '   ', 'x'.repeat(81), 'two\nlines', 42]) {
      const res = await make({ name, displayName: 'P' });
      expect(res.status, JSON.stringify(name)).toBe(400);
      expect(res.body.field).toBe('name');
    }
    expect((await make({ name: 'Team', displayName: '' })).body.field).toBe('displayName');
    expect((await make({ name: 'é'.repeat(80), displayName: 'P' })).status).toBe(201);
    // A family emoji is several characters joined together; a name that turns its text around is a disguise.
    expect((await make({ name: 'Team', displayName: 'Sam 👨‍👩‍👧' })).body.me.name).toBe('Sam 👨‍👩‍👧');
    expect((await make({ name: 'Team', displayName: 'Olga\u202egnp.exe' })).status).toBe(400);
  });

  it('looks the same to an outsider whether a workspace exists or not', async () => {
    const ws = await newWorkspace();
    const outsider = await signup();
    const real = await api('GET', `/v1/workspaces/${ws.id}`, { token: outsider.token });
    const none = await api('GET', '/v1/workspaces/w_AAAAAAAAAAAAAAAAAAAAAA', { token: outsider.token });
    expect(real.status).toBe(404);
    expect(real.body).toEqual(none.body);
    expect(real.body).toMatchObject({ error: 'not_found', scope: 'workspace' });
    expect((await api('GET', `/v1/workspaces/${ws.id}/channels`, { token: outsider.token })).status).toBe(404);
    expect((await api('GET', `/v1/workspaces/${ws.id}/changes`, { token: outsider.token })).status).toBe(404);
    // No session at all is a different answer: sign in, not "you were removed".
    const signedOut = await api('GET', `/v1/workspaces/${ws.id}`, { token: `${'a'.repeat(43)}.${'b'.repeat(43)}` });
    expect(signedOut.status).toBe(401);
    expect(signedOut.body.scope).toBe('account');
    expect((await api('GET', `/v1/workspaces/${ws.id}`)).status).toBe(401);
  });
});

describe('invitations', () => {
  it('shows what an invitation is for, then lets one account in, once', async () => {
    const ws = await newWorkspace('Acme', 'Olga');
    const made = await invite(ws.person, ws.id, { role: 'member', channels: [ws.general] });
    expect(made.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(made.invite).toMatchObject({ role: 'member', channels: [ws.general], issuer: ws.me.id });
    expect(made.invite.expiresAt - made.invite.createdAt).toBe(24 * 60 * 60 * 1000);
    // Only a hash of the secret is stored.
    const stored = await workspaceSql(ws.id, 'SELECT * FROM invite');
    expect(JSON.stringify(stored)).not.toContain(made.secret);

    const mila = await signup();
    const preview = await api('POST', `/v1/workspaces/${ws.id}/invites/preview`, { token: mila.token, body: { invite: made.secret } });
    expect(preview.body).toEqual({
      workspace: { id: ws.id, name: 'Acme' },
      role: 'member',
      channels: 1,
      issuer: { name: 'Olga' },
      expiresAt: made.invite.expiresAt
    });

    const joined = await api('POST', `/v1/workspaces/${ws.id}/join`, { token: mila.token, body: { invite: made.secret, name: 'Mila' } });
    expect(joined.status).toBe(201);
    expect(joined.body.me).toMatchObject({ name: 'Mila', role: 'member' });
    // The invitation's channel came with it.
    expect((await channels(mila, ws.id)).map((c) => [c.name, c.joined, c.role, c.members])).toEqual([['general', true, 'member', 2]]);

    // The same person asking again gets their membership; anyone else finds the invitation spent.
    const again = await api('POST', `/v1/workspaces/${ws.id}/join`, { token: mila.token, body: { invite: made.secret, name: 'Other name' } });
    expect(again.status).toBe(200);
    expect(again.body.me).toMatchObject({ id: joined.body.me.id, name: 'Mila' });
    const third = await api('POST', `/v1/workspaces/${ws.id}/join`, { token: (await signup()).token, body: { invite: made.secret, name: 'Tess' } });
    expect(third.status).toBe(410);
    expect(third.body.error).toBe('invite_gone');
    expect((await api('GET', `/v1/workspaces/${ws.id}/invites`, { token: ws.person.token })).body.invites).toEqual([]);
  });

  it('refuses a wrong, withdrawn or expired invitation', async () => {
    const ws = await newWorkspace();
    const person = await signup();
    const join = (secret) => api('POST', `/v1/workspaces/${ws.id}/join`, { token: person.token, body: { invite: secret, name: 'P' } });

    // A secret nobody issued looks like a workspace that isn't there.
    const wrong = await join('A'.repeat(43));
    expect(wrong.status).toBe(404);
    expect(wrong.body.scope).toBe('workspace');
    expect((await join('short')).status).toBe(400);

    const revoked = await invite(ws.person, ws.id);
    expect((await api('GET', `/v1/workspaces/${ws.id}/invites`, { token: ws.person.token })).body.invites).toHaveLength(1);
    expect((await api('DELETE', `/v1/workspaces/${ws.id}/invites/${revoked.invite.id}`, { token: ws.person.token })).status).toBe(204);
    expect((await join(revoked.secret)).status).toBe(410);

    const expired = await invite(ws.person, ws.id, { role: 'member', expiresIn: 60 });
    expect(expired.invite.expiresAt - expired.invite.createdAt).toBe(60 * 1000);
    await workspaceSql(ws.id, 'UPDATE invite SET expiresAt = ? WHERE id = ?', Date.now() - 1, expired.invite.id);
    expect((await join(expired.secret)).status).toBe(410);
    // Nothing made this account a member, and the reference it took is given back the next time it lists.
    expect((await api('GET', `/v1/workspaces/${ws.id}`, { token: person.token })).status).toBe(404);
    expect((await api('GET', '/v1/workspaces', { token: person.token })).body.workspaces).toEqual([]);
  });

  it('stops working when its issuer leaves or loses the role to invite', async () => {
    const ws = await newWorkspace();
    const admin = await newMember(ws, 'Ada');
    await api('PATCH', `/v1/workspaces/${ws.id}/members/${admin.me.id}`, { token: ws.person.token, body: { role: 'admin' } });
    const first = await invite(admin.person, ws.id);
    const second = await invite(admin.person, ws.id);
    const join = async (secret) =>
      api('POST', `/v1/workspaces/${ws.id}/join`, { token: (await signup()).token, body: { invite: secret, name: 'P' } });

    await api('PATCH', `/v1/workspaces/${ws.id}/members/${admin.me.id}`, { token: ws.person.token, body: { role: 'member' } });
    expect((await join(first.secret)).status).toBe(410);
    await api('PATCH', `/v1/workspaces/${ws.id}/members/${admin.me.id}`, { token: ws.person.token, body: { role: 'admin' } });
    expect((await join(first.secret)).status).toBe(201);

    // Removing the issuer withdraws what they issued, also if they come back.
    await api('DELETE', `/v1/workspaces/${ws.id}/members/${admin.me.id}`, { token: ws.person.token });
    expect((await join(second.secret)).status).toBe(410);
  });

  it('is for owners and admins to issue, into channels they manage', async () => {
    const ws = await newWorkspace();
    const member = await newMember(ws);
    const ask = (person, body) => api('POST', `/v1/workspaces/${ws.id}/invites`, { token: person.token, body });
    expect((await ask(member.person, { role: 'member' })).status).toBe(403);
    expect((await api('GET', `/v1/workspaces/${ws.id}/invites`, { token: member.person.token })).status).toBe(403);
    expect((await ask(ws.person, { role: 'owner' })).status).toBe(400);
    expect((await ask(ws.person, { role: 'guest', channels: ['c_AAAAAAAAAAAAAAAAAAAAAA'] })).status).toBe(404);

    // An admin who is in a channel without managing it can't invite into it.
    await api('PATCH', `/v1/workspaces/${ws.id}/members/${member.me.id}`, { token: ws.person.token, body: { role: 'admin' } });
    await api('POST', `/v1/workspaces/${ws.id}/channels/${ws.general}/join`, { token: member.person.token });
    expect((await ask(member.person, { role: 'guest', channels: [ws.general] })).status).toBe(403);
    expect((await ask(member.person, { role: 'guest' })).status).toBe(201);
  });

  it('holds a workspace to its member limit', async () => {
    const ws = await newWorkspace();
    const { secret } = await invite(ws.person, ws.id);
    await runInDurableObject(workspaceStub(ws.id), (instance, state) => {
      for (let i = 0; i < 99; i++) {
        state.storage.sql.exec(
          "INSERT INTO member (id, incarnation, account, role, state, name, joinedAt) VALUES (?, ?, ?, 'member', 'active', 'Filler', 0)",
          `u_filler${i}`,
          `filler-${i}`,
          `filler-${i}`
        );
      }
    });
    const full = await api('POST', `/v1/workspaces/${ws.id}/join`, { token: (await signup()).token, body: { invite: secret, name: 'P' } });
    expect(full.status).toBe(413);
    expect(full.body).toMatchObject({ error: 'quota', scope: 'workspace' });
  });
});

describe('members', () => {
  it('lets owners appoint, admins manage members and guests, and nobody orphan the workspace', async () => {
    const ws = await newWorkspace();
    const admin = await newMember(ws, 'Ada');
    const member = await newMember(ws, 'Mila');
    const role = (by, who, value) => api('PATCH', `/v1/workspaces/${ws.id}/members/${who.me.id}`, { token: by.token, body: { role: value } });

    expect((await role(member.person, admin, 'guest')).status).toBe(403);
    expect((await role(ws.person, admin, 'admin')).body.member.role).toBe('admin');
    // An admin moves people between member and guest, and nothing above that.
    expect((await role(admin.person, member, 'guest')).status).toBe(200);
    expect((await role(admin.person, member, 'member')).status).toBe(200);
    expect((await role(admin.person, member, 'admin')).status).toBe(403);
    expect((await role(admin.person, { me: ws.me }, 'member')).status).toBe(403);
    expect((await role(ws.person, member, 'wizard')).status).toBe(400);

    // The only owner can't step down or leave.
    const down = await role(ws.person, { me: ws.me }, 'admin');
    expect(down.status).toBe(409);
    expect(down.body.error).toBe('last_owner');
    expect((await api('DELETE', `/v1/workspaces/${ws.id}/members/me`, { token: ws.person.token })).status).toBe(409);
    // With a second owner, the first can.
    expect((await role(ws.person, admin, 'owner')).status).toBe(200);
    expect((await role(ws.person, { me: ws.me }, 'member')).status).toBe(200);
  });

  it('shows full members everyone and a guest only who they share a channel with', async () => {
    const ws = await newWorkspace('Acme', 'Olga');
    const member = await newMember(ws, 'Mila');
    const guest = await newMember(ws, 'Gus', { role: 'guest', channels: [ws.general] });
    const names = async (person) =>
      (await api('GET', `/v1/workspaces/${ws.id}/members`, { token: person.token })).body.members.map((m) => m.name).sort();
    expect(await names(ws.person)).toEqual(['Gus', 'Mila', 'Olga']);
    expect(await names(member.person)).toEqual(['Gus', 'Mila', 'Olga']);
    // Mila hasn't joined general, so the guest doesn't see her.
    expect(await names(guest.person)).toEqual(['Gus', 'Olga']);

    const renamed = await api('PATCH', `/v1/workspaces/${ws.id}/members/me`, { token: guest.person.token, body: { name: 'Gus G.' } });
    expect(renamed.body.me.name).toBe('Gus G.');
    expect(await names(ws.person)).toEqual(['Gus G.', 'Mila', 'Olga']);
  });

  it('ends everything for a removed member and keeps their place for when they return', async () => {
    const ws = await newWorkspace();
    const member = await newMember(ws, 'Mila', { channels: [ws.general] });
    const sent = await post(member.person, ws.id, ws.general, 'hello');
    expect(sent.status).toBe(201);

    // A member can't remove someone; an admin can't remove an owner.
    const other = await newMember(ws, 'Tess');
    expect((await api('DELETE', `/v1/workspaces/${ws.id}/members/${member.me.id}`, { token: other.person.token })).status).toBe(403);

    expect((await api('DELETE', `/v1/workspaces/${ws.id}/members/${member.me.id}`, { token: ws.person.token })).status).toBe(204);
    for (const path of ['', '/channels', '/members', '/changes', `/conversations/${ws.general}/events`]) {
      const res = await api('GET', `/v1/workspaces/${ws.id}${path}`, { token: member.person.token });
      expect(res.status, path).toBe(404);
      expect(res.body.scope).toBe('workspace');
    }
    expect((await post(member.person, ws.id, ws.general, 'still here?')).status).toBe(404);
    expect((await api('GET', '/v1/workspaces', { token: member.person.token })).body.workspaces).toEqual([]);

    // Their message stays, under their name, and the channel shows that they left.
    const members = (await api('GET', `/v1/workspaces/${ws.id}/members`, { token: ws.person.token })).body.members;
    expect(members.find((m) => m.id === member.me.id)).toMatchObject({ name: 'Mila', state: 'removed' });
    const log = (await events(ws.person, ws.id, ws.general)).body.events;
    expect(log.at(-1)).toMatchObject({ kind: 'member.left', member: member.me.id, actor: ws.me.id });
    expect(log.find((e) => e.kind === 'message.posted')).toMatchObject({ text: 'hello', actor: member.me.id });

    // Invited again, they are the same member, and start without channels.
    const { secret } = await invite(ws.person, ws.id);
    const back = await api('POST', `/v1/workspaces/${ws.id}/join`, { token: member.person.token, body: { invite: secret, name: 'Mila again' } });
    expect(back.status).toBe(201);
    expect(back.body.me).toMatchObject({ id: member.me.id, name: 'Mila again', state: 'active' });
    expect((await channels(member.person, ws.id)).map((c) => [c.name, c.joined])).toEqual([['general', false]]);
  });

  it('lets a member leave on their own', async () => {
    const ws = await newWorkspace();
    const member = await newMember(ws, 'Mila', { channels: [ws.general] });
    expect((await api('DELETE', `/v1/workspaces/${ws.id}/members/me`, { token: member.person.token })).status).toBe(204);
    expect((await api('GET', `/v1/workspaces/${ws.id}`, { token: member.person.token })).status).toBe(404);
    const members = (await api('GET', `/v1/workspaces/${ws.id}/members`, { token: ws.person.token })).body.members;
    expect(members.find((m) => m.id === member.me.id).state).toBe('left');
  });
});

describe('channels', () => {
  it('lets full members find and join a channel the workspace can see', async () => {
    const ws = await newWorkspace();
    const member = await newMember(ws, 'Mila');
    expect((await channels(member.person, ws.id)).map((c) => [c.name, c.joined, c.role])).toEqual([['general', false, null]]);
    // Not in it yet: no reading, no posting.
    expect((await events(member.person, ws.id, ws.general)).status).toBe(404);
    expect((await post(member.person, ws.id, ws.general, 'hi')).status).toBe(404);

    const joined = await api('POST', `/v1/workspaces/${ws.id}/channels/${ws.general}/join`, { token: member.person.token });
    expect(joined.body.channel).toMatchObject({ name: 'general', joined: true, role: 'member', members: 2 });
    // Asking twice changes nothing.
    await api('POST', `/v1/workspaces/${ws.id}/channels/${ws.general}/join`, { token: member.person.token });
    const log = (await events(member.person, ws.id, ws.general)).body.events;
    expect(log.map((e) => e.kind)).toEqual(['channel.created', 'member.joined', 'member.joined']);
    // Joining gives the channel's earlier history, and the join is an event in its order.
    expect(log[2]).toMatchObject({ seq: 3, member: member.me.id, actor: member.me.id });
    expect((await post(member.person, ws.id, ws.general, 'hi')).status).toBe(201);
  });

  it('hides a private channel from everyone who is not in it', async () => {
    const ws = await newWorkspace();
    const member = await newMember(ws, 'Mila');
    const made = await api('POST', `/v1/workspaces/${ws.id}/channels`, { token: ws.person.token, body: { name: 'board', visibility: 'private' } });
    expect(made.status).toBe(201);
    const secret = made.body.channel.id;
    await post(ws.person, ws.id, secret, 'the plan');

    expect((await channels(member.person, ws.id)).map((c) => c.name)).toEqual(['general']);
    const missing = 'c_AAAAAAAAAAAAAAAAAAAAAA';
    const probe = async (method, path, body) => {
      const real = await api(method, `/v1/workspaces/${ws.id}${path(secret)}`, { token: member.person.token, body });
      const none = await api(method, `/v1/workspaces/${ws.id}${path(missing)}`, { token: member.person.token, body });
      expect(real.status, path(secret)).toBe(404);
      expect(real.body, path(secret)).toEqual(none.body);
    };
    await probe('GET', (c) => `/conversations/${c}/events`);
    await probe('POST', (c) => `/channels/${c}/join`);
    await probe('GET', (c) => `/channels/${c}/members`);
    await probe('PATCH', (c) => `/channels/${c}`, { archived: true });
    await probe('PATCH', (c) => `/channels/${c}`, { name: 'mine' });
    await probe('POST', (c) => `/conversations/${c}/read`, { seq: 1 });
    await probe('DELETE', (c) => `/channels/${c}/members/me`);
    await probe('POST', (c) => `/channels/${c}/members`, { member: member.me.id });
    const sent = await post(member.person, ws.id, secret, 'let me in');
    expect(sent.status).toBe(404);
    // Nor does the feed mention it.
    const feed = await api('GET', `/v1/workspaces/${ws.id}/changes`, { token: member.person.token });
    expect(JSON.stringify(feed.body)).not.toContain(secret);

    // Its manager lets the member in, who then reads what was said before.
    const admitted = await api('POST', `/v1/workspaces/${ws.id}/channels/${secret}/members`, { token: ws.person.token, body: { member: member.me.id } });
    expect(admitted.body).toEqual({ member: member.me.id, role: 'member' });
    expect((await channels(member.person, ws.id)).map((c) => [c.name, c.visibility])).toEqual([
      ['board', 'private'],
      ['general', 'workspace']
    ]);
    expect((await events(member.person, ws.id, secret)).body.events.find((e) => e.kind === 'message.posted').text).toBe('the plan');
    expect((await api('GET', `/v1/workspaces/${ws.id}/channels/${secret}/members`, { token: member.person.token })).body.members).toEqual([
      { member: ws.me.id, role: 'manager' },
      { member: member.me.id, role: 'member' }
    ]);
    // A member of the channel who doesn't manage it can't let others in.
    const third = await newMember(ws, 'Tess');
    expect(
      (await api('POST', `/v1/workspaces/${ws.id}/channels/${secret}/members`, { token: member.person.token, body: { member: third.me.id } })).status
    ).toBe(403);
  });

  it('shows a guest only the channels they were let into', async () => {
    const ws = await newWorkspace();
    const open = (await api('POST', `/v1/workspaces/${ws.id}/channels`, { token: ws.person.token, body: { name: 'project', visibility: 'workspace' } })).body.channel.id;
    const guest = await newMember(ws, 'Gus', { role: 'guest', channels: [open] });
    expect((await channels(guest.person, ws.id)).map((c) => c.name)).toEqual(['project']);
    // The channel everyone else can see doesn't exist for the guest, and neither does making one.
    expect((await api('POST', `/v1/workspaces/${ws.id}/channels/${ws.general}/join`, { token: guest.person.token })).status).toBe(404);
    expect((await events(guest.person, ws.id, ws.general)).status).toBe(404);
    expect((await api('GET', `/v1/workspaces/${ws.id}/channels/${ws.general}/members`, { token: guest.person.token })).status).toBe(404);
    const made = await api('POST', `/v1/workspaces/${ws.id}/channels`, { token: guest.person.token, body: { name: 'mine', visibility: 'private' } });
    expect(made.status).toBe(403);
    expect((await post(guest.person, ws.id, open, 'hello from outside')).status).toBe(201);

    // Letting a guest into a channel takes a manager who is also an admin.
    const manager = await newMember(ws, 'Mila');
    const theirs = (await api('POST', `/v1/workspaces/${ws.id}/channels`, { token: manager.person.token, body: { name: 'side', visibility: 'private' } })).body.channel.id;
    const add = () => api('POST', `/v1/workspaces/${ws.id}/channels/${theirs}/members`, { token: manager.person.token, body: { member: guest.me.id } });
    const refused = await add();
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe('cosign_required');
    await api('PATCH', `/v1/workspaces/${ws.id}/members/${manager.me.id}`, { token: ws.person.token, body: { role: 'admin' } });
    expect((await add()).status).toBe(200);
    expect((await channels(guest.person, ws.id)).map((c) => c.name)).toEqual(['project', 'side']);
  });

  it('keeps visible channel names unique without giving private ones away', async () => {
    const ws = await newWorkspace();
    const make = (name, visibility) => api('POST', `/v1/workspaces/${ws.id}/channels`, { token: ws.person.token, body: { name, visibility } });
    expect((await make('board', 'private')).status).toBe(201);
    // A visible channel may take a private one's name: refusing would say the private one exists.
    expect((await make('Board', 'workspace')).status).toBe(201);
    expect((await make('board', 'private')).status).toBe(201);
    const taken = await make('BOARD', 'workspace');
    expect(taken.status).toBe(409);
    expect(taken.body.error).toBe('name_taken');
    expect((await make('General', 'workspace')).status).toBe(409);
    expect((await make('x', 'secret')).status).toBe(400);
  });

  it('renames and archives', async () => {
    const ws = await newWorkspace();
    const member = await newMember(ws, 'Mila', { channels: [ws.general] });
    const patch = (person, body, c = ws.general) => api('PATCH', `/v1/workspaces/${ws.id}/channels/${c}`, { token: person.token, body });
    expect((await patch(member.person, { name: 'lobby' })).status).toBe(403);
    expect((await patch(member.person, { archived: true })).status).toBe(403);
    expect((await patch(ws.person, { name: 'lobby' })).body.channel.name).toBe('lobby');

    await post(member.person, ws.id, ws.general, 'before');
    const archived = await patch(ws.person, { archived: true });
    expect(archived.body.channel).toMatchObject({ name: 'lobby', archived: true });
    // Archived for good: no posting, joining or renaming, and asking again changes nothing.
    const sent = await post(member.person, ws.id, ws.general, 'after');
    expect(sent.status).toBe(409);
    expect(sent.body).toMatchObject({ error: 'archived', scope: 'conversation' });
    expect((await patch(ws.person, { name: 'again' })).status).toBe(409);
    expect((await patch(ws.person, { archived: true })).status).toBe(200);
    const log = (await events(member.person, ws.id, ws.general)).body.events;
    expect(log.map((e) => e.kind)).toEqual(['channel.created', 'member.joined', 'member.joined', 'channel.renamed', 'message.posted', 'channel.archived']);
    expect(log[3]).toMatchObject({ name: 'lobby' });
    // It is still there for the people in it, and gone from the directory for everyone else.
    expect((await channels(member.person, ws.id)).map((c) => [c.name, c.archived])).toEqual([['lobby', true]]);
    const newcomer = await newMember(ws, 'Tess');
    expect(await channels(newcomer.person, ws.id)).toEqual([]);
    expect((await api('POST', `/v1/workspaces/${ws.id}/channels/${ws.general}/join`, { token: newcomer.person.token })).status).toBe(409);

    // An admin archives a channel the workspace can see without being in it.
    const open = (await api('POST', `/v1/workspaces/${ws.id}/channels`, { token: member.person.token, body: { name: 'open', visibility: 'workspace' } })).body.channel.id;
    expect((await patch(ws.person, { archived: true }, open)).body.channel).toMatchObject({ archived: true, joined: false });
  });

  it('asks a leaving manager who takes over, and archives a channel its last member leaves', async () => {
    const ws = await newWorkspace();
    const member = await newMember(ws, 'Mila', { channels: [ws.general] });
    const leave = (person, who = 'me', query = '') =>
      api('DELETE', `/v1/workspaces/${ws.id}/channels/${ws.general}/members/${who}${query}`, { token: person.token });

    // A member can't take someone else out.
    expect((await leave(member.person, ws.me.id)).status).toBe(403);
    const alone = await leave(ws.person);
    expect(alone.status).toBe(409);
    expect(alone.body.error).toBe('last_manager');
    expect((await leave(ws.person, 'me', `?successor=${ws.me.id}`)).status).toBe(409);
    expect((await leave(ws.person, 'me', `?successor=${member.me.id}`)).status).toBe(204);
    expect((await channels(member.person, ws.id)).map((c) => [c.name, c.role, c.members])).toEqual([['general', 'manager', 1]]);
    expect((await events(ws.person, ws.id, ws.general)).status).toBe(404);

    // The last one out archives it.
    expect((await leave(member.person)).status).toBe(204);
    const row = await workspaceSql(ws.id, 'SELECT archivedAt FROM conversation WHERE id = ?', ws.general);
    expect(row[0].archivedAt).toBeGreaterThan(0);

    // A manager can appoint another and then step back, or take someone out.
    const other = (await api('POST', `/v1/workspaces/${ws.id}/channels`, { token: ws.person.token, body: { name: 'other', visibility: 'workspace' } })).body.channel.id;
    await api('POST', `/v1/workspaces/${ws.id}/channels/${other}/join`, { token: member.person.token });
    const role = (who, value) => api('PATCH', `/v1/workspaces/${ws.id}/channels/${other}/members/${who}`, { token: ws.person.token, body: { role: value } });
    expect((await role(ws.me.id, 'member')).status).toBe(409);
    expect((await role(member.me.id, 'manager')).body).toEqual({ member: member.me.id, role: 'manager' });
    expect((await role(ws.me.id, 'member')).status).toBe(200);
    const out = await api('DELETE', `/v1/workspaces/${ws.id}/channels/${other}/members/${ws.me.id}`, { token: member.person.token });
    expect(out.status).toBe(204);
  });

  it('keeps one workspace out of another', async () => {
    const a = await newWorkspace('A');
    const b = await newWorkspace('B');
    await post(b.person, b.id, b.general, 'for B only');
    // B's channel under A's address, as A's owner and as B's.
    expect((await events(a.person, a.id, b.general)).status).toBe(404);
    expect((await events(b.person, a.id, b.general)).status).toBe(404);
    expect((await post(a.person, a.id, b.general, 'x')).status).toBe(404);
    expect((await api('PATCH', `/v1/workspaces/${a.id}/members/${b.me.id}`, { token: a.person.token, body: { role: 'admin' } })).status).toBe(404);
  });
});
