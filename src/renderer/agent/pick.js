// Which agent a new chat starts on. The chat panel (panel.js) asks this when the agents' statuses come in, so a
// fresh profile whose default (Hermes) isn't set up starts on Claude Code or Codex when one of them is ready, instead
// of on a disabled input. The stored default in Settings stays as it is. No imports: test/agent-pick.test.js loads
// this file on its own.

// Until these are fixed in Settings the agent cannot take a message. An agent that is offline can come back by
// itself, so it isn't blocked. 'removed' is the panel's own state for an agent that is no longer in Settings (a custom
// agent the user removed); main never reports it.
export const BLOCKED = new Set(['unconfigured', 'disabled', 'missing', 'unauthorized', 'removed']);

// The agents a new chat falls back on, first choice first: the local programs, OpenClaw, the user's own agents in
// their Settings order, and Hermes last, since it needs a server of its own.
const BUILT_IN = ['claude', 'codex', 'openclaw'];

const stateOf = (status, id) => (status && status[id] && typeof status[id].state === 'string' ? status[id].state : null);

// agents: every agent id the panel knows, in Settings order (Hermes, Claude Code, Codex, OpenClaw, custom agents).
export function fallbackOrder(agents) {
  const list = Array.isArray(agents) ? agents : [];
  return [...BUILT_IN.filter((id) => list.includes(id)), ...list.filter((id) => id !== 'clark' && !BUILT_IN.includes(id)), ...(list.includes('clark') ? ['clark'] : [])];
}

export const isBlocked = (status, id) => BLOCKED.has(stateOf(status, id));

// The ready agents other than `except`, in fallback order: what the setup card offers instead.
export function readyAgents({ agents, status, except = null, limit = Infinity } = {}) {
  return fallbackOrder(agents)
    .filter((id) => id !== except && stateOf(status, id) === 'ready')
    .slice(0, limit);
}

// The default agent, unless it is blocked; then the first ready agent; else the default after all. Without statuses
// (not in yet) the default stands.
export function startingAgent({ defaultAgent, agents, status } = {}) {
  if (!isBlocked(status, defaultAgent)) return defaultAgent;
  return readyAgents({ agents, status, except: defaultAgent, limit: 1 })[0] || defaultAgent;
}

// ---------- the draft's agent ----------

// The chat being written, before it is sent, has an agent and a hold on it ({agent, hold}):
// - 'auto': nothing typed, attached or picked yet. The rule above decides, and the agent may move as the config and
//   the statuses come in. Nobody has written anything for it, so moving it sends nothing anywhere.
// - 'kept': the input held something (text, an attached email or file, a file on its way), however it got there, or
//   the person picked the agent (agent menu, Chat with). The agent stays for as long as the draft does, also when the
//   person empties the input again, when the agent stops taking messages or when the default changes in Settings: the
//   panel then says so and the person chooses. A message only goes to the agent on screen.
// A draft ends when it is sent or New chat starts another; the next starts on the rule again (startDraft()).
//
// rule: {defaultAgent, agents, status} for startingAgent(), or null while the config isn't in.

const ruleAgent = (rule) => {
  if (!rule) return null;
  const id = startingAgent(rule);
  return Array.isArray(rule.agents) && rule.agents.includes(id) ? id : null;
};

// A fresh draft: the rule's agent, or `current` while the rule can't tell.
export function startDraft(rule, current) {
  return { agent: ruleAgent(rule) || current, hold: 'auto' };
}

// The draft has something in it (text, an attachment, a file on its way): it keeps the agent it shows.
export function keepDraft(draft) {
  return draft.hold === 'auto' ? { agent: draft.agent, hold: 'kept' } : draft;
}

// The config or the statuses changed: an untouched draft follows the rule, a kept one stays where it is. written:
// whether the input holds anything right now, as the panel reads it at this moment. The content decides, not the edit
// that put it there, so text from a paste, a drop, an undo or code keeps the draft like typed text does.
export function followDraft(draft, rule, written = false) {
  if (written) return keepDraft(draft);
  if (draft.hold !== 'auto') return draft;
  const id = ruleAgent(rule);
  return id && id !== draft.agent ? { agent: id, hold: 'auto' } : draft;
}

// The person picked an agent for this draft. In an open chat (convAgent), picking that chat's own agent changes
// nothing: it is the agent on screen already, and the next new draft still starts on the rule.
export function pickDraft(draft, id, convAgent = null) {
  if (convAgent && convAgent === id) return draft;
  return draft.agent === id && draft.hold === 'kept' ? draft : { agent: id, hold: 'kept' };
}

// ---------- sending ----------

// What Send goes to, taken once when it is pressed: the agent the input shows (shown), with the chat on screen (conv)
// or else the draft. Null when the two disagree: the panel then draws itself again and sends nothing, so the person
// sees the agent before anything goes. Creating the chat and the error's name use this value, not the panel as it is
// by the time main answers.
export function sendTarget({ shown, conv = null, draft }) {
  const agent = conv ? conv.agent : draft && draft.agent;
  if (!agent || shown !== agent) return null;
  return { agent, conv: conv ? conv.id : null };
}

// The longest message text main takes (AGENT_TEXT_MAX in main.js, which cuts anything longer; test/agent-draft.test.js
// checks they agree). The renderer has no way to load main's files, so the number is in both.
export const TEXT_MAX = 20000;
// How many characters text is over that, 0 when it fits: Send then sends nothing and keeps the input as it is.
export const overLimit = (text) => Math.max(0, String(text || '').length - TEXT_MAX);

// ---------- Set up ----------

// What Set up {name} puts the keyboard in on the agent's card in Settings, for the state the panel showed:
// 'enabled' (the Use switch of an agent that is turned off), 'replace' (Replace for a saved key the agent refused),
// 'key', 'exe', 'url', or null for nothing. fields: which controls the card has, as {url, key, exe: {empty}} for the
// fields and replace: true when a saved key shows Replace instead of its field.
export function setupTarget({ state, enabled = true, fields = {} } = {}) {
  if (enabled === false || state === 'disabled') return 'enabled';
  if (state === 'unauthorized') {
    if (fields.replace) return 'replace';
    if (fields.key) return 'key';
  }
  if (state === 'missing' && fields.exe) return 'exe';
  const order = ['url', 'key', 'exe'];
  return order.find((k) => fields[k] && fields[k].empty) || order.find((k) => fields[k]) || (fields.replace ? 'replace' : null);
}
