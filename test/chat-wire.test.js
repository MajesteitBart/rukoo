'use strict';

// src/main/workspaces/wire.js: the shared vectors (test/fixtures/chat-vectors.json) as desktop reads them, the checks
// of the server's answers, the checks of every IPC method's arguments, and the errors the renderer tells apart.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const i18n = require('../src/i18n');
const { AccountError } = require('../src/main/account/client');
const wire = require('../src/main/workspaces/wire');
const vectors = require('./fixtures/chat-vectors.json');

const { ChatError } = wire;
const id = (prefix, label) => `${prefix}_${crypto.createHash('sha256').update(label).digest('base64url').slice(0, 22)}`;
const W = id('w', 'workspace');
const C = id('c', 'general');
const D = id('c', 'dm');
const U = id('u', 'zoe');
const U2 = id('u', 'joel');
const U3 = id('u', 'mila');
const E = id('e', 'one');
const E2 = id('e', 'two');
const G = id('g', 'grant');
const I = id('i', 'invite');
const LOCAL = crypto.createHash('sha256').update('local').digest('base64url').slice(0, 22);
const SECRET = crypto.createHash('sha256').update('secret').digest('base64url').slice(0, 43);
const GENERATION = crypto.createHash('sha256').update('generation').digest('base64url').slice(0, 22);

function refusedAt(fn, where) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof ChatError, `a ChatError, got ${err}`);
    assert.equal(err.code, 'server');
    if (where) assert.equal(err.where, where);
    return true;
  });
}

function invalidField(fn, field) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof ChatError, `a ChatError, got ${err && err.stack}`);
    assert.equal(err.code, 'invalid');
    assert.equal(err.field, field);
    return true;
  });
}

// ---- the shared vectors ----

test('every mention vector passes checkMentions unchanged', () => {
  for (const c of vectors.mentions) {
    assert.deepEqual(wire.checkMentions(c.text, c.bytes), c.bytes, c.name);
    assert.equal(wire.mentionRule(c.text, c.bytes), null, c.name);
  }
});

test('every bad mention vector breaks exactly its rule and is refused as invalid mentions', () => {
  for (const c of vectors.badMentions) {
    assert.equal(wire.mentionRule(c.text, c.bytes), c.rule, c.name);
    invalidField(() => wire.checkMentions(c.text, c.bytes), 'mentions');
  }
  // Mentions as UTF-16 offsets are what the editors hold; main takes only bytes, so a UTF-16 range that differs
  // from its bytes is refused or names other text.
  const zoe = vectors.mentions.find((c) => c.text.includes('Zoë') && c.bytes.length === 1);
  assert.notDeepEqual(zoe.utf16, zoe.bytes);
  assert.equal(wire.mentionRule(zoe.text, zoe.utf16), 'split_character');
});

test('every invitation link vector parses as desktop expects', () => {
  for (const c of vectors.inviteLinks) {
    let got;
    try {
      got = { result: wire.parseInviteLink(c.text, c.server), error: null };
    } catch (err) {
      assert.ok(err instanceof ChatError, `${c.name}: ${err}`);
      got = { result: null, error: err.code };
    }
    // Desktop follows the case itself; the android override applies to Android debug builds only.
    assert.deepEqual(got, { result: c.expect, error: c.error }, c.name);
  }
});

test('every UUIDv7 vector comes out of uuidv7 from its milliseconds and random bytes', () => {
  for (const c of vectors.uuidv7) assert.equal(wire.uuidv7(c.ms, Buffer.from(c.random, 'hex')), c.id, c.name);
});

// ---- invitation links ----

test('inviteLink writes the link parseInviteLink reads back, with and without a base path', () => {
  for (const server of ['https://rukoo.io', 'https://chat.example.com/rukoo', 'http://127.0.0.1:38811']) {
    const link = wire.inviteLink(server, W, SECRET);
    assert.equal(link, `${server}/join#w=${W}&i=${SECRET}`);
    assert.deepEqual(wire.parseInviteLink(link, server), { server, workspace: W, secret: SECRET });
    assert.deepEqual(wire.parseInviteLink(`Hoi! ${link}\n`), { server, workspace: W, secret: SECRET });
  }
  invalidField(() => wire.inviteLink('rukoo.io', W, SECRET), 'server');
  invalidField(() => wire.inviteLink('https://rukoo.io', C, SECRET), 'workspace');
  invalidField(() => wire.inviteLink('https://rukoo.io', W, 'short'), 'secret');
});

test('parseInviteLink refuses what is no text and names the other server', () => {
  for (const text of [null, undefined, 42, {}, '', '   ']) assert.throws(() => wire.parseInviteLink(text, 'https://rukoo.io'), { code: 'bad_link' });
  assert.throws(() => wire.parseInviteLink(`https://chat.example.net/join#w=${W}&i=${SECRET}`, 'https://rukoo.io'), (err) => {
    assert.equal(err.code, 'other_server');
    assert.match(err.message, /chat\.example\.net/);
    assert.match(err.message, /rukoo\.io/);
    return true;
  });
  // ws:// and other schemes are no invitation link.
  assert.throws(() => wire.parseInviteLink(`ws://127.0.0.1/join#w=${W}&i=${SECRET}`), { code: 'bad_link' });
});

// ---- UUIDv7 and local IDs ----

test('uuidv7 keeps the version, the variant and the time, and refuses what it cannot encode', () => {
  const now = 1795000123456;
  const a = wire.uuidv7(now);
  const b = wire.uuidv7(now + 1);
  for (const x of [a, b]) assert.match(x, wire.patterns.UUID_V7);
  assert.equal(parseInt(a.replace(/-/g, '').slice(0, 12), 16), now);
  assert.ok(a < b, 'a later millisecond sorts later');
  assert.notEqual(wire.uuidv7(now), wire.uuidv7(now), 'random bytes differ');
  assert.throws(() => wire.uuidv7(-1), RangeError);
  assert.throws(() => wire.uuidv7(2 ** 48), RangeError);
  assert.throws(() => wire.uuidv7(1.5), RangeError);
  assert.throws(() => wire.uuidv7(now, Buffer.alloc(9)), RangeError);
  assert.match(wire.localId(), wire.patterns.LOCAL_ID);
});

// ---- answers ----

function channelRow(over = {}) {
  return {
    conversation: C, kind: 'channel', name: 'general', visibility: 'workspace', archived: false,
    grant: G, role: 'member', members: 3, head: 42, floor: 1, lastAt: 1763550000000, read: 40, unread: 2, mentions: 1,
    removed: [E], removedMore: false, ...over
  };
}

function dmRow(over = {}) {
  return {
    conversation: D, kind: 'dm', name: null, visibility: 'dm', archived: false,
    participants: [U, U2, U3], startedBy: U, closedReason: null,
    grant: id('g', 'dm'), role: 'member', members: 3, head: 12, floor: 1, lastAt: 1763550000000, read: 10, unread: 2, mentions: 0,
    removed: [], removedMore: false, ...over
  };
}

const posted = (seq, over = {}) => ({ seq, id: id('e', `posted ${seq}`), kind: 'message.posted', actor: U, at: 1763550000000 + seq, text: `Hoi ${seq}`, mentions: [], ...over });

function page(over = {}) {
  return {
    changes: [channelRow(), dmRow()],
    evictions: [id('c', 'gone')],
    inlineEvents: [posted(41), posted(42, { text: 'Hoi @Zoë', mentions: [{ actor: U, start: 4, end: 9 }], root: E })],
    directory: { members: false, channels: true, blocks: false },
    next: 'AbC_-123',
    more: false,
    ...over
  };
}

test('checkChanges takes a page with a channel, a DM and inline events, and keeps only what the protocol names', () => {
  const body = page();
  body.changes[0].extra = 'ignored';
  body.surprise = { nested: true };
  const out = wire.checkChanges(body);
  assert.deepEqual(Object.keys(out), ['changes', 'evictions', 'inlineEvents', 'directory', 'next', 'more']);
  assert.equal(out.changes[0].extra, undefined);
  assert.deepEqual(out.changes[0], { ...channelRow(), participants: null, startedBy: null, closedReason: null });
  assert.deepEqual(out.changes[1], dmRow());
  assert.deepEqual(out.inlineEvents[1], posted(42, { text: 'Hoi @Zoë', mentions: [{ actor: U, start: 4, end: 9 }], root: E }));
  assert.deepEqual(out.directory, { members: false, channels: true, blocks: false });
  // A closed DM is archived; a server from before DMs leaves out members, lastAt and directory.blocks.
  assert.equal(wire.checkChanges(page({ changes: [dmRow({ archived: true, closedReason: 'closed' })] })).changes[0].closedReason, 'closed');
  const old = channelRow();
  delete old.members;
  delete old.lastAt;
  const before = wire.checkChanges(page({ changes: [old], directory: { members: true, channels: false } }));
  assert.equal(before.changes[0].members, 0);
  assert.equal(before.changes[0].lastAt, null);
  assert.equal(before.directory.blocks, false);
});

test('checkChanges refuses the whole page for a bad ID, an out-of-range number or an oversized list', () => {
  const cases = [
    ['changes.next', (p) => (p.next = 'a.b')],
    ['changes.next', (p) => (p.next = 'x'.repeat(401))],
    ['changes.more', (p) => (p.more = 'no')],
    ['changes.changes', (p) => (p.changes = 'rooms')],
    ['changes.changes[0].conversation', (p) => (p.changes[0].conversation = W)],
    ['changes.changes[0].conversation', (p) => (p.changes[0].conversation = 'c_short')],
    ['changes.changes[0].grant', (p) => (p.changes[0].grant = C)],
    ['changes.changes[0].kind', (p) => (p.changes[0].kind = 'thread')],
    ['changes.changes[0].name', (p) => (p.changes[0].name = '')],
    ['changes.changes[0].name', (p) => (p.changes[0].name = 'x'.repeat(201))],
    ['changes.changes[0].visibility', (p) => (p.changes[0].visibility = 'dm')],
    ['changes.changes[0].role', (p) => (p.changes[0].role = 'owner')],
    ['changes.changes[0].archived', (p) => (p.changes[0].archived = 0)],
    ['changes.changes[0].head', (p) => (p.changes[0].head = -1)],
    ['changes.changes[0].head', (p) => (p.changes[0].head = 2 ** 53)],
    ['changes.changes[0].floor', (p) => (p.changes[0].floor = 1.5)],
    ['changes.changes[0].read', (p) => (p.changes[0].read = 43)],
    ['changes.changes[0].unread', (p) => (p.changes[0].unread = 101)],
    ['changes.changes[0].mentions', (p) => (p.changes[0].mentions = -1)],
    ['changes.changes[0].members', (p) => (p.changes[0].members = '3')],
    ['changes.changes[0].lastAt', (p) => (p.changes[0].lastAt = 'today')],
    ['changes.changes[0].removed', (p) => (p.changes[0].removed = Array.from({ length: 65 }, (_, i) => id('e', `r${i}`)))],
    ['changes.changes[0].removed[0]', (p) => (p.changes[0].removed = ['e_bad'])],
    ['changes.changes[0].removed', (p) => (p.changes[0].removed = [E, E])],
    ['changes.changes[0].removedMore', (p) => (p.changes[0].removedMore = 1)],
    ['changes.changes[1].name', (p) => (p.changes[1].name = 'a DM has no name')],
    ['changes.changes[1].participants', (p) => (p.changes[1].participants = [U])],
    ['changes.changes[1].participants', (p) => (p.changes[1].participants = Array.from({ length: 9 }, (_, i) => id('u', `p${i}`)))],
    ['changes.changes[1].participants', (p) => (p.changes[1].participants = [U, U])],
    ['changes.changes[1].startedBy', (p) => (p.changes[1].startedBy = 'u_x')],
    ['changes.changes[1].closedReason', (p) => (p.changes[1].closedReason = 'blocked')],
    ['changes.changes[1].closedReason', (p) => (p.changes[1].archived = true)],
    ['changes.changes[1].closedReason', (p) => (p.changes[1].closedReason = 'left')],
    ['changes.changes', (p) => (p.changes = [channelRow(), channelRow()])],
    ['changes.changes', (p) => (p.changes = Array.from({ length: 101 }, (_, i) => channelRow({ conversation: id('c', `r${i}`) })))],
    ['changes.changes', (p) => {
      p.changes = Array.from({ length: 60 }, (_, i) => channelRow({ conversation: id('c', `r${i}`) }));
      p.evictions = Array.from({ length: 41 }, (_, i) => id('c', `e${i}`));
    }],
    ['changes.evictions[0]', (p) => (p.evictions = [E])],
    ['changes.inlineEvents', (p) => (p.inlineEvents = Array.from({ length: 21 }, (_, i) => posted(i + 1)))],
    ['changes.inlineEvents[1].seq', (p) => (p.inlineEvents = [posted(5), posted(5)])],
    ['changes.inlineEvents[0].mentions', (p) => (p.inlineEvents = [posted(1, { text: 'Hoi @Zoë', mentions: [{ actor: U, start: 4, end: 8 }] })])],
    ['changes.inlineEvents[0].text', (p) => (p.inlineEvents = [posted(1, { text: 'x'.repeat(16385) })])],
    ['changes.inlineEvents[0].text', (p) => (p.inlineEvents = [posted(1, { text: '\ud800' })])],
    ['changes.directory', (p) => (p.directory = null)],
    ['changes.directory.channels', (p) => (p.directory.channels = 'yes')],
    ['changes.directory.blocks', (p) => (p.directory.blocks = 1)]
  ];
  for (const [where, mutate] of cases) {
    const p = page();
    mutate(p);
    refusedAt(() => wire.checkChanges(p), where);
  }
  for (const v of [null, [], 'page', 42]) refusedAt(() => wire.checkChanges(v), 'changes');
});

test('checkEvents takes every event kind in order and refuses a page out of order or too long', () => {
  const at = 1763550000000;
  const events = [
    { seq: 1, id: id('e', '1'), kind: 'channel.created', actor: U, at, name: 'general', visibility: 'workspace' },
    { seq: 2, id: id('e', '2'), kind: 'member.joined', actor: U, at, member: U2 },
    { seq: 3, id: id('e', '3'), kind: 'message.posted', actor: U2, at, text: 'Hoi', mentions: [] },
    { seq: 4, id: id('e', '4'), kind: 'message.posted', actor: U2, at, root: id('e', '3'), redacted: true },
    { seq: 5, id: id('e', '5'), kind: 'message.redacted', actor: U2, at, target: id('e', '4'), targetSeq: 4 },
    { seq: 6, id: id('e', '6'), kind: 'channel.renamed', actor: U, at, name: 'algemeen' },
    { seq: 7, id: id('e', '7'), kind: 'channel.archived', actor: U, at },
    { seq: 8, id: id('e', '8'), kind: 'member.left', actor: U, at, member: U2 },
    { seq: 9, id: id('e', '9'), kind: 'dm.started', actor: U, at, members: [U, U2] },
    { seq: 10, id: id('e', '10'), kind: 'workspace.future_thing', actor: U, at, secret: 'dropped' }
  ];
  const out = wire.checkEvents({ events, head: 10, floor: 1, more: false });
  assert.equal(out.events.length, 10);
  assert.deepEqual(out.events[3], { seq: 4, id: id('e', '4'), kind: 'message.posted', actor: U2, at, root: id('e', '3'), redacted: true });
  assert.deepEqual(out.events[9], { seq: 10, id: id('e', '10'), kind: 'workspace.future_thing', actor: U, at });
  assert.deepEqual(out.events[8].members, [U, U2]);
  refusedAt(() => wire.checkEvents({ events: [events[1], events[0]], head: 2, floor: 1 }), 'events.events[1].seq');
  refusedAt(() => wire.checkEvents({ events: Array.from({ length: 101 }, (_, i) => posted(i + 1)), head: 101, floor: 1 }), 'events.events');
  refusedAt(() => wire.checkEvents({ events: [posted(1, { redacted: true })], head: 1, floor: 1 }), 'events.events[0].redacted');
  refusedAt(() => wire.checkEvents({ events: [{ ...events[4], target: 'nope' }], head: 5, floor: 1 }), 'events.events[0].target');
  refusedAt(() => wire.checkEvents({ events: [{ ...events[8], members: [U] }], head: 9, floor: 1 }), 'events.events[0].members');
  refusedAt(() => wire.checkEvents({ events: [{ ...events[0], kind: 'Bad Kind' }], head: 1, floor: 1 }), 'events.events[0].kind');
  refusedAt(() => wire.checkEvents({ events: [{ ...events[0], actor: null }], head: 1, floor: 1 }), 'events.events[0].actor');
  refusedAt(() => wire.checkEvents({ events: [{ ...events[0], seq: 0 }], head: 1, floor: 1 }), 'events.events[0].seq');
  refusedAt(() => wire.checkEvents({ events: [], head: -1, floor: 1 }), 'events.head');
});

test('a time a JavaScript Date cannot hold is refused, so the renderer never draws one', () => {
  // 8.64e15 ms is the last moment a Date holds; one past it is a safe integer whose toISOString() throws.
  const last = 8.64e15;
  assert.throws(() => new Date(last + 1).toISOString(), RangeError);
  const ev = (at) => ({ seq: 1, id: id('e', '1'), kind: 'message.posted', actor: U, at, text: 'Hoi', mentions: [] });
  assert.equal(wire.checkEvents({ events: [ev(last)], head: 1, floor: 1 }).events[0].at, last);
  refusedAt(() => wire.checkEvents({ events: [ev(last + 1)], head: 1, floor: 1 }), 'events.events[0].at');
  refusedAt(() => wire.checkEvents({ events: [ev(Number.MAX_SAFE_INTEGER)], head: 1, floor: 1 }), 'events.events[0].at');
  refusedAt(() => wire.checkBlocks({ blocks: [{ member: U, at: last + 1 }] }), 'blocks.blocks[0].at');
});

test('the directory, workspace and other answers are checked whole', () => {
  const member = { id: U, kind: 'human', name: 'Zoë', role: 'owner', state: 'active', joinedAt: 1 };
  const workspace = {
    id: W, name: 'Rukoo team', createdAt: 1, generation: GENERATION, keyId: 'AbCdEfGhIjK', time: 2,
    limits: { members: 100, conversations: 8192, textBytes: 16384 }, retention: { contentDays: 90, feedDays: 14 }
  };
  assert.deepEqual(wire.checkWorkspace({ workspace: { ...workspace, extra: 1 }, me: member }), { workspace, me: member });
  refusedAt(() => wire.checkWorkspace({ workspace: { ...workspace, generation: 'short' }, me: member }), 'workspace.workspace.generation');
  refusedAt(() => wire.checkWorkspace({ workspace: { ...workspace, limits: null }, me: member }), 'workspace.workspace.limits');
  refusedAt(() => wire.checkWorkspace({ workspace, me: { ...member, role: 'boss' } }), 'workspace.me.role');

  assert.deepEqual(wire.checkWorkspaces({ workspaces: [{ id: W, name: 'Rukoo team', role: 'owner' }] }).workspaces.length, 1);
  refusedAt(() => wire.checkWorkspaces({ workspaces: [{ id: W, name: 'a', role: 'owner' }, { id: W, name: 'b', role: 'owner' }] }), 'workspaces.workspaces');

  const deleted = { ...member, id: U2, name: '', state: 'deleted', role: 'member' };
  assert.deepEqual(wire.checkMembers({ members: [member, deleted], more: true }), { members: [member, deleted], more: true });
  refusedAt(() => wire.checkMembers({ members: [{ ...member, state: 'gone' }] }), 'members.members[0].state');
  refusedAt(() => wire.checkMembers({ members: [member, member] }), 'members.members');

  const channel = { id: C, name: 'general', visibility: 'private', archived: false, joined: true, role: null, members: 2 };
  assert.deepEqual(wire.checkChannels({ channels: [channel] }), { channels: [channel] });
  assert.deepEqual(wire.checkChannel({ channel }), { channel });
  refusedAt(() => wire.checkChannels({ channels: [{ ...channel, joined: 'yes' }] }), 'channels.channels[0].joined');
  refusedAt(() => wire.checkChannels({ channels: [{ ...channel, visibility: 'dm' }] }), 'channels.channels[0].visibility');

  assert.deepEqual(wire.checkBlocks({ blocks: [{ member: U2, at: 5 }] }), { blocks: [{ member: U2, at: 5 }] });
  refusedAt(() => wire.checkBlocks({ blocks: [{ member: W, at: 5 }] }), 'blocks.blocks[0].member');
  refusedAt(() => wire.checkBlocks({ blocks: [{ member: U2, at: 5 }, { member: U2, at: 6 }] }), 'blocks.blocks');

  assert.deepEqual(wire.checkDm({ dm: dmRow() }).dm.participants, [U, U2, U3]);
  refusedAt(() => wire.checkDm({ dm: channelRow() }), 'dm.dm.kind');
  assert.equal(wire.checkRoom(channelRow()).conversation, C);

  assert.deepEqual(wire.checkRoomMembers({ members: [{ member: U, role: 'manager' }] }), { members: [{ member: U, role: 'manager' }] });
  refusedAt(() => wire.checkRoomMember({ member: U, role: 'owner' }), 'roomMember.role');

  const invite = { id: I, role: 'guest', channels: [C], channelCount: 1, issuer: U, createdAt: 1, expiresAt: 2 };
  assert.deepEqual(wire.checkInvite({ invite, secret: SECRET }), { invite, secret: SECRET });
  assert.deepEqual(wire.checkInvites({ invites: [invite] }), { invites: [invite] });
  refusedAt(() => wire.checkInvite({ invite, secret: 'short' }), 'invite.secret');
  const preview = { workspace: { id: W, name: 'Rukoo team' }, role: 'member', channels: 2, issuer: { name: 'Zoë' }, expiresAt: 3 };
  assert.deepEqual(wire.checkPreview(preview), preview);
  refusedAt(() => wire.checkPreview({ ...preview, channels: [C] }), 'preview.channels');

  const operationId = vectors.uuidv7[0].id;
  assert.deepEqual(wire.checkPost({ operationId, messageId: E, seq: 3 }), { operationId, messageId: E, seq: 3 });
  refusedAt(() => wire.checkPost({ operationId: operationId.toUpperCase(), messageId: E, seq: 3 }), 'post.operationId');
  assert.deepEqual(wire.checkOperation({ messageId: E, seq: 3, visible: false }), { messageId: E, seq: 3, visible: false });
  assert.deepEqual(wire.checkRead({ read: 7 }), { read: 7 });
  assert.deepEqual(wire.checkRedact({ messageId: E, redacted: true }), { messageId: E, redacted: true });
  refusedAt(() => wire.checkRedact({ messageId: E }), 'redact.redacted');
  assert.deepEqual(wire.checkMe({ me: member }), { me: member });
  assert.deepEqual(wire.checkMemberAnswer({ member }), { member });
  assert.deepEqual(wire.checkTicket({ ticket: 'abc.def', expiresAt: 5, protocol: 'rukoo.workspace.v1' }).protocol, 'rukoo.workspace.v1');
});

// ---- IPC arguments ----

// Every method of contract 4.4, and chatDraft (desktop-ui), which Undo of Discard reads a room's kept draft with.
const METHODS = [
  'chatState', 'chatSelect', 'chatView', 'chatSync', 'chatReload', 'chatOpen', 'chatClose', 'chatOlder', 'chatThread',
  'chatRoomMembers', 'chatRead', 'chatMarkRead', 'chatMute', 'chatSaveDraft', 'chatDraft', 'chatSend', 'chatResend', 'chatDiscard',
  'chatRedact', 'chatCreateWorkspace', 'chatPreviewInvite', 'chatJoin', 'chatTakePendingJoin', 'chatLeaveWorkspace',
  'chatDeleteWorkspace', 'chatSetMyName', 'chatSetRole', 'chatRemoveMember', 'chatInvites', 'chatCreateInvite',
  'chatWithdrawInvite', 'chatCreateChannel', 'chatRenameChannel', 'chatArchiveChannel', 'chatJoinChannel',
  'chatAddToChannel', 'chatSetChannelRole', 'chatRemoveFromChannel', 'chatLeaveChannel', 'chatStartDm', 'chatLeaveDm',
  'chatBlock', 'chatUnblock'
];

const zoe = vectors.mentions.find((c) => c.text.includes('Zoë') && c.bytes.length === 1);
const link = `https://rukoo.io/join#w=${W}&i=${SECRET}`;

// For each method: a call that passes with what it comes out as, and calls that fail with the field they name.
const CALLS = {
  chatState: { ok: [[[], []]], bad: [] },
  chatSelect: { ok: [[[W], [W]], [[null], [null]]], bad: [[[C], 'ws'], [['w_x'], 'ws']] },
  chatView: { ok: [[[W], [W]]], bad: [[[undefined], 'ws']] },
  chatSync: { ok: [[[], [null]], [[W], [W]]], bad: [[[42], 'ws']] },
  chatReload: { ok: [[[W], [W]]], bad: [[[null], 'ws']] },
  chatOpen: { ok: [[[W, C], [W, C, {}]], [[W, C, { at: 12 }], [W, C, { at: 12 }]]], bad: [[[W, W], 'conversation'], [[W, C, { at: 0 }], 'at'], [[W, C, 'x'], 'opts']] },
  chatClose: { ok: [[[], []]], bad: [] },
  chatOlder: { ok: [[[W, C, 1], [W, C, 1]]], bad: [[[W, C, 0], 'before'], [[W, C, '5'], 'before']] },
  chatThread: { ok: [[[W, C, E], [W, C, E]]], bad: [[[W, C, null], 'root'], [[W, C, C], 'root']] },
  chatRoomMembers: { ok: [[[W, C], [W, C]]], bad: [[[W, 'c_'], 'conversation']] },
  chatRead: { ok: [[[W, C, 0], [W, C, 0]], [[W, C, 99], [W, C, 99]]], bad: [[[W, C, -1], 'seq'], [[W, C, 1.5], 'seq']] },
  chatMarkRead: { ok: [[[W, C], [W, C]]], bad: [[[U, C], 'ws']] },
  chatMute: { ok: [[[W, C, true], [W, C, true]]], bad: [[[W, C, 1], 'muted']] },
  chatSaveDraft: {
    ok: [
      [[W, C, null, { text: zoe.text, mentions: zoe.bytes }], [W, C, null, { text: zoe.text, mentions: zoe.bytes }]],
      [[W, C, E, { text: '' }], [W, C, E, { text: '', mentions: [] }]],
      [[W, C, null, null], [W, C, null, null]]
    ],
    bad: [[[W, C, 'e_x', null], 'root'], [[W, C, null, { text: 5 }], 'text'], [[W, C, null, { text: zoe.text, mentions: zoe.utf16 }], 'mentions'], [[W, C, null, 'draft'], 'draft']]
  },
  chatDraft: { ok: [[[W, C, null], [W, C, null]], [[W, C, E], [W, C, E]], [[W, C], [W, C, null]]], bad: [[[W, C, 'e_x'], 'root'], [[W, E, null], 'conversation']] },
  chatSend: {
    ok: [
      [[W, C, { text: zoe.text, mentions: zoe.bytes, root: null }], [W, C, { text: zoe.text, mentions: zoe.bytes, root: null }]],
      [[W, C, { text: 'Hoi', root: E }], [W, C, { text: 'Hoi', mentions: [], root: E }]]
    ],
    bad: [
      [[W, C, { text: '' }], 'text'],
      [[W, C, { text: ' \n ' }], 'text'],
      [[W, C, { text: 'é'.repeat(8193) }], 'text'],
      [[W, C, { text: '\ud83d' }], 'text'],
      [[W, C, { text: zoe.text, mentions: zoe.utf16 }], 'mentions'],
      [[W, C, { text: 'x'.repeat(40), mentions: Array.from({ length: 33 }, (_, i) => ({ actor: U, start: i, end: i + 1 })) }], 'mentions'],
      [[W, C, { text: 'Hoi', root: C }], 'root'],
      [[W, C, 'Hoi'], 'input']
    ]
  },
  chatResend: { ok: [[[LOCAL, { mode: 'withoutMentions' }], [LOCAL, { mode: 'withoutMentions' }]]], bad: [[[LOCAL + 'x', { mode: 'send' }], 'local'], [[LOCAL, { mode: 'new' }], 'mode'], [[LOCAL], 'opts']] },
  chatDiscard: { ok: [[[LOCAL], [LOCAL]]], bad: [[['local'], 'local']] },
  chatRedact: { ok: [[[W, C, E], [W, C, E]]], bad: [[[W, C, U], 'message']] },
  chatCreateWorkspace: {
    ok: [[[{ name: '  Rukoo team ', displayName: 'Zoë' }], [{ name: 'Rukoo team', displayName: 'Zoë' }]]],
    bad: [[[{ name: '', displayName: 'Zoë' }], 'name'], [[{ name: 'Team', displayName: 'a\nb' }], 'displayName'], [[{ name: 'x'.repeat(81), displayName: 'Zoë' }], 'name'], [[{ name: 'a‮b', displayName: 'Zoë' }], 'name'], [[null], 'input']]
  },
  chatPreviewInvite: { ok: [[[link], [link]]], bad: [[[''], 'link'], [['x'.repeat(2001)], 'link'], [[{}], 'link']] },
  chatJoin: { ok: [[[{ link, name: ' Joël ' }], [{ link, name: 'Joël' }]]], bad: [[[{ link: '', name: 'Joël' }], 'link'], [[{ link, name: '' }], 'name']] },
  chatTakePendingJoin: { ok: [[[], []]], bad: [] },
  chatLeaveWorkspace: { ok: [[[W], [W]]], bad: [[[C], 'ws']] },
  chatDeleteWorkspace: { ok: [[[W], [W]]], bad: [[[C], 'ws']] },
  chatSetMyName: { ok: [[[W, ' Mila '], [W, 'Mila']]], bad: [[[W, '   '], 'name']] },
  chatSetRole: { ok: [[[W, U, 'guest'], [W, U, 'guest']]], bad: [[[W, U, 'manager'], 'role'], [[W, C, 'member'], 'member']] },
  chatRemoveMember: { ok: [[[W, U], [W, U]]], bad: [[[W, 'me'], 'member']] },
  chatInvites: { ok: [[[W], [W]]], bad: [[[null], 'ws']] },
  chatCreateInvite: {
    ok: [
      [[W, { role: 'member' }], [W, { role: 'member', channels: [], expiresIn: 86400 }]],
      [[W, { role: 'guest', channels: [C], expiresIn: 604800 }], [W, { role: 'guest', channels: [C], expiresIn: 604800 }]]
    ],
    bad: [
      [[W, { role: 'guest', channels: [] }], 'channels'],
      [[W, { role: 'admin' }], 'role'],
      [[W, { role: 'member', expiresIn: 3600 }], 'expiresIn'],
      [[W, { role: 'member', channels: [C, C] }], 'channels'],
      [[W, { role: 'member', channels: Array.from({ length: 21 }, (_, i) => id('c', `i${i}`)) }], 'channels'],
      [[W, { role: 'member', channels: [U] }], 'channels']
    ]
  },
  chatWithdrawInvite: { ok: [[[W, I], [W, I]]], bad: [[[W, SECRET], 'invite']] },
  chatCreateChannel: { ok: [[[W, { name: ' Plans ', visibility: 'private' }], [W, { name: 'Plans', visibility: 'private' }]]], bad: [[[W, { name: 'Plans', visibility: 'dm' }], 'visibility'], [[W, { visibility: 'workspace' }], 'name']] },
  chatRenameChannel: { ok: [[[W, C, 'Plannen'], [W, C, 'Plannen']]], bad: [[[W, C, ''], 'name']] },
  chatArchiveChannel: { ok: [[[W, C], [W, C]]], bad: [[[W, E], 'conversation']] },
  chatJoinChannel: { ok: [[[W, C], [W, C]]], bad: [[[W, E], 'conversation']] },
  chatAddToChannel: { ok: [[[W, C, U], [W, C, U]]], bad: [[[W, C, W], 'member']] },
  chatSetChannelRole: { ok: [[[W, C, U, 'manager'], [W, C, U, 'manager']]], bad: [[[W, C, U, 'admin'], 'role']] },
  chatRemoveFromChannel: { ok: [[[W, C, U], [W, C, U]]], bad: [[[W, C, 'u_'], 'member']] },
  chatLeaveChannel: { ok: [[[W, C, null], [W, C, null]], [[W, C, U2], [W, C, U2]], [[W, C], [W, C, null]]], bad: [[[W, C, 'me'], 'successor']] },
  chatStartDm: {
    ok: [[[W, [U, U2]], [W, [U, U2]]]],
    bad: [[[W, []], 'members'], [[W, [U, U]], 'members'], [[W, Array.from({ length: 8 }, (_, i) => id('u', `m${i}`))], 'members'], [[W, [C]], 'members'], [[W, U], 'members']]
  },
  chatLeaveDm: { ok: [[[W, D], [W, D]]], bad: [[[W, null], 'conversation']] },
  chatBlock: { ok: [[[W, U2], [W, U2]]], bad: [[[W, null], 'member']] },
  chatUnblock: { ok: [[[W, U2], [W, U2]]], bad: [[[W, E], 'member']] }
};

test('every IPC method of the contract has an argument check, and nothing else does', () => {
  assert.deepEqual(Object.keys(wire.ARGS).sort(), [...METHODS].sort());
  assert.deepEqual(Object.keys(CALLS).sort(), [...METHODS].sort());
  invalidField(() => wire.checkArgs('chatDelete', []), 'method');
  invalidField(() => wire.checkArgs('toString', []), 'method');
});

test('every IPC method passes good arguments through and refuses bad ones by field', () => {
  for (const method of METHODS) {
    for (const [args, expected] of CALLS[method].ok) assert.deepEqual(wire.checkArgs(method, args), expected, `${method}(${JSON.stringify(args)})`);
    for (const [args, field] of CALLS[method].bad) {
      assert.throws(() => wire.checkArgs(method, args), (err) => {
        assert.ok(err instanceof ChatError, `${method}: ${err && err.stack}`);
        assert.equal(err.code, 'invalid', method);
        assert.equal(err.field, field, `${method}(${JSON.stringify(args).slice(0, 80)})`);
        return true;
      });
    }
    // Every method that takes a workspace refuses a missing one; chatSelect and chatSync take null for none.
    if (CALLS[method].ok[0][0][0] === W && !['chatSelect', 'chatSync'].includes(method)) invalidField(() => wire.checkArgs(method, []), 'ws');
  }
});

test('names are trimmed and checked by code points, as the server counts them', () => {
  assert.equal(wire.input.name('👩‍👩‍👧'.repeat(10)), '👩‍👩‍👧'.repeat(10), 'ZWJ emoji are several code points each, within 80');
  assert.equal(wire.input.name('😀'.repeat(80)), '😀'.repeat(80), '80 astral characters are 160 UTF-16 units');
  invalidField(() => wire.input.name('😀'.repeat(81)), 'name');
  invalidField(() => wire.input.name('a b'), 'name');
  invalidField(() => wire.input.name('tab\there'), 'name');
});

// ---- errors ----

// Every code of contract 3.15, with the details that pick its key.
const ERRORS = [
  ['network', 0, {}, 'chat.errors.network'],
  ['signed_out', 0, {}, 'chat.errors.signedOut'],
  ['upgrade_required', 426, {}, 'chat.errors.upgrade'],
  ['rate_limited', 429, { retryAfter: 7 }, 'chat.errors.rateLimited'],
  ['rate_limited', 429, { retryAfter: 3600, limit: 'dailyDms' }, 'chat.errors.dailyDms'],
  ['not_found', 404, { scope: 'workspace' }, 'chat.errors.goneWorkspace'],
  ['not_found', 404, { scope: 'conversation' }, 'chat.errors.goneConversation'],
  ['not_found', 404, {}, 'chat.errors.notFound'],
  ['forbidden', 403, {}, 'chat.errors.forbidden'],
  ['cosign_required', 403, {}, 'chat.channel.addGuestNeedsAdmin'],
  ['workspace_limit', 403, {}, 'chat.errors.workspaceLimit'],
  ['workspaces_full', 403, {}, 'chat.errors.workspacesFull'],
  ['workspace_account_scope', 403, {}, 'chat.errors.accountScope'],
  ['dm_unavailable', 403, { field: 'members' }, 'chat.errors.dmUnavailable'],
  ['blocked', 409, { member: U2 }, 'chat.errors.blocked'],
  ['name_taken', 409, {}, 'chat.errors.nameTaken'],
  ['last_owner', 409, {}, 'chat.errors.lastOwner'],
  ['last_manager', 409, { channels: [C, D] }, 'chat.errors.lastManager'],
  ['members_remain', 409, {}, 'chat.errors.membersRemain'],
  ['archived', 409, { scope: 'conversation' }, 'chat.errors.archived'],
  ['invite_gone', 410, {}, 'chat.errors.inviteGone'],
  ['quota', 413, { limit: 'members' }, 'chat.errors.quotaMembers'],
  ['quota', 413, { limit: 'conversations' }, 'chat.errors.quotaConversations'],
  ['quota', 413, { limit: 'invites' }, 'chat.errors.quotaInvites'],
  ['quota', 413, { limit: 'bytes' }, 'chat.errors.quotaBytes'],
  ['quota', 413, {}, 'chat.errors.quota'],
  ['invalid', 400, { field: 'name' }, 'chat.errors.invalidName'],
  ['invalid', 400, { field: 'displayName' }, 'chat.errors.invalidName'],
  ['invalid', 400, { field: 'text' }, 'chat.errors.invalid'],
  ['server', 500, {}, 'chat.errors.failed']
];

test('chatError keeps every server code of the contract with its details and picks its text key', () => {
  for (const [code, status, details, key] of ERRORS) {
    const err = wire.chatError(new AccountError(code, status, 'server words', details));
    assert.ok(err instanceof ChatError, code);
    assert.equal(err.chat, true);
    assert.equal(err.code, code);
    assert.equal(err.status, status);
    assert.equal(wire.errorKey(err.code, err), key, `${code} ${JSON.stringify(details)}`);
    for (const k of ['field', 'scope', 'retryAfter', 'member', 'limit']) assert.equal(err[k], details[k] ?? null, `${code}.${k}`);
    assert.deepEqual(err.channels, details.channels ?? null);
    assert.equal(err.message, i18n.t(key, { count: details.retryAfter ?? 1, host: '…', workspace: '…', name: '…' }), code);
  }
});

test('chatError maps transport failures, a 401, unknown codes and other errors', () => {
  assert.equal(wire.chatError(new AccountError('network', 0, 'ECONNREFUSED')).code, 'network');
  assert.equal(wire.chatError(new AccountError('unauthorized', 401, '', { scope: 'account' })).code, 'signed_out');
  assert.equal(wire.chatError(new AccountError('signed_out', 0)).code, 'signed_out');
  assert.equal(wire.chatError(new AccountError('too_large', 200)).code, 'server');
  assert.equal(wire.chatError(new AccountError('teapot', 418)).code, 'server');
  assert.equal(wire.chatError(new TypeError('boom')).code, 'server');
  assert.equal(wire.chatError(null).code, 'server');
  const own = new ChatError('paused', { workspace: 'Rukoo team' });
  assert.equal(wire.chatError(own), own);
  assert.equal(own.message, i18n.t('chat.errors.paused', { workspace: 'Rukoo team' }));
  // The outcomes the engines handle keep their code, so the outbox and the sync engine can act on them.
  for (const code of ['operation_conflict', 'submission_expired', 'stale_grant', 'stale_generation', 'history_regressed', 'reset_required']) {
    const err = wire.chatError(new AccountError(code, code === 'reset_required' ? 410 : 409));
    assert.equal(err.code, code);
    assert.ok(wire.isInternal(code));
  }
  assert.ok(!wire.isInternal('archived'));
});

test('chatError keeps only details of the right shape', () => {
  const err = wire.chatError(
    new AccountError('last_manager', 409, '', {
      field: 'x'.repeat(300),
      scope: 'galaxy',
      retryAfter: 99999,
      channels: [C, 'nope', ...Array.from({ length: 120 }, (_, i) => id('c', `m${i}`))],
      member: 'u_bad',
      limit: 'everything'
    })
  );
  assert.equal(err.field.length, 200);
  assert.equal(err.scope, null);
  assert.equal(err.retryAfter, 3600);
  assert.equal(err.channels.length, 100);
  assert.equal(err.channels[0], C);
  assert.ok(!err.channels.includes('nope'));
  assert.equal(err.member, null);
  assert.equal(err.limit, null);
});

test('error texts come from the catalog in the interface language, with the codes of the app itself', () => {
  try {
    i18n.setLanguage('nl');
    assert.equal(new ChatError('not_saved').message, i18n.t('chat.errors.notSaved'));
    assert.equal(new ChatError('bad_link').message, i18n.t('chat.join.badLink'));
    assert.equal(new ChatError('network', { host: 'rukoo.io' }).message, i18n.t('chat.errors.network', { host: 'rukoo.io' }));
    assert.equal(new ChatError('rate_limited', { retryAfter: 3 }).message, i18n.t('chat.errors.rateLimited', { count: 3 }));
    assert.equal(new ChatError('blocked', { name: 'Joël' }).message, i18n.t('chat.errors.blocked', { name: 'Joël' }));
    assert.equal(new ChatError('other_server', { host: 'example.net', own: 'rukoo.io' }).message, i18n.t('chat.join.otherHost', { host: 'example.net', own: 'rukoo.io' }));
  } finally {
    i18n.setLanguage('en');
  }
  assert.equal(new ChatError('not a code').code, 'server');
});

// ---- shapes for the renderer ----

test('toRenderer, toRoom and toPending give the shapes of contract 4.6', () => {
  const at = 1763550000000;
  assert.deepEqual(
    wire.toRenderer({ ws: W, room: C, seq: 3, id: E, kind: 'message.posted', actor: U, at, root: null, text: zoe.text, mentions: JSON.stringify(zoe.bytes), data: null, redacted: 0 }),
    { seq: 3, id: E, kind: 'message.posted', actor: U, at, root: null, text: zoe.text, mentions: zoe.bytes, redacted: false, data: {} }
  );
  assert.deepEqual(
    wire.toRenderer({ seq: 4, id: E2, kind: 'message.posted', actor: U, at, root: E, text: null, mentions: null, data: null, redacted: 1 }),
    { seq: 4, id: E2, kind: 'message.posted', actor: U, at, root: E, text: null, mentions: [], redacted: true, data: {} }
  );
  assert.deepEqual(
    wire.toRenderer({ seq: 5, id: E2, kind: 'message.redacted', actor: U, at, root: null, text: null, mentions: null, data: JSON.stringify({ target: E, targetSeq: 3, other: 1 }), redacted: 0 }).data,
    { target: E, targetSeq: 3 }
  );
  const row = {
    ws: W, id: D, kind: 'dm', name: null, visibility: 'dm', archived: 0, closedReason: null, participants: JSON.stringify([U, U2]), startedBy: U,
    grantId: G, role: 'member', members: 2, head: 9, floor: 1, lastAt: at, read: 5, readLocal: 7, readSent: 5, unread: 2, mentions: 1,
    lo: 1, hi: 9, notified: 0, muted: 0
  };
  assert.deepEqual(wire.toRoom(row), {
    id: D, kind: 'dm', name: null, visibility: 'dm', archived: false, closedReason: null, participants: [U, U2], startedBy: U,
    role: 'member', members: 2, head: 9, floor: 1, lastAt: at, read: 7, unread: 2, mentions: 1, attention: 2, muted: false, hasCache: true
  });
  assert.equal(wire.toRoom({ ...row, kind: 'channel', name: 'general', visibility: 'workspace', participants: null }).attention, 1);
  assert.equal(wire.toRoom({ ...row, muted: 1 }).attention, 0);
  assert.equal(wire.toRoom({ ...row, lo: null, hi: null }).hasCache, false);
  const pending = { local: LOCAL, ws: W, room: C, actor: U, grantId: G, generation: GENERATION, text: 'Hoi', mentions: '[]', root: null, operationId: null, state: 'queued', reason: null, attempts: 0, nextAt: 0, createdAt: at };
  assert.deepEqual(wire.toPending(pending), { local: LOCAL, ws: W, conversation: C, root: null, text: 'Hoi', mentions: [], state: 'queued', reason: null, nextAt: 0, createdAt: at });
  assert.equal(wire.toPending(pending, { waiting: true }).state, 'waiting');
  assert.equal(wire.toPending({ ...pending, state: 'held', reason: 'stale_grant' }, { waiting: true }).state, 'held');
});
