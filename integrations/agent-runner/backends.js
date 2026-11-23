'use strict';

// The agent runtimes the runner can hand a trigger to. Each run(prompt, { id, signal }) answers the reply text, or
// throws a BackendError: the runner then posts nothing. Every trigger is a fresh session without memory.
//
//   runs     the Runs API of Hermes Agent and Booper's app channel (as src/main/agents/hermes.js speaks it)
//   openai   OpenAI-compatible Chat Completions, which OpenClaw's gateway and many servers speak (openai.js, openclaw.js)
//   claude   `claude -p`, without MCP servers, tools, hooks or plugins
//   codex    `codex exec` in its read-only sandbox, without its command tool, MCP servers or user config
//   command  any program: the prompt on stdin, the reply on stdout

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const WINDOWS = process.platform === 'win32';
const DEFAULT_TIMEOUT = 600;
// What a process may write before the runner stops reading: far more than five messages.
const STDOUT_MAX = 1024 * 1024;
const STDERR_MAX = 16 * 1024;

class BackendError extends Error {}

const clip = (text, max = 300) => {
  const s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};

const sleep = (ms, signal) =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (signal) signal.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true });
  });

// A secret from the config: key, else the variable keyEnv names.
function secret(config, env = process.env) {
  if (typeof config.key === 'string' && config.key.trim()) return config.key.trim();
  if (typeof config.keyEnv === 'string' && config.keyEnv.trim()) return String(env[config.keyEnv.trim()] || '').trim();
  return '';
}

function timeoutMs(config) {
  const n = Number(config.timeout);
  return (Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT) * 1000;
}

// The URL of path on a server with an optional path prefix (Hermes serves profiles under /p/<name>/).
function endpoint(base, route) {
  let url;
  try {
    url = new URL(String(base || '').trim());
  } catch {
    throw new BackendError(`The backend's "url" is not an address: ${base}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new BackendError('The backend\'s "url" must start with http:// or https://');
  const out = new URL(url.pathname.replace(/\/+$/, '') + route, url.origin);
  if (out.origin !== url.origin) throw new BackendError('Refusing a request outside the backend server');
  return out;
}

// ---- Server-sent events ----

// `event:`/`data:`/`id:` lines; a blank line ends a frame; lines starting with ':' are comments.
class SseParser {
  constructor(onEvent) {
    this.onEvent = onEvent;
    this.buffer = '';
    this.event = '';
    this.data = [];
    this.decoder = new TextDecoder('utf-8');
  }

  push(chunk) {
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.decode(chunk, { stream: true });
    const lines = this.buffer.split(/\r\n|\r|\n/);
    this.buffer = lines.pop();
    for (const line of lines) this.line(line);
  }

  line(text) {
    if (text === '') {
      if (this.data.length) this.onEvent({ event: this.event || 'message', data: this.data.join('\n') });
      this.event = '';
      this.data = [];
      return;
    }
    if (text[0] === ':') return;
    const colon = text.indexOf(':');
    const field = colon === -1 ? text : text.slice(0, colon);
    let value = colon === -1 ? '' : text.slice(colon + 1);
    if (value[0] === ' ') value = value.slice(1);
    if (field === 'event') this.event = value;
    else if (field === 'data') this.data.push(value);
  }
}

async function readStream(body, parser, signal) {
  const reader = body.getReader();
  const cancel = () => reader.cancel().catch(() => {});
  if (signal) signal.addEventListener('abort', cancel, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parser.push(value);
    }
    parser.push('\n\n');
  } finally {
    if (signal) signal.removeEventListener('abort', cancel);
  }
}

async function errorOf(res) {
  let text = '';
  try {
    text = await res.text();
  } catch {}
  let detail = text;
  try {
    const data = JSON.parse(text);
    detail = (data && data.error && (data.error.message || data.error)) || (data && data.message) || text;
  } catch {}
  return new BackendError(`HTTP ${res.status}${detail ? `: ${clip(typeof detail === 'string' ? detail : JSON.stringify(detail), 200)}` : ''}`);
}

// ---- runs: Hermes Agent and Booper ----

// One run per trigger, without session_id, so the server starts a session of its own for it. The Idempotency-Key
// names the trigger, so a POST sent again after a lost answer gets the run it already started. Approval requests are
// denied: nobody is there to answer them. A run that takes longer than the timeout is stopped.
class RunsBackend {
  constructor(config) {
    this.config = config;
    if (!config.url) throw new BackendError('The runs backend needs "url"');
  }

  headers(extra = {}) {
    const key = secret(this.config);
    return { Accept: 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}), ...extra };
  }

  async call(method, route, { body, headers, signal, timeout = 30000 } = {}) {
    const res = await fetch(endpoint(this.config.url, route), {
      method,
      headers: this.headers({ ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }),
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.any([AbortSignal.timeout(timeout), ...(signal ? [signal] : [])])
    });
    return res;
  }

  async run(prompt, { id, signal } = {}) {
    const deadline = AbortSignal.any([AbortSignal.timeout(timeoutMs(this.config)), ...(signal ? [signal] : [])]);
    const body = { input: prompt.input, instructions: prompt.instructions };
    // "provider::model", as Rukoo's model menu names a model of another provider.
    const model = String(this.config.model || '').trim();
    if (model) {
      const at = model.indexOf('::');
      if (at > 0) {
        body.provider = model.slice(0, at);
        body.model = model.slice(at + 2);
      } else body.model = model;
    }
    // The same trigger with the same input gets the run it already has; the trigger with other input (more messages
    // came, or other settings) is another run.
    const digest = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 16);
    let res;
    try {
      res = await this.call('POST', '/v1/runs', { body, headers: { 'Idempotency-Key': `rukoo-agent-${id}-${digest}` }, signal: deadline });
    } catch (err) {
      throw new BackendError(`Could not start a run: ${clip(err.cause ? err.cause.message || err.cause : err.message, 200)}`);
    }
    if (res.status !== 200 && res.status !== 202) throw await errorOf(res);
    const started = await res.json().catch(() => null);
    const runId = started && started.run_id;
    if (!runId) throw new BackendError('The server did not return a run id');
    try {
      return await this.follow(runId, deadline);
    } catch (err) {
      // Stopped or out of time: the run must not go on where nobody follows it.
      await this.call('POST', `/v1/runs/${encodeURIComponent(runId)}/stop`, { timeout: 5000 }).catch(() => {});
      throw err instanceof BackendError ? err : new BackendError(deadline.aborted ? 'The run took longer than the timeout and was stopped' : clip(err.message, 200));
    }
  }

  // The run's event stream; when it breaks off, its status, until the run ends.
  async follow(runId, signal) {
    const state = { text: '', end: null };
    const onEvent = ({ event, data }) => {
      let d;
      try {
        d = JSON.parse(data);
      } catch {
        return;
      }
      const kind = (d && d.event) || event;
      if (kind === 'message.delta' || kind === 'assistant.delta') state.text += typeof d.delta === 'string' ? d.delta : '';
      else if (kind === 'run.completed') state.end = { ok: true, output: typeof d.output === 'string' ? d.output : '' };
      else if (kind === 'run.failed' || kind === 'run.interrupted' || kind === 'error') state.end = { ok: false, detail: d.error || d.message || 'The run failed' };
      else if (kind === 'run.cancelled') state.end = { ok: false, detail: 'The run was cancelled' };
      else if (kind === 'approval.request') this.deny(runId, d.request_id);
    };
    try {
      const res = await this.call('GET', `/v1/runs/${encodeURIComponent(runId)}/events`, { headers: { Accept: 'text/event-stream' }, signal, timeout: timeoutMs(this.config) });
      if (res.ok && res.body) await readStream(res.body, new SseParser(onEvent), signal);
      else res.body?.cancel().catch(() => {});
    } catch (err) {
      if (signal.aborted) throw err;
    }
    while (!state.end) {
      if (signal.aborted) throw new BackendError('The run took longer than the timeout and was stopped');
      const res = await this.call('GET', `/v1/runs/${encodeURIComponent(runId)}`, { signal }).catch(() => null);
      const d = res && res.ok ? await res.json().catch(() => null) : null;
      if (d && d.status === 'completed') state.end = { ok: true, output: d.output || '' };
      else if (d && (d.status === 'failed' || d.status === 'interrupted')) state.end = { ok: false, detail: d.error || d.message || 'The run failed' };
      else if (d && d.status === 'cancelled') state.end = { ok: false, detail: 'The run was cancelled' };
      else if (d && d.status === 'waiting_for_approval') this.deny(runId, null);
      if (!state.end) await sleep(3000, signal);
    }
    if (!state.end.ok) throw new BackendError(clip(typeof state.end.detail === 'string' ? state.end.detail : JSON.stringify(state.end.detail), 200));
    return state.end.output || state.text;
  }

  deny(runId, requestId) {
    const body = { choice: 'deny', ...(requestId ? { request_id: String(requestId) } : {}) };
    this.call('POST', `/v1/runs/${encodeURIComponent(runId)}/approval`, { body, timeout: 10000 }).catch(() => {});
  }
}

// ---- openai: Chat Completions, OpenClaw's gateway ----

// The instructions as a system message and the prompt as the user's. `user` keeps a session on servers that keep one,
// such as OpenClaw, so it is unique per trigger: the configured prefix and the trigger's id.
class OpenAiBackend {
  constructor(config) {
    this.config = config;
    if (!config.url) throw new BackendError('The openai backend needs "url"');
  }

  async run(prompt, { id, signal } = {}) {
    const deadline = AbortSignal.any([AbortSignal.timeout(timeoutMs(this.config)), ...(signal ? [signal] : [])]);
    const key = secret(this.config);
    const user = `${String(this.config.user || 'rukoo-agent').trim()}:${id}`;
    const body = {
      model: String(this.config.model || '').trim() || 'default',
      user,
      stream: true,
      messages: [
        { role: 'system', content: prompt.instructions },
        { role: 'user', content: prompt.input }
      ]
    };
    const extra = this.config.headers && typeof this.config.headers === 'object' ? this.config.headers : {};
    let res;
    try {
      res = await fetch(endpoint(this.config.url, '/v1/chat/completions'), {
        method: 'POST',
        headers: { Accept: 'text/event-stream, application/json', 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}), ...extra },
        body: JSON.stringify(body),
        redirect: 'error',
        signal: deadline
      });
    } catch (err) {
      throw new BackendError(deadline.aborted ? 'No answer within the timeout' : `No answer from the server: ${clip(err.cause ? err.cause.message || err.cause : err.message, 200)}`);
    }
    if (!res.ok) throw await errorOf(res);
    // A server that ignores stream answers one completion as JSON.
    if (!/text\/event-stream/i.test(res.headers.get('content-type') || '')) {
      const data = await res.json().catch(() => null);
      const content = data && Array.isArray(data.choices) && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      if (typeof content !== 'string') throw new BackendError('The server answered without a message');
      return content;
    }
    const state = { text: '', error: null, done: false };
    const parser = new SseParser(({ data }) => {
      const raw = data.trim();
      if (raw === '[DONE]') return void (state.done = true);
      let d;
      try {
        d = JSON.parse(raw);
      } catch {
        return;
      }
      if (d && d.error) state.error = d.error.message || JSON.stringify(d.error);
      const choice = d && Array.isArray(d.choices) ? d.choices[0] : null;
      if (choice && choice.delta && typeof choice.delta.content === 'string') state.text += choice.delta.content;
      if (choice && choice.finish_reason) state.done = true;
    });
    try {
      await readStream(res.body, parser, deadline);
    } catch (err) {
      throw new BackendError(deadline.aborted ? 'The answer took longer than the timeout' : `The connection broke off: ${clip(err.message, 200)}`);
    }
    if (state.error) throw new BackendError(clip(state.error, 200));
    if (!state.done) throw new BackendError('The connection closed before the answer was complete');
    return state.text;
  }
}

// ---- Processes: claude, codex, command ----

// Variables a CLI reads as "you run inside another agent session", which leak in when the runner starts from a Claude
// Code or Codex terminal (src/main/agents/proc.js).
const SESSION_VARS = ['ELECTRON_RUN_AS_NODE', 'CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_EFFORT', 'CLAUDE_AGENT_SDK_VERSION', 'CLAUDE_PLUGIN_DATA', 'CLAUDE_PLUGIN_ROOT'];
const SESSION_PATTERNS = [
  /^CLAUDE_CODE_(ENTRYPOINT|SESSION_ID|CHILD_SESSION|SESSION_ATTENDED|MESSAGING_SOCKET|MESSAGING_TOKEN|EXECPATH|SSE_PORT)$/,
  /^CODEX_(THREAD_ID|SESSION_ID|TURN_ID|COMPANION_.*|MANAGED_BY_NPM|MANAGED_PACKAGE_ROOT|SANDBOX|SANDBOX_NETWORK_DISABLED|CI|INTERNAL_.*)$/
];

// The environment for a child: the runner's own, without the agent's key (by name and by value) or the variables
// above, plus extra. hide: names and values to leave out.
function childEnv(extra = {}, { hideNames = [], hideValues = [] } = {}, base = process.env) {
  const names = new Set(hideNames.filter(Boolean).map((n) => n.toUpperCase()));
  const values = hideValues.filter((v) => typeof v === 'string' && v.length >= 8);
  const env = {};
  for (const [k, v] of Object.entries(base)) {
    const upper = k.toUpperCase();
    if (names.has(upper) || SESSION_VARS.includes(upper) || SESSION_PATTERNS.some((re) => re.test(upper))) continue;
    if (typeof v === 'string' && values.some((s) => v.includes(s))) continue;
    env[k] = v;
  }
  for (const [k, v] of Object.entries(extra || {})) {
    if (v === undefined || v === null) delete env[k];
    else env[k] = String(v);
  }
  return env;
}

function executable(file) {
  try {
    if (!fs.statSync(file).isFile()) return false;
    if (!WINDOWS) fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// The first existing file of candidates, else the first program called name on PATH. On Windows only a real .exe:
// npm's .cmd shims need a shell, and the runner starts every program without one.
function findExe(candidates, name) {
  for (const file of candidates) if (file && executable(file)) return file;
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const file = path.join(dir, WINDOWS ? `${name}.exe` : name);
    if (executable(file)) return file;
  }
  return null;
}

// Ends a process and what it started: taskkill /T on Windows, the process group elsewhere.
function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  if (WINDOWS) {
    const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    killer.on('error', () => {
      try {
        child.kill();
      } catch {}
    });
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {}
  }
}

// Runs exe with input on stdin, without a shell. Resolves { code, stdout, stderr }; a timeout or stop kills the tree.
function runProcess(exe, args, { input = '', cwd, env, timeout, signal } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(exe, args, { cwd, env, shell: false, windowsHide: true, detached: !WINDOWS, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      reject(new BackendError(`Could not start ${path.basename(exe)}: ${clip(err.message, 200)}`));
      return;
    }
    const out = [];
    let outBytes = 0;
    let err = '';
    let ended = null;
    const stop = (why) => {
      if (ended) return;
      ended = why;
      killTree(child);
    };
    const timer = setTimeout(() => stop('timeout'), timeout);
    const onAbort = () => stop('stopped');
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    child.stdout.on('data', (chunk) => {
      if (outBytes >= STDOUT_MAX) return;
      out.push(chunk);
      outBytes += chunk.length;
    });
    child.stderr.on('data', (chunk) => {
      if (err.length < STDERR_MAX) err += chunk.toString('utf8');
    });
    child.stdin.on('error', () => {});
    child.on('error', (e) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      reject(new BackendError(e.code === 'ENOENT' ? `${path.basename(exe)} is not installed or not on PATH` : `Could not start ${path.basename(exe)}: ${clip(e.message, 200)}`));
    });
    child.on('close', (code, sig) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      if (ended === 'timeout') return reject(new BackendError(`${path.basename(exe)} took longer than ${Math.round(timeout / 1000)} s and was stopped`));
      if (ended === 'stopped') return reject(new BackendError('Stopped'));
      resolve({ code: code === null ? -1 : code, signal: sig, stdout: Buffer.concat(out).toString('utf8'), stderr: err });
    });
    child.stdin.end(input, 'utf8');
  });
}

// An empty folder for one run, so a CLI finds no project files, instructions or settings where it starts.
function scratchDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rukoo-agent-'));
}

function removeDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch {}
}

// The flags for `claude -p`, checked against Claude Code 2.1.328 (README "Claude Code").
function claudeArgs(config) {
  const args = [
    '-p',
    '--output-format',
    'json',
    '--no-session-persistence',
    // No hooks, plugins, skills, CLAUDE.md or MCP servers from the user's settings.
    '--safe-mode',
    // No built-in tools at all: nothing runs commands, reads files or fetches pages.
    '--tools',
    '',
    // No MCP servers but these: none.
    '--strict-mcp-config',
    '--mcp-config',
    '{"mcpServers":{}}',
    // Anything that would ask is refused, and nobody is asked.
    '--permission-mode',
    'dontAsk',
    '--permission-prompts',
    'none',
    '--disable-slash-commands'
  ];
  const model = String(config.model || '').trim();
  if (model) args.push(`--model=${model}`);
  return args;
}

class ClaudeBackend {
  constructor(config, { hide } = {}) {
    this.config = config;
    this.hide = hide || {};
  }

  exe() {
    const configured = String(this.config.exe || '').trim();
    const home = os.homedir();
    const found = configured ? (executable(configured) ? configured : null) : findExe([path.join(home, '.local', 'bin', WINDOWS ? 'claude.exe' : 'claude')], 'claude');
    if (!found) throw new BackendError(configured ? `"exe" is not a program: ${configured}` : 'Claude Code is not installed: no claude on PATH or in ~/.local/bin. Set "exe".');
    return found;
  }

  async run(prompt, { signal } = {}) {
    const exe = this.exe();
    const dir = scratchDir();
    try {
      const env = childEnv(this.config.configDir ? { CLAUDE_CONFIG_DIR: this.config.configDir } : {}, this.hide);
      const res = await runProcess(exe, claudeArgs(this.config), { input: prompt.text, cwd: dir, env, timeout: timeoutMs(this.config), signal });
      // One JSON object, possibly after other lines.
      let data = null;
      for (const candidate of [res.stdout.trim(), res.stdout.trim().split(/\r?\n/).filter(Boolean).pop() || '']) {
        try {
          data = JSON.parse(candidate);
          break;
        } catch {}
      }
      if (!data || typeof data !== 'object') throw new BackendError(`Claude Code answered no result (exit code ${res.code})${res.stderr ? `: ${clip(res.stderr, 200)}` : ''}`);
      if (data.is_error || (data.subtype && data.subtype !== 'success')) throw new BackendError(`Claude Code failed: ${clip(data.result || data.subtype || 'error', 200)}`);
      return typeof data.result === 'string' ? data.result : '';
    } finally {
      removeDir(dir);
    }
  }
}

// The flags for `codex exec`, checked against codex-cli 0.170.0 (README "Codex").
function codexArgs(config, { dir, last }) {
  const args = [
    'exec',
    '--sandbox',
    'read-only',
    '--skip-git-repo-check',
    '--ephemeral',
    // No config.toml: none of its MCP servers, profiles or approval settings.
    '--ignore-user-config',
    '--ignore-rules',
    '--color',
    'never',
    // The command tool, hooks, plugins, apps and computer control are off.
    '--disable',
    'shell_tool',
    '--disable',
    'hooks',
    '--disable',
    'plugins',
    '--disable',
    'apps',
    '--disable',
    'browser_use',
    '--disable',
    'computer_use',
    '-c',
    'mcp_servers={}',
    '-c',
    'web_search="disabled"',
    '-c',
    'approval_policy="never"',
    '-C',
    dir,
    '--output-last-message',
    last
  ];
  const model = String(config.model || '').trim();
  if (model) args.push('-m', model);
  args.push('-');
  return args;
}

class CodexBackend {
  constructor(config, { hide } = {}) {
    this.config = config;
    this.hide = hide || {};
  }

  exe() {
    const configured = String(this.config.exe || '').trim();
    if (configured) {
      if (!executable(configured)) throw new BackendError(`"exe" is not a program: ${configured}`);
      return configured;
    }
    const candidates = [];
    if (WINDOWS) {
      // The native program inside the global npm package; its codex.cmd shim would need a shell.
      const npm = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'npm', 'node_modules', '@openai', 'codex');
      const triple = process.arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc';
      const pkg = process.arch === 'arm64' ? 'codex-win32-arm64' : 'codex-win32-x64';
      candidates.push(path.join(npm, 'node_modules', '@openai', pkg, 'vendor', triple, 'bin', 'codex.exe'));
    } else {
      candidates.push(path.join(os.homedir(), '.local', 'bin', 'codex'));
    }
    const found = findExe(candidates, 'codex');
    if (!found) throw new BackendError('Codex is not installed: no codex found. Set "exe".');
    return found;
  }

  async run(prompt, { signal } = {}) {
    const exe = this.exe();
    const dir = scratchDir();
    const outDir = scratchDir();
    const last = path.join(outDir, 'answer.txt');
    try {
      const env = childEnv({}, this.hide);
      const res = await runProcess(exe, codexArgs(this.config, { dir, last }), { input: prompt.text, cwd: dir, env, timeout: timeoutMs(this.config), signal });
      if (res.code !== 0) throw new BackendError(`Codex stopped with exit code ${res.code}${res.stderr ? `: ${clip(res.stderr.split(/\r?\n/).filter(Boolean).slice(-3).join(' '), 200)}` : ''}`);
      let text = '';
      try {
        text = fs.readFileSync(last, 'utf8');
      } catch {
        throw new BackendError('Codex wrote no answer');
      }
      return text;
    } finally {
      removeDir(dir);
      removeDir(outDir);
    }
  }
}

// Any program. command: an array (the program and its arguments) or a string (the program), with args.
class CommandBackend {
  constructor(config, { hide } = {}) {
    this.config = config;
    this.hide = hide || {};
    const list = Array.isArray(config.command) ? config.command.map(String) : config.command ? [String(config.command)] : [];
    if (!list.length || !list[0]) throw new BackendError('The command backend needs "command"');
    this.argv = [...list, ...(Array.isArray(config.args) ? config.args.map(String) : [])];
  }

  async run(prompt, { signal } = {}) {
    const [exe, ...args] = this.argv;
    const env = childEnv(this.config.env, this.hide);
    const cwd = this.config.cwd ? String(this.config.cwd) : undefined;
    const res = await runProcess(exe, args, { input: prompt.text, cwd, env, timeout: timeoutMs(this.config), signal });
    if (res.code !== 0) throw new BackendError(`${path.basename(exe)} stopped with exit code ${res.code}${res.stderr ? `: ${clip(res.stderr, 200)}` : ''}`);
    return res.stdout;
  }
}

const TYPES = { runs: RunsBackend, openai: OpenAiBackend, claude: ClaudeBackend, codex: CodexBackend, command: CommandBackend };

// hide: { hideNames, hideValues } that child processes must not get, such as the agent's key.
function makeBackend(config, { hide } = {}) {
  const c = config && typeof config === 'object' ? config : {};
  const Type = TYPES[c.type];
  if (!Type) throw new BackendError(`"backend.type" must be one of ${Object.keys(TYPES).join(', ')}`);
  return new Type(c, { hide });
}

module.exports = {
  makeBackend,
  BackendError,
  RunsBackend,
  OpenAiBackend,
  ClaudeBackend,
  CodexBackend,
  CommandBackend,
  SseParser,
  childEnv,
  claudeArgs,
  codexArgs,
  runProcess,
  findExe,
  TYPES
};
