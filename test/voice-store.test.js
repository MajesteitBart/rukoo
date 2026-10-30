'use strict';

// What Rukoo keeps of Rukoo Voice's meetings: events applied once or twice give the same store, revisions only go up,
// a removed meeting takes its transcript but not the user's notes, damaged files are kept aside, and saves wait a
// moment but are all written when Rukoo quits.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tempDir } = require('./tmp');
const { VoiceStore } = require('../src/main/voice/store');
const { suggest, candidateEvents, attendeeCandidates } = require('../src/main/voice/speakers');

const M = 'm-20261030-171203-4f2a';
const OTHER = 'm-20261030-090000-00ff';
let seq = 0;
const ev = (event, meeting, data) => ({ type: 'event', seq: ++seq, event, ...(meeting ? { meeting } : {}), createdAt: 1793000000000, data });
const started = (meeting = M, extra = {}) => ev('meeting.started', meeting, { title: 'Weekly with Anna', startedAt: 1793000000000, tracks: ['mic', 'call'], screen: 'off', startedBy: 'rukoo', context: { calendarEvent: 'acc:cal:evt' }, ...extra });
const passage = (track, start, text, revision = 1, extra = {}) =>
  ev('passage', M, { id: `${track}-${String(start).padStart(9, '0')}`, track, speaker: track === 'mic' ? 'mic' : 'call-1', start, end: start + 1500, text, revision, dictation: false, language: 'en', ...extra });

function store(dir = tempDir('rukoo-voice-store-'), opts = {}) {
  return new VoiceStore({ dataDir: dir, saveMs: 20, now: () => 1793000500000, ...opts }).load();
}

function script() {
  return [
    started(),
    ev('meeting.state', M, { state: 'recording', at: 0 }),
    ev('speaker', M, { id: 'mic', track: 'mic', label: 'You' }),
    ev('speaker', M, { id: 'call-1', track: 'call', label: 'Speaker 1' }),
    passage('call', 65320, "Let's move the launch to Thursday."),
    passage('mic', 70000, 'Works for me.'),
    passage('call', 65320, "Let's move the launch to Thursday morning.", 2),
    ev('mark', M, { id: 'k-3', kind: 'gap', at: 120400, until: 126900, track: 'mic', detail: 'device', label: null }),
    ev('passage.removed', M, { id: 'mic-000070000' }),
    ev('meeting.state', M, { state: 'processing', at: 3605120, endedAt: 1793003605120, reason: 'user' })
  ];
}

const shape = (s) => {
  const m = s.meeting(M);
  return JSON.stringify({ meeting: { ...m.meeting, rev: 0 }, speakers: m.speakers, passages: m.passages.map(({ changed, added, ...p }) => p), marks: m.marks.map(({ changed, ...k }) => k) });
};

test('applying the same events twice gives the same meeting', () => {
  const once = store();
  const events = script();
  for (const e of events) once.apply(e);
  const twice = store();
  for (const e of [...events, ...events]) twice.apply(e);
  assert.equal(shape(twice), shape(once));
  const m = once.meeting(M);
  assert.equal(m.meeting.title, 'Weekly with Anna');
  assert.equal(m.meeting.state, 'processing');
  assert.equal(m.meeting.endedAt, 1793003605120);
  assert.equal(m.meeting.eventId, 'acc:cal:evt', 'the calendar event Rukoo started it from');
  assert.deepEqual(m.passages.map((p) => [p.id, p.text, p.revision]), [['call-000065320', "Let's move the launch to Thursday morning.", 2]]);
  assert.deepEqual(m.marks.map((k) => k.id), ['k-3']);
  assert.equal(once.cursor().after, events.at(-1).seq);
  // A repeat changes nothing, so it reports nothing.
  assert.equal(twice.apply(events[4]), null);
});

test('an older revision that arrives late does not replace a newer one, and a passage keeps when it was first seen', () => {
  const s = store();
  s.apply(started());
  s.apply(passage('call', 1000, 'Better.', 3));
  const first = s.meeting(M).passages[0];
  assert.equal(s.apply(passage('call', 1000, 'Worse.', 2)), null);
  s.apply(passage('call', 1000, 'Best.', 4));
  const p = s.meeting(M).passages[0];
  assert.equal(p.text, 'Best.');
  assert.equal(p.added, first.added);
  assert.ok(p.changed > first.changed);
});

test('recording follows the status and the meeting state, and an ended meeting no longer records', () => {
  const s = store();
  s.apply(started());
  s.apply(ev('meeting.state', M, { state: 'recording', at: 0 }));
  assert.equal(s.status().recording, M, 'known the moment Voice says the meeting records');
  s.apply(ev('status', null, { recording: M, dictating: true }));
  assert.deepEqual(s.status(), { recording: M, dictating: true });
  s.apply(ev('meeting.state', M, { state: 'done', at: 5000, endedAt: 1793000005000 }));
  assert.equal(s.status().recording, null);
});

test("a removed meeting takes its transcript and Rukoo's names and corrections, but keeps the user's notes", () => {
  const dir = tempDir('rukoo-voice-store-');
  const s = store(dir);
  for (const e of script().slice(0, 6)) s.apply(e);
  s.apply(started(OTHER, { title: 'Without notes' }));
  assert.equal(s.setName(M, 'call-1', { name: 'Anna', address: 'anna@example.com' }), true);
  assert.equal(s.correct(M, 'call-000065320', 'Move the launch to Thursday.'), true);
  assert.deepEqual(s.saveNotes(M, 'Launch on Thursday.', 0), { rev: 1 });
  s.flush();
  assert.ok(fs.existsSync(path.join(dir, 'meetings', `${OTHER}.json`)) || !s.meeting(OTHER).passages.length);
  s.apply(ev('meeting.removed', M, {}));
  s.apply(ev('meeting.removed', OTHER, {}));
  s.close();
  const again = store(dir);
  assert.equal(again.meeting(OTHER), null);
  assert.equal(fs.existsSync(path.join(dir, 'meetings', `${OTHER}.json`)), false);
  const kept = again.meeting(M);
  assert.equal(kept.meeting.removed, true);
  assert.deepEqual(kept.passages, []);
  assert.deepEqual(kept.speakers, []);
  assert.equal(kept.notes.text, 'Launch on Thursday.');
});

test('names, notes and corrections are Rukoo\'s and survive a restart; notes refuse a save from a stale editor', () => {
  const dir = tempDir('rukoo-voice-store-');
  const s = store(dir);
  const events = script().slice(0, 5);
  for (const e of events) s.apply(e);
  assert.equal(s.setName(M, 'call-1', { name: '  Anna de Vries ', address: 'anna@example.com', from: 'calendar' }), true);
  assert.equal(s.setName(M, 'nobody', { name: 'X' }), false, 'only a speaker Voice named');
  assert.deepEqual(s.saveNotes(M, 'First', 0), { rev: 1 });
  assert.deepEqual(s.saveNotes(M, 'Stale', 0), { conflict: true, rev: 1, text: 'First' });
  assert.deepEqual(s.saveNotes(M, 'Second', 1), { rev: 2 });
  const before = s.meeting(M).passages[0].changed;
  assert.equal(s.correct(M, 'call-000065320', 'Move it to Thursday.'), true);
  assert.equal(s.correct(M, 'call-999999999', 'x'), false);
  const p = s.meeting(M).passages[0];
  assert.ok(p.changed > before, 'a correction counts as a change for the agent');
  assert.deepEqual([p.text, p.original, p.corrected], ['Move it to Thursday.', "Let's move the launch to Thursday.", true]);
  s.close();
  const again = store(dir);
  const m = again.meeting(M);
  assert.deepEqual(m.speakers.find((x) => x.id === 'call-1'), { id: 'call-1', track: 'call', label: 'Speaker 1', name: 'Anna de Vries', address: 'anna@example.com', from: 'calendar' });
  assert.equal(m.notes.text, 'Second');
  assert.equal(m.passages[0].text, 'Move it to Thursday.');
  assert.equal(again.cursor().after, events.at(-1).seq);
  // Voice's newer revision keeps the user's correction; null goes back to what Voice recognized.
  again.apply(passage('call', 65320, 'Voice heard it again.', 2));
  assert.equal(again.meeting(M).passages[0].text, 'Move it to Thursday.');
  again.correct(M, 'call-000065320', null);
  assert.equal(again.meeting(M).passages[0].text, 'Voice heard it again.');
});

test('saves wait a moment, and closing writes everything at once', async () => {
  const dir = tempDir('rukoo-voice-store-');
  const s = store(dir, { saveMs: 60000 });
  const events = script().slice(0, 5);
  for (const e of events) s.apply(e);
  assert.equal(fs.existsSync(path.join(dir, 'voice.json')), false, 'not yet');
  s.close();
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'voice.json'), 'utf8')).lastSeq, events.at(-1).seq);
  assert.ok(JSON.parse(fs.readFileSync(path.join(dir, 'meetings', `${M}.json`), 'utf8')).passages['call-000065320']);
  const quick = store(tempDir('rukoo-voice-store-'), { saveMs: 10 });
  quick.apply(started());
  await new Promise((r) => setTimeout(r, 60));
  assert.ok(fs.existsSync(quick.file));
});

test('a damaged voice.json or meeting file is kept aside, never overwritten, and Voice is asked for the meeting again', () => {
  const dir = tempDir('rukoo-voice-store-');
  const s = store(dir);
  for (const e of script().slice(0, 5)) s.apply(e);
  s.close();
  fs.writeFileSync(path.join(dir, 'meetings', `${M}.json`), '{"passages": {"call-');
  const again = store(dir);
  const m = again.meeting(M);
  assert.deepEqual(m.passages, [], 'the damaged cache starts empty');
  assert.ok(again.damaged.has(M), 'so the service asks Voice for it');
  assert.equal(fs.readdirSync(path.join(dir, 'meetings')).filter((n) => n.startsWith(`${M}.json.bad-`)).length, 1);
  fs.writeFileSync(path.join(dir, 'voice.json'), 'not json');
  const third = store(dir);
  assert.deepEqual(third.list(), []);
  assert.equal(third.cursor().after, 0);
  assert.equal(fs.readdirSync(dir).filter((n) => n.startsWith('voice.json.bad-')).length, 1);
  third.apply(started());
  third.close();
  assert.equal(fs.readdirSync(dir).filter((n) => n.startsWith('voice.json.bad-')).length, 1, 'the kept copy stays');
});

test("with voice.json lost, a meeting's next change still counts above every change in its own file", () => {
  const dir = tempDir('rukoo-voice-store-');
  const s = store(dir);
  const events = script().slice(0, 6);
  for (const e of events) s.apply(e);
  s.close();
  let last = s;
  for (const [n, damage] of [[1, '{not json'], [2, null]]) {
    // What a meeting chat's cursor can hold after the agent read it all.
    const top = Math.max(...last.meeting(M).passages.map((p) => p.changed));
    if (damage) fs.writeFileSync(path.join(dir, 'voice.json'), damage);
    else fs.rmSync(path.join(dir, 'voice.json'));
    const again = store(dir);
    assert.equal(again.cursor().after, 0, 'Voice replays everything');
    for (const e of events) again.apply(e);
    again.apply(passage('call', 90000 + n * 1000, `Said after loss ${n}.`));
    const p = again.meeting(M).passages.find((x) => x.text === `Said after loss ${n}.`);
    assert.ok(p.changed > top, `${p.changed} > ${top}`);
    again.close();
    last = again;
  }
});

test("a snapshot doesn't undo the meeting's events past its head that Rukoo applied before the snapshot came", () => {
  const s = store();
  const at = (e, n) => ({ ...e, seq: n });
  const later = [
    at(passage('call', 4000, 'After the head.'), 4),
    at(ev('mark', M, { id: 'k-9', kind: 'user', at: 4500, until: null, track: null, detail: null, label: null }), 5),
    at(ev('meeting.state', M, { state: 'processing', at: 5000, endedAt: 1793000005000, reason: 'user' }), 6)
  ];
  s.apply(at(started(), 1));
  s.apply(at(passage('call', 1000, 'Before the head.'), 2));
  for (const e of later) s.apply(e);
  s.correct(M, 'call-000004000', 'After the head, corrected.');
  const snap = {
    meeting: { id: M, title: 'Weekly with Anna', startedAt: 1793000000000, tracks: ['mic', 'call'], screen: 'off', startedBy: 'rukoo', context: null, state: 'recording', endedAt: null },
    speakers: [],
    passages: [{ ...passage('call', 1000, 'Before the head.').data }],
    marks: [],
    head: 3
  };
  assert.ok(s.applySnapshot(M, snap, [at(passage('call', 1000, 'Before the head.'), 2), ...later]));
  const m = s.meeting(M);
  assert.deepEqual(m.passages.map((p) => p.text), ['Before the head.', 'After the head, corrected.']);
  assert.deepEqual(m.marks.map((k) => k.id), ['k-9']);
  assert.equal(m.meeting.state, 'processing');
  // With every event at or before its head, the snapshot is the whole meeting.
  assert.ok(s.applySnapshot(M, { ...snap, head: 6 }, later));
  assert.deepEqual(s.meeting(M).passages.map((p) => p.text), ['Before the head.']);
  assert.equal(s.meeting(M).meeting.state, 'recording');
  // A meeting Voice removed after the snapshot stays removed.
  s.apply(at(ev('meeting.removed', M, {}), 7));
  assert.equal(s.applySnapshot(M, snap, [at(ev('meeting.removed', M, {}), 7)]), null);
  assert.equal(s.meeting(M), null);
});

test('welcome: another instance resets the cursor, a gap or full replay goes back to before the oldest event', () => {
  const s = store();
  const base = { type: 'welcome', protocol: 1, voiceVersion: '0.1.0', head: 40, status: { recording: null, dictating: false } };
  assert.deepEqual(s.welcome({ ...base, instance: 'Vb3kQ9m2X7pL1sR4tY8wZQ', oldest: 1, replay: 'full' }), { reset: false, gap: false });
  s.apply({ ...started(), seq: 30 });
  assert.equal(s.cursor().after, 30);
  assert.deepEqual(s.welcome({ ...base, instance: 'Vb3kQ9m2X7pL1sR4tY8wZQ', oldest: 1, replay: 'partial' }), { reset: false, gap: false });
  assert.equal(s.cursor().after, 30);
  assert.deepEqual(s.welcome({ ...base, instance: 'Vb3kQ9m2X7pL1sR4tY8wZQ', oldest: 35, replay: 'gap' }), { reset: false, gap: true });
  assert.equal(s.cursor().after, 34);
  assert.deepEqual(s.welcome({ ...base, instance: 'AAAAAAAAAAAAAAAAAAAAAA', head: 3, oldest: 1, replay: 'full' }), { reset: true, gap: false });
  assert.deepEqual(s.cursor(), { instance: 'AAAAAAAAAAAAAAAAAAAAAA', after: 0 });
  assert.ok(s.meeting(M), 'the meetings Rukoo has stay');
});

test('a replay whose numbers skip, because Voice keeps only the newest status, applies and moves the cursor', () => {
  const s = store();
  s.welcome({ type: 'welcome', protocol: 1, voiceVersion: '0.1.0', instance: 'Vb3kQ9m2X7pL1sR4tY8wZQ', head: 9, oldest: 3, replay: 'full', status: { recording: null, dictating: false } });
  assert.equal(s.cursor().after, 2);
  // Status events 1, 2, 4, 5, 6 and 8 were replaced by 9.
  s.apply({ ...started(), seq: 3 });
  s.apply({ ...passage('call', 1000, 'First.'), seq: 7 });
  s.apply({ ...ev('status', null, { recording: null, dictating: true }), seq: 9 });
  assert.equal(s.cursor().after, 9);
  assert.deepEqual(s.status(), { recording: null, dictating: true });
  assert.deepEqual(s.meeting(M).passages.map((p) => p.text), ['First.']);
});

test("a snapshot replaces the lists with Voice's current ones and leaves out what doesn't pass the protocol's checks", () => {
  const s = store();
  for (const e of script().slice(0, 6)) s.apply(e);
  const change = s.applySnapshot(M, {
    meeting: { id: M, title: 'Renamed', startedAt: 1793000000000, tracks: ['mic', 'call'], screen: 'off', startedBy: 'rukoo', context: null, state: 'done', endedAt: 1793003605120 },
    speakers: [{ id: 'call-1', track: 'call', label: 'Speaker 1' }, { id: 'room-1', track: 'room', label: 'Bad' }],
    passages: [{ id: 'call-000065320', track: 'call', speaker: 'call-1', start: 65320, end: 70000, text: 'Settled.', revision: 2, dictation: false, language: 'en' }, { id: 'call-000000001', track: 'call', speaker: null, start: 5, end: 6, text: 'id mismatch', revision: 1, dictation: false, language: null }],
    marks: [],
    head: 99
  });
  assert.equal(change.kind, 'snapshot');
  const m = s.meeting(M);
  assert.equal(m.meeting.title, 'Renamed');
  assert.equal(m.meeting.state, 'done');
  assert.deepEqual(m.speakers.map((x) => x.id), ['call-1']);
  assert.deepEqual(m.passages.map((p) => p.text), ['Settled.']);
});

test('ids that are not meeting ids never reach the file system', () => {
  const dir = tempDir('rukoo-voice-store-');
  const s = store(dir);
  assert.equal(s.meeting('../voice'), null);
  assert.equal(s.data('..\\..\\x', true), null);
  assert.equal(s.saveNotes('../x', 'y', 0), null);
  assert.equal(fs.existsSync(path.join(dir, 'meetings')), false);
});

test('speaker names from the calendar: the matching event, the guests to offer, and a name of its own only in a 1:1', () => {
  const at = Date.UTC(2026, 9, 30, 9, 31);
  const standup = { id: 'e1', start: Date.UTC(2026, 9, 30, 9, 30), end: Date.UTC(2026, 9, 30, 9, 45), meeting: 'https://meet.example.com/standup', attendees: [{ name: 'Demo User', address: 'demo@example.com', response: 'accepted', self: true }, { name: 'Joris', address: 'joris@example.com', response: 'tentative' }, { name: 'Sanne', address: 'sanne@example.com', response: 'accepted' }, { name: 'Piet', address: 'piet@example.com', response: 'declined' }] };
  const lunch = { id: 'e2', start: Date.UTC(2026, 9, 30, 9, 0), end: Date.UTC(2026, 9, 30, 10, 0), attendees: [] };
  const allDay = { id: 'e3', allDay: true, start: Date.UTC(2026, 9, 30), end: Date.UTC(2026, 9, 31) };
  const declined = { id: 'e4', start: at, end: at + 1800000, response: 'declined', meeting: 'x', attendees: [{ address: 'a@b.c' }] };
  const far = { id: 'e5', start: at + 3600000, end: at + 7200000 };
  assert.deepEqual(candidateEvents([lunch, allDay, declined, far, standup], at).map((e) => e.id), ['e1', 'e2']);
  assert.deepEqual(attendeeCandidates(standup).map((a) => a.name), ['Sanne', 'Joris']);
  const speakers = [{ id: 'mic', track: 'mic' }, { id: 'call-1', track: 'call' }];
  assert.deepEqual(suggest(speakers, standup).auto, {}, 'two guests: the user picks');
  const oneOnOne = { ...standup, attendees: [standup.attendees[0], standup.attendees[2]] };
  assert.equal(suggest(speakers, oneOnOne).auto['call-1'].name, 'Sanne');
  assert.deepEqual(suggest([...speakers, { id: 'call-2', track: 'call' }], oneOnOne).auto, {}, 'two voices: the user picks');
});
