// The config of the reference runner (integrations/agent-runner) for an agent in team chat: what the key step shows
// with Copy config after Add an agent and New key, and the line under an agent that says whether its runner
// connected. Pure: no DOM and no window.mail, so the node tests can load it (test/chat-agents.test.js). The format is
// the runner's (its README, and server/WORKSPACES.md "Agents").
//
// The key step's "Answers with" picks the runner's backend: on desktop an agent of Settings, Agents
// (src/main/agents/config.js, as agentConfig answers it: never a key), in the browser Claude Code or Codex, or a
// program of the person's own. A backend that needs a secret names an environment variable for it (keyEnv); the
// secret itself never goes into the config.

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

// The choice of "Answers with" that keeps PLACEHOLDER_BACKEND: always the last one.
export const OWN_PROGRAM = 'own';

// What the browser app and the phone offer, which can't read Settings, Agents: the agents the runner finds on the
// computer it runs on without any settings. Android's AgentRules.BACKENDS has the same.
export const PLAIN_AGENTS = Object.freeze([
  Object.freeze({ id: 'claude', name: 'Claude Code', kind: 'claude', backend: Object.freeze({ type: 'claude' }) }),
  Object.freeze({ id: 'codex', name: 'Codex', kind: 'codex', backend: Object.freeze({ type: 'codex' }) })
]);

// What a status check of Settings, Agents says of an agent that can't answer here as it is set up: turned off, not set
// up, or its program not installed (agentStatus, src/main/agents/hub.js).
const UNFIT = new Set(['disabled', 'unconfigured', 'missing']);

// The agents "Answers with" offers, in order, each with ready: whether its status check passed. config: agentConfig's
// answer on desktop, or null in the browser and on the phone (PLAIN_AGENTS). status: agentStatus's answer, or null
// while it is unknown. Agents a status check says can't answer are left out; the ready ones come first, Settings'
// default agent first among them, and otherwise Settings' order holds. A program of one's own isn't in the list: it
// is always the last choice (OWN_PROGRAM).
export function runnerChoices(config, { status = null, names = {} } = {}) {
  const stateOf = (id) => (status && status[id] && typeof status[id].state === 'string' ? status[id].state : null);
  const list = (config ? runnerAgents(config, names) : PLAIN_AGENTS.map((a) => ({ ...a, backend: { ...a.backend } })))
    .filter((a) => !UNFIT.has(stateOf(a.id)))
    .map((a) => ({ ...a, ready: stateOf(a.id) === 'ready' }));
  const preferred = config && typeof config.defaultAgent === 'string' ? config.defaultAgent : null;
  const rank = (a) => (a.ready ? 0 : 2) + (a.id === preferred ? 0 : 1);
  return list
    .map((a, i) => [a, i])
    .sort((x, y) => rank(x[0]) - rank(y[0]) || x[1] - y[1])
    .map(([a]) => a);
}

// How long the key step waits for one agent's status check.
export const STATUS_WAIT = 3000;

// "Answers with" on desktop: runnerChoices of agentConfig's answer, with a status check of each agent (statusOf(id),
// agentStatus for that agent) that gets wait ms of its own, so a slow agent stays unknown without holding up the
// others. Only what Settings has: an empty list when no agent there can answer, or config is null.
export async function askedRunnerChoices(config, statusOf, { wait = STATUS_WAIT } = {}) {
  if (!config) return [];
  const ids = runnerChoices(config).map((a) => a.id);
  const entries = await Promise.all(
    ids.map((id) =>
      Promise.race([Promise.resolve().then(() => statusOf(id)).catch(() => null), new Promise((resolve) => setTimeout(() => resolve(null), wait))]).then((s) => [id, s])
    )
  );
  return runnerChoices(config, { status: Object.fromEntries(entries.filter(([, s]) => s && typeof s === 'object')) });
}

// How to start the runner with the config saved as agent.json next to runner.js.
export const RUNNER_COMMAND = 'node runner.js --config agent.json';

// Where to get the runner: its README on GitHub, whose "Get the runner" says how to download it.
export const RUNNER_URL = 'https://github.com/MajesteitBart/rukoo/blob/main/integrations/agent-runner/README.md#get-the-runner';

// The name of the Settings agent a runner answers with, by its id (a run's use, an "Answers with" choice): the name
// "Answers with" shows. config: agentConfig's answer, or null when unknown.
export function useName(config, id) {
  const found = (config ? runnerAgents(config) : []).concat(PLAIN_AGENTS).find((a) => a.id === id);
  return found ? found.name : String(id || '');
}

// An agent belongs to one workspace, so having Clark in a second one means a new agent there, with a key of its own.
// On the computer, Add an agent can start from an agent this computer runs in another workspace (src/main/agent-runs.js):
// its name, whom it answers, whether it answers other agents and the Settings agent that answers for it, whose own
// secret stays where Run on this computer keeps it. runs: the setups as agentRuns lists them (never a key); ws: the
// workspace the new agent is for; workspaces: [{ id, name }] of the session. Answers [{ ws, agent, name, use,
// workspace }], one per setup in another workspace the session still has, by name and then workspace.
export function agentCopies(runs, { ws, workspaces = [] } = {}) {
  const names = new Map((Array.isArray(workspaces) ? workspaces : []).filter((w) => w && typeof w.id === 'string').map((w) => [w.id, String(w.name || '')]));
  return (Array.isArray(runs) ? runs : [])
    .filter((r) => r && r.ws !== ws && names.has(r.ws) && typeof r.agent === 'string' && text(r.use))
    .map((r) => ({ ws: r.ws, agent: r.agent, name: text(r.name), use: text(r.use), workspace: names.get(r.ws) }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.workspace.localeCompare(b.workspace));
}

// What the form takes from a copied agent: agent is that agent as its workspace's GET /agents lists it, or null when
// it couldn't be read; copy is agentCopies()'s entry. Chosen people become Only me, since the people picked are members
// of the other workspace (chosenDropped says so). Unknown settings start on Only me without other agents.
export function copiedSettings(copy, agent = null) {
  const answers = agent && ['everyone', 'sponsor', 'members'].includes(agent.answers) ? agent.answers : 'sponsor';
  return {
    name: text((agent && agent.name) || (copy && copy.name)).slice(0, 200),
    answers: answers === 'members' ? 'sponsor' : answers,
    agents: Boolean(agent && agent.agents),
    use: copy ? copy.use : '',
    chosenDropped: answers === 'members',
    unread: !agent
  };
}

// The line about the last mention that got no answer, by the code the runner reported (integrations/agent-runner
// backends.js BackendError): the catalogs' words, never the runner's.
const FAILED = { timeout: 'failedTimeout', exit: 'failedExit', empty: 'failedEmpty', offline: 'failedOffline' };
function failureText(f, { t, use }) {
  if (f.code === 'missing') return { text: t('chat.agents.run.missing', { use }), tone: 'error' };
  if (f.code === 'http' && Number.isSafeInteger(f.status)) return { text: t('chat.agents.run.failedHttp', { use, status: f.status }), tone: 'warn' };
  return { text: t(`chat.agents.run.${FAILED[f.code] || 'failed'}`, { use }), tone: 'warn' };
}

// What the Agents dialog and the key step say of an agent this computer runs (src/main/agent-runs.js, its view of a
// setup): { text, tone }, tone ok, busy, warn, error or off for the dot before it. use: the name of the agent it
// answers with. Main passes only codes and an HTTP status of what the runner reported, which the catalogs word.
export function runStateText(run, { t, use = '', locale = 'en', now = Date.now() }) {
  if (!run) return null;
  switch (run.phase) {
    case 'starting':
      // It tries the server again and again while it starts; until it connects it doesn't answer.
      if (run.unreachable) return { text: t('chat.agents.run.startingOffline'), tone: 'warn' };
      return { text: t('chat.agents.run.starting'), tone: 'busy' };
    case 'running': {
      // After the computer woke: what it said before may no longer hold, until its next pass.
      if (run.stale) return { text: t('chat.agents.run.stale'), tone: 'busy' };
      const p = run.problem;
      if (p && p.code === 'missing') return { text: t('chat.agents.run.missing', { use }), tone: 'error' };
      if (p && p.code === 'unreachable') return { text: t('chat.agents.run.unreachable', { use }), tone: 'error' };
      if (p && p.code === 'backend_key') return { text: t('chat.agents.run.backendKey', { use }), tone: 'error' };
      if (p) return { text: t('chat.agents.run.problem', { use }), tone: 'error' };
      if (run.unreachable) return { text: t('chat.agents.run.offline'), tone: 'warn' };
      if (run.failure && !(run.answeredAt > run.failure.at)) return failureText(run.failure, { t, use });
      if (run.channels === 0) return { text: t('chat.agents.run.noChannel'), tone: 'warn' };
      return { text: t('chat.agents.run.running'), tone: 'ok' };
    }
    case 'changed':
      // Settings, Agents name another program or address than the one approved here, or the agent is off or gone there.
      return { text: t(run.gone ? 'chat.agents.run.gone' : 'chat.agents.run.changed', { use }), tone: 'error' };
    case 'waiting': {
      const seconds = Math.max(1, Math.round(((run.retryAt || now) - now) / 1000));
      const time = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(seconds < 90 ? seconds : Math.round(seconds / 60), seconds < 90 ? 'second' : 'minute');
      return { text: t('chat.agents.run.waiting', { time }), tone: 'warn' };
    }
    case 'refused':
      return { text: t('chat.agents.run.refused'), tone: 'error' };
    case 'error': {
      const code = run.error && run.error.code;
      if (code === 'unknown_backend') return { text: t('chat.agents.run.unknownUse'), tone: 'error' };
      if (code === 'missing') return { text: t('chat.agents.run.missing', { use }), tone: 'error' };
      if (code === 'key_unreadable') return { text: t('chat.agents.run.keyUnreadable'), tone: 'error' };
      if (code === 'unresolved') return { text: t('chat.agents.run.unresolved', { use }), tone: 'error' };
      if (code === 'plain_http') return { text: t('chat.agents.run.plainHttp', { use }), tone: 'error' };
      return { text: t('chat.agents.run.cantStart'), tone: 'error' };
    }
    default:
      return { text: t('chat.agents.run.stopped'), tone: 'off' };
  }
}

// The kinds of "Answers with" that keep the tools, memory and integrations of their own profile (Hermes, OpenClaw and
// custom agents on a server), which they can use for anyone the agent answers. Claude Code and Codex run without tools.
export const KEEPS_TOOLS = Object.freeze(['hermes', 'openclaw', 'custom']);
export const keepsTools = (choice) => Boolean(choice) && KEEPS_TOOLS.includes(choice.kind);

// The key as the config shows it on the computer, where main keeps it and the window never gets it.
export const KEY_MASK = '••••••••••••';

// Whether a runner somewhere else used the agent's key lately, so starting it here too would make two runners answer
// its mentions: the server saw the key (lastSeen, AgentOut) within the last ten minutes, more than a minute after this
// computer's runner last did. The server writes lastSeen once a minute at most, hence the minute.
export const ELSEWHERE_WITHIN = 10 * 60 * 1000;
export function ranElsewhere(lastSeen, run, now = Date.now()) {
  if (!Number.isFinite(lastSeen) || now - lastSeen > ELSEWHERE_WITHIN) return false;
  const here = Math.max(0, ...[run && run.stoppedAt, run && run.passAt, run && run.connectedAt].filter(Number.isFinite));
  return lastSeen > here + 60 * 1000;
}

// When an agent's runner last reached the server, as its rows say it: "Not connected yet" for an agent whose runner
// never did (lastSeen null), "Last active 5 minutes ago", "Last active yesterday", or after a week the date. '' while
// it is unknown (undefined): a guest can't read it, or it hasn't loaded yet.
export function agentSeenText(lastSeen, { t, locale, now = Date.now() }) {
  if (lastSeen === undefined) return '';
  if (lastSeen === null || !Number.isFinite(lastSeen)) return t('chat.agents.neverActive');
  return t('chat.agents.lastActive', { date: sinceText(lastSeen, now, locale) });
}

// How long ago at was: "5 minutes ago", "yesterday", or after a week a day and month.
export function sinceText(at, now, locale) {
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const minutes = Math.max(1, Math.floor((now - at) / 60000));
  if (minutes < 60) return rtf.format(-minutes, 'minute');
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return rtf.format(-hours, 'hour');
  const days = Math.floor(hours / 24);
  if (days < 7) return rtf.format(-days, 'day');
  return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', ...(new Date(at).getFullYear() !== new Date(now).getFullYear() ? { year: 'numeric' } : {}) }).format(at);
}
