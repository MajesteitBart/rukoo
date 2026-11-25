'use strict';

// What Rukoo keeps of Rukoo Voice's meetings, in the profile's data folder:
//
//   voice.json              the event cursor (instance, lastSeq), Voice's last known status and an index of meetings
//   meetings/<id>.json      per meeting: a cache of what Voice sent (speakers, passages, marks, frames) and what
//                           Rukoo owns (speaker names, notes, corrections, the linked calendar event)
//
// The cache lets the meeting view and the agent's tools work while Voice is closed. It goes when Voice removes the
// meeting (meeting.removed); the user's notes stay. Applying an event twice gives the same result, so a replay that
// overlaps what Rukoo has is harmless.
//
// tick is Rukoo's own change counter: every change to a passage, mark or frame takes the next number. It orders what
// the agent has read (read_meeting_transcript's cursor) and what the renderer has shown, and unlike Voice's seq it
// never starts again when Voice's data folder does. When voice.json is lost it resumes, for each meeting, above the
// ticks in that meeting's file before the meeting changes again (data()).
//
// A meeting.get snapshot can leave out the text of older frames to stay under Voice's reply limit ("textOmitted"). A
// frame Rukoo already has keeps its text; one it hasn't seen keeps textOmitted until frame.get brings the text
// (frameText()).
//
// What Rukoo owns of a meeting also reaches the user's other computers, through Voice's bucket (voice/PROTOCOL.md,
// meeting.data). Each field carries a stamp: when it changed (wall ms) and on which device. dataDoc() is this computer's
// view of every stamped field, which Voice uploads; applyData() takes another computer's view field by field, the later
// change winning. Notes changed on two computers before either heard of the other keep both texts: the newer one is
// the notes, the other waits in notesOther until the user picks.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { validate, isMeetingId, STATES, SCREENS } = require('./protocol');
const { screenAt } = require('./screen');

const VERSION = 1;
const SAVE_MS = 400;
const RETRY_MS = 2000;
const NAME_MAX = 200;
const ADDRESS_MAX = 320;
const NOTES_MAX = 100000;
const CORRECTION_MAX = 20000;
const EVENT_ID_MAX = 4000;
const ENDED = new Set(['processing', 'done', 'failed']);
const NAME_SOURCES = new Set(['calendar', 'user', 'auto', 'agent']);
const DATA_VERSION = 1;
// The fields of a meeting's data document, and the ids in a name or correction key: Voice's speaker and passage ids.
const DATA_KEY = /^(?:title|event|notes|you|joined|name:[A-Za-z0-9_-]{1,64}|correction:[A-Za-z0-9_-]{1,64})$/;
const DEVICE = /^[0-9a-f]{32}$/;
const DEVICE_NAME_MAX = 100;

const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const int = (v, fallback = 0) => (Number.isInteger(v) && v >= 0 ? v : fallback);
const text = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

// The screen a meeting gets when meeting.start leaves it out, as Voice said; null when Voice didn't say.
const screenDefault = (v) => (SCREENS.includes(v) ? v : null);

function emptyIndex() {
  return { version: VERSION, instance: null, lastSeq: 0, tick: 0, device: null, status: { recording: null, dictating: false, screenDefault: null }, meetings: {}, deleted: {}, unsent: {}, data: 1 };
}

// A frame as Rukoo keeps it. textOmitted: Voice left the text out of a snapshot, and Rukoo doesn't have it yet.
function frameEntry(d, changed, textOmitted = false) {
  const f = { id: d.id, at: d.at, width: d.width, height: d.height, text: textOmitted ? '' : d.text, changed };
  if (textOmitted) f.textOmitted = true;
  return f;
}

// What Rukoo owns of the microphone (voice/PROTOCOL.md speakers.split). Voice can split it into mic, mic-2, mic-3;
// you: which of those is the user, joined: whether the view shows them as one voice again, voices: how many voices the
// split found, or null before Voice split it.
function emptyMic() {
  return { you: 'mic', joined: false, voices: null };
}

// stamps: when each field Rukoo owns last changed, {at, by, base?} by key (DATA_KEY); notesOther: the notes another
// computer changed at the same time, {text, at, device}, with this computer's own stamp when they are notes written here
// that lost (they still go to the other computers, so the conflict shows there too) or replaced: true after Use it
// instead; notesDismissed: the other notes the user let go, {at, text}, so a replay doesn't bring them back; notesFrom:
// the revision of the notes another computer wrote, {rev, at, device}, while no edit here followed it; dataRev counts
// this computer's changes, dataSent the last one Voice took.
function emptyMeeting(id) {
  return { version: VERSION, id, speakers: {}, passages: {}, marks: {}, frames: {}, names: {}, notes: null, corrections: {}, correctedEnds: {}, mic: emptyMic(), stamps: {}, notesOther: null, notesFrom: null, dataRev: 0, dataSent: 0 };
}

// A stamp as stored or as another computer sent it, or null.
function stampOf(v) {
  if (!isObj(v) || !Number.isInteger(v.at) || v.at < 0 || typeof v.by !== 'string' || !v.by || v.by.length > 64) return null;
  const s = { at: v.at, by: v.by };
  if (Number.isInteger(v.base) && v.base >= 0) s.base = v.base;
  return s;
}

// Whether stamp a is a later change than b: the later time, and on a tie the larger device id, so every computer
// picks the same one.
const later = (a, b) => !b || a.at > b.at || (a.at === b.at && a.by > b.by);

const MIC_VOICE = /^mic(?:-[1-9]\d{0,2})?$/;

// The other notes as the meeting view gets them: without the stamp they keep for the other computers.
function notesOtherView(o, deviceName) {
  const { stamp, ...view } = o;
  return { ...view, mine: o.device === deviceName };
}

function normalizeMic(raw) {
  const m = emptyMic();
  if (!isObj(raw)) return m;
  if (typeof raw.you === 'string' && MIC_VOICE.test(raw.you)) m.you = raw.you;
  m.joined = raw.joined === true;
  if (Number.isInteger(raw.voices) && raw.voices >= 1) m.voices = raw.voices;
  return m;
}

// The order of a microphone voice's id: mic, then mic-2, mic-3, …
function micOrder(id) {
  const n = /^mic-([1-9]\d*)$/.exec(id);
  return id === 'mic' ? 1 : n ? Number(n[1]) : Infinity;
}

// The microphone as the view shows it. Before a split, and when the user joined it again, it is one voice: the user.
// After a split each voice at the microphone is a speaker; the one the user chose (else mic) is the user, and the
// others get letters in id order (Speaker A, Speaker B), so they don't clash with the call's numbers.
function micView(m) {
  const ids = Object.values(m.speakers)
    .filter((s) => s.track === 'mic')
    .map((s) => s.id)
    .sort((a, b) => micOrder(a) - micOrder(b));
  const split = ids.some((id) => id !== 'mic');
  const you = split && ids.includes(m.mic.you) ? m.mic.you : 'mic';
  const joined = split && m.mic.joined;
  const letters = {};
  if (split && !joined) ids.filter((id) => id !== you).forEach((id, i) => (letters[id] = String.fromCharCode(65 + Math.min(i, 25))));
  return { you, joined, split, voices: m.mic.voices, letters };
}

// An index entry with every field, from what was stored or what Voice sent.
function indexEntry(id, v = {}) {
  return {
    id,
    title: typeof v.title === 'string' ? v.title : '',
    ownTitle: typeof v.ownTitle === 'string' ? Array.from(v.ownTitle).slice(0, 200).join('') : null,
    startedAt: Number.isInteger(v.startedAt) ? v.startedAt : null,
    endedAt: Number.isInteger(v.endedAt) ? v.endedAt : null,
    state: STATES.includes(v.state) ? v.state : null,
    reason: typeof v.reason === 'string' ? v.reason : null,
    at: int(v.at, 0),
    tracks: Array.isArray(v.tracks) ? v.tracks.filter((t) => t === 'mic' || t === 'call') : [],
    screen: typeof v.screen === 'string' ? v.screen : 'off',
    currentScreen: SCREENS.includes(v.currentScreen) ? v.currentScreen : SCREENS.includes(v.screen) ? v.screen : 'off',
    startedBy: v.startedBy === 'rukoo' ? 'rukoo' : 'voice',
    context: isObj(v.context) ? v.context : null,
    eventId: typeof v.eventId === 'string' && v.eventId ? v.eventId.slice(0, EVENT_ID_MAX) : null,
    rev: int(v.rev, 0),
    removed: v.removed === true
  };
}

// A meeting file as stored: anything that isn't the right shape goes, the rest stays.
function normalizeMeeting(id, raw) {
  const m = emptyMeeting(id);
  const map = (o, keep) => {
    const out = {};
    if (isObj(o)) for (const [k, v] of Object.entries(o)) if (isObj(v) && keep(v)) out[k] = v;
    return out;
  };
  m.speakers = map(raw.speakers, (v) => typeof v.id === 'string');
  m.passages = map(raw.passages, (v) => typeof v.id === 'string' && typeof v.text === 'string' && Number.isInteger(v.start));
  m.marks = map(raw.marks, (v) => typeof v.id === 'string' && Number.isInteger(v.at));
  m.frames = map(raw.frames, (v) => typeof v.id === 'string' && Number.isInteger(v.at));
  m.names = map(raw.names, (v) => typeof v.name === 'string');
  m.notes = isObj(raw.notes) && typeof raw.notes.text === 'string' ? { text: raw.notes.text, rev: int(raw.notes.rev, 0), updatedAt: int(raw.notes.updatedAt, 0) } : null;
  if (isObj(raw.corrections)) for (const [k, v] of Object.entries(raw.corrections)) if (typeof v === 'string') m.corrections[k] = v;
  // Where a corrected passage ended when the user corrected it, and the change number then (meeting(): a split that
  // cuts it). A correction from before Rukoo kept these gets them now: no split has cut it yet.
  if (isObj(raw.correctedEnds)) for (const [k, v] of Object.entries(raw.correctedEnds)) if (Object.hasOwn(m.corrections, k) && isObj(v) && Number.isInteger(v.end) && Number.isInteger(v.at)) m.correctedEnds[k] = { end: v.end, at: v.at };
  const newest = Object.values(m.passages).reduce((n, p) => Math.max(n, int(p.changed), int(p.added)), 0);
  for (const k of Object.keys(m.corrections)) if (!m.correctedEnds[k] && m.passages[k] && Number.isInteger(m.passages[k].end)) m.correctedEnds[k] = { end: m.passages[k].end, at: newest };
  m.mic = normalizeMic(raw.mic);
  if (isObj(raw.stamps)) for (const [k, v] of Object.entries(raw.stamps)) if (DATA_KEY.test(k) && stampOf(v)) m.stamps[k] = stampOf(v);
  if (isObj(raw.notesOther) && typeof raw.notesOther.text === 'string') {
    m.notesOther = { text: text(raw.notesOther.text, NOTES_MAX), at: int(raw.notesOther.at, 0), device: text(raw.notesOther.device, DEVICE_NAME_MAX) };
    if (raw.notesOther.replaced === true) m.notesOther.replaced = true;
    if (stampOf(raw.notesOther.stamp)) m.notesOther.stamp = stampOf(raw.notesOther.stamp);
  }
  if (isObj(raw.notesDismissed) && Number.isInteger(raw.notesDismissed.at) && typeof raw.notesDismissed.text === 'string') m.notesDismissed = { at: raw.notesDismissed.at, text: text(raw.notesDismissed.text, NOTES_MAX) };
  if (isObj(raw.notesFrom) && Number.isInteger(raw.notesFrom.rev)) m.notesFrom = { rev: raw.notesFrom.rev, at: int(raw.notesFrom.at, 0), device: text(raw.notesFrom.device, DEVICE_NAME_MAX) };
  m.dataRev = int(raw.dataRev, 0);
  m.dataSent = Math.min(int(raw.dataSent, 0), m.dataRev);
  return m;
}

class VoiceStore {
  constructor({ dataDir, now = Date.now, saveMs = SAVE_MS, log = () => {}, deviceName = os.hostname() } = {}) {
    this.file = path.join(dataDir, 'voice.json');
    this.dir = path.join(dataDir, 'meetings');
    this.now = now;
    // Shown with notes another computer changed at the same time.
    this.deviceName = text(deviceName, DEVICE_NAME_MAX);
    // Told when the user changed something Rukoo owns, so it can go to Voice and the other computers.
    this.onOwnChange = null;
    this.saveMs = saveMs;
    this.log = log;
    this.index = emptyIndex();
    // Meeting files read so far, by id.
    this.cache = new Map();
    // Meetings whose file was damaged and set aside: Voice can send them again (meeting.get).
    this.damaged = new Set();
    // Told when a meeting file turns out damaged as it is read, so Voice can be asked for the meeting at once.
    this.onDamaged = null;
    this.dirty = new Set();
    this.indexDirty = false;
    this.timer = null;
    this.closed = false;
  }

  // ---------- loading and saving ----------

  // A file Rukoo can't read is kept aside as <file>.bad-<ms> and never overwritten; Rukoo starts that part empty.
  keepAside(file) {
    try {
      fs.renameSync(file, `${file}.bad-${this.now()}`);
    } catch (_) {
      // Already gone.
    }
  }

  readJson(file) {
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') return undefined;
      this.log('store', `${path.basename(file)} is damaged; kept aside`);
      this.keepAside(file);
      return null;
    }
    if (!isObj(raw)) {
      this.log('store', `${path.basename(file)} is not a store; kept aside`);
      this.keepAside(file);
      return null;
    }
    return raw;
  }

  load() {
    const raw = this.readJson(this.file);
    const index = emptyIndex();
    if (raw && isObj(raw.meetings)) {
      index.instance = typeof raw.instance === 'string' ? raw.instance : null;
      index.lastSeq = int(raw.lastSeq, 0);
      index.tick = int(raw.tick, 0);
      index.device = typeof raw.device === 'string' && DEVICE.test(raw.device) ? raw.device : null;
      if (isObj(raw.deleted)) for (const [id, deleted] of Object.entries(raw.deleted)) if (isMeetingId(id) && deleted === true) index.deleted[id] = true;
      const st = isObj(raw.status) ? raw.status : {};
      index.status = { recording: isMeetingId(st.recording) ? st.recording : null, dictating: st.dictating === true, screenDefault: screenDefault(st.screenDefault) };
      for (const [id, v] of Object.entries(raw.meetings)) if (isMeetingId(id) && isObj(v) && !index.deleted[id]) index.meetings[id] = indexEntry(id, v);
      // Meetings with changes Voice hasn't taken yet, so a connection sends them without reading every meeting file.
      if (isObj(raw.unsent)) for (const id of Object.keys(raw.unsent)) if (index.meetings[id]) index.unsent[id] = true;
      index.data = raw.data === 1 ? 1 : 0;
    } else if (raw) {
      this.keepAside(this.file);
    }
    // Which device made a change, in the stamps of what Rukoo owns. Made once per profile.
    if (!index.device) {
      index.device = crypto.randomBytes(16).toString('hex');
      this.indexDirty = true;
    }
    this.index = index;
    if (!index.data) this.catchUpData();
    // The cursor on disk: Voice replays after it, so it only moves once every meeting file before it is written.
    this.savedCursor = { instance: index.instance, lastSeq: index.lastSeq };
    if (this.indexDirty) this.scheduleSave();
    return this;
  }

  // Once, for a profile from before Rukoo synced what it owns. Its cursor may have passed meeting.data events it didn't
  // read: Voice sends everything again, which applies as before. What the user changed then has no stamp: it gets one
  // now, older than any change made since (notes: when they were saved), so a computer without it takes it and a later
  // change anywhere wins, and notes written on two computers both stay.
  catchUpData() {
    this.index.lastSeq = 0;
    const seed = (m, key) => {
      if (m.stamps[key]) return false;
      m.stamps[key] = { at: key === 'notes' ? Math.max(1, m.notes.updatedAt) : 1, by: this.index.device };
      return true;
    };
    for (const [id, e] of Object.entries(this.index.meetings)) {
      if (e.removed) continue;
      const m = this.data(id);
      if (!m) continue;
      let seeded = false;
      if (e.ownTitle) seeded = seed(m, 'title') || seeded;
      // A link from the meeting's start comes with Voice's meeting on every computer; only one the user chose is theirs.
      if (e.eventId && e.eventId !== (e.context && e.context.calendarEvent)) seeded = seed(m, 'event') || seeded;
      if (m.notes && m.notes.text.trim()) seeded = seed(m, 'notes') || seeded;
      if (m.mic.you !== 'mic') seeded = seed(m, 'you') || seeded;
      if (m.mic.joined) seeded = seed(m, 'joined') || seeded;
      for (const sid of Object.keys(m.names)) if (/^[A-Za-z0-9_-]{1,64}$/.test(sid)) seeded = seed(m, `name:${sid}`) || seeded;
      for (const pid of Object.keys(m.corrections)) if (/^[A-Za-z0-9_-]{1,64}$/.test(pid)) seeded = seed(m, `correction:${pid}`) || seeded;
      if (seeded) {
        m.dataRev += 1;
        this.index.unsent[id] = true;
        this.dirty.add(id);
      }
    }
    this.index.data = 1;
    this.indexDirty = true;
    this.unsentDirty = true;
  }

  meetingFile(id) {
    return path.join(this.dir, `${id}.json`);
  }

  // The meeting's file, read once. null for an id that isn't a meeting id, so nothing outside meetings/ is touched.
  // A removed meeting stays in the cache as null until its file is gone.
  data(id, create = false) {
    if (!isMeetingId(id)) return null;
    let m = this.cache.get(id);
    if (m) return m;
    if (this.cache.has(id)) {
      if (!create) return null;
      m = emptyMeeting(id);
      this.cache.set(id, m);
      return m;
    }
    const raw = this.readJson(this.meetingFile(id));
    if (raw === null) {
      this.damaged.add(id);
      if (this.onDamaged) this.onDamaged(id);
    }
    if (!raw && !create && !this.index.meetings[id]) return null;
    m = raw ? normalizeMeeting(id, raw) : emptyMeeting(id);
    this.cache.set(id, m);
    // voice.json can be lost, set aside or older than this file (a crash between the two saves) while a chat's
    // cursor still holds this file's ticks: the meeting's next change must still count as new.
    let top = 0;
    for (const v of [...Object.values(m.passages), ...Object.values(m.marks), ...Object.values(m.frames)]) top = Math.max(top, int(v.changed), int(v.added));
    if (top > this.index.tick) {
      this.index.tick = top;
      this.indexDirty = true;
    }
    return m;
  }

  scheduleSave() {
    if (this.timer || this.closed) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.save();
    }, this.saveMs);
    if (this.timer.unref) this.timer.unref();
  }

  // The meetings first, then the index with the cursor, so a crash in between leaves the cursor behind the data
  // and Voice's replay applies the same events again. A meeting that fails to save keeps the cursor on disk where it
  // was: otherwise a restart would ask Voice only for what came after events that never reached the meeting's file.
  save() {
    let failed = false;
    // Changes Voice hasn't taken go into voice.json before the meeting files that hold them, with the cursor as it was,
    // so a crash in between never leaves one that no connection sends.
    if (this.unsentDirty) {
      try {
        writeAtomic(this.file, { ...this.index, ...this.savedCursor });
        this.unsentDirty = false;
      } catch (err) {
        this.log('store', `saving voice.json failed: ${err.message}`);
        this.retrySave();
        return;
      }
    }
    for (const id of [...this.dirty]) {
      this.dirty.delete(id);
      const m = this.cache.get(id);
      try {
        if (m) writeAtomic(this.meetingFile(id), m);
        else fs.rmSync(this.meetingFile(id), { force: true });
      } catch (err) {
        this.log('store', `saving ${id} failed: ${err.message}`);
        this.dirty.add(id);
        failed = true;
      }
    }
    if (failed) this.indexDirty = true;
    if (this.indexDirty) {
      this.indexDirty = false;
      const cursor = failed ? this.savedCursor : { instance: this.index.instance, lastSeq: this.index.lastSeq };
      try {
        writeAtomic(this.file, { ...this.index, ...cursor });
        this.savedCursor = cursor;
      } catch (err) {
        this.log('store', `saving voice.json failed: ${err.message}`);
        this.indexDirty = true;
        failed = true;
      }
      if (failed) this.indexDirty = true;
    }
    if (failed) this.retrySave();
  }

  // A failed save tries again a little later, so a file another program held open is written once it lets go.
  retrySave() {
    if (this.retryTimer || this.closed) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.save();
    }, RETRY_MS);
    if (this.retryTimer.unref) this.retryTimer.unref();
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.save();
  }

  close() {
    this.flush();
    this.closed = true;
  }

  touchIndex() {
    this.indexDirty = true;
    this.scheduleSave();
  }

  touchMeeting(id) {
    this.dirty.add(id);
    this.scheduleSave();
  }

  nextTick() {
    this.index.tick += 1;
    this.indexDirty = true;
    return this.index.tick;
  }

  // ---------- the cursor ----------

  cursor() {
    return { instance: this.index.instance, after: this.index.lastSeq };
  }

  // Voice's welcome. Another instance means another data folder, whose numbers start again: the cursor follows it.
  // The meetings Rukoo has stay, keyed by id. A full or gap replay sends every stored event from oldest, so the
  // cursor goes back to just before it. {reset, gap}.
  welcome(msg) {
    const reset = this.index.instance !== null && this.index.instance !== msg.instance;
    this.index.instance = msg.instance;
    if (msg.replay !== 'partial') this.index.lastSeq = Math.max(0, msg.oldest - 1);
    // What records now is the welcome's status. The replay that follows is history up to this head: an older
    // meeting's states in it must not move the status, or Rukoo would show itself in a screen recording mid-meeting.
    this.replayHead = Number.isInteger(msg.head) ? msg.head : 0;
    this.setStatus(msg.status);
    this.touchIndex();
    return { reset, gap: msg.replay === 'gap' };
  }

  setStatus(status) {
    const recording = status && isMeetingId(status.recording) ? status.recording : null;
    const dictating = Boolean(status && status.dictating === true);
    const screen = screenDefault(status && status.screenDefault);
    const now = this.index.status;
    if (now.recording === recording && now.dictating === dictating && now.screenDefault === screen) return false;
    this.index.status = { recording, dictating, screenDefault: screen };
    this.touchIndex();
    return true;
  }

  status() {
    return { ...this.index.status };
  }

  // Whether an event is part of the replay that follows the welcome, up to its head: history, not what happens now.
  isReplay(seq) {
    return Number.isInteger(seq) && seq <= (this.replayHead || 0);
  }

  // ---------- Voice's events ----------

  ensureEntry(id) {
    let e = this.index.meetings[id];
    if (!e) {
      e = indexEntry(id);
      this.index.meetings[id] = e;
    }
    if (e.removed) e.removed = false;
    return e;
  }

  // Applies one validated event. Returns {meeting, kind, id} for what changed, or null when nothing did (a repeat,
  // an older revision, an event type Rukoo doesn't know).
  apply(ev) {
    if (Number.isInteger(ev.seq) && ev.seq > this.index.lastSeq) {
      this.index.lastSeq = ev.seq;
      this.touchIndex();
    }
    const id = ev.meeting;
    // A user deletion is permanent. Replays and snapshots already in flight cannot put its data back.
    if (id && this.index.deleted[id]) return null;
    const d = ev.data;
    const live = !this.isReplay(ev.seq);
    switch (ev.event) {
      case 'status':
        return live && this.setStatus(d) ? { meeting: null, kind: 'status' } : null;
      case 'meeting.started':
        return this.started(id, d);
      case 'meeting.state':
        return this.stateChanged(id, d, live);
      case 'speaker':
        return this.speaker(id, d);
      case 'passage':
        return this.passage(id, d);
      case 'passage.removed':
        return this.passageRemoved(id, d.id);
      case 'mark':
        return this.mark(id, d);
      case 'frame':
        return this.frame(id, d);
      case 'meeting.removed':
        return this.remove(id, { purge: d.reason === 'user' }) ? { meeting: id, kind: 'removed' } : null;
      case 'meeting.data':
        return this.applyData(id, d.data);
      default:
        return null;
    }
  }

  started(id, d) {
    const e = this.ensureEntry(id);
    const before = JSON.stringify(e);
    Object.assign(e, { title: d.title, startedAt: d.startedAt, tracks: d.tracks.slice(), screen: d.screen, startedBy: d.startedBy, context: d.context });
    e.currentScreen = screenAt(e, Object.values(this.data(id)?.marks || {})).screen;
    // A meeting Rukoo started from a calendar event carries it in context; the user can link another later. A link the
    // user changed or removed, here or on another computer, stays as they left it when Voice sends the start again.
    const linked = this.data(id)?.stamps.event;
    if (!e.eventId && !linked && d.context && typeof d.context.calendarEvent === 'string' && d.context.calendarEvent) e.eventId = d.context.calendarEvent.slice(0, EVENT_ID_MAX);
    if (!e.state) e.state = 'recording';
    return this.entryChanged(e, before);
  }

  // live: the event came after the welcome's head, so it tells what happens now rather than replaying history.
  stateChanged(id, d, live = true) {
    const e = this.ensureEntry(id);
    const before = JSON.stringify(e);
    Object.assign(e, { state: d.state, at: d.at, endedAt: ENDED.has(d.state) ? d.endedAt : null, reason: d.reason == null ? null : d.reason });
    // Fail closed: what records now is known the moment Voice says so, and a meeting that ended no longer records,
    // also when the status event that says it is still to come.
    if (live && (d.state === 'recording' || d.state === 'paused')) this.setStatus({ ...this.index.status, recording: id });
    else if (live && this.index.status.recording === id) this.setStatus({ ...this.index.status, recording: null });
    return this.entryChanged(e, before);
  }

  entryChanged(e, before) {
    if (JSON.stringify(e) === before) return null;
    e.rev = this.nextTick();
    this.touchIndex();
    return { meeting: e.id, kind: 'meeting' };
  }

  // Something in the meeting's file changed: the meeting's rev follows, for the renderer.
  meetingChanged(id, tick = this.nextTick()) {
    const e = this.ensureEntry(id);
    e.rev = tick;
    this.touchIndex();
    this.touchMeeting(id);
    return tick;
  }

  speaker(id, d) {
    const m = this.data(id, true);
    const next = { id: d.id, track: d.track, label: d.label };
    if (JSON.stringify(m.speakers[d.id]) === JSON.stringify(next)) return null;
    m.speakers[d.id] = next;
    this.meetingChanged(id);
    return { meeting: id, kind: 'speaker', id: d.id };
  }

  passage(id, d) {
    const m = this.data(id, true);
    const old = m.passages[d.id];
    // A higher revision replaces the passage Rukoo has; an older one that arrives late does not.
    if (old && old.revision > d.revision) return null;
    const next = { id: d.id, track: d.track, speaker: d.speaker, start: d.start, end: d.end, text: d.text, revision: d.revision, dictation: d.dictation, language: d.language };
    if (old && JSON.stringify({ ...old, changed: undefined, added: undefined }) === JSON.stringify({ ...next, changed: undefined, added: undefined })) return null;
    const tick = this.nextTick();
    m.passages[d.id] = { ...next, changed: tick, added: old ? old.added : tick };
    this.meetingChanged(id, tick);
    return { meeting: id, kind: 'passage', id: d.id };
  }

  passageRemoved(id, passageId) {
    const m = this.data(id);
    if (!m || !m.passages[passageId]) return null;
    delete m.passages[passageId];
    delete m.corrections[passageId];
    delete m.correctedEnds[passageId];
    this.meetingChanged(id);
    return { meeting: id, kind: 'passage.removed', id: passageId };
  }

  mark(id, d) {
    const m = this.data(id, true);
    const old = m.marks[d.id];
    const next = { id: d.id, kind: d.kind, at: d.at, until: d.until, track: d.track, detail: d.detail, label: d.label };
    if (old && JSON.stringify({ ...old, changed: undefined }) === JSON.stringify({ ...next, changed: undefined })) return null;
    const tick = this.nextTick();
    m.marks[d.id] = { ...next, changed: tick };
    if (d.kind === 'screen_mode' || (d.track === 'screen' && ['dropped', 'video_dropped'].includes(d.kind))) {
      const entry = this.ensureEntry(id);
      entry.currentScreen = screenAt(entry, Object.values(m.marks)).screen;
    }
    this.meetingChanged(id, tick);
    return { meeting: id, kind: 'mark', id: d.id };
  }

  // A frame event: Voice sends a frame again with the same id, and that changes nothing. textOmitted only comes from
  // a snapshot (applySnapshot).
  frame(id, d, textOmitted = false) {
    const m = this.data(id, true);
    const old = m.frames[d.id];
    const next = frameEntry(d, 0, textOmitted);
    if (old && JSON.stringify({ ...old, changed: 0 }) === JSON.stringify(next)) return null;
    const tick = this.nextTick();
    m.frames[d.id] = { ...next, changed: tick };
    this.meetingChanged(id, tick);
    return { meeting: id, kind: 'frame', id: d.id };
  }

  // The text frame.get brought for a frame a snapshot gave without it. Not a new change for the agent: the transcript
  // never holds screen text, so the frame keeps its tick and only the meeting's rev moves, for the renderer.
  frameText(id, f) {
    const m = isObj(f) && typeof f.id === 'string' && typeof f.text === 'string' ? this.data(id) : null;
    const old = m && m.frames[f.id];
    if (!old || !old.textOmitted) return null;
    m.frames[f.id] = { id: old.id, at: old.at, width: old.width, height: old.height, text: f.text, changed: old.changed };
    this.meetingChanged(id);
    return { meeting: id, kind: 'frame', id: f.id };
  }

  // meeting.get's answer: the current version of everything up to its head. What Rukoo has that the snapshot lacks
  // was removed meanwhile. Items Voice sent that don't pass the protocol's checks are left out, as events would be.
  // later: the events for this meeting Rukoo applied while the answer was on its way. Voice sends its replies and its
  // events separately, so those past head can come first: they are newer than the snapshot and apply again on top.
  applySnapshot(id, snap, later = []) {
    if (this.index.deleted[id]) return null;
    if (!isMeetingId(id) || !isObj(snap)) return null;
    const head = Number.isInteger(snap.head) ? snap.head : Infinity;
    const newer = later.filter((ev) => ev.meeting === id && ev.seq > head);
    // Voice removed the meeting after the snapshot, and Rukoo did too.
    if (newer.some((ev) => ev.event === 'meeting.removed')) return null;
    const fresh = new Set(newer.filter((ev) => ev.event === 'passage' || ev.event === 'mark' || ev.event === 'frame').map((ev) => `${ev.event}:${ev.data.id}`));
    const ok = (event, data) => validate('voice', { type: 'event', seq: 1, event, meeting: id, createdAt: 0, data }).ok;
    const meeting = isObj(snap.meeting) ? snap.meeting : {};
    const e = this.ensureEntry(id);
    const before = JSON.stringify(e);
    if (ok('meeting.started', meeting)) Object.assign(e, { title: meeting.title, startedAt: meeting.startedAt, tracks: meeting.tracks.slice(), screen: SCREENS.includes(meeting.initialScreen) ? meeting.initialScreen : meeting.screen, startedBy: meeting.startedBy, context: meeting.context });
    // The snapshot's meeting has state and endedAt, not always the reason or the moment of the change.
    if (STATES.includes(meeting.state) && (!ENDED.has(meeting.state) || Number.isInteger(meeting.endedAt))) {
      Object.assign(e, {
        state: meeting.state,
        at: Number.isInteger(meeting.at) ? meeting.at : e.at,
        endedAt: ENDED.has(meeting.state) ? meeting.endedAt : null,
        reason: typeof meeting.reason === 'string' ? meeting.reason : ENDED.has(meeting.state) ? e.reason : null
      });
      if (ENDED.has(meeting.state) && this.index.status.recording === id) this.setStatus({ ...this.index.status, recording: null });
    }
    const changed = JSON.stringify(e) !== before;
    const m = this.data(id, true);
    const list = (v) => (Array.isArray(v) ? v : []);
    let touched = false;
    const speakers = {};
    for (const s of list(snap.speakers)) if (ok('speaker', s)) speakers[s.id] = { id: s.id, track: s.track, label: s.label };
    if (JSON.stringify(speakers) !== JSON.stringify(m.speakers)) {
      m.speakers = speakers;
      touched = true;
    }
    const keep = new Set();
    for (const p of list(snap.passages)) {
      if (!ok('passage', p)) continue;
      keep.add(p.id);
      if (this.passage(id, { ...p, revision: Math.max(p.revision, 1) })) touched = true;
    }
    for (const pid of Object.keys(m.passages)) {
      if (!keep.has(pid) && !fresh.has(`passage:${pid}`)) {
        delete m.passages[pid];
        delete m.corrections[pid];
        delete m.correctedEnds[pid];
        touched = true;
      }
    }
    const marks = new Set();
    for (const k of list(snap.marks)) {
      if (!ok('mark', k)) continue;
      marks.add(k.id);
      if (this.mark(id, k)) touched = true;
    }
    for (const kid of Object.keys(m.marks)) {
      if (!marks.has(kid) && !fresh.has(`mark:${kid}`)) {
        delete m.marks[kid];
        touched = true;
      }
    }
    // An older Voice sends no frames: then the frames Rukoo has stay.
    if (Array.isArray(snap.frames)) {
      const frames = new Set();
      for (const f of snap.frames) {
        if (!ok('frame', f)) continue;
        frames.add(f.id);
        const old = m.frames[f.id];
        // Left out to keep the reply small: the text Rukoo had stays, else frame.get brings it later.
        const omitted = f.textOmitted === true;
        if (omitted && old && !old.textOmitted) continue;
        if (this.frame(id, f, omitted)) touched = true;
      }
      for (const fid of Object.keys(m.frames)) {
        if (!frames.has(fid) && !fresh.has(`frame:${fid}`)) {
          delete m.frames[fid];
          touched = true;
        }
      }
    }
    e.currentScreen = SCREENS.includes(meeting.initialScreen) ? meeting.screen : screenAt(e, Object.values(m.marks)).screen;
    // Applying an event twice gives the same result, so what Rukoo had from them comes back as it was.
    for (const ev of newer) if (this.apply(ev)) touched = true;
    this.damaged.delete(id);
    if (!changed && !touched) return null;
    this.meetingChanged(id);
    return { meeting: id, kind: 'snapshot' };
  }

  // Voice removed the meeting: its transcript goes. Notes the user wrote stay, with the meeting marked removed.
  remove(id, { purge = false } = {}) {
    if (!isMeetingId(id)) return false;
    const e = this.index.meetings[id];
    const m = this.data(id);
    if (purge) this.index.deleted[id] = true;
    delete this.index.unsent[id];
    if (!e && !m) {
      if (purge) this.touchIndex();
      return purge;
    }
    if (this.index.status.recording === id) this.setStatus({ ...this.index.status, recording: null });
    if (!purge && m && m.notes && m.notes.text.trim()) {
      const kept = emptyMeeting(id);
      kept.notes = m.notes;
      this.cache.set(id, kept);
      const left = this.ensureEntry(id);
      left.removed = true;
      left.rev = this.nextTick();
    } else {
      // save() deletes the file of a meeting whose cache entry is null.
      this.cache.set(id, null);
      delete this.index.meetings[id];
    }
    this.touchMeeting(id);
    this.touchIndex();
    return true;
  }

  // ---------- what Rukoo owns ----------

  // A change the user made to something Rukoo owns: its stamp says when and here, and it goes to Voice.
  stamp(id, key, extra = {}) {
    const m = this.data(id, true);
    if (!m) return;
    m.stamps[key] = { at: this.now(), by: this.index.device, ...extra };
    this.dataChanged(id, m);
  }

  // The meeting's document changed: it goes to Voice again.
  dataChanged(id, m) {
    m.dataRev += 1;
    if (!this.index.unsent[id]) this.unsentDirty = true;
    this.index.unsent[id] = true;
    this.touchIndex();
    this.touchMeeting(id);
    if (this.onOwnChange) this.onOwnChange(id);
  }

  setTitle(id, value) {
    const e = this.index.meetings[id];
    if (!e || e.removed || typeof value !== 'string') return false;
    const title = value.trim();
    if (!title || Array.from(title).length > 200) return false;
    const before = JSON.stringify(e);
    e.ownTitle = title;
    if (this.entryChanged(e, before)) this.stamp(id, 'title');
    return true;
  }

  // value: {name, address, from} or null to forget the name. Returns false for an unknown meeting or speaker.
  setName(id, speakerId, value) {
    const m = this.data(id);
    if (!m || !this.index.meetings[id] || typeof speakerId !== 'string' || !m.speakers[speakerId]) return false;
    const before = JSON.stringify(m.names[speakerId] || null);
    if (value === null) delete m.names[speakerId];
    else {
      const name = text(value && value.name, NAME_MAX).trim();
      if (!name) delete m.names[speakerId];
      else m.names[speakerId] = { name, address: text(value.address, ADDRESS_MAX).trim(), from: NAME_SOURCES.has(value.from) ? value.from : 'user' };
    }
    this.meetingChanged(id);
    if (JSON.stringify(m.names[speakerId] || null) !== before) this.stamp(id, `name:${speakerId}`);
    return true;
  }

  // Which microphone voice is the user, after a split. false for an unknown meeting or a voice not at the microphone.
  setYou(id, speakerId) {
    const m = this.data(id);
    const s = m && this.index.meetings[id] && typeof speakerId === 'string' ? m.speakers[speakerId] : null;
    if (!s || s.track !== 'mic') return false;
    const named = Boolean(m.names[speakerId]);
    m.mic.you = speakerId;
    // The user isn't one of the people they name.
    delete m.names[speakerId];
    this.meetingChanged(id);
    this.stamp(id, 'you');
    if (named) this.stamp(id, `name:${speakerId}`);
    return true;
  }

  // Shows a split microphone as one voice again (true), or as its voices (false).
  setJoined(id, joined) {
    const m = this.data(id);
    if (!m || !this.index.meetings[id]) return false;
    m.mic.joined = joined === true;
    this.meetingChanged(id);
    this.stamp(id, 'joined');
    return true;
  }

  // Voice split the microphone and found this many voices. A split the user asked for shows them, undoing an earlier
  // join; keepJoined: only the result of a split Rukoo saw before, so a join stays.
  setSplit(id, voices, { keepJoined = false } = {}) {
    const m = this.data(id);
    if (!m || !this.index.meetings[id] || !Number.isInteger(voices) || voices < 1) return false;
    const joined = keepJoined && m.mic.joined;
    if (m.mic.voices === voices && m.mic.joined === joined) return false;
    m.mic.voices = voices;
    m.mic.joined = joined;
    this.meetingChanged(id);
    return true;
  }

  // Saves the notes when rev is the revision the editor started from. {rev} after a save, {conflict: true, rev, text}
  // when someone saved in between, null for an unknown meeting.
  saveNotes(id, value, rev) {
    const m = this.data(id);
    if (!m || !this.index.meetings[id]) return null;
    const current = m.notes ? m.notes.rev : 0;
    // Notes from another computer arrived while the editor here wrote from an older version: the editor's text is
    // saved, and theirs waits beside it, so neither is lost.
    const crossed = rev !== current && m.notesFrom && m.notesFrom.rev === current;
    if (rev !== current && !crossed) return { conflict: true, rev: current, text: m.notes ? m.notes.text : '' };
    if (typeof value === 'string' && value.length > NOTES_MAX) return { tooLong: true, maxLength: NOTES_MAX, rev: current };
    const was = m.notes ? m.notes.text : '';
    const next = text(value, NOTES_MAX);
    if (crossed && next !== was && was.trim()) m.notesOther = { text: was, at: m.notesFrom.at, device: m.notesFrom.device };
    m.notes = { text: next, rev: current + 1, updatedAt: this.now() };
    m.notesFrom = null;
    this.meetingChanged(id);
    // base: the newest version from elsewhere these notes were written from, so another computer can tell a change made
    // at the same time. Edits here one after another keep the base of the first. Written over notes that came meanwhile,
    // they were written from none that computer knows.
    const s = m.stamps.notes;
    const base = crossed || !s ? 0 : s.by === this.index.device ? s.base || 0 : s.at;
    if (m.notes.text !== was) this.stamp(id, 'notes', { base });
    return { rev: m.notes.rev };
  }

  // The notes another computer changed at the same time: 'use' makes them the notes and keeps the replaced ones in
  // their place, 'dismiss' lets them go. Either way the choice is a change of its own.
  resolveNotes(id, action) {
    const m = this.data(id);
    if (!m || !this.index.meetings[id] || !m.notesOther) return null;
    const other = m.notesOther;
    m.notesOther = null;
    if (action === 'use') {
      const current = m.notes ? m.notes.rev : 0;
      const was = m.notes ? m.notes.text : '';
      const wasAt = m.stamps.notes ? m.stamps.notes.at : 0;
      // The notes it replaces wait in their place, so Use it instead takes them back.
      if (was.trim() && was !== other.text) m.notesOther = { text: was, at: wasAt, device: m.notesFrom ? m.notesFrom.device : this.deviceName, replaced: true };
      m.notes = { text: other.text, rev: current + 1, updatedAt: this.now() };
      m.notesFrom = null;
      this.stamp(id, 'notes', { base: Math.max(wasAt, other.at) });
    } else {
      m.notesDismissed = { at: other.at, text: other.text };
      // This computer's own notes that lost stop going to the other computers.
      if (other.stamp) this.dataChanged(id, m);
      else this.touchMeeting(id);
    }
    this.meetingChanged(id);
    return { rev: m.notes ? m.notes.rev : 0 };
  }

  // The user's correction of a passage's text, or null to go back to Voice's. The agent sees it as a change.
  correct(id, passageId, value) {
    const m = this.data(id);
    if (!m || !m.passages[passageId]) return false;
    const tick = this.nextTick();
    if (value === null || value === undefined) {
      delete m.corrections[passageId];
      delete m.correctedEnds[passageId];
    } else {
      m.corrections[passageId] = text(value, CORRECTION_MAX);
      // Editing it again keeps what the correction first covered.
      const was = m.correctedEnds[passageId];
      m.correctedEnds[passageId] = was ? { end: Math.max(was.end, m.passages[passageId].end), at: was.at } : { end: m.passages[passageId].end, at: tick };
    }
    m.passages[passageId].changed = tick;
    this.meetingChanged(id, tick);
    this.stamp(id, `correction:${passageId}`);
    return true;
  }

  setEvent(id, eventId) {
    const e = this.index.meetings[id];
    if (!e) return false;
    const was = e.eventId;
    e.eventId = typeof eventId === 'string' && eventId ? eventId.slice(0, EVENT_ID_MAX) : null;
    e.rev = this.nextTick();
    this.touchIndex();
    if (e.eventId !== was) this.stamp(id, 'event');
    return true;
  }

  // ---------- what Rukoo owns, on the user's other computers ----------

  // The value a data document gives a field.
  ownValue(id, m, key) {
    const e = this.index.meetings[id] || {};
    if (key === 'title') return e.ownTitle ?? null;
    if (key === 'event') return e.eventId ?? null;
    if (key === 'notes') return m.notes ? m.notes.text : '';
    if (key === 'you') return m.mic.you;
    if (key === 'joined') return m.mic.joined;
    if (key.startsWith('name:')) {
      const n = m.names[key.slice(5)];
      return n ? { name: n.name, address: n.address, from: n.from } : null;
    }
    const pid = key.slice('correction:'.length);
    if (!Object.hasOwn(m.corrections, pid)) return null;
    // With the end of what it covers, so a computer that split the passage first hides the same pieces.
    const c = m.correctedEnds[pid];
    return c ? { text: m.corrections[pid], end: c.end } : m.corrections[pid];
  }

  // This computer's view of what Rukoo owns of the meeting, for Voice to upload (voice/PROTOCOL.md, meeting.data.set).
  // null without anything stamped.
  // Notes written here that lost to another computer's go instead of the winner, until the user picks, so that computer
  // shows both too. A document over maxBytes (UTF-8, what one message to Voice can carry) leaves out the oldest
  // corrections, which then stay on this computer, so the rest keeps travelling.
  dataDoc(id, maxBytes = Infinity) {
    const m = this.data(id);
    if (!m || !this.index.meetings[id] || !Object.keys(m.stamps).length) return null;
    const fields = {};
    for (const [key, s] of Object.entries(m.stamps).sort(([a], [b]) => (a < b ? -1 : 1))) fields[key] = { v: this.ownValue(id, m, key), ...s };
    const lost = m.notesOther && m.notesOther.stamp;
    if (lost && fields.notes) fields.notes = { v: m.notesOther.text, ...lost };
    const doc = { v: DATA_VERSION, device: this.index.device, name: this.deviceName, fields };
    let size = Buffer.byteLength(JSON.stringify(doc));
    if (size > maxBytes) {
      const oldest = Object.keys(fields)
        .filter((k) => k.startsWith('correction:'))
        .sort((a, b) => fields[a].at - fields[b].at);
      for (const k of oldest) {
        if (size <= maxBytes) break;
        size -= Buffer.byteLength(JSON.stringify({ [k]: fields[k] })) - 1;
        delete fields[k];
      }
      this.log('store', `${id}: its data is over what one message carries; the oldest corrections stay on this computer`);
    }
    return doc;
  }

  // The meetings with changes Voice hasn't taken yet, and the change count each one's document has.
  unsentData() {
    const out = [];
    for (const id of Object.keys(this.index.unsent)) {
      const m = this.index.meetings[id] ? this.data(id) : null;
      if (m && m.dataRev > m.dataSent) out.push({ id, rev: m.dataRev });
      else {
        delete this.index.unsent[id];
        this.touchIndex();
      }
    }
    return out;
  }

  // Voice took the document with changes up to rev.
  dataTaken(id, rev) {
    const m = this.data(id);
    if (!m || !Number.isInteger(rev) || rev <= m.dataSent) return;
    m.dataSent = Math.min(rev, m.dataRev);
    if (m.dataSent >= m.dataRev) {
      delete this.index.unsent[id];
      this.touchIndex();
    }
    this.touchMeeting(id);
  }

  // Whether a value fits the field it says it is for.
  validValue(key, v) {
    if (key === 'title') return v === null || (typeof v === 'string' && v.trim() !== '' && Array.from(v.trim()).length <= 200);
    if (key === 'event') return v === null || (typeof v === 'string' && v.length <= EVENT_ID_MAX);
    if (key === 'notes') return typeof v === 'string' && v.length <= NOTES_MAX;
    if (key === 'you') return typeof v === 'string' && MIC_VOICE.test(v);
    if (key === 'joined') return typeof v === 'boolean';
    if (key.startsWith('name:')) return v === null || (isObj(v) && typeof v.name === 'string' && v.name.trim() !== '' && v.name.length <= NAME_MAX);
    const fits = (t) => typeof t === 'string' && t.length <= CORRECTION_MAX;
    return v === null || fits(v) || (isObj(v) && fits(v.text) && Number.isInteger(v.end) && v.end >= 0);
  }

  // Another computer's view of what Rukoo owns of a meeting (meeting.data): each field it changed later than this one
  // did comes in. Applying a document twice gives the same result. {meeting, kind: 'data'} when anything changed.
  applyData(id, doc) {
    const m = isObj(doc) && isObj(doc.fields) && this.index.meetings[id] ? this.data(id, true) : null;
    if (!m) return null;
    const theirs = text(doc.name, DEVICE_NAME_MAX);
    let changed = false;
    for (const [key, f] of Object.entries(doc.fields)) {
      const s = DATA_KEY.test(key) && isObj(f) ? stampOf(f) : null;
      if (!s || !this.validValue(key, f.v)) continue;
      const mine = m.stamps[key];
      if (mine && mine.at === s.at && mine.by === s.by) continue;
      const dismissed = key === 'notes' && m.notesDismissed && m.notesDismissed.at === s.at && m.notesDismissed.text === f.v;
      if (!later(s, mine)) {
        // This computer's notes are newer, but theirs weren't written from them: both stay.
        if (key === 'notes' && !dismissed && s.at > (mine.base || 0) && f.v !== this.ownValue(id, m, key) && f.v.trim() && !(m.notesOther && m.notesOther.at === s.at)) {
          m.notesOther = { text: f.v, at: s.at, device: theirs };
          changed = true;
        }
        continue;
      }
      if (key === 'notes') {
        const ours = this.ownValue(id, m, key);
        // Theirs are newer, but weren't written from this computer's: this computer's stay beside them, and when they
        // were written here they keep going to the other computers until the user picks.
        if (mine && mine.at > (s.base || 0) && ours !== f.v && ours.trim()) {
          m.notesOther = { text: ours, at: mine.at, device: this.deviceName };
          if (mine.by === this.index.device) {
            m.notesOther.stamp = mine;
            this.dataChanged(id, m);
          }
        } else if (m.notesOther && m.notesOther.text === f.v) m.notesOther = null;
      }
      this.setOwnValue(id, m, key, f.v);
      m.stamps[key] = s;
      if (key === 'notes') m.notesFrom = { rev: m.notes.rev, at: s.at, device: theirs };
      changed = true;
    }
    if (!changed) return null;
    this.meetingChanged(id);
    return { meeting: id, kind: 'data' };
  }

  // Sets a field from another computer, without a stamp of this one.
  setOwnValue(id, m, key, v) {
    const e = this.index.meetings[id];
    if (key === 'title') {
      e.ownTitle = v === null ? null : v.trim();
      this.touchIndex();
    } else if (key === 'event') {
      e.eventId = v;
      this.touchIndex();
    } else if (key === 'notes') {
      const rev = m.notes ? m.notes.rev : 0;
      m.notes = { text: v, rev: rev + 1, updatedAt: this.now() };
    } else if (key === 'you') m.mic.you = v;
    else if (key === 'joined') m.mic.joined = v;
    else if (key.startsWith('name:')) {
      const sid = key.slice(5);
      if (v === null) delete m.names[sid];
      else m.names[sid] = { name: text(v.name, NAME_MAX).trim(), address: text(v.address, ADDRESS_MAX).trim(), from: NAME_SOURCES.has(v.from) ? v.from : 'user' };
    } else {
      const pid = key.slice('correction:'.length);
      const tick = this.nextTick();
      if (v === null) {
        delete m.corrections[pid];
        delete m.correctedEnds[pid];
      } else {
        m.corrections[pid] = typeof v === 'string' ? v : v.text;
        const p = m.passages[pid];
        // What the other computer's correction covered, pieces of a split here included: a split cuts a passage
        // within its own span, so every later passage of the track that starts before that end is one of its pieces.
        if (isObj(v) && p) m.correctedEnds[pid] = { end: Math.max(v.end, p.end), at: 0 };
        else if (p && !m.correctedEnds[pid]) m.correctedEnds[pid] = { end: p.end, at: tick };
      }
      if (m.passages[pid]) m.passages[pid].changed = tick;
    }
  }

  // ---------- reading ----------

  entry(id) {
    const e = isMeetingId(id) ? this.index.meetings[id] : null;
    return e ? { ...e, title: e.ownTitle ?? e.title, initialScreen: e.screen, screen: e.currentScreen } : null;
  }

  // Whether Voice stopped recording the meeting's screen for good: it sends a dropped mark on the screen track then.
  screenDropped(id) {
    const m = this.data(id);
    return Boolean(m) && Object.values(m.marks).some((k) => k.kind === 'dropped' && k.track === 'screen');
  }

  // Newest first.
  list() {
    return Object.keys(this.index.meetings).map((id) => this.entry(id)).sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0) || (a.id < b.id ? 1 : -1));
  }

  // A split can cut a passage the user corrected into pieces: the correction stays whole on the first piece, which
  // keeps the passage's id, and the later pieces it covers don't show, so no words show twice. Only pieces that came
  // after the correction, on its track and within what it covered, count: a passage that was there before stays.
  // Maps each hidden piece to the passage whose correction covers it.
  covered(m) {
    const out = new Map();
    for (const [pid, c] of Object.entries(m.correctedEnds)) {
      const first = m.passages[pid];
      if (!first || !Object.hasOwn(m.corrections, pid) || c.end <= first.end) continue;
      for (const p of Object.values(m.passages)) if (p.id !== pid && p.track === first.track && p.start >= first.end && p.start < c.end && int(p.added) > c.at) out.set(p.id, pid);
    }
    return out;
  }

  // Whether this passage's correction hides pieces a split cut from it.
  hidesPieces(id, passageId) {
    const m = this.data(id);
    const c = m && m.correctedEnds[passageId];
    const first = m && m.passages[passageId];
    return Boolean(c && first && Object.hasOwn(m.corrections, passageId) && c.end > first.end);
  }

  // Everything about one meeting, with the names and corrections applied; null when Rukoo doesn't have it.
  meeting(id) {
    const e = this.entry(id);
    if (!e) return null;
    const m = this.data(id) || emptyMeeting(id);
    const mic = micView(m);
    // A joined microphone is one voice, the user's; its other voices keep their names for when it splits again.
    const speakers = Object.values(m.speakers)
      .filter((s) => s.track !== 'mic' || !mic.joined || s.id === mic.you)
      .map((s) => {
        const you = s.track === 'mic' && s.id === mic.you;
        const own = you ? null : m.names[s.id];
        return { ...s, you, letter: mic.letters[s.id] || null, name: own ? own.name : null, address: own ? own.address || null : null, from: own ? own.from : null };
      });
    const covered = this.covered(m);
    // What the user dictated is theirs, whichever voice at the microphone they said is them.
    const voiced = (p) => (p.track === 'mic' && p.speaker !== null && (mic.joined || (p.dictation && p.speaker === 'mic')) ? { ...p, speaker: mic.you } : p);
    const byTime = (a, b) => a.start - b.start || (a.track < b.track ? -1 : 1);
    const passages = Object.values(m.passages)
      .filter((p) => !covered.has(p.id))
      .map((p) => {
        const v = voiced(p);
        if (!Object.prototype.hasOwnProperty.call(m.corrections, p.id)) return { ...v, corrected: false };
        return { ...v, text: m.corrections[p.id], original: p.text, corrected: true };
      })
      .sort(byTime);
    // The pieces a correction hides still hold their voice's speech: the player hears them, under the correction.
    const pieces = Object.values(m.passages)
      .filter((p) => covered.has(p.id))
      .map((p) => ({ ...voiced(p), under: covered.get(p.id) }))
      .sort(byTime);
    const marks = Object.values(m.marks).sort((a, b) => a.at - b.at);
    const frames = Object.values(m.frames).sort((a, b) => a.at - b.at);
    return {
      meeting: { ...e },
      speakers,
      passages,
      pieces,
      marks,
      frames,
      notes: m.notes ? { ...m.notes } : { text: '', rev: 0, updatedAt: null },
      // mine: the text this computer wrote, kept beside newer notes from another computer.
      notesOther: m.notesOther ? notesOtherView(m.notesOther, this.deviceName) : null,
      mic: { you: mic.you, joined: mic.joined, split: mic.split, voices: mic.voices },
      rev: e.rev
    };
  }
}

module.exports = { VoiceStore, VERSION, NOTES_MAX, CORRECTION_MAX, NAME_MAX, ADDRESS_MAX };
