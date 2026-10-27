// Settings > Calendar: the week, working hours, new events and reminders, and per calendar its colour and whether it
// counts toward availability. Main keeps all of it in settings.calendar and changes it only through calendarSettings
// (contracts d), which merges per calendar and keeps what doesn't fit. Calendars come from calendarList, which has no
// effect on the calendar view.
import { t, getLocale } from './i18n.js';
import { api, esc, toast, dialog, choiceDialog } from './ui.js';
import { duration, setCalSettings } from './calendar-shared.js';

export const CALENDAR_VIEWS = ['calendar'];

// The calendar sidebar's swatches (calendar.js), with its labels, so a colour picked here looks the same there.
const PALETTE = [
  ['#ff5d73', () => t('calendar.colors.red')],
  ['#ff8a3d', () => t('calendar.colors.orange')],
  ['#f5c542', () => t('calendar.colors.yellow')],
  ['#9fcf4a', () => t('calendar.colors.lime')],
  ['#3fbf72', () => t('calendar.colors.green')],
  ['#2fd6c0', () => t('calendar.colors.turquoise')],
  ['#5ec2ff', () => t('calendar.colors.lightBlue')],
  ['#4a7dff', () => t('calendar.colors.blue')],
  ['#8a72f0', () => t('calendar.colors.indigo')],
  ['#c56cf0', () => t('calendar.colors.purple')],
  ['#f06cb4', () => t('calendar.colors.pink')],
  ['#8a90a0', () => t('calendar.colors.grey')]
];
const HEX = /^#[0-9a-f]{6}$/i;
const LENGTHS = [15, 30, 45, 60, 90, 120];
const REMINDERS = [null, 0, 5, 10, 15, 30, 60];
const DEFAULTS = { weekStart: null, weekends: true, workDays: [1, 2, 3, 4, 5], workStart: '09:00', workEnd: '17:00', duration: 60, reminder: 10, notify: true, colors: {} };

const key = (accountId, calendarId) => `${accountId}\n${calendarId}`;
// A weekday's name: 0 Sunday … 6 Saturday, from a week in January 2023 that starts on a Sunday.
export const weekdayName = (day, style = 'long') => {
  const name = new Intl.DateTimeFormat(getLocale(), { weekday: style }).format(new Date(2023, 0, 1 + day));
  return name.replace(/^./, (c) => c.toUpperCase());
};
export function localeFirstDay() {
  try {
    const locale = new Intl.Locale(getLocale());
    const info = typeof locale.getWeekInfo === 'function' ? locale.getWeekInfo() : locale.weekInfo;
    return info && info.firstDay ? info.firstDay % 7 : 1;
  } catch (_) {
    return 1;
  }
}
// The week's days in the order the calendar shows them.
export const weekOrder = (calendar) => {
  const first = calendar && [0, 1, 6].includes(calendar.weekStart) ? calendar.weekStart : localeFirstDay();
  return Array.from({ length: 7 }, (_, i) => (first + i) % 7);
};
const reminderLabel = (m) => (m === null ? t('common.values.none') : m === 0 ? t('settings.calendar.reminderAtStart') : t('settings.calendar.reminderBefore', { length: duration(m * 60000) }));

// Days as text: "Mon–Fri", or one by one where they don't run on ("Mon, Wed, Fri").
export function daysText(days, calendar) {
  const order = weekOrder(calendar).filter((d) => days.includes(d));
  const runs = [];
  for (const d of order) {
    const last = runs[runs.length - 1];
    if (last && weekOrder(calendar).indexOf(d) === weekOrder(calendar).indexOf(last[1]) + 1) last[1] = d;
    else runs.push([d, d]);
  }
  return runs.map(([a, b]) => (a === b ? weekdayName(a, 'short') : `${weekdayName(a, 'short')}–${weekdayName(b, 'short')}`)).join(', ');
}

// Working hours as text: "Mon–Fri, 09:00–17:00".
export function workHoursText(calendar) {
  const c = { ...DEFAULTS, ...(calendar || {}) };
  if (!c.workDays.length) return t('settings.calendar.noWorkDays');
  return `${daysText(c.workDays, c)}, ${c.workStart}–${c.workEnd}`;
}

// pages: what settings.js needs. row: its row helper; go and rerender: its navigation; current(): the page on top.
export function calendarSettingsPages({ row, go, rerender, current }) {
  let calendar = { ...DEFAULTS };
  let accounts = null;
  let listFailed = false;

  // state: what settings.js just read from main, for settings.calendar.
  async function prepare(view, state) {
    if (state && state.settings && state.settings.calendar) calendar = state.settings.calendar;
    if (view !== 'calendar') return;
    try {
      accounts = await api('calendarList');
      listFailed = false;
    } catch (_) {
      listFailed = true;
    }
  }

  // The row on the Settings overview.
  function rowHtml() {
    return row({ title: esc(t('settings.calendar.title')), desc: esc(t('settings.calendar.rowDesc')), action: 'calset-open' });
  }

  // Saves a change; the page is drawn again from what main kept, unless the change came from a field still in use.
  async function save(patch, { redraw = true } = {}) {
    try {
      calendar = await api('calendarSettings', patch);
      setCalSettings(calendar);
    } catch (err) {
      toast(err.message, 5000);
    }
    if (redraw && current() === 'calendar') await rerender();
  }

  function weekCard() {
    const c = { ...DEFAULTS, ...calendar };
    const startLabel = c.weekStart === null ? t('settings.calendar.weekStartAuto', { day: weekdayName(localeFirstDay()) }) : weekdayName(c.weekStart);
    const days = weekOrder(c)
      .map((d) => {
        const on = c.workDays.includes(d);
        return `<button class="calset-day" data-a="calset-day:${d}" aria-pressed="${on}" title="${esc(weekdayName(d))}" aria-label="${esc(weekdayName(d))}">${esc(weekdayName(d, 'short'))}</button>`;
      })
      .join('');
    const end = c.workEnd === '24:00' ? '00:00' : c.workEnd;
    return `
      <div class="settings-group-title">${esc(t('settings.calendar.week'))}</div>
      <div class="card">
        ${row({ title: esc(t('settings.calendar.weekStart')), value: esc(startLabel), action: 'calset-weekstart' })}
        ${row({ title: esc(t('settings.calendar.weekends')), desc: esc(t('settings.calendar.weekendsHelp')), action: 'calset-weekends', toggle: c.weekends !== false })}
        <div class="row static calset-days-row">
          <div class="text"><div class="title" id="calset-days">${esc(t('settings.calendar.workDays'))}</div></div>
          <div class="calset-days" role="group" aria-labelledby="calset-days">${days}</div>
        </div>
        <div class="row static calset-hours-row">
          <div class="text"><div class="title" id="calset-hours">${esc(t('settings.calendar.workHours'))}</div>
            <div class="desc">${esc(t('settings.calendar.workHoursHelp'))}</div>
            <div class="error calset-error" data-calset-error aria-live="polite"></div></div>
          <div class="calset-hours" role="group" aria-labelledby="calset-hours">
            <input type="time" step="300" data-calset-time="start" value="${esc(c.workStart)}" aria-label="${esc(t('settings.calendar.workFrom'))}"/>
            <span aria-hidden="true">–</span>
            <input type="time" step="300" data-calset-time="end" value="${esc(end)}" aria-label="${esc(t('settings.calendar.workTo'))}"/>
          </div>
        </div>
      </div>`;
  }

  function eventsCard() {
    const c = { ...DEFAULTS, ...calendar };
    return `
      <div class="settings-group-title">${esc(t('settings.calendar.events'))}</div>
      <div class="card">
        ${row({ title: esc(t('settings.calendar.duration')), value: esc(duration(c.duration * 60000)), action: 'calset-duration' })}
        ${row({ title: esc(t('settings.calendar.notify')), desc: esc(t('settings.calendar.notifyHelp')), action: 'calset-notify', toggle: c.notify !== false })}
        ${row({ title: esc(t('settings.calendar.reminder')), desc: esc(t('settings.calendar.reminderHelp')), value: esc(reminderLabel(c.reminder)), action: 'calset-reminder' })}
      </div>`;
  }

  function calendarRow(acc, cal) {
    const k = encodeURIComponent(key(acc.id, cal.id));
    const color = HEX.test(cal.color || '') ? cal.color : 'var(--accent)';
    const counts = cal.availability === true;
    const notes = [!cal.writable ? t('settings.calendar.readOnly') : '', !cal.owned && !cal.primary ? t('calendar.sidebar.availabilityShared') : ''].filter(Boolean).join(' · ');
    return `<div class="row static calset-cal">
        <button class="calset-swatch" data-a="calset-color:${k}" style="--cal:${esc(color)}" title="${esc(t('settings.calendar.color', { name: cal.name }))}" aria-label="${esc(t('settings.calendar.color', { name: cal.name }))}"></button>
        <div class="text"><div class="title">${esc(cal.name)}</div>${notes ? `<div class="desc">${esc(notes)}</div>` : ''}</div>
        <button class="calset-switch" data-a="calset-avail:${k}" role="switch" aria-checked="${counts}" aria-label="${esc(t('settings.calendar.countsLabel', { name: cal.name }))}"><span class="calset-switch-label" aria-hidden="true">${esc(t('settings.calendar.counts'))}</span><span class="switch ${counts ? 'on' : ''}"></span></button>
      </div>`;
  }

  function calendarsCard() {
    const head = `<div class="settings-group-title">${esc(t('settings.calendar.calendars'))}</div><p class="settings-text">${esc(t('settings.calendar.calendarsHelp'))}</p>`;
    if (listFailed && !accounts) return `${head}<p class="settings-text error">${esc(t('settings.calendar.listFailed'))}</p>`;
    if (!accounts) return `${head}<div class="card"><div class="row static"><span class="spinner"></span></div></div>`;
    const withCalendars = accounts.filter((a) => a.calendars.length || a.state === 'reconnect');
    if (!withCalendars.length) return `${head}<p class="settings-text">${esc(t('settings.calendar.noCalendars'))}</p>`;
    return (
      head +
      withCalendars
        .map(
          (a) => `<div class="calset-account">${esc(a.email)}</div>
        <div class="card">${
          a.calendars.length
            ? a.calendars.map((c) => calendarRow(a, c)).join('')
            : `<div class="row static"><div class="text"><div class="desc">${esc(t('settings.calendar.reconnect'))}</div></div></div>`
        }</div>`
        )
        .join('')
    );
  }

  function view() {
    return { title: esc(t('settings.calendar.title')), body: `${weekCard()}${eventsCard()}${calendarsCard()}` };
  }

  // The working-hours fields save when either changes, both ends together, so main never sees half a change. An end
  // of 00:00 means midnight at the end of the day.
  function fill(view, page) {
    if (view !== 'calendar') return;
    const fields = [...page.querySelectorAll('[data-calset-time]')];
    const error = page.querySelector('[data-calset-error]');
    fields.forEach((input) =>
      input.addEventListener('change', async () => {
        const start = fields[0].value;
        let end = fields[1].value;
        if (end === '00:00') end = '24:00';
        if (!/^\d\d:\d\d$/.test(start) || !/^\d\d:\d\d$/.test(end) || end <= start) {
          error.textContent = t('settings.calendar.workInvalid');
          fields.forEach((f) => f.setAttribute('aria-invalid', 'true'));
          return;
        }
        error.textContent = '';
        fields.forEach((f) => f.removeAttribute('aria-invalid'));
        await save({ workStart: start, workEnd: end }, { redraw: false });
      })
    );
  }

  async function pickColor(k) {
    const [accountId, calendarId] = k.split('\n');
    const acc = (accounts || []).find((a) => a.id === accountId);
    const cal = acc && acc.calendars.find((c) => c.id === calendarId);
    if (!cal) return;
    const picked = (calendar.colors || {})[k];
    const value = await dialog({
      title: t('settings.calendar.colorTitle', { name: cal.name }),
      buttons: [
        { get label() { return t('calendar.colors.default'); }, value: 'default', left: true },
        { get label() { return t('common.actions.cancel'); }, value: null }
      ],
      render(body, done) {
        body.innerHTML = `<div class="calset-palette" role="radiogroup" aria-label="${esc(t('calendar.colors.heading'))}">${PALETTE.map(
          ([hex, label]) =>
            `<button type="button" class="cat-swatch" role="radio" aria-checked="${hex === picked}" data-color="${hex}" style="--cat:${hex}" title="${esc(label())}" aria-label="${esc(label())}"></button>`
        ).join('')}</div>`;
        body.querySelectorAll('[data-color]').forEach((b) => b.addEventListener('click', () => done(b.dataset.color)));
        setTimeout(() => (body.querySelector('[aria-checked="true"]') || body.querySelector('[data-color]'))?.focus(), 0);
      }
    });
    if (!value) return;
    await save({ colors: { [k]: value === 'default' ? null : value } }, { redraw: false });
    await prepare('calendar');
    await rerender();
  }

  // Handles a data-a action of this page; false when it isn't one.
  async function click(a) {
    if (a === 'calset-open') return go('calendar'), true;
    const c = { ...DEFAULTS, ...calendar };
    if (a.startsWith('calset-day:')) {
      const d = Number(a.slice(11));
      const days = c.workDays.includes(d) ? c.workDays.filter((x) => x !== d) : [...c.workDays, d].sort((x, y) => x - y);
      await save({ workDays: days });
      return true;
    }
    if (a.startsWith('calset-avail:')) {
      const k = decodeURIComponent(a.slice(13));
      const [accountId, calendarId] = k.split('\n');
      const cal = (accounts || []).find((x) => x.id === accountId)?.calendars.find((x) => x.id === calendarId);
      if (!cal) return true;
      await save({ availability: { [k]: !cal.availability } }, { redraw: false });
      await prepare('calendar');
      await rerender();
      return true;
    }
    if (a.startsWith('calset-color:')) {
      await pickColor(decodeURIComponent(a.slice(13)));
      return true;
    }
    switch (a) {
      case 'calset-weekstart': {
        const v = await choiceDialog(
          t('settings.calendar.weekStart'),
          [
            { value: 'auto', label: t('settings.calendar.weekStartAuto', { day: weekdayName(localeFirstDay()) }) },
            { value: 1, label: weekdayName(1) },
            { value: 0, label: weekdayName(0) },
            { value: 6, label: weekdayName(6) }
          ],
          c.weekStart === null ? 'auto' : c.weekStart
        );
        if (v !== null && v !== undefined) await save({ weekStart: v === 'auto' ? null : v });
        return true;
      }
      case 'calset-weekends':
        await save({ weekends: c.weekends === false });
        return true;
      case 'calset-notify':
        await save({ notify: c.notify === false });
        return true;
      case 'calset-duration': {
        const list = LENGTHS.includes(c.duration) ? LENGTHS : [...LENGTHS, c.duration].sort((x, y) => x - y);
        const v = await choiceDialog(t('settings.calendar.duration'), list.map((m) => ({ value: m, label: duration(m * 60000) })), c.duration);
        if (v) await save({ duration: v });
        return true;
      }
      case 'calset-reminder': {
        const list = REMINDERS.includes(c.reminder) ? REMINDERS : [...REMINDERS, c.reminder];
        const v = await choiceDialog(t('settings.calendar.reminder'), list.map((m) => ({ value: m === null ? 'none' : m, label: reminderLabel(m) })), c.reminder === null ? 'none' : c.reminder);
        if (v !== null && v !== undefined) await save({ reminder: v === 'none' ? null : v });
        return true;
      }
    }
    return false;
  }

  return { prepare, rowHtml, view, fill, click, calendar: () => calendar };
}
