import { t } from './i18n.js';
import { icons } from './icons.js';
import { api, esc, $, $$, hhmm, toast, dialog, choiceDialog, confirmDialog, showMenu, closeMenu, KEEP_OPEN } from './ui.js';
import {
  DAY,
  prefs,
  savePrefs,
  C,
  ctx,
  hooks,
  calSettings,
  startOfDay,
  addDays,
  firstWeekday,
  weekStart,
  fmt,
  dateValue,
  timeValue,
  parseLocal,
  keptInstant,
  whenText,
  linkify,
  key,
  accounts,
  account,
  calendarOf,
  titleOf,
  eventColor,
  calendarColor,
  eventInput,
  byId,
  shownView,
  range,
  duration,
  inlineDay
} from './calendar-shared.js';

// An event's card next to it in the grid or list, a booking request's card, the quick popover that makes an event
// where the user clicked or dragged, the dialog with every field, and the changes themselves: save, move, delete,
// answer an invitation, cancel a booking. calendar.js draws the view and opens the cards.

const RESPONSES = ['accepted', 'tentative', 'declined'];
const RESPONSE_MARK = { accepted: 'check', declined: 'close', tentative: 'info', needsAction: 'clock' };
// RRULE weekday codes, by Date.getDay().
const WD = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const MAX_REMINDERS = 5;
const MAX_GUESTS = 100;
// Reminder presets, in minutes before the start. All-day ones count back from 00:00 of the event's first day, so
// -540 is that day at 09:00 and 900 the day before at 09:00 (contracts a). Google can't keep a negative value.
const TIMED_PRESETS = [0, 5, 10, 15, 30, 60, 120, 1440, 2880, 10080];
const ALL_DAY_PRESETS = [-540, 900, 2340, 9540];
// The conflict line asks again this long after the times last changed.
const CONFLICT_WAIT = 300;
// The quick popover waits at most this long for its conflict line before it shows.
const REVEAL_WAIT = 250;
// A booking main told the card about is asked again after this long.
const DETAILS_AGE = 60000;

// The view loads again after a change; calendar.js sets this when it loads.
const reload = (ms) => hooks.reload(ms);

const pcZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch (_) {
    return 'UTC';
  }
};

function isZone(text) {
  if (typeof text !== 'string' || !text || text.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: text });
    return true;
  } catch (_) {
    return false;
  }
}

// "GMT+01:00", the offset a zone has at a moment.
function offsetText(zone, at = Date.now()) {
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' }).formatToParts(at).find((p) => p.type === 'timeZoneName');
    return part ? part.value : '';
  } catch (_) {
    return '';
  }
}

// A moment on another zone's clock, "09:00".
function clockIn(ms, zone) {
  try {
    return fmt(ms, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: zone });
  } catch (_) {
    return hhmm(ms);
  }
}

const ADDRESS = /^[^\s@<>()[\]",;:]+@[^\s@<>()[\]",;:]+\.[^\s@<>()[\]",;:.]+$/;
const isAddress = (s) => typeof s === 'string' && s.length <= 320 && ADDRESS.test(s);

// When an event is, for inside a sentence: as whenText, but the weekday keeps the language's own case ("vrijdag 30
// oktober" in Dutch, where whenText starts a line with a capital).
function whenInline(e) {
  if (e.allDay) {
    const last = addDays(e.end, -1);
    return startOfDay(last) === startOfDay(e.start) ? inlineDay(e.start) : `${inlineDay(e.start)} – ${inlineDay(last)}`;
  }
  if (startOfDay(e.start) === startOfDay(e.end - 1)) return `${inlineDay(e.start)}, ${hhmm(e.start)} – ${hhmm(e.end)}`;
  return `${inlineDay(e.start)}, ${hhmm(e.start)} – ${inlineDay(e.end)}, ${hhmm(e.end)}`;
}

// 1 January 2023 was a Sunday: the names of the weekdays in the interface language.
const weekdayName = (wd) => fmt(new Date(2023, 0, 1 + wd).getTime(), { weekday: 'long' });
const weekdayLetter = (wd) => fmt(new Date(2023, 0, 1 + wd).getTime(), { weekday: 'narrow' });
const daysInMonth = (ms) => {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
};

// The start's weekday, day of the month, month and month length on the clock of the zone a series repeats in, and
// how many days that date is from the PC's. The editor shows days as the PC has them; the rule names them as the
// calendar repeats them, in the event's zone, or a Tuesday 08:00 in Amsterdam set in Los Angeles repeats on Wednesdays.
function zoneDay(start, zone) {
  const d = new Date(start);
  const pc = { wd: d.getDay(), day: d.getDate(), month: d.getMonth() + 1, last: daysInMonth(start), shift: 0 };
  if (!zone || !isZone(zone) || zone === pcZone()) return pc;
  const parts = {};
  for (const p of new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(d)) parts[p.type] = Number(p.value);
  const there = Date.UTC(parts.year, parts.month - 1, parts.day);
  const shift = Math.round((there - Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000);
  return { wd: new Date(there).getUTCDay(), day: parts.day, month: parts.month, last: new Date(Date.UTC(parts.year, parts.month, 0)).getUTCDate(), shift };
}
const shiftDay = (wd, n) => (((wd + n) % 7) + 7) % 7;
// The zone the event's series repeats in, for its rule: none for all-day events.
const ruleZone = (v) => (!v.allDay && isZone(v.timeZone) ? v.timeZone : null);

const focusables = (root) =>
  [...root.querySelectorAll('button, input, select, textarea, a[href], [tabindex="0"]')].filter((x) => !x.disabled && !x.closest('[hidden], [inert]') && x.getClientRects().length);

// Tab stays inside a card or the popover, as in a dialog.
function trapTab(ev) {
  if (ev.key !== 'Tab') return;
  const items = focusables(ev.currentTarget);
  if (!items.length) return;
  const first = items[0];
  const last = items[items.length - 1];
  if (ev.shiftKey && (document.activeElement === first || !ev.currentTarget.contains(document.activeElement))) {
    ev.preventDefault();
    last.focus();
  } else if (!ev.shiftKey && (document.activeElement === last || !ev.currentTarget.contains(document.activeElement))) {
    ev.preventDefault();
    first.focus();
  }
}

// Where a card or the popover goes: beside its anchor (an element on the grid, or the point clicked), on the right
// where there is room, else on the left, and inside the window.
function rectOf(anchor) {
  if (anchor instanceof Element) return anchor.isConnected ? anchor.getBoundingClientRect() : null;
  const x = Number(anchor && anchor.x) || window.innerWidth / 2;
  const y = Number(anchor && anchor.y) || window.innerHeight / 3;
  return { left: x, right: x, top: y - 12, bottom: y + 12 };
}

// An anchor that left the page (a redraw) leaves the card where it is.
function place(pop, anchor) {
  const r = rectOf(anchor) || (pop.style.left ? null : { left: window.innerWidth / 2, right: window.innerWidth / 2, top: window.innerHeight / 3, bottom: window.innerHeight / 3 });
  if (!r) return;
  const w = pop.offsetWidth;
  const h = pop.offsetHeight;
  const gap = 8;
  let left = r.right + gap;
  if (left + w > window.innerWidth - 8) left = r.left - gap - w;
  if (left < 8) left = Math.min(window.innerWidth - w - 8, Math.max(8, r.left));
  const top = Math.max(48, Math.min(r.top, window.innerHeight - h - 8));
  pop.style.left = `${Math.max(8, left)}px`;
  pop.style.top = `${Math.max(8, top)}px`;
}

// A click that closed a card or the popover doesn't also start a new event where it landed.
function swallowGridClick(target) {
  if (!target.closest('.calendar [data-cal-col], .calendar [data-cal-allday], .calendar [data-cal-mday]')) return;
  C.swallow = true;
  window.addEventListener('mouseup', () => setTimeout(() => (C.swallow = false), 0), { once: true });
}

// ---------- booking ----------

const bookingOn = () => Boolean(C.booking && C.booking.status === 'on');
const details = new Map();

// The booking an event was made for, when the page's own list has it or main told the card about it lately
// (contracts k, Booking event actions). Only a confirmed one: a cancelled booking's event is a plain event.
function knownBooking(e) {
  if (!e || !e.bookingId || !bookingOn()) return null;
  const list = Array.isArray(C.booking.bookings) ? C.booking.bookings : [];
  const hit = list.find((b) => b && b.id === e.bookingId);
  if (hit) return hit.status === 'confirmed' || !hit.status ? hit : null;
  const seen = details.get(e.bookingId);
  return seen && seen.item && Date.now() - seen.at < DETAILS_AGE ? seen.item : null;
}

// The same, asking main for a booking older than the page's list (bookingDetails).
async function bookingOf(e) {
  const known = knownBooking(e);
  if (known || !e || !e.bookingId || !bookingOn()) return known;
  const seen = details.get(e.bookingId);
  if (seen && seen.pending) return seen.pending;
  if (seen && Date.now() - seen.at < DETAILS_AGE) return seen.item;
  const pending = api('bookingDetails', e.bookingId).then(
    (item) => {
      const ok = item && typeof item === 'object' && item.id === e.bookingId && (item.status === 'confirmed' || !item.status) ? item : null;
      details.set(e.bookingId, { item: ok, at: Date.now() });
      return ok;
    },
    () => {
      details.set(e.bookingId, { item: null, at: Date.now() });
      return null;
    }
  );
  details.set(e.bookingId, { pending });
  return pending;
}

const bookingDevice = () => (C.booking && C.booking.device && C.booking.device.name) || t('calendar.booking.otherComputer');
// A booked event whose meeting has ended is an ordinary event to delete: its guest isn't sent a cancellation.
const over = (e) => e.end <= Date.now();

// What a guest wrote, as text. Their notes don't turn into links: they are someone else's words.
function guestRows(g, start, end, row) {
  const out = [];
  if (!g) {
    out.push(row('person', `<span class="cal-quiet">${esc(t('calendar.booking.noDetails'))}</span>`));
    return out;
  }
  out.push(row('person', `<div class="sel">${esc(g.name || g.email || '')}</div>${g.name && g.email ? `<div class="cal-sub sel">${esc(g.email)}</div>` : ''}`));
  if (g.timeZone) {
    const there = isZone(g.timeZone) ? `${clockIn(start, g.timeZone)} – ${clockIn(end, g.timeZone)}` : '';
    out.push(row('globe', esc(there ? t('calendar.booking.guestTime', { zone: g.timeZone, time: there }) : t('calendar.booking.guestZone', { zone: g.timeZone }))));
  }
  if (g.notes) out.push(row('notes', `<div class="cal-desc cal-guest-notes sel">${esc(g.notes)}</div>`));
  if (g.via) out.push(row('info', `<span class="sel">${esc(t('calendar.booking.via', { via: g.via }))}</span>`));
  return out;
}

// ---------- event card ----------

const cardRow = (icon, html) => `<div class="cal-pop-row"><span class="ic">${icons[icon]}</span><div>${html}</div></div>`;

// Rukoo Voice can record an event from its card while Voice runs, nothing records yet and the event is about to
// start or under way: from 15 minutes before it until it ends.
const RECORD_BEFORE = 15 * 60 * 1000;
function canRecord(e, now = Date.now()) {
  const voice = ctx && ctx.voiceState ? ctx.voiceState() : null;
  return Boolean(voice) && voice.status === 'connected' && !voice.recording && !e.allDay && now >= e.start - RECORD_BEFORE && now < e.end;
}

function popHtml(e, booking) {
  const acc = account(e.accountId);
  const cal = calendarOf(e);
  const guests = e.attendees || [];
  const cancels = Boolean(booking && C.booking.thisDevice && !over(e));
  const deleteTitle = cancels ? t('calendar.booking.cancelShortcut') : t('calendar.event.deleteShortcut');
  const actions = [
    e.canEdit ? `<button class="icon-btn sm" data-pop="edit" title="${esc(t('calendar.event.editShortcut'))}">${icons.edit}</button>` : '',
    writable().length ? `<button class="icon-btn sm" data-pop="duplicate" title="${esc(t('calendar.event.duplicate'))}">${icons.copy}</button>` : '',
    e.canDelete ? `<button class="icon-btn sm" data-pop="delete" title="${esc(deleteTitle)}">${icons.trash}</button>` : '',
    e.link ? `<button class="icon-btn sm" data-href="${esc(e.link)}" title="${esc(t('calendar.event.openGoogle'))}">${icons.popOut}</button>` : '',
    `<button class="icon-btn sm" data-pop="close" title="${esc(t('common.actions.close'))}">${icons.close}</button>`
  ].join('');
  const rows = [];
  if (booking) {
    rows.push(cardRow('booking', `<div>${esc(t('calendar.booking.booked'))}</div>${booking.typeTitle ? `<div class="cal-sub">${esc(booking.typeTitle)}</div>` : ''}`));
    rows.push(...guestRows(booking.guest, e.start, e.end, cardRow));
    if (booking.customLength) rows.push(cardRow('clock', esc(t('calendar.booking.customLength'))));
  }
  if (e.seriesId) rows.push(cardRow('repeat', esc(t('calendar.event.series'))));
  const record = canRecord(e) ? `<button class="link-btn" data-pop="record">${esc(t('calendar.event.record'))}</button>` : '';
  if (e.meeting) rows.push(cardRow('video', `<div class="cal-pop-links"><button class="link-btn" data-href="${esc(e.meeting)}">${esc(t('calendar.event.join'))}</button>${record}</div>`));
  else if (record) rows.push(cardRow('mic', record));
  if (e.location) rows.push(cardRow('pin', /^https?:\/\//.test(e.location) ? linkify(e.location) : `<span class="sel">${esc(e.location)}</span>`));
  if (guests.length) {
    const shown = guests.slice(0, 8);
    const people = shown
      .map((g) => {
        const name = g.name || g.address;
        const role = g.organizer ? `<span class="role">${esc(t('calendar.guests.organizer'))}</span>` : g.optional ? `<span class="role">${esc(t('calendar.guests.optional'))}</span>` : '';
        return `<li class="${esc(g.response)}" title="${esc(`${g.address} · ${t(`calendar.response.${g.response}`)}`)}"><span class="mark" aria-label="${esc(t(`calendar.response.${g.response}`))}">${icons[RESPONSE_MARK[g.response]]}</span><span class="name">${esc(name)}</span>${role}</li>`;
      })
      .join('');
    const more = guests.length > shown.length || e.moreAttendees ? `<li class="more">${esc(t('calendar.guests.more', { count: Math.max(guests.length - shown.length, 1) }))}</li>` : '';
    rows.push(cardRow('people', `<div class="cal-guests-n">${esc(t('calendar.guests.count', { count: guests.length }))}</div><ul class="cal-guests">${people}${more}</ul>`));
  } else if (e.organizer && !e.organizer.self && e.organizer.address) {
    rows.push(cardRow('person', esc(t('calendar.guests.organizedBy', { name: e.organizer.name || e.organizer.address }))));
  }
  if (e.description) rows.push(cardRow('notes', `<div class="cal-desc">${linkify(e.description)}</div>`));
  rows.push(cardRow('calendar', `<span class="cal-dot" style="--c:${eventColor(e)}"></span>${esc(cal ? cal.name : '')}<span class="cal-acc">${esc(acc ? acc.email : '')}</span>`));
  const rsvp = e.canRespond
    ? `<div class="cal-rsvp"><span>${esc(t('calendar.rsvp.question'))}</span><div class="filters" role="group" aria-label="${esc(t('calendar.rsvp.question'))}">${RESPONSES.map(
        (r) => `<button class="filter ${e.response === r ? 'active' : ''}" data-rsvp="${r}" aria-pressed="${e.response === r}">${esc(t(`calendar.rsvp.${r}`))}</button>`
      ).join('')}</div></div>`
    : '';
  return `<div class="cal-pop-bar">${actions}</div>
    <div class="cal-pop-head"><span class="cal-swatch" style="--c:${eventColor(e)}"></span><div><h2 id="cal-pop-title" class="sel">${esc(titleOf(e))}</h2>
      <div class="cal-pop-when">${esc(whenText(e))}</div></div></div>
    ${rows.join('')}${rsvp}`;
}

function popEl() {
  return document.querySelector('.cal-pop');
}

export function openPop(e, anchor, { focus = true } = {}) {
  closeQuick();
  closeRequest();
  let pop = popEl();
  if (!pop) {
    pop = document.createElement('div');
    pop.className = 'cal-pop';
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-labelledby', 'cal-pop-title');
    pop.addEventListener('click', popClick);
    pop.addEventListener('keydown', trapTab);
    document.body.appendChild(pop);
  }
  for (const el of $$('.calendar .open[data-ev]')) el.classList.remove('open');
  anchor.classList.add('open');
  C.pop = e.id;
  // Which of the event's places on screen it was, so a redraw opens the card at the same one.
  C.popIndex = Math.max(0, $$(`.calendar [data-ev="${CSS.escape(e.id)}"]`).indexOf(anchor));
  pop.dataset.id = e.id;
  const booking = knownBooking(e);
  pop.innerHTML = popHtml(e, booking);
  place(pop, anchor);
  if (focus) (pop.querySelector('[data-rsvp], [data-pop="edit"]') || pop.querySelector('[data-pop="close"]')).focus();
  // A booking older than the page's own list: main may still know it, and then the card shows it.
  if (!booking && e.bookingId && bookingOn()) {
    bookingOf(e).then((b) => {
      const open = popEl();
      if (!b || !open || C.pop !== e.id) return;
      const had = document.activeElement && open.contains(document.activeElement) ? document.activeElement.dataset.pop : null;
      open.innerHTML = popHtml(byId(e.id) || e, b);
      const at = $('.calendar .open[data-ev]');
      if (at) place(open, at);
      if (had) open.querySelector(`[data-pop="${had}"]`)?.focus();
    });
  }
}

// The card moves along when its event scrolls, and closes once the event is out of sight. Focusing an event that
// is partly hidden scrolls it into view, so a scroll can come right after the click that opened the card. The
// popover and a request's card move along with their anchors too, but stay open: one may hold a title being typed.
export function followScroll(scroll) {
  if (quick && quick.anchor instanceof Element && quick.anchor.isConnected && scroll.contains(quick.anchor)) place(quick.el, quick.anchor);
  if (reqCard) {
    const at = $(`.calendar [data-request="${CSS.escape(reqCard.id)}"]`);
    if (at && scroll.contains(at)) place(reqCard.el, at);
  }
  const pop = popEl();
  // A multi-day event shows more than once; the open one is the one that was clicked.
  const anchor = C.pop && $('.calendar .open[data-ev]');
  if (!pop || !anchor || !scroll.contains(anchor)) return;
  const a = anchor.getBoundingClientRect();
  const s = scroll.getBoundingClientRect();
  if (a.bottom < s.top || a.top > s.bottom) closePop();
  else place(pop, anchor);
}

// A window resize or a zoom: calendar.js closes the cards through closePop, but the quick popover may hold a title
// being typed, so it stays and moves along. This listener captures, so it runs before calendar.js's.
let resizing = false;
window.addEventListener(
  'resize',
  () => {
    resizing = true;
    setTimeout(() => (resizing = false), 0);
    requestAnimationFrame(() => quick && place(quick.el, quick.anchor));
  },
  true
);

// Closes the event card, and with it a request's card and the quick popover: calendar.js calls this when the view
// changes.
export function closePop(refocus = false) {
  if (!resizing) closeQuick();
  closeRequest();
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
  if (btn.dataset.pop === 'record') {
    closePop();
    return ctx.recordMeeting({ title: e.title || '', eventId: e.id });
  }
  if (btn.dataset.pop === 'edit') return editEvent(e);
  if (btn.dataset.pop === 'duplicate') return duplicateEvent(e);
  if (btn.dataset.pop === 'delete') return removeEvent(e);
  if (btn.dataset.rsvp) return respond(e, btn.dataset.rsvp);
}

document.addEventListener('mousedown', (ev) => {
  const target = ev.target;
  if (target.closest('.scrim, .menu, .cal-gsuggest')) return;
  if (quick && !quick.el.contains(target)) {
    // A save on its way keeps the popover, so a failure still shows in it with the title.
    if (!quick.saving) quick.close();
    swallowGridClick(target);
  }
  if (reqCard && !reqCard.el.contains(target) && !target.closest('[data-request]')) {
    closeRequest();
    swallowGridClick(target);
  }
  if (!C.pop || target.closest('.cal-pop')) return;
  // A click on an event opens that one; the click handler takes care of it.
  if (target.closest('.calendar [data-ev]')) return;
  closePop();
  swallowGridClick(target);
});

// ---------- booking request card ----------

let reqCard = null;

function pendingRequest(id) {
  const list = C.booking && Array.isArray(C.booking.requests) ? C.booking.requests : [];
  return list.find((r) => r && r.id === id && r.status === 'pending') || null;
}

function requestHtml(r) {
  const g = r.guest;
  const name = g && (g.name || g.email);
  const rows = [];
  if (r.typeTitle) rows.push(cardRow('booking', esc(r.typeTitle)));
  rows.push(...guestRows(g, r.start, r.end, cardRow));
  if (Number.isFinite(r.expiresAt)) rows.push(cardRow('clock', esc(t('calendar.booking.expires', { when: `${inlineDay(r.expiresAt)}, ${hhmm(r.expiresAt)}` }))));
  const here = Boolean(C.booking && C.booking.thisDevice);
  const actions = here
    ? `<div class="cal-req-actions"><button class="btn sm" data-req="decline">${esc(t('calendar.booking.decline'))}</button><button class="btn sm primary" data-req="accept">${esc(t('calendar.booking.accept'))}</button></div>`
    : `<p class="cal-req-note">${esc(t('calendar.booking.requestElsewhere', { device: bookingDevice() }))}</p>`;
  return `<div class="cal-pop-bar"><button class="icon-btn sm" data-req="close" title="${esc(t('common.actions.close'))}">${icons.close}</button></div>
    <div class="cal-pop-head"><span class="cal-swatch cal-swatch-req"></span><div><h2 id="cal-req-title" class="sel">${esc(name ? t('calendar.booking.requestFrom', { name }) : t('calendar.booking.request'))}</h2>
      <div class="cal-pop-when">${esc(whenText({ allDay: false, start: r.start, end: r.end }))}</div></div></div>
    ${rows.join('')}<div class="error" data-req-error></div>${actions}`;
}

// A booking request's card (hooks.openRequest): its time, type and guest, with Accept and Decline on the computer
// that handles bookings.
function openRequest(bookingId, anchor) {
  closePop();
  const r = pendingRequest(bookingId);
  if (!r) {
    toast(t('calendar.booking.requestGone'), 5000);
    return;
  }
  const el = document.createElement('div');
  el.className = 'cal-reqcard';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-labelledby', 'cal-req-title');
  el.dataset.id = r.id;
  el.innerHTML = requestHtml(r);
  document.body.appendChild(el);
  reqCard = { el, id: r.id, anchor };
  anchor?.classList?.add('open');
  place(el, anchor);
  el.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation();
      return closeRequest(true);
    }
    trapTab(ev);
    // The calendar's own letter keys don't act behind the card.
    if (!ev.ctrlKey && !ev.metaKey && !ev.altKey) ev.stopPropagation();
  });
  el.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-req]');
    if (!b) return;
    if (b.dataset.req === 'close') return closeRequest(true);
    if (b.dataset.req === 'accept') return acceptRequest(r);
    if (b.dataset.req === 'decline') return declineRequest(r);
  });
  (el.querySelector('[data-req="accept"]') || el.querySelector('[data-req="close"]')).focus();
}
hooks.openRequest = openRequest;
hooks.cancelBooking = (e, b) => cancelBooking(e, b);

function closeRequest(refocus = false) {
  if (!reqCard) return;
  const { el, id, anchor } = reqCard;
  reqCard = null;
  el.remove();
  anchor?.classList?.remove('open');
  if (refocus) ($(`.calendar [data-request="${CSS.escape(id)}"]`) || (anchor && anchor.isConnected ? anchor : null))?.focus();
}

function requestBusy(on) {
  if (!reqCard) return;
  for (const b of $$('[data-req="accept"], [data-req="decline"]', reqCard.el)) b.disabled = on;
}

async function acceptRequest(r) {
  requestBusy(true);
  try {
    await api('bookingAction', r.id, 'accept');
    toast(t('calendar.booking.accepted'));
    closeRequest();
    reload(0);
  } catch (err) {
    requestBusy(false);
    const box = reqCard && reqCard.el.querySelector('[data-req-error]');
    if (box) box.textContent = err.message;
    else toast(err.message, 5000);
  }
}

// Declining can carry a short message for the guest, shown on their booking page; emailing it from the calendar's
// own account is off unless chosen.
async function declineRequest(r) {
  const g = r.guest;
  const name = (g && (g.name || g.email)) || '';
  const from = C.booking && C.booking.resolved && C.booking.resolved.destination && C.booking.resolved.destination.email;
  await messageDialog({
    title: t('calendar.booking.declineTitle'),
    keep: t('common.actions.cancel'),
    act: t('calendar.booking.decline'),
    html: `<p>${esc(name ? t('calendar.booking.declineHelp', { name }) : t('calendar.booking.declineHelpNoName'))}</p>
        <label>${esc(t('calendar.booking.message'))}<textarea name="message" maxlength="500"></textarea></label>
        <label class="inline"><input type="checkbox" name="email"/> ${esc(from ? t('calendar.booking.declineEmailFrom', { address: from }) : t('calendar.booking.declineEmail'))}</label>`,
    async run({ message, email }) {
      requestBusy(true);
      try {
        const opts = {};
        if (message) opts.message = message;
        if (email) opts.email = true;
        await api('bookingAction', r.id, 'decline', opts);
      } catch (err) {
        requestBusy(false);
        throw err;
      }
      toast(t('calendar.booking.declined'));
      closeRequest();
      reload(0);
    }
  });
}

function readMessage(scrim) {
  const message = (scrim.querySelector('[name="message"]')?.value || '').trim().slice(0, 500);
  const email = Boolean(scrim.querySelector('[name="email"]')?.checked);
  return { message, email };
}

// A dialog with a short message for the guest that does its action itself: it stays open while the action runs, and a
// failure shows under the fields with what the host wrote still there. Closed meanwhile, a failure is a toast.
function messageDialog({ title, keep, act, html, run }) {
  let close = null;
  let busy = false;
  return dialog({
    title,
    buttons: [
      { label: keep, value: null },
      {
        label: act,
        danger: true,
        value: (scrim) => {
          if (busy) return KEEP_OPEN;
          busy = true;
          const error = scrim.querySelector('[data-message-error]');
          const buttons = $$('.buttons button', scrim);
          error.textContent = '';
          scrim.querySelector('.dialog').setAttribute('aria-busy', 'true');
          for (const b of buttons) b.disabled = true;
          run(readMessage(scrim)).then(
            () => scrim.isConnected && close(true),
            (err) => {
              busy = false;
              if (!scrim.isConnected) return toast(err.message, 5000);
              scrim.querySelector('.dialog').removeAttribute('aria-busy');
              for (const b of buttons) b.disabled = false;
              error.textContent = err.message;
              scrim.querySelector('[name="message"]')?.focus();
            }
          );
          return KEEP_OPEN;
        }
      }
    ],
    render(body, done) {
      close = done;
      body.innerHTML = `<div class="form cal-message">${html}<div class="error" data-message-error role="alert"></div></div>`;
    }
  });
}

// ---------- calendars ----------

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

// Where an event can move: the other writable calendars of its own account (design 1.1.11).
function moveTargets(e) {
  const a = account(e.accountId);
  if (!a) return [];
  return a.calendars.filter((c) => c.writable || c.id === e.calendarId).map((cal) => ({ a, cal, key: key(a.id, cal.id) }));
}

function calendarAt(k) {
  const [accountId, calendarId] = String(k || '').split('\n');
  const a = account(accountId) || null;
  return { a, cal: (a && a.calendars.find((c) => c.id === calendarId)) || null };
}

// Who sends invitations for a calendar's guests: the provider, or nobody (contracts a).
function invitesOf(k) {
  const { a, cal } = calendarAt(k);
  if (cal && (cal.invites === 'provider' || cal.invites === 'none')) return cal.invites;
  return a && a.kind === 'google' ? 'provider' : 'none';
}

const meetAllowed = (k) => Boolean(calendarAt(k).cal?.conference);

function calendarOptions(list, chosen) {
  const groups = new Map();
  for (const o of list) {
    if (!o.a || !o.cal) continue;
    if (!groups.has(o.a.id)) groups.set(o.a.id, { a: o.a, items: [] });
    groups.get(o.a.id).items.push(o);
  }
  return [...groups.values()]
    .map((g) => `<optgroup label="${esc(g.a.email)}">${g.items.map((o) => `<option value="${esc(o.key)}" ${o.key === chosen ? 'selected' : ''}>${esc(o.cal.name)}</option>`).join('')}</optgroup>`)
    .join('');
}

// ---------- form values ----------

export function fromEvent(e) {
  return { title: e.title, location: e.location, description: e.description, allDay: e.allDay, start: e.start, end: e.end, key: key(e.accountId, e.calendarId) };
}

const hasMeet = (e) => Boolean(e && e.conference && e.conference.solution === 'hangoutsMeet');

// The guests besides the user, as the dialog edits them.
function guestList(e) {
  return (e.attendees || [])
    .filter((a) => !a.self && a.address)
    .map((a) => ({ address: String(a.address).toLowerCase(), name: a.name || '', optional: Boolean(a.optional), response: a.response || 'needsAction', organizer: Boolean(a.organizer), existing: true }));
}

function copyReminders(r) {
  if (!r || typeof r !== 'object') return null;
  const overrides = (Array.isArray(r.overrides) ? r.overrides : [])
    .filter((o) => o && Number.isInteger(Number(o.minutes)))
    .map((o) => ({ method: o.method === 'email' ? 'email' : 'popup', minutes: Number(o.minutes) }));
  return { useDefault: Boolean(r.useDefault), overrides };
}

// A calendar with default reminders (Google) starts a new event on them; elsewhere a new event has none of its own.
function startReminders(k) {
  const cal = calendarAt(k).cal;
  return cal && Array.isArray(cal.defaultReminders) && cal.defaultReminders.length ? { useDefault: true, overrides: [] } : null;
}

// Everything the dialog edits, from an event. The repeat rule comes later, from calendarSeries.
function formValues(e) {
  const series = Boolean(e.seriesId || e.recurring);
  return {
    ...fromEvent(e),
    title: e.title || '',
    location: e.location || '',
    description: e.description || '',
    guests: guestList(e),
    meet: hasMeet(e),
    repeat: series ? { mode: 'loading' } : { mode: 'none' },
    reminders: copyReminders(e.reminders),
    remindersTouched: false,
    timeZone: e.timeZone || pcZone(),
    busy: e.busy !== false,
    busyTouched: true,
    visibility: e.visibility || 'default',
    more: prefs.eventMore === true,
    error: ''
  };
}

// A new event: what the click, drag or keyboard set, on the calendar chosen first.
function newValues(preset, k) {
  return {
    title: '',
    location: '',
    description: '',
    allDay: Boolean(preset.allDay),
    start: preset.start,
    end: preset.end,
    key: k,
    guests: [],
    meet: false,
    repeat: { mode: 'none' },
    reminders: startReminders(k),
    remindersTouched: false,
    timeZone: pcZone(),
    // New all-day events show as free, timed ones as busy (design 1.1.10).
    busy: !preset.allDay,
    busyTouched: false,
    visibility: 'default',
    more: prefs.eventMore === true,
    error: ''
  };
}

// The latest version with what the user changed on top: each field on its own, the times together, and the guests the
// user added, removed or marked optional on the latest list. What the user left alone shows as it is now. The result
// shares no list with latest, which becomes the baseline the next Save compares with.
function rebase(opened, mine, latest) {
  const repeat = mine.repeat.touched ? mine.repeat : latest.repeat.mode === 'loading' ? opened.repeat : latest.repeat;
  const out = { ...latest, key: mine.key, more: mine.more, repeat: { ...repeat }, guests: latest.guests.map((g) => ({ ...g })), reminders: copyReminders(latest.reminders) };
  for (const k of ['title', 'location', 'description', 'meet', 'timeZone', 'visibility']) if (mine[k] !== opened[k]) out[k] = mine[k];
  if (mine.busy !== opened.busy) Object.assign(out, { busy: mine.busy, busyTouched: true });
  if (mine.allDay !== opened.allDay || mine.start !== opened.start || mine.end !== opened.end) Object.assign(out, { allDay: mine.allDay, start: mine.start, end: mine.end });
  const guests = guestDiff(opened.guests, mine.guests);
  if (guests) out.guests = withGuests(out.guests, guests, mine.guests);
  if (!sameReminders(mine.reminders, opened.reminders)) Object.assign(out, { reminders: copyReminders(mine.reminders), remindersTouched: true });
  return out;
}

// A guest list with a GuestDiff applied; added guests come from the user's own list.
function withGuests(list, diff, mine) {
  const gone = new Set(diff.remove || []);
  const optional = diff.optional || {};
  const out = list.filter((g) => !gone.has(g.address)).map((g) => (Object.hasOwn(optional, g.address) ? { ...g, optional: optional[g.address] } : g));
  for (const a of diff.add || []) {
    const g = mine.find((x) => x.address === a.address);
    if (g && !out.some((x) => x.address === a.address)) out.push({ ...g });
  }
  return out;
}

// The event as the calendar store has it now, also when it moved; null when it is gone.
async function latestVersion(e) {
  try {
    return await api('calendarEvent', e.id);
  } catch (_) {
    return null;
  }
}

// ---------- guests ----------

let contacts = null;
let suggestion = null;

// What changed between two guest lists, as the store takes it (contracts a, GuestDiff); null for nothing.
function guestDiff(before, after) {
  const was = new Map(before.map((g) => [g.address, g]));
  const now = new Set(after.map((g) => g.address));
  const out = {};
  const add = after.filter((g) => !was.has(g.address)).map((g) => ({ address: g.address, name: String(g.name || '').slice(0, 200), optional: Boolean(g.optional) }));
  const remove = before.filter((g) => !now.has(g.address)).map((g) => g.address);
  const optional = {};
  for (const g of after) {
    const w = was.get(g.address);
    if (w && Boolean(w.optional) !== Boolean(g.optional)) optional[g.address] = Boolean(g.optional);
  }
  if (add.length) out.add = add;
  if (remove.length) out.remove = remove;
  if (Object.keys(optional).length) out.optional = optional;
  return Object.keys(out).length ? out : null;
}

// How the guests can be changed on the calendar chosen: 'edit' (add, remove, mark optional), 'add' (only add;
// Google's guestsCanInviteOthers), 'view', or null for no guest field. Guests need a calendar whose provider sends the
// invitations (design 1.1.5).
function guestMode(v, e) {
  if (invitesOf(v.key) !== 'provider') return v.guests.length ? 'view' : null;
  if (!e) return 'edit';
  if (e.canInvite === 'edit') return 'edit';
  if (e.canInvite === 'add') return 'add';
  return v.guests.length ? 'view' : null;
}

function chipHtml(g, i, mode) {
  const label = g.name || g.address;
  // A guest just added can go again anywhere; one already invited only where the list can be edited.
  const changeable = mode === 'edit' || !g.existing;
  const mark = g.existing ? `<span class="mark ${esc(g.response)}" aria-label="${esc(t(`calendar.response.${g.response}`))}">${icons[RESPONSE_MARK[g.response] || 'clock']}</span>` : '';
  const opt = g.optional ? `<span class="opt">${esc(t('calendar.guests.optional'))}</span>` : '';
  const inner = `${mark}<span class="n">${esc(label)}</span>${opt}`;
  const main = changeable
    ? `<button type="button" class="cal-gchip-main" data-guest-menu="${i}" title="${esc(g.address)}" aria-haspopup="menu">${inner}</button>`
    : `<span class="cal-gchip-main" title="${esc(g.address)}">${inner}</span>`;
  const x = changeable ? `<button type="button" class="x" data-guest-remove="${i}" aria-label="${esc(t('calendar.guests.remove', { name: label }))}">${icons.close}</button>` : '';
  return `<span class="cal-gchip ${g.optional ? 'optional' : ''} ${changeable ? '' : 'fixed'}">${main}${x}</span>`;
}

function guestsHtml(v, mode) {
  const chips = v.guests.map((g, i) => chipHtml(g, i, mode)).join('');
  const input =
    mode === 'edit' || mode === 'add'
      ? `<input type="text" class="cal-ginput" data-guest-input autocomplete="off" spellcheck="false" role="combobox" aria-autocomplete="list" aria-expanded="false" placeholder="${esc(t('calendar.guests.add'))}" aria-label="${esc(t('calendar.guests.add'))}"/>`
      : '';
  const refused = mode === 'view' && v.guests.some((g) => !g.existing) ? t('errors.calendar.noGuests') : '';
  // The dialog's own .error stays the one message under the form; this line is the guest field's.
  return `<div class="cal-gbox ${mode}" data-guest-box><span class="cal-gchips">${chips}</span>${input}</div><div class="cal-gerror" data-guest-error role="alert">${esc(refused)}</div>`;
}

function closeSuggest() {
  if (!suggestion) return;
  suggestion.el.remove();
  suggestion.input.setAttribute('aria-expanded', 'false');
  suggestion = null;
}

// Escape in a suggestion list or a guest's menu closes only that. ui.js's dialog listens on the document before the
// field does, so without this the whole dialog would close.
window.addEventListener(
  'keydown',
  (ev) => {
    if (ev.key !== 'Escape') return;
    if (suggestion) {
      ev.preventDefault();
      ev.stopPropagation();
      closeSuggest();
    } else if ($('.menu.cal-gmenu')) {
      ev.preventDefault();
      ev.stopPropagation();
      closeMenu({ refocus: true });
    }
  },
  true
);

// The guest chips with their input. Suggestions come from the addresses in synced mail (the contacts IPC); Enter, a
// comma or leaving the field adds what was typed; Backspace in an empty input takes off the last guest just added.
function bindGuests(root, v, mode, onChange) {
  const input = root.querySelector('[data-guest-input]');
  const error = root.querySelector('[data-guest-error]');
  const redraw = (focus = true) => {
    root.querySelector('.cal-gchips').innerHTML = v.guests.map((g, i) => chipHtml(g, i, mode)).join('');
    if (mode === 'view' && !v.guests.some((g) => !g.existing)) error.textContent = '';
    onChange();
    if (focus) (input || root.querySelector('button'))?.focus();
  };
  const add = (list) => {
    for (const c of list) {
      const address = String(c.address || '').trim().toLowerCase();
      if (!isAddress(address) || v.guests.some((g) => g.address === address) || v.guests.length >= MAX_GUESTS) continue;
      v.guests.push({ address, name: c.name || '', optional: false, response: 'needsAction', organizer: false, existing: false });
    }
    redraw();
  };
  // What was typed: addresses, or "Name <address>", separated by commas. Anything that isn't an address stays in the
  // field with a line under it.
  const commit = () => {
    if (!input) return true;
    const parts = input.value.split(/[,;\n]+/).map((s) => s.trim()).filter(Boolean);
    if (!parts.length) {
      input.value = '';
      return true;
    }
    const good = [];
    const bad = [];
    for (const p of parts) {
      const m = /^(.*)<([^>]+)>$/.exec(p);
      const entry = m ? { name: m[1].trim().replace(/^"|"$/g, ''), address: m[2].trim() } : { name: '', address: p };
      (isAddress(entry.address.toLowerCase()) ? good : bad).push(m ? entry : { ...entry, raw: p });
    }
    input.value = bad.map((b) => b.raw || b.address).join(', ');
    error.textContent = bad.length ? t('calendar.guests.invalid', { text: bad[0].raw || bad[0].address }) : '';
    if (good.length) add(good);
    return !bad.length;
  };
  const pick = (c) => {
    input.value = '';
    closeSuggest();
    error.textContent = '';
    add([c]);
  };
  const suggest = async () => {
    const q = input.value.trim().toLowerCase();
    closeSuggest();
    if (!q) return;
    if (!contacts) contacts = await api('contacts').catch(() => []);
    if (input.value.trim().toLowerCase() !== q || !input.isConnected) return;
    const taken = new Set(v.guests.map((g) => g.address));
    const hits = contacts.filter((c) => c && c.address && !taken.has(c.address.toLowerCase()) && `${c.name || ''} ${c.address}`.toLowerCase().includes(q)).slice(0, 6);
    if (!hits.length) return;
    const el = document.createElement('div');
    el.className = 'suggest cal-gsuggest';
    el.setAttribute('role', 'listbox');
    el.innerHTML = hits
      .map((c, i) => `<button type="button" role="option" data-i="${i}" class="${i === 0 ? 'active' : ''}" aria-selected="${i === 0}"><div>${esc(c.name || c.address)}</div><div class="addr">${esc(c.address)}</div></button>`)
      .join('');
    el.addEventListener('mousedown', (ev) => {
      const b = ev.target.closest('button');
      if (!b) return;
      ev.preventDefault();
      pick(hits[Number(b.dataset.i)]);
    });
    document.body.appendChild(el);
    const r = input.closest('.cal-gbox').getBoundingClientRect();
    el.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - el.offsetWidth - 8))}px`;
    el.style.width = `${Math.max(240, r.width)}px`;
    const below = r.bottom + 4;
    el.style.top = `${below + el.offsetHeight > window.innerHeight - 8 ? Math.max(8, r.top - el.offsetHeight - 4) : below}px`;
    input.setAttribute('aria-expanded', 'true');
    suggestion = { el, input, hits };
  };
  const moveActive = (step) => {
    const buttons = $$('button', suggestion.el);
    const i = buttons.findIndex((b) => b.classList.contains('active'));
    const next = (i + step + buttons.length) % buttons.length;
    buttons.forEach((b, j) => {
      b.classList.toggle('active', j === next);
      b.setAttribute('aria-selected', String(j === next));
    });
  };
  root.addEventListener('click', (ev) => {
    const x = ev.target.closest('[data-guest-remove]');
    if (x) {
      v.guests.splice(Number(x.dataset.guestRemove), 1);
      return redraw();
    }
    const chip = ev.target.closest('[data-guest-menu]');
    if (chip) {
      const g = v.guests[Number(chip.dataset.guestMenu)];
      if (!g) return;
      showMenu(
        chip,
        [
          { heading: g.address },
          { label: t('calendar.guests.optional'), checked: g.optional, action: () => ((g.optional = !g.optional), redraw(false), root.querySelector(`[data-guest-menu="${v.guests.indexOf(g)}"]`)?.focus()) },
          { label: t('calendar.guests.removeGuest'), icon: 'close', danger: true, action: () => (v.guests.splice(v.guests.indexOf(g), 1), redraw()) }
        ],
        { align: 'left' }
      );
      $('body > .menu')?.classList.add('cal-gmenu');
      return;
    }
    if (input && ev.target.closest('[data-guest-box]') && !ev.target.closest('button')) input.focus();
  });
  if (!input) return { commit };
  input.addEventListener('input', () => {
    if (/[,;]/.test(input.value)) {
      closeSuggest();
      commit();
      return;
    }
    error.textContent = '';
    suggest();
  });
  input.addEventListener('keydown', (ev) => {
    if (suggestion && (ev.key === 'ArrowDown' || ev.key === 'ArrowUp')) {
      ev.preventDefault();
      return moveActive(ev.key === 'ArrowDown' ? 1 : -1);
    }
    if (ev.key === 'Enter' || (ev.key === 'Tab' && !ev.shiftKey && input.value.trim())) {
      if (suggestion) {
        ev.preventDefault();
        ev.stopPropagation();
        const i = $$('button', suggestion.el).findIndex((b) => b.classList.contains('active'));
        return pick(suggestion.hits[Math.max(0, i)]);
      }
      if (input.value.trim()) {
        ev.preventDefault();
        ev.stopPropagation();
        commit();
      }
      return;
    }
    if (ev.key === 'Backspace' && !input.value) {
      const last = v.guests.length - 1;
      if (last >= 0 && (mode === 'edit' || !v.guests[last].existing)) {
        v.guests.splice(last, 1);
        redraw();
      }
    }
  });
  input.addEventListener('blur', () =>
    setTimeout(() => {
      if (document.activeElement === input) return;
      closeSuggest();
      if (input.isConnected && input.value.trim()) commit();
    }, 120)
  );
  return { commit };
}

// ---------- repeat ----------

// The rule an RRULE value says, as the editor shows it: a preset, the custom form, or a rule outside what the editor
// can show, kept as it is (design 1.1.6). start is the event's start, which presets take their day from; zone the one
// the series repeats in, whose dates the rule names (zoneDay).
function parseRule(text, start, zone = null) {
  if (!text) return { mode: 'none' };
  const kept = { mode: 'kept', kept: String(text) };
  const parts = {};
  for (const p of String(text).toUpperCase().split(';')) {
    const [k, val, rest] = p.split('=');
    if (!k || val === undefined || rest !== undefined || parts[k] !== undefined) return kept;
    parts[k] = val;
  }
  const known = new Set(['FREQ', 'INTERVAL', 'COUNT', 'UNTIL', 'BYDAY', 'BYMONTHDAY', 'BYMONTH', 'WKST']);
  if (Object.keys(parts).some((k) => !known.has(k)) || (parts.COUNT && parts.UNTIL)) return kept;
  const interval = parts.INTERVAL ? Number(parts.INTERVAL) : 1;
  if (!Number.isInteger(interval) || interval < 1 || interval > 999) return kept;
  const z = zoneDay(start, zone);
  const { wd, day, month } = z;
  const pcWd = new Date(start).getDay();
  const out = { mode: 'custom', freq: parts.FREQ, interval, days: [pcWd], monthly: 'day', ends: 'never', until: '', count: 10 };
  if (parts.COUNT) {
    const n = Number(parts.COUNT);
    if (!Number.isInteger(n) || n < 1 || n > 999) return kept;
    Object.assign(out, { ends: 'after', count: n });
  } else if (parts.UNTIL) {
    const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(parts.UNTIL);
    if (!m) return kept;
    const at = m[4] ? (m[7] ? Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime()) : new Date(+m[1], m[2] - 1, +m[3]).getTime();
    Object.assign(out, { ends: 'on', until: dateValue(at) });
  }
  const byday = parts.BYDAY ? parts.BYDAY.split(',') : null;
  if (parts.FREQ === 'DAILY') {
    if (byday || parts.BYMONTHDAY || parts.BYMONTH) return kept;
  } else if (parts.FREQ === 'WEEKLY') {
    if (parts.BYMONTHDAY || parts.BYMONTH) return kept;
    if (byday) {
      if (byday.some((x) => !WD.includes(x))) return kept;
      out.days = [...new Set(byday.map((x) => shiftDay(WD.indexOf(x), -z.shift)))];
    }
  } else if (parts.FREQ === 'MONTHLY') {
    if (parts.BYMONTH || (parts.BYMONTHDAY && byday)) return kept;
    if (parts.BYMONTHDAY && Number(parts.BYMONTHDAY) !== day) return kept;
    if (byday) {
      const m = /^([+-]?\d)?(SU|MO|TU|WE|TH|FR|SA)$/.exec(byday.length === 1 ? byday[0] : '');
      if (!m || WD.indexOf(m[2]) !== wd) return kept;
      const n = Number(m[1] || 0);
      if (n === -1 && day + 7 > z.last) out.monthly = 'last';
      else if (n >= 1 && n <= 4 && n === Math.ceil(day / 7)) out.monthly = 'nth';
      else return kept;
    }
  } else if (parts.FREQ === 'YEARLY') {
    if (byday || (parts.BYMONTH && Number(parts.BYMONTH) !== month) || (parts.BYMONTHDAY && Number(parts.BYMONTHDAY) !== day)) return kept;
  } else return kept;
  // The presets: no interval and no end.
  if (interval === 1 && out.ends === 'never') {
    if (out.freq === 'DAILY') return { ...out, mode: 'daily' };
    if (out.freq === 'WEEKLY' && out.days.length === 5 && [1, 2, 3, 4, 5].every((x) => out.days.includes(x))) return { ...out, mode: 'weekdays' };
    if (out.freq === 'WEEKLY' && out.days.length === 1 && out.days[0] === pcWd) return { ...out, mode: 'weekly' };
    if (out.freq === 'MONTHLY') return { ...out, mode: out.monthly === 'last' ? 'monthlyLast' : out.monthly === 'nth' ? 'monthlyNth' : 'monthlyDay' };
    if (out.freq === 'YEARLY') return { ...out, mode: 'yearly' };
  }
  return out;
}

const untilStamp = (date, allDay) => {
  if (allDay) return date.replace(/-/g, '');
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d, 23, 59, 59).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
};

// The RRULE value the editor stands for, with the user's week start (design 1.1.6); null for no repeat. zone: the one
// the series repeats in; the days the editor shows on the PC's clock are named as they fall there (zoneDay).
function ruleOf(r, start, allDay, zone = null) {
  if (!r || r.mode === 'none' || r.mode === 'loading') return null;
  if (r.mode === 'kept') return r.kept;
  const z = zoneDay(start, allDay ? null : zone);
  const { wd, day } = z;
  const wkst = `WKST=${WD[shiftDay(firstWeekday(), z.shift)]}`;
  // No fifth weekday: one is always the last. "Last" where the zone's date isn't in its month's last week is the nth.
  const nth = Math.ceil(day / 7) > 4 ? -1 : Math.ceil(day / 7);
  const last = day + 7 > z.last ? -1 : nth;
  const weekDays = (days) => {
    const order = [0, 1, 2, 3, 4, 5, 6].map((i) => (firstWeekday() + i) % 7);
    return order.filter((x) => days.includes(x)).map((x) => WD[shiftDay(x, z.shift)]).join(',');
  };
  switch (r.mode) {
    case 'daily':
      return `FREQ=DAILY;${wkst}`;
    case 'weekdays':
      return `FREQ=WEEKLY;BYDAY=${weekDays([1, 2, 3, 4, 5])};${wkst}`;
    case 'weekly':
      return `FREQ=WEEKLY;BYDAY=${WD[wd]};${wkst}`;
    case 'monthlyDay':
      return `FREQ=MONTHLY;BYMONTHDAY=${day};${wkst}`;
    case 'monthlyNth':
      return `FREQ=MONTHLY;BYDAY=${nth}${WD[wd]};${wkst}`;
    case 'monthlyLast':
      return `FREQ=MONTHLY;BYDAY=${last}${WD[wd]};${wkst}`;
    case 'yearly':
      return `FREQ=YEARLY;BYMONTH=${z.month};BYMONTHDAY=${day};${wkst}`;
    default: {
      const parts = [`FREQ=${r.freq}`];
      if (r.interval > 1) parts.push(`INTERVAL=${r.interval}`);
      if (r.freq === 'WEEKLY') parts.push(`BYDAY=${weekDays(r.days)}`);
      if (r.freq === 'MONTHLY') parts.push(r.monthly === 'last' ? `BYDAY=${last}${WD[wd]}` : r.monthly === 'nth' ? `BYDAY=${nth}${WD[wd]}` : `BYMONTHDAY=${day}`);
      if (r.freq === 'YEARLY') parts.push(`BYMONTH=${z.month}`, `BYMONTHDAY=${day}`);
      if (r.ends === 'after') parts.push(`COUNT=${r.count}`);
      if (r.ends === 'on' && r.until) parts.push(`UNTIL=${untilStamp(r.until, allDay)}`);
      parts.push(wkst);
      return parts.join(';');
    }
  }
}

// Two rules that repeat the same way: the same parts whatever their order, an interval of 1 or none, any WKST.
function sameRule(a, b) {
  const norm = (text) => {
    if (!text) return '';
    const map = {};
    for (const p of String(text).toUpperCase().split(';')) {
      const [k, val] = p.split('=');
      if (!k || k === 'WKST' || (k === 'INTERVAL' && val === '1')) continue;
      map[k] = k === 'BYDAY' ? val.split(',').sort().join(',') : val;
    }
    return Object.keys(map)
      .sort()
      .map((k) => `${k}=${map[k]}`)
      .join(';');
  };
  return norm(a) === norm(b);
}

const nthKey = (n) => ['calendar.recurrence.monthlyFirst', 'calendar.recurrence.monthlySecond', 'calendar.recurrence.monthlyThird', 'calendar.recurrence.monthlyFourth'][n - 1];
const onNthKey = (n) => ['calendar.recurrence.onFirst', 'calendar.recurrence.onSecond', 'calendar.recurrence.onThird', 'calendar.recurrence.onFourth'][n - 1];

const PRESET_ORDER = ['none', 'daily', 'weekdays', 'weekly', 'monthlyDay', 'monthlyNth', 'monthlyLast', 'yearly', 'custom', 'kept'];

// The start a series' rule was read against, while the user hasn't touched it: an occurrence opened from the series,
// or moved to another date, still shows the series' own rule ("the last Friday", not the occurrence's new day).
const seriesAnchor = (r) => (r && !r.touched && Number.isFinite(r.anchor) ? r.anchor : null);

// The presets the start date offers: "last" only in the month's last week, no "fifth" (design 1.1.6). With the
// series' anchor, the option the series has now keeps its label from there, also where the start wouldn't offer it.
function repeatChoices(start, current, anchor = null) {
  const out = presetChoices(start, current);
  if (anchor === null || anchor === start) return out;
  const own = presetChoices(anchor, current).find(([m]) => m === current);
  if (!own) return out;
  const i = out.findIndex(([m]) => m === current);
  if (i >= 0) out[i] = own;
  else out.push(own);
  return out.sort((a, b) => PRESET_ORDER.indexOf(a[0]) - PRESET_ORDER.indexOf(b[0]));
}

// A rule the start can't have becomes the monthly one by date: a fifth weekday, or "last" outside the last week.
function fitRepeat(r, start) {
  const day = new Date(start).getDate();
  const noNth = Math.ceil(day / 7) > 4;
  const noLast = day + 7 <= daysInMonth(start);
  if ((r.mode === 'monthlyNth' && noNth) || (r.mode === 'monthlyLast' && noLast)) return { ...r, mode: 'monthlyDay' };
  if (r.mode === 'custom' && r.freq === 'MONTHLY' && ((r.monthly === 'nth' && noNth) || (r.monthly === 'last' && noLast))) return { ...r, monthly: 'day' };
  return r;
}

function presetChoices(start, current) {
  const d = new Date(start);
  const day = d.getDate();
  const weekday = weekdayName(d.getDay());
  const nth = Math.ceil(day / 7);
  const out = [
    ['none', t('calendar.recurrence.none')],
    ['daily', t('calendar.recurrence.daily')],
    ['weekdays', t('calendar.recurrence.weekdays')],
    ['weekly', t('calendar.recurrence.weekly', { weekday })],
    ['monthlyDay', t('calendar.recurrence.monthlyDay', { day })]
  ];
  if (nth <= 4) out.push(['monthlyNth', t(nthKey(nth), { weekday })]);
  if (day + 7 > daysInMonth(start)) out.push(['monthlyLast', t('calendar.recurrence.monthlyLast', { weekday })]);
  out.push(['yearly', t('calendar.recurrence.yearly', { date: fmt(start, { day: 'numeric', month: 'long' }) })]);
  out.push(['custom', t('calendar.recurrence.custom')]);
  if (current === 'kept') out.push(['kept', t('calendar.recurrence.kept')]);
  return out;
}

// What the repeat says in a few words, for the closed More section.
function repeatSummary(r, start) {
  if (!r || r.mode === 'none' || r.mode === 'loading') return '';
  if (r.mode === 'custom') return t('calendar.recurrence.customSummary');
  const hit = repeatChoices(start, r.mode, seriesAnchor(r)).find(([m]) => m === r.mode);
  return hit ? hit[1] : '';
}

// A custom rule starts from the preset it replaces.
function customFrom(r, start) {
  const d = new Date(start);
  const base = { mode: 'custom', interval: 1, days: [d.getDay()], monthly: 'day', ends: 'never', until: '', count: 10 };
  if (r.freq) return { ...base, ...r, mode: 'custom' };
  if (r.mode === 'daily') return { ...base, freq: 'DAILY' };
  if (r.mode === 'weekdays') return { ...base, freq: 'WEEKLY', days: [1, 2, 3, 4, 5] };
  if (r.mode === 'monthlyDay' || r.mode === 'monthlyNth' || r.mode === 'monthlyLast') return { ...base, freq: 'MONTHLY', monthly: r.mode === 'monthlyNth' ? 'nth' : r.mode === 'monthlyLast' ? 'last' : 'day' };
  if (r.mode === 'yearly') return { ...base, freq: 'YEARLY' };
  return { ...base, freq: 'WEEKLY' };
}

function repeatHtml(v) {
  const r = v.repeat;
  if (r.mode === 'loading') {
    return `<label>${esc(t('calendar.recurrence.label'))}<select name="repeat" disabled><option>${esc(t('calendar.recurrence.loading'))}</option></select></label>`;
  }
  const anchor = seriesAnchor(r);
  const choices = repeatChoices(v.start, r.mode, anchor);
  const select = `<label>${esc(t('calendar.recurrence.label'))}<select name="repeat">${choices.map(([m, label]) => `<option value="${m}" ${m === r.mode ? 'selected' : ''}>${esc(label)}</option>`).join('')}</select></label>`;
  // The day the rule repeats on: the series' own until the user changes the rule, then the event's.
  const at = anchor ?? v.start;
  const day = new Date(at).getDate();
  const byDay = r.mode === 'monthlyDay' || (r.mode === 'custom' && r.freq === 'MONTHLY' && r.monthly === 'day');
  const warn = byDay && day >= 29 ? `<p class="field-help cal-warn" data-repeat-warn>${esc(t('calendar.recurrence.shortMonths', { day }))}</p>` : '';
  const kept = r.mode === 'kept' ? `<p class="field-help">${esc(t('calendar.recurrence.keptHelp'))}</p>` : '';
  return `${select}${r.mode === 'custom' ? customHtml(r, v, at) : ''}${warn}${kept}`;
}

function customHtml(r, v, at) {
  const units = ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'];
  const unitKey = { DAILY: 'calendar.recurrence.unitDays', WEEKLY: 'calendar.recurrence.unitWeeks', MONTHLY: 'calendar.recurrence.unitMonths', YEARLY: 'calendar.recurrence.unitYears' };
  const every = `<div class="cal-rline"><span class="cal-rlabel" id="cal-r-every">${esc(t('calendar.recurrence.every'))}</span>
    <input type="number" name="rInterval" class="cal-num" min="1" max="99" value="${Number(r.interval) || 1}" aria-labelledby="cal-r-every"/>
    <select name="rFreq" aria-label="${esc(t('calendar.recurrence.unitLabel'))}">${units.map((u) => `<option value="${u}" ${u === r.freq ? 'selected' : ''}>${esc(t(unitKey[u], { count: Number(r.interval) || 1 }))}</option>`).join('')}</select></div>`;
  let on = '';
  if (r.freq === 'WEEKLY') {
    const order = [0, 1, 2, 3, 4, 5, 6].map((i) => (firstWeekday() + i) % 7);
    on = `<div class="cal-wds" role="group" aria-label="${esc(t('calendar.recurrence.onDays'))}">${order
      .map((wd) => `<button type="button" class="cal-wd" data-wd="${wd}" aria-pressed="${r.days.includes(wd)}" aria-label="${esc(weekdayName(wd))}" title="${esc(weekdayName(wd))}">${esc(weekdayLetter(wd))}</button>`)
      .join('')}</div>`;
  } else if (r.freq === 'MONTHLY') {
    const d = new Date(at);
    const day = d.getDate();
    const weekday = weekdayName(d.getDay());
    const nth = Math.ceil(day / 7);
    const opts = [['day', t('calendar.recurrence.onDay', { day })]];
    if (nth <= 4) opts.push(['nth', t(onNthKey(nth), { weekday })]);
    if (day + 7 > daysInMonth(at)) opts.push(['last', t('calendar.recurrence.onLast', { weekday })]);
    on = `<select name="rMonthly" aria-label="${esc(t('calendar.recurrence.onMonthly'))}">${opts.map(([m, label]) => `<option value="${m}" ${m === r.monthly ? 'selected' : ''}>${esc(label)}</option>`).join('')}</select>`;
  }
  const radio = (value, label, extra = '') =>
    `<div class="cal-end"><label class="inline"><input type="radio" name="rEnds" value="${value}" ${r.ends === value ? 'checked' : ''}/> ${esc(label)}</label>${extra}</div>`;
  const ends = `<div class="cal-ends" role="radiogroup" aria-labelledby="cal-r-ends"><span class="cal-rlabel" id="cal-r-ends">${esc(t('calendar.recurrence.ends'))}</span>
    ${radio('never', t('calendar.recurrence.never'))}
    ${radio('on', t('calendar.recurrence.on'), `<input type="date" name="rUntil" value="${esc(r.until || dateValue(addDays(v.start, 28)))}" aria-label="${esc(t('calendar.recurrence.untilLabel'))}" ${r.ends === 'on' ? '' : 'disabled'}/>`)}
    ${radio('after', t('calendar.recurrence.after'), `<input type="number" name="rCount" class="cal-num" min="1" max="999" value="${Number(r.count) || 10}" aria-label="${esc(t('calendar.recurrence.countLabel'))}" ${r.ends === 'after' ? '' : 'disabled'}/><span class="cal-unit">${esc(t('calendar.recurrence.times', { count: Number(r.count) || 10 }))}</span>`)}
  </div>`;
  return `<div class="cal-rcustom" data-custom>${every}${on}${ends}</div>`;
}

// Checks the custom form; the message, or '' when it can be saved.
function repeatProblem(v) {
  const r = v.repeat;
  if (r.mode !== 'custom') return '';
  if (!Number.isInteger(r.interval) || r.interval < 1 || r.interval > 99) return t('calendar.recurrence.badInterval');
  if (r.freq === 'WEEKLY' && !r.days.length) return t('calendar.recurrence.noDays');
  if (r.ends === 'after' && (!Number.isInteger(r.count) || r.count < 1 || r.count > 999)) return t('calendar.recurrence.badCount');
  if (r.ends === 'on' && (!r.until || r.until < dateValue(v.start))) return t('calendar.recurrence.badUntil');
  return '';
}

function bindRepeat(root, v, onChange) {
  const draw = () => {
    root.innerHTML = repeatHtml(v);
    onChange();
  };
  root.addEventListener('change', (ev) => {
    const el = ev.target;
    const r = v.repeat;
    if (el.name === 'repeat') {
      v.repeat = el.value === 'custom' ? { ...customFrom(r, v.start), touched: true } : el.value === 'kept' ? { ...r, mode: 'kept', touched: true } : { ...r, mode: el.value, touched: true };
      if (el.value === 'kept' && !v.repeat.kept) v.repeat.mode = 'none';
      // A changed rule repeats from the event's own start, which may not offer what the series had.
      v.repeat = fitRepeat(v.repeat, v.start);
      draw();
      root.querySelector('[name="repeat"]')?.focus();
      return;
    }
    r.touched = true;
    if (el.name === 'rInterval') r.interval = Math.round(Number(el.value));
    if (el.name === 'rFreq') r.freq = el.value;
    if (el.name === 'rMonthly') r.monthly = el.value;
    if (el.name === 'rEnds') {
      r.ends = el.value;
      if (r.ends === 'on' && !r.until) r.until = dateValue(addDays(v.start, 28));
    }
    if (el.name === 'rUntil') r.until = el.value;
    if (el.name === 'rCount') r.count = Math.round(Number(el.value));
    v.repeat = fitRepeat(r, v.start);
    const focus = el.name;
    draw();
    root.querySelector(`[name="${focus}"]${focus === 'rEnds' ? `[value="${r.ends}"]` : ''}`)?.focus();
  });
  root.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-wd]');
    if (!b) return;
    const wd = Number(b.dataset.wd);
    const r = v.repeat;
    r.touched = true;
    r.days = r.days.includes(wd) ? r.days.filter((x) => x !== wd) : [...r.days, wd];
    draw();
    root.querySelector(`[data-wd="${wd}"]`)?.focus();
  });
  // The day a preset repeats on follows the start date.
  return { redraw: draw };
}

// ---------- reminders ----------

const plural = (k, count) => t(k, { count });

// "10 minutes before", or for an all-day event "The day before at 09:00".
function reminderLabel(minutes, allDay) {
  if (allDay) {
    const days = Math.ceil(minutes / 1440);
    const at = hhmm(new Date(2023, 0, 1, 0, days * 1440 - minutes).getTime());
    if (days <= 0) return t('calendar.reminders.onTheDay', { time: at });
    if (days === 1) return t('calendar.reminders.dayBefore', { time: at });
    if (days === 7) return t('calendar.reminders.weekBefore', { time: at });
    return t('calendar.reminders.daysBefore', { count: days, time: at });
  }
  if (minutes === 0) return t('calendar.reminders.atStart');
  if (minutes % 10080 === 0) return plural('calendar.reminders.weeks', minutes / 10080);
  if (minutes % 1440 === 0) return plural('calendar.reminders.days', minutes / 1440);
  if (minutes % 60 === 0) return plural('calendar.reminders.hours', minutes / 60);
  if (minutes < 60) return plural('calendar.reminders.minutes', minutes);
  return t('calendar.reminders.before', { time: duration(minutes * 60000) });
}

function reminderPresets(v) {
  if (!v.allDay) return TIMED_PRESETS;
  // Google takes no negative minutes, so "on the day" isn't offered there (contracts a).
  return calendarAt(v.key).a?.kind === 'google' ? ALL_DAY_PRESETS.filter((m) => m >= 0) : ALL_DAY_PRESETS;
}

function remindersHtml(v) {
  const { cal } = calendarAt(v.key);
  const defaults = cal && Array.isArray(cal.defaultReminders) && cal.defaultReminders.length ? cal.defaultReminders : null;
  const r = v.reminders;
  const useDefault = Boolean(defaults && r && r.useDefault);
  let out = `<span class="cal-elabel" id="cal-rem-label">${esc(t('calendar.reminders.label'))}</span>`;
  if (defaults) {
    const popups = defaults.filter((d) => d.method !== 'email').map((d) => reminderLabel(Number(d.minutes), false));
    const detail = !v.allDay && popups.length ? ` <span class="cal-quiet">(${esc(popups.join(', '))})</span>` : '';
    out += `<label class="inline"><input type="checkbox" data-rem-default ${useDefault ? 'checked' : ''}/> ${esc(t('calendar.reminders.useDefault'))}${detail}</label>`;
  }
  if (useDefault) return out;
  const list = (r && r.overrides) || [];
  const presets = reminderPresets(v);
  const rows = list.map((o, i) => {
    if (o.method === 'email') return `<div class="cal-rem email"><span class="ic">${icons.mailOpen}</span><span>${esc(t('calendar.reminders.email', { when: reminderLabel(o.minutes, v.allDay) }))}</span></div>`;
    const values = presets.includes(o.minutes) ? presets : [...presets, o.minutes].sort((a, b) => a - b);
    return `<div class="cal-rem"><span class="ic">${icons.bell}</span><select data-rem="${i}" aria-label="${esc(t('calendar.reminders.which', { n: i + 1 }))}">${values
      .map((m) => `<option value="${m}" ${m === o.minutes ? 'selected' : ''}>${esc(reminderLabel(m, v.allDay))}</option>`)
      .join('')}</select><button type="button" class="icon-btn xs" data-rem-remove="${i}" title="${esc(t('calendar.reminders.remove'))}" aria-label="${esc(t('calendar.reminders.remove'))}">${icons.close}</button></div>`;
  });
  const fallback = calSettings().reminder;
  if (!list.length) {
    const text = r === null && !v.allDay && calSettings().notify !== false && Number.isFinite(fallback) ? t('calendar.reminders.fallback', { when: reminderLabel(fallback, false) }) : t('calendar.reminders.none');
    out += `<p class="field-help">${esc(text)}</p>`;
  }
  out += rows.length ? `<div class="cal-rems">${rows.join('')}</div>` : '';
  if (list.length < MAX_REMINDERS) out += `<button type="button" class="link-btn cal-add" data-rem-add>${icons.plus}${esc(t('calendar.reminders.add'))}</button>`;
  return out;
}

function sameReminders(a, b) {
  const norm = (r) =>
    r
      ? JSON.stringify({ d: Boolean(r.useDefault), o: (r.overrides || []).map((o) => `${o.method}:${o.minutes}`).sort() })
      : 'null';
  return norm(a) === norm(b);
}

function bindReminders(root, v, onChange) {
  const draw = (focus) => {
    root.innerHTML = remindersHtml(v);
    onChange();
    if (focus) root.querySelector(focus)?.focus();
  };
  const own = () => {
    if (!v.reminders || v.reminders.useDefault) {
      const cal = calendarAt(v.key).cal;
      // Leaving the calendar's defaults starts from them, so nothing changes until the user changes it.
      const from = v.reminders && v.reminders.useDefault && cal && Array.isArray(cal.defaultReminders) ? cal.defaultReminders : [];
      v.reminders = { useDefault: false, overrides: from.map((d) => ({ method: d.method === 'email' ? 'email' : 'popup', minutes: Number(d.minutes) })) };
    }
    v.remindersTouched = true;
    return v.reminders;
  };
  root.addEventListener('change', (ev) => {
    const el = ev.target;
    if (el.matches('[data-rem-default]')) {
      if (el.checked) v.reminders = { useDefault: true, overrides: [] };
      else own();
      v.remindersTouched = true;
      return draw('[data-rem-default]');
    }
    if (el.dataset.rem !== undefined) {
      own().overrides[Number(el.dataset.rem)].minutes = Number(el.value);
      return draw(`[data-rem="${el.dataset.rem}"]`);
    }
  });
  root.addEventListener('click', (ev) => {
    const add = ev.target.closest('[data-rem-add]');
    const remove = ev.target.closest('[data-rem-remove]');
    if (add) {
      const list = own().overrides;
      const taken = new Set(list.filter((o) => o.method === 'popup').map((o) => o.minutes));
      const presets = reminderPresets(v);
      const first = v.allDay ? 900 : 10;
      list.push({ method: 'popup', minutes: !taken.has(first) && presets.includes(first) ? first : presets.find((m) => !taken.has(m)) ?? presets[0] });
      return draw(`[data-rem="${list.length - 1}"]`);
    }
    if (remove) {
      own().overrides.splice(Number(remove.dataset.remRemove), 1);
      return draw('[data-rem-add]');
    }
  });
  return { redraw: () => draw() };
}

// From all day to a time or back, a reminder keeps its value where it still means something; a time on the event
// day doesn't exist for a timed event, so that one becomes "at the start".
function fitReminders(v) {
  if (!v.reminders || v.allDay) return;
  for (const o of v.reminders.overrides) if (o.minutes < 0) o.minutes = 0;
}

// ---------- time zones ----------

let zoneOptions = null;
function zoneList() {
  if (zoneOptions) return zoneOptions;
  let list = [];
  try {
    list = Intl.supportedValuesOf('timeZone');
  } catch (_) {
    list = [];
  }
  if (!list.includes('UTC')) list = ['UTC', ...list];
  const now = Date.now();
  zoneOptions = list.map((z) => `<option value="${esc(z)}" label="${esc(`${z.replace(/_/g, ' ')} · ${offsetText(z, now)}`)}"></option>`).join('');
  return zoneOptions;
}

function zoneHelp(v) {
  if (!isZone(v.timeZone)) return t('calendar.timezone.unknown');
  const offset = offsetText(v.timeZone, v.start);
  return v.timeZone === pcZone() ? t('calendar.timezone.computer', { offset }) : offset;
}

// The times on the event's own clock, when its zone isn't this computer's.
function zoneNote(v) {
  if (v.allDay || !isZone(v.timeZone) || v.timeZone === pcZone()) return '';
  return t('calendar.timezone.inZone', { time: `${clockIn(v.start, v.timeZone)} – ${clockIn(v.end, v.timeZone)}`, zone: v.timeZone.replace(/_/g, ' ') });
}

// ---------- conflicts ----------

// The conflict line: busy events on the calendars that count toward availability that overlap the times, asked
// 300 ms after the times last changed, without the event itself (contracts k). The returned function asks; with 0 it
// asks at once, as on opening, so the line is there before anyone reaches for what is below it. answered runs after
// each answer is shown.
function conflictWatcher(box, times, exclude, answered = () => {}) {
  let timer = null;
  let seq = 0;
  const show = (res) => {
    if (!box.isConnected) return;
    const list = res && Array.isArray(res.events) ? res.events : [];
    const failed = res && Array.isArray(res.failed) ? res.failed : [];
    let text = '';
    if (list.length) {
      const first = list[0];
      const when = first.allDay ? t('calendar.conflict.allDay') : `${hhmm(first.start)}–${hhmm(first.end)}`;
      const title = first.title || t('calendar.event.noTitle');
      text = list.length > 1 ? t('calendar.conflict.many', { title, time: when, count: list.length - 1 }) : t('calendar.conflict.one', { title, time: when });
    }
    const unchecked = failed.length ? (failed.length === 1 ? t('calendar.conflict.unchecked', { email: failed[0].email || '' }) : t('calendar.conflict.uncheckedMany', { count: failed.length })) : '';
    box.hidden = !text && !unchecked;
    box.innerHTML = box.hidden ? '' : `<span class="ic">${icons.warning}</span><div>${text ? `<div>${esc(text)}</div>` : ''}${unchecked ? `<div class="cal-quiet">${esc(unchecked)}</div>` : ''}</div>`;
    answered();
  };
  return (wait = CONFLICT_WAIT) => {
    clearTimeout(timer);
    const n = ++seq;
    timer = setTimeout(async () => {
      const r = times();
      if (!r || r.allDay || !(r.end > r.start) || r.end - r.start > 31 * DAY) return n === seq && show(null);
      try {
        const res = await api('calendarConflicts', { start: r.start, end: r.end, exclude: exclude ? [exclude] : [] });
        if (n === seq) show(res);
      } catch (_) {
        if (n === seq) show(null);
      }
    }, wait);
  };
}

// ---------- the dialog ----------

function moreSummary(v) {
  const parts = [];
  const repeat = repeatSummary(v.repeat, v.start);
  if (repeat) parts.push(repeat);
  const r = v.reminders;
  if (r && !r.useDefault) parts.push(r.overrides.length ? plural('calendar.reminders.count', r.overrides.length) : t('calendar.reminders.none'));
  if (!v.allDay && isZone(v.timeZone) && v.timeZone !== pcZone()) parts.push(v.timeZone.replace(/_/g, ' '));
  if (v.busy === v.allDay) parts.push(t(v.busy ? 'calendar.showAs.busy' : 'calendar.showAs.free'));
  if (v.visibility === 'private') parts.push(t('calendar.visibility.private'));
  return parts.join(' · ');
}

function formHtml(v, e) {
  const own = e ? (e.canMove ? moveTargets(e) : [{ a: account(e.accountId), cal: calendarOf(e), key: key(e.accountId, e.calendarId) }]) : writable();
  const fixedCalendar = e && !e.canMove;
  // The chosen calendar's colour, as a dot in the field: the select shows the first calendar when v.key names none of
  // them. bindForm follows a change.
  const shown = own.find((o) => o.a && o.cal && o.key === v.key) || own.find((o) => o.a && o.cal);
  const pickColor = shown ? calendarColor(shown.a.id, shown.cal) : 'var(--accent)';
  const lastDay = v.allDay ? addDays(v.end, -1) : v.end;
  const mode = guestMode(v, e);
  const meetShown = meetAllowed(v.key) || hasMeet(e);
  // An event with another kind of conference (Zoom through an add-on) keeps it; Meet isn't offered beside it.
  const otherConference = Boolean(e && e.conference && e.conference.solution !== 'hangoutsMeet');
  const visibilities = ['default', 'private', ...(['public', 'confidential'].includes(v.visibility) ? [v.visibility] : [])];
  // The instants the fields started from; readTimes keeps them for fields left as they were.
  return `<div class="form cal-form ${v.allDay ? 'all-day' : ''}" data-start="${Number(v.start)}" data-end="${Number(v.end)}">
    <input type="text" name="title" class="cal-form-title" value="${esc(v.title || '')}" placeholder="${esc(t('calendar.dialog.titlePlaceholder'))}" aria-label="${esc(t('calendar.dialog.title'))}" maxlength="1000"/>
    <div class="cal-when">
      <label>${esc(t('calendar.dialog.starts'))}<span class="cal-dt"><input type="date" name="startDate" value="${dateValue(v.start)}"/><input type="time" name="startTime" step="300" value="${timeValue(v.start)}"/></span></label>
      <label>${esc(t('calendar.dialog.ends'))}<span class="cal-dt"><input type="date" name="endDate" value="${dateValue(lastDay)}"/><input type="time" name="endTime" step="300" value="${timeValue(v.end)}"/></span></label>
    </div>
    <div class="cal-when-foot"><label class="inline"><input type="checkbox" name="allDay" ${v.allDay ? 'checked' : ''}/> ${esc(t('calendar.event.allDay'))}</label><span class="cal-zone-note" data-zone-note>${esc(zoneNote(v))}</span></div>
    <div class="cal-conflict" data-conflict role="status" aria-live="polite" hidden></div>
    <label>${esc(t('calendar.dialog.calendar'))}<span class="cal-pick" style="--c:${pickColor}"><span class="cal-dot"></span><select name="calendar" ${fixedCalendar ? 'disabled' : ''}>${calendarOptions(own, v.key)}</select></span></label>
    <p class="field-help" data-move-note hidden></p>
    <div class="cal-efield" data-guests ${mode ? '' : 'hidden'}><span class="cal-elabel">${esc(t('calendar.guests.label'))}</span><div data-guest-host>${mode ? guestsHtml(v, mode) : ''}</div></div>
    ${
      otherConference
        ? ''
        : `<button type="button" class="cal-meet" role="switch" aria-checked="${v.meet}" data-meet ${meetShown ? '' : 'hidden'}><span class="ic">${icons.video}</span><span class="l">${esc(t('calendar.meet.add'))}</span><span class="switch ${v.meet ? 'on' : ''}"></span></button>`
    }
    <label>${esc(t('calendar.dialog.location'))}<input type="text" name="location" value="${esc(v.location || '')}" maxlength="1000"/></label>
    <label>${esc(t('calendar.dialog.description'))}<textarea name="description" maxlength="20000">${esc(v.description || '')}</textarea></label>
    <div class="cal-extras ${v.more ? 'open' : ''}">
      <button type="button" class="cal-extras-toggle" aria-expanded="${v.more}" aria-controls="cal-extras-body" data-extras><span class="chev">${icons.chevronRight}</span><span class="l">${esc(t('calendar.dialog.more'))}</span><span class="sum" data-extras-sum>${esc(moreSummary(v))}</span></button>
      <div class="cal-extras-body" id="cal-extras-body" ${v.more ? '' : 'inert'}><div class="cal-extras-inner">
        <div class="cal-efield" data-repeat>${repeatHtml(v)}</div>
        <div class="cal-efield" data-reminders role="group" aria-labelledby="cal-rem-label">${remindersHtml(v)}</div>
        <label data-zone-field ${v.allDay ? 'hidden' : ''}>${esc(t('calendar.timezone.label'))}<input type="text" name="timeZone" list="cal-zone-list" value="${esc(v.timeZone)}" autocomplete="off" spellcheck="false"/><datalist id="cal-zone-list">${zoneList()}</datalist><span class="field-help" data-zone-help>${esc(zoneHelp(v))}</span></label>
        <div class="cal-pair">
          <label>${esc(t('calendar.showAs.label'))}<select name="busy"><option value="busy" ${v.busy ? 'selected' : ''}>${esc(t('calendar.showAs.busy'))}</option><option value="free" ${v.busy ? '' : 'selected'}>${esc(t('calendar.showAs.free'))}</option></select></label>
          <label>${esc(t('calendar.visibility.label'))}<select name="visibility">${visibilities.map((x) => `<option value="${x}" ${x === v.visibility ? 'selected' : ''}>${esc(t(`calendar.visibility.${x}`))}</option>`).join('')}</select></label>
        </div>
      </div></div>
    </div>
    ${e && e.seriesId ? `<p class="note">${esc(t('calendar.dialog.seriesNote'))}</p>` : ''}
    <div class="error" data-error>${esc(v.error || '')}</div>
  </div>`;
}

// The times the fields say: { allDay, start, end, startDate?, endDate? }, or { error }.
function readTimes(f) {
  const field = (n) => f.querySelector(`[name="${n}"]`);
  const allDay = field('allDay').checked;
  const startDate = field('startDate').value;
  const endDate = field('endDate').value;
  if (!startDate || !endDate || (!allDay && (!field('startTime').value || !field('endTime').value))) return { error: t('calendar.dialog.missingTime') };
  if (allDay) {
    if (endDate < startDate) return { error: t('calendar.dialog.endBeforeStart') };
    const end = dateValue(addDays(parseLocal(endDate), 1));
    return { allDay, startDate, endDate: end, start: parseLocal(startDate), end: parseLocal(end) };
  }
  const start = keptInstant(Number(f.dataset.start), startDate, field('startTime').value);
  const end = keptInstant(Number(f.dataset.end), endDate, field('endTime').value);
  if (end <= start) return { error: t('calendar.dialog.endBeforeStart') };
  return { allDay, start, end };
}

function bindForm(body, v, e, { opened, seriesInfo }) {
  const f = body.querySelector('.cal-form');
  const field = (n) => f.querySelector(`[name="${n}"]`);
  const editing = e || null;
  const at = (date, time) => parseLocal(date || dateValue(Date.now()), field('allDay').checked ? '00:00' : time);
  // Fields that still show the instant they started from keep it, also in the hour that happens twice.
  const instant = (which) => {
    const date = field(`${which}Date`).value || dateValue(Date.now());
    if (field('allDay').checked) return at(date, '00:00');
    return keptInstant(Number(f.dataset[which]), date, field(`${which}Time`).value);
  };
  const startOf = () => instant('start');
  const endOf = () => instant('end');
  // Moving the start moves the end with it, so the event keeps its length: in time for a timed event, in
  // calendar days for an all-day one, whose days are 23 or 25 hours long across a clock change.
  const dayCount = () => Math.round((at(field('endDate').value, '00:00') - at(field('startDate').value, '00:00')) / DAY);
  let length = endOf() - startOf();
  let days = dayCount();
  const remember = () => {
    length = endOf() - startOf();
    days = dayCount();
  };
  const summary = () => {
    const sum = f.querySelector('[data-extras-sum]');
    if (sum) sum.textContent = moreSummary(v);
  };
  const conflicts = conflictWatcher(f.querySelector('[data-conflict]'), () => (readTimes(f).error ? null : readTimes(f)), editing ? editing.id : null);
  const repeat = bindRepeat(f.querySelector('[data-repeat]'), v, summary);
  const reminders = bindReminders(f.querySelector('[data-reminders]'), v, summary);
  let guests = null;
  // A new host each time, so the listeners of the last one go with it.
  const drawGuests = () => {
    const box = f.querySelector('[data-guests]');
    const mode = guestMode(v, editing);
    box.hidden = !mode;
    const host = document.createElement('div');
    host.dataset.guestHost = '';
    host.innerHTML = mode ? guestsHtml(v, mode) : '';
    box.querySelector('[data-guest-host]').replaceWith(host);
    guests = mode ? bindGuests(host, v, mode, () => {}) : null;
  };
  // The times changed: what follows them does too.
  const timesChanged = ({ allDayToggled = false } = {}) => {
    const r = readTimes(f);
    if (!r.error) Object.assign(v, { allDay: r.allDay, start: r.start, end: r.end });
    if (allDayToggled) {
      if (!v.busyTouched) {
        v.busy = !v.allDay;
        field('busy').value = v.busy ? 'busy' : 'free';
      }
      fitReminders(v);
      reminders.redraw();
      f.querySelector('[data-zone-field]').hidden = v.allDay;
    }
    if (v.repeat.mode !== 'loading' && !r.error) {
      // A rule the user chose follows the new date: a preset that date doesn't offer becomes the monthly one by date.
      // A series' own rule stays as it is when one occurrence moves; it isn't sent unless the user changes it.
      if (v.repeat.touched || !(editing && (editing.seriesId || editing.recurring))) v.repeat = fitRepeat(v.repeat, v.start);
      repeat.redraw();
    }
    f.querySelector('[data-zone-note]').textContent = zoneNote(v);
    f.querySelector('[data-zone-help]').textContent = zoneHelp(v);
    summary();
    conflicts();
  };
  const follow = () => {
    if (field('allDay').checked) field('endDate').value = dateValue(addDays(at(field('startDate').value, '00:00'), Math.max(days, 0)));
    else {
      const end = startOf() + Math.max(length, 0);
      field('endDate').value = dateValue(end);
      field('endTime').value = timeValue(end);
      // The end the fields now show is this instant, even where the clock shows that time twice.
      f.dataset.end = String(end);
    }
    remember();
    timesChanged();
  };
  field('startDate').addEventListener('change', follow);
  field('startTime').addEventListener('change', follow);
  for (const n of ['endDate', 'endTime']) {
    field(n).addEventListener('change', () => {
      remember();
      timesChanged();
    });
  }
  field('allDay').addEventListener('change', () => {
    const allDay = field('allDay').checked;
    f.classList.toggle('all-day', allDay);
    // From all day to a time: the hidden times are midnight, which would end the event where it starts or lose its
    // last day. It becomes nine to ten instead, from the first day to the last.
    if (!allDay && field('startTime').value === '00:00' && field('endTime').value === '00:00') {
      field('startTime').value = '09:00';
      field('endTime').value = '10:00';
    }
    remember();
    timesChanged({ allDayToggled: true });
  });
  for (const n of ['title', 'location', 'description']) field(n).addEventListener('input', () => (v[n] = field(n).value));
  field('calendar').addEventListener('change', () => {
    v.key = field('calendar').value;
    const picked = calendarAt(v.key);
    f.querySelector('.cal-pick').style.setProperty('--c', picked.a && picked.cal ? calendarColor(picked.a.id, picked.cal) : 'var(--accent)');
    if (!v.remindersTouched && !editing) v.reminders = startReminders(v.key);
    if (!meetAllowed(v.key) && !hasMeet(editing)) v.meet = false;
    const meet = f.querySelector('[data-meet]');
    if (meet) {
      meet.hidden = !(meetAllowed(v.key) || hasMeet(editing));
      meet.setAttribute('aria-checked', String(v.meet));
      meet.querySelector('.switch').classList.toggle('on', v.meet);
    }
    drawGuests();
    reminders.redraw();
    const note = f.querySelector('[data-move-note]');
    const moving = editing && v.key !== key(editing.accountId, editing.calendarId);
    note.hidden = !moving;
    if (moving) note.textContent = t(editing.seriesId || editing.recurring ? 'calendar.move.seriesNote' : 'calendar.move.note', { calendar: calendarAt(v.key).cal?.name || '' });
    summary();
  });
  f.querySelector('[data-meet]')?.addEventListener('click', (ev) => {
    const b = ev.currentTarget;
    v.meet = !v.meet;
    b.setAttribute('aria-checked', String(v.meet));
    b.querySelector('.switch').classList.toggle('on', v.meet);
  });
  f.querySelector('[data-extras]').addEventListener('click', (ev) => {
    v.more = !v.more;
    prefs.eventMore = v.more;
    savePrefs();
    const wrap = f.querySelector('.cal-extras');
    wrap.classList.toggle('open', v.more);
    ev.currentTarget.setAttribute('aria-expanded', String(v.more));
    f.querySelector('.cal-extras-body').inert = !v.more;
  });
  field('timeZone').addEventListener('input', () => {
    v.timeZone = field('timeZone').value.trim();
    f.querySelector('[data-zone-help]').textContent = zoneHelp(v);
    f.querySelector('[data-zone-help]').classList.toggle('bad', !isZone(v.timeZone));
    f.querySelector('[data-zone-note]').textContent = zoneNote(v);
    summary();
  });
  field('busy').addEventListener('change', () => {
    v.busy = field('busy').value === 'busy';
    v.busyTouched = true;
    summary();
  });
  field('visibility').addEventListener('change', () => {
    v.visibility = field('visibility').value;
    summary();
  });
  drawGuests();
  // Enter in a single-line field saves; in the time zone field it picks from the list.
  f.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && ev.target.tagName === 'INPUT' && !['checkbox', 'radio'].includes(ev.target.type) && ev.target.name !== 'timeZone' && !ev.defaultPrevented) {
      ev.preventDefault();
      body.closest('.dialog').querySelector('.buttons button.primary')?.click();
    }
  });
  // A series' rule arrives after the dialog opened.
  if (seriesInfo && v.repeat.mode === 'loading') {
    seriesInfo.then((info) => {
      const r = repeatFromSeries(info, v.start);
      if (opened && opened.repeat.mode === 'loading') opened.repeat = { ...r };
      if (v.repeat.mode === 'loading') v.repeat = r;
      if (f.isConnected) {
        repeat.redraw();
        summary();
      }
    });
  }
  conflicts(0);
  return { commitGuests: () => (guests ? guests.commit() : true) };
}

// The rule of a series as the editor shows it; more than one rule is shown as kept (contracts b, SeriesInfo). anchor:
// the start it was read against, which its labels keep until the user changes the rule.
function repeatFromSeries(info, start) {
  if (!info) return { mode: 'kept', kept: '', unknown: true };
  if (Array.isArray(info.rules) && info.rules.length > 1) return { mode: 'kept', kept: info.rule };
  const anchor = Number.isFinite(info.start) ? info.start : start;
  return { ...parseRule(info.rule, anchor, info.allDay ? null : info.timeZone), anchor };
}

// Checks the whole form; the values with their times, or KEEP_OPEN after saying what to fix.
function readForm(scrim, v, form) {
  const f = scrim.querySelector('.cal-form');
  const fail = (message, focus) => {
    f.querySelector('[data-error]').textContent = message;
    if (focus) {
      if (focus.closest('.cal-extras-body') && !v.more) f.querySelector('[data-extras]').click();
      focus.focus();
    }
    return KEEP_OPEN;
  };
  const r = readTimes(f);
  if (r.error) return fail(r.error);
  Object.assign(v, { allDay: r.allDay, start: r.start, end: r.end, startDate: r.startDate, endDate: r.endDate });
  for (const n of ['title', 'location', 'description']) v[n] = f.querySelector(`[name="${n}"]`).value;
  const calendar = f.querySelector('[name="calendar"]').value;
  if (!calendar || !calendar.includes('\n')) return fail(t('calendar.dialog.noCalendar'));
  v.key = calendar;
  if (!form.commitGuests()) return fail(t('calendar.guests.fix'), f.querySelector('[data-guest-input]'));
  if (v.guests.some((g) => !g.existing) && invitesOf(v.key) !== 'provider') return fail(t('errors.calendar.noGuests'));
  const problem = repeatProblem(v);
  if (problem) return fail(problem, f.querySelector('[data-repeat] select, [data-repeat] input'));
  if (!v.allDay && !isZone(v.timeZone) && v.timeZone !== (form.openedZone || '')) return fail(t('calendar.timezone.invalid'), f.querySelector('[name="timeZone"]'));
  return { ...v };
}

// The input calendarCreate takes for a new event.
function createInput(v) {
  const [accountId, calendarId] = v.key.split('\n');
  const input = { accountId, calendarId, title: v.title.trim(), location: v.location.trim(), description: v.description, allDay: v.allDay, start: v.start, end: v.end };
  if (v.allDay) {
    input.startDate = dateValue(v.start);
    input.endDate = dateValue(v.end);
  }
  if (v.guests.length && invitesOf(v.key) === 'provider') input.guests = { add: v.guests.map((g) => ({ address: g.address, name: String(g.name || '').slice(0, 200), optional: Boolean(g.optional) })) };
  if (v.meet && meetAllowed(v.key)) input.addMeet = true;
  const rule = ruleOf(v.repeat, v.start, v.allDay, ruleZone(v));
  if (rule) input.recurrence = rule;
  if (v.reminders && (v.remindersTouched || !v.reminders.useDefault) && !sameReminders(v.reminders, startReminders(v.key))) input.reminders = cleanReminders(v.reminders, v);
  if (!v.allDay && isZone(v.timeZone) && v.timeZone !== pcZone()) input.timeZone = v.timeZone;
  input.busy = Boolean(v.busy);
  if (v.visibility && v.visibility !== 'default') input.visibility = v.visibility;
  return input;
}

// Google keeps no negative minutes; the dialog never offers one there, and one left from an all-day event that
// became a timed one is "at the start" by now.
function cleanReminders(r, v) {
  return { useDefault: Boolean(r.useDefault), overrides: r.overrides.slice(0, MAX_REMINDERS).map((o) => ({ method: o.method, minutes: v.allDay ? o.minutes : Math.max(0, o.minutes) })) };
}

// The input calendarUpdate takes: today's fields in full (eventInput), the newer ones only where the user changed
// them, so nothing the dialog didn't touch is rewritten (contracts a). changed: whether anything is to be saved;
// shared: whether guests would see it, rather than only the user's own reminders, show as and visibility.
function editInput(e, v, opened, series) {
  const input = eventInput(e, { title: v.title.trim(), location: v.location.trim(), description: v.description, allDay: v.allDay, start: v.start, end: v.end });
  let changed =
    input.title !== (opened.title || '').trim() ||
    input.location !== (opened.location || '').trim() ||
    input.description !== (opened.description || '') ||
    v.allDay !== opened.allDay ||
    v.start !== opened.start ||
    v.end !== opened.end;
  const guests = guestDiff(opened.guests, v.guests);
  if (guests) input.guests = guests;
  if (v.meet !== opened.meet) input.addMeet = v.meet;
  let ruleChanged = false;
  if (v.repeat.touched && v.repeat.mode !== 'loading') {
    const rule = ruleOf(v.repeat, v.start, v.allDay, ruleZone(v));
    const before = series ? series.rule : null;
    if (!sameRule(rule, before) && !(rule === null && !before)) {
      input.recurrence = rule;
      ruleChanged = Boolean(e.seriesId || e.recurring);
    }
  }
  if (v.reminders && !sameReminders(v.reminders, opened.reminders)) input.reminders = cleanReminders(v.reminders, v);
  // A zone with a name Intl doesn't know (an Outlook event's) is sent only when the user picked another.
  if (!v.allDay && v.timeZone !== opened.timeZone && isZone(v.timeZone)) input.timeZone = v.timeZone;
  if (v.busy !== opened.busy) input.busy = Boolean(v.busy);
  if (v.visibility !== opened.visibility) input.visibility = v.visibility;
  const shared = changed || ['guests', 'addMeet', 'recurrence', 'timeZone'].some((k) => input[k] !== undefined);
  changed = shared || ['reminders', 'busy', 'visibility'].some((k) => input[k] !== undefined);
  return { input, changed, shared, ruleChanged };
}

// A new event's id, made when its popover or dialog opens, so a Save tried again after a lost answer finds the event
// it made instead of making a second one. Google wants base32hex: 0-9 and a-v.
function newEventId() {
  const digits = '0123456789abcdefghijklmnopqrstuv';
  return Array.from(crypto.getRandomValues(new Uint8Array(26)), (b) => digits[b & 31]).join('');
}

// Whether guests of a new event get their invitations. A server that schedules sends them anyway (design 2.7).
async function askInvite(v) {
  if (!v.guests.length) return false;
  const a = calendarAt(v.key).a;
  if (!a || a.kind === 'demo') return false;
  if (a.kind === 'caldav') return true;
  return dialog({
    title: t('calendar.notify.createTitle'),
    body: `<p>${esc(t('calendar.notify.help', { count: v.guests.length }))}</p>`,
    buttons: [
      { label: t('common.actions.cancel'), value: null },
      { label: t('calendar.notify.dontSend'), value: false },
      { label: t('calendar.notify.send'), value: true, primary: true }
    ]
  });
}

// Shows a saved event that lies outside what is on screen.
function showSaved(saved) {
  const r = range();
  if (saved && (saved.start >= r.end || saved.end <= r.start) && shownView() !== 'upcoming') C.date = startOfDay(saved.start);
  C.pop = null;
  reload(0);
}

// Makes the event; 'back' when the user stopped at the invitation question. Throws what the calendar answered.
async function createEvent(v, id) {
  const notify = await askInvite(v);
  if (notify === null) return 'back';
  const saved = await api('calendarCreate', { ...createInput(v), id }, { notify });
  prefs.calendar = v.key;
  savePrefs();
  toast(t('calendar.event.created'));
  showSaved(saved);
  return 'saved';
}

// Saves a change: the fields first, then the move to another calendar with the id the change gave back (contracts c).
async function saveEdit(state) {
  const { e, v, opened, series } = state;
  const { input, changed, shared, ruleChanged } = editInput(e, v, opened, series);
  const target = v.key !== key(e.accountId, e.calendarId) ? v.key.split('\n')[1] : null;
  if (!changed && !target) {
    C.pop = null;
    return 'saved';
  }
  let scope = 'one';
  if (changed && (e.seriesId || e.recurring)) {
    // A new rule is for the series: this and following, or all of it (design 1.1.6).
    scope = await seriesChoice(t('calendar.series.editTitle'), e, { wide: ruleChanged });
    if (!scope) return 'back';
  }
  // A change only the user sees (reminders, show as, visibility) goes to nobody, without asking.
  const notify = shared || target ? await notifyGuests(e, 'update', { guests: v.guests.length }) : false;
  if (notify === null) return 'back';
  let saved = e;
  if (changed) {
    // The version this dialog opened: a newer one in the calendar makes the save fail instead of overwriting it.
    saved = await api('calendarUpdate', e.id, input, { notify, etag: e.etag, scope, seriesEtag: scope === 'one' ? null : (series && series.etag) || null });
    // Saved: should the move fail, trying again only moves.
    const now = saved || (await latestVersion(e));
    if (now) {
      state.e = now;
      state.opened = { ...formValues(now), repeat: state.opened.repeat };
    }
  }
  if (target) {
    const from = state.e || e;
    saved = await api('calendarMove', from.id, target, { notify });
    toast(t('calendar.move.done', { calendar: calendarAt(v.key).cal?.name || '' }));
  }
  showSaved(saved);
  return 'saved';
}

// The full dialog: a new event (e null; preset or values from the popover or Duplicate) or a change to e. It stays
// in a loop until saved or cancelled: an error opens it again with what the user typed and the message, and a
// version changed elsewhere puts the user's changes on top of it.
async function eventDialog(e, preset, { values = null, createId = null } = {}) {
  const options = writable();
  if (!e && !options.length) {
    toast(t('calendar.errors.noWritable'), 5000);
    return;
  }
  const id = e ? null : createId || newEventId();
  const state = { e, v: values || (e ? formValues(e) : newValues(preset, options[0].key)), opened: e ? formValues(e) : null, series: null };
  if (!state.v.key || (!e && !options.some((o) => o.key === state.v.key))) state.v.key = options[0].key;
  const openedZone = state.v.timeZone;
  const seriesInfo =
    e && (e.seriesId || e.recurring)
      ? api('calendarSeries', e.id)
          .then((info) => (state.series = info))
          .catch(() => null)
      : null;
  for (;;) {
    let form = null;
    const result = await dialog({
      title: e ? t('calendar.dialog.editTitle') : t('calendar.dialog.newTitle'),
      wide: true,
      buttons: [
        { label: t('common.actions.cancel'), value: null },
        { label: t('common.actions.save'), value: (scrim) => readForm(scrim, state.v, form), primary: true }
      ],
      render(body) {
        // Hung from the top, not centred: the conflict line, guest chips and More grow it downward without moving
        // the fields above them.
        body.closest('.scrim')?.classList.add('cal-scrim');
        body.innerHTML = formHtml(state.v, state.e);
        form = bindForm(body, state.v, state.e, { opened: state.opened, seriesInfo });
        form.openedZone = openedZone;
      }
    });
    closeSuggest();
    if (!result) return;
    state.v.error = '';
    try {
      const done = state.e ? await saveEdit(state) : await createEvent(state.v, id);
      if (done === 'saved') return;
    } catch (err) {
      state.v.error = err.message;
      // Changed elsewhere since the dialog opened: the dialog continues from the latest version, with the user's own
      // changes on top, and the next Save applies them to that version.
      const latest = state.e && (await latestVersion(state.e));
      if (latest && latest.etag !== state.e.etag) {
        state.v = { ...rebase(state.opened, state.v, formValues(latest)), error: t('calendar.dialog.changedElsewhere') };
        // Its own copy: the dialog edits state.v's guests and reminders in place.
        state.opened = { ...formValues(latest), repeat: state.opened.repeat };
        state.e = latest;
        // The series' version moved on too.
        if (latest.seriesId || latest.recurring) state.series = (await api('calendarSeries', latest.id).catch(() => null)) || state.series;
      }
    }
  }
}

export function editEvent(e) {
  closePop();
  eventDialog(e);
}

// Duplicate (design 1.1.11): the dialog for a new event with the same fields, on the same calendar when it takes new
// events. The guests are invited anew; the rule of a series comes along.
async function duplicateEvent(e) {
  closePop();
  const options = writable();
  if (!options.length) {
    toast(t('calendar.errors.noWritable'), 5000);
    return;
  }
  const own = key(e.accountId, e.calendarId);
  const v = formValues(e);
  v.key = options.some((o) => o.key === own) ? own : options[0].key;
  v.guests = invitesOf(v.key) === 'provider' ? v.guests.map((g) => ({ ...g, existing: false, response: 'needsAction' })) : [];
  v.meet = v.meet && meetAllowed(v.key);
  v.busyTouched = true;
  v.remindersTouched = Boolean(v.reminders);
  v.repeat = { mode: 'none' };
  if (e.seriesId || e.recurring) {
    const info = await api('calendarSeries', e.id).catch(() => null);
    // The copy repeats from its own start, which may not offer what the series had.
    if (info && info.rule) v.repeat = fitRepeat({ ...repeatFromSeries(info, e.start), touched: true }, v.start);
  }
  return eventDialog(null, null, { values: v });
}

// ---------- quick popover ----------

let quick = null;

function closeQuick() {
  if (quick) quick.close(false);
}

function quickHtml(v) {
  const mode = guestMode(v, null);
  const { cal } = calendarAt(v.key);
  return `<div class="cal-quick-body">
    <input type="text" name="title" class="cal-quick-title" placeholder="${esc(t('calendar.dialog.titlePlaceholder'))}" aria-label="${esc(t('calendar.dialog.title'))}" maxlength="1000" value="${esc(v.title)}"/>
    <div class="cal-pop-row"><span class="ic">${icons.clock}</span><div class="cal-quick-when">${esc(whenText(v))}</div></div>
    <div class="cal-conflict" data-conflict role="status" aria-live="polite" hidden></div>
    <div class="cal-pop-row cal-quick-cal"><span class="ic"><span class="cal-dot" data-quick-dot style="--c:${cal ? calendarColor(calendarAt(v.key).a.id, cal) : 'var(--accent)'}"></span></span><div><select name="calendar" aria-label="${esc(t('calendar.dialog.calendar'))}">${calendarOptions(writable(), v.key)}</select></div></div>
    <div class="cal-pop-row" data-guests ${mode ? '' : 'hidden'}><span class="ic">${icons.people}</span><div class="cal-efield" data-guest-host>${mode ? guestsHtml(v, mode) : ''}</div></div>
    <button type="button" class="cal-meet" role="switch" aria-checked="${v.meet}" data-meet ${meetAllowed(v.key) ? '' : 'hidden'}><span class="ic">${icons.video}</span><span class="l">${esc(t('calendar.meet.add'))}</span><span class="switch ${v.meet ? 'on' : ''}"></span></button>
    <div class="error" data-error></div>
  </div>
  <div class="cal-quick-bar"><button type="button" class="btn sm" data-quick="more">${esc(t('calendar.quick.more'))}</button><button type="button" class="btn sm primary" data-quick="save">${esc(t('common.actions.save'))}</button></div>`;
}

// The quick popover for a new event, beside the click or drag that made it (design 1.1.3): a title, the time, the
// calendar, guests and Google Meet where the calendar has them, and the conflict line. Enter saves; More options opens
// the dialog with what was typed. The promise settles when the popover or that dialog closes, saved or not, and never
// earlier: calendar.js keeps a drag's ghost on the grid until then (contracts, B1 item 1).
function quickCreate(preset, anchor) {
  return new Promise((resolve) => {
    const options = writable();
    if (!options.length) {
      toast(t('calendar.errors.noWritable'), 5000);
      resolve();
      return;
    }
    const v = newValues(preset, options[0].key);
    const createId = newEventId();
    const before = document.activeElement;
    const el = document.createElement('div');
    // Measuring: there for the keyboard but not yet shown, until it knows its height (reveal below).
    el.className = 'cal-quick measuring';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', t('calendar.dialog.newTitle'));
    el.innerHTML = quickHtml(v);
    document.body.appendChild(el);
    let guests = null;
    // saving: a save on its way, which outside clicks and Escape leave alone (the document's mousedown reads it).
    const state = { el, anchor, saving: false };
    const field = (n) => el.querySelector(`[name="${n}"]`);
    const finish = ({ refocus = false } = {}) => {
      if (quick !== state) return false;
      quick = null;
      closeSuggest();
      el.remove();
      sizes.disconnect();
      if (refocus && before && before.isConnected) before.focus();
      return true;
    };
    state.close = (refocus = false) => {
      if (finish({ refocus })) resolve();
    };
    quick = state;
    // The conflict line and the guests come and go; the popover stays inside the window and beside its anchor.
    const sizes = new ResizeObserver(() => quick === state && place(el, anchor));
    const drawGuests = () => {
      const row = el.querySelector('[data-guests]');
      const mode = guestMode(v, null);
      row.hidden = !mode;
      const host = document.createElement('div');
      host.className = 'cal-efield';
      host.dataset.guestHost = '';
      host.innerHTML = mode ? guestsHtml(v, mode) : '';
      row.querySelector('[data-guest-host]').replaceWith(host);
      guests = mode ? bindGuests(host, v, mode, () => place(el, anchor)) : null;
    };
    const error = (text) => {
      el.querySelector('[data-error]').textContent = text || '';
      place(el, anchor);
    };
    const read = () => {
      v.title = field('title').value;
      v.key = field('calendar').value;
    };
    const save = async () => {
      if (state.saving) return;
      read();
      if (guests && !guests.commit()) return error(t('calendar.guests.fix'));
      if (v.guests.length && invitesOf(v.key) !== 'provider') return error(t('errors.calendar.noGuests'));
      state.saving = true;
      el.classList.add('saving');
      el.setAttribute('aria-busy', 'true');
      for (const b of $$('.cal-quick-bar button', el)) b.disabled = true;
      try {
        const done = await createEvent(v, createId);
        if (done === 'saved') {
          if (finish()) resolve();
          return;
        }
      } catch (err) {
        // The view changed while the save was on its way and took the popover along: the failure is a toast.
        if (quick !== state) return toast(err.message, 5000);
        error(err.message);
      }
      state.saving = false;
      if (quick !== state) return;
      el.classList.remove('saving');
      el.removeAttribute('aria-busy');
      for (const b of $$('.cal-quick-bar button', el)) b.disabled = false;
      field('title').focus();
    };
    const more = async () => {
      if (state.saving) return;
      read();
      guests?.commit();
      if (!finish()) return;
      await eventDialog(null, null, { values: v, createId });
      resolve();
    };
    el.addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-quick], [data-meet]');
      if (!b) return;
      if (b.dataset.quick === 'save') return save();
      if (b.dataset.quick === 'more') return more();
      if (b.matches('[data-meet]')) {
        v.meet = !v.meet;
        b.setAttribute('aria-checked', String(v.meet));
        b.querySelector('.switch').classList.toggle('on', v.meet);
      }
    });
    field('calendar').addEventListener('change', () => {
      v.key = field('calendar').value;
      v.reminders = startReminders(v.key);
      const { a, cal } = calendarAt(v.key);
      el.querySelector('[data-quick-dot]').style.setProperty('--c', a && cal ? calendarColor(a.id, cal) : 'var(--accent)');
      if (!meetAllowed(v.key)) v.meet = false;
      const meet = el.querySelector('[data-meet]');
      meet.hidden = !meetAllowed(v.key);
      meet.setAttribute('aria-checked', String(v.meet));
      meet.querySelector('.switch').classList.toggle('on', v.meet);
      drawGuests();
      place(el, anchor);
    });
    field('title').addEventListener('input', () => (v.title = field('title').value));
    el.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        ev.stopPropagation();
        return state.saving ? undefined : state.close(true);
      }
      trapTab(ev);
      if (ev.key === 'Enter' && !ev.defaultPrevented && ev.target.matches('input[type="text"], select')) {
        ev.preventDefault();
        save();
      }
      // The calendar's own letter keys don't act behind the popover.
      if (!ev.ctrlKey && !ev.metaKey && !ev.altKey) ev.stopPropagation();
    });
    drawGuests();
    place(el, anchor);
    // The popover's times don't change, so the conflict line is asked once, at once, and the popover shows when it
    // knows whether the line is there: it opens at its height instead of growing under the user's pointer. A slow
    // answer doesn't hold it back for longer than REVEAL_WAIT.
    const reveal = () => {
      if (quick !== state || !el.classList.contains('measuring')) return;
      el.classList.remove('measuring');
      place(el, anchor);
    };
    conflictWatcher(el.querySelector('[data-conflict]'), () => v, null, reveal)(0);
    setTimeout(reveal, REVEAL_WAIT);
    sizes.observe(el);
    field('title').focus();
  });
}

// Where the last click on the grid landed: calendar.js makes a new event from a click without passing an anchor, and
// the popover goes there. Cleared once the click has been handled.
let lastPoint = null;
for (const type of ['click', 'dblclick']) {
  document.addEventListener(
    type,
    (ev) => {
      const inGrid = ev.detail > 0 && ev.target.closest && ev.target.closest('.calendar [data-cal-col], .calendar [data-cal-allday], .calendar [data-cal-mday]');
      lastPoint = inGrid ? { x: ev.clientX, y: ev.clientY } : null;
      setTimeout(() => (lastPoint = null), 0);
    },
    true
  );
}

// A new event. From the grid (a click, a drag, a double click in the month) the quick popover opens beside it; from
// the toolbar or the keyboard the full dialog. The promise settles when the popover or the dialog closes.
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
  // A drag on the grid says where the event ends too.
  const end = Number.isFinite(preset.end) && preset.end > start ? preset.end : allDay ? addDays(start, 1) : start + 3600000;
  const anchor = preset.anchor || (preset.start ? lastPoint : null);
  if (anchor) return quickCreate({ allDay, start, end }, anchor);
  return eventDialog(null, { allDay, start, end });
}

// ---------- changes ----------

// Guests hear about a change only when the user says so, as Google Calendar asks. guests: how many guests besides the
// user the event has after the change, when the dialog changed the list.
export async function notifyGuests(e, what, { guests = null } = {}) {
  const a = account(e.accountId);
  // The demo account's guests are made up and nobody emails them, so there is nothing to ask.
  if (a?.kind === 'demo') return false;
  const others = (e.attendees || []).filter((x) => !x.self).length;
  const count = Number.isInteger(guests) ? Math.max(guests, others) : others;
  if (!count) return false;
  // A CalDAV server that schedules sends the invitations itself, whatever Rukoo asks (contracts, A3 item 3).
  if (a?.kind === 'caldav' && calendarOf(e)?.invites === 'provider') return true;
  if (!e.organizer || !e.organizer.self) return false;
  return dialog({
    title: t(`calendar.notify.${what}Title`),
    body: `<p>${esc(t('calendar.notify.help', { count }))}</p>`,
    buttons: [
      { label: t('common.actions.cancel'), value: null },
      { label: t('calendar.notify.dontSend'), value: false },
      { label: t('calendar.notify.send'), value: true, primary: true }
    ]
  });
}

// Which events of a series a change is for. "This and following" is for the organizer (or an event without one);
// wide leaves out "This event", for a change of the rule itself (design 1.1.6).
export function seriesChoice(title, e, { wide = false } = {}) {
  const following = Boolean(e) && (!e.organizer || e.organizer.self);
  const options = [];
  if (!wide) options.push({ label: t('calendar.series.one'), value: 'one' });
  if (following) options.push({ label: t('calendar.series.following'), value: 'following' });
  options.push({ label: t('calendar.series.all'), value: 'all' });
  return choiceDialog(title, options, wide ? options[0].value : 'one');
}

export async function removeEvent(e) {
  closePop();
  const booking = over(e) ? null : await bookingOf(e);
  // On the computer that handles bookings, deleting a booked event cancels the booking (contracts k).
  if (booking && C.booking.thisDevice) return cancelBooking(e, booking);
  let scope = 'one';
  if (e.seriesId || e.recurring) {
    scope = await seriesChoice(t('calendar.series.deleteTitle'), e);
    if (!scope) return;
  } else {
    const help = booking ? t('calendar.booking.deleteElsewhere', { device: bookingDevice() }) : t('calendar.event.deleteHelp', { title: titleOf(e) });
    if (!(await confirmDialog(booking ? t('calendar.booking.deleteTitle') : t('calendar.event.deleteTitle'), help, t('common.actions.delete'), true))) return;
  }
  const notify = await notifyGuests(e, 'delete');
  if (notify === null) return;
  let seriesEtag = null;
  if (scope !== 'one') seriesEtag = (await api('calendarSeries', e.id).catch(() => null))?.etag || null;
  try {
    await api('calendarDelete', e.id, { notify, scope, series: scope === 'all', etag: e.etag, seriesEtag });
    toast(t('calendar.event.deleted'));
  } catch (err) {
    toast(err.message, 5000);
  }
  reload(0);
}

// Cancel booking: the event goes, the guest hears it from the calendar, and may read a short message from the host
// on their confirmation page. e: the booked event, or { allDay, start, end } from the booking where only that is at hand
// (an overlap notice).
async function cancelBooking(e, b) {
  const name = (b.guest && (b.guest.name || b.guest.email)) || '';
  await messageDialog({
    title: t('calendar.booking.cancelTitle'),
    keep: t('calendar.booking.keep'),
    act: t('calendar.booking.cancel'),
    html: `<p>${esc(name ? t('calendar.booking.cancelHelp', { name, when: whenInline(e) }) : t('calendar.booking.cancelHelpNoName', { when: whenInline(e) }))}</p>
        <label>${esc(t('calendar.booking.message'))}<textarea name="message" maxlength="500"></textarea><span class="field-help">${esc(t('calendar.booking.messageHelp'))}</span></label>`,
    async run({ message }) {
      await api('bookingAction', b.id, 'cancel', message ? { notify: true, message } : { notify: true });
      toast(t('calendar.booking.cancelled'));
      reload(0);
    }
  });
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
