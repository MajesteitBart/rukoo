'use strict';

// "Run on this computer" for team chat's agents (docs/chat.md, "Agents in channels"): Rukoo's desktop app runs an
// agent's runner (integrations/agent-runner) itself, one process per agent, while Rukoo runs, in the tray too. Nothing
// here ships in the browser app, which reaches src/main only through src/web/host.js.
//
// The window is the boundary. It may call any of the IPC methods below with any arguments, and nothing it does alone
// makes a runner execute a program or send a secret somewhere a person didn't approve, or hands it an agent's key.
//
// What a runner answers with. An agent of Settings, Agents (src/main/agents/config.js), by its id: main builds the
// backend from those settings (runBackend), never from what the window sends. Running it here takes a person's yes in
// a native question from main (ask), which names the agent and the program or the address: for Claude Code and Codex
// the program as the runner would find it and the folder of its settings, for Hermes, OpenClaw and custom agents the
// address the runner sends to. Main records what was approved (identify) and starts the runner only with exactly that;
// the backend's own secret, such as a Hermes API key, goes only to the approved address. When Settings later name
// another program or address, or the agent is off or gone there, the runner stops or doesn't start (phase 'changed')
// until someone runs it again and approves it as it is now.
//
// The agent's key. The server shows it once, when the agent is made and at New key; main takes it from those answers
// (takeKey) and the window gets them without it. Main holds it in memory for the window document that made the agent
// (hold, owner: its webContents), for ten minutes at most, and until that document navigates, reloads, crashes or
// closes, or the person signs out. Run on this computer stores it in agent-runs.json, encrypted with safeStorage
// (secrets.js), which uses up the hold; without a way to encrypt it (Linux without a keyring) the option isn't offered
// and nothing is stored. "Run it on another computer instead" is an export main carries out (exportConfig): it asks
// the person in a native question, then puts the config with the key on the clipboard or in a file itself. No call
// answers a key. New key for an agent set up here goes straight to its setup and restarts its runner.
//
// The process. agent-runner-child.js in an Electron utility process, which ends with Rukoo and never takes
// ELECTRON_RUN_AS_NODE. Its config, the key and the backend's secret go to it together in its first message and stay
// in its memory; no config file exists. One agent has one process at most, always: every start, stop and restart of an
// agent goes through queue() and waits for the old process to exit. A runner that ends by itself starts again after a
// pause that grows (DELAYS); one that ran STEADY without trouble starts the pauses over. Exit code 2 means the key
// stopped working: it stays stopped until New key. A setup goes with its agent, however main learns of it: removing
// it here, the workspace's directory (reconcile), leaving the workspace, or signing out. Setups belong to one sign-in,
// as the chat cache does: signing out, or a session or server other than the one they were made under, deletes them.
//
// What the window and the log hear of a runner: codes Rukoo defines and at most an HTTP status, never text a server or
// a backend wrote. A setups file that can't be written is an error for the caller, and nothing changes then, so what
// the window shows is what a restart does.
const crypto = require('crypto');
const EventEmitter = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeBackend } = require('../../integrations/agent-runner/backends.js');

const FILE = 'agent-runs.json';
const DIR = 'agent-runs';
const CHILD = path.join(__dirname, 'agent-runner-child.js');
// The pauses before the next start of a runner that ended by itself, the last one repeating.
const DELAYS = [2000, 5000, 15000, 30000, 60000, 120000, 300000];
// A runner that ran this long starts its pauses over when it ends.
const STEADY = 2 * 60 * 1000;
// How long main holds a new key for the document that made the agent.
const HELD_FOR = 10 * 60 * 1000;
// How long a runner gets to end a turn in flight and exit after it was asked to stop, before main ends its process.
// The runner itself waits up to 4 s for its turn (runner.js STOP_GRACE).
const STOP_WAIT = 5000;
// What the runner reads for each mention, as the config the key step shows (src/renderer/chat-agents.js).
const RUNNER_CONTEXT = Object.freeze({ threadMessages: 50, channelMessages: 20, maxChars: 30000 });
// The Settings agents a runner answers with: the built-in ones and custom ones on a server (cx_…).
const BUILT_IN = ['clark', 'openclaw', 'claude', 'codex'];
const CUSTOM_ID = /^cx_[a-z0-9]{10}$/;
const WS_ID = /^w_[A-Za-z0-9_-]{22}$/;
const MEMBER_ID = /^u_[A-Za-z0-9_-]{22}$/;
const AGENT_KEY = /^rka_[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/;
// "Answers with" A program of my own (src/renderer/chat-agents.js OWN_PROGRAM): only for the export.
const OWN_PROGRAM = 'own';
const PLACEHOLDER_BACKEND = Object.freeze({ type: 'command', command: 'my-agent' });
// The variables an exported config names for a backend's secret, as the key step shows them (chat-agents.js KEY_ENV).
const KEY_ENV = Object.freeze({ hermes: 'HERMES_API_KEY', openclaw: 'OPENCLAW_GATEWAY_TOKEN', custom: 'AGENT_API_KEY' });
// The codes a runner reports (agent-runner-child.js), the only words of a runner that reach the window.
const CODES = new Set(['offline', 'http', 'timeout', 'missing', 'exit', 'empty', 'failed', 'protocol', 'config', 'server', 'too_large', 'stopped', 'backend', 'unreachable', 'backend_key', 'key_env', 'placeholder', 'runner', 'other']);
// What an approval records, in this order.
const IDENTITY = ['use', 'kind', 'type', 'program', 'args', 'configDir', 'address', 'agent'];

const text = (v) => (typeof v === 'string' ? v.trim() : '');
const withModel = (backend, model) => (text(model) ? { ...backend, model: text(model) } : backend);
const idOf = (ws, agent) => `${ws} ${agent}`;
const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

class RunError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

// A custom agent's variable, as chat-agents.js customKeyEnv makes it: its name in capitals with _API_KEY.
function customKeyEnv(name) {
  const base = text(name)
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  if (!base) return KEY_ENV.custom;
  return /^[0-9]/.test(base) ? `AGENT_${base}_API_KEY` : `${base}_API_KEY`;
}

// The runner's backend for the Settings agent use, as the key step's config has it (chat-agents.js runnerAgents),
// with that agent's secret apart: { name, kind, backend, secret }, or null when use names no agent that is on and can
// answer. kind: hermes, openclaw, claude, codex or custom. cfg: the hub's AgentConfig, whose get() decrypts secrets.
function runBackend(cfg, use) {
  if (!cfg || typeof use !== 'string' || !(BUILT_IN.includes(use) || CUSTOM_ID.test(use))) return null;
  if (typeof cfg.enabled === 'function' && !cfg.enabled(use)) return null;
  const c = cfg.get(use);
  if (!c || c.enabled === false) return null;
  const name = typeof cfg.displayName === 'function' ? cfg.displayName(use) : use;
  if (use === 'clark') {
    if (!text(c.url)) return null;
    return { name, kind: 'hermes', backend: withModel({ type: 'runs', url: text(c.url) }, c.model), secret: text(c.key) };
  }
  if (use === 'openclaw') {
    if (!text(c.url)) return null;
    // OpenClaw's gateway speaks Chat Completions; its model names an OpenClaw agent. A backend model of Settings goes in
    // the x-openclaw-model header, as Rukoo sends it.
    const headers = text(c.model) ? { headers: { 'x-openclaw-model': text(c.model) } } : {};
    return { name, kind: 'openclaw', backend: { type: 'openai', url: text(c.url), model: `openclaw/${text(c.agent) || 'default'}`, ...headers }, secret: text(c.key) };
  }
  if (use === 'claude' || use === 'codex') {
    const exe = text(c.exe);
    const configDir = use === 'claude' ? text(c.configDir) : '';
    return { name, kind: use, backend: withModel({ type: use, ...(exe ? { exe } : {}), ...(configDir ? { configDir } : {}) }, c.model), secret: '' };
  }
  if (!text(c.url) || !['runs', 'openai'].includes(c.protocol)) return null;
  return { name: text(c.name) || name, kind: 'custom', backend: withModel({ type: c.protocol, url: text(c.url) }, c.model), secret: text(c.key) };
}

// The backend of the config "Run it on another computer instead" exports for use: runBackend's, with the variable a
// secret goes in on the other computer (keyEnv) instead of the secret, exactly as the key step shows it
// (chat-agents.js runnerAgents); the placeholder for A program of my own. null for anything else.
function exportBackend(cfg, use) {
  if (use === OWN_PROGRAM) return { ...PLACEHOLDER_BACKEND };
  const b = runBackend(cfg, use);
  if (!b) return null;
  if (!b.secret) return b.backend;
  const keyEnv = b.kind === 'custom' ? customKeyEnv(b.name) : KEY_ENV[b.kind];
  // The variable goes after url, as the key step's config has it.
  const { type, url, ...rest } = b.backend;
  return { type, url, keyEnv, ...rest };
}

// The program the runner would start for a Claude Code or Codex backend, found as it finds it (backends.js exe()):
// the path in Settings, else claude or codex on PATH or where its installer puts it. Throws RunError('missing').
function resolveProgram(type, exe) {
  try {
    return makeBackend({ type, ...(exe ? { exe } : {}) }).exe();
  } catch (_) {
    throw new RunError('missing');
  }
}

// An address as the runner sends to it: origin and path, without a query, fragment or credentials (backends.js
// endpoint() uses no more).
function addressOf(url) {
  let u;
  try {
    u = new URL(text(url));
  } catch (_) {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
}

// What a person approves when an agent runs here with b (runBackend's answer) for the Settings agent use: for a
// program, the program and the folder of its settings; for a server, its address, and for OpenClaw the OpenClaw agent
// it asks. Throws RunError('missing') for a program that isn't there. resolve(type, exe) and env/home: for the tests.
function identify(use, b, { resolve = resolveProgram, env = process.env, home = os.homedir() } = {}) {
  const be = (b && b.backend) || {};
  const out = { use, kind: b.kind || be.type };
  if (be.type === 'claude' || be.type === 'codex') {
    out.type = be.type;
    out.program = resolve(be.type, text(be.exe));
    // The folder its login and settings are in: Claude Code's from Settings or CLAUDE_CONFIG_DIR, Codex's CODEX_HOME.
    out.configDir = be.type === 'claude' ? text(be.configDir) || text(env.CLAUDE_CONFIG_DIR) || path.join(home, '.claude') : text(env.CODEX_HOME) || path.join(home, '.codex');
    return out;
  }
  if (be.type === 'command') {
    // Only a test's backendFor answers a command; runBackend never does.
    const argv = (Array.isArray(be.command) ? be.command : [be.command]).map(String);
    out.type = 'command';
    out.program = resolve('command', argv[0]);
    out.args = argv.slice(1);
    return out;
  }
  if (be.type !== 'runs' && be.type !== 'openai') throw new RunError('unknown_backend');
  const address = addressOf(be.url);
  if (!address) throw new RunError('unknown_backend');
  out.type = be.type;
  out.address = address;
  if (b.kind === 'openclaw') out.agent = text(be.model);
  return out;
}

// An identity with only its fields, in their order: for comparing, and for what agent-runs.json keeps.
function pickIdentity(v) {
  if (!isObj(v)) return null;
  const out = {};
  for (const k of IDENTITY) {
    if (v[k] === undefined) continue;
    if (k === 'args') {
      if (!Array.isArray(v.args)) return null;
      out.args = v.args.map(String);
    } else if (typeof v[k] === 'string') out[k] = v[k];
    else return null;
  }
  return out.use && out.type ? out : null;
}

const sameIdentity = (a, b) => Boolean(a && b) && JSON.stringify(pickIdentity(a)) === JSON.stringify(pickIdentity(b));

// The process of one runner: a utility process in Electron, a fork in plain Node (the tests). { post(msg),
// onMessage(fn), onExit(fn(code)), stderr, kill() }. kill() a second time ends it outright.
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
  let kills = 0;
  return {
    post: (msg) => {
      if (child.connected) child.send(msg, () => {});
    },
    onMessage: (fn) => child.on('message', fn),
    onExit: (fn) => child.on('exit', (code) => fn(code === null ? -1 : code)),
    stderr: child.stderr,
    kill: () => child.kill(++kills > 1 ? 'SIGKILL' : 'SIGTERM')
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

// A report's code, when it is one of CODES; else 'other'. A status, when it is an HTTP status; else null.
const codeOf = (v) => (typeof v === 'string' && CODES.has(v) ? v : 'other');
const statusOf = (v) => (Number.isSafeInteger(v) && v >= 100 && v <= 599 ? v : null);

class AgentRuns extends EventEmitter {
  // dataDir: the profile's data folder. secrets: secrets.js. canKeep(): whether a secret can be stored encrypted
  // (secrets.available). account: the AccountService, for the sign-in the setups belong to. backendFor(use): runBackend
  // for the hub's settings; exportFor(use): exportBackend for them. agentExists(ws, agent): a promise of whether the
  // workspace still has the agent (true, false or null when unknown), asked after a key stopped working.
  // ask(question): a promise of the id of the button the person chose in a native question from main ({ kind, message,
  // detail, buttons: [{ id, label }], cancel }); copy(text): the clipboard; saveTo(name): a promise of the file the
  // person picked in a native save dialog, or null. t: the catalogs. resolve, env, home, fork, child, delays, steady,
  // stopWait, heldFor and now can be replaced in tests. log(level, message): ids, states and codes only.
  constructor({
    dataDir,
    secrets,
    canKeep = () => false,
    account,
    backendFor = () => null,
    exportFor = () => null,
    agentExists = () => Promise.resolve(null),
    ask = async (q) => q.cancel,
    copy = () => {},
    saveTo = async () => null,
    t = require('../i18n').t,
    resolve = resolveProgram,
    env = process.env,
    home = os.homedir(),
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
    Object.assign(this, { secrets, canKeep, account, backendFor, exportFor, agentExists, ask, copy, saveTo, t, resolve, env, home, fork, child, delays, steady, stopWait, now, log });
    this.heldFor = heldFor || HELD_FOR;
    // { version, server, session, runs: [stored run] }. A stored run: { ws, agent, name, use, key, keyAt, on, refused,
    // stoppedAt, approved }. What only this run of Rukoo knows of each (what its runner reported) is in live, by id.
    this.data = { version: 1, server: null, session: null, runs: [] };
    this.live = new Map();
    // id → { child, exited, stopping, killTimer }: every runner process that hasn't exited yet, also of a setup that went.
    this.procs = new Map();
    // id → the end of the queue of that agent's starts and stops.
    this.ops = new Map();
    // id → { key, owner, timer }: the keys held for the window document that made the agent.
    this.held = new Map();
    this.asking = false;
    this.followed = null;
    this.closed = false;
    this.closing = null;
    this.onStatus = () => this.follow();
    // The file writes, for a test that makes them fail.
    this.writeFile = writePrivate;
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
        stoppedAt: Number.isFinite(r.stoppedAt) ? r.stoppedAt : null,
        approved: pickIdentity(r.approved)
      });
    }
    this.data = { version: 1, server: typeof saved.server === 'string' ? saved.server : null, session: typeof saved.session === 'string' ? saved.session : null, runs };
  }

  // Writes runs (with meta's server and session) and only then takes them: a write that fails throws
  // RunError('save_failed') and changes nothing.
  persist(runs, meta = this.data) {
    try {
      if (!runs.length) fs.rmSync(this.file, { force: true });
      else {
        const out = runs.map(({ ws, agent, name, use, key, keyAt, on, refused, stoppedAt, approved }) => ({ ws, agent, name, use, key, keyAt, on, refused, stoppedAt, approved }));
        this.writeFile(this.file, JSON.stringify({ version: 1, server: meta.server, session: meta.session, runs: out }));
      }
    } catch (err) {
      this.log('warn', `could not save the agent setups: ${typeof err.code === 'string' ? err.code : 'error'}`);
      throw new RunError('save_failed');
    }
    this.data = { version: 1, server: meta.server, session: meta.session, runs };
  }

  // The setup of id with changes, written and taken. Throws as persist does.
  update(id, changes) {
    const runs = this.data.runs.map((r) => (idOf(r.ws, r.agent) === id ? { ...r, ...changes } : r));
    this.persist(runs);
    return this.findId(id);
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
    for (const run of this.data.runs) if (run.on && !run.refused) this.queue(idOf(run.ws, run.agent), () => this.cycle(idOf(run.ws, run.agent), { restart: false })).catch(() => {});
    this.changed();
  }

  // Every runner stops, and every setup and held key goes, from disk too: again once each runner exited, as one that
  // stops can still write its state file.
  wipe(why) {
    const had = this.data.runs.length;
    this.data = { version: 1, server: null, session: null, runs: [] };
    for (const s of this.live.values()) clearTimeout(s.timer);
    this.live.clear();
    for (const h of this.held.values()) clearTimeout(h.timer);
    this.held.clear();
    for (const id of [...this.procs.keys()]) this.endProcess(id).then(() => !this.data.runs.length && this.removeFiles());
    this.removeFiles();
    if (had) this.log('info', `agent setups deleted: ${why}`);
    this.changed();
  }

  // ---- keys held for the window ----

  // Holds key for the window document owner (a webContents id) for heldFor. false for a key that isn't the agent's.
  hold(ws, agent, key, owner) {
    if (!WS_ID.test(ws) || !MEMBER_ID.test(agent) || typeof key !== 'string' || !AGENT_KEY.test(key) || key.slice(4, 26) !== agent.slice(2) || owner == null) return false;
    const id = idOf(ws, agent);
    this.drop(id);
    const timer = setTimeout(() => this.drop(id), this.heldFor);
    if (timer.unref) timer.unref();
    this.held.set(id, { key, owner, timer });
    return true;
  }

  // The hold of id when owner made it, or null.
  holdOf(id, owner) {
    const h = this.held.get(id);
    return h && owner != null && h.owner === owner ? h : null;
  }

  drop(id) {
    const h = this.held.get(id);
    if (!h) return false;
    clearTimeout(h.timer);
    this.held.delete(id);
    return true;
  }

  // The key step closed: its document lets go of the key it holds. Another document's hold stays.
  release(ws, agent, owner) {
    const id = idOf(ws, agent);
    return this.holdOf(id, owner) ? this.drop(id) : false;
  }

  // The document owner navigated, reloaded, crashed or closed: every key it held goes.
  releaseOwner(owner) {
    for (const [id, h] of [...this.held]) if (h.owner === owner) this.drop(id);
  }

  // What chatCreateAgent and chatNewAgentKey answer the window: the server's answer without the key. renew: New key,
  // which goes straight to the agent's setup here when it has one (runsHere) and else is held for owner.
  takeKey(ws, answer, { renew = false, owner = null } = {}) {
    if (!answer || typeof answer !== 'object' || typeof answer.key !== 'string' || !answer.agent || typeof answer.agent.id !== 'string') return answer;
    const { key, ...rest } = answer;
    const agent = answer.agent.id;
    const runsHere = renew && Boolean(this.find(ws, agent));
    if (runsHere) this.replaceKey(ws, agent, key);
    else this.hold(ws, agent, key, owner);
    return { ...rest, held: this.holdOf(idOf(ws, agent), owner) !== null, runsHere };
  }

  // ---- setups ----

  find(ws, agent) {
    return this.data.runs.find((r) => r.ws === ws && r.agent === agent) || null;
  }

  findId(id) {
    return this.data.runs.find((r) => idOf(r.ws, r.agent) === id) || null;
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

  // What runs for use now, as identify() says, or null when Settings have no such agent that is on.
  current(use) {
    const b = this.backendFor(use);
    if (!b) return null;
    return { b, identity: identify(use, b, { resolve: this.resolve, env: this.env, home: this.home }) };
  }

  // One native question at a time: a second one while the first is open is refused.
  async askOnce(question) {
    if (this.asking) throw new RunError('busy');
    this.asking = true;
    try {
      const answer = await this.ask(question);
      return question.buttons.some((b) => b.id === answer) ? answer : question.cancel;
    } finally {
      this.asking = false;
    }
  }

  // The question before an agent runs here with what identity names, in plain words.
  approvalQuestion(name, b, identity) {
    const t = this.t;
    const use = identity.kind === 'claude' ? 'Claude Code' : identity.kind === 'codex' ? 'Codex' : b.name;
    const agent = text(name) || t('native.agentRuns.thisAgent');
    const detail = identity.address
      ? t('native.agentRuns.runServer', { name: agent, use, address: identity.address })
      : t('native.agentRuns.runProgram', { name: agent, use, program: [identity.program, ...(identity.args || [])].join(' '), folder: identity.configDir || '' });
    return {
      kind: 'run',
      message: t('native.agentRuns.runTitle', { name: agent, use }),
      detail,
      buttons: [
        { id: 'cancel', label: t('common.actions.cancel') },
        { id: 'run', label: t('native.agentRuns.run') }
      ],
      cancel: 'cancel'
    };
  }

  // Run on this computer, or Start: the key this document holds when it has one, else the stored key. use: the
  // Settings agent that answers (the stored one when left out). name: the agent's name, for the list and the process.
  // owner: the window document that asks. Asks the person first unless the setup already runs exactly this.
  async start(ws, agent, { use = '', name = '', owner = null } = {}) {
    if (this.closed) throw new RunError('closed');
    if (!WS_ID.test(ws) || !MEMBER_ID.test(agent)) throw new RunError('invalid');
    if (!this.signedIn()) throw new RunError('signed_out');
    if (!this.canKeep()) throw new RunError('no_keyring');
    const id = idOf(ws, agent);
    const existing = this.find(ws, agent);
    if (!this.holdOf(id, owner) && !existing) throw new RunError('no_key');
    if (existing && existing.refused && !this.holdOf(id, owner)) throw new RunError('refused');
    const wanted = text(use) || (existing && existing.use) || '';
    const now = this.current(wanted);
    if (!now) throw new RunError('unknown_backend');
    const label = text(name) || (existing && existing.name) || '';
    if (!(existing && existing.use === wanted && sameIdentity(existing.approved, now.identity))) {
      const answer = await this.askOnce(this.approvalQuestion(label, now.b, now.identity));
      if (answer !== 'run') throw new RunError('declined');
    }
    return this.queue(id, async () => {
      if (this.closed) throw new RunError('closed');
      if (!this.signedIn()) throw new RunError('signed_out');
      // Settings that changed while the question was open don't run: what runs is what the person saw.
      const again = this.current(wanted);
      if (!again) throw new RunError('unknown_backend');
      if (!sameIdentity(again.identity, now.identity)) throw new RunError('changed');
      const h = this.holdOf(id, owner);
      const run = this.find(ws, agent);
      if (!h && !run) throw new RunError('no_key');
      const key = h ? this.encrypt(h.key) : null;
      const at = this.now();
      const next = {
        ...(run || { ws, agent, name: '', key: null, keyAt: at, refused: false }),
        ...(key ? { key, keyAt: at, refused: false } : {}),
        name: label.slice(0, 80),
        use: wanted,
        on: true,
        stoppedAt: null,
        approved: pickIdentity(now.identity)
      };
      const status = this.signature();
      this.persist(run ? this.data.runs.map((r) => (r === run ? next : r)) : [...this.data.runs, next], { server: status.server, session: status.session });
      // The key is on this computer now, encrypted: no document holds it any more.
      if (h) this.drop(id);
      const s = this.state(id);
      s.failures = 0;
      this.log('info', `${agent} runs on this computer with ${wanted}`);
      await this.cycle(id, { restart: true });
      return this.view(this.findId(id));
    });
  }

  async stop(ws, agent) {
    if (!WS_ID.test(ws) || !MEMBER_ID.test(agent)) throw new RunError('invalid');
    const id = idOf(ws, agent);
    if (!this.find(ws, agent)) throw new RunError('not_found');
    return this.queue(id, async () => {
      const run = this.findId(id);
      if (!run) throw new RunError('not_found');
      this.update(id, { on: false, stoppedAt: this.now() });
      const s = this.state(id);
      this.clearTimer(s);
      if (!['refused', 'changed'].includes(s.phase)) s.phase = run.refused ? 'refused' : 'stopped';
      this.log('info', `${agent} stopped on this computer`);
      this.changed();
      await this.endProcess(id);
      return this.view(this.findId(id));
    });
  }

  // The setup goes: its runner stops and its key and state file are deleted. Answers whether it had one.
  async forget(ws, agent) {
    if (!WS_ID.test(ws) || !MEMBER_ID.test(agent)) throw new RunError('invalid');
    const id = idOf(ws, agent);
    this.drop(id);
    return this.queue(id, async () => {
      if (!this.findId(id)) return false;
      this.persist(this.data.runs.filter((r) => idOf(r.ws, r.agent) !== id));
      const s = this.live.get(id);
      if (s) this.clearTimer(s);
      this.live.delete(id);
      this.log('info', `${agent} no longer runs on this computer`);
      this.changed();
      await this.endProcess(id);
      if (!this.findId(id)) this.removeFiles(id);
      return true;
    });
  }

  forgetWorkspace(ws) {
    for (const run of this.data.runs.filter((r) => r.ws === ws)) this.forget(run.ws, run.agent).catch(() => {});
    for (const id of [...this.held.keys()]) if (id.startsWith(`${ws} `)) this.drop(id);
  }

  // The workspace's directory as the app loaded it now (GET /members, store.listMembers): a setup whose agent isn't an
  // active member of it goes, whether its runner runs, stopped or was refused. A directory with no active person in it
  // says nothing. Setups are only ever of the person's own agents, which the directory of a full member always lists
  // while they are active, and which the server removes when the person becomes a guest.
  reconcile(ws, members) {
    if (!Array.isArray(members) || !members.some((m) => m && m.kind !== 'agent' && m.state === 'active')) return;
    const active = new Set(members.filter((m) => m && m.state === 'active').map((m) => m.id));
    for (const run of this.data.runs.filter((r) => r.ws === ws)) {
      if (active.has(run.agent)) continue;
      this.log('info', `${run.agent} is no longer in the workspace`);
      this.forget(run.ws, run.agent).catch(() => {});
    }
  }

  // New key: the setup takes the new key, and a runner that is on starts again with it. Answers whether the agent has
  // a setup here.
  replaceKey(ws, agent, key) {
    const id = idOf(ws, agent);
    const run = this.findId(id);
    if (!run) return false;
    let next;
    try {
      next = this.update(id, { key: this.encrypt(key), keyAt: this.now(), refused: false });
    } catch (_) {
      // The old key stopped at the server and the new one can't be kept: the runner stays stopped, as after a restart.
      const s = this.state(id);
      s.phase = 'refused';
      try {
        this.update(id, { refused: true });
      } catch (__) {
        // A restart tries the old key, which the server refuses.
      }
      this.queue(id, () => this.endProcess(id)).catch(() => {});
      this.changed();
      return true;
    }
    if (next.on) {
      this.state(id).failures = 0;
      this.queue(id, () => this.cycle(id, { restart: true })).catch(() => {});
    } else this.changed();
    return true;
  }

  // "Run it on another computer instead": the config the key step shows for use, with the key this document holds, on
  // the clipboard or in a file the person picks, after they said so in a native question. { done: 'copied' | 'saved'
  // | null }. The key never goes to the window.
  async exportConfig(ws, agent, { use = '', name = '', owner = null } = {}) {
    if (!WS_ID.test(ws) || !MEMBER_ID.test(agent)) throw new RunError('invalid');
    if (!this.signedIn()) throw new RunError('signed_out');
    const id = idOf(ws, agent);
    if (!this.holdOf(id, owner)) throw new RunError('no_key');
    const backend = this.exportFor(text(use));
    if (!backend) throw new RunError('unknown_backend');
    const t = this.t;
    const run = this.find(ws, agent);
    const label = text(name) || (run && run.name) || t('native.agentRuns.thisAgent');
    const answer = await this.askOnce({
      kind: 'export',
      message: t('native.agentRuns.exportTitle', { name: label }),
      detail: t('native.agentRuns.exportBody', { name: label }),
      buttons: [
        { id: 'cancel', label: t('common.actions.cancel') },
        { id: 'save', label: t('native.agentRuns.save') },
        { id: 'copy', label: t('native.agentRuns.copy') }
      ],
      cancel: 'cancel'
    });
    if (answer === 'cancel') return { done: null };
    // The document navigated or the hold ran out while the question was open.
    const h = this.holdOf(id, owner);
    if (!h) throw new RunError('no_key');
    const config = { server: String(this.signature().server || '').replace(/\/+$/, ''), workspace: ws, key: h.key, backend, context: { ...RUNNER_CONTEXT }, instructions: '' };
    const out = `${JSON.stringify(config, null, 2)}\n`;
    if (answer === 'copy') {
      this.copy(out);
      return { done: 'copied' };
    }
    const file = await this.saveTo('agent.json');
    if (!file) return { done: null };
    try {
      this.writeFile(file, out);
    } catch (_) {
      throw new RunError('save_failed');
    }
    return { done: 'saved' };
  }

  // Settings, Agents changed: a runner whose Settings agent now names another program or address, or is off or gone,
  // stops until it is run again; one with other details (a model, a secret) starts again with them.
  settingsChanged() {
    for (const run of this.data.runs) {
      const id = idOf(run.ws, run.agent);
      const s = this.live.get(id);
      if (!run.on || run.refused || !s || !this.procs.has(id)) continue;
      let now = null;
      try {
        now = this.current(run.use);
      } catch (_) {
        now = null;
      }
      if (now && sameIdentity(now.identity, run.approved)) {
        if (this.fingerprint(now.b, now.identity) !== s.fingerprint) this.queue(id, () => this.cycle(id, { restart: true })).catch(() => {});
        continue;
      }
      this.queue(id, async () => {
        const st = this.live.get(id);
        if (st) this.mark(st, 'changed', { gone: !now });
        await this.endProcess(id);
      }).catch(() => {});
    }
  }

  // The computer woke: what each runner said before is stale until its next pass, which a wake asks for now.
  resume() {
    for (const [id, s] of this.live) {
      const p = this.procs.get(id);
      if (!p || s.child !== p.child) continue;
      s.stale = true;
      try {
        p.child.post({ type: 'wake' });
      } catch (_) {
        // Gone; its exit follows.
      }
    }
    this.changed();
  }

  // The state file of a setup, and the config file an earlier version kept next to it.
  files(id) {
    const base = path.join(this.dir, id.replace(' ', '-'));
    return [`${base}.state.json`, `${base}.json`];
  }

  // ---- processes ----

  // The ops of one agent, one after the other: fn runs once the one before it ended, however that ended.
  queue(id, fn) {
    const before = this.ops.get(id) || Promise.resolve();
    const run = before.then(() => fn());
    const tail = run.then(
      () => {},
      () => {}
    );
    this.ops.set(id, tail);
    tail.then(() => {
      if (this.ops.get(id) === tail) this.ops.delete(id);
    });
    return run;
  }

  // What only this run of Rukoo knows of a setup: what its runner reported. Made only for a setup that exists.
  state(id) {
    let s = this.live.get(id);
    if (!s) {
      const run = this.findId(id);
      s = {
        phase: run && run.refused ? 'refused' : run && run.on ? 'starting' : 'stopped',
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
        gone: false,
        stale: false,
        fingerprint: null,
        stderr: []
      };
      this.live.set(id, s);
    }
    return s;
  }

  clearTimer(s) {
    clearTimeout(s.timer);
    s.timer = null;
    s.retryAt = null;
  }

  mark(s, phase, { gone = false } = {}) {
    s.phase = phase;
    s.gone = gone;
    this.changed();
  }

  // What a runner was started with, as a hash: Settings that changed only this restart it.
  fingerprint(b, identity) {
    return crypto.createHash('sha256').update(JSON.stringify([b.backend, b.secret, identity])).digest('hex');
  }

  // Inside queue(): brings the agent's process in line with its setup. restart: ends a process that runs first; else
  // a running process stays.
  async cycle(id, { restart }) {
    if (!restart && this.procs.has(id)) return;
    await this.endProcess(id);
    this.spawn(id);
  }

  // Starts the agent's runner, when its setup is on, it is signed in, and Settings still have what was approved.
  // Only from cycle(), after the old process exited.
  spawn(id) {
    const run = this.findId(id);
    if (!run || !run.on || run.refused || this.closed || !this.signedIn() || this.procs.has(id)) return;
    const s = this.state(id);
    this.clearTimer(s);
    s.error = null;
    s.gone = false;
    const fail = (code) => {
      s.phase = 'error';
      s.error = { code };
      this.log('warn', `${run.agent} can't start: ${code}`);
      this.changed();
    };
    let now;
    try {
      now = this.current(run.use);
    } catch (err) {
      return fail(err instanceof RunError ? err.code : 'unknown_backend');
    }
    if (!now || !sameIdentity(now.identity, run.approved)) {
      this.log('warn', `${run.agent} answers with something that changed in Settings, Agents: it runs again once approved`);
      return this.mark(s, 'changed', { gone: !now });
    }
    let key = '';
    try {
      key = this.secrets.decrypt(run.key);
    } catch (_) {
      key = '';
    }
    if (!AGENT_KEY.test(key)) return fail('key_unreadable');
    const identity = now.identity;
    const backend = { ...now.b.backend };
    // The program that was approved, as it was found then.
    if (identity.type === 'claude' || identity.type === 'codex') backend.exe = identity.program;
    // The backend's secret goes only to the address that was approved.
    const secret = identity.address ? (addressOf(backend.url) === identity.address ? now.b.secret || '' : '') : now.b.secret || '';
    const config = {
      server: this.data.server,
      workspace: run.ws,
      backend,
      context: { ...RUNNER_CONTEXT },
      instructions: '',
      state: this.files(id)[0],
      // The app's own server: the key goes where the app's session goes already, also over plain http.
      ...(/^http:/i.test(String(this.data.server || '')) ? { allowHttp: true } : {})
    };
    let child;
    try {
      child = this.fork(this.child, [], { env: runnerEnv(this.env), serviceName: `Rukoo agent ${run.name || run.agent}` });
    } catch (_) {
      return fail('spawn');
    }
    // key: the stored key it runs with, so a refusal of a key that New key replaced meanwhile isn't this setup's.
    const proc = { child, stopping: false, killTimer: null, done: null, key: run.key };
    proc.exited = new Promise((resolve) => (proc.done = resolve));
    this.procs.set(id, proc);
    Object.assign(s, { child, phase: 'starting', startedAt: this.now(), connectedAt: null, problems: [], unreachable: null, failure: null, stale: false, stderr: [], fingerprint: this.fingerprint(now.b, identity) });
    if (child.stderr) {
      child.stderr.setEncoding('utf8');
      // Read, or the pipe fills and the runner stalls. The last lines stay in memory only: the child keeps the key
      // and the backend's secret out of them, but they can quote what a server or a backend said.
      child.stderr.on('data', (d) => {
        s.stderr = s.stderr.concat(String(d).split('\n').filter(Boolean)).slice(-20);
      });
    }
    child.onMessage((msg) => this.report(id, child, msg));
    child.onExit((code) => {
      clearTimeout(proc.killTimer);
      if (this.procs.get(id) === proc) this.procs.delete(id);
      proc.done();
      this.exited(id, child, code, proc);
    });
    child.post({ type: 'start', config, key, backendKey: secret });
    this.log('info', `${run.agent} starting`);
    this.changed();
  }

  report(id, child, msg) {
    const s = this.live.get(id);
    if (!s || s.child !== child || !msg || msg.type !== 'report' || !isObj(msg.event)) return;
    const e = msg.event;
    const now = this.now();
    const coded = () => ({ code: codeOf(e.code), status: statusOf(e.status), at: now });
    switch (e.type) {
      case 'connected':
        s.phase = 'running';
        s.connectedAt = now;
        s.unreachable = null;
        s.stale = false;
        break;
      case 'problems':
        s.problems = (Array.isArray(e.problems) ? e.problems : []).slice(0, 5).map((p) => ({ code: codeOf(p && p.code) }));
        break;
      case 'pass': {
        // A pass comes at every wake and every 30 seconds: the window hears of one when what it shows changed, and
        // of the time of the last one at most once a minute.
        const channels = Number.isSafeInteger(e.channels) ? e.channels : null;
        const same = s.phase === 'running' && !s.unreachable && !s.stale && s.channels === channels && s.passAt && now - s.passAt < 60000;
        if (s.phase === 'starting') s.phase = 'running';
        s.unreachable = null;
        s.stale = false;
        s.channels = channels;
        if (same) return;
        s.passAt = now;
        break;
      }
      case 'unreachable':
        s.unreachable = coded();
        s.stale = false;
        break;
      case 'answered':
        s.answeredAt = now;
        s.failure = null;
        break;
      case 'failed':
        s.failure = coded();
        break;
      case 'refused':
        s.refusedSeen = true;
        break;
      case 'error':
        s.error = { code: codeOf(e.code) };
        break;
      default:
        return;
    }
    this.changed();
  }

  exited(id, child, code, proc) {
    const s = this.live.get(id);
    // A process that is no longer tracked: its setup went, or another process took over. Nothing to say.
    if (!s || s.child !== child) return;
    s.child = null;
    const run = this.findId(id);
    if (!run) {
      this.live.delete(id);
      return;
    }
    const ranFor = s.startedAt ? this.now() - s.startedAt : 0;
    const refused = code === 2 || s.refusedSeen;
    s.refusedSeen = false;
    if (refused && run.key === proc.key) {
      s.phase = 'refused';
      try {
        this.update(id, { refused: true, stoppedAt: this.now() });
      } catch (_) {
        // A restart tries the key again, which the server refuses again.
      }
      this.log('warn', `${run.agent}'s key stopped working`);
      this.changed();
      // A removed agent's setup goes; one whose key was replaced elsewhere waits for New key here. The workspace's
      // directory says the same when it next loads (reconcile).
      Promise.resolve()
        .then(() => this.agentExists(run.ws, run.agent))
        .then(
          (exists) => {
            const now = this.findId(id);
            if (exists === false && now && now.refused) this.forget(run.ws, run.agent).catch(() => {});
          },
          () => {}
        );
      return;
    }
    // Asked to stop: whoever asked says what it is now.
    if (proc.stopping || !run.on || this.closed) {
      if (!run.on && !['refused', 'changed'].includes(s.phase)) s.phase = 'stopped';
      this.changed();
      return;
    }
    // Ended by itself: a crash, or a config or startup problem. It starts again after a pause.
    if (ranFor >= this.steady) s.failures = 0;
    const wait = this.delays[Math.min(s.failures, this.delays.length - 1)];
    s.failures += 1;
    s.phase = 'waiting';
    if (!s.error) s.error = { code: 'crashed' };
    s.retryAt = this.now() + wait;
    this.log('warn', `${run.agent} ended with code ${Number.isSafeInteger(code) ? code : '?'}; starting again in ${Math.round(wait / 1000)} s`);
    const timer = setTimeout(() => {
      if (s.timer !== timer) return;
      s.timer = null;
      this.queue(id, () => this.cycle(id, { restart: false })).catch(() => {});
    }, wait);
    s.timer = timer;
    if (timer.unref) timer.unref();
    this.changed();
  }

  // Asks the agent's runner to stop and ends its process when it hasn't exited after stopWait. A promise of its exit;
  // at once without one.
  endProcess(id) {
    const p = this.procs.get(id);
    if (!p) return Promise.resolve();
    if (!p.stopping) {
      p.stopping = true;
      try {
        p.child.post({ type: 'stop' });
      } catch (_) {
        // Gone already; its exit follows.
      }
      const kill = () => {
        try {
          p.child.kill();
        } catch (_) {
          // Gone already.
        }
      };
      p.killTimer = setTimeout(() => {
        this.log('warn', `${id.split(' ')[1]} did not stop in time; its process was ended`);
        kill();
        // A process that ignored the first ending gets the second.
        p.killTimer = setTimeout(kill, 1000);
        if (p.killTimer.unref) p.killTimer.unref();
      }, this.stopWait);
      if (p.killTimer.unref) p.killTimer.unref();
    }
    return p.exited;
  }

  // Deletes a setup's state file, or every setup's folder and the setups file.
  removeFiles(id = null) {
    try {
      if (id) for (const f of this.files(id)) fs.rmSync(f, { force: true });
      else {
        fs.rmSync(this.file, { force: true });
        fs.rmSync(this.dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      }
    } catch (err) {
      this.log('warn', `could not delete an agent setup: ${typeof err.code === 'string' ? err.code : 'error'}`);
    }
  }

  // Rukoo quits: every runner is asked to stop, and the setups stay as they are for the next start. A promise of every
  // runner's exit, which comes within stopWait and a second: main's quit waits for it.
  close() {
    if (this.closing) return this.closing;
    this.closed = true;
    if (this.account && typeof this.account.removeListener === 'function') this.account.removeListener('status', this.onStatus);
    for (const s of this.live.values()) this.clearTimer(s);
    for (const h of this.held.values()) clearTimeout(h.timer);
    this.held.clear();
    this.closing = Promise.all([...this.procs.keys()].map((id) => this.endProcess(id))).then(() => {});
    return this.closing;
  }

  // Whether a runner process still runs, for main's quit.
  busy() {
    return this.procs.size > 0;
  }

  // ---- what the window sees ----

  // One setup as the window sees it: never its key, never a runner's text.
  view(run) {
    if (!run) return null;
    const s = this.state(idOf(run.ws, run.agent));
    return {
      ws: run.ws,
      agent: run.agent,
      name: run.name,
      use: run.use,
      on: run.on,
      phase: s.phase,
      gone: s.gone,
      stale: s.stale,
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
// AgentRuns. chat: the chat* methods as workspaces/ipc.js made them, whose arguments those check. windowApi's methods
// take the sender first (main.js windowApi): the document that made an agent is the one that holds its key. Nothing
// here answers a key.
function runsApi(get, chat) {
  const id = (v, re) => {
    if (typeof v !== 'string' || !re.test(v)) throw new RunError('invalid');
    return v;
  };
  const plain = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
  const owner = (sender) => (sender && Number.isSafeInteger(sender.id) ? sender.id : null);
  const api = {
    chatRemoveAgent: async (ws, agent) => {
      const done = await chat.chatRemoveAgent(ws, agent);
      if (WS_ID.test(String(ws)) && MEMBER_ID.test(String(agent))) await get().forget(ws, agent).catch(() => {});
      return done;
    },
    agentRuns: () => get().snapshot(),
    agentRunStop: (ws, agent) => get().stop(id(ws, WS_ID), id(agent, MEMBER_ID)),
    agentRunForget: (ws, agent) => get().forget(id(ws, WS_ID), id(agent, MEMBER_ID))
  };
  const windowApi = {
    chatCreateAgent: async (sender, ws, input) => get().takeKey(ws, await chat.chatCreateAgent(ws, input), { owner: owner(sender) }),
    chatNewAgentKey: async (sender, ws, agent) => get().takeKey(ws, await chat.chatNewAgentKey(ws, agent), { renew: true, owner: owner(sender) }),
    agentRunStart: (sender, ws, agent, opts) => {
      const o = plain(opts);
      return get().start(id(ws, WS_ID), id(agent, MEMBER_ID), { use: text(o.use).slice(0, 40), name: text(o.name).slice(0, 80), owner: owner(sender) });
    },
    agentRunExport: (sender, ws, agent, opts) => {
      const o = plain(opts);
      return get().exportConfig(id(ws, WS_ID), id(agent, MEMBER_ID), { use: text(o.use).slice(0, 40), name: text(o.name).slice(0, 80), owner: owner(sender) });
    },
    agentRunRelease: (sender, ws, agent) => get().release(id(ws, WS_ID), id(agent, MEMBER_ID), owner(sender))
  };
  return { api, windowApi };
}

module.exports = { AgentRuns, RunError, runBackend, exportBackend, identify, resolveProgram, runsApi, runnerEnv, forkRunner, customKeyEnv, DELAYS, STEADY, HELD_FOR, STOP_WAIT, RUNNER_CONTEXT, CHILD };
