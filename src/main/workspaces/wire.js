'use strict';

// What crosses the edges of team chat in the main process: the server's answers, which are checked whole before
// anything of them reaches the cache, the renderer's IPC arguments, which are checked before any request, and the
// errors the renderer tells apart. Nothing here talks to the network or the disk. The rules are in server/WORKSPACES.md
// ("Gate 1 routes") and in the team chat contract: invitation links (3.2), operation IDs (3.8), errors (3.15), names
// and limits (3.16), mentions (3.17), IPC methods (4.4) and the shapes the renderer gets (4.6).
const crypto = require('crypto');
const { t } = require('../../i18n');
const { AccountError } = require('../account/client');

const ID = (prefix) => new RegExp(`^${prefix}_[A-Za-z0-9_-]{22}$`);
const WORKSPACE_ID = ID('w');
const CONVERSATION_ID = ID('c');
const MEMBER_ID = ID('u');
const EVENT_ID = ID('e');
const GRANT_ID = ID('g');
const INVITE_ID = ID('i');
const LOCAL_ID = /^[A-Za-z0-9_-]{22}$/;
const SECRET = /^[A-Za-z0-9_-]{43}$/;
const GENERATION = /^[A-Za-z0-9_-]{22}$/;
const KEY_ID = /^[A-Za-z0-9_-]{1,64}$/;
// The server refuses a longer cursor (server/src/workspaces.js, changesQuery).
const CURSOR = /^[A-Za-z0-9_-]{1,400}$/;
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const EVENT_KIND = /^[a-z]+(\.[a-z_]+)+$/;

const NAME_LENGTH = 80;
const TEXT_BYTES = 16384;
const MENTIONS_MAX = 32;
// A draft may hold more than a message may send: the composer disables Send past the limits, and the draft keeps what
// the person typed until they shorten it.
const DRAFT_BYTES = 4 * TEXT_BYTES;
const DRAFT_MENTIONS = 100;
const LINK_LENGTH = 2000;
const INVITE_CHANNELS = 20;
const INVITE_EXPIRY = [86400, 259200, 604800];
const DM_OTHERS = 7;
// What one answer may hold. The server sends at most 100 rooms and evictions together, 64 removed IDs per room, 20
// inline events and 100 events per page.
const FEED_ROWS = 100;
const REMOVED_IDS = 64;
const INLINE_EVENTS = 20;
const EVENTS_PAGE = 100;
const BADGE_CAP = 100;
// Names on the wire: the server keeps them to 80 code points, so 200 UTF-16 units leaves room and refuses nonsense.
const NAME_UNITS = 200;
// A full member gets every active member and the 1,000 who left most recently.
const MEMBERS_MAX = 20000;
const CHANNELS_MAX = 10000;
const BLOCKS_MAX = 10000;
const INVITES_MAX = 1000;
const WORKSPACES_MAX = 200;

const MEMBER_ROLES = ['owner', 'admin', 'member', 'guest'];
const MEMBER_STATES = ['active', 'left', 'removed', 'deleted'];
const ROOM_ROLES = ['manager', 'member'];
const CLOSED_REASONS = ['left', 'ineligible', 'closed'];
const SCOPES = ['account', 'workspace', 'conversation'];
const LIMITS = ['members', 'conversations', 'invites', 'bytes', 'dailyDms'];

const encoder = new TextEncoder();
const utf8Length = (text) => encoder.encode(text).length;

// ---- Errors ----

// The text key of each code the renderer tells apart (contract 3.15). The codes the engines handle themselves come
// through chatError() unchanged so the outbox and the sync engine can act on them; they never reach the UI.
const KEYS = {
  network: 'chat.errors.network',
  signed_out: 'chat.errors.signedOut',
  upgrade_required: 'chat.errors.upgrade',
  rate_limited: 'chat.errors.rateLimited',
  not_found: 'chat.errors.notFound',
  forbidden: 'chat.errors.forbidden',
  cosign_required: 'chat.channel.addGuestNeedsAdmin',
  workspace_limit: 'chat.errors.workspaceLimit',
  workspaces_full: 'chat.errors.workspacesFull',
  workspace_account_scope: 'chat.errors.accountScope',
  dm_unavailable: 'chat.errors.dmUnavailable',
  blocked: 'chat.errors.blocked',
  name_taken: 'chat.errors.nameTaken',
  last_owner: 'chat.errors.lastOwner',
  last_manager: 'chat.errors.lastManager',
  members_remain: 'chat.errors.membersRemain',
  archived: 'chat.errors.archived',
  invite_gone: 'chat.errors.inviteGone',
  quota: 'chat.errors.quota',
  invalid: 'chat.errors.invalid',
  bad_link: 'chat.join.badLink',
  other_server: 'chat.join.otherHost',
  not_saved: 'chat.errors.notSaved',
  paused: 'chat.errors.paused',
  server: 'chat.errors.failed',
  operation_conflict: 'chat.errors.operationConflict',
  submission_expired: 'chat.errors.failed',
  stale_grant: 'chat.errors.failed',
  stale_generation: 'chat.errors.failed',
  history_regressed: 'chat.errors.failed',
  reset_required: 'chat.errors.failed'
};
// Never call errors: the engines turn these into outbox rows and workspace states (contract 3.15).
const INTERNAL = new Set(['operation_conflict', 'submission_expired', 'stale_grant', 'stale_generation', 'history_regressed', 'reset_required']);
const QUOTA_KEYS = {
  members: 'chat.errors.quotaMembers',
  conversations: 'chat.errors.quotaConversations',
  invites: 'chat.errors.quotaInvites',
  bytes: 'chat.errors.quotaBytes'
};
const NAME_FIELDS = new Set(['name', 'displayName']);

// The key for a code and its details, as the renderer's chatErrorText picks it.
function errorKey(code, { scope, limit, field } = {}) {
  if (code === 'not_found') {
    if (scope === 'workspace') return 'chat.errors.goneWorkspace';
    if (scope === 'conversation') return 'chat.errors.goneConversation';
    return 'chat.errors.notFound';
  }
  if (code === 'rate_limited' && limit === 'dailyDms') return 'chat.errors.dailyDms';
  if (code === 'quota') return QUOTA_KEYS[limit] || 'chat.errors.quota';
  if (code === 'invalid' && NAME_FIELDS.has(field)) return 'chat.errors.invalidName';
  return KEYS[code] || KEYS.server;
}

// A team chat error. chat = true is what main.js's windowError() looks for to pass the code and its details to the
// renderer. The message is for logs and plain toasts; the renderer words its own from the code. host, own, workspace
// and name fill the placeholders of the text when the caller knows them.
class ChatError extends Error {
  constructor(code, opts = {}) {
    const known = Object.hasOwn(KEYS, code) ? code : 'server';
    const key = errorKey(known, opts);
    const params = {
      count: Number.isSafeInteger(opts.retryAfter) ? opts.retryAfter : 1,
      host: opts.host ?? '…',
      own: opts.own ?? '…',
      workspace: opts.workspace ?? '…',
      name: opts.name ?? '…'
    };
    let message;
    try {
      message = t(key, params);
    } catch (_) {
      message = known;
    }
    super(message, opts.cause ? { cause: opts.cause } : undefined);
    this.name = 'ChatError';
    this.chat = true;
    this.code = known;
    this.status = Number.isSafeInteger(opts.status) ? opts.status : 0;
    this.field = typeof opts.field === 'string' ? opts.field.slice(0, 200) : null;
    this.scope = SCOPES.includes(opts.scope) ? opts.scope : null;
    this.retryAfter = Number.isSafeInteger(opts.retryAfter) ? Math.min(Math.max(opts.retryAfter, 1), 3600) : null;
    this.channels = Array.isArray(opts.channels) ? opts.channels.filter((c) => typeof c === 'string' && CONVERSATION_ID.test(c)).slice(0, 100) : null;
    this.member = typeof opts.member === 'string' && MEMBER_ID.test(opts.member) ? opts.member : null;
    this.limit = typeof opts.limit === 'string' && LIMITS.includes(opts.limit) ? opts.limit : null;
    // Where an answer was refused, such as 'changes[3].head': for logs and tests, never shown.
    if (typeof opts.where === 'string') this.where = opts.where;
  }
}

// An AccountError from AccountService.workspaceCall() as a ChatError. The server's code survives when the renderer or
// an engine acts on it; transport failures are network; a 401 or a missing session is signed_out; anything else is
// server. The details come from client.js's errorDetails().
function chatError(err) {
  if (err instanceof ChatError) return err;
  const account = err instanceof AccountError || (err && typeof err.code === 'string' && typeof err.status === 'number');
  if (!account) return new ChatError('server', { cause: err });
  const details = err.details && typeof err.details === 'object' ? err.details : {};
  let code = err.code;
  if (code === 'unauthorized' || err.status === 401) code = 'signed_out';
  else if (code === 'too_large') code = 'server';
  else if (!Object.hasOwn(KEYS, code)) code = 'server';
  return new ChatError(code, {
    status: err.status,
    field: details.field,
    scope: details.scope,
    retryAfter: details.retryAfter,
    channels: details.channels,
    member: details.member,
    limit: details.limit,
    cause: err
  });
}

const isInternal = (code) => INTERNAL.has(code);

// ---- Mentions ----

// The first rule of contract 3.17 a list of byte ranges breaks in text, or null. The rule names are those of
// test/fixtures/chat-vectors.json: too_many, bad_actor, empty, past_end, split_character, out_of_order, overlap.
// Ranges that touch are allowed.
function mentionRule(text, mentions, max = MENTIONS_MAX) {
  if (!Array.isArray(mentions)) return 'bad_shape';
  if (mentions.length > max) return 'too_many';
  const utf8 = Buffer.from(text, 'utf8');
  const between = (at) => at === utf8.length || (at < utf8.length && (utf8[at] & 0xc0) !== 0x80);
  let prev = null;
  for (const m of mentions) {
    if (!m || typeof m !== 'object' || Array.isArray(m)) return 'bad_shape';
    if (!Number.isSafeInteger(m.start) || !Number.isSafeInteger(m.end) || m.start < 0 || m.end < 0) return 'bad_shape';
    if (typeof m.actor !== 'string' || !MEMBER_ID.test(m.actor)) return 'bad_actor';
    if (m.end <= m.start) return 'empty';
    if (m.end > utf8.length) return 'past_end';
    if (!between(m.start) || !between(m.end)) return 'split_character';
    if (prev) {
      if (m.start < prev.start) return 'out_of_order';
      if (m.start < prev.end) return 'overlap';
    }
    prev = m;
  }
  return null;
}

// Mentions as they go on the wire and into the cache: a copy with only actor, start and end, or ChatError('invalid')
// with field mentions. Desktop main checks byte ranges and passes them on unchanged; only the editors convert.
function checkMentions(text, mentions, { max = MENTIONS_MAX, field = 'mentions' } = {}) {
  if (typeof text !== 'string') throw new ChatError('invalid', { field: 'text' });
  const list = mentions === undefined || mentions === null ? [] : mentions;
  const rule = mentionRule(text, list, max);
  if (rule) throw new ChatError('invalid', { field, where: rule });
  return list.map((m) => ({ actor: m.actor, start: m.start, end: m.end }));
}

// ---- Invitation links ----

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

// An invitation link in pasted text (contract 3.2): { server, workspace, secret }. Throws ChatError('bad_link') for
// text that holds none, and ChatError('other_server') for a link to another server than server, the configured
// account server as serverUrl() writes it. Without server, any server is accepted.
function parseInviteLink(text, server = null) {
  const bad = () => new ChatError('bad_link');
  if (typeof text !== 'string') throw bad();
  // 1. The first http:// or https:// URL in the trimmed text, up to white space.
  const found = /https?:\/\/\S+/.exec(text.trim());
  if (!found) throw bad();
  let url;
  try {
    url = new URL(found[0]);
  } catch (_) {
    throw bad();
  }
  // 2. http only for a server on this computer.
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOCAL_HOSTS.includes(url.hostname))) throw bad();
  // 3. No user info, a path that ends with /join, and a fragment of exactly w and i in any order.
  if (url.username || url.password || !url.pathname.endsWith('/join')) throw bad();
  const pairs = url.hash.replace(/^#/, '').split('&');
  if (pairs.length !== 2) throw bad();
  const fragment = {};
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    if (eq < 0) throw bad();
    const key = pair.slice(0, eq);
    if ((key !== 'w' && key !== 'i') || Object.hasOwn(fragment, key)) throw bad();
    fragment[key] = pair.slice(eq + 1);
  }
  // 4. The shapes of the workspace ID and the secret.
  if (!WORKSPACE_ID.test(fragment.w || '') || !SECRET.test(fragment.i || '')) throw bad();
  // 5. The server: the origin and the path without /join and a trailing slash.
  const linkServer = url.origin + url.pathname.slice(0, -'/join'.length).replace(/\/+$/, '');
  // 6. One server in v1: the person's own.
  if (server !== null && server !== undefined && linkServer !== server) {
    throw new ChatError('other_server', { host: url.host, own: hostOf(server) });
  }
  return { server: linkServer, workspace: fragment.w, secret: fragment.i };
}

function hostOf(server) {
  try {
    return new URL(server).host;
  } catch (_) {
    return String(server);
  }
}

// The link chatCreateInvite hands out: <credential URL>/join#w=<w_id>&i=<secret>.
function inviteLink(server, workspace, secret) {
  if (typeof server !== 'string' || !/^https?:\/\//.test(server)) throw new ChatError('invalid', { field: 'server' });
  if (!WORKSPACE_ID.test(workspace)) throw new ChatError('invalid', { field: 'workspace' });
  if (!SECRET.test(secret)) throw new ChatError('invalid', { field: 'secret' });
  return `${server.replace(/\/+$/, '')}/join#w=${workspace}&i=${secret}`;
}

// ---- IDs ----

// A UUIDv7 operation ID (contract 3.8): bytes 0 to 5 the milliseconds big-endian, byte 6 0x70 | (r[0] & 0x0f), byte 7
// r[1], byte 8 0x80 | (r[2] & 0x3f), bytes 9 to 15 r[3..9]; lowercase hex in 8-4-4-4-12 groups. ms is the server's
// clock as the outbox estimates it.
function uuidv7(ms, random10 = crypto.randomBytes(10)) {
  if (!Number.isSafeInteger(ms) || ms < 0 || ms > 0xffffffffffff) throw new RangeError('uuidv7 needs a 48-bit millisecond time');
  const r = Buffer.from(random10);
  if (r.length !== 10) throw new RangeError('uuidv7 needs 10 random bytes');
  const b = Buffer.alloc(16);
  b.writeUIntBE(ms, 0, 6);
  b[6] = 0x70 | (r[0] & 0x0f);
  b[7] = r[1];
  b[8] = 0x80 | (r[2] & 0x3f);
  r.copy(b, 9, 3, 10);
  const hex = b.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// The renderer's handle of an unsent message: 16 random bytes in base64url.
const localId = () => crypto.randomBytes(16).toString('base64url');

// ---- Checking answers ----

// Thrown for any field of an answer that isn't what the protocol says. The whole answer is refused: nothing of it is
// applied, and the run ends with error server.
function refused(where) {
  return new ChatError('server', { where });
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function obj(v, where) {
  if (!isObject(v)) throw refused(where);
  return v;
}
function id(v, re, where) {
  if (typeof v !== 'string' || !re.test(v)) throw refused(where);
  return v;
}
function int(v, where, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(v) || v < min || v > max) throw refused(where);
  return v;
}
function intOrNull(v, where, min = 0) {
  return v === null || v === undefined ? null : int(v, where, min);
}
function bool(v, where) {
  if (typeof v !== 'boolean') throw refused(where);
  return v;
}
function oneOf(v, list, where) {
  if (!list.includes(v)) throw refused(where);
  return v;
}
function str(v, where, max = NAME_UNITS, min = 0) {
  if (typeof v !== 'string' || v.length < min || v.length > max || !v.isWellFormed()) throw refused(where);
  return v;
}
function list(v, where, max) {
  if (!Array.isArray(v) || v.length > max) throw refused(where);
  return v;
}
function ids(v, re, where, max, min = 0) {
  list(v, where, max);
  if (v.length < min) throw refused(where);
  const out = v.map((x, i) => id(x, re, `${where}[${i}]`));
  if (new Set(out).size !== out.length) throw refused(where);
  return out;
}

// One room row as the feed gives it, and as POST /dms answers with (server/WORKSPACES.md "The feed", contract 2.4).
// members, lastAt and directory.blocks came with direct messages; they default when absent, so a server from before
// them still syncs. A DM carries participants, startedBy and closedReason, and is archived exactly when it closed.
function checkRoom(v, where = 'room') {
  obj(v, where);
  const kind = oneOf(v.kind, ['channel', 'dm'], `${where}.kind`);
  const dm = kind === 'dm';
  const room = {
    conversation: id(v.conversation, CONVERSATION_ID, `${where}.conversation`),
    kind,
    name: dm ? (v.name === null || v.name === undefined || v.name === '' ? null : refusedName(where)) : str(v.name, `${where}.name`, NAME_UNITS, 1),
    visibility: dm ? oneOf(v.visibility, ['dm'], `${where}.visibility`) : oneOf(v.visibility, ['workspace', 'private'], `${where}.visibility`),
    archived: bool(v.archived, `${where}.archived`),
    participants: null,
    startedBy: null,
    closedReason: null,
    grant: id(v.grant, GRANT_ID, `${where}.grant`),
    role: oneOf(v.role, ROOM_ROLES, `${where}.role`),
    members: v.members === undefined ? 0 : int(v.members, `${where}.members`),
    head: int(v.head, `${where}.head`),
    floor: int(v.floor, `${where}.floor`),
    lastAt: intOrNull(v.lastAt, `${where}.lastAt`),
    read: int(v.read, `${where}.read`),
    unread: int(v.unread, `${where}.unread`, 0, BADGE_CAP),
    mentions: int(v.mentions, `${where}.mentions`, 0, BADGE_CAP),
    removed: v.removed === undefined ? [] : ids(v.removed, EVENT_ID, `${where}.removed`, REMOVED_IDS),
    removedMore: v.removedMore === undefined ? false : bool(v.removedMore, `${where}.removedMore`)
  };
  if (room.read > room.head) throw refused(`${where}.read`);
  if (dm) {
    room.participants = ids(v.participants, MEMBER_ID, `${where}.participants`, DM_OTHERS + 1, 2);
    room.startedBy = v.startedBy === null ? null : id(v.startedBy, MEMBER_ID, `${where}.startedBy`);
    room.closedReason = v.closedReason === null ? null : oneOf(v.closedReason, CLOSED_REASONS, `${where}.closedReason`);
    if (room.archived !== (room.closedReason !== null)) throw refused(`${where}.closedReason`);
  }
  return room;
}

function refusedName(where) {
  throw refused(`${where}.name`);
}

// One event (server/WORKSPACES.md "Messages", contract 2.4). Kinds this version doesn't know are kept without their
// fields, so a newer server's event doesn't stop the feed; the timeline shows nothing for them.
function checkEvent(v, where = 'event') {
  obj(v, where);
  const kind = typeof v.kind === 'string' && v.kind.length <= 40 && EVENT_KIND.test(v.kind) ? v.kind : refusedKind(where);
  const e = {
    seq: int(v.seq, `${where}.seq`, 1),
    id: id(v.id, EVENT_ID, `${where}.id`),
    kind,
    actor: id(v.actor, MEMBER_ID, `${where}.actor`),
    at: int(v.at, `${where}.at`)
  };
  switch (kind) {
    case 'message.posted':
      if (v.root !== undefined && v.root !== null) e.root = id(v.root, EVENT_ID, `${where}.root`);
      if (v.redacted === true) {
        if (v.text !== undefined || v.mentions !== undefined) throw refused(`${where}.redacted`);
        e.redacted = true;
        break;
      }
      if (v.redacted !== undefined && v.redacted !== false) throw refused(`${where}.redacted`);
      if (typeof v.text !== 'string' || !v.text.isWellFormed() || v.text.length === 0 || utf8Length(v.text) > TEXT_BYTES) {
        throw refused(`${where}.text`);
      }
      e.text = v.text;
      if (mentionRule(v.text, v.mentions === undefined ? [] : v.mentions)) throw refused(`${where}.mentions`);
      e.mentions = (v.mentions || []).map((m) => ({ actor: m.actor, start: m.start, end: m.end }));
      break;
    case 'message.redacted':
      e.target = id(v.target, EVENT_ID, `${where}.target`);
      e.targetSeq = int(v.targetSeq, `${where}.targetSeq`, 1);
      break;
    case 'channel.created':
      e.name = str(v.name, `${where}.name`, NAME_UNITS, 1);
      e.visibility = oneOf(v.visibility, ['workspace', 'private'], `${where}.visibility`);
      break;
    case 'channel.renamed':
      e.name = str(v.name, `${where}.name`, NAME_UNITS, 1);
      break;
    case 'member.joined':
    case 'member.left':
      e.member = id(v.member, MEMBER_ID, `${where}.member`);
      break;
    case 'dm.started':
      e.members = ids(v.members, MEMBER_ID, `${where}.members`, DM_OTHERS + 1, 2);
      break;
    default:
      break;
  }
  return e;
}

function refusedKind(where) {
  throw refused(`${where}.kind`);
}

// Events in order: each seq above the one before.
function checkEventList(v, where, max) {
  list(v, where, max);
  let last = 0;
  return v.map((x, i) => {
    const e = checkEvent(x, `${where}[${i}]`);
    if (e.seq <= last) throw refused(`${where}[${i}].seq`);
    last = e.seq;
    return e;
  });
}

// GET /changes (server/WORKSPACES.md "The feed").
function checkChanges(v) {
  obj(v, 'changes');
  const changes = list(v.changes, 'changes.changes', FEED_ROWS).map((r, i) => checkRoom(r, `changes.changes[${i}]`));
  const evictions = ids(v.evictions, CONVERSATION_ID, 'changes.evictions', FEED_ROWS);
  if (changes.length + evictions.length > FEED_ROWS) throw refused('changes.changes');
  const rooms = new Set(changes.map((r) => r.conversation));
  if (rooms.size !== changes.length) throw refused('changes.changes');
  const directory = obj(v.directory, 'changes.directory');
  return {
    changes,
    evictions,
    inlineEvents: v.inlineEvents === undefined ? [] : checkEventList(v.inlineEvents, 'changes.inlineEvents', INLINE_EVENTS),
    directory: {
      members: bool(directory.members, 'changes.directory.members'),
      channels: bool(directory.channels, 'changes.directory.channels'),
      blocks: directory.blocks === undefined ? false : bool(directory.blocks, 'changes.directory.blocks')
    },
    next: id(v.next, CURSOR, 'changes.next'),
    more: bool(v.more, 'changes.more')
  };
}

// GET /conversations/{c}/events: { events, head, floor, more }, oldest first.
function checkEvents(v) {
  obj(v, 'events');
  return {
    events: checkEventList(v.events, 'events.events', EVENTS_PAGE),
    head: int(v.head, 'events.head'),
    floor: int(v.floor, 'events.floor'),
    more: v.more === undefined ? false : bool(v.more, 'events.more')
  };
}

function checkMember(v, where = 'member') {
  obj(v, where);
  return {
    id: id(v.id, MEMBER_ID, `${where}.id`),
    kind: str(v.kind, `${where}.kind`, 20, 1),
    // A deleted member's name is empty.
    name: str(v.name, `${where}.name`),
    role: oneOf(v.role, MEMBER_ROLES, `${where}.role`),
    state: oneOf(v.state, MEMBER_STATES, `${where}.state`),
    joinedAt: int(v.joinedAt, `${where}.joinedAt`)
  };
}

function checkWorkspaceRow(v, where) {
  obj(v, where);
  const limits = obj(v.limits, `${where}.limits`);
  const retention = obj(v.retention, `${where}.retention`);
  return {
    id: id(v.id, WORKSPACE_ID, `${where}.id`),
    name: str(v.name, `${where}.name`, NAME_UNITS, 1),
    createdAt: int(v.createdAt, `${where}.createdAt`),
    generation: id(v.generation, GENERATION, `${where}.generation`),
    keyId: id(v.keyId, KEY_ID, `${where}.keyId`),
    time: int(v.time, `${where}.time`),
    limits: {
      members: int(limits.members, `${where}.limits.members`),
      conversations: int(limits.conversations, `${where}.limits.conversations`),
      textBytes: int(limits.textBytes, `${where}.limits.textBytes`)
    },
    retention: {
      contentDays: int(retention.contentDays, `${where}.retention.contentDays`),
      feedDays: int(retention.feedDays, `${where}.retention.feedDays`)
    }
  };
}

// GET /, POST /v1/workspaces and POST /join: { workspace, me }.
function checkWorkspace(v) {
  obj(v, 'workspace');
  return { workspace: checkWorkspaceRow(v.workspace, 'workspace.workspace'), me: checkMember(v.me, 'workspace.me') };
}

// GET /v1/workspaces: { workspaces: [{ id, name, role }] }.
function checkWorkspaces(v) {
  obj(v, 'workspaces');
  const out = list(v.workspaces, 'workspaces.workspaces', WORKSPACES_MAX).map((w, i) => {
    const where = `workspaces.workspaces[${i}]`;
    obj(w, where);
    return { id: id(w.id, WORKSPACE_ID, `${where}.id`), name: str(w.name, `${where}.name`, NAME_UNITS, 1), role: oneOf(w.role, MEMBER_ROLES, `${where}.role`) };
  });
  if (new Set(out.map((w) => w.id)).size !== out.length) throw refused('workspaces.workspaces');
  return { workspaces: out };
}

// GET /members: { members, more }.
function checkMembers(v) {
  obj(v, 'members');
  const members = list(v.members, 'members.members', MEMBERS_MAX).map((m, i) => checkMember(m, `members.members[${i}]`));
  if (new Set(members.map((m) => m.id)).size !== members.length) throw refused('members.members');
  return { members, more: v.more === undefined ? false : bool(v.more, 'members.more') };
}

function checkChannelRow(v, where = 'channel') {
  obj(v, where);
  return {
    id: id(v.id, CONVERSATION_ID, `${where}.id`),
    name: str(v.name, `${where}.name`, NAME_UNITS, 1),
    visibility: oneOf(v.visibility, ['workspace', 'private'], `${where}.visibility`),
    archived: bool(v.archived, `${where}.archived`),
    joined: bool(v.joined, `${where}.joined`),
    role: v.role === null ? null : oneOf(v.role, ROOM_ROLES, `${where}.role`),
    members: int(v.members, `${where}.members`)
  };
}

// GET /channels: { channels }.
function checkChannels(v) {
  obj(v, 'channels');
  const channels = list(v.channels, 'channels.channels', CHANNELS_MAX).map((c, i) => checkChannelRow(c, `channels.channels[${i}]`));
  if (new Set(channels.map((c) => c.id)).size !== channels.length) throw refused('channels.channels');
  return { channels };
}

// POST /channels, PATCH /channels/{c} and POST /channels/{c}/join: { channel }.
function checkChannel(v) {
  obj(v, 'channel');
  return { channel: checkChannelRow(v.channel, 'channel.channel') };
}

// GET /channels/{c}/members: { members: [{ member, role }] }; POST and PATCH answer one { member, role }.
function checkRoomMember(v, where = 'roomMember') {
  obj(v, where);
  return { member: id(v.member, MEMBER_ID, `${where}.member`), role: oneOf(v.role, ROOM_ROLES, `${where}.role`) };
}
function checkRoomMembers(v) {
  obj(v, 'roomMembers');
  return { members: list(v.members, 'roomMembers.members', MEMBERS_MAX).map((m, i) => checkRoomMember(m, `roomMembers.members[${i}]`)) };
}

// GET /blocks: { blocks: [{ member, at }] }; POST /blocks answers one { block }.
function checkBlock(v, where = 'block') {
  obj(v, where);
  return { member: id(v.member, MEMBER_ID, `${where}.member`), at: int(v.at, `${where}.at`) };
}
function checkBlocks(v) {
  obj(v, 'blocks');
  const blocks = list(v.blocks, 'blocks.blocks', BLOCKS_MAX).map((b, i) => checkBlock(b, `blocks.blocks[${i}]`));
  if (new Set(blocks.map((b) => b.member)).size !== blocks.length) throw refused('blocks.blocks');
  return { blocks };
}

// POST /dms: { dm: Room }.
function checkDm(v) {
  obj(v, 'dm');
  const dm = checkRoom(v.dm, 'dm.dm');
  if (dm.kind !== 'dm') throw refused('dm.dm.kind');
  return { dm };
}

function checkInviteRow(v, where) {
  obj(v, where);
  return {
    id: id(v.id, INVITE_ID, `${where}.id`),
    role: oneOf(v.role, ['member', 'guest'], `${where}.role`),
    channels: ids(v.channels, CONVERSATION_ID, `${where}.channels`, INVITE_CHANNELS),
    channelCount: int(v.channelCount, `${where}.channelCount`),
    issuer: id(v.issuer, MEMBER_ID, `${where}.issuer`),
    createdAt: int(v.createdAt, `${where}.createdAt`),
    expiresAt: int(v.expiresAt, `${where}.expiresAt`)
  };
}

// POST /invites: { invite, secret }.
function checkInvite(v) {
  obj(v, 'invite');
  return { invite: checkInviteRow(v.invite, 'invite.invite'), secret: id(v.secret, SECRET, 'invite.secret') };
}

// GET /invites: { invites }.
function checkInvites(v) {
  obj(v, 'invites');
  return { invites: list(v.invites, 'invites.invites', INVITES_MAX).map((x, i) => checkInviteRow(x, `invites.invites[${i}]`)) };
}

// POST /invites/preview: { workspace: { id, name }, role, channels (a count), issuer: { name }, expiresAt }.
function checkPreview(v) {
  obj(v, 'preview');
  const ws = obj(v.workspace, 'preview.workspace');
  const issuer = obj(v.issuer, 'preview.issuer');
  return {
    workspace: { id: id(ws.id, WORKSPACE_ID, 'preview.workspace.id'), name: str(ws.name, 'preview.workspace.name', NAME_UNITS, 1) },
    role: oneOf(v.role, ['member', 'guest'], 'preview.role'),
    channels: int(v.channels, 'preview.channels'),
    issuer: { name: str(issuer.name, 'preview.issuer.name') },
    expiresAt: int(v.expiresAt, 'preview.expiresAt')
  };
}

// POST /conversations/{c}/messages: { operationId, messageId, seq }.
function checkPost(v) {
  obj(v, 'post');
  return {
    operationId: id(v.operationId, UUID_V7, 'post.operationId'),
    messageId: id(v.messageId, EVENT_ID, 'post.messageId'),
    seq: int(v.seq, 'post.seq', 1)
  };
}

// GET /conversations/{c}/operations/{operationId}: { messageId, seq, visible }.
function checkOperation(v) {
  obj(v, 'operation');
  return {
    messageId: id(v.messageId, EVENT_ID, 'operation.messageId'),
    seq: int(v.seq, 'operation.seq', 1),
    visible: v.visible === undefined ? true : bool(v.visible, 'operation.visible')
  };
}

// POST /conversations/{c}/read: { read }.
function checkRead(v) {
  obj(v, 'read');
  return { read: int(v.read, 'read.read') };
}

// POST /conversations/{c}/messages/{e}/redact: { messageId, redacted: true }.
function checkRedact(v) {
  obj(v, 'redact');
  if (v.redacted !== true) throw refused('redact.redacted');
  return { messageId: id(v.messageId, EVENT_ID, 'redact.messageId'), redacted: true };
}

// PATCH /members/me: { me }; PATCH /members/{u}: { member }.
function checkMe(v) {
  obj(v, 'me');
  return { me: checkMember(v.me, 'me.me') };
}
function checkMemberAnswer(v) {
  obj(v, 'member');
  return { member: checkMember(v.member, 'member.member') };
}

// POST /socket-ticket: { ticket, expiresAt, protocol }.
function checkTicket(v) {
  obj(v, 'ticket');
  return {
    ticket: str(v.ticket, 'ticket.ticket', 1024, 1),
    expiresAt: int(v.expiresAt, 'ticket.expiresAt'),
    protocol: str(v.protocol, 'ticket.protocol', 64, 1)
  };
}

// ---- Shapes for the renderer (contract 4.6) ----

function parseJson(text, fallback) {
  if (text === null || text === undefined) return fallback;
  try {
    return JSON.parse(text);
  } catch (_) {
    return fallback;
  }
}

const DATA_FIELDS = ['name', 'visibility', 'member', 'members', 'target', 'targetSeq'];

// A cached event row as the renderer's Event: mentions in UTF-8 bytes as the server sent them.
function toRenderer(row) {
  const raw = parseJson(row.data, {});
  const data = {};
  for (const key of DATA_FIELDS) if (isObject(raw) && raw[key] !== undefined) data[key] = raw[key];
  const mentions = parseJson(row.mentions, []);
  return {
    seq: row.seq,
    id: row.id,
    kind: row.kind,
    actor: row.actor,
    at: row.at,
    root: row.root ?? null,
    text: row.redacted ? null : row.text ?? null,
    mentions: row.redacted || !Array.isArray(mentions) ? [] : mentions,
    redacted: Boolean(row.redacted),
    data
  };
}

// A cached room row as the renderer's Room. A muted room asks for no attention; a DM asks for its unread messages and
// a channel for its mentions (contract 3.10).
function toRoom(row) {
  const dm = row.kind === 'dm';
  const muted = Boolean(row.muted);
  return {
    id: row.id,
    kind: row.kind,
    name: dm ? null : row.name ?? null,
    visibility: row.visibility,
    archived: Boolean(row.archived),
    closedReason: row.closedReason ?? null,
    participants: dm ? parseJson(row.participants, []) : null,
    startedBy: row.startedBy ?? null,
    role: row.role,
    members: row.members,
    head: row.head,
    floor: row.floor,
    lastAt: row.lastAt ?? null,
    read: row.readLocal,
    unread: row.unread,
    mentions: row.mentions,
    attention: muted ? 0 : dm ? row.unread : row.mentions,
    muted,
    hasCache: row.lo !== null && row.lo !== undefined
  };
}

// An outbox row as the renderer's Pending. waiting: a held or failed row before it in its room holds it back.
function toPending(row, { waiting = false } = {}) {
  return {
    local: row.local,
    ws: row.ws,
    conversation: row.room,
    root: row.root ?? null,
    text: row.text,
    mentions: parseJson(row.mentions, []),
    state: waiting && row.state === 'queued' ? 'waiting' : row.state,
    reason: row.reason ?? null,
    nextAt: row.nextAt,
    createdAt: row.createdAt
  };
}

// ---- IPC arguments (contract 4.4) ----

const invalid = (field) => new ChatError('invalid', { field });

function plain(v, field) {
  if (!isObject(v)) throw invalid(field);
  return v;
}

// A name people see: trimmed, 1 to 80 code points, one line, without the characters the server refuses.
function name(v, field = 'name') {
  if (typeof v !== 'string' || v.length > NAME_UNITS * 4) throw invalid(field);
  const trimmed = v.trim();
  if (!trimmed || !trimmed.isWellFormed() || Array.from(trimmed).length > NAME_LENGTH || /[\p{Cc}\p{Zl}\p{Zp}‪-‮⁦-⁩]/u.test(trimmed)) {
    throw invalid(field);
  }
  return trimmed;
}

const pattern = (re, field) => (v) => {
  if (typeof v !== 'string' || !re.test(v)) throw invalid(field);
  return v;
};
const orNull = (check) => (v) => (v === null || v === undefined ? null : check(v));

function seqValue(v, field, min) {
  if (!Number.isSafeInteger(v) || v < min) throw invalid(field);
  return v;
}

function textOf(v, { field = 'text', maxBytes, allowEmpty }) {
  if (typeof v !== 'string' || !v.isWellFormed()) throw invalid(field);
  const bytes = utf8Length(v);
  if (bytes > maxBytes || (!allowEmpty && (bytes === 0 || v.trim() === ''))) throw invalid(field);
  return v;
}

function oneOfInput(v, values, field) {
  if (!values.includes(v)) throw invalid(field);
  return v;
}

// The checks each argument goes through, by what it is.
const input = {
  ws: pattern(WORKSPACE_ID, 'ws'),
  conversation: pattern(CONVERSATION_ID, 'conversation'),
  member: pattern(MEMBER_ID, 'member'),
  message: pattern(EVENT_ID, 'message'),
  root: orNull(pattern(EVENT_ID, 'root')),
  invite: pattern(INVITE_ID, 'invite'),
  local: pattern(LOCAL_ID, 'local'),
  name,
  seq: (v, field = 'seq') => seqValue(v, field, 0),
  before: (v) => seqValue(v, 'before', 1),
  bool: (v, field) => {
    if (typeof v !== 'boolean') throw invalid(field);
    return v;
  },
  link(v) {
    if (typeof v !== 'string' || v.trim() === '' || v.length > LINK_LENGTH) throw invalid('link');
    return v;
  },
  // A message to send: the text exactly as it goes on the wire, 1 to 16,384 bytes with something besides white space,
  // at most 32 mentions in its UTF-8 bytes, and a thread root or null.
  send(v) {
    plain(v, 'input');
    const text = textOf(v.text, { maxBytes: TEXT_BYTES, allowEmpty: false });
    return { text, mentions: checkMentions(text, v.mentions), root: input.root(v.root) };
  },
  draft(v) {
    if (v === null || v === undefined) return null;
    plain(v, 'draft');
    const text = textOf(v.text, { maxBytes: DRAFT_BYTES, allowEmpty: true });
    return { text, mentions: checkMentions(text, v.mentions, { max: DRAFT_MENTIONS }) };
  },
  openOptions(v) {
    if (v === null || v === undefined) return {};
    plain(v, 'opts');
    return v.at === undefined || v.at === null ? {} : { at: seqValue(v.at, 'at', 1) };
  },
  resendOptions(v) {
    plain(v, 'opts');
    return { mode: oneOfInput(v.mode, ['send', 'retry', 'withoutMentions'], 'mode') };
  },
  newWorkspace(v) {
    plain(v, 'input');
    return { name: name(v.name, 'name'), displayName: name(v.displayName, 'displayName') };
  },
  join(v) {
    plain(v, 'input');
    return { link: input.link(v.link), name: name(v.name, 'name') };
  },
  workspaceRole: (v) => oneOfInput(v, MEMBER_ROLES, 'role'),
  channelRole: (v) => oneOfInput(v, ROOM_ROLES, 'role'),
  newInvite(v) {
    plain(v, 'input');
    const role = oneOfInput(v.role, ['member', 'guest'], 'role');
    const channels = v.channels === undefined || v.channels === null ? [] : v.channels;
    if (!Array.isArray(channels) || channels.length > INVITE_CHANNELS) throw invalid('channels');
    const out = channels.map(pattern(CONVERSATION_ID, 'channels'));
    if (new Set(out).size !== out.length) throw invalid('channels');
    if (role === 'guest' && out.length === 0) throw invalid('channels');
    const expiresIn = v.expiresIn === undefined || v.expiresIn === null ? INVITE_EXPIRY[0] : oneOfInput(v.expiresIn, INVITE_EXPIRY, 'expiresIn');
    return { role, channels: out, expiresIn };
  },
  newChannel(v) {
    plain(v, 'input');
    return { name: name(v.name, 'name'), visibility: oneOfInput(v.visibility, ['workspace', 'private'], 'visibility') };
  },
  successor: orNull(pattern(MEMBER_ID, 'successor')),
  dmMembers(v) {
    if (!Array.isArray(v) || v.length < 1 || v.length > DM_OTHERS) throw invalid('members');
    const out = v.map(pattern(MEMBER_ID, 'members'));
    if (new Set(out).size !== out.length) throw invalid('members');
    return out;
  }
};

const ws = (v) => input.ws(v);
const c = (v) => input.conversation(v);

// Every IPC method of contract 4.4 with the checks of its arguments, in order. Each returns the arguments the method
// gets: trimmed names, copied objects, null for an omitted optional one. ipc.js runs them before anything else.
const ARGS = {
  chatState: () => [],
  chatSelect: (w) => [orNull(ws)(w)],
  chatView: (w) => [ws(w)],
  chatSync: (w) => [orNull(ws)(w)],
  chatReload: (w) => [ws(w)],
  chatOpen: (w, conv, opts) => [ws(w), c(conv), input.openOptions(opts)],
  chatClose: () => [],
  chatOlder: (w, conv, before) => [ws(w), c(conv), input.before(before)],
  chatThread: (w, conv, root) => [ws(w), c(conv), pattern(EVENT_ID, 'root')(root)],
  chatRoomMembers: (w, conv) => [ws(w), c(conv)],
  chatRead: (w, conv, seq) => [ws(w), c(conv), input.seq(seq)],
  chatMarkRead: (w, conv) => [ws(w), c(conv)],
  chatMute: (w, conv, muted) => [ws(w), c(conv), input.bool(muted, 'muted')],
  chatSaveDraft: (w, conv, root, draft) => [ws(w), c(conv), input.root(root), input.draft(draft)],
  chatSend: (w, conv, x) => [ws(w), c(conv), input.send(x)],
  chatResend: (local, opts) => [input.local(local), input.resendOptions(opts)],
  chatDiscard: (local) => [input.local(local)],
  chatRedact: (w, conv, message) => [ws(w), c(conv), input.message(message)],
  chatCreateWorkspace: (x) => [input.newWorkspace(x)],
  chatPreviewInvite: (link) => [input.link(link)],
  chatJoin: (x) => [input.join(x)],
  chatTakePendingJoin: () => [],
  chatLeaveWorkspace: (w) => [ws(w)],
  chatDeleteWorkspace: (w) => [ws(w)],
  chatSetMyName: (w, n) => [ws(w), name(n, 'name')],
  chatSetRole: (w, member, role) => [ws(w), input.member(member), input.workspaceRole(role)],
  chatRemoveMember: (w, member) => [ws(w), input.member(member)],
  chatInvites: (w) => [ws(w)],
  chatCreateInvite: (w, x) => [ws(w), input.newInvite(x)],
  chatWithdrawInvite: (w, invite) => [ws(w), input.invite(invite)],
  chatCreateChannel: (w, x) => [ws(w), input.newChannel(x)],
  chatRenameChannel: (w, conv, n) => [ws(w), c(conv), name(n, 'name')],
  chatArchiveChannel: (w, conv) => [ws(w), c(conv)],
  chatJoinChannel: (w, conv) => [ws(w), c(conv)],
  chatAddToChannel: (w, conv, member) => [ws(w), c(conv), input.member(member)],
  chatSetChannelRole: (w, conv, member, role) => [ws(w), c(conv), input.member(member), input.channelRole(role)],
  chatRemoveFromChannel: (w, conv, member) => [ws(w), c(conv), input.member(member)],
  chatLeaveChannel: (w, conv, successor) => [ws(w), c(conv), input.successor(successor)],
  chatStartDm: (w, members) => [ws(w), input.dmMembers(members)],
  chatLeaveDm: (w, conv) => [ws(w), c(conv)],
  chatBlock: (w, member) => [ws(w), input.member(member)],
  chatUnblock: (w, member) => [ws(w), input.member(member)]
};

// The checked arguments of one IPC call, or ChatError('invalid') with the field that failed. An unknown method is
// refused too, so a method can't reach the service without a check.
function checkArgs(method, args = []) {
  if (!Object.hasOwn(ARGS, method)) throw invalid('method');
  return ARGS[method](...args);
}

module.exports = {
  ChatError,
  chatError,
  errorKey,
  isInternal,
  mentionRule,
  checkMentions,
  parseInviteLink,
  inviteLink,
  uuidv7,
  localId,
  checkChanges,
  checkEvents,
  checkEvent,
  checkRoom,
  checkWorkspace,
  checkWorkspaces,
  checkMembers,
  checkChannels,
  checkChannel,
  checkRoomMembers,
  checkRoomMember,
  checkBlocks,
  checkBlock,
  checkDm,
  checkInvite,
  checkInvites,
  checkPreview,
  checkPost,
  checkOperation,
  checkRead,
  checkRedact,
  checkMe,
  checkMemberAnswer,
  checkTicket,
  toRenderer,
  toRoom,
  toPending,
  input,
  ARGS,
  checkArgs,
  patterns: { WORKSPACE_ID, CONVERSATION_ID, MEMBER_ID, EVENT_ID, GRANT_ID, INVITE_ID, LOCAL_ID, SECRET, GENERATION, CURSOR, UUID_V7 },
  limits: { NAME_LENGTH, TEXT_BYTES, MENTIONS_MAX, DRAFT_BYTES, DRAFT_MENTIONS, LINK_LENGTH, INVITE_CHANNELS, INVITE_EXPIRY, DM_OTHERS, BADGE_CAP }
};
