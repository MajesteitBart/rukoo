'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const AGENT_IDS = ['clark', 'claude', 'codex'];
const ACCESS = ['ask', 'full'];

const DEFAULTS = {
  version: 1,
  defaultAgent: 'clark',
  // true: mail_action runs without an approval card (unsubscribe always asks).
  autoMailActions: false,
  clark: { enabled: true, name: 'Hermes', url: '', key: null, model: '' },
  claude: { enabled: true, exe: '', configDir: '', model: '', access: 'ask' },
  codex: { enabled: true, exe: '', model: '', access: 'ask' },
  mcp: { port: 47800, remote: false, remoteHost: '' }
};

// Clark's bridge signs in with a token made from the Hermes API key. Every Rukoo needs that key to chat with
// Clark anyway, so one bridge setup reaches Rukoo on any of the user's devices.
function remoteTokenFor(key) {
  return key ? crypto.createHmac('sha256', key).update('rukoo-mcp-v1').digest('base64url') : '';
}

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
      clark: mergeSection(DEFAULTS.clark, s.clark),
      claude: mergeSection(DEFAULTS.claude, s.claude),
      codex: mergeSection(DEFAULTS.codex, s.codex),
      mcp: mergeSection(DEFAULTS.mcp, s.mcp)
    };
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
    if (section === 'clark') return { ...this.data.clark, key: this.decrypt(this.data.clark.key) };
    if (this.data[section] && isObj(this.data[section])) return { ...this.data[section] };
    return null;
  }

  displayName(agent) {
    if (agent === 'clark') return this.data.clark.name || DEFAULTS.clark.name;
    return agent === 'claude' ? 'Claude' : agent === 'codex' ? 'Codex' : String(agent || '');
  }

  // remoteHost wins; otherwise the first Tailscale IPv4 on this machine.
  address() {
    return this.data.mcp.remoteHost || tailscaleAddress(this.interfaces);
  }

  publicView() {
    const d = this.data;
    const { key, ...clark } = d.clark;
    return {
      version: 1,
      defaultAgent: d.defaultAgent,
      autoMailActions: d.autoMailActions,
      clark: { ...clark, hasKey: Boolean(key) },
      claude: { ...d.claude },
      codex: { ...d.codex },
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
      if (!AGENT_IDS.includes(patch.defaultAgent)) throw new AgentError('invalid', 'defaultAgent must be clark, claude or codex');
      next.defaultAgent = patch.defaultAgent;
    }
    if ('autoMailActions' in patch) next.autoMailActions = bool(patch.autoMailActions, 'autoMailActions');
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
    if (agent !== 'clark') throw new AgentError('invalid', 'only clark has a secret');
    if (typeof value !== 'string' || value.length > 4000) throw new AgentError('invalid', 'key must be text');
    const v = value.trim();
    this.data.clark.key = v ? this.secrets.encrypt(v) : null;
    this.save();
    return this.publicView();
  }

  // The token Clark's bridge sends; empty until the API key is set.
  remoteToken() {
    return remoteTokenFor(this.get('clark').key);
  }

  // The block for ~/.hermes/config.yaml on Clark's machine. It holds no secret and is the same on every device:
  // the bridge finds Rukoo over Tailscale and signs in with the API server key, which Hermes fills in from its
  // .env. ${userHome} is a Hermes config variable.
  hermesSetup() {
    const port = this.runtime.remotePort || this.data.mcp.port;
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

module.exports = { AgentConfig, AgentError, AGENT_IDS, DEFAULTS, writeJsonAtomic, tailscaleAddress, isTailscale, remoteTokenFor };
