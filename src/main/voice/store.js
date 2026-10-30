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
// tick is Rukoo's own change counter: every change to a passage or mark takes the next number. It orders what the
// agent has read (read_meeting_transcript's cursor) and what the renderer has shown, and unlike Voice's seq it never
// starts again when Voice's data folder does. When voice.json is lost it resumes, for each meeting, above the ticks
// in that meeting's file before the meeting changes again (data()).

const fs = require('fs');
const path = require('path');
const { validate, isMeetingId, STATES } = require('./protocol');

const VERSION = 1;
const SAVE_MS = 400;
const RETRY_MS = 2000;
const NAME_MAX = 200;
const ADDRESS_MAX = 320;
const NOTES_MAX = 100000;
const CORRECTION_MAX = 20000;
const EVENT_ID_MAX = 4000;
const ENDED = new Set(['processing', 'done', 'failed']);
const NAME_SOURCES = new Set(['calendar', 'user', 'auto']);

const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const int = (v, fallback = 0) => (Number.isInteger(v) && v >= 0 ? v : fallback);
const text = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

function emptyIndex() {
  return { version: VERSION, instance: null, lastSeq: 0, tick: 0, status: { recording: null, dictating: false }, meetings: {} };
}

function emptyMeeting(id) {
  return { version: VERSION, id, speakers: {}, passages: {}, marks: {}, frames: {}, names: {}, notes: null, corrections: {} };
}

// An index entry with every field, from what was stored or what Voice sent.
function indexEntry(id, v = {}) {
  return {
    id,
    title: typeof v.title === 'string' ? v.title : '',
    startedAt: Number.isInteger(v.startedAt) ? v.startedAt : null,
    endedAt: Number.isInteger(v.endedAt) ? v.endedAt : null,
    state: STATES.includes(v.state) ? v.state : null,
    reason: typeof v.reason === 'string' ? v.reason : null,
    at: int(v.at, 0),
    tracks: Array.isArray(v.tracks) ? v.tracks.filter((t) => t === 'mic' || t === 'call') : [],
    screen: typeof v.screen === 'string' ? v.screen : 'off',
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
  return m;
}

class VoiceStore {
  constructor({ dataDir, now = Date.now, saveMs = SAVE_MS, log = () => {} } = {}) {
    this.file = path.join(dataDir, 'voice.json');
    this.dir = path.join(dataDir, 'meetings');
    this.now = now;
    this.saveMs = saveMs;
    this.log = log;
    this.index = emptyIndex();
    // Meeting files read so far, by id.
    this.cache = new Map();
    // Meetings whose file was damaged and set aside: Voice can send them again (meeting.get).
    this.damaged = new Set();
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
      const st = isObj(raw.status) ? raw.status : {};
      index.status = { recording: isMeetingId(st.recording) ? st.recording : null, dictating: st.dictating === true };
      for (const [id, v] of Object.entries(raw.meetings)) if (isMeetingId(id) && isObj(v)) index.meetings[id] = indexEntry(id, v);
    } else if (raw) {
      this.keepAside(this.file);
    }
    this.index = index;
    // The cursor on disk: Voice replays after it, so it only moves once every meeting file before it is written.
    this.savedCursor = { instance: index.instance, lastSeq: index.lastSeq };
    return this;
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
    if (raw === null) this.damaged.add(id);
    if (!raw && !create && !this.index.meetings[id]) return null;
    m = raw ? normalizeMeeting(id, raw) : emptyMeeting(id);
    this.cache.set(id, m);
    // voice.json can be lost, set aside or older than this file (a crash between the two saves) while a chat's
    // cursor still holds this file's ticks: the meeting's next change must still count as new.
    let top = 0;
    for (const v of [...Object.values(m.passages), ...Object.values(m.marks)]) top = Math.max(top, int(v.changed), int(v.added));
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
    this.setStatus(msg.status);
    this.touchIndex();
    return { reset, gap: msg.replay === 'gap' };
  }

  setStatus(status) {
    const recording = status && isMeetingId(status.recording) ? status.recording : null;
    const dictating = Boolean(status && status.dictating === true);
    if (this.index.status.recording === recording && this.index.status.dictating === dictating) return false;
    this.index.status = { recording, dictating };
    this.touchIndex();
    return true;
  }

  status() {
    return { ...this.index.status };
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
    const d = ev.data;
    switch (ev.event) {
      case 'status':
        return this.setStatus(d) ? { meeting: null, kind: 'status' } : null;
      case 'meeting.started':
        return this.started(id, d);
      case 'meeting.state':
        return this.stateChanged(id, d);
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
        return this.remove(id) ? { meeting: id, kind: 'removed' } : null;
      default:
        return null;
    }
  }

  started(id, d) {
    const e = this.ensureEntry(id);
    const before = JSON.stringify(e);
    Object.assign(e, { title: d.title, startedAt: d.startedAt, tracks: d.tracks.slice(), screen: d.screen, startedBy: d.startedBy, context: d.context });
    // A meeting Rukoo started from a calendar event carries it in context; the user can link another later.
    if (!e.eventId && d.context && typeof d.context.calendarEvent === 'string' && d.context.calendarEvent) e.eventId = d.context.calendarEvent.slice(0, EVENT_ID_MAX);
    if (!e.state) e.state = 'recording';
    return this.entryChanged(e, before);
  }

  stateChanged(id, d) {
    const e = this.ensureEntry(id);
    const before = JSON.stringify(e);
    Object.assign(e, { state: d.state, at: d.at, endedAt: ENDED.has(d.state) ? d.endedAt : null, reason: d.reason == null ? null : d.reason });
    // Fail closed: what records now is known the moment Voice says so, and a meeting that ended no longer records,
    // also when the status event that says it is still to come.
    if (d.state === 'recording' || d.state === 'paused') this.setStatus({ ...this.index.status, recording: id });
    else if (this.index.status.recording === id) this.setStatus({ ...this.index.status, recording: null });
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
    this.meetingChanged(id, tick);
    return { meeting: id, kind: 'mark', id: d.id };
  }

  frame(id, d) {
    const m = this.data(id, true);
    const next = { id: d.id, at: d.at, width: d.width, height: d.height, text: d.text };
    if (JSON.stringify(m.frames[d.id]) === JSON.stringify(next)) return null;
    m.frames[d.id] = next;
    this.meetingChanged(id);
    return { meeting: id, kind: 'frame', id: d.id };
  }

  // meeting.get's answer: the current version of everything up to its head. What Rukoo has that the snapshot lacks
  // was removed meanwhile. Items Voice sent that don't pass the protocol's checks are left out, as events would be.
  // later: the events for this meeting Rukoo applied while the answer was on its way. Voice sends its replies and its
  // events separately, so those past head can come first: they are newer than the snapshot and apply again on top.
  applySnapshot(id, snap, later = []) {
    if (!isMeetingId(id) || !isObj(snap)) return null;
    const head = Number.isInteger(snap.head) ? snap.head : Infinity;
    const newer = later.filter((ev) => ev.meeting === id && ev.seq > head);
    // Voice removed the meeting after the snapshot, and Rukoo did too.
    if (newer.some((ev) => ev.event === 'meeting.removed')) return null;
    const fresh = new Set(newer.filter((ev) => ev.event === 'passage' || ev.event === 'mark').map((ev) => `${ev.event}:${ev.data.id}`));
    const ok = (event, data) => validate('voice', { type: 'event', seq: 1, event, meeting: id, createdAt: 0, data }).ok;
    const meeting = isObj(snap.meeting) ? snap.meeting : {};
    const e = this.ensureEntry(id);
    const before = JSON.stringify(e);
    if (ok('meeting.started', meeting)) Object.assign(e, { title: meeting.title, startedAt: meeting.startedAt, tracks: meeting.tracks.slice(), screen: meeting.screen, startedBy: meeting.startedBy, context: meeting.context });
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
    // Applying an event twice gives the same result, so what Rukoo had from them comes back as it was.
    for (const ev of newer) if (this.apply(ev)) touched = true;
    this.damaged.delete(id);
    if (!changed && !touched) return null;
    this.meetingChanged(id);
    return { meeting: id, kind: 'snapshot' };
  }

  // Voice removed the meeting: its transcript goes. Notes the user wrote stay, with the meeting marked removed.
  remove(id) {
    if (!isMeetingId(id)) return false;
    const e = this.index.meetings[id];
    const m = this.data(id);
    if (!e && !m) return false;
    if (this.index.status.recording === id) this.setStatus({ ...this.index.status, recording: null });
    if (m && m.notes && m.notes.text.trim()) {
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

  // value: {name, address, from} or null to forget the name. Returns false for an unknown meeting or speaker.
  setName(id, speakerId, value) {
    const m = this.data(id);
    if (!m || !this.index.meetings[id] || typeof speakerId !== 'string' || !m.speakers[speakerId]) return false;
    if (value === null) delete m.names[speakerId];
    else {
      const name = text(value && value.name, NAME_MAX).trim();
      if (!name) delete m.names[speakerId];
      else m.names[speakerId] = { name, address: text(value.address, ADDRESS_MAX).trim(), from: NAME_SOURCES.has(value.from) ? value.from : 'user' };
    }
    this.meetingChanged(id);
    return true;
  }

  // Saves the notes when rev is the revision the editor started from. {rev} after a save, {conflict: true, rev, text}
  // when someone saved in between, null for an unknown meeting.
  saveNotes(id, value, rev) {
    const m = this.data(id);
    if (!m || !this.index.meetings[id]) return null;
    const current = m.notes ? m.notes.rev : 0;
    if (rev !== current) return { conflict: true, rev: current, text: m.notes ? m.notes.text : '' };
    m.notes = { text: text(value, NOTES_MAX), rev: current + 1, updatedAt: this.now() };
    this.meetingChanged(id);
    return { rev: m.notes.rev };
  }

  // The user's correction of a passage's text, or null to go back to Voice's. The agent sees it as a change.
  correct(id, passageId, value) {
    const m = this.data(id);
    if (!m || !m.passages[passageId]) return false;
    if (value === null || value === undefined) delete m.corrections[passageId];
    else m.corrections[passageId] = text(value, CORRECTION_MAX);
    const tick = this.nextTick();
    m.passages[passageId].changed = tick;
    this.meetingChanged(id, tick);
    return true;
  }

  setEvent(id, eventId) {
    const e = this.index.meetings[id];
    if (!e) return false;
    e.eventId = typeof eventId === 'string' && eventId ? eventId.slice(0, EVENT_ID_MAX) : null;
    e.rev = this.nextTick();
    this.touchIndex();
    return true;
  }

  // ---------- reading ----------

  entry(id) {
    return isMeetingId(id) ? this.index.meetings[id] || null : null;
  }

  // Newest first.
  list() {
    return Object.values(this.index.meetings).sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0) || (a.id < b.id ? 1 : -1));
  }

  // Everything about one meeting, with the names and corrections applied; null when Rukoo doesn't have it.
  meeting(id) {
    const e = this.entry(id);
    if (!e) return null;
    const m = this.data(id) || emptyMeeting(id);
    const speakers = Object.values(m.speakers).map((s) => {
      const own = m.names[s.id];
      return { ...s, name: own ? own.name : null, address: own ? own.address || null : null, from: own ? own.from : null };
    });
    const passages = Object.values(m.passages)
      .map((p) => (Object.prototype.hasOwnProperty.call(m.corrections, p.id) ? { ...p, text: m.corrections[p.id], original: p.text, corrected: true } : { ...p, corrected: false }))
      .sort((a, b) => a.start - b.start || (a.track < b.track ? -1 : 1));
    const marks = Object.values(m.marks).sort((a, b) => a.at - b.at);
    const frames = Object.values(m.frames).sort((a, b) => a.at - b.at);
    return { meeting: { ...e }, speakers, passages, marks, frames, notes: m.notes ? { ...m.notes } : { text: '', rev: 0, updatedAt: null }, rev: e.rev };
  }
}

module.exports = { VoiceStore, VERSION, NOTES_MAX, CORRECTION_MAX, NAME_MAX, ADDRESS_MAX };
