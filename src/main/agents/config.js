'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const AGENT_IDS = ['clark', 'claude', 'codex', 'openclaw'];
// Agents that keep a secret (the Hermes API key, the OpenClaw gateway token), encrypted in the file as `key`.
const SECRET_AGENTS = ['clark', 'openclaw'];
// Where an OpenClaw gateway listens unless it was told otherwise (docs.openclaw.ai/gateway/config-gateway).
const OPENCLAW_URL = 'http://127.0.0.1:18789';
const ACCESS = ['ask', 'full'];
// Every effort level an agent may offer, lowest first. Each agent offers its own subset (see models()).
const EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

// The chat panel's shortcuts, as the user arranged them (null: Rukoo's own, in their own order). Each entry is a
// command name with what the user changed: a shortcut of Rukoo's can be hidden or get its own label and prompt; one
// of the user's own (custom) has all of these. Main checks the shape; the panel knows which names are Rukoo's.
const SHORTCUT_KEY = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// Message actions the hub and the panel give a meaning of their own; a shortcut can't take their name.
const SHORTCUT_RESERVED = new Set(['approved', 'declined', 'skill', 'shortcut']);
const SHORTCUT_ICONS = ['sparkle', 'mail', 'search', 'list', 'arrow-right', 'layers', 'clock', 'file', 'pen', 'calendar', 'person', 'globe', 'chart', 'link', 'check', 'shield', 'info', 'x'];
const SHORTCUT_WHEN = ['email', 'always'];
const SHORTCUTS_MAX = 40;
const SHORTCUT_LABEL_MAX = 60;
const SHORTCUT_PROMPT_MAX = 4000;

const DEFAULTS = {
  version: 1,
  defaultAgent: 'clark',
  // true: mail_action runs without an approval card (unsubscribe always asks).
  autoMailActions: false,
  shortcuts: null,
  clark: { enabled: true, name: 'Hermes', url: '', key: null, model: '' },
  claude: { enabled: true, exe: '', configDir: '', model: '', access: 'ask' },
  codex: { enabled: true, exe: '', model: '', access: 'ask' },
  // agent: the OpenClaw agent id a new chat goes to ('' for the gateway's default agent). model: a backend model
  // for x-openclaw-model ('' for the agent's own).
  openclaw: { enabled: true, url: OPENCLAW_URL, key: null, agent: '', model: '' },
  mcp: { port: 47800, remote: false, remoteHost: '' }
};

// Clark's bridge signs in with a token made from the Hermes API key. Every Rukoo needs that key to chat with
// Clark anyway, so one bridge setup reaches Rukoo on any of the user's devices.
function remoteTokenFor(key) {
  return key ? crypto.createHmac('sha256', key).update('rukoo-mcp-v1').digest('base64url') : '';
}

// The token OpenClaw's MCP client sends to Rukoo, made from the gateway token: it changes with that token, and it
// doesn't give away the gateway token itself. Rukoo accepts it only on 127.0.0.1.
function openclawTokenFor(key) {
  return key ? crypto.createHmac('sha256', key).update('rukoo-mcp-openclaw-v1').digest('base64url') : '';
}

// An OpenClaw agent id as the gateway takes it in `openclaw/<agentId>` (lowercase letters, digits, - and _).
const OPENCLAW_AGENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

// Errors that reach the renderer carry a code from SPEC 4.6; the message is the bare code so the
// renderer can localize it from Error.message after the IPC round trip.
class AgentError extends Error {
  constructor(code, detail = '') {
    super(code);
    this.code = code;
    this.detail = String(detail || '');
  }
}

function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

const clone = (v) => JSON.parse(JSON.stringify(v));
const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

// Tailscale hands out addresses from the CGNAT range 100.64.0.0/10.
function isTailscale(ip) {
  const m = /^100\.(\d+)\.\d+\.\d+$/.exec(String(ip || ''));
  return Boolean(m) && Number(m[1]) >= 64 && Number(m[1]) <= 127;
}

function tailscaleAddress(interfaces = os.networkInterfaces) {
  let list = {};
  try {
    list = interfaces() || {};
  } catch (_) {
    return '';
  }
  for (const addrs of Object.values(list)) {
    for (const a of addrs || []) {
      const v4 = a.family === 'IPv4' || a.family === 4;
      if (v4 && !a.internal && isTailscale(a.address)) return a.address;
    }
  }
  return '';
}

// Copies the known keys of a stored section over the defaults, keeping only values of the right type.
function mergeSection(defaults, stored) {
  const out = { ...defaults };
  if (!isObj(stored)) return out;
  for (const [k, def] of Object.entries(defaults)) {
    const v = stored[k];
    if (v === undefined) continue;
    if (def === null ? typeof v === 'string' || v === null : typeof v === typeof def) out[k] = v;
  }
  return out;
}

function text(value, max, field) {
  if (typeof value !== 'string') throw new AgentError('invalid', `${field} must be text`);
  const s = value.trim();
  if (s.length > max) throw new AgentError('invalid', `${field} is longer than ${max} characters`);
  return s;
}

function bool(value, field) {
  if (typeof value !== 'boolean') throw new AgentError('invalid', `${field} must be true or false`);
  return value;
}

// The shortcut list as stored: a clean copy, in order. An entry that breaks the rules throws 'invalid'.
function shortcutList(value) {
  if (value === null) return null;
  if (!Array.isArray(value)) throw new AgentError('invalid', 'shortcuts must be a list');
  if (value.length > SHORTCUTS_MAX) throw new AgentError('invalid', `at most ${SHORTCUTS_MAX} shortcuts`);
  const seen = new Set();
  return value.map((entry) => {
    if (!isObj(entry)) throw new AgentError('invalid', 'a shortcut must be an object');
    const key = text(entry.key, 40, 'shortcut name').toLowerCase();
    if (!SHORTCUT_KEY.test(key)) throw new AgentError('invalid', 'a shortcut name has lowercase letters, digits and single hyphens');
    if (SHORTCUT_RESERVED.has(key)) throw new AgentError('invalid', `/${key} is taken`);
    if (seen.has(key)) throw new AgentError('invalid', `/${key} is there twice`);
    seen.add(key);
    const out = { key };
    if (entry.custom === true) out.custom = true;
    if (entry.hidden !== undefined && bool(entry.hidden, 'shortcut hidden')) out.hidden = true;
    const label = entry.label == null ? '' : text(entry.label, SHORTCUT_LABEL_MAX, 'shortcut label');
    const prompt = entry.prompt == null ? '' : text(entry.prompt, SHORTCUT_PROMPT_MAX, 'shortcut prompt');
    if (label) out.label = label;
    if (prompt) out.prompt = prompt;
    if (out.custom) {
      if (!label || !prompt) throw new AgentError('invalid', `/${key} needs a label and a prompt`);
      out.icon = SHORTCUT_ICONS.includes(entry.icon) ? entry.icon : 'sparkle';
      out.when = SHORTCUT_WHEN.includes(entry.when) ? entry.when : 'email';
    }
    return out;
  });
}

// A list in the file that no longer passes (edited by hand, or from a later Rukoo) gives way to the defaults.
function storedShortcuts(value) {
  try {
    return value === undefined ? null : shortcutList(value);
  } catch (_) {
    return null;
  }
}

function httpUrl(value, field) {
  const s = text(value, 300, field);
  if (!s) return '';
  let u;
  try {
    u = new URL(s);
  } catch (_) {
    throw new AgentError('invalid', `${field} is not a valid URL`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new AgentError('invalid', `${field} must start with http:// or https://`);
  if (u.username || u.password) throw new AgentError('invalid', `${field} must not contain credentials`);
  return s.replace(/\/+$/, '');
}

class AgentConfig {
  constructor({ file, secrets, interfaces = os.networkInterfaces } = {}) {
    this.file = file;
    this.secrets = secrets || { encrypt: (s) => s, decrypt: (s) => s };
    this.interfaces = interfaces;
    this.data = clone(DEFAULTS);
    // Filled in by the hub once the MCP listeners are up; never persisted.
    this.runtime = { localPort: null, remotePort: null, note: '' };
  }

  load() {
    let stored = null;
    try {
      stored = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (_) {
      stored = null;
    }
    const s = isObj(stored) ? stored : {};
    this.data = {
      version: 1,
      defaultAgent: AGENT_IDS.includes(s.defaultAgent) ? s.defaultAgent : DEFAULTS.defaultAgent,
      autoMailActions: s.autoMailActions === true,
      shortcuts: storedShortcuts(s.shortcuts),
      clark: mergeSection(DEFAULTS.clark, s.clark),
      claude: mergeSection(DEFAULTS.claude, s.claude),
      codex: mergeSection(DEFAULTS.codex, s.codex),
      openclaw: mergeSection(DEFAULTS.openclaw, s.openclaw),
      mcp: mergeSection(DEFAULTS.mcp, s.mcp)
    };
    if (this.data.openclaw.agent && !OPENCLAW_AGENT.test(this.data.openclaw.agent)) this.data.openclaw.agent = '';
    for (const id of ['claude', 'codex']) if (!ACCESS.includes(this.data[id].access)) this.data[id].access = 'ask';
    const port = this.data.mcp.port;
    if (!Number.isInteger(port) || port < 1024 || port > 65535) this.data.mcp.port = DEFAULTS.mcp.port;
    if (!this.data.clark.name) this.data.clark.name = DEFAULTS.clark.name;
    return this;
  }

  save() {
    writeJsonAtomic(this.file, this.data);
  }

  decrypt(value) {
    if (!value) return '';
    try {
      return this.secrets.decrypt(value);
    } catch (_) {
      // Encrypted under another Windows user or machine: treat as not set.
      return '';
    }
  }

  // Raw section for main-process code, with the secret decrypted. Never send this to the renderer.
  get(section) {
    if (SECRET_AGENTS.includes(section)) return { ...this.data[section], key: this.decrypt(this.data[section].key) };
    if (this.data[section] && isObj(this.data[section])) return { ...this.data[section] };
    return null;
  }

  displayName(agent) {
    if (agent === 'clark') return this.data.clark.name || DEFAULTS.clark.name;
    return agent === 'claude' ? 'Claude' : agent === 'codex' ? 'Codex' : agent === 'openclaw' ? 'OpenClaw' : String(agent || '');
  }

  // remoteHost wins; otherwise the first Tailscale IPv4 on this machine.
  address() {
    return this.data.mcp.remoteHost || tailscaleAddress(this.interfaces);
  }

  publicView() {
    const d = this.data;
    const { key, ...clark } = d.clark;
    const { key: openclawKey, ...openclaw } = d.openclaw;
    return {
      version: 1,
      defaultAgent: d.defaultAgent,
      autoMailActions: d.autoMailActions,
      shortcuts: d.shortcuts ? clone(d.shortcuts) : null,
      clark: { ...clark, hasKey: Boolean(key) },
      claude: { ...d.claude },
      codex: { ...d.codex },
      openclaw: { ...openclaw, hasKey: Boolean(openclawKey) },
      mcp: {
        port: d.mcp.port,
        remote: d.mcp.remote,
        remoteHost: d.mcp.remoteHost,
        address: this.address(),
        localPort: this.runtime.localPort,
        remotePort: this.runtime.remotePort,
        note: this.runtime.note || ''
      }
    };
  }

  // Applies a renderer patch. Unknown keys are ignored; known keys with bad values throw 'invalid'.
  // Secrets never come in this way (setSecret).
  update(patch) {
    if (!isObj(patch)) throw new AgentError('invalid', 'patch must be an object');
    const next = clone(this.data);
    if ('defaultAgent' in patch) {
      if (!AGENT_IDS.includes(patch.defaultAgent)) throw new AgentError('invalid', 'defaultAgent must be clark, claude, codex or openclaw');
      next.defaultAgent = patch.defaultAgent;
    }
    if ('autoMailActions' in patch) next.autoMailActions = bool(patch.autoMailActions, 'autoMailActions');
    if ('shortcuts' in patch) next.shortcuts = shortcutList(patch.shortcuts);
    const section = (name, apply) => {
      if (!(name in patch)) return;
      if (!isObj(patch[name])) throw new AgentError('invalid', `${name} must be an object`);
      apply(patch[name], next[name]);
    };
    const access = (v, field) => {
      if (!ACCESS.includes(v)) throw new AgentError('invalid', `${field} must be ask or full`);
      return v;
    };
    section('clark', (p, s) => {
      if ('enabled' in p) s.enabled = bool(p.enabled, 'clark.enabled');
      if ('name' in p) s.name = text(p.name, 40, 'clark.name') || DEFAULTS.clark.name;
      if ('url' in p) s.url = httpUrl(p.url, 'clark.url');
      if ('model' in p) s.model = text(p.model, 100, 'clark.model');
    });
    section('claude', (p, s) => {
      if ('enabled' in p) s.enabled = bool(p.enabled, 'claude.enabled');
      if ('exe' in p) s.exe = text(p.exe, 500, 'claude.exe');
      if ('configDir' in p) s.configDir = text(p.configDir, 500, 'claude.configDir');
      if ('model' in p) s.model = text(p.model, 100, 'claude.model');
      if ('access' in p) s.access = access(p.access, 'claude.access');
    });
    section('codex', (p, s) => {
      if ('enabled' in p) s.enabled = bool(p.enabled, 'codex.enabled');
      if ('exe' in p) s.exe = text(p.exe, 500, 'codex.exe');
      if ('model' in p) s.model = text(p.model, 100, 'codex.model');
      if ('access' in p) s.access = access(p.access, 'codex.access');
    });
    section('openclaw', (p, s) => {
      if ('enabled' in p) s.enabled = bool(p.enabled, 'openclaw.enabled');
      if ('url' in p) s.url = httpUrl(p.url, 'openclaw.url');
      if ('agent' in p) {
        const agent = text(p.agent, 64, 'openclaw.agent');
        if (agent && !OPENCLAW_AGENT.test(agent)) throw new AgentError('invalid', 'openclaw.agent is an agent id: letters, digits, - and _');
        s.agent = agent;
      }
      if ('model' in p) s.model = text(p.model, 100, 'openclaw.model');
    });
    section('mcp', (p, s) => {
      if ('port' in p) {
        const port = Number(p.port);
        if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new AgentError('invalid', 'mcp.port must be between 1024 and 65535');
        s.port = port;
      }
      if ('remote' in p) s.remote = bool(p.remote, 'mcp.remote');
      if ('remoteHost' in p) {
        const host = text(p.remoteHost, 255, 'mcp.remoteHost');
        if (host && !/^[A-Za-z0-9.\-]+$/.test(host)) throw new AgentError('invalid', 'mcp.remoteHost must be an IPv4 address or host name');
        s.remoteHost = host;
      }
    });
    this.data = next;
    this.save();
    return this.publicView();
  }

  setSecret(agent, value) {
    if (!SECRET_AGENTS.includes(agent)) throw new AgentError('invalid', 'only clark and openclaw have a secret');
    if (typeof value !== 'string' || value.length > 4000) throw new AgentError('invalid', 'key must be text');
    const v = value.trim();
    this.data[agent].key = v ? this.secrets.encrypt(v) : null;
    this.save();
    return this.publicView();
  }

  // The token Clark's bridge sends; empty until the API key is set.
  remoteToken() {
    return remoteTokenFor(this.get('clark').key);
  }

  // The token OpenClaw's MCP client sends; empty until the gateway token is set.
  openclawToken() {
    return openclawTokenFor(this.get('openclaw').key);
  }

  // The command that adds Rukoo to OpenClaw's MCP servers (docs.openclaw.ai/cli/mcp): Streamable HTTP on this
  // computer's loopback, with the token above. OpenClaw leaves a URL server on SSE unless transport says otherwise.
  // port: the port Rukoo's local listener really got. The command holds a token, unlike the Hermes block: OpenClaw
  // can't compute it from its gateway token. It is only of use on this computer.
  openclawSetup(port = this.runtime.localPort || this.data.mcp.port) {
    const token = this.openclawToken();
    if (!token) return '';
    const server = { url: `http://127.0.0.1:${port}/mcp`, transport: 'streamable-http', headers: { Authorization: `Bearer ${token}` } };
    return `openclaw mcp set rukoo '${JSON.stringify(server)}'\n`;
  }

  // The block for ~/.hermes/config.yaml on Clark's machine. It holds no secret and is the same on every device:
  // the bridge finds Rukoo over Tailscale and signs in with the API server key, which Hermes fills in from its
  // .env. ${userHome} is a Hermes config variable.
  hermesSetup() {
    // The configured port, which other devices share. A port this device fell back to applies to it alone.
    const port = this.data.mcp.port;
    const name = this.displayName('clark');
    return [
      `# Rukoo Mail: lets ${name} read mail, write drafts and ask for approval in Rukoo, on any of your devices.`,
      '# 1. Copy rukoo_bridge.py (Rukoo: integrations/hermes) to ~/.hermes/ on this machine.',
      '# 2. Merge this block into ~/.hermes/config.yaml (keep your other mcp_servers).',
      '# 3. Check it with: hermes mcp test rukoo',
      `# On each device, turn on Settings > Agents > "Let ${name} use Rukoo".`,
      'mcp_servers:',
      '  rukoo:',
      '    command: python3',
      '    args: ["${userHome}/.hermes/rukoo_bridge.py"]',
      '    env:',
      '      RUKOO_KEY: ${API_SERVER_KEY}',
      ...(port !== DEFAULTS.mcp.port ? [`      RUKOO_PORT: "${port}"`] : []),
      '    timeout: 120',
      ''
    ].join('\n');
  }
}

module.exports = { AgentConfig, AgentError, AGENT_IDS, SECRET_AGENTS, EFFORTS, DEFAULTS, SHORTCUT_ICONS, SHORTCUTS_MAX, writeJsonAtomic, tailscaleAddress, isTailscale, remoteTokenFor, openclawTokenFor };
