'use strict';

// The reference runner's config as the key step writes it (src/renderer/chat-agents.js): the workspace, the agent's
// key and a backend from "Answers with", and the line that says whether an agent's runner connected. The config never
// holds the key of one of the person's own agents: it names an environment variable instead.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// A browser module in a CommonJS package, loaded from a data: URL as test/chat-model.test.js does.
function moduleUrl(file) {
  const source = fs
    .readFileSync(path.join(__dirname, '../src/renderer', file), 'utf8')
    .replace(/from '\.\/([\w-]+\.js)'/g, (_, dep) => `from '${moduleUrl(dep)}'`);
  return `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
}
const loading = import(moduleUrl('chat-agents.js'));

const W = 'w_AbCdEfGhIjKlMnOpQrStUv';
const KEY = `rka_${'a'.repeat(22)}.${'b'.repeat(43)}`;

// agentConfig as main answers it (src/main/agents/config.js publicView): hasKey in place of every key.
const config = {
  clark: { enabled: true, name: 'Hermes', url: 'https://hermes.example/', hasKey: true, model: 'hermes-4' },
  claude: { enabled: true, exe: '', configDir: '', model: 'opus', access: 'ask' },
  codex: { enabled: false, exe: '', model: '', access: 'ask' },
  openclaw: { enabled: true, url: 'http://127.0.0.1:18789', hasKey: true, agent: 'ops', model: 'gpt-5', remote: false },
  custom: [
    { id: 'cx_abcdefghij', protocol: 'runs', preset: 'booper', name: 'Booper', enabled: true, url: 'http://127.0.0.1:8662', hasKey: true, model: '' },
    { id: 'cx_klmnopqrst', protocol: 'openai', preset: 'openai', name: 'Ünïcode bot 2', enabled: true, url: 'http://127.0.0.1:8000', hasKey: false, model: 'local' },
    { id: 'cx_uvwxyzabcd', protocol: 'openai', preset: 'openai', name: 'No address', enabled: true, url: '', hasKey: false, model: '' },
    { id: 'cx_offoffoffo', protocol: 'runs', preset: 'runs', name: 'Off', enabled: false, url: 'http://x', hasKey: true, model: '' }
  ]
};

test("the config names the server, the workspace and the agent's key, with the runner's context and a placeholder backend", async () => {
  const { runnerConfig, runnerText, runnerEnv, RUNNER_CONTEXT, PLACEHOLDER_BACKEND } = await loading;
  const cfg = runnerConfig({ server: 'https://rukoo.io/', workspace: W, key: KEY });
  assert.deepEqual(cfg, {
    server: 'https://rukoo.io',
    workspace: W,
    key: KEY,
    backend: { type: 'command', command: 'my-agent' },
    context: { threadMessages: 50, channelMessages: 20, maxChars: 30000 },
    instructions: ''
  });
  assert.deepEqual(RUNNER_CONTEXT, cfg.context);
  assert.deepEqual(PLACEHOLDER_BACKEND, cfg.backend);
  // The file is JSON two spaces deep, as the runner reads it, ending in a new line.
  const text = runnerText(cfg);
  assert.deepEqual(JSON.parse(text), cfg);
  assert.ok(text.endsWith('}\n'));
  assert.match(text, /\n  "backend": \{\n    "type": "command"/);
  assert.deepEqual(runnerEnv(cfg), []);
  // A backend of the caller's is copied, so the config can't change it.
  const backend = { type: 'claude' };
  runnerConfig({ server: 'x', workspace: W, key: KEY, backend }).backend.model = 'changed';
  assert.deepEqual(backend, { type: 'claude' });
});

test("the person's agents become backends with an environment variable for their own key, never the key", async () => {
  const { runnerAgents, runnerConfig, runnerEnv } = await loading;
  const list = runnerAgents(config);
  assert.deepEqual(
    list.map((a) => [a.id, a.name, a.kind]),
    [
      ['clark', 'Hermes', 'hermes'],
      ['openclaw', 'OpenClaw', 'openclaw'],
      ['claude', 'Claude Code', 'claude'],
      ['cx_abcdefghij', 'Booper', 'custom'],
      ['cx_klmnopqrst', 'Ünïcode bot 2', 'custom']
    ],
    'Codex is off, and custom agents without an address or turned off are left out'
  );
  const by = Object.fromEntries(list.map((a) => [a.id, a.backend]));
  assert.deepEqual(by.clark, { type: 'runs', url: 'https://hermes.example/', keyEnv: 'HERMES_API_KEY', model: 'hermes-4' });
  // Its backend model goes in the header Rukoo sends it in.
  assert.deepEqual(by.openclaw, { type: 'openai', url: 'http://127.0.0.1:18789', keyEnv: 'OPENCLAW_GATEWAY_TOKEN', model: 'openclaw/ops', headers: { 'x-openclaw-model': 'gpt-5' } });
  assert.deepEqual(by.claude, { type: 'claude', model: 'opus' });
  assert.deepEqual(by.cx_abcdefghij, { type: 'runs', url: 'http://127.0.0.1:8662', keyEnv: 'BOOPER_API_KEY' });
  assert.deepEqual(by.cx_klmnopqrst, { type: 'openai', url: 'http://127.0.0.1:8000', model: 'local' }, 'a server without a key needs no variable');
  assert.deepEqual(runnerEnv(runnerConfig({ server: 'x', workspace: W, key: KEY, backend: by.clark })), ['HERMES_API_KEY']);
  // Nothing in the configs is a secret of the person's agents: publicView has none, and none is made up.
  for (const a of list) assert.ok(!JSON.stringify(a.backend).includes('hasKey'), a.id);
});

test('the backends follow what Settings, Agents has: a program path, the default OpenClaw agent, names', async () => {
  const { runnerAgents, customKeyEnv } = await loading;
  const list = runnerAgents({
    clark: { enabled: true, url: '', hasKey: true },
    claude: { enabled: true, exe: 'C:\\Program Files\\Claude\\claude.exe', configDir: 'D:\\claude-work', model: '' },
    codex: { enabled: true, exe: '/usr/local/bin/codex', model: 'gpt-5.5' },
    openclaw: { enabled: true, url: 'http://127.0.0.1:18789', hasKey: false, agent: '' }
  }, { codex: 'Codex CLI' });
  assert.deepEqual(list.map((a) => a.id), ['openclaw', 'claude', 'codex'], 'Hermes without an address is left out');
  assert.deepEqual(list[0].backend, { type: 'openai', url: 'http://127.0.0.1:18789', model: 'openclaw/default' });
  assert.deepEqual(list[1].backend, { type: 'claude', exe: 'C:\\Program Files\\Claude\\claude.exe', configDir: 'D:\\claude-work' });
  assert.deepEqual(list[2].backend, { type: 'codex', exe: '/usr/local/bin/codex', model: 'gpt-5.5' });
  assert.equal(list[2].name, 'Codex CLI');
  assert.deepEqual(runnerAgents(null), []);
  assert.deepEqual(runnerAgents({}), []);
  assert.equal(customKeyEnv('Booper'), 'BOOPER_API_KEY');
  assert.equal(customKeyEnv('  my-agent v2 '), 'MY_AGENT_V2_API_KEY');
  assert.equal(customKeyEnv('Ünïcode'), 'UNICODE_API_KEY');
  assert.equal(customKeyEnv('42 bot'), 'AGENT_42_BOT_API_KEY');
  assert.equal(customKeyEnv('🙂'), 'AGENT_API_KEY');
  assert.equal(customKeyEnv(''), 'AGENT_API_KEY');
});

// The key step's "Answers with" (chat-dialogs.js showAgentKey): what it offers and which one it starts on.
test('Answers with offers the agents a status check passed first, the default agent first among them, and leaves out those that cannot answer', async () => {
  const { runnerChoices } = await loading;
  const ids = (list) => list.map((a) => a.id);
  // Without a status yet: Settings' order, the default agent first.
  assert.deepEqual(ids(runnerChoices(config)), ['clark', 'openclaw', 'claude', 'cx_abcdefghij', 'cx_klmnopqrst']);
  assert.deepEqual(ids(runnerChoices({ ...config, defaultAgent: 'claude' })), ['claude', 'clark', 'openclaw', 'cx_abcdefghij', 'cx_klmnopqrst']);
  // Hermes is offline, OpenClaw was never set up, Claude Code is ready, Booper's key is refused, the other custom
  // agent's program isn't there: the ready one comes first, the ones that can't answer go.
  const status = {
    clark: { state: 'offline' },
    openclaw: { state: 'unconfigured' },
    claude: { state: 'ready' },
    codex: { state: 'disabled' },
    cx_abcdefghij: { state: 'unauthorized' },
    cx_klmnopqrst: { state: 'missing' }
  };
  const list = runnerChoices({ ...config, defaultAgent: 'clark' }, { status });
  assert.deepEqual(ids(list), ['claude', 'clark', 'cx_abcdefghij']);
  assert.deepEqual(list.map((a) => a.ready), [true, false, false]);
  // Two ready: the default agent first, then Settings' order.
  const both = runnerChoices({ ...config, defaultAgent: 'cx_abcdefghij' }, { status: { ...status, cx_abcdefghij: { state: 'ready' }, clark: { state: 'ready' } } });
  assert.deepEqual(ids(both), ['cx_abcdefghij', 'clark', 'claude']);
  // An agent the status doesn't name, or names with a state this version doesn't know, stays and isn't ready.
  assert.deepEqual(runnerChoices(config, { status: { claude: { state: 'starting' } } }).find((a) => a.id === 'claude').ready, false);
});

test('without Settings, as in the browser and on the phone, Answers with offers Claude Code and Codex, which need no settings', async () => {
  const { runnerChoices, PLAIN_AGENTS, OWN_PROGRAM } = await loading;
  const list = runnerChoices(null);
  assert.deepEqual(
    list.map((a) => [a.id, a.name, a.backend]),
    [
      ['claude', 'Claude Code', { type: 'claude' }],
      ['codex', 'Codex', { type: 'codex' }]
    ]
  );
  // A copy: changing it leaves the next choice as it was.
  list[0].backend.model = 'changed';
  assert.deepEqual(PLAIN_AGENTS[0].backend, { type: 'claude' });
  assert.ok(!list.some((a) => a.id === OWN_PROGRAM), 'A program of my own is the dialog\'s last choice, outside the list');
});

test('the runner starts from its own folder with Node.js, and its README says where to get it', async () => {
  const { RUNNER_COMMAND, RUNNER_URL } = await loading;
  assert.equal(RUNNER_COMMAND, 'node runner.js --config agent.json');
  assert.equal(RUNNER_URL, 'https://github.com/MajesteitBart/rukoo/blob/main/integrations/agent-runner/README.md#get-the-runner');
  // The README has that section, with the four files runner.js loads.
  const readme = fs.readFileSync(path.join(__dirname, '../integrations/agent-runner/README.md'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(readme, /^## Get the runner$/m);
  const runner = fs.readFileSync(path.join(__dirname, '../integrations/agent-runner/runner.js'), 'utf8');
  const siblings = [...runner.matchAll(/require\('\.\/(\w+)'\)/g)].map((m) => `${m[1]}.js`);
  assert.deepEqual(siblings.sort(), ['backends.js', 'prompt.js', 'rukoo.js']);
  const section = readme.split(/^## Get the runner$/m)[1].split(/^## /m)[0];
  for (const file of ['runner.js', ...siblings]) assert.ok(section.includes(file), `"Get the runner" names ${file}`);
  assert.match(section, /Node\.js\]\(https:\/\/nodejs\.org\) 22 or newer/);
});

test("an agent's line says whether its runner ever connected, and how long ago it last did", async () => {
  const { agentSeenText } = await loading;
  const t = (key, values = {}) => (key === 'chat.agents.neverActive' ? 'Not connected yet' : `Last active ${values.date}`);
  const now = Date.UTC(2026, 10, 24, 15, 0, 0);
  const at = (ms) => agentSeenText(now - ms, { t, locale: 'en', now });
  assert.equal(agentSeenText(undefined, { t, locale: 'en', now }), '', 'unknown, as for a guest: nothing');
  assert.equal(agentSeenText(null, { t, locale: 'en', now }), 'Not connected yet');
  assert.equal(at(10 * 1000), 'Last active 1 minute ago');
  assert.equal(at(5 * 60000), 'Last active 5 minutes ago');
  assert.equal(at(3 * 3600000), 'Last active 3 hours ago');
  assert.equal(at(30 * 3600000), 'Last active yesterday');
  assert.equal(at(10 * 86400000), 'Last active Nov 14');
  assert.equal(agentSeenText(Date.UTC(2025, 10, 1, 12), { t, locale: 'en', now }), 'Last active Nov 1, 2025');
  assert.equal(agentSeenText(now - 5 * 60000, { t, locale: 'nl', now }), 'Last active 5 minuten geleden');
});

test('an agent this computer runs says what it does here in one line, with a tone for its dot, and in plain words for the codes the runner reports', async () => {
  const { runStateText } = await loading;
  const t = (key, v = {}) => `${key}${Object.keys(v).length ? ` ${JSON.stringify(v)}` : ''}`;
  const now = Date.UTC(2026, 10, 24, 15, 0, 0);
  const line = (run) => runStateText({ phase: 'running', problem: null, unreachable: null, failure: null, channels: 2, answeredAt: null, ...run }, { t, use: 'Claude Code', locale: 'en', now });
  assert.equal(runStateText(null, { t }), null);
  assert.deepEqual(line({ phase: 'starting' }), { text: 'chat.agents.run.starting', tone: 'busy' });
  // A runner that can't reach the server while it starts says so, and doesn't look as if it were about to run.
  assert.deepEqual(line({ phase: 'starting', unreachable: { code: 'offline', status: null, at: now } }), { text: 'chat.agents.run.startingOffline', tone: 'warn' });
  assert.deepEqual(line({}), { text: 'chat.agents.run.running', tone: 'ok' });
  // After the computer woke, the last status is stale until a fresh pass.
  assert.deepEqual(line({ stale: true }), { text: 'chat.agents.run.stale', tone: 'busy' });
  assert.deepEqual(line({ channels: 0 }), { text: 'chat.agents.run.noChannel', tone: 'warn' });
  assert.deepEqual(line({ unreachable: { code: 'offline', status: null, at: now } }), { text: 'chat.agents.run.offline', tone: 'warn' });
  // A failure is said by its code in the catalogs' words, never in the runner's.
  assert.deepEqual(line({ failure: { code: 'http', status: 500, at: now } }), { text: 'chat.agents.run.failedHttp {"use":"Claude Code","status":500}', tone: 'warn' });
  assert.deepEqual(line({ failure: { code: 'http', status: null, at: now } }), { text: 'chat.agents.run.failed {"use":"Claude Code"}', tone: 'warn' });
  assert.deepEqual(line({ failure: { code: 'timeout', at: now } }), { text: 'chat.agents.run.failedTimeout {"use":"Claude Code"}', tone: 'warn' });
  assert.deepEqual(line({ failure: { code: 'exit', at: now } }), { text: 'chat.agents.run.failedExit {"use":"Claude Code"}', tone: 'warn' });
  assert.deepEqual(line({ failure: { code: 'empty', at: now } }), { text: 'chat.agents.run.failedEmpty {"use":"Claude Code"}', tone: 'warn' });
  assert.deepEqual(line({ failure: { code: 'offline', at: now } }), { text: 'chat.agents.run.failedOffline {"use":"Claude Code"}', tone: 'warn' });
  assert.deepEqual(line({ failure: { code: 'missing', at: now } }), { text: 'chat.agents.run.missing {"use":"Claude Code"}', tone: 'error' });
  assert.deepEqual(line({ failure: { code: 'other', message: 'never shown', at: now } }), { text: 'chat.agents.run.failed {"use":"Claude Code"}', tone: 'warn' });
  // An answer after the failure clears it.
  assert.deepEqual(line({ failure: { code: 'http', status: 500, at: now - 10 }, answeredAt: now }), { text: 'chat.agents.run.running', tone: 'ok' });
  // The runner's check codes (backends.js) in the catalogs' words; another problem gets the general line.
  assert.deepEqual(line({ problem: { code: 'missing' } }), { text: 'chat.agents.run.missing {"use":"Claude Code"}', tone: 'error' });
  assert.deepEqual(line({ problem: { code: 'unreachable' } }), { text: 'chat.agents.run.unreachable {"use":"Claude Code"}', tone: 'error' });
  assert.deepEqual(line({ problem: { code: 'backend_key' } }), { text: 'chat.agents.run.backendKey {"use":"Claude Code"}', tone: 'error' });
  assert.deepEqual(line({ problem: { code: 'other', message: 'Something new' } }), { text: 'chat.agents.run.problem {"use":"Claude Code"}', tone: 'error' });
  // What it answers with changed in Settings, or went: it runs again only once someone runs it again.
  assert.deepEqual(line({ phase: 'changed' }), { text: 'chat.agents.run.changed {"use":"Claude Code"}', tone: 'error' });
  assert.deepEqual(line({ phase: 'changed', gone: true }), { text: 'chat.agents.run.gone {"use":"Claude Code"}', tone: 'error' });
  assert.deepEqual(line({ phase: 'error', error: { code: 'missing' } }), { text: 'chat.agents.run.missing {"use":"Claude Code"}', tone: 'error' });
  assert.deepEqual(line({ phase: 'waiting', retryAt: now + 30000 }), { text: 'chat.agents.run.waiting {"time":"in 30 seconds"}', tone: 'warn' });
  assert.deepEqual(line({ phase: 'waiting', retryAt: now + 5 * 60000 }), { text: 'chat.agents.run.waiting {"time":"in 5 minutes"}', tone: 'warn' });
  assert.deepEqual(line({ phase: 'stopped' }), { text: 'chat.agents.run.stopped', tone: 'off' });
  assert.deepEqual(line({ phase: 'refused' }), { text: 'chat.agents.run.refused', tone: 'error' });
  assert.deepEqual(line({ phase: 'error', error: { code: 'unknown_backend' } }), { text: 'chat.agents.run.unknownUse', tone: 'error' });
  assert.deepEqual(line({ phase: 'error', error: { code: 'key_unreadable' } }), { text: 'chat.agents.run.keyUnreadable', tone: 'error' });
  assert.deepEqual(line({ phase: 'error', error: { code: 'spawn' } }), { text: 'chat.agents.run.cantStart', tone: 'error' });
  // Every key it uses is in the catalogs.
  const en = fs.readFileSync(path.join(__dirname, '../src/i18n/en.js'), 'utf8');
  for (const key of ['starting', 'startingOffline', 'running', 'stale', 'noChannel', 'offline', 'failed', 'failedHttp', 'failedTimeout', 'failedExit', 'failedEmpty', 'failedOffline', 'missing', 'unreachable', 'backendKey', 'problem', 'changed', 'gone', 'waiting', 'stopped', 'refused', 'unknownUse', 'keyUnreadable', 'cantStart']) {
    assert.ok(en.includes(`"chat.agents.run.${key}"`), key);
  }
});

test('starting here warns of a runner elsewhere only when the server saw the key lately, more than a minute after this computer last did', async () => {
  const { ranElsewhere, useName } = await loading;
  const now = Date.UTC(2026, 10, 24, 15, 0, 0);
  const min = 60000;
  const stopped = { stoppedAt: now - 5 * min, passAt: null, connectedAt: null };
  assert.equal(ranElsewhere(null, stopped, now), false, 'never seen');
  assert.equal(ranElsewhere(now - 5 * min, stopped, now), false, 'this computer was the last');
  assert.equal(ranElsewhere(now - 4.5 * min, stopped, now), false, 'within the minute the server takes to write lastSeen');
  assert.equal(ranElsewhere(now - 2 * min, stopped, now), true, 'used three minutes after it stopped here');
  assert.equal(ranElsewhere(now - 20 * min, { stoppedAt: now - 60 * min }, now), false, 'too long ago to be running now');
  assert.equal(ranElsewhere(now - 2 * min, { stoppedAt: null, passAt: now - 2.5 * min, connectedAt: now - 30 * min }, now), false, 'its last pass here');
  assert.equal(ranElsewhere(now - 2 * min, null, now), true);
  // The name of what it answers with, as Answers with shows it.
  assert.equal(useName(config, 'clark'), 'Hermes');
  assert.equal(useName(config, 'cx_abcdefghij'), 'Booper');
  assert.equal(useName(null, 'codex'), 'Codex');
  assert.equal(useName(null, 'cx_gonegonego'), 'cx_gonegonego');
});
