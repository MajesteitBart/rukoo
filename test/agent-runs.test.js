'use strict';

// "Run on this computer" (src/main/agent-runs.js): the supervisor that runs a team chat agent's runner in a process of
// its own. The first cases use a fake child whose boot, reports and exit the test controls, for the orders a window,
// a crash and the server can bring things in. The later ones run the real child against the real account server
// (test/fixtures/real-server.js), with the command backend and a scripted fake agent; plain Node forks the process
// where Electron makes a utility process. The keys are kept with a stand-in for safeStorage that marks what it
// encrypted. The server cases need server/node_modules (npm ci --prefix server); they skip without it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { EventEmitter } = require('events');
const { tempDir } = require('./tmp');
const { startRealServer, realServerAvailable, skipWithoutServer, mention } = require('./fixtures/real-server');
const { AgentRuns, RunError, runBackend, exportBackend, runnerEnv, runsApi, identify, canonicalProgram, ownNetwork, plainHttp, writePrivate } = require('../src/main/agent-runs.js');
const { AgentConfig } = require('../src/main/agents/config.js');

// Reads the prompt and answers FAKE_REPLY; notes in FAKE_LOG whether a key, or the backend's secret, reached it.
const FAKE = `'use strict';
const fs = require('fs');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', () => {
  const env = Object.entries(process.env);
  const leaked = env.some(([k, v]) => k.toUpperCase() === 'RUKOO_AGENT_KEY' || String(v).includes('rka_') || String(v).includes('backend-secret-value'));
  if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ leaked, pid: process.pid }) + '\\n');
  if (process.env.FAKE_WAIT) return setTimeout(() => process.stdout.write(process.env.FAKE_REPLY || 'Hello from here.'), Number(process.env.FAKE_WAIT));
  process.stdout.write(process.env.FAKE_REPLY || 'Hello from here.');
});
`;

const W = 'w_AbCdEfGhIjKlMnOpQrStUv';
const A = `u_${'a'.repeat(22)}`;
const B = `u_${'b'.repeat(22)}`;
const KEY = `rka_${'a'.repeat(22)}.${'b'.repeat(43)}`;
const KEY_B = `rka_${'b'.repeat(22)}.${'c'.repeat(43)}`;
const HOME = path.resolve('/home/me');
const TEAM = path.join(HOME, '.claude-team');
const KEY_NEW = `rka_${'a'.repeat(22)}.${'d'.repeat(43)}`;

let server;
let dir;
let fakePath;
test.before(async () => {
  dir = tempDir('rukoo-agent-runs-');
  fakePath = path.join(dir, 'fake-agent.js');
  fs.writeFileSync(fakePath, FAKE);
  if (realServerAvailable()) server = await startRealServer();
});
test.after(() => server?.close());

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref());
// Polls check every few ms; one that asks the server every 250 ms (every), within its allowance of about 8 reads a
// second per account.
async function until(check, ms, what, every = 20) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`Timed out after ${ms} ms waiting for ${what}`);
    await sleep(every);
  }
}

// safeStorage as secrets.js uses it, readable by the test: enc: and base64 of a marked string.
function fakeSecrets() {
  return {
    encrypt: (s) => `enc:${Buffer.from(`sealed:${s}`).toString('base64')}`,
    decrypt: (v) => {
      const s = String(v || '');
      if (!s.startsWith('enc:')) return s;
      const t = Buffer.from(s.slice(4), 'base64').toString();
      if (!t.startsWith('sealed:')) throw new Error('bad');
      return t.slice(7);
    }
  };
}

// The account as AgentRuns follows it: signed in to server under a session tag, until signOut().
function fakeAccount(url, tag = 'session-one') {
  const a = new EventEmitter();
  a.signed = true;
  a.server = url;
  a.sessionTag = tag;
  a.status = () => ({ signedIn: a.signed, server: a.server });
  a.signOut = () => {
    a.signed = false;
    a.sessionTag = null;
    a.emit('status');
  };
  return a;
}

// Processes the test drives. Each one records what main posted to it; exit(code) ends it, say(event) reports. alive()
// lists those that haven't ended, and most: the most that were alive at once.
function fakeForks() {
  const all = [];
  let most = 0;
  const fork = (file, args, opts) => {
    const c = { posts: [], alive: true, killed: 0, opts, msg: [], ends: [] };
    c.post = (m) => {
      if (c.alive) c.posts.push(m);
    };
    c.onMessage = (fn) => c.msg.push(fn);
    c.onExit = (fn) => c.ends.push(fn);
    c.stderr = null;
    // A kill ends it, as it ends a real one.
    c.kill = () => {
      c.killed += 1;
      c.exit(-1);
    };
    c.exit = (code = 0) => {
      if (!c.alive) return;
      c.alive = false;
      for (const fn of c.ends) fn(code);
    };
    c.say = (event) => {
      for (const fn of c.msg) fn({ type: 'report', event });
    };
    c.types = () => c.posts.map((p) => p.type);
    all.push(c);
    most = Math.max(most, all.filter((x) => x.alive).length);
    return c;
  };
  fork.all = all;
  fork.alive = () => all.filter((c) => c.alive);
  fork.most = () => most;
  return fork;
}

// Settings, Agents as backendFor answers it: claude and codex as programs, clark (Hermes) and a custom agent on servers.
// over: changes to an agent's answer, by id; null leaves the agent out (off or removed).
function fakeBackends(over = {}) {
  const base = {
    claude: { name: 'Claude', kind: 'claude', backend: { type: 'claude', exe: '' }, secret: '' },
    codex: { name: 'Codex', kind: 'codex', backend: { type: 'codex' }, secret: '' },
    clark: { name: 'Hermes', kind: 'hermes', backend: { type: 'runs', url: 'http://127.0.0.1:8642' }, secret: 'hermes-secret-value' }
  };
  return (use) => {
    if (Object.prototype.hasOwnProperty.call(over, use)) return over[use] ? { ...base[use], ...over[use], backend: { ...base[use].backend, ...(over[use].backend || {}) } } : null;
    return base[use] || null;
  };
}

let counter = 0;
// An AgentRuns on a profile of its own. ask answers every question with 'run' unless the test says otherwise.
function makeRuns(o = {}) {
  const dataDir = o.dataDir || path.join(dir, `profile-${++counter}`);
  const logFile = path.join(dir, `calls-${counter}.jsonl`);
  const lines = [];
  const asked = [];
  const runs = new AgentRuns({
    dataDir,
    secrets: o.secrets || fakeSecrets(),
    canKeep: o.canKeep || (() => true),
    account: o.account || fakeAccount(server ? server.url : 'https://rukoo.example'),
    backendFor:
      o.backendFor ||
      ((use) =>
        use === 'claude' || use === 'clark'
          ? {
              name: use === 'clark' ? 'Hermes' : 'Claude',
              kind: use === 'clark' ? 'hermes' : 'claude',
              backend: { type: 'command', command: [process.execPath, fakePath], env: { FAKE_LOG: logFile, FAKE_REPLY: `Answered with ${use}.`, ...(o.fakeEnv || {}) }, timeout: 30 },
              secret: use === 'clark' ? 'backend-secret-value' : ''
            }
          : null),
    exportFor: o.exportFor || ((use) => (use === 'own' ? { type: 'command', command: 'my-agent' } : use === 'claude' ? { type: 'claude' } : null)),
    resolve: o.resolve || ((type, exe) => (type === 'command' ? exe : exe || `/usr/bin/${type}`)),
    env: o.env || { HOME },
    home: HOME,
    memberName: o.memberName || ((ws, id) => (id === A ? 'Clark' : id === B ? 'Bea' : '')),
    ...(o.ownerAlive ? { ownerAlive: o.ownerAlive } : {}),
    agentExists: o.agentExists,
    ask: async (q) => {
      asked.push(q);
      return o.ask ? o.ask(q) : q.kind === 'run' ? 'run' : 'save';
    },
    saveTo: o.saveTo || (async () => null),
    delays: o.delays || [100, 200, 400],
    steady: o.steady || 60000,
    stopWait: o.stopWait || 2000,
    heldFor: o.heldFor,
    ...(o.fork ? { fork: o.fork } : {}),
    log: (level, message) => lines.push(`${level} ${message}`)
  }).init();
  return { runs, dataDir, lines, asked, logFile, calls: () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []) };
}

const phaseOf = (runs, ws, agent) => runs.snapshot().runs.find((r) => r.ws === ws && r.agent === agent)?.phase;
const viewOf = (runs, ws, agent) => runs.snapshot().runs.find((r) => r.ws === ws && r.agent === agent);
const rejects = (promise, code) => assert.rejects(promise, (err) => err instanceof RunError && err.code === code);

// What a profile holds, every file read as text: no agent key or backend secret in the clear.
function profileText(dataDir) {
  const out = [];
  const walk = (d) => {
    for (const name of fs.existsSync(d) ? fs.readdirSync(d) : []) {
      const f = path.join(d, name);
      if (fs.statSync(f).isDirectory()) walk(f);
      else out.push(fs.readFileSync(f, 'utf8'));
    }
  };
  walk(dataDir);
  return out.join('\n');
}

// ---- One process per agent, whatever order things come in ----

test('a second start while the first runner boots waits for its exit, and each runner gets its config and secrets in one message', async (t) => {
  const forks = fakeForks();
  const a = makeRuns({ fork: forks, backendFor: fakeBackends() });
  t.after(() => a.runs.close());
  assert.ok(a.runs.hold(W, A, KEY, 1));
  const first = a.runs.start(W, A, { use: 'claude', name: 'Clark', owner: 1 });
  await until(() => forks.all.length === 1, 2000, 'the first runner');
  // The second start, with another agent answering, while the first hasn't reported anything yet.
  const second = a.runs.start(W, A, { use: 'clark', name: 'Clark' });
  await first;
  await sleep(100);
  assert.equal(forks.all.length, 1, 'no second process while the first one runs');
  assert.deepEqual(forks.all[0].types(), ['start', 'stop']);
  forks.all[0].exit(0);
  await second;
  assert.equal(forks.all.length, 2);
  assert.equal(forks.most(), 1, 'never two processes for one agent');
  // Each process got what it runs and the secret for it together, and nothing on disk to read them from.
  const [one, two] = forks.all.map((c) => c.posts[0]);
  assert.equal(one.config.backend.type, 'claude');
  assert.equal(one.config.backend.exe, '/usr/bin/claude');
  assert.equal(one.backendKey, '');
  assert.equal(two.config.backend.type, 'runs');
  assert.equal(two.config.backend.url, 'http://127.0.0.1:8642');
  assert.equal(two.backendKey, 'hermes-secret-value');
  assert.equal(one.key, KEY);
  assert.equal(two.key, KEY);
  assert.deepEqual(forks.all[0].opts && forks.all.map((c) => c.posts.filter((p) => p.type === 'start').length), [1, 1]);
  const files = fs.existsSync(path.join(a.dataDir, 'agent-runs')) ? fs.readdirSync(path.join(a.dataDir, 'agent-runs')) : [];
  assert.deepEqual(files.filter((f) => !f.endsWith('.state.json')), [], 'no config file on disk');
  assert.ok(!profileText(a.dataDir).includes(KEY) && !profileText(a.dataDir).includes('hermes-secret-value'));
});

test('stop while the runner boots ends it and nothing starts again', async (t) => {
  const forks = fakeForks();
  const a = makeRuns({ fork: forks, backendFor: fakeBackends() });
  t.after(() => a.runs.close());
  a.runs.hold(W, A, KEY, 1);
  await a.runs.start(W, A, { use: 'claude', owner: 1 });
  const stopped = a.runs.stop(W, A);
  await sleep(20);
  assert.deepEqual(forks.all[0].types(), ['start', 'stop']);
  assert.equal(phaseOf(a.runs, W, A), 'stopped');
  forks.all[0].exit(0);
  await stopped;
  await sleep(300);
  assert.equal(forks.all.length, 1, 'a runner stopped while it booted is no crash');
  assert.equal(phaseOf(a.runs, W, A), 'stopped');
  assert.equal(JSON.parse(fs.readFileSync(path.join(a.dataDir, 'agent-runs.json'), 'utf8')).runs[0].on, false);
});

test('a start during the pause after a crash starts one runner, and the pause no longer starts another', async (t) => {
  const forks = fakeForks();
  const a = makeRuns({ fork: forks, backendFor: fakeBackends(), delays: [150, 150, 150] });
  t.after(() => a.runs.close());
  a.runs.hold(W, A, KEY, 1);
  await a.runs.start(W, A, { use: 'claude', owner: 1 });
  forks.all[0].exit(1);
  await until(() => phaseOf(a.runs, W, A) === 'waiting', 1000, 'the pause');
  assert.ok(viewOf(a.runs, W, A).retryAt > Date.now());
  assert.deepEqual(viewOf(a.runs, W, A).error, { code: 'crashed' });
  await a.runs.start(W, A, {});
  assert.equal(forks.all.length, 2);
  await sleep(400);
  assert.equal(forks.all.length, 2, 'the pause started nothing after the start');
  assert.equal(forks.most(), 1);
  assert.equal(phaseOf(a.runs, W, A), 'starting');
});

test('an exit or a report that comes after the agent was removed here makes no state and starts nothing', async (t) => {
  const forks = fakeForks();
  const a = makeRuns({ fork: forks, backendFor: fakeBackends() });
  t.after(() => a.runs.close());
  a.runs.hold(W, A, KEY, 1);
  await a.runs.start(W, A, { use: 'claude', owner: 1 });
  const gone = a.runs.forget(W, A);
  await sleep(20);
  assert.equal(a.runs.find(W, A), null);
  assert.deepEqual(a.runs.snapshot().runs, []);
  forks.all[0].say({ type: 'connected' });
  forks.all[0].say({ type: 'refused' });
  forks.all[0].exit(2);
  assert.equal(await gone, true);
  await sleep(300);
  assert.deepEqual(a.runs.snapshot().runs, []);
  assert.equal(a.runs.live.size, 0, 'no state for a process that is no longer tracked');
  assert.equal(forks.all.length, 1);
  assert.ok(!fs.existsSync(path.join(a.dataDir, 'agent-runs.json')));
});

test('the old runner saying its key was refused, while New key replaces it, stops nothing: the new key runs', async (t) => {
  const forks = fakeForks();
  const a = makeRuns({ fork: forks, backendFor: fakeBackends() });
  t.after(() => a.runs.close());
  a.runs.hold(W, A, KEY, 1);
  await a.runs.start(W, A, { use: 'claude', owner: 1 });
  // The server replaced the key: the old runner hears it before or after main asks it to stop.
  a.runs.takeKey(W, { agent: { id: A }, key: KEY_NEW }, { renew: true, owner: 1 });
  forks.all[0].say({ type: 'refused' });
  forks.all[0].exit(2);
  await until(() => forks.all.length === 2, 1000, 'the runner with the new key');
  assert.equal(forks.all[1].posts[0].key, KEY_NEW);
  assert.equal(phaseOf(a.runs, W, A), 'starting');
  assert.equal(a.runs.find(W, A).refused, false);
  await sleep(300);
  assert.equal(forks.all.length, 2);
  assert.equal(forks.most(), 1);
});

test('a setups file that cannot be written is an error, and what the window sees stays what a restart does', async (t) => {
  const forks = fakeForks();
  const a = makeRuns({ fork: forks, backendFor: fakeBackends() });
  t.after(() => a.runs.close());
  a.runs.hold(W, A, KEY, 1);
  await a.runs.start(W, A, { use: 'claude', owner: 1 });
  const file = path.join(a.dataDir, 'agent-runs.json');
  // The profile can't be written.
  const write = a.runs.writeFile;
  a.runs.writeFile = () => {
    throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
  };
  await rejects(a.runs.stop(W, A), 'save_failed');
  assert.equal(viewOf(a.runs, W, A).on, true, 'Stop that could not be saved leaves it on');
  assert.equal(forks.alive().length, 1, 'and running, as after a restart');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).runs[0].on, true);
  // A new setup that can't be saved never starts.
  a.runs.hold(W, B, KEY_B, 1);
  await rejects(a.runs.start(W, B, { use: 'claude', owner: 1 }), 'save_failed');
  assert.equal(a.runs.find(W, B), null);
  assert.equal(forks.all.length, 1);
  a.runs.writeFile = write;
});

// ---- What a runner runs is approved in main, by a person ----

test('the first Run on this computer asks the person in main, naming the agent and the program, and declining starts nothing', async (t) => {
  const forks = fakeForks();
  let answer = 'cancel';
  const a = makeRuns({ fork: forks, backendFor: fakeBackends(), ask: () => answer });
  t.after(() => a.runs.close());
  a.runs.hold(W, A, KEY, 1);
  await rejects(a.runs.start(W, A, { use: 'claude', name: 'Clark', owner: 1 }), 'declined');
  assert.equal(forks.all.length, 0);
  assert.equal(a.runs.find(W, A), null);
  assert.equal(a.asked.length, 1);
  assert.equal(a.asked[0].kind, 'run');
  assert.match(a.asked[0].message, /Clark/);
  assert.match(a.asked[0].detail, /\/usr\/bin\/claude/);
  assert.match(a.asked[0].detail, /\.claude/);
  answer = 'run';
  await a.runs.start(W, A, { use: 'claude', name: 'Clark', owner: 1 });
  assert.equal(forks.all.length, 1);
  assert.deepEqual(a.runs.find(W, A).approved, { use: 'claude', kind: 'claude', type: 'claude', program: '/usr/bin/claude', configDir: path.join(HOME, '.claude') });
  // Start again with the same: no question.
  const stopping = a.runs.stop(W, A);
  await until(() => forks.all[0].types().includes('stop'), 1000, 'the stop');
  forks.all[0].exit(0);
  await stopping;
  await a.runs.start(W, A, {});
  assert.equal(forks.all.length, 2);
  assert.equal(a.asked.length, 2);
});

test('an agent on a server is approved by its address, and its secret goes only there; another address in Settings stops it until it is run again', async (t) => {
  const forks = fakeForks();
  const over = {};
  const a = makeRuns({ fork: forks, backendFor: (use) => fakeBackends(over)(use) });
  t.after(() => a.runs.close());
  a.runs.hold(W, A, KEY, 1);
  await a.runs.start(W, A, { use: 'clark', name: 'Clark', owner: 1 });
  assert.match(a.asked[0].detail, /http:\/\/127\.0\.0\.1:8642/);
  assert.match(a.asked[0].detail, /tools/);
  assert.deepEqual(a.runs.find(W, A).approved, { use: 'clark', kind: 'hermes', type: 'runs', address: 'http://127.0.0.1:8642' });
  assert.equal(forks.all[0].posts[0].backendKey, 'hermes-secret-value');
  // The window changes Hermes's address in Settings: the runner stops, says why, and the secret goes nowhere new.
  over.clark = { backend: { url: 'https://elsewhere.example' } };
  a.runs.settingsChanged();
  await until(() => forks.all[0].types().includes('stop'), 1000, 'the stop');
  forks.all[0].exit(0);
  await until(() => phaseOf(a.runs, W, A) === 'changed', 1000, 'changed');
  assert.equal(viewOf(a.runs, W, A).on, true);
  // A crash pause, a restart of Rukoo or Start: none of them runs it with the new address.
  a.runs.close();
  const b = makeRuns({ dataDir: a.dataDir, fork: forks, backendFor: (use) => fakeBackends(over)(use), ask: () => 'cancel' });
  t.after(() => b.runs.close());
  await sleep(50);
  assert.equal(forks.all.length, 1, 'no start with what nobody approved');
  assert.equal(phaseOf(b.runs, W, A), 'changed');
  await rejects(b.runs.start(W, A, {}), 'declined');
  assert.equal(forks.all.length, 1);
  assert.match(b.asked[0].detail, /https:\/\/elsewhere\.example/);
});

test('a program path that differs from the approved one, or a Settings agent turned off, keeps the runner from starting', async (t) => {
  const forks = fakeForks();
  const over = {};
  let where = '/usr/bin/claude';
  const a = makeRuns({ fork: forks, backendFor: (use) => fakeBackends(over)(use), resolve: (type, exe) => exe || where });
  t.after(() => a.runs.close());
  a.runs.hold(W, A, KEY, 1);
  await a.runs.start(W, A, { use: 'claude', owner: 1 });
  forks.all[0].exit(1);
  // While it waits to start again, Settings names another program.
  over.claude = { backend: { exe: '/tmp/evil' } };
  await sleep(250);
  assert.equal(forks.all.length, 1);
  assert.equal(phaseOf(a.runs, W, A), 'changed');
  // The same program again, then turned off in Settings.
  delete over.claude;
  await a.runs.start(W, A, {});
  assert.equal(forks.all.length, 2);
  over.claude = null;
  a.runs.settingsChanged();
  await until(() => forks.all[1].types().includes('stop'), 1000, 'the stop');
  forks.all[1].exit(0);
  await until(() => phaseOf(a.runs, W, A) === 'changed', 1000, 'changed');
  assert.equal(viewOf(a.runs, W, A).gone, true);
  await rejects(a.runs.start(W, A, {}), 'unknown_backend');
  // PATH now finds another claude: that is another program too.
  delete over.claude;
  where = '/opt/other/claude';
  const asked = a.asked.length;
  await a.runs.start(W, A, {});
  assert.equal(a.asked.length, asked + 1, 'asked again for the other program');
});

test('Settings that change while the question is open are not what runs', async (t) => {
  const forks = fakeForks();
  const over = {};
  const a = makeRuns({
    fork: forks,
    backendFor: (use) => fakeBackends(over)(use),
    ask: () => {
      over.clark = { backend: { url: 'https://swapped.example' } };
      return 'run';
    }
  });
  t.after(() => a.runs.close());
  a.runs.hold(W, A, KEY, 1);
  await rejects(a.runs.start(W, A, { use: 'clark', owner: 1 }), 'changed');
  assert.equal(forks.all.length, 0);
});

test('runBackend and identify answer nothing for an agent turned off in Settings, and only built-in and custom ids', () => {
  const cfg = new AgentConfig({ file: path.join(dir, 'agents-off.json'), secrets: fakeSecrets() }).load();
  cfg.update({ clark: { url: 'http://127.0.0.1:8642', enabled: false } });
  assert.equal(runBackend(cfg, 'clark'), null);
  cfg.update({ clark: { enabled: true } });
  assert.equal(runBackend(cfg, 'clark').kind, 'hermes');
  assert.deepEqual(identify('clark', runBackend(cfg, 'clark'), { resolve: () => assert.fail('no program for a server') }), { use: 'clark', kind: 'hermes', type: 'runs', address: 'http://127.0.0.1:8642' });
  cfg.update({ codex: { enabled: false } });
  assert.equal(runBackend(cfg, 'codex'), null);
});

// ---- The key stays in main ----

test('a held key belongs to the document that made the agent: another document can neither run nor export it, and it goes at navigation and after its time', async (t) => {
  const forks = fakeForks();
  const a = makeRuns({ fork: forks, backendFor: fakeBackends(), heldFor: 80 });
  t.after(() => a.runs.close());
  const answer = a.runs.takeKey(W, { agent: { id: A, name: 'Clark' }, key: KEY }, { owner: 7 });
  assert.deepEqual(answer, { agent: { id: A, name: 'Clark' }, held: true, runsHere: false });
  // Another window, or the same window after a reload (another owner): nothing.
  await rejects(a.runs.start(W, A, { use: 'claude', owner: 8 }), 'no_key');
  await rejects(a.runs.exportConfig(W, A, { use: 'claude', owner: 8 }), 'no_key');
  assert.equal(a.runs.release(W, A, 8), false);
  // Navigation of the document that holds it ends the hold.
  a.runs.releaseOwner(7);
  await rejects(a.runs.exportConfig(W, A, { use: 'claude', owner: 7 }), 'no_key');
  // And so does its time.
  a.runs.takeKey(W, { agent: { id: A }, key: KEY }, { owner: 7 });
  await sleep(150);
  await rejects(a.runs.start(W, A, { use: 'claude', owner: 7 }), 'no_key');
  assert.equal(forks.all.length, 0);
  // Signing out ends it too.
  a.runs.takeKey(W, { agent: { id: A }, key: KEY }, { owner: 7 });
  a.runs.account.signOut();
  assert.equal(a.runs.held.size, 0);
});

test('running here uses up the hold; export asks first, then saves the config with the key to a file, never to the clipboard, and the window never gets it', async (t) => {
  const forks = fakeForks();
  let answer = 'save';
  const saved = path.join(dir, 'exported-agent.json');
  const a = makeRuns({ fork: forks, account: fakeAccount('https://rukoo.example'), backendFor: fakeBackends(), ask: (q) => (q.kind === 'run' ? 'run' : answer), saveTo: async () => saved });
  t.after(() => a.runs.close());
  a.runs.takeKey(W, { agent: { id: A }, key: KEY }, { owner: 3 });
  assert.deepEqual(await a.runs.exportConfig(W, A, { use: 'claude', owner: 3 }), { done: 'saved' });
  assert.equal(a.asked.at(-1).kind, 'export');
  assert.match(a.asked.at(-1).detail, /key/);
  // The question offers only a file: a window can read the clipboard back through a paste.
  assert.deepEqual(a.asked.at(-1).buttons.map((b) => b.id), ['cancel', 'save']);
  const config = JSON.parse(fs.readFileSync(saved, 'utf8'));
  assert.deepEqual(config, { server: 'https://rukoo.example', workspace: W, key: KEY, backend: { type: 'claude' }, context: { threadMessages: 50, channelMessages: 20, maxChars: 30000 }, instructions: '' });
  // Cancel, or an answer that isn't offered, such as the copy there once was, writes nothing; Save writes the file,
  // readable only by the person.
  fs.rmSync(saved);
  for (answer of ['cancel', 'copy']) {
    assert.deepEqual(await a.runs.exportConfig(W, A, { use: 'own', owner: 3 }), { done: null });
    assert.ok(!fs.existsSync(saved));
  }
  answer = 'save';
  assert.deepEqual(await a.runs.exportConfig(W, A, { use: 'own', owner: 3 }), { done: 'saved' });
  assert.equal(JSON.parse(fs.readFileSync(saved, 'utf8')).backend.command, 'my-agent');
  if (process.platform !== 'win32') assert.equal(fs.statSync(saved).mode & 0o077, 0);
  // An agent the export can't name refuses.
  await rejects(a.runs.exportConfig(W, A, { use: 'command', owner: 3 }), 'unknown_backend');
  // Run on this computer takes the key: from then on it is only the encrypted one, and no export has it.
  await a.runs.start(W, A, { use: 'claude', owner: 3 });
  await rejects(a.runs.exportConfig(W, A, { use: 'claude', owner: 3 }), 'no_key');
  assert.ok(!JSON.stringify(a.runs.snapshot()).includes('rka_'));
  // New key for an agent set up here goes to the setup, never to a hold.
  const renewed = a.runs.takeKey(W, { agent: { id: A }, key: KEY_NEW }, { renew: true, owner: 3 });
  assert.deepEqual(renewed, { agent: { id: A }, held: false, runsHere: true });
  await rejects(a.runs.exportConfig(W, A, { use: 'claude', owner: 3 }), 'no_key');
  await until(() => forks.all.length === 1 && forks.all[0].types().includes('stop'), 1000, 'the restart');
  forks.all[0].exit(0);
  await until(() => forks.all.length === 2, 1000, 'the runner with the new key');
  assert.equal(forks.all[1].posts[0].key, KEY_NEW);
});

test('runsApi has no call that answers a key, and the window calls carry their document and the session they came in', async () => {
  const seen = [];
  const fake = {
    signature: () => ({ signedIn: true, server: 'https://rukoo.example', session: 'session-one' }),
    takeKey: (ws, answer, opts) => (seen.push(['take', opts]), { agent: answer.agent, held: true, runsHere: false }),
    forget: async (ws, agent) => (seen.push(['forget', ws, agent]), true),
    start: async (ws, agent, opts) => (seen.push(['start', opts]), {}),
    exportConfig: async (ws, agent, opts) => (seen.push(['export', opts]), { done: 'saved' }),
    release: (ws, agent, owner) => (seen.push(['release', owner]), true),
    snapshot: () => ({ available: true, runs: [] })
  };
  const { api, windowApi } = runsApi(() => fake, {
    chatCreateAgent: async () => ({ agent: { id: A }, key: KEY }),
    chatNewAgentKey: async () => ({ agent: { id: A }, key: KEY }),
    chatRemoveAgent: async () => true
  });
  // The token of the document that called (main.js documentOf).
  const doc = '42:3';
  assert.ok(!('agentRunHeldKey' in api) && !('agentRunHeldKey' in windowApi));
  assert.ok(!JSON.stringify(await windowApi.chatCreateAgent(doc, W, {})).includes('rka_'));
  assert.ok(!JSON.stringify(await windowApi.chatNewAgentKey(doc, W, A)).includes('rka_'));
  await windowApi.agentRunStart(doc, W, A, { use: 'claude', name: 'Not from the window' });
  await windowApi.agentRunExport(doc, W, A, { use: 'claude', name: 'Not from the window' });
  windowApi.agentRunRelease(doc, W, A);
  assert.deepEqual(
    seen.map(([kind, opts]) => [kind, opts && typeof opts === 'object' ? opts.owner : opts]),
    [
      ['take', doc],
      ['take', doc],
      ['start', doc],
      ['export', doc],
      ['release', doc]
    ]
  );
  // The session the call came in goes with the answer; the name the window sent goes nowhere.
  assert.deepEqual(seen.slice(0, 2).map(([, opts]) => opts.session), ['session-one', 'session-one']);
  assert.ok(!JSON.stringify(seen).includes('Not from the window'));
  assert.equal(await api.chatRemoveAgent(W, A), true);
  assert.deepEqual(seen.at(-1), ['forget', W, A]);
  assert.throws(() => windowApi.agentRunStart(doc, '../x', A, {}), (err) => err.code === 'invalid');
  assert.throws(() => api.agentRunStop(W, 'u_short'), (err) => err.code === 'invalid');
});

// ---- A setup goes with its agent ----

test("a setup goes when the workspace's directory no longer has its agent, running, stopped or refused alike", async (t) => {
  const forks = fakeForks();
  const a = makeRuns({ fork: forks, backendFor: fakeBackends() });
  t.after(() => a.runs.close());
  a.runs.hold(W, A, KEY, 1);
  a.runs.hold(W, B, KEY_B, 1);
  await a.runs.start(W, A, { use: 'claude', owner: 1 });
  await a.runs.start(W, B, { use: 'claude', owner: 1 });
  const stopping = a.runs.stop(W, B);
  forks.all[1].exit(0);
  await stopping;
  const me = { id: `u_${'m'.repeat(22)}`, kind: 'human', state: 'active' };
  // A directory that lists both as active keeps both; one without anyone active in it says nothing.
  a.runs.reconcile(W, [me, { id: A, kind: 'agent', state: 'active' }, { id: B, kind: 'agent', state: 'active' }], { complete: true });
  a.runs.reconcile(W, [], { complete: true });
  // A cache that an optimistic change or a failed reload left without them is no answer from the server.
  a.runs.reconcile(W, [me]);
  a.runs.reconcile(W, [me], { complete: 'yes' });
  await sleep(50);
  assert.equal(a.runs.snapshot().runs.length, 2);
  assert.equal(forks.all[0].types().includes('stop'), false);
  // A removed elsewhere while it ran, B while it was stopped here: the server's whole member list says so.
  a.runs.reconcile(W, [me, { id: A, kind: 'agent', state: 'removed' }], { complete: true });
  await until(() => forks.all[0].types().includes('stop'), 1000, 'the stop');
  forks.all[0].exit(0);
  await until(() => a.runs.snapshot().runs.length === 0, 1000, 'both setups to go');
  assert.ok(!fs.existsSync(path.join(a.dataDir, 'agent-runs.json')));
});

// ---- Quit, and what the status says ----

test('close asks each runner to stop and waits for it, and ends one that takes too long', async () => {
  const forks = fakeForks();
  const a = makeRuns({ fork: forks, backendFor: fakeBackends(), stopWait: 150 });
  a.runs.hold(W, A, KEY, 1);
  a.runs.hold(W, B, KEY_B, 1);
  await a.runs.start(W, A, { use: 'claude', owner: 1 });
  await a.runs.start(W, B, { use: 'claude', owner: 1 });
  let done = false;
  const closing = a.runs.close().then(() => (done = true));
  assert.deepEqual(forks.all.map((c) => c.types().at(-1)), ['stop', 'stop']);
  forks.all[0].exit(0);
  await sleep(50);
  assert.equal(done, false, 'the quit waits for the runner that is still cancelling');
  await until(() => forks.all[1].killed > 0, 1000, 'the kill');
  forks.all[1].exit(-1);
  await closing;
  assert.equal(done, true);
});

test('a runner that cannot reach the server says so while it starts, and after a wake its status is stale until a fresh pass', async (t) => {
  const forks = fakeForks();
  const a = makeRuns({ fork: forks, backendFor: fakeBackends() });
  t.after(() => a.runs.close());
  a.runs.hold(W, A, KEY, 1);
  await a.runs.start(W, A, { use: 'claude', owner: 1 });
  forks.all[0].say({ type: 'unreachable', code: 'offline', message: 'No answer from evil: token rka_leak' });
  let v = viewOf(a.runs, W, A);
  assert.equal(v.phase, 'starting');
  assert.deepEqual(v.unreachable && { code: v.unreachable.code, status: v.unreachable.status }, { code: 'offline', status: null });
  forks.all[0].say({ type: 'connected' });
  forks.all[0].say({ type: 'pass', channels: 1 });
  v = viewOf(a.runs, W, A);
  assert.equal(v.phase, 'running');
  assert.equal(v.unreachable, null);
  a.runs.resume();
  assert.equal(viewOf(a.runs, W, A).stale, true);
  const wake = forks.all[0].posts.at(-1);
  assert.equal(wake.type, 'wake');
  // A pass that began before the wake, a connection or an unreachable server says nothing fresh: only the child's
  // answer to this wake does.
  forks.all[0].say({ type: 'pass', channels: 1 });
  forks.all[0].say({ type: 'connected' });
  assert.equal(viewOf(a.runs, W, A).stale, true);
  a.runs.resume();
  forks.all[0].say({ type: 'woke', seq: wake.seq });
  assert.equal(viewOf(a.runs, W, A).stale, true, 'an answer to the wake before is not an answer to this one');
  forks.all[0].say({ type: 'woke', seq: forks.all[0].posts.at(-1).seq });
  assert.equal(viewOf(a.runs, W, A).stale, false);
});

test('a runner that is stopping says nothing more, and an expected exit never leaves the row running without a process', async (t) => {
  const forks = fakeForks();
  const over = {};
  const a = makeRuns({ fork: forks, backendFor: (use) => fakeBackends(over)(use) });
  t.after(() => a.runs.close());
  a.runs.hold(W, A, KEY, 1);
  await a.runs.start(W, A, { use: 'clark', owner: 1 });
  forks.all[0].say({ type: 'connected' });
  assert.equal(phaseOf(a.runs, W, A), 'running');
  // Settings name another address: the row says changed, and a late report of the old runner doesn't undo that.
  over.clark = { backend: { url: 'https://elsewhere.example' } };
  a.runs.settingsChanged();
  assert.equal(phaseOf(a.runs, W, A), 'changed');
  forks.all[0].say({ type: 'connected' });
  forks.all[0].say({ type: 'pass', channels: 2 });
  assert.equal(phaseOf(a.runs, W, A), 'changed');
  forks.all[0].exit(0);
  await sleep(20);
  assert.equal(phaseOf(a.runs, W, A), 'changed');
  // A restart whose new start doesn't come (signed out meanwhile) leaves it stopped, not running.
  delete over.clark;
  await a.runs.start(W, A, { owner: 1 }).catch(() => {});
  const forks2 = forks.all.at(-1);
  forks2.say({ type: 'connected' });
  assert.equal(phaseOf(a.runs, W, A), 'running');
  a.runs.account.signed = false;
  const restart = a.runs.queue(`${W} ${A}`, () => a.runs.cycle(`${W} ${A}`, { restart: true }));
  forks2.exit(0);
  await restart;
  assert.equal(a.runs.procs.size, 0);
  assert.notEqual(phaseOf(a.runs, W, A), 'running');
});

test('what a runner reports reaches the window as codes and a status number, never as text', async (t) => {
  const forks = fakeForks();
  const a = makeRuns({ fork: forks, backendFor: fakeBackends() });
  t.after(() => a.runs.close());
  a.runs.hold(W, A, KEY, 1);
  await a.runs.start(W, A, { use: 'claude', owner: 1 });
  const c = forks.all[0];
  c.say({ type: 'connected' });
  c.say({ type: 'problems', problems: [{ code: 'unreachable', message: 'Nothing answers at http://x/?token=SECRET' }, { code: '<script>', message: 'x' }] });
  c.say({ type: 'failed', code: 'http', status: 502, message: 'HTTP 502: {"error":"SECRET"}' });
  c.say({ type: 'error', code: 'runner', message: 'SECRET' });
  c.say({ type: 'unreachable', code: 'http', status: 9999, message: 'SECRET' });
  const v = viewOf(a.runs, W, A);
  assert.ok(!JSON.stringify(a.runs.snapshot()).includes('SECRET'));
  assert.deepEqual(v.problem, { code: 'unreachable' });
  assert.deepEqual({ code: v.failure.code, status: v.failure.status }, { code: 'http', status: 502 });
  assert.deepEqual(v.error, { code: 'runner' });
  assert.equal(v.unreachable.status, null, 'a status that is no HTTP status is dropped');
  // The process ends after its error: the error it reported is what the window hears.
  c.exit(1);
  await until(() => phaseOf(a.runs, W, A) === 'waiting', 1000, 'the pause');
  assert.deepEqual(viewOf(a.runs, W, A).error, { code: 'runner' });
  assert.ok(!a.lines.join('\n').includes('SECRET'), 'nor in the log');
});

// ---- Review round 3 ----

const C = `u_${'c'.repeat(22)}`;
const KEY_C = `rka_${'c'.repeat(22)}.${'e'.repeat(43)}`;
const unresolved = (fn) => assert.throws(fn, (err) => err instanceof RunError && err.code === 'unresolved');

test('the program a person approves is a full, canonical path: relative paths are refused, a link becomes its file, and on Windows only an .exe', () => {
  const ext = process.platform === 'win32' ? '.exe' : '';
  const d = path.join(dir, 'programs');
  fs.mkdirSync(d, { recursive: true });
  const real = path.join(d, `agent-program${ext}`);
  fs.writeFileSync(real, '#!/bin/sh\n');
  fs.chmodSync(real, 0o755);
  const canonical = fs.realpathSync.native(real);
  assert.equal(canonicalProgram(real), canonical);
  // A name for PATH to find, or a path relative to some working folder, is no program anyone can see.
  unresolved(() => canonicalProgram(`claude${ext}`));
  unresolved(() => canonicalProgram(path.join('bin', `claude${ext}`)));
  unresolved(() => canonicalProgram(''));
  assert.throws(() => canonicalProgram(path.join(d, `not-there${ext}`)), (err) => err.code === 'missing');
  // On Windows a .cmd, or a program named without .exe, is refused even when it exists.
  const cmd = path.join(d, 'agent.cmd');
  fs.writeFileSync(cmd, '');
  unresolved(() => canonicalProgram(cmd, { platform: 'win32' }));
  unresolved(() => canonicalProgram(path.join(d, 'agent-program'), { platform: 'win32' }));
  // A link: what is approved and started is the file it points at.
  const link = path.join(d, `agent-link${ext}`);
  let linked = true;
  try {
    fs.symlinkSync(real, link);
  } catch (_) {
    linked = false;
  }
  if (linked) assert.equal(canonicalProgram(link), canonical);
  // The folder of its settings is given in full too.
  const b = { kind: 'claude', backend: { type: 'claude', configDir: path.join('relative', 'claude') } };
  unresolved(() => identify('claude', b, { resolve: () => canonical, env: {}, home: HOME }));
  unresolved(() => identify('codex', { kind: 'codex', backend: { type: 'codex' } }, { resolve: () => canonical, env: { CODEX_HOME: 'codex-home' }, home: HOME }));
  assert.equal(identify('codex', { kind: 'codex', backend: { type: 'codex' } }, { resolve: () => canonical, env: {}, home: HOME }).configDir, path.join(HOME, '.codex'));
});

test('the runner gets exactly the approved file to start, and a program that changed under it stops it until a person says yes again', async (t) => {
  const forks = fakeForks();
  const a = makeRuns({ fork: forks, backendFor: fakeBackends() });
  t.after(() => a.runs.close());
  a.runs.hold(W, A, KEY, 1);
  await a.runs.start(W, A, { use: 'claude', owner: 1 });
  const backend = forks.all[0].posts[0].config.backend;
  assert.equal(backend.exe, '/usr/bin/claude');
  assert.equal(backend.pin, true, 'the runner checks the file again before each turn');
  // Before a turn the runner found another file at that path (backends.js pinned): it reports and exits with 3.
  forks.all[0].say({ type: 'changed' });
  forks.all[0].exit(3);
  await until(() => phaseOf(a.runs, W, A) === 'changed', 1000, 'changed');
  assert.equal(JSON.parse(fs.readFileSync(path.join(a.dataDir, 'agent-runs.json'), 'utf8')).runs[0].approved, null);
  await sleep(300);
  assert.equal(forks.all.length, 1, 'no start again after a pause');
  const asked = a.asked.length;
  await a.runs.start(W, A, {});
  assert.equal(a.asked.length, asked + 1, 'the same Settings ask again');
  assert.equal(forks.all.length, 2);
});

test("the question names each request in full, OpenClaw's agent and main's own name for the agent; a path that would name another server is refused", async (t) => {
  const forks = fakeForks();
  const backends = {
    clark: { name: 'Hermes', kind: 'hermes', backend: { type: 'runs', url: 'http://127.0.0.1:8642/p/work/' }, secret: 'hermes-secret-value' },
    openclaw: { name: 'OpenClaw', kind: 'openclaw', backend: { type: 'openai', url: 'http://127.0.0.1:18789', model: 'openclaw/ops' }, secret: 'gateway-token-value' },
    sneaky: { name: 'Sneaky', kind: 'custom', backend: { type: 'openai', url: 'http://127.0.0.1:18789//evil.example/v1' }, secret: '' }
  };
  const a = makeRuns({ fork: forks, backendFor: (use) => backends[use] || null });
  t.after(() => a.runs.close());
  a.runs.hold(W, A, KEY, 1);
  // The window sends a name of its own: main asks with the directory's.
  await a.runs.start(W, A, { use: 'clark', name: 'Someone else', owner: 1 });
  assert.equal(a.asked[0].message, 'Run Clark on this computer with Hermes?');
  assert.ok(!JSON.stringify(a.asked[0]).includes('Someone else'));
  assert.ok(a.asked[0].detail.includes('http://127.0.0.1:8642/p/work/v1/runs\n'), a.asked[0].detail);
  assert.equal(a.runs.find(W, A).name, 'Clark');
  // A gateway with several agents: the one that answers is in the question and in the approval.
  a.runs.hold(W, B, KEY_B, 1);
  await a.runs.start(W, B, { use: 'openclaw', owner: 1 });
  assert.ok(a.asked[1].detail.includes('http://127.0.0.1:18789/v1/chat/completions\n'), a.asked[1].detail);
  assert.ok(a.asked[1].detail.includes("the gateway's agent openclaw/ops answers"), a.asked[1].detail);
  backends.openclaw = { ...backends.openclaw, backend: { ...backends.openclaw.backend, model: 'openclaw/finance' } };
  a.runs.settingsChanged();
  assert.equal(phaseOf(a.runs, W, B), 'changed', 'another agent at the same gateway is another approval');
  // A path that starts with // is refused before any question.
  a.runs.hold(W, C, KEY_C, 1);
  await rejects(a.runs.start(W, C, { use: 'sneaky', owner: 1 }), 'unknown_backend');
  assert.equal(a.asked.length, 2);
  // OpenClaw's model header is the model, which needs no new yes; any other header does.
  const gw = { kind: 'openclaw', backend: { type: 'openai', url: 'http://127.0.0.1:18789', model: 'openclaw/ops', headers: { 'x-openclaw-model': 'gpt-5' } } };
  const id = identify('openclaw', gw);
  assert.equal(id.headers, undefined);
  assert.deepEqual(identify('openclaw', { ...gw, backend: { ...gw.backend, headers: { 'x-openclaw-model': 'other' } } }), id);
  const extra = identify('openclaw', { ...gw, backend: { ...gw.backend, headers: { 'x-openclaw-model': 'gpt-5', 'X-Team': 'finance-secret' } } });
  assert.match(extra.headers, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(extra).includes('finance-secret'));
});

test('a mismatch takes the approval for good, also while the runner waits to start again and across a restart; Stop keeps it', async (t) => {
  const forks = fakeForks();
  const over = {};
  const a = makeRuns({ fork: forks, backendFor: (use) => fakeBackends(over)(use), delays: [5000] });
  a.runs.hold(W, A, KEY, 1);
  await a.runs.start(W, A, { use: 'clark', owner: 1 });
  // Stop, then Start with the same Settings: no question.
  const stopping = a.runs.stop(W, A);
  forks.all[0].exit(0);
  await stopping;
  await a.runs.start(W, A, {});
  assert.equal(a.asked.length, 1);
  // It ends by itself and waits 5 s to start again; meanwhile Settings name another address, then the old one.
  forks.all[1].exit(1);
  await until(() => phaseOf(a.runs, W, A) === 'waiting', 1000, 'the pause');
  over.clark = { backend: { url: 'https://elsewhere.example' } };
  a.runs.settingsChanged();
  assert.equal(phaseOf(a.runs, W, A), 'changed');
  delete over.clark;
  a.runs.settingsChanged();
  assert.equal(phaseOf(a.runs, W, A), 'changed', 'the old Settings bring nothing back');
  assert.equal(JSON.parse(fs.readFileSync(path.join(a.dataDir, 'agent-runs.json'), 'utf8')).runs[0].approved, null);
  // Nor does a restart of Rukoo.
  await a.runs.close();
  const b = makeRuns({ dataDir: a.dataDir, fork: forks, backendFor: fakeBackends(), ask: () => 'cancel' });
  t.after(() => b.runs.close());
  await sleep(50);
  assert.equal(forks.all.length, 2, 'nothing starts without a new yes');
  assert.equal(phaseOf(b.runs, W, A), 'changed');
  await rejects(b.runs.start(W, A, {}), 'declined');
  assert.equal(b.asked.length, 1);
});

test('a key hold belongs to one document and one session: an answer or a question that ends after either went keeps nothing', async (t) => {
  const forks = fakeForks();
  let alive = true;
  let duringAsk = () => {};
  let duringSave = () => {};
  let exportAnswer = 'save';
  const saved = path.join(dir, 'for-a-gone-document.json');
  const a = makeRuns({
    fork: forks,
    backendFor: fakeBackends(),
    ownerAlive: (o) => alive && o === '7:0',
    ask: (q) => {
      duringAsk();
      return q.kind === 'run' ? 'run' : exportAnswer;
    },
    saveTo: async () => {
      duringSave();
      return saved;
    }
  });
  t.after(() => a.runs.close());
  const made = { agent: { id: A, name: 'Clark' }, key: KEY };
  // The answer comes after the document that asked went (a reload): nothing is held, and the window hears so.
  alive = false;
  assert.deepEqual(a.runs.takeKey(W, made, { owner: '7:0', session: 'session-one' }), { agent: made.agent, held: false, runsHere: false });
  assert.equal(a.runs.held.size, 0);
  // It comes in another session than the call came in: nothing is held.
  alive = true;
  assert.equal(a.runs.takeKey(W, made, { owner: '7:0', session: 'session-before' }).held, false);
  assert.equal(a.runs.held.size, 0);
  // The document reloads while the question is open: nothing is stored or started.
  assert.equal(a.runs.takeKey(W, made, { owner: '7:0', session: 'session-one' }).held, true);
  duringAsk = () => (alive = false);
  await rejects(a.runs.start(W, A, { use: 'claude', owner: '7:0' }), 'no_key');
  assert.equal(a.runs.find(W, A), null);
  assert.equal(forks.all.length, 0);
  // It reloads while the save dialog is open: nothing is written.
  alive = true;
  duringAsk = () => {};
  a.runs.takeKey(W, made, { owner: '7:0', session: 'session-one' });
  duringSave = () => (alive = false);
  await rejects(a.runs.exportConfig(W, A, { use: 'claude', owner: '7:0' }), 'no_key');
  assert.ok(!fs.existsSync(saved));
  // The session changes while the question is open: nothing is written.
  alive = true;
  duringSave = () => {};
  a.runs.takeKey(W, made, { owner: '7:0', session: 'session-one' });
  duringAsk = () => (a.runs.account.sessionTag = 'session-two');
  await rejects(a.runs.exportConfig(W, A, { use: 'claude', owner: '7:0' }), 'no_key');
  assert.ok(!fs.existsSync(saved));
});

test('a private file is written through a new temporary file that takes its place: never through a link, and none is left behind', () => {
  const d = path.join(dir, 'private');
  fs.mkdirSync(d, { recursive: true });
  const file = path.join(d, 'agent.json');
  writePrivate(file, 'one');
  writePrivate(file, 'two');
  assert.equal(fs.readFileSync(file, 'utf8'), 'two');
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(d), ['agent.json']);
  // A link at the destination is replaced; the file it pointed at stays as it was.
  const other = path.join(d, 'other.txt');
  fs.writeFileSync(other, 'keep', { mode: 0o644 });
  const link = path.join(d, 'link.json');
  let linked = true;
  try {
    fs.symlinkSync(other, link);
  } catch (_) {
    linked = false;
  }
  if (linked) {
    writePrivate(link, 'secret');
    assert.equal(fs.readFileSync(other, 'utf8'), 'keep');
    assert.equal(fs.lstatSync(link).isSymbolicLink(), false);
    assert.equal(fs.readFileSync(link, 'utf8'), 'secret');
  }
  // A destination that can't be replaced (a folder with a file in it) is an error, and no temporary file stays.
  const blocked = path.join(d, 'blocked.json');
  fs.mkdirSync(blocked);
  fs.writeFileSync(path.join(blocked, 'x'), '');
  assert.throws(() => writePrivate(blocked, 'secret'));
  assert.deepEqual(fs.readdirSync(d).filter((n) => n.endsWith('.tmp')), []);
  assert.deepEqual(fs.readdirSync(blocked), ['x']);
});

test('a new key the setup here cannot keep is said so, and stays held for the document, to run here again or export', async (t) => {
  const forks = fakeForks();
  let failing = false;
  const secrets = fakeSecrets();
  const seal = secrets.encrypt;
  secrets.encrypt = (s) => {
    if (failing) throw new Error('the keyring is locked');
    return seal(s);
  };
  const saved = path.join(dir, 'unsaved-new-key.json');
  const a = makeRuns({ fork: forks, backendFor: fakeBackends(), secrets, saveTo: async () => saved });
  t.after(() => a.runs.close());
  a.runs.hold(W, A, KEY, 1);
  await a.runs.start(W, A, { use: 'claude', owner: 1 });
  failing = true;
  const answer = a.runs.takeKey(W, { agent: { id: A }, key: KEY_NEW }, { renew: true, owner: 1 });
  assert.deepEqual(answer, { agent: { id: A }, held: true, runsHere: false, unsaved: true });
  await until(() => forks.all[0].types().includes('stop'), 1000, 'the old runner to stop');
  forks.all[0].exit(0);
  await sleep(20);
  assert.equal(phaseOf(a.runs, W, A), 'refused');
  // Save config gives the new key.
  assert.deepEqual(await a.runs.exportConfig(W, A, { use: 'claude', owner: 1 }), { done: 'saved' });
  assert.equal(JSON.parse(fs.readFileSync(saved, 'utf8')).key, KEY_NEW);
  // Run on this computer tries again once the keyring works, without a question: it runs what was approved.
  failing = false;
  const asked = a.asked.length;
  await a.runs.start(W, A, { owner: 1 });
  assert.equal(a.asked.length, asked);
  assert.equal(forks.all.at(-1).posts[0].key, KEY_NEW);
  assert.equal(a.runs.find(W, A).refused, false);
});

test("a backend's secret goes over plain http only to this computer or the person's own network, and https anywhere", async (t) => {
  const own = ['127.0.0.1', '127.8.9.1', '[::1]', 'localhost', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.10', '100.64.0.1', '100.127.255.254', '[fd12::1]', '[fc00::1]', 'box.tail1234.ts.net'];
  const outside = ['8.8.8.8', '172.32.0.1', '172.15.0.1', '100.63.0.1', '100.128.0.1', '192.169.0.1', '[2001:db8::1]', '[fe80::1]', 'example.com', 'ts.net', 'box.ts.net.example.com', '[::ffff:10.0.0.1]'];
  for (const h of own) assert.equal(ownNetwork(new URL(`http://${h}/`).hostname), true, h);
  for (const h of outside) assert.equal(ownNetwork(new URL(`http://${h}/`).hostname), false, h);
  assert.equal(plainHttp('https://203.0.113.5:8642'), false);
  assert.equal(plainHttp('http://203.0.113.5:8642'), true);
  assert.equal(plainHttp('http://100.100.1.2:8642'), false);
  const forks = fakeForks();
  const over = { clark: { backend: { url: 'http://203.0.113.5:8642' } } };
  const a = makeRuns({ fork: forks, backendFor: (use) => fakeBackends(over)(use) });
  t.after(() => a.runs.close());
  a.runs.hold(W, A, KEY, 1);
  await rejects(a.runs.start(W, A, { use: 'clark', owner: 1 }), 'plain_http');
  assert.equal(a.asked.length, 0, 'refused before any question');
  // Over https it asks, and runs after a yes.
  over.clark = { backend: { url: 'https://hermes.example' } };
  await a.runs.start(W, A, { use: 'clark', owner: 1 });
  assert.equal(forks.all[0].posts[0].backendKey, 'hermes-secret-value');
  // Settings later move it to plain http on the internet: it stops, and its secret goes nowhere.
  over.clark = { backend: { url: 'http://203.0.113.5:8642' } };
  a.runs.settingsChanged();
  assert.equal(phaseOf(a.runs, W, A), 'changed');
  assert.equal(viewOf(a.runs, W, A).gone, false);
  forks.all[0].exit(0);
  await rejects(a.runs.start(W, A, {}), 'plain_http');
  assert.equal(forks.all.length, 1);
  // A server agent without a secret may use plain http: nothing secret goes along.
  over.clark = { backend: { url: 'http://203.0.113.5:8642' }, secret: '' };
  await a.runs.start(W, A, {});
  assert.equal(forks.all.length, 2);
  assert.equal(forks.all[1].posts[0].backendKey, '');
});

test("what the runner's process writes for diagnostics is codes and counts only, never what a server said", async (t) => {
  const { fork } = require('child_process');
  const { CHILD } = require('../src/main/agent-runs.js');
  const SAID = 'SERVER-SAID-THIS rka_notakey';
  const srv = http.createServer((req, res) => res.writeHead(503, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'down', message: SAID })));
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  t.after(() => srv.close());
  const child = fork(CHILD, [], { execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: runnerEnv() });
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));
  const reports = [];
  child.on('message', (m) => m && m.type === 'report' && reports.push(m.event));
  const exited = new Promise((resolve) => child.on('exit', resolve));
  const state = path.join(dir, 'diag-child', 'agent.state.json');
  child.send({ type: 'start', config: { server: `http://127.0.0.1:${srv.address().port}`, workspace: W, backend: { type: 'command', command: [process.execPath, fakePath] }, context: {}, instructions: '', state }, key: KEY, backendKey: 'backend-secret-value' });
  await until(() => reports.some((e) => e.type === 'unreachable'), 10000, 'the report that the server is down');
  child.send({ type: 'wake', seq: 4 });
  await until(() => reports.some((e) => e.type === 'woke' && e.seq === 4), 10000, 'the answer to the wake');
  child.send({ type: 'stop' });
  assert.equal(await exited, 0);
  assert.deepEqual(reports.find((e) => e.type === 'unreachable'), { type: 'unreachable', code: 'http', status: 503 });
  assert.ok(stderr.length > 0, 'it wrote lines');
  for (const line of stderr.trim().split(/\r?\n/)) assert.match(line, /^\d{4}-\d\d-\d\dT[\d:.]+Z (info|warn|error) [a-z_]+( \d+)?$/, line);
  assert.ok(!stderr.includes('SERVER-SAID') && !stderr.includes('rka_') && !stderr.includes('127.0.0.1'));
});

// ---- The real child, against the real server ----

async function setup() {
  const olga = await server.seedAccount();
  const bart = await server.seedAccount();
  const ws = await server.seedWorkspace(olga, { name: 'Acme', displayName: 'Olga' });
  await server.seedMember(ws, bart, 'Bart');
  const { agent, key } = await server.seedAgent(olga, ws, { name: 'Clark', answers: 'everyone' });
  const added = await server.call('POST', `/v1/workspaces/${ws.id}/channels/${ws.general}/members`, { token: olga.token, body: { member: agent.id } });
  assert.equal(added.status, 200, added.text);
  return { olga, bart, ws, agent, key };
}

async function replies(person, ws, agentId) {
  const page = await server.call('GET', `/v1/workspaces/${ws.id}/conversations/${ws.general}/events?after=0&limit=100`, { token: person.token });
  assert.equal(page.status, 200, page.text);
  return page.body.events.filter((e) => e.kind === 'message.posted' && e.actor === agentId && !e.redacted);
}

function ask(person, ws, text, agent) {
  return server.post(person, ws.id, ws.general, text, { mentions: [mention(text, `@${agent.name}`, agent.id)] });
}

test('Run on this computer answers a mention, keeps the key encrypted and out of the window, and answers again after a restart', async (t) => {
  if (skipWithoutServer(t)) return;
  const { bart, ws, agent, key } = await setup();
  const account = fakeAccount(server.url);
  const a = makeRuns({ account });
  const answer = a.runs.takeKey(ws.id, { agent, key }, { owner: 1 });
  assert.equal(answer.key, undefined);
  assert.equal(answer.held, true);
  const view = await a.runs.start(ws.id, agent.id, { use: 'clark', name: 'Clark', owner: 1 });
  assert.equal(view.key, undefined);
  assert.ok(!JSON.stringify(a.runs.snapshot()).includes(key), 'the snapshot never holds the key');
  await until(() => phaseOf(a.runs, ws.id, agent.id) === 'running', 20000, 'running');

  await ask(bart, ws, '@Clark are you there?', agent);
  await until(async () => (await replies(bart, ws, agent.id)).length === 1, 20000, 'the reply', 250);
  assert.equal((await replies(bart, ws, agent.id))[0].text, 'Answered with clark.');
  // Neither the agent's key nor the backend's secret reached the backend program.
  assert.deepEqual(a.calls().map((c) => c.leaked), [false]);
  // On disk only encrypted: the setups file and the runner's state hold neither secret, and there is no config file.
  const disk = profileText(a.dataDir);
  assert.ok(!disk.includes(key) && !disk.includes('backend-secret-value'), 'no secret in the clear on disk');
  const saved = JSON.parse(fs.readFileSync(path.join(a.dataDir, 'agent-runs.json'), 'utf8'));
  assert.match(saved.runs[0].key, /^enc:/);
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(a.dataDir, 'agent-runs.json')).mode & 0o077, 0);
  // What the child wrote has no secret in it.
  const written = [...a.runs.live.values()].flatMap((s) => s.stderr || []).join('\n');
  assert.ok(!written.includes(key) && !written.includes('backend-secret-value'));

  // Rukoo quits and starts again: the runner comes back with the stored key, without a question.
  await a.runs.close();
  const b = makeRuns({ account, dataDir: a.dataDir, fakeEnv: { FAKE_REPLY: 'Back again.' }, ask: () => assert.fail('no question for what was approved') });
  t.after(() => b.runs.close());
  await until(() => phaseOf(b.runs, ws.id, agent.id) === 'running', 20000, 'running after the restart');
  await ask(bart, ws, '@Clark still there?', agent);
  await until(async () => (await replies(bart, ws, agent.id)).some((e) => e.text === 'Back again.'), 20000, 'the reply after the restart', 250);
});

test('New key replaces the stored key and the runner answers with it; Stop stops it and a mention gets no reply', async (t) => {
  if (skipWithoutServer(t)) return;
  const { olga, bart, ws, agent, key } = await setup();
  const a = makeRuns();
  t.after(() => a.runs.close());
  a.runs.takeKey(ws.id, { agent, key }, { owner: 1 });
  await a.runs.start(ws.id, agent.id, { use: 'claude', name: 'Clark', owner: 1 });
  await until(() => phaseOf(a.runs, ws.id, agent.id) === 'running', 20000, 'running');

  const rotated = await server.call('POST', `/v1/workspaces/${ws.id}/agents/${agent.id}/key`, { token: olga.token });
  assert.equal(rotated.status, 200, rotated.text);
  const answer = a.runs.takeKey(ws.id, rotated.body, { renew: true, owner: 1 });
  assert.equal(answer.runsHere, true);
  assert.equal(answer.key, undefined);
  await until(() => phaseOf(a.runs, ws.id, agent.id) === 'running' && viewOf(a.runs, ws.id, agent.id).connectedAt, 20000, 'running with the new key');
  await ask(bart, ws, '@Clark with the new key?', agent);
  await until(async () => (await replies(bart, ws, agent.id)).length === 1, 20000, 'the reply with the new key', 250);

  await a.runs.stop(ws.id, agent.id);
  assert.equal(phaseOf(a.runs, ws.id, agent.id), 'stopped');
  assert.equal(JSON.parse(fs.readFileSync(path.join(a.dataDir, 'agent-runs.json'), 'utf8')).runs[0].on, false);
  await ask(bart, ws, '@Clark anyone?', agent);
  await sleep(3000);
  assert.equal((await replies(bart, ws, agent.id)).length, 1, 'a stopped agent answers nothing');
});

test('quitting during a turn lets the runner end its program first, and the quit waits for that', async (t) => {
  if (skipWithoutServer(t)) return;
  const { bart, ws, agent, key } = await setup();
  const a = makeRuns({ fakeEnv: { FAKE_WAIT: '30000' }, stopWait: 8000 });
  t.after(() => a.runs.close());
  a.runs.takeKey(ws.id, { agent, key }, { owner: 1 });
  await a.runs.start(ws.id, agent.id, { use: 'claude', name: 'Clark', owner: 1 });
  await until(() => phaseOf(a.runs, ws.id, agent.id) === 'running', 20000, 'running');
  await ask(bart, ws, '@Clark take your time', agent);
  const [turn] = await until(() => (a.calls().length ? a.calls() : null), 20000, 'the turn');
  const started = Date.now();
  await a.runs.close();
  // The runner stopped its program with what that started, then ended by itself, before main had to end it.
  assert.ok(Date.now() - started < 8000, `closed in ${Date.now() - started} ms`);
  assert.ok(!a.lines.some((l) => /did not stop/.test(l)), a.lines.join('\n'));
  assert.equal(a.runs.procs.size, 0);
  assert.throws(() => process.kill(turn.pid, 0), (err) => err.code === 'ESRCH', 'the program of the turn is gone');
});

test('a key replaced elsewhere stops the runner for good; an agent removed on another device leaves this computer', async (t) => {
  if (skipWithoutServer(t)) return;
  const { olga, ws, agent, key } = await setup();
  const a = makeRuns({
    agentExists: async (wsId, id) => {
      const res = await server.call('GET', `/v1/workspaces/${wsId}/agents`, { token: olga.token });
      return res.status === 200 ? res.body.agents.some((x) => x.id === id) : null;
    }
  });
  t.after(() => a.runs.close());
  a.runs.takeKey(ws.id, { agent, key }, { owner: 1 });
  await a.runs.start(ws.id, agent.id, { use: 'claude', name: 'Clark', owner: 1 });
  await until(() => phaseOf(a.runs, ws.id, agent.id) === 'running', 20000, 'running');
  const rotated = await server.call('POST', `/v1/workspaces/${ws.id}/agents/${agent.id}/key`, { token: olga.token });
  assert.equal(rotated.status, 200);
  await until(() => phaseOf(a.runs, ws.id, agent.id) === 'refused', 20000, 'refused');
  await sleep(500);
  assert.equal(phaseOf(a.runs, ws.id, agent.id), 'refused');
  assert.equal(a.runs.procs.size, 0);
  const removed = await server.call('DELETE', `/v1/workspaces/${ws.id}/agents/${agent.id}`, { token: olga.token });
  assert.ok([200, 204].includes(removed.status), removed.text);
  // The directory the app loads next says so: the setup goes, stopped or not.
  a.runs.reconcile(ws.id, [{ id: `u_${'m'.repeat(22)}`, kind: 'human', state: 'active' }, { id: agent.id, kind: 'agent', state: 'removed' }], { complete: true });
  await until(() => a.runs.find(ws.id, agent.id) === null, 5000, 'the setup to go');
  assert.ok(!fs.existsSync(path.join(a.dataDir, 'agent-runs.json')));
  assert.deepEqual(fs.existsSync(path.join(a.dataDir, 'agent-runs')) ? fs.readdirSync(path.join(a.dataDir, 'agent-runs')) : [], []);
});

test('two agents run side by side; signing out stops both and deletes their keys', async (t) => {
  if (skipWithoutServer(t)) return;
  const { olga, bart, ws, agent, key } = await setup();
  const second = await server.seedAgent(olga, ws, { name: 'Revy', answers: 'everyone' });
  await server.call('POST', `/v1/workspaces/${ws.id}/channels/${ws.general}/members`, { token: olga.token, body: { member: second.agent.id } });
  const account = fakeAccount(server.url);
  const a = makeRuns({ account });
  t.after(() => a.runs.close());
  a.runs.takeKey(ws.id, { agent, key }, { owner: 1 });
  a.runs.takeKey(ws.id, second, { owner: 1 });
  await a.runs.start(ws.id, agent.id, { use: 'claude', name: 'Clark', owner: 1 });
  await a.runs.start(ws.id, second.agent.id, { use: 'clark', name: 'Revy', owner: 1 });
  await until(() => phaseOf(a.runs, ws.id, agent.id) === 'running' && phaseOf(a.runs, ws.id, second.agent.id) === 'running', 20000, 'both running');
  await ask(bart, ws, '@Clark one', agent);
  await ask(bart, ws, '@Revy two', second.agent);
  await until(async () => (await replies(bart, ws, agent.id)).length === 1 && (await replies(bart, ws, second.agent.id)).length === 1, 20000, 'both replies', 250);
  assert.equal((await replies(bart, ws, agent.id))[0].text, 'Answered with claude.');
  assert.equal((await replies(bart, ws, second.agent.id))[0].text, 'Answered with clark.');
  assert.equal(a.runs.procs.size, 2);
  account.signOut();
  assert.deepEqual(a.runs.snapshot(), { available: false, runs: [] });
  assert.ok(!fs.existsSync(path.join(a.dataDir, 'agent-runs.json')));
  await until(() => a.runs.procs.size === 0 && !fs.existsSync(path.join(a.dataDir, 'agent-runs')), 10000, 'the files to go');
  await rejects(a.runs.start(ws.id, agent.id, { use: 'claude' }), 'signed_out');
});

test('without a keyring nothing is offered or stored, and a key that is not the agent\'s own is not held', async (t) => {
  const a = makeRuns({ account: fakeAccount('http://127.0.0.1:9'), canKeep: () => false, fork: fakeForks() });
  t.after(() => a.runs.close());
  assert.equal(a.runs.snapshot().available, false);
  assert.ok(a.runs.hold(W, A, KEY, 1));
  await rejects(a.runs.start(W, A, { use: 'claude', owner: 1 }), 'no_keyring');
  assert.ok(!fs.existsSync(path.join(a.dataDir, 'agent-runs.json')));
  assert.equal(a.runs.hold(W, `u_${'c'.repeat(22)}`, KEY, 1), false);
  // A secrets module that would store it readable (plain:) counts as no keyring.
  const b = makeRuns({ account: fakeAccount('http://127.0.0.1:9'), fork: fakeForks(), secrets: { encrypt: (s) => `plain:${Buffer.from(s).toString('base64')}`, decrypt: (s) => s } });
  t.after(() => b.runs.close());
  b.runs.hold(W, A, KEY, 1);
  await rejects(b.runs.start(W, A, { use: 'claude', owner: 1 }), 'no_keyring');
  // The window can't name a program: only an agent of Settings, Agents.
  await rejects(b.runs.start(W, A, { use: 'command', owner: 1 }), 'unknown_backend');
});

test('setups made under another sign-in are deleted at the start, never run', async () => {
  const forks = fakeForks();
  const a = makeRuns({ account: fakeAccount('https://rukoo.example', 'session-one'), fork: forks, backendFor: fakeBackends() });
  a.runs.hold(W, A, KEY, 1);
  await a.runs.start(W, A, { use: 'claude', name: 'Clark', owner: 1 });
  const closing = a.runs.close();
  forks.all[0].exit(0);
  await closing;
  assert.ok(fs.existsSync(path.join(a.dataDir, 'agent-runs.json')));
  const b = makeRuns({ dataDir: a.dataDir, account: fakeAccount('https://rukoo.example', 'session-two'), backendFor: fakeBackends(), fork: () => assert.fail('a setup of another sign-in must not run') });
  assert.deepEqual(b.runs.snapshot().runs, []);
  assert.ok(!fs.existsSync(path.join(a.dataDir, 'agent-runs.json')));
  await b.runs.close();
});

test('runBackend builds the backend from Settings, Agents with the secret apart, and runnerEnv drops ELECTRON_RUN_AS_NODE', () => {
  const file = path.join(dir, 'agents.json');
  const cfg = new AgentConfig({ file, secrets: fakeSecrets() }).load();
  cfg.update({ clark: { url: 'http://127.0.0.1:8642', model: 'hermes-4' }, openclaw: { agent: 'ops', model: 'gpt-5' }, claude: { exe: '/opt/claude', configDir: TEAM } });
  cfg.setSecret('clark', 'hermes-secret');
  cfg.setSecret('openclaw', 'gateway-token');
  assert.deepEqual(runBackend(cfg, 'clark'), { name: 'Hermes', kind: 'hermes', backend: { type: 'runs', url: 'http://127.0.0.1:8642', model: 'hermes-4' }, secret: 'hermes-secret' });
  assert.deepEqual(runBackend(cfg, 'openclaw'), {
    name: 'OpenClaw',
    kind: 'openclaw',
    backend: { type: 'openai', url: 'http://127.0.0.1:18789', model: 'openclaw/ops', headers: { 'x-openclaw-model': 'gpt-5' } },
    secret: 'gateway-token'
  });
  assert.deepEqual(runBackend(cfg, 'claude'), { name: 'Claude', kind: 'claude', backend: { type: 'claude', exe: '/opt/claude', configDir: TEAM }, secret: '' });
  assert.deepEqual(runBackend(cfg, 'codex'), { name: 'Codex', kind: 'codex', backend: { type: 'codex' }, secret: '' });
  const id = cfg.addCustom({ preset: 'booper' });
  cfg.setSecret(id, 'booper-key');
  assert.deepEqual(runBackend(cfg, id), { name: 'Booper', kind: 'custom', backend: { type: 'runs', url: 'http://127.0.0.1:8662' }, secret: 'booper-key' });
  for (const use of ['command', 'mcp', 'phone', '', '../clark', 'cx_0000000000']) assert.equal(runBackend(cfg, use), null, use);
  assert.ok(!JSON.stringify(runBackend(cfg, 'clark').backend).includes('hermes-secret'));
  // OpenClaw is approved with the OpenClaw agent it asks.
  assert.deepEqual(identify('openclaw', runBackend(cfg, 'openclaw'), {}), { use: 'openclaw', kind: 'openclaw', type: 'openai', address: 'http://127.0.0.1:18789', agent: 'openclaw/ops' });
  assert.deepEqual(identify('claude', runBackend(cfg, 'claude'), { resolve: (type, exe) => exe }), { use: 'claude', kind: 'claude', type: 'claude', program: '/opt/claude', configDir: TEAM });
  assert.deepEqual(runnerEnv({ PATH: '/bin', ELECTRON_RUN_AS_NODE: '1', rukoo_agent_key: 'x' }), { PATH: '/bin' });
});

test("main's export config for each Settings agent is the one the key step shows, with the variable for its secret", async () => {
  const cfg = new AgentConfig({ file: path.join(dir, 'agents-mirror.json'), secrets: fakeSecrets() }).load();
  cfg.update({ clark: { url: 'https://hermes.example/', model: 'hermes-4' }, claude: { configDir: '/home/me/.claude-work', model: 'opus' }, codex: { exe: '/usr/bin/codex' }, openclaw: { agent: 'ops', model: 'gpt-5' } });
  cfg.setSecret('clark', 'hermes-secret');
  cfg.setSecret('openclaw', 'gateway-token');
  const id = cfg.addCustom({ preset: 'booper' });
  cfg.update({ custom: { [id]: { url: 'http://booper.example:8662' } } });
  cfg.setSecret(id, 'booper-key');
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/chat-agents.js'), 'utf8');
  const { runnerAgents, PLACEHOLDER_BACKEND, OWN_PROGRAM } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  const shown = runnerAgents(cfg.publicView());
  assert.deepEqual(
    shown.map((x) => x.id),
    ['clark', 'openclaw', 'claude', 'codex', id]
  );
  for (const x of shown) {
    assert.deepEqual(exportBackend(cfg, x.id), x.backend, x.id);
    const { keyEnv, ...backend } = x.backend;
    assert.deepEqual(runBackend(cfg, x.id).backend, backend, x.id);
  }
  assert.deepEqual(exportBackend(cfg, OWN_PROGRAM), { ...PLACEHOLDER_BACKEND });
  cfg.update({ codex: { enabled: false } });
  assert.equal(exportBackend(cfg, 'codex'), null);
});

// An HTTP server that notes whether a request carried a secret: for the end of the runner's backend.
test('only the address that was approved gets the backend secret, through the real child', async (t) => {
  if (skipWithoutServer(t)) return;
  const { bart, ws, agent, key } = await setup();
  const seen = [];
  const backend = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ url: req.url, auth: req.headers.authorization || null });
      if (req.url === '/v1/chat/completions') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: 'From the approved address.' }, finish_reason: 'stop' }] }));
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [] }));
    });
  });
  await new Promise((resolve) => backend.listen(0, '127.0.0.1', resolve));
  t.after(() => backend.close());
  const url = `http://127.0.0.1:${backend.address().port}`;
  let current = url;
  const a = makeRuns({ backendFor: (use) => (use === 'echo' ? { name: 'Echo', kind: 'custom', backend: { type: 'openai', url: current }, secret: 'echo-secret-value' } : null) });
  t.after(() => a.runs.close());
  a.runs.takeKey(ws.id, { agent, key }, { owner: 1 });
  await a.runs.start(ws.id, agent.id, { use: 'echo', owner: 1 });
  await until(() => phaseOf(a.runs, ws.id, agent.id) === 'running', 20000, 'running');
  await ask(bart, ws, '@Clark hello', agent);
  await until(async () => (await replies(bart, ws, agent.id)).length === 1, 20000, 'the reply', 250);
  assert.ok(seen.filter((s) => s.url === '/v1/chat/completions').every((s) => s.auth === 'Bearer echo-secret-value'));
  // Settings now point elsewhere: the runner stops, and nothing more reaches the old or the new address.
  current = 'http://127.0.0.1:9';
  a.runs.settingsChanged();
  await until(() => phaseOf(a.runs, ws.id, agent.id) === 'changed' && a.runs.procs.size === 0, 10000, 'changed');
});
