'use strict';

// Calendar tests compare what was made around "now" with what the window shows for "now". The demo calendar's events
// are made around the week the main process is in, a test works out "this Monday" itself, and the window shows the
// week it is in when the calendar opens. With midnight in between, those are different days, and from Sunday to
// Monday different weeks: a test that started at 23:59:59 on a Sunday looked for this week's events in the next one.
// So a calendar test doesn't start in the last minute of a day. It waits until the day has turned, and its timeout
// grows by the wait. A calendar test takes a few seconds, well within the minute. A test that sets its own timeout
// afterwards would drop the wait: it adds to test.info().timeout instead.
const { test } = require('@playwright/test');

const MARGIN = 60000;

async function clearOfMidnight() {
  const now = Date.now();
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  const left = midnight.getTime() - now;
  if (left >= MARGIN) return;
  const wait = left + 1000;
  test.setTimeout(test.info().timeout + wait);
  await new Promise((resolve) => setTimeout(resolve, wait));
}

module.exports = { clearOfMidnight };
