'use strict';

const { t, languages, getLanguage } = require('../../i18n');

// Open time across the calendars that count toward availability, for the availability panel, the composer's "free
// times" and the find_free_time tool. Busy time comes from the calendar store; open hours are the working hours from
// settings.calendar, the booking page's hours, or the whole range. The same lines of text serve all three, so there is
// one way free time reads. Booking slots themselves are made on the server.
const { openWindows, freeWindows, formatFreeTimes, workWeekly } = require('./availability');
const { isZone, pcZone } = require('./zone');
const { calendarError } = require('./google');

const DAY = 86400000;
const MAX_SPAN = 31 * DAY;
const HOURS = new Set(['booking', 'working', 'any']);

// opts: { start, end (at most 31 days later), length (minutes, 5..480), hours, timeZone?, locale?, hour12? }.
// booking: the booking page's hours ({ weekly, overrides, timeZone }) or null when the page is off; 'booking' hours
// then fall back to working hours. timeZone (the PC's by default) is only the zone the result is shown in: working
// hours are the PC's, as the grid shades them, and booking hours are in the page's own zone. All-day events block
// whole days in the zone the hours are in.
async function free(calendars, settings, booking, opts = {}) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const { start, end } = o;
  const length = Number(o.length);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > MAX_SPAN || !Number.isInteger(length) || length < 5 || length > 480) {
    throw calendarError('invalid', t('errors.calendar.invalidFree'));
  }
  if (o.timeZone !== undefined && !isZone(o.timeZone)) throw calendarError('invalid', t('errors.calendar.invalidZone'));
  const timeZone = o.timeZone || pcZone();
  let hours = HOURS.has(o.hours) ? o.hours : 'working';
  if (hours === 'booking' && !booking) hours = 'working';
  const language = o.locale === 'en' || o.locale === 'nl' ? o.locale : getLanguage();
  const locale = (languages.find((l) => l.code === language) || languages[0]).locale;

  let open;
  let busyZone = pcZone();
  try {
    if (hours === 'booking') {
      open = openWindows({ weekly: booking.weekly, overrides: booking.overrides || {}, timeZone: booking.timeZone, from: start, to: end });
      busyZone = booking.timeZone;
    } else if (hours === 'working') open = openWindows({ weekly: workWeekly(settings && settings.calendar), timeZone: busyZone, from: start, to: end });
    else open = [[start, end]];
  } catch (err) {
    // Booking hours that don't make a schedule; the booking service checks them when they are saved.
    if (err instanceof RangeError) throw calendarError('invalid', t('errors.calendar.invalidFree'));
    throw err;
  }
  const busy = await calendars.busyTimes({ start, end, calendars: null, timeZone: busyZone });
  const windows = freeWindows({ open, busy: busy.intervals, minLength: length * 60000 });
  // The calendars that were read; an account that failed is named in failed instead.
  const missed = new Set(busy.failed.map((f) => f.accountId));
  const checked = [];
  for (const acc of calendars.list()) {
    if (missed.has(acc.id)) continue;
    for (const c of acc.calendars) if (c.availability) checked.push({ accountId: acc.id, calendarId: c.id, name: c.name, email: acc.email });
  }
  return {
    windows,
    allDay: busy.allDay,
    failed: busy.failed,
    timeZone,
    checked,
    lines: formatFreeTimes(windows, { locale, timeZone, hour12: typeof o.hour12 === 'boolean' ? o.hour12 : undefined })
  };
}

module.exports = { free };
