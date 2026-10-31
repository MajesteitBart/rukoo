import { t, getLocale } from './i18n.js';
import { icons } from './icons.js';
import { api, esc, $, hhmm, hue, initials, readerDate, groupLabel, toast, showMenu, segmented, setSegmented } from './ui.js';
import { promptDialog } from './settings.js';

// The meeting view: Rukoo Voice's meetings, a third mode next to Mail and Calendar (Ctrl+3). Voice records and
// transcribes; main keeps what Rukoo owns of each meeting (src/main/voice) and sends 'meeting' events. This module
// draws the meeting on screen with its controls, the transcript as it comes in, who spoke, the linked calendar event
// and the user's notes. It also draws the list of meetings in the sidebar and the recording indicator in the title bar.
//
// Everything in a meeting was said, shown or written by other people, and attendee names come from whoever sent the
// invitation: it reaches the DOM only through esc() or textContent.

const SAVED = 'rukoo.meeting';
const NOTES_WAIT = 700;
const STOP_CONFIRM_MS = 3000;
// Two passages of one voice this close together read as one stretch: the name shows once.
const SAME_STRETCH_MS = 30000;
const LIVE = new Set(['recording', 'paused']);
const VOICE_ERRORS = new Set(['offline', 'timeout', 'busy', 'not_found', 'not_recording', 'not_available', 'failed', 'bad_request', 'unknown_command']);

const M = {
  open: false,
  // What main says about Rukoo Voice (voiceState in main.js).
  voice: { status: 'absent', reason: 'none', voiceVersion: null, older: null, recording: null, dictating: false, hidden: false, canHide: false },
  // Summaries, newest first (meetingList).
  list: [],
  listLoaded: false,
  // The meeting on screen and everything about it (meetingGet), or null while it loads or when Rukoo lacks it.
  id: readSaved(),
  data: null,
  // The meeting the last meetingGet answered for: until then the view shows that it loads.
  fetched: null,
  loading: 0,
  // In a narrow window the transcript, the notes and the people share the view as tabs.
  tab: 'transcript',
  starting: false,
  confirmStop: null,
  // The passage whose text the user is correcting; changes to it wait until the editor closes.
  editing: null
};
let ctx = null;
let bound = false;

function readSaved() {
  try {
    const id = localStorage.getItem(SAVED);
    return typeof id === 'string' && /^m-[0-9]{8}-[0-9]{6}-[0-9a-f]{4}$/.test(id) ? id : null;
  } catch (_) {
    return null;
  }
}
function saveId(id) {
  try {
    if (id) localStorage.setItem(SAVED, id);
    else localStorage.removeItem(SAVED);
  } catch (_) {
    // A full or blocked storage only means the view opens on the newest meeting next time.
  }
}

// ---------- formatting ----------

const pad = (n) => String(n).padStart(2, '0');
// Meeting time: "4:05", or "1:04:05" past the hour.
function clock(ms) {
  const s = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}
// A stretch of time in words: "12 sec", "1 min, 5 sec".
function length(ms) {
  const total = Math.max(1, Math.round((Number(ms) || 0) / 1000));
  const parts = { hours: Math.floor(total / 3600), minutes: Math.floor((total % 3600) / 60), seconds: total % 60 };
  if (parts.hours) delete parts.seconds;
  for (const k of Object.keys(parts)) if (!parts[k]) delete parts[k];
  try {
    return new Intl.DurationFormat(getLocale(), { style: 'short' }).format(parts);
  } catch (_) {
    return [parts.hours && `${parts.hours} h`, parts.minutes && `${parts.minutes} min`, parts.seconds && `${parts.seconds} s`].filter(Boolean).join(' ');
  }
}
const live = (s) => Boolean(s) && LIVE.has(s.state);
// How long the meeting has run: up to now while it records or pauses (the clock keeps running), else its length.
function elapsed(s, now = Date.now()) {
  if (!s || !Number.isFinite(s.startedAt)) return null;
  const end = live(s) ? now : s.endedAt;
  return Number.isFinite(end) ? Math.max(0, end - s.startedAt) : null;
}
const summaryOf = (id) => M.list.find((m) => m.id === id) || null;
// A linked event's time, short enough for the side column: "Mon 2 Nov, 09:30 – 09:45".
function eventWhen(e) {
  if (!Number.isFinite(e.start) || !Number.isFinite(e.end)) return '';
  const day = new Intl.DateTimeFormat(getLocale(), { weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(e.start));
  return `${day}, ${hhmm(e.start)} – ${hhmm(e.end)}`;
}
// The meeting's own title, else the linked event's, else when it started.
function titleOf(s, event = null) {
  if (s && s.title && s.title.trim()) return s.title.trim();
  if (event && !event.missing && event.title) return event.title;
  if (s && Number.isFinite(s.startedAt)) return t('meeting.untitled', { time: hhmm(s.startedAt) });
  return t('meeting.untitledNoTime');
}

// What Voice said back when a command failed, in the user's words.
export function voiceError(err) {
  const code = err && err.voice;
  return VOICE_ERRORS.has(code) ? t(`meeting.errors.${code}`) : (err && err.message) || t('meeting.errors.failed');
}

// Why Rukoo can't record now, or null when it can.
function notReadyText(v = M.voice) {
  if (v.status === 'connected') return v.recording ? t('meeting.errors.busy') : null;
  if (v.status === 'connecting') return t('meeting.voice.connecting');
  if (v.status === 'incompatible') return v.older === 'rukoo' ? t('meeting.voice.updateRukoo') : t('meeting.voice.updateVoice');
  if (v.status === 'insecure') return t('meeting.voice.insecure');
  return t('meeting.voice.absent');
}

// ---------- the API app.js uses ----------

export function init(context) {
  ctx = context;
  Promise.all([api('voiceState').catch(() => null), api('meetingList').catch(() => null)]).then(([state, list]) => {
    if (state) M.voice = state;
    if (Array.isArray(list)) M.list = list;
    M.listLoaded = true;
    afterVoice();
    redrawSide();
    if (M.open) pickAndOpen();
  });
}

export const isOpen = () => M.open;
export const voiceState = () => ({ ...M.voice });

export function show() {
  M.open = true;
  bind();
  pickAndOpen();
}

export function hide() {
  M.open = false;
  flushNotes();
  closeEditor(false);
}

// After a language change everything is drawn again.
export function relocalize() {
  const el = $('.meeting');
  // The notes field is built again: what was typed goes out first, and stays in the new field.
  const area = $('.meeting .mt-notes-input');
  const typed = area && (N.dirty || N.saving) ? area.value : null;
  flushNotes();
  if (el) {
    el.innerHTML = '';
    delete el.dataset.id;
  }
  renderIndicator();
  if (M.open) renderView();
  const next = $('.meeting .mt-notes-input');
  if (next && typed !== null) next.value = typed;
}

// The meeting the chat panel follows: the one on screen in meeting mode.
export function current() {
  if (!M.open || !M.id) return null;
  const s = (M.data && M.data.meeting) || summaryOf(M.id);
  if (!s || s.removed) return null;
  return { id: M.id, title: titleOf(s, M.data && M.data.event), eventId: s.eventId || null };
}

// Opens one meeting in the view (app.js has switched to meeting mode).
export function open(id) {
  if (!id) return;
  if (id === M.id && M.data) {
    renderView();
    return;
  }
  flushNotes();
  closeEditor(false);
  M.id = id;
  M.data = null;
  M.fetched = null;
  M.tab = 'transcript';
  saveId(id);
  renderView();
  redrawSide();
  fetchMeeting(id);
  ctx.agentSync?.();
}

// Starts a recording through Rukoo Voice: from the sidebar, the empty view or a calendar event's card. opts:
// {title, eventId}. The new meeting opens once Voice has it.
export async function record(opts = {}) {
  const why = notReadyText();
  if (why) return toast(why, 5000);
  if (M.starting) return;
  M.starting = true;
  renderSideSoon();
  try {
    const res = await api('meetingStart', { title: opts.title || '', eventId: opts.eventId || null });
    if (res && res.meetingId) {
      await reloadList();
      ctx.openMeeting(res.meetingId);
    }
  } catch (err) {
    toast(voiceError(err), 6000);
  } finally {
    M.starting = false;
    renderSideSoon();
  }
}

// The meeting view takes its keys itself; app.js passes on what reaches the document.
export function onKey() {
  return false;
}

// Main's 'meeting' events (main.js voice block): the Voice state, a change to one meeting, a removed meeting, or
// "fetch the list again".
export function onEvent(p) {
  if (!p || typeof p !== 'object') return;
  if (p.kind === 'state' && p.state) return setVoice(p.state);
  if (p.kind === 'list') return reloadList().then(() => redrawSide());
  // Voice deleted a meeting. Main keeps it only for the notes the user wrote, marked removed.
  if (p.kind === 'removed') {
    M.list = M.list.filter((m) => m.id !== p.id);
    if (p.id === M.id) {
      M.data = null;
      M.fetched = null;
    }
    return reloadList().then(() => {
      if (p.id === M.id && M.open) fetchMeeting(M.id);
      redrawSide();
    });
  }
  if (p.kind === 'meeting') applyDelta(p);
}

// ---------- data ----------

async function reloadList() {
  try {
    const list = await api('meetingList');
    if (Array.isArray(list)) M.list = list;
    M.listLoaded = true;
  } catch (_) {
    // The list on screen stays.
  }
  renderIndicator();
}

function upsertSummary(s) {
  if (!s || !s.id) return false;
  const i = M.list.findIndex((m) => m.id === s.id);
  const before = i >= 0 ? M.list[i] : null;
  if (i >= 0) M.list[i] = s;
  else {
    M.list.push(s);
    M.list.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0) || (a.id < b.id ? 1 : -1));
  }
  // The sidebar shows the title, the state and the start.
  return !before || before.title !== s.title || before.state !== s.state || before.startedAt !== s.startedAt || before.removed !== s.removed || before.eventId !== s.eventId;
}

// The meeting to show when the view opens: the one recording, else the one from before, else the newest.
function pickAndOpen() {
  if (!M.listLoaded) return renderView();
  // The recording comes first, also when its first events are still on their way: they fetch it once they arrive.
  const rec = M.voice.recording;
  const known = (id) => id && summaryOf(id);
  const id = rec || (known(M.id) ? M.id : null) || (M.list.find((m) => !m.removed) || M.list[0] || {}).id || null;
  if (id && id !== M.id) return open(id);
  if (id && !M.data) {
    renderView();
    return fetchMeeting(id);
  }
  if (!id) {
    M.id = null;
    M.data = null;
  }
  renderView();
}

let pickTimer = null;
function pickSoon() {
  clearTimeout(pickTimer);
  pickTimer = setTimeout(() => M.open && !M.id && pickAndOpen(), 120);
}

async function fetchMeeting(id) {
  const mine = ++M.loading;
  let data = null;
  try {
    data = await api('meetingGet', id);
  } catch (_) {
    data = null;
  }
  if (mine !== M.loading || id !== M.id) return;
  // Gone from Voice and from Rukoo, notes and all: the view moves on to the next meeting.
  if (!data && M.open && !summaryOf(id) && id !== M.voice.recording) {
    M.id = null;
    M.data = null;
    saveId(null);
    return pickAndOpen();
  }
  M.data = data;
  M.fetched = id;
  if (data && data.meeting) upsertSummary(data.meeting);
  renderView({ fetched: true });
  ctx.agentSync?.();
}

function setVoice(state) {
  const before = M.voice;
  M.voice = { ...M.voice, ...state };
  const started = M.voice.recording && M.voice.recording !== before.recording;
  if (started && !summaryOf(M.voice.recording)) reloadList().then(() => redrawSide());
  // A recording that starts while the view is open shows at once, unless the user is writing in this one.
  if (started && M.open && M.voice.recording !== M.id && !busyHere()) open(M.voice.recording);
  afterVoice();
  if (before.status !== M.voice.status || before.recording !== M.voice.recording) redrawSide();
  if (M.open) {
    if (M.data) {
      renderHead();
      renderNotice();
      renderLive();
    } else renderView();
  }
}

function busyHere() {
  const el = document.activeElement;
  return Boolean(M.editing) || Boolean(el && el.closest && el.closest('.mt-notes-input'));
}

// A change to one meeting, batched by main. from is the meeting's rev before it: a view that holds another rev
// missed one, and fetches the meeting again.
function applyDelta(p) {
  const listChanged = upsertSummary(p.meeting);
  if (listChanged) redrawSide();
  renderIndicator();
  if (M.open && p.id === M.id && !M.data) return fetchMeeting(M.id);
  if (p.id !== M.id || !M.data) {
    // The view had nothing to show, and now there is a meeting: once the rest of this batch is in, the newest.
    if (M.open && !M.id) pickSoon();
    return;
  }
  const d = M.data;
  const eventChanged = (p.meeting && p.meeting.eventId) !== d.meeting.eventId;
  if (p.refetch || d.rev !== p.from || eventChanged) return fetchMeeting(M.id);
  d.meeting = p.meeting;
  d.rev = p.rev;
  const changed = [];
  if (Array.isArray(p.passages)) {
    for (const x of p.passages) {
      const i = d.passages.findIndex((y) => y.id === x.id);
      if (i >= 0) d.passages[i] = x;
      else d.passages.push(x);
      changed.push(`p:${x.id}`);
    }
    d.passages.sort((a, b) => a.start - b.start || (a.track < b.track ? -1 : 1));
  }
  const removed = Array.isArray(p.removedPassages) ? p.removedPassages : [];
  if (removed.length) d.passages = d.passages.filter((x) => !removed.includes(x.id));
  if (Array.isArray(p.marks)) {
    for (const k of p.marks) {
      const i = d.marks.findIndex((y) => y.id === k.id);
      if (i >= 0) d.marks[i] = k;
      else d.marks.push(k);
      changed.push(`k:${k.id}`);
    }
  }
  if (Array.isArray(p.speakers)) d.speakers = p.speakers;
  if (p.notes) notesArrived(p.notes);
  if (!M.open) return;
  renderHead();
  renderNotice();
  if (Array.isArray(p.speakers)) {
    renderPeople();
    renderTranscript(true);
  } else updateRows(changed, removed.map((id) => `p:${id}`));
  renderLive();
  if (listChanged) ctx.agentSync?.();
}

// ---------- the view ----------

function bind() {
  if (bound) return;
  const el = $('.meeting');
  if (!el) return;
  bound = true;
  el.addEventListener('click', onClick);
  el.addEventListener('dblclick', (e) => {
    const text = e.target.closest('.mt-passage .mt-text');
    if (text) editPassage(text.closest('.mt-row'));
  });
  el.addEventListener('contextmenu', onContextMenu);
  el.addEventListener('keydown', onViewKey);
  el.addEventListener('input', (e) => {
    if (e.target.matches('.mt-notes-input')) notesTyped();
    if (e.target.matches('.mt-edit')) grow(e.target);
  });
  el.addEventListener('focusout', (e) => {
    if (e.target.matches && e.target.matches('.mt-notes-input')) saveNotes();
  });
}

// fetched: the meeting on screen came again from main (a delta it missed): its transcript and notes follow too.
function renderView({ fetched = false } = {}) {
  const el = $('.meeting');
  if (!el || !M.open) return;
  bind();
  const d = M.data;
  if (!d || !d.meeting) {
    delete el.dataset.id;
    // A recording whose first events haven't arrived yet loads until they do.
    const waiting = M.id && (M.fetched !== M.id || M.id === M.voice.recording);
    el.innerHTML = !M.listLoaded || waiting ? loadingHtml() : emptyHtml();
    return;
  }
  if (el.dataset.id !== d.meeting.id) {
    el.dataset.id = d.meeting.id;
    el.innerHTML = shellHtml();
    fillNotes(d);
    renderTranscript(true, { bottom: true });
  } else if (fetched) {
    renderTranscript(true);
    if (d.notes) notesArrived(d.notes);
  }
  el.dataset.tab = M.tab;
  renderHead();
  renderNotice();
  renderPeople();
  renderEvent();
  renderLive();
}

function loadingHtml() {
  return `<div class="mt-empty" aria-busy="true"><span class="spinner"></span></div>`;
}

// Nothing to show: the way to record a meeting, or why Rukoo can't.
function emptyHtml() {
  const v = M.voice;
  let title = t('meeting.empty.startVoice');
  let body = t('meeting.empty.body');
  let after = `<div class="mt-empty-hint">${esc(t('meeting.empty.voiceHint'))}</div>`;
  if (v.status === 'connected') {
    title = t('meeting.empty.title');
    after = `<button class="btn primary" data-mt="record">${icons.record}<span>${esc(t('meeting.actions.record'))}</span></button><div class="mt-empty-hint">${esc(t('meeting.empty.calendarHint'))}</div>`;
  } else if (v.status === 'connecting') {
    title = t('meeting.voice.connecting');
    after = '';
  } else if (v.status !== 'absent') {
    title = t('meeting.empty.cantConnect');
    body = notReadyText(v);
    after = '';
  }
  return `<div class="mt-empty">${icons.mic}<div class="t">${esc(title)}</div><div class="mt-empty-body">${esc(body)}</div>${after}</div>`;
}

function shellHtml() {
  const tabs = segmented({
    name: 'mt-tab',
    label: t('meeting.tabs.label'),
    value: M.tab,
    options: [
      { value: 'transcript', label: t('meeting.tabs.transcript') },
      { value: 'notes', label: t('meeting.tabs.notes') },
      { value: 'people', label: t('meeting.tabs.details') }
    ]
  });
  return `<header class="mt-head"></header>
    <div class="mt-notice" hidden></div>
    <div class="mt-tabs">${tabs}</div>
    <div class="mt-body">
      <section class="mt-transcript-pane" aria-label="${esc(t('meeting.tabs.transcript'))}">
        <div class="mt-scroll" tabindex="-1">
          <ol class="mt-transcript" tabindex="0" aria-label="${esc(t('meeting.transcript.label'))}"></ol>
          <div class="mt-live" aria-live="polite"></div>
        </div>
        <button class="mt-jump" data-mt="jump" hidden>${icons.down}<span>${esc(t('meeting.transcript.latest'))}</span></button>
      </section>
      <aside class="mt-side">
        <section class="mt-card mt-event-card" data-pane="people">
          <h2 class="mt-card-title">${esc(t('meeting.event.title'))}</h2>
          <div class="mt-event-box"></div>
        </section>
        <section class="mt-card mt-people-card" data-pane="people">
          <h2 class="mt-card-title">${esc(t('meeting.speakers.title'))}</h2>
          <div class="mt-people"></div>
        </section>
        <section class="mt-card mt-notes-card" data-pane="notes">
          <div class="mt-card-head"><h2 class="mt-card-title" id="mt-notes-title">${esc(t('meeting.notes.title'))}</h2><span class="mt-notes-status" aria-live="polite"></span></div>
          <textarea class="mt-notes-input sel" spellcheck="true" aria-labelledby="mt-notes-title" placeholder="${esc(t('meeting.notes.placeholder'))}"></textarea>
        </section>
      </aside>
    </div>`;
}

// ---------- header ----------

function stateHtml(s) {
  if (s.removed) return `<span class="mt-state">${esc(t('meeting.state.removed'))}</span>`;
  const cls = { recording: 'is-rec', paused: 'is-paused', processing: 'is-busy', failed: 'is-failed' }[s.state];
  if (!cls) return '';
  const title = s.state === 'failed' && s.reason ? ` title="${esc(s.reason)}"` : '';
  return `<span class="mt-state ${cls}"${title}><i aria-hidden="true"></i>${esc(t(`meeting.state.${s.state}`))}</span>`;
}

function renderHead() {
  const head = $('.meeting .mt-head');
  const d = M.data;
  if (!head || !d) return;
  const s = d.meeting;
  const connected = M.voice.status === 'connected';
  const disabled = connected ? '' : `disabled title="${esc(notReadyText() || '')}"`;
  const ms = elapsed(s);
  const when = Number.isFinite(s.startedAt) ? readerDate(s.startedAt) : '';
  const meta = [
    stateHtml(s),
    ms !== null ? `<span class="mt-elapsed" title="${esc(t('meeting.head.length'))}">${esc(live(s) ? clock(ms) : length(ms))}</span>` : '',
    when ? `<span class="mt-when">${esc(when)}</span>` : '',
    live(s) && M.voice.hidden ? `<span class="mt-hidden" title="${esc(t('meeting.head.hiddenHelp'))}">${icons.eyeOff}<span>${esc(t('meeting.head.hidden'))}</span></span>` : ''
  ]
    .filter(Boolean)
    .join('');
  const confirming = M.confirmStop === s.id;
  const actions = live(s)
    ? `<button class="tbtn" data-mt="mark" ${disabled}>${icons.flag}<span>${esc(t('meeting.actions.mark'))}</span></button>
       <button class="tbtn" data-mt="${s.state === 'paused' ? 'resume' : 'pause'}" ${disabled}>${s.state === 'paused' ? icons.play : icons.pause}<span>${esc(t(s.state === 'paused' ? 'meeting.actions.resume' : 'meeting.actions.pause'))}</span></button>
       <button class="tbtn primary ${confirming ? 'is-confirm' : ''}" data-mt="stop" ${disabled}>${icons.stop}<span>${esc(t(confirming ? 'meeting.actions.stopConfirm' : 'meeting.actions.stop'))}</span></button>`
    : '';
  const focused = head.contains(document.activeElement) ? document.activeElement.dataset.mt : null;
  head.innerHTML = `<div class="mt-titles"><h1 class="mt-title sel" title="${esc(titleOf(s, d.event))}">${esc(titleOf(s, d.event))}</h1><div class="mt-meta">${meta}</div></div><div class="mt-actions">${actions}</div>`;
  // A redraw keeps the keyboard where it was; Pause becomes Resume in the same place.
  if (focused) (head.querySelector(`[data-mt="${focused}"]`) || head.querySelector(`[data-mt="${focused === 'pause' ? 'resume' : focused === 'resume' ? 'pause' : ''}"]`))?.focus();
}

// A line under the header when something about the meeting needs saying.
function renderNotice() {
  const el = $('.meeting .mt-notice');
  const d = M.data;
  if (!el || !d) return;
  const s = d.meeting;
  let text = '';
  if (s.removed) text = t('meeting.notice.removed');
  else if (M.voice.status !== 'connected' && (live(s) || s.state === 'processing')) text = t('meeting.notice.offline');
  else if (s.state === 'failed') text = t('meeting.notice.failed');
  el.hidden = !text;
  el.innerHTML = text ? `${icons.info}<span>${esc(text)}</span>` : '';
}

// The line after the transcript: listening while it records, finishing once it stopped.
function renderLive() {
  const el = $('.meeting .mt-live');
  const d = M.data;
  if (!el || !d) return;
  const s = d.meeting;
  const none = !d.passages.length;
  let html = '';
  if (s.state === 'recording') html = `<span class="mt-listening">${esc(t(none ? 'meeting.live.waiting' : 'meeting.live.listening'))}</span>`;
  else if (s.state === 'paused') html = `<span>${esc(t('meeting.live.paused'))}</span>`;
  else if (s.state === 'processing') html = `<span class="spinner"></span><span>${esc(t('meeting.live.processing'))}</span>`;
  else if (none && !s.removed) html = `<span>${esc(t('meeting.live.nothing'))}</span>`;
  el.innerHTML = html;
  el.className = `mt-live ${s.state === 'recording' ? 'is-rec' : ''}`;
}

// ---------- transcript ----------

function speakerOf(id) {
  return (M.data && M.data.speakers.find((s) => s.id === id)) || null;
}
// A passage's voice: its speaker, or the user for the microphone when Voice hasn't said whose it is.
function voiceOf(p) {
  const s = speakerOf(p.speaker);
  if (s) return s;
  return p.track === 'mic' ? { id: 'mic', track: 'mic', you: true, label: null, name: null } : { id: null, track: p.track, label: null, name: null };
}
function speakerName(s) {
  if (s.name) return s.name;
  if (s.you || s.track === 'mic') return t('meeting.speakers.you');
  return s.label || t('meeting.speakers.unknown');
}
function avatarHtml(s) {
  if (s.you || s.track === 'mic') return `<span class="mt-av is-you" aria-hidden="true">${icons.mic}</span>`;
  const name = speakerName(s);
  return `<span class="mt-av" style="--h:${hue(s.address || name)}" aria-hidden="true">${esc(initials({ name }))}</span>`;
}

const TRACK_KEYS = { mic: 'meeting.track.mic', call: 'meeting.track.call', screen: 'meeting.track.screen' };
const trackName = (track) => t(TRACK_KEYS[track] || 'meeting.track.all');

// What a mark says. Device names come from Voice's device list; the label of a user mark is what Voice was given.
function markText(k) {
  const span = Number.isFinite(k.until) ? length(k.until - k.at) : null;
  const track = trackName(k.track);
  switch (k.kind) {
    case 'user':
      return k.label ? t('meeting.mark.userLabel', { label: k.label }) : t('meeting.mark.user');
    case 'dictation':
      return span ? t('meeting.mark.dictation', { length: span }) : t('meeting.mark.dictationOpen');
    case 'gap': {
      const key = { crash: 'meeting.mark.gapCrash', device: 'meeting.mark.gapDevice', suspend: 'meeting.mark.gapSuspend' }[k.detail] || 'meeting.mark.gap';
      return t(key, { track, length: span || length(0) });
    }
    case 'device': {
      const device = k.label || t('meeting.mark.unnamedDevice');
      const key = { reconnected: 'meeting.mark.deviceBack', lost: 'meeting.mark.deviceLost' }[k.detail] || 'meeting.mark.deviceMoved';
      return t(key, { track, device });
    }
    case 'dropped':
      return t(k.detail === 'disk' ? 'meeting.mark.droppedDisk' : 'meeting.mark.droppedEncoder');
    default:
      return k.label ? t('meeting.mark.userLabel', { label: k.label }) : t('meeting.mark.user');
  }
}
const MARK_ICONS = { user: 'flag', gap: 'warning', device: 'mic', dictation: 'edit', dropped: 'warning' };

function markHtml(k) {
  const kind = ['user', 'gap', 'device', 'dictation', 'dropped'].includes(k.kind) ? k.kind : 'user';
  return `<li class="mt-row mt-mark is-${kind}" data-key="k:${esc(k.id)}" data-at="${k.at}" tabindex="-1">
    <time class="mt-at">${esc(clock(k.at))}</time>
    <div class="mt-line">${icons[MARK_ICONS[kind]]}<span>${esc(markText(k))}</span></div>
  </li>`;
}

function passageHtml(p) {
  const s = voiceOf(p);
  const wall = M.data && Number.isFinite(M.data.meeting.startedAt) ? hhmm(M.data.meeting.startedAt + p.start) : '';
  const cls = ['mt-row', 'mt-passage', p.dictation ? 'is-dict' : '', p.corrected ? 'is-corrected' : ''].filter(Boolean).join(' ');
  return `<li class="${cls}" data-key="p:${esc(p.id)}" data-id="${esc(p.id)}" data-voice="${esc(s.id || p.track)}" data-at="${p.start}" data-end="${p.end}" tabindex="-1">
    <time class="mt-at"${wall ? ` title="${esc(wall)}"` : ''}>${esc(clock(p.start))}</time>
    <div class="mt-main">
      <div class="mt-who">${avatarHtml(s)}<span class="mt-name">${esc(speakerName(s))}</span>${p.dictation ? `<span class="mt-tag" title="${esc(t('meeting.transcript.dictatingHelp'))}">${icons.edit}<span>${esc(t('meeting.transcript.dictating'))}</span></span>` : ''}</div>
      <div class="mt-text sel">${esc(p.text)}</div>
      ${p.corrected ? `<div class="mt-corrected">${esc(t('meeting.transcript.corrected'))}</div>` : ''}
    </div>
  </li>`;
}

// Marks before a passage that starts at the same moment. A dictation stretch whose words are in the transcript
// already shows as those lines, tagged; its mark only says when nothing was transcribed in it.
function items(d) {
  const out = [];
  const dictated = (k) => d.passages.some((p) => p.dictation && p.start < (Number.isFinite(k.until) ? k.until : Infinity) && p.end > k.at);
  for (const k of d.marks) if (!(k.kind === 'dictation' && dictated(k))) out.push({ key: `k:${k.id}`, at: k.at, order: 0, html: () => markHtml(k) });
  for (const p of d.passages) out.push({ key: `p:${p.id}`, at: p.start, order: 1, html: () => passageHtml(p) });
  return out.sort((a, b) => a.at - b.at || a.order - b.order || (a.key < b.key ? -1 : 1));
}
const rowKey = (el) => [Number(el.dataset.at), el.classList.contains('mt-mark') ? 0 : 1, el.dataset.key];
const before = (a, b) => a[0] - b[0] || a[1] - b[1] || (a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0);

const scroller = () => $('.meeting .mt-scroll');
const atBottom = (el) => !el || el.scrollHeight - el.scrollTop - el.clientHeight < 48;

// The whole transcript, drawn again: when the meeting opens and when names change.
function renderTranscript(full, { bottom = false } = {}) {
  const list = $('.meeting .mt-transcript');
  const d = M.data;
  if (!list || !d || !full) return;
  const sc = scroller();
  const stick = bottom || atBottom(sc);
  const top = sc ? sc.scrollTop : 0;
  const focusKey = list.contains(document.activeElement) ? document.activeElement.dataset.key : null;
  const draft = list.querySelector('.mt-edit');
  const draftText = draft ? draft.value : null;
  list.innerHTML = items(d)
    .map((x) => x.html())
    .join('');
  continuations();
  if (M.editing) {
    const row = list.querySelector(`[data-key="p:${CSS.escape(M.editing)}"]`);
    if (row) {
      const editing = M.editing;
      M.editing = null;
      editPassage(row);
      const area = row.querySelector('.mt-edit');
      if (area && draftText !== null && M.editing === editing) {
        area.value = draftText;
        grow(area);
      }
    } else M.editing = null;
  }
  if (focusKey) list.querySelector(`[data-key="${CSS.escape(focusKey)}"]`)?.focus({ preventScroll: true });
  if (sc) {
    if (stick) sc.scrollTop = sc.scrollHeight;
    else sc.scrollTop = top;
  }
}

// Rows that changed or arrived go in their place by time; the rest stay, so focus and selection survive.
function updateRows(keys, removedKeys) {
  const list = $('.meeting .mt-transcript');
  const d = M.data;
  if (!list || !d) return;
  const sc = scroller();
  const stick = atBottom(sc);
  for (const key of removedKeys) list.querySelector(`[data-key="${CSS.escape(key)}"]`)?.remove();
  const byKey = new Map(items(d).map((x) => [x.key, x]));
  // A row whose item is gone, such as a dictation mark once its words arrived.
  for (const row of [...list.children]) if (!byKey.has(row.dataset.key)) row.remove();
  let added = false;
  for (const key of new Set(keys)) {
    const item = byKey.get(key);
    if (!item) continue;
    if (key === `p:${M.editing}`) continue;
    const tmp = document.createElement('template');
    tmp.innerHTML = item.html().trim();
    const row = tmp.content.firstElementChild;
    const old = list.querySelector(`[data-key="${CSS.escape(key)}"]`);
    const hadFocus = old && old === document.activeElement;
    if (old) old.remove();
    else added = true;
    const k = rowKey(row);
    // Passages mostly arrive in order: look from the end.
    let next = null;
    for (let el = list.lastElementChild; el; el = el.previousElementSibling) {
      if (before(rowKey(el), k) <= 0) break;
      next = el;
    }
    list.insertBefore(row, next);
    if (hadFocus) row.focus({ preventScroll: true });
  }
  continuations();
  if (sc && stick) sc.scrollTop = sc.scrollHeight;
  else if (added) $('.meeting .mt-jump')?.removeAttribute('hidden');
}

// A passage by the same voice soon after the one before it doesn't repeat the name.
function continuations() {
  let prev = null;
  for (const row of $('.meeting .mt-transcript')?.children || []) {
    const passage = row.classList.contains('mt-passage');
    const cont = passage && prev && prev.classList.contains('mt-passage') && prev.dataset.voice === row.dataset.voice && prev.classList.contains('is-dict') === row.classList.contains('is-dict') && Number(row.dataset.at) - Number(prev.dataset.end) < SAME_STRETCH_MS;
    row.classList.toggle('cont', Boolean(cont));
    prev = row;
  }
}

// ---------- correcting a passage ----------

function passageById(id) {
  return M.data ? M.data.passages.find((p) => p.id === id) || null : null;
}

function grow(area) {
  area.style.height = 'auto';
  area.style.height = `${area.scrollHeight + 2}px`;
}

function editPassage(row) {
  if (!row || !row.classList.contains('mt-passage') || !M.data || M.data.meeting.removed) return;
  const p = passageById(row.dataset.id);
  if (!p) return;
  if (M.editing && M.editing !== p.id) closeEditor(false);
  M.editing = p.id;
  const main = row.querySelector('.mt-main');
  if (main.querySelector('.mt-edit')) return main.querySelector('.mt-edit').focus();
  const text = main.querySelector('.mt-text');
  const box = document.createElement('div');
  box.className = 'mt-edit-box';
  box.innerHTML = `<textarea class="mt-edit sel" rows="1" aria-label="${esc(t('meeting.transcript.correctLabel'))}"></textarea>
    <div class="mt-edit-bar"><span class="mt-edit-hint">${esc(t('meeting.transcript.correctHint'))}</span><button class="btn sm secondary" data-mt="edit-cancel">${esc(t('common.actions.cancel'))}</button><button class="btn sm primary" data-mt="edit-save">${esc(t('common.actions.save'))}</button></div>`;
  const area = box.querySelector('textarea');
  area.value = p.text;
  text.replaceWith(box);
  grow(area);
  area.focus();
  area.setSelectionRange(area.value.length, area.value.length);
}

// save: send the text to main; false just closes the editor. Either way the row is drawn from the data again.
async function closeEditor(save) {
  const id = M.editing;
  if (!id) return;
  const list = $('.meeting .mt-transcript');
  const row = list && list.querySelector(`[data-key="p:${CSS.escape(id)}"]`);
  const area = row && row.querySelector('.mt-edit');
  const value = area ? area.value : null;
  M.editing = null;
  if (save && value !== null && M.data) {
    const p = passageById(id);
    const original = p ? (p.corrected ? p.original : p.text) : null;
    const next = value.trim();
    const meetingId = M.data.meeting.id;
    if (p && next !== p.text) {
      // Back to what Voice heard, the correction goes. The row shows the new text now; main's change follows.
      const value = next === original || !next ? null : next;
      Object.assign(p, value === null ? { text: original, corrected: false, original: undefined } : { text: value, corrected: true, original });
      redrawRow(id);
      try {
        await api('meetingCorrect', meetingId, id, value);
      } catch (err) {
        toast(voiceError(err), 5000);
        if (M.data && M.data.meeting.id === meetingId) fetchMeeting(meetingId);
      }
      return;
    }
  }
  if (row) redrawRow(id);
}

function redrawRow(id) {
  updateRows([`p:${id}`], []);
  $('.meeting .mt-transcript')?.querySelector(`[data-key="p:${CSS.escape(id)}"]`)?.focus({ preventScroll: true });
}

async function restorePassage(id) {
  if (!M.data) return;
  try {
    await api('meetingCorrect', M.data.meeting.id, id, null);
  } catch (err) {
    toast(voiceError(err), 5000);
  }
}

function onContextMenu(e) {
  const row = e.target.closest('.mt-passage');
  if (!row || row.querySelector('.mt-edit') || !M.data || M.data.meeting.removed) return;
  // Text the user selected keeps the system menu, with Copy.
  if (String(window.getSelection()).trim()) return;
  e.preventDefault();
  const p = passageById(row.dataset.id);
  if (!p) return;
  showMenu(
    row,
    [
      { label: t('meeting.transcript.correct'), icon: 'edit', action: () => editPassage(row) },
      p.corrected ? { label: t('meeting.transcript.restore'), icon: 'undo', action: () => restorePassage(p.id) } : null
    ],
    { at: { x: e.clientX, y: e.clientY } }
  );
}

// ---------- people ----------

function renderPeople() {
  const box = $('.meeting .mt-people');
  const d = M.data;
  if (!box || !d) return;
  const speakers = [...d.speakers].sort((a, b) => Number(b.you || b.track === 'mic') - Number(a.you || a.track === 'mic') || (a.id < b.id ? -1 : 1));
  if (!speakers.length) {
    box.innerHTML = d.meeting.removed ? '' : `<p class="mt-quiet">${esc(t('meeting.speakers.none'))}</p>`;
    return;
  }
  const focused = box.contains(document.activeElement) ? document.activeElement.dataset.speaker : null;
  box.innerHTML = speakers
    .map((s) => {
      const name = speakerName(s);
      if (s.you || s.track === 'mic') {
        return `<div class="mt-person is-you">${avatarHtml(s)}<span class="mt-person-text"><span class="mt-person-name">${esc(name)}</span><span class="mt-person-sub">${esc(t('meeting.speakers.microphone'))}</span></span></div>`;
      }
      const sub = s.name ? s.address || (s.label ? t('meeting.speakers.was', { label: s.label }) : '') : (s.suggestions || []).length ? t('meeting.speakers.pick') : t('meeting.speakers.nameIt');
      const disabled = d.meeting.removed ? 'disabled' : '';
      return `<button class="mt-person" data-mt="speaker" data-speaker="${esc(s.id)}" aria-haspopup="menu" ${disabled} title="${esc(t('meeting.speakers.choose', { name }))}">${avatarHtml(s)}<span class="mt-person-text"><span class="mt-person-name">${esc(name)}</span><span class="mt-person-sub ${s.name ? '' : 'is-ask'}">${esc(sub)}</span></span>${icons.chevronDown}</button>`;
    })
    .join('');
  if (focused) box.querySelector(`[data-speaker="${CSS.escape(focused)}"]`)?.focus();
}

function speakerMenu(btn) {
  const d = M.data;
  const s = d && d.speakers.find((x) => x.id === btn.dataset.speaker);
  if (!s) return;
  const event = d.event && !d.event.missing ? d.event : null;
  const options = (s.suggestions || []).map((c) => ({
    label: c.name || c.address,
    sub: c.name && c.address ? c.address : '',
    checked: Boolean(s.name) && s.name === (c.name || c.address) && (s.address || '') === (c.address || ''),
    action: () => setSpeaker(s.id, { name: c.name || c.address, address: c.address || '' })
  }));
  showMenu(
    btn,
    [
      options.length ? { heading: event ? t('meeting.speakers.fromEvent', { title: event.title || t('calendar.event.noTitle') }) : t('meeting.speakers.guests') } : null,
      ...options,
      options.length ? { separator: true } : null,
      { label: t('meeting.speakers.someoneElse'), icon: 'edit', action: () => nameSpeaker(s) },
      s.name ? { label: t('meeting.speakers.clear', { label: s.label || t('meeting.speakers.unknown') }), icon: 'undo', action: () => setSpeaker(s.id, null) } : null
    ],
    { align: 'left' }
  );
}

async function nameSpeaker(s) {
  const value = await promptDialog(t('meeting.speakers.nameTitle', { label: s.label || t('meeting.speakers.unknown') }), s.name || '', { placeholder: t('meeting.speakers.namePlaceholder') });
  if (typeof value !== 'string' || !value.trim()) return;
  setSpeaker(s.id, { name: value.trim(), address: '' });
}

async function setSpeaker(speakerId, value) {
  if (!M.data) return;
  const id = M.data.meeting.id;
  try {
    const speakers = await api('meetingSetSpeaker', id, speakerId, value);
    if (!M.data || M.data.meeting.id !== id || !Array.isArray(speakers)) return;
    M.data.speakers = speakers;
    renderPeople();
    renderTranscript(true);
  } catch (err) {
    toast(voiceError(err), 5000);
  }
}

// ---------- the calendar event ----------

function renderEvent() {
  const box = $('.meeting .mt-event-box');
  const d = M.data;
  if (!box || !d) return;
  const ev = d.event;
  const change = d.meeting.removed ? '' : `<button class="btn sm secondary" data-mt="event" aria-haspopup="menu">${esc(t(ev ? 'meeting.event.change' : 'meeting.event.link'))}</button>`;
  let main;
  if (!ev) main = `<div class="mt-quiet">${esc(t('meeting.event.none'))}</div>`;
  else if (ev.missing) main = `<div class="mt-quiet">${esc(t('meeting.event.missing'))}</div>`;
  else main = `<button class="mt-event-title" data-mt="open-event" title="${esc(t('meeting.event.open'))}">${esc(ev.title || t('calendar.event.noTitle'))}</button><div class="mt-event-when">${esc(eventWhen(ev))}</div>`;
  const focused = box.contains(document.activeElement) ? document.activeElement.dataset.mt : null;
  box.innerHTML = `<span class="mt-event-ic">${icons.calendar}</span><div class="mt-event-text">${main}</div>${change}`;
  if (focused) box.querySelector(`[data-mt="${focused}"]`)?.focus();
}

async function eventMenu(btn) {
  const d = M.data;
  if (!d) return;
  const id = d.meeting.id;
  let found = { events: [], failed: [] };
  try {
    found = await api('meetingEvents', id);
  } catch (_) {
    // The menu says nothing fits; Unlink still works.
  }
  if (!M.data || M.data.meeting.id !== id || !btn.isConnected) return;
  const currentId = d.meeting.eventId;
  const events = (found.events || []).map((e) => ({
    label: e.title || t('calendar.event.noTitle'),
    sub: eventWhen(e),
    checked: e.id === currentId,
    action: () => setEvent(e.id)
  }));
  showMenu(
    btn,
    [
      { heading: t('meeting.event.around') },
      ...(events.length ? events : [{ label: t('meeting.event.noneFound'), disabled: true, action: () => {} }]),
      (found.failed || []).length ? { label: t('meeting.event.someFailed'), disabled: true, action: () => {} } : null,
      currentId ? { separator: true } : null,
      currentId ? { label: t('meeting.event.unlink'), icon: 'close', action: () => setEvent(null) } : null
    ],
    { align: 'right' }
  );
}

async function setEvent(eventId) {
  if (!M.data) return;
  const id = M.data.meeting.id;
  try {
    await api('meetingSetEvent', id, eventId);
    // The meeting's delta follows with the new event; fetch now so the card and the names change together.
    if (M.data && M.data.meeting.id === id) await fetchMeeting(id);
  } catch (err) {
    toast(voiceError(err), 5000);
  }
}

// ---------- notes ----------

// The notes editor saves a moment after typing stops and when it loses focus, with the revision it started from.
// queued holds texts waiting while another save runs, by meeting: captured when the save was asked for, so opening
// another meeting meanwhile can't lose what was typed in the one before.
const N = { id: null, rev: 0, dirty: false, saving: false, queued: new Map(), timer: null };

function fillNotes(d) {
  const area = $('.meeting .mt-notes-input');
  if (!area) return;
  N.id = d.meeting.id;
  N.rev = d.notes ? d.notes.rev : 0;
  N.dirty = false;
  area.value = d.notes ? d.notes.text : '';
  area.disabled = false;
  notesStatus(d.notes && d.notes.updatedAt ? t('meeting.notes.saved') : '');
}

function notesStatus(text, error = false) {
  const el = $('.meeting .mt-notes-status');
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('error', error);
}

function notesTyped() {
  N.dirty = true;
  notesStatus('');
  clearTimeout(N.timer);
  N.timer = setTimeout(saveNotes, NOTES_WAIT);
}

// Notes from main: another save, or what main kept when the view opened. Text being written stays.
function notesArrived(notes) {
  if (!M.data) return;
  M.data.notes = notes;
  const area = $('.meeting .mt-notes-input');
  if (!area || N.id !== M.data.meeting.id || N.dirty || N.saving || document.activeElement === area) return;
  if (notes.rev !== N.rev) {
    N.rev = notes.rev;
    area.value = notes.text;
  }
}

async function saveNotes() {
  clearTimeout(N.timer);
  if (!N.dirty || !N.id) return;
  const area = $('.meeting .mt-notes-input');
  if (!area || $('.meeting')?.dataset.id !== N.id) return;
  N.dirty = false;
  N.queued.set(N.id, { text: area.value, rev: N.rev });
  if (!N.saving) await drainNotes();
}

// Saves the queued texts one at a time. A conflict is a save of this editor's own that crossed this one, because only
// this editor writes a meeting's notes: it saves over it with the revision main has now.
async function drainNotes() {
  N.saving = true;
  try {
    while (N.queued.size) {
      const [id, job] = N.queued.entries().next().value;
      N.queued.delete(id);
      if (N.id === id) notesStatus(t('meeting.notes.saving'));
      try {
        let res = await api('meetingSaveNotes', id, job.text, job.rev);
        if (res && res.conflict) res = await api('meetingSaveNotes', id, job.text, res.rev);
        if (res && !res.conflict) {
          // A newer text queued meanwhile goes out with the revision this save made.
          const next = N.queued.get(id);
          if (next) next.rev = res.rev;
          if (N.id === id) N.rev = res.rev;
          if (M.data && M.data.meeting.id === id) M.data.notes = { text: job.text, rev: res.rev, updatedAt: Date.now() };
        }
        if (N.id === id) notesStatus(N.dirty || N.queued.has(id) ? '' : t('meeting.notes.saved'));
      } catch (_) {
        // Kept for the next try, unless something newer for that meeting is queued already.
        if (!N.queued.has(id)) N.queued.set(id, job);
        if (N.id === id) notesStatus(t('meeting.notes.failed'), true);
        clearTimeout(N.timer);
        N.timer = setTimeout(retryNotes, NOTES_WAIT);
        return;
      }
    }
  } finally {
    N.saving = false;
  }
  if (N.dirty && N.id) N.timer = setTimeout(saveNotes, NOTES_WAIT);
}

function retryNotes() {
  if (N.saving) return;
  if (N.dirty) saveNotes();
  else if (N.queued.size) drainNotes();
}

// Leaving the meeting or the view: what was typed goes out now.
function flushNotes() {
  if (N.dirty) saveNotes();
}

// ---------- events in the view ----------

async function onClick(e) {
  const b = e.target.closest('[data-mt], [data-mt-tab]');
  if (!b || b.disabled) return;
  if (b.dataset.mtTab) {
    M.tab = b.dataset.mtTab;
    setSegmented(b.closest('.segmented'), M.tab);
    $('.meeting').dataset.tab = M.tab;
    return;
  }
  const d = M.data;
  const id = d && d.meeting.id;
  switch (b.dataset.mt) {
    case 'record':
      return record();
    case 'jump': {
      const sc = scroller();
      if (sc) sc.scrollTo({ top: sc.scrollHeight, behavior: 'smooth' });
      b.hidden = true;
      return;
    }
    case 'speaker':
      return speakerMenu(b);
    case 'event':
      return eventMenu(b);
    case 'open-event':
      if (d && d.event && !d.event.missing) ctx.openCalendarEvent(d.event.id, d.event.start);
      return;
    case 'edit-save':
      return closeEditor(true);
    case 'edit-cancel':
      return closeEditor(false);
    case 'mark':
      return command(() => api('meetingMark', id, null), () => toast(t('meeting.actions.marked', { time: clock(elapsed(d.meeting) || 0) })));
    case 'pause':
      return command(() => api('meetingPause', id));
    case 'resume':
      return command(() => api('meetingResume', id));
    case 'stop':
      // Two steps, as on Voice's pill: a meeting can't be recorded again.
      if (M.confirmStop !== id) {
        M.confirmStop = id;
        renderHead();
        setTimeout(() => {
          if (M.confirmStop !== id) return;
          M.confirmStop = null;
          renderHead();
        }, STOP_CONFIRM_MS);
        return;
      }
      M.confirmStop = null;
      renderHead();
      return command(() => api('meetingStop', id));
  }
}

async function command(run, done = null) {
  try {
    await run();
    if (done) done();
  } catch (err) {
    toast(voiceError(err), 6000);
  }
}

// The transcript is one tab stop: arrows move between its lines, Enter corrects a passage. In the editor Enter saves
// and Escape cancels.
function onViewKey(e) {
  if (e.target.matches && e.target.matches('.mt-edit')) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeEditor(false);
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      closeEditor(true);
    }
    return;
  }
  const list = e.target.closest && e.target.closest('.mt-transcript');
  if (!list) return;
  const rows = [...list.children];
  if (!rows.length) return;
  const at = rows.indexOf(e.target.closest('.mt-row'));
  let next = null;
  if (e.key === 'ArrowDown') next = rows[Math.min(rows.length - 1, at + 1)];
  else if (e.key === 'ArrowUp') next = rows[Math.max(0, at < 0 ? rows.length - 1 : at - 1)];
  else if (e.key === 'Home') next = rows[0];
  else if (e.key === 'End') next = rows[rows.length - 1];
  else if ((e.key === 'Enter' || e.key === 'F2') && at >= 0) {
    e.preventDefault();
    return editPassage(rows[at]);
  }
  if (!next) return;
  e.preventDefault();
  next.focus();
  next.scrollIntoView({ block: 'nearest' });
}

// ---------- sidebar ----------

// Only once the window has its accounts: before that app.js has no sidebar to draw.
function redrawSide() {
  if (ctx && ctx.S && ctx.S.data && ctx.S.data.accounts.length && document.querySelector('.sidebar-main')) ctx.renderSidebar();
}

let sideTimer = null;
function renderSideSoon() {
  clearTimeout(sideTimer);
  sideTimer = setTimeout(redrawSide, 0);
}

// "Record a meeting", then the meetings by day. In the rail a meeting shows as its day of the month.
export function sidebarHtml() {
  const why = notReadyText();
  const record = `<button class="btn compose-btn mt-record-btn ${why ? 'is-off' : ''}" data-mt-side="record" title="${esc(why || t('meeting.actions.record'))}" ${M.starting ? 'disabled' : ''}>${icons.record}<span>${esc(t('meeting.actions.record'))}</span></button>`;
  let lastGroup = null;
  const rows = M.list
    .map((m) => {
      const group = Number.isFinite(m.startedAt) ? groupLabel(m.startedAt) : '';
      const head = group !== lastGroup ? `<div class="nav-section"><span>${esc(group || t('meeting.sidebar.undated'))}</span></div>` : '';
      lastGroup = group;
      const title = titleOf(m);
      const isLive = live(m) && m.id === M.voice.recording;
      const time = Number.isFinite(m.startedAt) ? hhmm(m.startedAt) : '';
      const day = Number.isFinite(m.startedAt) ? new Date(m.startedAt).getDate() : '·';
      const active = M.open && m.id === M.id;
      const label = isLive ? t('meeting.sidebar.recordingTitle', { title }) : time ? t('meeting.sidebar.itemTitle', { title, time }) : title;
      return `${head}<button class="nav-item mt-nav ${active ? 'active' : ''} ${isLive ? 'is-live' : ''} ${m.removed ? 'is-removed' : ''}" data-mt-open="${esc(m.id)}" title="${esc(label)}" aria-label="${esc(label)}"${active ? ' aria-current="true"' : ''}><span class="ic mdot">${isLive ? '<i class="mt-rec-dot"></i>' : icons.mic}<b>${esc(day)}</b></span><span class="label">${esc(title)}</span><span class="count">${esc(time)}</span></button>`;
    })
    .join('');
  const list = rows || `<p class="mt-side-empty">${esc(t('meeting.sidebar.empty'))}</p>`;
  return `${record}<nav class="nav mt-list" aria-label="${esc(t('meeting.sidebar.label'))}">${list}</nav>`;
}

// Handles a click in the sidebar; false when it isn't the meeting list's.
export function sidebarClick(btn) {
  if (btn.dataset.mtSide === 'record') {
    record();
    return true;
  }
  if (btn.dataset.mtOpen) {
    open(btn.dataset.mtOpen);
    return true;
  }
  return false;
}

// The sidebar's status line in meeting mode says how Rukoo Voice is: {cls, text, title}, as syncStatus in app.js.
export function footStatus() {
  const v = M.voice;
  if (v.status === 'connected') {
    return { cls: v.recording ? 'rec' : 'ok', text: v.recording ? t('meeting.voice.recording') : t('meeting.voice.connected'), title: v.voiceVersion ? t('meeting.voice.version', { version: v.voiceVersion }) : '' };
  }
  if (v.status === 'connecting') return { cls: 'busy', text: t('meeting.voice.connectingShort'), title: '' };
  return { cls: '', text: t('meeting.voice.offShort'), title: notReadyText(v) || '' };
}

// ---------- the title bar's recording indicator ----------

let ticker = null;
function afterVoice() {
  renderIndicator();
  const on = Boolean(M.voice.recording);
  if (on && !ticker) ticker = setInterval(tick, 1000);
  if (!on && ticker) {
    clearInterval(ticker);
    ticker = null;
  }
}

// Once a second while a meeting records: the clocks.
function tick() {
  renderIndicator();
  const s = M.data && M.data.meeting;
  const el = $('.meeting .mt-elapsed');
  if (el && live(s)) el.textContent = clock(elapsed(s));
}

export function renderIndicator() {
  const b = document.querySelector('[data-meeting-indicator]');
  if (!b) return;
  const id = M.voice.recording;
  b.hidden = !id;
  if (!id) return;
  const s = summaryOf(id);
  const paused = Boolean(s && s.state === 'paused');
  const ms = elapsed(s);
  const title = s ? titleOf(s) : t('meeting.untitledNoTime');
  b.classList.toggle('is-paused', paused);
  b.classList.toggle('is-hidden', Boolean(M.voice.hidden));
  b.dataset.meetingIndicator = id;
  b.querySelector('.rec-time').textContent = ms === null ? t('meeting.indicator.short') : clock(ms);
  const label = t(paused ? 'meeting.indicator.paused' : 'meeting.indicator.recording', { title });
  b.title = M.voice.hidden ? `${label}\n${t('meeting.head.hiddenHelp')}` : label;
  b.setAttribute('aria-label', label);
}

export const indicatorHtml = () =>
  `<button class="rec-indicator" data-meeting-indicator="" hidden><span class="rec-dot" aria-hidden="true"></span><span class="rec-time"></span>${icons.eyeOff}</button>`;
