// The live paired run of Rukoo Voice 0.1 and Rukoo, its acceptance test: a development Voice on the real engine
// records SAPI speech through its recorder's file sources, transcribes it with Orukeet, and streams the meeting to a
// development Rukoo over the bridge.
//
//   node voice/scripts/live-meeting.mjs [--skip-build]
//
// Windows only. Everything it starts lives under tmp\live\<time>\ in this checkout: Voice's data folder
// (RUKOO_VOICE_DATA_DIR), Rukoo's profile (SEM_DATA_DIR), the discovery file both get as RUKOO_VOICE_BRIDGE, and the
// speech. Captures of the apps' own windows go to tmp\live-shots\. Orukeet is read from Ownkey's model folder, read
// only. Nothing touches the installed apps, the clipboard or the keyboard, nothing plays out loud, and every process
// it started is stopped by its process id.
//
// The checks: passages with the expected words reach Rukoo on both tracks before the stop; the pill shows the
// recording; Rukoo's windows are protected from capture; Voice restarted mid-meeting reattaches to the recorder and
// sends no passage twice; a killed recorder comes back through the watchdog with a gap mark; the stop goes to
// processing, then done; Rukoo's meeting.get has every passage Voice has; and a meeting started from Voice shows up
// in Rukoo. The report is tmp\live\<time>\report.json.

import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { _electron: electron } = require('@playwright/test');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const VOICE = path.join(ROOT, 'voice');
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const RUN = path.join(ROOT, 'tmp', 'live', STAMP);
const SHOTS = path.join(ROOT, 'tmp', 'live-shots');
const VOICE_DATA = path.join(RUN, 'voice-data');
const RUKOO_DATA = path.join(RUN, 'rukoo-data');
const BRIDGE = path.join(RUN, 'bridge', 'voice-bridge.json');
const HOOKS = path.join(RUN, 'hooks');
const EXE = path.join(VOICE, 'target', 'debug', 'rukoo-voice.exe');
const SHERPA = process.env.SHERPA_ONNX_ARCHIVE_DIR || path.join(ROOT, 'tmp', 'sherpa-archive');

// What each track says. The words checked in Rukoo are distinct per track.
const YOU = {
  parts: [
    'Good morning everyone, thanks for joining the launch review.',
    'The budget for the Thursday launch is approved.',
    'Please send the slides to Maria before Friday.',
    "Let's move on to the marketing timeline."
  ],
  words: ['launch', 'budget', 'slides', 'marketing', 'thursday', 'friday']
};
const THEM = {
  lead: 1500,
  parts: [
    'Thanks, the invoice from Amsterdam arrived yesterday.',
    'The deadline for the warehouse contract is next Tuesday.',
    'I will call the supplier about the delivery.'
  ],
  words: ['invoice', 'amsterdam', 'deadline', 'warehouse', 'supplier', 'delivery', 'tuesday']
};

const report = { started: new Date().toISOString(), run: RUN, checks: [], notes: [] };
const started = { voice: [], rukoo: null };
let failed = 0;

function check(name, ok, detail = null) {
  report.checks.push({ name, ok: Boolean(ok), detail });
  if (!ok) failed += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
  return ok;
}

function note(text) {
  report.notes.push(text);
  console.log(`     ${text}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(what, fn, ms = 60000, every = 250) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out after ${ms / 1000} s waiting for ${what}`);
    await sleep(every);
  }
}

function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// TerminateProcess on this one process id: a hard kill, as a crash would be.
function killPid(pid) {
  try {
    process.kill(pid, 'SIGKILL');
    return true;
  } catch (_) {
    return false;
  }
}

// ---------- build and speech ----------

function build() {
  console.log('building rukoo-voice, rukoo-voice-recorder and rukoo-voice-local (debug)');
  const out = spawnSync('cargo', ['build', '-p', 'voice-app', '-p', 'voice-recorder', '-p', 'voice-local'], {
    cwd: VOICE,
    env: { ...process.env, SHERPA_ONNX_ARCHIVE_DIR: SHERPA },
    stdio: 'inherit',
    windowsHide: true
  });
  if (out.status !== 0) throw new Error('cargo build failed');
}

// SAPI speech as 16 kHz mono 16-bit WAV, with a pause after every sentence so the pipeline can cut windows there.
function speech(file, { parts, lead = 0 }) {
  const script = path.join(RUN, 'speak.ps1');
  fs.writeFileSync(
    script,
    [
      'param([string]$Out, [string]$Parts, [int]$Lead)',
      'Add-Type -AssemblyName System.Speech',
      '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
      "$v = $s.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name -like 'en-*' } | Select-Object -First 1",
      'if ($v) { $s.SelectVoice($v.VoiceInfo.Name) }',
      '$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)',
      '$s.SetOutputToWaveFile($Out, $fmt)',
      '$p = New-Object System.Speech.Synthesis.PromptBuilder',
      'if ($Lead -gt 0) { $p.AppendBreak([TimeSpan]::FromMilliseconds($Lead)) }',
      "foreach ($part in $Parts.Split('|')) { $p.AppendText($part); $p.AppendBreak([TimeSpan]::FromMilliseconds(2500)) }",
      '$s.Speak($p)',
      '$s.Dispose()'
    ].join('\r\n')
  );
  const out = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Out', file, '-Parts', parts.join('|'), '-Lead', String(lead)], { encoding: 'utf8', windowsHide: true });
  if (out.status !== 0 || !fs.existsSync(file)) throw new Error(`SAPI failed: ${out.stderr}`);
  return fs.statSync(file).size;
}

// ---------- Voice ----------

function startVoice(n) {
  const env = {
    ...process.env,
    RUKOO_VOICE_DATA_DIR: VOICE_DATA,
    RUKOO_VOICE_BRIDGE: BRIDGE,
    // The recorder plays the speech in real time, looping, instead of opening the microphone and the speakers.
    RUKOO_VOICE_TEST_SOURCES: `mic=file:${path.join(RUN, 'you.wav')},loop,call=file:${path.join(RUN, 'them.wav')},loop`
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.RUKOO_VOICE_LOCAL_EXE;
  const log = fs.openSync(path.join(RUN, `voice-${n}.log`), 'a');
  const child = spawn(EXE, ['--dev-hooks', HOOKS], { cwd: VOICE, env, stdio: ['ignore', log, log], windowsHide: true });
  started.voice.push(child.pid);
  console.log(`started Voice ${n}, pid ${child.pid}`);
  return child;
}

let hookId = 0;
async function hook(cmd, args = {}, ms = 60000) {
  const id = ++hookId;
  fs.mkdirSync(HOOKS, { recursive: true });
  const tmp = path.join(HOOKS, `request-${id}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify({ id, cmd, ...args }));
  fs.renameSync(tmp, path.join(HOOKS, 'request.json'));
  const reply = path.join(HOOKS, `reply-${id}.json`);
  await until(`Voice's answer to ${cmd}`, () => fs.existsSync(reply), ms, 100);
  const answer = JSON.parse(fs.readFileSync(reply, 'utf8'));
  if (!answer.ok) throw new Error(`${cmd}: ${answer.error}`);
  return answer.result;
}

function recorderOf(id) {
  try {
    return JSON.parse(fs.readFileSync(path.join(VOICE_DATA, 'meetings', id, 'recorder.json'), 'utf8'));
  } catch (_) {
    return null;
  }
}

function timeline(id) {
  try {
    return fs
      .readFileSync(path.join(VOICE_DATA, 'meetings', id, 'timeline.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch (_) {
          return null;
        }
      })
      .filter(Boolean);
  } catch (_) {
    return [];
  }
}

// What Voice's event log holds, read only: the states a meeting went through, or how many status events it keeps.
async function voiceLog(query, ...params) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(VOICE_DATA, 'bridge.db'), { readOnly: true });
  try {
    return db.prepare(query).all(...params);
  } finally {
    db.close();
  }
}

const voiceStates = async (id) =>
  (await voiceLog("SELECT data FROM events WHERE event = 'meeting.state' AND meeting = ? ORDER BY seq", id)).map((row) => JSON.parse(row.data).state);
const statusRows = async () => (await voiceLog("SELECT COUNT(*) AS n FROM events WHERE event = 'status'"))[0].n;

// processing comes before done, which comes last.
function stoppedThenDone(states) {
  const processing = states.indexOf('processing');
  return processing >= 0 && processing < states.lastIndexOf('done') && states.at(-1) === 'done';
}

// ---------- Rukoo ----------

let app;
let win;

async function startRukoo() {
  const env = { ...process.env, SEM_DATA_DIR: RUKOO_DATA, SEM_HIDDEN: '1', SEM_AGENT_FAKE: '1', RUKOO_VOICE_BRIDGE: BRIDGE };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.RUKOO_VOICE_DATA_DIR;
  app = await electron.launch({ args: ['.'], cwd: ROOT, env });
  started.rukoo = app.process().pid;
  console.log(`started Rukoo, pid ${started.rukoo}`);
  win = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1500, 950));
  await win.waitForSelector('.provider-grid', { timeout: 60000 });
  await win.click('[data-s="demo"]');
  await win.locator('.item').first().waitFor({ timeout: 30000 });
}

const rukoo = {
  connected: () => app.evaluate(() => global.__semVoice.connected),
  state: () => win.evaluate(() => window.mail.call('voiceState')),
  get: (id) => win.evaluate((m) => window.mail.call('meetingGet', m), id),
  start: (opts) => win.evaluate((o) => window.mail.call('meetingStart', o), opts),
  stop: (id) => win.evaluate((m) => window.mail.call('meetingStop', m), id),
  voiceGet: (id) => app.evaluate((_, m) => global.__semVoice.bridge.command('meeting.get', { meeting: m }), id),
  protectedWindows: () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.isContentProtected()))
};

async function captureRukoo(file) {
  const base64 = await app.evaluate(async ({ BrowserWindow }) => {
    const image = await BrowserWindow.getAllWindows()[0].webContents.capturePage();
    return image.isEmpty() ? null : image.toPNG().toString('base64');
  });
  if (base64) fs.writeFileSync(file, Buffer.from(base64, 'base64'));
  else await win.screenshot({ path: file });
  return file;
}

// ---------- what Rukoo has ----------

const hasWord = (text, words) => words.some((w) => text.toLowerCase().includes(w));

function trackHas(meeting, track, words) {
  return (meeting?.passages || []).some((p) => p.track === track && hasWord(p.text || '', words));
}

// Two passages of one track over the same stretch of audio would mean it was transcribed twice. Windows split at
// pauses and never overlap; a little slack covers word timings at the edges.
function overlaps(passages) {
  const found = [];
  for (const track of ['mic', 'call']) {
    const list = passages.filter((p) => p.track === track).sort((a, b) => a.start - b.start);
    for (let i = 1; i < list.length; i++) {
      if (list[i].start < list[i - 1].end - 250) found.push([list[i - 1].id, list[i].id]);
    }
  }
  return found;
}

// ---------- the run ----------

async function main() {
  if (process.platform !== 'win32') throw new Error('The live run needs Windows: Voice 0.1 records there only.');
  fs.mkdirSync(RUN, { recursive: true });
  fs.mkdirSync(SHOTS, { recursive: true });
  fs.mkdirSync(path.dirname(BRIDGE), { recursive: true });
  if (!process.argv.includes('--skip-build')) build();
  if (!fs.existsSync(EXE)) throw new Error(`${EXE} is missing; build it first`);

  const youBytes = speech(path.join(RUN, 'you.wav'), YOU);
  const themBytes = speech(path.join(RUN, 'them.wav'), THEM);
  note(`speech: you.wav ${(youBytes / 32000).toFixed(1)} s, them.wav ${(themBytes / 32000).toFixed(1)} s`);

  // 1. Voice, then Rukoo, paired through RUKOO_VOICE_BRIDGE.
  let voice = startVoice(1);
  await until('the discovery file', () => fs.existsSync(BRIDGE), 60000);
  const first = await hook('status');
  check('Voice runs the real engine in a development copy', first.settings.devMode === true && first.pid === voice.pid, { pid: first.pid });
  await startRukoo();
  await until('Rukoo to connect to Voice', rukoo.connected, 30000);
  const settled = await until('Settings > Rukoo to show the client', async () => {
    const s = await hook('status');
    return s.settings.rukoo.state === 'connected' && s.settings.rukoo;
  }, 15000);
  check('Settings > Rukoo shows the connected client from its hello', settled.clientVersion && settled.protocol === 1, settled);

  // 2. A meeting started from Rukoo.
  const t0 = Date.now();
  const { meetingId: id } = await rukoo.start({ title: 'Live run: launch review' });
  check('Rukoo started a meeting through Voice', Boolean(id), id);
  report.meeting = id;
  await until('the recording status in Rukoo', async () => (await rukoo.state()).recording === id, 15000);
  const shielded = await rukoo.protectedWindows();
  check("Rukoo's windows are protected from capture while it records", shielded.length > 0 && shielded.every(Boolean), shielded);
  const pill = (await hook('status')).pill;
  check('the pill shows the recording', pill.visible && pill.phase === 'meeting' && pill.meeting?.state === 'recording', { phase: pill.phase, meeting: pill.meeting });

  // 3. Passages on both tracks, while it records.
  const live = await until('passages with the expected words on both tracks', async () => {
    const m = await rukoo.get(id);
    return m && trackHas(m, 'mic', YOU.words) && trackHas(m, 'call', THEM.words) && m;
  }, 240000, 500);
  const stillRecording = (await rukoo.state()).recording === id;
  check('passages with the expected words reached Rukoo on both tracks before the stop', stillRecording, {
    after: `${Math.round((Date.now() - t0) / 1000)} s`,
    mic: live.passages.filter((p) => p.track === 'mic').map((p) => p.text),
    call: live.passages.filter((p) => p.track === 'call').map((p) => p.text)
  });

  // Captures while it records: Rukoo's meeting view, the pill and Settings > Rukoo.
  await win.keyboard.press('Control+3');
  await win.locator('.meeting .mt-transcript .mt-passage').first().waitFor({ timeout: 20000 });
  await sleep(1000);
  await captureRukoo(path.join(SHOTS, 'rukoo-meeting-live.png'));
  const shots = await hook('capture', { dir: SHOTS, page: 'rukoo' }, 90000);
  check('Voice captured its pill and Settings > Rukoo from WebView2', !shots.pill.error && !shots.settings.error, shots);

  // 4. Voice restarts mid-meeting; the recorder goes on and the new Voice reattaches.
  const before = await rukoo.get(id);
  const lastEnd = Math.max(...before.passages.map((p) => p.end));
  const recorder = recorderOf(id);
  killPid(voice.pid);
  await until('Voice to exit', () => !alive(voice.pid), 15000);
  await sleep(1500);
  check('the recorder outlives Voice', recorder && alive(recorder.pid), recorder && { pid: recorder.pid });
  voice = startVoice(2);
  await until('Rukoo to reconnect to the new Voice', async () => (await rukoo.connected()) && (await rukoo.state()).voiceVersion, 60000);
  const reattached = await until('the reattached meeting in the pill', async () => {
    const s = await hook('status');
    return s.pill.meeting?.state === 'recording' && s;
  }, 30000);
  check('the new Voice reattached to the running recorder', recorderOf(id)?.pid === recorder.pid && reattached.tray.meeting === 'recording', { recorder: recorder.pid });
  const resumed = await until('passages after the restart', async () => {
    const m = await rukoo.get(id);
    return m.passages.some((p) => p.start > lastEnd) && m;
  }, 120000, 500);
  check('the meeting goes on after the restart without passages twice', overlaps(resumed.passages).length === 0, { overlaps: overlaps(resumed.passages), passages: resumed.passages.length });
  check("Rukoo's windows stayed protected through the restart", (await rukoo.protectedWindows()).every(Boolean));

  // 5. The recorder dies; the watchdog starts it again with --resume and the gap is marked.
  const doomed = recorderOf(id);
  killPid(doomed.pid);
  const back = await until('a new recorder', () => {
    const r = recorderOf(id);
    return r && r.pid !== doomed.pid && alive(r.pid) && r;
  }, 30000);
  check('the watchdog resumed the killed recorder', true, { killed: doomed.pid, resumed: back.pid });
  const gap = await until('a gap mark in Rukoo', async () => {
    const m = await rukoo.get(id);
    return (m.marks || []).find((k) => k.kind === 'gap' && k.detail === 'crash');
  }, 60000, 500);
  check('Rukoo shows the gap with detail crash', Boolean(gap), gap);
  const lines = timeline(id);
  check('the timeline has a resumed session and a crash line', lines.some((l) => l.kind === 'session' && l.resumed) && lines.some((l) => l.kind === 'crash'));

  // 6. Stop from Rukoo: processing, then done.
  await sleep(6000);
  await rukoo.stop(id);
  await until('done', async () => (await rukoo.get(id)).meeting.state === 'done', 240000, 200);
  const states = await voiceStates(id);
  check('the stop went to processing, then done', stoppedThenDone(states), states);
  const ended = await until('protection to end', async () => (await rukoo.protectedWindows()).every((p) => !p), 15000);
  check("Rukoo's windows are capturable again after the meeting", ended);
  await until('the recorder to exit', () => !alive(back.pid), 20000);

  // 7. Rukoo's meeting.get against Voice's.
  const mine = await rukoo.get(id);
  const theirs = await rukoo.voiceGet(id);
  const key = (p) => `${p.id}@${p.revision}`;
  const missing = theirs.passages.filter((p) => !mine.passages.some((q) => key(q) === key(p)));
  const extra = mine.passages.filter((p) => !theirs.passages.some((q) => q.id === p.id));
  check("Rukoo's meeting.get has every passage Voice has", missing.length === 0 && extra.length === 0 && theirs.passages.length > 0, {
    voice: theirs.passages.length,
    rukoo: mine.passages.length,
    missing: missing.map(key),
    extra: extra.map(key)
  });
  check('no passage covers the same audio twice', overlaps(mine.passages).length === 0, overlaps(mine.passages));
  await captureRukoo(path.join(SHOTS, 'rukoo-meeting-done.png'));

  // 8. A meeting started from Voice's side, as from its tray.
  const fromVoice = (await hook('start_meeting')).meeting;
  const seen = await until("Rukoo to pick up Voice's meeting", async () => {
    const m = await rukoo.get(fromVoice);
    const s = await rukoo.state();
    return m && s.recording === fromVoice && m;
  }, 30000);
  check('a meeting Voice started shows in Rukoo as recording', seen.meeting.startedBy === 'voice', { id: fromVoice, eventId: seen.meeting.eventId, event: seen.event });
  check("Rukoo protects its windows for Voice's meeting too", (await rukoo.protectedWindows()).every(Boolean));
  if (!seen.meeting.eventId) note('no calendar event in the demo account fits this time of day, so Rukoo linked none (it links one only when exactly one fits)');
  await sleep(4000);
  await hook('stop_meeting');
  await until("Voice's meeting to be done", async () => (await rukoo.get(fromVoice)).meeting.state === 'done', 120000, 500);
  const fromVoiceStates = await voiceStates(fromVoice);
  check('the meeting Voice started went to processing, then done', stoppedThenDone(fromVoiceStates), fromVoiceStates);
  const rows = await statusRows();
  check("Voice's event log keeps only the newest status event", rows === 1, { statusRows: rows });

  const final = await hook('status');
  report.settingsRukoo = final.settings.rukoo;
  check('Settings > Rukoo reports the client and how far behind it is', final.settings.rukoo.state === 'connected' && final.settings.rukoo.behind === 0, final.settings.rukoo);
}

async function cleanup() {
  // Rukoo first: its quit path, then its process id if it hangs.
  if (app) {
    try {
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.destroy()));
      await Promise.race([app.close(), sleep(45000)]);
    } catch (_) {
      // Gone already.
    }
    if (alive(started.rukoo)) {
      spawnSync('taskkill', ['/PID', String(started.rukoo), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    }
  }
  for (const pid of started.voice) if (alive(pid)) killPid(pid);
  // A recorder still recording after a failure: by the id in its recorder.json.
  const meetings = path.join(VOICE_DATA, 'meetings');
  for (const id of fs.existsSync(meetings) ? fs.readdirSync(meetings) : []) {
    const r = recorderOf(id);
    if (r && alive(r.pid)) {
      killPid(r.pid);
      note(`stopped a recorder that was still running: ${r.pid}`);
    }
  }
  report.leftRunning = [...started.voice, started.rukoo].filter((pid) => pid && alive(pid));
}

let error = null;
try {
  await main();
} catch (err) {
  error = err;
  check('the run finished', false, err.message);
} finally {
  await cleanup();
  report.finished = new Date().toISOString();
  report.failed = failed;
  fs.writeFileSync(path.join(RUN, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`\n${failed ? `${failed} check(s) failed` : 'every check passed'}; report: ${path.join(RUN, 'report.json')}`);
  if (error) console.error(error);
  process.exit(failed ? 1 : 0);
}
