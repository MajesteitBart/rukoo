import { t } from './i18n.js';
import { icons } from './icons.js';
import { api, esc, $, $$, toast, dialog, choiceDialog, confirmDialog, KEEP_OPEN } from './ui.js';
import {
  DAY,
  prefs,
  savePrefs,
  C,
  ctx,
  hooks,
  startOfDay,
  addDays,
  weekStart,
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
  colorOf,
  byId,
  shownView,
  range
} from './calendar-shared.js';

// An event's card next to it in the grid or list, the dialog that makes or changes an event, and the changes
// themselves: delete, answer an invitation. calendar.js draws the view and opens the card.

const RESPONSES = ['accepted', 'tentative', 'declined'];

// The view loads again after a change; calendar.js sets this when it loads.
const reload = (ms) => hooks.reload(ms);

// ---------- event card ----------

const RESPONSE_MARK = { accepted: 'check', declined: 'close', tentative: 'info', needsAction: 'clock' };

function popHtml(e) {
  const acc = account(e.accountId);
  const cal = calendarOf(e);
  const guests = e.attendees || [];
  const actions = [
    e.canEdit ? `<button class="icon-btn sm" data-pop="edit" title="${esc(t('calendar.event.editShortcut'))}">${icons.edit}</button>` : '',
    e.canDelete ? `<button class="icon-btn sm" data-pop="delete" title="${esc(t('calendar.event.deleteShortcut'))}">${icons.trash}</button>` : '',
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

export function openPop(e, anchor, { focus = true } = {}) {
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
export function followScroll(scroll) {
  const pop = popEl();
  // A multi-day event shows more than once; the open one is the one that was clicked.
  const anchor = C.pop && $('.calendar .open[data-ev]');
  if (!pop || !anchor || !scroll.contains(anchor)) return;
  const a = anchor.getBoundingClientRect();
  const s = scroll.getBoundingClientRect();
  if (a.bottom < s.top || a.top > s.bottom) closePop();
  else place(pop, anchor);
}

export function closePop(refocus = false) {
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

export function fromEvent(e) {
  return { title: e.title, location: e.location, description: e.description, allDay: e.allDay, start: e.start, end: e.end, key: key(e.accountId, e.calendarId) };
}

// The event as the calendar store has it now, also when it moved; null when it is gone.
async function latestVersion(e) {
  try {
    return await api('calendarEvent', e.id);
  } catch (_) {
    return null;
  }
}

// The latest version with what the user changed on top: the title, place and description each on their own, the
// times together. What the user left alone shows as it is now.
function rebase(opened, mine, latest) {
  const out = { ...fromEvent(latest), key: mine.key };
  for (const k of ['title', 'location', 'description']) if (mine[k] !== opened[k]) out[k] = mine[k];
  if (mine.allDay !== opened.allDay || mine.start !== opened.start || mine.end !== opened.end) Object.assign(out, { allDay: mine.allDay, start: mine.start, end: mine.end });
  return out;
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
  };
  field('startDate').addEventListener('change', follow);
  field('startTime').addEventListener('change', follow);
  field('endDate').addEventListener('change', remember);
  field('endTime').addEventListener('change', remember);
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
    out.start = keptInstant(Number(f.dataset.start), startDate, field('startTime').value);
    out.end = keptInstant(Number(f.dataset.end), endDate, field('endTime').value);
    if (out.end <= out.start) return fail(t('calendar.dialog.endBeforeStart'));
  }
  return out;
}

// Guests hear about a change only when the user says so, as Google Calendar asks.
export async function notifyGuests(e, what) {
  const others = (e.attendees || []).filter((a) => !a.self);
  // The demo account's guests are made up and nobody emails them, so there is nothing to ask.
  if (account(e.accountId)?.kind === 'demo') return false;
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
        // The version this dialog opened: a newer one in the calendar makes the save fail instead of overwriting it.
        saved = await api('calendarUpdate', e.id, input, { notify, etag: e.etag });
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
      // Changed elsewhere since the dialog opened: the dialog continues from the latest version, with the user's own
      // changes on top, and the next Save applies them to that version.
      const latest = e && (await latestVersion(e));
      if (latest && latest.etag !== e.etag) {
        values = { ...rebase(fromEvent(e), result, latest), error: t('calendar.dialog.changedElsewhere') };
        e = latest;
      }
    }
  }
}

export function editEvent(e) {
  closePop();
  eventDialog(e);
}

export function seriesChoice(title) {
  return choiceDialog(
    title,
    [
      { label: t('calendar.series.one'), value: 'one' },
      { label: t('calendar.series.all'), value: 'all' }
    ],
    'one'
  );
}

export async function removeEvent(e) {
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
    await api('calendarDelete', e.id, { notify, series, etag: e.etag });
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
