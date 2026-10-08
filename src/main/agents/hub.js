'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { AgentConfig, AgentError, AGENT_IDS, writeJsonAtomic, tailscaleAddress } = require('./config');
const { McpServer } = require('./mcp');
const tools = require('./tools');
const context = require('./context');

const MAX_CONVERSATIONS = 150;
// Conversations an agent opened from outside the panel (Clark on WhatsApp) have their own, smaller cap.
const MAX_EXTERNAL = 20;
// An agent calling in from outside keeps using one conversation per open email for this long.
const EXTERNAL_REUSE_MS = 4 * 60 * 60 * 1000;
const MAX_ITEMS = 400;
const MAX_TEXT = 40000;
const SAVE_MS = 400;
// While a turn runs, items change all the time; saving all conversations every 400 ms would stall the main thread.
const SAVE_RUNNING_MS = 2000;
// Attachment copies older than this are left over from a crash or a forced quit.
const TEMP_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const DELTA_MS = 50;
// An adapter that ignores stop() gets this long before the hub closes the turn itself.
const STOP_GRACE_MS = 12000;
const STATES = new Set(['ready', 'offline', 'unconfigured', 'disabled', 'missing', 'unauthorized', 'unknown']);
const ADAPTERS = { clark: ['./hermes', 'HermesAdapter'], claude: ['./claude', 'ClaudeAdapter'], codex: ['./codex', 'CodexAdapter'] };
const DENY_IDS = new Set(['deny', 'decline', 'cancel']);
// English fallbacks for error notices; the renderer localizes by code.
const ERROR_TEXT = {
  offline: 'Could not reach the agent.',
  unauthorized: 'The agent rejected the key or token.',
  'not-configured': 'The agent is not set up yet.',
  'not-installed': 'The agent program was not found.',
  disabled: 'The agent is turned off.',
  'spawn-failed': 'The agent program stopped unexpectedly.',
  busy: 'The agent is still working on the previous message.',
  window: "Rukoo's window is closed.",
  timeout: 'The agent did not respond in time.',
  protocol: 'The agent sent something Rukoo did not understand.',
  'rate-limited': 'The agent is rate limited. Try again in a moment.',
  stopped: 'Stopped.',
  unknown: 'Something went wrong.'
};

const rand = (n = 6) => crypto.randomBytes(n).toString('base64url').replace(/[-_]/g, '').slice(0, n).toLowerCase().padEnd(n, '0');
const newConversationId = () => `c_${Date.now().toString(36)}_${rand(6)}`;
const newItemId = () => `i_${rand(10)}`;
const clip = (v, max) => String(v == null ? '' : v).slice(0, max);
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest();
const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const normId = (v) => String(v || '').trim().replace(/^<|>$/g, '').toLowerCase();

// Anything thrown or reported becomes {code, detail} with a code from SPEC 4.6.
function toError(err) {
  if (!err) return { code: 'unknown', detail: '' };
  if (typeof err !== 'object') return { code: 'unknown', detail: clip(err, 500) };
  const known = typeof err.code === 'string' && Object.prototype.hasOwnProperty.call(ERROR_TEXT, err.code);
  const code = known ? err.code : 'unknown';
  const message = typeof err.message === 'string' && err.message !== err.code ? err.message : '';
  // Node system errors (ECONNREFUSED and friends) keep their code in the detail.
  const raw = !known && typeof err.code === 'string' ? err.code : '';
  return { code, detail: clip(err.detail || [raw, message].filter(Boolean).join(': '), 500) };
}

function withTimeout(promise, ms, code = 'timeout') {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new AgentError(code, `no answer after ${ms} ms`)), ms);
    })
  ]);
}

// Finds the adapter class in a module written to SPEC 5, whatever it is exported as.
function adapterClass(mod, name) {
  if (typeof mod === 'function') return mod;
  if (mod && typeof mod[name] === 'function') return mod[name];
  const any = mod && Object.values(mod).find((v) => typeof v === 'function' && /Adapter$/.test(v.name || ''));
  if (any) return any;
  throw new Error(`${name} not exported`);
}

function emptyView() {
  return { openMessageId: null, checkedIds: [], scope: 'all', view: 'inbox', folder: null, composer: null };
}

class AgentHub extends EventEmitter {
  // listen: false skips the MCP listeners (unit tests that call tools directly).
  constructor({ engine, dataDir, secrets, deps = {}, adapters = null, listen = true } = {}) {
    super();
    this.engine = engine;
    this.dataDir = dataDir;
    this.deps = deps;
    this.listen = listen;
    this.cfg = new AgentConfig({ file: path.join(dataDir, 'agents.json'), secrets, interfaces: deps.interfaces });
    this.file = path.join(dataDir, 'conversations.json');
    this.workspace = deps.workspace || path.join(path.dirname(dataDir), 'agent-workspace');
    this.injectedAdapters = adapters;
    this.adapters = new Map();
    this.adapterErrors = new Map();
    this.conversations = new Map();
    this.turns = new Map();
    this.approvals = new Map();
    this.followUps = new Map();
    this.tokens = [];
    this.convTokens = new Map();
    this.remoteHash = null;
    this.threads = new Map();
    this.uiPending = new Map();
    // Per conversation, the chain of mail work whose outcome goes into the notes, and what on it still runs; see
    // settleMail().
    this.mailSettling = new Map();
    this.mailRunning = new Map();
    // Attachment copies written for local agents (read_attachment local_path), removed on dispose.
    this.tempDirs = new Set();
    this.viewState = emptyView();
    this.statuses = {};
    // Per agent, how many forced status probes have started; see probeStatus().
    this.statusRound = new Map(AGENT_IDS.map((id) => [id, 0]));
    this.deltas = new Map();
    this.deltaTimer = null;
    this.saveTimer = null;
    this.mcp = null;
    this.remoteTimer = null;
    this.remoteStarting = false;
    this.remoteQueue = Promise.resolve();
    this.started = false;
    this.disposed = false;
  }

  // ---------- lifecycle ----------

  // The synchronous part (config, conversations, adapters) runs before the first await, so renderer calls
  // that arrive while the MCP listeners start already see the stored conversations.
  async start() {
    if (this.started) return;
    this.started = true;
    this.cfg.load();
    this.load();
    if (this.cfg.data.mcp.remoteToken) this.remoteHash = sha256(this.cfg.remoteToken());
    this.sweepTemp();
    this.registerAdapters();
    try {
      if (this.listen) await this.startMcp();
    } catch (err) {
      this.cfg.runtime.note = `MCP server did not start: ${err.message}`;
      this.log('hub', this.cfg.runtime.note);
    }
    this.refreshStatus().catch(() => {});
  }

  // In its long form: os.tmpdir() can be an 8.3 path (C:\Users\BARTAD~1\...). Claude gets this folder as
  // --add-dir, and a local_path written the short way would not match it, so every attachment would prompt.
  tempBase() {
    if (this.tempBaseDir) return this.tempBaseDir;
    const base = this.deps.tempDir || path.join(os.tmpdir(), 'rukoo-agent');
    let dir = base;
    try {
      fs.mkdirSync(base, { recursive: true });
      dir = fs.realpathSync.native(base);
    } catch (_) {
      // Not writable: writeTemp fails on its own and read_attachment goes without local_path.
    }
    this.tempBaseDir = dir;
    return dir;
  }

  // dispose() removes this run's attachment copies; a crash or a forced quit leaves them behind. Only old
  // folders go, so a second instance (dev, tests) keeps the files it is using.
  sweepTemp() {
    const base = this.tempBase();
    let names;
    try {
      names = fs.readdirSync(base);
    } catch (_) {
      return;
    }
    const cutoff = Date.now() - TEMP_MAX_AGE_MS;
    for (const name of names) {
      const dir = path.join(base, name);
      try {
        if (fs.statSync(dir).mtimeMs < cutoff) fs.rmSync(dir, { recursive: true, force: true });
      } catch (_) {
        // In use or already gone.
      }
    }
  }

  registerAdapters() {
    for (const id of AGENT_IDS) {
      const opts = {
        id,
        config: () => this.cfg.get(id),
        hub: this,
        log: (...args) => this.log(id, ...args),
        // attachments: where read_attachment saves files for local agents, so Claude may read them without asking.
        paths: { workspace: this.workspace, attachments: this.tempBase() }
      };
      try {
        let adapter;
        if (this.injectedAdapters) {
          const given = this.injectedAdapters[id];
          if (!given) continue;
          adapter = typeof given.runTurn === 'function' ? given : given(opts);
        } else if (process.env.SEM_AGENT_FAKE === '1') {
          const { FakeAdapter } = require('./fake');
          adapter = new FakeAdapter(opts);
        } else {
          // Each adapter loads on its own, so one broken or missing module only takes out that agent.
          const [file, name] = ADAPTERS[id];
          const Cls = adapterClass(require(file), name);
          adapter = new Cls(opts);
        }
        this.adapters.set(id, adapter);
      } catch (err) {
        this.adapterErrors.set(id, clip(err && err.message, 300));
        this.log(id, 'adapter not loaded:', err && err.message);
      }
    }
  }

  log(scope, ...args) {
    if (process.env.SEM_AGENT_LOG || process.env.SEM_TRACE) console.log(`[agent:${scope}]`, ...args);
  }

  async startMcp() {
    this.mcp = new McpServer({ hub: this, version: this.deps.appVersion || '0.0.0', log: (...a) => this.log('mcp', ...a) });
    const want = this.cfg.data.mcp.port;
    let note = '';
    try {
      await this.mcp.listen({ host: '127.0.0.1', port: want, remote: false });
    } catch (err) {
      if (err.code !== 'EADDRINUSE' && err.code !== 'EACCES') throw err;
      await this.mcp.listen({ host: '127.0.0.1', port: 0, remote: false });
      note = `Port ${want} is in use; Rukoo uses ${this.mcp.ports().local} for local agents.`;
    }
    this.cfg.runtime.localPort = this.mcp.ports().local;
    this.cfg.runtime.note = note;
    await this.startRemote();
    // Tailscale often comes up after Rukoo (login items); keep trying while the user wants remote access.
    clearInterval(this.remoteTimer);
    this.remoteTimer = setInterval(() => {
      if (this.disposed || !this.mcp || !this.cfg.data.mcp.remote || this.mcp.ports().remote || this.remoteStarting) return;
      this.remoteStarting = true;
      this.startRemote()
        .then(() => this.mcp && this.mcp.ports().remote && this.refreshStatus({ force: true }))
        .catch(() => {})
        .finally(() => {
          this.remoteStarting = false;
        });
    }, 60000);
    if (this.remoteTimer.unref) this.remoteTimer.unref();
  }

  // One start at a time. A start still waiting for its listener (the retry timer, say) would otherwise add
  // it after a later start had closed the remote listeners because the user turned remote access off.
  startRemote() {
    const run = this.remoteQueue.then(() => this.openRemote());
    this.remoteQueue = run.catch(() => {});
    return run;
  }

  // The Tailscale listener, only when the user turned it on and this machine has an address.
  async openRemote() {
    const mcp = this.mcp;
    if (!mcp || mcp.closed) return;
    await mcp.closeRemote();
    this.cfg.runtime.remotePort = null;
    const { remote, remoteHost, port } = this.cfg.data.mcp;
    if (!remote) return;
    this.cfg.remoteToken();
    this.remoteHash = sha256(this.cfg.remoteToken());
    const detected = tailscaleAddress(this.cfg.interfaces);
    const literal = /^\d+\.\d+\.\d+\.\d+$/.test(remoteHost);
    const host = literal ? remoteHost : detected || remoteHost;
    if (!host) {
      this.cfg.runtime.note = 'No Tailscale address found on this PC.';
      return;
    }
    const names = remoteHost && remoteHost !== host ? [remoteHost] : [];
    try {
      await mcp.listen({ host, port, remote: true, hosts: names });
    } catch (err) {
      // dispose() or a port change closed this server meanwhile; the note belongs to the server that replaced it.
      if (mcp.closed) return;
      if (err.code !== 'EADDRINUSE') {
        this.cfg.runtime.note = `Could not listen on ${host}:${port}: ${err.code || err.message}`;
        return;
      }
      try {
        await mcp.listen({ host, port: mcp.ports().local || 0, remote: true, hosts: names });
      } catch (err2) {
        if (!mcp.closed) this.cfg.runtime.note = `Could not listen on ${host}: ${err2.code || err2.message}`;
        return;
      }
    }
    this.cfg.runtime.remotePort = mcp.ports().remote;
    if (this.cfg.runtime.remotePort !== port) this.cfg.runtime.note = `Port ${port} is in use on ${host}; Rukoo uses ${this.cfg.runtime.remotePort}.`;
  }

  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    clearInterval(this.remoteTimer);
    for (const turn of [...this.turns.values()]) {
      // runTurn() would give these back only after the flush below, so a turn the agent does not have yet gives
      // them back now.
      const c = this.conversations.get(turn.cid);
      if (c && !turn.reached) this.giveBack(c, turn);
      turn.controller.abort();
      this.finishTurn(turn, { status: 'stopped' });
    }
    for (const [id, p] of this.uiPending) {
      clearTimeout(p.timer);
      p.reject(new AgentError('window', 'Rukoo is closing'));
      this.uiPending.delete(id);
    }
    // Approvals queued behind a turn that ended just now: the agent hears about them with the next message.
    for (const [cid, queue] of this.followUps) {
      const c = this.conversations.get(cid);
      if (c) for (const message of queue) this.keepApproval(c, message);
    }
    this.followUps.clear();
    // Mail work still running or queued: its outcome would come too late to be saved, so the agent hears that it is
    // not known.
    for (const [cid, running] of this.mailRunning) {
      const c = this.conversations.get(cid);
      if (!c) continue;
      for (const { label } of running) {
        c.notes.push(`Rukoo closed while ${context.unsafeInline(label || 'a mail action', 'mail action')} was still running, so its outcome is not known. Check the mail before you act on it again.`);
      }
    }
    clearTimeout(this.deltaTimer);
    this.deltas.clear();
    // Synchronous, so a quit that does not wait for this promise still keeps the transcript.
    this.flush();
    for (const dir of this.tempDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch (_) {
        // A file an agent still holds open; the OS cleans temp eventually.
      }
    }
    const closing = [...this.adapters.values()].map((a) => Promise.resolve().then(() => a.dispose && a.dispose()));
    if (this.mcp) closing.push(this.mcp.close());
    await Promise.allSettled(closing);
  }

  // ---------- persistence ----------

  load() {
    let raw = null;
    try {
      raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') {
        // Keep a broken file aside instead of overwriting it with an empty list on the next save.
        try {
          fs.renameSync(this.file, `${this.file}.bad-${Date.now()}`);
        } catch (_) {
          // Nothing to keep.
        }
      }
    }
    const list = raw && Array.isArray(raw.conversations) ? raw.conversations : [];
    for (const c of list) {
      if (!isObj(c) || typeof c.id !== 'string' || !AGENT_IDS.includes(c.agent) || !Array.isArray(c.items)) continue;
      c.status = 'idle';
      c.provider = isObj(c.provider) ? c.provider : {};
      c.notes = Array.isArray(c.notes) ? c.notes.filter((n) => typeof n === 'string') : [];
      // Saved before Rukoo tracked this: a chat with a message the agent answered has had its first turn.
      if (typeof c.delivered !== 'boolean') c.delivered = c.items.some((i) => i.type === 'assistant');
      // A turn cannot survive a restart: close whatever was still open.
      for (const item of c.items) {
        if (item.type === 'assistant' && item.status === 'streaming') item.status = 'stopped';
        if (item.type === 'thinking' && item.status === 'running') Object.assign(item, { status: 'done', endedAt: item.endedAt || c.updatedAt });
        if (item.type === 'tool' && item.status === 'running') Object.assign(item, { status: 'done', endedAt: item.endedAt || c.updatedAt });
        if (item.type === 'approval' && item.status === 'pending' && item.kind === 'runtime') item.status = 'expired';
      }
      this.conversations.set(c.id, c);
      if (c.provider.threadId) this.threads.set(String(c.provider.threadId), c.id);
    }
  }

  scheduleSave() {
    // After dispose() flushed, nothing more is written: the app is quitting.
    if (this.saveTimer || this.disposed) return;
    this.saveTimer = setTimeout(
      () => {
        this.saveTimer = null;
        this.save();
      },
      this.turns.size ? SAVE_RUNNING_MS : SAVE_MS
    );
  }

  save() {
    try {
      const conversations = [...this.conversations.values()].sort((a, b) => b.updatedAt - a.updatedAt);
      writeJsonAtomic(this.file, { version: 1, conversations });
    } catch (err) {
      this.log('hub', 'saving conversations failed:', err.message);
    }
  }

  flush() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.save();
  }

  // ---------- events ----------

  emitEvent(payload) {
    if (payload.kind !== 'delta') this.flushDeltas();
    this.emit('event', payload);
  }

  // Streaming text arrives in tiny pieces; send it to the renderer at most every 50 ms per item.
  queueDelta(cid, itemId, text) {
    const key = `${cid}\n${itemId}`;
    const d = this.deltas.get(key);
    if (d) d.text += text;
    else this.deltas.set(key, { conversationId: cid, itemId, text });
    if (!this.deltaTimer) this.deltaTimer = setTimeout(() => this.flushDeltas(), DELTA_MS);
  }

  flushDeltas() {
    clearTimeout(this.deltaTimer);
    this.deltaTimer = null;
    if (!this.deltas.size) return;
    const list = [...this.deltas.values()];
    this.deltas.clear();
    for (const d of list) this.emit('event', { kind: 'delta', conversationId: d.conversationId, itemId: d.itemId, field: 'text', text: d.text });
  }

  emitConversation(c) {
    this.emitEvent({ kind: 'conversation', conversation: c });
  }

  touch(c) {
    c.updatedAt = Date.now();
    this.scheduleSave();
  }

  addItem(c, fields) {
    const item = { id: newItemId(), at: Date.now(), ...fields };
    for (const k of ['text', 'detail', 'summary']) if (typeof item[k] === 'string') item[k] = clip(item[k], MAX_TEXT);
    c.items.push(item);
    const removed = this.trimItems(c, item);
    this.touch(c);
    this.emitEvent({ kind: 'item', conversationId: c.id, item });
    // Only the ids, so a long transcript is not sent again for every new item.
    if (removed.length) this.emitEvent({ kind: 'trim', conversationId: c.id, itemIds: removed });
    return item;
  }

  // Drops the oldest items past MAX_ITEMS. An approval that still waits for the user stays, so nobody is
  // left waiting on a card that is gone. Only when nothing else is left does the oldest one expire and go.
  trimItems(c, keep) {
    const removed = [];
    while (c.items.length > MAX_ITEMS) {
      let i = c.items.findIndex((x) => x !== keep && !(x.type === 'approval' && x.status === 'pending'));
      if (i < 0) {
        i = 0;
        const w = this.approvals.get(c.items[0].id);
        this.approvals.delete(c.items[0].id);
        if (w) w.resolve('cancel');
      }
      removed.push(c.items.splice(i, 1)[0].id);
    }
    return removed;
  }

  updateItem(c, item) {
    this.touch(c);
    this.emitEvent({ kind: 'item', conversationId: c.id, item });
    return item;
  }

  setStatus(c, status, error = null) {
    c.status = status;
    this.touch(c);
    this.emitEvent({ kind: 'status', conversationId: c.id, status, ...(error ? { error } : {}) });
  }

  // ---------- conversations (renderer API) ----------

  mustGet(id) {
    const c = this.conversations.get(id);
    if (!c) throw new AgentError('invalid', 'unknown conversation');
    return c;
  }

  agentName(agent) {
    return this.cfg.displayName(agent);
  }

  list() {
    return [...this.conversations.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((c) => {
        const last = [...c.items].reverse().find((i) => (i.type === 'assistant' && !i.interim) || i.type === 'user');
        return {
          id: c.id,
          agent: c.agent,
          title: c.title,
          message: c.message,
          origin: c.origin,
          updatedAt: c.updatedAt,
          status: c.status,
          preview: last ? clip(String(last.text || '').replace(/\s+/g, ' ').trim(), 140) : ''
        };
      });
  }

  get(id) {
    this.flushDeltas();
    return this.conversations.get(id) || null;
  }

  findFor(ref = {}) {
    const want = normId(ref.messageId);
    const id = ref.id ? String(ref.id) : '';
    // The same email can arrive in two accounts; each copy has its own chats. A saved copy has no account.
    const account = ref.accountId || tools.accountOfId(id);
    let best = null;
    for (const c of this.conversations.values()) {
      const m = c.message;
      if (!m) continue;
      const own = m.accountId || tools.accountOfId(m.id);
      const hit = want && m.messageId ? normId(m.messageId) === want && !(account && own && own !== account) : Boolean(id) && m.id === id;
      if (hit && (!best || c.updatedAt > best.updatedAt)) best = c;
    }
    return best;
  }

  // The current Rukoo id of an email a card points at: the stored id while it still holds that email, else
  // the same Message-ID within the same account (mail moves within its account), first in the folders Rukoo
  // has synced, then in the folder Rukoo last moved it to. null when it is gone.
  async locate(ref = {}) {
    const id = ref.id ? String(ref.id) : '';
    const header = ref.messageHeader ? String(ref.messageHeader) : '';
    const cached = id ? tools.cacheMessage(this.engine, id) : null;
    if (cached && (!header || !cached.messageId || normId(cached.messageId) === normId(header))) return id;
    // A saved copy is there until the user deletes it. After that its id is as stale as a moved email's:
    // the Message-ID may still find the email in the mailbox, else it is gone.
    if (id.startsWith('saved:') && this.engine.saved.some((s) => s.id === id)) return id;
    if (!header) return null;
    const account = ref.accountId || tools.accountOfId(id);
    const found = tools.findByMessageId(this.engine, header, account);
    if (found || !account) return found || null;
    try {
      return (await this.engine.findMoved(account, header)) || null;
    } catch (err) {
      this.log('hub', 'finding a moved email failed:', err.message);
      return null;
    }
  }

  // Normalizes the email reference the renderer sends, filling gaps from the engine cache.
  messageRef(input) {
    if (!isObj(input) || !input.id) return null;
    const id = clip(input.id, 2000);
    const ref = {
      id,
      messageId: input.messageId ? clip(input.messageId, 1000) : null,
      accountId: input.accountId ? clip(input.accountId, 200) : null,
      subject: clip(input.subject || '', 1000),
      from: isObj(input.from) ? { name: clip(input.from.name || '', 200), address: clip(input.from.address || '', 320) } : null,
      date: Number(input.date) || null,
      // Keeps the /unsubscribe command for the chat once the email is no longer on screen.
      unsubscribe: input.unsubscribe === true
    };
    const cached = tools.cacheMessage(this.engine, id);
    if (cached) {
      if (!ref.unsubscribe && cached.unsubscribe) ref.unsubscribe = true;
      if (!ref.messageId && cached.messageId) ref.messageId = cached.messageId;
      if (!ref.subject) ref.subject = cached.subject || '';
      if (!ref.from && cached.from) ref.from = { name: cached.from.name || '', address: cached.from.address || '' };
      if (!ref.date) ref.date = cached.date || null;
      if (!ref.accountId) ref.accountId = id.split(':').map(decodeURIComponent)[0];
    }
    return ref;
  }

  create({ agent, message = null, origin = 'panel', title = '' } = {}) {
    const id = AGENT_IDS.includes(agent) ? agent : this.cfg.data.defaultAgent;
    if (this.cfg.data[id].enabled === false) throw new AgentError('disabled', `${id} is turned off`);
    const ref = this.messageRef(message);
    const now = Date.now();
    const c = {
      id: newConversationId(),
      agent: id,
      title: clip(ref && ref.subject ? ref.subject : title, 80),
      message: ref,
      origin: origin === 'external' ? 'external' : 'panel',
      createdAt: now,
      updatedAt: now,
      status: 'idle',
      provider: {},
      notes: [],
      // Set once a turn reached the agent; until then every message is a first turn with the email attached.
      delivered: false,
      items: []
    };
    this.conversations.set(c.id, c);
    this.enforceLimit(c);
    this.scheduleSave();
    this.emitConversation(c);
    return c;
  }

  // Keeps at most 150 panel conversations and 20 external ones, each counted on its own, so an agent calling
  // in from outside can never push out the user's own chats. The oldest idle ones go first; keep is the new one.
  enforceLimit(keep) {
    const external = keep.origin === 'external';
    const max = external ? MAX_EXTERNAL : MAX_CONVERSATIONS;
    const same = [...this.conversations.values()].filter((c) => (c.origin === 'external') === external);
    const idle = same.filter((c) => c !== keep && !this.turns.has(c.id)).sort((a, b) => a.updatedAt - b.updatedAt);
    for (let n = same.length; n > max && idle.length; n--) this.drop(idle.shift(), true);
  }

  remove(id) {
    const c = this.conversations.get(id);
    if (!c) return false;
    this.drop(c, false);
    this.scheduleSave();
    return true;
  }

  drop(c, quiet) {
    const turn = this.turns.get(c.id);
    if (turn) {
      turn.controller.abort();
      this.finishTurn(turn, { status: 'stopped' });
    }
    for (const [itemId, w] of this.approvals) {
      if (w.cid !== c.id) continue;
      this.approvals.delete(itemId);
      w.resolve('cancel');
    }
    this.followUps.delete(c.id);
    const token = this.convTokens.get(c.id);
    if (token) this.revokeToken(token);
    this.convTokens.delete(c.id);
    for (const [threadId, cid] of this.threads) if (cid === c.id) this.threads.delete(threadId);
    this.conversations.delete(c.id);
    const adapter = this.adapters.get(c.agent);
    // Optional adapter hook: lets Claude kill the process that belongs to this conversation.
    if (adapter && typeof adapter.forget === 'function') Promise.resolve().then(() => adapter.forget(c)).catch(() => {});
    this.emitEvent({ kind: 'conversation', conversation: { id: c.id, removed: true } });
    if (!quiet) this.log('hub', 'removed', c.id);
  }

  view(state) {
    const s = isObj(state) ? state : {};
    const str = (v, max) => (typeof v === 'string' && v ? v.slice(0, max) : null);
    const composer = isObj(s.composer)
      ? { mode: str(s.composer.mode, 20), replyToId: str(s.composer.replyToId, 2000), draftId: str(s.composer.draftId, 2000) }
      : null;
    this.viewState = {
      openMessageId: str(s.openMessageId, 2000),
      checkedIds: (Array.isArray(s.checkedIds) ? s.checkedIds : []).filter((v) => typeof v === 'string').slice(0, 50).map((v) => v.slice(0, 2000)),
      scope: str(s.scope, 200) || 'all',
      view: str(s.view, 40) || 'inbox',
      folder: str(s.folder, 1000),
      composer
    };
    return true;
  }

  openMessageId() {
    const id = this.viewState.openMessageId;
    return id && tools.cacheMessage(this.engine, id) ? id : null;
  }

  // The live id of a conversation's email, found like a source card's (locate): ids change when mail moves,
  // the Message-ID header does not, and a copy in another account belongs to another chat. The chat keeps
  // the id it finds.
  async currentMessageId(c) {
    const ref = c && c.message;
    if (!ref) return null;
    const found = await this.locate({ id: ref.id, messageHeader: ref.messageId, accountId: ref.accountId });
    // The chat may have been deleted while a folder synced.
    if (found && found !== ref.id && this.conversations.get(c.id) === c) {
      ref.id = found;
      this.touch(c);
    }
    return found;
  }

  // ---------- turns ----------

  send(id, { text, action = null, display = null } = {}) {
    const c = this.mustGet(id);
    if (this.disposed) throw new AgentError('stopped', 'Rukoo is closing');
    if (this.turns.has(c.id)) throw new AgentError('busy', 'a turn is running');
    if (this.cfg.data[c.agent].enabled === false) throw new AgentError('disabled', `${c.agent} is turned off`);
    const body = clip(text, 20000);
    if (!body.trim()) throw new AgentError('invalid', 'empty message');
    const firstTurn = !c.delivered;
    const shown = display ? clip(display, 20000) : body;
    // display can be an approved proposal's title. Email text the agent quoted in it keeps its <unsafe_content>
    // tags for the agent (runTurn gets them); the user's line and the chat title show the text alone.
    const line = display ? context.untag(shown) : shown;
    const userItem = this.addItem(c, { type: 'user', text: line, action: action || null });
    if (!c.title) c.title = clip(line.replace(/\s+/g, ' ').trim(), 80);
    const turn = {
      id: `t_${rand(10)}`,
      cid: c.id,
      controller: new AbortController(),
      items: new Set(),
      tools: new Map(),
      assistant: null,
      thinking: null,
      closed: false,
      errorShown: false,
      // Set once the agent shows it got the input: it streamed, called a tool or asked for approval.
      reached: false,
      stopTimer: null,
      forceStop: null
    };
    this.turns.set(c.id, turn);
    this.setStatus(c, 'running');
    this.runTurn(c, turn, { text: body, action, firstTurn, display: shown }).catch((err) => this.finishTurn(turn, { status: 'error', error: toError(err) }));
    return { conversationId: c.id, itemId: userItem.id };
  }

  async runTurn(c, turn, { text, action, firstTurn, display = '' }) {
    const adapter = this.adapters.get(c.agent);
    let result;
    if (action === 'approved') turn.approval = { display: display || text };
    try {
      if (!adapter) throw new AgentError('unknown', this.adapterErrors.get(c.agent) || `${c.agent} adapter not available`);
      // Mail work that still runs reports into the notes this turn takes: wait for all of it first, also for
      // what is decided while this waits.
      if (this.mailSettling.has(c.id)) {
        for (let work = this.mailSettling.get(c.id); work; work = this.mailSettling.get(c.id)) await work;
        if (turn.closed || turn.controller.signal.aborted) {
          this.giveBack(c, turn);
          return this.finishTurn(turn, { status: 'stopped' });
        }
      }
      let message = null;
      if (firstTurn && c.message) {
        const liveId = await this.currentMessageId(c);
        const full = liveId ? await this.engine.getMessage(liveId).catch(() => null) : null;
        // Stopped while the email was loading: stop() already closed the turn, and a newer turn may own the
        // notes by now. Touch nothing.
        if (turn.closed || turn.controller.signal.aborted) {
          // An approved follow-up stopped this early never reached the agent; keep the approval (the notes
          // are not taken yet, so nothing else changes).
          this.giveBack(c, turn);
          return this.finishTurn(turn, { status: 'stopped' });
        }
        if (full) {
          const acc = this.engine.accounts.find((a) => a.id === full.accountId);
          message = { full, account: acc ? acc.email : '', folder: full.folder || '' };
        }
      }
      let openMessage = null;
      const openId = this.openMessageId();
      const boundId = c.message ? c.message.id : null;
      if (!firstTurn && openId && openId !== boundId) {
        const m = tools.cacheMessage(this.engine, openId);
        openMessage = { id: openId, subject: m ? m.subject : '' };
      }
      const notes = c.notes.splice(0);
      turn.notes = notes;
      const input = context.turnText({ conversation: c, text, firstTurn, notes, message, openMessage });
      const port = this.mcp ? this.mcp.ports().local : null;
      const handle = {
        id: turn.id,
        conversation: c,
        input,
        instructions: context.instructions({ agent: c.agent, agentName: this.agentName(c.agent) }),
        text,
        action: action || null,
        firstTurn,
        mcp: { url: port ? `http://127.0.0.1:${port}/mcp` : '', token: this.tokenFor(c) },
        emit: (event) => this.onAdapterEvent(turn, event),
        approve: (request) => this.requestApproval(c.id, { ...(request || {}), source: c.agent, kind: 'runtime' }),
        setProvider: (patch) => {
          if (!isObj(patch)) return;
          c.provider = { ...c.provider, ...patch };
          if (patch.threadId) this.mapThread(patch.threadId, c.id);
          this.touch(c);
        },
        // Optional for adapters: call once the agent has the input, a more exact signal than its first output.
        accepted: () => {
          turn.reached = true;
        },
        signal: turn.controller.signal
      };
      const forced = new Promise((resolve) => {
        turn.forceStop = resolve;
      });
      // Never start the agent for a turn that is already stopped.
      if (turn.controller.signal.aborted) result = { status: 'stopped' };
      else result = await Promise.race([adapter.runTurn(handle), forced]);
    } catch (err) {
      result = { status: 'error', error: toError(err) };
    }
    // A turn that never reached the agent (offline, not installed, stopped early) uses up nothing: the next
    // message is still a first turn with the email, and the notes go along with it.
    if (turn.reached || (result && result.status === 'done')) {
      if (!c.delivered) {
        c.delivered = true;
        this.touch(c);
      }
    } else this.giveBack(c, turn);
    this.finishTurn(turn, result || { status: 'error', error: { code: 'protocol', detail: 'the adapter returned nothing' } });
  }

  tokenFor(c) {
    let token = this.convTokens.get(c.id);
    if (!token) {
      token = this.issueToken({ agent: c.agent, conversationId: c.id });
      this.convTokens.set(c.id, token);
    }
    return token;
  }

  onAdapterEvent(turn, event) {
    if (turn.closed || !isObj(event)) return;
    const c = this.conversations.get(turn.cid);
    if (!c) return;
    if (REACHED.has(event.type)) turn.reached = true;
    const now = Date.now();
    const own = (fields) => {
      const item = this.addItem(c, fields);
      turn.items.add(item.id);
      return item;
    };
    // Text after any other item starts a new bubble; anything that is not thinking ends the thinking state.
    const endThinking = () => {
      if (turn.thinking && turn.thinking.status === 'running') {
        Object.assign(turn.thinking, { status: 'done', endedAt: now });
        this.updateItem(c, turn.thinking);
      }
      turn.thinking = null;
    };
    const endText = () => {
      if (turn.assistant && turn.assistant.status === 'streaming') {
        turn.assistant.status = 'done';
        this.updateItem(c, turn.assistant);
      }
      turn.assistant = null;
    };
    switch (event.type) {
      case 'text': {
        const delta = String(event.delta || '');
        if (!delta) return;
        endThinking();
        if (!turn.assistant) {
          turn.assistant = own({ type: 'assistant', text: delta.slice(0, MAX_TEXT), status: 'streaming', interim: false });
          return;
        }
        const room = MAX_TEXT - turn.assistant.text.length;
        if (room <= 0) return;
        const piece = delta.slice(0, room);
        turn.assistant.text += piece;
        // No save per delta: the next item, the end of the turn or quitting saves the text.
        c.updatedAt = now;
        this.queueDelta(c.id, turn.assistant.id, piece);
        return;
      }
      case 'commentary': {
        const text = String(event.text || '').trim();
        if (!text) return;
        endThinking();
        endText();
        own({ type: 'assistant', text, status: 'done', interim: true });
        return;
      }
      case 'thinking': {
        const delta = String(event.delta || '');
        endText();
        if (!turn.thinking) {
          turn.thinking = own({ type: 'thinking', text: delta.slice(0, MAX_TEXT), status: 'running', startedAt: now, endedAt: null });
          return;
        }
        if (!delta) return;
        const piece = delta.slice(0, Math.max(0, MAX_TEXT - turn.thinking.text.length));
        if (!piece) return;
        turn.thinking.text += piece;
        this.queueDelta(c.id, turn.thinking.id, piece);
        return;
      }
      case 'thinking-done':
        endThinking();
        return;
      case 'tool-start': {
        endThinking();
        endText();
        const name = clip(event.name || 'tool', 200);
        const key = String(event.key || `${name}#${turn.tools.size}`);
        const item = own({
          type: 'tool',
          name,
          label: toolLabel(name),
          detail: chipDetail(event.detail),
          status: 'running',
          startedAt: now,
          endedAt: null,
          rukoo: tools.isRukooTool(name)
        });
        turn.tools.set(key, item);
        return;
      }
      case 'tool-end': {
        const item = turn.tools.get(String(event.key || ''));
        if (!item || item.status !== 'running') return;
        item.status = event.error ? 'error' : 'done';
        item.endedAt = now;
        if (event.detail) item.detail = chipDetail(event.detail);
        this.updateItem(c, item);
        return;
      }
      case 'error': {
        endThinking();
        endText();
        const err = toError(event);
        turn.errorShown = true;
        turn.lastError = err;
        own({ type: 'notice', text: ERROR_TEXT[err.code], detail: err.detail, tone: 'error', code: err.code, undo: null });
        return;
      }
      case 'notice': {
        // Informational lines from an adapter, e.g. "Codex started a new thread".
        const text = clip(oneLine(event.text), 500);
        if (!text) return;
        endThinking();
        endText();
        own({ type: 'notice', text, tone: ['info', 'success', 'error'].includes(event.tone) ? event.tone : 'info', code: event.code || null, undo: null });
        return;
      }
      default:
        // 'usage' and anything newer: ignored for now.
        return;
    }
  }

  // Stop ends the turn, not what the user already approved: a queued approval follow-up still starts once
  // the turn has ended (SPEC 4.4 step 6).
  stop(id) {
    const turn = this.turns.get(id);
    if (!turn) return false;
    turn.controller.abort();
    this.expireTurnApprovals(turn);
    // Still loading the email: no adapter runs yet, so there is nothing to wait for.
    if (!turn.forceStop) {
      this.finishTurn(turn, { status: 'stopped' });
      return true;
    }
    if (!turn.stopTimer) turn.stopTimer = setTimeout(() => turn.forceStop && turn.forceStop({ status: 'stopped' }), STOP_GRACE_MS);
    return true;
  }

  expireTurnApprovals(turn) {
    for (const [itemId, w] of this.approvals) {
      if (w.turnId !== turn.id) continue;
      this.expireApproval(w.cid, itemId);
    }
  }

  finishTurn(turn, result) {
    if (turn.closed) return;
    turn.closed = true;
    clearTimeout(turn.stopTimer);
    if (this.turns.get(turn.cid) === turn) this.turns.delete(turn.cid);
    const c = this.conversations.get(turn.cid);
    const status = ['done', 'stopped', 'error'].includes(result && result.status) ? result.status : 'error';
    this.expireTurnApprovals(turn);
    if (!c) return;
    const now = Date.now();
    for (const item of c.items) {
      if (!turn.items.has(item.id)) continue;
      let changed = false;
      if (item.type === 'assistant' && item.status === 'streaming') {
        item.status = status === 'stopped' ? 'stopped' : 'done';
        changed = true;
      } else if ((item.type === 'thinking' || item.type === 'tool') && item.status === 'running') {
        Object.assign(item, { status: 'done', endedAt: now });
        changed = true;
      }
      if (changed) this.updateItem(c, item);
    }
    let error = null;
    if (status === 'error') {
      error = (result && result.error && toError(result.error)) || turn.lastError || { code: 'unknown', detail: '' };
      if (!turn.errorShown) this.addItem(c, { type: 'notice', text: ERROR_TEXT[error.code], detail: error.detail, tone: 'error', code: error.code, undo: null });
    }
    this.setStatus(c, status === 'error' ? 'error' : 'idle', error);
    if (error && ['offline', 'unauthorized', 'not-configured', 'not-installed', 'spawn-failed'].includes(error.code)) {
      this.refreshStatus().catch(() => {});
    }
    if (this.disposed) return;
    const queue = this.followUps.get(c.id);
    const next = queue && queue.shift();
    if (queue && !queue.length) this.followUps.delete(c.id);
    if (next) setImmediate(() => this.sendFollowUp(c.id, next));
  }

  sendFollowUp(cid, message) {
    if (this.disposed || !this.conversations.has(cid)) return;
    try {
      this.send(cid, message);
    } catch (err) {
      const c = this.conversations.get(cid);
      const e = toError(err);
      if (!c) return;
      this.addItem(c, { type: 'notice', text: ERROR_TEXT[e.code] || ERROR_TEXT.unknown, detail: e.detail, tone: 'error', code: e.code, undo: null });
      if (message.action === 'approved') this.keepApproval(c, message);
    }
  }

  // A turn that never reached the agent (offline, failed to start, stopped first) uses up nothing: the notes it
  // took go back, and an approved follow-up's approval is kept, so the next message still tells the agent what
  // the user said yes to. Once per turn, from runTurn() or from dispose(), whichever comes first.
  giveBack(c, turn) {
    if (turn.givenBack) return;
    turn.givenBack = true;
    if (turn.notes && turn.notes.length) {
      c.notes.unshift(...turn.notes);
      this.touch(c);
    }
    if (turn.approval) this.keepApproval(c, turn.approval);
  }

  // An approval whose follow-up turn could not start. The agent hears about it with the next message, and
  // the card's "Approved" does not pretend it was carried out.
  keepApproval(c, message) {
    c.notes.push(`The user approved: ${message.display}. You were not told until now, so it has not been done; check with the user before you carry it out.`);
    const title = context.untag(message.display);
    this.addItem(c, { type: 'notice', text: `Not done yet: ${title}. ${this.agentName(c.agent)} hears about your approval with your next message.`, tone: 'info', code: 'kept-approval', params: { title: title.slice(0, 200) }, undo: null });
  }

  // ---------- approvals ----------

  requestApproval(cid, { title, detail = '', fields = [], choices = [], source = 'rukoo', kind = 'runtime', key = null, mail = null, tool = null } = {}) {
    const c = this.mustGet(cid);
    const cleanChoices = (Array.isArray(choices) ? choices : [])
      .filter((ch) => isObj(ch) && ch.id)
      .slice(0, 6)
      .map((ch) => ({ id: clip(ch.id, 60), label: clip(ch.label || ch.id, 60), kind: ['primary', 'danger', 'default'].includes(ch.kind) ? ch.kind : 'default' }));
    const cleanTool = approvalTool(tool);
    const shownChoices = cleanChoices.length
      ? cleanChoices
      : [
          { id: 'allow', label: 'Allow', kind: 'primary' },
          { id: 'deny', label: 'Deny', kind: 'danger' }
        ];
    const shownFields = foldFields((Array.isArray(fields) ? fields : []).filter(isObj)).map(approvalField);
    // Allow passes on the whole input, so a card that cannot show all of it is declined without asking.
    // The adapter gets its own deny choice: cancel would end a Codex turn and leave Hermes unanswered.
    const refusal = shownFields.some((f) => f.truncated)
      ? shownChoices.find((ch) => ch.id !== 'cancel' && DENY_IDS.has(ch.id)) || shownChoices.find((ch) => ch.kind === 'danger') || { id: 'cancel' }
      : null;
    const item = this.addItem(c, {
      type: 'approval',
      title: clip(title || 'Approval needed', 200),
      detail: clip(detail, 2000),
      fields: shownFields,
      ...(cleanTool ? { tool: cleanTool } : {}),
      choices: shownChoices,
      status: refusal ? 'denied' : 'pending',
      decision: refusal ? refusal.id : null,
      source,
      kind,
      ...(mail ? { mail } : {})
    });
    const turn = kind === 'runtime' ? this.turns.get(cid) : null;
    if (turn) {
      turn.items.add(item.id);
      turn.reached = true;
    }
    if (refusal) {
      const shownTitle = context.untag(item.title);
      this.addItem(c, { type: 'notice', text: `Declined without asking: ${shownTitle}. Its input is too long to show here in full.`, tone: 'info', code: 'approval-too-long', params: { title: shownTitle }, undo: null });
      // A runtime request gets the denial as its answer; a proposal or mail action is told with the next message.
      if (kind !== 'runtime') c.notes.push(`Rukoo declined ${kind === 'mail' ? context.unsafeInline(item.title, 'mail action') : `"${oneLine(item.title)}"`} without asking the user: its input was too long to show in full. Ask again with shorter input.`);
      const declined = Promise.resolve(refusal.id);
      declined.itemId = item.id;
      return declined;
    }
    let resolve;
    const promise = new Promise((r) => {
      resolve = r;
    });
    promise.itemId = item.id;
    this.approvals.set(item.id, { cid, resolve, key: key == null ? null : String(key), turnId: turn ? turn.id : null });
    // A runtime approval outside a running turn has nobody to answer it.
    if (kind === 'runtime' && !turn) this.expireApproval(cid, item.id);
    return promise;
  }

  // itemOrKey: the approval item id, or the key the adapter passed with the request (e.g. a request id).
  expireApproval(cid, itemOrKey) {
    const c = this.conversations.get(cid);
    for (const [itemId, w] of this.approvals) {
      if (w.cid !== cid || (itemId !== itemOrKey && (w.key === null || w.key !== String(itemOrKey)))) continue;
      this.approvals.delete(itemId);
      const item = c && c.items.find((i) => i.id === itemId);
      if (item && item.status === 'pending') {
        item.status = 'expired';
        this.updateItem(c, item);
      }
      w.resolve('cancel');
      return true;
    }
    return false;
  }

  decide(cid, itemId, choiceId) {
    const c = this.mustGet(cid);
    const item = c.items.find((i) => i.id === itemId && i.type === 'approval');
    if (!item) throw new AgentError('invalid', 'unknown approval');
    if (item.status !== 'pending') return item;
    const choice = item.choices.find((ch) => ch.id === choiceId);
    if (!choice) throw new AgentError('invalid', 'unknown choice');
    const denied = choice.kind === 'danger' || DENY_IDS.has(choice.id);
    item.status = denied ? 'denied' : 'approved';
    item.decision = choice.id;
    this.updateItem(c, item);
    const waiter = this.approvals.get(itemId);
    this.approvals.delete(itemId);
    if (waiter) waiter.resolve(choice.id);
    if (item.kind === 'proposal') this.onProposal(c, item, !denied);
    if (item.kind === 'mail') {
      this.settleMail(c, () => this.onMailDecision(c, item, !denied), item.title);
    }
    return item;
  }

  // Mail work whose outcome goes into the notes of the agent's next message: a decision on a mail action, or an
  // action that ran without asking and outlasted its tool call. One chain per conversation, in order; runTurn()
  // waits until the chain is done.
  // label names the work for a note when Rukoo quits before it is done (see dispose()).
  settleMail(c, work, label = '') {
    const before = this.mailSettling.get(c.id);
    // Nothing queued: start at once, so a decision's own note is there when decide() returns.
    const started = before ? before.then(work) : new Promise((resolve) => resolve(work()));
    const running = this.mailRunning.get(c.id) || new Set();
    const entry = { label };
    running.add(entry);
    this.mailRunning.set(c.id, running);
    const op = started
      .catch((err) => {
        const e = toError(err);
        this.addItem(c, { type: 'notice', text: ERROR_TEXT[e.code], detail: e.detail, tone: 'error', code: e.code, undo: null });
      })
      .finally(() => {
        running.delete(entry);
        if (!running.size && this.mailRunning.get(c.id) === running) this.mailRunning.delete(c.id);
      });
    this.mailSettling.set(c.id, op);
    op.then(() => {
      if (this.mailSettling.get(c.id) === op) this.mailSettling.delete(c.id);
    });
    return op;
  }

  // A proposal is the agent's text as it wrote it. Email text it quoted keeps its <unsafe_content> tags when Rukoo
  // repeats the proposal, so it never reaches the agent as the user's words; the user's own line shows no tags.
  onProposal(c, item, approved) {
    if (!approved) {
      c.notes.push(`The user declined: ${item.title}.`);
      this.addItem(c, { type: 'user', text: context.untag(item.title), action: 'declined' });
      return;
    }
    // The agent may not remember the proposal (another channel, a new session), so repeat what was approved.
    const lines = [`Approved: ${item.title}. Go ahead and do it now, then report back briefly.`];
    if (item.detail) lines.push(`Details you proposed: ${item.detail}`);
    for (const f of item.fields || []) lines.push(`${f.label}: ${f.value}`);
    const message = { text: lines.join('\n'), display: item.title, action: 'approved' };
    if (this.turns.has(c.id)) {
      const queue = this.followUps.get(c.id) || [];
      queue.push(message);
      this.followUps.set(c.id, queue);
    } else {
      this.sendFollowUp(c.id, message);
    }
  }

  // Mail titles and results hold sender names and subjects, which come from the email: tagged as unsafe content.
  async onMailDecision(c, item, approved) {
    if (!approved) {
      c.notes.push(`The user declined: ${context.unsafeInline(item.title, 'mail action')}.`);
      this.touch(c);
      return;
    }
    const result = await tools.executeMail(this, c, item.mail || {});
    c.notes.push(`The user approved: ${context.unsafeInline(item.title, 'mail action')}. Rukoo: ${context.unsafeInline(result.text, 'mail result')}.`);
    this.touch(c);
  }

  // The renderer's one write to an item: the user undid an agent's draft in the composer, or redid it.
  patchItem(cid, itemId, patch) {
    const c = this.mustGet(cid);
    const item = c.items.find((i) => i.id === itemId);
    if (!item || item.type !== 'draft') throw new AgentError('invalid', 'unknown draft');
    if (!isObj(patch) || Object.keys(patch).some((k) => k !== 'undone') || typeof patch.undone !== 'boolean') {
      throw new AgentError('invalid', 'only {undone: true|false} can change');
    }
    item.undone = patch.undone;
    return this.updateItem(c, item);
  }

  async undo(cid, itemId) {
    const c = this.mustGet(cid);
    const item = c.items.find((i) => i.id === itemId && i.type === 'notice');
    if (!item || !item.undo || item.undo.kind !== 'move') throw new AgentError('invalid', 'nothing to undo');
    const ids = item.undo.ids || [];
    item.undo = null;
    this.updateItem(c, item);
    // On the mail chain like any other mail work: after what was asked for before it, and the next message
    // waits for it, so the agent hears about the undo before it looks at the mail again.
    let out = { restored: 0, failed: ids.length };
    await this.settleMail(
      c,
      async () => {
        let restored = 0;
        const failed = [];
        for (const id of ids) {
          try {
            await this.engine.undoMove(id);
            restored++;
          } catch (err) {
            failed.push(err.message);
          }
        }
        const text = failed.length
          ? `Restored ${restored} of ${ids.length} email${ids.length === 1 ? '' : 's'}. ${failed[0]}`
          : `Restored ${restored} email${restored === 1 ? '' : 's'}`;
        this.addItem(c, { type: 'notice', text, tone: failed.length && !restored ? 'error' : 'info', code: null, undo: null, mail: { action: 'undo', count: restored, failed: failed.length, folder: null } });
        c.notes.push(`The user undid ${context.unsafeInline(item.text, 'mail result')}. ${text}.`);
        this.touch(c);
        out = { restored, failed: failed.length };
      },
      `Undo: ${item.text}`
    );
    return out;
  }

  // ---------- tokens and identities ----------

  issueToken({ agent, conversationId = null } = {}) {
    const token = crypto.randomBytes(32).toString('base64url');
    this.tokens.push({ token, hash: sha256(token), identity: { agent, conversationId: conversationId || null, remote: false } });
    return token;
  }

  revokeToken(token) {
    this.tokens = this.tokens.filter((t) => t.token !== token);
  }

  // Constant-time compare of sha256 digests; every entry is checked so timing does not reveal a match position.
  identify(token) {
    if (typeof token !== 'string' || !token || token.length > 512) return null;
    const hash = sha256(token);
    let found = null;
    for (const t of this.tokens) if (crypto.timingSafeEqual(t.hash, hash)) found = t.identity;
    if (this.remoteHash && crypto.timingSafeEqual(this.remoteHash, hash)) found = { agent: 'clark', conversationId: null, remote: true };
    return found ? { ...found } : null;
  }

  mapThread(threadId, cid) {
    if (threadId && this.conversations.has(cid)) this.threads.set(String(threadId), cid);
  }

  resolveConversation(identity, args = {}, meta = {}) {
    if (!identity) return null;
    const own = (id) => {
      const c = typeof id === 'string' && id ? this.conversations.get(id) : null;
      return c && c.agent === identity.agent ? c : null;
    };
    // A per-chat token speaks for its own chat only. A stale or forged conversation_id must not move its
    // calls into another chat of the same agent; only tokens without a chat (Codex, Clark) are routed by it.
    if (identity.conversationId) return own(identity.conversationId);
    const byArg = own(args && args.conversation_id);
    if (byArg) return byArg;
    const codex = meta && isObj(meta['x-codex-turn-metadata']) ? meta['x-codex-turn-metadata'].thread_id : null;
    const threadId = (meta && meta.threadId) || codex;
    const mapped = threadId ? own(this.threads.get(String(threadId))) : null;
    if (mapped) return mapped;
    const running = [...this.turns.keys()].map((id) => this.conversations.get(id)).filter((c) => c && c.agent === identity.agent);
    return running.length === 1 ? running[0] : null;
  }

  // Tools that put something on screen need a conversation. A call from outside a panel chat (Clark on
  // WhatsApp, say) goes to the agent's external conversation about the open email, so a request that shows a
  // plan and then asks for approval stays in one chat. Only a new one is revealed in the panel. Tool results
  // carry its conversation_id, so the agent can keep using it.
  ensureConversation(call) {
    if (call.conversation) return call.conversation;
    const reuse = this.externalFor(call.agent);
    if (reuse) {
      call.conversation = reuse;
      return reuse;
    }
    const open = this.openMessageId();
    const c = this.create({ agent: call.agent, message: open ? { id: open } : null, origin: 'external', title: this.agentName(call.agent) });
    call.conversation = c;
    this.emitEvent({ kind: 'reveal', conversationId: c.id });
    return c;
  }

  // The agent's recent external conversation about the email that is open now (or about no email), if any.
  externalFor(agent) {
    const open = this.openMessageId();
    const m = open ? tools.cacheMessage(this.engine, open) : null;
    const since = Date.now() - EXTERNAL_REUSE_MS;
    // The same email can sit in two accounts; a chat about one copy is not about the other.
    const account = tools.accountOfId(open);
    const about = (c) => {
      if (!m || !c.message) return !m && !c.message;
      const own = c.message.accountId || tools.accountOfId(c.message.id);
      if (account && own && own !== account) return false;
      if (m.messageId && c.message.messageId) return normId(m.messageId) === normId(c.message.messageId);
      return c.message.id === open;
    };
    return (
      [...this.conversations.values()]
        .filter((c) => c.origin === 'external' && c.agent === agent && c.updatedAt >= since && about(c))
        .sort((a, b) => b.updatedAt - a.updatedAt)[0] || null
    );
  }

  listTools() {
    return tools.list();
  }

  callTool(identity, name, args, meta) {
    return tools.callTool(this, identity, name, args, meta);
  }

  // ---------- UI bridge ----------

  ui(action, args = {}, timeoutMs = 10000) {
    const hasWindow = this.deps.hasWindow ? this.deps.hasWindow() : this.listenerCount('event') > 0;
    if (!hasWindow || this.disposed) return Promise.reject(new AgentError('window', 'the main window is closed'));
    const requestId = `u_${rand(10)}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.uiPending.delete(requestId);
        reject(new AgentError('timeout', `the window did not answer ${action}`));
      }, timeoutMs);
      this.uiPending.set(requestId, { resolve, reject, timer });
      // The deadline lets a window that only gets the request late (its panel was still loading) skip it.
      this.emitEvent({ kind: 'ui', requestId, action, args, deadline: Date.now() + timeoutMs });
    });
  }

  uiReply(requestId, ok, result) {
    const p = this.uiPending.get(requestId);
    if (!p) return false;
    this.uiPending.delete(requestId);
    clearTimeout(p.timer);
    if (ok) p.resolve(result === undefined ? null : result);
    else if (isObj(result) && typeof result.code === 'string') p.reject(new AgentError(ERROR_TEXT[result.code] ? result.code : 'unknown', result.detail || result.message || result.code));
    else p.reject(new AgentError('unknown', typeof result === 'string' ? result : 'the window reported an error'));
    return true;
  }

  // ---------- config and status (renderer API) ----------

  config() {
    const view = this.cfg.publicView();
    for (const id of ['claude', 'codex']) {
      const a = this.adapters.get(id);
      try {
        // Optional adapter hook, used as the placeholder of the program path field.
        const exe = a && typeof a.defaultExe === 'function' ? a.defaultExe() : '';
        view[id].detectedExe = typeof exe === 'string' ? exe : '';
      } catch (_) {
        view[id].detectedExe = '';
      }
    }
    return view;
  }

  async updateConfig(patch) {
    const before = JSON.stringify(this.cfg.data.mcp);
    this.cfg.update(patch);
    if (JSON.stringify(this.cfg.data.mcp) !== before && this.mcp) {
      if (this.cfg.data.mcp.port !== JSON.parse(before).port) {
        await this.mcp.close();
        await this.startMcp().catch((err) => {
          this.cfg.runtime.note = `MCP server did not start: ${err.message}`;
        });
      } else {
        await this.startRemote();
      }
    }
    this.configChanged();
    return this.config();
  }

  setSecret(agent, value) {
    this.cfg.setSecret(agent, value);
    this.configChanged();
    return this.config();
  }

  rotateToken() {
    const token = this.cfg.rotateRemoteToken();
    this.remoteHash = sha256(token);
    return this.config();
  }

  copyHermesSetup() {
    const text = this.cfg.hermesSetup();
    this.remoteHash = sha256(this.cfg.remoteToken());
    if (this.deps.clipboard) this.deps.clipboard.writeText(text);
    return true;
  }

  configChanged() {
    for (const a of this.adapters.values()) {
      // Optional adapter hook: restart processes that run with old settings.
      if (typeof a.configChanged === 'function') Promise.resolve().then(() => a.configChanged()).catch(() => {});
    }
    this.refreshStatus({ force: true }).catch(() => {});
  }

  async agentStatus(id, force = false) {
    if (!AGENT_IDS.includes(id)) throw new AgentError('invalid', 'unknown agent');
    if (this.cfg.data[id].enabled === false) return { state: 'disabled', detail: '' };
    const a = this.adapters.get(id);
    if (!a) return { state: 'unknown', detail: this.adapterErrors.get(id) || 'adapter not available' };
    try {
      // force and fresh mean the same: skip the adapter's 30 s status cache (Test connection).
      const s = await withTimeout(a.status({ force, fresh: force }), 12000);
      return { state: s && STATES.has(s.state) ? s.state : 'unknown', detail: clip((s && s.detail) || '', 300) };
    } catch (err) {
      return { state: 'unknown', detail: clip(err && (err.detail || err.message), 300) };
    }
  }

  // Probes overlap: the startup check, a saved URL or key, Test. A forced probe asks with the settings as they
  // are now, so an older probe of that agent that answers after it is dropped; it may have used the old URL
  // or key. An unforced probe can answer from the adapter's cache, so it never drops a forced one.
  // Returns whether the published status changed.
  async probeStatus(id, force) {
    if (force && this.statusRound.has(id)) this.statusRound.set(id, this.statusRound.get(id) + 1);
    const round = this.statusRound.get(id);
    const s = await this.agentStatus(id, force);
    if (this.statusRound.get(id) !== round) return false;
    const changed = JSON.stringify(s) !== JSON.stringify(this.statuses[id]);
    this.statuses = { ...this.statuses, [id]: s };
    return changed;
  }

  async refreshStatus({ force = false } = {}) {
    const changed = await Promise.all(AGENT_IDS.map((id) => this.probeStatus(id, force)));
    if (changed.includes(true) || force) this.emitEvent({ kind: 'agents', status: this.statuses });
    return this.statuses;
  }

  status() {
    return this.refreshStatus();
  }

  async test(agent) {
    await this.probeStatus(agent, true);
    this.emitEvent({ kind: 'agents', status: this.statuses });
    return this.statuses[agent];
  }
}

function oneLine(v) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
}

// A tool chip's detail comes from the arguments the agent passed, which may be values it copied from a tool
// result with their <unsafe_content> tags. The tags are for the agent; the user sees the value.
// Hermes clips its previews on the server, which can cut a tag in half, so a dangling piece of one at the end
// goes too. Only with signs of a cut: an ellipsis at the end, or enough of the tag's name that it can't be a
// value's own text; "price <" or "n <u" stay.
const TAG_TAIL = /<\/?(u(?:n(?:s(?:a(?:f(?:e(?:_(?:c(?:o(?:n(?:t(?:e(?:n(?:t)?)?)?)?)?)?)?)?)?)?)?)?)?)?(?:\s(?:"[^"]*(?:"|$)|[^"<>])*)?(…|\.\.\.)?$/i;
function chipDetail(v) {
  let text = context.untag(v);
  const tail = TAG_TAIL.exec(text);
  if (tail && (tail[2] || (tail[1] || '').length >= 3)) text = text.slice(0, tail.index);
  return clip(oneLine(text), 200);
}

// Untrusted text inside a note: one line, clipped, in JSON quotes so it cannot pose as Rukoo's own words.

// Adapter events that show the agent got the turn's input.
const REACHED = new Set(['text', 'commentary', 'thinking', 'tool-start']);

// The user approves what the card shows, so values pass through whole up to FIELD_MAX. A longer value keeps
// FIELD_MAX characters and says how many were cut. key tells the renderer which translated label to use.
const FIELD_MAX = 20000;
const FIELD_KEYS = new Set(['command', 'folder', 'file', 'path', 'url', 'query', 'pattern', 'content', 'before', 'after', 'diff', 'reason', 'input']);
const TOOL_KINDS = new Set(['command', 'readFile', 'changeFiles', 'web', 'mcp', 'permissions', 'other']);

// Allowing an approval allows all of its input, so nothing may be left out of the card. Past 12 fields the
// rest is folded into one "Other input" field instead of being cut.
const MAX_FIELDS = 12;
function foldFields(fields) {
  if (fields.length <= MAX_FIELDS) return fields;
  const rest = fields.slice(MAX_FIELDS - 1).map((f) => `${f.label || f.key || 'input'}: ${typeof f.value === 'string' ? f.value : JSON.stringify(f.value)}`);
  return [...fields.slice(0, MAX_FIELDS - 1), { key: 'input', label: 'Other input', value: rest.join('\n') }];
}

function approvalField(f) {
  const value = String(f.value == null ? '' : f.value);
  const out = { label: clip(f.label, 80), value: value.slice(0, FIELD_MAX) };
  if (FIELD_KEYS.has(f.key)) out.key = f.key;
  if (value.length > FIELD_MAX) out.truncated = value.length - FIELD_MAX;
  return out;
}

function approvalTool(tool) {
  if (!isObj(tool)) return null;
  const out = { name: clip(tool.name, 200), kind: TOOL_KINDS.has(tool.kind) ? tool.kind : 'other' };
  if (out.kind === 'mcp') {
    out.server = clip(tool.server, 120);
    out.tool = clip(tool.tool, 200);
  }
  return out;
}

const RUKOO_LABELS = {
  get_context: 'Read the email',
  read_message: 'Read the email',
  search_mail: 'Searched mail',
  write_draft: 'Wrote the draft',
  get_draft: 'Checked the draft',
  show_plan: 'Showed a plan',
  show_sources: 'Showed sources',
  propose_action: 'Asked for approval',
  mail_action: 'Proposed a mail action',
  read_attachment: 'Read an attachment'
};
const COMMANDS = /^(bash|terminal|shell|powershell|command|commandexecution|exec(_command)?|run_command|local_shell|execute_code)$/i;
const BUILTINS = [
  [/^(websearch|web_search|websearchtool|search_web)$/i, 'Searched the web'],
  [/^(webfetch|web_fetch|web_extract|fetch_url|browser.*)$/i, 'Opened a web page'],
  [/^(read|read_file|view|cat)$/i, 'Read a file'],
  [/^(write|edit|multiedit|filechange|apply_patch|write_file|patch)$/i, 'Changed files'],
  [/^(task|agent|delegate_task|subagent.*|collabagenttoolcall)$/i, 'Ran a subagent'],
  [/^(glob|grep|ls|search_files)$/i, 'Looked through files'],
  [/^(todowrite|todo)$/i, 'Updated its to-do list'],
  [/^toolsearch$/i, 'Looked up tools'],
  [/^memory$/i, 'Checked its memory']
];

// Short human label for a tool chip. Rukoo's tools get their own phrasing; others show "server · tool".
function toolLabel(name) {
  const n = String(name || '');
  const bare = tools.bareName(n);
  if (tools.isRukooTool(n) && RUKOO_LABELS[bare]) return RUKOO_LABELS[bare];
  if (COMMANDS.test(n)) return 'Ran a command';
  const mcp = /^mcp__([^_].*?)__(.+)$/.exec(n) || /^mcp_([a-z0-9-]+)_(.+)$/i.exec(n);
  if (mcp) return `${mcp[1]} · ${mcp[2]}`;
  for (const [re, label] of BUILTINS) if (re.test(n)) return label;
  return n;
}

module.exports = { AgentHub, toolLabel, ERROR_TEXT, MAX_ITEMS, MAX_CONVERSATIONS, MAX_TEXT };
