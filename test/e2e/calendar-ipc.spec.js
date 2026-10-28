// The calendar calls a window makes to the main process, in the real app on the demo account: the calendar list and
// settings, free time, conflicts, search and the newer event fields, as the renderer will send them.
const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('path');
const { tempDir, removeDir } = require('../tmp');
const { closeApp } = require('./close');

let app;
let win;
let dataDir;

test.beforeEach(async () => {
  dataDir = tempDir('sem-e2e-calipc-');
  const env = { ...process.env, SEM_DATA_DIR: dataDir, SEM_HIDDEN: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: ['.'], cwd: path.join(__dirname, '..', '..'), env });
  win = await app.firstWindow();
  await win.waitForSelector('.provider-grid');
  await win.click('[data-s="demo"]');
  await expect(win.locator('.item').first()).toBeVisible({ timeout: 15000 });
});

test.afterEach(async () => {
  await closeApp(app);
  removeDir(dataDir);
});

const call = (method, ...args) => win.evaluate(([m, a]) => window.mail.call(m, ...a), [method, args]);
const fails = (method, ...args) => win.evaluate(([m, a]) => window.mail.call(m, ...a).then(() => null, (err) => err.message), [method, args]);

test('calendar list and settings: no fetch for the view, choices merge per calendar and come back with the state', async () => {
  await win.evaluate(() => {
    window.__calendarEvents = 0;
    window.mail.on((e) => {
      if (e.type === 'calendar') window.__calendarEvents++;
    });
  });
  // Before the calendar was ever shown: the list reads the calendars itself, without the view's fetch or redraw.
  const before = await call('calendarList');
  expect(before.map((a) => [a.kind, a.calendars.length, a.loading])).toEqual([['demo', 3, false]]);
  expect(await win.evaluate(() => window.__calendarEvents)).toBe(0);
  const monday = await win.evaluate(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    return d.getTime();
  });
  const free = await call('calendarFree', { start: monday, end: monday + 7 * 86400000, length: 30, hours: 'working', locale: 'en' });
  expect(free.checked.map((c) => c.calendarId)).toEqual(['personal', 'work']);
  expect(free.failed).toEqual([]);
  expect(free.lines.length).toBeGreaterThan(0);
  expect(free.lines[0]).toMatch(/^(Mon|Tue|Wed|Thu|Fri) \d+ \w+: /);
  const list = await call('calendarList');
  expect(list[0].calendars.map((c) => [c.id, c.invites, c.availability, c.visible])).toEqual([
    ['personal', 'none', true, true],
    ['work', 'none', true, true],
    ['birthdays', 'none', false, true]
  ]);

  const saved = await call('calendarSettings', { colors: { [`${list[0].id}\npersonal`]: '#112233' }, visible: { [`${list[0].id}\nwork`]: false }, duration: 30 });
  expect([saved.duration, saved.colors[`${list[0].id}\npersonal`]]).toEqual([30, '#112233']);
  await expect.poll(() => win.evaluate(() => window.__calendarEvents)).toBeGreaterThan(0);
  const state = await call('state');
  expect(state.settings.calendar.visible).toEqual({ [`${list[0].id}\nwork`]: false });
  const after = await call('calendarList');
  expect(after[0].calendars.map((c) => [c.id, c.color, c.visible])).toEqual([
    ['personal', '#112233', true],
    ['work', after[0].color, false],
    ['birthdays', after[0].color, true]
  ]);
  // updateSettings can't change them.
  await call('updateSettings', { calendar: { duration: 90 } });
  expect((await call('state')).settings.calendar.duration).toBe(30);
});

test('new event fields pass through, guests are refused where nobody sends invitations, and the reads answer', async () => {
  const [account] = await call('calendarList');
  const start = await win.evaluate(() => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(15, 0, 0, 0);
    return d.getTime();
  });
  const base = { accountId: account.id, calendarId: 'personal', title: 'Dentist', location: '', description: '', allDay: false, start, end: start + 3600000 };
  // A list of the demo calendars first, as the dialog has it.
  await call('calendarView', { start: start - 7 * 86400000, end: start + 7 * 86400000 });
  await expect.poll(async () => (await call('calendarList'))[0].calendars.length).toBe(3);
  const made = await call('calendarCreate', { ...base, busy: true, visibility: 'private', bookingId: 'Rf63vMqqWdS0MICDAHKmrw', uid: 'x@y' }, { notify: false, bookingId: 'Rf63vMqqWdS0MICDAHKmrw' });
  expect(made.title).toBe('Dentist');
  expect(made.bookingId).toBe(null);
  expect(await fails('calendarCreate', { ...base, guests: { add: [{ address: 'jane@example.com' }] } })).toBe("This calendar doesn't send invitations, so its events can't have guests.");
  expect(await fails('calendarCreate', { ...base, recurrence: 'FREQ=WEEKLY;COUNT=2;UNTIL=20991231' })).toBe("Rukoo can't save this repeat rule.");
  expect(await fails('calendarCreate', { ...base, timeZone: 'Nowhere/Land' })).toBe("Rukoo doesn't know that time zone.");
  // Shapes that don't fit are left out, not turned into a value: the event gets the calendar's own defaults (a timed
  // event is busy, no reminders of its own), and the guest text doesn't become a guest list the demo would refuse.
  const loose = await call('calendarCreate', { ...base, title: 'Loose', busy: 0, visibility: 'secret', guests: 'jane', reminders: { useDefault: 'no', overrides: [] } });
  expect([loose.title, loose.busy, loose.visibility, loose.reminders, loose.attendees]).toEqual(['Loose', true, 'default', null, []]);

  const conflicts = await call('calendarConflicts', { start, end: start + 3600000, exclude: [made.id] });
  expect(conflicts.events.map((e) => e.title)).toContain('Loose');
  expect(conflicts.events.map((e) => e.title)).not.toContain('Dentist');
  expect(await fails('calendarConflicts', { start, end: start + 40 * 86400000 })).toBeTruthy();

  const found = await call('calendarSearch', 'roadmap');
  expect(found.events.some((e) => /Roadmap/.test(e.title))).toBe(true);
  expect(await fails('calendarSearch', '')).toBe('Type something to search for, up to 200 characters.');
  expect(await fails('calendarMove', made.id, 'birthdays')).toBe("This calendar can't be found, or it doesn't take new events.");
  expect(await fails('calendarMove', made.id, 42)).toBe('invalid');
  expect(await fails('calendarFree', { start, end: start + 86400000, length: 2, hours: 'any' })).toBe('Rukoo looks for free time of 5 minutes to 8 hours, over at most 31 days.');
  await call('calendarDelete', made.id, { scope: 'one' });
  expect(await call('calendarEvent', made.id)).toBe(null);
});
