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
// - 'kept': the person typed, attached an email or file, has a file on its way, or picked the agent (agent menu,
//   Chat with). The agent stays for as long as the draft does, also when it stops taking messages or the default
//   changes in Settings: the panel then says so and the person chooses. A message only goes to the agent on screen.
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

// The config or the statuses changed: an untouched draft follows the rule, a kept one stays where it is.
export function followDraft(draft, rule) {
  if (draft.hold !== 'auto') return draft;
  const id = ruleAgent(rule);
  return id && id !== draft.agent ? { agent: id, hold: 'auto' } : draft;
}

// The draft has something in it (text, an attachment, a file on its way): it keeps the agent it shows.
export function keepDraft(draft) {
  return draft.hold === 'auto' ? { agent: draft.agent, hold: 'kept' } : draft;
}

// The person picked an agent for this draft.
export function pickDraft(draft, id) {
  return draft.agent === id && draft.hold === 'kept' ? draft : { agent: id, hold: 'kept' };
}

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
