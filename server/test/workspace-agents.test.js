// Agents in channels (WORKSPACES.md): agent accounts a member makes in a workspace, their keys, adding them to
// channels, and the rules the server keeps for every reply an agent posts.

import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { call, signup } from './helpers.js';
import {
  api,
  block,
  channels,
  events,
  fillers,
  guest,
  invite,
  newMember,
  newWorkspace,
  openSocket,
  post,
  startDm,
  sync,
  until,
  uuidv7,
  workspaceSql,
  workspaceStub
} from './workspace-helpers.js';

const KEY = /^rka_[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/;
const encoder = new TextEncoder();

// A mention of actor at the first needle in text, in UTF-8 byte offsets as the server takes them.
function mention(text, needle, actor) {
  const i = text.indexOf(needle);
  return { actor, start: encoder.encode(text.slice(0, i)).length, end: encoder.encode(text.slice(0, i + needle.length)).length };
}

const route = (id, rest = '') => `/v1/workspaces/${id}${rest}`;

function makeAgent(person, id, body = {}, vars) {
  return api('POST', route(id, '/agents'), { token: person.token, body: { name: 'Clark', answers: 'everyone', ...body }, vars });
}

// An agent made by person: { agent, key }.
async function newAgent(person, id, body = {}) {
  const made = await makeAgent(person, id, body);
  if (made.status !== 201) throw new Error(`Could not make an agent: ${made.status} ${made.text}`);
  return made.body;
}

function addToChannel(person, id, channel, member) {
  return api('POST', route(id, `/channels/${channel}/members`), { token: person.token, body: { member } });
}

function asAgent(agent, method, path, options = {}) {
  return api(method, path, { ...options, token: agent.key });
}

// What the agent knows when it writes: its grant in the conversation and the workspace's generation, read straight
// from the workspace so a test's replies don't spend the agent's read allowance.
async function agentAccess(id, agentId, conversation) {
  const [grant] = await workspaceSql(
    id,
    `SELECT g.id FROM grants g JOIN member m ON m.n = g.member JOIN conversation c ON c.n = g.conversation WHERE m.id = ? AND c.id = ?`,
    agentId,
    conversation
  );
  const [ws] = await workspaceSql(id, 'SELECT generation FROM workspace');
  return { grant: grant?.id ?? 'g_AAAAAAAAAAAAAAAAAAAAAA', generation: ws.generation };
}

// An agent's reply. body names trigger and text, and may give mentions, part, root and operationId.
async function reply(agent, id, conversation, body) {
  const known = await agentAccess(id, agent.agent.id, conversation);
  return asAgent(agent, 'POST', route(id, `/conversations/${conversation}/messages`), { body: { operationId: uuidv7(), ...known, ...body } });
}

// A person's message that mentions an agent named Clark: its id.
async function ask(person, id, conversation, agentId, text = '@Clark what is the plan?', extra = {}) {
  const sent = await post(person, id, conversation, text, { mentions: [mention(text, '@Clark', agentId)], ...extra });
  if (sent.status !== 201) throw new Error(`Could not ask: ${sent.status} ${sent.text}`);
  return sent.body.messageId;
}

async function eventById(person, id, conversation, messageId) {
  return (await events(person, id, conversation)).body.events.find((e) => e.id === messageId);
}

const agentState = async (id, agentId) => (await workspaceSql(id, 'SELECT state FROM member WHERE id = ?', agentId))[0].state;

// A workspace with Olga the owner, Mila a member, both in general, and Olga's agent Clark in general.
async function team(settings = {}) {
  const ws = await newWorkspace('Acme', 'Olga');
  const mila = await newMember(ws, 'Mila');
  const clark = await newAgent(ws.person, ws.id, settings);
  expect((await addToChannel(ws.person, ws.id, ws.general, clark.agent.id)).status).toBe(200);
  return { ws, mila, clark };
}

describe('making an agent', () => {
  it('gives a full member an agent with a key shown once, and puts it in the directory', async () => {
    const ws = await newWorkspace('Acme', 'Olga');
    const made = await makeAgent(ws.person, ws.id, { name: '  Clark  ', answers: 'sponsor' });
    expect(made.status, made.text).toBe(201);
    expect(made.body.agent).toEqual({
      id: expect.stringMatching(/^u_[A-Za-z0-9_-]{22}$/),
      name: 'Clark',
      sponsor: ws.me.id,
      answers: 'sponsor',
      members: [],
      agents: false,
      lastSeen: null,
      createdAt: expect.any(Number)
    });
    expect(made.body.key).toMatch(KEY);
    expect(made.body.key.slice(4, 26)).toBe(made.body.agent.id.slice(2));

    // Only a hash of the secret is kept, and nothing an account's session could match.
    const [row] = await workspaceSql(
      ws.id,
      'SELECT m.incarnation, m.account, m.role, m.kind, a.keyHash FROM member m JOIN agent a ON a.member = m.n WHERE m.id = ?',
      made.body.agent.id
    );
    expect(row).toMatchObject({ incarnation: null, account: null, role: 'agent', kind: 'agent' });
    expect(new Uint8Array(row.keyHash)).toHaveLength(32);

    const listed = await api('GET', route(ws.id, '/agents'), { token: ws.person.token });
    expect(listed.body.agents).toEqual([made.body.agent]);
    // The directory shows a member with the Agent kind, the role older apps know, and its settings without the key.
    const members = (await api('GET', route(ws.id, '/members'), { token: ws.person.token })).body.members;
    expect(members.find((m) => m.id === made.body.agent.id)).toEqual({
      id: made.body.agent.id,
      kind: 'agent',
      name: 'Clark',
      role: 'member',
      state: 'active',
      joinedAt: expect.any(Number),
      agent: { sponsor: ws.me.id, answers: 'sponsor', members: [], agents: false }
    });
    expect(members.find((m) => m.id === ws.me.id)).toEqual({ id: ws.me.id, kind: 'human', name: 'Olga', role: 'owner', state: 'active', joinedAt: expect.any(Number) });
  });

  it('checks the settings: whom it answers, the chosen members and the name', async () => {
    const ws = await newWorkspace('Acme', 'Olga');
    const mila = await newMember(ws, 'Mila');
    const other = await newAgent(ws.person, ws.id, { name: 'Bee' });
    const refused = async (body, field) => {
      const res = await makeAgent(ws.person, ws.id, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body).toMatchObject({ error: 'invalid', field });
    };
    await refused({ answers: 'anyone' }, 'answers');
    await refused({ name: '' }, 'name');
    await refused({ agents: 'yes' }, 'agents');
    await refused({ answers: 'members', members: 'u_x' }, 'members');
    await refused({ answers: 'members', members: ['u_AAAAAAAAAAAAAAAAAAAAAA'] }, 'members');
    // Another agent can't be one of the chosen members.
    await refused({ answers: 'members', members: [other.agent.id] }, 'members');

    // The sponsor is always answered, so the list leaves them out, and names each person once.
    const chosen = await makeAgent(ws.person, ws.id, { answers: 'members', members: [ws.me.id, mila.me.id, mila.me.id] });
    expect(chosen.body.agent).toMatchObject({ answers: 'members', members: [mila.me.id] });
    // Any other answers clears the list.
    const everyone = await makeAgent(ws.person, ws.id, { answers: 'everyone', members: [mila.me.id] });
    expect(everyone.body.agent.members).toEqual([]);
  });

  it('is for full members only, and a workspace holds at most WORKSPACE_AGENTS of them', async () => {
    const ws = await newWorkspace('Acme', 'Olga');
    const gita = await guest(ws, 'Gita', [ws.general]);
    expect((await makeAgent(gita.person, ws.id)).body).toMatchObject({ error: 'forbidden' });
    expect((await api('GET', route(ws.id, '/agents'), { token: gita.person.token })).status).toBe(403);

    for (let i = 0; i < 20; i++) expect((await makeAgent(ws.person, ws.id, { name: `Agent ${i}` })).status).toBe(201);
    const full = await makeAgent(ws.person, ws.id, { name: 'One too many' });
    expect(full.status).toBe(409);
    expect(full.body).toMatchObject({ error: 'agent_limit', limit: 'agents' });
    expect((await api('GET', route(ws.id, '/agents'), { token: ws.person.token })).body.agents).toHaveLength(20);
  });

  it('is off with WORKSPACE_AGENTS off: no capability, no routes and no keys', async () => {
    const off = { WORKSPACE_AGENTS: 'off' };
    const ws = await newWorkspace('Acme', 'Olga');
    const clark = await newAgent(ws.person, ws.id);
    const info = (await api('GET', '/v1/info', { vars: off })).body.workspace;
    expect(info.capabilities).not.toContain('agents');
    expect(info).not.toHaveProperty('agents');
    expect((await api('GET', '/v1/info', { vars: { WORKSPACE_AGENTS: '0' } })).body.workspace.capabilities).not.toContain('agents');
    expect((await api('GET', route(ws.id, '/agents'), { token: ws.person.token, vars: off })).status).toBe(404);
    expect((await makeAgent(ws.person, ws.id, {}, off)).status).toBe(404);
    const key = await api('GET', route(ws.id), { token: clark.key, vars: off });
    expect(key.status).toBe(401);
    expect(key.body).toMatchObject({ error: 'unauthorized', scope: 'agent' });
  });
});

describe('changing and removing an agent', () => {
  it('lets its sponsor, an owner or an admin change it, and makes it a directory change', async () => {
    const ws = await newWorkspace('Acme', 'Olga');
    const mila = await newMember(ws, 'Mila');
    const ada = await newMember(ws, 'Ada');
    const milas = await newAgent(mila.person, ws.id, { name: 'Milabot', answers: 'sponsor' });
    const patch = (person, body) => api('PATCH', route(ws.id, `/agents/${milas.agent.id}`), { token: person.token, body });

    expect((await patch(ada.person, { name: 'Mine now' })).body).toMatchObject({ error: 'forbidden' });
    const { cursor } = await sync(ws.person, ws.id);
    const changed = await patch(mila.person, { name: 'Mila bot', answers: 'members', members: [ada.me.id], agents: true });
    expect(changed.status, changed.text).toBe(200);
    expect(changed.body.agent).toMatchObject({ name: 'Mila bot', sponsor: mila.me.id, answers: 'members', members: [ada.me.id], agents: true });
    expect((await sync(ws.person, ws.id, cursor)).last.directory.members).toBe(true);
    // An owner changes it too; answers other than members clears the list.
    expect((await patch(ws.person, { answers: 'everyone' })).body.agent).toMatchObject({ answers: 'everyone', members: [], agents: true });
    // Fields that aren't given stay.
    expect((await patch(mila.person, {})).body.agent).toMatchObject({ name: 'Mila bot', answers: 'everyone', agents: true });
    expect((await patch(mila.person, { answers: 'never' })).body).toMatchObject({ error: 'invalid', field: 'answers' });
    expect((await api('PATCH', route(ws.id, '/agents/u_AAAAAAAAAAAAAAAAAAAAAA'), { token: ws.person.token, body: {} })).status).toBe(404);
  });

  it('shows a guest only the chosen members the guest can see', async () => {
    const ws = await newWorkspace('Acme', 'Olga');
    const mila = await newMember(ws, 'Mila');
    const ada = await newMember(ws, 'Ada');
    const project = (await api('POST', route(ws.id, '/channels'), { token: ws.person.token, body: { name: 'project', visibility: 'workspace' } })).body.channel;
    const clark = await newAgent(ws.person, ws.id, { answers: 'members', members: [mila.me.id, ada.me.id] });
    expect((await addToChannel(ws.person, ws.id, project.id, clark.agent.id)).status).toBe(200);
    expect((await addToChannel(ws.person, ws.id, project.id, ada.me.id)).status).toBe(200);
    const gita = await guest(ws, 'Gita', [project.id]);
    const seen = (await api('GET', route(ws.id, '/members'), { token: gita.person.token })).body.members;
    expect(seen.find((m) => m.id === clark.agent.id).agent).toEqual({ sponsor: ws.me.id, answers: 'members', members: [ada.me.id], agents: false });
    expect(seen.map((m) => m.id)).not.toContain(mila.me.id);
  });

  it('takes a chosen member off the list when they leave', async () => {
    const ws = await newWorkspace('Acme', 'Olga');
    const mila = await newMember(ws, 'Mila');
    const clark = await newAgent(ws.person, ws.id, { answers: 'members', members: [mila.me.id] });
    expect((await api('DELETE', route(ws.id, '/members/me'), { token: mila.person.token })).status).toBe(204);
    expect((await api('GET', route(ws.id, '/agents'), { token: ws.person.token })).body.agents[0]).toMatchObject({ id: clark.agent.id, members: [] });
  });

  it('removes it for its sponsor, an owner or an admin: its grants end, its key stops and its messages stay', async () => {
    const { ws, mila, clark } = await team();
    const trigger = await ask(mila.person, ws.id, ws.general, clark.agent.id);
    const answered = await reply(clark, ws.id, ws.general, { trigger, text: 'The plan is ready.' });
    expect(answered.status).toBe(201);
    const socket = await openSocket({ token: clark.key }, ws.id);

    expect((await api('DELETE', route(ws.id, `/agents/${clark.agent.id}`), { token: mila.person.token })).status).toBe(403);
    expect((await api('DELETE', route(ws.id, `/agents/${clark.agent.id}`), { token: ws.person.token })).status).toBe(204);
    expect(await agentState(ws.id, clark.agent.id)).toBe('removed');
    expect((await asAgent(clark, 'GET', route(ws.id))).status).toBe(401);
    expect(await until(() => socket.closed !== null)).toBe(true);
    expect(socket.closed.code).toBe(4003);
    expect((await api('GET', route(ws.id, '/agents'), { token: ws.person.token })).body.agents).toEqual([]);
    const log = (await events(ws.person, ws.id, ws.general)).body.events;
    expect(log.find((e) => e.id === answered.body.messageId)).toMatchObject({ text: 'The plan is ready.', actor: clark.agent.id });
    expect(log.at(-1)).toMatchObject({ kind: 'member.left', member: clark.agent.id, actor: ws.me.id });
    // The directory keeps it as a former member.
    const members = (await api('GET', route(ws.id, '/members'), { token: ws.person.token })).body.members;
    expect(members.find((m) => m.id === clark.agent.id)).toMatchObject({ kind: 'agent', state: 'removed' });
    // DELETE /members/{agent} is the same removal.
    const bee = await newAgent(mila.person, ws.id, { name: 'Bee' });
    expect((await api('DELETE', route(ws.id, `/members/${bee.agent.id}`), { token: mila.person.token })).status).toBe(204);
    expect(await agentState(ws.id, bee.agent.id)).toBe('removed');
  });
});

describe('an agent key', () => {
  it('works for its own workspace and the routes a runner needs, and nothing else', async () => {
    const { ws, mila, clark } = await team();
    const other = await newWorkspace('Other', 'Otto');
    const elsewhere = await asAgent(clark, 'GET', route(other.id));
    expect(elsewhere.status).toBe(401);
    expect(elsewhere.body).toMatchObject({ error: 'unauthorized', scope: 'agent' });
    // Account routes never take it.
    expect((await call('GET', '/v1/account', { token: clark.key })).status).toBe(401);
    expect((await asAgent(clark, 'GET', '/v1/workspaces')).status).toBe(401);
    // A wrong secret.
    const wrong = `${clark.key.slice(0, 27)}${clark.key.at(27) === 'A' ? 'B' : 'A'}${clark.key.slice(28)}`;
    expect((await api('GET', route(ws.id), { token: wrong })).body).toMatchObject({ error: 'unauthorized', scope: 'agent' });

    const allowed = [
      ['GET', route(ws.id)],
      ['GET', route(ws.id, '/members')],
      ['GET', route(ws.id, '/channels')],
      ['GET', route(ws.id, '/changes')],
      ['POST', route(ws.id, '/socket-ticket')],
      ['GET', route(ws.id, `/channels/${ws.general}/members`)],
      ['GET', route(ws.id, '/agents/me')],
      ['GET', route(ws.id, `/conversations/${ws.general}/events`)],
      ['POST', route(ws.id, `/conversations/${ws.general}/read`), { seq: 1 }]
    ];
    for (const [method, path, body] of allowed) {
      const res = await asAgent(clark, method, path, { body });
      expect(res.status, `${method} ${path}: ${res.text}`).toBe(200);
    }
    const me = await asAgent(clark, 'GET', route(ws.id));
    expect(me.body.me).toMatchObject({ id: clark.agent.id, kind: 'agent', role: 'member', agent: { sponsor: ws.me.id, answers: 'everyone' } });
    // lastSeen is the time of its last request, written once a minute at most.
    const seen = (await asAgent(clark, 'GET', route(ws.id, '/agents/me'))).body.agent.lastSeen;
    expect(seen).toEqual(expect.any(Number));
    expect((await api('GET', route(ws.id, '/agents'), { token: ws.person.token })).body.agents[0].lastSeen).toBe(seen);
    await workspaceSql(ws.id, 'UPDATE agent SET lastSeen = lastSeen - 61000');
    await asAgent(clark, 'GET', route(ws.id));
    expect((await asAgent(clark, 'GET', route(ws.id, '/agents/me'))).body.agent.lastSeen).toBeGreaterThan(seen - 61000);
    // An agent sees the people of its channels, as a guest does, and only its own channels.
    const project = (await api('POST', route(ws.id, '/channels'), { token: ws.person.token, body: { name: 'project', visibility: 'workspace' } })).body.channel;
    expect((await asAgent(clark, 'GET', route(ws.id, '/channels'))).body.channels.map((c) => c.id)).toEqual([ws.general]);
    expect((await asAgent(clark, 'GET', route(ws.id, `/channels/${project.id}/members`))).status).toBe(404);

    const message = await ask(mila.person, ws.id, ws.general, clark.agent.id);
    const forbidden = [
      ['POST', route(ws.id, '/channels'), { name: 'mine', visibility: 'workspace' }],
      ['POST', route(ws.id, `/channels/${project.id}/join`)],
      ['POST', route(ws.id, `/channels/${ws.general}/members`), { member: mila.me.id }],
      ['DELETE', route(ws.id, `/channels/${ws.general}/members/me`)],
      ['PATCH', route(ws.id, `/channels/${ws.general}`), { name: 'renamed' }],
      ['POST', route(ws.id, '/invites'), { role: 'member' }],
      ['GET', route(ws.id, '/invites')],
      ['POST', route(ws.id, '/dms'), { members: [mila.me.id] }],
      ['GET', route(ws.id, '/blocks')],
      ['POST', route(ws.id, '/blocks'), { member: mila.me.id }],
      ['PATCH', route(ws.id, '/members/me'), { name: 'Not Clark' }],
      ['DELETE', route(ws.id, '/members/me')],
      ['PATCH', route(ws.id, `/members/${mila.me.id}`), { role: 'guest' }],
      ['GET', route(ws.id, '/agents')],
      ['POST', route(ws.id, '/agents'), { name: 'Child', answers: 'everyone' }],
      ['POST', route(ws.id, `/agents/${clark.agent.id}/key`)],
      ['POST', route(ws.id, `/conversations/${ws.general}/messages/${message}/redact`)],
      ['POST', route(ws.id, `/conversations/${ws.general}/unread`), { message }],
      ['POST', route(ws.id, `/conversations/${ws.general}/uploads`), { name: 'a.txt', size: 1, sha256: '0'.repeat(64) }],
      ['DELETE', route(ws.id)]
    ];
    for (const [method, path, body] of forbidden) {
      const res = await asAgent(clark, method, path, { body });
      expect(res.status, `${method} ${path}: ${res.text}`).toBe(403);
      expect(res.body.error).toBe('agent_forbidden');
    }
    // Still in the workspace and in general.
    expect(await agentState(ws.id, clark.agent.id)).toBe('active');
  });

  it('is replaced by a new key at once, which closes its sockets', async () => {
    const { ws, mila, clark } = await team();
    const socket = await openSocket({ token: clark.key }, ws.id);
    await ask(mila.person, ws.id, ws.general, clark.agent.id);
    expect(await until(() => socket.frames.length > 0)).toBe(true);
    const ticket = (await asAgent(clark, 'POST', route(ws.id, '/socket-ticket'))).body.ticket;
    const issued = await workspaceSql(ws.id, 'SELECT * FROM ticket');

    const renewed = await api('POST', route(ws.id, `/agents/${clark.agent.id}/key`), { token: ws.person.token });
    expect(renewed.status, renewed.text).toBe(200);
    expect(renewed.body.key).toMatch(KEY);
    expect(renewed.body.key).not.toBe(clark.key);
    expect(renewed.body.agent.id).toBe(clark.agent.id);
    expect((await asAgent(clark, 'GET', route(ws.id))).body).toMatchObject({ error: 'unauthorized', scope: 'agent' });
    expect((await asAgent({ key: renewed.body.key }, 'GET', route(ws.id))).status).toBe(200);
    expect(await until(() => socket.closed !== null)).toBe(true);
    expect(socket.closed.code).toBe(4001);
    // A ticket the old key got opens nothing: the new key took it away, and one that got back in, as a ticket asked
    // for while the key was being replaced would, names the old key.
    expect(await workspaceSql(ws.id, 'SELECT * FROM ticket')).toEqual([]);
    expect((await openSocket({ token: renewed.body.key }, ws.id, { ticket })).status).toBe(401);
    for (const row of issued) {
      await workspaceSql(ws.id, 'INSERT INTO ticket (nonce, member, session, expiresAt) VALUES (?, ?, ?, ?)', row.nonce, row.member, row.session, row.expiresAt);
    }
    expect((await openSocket({ token: renewed.body.key }, ws.id, { ticket })).status).toBe(401);
    expect((await openSocket({ token: renewed.body.key }, ws.id)).status).toBe(101);
    // Only its sponsor makes one.
    expect((await api('POST', route(ws.id, `/agents/${clark.agent.id}/key`), { token: mila.person.token })).status).toBe(403);
  });

  it("is its sponsor's alone to renew: an owner or admin outside a private channel can't read it with a new key", async () => {
    const ws = await newWorkspace('Acme', 'Olga');
    const mila = await newMember(ws, 'Mila');
    const ada = await newMember(ws, 'Ada');
    expect((await api('PATCH', route(ws.id, `/members/${ada.me.id}`), { token: ws.person.token, body: { role: 'admin' } })).status).toBe(200);
    const milas = await newAgent(mila.person, ws.id, { name: 'Milabot' });
    const secret = (await api('POST', route(ws.id, '/channels'), { token: mila.person.token, body: { name: 'secret', visibility: 'private' } })).body.channel;
    expect((await addToChannel(mila.person, ws.id, secret.id, milas.agent.id)).status).toBe(200);
    expect((await post(mila.person, ws.id, secret.id, 'The price is 4.2M, keep this to us.')).status).toBe(201);

    // Neither the owner nor the admin is in #secret, and neither gets a key for Mila's agent.
    for (const person of [ws.person, ada.person]) {
      expect((await events(person, ws.id, secret.id)).status).toBe(404);
      const renewed = await api('POST', route(ws.id, `/agents/${milas.agent.id}/key`), { token: person.token });
      expect(renewed.status, renewed.text).toBe(403);
      expect(renewed.body).toMatchObject({ error: 'forbidden' });
      expect(renewed.body).not.toHaveProperty('key');
    }
    // Mila's key still works: nothing was replaced.
    expect((await asAgent(milas, 'GET', route(ws.id, `/conversations/${secret.id}/events`))).status).toBe(200);
    // Owners and admins still change and remove it.
    expect((await api('PATCH', route(ws.id, `/agents/${milas.agent.id}`), { token: ada.person.token, body: { name: 'Mila bot' } })).status).toBe(200);
    expect((await api('POST', route(ws.id, `/agents/${milas.agent.id}/key`), { token: mila.person.token })).status).toBe(200);
    expect((await api('DELETE', route(ws.id, `/agents/${milas.agent.id}`), { token: ada.person.token })).status).toBe(204);
  });

  it("keeps an agent's allowance for its own key: wrong secrets under its name draw from the strangers' one", async () => {
    const { ws, mila, clark } = await team();
    const wrong = (key) => `${key.slice(0, 27)}${key.at(27) === 'A' ? 'B' : 'A'}${key.slice(28)}`;
    // Mila knows Clark's member id, which is all a key's name is. She sends 40 socket tickets with a wrong secret:
    // the ticket lane holds 6, the strangers' allowance 30.
    const flood = async (key, path = '/socket-ticket', method = 'POST', times = 40) => {
      const statuses = {};
      for (let i = 0; i < times; i++) {
        const res = await api(method, route(ws.id, path), { token: key });
        statuses[res.status] = (statuses[res.status] ?? 0) + 1;
      }
      return statuses;
    };
    const forged = await flood(wrong(clark.key));
    expect(forged[401]).toBeGreaterThan(0);
    expect(forged[429]).toBeGreaterThan(0);
    // The real key still has its own tickets and its own reads.
    const ticket = await asAgent(clark, 'POST', route(ws.id, '/socket-ticket'));
    expect(ticket.status, ticket.text).toBe(200);
    expect((await asAgent(clark, 'GET', route(ws.id, '/agents/me'))).status).toBe(200);
    // And it can still reply.
    const trigger = await ask(mila.person, ws.id, ws.general, clark.agent.id);
    expect((await reply(clark, ws.id, ws.general, { trigger, text: 'Still here' })).status).toBe(201);

    // A key that was replaced is a stranger's at once: it runs out the strangers' allowance, and the new key keeps the
    // agent's.
    const renewed = (await api('POST', route(ws.id, `/agents/${clark.agent.id}/key`), { token: ws.person.token })).body.key;
    const old = await flood(clark.key, '/agents/me', 'GET');
    expect(old[200]).toBeUndefined();
    expect(old[429]).toBeGreaterThan(0);
    expect((await asAgent({ key: renewed }, 'GET', route(ws.id, '/agents/me'))).status).toBe(200);
    // A removed agent's key is a stranger's too: the strangers' allowance is still used up.
    expect((await api('DELETE', route(ws.id, `/agents/${clark.agent.id}`), { token: ws.person.token })).status).toBe(204);
    expect((await flood(renewed, '/agents/me', 'GET', 5))[429]).toBeGreaterThan(0);
  });

  it('knows the current key of each agent again after its object restarts', async () => {
    const { ws, clark } = await team();
    const wrong = `${clark.key.slice(0, 27)}${clark.key.at(27) === 'A' ? 'B' : 'A'}${clark.key.slice(28)}`;
    await runInDurableObject(workspaceStub(ws.id), async (instance, state) => {
      const fresh = new instance.constructor(state, instance.env);
      // The strangers' allowance holds 30: a wrong secret uses it up, and the right one keeps its own.
      for (let i = 0; i < 30; i++) await fresh.request(wrong, 'agent.me');
      expect((await fresh.request(wrong, 'agent.me')).status).toBe(429);
      expect((await fresh.request(clark.key, 'agent.me')).status).toBe(200);
    });
  });

  it('stops a reply whose key was replaced after the key was checked', async () => {
    const { ws, mila, clark } = await team();
    const trigger = await ask(mila.person, ws.id, ws.general, clark.agent.id);
    const known = await agentAccess(ws.id, clark.agent.id, ws.general);
    const operationId = uuidv7();
    const op = new Uint8Array(operationId.replace(/-/g, '').match(/../g).map((h) => parseInt(h, 16)));
    const args = {
      conversation: ws.general,
      operationId,
      op,
      opTime: Date.now(),
      ...known,
      text: 'Late',
      size: 4,
      mentions: [],
      root: null,
      attachments: [],
      trigger,
      part: 0
    };
    // The post makes the hash of what it covers after the key was checked. The key is replaced right then, as a
    // sponsor's New key in another request would.
    const result = await runInDurableObject(workspaceStub(ws.id), async (instance, state) => {
      const subtle = crypto.subtle;
      const digest = subtle.digest;
      let calls = 0;
      subtle.digest = async function (...input) {
        const out = await digest.apply(subtle, input);
        calls += 1;
        if (calls === 2) state.storage.sql.exec("UPDATE agent SET keyVersion = keyVersion + 1 WHERE member = (SELECT n FROM member WHERE id = ?)", clark.agent.id);
        return out;
      };
      try {
        return await instance.request(clark.key, 'post', args);
      } finally {
        subtle.digest = digest;
      }
    });
    expect(result.status).toBe(401);
    expect(result.body).toMatchObject({ error: 'unauthorized', scope: 'agent' });
    expect(await workspaceSql(ws.id, 'SELECT seq FROM agent_reply')).toEqual([]);
  });

  it('never makes a person an agent: a session posts as its own member, with any trigger ignored', async () => {
    const { ws, mila, clark } = await team();
    const trigger = await ask(mila.person, ws.id, ws.general, clark.agent.id);
    const sent = await post(mila.person, ws.id, ws.general, 'Me again', { trigger, part: 0 });
    expect(sent.status).toBe(201);
    const event = await eventById(ws.person, ws.id, ws.general, sent.body.messageId);
    expect(event.actor).toBe(mila.me.id);
    expect(event).not.toHaveProperty('trigger');
    expect(event).not.toHaveProperty('depth');
    expect((await api('GET', route(ws.id, '/agents/me'), { token: mila.person.token })).status).toBe(404);
    expect(await workspaceSql(ws.id, 'SELECT seq FROM agent_reply')).toEqual([]);
  });
});

describe('agents in channels', () => {
  it('come in through a manager, or through their sponsor into a channel everyone can see that the sponsor is in', async () => {
    const ws = await newWorkspace('Acme', 'Olga');
    const mila = await newMember(ws, 'Mila');
    const milas = await newAgent(mila.person, ws.id, { name: 'Milabot' });
    const olgas = await newAgent(ws.person, ws.id, { name: 'Clark' });
    const board = (await api('POST', route(ws.id, '/channels'), { token: ws.person.token, body: { name: 'board', visibility: 'private' } })).body.channel;
    expect((await addToChannel(ws.person, ws.id, board.id, mila.me.id)).status).toBe(200);

    // Mila isn't a manager of general: she adds her own agent, and not Olga's.
    const added = await addToChannel(mila.person, ws.id, ws.general, milas.agent.id);
    expect(added.body).toEqual({ member: milas.agent.id, role: 'member' });
    expect((await addToChannel(mila.person, ws.id, ws.general, olgas.agent.id)).status).toBe(403);
    // Nor into a private channel she doesn't manage.
    expect((await addToChannel(mila.person, ws.id, board.id, milas.agent.id)).status).toBe(403);
    // A manager adds any agent, also into a private channel its sponsor is in.
    expect((await addToChannel(ws.person, ws.id, board.id, milas.agent.id)).status).toBe(200);
    const joined = (await events(mila.person, ws.id, ws.general)).body.events.at(-1);
    expect(joined).toMatchObject({ kind: 'member.joined', member: milas.agent.id, actor: mila.me.id });

    // Channels count people; the feed counts agents apart.
    const general = (await channels(ws.person, ws.id)).find((c) => c.id === ws.general);
    expect(general.members).toBe(2);
    const room = (await sync(ws.person, ws.id)).rooms.get(ws.general);
    expect(room).toMatchObject({ members: 2, agents: 1 });
    const listed = (await api('GET', route(ws.id, `/channels/${ws.general}/members`), { token: ws.person.token })).body.members;
    expect(listed).toContainEqual({ member: milas.agent.id, role: 'member' });
  });

  it('can never manage a channel or take one over', async () => {
    const { ws, mila, clark } = await team();
    const made = await api('PATCH', route(ws.id, `/channels/${ws.general}/members/${clark.agent.id}`), { token: ws.person.token, body: { role: 'manager' } });
    expect(made.status).toBe(400);
    expect(made.body).toMatchObject({ error: 'agent_not_manager' });
    const left = await api('DELETE', route(ws.id, `/channels/${ws.general}/members/me?successor=${clark.agent.id}`), { token: ws.person.token });
    expect(left.status).toBe(400);
    expect(left.body).toMatchObject({ error: 'agent_not_manager', field: 'successor' });
    expect((await api('DELETE', route(ws.id, `/channels/${ws.general}/members/me?successor=${mila.me.id}`), { token: ws.person.token })).status).toBe(204);
  });

  it('leave a channel through a manager or their sponsor, also a sponsor outside the channel', async () => {
    const ws = await newWorkspace('Acme', 'Olga');
    const mila = await newMember(ws, 'Mila');
    const ada = await newMember(ws, 'Ada');
    const milas = await newAgent(mila.person, ws.id, { name: 'Milabot' });
    const board = (await api('POST', route(ws.id, '/channels'), { token: ws.person.token, body: { name: 'board', visibility: 'private' } })).body.channel;
    const project = (await api('POST', route(ws.id, '/channels'), { token: ws.person.token, body: { name: 'project', visibility: 'workspace' } })).body.channel;
    expect((await addToChannel(ws.person, ws.id, board.id, mila.me.id)).status).toBe(200);
    // A manager adds someone's agent to a channel the workspace can see, also one its sponsor isn't in.
    for (const channel of [board.id, project.id, ws.general]) expect((await addToChannel(ws.person, ws.id, channel, milas.agent.id)).status).toBe(200);
    const out = (person, channel) => api('DELETE', route(ws.id, `/channels/${channel}/members/${milas.agent.id}`), { token: person.token });

    // Ada is in general but neither manages it nor sponsors the agent.
    expect((await out(ada.person, ws.general)).status).toBe(403);
    // Ada isn't in board: the private channel stays unknown to her.
    expect((await out(ada.person, board.id)).body).toMatchObject({ error: 'not_found', scope: 'conversation' });
    // Mila isn't in project, but it is her agent. In board she is a member and no manager.
    expect((await out(mila.person, project.id)).status).toBe(204);
    expect((await out(mila.person, board.id)).status).toBe(204);
    expect((await out(ws.person, ws.general)).status).toBe(204);
    expect(await workspaceSql(ws.id, 'SELECT g.conversation FROM grants g JOIN member m ON m.n = g.member WHERE m.id = ?', milas.agent.id)).toEqual([]);
  });

  it('come into a private channel only while their sponsor is in it', async () => {
    const ws = await newWorkspace('Acme', 'Olga');
    const mila = await newMember(ws, 'Mila');
    const milas = await newAgent(mila.person, ws.id, { name: 'Milabot' });
    const board = (await api('POST', route(ws.id, '/channels'), { token: ws.person.token, body: { name: 'board', visibility: 'private' } })).body.channel;

    // Mila isn't in board. Its manager can't add her agent, which would read board for her.
    const refused = await addToChannel(ws.person, ws.id, board.id, milas.agent.id);
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ error: 'sponsor_not_in_channel' });
    expect((await events(ws.person, ws.id, board.id)).body.events.some((e) => e.member === milas.agent.id)).toBe(false);
    expect((await asAgent(milas, 'GET', route(ws.id, `/conversations/${board.id}/events`))).status).toBe(404);

    expect((await addToChannel(ws.person, ws.id, board.id, mila.me.id)).status).toBe(200);
    expect((await addToChannel(ws.person, ws.id, board.id, milas.agent.id)).status).toBe(200);
    // Adding it again changes nothing.
    expect((await addToChannel(ws.person, ws.id, board.id, milas.agent.id)).body).toEqual({ member: milas.agent.id, role: 'member' });
    expect((await asAgent(milas, 'GET', route(ws.id, `/conversations/${board.id}/events`))).status).toBe(200);
  });

  it("leave a private channel with their sponsor, however the sponsor's grant there ends", async () => {
    const ws = await newWorkspace('Acme', 'Olga');
    const mila = await newMember(ws, 'Mila');
    const milas = await newAgent(mila.person, ws.id, { name: 'Milabot' });
    const clark = await newAgent(ws.person, ws.id, { name: 'Clark' });
    const board = (await api('POST', route(ws.id, '/channels'), { token: ws.person.token, body: { name: 'board', visibility: 'private' } })).body.channel;
    const project = (await api('POST', route(ws.id, '/channels'), { token: ws.person.token, body: { name: 'project', visibility: 'workspace' } })).body.channel;
    const bring = async (channel) => {
      for (const member of [mila.me.id, milas.agent.id, clark.agent.id]) expect((await addToChannel(ws.person, ws.id, channel, member)).status).toBe(200);
    };
    const holds = async (agentId, channel) =>
      (await workspaceSql(ws.id, 'SELECT 1 FROM grants g JOIN member m ON m.n = g.member JOIN conversation c ON c.n = g.conversation WHERE m.id = ? AND c.id = ?', agentId, channel)).length > 0;
    await bring(board.id);
    await bring(project.id);
    const { cursor } = await sync({ token: milas.key }, ws.id);

    // Mila leaves board: her agent goes in the same step, Olga's stays.
    expect((await api('DELETE', route(ws.id, `/channels/${board.id}/members/me`), { token: mila.person.token })).status).toBe(204);
    expect(await holds(milas.agent.id, board.id)).toBe(false);
    expect(await holds(clark.agent.id, board.id)).toBe(true);
    const tail = (await events(ws.person, ws.id, board.id)).body.events.slice(-2);
    expect(tail).toMatchObject([
      { kind: 'member.left', member: mila.me.id, actor: mila.me.id },
      { kind: 'member.left', member: milas.agent.id, actor: mila.me.id }
    ]);
    expect((await asAgent(milas, 'GET', route(ws.id, `/conversations/${board.id}/events`))).status).toBe(404);
    expect((await sync({ token: milas.key }, ws.id, cursor)).evictions).toContain(board.id);

    // A manager taking Mila out takes her agent out too.
    await bring(board.id);
    expect((await api('DELETE', route(ws.id, `/channels/${board.id}/members/${mila.me.id}`), { token: ws.person.token })).status).toBe(204);
    expect(await holds(milas.agent.id, board.id)).toBe(false);
    expect((await events(ws.person, ws.id, board.id)).body.events.at(-1)).toMatchObject({ kind: 'member.left', member: milas.agent.id, actor: ws.me.id });

    // A channel the workspace can see keeps it: Mila could come back in by herself.
    expect((await api('DELETE', route(ws.id, `/channels/${project.id}/members/me`), { token: mila.person.token })).status).toBe(204);
    expect(await holds(milas.agent.id, project.id)).toBe(true);
    expect(await agentState(ws.id, milas.agent.id)).toBe('active');
  });

  it('keep nobody in a channel: when its last person leaves, it is archived and the agents go', async () => {
    const ws = await newWorkspace('Acme', 'Olga');
    const mila = await newMember(ws, 'Mila');
    const clark = await newAgent(ws.person, ws.id);
    const project = (await api('POST', route(ws.id, '/channels'), { token: mila.person.token, body: { name: 'project', visibility: 'workspace' } })).body.channel;
    expect((await addToChannel(mila.person, ws.id, project.id, clark.agent.id)).status).toBe(200);
    // Mila manages project and is its only person: leaving the workspace asks for no successor.
    expect((await api('DELETE', route(ws.id, '/members/me'), { token: mila.person.token })).status).toBe(204);
    const listed = (await channels(ws.person, ws.id)).find((c) => c.id === project.id);
    expect(listed).toBeUndefined();
    const [row] = await workspaceSql(ws.id, 'SELECT archivedAt FROM conversation WHERE id = ?', project.id);
    expect(row.archivedAt).toEqual(expect.any(Number));
    const { evictions } = await sync({ token: clark.key }, ws.id);
    expect(evictions).toContain(project.id);
    // Clark itself stays: Olga made it.
    expect(await agentState(ws.id, clark.agent.id)).toBe('active');
  });
});

describe('what agents are left out of', () => {
  it('refuses agents in DMs, blocks and role changes', async () => {
    const { ws, mila, clark } = await team();
    const dm = await startDm(ws.person, ws.id, [clark.agent.id]);
    expect(dm.status).toBe(400);
    expect(dm.body).toMatchObject({ error: 'agent_in_dm', field: 'members' });
    expect((await startDm(ws.person, ws.id, [mila.me.id, clark.agent.id])).body.error).toBe('agent_in_dm');
    const blocked = await block(mila.person, ws.id, clark.agent.id);
    expect(blocked.status).toBe(400);
    expect(blocked.body).toMatchObject({ error: 'agent_block', field: 'member' });
    const role = await api('PATCH', route(ws.id, `/members/${clark.agent.id}`), { token: ws.person.token, body: { role: 'admin' } });
    expect(role.status).toBe(400);
    expect(role.body).toMatchObject({ error: 'agent_role' });
    // A guest learns nothing new: their answer is the one every DM refusal gives them.
    const gita = await guest(ws, 'Gita', [ws.general]);
    expect((await startDm(gita.person, ws.id, [clark.agent.id])).body.error).toBe('dm_unavailable');
  });

  it("doesn't count agents against the workspace's members, and deletes them with the workspace", async () => {
    const ws = await newWorkspace('Acme', 'Olga');
    await newAgent(ws.person, ws.id);
    await fillers(ws.id, 98);
    // 99 people and an agent: one more person fits.
    await newMember(ws, 'Number 100');
    const { secret } = await invite(ws.person, ws.id);
    const late = await api('POST', route(ws.id, '/join'), { token: (await signup()).token, body: { invite: secret, name: 'Late' } });
    expect(late.status).toBe(413);

    const alone = await newWorkspace('Solo', 'Sol');
    await newAgent(alone.person, alone.id);
    expect((await api('DELETE', route(alone.id), { token: alone.person.token })).status).toBe(204);
  });
});

describe('replies', () => {
  it('answers a mention once, in a thread under it, and moves the agent’s read position there', async () => {
    const { ws, mila, clark } = await team();
    const trigger = await ask(mila.person, ws.id, ws.general, clark.agent.id);
    const before = (await sync({ token: clark.key }, ws.id)).rooms.get(ws.general);
    expect(before.mentions).toBe(1);

    const text = 'Here is the plan, @Mila.';
    const answered = await reply(clark, ws.id, ws.general, { trigger, text, mentions: [mention(text, '@Mila', mila.me.id)] });
    expect(answered.status, answered.text).toBe(201);
    const event = await eventById(mila.person, ws.id, ws.general, answered.body.messageId);
    expect(event).toMatchObject({ actor: clark.agent.id, text, root: trigger, trigger, depth: 1, origin: mila.me.id, mentions: [{ actor: mila.me.id }] });
    // A person's message has none of them.
    const asked = await eventById(mila.person, ws.id, ws.general, trigger);
    for (const field of ['trigger', 'depth', 'origin']) expect(asked).not.toHaveProperty(field);
    const after = (await sync({ token: clark.key }, ws.id)).rooms.get(ws.general);
    expect(after).toMatchObject({ read: answered.body.seq, mentions: 0 });
    expect((await sync(mila.person, ws.id)).rooms.get(ws.general).mentions).toBe(1);
  });

  it("gives the agent's feed rows the trigger of its newest reply, also once that reply is removed, and people's rows nothing", async () => {
    const { ws, mila, clark } = await team();
    const agentRoom = async (after = null) => (await sync({ token: clark.key }, ws.id, after)).rooms.get(ws.general);
    const seqOf = async (id) => (await eventById(ws.person, ws.id, ws.general, id)).seq;
    expect((await agentRoom()).lastTrigger).toBeNull();
    const a = await ask(mila.person, ws.id, ws.general, clark.agent.id, '@Clark one');
    const b = await ask(mila.person, ws.id, ws.general, clark.agent.id, '@Clark two');
    // The agent answers A. B came while it worked, and the reply moved its read position past B too.
    const answered = await reply(clark, ws.id, ws.general, { trigger: a, text: 'One' });
    expect(answered.status, answered.text).toBe(201);
    const base = await sync({ token: clark.key }, ws.id);
    expect(base.rooms.get(ws.general)).toMatchObject({ read: answered.body.seq, mentions: 0, lastTrigger: await seqOf(a) });

    // The sponsor removes the reply: its event loses the trigger, the agent's row keeps it, in a pass from the start and
    // in the changes since a cursor.
    const removed = await api('POST', route(ws.id, `/conversations/${ws.general}/messages/${answered.body.messageId}/redact`), { token: ws.person.token });
    expect(removed.status, removed.text).toBe(200);
    expect(await eventById(mila.person, ws.id, ws.general, answered.body.messageId)).not.toHaveProperty('trigger');
    expect((await agentRoom(base.cursor)).lastTrigger).toBe(await seqOf(a));
    expect((await agentRoom()).lastTrigger).toBe(await seqOf(a));

    // The newest reply counts by when it was posted, not by its trigger.
    expect((await reply(clark, ws.id, ws.general, { trigger: b, text: 'Two' })).status).toBe(201);
    expect((await agentRoom()).lastTrigger).toBe(await seqOf(b));
    expect((await reply(clark, ws.id, ws.general, { trigger: a, text: 'One, part two', part: 1 })).status).toBe(201);
    expect((await agentRoom()).lastTrigger).toBe(await seqOf(a));

    // A person's row is as it was.
    for (const person of [ws.person, mila.person]) {
      const room = (await sync(person, ws.id)).rooms.get(ws.general);
      expect(room).toMatchObject({ conversation: ws.general, agents: 1 });
      expect(room).not.toHaveProperty('lastTrigger');
    }
  });

  it('answers in the thread a mention is in, and refuses another root', async () => {
    const { ws, mila, clark } = await team();
    const top = (await post(ws.person, ws.id, ws.general, 'Planning')).body.messageId;
    const trigger = await ask(mila.person, ws.id, ws.general, clark.agent.id, '@Clark thoughts?', { root: top });
    expect((await reply(clark, ws.id, ws.general, { trigger, text: 'No', root: trigger })).body).toMatchObject({ error: 'bad_root', field: 'root' });
    const answered = await reply(clark, ws.id, ws.general, { trigger, text: 'Yes', root: top });
    expect(answered.status, answered.text).toBe(201);
    expect(await eventById(ws.person, ws.id, ws.general, answered.body.messageId)).toMatchObject({ root: top, trigger, depth: 1 });
  });

  it('needs a trigger that mentions the agent, after it came in, that is still there', async () => {
    const ws = await newWorkspace('Acme', 'Olga');
    const mila = await newMember(ws, 'Mila');
    const clark = await newAgent(ws.person, ws.id);
    const early = (await post(mila.person, ws.id, ws.general, '@Clark before you came')).body.messageId;
    expect((await addToChannel(ws.person, ws.id, ws.general, clark.agent.id)).status).toBe(200);
    const plain = (await post(mila.person, ws.id, ws.general, 'No mention here')).body.messageId;
    const removed = await ask(mila.person, ws.id, ws.general, clark.agent.id);
    await api('POST', route(ws.id, `/conversations/${ws.general}/messages/${removed}/redact`), { token: mila.person.token });
    const project = (await api('POST', route(ws.id, '/channels'), { token: ws.person.token, body: { name: 'project', visibility: 'workspace' } })).body.channel;
    expect((await addToChannel(ws.person, ws.id, project.id, clark.agent.id)).status).toBe(200);
    const there = await ask(ws.person, ws.id, project.id, clark.agent.id);
    const own = (await reply(clark, ws.id, project.id, { trigger: there, text: 'My answer' })).body.messageId;

    for (const trigger of [early, plain, removed, there, own, 'e_AAAAAAAAAAAAAAAAAAAAAA']) {
      const res = await reply(clark, ws.id, ws.general, { trigger, text: 'Hm' });
      expect(res.status, `${trigger}: ${res.text}`).toBe(400);
      expect(res.body).toMatchObject({ error: 'bad_trigger', field: 'trigger' });
    }
    expect((await reply(clark, ws.id, project.id, { trigger: own, text: 'Me' })).body.error).toBe('bad_trigger');
    const missing = await reply(clark, ws.id, ws.general, { text: 'No trigger' });
    expect(missing.body).toMatchObject({ error: 'invalid', field: 'trigger' });
  });

  it('posts one reply per trigger and part, whichever operation asks', async () => {
    const { ws, mila, clark } = await team();
    const trigger = await ask(mila.person, ws.id, ws.general, clark.agent.id);
    const operationId = uuidv7();
    const first = await reply(clark, ws.id, ws.general, { trigger, text: 'Part one', operationId });
    expect(first.status).toBe(201);
    // A retry of the same operation gets the first answer.
    const again = await reply(clark, ws.id, ws.general, { trigger, text: 'Part one', operationId });
    expect(again.status).toBe(200);
    expect(again.body.messageId).toBe(first.body.messageId);
    // Another operation for the same slot, such as a runner that lost its state.
    const twice = await reply(clark, ws.id, ws.general, { trigger, text: 'Part one, again' });
    expect(twice.status).toBe(409);
    expect(twice.body).toMatchObject({ error: 'already_answered', messageId: first.body.messageId });
    // The same operation id with another part is another payload.
    expect((await reply(clark, ws.id, ws.general, { trigger, text: 'Part one', part: 1, operationId })).body.error).toBe('operation_conflict');
    const second = await reply(clark, ws.id, ws.general, { trigger, text: 'Part two', part: 1 });
    expect(second.status).toBe(201);
    expect((await reply(clark, ws.id, ws.general, { trigger, text: 'Part six', part: 5 })).body).toMatchObject({ error: 'invalid', field: 'part' });
    expect(await workspaceSql(ws.id, 'SELECT part FROM agent_reply ORDER BY part')).toEqual([{ part: 0 }, { part: 1 }]);
  });

  it('answers only its sponsor when it answers sponsor', async () => {
    const { ws, mila, clark } = await team({ answers: 'sponsor' });
    const milas = await ask(mila.person, ws.id, ws.general, clark.agent.id);
    const refused = await reply(clark, ws.id, ws.general, { trigger: milas, text: 'No' });
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ error: 'not_answered', reason: 'sponsor_only' });
    const olgas = await ask(ws.person, ws.id, ws.general, clark.agent.id);
    expect((await reply(clark, ws.id, ws.general, { trigger: olgas, text: 'Yes' })).status).toBe(201);
  });

  it('answers its sponsor and the chosen members when it answers members', async () => {
    const ws = await newWorkspace('Acme', 'Olga');
    const mila = await newMember(ws, 'Mila');
    const ada = await newMember(ws, 'Ada');
    const clark = await newAgent(ws.person, ws.id, { answers: 'members', members: [mila.me.id] });
    expect((await addToChannel(ws.person, ws.id, ws.general, clark.agent.id)).status).toBe(200);
    const answer = async (person) => reply(clark, ws.id, ws.general, { trigger: await ask(person, ws.id, ws.general, clark.agent.id), text: 'Sure' });
    expect((await answer(mila.person)).status).toBe(201);
    expect((await answer(ws.person)).status).toBe(201);
    expect((await answer(ada.person)).body).toMatchObject({ error: 'not_answered', reason: 'not_listed' });
  });

  it('answers everyone who can post in the channel, a guest too, while they are still there', async () => {
    const { ws, mila, clark } = await team();
    const gita = await guest(ws, 'Gita', [ws.general]);
    const guests = await ask(gita.person, ws.id, ws.general, clark.agent.id);
    expect((await reply(clark, ws.id, ws.general, { trigger: guests, text: 'Hi Gita' })).status).toBe(201);
    const milas = await ask(mila.person, ws.id, ws.general, clark.agent.id);
    expect((await api('DELETE', route(ws.id, `/channels/${ws.general}/members/me`), { token: mila.person.token })).status).toBe(204);
    expect((await reply(clark, ws.id, ws.general, { trigger: milas, text: 'Too late' })).body).toMatchObject({ error: 'not_answered', reason: 'author_gone' });
  });

  it("lets its runner tell an author who is gone from one it doesn't answer", async () => {
    const ws = await newWorkspace('Acme', 'Olga');
    const mila = await newMember(ws, 'Mila');
    const ada = await newMember(ws, 'Ada');
    const clark = await newAgent(ws.person, ws.id, { answers: 'members', members: [mila.me.id] });
    expect((await addToChannel(ws.person, ws.id, ws.general, clark.agent.id)).status).toBe(200);
    const fromMila = await ask(mila.person, ws.id, ws.general, clark.agent.id);
    const fromAda = await ask(ada.person, ws.id, ws.general, clark.agent.id);
    expect((await api('DELETE', route(ws.id, `/members/${mila.me.id}`), { token: ws.person.token })).status).toBe(204);

    // The channel's members, which the agent's key reads, still list Ada and no longer Mila.
    const here = (await asAgent(clark, 'GET', route(ws.id, `/channels/${ws.general}/members`))).body.members.map((m) => m.member);
    expect(here).toContain(ada.me.id);
    expect(here).not.toContain(mila.me.id);
    // The refusals say which is which, and both are 403 not_answered, never the agent_forbidden of a route.
    expect((await reply(clark, ws.id, ws.general, { trigger: fromMila, text: 'Hi' })).body).toMatchObject({ error: 'not_answered', reason: 'author_gone' });
    expect((await reply(clark, ws.id, ws.general, { trigger: fromAda, text: 'Hi' })).body).toMatchObject({ error: 'not_answered', reason: 'not_listed' });
  });

  it('applies whom it answers to the person who started the chain, also through other agents', async () => {
    const ws = await newWorkspace('Acme', 'Olga');
    const mila = await newMember(ws, 'Mila');
    const ada = await newMember(ws, 'Ada');
    // Mila's relay answers everyone and other agents. Olga's Clark answers only Olga, and other agents.
    const relay = await newAgent(mila.person, ws.id, { name: 'Relay', answers: 'everyone', agents: true });
    const clark = await newAgent(ws.person, ws.id, { name: 'Clark', answers: 'sponsor', agents: true });
    for (const a of [relay, clark]) expect((await addToChannel(ws.person, ws.id, ws.general, a.agent.id)).status).toBe(200);
    // person asks the relay, which asks Clark: the relay's reply that mentions Clark.
    const relayed = async (person) => {
      const asked = await post(person, ws.id, ws.general, '@Relay ask Clark', { mentions: [mention('@Relay ask Clark', '@Relay', relay.agent.id)] });
      const text = '@Clark please do it';
      const sent = await reply(relay, ws.id, ws.general, { trigger: asked.body.messageId, text, mentions: [mention(text, '@Clark', clark.agent.id)] });
      expect(sent.status, sent.text).toBe(201);
      return sent.body.messageId;
    };

    // Mila can't reach Only me through her relay.
    const fromMila = await relayed(mila.person);
    expect(await eventById(ws.person, ws.id, ws.general, fromMila)).toMatchObject({ actor: relay.agent.id, depth: 1, origin: mila.me.id });
    const refused = await reply(clark, ws.id, ws.general, { trigger: fromMila, text: 'Done' });
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ error: 'not_answered', reason: 'sponsor_only' });
    // Olga can, and Clark's reply keeps her as its origin.
    const fromOlga = await relayed(ws.person);
    const answered = await reply(clark, ws.id, ws.general, { trigger: fromOlga, text: 'Done' });
    expect(answered.status, answered.text).toBe(201);
    expect(await eventById(mila.person, ws.id, ws.general, answered.body.messageId)).toMatchObject({ depth: 2, trigger: fromOlga, origin: ws.me.id });

    // Chosen people: Mila once she is chosen, Ada not.
    expect((await api('PATCH', route(ws.id, `/agents/${clark.agent.id}`), { token: ws.person.token, body: { answers: 'members', members: [mila.me.id] } })).status).toBe(200);
    expect((await reply(clark, ws.id, ws.general, { trigger: fromMila, text: 'Done' })).status).toBe(201);
    const fromAda = await relayed(ada.person);
    expect((await reply(clark, ws.id, ws.general, { trigger: fromAda, text: 'Done' })).body).toMatchObject({ error: 'not_answered', reason: 'not_listed' });

    // Everyone, but the person who started the chain left the channel since.
    expect((await api('PATCH', route(ws.id, `/agents/${clark.agent.id}`), { token: ws.person.token, body: { answers: 'everyone' } })).status).toBe(200);
    expect((await api('DELETE', route(ws.id, `/channels/${ws.general}/members/me`), { token: ada.person.token })).status).toBe(204);
    expect((await reply(clark, ws.id, ws.general, { trigger: fromAda, text: 'Done' })).body).toMatchObject({ error: 'not_answered', reason: 'author_gone' });
    // So did the agent that wrote the trigger.
    const late = await relayed(mila.person);
    expect((await api('DELETE', route(ws.id, `/channels/${ws.general}/members/${relay.agent.id}`), { token: mila.person.token })).status).toBe(204);
    expect((await reply(clark, ws.id, ws.general, { trigger: late, text: 'Done' })).body).toMatchObject({ error: 'not_answered', reason: 'author_gone' });

    // Removing a reply takes its trigger, depth and origin with its text.
    expect((await api('POST', route(ws.id, `/conversations/${ws.general}/messages/${answered.body.messageId}/redact`), { token: ws.person.token })).status).toBe(200);
    const removed = await eventById(mila.person, ws.id, ws.general, answered.body.messageId);
    expect(removed).toMatchObject({ redacted: true });
    for (const field of ['trigger', 'depth', 'origin', 'text']) expect(removed).not.toHaveProperty(field);
  });

  it("lets its sponsor remove its replies and their link cards, also once the agent is gone", async () => {
    const ws = await newWorkspace('Acme', 'Olga');
    const mila = await newMember(ws, 'Mila');
    const ada = await newMember(ws, 'Ada');
    const milas = await newAgent(mila.person, ws.id, { name: 'Clark' });
    expect((await addToChannel(mila.person, ws.id, ws.general, milas.agent.id)).status).toBe(200);
    const first = await reply(milas, ws.id, ws.general, { trigger: await ask(ada.person, ws.id, ws.general, milas.agent.id), text: 'One' });
    const second = await reply(milas, ws.id, ws.general, { trigger: await ask(ada.person, ws.id, ws.general, milas.agent.id), text: 'Two' });
    const messageRoute = (id, rest) => route(ws.id, `/conversations/${ws.general}/messages/${id}/${rest}`);
    const card = { url: 'https://example.com/a', title: 'A', description: '', site: 'example.com', image: null, video: false };
    await workspaceSql(
      ws.id,
      'UPDATE event SET previews = ? WHERE seq = ? AND conversation = (SELECT n FROM conversation WHERE id = ?)',
      JSON.stringify([card]),
      first.body.seq,
      ws.general
    );

    // Ada asked, but she neither wrote the reply, sponsors its agent nor manages general.
    const cardAsAda = await api('POST', messageRoute(first.body.messageId, 'previews'), { token: ada.person.token, body: { remove: card.url } });
    expect(cardAsAda.status).toBe(403);
    expect((await api('POST', messageRoute(first.body.messageId, 'redact'), { token: ada.person.token })).status).toBe(403);
    // Mila sponsors it: she takes the card off, which the room hears from the agent as the message's author.
    const cardAsMila = await api('POST', messageRoute(first.body.messageId, 'previews'), { token: mila.person.token, body: { remove: card.url } });
    expect(cardAsMila.status, cardAsMila.text).toBe(200);
    expect(cardAsMila.body).toEqual({ previews: [] });
    expect((await events(ws.person, ws.id, ws.general)).body.events.at(-1)).toMatchObject({ kind: 'message.previewed', actor: milas.agent.id, previews: [] });
    // And she removes the reply.
    const removed = await api('POST', messageRoute(first.body.messageId, 'redact'), { token: mila.person.token });
    expect(removed.status, removed.text).toBe(200);
    expect((await events(ws.person, ws.id, ws.general)).body.events.at(-1)).toMatchObject({ kind: 'message.redacted', actor: mila.me.id, target: first.body.messageId });
    // Once the agent is removed, its replies are still hers to remove.
    expect((await api('DELETE', route(ws.id, `/agents/${milas.agent.id}`), { token: mila.person.token })).status).toBe(204);
    expect((await api('POST', messageRoute(second.body.messageId, 'redact'), { token: mila.person.token })).status).toBe(200);
    expect(await eventById(ada.person, ws.id, ws.general, second.body.messageId)).toMatchObject({ redacted: true });
  });

  it('answers other agents only with agents on, and stops a chain at the depth limit', async () => {
    const ws = await newWorkspace('Acme', 'Olga');
    const alpha = await newAgent(ws.person, ws.id, { name: 'Alpha', agents: true });
    const beta = await newAgent(ws.person, ws.id, { name: 'Beta', agents: false });
    for (const a of [alpha, beta]) expect((await addToChannel(ws.person, ws.id, ws.general, a.agent.id)).status).toBe(200);
    const say = (agent, trigger, text, needle, target, extra = {}) =>
      reply(agent, ws.id, ws.general, { trigger, text, mentions: [mention(text, needle, target)], ...extra });

    const start = (await post(ws.person, ws.id, ws.general, '@Alpha go', { mentions: [mention('@Alpha go', '@Alpha', alpha.agent.id)] })).body.messageId;
    const one = await say(alpha, start, '@Beta your turn', '@Beta', beta.agent.id);
    expect(one.status, one.text).toBe(201);
    // Beta doesn't answer agents.
    const off = await say(beta, one.body.messageId, '@Alpha back', '@Alpha', alpha.agent.id);
    expect(off.status).toBe(403);
    expect(off.body).toMatchObject({ error: 'not_answered', reason: 'agents_off' });

    expect((await api('PATCH', route(ws.id, `/agents/${beta.agent.id}`), { token: ws.person.token, body: { agents: true } })).status).toBe(200);
    const two = await say(beta, one.body.messageId, '@Alpha back', '@Alpha', alpha.agent.id);
    expect(two.status, two.text).toBe(201);
    const three = await say(alpha, two.body.messageId, '@Beta again', '@Beta', beta.agent.id);
    expect(three.status, three.text).toBe(201);
    const four = await say(beta, three.body.messageId, '@Alpha once more', '@Alpha', alpha.agent.id);
    expect(four.status).toBe(409);
    expect(four.body).toMatchObject({ error: 'too_deep' });

    const log = (await events(ws.person, ws.id, ws.general)).body.events;
    const depths = [one, two, three].map((r) => log.find((e) => e.id === r.body.messageId).depth);
    expect(depths).toEqual([1, 2, 3]);
    // The chain stays in the thread of the person's message, and a person's mention starts over at depth 0.
    expect(log.find((e) => e.id === three.body.messageId).root).toBe(start);
    const restart = (await post(ws.person, ws.id, ws.general, '@Beta you too', { mentions: [mention('@Beta you too', '@Beta', beta.agent.id)], root: start })).body.messageId;
    expect((await reply(beta, ws.id, ws.general, { trigger: restart, text: 'Fine' })).status).toBe(201);
  });

  it('posts text only, never into an archived channel, and at most WORKSPACE_AGENT_REPLIES an hour', async () => {
    const { ws, mila, clark } = await team();
    const trigger = await ask(mila.person, ws.id, ws.general, clark.agent.id);
    const files = await reply(clark, ws.id, ws.general, { trigger, text: 'See file', attachments: ['f_AAAAAAAAAAAAAAAAAAAAAA'] });
    expect(files.status).toBe(400);
    expect(files.body).toMatchObject({ error: 'agent_attachments' });

    const [{ agent, conversation }] = await workspaceSql(
      ws.id,
      'SELECT m.n AS agent, c.n AS conversation FROM member m, conversation c WHERE m.id = ? AND c.id = ?',
      clark.agent.id,
      ws.general
    );
    await runInDurableObject(workspaceStub(ws.id), (instance, state) => {
      const now = Date.now();
      for (let i = 0; i < 120; i++) {
        state.storage.sql.exec('INSERT INTO agent_reply (agent, conversation, triggerSeq, part, seq, at) VALUES (?, ?, ?, 0, 0, ?)', agent, conversation, 100000 + i, now - i * 1000);
      }
    });
    const busy = await reply(clark, ws.id, ws.general, { trigger, text: 'One too many' });
    expect(busy.status).toBe(429);
    expect(busy.body).toMatchObject({ error: 'rate_limited', limit: 'agentReplies' });
    expect(Number(busy.headers.get('retry-after'))).toBeGreaterThan(0);
    await workspaceSql(ws.id, 'DELETE FROM agent_reply');

    await api('PATCH', route(ws.id, `/channels/${ws.general}`), { token: ws.person.token, body: { archived: true } });
    expect((await reply(clark, ws.id, ws.general, { trigger, text: 'Archived' })).body.error).toBe('archived');
  });
});

describe('a sponsor who can no longer have agents', () => {
  async function check(ws, clark) {
    expect(await until(async () => (await agentState(ws.id, clark.agent.id)) === 'removed')).toBe(true);
    expect((await asAgent(clark, 'GET', route(ws.id))).status).toBe(401);
    const log = (await events(ws.person, ws.id, ws.general)).body.events;
    expect(log.some((e) => e.kind === 'member.left' && e.member === clark.agent.id)).toBe(true);
  }

  async function milaWithAgent() {
    const ws = await newWorkspace('Acme', 'Olga');
    const mila = await newMember(ws, 'Mila');
    const clark = await newAgent(mila.person, ws.id, { name: 'Milabot' });
    expect((await addToChannel(mila.person, ws.id, ws.general, clark.agent.id)).status).toBe(200);
    return { ws, mila, clark };
  }

  it('takes their agents with them when they leave', async () => {
    const { ws, mila, clark } = await milaWithAgent();
    const socket = await openSocket({ token: clark.key }, ws.id);
    expect((await api('DELETE', route(ws.id, '/members/me'), { token: mila.person.token })).status).toBe(204);
    await check(ws, clark);
    expect(await until(() => socket.closed !== null)).toBe(true);
    expect(socket.closed.code).toBe(4003);
  });

  it('takes their agents with them when they are removed', async () => {
    const { ws, mila, clark } = await milaWithAgent();
    expect((await api('DELETE', route(ws.id, `/members/${mila.me.id}`), { token: ws.person.token })).status).toBe(204);
    await check(ws, clark);
  });

  it('takes their agents with them when they become a guest', async () => {
    const { ws, mila, clark } = await milaWithAgent();
    expect((await api('PATCH', route(ws.id, `/members/${mila.me.id}`), { token: ws.person.token, body: { role: 'guest' } })).status).toBe(200);
    await check(ws, clark);
  });

  it('takes their agents with them when their account is deleted', async () => {
    const { ws, mila, clark } = await milaWithAgent();
    expect((await call('DELETE', '/v1/account', { token: mila.person.token, body: { authKey: mila.person.authKey } })).status).toBe(204);
    await check(ws, clark);
  });
});

describe('a workspace made before agents', () => {
  it('gets the columns and tables of agents when its object starts, and keeps everyone a person', async () => {
    const ws = await newWorkspace('Acme', 'Olga');
    const mila = await newMember(ws, 'Mila');
    await post(mila.person, ws.id, ws.general, 'Written before the upgrade');
    await runInDurableObject(workspaceStub(ws.id), (instance, state) => {
      const sql = state.storage.sql;
      sql.exec(`
        DROP INDEX member_sponsor;
        DROP TABLE agent;
        DROP TABLE agent_reply;
        ALTER TABLE member DROP COLUMN kind;
        ALTER TABLE member DROP COLUMN sponsor;
      `);
      const columns = (table) => sql.exec(`PRAGMA table_info(${table})`).toArray().map((c) => c.name);
      expect(columns('member')).not.toContain('kind');
      new instance.constructor(state, instance.env);
      new instance.constructor(state, instance.env);
      expect(columns('member')).toEqual(expect.arrayContaining(['kind', 'sponsor']));
      expect(sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('agent', 'agent_reply')").toArray()).toHaveLength(2);
      // The feed finds an agent's newest reply in a room through its own index.
      const plan = sql.exec('EXPLAIN QUERY PLAN SELECT triggerSeq FROM agent_reply WHERE agent = 1 AND conversation = 1 ORDER BY seq DESC LIMIT 1').toArray();
      expect(plan.map((row) => row.detail).join('\n')).toMatch(/USING (COVERING )?INDEX agent_reply_seq/);
      expect(sql.exec("SELECT DISTINCT kind FROM member").toArray()).toEqual([{ kind: 'human' }]);
    });
    const members = (await api('GET', route(ws.id, '/members'), { token: ws.person.token })).body.members;
    expect(members.map((m) => m.kind)).toEqual(['human', 'human']);
    const clark = await newAgent(ws.person, ws.id);
    expect((await addToChannel(ws.person, ws.id, ws.general, clark.agent.id)).status).toBe(200);
    const trigger = await ask(mila.person, ws.id, ws.general, clark.agent.id);
    expect((await reply(clark, ws.id, ws.general, { trigger, text: 'After the upgrade' })).status).toBe(201);
  });
});
