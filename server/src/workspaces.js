// The workspace routes, /v1/workspaces and everything under it (WORKSPACES.md, Gate 1 routes). This file checks the
// shape of what a client sends and hands it to the workspace's Durable Object (workspace.js), which decides who may
// do what. Making a workspace and listing an account's workspaces happen here, because they span the account, the
// registry and the workspace.

import { fromBase64url, hmac, randomBytes, sameBytes, toBase64url, utf8 } from './bytes.js';
import {
  ACCOUNT_NAME,
  accountObject,
  limitRate,
  registryObject,
  workspaceLimits,
  workspaceObject,
  workspaceOrigin,
  workspacesOn
} from './config.js';
import { json, send } from './http.js';
import * as input from './input.js';
import { HttpError, invalid } from './input.js';

// The wire versions this server speaks. A client names the one it uses in Rukoo-Workspace-Version; none means 1.
export const VERSIONS = [1];
const PROTOCOL = 'rukoo.workspace.v1';
const TICKET_PREFIX = 'rukoo.ticket.';

const TOKEN = /^Bearer ([A-Za-z0-9_-]{43})\.[A-Za-z0-9_-]{43}$/i;
const ID = (prefix) => new RegExp(`^${prefix}_[A-Za-z0-9_-]{22}$`);
const WORKSPACE_ID = ID('w');
const CONVERSATION_ID = ID('c');
const MEMBER_ID = ID('u');
const EVENT_ID = ID('e');
const INVITE_ID = ID('i');
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const NAME_LENGTH = 80;
const TEXT_BYTES = 16384;
const MENTIONS = 32;
const INVITE_CHANNELS = 20;
const LIST_MAX = 50;

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
    // files, runner, mcp, protected-recovery and push-wake are named here once this server has them.
    capabilities: [],
    recovery: 'basic',
    limits: {
      workspacesPerAccount: limits.perAccount,
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

export async function workspaces(request, env, url) {
  if (!workspacesOn(env)) throw notFound();
  const version = request.headers.get('rukoo-workspace-version');
  if (version !== null && !VERSIONS.includes(Number(version))) {
    throw new HttpError(426, 'upgrade_required', 'This server does not speak that version of the workspace protocol.', {}, {
      minVersion: VERSIONS[0],
      scope: 'workspace'
    });
  }
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

  const { token } = session(request);
  const stub = workspaceObject(env, id);
  const ask = async (op, args) => send(await stub.request(token, op, args));
  const body = () => input.readJson(request);

  switch (route) {
    case 'GET /':
      return ask('workspace.get');
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
      return ask('changes', changesQuery(url));
    case 'POST /socket-ticket':
      return ticket(env, id, await stub.request(token, 'ticket'));
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
  if (area === 'conversations' && rest.length >= 3) {
    const conversation = match(a, CONVERSATION_ID);
    if (rest.length === 3 && b === 'messages' && method === 'POST') return ask('post', message(conversation, await body()));
    if (rest.length === 3 && b === 'events' && method === 'GET') return ask('events', eventsQuery(conversation, url));
    if (rest.length === 3 && b === 'read' && method === 'POST') {
      return ask('read', { conversation, seq: whole((await body()).seq, 'seq') });
    }
    if (rest.length === 4 && b === 'operations' && method === 'GET') {
      return ask('operation', { conversation, operationId: c, op: operation(c).bytes });
    }
    if (rest.length === 5 && b === 'messages' && d === 'redact' && method === 'POST') {
      return ask('redact', { conversation, message: match(c, EVENT_ID) });
    }
  }
  throw notFound();
}

// ---- Routes that span objects ----

// The workspaces an account is in. The account knows which it may be in; each workspace says whether it is. A
// reference whose workspace doesn't know the account, left by a join that failed or a removal, is given back here.
async function list(request, env) {
  const { stub, token } = session(request, env);
  const mine = await stub.workspaces(token);
  if (mine.status !== 200) return send(mine);
  const found = await Promise.all(
    mine.workspaces.slice(0, LIST_MAX).map(async (ref) => {
      const membership = await workspaceObject(env, ref.id).membership(mine.incarnation);
      if (!membership && ref.stale) await stub.dropWorkspace(mine.incarnation, ref.id);
      return membership;
    })
  );
  return json(200, { workspaces: found.filter(Boolean) });
}

// Makes a workspace. Its place under MAX_WORKSPACES and the account's reference come first and are given back when
// making it fails.
async function create(request, env) {
  const { stub, token } = session(request, env);
  await limitRate(request, env.RATE_LIMITER);
  const body = await input.readJson(request);
  const fields = { id: `w_${toBase64url(randomBytes(16))}`, name: name(body.name, 'name'), displayName: name(body.displayName, 'displayName') };
  const who = await stub.principal(token);
  if (who.status !== 200) return send(who);
  if (who.class !== 'full') {
    throw new HttpError(403, 'workspace_account_scope', 'This account cannot make workspaces on this server.');
  }
  const limits = workspaceLimits(env);
  const registry = registryObject(env);
  if (registry && (await registry.reserveWorkspace(limits.max)) === 'full') {
    throw new HttpError(403, 'workspaces_full', 'This server has no room for another workspace.');
  }
  let result;
  let referenced = false;
  try {
    const ref = await stub.addWorkspace(token, fields.id, { created: true, max: limits.perAccount });
    if (ref.status !== 200) return send((result = ref));
    referenced = true;
    result = await workspaceObject(env, fields.id).create(who, fields);
    return send(result);
  } finally {
    if (!result || result.status !== 201) {
      if (registry) await registry.releaseWorkspace();
      if (referenced) await stub.dropWorkspace(who.incarnation, fields.id);
    }
  }
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

// A message as the workspace stores it: the text exactly as sent, and mentions as byte ranges in that text.
function message(conversation, body) {
  const { bytes: op, time: opTime } = operation(body.operationId);
  if (typeof body.text !== 'string') throw invalid('text must be a string.', 'text');
  const utf8Text = encoder.encode(body.text);
  if (utf8Text.length === 0 || utf8Text.length > TEXT_BYTES || !body.text.isWellFormed()) {
    throw invalid(`text must be 1 to ${TEXT_BYTES} bytes of UTF-8.`, 'text');
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
  const root = body.root === undefined || body.root === null ? null : match(body.root, EVENT_ID, 'root');
  return { conversation, operationId: body.operationId, op, opTime, text: body.text, size: utf8Text.length, mentions, root };
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
