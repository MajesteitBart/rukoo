#!/usr/bin/env node
'use strict';

// The reference agent runner: connects one Rukoo agent account to one agent runtime. Plain Node.js 22 or newer,
// without dependencies. README.md explains it; server/WORKSPACES.md ("Agents in channels") is the protocol.
//
//   node integrations/agent-runner/runner.js --config agent.json [--once] [--check]
//
// The loop: read the agent's settings (GET /agents/me), follow the feed (GET /changes) on every wake of the socket and
// at least every 60 seconds, read each room's new events in order, and answer each message that mentions the agent and
// that its settings allow, with a reply in the message's thread. The server checks the same settings again and keeps
// one reply per trigger, so a restart never posts twice.

const fs = require('fs');
const path = require('path');
const { Rukoo, RukooError, KeyRefused, uuidv7, retryAfter } = require('./rukoo');
const { makeBackend, BackendError } = require('./backends');
const { buildInput, cleanAnswer, convertMentions, splitReply } = require('./prompt');

const DEFAULT_KEY_ENV = 'RUKOO_AGENT_KEY';
// Version 2 keeps an answer being posted per channel; version 1 kept one for the whole workspace.
const STATE_VERSION = 2;
// Pages of 100 events the runner reads back for a trigger's context, at most.
const CONTEXT_PAGES = 10;
// Pages of 100 events the runner reads back from the read position for the trigger of the agent's newest reply, at
// most (lookback()): 5,000 events, many more than a busy channel gets while a runtime answers one mention.
const LOOKBACK_PAGES = 50;
// A post that fails with no answer or a server error is sent again this often, with the same operation ID.
const POST_TRIES = 5;
// How long stop() lets a turn in flight end before run() returns: a program the backend started is ended with what it
// started, and a run of the Runs API gets its stop request.
const STOP_GRACE = 4000;

const sleep = (ms, signal) =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (signal) signal.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true });
  });

function defaultLog(level, message) {
  process.stderr.write(`${new Date().toISOString()} ${level} ${message}\n`);
}

// ---- Config ----

function int(value, fallback, min, max) {
  const n = Number(value);
  if (value === undefined || value === null || !Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

// The config as the runner uses it. dir: where relative paths start; name: the config file's name without .json, for
// the default state file next to it.
function normalizeConfig(raw, { dir = process.cwd(), name = 'agent', env = process.env } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('The config must be a JSON object');
  if (!raw.server) throw new Error('The config needs "server", the address of the Rukoo server');
  if (!raw.workspace) throw new Error('The config needs "workspace", the workspace id (w_…)');
  if (!raw.backend || typeof raw.backend !== 'object') throw new Error('The config needs "backend"');
  const keyEnv = typeof raw.keyEnv === 'string' && raw.keyEnv.trim() ? raw.keyEnv.trim() : DEFAULT_KEY_ENV;
  const key = typeof raw.key === 'string' && raw.key.trim() ? raw.key.trim() : String(env[keyEnv] || '').trim();
  if (!key) throw new Error(`No agent key: set "key" in the config, or the variable ${keyEnv}`);
  const context = raw.context && typeof raw.context === 'object' ? raw.context : {};
  let state = null;
  if (raw.state === false) state = null;
  else if (typeof raw.state === 'string' && raw.state.trim()) state = path.resolve(dir, raw.state.trim());
  else state = path.join(dir, `${name}.state.json`);
  return {
    server: String(raw.server),
    workspace: String(raw.workspace),
    key,
    keyEnv,
    allowHttp: raw.allowHttp === true,
    backend: raw.backend,
    context: {
      threadMessages: int(context.threadMessages, 50, 1, 200),
      channelMessages: int(context.channelMessages, 20, 0, 100),
      maxChars: int(context.maxChars, 30000, 2000, 1000000)
    },
    instructions: typeof raw.instructions === 'string' ? raw.instructions : '',
    state,
    pollSeconds: int(raw.pollSeconds, 30, 5, 60)
  };
}

function loadConfig(file, env = process.env) {
  const full = path.resolve(file);
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(full, 'utf8'));
  } catch (err) {
    throw new Error(`Could not read the config ${full}: ${err.message}`);
  }
  return normalizeConfig(raw, { dir: path.dirname(full), name: path.basename(full).replace(/\.json$/i, ''), env });
}

// ---- State ----
//
// A small file: per room the grant and the last event the runner handled, and per room an answer being posted
// (pending, by conversation id), so a restart sends its parts again with the same operation IDs. An answer's text
// leaves the file once it is posted.

function emptyState() {
  return { version: STATE_VERSION, agent: null, rooms: {}, pending: {} };
}

// A state file as this version keeps it, or null for one it can't read. Version 1's single answer becomes its room's.
function upgradeState(s) {
  if (!s || typeof s !== 'object' || !s.rooms || typeof s.rooms !== 'object') return null;
  const object = (v) => v && typeof v === 'object' && !Array.isArray(v);
  if (s.version === 1) {
    const p = s.pending;
    return { ...emptyState(), agent: s.agent ?? null, rooms: s.rooms, pending: object(p) && typeof p.conversation === 'string' ? { [p.conversation]: p } : {} };
  }
  if (s.version === STATE_VERSION) return { ...emptyState(), ...s, pending: object(s.pending) ? s.pending : {} };
  return null;
}

function readState(file, log) {
  if (!file) return emptyState();
  try {
    const s = upgradeState(JSON.parse(fs.readFileSync(file, 'utf8')));
    if (s) return s;
    log('warn', `The state file ${file} is from another version; starting from the server's read positions`);
  } catch (err) {
    if (err.code !== 'ENOENT') log('warn', `Could not read the state file ${file} (${err.message}); starting from the server's read positions`);
  }
  return emptyState();
}

function writeState(file, state) {
  if (!file) return;
  const text = JSON.stringify(state);
  const temp = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(temp, text, { mode: 0o600 });
  try {
    fs.renameSync(temp, file);
  } catch {
    // Windows can refuse to replace a file another process has open for a moment.
    fs.writeFileSync(file, text, { mode: 0o600 });
    fs.rmSync(temp, { force: true });
  }
}

// ---- The runner ----

class Runner {
  // config: normalizeConfig()'s result. backend: a stand-in for tests. log(level, message). retryMs: the first wait
  // before a post is sent again, doubled each time. report(event): what a program that started the runner shows of
  // its state, such as Rukoo's desktop app (src/main/agent-runs.js): { type: 'connected' | 'problems' | 'pass' |
  // 'unreachable' | 'answered' | 'failed' | 'refused', … }. Events carry ids, counts, codes the runner defines and at
  // most an HTTP status (failureOf), never text that a server, a backend or a message wrote.
  constructor(config, { log = defaultLog, backend, retryMs = 1000, report = () => {} } = {}) {
    this.config = config;
    this.log = log;
    this.report = (event) => {
      try {
        report(event);
      } catch {}
    };
    this.api = new Rukoo({ server: config.server, workspace: config.workspace, key: config.key, allowHttp: config.allowHttp });
    // Child processes never get the agent's key, or the backend's own secret, by name or by value.
    const b = config.backend && typeof config.backend === 'object' ? config.backend : {};
    const backendEnv = typeof b.keyEnv === 'string' ? b.keyEnv.trim() : '';
    const backendKey = typeof b.key === 'string' && b.key.trim() ? b.key.trim() : backendEnv ? String(process.env[backendEnv] || '').trim() : '';
    this.backend = backend || makeBackend(config.backend, { hide: { hideNames: [config.keyEnv, DEFAULT_KEY_ENV, backendEnv], hideValues: [config.key, backendKey] } });
    this.state = readState(config.state, log);
    this.rooms = new Map();
    this.dirty = new Set();
    // Rooms whose start this process checked against the agent's newest reply (lookback()).
    this.looked = new Set();
    this.cursor = null;
    // The feed said the settings or the people changed, and the runner hasn't read them since. No mention is handled
    // meanwhile.
    this.settingsStale = false;
    this.retryMs = retryMs;
    this.people = new Map();
    this.me = null;
    this.depthLimit = 3;
    this.generation = null;
    this.clockOffset = 0;
    this.stopped = false;
    this.abort = new AbortController();
    this.pumping = null;
    this.again = false;
    this.fatal = null;
    // What kept the last pass from finishing, for once().
    this.passError = null;
    this.stats = { answered: 0, skipped: 0, failed: 0, refused: 0 };
    this.onStop = null;
    this.finished = new Promise((resolve) => (this.onStop = resolve));
  }

  save() {
    try {
      writeState(this.config.state, this.state);
    } catch (err) {
      this.log('warn', `Could not write the state file: ${err.message}`);
    }
  }

  // Its requests end when the runner stops (this.abort), so stop() doesn't wait for a server that is slow to answer.
  async connect() {
    const info = await this.api.info({ signal: this.abort.signal });
    const w = info && info.workspace;
    if (!w) throw Object.assign(new Error('This server has no team chat'), { code: 'server' });
    if (!Array.isArray(w.capabilities) || !w.capabilities.includes('agents')) throw Object.assign(new Error('This server has agents turned off'), { code: 'server' });
    if (w.agents && Number.isSafeInteger(w.agents.depth)) this.depthLimit = w.agents.depth;
    await this.loadWorkspace();
    await this.loadSettings();
    if (this.state.agent && this.state.agent !== this.me.id) this.state = emptyState();
    this.state.agent = this.me.id;
    const answers =
      this.me.answers === 'everyone'
        ? 'everyone'
        : this.me.answers === 'sponsor'
          ? 'only its sponsor'
          : this.me.answers === 'members'
            ? `its sponsor and ${this.me.members.length} chosen ${this.me.members.length === 1 ? 'member' : 'members'}`
            : `only its sponsor (its setting ${JSON.stringify(String(this.me.answers))} is new to this runner)`;
    this.log('info', `Connected as agent ${this.me.id} in workspace ${this.api.workspace}. It answers ${answers}, ${this.me.agents ? 'and other agents' : 'not other agents'}.`);
    this.report({ type: 'connected', agent: this.me.id });
  }

  // The channels the agent is in, of the rooms the feed brought so far.
  channelCount() {
    return [...this.rooms.values()].filter((row) => row.kind === 'channel' && !row.archived).length;
  }

  async loadWorkspace() {
    const res = await this.api.workspaceInfo({ signal: this.abort.signal });
    this.workspace = { id: res.workspace.id, name: res.workspace.name };
    this.generation = res.workspace.generation;
    if (Number.isFinite(res.workspace.time)) this.clockOffset = res.workspace.time - Date.now();
  }

  // The agent's settings: its name, its sponsor, whom it answers and whether it answers other agents.
  async loadMe() {
    const me = await this.api.me({ signal: this.abort.signal });
    this.me = { ...me, members: Array.isArray(me.members) ? me.members : [] };
  }

  // The agent's settings and the people it can see.
  async loadSettings() {
    await this.loadMe();
    const list = await this.api.members({ signal: this.abort.signal });
    this.people = new Map(list.map((m) => [m.id, { name: m.name, kind: m.kind || 'human', state: m.state }]));
  }

  // ---- The loop ----

  // One pass over the feed and the rooms that need work. Wakes during a pass ask for another one after it.
  pump() {
    if (this.stopped) return Promise.resolve();
    if (this.pumping) {
      this.again = true;
      return this.pumping;
    }
    this.pumping = (async () => {
      do {
        this.again = false;
        try {
          await this.pass();
        } catch (err) {
          if (err instanceof KeyRefused) return this.fail(err);
          this.passError = err;
          if (!this.stopped) {
            this.log('warn', `Could not read the workspace: ${err.message}; trying again later`);
            this.report({ type: 'unreachable', ...failureOf(err) });
          }
          return;
        }
        if (!this.stopped) this.report({ type: 'pass', channels: this.channelCount() });
      } while (this.again && !this.stopped);
    })().finally(() => {
      this.pumping = null;
    });
    return this.pumping;
  }

  fail(err) {
    this.fatal = err;
    this.log('error', "The agent's key no longer works: it was replaced, the agent was removed, its sponsor left, or the server turned agents off. Get a new key in Rukoo's Agents dialog.");
    this.report({ type: 'refused' });
    this.stop();
  }

  async pass() {
    await this.feed();
    for (const c of [...this.dirty]) {
      if (this.stopped) return;
      try {
        if (await this.work(c)) this.dirty.delete(c);
      } catch (err) {
        if (err instanceof KeyRefused) throw err;
        if (this.stopped) return;
        this.passError = err;
        this.log('warn', `Could not finish room ${c}: ${err.message}; trying again later`);
      }
    }
  }

  // The feed from the cursor to its end: each changed room becomes dirty; lost rooms go. When the feed says the
  // settings or the people changed, they are read before the cursor moves: a pass that can't read them throws before
  // any room is worked, and the next pass reads the same changes again.
  async feed() {
    let cursor = this.cursor;
    let directory = false;
    for (;;) {
      let page;
      try {
        page = await this.api.changes(cursor, this.abort.signal);
      } catch (err) {
        if (err instanceof RukooError && err.status === 410 && cursor) {
          cursor = null;
          continue;
        }
        throw err;
      }
      for (const row of page.changes || []) {
        this.rooms.set(row.conversation, row);
        this.dirty.add(row.conversation);
      }
      // A lost room leaves the state file at once, with an answer it still had to post there: no work in another room
      // may come to write the file, and the next pass doesn't see this eviction again once the cursor moved.
      let lost = false;
      for (const c of page.evictions || []) {
        this.rooms.delete(c);
        this.dirty.delete(c);
        if (c in this.state.rooms || c in this.state.pending) lost = true;
        delete this.state.rooms[c];
        delete this.state.pending[c];
      }
      if (lost) this.save();
      if (page.directory && page.directory.members) directory = true;
      cursor = page.next;
      if (!page.more) break;
    }
    if (directory) this.settingsStale = true;
    if (this.settingsStale) {
      await this.loadSettings();
      this.settingsStale = false;
    }
    this.cursor = cursor;
  }

  isTrigger(ev) {
    return ev.kind === 'message.posted' && !ev.redacted && ev.actor !== this.me.id && Array.isArray(ev.mentions) && ev.mentions.some((m) => m && m.actor === this.me.id);
  }

  // Why the agent may not answer ev, or null: the server's reply rules 6 and 7 (server/WORKSPACES.md, "A reply"), in
  // the server's order, so the runtime is never called for a reply the server would refuse. The server checks them
  // again when it posts. Whom the agent answers applies to the origin, the person who started the chain: the author of
  // a person's message, and the origin an agent's reply carries, so "only its sponsor" holds through other agents too.
  // inChannel: the member IDs with a grant in the channel now (GET /channels/{c}/members).
  skipReason(ev, inChannel) {
    const me = this.me;
    const author = this.people.get(ev.actor);
    const byAgent = typeof ev.depth === 'number' || Boolean(author && author.kind === 'agent');
    if (byAgent && !me.agents) return 'it does not answer other agents';
    const origin = byAgent ? ev.origin : ev.actor;
    // The server gives every agent's reply an origin; one without it gets no answer (author_gone).
    if (typeof origin !== 'string' || !origin) return 'the agent that wrote it names nobody who started the conversation';
    // Still an active member with a grant in the channel, and for the origin a person (author_gone).
    const present = (id) => {
      const p = this.people.get(id);
      return inChannel.has(id) && !(p && p.state && p.state !== 'active') && !(id === origin && p && p.kind === 'agent');
    };
    if (!present(ev.actor)) return 'its author is no longer in the channel';
    if (origin !== ev.actor && !present(origin)) return `${origin}, who started the conversation, is no longer in the channel`;
    if (origin !== me.sponsor) {
      const via = byAgent ? ` (${origin} asked through another agent)` : '';
      if (me.answers === 'sponsor') return `it answers only its sponsor${via}`;
      if (me.answers === 'members') {
        if (!me.members.includes(origin)) return `it does not answer this member${via}`;
      } else if (me.answers !== 'everyone') {
        // A setting of a newer server: answering would risk what the sponsor chose, so only the sponsor gets answers.
        return `it answers ${JSON.stringify(String(me.answers))}, which this runner doesn't know, so it answers only its sponsor`;
      }
    }
    const depth = (typeof ev.depth === 'number' ? ev.depth : 0) + 1;
    if (depth > this.depthLimit) return `a reply would be ${depth} deep, past the limit of ${this.depthLimit}`;
    return null;
  }

  // Handles a room's new events in order. true when the room is done for now; throws to try it again later.
  async work(c) {
    const row = this.rooms.get(c);
    if (!row || (row.kind && row.kind !== 'channel')) return true;
    // An answer this room still has to post goes in before anything else here, so its trigger never reaches the
    // runtime again. When it can't go in yet, the room waits for the next pass. A grant that ended took it along.
    const pending = this.state.pending[c];
    if (pending) {
      if (pending.grant === row.grant) await this.finishPending(c);
      else {
        delete this.state.pending[c];
        this.save();
      }
    }
    let st = this.state.rooms[c];
    if (st && st.grant !== row.grant) st = null;
    let recover = null;
    // Without a position for this grant, or once per start with one behind the read position (a state file from a
    // backup, say), the newest reply says where the work stopped: work that is done costs no backend call again.
    if (!st || (!this.looked.has(c) && st.done < (row.read || 0))) {
      const found = await this.lookback(row);
      recover = found.recover;
      st = this.state.rooms[c] = { grant: row.grant, done: st ? Math.max(st.done, found.from) : found.from };
    }
    this.looked.add(c);
    if (row.archived) {
      st.done = Math.max(st.done, row.head || 0);
      this.save();
      return true;
    }
    // With no mention after the read position, only what lies before it can hold a trigger: the reads a reply moved.
    const end = row.mentions > 0 ? Infinity : row.read || 0;
    if (st.done >= Math.min(end, row.head || 0)) {
      this.save();
      return true;
    }
    let after = st.done;
    let reached = false;
    while (!reached && !this.stopped) {
      const page = await this.api.events(c, { after, limit: 100 });
      for (const ev of page.events || []) {
        if (ev.seq > end || this.stopped) {
          reached = true;
          break;
        }
        after = ev.seq;
        if (this.isTrigger(ev)) {
          if (!(recover && recover.answered.has(ev.id))) await this.handle(row, ev);
          st.done = Math.max(st.done, ev.seq);
          this.save();
          await this.markRead(row, ev.seq);
        } else {
          st.done = Math.max(st.done, ev.seq);
        }
      }
      if (!page.more) break;
    }
    this.save();
    await this.markRead(row, st.done);
    return true;
  }

  async markRead(row, seq) {
    if (!(seq > (row.read || 0))) return;
    try {
      const res = await this.api.read(row.conversation, seq);
      row.read = Math.max(row.read || 0, (res && res.read) || seq);
    } catch (err) {
      if (err instanceof KeyRefused) throw err;
    }
  }

  // Where to start in a room the state file doesn't know. Normally the server's read position. A reply moves the
  // agent's read position to itself, past mentions that came between the trigger and the reply; when the runner
  // stopped there, those are still to do. Otherwise only the runner moves the read position, as it handles events: so
  // when the agent's newest message is below the read position, everything up to it was handled. When that message is
  // at the read position, the runner starts after its trigger: it reads back from the read position until it has read
  // every event after the trigger, up to LOOKBACK_PAGES pages, and leaves out the mentions a reply it read answers.
  //
  // The feed row's lastTrigger is where that trigger is, and it stays when someone removes the reply, whose event then
  // loses its trigger. A server from before lastTrigger leaves it out: the runner then goes back to the trigger of its
  // newest reply that is still there, which with the newest one removed is an older reply's, or starts at the read
  // position when it finds none.
  async lookback(row) {
    const read = row.read || 0;
    if (read <= 0) return { from: 0, recover: null };
    const mine = (e) => e.kind === 'message.posted' && e.actor === this.me.id;
    const known = Number.isSafeInteger(row.lastTrigger) ? Math.min(row.lastTrigger, read) : null;
    let last = null;
    const answered = new Set();
    let before = read + 1;
    let oldest = null;
    let more = false;
    for (let pages = 0; pages < LOOKBACK_PAGES; pages++) {
      const page = await this.api.events(row.conversation, { before, limit: 100 });
      const events = page.events || [];
      if (pages === 0) {
        // A removed reply keeps its author but not its trigger, so it still counts as the agent's newest message.
        const newest = events.findLast(mine);
        if (!newest || newest.seq < read) return { from: read, recover: null };
      }
      for (let i = events.length - 1; i >= 0; i--) {
        const e = events[i];
        if (known === null && last && e.id === last.trigger) return { from: e.seq, recover: { answered } };
        if (mine(e) && e.trigger) {
          last = last || e;
          answered.add(e.trigger);
        }
      }
      if (events.length) oldest = events[0].seq;
      if (known !== null && oldest !== null && oldest <= known + 1) return { from: known, recover: { answered } };
      if (known === null && !last) return { from: read, recover: null };
      more = Boolean(page.more) && events.length > 0;
      if (!more) break;
      before = oldest;
    }
    // The trigger is gone, older than what the room keeps, or further back than the runner reads: it starts at the
    // oldest event it read, and a mention older than that which no reply answers is missed.
    if (more) {
      this.log('warn', `The trigger of the agent's newest reply in ${row.conversation} is more than ${(LOOKBACK_PAGES * 100).toLocaleString('en-US')} events back, so the runner starts there; a mention before that without a reply is missed`);
    }
    return { from: Math.max(0, oldest - 1), recover: { answered } };
  }

  // ---- One trigger ----

  async handle(row, ev) {
    const c = row.conversation;
    // The settings as they are now, so a change the sponsor makes during a pass applies from the next mention on. When
    // they can't be read, this throws and the room waits with the mention for the next pass.
    await this.loadMe();
    // Who is in the channel now: whether the author and the origin still are, and whom the answer can mention.
    const inChannel = new Set((await this.api.channelMembers(c)).map((m) => m.member));
    const why = this.skipReason(ev, inChannel);
    if (why) {
      this.stats.skipped++;
      this.log('info', `Skipped ${ev.id} in ${c}: ${why}`);
      return;
    }
    // Everything from the server comes before the backend: once it answered, nothing may fail before the journal has it.
    const prompt = await this.prompt(row, ev);
    let answer;
    try {
      answer = await this.backend.run(prompt, { id: ev.id, signal: this.abort.signal });
    } catch (err) {
      // Stopping the runner ends a turn without an outcome; it runs again after a restart.
      if (this.stopped) throw new Error('Stopped');
      this.stats.failed++;
      this.log('warn', `The backend failed on ${ev.id} in ${c}, so nothing was posted: ${err.message}`);
      this.report({ type: 'failed', ...failureOf(err) });
      return;
    }
    const text = cleanAnswer(answer);
    if (!text) {
      this.stats.failed++;
      this.log('warn', `The backend gave no answer to ${ev.id} in ${c}, so nothing was posted`);
      this.report({ type: 'failed', code: 'empty' });
      return;
    }
    const converted = convertMentions(text, (id) => {
      if (id === this.me.id) return { name: this.me.name, mention: false };
      const p = this.people.get(id);
      if (!p && !inChannel.has(id)) return null;
      return { name: p ? p.name : id, mention: inChannel.has(id) };
    });
    const parts = splitReply(converted.text, converted.mentions);
    if (!parts.length) {
      this.stats.failed++;
      this.log('warn', `The backend gave no answer to ${ev.id} in ${c}, so nothing was posted`);
      this.report({ type: 'failed', code: 'empty' });
      return;
    }
    const at = Date.now() + this.clockOffset;
    this.state.pending[c] = {
      conversation: c,
      grant: row.grant,
      trigger: ev.id,
      triggerSeq: ev.seq,
      parts: parts.map((p) => ({ text: p.text, mentions: p.mentions, operationId: uuidv7(at) })),
      next: 0
    };
    this.save();
    await this.finishPending(c);
  }

  // Posts the parts of room c's answer in state.pending that aren't in yet, with their own operation IDs, so a part
  // that went in already gets its first answer again. A refusal ends the answer; no answer or a server error leaves it
  // for the next pass, which posts it before it handles anything else in the room.
  async finishPending(c) {
    const p = this.state.pending[c];
    let outcome = null;
    let posted = 0;
    for (let i = p.next; i < p.parts.length; i++) {
      const result = await this.postPart(p, i);
      if (result.refused) {
        outcome = result.refused;
        break;
      }
      posted++;
      p.next = i + 1;
      this.save();
    }
    const st = this.state.rooms[p.conversation];
    if (st && st.grant === p.grant) st.done = Math.max(st.done, p.triggerSeq);
    delete this.state.pending[c];
    this.save();
    if (outcome) {
      this.stats.refused++;
      this.log('info', `The server took no ${p.next ? 'more ' : ''}reply to ${p.trigger} in ${p.conversation}: ${outcome}`);
    } else {
      this.stats.answered++;
      this.log('info', `Answered ${p.trigger} in ${p.conversation}${p.parts.length > 1 ? ` in ${p.parts.length} parts` : ''}`);
      this.report({ type: 'answered' });
    }
    return posted;
  }

  async postPart(p, i) {
    const part = p.parts[i];
    const body = { operationId: part.operationId, grant: p.grant, generation: this.generation, text: part.text, mentions: part.mentions, trigger: p.trigger, part: i };
    let failures = 0;
    let reloaded = false;
    for (;;) {
      if (this.stopped) throw new Error('Stopped');
      let res;
      try {
        res = await this.api.post(p.conversation, body);
      } catch (err) {
        if (err instanceof KeyRefused || ++failures >= POST_TRIES) throw err;
        await sleep(this.retryMs * 2 ** failures, this.abort.signal);
        continue;
      }
      if (res.status === 200 || res.status === 201) {
        // The post moved the agent's read position to the reply.
        const row = this.rooms.get(p.conversation);
        if (row && res.body && res.body.seq > (row.read || 0)) row.read = res.body.seq;
        return { messageId: res.body && res.body.messageId };
      }
      const b = res.body || {};
      if (res.status === 429) {
        const wait = Math.min(3600, retryAfter(res.headers) ?? 30);
        this.log('info', `The server asks to wait ${wait} s before the reply to ${p.trigger}${b.limit === 'agentReplies' ? ': the agent reached its replies per hour' : ''}`);
        await sleep(wait * 1000, this.abort.signal);
        continue;
      }
      if (res.status >= 500 || res.status === 408) {
        if (++failures >= POST_TRIES) throw new RukooError(res.status, b);
        await sleep(this.retryMs * 2 ** failures, this.abort.signal);
        continue;
      }
      if (res.status === 409 && b.error === 'stale_generation' && !reloaded) {
        reloaded = true;
        await this.loadWorkspace();
        body.generation = this.generation;
        continue;
      }
      // Every other answer is final for this trigger: already_answered, not_answered, too_deep, bad_trigger, bad_root,
      // archived, stale_grant, submission_expired, a room the agent left, and the rest.
      return { refused: `${res.status} ${b.error || 'refused'}${b.reason ? ` (${b.reason})` : ''}` };
    }
  }

  // Reads back from before, newest first, calling visit(event) for each message that is still there until it answers
  // false, the room's start or CONTEXT_PAGES pages.
  async scanBack(c, before, visit) {
    let at = before;
    for (let pages = 0; pages < CONTEXT_PAGES && at > 1; pages++) {
      const page = await this.api.events(c, { before: at, limit: 100 });
      const events = page.events || [];
      if (!events.length) return;
      for (let i = events.length - 1; i >= 0; i--) {
        const e = events[i];
        if (e.kind !== 'message.posted' || e.redacted) continue;
        if (visit(e) === false) return;
      }
      at = events[0].seq;
      if (!page.more) return;
    }
  }

  async prompt(row, ev) {
    const c = row.conversation;
    const { threadMessages, channelMessages, maxChars } = this.config.context;
    let context = [];
    let threadStart = null;
    if (ev.root) {
      const replies = [];
      let root = null;
      await this.scanBack(c, ev.seq, (e) => {
        if (e.id === ev.root) {
          root = e;
          return false;
        }
        if (e.root === ev.root && replies.length < threadMessages - 1) replies.push(e);
        return true;
      });
      if (root) {
        context.push(root);
        threadStart = root.id;
      }
      context = context.concat(replies.reverse());
    } else if (channelMessages > 0) {
      const tops = [];
      await this.scanBack(c, ev.seq, (e) => {
        if (!e.root) tops.push(e);
        return tops.length < channelMessages;
      });
      context = tops.reverse();
    }
    const author = this.people.get(ev.actor);
    return buildInput({
      agent: { id: this.me.id, name: this.me.name },
      workspace: this.workspace,
      channel: { id: c, name: row.name || '' },
      trigger: ev,
      context,
      people: this.people,
      senderIsAgent: typeof ev.depth === 'number' || Boolean(author && author.kind === 'agent'),
      threadStart,
      instructions: this.config.instructions,
      maxChars,
      channelMessages
    });
  }

  // ---- Checking ----

  // What the backend needs before the first mention (backends.js, "Checks"): [{ level, message }]. stop() ends a check
  // that still waits, and then nothing is said.
  async backendProblems() {
    if (typeof this.backend.check !== 'function') return [];
    try {
      const list = await this.backend.check({ env: process.env, signal: this.abort.signal });
      return this.stopped ? [] : list;
    } catch (err) {
      return this.stopped ? [] : [{ level: 'error', message: `Could not check the backend: ${err instanceof BackendError ? err.message : 'the check failed'}` }];
    }
  }

  // The channels the agent is in now, by id.
  async channels() {
    await this.feed();
    return [...this.rooms.values()].filter((row) => row.kind === 'channel' && !row.archived).map((row) => row.conversation);
  }

  // --check: the backend, the server and the key, and the agent's channels, each said in a line with what to do.
  // Answers the exit code: 0 when the agent can answer (a warning when it is in no channel yet), 1 when the backend
  // can't answer as configured. A key that doesn't work throws KeyRefused, which main() makes 2.
  async check() {
    const stopped = () => new Error('Stopped before the check finished');
    const problems = await this.backendProblems();
    if (this.stopped) throw stopped();
    for (const p of problems) this.log(p.level, p.message);
    let rooms;
    try {
      await this.connect();
      rooms = await this.channels();
    } catch (err) {
      throw this.stopped ? stopped() : err;
    }
    if (this.stopped) throw stopped();
    if (rooms.length) this.log('info', `The agent is in ${rooms.length} ${rooms.length === 1 ? 'channel' : 'channels'}: ${rooms.join(', ')}`);
    else this.log('warn', 'The agent is in no channel yet, so no mention can reach it. In Rukoo, open a channel\'s menu and choose Add agents, or Add people when you manage the channel.');
    const errors = problems.filter((p) => p.level === 'error').length;
    if (errors) {
      this.log('error', `The backend can't answer yet: fix ${errors === 1 ? 'the problem' : `the ${errors} problems`} above and check again.`);
      return 1;
    }
    this.log('info', 'The check passed. Start the runner without --check.');
    return 0;
  }

  // ---- Running ----

  // One pass, then done: for a scheduled job, and the tests.
  // A pass that couldn't finish throws, so a scheduled job sees it in the exit code; the next pass picks it up.
  async once() {
    if (!this.me) await this.connect();
    this.passError = null;
    await this.pump();
    if (this.fatal) throw this.fatal;
    if (this.passError) throw this.passError;
    return this.stats;
  }

  // Runs until stop(): the socket's wakes, and a pass every pollSeconds as a backup. A server that doesn't answer at
  // the start is tried again, up to a minute apart.
  async run() {
    for (let wait = 1000; ; wait = Math.min(wait * 2, 60000)) {
      try {
        await this.connect();
        break;
      } catch (err) {
        // Stopped while a request to the server waited: stop() aborted it, and that is no failure.
        if (this.stopped) return;
        const passing = err instanceof RukooError && !(err instanceof KeyRefused) && (err.network || err.status >= 500 || err.status === 429);
        if (!passing) throw err;
        this.log('warn', `Could not reach the server: ${err.message}; trying again in ${wait / 1000} s`);
        this.report({ type: 'unreachable', ...failureOf(err) });
        await sleep(wait, this.abort.signal);
        if (this.stopped) return;
      }
    }
    // What would keep every answer from going out, or what the check couldn't tell, said at the start rather than at
    // the first mention. A program that started the runner hears of the errors, by their codes.
    const problems = await this.backendProblems();
    for (const p of problems) if (p.level === 'error' || p.level === 'warn') this.log('warn', p.message);
    // Stopped while the check waited: nothing may start after stop().
    if (this.stopped) return;
    this.report({ type: 'problems', problems: problems.filter((p) => p.level === 'error').map((p) => ({ code: p.code || 'other' })) });
    this.timer = setInterval(() => this.pump(), this.config.pollSeconds * 1000);
    this.socketLoop().catch((err) => this.log('warn', `The wake socket stopped: ${err.message}`));
    await this.pump();
    if (!this.stopped && ![...this.rooms.values()].some((row) => row.kind === 'channel' && !row.archived)) {
      this.log('warn', "The agent is in no channel yet. In Rukoo, open a channel's menu and choose Add agents; the runner picks it up at once.");
    }
    await this.finished;
    await this.settle();
    if (this.fatal) throw this.fatal;
  }

  // After stop(): the pass in flight ends what it does, a turn included, within STOP_GRACE.
  async settle() {
    if (!this.pumping) return;
    let timer;
    await Promise.race([this.pumping.catch(() => {}), new Promise((resolve) => (timer = setTimeout(resolve, STOP_GRACE)))]);
    clearTimeout(timer);
  }

  async socketLoop() {
    if (typeof WebSocket !== 'function') {
      this.log('warn', `This Node.js has no WebSocket, so the runner checks every ${this.config.pollSeconds} s instead of at once`);
      return;
    }
    let backoff = 1000;
    while (!this.stopped) {
      let code = null;
      try {
        const { ticket } = await this.api.ticket();
        code = await this.socketOnce(ticket, () => {
          backoff = 1000;
        });
      } catch (err) {
        if (err instanceof KeyRefused) return this.fail(err);
        if (!this.stopped) this.log('warn', `The wake socket failed: ${err.message}`);
      }
      if (this.stopped) return;
      // The server closes with 4001 when the key was replaced or the socket's time ran out, and 4003 when the agent was
      // removed. A request says which; the same goes for a socket that closed without a code.
      if (code !== 1000) {
        try {
          await this.api.me();
        } catch (err) {
          if (err instanceof KeyRefused) return this.fail(err);
        }
      }
      await sleep(backoff, this.abort.signal);
      backoff = Math.min(backoff * 2, 60000);
    }
  }

  // One socket until it closes: resolves its close code, or null when it is closing. A closing handshake can take
  // seconds before the close event, so the state is checked every second. opened() once it is open.
  socketOnce(ticket, opened) {
    return new Promise((resolve) => {
      const socket = new WebSocket(this.api.socketUrl(), this.api.socketProtocols(ticket));
      let alive = true;
      let ping = null;
      let done = false;
      const closing = setInterval(() => {
        if (socket.readyState >= 2) finish(null);
      }, 1000);
      if (closing.unref) closing.unref();
      const finish = (code) => {
        if (done) return;
        done = true;
        clearInterval(ping);
        clearInterval(closing);
        this.abort.signal.removeEventListener('abort', onAbort);
        resolve(code);
      };
      const onAbort = () => {
        try {
          socket.close(1000);
        } catch {}
      };
      this.abort.signal.addEventListener('abort', onAbort, { once: true });
      socket.addEventListener('open', () => {
        opened();
        this.socket = socket;
        // A ping every 45 s; no answer by the next one means the connection is gone.
        ping = setInterval(() => {
          if (!alive) {
            try {
              socket.close(4000);
            } catch {}
            return;
          }
          alive = false;
          try {
            socket.send('ping');
          } catch {}
        }, 45000);
        if (ping.unref) ping.unref();
        // Whatever happened while the socket was down.
        this.pump();
      });
      socket.addEventListener('message', (e) => {
        alive = true;
        if (String(e.data).includes('"wake"')) this.pump();
      });
      socket.addEventListener('close', (e) => finish(e.code));
      socket.addEventListener('error', () => {});
    });
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.timer);
    this.abort.abort();
    try {
      if (this.socket) this.socket.close(1000);
    } catch {}
    this.onStop();
  }
}

// What a failure was, for report(): { code, status? }. For the account server offline, or http with its status; for a
// backend the code its BackendError carries (backends.js): timeout, http, exit, missing, empty, offline, failed,
// protocol, too_large and the like. Never its message, which can quote what a server or a backend said.
function failureOf(err) {
  const status = err && Number.isSafeInteger(err.status) && err.status >= 100 && err.status <= 599 ? err.status : null;
  if (err instanceof RukooError) return { code: err.network ? 'offline' : err.tooLarge ? 'too_large' : 'http', ...(status ? { status } : {}) };
  const code = err && typeof err.code === 'string' && /^[a-z_]{2,20}$/.test(err.code) ? err.code : 'backend';
  return { code, ...(status ? { status } : {}) };
}

// ---- Command line ----

function usage() {
  return 'Usage: node runner.js --config <agent.json> [--once] [--check]\n\n  --once   one pass over the workspace, then exit\n  --check  check the backend, the key and the agent\'s channels, then exit\n';
}

async function main(argv = process.argv.slice(2)) {
  let file = null;
  let once = false;
  let check = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--config' || a === '-c') file = argv[++i];
    else if (a.startsWith('--config=')) file = a.slice(9);
    else if (a === '--once') once = true;
    else if (a === '--check') check = true;
    else if (a === '--help' || a === '-h') {
      process.stdout.write(usage());
      return 0;
    } else {
      process.stderr.write(`Unknown argument: ${a}\n${usage()}`);
      return 1;
    }
  }
  if (!file) {
    process.stderr.write(usage());
    return 1;
  }
  let runner;
  try {
    runner = new Runner(loadConfig(file));
  } catch (err) {
    defaultLog('error', err.message);
    return 1;
  }
  const quit = () => runner.stop();
  process.on('SIGINT', quit);
  process.on('SIGTERM', quit);
  try {
    if (check) return await runner.check();
    if (once) await runner.once();
    else await runner.run();
    return 0;
  } catch (err) {
    if (err instanceof KeyRefused) {
      if (!runner.fatal) defaultLog('error', "The agent's key doesn't work: it was replaced, the agent was removed, its sponsor left, or the server turned agents off. Get a new key in Rukoo's Agents dialog.");
      return 2;
    }
    defaultLog('error', err.message);
    return 1;
  } finally {
    runner.stop();
  }
}

if (require.main === module) {
  main().then((code) => {
    process.exitCode = code;
  });
}

module.exports = { Runner, loadConfig, normalizeConfig, readState, writeState, main, failureOf, DEFAULT_KEY_ENV, STOP_GRACE };
