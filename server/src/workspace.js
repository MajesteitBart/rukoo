// One Durable Object per workspace, holding all of a team's chat in its own SQLite database: who belongs to it, its
// channels, who may read which channel, every message, each person's read position and the feed devices sync from.
// WORKSPACES.md is the contract; its "Gate 1 routes" section lists what this object answers today.
//
// Unlike an account's records, none of this is encrypted to the people who use it: whoever runs the server can read
// and change a workspace (WORKSPACES.md, the privacy promise). Personal sync keeps its own encryption and never comes
// through here.
//
// The Worker checks the shape of every input and calls request() with the caller's session token. This object sheds
// load first, from token buckets in memory, then asks the caller's Account object who the session is, and only then
// reads or writes. Every change runs in one synchronous transaction that checks the caller's rights again, so a
// removal and a send can never pass each other. Devices are woken after the transaction has committed, with a frame
// that says nothing: a device learns what changed from GET /changes, under its own access.
//
// A message can carry files, reactions and link cards (WORKSPACES.md, Rich messages). The files' bytes live in the
// file store, the WORKSPACE_FILES bucket or an S3-compatible one (filestore.js), and never pass through this object:
// the Worker streams them (files.js) and makes link cards (previews.js). This object keeps what they are, who may have
// them, and every key it ever handed out in the store's bucket, until the key is deleted from the bucket again.

import { DurableObject } from 'cloudflare:workers';
import { blob, fromBase64url, hmac, randomBytes, sameBytes, sha256, toBase64url, utf8 } from './bytes.js';
import { accountObject, filesOn, workspaceLimits } from './config.js';
import { fileStore } from './filestore.js';

const DAY = 24 * 60 * 60 * 1000;
// An operation id older than this is refused even when its retry receipt is gone; one further ahead than the second
// number can't come from a device that asked this server for the time (WORKSPACES.md, Messaging and sync).
const OPERATION_AGE = 30 * DAY;
const OPERATION_AHEAD = 5 * 60 * 1000;
// How long after a message was posted its operation id is still remembered when retention has removed the message
// itself: as long as a retry of that id can still be let in.
const RECEIPT_TIME = OPERATION_AGE + DAY;
// Former members a full member's directory lists, newest first, next to everyone who is active.
const FORMER_MEMBERS = 1000;
// A socket stays authorized this long after its session last passed a real sign-in check.
const SOCKET_LEASE = 15 * 60 * 1000;
const TICKET_TIME = 30 * 1000;
// A device woken less than this long ago gets its next wake at the end of the window, so a busy channel costs each
// device at most two fetches a second.
const WAKE_WINDOW = 500;
const INVITE_TIME = DAY;
const INVITE_TIME_MAX = 7 * DAY;
const PENDING_INVITES = 100;
// Redacted message ids one room carries in a /changes answer before it says there were more.
const REMOVED_IDS = 64;
const BADGE_CAP = 100;
const INLINE_EVENTS = 20;
// How long the feed remembers evictions and redactions for devices that were away. An older cursor starts over.
const FEED_DAYS = 14;
const SWEEP_BATCH = 2000;
const PROTOCOL = 'rukoo.workspace.v1';
// Direct messages: how many DMs one member starts in a rolling day. A DM holds 2 to 8 people, which the Worker checks.
const DM_DAILY = 20;
// Different emoji one message holds.
const REACTIONS = 20;
// Files: uploads one member holds open (reserved, under way or ready, and not sent yet), how long a reservation lasts,
// how many attempts at one upload may be under way at once, and after how long an attempt that never reported back
// counts as dead.
const OPEN_UPLOADS = 20;
const UPLOAD_TIME = 60 * 60 * 1000;
const ATTEMPTS = 2;
const ATTEMPT_TIME = 2 * 60 * 60 * 1000;
// Keys deleted from the bucket in one go, at most: the most R2 takes at once. An S3 store takes fewer (its batch,
// filestore.js). How soon the alarm comes for new trash, and how long it waits after a delete failed.
const TRASH_BATCH = 1000;
const TRASH_SOON = 10 * 1000;
const TRASH_RETRY = 5 * 60 * 1000;
// Events that are no activity of their own: they never count as unread and don't move a room's lastAt. A removal
// turns the reaction events of its message into reaction.cleared in place, which stays as quiet.
const QUIET = new Set(['reaction.added', 'reaction.removed', 'reaction.cleared', 'message.previewed']);

const FULL = new Set(['owner', 'admin', 'member']);
const ADMIN = new Set(['owner', 'admin']);

// Conversations and members have small integer keys inside the database and random ids outside it: a message row
// names its channel and its author, and at 16 KiB of text or less the keys are a real share of what a workspace
// stores. Event and operation ids are 16 random bytes for the same reason. A conversation's key is never used again
// after the conversation is collected, because receipts outlive it.
//
// A direct message is a conversation too, of kind 'dm'. Its dmSet is the participants' member keys, ascending and
// joined with commas, and the partial unique index lets one set have one open DM. closedWhy says why a DM closed,
// next to its archivedAt. A block is one person's, and dm_start keeps a row per DM someone started, for the daily cap.
//
// The tables of rich messages, which a new workspace makes with the rest and an older one adds in #upgrade().
const RICH_TABLES = `
  CREATE TABLE IF NOT EXISTS reaction (
    conversation INTEGER NOT NULL,
    seq INTEGER NOT NULL,
    emoji TEXT NOT NULL,
    member INTEGER NOT NULL,
    ord INTEGER NOT NULL,
    PRIMARY KEY (conversation, seq, emoji, member)
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS upload (
    n INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    member INTEGER NOT NULL,
    conversation INTEGER NOT NULL,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    size INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    width INTEGER,
    height INTEGER,
    state TEXT NOT NULL,
    key TEXT,
    createdAt INTEGER NOT NULL,
    expiresAt INTEGER NOT NULL,
    seq INTEGER,
    pos INTEGER,
    preview INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS upload_open ON upload (member, expiresAt) WHERE seq IS NULL;
  CREATE INDEX IF NOT EXISTS upload_expiry ON upload (expiresAt) WHERE seq IS NULL;
  CREATE INDEX IF NOT EXISTS upload_message ON upload (conversation, seq);
  CREATE TABLE IF NOT EXISTS attempt (
    key TEXT PRIMARY KEY,
    upload INTEGER,
    size INTEGER NOT NULL,
    charge INTEGER NOT NULL,
    at INTEGER NOT NULL
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS attempt_upload ON attempt (upload);
  CREATE INDEX IF NOT EXISTS attempt_at ON attempt (at);
  CREATE TABLE IF NOT EXISTS trash (
    key TEXT PRIMARY KEY,
    size INTEGER NOT NULL,
    at INTEGER NOT NULL
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS trash_at ON trash (at);
`;

// Rich messages: conversation.last is the sequence of the newest event that counts as activity (lastAt in the feed),
// and grants.readMark counts how often the member marked something unread there. A reaction row is one person's
// emoji on one message, ord the sequence of the reaction.added that made it, which orders who reacted. event.previews
// holds a message's link cards once they are made; noPreviews says its author took one away, so none come again.
// An upload is a file from reservation to the end of its message: reserved, uploading, ready, then bound to a message
// (seq, pos), or a link card's image (preview). attempt holds the bucket keys of writes under way, trash the keys
// waiting to be deleted from the bucket. workspace.fileBytes counts the bytes all of those stand for, apart from the
// message text bytes counts.
const SCHEMA = `
  CREATE TABLE workspace (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    wid TEXT NOT NULL,
    name TEXT NOT NULL,
    createdAt INTEGER NOT NULL,
    generation TEXT NOT NULL,
    rev INTEGER NOT NULL,
    feedFloor INTEGER NOT NULL,
    membersRev INTEGER NOT NULL,
    channelsRev INTEGER NOT NULL,
    bytes INTEGER NOT NULL,
    fileBytes INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE member (
    n INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    incarnation TEXT UNIQUE,
    account TEXT,
    ref INTEGER,
    role TEXT NOT NULL,
    state TEXT NOT NULL,
    name TEXT NOT NULL,
    joinedAt INTEGER NOT NULL,
    endedAt INTEGER,
    rev INTEGER NOT NULL DEFAULT 0,
    blocksRev INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS retired (incarnation TEXT PRIMARY KEY, at INTEGER NOT NULL);
  CREATE TABLE conversation (
    n INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL,
    visibility TEXT NOT NULL,
    name TEXT NOT NULL,
    createdBy INTEGER NOT NULL,
    createdAt INTEGER NOT NULL,
    archivedAt INTEGER,
    head INTEGER NOT NULL,
    floor INTEGER NOT NULL,
    rev INTEGER NOT NULL,
    roster INTEGER NOT NULL DEFAULT 0,
    dmSet TEXT,
    closedWhy TEXT,
    last INTEGER NOT NULL DEFAULT 0
  );
  CREATE UNIQUE INDEX conversation_dm_open ON conversation (dmSet) WHERE dmSet IS NOT NULL AND archivedAt IS NULL;
  CREATE TABLE block (
    blocker INTEGER NOT NULL,
    blocked INTEGER NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (blocker, blocked)
  ) WITHOUT ROWID;
  CREATE INDEX block_blocked ON block (blocked);
  CREATE TABLE dm_start (member INTEGER NOT NULL, at INTEGER NOT NULL);
  CREATE INDEX dm_start_member ON dm_start (member, at);
  CREATE TABLE grants (
    member INTEGER NOT NULL,
    conversation INTEGER NOT NULL,
    id TEXT NOT NULL,
    role TEXT NOT NULL,
    startSeq INTEGER NOT NULL,
    readSeq INTEGER NOT NULL,
    rev INTEGER NOT NULL,
    readMark INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (member, conversation)
  ) WITHOUT ROWID;
  CREATE INDEX grants_conversation ON grants (conversation);
  CREATE TABLE evicted (
    member INTEGER NOT NULL,
    conversation TEXT NOT NULL,
    rev INTEGER NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (member, conversation)
  ) WITHOUT ROWID;
  CREATE TABLE event (
    conversation INTEGER NOT NULL,
    seq INTEGER NOT NULL,
    id BLOB NOT NULL,
    kind TEXT NOT NULL,
    actor INTEGER NOT NULL,
    at INTEGER NOT NULL,
    root BLOB,
    text TEXT,
    data TEXT,
    size INTEGER NOT NULL DEFAULT 0,
    op BLOB,
    opHash BLOB,
    redactedAt INTEGER,
    previews TEXT,
    noPreviews INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (conversation, seq)
  ) WITHOUT ROWID;
  CREATE UNIQUE INDEX event_id ON event (id);
  CREATE UNIQUE INDEX event_op ON event (actor, op) WHERE op IS NOT NULL;
  CREATE INDEX event_at ON event (at);
${RICH_TABLES}
  CREATE TABLE receipt (
    actor INTEGER NOT NULL,
    op BLOB NOT NULL,
    conversation INTEGER NOT NULL,
    seq INTEGER NOT NULL,
    id BLOB NOT NULL,
    opHash BLOB NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (actor, op)
  ) WITHOUT ROWID;
  CREATE TABLE mention (
    member INTEGER NOT NULL,
    conversation INTEGER NOT NULL,
    seq INTEGER NOT NULL,
    PRIMARY KEY (member, conversation, seq)
  ) WITHOUT ROWID;
  CREATE TABLE removal (
    conversation INTEGER NOT NULL,
    rev INTEGER NOT NULL,
    id BLOB NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (conversation, rev)
  ) WITHOUT ROWID;
  CREATE TABLE invite (
    id TEXT PRIMARY KEY,
    hash BLOB NOT NULL UNIQUE,
    issuer INTEGER NOT NULL,
    role TEXT NOT NULL,
    channels TEXT NOT NULL,
    createdAt INTEGER NOT NULL,
    expiresAt INTEGER NOT NULL,
    redeemedBy INTEGER,
    redeemedAt INTEGER,
    revokedAt INTEGER
  );
  CREATE TABLE ticket (
    nonce TEXT PRIMARY KEY,
    member INTEGER NOT NULL,
    session TEXT NOT NULL,
    expiresAt INTEGER NOT NULL
  );
`;

// Which bucket an operation draws from. fetch and send are a person's ordinary reading and writing. control holds
// what takes access away, which must still go through while the workspace is busy, so it skips the workspace-wide
// ceiling. dm is starting a direct message: one every ten seconds, so a retry storm is shed before it costs a query.
// Numbers are tokens held at most, and tokens added per second.
const LANES = {
  fetch: { burst: 60, rate: 8 },
  send: { burst: 30, rate: 3 },
  dm: { burst: 10, rate: 0.1 },
  ticket: { burst: 6, rate: 0.2 },
  control: { burst: 60, rate: 5 }
};
const WORKSPACE_LANE = { burst: 600, rate: 300 };
// Everyone who isn't a member shares these: people redeeming an invitation, and anyone guessing.
const STRANGER_LANE = { burst: 30, rate: 2 };

const OPERATIONS = {
  'workspace.get': 'fetch',
  'members.list': 'fetch',
  'channels.list': 'fetch',
  'channel.members': 'fetch',
  'invites.list': 'fetch',
  events: 'fetch',
  changes: 'fetch',
  operation: 'fetch',
  'blocks.list': 'fetch',
  'file.download': 'fetch',
  post: 'send',
  read: 'send',
  react: 'send',
  unread: 'send',
  'upload.reserve': 'send',
  'upload.cancel': 'send',
  'previews.remove': 'send',
  join: 'send',
  'invite.preview': 'send',
  'invite.create': 'send',
  'member.rename': 'send',
  'channel.create': 'send',
  'channel.rename': 'send',
  'channel.join': 'send',
  'channel.admit': 'send',
  unblock: 'send',
  'dm.start': 'dm',
  ticket: 'ticket',
  'member.role': 'control',
  'channel.role': 'control',
  'member.remove': 'control',
  'invite.revoke': 'control',
  'channel.archive': 'control',
  'channel.remove': 'control',
  'dm.leave': 'control',
  block: 'control',
  redact: 'control',
  'workspace.delete': 'control'
};

// A refusal thrown inside a transaction: the transaction rolls back and the caller gets this answer.
class Refusal extends Error {
  constructor(status, error, message, extra = {}, headers) {
    super(message);
    this.reply = { status, body: { error, message, ...extra }, headers };
  }
}

function reply(status, body = null, headers) {
  return { status, body, headers };
}

// What someone outside a workspace gets, whether it exists or not.
const NO_WORKSPACE = () => new Refusal(404, 'not_found', 'There is no such workspace.', { scope: 'workspace' });
// The same for a channel the caller isn't in: a private channel must look like one that was never made.
const NO_CONVERSATION = () => new Refusal(404, 'not_found', 'There is no such conversation.', { scope: 'conversation' });
const FORBIDDEN = (message) => new Refusal(403, 'forbidden', message);
// One answer for every DM that can't be started for a reason the caller mustn't learn: a guest, someone who isn't an
// active member, or someone who blocked someone else in the set (WORKSPACES.md, Direct messages).
const DM_UNAVAILABLE = () =>
  new Refusal(403, 'dm_unavailable', "You can't start a conversation with these people.", { field: 'members' });
// Nothing new goes into an archived channel or a closed DM.
const ARCHIVED = (c) =>
  new Refusal(409, 'archived', c.kind === 'dm' ? 'This conversation is closed.' : 'This channel is archived.', { scope: 'conversation' });
const NO_MESSAGE = () => new Refusal(404, 'not_found', 'There is no message with this id here.');
const NO_FILE = () => new Refusal(404, 'not_found', 'There is no file with this id here.');
// An upload a PUT can't go to: sent with a message already, cancelled, expired or never made.
const INVALID_STATE = () => new Refusal(409, 'invalid_state', 'This upload was sent, cancelled or has expired. Attach the file again.');
const FILES_QUOTA = () =>
  new Refusal(413, 'quota', 'This workspace has no room for more files. Remove some first.', { scope: 'workspace', limit: 'files' });

function newId(prefix) {
  return `${prefix}_${toBase64url(randomBytes(16))}`;
}

function eventId(bytes) {
  return `e_${toBase64url(new Uint8Array(bytes))}`;
}

// The 16 bytes of an "e_…" id, or null.
function eventBytes(id) {
  const bytes = typeof id === 'string' && id.startsWith('e_') ? fromBase64url(id.slice(2)) : null;
  return bytes && bytes.length === 16 ? bytes : null;
}

function memberOut(row) {
  return { id: row.id, kind: 'human', name: row.name, role: row.role, state: row.state, joinedAt: row.joinedAt };
}

// A file as a message carries it. Width and height only for an image that gave them.
function fileOut(row) {
  const out = { id: row.id, name: row.name, type: row.type, size: row.size };
  if (row.width && row.height) Object.assign(out, { width: row.width, height: row.height });
  return out;
}

// A new bucket key, under the workspace's own prefix: a deleted workspace's leftovers can be found by it.
function fileKey(wid) {
  return `ws/${wid}/${toBase64url(randomBytes(16))}`;
}

class Bucket {
  constructor({ burst, rate }, now) {
    this.burst = burst;
    this.rate = rate;
    this.tokens = burst;
    this.at = now;
  }

  // Takes a token: 0 when there was one, else the seconds until there is.
  take(now) {
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.at) / 1000) * this.rate);
    this.at = now;
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return 0;
    }
    return Math.max(1, Math.ceil((1 - this.tokens) / this.rate));
  }
}

export class Workspace extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    // Tables are made when the workspace is: a request for an id nobody made leaves its object empty.
    this.present =
      this.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'workspace'").toArray().length > 0;
    // The workspace's id, kept in memory too: a join still waiting on its account when the workspace is deleted needs
    // it to give the account's reference back, and by then the database is empty.
    this.wid = this.present ? this.#ws().wid : null;
    if (this.present) this.#upgrade();
    // The accounts of the people in this workspace, so a request can be given its own bucket before any query runs.
    this.accounts = new Set();
    if (this.present) {
      for (const row of this.sql.exec("SELECT account FROM member WHERE state = 'active'")) this.accounts.add(row.account);
    }
    const now = Date.now();
    this.buckets = new Map();
    this.strangers = new Bucket(STRANGER_LANE, now);
    // A PUT carries no session, only its upload link: each upload gets a stranger's allowance of its own.
    this.uploadLanes = new Map();
    this.ceiling = new Bucket(WORKSPACE_LANE, now);
    // The earliest time a change asked the alarm to come by: for new trash, or for a reservation's expiry.
    this.alarmAt = null;
    // How many deletions of this workspace are deleting its files right now. No write to the bucket starts meanwhile.
    this.deleting = 0;
    this.lastWake = new Map();
    this.trailing = new Map();
    this.wakes = new Set();
    this.key = null;
    this.checking = new Set();
    // A device's keepalive is answered without waking this object, and renews nothing.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  // A workspace made by the first release of workspaces has no columns or tables for direct messages and blocks, and
  // one made before rich messages none for reactions, files and link cards. They are added before the object answers
  // anything. Each step can run again, so an object stopped halfway finishes the next time it starts, and one already
  // up to date only reads its table definitions.
  #upgrade() {
    const has = (table, column) => this.sql.exec(`PRAGMA table_info(${table})`).toArray().some((c) => c.name === column);
    if (!has('member', 'blocksRev')) this.sql.exec('ALTER TABLE member ADD COLUMN blocksRev INTEGER NOT NULL DEFAULT 0');
    if (!has('conversation', 'dmSet')) this.sql.exec('ALTER TABLE conversation ADD COLUMN dmSet TEXT');
    if (!has('conversation', 'closedWhy')) this.sql.exec('ALTER TABLE conversation ADD COLUMN closedWhy TEXT');
    // Every event of an older workspace counts as activity, so a room's newest is its head. The column and its values
    // come in one step, or a restart in between would leave every room with lastAt null.
    if (!has('conversation', 'last')) {
      this.ctx.storage.transactionSync(() => {
        this.sql.exec('ALTER TABLE conversation ADD COLUMN last INTEGER NOT NULL DEFAULT 0');
        this.sql.exec('UPDATE conversation SET last = head');
      });
    }
    if (!has('grants', 'readMark')) this.sql.exec('ALTER TABLE grants ADD COLUMN readMark INTEGER NOT NULL DEFAULT 0');
    if (!has('event', 'previews')) this.sql.exec('ALTER TABLE event ADD COLUMN previews TEXT');
    if (!has('event', 'noPreviews')) this.sql.exec('ALTER TABLE event ADD COLUMN noPreviews INTEGER NOT NULL DEFAULT 0');
    if (!has('workspace', 'fileBytes')) this.sql.exec('ALTER TABLE workspace ADD COLUMN fileBytes INTEGER NOT NULL DEFAULT 0');
    this.sql.exec(RICH_TABLES);
    this.sql.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS conversation_dm_open ON conversation (dmSet) WHERE dmSet IS NOT NULL AND archivedAt IS NULL;
      CREATE TABLE IF NOT EXISTS block (
        blocker INTEGER NOT NULL,
        blocked INTEGER NOT NULL,
        at INTEGER NOT NULL,
        PRIMARY KEY (blocker, blocked)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS block_blocked ON block (blocked);
      CREATE TABLE IF NOT EXISTS dm_start (member INTEGER NOT NULL, at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS dm_start_member ON dm_start (member, at);
    `);
  }

  // ---- Called by the Worker ----

  // Makes the workspace with its first owner and a first channel. who is what Account.principal() answered.
  async create(who, input) {
    if (this.present) return reply(409, { error: 'exists', message: 'This workspace already exists.' });
    // The maker's account may have been deleted between asking and now, and have told this object already (retire).
    if (this.#hasTable('retired') && this.sql.exec('SELECT 1 FROM retired WHERE incarnation = ?', who.incarnation).toArray().length > 0) {
      return reply(401, { error: 'unauthorized', message: 'Sign in again.', scope: 'account' });
    }
    const now = Date.now();
    let me;
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(SCHEMA);
      this.sql.exec(
        `INSERT INTO workspace (id, wid, name, createdAt, generation, rev, feedFloor, membersRev, channelsRev, bytes)
         VALUES (1, ?, ?, ?, ?, 0, 0, 0, 0, 0)`,
        input.id,
        input.name,
        now,
        toBase64url(randomBytes(16))
      );
      me = this.#addMember(who, 'owner', input.displayName, now);
      this.#newChannel(me, { name: 'general', visibility: 'workspace' }, now);
    });
    this.present = true;
    this.wid = input.id;
    this.accounts.add(who.name);
    await this.ctx.storage.setAlarm(now + DAY);
    return reply(201, { workspace: await this.#workspaceOut(), me: memberOut(me) });
  }

  // Every other route. token is the caller's session token, op one of OPERATIONS, args what the Worker checked.
  async request(token, op, args = {}) {
    const name = token.slice(0, token.indexOf('.'));
    const wait = this.#admit(name, op, Date.now());
    if (wait) {
      return reply(
        429,
        { error: 'rate_limited', message: 'Too many requests. Try again shortly.', scope: 'workspace' },
        { 'retry-after': String(wait) }
      );
    }
    const who = await accountObject(this.env, name).principal(token);
    if (who.status !== 200) return reply(who.status, { ...who.body, scope: 'account' });
    try {
      if (!this.present) throw NO_WORKSPACE();
      if (op === 'join') return await this.#join(token, who, args);
      if (op === 'invite.preview') return await this.#preview(args);
      const me = this.#actor(who);
      if (!me) throw NO_WORKSPACE();
      this.#renew(who.session);
      const result = await this.#dispatch(op, me, who, args);
      await this.#settle();
      return result;
    } catch (err) {
      if (err instanceof Refusal) return err.reply;
      throw err;
    }
  }

  // ---- Called by the Worker for files and link cards ----

  // A PUT to an upload link, before any byte is written: whether the upload takes one now, and the fresh bucket key
  // this attempt writes to, recorded here first so that no key the bucket holds is ever unknown. length is the PUT's
  // Content-Length. The answer's attempt is for the Worker: { key, size, type, name, sha256 }.
  async startAttempt(id, length) {
    const wait = this.#admitUpload(id, Date.now());
    if (wait) {
      return reply(429, { error: 'rate_limited', message: 'Too many requests. Try again shortly.', scope: 'workspace' }, { 'retry-after': String(wait) });
    }
    return this.#run(() => this.#write(() => this.#startAttempt(id, length, Date.now())));
  }

  // The end of a PUT: ok when the bucket took the bytes and their digest. The first attempt that ends well makes the
  // upload ready with its key; every other key goes to the trash. size is the attempt's, for a key this object had
  // already given up on. gone: true when the workspace was deleted meanwhile, and the Worker deletes the key itself.
  async finishAttempt(id, key, size, ok) {
    if (!this.present) return { status: 404, body: NO_WORKSPACE().reply.body, gone: true };
    return this.#run(() => this.#write(() => this.#finishAttempt(id, key, size, ok, Date.now())));
  }

  // A bucket key for the image of a link card on a message, recorded before the image is written, or null when the
  // workspace has no room for size more bytes or the message can't get cards.
  async previewKey(conversation, message, size) {
    if (!this.present || !filesOn(this.env)) return null;
    const key = await this.#run(() => this.#write(() => this.#previewKey(conversation, message, size, Date.now())));
    return typeof key === 'string' ? key : null;
  }

  // The link cards the Worker made for a message, published once: stored on the message and announced with a
  // message.previewed event. A message removed meanwhile, or whose author took cards away, gets none, and the images
  // go to the trash, as do the keys in discard, images whose write failed. gone: true when the workspace was deleted.
  async publishPreviews(conversation, message, previews, discard = []) {
    if (!this.present) return { published: false, gone: true };
    return this.#run(() => this.#write(() => this.#publishPreviews(conversation, message, previews, discard, Date.now())));
  }

  // Whether this workspace was made. The Worker and the registry ask when an answer to making it got lost.
  async exists() {
    return this.present;
  }

  // Whether an invitation secret can still be used, for a sign-up that offers it in place of an invite code. false
  // when the workspace isn't there, or the invitation is unknown, used, withdrawn or expired, or its issuer can no
  // longer invite (#usable).
  async inviteOpen(secret) {
    if (!this.present || typeof secret !== 'string') return false;
    try {
      this.#usable(await sha256(utf8(secret)), Date.now());
      return this.present;
    } catch (err) {
      if (err instanceof Refusal) return false;
      throw err;
    }
  }

  // What an account incarnation is here, for GET /v1/workspaces: an active member with what the list shows, a
  // former member, or nobody this workspace knows.
  async membership(incarnation) {
    if (!this.present) return { state: 'none' };
    const member = this.sql.exec('SELECT role, state FROM member WHERE incarnation = ?', incarnation).toArray()[0];
    if (!member) return { state: 'none' };
    if (member.state !== 'active') return { state: 'former' };
    const ws = this.#ws();
    return { state: 'active', id: ws.wid, name: ws.name, role: member.role };
  }

  // An account was deleted (Account, #cleanup): its membership ends, its name goes, and nothing still on its way in
  // under that incarnation can commit. What it wrote stays, under a deleted member, until retention removes it.
  async retire(incarnation) {
    const now = Date.now();
    if (!this.present) {
      // Only an account that recorded a reference to this id asks, so this is a workspace on its way to being made.
      // The note stops create() from making it for an account that is already gone.
      this.sql.exec('CREATE TABLE IF NOT EXISTS retired (incarnation TEXT PRIMARY KEY, at INTEGER NOT NULL)');
      this.sql.exec('INSERT OR IGNORE INTO retired (incarnation, at) VALUES (?, ?)', incarnation, now);
      return true;
    }
    const gone = this.#write(() => {
      this.sql.exec('INSERT OR IGNORE INTO retired (incarnation, at) VALUES (?, ?)', incarnation, now);
      const member = this.sql.exec('SELECT * FROM member WHERE incarnation = ?', incarnation).toArray()[0];
      if (!member) return null;
      if (member.state === 'active') this.#endMembership(member, member, now);
      this.sql.exec(
        `UPDATE member SET state = 'deleted', incarnation = NULL, account = NULL, ref = NULL, name = '',
           endedAt = COALESCE(endedAt, ?) WHERE n = ?`,
        now,
        member.n
      );
      // Nothing of the account's blocks is kept, in either direction. Whoever had blocked it loads their list again.
      for (const row of this.sql.exec('DELETE FROM block WHERE blocked = ? RETURNING blocker', member.n).toArray()) {
        this.#blocksChanged(row.blocker);
      }
      this.sql.exec('DELETE FROM block WHERE blocker = ?', member.n);
      this.#memberChanged(member);
      return member;
    });
    if (gone) this.#forget(gone);
    // A DM that closed with the account before anyone wrote in it is deleted, with any upload that waited for it.
    await this.#settle();
    return true;
  }

  // The socket a device waits on. The Worker has checked the ticket's signature and passes its nonce; the ticket
  // itself was issued here, to one session, and works once.
  async fetch(request) {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return new Response(null, { status: 426 });
    // A workspace deleted after it issued the ticket: the Worker answers its 404.
    if (!this.present) return new Response(null, { status: 404 });
    const now = Date.now();
    const nonce = request.headers.get('x-ticket') || '';
    const active = (n) => this.sql.exec("SELECT incarnation, account FROM member WHERE n = ? AND state = 'active'", n).toArray()[0];
    const asked = this.sql.exec('SELECT member, session, expiresAt FROM ticket WHERE nonce = ?', nonce).toArray()[0];
    const holder = asked && asked.expiresAt > now ? active(asked.member) : null;
    // A ticket that is being checked right now is in use: a second upgrade with it gets no check of its own.
    if (!holder || this.checking.has(nonce)) return new Response(null, { status: 401 });
    // The ticket's session may have been signed out since it asked. Only its account knows.
    this.checking.add(nonce);
    let alive;
    try {
      alive = await accountObject(this.env, holder.account).session(holder.incarnation, asked.session);
    } finally {
      this.checking.delete(nonce);
    }
    // The workspace may have been deleted while the account answered; its database is gone with it.
    if (!this.present) return new Response(null, { status: 404 });
    if (!alive) {
      this.sql.exec('DELETE FROM ticket WHERE nonce = ?', nonce);
      return new Response(null, { status: 401 });
    }
    // That waited, so the ticket is taken and the member checked again, in one step: a ticket opens one socket.
    const ticket = this.ctx.storage.transactionSync(() => {
      const row = this.sql.exec('DELETE FROM ticket WHERE nonce = ? RETURNING member, session, expiresAt', nonce).toArray()[0];
      return row && row.expiresAt > Date.now() && active(row.member) ? row : null;
    });
    if (!ticket) return new Response(null, { status: 401 });
    if (this.ctx.getWebSockets().length >= workspaceLimits(this.env).sockets) {
      return new Response(null, { status: 429, headers: { 'retry-after': '60' } });
    }
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], [`m:${ticket.member}`, `s:${ticket.session}`]);
    pair[1].serializeAttachment({ m: ticket.member, s: ticket.session, until: now + SOCKET_LEASE });
    const headers = request.headers.get('x-protocol') ? { 'sec-websocket-protocol': PROTOCOL } : {};
    return new Response(null, { status: 101, webSocket: pair[0], headers });
  }

  // Devices have nothing to say on this socket; a frame is answered with silence.
  async webSocketMessage() {}

  async webSocketClose(ws, code) {
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code);
    } catch {
      // Already closed.
    }
  }

  async webSocketError(ws) {
    try {
      ws.close(1011);
    } catch {
      // Already closed.
    }
  }

  // At least once a day: what retention removes, what the feed no longer needs to remember, spent tickets and
  // invitations, and uploads that expired unsent. Then the trash is deleted from the bucket. The alarm comes sooner
  // when there is trash, when an upload is about to expire, or when a sweep left more for later.
  async alarm() {
    if (!this.present) return;
    const now = Date.now();
    const limits = workspaceLimits(this.env);
    let more = false;
    try {
      more = this.#write(() => {
        this.sql.exec('DELETE FROM ticket WHERE expiresAt <= ?', now);
        this.sql.exec('DELETE FROM invite WHERE expiresAt <= ?', now - 30 * DAY);
        this.sql.exec('DELETE FROM retired WHERE at <= ?', now - 30 * DAY);
        this.sql.exec('DELETE FROM receipt WHERE at <= ?', now - RECEIPT_TIME);
        this.sql.exec('DELETE FROM dm_start WHERE at <= ?', now - DAY);
        this.#trimFeed(now - FEED_DAYS * DAY);
        const files = this.#expireUploads(now);
        return this.#expire(now - limits.retentionDays * DAY, now) || files;
      });
    } catch (err) {
      // A sweep that fails is tried again tomorrow. Without the next alarm, retention would stop for good.
      console.error('A workspace could not run its daily sweep:', err?.stack || err);
    }
    let failed = false;
    try {
      more = (await this.#emptyTrash()) || more;
    } catch (err) {
      failed = true;
      console.error('A workspace could not delete files from its bucket:', err?.message || err);
    }
    this.alarmAt = null;
    if (this.present) await this.ctx.storage.setAlarm(this.#nextAlarm(now, more, failed));
  }

  // ---- Load shedding and sockets ----

  // 0 to let a request in, else the seconds to wait. No query and no call to another object happens before this.
  // The caller's own allowance comes first, so a caller who is over theirs takes nothing from what everyone shares.
  #admit(name, op, now) {
    const lane = OPERATIONS[op] ?? 'send';
    let wait;
    if (!this.accounts.has(name)) wait = this.strangers.take(now);
    else {
      let mine = this.buckets.get(name);
      if (!mine) {
        mine = {};
        this.buckets.set(name, mine);
      }
      mine[lane] ??= new Bucket(LANES[lane], now);
      wait = mine[lane].take(now);
    }
    if (wait || lane === 'control') return wait;
    return this.ceiling.take(now);
  }

  // A request that passed a real sign-in check keeps that session's sockets authorized. Written only when a good
  // part of the lease is gone, so an active device doesn't rewrite its socket on every request.
  #renew(session) {
    const now = Date.now();
    for (const ws of this.ctx.getWebSockets(`s:${session}`)) {
      const state = ws.deserializeAttachment();
      if (state && state.until - now < SOCKET_LEASE / 2) ws.serializeAttachment({ ...state, until: now + SOCKET_LEASE });
    }
  }

  // Runs a change in one transaction. A Refusal thrown inside rolls it back. The devices it concerns are woken once
  // it has committed.
  #write(fn) {
    this.wakes = new Set();
    // A request that was waiting when the workspace was deleted finds nothing to write to.
    const result = this.ctx.storage.transactionSync(() => {
      if (!this.present) throw NO_WORKSPACE();
      return fn();
    });
    const wakes = this.wakes;
    this.wakes = new Set();
    this.#wake(wakes);
    return result;
  }

  // Runs one of the Worker's own calls: a Refusal becomes its answer, and an alarm a change asked for is set.
  async #run(fn) {
    try {
      const result = await fn();
      await this.#settle();
      return result;
    } catch (err) {
      if (err instanceof Refusal) return err.reply;
      throw err;
    }
  }

  // Asks the alarm to come by at: for trash, or a reservation that expires then. A transaction can't wait on the
  // alarm, so the time is kept until #settle() sets it. A change that rolled back may have asked too, which costs an
  // early alarm and nothing else.
  #alarmBy(at) {
    this.alarmAt = this.alarmAt === null ? at : Math.min(this.alarmAt, at);
  }

  async #settle() {
    const at = this.alarmAt;
    this.alarmAt = null;
    if (at === null || !this.present) return;
    const set = await this.ctx.storage.getAlarm();
    if (set === null || set > at) await this.ctx.storage.setAlarm(at);
  }

  // A PUT's allowance: per upload, as a stranger's, and then the workspace's ceiling.
  #admitUpload(id, now) {
    let bucket = this.uploadLanes.get(id);
    if (!bucket) {
      // Old entries go first. An upload that comes back after this gets a full allowance, which a PUT every half
      // second at most can't turn into a flood.
      if (this.uploadLanes.size >= 1000) this.uploadLanes.delete(this.uploadLanes.keys().next().value);
      bucket = new Bucket(STRANGER_LANE, now);
      this.uploadLanes.set(id, bucket);
    }
    return bucket.take(now) || this.ceiling.take(now);
  }

  #wake(members) {
    const now = Date.now();
    for (const n of members) {
      const since = now - (this.lastWake.get(n) ?? 0);
      if (since >= WAKE_WINDOW) this.#send(n, now);
      else if (!this.trailing.has(n)) {
        this.trailing.set(
          n,
          setTimeout(() => {
            this.trailing.delete(n);
            this.#send(n, Date.now());
          }, WAKE_WINDOW - since)
        );
      }
    }
  }

  // The frame names no workspace, no channel and no count. A socket whose lease ran out is closed instead: its
  // session hasn't proved itself for 15 minutes.
  #send(n, now) {
    this.lastWake.set(n, now);
    for (const ws of this.ctx.getWebSockets(`m:${n}`)) {
      try {
        const state = ws.deserializeAttachment();
        if (!state || state.until <= now) ws.close(4001, 'lease');
        else ws.send('{"t":"wake"}');
      } catch {
        // The socket is gone; the device catches up from its cursor.
      }
    }
  }

  // Someone left or was removed: their sockets go, and their bucket too, unless the same account is an active member
  // again under a newer incarnation.
  #forget(member) {
    const again = member.account && this.sql.exec("SELECT 1 FROM member WHERE account = ? AND state = 'active'", member.account).toArray().length > 0;
    if (member.account && !again) {
      this.accounts.delete(member.account);
      this.buckets.delete(member.account);
    }
    for (const ws of this.ctx.getWebSockets(`m:${member.n}`)) {
      try {
        ws.close(4003, 'removed');
      } catch {
        // Already closed.
      }
    }
  }

  // ---- Small reads ----

  #ws() {
    return this.sql.exec('SELECT * FROM workspace WHERE id = 1').one();
  }

  // The next feed revision. Every row the feed pages over gets a revision of its own, so two entries never tie.
  #rev() {
    return this.sql.exec('UPDATE workspace SET rev = rev + 1 WHERE id = 1 RETURNING rev').one().rev;
  }

  // A member's name, role or standing changed. Full members load the directory again. So do the people who share a
  // room with the member, which is how a guest hears of it, and hears of nothing else.
  #memberChanged(member) {
    const rev = this.#rev();
    this.sql.exec('UPDATE member SET rev = ? WHERE n = ?', rev, member.n);
    this.sql.exec('UPDATE workspace SET membersRev = ? WHERE id = 1', rev);
    this.#wakeFull();
    for (const row of this.sql.exec(
      'SELECT DISTINCT member FROM grants WHERE conversation IN (SELECT conversation FROM grants WHERE member = ?)',
      member.n
    )) {
      this.wakes.add(row.member);
    }
    this.wakes.add(member.n);
  }

  #hasTable(name) {
    return this.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", name).toArray().length > 0;
  }

  #channelsChanged() {
    this.sql.exec('UPDATE workspace SET channelsRev = ? WHERE id = 1', this.#rev());
    this.#wakeFull();
  }

  #wakeFull() {
    for (const row of this.sql.exec("SELECT n FROM member WHERE state = 'active' AND role != 'guest'")) this.wakes.add(row.n);
  }

  #wakeRoom(c) {
    for (const row of this.sql.exec('SELECT member FROM grants WHERE conversation = ?', c.n)) this.wakes.add(row.member);
  }

  // The active member an account incarnation is here, or undefined.
  #actor(who) {
    return this.sql.exec("SELECT * FROM member WHERE incarnation = ? AND state = 'active'", who.incarnation).toArray()[0];
  }

  #member(id) {
    return this.sql.exec("SELECT * FROM member WHERE id = ? AND state = 'active'", id).toArray()[0];
  }

  #conversation(id) {
    return this.sql.exec('SELECT * FROM conversation WHERE id = ?', id).toArray()[0];
  }

  #grant(member, c) {
    return this.sql.exec('SELECT * FROM grants WHERE member = ? AND conversation = ?', member.n, c.n).toArray()[0];
  }

  // The conversation and the caller's grant in it, or the same 404 for a missing one and one they aren't in.
  #room(me, id) {
    const c = this.#conversation(id);
    const grant = c && this.#grant(me, c);
    if (!grant) throw NO_CONVERSATION();
    return { c, grant };
  }

  // The same for the channel routes, to which a DM is a conversation that doesn't exist.
  #channel(me, id) {
    const room = this.#room(me, id);
    if (room.c.kind !== 'channel') throw NO_CONVERSATION();
    return room;
  }

  // A member's own list of blocks changed: their devices load it again (directory.blocks in the feed).
  #blocksChanged(n) {
    this.sql.exec('UPDATE member SET blocksRev = ? WHERE n = ?', this.#rev(), n);
    this.wakes.add(n);
  }

  #owners() {
    return this.sql.exec("SELECT COUNT(*) AS n FROM member WHERE state = 'active' AND role = 'owner'").one().n;
  }

  async #cursorKey() {
    if (!this.key) {
      // From the host's secret, not from this database: a database that is lost or rolled back keeps its key, so a
      // device's cursor from before still opens and can show that the workspace went backwards.
      const raw = await hmac(this.env.PEPPER, `workspace-cursor\n${this.#ws().wid}`);
      this.key = {
        key: await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']),
        id: toBase64url((await sha256(utf8(`workspace-key-id\n${toBase64url(raw)}`))).slice(0, 8))
      };
    }
    return this.key;
  }

  // A cursor is sealed so a device can't read the workspace's revision counter from it, which counts what happens in
  // channels it isn't in.
  async #seal(value) {
    const { key } = await this.#cursorKey();
    const nonce = randomBytes(12);
    const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, utf8(JSON.stringify(value))));
    const out = new Uint8Array(13 + sealed.length);
    out[0] = 1;
    out.set(nonce, 1);
    out.set(sealed, 13);
    return toBase64url(out);
  }

  async #open(text) {
    const bytes = fromBase64url(text);
    if (!bytes || bytes.length < 30 || bytes[0] !== 1) return null;
    try {
      const { key } = await this.#cursorKey();
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(1, 13) }, key, bytes.slice(13));
      const value = JSON.parse(new TextDecoder().decode(plain));
      if (!Array.isArray(value) || value.length !== 4) return null;
      const cursor = { member: value[0], generation: value[1], at: Number(value[2]), base: Number(value[3]) };
      return Number.isSafeInteger(cursor.at) && Number.isSafeInteger(cursor.base) ? cursor : null;
    } catch {
      return null;
    }
  }

  // A cursor for a member: where the scan is (at), and the revision through which a finished pass had brought the
  // device (base). Both are written at a fixed width, so a cursor's length says nothing about either.
  #cursor(me, generation, at, base) {
    const fixed = (n) => String(n).padStart(16, '0');
    return this.#seal([me.id, generation, fixed(at), fixed(base)]);
  }

  async #workspaceOut() {
    const ws = this.#ws();
    const limits = workspaceLimits(this.env);
    return {
      id: ws.wid,
      name: ws.name,
      createdAt: ws.createdAt,
      generation: ws.generation,
      keyId: (await this.#cursorKey()).id,
      time: Date.now(),
      limits: {
        members: limits.members,
        conversations: limits.conversations,
        textBytes: limits.textBytes,
        fileBytes: limits.fileBytes,
        filesBytes: limits.filesBytes
      },
      retention: { contentDays: limits.retentionDays, feedDays: FEED_DAYS }
    };
  }

  // ---- Dispatch ----

  // A Worker of an older build may still call this object during a deploy, without the fields that came later: no
  // attachments on a post, no readMark on a read and no version on events and the feed.
  async #dispatch(op, me, who, a) {
    switch (op) {
      case 'workspace.get':
        return reply(200, { workspace: await this.#workspaceOut(), me: memberOut(me) });
      case 'members.list':
        return this.#members(me);
      case 'member.rename':
        return this.#write(() => this.#rename(me, a.name));
      case 'member.role':
        return this.#write(() => this.#setRole(me, a.member, a.role));
      case 'member.remove':
        return this.#removeMember(me, a.member);
      case 'invites.list':
        return this.#invites(me);
      case 'invite.create':
        return this.#invite(me, a);
      case 'invite.revoke':
        return this.#write(() => this.#revoke(me, a.invite));
      case 'channels.list':
        return this.#channels(me);
      case 'channel.create':
        return this.#write(() => this.#createChannel(me, a));
      case 'channel.rename':
        return this.#write(() => this.#renameChannel(me, a.conversation, a.name));
      case 'channel.archive':
        return this.#write(() => this.#archive(me, a.conversation));
      case 'channel.join':
        return this.#write(() => this.#joinChannel(me, a.conversation));
      case 'channel.members':
        return this.#channelMembers(me, a.conversation);
      case 'channel.admit':
        return this.#write(() => this.#admitToChannel(me, a.conversation, a.member));
      case 'channel.role':
        return this.#write(() => this.#channelRole(me, a.conversation, a.member, a.role));
      case 'channel.remove':
        return this.#write(() => this.#leaveChannel(me, a.conversation, a.member, a.successor));
      case 'dm.start':
        return this.#write(() => this.#startDm(me, a.members));
      case 'dm.leave':
        return this.#write(() => this.#leaveDm(me, a.conversation));
      case 'blocks.list':
        return this.#blocks(me);
      case 'block':
        return this.#write(() => this.#block(me, a.member));
      case 'unblock':
        return this.#write(() => this.#unblock(me, a.member));
      case 'post':
        return this.#post(me, { ...a, attachments: a.attachments ?? [] });
      case 'redact':
        return this.#write(() => this.#redact(me, a.conversation, a.message));
      case 'read':
        return this.#write(() => this.#read(me, a.conversation, a.seq, a.readMark ?? null));
      case 'unread':
        return this.#write(() => this.#unread(me, a.conversation, a.message));
      case 'react':
        return this.#write(() => this.#react(me, a.conversation, a.message, a.emoji, a.on));
      case 'upload.reserve':
        return this.#write(() => this.#reserve(me, a));
      case 'upload.cancel':
        return this.#write(() => this.#cancelUpload(me, a.conversation, a.upload));
      case 'file.download':
        return this.#download(me, a.conversation, a.file);
      case 'previews.remove':
        return this.#write(() => this.#removePreview(me, a.conversation, a.message, a.remove));
      case 'events':
        return this.#events(me, { ...a, version: a.version ?? 1 });
      case 'operation':
        return this.#operation(me, a.conversation, a.op);
      case 'changes':
        return this.#changes(me, { ...a, version: a.version ?? 1 });
      case 'ticket':
        return this.#ticket(me, who.session);
      case 'workspace.delete':
        return this.#deleteWorkspace(me, who);
    }
    throw new Refusal(404, 'not_found', 'There is nothing here.');
  }

  // ---- Members and invitations ----

  // Adds an account as a member, or brings back the row of someone who was here before under the same incarnation, so
  // what they wrote earlier stays theirs.
  // who.ref is the version of the account's reference to this workspace, kept so that ending the membership later
  // marks that reference and no newer one.
  #addMember(who, role, name, now) {
    const old = this.sql.exec('SELECT n FROM member WHERE incarnation = ?', who.incarnation).toArray()[0];
    if (old) {
      this.sql.exec(
        `UPDATE member SET state = 'active', role = ?, name = ?, account = ?, ref = ?, joinedAt = ?, endedAt = NULL
         WHERE n = ?`,
        role,
        name,
        who.name,
        who.ref ?? null,
        now,
        old.n
      );
    } else {
      this.sql.exec(
        "INSERT INTO member (id, incarnation, account, ref, role, state, name, joinedAt) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)",
        newId('u'),
        who.incarnation,
        who.name,
        who.ref ?? null,
        role,
        name,
        now
      );
    }
    const member = this.#actor(who);
    this.#memberChanged(member);
    return member;
  }

  // Full members see everyone who is active, and the most recent of those who left, so old messages keep their
  // author's name. A guest sees the people in the channels they were let into.
  #members(me) {
    if (!FULL.has(me.role)) {
      const rows = this.sql
        .exec(
          `SELECT * FROM member WHERE state = 'active' AND (n = ? OR n IN (
             SELECT member FROM grants WHERE conversation IN (SELECT conversation FROM grants WHERE member = ?)
           )) ORDER BY n`,
          me.n,
          me.n
        )
        .toArray();
      return reply(200, { members: rows.map(memberOut), more: false });
    }
    const active = this.sql.exec("SELECT * FROM member WHERE state = 'active'").toArray();
    const former = this.sql
      .exec("SELECT * FROM member WHERE state != 'active' ORDER BY endedAt DESC, n DESC LIMIT ?", FORMER_MEMBERS + 1)
      .toArray();
    const rows = [...active, ...former.slice(0, FORMER_MEMBERS)].sort((a, b) => a.n - b.n);
    return reply(200, { members: rows.map(memberOut), more: former.length > FORMER_MEMBERS });
  }

  #rename(me, name) {
    this.sql.exec('UPDATE member SET name = ? WHERE n = ?', name, me.n);
    this.#memberChanged(me);
    return reply(200, { me: memberOut({ ...me, name }) });
  }

  // Owners appoint owners and change anyone. Admins move people between member and guest. Whether the caller may do
  // this at all is settled before the member is looked up, so the answer says nothing about ids they can't see. A
  // guest is in no DM, so someone who becomes one leaves every open DM closed behind them.
  #setRole(me, id, role) {
    if (!ADMIN.has(me.role)) throw FORBIDDEN('Your role in this workspace does not allow this change.');
    const target = this.#member(id);
    if (!target) throw new Refusal(404, 'not_found', 'There is no member with this id.');
    const allowed =
      me.role === 'owner' || (me.role === 'admin' && !ADMIN.has(target.role) && (role === 'member' || role === 'guest'));
    if (!allowed) throw FORBIDDEN('Your role in this workspace does not allow this change.');
    if (target.role === 'owner' && role !== 'owner' && this.#owners() <= 1) {
      throw new Refusal(409, 'last_owner', 'A workspace needs an owner. Appoint another one first.');
    }
    this.sql.exec('UPDATE member SET role = ? WHERE n = ?', role, target.n);
    if (role === 'guest' && target.role !== 'guest') {
      const now = Date.now();
      for (const c of this.#openDms(target.n)) this.#closeDm(c, 'ineligible', now);
    }
    this.#memberChanged(target);
    return reply(200, { member: memberOut({ ...target, role }) });
  }

  // Leaving, or being removed. Every grant ends with it. The account keeps its reference to this workspace, marked as
  // one it left, so the workspace still hears if the account is deleted and can take the name off what it wrote.
  async #removeMember(me, id) {
    const now = Date.now();
    const gone = this.#write(() => {
      const self = id === 'me' || id === me.id;
      if (!self && !ADMIN.has(me.role)) throw FORBIDDEN('Your role in this workspace does not allow removing this member.');
      const target = this.#member(self ? me.id : id);
      if (!target) throw new Refusal(404, 'not_found', 'There is no member with this id.');
      if (!self && me.role === 'admin' && ADMIN.has(target.role)) {
        throw FORBIDDEN('Your role in this workspace does not allow removing this member.');
      }
      if (target.role === 'owner' && this.#owners() <= 1) {
        throw new Refusal(409, 'last_owner', 'A workspace needs an owner. Appoint another one first.');
      }
      if (self) {
        // Leaving a workspace is leaving each of its channels, and a channel's only manager hands it over first.
        // Being removed is different: nobody waits for a removed member to appoint anyone.
        const mine = this.sql
          .exec(
            `SELECT c.id FROM grants g JOIN conversation c ON c.n = g.conversation
             WHERE g.member = ? AND g.role = 'manager' AND c.archivedAt IS NULL
               AND (SELECT COUNT(*) FROM grants WHERE conversation = c.n AND role = 'manager') = 1
               AND (SELECT COUNT(*) FROM grants WHERE conversation = c.n) > 1
             ORDER BY c.n`,
            target.n
          )
          .toArray();
        if (mine.length > 0) {
          throw new Refusal(409, 'last_manager', 'You are the only manager of channels other people are in. Appoint a manager in each first.', {
            channels: mine.map((row) => row.id)
          });
        }
      }
      this.#endMembership(target, me, now);
      this.sql.exec('UPDATE member SET state = ?, endedAt = ? WHERE n = ?', self ? 'left' : 'removed', now, target.n);
      this.#memberChanged(target);
      return target;
    });
    this.#forget(gone);
    try {
      await accountObject(this.env, gone.account).leftWorkspace(gone.incarnation, this.#ws().wid, gone.ref);
    } catch (err) {
      // The account's list still shows the workspace until it next asks, and then learns that it left.
      console.error('Could not mark a workspace reference as left:', err?.message || err);
    }
    return reply(204);
  }

  // Ends every grant a member holds and withdraws the invitations they issued.
  #endMembership(member, by, now) {
    const rooms = this.sql
      .exec('SELECT c.* FROM grants g JOIN conversation c ON c.n = g.conversation WHERE g.member = ?', member.n)
      .toArray();
    for (const c of rooms) this.#endGrant(member, c, by, now);
    this.sql.exec('UPDATE invite SET revokedAt = ? WHERE issuer = ? AND redeemedAt IS NULL AND revokedAt IS NULL', now, member.n);
    this.sql.exec('DELETE FROM ticket WHERE member = ?', member.n);
    this.wakes.add(member.n);
  }

  #invites(me) {
    if (!ADMIN.has(me.role)) throw FORBIDDEN('Only owners and admins see invitations.');
    const now = Date.now();
    const rows = this.sql
      .exec(
        `SELECT i.*, m.id AS issuerId FROM invite i JOIN member m ON m.n = i.issuer
         WHERE i.redeemedAt IS NULL AND i.revokedAt IS NULL AND i.expiresAt > ? ORDER BY i.createdAt`,
        now
      )
      .toArray();
    // An admin who isn't in a private channel learns that an invitation leads into one, not which.
    const out = rows.map((row) => {
      const issuer = this.sql.exec("SELECT * FROM member WHERE n = ? AND state = 'active'", row.issuer).toArray()[0];
      const rooms = this.#leadsInto(row, issuer);
      const mine = rooms.filter((c) => c.visibility === 'workspace' || this.#grant(me, c));
      return inviteOut(row, mine.map((c) => c.id), rooms.length);
    });
    return reply(200, { invites: out });
  }

  // An invitation is a secret that works once. Only its hash is stored. The channels it names are ones its issuer
  // manages, and for a guest the issuer is also the admin who signs off on the admission.
  async #invite(me, a) {
    const secret = toBase64url(randomBytes(32));
    const hash = await sha256(utf8(secret));
    const now = Date.now();
    const invite = this.#write(() => {
      const issuer = this.#member(me.id);
      if (!issuer || !ADMIN.has(issuer.role)) throw FORBIDDEN('Only owners and admins invite people.');
      const pending = this.sql
        .exec('SELECT COUNT(*) AS n FROM invite WHERE redeemedAt IS NULL AND revokedAt IS NULL AND expiresAt > ?', now)
        .one().n;
      if (pending >= PENDING_INVITES) {
        throw new Refusal(413, 'quota', 'This workspace has too many open invitations. Revoke some first.', {
          scope: 'workspace',
          limit: 'invites'
        });
      }
      // Each channel is kept with the grant the issuer manages it under. An issuer who loses that grant and gets
      // another later has to invite again.
      const channels = [];
      for (const id of a.channels) {
        const c = this.#conversation(id);
        const grant = c && c.kind === 'channel' && this.#grant(issuer, c);
        if (!grant) throw NO_CONVERSATION();
        if (grant.role !== 'manager') throw FORBIDDEN('You can only invite into channels you manage.');
        channels.push({ c: id, g: grant.id });
      }
      const row = {
        id: newId('i'),
        issuerId: issuer.id,
        role: a.role,
        channels: JSON.stringify(channels),
        createdAt: now,
        expiresAt: now + Math.min(a.expiresIn ? a.expiresIn * 1000 : INVITE_TIME, INVITE_TIME_MAX)
      };
      this.sql.exec(
        'INSERT INTO invite (id, hash, issuer, role, channels, createdAt, expiresAt) VALUES (?, ?, ?, ?, ?, ?, ?)',
        row.id,
        blob(hash),
        issuer.n,
        row.role,
        row.channels,
        row.createdAt,
        row.expiresAt
      );
      return { row, ids: this.#leadsInto(row, issuer).map((c) => c.id) };
    });
    return reply(201, { invite: inviteOut(invite.row, invite.ids, invite.ids.length), secret });
  }

  #revoke(me, id) {
    const invite = this.sql.exec('SELECT * FROM invite WHERE id = ?', id).toArray()[0];
    if (!invite || !(ADMIN.has(me.role) || invite.issuer === me.n)) {
      throw new Refusal(404, 'not_found', 'There is no invitation with this id.');
    }
    if (!invite.revokedAt && !invite.redeemedAt) this.sql.exec('UPDATE invite SET revokedAt = ? WHERE id = ?', Date.now(), id);
    return reply(204);
  }

  // The invitation a secret belongs to, with its issuer, when it can still be used. Throws what a caller should see:
  // an unknown secret looks like a workspace that doesn't exist, a spent one says so. An invitation whose issuer left
  // or lost the role to invite is spent too.
  #usable(hash, now) {
    const GONE = () => new Refusal(410, 'invite_gone', 'This invitation was used, withdrawn or has expired. Ask for a new one.');
    const invite = this.sql.exec('SELECT * FROM invite WHERE hash = ?', blob(hash)).toArray()[0];
    if (!invite) throw NO_WORKSPACE();
    if (invite.redeemedAt || invite.revokedAt || invite.expiresAt <= now) throw GONE();
    const issuer = this.sql.exec("SELECT * FROM member WHERE n = ? AND state = 'active'", invite.issuer).toArray()[0];
    if (!issuer || !ADMIN.has(issuer.role)) throw GONE();
    return { invite, issuer };
  }

  // What an invitation is for, shown before someone joins.
  async #preview(a) {
    const hash = await sha256(utf8(a.invite));
    const { invite, issuer } = this.#usable(hash, Date.now());
    const ws = this.#ws();
    return reply(200, {
      workspace: { id: ws.wid, name: ws.name },
      role: invite.role,
      channels: this.#leadsInto(invite, issuer).length,
      issuer: { name: issuer.name },
      expiresAt: invite.expiresAt
    });
  }

  // Redeems an invitation. The account records its reference to this workspace before the membership exists, so an
  // account deleted a moment later still tells this workspace. Then everything is checked again in the transaction
  // that makes the member.
  async #join(token, who, a) {
    if (who.class !== 'full') {
      throw new Refusal(403, 'workspace_account_scope', 'This account cannot join workspaces on this server.');
    }
    const hash = await sha256(utf8(a.invite));
    const already = this.#actor(who);
    if (already) return reply(200, { workspace: await this.#workspaceOut(), me: memberOut(already) });
    this.#usable(hash, Date.now());
    const most = workspaceLimits(this.env).memberships;
    const ref = await accountObject(this.env, who.name).addWorkspace(token, this.wid, { most });
    if (ref.status !== 200) return reply(ref.status, { ...ref.body, scope: ref.status === 401 ? 'account' : undefined });
    who = { ...who, ref: ref.ref };
    // The workspace was deleted while the account recorded its reference: the reference goes back, and the join finds
    // what anyone finds at a workspace that isn't there.
    if (!this.present) {
      await this.#giveBack(who);
      throw NO_WORKSPACE();
    }
    if (ref.incarnation !== who.incarnation) throw new Refusal(401, 'unauthorized', 'Sign in again.', { scope: 'account' });
    const now = Date.now();
    let joined;
    try {
      joined = this.#redeem(who, hash, a, now);
    } catch (err) {
      // Refused after the account recorded its reference: the reference is settled now, so it doesn't count against
      // how many workspaces the account may be in.
      if (err instanceof Refusal) await this.#giveBack(who);
      throw err;
    }
    this.accounts.add(who.name);
    return reply(joined.made ? 201 : 200, { workspace: await this.#workspaceOut(), me: memberOut(joined.member) });
  }

  // The reference of a join that was refused. Someone who was a member before keeps it as a workspace they left, so
  // their name can still be taken off it later. Anyone else gets it back, and so does everyone once the workspace is
  // deleted.
  async #giveBack(who) {
    const known = this.present && this.sql.exec('SELECT 1 FROM member WHERE incarnation = ?', who.incarnation).toArray().length > 0;
    const account = accountObject(this.env, who.name);
    try {
      if (known) await account.leftWorkspace(who.incarnation, this.wid, who.ref);
      else await account.dropWorkspace(who.incarnation, this.wid, who.ref);
    } catch (err) {
      console.error('Could not settle a workspace reference after a refused join:', err?.message || err);
    }
  }

  // The channels an invitation names that still hold: the ones its issuer still manages under the grant they had
  // when they invited, and that aren't archived. Joining grants these; #leadsInto adds the default channel.
  #invited(invite, issuer) {
    const rooms = [];
    for (const { c: id, g } of JSON.parse(invite.channels)) {
      const c = this.#conversation(id);
      const grant = c && !c.archivedAt && issuer ? this.#grant(issuer, c) : null;
      if (grant?.role === 'manager' && grant.id === g) rooms.push(c);
    }
    return rooms;
  }

  // The workspace's default channel: its oldest open channel that everyone can see, normally general. A member
  // invitation leads into it as well as into the channels it names.
  #defaultChannel() {
    return this.sql
      .exec("SELECT * FROM conversation WHERE kind = 'channel' AND visibility = 'workspace' AND archivedAt IS NULL ORDER BY n LIMIT 1")
      .toArray()[0];
  }

  // Every channel a person joining with this invitation would be in right now: the invited ones and, for a member,
  // the default channel. The preview and the list of invitations count these, so they match what joining does.
  #leadsInto(invite, issuer) {
    const rooms = this.#invited(invite, issuer);
    const first = invite.role === 'member' ? this.#defaultChannel() : null;
    if (first && !rooms.some((c) => c.id === first.id)) rooms.push(first);
    return rooms;
  }

  // The transaction that makes a member of someone holding an invitation: { member, made }, where made is false for
  // someone who turned out to be a member already.
  #redeem(who, hash, a, now) {
    return this.#write(() => {
      if (this.sql.exec('SELECT 1 FROM retired WHERE incarnation = ?', who.incarnation).toArray().length > 0) {
        throw new Refusal(401, 'unauthorized', 'Sign in again.', { scope: 'account' });
      }
      const again = this.#actor(who);
      if (again) {
        // Two joins of one account at once: both recorded a reference and the account kept the later one. The member
        // keeps that one too, whichever join got here first.
        this.sql.exec('UPDATE member SET ref = MAX(COALESCE(ref, 0), ?) WHERE n = ?', who.ref, again.n);
        return { member: again, made: false };
      }
      const { invite, issuer } = this.#usable(hash, now);
      const members = this.sql.exec("SELECT COUNT(*) AS n FROM member WHERE state = 'active'").one().n;
      if (members >= workspaceLimits(this.env).members) {
        throw new Refusal(413, 'quota', 'This workspace is full.', { scope: 'workspace', limit: 'members' });
      }
      const member = this.#addMember(who, invite.role, a.name, now);
      this.sql.exec('UPDATE invite SET redeemedBy = ?, redeemedAt = ? WHERE id = ?', member.n, now, invite.id);
      // A channel the issuer stopped managing since, or that was archived, is left out; the rest still holds.
      for (const c of this.#invited(invite, issuer)) this.#grantTo(member, c, 'member', issuer, now);
      // A member also gets the workspace's default channel, its oldest open one that everyone can see (normally
      // general), so nobody joins a team and finds themselves in no room. They let themselves in, as with a join of
      // their own. A guest gets only what the invitation names.
      if (invite.role === 'member') {
        const first = this.#defaultChannel();
        if (first && !this.#grant(member, first)) this.#grantTo(member, first, 'member', member, now);
      }
      return { member, made: true };
    });
  }

  // ---- Deleting the workspace ----

  // An owner who is the workspace's only member deletes it. Every file leaves the bucket first, while the workspace
  // stays as it is; a bucket that fails answers 503 and the owner tries again, so no file outlives the database that
  // knows it. Only then one transaction checks again and withdraws the open invitations, the sockets close and the
  // database goes. The answer carries the caller's account reference, which the Worker gives back, as #ticket's answer
  // carries a ticket for the Worker to sign.
  async #deleteWorkspace(me, who) {
    const check = () => {
      const self = this.#member(me.id);
      if (!self || self.role !== 'owner') throw FORBIDDEN('Only an owner deletes a workspace.');
      const others = this.sql.exec("SELECT COUNT(*) AS n FROM member WHERE state = 'active' AND n != ?", self.n).one().n;
      if (others > 0) throw new Refusal(409, 'members_remain', 'Remove everyone else first.');
      // A write under way could land after the bucket was listed: an upload's attempt, also one that lost to another
      // or whose upload went, and a link card's image.
      const writing = this.sql.exec('SELECT 1 FROM attempt WHERE at > ? LIMIT 1', Date.now() - ATTEMPT_TIME).toArray().length;
      if (writing) throw new Refusal(503, 'unavailable', 'A file is being uploaded. Try again shortly.', {}, { 'retry-after': '30' });
      return self;
    };
    this.#write(check);
    // This object takes other requests while it waits on the bucket. None starts a write there (#startAttempt,
    // #previewKey): it could land after the listing went past its key and outlive the database.
    this.deleting += 1;
    let owner;
    try {
      try {
        await this.#forgetFiles(this.wid);
      } catch (err) {
        console.error('Could not delete the files of a workspace, which stays:', err?.message || err);
        return reply(503, { error: 'unavailable', message: 'The workspace could not be deleted. Try again shortly.' }, { 'retry-after': '30' });
      }
      const now = Date.now();
      owner = this.#write(() => {
        const self = check();
        this.sql.exec('UPDATE invite SET revokedAt = ? WHERE redeemedAt IS NULL AND revokedAt IS NULL', now);
        return self;
      });
      // From here every request, and every join still waiting on its account, finds no workspace.
      this.present = false;
    } finally {
      this.deleting -= 1;
    }
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(4003, 'deleted');
      } catch {
        // Already closed.
      }
    }
    for (const timer of this.trailing.values()) clearTimeout(timer);
    this.trailing.clear();
    this.accounts.clear();
    this.buckets.clear();
    this.key = null;
    this.alarmAt = null;
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    return { status: 204, body: null, account: who.name, incarnation: who.incarnation, ref: owner.ref };
  }

  // Every object under the workspace's prefix leaves the bucket, a page of up to 1,000 at a time (fewer from an S3
  // store). Every key this workspace makes is under it (fileKey). A failure throws. So does a server without a file
  // store, such as one whose S3 settings lost a secret, while the workspace still knows keys in the bucket: those
  // objects would outlive the database that knows them.
  async #forgetFiles(wid) {
    if (!wid) return;
    const store = fileStore(this.env);
    if (!store) {
      const known = this.sql.exec('SELECT 1 FROM upload WHERE key IS NOT NULL UNION ALL SELECT 1 FROM attempt UNION ALL SELECT 1 FROM trash LIMIT 1');
      if (known.toArray().length) throw new Error('The workspace has files, and the server has no file store to delete them from.');
      return;
    }
    const limit = Math.min(TRASH_BATCH, store.batch);
    let cursor = null;
    do {
      const page = await store.list({ prefix: `ws/${wid}/`, cursor, limit });
      if (page.keys.length) await store.delete(page.keys);
      cursor = page.cursor;
    } while (cursor);
  }

  // ---- Channels ----

  // A channel and a DM each take one of the workspace's conversation slots, until retention collects them or a DM that
  // closed before anyone wrote in it is deleted.
  #roomForAnother() {
    const count = this.sql.exec('SELECT COUNT(*) AS n FROM conversation').one().n;
    if (count >= workspaceLimits(this.env).conversations) {
      throw new Refusal(413, 'quota', 'This workspace has no room for another conversation.', { scope: 'workspace', limit: 'conversations' });
    }
  }

  #newChannel(me, { name, visibility }, now) {
    this.#roomForAnother();
    // Names are unique among the channels everyone can see. A private channel's name is never compared, or the
    // refusal would tell an outsider that it exists.
    if (visibility === 'workspace' && this.#nameTaken(name, null)) {
      throw new Refusal(409, 'name_taken', 'There is already a channel with this name.');
    }
    const id = newId('c');
    this.sql.exec(
      `INSERT INTO conversation (id, kind, visibility, name, createdBy, createdAt, head, floor, rev)
       VALUES (?, 'channel', ?, ?, ?, ?, 0, 1, ?)`,
      id,
      visibility,
      name,
      me.n,
      now,
      this.#rev()
    );
    const c = this.#conversation(id);
    this.#append(c, 'channel.created', me, now, { data: { name, visibility } });
    this.#grantTo(me, c, 'manager', me, now);
    if (visibility === 'workspace') this.#channelsChanged();
    return c;
  }

  #nameTaken(name, except) {
    return (
      this.sql
        .exec(
          "SELECT 1 FROM conversation WHERE visibility = 'workspace' AND archivedAt IS NULL AND name = ? COLLATE NOCASE AND n IS NOT ?",
          name,
          except
        )
        .toArray().length > 0
    );
  }

  #createChannel(me, a) {
    if (!FULL.has(me.role)) throw FORBIDDEN('Guests cannot create channels.');
    const c = this.#newChannel(me, a, Date.now());
    return reply(201, { channel: this.#channelOut(me, c) });
  }

  // The directory: every channel the caller is in, and for full members every channel the workspace can see. DMs are
  // never in it: the feed is where a member finds their own.
  #channels(me) {
    const rows = this.sql
      .exec(
        `SELECT c.*, g.role AS grantRole, (SELECT COUNT(*) FROM grants WHERE conversation = c.n) AS members
         FROM conversation c LEFT JOIN grants g ON g.conversation = c.n AND g.member = ?
         WHERE c.kind = 'channel' AND (g.member IS NOT NULL OR (? AND c.visibility = 'workspace' AND c.archivedAt IS NULL))
         ORDER BY c.name COLLATE NOCASE, c.n`,
        me.n,
        FULL.has(me.role) ? 1 : 0
      )
      .toArray();
    return reply(200, { channels: rows.map(channelRow) });
  }

  #channelOut(me, c) {
    const fresh = this.#conversation(c.id);
    const grant = this.#grant(me, fresh);
    const members = this.sql.exec('SELECT COUNT(*) AS n FROM grants WHERE conversation = ?', fresh.n).one().n;
    return channelRow({ ...fresh, grantRole: grant?.role ?? null, members });
  }

  #renameChannel(me, id, name) {
    const { c, grant } = this.#channel(me, id);
    if (grant.role !== 'manager') throw FORBIDDEN('Only a channel manager renames it.');
    if (c.archivedAt) throw new Refusal(409, 'archived', 'This channel is archived.', { scope: 'conversation' });
    if (c.visibility === 'workspace' && this.#nameTaken(name, c.n)) {
      throw new Refusal(409, 'name_taken', 'There is already a channel with this name.');
    }
    if (name !== c.name) {
      this.sql.exec('UPDATE conversation SET name = ? WHERE n = ?', name, c.n);
      this.#append(c, 'channel.renamed', me, Date.now(), { data: { name } });
      this.#wakeRoom(c);
      if (c.visibility === 'workspace') this.#channelsChanged();
    }
    return reply(200, { channel: this.#channelOut(me, c) });
  }

  // A manager archives their channel; an admin archives one they can see. Posting stops for good, reading goes on
  // until retention has removed the history, and then the channel's slot is free again (#expire).
  #archive(me, id) {
    const c = this.#conversation(id);
    const grant = c && this.#grant(me, c);
    // A DM is no channel: without this, an admin in one could archive it here.
    const visible = c && c.kind === 'channel' && (grant || (FULL.has(me.role) && c.visibility === 'workspace'));
    if (!visible) throw NO_CONVERSATION();
    if (!(grant?.role === 'manager' || ADMIN.has(me.role))) throw FORBIDDEN('Only a channel manager or an admin archives it.');
    if (!c.archivedAt) this.#archiveChannel(c, me, Date.now());
    return reply(200, { channel: this.#channelOut(me, c) });
  }

  #archiveChannel(c, by, now) {
    this.sql.exec('UPDATE conversation SET archivedAt = ? WHERE n = ?', now, c.n);
    c.archivedAt = now;
    this.#append(c, 'channel.archived', by, now, {});
    this.#wakeRoom(c);
    if (c.visibility === 'workspace') this.#channelsChanged();
  }

  // A full member lets themselves into a channel the workspace can see. To a guest such a channel doesn't exist.
  #joinChannel(me, id) {
    const c = this.#conversation(id);
    if (!c || c.kind !== 'channel') throw NO_CONVERSATION();
    if (c.visibility !== 'workspace' || !FULL.has(me.role)) {
      if (this.#grant(me, c)) return reply(200, { channel: this.#channelOut(me, c) });
      throw NO_CONVERSATION();
    }
    if (!this.#grant(me, c)) {
      if (c.archivedAt) throw new Refusal(409, 'archived', 'This channel is archived.', { scope: 'conversation' });
      this.#grantTo(me, c, 'member', me, Date.now());
    }
    return reply(200, { channel: this.#channelOut(me, c) });
  }

  #channelMembers(me, id) {
    const c = this.#conversation(id);
    const visible = c && c.kind === 'channel' && (this.#grant(me, c) || (FULL.has(me.role) && c.visibility === 'workspace'));
    if (!visible) throw NO_CONVERSATION();
    const rows = this.sql
      .exec('SELECT m.id AS member, g.role FROM grants g JOIN member m ON m.n = g.member WHERE g.conversation = ? ORDER BY m.n', c.n)
      .toArray();
    return reply(200, { members: rows });
  }

  // A manager lets a member into their channel. For a guest the manager must also be an admin, who signs off on
  // letting someone from outside the team in. Two different people signing isn't built yet.
  #admitToChannel(me, id, memberId) {
    const { c, grant } = this.#channel(me, id);
    if (grant.role !== 'manager') throw FORBIDDEN('Only a channel manager adds people.');
    if (c.archivedAt) throw new Refusal(409, 'archived', 'This channel is archived.', { scope: 'conversation' });
    const target = this.#member(memberId);
    if (!target) throw new Refusal(404, 'not_found', 'There is no member with this id.');
    if (target.role === 'guest' && !ADMIN.has(me.role)) {
      throw new Refusal(403, 'cosign_required', 'Adding a guest to a channel needs a workspace admin.');
    }
    if (!this.#grant(target, c)) this.#grantTo(target, c, 'member', me, Date.now());
    return reply(200, { member: target.id, role: this.#grant(target, c).role });
  }

  #channelRole(me, id, memberId, role) {
    const { c, grant } = this.#channel(me, id);
    if (grant.role !== 'manager') throw FORBIDDEN('Only a channel manager changes roles.');
    const target = this.#member(memberId);
    const theirs = target && this.#grant(target, c);
    if (!theirs) throw new Refusal(404, 'not_found', 'There is no member with this id in the channel.');
    if (theirs.role === 'manager' && role !== 'manager' && this.#managers(c) <= 1) {
      throw new Refusal(409, 'last_manager', 'A channel needs a manager. Appoint another one first.');
    }
    if (theirs.role !== role) {
      this.sql.exec('UPDATE grants SET role = ?, rev = ? WHERE member = ? AND conversation = ?', role, this.#rev(), target.n, c.n);
      if (role !== 'manager') this.#uninvite(target, c);
      this.wakes.add(target.n);
    }
    return reply(200, { member: target.id, role });
  }

  // Takes a channel out of the open invitations a member issued into it, when they stop managing it. Managing it
  // again later doesn't bring it back.
  #uninvite(member, c) {
    const open = this.sql
      .exec('SELECT id, channels FROM invite WHERE issuer = ? AND redeemedAt IS NULL AND revokedAt IS NULL', member.n)
      .toArray();
    for (const row of open) {
      const all = JSON.parse(row.channels);
      const kept = all.filter((entry) => entry.c !== c.id);
      if (kept.length !== all.length) this.sql.exec('UPDATE invite SET channels = ? WHERE id = ?', JSON.stringify(kept), row.id);
    }
  }

  #managers(c) {
    return this.sql.exec("SELECT COUNT(*) AS n FROM grants WHERE conversation = ? AND role = 'manager'", c.n).one().n;
  }

  // Leaving a channel, or a manager taking someone out. A channel's last manager names who takes over before they
  // leave; the last person in a channel archives it by leaving.
  #leaveChannel(me, id, memberId, successorId) {
    const { c, grant } = this.#channel(me, id);
    const now = Date.now();
    const target = memberId === 'me' ? me : this.#member(memberId);
    const theirs = target && this.#grant(target, c);
    if (!theirs) throw new Refusal(404, 'not_found', 'There is no member with this id in the channel.');
    const self = target.n === me.n;
    if (!self && grant.role !== 'manager') throw FORBIDDEN('Only a channel manager removes people.');
    if (theirs.role === 'manager' && this.#managers(c) <= 1 && !c.archivedAt) {
      const others = this.sql.exec('SELECT COUNT(*) AS n FROM grants WHERE conversation = ?', c.n).one().n - 1;
      if (others === 0) this.#archiveChannel(c, me, now);
      else {
        const successor = self && successorId ? this.#member(successorId) : null;
        const next = successor && successor.n !== me.n && this.#grant(successor, c);
        if (!next) throw new Refusal(409, 'last_manager', 'A channel needs a manager. Name who takes over.');
        this.sql.exec("UPDATE grants SET role = 'manager', rev = ? WHERE member = ? AND conversation = ?", this.#rev(), successor.n, c.n);
      }
    }
    this.#endGrant(target, c, me, now);
    return reply(204);
  }

  // Lets a member into a conversation. The join is an event in the conversation's own order: its sequence is where the
  // grant starts, and where its read position starts. A DM's people all start at its dm.started event, given as seq,
  // so it opens with one marker instead of one per person.
  #grantTo(member, c, role, by, now, seq = null) {
    if (seq === null) seq = this.#append(c, 'member.joined', by, now, { data: { member: member.id } }).seq;
    this.sql.exec(
      'INSERT INTO grants (member, conversation, id, role, startSeq, readSeq, rev) VALUES (?, ?, ?, ?, ?, ?, ?)',
      member.n,
      c.n,
      newId('g'),
      role,
      seq,
      seq,
      this.#rev()
    );
    this.sql.exec('DELETE FROM evicted WHERE member = ? AND conversation = ?', member.n, c.id);
    this.sql.exec('UPDATE conversation SET roster = ? WHERE n = ?', this.#rev(), c.n);
    this.#wakeRoom(c);
  }

  // Ends a grant. The feed keeps an eviction for the member's devices, which is how they learn to drop the room.
  #endGrant(member, c, by, now) {
    this.sql.exec('DELETE FROM grants WHERE member = ? AND conversation = ?', member.n, c.n);
    this.sql.exec('DELETE FROM mention WHERE member = ? AND conversation = ?', member.n, c.n);
    this.#uninvite(member, c);
    this.#append(c, 'member.left', by, now, { data: { member: member.id } });
    this.sql.exec(
      'INSERT OR REPLACE INTO evicted (member, conversation, rev, at) VALUES (?, ?, ?, ?)',
      member.n,
      c.id,
      this.#rev(),
      now
    );
    this.sql.exec('UPDATE conversation SET roster = ? WHERE n = ?', this.#rev(), c.n);
    this.#wakeRoom(c);
    this.wakes.add(member.n);
    const left = this.sql.exec('SELECT COUNT(*) AS n FROM grants WHERE conversation = ?', c.n).one().n;
    // A DM's set is fixed: one person going closes it for the rest. A closed one that nobody holds any more goes.
    if (c.kind === 'dm') {
      if (!c.archivedAt) this.#closeDm(c, 'left', now);
      else if (left === 0) this.#dropDm(c, now);
      return;
    }
    // A channel nobody is in can't be reached by anyone, so it is archived, whichever way its last member went.
    // Retention then collects it and its place is free again.
    if (!c.archivedAt && left === 0) this.#archiveChannel(c, by, now);
  }

  // ---- Direct messages ----

  // The member keys of a DM's people, ascending and joined: what makes one set one DM.
  #dmSet(ns) {
    return [...ns].sort((a, b) => a - b).join(',');
  }

  // Starts a DM with the people named, or answers the open DM their set already has. The refusals come in a fixed
  // order, because the order is what keeps them from telling the caller more than their own blocks: everything a
  // caller mustn't tell apart gets one answer first, then the open DM, so a retry never meets a limit, then the
  // caller's own blocks, and only then the limits.
  #startDm(me, ids) {
    if (ids.includes(me.id)) throw new Refusal(400, 'invalid', 'members lists the other people, not you.', { field: 'members' });
    const rows = [me];
    for (const id of ids) {
      const member = this.#member(id);
      if (!member) throw DM_UNAVAILABLE();
      rows.push(member);
    }
    if (rows.some((row) => !FULL.has(row.role))) throw DM_UNAVAILABLE();
    rows.sort((a, b) => a.n - b.n);
    const set = this.#dmSet(rows.map((row) => row.n));
    const open = this.sql.exec('SELECT * FROM conversation WHERE dmSet = ? AND archivedAt IS NULL', set).toArray()[0];
    if (open) return reply(200, { dm: this.#roomOut(me, open.id, null) });

    const ns = rows.map((row) => row.n);
    const marks = ns.map(() => '?').join(', ');
    const blocks = this.sql.exec(`SELECT blocker, blocked FROM block WHERE blocker IN (${marks}) AND blocked IN (${marks})`, ...ns, ...ns).toArray();
    const mine = rows.find((row) => blocks.some((b) => b.blocker === me.n && b.blocked === row.n));
    if (mine) {
      throw new Refusal(409, 'blocked', 'You blocked someone in this conversation. Unblock them first.', { member: mine.id });
    }
    if (blocks.length > 0) throw DM_UNAVAILABLE();

    const now = Date.now();
    const started = this.sql
      .exec('SELECT COUNT(*) AS n, MIN(at) AS oldest FROM dm_start WHERE member = ? AND at > ?', me.n, now - DAY)
      .one();
    if (started.n >= DM_DAILY) {
      const wait = Math.max(1, Math.ceil((started.oldest + DAY - now) / 1000));
      throw new Refusal(429, 'rate_limited', 'You started many conversations today. Try again later.', { limit: 'dailyDms' }, { 'retry-after': String(wait) });
    }
    const c = this.#newDm(me, rows, now);
    return reply(201, { dm: this.#roomOut(me, c.id, null) });
  }

  // Opens a DM at once: the conversation, one dm.started event, and a grant for each person that starts there.
  #newDm(me, rows, now) {
    this.#roomForAnother();
    const id = newId('c');
    this.sql.exec(
      `INSERT INTO conversation (id, kind, visibility, name, createdBy, createdAt, head, floor, rev, dmSet)
       VALUES (?, 'dm', 'dm', '', ?, ?, 0, 1, ?, ?)`,
      id,
      me.n,
      now,
      this.#rev(),
      this.#dmSet(rows.map((row) => row.n))
    );
    const c = this.#conversation(id);
    const { seq } = this.#append(c, 'dm.started', me, now, { data: { members: rows.map((row) => row.id) } });
    for (const member of rows) this.#grantTo(member, c, 'member', me, now, seq);
    this.sql.exec('INSERT INTO dm_start (member, at) VALUES (?, ?)', me.n, now);
    return c;
  }

  // Closes a DM for good, saying why: left, ineligible or closed. Those who still hold it keep reading it. A DM nobody
  // wrote in, or that nobody holds any more, has nothing worth keeping and is deleted instead.
  #closeDm(c, why, now) {
    const fresh = this.#conversation(c.id);
    if (!fresh || fresh.archivedAt) return;
    const written = this.sql.exec("SELECT 1 FROM event WHERE conversation = ? AND kind = 'message.posted' LIMIT 1", fresh.n).toArray().length > 0;
    const held = this.sql.exec('SELECT COUNT(*) AS n FROM grants WHERE conversation = ?', fresh.n).one().n;
    if (!written || held === 0) {
      this.#dropDm(fresh, now);
    } else {
      this.sql.exec('UPDATE conversation SET archivedAt = ?, closedWhy = ?, rev = ? WHERE n = ?', now, why, this.#rev(), fresh.n);
      this.#wakeRoom(fresh);
    }
    c.archivedAt = now;
  }

  // Deletes a DM and everything in it. Whoever still held it gets an eviction, and its slot is free at once.
  #dropDm(c, now) {
    for (const row of this.sql.exec('SELECT member FROM grants WHERE conversation = ?', c.n).toArray()) {
      this.sql.exec('INSERT OR REPLACE INTO evicted (member, conversation, rev, at) VALUES (?, ?, ?, ?)', row.member, c.id, this.#rev(), now);
      this.wakes.add(row.member);
    }
    const bytes = this.sql.exec('SELECT COALESCE(SUM(size), 0) AS n FROM event WHERE conversation = ?', c.n).one().n;
    this.sql.exec('UPDATE workspace SET bytes = MAX(0, bytes - ?) WHERE id = 1', bytes);
    this.sql.exec('DELETE FROM grants WHERE conversation = ?', c.n);
    this.sql.exec('DELETE FROM mention WHERE conversation = ?', c.n);
    this.sql.exec('DELETE FROM removal WHERE conversation = ?', c.n);
    this.#dropRich('conversation = ?', c.n);
    this.sql.exec('DELETE FROM event WHERE conversation = ?', c.n);
    this.sql.exec('DELETE FROM conversation WHERE n = ?', c.n);
  }

  // The open DMs member n is in.
  #openDms(n) {
    return this.sql
      .exec(
        `SELECT c.* FROM grants g JOIN conversation c ON c.n = g.conversation
         WHERE g.member = ? AND c.kind = 'dm' AND c.archivedAt IS NULL ORDER BY c.n`,
        n
      )
      .toArray();
  }

  // Leaving a DM closes it for the others. Leaving one that is closed already only takes it off the caller's list.
  #leaveDm(me, id) {
    const { c } = this.#room(me, id);
    if (c.kind !== 'dm') throw NO_CONVERSATION();
    this.#endGrant(me, c, me, Date.now());
    return reply(204);
  }

  // ---- Blocks ----

  // The active member an id names, as the caller may see them: a full member sees everyone who is active, a guest the
  // people they share a room with. Anyone else is undefined, like an id nobody has.
  #visibleMember(me, id) {
    if (FULL.has(me.role)) return this.#member(id);
    return this.sql
      .exec(
        `SELECT * FROM member WHERE id = ? AND state = 'active' AND n IN (
           SELECT member FROM grants WHERE conversation IN (SELECT conversation FROM grants WHERE member = ?)
         )`,
        id,
        me.n
      )
      .toArray()[0];
  }

  // The caller's own blocks, newest first. Nobody else's list ever names them.
  #blocks(me) {
    const rows = this.sql
      .exec('SELECT m.id AS member, b.at FROM block b JOIN member m ON m.n = b.blocked WHERE b.blocker = ? ORDER BY b.at DESC, b.blocked DESC', me.n)
      .toArray();
    return reply(200, { blocks: rows.map((row) => ({ member: row.member, at: row.at })) });
  }

  // A block closes every open DM the two are in, and keeps them out of new ones. The blocked person's mentions of the
  // blocker stop counting, those already made too. Their messages in shared channels stay, and nobody is told.
  #block(me, id) {
    if (id === me.id) throw new Refusal(400, 'invalid', 'You cannot block yourself.', { field: 'member' });
    const target = this.#visibleMember(me, id);
    if (!target) throw new Refusal(404, 'not_found', 'There is no member with this id.');
    const old = this.sql.exec('SELECT at FROM block WHERE blocker = ? AND blocked = ?', me.n, target.n).toArray()[0];
    if (old) return reply(200, { block: { member: target.id, at: old.at } });
    const now = Date.now();
    this.sql.exec('INSERT INTO block (blocker, blocked, at) VALUES (?, ?, ?)', me.n, target.n, now);
    for (const c of this.#openDms(me.n)) {
      if (c.dmSet.split(',').map(Number).includes(target.n)) this.#closeDm(c, 'closed', now);
    }
    const rooms = this.sql
      .exec(
        `DELETE FROM mention WHERE member = ? AND EXISTS (
           SELECT 1 FROM event e WHERE e.conversation = mention.conversation AND e.seq = mention.seq AND e.actor = ?
         ) RETURNING conversation`,
        me.n,
        target.n
      )
      .toArray();
    // Each room that lost a mention comes back in the blocker's feed with its count put right.
    for (const conversation of new Set(rooms.map((row) => row.conversation))) {
      this.sql.exec('UPDATE grants SET rev = ? WHERE member = ? AND conversation = ?', this.#rev(), me.n, conversation);
    }
    this.#blocksChanged(me.n);
    return reply(201, { block: { member: target.id, at: now } });
  }

  // Unblocking takes the block away and nothing else: a closed DM stays closed, and mentions that went stay gone.
  #unblock(me, id) {
    const target = this.sql.exec('SELECT n FROM member WHERE id = ?', id).toArray()[0];
    const gone = target && this.sql.exec('DELETE FROM block WHERE blocker = ? AND blocked = ? RETURNING at', me.n, target.n).toArray().length > 0;
    if (gone) this.#blocksChanged(me.n);
    return reply(204);
  }

  // ---- Messages ----

  // Appends one event to a conversation and gives it the next sequence. c is updated in place, so a transaction that
  // appends twice gets consecutive sequences. A quiet event, such as a reaction, moves head but not last.
  #append(c, kind, actor, now, { text = null, data = null, root = null, size = 0, op = null, opHash = null }) {
    const seq = c.head + 1;
    const id = randomBytes(16);
    const rev = this.#rev();
    this.sql.exec(
      `INSERT INTO event (conversation, seq, id, kind, actor, at, root, text, data, size, op, opHash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      c.n,
      seq,
      blob(id),
      kind,
      actor.n,
      now,
      root ? blob(root) : null,
      text,
      data ? JSON.stringify(data) : null,
      size,
      op ? blob(op) : null,
      opHash ? blob(opHash) : null
    );
    const loud = !QUIET.has(kind);
    this.sql.exec('UPDATE conversation SET head = ?, rev = ?, last = CASE WHEN ? THEN ? ELSE last END WHERE n = ?', seq, rev, loud ? 1 : 0, seq, c.n);
    c.head = seq;
    c.rev = rev;
    if (loud) c.last = seq;
    return { seq, id, rev };
  }

  // The message an operation id of this member already made, from the message itself or, once retention removed that,
  // from the receipt it left.
  #sent(me, op) {
    return (
      this.sql.exec('SELECT conversation, seq, id, opHash, redactedAt FROM event WHERE actor = ? AND op = ?', me.n, blob(op)).toArray()[0] ??
      this.sql.exec('SELECT conversation, seq, id, opHash, 1 AS redactedAt FROM receipt WHERE actor = ? AND op = ?', me.n, blob(op)).toArray()[0]
    );
  }

  // A message. The device made the operation id before its first attempt and sends the same one on every retry, so a
  // message whose answer was lost is never posted twice: the id stays on the message's row for as long as the message
  // is kept, and on a receipt after that for as long as a retry could still come. The device also says under which
  // grant it wrote the message: one written before the member lost the channel is not sent because they got back in.
  // Files come uploaded and ready beforehand; the message names them, and binding them to it is part of the post.
  async #post(me, a) {
    // A message with files covers their ids too. One without hashes as before, so the retry of a message sent before
    // files existed still matches what it sent.
    const covered = [a.conversation, a.text, a.mentions, a.root];
    if (a.attachments.length) covered.push(a.attachments);
    const hash = (await sha256(utf8(JSON.stringify(covered)))).slice(0, 16);
    const now = Date.now();
    return this.#write(() => {
      const { c, grant } = this.#room(me, a.conversation);
      const before = this.#sent(me, a.op);
      if (before) {
        if (before.conversation !== c.n || !sameBytes(new Uint8Array(before.opHash), hash)) {
          throw new Refusal(409, 'operation_conflict', 'This operation id was used for a different message.');
        }
        return reply(200, { operationId: a.operationId, messageId: eventId(before.id), seq: before.seq });
      }
      if (a.generation !== this.#ws().generation) {
        throw new Refusal(409, 'stale_generation', 'This workspace was restored since the message was written. Load it again first.', { scope: 'workspace' });
      }
      if (a.grant !== grant.id) {
        throw new Refusal(409, 'stale_grant', 'This message was written before you were let back into the conversation. Check it before sending it again.', { scope: 'conversation' });
      }
      if (a.opTime < now - OPERATION_AGE) {
        throw new Refusal(409, 'submission_expired', 'This message waited too long to be sent. Check whether it arrived.');
      }
      if (a.opTime > now + OPERATION_AHEAD) throw new Refusal(400, 'invalid', "operationId is ahead of the server's time.", { field: 'operationId' });
      if (c.archivedAt) throw ARCHIVED(c);
      const limits = workspaceLimits(this.env);
      if (this.#ws().bytes + a.size > limits.contentBytes) {
        throw new Refusal(413, 'quota', 'This workspace is full. An admin can lower retention or remove content.', { scope: 'workspace', limit: 'bytes' });
      }
      const mentioned = [];
      for (const mention of a.mentions) {
        const target = this.#member(mention.actor);
        if (!target || !this.#grant(target, c)) {
          throw new Refusal(400, 'invalid', 'A mention names someone who is not in this conversation.', { field: 'mentions' });
        }
        mentioned.push(target.n);
      }
      let root = null;
      if (a.root) {
        root = eventBytes(a.root);
        const top = this.sql
          .exec("SELECT root, redactedAt FROM event WHERE id = ? AND conversation = ? AND kind = 'message.posted'", blob(root), c.n)
          .toArray()[0];
        if (!top || top.root || top.redactedAt) {
          throw new Refusal(400, 'invalid', 'root must be a top-level message in this conversation.', { field: 'root' });
        }
      }
      // Each file must be the caller's own upload for this conversation, ready, unsent and unexpired. The refusal names
      // every one that isn't, and nothing is posted.
      const files = a.attachments.map((id) => this.sql.exec('SELECT * FROM upload WHERE id = ?', id).toArray()[0]);
      const missing = a.attachments.filter((id, i) => {
        const row = files[i];
        return !row || row.member !== me.n || row.conversation !== c.n || row.state !== 'ready' || row.expiresAt <= now;
      });
      if (missing.length) {
        throw new Refusal(409, 'files_unavailable', 'A file in this message is no longer available. Attach it again.', { files: missing });
      }
      const { seq, id } = this.#append(c, 'message.posted', me, now, {
        text: a.text,
        data: a.mentions.length ? a.mentions : null,
        root,
        size: a.size,
        op: a.op,
        opHash: hash
      });
      files.forEach((row, pos) => {
        this.sql.exec("UPDATE upload SET state = 'bound', seq = ?, pos = ? WHERE n = ?", seq, pos, row.n);
      });
      // Someone who blocked the sender isn't called by their mentions. The mention stays in the text, as written.
      const blockers = new Set(this.sql.exec('SELECT blocker FROM block WHERE blocked = ?', me.n).toArray().map((row) => row.blocker));
      for (const n of new Set(mentioned)) {
        if (n !== me.n && !blockers.has(n)) this.sql.exec('INSERT INTO mention (member, conversation, seq) VALUES (?, ?, ?)', n, c.n, seq);
      }
      this.sql.exec('UPDATE workspace SET bytes = bytes + ? WHERE id = 1', a.size);
      // Whoever posts has the conversation in front of them, so it is read up to their own message.
      this.sql.exec('UPDATE grants SET readSeq = ?, rev = ? WHERE member = ? AND conversation = ?', seq, this.#rev(), me.n, c.n);
      this.#wakeRoom(c);
      return reply(201, { operationId: a.operationId, messageId: eventId(id), seq });
    });
  }

  // Whether a message with this operation id is here, for a device that never got its answer and whose id has since
  // become too old to send again.
  #operation(me, conversation, op) {
    const { c } = this.#room(me, conversation);
    const row = this.#sent(me, op);
    if (!row || row.conversation !== c.n) throw new Refusal(404, 'not_found', 'There is no message from this operation here.');
    return reply(200, { messageId: eventId(row.id), seq: row.seq, visible: !row.redactedAt });
  }

  // Removes a message's text for everyone: its author can, and so can a manager of the channel. The message's place
  // in the order stays, a later event says it was removed, and the feed tells every device to drop its copy. Its
  // reactions and link cards go with the text, without events of their own, and its files go to the trash. The events
  // that added and took back its reactions keep their place but no longer say who reacted with what.
  #redact(me, conversation, message) {
    const { c, grant } = this.#room(me, conversation);
    const id = eventBytes(message);
    const target = this.sql
      .exec("SELECT seq, actor, size, redactedAt FROM event WHERE id = ? AND conversation = ? AND kind = 'message.posted'", blob(id), c.n)
      .toArray()[0];
    if (!target) throw new Refusal(404, 'not_found', 'There is no message with this id here.');
    if (target.actor !== me.n && grant.role !== 'manager') throw FORBIDDEN('Only its author or a channel manager removes a message.');
    if (target.redactedAt) return reply(200, { messageId: message, redacted: true });
    const now = Date.now();
    this.sql.exec(
      'UPDATE event SET text = NULL, data = NULL, size = 0, previews = NULL, redactedAt = ? WHERE conversation = ? AND seq = ?',
      now,
      c.n,
      target.seq
    );
    this.sql.exec('DELETE FROM mention WHERE conversation = ? AND seq = ?', c.n, target.seq);
    this.#dropRich('conversation = ? AND seq = ?', c.n, target.seq);
    // Its cards also went out in message.previewed events, with the addresses from its text. Those events keep their
    // place in the order and lose the cards.
    const scrubbed = JSON.stringify({ target: message, targetSeq: target.seq, previews: [] });
    for (const row of this.sql
      .exec("SELECT seq, data FROM event WHERE conversation = ? AND seq > ? AND kind = 'message.previewed'", c.n, target.seq)
      .toArray()) {
      if (JSON.parse(row.data).target === message) this.sql.exec('UPDATE event SET data = ? WHERE conversation = ? AND seq = ?', scrubbed, c.n, row.seq);
    }
    // Its reactions went out in reaction.added and reaction.removed events, with who reacted and which emoji. Each
    // becomes reaction.cleared, by whoever removed the message, with only the target.
    this.sql.exec(
      `UPDATE event SET kind = 'reaction.cleared', actor = ?, data = ?
       WHERE conversation = ? AND seq > ? AND kind IN ('reaction.added', 'reaction.removed') AND json_extract(data, '$.targetSeq') = ?`,
      me.n,
      JSON.stringify({ target: message, targetSeq: target.seq }),
      c.n,
      target.seq,
      target.seq
    );
    this.sql.exec('UPDATE workspace SET bytes = MAX(0, bytes - ?) WHERE id = 1', target.size);
    const { rev } = this.#append(c, 'message.redacted', me, now, { data: { target: message, targetSeq: target.seq } });
    this.sql.exec('INSERT INTO removal (conversation, rev, id, at) VALUES (?, ?, ?, ?)', c.n, rev, blob(id), now);
    this.#wakeRoom(c);
    return reply(200, { messageId: message, redacted: true });
  }

  // A read position only moves forward and never past what exists. The member's other devices are woken, so a
  // channel read on the phone stops showing as unread on the desktop. A read that names a readMark lower than the
  // room's was made before the member marked something unread, and moves nothing.
  #read(me, conversation, seq, readMark) {
    const { c, grant } = this.#room(me, conversation);
    if (readMark !== null && readMark < grant.readMark) return reply(200, { read: grant.readSeq, readMark: grant.readMark });
    const next = Math.min(Math.max(grant.readSeq, seq), c.head);
    if (next !== grant.readSeq) {
      this.sql.exec('UPDATE grants SET readSeq = ?, rev = ? WHERE member = ? AND conversation = ?', next, this.#rev(), me.n, c.n);
      this.wakes.add(me.n);
    }
    return reply(200, { read: next, readMark: grant.readMark });
  }

  // Marking a message unread: the read position goes back to just before it, and never below what the room still
  // holds. It never moves forward here. readMark counts these moves, so the member's other devices take the lower
  // position from the feed instead of keeping their own higher one.
  #unread(me, conversation, message) {
    const { c, grant } = this.#room(me, conversation);
    const bytes = eventBytes(message);
    const target =
      bytes && this.sql.exec("SELECT seq FROM event WHERE id = ? AND conversation = ? AND kind = 'message.posted'", blob(bytes), c.n).toArray()[0];
    if (!target) throw NO_MESSAGE();
    const next = Math.max(target.seq - 1, c.floor - 1, 0);
    if (next >= grant.readSeq) return reply(200, { read: grant.readSeq, readMark: grant.readMark });
    this.sql.exec(
      'UPDATE grants SET readSeq = ?, readMark = readMark + 1, rev = ? WHERE member = ? AND conversation = ?',
      next,
      this.#rev(),
      me.n,
      c.n
    );
    this.wakes.add(me.n);
    return reply(200, { read: next, readMark: grant.readMark + 1 });
  }

  // A message of this conversation that is still there, or the 404 of one that isn't.
  #message(c, id) {
    const bytes = eventBytes(id);
    const row =
      bytes &&
      this.sql
        .exec("SELECT seq, actor, previews, noPreviews FROM event WHERE id = ? AND conversation = ? AND kind = 'message.posted' AND redactedAt IS NULL", blob(bytes), c.n)
        .toArray()[0];
    if (!row) throw NO_MESSAGE();
    return row;
  }

  // ---- Reactions ----

  // Someone who can read a message reacts to it with an emoji, once per emoji, and can take it back. Each change is an
  // event in the conversation's order, so a device's cache follows it like anything else, but it is no activity: it
  // isn't unread, mentions nobody, alerts nobody and leaves lastAt alone. A change to nothing appends nothing.
  #react(me, conversation, message, emoji, on) {
    const { c } = this.#room(me, conversation);
    const target = this.#message(c, message);
    if (c.archivedAt) throw ARCHIVED(c);
    const mine = this.sql
      .exec('SELECT 1 FROM reaction WHERE conversation = ? AND seq = ? AND emoji = ? AND member = ?', c.n, target.seq, emoji, me.n)
      .toArray().length > 0;
    if (mine === on) return reply(200, { messageId: message, emoji, on, changed: false });
    const now = Date.now();
    const data = { target: message, targetSeq: target.seq, emoji };
    if (on) {
      const kinds = this.sql
        .exec('SELECT COUNT(DISTINCT emoji) AS n, MAX(emoji = ?) AS here FROM reaction WHERE conversation = ? AND seq = ?', emoji, c.n, target.seq)
        .one();
      if (!kinds.here && kinds.n >= REACTIONS) {
        throw new Refusal(409, 'reaction_limit', `A message holds at most ${REACTIONS} different reactions.`);
      }
      const { seq } = this.#append(c, 'reaction.added', me, now, { data });
      this.sql.exec('INSERT INTO reaction (conversation, seq, emoji, member, ord) VALUES (?, ?, ?, ?, ?)', c.n, target.seq, emoji, me.n, seq);
    } else {
      this.sql.exec('DELETE FROM reaction WHERE conversation = ? AND seq = ? AND emoji = ? AND member = ?', c.n, target.seq, emoji, me.n);
      this.#append(c, 'reaction.removed', me, now, { data });
    }
    this.#wakeRoom(c);
    return reply(200, { messageId: message, emoji, on, changed: true });
  }

  // ---- Files ----
  //
  // An upload's bytes are counted in workspace.fileBytes from its reservation until its key is deleted from the
  // bucket: as a reservation while it waits, then as a stored file once a message has it. A bound file's key goes to
  // the trash with its message, and the trash keeps the bytes counted until the bucket confirms the delete. Each
  // attempt at writing an upload gets a key of its own. The upload's own count covers one attempt that is under way;
  // any other is counted by itself (attempt.charge), so whatever the bucket may hold is always counted.

  #fileBytes(delta) {
    if (delta) this.sql.exec('UPDATE workspace SET fileBytes = MAX(0, fileBytes + ?) WHERE id = 1', delta);
  }

  // A key whose object goes from the bucket. Counted until the alarm has deleted it.
  #toTrash(key, size, now) {
    const added = this.sql.exec('INSERT OR IGNORE INTO trash (key, size, at) VALUES (?, ?, ?) RETURNING key', key, size, now).toArray().length > 0;
    if (added) this.#fileBytes(size);
    this.#alarmBy(now + TRASH_SOON);
  }

  // The attempts at an upload that its own count covered get counts of their own, for when it stops covering them:
  // it got a key, or it went.
  #uncover(n) {
    for (const row of this.sql.exec('UPDATE attempt SET charge = size WHERE upload = ? AND charge = 0 RETURNING size', n).toArray()) {
      this.#fileBytes(row.size);
    }
  }

  // An upload goes, in any state: its key to the trash, its count with it.
  #dropUpload(row, now) {
    this.#uncover(row.n);
    if (row.key) this.#toTrash(row.key, row.size, now);
    this.sql.exec('DELETE FROM upload WHERE n = ?', row.n);
    this.#fileBytes(-row.size);
  }

  // The reactions and files of the messages a condition on conversation and seq picks, when those messages go: the
  // reactions with them, the files' keys to the trash. Without seq in the condition, unsent uploads go too.
  #dropRich(where, ...args) {
    const now = Date.now();
    this.sql.exec(`DELETE FROM reaction WHERE ${where}`, ...args);
    for (const row of this.sql.exec(`SELECT * FROM upload WHERE ${where}`, ...args).toArray()) this.#dropUpload(row, now);
  }

  // Reserves an upload of a file to send in this conversation. The Worker signs the PUT link (files.js).
  #reserve(me, a) {
    const { c } = this.#room(me, a.conversation);
    if (c.archivedAt) throw ARCHIVED(c);
    const now = Date.now();
    const open = this.sql
      .exec('SELECT COUNT(*) AS n, MIN(expiresAt) AS first FROM upload WHERE member = ? AND seq IS NULL AND expiresAt > ?', me.n, now)
      .one();
    if (open.n >= OPEN_UPLOADS) {
      const wait = Math.max(1, Math.ceil((open.first - now) / 1000));
      throw new Refusal(429, 'rate_limited', `You have ${OPEN_UPLOADS} files waiting to be sent. Send or remove some first.`, { limit: 'uploads' }, { 'retry-after': String(wait) });
    }
    if (this.#ws().fileBytes + a.size > workspaceLimits(this.env).filesBytes) throw FILES_QUOTA();
    const id = newId('f');
    const expiresAt = now + UPLOAD_TIME;
    this.sql.exec(
      `INSERT INTO upload (id, member, conversation, name, type, size, sha256, width, height, state, createdAt, expiresAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?)`,
      id,
      me.n,
      c.n,
      a.name,
      a.type,
      a.size,
      a.sha256,
      a.width,
      a.height,
      now,
      expiresAt
    );
    this.#fileBytes(a.size);
    // The alarm frees it once it expires, if no message took it.
    this.#alarmBy(expiresAt + 1000);
    return { status: 201, body: { upload: { id, expiresAt } }, file: { id, expiresAt } };
  }

  // Cancels the caller's own upload that no message has. Nothing to cancel is fine too.
  #cancelUpload(me, conversation, id) {
    const c = this.#conversation(conversation);
    const row = c && this.sql.exec('SELECT * FROM upload WHERE id = ? AND member = ? AND conversation = ? AND seq IS NULL', id, me.n, c.n).toArray()[0];
    if (row) this.#dropUpload(row, Date.now());
    return reply(204);
  }

  // What a download link needs, for a file of a message the caller can read: one that wasn't removed and that
  // retention still keeps, or the image of one of its link cards. The Worker signs the link with key (files.js).
  #download(me, conversation, id) {
    const { c } = this.#room(me, conversation);
    const row = this.sql
      .exec(
        `SELECT u.*, e.redactedAt FROM upload u JOIN event e ON e.conversation = u.conversation AND e.seq = u.seq
         WHERE u.id = ? AND u.conversation = ? AND u.state = 'bound'`,
        id,
        c.n
      )
      .toArray()[0];
    if (!row || row.redactedAt || row.seq < c.floor || !row.key) throw NO_FILE();
    return { status: 200, body: { name: row.name, type: row.type, size: row.size, sha256: row.sha256 }, file: { id, key: row.key } };
  }

  #startAttempt(id, length, now) {
    if (this.deleting) throw new Refusal(503, 'unavailable', 'The workspace is busy. Try again shortly.', {}, { 'retry-after': '30' });
    const upload = this.sql.exec('SELECT * FROM upload WHERE id = ?', id).toArray()[0];
    if (!upload || !(upload.state === 'reserved' || upload.state === 'uploading') || upload.expiresAt <= now) throw INVALID_STATE();
    if (length !== upload.size) {
      throw new Refusal(400, 'invalid', `This upload takes exactly ${upload.size} bytes, the size it was reserved with.`, { field: 'size' });
    }
    const flying = this.sql.exec('SELECT COUNT(*) AS n FROM attempt WHERE upload = ? AND at > ?', upload.n, now - ATTEMPT_TIME).one().n;
    if (flying >= ATTEMPTS) {
      throw new Refusal(429, 'rate_limited', 'This file is being uploaded already. Try again shortly.', { limit: 'attempts' }, { 'retry-after': '60' });
    }
    // The upload's own count covers one attempt at a time. A second one under way is counted by itself, and only
    // starts when the workspace has room for it.
    const taken = this.sql.exec('SELECT 1 FROM attempt WHERE upload = ? AND charge = 0', upload.n).toArray().length > 0;
    const charge = taken ? upload.size : 0;
    if (charge && this.#ws().fileBytes + charge > workspaceLimits(this.env).filesBytes) throw FILES_QUOTA();
    const key = fileKey(this.wid);
    this.sql.exec('INSERT INTO attempt (key, upload, size, charge, at) VALUES (?, ?, ?, ?, ?)', key, upload.n, upload.size, charge, now);
    this.#fileBytes(charge);
    this.sql.exec("UPDATE upload SET state = 'uploading' WHERE n = ?", upload.n);
    this.#alarmBy(now + ATTEMPT_TIME + 1000);
    return {
      status: 200,
      body: null,
      attempt: { key, size: upload.size, type: upload.type, name: upload.name, sha256: upload.sha256 }
    };
  }

  // The answers here are returned, never thrown: a thrown refusal would roll back the key's way to the trash.
  #finishAttempt(id, key, size, ok, now) {
    const READY = () => reply(200, { upload: { id, ready: true } });
    const GONE = () => INVALID_STATE().reply;
    const upload = this.sql.exec('SELECT * FROM upload WHERE id = ?', id).toArray()[0];
    const attempt = this.sql.exec('SELECT * FROM attempt WHERE key = ?', key).toArray()[0];
    if (!attempt) {
      // The same end told twice: the key won, and stays.
      if (this.sql.exec('SELECT 1 FROM upload WHERE key = ?', key).toArray().length > 0) return READY();
      // Given up on as dead, its key in the trash and maybe deleted already, before this write landed. The key goes to
      // the trash again, so nothing it wrote stays behind.
      this.#toTrash(key, size, now);
      if (ok && upload?.key) return READY();
      if (ok) return GONE();
      return reply(200, null);
    }
    this.sql.exec('DELETE FROM attempt WHERE key = ?', key);
    this.#fileBytes(-attempt.charge);
    const mine = upload && upload.n === attempt.upload;
    const open = mine && (upload.state === 'reserved' || upload.state === 'uploading') && !upload.key && upload.expiresAt > now;
    if (ok && open) {
      this.sql.exec("UPDATE upload SET state = 'ready', key = ? WHERE n = ?", key, upload.n);
      this.#uncover(upload.n);
      return READY();
    }
    this.#toTrash(key, attempt.size, now);
    if (!ok) return reply(200, null);
    // Another attempt won meanwhile: this one's key goes, and the answer is the same.
    if (mine && upload.key) return READY();
    return GONE();
  }

  // Uploads that expired before a message took them, and attempts that never reported back. Returns whether more is
  // due than one sweep takes.
  #expireUploads(now) {
    const uploads = this.sql.exec('SELECT * FROM upload WHERE seq IS NULL AND expiresAt <= ? LIMIT ?', now, SWEEP_BATCH).toArray();
    for (const row of uploads) this.#dropUpload(row, now);
    const dead = this.sql.exec('SELECT * FROM attempt WHERE at <= ? LIMIT ?', now - ATTEMPT_TIME, SWEEP_BATCH).toArray();
    for (const row of dead) {
      this.sql.exec('DELETE FROM attempt WHERE key = ?', row.key);
      this.#fileBytes(-row.charge);
      this.#toTrash(row.key, row.size, now);
    }
    return uploads.length >= SWEEP_BATCH || dead.length >= SWEEP_BATCH;
  }

  // Deletes the trash from the bucket, a batch at a time, and only then stops counting its bytes. A delete that fails
  // throws and leaves the keys for the next alarm. When the store names the keys that failed (err.failed), the others
  // leave the trash all the same and the failed ones go to its back, so a key that keeps failing holds up no other.
  // Returns whether more is waiting.
  async #emptyTrash() {
    const store = fileStore(this.env);
    if (!store) return false;
    const size = Math.min(TRASH_BATCH, store.batch);
    const rows = this.sql.exec('SELECT key FROM trash ORDER BY at LIMIT ?', size + 1).toArray();
    if (!rows.length) return false;
    const batch = rows.slice(0, size).map((row) => row.key);
    let failure = null;
    try {
      await store.delete(batch);
    } catch (err) {
      if (!Array.isArray(err?.failed)) throw err;
      failure = err;
    }
    if (!this.present) return false;
    const failed = new Set(failure?.failed);
    const now = Date.now();
    this.#write(() => {
      for (const key of batch) {
        if (failed.has(key)) {
          this.sql.exec('UPDATE trash SET at = ? WHERE key = ?', now, key);
          continue;
        }
        const gone = this.sql.exec('DELETE FROM trash WHERE key = ? RETURNING size', key).toArray()[0];
        if (gone) this.#fileBytes(-gone.size);
      }
    });
    if (failure) throw failure;
    return rows.length > size;
  }

  // When the alarm comes next: in a minute while a sweep left work or the trash isn't empty, five minutes after a delete
  // failed, at the next expiry of an upload or an attempt, and in a day at the latest.
  #nextAlarm(now, more, failed) {
    if (failed) return now + TRASH_RETRY;
    if (more) return now + 60 * 1000;
    let next = now + DAY;
    if (filesOn(this.env) && this.sql.exec('SELECT 1 FROM trash LIMIT 1').toArray().length > 0) next = now + 60 * 1000;
    const upload = this.sql.exec('SELECT MIN(expiresAt) AS t FROM upload WHERE seq IS NULL').one().t;
    if (upload !== null) next = Math.min(next, upload + 1000);
    const attempt = this.sql.exec('SELECT MIN(at) AS t FROM attempt').one().t;
    if (attempt !== null) next = Math.min(next, attempt + ATTEMPT_TIME + 1000);
    return Math.max(next, now + 1000);
  }

  // ---- Link cards ----

  // The message link cards are for, when it can still get them: there, not removed, never given cards before and
  // never had one taken away by its author.
  #unfurlable(conversation, message) {
    const c = this.#conversation(conversation);
    const bytes = eventBytes(message);
    const target =
      c &&
      bytes &&
      this.sql
        .exec("SELECT seq, actor, previews, noPreviews, redactedAt FROM event WHERE id = ? AND conversation = ? AND kind = 'message.posted'", blob(bytes), c.n)
        .toArray()[0];
    if (!target || target.redactedAt || target.noPreviews || target.previews !== null) return null;
    return { c, target };
  }

  #previewKey(conversation, message, size, now) {
    if (this.deleting || !this.#unfurlable(conversation, message)) return null;
    if (this.#ws().fileBytes + size > workspaceLimits(this.env).filesBytes) return null;
    const key = fileKey(this.wid);
    this.sql.exec('INSERT INTO attempt (key, upload, size, charge, at) VALUES (?, NULL, ?, ?, ?)', key, size, size, now);
    this.#fileBytes(size);
    this.#alarmBy(now + ATTEMPT_TIME + 1000);
    return key;
  }

  #publishPreviews(conversation, message, previews, discard, now) {
    // An image's key, taken from the attempts it was recorded in: false when this object had given up on it already.
    const take = (key) => {
      const row = this.sql.exec('DELETE FROM attempt WHERE key = ? AND upload IS NULL RETURNING charge', key).toArray()[0];
      if (row) this.#fileBytes(-row.charge);
      return Boolean(row);
    };
    const drop = (image) => {
      take(image.key);
      this.#toTrash(image.key, image.size, now);
    };
    for (const image of discard) drop(image);
    const found = this.#unfurlable(conversation, message);
    if (!found || previews.length === 0) {
      for (const p of previews) if (p.image) drop(p.image);
      return { published: false };
    }
    const { c, target } = found;
    const out = previews.map((p, pos) => {
      let image = null;
      if (p.image && take(p.image.key)) {
        const row = {
          id: newId('f'),
          name: `preview.${p.image.ext}`,
          type: p.image.type,
          size: p.image.size,
          width: p.image.width ?? null,
          height: p.image.height ?? null
        };
        this.sql.exec(
          `INSERT INTO upload (id, member, conversation, name, type, size, sha256, width, height, state, key, createdAt, expiresAt, seq, pos, preview)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'bound', ?, ?, ?, ?, ?, 1)`,
          row.id,
          target.actor,
          c.n,
          row.name,
          row.type,
          row.size,
          p.image.sha256,
          row.width,
          row.height,
          p.image.key,
          now,
          now,
          target.seq,
          pos
        );
        this.#fileBytes(row.size);
        image = fileOut(row);
      } else if (p.image) {
        this.#toTrash(p.image.key, p.image.size, now);
      }
      return { url: p.url, title: p.title, description: p.description, site: p.site, image, video: p.video };
    });
    this.sql.exec('UPDATE event SET previews = ? WHERE conversation = ? AND seq = ?', JSON.stringify(out), c.n, target.seq);
    this.#append(c, 'message.previewed', { n: target.actor }, now, { data: { target: message, targetSeq: target.seq, previews: out } });
    this.#wakeRoom(c);
    return { published: true, previews: out };
  }

  // The author takes a link card off their message: the card goes, its image to the trash, and message.previewed
  // carries the cards left. Asking at all also means the message never gets cards again, so cards still being made
  // for it are dropped when they arrive.
  #removePreview(me, conversation, message, url) {
    const { c } = this.#room(me, conversation);
    const target = this.#message(c, message);
    if (target.actor !== me.n) throw FORBIDDEN('Only its author removes a link card from a message.');
    const previews = target.previews ? JSON.parse(target.previews) : [];
    const kept = previews.filter((p) => p.url !== url);
    this.sql.exec('UPDATE event SET noPreviews = 1 WHERE conversation = ? AND seq = ?', c.n, target.seq);
    if (kept.length !== previews.length) {
      const now = Date.now();
      for (const p of previews) {
        if (p.url !== url || !p.image) continue;
        const row = this.sql.exec('SELECT * FROM upload WHERE id = ? AND conversation = ? AND seq = ?', p.image.id, c.n, target.seq).toArray()[0];
        if (row) this.#dropUpload(row, now);
      }
      this.sql.exec('UPDATE event SET previews = ? WHERE conversation = ? AND seq = ?', JSON.stringify(kept), c.n, target.seq);
      this.#append(c, 'message.previewed', me, now, { data: { target: message, targetSeq: target.seq, previews: kept } });
      this.#wakeRoom(c);
    }
    return reply(200, { previews: kept });
  }

  // A page of a conversation's events, oldest first: after a sequence, or the newest ones before a sequence.
  #events(me, a) {
    const { c } = this.#room(me, a.conversation);
    const rows =
      a.before !== null
        ? this.#eventRows('e.conversation = ? AND e.seq < ? ORDER BY e.seq DESC LIMIT ?', c.n, a.before, a.limit + 1)
        : this.#eventRows('e.conversation = ? AND e.seq > ? ORDER BY e.seq LIMIT ?', c.n, a.after, a.limit + 1);
    const more = rows.length > a.limit;
    const page = rows.slice(0, a.limit);
    if (a.before !== null) page.reverse();
    return reply(200, { events: this.#eventsOut(c.n, page, a.version), head: c.head, floor: c.floor, more });
  }

  #eventRows(where, ...args) {
    return this.sql
      .exec(
        `SELECT e.seq, e.id, e.kind, e.at, e.root, e.text, e.data, e.redactedAt, e.previews, m.id AS actor
         FROM event e JOIN member m ON m.n = e.actor WHERE ${where}`,
        ...args
      )
      .toArray();
  }

  // Events as devices get them, with what a message carries besides its text: its files and its reactions as they are
  // now, read for the whole page at once. Its link cards are on its own row. version is the reader's wire version.
  #eventsOut(conversation, rows, version) {
    const seqs = rows.filter((row) => row.kind === 'message.posted' && !row.redactedAt).map((row) => row.seq);
    if (!seqs.length) return rows.map((row) => eventOut(row));
    const from = Math.min(...seqs);
    const to = Math.max(...seqs);
    const files = new Map();
    for (const row of this.sql.exec(
      'SELECT * FROM upload WHERE conversation = ? AND seq BETWEEN ? AND ? AND preview = 0 ORDER BY seq, pos',
      conversation,
      from,
      to
    )) {
      if (!files.has(row.seq)) files.set(row.seq, []);
      files.get(row.seq).push(fileOut(row));
    }
    // Who reacted, in the order they did; each emoji's group in the order of its first reaction.
    const reactions = new Map();
    for (const row of this.sql.exec(
      'SELECT r.seq, r.emoji, m.id AS actor FROM reaction r JOIN member m ON m.n = r.member WHERE r.conversation = ? AND r.seq BETWEEN ? AND ? ORDER BY r.seq, r.ord',
      conversation,
      from,
      to
    )) {
      if (!reactions.has(row.seq)) reactions.set(row.seq, new Map());
      const groups = reactions.get(row.seq);
      if (!groups.has(row.emoji)) groups.set(row.emoji, []);
      groups.get(row.emoji).push(row.actor);
    }
    return rows.map((row) => {
      const groups = reactions.get(row.seq);
      const out = eventOut(row, files.get(row.seq) ?? [], groups ? [...groups].map(([emoji, actors]) => ({ emoji, actors })) : []);
      return version < 2 ? namedFiles(out) : out;
    });
  }

  // ---- The feed ----

  // What changed for the caller since a cursor: the rooms they are in whose state moved, with their badges, and the
  // rooms they lost. One latest revision per room, per grant and per eviction is paged in revision order, so a page
  // that ends early leaves everything it hasn't returned ahead of its cursor, and a cursor that came with more: false
  // covers everything through its revision. Without a cursor this is the pass a device starts or starts over with.
  //
  // A cursor holds two revisions. at is where the scan is. base is the revision the device was brought through when
  // its last pass finished, or, on a pass from the start, the revision at which that pass began. A room can change
  // again while a device pages, which moves it ahead of at, so what was redacted in it is listed from base, not from
  // at: a redaction the scan passed on its way is listed anyway. base is also what the feed must still remember.
  async #changes(me, a) {
    const cursor = a.after ? await this.#open(a.after) : null;
    // Opening the cursor waited, and the caller may have been removed meanwhile.
    me = this.#member(me.id);
    if (!me) throw NO_WORKSPACE();
    const ws = this.#ws();
    const RESET = () => new Refusal(410, 'reset_required', 'This device has to load the workspace again.', { scope: 'workspace' });
    if (a.after) {
      if (!cursor || cursor.member !== me.id || cursor.generation !== ws.generation) throw RESET();
      if (cursor.at > ws.rev || cursor.base > ws.rev) {
        throw new Refusal(409, 'history_regressed', 'This workspace is behind what this device has seen.', { scope: 'workspace' });
      }
      if (cursor.base < ws.feedFloor) throw RESET();
    }
    const after = cursor ? cursor.at : 0;
    const base = cursor ? cursor.base : ws.rev;
    const rows = this.sql
      .exec(
        `SELECT 0 AS gone, c.id AS id, MAX(c.rev, g.rev) AS rev FROM grants g JOIN conversation c ON c.n = g.conversation
         WHERE g.member = ? AND MAX(c.rev, g.rev) > ?
         UNION ALL
         SELECT 1, conversation, rev FROM evicted WHERE member = ? AND rev > ?
         ORDER BY rev LIMIT ?`,
        me.n,
        after,
        me.n,
        after,
        a.limit + 1
      )
      .toArray();
    const more = rows.length > a.limit;
    const page = rows.slice(0, a.limit);
    const full = FULL.has(me.role);
    const body = {
      changes: page.filter((row) => !row.gone).map((row) => this.#roomOut(me, row.id, cursor ? base : null)),
      evictions: page.filter((row) => row.gone).map((row) => row.id),
      inlineEvents: [],
      // Whether to load the member list, the channel directory and the caller's own blocks again. A guest has no
      // channel directory, and hears of members only when someone they share a room with changed, came or went.
      directory: {
        members: !cursor || (full ? ws.membersRev > base : this.#peersChanged(me, base)),
        channels: full && (!cursor || ws.channelsRev > base),
        blocks: !cursor || me.blocksRev > base
      },
      more
    };
    if (a.active) {
      const c = this.#conversation(a.active);
      if (c && this.#grant(me, c)) {
        const from = a.roomAfter ?? Math.max(c.head - INLINE_EVENTS, 0);
        body.inlineEvents = this.#eventsOut(c.n, this.#eventRows('e.conversation = ? AND e.seq > ? ORDER BY e.seq LIMIT ?', c.n, from, INLINE_EVENTS), a.version);
      }
    }
    body.next = more
      ? await this.#cursor(me, ws.generation, page[page.length - 1].rev, base)
      : await this.#cursor(me, ws.generation, ws.rev, ws.rev);
    return reply(200, body);
  }

  // Whether the people a guest can see changed since a revision: someone came into or left one of their rooms,
  // someone in one of them changed their name or role, the guest lost a room and the people in it, or the guest's
  // own name or role changed on another device.
  #peersChanged(me, since) {
    return (
      this.sql
        .exec(
          `SELECT 1 FROM grants g JOIN conversation c ON c.n = g.conversation WHERE g.member = ? AND c.roster > ?
           UNION ALL
           SELECT 1 FROM member m WHERE m.rev > ? AND (m.n = ? OR m.n IN (
             SELECT member FROM grants WHERE conversation IN (SELECT conversation FROM grants WHERE member = ?)
           ))
           UNION ALL
           SELECT 1 FROM evicted WHERE member = ? AND rev > ?
           LIMIT 1`,
          me.n,
          since,
          since,
          me.n,
          me.n,
          me.n,
          since
        )
        .toArray().length > 0
    );
  }

  // One room as the feed shows it. after is the cursor's base, or null on the first page of a pass from the start,
  // which builds the room's cache from history that already leaves out what was removed. members is how many people
  // hold the room now, lastAt when its newest event that is activity happened (reactions and link cards aren't), or
  // null once retention took that event. readMark counts the member's marks of unread here. A DM has no name: it names
  // its people instead, who started it, and why it closed.
  #roomOut(me, id, after) {
    const c = this.#conversation(id);
    const grant = this.#grant(me, c);
    const unread = this.sql
      .exec(
        `SELECT COUNT(*) AS n FROM (SELECT 1 FROM event WHERE conversation = ? AND seq > ? AND kind = 'message.posted'
         AND actor != ? AND redactedAt IS NULL LIMIT ?)`,
        c.n,
        grant.readSeq,
        me.n,
        BADGE_CAP
      )
      .one().n;
    const mentions = this.sql
      .exec('SELECT COUNT(*) AS n FROM (SELECT 1 FROM mention WHERE member = ? AND conversation = ? AND seq > ? LIMIT ?)', me.n, c.n, grant.readSeq, BADGE_CAP)
      .one().n;
    const removed =
      after === null
        ? []
        : this.sql.exec('SELECT id FROM removal WHERE conversation = ? AND rev > ? ORDER BY rev LIMIT ?', c.n, after, REMOVED_IDS + 1).toArray();
    const members = this.sql.exec('SELECT COUNT(*) AS n FROM grants WHERE conversation = ?', c.n).one().n;
    const last = this.sql.exec('SELECT at FROM event WHERE conversation = ? AND seq = ?', c.n, c.last).toArray()[0];
    const dm = c.kind === 'dm';
    const people = dm ? this.#dmPeople(c) : null;
    return {
      conversation: c.id,
      kind: c.kind,
      name: dm ? null : c.name,
      visibility: c.visibility,
      archived: c.archivedAt !== null,
      ...(dm ? { participants: people.ids, startedBy: people.startedBy, closedReason: c.closedWhy ?? null } : {}),
      grant: grant.id,
      role: grant.role,
      members,
      head: c.head,
      floor: c.floor,
      lastAt: last ? last.at : null,
      read: grant.readSeq,
      readMark: grant.readMark,
      unread,
      mentions,
      removed: removed.slice(0, REMOVED_IDS).map((row) => eventId(row.id)),
      removedMore: removed.length > REMOVED_IDS
    };
  }

  // A DM's people as member ids, in the order of their keys, and the id of whoever started it. Member rows outlive a
  // membership, so someone who left or was deleted is still named.
  #dmPeople(c) {
    const ns = c.dmSet.split(',').map(Number);
    const rows = this.sql.exec(`SELECT n, id FROM member WHERE n IN (${ns.map(() => '?').join(', ')}) ORDER BY n`, ...ns).toArray();
    const starter = this.sql.exec('SELECT id FROM member WHERE n = ?', c.createdBy).toArray()[0];
    return { ids: rows.map((row) => row.id), startedBy: starter ? starter.id : null };
  }

  // A socket ticket: 30 seconds, one use, for the session that asked. The Worker signs it (workspaces.js).
  #ticket(me, session) {
    const now = Date.now();
    const nonce = toBase64url(randomBytes(16));
    this.sql.exec('INSERT INTO ticket (nonce, member, session, expiresAt) VALUES (?, ?, ?, ?)', nonce, me.n, session, now + TICKET_TIME);
    return { status: 200, body: null, ticket: { nonce, expiresAt: now + TICKET_TIME } };
  }

  // ---- Retention ----

  // Removes events older than the cutoff, a batch at a time, and raises each conversation's floor to match. An
  // archived channel with nothing left is collected: its grants end and its slot is free. Returns whether more is due.
  #expire(cutoff, now) {
    const batch = this.sql
      .exec(
        `SELECT conversation, MAX(seq) AS upto, SUM(size) AS bytes FROM (
           SELECT conversation, seq, size FROM event WHERE at < ? ORDER BY at LIMIT ?
         ) GROUP BY conversation`,
        cutoff,
        SWEEP_BATCH
      )
      .toArray();
    let count = 0;
    for (const { conversation, upto } of batch) {
      const freed = this.sql
        .exec('SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM event WHERE conversation = ? AND seq <= ?', conversation, upto)
        .one();
      // With retention shorter than the time a retry may still come, a message can go while its operation id is still
      // in use. Its receipt stays, so the retry gets the first answer instead of posting again.
      this.sql.exec(
        `INSERT OR IGNORE INTO receipt (actor, op, conversation, seq, id, opHash, at)
         SELECT actor, op, conversation, seq, id, opHash, at FROM event
         WHERE conversation = ? AND seq <= ? AND op IS NOT NULL AND at > ?`,
        conversation,
        upto,
        now - RECEIPT_TIME
      );
      this.sql.exec('DELETE FROM event WHERE conversation = ? AND seq <= ?', conversation, upto);
      this.sql.exec('DELETE FROM mention WHERE conversation = ? AND seq <= ?', conversation, upto);
      this.#dropRich('conversation = ? AND seq <= ?', conversation, upto);
      this.sql.exec('UPDATE workspace SET bytes = MAX(0, bytes - ?) WHERE id = 1', freed.bytes);
      this.sql.exec('UPDATE conversation SET floor = ?, rev = ? WHERE n = ?', upto + 1, this.#rev(), conversation);
      this.#wakeRoom({ n: conversation });
      count += freed.n;
    }
    for (const c of this.sql.exec('SELECT * FROM conversation WHERE archivedAt IS NOT NULL AND floor > head').toArray()) {
      for (const g of this.sql.exec('SELECT member FROM grants WHERE conversation = ?', c.n).toArray()) {
        this.sql.exec('INSERT OR REPLACE INTO evicted (member, conversation, rev, at) VALUES (?, ?, ?, ?)', g.member, c.id, this.#rev(), now);
        this.wakes.add(g.member);
      }
      this.sql.exec('DELETE FROM grants WHERE conversation = ?', c.n);
      this.sql.exec('DELETE FROM mention WHERE conversation = ?', c.n);
      this.sql.exec('DELETE FROM removal WHERE conversation = ?', c.n);
      this.#dropRich('conversation = ?', c.n);
      this.sql.exec('DELETE FROM conversation WHERE n = ?', c.n);
    }
    return count >= SWEEP_BATCH;
  }

  // Forgets evictions and redactions older than the feed keeps them. A cursor from before the newest forgotten one
  // can no longer be answered exactly, so it starts over.
  #trimFeed(cutoff) {
    const oldest = this.sql
      .exec(
        `SELECT MAX(rev) AS rev FROM (
           SELECT rev FROM removal WHERE at <= ? UNION ALL SELECT rev FROM evicted WHERE at <= ?
         )`,
        cutoff,
        cutoff
      )
      .one().rev;
    if (oldest === null) return;
    this.sql.exec('DELETE FROM removal WHERE at <= ?', cutoff);
    this.sql.exec('DELETE FROM evicted WHERE at <= ?', cutoff);
    this.sql.exec('UPDATE workspace SET feedFloor = MAX(feedFloor, ?) WHERE id = 1', oldest);
  }
}

// An invitation as an owner or admin sees it. channels are the ones the viewer may know of; channelCount is how many
// the invitation leads into.
function inviteOut(row, channels, channelCount) {
  return {
    id: row.id,
    role: row.role,
    channels,
    channelCount,
    issuer: row.issuerId,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt
  };
}

function channelRow(row) {
  return {
    id: row.id,
    name: row.name,
    visibility: row.visibility,
    archived: row.archivedAt !== null,
    joined: row.grantRole !== null,
    role: row.grantRole,
    members: row.members
  };
}

// An event as devices get it. A message carries its files in the order it named them, its link cards and its
// reactions, each [] when it has none. A redacted message keeps its place, its author and its time, and nothing else.
function eventOut(row, attachments = [], reactions = []) {
  const out = { seq: row.seq, id: eventId(row.id), kind: row.kind, actor: row.actor, at: row.at };
  if (row.kind !== 'message.posted') return { ...out, ...(row.data ? JSON.parse(row.data) : {}) };
  if (row.root) out.root = eventId(row.root);
  if (row.redactedAt) return { ...out, redacted: true };
  return {
    ...out,
    text: row.text,
    mentions: row.data ? JSON.parse(row.data) : [],
    attachments,
    previews: row.previews ? JSON.parse(row.previews) : [],
    reactions
  };
}

// A message of files without text, for a reader of wire version 1, which takes no message without text: its text is
// a paperclip and the files' names. What is stored doesn't change.
function namedFiles(event) {
  if (event.kind !== 'message.posted' || event.redacted || event.text !== '' || !event.attachments.length) return event;
  // Ten names of at most 255 characters stay under 10.3 KB, well within the 16,384-byte text limit, so nothing is cut.
  const text = `📎 ${event.attachments.map((file) => file.name).join(', ')}`;
  return { ...event, text, mentions: [] };
}
