// Which agent a new chat starts on. The chat panel (panel.js) asks this when the agents' statuses come in, so a
// fresh profile whose default (Hermes) isn't set up starts on Claude Code or Codex when one of them is ready, instead
// of on a disabled input. The stored default in Settings stays as it is. No imports: test/agent-pick.test.js loads
// this file on its own.

// Until these are fixed in Settings the agent cannot take a message. An agent that is offline can come back by
// itself, so it isn't blocked.
export const BLOCKED = new Set(['unconfigured', 'disabled', 'missing', 'unauthorized']);

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
