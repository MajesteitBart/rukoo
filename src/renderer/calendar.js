import { t, getLocale } from './i18n.js';
import { icons } from './icons.js';
import { api, esc, $, $$, hhmm, avatar, toast, segmented, setSegmented, showMenu, closeMenu, dialog, KEEP_OPEN, runToastAction } from './ui.js';
import {
  DAY,
  UPCOMING_DAYS,
  NARROW,
  prefs,
  savePrefs,
  C,
  ctx,
  setContext,
  hooks,
  calSettings,
  setCalSettings,
  clockMinutes,
  startOfDay,
  addDays,
  monthStart,
  addMonths,
  shownDays,
  weekStart,
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
  calendarColor,
  eventColor,
  isVisible,
  countsForAvailability,
  eventInput,
  events,
  byId,
  shownView,
  range,
  duration,
  fromNow
} from './calendar-shared.js';
import { newEvent, editEvent, removeEvent, openPop, closePop, followScroll, notifyGuests, seriesChoice } from './calendar-event.js';

// The calendar view: the calendars of every account together, as a day, a week, a month or a list of what comes
// next. Main fetches and caches the events (src/main/calendar); this module draws them and sends changes back.
// Each calendar has a colour: one picked in its sidebar menu, its provider's, or its account's.
// State, dates and lookups live in calendar-shared.js; the event card and the dialog in calendar-event.js.

// The grid: pixels per hour, and the least an event is drawn, so a short one still shows its title.
const HOUR = 56;
const MIN_EVENT = 20;
// Drags snap to quarters of an hour. A mouse press becomes a drag after a few pixels; a touch after holding still
// for LONG_PRESS, so a swipe still scrolls.
const SNAP = 15;
const SLOP = 4;
const TOUCH_SLOP = 8;
const LONG_PRESS = 300;
// The side panel's width beside the grid. Where the grid would get narrower than NARROW, it lies over the grid.
const PANEL_W = 340;
// The month: the row of a day's number and the row of each event in it, in pixels.
const MONTH_HEAD = 26;
const MONTH_ROW = 22;

// Calendar colours to pick from: tints of these read in both themes, like the account colours.
const PALETTE = [
  { value: '#ff5d73', get label() { return t('calendar.colors.red'); } },
  { value: '#ff8a3d', get label() { return t('calendar.colors.orange'); } },
  { value: '#f5c542', get label() { return t('calendar.colors.yellow'); } },
  { value: '#9fcf4a', get label() { return t('calendar.colors.lime'); } },
  { value: '#3fbf72', get label() { return t('calendar.colors.green'); } },
  { value: '#2fd6c0', get label() { return t('calendar.colors.turquoise'); } },
  { value: '#5ec2ff', get label() { return t('calendar.colors.lightBlue'); } },
  { value: '#4a7dff', get label() { return t('calendar.colors.blue'); } },
  { value: '#8a72f0', get label() { return t('calendar.colors.indigo'); } },
  { value: '#c56cf0', get label() { return t('calendar.colors.purple'); } },
  { value: '#f06cb4', get label() { return t('calendar.colors.pink'); } },
  { value: '#8a90a0', get label() { return t('calendar.colors.grey'); } }
];

// calendar-event.js loads the view again after a change through this.
hooks.reload = reload;

export { newEvent };

let loadTimer = null;
let loadSeq = 0;
// A load or a redraw asked for while a drag was on; they run when it ends.
let deferred = { load: false, render: false };

export function reload(ms = 60) {
  if (!C.open) return;
  clearTimeout(loadTimer);
  loadTimer = setTimeout(load, ms);
}

// What to fetch: what the view shows, and the mini month's six weeks for its dots while they lie close by.
function loadRange() {
  const r = range();
  const m = miniRange(miniMonth());
  const start = Math.min(r.start, m.start);
  const end = Math.max(r.end, m.end);
  return end - start <= 120 * DAY ? { start, end } : r;
}

async function load() {
  clearTimeout(loadTimer);
  if (C.drag) {
    deferred.load = true;
    return;
  }
  const seq = ++loadSeq;
  try {
    const data = await api('calendarView', loadRange());
    if (seq !== loadSeq || !C.open) return;
    if (C.drag) {
      deferred.load = true;
      return;
    }
    C.data = data;
    render();
    renderSide();
  } catch (err) {
    toast(err.message, 5000);
  }
}

// ---------- shell ----------

export function init(context) {
  setContext(context);
  migrateVisible();
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
  upgradeNotice();
}

export function hide() {
  C.open = false;
  abandonDrag();
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

// Sync now also fetches the booking page's news while the page is on (contracts k).
export async function syncNow() {
  toast(t('mailbox.sync.syncing'));
  let error = null;
  try {
    await api('calendarSync', null);
  } catch (err) {
    error = err;
  }
  if (C.booking?.status === 'on') api('bookingSync').catch(() => {});
  if (error) toast(error.message, 5000);
  else toast(t('mailbox.sync.done'));
}

// The eye toggles once lived in this computer's localStorage; Settings keeps them now (contracts d). They move over
// once, at start, so main sees the right calendars from the start. Until main keeps calendar settings, nothing moves
// and the next start tries again.
async function migrateVisible() {
  if (prefs.visibleMigrated || !Object.keys(prefs.visible || {}).length) return;
  try {
    const state = await api('state');
    const saved = state && state.settings && state.settings.calendar;
    if (!saved || Object.keys(saved.visible || {}).length) return;
    const visible = {};
    for (const [k, v] of Object.entries(prefs.visible)) if (typeof v === 'boolean') visible[k] = v;
    setCalSettings(await api('calendarSettings', { visible }));
    prefs.visibleMigrated = true;
    savePrefs();
  } catch (_) {
    // Main can't keep them yet.
  }
}

// Once, after the upgrade that brought reminders: a notice that Rukoo reminds you now, until it is dismissed or used.
let upgradeChecked = false;
function upgradeNotice() {
  const s = ctx.S.data?.settings?.calendar;
  if (upgradeChecked || !s) return;
  upgradeChecked = true;
  if (!s.notify || s.notifiedUpgrade) return;
  const done = () => {
    setNotices('reminders', []);
    api('calendarSettings', { notifiedUpgrade: true })
      .then(setCalSettings)
      .catch(() => {});
  };
  setNotices('reminders', [
    {
      id: 'remindersNew',
      tone: 'info',
      get title() {
        return t('calendar.notices.remindersTitle');
      },
      get text() {
        return t('calendar.notices.remindersNew');
      },
      actions: [
        { get label() { return t('calendar.notices.dismiss'); }, run: done },
        {
          get label() { return t('calendar.notices.openSettings'); },
          primary: true,
          run: () => {
            done();
            ctx.openSettings('calendar');
          }
        }
      ]
    }
  ]);
}

// ---------- for other parts of the app ----------

// Opens an event's card, from a reminder, a notification or a search result. With its start the view first goes
// to that day; an event outside what is loaded is fetched on its own.
export async function openEvent(id, start) {
  if (typeof id !== 'string' || !id) return;
  closePop();
  if (C.search) {
    C.search = null;
    C.scroll = true;
  }
  if (Number.isFinite(start)) {
    C.date = startOfDay(start);
    C.mini = null;
    if (prefs.view === 'upcoming') {
      const r = range('upcoming');
      if (start < r.start || start >= r.end) {
        prefs.view = 'day';
        savePrefs();
      }
    }
  }
  if (!C.open) return;
  await load();
  let e = byId(id);
  if (!e) {
    e = await api('calendarEvent', id).catch(() => null);
    if (!e) {
      toast(t('calendar.nav.notFound'), 5000);
      return;
    }
    if (C.data) C.data.events.push(e);
  }
  const anchor = $(`.calendar [data-ev="${CSS.escape(id)}"]`);
  anchor?.scrollIntoView({ block: 'nearest' });
  openPop(e, anchor || $('.calendar .cal-title'), { focus: true });
}

// Opens a booking request's card next to its block on the grid (calendar-event.js draws the card).
export async function openRequest(bookingId) {
  const req = pendingRequests().find((r) => r.id === bookingId);
  if (req) {
    C.date = startOfDay(req.start);
    C.mini = null;
    if (prefs.view === 'upcoming') {
      prefs.view = 'day';
      savePrefs();
    }
    if (C.open) await load();
  }
  const anchor = $(`.calendar [data-request="${CSS.escape(String(bookingId))}"]`) || $('.calendar .cal-title');
  if (hooks.openRequest && anchor) hooks.openRequest(String(bookingId), anchor);
}

// Open time to show on the grid while the availability panel is open: [[start, end], ...], or null for none.
export function setHighlight(intervals) {
  C.highlight = Array.isArray(intervals) ? intervals.filter((i) => Array.isArray(i) && i[1] > i[0]) : null;
  if (C.open) render();
}

// Notices above the calendar from another part of the app, such as the booking page's. A source replaces its own.
export function setNotices(source, list) {
  if (Array.isArray(list) && list.length) C.notices[String(source)] = list;
  else delete C.notices[String(source)];
  if (C.open) render();
}

// The booking page's state: its requests show on the grid and as a count on the mode switch.
export function setBooking(state) {
  C.booking = state && typeof state === 'object' ? state : null;
  if (C.open) render();
  if (ctx?.S?.data) renderSide();
}

export function requestCount() {
  return pendingRequests().length;
}

function pendingRequests() {
  const list = C.booking && Array.isArray(C.booking.requests) ? C.booking.requests : [];
  return list.filter((r) => r && r.status === 'pending' && Number.isFinite(r.start) && Number.isFinite(r.end) && r.end > r.start);
}

// An event made through the booking page, while the page is on, for a booking the page still has (contracts k). An
// event from before the page was last turned on keeps its bookingId but is a plain event, as its card says.
const isBooked = (e) =>
  Boolean(e.bookingId && C.booking && C.booking.status === 'on' && Array.isArray(C.booking.bookings) && C.booking.bookings.some((b) => b && b.id === e.bookingId));
const bookingMark = (e) => (isBooked(e) ? `<span class="cal-mark" title="${esc(t('calendar.requests.booked'))}">${icons.booking}</span>` : '');

// ---------- side panel ----------

// A panel beside the grid, such as the availability panel (hooks.panels.free, registered by calendar-free.js). The
// grid keeps at least NARROW pixels; where it can't, the panel lies over it as a sheet.
export function openPanel(name, { focus = false } = {}) {
  const panel = hooks.panels[name];
  if (!panel) return;
  if (C.panel && C.panel !== name) closePanel();
  C.panel = name;
  closePop();
  // The panel takes its room first, so the grid draws at the width it has left. A toolbar built now mounts it.
  if ($('.calendar .cal-head')) mountPanel();
  render();
  if (focus) $('.calendar .cal-panel-body')?.querySelector('button, input, select, textarea, [tabindex="0"]')?.focus();
}

export function closePanel({ refocus = false } = {}) {
  if (!C.panel) return;
  const panel = hooks.panels[C.panel];
  C.panel = null;
  try {
    panel?.close();
  } catch (err) {
    console.error(err);
  }
  const host = $('.calendar .cal-panel');
  if (host) {
    host.hidden = true;
    host.innerHTML = '';
  }
  C.highlight = null;
  render();
  if (refocus) $('.calendar [data-cal-panel]')?.focus();
}

function mountPanel() {
  const host = $('.calendar .cal-panel');
  const panel = C.panel && hooks.panels[C.panel];
  if (!host || !panel) return;
  host.hidden = false;
  host.innerHTML = `<div class="cal-panel-head"><h2>${esc(panel.title())}</h2>
    <button class="icon-btn sm" data-cal="panel-close" title="${esc(t('common.actions.close'))}">${icons.close}</button></div>
    <div class="cal-panel-body"></div>`;
  layoutPanel();
  try {
    panel.render(host.querySelector('.cal-panel-body'));
  } catch (err) {
    console.error(err);
  }
}

function layoutPanel() {
  const host = $('.calendar .cal-panel');
  if (!host || !C.panel) return;
  host.classList.toggle('sheet', $('.calendar').clientWidth - PANEL_W < NARROW);
}

// ---------- sidebar ----------

function renderSide() {
  ctx.renderSidebar();
}

// app.js redraws the sidebar as a whole, after this module's changes and after its own updates. The keyboard stays
// where it was: on the mini month, a calendar or its menu button. sidebarHtml() runs just before the old buttons go,
// so it notes the one with the focus and puts the focus on its new copy once the redraw is done.
function keepSideFocus() {
  const el = document.activeElement;
  if (!el || !el.closest || !el.closest('.sidebar .sidebar-main')) return;
  let selector = null;
  if (el.closest('.cal-mini')) selector = el.dataset.mini ? `[data-mini="${el.dataset.mini}"]` : '.cal-mini [data-mini-day][tabindex="0"]';
  else if (el.dataset.calToggle) selector = `[data-cal-toggle="${CSS.escape(el.dataset.calToggle)}"]`;
  else if (el.dataset.calMenu) selector = `[data-cal-menu="${CSS.escape(el.dataset.calMenu)}"]`;
  if (!selector) return;
  queueMicrotask(() => {
    if (document.contains(el)) return;
    if (document.activeElement && document.activeElement !== document.body) return;
    $(`.sidebar ${selector}`)?.focus({ preventScroll: true });
  });
}

export function sidebarHtml() {
  keepSideFocus();
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
            const k = esc(key(a.id, cal.id));
            return `<div class="cal-side-row"><button class="nav-item cal-toggle" role="checkbox" aria-checked="${on}" data-cal-toggle="${k}" title="${esc(cal.name)}"><span class="ic"><span class="cal-check ${on ? 'on' : ''}" style="--c:${calendarColor(a.id, cal)}">${icons.check}</span></span><span class="label">${esc(cal.name)}</span></button><button class="icon-btn xs cal-side-more" data-cal-menu="${k}" aria-haspopup="menu" title="${esc(t('calendar.sidebar.options', { name: cal.name }))}">${icons.more}</button></div>`;
          })
          .join('')
      );
    })
    .join('');
  return `<button class="btn compose-btn" data-cal="new" title="${esc(t('calendar.event.newShortcut'))}">${icons.calendarPlus}<span>${esc(t('calendar.event.new'))}</span></button>
    ${sideMiniHtml()}
    <nav class="nav" aria-label="${esc(t('calendar.sidebar.calendars'))}">${rows}</nav>`;
}

// Handles a click in the sidebar; false when the button isn't the calendar's.
export function sidebarClick(btn) {
  if (btn.dataset.cal === 'new') {
    newEvent();
    return true;
  }
  if (btn.dataset.miniDay) {
    pickDay(Number(btn.dataset.miniDay));
    return true;
  }
  if (btn.dataset.mini) {
    C.mini = addMonths(miniMonth(), btn.dataset.mini === 'next' ? 1 : -1);
    C.miniFocus = null;
    drawSideMini(`[data-mini="${btn.dataset.mini}"]`);
    reload();
    return true;
  }
  if (btn.dataset.calMenu) {
    calendarMenu(btn.dataset.calMenu, btn);
    return true;
  }
  if (btn.dataset.calToggle) {
    const k = btn.dataset.calToggle;
    const [accountId, calendarId] = k.split('\n');
    const cal = account(accountId)?.calendars.find((c) => c.id === calendarId);
    if (!cal) return true;
    const on = !isVisible(accountId, cal);
    // Settings keeps the choice; this computer's copy serves until main can keep it.
    prefs.visible[k] = on;
    savePrefs();
    const saved = ctx.S.data?.settings?.calendar;
    if (saved && typeof saved === 'object') saved.visible = { ...(saved.visible || {}), [k]: on };
    api('calendarSettings', { visible: { [k]: on } })
      .then(setCalSettings)
      .catch(() => {});
    closePop();
    render();
    renderSide();
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

// A calendar's menu, from its ⋯ button or a right click: its colour and whether it counts toward availability.
function calendarMenu(k, anchor, at = null) {
  const [accountId, calendarId] = k.split('\n');
  const cal = account(accountId)?.calendars.find((c) => c.id === calendarId);
  if (!cal) return;
  const picked = /^#[0-9a-f]{6}$/i.test(calSettings().colors[k] || '');
  const color = calendarColor(accountId, cal).toLowerCase();
  const counts = countsForAvailability(accountId, cal);
  // The ⋯ button says its menu is open, and stays in sight meanwhile.
  const button = anchor && anchor.dataset.calMenu ? anchor : null;
  button?.setAttribute('aria-expanded', 'true');
  // Someone else's calendar, or one subscribed to, counts only when the user turns it on, knowing what that does.
  const shared = cal.owned === false && !cal.primary;
  showMenu(
    anchor,
    [
      { heading: cal.name },
      { separator: true },
      { label: t('calendar.colors.default'), disabled: !picked, action: () => saveCalendarSettings({ colors: { [k]: null } }, k) },
      { separator: true },
      {
        label: t('calendar.sidebar.availability'),
        sub: shared ? t('calendar.sidebar.availabilityShared') : undefined,
        checked: counts,
        action: () => saveCalendarSettings({ availability: { [k]: !counts } }, k)
      }
    ],
    at ? { at } : { align: 'left' }
  );
  const menu = $('.menu');
  if (!menu) return;
  if (shared) menu.querySelector('[role="menuitemcheckbox"]')?.classList.add('cal-menu-note');
  // The palette sits under the calendar's name. The arrow keys reach its swatches like the rows below it.
  const swatches = document.createElement('div');
  swatches.className = 'cal-swatches';
  swatches.setAttribute('role', 'group');
  swatches.setAttribute('aria-label', t('calendar.colors.heading'));
  swatches.innerHTML = PALETTE.map(
    (c) =>
      `<button class="cal-swatch-btn" role="menuitemradio" aria-checked="${c.value === color}" data-color="${c.value}" style="--c:${c.value}" title="${esc(c.label)}" aria-label="${esc(c.label)}">${c.value === color ? icons.check : ''}</button>`
  ).join('');
  menu.querySelector('.menu-heading')?.after(swatches);
  placeMenu(menu, anchor, at);
  swatches.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-color]');
    if (!b) return;
    ev.stopPropagation();
    closeMenu();
    saveCalendarSettings({ colors: { [k]: b.dataset.color } }, k);
  });
  // Left and right walk the swatches; up and down go on through the menu as usual.
  swatches.addEventListener('keydown', (ev) => {
    if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;
    const all = [...swatches.querySelectorAll('button')];
    const i = all.indexOf(document.activeElement);
    if (i < 0) return;
    ev.preventDefault();
    all[(i + (ev.key === 'ArrowRight' ? 1 : -1) + all.length) % all.length].focus();
  });
  (swatches.querySelector('[aria-checked="true"]') || swatches.querySelector('button'))?.focus();
  // The anchor loses its open state when the menu goes, however it goes.
  const observer = new MutationObserver(() => {
    if (document.contains(menu)) return;
    observer.disconnect();
    button?.removeAttribute('aria-expanded');
  });
  observer.observe(document.body, { childList: true });
}

// showMenu() measured the menu before the swatches made it taller. It goes in again the way showMenu places it:
// below the button or at the click, else above it, else as low as the window allows, and it scrolls when it is
// taller than the window.
function placeMenu(menu, anchor, at) {
  menu.classList.remove('scrolls');
  menu.style.maxHeight = '';
  const height = menu.offsetHeight;
  const room = window.innerHeight - 8;
  const r = at ? null : anchor.getBoundingClientRect();
  let top = at ? at.y : r.bottom + 4;
  let above = false;
  if (top + height > room) {
    const flipped = at ? at.y - height : r.top - height - 6;
    above = flipped >= 8;
    top = above ? flipped : Math.max(8, room - height);
  }
  menu.style.top = `${top}px`;
  menu.style.transformOrigin = `${above ? 'bottom' : 'top'} left`;
  if (top + height > room) {
    menu.style.maxHeight = `${room - top}px`;
    menu.classList.add('scrolls');
  }
}

async function saveCalendarSettings(patch, k = null) {
  try {
    setCalSettings(await api('calendarSettings', patch));
  } catch (err) {
    toast(err.message, 5000);
    return false;
  }
  render();
  renderSide();
  if (k && !document.activeElement?.closest?.('.calendar, .menu, .scrim')) $(`.sidebar [data-cal-toggle="${CSS.escape(k)}"]`)?.focus({ preventScroll: true });
  return true;
}

// ---------- mini month ----------

// The month the mini month shows, and its six weeks.
const miniMonth = () => C.mini ?? monthStart(C.date);
function miniRange(month) {
  const start = weekStart(month);
  return { start, end: addDays(start, 42) };
}

// The days with an event on a shown calendar, between start and end.
function eventDays(start, end) {
  const out = new Set();
  for (const e of events()) {
    if (e.end <= e.start) {
      out.add(startOfDay(e.start));
      continue;
    }
    for (let d = Math.max(startOfDay(e.start), start); d < Math.min(e.end, end); d = addDays(d, 1)) out.add(d);
  }
  return out;
}

// Six weeks of a month as buttons; one of them takes the Tab stop and the arrow keys move it (roving tabindex).
function miniHtml({ month, focus, selected = null, span = null, dots = null, nav = true }) {
  const { start } = miniRange(month);
  const days = Array.from({ length: 42 }, (_, i) => addDays(start, i));
  const today = startOfDay(Date.now());
  const m = new Date(month).getMonth();
  const title = cap(fmt(month, { month: 'long', year: 'numeric' }));
  const names = days
    .slice(0, 7)
    .map((d) => `<span class="cal-mini-dow" aria-hidden="true">${esc(fmt(d, { weekday: 'narrow' }))}</span>`)
    .join('');
  const cells = days
    .map((d) => {
      const cls = [new Date(d).getMonth() !== m ? 'out' : '', d === today ? 'today' : '', d === selected ? 'sel' : '', span && d >= span.start && d < span.end ? 'span' : '', dots && dots.has(d) ? 'dot' : '']
        .filter(Boolean)
        .join(' ');
      return `<button class="cal-mini-day ${cls}" data-mini-day="${d}" tabindex="${d === focus ? 0 : -1}" aria-label="${esc(longDay(d))}" ${d === today ? 'aria-current="date"' : ''}>${esc(fmt(d, { day: 'numeric' }))}</button>`;
    })
    .join('');
  const arrows = nav
    ? `<button class="icon-btn xs" data-mini="prev" title="${esc(t('calendar.mini.prev'))}">${icons.chevronLeft}</button><button class="icon-btn xs" data-mini="next" title="${esc(t('calendar.mini.next'))}">${icons.chevronRight}</button>`
    : '';
  return `<div class="cal-mini-head"><span class="cal-mini-title">${esc(title)}</span>${arrows}</div>
    <div class="cal-mini-grid" role="group" aria-label="${esc(title)}">${names}${cells}</div>`;
}

// The day that holds the mini month's Tab stop: the one the keyboard was on, else the view's day, else the 1st.
function miniFocus(month, selected) {
  const { start, end } = miniRange(month);
  const next = monthStart(addMonths(month, 1));
  if (C.miniFocus >= start && C.miniFocus < end) return C.miniFocus;
  if (selected >= month && selected < next) return selected;
  return month;
}

function sideMiniHtml() {
  const month = miniMonth();
  const { start, end } = miniRange(month);
  const view = shownView();
  const selected = view === 'upcoming' ? null : C.date;
  const span = view === 'day' || view === 'week' ? range(view) : null;
  return `<div class="cal-mini" data-cal-mini>${miniHtml({ month, focus: miniFocus(month, selected), selected, span, dots: eventDays(start, end) })}</div>`;
}

// Redraws only the mini month, so the keyboard stays on it; focus: what to put the keyboard on afterwards.
function drawSideMini(focus = null) {
  const box = $('.sidebar .cal-mini');
  if (!box) return;
  const wrap = document.createElement('div');
  wrap.innerHTML = sideMiniHtml();
  box.innerHTML = wrap.firstElementChild.innerHTML;
  if (focus) box.querySelector(focus)?.focus({ preventScroll: true });
}

// Where an arrow key, Page Up or Down, Home or End moves the mini month's focus from day; null for other keys.
function miniStep(ev, day) {
  switch (ev.key) {
    case 'ArrowLeft':
      return addDays(day, -1);
    case 'ArrowRight':
      return addDays(day, 1);
    case 'ArrowUp':
      return addDays(day, -7);
    case 'ArrowDown':
      return addDays(day, 7);
    case 'PageUp':
      return addMonths(day, -1);
    case 'PageDown':
      return addMonths(day, 1);
    case 'Home':
      return weekStart(day);
    case 'End':
      return addDays(weekStart(day), 6);
    default:
      return null;
  }
}

function sideMiniKey(ev) {
  const day = Number(ev.target.dataset.miniDay);
  const next = miniStep(ev, day);
  if (next === null) return false;
  const month = monthStart(next);
  const moved = month !== miniMonth();
  C.miniFocus = next;
  if (moved) C.mini = month;
  drawSideMini(`[data-mini-day="${next}"]`);
  // Another month needs its dots.
  if (moved) reload();
  return true;
}

function pickDay(day) {
  closePop();
  C.search = null;
  C.date = startOfDay(day);
  C.mini = null;
  C.miniFocus = C.date;
  C.scroll = true;
  if (prefs.view === 'upcoming') return setView('day');
  load();
}

// Go to date: G or a click on the title. A date field and a month to pick from.
async function goToDate() {
  closePop();
  let month = monthStart(C.date);
  let focus = C.date;
  const picked = await dialog({
    title: t('calendar.goto.title'),
    buttons: [
      { label: t('common.actions.cancel'), value: null },
      {
        label: t('calendar.goto.show'),
        primary: true,
        value: (scrim) => {
          const v = scrim.querySelector('[name="date"]').value;
          if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) {
            scrim.querySelector('[data-error]').textContent = t('calendar.goto.invalid');
            return KEEP_OPEN;
          }
          return parseLocal(v);
        }
      }
    ],
    render(body, done) {
      body.innerHTML = `<div class="form cal-goto">
        <label>${esc(t('calendar.goto.date'))}<input type="date" name="date" value="${dateValue(C.date)}"/></label>
        <div class="cal-mini"></div><div class="error" data-error></div></div>`;
      const input = body.querySelector('[name="date"]');
      const box = body.querySelector('.cal-mini');
      const draw = (focusIt = false) => {
        box.innerHTML = miniHtml({ month, focus, selected: C.date, dots: null });
        if (focusIt) box.querySelector('[tabindex="0"]')?.focus();
      };
      draw();
      box.addEventListener('click', (ev) => {
        const b = ev.target.closest('button');
        if (!b) return;
        if (b.dataset.miniDay) return done(Number(b.dataset.miniDay));
        month = addMonths(month, b.dataset.mini === 'next' ? 1 : -1);
        focus = month;
        draw();
        box.querySelector(`[data-mini="${b.dataset.mini}"]`)?.focus();
      });
      box.addEventListener('keydown', (ev) => {
        if (!ev.target.dataset.miniDay) return;
        const next = miniStep(ev, Number(ev.target.dataset.miniDay));
        if (next === null) return;
        ev.preventDefault();
        focus = next;
        month = monthStart(next);
        input.value = dateValue(next);
        draw(true);
      });
      input.addEventListener('change', () => {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(input.value)) return;
        focus = parseLocal(input.value);
        month = monthStart(focus);
        draw();
      });
      input.addEventListener('keydown', (ev) => {
        if (ev.key !== 'Enter') return;
        ev.preventDefault();
        body.closest('.dialog').querySelector('.buttons button.primary')?.click();
      });
    }
  });
  if (picked === null || picked === undefined) return;
  pickDay(picked);
}

// ---------- drawing ----------

function headHtml(view) {
  const r = range(view);
  let title = t('calendar.views.upcoming');
  if (view === 'day') title = cap(fmt(r.start, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }));
  if (view === 'week') {
    const days = shownDays(r.start);
    title = cap(new Intl.DateTimeFormat(getLocale(), { month: 'long', year: 'numeric' }).formatRange(new Date(days[0]), new Date(days[days.length - 1])));
  }
  if (view === 'month') title = cap(fmt(monthStart(C.date), { month: 'long', year: 'numeric' }));
  const step = view === 'day' ? 'day' : view === 'month' ? 'month' : 'week';
  const nav =
    view === 'upcoming'
      ? ''
      : `<button class="tbtn" data-cal="today" title="${esc(t('calendar.nav.todayShortcut'))}">${esc(t('calendar.nav.today'))}</button>
        <button class="icon-btn sm" data-cal="prev" title="${esc(t(`calendar.nav.prev.${step}`))}">${icons.chevronLeft}</button>
        <button class="icon-btn sm" data-cal="next" title="${esc(t(`calendar.nav.next.${step}`))}">${icons.chevronRight}</button>`;
  const busy = accounts().some((a) => a.loading);
  return `<div class="cal-nav">${nav}</div>
    <h1 class="cal-heading"><button class="cal-title" data-cal="goto" aria-haspopup="dialog" title="${esc(t('calendar.goto.shortcut'))}">${esc(title)}</button></h1>
    <span class="cal-busy" ${busy ? '' : 'hidden'} title="${esc(t('mailbox.sync.syncing'))}"><span class="spinner"></span></span>`;
}

function searchFieldHtml() {
  return `<div class="cal-search" role="search">
    <span class="s-ic">${icons.search}</span>
    <input type="search" name="cal-search" autocomplete="off" spellcheck="false" placeholder="${esc(t('calendar.search.placeholder'))}" aria-label="${esc(t('calendar.search.placeholder'))}" value="${esc(C.search.query)}"/>
    <button class="icon-btn xs" data-cal="search-close" title="${esc(t('calendar.search.close'))}">${icons.close}</button></div>`;
}

function viewSwitch() {
  return segmented({
    name: 'cal-view',
    label: t('calendar.views.label'),
    value: prefs.view,
    options: [
      { value: 'day', label: t('calendar.views.day'), title: t('calendar.views.dayShortcut') },
      { value: 'week', label: t('calendar.views.week'), title: t('calendar.views.weekShortcut') },
      { value: 'month', label: t('calendar.views.month'), title: t('calendar.views.monthShortcut') },
      { value: 'upcoming', label: t('calendar.views.upcoming'), title: t('calendar.views.upcomingShortcut') }
    ]
  });
}

// Notices above the calendar: accounts that can show their calendar after signing in again, fetch errors, and the
// notices other parts of the app set (setNotices). Without Google sign-in on this PC there is nothing to reconnect
// with; the sidebar row still explains that.
function noticesHtml() {
  const canSignIn = Boolean(ctx.S.data && ctx.S.data.googleAvailable);
  const own = accounts()
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
  const others = Object.entries(C.notices)
    .flatMap(([source, list]) =>
      list.map((n, i) => {
        const tone = n.tone === 'error' ? 'error' : n.tone === 'warn' ? 'warn' : '';
        const actions = (n.actions || [])
          .map((a, j) => `<button class="btn sm ${a.primary ? 'primary' : ''}" data-cal-notice="${esc(source)}" data-i="${i}" data-j="${j}">${esc(a.label)}</button>`)
          .join('');
        return `<div class="cal-notice ${tone}" role="status"><span class="ic">${tone ? icons.info : icons.bell}</span>
          <div class="text"><div class="t">${esc(n.title)}</div><div class="d">${esc(n.text)}</div></div>${actions}</div>`;
      })
    )
    .join('');
  return own + others;
}

function render() {
  if (C.drag) {
    deferred.render = true;
    return;
  }
  const el = $('.calendar');
  if (!el) return;
  if (!el.querySelector('.cal-head')) {
    el.innerHTML = `<div class="cal-head"><div class="cal-head-main"></div><span class="spacer"></span>
        <div class="cal-head-side"><div class="cal-tools">
          <button class="icon-btn" data-cal="search" aria-pressed="false" title="${esc(t('calendar.search.open'))}">${icons.search}</button>
          <button class="icon-btn" data-cal-panel="free" aria-pressed="false" hidden>${icons.clock}</button>
        </div>${viewSwitch()}
        <button class="icon-btn" data-cal="sync" title="${esc(t('calendar.sync.shortcut'))}">${icons.sync}</button></div></div>
      <div class="cal-notices"></div>
      <div class="cal-main"><div class="cal-body"></div><aside class="cal-panel" hidden></aside></div>`;
    if (C.panel) mountPanel();
  }
  layoutPanel();
  const view = shownView();
  renderHead(el, view);
  el.querySelector('.cal-notices').innerHTML = noticesHtml();
  renderBody(view);
}

function renderHead(el, view) {
  const head = el.querySelector('.cal-head');
  const main = head.querySelector('.cal-head-main');
  head.classList.toggle('searching', Boolean(C.search));
  if (!C.search) main.innerHTML = headHtml(view);
  else if (!main.querySelector('.cal-search')) {
    main.innerHTML = searchFieldHtml();
    bindSearchField(main.querySelector('input'));
  }
  setSegmented(head.querySelector('.segmented'), prefs.view);
  const search = head.querySelector('[data-cal="search"]');
  search.classList.toggle('on', Boolean(C.search));
  search.setAttribute('aria-pressed', String(Boolean(C.search)));
  const button = head.querySelector('[data-cal-panel="free"]');
  const panel = hooks.panels.free;
  button.hidden = !panel;
  if (panel) {
    button.title = t('calendar.nav.panelShortcut', { title: panel.title() });
    button.setAttribute('aria-label', panel.title());
    button.classList.toggle('on', C.panel === 'free');
    button.setAttribute('aria-pressed', String(C.panel === 'free'));
  }
}

function renderBody(view = shownView()) {
  const body = $('.calendar .cal-body');
  if (!body) return;
  const kind = C.search ? 'search' : view;
  const old = body.querySelector('.cal-scroll');
  const top = old && body.dataset.kind === kind ? old.scrollTop : 0;
  if (body.dataset.kind !== kind && kind !== 'search') C.scroll = true;
  body.dataset.kind = kind;
  // A redraw (a sync, a change) keeps the keyboard on the event it was on.
  const focused = body.contains(document.activeElement) ? document.activeElement.dataset.ev || document.activeElement.dataset.searchEv : null;
  if (C.search) body.innerHTML = searchHtml();
  else if (!accounts().length && C.data) {
    body.innerHTML = `<div class="empty">${icons.calendar}<div class="t">${esc(t('calendar.empty.title'))}</div><div class="h">${esc(t('calendar.empty.help'))}</div></div>`;
  } else body.innerHTML = view === 'upcoming' ? listHtml() : view === 'month' ? monthHtml(body) : gridHtml(view);
  const scroll = body.querySelector('.cal-scroll');
  if (scroll) {
    if (C.scroll && !C.search) scroll.scrollTop = workingDayTop(view, scroll.clientHeight);
    else scroll.scrollTop = top;
    scroll.addEventListener('scroll', () => followScroll(scroll), { passive: true });
  }
  if (!C.search) C.scroll = false;
  if (focused) body.querySelector(`[data-ev="${CSS.escape(focused)}"], [data-search-ev="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
  if (C.pop) {
    const e = byId(C.pop);
    const places = e ? body.querySelectorAll(`[data-ev="${CSS.escape(e.id)}"]`) : [];
    const anchor = places[C.popIndex] || places[0];
    if (e && anchor) openPop(e, anchor, { focus: false });
    else closePop();
  }
}

// Where the grid opens: an hour and a half before the working day starts.
// The month and the Upcoming list open at their top.
function workingDayTop(view, height) {
  if (view !== 'day' && view !== 'week') return 0;
  const r = range(view);
  const now = Date.now();
  const start = (Math.max(0, clockMinutes(calSettings().workStart, 540) - 90) * HOUR) / 60;
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
  if (isBooked(e)) parts.push(t('calendar.requests.booked'));
  return parts.filter(Boolean).join(', ');
}

function requestLabel(r) {
  const when = whenText({ start: r.start, end: r.end, allDay: false });
  const name = r.guest && r.guest.name ? r.guest.name : '';
  return name ? t('calendar.requests.ariaNamed', { name, when }) : t('calendar.requests.aria', { when });
}

// Timed events of at least a day sit with the all-day events, as in Google Calendar.
const inAllDayRow = (e) => e.allDay || e.end - e.start >= DAY;

// Events laid out over a row of day columns (the all-day row, a week of the month): each on the first row where
// its days are free. from and to are column numbers; with weekends hidden an event can skip columns.
function spanLayout(list, columns, order) {
  const rows = [];
  const placed = [];
  const first = columns[0];
  const index = columns.map((d) => dayIndex(d, first));
  for (const e of [...list].sort(order)) {
    const a = dayIndex(e.start, first);
    const b = dayIndex(Math.max(e.start, e.end - 1), first);
    const from = index.findIndex((i) => i >= a);
    let to = -1;
    for (let i = index.length - 1; i >= 0; i--) {
      if (index[i] <= b) {
        to = i;
        break;
      }
    }
    if (from < 0 || to < from) continue;
    let row = rows.findIndex((taken) => taken.every(([x, y]) => to < x || from > y));
    if (row < 0) {
      row = rows.length;
      rows.push([]);
    }
    rows[row].push([from, to]);
    placed.push({ e, from, to, row });
  }
  return { placed, rows: rows.length };
}

const byStart = (a, b) => a.start - b.start || b.end - b.start - (a.end - a.start);

function gridHtml(view) {
  const r = range(view);
  const columns = view === 'day' ? [r.start] : shownDays(r.start);
  const days = columns.length;
  const last = addDays(columns[days - 1], 1);
  const list = events();
  const today = startOfDay(Date.now());
  const head = columns
    .map(
      (d) =>
        `<button class="cal-dayhead ${d === today ? 'today' : ''}" data-cal-day="${d}" title="${esc(longDay(d))}"><span class="dow">${esc(fmt(d, { weekday: 'short' }))}</span><span class="dom">${esc(fmt(d, { day: 'numeric' }))}</span></button>`
    )
    .join('');
  const { placed, rows } = spanLayout(list.filter(inAllDayRow), columns, byStart);
  const chips = placed
    .map(({ e, from, to, row }) => {
      const cls = [stateClass(e), e.start < columns[from] ? 'cont-l' : '', e.end > addDays(columns[to], 1) ? 'cont-r' : '', e.canEdit ? 'drag' : ''].join(' ');
      return `<button class="cal-chip ${cls}" data-ev="${esc(e.id)}" style="grid-column:${from + 2} / span ${to - from + 1};grid-row:${row + 1};--c:${eventColor(e)}" aria-label="${esc(ariaLabel(e))}">${bookingMark(e)}<span class="t">${esc(e.allDay ? titleOf(e) : `${hhmm(e.start)} ${titleOf(e)}`)}</span></button>`;
    })
    .join('');
  const cells = columns.map((d, i) => `<div class="cal-allday-cell" data-cal-allday="${d}" style="grid-column:${i + 2};grid-row:1 / span ${Math.max(rows, 1)}"></div>`).join('');
  const hours = Array.from({ length: 23 }, (_, i) => `<div class="cal-hour" style="top:${(i + 1) * HOUR}px"><span>${esc(hhmm(new Date(2000, 0, 1, i + 1).getTime()))}</span></div>`).join('');
  const timed = list.filter((e) => !inAllDayRow(e));
  const requests = pendingRequests().filter((q) => q.start < last && q.end > columns[0]);
  const work = workHours();
  const cols = columns
    .map((d) => {
      const blocks = layoutDay(segments(timed, d).concat(requestSegments(requests, d)))
        .map((s) => (s.req ? requestHtml(s) : eventHtml(s)))
        .join('');
      const now = d === today ? `<div class="cal-now" style="top:${(minutes(Date.now()) * HOUR) / 60}px"></div>` : '';
      return `<div class="cal-col ${d === today ? 'today' : ''}" data-cal-col="${d}">${offHtml(d, work)}${highlightHtml(d)}${blocks}${now}</div>`;
    })
    .join('');
  return `<div class="cal-grid-wrap" style="--days:${days}">
    <div class="cal-days"><div class="cal-gutter"></div>${head}</div>
    <div class="cal-allday" style="--rows:${Math.max(rows, 1)}"><div class="cal-gutter cal-allday-label">${esc(t('calendar.event.allDay'))}</div>${cells}${chips}</div>
    <div class="cal-scroll"><div class="cal-grid" style="height:${24 * HOUR}px"><div class="cal-hours">${hours}</div>${cols}</div></div>
  </div>`;
}

// Working hours from Settings → Calendar, in minutes; the grid shades the rest.
function workHours() {
  const s = calSettings();
  const start = clockMinutes(s.workStart, 540);
  const end = clockMinutes(s.workEnd, 1020);
  return { days: new Set(s.workDays), start, end: end > start ? end : 1440 };
}

function offHtml(day, work) {
  const px = (m) => (m * HOUR) / 60;
  if (!work.days.has(new Date(day).getDay())) return `<div class="cal-off" style="top:0;height:${px(1440)}px"></div>`;
  let out = '';
  if (work.start > 0) out += `<div class="cal-off" style="top:0;height:${px(work.start)}px"></div>`;
  if (work.end < 1440) out += `<div class="cal-off" style="top:${px(work.end)}px;height:${px(1440 - work.end)}px"></div>`;
  return out;
}

// The open time the availability panel found, in this day's column.
function highlightHtml(day) {
  if (!C.highlight) return '';
  const next = addDays(day, 1);
  return C.highlight
    .filter(([s, e]) => s < next && e > day)
    .map(([s, e]) => {
      const top = s <= day ? 0 : minutes(s);
      const bottom = e >= next ? 1440 : minutes(e);
      return `<div class="cal-hl" style="top:${(top * HOUR) / 60}px;height:${((bottom - top) * HOUR) / 60}px"></div>`;
    })
    .join('');
}

// The part of each timed event that falls on one day, in minutes from midnight.
function segments(list, day) {
  const next = addDays(day, 1);
  const out = [];
  for (const e of list) {
    if (e.start >= next || e.end <= day) continue;
    const top = e.start <= day ? 0 : minutes(e.start);
    const bottom = e.end >= next ? 1440 : minutes(e.end);
    out.push({ e, top, bottom: Math.max(bottom, top), endsHere: e.end <= next });
  }
  return out;
}

function requestSegments(list, day) {
  const next = addDays(day, 1);
  return list
    .filter((r) => r.start < next && r.end > day)
    .map((req) => {
      const top = req.start <= day ? 0 : minutes(req.start);
      const bottom = req.end >= next ? 1440 : minutes(req.end);
      return { req, top, bottom: Math.max(bottom, top) };
    });
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

function blockBox(s) {
  const top = (s.top * HOUR) / 60 + 1;
  const height = Math.max(((s.bottom - s.top) * HOUR) / 60, MIN_EVENT) - 3;
  const left = (s.col / s.cols) * 100;
  const width = (s.span / s.cols) * 100;
  return { top, height, style: `top:${top}px;height:${height}px;left:calc(${left}% + 3px);width:calc(${width}% - 6px)` };
}

// An event in the grid: a card a pixel inside its slot and a few pixels in from the day's edges, so neighbours
// and back-to-back events stay apart without borders. One that can change has a handle on its bottom edge.
function eventHtml(s) {
  const e = s.e;
  const { height, style } = blockBox(s);
  // Two lines need 42px; below that the title and start time share one.
  const short = height < 42;
  const time = short ? `<span class="w">${esc(hhmm(e.start))}</span>` : `<span class="w">${icons.clock}<span>${esc(`${hhmm(e.start)} – ${hhmm(e.end)}`)}</span></span>`;
  const handle = e.canEdit && s.endsHere ? '<span class="cal-resize" aria-hidden="true"></span>' : '';
  return `<button class="cal-ev ${stateClass(e)} ${short ? 'short' : ''} ${e.canEdit ? 'drag' : ''}" data-ev="${esc(e.id)}" style="${style};--c:${eventColor(e)}" aria-label="${esc(ariaLabel(e))}">
    <span class="t">${bookingMark(e)}${esc(titleOf(e))}</span>${time}${!short && e.location && height >= 59 ? `<span class="w"><span>${esc(e.location)}</span></span>` : ''}${handle}</button>`;
}

// A booking request that waits for an answer: a dashed block at its time.
function requestHtml(s) {
  const r = s.req;
  const { height, style } = blockBox(s);
  const short = height < 42;
  const name = (r.guest && r.guest.name) || r.typeTitle || '';
  const time = short ? '' : `<span class="w"><span>${esc(`${hhmm(r.start)} – ${hhmm(r.end)}`)}</span></span>`;
  return `<button class="cal-ev cal-req ${short ? 'short' : ''}" data-request="${esc(r.id)}" style="${style}" aria-label="${esc(requestLabel(r))}">
    <span class="t"><span class="tag">${esc(t('calendar.requests.label'))}</span>${esc(name)}</span>${time}</button>`;
}

// ---------- month ----------

// Long events take the top rows of a week, then the rest by start time.
const isLong = (e) => e.allDay || e.end - e.start >= DAY || startOfDay(e.start) !== startOfDay(Math.max(e.start, e.end - 1));
const monthOrder = (a, b) => Number(isLong(b)) - Number(isLong(a)) || byStart(a, b);

function monthHtml(body) {
  const r = range('month');
  const weeks = Math.max(1, Math.round(dayIndex(r.end, r.start) / 7));
  const names = shownDays(r.start)
    .map((d) => `<div class="cal-mname">${esc(fmt(d, { weekday: 'short' }))}</div>`)
    .join('');
  // As many event rows as a week has room for; a day with more says how many more.
  const height = body.clientHeight || 0;
  const fit = height ? Math.max(1, Math.floor(((height - 40) / weeks - MONTH_HEAD - 4) / MONTH_ROW)) : 3;
  const list = events();
  const requests = pendingRequests().map((req) => ({ start: req.start, end: req.end, req }));
  const month = new Date(monthStart(C.date)).getMonth();
  let rows = '';
  for (let w = 0; w < weeks; w++) rows += monthWeekHtml(shownDays(addDays(r.start, w * 7)), list, requests, fit, month);
  return `<div class="cal-month" style="--days:${shownDays(r.start).length};--weeks:${weeks}">
    <div class="cal-mnames">${names}</div><div class="cal-mgrid">${rows}</div></div>`;
}

function monthWeekHtml(columns, list, requests, fit, month) {
  const today = startOfDay(Date.now());
  const first = columns[0];
  const end = addDays(columns[columns.length - 1], 1);
  const items = list.concat(requests).filter((e) => (e.start < end && e.end > first) || (e.start === e.end && e.start >= first && e.start < end));
  const { placed } = spanLayout(items, columns, monthOrder);
  // A day overflows when something in it sits below the last row; then its last row says "+N more", and an event
  // that would sit in that row over an overflowing day goes too.
  const over = new Set();
  for (const p of placed) if (p.row >= fit) for (let c = p.from; c <= p.to; c++) over.add(c);
  const covers = (p, set) => {
    for (let c = p.from; c <= p.to; c++) if (set.has(c)) return true;
    return false;
  };
  const visible = (p) => p.row < fit - 1 || (p.row === fit - 1 && !covers(p, over));
  const hidden = columns.map(() => 0);
  let chips = '';
  for (const p of placed) {
    if (!visible(p)) {
      for (let c = p.from; c <= p.to; c++) hidden[c]++;
      continue;
    }
    chips += monthChipHtml(p, columns);
  }
  const cells = columns
    .map((d, i) => {
      const out = new Date(d).getMonth() !== month;
      return `<div class="cal-mcell ${out ? 'out' : ''}" data-cal-mday="${d}" style="grid-column:${i + 1}"></div>`;
    })
    .join('');
  const numbers = columns
    .map((d, i) => {
      const out = new Date(d).getMonth() !== month;
      // The first of a month says which month, as Google Calendar does.
      const label = new Date(d).getDate() === 1 ? fmt(d, { day: 'numeric', month: 'short' }) : fmt(d, { day: 'numeric' });
      return `<button class="cal-mnum ${out ? 'out' : ''} ${d === today ? 'today' : ''}" data-cal-day="${d}" style="grid-column:${i + 1}" title="${esc(longDay(d))}" aria-label="${esc(longDay(d))}">${esc(label)}</button>`;
    })
    .join('');
  const more = columns
    .map((d, i) =>
      hidden[i]
        ? `<button class="cal-mmore" data-cal-more="${d}" style="grid-column:${i + 1};grid-row:${fit + 1}" aria-label="${esc(t('calendar.month.moreLabel', { count: hidden[i], date: longDay(d) }))}">${esc(t('calendar.month.more', { count: hidden[i] }))}</button>`
        : ''
    )
    .join('');
  return `<div class="cal-mweek" style="--rows:${fit}">${cells}${numbers}${chips}${more}</div>`;
}

function monthChipHtml({ e, from, to, row }, columns) {
  const place = `grid-column:${from + 1} / span ${to - from + 1};grid-row:${row + 2}`;
  if (e.req) {
    const r = e.req;
    const name = (r.guest && r.guest.name) || r.typeTitle || '';
    return `<button class="cal-mchip timed cal-req" data-request="${esc(r.id)}" style="${place}" aria-label="${esc(requestLabel(r))}"><span class="tag">${esc(t('calendar.requests.label'))}</span><span class="w">${esc(hhmm(r.start))}</span><span class="t">${esc(name)}</span></button>`;
  }
  const cls = [stateClass(e), e.canEdit ? 'drag' : ''];
  if (isLong(e)) {
    cls.push('span', e.start < columns[from] ? 'cont-l' : '', e.end > addDays(columns[to], 1) ? 'cont-r' : '');
    const text = e.allDay ? titleOf(e) : `${hhmm(e.start)} ${titleOf(e)}`;
    return `<button class="cal-mchip ${cls.join(' ')}" data-ev="${esc(e.id)}" style="${place};--c:${eventColor(e)}" aria-label="${esc(ariaLabel(e))}">${bookingMark(e)}<span class="t">${esc(text)}</span></button>`;
  }
  return `<button class="cal-mchip timed ${cls.join(' ')}" data-ev="${esc(e.id)}" style="${place};--c:${eventColor(e)}" aria-label="${esc(ariaLabel(e))}"><span class="cal-dot"></span><span class="w">${esc(hhmm(e.start))}</span>${bookingMark(e)}<span class="t">${esc(titleOf(e))}</span></button>`;
}

// ---------- Upcoming and search ----------

function listHtml() {
  const r = range('upcoming');
  const list = events();
  const requests = pendingRequests();
  const now = Date.now();
  const today = startOfDay(now);
  let out = '';
  for (let d = r.start; d < r.end; d = addDays(d, 1)) {
    const next = addDays(d, 1);
    const day = list
      .filter((e) => e.start < next && e.end > d && (d !== today || e.end > now || e.allDay))
      .sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.start - b.start);
    const asked = requests.filter((q) => q.start >= d && q.start < next);
    if (!day.length && !asked.length) continue;
    const rows = day.map((e) => rowHtml(e, d, next)).concat(asked.map(requestRowHtml));
    out += `<section class="cal-list-day"><h2><span>${esc(dayLabel(d))}</span><span class="sub">${esc(fmt(d, { day: 'numeric', month: 'long' }))}</span></h2>${rows.join('')}</section>`;
  }
  if (!out) out = `<div class="empty">${icons.calendar}<div class="t">${esc(t('calendar.empty.upcoming', { count: C.upcomingDays }))}</div></div>`;
  return `<div class="cal-scroll cal-list"><div class="cal-list-inner">${out}<button class="btn secondary sm cal-more" data-cal="more">${esc(t('calendar.views.more'))}</button></div></div>`;
}

function dayLabel(d) {
  const today = startOfDay(Date.now());
  if (d === today) return t('common.dates.today');
  if (d === addDays(today, 1)) return t('calendar.dates.tomorrow');
  return cap(fmt(d, { weekday: 'long' }));
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

// A row of the Upcoming list and of search results: when, the event, where and with whom. Everything hangs from the
// first line. A search result opens the event in the calendar (data-search-ev) instead of beside the row.
function rowHtml(e, day, next, { search = false } = {}) {
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
  const target = search ? `data-search-ev="${esc(e.id)}" data-start="${e.start}"` : `data-ev="${esc(e.id)}"`;
  return `<button class="cal-row ${stateClass(e)}" ${target} style="--c:${eventColor(e)}" aria-label="${esc(ariaLabel(e))}">
    <span class="cal-row-time"><span>${esc(time)}</span>${detail}</span><span class="cal-dot"></span>
    <span class="cal-row-main"><span class="cal-row-title">${bookingMark(e)}${esc(titleOf(e))}</span><span class="cal-row-sub">${meta}</span></span>
    ${e.response === 'needsAction' ? `<span class="cal-pill">${esc(t('calendar.event.invitation'))}</span>` : ''}${peopleHtml(e)}</button>`;
}

function requestRowHtml(r) {
  const name = (r.guest && r.guest.name) || '';
  return `<button class="cal-row cal-req" data-request="${esc(r.id)}" aria-label="${esc(requestLabel(r))}">
    <span class="cal-row-time"><span>${esc(`${hhmm(r.start)} – ${hhmm(r.end)}`)}</span><span class="rel">${esc(duration(r.end - r.start))}</span></span><span class="cal-dot"></span>
    <span class="cal-row-main"><span class="cal-row-title"><span class="tag">${esc(t('calendar.requests.label'))}</span>${esc(name)}</span><span class="cal-row-sub"><span class="m"><span>${esc(r.typeTitle || '')}</span></span></span></span></button>`;
}

// ---------- search ----------

let searchTimer = null;

function openSearch() {
  closePop();
  if (!C.search) C.search = { query: '', results: null, failed: [], busy: false, seq: 0 };
  render();
  const input = $('.calendar .cal-search input');
  input?.focus();
  input?.select();
}

function closeSearch(refocus = false) {
  if (!C.search) return;
  clearTimeout(searchTimer);
  C.search = null;
  C.scroll = true;
  render();
  if (refocus) $('.calendar [data-cal="search"]')?.focus();
}

function bindSearchField(input) {
  input.addEventListener('input', () => {
    if (!C.search) return;
    C.search.query = input.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(runSearch, 250);
  });
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      clearTimeout(searchTimer);
      runSearch();
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation();
      closeSearch(true);
    } else if (ev.key === 'ArrowDown') {
      const first = $('.calendar [data-search-ev]');
      if (first) {
        ev.preventDefault();
        first.focus();
      }
    }
  });
}

// Main searches every calendar (calendarSearch). Before it can, the events this view has loaded are searched.
async function runSearch() {
  const s = C.search;
  if (!s) return;
  const query = s.query.trim();
  const seq = ++s.seq;
  if (!query) {
    s.results = null;
    s.busy = false;
    return renderBody();
  }
  s.busy = true;
  renderBody();
  let result;
  try {
    result = await api('calendarSearch', query);
  } catch (_) {
    result = { events: localSearch(query), failed: [] };
  }
  if (C.search !== s || seq !== s.seq) return;
  s.results = Array.isArray(result?.events) ? result.events : [];
  s.failed = Array.isArray(result?.failed) ? result.failed : [];
  s.busy = false;
  renderBody();
}

function localSearch(query) {
  const q = query.toLowerCase();
  const has = (v) => String(v || '').toLowerCase().includes(q);
  return ((C.data && C.data.events) || [])
    .filter((e) => has(e.title) || has(e.location) || has(e.description) || (e.attendees || []).some((a) => has(a.name) || has(a.address)))
    .sort((a, b) => a.start - b.start);
}

function searchHtml() {
  const s = C.search;
  if (!s.query.trim()) return `<div class="cal-scroll cal-list"><div class="empty">${icons.search}<div class="h">${esc(t('calendar.search.hint'))}</div></div></div>`;
  if (!s.results) return `<div class="cal-scroll cal-list"><div class="empty"><span class="spinner"></span><div class="h">${esc(t('calendar.search.searching'))}</div></div></div>`;
  // Calendars hidden by their eye toggle stay out of the results too.
  const list = s.results.filter((e) => {
    const cal = calendarOf(e);
    return !cal || isVisible(e.accountId, cal);
  });
  const failed = s.failed.map((f) => `<p class="cal-search-failed">${icons.info}<span>${esc(t('calendar.search.failed', { email: f.email || '' }))}</span></p>`).join('');
  const days = new Map();
  for (const e of list) {
    const d = startOfDay(e.start);
    if (!days.has(d)) days.set(d, []);
    days.get(d).push(e);
  }
  const thisYear = new Date().getFullYear();
  let out = '';
  for (const [d, group] of [...days].sort((a, b) => a[0] - b[0])) {
    const sub = fmt(d, new Date(d).getFullYear() === thisYear ? { day: 'numeric', month: 'long' } : { day: 'numeric', month: 'long', year: 'numeric' });
    out += `<section class="cal-list-day"><h2><span>${esc(dayLabel(d))}</span><span class="sub">${esc(sub)}</span></h2>${group.map((e) => rowHtml(e, d, addDays(d, 1), { search: true })).join('')}</section>`;
  }
  const count = `<div class="cal-search-count" role="status">${esc(list.length ? t('calendar.search.results', { count: list.length }) : t('calendar.search.empty', { query: s.query.trim() }))}</div>`;
  return `<div class="cal-scroll cal-list"><div class="cal-list-inner">${count}${failed}${out}</div></div>`;
}

window.addEventListener('resize', () => {
  closePop();
  if (C.open) reload();
});

// ---------- drag ----------

// A press on the grid can become one of these gestures:
//   create  empty space in a day column: a new event from the press to the pointer
//   move    an event in a day column: another time, or another day of the week
//   resize  an event's bottom edge: another end
//   days    an all-day chip, or any event in the month: moved by whole days
//   span    empty all-day or month cells: a new all-day event over the days dragged across
// Nothing redraws the grid from the press until the change is saved (C.drag); a load or redraw asked for meanwhile
// runs afterwards. The click that ends a drag does nothing else.

let swallowNext = false;
function swallowClick() {
  swallowNext = true;
  setTimeout(() => (swallowNext = false), 0);
}

function onPointerDown(ev) {
  if (C.drag || ev.button !== 0 || ev.ctrlKey || ev.metaKey || ev.shiftKey || ev.altKey) return;
  if (ev.target.closest('.cal-panel, .cal-head, .cal-notices, .cal-mnum, .cal-mmore, [data-request], .cal-dayhead, .cal-list')) return;
  const evEl = ev.target.closest('[data-ev]');
  let g = null;
  if (evEl) {
    const e = byId(evEl.dataset.ev);
    if (!e || !e.canEdit) return;
    const col = evEl.closest('[data-cal-col]');
    if (col) g = { kind: ev.target.closest('.cal-resize') ? 'resize' : 'move', e, col: Number(col.dataset.calCol) };
    else if (evEl.closest('.cal-allday, .cal-month')) g = { kind: 'days', e, day: dayAt(ev.clientX, ev.clientY) };
  } else if (ev.target.closest('[data-cal-col]')) {
    g = { kind: 'create', col: Number(ev.target.closest('[data-cal-col]').dataset.calCol) };
  } else if (ev.target.closest('[data-cal-allday], [data-cal-mday]')) {
    g = { kind: 'span', day: dayAt(ev.clientX, ev.clientY) };
  }
  if (!g || ((g.kind === 'days' || g.kind === 'span') && g.day === null)) return;
  Object.assign(g, {
    pointer: ev.pointerId,
    touch: ev.pointerType === 'touch',
    target: ev.target.closest('[data-ev], [data-cal-col], [data-cal-allday], [data-cal-mday]'),
    x0: ev.clientX,
    y0: ev.clientY,
    x: ev.clientX,
    y: ev.clientY,
    active: false
  });
  C.drag = g;
  if (g.touch) g.timer = setTimeout(() => startDrag(g), LONG_PRESS);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerCancel);
  window.addEventListener('blur', onLostPointer);
}

function stopListening() {
  window.removeEventListener('pointermove', onPointerMove);
  window.removeEventListener('pointerup', onPointerUp);
  window.removeEventListener('pointercancel', onPointerCancel);
  window.removeEventListener('blur', onLostPointer);
}

// The release can go missing: Alt+Tab or the Windows key mid-drag, or a system prompt that takes the focus. The
// event then goes back and the grid draws again, instead of the next click saving the move wherever the pointer is.
function onLostPointer() {
  const g = C.drag;
  if (g && !g.saving) abandonDrag();
}

function onPointerMove(ev) {
  const g = C.drag;
  if (!g || ev.pointerId !== g.pointer || g.saving) return;
  // A mouse that moves with its button up lost its release somewhere.
  if (ev.pointerType !== 'touch' && !(ev.buttons & 1)) return abandonDrag();
  if (g.cancelled) return;
  g.x = ev.clientX;
  g.y = ev.clientY;
  if (!g.active) {
    const dist = Math.hypot(g.x - g.x0, g.y - g.y0);
    // A finger that moves before the long press is over scrolls instead.
    if (g.touch) {
      if (dist > TOUCH_SLOP) abandonDrag();
      return;
    }
    if (dist < SLOP) return;
    startDrag(g);
  }
  ev.preventDefault();
  update(g);
  autoScroll(g);
}

function onPointerUp(ev) {
  const g = C.drag;
  if (!g || ev.pointerId !== g.pointer) return;
  stopListening();
  clearTimeout(g.timer);
  if (!g.active) {
    // A plain click: the click handler takes it.
    C.drag = null;
    flushDeferred();
    return;
  }
  swallowClick();
  if (g.cancelled) return endDrag();
  finish(g);
}

function onPointerCancel(ev) {
  const g = C.drag;
  if (!g || ev.pointerId !== g.pointer || g.saving) return;
  abandonDrag();
}

function startDrag(g) {
  if (C.drag !== g || g.active || g.cancelled) return;
  clearTimeout(g.timer);
  g.active = true;
  closePop();
  closeMenu();
  const el = $('.calendar');
  el.classList.add('dragging', `drag-${g.kind}`);
  try {
    g.target?.setPointerCapture(g.pointer);
    // The capture also ends after the release; by then the drag is saving or over, so this does nothing. A touch
    // was captured by the element under the finger first, and its loss bubbles up from there: that one doesn't count.
    const lost = (ev) => {
      if (ev.target !== g.target) return;
      g.target.removeEventListener('lostpointercapture', lost);
      if (C.drag === g) onLostPointer();
    };
    g.target?.addEventListener('lostpointercapture', lost);
  } catch (_) {
    // The pointer is gone already.
  }
  if (g.col !== undefined) g.m0 = pointerMinutes(g.col, g.y0);
  if (g.e) for (const x of $$(`.calendar [data-ev="${CSS.escape(g.e.id)}"]`)) x.classList.add('drag-src');
  update(g);
}

// Minutes from midnight at the pointer's height in a day column, 0 to 1440.
function pointerMinutes(day, y) {
  const col = $(`.calendar .cal-col[data-cal-col="${day}"]`) || $('.calendar .cal-col');
  if (!col) return 0;
  const m = ((y - col.getBoundingClientRect().top) / HOUR) * 60;
  return Math.max(0, Math.min(1440, m));
}

// The day column under the pointer, or the nearest one.
function columnAt(x) {
  let best = null;
  let distance = Infinity;
  for (const col of $$('.calendar .cal-col')) {
    const r = col.getBoundingClientRect();
    const d = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
    if (d < distance) {
      distance = d;
      best = Number(col.dataset.calCol);
    }
  }
  return best;
}

// The all-day or month cell under the pointer, or the nearest one; null outside those.
function dayAt(x, y) {
  let best = null;
  let distance = Infinity;
  for (const cell of $$('.calendar [data-cal-allday], .calendar [data-cal-mday]')) {
    const r = cell.getBoundingClientRect();
    const dx = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
    const dy = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
    const d = Math.hypot(dx, dy);
    if (d < distance) {
      distance = d;
      best = Number(cell.dataset.calAllday || cell.dataset.calMday);
    }
  }
  return best;
}

const atMinutes = (day, m) => {
  const d = new Date(day);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, m).getTime();
};

// A time moved on the wall clock: days on the calendar, then minutes.
function shift(ts, days, mins) {
  const d = new Date(ts);
  d.setDate(d.getDate() + days);
  d.setMinutes(d.getMinutes() + mins);
  return d.getTime();
}

const snap = (m) => Math.round(m / SNAP) * SNAP;

// Works out what the gesture would change at the pointer, and shows it.
function update(g) {
  if (g.kind === 'create') {
    const a = Math.floor(g.m0 / SNAP) * SNAP;
    const b = Math.min(1440 - SNAP, Math.floor(pointerMinutes(g.col, g.y) / SNAP) * SNAP);
    const [s, e] = b >= a ? [a, b + SNAP] : [b, a + SNAP];
    g.start = atMinutes(g.col, s);
    g.end = atMinutes(g.col, Math.min(1440, e));
    drawGhost(g, '', 'var(--accent)');
  } else if (g.kind === 'move') {
    const target = shownView() === 'day' ? g.col : columnAt(g.x) ?? g.col;
    const delta = snap(pointerMinutes(target, g.y) - g.m0);
    g.start = shift(g.e.start, dayIndex(target, g.col), delta);
    g.end = g.start + (g.e.end - g.e.start);
    drawGhost(g, titleOf(g.e), eventColor(g.e));
  } else if (g.kind === 'resize') {
    const delta = snap(pointerMinutes(g.col, g.y) - g.m0);
    g.start = g.e.start;
    g.end = Math.max(shift(g.e.end, 0, delta), g.e.start + SNAP * 60000);
    drawGhost(g, titleOf(g.e), eventColor(g.e));
  } else if (g.kind === 'days') {
    const target = dayAt(g.x, g.y) ?? g.day;
    const n = dayIndex(target, g.day);
    g.start = addDays(g.e.start, n);
    g.end = addDays(g.e.end, n);
    markDays(startOfDay(g.start), startOfDay(Math.max(g.start, g.end - 1)), eventColor(g.e));
  } else if (g.kind === 'span') {
    const target = dayAt(g.x, g.y) ?? g.day;
    const [a, b] = target >= g.day ? [g.day, target] : [target, g.day];
    g.start = a;
    g.end = addDays(b, 1);
    markDays(a, b, 'var(--accent)');
  }
}

// The new place of a timed event: a lifted card in each day column it reaches, with its times.
function drawGhost(g, title, color) {
  for (const x of $$('.calendar .cal-ghost')) x.remove();
  g.ghost = null;
  for (const col of $$('.calendar .cal-col')) {
    const day = Number(col.dataset.calCol);
    const next = addDays(day, 1);
    if (g.start >= next || g.end <= day) continue;
    const top = g.start <= day ? 0 : minutes(g.start);
    const bottom = g.end >= next ? 1440 : minutes(g.end);
    const height = Math.max(((bottom - top) * HOUR) / 60, MIN_EVENT) - 3;
    const ghost = document.createElement('div');
    ghost.className = `cal-ev cal-ghost ${height < 42 ? 'short' : ''} ${g.kind === 'create' ? 'new' : ''}`;
    ghost.style.cssText = `top:${(top * HOUR) / 60 + 1}px;height:${height}px;left:3px;right:3px;--c:${color}`;
    ghost.innerHTML = `${title ? `<span class="t">${esc(title)}</span>` : ''}<span class="w">${esc(`${hhmm(g.start)} – ${hhmm(g.end)}`)}</span>`;
    col.appendChild(ghost);
    g.ghost = g.ghost || ghost;
  }
}

// The days an all-day gesture covers, marked in the all-day row or the month.
function markDays(a, b, color) {
  for (const cell of $$('.calendar [data-cal-allday], .calendar [data-cal-mday]')) {
    const d = Number(cell.dataset.calAllday || cell.dataset.calMday);
    const on = d >= a && d <= b;
    cell.classList.toggle('drop', on);
    if (on) cell.style.setProperty('--c', color);
  }
}

let scrollFrame = 0;
// Near the top or bottom of the grid a drag scrolls it, faster the further out the pointer is.
function autoScroll(g) {
  if (!['create', 'move', 'resize'].includes(g.kind) || scrollFrame) return;
  const scroller = $('.calendar .cal-scroll');
  if (!scroller) return;
  const speed = () => {
    const r = scroller.getBoundingClientRect();
    const edge = 28;
    if (g.y < r.top + edge) return -Math.min(16, (r.top + edge - g.y) / 2);
    if (g.y > r.bottom - edge) return Math.min(16, (g.y - (r.bottom - edge)) / 2);
    return 0;
  };
  const step = () => {
    scrollFrame = 0;
    if (C.drag !== g || !g.active || g.saving || g.cancelled) return;
    const v = speed();
    if (!v) return;
    scroller.scrollTop += v;
    update(g);
    scrollFrame = requestAnimationFrame(step);
  };
  if (speed()) scrollFrame = requestAnimationFrame(step);
}

function clearDragMarks() {
  cancelAnimationFrame(scrollFrame);
  scrollFrame = 0;
  const el = $('.calendar');
  el?.classList.remove('dragging', 'drag-create', 'drag-move', 'drag-resize', 'drag-days', 'drag-span');
  for (const x of $$('.calendar .cal-ghost')) x.remove();
  for (const x of $$('.calendar .drag-src')) x.classList.remove('drag-src');
  for (const x of $$('.calendar .drop')) {
    x.classList.remove('drop');
    x.style.removeProperty('--c');
  }
}

function flushDeferred(force = false) {
  const { load: l, render: r } = deferred;
  deferred = { load: false, render: false };
  if (r || force || l) render();
  if (l) load();
}

// The gesture is over, saved or not: the grid draws what the calendar holds now.
function endDrag() {
  const g = C.drag;
  C.drag = null;
  if (g) clearTimeout(g.timer);
  stopListening();
  clearDragMarks();
  flushDeferred(true);
}

// Escape: the event goes back, and the release that follows does nothing.
function cancelDrag() {
  const g = C.drag;
  if (!g || !g.active || g.saving || g.cancelled) return false;
  g.cancelled = true;
  clearDragMarks();
  return true;
}

// A press that never became a drag, or a drag the system broke off (a scroll, the window losing the pointer).
function abandonDrag() {
  const g = C.drag;
  if (!g || g.saving) return;
  C.drag = null;
  clearTimeout(g.timer);
  stopListening();
  clearDragMarks();
  flushDeferred(g.active);
}

async function finish(g) {
  g.saving = true;
  cancelAnimationFrame(scrollFrame);
  scrollFrame = 0;
  if (g.kind === 'create' || g.kind === 'span') {
    const anchor = g.ghost || $('.calendar .drop');
    try {
      await newEvent({ start: g.start, end: g.end, allDay: g.kind === 'span', anchor });
    } finally {
      endDrag();
    }
    return;
  }
  if (g.start === g.e.start && g.end === g.e.end) return endDrag();
  await saveChange(g.e, { start: g.start, end: g.end }, g.kind === 'resize' ? 'resize' : 'move');
}

function replaceEvent(id, fresh) {
  const list = C.data && C.data.events;
  const i = list ? list.findIndex((x) => x.id === id) : -1;
  if (i >= 0 && fresh) list[i] = fresh;
}

// Saves a moved or resized event. An occurrence of a series asks which events change; guests hear about it only
// when the user says so. A failed save puts the event back where it was.
async function saveChange(e, next, what) {
  let scope = 'one';
  if (e.seriesId || e.recurring) {
    scope = await seriesChoice(t(what === 'resize' ? 'calendar.drag.seriesResize' : 'calendar.drag.seriesMove'), e);
    if (!scope) return endDrag();
  }
  const notify = await notifyGuests(e, 'update');
  if (notify === null) return endDrag();
  const before = { start: e.start, end: e.end, allDay: e.allDay };
  let saved;
  try {
    saved = await api('calendarUpdate', e.id, eventInput(e, next), { notify, etag: e.etag, scope });
  } catch (err) {
    endDrag();
    toast(err.message, 5000);
    reload(0);
    return;
  }
  // The change shows at once; the reload brings what else it changed, such as the rest of a series.
  replaceEvent(e.id, saved || { ...e, ...next });
  endDrag();
  reload(0);
  const label = t(what === 'resize' ? 'calendar.drag.resized' : 'calendar.drag.moved');
  // Undo puts back the one event it got back, with the same choice about the guests (contracts k).
  if (saved && scope === 'one') toast(label, { action: { label: t('common.actions.undo'), run: () => undoChange(saved, before, notify) } });
  else toast(label);
}

async function undoChange(saved, before, notify) {
  try {
    const back = await api('calendarUpdate', saved.id, eventInput(saved, before), { notify, etag: saved.etag, scope: 'one' });
    if (!C.drag) {
      replaceEvent(saved.id, back);
      render();
    }
    toast(t('calendar.drag.undone'));
  } catch (err) {
    toast(err.message, 5000);
  }
  reload(0);
}

// ---------- input ----------

function setView(view) {
  if (!['day', 'week', 'month', 'upcoming'].includes(view)) return;
  prefs.view = view;
  savePrefs();
  closePop();
  C.search = null;
  C.mini = null;
  C.scroll = true;
  if (view === 'upcoming') C.upcomingDays = UPCOMING_DAYS;
  setSegmented($('.calendar .cal-head .segmented'), view);
  load();
}

function step(dir) {
  const view = shownView();
  if (view === 'upcoming') return;
  closePop();
  if (view === 'month') C.date = addMonths(C.date, dir);
  else C.date = addDays(C.date, dir * (view === 'day' ? 1 : 7));
  C.mini = null;
  load();
}

function goToday() {
  closePop();
  C.date = startOfDay(Date.now());
  C.mini = null;
  C.miniFocus = null;
  C.scroll = true;
  load();
}

function togglePanel(name, focus) {
  if (C.panel === name) closePanel({ refocus: true });
  else openPanel(name, { focus });
}

let bound = false;
function bind() {
  if (bound) return;
  const el = $('.calendar');
  if (!el) return;
  bound = true;
  // The click that ends a drag, or follows an Escape during one, does nothing else.
  el.addEventListener(
    'click',
    (ev) => {
      if (!swallowNext) return;
      swallowNext = false;
      C.swallow = false;
      ev.stopPropagation();
      ev.preventDefault();
    },
    true
  );
  el.addEventListener('click', (ev) => {
    // The side panel's own controls belong to the panel.
    if (ev.target.closest('.cal-panel-body')) return;
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
    if (d.cal === 'goto') return goToDate();
    if (d.cal === 'search') return C.search ? closeSearch(true) : openSearch();
    if (d.cal === 'search-close') return closeSearch(true);
    if (d.cal === 'panel-close') return closePanel({ refocus: true });
    if (d.calPanel) return togglePanel(d.calPanel, ev.detail === 0);
    if (d.cal === 'more') {
      C.upcomingDays = Math.min(C.upcomingDays + UPCOMING_DAYS, 12 * UPCOMING_DAYS);
      return load();
    }
    if (d.calNotice) {
      const action = C.notices[d.calNotice]?.[Number(d.i)]?.actions?.[Number(d.j)];
      if (action) action.run();
      return;
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
    if (d.calDay || d.calMore) {
      C.date = Number(d.calDay || d.calMore);
      return setView('day');
    }
    if (d.searchEv) return openEvent(d.searchEv, Number(d.start));
    if (d.request) {
      if (hooks.openRequest) hooks.openRequest(d.request, target);
      return;
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
      // An empty spot in the grid: a new event from the half hour clicked, as long as Settings → Calendar says.
      const y = ev.clientY - target.getBoundingClientRect().top;
      const half = Math.max(0, Math.min(47, Math.floor((y / HOUR) * 2)));
      const start = parseLocal(dateValue(Number(d.calCol)), `${pad(Math.floor(half / 2))}:${half % 2 ? '30' : '00'}`);
      return newEvent({ start, end: start + (Number(calSettings().duration) || 60) * 60000 });
    }
  });
  // A double click on an empty day of the month makes an all-day event there.
  el.addEventListener('dblclick', (ev) => {
    if (ev.target.closest('button')) return;
    const cell = ev.target.closest('[data-cal-mday]');
    if (cell) newEvent({ start: Number(cell.dataset.calMday), allDay: true });
  });
  el.addEventListener('pointerdown', onPointerDown);
  // While a touch drag is on, the finger moves the event instead of scrolling the grid.
  el.addEventListener(
    'touchmove',
    (ev) => {
      if (C.drag && C.drag.active) ev.preventDefault();
    },
    { passive: false }
  );
  el.addEventListener('contextmenu', (ev) => {
    if (C.drag) ev.preventDefault();
  });
  // A calendar's menu also opens with a right click, a long press or the menu key on its row.
  $('.sidebar')?.addEventListener('contextmenu', (ev) => {
    const row = ev.target.closest('[data-cal-toggle]');
    if (!row || !$('.shell.calendar-mode')) return;
    ev.preventDefault();
    const fromKeyboard = ev.clientX === 0 && ev.clientY === 0;
    calendarMenu(row.dataset.calToggle, row, fromKeyboard ? null : { x: ev.clientX, y: ev.clientY });
  });
}

// The calendar's keys; true when the key was its own. Mail keys don't reach a hidden mailbox.
export function onKey(ev) {
  const key = ev.key.toLowerCase();
  const ctrl = ev.ctrlKey || ev.metaKey;
  const e = C.pop && byId(C.pop);
  const typing = ev.target && (ev.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(ev.target.tagName));
  if (ev.key === 'Escape' && C.drag && cancelDrag()) return true;
  if (ev.key === 'Escape' && C.pop) {
    closePop(true);
    return true;
  }
  if (typing) return false;
  if (ev.key === 'Escape' && C.panel && ev.target.closest?.('.cal-panel')) {
    closePanel({ refocus: true });
    return true;
  }
  if (ev.key === 'Escape' && C.search) {
    closeSearch(true);
    return true;
  }
  // The mini month in the sidebar moves its own focus.
  if (!ctrl && !ev.altKey && ev.target.dataset?.miniDay && ev.target.closest?.('.sidebar .cal-mini')) {
    if (sideMiniKey(ev)) return true;
  }
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
  // Undo of the last move or resize, as the toast offers.
  if (ctrl && key === 'z' && !ev.shiftKey && !ev.altKey) return runToastAction();
  if (ctrl || ev.altKey) return false;
  // Arrows inside a control (the view switch, the event card, the mini month, a side panel) stay with it.
  const inControl = ev.target.closest?.('[role="tablist"], .cal-pop, .cal-mini, .cal-panel, .menu');
  if (key === 't') goToday();
  else if ((ev.key === 'ArrowLeft' && !inControl) || key === 'k') step(-1);
  else if ((ev.key === 'ArrowRight' && !inControl) || key === 'j') step(1);
  else if (key === 'd') setView('day');
  else if (key === 'w') setView('week');
  else if (key === 'm') setView('month');
  else if (key === 'u') setView('upcoming');
  else if (key === 'g') goToDate();
  else if (ev.key === '/') openSearch();
  else if (key === 'a' && hooks.panels.free) togglePanel('free', true);
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
  if (shownView() === 'upcoming' && !C.search) render();
  const line = $('.calendar .cal-now');
  if (line) line.style.top = `${(minutes(Date.now()) * HOUR) / 60}px`;
}, 30000);
