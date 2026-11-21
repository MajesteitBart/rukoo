// The workspace routes, /v1/workspaces and everything under it (WORKSPACES.md, Gate 1 routes). This file checks the
// shape of what a client sends and hands it to the workspace's Durable Object (workspace.js), which decides who may
// do what. Making a workspace and listing an account's workspaces happen here, because they span the account, the
// registry and the workspace.

import { fromBase64url, hmac, randomBytes, sameBytes, sha256, toBase64url, utf8 } from './bytes.js';
import {
  ACCOUNT_NAME,
  accountObject,
  filesOn,
  filesOrigin,
  limitRate,
  previewsOn,
  registryObject,
  signups,
  workspaceLimits,
  workspaceObject,
  workspaceOrigin,
  workspaceSignups,
  workspacesOn
} from './config.js';
import { downloadable, fileRoute, filesOff, needFiles, reserved } from './files.js';
import { json, send } from './http.js';
import * as input from './input.js';
import { HttpError, invalid } from './input.js';
import { schedulePreviews } from './previews.js';

// The wire versions this server speaks. A client names the one it uses in Rukoo-Workspace-Version; none means 1.
// A reader of version 2 takes a message with files and no text; one of version 1 gets the files' names as its text.
export const VERSIONS = [1, 2];
const PROTOCOL = 'rukoo.workspace.v1';
const TICKET_PREFIX = 'rukoo.ticket.';

const TOKEN = /^Bearer ([A-Za-z0-9_-]{43})\.[A-Za-z0-9_-]{43}$/i;
const ID = (prefix) => new RegExp(`^${prefix}_[A-Za-z0-9_-]{22}$`);
const WORKSPACE_ID = ID('w');
const CONVERSATION_ID = ID('c');
const MEMBER_ID = ID('u');
const EVENT_ID = ID('e');
const INVITE_ID = ID('i');
const GRANT_ID = ID('g');
const FILE_ID = ID('f');
const GENERATION = /^[A-Za-z0-9_-]{22}$/;
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const NAME_LENGTH = 80;
const TEXT_BYTES = 16384;
const MENTIONS = 32;
const INVITE_CHANNELS = 20;
// The other people in a DM: a DM holds 2 to 8, the one starting it included.
const DM_OTHERS = 7;
// Files one message carries, and the longest file name and MIME type an upload may have.
const ATTACHMENTS = 10;
const FILE_NAME = 255;
const FILE_TYPE = 127;
const MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;
// A reaction is one emoji as Unicode recommends it for general interchange, skin tones and sequences included.
const EMOJI = /^\p{RGI_Emoji}$/v;
const EMOJI_BYTES = 64;

const encoder = new TextEncoder();

// What GET /v1/info says about workspaces, or null while they are off.
let installations = new Map();
export async function workspaceInfo(env, url) {
  if (!workspacesOn(env)) return null;
  const registry = registryObject(env);
  const where = String(env.JURISDICTION ?? '');
  if (registry && !installations.has(where)) installations.set(where, await registry.installation());
  const limits = workspaceLimits(env);
  return {
    versions: VERSIONS,
    home: { origin: workspaceOrigin(env) ?? url.origin, installation: installations.get(where) ?? null },
    // Reactions and marking unread come with this server. files needs the bucket and previews the operator's
    // WORKSPACE_PREVIEWS. runner, mcp, protected-recovery and push-wake are named here once this server has them.
    capabilities: capabilities(env),
    ...(filesOn(env) ? { files: { maxBytes: limits.fileBytes, workspaceBytes: limits.filesBytes, origin: filesOrigin(env, url) } } : {}),
    recovery: 'basic',
    // Whether someone without an account can sign up with a workspace invitation (POST /v1/signup, workspaceInvite).
    inviteSignups: inviteSignups(env),
    limits: {
      workspacesPerAccount: limits.perAccount,
      membershipsPerAccount: limits.memberships,
      members: limits.members,
      sockets: limits.sockets,
      conversations: limits.conversations,
      textBytes: limits.textBytes
    },
    // contentDays: how long messages are kept. feedDays: how long a device can stay away before it loads a
    // workspace again. platformHistoryDays: how far back the hosting provider can restore a workspace's database,
    // which includes messages that were removed since.
    retention: { contentDays: limits.retentionDays, feedDays: 14, platformHistoryDays: 30 }
  };
}

export function capabilities(env) {
  return ['reactions', 'unread', ...(filesOn(env) ? ['files'] : []), ...(previewsOn(env) ? ['previews'] : [])];
}

// A workspace invitation stands in for the operator's invite code only on a server that takes accounts by invite
// code, or by invite code or emailed code (verified), with team chat on and WORKSPACE_SIGNUPS not off. Without the
// registry nothing would hold an invitation to one account, so none counts.
export function inviteSignups(env) {
  const mode = signups(env);
  return workspacesOn(env) && (mode === 'invite' || mode === 'verified') && workspaceSignups(env) && Boolean(env.REGISTRY);
}

// For POST /v1/signup without a good invite code: the code under which the registry counts a sign-up with this
// workspace invitation, or null when it can't be used. The registry lets each such code make one account. Any shape
// that isn't { workspace, invite } is null too, so a sign-up learns only what a wrong invite code tells it.
export async function signupInvite(env, value) {
  if (!inviteSignups(env) || typeof value !== 'object' || value === null) return null;
  const { workspace, invite } = value;
  if (typeof workspace !== 'string' || !WORKSPACE_ID.test(workspace) || typeof invite !== 'string') return null;
  const bytes = fromBase64url(invite);
  if (!bytes || bytes.length !== 32) return null;
  if (!(await workspaceObject(env, workspace).inviteOpen(invite))) return null;
  return `workspace:${toBase64url(await sha256(utf8(invite)))}`;
}

// ctx is the request's ExecutionContext: link cards are made in its waitUntil after a post, and an upload finishes in
// it when the device hangs up.
export async function workspaces(request, env, url, ctx) {
  if (!workspacesOn(env)) throw notFound();
  const version = request.headers.get('rukoo-workspace-version');
  if (version !== null && !VERSIONS.includes(Number(version))) {
    throw new HttpError(426, 'upgrade_required', 'This server does not speak that version of the workspace protocol.', {}, {
      minVersion: VERSIONS[0],
      scope: 'workspace'
    });
  }
  // The workspace shapes the events it serves for this version.
  const wire = version === null ? 1 : Number(version);
  const method = request.method;
  const parts = url.pathname.slice('/v1/workspaces'.length).split('/').slice(1);
  if (parts.length === 0) {
    if (method === 'GET') return list(request, env);
    if (method === 'POST') return create(request, env);
    throw notFound();
  }
  const [id, ...rest] = parts;
  if (!WORKSPACE_ID.test(id)) throw notFound();
  const route = `${method} /${rest.join('/')}`;
  if (route === 'GET /socket') return socket(request, env, id);
  // A file link carries its own capability and no session (files.js).
  if (rest[0] === 'files' && rest.length === 2 && (method === 'PUT' || method === 'GET')) return fileRoute(request, env, id, rest[1], ctx);

  const { token } = session(request);
  const stub = workspaceObject(env, id);
  const ask = async (op, args) => send(await stub.request(token, op, args));
  const body = () => input.readJson(request);

  switch (route) {
    case 'GET /':
      return ask('workspace.get');
    case 'DELETE /':
      return remove(env, id, await stub.request(token, 'workspace.delete'));
    case 'POST /join': {
      await limitRate(request, env.RATE_LIMITER);
      const b = await body();
      return ask('join', { invite: secret(b.invite), name: name(b.name, 'name') });
    }
    case 'POST /invites/preview': {
      await limitRate(request, env.RATE_LIMITER);
      return ask('invite.preview', { invite: secret((await body()).invite) });
    }
    case 'GET /invites':
      return ask('invites.list');
    case 'POST /invites':
      return ask('invite.create', invite(await body()));
    case 'GET /members':
      return ask('members.list');
    case 'GET /channels':
      return ask('channels.list');
    case 'POST /channels': {
      const b = await body();
      return ask('channel.create', { name: name(b.name, 'name'), visibility: oneOf(b.visibility, ['workspace', 'private'], 'visibility') });
    }
    case 'GET /changes':
      return ask('changes', { ...changesQuery(url), version: wire });
    case 'POST /socket-ticket':
      return ticket(env, id, await stub.request(token, 'ticket'));
    case 'POST /dms':
      return ask('dm.start', { members: dmMembers((await body()).members) });
    case 'GET /blocks':
      return ask('blocks.list');
    case 'POST /blocks':
      return ask('block', { member: match((await body()).member, MEMBER_ID, 'member') });
  }

  const [area, a, b, c, d] = rest;
  if (area === 'invites' && rest.length === 2 && method === 'DELETE') {
    return ask('invite.revoke', { invite: match(a, INVITE_ID) });
  }
  if (area === 'members' && rest.length === 2) {
    const member = a === 'me' ? 'me' : match(a, MEMBER_ID);
    if (method === 'DELETE') return ask('member.remove', { member });
    if (method === 'PATCH') {
      const fields = await body();
      if (member === 'me') return ask('member.rename', { name: name(fields.name, 'name') });
      return ask('member.role', { member, role: oneOf(fields.role, ['owner', 'admin', 'member', 'guest'], 'role') });
    }
  }
  if (area === 'channels' && rest.length >= 2) {
    const conversation = match(a, CONVERSATION_ID);
    if (rest.length === 2 && method === 'PATCH') {
      const fields = await body();
      if (fields.archived === true) return ask('channel.archive', { conversation });
      return ask('channel.rename', { conversation, name: name(fields.name, 'name') });
    }
    if (rest.length === 3 && b === 'join' && method === 'POST') return ask('channel.join', { conversation });
    if (rest.length === 3 && b === 'members' && method === 'GET') return ask('channel.members', { conversation });
    if (rest.length === 3 && b === 'members' && method === 'POST') {
      return ask('channel.admit', { conversation, member: match((await body()).member, MEMBER_ID, 'member') });
    }
    if (rest.length === 4 && b === 'members') {
      const member = c === 'me' ? 'me' : match(c, MEMBER_ID);
      if (method === 'DELETE') {
        const successor = url.searchParams.get('successor');
        return ask('channel.remove', { conversation, member, successor: successor ? match(successor, MEMBER_ID, 'successor') : null });
      }
      if (method === 'PATCH' && member !== 'me') {
        return ask('channel.role', { conversation, member, role: oneOf((await body()).role, ['manager', 'member'], 'role') });
      }
    }
  }
  if (area === 'dms' && rest.length === 3 && b === 'leave' && method === 'POST') {
    return ask('dm.leave', { conversation: match(a, CONVERSATION_ID) });
  }
  if (area === 'blocks' && rest.length === 2 && method === 'DELETE') {
    return ask('unblock', { member: match(a, MEMBER_ID) });
  }
  if (area === 'conversations' && rest.length >= 3) {
    const conversation = match(a, CONVERSATION_ID);
    if (rest.length === 3 && b === 'messages' && method === 'POST') {
      const args = message(conversation, await body());
      if (args.attachments.length && !filesOn(env)) throw filesOff();
      const result = await stub.request(token, 'post', args);
      // A message that was just posted gets its link cards made after the answer; a retry's 200 doesn't.
      if (result.status === 201) schedulePreviews(ctx, env, url, { workspace: id, conversation, message: result.body.messageId }, args.text);
      return send(result);
    }
    if (rest.length === 3 && b === 'events' && method === 'GET') return ask('events', { ...eventsQuery(conversation, url), version: wire });
    if (rest.length === 3 && b === 'read' && method === 'POST') {
      // readMark: the room's readMark the device knew when it read, so a read from before a mark of unread moves nothing.
      const fields = await body();
      const seq = whole(fields.seq, 'seq');
      const readMark = fields.readMark === undefined || fields.readMark === null ? null : whole(fields.readMark, 'readMark');
      return ask('read', { conversation, seq, readMark });
    }
    if (rest.length === 3 && b === 'unread' && method === 'POST') {
      return ask('unread', { conversation, message: event((await body()).message, 'message') });
    }
    if (rest.length === 3 && b === 'uploads' && method === 'POST') {
      needFiles(env);
      const fields = upload(await body(), env);
      return reserved(env, url, id, await stub.request(token, 'upload.reserve', { conversation, ...fields }));
    }
    if (rest.length === 4 && b === 'uploads' && method === 'DELETE') {
      needFiles(env);
      return ask('upload.cancel', { conversation, upload: match(c, FILE_ID) });
    }
    if (rest.length === 4 && b === 'operations' && method === 'GET') {
      return ask('operation', { conversation, operationId: c, op: operation(c).bytes });
    }
    if (rest.length === 5 && b === 'files' && d === 'download' && method === 'POST') {
      needFiles(env);
      return downloadable(env, url, id, await stub.request(token, 'file.download', { conversation, file: match(c, FILE_ID) }));
    }
    if (rest.length === 5 && b === 'messages' && d === 'redact' && method === 'POST') {
      return ask('redact', { conversation, message: event(c) });
    }
    if (rest.length === 5 && b === 'messages' && d === 'react' && method === 'POST') {
      return ask('react', { conversation, message: event(c), ...reaction(await body()) });
    }
    if (rest.length === 5 && b === 'messages' && d === 'previews' && method === 'POST') {
      return ask('previews.remove', { conversation, message: event(c), remove: previewAddress((await body()).remove) });
    }
  }
  throw notFound();
}

// ---- Routes that span objects ----

// An account object's answer, with the scope a device reads when its session has ended.
function scoped(result) {
  return result.status === 401 ? { ...result, body: { ...result.body, scope: 'account' } } : result;
}

// The workspaces an account is in. The account knows which it may be in, at most MAX_WORKSPACE_MEMBERSHIPS; each
// workspace says whether it is. A reference old enough to be settled is put right here: one whose workspace doesn't
// know the account, left by a join that failed, is given back, and one whose workspace knows it as a former member
// is marked as left. Both name the version they saw, so a join that recorded the reference again meanwhile keeps it.
// A workspace the account made and left is never listed; its reference goes once the workspace is gone (settleMade).
async function list(request, env) {
  const { stub, token } = session(request, env);
  const mine = await stub.workspaces(token);
  if (mine.status !== 200) return send(scoped(mine));
  const found = await Promise.all(
    mine.workspaces.map(async (ref) => {
      if (ref.former) {
        await settleMade(env, stub, mine.incarnation, ref);
        return null;
      }
      const here = await workspaceObject(env, ref.id).membership(mine.incarnation);
      if (here.state === 'active') return { id: here.id, name: here.name, role: here.role };
      if (ref.stale && here.state === 'former') await stub.leftWorkspace(mine.incarnation, ref.id, ref.version);
      if (ref.stale && here.state === 'none') await stub.dropWorkspace(mine.incarnation, ref.id, ref.version);
      return null;
    })
  );
  return json(200, { workspaces: found.filter(Boolean) });
}

// A workspace the account made and then left keeps its reference, so the workspace hears when the account is deleted,
// and the reference counts against the limit on making workspaces. Once the workspace no longer knows the account, as
// after someone else deleted it, the reference is given back. A failure leaves it for the next time.
async function settleMade(env, stub, incarnation, ref) {
  try {
    const here = await workspaceObject(env, ref.id).membership(incarnation);
    if (here.state === 'none') await stub.dropWorkspace(incarnation, ref.id, ref.version);
  } catch (err) {
    console.error('Could not settle the reference of a workspace this account made:', err?.message || err);
  }
}

// Makes a workspace. Its place under MAX_WORKSPACES and the account's reference come first. They are given back
// when the workspace says it wasn't made, and only then.
async function create(request, env) {
  const { stub, token } = session(request, env);
  await limitRate(request, env.RATE_LIMITER);
  const body = await input.readJson(request);
  const fields = { id: `w_${toBase64url(randomBytes(16))}`, name: name(body.name, 'name'), displayName: name(body.displayName, 'displayName') };
  const who = await stub.principal(token);
  if (who.status !== 200) return send(scoped(who));
  if (who.class !== 'full') {
    throw new HttpError(403, 'workspace_account_scope', 'This account cannot make workspaces on this server.');
  }
  const limits = workspaceLimits(env);
  const registry = registryObject(env);
  if (registry && (await registry.reserveWorkspace(fields.id, limits.max)) === 'full') {
    throw new HttpError(403, 'workspaces_full', 'This server has no room for another workspace.');
  }
  const release = async () => {
    if (registry) await registry.releaseWorkspace(fields.id);
  };
  let ref;
  try {
    const add = () => stub.addWorkspace(token, fields.id, { created: true, max: limits.perAccount, most: limits.memberships });
    ref = await add();
    // At the limit, a workspace the account made, left and someone else deleted may still count. Its reference is
    // settled, and the account tries once more.
    if (ref.status === 403 && ref.body?.error === 'workspace_limit') {
      const mine = await stub.workspaces(token);
      if (mine.status === 200) {
        const made = mine.workspaces.filter((r) => r.former);
        await Promise.all(made.map((r) => settleMade(env, stub, mine.incarnation, r)));
        if (made.length) ref = await add();
      }
    }
  } catch (err) {
    await release();
    throw err;
  }
  const undo = async () => {
    await release();
    if (ref.status === 200) await stub.dropWorkspace(who.incarnation, fields.id, ref.ref);
  };
  // A confirmation that fails is made up for later: the registry asks the workspace about a place nobody settled.
  const confirm = async () => {
    if (registry) await registry.confirmWorkspace(fields.id).catch(() => {});
  };
  if (ref.status !== 200) {
    await undo();
    return send(scoped(ref));
  }
  let result;
  try {
    result = await workspaceObject(env, fields.id).create({ ...who, ref: ref.ref }, fields);
  } catch (err) {
    // The answer got lost, which says nothing about whether the workspace was made. The workspace knows, and is asked
    // through a new stub, since the failure may have broken the first. If it can't be asked either, nothing is undone:
    // the registry settles the place later and the account's list settles the reference, both by asking again.
    let made;
    try {
      made = await workspaceObject(env, fields.id).exists();
    } catch {
      throw err;
    }
    if (!made) {
      await undo();
      throw err;
    }
    await confirm();
    const got = await workspaceObject(env, fields.id).request(token, 'workspace.get');
    return got.status === 200 ? json(201, got.body) : send(got);
  }
  if (result.status === 201) await confirm();
  else await undo();
  return send(result);
}

// A workspace its owner deleted: the owner's account gives its reference back, which frees the slot the account's
// limit on making workspaces counts, and the registry frees its place under MAX_WORKSPACES. Either can fail without
// undoing the delete: the account's list settles the reference the next time it asks, and the registry asks the
// workspace about its place once the server is full.
async function remove(env, id, result) {
  if (result.status === 204) {
    try {
      await accountObject(env, result.account).dropWorkspace(result.incarnation, id, result.ref);
    } catch (err) {
      console.error('Could not give back the reference of a deleted workspace:', err?.message || err);
    }
    const registry = registryObject(env);
    try {
      if (registry) await registry.forgetWorkspace(id);
    } catch (err) {
      console.error('Could not free the place of a deleted workspace:', err?.message || err);
    }
  }
  return send(result);
}

// ---- Sockets ----

// A ticket as the client gets it: what the workspace issued, signed with a key from the server's secret, so the
// upgrade below can turn away anything else without waking a workspace.
async function ticket(env, id, result) {
  if (result.status !== 200) return send(result);
  const payload = toBase64url(utf8(JSON.stringify({ w: id, n: result.ticket.nonce, e: result.ticket.expiresAt })));
  const mac = toBase64url(await hmac(env.PEPPER, `workspace-ticket\n${payload}`));
  return json(200, { ticket: `${payload}.${mac}`, expiresAt: result.ticket.expiresAt, protocol: PROTOCOL });
}

// The upgrade. The ticket comes in the Authorization header ("Ticket <ticket>"), or, for a client that can't set
// one, as an entry in Sec-WebSocket-Protocol next to the protocol's own name. Never in the address.
async function socket(request, env, id) {
  if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
    throw new HttpError(426, 'upgrade_required', 'This address takes a WebSocket.');
  }
  const offered = (request.headers.get('sec-websocket-protocol') || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  const header = (request.headers.get('authorization') || '').match(/^Ticket (\S+)$/i);
  const entry = offered.find((item) => item.startsWith(TICKET_PREFIX));
  const given = header ? header[1] : entry ? entry.slice(TICKET_PREFIX.length) : null;
  const refused = new HttpError(401, 'unauthorized', 'Ask for a new socket ticket.', {}, { scope: 'workspace' });
  if (!given) throw refused;
  const [payload, mac, ...more] = given.split('.');
  const signature = fromBase64url(mac ?? '');
  if (more.length > 0 || !signature) throw refused;
  if (!sameBytes(signature, await hmac(env.PEPPER, `workspace-ticket\n${payload}`))) throw refused;
  let claims;
  try {
    claims = JSON.parse(new TextDecoder().decode(fromBase64url(payload)));
  } catch {
    throw refused;
  }
  if (claims.w !== id || !(claims.e > Date.now())) throw refused;
  const response = await workspaceObject(env, id).fetch(
    new Request('https://workspace.internal/socket', {
      headers: { upgrade: 'websocket', 'x-ticket': String(claims.n), 'x-protocol': offered.includes(PROTOCOL) ? '1' : '' }
    })
  );
  if (response.status === 101) return response;
  if (response.status === 404) throw new HttpError(404, 'not_found', 'There is no such workspace.', {}, { scope: 'workspace' });
  if (response.status === 429) {
    throw new HttpError(429, 'rate_limited', 'This workspace has too many open connections.', { 'retry-after': '60' }, { scope: 'workspace' });
  }
  throw refused;
}

// ---- Input ----

// The account object a bearer token points at, and the token.
function session(request, env) {
  const found = (request.headers.get('authorization') || '').match(TOKEN);
  if (!found || !ACCOUNT_NAME.test(found[1])) throw new HttpError(401, 'unauthorized', 'Sign in first.', {}, { scope: 'account' });
  return { stub: env ? accountObject(env, found[1]) : null, token: found[0].slice('Bearer '.length) };
}

function notFound() {
  return new HttpError(404, 'not_found', 'There is nothing here.');
}

function match(value, pattern, field) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    if (field) throw invalid(`${field} is not an id of the right kind.`, field);
    throw notFound();
  }
  return value;
}

// An event id in its one spelling: the 16 bytes behind it, in canonical base64url.
function event(value, field) {
  const bytes = typeof value === 'string' && EVENT_ID.test(value) ? fromBase64url(value.slice(2)) : null;
  if (!bytes || bytes.length !== 16) {
    if (field) throw invalid(`${field} is not an id of the right kind.`, field);
    throw notFound();
  }
  return value;
}

function oneOf(value, options, field) {
  if (!options.includes(value)) throw invalid(`${field} must be one of: ${options.join(', ')}.`, field);
  return value;
}

function whole(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) throw invalid(`${field} must be a whole number of 0 or more.`, field);
  return value;
}

// A name people see: a workspace's, a channel's or a member's. One line, trimmed, at most 80 characters. Emoji made
// of several joined characters are fine. The characters that turn the direction of text around are not, because they
// let one name be drawn as another.
function name(value, field) {
  if (typeof value !== 'string') throw invalid(`${field} must be a string.`, field);
  const trimmed = value.trim();
  if (!trimmed || Array.from(trimmed).length > NAME_LENGTH || /[\p{Cc}\p{Zl}\p{Zp}\u202a-\u202e\u2066-\u2069]/u.test(trimmed)) {
    throw invalid(`${field} must be one line of 1 to ${NAME_LENGTH} characters.`, field);
  }
  return trimmed;
}

// An invitation's secret: 32 random bytes in base64url.
function secret(value) {
  const bytes = fromBase64url(value);
  if (!bytes || bytes.length !== 32) throw invalid('invite must be an invitation secret.', 'invite');
  return value;
}

function invite(body) {
  const channels = body.channels === undefined ? [] : body.channels;
  if (!Array.isArray(channels) || channels.length > INVITE_CHANNELS) {
    throw invalid(`channels must be a list of at most ${INVITE_CHANNELS} channel ids.`, 'channels');
  }
  const expiresIn = body.expiresIn === undefined ? null : body.expiresIn;
  if (expiresIn !== null && (!Number.isSafeInteger(expiresIn) || expiresIn < 60 || expiresIn > 7 * 24 * 60 * 60)) {
    throw invalid('expiresIn must be a number of seconds from one minute to seven days.', 'expiresIn');
  }
  return {
    role: oneOf(body.role, ['member', 'guest'], 'role'),
    channels: [...new Set(channels.map((id) => match(id, CONVERSATION_ID, 'channels')))],
    expiresIn
  };
}

// The people a DM is started with, besides the caller: 1 to 7 member ids, each once. Who they are, and whether the
// caller is among them, is the workspace's to check.
function dmMembers(list) {
  const ok =
    Array.isArray(list) &&
    list.length >= 1 &&
    list.length <= DM_OTHERS &&
    list.every((id) => typeof id === 'string' && MEMBER_ID.test(id)) &&
    new Set(list).size === list.length;
  if (!ok) throw invalid(`members must be a list of 1 to ${DM_OTHERS} member ids, each named once.`, 'members');
  return list;
}

// The 16 bytes and the time of a UUIDv7, which a device makes once per message and sends again on every retry.
function operation(value) {
  if (typeof value !== 'string' || !UUID_V7.test(value)) {
    throw invalid('operationId must be a UUIDv7 in lowercase.', 'operationId');
  }
  const hex = value.replace(/-/g, '');
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return { bytes, time: parseInt(hex.slice(0, 12), 16) };
}

// A message as the workspace stores it: the text exactly as sent, and mentions as byte ranges in that text. grant
// and generation say under which access, and in which life of the workspace, the device wrote it. attachments are
// uploads that are ready, in the order the message shows them; a message with files may have no text.
function message(conversation, body) {
  const { bytes: op, time: opTime } = operation(body.operationId);
  const grant = match(body.grant, GRANT_ID, 'grant');
  if (typeof body.generation !== 'string' || !GENERATION.test(body.generation)) {
    throw invalid('generation must be the generation the workspace answered with.', 'generation');
  }
  const attachments = body.attachments === undefined ? [] : body.attachments;
  const files =
    Array.isArray(attachments) &&
    attachments.length <= ATTACHMENTS &&
    attachments.every((id) => typeof id === 'string' && FILE_ID.test(id)) &&
    new Set(attachments).size === attachments.length;
  if (!files) throw invalid(`attachments must be a list of at most ${ATTACHMENTS} different file ids.`, 'attachments');
  if (typeof body.text !== 'string') throw invalid('text must be a string.', 'text');
  const utf8Text = encoder.encode(body.text);
  const least = attachments.length ? 0 : 1;
  if (utf8Text.length < least || utf8Text.length > TEXT_BYTES || !body.text.isWellFormed()) {
    throw invalid(`text must be ${least} to ${TEXT_BYTES} bytes of UTF-8.`, 'text');
  }
  const list = body.mentions === undefined ? [] : body.mentions;
  if (!Array.isArray(list) || list.length > MENTIONS) throw invalid(`mentions must be a list of at most ${MENTIONS}.`, 'mentions');
  // A range starts and ends between characters, never inside one, and ranges come in order without overlapping.
  const boundary = (at) => at === utf8Text.length || (utf8Text[at] & 0xc0) !== 0x80;
  let from = 0;
  const mentions = list.map((item) => {
    const ok =
      typeof item === 'object' &&
      item !== null &&
      typeof item.actor === 'string' &&
      MEMBER_ID.test(item.actor) &&
      Number.isSafeInteger(item.start) &&
      Number.isSafeInteger(item.end) &&
      item.start >= from &&
      item.end > item.start &&
      item.end <= utf8Text.length &&
      boundary(item.start) &&
      boundary(item.end);
    if (!ok) throw invalid('Each mention needs an actor and a start and end in bytes of the text.', 'mentions');
    from = item.end;
    return { actor: item.actor, start: item.start, end: item.end };
  });
  const root = body.root === undefined || body.root === null ? null : event(body.root, 'root');
  return {
    conversation,
    operationId: body.operationId,
    op,
    opTime,
    grant,
    generation: body.generation,
    text: body.text,
    size: utf8Text.length,
    mentions,
    root,
    attachments
  };
}

// A file to reserve an upload for. The name is shown and saved as it is, so it is one line without path separators or
// characters that turn the direction of text around, which could make "gpj.exe" read as "exe.jpg". width and height
// are an image's, for the apps to lay it out before they have it.
function upload(body, env) {
  if (typeof body.name !== 'string') throw invalid('name must be a string.', 'name');
  const name = body.name.trim();
  const length = Array.from(name).length;
  if (!length || length > FILE_NAME || !name.isWellFormed() || /[\p{Cc}\p{Zl}\p{Zp}\u202a-\u202e\u2066-\u2069/\\]/u.test(name)) {
    throw invalid(`name must be a file name of 1 to ${FILE_NAME} characters, without / or \\.`, 'name');
  }
  const type = body.type === undefined || body.type === null ? 'application/octet-stream' : body.type;
  if (typeof type !== 'string' || type.length > FILE_TYPE || !MIME.test(type)) {
    throw invalid('type must be a MIME type in lowercase, such as image/png.', 'type');
  }
  if (!Number.isSafeInteger(body.size) || body.size < 1) throw invalid("size must be the file's size in bytes.", 'size');
  const most = workspaceLimits(env).fileBytes;
  if (body.size > most) throw new HttpError(413, 'too_large', `A file can be at most ${most} bytes.`, {}, { limit: 'fileBytes' });
  if (typeof body.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(body.sha256)) {
    throw invalid("sha256 must be the file's SHA-256 in lowercase hex.", 'sha256');
  }
  const size = {};
  for (const field of ['width', 'height']) {
    const value = body[field];
    if (value === undefined || value === null) continue;
    if (!type.startsWith('image/') || !Number.isSafeInteger(value) || value < 1 || value > 65535) {
      throw invalid(`${field} must be a whole number from 1 to 65535, for an image.`, field);
    }
    size[field] = value;
  }
  if ((size.width === undefined) !== (size.height === undefined)) {
    throw invalid('width and height come together.', size.width === undefined ? 'width' : 'height');
  }
  return { name, type, size: body.size, sha256: body.sha256, width: size.width ?? null, height: size.height ?? null };
}

function reaction(body) {
  const { emoji, on } = body;
  if (typeof emoji !== 'string' || !emoji.isWellFormed() || encoder.encode(emoji).length > EMOJI_BYTES || !EMOJI.test(emoji)) {
    throw invalid('emoji must be one emoji.', 'emoji');
  }
  if (typeof on !== 'boolean') throw invalid('on must be true or false.', 'on');
  return { emoji, on };
}

// The address of a link card, as the card names it.
function previewAddress(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > TEXT_BYTES) throw invalid('remove must be the address of a link card.', 'remove');
  return value;
}

function number(url, key, fallback, max) {
  const raw = url.searchParams.get(key);
  if (raw === null) return fallback;
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n) || (max !== undefined && (n < 1 || n > max))) {
    throw invalid(`${key} is not a number this route takes.`, key);
  }
  return n;
}

function eventsQuery(conversation, url) {
  const before = number(url, 'before', null);
  const after = number(url, 'after', 0);
  if (before !== null && url.searchParams.has('after')) throw invalid('Give after or before, not both.', 'before');
  return { conversation, after, before, limit: number(url, 'limit', 50, 100) };
}

function changesQuery(url) {
  const after = url.searchParams.get('after');
  if (after !== null && (after.length > 400 || !/^[A-Za-z0-9_-]+$/.test(after))) throw invalid('after is not a cursor.', 'after');
  const active = url.searchParams.get('active');
  return {
    after,
    limit: number(url, 'limit', 32, 100),
    active: active === null ? null : match(active, CONVERSATION_ID, 'active'),
    roomAfter: number(url, 'roomAfter', null)
  };
}
