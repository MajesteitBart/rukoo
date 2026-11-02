// The live paired run of Rukoo Voice 0.1 and Rukoo, its acceptance test: a development Voice on the real engine
// records SAPI speech through its recorder's file sources, transcribes it with Orukeet, and streams the meeting to a
// development Rukoo over the bridge.
//
//   node voice/scripts/live-meeting.mjs [--skip-build] [--sync] [--measure=sync] [--remote-fetch=<ssh target>]
//
// Windows only. Everything it starts lives under tmp\live\<time>\ in this checkout: Voice's data folder
// (RUKOO_VOICE_DATA_DIR), Rukoo's profile (SEM_DATA_DIR), the discovery file both get as RUKOO_VOICE_BRIDGE, and the
// speech. Captures of the apps' own windows go to tmp\live-shots\. Orukeet is read from Ownkey's model folder, read
// only. Nothing touches the installed apps, the clipboard or the keyboard, nothing plays out loud, and every process
// it started is stopped by its process id. Rukoo's MCP server listens on port 47810, not the 47800 an installed
// Rukoo uses. Voice is found in CARGO_TARGET_DIR when that is set.
//
// The checks: passages with the expected words reach Rukoo on both tracks before the stop; the pill shows the
// recording; Rukoo's windows are protected from capture; Voice restarted mid-meeting reattaches to the recorder and
// sends no passage twice; a killed recorder comes back through the watchdog with a gap mark; the stop goes to
// processing, then done; Rukoo's meeting.get has every passage Voice has; and a meeting started from Voice shows up
// in Rukoo. The report is tmp\live\<time>\report.json.
//
// --sync adds bucket sync against voice-s3-fake (rukoo-voice-fake-s3) in tmp\live\<time>\s3\: Voice connects
// through its Settings commands before the meeting; audio objects arrive while it records; the fake stops for 20 s
// mid-meeting and the recorder's heartbeats stay within 1,300 ms; the Voice restart leaves no object uploaded twice;
// after done every object passes check-encrypted.mjs and neither the secret nor the recovery code is in plain text;
// an agent's audio link (get_meeting_media_link) gives the meeting's speech and is refused after its 5 s; and a
// second Voice on a fresh data folder imports the code, restores every meeting into Rukoo and serves the same audio
// from the bucket. --measure=sync adds spec-RUK-110's measurements to report.json: a 10-minute meeting with sync on,
// a 3-minute one with sync off and six short ones. --remote-fetch=<ssh target> lets that machine, on the tailnet, call
// the tool over Rukoo's Tailscale listener and download the link with curl, read only; it then checks that the link
// is refused from this computer's own address and after it expired. The recovery code and the secret stay in memory.

import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { _electron: electron } = require('@playwright/test');

const ARGS = process.argv.slice(2);
const MEASURES = ['sync'];
const valueOf = (name) => {
  const arg = ARGS.find((a) => a.startsWith(`${name}=`));
  return arg ? arg.slice(name.length + 1) : null;
};
for (const arg of ARGS) {
  if (arg === '--measure') {
    console.error(`--measure takes a value: ${MEASURES.map((m) => `--measure=${m}`).join(', ')}`);
    process.exit(2);
  }
  if (!['--skip-build', '--sync'].includes(arg) && !/^--(measure|remote-fetch)=./.test(arg)) {
    console.error(`unknown argument ${arg}`);
    process.exit(2);
  }
}
const MEASURE = valueOf('--measure');
if (MEASURE && !MEASURES.includes(MEASURE)) {
  console.error(`unknown measurement ${MEASURE}; one of ${MEASURES.join(', ')}`);
  process.exit(2);
}
const SYNC = ARGS.includes('--sync') || MEASURE === 'sync';
const REMOTE_FETCH = valueOf('--remote-fetch');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const VOICE = path.join(ROOT, 'voice');
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const RUN = path.join(ROOT, 'tmp', 'live', STAMP);
const SHOTS = path.join(ROOT, 'tmp', 'live-shots');
const VOICE_DATA = path.join(RUN, 'voice-data');
// The second Voice of the restore, on a fresh data folder.
const VOICE_DATA_2 = path.join(RUN, 'voice-data-2');
const RUKOO_DATA = path.join(RUN, 'rukoo-data');
const BRIDGE = path.join(RUN, 'bridge', 'voice-bridge.json');
const HOOKS = path.join(RUN, 'hooks');
const S3_DIR = path.join(RUN, 's3');
const TARGET = process.env.CARGO_TARGET_DIR ? path.resolve(process.env.CARGO_TARGET_DIR) : path.join(VOICE, 'target');
const EXE = path.join(TARGET, 'debug', 'rukoo-voice.exe');
const FAKE_S3 = path.join(TARGET, 'debug', 'rukoo-voice-fake-s3.exe');
const SHERPA = process.env.SHERPA_ONNX_ARCHIVE_DIR || path.join(ROOT, 'tmp', 'sherpa-archive');
const MCP_PORT = 47810;
const LINK_TTL_MS = 5000;
const TITLE = 'Live run: launch review';
// The recorder's segments are 30 s (voice/RECORDING.md).
const SEGMENT_MS = 30000;

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

// The bucket secret the run chooses and the recovery code Voice shows: in memory only, never in the report.
const SECRETS = { secret: `test-secret-${crypto.randomBytes(12).toString('hex')}`, code: null };

const report = { started: new Date().toISOString(), run: RUN, mode: { sync: SYNC, measure: MEASURE, remoteFetch: Boolean(REMOTE_FETCH) }, checks: [], notes: [], measurements: {} };
const started = { voice: [], rukoo: null, fake: [] };
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
  console.log('building rukoo-voice, rukoo-voice-recorder, rukoo-voice-local and rukoo-voice-fake-s3 (debug)');
  const out = spawnSync('cargo', ['build', '-p', 'voice-app', '-p', 'voice-recorder', '-p', 'voice-local', '-p', 'voice-s3-fake'], {
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

function startVoice(n, data = VOICE_DATA) {
  const env = {
    ...process.env,
    RUKOO_VOICE_DATA_DIR: data,
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
  // A reply can hold the recovery code; it stays in memory only.
  fs.rmSync(reply, { force: true });
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

function timeline(id, data = VOICE_DATA) {
  try {
    return fs
      .readFileSync(path.join(data, 'meetings', id, 'timeline.jsonl'), 'utf8')
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

// A query on one of Voice's databases, read only.
async function readDb(file, query, ...params) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare(query).all(...params);
  } finally {
    db.close();
  }
}

// What Voice's event log holds: the states a meeting went through, or how many status events it keeps.
const voiceLog = (query, ...params) => readDb(path.join(VOICE_DATA, 'bridge.db'), query, ...params);

const voiceStates = async (id) =>
  (await voiceLog("SELECT data FROM events WHERE event = 'meeting.state' AND meeting = ? ORDER BY seq", id)).map((row) => JSON.parse(row.data).state);
const statusRows = async () => (await voiceLog("SELECT COUNT(*) AS n FROM events WHERE event = 'status'"))[0].n;

// processing comes before done, which comes last.
function stoppedThenDone(states) {
  const processing = states.indexOf('processing');
  return processing >= 0 && processing < states.lastIndexOf('done') && states.at(-1) === 'done';
}

// The largest step between heartbeats whose wall time is in [from, to], by the meeting clock `t`, and whether any
// gap, device_lost, crash or suspend line falls in it.
function heartbeats(lines, from = 0, to = Infinity) {
  const inside = lines.filter((l) => Number.isFinite(l.wall) ? l.wall >= from && l.wall <= to : false);
  const beats = inside.filter((l) => l.kind === 'heartbeat').map((l) => l.t);
  let maxGapMs = 0;
  for (let i = 1; i < beats.length; i++) maxGapMs = Math.max(maxGapMs, beats[i] - beats[i - 1]);
  // Lines without a wall time sit between the heartbeats around them.
  const first = lines.findIndex((l) => l.kind === 'heartbeat' && l.wall >= from);
  let last = -1;
  lines.forEach((l, i) => {
    if (l.kind === 'heartbeat' && l.wall <= to) last = i;
  });
  const trouble = first >= 0 && last >= first ? lines.slice(first, last + 1).filter((l) => ['gap', 'device_lost', 'crash', 'suspend'].includes(l.kind)).map((l) => l.kind) : [];
  return { beats: beats.length, maxGapMs, trouble };
}

// CPU time and I/O transfer counts of one process, from Win32_Process.
function cpuIo(pid) {
  const out = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-Command', `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}"; if ($p) { '{0} {1} {2} {3}' -f $p.UserModeTime, $p.KernelModeTime, $p.ReadTransferCount, $p.WriteTransferCount }`],
    { encoding: 'utf8', windowsHide: true }
  );
  const [user, kernel, read, write] = String(out.stdout || '').trim().split(/\s+/).map(Number);
  if (![user, kernel, read, write].every(Number.isFinite)) throw new Error(`no process ${pid}`);
  return { at: Date.now(), cpuMs: (user + kernel) / 1e4, readBytes: read, writeBytes: write };
}

function usage(a, b) {
  const minutes = (b.at - a.at) / 60000;
  return {
    seconds: Math.round((b.at - a.at) / 1000),
    cpuSeconds: +((b.cpuMs - a.cpuMs) / 1000).toFixed(2),
    cpuPercentOfOneCore: +(((b.cpuMs - a.cpuMs) / (b.at - a.at)) * 100).toFixed(2),
    readMB: +((b.readBytes - a.readBytes) / 1e6).toFixed(2),
    writeMB: +((b.writeBytes - a.writeBytes) / 1e6).toFixed(2),
    cpuSecondsPerMinute: +((b.cpuMs - a.cpuMs) / 1000 / minutes).toFixed(3)
  };
}

// ---------- the fake bucket (--sync) ----------

const fake = { child: null, endpoint: null, port: 0 };

// rukoo-voice-fake-s3 on port (0: any), serving S3_DIR; resolves once it prints where it listens.
async function startFakeS3(port = 0) {
  fs.mkdirSync(S3_DIR, { recursive: true });
  const log = fs.openSync(path.join(RUN, 'fake-s3.log'), 'a');
  const child = spawn(FAKE_S3, ['--port', String(port), '--bucket', 'test', '--access-key', 'test', '--dir', S3_DIR], { stdio: ['ignore', 'pipe', log], windowsHide: true });
  started.fake.push(child.pid);
  const endpoint = await new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error('the fake S3 did not say where it listens within 15 s')), 15000);
    child.stdout.on('data', (d) => {
      out += d;
      const m = /listening (http:\/\/\S+)/.exec(out);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`the fake S3 exited with ${code}`));
    });
  });
  child.stdout.resume();
  fake.child = child;
  fake.endpoint = endpoint;
  fake.port = Number(new URL(endpoint).port);
  console.log(`started the fake S3, pid ${child.pid}, ${endpoint}`);
  return endpoint;
}

async function stopFakeS3() {
  const child = fake.child;
  if (!child) return;
  killPid(child.pid);
  await until('the fake S3 to exit', () => !alive(child.pid), 10000);
  fake.child = null;
}

// The fake's request log: { op, key, part, bytes, status, at }.
function s3Log() {
  try {
    return fs
      .readFileSync(path.join(S3_DIR, 'log.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (_) {
    return [];
  }
}

// Every stored object: key -> size.
function s3Objects() {
  const root = path.join(S3_DIR, 'objects');
  const out = new Map();
  const visit = (dir) => {
    for (const entry of fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else out.set(path.relative(root, full).split(path.sep).join('/'), fs.statSync(full).size);
    }
  };
  visit(root);
  return out;
}

const uploads = (log) => log.filter((l) => (l.op === 'put' || l.op === 'upload_part') && l.status >= 200 && l.status < 300);

// Object names stored twice, and parts uploaded twice, over the whole log. Only meeting files count: a manifest
// and the index keep their names and are written again on purpose.
function duplicates(log) {
  const puts = new Map();
  const parts = new Map();
  for (const l of uploads(log)) {
    if (!l.key.includes('/o/')) continue;
    if (l.op === 'put') puts.set(l.key, (puts.get(l.key) || 0) + 1);
    else parts.set(`${l.key}#${l.part}`, (parts.get(`${l.key}#${l.part}`) || 0) + 1);
  }
  const twice = (m) => [...m].filter(([, n]) => n > 1).map(([k, n]) => `${k} x${n}`);
  return { puts: puts.size, parts: parts.size, putTwice: twice(puts), partTwice: twice(parts) };
}

// Upload rate between from and to (wall ms): mean, the busiest 10 s window and the largest request.
function uploadRate(log, from, to) {
  const inside = uploads(log).filter((l) => l.at >= from && l.at <= to);
  const total = inside.reduce((n, l) => n + l.bytes, 0);
  const windows = new Map();
  for (const l of inside) {
    const w = Math.floor((l.at - from) / 10000);
    windows.set(w, (windows.get(w) || 0) + l.bytes);
  }
  const count = Math.max(1, Math.ceil((to - from) / 10000));
  const perWindow = Array.from({ length: count }, (_, i) => windows.get(i) || 0);
  return {
    seconds: Math.round((to - from) / 1000),
    requests: inside.length,
    bytes: total,
    meanKiBs: +(total / 1024 / ((to - from) / 1000)).toFixed(1),
    maxKiBsPer10s: +(Math.max(...perWindow) / 1024 / 10).toFixed(1),
    largestRequest: inside.reduce((n, l) => Math.max(n, l.bytes), 0)
  };
}

// Settings > Storage, through the dev hooks as the page would.
const syncHook = (action, more = {}, ms) => hook('sync', { action, ...more }, ms);
const setting = (key, value) => hook('settings', { key, value });
const syncStatus = () => syncHook('status');

async function connectSync(endpoint, secret) {
  await setting('storage.sync.service', 'other');
  await setting('storage.sync.endpoint', endpoint);
  await setting('storage.sync.region', 'us-east-1');
  await setting('storage.sync.bucket', 'test');
  await setting('storage.sync.accessKeyId', 'test');
  await syncHook('secret', { secret });
  const tested = await syncHook('test');
  await setting('storage.sync.enabled', true);
  return tested;
}

// Settings > Storage in the real app, from WebView2, in both themes and languages: tmp\live-shots\voice-storage-
// <label>-<theme>-<language>.png. The page shows the fake's loopback address and nothing else of this computer.
async function captureStorage(label) {
  const was = (await hook('status')).settings;
  const ui = was.config?.ui || {};
  const shots = [];
  for (const [theme, language] of [['dark', 'en'], ['light', 'en'], ['dark', 'nl'], ['light', 'nl']]) {
    await setting('ui.theme', theme);
    await setting('ui.language', language);
    const dir = path.join(RUN, 'captures', `${label}-${theme}-${language}`);
    const out = await hook('capture', { dir, page: 'storage' }, 90000);
    const file = path.join(SHOTS, `voice-storage-${label}-${theme}-${language}.png`);
    if (!out.settings.error) fs.copyFileSync(out.settings.file, file);
    shots.push(out.settings.error ? { theme, language, error: out.settings.error } : { theme, language, file: path.basename(file) });
  }
  if (ui.theme) await setting('ui.theme', ui.theme);
  if (ui.language) await setting('ui.language', ui.language);
  check(`Voice captured Settings > Storage (${label}) in both themes and languages`, shots.every((s) => !s.error), shots);
}

// Waits until nothing waits to upload, the worker is idle and the index went up after the last manifest, so the
// bucket's index names every meeting.
async function drained(what, ms = 300000) {
  return until(`${what}: the queue to drain and the index to follow`, async () => {
    const s = await syncStatus();
    if (s.waiting !== 0 || !(s.state === 'idle' || s.state === 'live')) return false;
    const puts = s3Log().filter((l) => l.op === 'put' && l.status === 200);
    const last = (test) => puts.filter((l) => test(l.key)).reduce((n, l) => Math.max(n, l.at), 0);
    const manifest = last((k) => k.endsWith('/manifest'));
    return manifest > 0 && last((k) => k.includes('/index/')) > manifest && s;
  }, ms, 1000);
}

// Which files under dir (a folder or one file) hold one of the needles (strings). A file a running process holds
// open without sharing can't be read; it is listed in `locked`, and the scan after every process stopped reads it.
function holders(dir, needles, locked = []) {
  const found = [];
  const look = (full) => {
    let bytes;
    try {
      bytes = fs.readFileSync(full);
    } catch (err) {
      if (err.code === 'EBUSY' || err.code === 'EPERM') return locked.push(path.relative(RUN, full));
      throw err;
    }
    needles.forEach((n, i) => {
      if (n && bytes.includes(Buffer.from(n, 'utf8'))) found.push(`${path.relative(RUN, full)} holds needle ${i + 1}`);
    });
  };
  const visit = (d) => {
    for (const entry of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) visit(full);
      else look(full);
    }
  };
  if (fs.existsSync(dir) && fs.statSync(dir).isFile()) look(dir);
  else visit(dir);
  return found;
}

// ---------- audio ----------

// The samples of a 16-bit mono PCM WAV.
function pcm(buf) {
  let at = 12;
  while (at + 8 <= buf.length) {
    const id = buf.toString('latin1', at, at + 4);
    const size = buf.readUInt32LE(at + 4);
    if (id === 'data') {
      const end = Math.min(buf.length, at + 8 + size);
      const bytes = Buffer.from(buf.subarray(at + 8, end - ((end - at - 8) % 2)));
      return new Int16Array(bytes.buffer, bytes.byteOffset, bytes.length / 2);
    }
    at += 8 + size + (size % 2);
  }
  throw new Error('no data chunk in the WAV');
}

// RMS per 20 ms window (320 samples at 16 kHz).
function envelope(samples) {
  const out = [];
  for (let i = 0; i + 320 <= samples.length; i += 320) {
    let sum = 0;
    for (let j = i; j < i + 320; j++) sum += samples[j] * samples[j];
    out.push(Math.sqrt(sum / 320));
  }
  return out;
}

function pearson(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 10) return 0;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i];
    mb += b[i];
  }
  ma /= n;
  mb /= n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

// How well a fetched mix follows the two speech files played on a loop and summed: the best correlation of their
// loudness over time, within a second of lag either way (the recorder starts its file sources as it starts).
function matchesSpeech(wav, you, them) {
  const got = pcm(wav);
  const a = pcm(you);
  const b = pcm(them);
  const mix = new Int16Array(got.length + 16000);
  for (let i = 0; i < mix.length; i++) mix[i] = Math.max(-32768, Math.min(32767, a[i % a.length] + b[i % b.length]));
  const eg = envelope(got);
  const em = envelope(mix);
  let best = { r: -1, lagMs: 0 };
  for (let lag = -50; lag <= 50; lag++) {
    const x = lag >= 0 ? eg.slice(lag) : eg;
    const y = lag >= 0 ? em : em.slice(-lag);
    const r = pearson(x, y);
    if (r > best.r) best = { r: +r.toFixed(3), lagMs: lag * 20 };
  }
  return { seconds: +(got.length / 16000).toFixed(2), ...best };
}

// Fetches url: status, headers, the bytes, time to the first byte and the rate.
async function download(url, headers = {}) {
  const t0 = performance.now();
  const res = await fetch(url, { headers });
  const chunks = [];
  let firstMs = null;
  if (res.body) {
    for await (const chunk of res.body) {
      if (firstMs === null) firstMs = performance.now() - t0;
      chunks.push(Buffer.from(chunk));
    }
  }
  const ms = performance.now() - t0;
  const bytes = Buffer.concat(chunks);
  return {
    status: res.status,
    type: res.headers.get('content-type'),
    bytes,
    firstByteMs: firstMs === null ? null : Math.round(firstMs),
    totalMs: Math.round(ms),
    mbPerS: ms > 0 ? +((bytes.length / 1e6) / (ms / 1000)).toFixed(1) : null
  };
}

// ---------- Rukoo ----------

let app;
let win;

async function startRukoo() {
  // Port 47810 for the MCP server: an installed Rukoo listens on 47800.
  const agents = path.join(RUKOO_DATA, 'data', 'agents.json');
  fs.mkdirSync(path.dirname(agents), { recursive: true });
  if (!fs.existsSync(agents)) fs.writeFileSync(agents, JSON.stringify({ version: 1, mcp: { port: MCP_PORT, remote: false, remoteHost: '' } }));
  const env = { ...process.env, SEM_DATA_DIR: RUKOO_DATA, SEM_HIDDEN: '1', SEM_AGENT_FAKE: '1', RUKOO_VOICE_BRIDGE: BRIDGE };
  // Links die after 5 s, so the run sees one refused.
  if (SYNC) env.SEM_MEDIA_LINK_TTL_MS = String(LINK_TTL_MS);
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
  protectedWindows: () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.isContentProtected())),
  // get_meeting_media_link as Claude Code on this computer would call it, through the tool code MCP runs. A call from
  // inside Rukoo carries no MCP token, so the link isn't bound to one.
  mediaLink: (args) =>
    app.evaluate(async (_, a) => {
      const res = await global.__semAgents.callTool({ agent: 'claude', conversationId: null, remote: false, peer: '127.0.0.1' }, 'get_meeting_media_link', a);
      return res.isError ? { error: res.content[0].text } : res.structuredContent;
    }, args),
  linkTtl: (ms) =>
    app.evaluate((_, t) => {
      global.__semAgents.mediaLinks.ttlMs = t;
    }, ms)
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

  // Sync: the fake bucket, then Settings > Storage as a user fills it in. The secret and the recovery code stay in
  // memory.
  const sync = SECRETS;
  if (SYNC) {
    await startFakeS3();
    const off = await syncStatus();
    check('sync is off until it is turned on', off.state === 'off', { state: off.state });
    const refused = await setting('storage.sync.enabled', true).then(() => null, (err) => err.message);
    check('the switch stays off before Test connection passed', /test/i.test(refused || ''), refused);
    const tested = await connectSync(fake.endpoint, sync.secret);
    const on = await syncStatus();
    check('Test connection passed and sync is on', on.state !== 'off' && on.state !== 'failing', { tested, state: on.state });
    const shown = await syncHook('key');
    sync.code = shown.code;
    check('Voice shows a recovery code for its key', typeof sync.code === 'string' && sync.code.startsWith('RKV1-'), { id: shown.id });
  }

  // 2. A meeting started from Rukoo.
  const t0 = Date.now();
  const { meetingId: id } = await rukoo.start({ title: TITLE });
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

  // Sync while it records: audio goes up before the stop, and a 20 s bucket outage costs the recorder nothing.
  const outage = {};
  if (SYNC) {
    const audio = await until('audio objects in the bucket while it records', () => {
      const n = s3Objects().size;
      return n >= 3 && n; // meeting.json and a segment of each track
    }, 120000, 1000);
    check('audio objects reach the bucket before the stop', (await rukoo.state()).recording === id, { objects: audio, after: `${Math.round((Date.now() - t0) / 1000)} s` });

    // Stop the fake about 7 s before the next segment closes, so the worker tries to upload it while the bucket is
    // gone.
    const closes = () => {
      const ends = timeline(id).filter((l) => l.kind === 'segment_end' && l.track === 'mic').map((l) => l.t);
      return (ends.length ? Math.max(...ends) : 0) + SEGMENT_MS;
    };
    const nowT = () => timeline(id).filter((l) => l.kind === 'heartbeat').at(-1)?.t ?? 0;
    let target = closes();
    if (nowT() > target - 4000) target += SEGMENT_MS;
    await until('the moment before a segment closes', () => nowT() >= target - 7000, 40000, 200);
    outage.start = Date.now();
    await stopFakeS3();
    const seen = new Set();
    let maxWaiting = 0;
    while (Date.now() - outage.start < 20000) {
      const s = await syncStatus();
      seen.add(s.state);
      maxWaiting = Math.max(maxWaiting, s.waiting);
      await sleep(500);
    }
    // Same port and folder; a refused bind is retried for a few seconds.
    for (let tries = 1; ; tries++) {
      try {
        await startFakeS3(fake.port);
        break;
      } catch (err) {
        if (tries >= 10) throw err;
        await sleep(1000);
      }
    }
    outage.end = Date.now();
    // Recovered: an upload succeeded after the bucket came back, the worker no longer retries, and what waited during
    // the outage went up (at most the segment that closed since waits).
    const back = await until('sync to recover after the outage', async () => {
      const s = await syncStatus();
      seen.add(s.state);
      const up = uploads(s3Log()).filter((l) => l.at >= outage.end);
      return up.length >= Math.min(maxWaiting, 2) && s.state !== 'retrying' && s.state !== 'failing' && s.waiting <= 1 && { s, up };
    }, 180000, 500);
    const firstUp = back.up.reduce((n, l) => Math.min(n, l.at), Infinity);
    check('the outage shows as retrying, then sync recovers and the queue drains', seen.has('retrying') && back.s.waiting <= 1, {
      states: [...seen],
      maxWaiting,
      waitingAfter: back.s.waiting,
      uploadsAfter: back.up.length,
      firstUploadAfterMs: firstUp - outage.end,
      recoveredAfter: `${Math.round((Date.now() - outage.end) / 1000)} s`
    });
    // From just before the outage until sync recovered.
    const window = heartbeats(timeline(id), outage.start - 2000, Date.now());
    outage.heartbeats = window;
    check('heartbeats stay within 1,300 ms through the outage, with no gap marks', window.beats > 20 && window.maxGapMs <= 1300 && window.trouble.length === 0, window);
    await captureStorage('live');
  }

  // Captures while it records: Rukoo's meeting view, the pill and Settings > Rukoo.
  await win.keyboard.press('Control+3');
  await win.locator('.meeting .mt-transcript .mt-passage').first().waitFor({ timeout: 20000 });
  await sleep(1000);
  await captureRukoo(path.join(SHOTS, 'rukoo-meeting-live.png'));
  const shots = await hook('capture', { dir: SHOTS, page: 'rukoo' }, 90000);
  check('Voice captured its pill and Settings > Rukoo from WebView2', !shots.pill.error && !shots.settings.error, shots);

  // 4. Voice restarts mid-meeting; the recorder goes on and the new Voice reattaches. With sync, the kill lands
  // while the worker still has a segment to upload.
  if (SYNC) {
    const pending = await until('a segment waiting to upload', async () => {
      const s = await syncStatus();
      return s.waiting >= 1 && s;
    }, 60000, 250);
    note(`Voice killed with ${pending.waiting} file(s) waiting to upload, state ${pending.state}`);
  }
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
  const stopAt = Date.now();
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

  if (!SYNC) return;
  const ctx = { id, fromVoice, theirs, t0, stopAt, outage, sync, voice: () => voice, setVoice: (v) => (voice = v) };
  await bucketChecks(ctx);
  if (MEASURE === 'sync') await measureSync(ctx);
  await linkChecks(ctx);
  if (REMOTE_FETCH) await remoteFetch(ctx);
  await restoreChecks(ctx);
}

// ---------- after the meetings, with --sync ----------

const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const queueRows = (data, meeting) => readDb(path.join(data, 'sync', 'queue.db'), 'SELECT path, kind, size, object, state FROM files WHERE meeting = ? ORDER BY id', meeting);

// 6. Every file in the bucket, encrypted, once; neither the secret nor the code on disk in plain text.
async function bucketChecks(ctx) {
  const { id, sync } = ctx;
  const status = await drained('after both meetings');
  check('every file of both meetings reached the bucket and the index followed', status.waiting === 0, { state: status.state, lastError: status.lastError && status.lastError.code });
  await captureStorage('synced');

  const rows = await queueRows(VOICE_DATA, id);
  const byKind = {};
  for (const r of rows) byKind[`${r.kind}:${r.state}`] = (byKind[`${r.kind}:${r.state}`] || 0) + 1;
  const segments = [];
  for (const track of ['mic', 'call']) {
    const dir = path.join(VOICE_DATA, 'meetings', id, 'audio', track);
    for (const f of fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.endsWith('.wav')) : []) segments.push(`audio/${track}/${f}`);
  }
  const notUp = segments.filter((p) => !rows.some((r) => r.path === p && r.state === 'done'));
  check("each of the meeting's segments, meeting.json, its timeline and its transcript are in the bucket", notUp.length === 0 && ['meeting', 'timeline', 'transcript', 'manifest'].every((k) => byKind[`${k}:done`]), { segments: segments.length, notUp, rows: byKind });

  encrypted('every object in the bucket passes check-encrypted.mjs');

  const dup = duplicates(s3Log());
  check('the Voice restart left no file uploaded twice and no part twice', dup.putTwice.length === 0 && dup.partTwice.length === 0, dup);

  const cfg = JSON.parse(fs.readFileSync(path.join(VOICE_DATA, 'config.json'), 'utf8'));
  const stored = cfg.extra?.storage_sync || cfg.storage_sync || {};
  const magic = (f, m) => {
    try {
      return fs.readFileSync(path.join(VOICE_DATA, 'sync', f)).subarray(0, 4).toString('latin1') === m;
    } catch (_) {
      return false;
    }
  };
  const logs = fs.readdirSync(RUN).filter((f) => /^voice-\d+\.log$/.test(f));
  const locked = [];
  const needles = [sync.secret, sync.code];
  const leaks = [...holders(VOICE_DATA, needles, locked), ...holders(HOOKS, needles, locked), ...logs.flatMap((f) => holders(path.join(RUN, f), needles, locked))];
  check('the secret and the key are DPAPI files; neither is in plain text in the data folder or the logs', !('secret' in stored) && magic('bucket-secret.bin', 'RKVS') && magic('master-key.bin', 'RKVK') && leaks.length === 0, { leaks, configHasSecret: 'secret' in stored, lockedUntilTheEnd: locked });

  // M1 and M2 for the healthy and the failing bucket, from the run's own meeting.
  const lines = timeline(id);
  report.measurements.M1_mainMeetingBeforeOutage = uploadRate(s3Log(), ctx.t0, ctx.outage.start);
  report.measurements.M2 = {
    healthy: heartbeats(lines, ctx.t0, ctx.outage.start),
    failing: ctx.outage.heartbeats
  };
}

// check-encrypted.mjs on the fake's folder, with every meeting id, the title and words of the speech as text no
// object may hold; and no key shows a meeting id.
function encrypted(name) {
  const objects = s3Objects();
  const ids = fs.readdirSync(path.join(VOICE_DATA, 'meetings')).filter((n) => n.startsWith('m-'));
  const forbid = [...ids, TITLE, 'warehouse', 'Amsterdam'].flatMap((t) => ['--forbid', t]);
  const enc = spawnSync(process.execPath, [path.join(VOICE, 'scripts', 'check-encrypted.mjs'), S3_DIR, '--json', ...forbid], { encoding: 'utf8', windowsHide: true });
  let result = null;
  try {
    result = JSON.parse(enc.stdout);
  } catch (_) {
    result = { error: enc.stderr };
  }
  check(name, enc.status === 0 && objects.size > 0, { meetings: ids.length, objects: result.objects, bytes: result.bytes, failed: result.failed, error: result.error });
  check('no object key shows a meeting id', [...objects.keys()].every((k) => !k.includes('m-20')), { objects: objects.size });
}

// The spec's measurements: a 10-minute meeting with sync on, a 3-minute one with sync off, six short ones.
async function measureSync(ctx) {
  const pid = ctx.voice().pid;
  const record = async (seconds, label) => {
    const before = cpuIo(pid);
    const { meeting } = await hook('start_meeting');
    const start = Date.now();
    console.log(`     ${label}: ${meeting}, ${seconds} s`);
    await until(`${label} to record 3 minutes`, () => Date.now() - start >= 180000, 200000, 1000);
    const at3 = cpuIo(pid);
    await until(`${label} to record ${seconds} s`, () => Date.now() - start >= seconds * 1000, seconds * 1000 + 60000, 1000);
    const stop = Date.now();
    await hook('stop_meeting');
    await until(`${label} to be done`, async () => (await rukoo.get(meeting))?.meeting.state === 'done', 300000, 1000);
    return { meeting, start, stop, before, at3 };
  };

  const b = await record(600, 'meeting B, sync on');
  await drained('meeting B');
  const bEnd = cpuIo(pid);
  const c0 = Date.now();
  await setting('storage.sync.enabled', false);
  const c = await record(180, 'meeting C, sync off');
  const cEnd = cpuIo(pid);
  await setting('storage.sync.enabled', true);
  const shorts = [];
  for (let i = 0; i < 6; i++) {
    const { meeting } = await hook('start_meeting');
    await sleep(6000);
    await hook('stop_meeting');
    await until('a short meeting to be done', async () => (await rukoo.get(meeting))?.meeting.state === 'done', 120000, 500);
    shorts.push(meeting);
  }
  await drained('every meeting');
  encrypted("every object of the measurements' ten meetings passes check-encrypted.mjs");
  ctx.measured = { b: b.meeting, c: c.meeting, shorts };

  const m = report.measurements;
  m.M1 = uploadRate(s3Log(), b.start, b.stop);
  m.M2.syncOn10min = heartbeats(timeline(b.meeting));
  m.M2.syncOff3min = heartbeats(timeline(c.meeting));
  m.M3 = {
    syncOnFirst3min: usage(b.before, b.at3),
    syncOffFirst3min: usage(c.before, c.at3),
    syncOnWhole10minAndUpload: usage(b.before, bEnd),
    syncOffWhole3min: usage(c.before, cEnd),
    note: `meeting C started ${Math.round((c.start - c0) / 1000)} s after sync went off`
  };

  // M5 on this computer: a 10-minute audio link from local audio.
  await rukoo.linkTtl(300000);
  const t = performance.now();
  const link = await rukoo.mediaLink({ meeting_id: b.meeting, kind: 'audio', from_seconds: 0, to_seconds: 600 });
  const toolMs = Math.round(performance.now() - t);
  const got = link.error ? null : await download(link.url);
  await rukoo.linkTtl(LINK_TTL_MS);
  check('a 10-minute audio link downloads from local audio', got && got.status === 200 && got.bytes.length === 600 * 32000 + 44, { error: link.error, status: got?.status, bytes: got?.bytes.length });
  ctx.measured.bSha = got ? sha(got.bytes) : null;
  m.M5 = { local: { bytes: got?.bytes.length, toolCallMs: toolMs, firstByteMs: got?.firstByteMs, totalMs: got?.totalMs, mbPerS: got?.mbPerS } };

  // M7: what meeting B costs in the bucket against its plaintext.
  const rows = await queueRows(VOICE_DATA, b.meeting);
  const objects = s3Objects();
  let plain = 0;
  let stored = 0;
  let audioObjects = 0;
  const segmentSizes = new Set();
  const counted = new Set();
  // Newest row first: a manifest keeps its object name, so only its last generation counts.
  for (const r of rows.filter((x) => x.state === 'done').reverse()) {
    const keyed = [...objects.keys()].find((k) => k.endsWith(r.object));
    if (!keyed || counted.has(keyed)) continue;
    counted.add(keyed);
    plain += r.size;
    stored += objects.get(keyed);
    if (r.kind === 'audio') {
      audioObjects++;
      if (r.size === 960044) segmentSizes.add(objects.get(keyed));
    }
  }
  m.M7 = {
    meeting: '10 minutes, two tracks',
    files: counted.size,
    audioObjects,
    plaintextBytes: plain,
    bucketBytes: stored,
    overheadPercent: plain ? +(((stored - plain) / plain) * 100).toFixed(3) : null,
    fullSegmentObjectBytes: [...segmentSizes],
    perHourMB: +((stored / 1e6) * (3600 / ((b.stop - b.start) / 1000))).toFixed(1)
  };
}

// 7. An agent's link to the meeting's audio: the speech, a range, and refused once expired.
async function linkChecks(ctx) {
  const you = fs.readFileSync(path.join(RUN, 'you.wav'));
  const them = fs.readFileSync(path.join(RUN, 'them.wav'));
  const link = await rukoo.mediaLink({ meeting_id: ctx.id, kind: 'audio', from_seconds: 0, to_seconds: 20 });
  check('get_meeting_media_link gives a link on the local listener', !link.error && link.url.startsWith(`http://127.0.0.1:${MCP_PORT}/media/v1/`), {
    error: link.error,
    type: link.type,
    to: link.to_seconds,
    expiresIn: link.expires_in_seconds
  });
  if (link.error) return;
  const got = await download(link.url);
  const ranged = await download(link.url, { range: 'bytes=0-43' });
  const match = got.status === 200 ? matchesSpeech(got.bytes, you, them) : null;
  check("the link gives the meeting's speech, both tracks mixed", got.status === 200 && got.type === 'audio/wav' && Math.abs(match.seconds - 20) < 0.05 && match.r >= 0.9, { status: got.status, type: got.type, bytes: got.bytes.length, match });
  check('a Range request gives those bytes', ranged.status === 206 && ranged.bytes.equals(got.bytes.subarray(0, 44)), { status: ranged.status });
  await until('the link to expire', () => Date.now() > Date.parse(link.expires_at) + 1000, 15000, 200);
  const expired = await download(link.url);
  check('the same link is refused after it expired', expired.status === 410, { status: expired.status });
  ctx.localAudio = got.bytes;
}

// The link fetched from another machine on the tailnet, over ssh, read only: Rukoo's Tailscale listener opens for
// Clark with a throwaway key in this profile.
async function remoteFetch(ctx) {
  const target = REMOTE_FETCH;
  const key = crypto.randomBytes(24).toString('base64url');
  const token = crypto.createHmac('sha256', key).update('rukoo-mcp-v1').digest('base64url');
  await app.evaluate(async (_, k) => {
    const hub = global.__semAgents;
    hub.setSecret('clark', k);
    await hub.updateConfig({ mcp: { remote: true } });
  }, key);
  const at = await until('the Tailscale listener', () =>
    app.evaluate(() => {
      const hub = global.__semAgents;
      const port = hub.mcp && hub.mcp.ports().remote;
      return port ? { port, host: hub.cfg.address() } : null;
    }), 30000, 500);
  const meeting = ctx.measured ? ctx.measured.b : ctx.id;
  const to = ctx.measured ? 600 : 20;
  const want = ctx.measured ? ctx.measured.bSha : sha(ctx.localAudio);
  const ttl = 60000;
  await rukoo.linkTtl(ttl);
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_meeting_media_link', arguments: { meeting_id: meeting, kind: 'audio', from_seconds: 0, to_seconds: to } } });
  const ssh = (script) => spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', target, 'bash -s'], { input: script, encoding: 'utf8', windowsHide: true, timeout: 180000 });
  const first = ssh(
    [
      'set -u',
      `T='${token}'`,
      `B='${body}'`,
      `R=$(curl -s -m 60 -H "Authorization: Bearer $T" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' --data "$B" http://${at.host}:${at.port}/mcp)`,
      `U=$(printf '%s' "$R" | grep -o '"url":"[^"]*"' | head -1 | cut -d'"' -f4)`,
      'if [ -z "$U" ]; then echo "NOURL"; exit 0; fi',
      'F=$(mktemp)',
      'echo "URL $U"',
      `curl -s -m 120 -o "$F" -w 'GOT %{http_code} %{size_download} %{time_starttransfer} %{speed_download}\\n' "$U"`,
      'echo "SHA $(sha256sum "$F" | cut -d" " -f1)"',
      'rm -f "$F"'
    ].join('\n')
  );
  const out = String(first.stdout || '');
  const url = (/^URL (\S+)$/m.exec(out) || [])[1];
  const gotLine = (/^GOT (\d+) (\d+) ([\d.]+) ([\d.]+)$/m.exec(out) || []).slice(1);
  const remoteSha = (/^SHA ([0-9a-f]{64})$/m.exec(out) || [])[1];
  const issuedAt = Date.now();
  check('a machine on the tailnet gets a link from the tool and downloads the same audio', Boolean(url) && gotLine[0] === '200' && remoteSha === want, {
    ssh: first.status,
    status: gotLine[0],
    bytes: Number(gotLine[1]),
    sameAsLocal: remoteSha === want,
    stderr: first.status ? String(first.stderr || '').slice(0, 200) : undefined
  });
  report.measurements.M5 = report.measurements.M5 || {};
  report.measurements.M5.tailscale = { bytes: Number(gotLine[1]), firstByteMs: Math.round(Number(gotLine[2]) * 1000), mbPerS: +(Number(gotLine[3]) / 1e6).toFixed(1) };
  if (url) {
    const here = await download(url.replace(/^http:\/\/[^/]+/, `http://${at.host}:${at.port}`));
    check("the link is refused from another address on the tailnet (this computer's)", here.status === 403, { status: here.status });
    await until('the remote link to expire', () => Date.now() > issuedAt + ttl + 2000, ttl + 30000, 500);
    const again = ssh(`curl -s -m 30 -o /dev/null -w '%{http_code}' '${url}'`);
    check('the remote link is refused once expired', String(again.stdout).trim() === '410', { status: String(again.stdout).trim() });
  }
  await app.evaluate(async () => {
    const hub = global.__semAgents;
    await hub.updateConfig({ mcp: { remote: false } });
    hub.setSecret('clark', '');
  });
  await rukoo.linkTtl(LINK_TTL_MS);
}

// 8. A second Voice on a fresh data folder: the code, the bucket, a restore, and the media back from the bucket.
async function restoreChecks(ctx) {
  const { id, sync } = ctx;
  await drained('before the restore');
  const old = ctx.voice();
  killPid(old.pid);
  await until('Voice to exit', () => !alive(old.pid), 15000);
  const meetings = fs.readdirSync(path.join(VOICE_DATA, 'meetings')).filter((n) => n.startsWith('m-'));
  const v = startVoice(3, VOICE_DATA_2);
  ctx.setVoice(v);
  await until('the second Voice', async () => {
    try {
      return (await hook('status', {}, 5000)).pid === v.pid;
    } catch (_) {
      return false;
    }
  }, 60000, 1000);
  const imported = await syncHook('import', { code: sync.code });
  await connectSync(fake.endpoint, sync.secret);
  const list = await syncHook('restore_list');
  check('the second Voice lists every meeting in the bucket', list.meetings.length === meetings.length, { listed: list.meetings.length, meetings: meetings.length, key: imported && imported.id });
  const r0 = Date.now();
  await syncHook('restore_start');
  const done = await until('the restore', async () => {
    const s = await syncStatus();
    return ['done', 'failed'].includes(s.restore.state) && s;
  }, 600000, 250);
  const restoreMs = Date.now() - r0;
  check('the restore finished', done.restore.state === 'done', done.restore);
  report.measurements.M6 = { meetings: list.meetings.length, seconds: +(restoreMs / 1000).toFixed(1), fromBucket: 'voice-s3-fake on this computer' };

  await until('Rukoo to connect to the second Voice', async () => (await rukoo.connected()) && (await rukoo.state()).voiceVersion, 60000);
  const theirs = await until('the restored meeting through the bridge', async () => {
    try {
      const m = await rukoo.voiceGet(id);
      return m && m.passages.length >= ctx.theirs.passages.length && m;
    } catch (_) {
      return false;
    }
  }, 120000, 1000);
  const key = (p) => `${p.id}@${p.revision}`;
  const sameSet = (a, b) => a.length === b.length && a.every((p) => b.some((q) => key(q) === key(p)));
  check('the restored meeting reaches Rukoo with every passage the first Voice had', sameSet(theirs.passages, ctx.theirs.passages), { first: ctx.theirs.passages.length, restored: theirs.passages.length });
  const mine = await rukoo.get(id);
  check("Rukoo's meeting.get still has every passage once", sameSet(mine.passages, ctx.theirs.passages), { rukoo: mine.passages.length });
  const same = (f) => {
    try {
      return fs.readFileSync(path.join(VOICE_DATA, 'meetings', id, f)).equals(fs.readFileSync(path.join(VOICE_DATA_2, 'meetings', id, f)));
    } catch (_) {
      return false;
    }
  };
  const localAudio = fs.existsSync(path.join(VOICE_DATA_2, 'meetings', id, 'audio'));
  check('meeting.json and the timeline come back byte for byte; audio stays in the bucket until needed', same('meeting.json') && same('timeline.jsonl') && !localAudio, { localAudio });

  // The same audio link, now served from the bucket.
  if (ctx.localAudio) {
    const t = performance.now();
    const link = await rukoo.mediaLink({ meeting_id: id, kind: 'audio', from_seconds: 0, to_seconds: 20 });
    const toolMs = Math.round(performance.now() - t);
    const got = link.error ? null : await download(link.url);
    check("the restored meeting's audio comes back from the bucket, byte for byte", got && got.status === 200 && got.bytes.equals(ctx.localAudio), { error: link.error, status: got?.status, toolMs, firstByteMs: got?.firstByteMs });
  }
  if (ctx.measured) {
    await rukoo.linkTtl(300000);
    const t = performance.now();
    const link = await rukoo.mediaLink({ meeting_id: ctx.measured.b, kind: 'audio', from_seconds: 0, to_seconds: 600 });
    const toolMs = Math.round(performance.now() - t);
    const got = link.error ? null : await download(link.url);
    await rukoo.linkTtl(LINK_TTL_MS);
    check('the 10-minute link from the bucket gives the same bytes as from local audio', got && got.status === 200 && sha(got.bytes) === ctx.measured.bSha, { error: link.error, status: got?.status });
    report.measurements.M5.bucket = { bytes: got?.bytes.length, toolCallMs: toolMs, firstByteMs: got?.firstByteMs, totalMs: got?.totalMs, mbPerS: got?.mbPerS };
  }
  const locked = [];
  const leaks = holders(VOICE_DATA_2, [sync.secret, sync.code], locked);
  check("the second Voice's data folder holds neither the secret nor the code in plain text", leaks.length === 0, { leaks, lockedUntilTheEnd: locked });
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
  for (const pid of started.fake) if (alive(pid)) killPid(pid);
  // A recorder still recording after a failure: by the id in its recorder.json.
  const meetings = path.join(VOICE_DATA, 'meetings');
  for (const id of fs.existsSync(meetings) ? fs.readdirSync(meetings) : []) {
    const r = recorderOf(id);
    if (r && alive(r.pid)) {
      killPid(r.pid);
      note(`stopped a recorder that was still running: ${r.pid}`);
    }
  }
  report.leftRunning = [...started.voice, started.rukoo, ...started.fake].filter((pid) => pid && alive(pid));
}

let error = null;
try {
  await main();
} catch (err) {
  error = err;
  check('the run finished', false, err.message);
} finally {
  await cleanup();
  // With every process stopped, nothing holds a file open: the whole run folder, both data folders, the hooks, the
  // logs and the bucket's objects, for the secret and the code.
  if (SYNC && SECRETS.code) {
    try {
      const locked = [];
      const leaks = holders(RUN, [SECRETS.secret, SECRETS.code], locked);
      check('after every process stopped, no file of the run holds the secret or the recovery code', leaks.length === 0 && locked.length === 0, { leaks, locked });
    } catch (err) {
      check('after every process stopped, no file of the run holds the secret or the recovery code', false, err.message);
    }
  }
  report.finished = new Date().toISOString();
  report.failed = failed;
  fs.writeFileSync(path.join(RUN, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`\n${failed ? `${failed} check(s) failed` : 'every check passed'}; report: ${path.join(RUN, 'report.json')}`);
  if (error) console.error(error);
  process.exit(failed ? 1 : 0);
}
