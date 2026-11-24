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
  assert.deepEqual(byS[4].context, { state: 'ok', root: root.id, actor: SANNE, author: members.get(SANNE), text: 'Can someone look at the draft?', files: 0 });
  assert.deepEqual(byS[6].context, { state: 'removed', root: gone.id });
  assert.deepEqual(byS[7].context, { state: 'missing', root: r4.root }, 'a root that is not cached');
  assert.equal(byS[7].head, true, 'replies by one author to two different roots are two groups');
  assert.equal(byS[5].head, false, 'replies by one author to the same root group, with the context line once');
  assert.equal(byS[8].head, true, 'a top-level message after replies starts a group');
  const long = msg(SANNE, T0, { seq: 1, text: 'x'.repeat(200) });
  const ctx = timeline([long, msg(ROB, T0 + MIN, { seq: 2, root: long.id })], base).at(-1).context.text;
  assert.equal(ctx, `${'x'.repeat(120)}…`, 'the context line quotes the start of the root');
  // Without Markdown markers (RUK-211 contract 3.7), and with the root's files counted for a root without text.
  const marked = msg(SANNE, T0, { seq: 1, text: '**Plan** for _today_:\n- ship it' });
  assert.equal(timeline([marked, msg(ROB, T0 + MIN, { seq: 2, root: marked.id })], base).at(-1).context.text, 'Plan for today: ship it');
  const filesOnly = msg(SANNE, T0, { seq: 1, text: '', attachments: [{ id: id('f', 'a'), name: 'a.pdf', type: 'application/pdf', size: 1 }] });
  const fileCtx = timeline([filesOnly, msg(ROB, T0 + MIN, { seq: 2, root: filesOnly.id })], base).at(-1).context;
  assert.deepEqual([fileCtx.text, fileCtx.files], ['', 1]);
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

// A directory that comes in after the room drew (a first sign-in on a slow server) names the people the intro showed as
// Former member: the intro draws again, as the system rows do.
test("the intro draws again when the directory brings or changes the names of the conversation's maker and people", async () => {
  const { timeline } = await loading;
  seqs = 0;
  const made = sys('channel.created', SANNE, T0, { name: 'design', visibility: 'workspace' });
  const intro = { actor: SANNE, at: T0, people: [], look: ['#design', 'channel', 'workspace', '', 'chat.example', 'Acme'] };
  const opts = { ...base, hasOlder: false, intro };
  const introRow = (o) => timeline([made], o).find((r) => r.type === 'intro');
  const before = introRow({ ...opts, members: new Map() });
  const after = introRow(opts);
  assert.notEqual(after.sig, before.sig, 'the maker came in with the directory');
  assert.equal(introRow(opts).sig, after.sig, 'the same directory keeps the row');
  const renamed = new Map(members);
  renamed.set(SANNE, { ...members.get(SANNE), name: 'Sanne Visser' });
  assert.notEqual(introRow({ ...opts, members: renamed }).sig, after.sig, 'a renamed maker');
  const dm = { ...intro, people: [MILA, ROB] };
  const dmRenamed = new Map(members);
  dmRenamed.set(ROB, { ...members.get(ROB), name: 'Robert' });
  assert.notEqual(introRow({ ...opts, intro: dm, members: dmRenamed }).sig, introRow({ ...opts, intro: dm }).sig, 'a renamed person of a DM');
  const other = new Map(members);
  other.set(PIM, { ...members.get(PIM), name: 'Pim Smit' });
  assert.equal(introRow({ ...opts, intro: dm, members: other }).sig, introRow({ ...opts, intro: dm }).sig, 'someone the intro does not name changes nothing');
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

test('leaving: the only owner, the channels that may need a successor, and who can take one over', async () => {
  const { onlyOwner, sharedManaged, soleManager, successors, handOverReady, SUCCESSOR_SEARCH_FROM } = await loading;
  const en = (key, params) => i18n.translate('en', key, params);
  const owners = new Map([...members].map(([k, m]) => [k, k === ME ? { ...m, role: 'owner' } : m]));
  assert.equal(onlyOwner('owner', ME, owners, false), true);
  assert.equal(onlyOwner('admin', ME, owners, false), false);
  assert.equal(onlyOwner('owner', ME, owners, true), false, "a directory that isn't complete can't vouch for it");
  const twoOwners = new Map(owners).set(ROB, { ...owners.get(ROB), role: 'owner' });
  assert.equal(onlyOwner('owner', ME, twoOwners, false), false);
  const formerOwner = new Map(owners).set(OLGA, { ...owners.get(OLGA), role: 'owner' });
  assert.equal(onlyOwner('owner', ME, formerOwner, false), true, 'someone who left is no owner');
  assert.equal(onlyOwner('owner', ME, new Map(), false), false, "a directory that hasn't loaded yet says nothing");

  const ch = (cid, extra = {}) => ({ id: cid, kind: 'channel', role: 'manager', archived: false, members: 3, ...extra });
  const rooms = [ch('c1'), ch('c2', { members: 1 }), ch('c3', { archived: true }), ch('c4', { role: 'member' }), { id: 'd1', kind: 'dm', role: 'member', members: 2 }];
  assert.deepEqual(sharedManaged(rooms).map((r) => r.id), ['c1']);
  assert.deepEqual(sharedManaged(new Map(rooms.map((r) => [r.id, r])).values()).map((r) => r.id), ['c1']);
  assert.equal(soleManager([{ member: ME, role: 'manager' }, { member: SANNE, role: 'member' }], ME), true);
  assert.equal(soleManager([{ member: ME, role: 'manager' }, { member: SANNE, role: 'manager' }], ME), false);
  assert.equal(soleManager([{ member: ME, role: 'manager' }], ME), false);

  // Active full members other than you, by name: not the guest, not someone who left or was deleted.
  const collator = new Intl.Collator('en', { sensitivity: 'base' });
  assert.deepEqual(successors([ME, SANNE, MILA, OLGA, PIM, ROB, ROB], members, ME, collator, en), [ROB, SANNE]);

  const a = { id: 'c1', people: [SANNE] };
  const b = { id: 'c2', people: [ROB] };
  assert.equal(handOverReady([a, b], {}), false);
  assert.equal(handOverReady([a, b], { c1: SANNE }), false);
  assert.equal(handOverReady([a, b], { c1: SANNE, c2: SANNE }), false, 'a pick from another channel does not count');
  assert.equal(handOverReady([a, b], { c1: SANNE, c2: ROB }), true);
  assert.equal(handOverReady([a, b], new Map([['c1', SANNE], ['c2', ROB]])), true);
  assert.equal(handOverReady([], {}), false);
  assert.equal(SUCCESSOR_SEARCH_FROM, 6);
});

test('leaving a private channel names the agents you made that leave it with you', async () => {
  const { mayTakeAgents, agentsLeavingWith, leavingAgentsText } = await loading;
  const en = (key, params) => i18n.translate('en', key, params);
  const nl = (key, params) => i18n.translate('nl', key, params);
  const lf = (lang) => new Intl.ListFormat(lang, { type: 'conjunction' });
  const collator = new Intl.Collator('en', { sensitivity: 'base' });
  const agent = (label, sponsor, state = 'active') => ({ id: id('u', label), kind: 'agent', name: label, role: 'member', state, joinedAt: 0, agent: { sponsor, answers: 'sponsor', members: [], agents: false } });
  const clark = agent('Clark', ME);
  const bee = agent('Bee', ME);
  const robs = agent('Robbot', ROB);
  const gone = agent('Gone', ME, 'removed');
  const dir = new Map([...members, ...[clark, bee, robs, gone].map((a) => [a.id, a])]);
  const room = { id: 'c1', kind: 'channel', visibility: 'private', role: 'member', archived: false, members: 3, agents: 3 };
  const inside = [ME, SANNE, ROB, clark.id, bee.id, robs.id].map((member) => ({ member, role: 'member' }));

  // As the server's #endGrant: a private channel takes your agents with you, archived or not and also as its last
  // person; any channel takes them as its last person, since that archives it and every agent goes.
  const open = { ...room, visibility: 'workspace' };
  assert.equal(mayTakeAgents(room, dir, ME), true);
  assert.equal(mayTakeAgents(open, dir, ME), false, 'an open channel with others in it keeps them');
  assert.equal(mayTakeAgents({ ...room, members: 1 }, dir, ME), true, 'the last person in a private channel');
  assert.equal(mayTakeAgents({ ...open, members: 1 }, dir, ME), true, 'the last person in an open channel archives it');
  assert.equal(mayTakeAgents({ ...room, archived: true }, dir, ME), true, 'an archived private channel');
  assert.equal(mayTakeAgents({ ...room, archived: true, members: 1 }, dir, ME), true);
  assert.equal(mayTakeAgents({ ...open, archived: true }, dir, ME), false, 'an archived open channel with others in it');
  assert.equal(mayTakeAgents({ ...room, agents: 0 }, dir, ME), false, 'no agents in it');
  assert.equal(mayTakeAgents({ ...room, agents: undefined }, dir, ME), true, 'a row without the count may hold some');
  assert.equal(mayTakeAgents({ ...room, kind: 'dm' }, dir, ME), false);
  assert.equal(mayTakeAgents(room, members, ME), false, 'you made no agent');
  assert.equal(mayTakeAgents(room, dir, SANNE), false);

  // Yours, active and in the channel, by name; not someone else's, not a removed one, not one outside the channel.
  assert.deepEqual(agentsLeavingWith(room, inside, dir, ME, collator, en).map((m) => m.name), ['Bee', 'Clark']);
  assert.deepEqual(agentsLeavingWith(room, inside, dir, ROB, collator, en).map((m) => m.name), ['Robbot']);
  assert.deepEqual(agentsLeavingWith({ ...room, archived: true }, inside, dir, ME, collator, en).map((m) => m.name), ['Bee', 'Clark']);
  assert.deepEqual(agentsLeavingWith({ ...open, members: 1 }, inside, dir, ME, collator, en).map((m) => m.name), ['Bee', 'Clark']);
  assert.equal(agentsLeavingWith(room, null, dir, ME, collator, en), null, "the members didn't load");
  assert.deepEqual(agentsLeavingWith(open, inside, dir, ME, collator, en), []);
  assert.deepEqual(agentsLeavingWith(open, null, dir, ME, collator, en), [], 'nothing to say, loaded or not');

  const line = (list, t, lang) => leavingAgentsText(list, { t, listFormat: lf(lang) });
  assert.equal(line([clark], en, 'en'), 'Your agent Clark leaves with you.');
  assert.equal(line([bee, clark], en, 'en'), 'Your agents Bee and Clark leave with you.');
  assert.equal(line([bee, clark], nl, 'nl'), 'Je agents Bee en Clark vertrekken met je mee.');
  assert.equal(line([clark], nl, 'nl'), 'Je agent Clark vertrekt met je mee.');
  const four = [bee, clark, gone, robs];
  assert.equal(line(four, en, 'en'), 'Your 4 agents in this channel leave with you.');
  assert.equal(line(four, nl, 'nl'), 'Je 4 agents in dit kanaal vertrekken met je mee.');
  assert.equal(line([], en, 'en'), null);
  // Without the channel's members, a line that holds without names.
  assert.equal(line(null, en, 'en'), 'Any agents of yours in this channel leave with you.');
  assert.equal(line(null, nl, 'nl'), 'Agents van jou in dit kanaal vertrekken met je mee.');
});

test("a closed DM's bar names the person you blocked and offers a new conversation only where the server takes one", async () => {
  const { closedBar } = await loading;
  const en = (key, params) => i18n.translate('en', key, params);
  const collator = new Intl.Collator('en', { sensitivity: 'base' });
  const dm = (participants, closedReason) => ({ id: 'd1', kind: 'dm', participants: [ME, ...participants], closedReason });
  const bar = (room, opts = {}) => closedBar(room, { me: ME, members, blocks: new Set(), full: true, collator, t: en, ...opts });

  assert.equal(bar(dm([SANNE], null)), null, 'an open DM has no bar');
  assert.equal(bar({ id: 'c1', kind: 'channel', closedReason: 'closed' }), null);

  // You blocked Sanne: the bar says so, offers Unblock and no new conversation, whatever the reason.
  assert.deepEqual(bar(dm([SANNE], 'closed'), { blocks: new Set([SANNE]) }), { key: 'closedYouBlocked', blocked: SANNE, startNew: false });
  assert.deepEqual(bar(dm([SANNE, ROB], 'closed'), { blocks: new Set([SANNE, ROB]) }), { key: 'closedYouBlocked', blocked: ROB, startNew: false }, 'the first blocked person by name');
  assert.equal(en('chat.input.closedYouBlocked', { name: 'Sanne de Vries' }), 'You blocked Sanne de Vries. You can still read this conversation.');

  // The block came from the other side: the neutral line, and the same people can start again.
  assert.deepEqual(bar(dm([SANNE], 'closed')), { key: 'closedBlocked', blocked: null, startNew: true });
  assert.deepEqual(bar(dm([SANNE, ROB], 'closed')), { key: 'closedBlocked', blocked: null, startNew: true });

  // Someone became a guest, left, was deleted or isn't known: the server refuses a new DM, so no button.
  assert.deepEqual(bar(dm([MILA], 'ineligible')), { key: 'closedIneligible', blocked: null, startNew: false });
  assert.deepEqual(bar(dm([OLGA], 'left')), { key: 'closedLeft', blocked: null, startNew: false });
  assert.deepEqual(bar(dm([SANNE, PIM], 'left')), { key: 'closedLeft', blocked: null, startNew: false });
  assert.deepEqual(bar(dm([id('u', 'stranger')], 'left')), { key: 'closedLeft', blocked: null, startNew: false });
  // Everyone came back as an active full member: a new conversation works again.
  assert.equal(bar(dm([SANNE], 'left')).startNew, true);
  // A guest never starts one.
  assert.equal(bar(dm([SANNE], 'closed'), { full: false }).startNew, false);
});

test("New message's list shows who can be picked, who you blocked and the guests, and says why it is empty", async () => {
  const { dmPicker } = await loading;
  const everyone = [...members.values()].sort((a, b) => a.name.localeCompare(b.name));
  const fits = (query) => (m) => m.name.toLowerCase().includes(query.toLowerCase());
  const view = (opts = {}) => {
    const r = dmPicker(everyone, { me: ME, blocks: new Set(), query: '', matches: () => true, ...opts });
    return { pick: r.pick.map((m) => m.id), blocked: r.blocked.map((m) => m.id), guests: r.guests.map((m) => m.id), empty: r.empty };
  };

  // Active full members only; the guest waits for a search, and nobody left or deleted shows.
  assert.deepEqual(view(), { pick: [ROB, SANNE], blocked: [], guests: [], empty: null });
  // Someone you blocked moves to the off rows, with Unblock.
  assert.deepEqual(view({ blocks: new Set([SANNE]) }), { pick: [ROB], blocked: [SANNE], guests: [], empty: null });
  // A search shows the guest too, switched off.
  assert.deepEqual(view({ query: 'mila', matches: fits('mila') }), { pick: [], blocked: [], guests: [MILA], empty: null });
  assert.deepEqual(view({ query: 'sanne', matches: fits('sanne'), blocks: new Set([SANNE]) }), { pick: [], blocked: [SANNE], guests: [], empty: null });
  // A search that finds nobody, Olga (who left) included.
  assert.deepEqual(view({ query: 'olga', matches: fits('olga') }), { pick: [], blocked: [], guests: [], empty: 'none' });
  // Everyone picked already: nothing to say.
  assert.deepEqual(view({ picked: [ROB, SANNE] }), { pick: [], blocked: [], guests: [], empty: null });

  // Only guests besides you: they show, switched off.
  const withGuest = [members.get(ME), members.get(MILA)];
  assert.deepEqual(dmPicker(withGuest, { me: ME }).guests.map((m) => m.id), [MILA]);
  // Nobody else at all: Nobody else is in the workspace, unless the directory isn't complete.
  assert.equal(dmPicker([members.get(ME), members.get(OLGA)], { me: ME }).empty, 'nobody');
  assert.equal(dmPicker([members.get(ME)], { me: ME, membersMore: true }).empty, 'none');
});

test('Add people says whether nobody else is in the workspace or everyone is in the channel already', async () => {
  const { addPeopleEmpty } = await loading;
  assert.equal(addPeopleEmpty({ rows: 2, candidates: 2, others: 4 }), null);
  assert.equal(addPeopleEmpty({ rows: 0, candidates: 2, others: 4, query: 'zz' }), 'none');
  assert.equal(addPeopleEmpty({ rows: 0, candidates: 0, others: 4 }), 'everyone');
  assert.equal(addPeopleEmpty({ rows: 0, candidates: 0, others: 4, query: 'zz' }), 'everyone');
  assert.equal(addPeopleEmpty({ rows: 0, candidates: 0, others: 0 }), 'nobody');
  const en = (key, params) => i18n.translate('en', key, params);
  const nl = (key, params) => i18n.translate('nl', key, params);
  assert.equal(en('chat.new.nobody', { workspace: 'Acme' }), 'Nobody else is in Acme yet');
  assert.equal(nl('chat.channel.addEveryone', { workspace: 'Acme', name: 'design' }), 'Iedereen in Acme zit al in #design');
});

test('a new invitation link says what it grants, and an open one names its channels', async () => {
  const { inviteChannelList, inviteGrant, inviteRowChannels } = await loading;
  const en = (key, params) => i18n.translate('en', key, params);
  const nl = (key, params) => i18n.translate('nl', key, params);
  const date = '21 November at 03:50';
  // Up to three names, then how many more.
  assert.equal(inviteChannelList([], en), '');
  assert.equal(inviteChannelList(['general'], en), '#general');
  assert.equal(inviteChannelList(['design', 'general'], en), '#design and #general');
  assert.equal(inviteChannelList(['a', 'b', 'c'], en), '#a, #b and #c');
  assert.equal(inviteChannelList(['a', 'b', 'c', 'd', 'e'], en), '#a, #b, #c and 2 more');
  assert.equal(inviteChannelList(['a', 'b', 'c', 'd'], nl), '#a, #b, #c en nog 1');
  // The role, the channels and the expiry; a member invitation can have no channels.
  assert.equal(inviteGrant('member', ['general'], date, en), 'One person can join as a member, with #general, until 21 November at 03:50.');
  assert.equal(inviteGrant('guest', ['design'], date, en), 'One person can join as a guest, only in #design, until 21 November at 03:50.');
  assert.equal(inviteGrant('member', [], date, en), 'One person can join as a member until 21 November at 03:50.');
  assert.equal(inviteGrant('guest', ['design', 'general'], '21 november om 03:50', nl), 'Eén persoon kan deelnemen als gast, alleen in #design en #general, tot 21 november om 03:50.');
  // An open invitation's row: two names, then +n; private channels the viewer can't name count in the +n.
  assert.equal(inviteRowChannels(['general'], 1, en), '#general');
  assert.equal(inviteRowChannels(['design', 'general'], 2, en), '#design, #general');
  assert.equal(inviteRowChannels(['a', 'b', 'c', 'd'], 4, en), '#a, #b +2');
  assert.equal(inviteRowChannels(['design'], 3, en), '#design +2');
  assert.equal(inviteRowChannels(['', 'design'], 2, en), '#design +1');
  assert.equal(inviteRowChannels([], 2, en), '2 channels');
  assert.equal(inviteRowChannels([], 0, nl), '0 kanalen');
});

// ---------- rich messages (RUK-211): reactions, files, link cards, formatting ----------

const loadingFormat = import(moduleUrl('chat-format.js'));

test('a reaction joins its group in order, a new emoji makes a group at the end, and applying it twice changes nothing', async () => {
  const { applyReaction, reacted } = await loading;
  let r = applyReaction([], '👍', SANNE, true);
  r = applyReaction(r, '🎉', ME, true);
  r = applyReaction(r, '👍', ME, true);
  assert.deepEqual(r, [
    { emoji: '👍', actors: [SANNE, ME] },
    { emoji: '🎉', actors: [ME] }
  ]);
  assert.deepEqual(applyReaction(r, '👍', ME, true), r);
  assert.equal(reacted(r, '👍', ME), true);
  // Taking the last one back drops the group; taking back one that isn't there changes nothing.
  r = applyReaction(r, '🎉', ME, false);
  assert.deepEqual(r, [{ emoji: '👍', actors: [SANNE, ME] }]);
  assert.deepEqual(applyReaction(r, '🎉', ME, false), r);
  assert.equal(reacted(r, '🎉', ME), false);
  // Garbage from an old cache reads as no reactions.
  assert.deepEqual(applyReaction(null, '👍', ME, true), [{ emoji: '👍', actors: [ME] }]);
});

test('who reacted names you as You, in the order they reacted, and counts the ones past the first eight', async () => {
  const { reactionNames } = await loading;
  const t = (key, p) => i18n.translate('en', key, p);
  assert.deepEqual(reactionNames({ emoji: '👍', actors: [SANNE, ME, PIM] }, { me: ME, members, t }), { names: ['Sanne de Vries', 'You', 'Deleted member'], more: 0 });
  const many = Array.from({ length: 11 }, (_, i) => id('u', `p${i}`));
  const { names, more } = reactionNames({ emoji: '👍', actors: many }, { me: ME, members, t });
  assert.equal(names.length, 8);
  assert.equal(more, 3);
  assert.equal(t('chat.react.who', { names: 'Sanne and you', emoji: '👍', count: 2 }), 'Sanne and you reacted with 👍');
  assert.equal(i18n.translate('nl', 'chat.react.who', { names: 'Sanne', emoji: '👍', count: 1 }), 'Sanne reageerde met 👍');
});

test("a message's files: images the app can show go in the grid of four with the rest counted, others are cards", async () => {
  const { fileLayout, fitBox, fileKind, isImage, cardImage } = await loading;
  const img = (n, extra = {}) => ({ id: id('f', `i${n}`), name: `photo${n}.png`, type: 'image/png', size: 1000, width: 800, height: 600, ...extra });
  const pdf = { id: id('f', 'pdf'), name: 'Plan.pdf', type: 'application/pdf', size: 250000 };
  const layout = fileLayout([img(1), pdf, img(2), img(3), img(4), img(5), img(6)]);
  assert.deepEqual(
    layout.images.map((f) => f.name),
    ['photo1.png', 'photo2.png', 'photo3.png', 'photo4.png']
  );
  assert.equal(layout.more, 2);
  assert.deepEqual(layout.files, [pdf]);
  // An image without its size, or of a type Chromium can't show, is a card.
  assert.equal(isImage(img(7, { width: undefined })), false);
  assert.equal(isImage(img(8, { type: 'image/heic' })), false);
  assert.equal(fileLayout([img(9, { type: 'image/tiff' })]).files.length, 1);
  // One image fits 360 by 280 at its shape, and is never drawn larger than it is.
  assert.deepEqual(fitBox(4000, 3000), { width: 360, height: 270 });
  assert.deepEqual(fitBox(600, 1200), { width: 140, height: 280 });
  assert.deepEqual(fitBox(120, 80), { width: 120, height: 80 });
  // Kinds for the card's icon, from the type or else the name.
  assert.equal(fileKind(pdf), 'pdf');
  assert.equal(fileKind({ name: 'Q3.xlsx', type: 'application/octet-stream' }), 'sheet');
  assert.equal(fileKind({ name: 'deck.pptx', type: '' }), 'slides');
  assert.equal(fileKind({ name: 'a.zip', type: 'application/zip' }), 'archive');
  assert.equal(fileKind({ name: 'clip.mp4', type: 'video/mp4' }), 'video');
  assert.equal(fileKind({ name: 'x.bin', type: 'application/octet-stream' }), 'file');
  // A card's image goes under the text from 400 pixels wide.
  assert.equal(cardImage({ image: null }), 'none');
  assert.equal(cardImage({ image: { width: 399 } }), 'side');
  assert.equal(cardImage({ image: { width: 1200 } }), 'below');
});

test('Send waits for every staged file, and a ready file is enough to send without text', async () => {
  const { stagedState, draftFiles } = await loading;
  const ready = { stage: 's1', state: 'ready', file: id('f', 'a') };
  assert.deepEqual(stagedState([ready], false).ids, [id('f', 'a')]);
  assert.equal(stagedState([ready], false).canSend, true);
  assert.equal(stagedState([], false).canSend, false);
  assert.equal(stagedState([], true).canSend, true);
  assert.equal(stagedState([ready, { stage: 's2', state: 'uploading' }], true).canSend, false);
  assert.equal(stagedState([ready, { stage: 's3', state: 'failed', error: 'too_large' }], true).canSend, false);
  // A draft keeps files until their upload expires.
  const now = 1000000;
  const { kept, expired } = draftFiles([{ id: id('f', 'old'), expiresAt: now - 1 }, { id: id('f', 'new'), expiresAt: now + 60000 }, { id: id('f', 'none') }], now);
  assert.deepEqual(
    kept.map((f) => f.id),
    [id('f', 'new'), id('f', 'none')]
  );
  assert.equal(expired, 1);
});

test('Message the author is for active full members you did not block, never your own message or in a guest view', async () => {
  const { canMessageAuthor } = await loading;
  const row = (actor) => ({ type: 'msg', actor, id: id('e', 'x'), seq: 1 });
  const opts = { me: ME, myRole: 'member', members, blocks: new Set() };
  assert.equal(canMessageAuthor(row(SANNE), opts), true);
  assert.equal(canMessageAuthor(row(ME), opts), false);
  assert.equal(canMessageAuthor(row(MILA), opts), false, 'a guest');
  assert.equal(canMessageAuthor(row(OLGA), opts), false, 'someone who left');
  assert.equal(canMessageAuthor(row(SANNE), { ...opts, blocks: new Set([SANNE]) }), false);
  assert.equal(canMessageAuthor(row(SANNE), { ...opts, myRole: 'guest' }), false);
  assert.equal(canMessageAuthor({ ...row(SANNE), pending: 'queued' }, opts), false);
});

test("a message row carries its files, cards and reactions, and its sig changes with them and with a reactor's name", async () => {
  const { timeline } = await loading;
  seqs = 0;
  const file = { id: id('f', 'a'), name: 'a.pdf', type: 'application/pdf', size: 10 };
  const card = { url: 'https://example.com/', title: 'Example', description: '', site: 'example.com', image: null, video: false };
  const m = msg(SANNE, T0, { attachments: [file], previews: [card], reactions: [{ emoji: '👍', actors: [ROB] }] });
  const row = timeline([m], base).find((r) => r.type === 'msg');
  assert.deepEqual(row.attachments, [file]);
  assert.deepEqual(row.previews, [card]);
  assert.deepEqual(row.reactions, [{ emoji: '👍', actors: [ROB] }]);
  const sig = (events, opts = base) => timeline(events, opts).find((r) => r.type === 'msg').sig;
  const before = sig([m]);
  assert.notEqual(sig([{ ...m, reactions: [{ emoji: '👍', actors: [ROB, ME] }] }]), before);
  assert.notEqual(sig([{ ...m, previews: [] }]), before);
  const renamed = new Map(members);
  renamed.set(ROB, { ...members.get(ROB), name: 'Robert' });
  assert.notEqual(sig([m], { ...base, members: renamed }), before);
  // A removed message keeps none of it; an old cache without the fields reads as none.
  const gone = timeline([{ ...m, redacted: true, text: null }], base).find((r) => r.type === 'msg');
  assert.deepEqual([gone.attachments, gone.previews, gone.reactions], [[], [], []]);
  const old = timeline([msg(SANNE, T0)], base).find((r) => r.type === 'msg');
  assert.deepEqual([old.attachments, old.previews, old.reactions], [[], [], []]);
  // A pending send shows its files, and has no cards or reactions yet.
  const p = { local: 'l'.repeat(22), text: '', mentions: [], root: null, state: 'queued', createdAt: T0 + MIN, attachments: [file] };
  const pending = timeline([m], { ...base, pending: [p] }).find((r) => r.pending);
  assert.deepEqual(pending.attachments, [file]);
  assert.deepEqual(pending.reactions, []);
});

test('the formatting commands wrap a selection or put a pair at the caret, and take markers off again', async () => {
  const { format, applyEdits } = await loadingFormat;
  const run = (kind, text, a, b = a) => {
    const r = format(kind, text, a, b);
    const out = applyEdits(text, r.edits);
    return [out, out.slice(r.start, r.end), r.start, r.end];
  };
  assert.deepEqual(run('bold', 'hello world', 6, 11), ['hello **world**', 'world', 8, 13]);
  assert.deepEqual(run('bold', 'hello **world**', 8, 13), ['hello world', 'world', 6, 11]);
  assert.deepEqual(run('bold', 'hello **world**', 6, 15), ['hello world', 'world', 6, 11]);
  assert.deepEqual(run('bold', 'hello ', 6), ['hello ****', '', 8, 8]);
  assert.deepEqual(run('bold', 'hello ****', 8), ['hello ', '', 6, 6]);
  // White space at the selection's ends stays outside the markers.
  assert.deepEqual(run('italic', 'a word here', 1, 7), ['a _word_ here', 'word', 3, 7]);
  assert.deepEqual(run('strike', 'gone', 0, 4), ['~~gone~~', 'gone', 2, 6]);
  assert.deepEqual(run('code', 'x', 0, 1), ['`x`', 'x', 1, 2]);
  // Links: the caret goes where the address belongs, or into the label when the selection was the address.
  assert.deepEqual(run('link', 'see docs now', 4, 8), ['see [docs]() now', '', 11, 11]);
  assert.deepEqual(run('link', 'https://example.com', 0, 19), ['[](https://example.com)', '', 1, 1]);
  assert.deepEqual(run('link', 'abc', 3), ['abc[]()', '', 4, 4]);
  // Lines: every line the selection touches, numbered from 1; when all have the prefix it comes off.
  assert.equal(run('bullets', 'one\ntwo\nthree', 0, 9)[0], '- one\n- two\n- three');
  assert.equal(run('bullets', '- one\n- two', 2, 9)[0], 'one\ntwo');
  assert.equal(run('numbers', 'one\n- two', 0, 7)[0], '1. one\n2. two');
  assert.equal(run('quote', 'one\ntwo', 5)[0], 'one\n> two');
  // Code blocks: fences on lines of their own, and off again.
  assert.deepEqual(run('codeBlock', 'abc', 3), ['abc\n```\n\n```', '', 8, 8]);
  assert.equal(run('codeBlock', 'a\nline1\nline2\nb', 2, 13)[0], 'a\n```\nline1\nline2\n```\nb');
  assert.equal(run('codeBlock', 'a\n```\nline1\n```\nb', 6, 11)[0], 'a\nline1\nb');
});

test("the composer's shortcuts are Slack's, and ':' with two characters opens the emoji list", async () => {
  const { formatForKey, emojiToken, emojiCode, SHORTCUTS, FORMATS } = await loadingFormat;
  const key = (k, code, mods = {}) => formatForKey({ key: k, code, ctrlKey: true, ...mods });
  assert.equal(key('b', 'KeyB'), 'bold');
  assert.equal(key('i', 'KeyI'), 'italic');
  assert.equal(key('X', 'KeyX', { shiftKey: true }), 'strike');
  assert.equal(key('e', 'KeyE'), 'code');
  assert.equal(key('U', 'KeyU', { shiftKey: true }), 'link');
  assert.equal(key('*', 'Digit8', { shiftKey: true }), 'bullets');
  assert.equal(key('&', 'Digit7', { shiftKey: true }), 'numbers');
  assert.equal(key('(', 'Digit9', { shiftKey: true }), 'quote');
  assert.equal(key('C', 'KeyC', { shiftKey: true, altKey: true }), 'codeBlock');
  assert.equal(formatForKey({ key: 'b', code: 'KeyB' }), null, 'without Ctrl');
  assert.equal(key('z', 'KeyZ'), null);
  assert.deepEqual(Object.keys(SHORTCUTS).sort(), [...FORMATS].sort());
  assert.deepEqual(emojiToken('nice :thu'), { start: 5, query: 'thu' });
  assert.equal(emojiToken('nice :t'), null, 'one character is not enough');
  assert.equal(emojiToken('at 10:30'), null, 'a time');
  assert.equal(emojiToken('see http://x'), null);
  assert.deepEqual(emojiCode('great :tada:'), { start: 6, code: 'tada' });
  assert.equal(emojiCode('10:30:'), null);
});

// ---- agents in channels (server/WORKSPACES.md "Agents") ----

const CLARK = id('u', 'clark');
const REVY = id('u', 'revy');
const agentOf = (over = {}, settings = {}) => ({
  id: CLARK,
  kind: 'agent',
  name: 'Clark',
  role: 'member',
  state: 'active',
  joinedAt: 0,
  agent: { sponsor: SANNE, answers: 'everyone', members: [], agents: false, ...settings },
  ...over
});
const withAgents = (...list) => new Map([...members, ...list.map((a) => [a.id, a])]);

test('an agent has the Agent tag in both languages, and a former agent the Former member tag', async () => {
  const { memberTag, isAgent, isPerson } = await loading;
  const en = (key, params) => i18n.translate('en', key, params);
  const nl = (key, params) => i18n.translate('nl', key, params);
  assert.equal(memberTag(agentOf(), en), 'Agent');
  assert.equal(memberTag(agentOf(), nl), 'Agent');
  assert.equal(memberTag(agentOf({ state: 'removed' }), en), 'Former member');
  assert.equal(isAgent(agentOf()), true);
  assert.equal(isAgent(members.get(SANNE)), false);
  assert.equal(isPerson(members.get(SANNE)), true);
  assert.equal(isPerson(agentOf()), false);
  assert.equal(isPerson({ ...members.get(SANNE), kind: 'robot' }), true, 'a kind this version does not know is a person');
});

test("an agent's row draws again when a member becomes an agent, as its tag changes", async () => {
  const { timeline } = await loading;
  seqs = 0;
  const events = [msg(CLARK, T0)];
  const message = (rows) => rows.find((r) => r.type === 'msg');
  const before = message(timeline(events, { ...base, members: withAgents({ ...agentOf(), kind: 'human', agent: undefined }) }));
  const after = message(timeline(events, { ...base, members: withAgents(agentOf()) }));
  assert.equal(before.key, after.key);
  assert.notEqual(before.sig, after.sig);
});

test('whom an agent answers: its sponsor always, everyone, or the people it lists; and the line that says so', async () => {
  const { agentAnswers, agentAnswersText, agentMentionNote } = await loading;
  const en = (key, params) => i18n.translate('en', key, params);
  const nl = (key, params) => i18n.translate('nl', key, params);
  const lf = (lang) => new Intl.ListFormat(lang, { type: 'conjunction' });
  const everyone = agentOf();
  const sponsorOnly = agentOf({}, { answers: 'sponsor' });
  const chosen = agentOf({}, { answers: 'members', members: [ROB] });
  assert.equal(agentAnswers(everyone, ME), true);
  assert.equal(agentAnswers(sponsorOnly, ME), false);
  assert.equal(agentAnswers(sponsorOnly, SANNE), true, 'its sponsor');
  assert.equal(agentAnswers(chosen, ROB), true);
  assert.equal(agentAnswers(chosen, SANNE), true);
  assert.equal(agentAnswers(chosen, ME), false);
  // An answers word this version doesn't know counts as not answering, as on Android; its sponsor is still answered.
  assert.equal(agentAnswers(agentOf({}, { answers: 'channel_managers' }), ME), false, 'an answers word this version does not know');
  assert.equal(agentAnswers(agentOf({}, { answers: 'channel_managers' }), SANNE), true, 'its sponsor, whatever the word');
  assert.equal(agentAnswers({ ...agentOf(), agent: undefined }, ME), true, 'no settings yet');
  assert.equal(agentAnswersText(everyone, { members, t: en }), 'Answers everyone');
  assert.equal(agentAnswersText(sponsorOnly, { members, t: en, listFormat: lf('en') }), 'Answers only Sanne de Vries');
  assert.equal(agentAnswersText(chosen, { members, t: en, listFormat: lf('en') }), 'Answers only Sanne de Vries and Rob');
  assert.equal(agentAnswersText(chosen, { members, t: nl, listFormat: lf('nl') }), 'Antwoordt alleen Sanne de Vries en Rob');
  const many = agentOf({}, { answers: 'members', members: [ROB, ME, MILA, OLGA] });
  assert.equal(agentAnswersText(many, { members, t: en, listFormat: lf('en') }), 'Answers only Sanne de Vries, Rob and 3 others');
  assert.equal(agentAnswersText(many, { members, t: nl, listFormat: lf('nl') }), 'Antwoordt alleen Sanne de Vries, Rob en 3 anderen');
  // AgentOut, as the Agents dialog lists it, reads the same.
  assert.equal(agentAnswersText({ sponsor: SANNE, answers: 'sponsor', members: [] }, { members, t: en, listFormat: lf('en') }), 'Answers only Sanne de Vries');
  // A word this version doesn't know reads as its sponsor only, and the mention list says so to anyone else.
  assert.equal(agentAnswersText(agentOf({}, { answers: 'channel_managers' }), { members, t: en, listFormat: lf('en') }), 'Answers only Sanne de Vries');
  assert.equal(agentMentionNote(agentOf({}, { answers: 'channel_managers' }), ME, { members, t: en, listFormat: lf('en') }), 'Answers only Sanne de Vries');
  // A sponsor the directory doesn't hold (a guest's directory has only the people in their channels) is never
  // "Former member": the line says "the person who made it", or names only the people it does know.
  const unknown = id('u', 'not in this directory');
  assert.equal(agentAnswersText(agentOf({}, { sponsor: unknown, answers: 'sponsor' }), { members, t: en, listFormat: lf('en') }), 'Answers only the person who made it');
  assert.equal(agentAnswersText(agentOf({}, { sponsor: unknown, answers: 'sponsor' }), { members, t: nl, listFormat: lf('nl') }), 'Antwoordt alleen wie hem maakte');
  assert.equal(agentMentionNote(agentOf({}, { sponsor: unknown, answers: 'sponsor' }), ME, { members, t: en, listFormat: lf('en') }), 'Answers only the person who made it');
  assert.equal(agentAnswersText(agentOf({}, { sponsor: unknown, answers: 'members', members: [ME] }), { members, t: en, listFormat: lf('en') }), 'Answers only Demo User');
  assert.equal(agentAnswersText(agentOf({}, { sponsor: null, answers: 'sponsor' }), { members, t: en }), 'Answers only the person who made it');
  // The mention list says it only to someone the agent won't answer.
  assert.equal(agentMentionNote(sponsorOnly, ME, { members, t: en, listFormat: lf('en') }), 'Answers only Sanne de Vries');
  assert.equal(agentMentionNote(sponsorOnly, SANNE, { members, t: en }), null);
  assert.equal(agentMentionNote(everyone, ME, { members, t: en }), null);
  assert.equal(agentMentionNote(members.get(ROB), ME, { members, t: en }), null, 'a person');
});

test('the line under an agent in the members lists says who made it and whom it answers, as on Android', async () => {
  const { agentNote } = await loading;
  const en = (key, params) => i18n.translate('en', key, params);
  const nl = (key, params) => i18n.translate('nl', key, params);
  const lf = (lang) => new Intl.ListFormat(lang, { type: 'conjunction' });
  assert.equal(agentNote(agentOf({}, { answers: 'sponsor' }), { members, t: en, listFormat: lf('en') }), 'Made by Sanne de Vries · Answers only Sanne de Vries');
  assert.equal(agentNote(agentOf({}, { agents: true }), { members, t: nl, listFormat: lf('nl') }), 'Gemaakt door Sanne de Vries · Antwoordt iedereen · Antwoordt andere agents');
  // AgentOut, as the Agents dialog lists it.
  assert.equal(agentNote({ id: CLARK, name: 'Clark', sponsor: ROB, answers: 'members', members: [ME], agents: false }, { members, t: en, listFormat: lf('en') }), 'Made by Rob · Answers only Rob and Demo User');
  // A sponsor the directory doesn't hold: no Made by, and never "Former member".
  const unknown = id('u', 'not in this directory');
  assert.equal(agentNote(agentOf({}, { sponsor: unknown, answers: 'sponsor' }), { members, t: en, listFormat: lf('en') }), 'Answers only the person who made it');
  assert.equal(agentNote(agentOf({}, { sponsor: unknown }), { members, t: en }), 'Answers everyone');
  // A person, or an agent without settings yet, has no line.
  assert.equal(agentNote(members.get(ROB), { members, t: en }), null);
  assert.equal(agentNote({ ...agentOf(), agent: undefined }, { members, t: en }), null);
});

test('a new agent starts on Only me, and Chosen people with nobody picked or an unknown choice cannot be saved', async () => {
  const { agentFormAnswers, agentFormReady, AGENT_CHOSEN_MAX } = await loading;
  assert.equal(agentFormAnswers(null), 'sponsor', 'a new agent');
  assert.equal(agentFormAnswers({ answers: 'everyone' }), 'everyone');
  assert.equal(agentFormAnswers({ answers: 'members' }), 'members');
  assert.equal(agentFormAnswers({ answers: 'channel_managers' }), 'sponsor', 'a word this version does not know');
  assert.equal(agentFormAnswers({ answers: null }), 'sponsor', 'a directory row without settings');
  assert.equal(agentFormReady({ answers: 'sponsor' }), true);
  assert.equal(agentFormReady({ answers: 'everyone' }), true);
  assert.equal(agentFormReady({ answers: 'members', chosen: 0 }), false, 'nobody picked');
  assert.equal(agentFormReady({ answers: 'members', chosen: 1 }), true);
  assert.equal(agentFormReady({ answers: 'members', chosen: AGENT_CHOSEN_MAX }), true);
  assert.equal(agentFormReady({ answers: 'members', chosen: AGENT_CHOSEN_MAX + 1 }), false);
  assert.equal(agentFormReady({ answers: 'channel_managers' }), false);
});

test("only an agent's sponsor makes it a new key; an owner or admin edits and removes it", async () => {
  const { canRenewAgentKey, canManageAgent } = await loading;
  const clark = agentOf();
  assert.equal(canRenewAgentKey(clark, SANNE), true, 'its sponsor');
  assert.equal(canRenewAgentKey(clark, ROB), false, 'an admin');
  assert.equal(canRenewAgentKey(clark, ME), false, 'someone else');
  assert.equal(canRenewAgentKey({ id: CLARK, sponsor: SANNE }, SANNE), true, 'AgentOut');
  assert.equal(canRenewAgentKey({ id: CLARK, sponsor: SANNE }, null), false);
  assert.equal(canRenewAgentKey({ ...clark, agent: undefined }, SANNE), false, 'without settings nobody is its sponsor');
  assert.equal(canManageAgent(clark, ROB, 'admin'), true);
  assert.equal(canManageAgent(clark, ROB, 'owner'), true);
});

test("an agent's sponsor removes the agent's messages, also once the agent is gone", async () => {
  const { canRemove, sponsorsAuthor } = await loading;
  seqs = 0;
  const reply = msg(CLARK, T0);
  const channel = { kind: 'channel', role: 'member' };
  assert.equal(canRemove(reply, SANNE, channel, withAgents(agentOf())), true, 'its sponsor');
  assert.equal(canRemove(reply, SANNE, channel, withAgents(agentOf({ state: 'removed' }))), true, 'a removed agent');
  assert.equal(canRemove(reply, ME, channel, withAgents(agentOf())), false, 'someone else');
  assert.equal(canRemove(reply, SANNE, channel), false, 'without the directory');
  assert.equal(canRemove(msg(ROB, T0), SANNE, channel, withAgents(agentOf())), false, "a person's message");
  assert.equal(canRemove({ ...reply, redacted: true }, SANNE, channel, withAgents(agentOf())), false);
  assert.equal(sponsorsAuthor(reply, SANNE, [...withAgents(agentOf()).values()]), true, 'a list as directory');
  assert.equal(sponsorsAuthor(reply, null, withAgents(agentOf())), false);
});

test('Add agents, for someone who may add only their own agents, says they are all in and never speaks for the people', async () => {
  const { addPeopleEmpty } = await loading;
  assert.equal(addPeopleEmpty({ rows: 0, candidates: 0, others: 4, agentsOnly: true }), 'agents');
  assert.equal(addPeopleEmpty({ rows: 0, candidates: 0, others: 0, agentsOnly: true }), 'agents');
  assert.equal(addPeopleEmpty({ rows: 0, candidates: 1, others: 4, query: 'zz', agentsOnly: true }), 'none');
  assert.equal(addPeopleEmpty({ rows: 1, candidates: 1, others: 4, agentsOnly: true }), null);
});

test('who may add an agent to a channel, take it out and change it', async () => {
  const { canAddAgent, canRemoveAgent, canManageAgent } = await loading;
  const clark = agentOf();
  const open = { id: id('c', 'open'), kind: 'channel', visibility: 'workspace', role: 'member', archived: false };
  const secret = { ...open, visibility: 'private' };
  // A manager adds any active agent to a channel the workspace can see; into a private channel only one whose sponsor
  // is in it (the server's 409 sponsor_not_in_channel), and none while the channel's members aren't known.
  assert.equal(canAddAgent(clark, { ...open, role: 'manager' }, ME), true);
  assert.equal(canAddAgent(clark, { ...secret, role: 'manager' }, ME, new Set([ME, SANNE])), true);
  assert.equal(canAddAgent(clark, { ...secret, role: 'manager' }, ME, [ME, SANNE]), true, 'a list of member IDs');
  assert.equal(canAddAgent(clark, { ...secret, role: 'manager' }, ME, new Set([ME])), false, 'its sponsor is not in it');
  assert.equal(canAddAgent(clark, { ...secret, role: 'manager' }, ME), false, 'the members are not known');
  assert.equal(canAddAgent({ ...clark, agent: undefined }, { ...secret, role: 'manager' }, ME, new Set([ME])), false, 'no sponsor known');
  assert.equal(canAddAgent(clark, { ...secret, role: 'manager' }, SANNE, new Set([SANNE])), true, 'its sponsor managing it');
  // Its sponsor adds it to a channel the workspace can see.
  assert.equal(canAddAgent(clark, open, SANNE), true);
  assert.equal(canAddAgent(clark, secret, SANNE), false, "a private channel's non-manager");
  assert.equal(canAddAgent(clark, open, ME), false, "someone else's agent where you don't manage");
  assert.equal(canAddAgent(clark, { ...open, archived: true, role: 'manager' }, ME), false);
  assert.equal(canAddAgent(agentOf({ state: 'removed' }), { ...open, role: 'manager' }, ME), false);
  assert.equal(canAddAgent(members.get(ROB), { ...open, role: 'manager' }, ME), false, 'a person');
  assert.equal(canAddAgent(clark, { ...open, kind: 'dm', role: 'manager' }, SANNE), false);
  // Its sponsor and the channel's managers take it out, also of a private channel.
  assert.equal(canRemoveAgent(clark, secret, SANNE), true);
  assert.equal(canRemoveAgent(clark, { ...secret, role: 'manager' }, ME), true);
  assert.equal(canRemoveAgent(clark, open, ME), false);
  // Also out of an archived channel, which keeps its history and so its key's read access until the agent leaves.
  assert.equal(canRemoveAgent(clark, { ...secret, archived: true }, SANNE), true, 'its sponsor, archived');
  assert.equal(canRemoveAgent(clark, { ...open, archived: true, role: 'manager' }, ME), true, 'a manager, archived');
  assert.equal(canRemoveAgent(clark, { ...open, archived: true }, ME), false, "someone else's agent, archived");
  assert.equal(canRemoveAgent(members.get(ROB), { ...open, archived: true, role: 'manager' }, ME), false, 'a person');
  // Its sponsor, an owner or an admin change it.
  assert.equal(canManageAgent(clark, SANNE, 'member'), true);
  assert.equal(canManageAgent(clark, ME, 'member'), false);
  assert.equal(canManageAgent(clark, ME, 'admin'), true);
  assert.equal(canManageAgent({ id: CLARK, sponsor: ME }, ME, 'member'), true, 'AgentOut');
});

test('agents are never in New message, a successor list, Message the author or Block the author', async () => {
  const { dmPicker, successors, canMessageAuthor, canBlockAuthor } = await loading;
  const clark = agentOf();
  const revy = agentOf({ id: REVY, name: 'Revy' }, { sponsor: ME });
  const dir = withAgents(clark, revy);
  const people = [...dir.values()];
  const picker = dmPicker(people, { me: ME, query: '' });
  assert.ok(!picker.pick.some((m) => m.kind === 'agent'));
  assert.ok(!picker.guests.some((m) => m.kind === 'agent'));
  assert.deepEqual(dmPicker(people, { me: ME, query: 'cla', matches: (m) => m.name.toLowerCase().includes('cla') }).empty, 'none');
  const collator = new Intl.Collator('en');
  const en = (key, params) => i18n.translate('en', key, params);
  assert.deepEqual(successors([SANNE, CLARK, REVY, ROB], dir, ME, collator, en), [ROB, SANNE]);
  const row = (actor) => ({ type: 'msg', actor, id: id('e', 'x'), seq: 1 });
  assert.equal(canMessageAuthor(row(CLARK), { me: ME, members: dir }), false);
  assert.equal(canBlockAuthor(row(CLARK), { me: ME, members: dir }), false);
  assert.equal(canBlockAuthor(row(SANNE), { me: ME, members: dir }), true);
  assert.equal(canBlockAuthor(row(SANNE), { me: ME, members: dir, blocks: [SANNE] }), false);
  assert.equal(canBlockAuthor(row(MILA), { me: ME, members: dir }), false, 'a guest');
});
