// Calendar date math that needs nothing from the page, so Node's tests can load this file (test/calendar-dates.test.js).

// The next half hour on the PC's clock, or ts itself when it is one. Rounding the milliseconds since 1970 would
// round on UTC's clock instead, which in a zone such as Nepal's (UTC+05:45) lands at a quarter past or to the hour.
export function nextHalfHour(ts) {
  const d = new Date(ts);
  const past = (d.getMinutes() % 30) * 60000 + d.getSeconds() * 1000 + d.getMilliseconds();
  return past ? ts - past + 1800000 : ts;
}
