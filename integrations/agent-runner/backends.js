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
// The most of a server's answer the runner reads: a JSON answer, a streamed answer's text and an SSE line, and the body
// of an error, of which the runner keeps the start.
const JSON_MAX = 4 * 1024 * 1024;
const ANSWER_MAX = STDOUT_MAX;
const SSE_LINE_MAX = 1024 * 1024;
const ERROR_MAX = 64 * 1024;
// After a stop: how long a run's POST may still take to answer its id, and how long the request that stops the run
// may take. Together within the runner's STOP_GRACE (runner.js).
const SUBMIT_GRACE = 1000;
const STOP_REQUEST = 2500;

// A backend that couldn't answer. code says what kind of failure it was, in words the runner defines, for a program
// that shows it in its own words (Rukoo's desktop app): config, offline, timeout, http (with status), protocol,
// too_large, failed (the backend said so), missing, start, exit, empty or stopped. message can quote the backend.
class BackendError extends Error {
  constructor(message, code = 'backend', status = null) {
    super(message);
    this.code = code;
    if (Number.isSafeInteger(status)) this.status = status;
  }
}

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

// The URL of path on a server with an optional path prefix (Hermes serves profiles under /p/<name>/): the url's
// origin, its path and route, without its query, fragment or credentials. Rukoo's desktop app shows what this builds
// before it runs an agent. A path that starts with // would read as another server's name, so it is refused.
function endpoint(base, route) {
  let url;
  try {
    url = new URL(String(base || '').trim());
  } catch {
    // Without the value, which can hold a token.
    throw new BackendError('The backend\'s "url" is not an address', 'config');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new BackendError('The backend\'s "url" must start with http:// or https://', 'config');
  const prefix = url.pathname.replace(/\/+$/, '');
  if (prefix.startsWith('//')) throw new BackendError('The backend\'s "url" has a path that starts with //', 'config');
  const out = new URL(`${url.origin}${prefix}${route}`);
  if (out.origin !== url.origin || !out.pathname.startsWith(`${prefix}/`)) throw new BackendError('Refusing a request outside the backend server', 'config');
  return out;
}

// ---- Server-sent events ----

// `event:`/`data:`/`id:` lines; a blank line ends a frame; lines starting with ':' are comments. The bytes of a line
// and of a frame, its line ends included, are counted as they arrive, before anything is kept or handed on: a line or a
// frame past SSE_LINE_MAX throws (too_large). Lines are split on the bytes CR and LF, which UTF-8 never uses inside a
// character, so a line is decoded once it is whole.
class SseParser {
  constructor(onEvent) {
    this.onEvent = onEvent;
    this.parts = [];
    this.lineBytes = 0;
    this.frameBytes = 0;
    // The last byte was a CR, so an LF right after it ends no other line.
    this.cr = false;
    this.event = '';
    this.data = [];
  }

  count(n) {
    this.lineBytes += n;
    this.frameBytes += n;
    if (this.lineBytes > SSE_LINE_MAX) throw new BackendError('The stream sent a line that is too long', 'too_large');
    if (this.frameBytes > SSE_LINE_MAX) throw new BackendError('The stream sent an event that is too large', 'too_large');
  }

  push(chunk) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    let start = 0;
    for (let i = 0; i < buf.length; i++) {
      const b = buf[i];
      if (b !== 10 && b !== 13) continue;
      if (b === 10 && this.cr && i === start) {
        this.cr = false;
        start = i + 1;
        continue;
      }
      this.count(i - start);
      if (i > start) this.parts.push(Buffer.from(buf.subarray(start, i)));
      // The line end belongs to the frame.
      this.lineBytes = 0;
      this.count(1);
      const text = Buffer.concat(this.parts).toString('utf8');
      this.parts = [];
      this.lineBytes = 0;
      this.cr = b === 13;
      start = i + 1;
      this.line(text);
    }
    if (start < buf.length) {
      this.count(buf.length - start);
      this.parts.push(Buffer.from(buf.subarray(start)));
      this.cr = false;
    }
  }

  line(text) {
    if (text === '') {
      const data = this.data;
      const event = this.event;
      this.event = '';
      this.data = [];
      this.frameBytes = 0;
      if (data.length) this.onEvent({ event: event || 'message', data: data.join('\n') });
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
  } catch (err) {
    // A parser that refused what came, or an answer that broke off: nothing more is read.
    cancel();
    throw err;
  } finally {
    if (signal) signal.removeEventListener('abort', cancel);
  }
}

// An answer's body as text, at most max bytes: { text, over }. over: there was more, which isn't read.
async function readText(res, max) {
  if (!res.body) return { text: '', over: false };
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (size + value.length > max) {
        chunks.push(Buffer.from(value).subarray(0, max - size));
        reader.cancel().catch(() => {});
        return { text: Buffer.concat(chunks).toString('utf8'), over: true };
      }
      size += value.length;
      chunks.push(Buffer.from(value));
    }
  } catch (err) {
    throw new BackendError(`The answer broke off: ${clip(err.message, 200)}`, 'offline');
  }
  return { text: Buffer.concat(chunks).toString('utf8'), over: false };
}

// An answer's JSON body, or null when it isn't JSON; past JSON_MAX a BackendError (too_large).
async function readJson(res) {
  const { text, over } = await readText(res, JSON_MAX);
  if (over) throw new BackendError('The answer was too large', 'too_large');
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

async function errorOf(res) {
  let text = '';
  try {
    text = (await readText(res, ERROR_MAX)).text;
  } catch {}
  let detail = text;
  try {
    const data = JSON.parse(text);
    detail = (data && data.error && (data.error.message || data.error)) || (data && data.message) || text;
  } catch {}
  return new BackendError(`HTTP ${res.status}${detail ? `: ${clip(typeof detail === 'string' ? detail : JSON.stringify(detail), 200)}` : ''}`, 'http', res.status);
}

// ---- runs: Hermes Agent and Booper ----

// One run per trigger, without session_id, so the server starts a session of its own for it. The Idempotency-Key
// names the trigger, so a POST sent again after a lost answer gets the run it already started. Approval requests are
// denied: nobody is there to answer them. A run that takes longer than the timeout is stopped.
class RunsBackend {
  constructor(config) {
    this.config = config;
    if (!config.url) throw new BackendError('The runs backend needs "url"', 'config');
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
    // Stopped before it was sent: no run starts on the server that nobody follows.
    if (deadline.aborted) throw new BackendError('Stopped before the run started', 'stopped');
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
    // A run the server took goes on until it is stopped, and only its id can stop it. So a stop or the timeout while
    // the POST is out gives its answer SUBMIT_GRACE more, and a run id that comes then is stopped below.
    const submit = new AbortController();
    let graceTimer = null;
    const onDeadline = () => {
      graceTimer = setTimeout(() => submit.abort(), SUBMIT_GRACE);
    };
    deadline.addEventListener('abort', onDeadline, { once: true });
    let res;
    let started;
    try {
      try {
        res = await this.call('POST', '/v1/runs', { body, headers: { 'Idempotency-Key': `rukoo-agent-${id}-${digest}` }, signal: submit.signal, timeout: 30000 });
      } catch (err) {
        throw new BackendError(`Could not start a run: ${clip(err.cause ? err.cause.message || err.cause : err.message, 200)}`, deadline.aborted ? 'timeout' : 'offline');
      }
      if (res.status !== 200 && res.status !== 202) throw await errorOf(res);
      started = await readJson(res);
    } finally {
      clearTimeout(graceTimer);
      deadline.removeEventListener('abort', onDeadline);
    }
    const runId = started && started.run_id;
    if (!runId) throw new BackendError('The server did not return a run id', 'protocol');
    try {
      return await this.follow(runId, deadline);
    } catch (err) {
      // Stopped or out of time: the run must not go on where nobody follows it. Within the runner's STOP_GRACE.
      await this.call('POST', `/v1/runs/${encodeURIComponent(runId)}/stop`, { timeout: STOP_REQUEST }).catch(() => {});
      throw err instanceof BackendError ? err : new BackendError(deadline.aborted ? 'The run took longer than the timeout and was stopped' : clip(err.message, 200), deadline.aborted ? 'timeout' : 'failed');
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
      if (kind === 'message.delta' || kind === 'assistant.delta') {
        state.text += typeof d.delta === 'string' ? d.delta : '';
        if (state.text.length > ANSWER_MAX) throw new BackendError('The answer was too large', 'too_large');
      }
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
      if (signal.aborted || (err instanceof BackendError && err.code === 'too_large')) throw err;
    }
    while (!state.end) {
      if (signal.aborted) throw new BackendError('The run took longer than the timeout and was stopped', 'timeout');
      const res = await this.call('GET', `/v1/runs/${encodeURIComponent(runId)}`, { signal }).catch(() => null);
      const d = res && res.ok ? await readJson(res).catch(() => null) : null;
      if (d && d.status === 'completed') state.end = { ok: true, output: d.output || '' };
      else if (d && (d.status === 'failed' || d.status === 'interrupted')) state.end = { ok: false, detail: d.error || d.message || 'The run failed' };
      else if (d && d.status === 'cancelled') state.end = { ok: false, detail: 'The run was cancelled' };
      else if (d && d.status === 'waiting_for_approval') this.deny(runId, null);
      if (!state.end) await sleep(3000, signal);
    }
    if (!state.end.ok) throw new BackendError(clip(typeof state.end.detail === 'string' ? state.end.detail : JSON.stringify(state.end.detail), 200), 'failed');
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
    if (!config.url) throw new BackendError('The openai backend needs "url"', 'config');
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
      throw new BackendError(deadline.aborted ? 'No answer within the timeout' : `No answer from the server: ${clip(err.cause ? err.cause.message || err.cause : err.message, 200)}`, deadline.aborted ? 'timeout' : 'offline');
    }
    if (!res.ok) throw await errorOf(res);
    // A server that ignores stream answers one completion as JSON.
    if (!/text\/event-stream/i.test(res.headers.get('content-type') || '')) {
      const data = await readJson(res);
      const content = data && Array.isArray(data.choices) && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      if (typeof content !== 'string') throw new BackendError('The server answered without a message', 'protocol');
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
      if (state.text.length > ANSWER_MAX) throw new BackendError('The answer was too large', 'too_large');
      if (choice && choice.finish_reason) state.done = true;
    });
    try {
      await readStream(res.body, parser, deadline);
    } catch (err) {
      if (err instanceof BackendError) throw err;
      throw new BackendError(deadline.aborted ? 'The answer took longer than the timeout' : `The connection broke off: ${clip(err.message, 200)}`, deadline.aborted ? 'timeout' : 'offline');
    }
    if (state.error) throw new BackendError(clip(state.error, 200), 'failed');
    if (!state.done) throw new BackendError('The connection closed before the answer was complete', 'protocol');
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

// A program a program that started the runner approved by its full path ("pin": true, as Rukoo's desktop app sets
// it): the runner starts exactly that file, and only while the path is still absolute and canonical (no link, no
// relative part, that file itself) and an executable file. Anything else throws a BackendError with code 'changed'.
function pinned(file) {
  const name = String(file || '');
  let real = null;
  try {
    real = fs.realpathSync.native(name);
  } catch {}
  if (!name || !path.isAbsolute(name) || real !== name || !executable(name)) throw new BackendError('The program changed since it was approved', 'changed');
  return name;
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
      reject(new BackendError(`Could not start ${path.basename(exe)}: ${clip(err.message, 200)}`, 'start'));
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
      reject(new BackendError(e.code === 'ENOENT' ? `${path.basename(exe)} is not installed or not on PATH` : `Could not start ${path.basename(exe)}: ${clip(e.message, 200)}`, e.code === 'ENOENT' ? 'missing' : 'start'));
    });
    let settled = false;
    const finish = (code, sig) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      if (signal) signal.removeEventListener('abort', onAbort);
      if (ended === 'timeout') return reject(new BackendError(`${path.basename(exe)} took longer than ${Math.round(timeout / 1000)} s and was stopped`, 'timeout'));
      if (ended === 'stopped') return reject(new BackendError('Stopped', 'stopped'));
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
    if (this.config.pin === true) return pinned(this.config.exe);
    const configured = String(this.config.exe || '').trim();
    const home = os.homedir();
    const found = configured ? (executable(configured) ? configured : null) : findExe([path.join(home, '.local', 'bin', WINDOWS ? 'claude.exe' : 'claude')], 'claude');
    if (!found) throw new BackendError(configured ? `"exe" is not a program: ${configured}` : 'Claude Code is not installed: no claude on PATH or in ~/.local/bin. Set "exe".', 'missing');
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
      if (!data || typeof data !== 'object') throw new BackendError(`Claude Code answered no result (exit code ${res.code})${res.stderr ? `: ${clip(res.stderr, 200)}` : ''}`, 'exit');
      if (data.is_error || (data.subtype && data.subtype !== 'success')) throw new BackendError(`Claude Code failed: ${clip(data.result || data.subtype || 'error', 200)}`, 'failed');
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
    if (this.config.pin === true) return pinned(this.config.exe);
    const configured = String(this.config.exe || '').trim();
    if (configured) {
      if (!executable(configured)) throw new BackendError(`"exe" is not a program: ${configured}`, 'missing');
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
    if (!found) throw new BackendError('Codex is not installed: no codex found. Set "exe".', 'missing');
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
      if (res.code !== 0) throw new BackendError(`Codex stopped with exit code ${res.code}${res.stderr ? `: ${clip(res.stderr.split(/\r?\n/).filter(Boolean).slice(-3).join(' '), 200)}` : ''}`, 'exit');
      let text = '';
      try {
        text = fs.readFileSync(last, 'utf8');
      } catch {
        throw new BackendError('Codex wrote no answer', 'empty');
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
    if (!list.length || !list[0]) throw new BackendError('The command backend needs "command"', 'config');
    this.argv = [...list, ...(Array.isArray(config.args) ? config.args.map(String) : [])];
  }

  async run(prompt, { signal } = {}) {
    const [exe, ...args] = this.argv;
    const env = childEnv(this.config.env, this.hide);
    const cwd = this.config.cwd ? String(this.config.cwd) : undefined;
    const res = await runProcess(exe, args, { input: prompt.text, cwd, env, timeout: timeoutMs(this.config), signal });
    if (res.code !== 0) throw new BackendError(`${path.basename(exe)} stopped with exit code ${res.code}${res.stderr ? `: ${clip(res.stderr, 200)}` : ''}`, 'exit');
    return res.stdout;
  }
}

// ---- Checks (--check) ----
//
// Whether a backend can answer before the first mention comes, as a list of { level, message, code }: 'error' when it
// can't as configured, 'warn' when the check couldn't tell or something else is worth knowing, 'info' for what was
// found. Each error says what to do next, and its code what kind of problem it is, for a program that shows it in its
// own words (Rukoo's desktop app): missing (the program isn't there), placeholder (my-agent), config (a setting the
// runner can't use), unreachable (nothing answers at its address), backend_key (the server there refused the key, or
// asks for one), key_env (the variable for its secret is empty and the server asks for a key), protocol (an answer of
// another kind, or a route that isn't there), http (another status) or other. The runner's --check prints them and
// exits with 1 for an error; a normal start logs the errors and warnings as warnings and runs anyway, since a server
// can come up later. signal: the runner's stop, which ends a check that still waits.
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

// The most of an answer's body the check reads: a contract's answer is small, and anything larger isn't one.
const CHECK_BODY_MAX = 256 * 1024;

// One request to a backend's route with the headers the runner sends: { status, type, data } for an HTTP answer, with
// the parsed JSON body of a 2xx (data: undefined when it isn't JSON); else { reason } and how it failed: bad (the
// setting isn't an address), timedOut, or stopped (signal).
async function probe(url, route, { headers = {}, timeout = CHECK_TIMEOUT, signal } = {}) {
  let target;
  try {
    target = endpoint(url, route);
  } catch (err) {
    return { reason: err.message, bad: true };
  }
  try {
    // Like the runner's own requests, never a redirect: one shows as its 3xx status.
    const res = await fetch(target, { headers, redirect: 'manual', signal: AbortSignal.any([AbortSignal.timeout(timeout), ...(signal ? [signal] : [])]) });
    const type = String(res.headers.get('content-type') || '').toLowerCase();
    if (res.status < 200 || res.status > 299) {
      res.body?.cancel().catch(() => {});
      return { status: res.status, type };
    }
    const text = await bodyText(res);
    let data;
    try {
      data = text === null ? undefined : JSON.parse(text);
    } catch {
      data = undefined;
    }
    return { status: res.status, type, data };
  } catch (err) {
    if (signal && signal.aborted) return { reason: 'stopped', stopped: true };
    if (err && err.name === 'TimeoutError') return { reason: `no answer within ${Math.round(timeout / 1000)} s`, timedOut: true };
    const code = err && err.cause && err.cause.code;
    return { reason: typeof code === 'string' && /^[A-Z][A-Z0-9_]*$/.test(code) ? code : 'no connection' };
  }
}

// An answer's body as text, or null past CHECK_BODY_MAX.
async function bodyText(res) {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > CHECK_BODY_MAX) {
      reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

// What a 2xx answer was when it isn't the contract's, in the check's words: never the answer's own text.
const answerKind = (p) => (/html/.test(p.type) ? 'an HTML page' : p.data === undefined ? 'an answer that isn\'t JSON' : 'JSON of another shape');

// The routes each HTTP backend's contract has, as Rukoo's own adapters check them (src/main/agents/hermes.js,
// openai.js, openclaw.js), in the order the check asks them. required: the backend can't answer without it; a route
// that isn't required (an OpenAI-compatible server's /v1/models) can be missing or closed while chat works. refused:
// the statuses that mean the key or token was refused. shape(data): whether a 2xx answer is the one the contract
// defines; problem(data): a 2xx in that shape that still says the backend can't answer. The README's "--check" has the
// table of what each answer means.
const RUNS_CONTRACT = {
  what: 'the Hermes or Booper server',
  routes: [
    { route: '/health', required: true, refused: [], shape: isObject, expect: 'a Runs API server\'s health' },
    {
      route: '/v1/capabilities',
      required: true,
      refused: [401, 403],
      shape: (d) => isObject(d) && (d.features === undefined || isObject(d.features)),
      expect: 'a Runs API server\'s capabilities',
      problem: (d) => (d.features && d.features.run_submission === false ? 'it takes no runs (run_submission is off in /v1/capabilities)' : ''),
      missing: 'Check that the address is the Runs API of Hermes Agent or Booper\'s app channel.'
    }
  ]
};
const MODELS = { route: '/v1/models', refused: [401, 403], shape: (d) => isObject(d) && Array.isArray(d.data), expect: 'a list of models' };
const OPENCLAW_CONTRACT = {
  what: 'the OpenClaw gateway',
  routes: [{ ...MODELS, required: true, missing: 'Turn on the gateway\'s Chat Completions endpoint (gateway.http.endpoints.chatCompletions.enabled), or correct the backend\'s "url".' }]
};
const OPENAI_CONTRACT = { what: 'the server', routes: [{ ...MODELS, required: false }] };

// An openai backend for an OpenClaw gateway: its model names an OpenClaw agent, as the config Rukoo gives for OpenClaw
// has it (src/renderer/chat-agents.js), or it sends the gateway's x-openclaw-model header.
function forOpenClaw(config) {
  const headers = isObject(config.headers) ? Object.keys(config.headers) : [];
  return /^openclaw\//i.test(String(config.model || '').trim()) || headers.some((h) => h.toLowerCase() === 'x-openclaw-model');
}

// Whether an HTTP backend can answer, asked of the routes of its contract with the headers its requests carry. One of
// three verdicts: it can (every route answered in its contract's shape: an info line); it can't (nothing at the
// address, a refused key or a missing route the contract requires, any other answer to a required route, or a 2xx
// that isn't the contract's: an error); or the check couldn't tell, only on a route that isn't required (a warning that
// names the route).
async function checkHttp(backend, { env, timeout, signal, headers, contract }) {
  const config = backend.config;
  const url = String(config.url || '').trim();
  const origin = originOf(url);
  const unset = unsetKeyEnv(config, env);
  const unsetWarn = { level: 'warn', message: `${unset} is not set, so the runner sends no key.` };
  const named = typeof config.keyEnv === 'string' && config.keyEnv.trim() ? config.keyEnv.trim() : '"key"';
  const cannot = (message, code) => [{ level: 'error', code, message }];
  const cantTell = (route, why) => [
    { level: 'warn', message: `The check couldn't tell whether ${origin} can answer: ${why} on ${route}, a route a server can chat without. The runner tries anyway, and its log says when a request fails.` },
    ...(unset ? [unsetWarn] : [])
  ];
  for (const [i, r] of contract.routes.entries()) {
    const p = await probe(url, r.route, { headers, timeout, signal });
    if (p.stopped) return [];
    if (p.bad) return cannot(p.reason, 'config');
    if (p.reason) {
      if (i === 0) return cannot(`Nothing answers at ${origin} (${p.reason}). Start ${contract.what} there, or correct the backend's "url".`, 'unreachable');
      return r.required ? cannot(`${origin} doesn't answer ${r.route} (${p.reason}), which ${contract.what} answers.`, 'unreachable') : cantTell(r.route, p.reason);
    }
    if (p.status >= 200 && p.status < 300) {
      if (!r.shape(p.data)) return cannot(`${origin} answered ${r.route} with ${answerKind(p)}, not ${r.expect}. Correct the backend's "url" so it points at ${contract.what}.`, 'protocol');
      const problem = r.problem ? r.problem(p.data) : '';
      if (problem) return cannot(`${origin} can't answer: ${problem}.`, 'other');
      continue;
    }
    const status = `HTTP ${p.status}`;
    if (!r.required) return cantTell(r.route, r.refused.includes(p.status) ? `it refused the key (${status})` : `it answered ${status}`);
    if (r.refused.includes(p.status)) {
      return cannot(
        unset
          ? `${unset} is not set, and ${origin} asks for a key (${status} on ${r.route}). Set it in the terminal or service that starts the runner, then start it again.`
          : secret(config, env)
            ? `${origin} refused the backend's key (${status} on ${r.route}). Check the key or token in ${named}.`
            : `${origin} asks for a key (${status} on ${r.route}). Add "keyEnv" to the backend and set that variable to its key or token.`,
        unset ? 'key_env' : 'backend_key'
      );
    }
    if (p.status === 404) return cannot(`${origin} has no ${r.route} (HTTP 404), which ${contract.what} answers. ${r.missing || 'Correct the backend\'s "url".'}`, 'protocol');
    return cannot(`${origin} answered ${r.route} with ${status}, where ${contract.what} answers 200.`, 'http');
  }
  const out = [{ level: 'info', message: `The backend answers at ${origin}` }];
  if (unset) out.push({ level: 'warn', message: `${unset} is not set, so the runner sends no key. ${origin} answered without one.` });
  return out;
}

RunsBackend.prototype.check = function check({ env = process.env, timeout = CHECK_TIMEOUT, signal } = {}) {
  return checkHttp(this, { env, timeout, signal, headers: this.headers({}, env), contract: RUNS_CONTRACT });
};

OpenAiBackend.prototype.check = function check({ env = process.env, timeout = CHECK_TIMEOUT, signal } = {}) {
  const contract = forOpenClaw(this.config) ? OPENCLAW_CONTRACT : OPENAI_CONTRACT;
  return checkHttp(this, { env, timeout, signal, headers: { Accept: 'application/json', ...this.authHeaders(env) }, contract });
};

// Claude Code and Codex: the program is found where the runner looks for it, and starts without a shell.
async function checkCli() {
  let exe;
  try {
    exe = this.exe();
  } catch (err) {
    return [{ level: 'error', code: err.code === 'changed' ? 'changed' : 'missing', message: err.message }];
  }
  if (needsShell(exe)) return [{ level: 'error', code: 'config', message: `"exe" is ${exe}, a .cmd or .bat file, which the runner can't start: it starts programs without a shell. Set "exe" to the program's .exe.` }];
  return [{ level: 'info', message: `The backend runs ${exe}` }];
}
ClaudeBackend.prototype.check = checkCli;
CodexBackend.prototype.check = checkCli;

CommandBackend.prototype.check = async function check({ env = process.env } = {}) {
  const program = this.argv[0];
  if (program === PLACEHOLDER_COMMAND) {
    return [{ level: 'error', code: 'placeholder', message: `The backend's "command" is still ${PLACEHOLDER_COMMAND}, the placeholder from Rukoo. Put your own program there: it gets the prompt on stdin and answers on stdout. Or pick one of your agents when you copy the config.` }];
  }
  if (needsShell(program)) {
    return [{ level: 'error', code: 'config', message: `The backend's program ${program} is a .cmd or .bat file, which the runner can't start: it starts programs without a shell. ${shellAdvice(program)}` }];
  }
  const cwd = this.config.cwd ? path.resolve(String(this.config.cwd)) : process.cwd();
  const found = findProgram(program, { cwd, env: { ...env, ...(this.config.env || {}) } });
  if (!found) {
    const shim = WINDOWS && !path.extname(program) ? ` ${shellAdvice(`${program}.cmd`)}` : '';
    return [{ level: 'error', code: 'missing', message: `The backend's program ${program} was not found${/[\\/]/.test(program) ? '' : ' on PATH'}. Set "command" to a program on this computer.${shim}` }];
  }
  return [{ level: 'info', message: `The backend runs ${found}` }];
};

const TYPES = { runs: RunsBackend, openai: OpenAiBackend, claude: ClaudeBackend, codex: CodexBackend, command: CommandBackend };

// hide: { hideNames, hideValues } that child processes must not get, such as the agent's key.
function makeBackend(config, { hide } = {}) {
  const c = config && typeof config === 'object' ? config : {};
  const Type = TYPES[c.type];
  if (!Type) throw new BackendError(`"backend.type" must be one of ${Object.keys(TYPES).join(', ')}`, 'config');
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
  readText,
  readJson,
  childEnv,
  claudeArgs,
  codexArgs,
  runProcess,
  findExe,
  findProgram,
  endpoint,
  pinned,
  TYPES
};
