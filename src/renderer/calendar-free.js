// The availability panel beside the calendar grid: open time across the calendars that count toward availability,
// for a length, a period and hours, grouped by day, in this computer's time zone or another. While it is open the grid
// shows the open time too. Main works the time out (calendarFree, src/main/calendar/free.js); this draws it. The
// module registers the panel with calendar.js through hooks.panels when it loads, and maps the booking page's state
// onto the calendar (requests, notices) for app.js.
import { t, getLocale } from './i18n.js';
import { icons } from './icons.js';
import { api, esc, toast } from './ui.js';
import { C, ctx, hooks, prefs, savePrefs, cap, duration, calSettings, account, FREE_LENGTHS, FREE_RANGES, pcZone, freeRange, zoneOptions } from './calendar-shared.js';
import { setHighlight, setBooking, setNotices, openEvent, openRequest } from './calendar.js';

// The choices last made, kept on this computer. hours null: Booking hours while the booking page is on, else working.
const saved = prefs.free && typeof prefs.free === 'object' ? prefs.free : {};
const F = {
  length: FREE_LENGTHS.includes(saved.length) ? saved.length : 30,
  range: FREE_RANGES.includes(saved.range) ? saved.range : 'week',
  hours: ['booking', 'working', 'any'].includes(saved.hours) ? saved.hours : null,
  zone: typeof saved.zone === 'string' ? saved.zone : null,
  host: null,
  result: null,
  error: null,
  busy: false,
  seq: 0,
  showChecked: false,
  timer: null
};

const bookingOn = () => Boolean(C.booking && C.booking.status === 'on');
const bookingUrl = () => (bookingOn() && C.booking.url) || (ctx && ctx.S && ctx.S.data && ctx.S.data.bookingUrl) || null;
const hoursNow = () => (F.hours === 'booking' && !bookingOn() ? 'working' : F.hours || (bookingOn() ? 'booking' : 'working'));
const zoneNow = () => F.zone || pcZone();
const isOpen = () => C.panel === 'free' && F.host && F.host.isConnected;
// The booking page's zone, while it is on. Its date overrides are dates in that zone, so a day can be blocked only
// while the panel shows its days in that zone too; in another zone a day here can span two of the page's dates.
const bookingZone = () => (bookingOn() && C.booking.settings && C.booking.settings.timeZone) || null;
const canBlock = () => Boolean(bookingZone() && zoneNow() === bookingZone());

function remember() {
  prefs.free = { length: F.length, range: F.range, hours: F.hours, zone: F.zone };
  savePrefs();
}

// ---------- times in a zone ----------

const formatter = (zone, options) => new Intl.DateTimeFormat(getLocale(), { timeZone: zone, ...options });
// 'YYYY-MM-DD' of an instant in a zone.
function dateKey(ms, zone) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(ms).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
const clock = (ms, zone) => formatter(zone, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ms);
const dayTitle = (ms, zone) => cap(formatter(zone, { weekday: 'long', day: 'numeric', month: 'long' }).format(ms));

// The next midnight in a zone after ms: a day later on the clock, found by stepping back from 26 hours on.
function nextMidnight(ms, zone) {
  const key = dateKey(ms, zone);
  let lo = ms;
  let hi = ms + 26 * 3600000;
  while (hi - lo > 60000) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (dateKey(mid, zone) === key) lo = mid;
    else hi = mid;
  }
  return Math.floor(hi / 60000) * 60000;
}

// The windows split at midnight in the zone, as days: [{ key, start, items: [[s, e, endsAtMidnight]] }].
function days(windows, zone) {
  const out = new Map();
  for (const [start, end] of windows) {
    let s = start;
    while (s < end) {
      const midnight = nextMidnight(s, zone);
      const e = Math.min(end, midnight);
      const key = dateKey(s, zone);
      if (!out.has(key)) out.set(key, { key, start: s, items: [] });
      out.get(key).items.push([s, e, e === midnight]);
      s = e;
    }
  }
  return [...out.values()];
}

// ---------- drawing ----------

function controlsHtml() {
  const hours = hoursNow();
  const lengthButtons = FREE_LENGTHS.map(
    (n) => `<button role="radio" aria-checked="${n === F.length}" data-free-length="${n}" title="${esc(duration(n * 60000))}">${n}</button>`
  ).join('');
  const rangeLabel = { week: t('calendar.free.rangeThisWeek'), next: t('calendar.free.rangeNextWeek'), days14: t('calendar.free.range14') };
  const hourOptions = [
    bookingOn() ? ['booking', t('calendar.free.hoursBooking')] : null,
    ['working', t('calendar.free.hoursWorking')],
    ['any', t('calendar.free.hoursAny')]
  ].filter(Boolean);
  return `<div class="free-form">
      <span class="free-label" id="free-length">${esc(t('calendar.free.length'))}</span>
      <div class="free-lengths" role="radiogroup" aria-labelledby="free-length">${lengthButtons}<span class="free-unit" aria-hidden="true">min</span></div>
      <label class="free-label" for="free-range">${esc(t('calendar.free.range'))}</label>
      <select id="free-range" data-free="range">${FREE_RANGES.map((r) => `<option value="${r}"${r === F.range ? ' selected' : ''}>${esc(rangeLabel[r])}</option>`).join('')}</select>
      <label class="free-label" for="free-hours">${esc(t('calendar.free.hours'))}</label>
      <select id="free-hours" data-free="hours">${hourOptions.map(([v, label]) => `<option value="${v}"${v === hours ? ' selected' : ''}>${esc(label)}</option>`).join('')}</select>
      <label class="free-label" for="free-zone">${esc(t('calendar.free.zone'))}</label>
      <select id="free-zone" data-free="zone">${zoneOptions(zoneNow(), bookingZone() ? [bookingZone()] : [])}</select>
    </div>
    <div class="free-result" aria-live="polite"></div>`;
}

function checkedHtml(r) {
  const n = r.checked.length;
  const list = F.showChecked
    ? `<ul class="free-checked">${r.checked.map((c) => `<li><span class="free-cal">${esc(c.name)}</span><span class="free-cal-mail">${esc(c.email)}</span></li>`).join('')}
        <li><button class="link-btn" data-free-act="settings">${esc(t('calendar.free.checkedChange'))}</button></li></ul>`
    : '';
  if (!n && !r.failed.length) {
    return `<div class="free-note warn" role="status">${esc(t('calendar.free.checkedNone'))} <button class="link-btn" data-free-act="settings">${esc(t('calendar.free.checkedChange'))}</button></div>`;
  }
  return `<button class="link-btn free-checked-toggle" data-free-act="checked" aria-expanded="${F.showChecked}">${esc(t('calendar.free.checked', { count: n }))}${icons.chevronDown}</button>${list}`;
}

function resultHtml() {
  const r = F.result;
  if (F.error) return `<div class="free-note error" role="alert">${esc(F.error)}</div>`;
  if (!r) return `<div class="free-loading"><span class="spinner"></span>${esc(t('calendar.free.loading'))}</div>`;
  const zone = r.timeZone || zoneNow();
  const failed = r.failed
    .map((f) => `<div class="free-note warn" role="status">${esc(t('calendar.free.failed', { email: f.email }))}</div>`)
    .join('');
  const url = bookingUrl();
  const actions = `<div class="free-actions">
      <button class="btn sm secondary" data-free-act="copy" ${r.lines.length ? '' : 'disabled'}>${icons.notes}${esc(t('calendar.free.copyText'))}</button>
      ${url ? `<button class="btn sm secondary" data-free-act="link">${icons.link}${esc(t('calendar.free.copyLink'))}</button>` : ''}
    </div>`;
  const list = days(r.windows, zone);
  // The days on screen are in the result's zone; while another zone loads they stay as they were.
  const blockable = canBlock() && zone === bookingZone();
  const allDayOn = (key) => r.allDay.filter((a) => a.startDate <= key && key < a.endDate);
  const body = list.length
    ? list
        .map((d) => {
          const allDay = allDayOn(d.key)
            .map((a) => `<li class="free-allday">${esc(t('calendar.free.allDay', { title: a.title || t('calendar.event.noTitle') }))}</li>`)
            .join('');
          const slots = d.items
            .map(
              ([s, e, toMidnight]) =>
                `<li><button class="free-slot" data-free-day="${s}" title="${esc(t('calendar.free.show'))}"><span class="free-time">${esc(clock(s, zone))} – ${esc(toMidnight ? '24:00' : clock(e, zone))}</span><span class="free-len">${esc(duration(e - s))}</span></button></li>`
            )
            .join('');
          const block = blockable
            ? `<button class="link-btn free-block" data-free-block="${esc(d.key)}" data-free-at="${d.start}" aria-label="${esc(t('calendar.free.blockLabel', { date: dayTitle(d.start, zone) }))}">${esc(t('calendar.free.block'))}</button>`
            : '';
          return `<section class="free-day"><div class="free-day-head"><h3>${esc(dayTitle(d.start, zone))}</h3>${block}</div><ul>${allDay}${slots}</ul></section>`;
        })
        .join('')
    : `<p class="free-empty">${esc(t('calendar.free.empty', { length: duration(F.length * 60000) }))}</p>`;
  // In another zone than the booking page's, days can't be blocked; one click shows the days in the page's zone.
  const zoneNote =
    list.length && bookingZone() && !canBlock()
      ? `<p class="free-zone-note">${esc(t('calendar.free.blockZone'))} <button class="link-btn" data-free-act="booking-zone">${esc(t('calendar.free.blockZoneAction', { zone: bookingZone().replace(/_/g, ' ') }))}</button></p>`
      : '';
  return `<div class="free-status">${checkedHtml(r)}${failed}</div>${actions}<div class="free-days ${F.busy ? 'busy' : ''}">${body}${zoneNote}</div>`;
}

function drawResult() {
  const box = F.host && F.host.querySelector('.free-result');
  if (!box) return;
  const focused = box.contains(document.activeElement) ? document.activeElement : null;
  const keep = focused && (focused.dataset.freeAct || focused.dataset.freeBlock || focused.dataset.freeDay);
  box.innerHTML = resultHtml();
  if (keep) box.querySelector(`[data-free-act="${CSS.escape(keep)}"], [data-free-block="${CSS.escape(keep)}"], [data-free-day="${CSS.escape(keep)}"]`)?.focus({ preventScroll: true });
}

// Asks main again; a newer question wins over an older answer.
async function refresh() {
  if (!isOpen()) return;
  clearTimeout(F.timer);
  const seq = ++F.seq;
  F.busy = true;
  drawResult();
  const range = freeRange(F.range, calSettings());
  try {
    const result = await api('calendarFree', { start: range.start, end: range.end, length: F.length, hours: hoursNow(), timeZone: zoneNow() });
    if (seq !== F.seq || !isOpen()) return;
    F.result = result;
    F.error = null;
    setHighlight(result.windows);
  } catch (err) {
    if (seq !== F.seq || !isOpen()) return;
    F.result = null;
    F.error = err.message;
    setHighlight(null);
  }
  F.busy = false;
  drawResult();
}
const refreshSoon = (ms = 400) => {
  clearTimeout(F.timer);
  F.timer = setTimeout(refresh, ms);
};

// calendar.js calls this each time the panel opens, and again when it builds its toolbar anew (a language change).
function render(host) {
  if (F.host && F.host !== host) close();
  F.host = host;
  host.classList.add('free-panel');
  host.innerHTML = controlsHtml();
  if (!host.dataset.freeBound) {
    host.dataset.freeBound = '1';
    host.addEventListener('click', onClick);
    host.addEventListener('change', onChange);
    host.addEventListener('keydown', onKeydown);
  }
  drawResult();
  refresh();
}

function close() {
  clearTimeout(F.timer);
  F.seq++;
  if (F.host) {
    F.host.removeEventListener('click', onClick);
    F.host.removeEventListener('change', onChange);
    F.host.removeEventListener('keydown', onKeydown);
    delete F.host.dataset.freeBound;
  }
  F.host = null;
  F.result = null;
  F.error = null;
  F.busy = false;
}

function onChange(ev) {
  const what = ev.target.dataset.free;
  if (!what) return;
  if (what === 'range') F.range = ev.target.value;
  if (what === 'hours') F.hours = ev.target.value;
  if (what === 'zone') F.zone = ev.target.value === pcZone() ? null : ev.target.value;
  remember();
  refresh();
}

function setLength(n) {
  F.length = n;
  remember();
  F.host.querySelectorAll('[data-free-length]').forEach((b) => b.setAttribute('aria-checked', String(Number(b.dataset.freeLength) === n)));
  refresh();
}

// The lengths are one radio group: arrows move the choice, as in any radio group.
function onKeydown(ev) {
  const b = ev.target.closest && ev.target.closest('[data-free-length]');
  if (!b || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(ev.key)) return;
  ev.preventDefault();
  const i = FREE_LENGTHS.indexOf(Number(b.dataset.freeLength));
  const next = FREE_LENGTHS[(i + (ev.key === 'ArrowLeft' || ev.key === 'ArrowUp' ? -1 : 1) + FREE_LENGTHS.length) % FREE_LENGTHS.length];
  setLength(next);
  F.host.querySelector(`[data-free-length="${next}"]`)?.focus();
}

async function copy(text, done) {
  try {
    await navigator.clipboard.writeText(text);
    toast(done);
  } catch (err) {
    toast(err.message, 5000);
  }
}

// A booking date override that blocks the day, with Undo putting back what the date had. date is the day in the
// booking page's zone, which the panel shows (canBlock); at is a moment on that day, for its name in the toast.
async function blockDay(date, at) {
  if (!canBlock()) return;
  const before = C.booking && C.booking.settings && C.booking.settings.overrides ? C.booking.settings.overrides[date] : undefined;
  const label = Number.isFinite(at) ? dayTitle(at, zoneNow()) : date;
  try {
    applyBooking(await api('bookingSave', { overrides: { [date]: [] } }));
  } catch (err) {
    toast(err.message, 6000);
    return;
  }
  refresh();
  toast(t('calendar.free.blocked', { date: label }), {
    action: {
      label: t('common.actions.undo'),
      run: async () => {
        try {
          applyBooking(await api('bookingSave', { overrides: { [date]: Array.isArray(before) ? before : null } }));
        } catch (err) {
          toast(err.message, 6000);
        }
        refresh();
      }
    }
  });
}

function onClick(ev) {
  const b = ev.target.closest('button');
  if (!b || !F.host.contains(b)) return;
  if (b.dataset.freeLength) return setLength(Number(b.dataset.freeLength));
  if (b.dataset.freeBlock) return blockDay(b.dataset.freeBlock, Number(b.dataset.freeAt));
  if (b.dataset.freeDay) {
    // The grid moves to that day; the open time already shows on it.
    const day = Number(b.dataset.freeDay);
    const d = new Date(day);
    d.setHours(0, 0, 0, 0);
    C.date = d.getTime();
    C.mini = null;
    C.scroll = true;
    if (prefs.view === 'upcoming' || prefs.view === 'month') {
      prefs.view = 'week';
      savePrefs();
    }
    hooks.reload(0);
    return;
  }
  switch (b.dataset.freeAct) {
    case 'copy': {
      const r = F.result;
      if (!r || !r.lines.length) return;
      return copy([...r.lines, t('calendar.free.zoneLine', { zone: r.timeZone })].join('\n'), t('calendar.free.copied'));
    }
    case 'link': {
      const url = bookingUrl();
      if (url) copy(url, t('calendar.free.linkCopied'));
      return;
    }
    case 'checked':
      F.showChecked = !F.showChecked;
      return drawResult();
    case 'settings':
      return ctx.openSettings('calendar');
    case 'booking-zone': {
      const zone = bookingZone();
      if (!zone) return;
      F.zone = zone === pcZone() ? null : zone;
      remember();
      const select = F.host.querySelector('[data-free="zone"]');
      if (select) select.value = zone;
      // The note and its button go with the redraw; the zone field keeps the keyboard.
      select?.focus();
      return refresh();
    }
  }
}

hooks.panels.free = {
  title: () => t('calendar.free.title'),
  render,
  close
};

// The open time changes with the calendar: after a sync, a change or a new calendar.
window.mail.on(({ type }) => {
  if (type === 'calendar' && isOpen()) refreshSoon();
});

// ---------- the booking page in the calendar ----------

// Reconnecting an account the booking page couldn't read, as the calendar's sidebar does: Google signs in again,
// a CalDAV account opens its Server settings.
async function reconnect(accountId) {
  const google = account(accountId)?.kind === 'google' || ctx.S.data?.accounts.find((a) => a.id === accountId)?.provider === 'google';
  if (!google) return ctx.openSettings('server', { id: accountId });
  if (!ctx.S.data.googleAvailable) return toast(t('errors.google.notConfigured'), 6000);
  toast(t('setup.google.waitToast'), 60000);
  try {
    await api('googleReauth', accountId);
    toast(t('setup.google.signedIn'));
  } catch (err) {
    toast(err.message, 6000);
  }
}

// A booking notice from main as a calendar notice: its text and buttons come translated; each button does here what
// contracts k says.
function calendarNotice(n, state) {
  const item = [...(state.bookings || []), ...(state.requests || [])].find((b) => b.id === n.bookingId);
  const act = async (fn) => {
    try {
      const next = await fn();
      if (next && typeof next === 'object' && next.status) applyBooking(next);
    } catch (err) {
      toast(err.message, 6000);
    }
  };
  const run = (action) => {
    switch (action) {
      case 'takeover':
        return act(() => api('bookingTakeover'));
      case 'reconnect':
        return n.accountId ? reconnect(n.accountId) : null;
      case 'open':
        if (item && item.eventId) return openEvent(item.eventId, item.start);
        return n.bookingId ? openRequest(n.bookingId) : null;
      case 'cancel':
        // As from the event's card: the host confirms, and may write the guest a message.
        return item && hooks.cancelBooking ? hooks.cancelBooking({ allDay: false, start: item.start, end: item.end }, item) : null;
      case 'keep':
      case 'dismiss':
        return act(() => api('bookingAction', n.id, action));
    }
    return null;
  };
  return {
    id: `booking:${n.id}`,
    tone: n.tone === 'error' || n.tone === 'warn' ? n.tone : 'info',
    title: String(n.title || ''),
    text: String(n.text || ''),
    actions: (n.actions || []).map((a, i, list) => ({ label: String(a.label || ''), primary: i === list.length - 1 && a.action !== 'dismiss', run: () => run(a.action) }))
  };
}

// The booking page's state from main ('booking' events, bookingState): requests and booked events on the grid, the
// page's notices above it, and the link the composer and this panel copy. The panel follows a page turned on or off.
export function applyBooking(state) {
  const s = state && typeof state === 'object' ? state : null;
  setBooking(s);
  setNotices('booking', s && Array.isArray(s.notices) ? s.notices.map((n) => calendarNotice(n, s)) : []);
  if (ctx && ctx.S && ctx.S.data) ctx.S.data.bookingUrl = s && s.status === 'on' ? s.url || null : null;
  if (isOpen()) {
    const hours = F.host.querySelector('[data-free="hours"]');
    const want = bookingOn();
    if (hours && Boolean(hours.querySelector('option[value="booking"]')) !== want) {
      F.host.innerHTML = controlsHtml();
      refresh();
    } else drawResult();
  }
}
