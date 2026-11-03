'use strict';

// Rukoo's side of Rukoo Voice: the bridge to Voice, the store of what Rukoo keeps, and the API main.js and the agent's
// tools call. main.js makes one VoiceService after the calendars and hands it to the agent hub as deps.voice.
//
// Voice keeps recording when Rukoo quits, so close() never stops a meeting.
//
// Hiding Rukoo from screen capture fails closed: while Rukoo believes a meeting records, protect(true) holds, also
// when the socket drops, until Voice says the meeting ended or the user turns the setting off. A start from Rukoo
// protects first and waits for the next desktop composition before it asks Voice to start, because protection lags
// one composition behind setContentProtection. A meeting Voice starts itself says meeting.starting before Voice
// captures the screen: Rukoo protects the same way, waits, and answers meeting.protected (voice/PROTOCOL.md). From
// that event on the meeting records as far as Rukoo knows, as after a start from Rukoo, so a connection that drops
// before Voice's status arrives keeps the windows hidden.

const path = require('path');
const { EventEmitter } = require('events');
const { VoiceStore } = require('./store');
const { VoiceBridge, VoiceError } = require('./bridge');
const { isMeetingId, TITLE_MAX, LABEL_MAX, SCREENS } = require('./protocol');
const { candidateEvents, suggest, compareSpeakers, WINDOW_MS } = require('./speakers');
const { bridgePathHere } = require('./paths');

const PROTECT_DELAY_MS = 100;
// How often Rukoo tries again to hide or show its windows after a window didn't take it.
const PROTECT_RETRY_MS = 1000;
const EMIT_MS = 150;
const LINK_WITHIN_MS = 12 * 60 * 60 * 1000;
const EVENT_ID_MAX = 4000;
// How long a meeting.starting keeps the windows hidden by itself, besides the status it sets: until the meeting's
// state arrives, or this long.
const STARTING_HOLD_MS = 10000;
// meeting.protected answers quickly or not at all: Voice stops waiting for it after 500 ms.
const PROTECTED_TIMEOUT_MS = 2000;
const SCREEN_STATES = ['starting', 'recording', 'paused', 'locked', 'stopped'];
const ENDED_STATES = ['processing', 'done', 'failed'];
const MONITOR_MAX = 64;
const MONITOR_NAME_MAX = 200;
const CLIP_PATH_MAX = 4096;
// media.open and media.read: the bridge's own 10 s, kept as an option of its own so tests can shorten it. Either can
// wait behind another command Voice runs on the same connection, such as a clip.get of up to 4 s.
const MEDIA_TIMEOUT_MS = 10000;

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

// calls: how many voices the meeting has on the call. A name Rukoo filled in for a 1:1 is a guess once a second voice
// turns up, so the People card asks the user to check it (autoCheck) rather than dropping a probably right name.
function speakerView(s, calls = 1) {
  return { id: s.id, track: s.track, label: s.label, name: s.name, address: s.address, from: s.from, you: s.track === 'mic', autoCheck: s.from === 'auto' && calls > 1 };
}

const count = (v) => Number.isInteger(v) && v >= 0;
const badReply = (what) => new VoiceError('failed', `Rukoo Voice sent ${what} Rukoo can't read.`);

// clip.get's answer, checked (voice/PROTOCOL.md "Commands"): each clip an MP4 file on this computer.
function checkClips(result) {
  if (!result || !Array.isArray(result.clips)) throw badReply('a clip list');
  return {
    clips: result.clips.map((c) => {
      const ok =
        c && typeof c.path === 'string' && c.path.length <= CLIP_PATH_MAX && path.isAbsolute(c.path) && /\.mp4$/i.test(c.path) && count(c.start) && count(c.end) && c.end >= c.start && count(c.width) && count(c.height) && count(c.bytes);
      if (!ok) throw badReply('a clip');
      return { path: c.path, start: c.start, end: c.end, width: c.width, height: c.height, bytes: c.bytes };
    })
  };
}

// screen.get's answer, checked: the screen recording and the monitors it can move to, left to right.
function checkScreen(result) {
  const r = result || {};
  const monitorId = (v) => typeof v === 'string' && v.length > 0 && Array.from(v).length <= MONITOR_MAX;
  if (!SCREENS.includes(r.screen) || !SCREEN_STATES.includes(r.state) || typeof r.video !== 'boolean' || typeof r.frames !== 'boolean' || !(r.monitor === null || monitorId(r.monitor)) || !Array.isArray(r.monitors)) {
    throw badReply('a screen recording');
  }
  const monitors = r.monitors.map((m) => {
    if (!m || !monitorId(m.id) || typeof m.name !== 'string' || !count(m.width) || !count(m.height) || typeof m.primary !== 'boolean') throw badReply('a monitor');
    return { id: m.id, name: Array.from(m.name).slice(0, MONITOR_NAME_MAX).join(''), width: m.width, height: m.height, primary: m.primary };
  });
  return { screen: r.screen, state: r.state, video: r.video, frames: r.frames, monitor: r.monitor, monitors };
}

class VoiceService extends EventEmitter {
  // discovery: the discovery file (paths.bridgePathHere), or null for a profile that never looks for Voice.
  // hide(): whether the user wants Rukoo hidden from screen capture during a meeting. protect(on): hides or shows
  // every window, and returns false or throws when a window didn't take it. calendars, engine: for the linked event
  // and the names of its guests. mediaTimeoutMs: how long media.open and media.read may take, shorter in tests.
  constructor({ dataDir, discovery = null, appVersion = '', hide = () => true, protect = () => {}, calendars = null, WebSocket, bridge = {}, protectDelayMs = PROTECT_DELAY_MS, protectRetryMs = PROTECT_RETRY_MS, startingHoldMs = STARTING_HOLD_MS, emitMs = EMIT_MS, mediaTimeoutMs = MEDIA_TIMEOUT_MS, now = Date.now, log = () => {} } = {}) {
    super();
    this.store = new VoiceStore({ dataDir, now, log });
    // A meeting file found damaged when a meeting is read: Voice sends the meeting again while it is connected.
    this.store.onDamaged = () => this.recoverDamaged();
    this.bridge = new VoiceBridge({ file: discovery, clientVersion: appVersion, cursor: () => this.store.cursor(), WebSocket, log, ...bridge });
    this.hide = hide;
    this.protect = protect;
    this.calendars = calendars;
    this.protectDelayMs = protectDelayMs;
    this.protectRetryMs = protectRetryMs;
    this.protectRetry = null;
    this.startingHoldMs = startingHoldMs;
    this.emitMs = emitMs;
    this.mediaTimeoutMs = mediaTimeoutMs;
    this.now = now;
    this.log = log;
    this.starting = 0;
    // The meeting.starting holds still counting in starting, by meeting id: their timers. heldOver: how many of them
    // ran out of time while the connection was down, and still count until the next welcome.
    this.holds = new Map();
    this.heldOver = 0;
    // The screen the last start from Rukoo asked for, until Voice's meeting.started says what it records.
    this.startScreen = null;
    // clip.get goes one at a time on a connection (voice/PROTOCOL.md): Voice runs a connection's commands in turn, and
    // a cut can take 4 s, so a second one in the queue would hold up the heartbeat behind both.
    this.clipChain = null;
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
    // A new connection has nothing in flight: its clips don't wait for the old one's.
    this.bridge.on('closed', () => {
      this.clipChain = null;
    });
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
    return { status: s.status, reason: s.reason, voiceVersion: s.voiceVersion, protocol: s.protocol, older: s.older, recording: status.recording, dictating: status.dictating, screenDefault: status.screenDefault };
  }

  recording() {
    return this.store.status().recording;
  }

  // Whether Voice may record the screen now, as far as Rukoo knows: main holds back notifications then, so they stay
  // out of the frames. Also while a start is on its way. Only a mode known for the recording meeting lets them show:
  // what its meeting.started says, or before that the screen a start from Rukoo asked for. Voice's default doesn't
  // count, because the meeting may have started with another one, as when Rukoo connects to a meeting it has no
  // meeting.started for yet. Not after a dropped mark on the screen track, which says the screen recording stopped
  // for good.
  screenRecording() {
    if (this.starting > 0) return true;
    const id = this.recording();
    if (!id) return false;
    const e = this.store.entry(id);
    if (e && e.startedAt !== null) return e.screen !== 'off' && !this.store.screenDropped(id);
    const asked = this.startScreen && this.startScreen.id === id ? this.startScreen.screen : null;
    return asked !== 'off';
  }

  get connected() {
    return this.bridge.connected;
  }

  shouldProtect() {
    return Boolean(this.hide()) && (Boolean(this.recording()) || this.starting > 0);
  }

  // Also for main when the user changes the setting. Returns whether the windows are as they should be. protect(on)
  // fails by throwing or by returning false when a window didn't take it: then Rukoo doesn't know what the windows
  // show, confirms nothing to Voice, and tries again every protectRetryMs until it works.
  refreshProtection() {
    clearTimeout(this.protectRetry);
    this.protectRetry = null;
    const on = this.shouldProtect();
    if (on === this.protectedNow) return true;
    let ok = false;
    try {
      ok = this.protect(on) !== false;
      if (!ok) this.log('voice', `${on ? 'hiding' : 'showing'} the windows failed`);
    } catch (err) {
      this.log('voice', `protecting the windows failed: ${err.message}`);
    }
    if (ok) {
      this.protectedNow = on;
      return true;
    }
    this.protectedNow = null;
    if (!this.closed) {
      this.protectRetry = setTimeout(() => {
        this.protectRetry = null;
        // main reports the windows hidden only once they are.
        if (this.refreshProtection()) this.emit('state', this.state());
      }, this.protectRetryMs);
      if (this.protectRetry.unref) this.protectRetry.unref();
    }
    return false;
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
    this.clipChain = null;
    const { reset, gap } = this.store.welcome(msg);
    this.statusChanged();
    this.endHeldOver();
    if (reset) this.emit('meeting', { kind: 'list' });
    // Voice already deleted events Rukoo missed: ask for every meeting Rukoo has. A done meeting can't change, but
    // Voice may have deleted it meanwhile, and its meeting.removed may be among the events Rukoo missed.
    if (gap || this.store.damaged.size) this.refetch(gap).catch(() => {});
  }

  // One refetch of the damaged meetings at a time. Damage found while one runs is fetched when it ends. It starts on
  // the next turn, so the read that found the damage finishes first.
  recoverDamaged() {
    if (!this.connected || !this.store.damaged.size) return;
    if (this.recovering) {
      this.recoverAgain = true;
      return;
    }
    this.recovering = true;
    setImmediate(() => {
      this.refetch(false)
        .catch(() => {})
        .finally(() => {
          this.recovering = false;
          if (this.recoverAgain) {
            this.recoverAgain = false;
            this.recoverDamaged();
          }
        });
    });
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
    const live = !this.store.isReplay(ev.seq);
    // A meeting.starting in the replay is history: Voice stopped waiting for it long ago.
    if (ev.event === 'meeting.starting' && live) {
      this.startedByVoice(ev.meeting);
      this.onStarting(ev.meeting).catch(() => {});
    }
    // The meeting's state took over from the hold of its meeting.starting.
    if (ev.event === 'meeting.state' && live) this.releaseStarting(ev.meeting);
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
      d = { from: before, passages: new Set(), removed: new Set(), marks: new Set(), frames: new Set(), speakers: false, notes: false, all: false };
      this.deltas.set(id, d);
    }
    if (change.kind === 'passage') {
      d.passages.add(change.id);
      d.removed.delete(change.id);
    } else if (change.kind === 'passage.removed') {
      d.passages.delete(change.id);
      d.removed.add(change.id);
    } else if (change.kind === 'mark') d.marks.add(change.id);
    else if (change.kind === 'frame') d.frames.add(change.id);
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
        if (d.frames.size) payload.frames = full.frames.filter((f) => d.frames.has(f.id));
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
        this.startScreen = { id, screen: SCREENS.includes(args.screen) ? args.screen : null };
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

  // The frame at or before at (meeting time in ms): {frame, image: {type, data}}. A frame Rukoo has without its text
  // (a snapshot left it out) gets the text from the answer, and the renderer hears of it with the next delta.
  async frame(id, at) {
    this.mustConnect();
    const res = await this.bridge.command('frame.get', { meeting: id, at });
    const before = this.revOf(id);
    const change = this.store.frameText(id, res && res.frame);
    if (change) this.note(change, before);
    return res;
  }

  // The meeting's video between start and end (ms), cut by Voice into MP4 files on this computer: {clips: [{path,
  // start, end, width, height, bytes}]}. clips is empty while Voice still cuts; the same call later gets the files.
  async clip(id, start, end) {
    this.mustConnect();
    const prev = this.clipChain || Promise.resolve();
    const mine = prev.then(() => {
      this.mustConnect();
      return this.bridge.command('clip.get', { meeting: id, start, end });
    });
    // The next clip waits for this one whatever its answer.
    const settled = mine.then(
      () => {},
      () => {}
    );
    this.clipChain = settled;
    settled.then(() => {
      if (this.clipChain === settled) this.clipChain = null;
    });
    return checkClips(await mine);
  }

  // The meeting's screen recording: {screen, state, video, frames, monitor, monitors: [{id, name, width, height,
  // primary}]}.
  async screenInfo(id) {
    this.mustConnect();
    return checkScreen(await this.bridge.command('screen.get', { meeting: id }));
  }

  // Moves the screen recording to another monitor of screenInfo's list; the id of the monitor it records now.
  async selectMonitor(id, monitor) {
    this.mustConnect();
    const res = await this.bridge.command('screen.select', { meeting: id, monitor });
    if (!res || typeof res.monitor !== 'string' || !res.monitor) throw badReply('a monitor');
    return res.monitor;
  }

  // ---------- the start handshake of a meeting Voice started ----------

  // Voice records the audio when it says meeting.starting, and its status may still be on its way: the meeting
  // records from now, as far as protection and notifications go, as after a start from Rukoo. Only what Voice says
  // next lets go of that: its status, the meeting's end, or the status of the next welcome. The store keeps it, so
  // it also holds across a restart of Rukoo while Voice is out of reach.
  startedByVoice(id) {
    const e = this.store.entry(id);
    if (e && ENDED_STATES.includes(e.state)) return;
    this.store.setStatus({ ...this.store.status(), recording: id });
  }

  // Voice waits up to 500 ms for this before it captures the screen. starting counts from the moment the event
  // arrives, so protection is on before the ack and stays on until the meeting's state says it records. The ack
  // says the windows are hidden, so it goes only once every window took it: otherwise Voice stops waiting and
  // starts as without a confirmation, while Rukoo keeps trying to hide them.
  async onStarting(id) {
    this.starting += 1;
    try {
      if (this.shouldProtect()) {
        if (!this.refreshProtection()) return;
        await delay(this.protectDelayMs);
        if (this.shouldProtect() && this.protectedNow !== true) return;
      }
      await this.bridge.command('meeting.protected', { meeting: id }, { timeoutMs: PROTECTED_TIMEOUT_MS });
    } finally {
      this.holdStarting(id);
    }
  }

  // Keeps one count of starting for the meeting until its meeting.state arrives or ms pass. When that state came
  // during the wait for the composition, there is nothing to hold: the status keeps the windows hidden while the
  // meeting records, and a meeting that ended no longer needs them hidden.
  holdStarting(id, ms = this.startingHoldMs) {
    const e = this.store.entry(id);
    if (this.closed || this.recording() === id || (e && ENDED_STATES.includes(e.state))) {
      this.endStarting();
      return;
    }
    let timers = this.holds.get(id);
    if (!timers) {
      timers = new Set();
      this.holds.set(id, timers);
    }
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (!timers.size) this.holds.delete(id);
      // Without a connection nothing can say whether Voice still records: the hold lasts until the next welcome.
      if (this.connected || this.closed) this.endStarting();
      else this.heldOver += 1;
    }, ms);
    if (timer.unref) timer.unref();
    timers.add(timer);
  }

  releaseStarting(id) {
    const timers = this.holds.get(id);
    if (!timers) return;
    this.holds.delete(id);
    for (const timer of timers) {
      clearTimeout(timer);
      this.endStarting();
    }
  }

  endStarting() {
    this.starting = Math.max(0, this.starting - 1);
    if (!this.closed) this.refreshProtection();
  }

  // The holds whose time ran out while the connection was down, once the welcome's status says what records.
  endHeldOver() {
    for (; this.heldOver > 0; this.heldOver -= 1) this.endStarting();
  }

  // media.open: { media, ready, type?, size?, start?, end? }. Voice answers at once; call again until ready is true.
  // start and end are meeting ms; end is left out for a frame.
  async mediaOpen({ meeting, kind, start, end }) {
    this.mustConnect();
    const args = { meeting, kind, start };
    if (Number.isInteger(end)) args.end = end;
    return this.bridge.command('media.open', args, { timeoutMs: this.mediaTimeoutMs });
  }

  // media.read: { offset, data } with up to length bytes of a prepared file from offset, in base64.
  async mediaRead(media, offset, length) {
    this.mustConnect();
    return this.bridge.command('media.read', { media, offset, length }, { timeoutMs: this.mediaTimeoutMs });
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
    if (!out.conflict && !out.tooLong) this.note({ meeting: id, kind: 'notes' }, before);
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

  // In one order for the meeting view and meetingGet: the microphone, then call-1, call-2, …, call-10 by number.
  speakers(id) {
    const full = this.store.meeting(id);
    if (!full) return [];
    const event = this.calendarEvent(full.meeting.eventId);
    const { suggestions } = suggest(full.speakers, event);
    const calls = full.speakers.filter((s) => s.track === 'call').length;
    return [...full.speakers].sort(compareSpeakers).map((s) => ({ ...speakerView(s, calls), suggestions: suggestions[s.id] || [] }));
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

  // A 1:1 gets its name without asking: one voice on the call and one guest who can be it, and no name yet. When a
  // second voice turns up later the name stays, and speakerView marks it for the user to check.
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
    clearTimeout(this.protectRetry);
    this.protectRetry = null;
    for (const timers of this.holds.values()) for (const timer of timers) clearTimeout(timer);
    this.holds.clear();
    this.bridge.close();
    this.store.close();
  }
}

module.exports = { VoiceService, VoiceError, bridgePathHere, summary };
