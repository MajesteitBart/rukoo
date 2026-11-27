'use strict';

// One team chat agent's runner (integrations/agent-runner, the same program its README describes) in a process of
// its own, which agent-runs.js starts for "Run on this computer". In Electron it is a utility process; plain Node (the
// unit tests) forks one.
//
// Everything comes in the first message, { type: 'start', config, key, backendKey }: the runner's config as main built
// it from what the person approved, the agent's key and the backend's own secret, such as a Hermes API key. They stay
// in this process's memory: never in its environment, which other programs of the same user can read, and never on
// disk. The runner keeps both out of every program it starts. { type: 'stop' } stops the runner: it ends a turn in
// flight, bounded (runner.js STOP_GRACE), and exits; a second SIGTERM ends it at once. { type: 'wake', seq } asks for a
// pass now, as after the computer slept, and is answered with the report { type: 'woke', seq } once that pass ended.
//
// What the runner reports goes back as { type: 'report', event } (Runner's report option), with codes, never text from
// a server or a backend. What this process writes to stderr, for diagnostics, is local too: the time, the level and a
// code or a number, never a message, which can quote a server or a backend. The exit code is the runner's own: 0
// stopped, 1 a config or startup problem, 2 the key stopped working, 3 the program is no longer the approved one.
//
// PDFs. The runner has no reader for PDFs of its own; this process lends it Rukoo's: { type: 'pdf', id, data,
// maxChars } asks main for a PDF's text, which main's reader reads in a process of its own with limits on its time and
// memory (src/main/pdfread.js), and { type: 'pdf', id, result } is the answer.
const path = require('path');
const { Runner, normalizeConfig, DEFAULT_KEY_ENV } = require('../../integrations/agent-runner/runner.js');
const { KeyRefused, RukooError } = require('../../integrations/agent-runner/rukoo.js');

const port = process.parentPort || null;
let runner = null;
let started = false;
let stopping = false;
let exiting = false;
// Log lines so far, by level: the only thing a line says about what the runner logged.
const lines = { info: 0, warn: 0, error: 0 };
// How long a PDF may wait for main's answer: its reader's time (pdfread.js TIMEOUT) and its wait for a free reader
// (TURN_WAIT), with room to spare.
const PDF_WAIT = 45000;
const pdfWaits = new Map();
let pdfSeq = 0;

function post(msg) {
  try {
    if (port) port.postMessage(msg);
    else if (process.send && process.connected) process.send(msg);
  } catch (_) {
    // Rukoo is gone; the exit follows.
  }
}

// A diagnostic line: the time, the level and what kind, by a code this file defines or a count.
function note(level, what) {
  process.stderr.write(`${new Date().toISOString()} ${level} ${what}\n`);
}

// The runner's own log: its level, and how many of that level came so far.
function log(level, _message) {
  const l = Object.prototype.hasOwnProperty.call(lines, level) ? level : 'info';
  lines[l] += 1;
  note(l, `log ${lines[l]}`);
}

// What an error that stopped the runner was, as a code: offline or http with its status for the account server,
// config for a config the runner can't take, server for a server without team chat or agents, runner otherwise.
function errorEvent(err) {
  if (err instanceof RukooError) return { type: 'error', code: err.network ? 'offline' : 'http', ...(Number.isSafeInteger(err.status) && err.status ? { status: err.status } : {}) };
  return { type: 'error', code: err && (err.code === 'config' || err.code === 'server') ? err.code : 'runner' };
}

// The runner's readPdf: a promise of { text, truncated, partial, encrypted, failed } from main's reader. It never
// rejects: no answer within PDF_WAIT, or the runner's stop, is a PDF without text.
function readPdf(bytes, { maxChars, signal } = {}) {
  return new Promise((resolve) => {
    const id = ++pdfSeq;
    let timer = null;
    const done = (result) => {
      if (!pdfWaits.has(id)) return;
      pdfWaits.delete(id);
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve(result);
    };
    const onAbort = () => done({ text: '', failed: 'stopped' });
    pdfWaits.set(id, done);
    if (signal && signal.aborted) return onAbort();
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => done({ text: '', failed: 'timeout' }), PDF_WAIT);
    post({ type: 'pdf', id, data: Buffer.from(bytes).toString('base64'), maxChars });
  });
}

// Main's answer to readPdf, with only what the runner reads of it.
function pdfAnswer(msg) {
  const done = pdfWaits.get(msg.id);
  if (!done) return;
  const r = msg.result && typeof msg.result === 'object' ? msg.result : {};
  done({ text: typeof r.text === 'string' ? r.text : '', truncated: r.truncated === true, partial: r.partial === true, encrypted: r.encrypted === true, failed: typeof r.failed === 'string' ? r.failed : null });
}

// A short wait first, so the last report reaches Rukoo before the process ends.
function exit(code) {
  if (exiting) return;
  exiting = true;
  setTimeout(() => process.exit(code), 50);
}

async function start({ config, key, backendKey }) {
  try {
    if (!config || typeof config !== 'object' || Array.isArray(config) || typeof config.state !== 'string') throw Object.assign(new Error('no config'), { code: 'config' });
    // The key goes in as the runner's own variable would, in an environment that exists only here. The state file is
    // an absolute path in the profile, which main chose.
    let cfg;
    try {
      cfg = normalizeConfig({ ...config, key: undefined, keyEnv: undefined }, { dir: path.dirname(config.state), name: 'agent', env: { [DEFAULT_KEY_ENV]: typeof key === 'string' ? key : '' } });
    } catch (err) {
      throw Object.assign(err, { code: 'config' });
    }
    if (typeof backendKey === 'string' && backendKey && cfg.backend && typeof cfg.backend === 'object') cfg.backend = { ...cfg.backend, key: backendKey };
    try {
      runner = new Runner(cfg, { log, report: (event) => post({ type: 'report', event }), readPdf });
    } catch (err) {
      throw Object.assign(err, { code: 'config' });
    }
  } catch (err) {
    const event = errorEvent(err);
    note('error', event.code);
    post({ type: 'report', event });
    return exit(1);
  }
  if (stopping) runner.stop();
  try {
    await runner.run();
    exit(0);
  } catch (err) {
    if (err instanceof KeyRefused) return exit(2);
    if (err && err.code === 'changed') {
      note('error', 'changed');
      return exit(3);
    }
    const event = errorEvent(err);
    note('error', event.code);
    post({ type: 'report', event });
    exit(1);
  }
}

function stop() {
  stopping = true;
  if (runner) runner.stop();
  else exit(0);
}

// A wake from main: a pass now, and the answer once it ended, so main knows its status is fresh again.
function wake(seq) {
  const woke = () => post({ type: 'report', event: { type: 'woke', seq } });
  if (!runner || stopping) return woke();
  Promise.resolve(runner.pump()).then(woke, woke);
}

function onMessage(msg) {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'start' && !started && !stopping) {
    started = true;
    start(msg);
  } else if (msg.type === 'stop') stop();
  else if (msg.type === 'wake') wake(Number.isSafeInteger(msg.seq) ? msg.seq : 0);
  else if (msg.type === 'pdf') pdfAnswer(msg);
}

if (port) {
  port.on('message', (e) => onMessage(e && e.data));
} else {
  process.on('message', onMessage);
  // Rukoo went: the channel closed. The runner stops, and the process with it.
  process.on('disconnect', stop);
}
// Without these, Node would print the error's text, which can quote a server or a backend.
process.on('uncaughtException', () => {
  note('error', 'uncaught');
  process.exit(1);
});
process.on('unhandledRejection', () => {
  note('error', 'unhandled');
  process.exit(1);
});
// Main ends a runner that didn't stop in time: a first SIGTERM stops it as a stop message does, a second ends it now.
process.on('SIGTERM', () => {
  if (stopping) process.exit(0);
  stop();
});
