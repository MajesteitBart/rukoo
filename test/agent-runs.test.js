'use strict';

// "Run on this computer" (src/main/agent-runs.js): the supervisor that runs a team chat agent's runner in a process of
// its own, against the real account server (test/fixtures/real-server.js), with the command backend and a scripted
// fake agent. Plain Node forks the process where Electron makes a utility process. The keys are kept with a stand-in
// for safeStorage that marks what it encrypted. Needs server/node_modules (npm ci --prefix server) for the cases that
// talk to the server; they skip without it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { tempDir } = require('./tmp');
const { startRealServer, realServerAvailable, skipWithoutServer, mention } = require('./fixtures/real-server');
const { AgentRuns, RunError, runBackend, runnerEnv, runsApi } = require('../src/main/agent-runs.js');
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
  if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ leaked }) + '\\n');
  process.stdout.write(process.env.FAKE_REPLY || 'Hello from here.');
});
`;
// A runner child that ends at once with the code it is given: a crash, as agent-runs.js sees it.
const CRASH = `'use strict';
const code = Number(process.argv[3] || 1);
process.on('message', () => {});
setTimeout(() => process.exit(code), 20);
`;

let server;
let dir;
let fakePath;
let crashPath;
test.before(async () => {
  dir = tempDir('rukoo-agent-runs-');
  fakePath = path.join(dir, 'fake-agent.js');
  crashPath = path.join(dir, 'crash.js');
  fs.writeFileSync(fakePath, FAKE);
  fs.writeFileSync(crashPath, CRASH);
  if (realServerAvailable()) server = await startRealServer();
});
test.after(() => server?.close());

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref());
async function until(check, ms, what) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`Timed out after ${ms} ms waiting for ${what}`);
    await sleep(50);
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

let counter = 0;
function makeRuns({ account, canKeep = () => true, backendFor, agentExists, delays = [100, 200, 400], steady = 60000, child } = {}) {
  const dataDir = path.join(dir, `profile-${++counter}`);
  const logFile = path.join(dir, `calls-${counter}.jsonl`);
  const lines = [];
  const runs = new AgentRuns({
    dataDir,
    secrets: fakeSecrets(),
    canKeep,
    account: account || fakeAccount(server ? server.url : 'http://127.0.0.1:1'),
    backendFor:
      backendFor ||
      ((use) =>
        use === 'claude' || use === 'clark'
          ? { name: 'Fake', backend: { type: 'command', command: [process.execPath, fakePath], env: { FAKE_LOG: logFile, FAKE_REPLY: `Answered with ${use}.` }, timeout: 30 }, secret: use === 'clark' ? 'backend-secret-value' : '' }
          : null),
    agentExists,
    delays,
    steady,
    stopWait: 2000,
    ...(child ? { child } : {}),
    log: (level, message) => lines.push(`${level} ${message}`)
  }).init();
  return { runs, dataDir, lines, logFile, calls: () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []) };
}

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

const phaseOf = (runs, ws, agent) => runs.snapshot().runs.find((r) => r.ws === ws && r.agent === agent)?.phase;

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

test('Run on this computer answers a mention, keeps the key encrypted and out of the window, and answers again after a restart', async (t) => {
  if (skipWithoutServer(t)) return;
  const { bart, ws, agent, key } = await setup();
  const account = fakeAccount(server.url);
  const a = makeRuns({ account });
  // The window gets the server's answer without the key; main holds it for the key step.
  const answer = a.runs.takeKey(ws.id, { agent, key });
  assert.equal(answer.key, undefined);
  assert.equal(answer.held, true);
  assert.equal(a.runs.heldKey(ws.id, agent.id), key);
  const view = a.runs.start(ws.id, agent.id, { use: 'clark', name: 'Clark' });
  assert.equal(view.key, undefined);
  assert.ok(!JSON.stringify(a.runs.snapshot()).includes(key), 'the snapshot never holds the key');
  await until(() => phaseOf(a.runs, ws.id, agent.id) === 'running', 20000, 'running');

  await ask(bart, ws, '@Clark are you there?', agent);
  await until(async () => (await replies(bart, ws, agent.id)).length === 1, 20000, 'the reply');
  assert.equal((await replies(bart, ws, agent.id))[0].text, 'Answered with clark.');
  // Neither the agent's key nor the backend's secret reached the backend program.
  assert.deepEqual(a.calls().map((c) => c.leaked), [false]);
  // On disk only encrypted: the setups file and the runner's config and state hold neither secret.
  const disk = profileText(a.dataDir);
  assert.ok(!disk.includes(key) && !disk.includes('backend-secret-value'), 'no secret in the clear on disk');
  const saved = JSON.parse(fs.readFileSync(path.join(a.dataDir, 'agent-runs.json'), 'utf8'));
  assert.match(saved.runs[0].key, /^enc:/);
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(a.dataDir, 'agent-runs.json')).mode & 0o077, 0);

  // Rukoo quits and starts again: the runner comes back with the stored key, without the key step.
  a.runs.close();
  await sleep(500);
  const b = new AgentRuns({
    dataDir: a.dataDir,
    secrets: fakeSecrets(),
    canKeep: () => true,
    account,
    backendFor: (use) => (use === 'clark' ? { name: 'Fake', backend: { type: 'command', command: [process.execPath, fakePath], env: { FAKE_REPLY: 'Back again.' }, timeout: 30 }, secret: '' } : null)
  }).init();
  t.after(() => b.close());
  assert.equal(b.heldKey(ws.id, agent.id), null, 'a restart holds no key for the window');
  await until(() => phaseOf(b, ws.id, agent.id) === 'running', 20000, 'running after the restart');
  await ask(bart, ws, '@Clark still there?', agent);
  await until(async () => (await replies(bart, ws, agent.id)).some((e) => e.text === 'Back again.'), 20000, 'the reply after the restart');
});

test('New key replaces the stored key and the runner answers with it; Stop stops it and a mention gets no reply', async (t) => {
  if (skipWithoutServer(t)) return;
  const { olga, bart, ws, agent, key } = await setup();
  const a = makeRuns();
  t.after(() => a.runs.close());
  a.runs.takeKey(ws.id, { agent, key });
  a.runs.start(ws.id, agent.id, { use: 'claude', name: 'Clark' });
  await until(() => phaseOf(a.runs, ws.id, agent.id) === 'running', 20000, 'running');

  const rotated = await server.call('POST', `/v1/workspaces/${ws.id}/agents/${agent.id}/key`, { token: olga.token });
  assert.equal(rotated.status, 200, rotated.text);
  const answer = a.runs.takeKey(ws.id, rotated.body, { renew: true });
  assert.equal(answer.runsHere, true);
  assert.equal(answer.key, undefined);
  await until(() => phaseOf(a.runs, ws.id, agent.id) === 'running' && a.runs.live.get(a.runs.find(ws.id, agent.id)).connectedAt, 20000, 'running with the new key');
  await ask(bart, ws, '@Clark with the new key?', agent);
  await until(async () => (await replies(bart, ws, agent.id)).length === 1, 20000, 'the reply with the new key');

  a.runs.stop(ws.id, agent.id);
  assert.equal(phaseOf(a.runs, ws.id, agent.id), 'stopped');
  assert.equal(JSON.parse(fs.readFileSync(path.join(a.dataDir, 'agent-runs.json'), 'utf8')).runs[0].on, false);
  await sleep(1500);
  await ask(bart, ws, '@Clark anyone?', agent);
  await sleep(3000);
  assert.equal((await replies(bart, ws, agent.id)).length, 1, 'a stopped agent answers nothing');
});

test('a key replaced elsewhere stops the runner for good; removing the agent deletes its setup', async (t) => {
  if (skipWithoutServer(t)) return;
  const { olga, ws, agent, key } = await setup();
  let exists = true;
  const a = makeRuns({ agentExists: async () => exists });
  t.after(() => a.runs.close());
  a.runs.takeKey(ws.id, { agent, key });
  a.runs.start(ws.id, agent.id, { use: 'claude', name: 'Clark' });
  await until(() => phaseOf(a.runs, ws.id, agent.id) === 'running', 20000, 'running');
  // New key on another device: this computer's key stops working, and the runner doesn't start again.
  const rotated = await server.call('POST', `/v1/workspaces/${ws.id}/agents/${agent.id}/key`, { token: olga.token });
  assert.equal(rotated.status, 200);
  await until(() => phaseOf(a.runs, ws.id, agent.id) === 'refused', 20000, 'refused');
  await sleep(500);
  assert.equal(phaseOf(a.runs, ws.id, agent.id), 'refused');
  assert.equal(a.runs.live.get(a.runs.find(ws.id, agent.id)).child, null);

  // The agent is removed: a refused setup whose agent is gone is deleted with its files.
  const removed = await server.call('DELETE', `/v1/workspaces/${ws.id}/agents/${agent.id}`, { token: olga.token });
  assert.ok([200, 204].includes(removed.status));
  exists = false;
  a.runs.forget(ws.id, agent.id);
  assert.equal(a.runs.find(ws.id, agent.id), null);
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
  a.runs.takeKey(ws.id, { agent, key });
  a.runs.takeKey(ws.id, second);
  a.runs.start(ws.id, agent.id, { use: 'claude', name: 'Clark' });
  a.runs.start(ws.id, second.agent.id, { use: 'clark', name: 'Revy' });
  await until(() => phaseOf(a.runs, ws.id, agent.id) === 'running' && phaseOf(a.runs, ws.id, second.agent.id) === 'running', 20000, 'both running');
  await ask(bart, ws, '@Clark one', agent);
  await ask(bart, ws, '@Revy two', second.agent);
  await until(async () => (await replies(bart, ws, agent.id)).length === 1 && (await replies(bart, ws, second.agent.id)).length === 1, 20000, 'both replies');
  assert.equal((await replies(bart, ws, agent.id))[0].text, 'Answered with claude.');
  assert.equal((await replies(bart, ws, second.agent.id))[0].text, 'Answered with clark.');

  const children = [...a.runs.live.values()].map((s) => s.child).filter(Boolean);
  assert.equal(children.length, 2);
  account.signOut();
  assert.deepEqual(a.runs.snapshot(), { available: false, runs: [] });
  assert.ok(!fs.existsSync(path.join(a.dataDir, 'agent-runs.json')));
  assert.ok(!fs.existsSync(path.join(a.dataDir, 'agent-runs')));
  assert.equal(a.runs.heldKey(ws.id, agent.id), null);
  assert.throws(() => a.runs.start(ws.id, agent.id, { use: 'claude' }), (err) => err instanceof RunError && err.code === 'signed_out');
});

test('a runner that crashes starts again after pauses that grow, and Stop ends the retries', async (t) => {
  const W = 'w_AbCdEfGhIjKlMnOpQrStUv';
  const A = `u_${'a'.repeat(22)}`;
  const KEY = `rka_${'a'.repeat(22)}.${'b'.repeat(43)}`;
  const starts = [];
  const { fork } = require('child_process');
  const a = makeRuns({
    account: fakeAccount('http://127.0.0.1:9'),
    delays: [100, 300, 900],
    child: crashPath
  });
  // The crash child, through the fork the supervisor would use, counted.
  a.runs.fork = (file, args, opts) => {
    starts.push(Date.now());
    const child = fork(file, [...args, '1'], { env: opts.env, execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    // A stop sent as the crash child ends fails with EPIPE, as in forkRunner.
    child.on('error', () => {});
    return { post: (m) => child.connected && child.send(m, () => {}), onMessage: (fn) => child.on('message', fn), onExit: (fn) => child.on('exit', (c) => fn(c === null ? -1 : c)), stderr: child.stderr, kill: () => child.kill() };
  };
  t.after(() => a.runs.close());
  assert.ok(a.runs.hold(W, A, KEY));
  a.runs.start(W, A, { use: 'claude', name: 'Clark' });
  await until(() => starts.length >= 4, 15000, 'four starts');
  const gaps = starts.slice(1).map((s, i) => s - starts[i]);
  assert.ok(gaps[0] >= 90 && gaps[1] >= 290 && gaps[2] >= 890, `the pauses grow: ${gaps.join(', ')}`);
  const view = a.runs.snapshot().runs[0];
  assert.ok(['waiting', 'starting'].includes(view.phase));
  a.runs.stop(W, A);
  const n = starts.length;
  await sleep(1500);
  assert.equal(starts.length, n, 'no start after Stop');
  assert.equal(phaseOf(a.runs, W, A), 'stopped');
});

test('without a keyring nothing is offered or stored, and a held key goes after its time', async (t) => {
  const W = 'w_AbCdEfGhIjKlMnOpQrStUv';
  const A = `u_${'a'.repeat(22)}`;
  const KEY = `rka_${'a'.repeat(22)}.${'b'.repeat(43)}`;
  const a = makeRuns({ account: fakeAccount('http://127.0.0.1:9'), canKeep: () => false });
  t.after(() => a.runs.close());
  assert.equal(a.runs.snapshot().available, false);
  assert.ok(a.runs.hold(W, A, KEY));
  assert.throws(() => a.runs.start(W, A, { use: 'claude' }), (err) => err.code === 'no_keyring');
  assert.ok(!fs.existsSync(path.join(a.dataDir, 'agent-runs.json')));
  // A key that isn't the agent's own isn't held.
  assert.equal(a.runs.hold(W, `u_${'c'.repeat(22)}`, KEY), false);
  // A secrets module that would store it readable (plain:) counts as no keyring.
  const b = makeRuns({ account: fakeAccount('http://127.0.0.1:9') });
  b.runs.secrets = { encrypt: (s) => `plain:${Buffer.from(s).toString('base64')}`, decrypt: (s) => s };
  t.after(() => b.runs.close());
  b.runs.hold(W, A, KEY);
  assert.throws(() => b.runs.start(W, A, { use: 'claude' }), (err) => err.code === 'no_keyring');
  // The window can't name a program: only an agent of Settings, Agents.
  const c = makeRuns({ account: fakeAccount('http://127.0.0.1:9') });
  t.after(() => c.runs.close());
  c.runs.hold(W, A, KEY);
  assert.throws(() => c.runs.start(W, A, { use: 'command' }), (err) => err.code === 'unknown_backend');
  // A held key goes after its time.
  c.runs.heldFor = 50;
  c.runs.hold(W, A, KEY);
  await sleep(150);
  assert.equal(c.runs.heldKey(W, A), null);
});

test('runsApi keeps the key from the window, checks ids, and removing an agent forgets its setup', async () => {
  const W = 'w_AbCdEfGhIjKlMnOpQrStUv';
  const A = `u_${'a'.repeat(22)}`;
  const KEY = `rka_${'a'.repeat(22)}.${'b'.repeat(43)}`;
  const forgotten = [];
  const fake = {
    takeKey: (ws, answer) => ({ agent: answer.agent, held: true }),
    forget: (ws, agent) => forgotten.push([ws, agent]),
    start: () => ({}),
    snapshot: () => ({ available: true, runs: [] })
  };
  const api = runsApi(() => fake, {
    chatCreateAgent: async () => ({ agent: { id: A }, key: KEY }),
    chatNewAgentKey: async () => ({ agent: { id: A }, key: KEY }),
    chatRemoveAgent: async () => true
  });
  assert.ok(!JSON.stringify(await api.chatCreateAgent(W, {})).includes('rka_'));
  assert.ok(!JSON.stringify(await api.chatNewAgentKey(W, A)).includes('rka_'));
  assert.equal(await api.chatRemoveAgent(W, A), true);
  assert.deepEqual(forgotten, [[W, A]]);
  assert.throws(() => api.agentRunStart('../x', A, {}), (err) => err.code === 'invalid');
  assert.throws(() => api.agentRunStop(W, 'u_short'), (err) => err.code === 'invalid');
});

test('runBackend builds the backend from Settings, Agents with the secret apart, and runnerEnv drops ELECTRON_RUN_AS_NODE', () => {
  const file = path.join(dir, 'agents.json');
  const cfg = new AgentConfig({ file, secrets: fakeSecrets() }).load();
  cfg.update({ clark: { url: 'http://127.0.0.1:8642', model: 'hermes-4' }, openclaw: { agent: 'ops', model: 'gpt-5' }, claude: { exe: '/opt/claude', configDir: '/home/me/.claude-team' } });
  cfg.setSecret('clark', 'hermes-secret');
  cfg.setSecret('openclaw', 'gateway-token');
  assert.deepEqual(runBackend(cfg, 'clark'), { name: 'Hermes', backend: { type: 'runs', url: 'http://127.0.0.1:8642', model: 'hermes-4' }, secret: 'hermes-secret' });
  assert.deepEqual(runBackend(cfg, 'openclaw'), {
    name: 'OpenClaw',
    backend: { type: 'openai', url: 'http://127.0.0.1:18789', model: 'openclaw/ops', headers: { 'x-openclaw-model': 'gpt-5' } },
    secret: 'gateway-token'
  });
  assert.deepEqual(runBackend(cfg, 'claude'), { name: 'Claude', backend: { type: 'claude', exe: '/opt/claude', configDir: '/home/me/.claude-team' }, secret: '' });
  assert.deepEqual(runBackend(cfg, 'codex'), { name: 'Codex', backend: { type: 'codex' }, secret: '' });
  const id = cfg.addCustom({ preset: 'booper' });
  cfg.setSecret(id, 'booper-key');
  assert.deepEqual(runBackend(cfg, id), { name: 'Booper', backend: { type: 'runs', url: 'http://127.0.0.1:8662' }, secret: 'booper-key' });
  // Nothing else: no command, no unknown id, no config path.
  for (const use of ['command', 'mcp', 'phone', '', '../clark', 'cx_0000000000']) assert.equal(runBackend(cfg, use), null, use);
  // The backend config holds no secret: the runner gets it in its first message.
  assert.ok(!JSON.stringify(runBackend(cfg, 'clark').backend).includes('hermes-secret'));
  assert.deepEqual(runnerEnv({ PATH: '/bin', ELECTRON_RUN_AS_NODE: '1', rukoo_agent_key: 'x' }), { PATH: '/bin' });
});

test('an agent removed on another device stops here and its setup goes by itself, once the workspace no longer lists it', async (t) => {
  if (skipWithoutServer(t)) return;
  const { olga, ws, agent, key } = await setup();
  const a = makeRuns({
    agentExists: async (wsId, id) => {
      const res = await server.call('GET', `/v1/workspaces/${wsId}/agents`, { token: olga.token });
      return res.status === 200 ? res.body.agents.some((x) => x.id === id) : null;
    }
  });
  t.after(() => a.runs.close());
  a.runs.takeKey(ws.id, { agent, key });
  a.runs.start(ws.id, agent.id, { use: 'claude', name: 'Clark' });
  await until(() => phaseOf(a.runs, ws.id, agent.id) === 'running', 20000, 'running');
  const removed = await server.call('DELETE', `/v1/workspaces/${ws.id}/agents/${agent.id}`, { token: olga.token });
  assert.ok([200, 204].includes(removed.status), removed.text);
  await until(() => a.runs.find(ws.id, agent.id) === null, 20000, 'the setup to go');
  // The runner's state file can be written while it stops; it goes once the process ended.
  await until(() => !fs.existsSync(path.join(a.dataDir, 'agent-runs')) || fs.readdirSync(path.join(a.dataDir, 'agent-runs')).length === 0, 10000, 'its files to go');
  assert.ok(!fs.existsSync(path.join(a.dataDir, 'agent-runs.json')));
});

test('setups made under another sign-in are deleted at the start, never run', async () => {
  const W = 'w_AbCdEfGhIjKlMnOpQrStUv';
  const A = `u_${'a'.repeat(22)}`;
  const KEY = `rka_${'a'.repeat(22)}.${'b'.repeat(43)}`;
  const forks = [];
  const a = makeRuns({ account: fakeAccount('https://rukoo.example', 'session-one') });
  a.runs.fork = () => {
    forks.push(1);
    return { post() {}, onMessage() {}, onExit() {}, kill() {} };
  };
  a.runs.hold(W, A, KEY);
  a.runs.start(W, A, { use: 'claude', name: 'Clark' });
  a.runs.close();
  assert.ok(fs.existsSync(path.join(a.dataDir, 'agent-runs.json')));
  const b = new AgentRuns({ dataDir: a.dataDir, secrets: fakeSecrets(), canKeep: () => true, account: fakeAccount('https://rukoo.example', 'session-two'), backendFor: () => ({ name: 'x', backend: { type: 'claude' }, secret: '' }), fork: () => assert.fail('a setup of another sign-in must not run') }).init();
  assert.deepEqual(b.snapshot().runs, []);
  assert.ok(!fs.existsSync(path.join(a.dataDir, 'agent-runs.json')));
  b.close();
  assert.equal(forks.length, 1);
});

test("main's backend for each Settings agent is the one the key step's config shows, without the variable for its secret", async () => {
  const cfg = new AgentConfig({ file: path.join(dir, 'agents-mirror.json'), secrets: fakeSecrets() }).load();
  cfg.update({ clark: { url: 'https://hermes.example/', model: 'hermes-4' }, claude: { configDir: '/home/me/.claude-work', model: 'opus' }, codex: { exe: '/usr/bin/codex' }, openclaw: { agent: 'ops', model: 'gpt-5' } });
  cfg.setSecret('clark', 'hermes-secret');
  cfg.setSecret('openclaw', 'gateway-token');
  const id = cfg.addCustom({ preset: 'booper' });
  cfg.update({ custom: { [id]: { url: 'http://booper.example:8662' } } });
  cfg.setSecret(id, 'booper-key');
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/chat-agents.js'), 'utf8');
  const { runnerAgents } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  const shown = runnerAgents(cfg.publicView());
  assert.deepEqual(
    shown.map((x) => x.id),
    ['clark', 'openclaw', 'claude', 'codex', id]
  );
  for (const x of shown) {
    const { keyEnv, ...backend } = x.backend;
    assert.deepEqual(runBackend(cfg, x.id).backend, backend, x.id);
  }
});
