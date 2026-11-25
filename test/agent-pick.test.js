'use strict';

// Which agent a new chat starts on (src/renderer/agent/pick.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// A browser module in a CommonJS package: Node takes it as ESM from a data: URL.
const pick = import(`data:text/javascript,${encodeURIComponent(fs.readFileSync(path.join(__dirname, '../src/renderer/agent/pick.js'), 'utf8'))}`);

const AGENTS = ['clark', 'claude', 'codex', 'openclaw', 'cx_aaaaaaaaaa', 'cx_bbbbbbbbbb'];
const statuses = (states) => Object.fromEntries(Object.entries(states).map(([id, state]) => [id, { state, detail: '' }]));

test('the default agent stands while it can take a message', async () => {
  const { startingAgent } = await pick;
  for (const state of ['ready', 'offline', 'starting', 'unknown']) {
    const status = statuses({ clark: state, claude: 'ready', codex: 'ready' });
    assert.equal(startingAgent({ defaultAgent: 'clark', agents: AGENTS, status }), 'clark', state);
  }
});

test('a blocked default gives way to the first ready agent: Claude Code, Codex, OpenClaw, custom agents, Hermes', async () => {
  const { startingAgent } = await pick;
  for (const state of ['unconfigured', 'disabled', 'missing', 'unauthorized']) {
    const status = statuses({ clark: state, claude: 'ready', codex: 'ready', openclaw: 'ready' });
    assert.equal(startingAgent({ defaultAgent: 'clark', agents: AGENTS, status }), 'claude', state);
  }
  const all = { clark: 'unconfigured', claude: 'missing', codex: 'ready', openclaw: 'ready', cx_aaaaaaaaaa: 'ready' };
  assert.equal(startingAgent({ defaultAgent: 'clark', agents: AGENTS, status: statuses(all) }), 'codex');
  assert.equal(startingAgent({ defaultAgent: 'clark', agents: AGENTS, status: statuses({ ...all, codex: 'offline' }) }), 'openclaw');
  assert.equal(startingAgent({ defaultAgent: 'clark', agents: AGENTS, status: statuses({ ...all, codex: 'offline', openclaw: 'unconfigured' }) }), 'cx_aaaaaaaaaa');
  // The custom agents come in their Settings order.
  const custom = statuses({ clark: 'unconfigured', claude: 'missing', codex: 'missing', openclaw: 'unconfigured', cx_aaaaaaaaaa: 'offline', cx_bbbbbbbbbb: 'ready' });
  assert.equal(startingAgent({ defaultAgent: 'clark', agents: AGENTS, status: custom }), 'cx_bbbbbbbbbb');
  // Hermes comes last, after every other agent.
  const hermes = statuses({ clark: 'ready', claude: 'missing', codex: 'ready', openclaw: 'ready', cx_aaaaaaaaaa: 'ready' });
  assert.equal(startingAgent({ defaultAgent: 'claude', agents: AGENTS, status: hermes }), 'codex');
  assert.equal(startingAgent({ defaultAgent: 'claude', agents: ['clark', 'claude'], status: hermes }), 'clark');
});

test('with nothing ready, or no statuses yet, the default stands', async () => {
  const { startingAgent } = await pick;
  const none = statuses({ clark: 'unconfigured', claude: 'missing', codex: 'offline', openclaw: 'unconfigured' });
  assert.equal(startingAgent({ defaultAgent: 'clark', agents: AGENTS, status: none }), 'clark');
  assert.equal(startingAgent({ defaultAgent: 'clark', agents: AGENTS, status: null }), 'clark');
  assert.equal(startingAgent({ defaultAgent: 'clark', agents: AGENTS, status: {} }), 'clark');
});

test('an agent that is not in the list is never picked', async () => {
  const { startingAgent } = await pick;
  const status = statuses({ clark: 'unconfigured', cx_cccccccccc: 'ready' });
  assert.equal(startingAgent({ defaultAgent: 'clark', agents: AGENTS, status }), 'clark');
});

test('readyAgents lists the alternatives in fallback order, without the agent on screen', async () => {
  const { readyAgents, fallbackOrder } = await pick;
  assert.deepEqual(fallbackOrder(AGENTS), ['claude', 'codex', 'openclaw', 'cx_aaaaaaaaaa', 'cx_bbbbbbbbbb', 'clark']);
  const status = statuses({ clark: 'unconfigured', claude: 'ready', codex: 'ready', openclaw: 'ready' });
  assert.deepEqual(readyAgents({ agents: AGENTS, status, except: 'clark', limit: 2 }), ['claude', 'codex']);
  assert.deepEqual(readyAgents({ agents: AGENTS, status, except: 'claude', limit: 2 }), ['codex', 'openclaw']);
  assert.deepEqual(readyAgents({ agents: AGENTS, status: null, except: 'clark' }), []);
});
