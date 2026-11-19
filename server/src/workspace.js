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

import { DurableObject } from 'cloudflare:workers';
import { blob, fromBase64url, hmac, randomBytes, sameBytes, sha256, toBase64url, utf8 } from './bytes.js';
import { accountObject, workspaceLimits } from './config.js';

const DAY = 24 * 60 * 60 * 1000;
// An operation id older than this is refused even when its retry receipt is gone; one further ahead than the second
// number can't come from a device that asked this server for the time (WORKSPACES.md, Messaging and sync).
const OPERATION_AGE = 30 * DAY;
const OPERATION_AHEAD = 5 * 60 * 1000;
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

const FULL = new Set(['owner', 'admin', 'member']);
const ADMIN = new Set(['owner', 'admin']);

// Conversations and members have small integer keys inside the database and random ids outside it: a message row
// names its channel and its author, and at 16 KiB of text or less the keys are a real share of what a workspace
// stores. Event and operation ids are 16 random bytes for the same reason.
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
    bytes INTEGER NOT NULL
  );
  CREATE TABLE member (
    n INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    incarnation TEXT UNIQUE,
    account TEXT,
    role TEXT NOT NULL,
    state TEXT NOT NULL,
    name TEXT NOT NULL,
    joinedAt INTEGER NOT NULL,
    endedAt INTEGER
  );
  CREATE TABLE retired (incarnation TEXT PRIMARY KEY, at INTEGER NOT NULL);
  CREATE TABLE conversation (
    n INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL,
    visibility TEXT NOT NULL,
    name TEXT NOT NULL,
    createdBy INTEGER NOT NULL,
    createdAt INTEGER NOT NULL,
    archivedAt INTEGER,
    head INTEGER NOT NULL,
    floor INTEGER NOT NULL,
    rev INTEGER NOT NULL
  );
  CREATE TABLE grants (
    member INTEGER NOT NULL,
    conversation INTEGER NOT NULL,
    id TEXT NOT NULL,
    role TEXT NOT NULL,
    startSeq INTEGER NOT NULL,
    readSeq INTEGER NOT NULL,
    rev INTEGER NOT NULL,
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
    PRIMARY KEY (conversation, seq)
  ) WITHOUT ROWID;
  CREATE UNIQUE INDEX event_id ON event (id);
  CREATE UNIQUE INDEX event_op ON event (actor, op) WHERE op IS NOT NULL;
  CREATE INDEX event_at ON event (at);
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
// ceiling. Numbers are tokens held at most, and tokens added per second.
const LANES = {
  fetch: { burst: 60, rate: 8 },
  send: { burst: 30, rate: 3 },
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
  post: 'send',
  read: 'send',
  join: 'send',
  'invite.preview': 'send',
  'invite.create': 'send',
  'member.rename': 'send',
  'channel.create': 'send',
  'channel.rename': 'send',
  'channel.join': 'send',
  'channel.admit': 'send',
  'channel.role': 'send',
  ticket: 'ticket',
  'member.role': 'control',
  'member.remove': 'control',
  'invite.revoke': 'control',
  'channel.archive': 'control',
  'channel.remove': 'control',
  redact: 'control'
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
    // The accounts of the people in this workspace, so a request can be given its own bucket before any query runs.
    this.accounts = new Set();
    if (this.present) {
      for (const row of this.sql.exec("SELECT account FROM member WHERE state = 'active'")) this.accounts.add(row.account);
    }
    const now = Date.now();
    this.buckets = new Map();
    this.strangers = new Bucket(STRANGER_LANE, now);
    this.ceiling = new Bucket(WORKSPACE_LANE, now);
    this.lastWake = new Map();
    this.trailing = new Map();
    this.wakes = new Set();
    this.key = null;
    // A device's keepalive is answered without waking this object, and renews nothing.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  // ---- Called by the Worker ----

  // Makes the workspace with its first owner and a first channel. who is what Account.principal() answered.
  async create(who, input) {
    if (this.present) return reply(409, { error: 'exists', message: 'This workspace already exists.' });
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
      return await this.#dispatch(op, me, who, args);
    } catch (err) {
      if (err instanceof Refusal) return err.reply;
      throw err;
    }
  }

  // Whether an account incarnation is a member, for GET /v1/workspaces: what the list shows, or null.
  async membership(incarnation) {
    if (!this.present) return null;
    const me = this.#actor({ incarnation });
    return me ? { id: this.#ws().wid, name: this.#ws().name, role: me.role } : null;
  }

  // An account was deleted (Account, #cleanup): its membership ends, its name goes, and nothing still on its way in
  // under that incarnation can commit. What it wrote stays, under a deleted member, until retention removes it.
  async retire(incarnation) {
    if (!this.present) return true;
    const now = Date.now();
    const gone = this.#write(() => {
      this.sql.exec('INSERT OR IGNORE INTO retired (incarnation, at) VALUES (?, ?)', incarnation, now);
      const member = this.sql.exec('SELECT * FROM member WHERE incarnation = ?', incarnation).toArray()[0];
      if (!member) return null;
      if (member.state === 'active') this.#endMembership(member, member, now);
      this.sql.exec(
        "UPDATE member SET state = 'deleted', incarnation = NULL, account = NULL, name = '', endedAt = ? WHERE n = ?",
        now,
        member.n
      );
      this.#membersChanged();
      return member;
    });
    if (gone) this.#forget(gone);
    return true;
  }

  // The socket a device waits on. The Worker has checked the ticket's signature and passes its nonce; the ticket
  // itself was issued here, to one session, and works once.
  async fetch(request) {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket' || !this.present) {
      return new Response(null, { status: 426 });
    }
    const now = Date.now();
    const nonce = request.headers.get('x-ticket') || '';
    const ticket = this.ctx.storage.transactionSync(() => {
      const row = this.sql.exec('DELETE FROM ticket WHERE nonce = ? RETURNING member, session, expiresAt', nonce).toArray()[0];
      if (!row || row.expiresAt <= now) return null;
      const member = this.sql.exec("SELECT n FROM member WHERE n = ? AND state = 'active'", row.member).toArray()[0];
      return member ? row : null;
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

  // Once a day: what retention removes, what the feed no longer needs to remember, and spent tickets and invitations.
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
        this.#trimFeed(now - FEED_DAYS * DAY);
        return this.#expire(now - limits.retentionDays * DAY, now);
      });
    } catch (err) {
      // A sweep that fails is tried again tomorrow. Without the next alarm, retention would stop for good.
      console.error('A workspace could not run its daily sweep:', err?.stack || err);
    }
    await this.ctx.storage.setAlarm(now + (more ? 60 * 1000 : DAY));
  }

  // ---- Load shedding and sockets ----

  // 0 to let a request in, else the seconds to wait. No query and no call to another object happens before this.
  #admit(name, op, now) {
    const lane = OPERATIONS[op] ?? 'send';
    if (lane !== 'control') {
      const wait = this.ceiling.take(now);
      if (wait) return wait;
    }
    if (!this.accounts.has(name)) return this.strangers.take(now);
    let mine = this.buckets.get(name);
    if (!mine) {
      mine = {};
      this.buckets.set(name, mine);
    }
    mine[lane] ??= new Bucket(LANES[lane], now);
    return mine[lane].take(now);
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
    const result = this.ctx.storage.transactionSync(fn);
    const wakes = this.wakes;
    this.wakes = new Set();
    this.#wake(wakes);
    return result;
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

  // Someone left or was removed: their bucket and their sockets go.
  #forget(member) {
    if (member.account) {
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

  #membersChanged() {
    this.sql.exec('UPDATE workspace SET membersRev = ? WHERE id = 1', this.#rev());
    this.#wakeFull();
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
      return Array.isArray(value) && value.length === 3 ? { member: value[0], generation: value[1], rev: value[2] } : null;
    } catch {
      return null;
    }
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
      limits: { members: limits.members, conversations: limits.conversations, textBytes: limits.textBytes },
      retention: { contentDays: limits.retentionDays, feedDays: FEED_DAYS }
    };
  }

  // ---- Dispatch ----

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
      case 'post':
        return this.#post(me, a);
      case 'redact':
        return this.#write(() => this.#redact(me, a.conversation, a.message));
      case 'read':
        return this.#write(() => this.#read(me, a.conversation, a.seq));
      case 'events':
        return this.#events(me, a);
      case 'operation':
        return this.#operation(me, a.conversation, a.op);
      case 'changes':
        return this.#changes(me, a);
      case 'ticket':
        return this.#ticket(me, who.session);
    }
    throw new Refusal(404, 'not_found', 'There is nothing here.');
  }

  // ---- Members and invitations ----

  // Adds an account as a member, or brings back the row of someone who was here before under the same incarnation, so
  // what they wrote earlier stays theirs.
  #addMember(who, role, name, now) {
    const old = this.sql.exec('SELECT n FROM member WHERE incarnation = ?', who.incarnation).toArray()[0];
    if (old) {
      this.sql.exec(
        "UPDATE member SET state = 'active', role = ?, name = ?, account = ?, joinedAt = ?, endedAt = NULL WHERE n = ?",
        role,
        name,
        who.name,
        now,
        old.n
      );
    } else {
      this.sql.exec(
        "INSERT INTO member (id, incarnation, account, role, state, name, joinedAt) VALUES (?, ?, ?, ?, 'active', ?, ?)",
        newId('u'),
        who.incarnation,
        who.name,
        role,
        name,
        now
      );
    }
    this.#membersChanged();
    return this.#actor(who);
  }

  // Full members see everyone, also who left, so old messages keep their author's name. A guest sees the people in
  // the channels they were let into.
  #members(me) {
    const rows = FULL.has(me.role)
      ? this.sql.exec('SELECT * FROM member ORDER BY n LIMIT 2000').toArray()
      : this.sql
          .exec(
            `SELECT * FROM member WHERE state = 'active' AND (n = ? OR n IN (
               SELECT member FROM grants WHERE conversation IN (SELECT conversation FROM grants WHERE member = ?)
             )) ORDER BY n`,
            me.n,
            me.n
          )
          .toArray();
    return reply(200, { members: rows.map(memberOut) });
  }

  #rename(me, name) {
    this.sql.exec('UPDATE member SET name = ? WHERE n = ?', name, me.n);
    this.#membersChanged();
    return reply(200, { me: memberOut({ ...me, name }) });
  }

  // Owners appoint owners and change anyone. Admins move people between member and guest.
  #setRole(me, id, role) {
    const target = this.#member(id);
    if (!target) throw new Refusal(404, 'not_found', 'There is no member with this id.');
    const allowed =
      me.role === 'owner' || (me.role === 'admin' && !ADMIN.has(target.role) && (role === 'member' || role === 'guest'));
    if (!allowed) throw FORBIDDEN('Your role in this workspace does not allow this change.');
    if (target.role === 'owner' && role !== 'owner' && this.#owners() <= 1) {
      throw new Refusal(409, 'last_owner', 'A workspace needs an owner. Appoint another one first.');
    }
    this.sql.exec('UPDATE member SET role = ? WHERE n = ?', role, target.n);
    this.#membersChanged();
    this.wakes.add(target.n);
    return reply(200, { member: memberOut({ ...target, role }) });
  }

  // Leaving, or being removed. Every grant ends with it. The account's reference to this workspace is given back
  // afterwards; a reference that outlives its membership is dropped the next time the account lists its workspaces.
  async #removeMember(me, id) {
    const now = Date.now();
    const gone = this.#write(() => {
      const target = id === 'me' ? me : this.#member(id);
      if (!target) throw new Refusal(404, 'not_found', 'There is no member with this id.');
      const self = target.n === me.n;
      if (!self && !(me.role === 'owner' || (me.role === 'admin' && !ADMIN.has(target.role)))) {
        throw FORBIDDEN('Your role in this workspace does not allow removing this member.');
      }
      if (target.role === 'owner' && this.#owners() <= 1) {
        throw new Refusal(409, 'last_owner', 'A workspace needs an owner. Appoint another one first.');
      }
      this.#endMembership(target, me, now);
      this.sql.exec('UPDATE member SET state = ?, endedAt = ? WHERE n = ?', self ? 'left' : 'removed', now, target.n);
      this.#membersChanged();
      return target;
    });
    this.#forget(gone);
    try {
      await accountObject(this.env, gone.account).dropWorkspace(gone.incarnation, this.#ws().wid);
    } catch (err) {
      console.error('Could not give a workspace reference back:', err?.message || err);
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
    return reply(200, { invites: rows.map(inviteOut) });
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
        throw new Refusal(413, 'quota', 'This workspace has too many open invitations. Revoke some first.', { scope: 'workspace' });
      }
      for (const id of a.channels) {
        const c = this.#conversation(id);
        const grant = c && this.#grant(issuer, c);
        if (!grant) throw NO_CONVERSATION();
        if (grant.role !== 'manager') throw FORBIDDEN('You can only invite into channels you manage.');
      }
      const row = {
        id: newId('i'),
        issuerId: issuer.id,
        role: a.role,
        channels: JSON.stringify(a.channels),
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
      return row;
    });
    return reply(201, { invite: inviteOut(invite), secret });
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
      channels: JSON.parse(invite.channels).length,
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
    const ref = await accountObject(this.env, who.name).addWorkspace(token, this.#ws().wid);
    if (ref.status !== 200) return reply(ref.status, ref.body);
    if (ref.incarnation !== who.incarnation) throw new Refusal(401, 'unauthorized', 'Sign in again.', { scope: 'account' });
    const now = Date.now();
    const me = this.#write(() => {
      if (this.sql.exec('SELECT 1 FROM retired WHERE incarnation = ?', who.incarnation).toArray().length > 0) {
        throw new Refusal(401, 'unauthorized', 'Sign in again.', { scope: 'account' });
      }
      const again = this.#actor(who);
      if (again) return again;
      const { invite, issuer } = this.#usable(hash, now);
      const members = this.sql.exec("SELECT COUNT(*) AS n FROM member WHERE state = 'active'").one().n;
      if (members >= workspaceLimits(this.env).members) {
        throw new Refusal(413, 'quota', 'This workspace is full.', { scope: 'workspace' });
      }
      const member = this.#addMember(who, invite.role, a.name, now);
      this.sql.exec('UPDATE invite SET redeemedBy = ?, redeemedAt = ? WHERE id = ?', member.n, now, invite.id);
      // A channel the issuer stopped managing since, or that was archived, is left out; the rest still holds.
      for (const id of JSON.parse(invite.channels)) {
        const c = this.#conversation(id);
        const grant = c && !c.archivedAt && this.#grant(issuer, c);
        if (grant?.role === 'manager') this.#grantTo(member, c, 'member', issuer, now);
      }
      return member;
    });
    this.accounts.add(who.name);
    return reply(201, { workspace: await this.#workspaceOut(), me: memberOut(me) });
  }

  // ---- Channels ----

  #newChannel(me, { name, visibility }, now) {
    const count = this.sql.exec('SELECT COUNT(*) AS n FROM conversation').one().n;
    if (count >= workspaceLimits(this.env).conversations) {
      throw new Refusal(413, 'quota', 'This workspace has no room for another channel.', { scope: 'workspace' });
    }
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

  // The directory: every channel the caller is in, and for full members every channel the workspace can see.
  #channels(me) {
    const rows = this.sql
      .exec(
        `SELECT c.*, g.role AS grantRole, (SELECT COUNT(*) FROM grants WHERE conversation = c.n) AS members
         FROM conversation c LEFT JOIN grants g ON g.conversation = c.n AND g.member = ?
         WHERE g.member IS NOT NULL OR (? AND c.visibility = 'workspace' AND c.archivedAt IS NULL)
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
    const { c, grant } = this.#room(me, id);
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
    const visible = c && (grant || (FULL.has(me.role) && c.visibility === 'workspace'));
    if (!visible) throw NO_CONVERSATION();
    if (!(grant?.role === 'manager' || ADMIN.has(me.role))) throw FORBIDDEN('Only a channel manager or an admin archives it.');
    if (!c.archivedAt) this.#archiveChannel(c, me, Date.now());
    return reply(200, { channel: this.#channelOut(me, c) });
  }

  #archiveChannel(c, by, now) {
    this.sql.exec('UPDATE conversation SET archivedAt = ? WHERE n = ?', now, c.n);
    this.#append(c, 'channel.archived', by, now, {});
    this.#wakeRoom(c);
    if (c.visibility === 'workspace') this.#channelsChanged();
  }

  // A full member lets themselves into a channel the workspace can see. To a guest such a channel doesn't exist.
  #joinChannel(me, id) {
    const c = this.#conversation(id);
    if (!c || c.visibility !== 'workspace' || !FULL.has(me.role)) {
      if (c && this.#grant(me, c)) return reply(200, { channel: this.#channelOut(me, c) });
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
    const visible = c && (this.#grant(me, c) || (FULL.has(me.role) && c.visibility === 'workspace'));
    if (!visible) throw NO_CONVERSATION();
    const rows = this.sql
      .exec('SELECT m.id AS member, g.role FROM grants g JOIN member m ON m.n = g.member WHERE g.conversation = ? ORDER BY m.n', c.n)
      .toArray();
    return reply(200, { members: rows });
  }

  // A manager lets a member into their channel. For a guest the manager must also be an admin, who signs off on
  // letting someone from outside the team in. Two different people signing isn't built yet.
  #admitToChannel(me, id, memberId) {
    const { c, grant } = this.#room(me, id);
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
    const { c, grant } = this.#room(me, id);
    if (grant.role !== 'manager') throw FORBIDDEN('Only a channel manager changes roles.');
    const target = this.#member(memberId);
    const theirs = target && this.#grant(target, c);
    if (!theirs) throw new Refusal(404, 'not_found', 'There is no member with this id in the channel.');
    if (theirs.role === 'manager' && role !== 'manager' && this.#managers(c) <= 1) {
      throw new Refusal(409, 'last_manager', 'A channel needs a manager. Appoint another one first.');
    }
    if (theirs.role !== role) {
      this.sql.exec('UPDATE grants SET role = ?, rev = ? WHERE member = ? AND conversation = ?', role, this.#rev(), target.n, c.n);
      this.wakes.add(target.n);
    }
    return reply(200, { member: target.id, role });
  }

  #managers(c) {
    return this.sql.exec("SELECT COUNT(*) AS n FROM grants WHERE conversation = ? AND role = 'manager'", c.n).one().n;
  }

  // Leaving a channel, or a manager taking someone out. A channel's last manager names who takes over before they
  // leave; the last person in a channel archives it by leaving.
  #leaveChannel(me, id, memberId, successorId) {
    const { c, grant } = this.#room(me, id);
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
  // grant starts, and where its read position starts.
  #grantTo(member, c, role, by, now) {
    const { seq } = this.#append(c, 'member.joined', by, now, { data: { member: member.id } });
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
    this.#wakeRoom(c);
  }

  // Ends a grant. The feed keeps an eviction for the member's devices, which is how they learn to drop the room.
  #endGrant(member, c, by, now) {
    this.sql.exec('DELETE FROM grants WHERE member = ? AND conversation = ?', member.n, c.n);
    this.sql.exec('DELETE FROM mention WHERE member = ? AND conversation = ?', member.n, c.n);
    this.#append(c, 'member.left', by, now, { data: { member: member.id } });
    this.sql.exec(
      'INSERT OR REPLACE INTO evicted (member, conversation, rev, at) VALUES (?, ?, ?, ?)',
      member.n,
      c.id,
      this.#rev(),
      now
    );
    this.#wakeRoom(c);
    this.wakes.add(member.n);
  }

  // ---- Messages ----

  // Appends one event to a conversation and gives it the next sequence. c is updated in place, so a transaction that
  // appends twice gets consecutive sequences.
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
    this.sql.exec('UPDATE conversation SET head = ?, rev = ? WHERE n = ?', seq, rev, c.n);
    c.head = seq;
    c.rev = rev;
    return { seq, id, rev };
  }

  // A message. The device made the operation id before its first attempt and sends the same one on every retry, so a
  // message whose answer was lost is never posted twice: the id stays on the message's row for as long as the message
  // is kept.
  async #post(me, a) {
    const hash = (await sha256(utf8(JSON.stringify([a.conversation, a.text, a.mentions, a.root])))).slice(0, 16);
    const now = Date.now();
    return this.#write(() => {
      const { c } = this.#room(me, a.conversation);
      const before = this.sql.exec('SELECT conversation, seq, id, opHash FROM event WHERE actor = ? AND op = ?', me.n, blob(a.op)).toArray()[0];
      if (before) {
        if (before.conversation !== c.n || !sameBytes(new Uint8Array(before.opHash), hash)) {
          throw new Refusal(409, 'operation_conflict', 'This operation id was used for a different message.');
        }
        return reply(200, { operationId: a.operationId, messageId: eventId(before.id), seq: before.seq });
      }
      if (a.opTime < now - OPERATION_AGE) {
        throw new Refusal(409, 'submission_expired', 'This message waited too long to be sent. Check whether it arrived.');
      }
      if (a.opTime > now + OPERATION_AHEAD) throw new Refusal(400, 'invalid', "operationId is ahead of the server's time.", { field: 'operationId' });
      if (c.archivedAt) throw new Refusal(409, 'archived', 'This channel is archived.', { scope: 'conversation' });
      const limits = workspaceLimits(this.env);
      if (this.#ws().bytes + a.size > limits.contentBytes) {
        throw new Refusal(413, 'quota', 'This workspace is full. An admin can lower retention or remove content.', { scope: 'workspace' });
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
      const { seq, id } = this.#append(c, 'message.posted', me, now, {
        text: a.text,
        data: a.mentions.length ? a.mentions : null,
        root,
        size: a.size,
        op: a.op,
        opHash: hash
      });
      for (const n of new Set(mentioned)) {
        if (n !== me.n) this.sql.exec('INSERT INTO mention (member, conversation, seq) VALUES (?, ?, ?)', n, c.n, seq);
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
    const row = this.sql
      .exec('SELECT seq, id, redactedAt FROM event WHERE actor = ? AND op = ? AND conversation = ?', me.n, blob(op), c.n)
      .toArray()[0];
    if (!row) throw new Refusal(404, 'not_found', 'There is no message from this operation here.');
    return reply(200, { messageId: eventId(row.id), seq: row.seq, visible: !row.redactedAt });
  }

  // Removes a message's text for everyone: its author can, and so can a manager of the channel. The message's place
  // in the order stays, a later event says it was removed, and the feed tells every device to drop its copy.
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
      'UPDATE event SET text = NULL, data = NULL, size = 0, redactedAt = ? WHERE conversation = ? AND seq = ?',
      now,
      c.n,
      target.seq
    );
    this.sql.exec('DELETE FROM mention WHERE conversation = ? AND seq = ?', c.n, target.seq);
    this.sql.exec('UPDATE workspace SET bytes = MAX(0, bytes - ?) WHERE id = 1', target.size);
    const { rev } = this.#append(c, 'message.redacted', me, now, { data: { target: message, targetSeq: target.seq } });
    this.sql.exec('INSERT INTO removal (conversation, rev, id, at) VALUES (?, ?, ?, ?)', c.n, rev, blob(id), now);
    this.#wakeRoom(c);
    return reply(200, { messageId: message, redacted: true });
  }

  // A read position only moves forward and never past what exists. The member's other devices are woken, so a
  // channel read on the phone stops showing as unread on the desktop.
  #read(me, conversation, seq) {
    const { c, grant } = this.#room(me, conversation);
    const next = Math.min(Math.max(grant.readSeq, seq), c.head);
    if (next !== grant.readSeq) {
      this.sql.exec('UPDATE grants SET readSeq = ?, rev = ? WHERE member = ? AND conversation = ?', next, this.#rev(), me.n, c.n);
      this.wakes.add(me.n);
    }
    return reply(200, { read: next });
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
    return reply(200, { events: page.map(eventOut), head: c.head, floor: c.floor, more });
  }

  #eventRows(where, ...args) {
    return this.sql
      .exec(
        `SELECT e.seq, e.id, e.kind, e.at, e.root, e.text, e.data, e.redactedAt, m.id AS actor
         FROM event e JOIN member m ON m.n = e.actor WHERE ${where}`,
        ...args
      )
      .toArray();
  }

  // ---- The feed ----

  // What changed for the caller since a cursor: the rooms they are in whose state moved, with their badges, and the
  // rooms they lost. One latest revision per room, per grant and per eviction is paged in revision order, so a page
  // that ends early leaves everything it hasn't returned ahead of its cursor, and a cursor that came with more: false
  // covers everything through its revision. Without a cursor this is the pass a device starts or starts over with.
  async #changes(me, a) {
    const cursor = a.after ? await this.#open(a.after) : null;
    const ws = this.#ws();
    const RESET = () => new Refusal(410, 'reset_required', 'This device has to load the workspace again.', { scope: 'workspace' });
    if (a.after) {
      if (!cursor || cursor.member !== me.id || cursor.generation !== ws.generation) throw RESET();
      if (cursor.rev > ws.rev) {
        throw new Refusal(409, 'history_regressed', 'This workspace is behind what this device has seen.', { scope: 'workspace' });
      }
      if (cursor.rev < ws.feedFloor) throw RESET();
    }
    const after = cursor ? cursor.rev : 0;
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
    const through = more ? page[page.length - 1].rev : ws.rev;
    const body = {
      changes: page.filter((row) => !row.gone).map((row) => this.#roomOut(me, row.id, cursor ? after : null)),
      evictions: page.filter((row) => row.gone).map((row) => row.id),
      inlineEvents: [],
      // Whether to load the member list and the channel directory again. A guest has no directory.
      directory: {
        members: !cursor || ws.membersRev > after,
        channels: FULL.has(me.role) && (!cursor || ws.channelsRev > after)
      },
      more
    };
    if (a.active) {
      const c = this.#conversation(a.active);
      if (c && this.#grant(me, c)) {
        const from = a.roomAfter ?? Math.max(c.head - INLINE_EVENTS, 0);
        body.inlineEvents = this.#eventRows('e.conversation = ? AND e.seq > ? ORDER BY e.seq LIMIT ?', c.n, from, INLINE_EVENTS).map(eventOut);
      }
    }
    body.next = await this.#seal([me.id, ws.generation, through]);
    return reply(200, body);
  }

  // One room as the feed shows it. after is the caller's cursor revision, or null on a pass without one, which
  // rebuilds the room's cache anyway.
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
    return {
      conversation: c.id,
      kind: c.kind,
      name: c.name,
      visibility: c.visibility,
      archived: c.archivedAt !== null,
      grant: grant.id,
      role: grant.role,
      head: c.head,
      floor: c.floor,
      read: grant.readSeq,
      unread,
      mentions,
      removed: removed.slice(0, REMOVED_IDS).map((row) => eventId(row.id)),
      removedMore: removed.length > REMOVED_IDS
    };
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
      this.sql.exec('DELETE FROM event WHERE conversation = ? AND seq <= ?', conversation, upto);
      this.sql.exec('DELETE FROM mention WHERE conversation = ? AND seq <= ?', conversation, upto);
      this.sql.exec('UPDATE workspace SET bytes = MAX(0, bytes - ?) WHERE id = 1', freed.bytes);
      this.sql.exec('UPDATE conversation SET floor = ?, rev = ? WHERE n = ?', upto + 1, this.#rev(), conversation);
      count += freed.n;
    }
    for (const c of this.sql.exec('SELECT * FROM conversation WHERE archivedAt IS NOT NULL AND floor > head').toArray()) {
      for (const g of this.sql.exec('SELECT member FROM grants WHERE conversation = ?', c.n).toArray()) {
        this.sql.exec('INSERT OR REPLACE INTO evicted (member, conversation, rev, at) VALUES (?, ?, ?, ?)', g.member, c.id, this.#rev(), now);
      }
      this.sql.exec('DELETE FROM grants WHERE conversation = ?', c.n);
      this.sql.exec('DELETE FROM mention WHERE conversation = ?', c.n);
      this.sql.exec('DELETE FROM removal WHERE conversation = ?', c.n);
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

function inviteOut(row) {
  return {
    id: row.id,
    role: row.role,
    channels: JSON.parse(row.channels),
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

// An event as devices get it. A redacted message keeps its place, its author and its time, and nothing else.
function eventOut(row) {
  const out = { seq: row.seq, id: eventId(row.id), kind: row.kind, actor: row.actor, at: row.at };
  if (row.kind !== 'message.posted') return { ...out, ...(row.data ? JSON.parse(row.data) : {}) };
  if (row.root) out.root = eventId(row.root);
  if (row.redactedAt) return { ...out, redacted: true };
  return { ...out, text: row.text, mentions: row.data ? JSON.parse(row.data) : [] };
}
