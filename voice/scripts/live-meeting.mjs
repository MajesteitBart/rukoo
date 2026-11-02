// The live paired run of Rukoo Voice and Rukoo, their acceptance test: a development Voice on the real engine
// records SAPI speech through its recorder's file sources, transcribes it with Orukeet, and streams the meeting to a
// development Rukoo over the bridge.
//
//   node voice/scripts/live-meeting.mjs [--skip-build] [--release] [--speakers[=cpu|runtime|model]] [--measure=speakers [--minutes=<n>]]
//
// Windows only. Everything it starts lives under tmp\live\<time>\ in this checkout: Voice's data folder
// (RUKOO_VOICE_DATA_DIR), Rukoo's profile (SEM_DATA_DIR), the discovery file both get as RUKOO_VOICE_BRIDGE, and the
// speech. Captures of the apps' own windows go to tmp\live-shots\. Orukeet is read from Ownkey's model folder, read
// only. Nothing touches the installed apps, the clipboard or the keyboard, nothing plays out loud, and every process
// it started is stopped by its process id. The programs come from CARGO_TARGET_DIR when it is set, debug builds
// unless --release is given.
//
// The checks: passages with the expected words reach Rukoo on both tracks before the stop; the pill shows the
// recording; Rukoo's windows are protected from capture; Voice restarted mid-meeting reattaches to the recorder and
// sends no passage twice; a killed recorder comes back through the watchdog with a gap mark; the stop goes to
// processing, then done; Rukoo's meeting.get has every passage Voice has; and a meeting started from Voice shows up
// in Rukoo. The report is tmp\live\<time>\report.json.
//
// --speakers plays the AMI meeting excerpt (fetched by scripts\speaker-assets.ps1 into tmp\speaker-assets, never
// committed) as the call, looped; the microphone keeps its SAPI speech. On top of the checks above: at least three
// call speakers reach Rukoo before the stop, and the three main AMI speakers get ids of their own; the id of MEE071
// gets a name; the speaker worker is killed and its voice keeps that id afterwards, and again after the Voice
// restart; after done at least 90% of the call's passage time went to the right speaker
// (scripts\lib\speaker-score.mjs) and no passage moved from one id to another between revisions.
//
// --speakers=cpu|runtime|model runs a short meeting with RUKOO_VOICE_TEST_NO_SPEAKERS set to that reason: the call
// is one speaker, call-1, Settings > Speaker labels says why, and Voice captures that page.
//
// --measure=speakers measures labels on and off (spec RUK-109 section 7): the worker's real-time factor through its
// --self-test, then two meetings started from Voice in fresh data folders, labels on and labels off, each --minutes
// long (default 5) with CPU per process read by pid at minute 1 and 5 (and at the end of a longer one), the speaker
// worker's peak working set, and the call passages' latency. With --minutes of 21 or more the labels-on meeting is
// also the compaction run: the settled position keeps moving past minute 20, the worker never restarts, and the three
// main speakers keep their ids from the first five minutes to the last five.
//
// The runtime: RUKOO_VOICE_NEMO_DIR when set; otherwise tmp\speaker-assets\nemo_speech when it holds one; otherwise
// Voice's own order (next to the exe, then Ownkey's copy, read only).

import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { accuracy, mapping } from './lib/speaker-score.mjs';

const require = createRequire(import.meta.url);
const { _electron: electron } = require('@playwright/test');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const VOICE = path.join(ROOT, 'voice');
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const RUN = path.join(ROOT, 'tmp', 'live', STAMP);
const SHOTS = path.join(ROOT, 'tmp', 'live-shots');
const TARGET = process.env.CARGO_TARGET_DIR ? path.resolve(process.env.CARGO_TARGET_DIR) : path.join(VOICE, 'target');
// --release builds and runs the release programs, as the measurements should.
const PROFILE = process.argv.includes('--release') ? 'release' : 'debug';
const EXE = path.join(TARGET, PROFILE, 'rukoo-voice.exe');
const SPEAKERS_EXE = path.join(TARGET, PROFILE, 'rukoo-voice-speakers.exe');
const SHERPA = process.env.SHERPA_ONNX_ARCHIVE_DIR || path.join(ROOT, 'tmp', 'sherpa-archive');
const ASSETS = path.join(ROOT, 'tmp', 'speaker-assets');
const AMI_WAV = path.join(ASSETS, 'ami', 'ami_en2002d_2132.wav');
const AMI_RTTM = path.join(ASSETS, 'ami', 'ami_en2002d_2132.rttm');
const NEMOTRON = path.join(ASSETS, 'nemotron', 'Nemotron-3-Diarization.q8_0.gguf');
// ModelSpec::nemotron() in voice-core: Voice's own models folder keeps it at <data>\models\<folder>\<revision>.
const NEMOTRON_DIR = path.join('models', 'nemotron-3-diarization', 'f667ed73aee57d40cc39428eb768b4fd87a0a29e');
// The three AMI speakers who talk for more than a few words; FEO072 says three.
const MAIN = ['MEE071', 'FEO070', 'MEE073'];

// Where the current Voice and Rukoo keep their files. --measure gives each of its meetings a fresh set.
let VOICE_DATA;
let RUKOO_DATA;
let BRIDGE;
let HOOKS;
function folders(dir) {
  VOICE_DATA = path.join(dir, 'voice-data');
  RUKOO_DATA = path.join(dir, 'rukoo-data');
  BRIDGE = path.join(dir, 'bridge', 'voice-bridge.json');
  HOOKS = path.join(dir, 'hooks');
  fs.mkdirSync(path.dirname(BRIDGE), { recursive: true });
}

// ---------- flags ----------

const ARGS = process.argv.slice(2);
function flag(name) {
  const arg = ARGS.find((a) => a === name || a.startsWith(`${name}=`));
  if (!arg) return null;
  return arg.includes('=') ? arg.slice(name.length + 1) : true;
}
const SPEAKERS = flag('--speakers');
const MEASURE = flag('--measure');
const MINUTES = Number(flag('--minutes')) || 5;
const REASONS = ['cpu', 'runtime', 'model'];
const MEASURES = ['speakers'];
if (MEASURE !== null && !MEASURES.includes(MEASURE)) {
  console.error(`--measure takes a value: ${MEASURES.map((m) => `--measure=${m}`).join(', ')}`);
  process.exit(2);
}
if (SPEAKERS !== null && SPEAKERS !== true && !REASONS.includes(SPEAKERS)) {
  console.error(`--speakers takes no value or one of ${REASONS.join(', ')}`);
  process.exit(2);
}
// The AMI excerpt is the call in every speaker run.
const AMI = SPEAKERS !== null || MEASURE === 'speakers';

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
  // With the AMI excerpt as the call: words its passages say.
  words: AMI ? ['speaker', 'organis', 'organiz', 'segment', 'steve', 'evaluation', 'time'] : ['invoice', 'amsterdam', 'deadline', 'warehouse', 'supplier', 'delivery', 'tuesday']
};

const report = { started: new Date().toISOString(), run: RUN, args: ARGS, checks: [], notes: [] };
const started = { voice: [], rukoo: null, dataDirs: [] };
let failed = 0;
let nemoDir = null;

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

const median = (xs) => percentile(xs, 0.5);
function percentile(xs, p) {
  if (!xs.length) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const at = (sorted.length - 1) * p;
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return Math.round(sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo));
}

// ---------- build, assets and speech ----------

function build() {
  const crates = ['voice-app', 'voice-recorder', 'voice-local', 'voice-speakers'];
  console.log(`building ${crates.join(', ')} (${PROFILE}) into ${TARGET}`);
  const out = spawnSync('cargo', ['build', ...(PROFILE === 'release' ? ['--release'] : []), ...crates.flatMap((c) => ['-p', c])], {
    cwd: VOICE,
    env: { ...process.env, SHERPA_ONNX_ARCHIVE_DIR: SHERPA },
    stdio: 'inherit',
    windowsHide: true
  });
  if (out.status !== 0) throw new Error('cargo build failed');
}

// The AMI excerpt and the model, checked against their pins; the runtime too once voice/nemo-runtime/manifest.json
// names a published archive (the script skips it before that).
function assets() {
  const out = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(VOICE, 'scripts', 'speaker-assets.ps1'), '-Out', ASSETS, '-Ami', '-Model', '-Runtime'], {
    encoding: 'utf8',
    windowsHide: true
  });
  if (out.status !== 0 || !fs.existsSync(AMI_WAV)) throw new Error(`speaker-assets.ps1 failed: ${out.stderr || out.stdout}`);
  if (process.env.RUKOO_VOICE_NEMO_DIR) nemoDir = process.env.RUKOO_VOICE_NEMO_DIR;
  else if (fs.existsSync(path.join(ASSETS, 'nemo_speech', 'runtime.json'))) nemoDir = path.join(ASSETS, 'nemo_speech');
  if (nemoDir) {
    const runtime = JSON.parse(fs.readFileSync(path.join(nemoDir, 'runtime.json'), 'utf8').replace(/^﻿/, ''));
    note(`NeMo runtime: ${nemoDir} (${runtime.name || 'unnamed'}, commit ${String(runtime.commit || '').slice(0, 7)}, MSVC ${runtime.toolset?.msvc || '?'})`);
  } else {
    note("NeMo runtime: Voice's own lookup (next to the exe, then Ownkey's copy, read only)");
  }
}

// The AMI reference: its RTTM turns in ms, and the length of one loop of the WAV.
let AMI_TURNS = [];
let AMI_MS = 0;
function loadAmi() {
  AMI_TURNS = fs
    .readFileSync(AMI_RTTM, 'utf8')
    .split('\n')
    .filter((line) => line.startsWith('SPEAKER '))
    .map((line) => {
      const f = line.trim().split(/\s+/);
      const start = Math.round(Number(f[3]) * 1000);
      return { start, end: start + Math.round(Number(f[4]) * 1000), speaker: f[7] };
    });
  AMI_MS = Math.round((fs.statSync(AMI_WAV).size - 44) / 32);
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

// A fresh data folder: the model as a hard link in Voice's own models folder, so the run doesn't depend on Ownkey
// having it (Voice still prefers Ownkey's copy when there is one), and the settings the run asks for.
function prepareVoiceData(config = null) {
  fs.mkdirSync(VOICE_DATA, { recursive: true });
  started.dataDirs.push(VOICE_DATA);
  if (AMI && fs.existsSync(NEMOTRON)) {
    const dir = path.join(VOICE_DATA, NEMOTRON_DIR);
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, path.basename(NEMOTRON));
    if (!fs.existsSync(target)) {
      try {
        fs.linkSync(NEMOTRON, target);
      } catch (_) {
        fs.copyFileSync(NEMOTRON, target);
      }
    }
  }
  if (config) fs.writeFileSync(path.join(VOICE_DATA, 'config.json'), JSON.stringify(config));
}

function startVoice(n, { noSpeakers = null } = {}) {
  const call = AMI ? `${AMI_WAV},loop` : `${path.join(RUN, 'them.wav')},loop`;
  const env = {
    ...process.env,
    RUKOO_VOICE_DATA_DIR: VOICE_DATA,
    RUKOO_VOICE_BRIDGE: BRIDGE,
    // The recorder plays the speech in real time, looping, instead of opening the microphone and the speakers.
    RUKOO_VOICE_TEST_SOURCES: `mic=file:${path.join(RUN, 'you.wav')},loop,call=file:${call}`
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.RUKOO_VOICE_LOCAL_EXE;
  delete env.RUKOO_VOICE_SPEAKERS_EXE;
  delete env.RUKOO_VOICE_TEST_NO_SPEAKERS;
  delete env.RUKOO_VOICE_NEMO_DIR;
  if (nemoDir) env.RUKOO_VOICE_NEMO_DIR = nemoDir;
  if (noSpeakers) env.RUKOO_VOICE_TEST_NO_SPEAKERS = noSpeakers;
  const log = fs.openSync(path.join(path.dirname(VOICE_DATA), `voice-${n}.log`), 'a');
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

// The meeting's time now, in ms, from its newest heartbeat.
function meetingNow(id) {
  const beats = timeline(id).filter((l) => l.kind === 'heartbeat');
  const last = beats.at(-1);
  return last ? last.t + (Date.now() - last.wall) : 0;
}

// A file of Voice's data folder through SQLite, read only.
async function readDb(file, query, ...params) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare(query).all(...params);
  } finally {
    db.close();
  }
}

// What Voice's event log holds, read only: the states a meeting went through, or how many status events it keeps.
const voiceLog = (query, ...params) => readDb(path.join(VOICE_DATA, 'bridge.db'), query, ...params);
const transcriptDb = (id, query, ...params) => readDb(path.join(VOICE_DATA, 'meetings', id, 'transcript.db'), query, ...params);

const voiceStates = async (id) =>
  (await voiceLog("SELECT data FROM events WHERE event = 'meeting.state' AND meeting = ? ORDER BY seq", id)).map((row) => JSON.parse(row.data).state);
const statusRows = async () => (await voiceLog("SELECT COUNT(*) AS n FROM events WHERE event = 'status'"))[0].n;
// Every passage event of a meeting, in order, with the time the log took it.
const passageEvents = async (id) =>
  (await voiceLog("SELECT created_at, data FROM events WHERE event = 'passage' AND meeting = ? ORDER BY seq", id)).map((row) => ({ createdAt: row.created_at, ...JSON.parse(row.data) }));

// processing comes before done, which comes last.
function stoppedThenDone(states) {
  const processing = states.indexOf('processing');
  return processing >= 0 && processing < states.lastIndexOf('done') && states.at(-1) === 'done';
}

// The meeting's entry in Settings > Speaker labels.
async function labelsOf(id) {
  const s = await hook('status');
  return (s.settings.speakers?.live || []).find((l) => l.meeting === id) || null;
}

// ---------- the speaker reference ----------

// The AMI turns on the meeting clock: the file source starts the WAV at the first call segment of every recorder
// session and loops it without a gap, until the next session.
function reference(id) {
  const lines = timeline(id);
  const starts = [];
  let open = false;
  for (const l of lines) {
    if (l.kind === 'session') open = true;
    else if (open && l.kind === 'segment' && l.track === 'call') {
      starts.push(l.t);
      open = false;
    }
  }
  const last = Math.max(0, ...lines.map((l) => (Number.isFinite(l.t) ? l.t : 0)));
  const turns = [];
  starts.forEach((start, i) => {
    const end = i + 1 < starts.length ? starts[i + 1] : last + AMI_MS;
    for (let loop = start; loop < end; loop += AMI_MS) {
      for (const r of AMI_TURNS) {
        const s = loop + r.start;
        const e = Math.min(loop + r.end, end);
        if (s < e) turns.push({ start: s, end: e, speaker: r.speaker });
      }
    }
  });
  return turns;
}

const callPassages = (passages) => passages.filter((p) => p.track === 'call').map((p) => ({ id: p.id, start: p.start, end: p.end, speaker: p.speaker ?? null }));

// The reference speaker who talks most inside a passage, as the scorer picks it.
function referenceOf(passage, turns) {
  const overlap = new Map();
  for (const r of turns) {
    const shared = Math.min(passage.end, r.end) - Math.max(passage.start, r.start);
    if (shared > 0) overlap.set(r.speaker, (overlap.get(r.speaker) || 0) + shared);
  }
  let best = null;
  for (const [name, time] of [...overlap].sort((a, b) => (a[0] < b[0] ? -1 : 1))) if (best === null || time > overlap.get(best)) best = name;
  return best;
}

// The id each main AMI speaker maps to, by the scorer's one-to-one rule.
function mainIds(passages, turns) {
  const map = mapping(passages, turns);
  return Object.fromEntries(MAIN.map((name) => [name, Object.keys(map).find((id) => map[id] === name) || null]));
}

// Passages whose speaker changed from one id to another between revisions; null to an id is allowed.
function movedPassages(events) {
  const seen = new Map();
  const moved = [];
  for (const e of events.filter((p) => p.track === 'call')) {
    if (e.speaker == null) continue;
    const before = seen.get(e.id);
    if (before && before !== e.speaker) moved.push({ id: e.id, from: before, to: e.speaker, revision: e.revision });
    seen.set(e.id, e.speaker);
  }
  return moved;
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
  name: (id, speaker, name) => win.evaluate(([m, s, n]) => window.mail.call('meetingSetSpeaker', m, s, { name: n, address: '' }), [id, speaker, name]),
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

// ---------- the paired run ----------

async function pairedRun() {
  folders(RUN);
  prepareVoiceData();
  const youBytes = speech(path.join(RUN, 'you.wav'), YOU);
  if (AMI) note(`speech: you.wav ${(youBytes / 32000).toFixed(1)} s; the call is the AMI excerpt, ${(AMI_MS / 1000).toFixed(1)} s, looped`);
  else {
    const themBytes = speech(path.join(RUN, 'them.wav'), THEM);
    note(`speech: you.wav ${(youBytes / 32000).toFixed(1)} s, them.wav ${(themBytes / 32000).toFixed(1)} s`);
  }
  const labels = SPEAKERS === true;

  // 1. Voice, then Rukoo, paired through RUKOO_VOICE_BRIDGE.
  let voice = startVoice(1);
  await until('the discovery file', () => fs.existsSync(BRIDGE), 60000);
  const first = await hook('status');
  check('Voice runs the real engine in a development copy', first.settings.devMode === true && first.pid === voice.pid, { pid: first.pid });
  if (labels) {
    const sp = first.settings.speakers;
    check('Settings > Speaker labels is ready with Nemotron', sp.ready === true && sp.engine === 'nemotron', { reason: sp.reason, detail: sp.detail, runtime: sp.runtime });
  }
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
    mic: live.passages.filter((p) => p.track === 'mic').length,
    call: live.passages.filter((p) => p.track === 'call').length
  });

  // 3a. Speaker labels: three voices on the call before the stop, one of them named, then the worker killed.
  let named = null;
  if (labels) named = await speakersBeforeStop(id);

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
  const restartAt = meetingNow(id);
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
  if (labels && named) await keepsItsId(id, named, restartAt, 'after the Voice restart');

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
  await sleep(labels ? 20000 : 6000);
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
  if (labels) await speakersAfterDone(id, mine, named);

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

// Before the stop: three call speakers in Rukoo with the main AMI speakers apart; MEE071's id gets a name; the
// worker is killed, comes back through the reel, and MEE071 keeps the id. Returns { speaker, name }.
async function speakersBeforeStop(id) {
  const t = Date.now();
  const found = await until('three call speakers in Rukoo with the main AMI speakers apart', async () => {
    const m = await rukoo.get(id);
    const calls = m.speakers.filter((s) => s.track === 'call');
    const ids = mainIds(callPassages(m.passages), reference(id));
    return calls.length >= 3 && MAIN.every((n) => ids[n]) && { calls: calls.map((s) => s.id), ids };
  }, 300000, 1000);
  check('three call speakers reached Rukoo before the stop, the main AMI speakers on ids of their own', true, { after: `${Math.round((Date.now() - t) / 1000)} s`, ...found });
  report.speakers = { beforeStop: found };

  const speaker = found.ids.MEE071;
  const name = 'Person A';
  const after = await rukoo.name(id, speaker, name);
  check(`the id of MEE071 (${speaker}) got a name in Rukoo`, after.find((s) => s.id === speaker)?.name === name);

  const labels = await until('the speaker worker', async () => {
    const l = await labelsOf(id);
    return l?.workerPid && l.state === 'listening' && l;
  }, 60000, 500);
  const pid = labels.workerPid;
  const killAt = meetingNow(id);
  const killed = Date.now();
  check('Settings names the running speaker worker by its process id', alive(pid), { pid, state: labels.state });
  killPid(pid);
  await until('the killed worker to exit', () => !alive(pid), 15000);
  const states = new Set();
  const back = await until('the follower to listen again with a new worker', async () => {
    const l = await labelsOf(id);
    if (l) states.add(l.state);
    return l?.state === 'listening' && l.workerPid && l.workerPid !== pid && l;
  }, 120000, 250);
  const refeed = Date.now() - killed;
  report.speakers.refeedMs = refeed;
  check('the follower started a new worker and matched the reel', alive(back.workerPid), { pid: back.workerPid, refeedMs: refeed, states: [...states] });
  check('recording went on through the worker crash', (await rukoo.state()).recording === id && alive(recorderOf(id)?.pid));
  await keepsItsId(id, { speaker, name }, killAt, 'after the worker kill');
  return { speaker, name };
}

// MEE071's passages after `from` (meeting ms) carry the named id, and Rukoo shows the name on it.
async function keepsItsId(id, { speaker, name }, from, when) {
  const later = await until(`MEE071's passages ${when}`, async () => {
    const m = await rukoo.get(id);
    const turns = reference(id);
    const own = m.passages.filter((p) => p.track === 'call' && p.start > from && referenceOf(p, turns) === 'MEE071');
    const labelled = own.filter((p) => p.speaker != null);
    return labelled.length >= 2 && { m, own, labelled };
  }, 240000, 1000);
  const wrong = later.labelled.filter((p) => p.speaker !== speaker);
  check(`MEE071 keeps ${speaker} ${when}`, wrong.length === 0, { passages: later.labelled.length, wrong: wrong.map((p) => `${p.id}:${p.speaker}`), unlabelled: later.own.length - later.labelled.length });
  check(`the name stays on ${speaker} ${when}`, later.m.speakers.find((s) => s.id === speaker)?.name === name);
}

// After done: the score over the whole meeting, and no passage moved from one id to another.
async function speakersAfterDone(id, meeting, named) {
  const passages = callPassages(meeting.passages);
  const turns = reference(id);
  const score = accuracy(passages, turns);
  const nulls = passages.filter((p) => p.speaker == null);
  const total = passages.reduce((sum, p) => sum + (p.end - p.start), 0);
  const nullTime = nulls.reduce((sum, p) => sum + (p.end - p.start), 0);
  report.speakers.accuracy = score;
  report.speakers.mapping = mapping(passages, turns);
  report.speakers.callSpeakers = meeting.speakers.filter((s) => s.track === 'call').map((s) => s.id);
  report.speakers.nullShare = total ? nullTime / total : 0;
  check('at least 90% of the call passage time went to the right speaker', score >= 0.9, {
    accuracy: Number(score.toFixed(4)),
    passages: passages.length,
    withoutSpeaker: `${nulls.length} (${((100 * nullTime) / (total || 1)).toFixed(1)}% of the time)`,
    mapping: report.speakers.mapping
  });
  const moved = movedPassages(await passageEvents(id));
  check('no passage moved from one id to another between revisions', moved.length === 0, moved.slice(0, 10));
  if (named) check(`MEE071 maps to ${named.speaker} over the whole meeting`, report.speakers.mapping[named.speaker] === 'MEE071', report.speakers.mapping);
}

// ---------- --speakers=<reason> ----------

async function withoutLabels(reason) {
  folders(RUN);
  prepareVoiceData();
  speech(path.join(RUN, 'you.wav'), YOU);
  startVoice(1, { noSpeakers: reason });
  await until('the discovery file', () => fs.existsSync(BRIDGE), 60000);
  const status = await hook('status');
  const sp = status.settings.speakers;
  check(`Settings > Speaker labels says why: ${reason}`, sp.ready === false && sp.reason === reason, { reason: sp.reason, missing: sp.missing, detail: sp.detail });
  await startRukoo();
  await until('Rukoo to connect to Voice', rukoo.connected, 30000);

  const { meetingId: id } = await rukoo.start({ title: `Live run: no speaker labels (${reason})` });
  check('Rukoo started a meeting through Voice', Boolean(id), id);
  report.meeting = id;
  const live = await until('passages with the expected words on both tracks', async () => {
    const m = await rukoo.get(id);
    return m && trackHas(m, 'mic', YOU.words) && trackHas(m, 'call', THEM.words) && m;
  }, 240000, 500);
  check('the meeting records and transcribes both tracks without labels', (await rukoo.state()).recording === id, { call: live.passages.filter((p) => p.track === 'call').length });
  const entry = await labelsOf(id);
  check(`the meeting's labels are off with reason ${reason}`, entry?.mode === 'off' && entry?.reason === reason, entry);
  const dir = path.join(SHOTS, `speakers-${reason}`);
  const shots = await hook('capture', { dir, page: 'speakers' }, 90000);
  check('Voice captured Settings > Speaker labels', !shots.settings.error, shots.settings);

  // Every AMI voice has spoken once a whole loop has gone by.
  await until('a whole loop of the AMI excerpt', () => meetingNow(id) > AMI_MS + 15000, 180000, 1000);
  await rukoo.stop(id);
  await until('done', async () => (await rukoo.get(id)).meeting.state === 'done', 240000, 200);
  const m = await rukoo.get(id);
  const calls = m.speakers.filter((s) => s.track === 'call').map((s) => s.id);
  const others = m.passages.filter((p) => p.track === 'call' && p.speaker !== 'call-1');
  check('the whole call is one speaker, call-1, as in Voice 0.1', calls.length === 1 && calls[0] === 'call-1' && others.length === 0, { calls, otherPassages: others.length });
  check('the stop went to processing, then done', stoppedThenDone(await voiceStates(id)));
}

// ---------- --measure=speakers ----------

// CPU time, working set and peak working set of each process id, through Get-Process.
function processTimes(pids) {
  const ids = pids.filter(Boolean);
  if (!ids.length) return {};
  const at = Date.now();
  const out = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-Command', `Get-Process -Id ${ids.join(',')} -ErrorAction SilentlyContinue | ForEach-Object { '{0} {1} {2} {3}' -f $_.Id, [long]$_.TotalProcessorTime.TotalMilliseconds, $_.WorkingSet64, $_.PeakWorkingSet64 }`],
    { encoding: 'utf8', windowsHide: true }
  );
  const wall = (at + Date.now()) / 2;
  const result = {};
  for (const line of (out.stdout || '').split(/\r?\n/).filter(Boolean)) {
    const [pid, cpu, ws, peak] = line.trim().split(/\s+/).map(Number);
    result[pid] = { cpu, ws, peak, wall };
  }
  return result;
}

// The children of a process by image name, through CIM.
function childrenOf(pid) {
  const out = spawnSync('powershell.exe', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "ParentProcessId=${pid}" | ForEach-Object { '{0} {1}' -f $_.ProcessId, $_.Name }`], { encoding: 'utf8', windowsHide: true });
  const result = {};
  for (const line of (out.stdout || '').split(/\r?\n/).filter(Boolean)) {
    const [child, name] = line.trim().split(/\s+/);
    result[name.replace(/\.exe$/i, '')] = Number(child);
  }
  return result;
}

async function measuredPids(id, voicePid) {
  const children = childrenOf(voicePid);
  const l = await labelsOf(id);
  return {
    'rukoo-voice': voicePid,
    'rukoo-voice-local': children['rukoo-voice-local'] || null,
    'rukoo-voice-speakers': l?.workerPid || children['rukoo-voice-speakers'] || null,
    'rukoo-voice-recorder': recorderOf(id)?.pid || null
  };
}

// The wall time of a meeting time, from the newest heartbeat at or before it.
function wallAt(beats, t) {
  let best = beats[0];
  for (const b of beats) if (b.t <= t) best = b;
  return best ? best.wall + (t - best.t) : null;
}

async function measuredMeeting(label, liveSpeakers, minutes) {
  folders(path.join(RUN, label));
  prepareVoiceData(liveSpeakers ? null : { meetings_live_speakers: false });
  const voice = startVoice(label);
  await until('the discovery file', () => fs.existsSync(BRIDGE), 60000);
  const sp = (await hook('status')).settings.speakers;
  check(`${label}: Settings > Speaker labels is ${liveSpeakers ? 'ready' : 'off'}`, liveSpeakers ? sp.ready === true : sp.reason === 'off', { reason: sp.reason, runtime: sp.runtime });

  const { meeting: id } = await hook('start_meeting');
  const result = { label, meeting: id, minutes, cpu: {}, samples: [], settled: [] };
  await until('the recording', async () => (await hook('status')).pill.meeting?.state === 'recording', 30000);
  const marks = [...new Set([1, 5, minutes].filter((m) => m <= minutes))];
  let pids = null;
  for (const minute of marks) {
    while (meetingNow(id) < minute * 60000) {
      await sleep(5000);
      if (liveSpeakers && minutes > 5) {
        try {
          const row = (await transcriptDb(id, "SELECT value FROM meta WHERE key = 'speakers.settled.call'"))[0];
          result.settled.push([Math.round(meetingNow(id)), row ? Number(row.value) : null]);
        } catch (_) {
          // The app holds the file; the next read gets it.
        }
      }
    }
    pids = await measuredPids(id, voice.pid);
    result.samples.push({ minute, pids, times: processTimes(Object.values(pids)) });
    console.log(`     ${label}: minute ${minute}`);
  }
  const l = await labelsOf(id);
  result.labels = l && { state: l.state, mode: l.mode, speakers: l.speakers, reason: l.reason };

  // CPU per process between minute 1 and each later sample, in % of one core.
  const first = result.samples[0];
  for (const sample of result.samples.slice(1)) {
    const row = {};
    let total = 0;
    for (const [name, pid] of Object.entries(sample.pids)) {
      const a = first.times[first.pids[name]];
      const b = sample.times[pid];
      if (!a || !b || first.pids[name] !== pid) {
        row[name] = null;
        continue;
      }
      row[name] = Number(((100 * (b.cpu - a.cpu)) / (b.wall - a.wall)).toFixed(1));
      total += row[name];
    }
    row.total = Number(total.toFixed(1));
    result.cpu[`1-${sample.minute}`] = row;
  }
  const last = result.samples.at(-1);
  const worker = last.pids['rukoo-voice-speakers'];
  result.workerPeakMb = worker && last.times[worker] ? Math.round(last.times[worker].peak / 1048576) : null;
  result.peakMb = Object.fromEntries(Object.entries(last.pids).map(([name, pid]) => [name, pid && last.times[pid] ? Math.round(last.times[pid].peak / 1048576) : null]));

  const stopWall = Date.now();
  await hook('stop_meeting');
  await until('done', async () => (await voiceStates(id)).at(-1) === 'done', 300000, 500);

  // Latency of each call passage's first revision, from the wall time of its end to the log taking it. Passages the
  // log took after the stop come from the final windows and aren't live.
  const beats = timeline(id).filter((x) => x.kind === 'heartbeat');
  const firsts = new Map();
  for (const e of await passageEvents(id)) if (!firsts.has(e.id)) firsts.set(e.id, e);
  const latency = { call: [], mic: [] };
  for (const e of firsts.values()) {
    if (e.createdAt > stopWall) continue;
    const wall = wallAt(beats, e.end);
    if (wall != null) latency[e.track]?.push(e.createdAt - wall);
  }
  result.latency = Object.fromEntries(Object.entries(latency).map(([track, xs]) => [track, { passages: xs.length, medianMs: median(xs), p90Ms: percentile(xs, 0.9) }]));

  if (liveSpeakers) {
    const events = await passageEvents(id);
    const latest = new Map();
    for (const e of events) latest.set(e.id, e);
    const passages = callPassages([...latest.values()]);
    const turns = reference(id);
    result.accuracy = Number(accuracy(passages, turns).toFixed(4));
    result.moved = movedPassages(events).length;
    const epochs = await transcriptDb(id, 'SELECT epoch, reason FROM speaker_epochs ORDER BY epoch');
    result.epochs = epochs.map((e) => e.reason);
    if (minutes > 5) {
      const end = Math.max(...passages.map((p) => p.end));
      const head = mainIds(passages.filter((p) => p.end <= 5 * 60000), turns);
      const tail = mainIds(passages.filter((p) => p.start >= end - 5 * 60000), turns);
      const settledLast = result.settled.filter(([, s]) => s != null).at(-1);
      const log = fs.readFileSync(path.join(path.dirname(VOICE_DATA), `voice-${label}.log`), 'utf8');
      result.compaction = { head, tail, settledLast, behindInLog: /fell behind/.test(log) };
      check(`${label}: the settled position moved past minute 20`, settledLast && settledLast[1] > 20 * 60000, settledLast);
      check(`${label}: no worker restart and no "behind" error in ${minutes} minutes`, result.epochs.length === 1 && !result.compaction.behindInLog, { epochs: result.epochs });
      check(`${label}: the main AMI speakers keep their ids from the first five minutes to the last five`, MAIN.every((n) => head[n] && head[n] === tail[n]), { head, tail });
    }
    check(`${label}: at least 90% of the call passage time went to the right speaker`, result.accuracy >= 0.9, { accuracy: result.accuracy, moved: result.moved });
  }
  killPid(voice.pid);
  await until('Voice to exit', () => !alive(voice.pid), 15000);
  return result;
}

// The worker's own real-time factor on the AMI excerpt, through --self-test.
function selfTest() {
  if (!nemoDir) {
    note('self-test skipped: no runtime folder for --runtime (set RUKOO_VOICE_NEMO_DIR)');
    return null;
  }
  const out = path.join(RUN, 'self-test.json');
  const runs = [];
  for (let i = 0; i < 3; i++) {
    const res = spawnSync(SPEAKERS_EXE, ['--self-test', '--runtime', nemoDir, '--model', NEMOTRON, '--wav', AMI_WAV, '--report', out], { encoding: 'utf8', windowsHide: true });
    if (res.status !== 0 || !fs.existsSync(out)) {
      note(`self-test failed: ${res.stderr}`);
      return null;
    }
    runs.push(JSON.parse(fs.readFileSync(out, 'utf8')));
  }
  return { runs, medianRtf: Number(median(runs.map((r) => Math.round(r.realtimeFactor * 100))) / 100) };
}

async function measureSpeakers() {
  fs.mkdirSync(RUN, { recursive: true });
  speech(path.join(RUN, 'you.wav'), YOU);
  report.measure = { selfTest: selfTest() };
  if (report.measure.selfTest) note(`worker real-time factor on the AMI excerpt: ${report.measure.selfTest.medianRtf}x (median of 3)`);
  report.measure.on = await measuredMeeting('labels-on', true, MINUTES);
  report.measure.off = await measuredMeeting('labels-off', false, Math.min(MINUTES, 5));
  const { on, off } = report.measure;
  const row = (name, a, b) => console.log(`  ${name.padEnd(34)} ${String(a ?? '-').padStart(10)} ${String(b ?? '-').padStart(10)}`);
  console.log('\n  measure                             labels on  labels off');
  for (const p of ['rukoo-voice', 'rukoo-voice-local', 'rukoo-voice-speakers', 'rukoo-voice-recorder', 'total']) row(`CPU % of one core, min 1-5: ${p}`, on.cpu['1-5']?.[p], off.cpu['1-5']?.[p]);
  if (on.cpu[`1-${MINUTES}`] && MINUTES > 5) row(`CPU total, min 1-${MINUTES}`, on.cpu[`1-${MINUTES}`].total, null);
  row('call passage latency, median ms', on.latency.call.medianMs, off.latency.call.medianMs);
  row('call passage latency, p90 ms', on.latency.call.p90Ms, off.latency.call.p90Ms);
  row('mic passage latency, median ms', on.latency.mic.medianMs, off.latency.mic.medianMs);
  row('speaker worker peak working set MB', on.workerPeakMb, null);
  row('accuracy', on.accuracy, null);
}

// ---------- main ----------

async function main() {
  if (process.platform !== 'win32') throw new Error('The live run needs Windows: Voice records there only.');
  fs.mkdirSync(RUN, { recursive: true });
  fs.mkdirSync(SHOTS, { recursive: true });
  if (!ARGS.includes('--skip-build')) build();
  if (!fs.existsSync(EXE)) throw new Error(`${EXE} is missing; build it first`);
  if (AMI) {
    assets();
    loadAmi();
  }
  if (MEASURE === 'speakers') await measureSpeakers();
  else if (REASONS.includes(SPEAKERS)) await withoutLabels(SPEAKERS);
  else await pairedRun();
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
  for (const data of started.dataDirs) {
    const meetings = path.join(data, 'meetings');
    for (const id of fs.existsSync(meetings) ? fs.readdirSync(meetings) : []) {
      let r = null;
      try {
        r = JSON.parse(fs.readFileSync(path.join(meetings, id, 'recorder.json'), 'utf8'));
      } catch (_) {
        // No recorder file: the recorder stopped cleanly.
      }
      if (r && alive(r.pid)) {
        killPid(r.pid);
        note(`stopped a recorder that was still running: ${r.pid}`);
      }
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
  fs.mkdirSync(RUN, { recursive: true });
  fs.writeFileSync(path.join(RUN, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`\n${failed ? `${failed} check(s) failed` : 'every check passed'}; report: ${path.join(RUN, 'report.json')}`);
  if (error) console.error(error);
  process.exit(failed ? 1 : 0);
}
