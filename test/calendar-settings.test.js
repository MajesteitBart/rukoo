'use strict';

// settings.calendar: defaults, what a hand-edited or older settings.json gets wrong, the per-calendar merge of
// calendarSettings(), its events, and updateSettings() leaving it alone.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tempDir } = require('./tmp');
const { Engine, DEFAULT_SETTINGS } = require('../src/main/engine');

const DEFAULTS = {
  visible: {},
  availability: {},
  colors: {},
  weekStart: null,
  weekends: true,
  workDays: [1, 2, 3, 4, 5],
  workStart: '09:00',
  workEnd: '17:00',
  duration: 60,
  reminder: 10,
  notify: true,
  notifiedUpgrade: false
};

function engine(settings) {
  const dataDir = tempDir('sem-calset-');
  if (settings) fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify(settings));
  return { engine: new Engine({ dataDir }).init(), dataDir };
}

test('a new profile has the calendar defaults, and an old or hand-edited one gets them where it is wrong', () => {
  assert.deepEqual(engine().engine.settings.calendar, DEFAULTS);
  const { engine: e } = engine({
    language: 'en',
    calendar: {
      visible: { 'a\ncal': false, 'a\nbad': 'yes' },
      availability: { 'a\ncal': true },
      colors: { 'a\ncal': '#A1B2C3', 'a\nbad': 'blue' },
      weekStart: 3,
      weekends: 'no',
      workDays: [5, 1, 1, 3],
      workStart: '18:00',
      workEnd: '17:00',
      duration: 7,
      reminder: null,
      notify: false,
      notifiedUpgrade: true,
      extra: 'dropped'
    }
  });
  assert.deepEqual(e.settings.calendar, {
    ...DEFAULTS,
    visible: { 'a\ncal': false },
    availability: { 'a\ncal': true },
    colors: { 'a\ncal': '#A1B2C3' },
    workDays: [1, 3, 5],
    reminder: null,
    notify: false,
    notifiedUpgrade: true
  }, 'an end before the start falls back as a pair');
  assert.equal(engine({ calendar: 'nonsense' }).engine.settings.calendar.duration, 60);
  assert.deepEqual(engine({ calendar: { workEnd: '24:00', weekStart: 6, workDays: [8] } }).engine.settings.calendar, { ...DEFAULTS, workEnd: '24:00', weekStart: 6 });
  // A map keeps at most 500 calendars.
  const many = Object.fromEntries(Array.from({ length: 600 }, (_, i) => [`a\n${i}`, true]));
  assert.equal(Object.keys(engine({ calendar: { visible: many } }).engine.settings.calendar.visible).length, 500);
});

test('calendarSettings merges calendars one by one, takes them back with null, saves, and tells the calendar services first', () => {
  const { engine: e, dataDir } = engine();
  const seen = [];
  e.on('calendar-settings', (c) => seen.push(['calendar-settings', c]));
  e.on('updated', () => seen.push(['updated']));
  let out = e.calendarSettings({ visible: { 'a\none': false }, colors: { 'a\none': '#112233' }, duration: 30 });
  assert.deepEqual([out.visible, out.colors, out.duration], [{ 'a\none': false }, { 'a\none': '#112233' }, 30]);
  assert.deepEqual(seen.map((s) => s[0]), ['calendar-settings', 'updated']);
  assert.equal(seen[0][1], e.settings.calendar);
  out = e.calendarSettings({ visible: { 'a\ntwo': true }, availability: { 'a\none': true } });
  assert.deepEqual(out.visible, { 'a\none': false, 'a\ntwo': true }, 'other calendars keep their choice');
  out = e.calendarSettings({ visible: { 'a\none': null }, colors: { 'a\none': 'not a colour' }, workDays: [0, 6], unknown: 1 });
  assert.deepEqual([out.visible, out.colors, out.workDays, out.duration, 'unknown' in out], [{ 'a\ntwo': true }, { 'a\none': '#112233' }, [0, 6], 30, false], 'a colour that is no colour keeps the one chosen');
  // Other fields replace, and what doesn't fit keeps what the user had.
  assert.equal(e.calendarSettings({ duration: 7 }).duration, 30);
  assert.equal(e.calendarSettings({ duration: 45 }).duration, 45);
  // Saved: a restart reads the same.
  const again = new Engine({ dataDir }).init();
  assert.deepEqual(again.settings.calendar, e.settings.calendar);
  assert.deepEqual(DEFAULT_SETTINGS.calendar, DEFAULTS, 'the defaults stay as they are');
});

test('working hours saved one end at a time keep the other end when the pair would not make a day', () => {
  const { engine: e } = engine();
  e.calendarSettings({ workStart: '07:00', workEnd: '15:00' });
  // A start after the current end: both stay, so the page shows what is saved and the user's 15:00 isn't lost.
  let out = e.calendarSettings({ workStart: '16:00' });
  assert.deepEqual([out.workStart, out.workEnd], ['07:00', '15:00']);
  out = e.calendarSettings({ workEnd: '22:00' });
  assert.deepEqual([out.workStart, out.workEnd], ['07:00', '22:00']);
  out = e.calendarSettings({ workStart: '16:00' });
  assert.deepEqual([out.workStart, out.workEnd], ['16:00', '22:00']);
  // Both at once, the way the settings page sends them.
  out = e.calendarSettings({ workStart: '08:30', workEnd: '12:00' });
  assert.deepEqual([out.workStart, out.workEnd], ['08:30', '12:00']);
  out = e.calendarSettings({ workStart: '13:00', workEnd: '12:00' });
  assert.deepEqual([out.workStart, out.workEnd], ['08:30', '12:00']);
  assert.deepEqual([e.calendarSettings({ workEnd: 'noon' }).workEnd, e.calendarSettings({ workStart: '24:00' }).workStart], ['12:00', '08:30']);
});

test('updateSettings leaves the calendar settings to calendarSettings', () => {
  const { engine: e } = engine();
  e.calendarSettings({ colors: { 'a\none': '#112233' } });
  const before = e.settings.calendar;
  e.updateSettings({ theme: 'dark', calendar: { colors: {}, duration: 15 } });
  assert.equal(e.settings.theme, 'dark');
  assert.deepEqual(e.settings.calendar, before);
  assert.deepEqual(e.state().settings.calendar, before, 'the windows get them with the rest of the state');
});
