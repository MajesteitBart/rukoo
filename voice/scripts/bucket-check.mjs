// The by-hand check of bucket sync against a real S3 bucket (spec-RUK-110 section 6.4, item 1): Test connection,
// how the provider's answers to a wrong secret and a missing bucket map to Settings' reasons, a multipart upload with
// ListParts, a meeting that syncs while it records, a Voice killed with files waiting and started again, every raw
// object downloaded and run through check-encrypted.mjs, a restore into a fresh data folder with the recovery code,
// and the meeting's audio fetched back from the bucket through the bridge. Run it only against a throwaway bucket.
//
//   node voice/scripts/bucket-check.mjs [--minutes=3]
//
// Windows only, on a development build (CARGO_TARGET_DIR\debug: rukoo-voice, its recorder and local worker, and
// voice-sync's `bucket` example). The bucket comes from RUKOO_VOICE_SYNC_TEST_ENDPOINT, _REGION, _BUCKET,
// _ACCESS_KEY_ID and _SECRET_ACCESS_KEY, and the service from _SERVICE (upcloud, r2 or other; default upcloud). The
// script never prints them: they reach the development Voice only through its Settings commands, as a user types
// them, and every message is redacted before it is shown or written. Each run uses a folder (prefix) of its own,
// rukoo-voice-check-<random>, and empties it at the end.
//
// Everything else lives in tmp\bucket-check\<time>\: two Voice data folders (RUKOO_VOICE_DATA_DIR), their discovery
// files (RUKOO_VOICE_BRIDGE), the dev hooks, synthetic SAPI speech as both tracks, and the downloaded objects. At the
// end the script stops what it started by process id, empties the bucket folder, checks that no file of the run holds
// the secret or the recovery code, and deletes the run folder except report.json, which names no bucket detail.

import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

const ARGS = process.argv.slice(2);
for (const arg of ARGS) {
  if (!/^--minutes=\d+(\.\d+)?$/.test(arg)) {
    console.error(`unknown argument ${arg}`);
    process.exit(2);
  }
}
const MINUTES = Number((ARGS.find((a) => a.startsWith('--minutes=')) || '--minutes=3').slice('--minutes='.length));

const ENV_KEYS = ['ENDPOINT', 'REGION', 'BUCKET', 'ACCESS_KEY_ID', 'SECRET_ACCESS_KEY'];
const BUCKET = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[`RUKOO_VOICE_SYNC_TEST_${k}`] || '']));
const SERVICE = process.env.RUKOO_VOICE_SYNC_TEST_SERVICE || 'upcloud';
const missing = ENV_KEYS.filter((k) => !BUCKET[k]);
if (missing.length) {
  console.error(`set ${missing.map((k) => `RUKOO_VOICE_SYNC_TEST_${k}`).join(', ')}`);
  process.exit(2);
}
const PREFIX = `rukoo-voice-check-${crypto.randomBytes(6).toString('hex')}`;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const VOICE = path.join(ROOT, 'voice');
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const RUN = path.join(ROOT, 'tmp', 'bucket-check', STAMP);
const TARGET = process.env.CARGO_TARGET_DIR ? path.resolve(process.env.CARGO_TARGET_DIR) : path.join(VOICE, 'target');
const EXE = path.join(TARGET, 'debug', 'rukoo-voice.exe');
const BUCKET_EXE = path.join(TARGET, 'debug', 'examples', 'bucket.exe');
const TITLE = 'Bucket check';
const SEGMENT_MS = 30000;

const YOU = [
  'Good morning everyone, thanks for joining the launch review.',
  'The budget for the Thursday launch is approved.',
  'Please send the slides to Maria before Friday.'
];
const THEM = ['Thanks, the invoice from Amsterdam arrived yesterday.', 'The deadline for the warehouse contract is next Tuesday.'];

// The recovery code Voice shows: in memory only.
const SECRETS = { code: null };

// Every bucket detail, as it could appear in a message: the values, and the endpoint's host on its own.
const SENSITIVE = (() => {
  const values = [BUCKET.SECRET_ACCESS_KEY, BUCKET.ACCESS_KEY_ID, BUCKET.ENDPOINT, BUCKET.BUCKET];
  try {
    values.push(new URL(BUCKET.ENDPOINT).host, new URL(BUCKET.ENDPOINT).hostname);
  } catch (_) {
    // A broken endpoint fails Test connection; nothing else to hide.
  }
  return values.filter((v) => v && v.length >= 3).sort((a, b) => b.length - a.length);
})();
function redact(text) {
  let out = String(text);
  for (const value of [...SENSITIVE, SECRETS.code].filter(Boolean)) out = out.split(value).join('<hidden>');
  return out;
}

const report = { started: new Date().toISOString(), service: SERVICE, minutes: MINUTES, checks: [], notes: [], measurements: {} };
const started = { voice: [] };
let failed = 0;

function check(name, ok, detail = null) {
  const safe = detail === null ? null : JSON.parse(redact(JSON.stringify(detail)));
  report.checks.push({ name, ok: Boolean(ok), detail: safe });
  if (!ok) failed += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${safe ? `: ${typeof safe === 'string' ? safe : JSON.stringify(safe)}` : ''}`);
  return ok;
}

function note(text) {
  report.notes.push(redact(text));
  console.log(`     ${redact(text)}`);
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

// SAPI speech as 16 kHz mono 16-bit WAV, with a pause after every sentence.
function speech(file, parts, lead = 0) {
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
}

// ---------- the two development Voices ----------

// Voice never sees the test variables: the bucket reaches it through Settings only.
function cleanEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('RUKOO_VOICE_SYNC_TEST_')) delete env[key];
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.RUKOO_VOICE_LOCAL_EXE;
  return env;
}

function voiceAt(name) {
  const dir = path.join(RUN, name);
  return { name, data: path.join(dir, 'data'), hooks: path.join(dir, 'hooks'), bridge: path.join(dir, 'bridge', 'voice-bridge.json'), child: null, hookId: 0, runs: 0 };
}

function startVoice(v) {
  fs.mkdirSync(path.dirname(v.bridge), { recursive: true });
  const env = {
    ...cleanEnv(),
    RUKOO_VOICE_DATA_DIR: v.data,
    RUKOO_VOICE_BRIDGE: v.bridge,
    RUKOO_VOICE_TEST_SOURCES: `mic=file:${path.join(RUN, 'you.wav')},loop,call=file:${path.join(RUN, 'them.wav')},loop`
  };
  v.runs += 1;
  const log = fs.openSync(path.join(RUN, `${v.name}-${v.runs}.log`), 'a');
  v.child = spawn(EXE, ['--dev-hooks', v.hooks], { cwd: VOICE, env, stdio: ['ignore', log, log], windowsHide: true });
  started.voice.push(v.child.pid);
  console.log(`started ${v.name} (run ${v.runs}), pid ${v.child.pid}`);
}

async function hook(v, cmd, args = {}, ms = 60000) {
  const id = ++v.hookId;
  fs.mkdirSync(v.hooks, { recursive: true });
  const tmp = path.join(v.hooks, `request-${id}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify({ id, cmd, ...args }));
  fs.renameSync(tmp, path.join(v.hooks, 'request.json'));
  const reply = path.join(v.hooks, `reply-${id}.json`);
  await until(`${v.name}'s answer to ${cmd}`, () => fs.existsSync(reply), ms, 100);
  const answer = JSON.parse(fs.readFileSync(reply, 'utf8'));
  // A reply can hold the recovery code; it stays in memory only.
  fs.rmSync(reply, { force: true });
  if (!answer.ok) throw new Error(`${cmd}: ${redact(answer.error)}`);
  return answer.result;
}

const syncHook = (v, action, more = {}, ms) => hook(v, 'sync', { action, ...more }, ms);
const setting = (v, key, value) => hook(v, 'settings', { key, value });
const syncStatus = (v) => syncHook(v, 'status');

async function ready(v) {
  await until(`${v.name} to answer`, async () => {
    try {
      return (await hook(v, 'status', {}, 5000)).pid === v.child.pid;
    } catch (_) {
      return false;
    }
  }, 90000, 1000);
}

// Settings > Storage as a user fills it in: the fields, the secret, Test connection, then the switch.
async function connect(v) {
  await setting(v, 'storage.sync.service', SERVICE);
  await setting(v, 'storage.sync.endpoint', BUCKET.ENDPOINT);
  await setting(v, 'storage.sync.region', BUCKET.REGION);
  await setting(v, 'storage.sync.bucket', BUCKET.BUCKET);
  await setting(v, 'storage.sync.prefix', PREFIX);
  await setting(v, 'storage.sync.accessKeyId', BUCKET.ACCESS_KEY_ID);
  await syncHook(v, 'secret', { secret: BUCKET.SECRET_ACCESS_KEY });
  const t = Date.now();
  const tested = await syncHook(v, 'test', {}, 180000);
  const ms = Date.now() - t;
  await setting(v, 'storage.sync.enabled', true);
  return { tested, ms };
}

function syncConfig(v) {
  const cfg = JSON.parse(fs.readFileSync(path.join(v.data, 'config.json'), 'utf8'));
  return cfg.extra?.storage_sync || cfg.storage_sync || {};
}

function timeline(v, id) {
  try {
    return fs
      .readFileSync(path.join(v.data, 'meetings', id, 'timeline.jsonl'), 'utf8')
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

function recorderOf(v, id) {
  try {
    return JSON.parse(fs.readFileSync(path.join(v.data, 'meetings', id, 'recorder.json'), 'utf8'));
  } catch (_) {
    return null;
  }
}

async function readDb(file, query, ...params) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare(query).all(...params);
  } finally {
    db.close();
  }
}

const states = async (v, id) =>
  (await readDb(path.join(v.data, 'bridge.db'), "SELECT data FROM events WHERE event = 'meeting.state' AND meeting = ? ORDER BY seq", id)).map((row) => JSON.parse(row.data).state);

// Nothing waits to upload and the worker is idle, which counts the manifests and the index too.
async function drained(v, what, ms = 600000) {
  return until(`${what}: the queue to drain`, async () => {
    const s = await syncStatus(v);
    if (s.state === 'failing' || s.state === 'key') throw new Error(`sync is ${s.state}: ${s.lastError ? s.lastError.code : 'no error'}`);
    return s.waiting === 0 && s.state === 'idle' && s;
  }, ms, 2000);
}

// ---------- the bucket, through voice-sync's own client ----------

function bucketSpawn(urlStyle, args, overrides = {}) {
  const env = { ...process.env, RUKOO_VOICE_SYNC_TEST_PREFIX: PREFIX, RUKOO_VOICE_SYNC_TEST_URL_STYLE: urlStyle };
  for (const [k, v] of Object.entries(overrides)) env[`RUKOO_VOICE_SYNC_TEST_${k}`] = v;
  return spawnSync(BUCKET_EXE, args, { env, encoding: 'utf8', windowsHide: true, timeout: 600000 });
}

function bucketRun(urlStyle, ...args) {
  const out = bucketSpawn(urlStyle, args);
  if (out.status !== 0) throw new Error(`bucket ${args[0]}: ${redact(out.stderr || out.error || out.status)}`);
  return JSON.parse(out.stdout);
}

// The code Settings would show for a probe with these settings changed, or "ok".
function probeCode(urlStyle, overrides) {
  const out = bucketSpawn(urlStyle, ['probe'], overrides);
  if (out.status === 0) return 'ok';
  const m = /failed \(([a-z_]+)\)/.exec(out.stderr || '');
  return m ? m[1] : `exit ${out.status}`;
}

// ---------- media through the bridge, as Rukoo asks for it ----------

async function bridgeTo(v) {
  const { VoiceBridge } = require(path.join(ROOT, 'src', 'main', 'voice', 'bridge.js'));
  const bridge = new VoiceBridge({ file: v.bridge, clientVersion: '0.0.0-bucket-check', backoffMs: [200], pollMs: 200, heartbeatMs: 0, commandTimeoutMs: 30000 });
  bridge.start();
  await until(`the bridge to ${v.name}`, () => bridge.connected, 60000, 200);
  return bridge;
}

// media.open until ready, then every byte with media.read.
async function mediaBytes(bridge, args, ms = 300000) {
  const t = Date.now();
  const ready = await until('the media to be ready', async () => {
    const out = await bridge.command('media.open', args);
    return out.ready === true && out;
  }, ms, 500);
  const readyMs = Date.now() - t;
  const parts = [];
  for (let offset = 0; offset < ready.size; ) {
    const piece = await bridge.command('media.read', { media: ready.media, offset, length: 1 << 20 });
    const bytes = Buffer.from(piece.data, 'base64');
    if (!bytes.length) throw new Error('media.read gave nothing');
    parts.push(bytes);
    offset += bytes.length;
  }
  return { bytes: Buffer.concat(parts), readyMs, totalMs: Date.now() - t };
}

// Which files under dir hold one of the needles. Names the file and the needle's number, never the needle.
function holders(dir, needles) {
  const found = [];
  const visit = (d) => {
    for (const entry of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) visit(full);
      else {
        const bytes = fs.readFileSync(full);
        needles.forEach((n, i) => {
          if (n && bytes.includes(Buffer.from(n, 'utf8'))) found.push(`${path.relative(RUN, full)} holds needle ${i + 1}`);
        });
      }
    }
  };
  visit(dir);
  return found;
}

const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

// ---------- the run ----------

const A = voiceAt('voice-a');
const B = voiceAt('voice-b');
let urlStyle = null;
let bridges = [];

async function main() {
  if (process.platform !== 'win32') throw new Error('The check needs Windows: Voice records there only.');
  for (const exe of [EXE, BUCKET_EXE]) if (!fs.existsSync(exe)) throw new Error(`${exe} is missing; build voice-app, voice-recorder, voice-local and voice-sync's bucket example first`);
  fs.mkdirSync(RUN, { recursive: true });
  speech(path.join(RUN, 'you.wav'), YOU);
  speech(path.join(RUN, 'them.wav'), THEM, 1500);

  // 1. Test connection, then the switch.
  startVoice(A);
  await ready(A);
  const off = await syncStatus(A);
  check('sync is off in a fresh data folder', off.state === 'off', { state: off.state });
  const { tested, ms: testMs } = await connect(A);
  urlStyle = syncConfig(A).urlStyle || 'path';
  report.urlStyle = urlStyle;
  report.measurements.testConnectionMs = testMs;
  const on = await syncStatus(A);
  check('Test connection passed against the real bucket and sync is on', on.state !== 'off' && on.state !== 'paused' && on.state !== 'failing', { state: on.state, urlStyle, otherKeys: tested.otherKeys, testMs });
  const shown = await syncHook(A, 'key');
  SECRETS.code = shown.code;
  check('Voice shows a recovery code for its key', typeof SECRETS.code === 'string' && SECRETS.code.startsWith('RKV1-'), { id: shown.id });

  // The provider's error answers, as Test connection reports them: a wrong secret and a bucket that isn't there.
  const wrongSecret = probeCode(urlStyle, { SECRET_ACCESS_KEY: `${BUCKET.SECRET_ACCESS_KEY}x` });
  const noBucket = probeCode(urlStyle, { BUCKET: `rukoo-voice-missing-${crypto.randomBytes(6).toString('hex')}` });
  report.errorCodes = { wrongSecret, noBucket };
  check('a wrong secret shows as auth and a missing bucket as bucket', wrongSecret === 'auth' && noBucket === 'bucket', { wrongSecret, noBucket });

  // A multipart upload: three parts, ListParts, complete, read back. No file of a 3-minute meeting is large enough.
  const multi = bucketRun(urlStyle, 'multipart');
  report.measurements.multipart = multi;
  check('a 20 MiB multipart upload goes up in three parts that ListParts lists, and reads back the same', multi.parts === 3 && multi.listedMatch && multi.same && multi.size === 20971520 && JSON.stringify(multi.listedSizes) === JSON.stringify([8388608, 8388608, 4194304]), multi);

  // 2. A meeting: audio objects reach the bucket while it records.
  const t0 = Date.now();
  const id = (await hook(A, 'start_meeting')).meeting;
  report.meeting = 'started';
  const firstObjects = await until('objects in the bucket while it records', () => {
    const listed = bucketRun(urlStyle, 'list');
    return listed.objects >= 3 && listed;
  }, 180000, 5000);
  const recording = timeline(A, id).every((l) => l.kind !== 'stop');
  check('audio objects reach the bucket while the meeting records', recording, { objects: firstObjects.objects, after: `${Math.round((Date.now() - t0) / 1000)} s` });

  // 3. Voice killed with a file waiting, then started again: the recorder goes on and the queue resumes.
  const pending = await until('a file waiting to upload', async () => {
    const s = await syncStatus(A);
    return s.waiting >= 1 && s;
  }, 120000, 250);
  const recorder = recorderOf(A, id);
  killPid(A.child.pid);
  await until('Voice to exit', () => !alive(A.child.pid), 15000);
  note(`Voice killed with ${pending.waiting} file(s) waiting to upload, state ${pending.state}`);
  await sleep(1500);
  check('the recorder outlives Voice', recorder && alive(recorder.pid), recorder && { pid: recorder.pid });
  startVoice(A);
  await ready(A);
  const reattached = await until('the reattached meeting', async () => {
    const s = await hook(A, 'status');
    return s.tray.meeting === 'recording' && s;
  }, 60000, 500);
  check('the new Voice reattached to the running recorder', recorderOf(A, id)?.pid === recorder.pid && Boolean(reattached));

  // 4. The stop after the meeting's minutes, then done, and every file in the bucket.
  await until('the meeting to reach its length', () => Date.now() - t0 >= MINUTES * 60000, MINUTES * 60000 + 60000, 1000);
  await hook(A, 'stop_meeting');
  await until('done', async () => (await states(A, id)).at(-1) === 'done', 600000, 1000);
  const t1 = Date.now();
  const status = await drained(A, 'after the meeting');
  check('every file reached the bucket after done, the index too', status.waiting === 0, { state: status.state, afterDoneS: Math.round((Date.now() - t1) / 1000) });
  const rows = await readDb(path.join(A.data, 'sync', 'queue.db'), 'SELECT path, kind, state FROM files WHERE meeting = ? ORDER BY id', id);
  const byKind = {};
  for (const r of rows) byKind[`${r.kind}:${r.state}`] = (byKind[`${r.kind}:${r.state}`] || 0) + 1;
  const segments = [];
  for (const track of ['mic', 'call']) {
    const dir = path.join(A.data, 'meetings', id, 'audio', track);
    for (const f of fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.endsWith('.wav')) : []) segments.push(`audio/${track}/${f}`);
  }
  const notUp = segments.filter((p) => !rows.some((r) => r.path === p && r.state === 'done'));
  check("each segment, meeting.json, the timeline and the transcript are in the bucket", segments.length > 0 && notUp.length === 0 && ['meeting', 'timeline', 'transcript', 'manifest'].every((k) => byKind[`${k}:done`]), { segments: segments.length, notUp, rows: byKind });
  report.measurements.bucket = bucketRun(urlStyle, 'list');

  // 5. Every raw object, downloaded and checked for anything the provider could read.
  const objects = path.join(RUN, 'objects');
  const dumped = bucketRun(urlStyle, 'dump', objects);
  const forbid = [id, TITLE, 'warehouse', 'Amsterdam'].flatMap((t) => ['--forbid', t]);
  const enc = spawnSync(process.execPath, [path.join(VOICE, 'scripts', 'check-encrypted.mjs'), objects, '--json', ...forbid], { encoding: 'utf8', windowsHide: true });
  let result;
  try {
    result = JSON.parse(enc.stdout);
  } catch (_) {
    result = { error: redact(enc.stderr) };
  }
  check('every raw object from the real bucket passes check-encrypted.mjs', enc.status === 0 && dumped.objects > 0, { objects: result.objects, bytes: result.bytes, failed: result.failed, error: result.error });
  const leaks = holders(objects, [...SENSITIVE, SECRETS.code]);
  check('no object holds the secret, the access key, the bucket, the endpoint or the recovery code', leaks.length === 0, { leaks });

  // 6. The audio as Voice mixes it from its own copy, for the comparison after the restore.
  const bridgeA = await bridgeTo(A);
  bridges.push(bridgeA);
  const args = { meeting: id, kind: 'audio', start: 0, end: 20000 };
  const local = await mediaBytes(bridgeA, args);
  bridgeA.close();
  killPid(A.child.pid);
  await until('Voice A to exit', () => !alive(A.child.pid), 15000);

  // 7. A fresh data folder with the code: the meeting's text comes back, and its audio from the bucket on demand.
  startVoice(B);
  await ready(B);
  const imported = await syncHook(B, 'import', { code: SECRETS.code });
  await connect(B);
  const list = await syncHook(B, 'restore_list', {}, 180000);
  check('the second Voice lists the meeting in the bucket', list.meetings.some((m) => m.id === id), { listed: list.meetings.length, key: imported && imported.id });
  const r0 = Date.now();
  await syncHook(B, 'restore_start');
  const done = await until('the restore', async () => {
    const s = await syncStatus(B);
    return ['done', 'failed'].includes(s.restore.state) && s;
  }, 600000, 500);
  report.measurements.M6 = { meetings: list.meetings.length, seconds: +((Date.now() - r0) / 1000).toFixed(1) };
  check('the restore finished', done.restore.state === 'done', done.restore);
  const same = (f) => {
    try {
      return fs.readFileSync(path.join(A.data, 'meetings', id, f)).equals(fs.readFileSync(path.join(B.data, 'meetings', id, f)));
    } catch (_) {
      return false;
    }
  };
  const restoredAudio = fs.existsSync(path.join(B.data, 'meetings', id, 'audio'));
  check('meeting.json and the timeline come back byte for byte; audio stays in the bucket until needed', same('meeting.json') && same('timeline.jsonl') && !restoredAudio, { restoredAudio });
  const bridgeB = await bridgeTo(B);
  bridges.push(bridgeB);
  const fetched = await mediaBytes(bridgeB, args);
  report.measurements.audioFromBucket = { bytes: fetched.bytes.length, readyMs: fetched.readyMs, totalMs: fetched.totalMs };
  check("the meeting's audio comes back from the real bucket byte for byte", fetched.bytes.equals(local.bytes), { bytes: fetched.bytes.length, sha256Matches: sha(fetched.bytes) === sha(local.bytes), readyMs: fetched.readyMs });
  bridgeB.close();
}

async function cleanup() {
  for (const b of bridges) {
    try {
      b.close();
    } catch (_) {
      // Closed already.
    }
  }
  for (const pid of started.voice) if (alive(pid)) killPid(pid);
  for (const v of [A, B]) {
    const meetings = path.join(v.data, 'meetings');
    for (const id of fs.existsSync(meetings) ? fs.readdirSync(meetings) : []) {
      const r = recorderOf(v, id);
      if (r && alive(r.pid)) {
        killPid(r.pid);
        note(`stopped a recorder that was still running: ${r.pid}`);
      }
    }
  }
  await sleep(2000);
  report.leftRunning = started.voice.filter((pid) => alive(pid));
  // The run's bucket folder: emptied with the style Test connection chose, or both when it never passed.
  for (const style of urlStyle ? [urlStyle] : ['path', 'virtual']) {
    try {
      const emptied = bucketRun(style, 'empty');
      const left = bucketRun(style, 'list');
      check('the run emptied its folder in the bucket', left.objects === 0, { deleted: emptied.deleted, failed: emptied.failed, left: left.objects });
      break;
    } catch (err) {
      note(`emptying the bucket folder with the ${style} style failed: ${err.message}`);
    }
  }
}

let error = null;
try {
  await main();
} catch (err) {
  error = err;
  check('the run finished', false, redact(err.message));
} finally {
  await cleanup();
  // With every process stopped: no file of the run holds the secret or the code, then the run folder goes.
  try {
    const leaks = holders(RUN, [BUCKET.SECRET_ACCESS_KEY, SECRETS.code]);
    check('after every process stopped, no file of the run holds the secret or the recovery code', leaks.length === 0, { leaks });
  } catch (err) {
    check('after every process stopped, no file of the run holds the secret or the recovery code', false, redact(err.message));
  }
  const logs = fs.existsSync(RUN) ? fs.readdirSync(RUN).filter((f) => f.endsWith('.log')) : [];
  const named = logs.filter((f) => SENSITIVE.some((s) => fs.readFileSync(path.join(RUN, f), 'utf8').includes(s)));
  if (named.length) note(`${named.length} Voice log(s) named a bucket detail; they go with the run folder`);
  for (const entry of fs.existsSync(RUN) ? fs.readdirSync(RUN) : []) {
    try {
      fs.rmSync(path.join(RUN, entry), { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    } catch (err) {
      check(`the run folder's ${entry} is deleted`, false, redact(err.message));
    }
  }
  report.finished = new Date().toISOString();
  report.failed = failed;
  fs.mkdirSync(RUN, { recursive: true });
  fs.writeFileSync(path.join(RUN, 'report.json'), redact(JSON.stringify(report, null, 2)));
  console.log(`\n${failed ? `${failed} check(s) failed` : 'every check passed'}; report: ${path.join(RUN, 'report.json')}`);
  if (error) console.error(redact(error.stack || error.message));
  process.exit(failed ? 1 : 0);
}
