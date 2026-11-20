// Records the real account server's answers to the team chat routes for Android's offline tests
// (WorkspaceClientTest, WorkspaceVectorsTest), as contract 8.6 and testing.md "Offline tests with recorded answers"
// describe. It starts server/ in the local Workers runtime through test/fixtures/real-server.js, drives one scripted
// scenario with several people, and writes every exchange to android/app/src/test/resources/workspace/vectors.json.
//
// From the repository root, with the server's dependencies installed (npm ci --prefix server):
//   node android/app/src/test/workspace-fixtures/make-fixtures.js           writes vectors.json
//   node android/app/src/test/workspace-fixtures/make-fixtures.js --check   records again and compares with it
//
// A recording is { name, request: { method, path, auth, headers?, body }, response: { status, headers?, body } }.
// auth is the person whose session made the call, by name: tests send that name as the bearer token. Cursors in a
// /changes path become {cursor}, which RecordedWorkspaceServer takes as any cursor. ids names the IDs the tests use.
// The server's address becomes {server}. Request bodies are written as WorkspaceClient writes them (an invitation
// always lists its channels, a message its mentions), because RecordedWorkspaceServer compares them exactly.
//
// --check compares after replacing what differs between two servers: IDs, secrets, tickets, cursors, generations,
// random key material and times. Anything else that changed (a status, an error code, a field, a value) fails it, so
// a server change that breaks what the phone expects shows up here.
'use strict';

const fs = require('fs');
const path = require('path');
const { startRealServer, uuidv7, mention } = require('../../../../../test/fixtures/real-server.js');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..');
const OUT = path.join(ROOT, 'android/app/src/test/resources/workspace/vectors.json');
const DAY = 24 * 60 * 60 * 1000;

// Small limits, so the quota answers come after a few calls: six people in a workspace, twelve conversations.
const VARS = { WORKSPACE_MEMBERS: '6', WORKSPACE_CONVERSATIONS: '12' };

async function record() {
  const server = await startRealServer({ vars: VARS });
  const exchanges = [];
  const ids = {};
  const names = new Map();
  const seen = new Set();

  // One recorded call. who is a person from seedAccount, or null for a call without a session.
  async function call(name, who, method, route, { body, headers } = {}) {
    if (seen.has(name)) throw new Error(`Two exchanges named "${name}"`);
    seen.add(name);
    const sent = { ...headers };
    if (route.startsWith('/v1/workspaces/') && !('rukoo-workspace-version' in sent)) sent['rukoo-workspace-version'] = '1';
    const r = await server.call(method, route, { body, token: who && who.token, headers: sent });
    const request = { method, path: route.startsWith('/v1/workspaces/') ? route.replace(/([?&]after=)[^&]+/, (m, p) => (route.includes('/changes') ? `${p}{cursor}` : m)) : route, auth: who ? names.get(who.token) : null };
    if (headers) request.headers = headers;
    request.body = body === undefined ? null : body;
    const response = { status: r.status };
    const retryAfter = r.headers.get('retry-after');
    if (retryAfter !== null) response.headers = { 'retry-after': retryAfter };
    response.body = r.body;
    exchanges.push({ name, request, response });
    return r;
  }
  // A recorded call that must answer one of statuses; returns the body.
  async function ok(statuses, ...args) {
    const r = await call(...args);
    if (![].concat(statuses).includes(r.status)) throw new Error(`${args[0]}: ${r.status} ${r.text}`);
    return r.body;
  }
  // A recorded call that must be refused with status and code.
  async function refused(status, code, ...args) {
    const r = await call(...args);
    if (r.status !== status || (code && r.body?.error !== code)) throw new Error(`${args[0]}: expected ${status} ${code}, got ${r.status} ${r.text}`);
    return r.body;
  }
  const person = async (name, extra) => {
    const p = await server.seedAccount({ email: `${name}@example.com`, ...extra });
    names.set(p.token, name);
    return p;
  };
  const ws = (id, rest = '') => `/v1/workspaces/${id}${rest}`;
  const quiet = async (who, method, route, body) => {
    const r = await server.call(method, route, { body, token: who.token });
    if (r.status >= 300) throw new Error(`${method} ${route}: ${r.status} ${r.text}`);
    return r.body;
  };

  try {
    const olga = await person('olga');
    const mila = await person('mila');
    const bart = await person('bart');
    const pia = await person('pia');
    const tom = await person('tom');
    const gus = await person('gus');
    const zoe = await person('zoe');
    const rex = await person('rex');
    const tina = await person('tina');

    // ---- the server, the account and the list ----
    await ok(200, 'info', null, 'GET', '/v1/info');
    await ok(200, 'account', olga, 'GET', '/v1/account');
    await ok(200, 'list empty', olga, 'GET', '/v1/workspaces');
    const made = await ok(201, 'create workspace', olga, 'POST', '/v1/workspaces', { body: { name: 'Acme', displayName: 'Olga Owner' } });
    const w = made.workspace.id;
    ids.workspace = w;
    ids.olga = made.me.id;
    await refused(400, 'invalid', 'create workspace bad name', olga, 'POST', '/v1/workspaces', { body: { name: ' ', displayName: 'Olga Owner' } });
    await ok(200, 'list', olga, 'GET', '/v1/workspaces');
    await ok(200, 'workspace', olga, 'GET', ws(w));
    const channels0 = await quiet(olga, 'GET', ws(w, '/channels'));
    const general = channels0.channels.find((c) => c.name === 'general').id;
    ids.general = general;

    // ---- invitations and joining ----
    const inv = await ok(201, 'create invite', olga, 'POST', ws(w, '/invites'), { body: { role: 'member', channels: [], expiresIn: 86400 } });
    ids.invite = inv.invite.id;
    ids.secret = inv.secret;
    await refused(400, 'invalid', 'create invite bad expiry', olga, 'POST', ws(w, '/invites'), { body: { role: 'member', channels: [], expiresIn: 30 } });
    await ok(200, 'invites', olga, 'GET', ws(w, '/invites'));
    await ok(200, 'preview invite', mila, 'POST', ws(w, '/invites/preview'), { body: { invite: inv.secret } });
    const joined = await ok(201, 'join', mila, 'POST', ws(w, '/join'), { body: { invite: inv.secret, name: 'Mila Member' } });
    ids.mila = joined.me.id;
    await ok(200, 'join again', mila, 'POST', ws(w, '/join'), { body: { invite: inv.secret, name: 'Mila Member' } });
    const wsRef = { id: w, owner: olga, general };
    ids.bart = (await server.seedMember(wsRef, bart, 'Bart')).id;
    ids.pia = (await server.seedMember(wsRef, pia, 'Pia')).id;
    ids.tom = (await server.seedMember(wsRef, tom, 'Tom')).id;
    ids.gus = (await server.seedMember(wsRef, gus, 'Gus Guest', { role: 'guest', channels: [general] })).id;
    const full = await server.createInvite(olga, w, { role: 'member' });
    await refused(413, 'quota', 'join full workspace', zoe, 'POST', ws(w, '/join'), { body: { invite: full.secret, name: 'Zoë' } });
    const gone = await server.createInvite(olga, w, { role: 'member' });
    ids.goneInvite = gone.invite.id;
    await ok(204, 'withdraw invite', olga, 'DELETE', ws(w, `/invites/${gone.invite.id}`));
    await refused(410, 'invite_gone', 'preview withdrawn invite', zoe, 'POST', ws(w, '/invites/preview'), { body: { invite: gone.secret } });
    await refused(403, 'forbidden', 'create invite as member', mila, 'POST', ws(w, '/invites'), { body: { role: 'member', channels: [] } });

    // ---- members ----
    await ok(200, 'members', mila, 'GET', ws(w, '/members'));
    await ok(200, 'rename me', mila, 'PATCH', ws(w, '/members/me'), { body: { name: 'Mila M.' } });
    await ok(200, 'set role', olga, 'PATCH', ws(w, `/members/${ids.bart}`), { body: { role: 'admin' } });
    await refused(400, 'invalid', 'set role bad role', olga, 'PATCH', ws(w, `/members/${ids.bart}`), { body: { role: 'king' } });
    await refused(409, 'last_owner', 'leave workspace last owner', olga, 'DELETE', ws(w, '/members/me'));

    // ---- channels ----
    await ok(200, 'channels', mila, 'GET', ws(w, '/channels'));
    const project = (await ok(201, 'create channel', mila, 'POST', ws(w, '/channels'), { body: { name: 'project', visibility: 'private' } })).channel.id;
    ids.project = project;
    await refused(409, 'name_taken', 'create channel name taken', olga, 'POST', ws(w, '/channels'), { body: { name: 'General', visibility: 'workspace' } });
    await refused(400, 'invalid', 'create channel bad name', olga, 'POST', ws(w, '/channels'), { body: { name: 'two\nlines', visibility: 'workspace' } });
    await ok(200, 'rename channel', mila, 'PATCH', ws(w, `/channels/${project}`), { body: { name: 'Project X' } });
    await ok([200, 201], 'admit', mila, 'POST', ws(w, `/channels/${project}/members`), { body: { member: ids.pia } });
    await refused(403, 'cosign_required', 'admit guest as manager', mila, 'POST', ws(w, `/channels/${project}/members`), { body: { member: ids.gus } });
    await ok(200, 'channel members', mila, 'GET', ws(w, `/channels/${project}/members`));
    await refused(409, 'last_manager', 'leave workspace last manager', mila, 'DELETE', ws(w, '/members/me'));
    await refused(409, 'last_manager', 'leave channel last manager', mila, 'DELETE', ws(w, `/channels/${project}/members/me`));
    await ok(200, 'channel role', mila, 'PATCH', ws(w, `/channels/${project}/members/${ids.pia}`), { body: { role: 'manager' } });
    const random = (await quiet(olga, 'POST', ws(w, '/channels'), { name: 'random', visibility: 'workspace' })).channel.id;
    ids.random = random;
    await ok(200, 'join channel', tom, 'POST', ws(w, `/channels/${random}/join`));
    await ok(204, 'leave channel', tom, 'DELETE', ws(w, `/channels/${random}/members/me`));
    await quiet(olga, 'POST', ws(w, `/channels/${random}/members`), { member: ids.tom });
    await ok(204, 'remove from channel', olga, 'DELETE', ws(w, `/channels/${random}/members/${ids.tom}`));
    const design = (await quiet(mila, 'POST', ws(w, '/channels'), { name: 'design', visibility: 'private' })).channel.id;
    ids.design = design;
    await quiet(mila, 'POST', ws(w, `/channels/${design}/members`), { member: ids.bart });
    await ok(204, 'leave channel with successor', mila, 'DELETE', ws(w, `/channels/${design}/members/me?successor=${ids.bart}`));
    const old = (await quiet(olga, 'POST', ws(w, '/channels'), { name: 'old', visibility: 'workspace' })).channel.id;
    ids.old = old;
    const oldAccess = await server.access(olga, w, old);
    await ok(200, 'archive channel', olga, 'PATCH', ws(w, `/channels/${old}`), { body: { archived: true } });

    // ---- the feed ----
    await ok(200, 'feed first pass', olga, 'GET', ws(w, '/changes'));
    const small = await ok(200, 'feed small page', olga, 'GET', ws(w, '/changes?limit=2'));
    if (!small.more) throw new Error('feed small page: expected more');
    await ok(200, 'feed next page', olga, 'GET', ws(w, `/changes?after=${small.next}&limit=2`));
    const milaFeed = await ok(200, 'member feed', mila, 'GET', ws(w, '/changes'));

    // ---- messages ----
    const meta = (await quiet(olga, 'GET', ws(w))).workspace;
    const room = await server.access(olga, w, general);
    const text = 'Hoi @Mila, zie je Zoë?';
    const op = uuidv7(meta.time);
    ids.operation = op;
    const body = { operationId: op, grant: room.grant, generation: meta.generation, text, mentions: [mention(text, '@Mila', ids.mila)] };
    const posted = await ok(201, 'post', olga, 'POST', ws(w, `/conversations/${general}/messages`), { body });
    ids.message = posted.messageId;
    await ok(200, 'post retry', olga, 'POST', ws(w, `/conversations/${general}/messages`), { body });
    await refused(409, 'operation_conflict', 'post changed retry', olga, 'POST', ws(w, `/conversations/${general}/messages`), { body: { ...body, text: 'Hoi @Mila, zie je Joël?' } });
    await refused(409, 'stale_grant', 'post stale grant', olga, 'POST', ws(w, `/conversations/${general}/messages`), {
      body: { ...body, operationId: uuidv7(meta.time), grant: 'g_AAAAAAAAAAAAAAAAAAAAAA' }
    });
    await refused(409, 'stale_generation', 'post stale generation', olga, 'POST', ws(w, `/conversations/${general}/messages`), {
      body: { ...body, operationId: uuidv7(meta.time), generation: 'AAAAAAAAAAAAAAAAAAAAAA' }
    });
    await refused(409, 'submission_expired', 'post expired', olga, 'POST', ws(w, `/conversations/${general}/messages`), {
      body: { ...body, operationId: uuidv7(meta.time - 31 * DAY) }
    });
    await refused(400, 'invalid', 'post ahead of time', olga, 'POST', ws(w, `/conversations/${general}/messages`), {
      body: { ...body, operationId: uuidv7(meta.time + 60 * 60 * 1000) }
    });
    await refused(400, 'invalid', 'post bad mentions', olga, 'POST', ws(w, `/conversations/${general}/messages`), {
      body: { ...body, operationId: uuidv7(meta.time), mentions: [{ actor: ids.mila, start: 21, end: 22 }] }
    });
    await refused(409, 'archived', 'post archived channel', olga, 'POST', ws(w, `/conversations/${old}/messages`), {
      body: { operationId: uuidv7(meta.time), grant: oldAccess.grant, generation: meta.generation, text: 'Still here?', mentions: [] }
    });
    const milaRoom = await server.access(mila, w, general);
    const reply = await ok(201, 'post reply', mila, 'POST', ws(w, `/conversations/${general}/messages`), {
      body: { operationId: uuidv7(meta.time), grant: milaRoom.grant, generation: meta.generation, text: 'Ja 👍', mentions: [], root: posted.messageId }
    });
    ids.reply = reply.messageId;
    await ok(200, 'operation', olga, 'GET', ws(w, `/conversations/${general}/operations/${op}`));
    await refused(404, 'not_found', 'operation unknown', olga, 'GET', ws(w, `/conversations/${general}/operations/${uuidv7(meta.time)}`));
    await ok(200, 'events', mila, 'GET', ws(w, `/conversations/${general}/events?after=0&limit=100`));
    const head = reply.seq;
    await ok(200, 'events before', mila, 'GET', ws(w, `/conversations/${general}/events?before=${head + 1}&limit=1`));
    await ok(200, 'read', mila, 'POST', ws(w, `/conversations/${general}/read`), { body: { seq: head } });
    await refused(403, 'forbidden', 'redact as someone else', mila, 'POST', ws(w, `/conversations/${general}/messages/${posted.messageId}/redact`));
    await ok(200, 'redact', olga, 'POST', ws(w, `/conversations/${general}/messages/${posted.messageId}/redact`));
    await ok(200, 'member feed after', mila, 'GET', ws(w, `/changes?after=${milaFeed.next}`));
    await refused(410, 'reset_required', 'bad cursor', mila, 'GET', ws(w, '/changes?after=AAAA'));
    await refused(404, 'not_found', 'not a member', mila, 'GET', ws('w_AAAAAAAAAAAAAAAAAAAAAA'));
    await refused(404, 'not_found', 'unknown conversation', mila, 'GET', ws(w, '/conversations/c_AAAAAAAAAAAAAAAAAAAAAA/events?after=0&limit=50'));
    await ok(200, 'ticket', mila, 'POST', ws(w, '/socket-ticket'));
    await refused(426, 'upgrade_required', 'upgrade required', mila, 'GET', ws(w), { headers: { 'rukoo-workspace-version': '2' } });

    // ---- a session that ended ----
    await quiet(rex, 'POST', '/v1/logout');
    await refused(401, 'unauthorized', 'signed out list', rex, 'GET', '/v1/workspaces');
    await refused(401, 'unauthorized', 'signed out workspace route', rex, 'GET', ws(w, '/changes'));

    // ---- direct messages and blocks ----
    const dm = (await ok(201, 'start dm', olga, 'POST', ws(w, '/dms'), { body: { members: [ids.mila] } })).dm;
    ids.dm = dm.conversation;
    await ok(200, 'start dm again', mila, 'POST', ws(w, '/dms'), { body: { members: [ids.olga] } });
    const group = (await ok(201, 'start group dm', olga, 'POST', ws(w, '/dms'), { body: { members: [ids.mila, ids.pia] } })).dm;
    ids.group = group.conversation;
    await refused(403, 'dm_unavailable', 'start dm with guest', olga, 'POST', ws(w, '/dms'), { body: { members: [ids.gus] } });
    await refused(400, 'invalid', 'start dm without members', olga, 'POST', ws(w, '/dms'), { body: { members: [] } });
    await ok(201, 'post dm', olga, 'POST', ws(w, `/conversations/${dm.conversation}/messages`), {
      body: { operationId: uuidv7(meta.time), grant: dm.grant, generation: meta.generation, text: 'Even bellen?', mentions: [] }
    });
    await ok(200, 'dm events', mila, 'GET', ws(w, `/conversations/${dm.conversation}/events?after=0&limit=100`));
    const withBart = (await quiet(olga, 'POST', ws(w, '/dms'), { members: [ids.bart] })).dm;
    ids.bartDm = withBart.conversation;
    await quiet(olga, 'POST', ws(w, `/conversations/${withBart.conversation}/messages`), {
      operationId: uuidv7(meta.time), grant: withBart.grant, generation: meta.generation, text: 'Hi Bart'
    });
    const olgaBefore = (await quiet(olga, 'GET', ws(w, '/changes'))).next;
    await ok(201, 'block', olga, 'POST', ws(w, '/blocks'), { body: { member: ids.bart } });
    await ok(200, 'block again', olga, 'POST', ws(w, '/blocks'), { body: { member: ids.bart } });
    await refused(400, 'invalid', 'block self', olga, 'POST', ws(w, '/blocks'), { body: { member: ids.olga } });
    await refused(404, 'not_found', 'block unknown', olga, 'POST', ws(w, '/blocks'), { body: { member: 'u_AAAAAAAAAAAAAAAAAAAAAA' } });
    await ok(200, 'blocks', olga, 'GET', ws(w, '/blocks'));
    await ok(200, 'feed after block', olga, 'GET', ws(w, `/changes?after=${olgaBefore}`));
    await refused(409, 'blocked', 'start dm blocked', olga, 'POST', ws(w, '/dms'), { body: { members: [ids.bart] } });
    await refused(403, 'dm_unavailable', 'start dm blocked by', bart, 'POST', ws(w, '/dms'), { body: { members: [ids.olga] } });
    const bartFeed = await ok(200, 'feed with closed dm', bart, 'GET', ws(w, '/changes'));
    const closed = bartFeed.changes.find((c) => c.conversation === withBart.conversation);
    await refused(409, 'archived', 'post closed dm', bart, 'POST', ws(w, `/conversations/${withBart.conversation}/messages`), {
      body: { operationId: uuidv7(meta.time), grant: closed.grant, generation: meta.generation, text: 'Hallo?', mentions: [] }
    });
    await ok(204, 'unblock', olga, 'DELETE', ws(w, `/blocks/${ids.bart}`));
    await ok(204, 'leave dm', mila, 'POST', ws(w, `/dms/${group.conversation}/leave`));
    await refused(404, 'not_found', 'leave dm on a channel', mila, 'POST', ws(w, `/dms/${general}/leave`));
    await refused(404, 'not_found', 'channel route on a dm', mila, 'GET', ws(w, `/channels/${dm.conversation}/members`));
    // The dm lane lets ten starts through at once; the call that finds it empty is recorded.
    for (let i = 0; ; i++) {
      const r = await server.call('POST', ws(w, '/dms'), { body: { members: [ids.mila] }, token: olga.token });
      if (r.status === 429) break;
      if (i > 30 || r.status !== 200) throw new Error(`dm lane: ${r.status} ${r.text}`);
    }
    await refused(429, 'rate_limited', 'start dm too fast', olga, 'POST', ws(w, '/dms'), { body: { members: [ids.mila] } });

    // ---- leaving and removing ----
    await ok(204, 'remove member', olga, 'DELETE', ws(w, `/members/${ids.tom}`));
    await ok(204, 'leave workspace', pia, 'DELETE', ws(w, '/members/me'));

    // ---- a workspace at its conversation limit, and deleting workspaces ----
    const tiny = await server.seedWorkspace(tina, { name: 'Tiny', displayName: 'Tina' });
    ids.tiny = tiny.id;
    const milaInTiny = await server.seedMember(tiny, mila, 'Mila');
    for (let i = 0; ; i++) {
      const r = await server.call('POST', ws(tiny.id, '/channels'), { body: { name: `room ${i}`, visibility: 'workspace' }, token: tina.token });
      if (r.status === 413) break;
      if (i > 20 || r.status !== 201) throw new Error(`filling Tiny: ${r.status} ${r.text}`);
    }
    await refused(413, 'quota', 'create channel over quota', tina, 'POST', ws(tiny.id, '/channels'), { body: { name: 'one more', visibility: 'workspace' } });
    await refused(413, 'quota', 'start dm over quota', tina, 'POST', ws(tiny.id, '/dms'), { body: { members: [milaInTiny.id] } });
    await refused(409, 'members_remain', 'delete workspace members remain', tina, 'DELETE', ws(tiny.id));
    await refused(403, 'forbidden', 'delete workspace not owner', mila, 'DELETE', ws(tiny.id));
    const solo = await server.seedWorkspace(olga, { name: 'Solo', displayName: 'Olga' });
    ids.solo = solo.id;
    await ok(204, 'delete workspace', olga, 'DELETE', ws(solo.id));
    await refused(404, 'not_found', 'deleted workspace', olga, 'GET', ws(solo.id));

    // ---- signing up with a workspace invitation (contract 2.12) ----
    const signupInvite = await server.createInvite(olga, w, { role: 'member' });
    const signup = (email) => ({
      email,
      workspaceInvite: { workspace: w, invite: signupInvite.secret },
      kdf: { alg: 'argon2id', m: 65536, t: 3, p: 1 },
      salt: 'AAAAAAAAAAAAAAAAAAAAAA',
      authKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      wrappedKey: 'AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      recoveryAuth: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      recoveryWrappedKey: 'AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      device: { name: 'Phone', platform: 'android' }
    });
    const nina = await ok(201, 'sign up with invitation', null, 'POST', '/v1/signup', { body: signup('nina@example.com') });
    names.set(nina.token, 'nina');
    await refused(403, 'invite_required', 'sign up with used invitation', null, 'POST', '/v1/signup', { body: signup('noor@example.com') });
  } finally {
    await server.close();
  }

  // Tokens never go into the file: the person's name stands in for each, also inside answers (a sign-up's token).
  // The server's address, which has the port the helper picked, becomes {server}.
  const replaceTokens = (value) => {
    if (typeof value === 'string') return names.has(value) ? names.get(value) : value.split(server.url).join('{server}');
    if (Array.isArray(value)) return value.map(replaceTokens);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, replaceTokens(v)]));
    return value;
  };
  return replaceTokens({
    about: 'Answers of the real account server (server/src) to the team chat routes, recorded by android/app/src/test/workspace-fixtures/make-fixtures.js. Do not edit by hand: run it again.',
    ids,
    exchanges
  });
}

// ---- --check ----

const ID = /^[wucegi]_[A-Za-z0-9_-]{22}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RANDOM_KEYS = new Set(['next', 'generation', 'keyId', 'ticket', 'secret', 'invite', 'installation', 'id']);
const TIME_KEYS = /(^at$|At$|^time$|^lastSeenAt$)/;

// What two recordings may differ in, replaced by a placeholder: IDs, secrets, tickets, cursors, generations, times.
function canonical(value, key = '') {
  if (Array.isArray(value)) return value.map((v) => canonical(v, key));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, canonical(v, k)]));
  if (typeof value === 'number' && (TIME_KEYS.test(key) || key === 'retry-after')) return '<time>';
  if (typeof value === 'string') {
    if (key === 'retry-after') return '<time>';
    if (ID.test(value)) return '<id>';
    if (UUID.test(value)) return '<uuid>';
    if (RANDOM_KEYS.has(key)) return '<random>';
    if (key === 'path') return value.replace(/[wucegi]_[A-Za-z0-9_-]{22}/g, '<id>').replace(/[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f-]{21}/g, '<uuid>');
  }
  return value;
}

function differences(a, b, at = '', out = []) {
  if (out.length > 40) return out;
  if (typeof a !== typeof b || Array.isArray(a) !== Array.isArray(b) || (a === null) !== (b === null)) {
    out.push(`${at}: ${JSON.stringify(a)} became ${JSON.stringify(b)}`);
  } else if (a && typeof a === 'object') {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) differences(a[k], b[k], `${at}/${k}`, out);
  } else if (a !== b) {
    out.push(`${at}: ${JSON.stringify(a)} became ${JSON.stringify(b)}`);
  }
  return out;
}

(async () => {
  const check = process.argv.includes('--check');
  const t = performance.now();
  const recorded = await record();
  const ms = Math.round(performance.now() - t);
  if (check) {
    const before = JSON.parse(fs.readFileSync(OUT, 'utf8'));
    const diff = differences(canonical(before), canonical(recorded));
    if (diff.length > 0) {
      console.error(`The server's answers changed from ${path.relative(ROOT, OUT)}:\n  ${diff.join('\n  ')}`);
      console.error('Run the script without --check to record them again, and update the phone where it relied on them.');
      process.exitCode = 1;
      return;
    }
    console.log(`${recorded.exchanges.length} exchanges in ${ms} ms match ${path.relative(ROOT, OUT)} apart from IDs and times.`);
    return;
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(recorded, null, 2) + '\n');
  console.log(`${recorded.exchanges.length} exchanges in ${ms} ms -> ${path.relative(ROOT, OUT)}`);
  for (const e of recorded.exchanges) {
    console.log(`${String(e.response.status).padEnd(4)} ${e.name}${e.response.body?.error ? ` (${e.response.body.error})` : ''}`);
  }
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
