// The live paired run of Rukoo Voice and Rukoo, their acceptance test: a development Voice on the real engine records
// SAPI speech through its recorder's file sources, transcribes it with Orukeet, records the screen, and streams the
// meeting to a development Rukoo over the bridge.
//
//   node voice/scripts/live-meeting.mjs [--skip-build] [--release] [--screen off|frames|video] [--real-screen]
//                                       [--choose-monitor=<\\.\DISPLAYn>] [--visible-rukoo] [--speakers[=cpu|runtime|model]]
//                                       [--measure=screen [--seconds=<n>] | --measure=speakers [--minutes=<n>]]
//
// Windows only. Everything it starts lives under tmp\live\<time>\ in this checkout: Voice's data folder
// (RUKOO_VOICE_DATA_DIR), Rukoo's profile (SEM_DATA_DIR), the discovery file both get as RUKOO_VOICE_BRIDGE, and the
// speech. Captures of the apps' own windows go to tmp\live-shots\. Orukeet is read from Ownkey's model folder, read
// only. Nothing touches the installed apps, the clipboard or the keyboard, nothing plays out loud, and every process
// it started is stopped by its process id. Cargo builds into CARGO_TARGET_DIR when it is set, else voice\target, and
// the programs run from there: debug builds unless --release is given, release builds for --measure=screen.
//
// The checks: passages with the expected words reach Rukoo on both tracks before the stop; the pill shows the
// recording; Rukoo's windows are protected from capture; frames with their text reach Rukoo while it records and
// Rukoo gets their images; a killed screen process comes back with a screen gap and no gap in the audio; Voice
// restarted mid-meeting reattaches to the recorder and the screen process and sends no passage twice; a killed
// recorder comes back through the watchdog with a gap mark; the video files hold 1 to 2 s fragments; the stop goes to
// processing, then done, after the screen journal's stop; Rukoo's meeting.get has every passage Voice has; and a
// meeting started from Voice shows up in Rukoo with Voice's default screen mode. The report is
// tmp\live\<time>\report.json: counts, timings and which demo strings matched, never the text read from a frame.
//
// The screen. --screen sets Voice's default (meetings_screen in the dev config.json, default frames); the meeting
// started from Rukoo uses it, and one more short meeting from Rukoo asks for video explicitly. By default the screen
// process draws numbered slides ("Slide 1", "Slide 2" ...) itself (RUKOO_VOICE_TEST_SCREEN) and captures nothing of
// the desktop. --real-screen captures the real displays: a second Electron app puts a demo slide window on one display
// and an always-on-top demo cover on every other, RUKOO_VOICE_TEST_MONITOR pins the slide display, and a run whose
// first monitor isn't that display stops, deletes the meeting's screen folder and fails. Toasts and other apps' pop-ups
// can still draw above the demo windows, so a real-screen run keeps its captures in tmp\, takes no captures of the
// meeting view and deletes Voice's data folder and Rukoo's profile when it ends. Run it only when nobody uses the
// desktop.
//
//   --choose-monitor=<id>  (needs --real-screen) the slide window on <id> is a normal window that gets the focus, no
//                          monitor is pinned, and the run checks that Voice chose <id>, then switches from the pill and
//                          from Rukoo's header.
//   --visible-rukoo        (needs --real-screen) Rukoo's window sits over half the slide; two meetings from Voice,
//                          with Rukoo's hide-from-capture switch off (its demo strings must show in the first frame)
//                          and on (they must not, and the frame must show the slide where Rukoo's window is).
//   --measure=screen       CPU and GPU of Voice's processes in four 10-minute meetings with live transcription, sampled
//                          by measure.ps1; release build. --seconds=<n> shortens each meeting for a trial. On the
//                          synthetic screen by default, at the sizes of this computer's displays as Windows reports
//                          them (off, frames and video at the main display's size, then video at the other display's
//                          size), with a new slide every 10 s; nothing shows on the desktop. With --real-screen, on the
//                          demo slide display instead: slides every 10 s, then a scrolling page, then still. Live
//                          speaker labels are off, so the screen's cost stands alone; with --speakers they are on, the
//                          call is the AMI excerpt and the speaker worker is measured too, for the combined load.
//
// --speakers plays the AMI meeting excerpt (fetched by scripts\speaker-assets.ps1 into tmp\speaker-assets, never
// committed) as the call, looped; the microphone keeps its SAPI speech. On top of the checks above: at least three
// call speakers reach Rukoo before the stop, and the three main AMI speakers get ids of their own; the id of MEE071
// gets a name; the speaker worker is killed and its voice keeps that id afterwards, and again after the Voice
// restart; after done at least 90% of the call's passage time went to the right speaker
// (scripts\lib\speaker-score.mjs) and no passage moved from one id to another between revisions. It doesn't combine
// with --real-screen, whose slides follow the SAPI call.
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
const MEASURES = ['screen', 'speakers'];
const REASONS = ['cpu', 'runtime', 'model'];
const SCREENS = ['off', 'frames', 'video'];

function parseArgs(argv) {
  const out = { skipBuild: false, release: false, screen: 'frames', realScreen: false, chooseMonitor: null, visibleRukoo: false, speakers: null, measure: null, seconds: 600, minutes: 5 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf('=');
    const key = eq > 0 ? arg.slice(0, eq) : arg;
    const value = eq > 0 ? arg.slice(eq + 1) : null;
    const next = () => value ?? argv[++i];
    switch (key) {
      case '--skip-build':
        out.skipBuild = true;
        break;
      case '--release':
        out.release = true;
        break;
      case '--speakers':
        if (value !== null && !REASONS.includes(value)) throw new Error(`--speakers takes no value or one of ${REASONS.join(', ')}`);
        out.speakers = value ?? true;
        break;
      case '--minutes':
        out.minutes = Number(next());
        if (!Number.isInteger(out.minutes) || out.minutes < 1) throw new Error('--minutes takes a whole number of minutes, at least 1');
        break;
      case '--screen':
        out.screen = next();
        if (!SCREENS.includes(out.screen)) throw new Error(`--screen takes ${SCREENS.join(', ')}`);
        break;
      case '--real-screen':
        out.realScreen = true;
        break;
      case '--choose-monitor': {
        // \\.\DISPLAY2, or DISPLAY2: Git Bash turns the leading \\ into \ on its way to node.
        const n = /^(?:\\{1,2}\.\\)?DISPLAY(\d+)$/i.exec(next() || '');
        if (!n) throw new Error('--choose-monitor takes a display id such as \\\\.\\DISPLAY2 or DISPLAY2');
        out.chooseMonitor = `\\\\.\\DISPLAY${n[1]}`;
        break;
      }
      case '--visible-rukoo':
        out.visibleRukoo = true;
        break;
      case '--measure':
        if (!MEASURES.includes(value)) throw new Error(`--measure takes a value: ${MEASURES.map((m) => `--measure=${m}`).join(', ')}`);
        out.measure = value;
        break;
      case '--seconds':
        out.seconds = Number(next());
        if (!Number.isInteger(out.seconds) || out.seconds < 30) throw new Error('--seconds takes a whole number of seconds, at least 30');
        break;
      default:
        throw new Error(`unknown option ${arg}`);
    }
  }
  if ((out.chooseMonitor || out.visibleRukoo) && !out.realScreen) throw new Error('--choose-monitor and --visible-rukoo need --real-screen');
  if ([out.chooseMonitor, out.visibleRukoo, out.measure].filter(Boolean).length > 1) throw new Error('--choose-monitor, --visible-rukoo and --measure are separate runs');
  if (out.speakers !== null && out.realScreen) throw new Error('--speakers and --real-screen are separate runs: the slides follow the SAPI call');
  if (REASONS.includes(out.speakers) && out.measure) throw new Error('--speakers=<reason> and --measure are separate runs');
  if (out.measure === 'speakers' && out.speakers !== null) throw new Error('--measure=speakers plays the AMI excerpt by itself; leave out --speakers');
  return out;
}

const ARGS = parseArgs(process.argv.slice(2));
// --release builds and runs the release programs, as the measurements should; --measure=screen always does.
const RELEASE = ARGS.release || ARGS.measure === 'screen';
const PROFILE = RELEASE ? 'release' : 'debug';
const SPEAKERS = ARGS.speakers;
const MEASURE = ARGS.measure;
const MINUTES = ARGS.minutes;
// The AMI excerpt is the call in every speaker run.
const AMI = SPEAKERS !== null || MEASURE === 'speakers';
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const RUN = path.join(ROOT, 'tmp', 'live', STAMP);
const SHOTS = path.join(ROOT, 'tmp', 'live-shots');
const TARGET = process.env.CARGO_TARGET_DIR ? path.resolve(process.env.CARGO_TARGET_DIR) : path.join(VOICE, 'target');
const BIN = path.join(TARGET, PROFILE);
const EXE = path.join(BIN, 'rukoo-voice.exe');
const SPEAKERS_EXE = path.join(BIN, 'rukoo-voice-speakers.exe');
const SCREEN_EXE = path.join(BIN, 'rukoo-voice-screen.exe');
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

// The synthetic screen of every run without --real-screen (contract 1.13). --measure=screen sets its size to a display's.
const synthetic = (size) => `synthetic:${size},change-every=10000,text=Slide`;
let syntheticSize = '1920x1080';

// What each track says. The words checked in Rukoo are distinct per track. The call's parts start the demo slides
// of a real-screen run: slide k shows from the moment part k starts in the call's WAV.
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
    "Let's look at slide two, the warehouse contract.",
    'The deadline for the warehouse contract is next Tuesday.',
    'I will call the supplier about the delivery.'
  ],
  // With the AMI excerpt as the call: words its passages say.
  words: AMI ? ['speaker', 'organis', 'organiz', 'segment', 'steve', 'evaluation', 'time'] : ['invoice', 'amsterdam', 'deadline', 'warehouse', 'supplier', 'delivery', 'tuesday']
};

const report = { started: new Date().toISOString(), run: RUN, options: ARGS, checks: [], notes: [], screen: {} };
const started = { voice: [], rukoo: null, screens: null, measure: [], dataDirs: [] };
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

function powershell(script, args = []) {
  const out = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script, ...args], { encoding: 'utf8', windowsHide: true });
  if (out.status !== 0) throw new Error(`PowerShell failed: ${out.stderr}`);
  return out.stdout;
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
  const crates = ['voice-app', 'voice-recorder', 'voice-local', 'voice-speakers', 'voice-screen'];
  console.log(`building ${crates.join(', ')} (${PROFILE}) into ${TARGET}`);
  const out = spawnSync('cargo', ['build', ...(RELEASE ? ['--release'] : []), ...crates.flatMap((c) => ['-p', c])], {
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

const wavMs = (bytes) => Math.round(((bytes - 44) / 32000) * 1000);

// Where each part of the call starts in its WAV: SAPI is deterministic, so the length of the WAV of the parts before
// it is that offset.
function partOffsets(track) {
  const offsets = [track.lead || 0];
  for (let k = 1; k < track.parts.length; k++) {
    const file = path.join(RUN, `prefix-${k}.wav`);
    offsets.push(wavMs(speech(file, { parts: track.parts.slice(0, k), lead: track.lead })));
    fs.rmSync(file, { force: true });
  }
  return offsets;
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

function voiceEnv({ monitor = null, noSpeakers = null } = {}) {
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
  delete env.RUKOO_VOICE_TEST_SCREEN;
  delete env.RUKOO_VOICE_TEST_MONITOR;
  if (!ARGS.realScreen) env.RUKOO_VOICE_TEST_SCREEN = synthetic(syntheticSize);
  else if (monitor) env.RUKOO_VOICE_TEST_MONITOR = monitor;
  return env;
}

// Voice's default screen mode, and any other setting the run asks for, before Voice reads its settings. config.json
// keeps Ownkey's flat keys.
function writeConfig(extra = {}) {
  fs.mkdirSync(VOICE_DATA, { recursive: true });
  const file = path.join(VOICE_DATA, 'config.json');
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    // A fresh data folder.
  }
  cfg.meetings_screen = ARGS.screen;
  Object.assign(cfg, extra);
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
}

function startVoice(n, { monitor = null, noSpeakers = null } = {}) {
  const log = fs.openSync(path.join(path.dirname(VOICE_DATA), `voice-${n}.log`), 'a');
  const child = spawn(EXE, ['--dev-hooks', HOOKS], { cwd: VOICE, env: voiceEnv({ monitor, noSpeakers }), stdio: ['ignore', log, log], windowsHide: true });
  started.voice.push(child.pid);
  console.log(`started Voice ${n}, pid ${child.pid}${monitor ? `, screen pinned to ${monitor}` : ''}${ARGS.realScreen ? '' : `, synthetic screen ${syntheticSize}`}`);
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

const meetingDir = (id) => path.join(VOICE_DATA, 'meetings', id);

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch (_) {
    return null;
  }
}

const recorderOf = (id) => readJson(path.join(meetingDir(id), 'recorder.json'));
const screenOf = (id) => readJson(path.join(meetingDir(id), 'screen', 'screen.json'));

function lines(file) {
  try {
    return fs
      .readFileSync(file, 'utf8')
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

const timeline = (id) => lines(path.join(meetingDir(id), 'timeline.jsonl'));
const journal = (id) => lines(path.join(meetingDir(id), 'screen', 'journal.jsonl'));

// Meeting time to the wall clock, from the recorder's first session line.
function wallOf(id, t) {
  const session = timeline(id).find((l) => l.kind === 'session');
  return session ? session.wall + (t - session.t) : null;
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
  frame: (id, at) => win.evaluate(([m, a]) => window.mail.call('meetingFrame', m, a), [id, at]),
  screen: (id) => win.evaluate((m) => window.mail.call('meetingScreen', m), id),
  select: (id, monitor) => win.evaluate(([m, s]) => window.mail.call('meetingScreenSelect', m, s), [id, monitor]),
  settings: (patch) => win.evaluate((p) => window.mail.call('updateSettings', p), patch),
  voiceGet: (id) => app.evaluate((_, m) => global.__semVoice.bridge.command('meeting.get', { meeting: m }), id),
  protectedWindows: () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.isContentProtected()))
};

async function captureRukoo(file) {
  // A real-screen run's meeting view shows frames of the real displays; those stay out of tmp\live-shots.
  if (ARGS.realScreen) return null;
  const base64 = await app.evaluate(async ({ BrowserWindow }) => {
    const image = await BrowserWindow.getAllWindows()[0].webContents.capturePage();
    return image.isEmpty() ? null : image.toPNG().toString('base64');
  });
  if (base64) fs.writeFileSync(file, Buffer.from(base64, 'base64'));
  else await win.screenshot({ path: file });
  return file;
}

// ---------- the demo screens of a real-screen run ----------

let screens;
let displays = [];

const SLIDES = [
  ['Launch review', 'Agenda: budget, slides and the marketing timeline', 'Owner: the launch team'],
  ['Warehouse contract', 'The deadline for the contract is next Tuesday', 'Draft terms are with the supplier'],
  ['Supplier delivery', 'Call the supplier about the delivery dates', 'Two pallets arrive on Monday'],
  ['Marketing timeline', 'Campaign starts the week after the launch', 'Slides go to Maria before Friday']
];

// The page every demo window shows: a slide, a long page that scrolls, or a cover. Demo text only.
const DEMO_PAGE = `<!doctype html><meta charset="utf-8"><title>Rukoo live run</title>
<style>
  html, body { margin: 0; height: 100%; overflow: hidden; font-family: 'Segoe UI', sans-serif; }
  body.slide { background: #f5f1e8; color: #1d2433; }
  body.cover { background: #2b2f36; color: #c9ced6; display: grid; place-items: center; }
  .slide main { padding: 7vh 8vw; }
  .slide h1 { font-size: 9vh; margin: 0 0 5vh; letter-spacing: -0.01em; }
  .slide h2 { font-size: 5.5vh; margin: 0 0 4vh; color: #3c4a66; font-weight: 600; }
  .slide li { font-size: 3.6vh; margin: 0 0 2.2vh; }
  .cover p { font-size: 3vh; }
  .page { height: 100%; overflow: hidden; }
  .page article { padding: 4vh 8vw; font-size: 2.6vh; line-height: 1.6; }
  .page h3 { font-size: 3.4vh; }
</style>
<body><div id="root"></div>
<script>
  const SLIDES = ${JSON.stringify(SLIDES)};
  const root = document.getElementById('root');
  let timer = null;
  window.slide = (n) => {
    clearInterval(timer);
    document.body.className = 'slide';
    const [title, a, b] = SLIDES[(n - 1) % SLIDES.length];
    root.innerHTML = '<main><h1>Slide ' + n + '</h1><h2>' + title + '</h2><ul><li>' + a + '</li><li>' + b + '</li></ul></main>';
  };
  window.cover = () => {
    clearInterval(timer);
    document.body.className = 'cover';
    root.innerHTML = '<p>Demo cover for a Rukoo Voice live run</p>';
  };
  window.scrolling = (on) => {
    clearInterval(timer);
    if (!document.querySelector('.page')) {
      document.body.className = 'slide';
      let html = '';
      for (let i = 1; i <= 120; i++) {
        const [title, a, b] = SLIDES[i % SLIDES.length];
        html += '<h3>' + i + '. ' + title + '</h3><p>' + a + '. ' + b + '. The launch team reviews this item every week.</p>';
      }
      root.innerHTML = '<div class="page"><article>' + html + '</article></div>';
    }
    const page = document.querySelector('.page');
    if (on) timer = setInterval(() => { page.scrollTop += 4; }, 33);
  };
</script></body>`;

// The displays as Electron and Windows see them, matched by their physical bounds.
function windowsDisplays() {
  const script = [
    "Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public static class Dpi { [DllImport(\"user32.dll\")] public static extern bool SetProcessDPIAware(); }'",
    '[Dpi]::SetProcessDPIAware() | Out-Null',
    'Add-Type -AssemblyName System.Windows.Forms',
    '[System.Windows.Forms.Screen]::AllScreens | ForEach-Object { [pscustomobject]@{ id = $_.DeviceName; x = $_.Bounds.X; y = $_.Bounds.Y; width = $_.Bounds.Width; height = $_.Bounds.Height; primary = $_.Primary } } | ConvertTo-Json -Compress'
  ].join('; ');
  const list = JSON.parse(powershell(script));
  return Array.isArray(list) ? list : [list];
}

async function startScreens() {
  const dir = path.join(RUN, 'screens');
  fs.mkdirSync(dir, { recursive: true });
  // A bare app that only keeps running: the run makes its windows through app.evaluate.
  fs.writeFileSync(path.join(dir, 'main.cjs'), "const { app } = require('electron');\napp.on('window-all-closed', () => {});\n");
  fs.writeFileSync(path.join(dir, 'page.html'), DEMO_PAGE);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  screens = await electron.launch({ args: [path.join(dir, 'main.cjs')], cwd: ROOT, env });
  started.screens = screens.process().pid;
  console.log(`started the demo screens, pid ${started.screens}`);
  const electronSide = await screens.evaluate(({ screen }) => {
    const primary = screen.getPrimaryDisplay().id;
    return screen.getAllDisplays().map((d) => ({ electronId: d.id, bounds: d.bounds, scaleFactor: d.scaleFactor, physical: screen.dipToScreenRect(null, d.bounds), primary: d.id === primary }));
  });
  const windowsSide = windowsDisplays();
  displays = electronSide.map((d) => {
    const match = windowsSide.find((w) => w.x === d.physical.x && w.y === d.physical.y && w.width === d.physical.width && w.height === d.physical.height);
    return { ...d, id: match ? match.id : null, width: match?.width, height: match?.height };
  });
  report.screen.displays = displays.map((d) => ({ id: d.id, width: d.width, height: d.height, primary: d.primary, scaleFactor: d.scaleFactor }));
  if (displays.some((d) => !d.id)) throw new Error(`couldn't match every Electron display to a Windows display: ${JSON.stringify({ electronSide, windowsSide })}`);
  note(`displays: ${displays.map((d) => `${d.id} ${d.width}x${d.height}${d.primary ? ' (primary)' : ''}`).join(', ')}`);
}

// Makes a window Windows' foreground window, as a click would, without sending input: the helper attaches its input
// queue to the foreground window's thread for the call, which lets SetForegroundWindow through. True when it is.
function foreground(hwnd) {
  const script = [
    "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class Fg {",
    '[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
    '[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr p);',
    '[DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();',
    '[DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);',
    '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);',
    '[DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);',
    'public static bool Front(long w) { IntPtr h = new IntPtr(w); uint fg = GetWindowThreadProcessId(GetForegroundWindow(), IntPtr.Zero); uint me = GetCurrentThreadId();',
    'bool attached = fg != 0 && fg != me && AttachThreadInput(me, fg, true); BringWindowToTop(h); SetForegroundWindow(h);',
    "if (attached) AttachThreadInput(me, fg, false); return GetForegroundWindow() == h; } }'",
    `; [Fg]::Front(${BigInt(hwnd)})`
  ].join(' ');
  return powershell(script).trim() === 'True';
}

// One demo window per display: the slide on `slideId`, covers on the others. focused: the slide is a normal window
// that takes the focus (monitor choice); otherwise every demo window stays on top without taking it.
async function showDemoWindows(slideId, { focused = false } = {}) {
  const file = path.join(RUN, 'screens', 'page.html');
  await screens.evaluate(
    async ({ BrowserWindow }, { displays: list, slideId: sid, focused: f, file: page }) => {
      for (const w of BrowserWindow.getAllWindows()) w.destroy();
      global.__demo = { slide: null, covers: [] };
      for (const d of list) {
        const slide = d.id === sid;
        const w = new BrowserWindow({
          ...d.bounds,
          show: false,
          frame: false,
          resizable: false,
          movable: false,
          skipTaskbar: true,
          focusable: slide && f,
          backgroundColor: slide ? '#f5f1e8' : '#2b2f36',
          webPreferences: { backgroundThrottling: false }
        });
        await w.loadFile(page);
        await w.webContents.executeJavaScript(slide ? 'slide(1)' : 'cover()');
        w.setBounds(d.bounds);
        if (slide && f) {
          w.show();
          w.focus();
        } else {
          w.setAlwaysOnTop(true, 'screen-saver');
          w.showInactive();
        }
        if (slide) global.__demo.slide = w;
        else global.__demo.covers.push(w);
      }
    },
    { displays, slideId, focused, file }
  );
  await sleep(1500);
  const where = await screens.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => ({ bounds: w.getBounds(), visible: w.isVisible(), focused: w.isFocused() })));
  report.screen.demoWindows = where;
}

const slideCall = (code) => screens.evaluate((_, c) => global.__demo.slide.webContents.executeJavaScript(c), code);
const setSlide = (n) => slideCall(`slide(${Number(n)})`);

// The slides of a real-screen meeting: slide k from the moment part k of the call starts in its WAV, measured from the
// call's first segment; after the last part, a new slide every 10 s. Returns a stop function.
function scheduleSlides(id, offsets) {
  const timers = [];
  let stopped = false;
  (async () => {
    const segment = await until('the call track\'s first segment', () => timeline(id).find((l) => l.kind === 'segment' && l.track === 'call'), 30000, 100);
    const start = wallOf(id, segment.t);
    report.screen.slides = { firstCallSegment: segment.t, offsets };
    offsets.forEach((offset, k) => {
      if (k === 0) return;
      timers.push(setTimeout(() => !stopped && setSlide(k + 1).catch(() => {}), Math.max(0, start + offset - Date.now())));
    });
    let n = offsets.length;
    const after = start + offsets.at(-1) + 10000;
    timers.push(
      setTimeout(() => {
        const every = setInterval(() => !stopped && setSlide(++n).catch(() => {}), 10000);
        timers.push({ every });
        if (!stopped) setSlide(++n).catch(() => {});
      }, Math.max(0, after - Date.now()))
    );
  })().catch((err) => note(`slides: ${err.message}`));
  return () => {
    stopped = true;
    for (const t of timers) {
      if (t && t.every) clearInterval(t.every);
      else clearTimeout(t);
    }
  };
}

// Mean absolute difference, 0 to 255, between a frame and the slide window in a rectangle given as fractions of the
// display, over a 48 x 48 grid of points. The frame comes as a data URL; both images are decoded by Electron.
async function frameAgainstSlide(dataUrl, rect) {
  return screens.evaluate(
    async ({ nativeImage }, { url, r }) => {
      const frame = nativeImage.createFromDataURL(url);
      const slide = await global.__demo.slide.webContents.capturePage();
      const fs = frame.getSize();
      const ss = slide.getSize();
      const fb = frame.toBitmap();
      const sb = slide.toBitmap();
      let sum = 0;
      let n = 0;
      for (let i = 0; i < 48; i++) {
        for (let j = 0; j < 48; j++) {
          const u = r.x + ((i + 0.5) / 48) * r.width;
          const v = r.y + ((j + 0.5) / 48) * r.height;
          const fi = (Math.floor(v * fs.height) * fs.width + Math.floor(u * fs.width)) * 4;
          const si = (Math.floor(v * ss.height) * ss.width + Math.floor(u * ss.width)) * 4;
          for (let c = 0; c < 3; c++) sum += Math.abs(fb[fi + c] - sb[si + c]);
          n += 3;
        }
      }
      return { diff: Math.round((sum / n) * 10) / 10, frame: fs, slide: ss };
    },
    { url: dataUrl, r: rect }
  );
}

// Deletes what a real-screen run captured: the screen folders, Voice's event log with the frames' text, and Rukoo's
// profile with its copy. The report keeps counts only.
function deleteRealCaptures() {
  for (const dir of [VOICE_DATA, RUKOO_DATA]) fs.rmSync(dir, { recursive: true, force: true });
  note('deleted the real-screen captures: Voice\'s data folder and Rukoo\'s profile of this run');
}

// A real-screen meeting must record the display that shows demo data. Otherwise: stop, delete its screen folder, fail.
async function guardMonitor(id, expected) {
  const first = await until('the screen journal\'s first monitor line', () => journal(id).find((l) => l.kind === 'monitor'), 30000, 100);
  if (first.id === expected) return first;
  try {
    await rukoo.stop(id);
  } catch (_) {
    await hook('stop_meeting').catch(() => {});
  }
  await until('the screen process to stop', () => !alive(screenOf(id)?.pid), 20000).catch(() => {});
  fs.rmSync(path.join(meetingDir(id), 'screen'), { recursive: true, force: true });
  throw new Error(`the screen recording started on ${first.id}, not on ${expected}: stopped the meeting and deleted its screen folder`);
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

const slideTwo = (text) => /\bslide 2\b/i.test(text || '');

// The fragments of a video file as `rukoo-voice-screen inspect` reads them.
function inspect(file) {
  const out = spawnSync(SCREEN_EXE, ['inspect', file], { encoding: 'utf8', windowsHide: true });
  try {
    return JSON.parse(out.stdout);
  } catch (_) {
    return { error: out.stderr || out.stdout };
  }
}

// Every video file of a meeting: complete, read to the end by Media Foundation, and its fragments 1.0 to 2.0 s long
// except the last.
function checkVideos(id, label) {
  const ends = journal(id).filter((l) => l.kind === 'video');
  const files = ends.map((v) => ({ seq: v.seq, file: path.join(meetingDir(id), v.file), width: v.width, height: v.height, encoder: v.encoder, hardware: v.hardware }));
  const results = files.map((f) => {
    const r = inspect(f.file);
    const inner = (r.fragmentMs || []).slice(0, -1);
    return {
      seq: f.seq,
      size: `${f.width}x${f.height}`,
      encoder: f.encoder,
      hardware: f.hardware,
      fragments: r.fragments,
      durationMs: r.durationMs,
      minMs: inner.length ? Math.min(...inner) : null,
      maxMs: inner.length ? Math.max(...inner) : null,
      complete: r.complete,
      readerSamples: r.reader?.samples ?? null,
      fps: r.durationMs ? Math.round((r.samples / r.durationMs) * 10000) / 10 : null,
      readerSize: r.reader && r.reader.width ? `${r.reader.width}x${r.reader.height}` : null,
      ok: !r.error && r.complete && inner.every((ms) => ms >= 1000 && ms <= 2000) && (r.reader?.samples || 0) > 0,
      error: r.error || r.reader?.error || null
    };
  });
  check(`${label}: every video file inspects cleanly with 1 to 2 s fragments`, results.length > 0 && results.every((r) => r.ok), results);
  return results;
}

// ---------- the run ----------

async function pair(monitor) {
  // A measurement says whether live speaker labels run; the other runs keep Voice's default, which is on.
  writeConfig(ARGS.measure === 'screen' ? { meetings_live_speakers: SPEAKERS === true } : {});
  const voice = startVoice(1, { monitor });
  await until('the discovery file', () => fs.existsSync(BRIDGE), 60000);
  const first = await hook('status');
  check('Voice runs the real engine in a development copy', first.settings.devMode === true && first.pid === voice.pid, { pid: first.pid });
  if (SPEAKERS === true) {
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
  const caps = await until('the screen probe', async () => (await hook('status')).settings.screen, 30000);
  report.screen.capabilities = caps;
  check('Voice found its screen process and can record the screen', caps.available === true, caps);
  const def = await until("Voice's default screen mode in Rukoo", async () => (await rukoo.state()).screenDefault === ARGS.screen, 15000).catch(() => false);
  check("Rukoo knows Voice's default screen mode from status", def, { expected: ARGS.screen });
  return voice;
}

// The screen of a meeting while it records: frames with text in Rukoo, an image through meetingFrame, and slide 2 at
// its moment.
async function checkFrames(id, { realOffsets = null } = {}) {
  const capture = await until('the first capture line', () => journal(id).find((l) => l.kind === 'capture'), 30000, 100);
  const two = await until('a frame that reads "Slide 2"', () => journal(id).find((l) => l.kind === 'frame' && slideTwo(l.text)), 60000, 250);
  if (realOffsets) {
    const expected = report.screen.slides.firstCallSegment + realOffsets[1];
    check('the frame that reads "Slide 2" sits at the slide\'s moment in the call (within 2.2 s)', two.t >= expected - 100 && two.t <= expected + 2200, { at: two.t, expected });
  } else {
    check('the frame that reads "Slide 2" sits 10.0 to 12.2 s after the capture started', two.t >= capture.t + 10000 && two.t <= capture.t + 12200, { at: two.t, capture: capture.t });
  }
  const seen = await until('frames in Rukoo', async () => {
    const m = await rukoo.get(id);
    return (m.frames || []).length > 0 && m;
  }, 30000, 500);
  const recording = (await rukoo.state()).recording === id;
  const withText = seen.frames.filter((f) => (f.text || '').length > 0).length;
  check('frames with their text reached Rukoo while it records', recording && withText > 0, { frames: seen.frames.length, withText });
  const latest = seen.frames.at(-1);
  const url = await rukoo.frame(id, latest.at);
  check("Rukoo's meetingFrame returns the frame's image", typeof url === 'string' && url.startsWith('data:image/jpeg;base64,'), { at: latest.at, bytes: url ? url.length : 0 });
  report.screen.slideTwoAt = two.t;
  report.screen.captureAt = capture.t;
}

// A killed screen process comes back through Voice's watchdog; the audio goes on.
async function killScreen(id) {
  const doomed = screenOf(id);
  const killedAt = Date.now();
  killPid(doomed.pid);
  const back = await until('a new screen process', () => {
    const s = screenOf(id);
    return s && s.pid !== doomed.pid && alive(s.pid) && s;
  }, 30000, 200);
  check("Voice's watchdog restarted the killed screen process", true, { killed: doomed.pid, resumed: back.pid, after: `${Date.now() - killedAt} ms` });
  const crash = await until('a crash line in the screen journal', () => journal(id).find((l) => l.kind === 'crash'), 20000);
  const gap = await until('a screen gap in Rukoo', async () => {
    const m = await rukoo.get(id);
    return (m.marks || []).find((k) => k.kind === 'screen_gap' && k.detail === 'crash');
  }, 30000, 500);
  check('Rukoo shows a screen gap with detail crash', Boolean(gap), { at: gap.at, until: gap.until, crash: { t: crash.t, lastSeen: crash.lastSeen } });
  await sleep(3000);
  const audio = timeline(id).filter((l) => ['crash', 'device_lost', 'suspend'].includes(l.kind));
  const m = await rukoo.get(id);
  const audioGaps = (m.marks || []).filter((k) => k.kind === 'gap');
  check('neither audio track has a gap from the screen process\'s crash', audio.length === 0 && audioGaps.length === 0, { timeline: audio, marks: audioGaps });
  return back;
}

async function standardRun(voice, offsets) {
  const labels = SPEAKERS === true;
  // 2. A meeting started from Rukoo, with Voice's default screen mode.
  const t0 = Date.now();
  const { meetingId: id } = await rukoo.start({ title: 'Live run: launch review' });
  check('Rukoo started a meeting through Voice', Boolean(id), id);
  report.meeting = id;
  const stopSlides = offsets ? scheduleSlides(id, offsets) : () => {};
  try {
    await until('the recording status in Rukoo', async () => (await rukoo.state()).recording === id, 15000);
    const shielded = await rukoo.protectedWindows();
    check("Rukoo's windows are protected from capture while it records", shielded.length > 0 && shielded.every(Boolean), shielded);
    const status = await hook('status');
    const pill = status.pill;
    check('the pill shows the recording', pill.visible && pill.phase === 'meeting' && pill.meeting?.state === 'recording', { phase: pill.phase, meeting: pill.meeting });
    const meta = await until('the meeting in Rukoo', async () => {
      const m = await rukoo.get(id);
      return m?.meeting?.screen && m;
    }, 10000);
    check("the meeting records Voice's default screen mode", meta.meeting.screen === ARGS.screen, { screen: meta.meeting.screen });
    if (ARGS.screen !== 'off') {
      check('the pill shows the screen recording', pill.meeting?.screen === ARGS.screen, { screen: pill.meeting?.screen, screenSwitch: pill.meeting?.screenSwitch });
      const live = await until('screen.json', () => screenOf(id), 30000, 100);
      check('screen.json names a live screen process', alive(live.pid), { pid: live.pid });
      if (ARGS.realScreen) await guardMonitor(id, report.screen.slideDisplay);
      await checkFrames(id, { realOffsets: ARGS.realScreen ? offsets : null });
    }

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
    if (!ARGS.realScreen) {
      await win.keyboard.press('Control+3');
      await win.locator('.meeting .mt-transcript .mt-passage').first().waitFor({ timeout: 20000 });
      await sleep(1000);
      await captureRukoo(path.join(SHOTS, 'rukoo-meeting-live.png'));
      const shots = await hook('capture', { dir: SHOTS, page: 'rukoo' }, 90000);
      check('Voice captured its pill and Settings > Rukoo from WebView2', !shots.pill.error && !shots.settings.error, shots);
    }

    // 3b. The screen process dies; Voice's watchdog starts it again and the audio doesn't notice.
    let screenPid = null;
    if (ARGS.screen !== 'off') screenPid = (await killScreen(id)).pid;

    // 4. Voice restarts mid-meeting; the recorder and the screen process go on and the new Voice reattaches.
    const before = await rukoo.get(id);
    const lastEnd = Math.max(...before.passages.map((p) => p.end));
    const recorder = recorderOf(id);
    const restartAt = meetingNow(id);
    killPid(voice.pid);
    await until('Voice to exit', () => !alive(voice.pid), 15000);
    await sleep(1500);
    check('the recorder outlives Voice', recorder && alive(recorder.pid), recorder && { pid: recorder.pid });
    if (screenPid) check('the screen process outlives Voice', alive(screenPid), { pid: screenPid });
    voice = startVoice(2, { monitor: report.screen.pinned });
    await until('Rukoo to reconnect to the new Voice', async () => (await rukoo.connected()) && (await rukoo.state()).voiceVersion, 60000);
    const reattached = await until('the reattached meeting in the pill', async () => {
      const s = await hook('status');
      return s.pill.meeting?.state === 'recording' && s;
    }, 30000);
    check('the new Voice reattached to the running recorder', recorderOf(id)?.pid === recorder.pid && reattached.tray.meeting === 'recording', { recorder: recorder.pid });
    if (screenPid) {
      await sleep(2000);
      check('the new Voice kept the same screen process', screenOf(id)?.pid === screenPid && alive(screenPid), { pid: screenOf(id)?.pid });
    }
    const resumed = await until('passages after the restart', async () => {
      const m = await rukoo.get(id);
      return m.passages.some((p) => p.start > lastEnd) && m;
    }, 120000, 500);
    check('the meeting goes on after the restart without passages twice', overlaps(resumed.passages).length === 0, { overlaps: overlaps(resumed.passages), passages: resumed.passages.length });
    check("Rukoo's windows stayed protected through the restart", (await rukoo.protectedWindows()).every(Boolean));
    if (labels && named) await keepsItsId(id, named, restartAt, 'after the Voice restart');
    if (screenPid) {
      const framesBefore = (await rukoo.get(id)).frames.length;
      const more = await until('a frame after the restart', async () => (await rukoo.get(id)).frames.length > framesBefore, 30000, 500).catch(() => false);
      check('frames keep reaching Rukoo after the restart', more, { before: framesBefore });
    }

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
    const tl = timeline(id);
    check('the timeline has a resumed session and a crash line', tl.some((l) => l.kind === 'session' && l.resumed) && tl.some((l) => l.kind === 'crash'));
    if (screenPid) check('the screen process followed the resumed recorder', alive(screenOf(id)?.pid), { pid: screenOf(id)?.pid });

    // 6. Stop from Rukoo: processing, then done, after the screen journal's stop.
    await sleep(labels ? 20000 : 6000);
    await rukoo.stop(id);
    await until('done', async () => (await rukoo.get(id)).meeting.state === 'done', 240000, 200);
    const states = await voiceStates(id);
    check('the stop went to processing, then done', stoppedThenDone(states), states);
    if (ARGS.screen !== 'off') {
      const j = journal(id);
      const last = j.at(-1);
      check('the screen journal ends with stop, reason meeting, at the recorder\'s stop', last?.kind === 'stop' && last.reason === 'meeting' && last.t === timeline(id).at(-1)?.t, { last, recorderStop: timeline(id).at(-1)?.t });
      check('screen.json is gone after the stop', !fs.existsSync(path.join(meetingDir(id), 'screen', 'screen.json')));
      report.screen.journal = summarizeJournal(j);
      if (ARGS.screen === 'video') report.screen.videos = checkVideos(id, 'the meeting from Rukoo');
    } else {
      check('a meeting without the screen has no screen folder', !fs.existsSync(path.join(meetingDir(id), 'screen')));
    }
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
    if (ARGS.screen !== 'off') {
      const ids = (x) => (x.frames || []).map((f) => f.id).sort().join(',');
      check("Rukoo's frames are Voice's frames", ids(mine) === ids(theirs) && (theirs.frames || []).length > 0, { voice: (theirs.frames || []).length, rukoo: (mine.frames || []).length });
    }
    await captureRukoo(path.join(SHOTS, 'rukoo-meeting-done.png'));
    if (labels) await speakersAfterDone(id, mine, named);
  } finally {
    stopSlides();
  }

  // 8. A meeting started from Voice's side, as from its tray, with Voice's default screen mode.
  const fromVoice = (await hook('start_meeting')).meeting;
  const seen = await until("Rukoo to pick up Voice's meeting", async () => {
    const m = await rukoo.get(fromVoice);
    const s = await rukoo.state();
    return m && s.recording === fromVoice && m;
  }, 30000);
  check('a meeting Voice started shows in Rukoo as recording', seen.meeting.startedBy === 'voice', { id: fromVoice, eventId: seen.meeting.eventId, event: seen.event });
  check("the meeting Voice started records Voice's default screen mode", seen.meeting.screen === ARGS.screen, { screen: seen.meeting.screen });
  check("Rukoo protects its windows for Voice's meeting too", (await rukoo.protectedWindows()).every(Boolean));
  if (!seen.meeting.eventId) note('no calendar event in the demo account fits this time of day, so Rukoo linked none (it links one only when exactly one fits)');
  if (ARGS.screen !== 'off') {
    if (ARGS.realScreen) await guardMonitor(fromVoice, report.screen.slideDisplay);
    await until('a frame of the meeting Voice started', () => journal(fromVoice).some((l) => l.kind === 'frame'), 20000);
    const startLine = (await voiceLog("SELECT COUNT(*) AS n FROM events WHERE event = 'meeting.starting' AND meeting = ?", fromVoice))[0].n;
    check('Voice asked Rukoo to protect before it captured (meeting.starting)', startLine >= 1, { events: startLine });
  }
  await sleep(4000);
  await hook('stop_meeting');
  await until("Voice's meeting to be done", async () => (await rukoo.get(fromVoice)).meeting.state === 'done', 120000, 500);
  const fromVoiceStates = await voiceStates(fromVoice);
  check('the meeting Voice started went to processing, then done', stoppedThenDone(fromVoiceStates), fromVoiceStates);

  // 9. Rukoo asks for video once, whatever Voice's default.
  if (ARGS.screen !== 'video') {
    const { meetingId: vid } = await rukoo.start({ title: 'Live run: video from Rukoo', screen: 'video' });
    await until('the recording status in Rukoo', async () => (await rukoo.state()).recording === vid, 15000);
    if (ARGS.realScreen) await guardMonitor(vid, report.screen.slideDisplay);
    const session = await until('the screen journal\'s session line', () => journal(vid).find((l) => l.kind === 'session'), 30000, 100);
    const video = await until('a video file', () => journal(vid).find((l) => l.kind === 'video' || l.kind === 'dropped'), 30000, 100);
    const m = await rukoo.get(vid);
    check('a meeting Rukoo starts with screen video records video', m.meeting.screen === 'video' && session.mode === 'video' && video.kind === 'video', { screen: m.meeting.screen, mode: session.mode, encoder: video.encoder, hardware: video.hardware });
    await sleep(5000);
    await rukoo.stop(vid);
    await until('done', async () => (await rukoo.get(vid)).meeting.state === 'done', 120000, 300);
    checkVideos(vid, 'the video meeting from Rukoo');
  }

  const rows = await statusRows();
  check("Voice's event log keeps only the newest status event", rows === 1, { statusRows: rows });
  const final = await hook('status');
  report.settingsRukoo = final.settings.rukoo;
  check('Settings > Rukoo reports the client and how far behind it is', final.settings.rukoo.state === 'connected' && final.settings.rukoo.behind === 0, final.settings.rukoo);
}

// Counts per kind and the drops; never the frames' text.
function summarizeJournal(j) {
  const kinds = {};
  for (const l of j) kinds[l.kind] = (kinds[l.kind] || 0) + 1;
  return {
    kinds,
    dropped: j.filter((l) => l.kind === 'dropped').map((l) => ({ t: l.t, what: l.what, reason: l.reason })),
    monitors: j.filter((l) => l.kind === 'monitor').map((l) => ({ t: l.t, id: l.id, reason: l.reason, size: `${l.width}x${l.height}` })),
    ocr: j.filter((l) => l.kind === 'frame').reduce((acc, l) => ({ ...acc, [l.ocr]: (acc[l.ocr] || 0) + 1 }), {})
  };
}

// --choose-monitor: Voice picks the display of the focused window; then the pill and Rukoo's header move it.
async function chooseRun(offsets) {
  const target = ARGS.chooseMonitor;
  // The window the user works in: the slide, as Windows' foreground window. Electron's focus() only activates it
  // within its own thread when another process has the foreground, so the run brings it to the front itself.
  await screens.evaluate(() => global.__demo.slide.focus());
  const hwnd = await screens.evaluate(() => global.__demo.slide.getNativeWindowHandle().readBigUInt64LE(0).toString());
  const front = foreground(hwnd);
  report.screen.slideForeground = front;
  if (!front) throw new Error("couldn't make the slide window the foreground window, so the monitor choice can't be checked");
  const { meetingId: id } = await rukoo.start({ title: 'Live run: monitor choice' });
  check('Rukoo started a meeting through Voice', Boolean(id), id);
  report.meeting = id;
  const stopSlides = scheduleSlides(id, offsets);
  try {
    await until('the recording status in Rukoo', async () => (await rukoo.state()).recording === id, 15000);
    const first = await guardMonitor(id, target);
    check('Voice chose the display of the focused window', first.id === target && first.reason === 'start', { id: first.id, size: `${first.width}x${first.height}` });
    if (ARGS.screen === 'video') {
      const video = await until('the first video file', () => journal(id).find((l) => l.kind === 'video'), 20000, 100);
      const display = displays.find((d) => d.id === target);
      check('the video keeps the display\'s own size', video.width === display.width && video.height === display.height, { video: `${video.width}x${video.height}`, display: `${display.width}x${display.height}`, encoder: video.encoder, hardware: video.hardware });
    }
    await checkFrames(id, { realOffsets: offsets });

    const users = () => journal(id).filter((l) => l.kind === 'monitor' && l.reason === 'user');
    const userMarks = async () => ((await rukoo.get(id)).marks || []).filter((k) => k.kind === 'monitor' && k.detail === 'user');

    // From the pill: the next monitor, left to right.
    await hook('pill_screen_click');
    const viaPill = await until('a monitor line after the pill click', () => users()[0], 15000, 100);
    const others = displays.filter((d) => d.id !== target).map((d) => d.id);
    check('the pill moved the recording to the next monitor, with reason user', others.includes(viaPill.id), { id: viaPill.id });
    const mark1 = await until('a monitor mark in Rukoo', async () => (await userMarks())[0], 20000, 500);
    check('Rukoo shows the move from the pill as a monitor mark with detail user', Boolean(mark1), { at: mark1.at, label: mark1.label });
    await sleep(3000);

    // From Rukoo's header: back to the chosen display.
    const info = await rukoo.screen(id);
    check("Rukoo's header lists the monitors and the one recorded now", info.monitors.length === displays.length && info.monitor === viaPill.id, { monitor: info.monitor, monitors: info.monitors.map((m) => m.id) });
    const picked = await rukoo.select(id, target);
    const viaRukoo = await until('a monitor line after the header pick', () => users()[1], 15000, 100);
    check("Rukoo's header moved the recording back, with reason user", picked === target && viaRukoo.id === target, { picked, id: viaRukoo.id });
    const mark2 = await until('a second monitor mark in Rukoo', async () => (await userMarks())[1], 20000, 500);
    check('Rukoo shows the move from its header as a monitor mark with detail user', Boolean(mark2), { at: mark2.at, label: mark2.label });
    await sleep(4000);

    await rukoo.stop(id);
    await until('done', async () => (await rukoo.get(id)).meeting.state === 'done', 240000, 300);
    const j = journal(id);
    check('the screen journal ends with stop, reason meeting', j.at(-1)?.kind === 'stop' && j.at(-1)?.reason === 'meeting', j.at(-1));
    report.screen.journal = summarizeJournal(j);
    if (ARGS.screen === 'video') report.screen.videos = checkVideos(id, 'the monitor-choice meeting');
  } finally {
    stopSlides();
  }
}

// The first frame of a meeting Voice started, against Rukoo's window over half of the slide.
async function visibleMeeting(hide, probes, rect) {
  await rukoo.settings({ meetingHideWindow: hide });
  const id = (await hook('start_meeting')).meeting;
  await until("Rukoo to pick up Voice's meeting", async () => (await rukoo.state()).recording === id, 30000);
  await guardMonitor(id, report.screen.slideDisplay);
  const first = await until('the first frame', () => journal(id).find((l) => l.kind === 'frame'), 30000, 100);
  const text = normalize(first.text);
  const words = new Set(text.split(' '));
  const matched = probes.filter((p) => words.has(p));
  const url = await until("the first frame's image in Rukoo", async () => {
    const m = await rukoo.get(id);
    return (m.frames || []).length > 0 && rukoo.frame(id, first.t);
  }, 30000, 500);
  const pixels = await frameAgainstSlide(url, rect);
  const shielded = await rukoo.protectedWindows();
  await hook('stop_meeting');
  await until("Voice's meeting to be done", async () => (await rukoo.get(id)).meeting.state === 'done', 120000, 500);
  return { id, matched: matched.length, probes: probes.length, ocr: first.ocr, diff: pixels.diff, protectedWindows: shielded };
}

const normalize = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// --visible-rukoo: with hiding off Rukoo shows in the first frame (the check can fail); with it on it doesn't.
async function visibleRun() {
  const slide = displays.find((d) => d.id === report.screen.slideDisplay);
  const b = slide.bounds;
  const bounds = { x: b.x + Math.round(b.width / 2), y: b.y + 60, width: Math.round(b.width / 2) - 60, height: b.height - 120 };
  const rect = { x: (bounds.x - b.x + 40) / b.width, y: (bounds.y - b.y + 40) / b.height, width: (bounds.width - 80) / b.width, height: (bounds.height - 80) / b.height };
  await app.evaluate(({ BrowserWindow }, r) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.setBounds(r);
    // Larger text, so Windows reads Rukoo's strings reliably when they are in the frame.
    w.webContents.setZoomFactor(1.5);
    w.setAlwaysOnTop(true, 'screen-saver');
    w.showInactive();
  }, bounds);
  await sleep(1500);
  // Rukoo's demo strings on screen: the words of six letters or more in the text Rukoo's window paints where nothing
  // covers it, none of which is on the slide. Single words, so a line the text reader breaks still counts.
  const painted = await win.evaluate(() => {
    const out = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!n.textContent.trim() || !n.parentElement) continue;
      range.selectNodeContents(n);
      const r = range.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0 || r.top < 0 || r.left < 0 || r.bottom > innerHeight || r.right > innerWidth) continue;
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (top && (top === n.parentElement || n.parentElement.contains(top) || top.contains(n.parentElement))) out.push(n.textContent);
    }
    return out;
  });
  const onSlide = new Set(normalize(SLIDES.flat().join(' ')).split(' '));
  const probes = [...new Set(normalize(painted.join(' ')).split(' '))].filter((w) => w.length >= 6 && !/^\d+$/.test(w) && !onSlide.has(w));
  report.screen.visible = { rukooBounds: bounds, probes: probes.length };
  try {
    const off = await visibleMeeting(false, probes, rect);
    report.screen.visible.off = off;
    check("with Rukoo's hiding switch off, its demo strings show in the first frame", off.matched >= 3 && off.protectedWindows.every((p) => !p), { matched: off.matched, of: off.probes, ocr: off.ocr });
    check("with hiding off, the frame doesn't show the slide where Rukoo's window is", off.diff > 20, { meanDiff: off.diff });
    const on = await visibleMeeting(true, probes, rect);
    report.screen.visible.on = on;
    check("with Rukoo's hiding switch on, none of its demo strings show in the first frame", on.matched === 0 && on.protectedWindows.every(Boolean), { matched: on.matched, of: on.probes, ocr: on.ocr });
    check("with hiding on, the frame shows the slide where Rukoo's window is", on.diff <= 12, { meanDiff: on.diff });
  } finally {
    await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0];
      w.setAlwaysOnTop(false);
      w.webContents.setZoomFactor(1);
      w.setPosition(-5000, -5000);
    });
  }
}

// ---------- measurements ----------

// The nearest-rank percentile, p from 0 to 100.
function nearestRank(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

function dirBytes(dir) {
  let total = 0;
  if (!fs.existsSync(dir)) return 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    total += entry.isDirectory() ? dirBytes(p) : fs.statSync(p).size;
  }
  return total;
}

// The screen log's own timings: "frame <id>: WxH, <n> bytes, jpeg <ms> ms, ocr <ms> ms (<status>)" and the GPU memory.
function screenLog(id) {
  const file = path.join(VOICE_DATA, 'logs', `screen-${id}.log`);
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const jpeg = [];
  const ocr = [];
  const memory = [];
  for (const line of text.split('\n')) {
    const f = /jpeg (\d+) ms, ocr (\d+) ms/.exec(line);
    if (f) {
      jpeg.push(Number(f[1]));
      ocr.push(Number(f[2]));
    }
    const m = /gpu memory in use: (\d+) MB/.exec(line);
    if (m) memory.push(Number(m[1]));
  }
  return { jpegMs: { p50: nearestRank(jpeg, 50), p95: nearestRank(jpeg, 95) }, ocrMs: { p50: nearestRank(ocr, 50), p95: nearestRank(ocr, 95) }, gpuMemoryMb: memory.length ? Math.max(...memory) : null };
}

// One measured meeting: started from Rukoo with `screen`, measured for ARGS.seconds once transcription runs. On the
// synthetic screen a new slide comes every 10 s throughout; with --real-screen the slide display runs the section 7
// script: slides every 10 s for 60% of the time, a scrolling page for 20%, then still.
async function measureRun(voice, name, screen) {
  console.log(`\nmeasuring: ${name}`);
  const { meetingId: id } = await rukoo.start({ title: `Live run: measure ${name}`, screen });
  await until('the recording status in Rukoo', async () => (await rukoo.state()).recording === id, 15000);
  if (screen !== 'off' && ARGS.realScreen) await guardMonitor(id, report.screen.slideDisplay);
  await until('the first passage', async () => ((await rukoo.get(id)).passages || []).length > 0, 120000, 500);
  const pids = { 'rukoo-voice': voice.pid, recorder: recorderOf(id).pid };
  const children = childrenOf(voice.pid);
  if (children['rukoo-voice-local']) pids.local = children['rukoo-voice-local'];
  // With live speaker labels on, the speaker worker belongs to the meeting's load.
  const speakerWorker = (await labelsOf(id))?.workerPid || children['rukoo-voice-speakers'];
  if (speakerWorker) pids.speakers = speakerWorker;
  if (screen !== 'off') pids.screen = screenOf(id).pid;
  const out = path.join(RUN, `measure-${name}.json`);
  const seconds = ARGS.seconds;
  const sampler = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(VOICE, 'scripts', 'measure.ps1'), '-Pids', Object.values(pids).join(','), '-Names', Object.keys(pids).join(','), '-Seconds', String(seconds), '-Out', out], { stdio: 'inherit', windowsHide: true });
  started.measure.push(sampler.pid);
  const t0 = Date.now();
  const startAt = (await rukoo.get(id)).passages.length;
  const plan = [];
  if (ARGS.realScreen) {
    const slidesFor = Math.round(seconds * 0.6);
    for (let s = 0, n = 1; s < slidesFor; s += 10, n++) plan.push([s * 1000, `slide(${n})`]);
    plan.push([slidesFor * 1000, 'scrolling(true)']);
    plan.push([Math.round(seconds * 0.8) * 1000, 'scrolling(false)']);
  }
  const timers = plan.map(([at, code]) => setTimeout(() => slideCall(code).catch(() => {}), at));
  const exit = await new Promise((resolve) => sampler.on('exit', resolve));
  timers.forEach(clearTimeout);
  const elapsed = (Date.now() - t0) / 1000;
  await rukoo.stop(id);
  await until('done', async () => (await rukoo.get(id)).meeting.state === 'done', 300000, 500);
  const sampled = readJson(out);
  const j = journal(id);
  const video = j.find((l) => l.kind === 'video');
  const lengthH = (timeline(id).at(-1).t - (timeline(id).find((l) => l.kind === 'session')?.t || 0)) / 3600000;
  const result = {
    name,
    screen,
    source: ARGS.realScreen ? 'real' : synthetic(syntheticSize),
    liveSpeakers: SPEAKERS === true,
    monitor: j.find((l) => l.kind === 'monitor')?.id || null,
    seconds,
    elapsed: Math.round(elapsed),
    sampler: exit,
    pids,
    encoder: video ? { name: video.encoder, hardware: video.hardware, size: `${video.width}x${video.height}` } : null,
    dropped: j.filter((l) => l.kind === 'dropped').map((l) => `${l.what} ${l.reason}`),
    passages: (await rukoo.get(id)).passages.length - startAt,
    perHour: {
      videoBytes: Math.round(dirBytes(path.join(meetingDir(id), 'screen', 'video')) / lengthH),
      frameBytes: Math.round(dirBytes(path.join(meetingDir(id), 'screen', 'frames')) / lengthH),
      audioBytes: Math.round(dirBytes(path.join(meetingDir(id), 'audio')) / lengthH),
      frames: Math.round(j.filter((l) => l.kind === 'frame').length / lengthH)
    },
    screenLog: screen === 'off' ? null : screenLog(id),
    summary: sampled?.summary || null
  };
  check(`measured ${name}: ${seconds} s of samples`, exit === 0 && sampled && sampled.summary.seconds >= seconds - 2, { samples: sampled?.summary.samples, seconds: sampled?.summary.seconds, sampler: exit });
  if (screen !== 'off') check(`measured ${name}: the screen journal ends with stop`, j.at(-1)?.kind === 'stop', j.at(-1)?.reason);
  return result;
}

async function measureAll(voice, sizes) {
  report.measure = [];
  const main = displays.find((d) => d.primary);
  const other = displays.find((d) => !d.primary);
  for (const [name, screen] of [['off', 'off'], ['frames', 'frames'], ['video', 'video']]) report.measure.push(await measureRun(voice, name, screen));
  // The fourth: video on the other display, or on the synthetic screen at its size. Live speaker labels are on in all
  // four with --speakers, for the combined load, and off without.
  const fourth = ARGS.realScreen ? other && `${other.width}x${other.height}` : sizes.find((s) => s !== syntheticSize);
  if (fourth) {
    killPid(voice.pid);
    await until('Voice to exit', () => !alive(voice.pid), 15000);
    if (ARGS.realScreen) {
      report.screen.slideDisplay = other.id;
      report.screen.pinned = other.id;
      await showDemoWindows(other.id);
    } else {
      syntheticSize = fourth;
    }
    voice = startVoice(2, { monitor: ARGS.realScreen ? other.id : null });
    await until('Rukoo to reconnect to the new Voice', async () => (await rukoo.connected()) && (await rukoo.state()).voiceVersion, 60000);
    report.measure.push(await measureRun(voice, `video-${fourth}`, 'video'));
    if (ARGS.realScreen) report.screen.slideDisplay = main.id;
  }
  printMeasurements(report.measure);
}

function printMeasurements(runs) {
  console.log('\nrun                 process       CPU mean/p95/max (% of a core)   GPU mean (% per engine)');
  for (const r of runs) {
    for (const [name, s] of Object.entries(r.summary?.processes || {})) {
      const gpu = Object.entries(s.gpu || {})
        .filter(([, v]) => v.mean > 0)
        .map(([k, v]) => `${k} ${v.mean}`)
        .join(', ');
      console.log(`${r.name.padEnd(20)}${name.padEnd(14)}${`${s.cpu.mean} / ${s.cpu.p95} / ${s.cpu.max}`.padEnd(33)}${gpu}`);
    }
    if (r.summary) console.log(`${r.name.padEnd(20)}${'machine'.padEnd(14)}${`${r.summary.total.mean} / ${r.summary.total.p95} / ${r.summary.total.max} (% of all cores)`}`);
  }
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
    if (minutes >= 21) {
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

  let offsets = null;
  let pinned = null;
  if (ARGS.realScreen) {
    offsets = partOffsets(THEM);
    note(`the call's parts, and so the slides, start at ${offsets.map((ms) => `${(ms / 1000).toFixed(1)} s`).join(', ')} of its WAV`);
    await startScreens();
    const slide = ARGS.chooseMonitor ? displays.find((d) => d.id === ARGS.chooseMonitor) : displays.find((d) => d.primary);
    if (!slide) throw new Error(`no display ${ARGS.chooseMonitor} on this computer`);
    report.screen.slideDisplay = slide.id;
    // --choose-monitor checks the choice instead of pinning it.
    pinned = ARGS.chooseMonitor ? null : slide.id;
    report.screen.pinned = pinned;
    await showDemoWindows(slide.id, { focused: Boolean(ARGS.chooseMonitor) });
  }

  // The synthetic screen of a measurement takes the sizes of this computer's displays, read from Windows, the main
  // display's first: the cost of encoding and reading text depends on the pixels.
  let sizes = [];
  if (ARGS.measure && !ARGS.realScreen) {
    const listed = windowsDisplays().sort((a, b) => Number(b.primary) - Number(a.primary));
    sizes = [...new Set(listed.map((d) => `${d.width}x${d.height}`))];
    if (sizes.length) syntheticSize = sizes[0];
    report.screen.syntheticSizes = sizes;
    note(`the synthetic screen takes the displays' sizes: ${sizes.join(', ') || 'none listed, so 1920x1080'}`);
  }

  // 1. Voice, then Rukoo, paired through RUKOO_VOICE_BRIDGE.
  const voice = await pair(pinned);
  if (ARGS.measure) await measureAll(voice, sizes);
  else if (ARGS.chooseMonitor) await chooseRun(offsets);
  else if (ARGS.visibleRukoo) await visibleRun();
  else await standardRun(voice, offsets);
}

// ---------- main ----------

async function main() {
  if (process.platform !== 'win32') throw new Error('The live run needs Windows: Voice records there only.');
  fs.mkdirSync(RUN, { recursive: true });
  fs.mkdirSync(SHOTS, { recursive: true });
  if (!ARGS.skipBuild) build();
  for (const exe of [EXE, SCREEN_EXE]) if (!fs.existsSync(exe)) throw new Error(`${exe} is missing; build it first`);
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
  for (const electronApp of [app, screens]) {
    if (!electronApp) continue;
    const pid = electronApp.process().pid;
    try {
      await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.destroy()));
      await Promise.race([electronApp.close(), sleep(45000)]);
    } catch (_) {
      // Gone already.
    }
    if (alive(pid)) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  }
  for (const pid of started.measure) if (alive(pid)) killPid(pid);
  for (const pid of started.voice) if (alive(pid)) killPid(pid);
  // A recorder or a screen process still recording after a failure: by the id in its recorder.json or screen.json.
  for (const data of started.dataDirs) {
    const meetings = path.join(data, 'meetings');
    for (const id of fs.existsSync(meetings) ? fs.readdirSync(meetings) : []) {
      const dir = path.join(meetings, id);
      for (const [what, info] of [['recorder', readJson(path.join(dir, 'recorder.json'))], ['screen process', readJson(path.join(dir, 'screen', 'screen.json'))]]) {
        if (info && alive(info.pid)) {
          killPid(info.pid);
          note(`stopped a ${what} that was still running: ${info.pid}`);
        }
      }
    }
  }
  report.leftRunning = [...started.voice, started.rukoo, started.screens].filter((pid) => pid && alive(pid));
  if (ARGS.realScreen) {
    await sleep(1000);
    deleteRealCaptures();
  }
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
