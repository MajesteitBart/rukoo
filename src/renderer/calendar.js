import { t, getLocale } from './i18n.js';
import { icons } from './icons.js';
import { api, esc, $, hhmm, avatar, toast, segmented, setSegmented } from './ui.js';
import {
  DAY,
  UPCOMING_DAYS,
  prefs,
  savePrefs,
  C,
  ctx,
  setContext,
  hooks,
  startOfDay,
  addDays,
  dayIndex,
  minutes,
  fmt,
  cap,
  pad,
  dateValue,
  parseLocal,
  longDay,
  whenText,
  key,
  accounts,
  account,
  calendarOf,
  titleOf,
  colorOf,
  isVisible,
  events,
  byId,
  shownView,
  range,
  duration,
  fromNow
} from './calendar-shared.js';
import { newEvent, editEvent, removeEvent, openPop, closePop, followScroll } from './calendar-event.js';

// The calendar view: the calendars of every account together, as a week, a day or a list of what comes next.
// Main fetches and caches the events (src/main/calendar); this module draws them and sends changes back.
// Every account keeps its own colour, the one it has in the unified inbox.
// State, dates and lookups live in calendar-shared.js; the event card and the dialog in calendar-event.js.

// The grid: pixels per hour, and the least an event is drawn, so a short one still shows its title.
const HOUR = 56;
const MIN_EVENT = 20;

// calendar-event.js loads the view again after a change through this.
hooks.reload = reload;

export { newEvent };

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
  setContext(context);
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
      // A CalDAV server's address and sign-in live in the account's Server settings.
      const open =
        a.error && a.error.url
          ? `<button class="btn sm" data-href="${esc(a.error.url)}">${esc(t('calendar.errors.openCloud'))}</button>`
          : a.kind === 'caldav'
            ? `<button class="btn sm" data-cal-server="${esc(a.id)}">${esc(t('calendar.errors.serverSettings'))}</button>`
            : '';
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

// Where the grid opens: at the start of the working day.
// The Upcoming list opens at its top.
function workingDayTop(view, height) {
  if (view === 'upcoming') return 0;
  const r = range(view);
  const now = Date.now();
  const start = 7.5 * HOUR;
  const nowTop = (minutes(now) * HOUR) / 60;
  let top = start;
  // Late in the day, the line for now still has to be on screen; then it sits about two thirds down.
  if (now >= r.start && now < r.end && nowTop > start + height - 16) top = nowTop - height * 0.66;
  return Math.max(0, Math.min(top, 24 * HOUR - height));
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

// An event in the grid: a card a pixel inside its slot and a few pixels in from the day's edges, so neighbours
// and back-to-back events stay apart without borders.
function eventHtml(s) {
  const e = s.e;
  const top = (s.top * HOUR) / 60 + 1;
  const height = Math.max(((s.bottom - s.top) * HOUR) / 60, MIN_EVENT) - 3;
  // Two lines need 42px; below that the title and start time share one.
  const short = height < 42;
  const left = (s.col / s.cols) * 100;
  const width = (s.span / s.cols) * 100;
  const time = short ? `<span class="w">${esc(hhmm(e.start))}</span>` : `<span class="w">${icons.clock}<span>${esc(`${hhmm(e.start)} – ${hhmm(e.end)}`)}</span></span>`;
  return `<button class="cal-ev ${stateClass(e)} ${short ? 'short' : ''}" data-ev="${esc(e.id)}" style="top:${top}px;height:${height}px;left:calc(${left}% + 3px);width:calc(${width}% - 6px);--c:${colorOf(e.accountId)}" aria-label="${esc(ariaLabel(e))}">
    <span class="t">${esc(titleOf(e))}</span>${time}${!short && e.location && height >= 59 ?`<span class="w"><span>${esc(e.location)}</span></span>` : ''}</button>`;
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

// The guests besides the user, as a stack of up to three faces and a count for the rest.
function peopleHtml(e) {
  const people = (e.attendees || []).filter((a) => !a.self);
  if (!people.length) return '';
  const shown = people.slice(0, 3);
  const names = people.map((a) => a.name || a.address).join(', ');
  return `<span class="cal-people" title="${esc(names)}">${shown.map((a) => avatar(a)).join('')}${
    people.length > shown.length ? `<span class="cal-people-more">+${people.length - shown.length}</span>` : ''
  }</span>`;
}

// A row of the Upcoming list: when, the event, where and with whom. Everything hangs from the first line.
function rowHtml(e, day, next) {
  const now = Date.now();
  let time;
  let detail = '';
  if (e.allDay || (e.start <= day && e.end >= next)) time = t('calendar.event.allDay');
  else if (e.start < day) time = t('calendar.event.until', { time: hhmm(e.end) });
  else if (e.end > next) time = t('calendar.event.from', { time: hhmm(e.start) });
  else time = `${hhmm(e.start)} – ${hhmm(e.end)}`;
  const today = day === startOfDay(now);
  if (!e.allDay && today && e.start <= now && e.end > now) detail = `<span class="rel now">${esc(t('calendar.event.now'))}</span>`;
  else if (!e.allDay && today && e.start > now) detail = `<span class="rel">${esc(fromNow(e.start - now))}</span>`;
  else if (!e.allDay && e.start >= day && e.end <= next) detail = `<span class="rel">${esc(duration(e.end - e.start))}</span>`;
  const meta = [
    e.location ? `<span class="m">${icons.pin}<span>${esc(e.location)}</span></span>` : '',
    e.meeting ? `<span class="m">${icons.video}<span>${esc(t('calendar.event.videoCall'))}</span></span>` : '',
    `<span class="m">${icons.calendar}<span>${esc(calendarOf(e)?.name || '')}</span></span>`
  ].join('');
  return `<button class="cal-row ${stateClass(e)}" data-ev="${esc(e.id)}" style="--c:${colorOf(e.accountId)}" aria-label="${esc(ariaLabel(e))}">
    <span class="cal-row-time"><span>${esc(time)}</span>${detail}</span><span class="cal-dot"></span>
    <span class="cal-row-main"><span class="cal-row-title">${esc(titleOf(e))}</span><span class="cal-row-sub">${meta}</span></span>
    ${e.response === 'needsAction' ? `<span class="cal-pill">${esc(t('calendar.event.invitation'))}</span>` : ''}${peopleHtml(e)}</button>`;
}

window.addEventListener('resize', () => {
  closePop();
  if (C.open) reload();
});

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
    if (d.calServer) return ctx.openSettings('server', { id: d.calServer });
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
  if (e && !ctrl && ((ev.key === 'Delete' && e.canDelete) || (key === 'e' && e.canEdit))) {
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

// The line for now moves along, and Upcoming's "in 25 min" and "Now" stay true; a new day redraws.
setInterval(() => {
  if (!C.open) return;
  const today = startOfDay(Date.now());
  if (today !== C.today) {
    C.today = today;
    reload(0);
    return;
  }
  if (shownView() === 'upcoming') render();
  const line = $('.calendar .cal-now');
  if (line) line.style.top = `${(minutes(Date.now()) * HOUR) / 60}px`;
}, 30000);
