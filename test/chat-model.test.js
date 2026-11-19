'use strict';

// Team chat as rows and labels (src/renderer/chat-model.js): the timeline's grouping, reply rows and thread
// summaries, the New divider, pending sends, the sidebar's order and badges, direct message titles and who may
// remove a message. chat-view.js draws these rows and is covered by the Electron specs.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const i18n = require('../src/i18n');

// A browser module in a CommonJS package: Node takes it as ESM from a data: URL, with each renderer module it
// imports turned into a data: URL of its own.
function moduleUrl(file) {
  const source = fs
    .readFileSync(path.join(__dirname, '../src/renderer', file), 'utf8')
    .replace(/from '\.\/([\w-]+\.js)'/g, (_, dep) => `from '${moduleUrl(dep)}'`);
  return `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
}
const loading = import(moduleUrl('chat-model.js'));

const id = (prefix, label) => `${prefix}_${label.padEnd(22, 'x')}`;
const ME = id('u', 'me');
const SANNE = id('u', 'sanne');
const MILA = id('u', 'mila');
const OLGA = id('u', 'olga');
const PIM = id('u', 'pim');
const ROB = id('u', 'rob');
const members = new Map(
  [
    { id: ME, name: 'Demo User', role: 'member', state: 'active' },
    { id: SANNE, name: 'Sanne de Vries', role: 'member', state: 'active' },
    { id: MILA, name: 'Mila Jansen', role: 'guest', state: 'active' },
    { id: OLGA, name: 'Olga Bakker', role: 'member', state: 'left' },
    { id: PIM, name: 'Pim', role: 'member', state: 'deleted' },
    { id: ROB, name: 'Rob', role: 'admin', state: 'active' }
  ].map((m) => [m.id, { kind: 'person', joinedAt: 0, ...m }])
);

// Local times, so day dividers fall where a person in this time zone sees them.
const T0 = new Date(2026, 10, 19, 14, 0, 0).getTime();
const MIN = 60 * 1000;
const NOW = new Date(2026, 10, 19, 18, 0, 0).getTime();

let seqs = 0;
const msg = (actor, at, extra = {}) => {
  const seq = extra.seq ?? ++seqs;
  return { seq, id: id('e', `m${seq}`), kind: 'message.posted', actor, at, root: null, text: `message ${seq}`, mentions: [], redacted: false, data: {}, ...extra };
};
const sys = (kind, actor, at, data = {}, extra = {}) => {
  const seq = extra.seq ?? ++seqs;
  return { seq, id: id('e', `s${seq}`), kind, actor, at, root: null, text: null, mentions: [], redacted: false, data };
};
const base = { me: ME, members, floor: 1, hasOlder: true, now: NOW };
const shape = (rows) => rows.map((r) => (r.type === 'msg' || r.type === 'reply' ? `${r.type}${r.head ? '+' : '-'}${r.seq ?? r.key}` : r.type));

test('a group continues for the same author within 5 minutes and breaks on everything else', async () => {
  const { timeline } = await loading;
  seqs = 0;
  const a = msg(SANNE, T0);
  const b = msg(SANNE, T0 + 4 * MIN + 59 * 1000);
  const c = msg(SANNE, T0 + 9 * MIN + 59 * 1000 + 1001); // 5 minutes 1 second after b
  const d = msg(MILA, T0 + 10 * MIN);
  const e = msg(MILA, T0 + 11 * MIN, { redacted: true, text: null });
  const f = msg(MILA, T0 + 12 * MIN);
  const g = sys('channel.renamed', ROB, T0 + 13 * MIN, { name: 'design' });
  const h = msg(MILA, T0 + 14 * MIN);
  const i = msg(MILA, new Date(2026, 10, 20, 0, 1).getTime());
  assert.deepEqual(shape(timeline([a, b, c, d, e, f, g, h, i], base)), [
    'day',
    'msg+1',
    'msg-2',
    'msg+3',
    'msg+4',
    'msg+5',
    'msg+6',
    'sys',
    'msg+8',
    'day',
    'msg+9'
  ]);
  const exactly = timeline([msg(SANNE, T0, { seq: 1 }), msg(SANNE, T0 + 5 * MIN, { seq: 2 })], base);
  assert.equal(exactly.at(-1).head, true, 'exactly 5 minutes is not less than 5 minutes');
  const wider = timeline([msg(SANNE, T0, { seq: 1 }), msg(SANNE, T0 + 8 * MIN, { seq: 2 })], { ...base, groupMs: 10 * MIN });
  assert.equal(wider.at(-1).head, false, 'groupMs sets the gap');
});

test('the New divider goes before the first message by someone else after the read position at open', async () => {
  const { timeline } = await loading;
  seqs = 0;
  const events = [msg(SANNE, T0), msg(ME, T0 + MIN), sys('member.joined', ROB, T0 + 2 * MIN, { member: ROB }), msg(SANNE, T0 + 3 * MIN), msg(SANNE, T0 + 4 * MIN)];
  const rows = timeline(events, { ...base, readAtOpen: 1 });
  assert.deepEqual(shape(rows), ['day', 'msg+1', 'msg+2', 'sys', 'new', 'msg+4', 'msg-5'], 'your own message and a system row never place it');
  assert.equal(rows.filter((r) => r.type === 'new').length, 1);
  assert.ok(!timeline(events, { ...base, readAtOpen: 5 }).some((r) => r.type === 'new'), 'nothing unread');
  assert.ok(!timeline(events, { ...base, readAtOpen: null }).some((r) => r.type === 'new'), 'no read position');
  const reply = msg(MILA, T0 + 5 * MIN, { root: events[0].id });
  assert.deepEqual(shape(timeline([...events, reply], { ...base, readAtOpen: 5 })), ['day', 'msg+1', 'msg+2', 'sys', 'msg+4', 'msg-5', 'new', 'reply+6'], 'a reply places it too');
  assert.ok(!timeline([...events, reply], { ...base, readAtOpen: 1, root: events[0].id }).some((r) => r.type === 'new'), 'a thread has none');
  const split = timeline([msg(SANNE, T0, { seq: 1 }), msg(SANNE, T0 + MIN, { seq: 2 })], { ...base, readAtOpen: 1 });
  assert.equal(split.at(-1).head, true, 'the divider breaks a group');
});

test('replies show in the main timeline as reply rows with the context of their root', async () => {
  const { timeline } = await loading;
  seqs = 0;
  const root = msg(SANNE, T0, { text: 'Can   someone\nlook at the draft?' });
  const gone = msg(MILA, T0 + MIN, { redacted: true, text: null });
  const top = msg(ME, T0 + 2 * MIN);
  const r1 = msg(ROB, T0 + 3 * MIN, { root: root.id });
  const r2 = msg(ROB, T0 + 4 * MIN, { root: root.id });
  const r3 = msg(ROB, T0 + 5 * MIN, { root: gone.id });
  const r4 = msg(ROB, T0 + 6 * MIN, { root: id('e', 'uncached') });
  const r5 = msg(ROB, T0 + 7 * MIN);
  const rows = timeline([root, gone, top, r1, r2, r3, r4, r5], base);
  assert.deepEqual(shape(rows), ['day', 'msg+1', 'msg+2', 'msg+3', 'reply+4', 'reply-5', 'reply+6', 'reply+7', 'msg+8']);
  const byS = Object.fromEntries(rows.filter((r) => r.seq).map((r) => [r.seq, r]));
  assert.deepEqual(byS[4].context, { state: 'ok', root: root.id, actor: SANNE, author: members.get(SANNE), text: 'Can someone look at the draft?' });
  assert.deepEqual(byS[6].context, { state: 'removed', root: gone.id });
  assert.deepEqual(byS[7].context, { state: 'missing', root: r4.root }, 'a root that is not cached');
  assert.equal(byS[7].head, true, 'replies by one author to two different roots are two groups');
  assert.equal(byS[5].head, false, 'replies by one author to the same root group, with the context line once');
  assert.equal(byS[8].head, true, 'a top-level message after replies starts a group');
  const long = msg(SANNE, T0, { seq: 1, text: 'x'.repeat(200) });
  const ctx = timeline([long, msg(ROB, T0 + MIN, { seq: 2, root: long.id })], base).at(-1).context.text;
  assert.equal(ctx, `${'x'.repeat(120)}…`, 'the context line quotes the start of the root');
});

test('a root carries the summary of its cached replies, with newest against the read position at open', async () => {
  const { timeline, replyCounts } = await loading;
  seqs = 0;
  const root = msg(SANNE, T0);
  const replies = [
    msg(MILA, T0 + MIN, { root: root.id }),
    msg(ROB, T0 + 2 * MIN, { root: root.id }),
    msg(MILA, T0 + 3 * MIN, { root: root.id }),
    msg(SANNE, T0 + 4 * MIN, { root: root.id }),
    msg(ME, T0 + 5 * MIN, { root: root.id, redacted: true, text: null })
  ];
  const counts = replyCounts([root, ...replies].reverse());
  assert.deepEqual(counts.get(root.id), { count: 5, lastAt: T0 + 5 * MIN, newest: 6, newestOther: 6, actors: [SANNE, MILA, ROB] }, 'the latest three distinct authors, the latest first, without removed replies');
  assert.equal(replyCounts(replies, { me: ME }).get(root.id).newestOther, 5, 'newestOther skips your own replies');
  const head = timeline([root, ...replies], { ...base, readAtOpen: 4 }).find((r) => r.seq === 1);
  assert.deepEqual(head.replies, { count: 5, lastAt: T0 + 5 * MIN, newest: 6, newestOther: 5, actors: [SANNE, MILA, ROB], hasNew: true });
  assert.equal(timeline([root, ...replies], { ...base, readAtOpen: 5 }).find((r) => r.seq === 1).replies.hasNew, false, 'your own reply after the read position is not new to you');
  assert.equal(timeline([root, ...replies], { ...base, readAtOpen: 6 }).find((r) => r.seq === 1).replies.hasNew, false);
  assert.equal(timeline([root], base).find((r) => r.seq === 1).replies, null, 'no replies, no summary');
  const removed = timeline([{ ...root, redacted: true, text: null }, ...replies], base).find((r) => r.seq === 1);
  assert.equal(removed.removed, true);
  assert.equal(removed.replies.count, 5, 'a removed root keeps its summary');
});

test('a thread holds its root and its replies, the root as a group head', async () => {
  const { timeline } = await loading;
  seqs = 0;
  const root = msg(SANNE, T0);
  const other = msg(SANNE, T0 + MIN);
  const r1 = msg(SANNE, T0 + 2 * MIN, { root: root.id });
  const r2 = msg(SANNE, T0 + 3 * MIN, { root: root.id });
  const r3 = msg(MILA, T0 + 4 * MIN, { root: other.id });
  const pending = [
    { local: 'p-main', root: null, text: 'main', mentions: [], state: 'queued', reason: null, createdAt: T0 + 6 * MIN },
    { local: 'p-thread', root: root.id, text: 'in thread', mentions: [], state: 'sending', reason: null, createdAt: T0 + 5 * MIN }
  ];
  const rows = timeline([root, other, r1, r2, r3], { ...base, hasOlder: false, root: root.id, pending, readAtOpen: 0 });
  assert.deepEqual(shape(rows), ['day', 'msg+1', 'msg+3', 'msg-4', 'msg+local:p-thread']);
  assert.equal(rows[1].replies.count, 2);
  assert.ok(!rows.some((r) => r.type === 'intro' || r.type === 'floor'), 'a thread has no intro or floor');
});

test('pending sends come after the sent rows in the order they were written, and keep their key once sent', async () => {
  const { timeline } = await loading;
  seqs = 0;
  const a = msg(ME, T0);
  const b = msg(SANNE, T0 + MIN);
  const pending = [
    { local: 'L2', root: null, text: 'second', mentions: [], state: 'queued', reason: null, nextAt: 0, createdAt: T0 + 3 * MIN },
    { local: 'L1', root: null, text: 'first', mentions: [], state: 'failed', reason: 'quota', nextAt: 0, createdAt: T0 + 2 * MIN },
    { local: 'L3', root: a.id, text: 'a reply', mentions: [], state: 'held', reason: 'stale_grant', nextAt: 0, createdAt: T0 + 4 * MIN }
  ];
  const rows = timeline([b, a], { ...base, pending });
  assert.deepEqual(shape(rows), ['day', 'msg+1', 'msg+2', 'msg+local:L1', 'msg-local:L2', 'reply+local:L3']);
  const l1 = rows.find((r) => r.key === 'local:L1');
  assert.deepEqual([l1.actor, l1.pending, l1.reason, l1.seq, l1.local, l1.text], [ME, 'failed', 'quota', null, 'L1', 'first']);
  const l2 = rows.find((r) => r.key === 'local:L2');
  const retried = timeline([b, a], { ...base, pending: pending.map((p) => (p.local === 'L2' ? { ...p, nextAt: T0 + 10 * MIN } : p)) });
  const l2b = retried.find((r) => r.key === 'local:L2');
  assert.equal(l2b.nextAt, T0 + 10 * MIN);
  assert.notEqual(l2b.sig, l2.sig, 'a queued send whose retry time moved redraws');
  assert.equal(retried.find((r) => r.key === 'local:L1').sig, l1.sig, 'and nothing else');

  // L1 commits with a seq below a message that arrived meanwhile: its row is placed by seq and keeps its key.
  const c = msg(SANNE, T0 + 2 * MIN + 30 * 1000, { seq: 3 });
  const sent = msg(ME, T0 + 2 * MIN + 40 * 1000, { seq: 4, text: 'first' });
  const later = msg(SANNE, T0 + 5 * MIN, { seq: 5 });
  const after = timeline([a, b, c, sent, later], { ...base, pending, sentLocal: new Map([[sent.id, 'L1']]) });
  assert.deepEqual(shape(after), ['day', 'msg+1', 'msg+2', 'msg-3', 'msg+4', 'msg+5', 'msg+local:L2', 'reply+local:L3']);
  const row = after.find((r) => r.key === 'local:L1');
  assert.equal(after.indexOf(row), 4, 'the sent row sits by its seq');
  assert.equal(after.filter((r) => r.local === 'L1').length, 1, 'and its pending row is gone');
  assert.deepEqual([row.seq, row.id, row.pending, row.local], [4, sent.id, null, 'L1']);
  assert.notEqual(row.sig, l1.sig, 'the sent row redraws');
});

test('a removal or an unknown kind on a later day leaves no day divider with nothing under it', async () => {
  const { timeline } = await loading;
  seqs = 0;
  const mon = new Date(2026, 10, 16, 10, 0).getTime();
  const tue = new Date(2026, 10, 17, 10, 0).getTime();
  const wed = new Date(2026, 10, 18, 10, 0).getTime();
  const a = msg(SANNE, mon);
  const b = msg(MILA, mon + MIN);
  const redaction = sys('message.redacted', SANNE, tue, { target: a.id, targetSeq: a.seq });
  const c = msg(SANNE, wed);
  const keys = (rows) => rows.map((r) => (r.type === 'day' ? r.key : r.type));
  assert.deepEqual(keys(timeline([{ ...a, redacted: true, text: null }, b, redaction, c], base)), ['day:2026-11-16', 'msg', 'msg', 'day:2026-11-18', 'msg']);
  const unknown = sys('agent.something', SANNE, tue);
  assert.deepEqual(keys(timeline([a, b, unknown, c], base)), ['day:2026-11-16', 'msg', 'msg', 'day:2026-11-18', 'msg']);
  const today = sys('message.redacted', SANNE, NOW - MIN, { target: a.id, targetSeq: a.seq });
  assert.deepEqual(keys(timeline([a, b, today], base)), ['day:2026-11-16', 'msg', 'msg'], 'the log does not end on an empty Today');
});

test('a pending row never runs the day dividers backwards or repeats a day key', async () => {
  const { timeline } = await loading;
  seqs = 0;
  const late = msg(SANNE, new Date(2026, 10, 17, 23, 58).getTime());
  const early = msg(SANNE, new Date(2026, 10, 18, 0, 1).getTime());
  const behind = { local: 'L', root: null, text: 'x', mentions: [], state: 'sending', reason: null, nextAt: 0, createdAt: new Date(2026, 10, 17, 23, 59).getTime() };
  const rows = timeline([late, early], { ...base, pending: [behind] });
  const keys = rows.map((r) => r.key);
  assert.deepEqual(keys, ['day:2026-11-17', late.id, 'day:2026-11-18', early.id, 'local:L'], 'under the latest day shown');
  assert.equal(new Set(keys).size, keys.length, 'every key once');

  const held = { ...behind, local: 'H', state: 'held', reason: 'stale_grant', createdAt: T0 - 86400000 };
  const two = timeline([msg(SANNE, T0, { seq: 10 })], { ...base, pending: [held, { ...behind, local: 'Q', createdAt: T0 + MIN }] });
  assert.deepEqual(two.map((r) => r.type), ['day', 'msg', 'msg', 'msg'], "a held send from yesterday sits under today's divider");

  const alone = timeline([], { ...base, pending: [held] });
  assert.deepEqual(alone.map((r) => r.type), ['day', 'msg'], 'with nothing sent, a pending row has its own day');
});

test('the intro and the retention floor show only when nothing older can load', async () => {
  const { timeline } = await loading;
  seqs = 0;
  const intro = { createdBy: SANNE, createdAt: T0, kind: 'channel', visibility: 'workspace' };
  const events = [msg(SANNE, T0)];
  assert.deepEqual(shape(timeline(events, { ...base, hasOlder: false, floor: 1, intro })), ['intro', 'day', 'msg+1']);
  assert.equal(timeline(events, { ...base, hasOlder: false, floor: 1, intro })[0].intro, intro);
  assert.deepEqual(shape(timeline(events, { ...base, hasOlder: false, floor: 40 })), ['floor', 'day', 'msg+1']);
  assert.deepEqual(shape(timeline(events, { ...base, hasOlder: true, floor: 1 })), ['day', 'msg+1']);
  assert.deepEqual(shape(timeline([], { ...base, hasOlder: false })), ['intro'], 'an empty conversation');
});

test('system events read by who did them, and removals and unknown kinds show no row', async () => {
  const { timeline } = await loading;
  seqs = 0;
  const events = [
    sys('channel.created', SANNE, T0, { name: 'design', visibility: 'workspace' }),
    sys('member.joined', SANNE, T0, { member: SANNE }),
    sys('member.joined', SANNE, T0, { member: MILA }),
    sys('member.left', MILA, T0, { member: MILA }),
    sys('member.left', ROB, T0, { member: OLGA }),
    sys('channel.renamed', ROB, T0, { name: 'design-team' }),
    sys('channel.archived', ROB, T0),
    sys('dm.started', SANNE, T0, { members: [SANNE, ME] }),
    sys('message.redacted', SANNE, T0, { target: id('e', 'm1'), targetSeq: 1 }),
    sys('agent.something', SANNE, T0)
  ];
  const rows = timeline(events, base).filter((r) => r.type === 'sys');
  assert.deepEqual(
    rows.map((r) => [r.sys, r.actor, r.member, r.name]),
    [
      ['created', SANNE, null, 'design'],
      ['joined', SANNE, SANNE, null],
      ['added', SANNE, MILA, null],
      ['left', MILA, MILA, null],
      ['removedBy', ROB, OLGA, null],
      ['renamed', ROB, null, 'design-team'],
      ['archived', ROB, null, null],
      ['dmStarted', SANNE, null, null]
    ]
  );
  assert.deepEqual(rows.map((r) => r.key), events.slice(0, 8).map((e) => e.id), 'keyed by event ID');
});

test('keys stay and sigs change only for the rows whose look changed', async () => {
  const { timeline } = await loading;
  seqs = 0;
  const root = msg(SANNE, T0, { text: 'Hi @Demo User', mentions: [{ actor: ME, start: 3, end: 13 }] });
  const plain = msg(MILA, T0 + MIN);
  const one = timeline([root, plain], base);
  const again = timeline([plain, root, root], base);
  assert.deepEqual(again.map((r) => [r.key, r.sig]), one.map((r) => [r.key, r.sig]), 'the same input, in any order and with duplicates, gives the same rows');
  assert.equal(one[1].mentionsMe, true);

  const renamed = new Map(members);
  renamed.set(SANNE, { ...members.get(SANNE), name: 'Sanne Visser' });
  const two = timeline([root, plain], { ...base, members: renamed });
  assert.notEqual(two[1].sig, one[1].sig, 'a renamed author redraws their rows');
  assert.equal(two[2].sig, one[2].sig, 'and nothing else');

  const meRenamed = new Map(members);
  meRenamed.set(ME, { ...members.get(ME), name: 'Demo' });
  assert.notEqual(timeline([root, plain], { ...base, members: meRenamed })[1].sig, one[1].sig, 'a renamed mention redraws its tooltip');

  const three = timeline([root, plain, msg(ROB, T0 + 2 * MIN, { root: root.id })], base);
  assert.notEqual(three[1].sig, one[1].sig, 'a new reply redraws the summary');
  assert.equal(three[2].sig, one[2].sig);

  const four = timeline([{ ...root, redacted: true, text: null, mentions: [] }, plain], base);
  assert.notEqual(four[1].sig, one[1].sig, 'a removal redraws');
  assert.equal(four[1].mentionsMe, false);

  const blocked = timeline([root, plain], { ...base, blocked: new Set([SANNE]) });
  assert.equal(blocked[1].mentionsMe, false, 'a mention from someone you blocked is not yours');
  assert.notEqual(blocked[1].sig, one[1].sig);

  assert.equal(one[0].key, timeline([root], { ...base, now: NOW + 86400000 })[0].key, 'a day keeps its key');
  assert.notEqual(one[0].sig, timeline([root], { ...base, now: NOW + 86400000 })[0].sig, 'today becomes yesterday');
});

test('channels sort by name with the collator, DMs by last activity with closed ones last', async () => {
  const { sortRooms } = await loading;
  const channel = (cid, name, extra = {}) => ({ id: id('c', cid), kind: 'channel', name, archived: false, closedReason: null, ...extra });
  const dm = (cid, lastAt, extra = {}) => ({ id: id('c', cid), kind: 'dm', name: null, archived: false, closedReason: null, lastAt, ...extra });
  const rooms = [
    channel('z', 'Zeta'),
    channel('e2', 'Emma'),
    channel('a', 'algemeen'),
    channel('e1', 'Émile'),
    channel('old', 'archief', { archived: true }),
    channel('n10', 'week 10'),
    channel('n9', 'week 9'),
    dm('d1', T0),
    dm('d2', T0 + MIN),
    dm('d3', T0 + 2 * MIN, { closedReason: 'left' }),
    dm('d4', null),
    dm('d5', T0 - MIN, { closedReason: 'ineligible' })
  ];
  const nl = new Intl.Collator('nl', { sensitivity: 'base', numeric: true });
  const { channels, dms } = sortRooms(rooms, nl);
  assert.deepEqual(channels.map((r) => r.name), ['algemeen', 'Émile', 'Emma', 'week 9', 'week 10', 'Zeta'], 'Dutch collation: É next to E, numbers by value');
  assert.deepEqual(dms.map((r) => r.id), ['d2', 'd1', 'd4', 'd3', 'd5'].map((x) => id('c', x)), 'open DMs by lastAt, then closed ones');
  assert.ok(sortRooms(rooms, nl, { open: id('c', 'old') }).channels.some((r) => r.name === 'archief'), 'an archived channel stays while it is open');
  assert.deepEqual(sortRooms(rooms).channels.length, 6, 'a default collator');
});

test('direct message titles name the others with the list format, in English and in Dutch', async () => {
  const { dmTitle } = await loading;
  const en = (key, params) => i18n.translate('en', key, params);
  const nl = (key, params) => i18n.translate('nl', key, params);
  const enList = new Intl.ListFormat('en-GB', { type: 'conjunction' });
  const nlList = new Intl.ListFormat('nl', { type: 'conjunction' });
  const room = (...participants) => ({ kind: 'dm', participants: [ME, ...participants] });
  assert.equal(dmTitle(room(SANNE), members, ME, enList, en), 'Sanne de Vries');
  assert.equal(dmTitle(room(SANNE, MILA), members, ME, enList, en), 'Sanne de Vries and Mila Jansen');
  assert.equal(dmTitle(room(SANNE, MILA, ROB), members, ME, enList, en), 'Sanne de Vries, Mila Jansen and Rob');
  assert.equal(dmTitle(room(SANNE, MILA, ROB, OLGA, PIM), members, ME, enList, en), 'Sanne de Vries, Mila Jansen and 3 others');
  assert.equal(dmTitle(room(SANNE, MILA, ROB, OLGA), members, ME, enList, en), 'Sanne de Vries, Mila Jansen and 2 others');
  assert.equal(dmTitle(room(SANNE, MILA, ROB), members, ME, nlList, nl), 'Sanne de Vries, Mila Jansen en Rob');
  assert.equal(dmTitle(room(SANNE, MILA, ROB, OLGA, PIM), members, ME, nlList, nl), 'Sanne de Vries, Mila Jansen en 3 anderen');
  assert.equal(dmTitle(room(PIM), members, ME, enList, en), 'Deleted member');
  assert.equal(dmTitle(room(PIM, SANNE), members, ME, nlList, nl), 'Verwijderd lid en Sanne de Vries');
  assert.equal(dmTitle(room(OLGA), members, ME, enList, en), 'Olga Bakker', 'a former member keeps their name');
  assert.equal(dmTitle(room(id('u', 'unknown')), [...members.values()], ME, enList, en), 'Former member', 'members as a list, someone not in the directory');
});

test('member names and tags for guests, former and deleted members', async () => {
  const { displayName, memberTag } = await loading;
  const en = (key, params) => i18n.translate('en', key, params);
  const nl = (key, params) => i18n.translate('nl', key, params);
  assert.equal(displayName(members.get(SANNE), en), 'Sanne de Vries');
  assert.equal(displayName(members.get(PIM), en), 'Deleted member');
  assert.equal(displayName(members.get(PIM), nl), 'Verwijderd lid');
  assert.equal(displayName(members.get(OLGA), en), 'Olga Bakker');
  assert.equal(displayName(undefined, en), 'Former member');
  assert.equal(memberTag(members.get(SANNE), en), null);
  assert.equal(memberTag(members.get(MILA), en), 'Guest');
  assert.equal(memberTag(members.get(MILA), nl), 'Gast');
  assert.equal(memberTag(members.get(OLGA), en), 'Former member');
  assert.equal(memberTag({ ...members.get(MILA), state: 'removed' }, nl), 'Voormalig lid');
  assert.equal(memberTag(members.get(PIM), en), null, "a deleted member's name is the tag already");
});

test('authors remove their own messages and channel managers any in their channel', async () => {
  const { canRemove, timeline } = await loading;
  seqs = 0;
  const mine = msg(ME, T0);
  const theirs = msg(SANNE, T0);
  const channel = { kind: 'channel', role: 'member' };
  const managed = { kind: 'channel', role: 'manager' };
  const dm = { kind: 'dm', role: 'manager', closedReason: 'left' };
  assert.equal(canRemove(mine, ME, channel), true, 'the author');
  assert.equal(canRemove(mine, ME, dm), true, 'the author in a closed DM');
  assert.equal(canRemove(theirs, ME, managed), true, 'a channel manager');
  assert.equal(canRemove(theirs, ME, channel), false, 'a member');
  assert.equal(canRemove(theirs, ME, dm), false, 'another participant of a DM');
  assert.equal(canRemove({ ...mine, redacted: true }, ME, channel), false, 'already removed');
  assert.equal(canRemove(sys('channel.renamed', ME, T0), ME, managed), false, 'not a message');
  const rows = timeline([mine], { ...base, pending: [{ local: 'L', root: null, text: 'x', mentions: [], state: 'failed', createdAt: T0 + 1 }] });
  assert.equal(canRemove(rows.find((r) => r.seq === mine.seq), ME, channel), true, 'a timeline row');
  assert.equal(canRemove(rows.find((r) => r.key === 'local:L'), ME, channel), false, 'a pending send');
  assert.equal(canRemove(null, ME, channel), false);
});

test('badges and attention follow unread for DMs, mentions for channels, and go quiet when muted', async () => {
  const { roomBadge, attention, totals, modeBadge } = await loading;
  const dm = { kind: 'dm', unread: 3, mentions: 1, muted: false, closedReason: null };
  const channel = { kind: 'channel', unread: 7, mentions: 2, muted: false };
  const quiet = { kind: 'channel', unread: 4, mentions: 0, muted: false };
  assert.deepEqual(roomBadge(dm), { attention: 3, pill: 3, count: null, bold: true, dim: false });
  assert.deepEqual(roomBadge(channel), { attention: 2, pill: 2, count: null, bold: true, dim: false });
  assert.deepEqual(roomBadge(quiet), { attention: 0, pill: null, count: 4, bold: true, dim: false });
  assert.deepEqual(roomBadge({ ...channel, muted: true }), { attention: 0, pill: null, count: null, bold: false, dim: true });
  assert.deepEqual(roomBadge({ ...dm, muted: true }), { attention: 0, pill: null, count: null, bold: false, dim: true });
  assert.deepEqual(roomBadge({ ...dm, unread: 0, closedReason: 'left' }), { attention: 0, pill: null, count: null, bold: false, dim: true });
  assert.deepEqual(roomBadge({ kind: 'channel', unread: 0, mentions: 0 }), { attention: 0, pill: null, count: null, bold: false, dim: false });
  assert.equal(attention(dm), 3);
  assert.equal(attention(channel), 2);
  assert.equal(attention({ ...dm, muted: true }), 0);
  assert.deepEqual(totals([dm, channel, quiet]), { attention: 5, unread: true });
  assert.deepEqual(totals([{ ...dm, muted: true }, { ...quiet, muted: true }]), { attention: 0, unread: false }, 'muted rooms count for nothing');
  assert.deepEqual(totals([quiet]), { attention: 0, unread: true });
  assert.deepEqual(totals([{ ...dm, unread: 60 }, { ...dm, unread: 70 }]).attention, 100, 'capped at 100');
  assert.deepEqual(modeBadge({ attention: 5, unread: true }), { count: 5, text: '5' });
  assert.deepEqual(modeBadge({ attention: 100, unread: true }), { count: 100, text: '99+' });
  assert.deepEqual(modeBadge({ attention: 0, unread: true }), { dot: true });
  assert.equal(modeBadge({ attention: 0, unread: false }), null);
});
