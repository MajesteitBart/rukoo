'use strict';

// One team chat agent's runner (integrations/agent-runner, the same program its README describes) in a process of
// its own, which agent-runs.js starts for "Run on this computer". In Electron it is a utility process; plain Node (the
// unit tests) forks one.
//
//   argv[2]: the runner's config file, which holds no secret.
//
// The agent's key and the backend's own secret, such as a Hermes API key, come in the first message ({ type: 'start',
// key, backendKey }) and stay in this process's memory: never in its environment, which other programs of the same
// user can read, and never on disk. The runner keeps both out of every program it starts. { type: 'stop' } stops the
// runner; it finishes what it posts and exits.
//
// What the runner reports goes back as { type: 'report', event } (Runner's report option), and its log lines go to
// stderr. The exit code is the runner's own: 0 stopped, 1 a config or startup problem, 2 the key stopped working.
const { Runner, loadConfig, DEFAULT_KEY_ENV } = require('../../integrations/agent-runner/runner.js');
const { KeyRefused } = require('../../integrations/agent-runner/rukoo.js');

const file = process.argv[2];
const port = process.parentPort || null;
let runner = null;
let started = false;
let exiting = false;

function post(msg) {
  try {
    if (port) port.postMessage(msg);
    else if (process.send && process.connected) process.send(msg);
  } catch (_) {
    // Rukoo is gone; the exit follows.
  }
}

function log(level, message) {
  process.stderr.write(`${new Date().toISOString()} ${level} ${message}\n`);
}

// A short wait first, so the last report reaches Rukoo before the process ends.
function exit(code) {
  if (exiting) return;
  exiting = true;
  setTimeout(() => process.exit(code), 50);
}

async function start({ key, backendKey }) {
  let config;
  try {
    // The key goes in as the runner's own variable would, in an environment that exists only here.
    config = loadConfig(file, { [DEFAULT_KEY_ENV]: typeof key === 'string' ? key : '' });
    if (typeof backendKey === 'string' && backendKey && config.backend && typeof config.backend === 'object') {
      config.backend = { ...config.backend, key: backendKey };
    }
    runner = new Runner(config, { log, report: (event) => post({ type: 'report', event }) });
  } catch (err) {
    log('error', err.message);
    post({ type: 'report', event: { type: 'error', message: err.message } });
    return exit(1);
  }
  try {
    await runner.run();
    exit(0);
  } catch (err) {
    if (err instanceof KeyRefused) return exit(2);
    log('error', err.message);
    post({ type: 'report', event: { type: 'error', message: err.message } });
    exit(1);
  }
}

function onMessage(msg) {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'start' && !started) {
    started = true;
    start(msg);
  } else if (msg.type === 'stop') {
    if (runner) runner.stop();
    else exit(0);
  }
}

if (port) {
  port.on('message', (e) => onMessage(e && e.data));
} else {
  process.on('message', onMessage);
  // Rukoo went: the channel closed. The runner stops, and the process with it.
  process.on('disconnect', () => {
    if (runner) runner.stop();
    exit(0);
  });
}
process.on('SIGTERM', () => {
  if (runner) runner.stop();
  else exit(0);
});
