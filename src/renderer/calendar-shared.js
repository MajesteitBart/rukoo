import { t, getLocale } from './i18n.js';
import { esc, $, hhmm } from './ui.js';

// What the calendar view and its event card share: the state of the view, the preferences kept on this computer,
// dates and the lookups into what main sent. calendar.js draws the view, calendar-event.js the card and the dialog.

export const DAY = 86400000;
export const UPCOMING_DAYS = 30;
// A week narrower than this shows its day instead: seven columns would be too narrow to read.
export const NARROW = 560;

export const prefs = { view: 'week', visible: {}, dismissed: {}, calendar: null, ...readPrefs() };
function readPrefs() {
  try {
    return JSON.parse(localStorage.getItem('rukoo.calendar') || '{}');
  } catch (_) {
    return {};
  }
}
export function savePrefs() {
  localStorage.setItem('rukoo.calendar', JSON.stringify(prefs));
}

export const C = {
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
// app.js's context, set by calendar.js's init().
export let ctx = null;
export function setContext(context) {
  ctx = context;
}

// What one part of the calendar asks of another without importing it: calendar.js sets reload when it loads, and
// calendar-event.js calls it after a change.
export const hooks = {
  reload: () => {}
};

// ---------- dates ----------

export function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// Days are added on the calendar, not as 24 hours, so a week across a clock change still starts at midnight.
export function addDays(ts, n) {
  const d = new Date(ts);
  d.setDate(d.getDate() + n);
  return d.getTime();
}

export function firstWeekday() {
  try {
    const locale = new Intl.Locale(getLocale());
    const info = typeof locale.getWeekInfo === 'function' ? locale.getWeekInfo() : locale.weekInfo;
    return info && info.firstDay ? info.firstDay % 7 : 1;
  } catch (_) {
    return 1;
  }
}

export function weekStart(ts) {
  const day = startOfDay(ts);
  return addDays(day, -((new Date(day).getDay() - firstWeekday() + 7) % 7));
}

export const dayIndex = (ts, from) => Math.round((startOfDay(ts) - from) / DAY);
export const minutes = (ts) => new Date(ts).getHours() * 60 + new Date(ts).getMinutes();
export const fmt = (ts, options) => new Intl.DateTimeFormat(getLocale(), options).format(new Date(ts));
export const cap = (s) => s.replace(/^./, (c) => c.toUpperCase());
export const pad = (n) => String(n).padStart(2, '0');
export const dateValue = (ts) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
export const timeValue = (ts) => `${pad(new Date(ts).getHours())}:${pad(new Date(ts).getMinutes())}`;
export function parseLocal(date, time = '00:00') {
  const [y, m, d] = date.split('-').map(Number);
  const [h, min] = time.split(':').map(Number);
  return new Date(y, m - 1, d, h || 0, min || 0).getTime();
}

// A date and time field that still show the instant ms keep it: on the night the clocks go back, 02:30 happens
// twice, and parsing it again would pick the first one.
export function keptInstant(ms, date, time) {
  return Number.isFinite(ms) && dateValue(ms) === date && timeValue(ms) === time ? ms : parseLocal(date, time);
}

export function longDay(ts) {
  return cap(fmt(ts, { weekday: 'long', day: 'numeric', month: 'long' }));
}

// "Tuesday 13 October, 14:00 – 15:30", or the days of an all-day event.
export function whenText(e) {
  if (e.allDay) {
    const last = addDays(e.end, -1);
    return startOfDay(last) === startOfDay(e.start) ? longDay(e.start) : `${longDay(e.start)} – ${longDay(last)}`;
  }
  if (startOfDay(e.start) === startOfDay(e.end - 1)) return `${longDay(e.start)}, ${hhmm(e.start)} – ${hhmm(e.end)}`;
  return `${longDay(e.start)}, ${hhmm(e.start)} – ${longDay(e.end)}, ${hhmm(e.end)}`;
}

// ---------- data ----------

export const key = (accountId, calendarId) => `${accountId}\n${calendarId}`;
export const accounts = () => (C.data && C.data.accounts) || [];
export const account = (id) => accounts().find((a) => a.id === id);
export const calendarOf = (e) => account(e.accountId)?.calendars.find((c) => c.id === e.calendarId) || null;
export const titleOf = (e) => e.title || t('calendar.event.noTitle');
// Account colours come from Rukoo's own palette; anything else falls back to the accent.
export const colorOf = (id) => {
  const c = account(id)?.color || '';
  return /^#[0-9a-f]{3,8}$/i.test(c) ? c : 'var(--accent)';
};

export function isVisible(accountId, cal) {
  const k = key(accountId, cal.id);
  return Object.hasOwn(prefs.visible, k) ? prefs.visible[k] : cal.selected !== false;
}

export function events() {
  return ((C.data && C.data.events) || []).filter((e) => {
    const cal = calendarOf(e);
    return cal && isVisible(e.accountId, cal);
  });
}

export const byId = (id) => ((C.data && C.data.events) || []).find((e) => e.id === id) || null;

export function shownView() {
  if (prefs.view !== 'week') return prefs.view;
  const width = $('.calendar')?.clientWidth || 0;
  return width && width < NARROW ? 'day' : 'week';
}

export function range(view = shownView()) {
  if (view === 'day') return { start: C.date, end: addDays(C.date, 1) };
  if (view === 'week') {
    const start = weekStart(C.date);
    return { start, end: addDays(start, 7) };
  }
  const start = startOfDay(Date.now());
  return { start, end: addDays(start, C.upcomingDays) };
}

// ---------- formatting ----------

export function linkify(text) {
  return esc(text).replace(/https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)]/g, (url) => `<a href="#" data-href="${url}">${url}</a>`);
}

// "45 min" or "1 hr, 30 min", in the interface language.
export function duration(ms) {
  const total = Math.round(ms / 60000);
  const parts = { hours: Math.floor(total / 60), minutes: total % 60 };
  if (!parts.hours) delete parts.hours;
  if (!parts.minutes && parts.hours) delete parts.minutes;
  try {
    return new Intl.DurationFormat(getLocale(), { style: 'short' }).format(parts);
  } catch (_) {
    return `${parts.hours ? `${parts.hours} h ` : ''}${parts.minutes ? `${parts.minutes} min` : ''}`.trim();
  }
}

// "in 25 min" or "in 3 hr", for what is still to come today.
export function fromNow(ms) {
  const minutesAway = Math.max(1, Math.round(ms / 60000));
  const rtf = new Intl.RelativeTimeFormat(getLocale(), { numeric: 'auto', style: 'short' });
  return minutesAway < 60 ? rtf.format(minutesAway, 'minute') : rtf.format(Math.round(minutesAway / 60), 'hour');
}

// ---- cal:B2 shared ----
// ---- /cal:B2 shared ----
// ---- cal:B3 shared ----
// ---- /cal:B3 shared ----
