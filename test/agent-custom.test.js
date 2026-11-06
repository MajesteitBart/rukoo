'use strict';

// Custom agents: the user's own agents on a server that speaks the Runs API (Booper, Hermes) or OpenAI's Chat
// Completions (config.js CUSTOM_PRESETS, openai.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { tempDir } = require('./tmp');
const { Engine } = require('../src/main/engine');
const { AgentHub } = require('../src/main/agents/hub');
const { AgentConfig, customTokenFor, isCustomId, READ_ONLY_TOOLS } = require('../src/main/agents/config');
const { FakeAdapter } = require('../src/main/agents/fake');
const { HermesAdapter, serverName } = require('../src/main/agents/hermes');
const { OpenAiAdapter, trimHistory, HISTORY_MAX } = require('../src/main/agents/openai');

const secrets = {
  encrypt: (s) => `enc:${Buffer.from(String(s)).toString('hex')}`,
  decrypt: (s) => (String(s).startsWith('enc:') ? Buffer.from(String(s).slice(4), 'hex').toString() : String(s))
};
const tailnet = () => ({ Tailscale: [{ address: '100.101.12.7', family: 'IPv4', internal: false }] });

function config() {
  const file = path.join(tempDir('sem-custom-cfg-'), 'agents.json');
  return { file, cfg: new AgentConfig({ file, secrets, interfaces: tailnet }).load() };
}

// ---------- config ----------

test('custom agents: added from a preset with a name of their own, stored without secrets in the view', () => {
  const { file, cfg } = config();
  const booper = cfg.addCustom({ preset: 'booper' });
  const second = cfg.addCustom({ preset: 'booper' });
  const openai = cfg.addCustom({ preset: 'openai' });
  assert.ok(isCustomId(booper) && isCustomId(second) && isCustomId(openai));
  assert.equal(new Set([booper, second, openai]).size, 3);
  assert.deepEqual(cfg.agentIds(), ['clark', 'claude', 'codex', 'openclaw', booper, second, openai]);
  assert.equal(cfg.displayName(booper), 'Booper');
  assert.equal(cfg.displayName(second), 'Booper 2', 'two agents never share a name');
  assert.equal(cfg.custom(booper).protocol, 'runs');
  assert.equal(cfg.custom(openai).protocol, 'openai');
  assert.equal(cfg.custom(booper).url, 'http://127.0.0.1:8662');
  assert.throws(() => cfg.addCustom({ preset: 'langchain' }), /invalid/);

  cfg.update({ custom: { [booper]: { name: '  Clark  ', url: 'http://100.64.0.9:8662/', model: 'sol', remote: true } }, defaultAgent: booper });
  cfg.setSecret(booper, 'dudan-token');
  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(!raw.includes('dudan-token'), 'the key is encrypted on disk');
  const view = cfg.publicView();
  const shown = view.custom.find((x) => x.id === booper);
  assert.deepEqual([shown.name, shown.url, shown.model, shown.remote, shown.hasKey], ['Clark', 'http://100.64.0.9:8662', 'sol', true, true]);
  assert.ok(!('key' in shown) && !('seed' in shown), 'never the key or the seed');
  assert.equal(view.defaultAgent, booper);
  assert.equal(cfg.get(booper).key, 'dudan-token');
  assert.ok(!('seed' in cfg.get(booper)));
  assert.equal(cfg.enabled(booper), true);

  assert.throws(() => cfg.update({ custom: { cx_0000000000: { name: 'x' } } }), /invalid/);
  assert.throws(() => cfg.update({ custom: { [booper]: { url: 'ftp://x' } } }), /invalid/);
  assert.throws(() => cfg.update({ defaultAgent: 'cx_0000000000' }), /invalid/);

  // The file again, with an entry a later Rukoo or a hand edit left behind.
  const stored = JSON.parse(raw);
  stored.custom.push({ id: 'cx_bad', protocol: 'runs' }, { id: 'cx_aaaaaaaaaa', protocol: 'grpc' }, { ...stored.custom[0] });
  fs.writeFileSync(file, JSON.stringify(stored));
  const again = new AgentConfig({ file, secrets, interfaces: tailnet }).load();
  assert.deepEqual(again.agentIds().slice(4), [booper, second, openai], 'bad, unknown and repeated entries are dropped');
  assert.equal(again.data.defaultAgent, booper);

  assert.equal(again.removeCustom(booper), true);
  assert.equal(again.data.defaultAgent, 'clark', 'the default goes back to Hermes with its agent');
  assert.equal(again.removeCustom(booper), false);
  assert.equal(again.enabled(booper), false, 'a removed agent counts as off');
  assert.equal(again.displayName(booper), 'Removed agent');
});

test('custom agents: tokens of their own for each listener, and a setup that holds them', () => {
  const { cfg } = config();
  const a = cfg.addCustom({ preset: 'booper' });
  const b = cfg.addCustom({ preset: 'openai' });
  assert.equal(cfg.customToken(a), '', 'no token before the first copy');
  assert.ok(!('seed' in cfg.custom(a)) || !cfg.custom(a).seed, 'adding an agent stores no secret');
  cfg.ensureSeed(a);
  cfg.ensureSeed(b);
  const local = cfg.customToken(a);
  assert.ok(local, 'an agent without a key still gets a token');
  cfg.ensureSeed(a);
  assert.equal(cfg.customToken(a), local, 'the seed is made once');
  assert.equal(local, customTokenFor(secrets.decrypt(cfg.custom(a).seed), a));
  assert.notEqual(local, cfg.customToken(b), 'two agents never share a token');
  assert.equal(cfg.customToken(a, true), '', 'no remote token until the user allows it');
  cfg.update({ custom: { [a]: { remote: true } } });
  const remote = cfg.customToken(a, true);
  assert.ok(remote && remote !== local);
  cfg.setSecret(a, 'new-key');
  assert.equal(cfg.customToken(a), local, 'a new key keeps the setup working');
  cfg.update({ custom: { [a]: { enabled: false } } });
  assert.equal(cfg.customToken(a, true), '', 'an agent turned off loses its remote token');
  cfg.update({ custom: { [a]: { enabled: true } } });

  const booper = cfg.customSetup(a, { remote: true, host: '100.101.12.7', port: 47801 });
  assert.match(booper, /^# Rukoo Mail: lets Booper/);
  assert.ok(booper.includes(`RUKOO_MCP_AUTHORIZATION=Bearer ${remote}`));
  assert.ok(booper.includes('      url: http://100.101.12.7:47801/mcp'));
  assert.ok(booper.includes('      headersEnv: { Authorization: RUKOO_MCP_AUTHORIZATION }'));
  assert.ok(booper.includes(`      safeTools: [${READ_ONLY_TOOLS.join(', ')}]`));
  assert.ok(!booper.includes('new-key'), 'never the agent key');

  const other = cfg.customSetup(b, { host: '127.0.0.1', port: 47800 });
  const json = JSON.parse(other.split('\n').filter((l) => !l.startsWith('//')).join('\n'));
  assert.deepEqual(json, { rukoo: { url: 'http://127.0.0.1:47800/mcp', transport: 'streamable-http', headers: { Authorization: `Bearer ${cfg.customToken(b)}` } } });
  assert.equal(cfg.customSetup('cx_0000000000'), '');
});

// ---------- hub ----------

async function demo() {
  const dir = tempDir('sem-custom-');
  const engine = new Engine({ dataDir: dir }).init();
  const acc = await engine.addAccount({ type: 'demo' });
  await engine.syncAccount(acc.id);
  return { dir, engine };
}

function hubOf(env, adapters) {
  return new AgentHub({
    engine: env.engine,
    dataDir: env.dir,
    secrets,
    deps: { appVersion: '1.0.0', workspace: path.join(env.dir, 'workspace') },
    adapters,
    listen: false
  });
}

async function idle(hub, cid, ms = 20000) {
  const end = Date.now() + ms;
  while (hub.turns.has(cid)) {
    if (Date.now() > end) throw new Error('turn did not finish');
    await new Promise((r) => setTimeout(r, 10));
  }
  await new Promise((r) => setImmediate(r));
}

test('hub: a custom agent gets an adapter, chats and Rukoo tokens, and loses them all when removed', async () => {
  const env = await demo();
  const made = [];
  const make = (opts) => {
    made.push(opts);
    return new FakeAdapter({ ...opts, scale: 0.02 });
  };
  const hub = hubOf(env, { clark: make, claude: make, 'custom:runs': make, 'custom:openai': make });
  hub.cfg.interfaces = tailnet;
  await hub.start();
  try {
    const { id } = hub.addCustomAgent('booper');
    assert.ok(hub.adapters.has(id));
    assert.equal(made.at(-1).custom, true, 'the adapter knows it is a custom agent');
    assert.equal(hub.config().custom[0].id, id);

    const c = hub.create({ agent: id });
    assert.equal(c.agent, id);
    assert.equal(hub.localAgent(c), false, 'a custom agent gets text, never local paths');
    hub.send(c.id, { text: 'Hello' });
    await idle(hub, c.id);
    assert.ok(c.items.some((i) => i.type === 'assistant'));

    hub.copyCustomSetup(id);
    const local = hub.cfg.customToken(id);
    assert.ok(local);
    assert.deepEqual(hub.identify(local), { agent: id, conversationId: null, remote: false });
    assert.equal(hub.agentAllowed(id, false), true);
    assert.equal(hub.agentAllowed(id, true), false, 'not from another computer until the user allows it');
    assert.equal(hub.wantsRemote(), false);
    await hub.updateConfig({ custom: { [id]: { remote: true } } });
    assert.equal(hub.wantsRemote(), true, 'allowing it opens the Tailscale listener');
    const remote = hub.cfg.customToken(id, true);
    assert.deepEqual(hub.identify(remote), { agent: id, conversationId: null, remote: true });
    assert.equal(hub.agentAllowed(id, true), true);

    const status = await hub.agentStatus(id);
    assert.equal(status.state, 'ready');

    // An identity taken from a request whose body comes in after the agent lost that listener, or was removed: the
    // call itself is refused.
    const viaTailnet = { agent: id, conversationId: null, remote: true };
    const viaLoopback = { agent: id, conversationId: null, remote: false };
    assert.ok(!/may no longer/.test(JSON.stringify(await hub.callTool(viaTailnet, 'get_context', {}))), 'allowed while remote is on');
    await hub.updateConfig({ custom: { [id]: { remote: false } } });
    const late = await hub.callTool(viaTailnet, 'get_context', {});
    assert.equal(late.isError, true);
    assert.match(late.content[0].text, /may no longer use Rukoo's tools/);
    assert.ok(!/may no longer/.test(JSON.stringify(await hub.callTool(viaLoopback, 'get_context', {}))), 'the loopback listener still works');

    await hub.removeCustomAgent(id);
    const gone = await hub.callTool(viaLoopback, 'get_context', {});
    assert.equal(gone.isError, true, 'removal closes a request already under way');
    assert.match(gone.content[0].text, /^This agent may no longer use Rukoo's tools/);
    assert.ok(!hub.adapters.has(id));
    assert.equal(hub.identify(local), null, 'its tokens stop working at once');
    assert.equal(hub.identify(remote), null);
    assert.equal(hub.wantsRemote(), false);
    assert.ok(hub.conversations.has(c.id), 'its chats stay');
    assert.throws(() => hub.send(c.id, { text: 'Still there?' }), /disabled/);
    await assert.rejects(hub.removeCustomAgent(id), /invalid/);
  } finally {
    await hub.dispose();
  }

  // After a restart the chat of the removed agent is still there.
  const again = hubOf(env, { clark: make, claude: make });
  await again.start();
  try {
    assert.equal(again.list().length >= 1, true);
    assert.ok([...again.conversations.values()].some((x) => isCustomId(x.agent)));
  } finally {
    await again.dispose();
  }
});

// ---------- Runs API (Hermes adapter) against Booper's answers ----------

// A server that answers like Booper's dudan channel (clark repo: src/channels/dudan).
function booperServer() {
  const runs = [];
  const server = http.createServer((req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      if (url.pathname === '/health') return send(200, { status: 'ok', platform: 'clark', ok: true, version: 1, server: { name: 'Booper', version: '0.2.1' } });
      if (req.headers.authorization !== 'Bearer tok') return send(401, { error: { message: 'unauthorized' } });
      if (url.pathname === '/v1/capabilities') return send(200, { features: { run_submission: true, run_events_sse: true, run_steer: true } });
      if (url.pathname === '/v1/models') return send(200, { object: 'list', data: [{ id: 'sol', object: 'model', root: 'openai-codex/gpt-6.1-sol', parent: null, default: true }] });
      if (url.pathname === '/api/model/options') {
        return send(200, {
          current_provider: 'clark',
          current_model: 'sol',
          providers: [{ slug: 'clark', name: 'Clark', authenticated: true, models: [{ id: 'sol', label: 'sol (openai-codex/gpt-6.1-sol)' }, { id: 'fast', label: 'fast (openrouter/x)' }], capabilities: { sol: { reasoning: true }, fast: { reasoning: false } } }]
        });
      }
      if (url.pathname === '/api/sessions' && req.method === 'POST') return send(200, { session: { id: 'dudan_1' } });
      if (url.pathname === '/v1/runs' && req.method === 'POST') {
        runs.push(JSON.parse(body));
        return send(202, { run_id: `run_${runs.length}`, status: 'queued' });
      }
      if (/^\/v1\/runs\/[^/]+\/events$/.test(url.pathname)) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(': open\n\n');
        res.write(`id: 1\ndata: ${JSON.stringify({ event: 'run.progress', phase: 'run', state: 'running', status: 'running' })}\n\n`);
        res.end(`id: 2\ndata: ${JSON.stringify({ event: 'run.completed', output: 'pong', usage: { input_tokens: 3, output_tokens: 1 } })}\n\n`);
        return;
      }
      send(404, { error: { message: 'not found' } });
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, runs, url: `http://127.0.0.1:${server.address().port}` })));
}

test('runs api: Booper names itself, lists its model profiles, and gets the effort in the field it reads', async () => {
  assert.equal(serverName({ version: 1, server: { name: 'Booper', version: '0.2.1' } }), 'Booper 0.2.1');
  assert.equal(serverName({ version: '0.21.0' }), 'Hermes 0.21.0');
  assert.equal(serverName({ version: 1 }), 'Hermes', 'a protocol number is no version');
  assert.equal(serverName({ server: { name: '<b>x</b>' } }), 'Hermes', 'an odd name is not shown');

  const b = await booperServer();
  try {
    const adapter = new HermesAdapter({ id: 'cx_aaaaaaaaaa', custom: true, config: () => ({ name: 'Clark', url: b.url, key: 'tok' }) });
    assert.deepEqual(await adapter.status({ force: true }), { state: 'ready', detail: 'Booper 0.2.1' });
    const { models } = await adapter.models();
    assert.deepEqual(
      models.map((m) => [m.id, m.label, m.isDefault === true, m.efforts.length > 0]),
      [
        ['clark::sol', 'sol (openai-codex/gpt-6.1-sol)', true, true],
        ['clark::fast', 'fast (openrouter/x)', false, false]
      ]
    );
    const conversation = { id: 'c_1', title: 'Probe', provider: {}, items: [] };
    const events = [];
    const turn = { id: 't_1', conversation, input: 'ping', model: 'clark::sol', effort: 'high', emit: (e) => events.push(e), setProvider: (p) => Object.assign(conversation.provider, p), signal: new AbortController().signal };
    assert.deepEqual(await adapter.runTurn(turn), { status: 'done' });
    assert.deepEqual(b.runs[0].model_options, { reasoning: { effort: 'high' }, reasoning_effort: 'high' });
    assert.equal(b.runs[0].model, 'sol');
    assert.ok(events.some((e) => e.type === 'text' && e.delta === 'pong'));

    // Hermes itself keeps the request it had.
    const hermes = new HermesAdapter({ id: 'clark', config: () => ({ name: 'Clark', url: b.url, key: 'tok' }) });
    await hermes.runTurn({ ...turn, id: 't_2', conversation: { id: 'c_2', provider: {}, items: [] } });
    assert.deepEqual(b.runs[1].model_options, { reasoning: { effort: 'high' } });
  } finally {
    b.server.close();
  }
});

// ---------- OpenAI-compatible ----------

function openaiServer({ key = '' } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      if (key && req.headers.authorization !== `Bearer ${key}`) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'bad key' } }));
      }
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ object: 'list', data: [{ id: 'agent-a' }, { id: 'agent-b' }, { id: 'agent-a' }] }));
      }
      if (req.url === '/v1/chat/completions') {
        const parsed = JSON.parse(body);
        requests.push(parsed);
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const n = requests.length;
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '\n\nAnswer ' } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `${n}` }, finish_reason: 'stop' }] })}\n\n`);
        return res.end('data: [DONE]\n\n');
      }
      res.writeHead(404);
      res.end();
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, requests, url: `http://127.0.0.1:${server.address().port}` })));
}

function openaiTurn(conversation, input, extra = {}) {
  const events = [];
  return {
    events,
    turn: { id: `t_${input}`, conversation, input, instructions: 'You are in Rukoo.', emit: (e) => events.push(e), setProvider: (p) => Object.assign(conversation.provider, p), signal: new AbortController().signal, ...extra }
  };
}

test('openai: lists the models, streams the answer and sends the earlier turns of a chat', async () => {
  const s = await openaiServer({ key: 'secret' });
  try {
    const cfg = { name: 'Agent', url: s.url, key: 'secret', model: '', history: true };
    const adapter = new OpenAiAdapter({ id: 'cx_bbbbbbbbbb', config: () => cfg });
    assert.deepEqual(await adapter.status({ force: true }), { state: 'ready', detail: 'OpenAI-compatible, 3 models' });
    assert.deepEqual((await adapter.models()).models.map((m) => m.id), ['agent-a', 'agent-b']);
    const refused = new OpenAiAdapter({ id: 'cx_cccccccccc', config: () => ({ ...cfg, key: 'wrong' }) });
    assert.equal((await refused.status({ force: true })).state, 'unauthorized');

    const conversation = { id: 'c_9', provider: {}, items: [] };
    const first = openaiTurn(conversation, 'First, with the email');
    assert.deepEqual(await adapter.runTurn(first.turn), { status: 'done' });
    assert.deepEqual(first.events, [{ type: 'text', delta: 'Answer ' }, { type: 'text', delta: '1' }]);
    assert.deepEqual(s.requests[0].messages, [
      { role: 'system', content: 'You are in Rukoo.' },
      { role: 'user', content: 'First, with the email' }
    ]);
    assert.equal(s.requests[0].model, 'default');
    assert.equal(s.requests[0].user, 'rukoo:c_9');
    assert.equal(s.requests[0].stream, true);

    const second = openaiTurn(conversation, 'And then?', { model: 'agent-b' });
    await adapter.runTurn(second.turn);
    assert.equal(s.requests[1].model, 'agent-b');
    assert.deepEqual(s.requests[1].messages.slice(1), [
      { role: 'user', content: 'First, with the email' },
      { role: 'assistant', content: 'Answer 1' },
      { role: 'user', content: 'And then?' }
    ]);

    cfg.history = false;
    await adapter.runTurn(openaiTurn(conversation, 'Stateful server').turn);
    assert.deepEqual(s.requests[2].messages.slice(1), [{ role: 'user', content: 'Stateful server' }], 'history off: only the new message');
  } finally {
    s.server.close();
  }
});

test('openai: a turn cut off after the server took it stays in the history, marked as cut off', async () => {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      requests.push(JSON.parse(body));
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (requests.length === 1) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Half an answer' } }] })}\n\n`);
        return setTimeout(() => res.socket.destroy(), 50);
      }
      res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const adapter = new OpenAiAdapter({ id: 'cx_ffffffffff', config: () => ({ url: `http://127.0.0.1:${server.address().port}`, history: true }) });
    const conversation = { id: 'c_cut', provider: {}, items: [] };
    const first = openaiTurn(conversation, 'The email and the question');
    const r = await adapter.runTurn(first.turn);
    assert.equal(r.status, 'error');
    await adapter.runTurn(openaiTurn(conversation, 'Please continue').turn);
    assert.deepEqual(requests[1].messages.slice(1), [
      { role: 'user', content: 'The email and the question' },
      { role: 'assistant', content: 'Half an answer\n\n[This answer was cut off here.]' },
      { role: 'user', content: 'Please continue' }
    ]);
  } finally {
    server.close();
  }
});

test('openai: a server without a key, one without the endpoint, and a history that keeps to its size', async () => {
  const s = await openaiServer();
  try {
    const adapter = new OpenAiAdapter({ id: 'cx_dddddddddd', config: () => ({ url: s.url, key: '' }) });
    assert.equal((await adapter.status({ force: true })).state, 'ready');
    const r = await adapter.runTurn(openaiTurn({ id: 'c', provider: {}, items: [] }, 'hi').turn);
    assert.equal(r.status, 'done');
  } finally {
    s.server.close();
  }
  const none = new OpenAiAdapter({ id: 'cx_eeeeeeeeee', config: () => ({ url: '' }) });
  assert.equal((await none.status()).state, 'unconfigured');
  assert.equal((await none.runTurn(openaiTurn({ id: 'c', provider: {}, items: [] }, 'hi').turn)).error.code, 'not-configured');

  const big = 'x'.repeat(HISTORY_MAX / 4);
  const list = [];
  for (let i = 0; i < 6; i++) list.push({ role: 'user', content: big }, { role: 'assistant', content: `a${i}` });
  const kept = trimHistory(list);
  assert.ok(kept.reduce((n, m) => n + m.content.length, 0) <= HISTORY_MAX);
  assert.equal(kept[0].role, 'user', 'a user message and its answer go together');
  assert.equal(kept.at(-1).content, 'a5', 'the newest turns stay');
});
