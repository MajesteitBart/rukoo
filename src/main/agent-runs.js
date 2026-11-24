'use strict';

// "Run on this computer" for team chat's agents (docs/chat.md, "Agents in channels"): Rukoo's desktop app runs an
// agent's runner (integrations/agent-runner) itself, one process per agent, while Rukoo runs, in the tray too. Nothing
// here ships in the browser app, which reaches src/main only through src/web/host.js.
//
// The agent's key. The server shows it once, when the agent is made and at New key; main receives it there
// (manage.createAgent, manage.newAgentKey) and holds it in memory while the key step is open (hold), for 30 minutes at
// most. "Run on this computer" stores it in agent-runs.json, encrypted with safeStorage (secrets.js); without a way to
// encrypt it (Linux without a keyring) the option isn't offered and nothing is stored. A stored key never goes back to
// the renderer: the only call that answers a key is heldKey, for the key step's "Run it on another computer", and it
// answers only the key the key step holds. New key replaces the stored key and restarts the runner by itself.
//
// The backend is an agent of Settings, Agents (src/main/agents/config.js), by its id: main builds the backend from
// those settings at every start (runBackend), never from what the renderer sends, so a renderer can't make main run a
// program of its choosing. That agent's own secret, such as a Hermes API key, comes from the same settings.
//
// The process. agent-runner-child.js in an Electron utility process, which ends with Rukoo and never takes
// ELECTRON_RUN_AS_NODE. Its config file in agent-runs/ holds no secret; the key and the backend's secret go to it in
// its first message and stay in its memory. A runner that ends by itself starts again after a pause that grows
// (DELAYS); one that ran STEADY without trouble starts the pauses over. Exit code 2 means the key stopped working: it
// stays stopped until New key, and when the agent turns out to be removed, its setup goes. The runner stops when the
// person stops it, removes the agent, leaves the workspace or signs out. Setups belong to one sign-in, as the chat
// cache does: signing out, or a session or server other than the one they were made under, deletes them.
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');

const FILE = 'agent-runs.json';
const DIR = 'agent-runs';
const CHILD = path.join(__dirname, 'agent-runner-child.js');
// The pauses before the next start of a runner that ended by itself, the last one repeating.
const DELAYS = [2000, 5000, 15000, 30000, 60000, 120000, 300000];
// A runner that ran this long starts its pauses over when it ends.
const STEADY = 2 * 60 * 1000;
// How long main holds a new key for the key step.
const HELD_FOR = 30 * 60 * 1000;
// How long a stopped runner gets to finish before its process is ended.
const STOP_WAIT = 5000;
// What the runner reads for each mention, as the config the key step shows (src/renderer/chat-agents.js).
const RUNNER_CONTEXT = Object.freeze({ threadMessages: 50, channelMessages: 20, maxChars: 30000 });
// The Settings agents a runner answers with: the built-in ones and custom ones on a server (cx_…).
const BUILT_IN = ['clark', 'openclaw', 'claude', 'codex'];
const CUSTOM_ID = /^cx_[a-z0-9]{10}$/;
const WS_ID = /^w_[A-Za-z0-9_-]{22}$/;
const MEMBER_ID = /^u_[A-Za-z0-9_-]{22}$/;
const AGENT_KEY = /^rka_[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/;

const text = (v) => (typeof v === 'string' ? v.trim() : '');
const withModel = (backend, model) => (text(model) ? { ...backend, model: text(model) } : backend);

class RunError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

// The runner's backend for the Settings agent use, as the key step's config has it (chat-agents.js runnerAgents),
// with that agent's secret apart: { name, backend, secret }, or null when use names no agent that can answer.
// cfg: the hub's AgentConfig, whose get() decrypts the secrets.
function runBackend(cfg, use) {
  if (!cfg || typeof use !== 'string' || !(BUILT_IN.includes(use) || CUSTOM_ID.test(use))) return null;
  const c = cfg.get(use);
  if (!c) return null;
  const name = typeof cfg.displayName === 'function' ? cfg.displayName(use) : use;
  if (use === 'clark') {
    if (!text(c.url)) return null;
    return { name, backend: withModel({ type: 'runs', url: text(c.url) }, c.model), secret: text(c.key) };
  }
  if (use === 'openclaw') {
    if (!text(c.url)) return null;
    // OpenClaw's gateway speaks Chat Completions; its model names an OpenClaw agent. A backend model of Settings goes in
    // the x-openclaw-model header, as Rukoo sends it.
    const headers = text(c.model) ? { headers: { 'x-openclaw-model': text(c.model) } } : {};
    return { name, backend: { type: 'openai', url: text(c.url), model: `openclaw/${text(c.agent) || 'default'}`, ...headers }, secret: text(c.key) };
  }
  if (use === 'claude' || use === 'codex') {
    const exe = text(c.exe);
    const configDir = use === 'claude' ? text(c.configDir) : '';
    return { name, backend: withModel({ type: use, ...(exe ? { exe } : {}), ...(configDir ? { configDir } : {}) }, c.model), secret: '' };
  }
  if (!text(c.url) || !['runs', 'openai'].includes(c.protocol)) return null;
  return { name: text(c.name) || name, backend: withModel({ type: c.protocol, url: text(c.url) }, c.model), secret: text(c.key) };
}

// The process of one runner: a utility process in Electron, a fork in plain Node (the tests). { post(msg),
// onMessage(fn), onExit(fn(code)), stderr, kill() }.
function forkRunner(modulePath, args, { env, serviceName }) {
  if (process.versions.electron && process.type === 'browser') {
    const { utilityProcess } = require('electron');
    const child = utilityProcess.fork(modulePath, args, { env, stdio: ['ignore', 'ignore', 'pipe'], serviceName });
    return {
      post: (msg) => child.postMessage(msg),
      onMessage: (fn) => child.on('message', fn),
      onExit: (fn) => child.on('exit', (code) => fn(code)),
      stderr: child.stderr,
      kill: () => child.kill()
    };
  }
  const { fork } = require('child_process');
  // execArgv in full: a fork would inherit the parent's, such as the test runner's.
  const child = fork(modulePath, args, { env, execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
  // A message to a process that just ended fails with EPIPE; the exit says what happened.
  child.on('error', () => {});
  return {
    post: (msg) => {
      if (child.connected) child.send(msg, () => {});
    },
    onMessage: (fn) => child.on('message', fn),
    onExit: (fn) => child.on('exit', (code) => fn(code === null ? -1 : code)),
    stderr: child.stderr,
    kill: () => child.kill()
  };
}

// The environment of a runner's process: Rukoo's, without what would make it start as plain Node or hand it a key.
function runnerEnv(base = process.env) {
  const env = { ...base };
  for (const name of Object.keys(env)) {
    const upper = name.toUpperCase();
    if (upper === 'ELECTRON_RUN_AS_NODE' || upper === 'RUKOO_AGENT_KEY') delete env[name];
  }
  return env;
}

function writePrivate(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  try {
    fs.renameSync(tmp, file);
  } catch (_) {
    // Windows can refuse to replace a file another process has open for a moment.
    fs.writeFileSync(file, data, { mode: 0o600 });
    fs.rmSync(tmp, { force: true });
  }
}

class AgentRuns extends EventEmitter {
  // dataDir: the profile's data folder. secrets: secrets.js. canKeep(): whether a secret can be stored encrypted
  // (secrets.available). account: the AccountService, for the sign-in the setups belong to. backendFor(use): runBackend
  // for the hub's settings. agentExists(ws, agent): a promise of whether the workspace still has the agent (true, false
  // or null when unknown), asked after a key stopped working. fork, child, delays, steady, stopWait, heldFor and now
  // can be replaced in tests. log(level, message): ids and states only.
  constructor({
    dataDir,
    secrets,
    canKeep = () => false,
    account,
    backendFor = () => null,
    agentExists = () => Promise.resolve(null),
    fork = forkRunner,
    child = CHILD,
    delays = DELAYS,
    steady = STEADY,
    stopWait = STOP_WAIT,
    heldFor = HELD_FOR,
    now = Date.now,
    log = () => {}
  }) {
    super();
    this.dataDir = dataDir;
    this.file = path.join(dataDir, FILE);
    this.dir = path.join(dataDir, DIR);
    this.secrets = secrets;
    this.canKeep = canKeep;
    this.account = account;
    this.backendFor = backendFor;
    this.agentExists = agentExists;
    this.fork = fork;
    this.child = child;
    this.delays = delays;
    this.steady = steady;
    this.stopWait = stopWait;
    this.heldFor = heldFor;
    this.now = now;
    this.log = log;
    // { version, server, session, runs: [stored run] }. What only this run of Rukoo knows of each (its process and
    // what it reported) is in live.
    this.data = { version: 1, server: null, session: null, runs: [] };
    this.live = new Map();
    // `${ws} ${agent}` → { key, timer }: the keys the key step holds.
    this.held = new Map();
    this.followed = null;
    this.closed = false;
    this.onStatus = () => this.follow();
  }

  // Reads the setups, follows the account and starts the runners that are on. Returns this.
  init() {
    this.load();
    if (this.account && typeof this.account.on === 'function') this.account.on('status', this.onStatus);
    this.follow();
    return this;
  }

  load() {
    let saved = null;
    try {
      saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (_) {
      saved = null;
    }
    if (!saved || saved.version !== 1 || !Array.isArray(saved.runs)) return;
    const runs = [];
    for (const r of saved.runs) {
      if (!r || !WS_ID.test(r.ws) || !MEMBER_ID.test(r.agent) || typeof r.key !== 'string' || !r.key.startsWith('enc:')) continue;
      if (runs.some((x) => x.ws === r.ws && x.agent === r.agent)) continue;
      runs.push({
        ws: r.ws,
        agent: r.agent,
        name: text(r.name).slice(0, 80),
        use: text(r.use),
        key: r.key,
        keyAt: Number.isFinite(r.keyAt) ? r.keyAt : null,
        on: r.on === true,
        refused: r.refused === true,
        stoppedAt: Number.isFinite(r.stoppedAt) ? r.stoppedAt : null
      });
    }
    this.data = { version: 1, server: typeof saved.server === 'string' ? saved.server : null, session: typeof saved.session === 'string' ? saved.session : null, runs };
  }

  save() {
    try {
      if (!this.data.runs.length) {
        fs.rmSync(this.file, { force: true });
        return;
      }
      const runs = this.data.runs.map(({ ws, agent, name, use, key, keyAt, on, refused, stoppedAt }) => ({ ws, agent, name, use, key, keyAt, on, refused, stoppedAt }));
      writePrivate(this.file, JSON.stringify({ version: 1, server: this.data.server, session: this.data.session, runs }));
    } catch (err) {
      this.log('warn', `could not save the agent setups: ${err.code || err.message}`);
    }
  }

  // ---- the sign-in ----

  signature() {
    const status = this.account && typeof this.account.status === 'function' ? this.account.status() : null;
    const signedIn = Boolean(status && status.signedIn);
    return { signedIn, server: signedIn ? String(status.server || '') : '', session: signedIn ? this.account.sessionTag || null : null };
  }

  signedIn() {
    return this.signature().signedIn;
  }

  // The account said something. Signed out, the setups and their keys go; signed in under another session or server
  // than the setups were made under too. Otherwise the runners that are on run.
  follow() {
    if (this.closed) return;
    const { signedIn, server, session } = this.signature();
    const sig = `${signedIn}\n${server}\n${session}`;
    if (sig === this.followed) return;
    this.followed = sig;
    if (!signedIn) {
      this.wipe('signed out');
      return;
    }
    if (this.data.runs.length && (this.data.session !== session || this.data.server !== server)) this.wipe('another sign-in');
    this.data.server = server;
    this.data.session = session;
    for (const run of this.data.runs) if (run.on && !run.refused) this.launch(run);
    this.changed();
  }

  // Every runner stops, and every setup and held key goes, from disk too: again once each runner ended, as one that
  // stops can still write its state file.
  wipe(why) {
    const old = this.data.runs;
    this.data = { version: 1, server: null, session: null, runs: [] };
    for (const run of old) this.stopProcess(run, () => !this.data.runs.length && this.removeFiles());
    for (const h of this.held.values()) clearTimeout(h.timer);
    this.held.clear();
    this.live.clear();
    this.removeFiles();
    if (old.length) this.log('info', `agent setups deleted: ${why}`);
    this.changed();
  }

  // ---- keys the key step holds ----

  hold(ws, agent, key) {
    if (!WS_ID.test(ws) || !MEMBER_ID.test(agent) || !AGENT_KEY.test(key) || key.slice(4, 26) !== agent.slice(2)) return false;
    this.release(ws, agent);
    const timer = setTimeout(() => this.release(ws, agent), this.heldFor);
    if (timer.unref) timer.unref();
    this.held.set(`${ws} ${agent}`, { key, timer });
    return true;
  }

  // The key the key step holds for the agent, or null. Never a stored one.
  heldKey(ws, agent) {
    const h = this.held.get(`${ws} ${agent}`);
    return h ? h.key : null;
  }

  release(ws, agent) {
    const id = `${ws} ${agent}`;
    const h = this.held.get(id);
    if (!h) return false;
    clearTimeout(h.timer);
    this.held.delete(id);
    return true;
  }

  // What chatCreateAgent and chatNewAgentKey answer the window: the server's answer without the key, which main holds
  // instead. renew: New key, which also replaces the key of the agent's setup here. runsHere: it has one.
  takeKey(ws, answer, { renew = false } = {}) {
    if (!answer || typeof answer !== 'object' || typeof answer.key !== 'string' || !answer.agent || typeof answer.agent.id !== 'string') return answer;
    const { key, ...rest } = answer;
    const agent = answer.agent.id;
    this.hold(ws, agent, key);
    const runsHere = renew ? this.replaceKey(ws, agent, key) : false;
    return { ...rest, held: this.heldKey(ws, agent) !== null, runsHere };
  }

  // ---- setups ----

  find(ws, agent) {
    return this.data.runs.find((r) => r.ws === ws && r.agent === agent) || null;
  }

  encrypt(key) {
    if (!this.canKeep()) throw new RunError('no_keyring');
    let value;
    try {
      value = this.secrets.encrypt(key);
    } catch (_) {
      throw new RunError('no_keyring');
    }
    if (typeof value !== 'string' || !value.startsWith('enc:')) throw new RunError('no_keyring');
    return value;
  }

  // Run on this computer, or Start: the held key when the key step has one, else the stored key. use: the Settings
  // agent that answers (the stored one when left out). name: the agent's name, for the list and the process.
  start(ws, agent, { use = '', name = '' } = {}) {
    if (this.closed) throw new RunError('closed');
    if (!WS_ID.test(ws) || !MEMBER_ID.test(agent)) throw new RunError('invalid');
    if (!this.signedIn()) throw new RunError('signed_out');
    if (!this.canKeep()) throw new RunError('no_keyring');
    let run = this.find(ws, agent);
    const held = this.heldKey(ws, agent);
    if (!held && !run) throw new RunError('no_key');
    const backend = text(use) || (run && run.use) || '';
    if (!this.backendFor(backend)) throw new RunError('unknown_backend');
    const key = held ? this.encrypt(held) : null;
    if (!run) {
      run = { ws, agent, name: '', use: backend, key, keyAt: this.now(), on: false, refused: false, stoppedAt: null };
      this.data.runs.push(run);
    } else if (key) {
      run.key = key;
      run.keyAt = this.now();
      run.refused = false;
    }
    if (text(name)) run.name = text(name).slice(0, 80);
    run.use = backend;
    run.on = true;
    run.stoppedAt = null;
    const status = this.signature();
    this.data.server = status.server;
    this.data.session = status.session;
    this.save();
    this.state(run).failures = 0;
    this.restart(run);
    this.log('info', `${agent} runs on this computer with ${backend}`);
    return this.view(run);
  }

  stop(ws, agent) {
    const run = this.find(ws, agent);
    if (!run) throw new RunError('not_found');
    run.on = false;
    run.stoppedAt = this.now();
    this.save();
    this.stopProcess(run);
    this.state(run).phase = run.refused ? 'refused' : 'stopped';
    this.log('info', `${agent} stopped on this computer`);
    this.changed();
    return this.view(run);
  }

  // The setup goes: its runner stops and its key, config and state file are deleted.
  forget(ws, agent) {
    const run = this.find(ws, agent);
    this.release(ws, agent);
    if (!run) return false;
    this.data.runs = this.data.runs.filter((r) => r !== run);
    this.stopProcess(run, () => !this.find(ws, agent) && this.removeFiles(run));
    this.live.delete(run);
    this.removeFiles(run);
    this.save();
    this.log('info', `${agent} no longer runs on this computer`);
    this.changed();
    return true;
  }

  forgetWorkspace(ws) {
    for (const run of this.data.runs.filter((r) => r.ws === ws)) this.forget(run.ws, run.agent);
    for (const id of [...this.held.keys()]) if (id.startsWith(`${ws} `)) this.release(...id.split(' '));
  }

  // New key: the setup takes the new key, and a runner that is on starts again with it. Answers whether the agent has
  // a setup here.
  replaceKey(ws, agent, key) {
    const run = this.find(ws, agent);
    if (!run) return false;
    try {
      run.key = this.encrypt(key);
    } catch (_) {
      // The old key stopped at the server; without a way to keep the new one the runner stays stopped.
      run.refused = true;
      this.save();
      this.stopProcess(run);
      this.state(run).phase = 'refused';
      this.changed();
      return true;
    }
    run.keyAt = this.now();
    run.refused = false;
    this.save();
    if (run.on) {
      this.state(run).failures = 0;
      this.restart(run);
    } else this.changed();
    return true;
  }

  files(run) {
    const base = path.join(this.dir, `${run.ws}-${run.agent}`);
    return [`${base}.json`, `${base}.state.json`];
  }

  // ---- processes ----

  // What only this run of Rukoo knows of a setup: its process and what it reported.
  state(run) {
    let s = this.live.get(run);
    if (!s) {
      s = {
        phase: run.refused ? 'refused' : run.on ? 'starting' : 'stopped',
        child: null,
        failures: 0,
        timer: null,
        startedAt: null,
        connectedAt: null,
        passAt: null,
        answeredAt: null,
        channels: null,
        problems: [],
        unreachable: null,
        failure: null,
        error: null,
        retryAt: null,
        stderr: []
      };
      this.live.set(run, s);
    }
    return s;
  }

  restart(run) {
    this.stopProcess(run);
    this.launch(run);
  }

  launch(run) {
    if (this.closed) return;
    const s = this.state(run);
    if (s.child) return;
    clearTimeout(s.timer);
    s.timer = null;
    s.retryAt = null;
    s.error = null;
    const fail = (code) => {
      s.phase = 'error';
      s.error = { code };
      this.log('warn', `${run.agent} can't start: ${code}`);
      this.changed();
    };
    const backend = this.backendFor(run.use);
    if (!backend) return fail('unknown_backend');
    let key = '';
    try {
      key = this.secrets.decrypt(run.key);
    } catch (_) {
      key = '';
    }
    if (!AGENT_KEY.test(key)) return fail('key_unreadable');
    const [configFile, stateFile] = this.files(run);
    const config = {
      server: this.data.server,
      workspace: run.ws,
      backend: backend.backend,
      context: { ...RUNNER_CONTEXT },
      instructions: '',
      state: path.basename(stateFile),
      // The app's own server: the key goes where the app's session goes already, also over plain http.
      ...(/^http:/i.test(String(this.data.server || '')) ? { allowHttp: true } : {})
    };
    try {
      writePrivate(configFile, `${JSON.stringify(config, null, 2)}\n`);
    } catch (_) {
      return fail('config');
    }
    let child;
    try {
      child = this.fork(this.child, [configFile], { env: runnerEnv(), serviceName: `Rukoo agent ${run.name || run.agent}` });
    } catch (_) {
      return fail('spawn');
    }
    s.child = child;
    s.phase = 'starting';
    s.startedAt = this.now();
    s.connectedAt = null;
    s.problems = [];
    s.unreachable = null;
    s.failure = null;
    s.stderr = [];
    if (child.stderr) {
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (d) => {
        // The last lines only, in memory: they can quote what a runtime answered.
        s.stderr = s.stderr.concat(String(d).split('\n').filter(Boolean)).slice(-10);
      });
    }
    child.onMessage((msg) => this.report(run, child, msg));
    child.onExit((code) => this.exited(run, child, code));
    child.post({ type: 'start', key, backendKey: backend.secret || '' });
    this.log('info', `${run.agent} starting`);
    this.changed();
  }

  report(run, child, msg) {
    const s = this.state(run);
    if (s.child !== child || !msg || msg.type !== 'report' || !msg.event || typeof msg.event !== 'object') return;
    const e = msg.event;
    const now = this.now();
    const line = (v) => text(v).replace(/\s+/g, ' ').slice(0, 300);
    switch (e.type) {
      case 'connected':
        s.phase = 'running';
        s.connectedAt = now;
        s.unreachable = null;
        break;
      case 'problems':
        s.problems = (Array.isArray(e.problems) ? e.problems : []).slice(0, 5).map((p) => ({ code: p && typeof p.code === 'string' ? p.code : null, message: line(p && p.message) }));
        break;
      case 'pass':
        if (s.phase === 'starting') s.phase = 'running';
        s.passAt = now;
        s.unreachable = null;
        s.channels = Number.isSafeInteger(e.channels) ? e.channels : null;
        break;
      case 'unreachable':
        s.unreachable = { message: line(e.message), at: now };
        break;
      case 'answered':
        s.answeredAt = now;
        s.failure = null;
        break;
      case 'failed':
        s.failure = { message: line(e.message), at: now };
        break;
      case 'refused':
        run.refused = true;
        this.save();
        break;
      case 'error':
        s.error = { code: 'runner', message: line(e.message) };
        break;
      default:
        return;
    }
    this.changed();
  }

  exited(run, child, code) {
    const s = this.state(run);
    if (s.child !== child) return;
    s.child = null;
    const ranFor = s.startedAt ? this.now() - s.startedAt : 0;
    if (code === 2 || run.refused) {
      run.refused = true;
      run.stoppedAt = this.now();
      this.save();
      s.phase = 'refused';
      this.log('warn', `${run.agent}'s key stopped working`);
      this.changed();
      // A removed agent's setup goes; one whose key was replaced elsewhere waits for New key here.
      Promise.resolve()
        .then(() => this.agentExists(run.ws, run.agent))
        .then(
          (exists) => {
            if (exists === false && this.find(run.ws, run.agent) === run && run.refused) this.forget(run.ws, run.agent);
          },
          () => {}
        );
      return;
    }
    if (!run.on || this.closed || !this.data.runs.includes(run)) {
      if (this.data.runs.includes(run)) s.phase = 'stopped';
      this.changed();
      return;
    }
    // Ended by itself: a crash, or a config or startup problem. It starts again after a pause.
    if (ranFor >= this.steady) s.failures = 0;
    const wait = this.delays[Math.min(s.failures, this.delays.length - 1)];
    s.failures += 1;
    s.phase = 'waiting';
    if (!s.error) s.error = { code: 'crashed', message: (s.stderr[s.stderr.length - 1] || '').slice(0, 300) };
    s.retryAt = this.now() + wait;
    this.log('warn', `${run.agent} ended with code ${code}; starting again in ${Math.round(wait / 1000)} s`);
    s.timer = setTimeout(() => {
      s.timer = null;
      if (run.on && !this.closed && this.data.runs.includes(run)) this.launch(run);
    }, wait);
    if (s.timer.unref) s.timer.unref();
    this.changed();
  }

  // Asks the runner to stop and ends its process when it hasn't after stopWait. then: once the process ended, or at
  // once without one; a runner that stops can still write its state file, which a deletion then removes again.
  stopProcess(run, then = null) {
    const s = this.live.get(run);
    const child = s ? s.child : null;
    if (s) {
      clearTimeout(s.timer);
      s.timer = null;
      s.retryAt = null;
      s.child = null;
    }
    if (!child) {
      if (then) then();
      return;
    }
    try {
      child.post({ type: 'stop' });
    } catch (_) {
      // Gone already.
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch (_) {
        // Gone already.
      }
    }, this.stopWait);
    if (timer.unref) timer.unref();
    child.onExit(() => {
      clearTimeout(timer);
      if (then) then();
    });
  }

  // Deletes a setup's config and state file, or every setup's folder.
  removeFiles(run = null) {
    try {
      if (run) for (const f of this.files(run)) fs.rmSync(f, { force: true });
      else {
        fs.rmSync(this.file, { force: true });
        fs.rmSync(this.dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      }
    } catch (err) {
      this.log('warn', `could not delete an agent setup: ${err.code || err.message}`);
    }
  }

  // Rukoo quits: every runner is asked to stop, and the setups stay as they are for the next start.
  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.account && typeof this.account.removeListener === 'function') this.account.removeListener('status', this.onStatus);
    for (const run of this.data.runs) this.stopProcess(run);
    for (const h of this.held.values()) clearTimeout(h.timer);
    this.held.clear();
  }

  // ---- what the window sees ----

  // One setup as the window sees it: never its key.
  view(run) {
    const s = this.state(run);
    return {
      ws: run.ws,
      agent: run.agent,
      name: run.name,
      use: run.use,
      on: run.on,
      phase: s.phase,
      keyAt: run.keyAt,
      stoppedAt: run.stoppedAt,
      startedAt: s.startedAt,
      connectedAt: s.connectedAt,
      passAt: s.passAt,
      answeredAt: s.answeredAt,
      channels: s.channels,
      problem: s.problems[0] || null,
      unreachable: s.unreachable,
      failure: s.failure,
      error: s.error,
      retryAt: s.retryAt
    };
  }

  // agentRuns: whether this computer can run agents (a sign-in, and a way to keep a key encrypted) and every setup.
  snapshot() {
    return { available: this.signedIn() && Boolean(this.canKeep()), runs: this.data.runs.map((r) => this.view(r)) };
  }

  changed() {
    if (this.closed) return;
    this.emit('changed', this.snapshot());
  }
}

// The IPC methods of Run on this computer, and the chat* methods they wrap so main keeps the keys. get: () => the
// AgentRuns. chat: the chat* methods as workspaces/ipc.js made them, whose arguments those check.
function runsApi(get, chat) {
  const id = (v, re) => {
    if (typeof v !== 'string' || !re.test(v)) throw new RunError('invalid');
    return v;
  };
  const plain = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
  return {
    chatCreateAgent: async (ws, input) => get().takeKey(ws, await chat.chatCreateAgent(ws, input)),
    chatNewAgentKey: async (ws, agent) => get().takeKey(ws, await chat.chatNewAgentKey(ws, agent), { renew: true }),
    chatRemoveAgent: async (ws, agent) => {
      const done = await chat.chatRemoveAgent(ws, agent);
      if (WS_ID.test(String(ws)) && MEMBER_ID.test(String(agent))) get().forget(ws, agent);
      return done;
    },
    agentRuns: () => get().snapshot(),
    agentRunStart: (ws, agent, opts) => {
      const o = plain(opts);
      return get().start(id(ws, WS_ID), id(agent, MEMBER_ID), { use: text(o.use).slice(0, 40), name: text(o.name).slice(0, 80) });
    },
    agentRunStop: (ws, agent) => get().stop(id(ws, WS_ID), id(agent, MEMBER_ID)),
    agentRunForget: (ws, agent) => get().forget(id(ws, WS_ID), id(agent, MEMBER_ID)),
    agentRunHeldKey: (ws, agent) => get().heldKey(id(ws, WS_ID), id(agent, MEMBER_ID)),
    agentRunRelease: (ws, agent) => get().release(id(ws, WS_ID), id(agent, MEMBER_ID))
  };
}

module.exports = { AgentRuns, RunError, runBackend, runsApi, runnerEnv, forkRunner, DELAYS, STEADY, HELD_FOR, RUNNER_CONTEXT, CHILD };
