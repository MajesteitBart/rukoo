'use strict';

// The agent of the chat being written and how it holds it (startDraft, followDraft, keepDraft, pickDraft in
// src/renderer/agent/pick.js), what Send goes to (sendTarget), and what Set up focuses in Settings (setupTarget).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// A browser module in a CommonJS package: Node takes it as ESM from a data: URL.
const pick = import(`data:text/javascript,${encodeURIComponent(fs.readFileSync(path.join(__dirname, '../src/renderer/agent/pick.js'), 'utf8'))}`);

const AGENTS = ['clark', 'claude', 'codex', 'openclaw', 'cx_aaaaaaaaaa'];
const statuses = (states) => Object.fromEntries(Object.entries(states).map(([id, state]) => [id, { state, detail: '' }]));
const rule = (states, defaultAgent = 'clark', agents = AGENTS) => ({ defaultAgent, agents, status: statuses(states) });

test('a fresh draft starts on the rule, or stays where it was while the config is not in', async () => {
  const { startDraft } = await pick;
  assert.deepEqual(startDraft(rule({ clark: 'unconfigured', claude: 'ready' }), 'clark'), { agent: 'claude', hold: 'auto' });
  assert.deepEqual(startDraft(rule({ clark: 'ready', claude: 'ready' }), 'codex'), { agent: 'clark', hold: 'auto' });
  assert.deepEqual(startDraft(null, 'clark'), { agent: 'clark', hold: 'auto' });
  // A default the agent list doesn't have (a config being changed): the draft stays where it was.
  assert.deepEqual(startDraft(rule({}, 'cx_zzzzzzzzzz'), 'codex'), { agent: 'codex', hold: 'auto' });
});

test('an untouched draft follows the statuses and a new default', async () => {
  const { startDraft, followDraft } = await pick;
  let d = startDraft(rule({}), 'clark');
  assert.deepEqual(d, { agent: 'clark', hold: 'auto' });
  // The statuses come in: Hermes isn't set up, Claude Code is ready.
  d = followDraft(d, rule({ clark: 'unconfigured', claude: 'ready', codex: 'ready' }));
  assert.deepEqual(d, { agent: 'claude', hold: 'auto' });
  // Claude Code goes missing: the untouched draft moves on to Codex.
  d = followDraft(d, rule({ clark: 'unconfigured', claude: 'missing', codex: 'ready' }));
  assert.deepEqual(d, { agent: 'codex', hold: 'auto' });
  // A new default in Settings.
  d = followDraft(d, rule({ clark: 'unconfigured', claude: 'missing', codex: 'ready', openclaw: 'ready' }, 'openclaw'));
  assert.deepEqual(d, { agent: 'openclaw', hold: 'auto' });
  // Nothing to go by: it stays.
  assert.equal(followDraft(d, null), d);
});

test('a draft with something in it keeps its agent when it becomes blocked or the default changes', async () => {
  const { startDraft, followDraft, keepDraft } = await pick;
  let d = startDraft(rule({ clark: 'unconfigured', claude: 'ready', codex: 'ready' }), 'clark');
  assert.equal(d.agent, 'claude');
  d = keepDraft(d);
  assert.deepEqual(d, { agent: 'claude', hold: 'kept' });
  // Writing more changes nothing.
  assert.equal(keepDraft(d), d);
  // Claude Code goes missing while Codex is ready: the draft stays on Claude Code; the panel shows it blocked.
  assert.equal(followDraft(d, rule({ clark: 'unconfigured', claude: 'missing', codex: 'ready' })), d);
  // A new default in Settings doesn't move it either.
  assert.equal(followDraft(d, rule({ claude: 'ready', codex: 'ready' }, 'codex')), d);
  // Nor does the agent being removed: the panel says it is gone and the person chooses.
  assert.equal(followDraft(d, rule({ codex: 'ready' }, 'clark', ['clark', 'codex'])), d);
});

// A paste, a drop, an undo or text set by code fires no input event, so a draft that got its text that way was still
// 'auto' when a status update came in, and moved to Codex. The status update now reads what the input holds.
test('a draft that holds anything is kept by the status update itself, whatever put it there', async () => {
  const { startDraft, followDraft } = await pick;
  const ready = rule({ clark: 'unconfigured', claude: 'ready', codex: 'ready' });
  const missing = rule({ clark: 'unconfigured', claude: 'missing', codex: 'ready' });
  // Pasted into an untouched Claude draft: still 'auto', since no edit told the panel.
  const pasted = startDraft(ready, 'clark');
  assert.deepEqual(pasted, { agent: 'claude', hold: 'auto' });
  // Claude Code goes missing. The panel passes what the input holds: kept on Claude, not moved to Codex.
  assert.deepEqual(followDraft(pasted, missing, true), { agent: 'claude', hold: 'kept' });
  // With nothing in it, the same update moves it.
  assert.deepEqual(followDraft(pasted, missing, false), { agent: 'codex', hold: 'auto' });
  // A new default with something in the input: kept too.
  assert.deepEqual(followDraft(pasted, rule({ claude: 'ready', codex: 'ready' }, 'codex'), true), { agent: 'claude', hold: 'kept' });
});

test('a draft the person emptied again stays on its agent; only a fresh draft follows the rule', async () => {
  const { startDraft, followDraft } = await pick;
  const ready = rule({ clark: 'unconfigured', claude: 'ready', codex: 'ready' });
  const missing = rule({ clark: 'unconfigured', claude: 'missing', codex: 'ready' });
  // Written in, then emptied: the input holds nothing now, and the draft stays on Claude Code.
  const d = followDraft(startDraft(ready, 'clark'), ready, true);
  assert.equal(followDraft(d, missing, false), d);
  assert.equal(followDraft(d, rule({ claude: 'ready', codex: 'ready' }, 'codex'), false), d);
  // Send or New chat: the next draft starts on the rule.
  assert.deepEqual(startDraft(missing, d.agent), { agent: 'codex', hold: 'auto' });
});

test('a pick keeps its agent across config and status responses, and a fresh draft starts on the rule again', async () => {
  const { startDraft, followDraft, pickDraft } = await pick;
  const blocked = rule({ clark: 'unconfigured', claude: 'ready', codex: 'ready' });
  // Picked before the config was in: the first config doesn't take it back.
  let d = pickDraft(startDraft(null, 'clark'), 'codex');
  assert.deepEqual(d, { agent: 'codex', hold: 'kept' });
  d = followDraft(d, blocked);
  assert.deepEqual(d, { agent: 'codex', hold: 'kept' });
  // Status responses and a new default keep it.
  d = followDraft(d, rule({ clark: 'unconfigured', claude: 'ready', codex: 'offline' }));
  d = followDraft(d, rule({ claude: 'ready', codex: 'ready' }, 'claude'));
  assert.deepEqual(d, { agent: 'codex', hold: 'kept' });
  // A blocked agent can be picked; it stays, and the panel offers the way out.
  assert.deepEqual(pickDraft(d, 'clark'), { agent: 'clark', hold: 'kept' });
  // Sent, or New chat: the next draft starts on the rule, not on the pick.
  assert.deepEqual(startDraft(blocked, d.agent), { agent: 'claude', hold: 'auto' });
});

// In an open Codex chat, choosing the checked Codex row pinned the next new draft to Codex.
test('choosing the agent an open chat already has changes nothing; another agent is a pick for a new chat', async () => {
  const { startDraft, pickDraft } = await pick;
  const d = startDraft(rule({ clark: 'ready' }), 'clark');
  assert.equal(pickDraft(d, 'codex', 'codex'), d);
  assert.deepEqual(d, { agent: 'clark', hold: 'auto' });
  // Another agent than the open chat's: a new chat with that one, kept.
  assert.deepEqual(pickDraft(d, 'claude', 'codex'), { agent: 'claude', hold: 'kept' });
  // Without an open chat, picking the draft's own agent is still a pick: it holds.
  assert.deepEqual(pickDraft(d, 'clark'), { agent: 'clark', hold: 'kept' });
});

test('Send takes the agent the input shows, with its chat, or nothing when they disagree', async () => {
  const { sendTarget } = await pick;
  const draft = { agent: 'claude', hold: 'kept' };
  assert.deepEqual(sendTarget({ shown: 'claude', draft }), { agent: 'claude', conv: null });
  // A chat on screen: its own agent and id.
  assert.deepEqual(sendTarget({ shown: 'codex', conv: { id: 'c1', agent: 'codex' }, draft }), { agent: 'codex', conv: 'c1' });
  // The draft moved but the input still shows the agent before: nothing goes.
  assert.equal(sendTarget({ shown: 'claude', draft: { ...draft, agent: 'codex' } }), null);
  assert.equal(sendTarget({ shown: 'claude', conv: { id: 'c1', agent: 'codex' }, draft }), null);
  assert.equal(sendTarget({ shown: null, draft }), null);
});

test('Set up focuses the control for the state the agent is in', async () => {
  const { setupTarget } = await pick;
  const full = { url: { empty: false }, exe: { empty: true } };
  // Turned off: the Use switch, whatever else is missing.
  assert.equal(setupTarget({ state: 'disabled', enabled: false, fields: { url: { empty: true } } }), 'enabled');
  assert.equal(setupTarget({ state: 'unconfigured', enabled: false, fields: { url: { empty: true } } }), 'enabled');
  // A saved key the server refused: Replace, also when the address is filled in and another field is empty.
  assert.equal(setupTarget({ state: 'unauthorized', fields: { ...full, replace: true } }), 'replace');
  // Refused with no key saved: its field.
  assert.equal(setupTarget({ state: 'unauthorized', fields: { url: { empty: false }, key: { empty: true } } }), 'key');
  // Not installed: the program path, filled in or not.
  assert.equal(setupTarget({ state: 'missing', fields: { exe: { empty: false } } }), 'exe');
  // Not set up: the first empty field.
  assert.equal(setupTarget({ state: 'unconfigured', fields: { url: { empty: true }, key: { empty: true } } }), 'url');
  assert.equal(setupTarget({ state: 'unconfigured', fields: { url: { empty: false }, key: { empty: true } } }), 'key');
  assert.equal(setupTarget({ state: 'unconfigured', fields: { url: { empty: false }, replace: true } }), 'url');
  // Nothing on the card to type in.
  assert.equal(setupTarget({ state: 'unconfigured', fields: {} }), null);
});
