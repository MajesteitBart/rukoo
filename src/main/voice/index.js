'use strict';

// Rukoo's side of Rukoo Voice: the bridge to Voice, the store of what Rukoo keeps, and the API main.js and the agent's
// tools call. main.js makes one VoiceService after the calendars and hands it to the agent hub as deps.voice.
//
// Voice keeps recording when Rukoo quits, so close() never stops a meeting.
//
// Hiding Rukoo from screen capture fails closed: while Rukoo believes a meeting records, protect(true) holds, also
// when the socket drops, until Voice says the meeting ended or the user turns the setting off. A start from Rukoo
// protects first and waits for the next desktop composition before it asks Voice to start, because protection lags
// one composition behind setContentProtection.

const { EventEmitter } = require('events');
const { VoiceStore } = require('./store');
const { VoiceBridge, VoiceError } = require('./bridge');
const { isMeetingId, TITLE_MAX, LABEL_MAX } = require('./protocol');
const { candidateEvents, suggest, WINDOW_MS } = require('./speakers');
const { bridgePathHere } = require('./paths');

const PROTECT_DELAY_MS = 100;
const EMIT_MS = 150;
const LINK_WITHIN_MS = 12 * 60 * 60 * 1000;
const EVENT_ID_MAX = 4000;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// At most max characters, counted as the protocol counts them (code points), and never half of one. Voice can't read
// a lone surrogate, so a command that carries one gets no answer at all. A cut in UTF-16 units before this one can
// leave half an emoji at the end: that half goes.
function clipChars(s, max) {
  return Array.from(s.replace(/[\uD800-\uDBFF]$/, '').toWellFormed())
    .slice(0, max)
    .join('');
}

// What the meeting list and a delta say about a meeting.
function summary(e, now = Date.now()) {
  const end = e.endedAt || (e.state === 'recording' || e.state === 'paused' ? now : null);
  return {
    id: e.id,
    title: e.title,
    startedAt: e.startedAt,
    endedAt: e.endedAt,
    state: e.state,
    reason: e.reason,
    tracks: e.tracks,
    screen: e.screen,
    startedBy: e.startedBy,
    eventId: e.eventId,
    removed: e.removed,
    duration: e.startedAt && end ? Math.max(0, end - e.startedAt) : null,
    rev: e.rev
  };
}

function speakerView(s) {
  return { id: s.id, track: s.track, label: s.label, name: s.name, address: s.address, from: s.from, you: s.track === 'mic' };
}

class VoiceService extends EventEmitter {
  // discovery: the discovery file (paths.bridgePathHere), or null for a profile that never looks for Voice.
  // hide(): whether the user wants Rukoo hidden from screen capture during a meeting. protect(on): hides or shows
  // every window. calendars, engine: for the linked event and the names of its guests.
  constructor({ dataDir, discovery = null, appVersion = '', hide = () => true, protect = () => {}, calendars = null, WebSocket, bridge = {}, protectDelayMs = PROTECT_DELAY_MS, emitMs = EMIT_MS, now = Date.now, log = () => {} } = {}) {
    super();
    this.store = new VoiceStore({ dataDir, now, log });
    this.bridge = new VoiceBridge({ file: discovery, clientVersion: appVersion, cursor: () => this.store.cursor(), WebSocket, log, ...bridge });
    this.hide = hide;
    this.protect = protect;
    this.calendars = calendars;
    this.protectDelayMs = protectDelayMs;
    this.emitMs = emitMs;
    this.now = now;
    this.log = log;
    this.starting = 0;
    this.protectedNow = null;
    this.lastRecording = null;
    this.deltas = new Map();
    this.deltaTimer = null;
    // The meetings whose meeting.get is on its way, each with the events for it applied meanwhile (refetch()).
    this.waiting = new Set();
    this.closed = false;
  }

  init() {
    this.store.load();
    this.lastRecording = this.store.status().recording;
    this.bridge.on('state', () => this.emit('state', this.state()));
    this.bridge.on('welcome', (msg) => this.onWelcome(msg));
    this.bridge.on('event', (ev) => this.onEvent(ev));
    this.bridge.on('status', (status) => {
      if (this.store.setStatus(status)) this.statusChanged();
    });
    // The last thing Rukoo heard may be that a meeting records: protect before any window shows.
    this.refreshProtection();
    this.bridge.start();
    return this;
  }

  // ---------- state ----------

  state() {
    const s = this.bridge.state();
    const status = this.store.status();
    return { status: s.status, reason: s.reason, voiceVersion: s.voiceVersion, protocol: s.protocol, older: s.older, recording: status.recording, dictating: status.dictating };
  }

  recording() {
    return this.store.status().recording;
  }

  get connected() {
    return this.bridge.connected;
  }

  shouldProtect() {
    return Boolean(this.hide()) && (Boolean(this.recording()) || this.starting > 0);
  }

  // Also for main when the user changes the setting.
  refreshProtection() {
    const on = this.shouldProtect();
    if (on === this.protectedNow) return;
    this.protectedNow = on;
    try {
      this.protect(on);
    } catch (err) {
      this.log('voice', `protecting the windows failed: ${err.message}`);
    }
  }

  statusChanged() {
    const recording = this.recording();
    if (recording !== this.lastRecording) {
      this.lastRecording = recording;
      this.emit('recording', recording);
    }
    this.refreshProtection();
    this.emit('state', this.state());
  }

  // ---------- from Voice ----------

  onWelcome(msg) {
    const { reset, gap } = this.store.welcome(msg);
    this.statusChanged();
    if (reset) this.emit('meeting', { kind: 'list' });
    // Voice already deleted events Rukoo missed: ask for every meeting Rukoo has. A done meeting can't change, but
    // Voice may have deleted it meanwhile, and its meeting.removed may be among the events Rukoo missed.
    if (gap || this.store.damaged.size) this.refetch(gap).catch(() => {});
  }

  async refetch(gap) {
    const ids = new Set(this.store.damaged);
    if (gap) for (const e of this.store.list()) if (!e.removed) ids.add(e.id);
    for (const id of ids) {
      if (!this.connected) return;
      const before = this.revOf(id);
      // The meeting's events that arrive before the answer: those past its head are newer than the snapshot.
      const waiting = { id, events: [] };
      this.waiting.add(waiting);
      try {
        const snap = await this.bridge.command('meeting.get', { meeting: id });
        const change = this.store.applySnapshot(id, snap, waiting.events);
        if (change) this.note(change, before);
      } catch (err) {
        // Voice doesn't have it any more: as if it said meeting.removed.
        if (err.code === 'not_found' && this.store.remove(id)) this.note({ meeting: id, kind: 'removed' }, before);
      } finally {
        this.waiting.delete(waiting);
      }
    }
    this.statusChanged();
    this.emit('meeting', { kind: 'list' });
  }

  revOf(id) {
    const e = id ? this.store.entry(id) : null;
    return e ? e.rev : 0;
  }

  onEvent(ev) {
    const before = this.revOf(ev.meeting);
    const was = this.store.status();
    let change = null;
    try {
      change = this.store.apply(ev);
      for (const w of this.waiting) if (w.id === ev.meeting) w.events.push(ev);
    } catch (err) {
      this.log('voice', `applying ${ev.event} failed: ${err.message}`);
    }
    // meeting.started already marks the entry recording, so the meeting.state that follows can change only the
    // status: protection and the windows must still hear that a meeting records.
    const now = this.store.status();
    const moved = now.recording !== was.recording || now.dictating !== was.dictating;
    if (!change) {
      if (moved) this.statusChanged();
      return;
    }
    if (moved || change.kind === 'status' || ev.event === 'meeting.state' || ev.event === 'meeting.removed') this.statusChanged();
    if (change.meeting) this.note(change, before);
    if (ev.event === 'meeting.started') this.linkEvent(ev.meeting).catch(() => {});
    if (ev.event === 'speaker') this.autoName(ev.meeting);
  }

  // ---------- deltas for the renderer ----------

  // A change to a meeting, sent to the renderer with the next batch. from: the meeting's rev before it, so the
  // renderer can tell it missed one and fetch the meeting again.
  note(change, before) {
    const id = change.meeting;
    let d = this.deltas.get(id);
    if (!d) {
      d = { from: before, passages: new Set(), removed: new Set(), marks: new Set(), speakers: false, notes: false, all: false };
      this.deltas.set(id, d);
    }
    if (change.kind === 'passage') {
      d.passages.add(change.id);
      d.removed.delete(change.id);
    } else if (change.kind === 'passage.removed') {
      d.passages.delete(change.id);
      d.removed.add(change.id);
    } else if (change.kind === 'mark') d.marks.add(change.id);
    else if (change.kind === 'speaker' || change.kind === 'names') d.speakers = true;
    else if (change.kind === 'notes') d.notes = true;
    else if (change.kind === 'snapshot' || change.kind === 'removed') d.all = true;
    if (!this.deltaTimer && !this.closed) {
      this.deltaTimer = setTimeout(() => this.flushDeltas(), this.emitMs);
      if (this.deltaTimer.unref) this.deltaTimer.unref();
    }
  }

  flushDeltas() {
    clearTimeout(this.deltaTimer);
    this.deltaTimer = null;
    const list = [...this.deltas];
    this.deltas.clear();
    for (const [id, d] of list) {
      const full = this.store.meeting(id);
      if (!full) {
        this.emit('meeting', { kind: 'removed', id });
        continue;
      }
      const payload = { kind: 'meeting', id, from: d.from, rev: full.rev, meeting: summary(full.meeting, this.now()) };
      if (d.all) {
        // A snapshot replaced the lists: the renderer fetches the meeting again.
        payload.refetch = true;
      } else {
        if (d.passages.size) payload.passages = full.passages.filter((p) => d.passages.has(p.id));
        if (d.removed.size) payload.removedPassages = [...d.removed];
        if (d.marks.size) payload.marks = full.marks.filter((k) => d.marks.has(k.id));
        // With the guests of the linked event to pick from, as meetingGet gives them.
        if (d.speakers) payload.speakers = this.speakers(id);
        if (d.notes) payload.notes = full.notes;
      }
      this.emit('meeting', payload);
    }
  }

  // ---------- the API for main and the tools ----------

  list() {
    return this.store.list().map((e) => summary(e, this.now()));
  }

  // Everything the meeting view shows. null for a meeting Rukoo doesn't have.
  get(id) {
    const full = this.store.meeting(id);
    if (!full) return null;
    return {
      meeting: summary(full.meeting, this.now()),
      // Each with the guests of the linked event the meeting view offers as names.
      speakers: this.speakers(id),
      passages: full.passages,
      marks: full.marks,
      frames: full.frames,
      notes: full.notes,
      event: this.eventSummary(full.meeting.eventId),
      rev: full.rev
    };
  }

  // The raw store view, for the agent's tools.
  meeting(id) {
    return this.store.meeting(id);
  }

  // The meeting a tool means without an id: the one recording, else the newest.
  defaultMeeting() {
    const rec = this.recording();
    if (rec && this.store.entry(rec)) return rec;
    const newest = this.store.list().find((e) => !e.removed);
    return newest ? newest.id : null;
  }

  // How many passages changed after Rukoo's change number since (read_meeting_transcript's cursor).
  freshCount(id, since = 0) {
    const full = this.store.meeting(id);
    return full ? full.passages.filter((p) => p.changed > since).length : 0;
  }

  mustConnect() {
    if (!this.connected) throw new VoiceError('offline', 'Rukoo Voice is not running or not connected.');
  }

  // opts: {title, eventId, screen, tracks}, already checked by main. {meetingId}.
  async start(opts = {}) {
    this.mustConnect();
    const args = {};
    const title = typeof opts.title === 'string' ? clipChars(opts.title.trim(), TITLE_MAX) : '';
    if (title) args.title = title;
    if (typeof opts.screen === 'string') args.screen = opts.screen;
    if (Array.isArray(opts.tracks) && opts.tracks.length) args.tracks = opts.tracks;
    const eventId = typeof opts.eventId === 'string' && opts.eventId ? opts.eventId.slice(0, EVENT_ID_MAX) : null;
    if (eventId) args.context = { calendarEvent: eventId };
    this.starting += 1;
    try {
      if (this.shouldProtect()) {
        this.refreshProtection();
        await delay(this.protectDelayMs);
      }
      const result = await this.bridge.command('meeting.start', args);
      const id = result && isMeetingId(result.meeting) ? result.meeting : null;
      if (id) {
        // The events may still be on their way: the meeting records from now, as far as protection goes.
        if (this.store.setStatus({ ...this.store.status(), recording: id })) this.statusChanged();
        if (eventId) {
          const before = this.revOf(id);
          this.store.ensureEntry(id);
          this.store.setEvent(id, eventId);
          this.note({ meeting: id, kind: 'meeting' }, before);
        }
      }
      return { meetingId: id };
    } finally {
      this.starting -= 1;
      this.refreshProtection();
    }
  }

  async stop(id) {
    this.mustConnect();
    await this.bridge.command('meeting.stop', { meeting: id });
    return true;
  }

  async pause(id) {
    this.mustConnect();
    await this.bridge.command('meeting.pause', { meeting: id });
    return true;
  }

  async resume(id) {
    this.mustConnect();
    await this.bridge.command('meeting.resume', { meeting: id });
    return true;
  }

  async mark(id, label = null) {
    this.mustConnect();
    const args = { meeting: id };
    const text = typeof label === 'string' ? clipChars(label.trim(), LABEL_MAX) : '';
    if (text) args.label = text;
    return this.bridge.command('meeting.mark', args);
  }

  // The frame closest before at (meeting time in ms): {frame, image: {type, data}}.
  async frame(id, at) {
    this.mustConnect();
    return this.bridge.command('frame.get', { meeting: id, at });
  }

  // ---------- what Rukoo owns ----------

  change(id, kind, fn) {
    const before = this.revOf(id);
    const out = fn();
    if (out) this.note({ meeting: id, kind }, before);
    return out;
  }

  setSpeaker(id, speakerId, value) {
    if (!this.change(id, 'names', () => this.store.setName(id, speakerId, value === null ? null : { ...value, from: 'user' }))) throw new VoiceError('not_found', 'No such meeting or speaker.');
    return this.speakers(id);
  }

  saveNotes(id, text, rev) {
    const before = this.revOf(id);
    const out = this.store.saveNotes(id, text, rev);
    if (!out) throw new VoiceError('not_found', 'No such meeting.');
    if (!out.conflict) this.note({ meeting: id, kind: 'notes' }, before);
    return out;
  }

  correct(id, passageId, text) {
    if (!this.change(id, 'passage', () => this.store.correct(id, passageId, text))) throw new VoiceError('not_found', 'No such meeting or passage.');
    // The delta names the passage.
    const d = this.deltas.get(id);
    if (d) d.passages.add(passageId);
    return true;
  }

  // Links a calendar event (or none). The guests become the names offered for the voices on the call; a 1:1 gets
  // its name right away. Returns the speakers with their suggestions.
  setEvent(id, eventId) {
    if (!this.change(id, 'meeting', () => this.store.setEvent(id, eventId))) throw new VoiceError('not_found', 'No such meeting.');
    this.autoName(id);
    return this.speakers(id);
  }

  speakers(id) {
    const full = this.store.meeting(id);
    if (!full) return [];
    const event = this.calendarEvent(full.meeting.eventId);
    const { suggestions } = suggest(full.speakers, event);
    return full.speakers.map((s) => ({ ...speakerView(s), suggestions: suggestions[s.id] || [] }));
  }

  // The calendar events this meeting can be, nearest first. {events, failed}.
  async events(id) {
    const e = this.store.entry(id);
    if (!e || !this.calendars || !Number.isFinite(e.startedAt)) return { events: [], failed: [] };
    const { events, failed } = await this.calendars.read({ start: e.startedAt - WINDOW_MS, end: e.startedAt + WINDOW_MS });
    return {
      events: candidateEvents(events, e.startedAt).map((x) => ({ id: x.id, title: x.title || '', start: x.start, end: x.end, accountId: x.accountId || null, video: Boolean(x.meeting), attendees: Array.isArray(x.attendees) ? x.attendees.length : 0 })),
      failed: (failed || []).map((f) => ({ accountId: f.accountId, email: f.email, code: f.code }))
    };
  }

  calendarEvent(eventId) {
    if (!eventId || !this.calendars || typeof this.calendars.event !== 'function') return null;
    try {
      return this.calendars.event(eventId);
    } catch (_) {
      return null;
    }
  }

  eventSummary(eventId) {
    const e = this.calendarEvent(eventId);
    return e ? { id: e.id, title: e.title || '', start: e.start, end: e.end, video: Boolean(e.meeting) } : eventId ? { id: eventId, missing: true } : null;
  }

  // A meeting Voice started on its own: when exactly one calendar event fits, link it; the user can change it. Only a
  // recent one: the first replay brings every meeting Voice has, and an old one isn't worth a calendar read each.
  async linkEvent(id) {
    const e = this.store.entry(id);
    if (!e || e.eventId || !this.calendars || !Number.isFinite(e.startedAt) || this.now() - e.startedAt > LINK_WITHIN_MS) return;
    const { events } = await this.events(id);
    if (events.length !== 1 || this.closed) return;
    const now = this.store.entry(id);
    if (!now || now.eventId) return;
    this.setEvent(id, events[0].id);
  }

  // A 1:1 gets its name without asking: one voice on the call and one guest who can be it, and no name yet.
  autoName(id) {
    const full = this.store.meeting(id);
    if (!full || !full.meeting.eventId) return;
    const { auto } = suggest(full.speakers, this.calendarEvent(full.meeting.eventId));
    for (const [speakerId, person] of Object.entries(auto)) {
      const s = full.speakers.find((x) => x.id === speakerId);
      if (s && !s.name) this.change(id, 'names', () => this.store.setName(id, speakerId, { name: person.name, address: person.address, from: 'auto' }));
    }
  }

  // Synchronous, for quit and the end of the Windows session: closes the socket and writes the store.
  close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.deltaTimer);
    this.deltaTimer = null;
    this.bridge.close();
    this.store.close();
  }
}

module.exports = { VoiceService, VoiceError, bridgePathHere, summary };
