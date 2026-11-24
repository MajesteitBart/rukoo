'use strict';

// What crosses the edges of team chat in the main process: the server's answers, which are checked whole before
// anything of them reaches the cache, the renderer's IPC arguments, which are checked before any request, and the
// errors the renderer tells apart. Nothing here talks to the network or the disk. The rules are in server/WORKSPACES.md
// ("Gate 1 routes") and in the team chat contract: invitation links (3.2), operation IDs (3.8), errors (3.15), names
// and limits (3.16), mentions (3.17), IPC methods (4.4) and the shapes the renderer gets (4.6). Rich messages
// (reactions, files, link cards, mark unread) follow the rich chat contract: the message shape (2.2), reactions (2.4),
// mark unread (2.5), files (2.6), link cards (2.7), the new event kinds (2.8) and errors (2.9), and the desktop's IPC
// methods and shapes (4.3 to 4.5).
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
const FILE_ID = ID('f');
const LOCAL_ID = /^[A-Za-z0-9_-]{22}$/;
const SHA256 = /^[0-9a-f]{64}$/;
// A reaction is one fully qualified emoji of Unicode's RGI set, as the server checks it (rich contract 2.4).
const RGI_EMOJI = /^\p{RGI_Emoji}$/v;
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
// Rich messages (rich contract 2.2 to 2.7): files per message, link cards per message, distinct emoji per message,
// the bytes of one emoji, a file's name in characters and its type, an image side, and the longest link.
const ATTACHMENTS_MAX = 10;
const PREVIEWS_MAX = 3;
const REACTIONS_MAX = 20;
const EMOJI_BYTES = 64;
const FILE_NAME = 255;
const FILE_TYPE = 127;
const IMAGE_SIDE = 65535;
const URL_LENGTH = 4096;
// A card's texts as the server cuts them (200, 500 and 100 characters and an ellipsis), with room for characters of
// two UTF-16 units each.
const PREVIEW_TITLE = 402;
const PREVIEW_DESCRIPTION = 1002;
const PREVIEW_SITE = 202;

const MEMBER_ROLES = ['owner', 'admin', 'member', 'guest'];
const MEMBER_STATES = ['active', 'left', 'removed', 'deleted'];
const ROOM_ROLES = ['manager', 'member'];
const CLOSED_REASONS = ['left', 'ineligible', 'closed'];
const SCOPES = ['account', 'workspace', 'conversation'];
const LIMITS = ['members', 'conversations', 'invites', 'bytes', 'dailyDms', 'fileBytes', 'files', 'uploads', 'agents'];
// Agents in channels (server/WORKSPACES.md "Agents"): whom an agent answers, the most people it may answer besides its
// sponsor, and the shape of its key (rka_<the 22 characters of its member ID>.<43 characters>), shown once.
const AGENT_ANSWERS = ['everyone', 'sponsor', 'members'];
const AGENT_CHOSEN = 50;
const AGENT_KEY = /^rka_[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/;
// A directory answer lists a guest's or an agent's chosen people only as far as the viewer may know them; a full
// member's lists them all. Room for a server with a higher limit than this version's.
const AGENT_CHOSEN_WIRE = 200;

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
  reset_required: 'chat.errors.failed',
  // Rich messages (rich contract 2.9). invalid_state and expired concern an upload or download link, which files.js
  // handles itself by reserving or asking again; unreadable is the app's: a file on this computer it couldn't read.
  reaction_limit: 'chat.errors.reactionLimit',
  files_off: 'chat.errors.filesOff',
  too_large: 'chat.errors.fileTooLarge',
  files_unavailable: 'chat.errors.filesUnavailable',
  invalid_state: 'chat.errors.failed',
  expired: 'chat.errors.failed',
  unreadable: 'chat.errors.fileUnreadable',
  // Agents in channels (server/WORKSPACES.md "Agents"): what the routes for people refuse about an agent.
  agent_limit: 'chat.errors.agentLimit',
  agent_in_dm: 'chat.errors.agentInDm',
  agent_not_manager: 'chat.errors.agentNotManager',
  agent_block: 'chat.errors.agentBlock',
  agent_role: 'chat.errors.agentRole',
  // An agent comes into a private channel only while the person who made it is in it.
  sponsor_not_in_channel: 'chat.errors.agentSponsorNotInChannel'
};
// Never call errors: the engines turn these into outbox rows and workspace states (contract 3.15).
const INTERNAL = new Set(['operation_conflict', 'submission_expired', 'stale_grant', 'stale_generation', 'history_regressed', 'reset_required']);
const QUOTA_KEYS = {
  members: 'chat.errors.quotaMembers',
  conversations: 'chat.errors.quotaConversations',
  invites: 'chat.errors.quotaInvites',
  bytes: 'chat.errors.quotaBytes',
  files: 'chat.errors.quotaFiles'
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
  if (code === 'rate_limited' && limit === 'uploads') return 'chat.errors.uploadsLimit';
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
  // The server's 413 too_large is a file over its limit; client.js's own too_large is an answer too big to read.
  else if (code === 'too_large' && err.status !== 413) code = 'server';
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
// Characters that can't end a link, such as the full stop of a sentence or the bracket around a link, and the ones
// that can't start a link written without its scheme. A secret or workspace ID never ends in one.
const LINK_QUOTES = '‘’‚“”„«»‹›';
const LINK_CLOSING = new RegExp(`[.,;:!?)\\]}>'"${LINK_QUOTES}]+$`);
const LINK_OPENING = new RegExp(`^[(\\[{<'"${LINK_QUOTES}]+`);
// <host>[:<port>][/<path>]/join#<fragment>, a link pasted without https://.
const LINK_WITHOUT_SCHEME = /^[A-Za-z0-9.-]+(:[0-9]+)?(\/\S*)?\/join#\S*$/;

// Step 1 of contract 3.2: the first http:// or https:// URL in the trimmed text up to white space, without the
// characters that can't end a link. Without one, the first word that is a link without its scheme, read as https.
function linkInText(text) {
  const trimmed = text.trim();
  const found = /https?:\/\/\S+/.exec(trimmed);
  if (found) return found[0].replace(LINK_CLOSING, '');
  for (const word of trimmed.split(/\s+/)) {
    const bare = word.replace(LINK_OPENING, '').replace(LINK_CLOSING, '');
    if (LINK_WITHOUT_SCHEME.test(bare)) return `https://${bare}`;
  }
  return null;
}

// An invitation link in pasted text (contract 3.2): { server, workspace, secret }. Throws ChatError('bad_link') for
// text that holds none, and ChatError('other_server') for a link to another server than server: the configured
// account server as serverUrl() writes it, or a list of the addresses that count as that server (sameServers()), the
// configured one first. Without server, any server is accepted.
function parseInviteLink(text, server = null) {
  const bad = () => new ChatError('bad_link');
  if (typeof text !== 'string') throw bad();
  // 1. The link in the text.
  const found = linkInText(text);
  if (!found) throw bad();
  let url;
  try {
    url = new URL(found);
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
  // 6. One server in v1: the person's own, under any address it answers at.
  const accepted = server === null || server === undefined ? null : [].concat(server).filter((s) => typeof s === 'string' && s);
  if (accepted && !accepted.includes(linkServer)) {
    throw new ChatError('other_server', { host: url.host, own: hostOf(accepted[0] || '') });
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

// Addresses that are one server (contract 3.2). rukoo.io was rukoo-account.bvdm.ai, which still serves the same
// accounts and workspaces (account/index.js FORMER_SERVERS), so a link made on a device that still uses the old address
// opens on one that uses the new, and the other way round. The app knows these itself: a server's own /v1/info can't
// add to them, or a server that claimed rukoo.io as its home would get the secrets of rukoo.io links its users paste.
// Android's InviteLink.SAME_SERVERS is the same list.
const SAME_SERVERS = Object.freeze([Object.freeze(['https://rukoo.io', 'https://rukoo-account.bvdm.ai'])]);

// The workspace home of a server's GET /v1/info (workspace.home.origin, server/WORKSPACES.md): an https origin, or
// http on this computer. null without one.
function homeOf(info) {
  const home = info && info.workspace && typeof info.workspace === 'object' && info.workspace.home;
  const origin = home && typeof home === 'object' ? home.origin : null;
  if (typeof origin !== 'string' || !origin || origin.length > 2000) return null;
  let url;
  try {
    url = new URL(origin);
  } catch (_) {
    return null;
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOCAL_HOSTS.includes(url.hostname))) return null;
  if (url.username || url.password) return null;
  return url.origin;
}

// The addresses an invitation link may name for the configured server: that server first, then the others of its
// group in SAME_SERVERS. Every request still goes to the configured server; these only decide which links are its own.
function sameServers(server) {
  if (typeof server !== 'string' || !server) return [];
  const group = SAME_SERVERS.find((g) => g.includes(server));
  return group ? [server, ...group.filter((s) => s !== server)] : [server];
}

// Where a new invitation link points: the home the server's /v1/info names when it is one of the server's own
// addresses (sameServers), so every device of the server reads the link as its own, whichever address it signed in
// at. Any other home is only the server's claim, and the link names the configured server.
function inviteServer(server, info = null) {
  const home = homeOf(info);
  return home && sameServers(server).includes(home) ? home : server;
}

// The invite field of a sign-up form (contract 3.3), against servers (sameServers()): an invitation link for the
// configured server becomes workspaceInvite { workspace, invite } and the link to remember; anything else stays the
// operator's invite code. A link to another server throws ChatError('other_server'): sent as an invite code, its secret
// would reach this server. manage.js splitInvite uses it, and the browser's sign-up when its chat engine couldn't start.
function splitInvite(text, servers) {
  const raw = typeof text === 'string' ? text : '';
  let found = null;
  try {
    found = parseInviteLink(raw, servers);
  } catch (err) {
    if (err && err.code === 'other_server') throw err;
    found = null;
  }
  if (!found) return { invite: raw, workspaceInvite: null, link: null };
  return {
    invite: '',
    workspaceInvite: { workspace: found.workspace, invite: found.secret },
    link: inviteLink(found.server, found.workspace, found.secret)
  };
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
// A time in milliseconds since 1970 that a JavaScript Date can hold (8.64e15, the year 275760): the renderer turns
// every time it shows into a Date, and a later one would throw there.
const TIME_MAX = 8.64e15;
function time(v, where) {
  return int(v, where, 0, TIME_MAX);
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
    // The agents holding a grant in the room, which members leaves out (server/WORKSPACES.md "Agents"); 0 from a
    // server from before them.
    agents: v.agents === undefined ? 0 : int(v.agents, `${where}.agents`),
    head: int(v.head, `${where}.head`),
    floor: int(v.floor, `${where}.floor`),
    lastAt: v.lastAt === null || v.lastAt === undefined ? null : time(v.lastAt, `${where}.lastAt`),
    read: int(v.read, `${where}.read`),
    unread: int(v.unread, `${where}.unread`, 0, BADGE_CAP),
    mentions: int(v.mentions, `${where}.mentions`, 0, BADGE_CAP),
    removed: v.removed === undefined ? [] : ids(v.removed, EVENT_ID, `${where}.removed`, REMOVED_IDS),
    removedMore: v.removedMore === undefined ? false : bool(v.removedMore, `${where}.removedMore`),
    // How often the person marked the room unread (rich contract 2.5); 0 from a server from before it.
    readMark: v.readMark === undefined ? 0 : int(v.readMark, `${where}.readMark`)
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

// A file of a message or a card's image (rich contract 2.2): { id, name, type, size, width?, height? }.
function checkFile(v, where = 'file') {
  obj(v, where);
  const f = {
    id: id(v.id, FILE_ID, `${where}.id`),
    name: str(v.name, `${where}.name`, FILE_NAME * 2, 1),
    type: str(v.type, `${where}.type`, FILE_TYPE, 1),
    size: int(v.size, `${where}.size`, 1)
  };
  if (v.width !== undefined && v.width !== null) f.width = int(v.width, `${where}.width`, 1, IMAGE_SIDE);
  if (v.height !== undefined && v.height !== null) f.height = int(v.height, `${where}.height`, 1, IMAGE_SIDE);
  return f;
}

function checkFiles(v, where, max = ATTACHMENTS_MAX) {
  const out = list(v, where, max).map((f, i) => checkFile(f, `${where}[${i}]`));
  if (new Set(out.map((f) => f.id)).size !== out.length) throw refused(where);
  return out;
}

function webUrl(v, where) {
  str(v, where, URL_LENGTH, 1);
  if (!/^https?:\/\/\S+$/i.test(v)) throw refused(where);
  return v;
}

// A link card (rich contract 2.2 and 2.7): { url, title, description, site, image, video }.
function checkLinkPreview(v, where = 'preview') {
  obj(v, where);
  return {
    url: webUrl(v.url, `${where}.url`),
    title: str(v.title, `${where}.title`, PREVIEW_TITLE, 1),
    description: v.description === undefined ? '' : str(v.description, `${where}.description`, PREVIEW_DESCRIPTION),
    site: v.site === undefined ? '' : str(v.site, `${where}.site`, PREVIEW_SITE),
    image: v.image === undefined || v.image === null ? null : checkFile(v.image, `${where}.image`),
    video: v.video === undefined ? false : bool(v.video, `${where}.video`)
  };
}

function checkLinkPreviews(v, where) {
  return list(v, where, PREVIEWS_MAX).map((p, i) => checkLinkPreview(p, `${where}[${i}]`));
}

function emojiText(v, where) {
  if (typeof v !== 'string' || !v.length || !v.isWellFormed() || utf8Length(v) > EMOJI_BYTES) throw refused(where);
  return v;
}

// A message's reactions (rich contract 2.2): one group per emoji, in the order of their first reaction, each with
// the people who reacted in the order they did.
function checkReactions(v, where) {
  const out = list(v, where, REACTIONS_MAX).map((r, i) => {
    obj(r, `${where}[${i}]`);
    return { emoji: emojiText(r.emoji, `${where}[${i}].emoji`), actors: ids(r.actors, MEMBER_ID, `${where}[${i}].actors`, MEMBERS_MAX, 1) };
  });
  if (new Set(out.map((r) => r.emoji)).size !== out.length) throw refused(where);
  return out;
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
    at: time(v.at, `${where}.at`)
  };
  switch (kind) {
    case 'message.posted': {
      if (v.root !== undefined && v.root !== null) e.root = id(v.root, EVENT_ID, `${where}.root`);
      if (v.redacted === true) {
        if (v.text !== undefined || v.mentions !== undefined) throw refused(`${where}.redacted`);
        e.redacted = true;
        break;
      }
      if (v.redacted !== undefined && v.redacted !== false) throw refused(`${where}.redacted`);
      // Files, cards and reactions came with rich messages (rich contract 2.2); a server from before sends none.
      const attachments = v.attachments === undefined ? [] : checkFiles(v.attachments, `${where}.attachments`);
      // With a file the text may be empty.
      const empty = attachments.length > 0;
      if (typeof v.text !== 'string' || !v.text.isWellFormed() || (v.text.length === 0 && !empty) || utf8Length(v.text) > TEXT_BYTES) {
        throw refused(`${where}.text`);
      }
      e.text = v.text;
      if (mentionRule(v.text, v.mentions === undefined ? [] : v.mentions)) throw refused(`${where}.mentions`);
      e.mentions = (v.mentions || []).map((m) => ({ actor: m.actor, start: m.start, end: m.end }));
      e.attachments = attachments;
      e.previews = v.previews === undefined ? [] : checkLinkPreviews(v.previews, `${where}.previews`);
      e.reactions = v.reactions === undefined ? [] : checkReactions(v.reactions, `${where}.reactions`);
      // An agent's reply names the message that asked for it, how deep in a chain of agents it is, and origin: the
      // person who started the chain (server/WORKSPACES.md "Agents"). A person's message has none of the three, which
      // is depth 0. The cache keeps them in data, and a removed message loses them.
      if (v.trigger !== undefined && v.trigger !== null) e.trigger = id(v.trigger, EVENT_ID, `${where}.trigger`);
      if (v.depth !== undefined && v.depth !== null) e.depth = int(v.depth, `${where}.depth`, 1, 1000);
      if (v.origin !== undefined && v.origin !== null) e.origin = id(v.origin, MEMBER_ID, `${where}.origin`);
      break;
    }
    case 'message.redacted':
      e.target = id(v.target, EVENT_ID, `${where}.target`);
      e.targetSeq = int(v.targetSeq, `${where}.targetSeq`, 1);
      break;
    // Rich contract 2.8. They never show as a row, count or alert; the cache applies them to their target.
    case 'reaction.added':
    case 'reaction.removed':
      e.target = id(v.target, EVENT_ID, `${where}.target`);
      e.targetSeq = int(v.targetSeq, `${where}.targetSeq`, 1);
      e.emoji = emojiText(v.emoji, `${where}.emoji`);
      break;
    case 'message.previewed':
      e.target = id(v.target, EVENT_ID, `${where}.target`);
      e.targetSeq = int(v.targetSeq, `${where}.targetSeq`, 1);
      e.previews = checkLinkPreviews(v.previews, `${where}.previews`);
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

// A member of the directory. An agent is kind 'agent' with role member, and its reply settings in agent (server/
// WORKSPACES.md "Agents"): { sponsor, answers, members, agents }, members [] unless it answers 'members'. A person has
// no agent field. A kind this version doesn't know stays as it came; the renderer shows it as a person.
function checkMember(v, where = 'member') {
  obj(v, where);
  const out = {
    id: id(v.id, MEMBER_ID, `${where}.id`),
    kind: str(v.kind, `${where}.kind`, 20, 1),
    // A deleted member's name is empty.
    name: str(v.name, `${where}.name`),
    role: oneOf(v.role, MEMBER_ROLES, `${where}.role`),
    state: oneOf(v.state, MEMBER_STATES, `${where}.state`),
    joinedAt: time(v.joinedAt, `${where}.joinedAt`)
  };
  if (out.kind === 'agent' && v.agent !== undefined && v.agent !== null) out.agent = checkAgentSettings(v.agent, `${where}.agent`);
  return out;
}

// An agent's reply settings as the directory carries them. answers is one of AGENT_ANSWERS, or a newer server's word
// that the renderer shows nothing for; sponsor may be null when the server no longer has the sponsor's row.
function checkAgentSettings(v, where) {
  obj(v, where);
  if (typeof v.answers !== 'string' || !/^[a-z][a-z_]{0,19}$/.test(v.answers)) throw refused(`${where}.answers`);
  return {
    sponsor: v.sponsor === null || v.sponsor === undefined ? null : id(v.sponsor, MEMBER_ID, `${where}.sponsor`),
    answers: v.answers,
    members: v.members === undefined || v.members === null ? [] : ids(v.members, MEMBER_ID, `${where}.members`, AGENT_CHOSEN_WIRE),
    agents: v.agents === undefined ? false : bool(v.agents, `${where}.agents`)
  };
}

// An agent as GET /agents lists it, and as the routes that make or change one answer (server/WORKSPACES.md AgentOut):
// { id, name, sponsor, answers, members, agents, lastSeen, createdAt }.
function checkAgentRow(v, where = 'agent') {
  obj(v, where);
  const settings = checkAgentSettings(v, where);
  return {
    id: id(v.id, MEMBER_ID, `${where}.id`),
    name: str(v.name, `${where}.name`, NAME_UNITS, 1),
    sponsor: settings.sponsor,
    answers: settings.answers,
    members: settings.members,
    agents: settings.agents,
    lastSeen: v.lastSeen === null || v.lastSeen === undefined ? null : time(v.lastSeen, `${where}.lastSeen`),
    createdAt: time(v.createdAt, `${where}.createdAt`)
  };
}

// GET /agents: { agents }.
function checkAgents(v) {
  obj(v, 'agents');
  const agents = list(v.agents, 'agents.agents', MEMBERS_MAX).map((a, i) => checkAgentRow(a, `agents.agents[${i}]`));
  if (new Set(agents.map((a) => a.id)).size !== agents.length) throw refused('agents.agents');
  return { agents };
}

// PATCH /agents/{u}: { agent }; POST /agents and POST /agents/{u}/key: { agent, key }, the key shown only then. The key
// must be the agent's own: its name is the 22 characters after u_ in the agent's ID.
function checkAgentAnswer(v, { key = false } = {}) {
  obj(v, 'agent');
  const agent = checkAgentRow(v.agent, 'agent.agent');
  if (!key) return { agent };
  if (typeof v.key !== 'string' || !AGENT_KEY.test(v.key) || v.key.slice(4, 26) !== agent.id.slice(2)) throw refused('agent.key');
  return { agent, key: v.key };
}

function checkWorkspaceRow(v, where) {
  obj(v, where);
  const limits = obj(v.limits, `${where}.limits`);
  const retention = obj(v.retention, `${where}.retention`);
  return {
    id: id(v.id, WORKSPACE_ID, `${where}.id`),
    name: str(v.name, `${where}.name`, NAME_UNITS, 1),
    createdAt: time(v.createdAt, `${where}.createdAt`),
    generation: id(v.generation, GENERATION, `${where}.generation`),
    keyId: id(v.keyId, KEY_ID, `${where}.keyId`),
    time: time(v.time, `${where}.time`),
    limits: {
      members: int(limits.members, `${where}.limits.members`),
      conversations: int(limits.conversations, `${where}.limits.conversations`),
      textBytes: int(limits.textBytes, `${where}.limits.textBytes`),
      // The largest file and the workspace's file bytes (rich contract 2.1), from a server with files.
      ...(limits.fileBytes === undefined ? {} : { fileBytes: int(limits.fileBytes, `${where}.limits.fileBytes`) }),
      ...(limits.filesBytes === undefined ? {} : { filesBytes: int(limits.filesBytes, `${where}.limits.filesBytes`) })
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
  return { member: id(v.member, MEMBER_ID, `${where}.member`), at: time(v.at, `${where}.at`) };
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
    createdAt: time(v.createdAt, `${where}.createdAt`),
    expiresAt: time(v.expiresAt, `${where}.expiresAt`)
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

// POST /conversations/{c}/read: { read }, and the grant's readMark on a server with Mark unread, which isn't needed:
// a higher readMark reaches the room through the feed.
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

// POST /conversations/{c}/messages/{m}/react: { messageId, emoji, on, changed } (rich contract 2.4).
function checkReact(v) {
  obj(v, 'react');
  return {
    messageId: id(v.messageId, EVENT_ID, 'react.messageId'),
    emoji: emojiText(v.emoji, 'react.emoji'),
    on: bool(v.on, 'react.on'),
    changed: v.changed === undefined ? true : bool(v.changed, 'react.changed')
  };
}

// POST /conversations/{c}/unread: { read, readMark } (rich contract 2.5).
function checkUnread(v) {
  obj(v, 'unread');
  return { read: int(v.read, 'unread.read'), readMark: int(v.readMark, 'unread.readMark') };
}

// POST /conversations/{c}/uploads: { upload: { id, expiresAt }, put: { url, expiresAt } } (rich contract 2.6).
function checkReserve(v) {
  obj(v, 'reserve');
  const upload = obj(v.upload, 'reserve.upload');
  const put = obj(v.put, 'reserve.put');
  return {
    upload: { id: id(upload.id, FILE_ID, 'reserve.upload.id'), expiresAt: time(upload.expiresAt, 'reserve.upload.expiresAt') },
    put: { url: webUrl(put.url, 'reserve.put.url'), expiresAt: time(put.expiresAt, 'reserve.put.expiresAt') }
  };
}

// PUT <put url>: { upload: { id, ready: true } }.
function checkUploaded(v) {
  obj(v, 'uploaded');
  const upload = obj(v.upload, 'uploaded.upload');
  if (upload.ready !== true) throw refused('uploaded.upload.ready');
  return { upload: { id: id(upload.id, FILE_ID, 'uploaded.upload.id'), ready: true } };
}

// POST /conversations/{c}/files/{f}/download: { url, expiresAt, name, type, size, sha256 }.
function checkDownload(v) {
  obj(v, 'download');
  return {
    url: webUrl(v.url, 'download.url'),
    expiresAt: time(v.expiresAt, 'download.expiresAt'),
    name: str(v.name, 'download.name', FILE_NAME * 2, 1),
    type: str(v.type, 'download.type', FILE_TYPE, 1),
    size: int(v.size, 'download.size', 1),
    sha256: id(v.sha256, SHA256, 'download.sha256')
  };
}

// POST /conversations/{c}/messages/{m}/previews: { previews }.
function checkPreviewsAnswer(v) {
  obj(v, 'previews');
  return { previews: checkLinkPreviews(v.previews, 'previews.previews') };
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

// trigger, depth and origin: an agent's reply, the message it answers, its depth and the person who started the chain
// (checkEvent).
const DATA_FIELDS = ['name', 'visibility', 'member', 'members', 'target', 'targetSeq', 'emoji', 'trigger', 'depth', 'origin'];

// A JSON list from a column, [] for NULL or anything that isn't one.
function jsonList(text) {
  const v = parseJson(text, []);
  return Array.isArray(v) ? v : [];
}

// A cached event row as the renderer's Event: mentions in UTF-8 bytes as the server sent them. A message that isn't
// removed carries its files, cards and reactions (rich contract 4.5); every other event carries [] for each.
function toRenderer(row) {
  const raw = parseJson(row.data, {});
  const data = {};
  for (const key of DATA_FIELDS) if (isObject(raw) && raw[key] !== undefined) data[key] = raw[key];
  const mentions = parseJson(row.mentions, []);
  const rich = row.kind === 'message.posted' && !row.redacted;
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
    data,
    attachments: rich ? jsonList(row.attachments) : [],
    previews: rich ? jsonList(row.previews) : [],
    reactions: rich ? jsonList(row.reactions) : []
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
    agents: row.agents ?? 0,
    head: row.head,
    floor: row.floor,
    lastAt: row.lastAt ?? null,
    read: row.readLocal,
    unread: row.unread,
    mentions: row.mentions,
    attention: muted ? 0 : dm ? row.unread : row.mentions,
    muted,
    hasCache: row.lo !== null && row.lo !== undefined,
    // Mark unread (rich contract 3.2): how often the person marked the room unread, and whether this device holds
    // back its reads of it until the room is opened again.
    readMark: row.readMark ?? 0,
    readingPaused: Boolean(row.readPaused)
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
    attachments: jsonList(row.attachments),
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

// A file's name as the server takes it (rich contract 2.6): 1 to 255 characters after trimming, no control
// characters, no / or \.
function fileName(v, field = 'name') {
  if (typeof v !== 'string' || v.length > FILE_NAME * 8) throw invalid(field);
  const trimmed = v.trim();
  if (!trimmed || !trimmed.isWellFormed() || Array.from(trimmed).length > FILE_NAME || /[\p{Cc}/\\]/u.test(trimmed)) throw invalid(field);
  return trimmed;
}

// A MIME type in lowercase, at most 127 characters, without parameters.
const MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;
function mimeType(v, field = 'type') {
  if (typeof v !== 'string' || v.length > FILE_TYPE || !MIME.test(v)) throw invalid(field);
  return v;
}

function sideOf(v, field) {
  if (v === undefined || v === null) return undefined;
  if (!Number.isSafeInteger(v) || v < 1 || v > IMAGE_SIDE) throw invalid(field);
  return v;
}

// A File object as the renderer hands it back in a draft: a ready file's ID and metadata, and when its upload
// expires unsent.
function fileObject(v, field = 'attachments') {
  plain(v, field);
  const out = { id: pattern(FILE_ID, field)(v.id), name: fileName(v.name, field), type: mimeType(v.type, field) };
  if (!Number.isSafeInteger(v.size) || v.size < 1) throw invalid(field);
  out.size = v.size;
  const width = sideOf(v.width, field);
  const height = sideOf(v.height, field);
  if (width !== undefined) out.width = width;
  if (height !== undefined) out.height = height;
  if (v.expiresAt !== undefined && v.expiresAt !== null) {
    if (!Number.isSafeInteger(v.expiresAt) || v.expiresAt < 0 || v.expiresAt > TIME_MAX) throw invalid(field);
    out.expiresAt = v.expiresAt;
  }
  return out;
}

function fileObjects(v, field = 'attachments') {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > ATTACHMENTS_MAX) throw invalid(field);
  const out = v.map((f) => fileObject(f, field));
  if (new Set(out.map((f) => f.id)).size !== out.length) throw invalid(field);
  return out;
}

function fileIds(v, field = 'attachments') {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > ATTACHMENTS_MAX) throw invalid(field);
  const out = v.map(pattern(FILE_ID, field));
  if (new Set(out).size !== out.length) throw invalid(field);
  return out;
}

// The people an agent answers besides its sponsor: at most 50 member IDs, each once.
function agentMembers(v) {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > AGENT_CHOSEN) throw invalid('members');
  const out = v.map(pattern(MEMBER_ID, 'members'));
  if (new Set(out).size !== out.length) throw invalid('members');
  return out;
}

// The longest path chatStage takes: Windows' extended paths go to 32,767 characters.
const PATH_LENGTH = 32767;

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
  // at most 32 mentions in its UTF-8 bytes, and a thread root or null. attachments: the IDs of 0 to 10 ready files
  // (rich contract 3.5); with at least one the text may be empty.
  send(v) {
    plain(v, 'input');
    const attachments = fileIds(v.attachments);
    const text = textOf(v.text, { maxBytes: TEXT_BYTES, allowEmpty: attachments.length > 0 });
    return { text, mentions: checkMentions(text, v.mentions), root: input.root(v.root), attachments };
  },
  // A draft: its text, mentions and the ready files it keeps (rich contract 3.5).
  draft(v) {
    if (v === null || v === undefined) return null;
    plain(v, 'draft');
    const text = textOf(v.text, { maxBytes: DRAFT_BYTES, allowEmpty: true });
    return { text, mentions: checkMentions(text, v.mentions, { max: DRAFT_MENTIONS }), attachments: fileObjects(v.attachments) };
  },
  file: pattern(FILE_ID, 'file'),
  stage: pattern(LOCAL_ID, 'stage'),
  // A reaction's emoji: one fully qualified RGI emoji of at most 64 bytes (rich contract 2.4).
  emoji(v) {
    if (typeof v !== 'string' || !v.isWellFormed() || utf8Length(v) > EMOJI_BYTES || !RGI_EMOJI.test(v)) throw invalid('emoji');
    return v;
  },
  // What chatStage attaches: { path } of a file chatPickFiles answered with, or { name, type, bytes } of one dropped
  // or pasted, which the sandboxed renderer sends as bytes. type may be '' or absent; files.js works it out.
  stageSource(v) {
    plain(v, 'source');
    if (v.path !== undefined) {
      if (typeof v.path !== 'string' || !v.path || v.path.length > PATH_LENGTH || !v.path.isWellFormed() || v.path.includes('\0')) throw invalid('path');
      return { path: v.path };
    }
    if (!(v.bytes instanceof Uint8Array)) throw invalid('bytes');
    const type = v.type === undefined || v.type === null || v.type === '' ? null : mimeType(String(v.type).toLowerCase().split(';')[0].trim());
    return { name: fileName(v.name), type, bytes: v.bytes };
  },
  fileAction: (v) => oneOfInput(v, ['view', 'open', 'save'], 'action'),
  previewUrl(v) {
    if (typeof v !== 'string' || v.length > URL_LENGTH || !/^https?:\/\/\S+$/i.test(v)) throw invalid('url');
    return v;
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
  // A new agent (server/WORKSPACES.md "Agents"): its name, whom it answers, the people it answers besides its sponsor
  // when that is 'members', and whether it answers other agents (off unless given).
  newAgent(v) {
    plain(v, 'input');
    const answers = oneOfInput(v.answers, AGENT_ANSWERS, 'answers');
    return {
      name: name(v.name, 'name'),
      answers,
      members: answers === 'members' ? agentMembers(v.members) : [],
      agents: v.agents === undefined || v.agents === null ? false : input.bool(v.agents, 'agents')
    };
  },
  // What changes of an agent: only the fields given, each checked as for newAgent.
  agentPatch(v) {
    plain(v, 'input');
    const out = {};
    if (v.name !== undefined && v.name !== null) out.name = name(v.name, 'name');
    if (v.answers !== undefined && v.answers !== null) out.answers = oneOfInput(v.answers, AGENT_ANSWERS, 'answers');
    if (v.members !== undefined && v.members !== null) out.members = agentMembers(v.members);
    if (v.agents !== undefined && v.agents !== null) out.agents = input.bool(v.agents, 'agents');
    if (!Object.keys(out).length) throw invalid('input');
    return out;
  },
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
  chatRetryInfo: () => [],
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
  chatDraft: (w, conv, root) => [ws(w), c(conv), input.root(root)],
  chatSend: (w, conv, x) => [ws(w), c(conv), input.send(x)],
  chatResend: (local, opts) => [input.local(local), input.resendOptions(opts)],
  chatDiscard: (local) => [input.local(local)],
  chatRedact: (w, conv, message) => [ws(w), c(conv), input.message(message)],
  chatCreateWorkspace: (x) => [input.newWorkspace(x)],
  chatPreviewInvite: (link) => [input.link(link)],
  chatJoin: (x) => [input.join(x)],
  chatTakePendingJoin: () => [],
  chatDropPendingJoin: () => [],
  chatCheckLink: (link) => [input.link(link)],
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
  chatUnblock: (w, member) => [ws(w), input.member(member)],
  // Agents in channels (server/WORKSPACES.md "Agents"). Adding one to a channel and taking it out are
  // chatAddToChannel and chatRemoveFromChannel.
  chatAgents: (w) => [ws(w)],
  chatCreateAgent: (w, x) => [ws(w), input.newAgent(x)],
  chatUpdateAgent: (w, agent, x) => [ws(w), pattern(MEMBER_ID, 'agent')(agent), input.agentPatch(x)],
  chatNewAgentKey: (w, agent) => [ws(w), pattern(MEMBER_ID, 'agent')(agent)],
  chatRemoveAgent: (w, agent) => [ws(w), pattern(MEMBER_ID, 'agent')(agent)],
  // Rich messages (rich contract 4.3).
  chatReact: (w, conv, message, emoji, on) => [ws(w), c(conv), input.message(message), input.emoji(emoji), input.bool(on, 'on')],
  chatMarkUnread: (w, conv, message) => [ws(w), c(conv), input.message(message)],
  chatPickFiles: () => [],
  chatStage: (w, conv, root, source) => [ws(w), c(conv), input.root(root), input.stageSource(source)],
  chatUnstage: (stage) => [input.stage(stage)],
  chatRetryStage: (stage) => [input.stage(stage)],
  chatStaged: (w, conv, root) => [ws(w), c(conv), input.root(root)],
  chatFile: (w, conv, file, action) => [ws(w), c(conv), input.file(file), input.fileAction(action)],
  chatRemovePreview: (w, conv, message, url) => [ws(w), c(conv), input.message(message), input.previewUrl(url)]
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
  homeOf,
  sameServers,
  inviteServer,
  splitInvite,
  SAME_SERVERS,
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
  checkAgents,
  checkAgentAnswer,
  checkTicket,
  checkFile,
  checkLinkPreview,
  checkReact,
  checkUnread,
  checkReserve,
  checkUploaded,
  checkDownload,
  checkPreviewsAnswer,
  toRenderer,
  toRoom,
  toPending,
  jsonList,
  input,
  ARGS,
  checkArgs,
  patterns: { WORKSPACE_ID, CONVERSATION_ID, MEMBER_ID, EVENT_ID, GRANT_ID, INVITE_ID, FILE_ID, LOCAL_ID, SECRET, GENERATION, CURSOR, UUID_V7, SHA256, RGI_EMOJI, MIME, AGENT_KEY },
  AGENT_ANSWERS,
  limits: {
    AGENT_CHOSEN,
    NAME_LENGTH,
    TEXT_BYTES,
    MENTIONS_MAX,
    DRAFT_BYTES,
    DRAFT_MENTIONS,
    LINK_LENGTH,
    INVITE_CHANNELS,
    INVITE_EXPIRY,
    DM_OTHERS,
    BADGE_CAP,
    ATTACHMENTS_MAX,
    PREVIEWS_MAX,
    REACTIONS_MAX,
    EMOJI_BYTES,
    FILE_NAME,
    FILE_TYPE
  }
};
