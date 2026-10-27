// The calendar's views and grid in the real app, on the demo account: the month, the mini month, Go to date,
// dragging events, the calendar menu, search, and what other parts of the app show on the grid.
const { test, expect, _electron: electron } = require('@playwright/test');
const path = require('path');
const { tempDir, removeDir } = require('../tmp');
const { closeApp } = require('./close');

let app;
let win;
let dataDir;

test.beforeEach(async () => {
  dataDir = tempDir('sem-e2e-calviews-');
  const env = { ...process.env, SEM_DATA_DIR: dataDir, SEM_HIDDEN: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: ['.'], cwd: path.join(__dirname, '..', '..'), env });
  win = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1500, 950));
  await win.waitForSelector('.provider-grid');
  await win.click('[data-s="demo"]');
  await expect(win.locator('.item').first()).toBeVisible({ timeout: 15000 });
});

test.afterEach(async () => {
  await closeApp(app);
  removeDir(dataDir);
});

const event = (title) => win.locator('.calendar [data-ev]', { hasText: title }).first();
const card = () => win.locator('.cal-pop');
const toast = () => win.locator('#toast');
const remindersNotice = () => win.locator('.cal-notice', { hasText: 'Rukoo now reminds you of events' });

// The calendar in week view. The one-time notice about reminders goes first, so every test has the same room.
async function openCalendar({ keepNotice = false } = {}) {
  await win.click('[data-mode="calendar"]');
  await expect(win.locator('.calendar')).toBeVisible();
  await expect(event('Roadmap review')).toBeVisible({ timeout: 10000 });
  if (!keepNotice && (await remindersNotice().count())) {
    await remindersNotice().locator('button', { hasText: 'Got it' }).click();
    await expect(remindersNotice()).toHaveCount(0);
  }
}

// The event as the calendar store holds it, without changing what the view loads.
const stored = (id) => win.evaluate((id) => window.mail.call('calendarEvent', id), id);
const calendarState = () => win.evaluate(() => window.mail.call('state').then((s) => s.settings.calendar));

// Dates on the window's clock: a day's midnight plus days, and a time on a day.
const shiftDays = (ms, n) => win.evaluate(([ms, n]) => {
  const d = new Date(ms);
  d.setDate(d.getDate() + n);
  return d.getTime();
}, [ms, n]);
const timeOn = (day, h, m = 0) => win.evaluate(([day, h, m]) => {
  const d = new Date(day);
  d.setHours(h, m, 0, 0);
  return d.getTime();
}, [day, h, m]);
const today = () => win.evaluate(() => new Date().setHours(0, 0, 0, 0));
const dateText = (ms) => win.evaluate((ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}, ms);
const demoAccount = () => win.evaluate(() => document.querySelector('.sidebar [data-cal-toggle]').dataset.calToggle.split('\n')[0]);
const columnOf = (locator) => locator.evaluate((el) => Number(el.closest('[data-cal-col]').dataset.calCol));

// A mouse drag: past the few pixels that make it a drag, then to the target in steps; before() runs before the
// button goes up.
async function drag(from, to, { before } = {}) {
  await win.mouse.move(from.x, from.y);
  await win.mouse.down();
  await win.mouse.move(from.x + 3, from.y + 5, { steps: 2 });
  await win.mouse.move(to.x, to.y, { steps: 10 });
  if (before) await before();
  await win.mouse.up();
}
const center = (box) => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });

// Where an element is once the view stopped redrawing: the same box twice in a row. A load that lands after an
// action redraws the grid, and an element measured just then is gone.
async function settledBox(locator) {
  let last = null;
  for (let i = 0; i < 30; i++) {
    const box = await locator.boundingBox();
    if (box && last && ['x', 'y', 'width', 'height'].every((k) => Math.abs(box[k] - last[k]) < 0.5)) return box;
    last = box;
    await win.waitForTimeout(80);
  }
  throw new Error('The element kept moving');
}

// The grid from 07:00, whatever time it is, so the demo's events are on screen.
const scrollGrid = (hour) => win.locator('.cal-scroll').evaluate((el, top) => (el.scrollTop = top), hour * 56);

test('the one-time notice about reminders goes for good once dismissed', async () => {
  await openCalendar({ keepNotice: true });
  await expect(remindersNotice()).toBeVisible();
  await expect(remindersNotice()).toContainText('Change this in Settings → Calendar.');
  await remindersNotice().locator('button', { hasText: 'Got it' }).click();
  await expect(remindersNotice()).toHaveCount(0);
  await expect.poll(async () => (await calendarState()).notifiedUpgrade).toBe(true);
  await win.reload();
  await expect(event('Roadmap review')).toBeVisible({ timeout: 10000 });
  await expect(remindersNotice()).toHaveCount(0);
});

test('the month view shows whole weeks, steps by month, and a full day says how many more it has', async () => {
  await openCalendar();
  await win.keyboard.press('m');
  await expect(win.locator('[data-cal-view="month"]')).toHaveAttribute('aria-selected', 'true');
  const thisMonth = await win.evaluate(() => new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric' }).format(new Date()));
  await expect(win.locator('.cal-title')).toHaveText(thisMonth);
  const weeks = await win.locator('.cal-mweek').count();
  expect(weeks).toBeGreaterThanOrEqual(4);
  expect(weeks).toBeLessThanOrEqual(6);
  await expect(win.locator('.cal-mname')).toHaveCount(7);
  await expect(win.locator('.cal-mchip', { hasText: 'Roadmap review' })).toBeVisible();
  // The offsite runs over several days as one bar.
  await expect(win.locator('.cal-mchip.span', { hasText: 'Team offsite' }).first()).toBeVisible();

  await win.click('[data-cal="next"]');
  const nextMonth = await win.evaluate(() => {
    const d = new Date();
    return new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric' }).format(new Date(d.getFullYear(), d.getMonth() + 1, 1));
  });
  await expect(win.locator('.cal-title')).toHaveText(nextMonth);
  await win.keyboard.press('k');
  await expect(win.locator('.cal-title')).toHaveText(thisMonth);

  // Eight more events today: the day can't show them all.
  const day = await today();
  const accountId = await demoAccount();
  for (let i = 0; i < 8; i++) {
    const start = await timeOn(day, 6 + i);
    await win.evaluate(([accountId, start, i]) => window.mail.call('calendarCreate', { accountId, calendarId: 'personal', title: `Extra ${i}`, allDay: false, start, end: start + 1800000 }), [accountId, start, i]);
  }
  const more = win.locator(`.cal-mmore[data-cal-more="${day}"]`);
  await expect(more).toBeVisible({ timeout: 10000 });
  const hidden = Number((await more.textContent()).match(/\d+/)[0]);
  expect(await more.textContent()).toBe(`+${hidden} more`);
  // What shows plus what the button counts is every event of the day.
  const shown = await win.evaluate((day) => {
    const cell = document.querySelector(`.cal-mcell[data-cal-mday="${day}"]`);
    const week = cell.closest('.cal-mweek');
    const column = Number(cell.style.gridColumnStart) - 1;
    return [...week.querySelectorAll('.cal-mchip')].filter((chip) => {
      const [from, span] = chip.style.gridColumn.split('/').map((s) => Number(s.replace(/\D/g, '')) || 1);
      return column >= from - 1 && column <= from - 1 + span - 1;
    }).length;
  }, day);
  await more.click();
  await expect(win.locator('[data-cal-view="day"]')).toHaveAttribute('aria-selected', 'true');
  await expect(win.locator('.cal-dayhead')).toHaveCount(1);
  await expect(win.locator('.cal-dayhead')).toHaveAttribute('data-cal-day', String(day));
  const all = (await win.locator('.cal-col [data-ev]').count()) + (await win.locator('.cal-allday [data-ev]').count());
  expect(shown + hidden).toBe(all);

  // A day's number opens that day too.
  await win.keyboard.press('m');
  const other = await shiftDays(day, 1);
  await win.locator(`.cal-mnum[data-cal-day="${other}"]`).click();
  await expect(win.locator('.cal-dayhead')).toHaveAttribute('data-cal-day', String(other));
});

test('the mini month moves by keyboard and shows the day picked', async () => {
  await openCalendar();
  const day = await today();
  // Dots mark days with events: Monday has the roadmap review.
  const monday = await event('Roadmap review').evaluate((el) => Number(el.closest('[data-cal-col]').dataset.calCol));
  await expect(win.locator(`.sidebar .cal-mini [data-mini-day="${monday}"]`)).toHaveClass(/\bdot\b/);
  await expect(win.locator(`.sidebar .cal-mini [data-mini-day="${day}"]`)).toHaveClass(/\btoday\b/);
  await win.keyboard.press('d');
  await expect(win.locator('.cal-dayhead')).toHaveCount(1);
  // One day holds the Tab stop: the day in view.
  const stop = win.locator('.sidebar .cal-mini [data-mini-day][tabindex="0"]');
  await expect(stop).toHaveCount(1);
  await expect(stop).toHaveAttribute('data-mini-day', String(day));
  await stop.focus();
  await win.keyboard.press('ArrowRight');
  await win.keyboard.press('ArrowDown');
  const target = await shiftDays(day, 8);
  await expect(win.locator(`.sidebar [data-mini-day="${target}"]`)).toBeFocused();
  await expect(win.locator('.sidebar .cal-mini [tabindex="0"]')).toHaveAttribute('data-mini-day', String(target));
  // The view stays where it was until a day is picked.
  await expect(win.locator('.cal-dayhead')).toHaveAttribute('data-cal-day', String(day));

  const title = await win.locator('.sidebar .cal-mini-title').textContent();
  await win.keyboard.press('PageDown');
  await expect(win.locator('.sidebar .cal-mini-title')).not.toHaveText(title);
  const nextMonth = await win.evaluate((ms) => {
    const d = new Date(ms);
    const last = new Date(d.getFullYear(), d.getMonth() + 2, 0).getDate();
    return new Date(d.getFullYear(), d.getMonth() + 1, Math.min(d.getDate(), last)).getTime();
  }, target);
  await expect(win.locator(`.sidebar [data-mini-day="${nextMonth}"]`)).toBeFocused();
  await win.keyboard.press('PageUp');
  await expect(win.locator(`.sidebar [data-mini-day="${target}"]`)).toBeFocused();

  await win.keyboard.press('Enter');
  await expect(win.locator('.cal-dayhead')).toHaveAttribute('data-cal-day', String(target));
  // The keyboard stays on the mini month after the view moved.
  await expect(win.locator(`.sidebar [data-mini-day="${target}"]`)).toBeFocused();
  await expect(win.locator(`.sidebar [data-mini-day="${target}"]`)).toHaveClass(/\bsel\b/);
});

test('Go to date opens with G or a click on the title', async () => {
  await openCalendar();
  await win.keyboard.press('g');
  await expect(win.locator('.dialog h2')).toHaveText('Go to date');
  await win.fill('.dialog [name="date"]', '2027-03-17');
  await win.keyboard.press('Enter');
  await expect(win.locator('.dialog')).toHaveCount(0);
  const march = await win.evaluate(() => new Date(2027, 2, 17).getTime());
  await expect(win.locator(`.cal-dayhead[data-cal-day="${march}"]`)).toBeVisible();
  await expect(win.locator('.cal-title')).toHaveText('March 2027');

  // The title opens it as well; a day in its month is a pick too, from the mouse or the keyboard.
  await win.locator('.cal-title').click();
  await expect(win.locator('.dialog .cal-mini-title')).toHaveText('March 2027');
  await win.locator('.dialog [data-mini="next"]').click();
  await expect(win.locator('.dialog .cal-mini-title')).toHaveText('April 2027');
  const april = await win.evaluate(() => new Date(2027, 3, 9).getTime());
  await win.locator(`.dialog [data-mini-day="${april}"]`).click();
  await expect(win.locator('.dialog')).toHaveCount(0);
  await expect(win.locator(`.cal-dayhead[data-cal-day="${april}"]`)).toBeVisible();

  await win.keyboard.press('g');
  await win.locator('.dialog .cal-mini [tabindex="0"]').focus();
  await win.keyboard.press('ArrowRight');
  await expect(win.locator('.dialog [name="date"]')).toHaveValue('2027-04-10');
  await win.keyboard.press('Enter');
  await expect(win.locator('.dialog')).toHaveCount(0);
  const tenth = await win.evaluate(() => new Date(2027, 3, 10).getTime());
  await expect(win.locator(`.cal-dayhead[data-cal-day="${tenth}"]`)).toBeVisible();
});

test('dragging on empty grid opens a new event with the dragged times', async () => {
  await openCalendar();
  await scrollGrid(5);
  const col = win.locator('.cal-col').nth(2);
  const day = await col.evaluate((el) => Number(el.dataset.calCol));
  const box = await settledBox(col);
  const y = (h, m) => box.y + ((h * 60 + m) / 60) * 56;
  await drag({ x: box.x + 30, y: y(6, 5) }, { x: box.x + 34, y: y(7, 20) }, {
    before: async () => {
      // While it goes, a card shows where the event will be and when.
      await expect(win.locator('.cal-ghost')).toHaveCount(1);
      await expect(win.locator('.cal-ghost')).toContainText('06:00 – 07:30');
    }
  });
  await expect(win.locator('.cal-form [name="startTime"]')).toHaveValue('06:00');
  await expect(win.locator('.cal-form [name="endTime"]')).toHaveValue('07:30');
  await expect(win.locator('.cal-form [name="startDate"]')).toHaveValue(await dateText(day));
  await expect(win.locator('.cal-form [name="allDay"]')).not.toBeChecked();
  await win.fill('.cal-form [name="title"]', 'Focus time');
  await win.keyboard.press('Enter');
  await expect(event('Focus time')).toContainText('06:00 – 07:30');
  await expect(win.locator('.cal-ghost')).toHaveCount(0);
  expect(await columnOf(event('Focus time'))).toBe(day);
});

test('an event dragged to another day and time moves there, and Undo puts it back', async () => {
  await openCalendar();
  await scrollGrid(7);
  const lunch = event('Lunch with Sanne');
  const id = await lunch.getAttribute('data-ev');
  const before = await stored(id);
  const wednesday = await columnOf(lunch);
  const width = (await settledBox(win.locator('.cal-col').first())).width;
  const box = await settledBox(lunch);
  const from = { x: box.x + box.width / 2, y: box.y + 12 };
  // One column right and an hour and a half down: Thursday 14:00.
  await drag(from, { x: from.x + width, y: from.y + 84 }, {
    before: () => expect(win.locator('.cal-ghost')).toContainText('14:00 – 15:00')
  });
  const thursday = await shiftDays(wednesday, 1);
  const moved = await timeOn(thursday, 14);
  await expect.poll(async () => (await stored(id)).start).toBe(moved);
  expect((await stored(id)).end).toBe(moved + 3600000);
  await expect(event('Lunch with Sanne')).toContainText('14:00 – 15:00');
  expect(await columnOf(event('Lunch with Sanne'))).toBe(thursday);
  // The release doesn't also open the card.
  await expect(card()).toHaveCount(0);
  await expect(toast()).toContainText('Event moved');

  await toast().locator('button', { hasText: 'Undo' }).click();
  await expect.poll(async () => (await stored(id)).start).toBe(before.start);
  expect((await stored(id)).end).toBe(before.end);
  await expect(toast()).toContainText('Change undone');
  await expect(event('Lunch with Sanne')).toContainText('12:30 – 13:30');
  expect(await columnOf(event('Lunch with Sanne'))).toBe(wednesday);
});

test("an event's bottom edge changes its end, and Ctrl+Z undoes it", async () => {
  await openCalendar();
  await scrollGrid(7);
  const dentist = event('Dentist');
  const id = await dentist.getAttribute('data-ev');
  const before = await stored(id);
  const box = await settledBox(dentist);
  const edge = { x: box.x + box.width / 2, y: box.y + box.height - 2 };
  // 45 minutes later: 09:15 becomes 10:00.
  await drag(edge, { x: edge.x, y: edge.y + 42 });
  await expect.poll(async () => (await stored(id)).end).toBe(before.end + 45 * 60000);
  expect((await stored(id)).start).toBe(before.start);
  await expect(toast()).toContainText('End time changed');
  await expect(event('Dentist')).toContainText('08:30 – 10:00');

  await win.keyboard.press('Control+z');
  await expect.poll(async () => (await stored(id)).end).toBe(before.end);
  await expect(toast()).toContainText('Change undone');
});

test('Escape during a drag puts the event back and the release does nothing', async () => {
  await openCalendar();
  await scrollGrid(7);
  const call = event('Call with Vandebron');
  const id = await call.getAttribute('data-ev');
  const before = await stored(id);
  const from = center(await settledBox(call));
  await win.mouse.move(from.x, from.y);
  await win.mouse.down();
  await win.mouse.move(from.x, from.y + 60, { steps: 6 });
  await win.mouse.move(from.x, from.y + 120, { steps: 6 });
  await expect(win.locator('.cal-ghost')).toHaveCount(1);
  await win.keyboard.press('Escape');
  await expect(win.locator('.cal-ghost')).toHaveCount(0);
  await expect(call).not.toHaveClass(/drag-src/);
  await win.mouse.move(from.x, from.y + 180, { steps: 4 });
  await win.mouse.up();
  await expect(win.locator('.cal-ghost')).toHaveCount(0);
  await expect(card()).toHaveCount(0);
  await expect(win.locator('.dialog')).toHaveCount(0);
  await win.waitForTimeout(300);
  expect((await stored(id)).start).toBe(before.start);

  // The grid works as before: a click still makes an event at the half hour.
  const col = win.locator('.cal-col').nth(0);
  const box = await settledBox(col);
  await win.mouse.click(box.x + 20, box.y + 8 * 56 + 10);
  await expect(win.locator('.cal-form [name="startTime"]')).toHaveValue('08:00');
  await win.keyboard.press('Escape');
});

test('a drag that loses its release puts the event back, the grid draws again and the next click saves nothing', async () => {
  await openCalendar();
  await scrollGrid(7);
  const lunch = event('Lunch with Sanne');
  const id = await lunch.getAttribute('data-ev');
  const before = await stored(id);
  const ghost = win.locator('.cal-ghost');
  const accountId = await demoAccount();
  const monday = await columnOf(event('Roadmap review'));
  const arrive = async (title, h) => {
    const start = await timeOn(monday, h);
    await win.evaluate(([accountId, title, start]) => window.mail.call('calendarCreate', { accountId, calendarId: 'personal', title, allDay: false, start, end: start + 3600000 }), [accountId, title, start]);
  };
  // A spot in the toolbar that is no control: a release or click there does nothing of its own.
  const spacer = await win.evaluate(() => {
    const r = document.querySelector('.calendar .cal-head').getBoundingClientRect();
    const y = r.top + r.height / 2;
    for (let x = r.left + 4; x < r.right; x += 8) {
      const el = document.elementFromPoint(x, y);
      if (el && el.closest('.cal-head') && !el.closest('button, a, input, [role="tablist"]')) return { x, y };
    }
    return null;
  });
  expect(spacer).not.toBeNull();

  // The mouse comes back with its button up, as after Alt+Tab mid-drag: the window never saw the release.
  const cdp = await win.context().newCDPSession(win);
  const mouse = (type, { x, y }, buttons) =>
    cdp.send('Input.dispatchMouseEvent', { type, x, y, buttons, button: type === 'mouseMoved' && !buttons ? 'none' : 'left', clickCount: type === 'mouseMoved' ? 0 : 1 });
  const from = center(await settledBox(lunch));
  await mouse('mousePressed', from, 1);
  for (let i = 1; i <= 8; i++) await mouse('mouseMoved', { x: from.x, y: from.y + i * 14 }, 1);
  await expect(ghost).toContainText('14:30 – 15:30');
  await arrive('Arrived during the drag', 15);
  await expect(event('Arrived during the drag')).toHaveCount(0);
  await mouse('mouseMoved', { x: from.x, y: from.y + 140 }, 0);
  await expect(ghost).toHaveCount(0);
  await expect(win.locator('.calendar')).not.toHaveClass(/\bdragging\b/);
  // The grid draws what came in meanwhile, and what comes in from now on.
  await expect(event('Arrived during the drag')).toBeVisible();
  await arrive('Arrived afterwards', 17);
  await expect(event('Arrived afterwards')).toBeVisible();
  // The release that turns up late, and a click after it, change nothing.
  await mouse('mouseReleased', spacer, 0);
  await mouse('mousePressed', spacer, 1);
  await mouse('mouseReleased', spacer, 0);
  await win.waitForTimeout(300);
  expect((await stored(id)).start).toBe(before.start);
  await expect(event('Lunch with Sanne')).toContainText('12:30 – 13:30');
  await expect(toast()).not.toContainText('Event moved');

  // The same when the window loses the focus mid-drag.
  let box = center(await settledBox(lunch));
  await drag(box, { x: box.x, y: box.y + 112 }, {
    before: async () => {
      await expect(ghost).toHaveCount(1);
      await win.evaluate(() => window.dispatchEvent(new Event('blur')));
      await expect(ghost).toHaveCount(0);
      await win.mouse.move(spacer.x, spacer.y, { steps: 3 });
    }
  });
  await win.waitForTimeout(300);
  expect((await stored(id)).start).toBe(before.start);

  // And when something else takes the pointer away from the event.
  box = center(await settledBox(lunch));
  await drag(box, { x: box.x, y: box.y + 112 }, {
    before: async () => {
      await expect(ghost).toHaveCount(1);
      await win.evaluate(() => document.querySelector('.calendar .drag-src').releasePointerCapture(1));
      await win.mouse.move(box.x, box.y + 130, { steps: 2 });
      await expect(ghost).toHaveCount(0);
      await win.mouse.move(spacer.x, spacer.y, { steps: 3 });
    }
  });
  await win.waitForTimeout(300);
  expect((await stored(id)).start).toBe(before.start);
  await expect(event('Lunch with Sanne')).toContainText('12:30 – 13:30');
  await expect(win.locator('.dialog')).toHaveCount(0);
});

test('nothing redraws the grid during a drag; what came in meanwhile shows after it', async () => {
  await openCalendar();
  await scrollGrid(7);
  const lunch = event('Lunch with Sanne');
  const from = center(await settledBox(lunch));
  await win.evaluate(() => (window.__grid = document.querySelector('.cal-grid')));
  const accountId = await demoAccount();
  const monday = await columnOf(event('Roadmap review'));
  const start = await timeOn(monday, 15);
  await drag(from, { x: from.x, y: from.y + 56 }, {
    before: async () => {
      // A change from elsewhere arrives while the pointer is down.
      await win.evaluate(([accountId, start]) => window.mail.call('calendarCreate', { accountId, calendarId: 'personal', title: 'Arrived meanwhile', allDay: false, start, end: start + 3600000 }), [accountId, start]);
      await win.waitForTimeout(400);
      expect(await win.evaluate(() => window.__grid === document.querySelector('.cal-grid'))).toBe(true);
      await expect(win.locator('.cal-ghost')).toHaveCount(1);
      await expect(event('Arrived meanwhile')).toHaveCount(0);
    }
  });
  await expect(event('Arrived meanwhile')).toBeVisible();
  await expect(event('Lunch with Sanne')).toContainText('13:30 – 14:30');
});

// A Google account next to the demo, on a fake Google Calendar: one event on Tuesday from 09:00 to 10:00 with the
// given fields. With refuse, the calendar takes no changes; otherwise a change is kept, and each one is noted in
// global.__googlePatches with the sendUpdates it asked for.
async function addGoogle(fields, { refuse = false } = {}) {
  await app.evaluate(({}, [fields, refuse]) => {
    const engine = global.__semEngine;
    const monday = new Date();
    monday.setHours(0, 0, 0, 0);
    monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
    const at = (day, h) => new Date(monday.getTime() + day * 86400000 + h * 3600000).toISOString();
    const store = [{ id: 'g1', etag: '"1"', start: { dateTime: at(1, 9) }, end: { dateTime: at(1, 10) }, organizer: { email: 'work@gmail.com', self: true }, ...fields }];
    const json = (status, body) => ({ ok: status < 300, status, json: async () => body });
    global.__googlePatches = [];
    global.__semCalendars.fetch = async (url, opts = {}) => {
      const u = new URL(url);
      const method = opts.method || 'GET';
      if (u.pathname.endsWith('/users/me/calendarList')) return json(200, { items: [{ id: 'work@gmail.com', summary: 'work@gmail.com', primary: true, accessRole: 'owner', selected: true }] });
      const id = decodeURIComponent(u.pathname.split('/events/')[1] || '');
      if (!id && method === 'GET') return json(200, { items: store });
      const item = store.find((e) => e.id === id);
      if (item && method === 'GET') return json(200, item);
      if (refuse || !item || method !== 'PATCH') return json(400, { error: { code: 400, message: 'Not today' } });
      global.__googlePatches.push({ sendUpdates: u.searchParams.get('sendUpdates') });
      Object.assign(item, JSON.parse(opts.body), { etag: `"${Number(item.etag.replace(/"/g, '')) + 1}"` });
      return json(200, item);
    };
    engine.accounts.push({
      id: 'g-work',
      type: 'imap',
      provider: 'google',
      auth: 'oauth2',
      email: 'work@gmail.com',
      name: 'Work account',
      color: '#ff8a3d',
      secret: 'plain:',
      scopes: ['https://mail.google.com/', 'https://www.googleapis.com/auth/calendar.calendarlist.readonly', 'https://www.googleapis.com/auth/calendar.events'],
      imap: { host: 'imap.gmail.com', port: 993, secure: true, user: 'work@gmail.com' },
      smtp: { host: 'smtp.gmail.com', port: 465, secure: true, user: 'work@gmail.com' }
    });
    engine.caches.set('g-work', { folders: [], boxes: {}, lastSync: null });
    engine.tokens.set('g-work', { accessToken: 'token', expiresAt: Date.now() + 3600000 });
    engine.emit('updated');
  }, [fields, refuse]);
}

test('a move the calendar refuses snaps back, with the reason in a toast', async () => {
  await openCalendar();
  // A Google account whose calendar takes no changes.
  await addGoogle({ summary: 'Board meeting' }, { refuse: true });
  const board = event('Board meeting');
  await expect(board).toBeVisible({ timeout: 10000 });
  await scrollGrid(7);
  const id = await board.getAttribute('data-ev');
  const before = await stored(id);
  const tuesday = await columnOf(board);
  const from = center(await settledBox(board));
  await drag(from, { x: from.x, y: from.y + 112 });
  await expect(toast()).toContainText('Google Calendar refused the request (Not today).');
  await expect(win.locator('.cal-ghost')).toHaveCount(0);
  await expect(event('Board meeting')).toContainText('09:00 – 10:00');
  expect(await columnOf(event('Board meeting'))).toBe(tuesday);
  expect((await stored(id)).start).toBe(before.start);
});

test('a meeting with guests asks whether they hear about the move; Cancel puts it back, Undo tells them the same way', async () => {
  await openCalendar();
  await addGoogle({
    summary: 'Planning with Sanne',
    attendees: [
      { email: 'work@gmail.com', self: true, organizer: true, responseStatus: 'accepted' },
      { email: 'sanne@example.com', responseStatus: 'needsAction' }
    ]
  });
  const planning = event('Planning with Sanne');
  await expect(planning).toBeVisible({ timeout: 10000 });
  await scrollGrid(7);
  const id = await planning.getAttribute('data-ev');
  const before = await stored(id);
  const patches = () => app.evaluate(() => global.__googlePatches);
  const dialog = win.locator('.dialog');

  let from = center(await settledBox(planning));
  await drag(from, { x: from.x, y: from.y + 112 });
  await expect(dialog.locator('h2')).toHaveText('Send the change to the guests?');
  await dialog.locator('button', { hasText: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(win.locator('.cal-ghost')).toHaveCount(0);
  await expect(event('Planning with Sanne')).toContainText('09:00 – 10:00');
  expect(await patches()).toEqual([]);
  expect((await stored(id)).start).toBe(before.start);

  from = center(await settledBox(planning));
  await drag(from, { x: from.x, y: from.y + 112 });
  await dialog.locator('button', { hasText: /^Send$/ }).click();
  await expect.poll(async () => (await stored(id)).start).toBe(before.start + 2 * 3600000);
  await expect(event('Planning with Sanne')).toContainText('11:00 – 12:00');
  expect(await patches()).toEqual([{ sendUpdates: 'all' }]);
  await toast().locator('button', { hasText: 'Undo' }).click();
  await expect.poll(async () => (await stored(id)).start).toBe(before.start);
  expect(await patches()).toEqual([{ sendUpdates: 'all' }, { sendUpdates: 'all' }]);
});

test('a recurring event asks which events move; all of them move, and there is no Undo for that', async () => {
  await openCalendar();
  await scrollGrid(16);
  // A 45-minute event is too short to show its end; its accessible name has both times.
  const piano = event('Piano lesson');
  const times = (text) => expect(event('Piano lesson')).toHaveAttribute('aria-label', new RegExp(`, ${text}, `));
  await times('18:30 – 19:15');
  const tuesday = await columnOf(piano);
  const dialog = win.locator('.dialog');

  // Cancel leaves the series as it was.
  let from = center(await settledBox(piano));
  await drag(from, { x: from.x, y: from.y + 56 }, { before: () => expect(win.locator('.cal-ghost')).toContainText('19:30 – 20:15') });
  await expect(dialog.locator('h2')).toHaveText('Move a recurring event');
  await dialog.locator('button', { hasText: 'Cancel' }).click();
  await expect(win.locator('.cal-ghost')).toHaveCount(0);
  await times('18:30 – 19:15');

  from = center(await settledBox(piano));
  await drag(from, { x: from.x, y: from.y + 56 });
  await dialog.locator('.radio-row', { hasText: 'All events in the series' }).click();
  await expect(toast()).toContainText('Event moved');
  await expect(toast()).not.toHaveClass(/\bhas-action\b/);
  await times('19:30 – 20:15');
  expect(await columnOf(event('Piano lesson'))).toBe(tuesday);
  // Two weeks on, the series' own Tuesday moved with it.
  await win.keyboard.press('j');
  await win.keyboard.press('j');
  await times('19:30 – 20:15');
});

test('on a touch screen a swipe scrolls the grid and a long press moves the event', async () => {
  await openCalendar();
  await scrollGrid(7);
  const cdp = await win.context().newCDPSession(win);
  const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
  const lunch = event('Lunch with Sanne');
  const id = await lunch.getAttribute('data-ev');
  const before = await stored(id);
  const scrollTop = () => win.locator('.cal-scroll').evaluate((el) => el.scrollTop);

  // A swipe right away: the grid scrolls and the event stays.
  let box = await settledBox(lunch);
  let x = box.x + box.width / 2;
  let y = box.y + 20;
  const top = await scrollTop();
  await touch('touchStart', x, y);
  for (let i = 1; i <= 8; i++) {
    await touch('touchMove', x, y - i * 15);
    await win.waitForTimeout(16);
  }
  await touch('touchEnd');
  await expect.poll(scrollTop).toBeGreaterThan(top + 40);
  await expect(win.locator('.cal-ghost')).toHaveCount(0);

  // Holding still first: the finger moves the event instead, an hour down, and the grid stays put. The swipe's
  // momentum ends first.
  let last = -1;
  await expect.poll(async () => {
    const now = await scrollTop();
    const still = now === last;
    last = now;
    return still;
  }, { intervals: [150] }).toBe(true);
  await scrollGrid(7);
  box = await settledBox(lunch);
  x = box.x + box.width / 2;
  y = box.y + 20;
  await touch('touchStart', x, y);
  await win.waitForTimeout(450);
  for (let i = 1; i <= 8; i++) {
    await touch('touchMove', x, y + i * 7);
    await win.waitForTimeout(16);
  }
  await expect(win.locator('.cal-ghost')).toContainText('13:30 – 14:30');
  expect(await scrollTop()).toBe(7 * 56);
  await touch('touchEnd');
  await expect.poll(async () => (await stored(id)).start).toBe(before.start + 3600000);
  await expect(card()).toHaveCount(0);
});

test('in the month an event moves by whole days, and a drag over empty days makes an all-day event', async () => {
  await openCalendar();
  await win.keyboard.press('m');
  const chip = win.locator('.cal-mchip', { hasText: 'Dentist' });
  const id = await chip.getAttribute('data-ev');
  const before = await stored(id);
  const thursday = await win.evaluate((ms) => new Date(ms).setHours(0, 0, 0, 0), before.start);
  const friday = await shiftDays(thursday, 1);
  const target = center(await settledBox(win.locator(`.cal-mcell[data-cal-mday="${friday}"]`)));
  await drag(center(await settledBox(chip)), { x: target.x, y: target.y + 30 }, {
    before: () => expect(win.locator(`.cal-mcell[data-cal-mday="${friday}"]`)).toHaveClass(/\bdrop\b/)
  });
  await expect.poll(async () => (await stored(id)).start).toBe(await shiftDays(before.start, 1));
  expect((await stored(id)).end).toBe(await shiftDays(before.end, 1));
  await expect(toast()).toContainText('Event moved');

  // Three months on nothing is planned: a drag over three empty days.
  for (let i = 0; i < 3; i++) await win.keyboard.press('j');
  const cells = win.locator('.cal-mweek').nth(1).locator('.cal-mcell');
  const first = await settledBox(cells.nth(0));
  const third = await settledBox(cells.nth(2));
  const startDay = Number(await cells.nth(0).getAttribute('data-cal-mday'));
  await drag({ x: first.x + first.width / 2, y: first.y + first.height - 8 }, { x: third.x + third.width / 2, y: third.y + third.height - 8 });
  await expect(win.locator('.cal-form [name="allDay"]')).toBeChecked();
  await expect(win.locator('.cal-form [name="startDate"]')).toHaveValue(await dateText(startDay));
  await expect(win.locator('.cal-form [name="endDate"]')).toHaveValue(await dateText(await shiftDays(startDay, 2)));
  await win.keyboard.press('Escape');
  await expect(win.locator('.cal-form')).toHaveCount(0);

  // A double click on an empty day makes a one-day event.
  await win.mouse.dblclick(third.x + third.width / 2, third.y + third.height - 8);
  await expect(win.locator('.cal-form [name="allDay"]')).toBeChecked();
  await expect(win.locator('.cal-form [name="startDate"]')).toHaveValue(await dateText(await shiftDays(startDay, 2)));
  await expect(win.locator('.cal-form [name="endDate"]')).toHaveValue(await dateText(await shiftDays(startDay, 2)));
  await win.keyboard.press('Escape');
});

test("in the week's all-day row a chip moves by whole days, and a drag over empty days makes an all-day event", async () => {
  await openCalendar();
  const chip = win.locator('.cal-allday .cal-chip', { hasText: 'Team offsite' });
  const id = await chip.getAttribute('data-ev');
  const before = await stored(id);
  const first = await win.evaluate((ms) => new Date(ms).setHours(0, 0, 0, 0), before.start);
  const next = await shiftDays(first, 1);
  // The chip runs over two days; taken at its first day and let go a day further on.
  const box = await settledBox(chip);
  const from = { x: box.x + 20, y: box.y + box.height / 2 };
  const cell = await settledBox(win.locator(`.cal-allday [data-cal-allday="${first}"]`));
  await drag(from, { x: from.x + cell.width, y: from.y }, {
    before: async () => {
      await expect(win.locator(`.cal-allday [data-cal-allday="${next}"]`)).toHaveClass(/\bdrop\b/);
      await expect(win.locator(`.cal-allday [data-cal-allday="${first}"]`)).not.toHaveClass(/\bdrop\b/);
    }
  });
  await expect.poll(async () => (await stored(id)).start).toBe(await shiftDays(before.start, 1));
  const moved = await stored(id);
  expect(moved.end).toBe(await shiftDays(before.end, 1));
  expect(moved.allDay).toBe(true);
  await expect(toast()).toContainText('Event moved');
  await expect(win.locator('.cal-allday .drop')).toHaveCount(0);

  // Monday and Tuesday have no all-day events: a drag across both.
  const monday = await columnOf(event('Roadmap review'));
  const tuesday = await shiftDays(monday, 1);
  const a = await settledBox(win.locator(`.cal-allday [data-cal-allday="${monday}"]`));
  const b = await settledBox(win.locator(`.cal-allday [data-cal-allday="${tuesday}"]`));
  await drag({ x: a.x + a.width / 2, y: a.y + a.height - 4 }, { x: b.x + b.width / 2, y: b.y + b.height - 4 });
  await expect(win.locator('.cal-form [name="allDay"]')).toBeChecked();
  await expect(win.locator('.cal-form [name="startDate"]')).toHaveValue(await dateText(monday));
  await expect(win.locator('.cal-form [name="endDate"]')).toHaveValue(await dateText(tuesday));
  await win.keyboard.press('Escape');
  await expect(win.locator('.cal-form')).toHaveCount(0);
});

test("a calendar's menu sets its colour, kept after a reload, and whether it counts toward availability", async () => {
  await openCalendar();
  const colour = (title) => event(title).evaluate((el) => el.style.getPropertyValue('--c'));
  expect(await colour('Roadmap review')).toBe('#2fd6c0');
  const work = win.locator('.sidebar .cal-toggle', { hasText: 'Work' });
  const key = await work.getAttribute('data-cal-toggle');
  await work.click({ button: 'right' });
  const menu = win.locator('.menu');
  await expect(menu.locator('.menu-heading')).toHaveText('Work');
  await expect(menu.locator('.cal-swatch-btn')).toHaveCount(12);
  await menu.locator('[data-color="#f06cb4"]').click();
  await expect(menu).toHaveCount(0);
  await expect.poll(() => colour('Roadmap review')).toBe('#f06cb4');
  // Only that calendar: the personal one keeps the account's colour.
  expect(await colour('Lunch with Sanne')).toBe('#2fd6c0');
  await expect(work.locator('.cal-check')).toHaveAttribute('style', /#f06cb4/);
  await expect.poll(async () => (await calendarState()).colors[key]).toBe('#f06cb4');

  await win.reload();
  await expect(event('Roadmap review')).toBeVisible({ timeout: 10000 });
  await expect.poll(() => colour('Roadmap review')).toBe('#f06cb4');
  // The event card shows the calendar's colour too.
  await event('Roadmap review').click();
  await expect(card().locator('.cal-swatch')).toHaveAttribute('style', /#f06cb4/);
  await win.keyboard.press('Escape');

  // The ⋯ button opens the same menu, also from the keyboard.
  const row = win.locator('.sidebar .cal-side-row', { hasText: 'Work' });
  await row.locator('[data-cal-menu]').focus();
  await win.keyboard.press('Enter');
  const counts = menu.locator('[role="menuitemcheckbox"]', { hasText: 'Counts toward availability' });
  await expect(counts).toHaveAttribute('aria-checked', 'true');
  await expect(menu.locator('[aria-checked="true"][data-color="#f06cb4"]')).toBeFocused();
  await counts.click();
  await expect.poll(async () => (await calendarState()).availability[key]).toBe(false);
  await row.locator('[data-cal-menu]').click();
  await expect(menu.locator('[role="menuitemcheckbox"]', { hasText: 'Counts toward availability' })).toHaveAttribute('aria-checked', 'false');
  await menu.locator('button', { hasText: 'Default color' }).click();
  await expect.poll(() => colour('Roadmap review')).toBe('#2fd6c0');
  await expect.poll(async () => (await calendarState()).colors[key]).toBeUndefined();
});

test("a calendar's menu stays in the window, and one that isn't the user's own says what counting it does", async () => {
  await openCalendar();
  const menu = win.locator('.menu');
  // The menu's place once its opening animation, which scales it for a moment, is over.
  const place = () =>
    menu.evaluate((el) => {
      for (const a of el.getAnimations()) a.finish();
      // Within a pixel: a menu is placed by its whole-pixel height.
      const r = el.getBoundingClientRect();
      return { top: Math.round(r.top), bottom: Math.round(r.bottom), inner: window.innerHeight };
    });
  const birthdays = win.locator('.sidebar .cal-toggle', { hasText: 'Birthdays' });
  const key = await birthdays.getAttribute('data-cal-toggle');

  // A right click near the bottom of the window: the menu opens upward from it, swatches and all.
  const inner = await win.evaluate(() => window.innerHeight);
  await birthdays.evaluate((el, y) => el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 120, clientY: y })), inner - 30);
  await expect(menu.locator('.cal-swatch-btn')).toHaveCount(12);
  let p = await place();
  expect(p.bottom).toBeLessThanOrEqual(inner - 8);
  expect(p.bottom).toBeLessThanOrEqual(inner - 30);
  expect(p.top).toBeGreaterThanOrEqual(8);
  const counts = menu.locator('[role="menuitemcheckbox"]');
  await expect(counts).toContainText("Not your own calendar: when it's busy, you count as busy too.");
  await expect(counts).toHaveAttribute('aria-checked', 'false');
  await counts.click();
  await expect.poll(async () => (await calendarState()).availability[key]).toBe(true);
  // The user's own calendars have no such note.
  await win.locator('.sidebar .cal-toggle', { hasText: 'Work' }).click({ button: 'right' });
  await expect(menu.locator('[role="menuitemcheckbox"]')).toHaveText('Counts toward availability');
  await win.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);

  // A short window with the ⋯ button low in it: the menu goes above the button.
  const more = win.locator('.sidebar .cal-side-row', { hasText: 'Birthdays' }).locator('[data-cal-menu]');
  const button = await settledBox(more);
  const frame = 950 - inner;
  await app.evaluate(({ BrowserWindow }, h) => BrowserWindow.getAllWindows()[0].setSize(1500, h), Math.max(560, Math.round(button.y + button.height + 120 + frame)));
  await expect.poll(() => win.evaluate(() => window.innerHeight)).toBeLessThan(inner);
  const low = await settledBox(more);
  await more.click();
  await expect(menu.locator('.cal-swatch-btn')).toHaveCount(12);
  p = await place();
  expect(p.bottom).toBeLessThanOrEqual(p.inner - 8);
  expect(p.top).toBeGreaterThanOrEqual(8);
  if (p.inner - (low.y + low.height) < p.bottom - p.top) expect(p.bottom).toBeLessThanOrEqual(low.y);
  // Its last row can be clicked.
  const last = await menu.locator('[role="menuitemcheckbox"]').boundingBox();
  expect(last.y + last.height).toBeLessThanOrEqual(p.inner);
  await win.keyboard.press('Escape');
});

test('the eye toggles kept on this computer move into Settings once', async () => {
  await openCalendar();
  const key = await win.locator('.sidebar .cal-toggle', { hasText: 'Work' }).getAttribute('data-cal-toggle');
  expect(Object.keys((await calendarState()).visible)).toHaveLength(0);
  await win.evaluate((k) => localStorage.setItem('rukoo.calendar', JSON.stringify({ view: 'week', visible: { [k]: false } })), key);
  await win.reload();
  await expect.poll(async () => (await calendarState()).visible[key]).toBe(false);
  await expect(win.locator('.sidebar .cal-toggle', { hasText: 'Work' })).toHaveAttribute('aria-checked', 'false');
  await expect(event('Lunch with Sanne')).toBeVisible();
  await expect(event('Roadmap review')).toHaveCount(0);
  expect(await win.evaluate(() => JSON.parse(localStorage.getItem('rukoo.calendar')).visibleMigrated)).toBe(true);
});

test('search finds events on every calendar and a result opens the event in the calendar', async () => {
  await openCalendar();
  await win.keyboard.press('/');
  const input = win.locator('.cal-search input');
  await expect(input).toBeFocused();
  await expect(win.locator('.cal-body')).toContainText('Search titles, places, descriptions and guests.');
  await input.fill('dentist');
  const result = win.locator('.cal-row[data-search-ev]', { hasText: 'Dentist' });
  await expect(result).toBeVisible();
  await expect(win.locator('.cal-search-count')).toHaveText('1 event found');
  // Guests are searched too.
  await input.fill('Joris');
  await expect(win.locator('.cal-row[data-search-ev]', { hasText: 'Quarterly planning' }).first()).toBeVisible();
  await input.fill('nothing like this');
  await expect(win.locator('.cal-search-count')).toHaveText('No events match “nothing like this”');
  await input.fill('dentist');
  await expect(result).toBeVisible();
  await result.click();
  await expect(win.locator('.cal-search')).toHaveCount(0);
  await expect(card().locator('h2')).toHaveText('Dentist');
  await expect(win.locator('.calendar .open[data-ev]')).toContainText('Dentist');

  // Escape leaves the search; the toolbar button opens a new one.
  await win.keyboard.press('Escape');
  await win.click('[data-cal="search"]');
  await expect(input).toHaveValue('');
  await input.fill('KL1691');
  await expect(win.locator('.cal-row[data-search-ev]', { hasText: 'KL1691' })).toBeVisible();
  await win.keyboard.press('Escape');
  await expect(win.locator('.cal-search')).toHaveCount(0);
  await expect(win.locator('.cal-grid')).toBeVisible();
});

test('week start, weekends and working hours follow Settings → Calendar', async () => {
  await openCalendar();
  // Working days 09:00 to 17:00: before and after are shaded on each of the five, all day at the weekend.
  await expect(win.locator('.cal-col')).toHaveCount(7);
  await expect(win.locator('.cal-off')).toHaveCount(12);
  await win.evaluate(() => window.mail.call('calendarSettings', { weekStart: 0, weekends: false, workDays: [1, 2, 3], workStart: '08:00', workEnd: '18:00' }));
  await expect(win.locator('.cal-dayhead')).toHaveCount(5);
  await expect(win.locator('.cal-dayhead .dow')).toHaveText(['Mon', 'Tue', 'Wed', 'Thu', 'Fri']);
  // Thursday and Friday are no working days now: shaded from top to bottom.
  await expect(win.locator('.cal-off')).toHaveCount(3 * 2 + 2);
  const first = await win.locator('.cal-col').first().locator('.cal-off').first().evaluate((el) => el.style.height);
  expect(first).toBe(`${8 * 56}px`);
  // The mini month starts its weeks on Sunday; the month leaves out the weekend.
  await expect(win.locator('.sidebar .cal-mini-dow').first()).toHaveText('S');
  await win.keyboard.press('m');
  await expect(win.locator('.cal-mname')).toHaveText(['Mon', 'Tue', 'Wed', 'Thu', 'Fri']);
});

test('a side panel, open time on the grid, booking requests and calendar-open from main', async () => {
  await openCalendar();
  const button = win.locator('[data-cal-panel="free"]');
  // A panel as calendar-free.js registers one.
  await win.evaluate(async () => {
    const shared = await import('./calendar-shared.js');
    window.__panel = { renders: 0, closes: 0, opened: null };
    shared.hooks.panels.free = {
      title: () => 'Availability',
      render(host) {
        window.__panel.renders++;
        host.innerHTML = '<button class="test-free">Copy as text</button>';
      },
      close() {
        window.__panel.closes++;
      }
    };
    shared.hooks.openRequest = (id, anchor) => {
      window.__panel.opened = { id, request: anchor.dataset.request || null };
    };
  });
  await win.keyboard.press('w');
  await expect(button).toBeVisible();
  await expect(button).toHaveAttribute('title', 'Availability (A)');
  await win.keyboard.press('a');
  const panel = win.locator('.cal-panel');
  await expect(panel).toBeVisible();
  await expect(panel.locator('h2')).toHaveText('Availability');
  await expect(panel.locator('.test-free')).toBeFocused();
  await expect(button).toHaveAttribute('aria-pressed', 'true');
  await expect(panel).not.toHaveClass(/\bsheet\b/);
  // The grid keeps its week and at least 560 pixels.
  await expect(win.locator('.cal-dayhead')).toHaveCount(7);
  expect(await win.locator('.cal-body').evaluate((el) => el.clientWidth)).toBeGreaterThanOrEqual(560);

  // Open time the panel found shows on the grid.
  const wednesday = await columnOf(event('Lunch with Sanne'));
  const [from, to] = [await timeOn(wednesday, 14), await timeOn(wednesday, 16)];
  await win.evaluate(async ([from, to]) => (await import('./calendar.js')).setHighlight([[from, to]]), [from, to]);
  const highlight = win.locator(`.cal-col[data-cal-col="${wednesday}"] .cal-hl`);
  await expect(highlight).toHaveCount(1);
  expect(await highlight.evaluate((el) => [el.style.top, el.style.height])).toEqual([`${14 * 56}px`, `${2 * 56}px`]);
  // Escape in the panel closes it, and the highlight goes with it.
  await panel.locator('.test-free').focus();
  await win.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await expect(button).toBeFocused();
  await expect(win.locator('.cal-hl')).toHaveCount(0);
  expect(await win.evaluate(() => window.__panel)).toMatchObject({ renders: 1, closes: 1 });

  // A booking request waits for an answer: a dashed block at its time and a count on the mode switch.
  const thursday = await shiftDays(wednesday, 1);
  const start = await timeOn(thursday, 11);
  await win.evaluate(async (start) => {
    const cal = await import('./calendar.js');
    cal.setBooking({
      status: 'on',
      bookings: [{ id: 'Kq0bAAAAAAAAAAAAAAAAAA', status: 'confirmed', type: '30min', typeTitle: '30 minute meeting', start: start + 3600000, end: start + 5400000, eventId: null, guest: null }],
      requests: [{ id: 'Rf63vMqqWdS0MICDAHKmrw', status: 'pending', type: '30min', typeTitle: '30 minute meeting', start, end: start + 1800000, guest: { name: 'Jane <b>Doe</b>', email: 'jane@example.com', notes: '', timeZone: 'Europe/Amsterdam', locale: 'en', via: '' } }]
    });
  }, start);
  const request = win.locator(`.cal-col[data-cal-col="${thursday}"] .cal-req`);
  await expect(request).toHaveCount(1);
  // The guest's name is text, never markup.
  await expect(request).toContainText('RequestJane <b>Doe</b>');
  await expect(request).toHaveAttribute('aria-label', /^Booking request from Jane <b>Doe<\/b>, /);
  await expect(win.locator('[data-mode="calendar"] .seg-badge')).toHaveText('1');
  await expect(win.locator('[data-mode="calendar"]')).toHaveAttribute('aria-label', 'Calendar, 1 booking request');
  await request.click();
  expect(await win.evaluate(() => window.__panel.opened)).toEqual({ id: 'Rf63vMqqWdS0MICDAHKmrw', request: 'Rf63vMqqWdS0MICDAHKmrw' });

  // An event the booking service made carries the booking icon while the page is on. One whose booking the page no
  // longer has, from before it was turned off and on again, is a plain event.
  const accountId = await demoAccount();
  const booked = await timeOn(thursday, 12);
  const make = (title, start, bookingId) =>
    app.evaluate(({}, [accountId, title, start, bookingId]) => global.__semCalendars.create({ accountId, calendarId: 'personal', title, location: '', description: '', allDay: false, start, end: start + 1800000 }, { bookingId }), [accountId, title, start, bookingId]);
  await make('Intro call', booked, 'Kq0bAAAAAAAAAAAAAAAAAA');
  await make('Earlier booking', await timeOn(thursday, 16), 'Zz9zAAAAAAAAAAAAAAAAAA');
  await expect(event('Intro call').locator('.cal-mark')).toHaveCount(1);
  await expect(event('Intro call')).toHaveAttribute('aria-label', /Booked through your booking page$/);
  await expect(event('Earlier booking')).toBeVisible();
  await expect(event('Earlier booking').locator('.cal-mark')).toHaveCount(0);
  await expect(event('Earlier booking')).not.toHaveAttribute('aria-label', /Booked through your booking page/);
  await expect(event('Dentist').locator('.cal-mark')).toHaveCount(0);
  await win.keyboard.press('m');
  await expect(win.locator('.cal-mchip.cal-req')).toHaveCount(1);

  // The badge stays in the mailbox; a notification's click comes back as calendar-open.
  await win.keyboard.press('Control+1');
  await expect(win.locator('[data-mode="calendar"] .seg-badge')).toHaveText('1');
  await win.evaluate(() => (window.__panel.opened = null));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('mail:event', { type: 'calendar-open', payload: { request: 'Rf63vMqqWdS0MICDAHKmrw' } }));
  await expect(win.locator('.calendar')).toBeVisible();
  await expect.poll(() => win.evaluate(() => window.__panel.opened && window.__panel.opened.id)).toBe('Rf63vMqqWdS0MICDAHKmrw');

  // An event outside the loaded weeks: the view goes to its day and opens its card.
  const flight = await win.evaluate(() => window.mail.call('calendarSearch', 'KL1691').then((r) => r.events[0]));
  await win.keyboard.press('Control+1');
  await app.evaluate(({ BrowserWindow }, open) => BrowserWindow.getAllWindows()[0].webContents.send('mail:event', { type: 'calendar-open', payload: open }), { id: flight.id, start: flight.start });
  await expect(card().locator('h2')).toHaveText('KL1691 Amsterdam to Lisbon');
  const flightDay = await win.evaluate((ms) => new Date(ms).setHours(0, 0, 0, 0), flight.start);
  await expect(win.locator(`.cal-mnum[data-cal-day="${flightDay}"], .cal-dayhead[data-cal-day="${flightDay}"]`)).toHaveCount(1);
});

test('Sync now also fetches the booking page while it is on, and notices from elsewhere run their own actions', async () => {
  await openCalendar();
  // The calls the window makes, seen in main; bookingSync answers here, before the booking service exists.
  await app.evaluate(({ BrowserWindow, ipcMain }) => {
    const original = ipcMain._invokeHandlers.get('mail:call');
    global.__calls = [];
    BrowserWindow.getAllWindows()[0].webContents.ipc.handle('mail:call', (event, method, args) => {
      global.__calls.push(method);
      return method === 'bookingSync' ? { ok: true, result: null } : original(event, method, args);
    });
  });
  const calls = () => app.evaluate(() => global.__calls);
  const setBooking = (status) => win.evaluate(async (status) => (await import('./calendar.js')).setBooking({ status, bookings: [], requests: [] }), status);

  await setBooking('off');
  await win.keyboard.press('F5');
  await expect(toast()).toHaveText('Synced');
  expect(await calls()).toContain('calendarSync');
  expect(await calls()).not.toContain('bookingSync');
  await setBooking('on');
  await win.keyboard.press('F5');
  await expect.poll(async () => (await calls()).filter((m) => m === 'bookingSync').length).toBe(1);
  await win.click('[data-cal="sync"]');
  await expect.poll(async () => (await calls()).filter((m) => m === 'bookingSync').length).toBe(2);

  // Notices from the booking page: text stays text, and each button runs its own action.
  await win.evaluate(async () => {
    const cal = await import('./calendar.js');
    window.__ran = [];
    cal.setNotices('booking', [
      {
        id: 'stale',
        tone: 'warn',
        title: 'Booking page <b>not</b> updated',
        text: 'This computer last published two days ago.',
        actions: [
          { label: 'Dismiss', run: () => window.__ran.push('dismiss') },
          { label: 'Take over', primary: true, run: () => window.__ran.push('takeover') }
        ]
      },
      { id: 'cap', tone: 'error', title: 'Daily limit reached', text: 'No more bookings today.', actions: [{ label: 'Open', run: () => window.__ran.push('open') }] }
    ]);
    cal.setNotices('other', [{ id: 'x', tone: 'info', title: 'Another source', text: 'Kept apart.', actions: [] }]);
  });
  const stale = win.locator('.cal-notice', { hasText: 'not</b> updated' });
  await expect(stale).toHaveClass(/\bwarn\b/);
  await expect(stale.locator('.t')).toHaveText('Booking page <b>not</b> updated');
  await expect(stale.locator('button.primary')).toHaveText('Take over');
  await expect(win.locator('.cal-notice.error', { hasText: 'Daily limit reached' })).toBeVisible();
  await stale.locator('button', { hasText: 'Take over' }).click();
  await win.locator('.cal-notice', { hasText: 'Daily limit reached' }).locator('button', { hasText: 'Open' }).click();
  expect(await win.evaluate(() => window.__ran)).toEqual(['takeover', 'open']);
  // A source's empty list clears its own notices only.
  await win.evaluate(async () => (await import('./calendar.js')).setNotices('booking', []));
  await expect(stale).toHaveCount(0);
  await expect(win.locator('.cal-notice', { hasText: 'Another source' })).toBeVisible();
});

test('in a narrow window the panel lies over the grid and the mini month leaves the rail', async () => {
  await openCalendar();
  await win.evaluate(async () => {
    const shared = await import('./calendar-shared.js');
    shared.hooks.panels.free = { title: () => 'Availability', render: (host) => (host.textContent = 'Panel'), close() {} };
  });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(900, 800));
  await expect(win.locator('.shell')).toHaveClass(/\bcollapsed\b/);
  await expect(win.locator('.sidebar .cal-mini')).toBeHidden();
  await win.keyboard.press('a');
  await expect(win.locator('.cal-panel')).toHaveClass(/\bsheet\b/);
  // The grid behind it keeps its width; the panel lies at its right edge once it has slid in.
  const body = await win.locator('.cal-body').boundingBox();
  await expect.poll(async () => {
    const panel = await win.locator('.cal-panel').boundingBox();
    return Math.round(panel.x + panel.width - (body.x + body.width));
  }).toBe(0);
  expect(body.width).toBeGreaterThan((await win.locator('.cal-panel').boundingBox()).width);
  await expect(win.locator('.cal-dayhead')).toHaveCount(7);
});
