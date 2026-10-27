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
  today: startOfDay(Date.now()),
  // The month the mini month shows (its first day), or null to follow the view's date; and its focused day.
  mini: null,
  miniFocus: null,
  // A drag on the grid in progress, from the press until its change is saved; the view doesn't redraw meanwhile.
  drag: null,
  // The search field and its results while they show instead of the view: { query, results, failed, busy, seq }.
  search: null,
  // The side panel that is open ('free'), or null.
  panel: null,
  // Open time the availability panel shows on the grid: [[start, end], ...] in ms.
  highlight: null,
  // Notices from other parts of the app, by source: { booking: [CalendarNotice], ... }.
  notices: {},
  // The booking page's state from main (BookingState), for the requests on the grid and booked events.
  booking: null
};
// app.js's context, set by calendar.js's init().
export let ctx = null;
export function setContext(context) {
  ctx = context;
}

// What one part of the calendar asks of another without importing it: calendar.js sets reload when it loads, and
// calendar-event.js calls it after a change. openRequest opens a booking request's card (calendar-event.js sets it);
// panels holds the side panels the toolbar can open, such as the availability panel (calendar-free.js registers it).
export const hooks = {
  reload: () => {},
  openRequest: null,
  panels: {}
};

// ---------- calendar settings ----------

// settings.calendar as main keeps it (contracts d), with every field filled in, also before main keeps it at all.
const CALENDAR_DEFAULTS = {
  visible: {},
  availability: {},
  colors: {},
  weekStart: null,
  weekends: true,
  workDays: [1, 2, 3, 4, 5],
  workStart: '09:00',
  workEnd: '17:00',
  duration: 60,
  reminder: 10,
  notify: true,
  notifiedUpgrade: false
};
const isMap = (v) => v && typeof v === 'object' && !Array.isArray(v);

export function calSettings() {
  const saved = ctx && ctx.S && ctx.S.data && ctx.S.data.settings && ctx.S.data.settings.calendar;
  if (!isMap(saved)) return CALENDAR_DEFAULTS;
  const out = { ...CALENDAR_DEFAULTS, ...saved };
  for (const k of ['visible', 'availability', 'colors']) if (!isMap(out[k])) out[k] = {};
  if (!Array.isArray(out.workDays)) out.workDays = CALENDAR_DEFAULTS.workDays;
  return out;
}

// What calendarSettings answered, so the view uses it before app.js reads the state again.
export function setCalSettings(saved) {
  if (isMap(saved) && ctx && ctx.S && ctx.S.data && ctx.S.data.settings) ctx.S.data.settings.calendar = saved;
}

// 'HH:MM' as minutes from midnight; '24:00' is 1440.
export function clockMinutes(text, fallback = 0) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(text || ''));
  return m ? Math.min(1440, Number(m[1]) * 60 + Number(m[2])) : fallback;
}

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

// The week starts where Settings → Calendar says, else where the language's region starts it.
export function firstWeekday() {
  const chosen = calSettings().weekStart;
  if (chosen === 0 || chosen === 1 || chosen === 6) return chosen;
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

export function monthStart(ts) {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
}

// The same day n months on, or the month's last day where it is shorter: 31 January plus one is 28 February.
export function addMonths(ts, n) {
  const d = new Date(ts);
  const last = new Date(d.getFullYear(), d.getMonth() + n + 1, 0).getDate();
  return new Date(d.getFullYear(), d.getMonth() + n, Math.min(d.getDate(), last)).getTime();
}

// The days a week shows: all seven, or without Saturday and Sunday when Settings → Calendar hides weekends.
export function shownDays(start, count = 7) {
  const all = Array.from({ length: count }, (_, i) => addDays(start, i));
  if (calSettings().weekends !== false) return all;
  const workweek = all.filter((d) => ![0, 6].includes(new Date(d).getDay()));
  return workweek.length ? workweek : all;
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

const HEX = /^#[0-9a-f]{6}$/i;

// A calendar's colour: the one picked in its sidebar menu, else its own (Google's or the CalDAV server's), else its
// account's. Main resolves the same into cal.color; the pick is read here too, so it shows before main answers.
export function calendarColor(accountId, cal) {
  const picked = cal ? calSettings().colors[key(accountId, cal.id)] : null;
  if (HEX.test(picked || '')) return picked;
  if (cal && HEX.test(cal.color || '')) return cal.color;
  return colorOf(accountId);
}
export const eventColor = (e) => calendarColor(e.accountId, calendarOf(e));

// Shown or hidden by the eye toggle: Settings keeps it (contracts d). Before it did, this computer kept it in
// localStorage; those choices are read for one more release, for calendars Settings doesn't know yet.
export function isVisible(accountId, cal) {
  const k = key(accountId, cal.id);
  const chosen = calSettings().visible;
  if (Object.hasOwn(chosen, k)) return chosen[k] !== false;
  if (Object.hasOwn(prefs.visible, k)) return prefs.visible[k] !== false;
  return typeof cal.visible === 'boolean' ? cal.visible : cal.selected !== false;
}

// "Counts toward availability": the choice in the sidebar menu, else main's resolved flag, else its default rule.
export function countsForAvailability(accountId, cal) {
  const k = key(accountId, cal.id);
  const chosen = calSettings().availability;
  if (Object.hasOwn(chosen, k)) return chosen[k] === true;
  if (typeof cal.availability === 'boolean') return cal.availability;
  return Boolean(cal.writable && (cal.primary || cal.owned));
}

// The full input calendarUpdate takes, from an event with some fields changed: drags, Undo and the dialog start
// here, so a change never blanks a field it didn't mean to touch. All-day events carry their dates too.
export function eventInput(e, changes = {}) {
  const v = {
    accountId: e.accountId,
    calendarId: e.calendarId,
    title: e.title || '',
    location: e.location || '',
    description: e.description || '',
    allDay: Boolean(e.allDay),
    start: e.start,
    end: e.end,
    ...changes
  };
  if (v.allDay) {
    v.startDate = dateValue(v.start);
    v.endDate = dateValue(v.end);
  } else {
    delete v.startDate;
    delete v.endDate;
  }
  return v;
}

export function events() {
  return ((C.data && C.data.events) || []).filter((e) => {
    const cal = calendarOf(e);
    return cal && isVisible(e.accountId, cal);
  });
}

export const byId = (id) => ((C.data && C.data.events) || []).find((e) => e.id === id) || null;

// The grid's own width decides, not the window's: a docked side panel takes room from it.
export function shownView() {
  if (prefs.view !== 'week') return prefs.view;
  const width = ($('.calendar .cal-body') || $('.calendar'))?.clientWidth || 0;
  return width && width < NARROW ? 'day' : 'week';
}

export function range(view = shownView()) {
  if (view === 'day') return { start: C.date, end: addDays(C.date, 1) };
  if (view === 'week') {
    const start = weekStart(C.date);
    return { start, end: addDays(start, 7) };
  }
  // The month's weeks, from the week its first day is in to the week of its last day.
  if (view === 'month') {
    const first = monthStart(C.date);
    const start = weekStart(first);
    const last = addDays(monthStart(addMonths(first, 1)), -1);
    return { start, end: addDays(start, 7 * (Math.floor(dayIndex(last, start) / 7) + 1)) };
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
