// The config of the reference runner (integrations/agent-runner) for an agent in team chat: what the Agents dialog
// shows with Copy after Add an agent and New key. Pure: no DOM and no window.mail, so the node tests can load it
// (test/chat-agents.test.js). The format is the runner's (its README, and server/WORKSPACES.md "Agents").
//
// On desktop the dialog also offers "Use one of my agents": an agent of Settings, Agents (src/main/agents/config.js,
// as agentConfig answers it: never a key) becomes the runner's backend. A backend that needs a secret names an
// environment variable for it (keyEnv); the secret itself never goes into the config.

// What the runner reads of a conversation for each mention, unless the config says otherwise.
export const RUNNER_CONTEXT = Object.freeze({ threadMessages: 50, channelMessages: 20, maxChars: 30000 });

// The backend of a config made without one of the person's agents: a command to replace with their own.
export const PLACEHOLDER_BACKEND = Object.freeze({ type: 'command', command: 'my-agent' });

// The environment variables the configs name for a backend's secret.
export const KEY_ENV = Object.freeze({ hermes: 'HERMES_API_KEY', openclaw: 'OPENCLAW_GATEWAY_TOKEN', custom: 'AGENT_API_KEY' });

const text = (v) => (typeof v === 'string' ? v.trim() : '');
const withModel = (backend, model) => (text(model) ? { ...backend, model: text(model) } : backend);

// A custom agent's variable: its name in capitals with _API_KEY ("Booper" gives BOOPER_API_KEY), or AGENT_API_KEY for a
// name without letters or digits.
export function customKeyEnv(name) {
  const base = text(name)
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  if (!base) return KEY_ENV.custom;
  return /^[0-9]/.test(base) ? `AGENT_${base}_API_KEY` : `${base}_API_KEY`;
}

// The person's agents that can be a runner's backend, from agentConfig: [{ id, name, kind, backend }]. kind is hermes,
// openclaw, claude, codex or custom. Only agents that are on, and those with a server only when it has an address.
// names: display names by id, as Settings shows them (the built-in agents' names come from the catalogs).
export function runnerAgents(config, names = {}) {
  const out = [];
  if (!config || typeof config !== 'object') return out;
  const on = (section) => Boolean(section) && section.enabled !== false;
  const label = (id, fallback) => text(names[id]) || fallback;
  const clark = config.clark;
  if (on(clark) && text(clark.url)) {
    out.push({
      id: 'clark',
      name: label('clark', text(clark.name) || 'Hermes'),
      kind: 'hermes',
      backend: withModel({ type: 'runs', url: text(clark.url), ...(clark.hasKey ? { keyEnv: KEY_ENV.hermes } : {}) }, clark.model)
    });
  }
  const oc = config.openclaw;
  if (on(oc) && text(oc.url)) {
    // OpenClaw's gateway speaks Chat Completions; its model names an OpenClaw agent, the gateway's default one unless
    // Settings picked another. A backend model of Settings goes in the x-openclaw-model header, as Rukoo sends it.
    const headers = text(oc.model) ? { headers: { 'x-openclaw-model': text(oc.model) } } : {};
    out.push({
      id: 'openclaw',
      name: label('openclaw', 'OpenClaw'),
      kind: 'openclaw',
      backend: { type: 'openai', url: text(oc.url), ...(oc.hasKey ? { keyEnv: KEY_ENV.openclaw } : {}), model: `openclaw/${text(oc.agent) || 'default'}`, ...headers }
    });
  }
  for (const [id, kind, fallback] of [
    ['claude', 'claude', 'Claude Code'],
    ['codex', 'codex', 'Codex']
  ]) {
    const section = config[id];
    if (!on(section)) continue;
    const exe = text(section.exe);
    // Claude Code's configDir is the account it runs as (CLAUDE_CONFIG_DIR), when Settings names one.
    const configDir = kind === 'claude' ? text(section.configDir) : '';
    out.push({ id, name: label(id, fallback), kind, backend: withModel({ type: kind, ...(exe ? { exe } : {}), ...(configDir ? { configDir } : {}) }, section.model) });
  }
  for (const c of Array.isArray(config.custom) ? config.custom : []) {
    if (!c || !on(c) || !text(c.url) || !['runs', 'openai'].includes(c.protocol)) continue;
    const name = text(c.name) || 'Agent';
    out.push({
      id: String(c.id || ''),
      name: label(c.id, name),
      kind: 'custom',
      backend: withModel({ type: c.protocol, url: text(c.url), ...(c.hasKey ? { keyEnv: customKeyEnv(name) } : {}) }, c.model)
    });
  }
  return out;
}

// The runner's config for one agent account: the server, the workspace, the agent's key, the backend and the
// context it reads. instructions stays empty for the person to fill in.
export function runnerConfig({ server, workspace, key, backend = PLACEHOLDER_BACKEND }) {
  return {
    server: String(server || '').replace(/\/+$/, ''),
    workspace: String(workspace || ''),
    key: String(key || ''),
    backend: { ...backend },
    context: { ...RUNNER_CONTEXT },
    instructions: ''
  };
}

// The config as the file the runner reads, two spaces deep.
export const runnerText = (config) => `${JSON.stringify(config, null, 2)}\n`;

// The environment variables a config's backend needs before the runner starts, for the line under it.
export const runnerEnv = (config) => (config && config.backend && config.backend.keyEnv ? [config.backend.keyEnv] : []);

// How to start the runner with the config saved as agent.json.
export const RUNNER_COMMAND = 'node integrations/agent-runner/runner.js --config agent.json';
