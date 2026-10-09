import { t, getLocale } from './i18n.js';
import { icons } from './icons.js';
import { api, esc, $, $$, hhmm, toast, dialog, choiceDialog, confirmDialog, segmented, setSegmented, KEEP_OPEN } from './ui.js';

// The calendar view: the calendars of every account together, as a week, a day or a list of what comes next.
// Main fetches and caches the events (src/main/calendar); this module draws them and sends changes back.
// Every account keeps its own colour, the one it has in the unified inbox.

const DAY = 86400000;
// The grid: pixels per hour, and the least an event is drawn, so a short one still shows its title.
const HOUR = 48;
const MIN_EVENT = 20;
const UPCOMING_DAYS = 30;
// A week narrower than this shows its day instead: seven columns would be too narrow to read.
const NARROW = 560;
const RESPONSES = ['accepted', 'tentative', 'declined'];

const prefs = { view: 'week', visible: {}, dismissed: {}, calendar: null, ...readPrefs() };
function readPrefs() {
  try {
    return JSON.parse(localStorage.getItem('rukoo.calendar') || '{}');
  } catch (_) {
    return {};
  }
}
function savePrefs() {
  localStorage.setItem('rukoo.calendar', JSON.stringify(prefs));
}

const C = {
  open: false,
  // The day the view is about, at local midnight.
  date: startOfDay(Date.now()),
  data: null,
  // The open event card: the event's id, and which of its places on screen it opened at.
  pop: null,
  popIndex: 0,
  upcomingDays: UPCOMING_DAYS,
  // Scroll the grid to the working day on the next draw.
  scroll: true,
  // Set when a click that closed the event card should do nothing else.
  swallow: false,
  today: startOfDay(Date.now())
};
let ctx = null;

// ---------- dates ----------

function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// Days are added on the calendar, not as 24 hours, so a week across a clock change still starts at midnight.
function addDays(ts, n) {
  const d = new Date(ts);
  d.setDate(d.getDate() + n);
  return d.getTime();
}

function firstWeekday() {
  try {
    const locale = new Intl.Locale(getLocale());
    const info = typeof locale.getWeekInfo === 'function' ? locale.getWeekInfo() : locale.weekInfo;
    return info && info.firstDay ? info.firstDay % 7 : 1;
  } catch (_) {
    return 1;
  }
}

function weekStart(ts) {
  const day = startOfDay(ts);
  return addDays(day, -((new Date(day).getDay() - firstWeekday() + 7) % 7));
}

const dayIndex = (ts, from) => Math.round((startOfDay(ts) - from) / DAY);
const minutes = (ts) => new Date(ts).getHours() * 60 + new Date(ts).getMinutes();
const fmt = (ts, options) => new Intl.DateTimeFormat(getLocale(), options).format(new Date(ts));
const cap = (s) => s.replace(/^./, (c) => c.toUpperCase());
const pad = (n) => String(n).padStart(2, '0');
const dateValue = (ts) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const timeValue = (ts) => `${pad(new Date(ts).getHours())}:${pad(new Date(ts).getMinutes())}`;
function parseLocal(date, time = '00:00') {
  const [y, m, d] = date.split('-').map(Number);
  const [h, min] = time.split(':').map(Number);
  return new Date(y, m - 1, d, h || 0, min || 0).getTime();
}

function longDay(ts) {
  return cap(fmt(ts, { weekday: 'long', day: 'numeric', month: 'long' }));
}

// "Tuesday 13 October, 14:00 – 15:30", or the days of an all-day event.
function whenText(e) {
  if (e.allDay) {
    const last = addDays(e.end, -1);
    return startOfDay(last) === startOfDay(e.start) ? longDay(e.start) : `${longDay(e.start)} – ${longDay(last)}`;
  }
  if (startOfDay(e.start) === startOfDay(e.end - 1)) return `${longDay(e.start)}, ${hhmm(e.start)} – ${hhmm(e.end)}`;
  return `${longDay(e.start)}, ${hhmm(e.start)} – ${longDay(e.end)}, ${hhmm(e.end)}`;
}

// ---------- data ----------

const key = (accountId, calendarId) => `${accountId}\n${calendarId}`;
const accounts = () => (C.data && C.data.accounts) || [];
const account = (id) => accounts().find((a) => a.id === id);
const calendarOf = (e) => account(e.accountId)?.calendars.find((c) => c.id === e.calendarId) || null;
const titleOf = (e) => e.title || t('calendar.event.noTitle');
// Account colours come from Rukoo's own palette; anything else falls back to the accent.
const colorOf = (id) => {
  const c = account(id)?.color || '';
  return /^#[0-9a-f]{3,8}$/i.test(c) ? c : 'var(--accent)';
};

function isVisible(accountId, cal) {
  const k = key(accountId, cal.id);
  return Object.hasOwn(prefs.visible, k) ? prefs.visible[k] : cal.selected !== false;
}

function events() {
  return ((C.data && C.data.events) || []).filter((e) => {
    const cal = calendarOf(e);
    return cal && isVisible(e.accountId, cal);
  });
}

const byId = (id) => ((C.data && C.data.events) || []).find((e) => e.id === id) || null;

function shownView() {
  if (prefs.view !== 'week') return prefs.view;
  const width = $('.calendar')?.clientWidth || 0;
  return width && width < NARROW ? 'day' : 'week';
}

function range(view = shownView()) {
  if (view === 'day') return { start: C.date, end: addDays(C.date, 1) };
  if (view === 'week') {
    const start = weekStart(C.date);
    return { start, end: addDays(start, 7) };
  }
  const start = startOfDay(Date.now());
  return { start, end: addDays(start, C.upcomingDays) };
}

let loadTimer = null;
let loadSeq = 0;

export function reload(ms = 60) {
  if (!C.open) return;
  clearTimeout(loadTimer);
  loadTimer = setTimeout(load, ms);
}

async function load() {
  const r = range();
  const seq = ++loadSeq;
  try {
    const data = await api('calendarView', r);
    if (seq !== loadSeq || !C.open) return;
    C.data = data;
    render();
    ctx.renderSidebar();
  } catch (err) {
    toast(err.message, 5000);
  }
}

// ---------- shell ----------

export function init(context) {
  ctx = context;
}

export function isOpen() {
  return C.open;
}

export function show() {
  C.open = true;
  C.scroll = true;
  bind();
  if (!C.data) render();
  load();
}

export function hide() {
  C.open = false;
  closePop();
}

// After a language change: the toolbar is built once, so build it again.
export function relocalize() {
  const el = $('.calendar');
  if (el) el.innerHTML = '';
  closePop();
  if (C.open) render();
}

// What the sidebar's sync line reports, in the shape the mail accounts have.
export function syncAccounts() {
  return accounts()
    .filter((a) => a.state !== 'reconnect')
    .map((a) => ({ email: a.email, syncing: a.loading, error: a.state === 'error' && a.error ? a.error.message : null, lastSync: a.syncedAt }));
}

export async function syncNow() {
  toast(t('mailbox.sync.syncing'));
  try {
    await api('calendarSync', null);
    toast(t('mailbox.sync.done'));
  } catch (err) {
    toast(err.message, 5000);
  }
}

// ---------- sidebar ----------

export function sidebarHtml() {
  const rows = accounts()
    .map((a) => {
      const head = `<div class="nav-section" title="${esc(a.email)}"><span>${esc(a.email)}</span></div>`;
      if (a.state === 'reconnect') {
        return `${head}<button class="nav-item" data-cal-reconnect="${esc(a.id)}" title="${esc(t('calendar.connect.action'))}"><span class="ic">${icons.plus}</span><span class="label">${esc(t('calendar.connect.action'))}</span></button>`;
      }
      return (
        head +
        a.calendars
          .map((cal) => {
            const on = isVisible(a.id, cal);
            return `<button class="nav-item cal-toggle" role="checkbox" aria-checked="${on}" data-cal-toggle="${esc(key(a.id, cal.id))}" title="${esc(cal.name)}"><span class="ic"><span class="cal-check ${on ? 'on' : ''}" style="--c:${colorOf(a.id)}">${icons.check}</span></span><span class="label">${esc(cal.name)}</span></button>`;
          })
          .join('')
      );
    })
    .join('');
  return `<button class="btn compose-btn" data-cal="new" title="${esc(t('calendar.event.newShortcut'))}">${icons.calendarPlus}<span>${esc(t('calendar.event.new'))}</span></button>
    <nav class="nav" aria-label="${esc(t('calendar.sidebar.calendars'))}">${rows}</nav>`;
}

// Handles a click in the sidebar; false when the button isn't the calendar's.
export function sidebarClick(btn) {
  if (btn.dataset.cal === 'new') {
    newEvent();
    return true;
  }
  if (btn.dataset.calToggle) {
    const [accountId, calendarId] = btn.dataset.calToggle.split('\n');
    const cal = account(accountId)?.calendars.find((c) => c.id === calendarId);
    if (!cal) return true;
    prefs.visible[btn.dataset.calToggle] = !isVisible(accountId, cal);
    savePrefs();
    closePop();
    render();
    ctx.renderSidebar();
    return true;
  }
  if (btn.dataset.calReconnect) {
    reconnect(btn.dataset.calReconnect);
    return true;
  }
  return false;
}

async function reconnect(accountId) {
  if (!ctx.S.data.googleAvailable) {
    toast(t('errors.google.notConfigured'), 6000);
    return;
  }
  toast(t('setup.google.waitToast'), 60000);
  try {
    await api('googleReauth', accountId);
    delete prefs.dismissed[accountId];
    savePrefs();
    toast(t('setup.google.signedIn'));
  } catch (err) {
    toast(err.message, 6000);
  }
  reload(0);
}

// ---------- drawing ----------

function headHtml(view) {
  const r = range(view);
  let title = t('calendar.views.upcoming');
  if (view === 'day') title = cap(fmt(r.start, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }));
  if (view === 'week') title = cap(new Intl.DateTimeFormat(getLocale(), { month: 'long', year: 'numeric' }).formatRange(new Date(r.start), new Date(r.end - 1)));
  const step = view === 'day' ? 'day' : 'week';
  const nav =
    view === 'upcoming'
      ? ''
      : `<button class="tbtn" data-cal="today" title="${esc(t('calendar.nav.todayShortcut'))}">${esc(t('calendar.nav.today'))}</button>
        <button class="icon-btn sm" data-cal="prev" title="${esc(t(`calendar.nav.prev.${step}`))}">${icons.chevronLeft}</button>
        <button class="icon-btn sm" data-cal="next" title="${esc(t(`calendar.nav.next.${step}`))}">${icons.chevronRight}</button>`;
  const busy = accounts().some((a) => a.loading);
  return `<div class="cal-nav">${nav}</div>
    <h1 class="cal-title">${esc(title)}</h1>
    <span class="cal-busy" ${busy ? '' : 'hidden'} title="${esc(t('mailbox.sync.syncing'))}"><span class="spinner"></span></span>`;
}

function viewSwitch() {
  return segmented({
    name: 'cal-view',
    label: t('calendar.views.label'),
    value: prefs.view,
    options: [
      { value: 'day', label: t('calendar.views.day'), title: t('calendar.views.dayShortcut') },
      { value: 'week', label: t('calendar.views.week'), title: t('calendar.views.weekShortcut') },
      { value: 'upcoming', label: t('calendar.views.upcoming'), title: t('calendar.views.upcomingShortcut') }
    ]
  });
}

// Notices above the calendar: accounts that can show their calendar after signing in again, and fetch errors.
// Without Google sign-in on this PC there is nothing to reconnect with; the sidebar row still explains that.
function noticesHtml() {
  const canSignIn = Boolean(ctx.S.data && ctx.S.data.googleAvailable);
  return accounts()
    .filter((a) => (a.state === 'reconnect' && canSignIn && !prefs.dismissed[a.id]) || a.state === 'error')
    .map((a) => {
      if (a.state === 'reconnect') {
        const text = a.error ? a.error.message : t('calendar.connect.help');
        return `<div class="cal-notice" role="status"><span class="ic">${icons.calendar}</span>
          <div class="text"><div class="t">${esc(t('calendar.connect.title', { email: a.email }))}</div><div class="d">${esc(text)}</div></div>
          <button class="btn sm" data-cal-dismiss="${esc(a.id)}">${esc(t('calendar.connect.later'))}</button>
          <button class="btn sm primary" data-cal-reconnect="${esc(a.id)}">${esc(t('calendar.connect.action'))}</button></div>`;
      }
      const open = a.error && a.error.url ? `<button class="btn sm" data-href="${esc(a.error.url)}">${esc(t('calendar.errors.openCloud'))}</button>` : '';
      return `<div class="cal-notice error" role="status"><span class="ic">${icons.info}</span>
        <div class="text"><div class="t">${esc(a.email)}</div><div class="d">${esc(a.error ? a.error.message : '')}</div></div>
        ${open}<button class="btn sm secondary" data-cal-retry="${esc(a.id)}">${esc(t('common.actions.retry'))}</button></div>`;
    })
    .join('');
}

function render() {
  const el = $('.calendar');
  if (!el) return;
  const view = shownView();
  if (!el.querySelector('.cal-head')) {
    el.innerHTML = `<div class="cal-head"><div class="cal-head-main"></div><span class="spacer"></span>${viewSwitch()}
        <button class="icon-btn" data-cal="sync" title="${esc(t('calendar.sync.shortcut'))}">${icons.sync}</button></div>
      <div class="cal-notices"></div><div class="cal-body"></div>`;
  }
  el.querySelector('.cal-head-main').innerHTML = headHtml(view);
  setSegmented(el.querySelector('.cal-head .segmented'), prefs.view);
  el.querySelector('.cal-notices').innerHTML = noticesHtml();
  const body = el.querySelector('.cal-body');
  const old = body.querySelector('.cal-scroll');
  const top = old ? old.scrollTop : 0;
  // A redraw (a sync, a change) keeps the keyboard on the event it was on.
  const focused = body.contains(document.activeElement) ? document.activeElement.dataset.ev : null;
  if (!accounts().length && C.data) {
    body.innerHTML = `<div class="empty">${icons.calendar}<div class="t">${esc(t('calendar.empty.title'))}</div><div class="h">${esc(t('calendar.empty.help'))}</div></div>`;
  } else body.innerHTML = view === 'upcoming' ? listHtml() : gridHtml(view);
  const scroll = body.querySelector('.cal-scroll');
  if (scroll) {
    if (C.scroll) scroll.scrollTop = workingDayTop(view, scroll.clientHeight);
    else scroll.scrollTop = top;
    scroll.addEventListener('scroll', () => followScroll(scroll), { passive: true });
  }
  C.scroll = false;
  if (focused) body.querySelector(`[data-ev="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
  if (C.pop) {
    const e = byId(C.pop);
    const places = e ? body.querySelectorAll(`[data-ev="${CSS.escape(e.id)}"]`) : [];
    const anchor = places[C.popIndex] || places[0];
    if (e && anchor) openPop(e, anchor, { focus: false });
    else closePop();
  }
}

// Where the grid opens: an hour or two before now on today, otherwise the start of the working day.
// The Upcoming list opens at its top.
function workingDayTop(view, height) {
  if (view === 'upcoming') return 0;
  const r = range(view);
  const now = Date.now();
  const hours = now >= r.start && now < r.end ? Math.max(0, minutes(now) / 60 - 2) : 7.5;
  return Math.min(hours * HOUR, 24 * HOUR - height);
}

function stateClass(e) {
  if (e.response === 'needsAction') return 'needs';
  if (e.response === 'tentative') return 'maybe';
  if (e.response === 'declined') return 'declined';
  return '';
}

function ariaLabel(e) {
  const cal = calendarOf(e);
  const parts = [titleOf(e), whenText(e), cal ? cal.name : ''];
  if (e.response && e.response !== 'accepted') parts.push(t(`calendar.response.${e.response}`));
  return parts.filter(Boolean).join(', ');
}

// Timed events of at least a day sit with the all-day events, as in Google Calendar.
const inAllDayRow = (e) => e.allDay || e.end - e.start >= DAY;

function gridHtml(view) {
  const r = range(view);
  const days = view === 'day' ? 1 : 7;
  const columns = Array.from({ length: days }, (_, i) => addDays(r.start, i));
  const list = events();
  const today = startOfDay(Date.now());
  const head = columns
    .map(
      (d) =>
        `<button class="cal-dayhead ${d === today ? 'today' : ''}" data-cal-day="${d}" title="${esc(longDay(d))}"><span class="dow">${esc(fmt(d, { weekday: 'short' }))}</span><span class="dom">${esc(fmt(d, { day: 'numeric' }))}</span></button>`
    )
    .join('');
  const { placed, rows } = allDayLayout(list.filter(inAllDayRow), r.start, days);
  const chips = placed
    .map(({ e, from, to, row }) => {
      const cls = [stateClass(e), e.start < r.start ? 'cont-l' : '', e.end > r.end ? 'cont-r' : ''].join(' ');
      return `<button class="cal-chip ${cls}" data-ev="${esc(e.id)}" style="grid-column:${from + 2} / span ${to - from + 1};grid-row:${row + 1};--c:${colorOf(e.accountId)}" aria-label="${esc(ariaLabel(e))}"><span class="t">${esc(e.allDay ? titleOf(e) : `${hhmm(e.start)} ${titleOf(e)}`)}</span></button>`;
    })
    .join('');
  const cells = columns.map((d, i) => `<div class="cal-allday-cell" data-cal-allday="${d}" style="grid-column:${i + 2};grid-row:1 / span ${Math.max(rows, 1)}"></div>`).join('');
  const hours = Array.from({ length: 23 }, (_, i) => `<div class="cal-hour" style="top:${(i + 1) * HOUR}px"><span>${esc(hhmm(new Date(2000, 0, 1, i + 1).getTime()))}</span></div>`).join('');
  const timed = list.filter((e) => !inAllDayRow(e));
  const cols = columns
    .map((d) => {
      const blocks = layoutDay(segments(timed, d)).map(eventHtml).join('');
      const now = d === today ? `<div class="cal-now" style="top:${(minutes(Date.now()) * HOUR) / 60}px"></div>` : '';
      return `<div class="cal-col ${d === today ? 'today' : ''}" data-cal-col="${d}">${blocks}${now}</div>`;
    })
    .join('');
  return `<div class="cal-grid-wrap" style="--days:${days}">
    <div class="cal-days"><div class="cal-gutter"></div>${head}</div>
    <div class="cal-allday" style="--rows:${Math.max(rows, 1)}"><div class="cal-gutter cal-allday-label">${esc(t('calendar.event.allDay'))}</div>${cells}${chips}</div>
    <div class="cal-scroll"><div class="cal-grid" style="height:${24 * HOUR}px"><div class="cal-hours">${hours}</div>${cols}</div></div>
  </div>`;
}

function allDayLayout(list, start, days) {
  const rows = [];
  const placed = [];
  const sorted = [...list].sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start));
  for (const e of sorted) {
    const from = Math.max(0, dayIndex(e.start, start));
    const to = Math.min(days - 1, dayIndex(e.end - 1, start));
    if (to < from) continue;
    let row = rows.findIndex((taken) => taken.every(([a, b]) => to < a || from > b));
    if (row < 0) {
      row = rows.length;
      rows.push([]);
    }
    rows[row].push([from, to]);
    placed.push({ e, from, to, row });
  }
  return { placed, rows: rows.length };
}

// The part of each timed event that falls on one day, in minutes from midnight.
function segments(list, day) {
  const next = addDays(day, 1);
  const out = [];
  for (const e of list) {
    if (e.start >= next || e.end <= day) continue;
    const top = e.start <= day ? 0 : minutes(e.start);
    const bottom = e.end >= next ? 1440 : minutes(e.end);
    out.push({ e, top, bottom: Math.max(bottom, top) });
  }
  return out;
}

// Events that overlap share the column side by side; one stretches right over columns that are free beside it.
function layoutDay(segs) {
  const minMinutes = (MIN_EVENT * 60) / HOUR;
  for (const s of segs) s.end = Math.max(s.bottom, s.top + minMinutes);
  segs.sort((a, b) => a.top - b.top || b.end - a.end);
  const clusters = [];
  let current = null;
  let reach = -1;
  for (const s of segs) {
    if (!current || s.top >= reach) {
      current = [];
      clusters.push(current);
    }
    current.push(s);
    reach = Math.max(reach, s.end);
  }
  for (const cluster of clusters) {
    const columns = [];
    for (const s of cluster) {
      let col = columns.findIndex((end) => end <= s.top);
      if (col < 0) {
        col = columns.length;
        columns.push(0);
      }
      columns[col] = s.end;
      s.col = col;
    }
    for (const s of cluster) {
      s.cols = columns.length;
      s.span = 1;
      while (s.col + s.span < s.cols && !cluster.some((o) => o.col === s.col + s.span && o.top < s.end && o.end > s.top)) s.span++;
    }
  }
  return segs;
}

function eventHtml(s) {
  const e = s.e;
  const top = (s.top * HOUR) / 60;
  const height = Math.max(((s.bottom - s.top) * HOUR) / 60, MIN_EVENT) - 2;
  const short = height < 34;
  const left = (s.col / s.cols) * 100;
  const width = (s.span / s.cols) * 100;
  const time = short ? hhmm(e.start) : `${hhmm(e.start)} – ${hhmm(e.end)}`;
  return `<button class="cal-ev ${stateClass(e)} ${short ? 'short' : ''}" data-ev="${esc(e.id)}" style="top:${top}px;height:${height}px;left:calc(${left}% + 1px);width:calc(${width}% - 3px);--c:${colorOf(e.accountId)}" aria-label="${esc(ariaLabel(e))}">
    <span class="t">${esc(titleOf(e))}</span><span class="w">${esc(time)}</span>${!short && e.location && height >= 52 ? `<span class="w">${esc(e.location)}</span>` : ''}</button>`;
}

function listHtml() {
  const r = range('upcoming');
  const list = events();
  const now = Date.now();
  const today = startOfDay(now);
  let out = '';
  for (let d = r.start; d < r.end; d = addDays(d, 1)) {
    const next = addDays(d, 1);
    const day = list
      .filter((e) => e.start < next && e.end > d && (d !== today || e.end > now || e.allDay))
      .sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.start - b.start);
    if (!day.length) continue;
    const label = d === today ? t('common.dates.today') : d === addDays(today, 1) ? t('calendar.dates.tomorrow') : cap(fmt(d, { weekday: 'long' }));
    out += `<section class="cal-list-day"><h2><span>${esc(label)}</span><span class="sub">${esc(fmt(d, { day: 'numeric', month: 'long' }))}</span></h2>${day
      .map((e) => rowHtml(e, d, next))
      .join('')}</section>`;
  }
  if (!out) out = `<div class="empty">${icons.calendar}<div class="t">${esc(t('calendar.empty.upcoming', { count: C.upcomingDays }))}</div></div>`;
  return `<div class="cal-scroll cal-list"><div class="cal-list-inner">${out}<button class="btn secondary sm cal-more" data-cal="more">${esc(t('calendar.views.more'))}</button></div></div>`;
}

function rowHtml(e, day, next) {
  let time;
  if (e.allDay || (e.start <= day && e.end >= next)) time = t('calendar.event.allDay');
  else if (e.start < day) time = t('calendar.event.until', { time: hhmm(e.end) });
  else if (e.end > next) time = t('calendar.event.from', { time: hhmm(e.start) });
  else time = `${hhmm(e.start)} – ${hhmm(e.end)}`;
  const sub = [e.location, calendarOf(e)?.name].filter(Boolean).join(' · ');
  return `<button class="cal-row ${stateClass(e)}" data-ev="${esc(e.id)}" aria-label="${esc(ariaLabel(e))}">
    <span class="cal-row-time">${esc(time)}</span><span class="cal-dot" style="--c:${colorOf(e.accountId)}"></span>
    <span class="cal-row-main"><span class="cal-row-title">${esc(titleOf(e))}</span><span class="cal-row-sub">${esc(sub)}</span></span>
    ${e.response === 'needsAction' ? `<span class="cal-pill">${esc(t('calendar.event.invitation'))}</span>` : ''}</button>`;
}

// ---------- event card ----------

function linkify(text) {
  return esc(text).replace(/https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)]/g, (url) => `<a href="#" data-href="${url}">${url}</a>`);
}

const RESPONSE_MARK = { accepted: 'check', declined: 'close', tentative: 'info', needsAction: 'clock' };

function popHtml(e) {
  const acc = account(e.accountId);
  const cal = calendarOf(e);
  const guests = e.attendees || [];
  const actions = [
    e.canEdit ? `<button class="icon-btn sm" data-pop="edit" title="${esc(t('calendar.event.editShortcut'))}">${icons.edit}</button>` : '',
    e.canEdit ? `<button class="icon-btn sm" data-pop="delete" title="${esc(t('calendar.event.deleteShortcut'))}">${icons.trash}</button>` : '',
    e.link ? `<button class="icon-btn sm" data-href="${esc(e.link)}" title="${esc(t('calendar.event.openGoogle'))}">${icons.popOut}</button>` : '',
    `<button class="icon-btn sm" data-pop="close" title="${esc(t('common.actions.close'))}">${icons.close}</button>`
  ].join('');
  const row = (icon, html) => `<div class="cal-pop-row"><span class="ic">${icons[icon]}</span><div>${html}</div></div>`;
  const rows = [];
  if (e.seriesId) rows.push(row('repeat', esc(t('calendar.event.series'))));
  if (e.meeting) rows.push(row('video', `<button class="link-btn" data-href="${esc(e.meeting)}">${esc(t('calendar.event.join'))}</button>`));
  if (e.location) rows.push(row('pin', /^https?:\/\//.test(e.location) ? linkify(e.location) : `<span class="sel">${esc(e.location)}</span>`));
  if (guests.length) {
    const shown = guests.slice(0, 8);
    const people = shown
      .map((g) => {
        const name = g.name || g.address;
        const role = g.organizer ? `<span class="role">${esc(t('calendar.guests.organizer'))}</span>` : '';
        return `<li class="${esc(g.response)}" title="${esc(`${g.address} · ${t(`calendar.response.${g.response}`)}`)}"><span class="mark" aria-label="${esc(t(`calendar.response.${g.response}`))}">${icons[RESPONSE_MARK[g.response]]}</span><span class="name">${esc(name)}</span>${role}</li>`;
      })
      .join('');
    const more = guests.length > shown.length || e.moreAttendees ? `<li class="more">${esc(t('calendar.guests.more', { count: Math.max(guests.length - shown.length, 1) }))}</li>` : '';
    rows.push(row('people', `<div class="cal-guests-n">${esc(t('calendar.guests.count', { count: guests.length }))}</div><ul class="cal-guests">${people}${more}</ul>`));
  } else if (e.organizer && !e.organizer.self && e.organizer.address) {
    rows.push(row('person', esc(t('calendar.guests.organizedBy', { name: e.organizer.name || e.organizer.address }))));
  }
  if (e.description) rows.push(row('notes', `<div class="cal-desc">${linkify(e.description)}</div>`));
  rows.push(row('calendar', `<span class="cal-dot" style="--c:${colorOf(e.accountId)}"></span>${esc(cal ? cal.name : '')}<span class="cal-acc">${esc(acc ? acc.email : '')}</span>`));
  const rsvp = e.canRespond
    ? `<div class="cal-rsvp"><span>${esc(t('calendar.rsvp.question'))}</span><div class="filters" role="group" aria-label="${esc(t('calendar.rsvp.question'))}">${RESPONSES.map(
        (r) => `<button class="filter ${e.response === r ? 'active' : ''}" data-rsvp="${r}" aria-pressed="${e.response === r}">${esc(t(`calendar.rsvp.${r}`))}</button>`
      ).join('')}</div></div>`
    : '';
  return `<div class="cal-pop-bar">${actions}</div>
    <div class="cal-pop-head"><span class="cal-swatch" style="--c:${colorOf(e.accountId)}"></span><div><h2 id="cal-pop-title" class="sel">${esc(titleOf(e))}</h2>
      <div class="cal-pop-when">${esc(whenText(e))}</div></div></div>
    ${rows.join('')}${rsvp}`;
}

function popEl() {
  return document.querySelector('.cal-pop');
}

function openPop(e, anchor, { focus = true } = {}) {
  let pop = popEl();
  if (!pop) {
    pop = document.createElement('div');
    pop.className = 'cal-pop';
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-labelledby', 'cal-pop-title');
    pop.addEventListener('click', popClick);
    document.body.appendChild(pop);
  }
  for (const el of $$('.calendar .open[data-ev]')) el.classList.remove('open');
  anchor.classList.add('open');
  C.pop = e.id;
  // Which of the event's places on screen it was, so a redraw opens the card at the same one.
  C.popIndex = Math.max(0, $$(`.calendar [data-ev="${CSS.escape(e.id)}"]`).indexOf(anchor));
  pop.dataset.id = e.id;
  pop.innerHTML = popHtml(e);
  place(pop, anchor);
  if (focus) (pop.querySelector('[data-rsvp], [data-pop="edit"]') || pop.querySelector('[data-pop="close"]')).focus();
}

function place(pop, anchor) {
  const r = anchor.getBoundingClientRect();
  const w = pop.offsetWidth;
  const h = pop.offsetHeight;
  const gap = 8;
  let left = r.right + gap;
  if (left + w > window.innerWidth - 8) left = r.left - gap - w;
  if (left < 8) left = Math.min(window.innerWidth - w - 8, Math.max(8, r.left));
  const top = Math.max(48, Math.min(r.top, window.innerHeight - h - 8));
  pop.style.left = `${Math.max(8, left)}px`;
  pop.style.top = `${top}px`;
}

// The card moves along when its event scrolls, and closes once the event is out of sight. Focusing an event that
// is partly hidden scrolls it into view, so a scroll can come right after the click that opened the card.
function followScroll(scroll) {
  const pop = popEl();
  // A multi-day event shows more than once; the open one is the one that was clicked.
  const anchor = C.pop && $('.calendar .open[data-ev]');
  if (!pop || !anchor || !scroll.contains(anchor)) return;
  const a = anchor.getBoundingClientRect();
  const s = scroll.getBoundingClientRect();
  if (a.bottom < s.top || a.top > s.bottom) closePop();
  else place(pop, anchor);
}

function closePop(refocus = false) {
  const anchor = C.pop && $('.calendar .open[data-ev]');
  C.pop = null;
  popEl()?.remove();
  for (const el of $$('.calendar .open[data-ev]')) el.classList.remove('open');
  if (refocus) anchor?.focus();
}

function popClick(ev) {
  const btn = ev.target.closest('button, a');
  if (!btn) return;
  const e = byId(C.pop);
  if (btn.dataset.href) {
    ev.preventDefault();
    api('openExternal', btn.dataset.href);
    return;
  }
  if (!e) return closePop();
  if (btn.dataset.pop === 'close') return closePop(true);
  if (btn.dataset.pop === 'edit') return editEvent(e);
  if (btn.dataset.pop === 'delete') return removeEvent(e);
  if (btn.dataset.rsvp) return respond(e, btn.dataset.rsvp);
}

document.addEventListener('mousedown', (ev) => {
  if (!C.pop || ev.target.closest('.cal-pop, .scrim, .menu')) return;
  // A click on an event opens that one; the click handler takes care of it.
  if (ev.target.closest('.calendar [data-ev]')) return;
  closePop();
  // A click in the empty grid that closes the card doesn't also start a new event.
  if (ev.target.closest('[data-cal-col], [data-cal-allday]')) C.swallow = true;
});
window.addEventListener('resize', () => {
  closePop();
  if (C.open) reload();
});

// ---------- changes ----------

// The calendars a new event can go in, the default one first: the last one used, else the default account's own.
function writable() {
  const list = [];
  for (const a of accounts()) {
    if (a.state === 'reconnect') continue;
    for (const cal of a.calendars) if (cal.writable) list.push({ a, cal, key: key(a.id, cal.id) });
  }
  const preferred = ctx.S.data.settings.defaultAccountId;
  const rank = (x) => (x.key === prefs.calendar ? 0 : x.a.id === preferred && x.cal.primary ? 1 : x.cal.primary ? 2 : 3);
  return list.sort((x, y) => rank(x) - rank(y));
}

export function newEvent(preset = {}) {
  closePop();
  let start = preset.start;
  if (!start) {
    // The next half hour when today is on screen, otherwise nine o'clock on the day shown.
    const now = Date.now();
    const view = shownView();
    const shown = range(view);
    const showsToday = view === 'upcoming' || (shown.start <= now && now < shown.end);
    start = showsToday ? Math.ceil(now / 1800000) * 1800000 : parseLocal(dateValue(view === 'week' ? weekStart(C.date) : C.date), '09:00');
  }
  const allDay = Boolean(preset.allDay);
  return eventDialog(null, { allDay, start, end: allDay ? addDays(start, 1) : start + 3600000 });
}

function fromEvent(e) {
  return { title: e.title, location: e.location, description: e.description, allDay: e.allDay, start: e.start, end: e.end, key: key(e.accountId, e.calendarId) };
}

function formHtml(v, e) {
  const own = e ? [{ a: account(e.accountId), cal: calendarOf(e), key: key(e.accountId, e.calendarId) }] : writable();
  const groups = new Map();
  for (const o of own) {
    if (!o.a || !o.cal) continue;
    if (!groups.has(o.a.id)) groups.set(o.a.id, { a: o.a, items: [] });
    groups.get(o.a.id).items.push(o);
  }
  const select = [...groups.values()]
    .map((g) => `<optgroup label="${esc(g.a.email)}">${g.items.map((o) => `<option value="${esc(o.key)}" ${o.key === v.key ? 'selected' : ''}>${esc(o.cal.name)}</option>`).join('')}</optgroup>`)
    .join('');
  const lastDay = v.allDay ? addDays(v.end, -1) : v.end;
  // The instants the fields started from; readForm keeps them for fields left as they were.
  return `<div class="form cal-form ${v.allDay ? 'all-day' : ''}" data-start="${Number(v.start)}" data-end="${Number(v.end)}">
    <input type="text" name="title" class="cal-form-title" value="${esc(v.title || '')}" placeholder="${esc(t('calendar.dialog.titlePlaceholder'))}" aria-label="${esc(t('calendar.dialog.title'))}"/>
    <div class="cal-when">
      <label>${esc(t('calendar.dialog.starts'))}<span class="cal-dt"><input type="date" name="startDate" value="${dateValue(v.start)}"/><input type="time" name="startTime" step="300" value="${timeValue(v.start)}"/></span></label>
      <label>${esc(t('calendar.dialog.ends'))}<span class="cal-dt"><input type="date" name="endDate" value="${dateValue(lastDay)}"/><input type="time" name="endTime" step="300" value="${timeValue(v.end)}"/></span></label>
    </div>
    <label class="inline"><input type="checkbox" name="allDay" ${v.allDay ? 'checked' : ''}/> ${esc(t('calendar.event.allDay'))}</label>
    <label>${esc(t('calendar.dialog.calendar'))}<select name="calendar" ${e ? 'disabled' : ''}>${select}</select></label>
    <label>${esc(t('calendar.dialog.location'))}<input type="text" name="location" value="${esc(v.location || '')}"/></label>
    <label>${esc(t('calendar.dialog.description'))}<textarea name="description">${esc(v.description || '')}</textarea></label>
    ${e && e.seriesId ? `<p class="note">${esc(t('calendar.dialog.seriesNote'))}</p>` : ''}
    <div class="error" data-error>${esc(v.error || '')}</div>
  </div>`;
}

function bindForm(body) {
  const f = body.querySelector('.cal-form');
  const field = (n) => f.querySelector(`[name="${n}"]`);
  const at = (date, time) => parseLocal(date || dateValue(Date.now()), field('allDay').checked ? '00:00' : time);
  const startOf = () => at(field('startDate').value, field('startTime').value);
  const endOf = () => at(field('endDate').value, field('endTime').value);
  // Moving the start moves the end with it, so the event keeps its length: in time for a timed event, in
  // calendar days for an all-day one, whose days are 23 or 25 hours long across a clock change.
  const dayCount = () => Math.round((at(field('endDate').value, '00:00') - at(field('startDate').value, '00:00')) / DAY);
  let length = endOf() - startOf();
  let days = dayCount();
  const remember = () => {
    length = endOf() - startOf();
    days = dayCount();
  };
  const follow = () => {
    if (field('allDay').checked) field('endDate').value = dateValue(addDays(at(field('startDate').value, '00:00'), Math.max(days, 0)));
    else {
      const end = startOf() + Math.max(length, 0);
      field('endDate').value = dateValue(end);
      field('endTime').value = timeValue(end);
    }
    remember();
  };
  field('startDate').addEventListener('change', follow);
  field('startTime').addEventListener('change', follow);
  field('endDate').addEventListener('change', remember);
  field('endTime').addEventListener('change', remember);
  field('allDay').addEventListener('change', () => {
    f.classList.toggle('all-day', field('allDay').checked);
    remember();
  });
  // Enter in a single-line field saves.
  f.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && ev.target.tagName === 'INPUT' && ev.target.type !== 'checkbox') {
      ev.preventDefault();
      body.closest('.dialog').querySelector('.buttons button.primary')?.click();
    }
  });
}

function readForm(scrim) {
  const f = scrim.querySelector('.cal-form');
  const field = (n) => f.querySelector(`[name="${n}"]`);
  const fail = (message) => {
    f.querySelector('[data-error]').textContent = message;
    return KEEP_OPEN;
  };
  const allDay = field('allDay').checked;
  const startDate = field('startDate').value;
  const endDate = field('endDate').value;
  if (!startDate || !endDate || (!allDay && (!field('startTime').value || !field('endTime').value))) return fail(t('calendar.dialog.missingTime'));
  const [accountId, calendarId] = String(field('calendar').value || '').split('\n');
  if (!accountId || !calendarId) return fail(t('calendar.dialog.noCalendar'));
  const out = { accountId, calendarId, key: field('calendar').value, title: field('title').value.trim(), location: field('location').value.trim(), description: field('description').value, allDay };
  if (allDay) {
    if (endDate < startDate) return fail(t('calendar.dialog.endBeforeStart'));
    out.startDate = startDate;
    out.endDate = dateValue(addDays(parseLocal(endDate), 1));
    out.start = parseLocal(startDate);
    out.end = parseLocal(out.endDate);
  } else {
    // A field left as it was keeps its instant: on the night the clocks go back, 02:30 happens twice and parsing
    // it again would pick the first one.
    const kept = (ms, date, time) => (Number.isFinite(ms) && dateValue(ms) === date && timeValue(ms) === time ? ms : parseLocal(date, time));
    out.start = kept(Number(f.dataset.start), startDate, field('startTime').value);
    out.end = kept(Number(f.dataset.end), endDate, field('endTime').value);
    if (out.end <= out.start) return fail(t('calendar.dialog.endBeforeStart'));
  }
  return out;
}

// Guests hear about a change only when the user says so, as Google Calendar asks.
async function notifyGuests(e, what) {
  const others = (e.attendees || []).filter((a) => !a.self);
  if (!e.organizer || !e.organizer.self || !others.length) return false;
  return dialog({
    title: t(`calendar.notify.${what}Title`),
    body: `<p>${esc(t('calendar.notify.help', { count: others.length }))}</p>`,
    buttons: [
      { label: t('common.actions.cancel'), value: null },
      { label: t('calendar.notify.dontSend'), value: false },
      { label: t('calendar.notify.send'), value: true, primary: true }
    ]
  });
}

// A new event's id, made when its dialog opens, so a Save tried again after a lost answer finds the event it made
// instead of making a second one. Google wants base32hex: 0-9 and a-v.
function newEventId() {
  const digits = '0123456789abcdefghijklmnopqrstuv';
  return Array.from(crypto.getRandomValues(new Uint8Array(26)), (b) => digits[b & 31]).join('');
}

async function eventDialog(e, preset) {
  const options = writable();
  if (!e && !options.length) {
    toast(t('calendar.errors.noWritable'), 5000);
    return;
  }
  const createId = e ? null : newEventId();
  let values = e ? fromEvent(e) : { ...preset, key: options[0].key };
  for (;;) {
    const result = await dialog({
      title: e ? t('calendar.dialog.editTitle') : t('calendar.dialog.newTitle'),
      wide: true,
      buttons: [
        { label: t('common.actions.cancel'), value: null },
        { label: t('common.actions.save'), value: (scrim) => readForm(scrim), primary: true }
      ],
      render(body) {
        body.innerHTML = formHtml(values, e);
        bindForm(body);
      }
    });
    if (!result) return;
    const { key: chosen, ...input } = result;
    try {
      let saved;
      if (e) {
        const notify = await notifyGuests(e, 'update');
        if (notify === null) return;
        saved = await api('calendarUpdate', e.id, input, { notify });
      } else {
        saved = await api('calendarCreate', { ...input, id: createId });
        prefs.calendar = chosen;
        savePrefs();
        toast(t('calendar.event.created'));
      }
      // Show the saved event when it lies outside what is on screen.
      const r = range();
      if (saved && (saved.start >= r.end || saved.end <= r.start) && shownView() !== 'upcoming') C.date = startOfDay(saved.start);
      C.pop = null;
      reload(0);
      return;
    } catch (err) {
      values = { ...result, error: err.message };
    }
  }
}

function editEvent(e) {
  closePop();
  eventDialog(e);
}

function seriesChoice(title) {
  return choiceDialog(
    title,
    [
      { label: t('calendar.series.one'), value: 'one' },
      { label: t('calendar.series.all'), value: 'all' }
    ],
    'one'
  );
}

async function removeEvent(e) {
  closePop();
  let series = false;
  if (e.seriesId) {
    const choice = await seriesChoice(t('calendar.series.deleteTitle'));
    if (!choice) return;
    series = choice === 'all';
  } else if (!(await confirmDialog(t('calendar.event.deleteTitle'), t('calendar.event.deleteHelp', { title: titleOf(e) }), t('common.actions.delete'), true))) return;
  const notify = await notifyGuests(e, 'delete');
  if (notify === null) return;
  try {
    await api('calendarDelete', e.id, { notify, series });
    toast(t('calendar.event.deleted'));
  } catch (err) {
    toast(err.message, 5000);
  }
  reload(0);
}

async function respond(e, response) {
  if (e.response === response) return;
  let series = false;
  if (e.seriesId) {
    const choice = await seriesChoice(t('calendar.series.respondTitle'));
    if (!choice) return;
    series = choice === 'all';
  }
  try {
    await api('calendarRespond', e.id, response, { series });
    toast(t(`calendar.rsvp.sent.${response}`));
  } catch (err) {
    toast(err.message, 5000);
  }
  reload(0);
}

// ---------- input ----------

function setView(view) {
  if (!['day', 'week', 'upcoming'].includes(view)) return;
  prefs.view = view;
  savePrefs();
  closePop();
  C.scroll = true;
  if (view === 'upcoming') C.upcomingDays = UPCOMING_DAYS;
  setSegmented($('.calendar .cal-head .segmented'), view);
  load();
}

function step(dir) {
  const view = shownView();
  if (view === 'upcoming') return;
  closePop();
  C.date = addDays(C.date, dir * (view === 'day' ? 1 : 7));
  load();
}

function goToday() {
  closePop();
  C.date = startOfDay(Date.now());
  C.scroll = true;
  load();
}

let bound = false;
function bind() {
  if (bound) return;
  const el = $('.calendar');
  if (!el) return;
  bound = true;
  el.addEventListener('click', (ev) => {
    const target = ev.target.closest('button, a, [data-cal-col], [data-cal-allday]');
    const swallow = C.swallow;
    C.swallow = false;
    if (!target) return;
    const d = target.dataset;
    if (d.href) {
      ev.preventDefault();
      api('openExternal', d.href);
      return;
    }
    if (d.calView) return setView(d.calView);
    if (d.cal === 'today') return goToday();
    if (d.cal === 'prev') return step(-1);
    if (d.cal === 'next') return step(1);
    if (d.cal === 'sync') return syncNow();
    if (d.cal === 'more') {
      C.upcomingDays = Math.min(C.upcomingDays + UPCOMING_DAYS, 12 * UPCOMING_DAYS);
      return load();
    }
    if (d.calReconnect) return reconnect(d.calReconnect);
    if (d.calDismiss) {
      prefs.dismissed[d.calDismiss] = true;
      savePrefs();
      return render();
    }
    if (d.calRetry) {
      api('calendarSync', d.calRetry).catch((err) => toast(err.message, 5000));
      return;
    }
    if (d.calDay) {
      C.date = Number(d.calDay);
      return setView('day');
    }
    if (d.ev) {
      const e = byId(d.ev);
      if (!e) return;
      if (C.pop === e.id) return closePop();
      // From the keyboard the card takes the focus; a mouse click leaves it where it is.
      return openPop(e, target, { focus: ev.detail === 0 });
    }
    if (swallow) return;
    if (d.calAllday) return newEvent({ start: Number(d.calAllday), allDay: true });
    if (d.calCol) {
      // An empty spot in the grid: a new event of an hour from the half hour clicked.
      const y = ev.clientY - target.getBoundingClientRect().top;
      const half = Math.max(0, Math.min(47, Math.floor((y / HOUR) * 2)));
      return newEvent({ start: parseLocal(dateValue(Number(d.calCol)), `${pad(Math.floor(half / 2))}:${half % 2 ? '30' : '00'}`) });
    }
  });
}

// The calendar's keys; true when the key was its own. Mail keys don't reach a hidden mailbox.
export function onKey(ev) {
  const key = ev.key.toLowerCase();
  const ctrl = ev.ctrlKey || ev.metaKey;
  const e = C.pop && byId(C.pop);
  const typing = ev.target && (ev.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(ev.target.tagName));
  if (ev.key === 'Escape' && C.pop) {
    closePop(true);
    return true;
  }
  if (typing) return false;
  if (e && e.canEdit && !ctrl && (ev.key === 'Delete' || key === 'e')) {
    if (ev.key === 'Delete') removeEvent(e);
    else editEvent(e);
    return true;
  }
  if ((ctrl && key === 'n' && !ev.shiftKey) || (!ctrl && !ev.altKey && (key === 'n' || key === 'c'))) {
    newEvent();
    return true;
  }
  if (ev.key === 'F5') {
    syncNow();
    return true;
  }
  if (ctrl || ev.altKey) return false;
  // Arrows inside a control (the view switch, the event card) stay with it.
  const inControl = ev.target.closest?.('[role="tablist"], .cal-pop');
  if (key === 't') goToday();
  else if ((ev.key === 'ArrowLeft' && !inControl) || key === 'k') step(-1);
  else if ((ev.key === 'ArrowRight' && !inControl) || key === 'j') step(1);
  else if (key === 'd') setView('day');
  else if (key === 'w') setView('week');
  else if (key === 'u') setView('upcoming');
  else return false;
  return true;
}

// The line for now moves along; a new day redraws.
setInterval(() => {
  if (!C.open) return;
  const today = startOfDay(Date.now());
  if (today !== C.today) {
    C.today = today;
    reload(0);
    return;
  }
  const line = $('.calendar .cal-now');
  if (line) line.style.top = `${(minutes(Date.now()) * HOUR) / 60}px`;
}, 30000);
