'use strict';

// One team chat agent's runner (integrations/agent-runner, the same program its README describes) in a process of
// its own, which agent-runs.js starts for "Run on this computer". In Electron it is a utility process; plain Node (the
// unit tests) forks one.
//
// Everything comes in the first message, { type: 'start', config, key, backendKey }: the runner's config as main built
// it from what the person approved, the agent's key and the backend's own secret, such as a Hermes API key. They stay
// in this process's memory: never in its environment, which other programs of the same user can read, and never on
// disk. The runner keeps both out of every program it starts, and this process keeps them out of what it writes.
// { type: 'stop' } stops the runner: it ends a turn in flight, bounded (runner.js STOP_GRACE), and exits; a second
// SIGTERM ends it at once. { type: 'wake' } asks for a pass now, as after the computer slept.
//
// What the runner reports goes back as { type: 'report', event } (Runner's report option), with codes, never text from
// a server or a backend. Its log lines go to stderr with the secrets taken out. The exit code is the runner's own: 0
// stopped, 1 a config or startup problem, 2 the key stopped working.
const path = require('path');
const { Runner, normalizeConfig, DEFAULT_KEY_ENV } = require('../../integrations/agent-runner/runner.js');
const { KeyRefused, RukooError } = require('../../integrations/agent-runner/rukoo.js');

const port = process.parentPort || null;
let runner = null;
let started = false;
let stopping = false;
let exiting = false;
// The values that never leave this process: the agent's key and the backend's secret.
let secrets = [];

// Text with every secret this process holds, and anything that looks like an agent key or a bearer token, taken out.
function redact(value) {
  let s = String(value == null ? '' : value);
  for (const v of secrets) s = s.split(v).join('[secret]');
  return s.replace(/rka_[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{10,}/g, 'rka_[secret]').replace(/(Bearer\s+)[^\s"']+/gi, '$1[secret]');
}

function post(msg) {
  try {
    if (port) port.postMessage(msg);
    else if (process.send && process.connected) process.send(msg);
  } catch (_) {
    // Rukoo is gone; the exit follows.
  }
}

function log(level, message) {
  process.stderr.write(`${redact(`${new Date().toISOString()} ${level} ${message}`)}\n`);
}

// What an error that stopped the runner was, as a code: offline or http with its status for the account server,
// config for a config the runner can't take, server for a server without team chat or agents, runner otherwise.
function errorEvent(err) {
  if (err instanceof RukooError) return { type: 'error', code: err.network ? 'offline' : 'http', ...(Number.isSafeInteger(err.status) && err.status ? { status: err.status } : {}) };
  return { type: 'error', code: err && (err.code === 'config' || err.code === 'server') ? err.code : 'runner' };
}

// A short wait first, so the last report reaches Rukoo before the process ends.
function exit(code) {
  if (exiting) return;
  exiting = true;
  setTimeout(() => process.exit(code), 50);
}

async function start({ config, key, backendKey }) {
  secrets = [key, backendKey].filter((v) => typeof v === 'string' && v.length >= 8);
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
      runner = new Runner(cfg, { log, report: (event) => post({ type: 'report', event }) });
    } catch (err) {
      throw Object.assign(err, { code: 'config' });
    }
  } catch (err) {
    log('error', err.message);
    post({ type: 'report', event: errorEvent(err) });
    return exit(1);
  }
  if (stopping) runner.stop();
  try {
    await runner.run();
    exit(0);
  } catch (err) {
    if (err instanceof KeyRefused) return exit(2);
    log('error', err.message);
    post({ type: 'report', event: errorEvent(err) });
    exit(1);
  }
}

function stop() {
  stopping = true;
  if (runner) runner.stop();
  else exit(0);
}

function onMessage(msg) {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'start' && !started && !stopping) {
    started = true;
    start(msg);
  } else if (msg.type === 'stop') stop();
  else if (msg.type === 'wake' && runner && !stopping) runner.pump();
}

if (port) {
  port.on('message', (e) => onMessage(e && e.data));
} else {
  process.on('message', onMessage);
  // Rukoo went: the channel closed. The runner stops, and the process with it.
  process.on('disconnect', stop);
}
// Main ends a runner that didn't stop in time: a first SIGTERM stops it as a stop message does, a second ends it now.
process.on('SIGTERM', () => {
  if (stopping) process.exit(0);
  stop();
});
