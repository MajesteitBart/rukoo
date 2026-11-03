'use strict';

// What Rukoo keeps of Rukoo Voice's meetings: events applied once or twice give the same store, revisions only go up,
// a removed meeting takes its transcript but not the user's notes, damaged files are kept aside, and saves wait a
// moment but are all written when Rukoo quits.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tempDir } = require('./tmp');
const { VoiceStore, NOTES_MAX } = require('../src/main/voice/store');
const { suggest, candidateEvents, attendeeCandidates, compareSpeakers, speakerOrder } = require('../src/main/voice/speakers');

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

test('oversized notes leave the saved text and revision untouched, including after restart', () => {
  const dir = tempDir('rukoo-notes-limit-');
  const s = store(dir);
  s.apply(started());
  const original = '_'.repeat(60000) + '\nEnd marker';
  assert.deepEqual(s.saveNotes(M, original, 0), { rev: 1 });
  const before = s.meeting(M).notes;
  assert.deepEqual(s.saveNotes(M, original.replace(/_/g, '\\_') + ' revised', 1), { tooLong: true, maxLength: NOTES_MAX, rev: 1 });
  assert.deepEqual(s.meeting(M).notes, before);
  s.close();
  const again = store(dir);
  assert.deepEqual(again.meeting(M).notes, before);
  assert.deepEqual(again.saveNotes(M, 'x'.repeat(NOTES_MAX), 1), { rev: 2 });
  assert.equal(again.meeting(M).notes.text.length, NOTES_MAX);
  again.close();
});

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
  assert.deepEqual(s.status(), { recording: M, dictating: true, screenDefault: null });
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

test("a replay of an older meeting's states leaves the meeting the welcome says records alone", () => {
  const s = store();
  const history = [
    started(OTHER),
    ev('meeting.state', OTHER, { state: 'recording', at: 0 }),
    ev('meeting.state', OTHER, { state: 'done', at: 60000, endedAt: 1793000060000 }),
    started(M),
    ev('meeting.state', M, { state: 'recording', at: 0 })
  ];
  // Rukoo connects while M records, and Voice replays everything it keeps from the oldest event on.
  s.welcome({ instance: 'Vb3kQ9m2X7pL1sR4tY8wZQ', replay: 'full', oldest: history[0].seq, head: history.at(-1).seq, status: { recording: M, dictating: false } });
  const seen = [];
  for (const e of history) {
    s.apply(e);
    seen.push(s.status().recording);
  }
  assert.deepEqual(seen, [M, M, M, M, M]);
  assert.equal(s.entry(OTHER).state, 'done');
  // After the head, an event says what happens now.
  s.apply(ev('meeting.state', M, { state: 'processing', at: 90000, endedAt: 1793000090000, reason: 'user' }));
  assert.equal(s.status().recording, null);
});

test("a meeting file that can't be written keeps the cursor on disk behind its events until it can", () => {
  const dir = tempDir('rukoo-voice-store-');
  const s = store(dir, { saveMs: 60000 });
  const first = script().slice(0, 5);
  for (const e of first) s.apply(e);
  s.flush();
  const saved = first.at(-1).seq;
  const file = path.join(dir, 'meetings', `${M}.json`);
  // A folder in the file's place makes the next write of the meeting fail, as a file another program holds would.
  fs.rmSync(file);
  fs.mkdirSync(file);
  const later = passage('mic', 90000, 'This passage never reaches the disk at first.');
  s.apply(later);
  s.flush();
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'voice.json'), 'utf8')).lastSeq, saved, 'the cursor on disk stays behind');
  assert.equal(store(dir).cursor().after, saved, 'after a restart Voice replays the passage again');
  fs.rmSync(file, { recursive: true });
  s.flush();
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'voice.json'), 'utf8')).lastSeq, later.seq);
  assert.ok(JSON.parse(fs.readFileSync(file, 'utf8')).passages['mic-000090000']);
  s.close();
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
  // The welcome's status is Voice's status at the head, the same as the newest status event, 9.
  s.welcome({ type: 'welcome', protocol: 1, voiceVersion: '0.1.0', instance: 'Vb3kQ9m2X7pL1sR4tY8wZQ', head: 9, oldest: 3, replay: 'full', status: { recording: null, dictating: true } });
  assert.equal(s.cursor().after, 2);
  // Status events 1, 2, 4, 5, 6 and 8 were replaced by 9.
  s.apply({ ...started(), seq: 3 });
  s.apply({ ...passage('call', 1000, 'First.'), seq: 7 });
  s.apply({ ...ev('status', null, { recording: null, dictating: true }), seq: 9 });
  assert.equal(s.cursor().after, 9);
  assert.deepEqual(s.status(), { recording: null, dictating: true, screenDefault: null });
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

const frameEv = (at, text, extra = {}) => ev('frame', M, { id: `f-${String(at).padStart(9, '0')}`, at, width: 1920, height: 1080, text, ...extra });

test('a frame sent twice is one change, and it takes a tick like a passage', () => {
  const dir = tempDir('rukoo-voice-store-');
  const s = store(dir);
  s.apply(started(M, { screen: 'frames' }));
  s.apply(passage('call', 1000, 'Before the slide.'));
  const tickBefore = s.meeting(M).passages[0].changed;
  const first = frameEv(412000, 'Q3 roadmap');
  assert.deepEqual(s.apply(first), { meeting: M, kind: 'frame', id: 'f-000412000' });
  assert.equal(s.apply({ ...first, seq: ++seq }), null, 'Voice sends a frame again with the same id');
  const f = s.meeting(M).frames[0];
  assert.deepEqual({ ...f, changed: undefined }, { id: 'f-000412000', at: 412000, width: 1920, height: 1080, text: 'Q3 roadmap', changed: undefined });
  assert.ok(f.changed > tickBefore, `${f.changed} > ${tickBefore}`);
  s.apply(passage('call', 420000, 'After the slide.'));
  assert.ok(s.meeting(M).passages[1].changed > f.changed);
  s.apply(frameEv(430000, 'The newest change is a frame'));
  const top = s.meeting(M).frames.at(-1).changed;
  // After a restart without voice.json the meeting's next change still counts above that frame's tick.
  s.close();
  fs.rmSync(path.join(dir, 'voice.json'));
  const again = store(dir);
  again.apply(passage('call', 500000, 'Said after the restart.'));
  const p = again.meeting(M).passages.find((x) => x.start === 500000);
  assert.ok(p.changed > top, `${p.changed} > ${top}`);
});

test("a snapshot replaces the frames, keeps the newer ones, and keeps the text Rukoo had for a frame it left without", () => {
  const s = store();
  const at = (e, n) => ({ ...e, seq: n });
  s.apply(at(started(M, { screen: 'frames' }), 1));
  s.apply(at(frameEv(10000, 'Agenda'), 2));
  s.apply(at(frameEv(20000, 'Gone from Voice'), 3));
  const newer = at(frameEv(40000, 'After the head'), 9);
  s.apply(newer);
  const newerTick = s.meeting(M).frames.find((f) => f.id === 'f-000040000').changed;
  const snap = {
    meeting: { id: M, title: 'Weekly with Anna', startedAt: 1793000000000, tracks: ['mic', 'call'], screen: 'frames', startedBy: 'rukoo', context: null, state: 'recording', endedAt: null },
    speakers: [],
    passages: [],
    marks: [],
    frames: [
      { id: 'f-000010000', at: 10000, width: 1920, height: 1080, text: '', textOmitted: true },
      { id: 'f-000030000', at: 30000, width: 1920, height: 1080, text: '', textOmitted: true },
      { id: 'f-000035000', at: 35000, width: 2560, height: 1440, text: 'Slide 2' },
      { id: 'bad', at: -1, width: 1, height: 1, text: '' }
    ],
    head: 8
  };
  assert.equal(s.applySnapshot(M, snap, [newer]).kind, 'snapshot');
  const frames = s.meeting(M).frames;
  assert.deepEqual(
    frames.map((f) => [f.id, f.text, f.textOmitted === true]),
    [
      ['f-000010000', 'Agenda', false],
      ['f-000030000', '', true],
      ['f-000035000', 'Slide 2', false],
      ['f-000040000', 'After the head', false]
    ]
  );
  // Not a new change: a meeting chat that read it doesn't hear of it again.
  assert.equal(frames[3].changed, newerTick, 'the frame newer than the snapshot keeps its tick');
  // frame.get brings the text later; it moves the meeting's rev for the renderer, but not the frame's tick.
  const rev = s.meeting(M).rev;
  const tick = frames[1].changed;
  assert.deepEqual(s.frameText(M, { id: 'f-000030000', at: 30000, width: 1920, height: 1080, text: 'Budget' }), { meeting: M, kind: 'frame', id: 'f-000030000' });
  const filled = s.meeting(M).frames[1];
  assert.deepEqual([filled.text, filled.textOmitted, filled.changed], ['Budget', undefined, tick]);
  assert.ok(s.meeting(M).rev > rev);
  assert.equal(s.frameText(M, { id: 'f-000030000', text: 'Again' }), null, 'only a frame without its text');
  assert.equal(s.frameText(M, null), null);
  // A second snapshot that leaves the text out again keeps it, and an older Voice's snapshot keeps every frame.
  s.applySnapshot(M, { ...snap, head: 9 });
  assert.equal(s.meeting(M).frames.find((f) => f.id === 'f-000030000').text, 'Budget');
  assert.deepEqual(s.meeting(M).frames.map((f) => f.id), ['f-000010000', 'f-000030000', 'f-000035000'], 'gone after the head that covers it');
  const { frames: _, ...older } = snap;
  s.applySnapshot(M, { ...older, head: 10 });
  assert.equal(s.meeting(M).frames.length, 3);
});

test("Voice's screen default is kept with the status, and anything but a screen mode reads as unknown", () => {
  const dir = tempDir('rukoo-voice-store-');
  const s = store(dir);
  assert.deepEqual(s.status(), { recording: null, dictating: false, screenDefault: null });
  assert.equal(s.setStatus({ recording: null, dictating: false, screenDefault: 'frames' }), true, 'a new default alone is a change');
  assert.equal(s.setStatus({ recording: null, dictating: false, screenDefault: 'frames' }), false);
  assert.equal(s.status().screenDefault, 'frames');
  // A recording keeps the default it had.
  s.apply(started());
  s.apply(ev('meeting.state', M, { state: 'recording', at: 0 }));
  assert.deepEqual(s.status(), { recording: M, dictating: false, screenDefault: 'frames' });
  s.close();
  assert.equal(store(dir).status().screenDefault, 'frames', 'saved in voice.json');
  const odd = store();
  odd.setStatus({ recording: null, dictating: false, screenDefault: '4k' });
  assert.equal(odd.status().screenDefault, null);
  // An older Voice says nothing about it.
  odd.welcome({ type: 'welcome', protocol: 1, voiceVersion: '0.1.0', instance: 'Vb3kQ9m2X7pL1sR4tY8wZQ', head: 1, oldest: 1, replay: 'full', status: { recording: null, dictating: false } });
  assert.equal(odd.status().screenDefault, null);
  assert.equal(odd.isReplay(1), true);
  assert.equal(odd.isReplay(2), false);
  assert.equal(odd.isReplay(undefined), false);
});

test('three voices on the call keep their names by id, through a snapshot, a restart and a passage that gets its voice later', () => {
  const dir = tempDir('rukoo-voice-store-');
  const s = store(dir);
  s.apply(started());
  for (const [id, track, label] of [['mic', 'mic', 'You'], ['call-1', 'call', 'Speaker 1'], ['call-10', 'call', 'Speaker 10'], ['call-2', 'call', 'Speaker 2']]) s.apply(ev('speaker', M, { id, track, label }));
  s.setName(M, 'call-1', { name: 'Anna de Vries', address: 'anna@example.com', from: 'calendar' });
  s.setName(M, 'call-2', { name: 'Sanne de Vries', address: 'sanne@example.com', from: 'user' });
  s.apply(passage('call', 101000, "Okay, let's look at the numbers.", 1, { speaker: null }));
  const names = (x) => Object.fromEntries(x.meeting(M).speakers.map((v) => [v.id, v.name]));
  const whose = (x) => {
    const m = x.meeting(M);
    const p = m.passages.find((q) => q.id === 'call-000101000');
    return p.speaker === null ? null : m.speakers.find((v) => v.id === p.speaker).name;
  };
  assert.equal(whose(s), null, 'Voice does not know yet');
  // Voice settles the speaker: the same passage, a new revision.
  s.apply(passage('call', 101000, "Okay, let's look at the numbers.", 2, { speaker: 'call-2' }));
  assert.equal(whose(s), 'Sanne de Vries');
  // A snapshot lists the speakers in another order; the names stay on their ids.
  s.applySnapshot(M, {
    meeting: { id: M, title: 'Weekly with Anna', startedAt: 1793000000000, tracks: ['mic', 'call'], screen: 'off', startedBy: 'rukoo', context: null, state: 'recording', endedAt: null },
    speakers: [{ id: 'call-2', track: 'call', label: 'Speaker 2' }, { id: 'call-10', track: 'call', label: 'Speaker 10' }, { id: 'mic', track: 'mic', label: 'You' }, { id: 'call-1', track: 'call', label: 'Speaker 1' }],
    passages: [{ ...passage('call', 101000, "Okay, let's look at the numbers.", 2, { speaker: 'call-2' }).data }],
    marks: [],
    head: 99
  });
  assert.deepEqual(names(s), { 'call-2': 'Sanne de Vries', 'call-10': null, mic: null, 'call-1': 'Anna de Vries' });
  assert.equal(whose(s), 'Sanne de Vries');
  s.close();
  const again = store(dir);
  assert.deepEqual(names(again), { 'call-2': 'Sanne de Vries', 'call-10': null, mic: null, 'call-1': 'Anna de Vries' });
  assert.equal(whose(again), 'Sanne de Vries');
});

test('the order of speakers: the microphone, then the call by number, so call-2 comes before call-10', () => {
  const list = [{ id: 'call-10', track: 'call' }, { id: 'call-2', track: 'call' }, { id: 'mic', track: 'mic' }, { id: 'call-x', track: 'call' }, { id: 'call-1', track: 'call' }];
  assert.deepEqual([...list].sort(compareSpeakers).map((x) => x.id), ['mic', 'call-1', 'call-2', 'call-10', 'call-x']);
  assert.equal(speakerOrder('call-10'), 10);
  assert.equal(speakerOrder('call-01'), Infinity, 'not a number Voice gives');
  assert.equal(speakerOrder('mic'), Infinity);
});

test('with three voices on the call, a guest one of them already has is marked for the others and offered last', () => {
  const standup = { id: 'e1', start: 0, end: 900000, meeting: 'x', attendees: [{ name: 'Demo User', address: 'demo@example.com', response: 'accepted', self: true }, { name: 'Joris Bakker', address: 'joris@example.com', response: 'tentative' }, { name: 'Sanne de Vries', address: 'sanne@example.com', response: 'accepted' }] };
  const speakers = [
    { id: 'call-10', track: 'call', name: null, address: null },
    { id: 'mic', track: 'mic', name: null, address: null },
    { id: 'call-2', track: 'call', name: 'Sanne de Vries', address: 'sanne@example.com' },
    { id: 'call-1', track: 'call', name: null, address: null }
  ];
  const offered = (out, id) => out.suggestions[id].map((c) => [c.name, c.takenBy]);
  const out = suggest(speakers, standup);
  assert.deepEqual(Object.keys(out.suggestions), ['call-1', 'call-2', 'call-10'], 'the call only, in order');
  assert.deepEqual(offered(out, 'call-1'), [['Joris Bakker', []], ['Sanne de Vries', ['call-2']]]);
  assert.deepEqual(offered(out, 'call-10'), [['Joris Bakker', []], ['Sanne de Vries', ['call-2']]]);
  assert.deepEqual(offered(out, 'call-2'), [['Sanne de Vries', []], ['Joris Bakker', []]], 'its own name is not taken from itself');
  assert.deepEqual(out.auto, {});
  // A typed name without an address matches by name; addresses match whatever their case.
  const typed = suggest([{ id: 'call-1', track: 'call', name: 'joris bakker', address: null }, { id: 'call-2', track: 'call', name: 'S. de Vries', address: 'SANNE@example.com' }, { id: 'call-3', track: 'call', name: null }], standup);
  assert.deepEqual(offered(typed, 'call-3'), [['Sanne de Vries', ['call-2']], ['Joris Bakker', ['call-1']]]);
  // One guest and three voices: nobody gets a name by itself.
  const oneOnOne = { ...standup, attendees: [standup.attendees[0], standup.attendees[2]] };
  assert.deepEqual(suggest(speakers.map((x) => ({ ...x, name: null, address: null })), oneOnOne).auto, {}, 'three voices: the user picks');
});
