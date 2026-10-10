'use strict';

// Codex, driven through `codex app-server`: one long-lived process for every Codex conversation,
// JSON lines on stdio, one Codex thread per conversation (see codex-cli research). Rukoo's MCP server
// is injected per thread, with the token in the process environment so it never lands in a thread's
// rollout file. The user's own MCP servers, skills and AGENTS.md stay on: they are the user's tools.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { untag } = require('./context');
const { AgentError, clip, logger, resolveExe, cleanEnv, start, readJsonLines, tail, killTree, writeJson, WINDOWS, humanize, fieldText, inputField, approvalTitle } = require('./proc');

const EXE_TTL = 30000;
const STOP_WAIT = 10000;
// How long turn/start may take to answer before the turn counts as lost.
const START_WAIT = 30000;
// A turn that needs a restarted app-server waits this long at most for the other Codex turns to finish.
const IDLE_WAIT_MS = 10 * 60 * 1000;
const ESCALATE =
  'When the sandbox blocks a command you need (writing files, network access), request escalated permissions so the user can approve it in Rukoo.';

let appVersion = '0.0.0';
try {
  appVersion = require('../../../package.json').version || appVersion;
} catch {}

const oneLine = (text) => String(text == null ? '' : text).replace(/\s+/g, ' ').trim();

// The script inside the wrapper, unquoted only when it is exactly one quoted string: the approval card
// shows this, so `'a' ; 'b'` must not turn into something that reads differently from what runs.
function unquote(inner, powershell) {
  let m;
  if (powershell) {
    if ((m = /^'((?:[^']|'')*)'$/.exec(inner))) return m[1].replace(/''/g, "'");
    if ((m = /^"((?:[^"`]|""|`[\s\S])*)"$/.exec(inner))) return m[1].replace(/""|`"/g, '"');
  } else {
    if ((m = /^'((?:[^']|'\\'')*)'$/.exec(inner))) return m[1].replace(/'\\''/g, "'");
    if ((m = /^"((?:[^"\\]|\\[\s\S])*)"$/.exec(inner))) return m[1].replace(/\\(["\\$`])/g, '$1');
  }
  return inner;
}

// Codex runs commands as `"…\powershell.exe" -Command '<cmd>'` (or `bash -lc '<cmd>'`); show <cmd>.
function stripShell(command) {
  const c = String(command || '').trim();
  const ps = c.match(/^(?:"[^"]*?(?:powershell|pwsh)(?:\.exe)?"|\S*?(?:powershell|pwsh)(?:\.exe)?)\s+(?:-(?:NoProfile|NoLogo|NonInteractive)\s+)*-(?:Command|c)\s+([\s\S]+)$/i);
  const sh = !ps && c.match(/^(?:\S*\/)?(?:bash|sh|zsh)\s+-l?c\s+([\s\S]+)$/);
  if (!ps && !sh) return c;
  return unquote((ps || sh)[1].trim(), Boolean(ps));
}

function commandText(actions, command) {
  const parsed = (Array.isArray(actions) ? actions : []).map((a) => a && a.command).filter(Boolean);
  return parsed.length ? parsed.join('; ') : stripShell(command);
}

function argDetail(args) {
  if (!args || typeof args !== 'object') return typeof args === 'string' ? clip(oneLine(untag(args)), 200) : '';
  for (const key of ['query', 'message_id', 'command', 'path', 'url', 'title', 'subject']) {
    if (typeof args[key] === 'string' && args[key].trim()) return clip(oneLine(untag(args[key])), 200);
  }
  // Rukoo's conversation id says nothing to the user, so it never becomes the preview.
  for (const [key, value] of Object.entries(args)) if (key !== 'conversation_id' && typeof value === 'string' && value.trim()) return clip(oneLine(untag(value)), 200);
  return '';
}

const changePaths = (item) => (Array.isArray(item.changes) ? item.changes.map((c) => c && c.path).filter(Boolean) : []);

// A fileChange entry: {path, kind:{type:'add'|'delete'|'update', move_path?}, diff}.
const changeName = (c) => (c.kind && c.kind.move_path ? `${c.path} → ${c.kind.move_path}` : String(c.path));
const VERBS = { add: 'Add', delete: 'Delete', update: 'Update' };

// Every change's diff for the approval card. A header (apply_patch's own wording) names the file when
// there is more than one, or when the file is new or goes away.
function patchText(changes) {
  if (!changes.some((c) => typeof c.diff === 'string' && c.diff)) return '';
  return changes
    .map((c) => {
      const type = (c.kind && c.kind.type) || 'update';
      const diff = typeof c.diff === 'string' ? c.diff.replace(/\n+$/, '') : '';
      if (changes.length === 1 && type === 'update') return diff;
      return `*** ${VERBS[type] || 'Update'} File: ${changeName(c)}` + (diff ? `\n${diff}` : '');
    })
    .join('\n');
}

// Thread items that become tool chips: name for the hub's labels, and the one-line preview.
function toolOf(item) {
  switch (item.type) {
    case 'commandExecution':
      return { name: 'shell', detail: clip(oneLine(commandText(item.commandActions, item.command)), 200) };
    case 'mcpToolCall':
      return { name: `mcp__${item.server}__${item.tool}`, detail: argDetail(item.arguments) };
    case 'webSearch': {
      const action = item.action || {};
      return { name: 'web_search', detail: clip(oneLine(item.query || action.query || action.url || ''), 200) };
    }
    case 'fileChange':
      return { name: 'apply_patch', detail: clip(changePaths(item).join(', '), 200) };
    case 'dynamicToolCall':
      return { name: item.namespace ? `${item.namespace}__${item.tool}` : String(item.tool || 'tool'), detail: argDetail(item.arguments) };
    case 'collabAgentToolCall':
      return { name: 'subagent', detail: clip(oneLine(item.prompt || item.tool || ''), 200) };
    case 'subAgentActivity':
      return { name: 'subagent', detail: clip(oneLine(item.agentPath || item.kind || ''), 200) };
    case 'imageGeneration':
      return { name: 'image_generation', detail: '' };
    default:
      return null;
  }
}

function toolFailed(item) {
  if (item.type === 'dynamicToolCall' && item.success === false) return true;
  if (item.type === 'mcpToolCall' && item.error) return true;
  return item.status === 'failed' || item.status === 'declined';
}

function turnError(error) {
  const info = error && error.codexErrorInfo;
  const kind = typeof info === 'string' ? info : info && typeof info === 'object' ? Object.keys(info)[0] : '';
  const detail = clip(oneLine((error && error.message) || kind || 'Codex reported an error'), 200);
  if (kind === 'usageLimitExceeded' || kind === 'rateLimitExceeded' || kind === 'serverOverloaded') return { code: 'rate-limited', detail };
  if (kind === 'unauthorized') return { code: 'unauthorized', detail };
  if (/ConnectionFailed|Disconnected|TooManyFailedAttempts/.test(kind)) return { code: 'offline', detail };
  return { code: 'unknown', detail };
}

// The turn's text, then each image the user attached that goes along with the message: Codex reads a local image
// itself. Codex takes no other files as input; they are in its working folder, and the text says where.
function turnInput(turn) {
  const input = [{ type: 'text', text: turn.input, text_elements: [] }];
  for (const f of Array.isArray(turn.files) ? turn.files : []) {
    if (f.kind === 'image' && f.inline && f.path) input.push({ type: 'localImage', path: f.path });
  }
  return input;
}

// Card choice → app-server decision. 'cancel' is what the hub resolves when the turn stopped.
const decision = (choice) => ({ decision: choice === 'accept' || choice === 'acceptForSession' || choice === 'cancel' ? choice : 'decline' });

const APPROVE_CHOICES = [
  { id: 'accept', label: 'Allow', kind: 'primary' },
  { id: 'acceptForSession', label: 'Allow for this chat', kind: 'default' },
  { id: 'decline', label: 'Deny', kind: 'danger' }
];

class CodexAdapter {
  // launchArgs: tests run a fake app-server script through node (process.execPath + script).
  // stopWait: how long a stopped turn gets to end before the app-server is killed; startWait: how long turn/start
  // may take to answer (tests shorten both).
  constructor({ id = 'codex', config, hub, log, paths, launchArgs = [], stopWait = STOP_WAIT, startWait = START_WAIT } = {}) {
    this.id = id;
    this.config = typeof config === 'function' ? config : () => config || {};
    this.hub = hub || null;
    this.log = logger(log);
    this.paths = paths || {};
    this.launchArgs = launchArgs;
    this.stopWait = stopWait;
    this.startWait = startWait;
    this.server = null;
    this.starting = null;
    this.exeCache = null;
    this.versions = new Map();
    // thread id → Run, for routing notifications and server requests
    this.runs = new Map();
    // Turns past ensureServer: while any is in flight, the app-server must not be swapped out.
    this.busy = 0;
  }

  settings() {
    const c = this.config() || {};
    return {
      enabled: c.enabled !== false,
      exe: String(c.exe || '').trim(),
      model: String(c.model || '').trim(),
      access: c.access === 'full' ? 'full' : 'ask'
    };
  }

  // The settings with the chat's own model and effort; without them the chat follows the settings. The hub only
  // passes an effort that model/list says the model supports.
  withChoice(s, turn) {
    return { ...s, model: String((turn && turn.model) || '').trim() || s.model, effort: String((turn && turn.effort) || '').trim() };
  }

  // The models app-server offers (model/list), each with the efforts it supports. The list needs a running
  // app-server: the one the chats use, started now if there is none yet.
  async models() {
    const s = this.settings();
    if (!s.enabled) throw new AgentError('disabled', 'Codex is turned off');
    const exe = await this.exe();
    if (!exe) throw new AgentError('not-installed', s.exe ? `Not found: ${clip(s.exe, 150)}` : 'Codex is not installed');
    if (this.starting) await this.starting.catch(() => {});
    const server = this.server && !this.server.exited ? this.server : await this.ensureServer(exe, { conversation: null, mcp: null }, s);
    if (!server) throw new AgentError('busy', 'Codex is restarting');
    const found = [];
    let cursor = null;
    for (let page = 0; page < 5; page++) {
      const res = await server.request('model/list', { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) }, 15000);
      found.push(...(res && Array.isArray(res.data) ? res.data : []));
      cursor = res && res.nextCursor;
      if (!cursor) break;
    }
    const models = found
      .filter((m) => m && !m.hidden && typeof (m.model || m.id) === 'string')
      .map((m) => ({
        id: String(m.model || m.id),
        label: String(m.displayName || m.model || m.id),
        efforts: (Array.isArray(m.supportedReasoningEfforts) ? m.supportedReasoningEfforts : []).map((e) => e && String(e.reasoningEffort || '')).filter(Boolean),
        defaultEffort: typeof m.defaultReasoningEffort === 'string' ? m.defaultReasoningEffort : ''
      }));
    // Without a model of its own the chat runs on the user's configured one, which can be any of these: offer
    // the efforts they all support. A model that is not in the list gets none, as its support is unknown.
    const common = models.length ? models.reduce((acc, m) => acc.filter((e) => m.efforts.includes(e)), models[0].efforts) : [];
    return { models, efforts: common, custom: [] };
  }

  // The native binary inside the global npm package; its codex.cmd/.ps1 shims would need a shell.
  npmExe() {
    if (!WINDOWS) return null;
    const npm = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'npm', 'node_modules', '@openai', 'codex');
    const triple = process.arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc';
    const pkg = process.arch === 'arm64' ? 'codex-win32-arm64' : 'codex-win32-x64';
    return path.join(npm, 'node_modules', '@openai', pkg, 'vendor', triple, 'bin', 'codex.exe');
  }

  // config.exe, else the npm package's native binary, else the first codex.exe on PATH.
  async exe() {
    const { exe } = this.settings();
    if (this.exeCache && this.exeCache.configured === exe && Date.now() - this.exeCache.at < EXE_TTL) return this.exeCache.value;
    const candidates = exe ? [exe] : [this.npmExe()];
    const value = await resolveExe(candidates, exe ? null : WINDOWS ? 'codex.exe' : 'codex');
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
    const file = this.npmExe();
    return file && fs.existsSync(file) ? file : '';
  }

  // A new program path takes effect once Codex is idle; access and model apply from the next turn
  // (a cleared model and a new Rukoo MCP address through a fresh app-server, see ensureServer).
  configChanged() {
    this.invalidate();
    const exe = this.settings().exe;
    if (this.server && !this.server.exited && this.busy === 0 && exe && exe !== this.server.exe) this.server.close();
  }

  async status({ force = false } = {}) {
    if (force) this.invalidate();
    const s = this.settings();
    if (!s.enabled) return { state: 'disabled', detail: '' };
    const exe = await this.exe();
    if (!exe) return { state: 'missing', detail: s.exe ? `Not found: ${clip(s.exe, 150)}` : 'Codex is not installed' };
    const version = await this.version(exe);
    return { state: 'ready', detail: version ? `Codex ${version}` : 'Codex' };
  }

  workspace() {
    const dir = this.paths.workspace || path.join(os.tmpdir(), 'rukoo-agent-workspace');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  async runTurn(turn) {
    try {
      return await this.turn(turn);
    } catch (err) {
      const e = err instanceof AgentError ? err : new AgentError('unknown', clip(err && err.message, 200));
      if (!(err instanceof AgentError)) this.log('codex: turn failed', err);
      return { status: 'error', error: { code: e.code, detail: e.detail } };
    }
  }

  async turn(turn) {
    const s = this.withChoice(this.settings(), turn);
    if (!s.enabled) throw new AgentError('disabled', 'Codex is turned off');
    const exe = await this.exe();
    if (!exe) throw new AgentError('not-installed', s.exe ? `Not found: ${clip(s.exe, 150)}` : 'Codex is not installed');
    if (turn.signal && turn.signal.aborted) return { status: 'stopped' };
    const server = await this.ensureServer(exe, turn, s);
    // Stopped while it waited for another Codex turn to finish.
    if (!server || (turn.signal && turn.signal.aborted)) return { status: 'stopped' };
    this.busy++;
    try {
      const threadId = await this.ensureThread(server, turn, s);
      if (turn.signal && turn.signal.aborted) return { status: 'stopped' };
      const run = new Run(this, server, turn, threadId);
      this.runs.set(threadId, run);
      try {
        const params = { threadId, input: turnInput(turn) };
        // Access, model or effort changed since the thread was loaded: these overrides stick for later turns.
        const loaded = server.threads.get(threadId);
        let next = null;
        if (loaded && (loaded.access !== s.access || loaded.model !== s.model || loaded.effort !== s.effort)) {
          if (loaded.access !== s.access || loaded.model !== s.model) {
            Object.assign(params, this.policy(s).turn);
            if (s.model) params.model = s.model;
          }
          if (s.effort) params.effort = s.effort;
          // A cleared model or effort has no override; the thread keeps the old one until ensureServer reloads it.
          next = { ...loaded, access: s.access, model: s.model || loaded.model, effort: s.effort || loaded.effort };
        }
        server
          .request('turn/start', params, this.startWait)
          .then((res) => {
            // Codex has the overrides only once it started the turn: a refused start sends them again next time.
            if (next && server.threads.has(threadId)) server.threads.set(threadId, next);
            run.started(res && res.turn && res.turn.id);
          })
          .catch((err) => {
            if (run.ended) return;
            const detail = clip(err.message, 200);
            // No answer in time: Codex may have started the turn anyway, where Rukoo cannot follow or stop it.
            // End the app-server with whatever it runs, as for a stop that does not end in time.
            if (err.code === 'timeout' && !server.exited) {
              this.log('codex: turn/start got no answer; ending the app-server');
              return this.endServer(run, run.stopping ? { status: 'stopped' } : { status: 'error', error: { code: 'timeout', detail } }, 'Codex was restarted because another chat did not start in time');
            }
            run.finish({ status: 'error', error: { code: 'protocol', detail } });
          });
        return await run.done;
      } finally {
        if (this.runs.get(threadId) === run) this.runs.delete(threadId);
      }
    } finally {
      this.busy--;
    }
  }

  policy(s) {
    if (s.access === 'full') {
      return { thread: { approvalPolicy: 'never', sandbox: 'danger-full-access' }, turn: { approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } } };
    }
    return {
      thread: { approvalPolicy: 'on-request', sandbox: 'read-only' },
      turn: { approvalPolicy: 'on-request', sandboxPolicy: { type: 'readOnly', networkAccess: false } }
    };
  }

  // What a thread was loaded with, to tell later which settings it still lacks. A thread starts without an effort
  // override; the first turn/start sends the chat's effort.
  threadState(turn, s) {
    return { access: s.access, model: s.model, effort: '', url: (turn.mcp && turn.mcp.url) || '' };
  }

  // Codex ignores new config for a thread it has loaded (thread/resume overrides included), and turn/start
  // cannot take a model or effort override back. A thread loaded with another Rukoo MCP address (the port
  // changed), or with a model or effort the chat and settings no longer name, only gets the new settings from a
  // fresh app-server.
  reloadNeeded(server, turn, s) {
    const known = turn.conversation && turn.conversation.provider && turn.conversation.provider.threadId;
    const loaded = known ? server.threads.get(known) : null;
    if (!loaded) return false;
    return loaded.url !== ((turn.mcp && turn.mcp.url) || '') || Boolean(loaded.model && !s.model) || Boolean(loaded.effort && !s.effort);
  }

  threadParams(turn, s) {
    const instructions = [turn.instructions || '', s.access === 'full' ? '' : ESCALATE].filter(Boolean).join('\n\n');
    const url = turn.mcp && turn.mcp.url;
    const params = {
      cwd: this.workspace(),
      ...this.policy(s).thread,
      developerInstructions: instructions,
      // Not stored with the thread: sent again on every start and resume. A thread that is already
      // loaded keeps what it was loaded with (see reloadNeeded).
      // notify: [] keeps the user's turn-ended hook from firing for Rukoo's turns.
      config: { notify: [] }
    };
    // Without a URL Rukoo's MCP server is not running: the chat still works, without Rukoo's tools.
    if (url) {
      params.config.mcp_servers = {
        rukoo: { url, bearer_token_env_var: 'RUKOO_MCP_TOKEN', default_tools_approval_mode: 'approve', tool_timeout_sec: 120, startup_timeout_sec: 20 }
      };
    }
    if (s.model) params.model = s.model;
    return params;
  }

  async ensureServer(exe, turn, s = this.settings()) {
    // One that is still starting is the server to use, or to judge, once it is up.
    if (this.starting) await this.starting.catch(() => {});
    const server = this.server && !this.server.exited ? this.server : null;
    if (server && server.exe === exe && !this.reloadNeeded(server, turn, s)) return server;
    // A new program path, or a reload, waits until no Codex turn is in flight: this turn must not run on the
    // old server, whose threads still have the old model or point at a closed Rukoo listener.
    if (server && this.busy > 0) {
      if (!(await this.whenIdle(turn.signal))) return null;
      return this.ensureServer(exe, turn, this.withChoice(this.settings(), turn));
    }
    if (server) server.close();
    if (!this.starting) {
      this.starting = this.startServer(exe, turn).finally(() => {
        this.starting = null;
      });
    }
    return this.starting;
  }

  // Resolves true once no Codex turn runs, false when the waiting turn is stopped first. Gives up after
  // ten minutes, so a stuck turn elsewhere cannot hold this one forever.
  async whenIdle(signal, limitMs = IDLE_WAIT_MS) {
    const end = Date.now() + limitMs;
    while (this.busy > 0) {
      if (signal && signal.aborted) return false;
      if (Date.now() > end) throw new AgentError('busy', 'Codex restarts with the new settings once the other Codex chat finishes. Try again then.');
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return !(signal && signal.aborted);
  }

  async startServer(exe, turn) {
    // One token for the whole process; Rukoo maps calls to conversations through _meta.threadId.
    const hub = this.hub;
    const token = hub && typeof hub.issueToken === 'function' ? hub.issueToken({ agent: this.id, conversationId: null }) : turn.mcp && turn.mcp.token;
    const server = new AppServer(this, exe, token);
    server.start({ cwd: this.workspace(), env: cleanEnv({ RUKOO_MCP_TOKEN: token }) });
    this.server = server;
    try {
      await server.request(
        'initialize',
        {
          clientInfo: { name: 'rukoo', title: 'Rukoo Mail', version: appVersion },
          capabilities: { experimentalApi: false, optOutNotificationMethods: ['remoteControl/status/changed', 'account/rateLimits/updated'] }
        },
        20000
      );
      server.notify('initialized');
    } catch (err) {
      server.close();
      if (this.server === server) this.server = null;
      if (err instanceof AgentError) throw err;
      throw new AgentError('spawn-failed', clip(err.message, 200));
    }
    return server;
  }

  async ensureThread(server, turn, s) {
    const cid = turn.conversation.id;
    const known = turn.conversation.provider && turn.conversation.provider.threadId;
    const map = (threadId) => {
      if (this.hub && typeof this.hub.mapThread === 'function') this.hub.mapThread(threadId, cid);
    };
    if (known && server.threads.has(known)) {
      map(known);
      return known;
    }
    const params = this.threadParams(turn, s);
    let lost = false;
    if (known) {
      try {
        await server.request('thread/resume', { threadId: known, excludeTurns: true, ...params }, 60000);
        server.threads.set(known, this.threadState(turn, s));
        map(known);
        return known;
      } catch (err) {
        if (server.exited) throw new AgentError('spawn-failed', clip(err.message, 200));
        this.log(`codex: could not resume thread ${known}: ${err.message}`);
        lost = true;
      }
    }
    let res;
    try {
      res = await server.request('thread/start', params, 60000);
    } catch (err) {
      throw new AgentError(server.exited ? 'spawn-failed' : 'protocol', clip(err.message, 200));
    }
    const threadId = res && res.thread && res.thread.id;
    if (!threadId) throw new AgentError('protocol', 'Codex did not return a thread id');
    server.threads.set(threadId, this.threadState(turn, s));
    turn.setProvider({ threadId });
    map(threadId);
    if (lost) {
      // The new thread knows nothing of the chat: the turn's input gets the email and a recap before it goes out.
      turn.emit({ type: 'notice', tone: 'info', code: 'new-thread', text: 'Codex started a new thread' });
      if (typeof turn.startOver === 'function') await turn.startOver();
    }
    return threadId;
  }

  onServerExit(server, detail) {
    if (this.server === server) this.server = null;
    for (const run of [...this.runs.values()]) {
      if (run.server === server) run.finish(run.stopping ? { status: 'stopped' } : { status: 'error', error: { code: 'spawn-failed', detail } });
    }
    this.revoke(server);
  }

  revoke(server) {
    const hub = this.hub;
    if (!server.token || server.revoked || !hub || typeof hub.revokeToken !== 'function') return;
    server.revoked = true;
    hub.revokeToken(server.token);
  }

  // A stopped turn that Codex did not end in time: kill the app-server with every command it runs, so
  // nothing goes on behind a chat that says Stopped. The token goes first, so the turn cannot reach
  // Rukoo's tools while the process dies. Other chats on the same process end too, and say why.
  forceStop(run) {
    if (run.ended) return;
    this.log('codex: a stopped turn did not end in time; ending the app-server');
    this.endServer(run, { status: 'stopped' }, 'Codex was restarted to stop another chat');
  }

  // Ends run with outcome and kills its app-server; other chats on it end with why.
  endServer(run, outcome, why) {
    const server = run.server;
    run.finish(outcome);
    if (server.exited) return;
    for (const other of [...this.runs.values()]) {
      if (other.server === server && !other.ended) {
        other.finish(other.stopping ? { status: 'stopped' } : { status: 'error', error: { code: 'unknown', detail: why } });
      }
    }
    server.kill();
  }

  async dispose() {
    for (const run of [...this.runs.values()]) run.finish({ status: 'stopped' });
    const closing = this.server ? this.server.close() : null;
    this.server = null;
    await closing;
  }
}

// The app-server process: JSON-RPC over lines, without the "jsonrpc" field.
class AppServer {
  constructor(adapter, exe, token) {
    this.adapter = adapter;
    this.log = adapter.log;
    this.exe = exe;
    this.token = token;
    this.child = null;
    this.exited = false;
    this.nextId = 1;
    this.pending = new Map();
    // thread id → settings key it was loaded with
    this.threads = new Map();
  }

  start(options) {
    let child;
    try {
      child = start(this.exe, [...this.adapter.launchArgs, 'app-server'], options);
    } catch (err) {
      this.exited = true;
      throw new AgentError(err.code === 'ENOENT' ? 'not-installed' : 'spawn-failed', clip(err.message, 200));
    }
    this.child = child;
    this.stderr = tail(child.stderr);
    child.stdout.on('error', () => {});
    readJsonLines(child.stdout, (msg) => this.onMessage(msg), (line) => this.log(`codex: ${clip(line, 200)}`));
    child.on('error', (err) => this.onExit(err.code === 'ENOENT' ? 'not-installed' : 'spawn-failed', clip(err.message, 200)));
    child.on('exit', (code, signal) => this.onExit('spawn-failed', clip(this.stderr.last() || `Codex exited (${signal || code})`, 200)));
  }

  request(method, params, timeout = 30000) {
    if (this.exited) return Promise.reject(new AgentError('spawn-failed', 'Codex is not running'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AgentError('timeout', `Codex did not answer ${method} within ${timeout / 1000} s`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer, method });
      if (!writeJson(this.child, { id, method, params })) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new AgentError('spawn-failed', 'Codex is not accepting input'));
      }
    });
  }

  notify(method, params) {
    writeJson(this.child, params === undefined ? { method } : { method, params });
  }

  respond(id, result) {
    writeJson(this.child, { id, result });
  }

  respondError(id, code, message) {
    writeJson(this.child, { id, error: { code, message } });
  }

  onMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    try {
      if (msg.id !== undefined && typeof msg.method === 'string') return this.onRequest(msg);
      if (msg.id !== undefined) return this.onResponse(msg);
      if (typeof msg.method === 'string') return this.onNotification(msg.method, msg.params || {});
    } catch (err) {
      this.log(`codex: could not handle ${msg.method || 'a response'}`, err);
    }
  }

  onResponse(msg) {
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    this.pending.delete(msg.id);
    clearTimeout(pending.timer);
    if (msg.error) pending.reject(Object.assign(new Error(msg.error.message || `${pending.method} failed`), { rpcCode: msg.error.code }));
    else pending.resolve(msg.result);
  }

  runFor(params) {
    const run = params && params.threadId ? this.adapter.runs.get(params.threadId) : null;
    return run && run.server === this ? run : null;
  }

  onNotification(method, params) {
    const run = this.runFor(params);
    if (method === 'mcpServer/startupStatus/updated' && params.name === 'rukoo' && params.status === 'failed') {
      this.log(`codex: the rukoo MCP server failed to start: ${clip(params.error || '', 200)}`);
    }
    if (run) run.onNotification(method, params);
  }

  onRequest(msg) {
    const run = this.runFor(msg.params);
    if (run) return run.onRequest(msg.id, msg.method, msg.params || {});
    // Nothing of ours is running on that thread: refuse whatever it is.
    if (msg.method === 'item/commandExecution/requestApproval' || msg.method === 'item/fileChange/requestApproval') return this.respond(msg.id, { decision: 'cancel' });
    if (msg.method === 'mcpServer/elicitation/request') return this.respond(msg.id, { action: 'cancel', content: null, _meta: null });
    if (msg.method === 'item/permissions/requestApproval') return this.respond(msg.id, { permissions: {}, scope: 'turn' });
    this.respondError(msg.id, -32601, `Rukoo does not handle ${msg.method}`);
  }

  onExit(code, detail) {
    if (this.exited) return;
    this.exited = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new AgentError(code, detail));
    }
    this.pending.clear();
    this.adapter.onServerExit(this, detail);
  }

  // Now, without waiting for a clean exit: the next turn gets a new process straight away.
  kill() {
    if (!this.child || this.exited) return;
    if (this.adapter.server === this) this.adapter.server = null;
    this.adapter.revoke(this);
    killTree(this.child);
  }

  // Resolves once the kill is done.
  close() {
    if (!this.child || this.exited) return Promise.resolve();
    // Closing stdin ends app-server cleanly; the tree kill takes any command it was still running.
    try {
      this.child.stdin.end();
    } catch {}
    return killTree(this.child);
  }
}

// One turn on one thread.
class Run {
  constructor(adapter, server, turn, threadId) {
    this.adapter = adapter;
    this.server = server;
    this.turn = turn;
    this.threadId = threadId;
    this.turnId = null;
    this.items = new Map();
    this.open = new Set();
    this.thinking = new Set();
    this.approvals = new Map();
    this.stopping = false;
    this.errored = false;
    this.ended = false;
    this.done = new Promise((resolve) => {
      this.resolve = resolve;
    });
    this.onAbort = () => this.stop();
    if (turn.signal) turn.signal.addEventListener('abort', this.onAbort, { once: true });
  }

  emit(event) {
    if (!this.ended) this.turn.emit(event);
  }

  started(turnId) {
    if (turnId && !this.turnId) this.turnId = turnId;
    if (this.stopping) this.interrupt();
  }

  stop() {
    if (this.ended || this.stopping) return;
    this.stopping = true;
    if (this.turnId) this.interrupt();
    this.stopTimer = setTimeout(() => this.adapter.forceStop(this), this.adapter.stopWait);
  }

  interrupt() {
    if (this.interrupted || !this.turnId) return;
    this.interrupted = true;
    this.server.request('turn/interrupt', { threadId: this.threadId, turnId: this.turnId }, 10000).catch((err) => this.adapter.log(`codex: interrupt failed: ${err.message}`));
  }

  finish(outcome) {
    if (this.ended) return;
    for (const key of this.open) this.turn.emit({ type: 'tool-end', key, error: false });
    if (this.thinking.size) this.turn.emit({ type: 'thinking-done' });
    this.open.clear();
    this.thinking.clear();
    this.ended = true;
    clearTimeout(this.stopTimer);
    if (this.turn.signal) this.turn.signal.removeEventListener('abort', this.onAbort);
    this.resolve(outcome);
  }

  onNotification(method, p) {
    if (this.ended) return;
    if (p.turnId && this.turnId && p.turnId !== this.turnId && method !== 'turn/completed') return;
    switch (method) {
      case 'turn/started':
        return this.started(p.turn && p.turn.id);
      case 'item/started':
        return this.itemStarted(p.item || {});
      case 'item/completed':
        return this.itemCompleted(p.item || {});
      case 'item/agentMessage/delta': {
        const entry = this.items.get(p.itemId) || this.track({ id: p.itemId, type: 'agentMessage', phase: null });
        if (typeof p.delta !== 'string' || !p.delta) return;
        // Commentary between tool calls arrives as one muted line when it is complete.
        if (entry.phase === 'commentary') entry.text += p.delta;
        else {
          entry.streamed = true;
          this.emit({ type: 'text', delta: p.delta });
        }
        return;
      }
      case 'item/reasoning/summaryPartAdded':
        if (p.summaryIndex > 0) this.emit({ type: 'thinking', delta: '\n\n' });
        return;
      case 'item/reasoning/summaryTextDelta':
        if (p.delta) {
          this.thinking.add(p.itemId);
          this.emit({ type: 'thinking', delta: p.delta });
        }
        return;
      case 'thread/tokenUsage/updated':
        if (p.tokenUsage && p.tokenUsage.last) this.emit({ type: 'usage', ...p.tokenUsage.last });
        return;
      case 'error':
        if (p.willRetry) return;
        this.errored = true;
        this.lastError = turnError(p.error);
        this.emit({ type: 'error', code: this.lastError.code, detail: this.lastError.detail });
        return;
      case 'serverRequest/resolved': {
        const pending = this.approvals.get(String(p.requestId));
        if (pending) this.expire(pending);
        return;
      }
      case 'turn/completed':
        return this.completed(p.turn || {});
      default:
        return;
    }
  }

  track(item) {
    const entry = { type: item.type, phase: item.phase || null, text: '', streamed: false, item };
    this.items.set(item.id, entry);
    return entry;
  }

  itemStarted(item) {
    if (!item.id) return;
    const entry = this.track(item);
    if (item.type === 'reasoning') {
      this.thinking.add(item.id);
      this.emit({ type: 'thinking', delta: '' });
      return;
    }
    const tool = toolOf(item);
    if (!tool) return;
    entry.tool = true;
    this.open.add(item.id);
    this.emit({ type: 'tool-start', key: item.id, name: tool.name, detail: tool.detail });
  }

  itemCompleted(item) {
    if (!item.id) return;
    const entry = this.items.get(item.id) || this.track(item);
    if (item.type === 'agentMessage') {
      const phase = item.phase || entry.phase;
      const text = typeof item.text === 'string' ? item.text : entry.text;
      if (phase === 'commentary') {
        if (text.trim()) this.emit({ type: 'commentary', text: text.trim() });
      } else if (!entry.streamed && text) this.emit({ type: 'text', delta: text });
      return;
    }
    if (item.type === 'reasoning') {
      if (this.thinking.delete(item.id)) this.emit({ type: 'thinking-done' });
      return;
    }
    const tool = toolOf(item);
    if (!tool) return;
    if (!this.open.has(item.id)) this.emit({ type: 'tool-start', key: item.id, name: tool.name, detail: tool.detail });
    this.open.delete(item.id);
    const end = { type: 'tool-end', key: item.id, error: toolFailed(item) };
    if (end.error && item.error && item.error.message) end.detail = clip(oneLine(item.error.message), 200);
    this.emit(end);
  }

  completed(turn) {
    if (turn.id && this.turnId && turn.id !== this.turnId) return;
    if (turn.status === 'completed') return this.finish({ status: 'done' });
    if (turn.status === 'interrupted') return this.finish({ status: 'stopped' });
    const error = turn.error ? turnError(turn.error) : this.lastError || { code: 'unknown', detail: 'The Codex turn failed' };
    if (!this.errored) this.emit({ type: 'error', code: error.code, detail: error.detail });
    this.finish({ status: 'error', error });
  }

  // Server requests: approvals become cards in the panel, the answer goes back as the response.
  onRequest(id, method, p) {
    switch (method) {
      case 'item/commandExecution/requestApproval': {
        // The raw command, not commandActions: those are Codex's summary for display and can leave out
        // parts of a pipeline. Only the shell wrapper comes off.
        const command = p.command ? stripShell(p.command) : commandText(p.commandActions, '');
        const fields = [];
        if (command) fields.push({ key: 'command', label: 'Command', value: command });
        if (p.cwd) fields.push({ key: 'folder', label: 'Folder', value: String(p.cwd) });
        if (p.networkApprovalContext) fields.push({ key: 'input', label: 'Network', value: fieldText(p.networkApprovalContext) });
        if (p.reason) fields.push({ key: 'reason', label: 'Reason', value: String(p.reason) });
        const tool = { name: 'shell', kind: 'command' };
        // availableDecisions (experimental) often lists only accept and cancel, but Codex 0.160 honours
        // acceptForSession and decline too; decline lets the model carry on, cancel ends the turn.
        return this.ask(id, {
          title: p.kind === 'writeStdin' ? 'Codex wants to send input to a command' : approvalTitle('Codex', tool),
          detail: '',
          fields,
          tool,
          choices: APPROVE_CHOICES
        }, decision);
      }
      case 'item/fileChange/requestApproval': {
        // The patch is on the fileChange item that started just before this request.
        const entry = this.items.get(p.itemId);
        const changes = entry && entry.item && Array.isArray(entry.item.changes) ? entry.item.changes.filter((c) => c && c.path) : [];
        const fields = [];
        if (changes.length) fields.push({ key: 'file', label: changes.length === 1 ? 'File' : 'Files', value: changes.map(changeName).join('\n') });
        const diff = patchText(changes);
        if (diff) fields.push({ key: 'diff', label: 'Changes', value: diff });
        if (p.grantRoot) fields.push({ key: 'folder', label: 'Folder', value: String(p.grantRoot) });
        if (p.reason) fields.push({ key: 'reason', label: 'Reason', value: String(p.reason) });
        const tool = { name: 'apply_patch', kind: 'changeFiles' };
        return this.ask(id, { title: approvalTitle('Codex', tool), detail: '', fields, tool, choices: APPROVE_CHOICES }, decision);
      }
      case 'mcpServer/elicitation/request': {
        // Rukoo's own tools need no second question: Rukoo asks the user itself where it matters.
        if (p.serverName === 'rukoo') return this.server.respond(id, { action: 'accept', content: null, _meta: null });
        const meta = p._meta && typeof p._meta === 'object' ? p._meta : {};
        const server = String(p.serverName || '');
        // 'Allow linear to run tool "create_issue"?': the raw name is only in the message.
        const named = /run (?:tool )?"([^"]+)"/.exec(String(p.message || ''));
        const raw = named ? named[1] : '';
        const shown = String(meta.tool_title || raw);
        const tool = server ? { name: raw ? `mcp__${server}__${raw}` : `mcp__${server}`, kind: 'mcp', server, tool: shown } : { name: 'mcp', kind: 'other' };
        const fields = [];
        if (p.mode === 'url' && p.url) fields.push({ key: 'url', label: 'URL', value: String(p.url) });
        const params = Array.isArray(meta.tool_params_display)
          ? meta.tool_params_display
          : meta.tool_params && typeof meta.tool_params === 'object'
            ? Object.entries(meta.tool_params).map(([name, value]) => ({ name, value }))
            : [];
        for (const param of params) {
          if (!param || !param.name) continue;
          const label = param.display_name && param.display_name !== param.name ? String(param.display_name) : '';
          fields.push(inputField(String(param.name), param.value, label));
        }
        return this.ask(id, {
          // The server is in the title, so no Server field repeats it.
          title: approvalTitle('Codex', tool, shown || 'a tool'),
          detail: clip(p.message || '', 2000),
          // The hub folds long lists into one field; nothing the user allows may be left off the card.
          fields,
          tool,
          choices: [
            { id: 'accept', label: 'Allow', kind: 'primary' },
            { id: 'decline', label: 'Deny', kind: 'danger' }
          ]
        }, (choice) => ({ action: choice === 'accept' ? 'accept' : choice === 'cancel' ? 'cancel' : 'decline', content: null, _meta: null }));
      }
      case 'item/permissions/requestApproval': {
        const perms = p.permissions || {};
        const fields = [];
        // Allow grants these objects as they are, so the card shows all of them.
        const net = perms.network && typeof perms.network === 'object' ? perms.network : null;
        if (net && Object.keys(net).some((k) => k !== 'enabled')) fields.push({ key: 'input', label: 'Network', value: fieldText(net) });
        else if (net && net.enabled) fields.push({ key: 'input', label: 'Network', value: 'Internet access' });
        const fsPerms = perms.fileSystem && typeof perms.fileSystem === 'object' ? perms.fileSystem : {};
        for (const [name, value] of Object.entries(fsPerms)) {
          if (Array.isArray(value) && !value.length) continue;
          const label = name === 'read' ? 'Read' : name === 'write' ? 'Write' : humanize(name);
          fields.push({ key: 'input', label, value: Array.isArray(value) && value.every((v) => typeof v === 'string') ? value.join('\n') : fieldText(value) });
        }
        if (p.reason) fields.push({ key: 'reason', label: 'Reason', value: String(p.reason) });
        const granted = {};
        if (perms.network) granted.network = perms.network;
        if (perms.fileSystem) granted.fileSystem = perms.fileSystem;
        const tool = { name: 'permissions', kind: 'permissions' };
        return this.ask(id, {
          title: approvalTitle('Codex', tool),
          detail: '',
          fields,
          tool,
          choices: [
            { id: 'allow', label: 'Allow for this turn', kind: 'primary' },
            { id: 'deny', label: 'Deny', kind: 'danger' }
          ]
        }, (choice) => ({ permissions: choice === 'allow' ? granted : {}, scope: 'turn' }));
      }
      default:
        return this.server.respondError(id, -32601, `Rukoo does not handle ${method}`);
    }
  }

  ask(id, request, answer) {
    const promise = this.turn.approve({ ...request, key: `codex:${id}` });
    const pending = { promise, expired: false, id };
    this.approvals.set(String(id), pending);
    Promise.resolve(promise)
      .catch(() => 'cancel')
      .then((choice) => {
        this.approvals.delete(String(id));
        if (pending.expired || this.server.exited) return;
        this.server.respond(id, answer(choice || 'cancel'));
      });
  }

  // Codex settled the request itself (interrupt, timeout): take the card off the screen.
  expire(pending) {
    pending.expired = true;
    const itemId = (pending.promise && pending.promise.itemId) || `codex:${pending.id}`;
    const hub = this.adapter.hub;
    if (hub && typeof hub.expireApproval === 'function') hub.expireApproval(this.turn.conversation.id, itemId);
  }
}

module.exports = { CodexAdapter, stripShell, toolOf, argDetail };
