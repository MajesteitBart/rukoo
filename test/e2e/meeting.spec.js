// End-to-end tests for the meeting view: the real app with the demo account, the fake agents (SEM_AGENT_FAKE=1) and a
// fake Rukoo Voice (test/fixtures/voice-server.js), paired through <SEM_DATA_DIR>/voice-bridge.json as voice/PROTOCOL.md
// says for a test profile. Nothing here reaches an installed Voice. Screenshots for review go to tmp/e2e-shots/meeting
// in the checkout, which Git ignores; each run replaces them.
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { tempDir, removeDir } = require('../tmp');
const { closeApp } = require('./close');
const { FakeVoice, startVoiceServer } = require('../fixtures/voice-server');

const ROOT = path.join(__dirname, '..', '..');
const SHOTS = path.join(ROOT, 'tmp', 'e2e-shots', 'meeting');
// Electron hides windows from capture only on Windows and macOS (main.js protectWindows).
const CAN_HIDE = process.platform === 'win32' || process.platform === 'darwin';

let app;
let win;
let dataDir;
let voice;

async function launch(size = [1500, 950]) {
  const env = { ...process.env, SEM_DATA_DIR: dataDir, SEM_HIDDEN: '1', SEM_AGENT_FAKE: '1', SEM_AGENT_FAKE_SCALE: '0.5' };
  delete env.ELECTRON_RUN_AS_NODE;
  // The pairing goes through the profile, never a path from the shell that started the tests.
  delete env.RUKOO_VOICE_BRIDGE;
  app = await electron.launch({ args: ['.'], cwd: ROOT, env });
  win = await app.firstWindow();
  await setSize(...size);
}

const setSize = (w, h) => app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setSize(w, h), [w, h]);
const connected = () => app.evaluate(() => global.__semVoice.connected);
const isProtected = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.isContentProtected()));

// ---------- demo screen frames ----------

// A small PNG encoder, so the fake Voice can send frame images without a file in the repository.
const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function png(width, height, paint) {
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) raw.set(paint(x, y), y * stride + 1 + x * 3);
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const head = Buffer.alloc(13);
  head.writeUInt32BE(width, 0);
  head.writeUInt32BE(height, 4);
  head[8] = 8;
  head[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', head), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]).toString('base64');
}
// A demo slide in one accent colour: a title band, three lines of "text" and a bar chart. Nothing real.
function slide([r, g, b], bars) {
  const inside = (x, y, x0, y0, x1, y1) => x >= x0 && x < x1 && y >= y0 && y < y1;
  return png(480, 270, (x, y) => {
    if (y < 48) return [r, g, b];
    if (inside(x, y, 32, 78, 290, 90) || inside(x, y, 32, 108, 250, 120) || inside(x, y, 32, 138, 270, 150)) return [96, 102, 116];
    for (let i = 0; i < bars.length; i++) if (inside(x, y, 320 + i * 34, 230 - bars[i], 344 + i * 34, 230)) return [r, g, b];
    if (inside(x, y, 312, 230, 456, 232)) return [190, 194, 204];
    return [250, 250, 252];
  });
}
const SLIDES = [slide([52, 92, 196], [40, 70, 110, 150]), slide([24, 140, 104], [120, 90, 60, 100]), slide([196, 98, 40], [60, 140, 80, 120])];
const frameId = (at) => `f-${String(at).padStart(9, '0')}`;

// Voice 0.1 has no pause handler in the fixture; these answer as Voice does.
function voiceHandlers(v) {
  v.handlers['meeting.pause'] = function (args) {
    if (this.status.recording !== args.meeting) return { error: { code: 'not_recording', message: 'Not recording.' } };
    this.append('meeting.state', args.meeting, { state: 'paused', at: 5000 });
    return {};
  };
  v.handlers['meeting.resume'] = function (args) {
    if (this.status.recording !== args.meeting) return { error: { code: 'not_recording', message: 'Not recording.' } };
    this.append('meeting.state', args.meeting, { state: 'recording', at: 6000 });
    return {};
  };
  // The frame at or before at, as Voice answers frame.get, with a demo slide for its image.
  v.handlers['frame.get'] = function (args) {
    const frames = this.events.filter((e) => e.event === 'frame' && e.meeting === args.meeting).map((e) => e.data);
    const f = frames.filter((x) => x.at <= args.at).sort((a, b) => b.at - a.at)[0];
    if (!f) return { error: { code: 'not_found', message: 'No frame at or before that time.' } };
    const n = frames.sort((a, b) => a.at - b.at).indexOf(f);
    return { frame: f, image: { type: 'image/png', data: SLIDES[n % SLIDES.length] } };
  };
}

test.beforeEach(async () => {
  dataDir = tempDir('rukoo-meeting-e2e-');
  voice = await startVoiceServer({ file: path.join(dataDir, 'voice-bridge.json') });
  voiceHandlers(voice);
  voice.writeDiscovery();
  await launch();
  await win.waitForSelector('.provider-grid');
  await win.click('[data-s="demo"]');
  await expect(win.locator('.item').first()).toBeVisible({ timeout: 15000 });
  await expect.poll(connected, { timeout: 10000 }).toBe(true);
});

test.afterEach(async () => {
  await closeApp(app);
  await voice.close();
  removeDir(dataDir);
});

// ---------- a scripted meeting ----------

const pid = (track, start) => `${track}-${String(start).padStart(9, '0')}`;

// A meeting Voice starts on its own, as from its pill: the events Voice sends, with both voices. screen: what it
// records of the screen.
function voiceStarts({ title = '', startedAt = Date.now(), context = null, screen = 'off' } = {}) {
  const id = voice.meetingId();
  voice.append('meeting.started', id, { title, startedAt, tracks: ['mic', 'call'], screen, startedBy: 'voice', context });
  voice.append('meeting.state', id, { state: 'recording', at: 0 });
  voice.append('status', null, { recording: id, dictating: false });
  voice.append('speaker', id, { id: 'mic', track: 'mic', label: 'You' });
  voice.append('speaker', id, { id: 'call-1', track: 'call', label: 'Speaker 1' });
  return id;
}

// One passage. push: false keeps it in Voice's log without sending it, as while Rukoo is away.
function say(id, track, start, text, { push = true, ...more } = {}) {
  return voice.append('passage', id, { id: pid(track, start), track, speaker: track === 'mic' ? 'mic' : 'call-1', start, end: start + 3000, text, revision: 1, dictation: false, language: 'en', ...more }, { push });
}

// A moment the screen changed, with the text Voice read on it.
function frameAt(id, at, text, { width = 1920, height = 1080, push = true } = {}) {
  return voice.append('frame', id, { id: frameId(at), at, width, height, text }, { push });
}

// The at of every frame.get Rukoo sent, in order.
const frameGets = () => voice.commands.filter((c) => c.command === 'frame.get').map((c) => c.args.at);

// The stand-up the demo calendar has every weekday at 09:30: today's while it isn't long past, else the next one. A
// meeting at that time stays within the 12 hours in which Rukoo links a meeting Voice started to its event.
function standupAt(now = new Date()) {
  const d = new Date(now);
  d.setHours(9, 30, 0, 0);
  const weekday = (x) => x.getDay() >= 1 && x.getDay() <= 5;
  if (!(weekday(d) && now.getHours() < 15)) {
    do d.setDate(d.getDate() + 1);
    while (!weekday(d));
  }
  return d.getTime();
}

const view = () => win.locator('.meeting');
const rows = () => win.locator('.meeting .mt-transcript .mt-passage');
const frame = (at) => win.locator(`.meeting .mt-frame[data-id="${frameId(at)}"]`);
const menu = () => win.locator('.menu');
const indicator = () => win.locator('.titlebar [data-meeting-indicator]');
const person = (id) => win.locator(`.meeting .mt-person[data-speaker="${id}"]`);
const pane = () => win.locator('.agentpane');
const transcript = () => win.locator('.agentpane .ap-transcript');
const input = () => win.locator('.agentpane .bui-pb__ta');
const chip = (label) => win.locator('.agentpane .bui-sugg__chip', { hasText: label });
const settled = () => pane().evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));

async function openMeetings() {
  await win.keyboard.press('Control+3');
  await expect(view()).toBeVisible();
  await expect(win.locator('[data-mode="meeting"]')).toHaveAttribute('aria-selected', 'true');
}

async function setTheme(theme) {
  await win.evaluate((t) => window.mail.call('updateSettings', { theme: t }), theme);
  await expect(win.locator('html')).toHaveClass(theme === 'light' ? /light/ : /^(?!.*light).*$/);
}

async function setLanguage(language) {
  await win.evaluate((l) => window.mail.call('updateSettings', { language: l }), language);
  await expect(win.locator('html')).toHaveAttribute('lang', language);
  await expect(win.locator('.sidebar-mode [data-mode="mail"] .seg-label')).toHaveText(language === 'nl' ? 'E-mail' : 'Mail');
}

async function shot(name) {
  fs.mkdirSync(SHOTS, { recursive: true });
  // The shimmer and the clock keep moving; a moment lets the last change paint.
  await win.waitForTimeout(400);
  await win.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

// ---------- tests ----------

test('records the Stand-up from its card: Rukoo hides first, the transcript streams in, and Stop ends it', async () => {
  // The card offers recording from 15 minutes before an event until it ends, so the window's clock is set to five
  // minutes before the Stand-up. Voice's clock follows it, so the meeting's own clock reads right.
  const standup = standupAt();
  const offset = standup - 5 * 60 * 1000 - Date.now();
  await win.clock.install({ time: new Date(standup - 5 * 60 * 1000) });
  voice.handlers['meeting.start'] = function (args) {
    const id = this.meetingId();
    this.append('meeting.started', id, { title: args.title || '', startedAt: Date.now() + offset, tracks: ['mic', 'call'], screen: 'off', startedBy: 'rukoo', context: args.context || null });
    this.append('meeting.state', id, { state: 'recording', at: 0 });
    this.append('status', null, { recording: id, dictating: false });
    return { meeting: id };
  };
  voice.handlers['meeting.stop'] = function (args) {
    if (this.status.recording !== args.meeting) return { error: { code: 'not_recording', message: 'Not recording.' } };
    this.append('meeting.state', args.meeting, { state: 'processing', at: 15000, endedAt: Date.now() + offset, reason: 'rukoo' });
    this.append('status', null, { recording: null, dictating: false });
    return {};
  };
  // Every window's protection, at the moment Rukoo sends meeting.start.
  await app.evaluate(({ BrowserWindow }) => {
    const v = global.__semVoice;
    const command = v.bridge.command.bind(v.bridge);
    global.__protectedAtStart = null;
    v.bridge.command = (name, args) => {
      if (name === 'meeting.start') global.__protectedAtStart = BrowserWindow.getAllWindows().map((w) => w.isContentProtected());
      return command(name, args);
    };
  });

  await win.keyboard.press('Control+2');
  await win.locator('[data-cal-view="day"]').click();
  await win.locator('[data-cal="today"]').click();
  await win.locator('.calendar [data-ev]', { hasText: 'Stand-up' }).first().click();
  const card = win.locator('.cal-pop');
  await expect(card.locator('h2')).toHaveText('Stand-up');
  await expect(card.locator('[data-pop="record"]')).toHaveText('Record with Rukoo Voice');
  await shot('card-record');
  await card.locator('[data-pop="record"]').click();

  // The meeting opens in its own mode, with the event linked and the guests to name the call after.
  await expect(win.locator('[data-mode="meeting"]')).toHaveAttribute('aria-selected', 'true');
  await expect(view().locator('.mt-title')).toHaveText('Stand-up');
  await expect(view().locator('.mt-state')).toHaveText('Recording');
  await expect(view().locator('.mt-event-title')).toHaveText('Stand-up');
  const start = voice.commands.find((c) => c.command === 'meeting.start');
  expect(start.args.title).toBe('Stand-up');
  expect(start.args.context.calendarEvent).toMatch(/standup/);
  if (CAN_HIDE) {
    expect(await app.evaluate(() => global.__protectedAtStart)).toEqual([true]);
    expect(await isProtected()).toEqual([true]);
    await expect(view().locator('.mt-hidden')).toBeVisible();
  }
  await expect(indicator()).toBeVisible();
  await expect(indicator().locator('.rec-time')).toHaveText(/^\d:\d\d$/);
  const id = start && voice.status.recording;

  // Passages arrive while Voice records, in time order, with the voice's name once per stretch.
  voice.append('speaker', id, { id: 'mic', track: 'mic', label: 'You' });
  voice.append('speaker', id, { id: 'call-1', track: 'call', label: 'Speaker 1' });
  say(id, 'call', 2000, 'Morning all. Quick round: what did everyone do yesterday?');
  await expect(rows()).toHaveCount(1);
  await expect(rows().first().locator('.mt-name')).toHaveText('Speaker 1');
  say(id, 'mic', 6000, 'I finished the pricing page and sent it to Joris.');
  say(id, 'call', 10000, 'Thanks. Joris, can you review it before lunch?');
  say(id, 'call', 13500, 'Sure, I will have comments by twelve.');
  await expect(rows()).toHaveCount(4);
  await expect(rows().nth(1).locator('.mt-name')).toHaveText('You');
  await expect(rows().nth(3)).toHaveClass(/cont/);
  // A later revision replaces the passage in place.
  say(id, 'call', 2000, 'Morning, all. Quick round: what did everyone do yesterday?', { revision: 2 });
  await expect(rows().first().locator('.mt-text')).toHaveText('Morning, all. Quick round: what did everyone do yesterday?');
  await expect(rows()).toHaveCount(4);
  await expect(view().locator('.mt-live')).toHaveText('Listening…');

  // The indicator shows in Mail too, and brings the meeting back.
  await win.keyboard.press('Control+1');
  await expect(view()).toBeHidden();
  await expect(indicator()).toBeVisible();
  await indicator().click();
  await expect(view().locator('.mt-title')).toHaveText('Stand-up');

  // Pause and Resume, then Stop in two steps.
  await view().locator('[data-mt="pause"]').click();
  await expect(view().locator('.mt-state')).toHaveText('Paused');
  await expect(indicator()).toHaveClass(/is-paused/);
  await view().locator('[data-mt="resume"]').click();
  await expect(view().locator('.mt-state')).toHaveText('Recording');
  await view().locator('[data-mt="stop"]').click();
  await expect(view().locator('[data-mt="stop"]')).toHaveText('Stop recording?');
  expect(voice.commands.some((c) => c.command === 'meeting.stop')).toBe(false);
  await view().locator('[data-mt="stop"]').click();
  await expect(view().locator('.mt-state')).toHaveText('Finishing the transcript');
  expect(voice.commands.find((c) => c.command === 'meeting.stop').args.meeting).toBe(id);
  await expect(indicator()).toBeHidden();
  if (CAN_HIDE) await expect.poll(isProtected).toEqual([false]);
  voice.append('meeting.state', id, { state: 'done', at: 16000, endedAt: Date.now() + offset });
  await expect(view().locator('.mt-state')).toHaveCount(0);
  await expect(view().locator('[data-mt="stop"]')).toHaveCount(0);
});

test('a meeting Rukoo Voice starts links the Stand-up, hides Rukoo, and the names picked from its guests survive a restart', async () => {
  test.setTimeout(120000);
  await openMeetings();
  await expect(view().locator('.mt-empty .t')).toHaveText('Record a meeting');
  const id = voiceStarts({ startedAt: standupAt() + 60 * 1000 });
  say(id, 'call', 1500, 'Shall we start? Joris is still on his way.');
  say(id, 'mic', 5200, 'Yes, let us go through the launch first.');

  // The view opens the new recording, and Rukoo links the one event that fits.
  await expect(view().locator('.mt-state')).toHaveText('Recording');
  await expect(view().locator('.mt-event-title')).toHaveText('Stand-up', { timeout: 10000 });
  await expect(view().locator('.mt-title')).toHaveText('Stand-up');
  if (CAN_HIDE) await expect.poll(isProtected).toEqual([true]);
  await expect(indicator()).toBeVisible();

  // Two guests can be the voice on the call, so Rukoo asks instead of guessing.
  await expect(person('call-1').locator('.mt-person-name')).toHaveText('Speaker 1');
  await expect(person('call-1').locator('.mt-person-sub')).toHaveText('Choose who this is');
  await person('call-1').click();
  const menu = win.locator('.menu');
  await expect(menu.locator('.menu-heading')).toHaveText('Guests of Stand-up');
  await expect(menu.locator('button')).toHaveText([/Sanne de Vries/, /Joris Bakker/, /Someone else/]);
  await menu.locator('button', { hasText: 'Sanne de Vries' }).click();
  await expect(person('call-1').locator('.mt-person-name')).toHaveText('Sanne de Vries');
  await expect(person('call-1').locator('.mt-person-sub')).toHaveText('sanne@example.com');
  await expect(rows().first().locator('.mt-name')).toHaveText('Sanne de Vries');
  await expect(rows().nth(1).locator('.mt-name')).toHaveText('You');

  // A correction and notes are Rukoo's own too.
  await rows().first().locator('.mt-text').dblclick();
  await view().locator('.mt-edit').fill('Shall we start? Joris is on his way.');
  await view().locator('.mt-edit').press('Enter');
  await expect(rows().first().locator('.mt-text')).toHaveText('Shall we start? Joris is on his way.');
  await expect(rows().first().locator('.mt-corrected')).toHaveText('Corrected by you');
  await view().locator('.mt-notes-input').fill('Launch first, then pricing.');
  await view().locator('.mt-notes-input').blur();
  await expect(view().locator('.mt-notes-status')).toHaveText('Saved');
  // The keyboard path: the transcript is one tab stop, arrows move, Enter corrects and Escape leaves it as it was.
  await view().locator('.mt-transcript').focus();
  await win.keyboard.press('ArrowDown');
  await expect(rows().first()).toBeFocused();
  await win.keyboard.press('ArrowDown');
  await expect(rows().nth(1)).toBeFocused();
  await win.keyboard.press('Enter');
  await expect(view().locator('.mt-edit')).toBeFocused();
  await win.keyboard.type(' Typed, then dropped.');
  await win.keyboard.press('Escape');
  await expect(rows().nth(1).locator('.mt-text')).toHaveText('Yes, let us go through the launch first.');
  await expect(rows().nth(1)).toBeFocused();

  await closeApp(app);
  await launch();
  await expect(view().locator('.mt-title')).toHaveText('Stand-up', { timeout: 20000 });
  await expect(person('call-1').locator('.mt-person-name')).toHaveText('Sanne de Vries');
  await expect(rows().first().locator('.mt-name')).toHaveText('Sanne de Vries');
  await expect(rows().first().locator('.mt-text')).toHaveText('Shall we start? Joris is on his way.');
  await expect(view().locator('.mt-notes-input')).toHaveValue('Launch first, then pricing.');
  // Voice still records: after the restart Rukoo hides again and shows the clock.
  await expect.poll(connected, { timeout: 10000 }).toBe(true);
  if (CAN_HIDE) await expect.poll(isProtected).toEqual([true]);
  await expect(indicator()).toBeVisible();
});

test('the chat follows the meeting: the fake agent reads the transcript, and its second turn gets only what is new', async () => {
  const id = voiceStarts({ title: 'Design review' });
  say(id, 'call', 1000, 'The new onboarding has three steps instead of five.');
  say(id, 'mic', 4500, 'Good. Can we keep the skip button?');
  say(id, 'call', 8000, 'Yes, it stays on every step.');
  await openMeetings();
  await expect(rows()).toHaveCount(3);
  await win.keyboard.press('Control+j');
  await expect(pane()).toBeVisible();
  await expect(win.locator('.agentpane .bui-rec__title')).toHaveText('What should Hermes do with this meeting?');
  await expect(win.locator('.agentpane .bui-entity__name')).toHaveText('Design review');
  await expect(win.locator('.agentpane .bui-sugg__chip')).toHaveText(['Catch me up', 'What did they ask me?', 'Write the notes', 'Draft the follow-up email']);
  await expect(input()).toHaveAttribute('data-placeholder', 'Ask Hermes about this meeting...');

  await chip('Catch me up').click();
  await expect(transcript().locator('.bui-ub')).toHaveText('Catch me up');
  const first = transcript().locator('[data-type="assistant"]').last();
  await expect(first).toContainText('From Design review, 3 lines', { timeout: 10000 });
  await expect(first).toContainText('The new onboarding has three steps instead of five.');
  await expect(transcript().locator('.bui-tool', { hasText: 'Read the meeting' })).toBeVisible();
  const chat = await app.evaluate(() => global.__semAgents.list()[0]);
  expect(chat.meeting).toEqual({ id, title: 'Design review' });

  say(id, 'mic', 12000, 'Then I will tell support on Monday.');
  say(id, 'call', 15500, 'Thanks, that is everything.');
  await expect(rows()).toHaveCount(5);
  await input().fill('What is new in the meeting?');
  await input().press('Enter');
  const second = transcript().locator('[data-type="assistant"]').last();
  await expect(second).toContainText('From Design review, 2 lines', { timeout: 10000 });
  await expect(second).toContainText('Then I will tell support on Monday.');
  await expect(second).not.toContainText('three steps instead of five');

  // In Mail the panel follows the email again; back in the meeting it finds this chat.
  await win.keyboard.press('Control+1');
  await expect(win.locator('.agentpane .bui-entity__name')).not.toHaveText('Design review');
  await win.keyboard.press('Control+3');
  await expect(transcript()).toContainText('From Design review, 2 lines');
});

test('a dropped connection and a Rukoo Voice on a new port replay without showing anything twice', async () => {
  const id = voiceStarts({ title: 'Sync with Joris' });
  say(id, 'call', 1000, 'Can you hear me?');
  say(id, 'mic', 3000, 'Yes, loud and clear.');
  await openMeetings();
  await expect(rows()).toHaveCount(2);

  // The connection dies halfway through a passage: it comes back and the replay brings it once.
  const cut = say(id, 'call', 6000, 'Let me share my screen.', { push: false });
  voice.drop(cut);
  await expect(rows()).toHaveCount(3, { timeout: 15000 });

  // Voice restarts on another port with the same data folder; what it said meanwhile arrives once too.
  const old = voice;
  const next = new FakeVoice({ file: old.file, instance: old.instance, token: old.token });
  Object.assign(next, { events: old.events, head: old.head, status: old.status, nextMeeting: old.nextMeeting });
  voiceHandlers(next);
  await old.close();
  voice = next;
  say(id, 'mic', 9000, 'I can see it now.');
  say(id, 'call', 12000, 'Good, the dashboard is on the left.');
  await voice.listen();
  voice.writeDiscovery();
  await expect(rows()).toHaveCount(5, { timeout: 15000 });
  const keys = await rows().evaluateAll((els) => els.map((el) => el.dataset.key));
  expect(new Set(keys).size).toBe(5);
  await expect(rows().last().locator('.mt-text')).toHaveText('Good, the dashboard is on the left.');
  // The new Voice was asked only for what came after the last event Rukoo had.
  const hello = voice.hellos[voice.hellos.length - 1];
  expect(hello.instance).toBe(old.instance);
  expect(hello.after).toBeGreaterThan(0);
});

test('a meeting Rukoo Voice deletes keeps your notes, marked as deleted; one without notes leaves the list', async () => {
  const ended = (id, title, ago) => {
    voice.append('meeting.started', id, { title, startedAt: Date.now() - ago, tracks: ['mic', 'call'], screen: 'off', startedBy: 'voice', context: null });
    voice.append('meeting.state', id, { state: 'done', at: 60000, endedAt: Date.now() - ago + 60000 });
    say(id, 'call', 1000, `A line from ${title}.`);
  };
  const kept = voice.meetingId();
  const gone = voice.meetingId();
  ended(kept, 'Kept for its notes', 3 * 60 * 60 * 1000);
  ended(gone, 'Gone entirely', 2 * 60 * 60 * 1000);
  await openMeetings();
  const item = (title) => win.locator('.sidebar [data-mt-open]', { hasText: title });
  await expect(win.locator('.sidebar [data-mt-open]')).toHaveCount(2);
  await item('Kept for its notes').click();
  await expect(item('Kept for its notes')).toHaveClass(/active/);
  await expect(view().locator('.mt-title')).toHaveText('Kept for its notes');
  await expect(rows()).toHaveCount(1);
  await view().locator('.mt-notes-input').fill('Follow up with the supplier.');
  await view().locator('.mt-notes-input').blur();
  await expect(view().locator('.mt-notes-status')).toHaveText('Saved');

  voice.append('meeting.removed', kept, {});
  await expect(view().locator('.mt-state')).toHaveText('Deleted in Rukoo Voice');
  await expect(view().locator('.mt-notice')).toHaveText('Rukoo Voice deleted this meeting and its transcript. Your notes stay here.');
  await expect(rows()).toHaveCount(0);
  await expect(view().locator('.mt-notes-input')).toHaveValue('Follow up with the supplier.');
  voice.append('meeting.removed', gone, {});
  await expect(item('Gone entirely')).toHaveCount(0);
  await expect(item('Kept for its notes')).toHaveCount(1);
});

test('notes typed while a save is still on its way are kept when another meeting opens', async () => {
  const ended = (id, title, ago) => {
    voice.append('meeting.started', id, { title, startedAt: Date.now() - ago, tracks: ['mic', 'call'], screen: 'off', startedBy: 'voice', context: null });
    voice.append('meeting.state', id, { state: 'done', at: 60000, endedAt: Date.now() - ago + 60000 });
    say(id, 'call', 1000, `A line from ${title}.`);
  };
  const first = voice.meetingId();
  const second = voice.meetingId();
  ended(first, 'First meeting', 3 * 60 * 60 * 1000);
  ended(second, 'Second meeting', 2 * 60 * 60 * 1000);
  await openMeetings();
  const item = (title) => win.locator('.sidebar [data-mt-open]', { hasText: title });
  await item('First meeting').click();
  await expect(view().locator('.mt-title')).toHaveText('First meeting');
  // Every save takes a while in main, so a second one has to wait for the first.
  await app.evaluate(() => {
    const v = global.__semVoice;
    const save = v.saveNotes.bind(v);
    v.saveNotes = (...args) => new Promise((resolve) => setTimeout(() => resolve(save(...args)), 800));
  });
  const input = view().locator('.mt-notes-input');
  await input.fill('First line.');
  await input.blur();
  await input.fill('First line. Second line.');
  await item('Second meeting').click();
  await expect(view().locator('.mt-title')).toHaveText('Second meeting');
  await expect.poll(() => app.evaluate((_e, id) => global.__semVoice.get(id).notes.text, first), { timeout: 10000 }).toBe('First line. Second line.');
  await item('First meeting').click();
  await expect(view().locator('.mt-notes-input')).toHaveValue('First line. Second line.');
});

test('without Rukoo Voice the view says to start it, and Settings > Meetings has both switches', async () => {
  await voice.close();
  voice.removeDiscovery();
  await expect.poll(connected).toBe(false);
  await openMeetings();
  await expect(view().locator('.mt-empty .t')).toHaveText('Start Rukoo Voice to record meetings');
  await expect(win.locator('.sidebar .sync-status .t')).toHaveText('Voice not running');
  await win.locator('.sidebar [data-mt-side="record"]').click();
  await expect(win.locator('#toast')).toHaveText('Start Rukoo Voice to record meetings.');
  await shot('voice-absent');

  // The sidebar's status line leads to Settings > Meetings.
  await win.locator('.sidebar .sync-status').click();
  const page = win.locator('.page.settings');
  await expect(page.locator('h1')).toHaveText('Meetings');
  await expect(page.locator('.mtset-pill')).toHaveText('Not running');
  const hide = page.locator('[data-a="toggle:meetingHideWindow"]');
  const agents = page.locator('[data-a="toggle:meetingAgentsCanRead"]');
  if (CAN_HIDE) {
    await expect(hide.locator('.switch')).toHaveClass(/on/);
    await hide.click();
    await expect(page.locator('[data-a="toggle:meetingHideWindow"] .switch')).not.toHaveClass(/on/);
    expect(await win.evaluate(() => window.mail.call('state').then((s) => s.settings.meetingHideWindow))).toBe(false);
  } else {
    await expect(hide).toHaveCount(0);
  }
  await expect(agents.locator('.switch')).toHaveClass(/on/);
  await agents.click();
  await expect(page.locator('[data-a="toggle:meetingAgentsCanRead"] .switch')).not.toHaveClass(/on/);
  expect(await win.evaluate(() => window.mail.call('state').then((s) => s.settings.meetingAgentsCanRead))).toBe(false);
  await shot('settings-meetings-off');
});

// ---------- the screen (RUK-108) ----------

test('records with a screen choice from the Stand-up card, and the header says what Voice records of the screen', async () => {
  const standup = standupAt();
  await win.clock.install({ time: new Date(standup - 5 * 60 * 1000) });
  // Every window's protection, at the moment Rukoo sends meeting.start.
  await app.evaluate(({ BrowserWindow }) => {
    const v = global.__semVoice;
    const command = v.bridge.command.bind(v.bridge);
    global.__protectedAtStart = null;
    v.bridge.command = (name, args, opts) => {
      if (name === 'meeting.start') global.__protectedAtStart = BrowserWindow.getAllWindows().map((w) => w.isContentProtected());
      return command(name, args, opts);
    };
  });
  await win.keyboard.press('Control+2');
  await win.locator('[data-cal-view="day"]').click();
  await win.locator('[data-cal="today"]').click();
  await win.locator('.calendar [data-ev]', { hasText: 'Stand-up' }).first().click();
  const card = win.locator('.cal-pop');
  await expect(card.locator('[data-pop="record"]')).toHaveText('Record with Rukoo Voice');
  await card.locator('[data-pop="record-menu"]').click();
  // Voice didn't say what its own setting is, so the first choice names no mode.
  await expect(menu().locator('.menu-heading')).toHaveText('Choose what to record');
  await expect(menu().locator('button')).toHaveText(["Voice's default", 'Audio only', 'Audio and screen frames', 'Audio and screen video']);
  await expect(card).toBeVisible();
  await shot('card-record-menu');
  await menu().locator('button', { hasText: 'Audio and screen frames' }).click();
  await expect(card).toBeHidden();

  await expect(win.locator('[data-mode="meeting"]')).toHaveAttribute('aria-selected', 'true');
  await expect(view().locator('.mt-title')).toHaveText('Stand-up');
  const start = voice.commands.find((c) => c.command === 'meeting.start');
  expect(start.args.screen).toBe('frames');
  expect(start.args.context.calendarEvent).toMatch(/standup/);
  if (CAN_HIDE) expect(await app.evaluate(() => global.__protectedAtStart)).toEqual([true]);
  await expect(view().locator('.mt-screen')).toHaveText('Screen: frames');
  await expect(view().locator('[data-mt="screen"]')).toBeVisible();
  // Hidden from capture, Rukoo can't show in the frames.
  await expect(view().locator('.mt-visible')).toHaveCount(0);
});

test("Voice's default shows in the record menu, and Record itself leaves the choice to Voice", async () => {
  voice.handlers['meeting.start'] = function (args) {
    const id = this.meetingId();
    this.append('meeting.started', id, { title: args.title || '', startedAt: Date.now(), tracks: ['mic', 'call'], screen: args.screen || this.status.screenDefault || 'off', startedBy: 'rukoo', context: args.context || null });
    this.append('meeting.state', id, { state: 'recording', at: 0 });
    this.append('status', null, { recording: id, dictating: false, screenDefault: this.status.screenDefault });
    return { meeting: id };
  };
  voice.append('status', null, { recording: null, dictating: false, screenDefault: 'video' });
  await openMeetings();
  await expect(view().locator('.mt-empty .t')).toHaveText('Record a meeting');
  await view().locator('[data-mt="record-menu"]').click();
  await expect(menu().locator('button').first()).toHaveText("Voice's default (video)");
  await expect(menu().locator('button').first()).toHaveAttribute('aria-checked', 'true');
  await shot('empty-record-menu');
  await win.keyboard.press('Escape');
  await expect(menu()).toHaveCount(0);
  await expect(view().locator('[data-mt="record-menu"]')).toBeFocused();

  // The sidebar's arrow opens the same choice, under the whole button.
  await win.locator('.sidebar [data-mt-side="record-menu"]').click();
  await expect(menu().locator('button').first()).toHaveText("Voice's default (video)");
  const [split, box] = await Promise.all([win.locator('.sidebar .mt-record-split').boundingBox(), menu().boundingBox()]);
  expect(Math.abs(box.x - split.x)).toBeLessThan(2);
  await shot('sidebar-record-menu');
  await win.keyboard.press('Escape');

  await win.locator('.sidebar [data-mt-side="record"]').click();
  await expect.poll(() => voice.commands.filter((c) => c.command === 'meeting.start').length).toBe(1);
  expect(voice.commands.find((c) => c.command === 'meeting.start').args).not.toHaveProperty('screen');
  await expect(view().locator('.mt-screen')).toHaveText('Screen: video');
});

test('frames sit between the lines at their moments, load as they come into view, open to their text, and say why when Voice is gone', async () => {
  test.setTimeout(90000);
  voice.handlers['frame.get'] = ((own) =>
    function (args) {
      // Voice removed this frame's image with the meeting's audio.
      if (args.at === 9000) return { error: { code: 'not_available', message: "The meeting's screen media was removed." } };
      return own.call(this, args);
    })(voice.handlers['frame.get']);
  const id = voiceStarts({ title: 'Roadmap review', screen: 'frames' });
  for (let i = 0; i < 60; i++) say(id, i % 3 ? 'call' : 'mic', 2000 + i * 5000, `Line ${i + 1} of the roadmap review, about the launch and the pricing page.`);
  frameAt(id, 4000, 'Q3 roadmap\nLaunch in September\nPricing page first');
  frameAt(id, 9000, 'Agenda');
  frameAt(id, 152500, 'Support plan\nTell support on Monday');
  frameAt(id, 297500, 'Slide 4\nNext steps\nWrite the follow-up');
  await openMeetings();
  await expect(rows()).toHaveCount(60);

  // Each frame sits after what was said before it, and before the next line.
  const keys = await win.locator('.meeting .mt-transcript > li').evaluateAll((els) => els.map((el) => el.dataset.key));
  expect(keys.slice(0, 4)).toEqual([`p:${pid('mic', 2000)}`, `f:${frameId(4000)}`, `p:${pid('call', 7000)}`, `f:${frameId(9000)}`]);
  expect(keys.indexOf(`f:${frameId(297500)}`)).toBe(keys.indexOf(`p:${pid('call', 297000)}`) + 1);

  // The view opens at the end: only the frame there asks Voice for its image.
  await expect(frame(297500)).toHaveClass(/has-image/);
  await expect(frame(297500).locator('.mt-shot img')).toHaveAttribute('src', /^data:image\/png;base64,/);
  await expect(frame(297500).locator('.mt-shot img')).toHaveAttribute('alt', 'The screen at 4:57');
  expect(frameGets()).toEqual([297500]);

  // The first line shows; the rest opens with the toggle, and Enter on the row closes it again.
  await expect(frame(297500).locator('.mt-frame-line')).toHaveText('Slide 4');
  await expect(frame(297500).locator('.mt-frame-full')).toBeHidden();
  await frame(297500).locator('.mt-frame-toggle').click();
  await expect(frame(297500)).toHaveClass(/is-open/);
  await expect(frame(297500).locator('.mt-frame-full')).toBeVisible();
  await expect(frame(297500).locator('.mt-frame-full')).toHaveText('Next steps\nWrite the follow-up');
  const wide = await frame(297500).locator('.mt-shot').boundingBox();
  expect(wide.width).toBeGreaterThan(300);
  await shot('frame-open');
  await frame(297500).focus();
  await win.keyboard.press('Enter');
  await expect(frame(297500)).not.toHaveClass(/is-open/);
  await expect(frame(297500).locator('.mt-frame-full')).toBeHidden();

  // A frame that arrives while the meeting records takes its place at once; without text it says so.
  frameAt(id, 299000, '');
  await expect(frame(299000)).toHaveCount(1);
  await expect(frame(299000).locator('.mt-frame-line')).toHaveText('No text read from the screen');
  await expect(frame(299000)).toHaveClass(/has-image/);

  // At the top: the first frame's image arrives, and the one Voice removed says so.
  await view().locator('.mt-scroll').evaluate((el) => (el.scrollTop = 0));
  await expect(frame(4000)).toHaveClass(/has-image/);
  await expect(frame(9000).locator('.mt-frame-note')).toHaveText('Rukoo Voice no longer has this image.');
  await expect(frame(9000).locator('.mt-frame-line')).toHaveText('Agenda');
  expect(frameGets()).not.toContain(152500);

  // Without Voice, images Rukoo has stay, the others say why they're missing, and the text is still there.
  await voice.close();
  voice.removeDiscovery();
  await expect.poll(connected).toBe(false);
  await frame(152500).scrollIntoViewIfNeeded();
  await expect(frame(152500).locator('.mt-frame-note')).toHaveText('The image shows while Rukoo Voice runs.');
  await expect(frame(152500).locator('.mt-frame-line')).toHaveText('Support plan');
  await expect(frame(152500)).not.toHaveClass(/has-image/);
  await expect(frame(4000)).toHaveClass(/has-image/);
});

test('marks about the screen say what happened to it, apart from the audio', async () => {
  const id = voiceStarts({ title: 'Screen marks', screen: 'video' });
  say(id, 'call', 500, 'Let me share my screen.');
  const mark = (data) => voice.append('mark', id, { until: null, track: 'screen', label: null, ...data });
  mark({ id: 'dropped-video-a', kind: 'video_dropped', at: 900, detail: 'encoder' });
  mark({ id: 'dropped-video-b', kind: 'video_dropped', at: 60000, detail: 'disk' });
  mark({ id: 'gap-screen-000070000', kind: 'screen_gap', at: 70000, until: 130000, detail: 'locked' });
  mark({ id: 'monitor-000140000', kind: 'monitor', at: 140000, detail: 'user', label: 'DELL S3220DGF' });
  mark({ id: 'gap-screen-000180000', kind: 'screen_gap', at: 180000, until: 183000, detail: 'crash' });
  mark({ id: 'gap-screen-000200000', kind: 'screen_gap', at: 200000, until: 204000, detail: 'device' });
  mark({ id: 'monitor-000210000', kind: 'monitor', at: 210000, detail: 'lost', label: 'PHL 275V8' });
  mark({ id: 'dropped-frames-a', kind: 'dropped', at: 240000, detail: 'disk' });
  mark({ id: 'dropped-frames-b', kind: 'dropped', at: 250000, detail: 'device' });
  await openMeetings();
  await expect(view().locator('.mt-mark .mt-line')).toHaveText([
    'Video stopped: no video encoder on this computer worked. Frames go on.',
    'Video stopped to keep recording audio: the disk is almost full. Frames go on.',
    /^Screen: not recorded for 1 min\w* while the computer was locked$/,
    'Screen recording moved to DELL S3220DGF',
    /^Screen: not recorded for 3 sec\w* while the screen recorder restarted$/,
    /^Screen: not recorded for 4 sec\w* while the graphics card restarted$/,
    'The recorded monitor went away; screen recording moved to PHL 275V8',
    'Screen recording stopped to keep recording audio: the disk is full',
    "Screen recording stopped to keep recording audio: the graphics card couldn't start again"
  ]);
  await expect(view().locator('.mt-mark.is-monitor svg')).toHaveCount(2);
  await expect(view().locator('.mt-mark.is-screen_gap')).toHaveCount(3);
  await expect(view().locator('.mt-mark.is-video_dropped')).toHaveCount(2);
});

test('a meeting Rukoo Voice starts gets Rukoo hidden before Voice captures the screen; a replayed start asks nothing', async () => {
  const acks = [];
  voice.handlers['meeting.protected'] = function (args) {
    acks.push({ at: Date.now(), meeting: args.meeting });
    return {};
  };
  // When main first hides a window.
  await app.evaluate(({ BrowserWindow }) => {
    global.__protectedAt = null;
    for (const w of BrowserWindow.getAllWindows()) {
      const set = w.setContentProtection.bind(w);
      w.setContentProtection = (on) => {
        if (on && !global.__protectedAt) global.__protectedAt = Date.now();
        return set(on);
      };
    }
  });
  // Voice records the audio already and asks before its first frame. Its status hasn't said it records yet.
  const id = voice.meetingId();
  voice.append('meeting.started', id, { title: 'From the pill', startedAt: Date.now(), tracks: ['mic', 'call'], screen: 'frames', startedBy: 'voice', context: null });
  voice.append('meeting.state', id, { state: 'recording', at: 0 });
  voice.append('meeting.starting', id, { screen: 'frames' });
  await expect.poll(() => acks.length).toBe(1);
  expect(acks[0].meeting).toBe(id);
  if (CAN_HIDE) {
    expect(await isProtected()).toEqual([true]);
    const at = await app.evaluate(() => global.__protectedAt);
    expect(acks[0].at - at).toBeGreaterThanOrEqual(90);
  }

  // A start Rukoo missed comes back in the replay after a reconnect: that is history, so no second answer.
  const other = voice.meetingId();
  const missed = voice.append('meeting.starting', other, { screen: 'frames' }, { push: false });
  voice.drop(missed);
  await expect.poll(connected, { timeout: 15000 }).toBe(false);
  await expect.poll(connected, { timeout: 15000 }).toBe(true);
  await win.waitForTimeout(1500);
  expect(acks.length).toBe(1);
  expect(voice.commands.filter((c) => c.command === 'meeting.protected').length).toBe(1);
});

test('the Screen button moves the recording to another monitor; a Voice that can\'t do that loses the button', async () => {
  const DISPLAY1 = '\\\\.\\DISPLAY1';
  const DISPLAY2 = '\\\\.\\DISPLAY2';
  const monitors = [
    { id: DISPLAY1, name: 'DELL S3220DGF', width: 2560, height: 1440, primary: true },
    { id: DISPLAY2, name: 'PHL 275V8', width: 1440, height: 2560, primary: false }
  ];
  let screen = { screen: 'frames', state: 'recording', video: false, frames: true, monitor: DISPLAY1, monitors };
  voice.handlers['screen.get'] = () => screen;
  voice.handlers['screen.select'] = (args) => ({ monitor: args.monitor });
  const id = voiceStarts({ title: 'Demo for the board', screen: 'frames' });
  say(id, 'call', 1000, 'Can you show the second screen?');
  await openMeetings();
  await view().locator('[data-mt="screen"]').click();
  await expect(menu().locator('.menu-heading')).toHaveText('Record this monitor');
  await expect(menu().locator('button')).toHaveText([/DELL S3220DGF\s*2560 × 1440\s*Main display/, /PHL 275V8\s*1440 × 2560/]);
  await expect(menu().locator('button').first()).toHaveAttribute('aria-checked', 'true');
  await expect(menu().locator('button').nth(1)).toHaveAttribute('aria-checked', 'false');
  await shot('screen-menu');
  await menu().locator('button', { hasText: 'PHL 275V8' }).click();
  await expect.poll(() => voice.commands.filter((c) => c.command === 'screen.select').map((c) => c.args)).toEqual([{ meeting: id, monitor: DISPLAY2 }]);
  voice.append('mark', id, { id: 'monitor-000015000', kind: 'monitor', at: 15000, until: null, track: 'screen', detail: 'user', label: 'PHL 275V8' });
  await expect(view().locator('.mt-mark .mt-line')).toHaveText(['Screen recording moved to PHL 275V8']);

  // Voice stopped recording the screen: the menu says so and offers nothing.
  screen = { ...screen, state: 'stopped', frames: false, monitor: null };
  await view().locator('[data-mt="screen"]').click();
  await expect(menu().locator('button', { hasText: 'Screen recording stopped' })).toBeDisabled();
  await expect(menu().locator('button', { hasText: 'PHL 275V8' })).toBeDisabled();
  await win.keyboard.press('Escape');

  // A Voice from before screen recording doesn't know screen.get: the button goes for that Voice.
  voice.handlers['screen.get'] = () => ({ error: { code: 'unknown_command', message: "Voice doesn't know the command `screen.get`." } });
  await view().locator('[data-mt="screen"]').click();
  await expect(win.locator('#toast')).toHaveText("This Rukoo Voice can't do that yet. Update Rukoo Voice.");
  await expect(view().locator('[data-mt="screen"]')).toHaveCount(0);
  await expect(view().locator('[data-mt="mark"]')).toBeVisible();
});

test('mail notifications wait while a meeting records the screen; the badge still counts', async () => {
  // Nothing reaches the desktop in a test, whatever happens.
  await app.evaluate(({ Notification }) => {
    global.__semShown = [];
    Notification.prototype.show = function () {
      global.__semShown.push(this.title);
    };
  });
  voiceStarts({ title: 'Screen share', screen: 'frames' });
  await expect.poll(() => app.evaluate(() => global.__semVoice.screenRecording())).toBe(true);
  const before = await app.evaluate(() => global.__semHeldNotices || 0);
  await app.evaluate(() => global.__semEngine.emit('new-mail', [{ id: 'demo:held-1', subject: 'Invoice for October', from: { name: 'Demo', address: 'demo@example.com' } }]));
  await expect.poll(() => app.evaluate(() => global.__semHeldNotices || 0)).toBe(before + 1);
  expect(await app.evaluate(() => global.__semShown)).toEqual([]);
});

test('screenshots: screen frames, the record and screen menus and the chips, in both themes and languages, wide and narrow', async () => {
  test.setTimeout(180000);
  voice.handlers['screen.get'] = () => ({
    screen: 'video',
    state: 'recording',
    video: true,
    frames: true,
    monitor: '\\\\.\\DISPLAY1',
    monitors: [
      { id: '\\\\.\\DISPLAY1', name: 'DELL S3220DGF', width: 2560, height: 1440, primary: true },
      { id: '\\\\.\\DISPLAY2', name: 'PHL 275V8', width: 1440, height: 2560, primary: false }
    ]
  });
  const id = voiceStarts({ title: 'Roadmap review', startedAt: Date.now() - 6 * 60 * 1000, screen: 'video' });
  say(id, 'call', 2100, 'Let me share the roadmap. Can everyone see it?');
  say(id, 'mic', 6400, 'Yes, the Q3 slide is up.');
  frameAt(id, 8000, 'Q3 roadmap\nLaunch in September\nPricing page first\nSupport plan in October');
  say(id, 'call', 12500, 'September is the launch. The pricing page goes first.');
  say(id, 'mic', 19000, 'Can we move support to October?');
  voice.append('mark', id, { id: 'monitor-000024000', kind: 'monitor', at: 24000, until: null, track: 'screen', detail: 'user', label: 'PHL 275V8' });
  frameAt(id, 25500, 'Support plan\nTell support on Monday\nTraining in week 41', { width: 1440, height: 2560 });
  say(id, 'call', 28000, 'Yes. I will tell support on Monday.');
  voice.append('mark', id, { id: 'dropped-video', kind: 'video_dropped', at: 33000, until: null, track: 'screen', detail: 'disk', label: null });
  frameAt(id, 36000, 'Next steps\nWrite the follow-up');
  say(id, 'mic', 38000, 'Agreed. I will write the follow-up.');
  await openMeetings();
  await expect(rows()).toHaveCount(6);
  for (const at of [8000, 25500, 36000]) await expect(frame(at)).toHaveClass(/has-image/);
  await frame(8000).locator('.mt-frame-toggle').click();

  for (const language of ['en', 'nl']) {
    await setLanguage(language);
    await frame(8000).locator('.mt-frame-toggle').waitFor();
    if (!(await frame(8000).getAttribute('class')).includes('is-open')) await frame(8000).locator('.mt-frame-toggle').click();
    for (const theme of ['dark', 'light']) {
      await setTheme(theme);
      await shot(`frames-wide-${theme}-${language}`);
      await view().locator('[data-mt="screen"]').click();
      await expect(menu().locator('button')).toHaveCount(2);
      await shot(`screen-menu-${theme}-${language}`);
      await win.keyboard.press('Escape');
    }
  }
  await expect(view().locator('.mt-screen')).toHaveText('Scherm: video');

  // Narrow, with Rukoo visible in screen recordings: the chip warns.
  await win.evaluate(() => window.mail.call('updateSettings', { meetingHideWindow: false }));
  if (CAN_HIDE) await expect(view().locator('.mt-visible')).toHaveText('Zichtbaar in schermopnames');
  await setSize(700, 900);
  for (const language of ['nl', 'en']) {
    await setLanguage(language);
    for (const theme of ['dark', 'light']) {
      await setTheme(theme);
      await shot(`frames-narrow-${theme}-${language}`);
    }
  }
  if (CAN_HIDE) await expect(view().locator('.mt-visible')).toHaveText('Visible in screen recordings');

  // The record menus, with nothing recording.
  voice.append('meeting.state', id, { state: 'done', at: 40000, endedAt: Date.now() });
  voice.append('status', null, { recording: null, dictating: false, screenDefault: 'frames' });
  await setSize(1500, 950);
  for (const [theme, language] of [
    ['dark', 'en'],
    ['light', 'nl']
  ]) {
    await setLanguage(language);
    await setTheme(theme);
    await win.locator('.sidebar [data-mt-side="record-menu"]').click();
    await expect(menu().locator('button')).toHaveCount(4);
    await shot(`record-menu-${theme}-${language}`);
    await win.keyboard.press('Escape');
  }
});

test('screenshots: a recording meeting in dark and light, English and Dutch, wide and narrow', async () => {
  test.setTimeout(150000);
  const id = voiceStarts({ title: 'Weekly planning', startedAt: Date.now() - 4 * 60 * 1000 });
  const lines = [
    ['call', 2100, 'Morning. Shall we start with the launch date?'],
    ['mic', 6200, 'Yes. I think Thursday still works if the copy is done by Tuesday.'],
    ['call', 11800, "The copy is close. I'll send the last screens tonight."],
    ['call', 15400, 'Can you check the pricing page before then?'],
    ['mic', 21000, 'I will. Let me note that.'],
    ['mic', 26000, 'Send Joris the pricing numbers', { dictation: true }],
    ['call', 41000, 'Then we move the launch to Thursday and tell support on Monday.'],
    ['mic', 47000, 'Agreed. I will write the follow-up.']
  ];
  for (const [track, start, text, more] of lines) say(id, track, start, text, more || {});
  voice.append('mark', id, { id: 'dict-26000', kind: 'dictation', at: 26000, until: 29500, track: 'mic', detail: null, label: null });
  voice.append('mark', id, { id: 'gap-mic-33000', kind: 'gap', at: 33000, until: 39000, track: 'mic', detail: 'device', label: null });
  voice.append('mark', id, { id: 'dev-mic-39000', kind: 'device', at: 39000, until: null, track: 'mic', detail: 'reconnected', label: 'Jabra Evolve2 65' });
  voice.append('mark', id, { id: 'k-1', kind: 'user', at: 44000, until: null, track: null, detail: null, label: null });
  await openMeetings();
  await expect(rows()).toHaveCount(8);
  // The dictation stretch shows as its tagged line; the gap and the device change as marks.
  await expect(rows().nth(5)).toHaveClass(/is-dict/);
  await expect(rows().nth(5).locator('.mt-tag')).toHaveText('Dictation');
  await expect(view().locator('.mt-mark')).toHaveText([/Microphone: no audio for .+, the device was gone/, /Microphone: Jabra Evolve2 65 is back/, /Marked/]);
  await view().locator('.mt-notes-input').fill('Launch moves to Thursday. Support hears on Monday.');
  await view().locator('.mt-notes-input').blur();
  await expect(view().locator('.mt-notes-status')).toHaveText('Saved');
  await win.keyboard.press('Control+j');
  await expect(pane()).toBeVisible();
  await settled();

  for (const language of ['en', 'nl']) {
    await setLanguage(language);
    for (const theme of ['dark', 'light']) {
      await setTheme(theme);
      await shot(`wide-${theme}-${language}`);
    }
  }
  await expect(view().locator('[data-mt="mark"]')).toHaveText('Markeren');

  // Narrow: the chat closed, the parts as tabs; then the chat over the meeting.
  await win.locator('.agentpane [data-ap="close"]').click();
  await expect(pane()).toBeHidden();
  await setSize(760, 900);
  await expect(view().locator('.mt-tabs')).toBeVisible();
  for (const theme of ['dark', 'light']) {
    await setTheme(theme);
    await view().locator('[data-mt-tab="transcript"]').click();
    await shot(`narrow-${theme}-nl-transcript`);
    await view().locator('[data-mt-tab="notes"]').click();
    await expect(view().locator('.mt-notes-input')).toBeVisible();
    await expect(view().locator('.mt-transcript-pane')).toBeHidden();
    await shot(`narrow-${theme}-nl-notes`);
    await view().locator('[data-mt-tab="people"]').click();
    await expect(person('call-1')).toBeVisible();
    await shot(`narrow-${theme}-nl-details`);
  }
  await setLanguage('en');
  await view().locator('[data-mt-tab="transcript"]').click();
  await shot('narrow-light-en-transcript');
  await win.keyboard.press('Control+j');
  await expect(pane()).toBeVisible();
  await settled();
  await shot('narrow-light-en-chat');
});
