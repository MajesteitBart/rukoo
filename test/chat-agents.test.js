'use strict';

// The reference runner's config as the Agents dialog writes it (src/renderer/chat-agents.js): the workspace, the
// agent's key and a backend, either a placeholder command or one of the person's agents from Settings, Agents. The
// config never holds that agent's own key: it names an environment variable instead.

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
