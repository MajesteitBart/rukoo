'use strict';

// Claude Code, driven as a long-lived `claude -p` process per conversation with stream-json on both
// pipes (see claude-cli research). The process keeps the session warm between turns; it is closed
// after 15 idle minutes and resumed with --resume when the chat continues later.
//
// It loads the user's own settings, MCP servers, skills and hooks on purpose: the point is that the
// agent keeps all its tools. Rukoo only adds its MCP server and the approval prompts.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { AgentError, clip, logger, resolveExe, cleanEnv, start, readJsonLines, tail, killTree, writeJson, WINDOWS, inputFields, echoFree, approvalTitle } = require('./proc');

const IDLE_MS = 15 * 60 * 1000;
const STOP_WAIT = 5000;
// A tool chip waits this long for the tool's input (its preview) before it shows without one.
const INPUT_WAIT = 1500;
const EXE_TTL = 30000;
const DENIED = 'The user denied this in Rukoo.';

const oneLine = (text) => String(text).replace(/\s+/g, ' ').trim();

// The most telling part of a tool's input, for the chip's one-line preview.
function toolDetail(input) {
  if (!input || typeof input !== 'object') return '';
  for (const key of ['command', 'file_path', 'path', 'url', 'query', 'pattern', 'description', 'prompt', 'subject', 'title', 'message_id']) {
    if (typeof input[key] === 'string' && input[key].trim()) return clip(oneLine(input[key]), 200);
  }
  // Rukoo's conversation id says nothing to the user, so it never becomes the preview.
  for (const [key, value] of Object.entries(input)) if (key !== 'conversation_id' && typeof value === 'string' && value.trim()) return clip(oneLine(value), 200);
  return '';
}

// What a built-in tool does, for the approval card's title. MCP tools are mcp__<server>__<tool>.
const KINDS = {
  Bash: 'command',
  PowerShell: 'command',
  Read: 'readFile',
  NotebookRead: 'readFile',
  Grep: 'readFile',
  Glob: 'readFile',
  LS: 'readFile',
  Write: 'changeFiles',
  Edit: 'changeFiles',
  MultiEdit: 'changeFiles',
  NotebookEdit: 'changeFiles',
  WebFetch: 'web',
  WebSearch: 'web'
};

function toolKind(name) {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  if (mcp) return { name, kind: 'mcp', server: mcp[1], tool: mcp[2] };
  return { name, kind: KINDS[name] || 'other' };
}

// Approval card fields: every input in full (Write's content, Edit's old and new text included), the
// command, file or URL first. The model's description of a command is the card's detail line already.
function approvalFields(input, description = '') {
  const skip = description && input && input.description === description ? ['description'] : [];
  return inputFields(input, { lead: ['command', 'file_path', 'notebook_path', 'url', 'query', 'pattern', 'path'], skip });
}

function resultError(msg, stderr) {
  const errors = Array.isArray(msg.errors) ? msg.errors.map((e) => (typeof e === 'string' ? e : e && e.message) || '').filter(Boolean) : [];
  const detail = clip(oneLine((typeof msg.result === 'string' && msg.result) || errors.join('; ') || stderr || msg.subtype || 'Claude Code reported an error'), 200);
  const status = Number(msg.api_error_status) || 0;
  if (status === 429 || /rate.?limit|usage limit|overloaded/i.test(detail)) return { code: 'rate-limited', detail };
  if (status === 401 || status === 403 || /\/login|not logged in|authenticat|invalid api key/i.test(detail)) return { code: 'unauthorized', detail };
  return { code: 'unknown', detail };
}

class ClaudeAdapter {
  // launchArgs: tests run a fake CLI script through node (process.execPath + script).
  constructor({ id = 'claude', config, hub, log, paths, launchArgs = [] } = {}) {
    this.id = id;
    this.config = typeof config === 'function' ? config : () => config || {};
    this.hub = hub || null;
    this.log = logger(log);
    this.paths = paths || {};
    this.launchArgs = launchArgs;
    // conversation id → Session (one claude process each)
    this.sessions = new Map();
    // conversation id → promise that settles when its closed process has exited
    this.exiting = new Map();
    this.exeCache = null;
    this.versions = new Map();
    this.rateLimit = null;
  }

  settings() {
    const c = this.config() || {};
    return {
      enabled: c.enabled !== false,
      exe: String(c.exe || '').trim(),
      configDir: String(c.configDir || '').trim(),
      model: String(c.model || '').trim(),
      access: c.access === 'full' ? 'full' : 'ask'
    };
  }

  // config.exe, else the native installer's location, else the first claude.exe on PATH.
  async exe() {
    const { exe } = this.settings();
    if (this.exeCache && this.exeCache.configured === exe && Date.now() - this.exeCache.at < EXE_TTL) return this.exeCache.value;
    const home = os.homedir();
    const candidates = exe ? [exe] : [path.join(home, '.local', 'bin', WINDOWS ? 'claude.exe' : 'claude')];
    // A configured path that does not exist is a mistake to report, not a reason to run another copy.
    const value = await resolveExe(candidates, exe ? null : WINDOWS ? 'claude.exe' : 'claude');
    this.exeCache = { configured: exe, at: Date.now(), value };
    return value;
  }

  version(exe) {
    if (this.versions.has(exe)) return this.versions.get(exe);
    const promise = new Promise((resolve) => {
      execFile(exe, ['--version'], { windowsHide: true, timeout: 10000, env: cleanEnv() }, (err, stdout) => {
        const match = !err && String(stdout).match(/\d+\.\d+\.\d+/);
        resolve(match ? match[0] : '');
      });
    });
    this.versions.set(exe, promise);
    return promise;
  }

  invalidate() {
    this.exeCache = null;
  }

  // For the settings placeholder: the program Rukoo would run when no path is set.
  defaultExe() {
    if (this.exeCache && !this.exeCache.configured && this.exeCache.value) return this.exeCache.value;
    const file = path.join(os.homedir(), '.local', 'bin', WINDOWS ? 'claude.exe' : 'claude');
    return fs.existsSync(file) ? file : '';
  }

  // Settings changed: idle processes still run with the old ones, so close them (the next turn resumes).
  configChanged() {
    this.invalidate();
    const now = JSON.stringify(this.settings());
    if (this.lastSettings === now) return;
    this.lastSettings = now;
    for (const session of [...this.sessions.values()]) if (!session.current) this.closeSession(session);
  }

  async status({ force = false } = {}) {
    if (force) this.invalidate();
    const s = this.settings();
    if (!s.enabled) return { state: 'disabled', detail: '' };
    const exe = await this.exe();
    if (!exe) return { state: 'missing', detail: s.exe ? `Not found: ${clip(s.exe, 150)}` : 'Claude Code is not installed' };
    const version = await this.version(exe);
    const limit = this.rateLimit && this.rateLimit.status && this.rateLimit.status !== 'allowed' ? ` (${this.rateLimit.status})` : '';
    return { state: 'ready', detail: (version ? `Claude Code ${version}` : 'Claude Code') + limit };
  }

  workspace() {
    const dir = this.paths.workspace || path.join(os.tmpdir(), 'rukoo-agent-workspace');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  // In its long form: os.tmpdir() can be an 8.3 path (C:\Users\BARTAD~1\...), and Claude Code does not
  // match a file it reads against an --add-dir written that way, so every attachment would prompt.
  attachmentsDir() {
    const dir = this.paths.attachments;
    if (!dir) return null;
    fs.mkdirSync(dir, { recursive: true });
    try {
      return fs.realpathSync.native(dir);
    } catch {
      return dir;
    }
  }

  async runTurn(turn) {
    try {
      return await this.turn(turn);
    } catch (err) {
      const e = err instanceof AgentError ? err : new AgentError('unknown', clip(err && err.message, 200));
      if (!(err instanceof AgentError)) this.log('claude: turn failed', err);
      return { status: 'error', error: { code: e.code, detail: e.detail } };
    }
  }

  async turn(turn, fresh = false) {
    const s = this.settings();
    if (!s.enabled) throw new AgentError('disabled', 'Claude Code is turned off');
    const exe = await this.exe();
    if (!exe) throw new AgentError('not-installed', s.exe ? `Not found: ${clip(s.exe, 150)}` : 'Claude Code is not installed');
    if (turn.signal && turn.signal.aborted) return { status: 'stopped' };
    const cid = turn.conversation.id;
    const key = crypto
      .createHash('sha256')
      .update(JSON.stringify([exe, s.configDir, s.model, s.access, turn.mcp && turn.mcp.url, turn.mcp && turn.mcp.token, turn.instructions]))
      .digest('hex');
    let session = this.sessions.get(cid);
    // Settings, the MCP endpoint and the instructions are fixed at spawn: a change means a new process.
    // A process still busy with a turn the hub gave up on would answer this turn with the old one's
    // output, so it goes too.
    if (session && (session.key !== key || session.exited || session.current)) {
      this.closeSession(session);
      session = null;
    }
    if (!session) {
      // A process for this chat that is still shutting down would hold the session: let it go first.
      const old = this.exiting.get(cid);
      if (old) await Promise.race([old, new Promise((r) => setTimeout(r, STOP_WAIT))]);
      // Stop can land during that wait; an abort that already fired never reaches a later listener.
      if (turn.signal && turn.signal.aborted) return { status: 'stopped' };
      session = this.spawn(turn, exe, s, key, fresh);
    }
    const outcome = await session.run(turn);
    if (outcome.lostSession && !fresh) {
      // The CLI no longer has this session (its transcript was deleted): start a fresh one.
      this.closeSession(session);
      turn.emit({ type: 'notice', tone: 'info', code: 'new-session', text: 'Claude started a new session' });
      return this.turn(turn, true);
    }
    return outcome.result;
  }

  spawn(turn, exe, s, key, fresh) {
    const known = !fresh && turn.conversation.provider && turn.conversation.provider.sessionId;
    const sessionId = known || crypto.randomUUID();
    const url = turn.mcp && turn.mcp.url;
    const mcp = {
      mcpServers: {
        rukoo: {
          type: 'http',
          url,
          headers: { Authorization: `Bearer ${turn.mcp && turn.mcp.token}` },
          alwaysLoad: true,
          timeout: 120000
        }
      }
    };
    // `--opt=value` where the value is free text: a title or prompt starting with '-' must not read as a flag.
    const args = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      // Without a URL Rukoo's MCP server is not running: the chat still works, without Rukoo's tools.
      ...(url ? ['--mcp-config', JSON.stringify(mcp), '--allowedTools', 'mcp__rukoo'] : []),
      `--append-system-prompt=${turn.instructions || ''}`,
      `--name=${clip(oneLine(turn.conversation.title || 'Rukoo chat'), 80)}`,
      '--thinking', 'adaptive',
      '--thinking-display', 'summarized',
      '--settings', JSON.stringify({ showThinkingSummaries: true }),
      known ? `--resume=${sessionId}` : `--session-id=${sessionId}`,
      '--permission-prompt-tool', 'stdio'
    ];
    // read_attachment saves files there for Claude to open; reading what Rukoo handed over needs no prompt.
    const attachments = this.attachmentsDir();
    if (attachments) args.push('--add-dir', attachments);
    if (s.model) args.push(`--model=${s.model}`);
    // "Ask" is explicit, so a defaultMode in the user's settings cannot quietly turn the prompts off.
    if (s.access === 'full') args.push('--permission-mode', 'bypassPermissions', '--allow-dangerously-skip-permissions');
    else args.push('--permission-mode', 'default');
    const env = cleanEnv(s.configDir ? { CLAUDE_CONFIG_DIR: s.configDir } : {});
    const session = new Session(this, { cid: turn.conversation.id, key, sessionId, resumed: Boolean(known) });
    session.start(exe, [...this.launchArgs, ...args], { cwd: this.workspace(), env });
    this.sessions.set(session.cid, session);
    return session;
  }

  closeSession(session, { sync = false } = {}) {
    if (this.sessions.get(session.cid) === session) this.sessions.delete(session.cid);
    if (session.child && !session.exited && !sync) {
      const gone = new Promise((resolve) => session.child.once('exit', resolve));
      this.exiting.set(session.cid, gone);
      gone.then(() => {
        if (this.exiting.get(session.cid) === gone) this.exiting.delete(session.cid);
      });
    }
    session.close({ sync });
  }

  // The hub calls this when a conversation is removed. The transcript stays with Claude Code.
  forget(conversation) {
    const session = conversation && this.sessions.get(conversation.id);
    if (session) this.closeSession(session);
  }

  async dispose() {
    for (const session of [...this.sessions.values()]) this.closeSession(session, { sync: true });
  }
}

// One claude process and the turn it is running.
class Session {
  constructor(adapter, { cid, key, sessionId, resumed }) {
    this.adapter = adapter;
    this.log = adapter.log;
    this.cid = cid;
    this.key = key;
    this.sessionId = sessionId;
    this.resumed = resumed;
    this.child = null;
    this.exited = false;
    this.current = null;
    this.idleTimer = null;
    this.stderr = null;
  }

  start(exe, args, options) {
    let child;
    try {
      child = start(exe, args, options);
    } catch (err) {
      this.exited = true;
      throw new AgentError(err.code === 'ENOENT' ? 'not-installed' : 'spawn-failed', clip(err.message, 200));
    }
    this.child = child;
    this.stderr = tail(child.stderr);
    child.stdout.on('error', () => {});
    readJsonLines(child.stdout, (msg) => this.onMessage(msg), (line) => this.log(`claude: ${clip(line, 200)}`));
    child.on('error', (err) => {
      this.spawnError = err;
      this.onExit(null, null);
    });
    child.on('exit', (code, signal) => this.onExit(code, signal));
  }

  run(turn) {
    clearTimeout(this.idleTimer);
    return new Promise((resolve) => {
      const t = {
        turn,
        resolve,
        blocks: {},
        open: new Set(),
        waiting: new Map(),
        late: new Map(),
        textSeen: new Set(),
        approvals: new Map(),
        stopping: false,
        stopTimer: null,
        message: null
      };
      this.current = t;
      t.onAbort = () => this.stop(t);
      if (turn.signal) turn.signal.addEventListener('abort', t.onAbort, { once: true });
      if (this.exited) return this.onExit(this.child && this.child.exitCode, null);
      if (turn.signal && turn.signal.aborted) return this.finish({ result: { status: 'stopped' } });
      const ok = writeJson(this.child, {
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: turn.input }] },
        parent_tool_use_id: null,
        session_id: ''
      });
      if (!ok) this.finish({ result: { status: 'error', error: { code: 'spawn-failed', detail: 'Claude Code is not accepting input' } } });
    });
  }

  finish(outcome) {
    const t = this.current;
    if (!t) return;
    this.current = null;
    clearTimeout(t.stopTimer);
    if (t.turn.signal) t.turn.signal.removeEventListener('abort', t.onAbort);
    for (const w of t.waiting.values()) clearTimeout(w.timer);
    for (const key of t.open) t.turn.emit({ type: 'tool-end', key, error: false });
    t.resolve(outcome);
    if (!this.exited) {
      clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(() => this.adapter.closeSession(this), IDLE_MS);
      this.idleTimer.unref?.();
    }
  }

  stop(t) {
    if (t !== this.current || t.stopping) return;
    t.stopping = true;
    writeJson(this.child, { type: 'control_request', request_id: crypto.randomUUID(), request: { subtype: 'interrupt' } });
    // An interrupt normally lands within milliseconds; a stuck process (or hook) gets killed.
    t.stopTimer = setTimeout(() => {
      if (this.current !== t) return;
      this.adapter.closeSession(this);
      this.finish({ result: { status: 'stopped' } });
    }, STOP_WAIT);
  }

  close({ sync = false } = {}) {
    clearTimeout(this.idleTimer);
    if (!this.child || this.exited) return;
    this.closing = true;
    if (sync || this.current) return killTree(this.child, { sync });
    // Idle: let it exit on its own once stdin closes, and make sure after a few seconds.
    try {
      this.child.stdin.end();
    } catch {}
    const timer = setTimeout(() => killTree(this.child), 5000);
    timer.unref?.();
    this.child.once('exit', () => clearTimeout(timer));
  }

  onExit(code, signal) {
    if (this.exited && !this.current) return;
    this.exited = true;
    clearTimeout(this.idleTimer);
    if (this.adapter.sessions.get(this.cid) === this) this.adapter.sessions.delete(this.cid);
    const t = this.current;
    if (!t) return;
    const stderr = this.stderr ? this.stderr.lines.join('\n') : '';
    if (/No conversation found with session ID/i.test(stderr)) return this.finish({ lostSession: true });
    if (t.stopping || this.closing) return this.finish({ result: { status: 'stopped' } });
    const err = this.spawnError;
    if (err && err.code === 'ENOENT') return this.finish({ result: { status: 'error', error: { code: 'not-installed', detail: clip(err.message, 200) } } });
    const last = this.stderr ? this.stderr.last() : '';
    const detail = clip(last || (err && err.message) || `Claude Code exited (${signal || code})`, 200);
    this.finish({ result: { status: 'error', error: { code: this.initSeen ? 'protocol' : 'spawn-failed', detail } } });
  }

  onMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    try {
      this.handle(msg);
    } catch (err) {
      this.log(`claude: could not handle ${msg.type}`, err);
    }
  }

  handle(msg) {
    const t = this.current;
    switch (msg.type) {
      case 'system':
        if (msg.subtype === 'init') {
          this.initSeen = true;
          if (msg.session_id && t && !this.persisted) {
            this.persisted = true;
            this.sessionId = msg.session_id;
            t.turn.setProvider({ sessionId: msg.session_id });
          }
          const rukoo = Array.isArray(msg.mcp_servers) && msg.mcp_servers.find((m) => m.name === 'rukoo');
          if (rukoo && rukoo.status === 'failed') this.log('claude: the rukoo MCP server failed to connect');
        }
        return;
      case 'rate_limit_event':
        this.adapter.rateLimit = msg.rate_limit_info || null;
        return;
      case 'stream_event':
        if (t && !msg.parent_tool_use_id) this.onStream(t, msg.event || {});
        return;
      case 'assistant':
        if (t && !msg.parent_tool_use_id) this.onAssistant(t, msg.message || {});
        return;
      case 'user':
        if (t && !msg.parent_tool_use_id) this.onToolResults(t, msg.message || {});
        return;
      case 'result':
        if (t) this.onResult(t, msg);
        return;
      case 'control_request':
        this.onControl(t, msg);
        return;
      case 'control_cancel_request':
        this.onCancel(t, msg.request_id);
        return;
      default:
        return;
    }
  }

  onStream(t, ev) {
    const emit = (e) => t.turn.emit(e);
    switch (ev.type) {
      case 'message_start':
        t.blocks = {};
        t.message = (ev.message && ev.message.id) || null;
        return;
      case 'content_block_start': {
        const block = ev.content_block || {};
        t.blocks[ev.index] = { type: block.type, id: block.id };
        if (block.type === 'thinking' || block.type === 'redacted_thinking') emit({ type: 'thinking', delta: '' });
        else if (block.type === 'tool_use' || block.type === 'server_tool_use' || block.type === 'mcp_tool_use') {
          // Its input (the chip's preview) streams in after this; give it a moment before showing the chip.
          if (block.id && !t.open.has(block.id) && !t.waiting.has(block.id)) {
            const timer = setTimeout(() => this.startTool(t, block.id, block.name, ''), INPUT_WAIT);
            t.waiting.set(block.id, { name: block.name || 'tool', timer });
          }
        } else if (block.tool_use_id && /_tool_result$/.test(block.type || '')) {
          // Server-side tools (web search) report their result inside the assistant message.
          this.endTool(t, block.tool_use_id, Boolean(block.is_error));
        }
        return;
      }
      case 'content_block_delta': {
        const delta = ev.delta || {};
        if (delta.type === 'text_delta' && delta.text) {
          if (t.message) t.textSeen.add(t.message);
          emit({ type: 'text', delta: delta.text });
        } else if (delta.type === 'thinking_delta' && delta.thinking) {
          emit({ type: 'thinking', delta: delta.thinking });
        }
        return;
      }
      case 'content_block_stop': {
        const block = t.blocks[ev.index];
        if (block && (block.type === 'thinking' || block.type === 'redacted_thinking')) emit({ type: 'thinking-done' });
        return;
      }
      default:
        return;
    }
  }

  // The complete message: tool inputs are only known here.
  onAssistant(t, message) {
    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (block.type === 'tool_use' || block.type === 'server_tool_use' || block.type === 'mcp_tool_use') {
        if (!block.id) continue;
        const detail = toolDetail(block.input);
        // A chip that is already showing gets its preview with the end event.
        if (t.open.has(block.id)) t.late.set(block.id, detail);
        else this.startTool(t, block.id, block.name, detail);
      } else if (block.type === 'text' && block.text && message.id && !t.textSeen.has(message.id)) {
        // Partial messages were not streamed for this one; show the text whole.
        t.textSeen.add(message.id);
        t.turn.emit({ type: 'text', delta: block.text });
      }
    }
  }

  onToolResults(t, message) {
    if (!Array.isArray(message.content)) return;
    for (const block of message.content) {
      if (block && block.type === 'tool_result' && block.tool_use_id) this.endTool(t, block.tool_use_id, Boolean(block.is_error));
    }
  }

  startTool(t, key, name, detail) {
    const waiting = t.waiting.get(key);
    if (waiting) clearTimeout(waiting.timer);
    t.waiting.delete(key);
    if (t.open.has(key) || this.current !== t) return;
    t.open.add(key);
    t.turn.emit({ type: 'tool-start', key, name: name || (waiting && waiting.name) || 'tool', detail });
  }

  endTool(t, key, error) {
    if (t.waiting.has(key)) this.startTool(t, key, null, '');
    if (!t.open.has(key)) return;
    t.open.delete(key);
    const end = { type: 'tool-end', key, error };
    if (t.late.get(key)) end.detail = t.late.get(key);
    t.turn.emit(end);
  }

  onResult(t, msg) {
    if (typeof msg.total_cost_usd === 'number' || msg.usage) t.turn.emit({ type: 'usage', costUsd: msg.total_cost_usd, usage: msg.usage });
    const stderr = this.stderr ? this.stderr.lines.join('\n') : '';
    if (msg.subtype === 'success' && !msg.is_error) return this.finish({ result: { status: 'done' } });
    if (/^aborted/.test(String(msg.terminal_reason || '')) || (t.stopping && msg.subtype === 'error_during_execution')) {
      return this.finish({ result: { status: 'stopped' } });
    }
    const errors = JSON.stringify(msg.errors || '');
    if (msg.num_turns === 0 && /No conversation found/i.test(errors + stderr)) return this.finish({ lostSession: true });
    const error = resultError(msg, this.stderr && this.stderr.last());
    t.turn.emit({ type: 'error', code: error.code, detail: error.detail });
    this.finish({ result: { status: 'error', error } });
  }

  respond(requestId, response) {
    writeJson(this.child, { type: 'control_response', response: { subtype: 'success', request_id: requestId, response } });
  }

  onControl(t, msg) {
    const request = msg.request || {};
    const requestId = msg.request_id;
    if (request.subtype !== 'can_use_tool') {
      writeJson(this.child, { type: 'control_response', response: { subtype: 'error', request_id: requestId, error: `Rukoo does not support ${request.subtype}` } });
      return;
    }
    if (!t) return this.respond(requestId, { behavior: 'deny', message: DENIED });
    const tool = toolKind(String(request.tool_name || 'tool'));
    const description = typeof request.description === 'string' ? request.description : '';
    const fields = approvalFields(request.input, description);
    const promise = t.turn.approve({
      title: approvalTitle('Claude', tool, request.display_name || request.tool_name),
      detail: clip(echoFree(description, fields), 2000),
      fields,
      tool,
      choices: [
        { id: 'allow', label: 'Allow', kind: 'primary' },
        { id: 'deny', label: 'Deny', kind: 'danger' }
      ],
      key: requestId
    });
    const pending = { promise, cancelled: false };
    t.approvals.set(requestId, pending);
    Promise.resolve(promise)
      .catch(() => 'cancel')
      .then((choice) => {
        t.approvals.delete(requestId);
        if (pending.cancelled || this.exited) return;
        if (choice === 'allow') this.respond(requestId, { behavior: 'allow', updatedInput: request.input || {} });
        else this.respond(requestId, { behavior: 'deny', message: DENIED });
      });
  }

  // The CLI withdrew a permission request (an interrupt): take the card off the screen.
  onCancel(t, requestId) {
    const pending = t && t.approvals.get(requestId);
    if (!pending) return;
    pending.cancelled = true;
    const itemId = (pending.promise && pending.promise.itemId) || requestId;
    const hub = this.adapter.hub;
    if (hub && typeof hub.expireApproval === 'function') hub.expireApproval(this.cid, itemId);
  }
}

module.exports = { ClaudeAdapter, toolDetail, approvalFields, toolKind };
