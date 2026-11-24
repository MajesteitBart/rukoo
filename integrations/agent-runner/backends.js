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
    // Without the value, which can hold a token.
    throw new BackendError('The backend\'s "url" is not an address');
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

  // What every request carries; --check sends the same (env: where the key's variable is read).
  headers(extra = {}, env = process.env) {
    const key = secret(this.config, env);
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

  // The key and the config's own headers, which every request carries; --check sends the same.
  authHeaders(env = process.env) {
    const key = secret(this.config, env);
    const extra = this.config.headers && typeof this.config.headers === 'object' ? this.config.headers : {};
    return { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...extra };
  }

  async run(prompt, { id, signal } = {}) {
    const deadline = AbortSignal.any([AbortSignal.timeout(timeoutMs(this.config)), ...(signal ? [signal] : [])]);
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
    let res;
    try {
      res = await fetch(endpoint(this.config.url, '/v1/chat/completions'), {
        method: 'POST',
        headers: { Accept: 'text/event-stream, application/json', 'Content-Type': 'application/json', ...this.authHeaders() },
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

// How long a run may still hold its output pipes after its own process ended, through something it started.
const PIPE_GRACE = 2000;

// Ends a process and what it started: taskkill /T on Windows, the process group elsewhere. Elsewhere the group
// outlives its leader, so it is killed also after the process itself ended: something it started may still run.
// taskkill can't find what an ended process started, so on Windows runProcess closes the pipes instead.
function killTree(child) {
  if (!child || !child.pid) return;
  if (WINDOWS) {
    if (child.exitCode !== null || child.signalCode !== null) return;
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
    let grace = null;
    // The run is over once its process ended and its pipes closed. Something the process started can keep the pipes
    // open after it ended; then the run is over PIPE_GRACE later: what it started is killed and the pipes closed, so a
    // left-behind process can't hold the runner.
    const letGo = () => {
      if (grace) return;
      grace = setTimeout(() => {
        killTree(child);
        for (const stream of [child.stdin, child.stdout, child.stderr]) stream.destroy();
        finish(child.exitCode, child.signalCode);
      }, PIPE_GRACE);
    };
    const stop = (why) => {
      if (ended) return;
      ended = why;
      killTree(child);
      letGo();
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
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      if (signal) signal.removeEventListener('abort', onAbort);
      reject(new BackendError(e.code === 'ENOENT' ? `${path.basename(exe)} is not installed or not on PATH` : `Could not start ${path.basename(exe)}: ${clip(e.message, 200)}`));
    });
    let settled = false;
    const finish = (code, sig) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      if (signal) signal.removeEventListener('abort', onAbort);
      if (ended === 'timeout') return reject(new BackendError(`${path.basename(exe)} took longer than ${Math.round(timeout / 1000)} s and was stopped`));
      if (ended === 'stopped') return reject(new BackendError('Stopped'));
      resolve({ code: code === null ? -1 : code, signal: sig, stdout: Buffer.concat(out).toString('utf8'), stderr: err });
    };
    child.on('exit', letGo);
    child.on('close', finish);
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

// ---- Checks (--check) ----
//
// What a backend needs before the first mention comes, as a list of { level, message }: 'error' when it can't answer
// as configured, 'warn' when the check couldn't tell, 'info' for what was found. Each error says what to do next. The
// runner's --check prints them and exits with 1 for an error; a normal start prints the errors as warnings and runs
// anyway, since a server can come up later. signal: the runner's stop, which ends a check that still waits.
//
// A message names a backend's address by its origin only: a path or query can hold a token. A failed request is said
// in the check's own words (a timeout, or the system's error code), never with the request's error text.

const CHECK_TIMEOUT = 5000;
// The backend command of a config made without one of the person's agents (src/renderer/chat-agents.js).
const PLACEHOLDER_COMMAND = 'my-agent';

// The value of a variable, whatever its case on Windows, where a copy of process.env loses the case-insensitivity.
function envValue(env, name) {
  if (!WINDOWS) return env[name];
  const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
}

// The program spawn() starts for file without a shell: a path, relative to cwd, or a name on PATH. On Windows, as
// libuv does, a name is looked for in cwd first, and one without an extension also as .com and .exe; a .cmd or .bat
// is never started.
function findProgram(file, { cwd = process.cwd(), env = process.env } = {}) {
  const name = String(file || '').trim();
  if (!name) return null;
  const forms = (base) => (WINDOWS && !path.extname(base) ? [base, `${base}.com`, `${base}.exe`] : [base]);
  if (path.isAbsolute(name) || /[\\/]/.test(name)) return forms(path.resolve(cwd, name)).find(executable) || null;
  const dirs = [...(WINDOWS ? [cwd] : []), ...String(envValue(env, 'PATH') || '').split(path.delimiter).filter(Boolean)];
  for (const dir of dirs) {
    const found = forms(path.join(dir, name)).find(executable);
    if (found) return found;
  }
  return null;
}

// A .cmd or .bat file, which Windows starts only through cmd.exe: spawn() without a shell fails on it (EINVAL).
const needsShell = (file) => WINDOWS && /\.(cmd|bat)$/i.test(String(file || '').trim());
// What the runner's README says to do instead.
const shellAdvice = (file) => `On Windows a .cmd or .bat file needs ["cmd", "/c", ${JSON.stringify(String(file))}] as "command".`;

// The address of a backend as messages say it: its origin, or the setting's name when it isn't an address.
function originOf(url) {
  try {
    const u = new URL(String(url || '').trim());
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.origin;
  } catch {}
  return 'the backend\'s "url"';
}

// The variable a backend names for its secret, when it is where the key comes from and isn't set: the runner then
// sends no key, which matters only to a server that asks for one.
function unsetKeyEnv(config, env) {
  if (typeof config.key === 'string' && config.key.trim()) return null;
  const name = typeof config.keyEnv === 'string' ? config.keyEnv.trim() : '';
  return name && !String(envValue(env, name) || '').trim() ? name : null;
}

// One request to a backend's route with the headers the runner sends: { status } for any HTTP answer, else { reason }
// and how it failed: bad (the setting isn't an address), timedOut, or stopped (signal).
async function probe(url, route, { headers = {}, timeout = CHECK_TIMEOUT, signal } = {}) {
  let target;
  try {
    target = endpoint(url, route);
  } catch (err) {
    return { reason: err.message, bad: true };
  }
  try {
    const res = await fetch(target, { headers, redirect: 'manual', signal: AbortSignal.any([AbortSignal.timeout(timeout), ...(signal ? [signal] : [])]) });
    res.body?.cancel().catch(() => {});
    return { status: res.status };
  } catch (err) {
    if (signal && signal.aborted) return { reason: 'stopped', stopped: true };
    if (err && err.name === 'TimeoutError') return { reason: `no answer within ${Math.round(timeout / 1000)} s`, timedOut: true };
    const code = err && err.cause && err.cause.code;
    return { reason: typeof code === 'string' && /^[A-Z][A-Z0-9_]*$/.test(code) ? code : 'no connection' };
  }
}

// The checks of an HTTP backend, with the headers its requests carry. health: a route that says whether the server is
// there; keyed: the route that says whether it takes the runner's requests (the same route, or one that needs the key).
// Three outcomes: it answers (2xx); it doesn't (nothing at the address, or 401: no key or the wrong one); or the check
// can't tell (any other answer, or none in time on the keyed route), which passes with a warning.
async function checkHttp(backend, { env, timeout, signal, headers, health, keyed, what }) {
  const config = backend.config;
  const url = String(config.url || '').trim();
  const origin = originOf(url);
  const unset = unsetKeyEnv(config, env);
  const out = [];
  const first = await probe(url, health, { headers, timeout, signal });
  if (first.stopped) return out;
  if (first.bad) return [{ level: 'error', message: first.reason }];
  if (first.reason) return [{ level: 'error', message: `Nothing answers at ${origin} (${first.reason}). Start ${what} there, or correct the backend's "url".` }];
  const second = keyed === health ? first : await probe(url, keyed, { headers, timeout, signal });
  if (second.stopped) return out;
  if (second.status >= 200 && second.status < 300) {
    out.push({ level: 'info', message: `The backend answers at ${origin}` });
    if (unset) out.push({ level: 'warn', message: `${unset} is not set, so the runner sends no key. ${origin} answered without one.` });
  } else if (second.status === 401) {
    const named = typeof config.keyEnv === 'string' && config.keyEnv.trim() ? config.keyEnv.trim() : '"key"';
    out.push({
      level: 'error',
      message: unset
        ? `${unset} is not set, and ${origin} asks for a key (HTTP 401). Set it in the terminal or service that starts the runner, then start it again.`
        : secret(config, env)
          ? `${origin} refused the backend's key (HTTP 401). Check the key or token in ${named}.`
          : `${origin} asks for a key (HTTP 401). Add "keyEnv" to the backend and set that variable to its key or token.`
    });
  } else {
    const why = second.reason || `HTTP ${second.status} on ${keyed}`;
    out.push({ level: 'warn', message: `The check couldn't tell whether ${origin} takes the runner's requests (${why}). The runner tries anyway, and its log says when a request fails.` });
    if (unset) out.push({ level: 'warn', message: `${unset} is not set, so the runner sends no key.` });
  }
  return out;
}

RunsBackend.prototype.check = function check({ env = process.env, timeout = CHECK_TIMEOUT, signal } = {}) {
  return checkHttp(this, { env, timeout, signal, headers: this.headers({}, env), health: '/health', keyed: '/v1/capabilities', what: 'the Hermes or Booper server' });
};

OpenAiBackend.prototype.check = function check({ env = process.env, timeout = CHECK_TIMEOUT, signal } = {}) {
  return checkHttp(this, { env, timeout, signal, headers: { Accept: 'application/json', ...this.authHeaders(env) }, health: '/v1/models', keyed: '/v1/models', what: 'the server' });
};

// Claude Code and Codex: the program is found where the runner looks for it, and starts without a shell.
async function checkCli() {
  let exe;
  try {
    exe = this.exe();
  } catch (err) {
    return [{ level: 'error', message: err.message }];
  }
  if (needsShell(exe)) return [{ level: 'error', message: `"exe" is ${exe}, a .cmd or .bat file, which the runner can't start: it starts programs without a shell. Set "exe" to the program's .exe.` }];
  return [{ level: 'info', message: `The backend runs ${exe}` }];
}
ClaudeBackend.prototype.check = checkCli;
CodexBackend.prototype.check = checkCli;

CommandBackend.prototype.check = async function check({ env = process.env } = {}) {
  const program = this.argv[0];
  if (program === PLACEHOLDER_COMMAND) {
    return [{ level: 'error', message: `The backend's "command" is still ${PLACEHOLDER_COMMAND}, the placeholder from Rukoo. Put your own program there: it gets the prompt on stdin and answers on stdout. Or pick one of your agents when you copy the config.` }];
  }
  if (needsShell(program)) {
    return [{ level: 'error', message: `The backend's program ${program} is a .cmd or .bat file, which the runner can't start: it starts programs without a shell. ${shellAdvice(program)}` }];
  }
  const cwd = this.config.cwd ? path.resolve(String(this.config.cwd)) : process.cwd();
  const found = findProgram(program, { cwd, env: { ...env, ...(this.config.env || {}) } });
  if (!found) {
    const shim = WINDOWS && !path.extname(program) ? ` ${shellAdvice(`${program}.cmd`)}` : '';
    return [{ level: 'error', message: `The backend's program ${program} was not found${/[\\/]/.test(program) ? '' : ' on PATH'}. Set "command" to a program on this computer.${shim}` }];
  }
  return [{ level: 'info', message: `The backend runs ${found}` }];
};

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
  findProgram,
  TYPES
};
