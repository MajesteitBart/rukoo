'use strict';

// Clark: Bart's Hermes Agent, reached over Tailscale through the Hermes API server.
//
// A turn is a run (POST /v1/runs) bound to a Hermes session, one session per Rukoo conversation. Runs
// keep going when the event stream drops, can be resumed with Last-Event-ID, and report tool errors;
// the session stream (/api/sessions/{id}/chat/stream) dies with its connection. A run with session_id
// loads that session's history and appends the turn to it (verified against Clark, see
// integrations/hermes/README.md).
//
// Node's fetch on purpose, not ./net.js: that module refuses 100.64.0.0/10, which is where a
// Tailscale peer lives. Requests only ever go to the configured server and never follow redirects.
const crypto = require('crypto');
const { SseParser, readSse } = require('./sse');
const { AgentError, clip, logger, echoFree, approvalTitle } = require('./proc');
const { untag } = require('./context');

const STATUS_TTL = 30000;
const CONNECT_TIMEOUT = 8000;
// Hermes sends a keepalive comment every 10 s, so this much silence means the connection is gone.
const SILENCE = 45000;
const RECONNECTS = 5;
const STOP_WAIT = 10000;
// How long a failed response's body may take: an error text is short, and a server that answers 5xx and then
// trickles its body must not hold the turn.
const ERROR_BODY_MS = 2000;
// Without an event stream a run is followed by its status: this often, and given up (after asking Hermes to
// stop it) once that many polls in a row got no answer, about a minute.
const POLL_EVERY = 3000;
const POLL_MISSES = 20;
// A stop Hermes did not take is sent again after this long, then after twice as long each time, up to ten
// times this (five minutes).
const STOP_RETRY = 30000;
// How long a quit waits for the answer to a run start that is still out.
const QUIT_ANSWER_MS = 1000;

// The effort levels a run's model_options.reasoning.effort takes (Hermes 0.21 also knows minimal and ultra, which
// few models have; it ignores a level a model lacks).
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
// A model list longer than this is cut: an aggregator such as OpenRouter lists hundreds.
const MAX_MODELS = 300;
const MAX_PER_PROVIDER = 60;

// "provider::model", the way Hermes names a model of a provider other than its current one; a bare model or a
// model_routes alias has no provider.
function splitModel(value) {
  const text = String(value || '').trim();
  const at = text.indexOf('::');
  if (at > 0 && /^[A-Za-z0-9_.:-]{2,80}$/.test(text.slice(0, at)) && text.slice(at + 2).trim()) return { provider: text.slice(0, at), model: text.slice(at + 2).trim() };
  return { provider: '', model: text };
}

const CHOICES = {
  once: { id: 'once', label: 'Allow once', kind: 'primary' },
  session: { id: 'session', label: 'Allow for this turn', kind: 'default' },
  always: { id: 'always', label: 'Always allow', kind: 'default' },
  deny: { id: 'deny', label: 'Deny', kind: 'danger' }
};

const sleep = (ms, signal) =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true });
  });

// The part of a run's final output that the transcript does not show yet. streamed is all text the run
// streamed; segment the text since the last tool call (leading white space dropped, like the deltas); lost
// whether the stream broke off before the run ended, so its later events never arrived.
function missingText(streamed, segment, output, lost = false) {
  const out = String(output || '').replace(/^\s+/, '').trimEnd();
  const all = String(streamed || '').trimEnd();
  const seg = String(segment || '');
  if (!out || all.endsWith(out) || seg.startsWith(out)) return '';
  // The answer was cut off part-way: add the rest.
  if (seg && out.startsWith(seg)) return out.slice(seg.length);
  // Nothing streamed since the last tool call: the final answer never came through.
  if (!seg) return out;
  // Other text streamed last. With the whole stream that is the answer worded differently, so it is not shown
  // twice. After a lost stream it can be text from before a tool call the stream never reported: the final
  // answer follows it.
  return lost ? `\n\n${out}` : '';
}

function describe(err) {
  const cause = err && err.cause;
  if (cause && cause.code) return [cause.code, cause.address && `${cause.address}:${cause.port}`].filter(Boolean).join(' ');
  if (cause && cause.message) return cause.message;
  return (err && err.message) || String(err);
}

// fetch() failures: no route, refused, reset, or our own connect timeout.
function networkError(err, host) {
  if (err instanceof AgentError) return err;
  if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) return new AgentError('offline', `No answer from ${host} within ${CONNECT_TIMEOUT / 1000} s`);
  return new AgentError('offline', clip(describe(err), 200));
}

// Up to limit bytes of a response body, for at most ms; then the rest is cancelled.
async function readCapped(res, ms, limit = 8192) {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  const timer = setTimeout(() => reader.cancel().catch(() => {}), ms);
  try {
    while (size < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
    }
  } catch {
    // A body that broke off: what came is enough for an error text.
  } finally {
    clearTimeout(timer);
    reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).subarray(0, limit).toString('utf8');
}

function errorText(data) {
  if (!data) return '';
  if (typeof data === 'string') return clip(data.trim(), 200);
  const e = data.error;
  return clip((e && (e.message || (typeof e === 'string' ? e : ''))) || data.message || data.detail || '', 200);
}

function httpError(res) {
  const text = errorText(res.data);
  const detail = `HTTP ${res.status}${text ? ': ' + text : ''}`;
  if (res.status === 401 || res.status === 403) return new AgentError('unauthorized', detail);
  if (res.status === 429) return new AgentError('rate-limited', detail);
  return new AgentError('protocol', detail);
}

class HermesAdapter {
  // timing: test-only overrides of {backoff, pollEvery, pollMisses, stopRetry}.
  constructor({ id = 'clark', config, hub, log, paths, timing } = {}) {
    this.id = id;
    this.timing = { backoff: 1000, pollEvery: POLL_EVERY, pollMisses: POLL_MISSES, stopRetry: STOP_RETRY, errorBody: ERROR_BODY_MS, quitAnswer: QUIT_ANSWER_MS, ...(timing || {}) };
    this.config = typeof config === 'function' ? config : () => config || {};
    this.hub = hub || null;
    this.log = logger(log);
    this.paths = paths || {};
    this.cache = null;
    this.checking = null;
    // Status checks in the order they started, and the newest one whose answer may be cached (see status()).
    this.checks = 0;
    this.cachedCheck = 0;
    // run id → live state, so dispose() can stop what is still running on the server.
    this.runs = new Map();
    // Run starts whose answer is not in yet; see submit() and dispose().
    this.submitting = new Set();
    // run id → state of a run Rukoo no longer follows whose stop Hermes has not taken yet (see keepStopping).
    this.unstopped = new Map();
  }

  settings() {
    const c = this.config() || {};
    return {
      enabled: c.enabled !== false,
      name: String(c.name || '').trim() || 'Hermes',
      url: String(c.url || '').trim(),
      key: String(c.key || '').trim(),
      model: String(c.model || '').trim()
    };
  }

  // A server with an optional path prefix (Hermes serves profiles under /p/<name>/). Without a URL: the
  // configured one.
  base(url = this.settings().url) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw new AgentError('not-configured', 'The server URL is not valid');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new AgentError('not-configured', 'The server URL must start with http:// or https://');
    return { origin: parsed.origin, prefix: parsed.pathname.replace(/\/+$/, ''), host: parsed.host };
  }

  endpoint(path, serverUrl) {
    const { origin, prefix } = this.base(serverUrl);
    const url = new URL(prefix + path, origin);
    if (url.origin !== origin) throw new AgentError('protocol', 'Refusing a request outside the configured server');
    return url;
  }

  // server: {url, key} of the run a request belongs to; without it, the configured server. A run keeps the
  // server it started on, even when Settings change while it runs.
  async request(method, path, { body, headers, auth = true, timeout = CONNECT_TIMEOUT, signal, server } = {}) {
    const { key, url } = server || this.settings();
    const { host } = this.base(url);
    const h = { Accept: 'application/json', ...headers };
    if (auth) h.Authorization = `Bearer ${key}`;
    if (body !== undefined) h['Content-Type'] = 'application/json';
    const signals = [AbortSignal.timeout(timeout)];
    if (signal) signals.push(signal);
    let res;
    try {
      res = await fetch(this.endpoint(path, url), {
        method,
        headers: h,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.any(signals)
      });
    } catch (err) {
      if (signal && signal.aborted) throw new AgentError('stopped', 'Stopped');
      throw networkError(err, host);
    }
    let text = '';
    try {
      text = await res.text();
    } catch (err) {
      throw networkError(err, host);
    }
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    return { status: res.status, ok: res.ok, data };
  }

  invalidate() {
    this.cache = null;
    // A check that started before this answers about the old state: it must not fill the cache again.
    this.cachedCheck = this.checks;
  }

  configChanged() {
    this.invalidate();
  }

  // The models a chat can pick: the model_routes aliases (GET /v1/models) and the models of each provider Hermes
  // has credentials for (GET /api/model/options), named provider::model. Either list can be missing (an older
  // Hermes, a slow catalog); the menu then has what the other one gives.
  async models() {
    const s = this.settings();
    if (!s.enabled) throw new AgentError('disabled', `${s.name} is turned off`);
    if (!s.url || !s.key) throw new AgentError('not-configured', !s.url ? 'No server URL' : 'No API key');
    const server = { url: s.url, key: s.key };
    const [routes, options] = await Promise.allSettled([
      this.request('GET', '/v1/models', { server }),
      this.request('GET', '/api/model/options?include_unconfigured=false', { server, timeout: 15000 })
    ]);
    const ok = (r) => r.status === 'fulfilled' && r.value.ok && r.value.data && typeof r.value.data === 'object';
    if (!ok(routes) && !ok(options)) {
      const answered = [routes, options].find((r) => r.status === 'fulfilled');
      if (answered) throw httpError(answered.value);
      throw networkError(routes.reason, this.base(s.url).host);
    }
    const models = [];
    const add = (m) => {
      if (models.length < MAX_MODELS && !models.some((x) => x.id === m.id)) models.push(m);
    };
    let current = null;
    if (ok(options)) {
      const d = options.value.data;
      for (const row of Array.isArray(d.providers) ? d.providers : []) {
        const slug = row && typeof row.slug === 'string' ? row.slug.trim() : '';
        if (!/^[A-Za-z0-9_.:-]{2,80}$/.test(slug)) continue;
        const caps = row.capabilities && typeof row.capabilities === 'object' ? row.capabilities : {};
        // An aggregator's shortlist (the newest few per lab) instead of its whole catalog.
        const featured = Array.isArray(row.featured_models) && row.featured_models.length ? row.featured_models : null;
        const ids = (featured || (Array.isArray(row.models) ? row.models : [])).filter((m) => typeof m === 'string' && m.trim() && m.length <= 150);
        for (const id of ids.slice(0, MAX_PER_PROVIDER)) {
          add({ id: `${slug}::${id}`, label: id, group: String(row.name || slug), efforts: caps[id] && caps[id].reasoning === false ? [] : EFFORTS });
        }
      }
      if (typeof d.model === 'string' && d.model) current = typeof d.provider === 'string' && d.provider ? `${d.provider}::${d.model}` : d.model;
    }
    if (ok(routes)) {
      // The first entry is the profile itself, which stands for Hermes' own default; the rest are aliases.
      for (const m of Array.isArray(routes.value.data.data) ? routes.value.data.data : []) {
        if (m && typeof m.id === 'string' && m.id && m.parent) add({ id: m.id, label: m.id, tag: typeof m.root === 'string' && m.root !== m.id ? m.root : '', route: true, efforts: EFFORTS });
      }
    }
    const own = current && models.find((m) => m.id === current);
    if (own) own.isDefault = true;
    return { models, efforts: own ? own.efforts : EFFORTS, custom: EFFORTS };
  }

  // Cheap and cached: /health says the server is there, /v1/capabilities that the key works.
  // force (the Test button) skips the cache.
  async status({ force = false } = {}) {
    const s = this.settings();
    if (!s.enabled) return { state: 'disabled', detail: '' };
    if (!s.url) return { state: 'unconfigured', detail: 'No server URL' };
    if (!s.key) return { state: 'unconfigured', detail: 'No API key' };
    const key = s.url + '\0' + crypto.createHash('sha256').update(s.key).digest('hex');
    if (!force && this.cache && this.cache.key === key && Date.now() - this.cache.at < STATUS_TTL) return this.cache.value;
    if (!force && this.checking && this.checking.key === key) return this.checking.promise;
    const n = ++this.checks;
    const promise = this.check().then((value) => {
      if (this.checking && this.checking.promise === promise) this.checking = null;
      // Only the newest answer is cached: a check that started earlier and answers later is out of date.
      if (n > this.cachedCheck) {
        this.cachedCheck = n;
        this.cache = { key, at: Date.now(), value };
      }
      return value;
    });
    this.checking = { key, promise };
    return promise;
  }

  async check() {
    try {
      const started = Date.now();
      const health = await this.request('GET', '/health', { auth: false });
      if (!health.ok) return { state: 'offline', detail: `Health check answered HTTP ${health.status}` };
      // Both checks together stay inside the hub's 12 s status deadline.
      const caps = await this.request('GET', '/v1/capabilities', { timeout: Math.max(2000, 10000 - (Date.now() - started)) });
      if (caps.status === 401 || caps.status === 403) return { state: 'unauthorized', detail: 'The server refused the API key' };
      if (!caps.ok) return { state: 'unknown', detail: `Capabilities answered HTTP ${caps.status}` };
      const features = (caps.data && caps.data.features) || {};
      if (features.run_submission === false || features.run_events_sse === false) {
        return { state: 'unknown', detail: 'This Hermes version has no Runs API' };
      }
      const version = health.data && health.data.version;
      return { state: 'ready', detail: version ? `Hermes ${version}` : 'Hermes' };
    } catch (err) {
      const e = err instanceof AgentError ? err : networkError(err, '');
      return { state: e.code === 'not-configured' ? 'unconfigured' : 'offline', detail: e.detail };
    }
  }

  async runTurn(turn) {
    try {
      return await this.turn(turn);
    } catch (err) {
      if (err instanceof AgentError && err.code === 'stopped') return { status: 'stopped' };
      const e = err instanceof AgentError ? err : new AgentError('unknown', clip(describe(err), 200));
      if (!(err instanceof AgentError)) this.log('hermes: turn failed', err);
      return { status: 'error', error: { code: e.code, detail: e.detail } };
    }
  }

  async turn(turn) {
    const s = this.settings();
    if (!s.enabled) throw new AgentError('disabled', `${s.name} is turned off`);
    if (!s.url || !s.key) throw new AgentError('not-configured', !s.url ? 'No server URL' : 'No API key');
    this.base();
    if (turn.signal && turn.signal.aborted) return { status: 'stopped' };
    // The whole turn talks to this server, so a changed URL or key cannot split a run between two.
    const server = { url: s.url, key: s.key };

    const sessionId = await this.session(turn, server);
    // Stop can arrive while the session lookup is in flight; nothing has been submitted to Hermes yet.
    if (turn.signal && turn.signal.aborted) return { status: 'stopped' };
    const body = { input: turn.input, session_id: sessionId };
    if (turn.instructions) body.instructions = turn.instructions;
    // The chat's own model and effort, else the model in Settings. Without either, Hermes uses its own.
    const { provider, model } = splitModel(String(turn.model || '').trim() || s.model);
    if (model) body.model = model;
    if (provider) body.provider = provider;
    if (EFFORTS.includes(turn.effort)) body.model_options = { reasoning: { effort: turn.effort } };
    // A retried POST (lost response) must not start the same turn twice.
    const idem = String(turn.id || '').replace(/[^\x21-\x7e]/g, '').slice(0, 200) || crypto.randomUUID();
    const started = await this.submit(body, `rukoo-${idem}`, server, turn.signal);
    const runId = started.data && started.data.run_id;
    if (!runId) throw new AgentError('protocol', 'The server did not return a run id');
    // Hermes has the message now: even a run stopped before its first event used up this turn's email and
    // notes, so the next message is not sent as a first turn again.
    if (typeof turn.accepted === 'function') turn.accepted();
    this.invalidate();
    return this.follow(turn, runId, server);
  }

  // Starts the run. No answer, a timeout or a passing server error says nothing about whether Hermes took the
  // POST, and a run it took but Rukoo never heard of can neither be followed nor stopped. So the POST is sent
  // again with the same Idempotency-Key, for which Hermes returns the run it already started. A rate limit
  // (429) is a refusal: nothing started, and the user hears it at once.
  // Stop ends the retries: the earlier POST may never have reached Hermes, and a retry would start a run the user
  // just stopped. A POST already on its way is not cut off, so follow() can stop the run it reports.
  // dispose() knows the start while its answer is out, so a quit can still find and stop a run Hermes took.
  async submit(body, key, server, signal) {
    const entry = { body, key, server, pending: null };
    this.submitting.add(entry);
    try {
      let failure;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt) {
          await sleep(this.timing.backoff * 2 ** (attempt - 1), signal);
          if (signal && signal.aborted) throw new AgentError('stopped', 'Stopped');
        }
        let res;
        try {
          entry.pending = this.request('POST', '/v1/runs', { body, headers: { 'Idempotency-Key': key }, timeout: 20000, server });
          res = await entry.pending;
        } catch (err) {
          if (!(err instanceof AgentError) || err.code !== 'offline') throw err;
          failure = err;
          continue;
        }
        if (res.status === 202 || res.status === 200) return res;
        failure = httpError(res);
        if (!(res.status >= 500 || res.status === 408)) throw failure;
      }
      throw failure;
    } finally {
      this.submitting.delete(entry);
    }
  }

  // Quitting while a run start is out: Hermes may have taken it, and the app is gone before the answer would
  // arrive. The answer gets a moment; without it the start goes again with the same Idempotency-Key, for which
  // Hermes names the run it took (or starts it now). Either way that run is stopped.
  async stopSubmitted(entry) {
    const runOf = (res) => (res && (res.status === 200 || res.status === 202) && res.data && res.data.run_id) || null;
    let runId = null;
    if (entry.pending) {
      const late = new Promise((resolve) => setTimeout(resolve, this.timing.quitAnswer, null));
      runId = runOf(await Promise.race([entry.pending.catch(() => null), late]));
    }
    if (!runId) {
      try {
        runId = runOf(await this.request('POST', '/v1/runs', { body: entry.body, headers: { 'Idempotency-Key': entry.key }, timeout: 1500, server: entry.server }));
      } catch (err) {
        this.log(`hermes: asking for a run being started failed: ${err.detail || describe(err)}`);
      }
    }
    if (runId) await this.sendStop({ runId, server: entry.server }, 1500);
  }

  // The Hermes session behind a conversation: reused while it exists, recreated when it was deleted.
  async session(turn, server) {
    const conversation = turn.conversation || {};
    const known = conversation.provider && conversation.provider.sessionId;
    if (known) {
      const res = await this.request('GET', `/api/sessions/${encodeURIComponent(known)}`, { signal: turn.signal, server });
      if (res.ok) return known;
      if (res.status !== 404) throw httpError(res);
      this.log(`hermes: session ${known} is gone, starting a new one`);
    }
    // Hermes wants unique session titles; a second chat about the same subject gets the chat id as well.
    const title = clip(`Rukoo: ${conversation.title || 'Chat'}`, 100);
    const titles = [title, clip(`${title.slice(0, 85)} (${String(conversation.id || '').slice(-6) || Date.now().toString(36)})`, 100), null];
    for (const t of titles) {
      const res = await this.request('POST', '/api/sessions', { body: t ? { title: t } : {}, signal: turn.signal, server });
      const id = res.ok && res.data && res.data.session && res.data.session.id;
      if (id) {
        turn.setProvider({ sessionId: id });
        if (known) {
          // The new session knows nothing of the chat: the turn's input gets the email and a recap before the run.
          turn.emit({ type: 'notice', tone: 'info', code: 'new-session', text: `${this.settings().name} started a new session` });
          if (typeof turn.startOver === 'function') await turn.startOver();
        }
        return id;
      }
      if (res.status !== 400) throw httpError(res);
    }
    throw new AgentError('protocol', 'Could not create a Hermes session');
  }

  // Streams one run's events into the turn until it ends, reconnecting where the stream left off.
  async follow(turn, runId, server = { url: this.settings().url, key: this.settings().key }) {
    const name = this.settings().name;
    const state = {
      runId,
      server,
      lastSeq: -1,
      terminal: null,
      // All text the run streamed, and the part since the last tool call.
      text: '',
      segment: '',
      counters: {},
      open: {},
      subagents: new Map(),
      approvals: new Map(),
      stopping: false,
      controller: new AbortController()
    };
    this.runs.set(runId, state);
    const onAbort = () => this.stopRun(state);
    if (turn.signal) {
      if (turn.signal.aborted) onAbort();
      else turn.signal.addEventListener('abort', onAbort, { once: true });
    }
    try {
      let failures = 0;
      while (!state.terminal && !state.controller.signal.aborted) {
        let outcome;
        const seen = state.lastSeq;
        try {
          outcome = await this.stream(turn, state, name);
        } catch (err) {
          if (err instanceof AgentError && err.code !== 'offline') throw err;
          outcome = 'error';
          this.log(`hermes: event stream for ${runId} failed: ${err.detail || describe(err)}`);
        }
        if (state.terminal || state.controller.signal.aborted) break;
        // Five reconnects in a row without progress, not five over a long run.
        if (state.lastSeq > seen) failures = 0;
        if (outcome === 'gone' || ++failures > RECONNECTS) {
          // Follow the run by its status. A stream that only kept failing is tried again once Hermes answers
          // that the run still goes on, so its text and approval requests come through again; a stream that
          // is gone is followed by status until the run ends.
          const res = await this.watch(state, name, outcome !== 'gone');
          if (res && res.status === 'running') {
            failures = 0;
            continue;
          }
          state.lost = true;
          state.terminal = res;
          break;
        }
        await sleep(Math.min(this.timing.backoff * 2 ** (failures - 1), 8 * this.timing.backoff), state.controller.signal);
      }
    } catch (err) {
      // Rukoo lets go of a run that may still be going: stop it first, so an approved action does not go on
      // where Stop no longer reaches it. watch(), the Stop button and dispose() already sent their own stop.
      if (!state.terminal && !state.stopping) {
        state.stopping = true;
        if (!(await this.sendStop(state))) this.keepStopping(state);
      }
      throw err;
    } finally {
      if (turn.signal) turn.signal.removeEventListener('abort', onAbort);
      clearTimeout(state.stopTimer);
      this.runs.delete(runId);
      // The run is over: a stop that did not go through no longer matters.
      if (state.terminal) this.settleStop(state);
    }
    for (const key of Object.values(state.open).flat()) turn.emit({ type: 'tool-end', key, error: false });
    const t = state.terminal;
    if (!t) return { status: 'stopped' };
    // The final output can hold more than what streamed (the connection dropped part-way, or only an earlier
    // segment streamed): add what is missing.
    if (t.status === 'done' && t.output) {
      const missing = missingText(state.text, state.segment, t.output, Boolean(state.lost));
      if (missing) turn.emit({ type: 'text', delta: missing });
    }
    if (t.status === 'error') turn.emit({ type: 'error', code: t.error.code, detail: t.error.detail });
    return t.status === 'error' ? { status: 'error', error: t.error } : { status: t.status };
  }

  // One connection to the run's event stream. Resolves 'end' | 'idle' | 'aborted' | 'gone'.
  async stream(turn, state, name) {
    const { key, url } = state.server;
    const { host } = this.base(url);
    const headers = { Authorization: `Bearer ${key}`, Accept: 'text/event-stream' };
    let path = `/v1/runs/${encodeURIComponent(state.runId)}/events`;
    if (state.lastSeq >= 0) {
      headers['Last-Event-ID'] = String(state.lastSeq);
      path += `?last_seq=${state.lastSeq}`;
    }
    // Only connecting has a deadline; the stream itself stays open as long as the run takes.
    const connect = new AbortController();
    const timer = setTimeout(() => connect.abort(), CONNECT_TIMEOUT);
    let res;
    try {
      res = await fetch(this.endpoint(path, url), { headers, redirect: 'error', signal: AbortSignal.any([connect.signal, state.controller.signal]) });
    } catch (err) {
      if (state.controller.signal.aborted) return 'aborted';
      throw networkError(err, host);
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 404) {
      res.body?.cancel().catch(() => {});
      return 'gone';
    }
    if (!res.ok) {
      // The connect deadline is over once the headers are in, so the body gets a deadline of its own.
      const text = await readCapped(res, this.timing.errorBody);
      let data = text;
      try {
        data = JSON.parse(text);
      } catch {}
      const err = httpError({ status: res.status, data });
      // A server or gateway error, a timeout or a rate limit can pass and says nothing about the run: like a
      // dropped connection, the stream is tried again and the run then followed by its status.
      if (res.status >= 500 || res.status === 408 || res.status === 429) throw new AgentError('offline', err.detail);
      throw err;
    }
    const parser = new SseParser((frame) => this.onFrame(turn, state, name, frame));
    return readSse(res.body, parser, { idleMs: SILENCE, signal: state.controller.signal });
  }

  // The run's state on the server: its terminal result, {status: 'running'} while Hermes still works on
  // it, or null when the server did not answer usefully.
  async poll(state) {
    const res = await this.request('GET', `/v1/runs/${encodeURIComponent(state.runId)}`, { server: state.server });
    if (!res.ok || !res.data) return null;
    const d = res.data;
    if (d.status === 'completed') return { status: 'done', output: d.output || '' };
    if (d.status === 'cancelled') return { status: 'stopped' };
    if (d.status === 'failed' || d.status === 'interrupted') return { status: 'error', error: this.failure(d) };
    if (['queued', 'running', 'waiting_for_approval', 'stopping'].includes(d.status)) return { status: 'running' };
    return null;
  }

  // Follows a run by its status once its event stream cannot be resumed. Hermes keeps the run going, so
  // giving up would leave an approved action running where Stop no longer reaches it. Returns the terminal
  // result, {status: 'running'} as soon as Hermes reports the run going on when retry is set, or null once
  // the turn is stopped. When the server stops answering, the run is stopped first, and a stop Hermes does
  // not take is sent again in the background.
  async watch(state, name, retry = false) {
    let misses = 0;
    while (!state.controller.signal.aborted) {
      const res = await this.poll(state).catch(() => null);
      if (res && (res.status !== 'running' || retry)) return res;
      if (res) misses = 0;
      else if (++misses >= this.timing.pollMisses) {
        state.stopping = true;
        if (await this.sendStop(state)) throw new AgentError('offline', `Lost the connection to ${name} during the turn; Rukoo stopped the run`);
        this.keepStopping(state);
        throw new AgentError('offline', `Lost the connection to ${name} during the turn; Rukoo keeps asking it to stop the run`);
      }
      await sleep(this.timing.pollEvery, state.controller.signal);
    }
    return null;
  }

  failure(data) {
    const detail = clip(data.error || data.message || data.turn_exit_reason || 'The run failed', 200);
    if (/\b429\b|rate.?limit/i.test(detail)) return { code: 'rate-limited', detail };
    if (data.event === 'run.interrupted' || data.status === 'interrupted') return { code: 'offline', detail };
    return { code: 'unknown', detail };
  }

  onFrame(turn, state, name, frame) {
    let data;
    try {
      data = JSON.parse(frame.data);
    } catch {
      return;
    }
    if (!data || typeof data !== 'object') return;
    const seq = typeof data.seq === 'number' ? data.seq : frame.id !== null && /^\d+$/.test(frame.id) ? Number(frame.id) : null;
    // A resumed stream replays from Last-Event-ID; never apply an event twice.
    if (seq !== null) {
      if (seq <= state.lastSeq) return;
      state.lastSeq = seq;
    }
    const event = data.event || frame.event;
    try {
      this.onEvent(turn, state, name, event, data);
    } catch (err) {
      this.log(`hermes: could not handle ${event}`, err);
    }
  }

  onEvent(turn, state, name, event, data) {
    switch (event) {
      case 'message.delta':
      case 'assistant.delta': {
        let delta = typeof data.delta === 'string' ? data.delta : '';
        // Text after a tool call starts with the blank lines that separated it in the model's output.
        if (!state.segment) delta = delta.replace(/^\s+/, '');
        if (!delta) return;
        state.segment += delta;
        // Kept across tool calls, to compare with the run's final output.
        state.text += delta;
        turn.emit({ type: 'text', delta });
        return;
      }
      case 'message.interim':
      case 'assistant.commentary':
        if (!data.already_streamed && typeof data.text === 'string' && data.text.trim()) {
          state.segment = '';
          turn.emit({ type: 'commentary', text: data.text.trim() });
        }
        return;
      case 'tool.started': {
        const tool = String(data.tool || data.tool_name || 'tool');
        const n = (state.counters[tool] = (state.counters[tool] || 0) + 1);
        const key = `${tool}#${n}`;
        (state.open[tool] = state.open[tool] || []).push(key);
        state.segment = '';
        turn.emit({ type: 'tool-start', key, name: tool, detail: clip(untag(data.preview || ''), 200) });
        return;
      }
      case 'tool.completed':
      case 'tool.failed': {
        const tool = String(data.tool || data.tool_name || 'tool');
        let key = state.open[tool] && state.open[tool].shift();
        if (!key) {
          // A completion without a start (it was before a reconnect window): show it anyway.
          const n = (state.counters[tool] = (state.counters[tool] || 0) + 1);
          key = `${tool}#${n}`;
          turn.emit({ type: 'tool-start', key, name: tool, detail: '' });
        }
        const error = event === 'tool.failed' || Boolean(data.error);
        const end = { type: 'tool-end', key, error };
        if (error && data.preview) end.detail = clip(data.preview, 200);
        state.segment = '';
        turn.emit(end);
        return;
      }
      case 'subagent.start': {
        const n = (state.counters.subagent = (state.counters.subagent || 0) + 1);
        const id = data.subagent_id || data.delegation_id || `#${n}`;
        const key = `subagent:${id}`;
        state.subagents.set(String(id), key);
        state.segment = '';
        turn.emit({ type: 'tool-start', key, name: 'subagent', detail: clip(data.goal || data.preview || '', 200) });
        return;
      }
      case 'subagent.complete': {
        let id = String(data.subagent_id || data.delegation_id || '');
        let key = state.subagents.get(id);
        if (!key) {
          const first = state.subagents.entries().next().value;
          if (!first) return;
          [id, key] = first;
        }
        state.subagents.delete(id);
        turn.emit({ type: 'tool-end', key, error: /fail|error/i.test(String(data.status || '')) });
        return;
      }
      case 'approval.request':
        state.segment = '';
        this.approval(turn, state, name, data).catch((err) => this.log('hermes: approval failed', err));
        return;
      case 'approval.responded': {
        // Answered somewhere else (another client, or Hermes timed it out): retire our card.
        const pending = state.approvals.get(String(data.request_id || ''));
        if (pending) this.expire(turn, pending);
        return;
      }
      case 'run.completed':
        state.terminal = { status: 'done', output: typeof data.output === 'string' ? data.output : '' };
        if (data.usage) turn.emit({ type: 'usage', ...data.usage });
        return;
      case 'run.cancelled':
        state.terminal = { status: 'stopped' };
        return;
      case 'run.failed':
      case 'run.interrupted':
        state.terminal = { status: 'error', error: this.failure(data) };
        return;
      case 'error':
        state.terminal = { status: 'error', error: { code: 'unknown', detail: clip(data.message || 'Hermes reported an error', 200) } };
        return;
      default:
        // reasoning.available and tool.progress repeat the visible text; the rest is bookkeeping.
        return;
    }
  }

  async approval(turn, state, name, data) {
    const ids = Array.isArray(data.choices) && data.choices.length ? data.choices : ['once', 'deny'];
    const choices = ids.map((id) => CHOICES[String(id).toLowerCase()]).filter(Boolean);
    if (!choices.some((c) => c.id === 'deny')) choices.push(CHOICES.deny);
    // The MCP trust gate reuses the command approval: "MCP tool '<t>' on UNTRUSTED server '<s>' wants to run…".
    const command = typeof data.command === 'string' ? data.command : '';
    let tool = { name: 'terminal', kind: 'command' };
    const fields = [];
    if (data.pattern_key === 'mcp_elicitation') {
      const m = /MCP tool '([^']+)' on (?:UNTRUSTED )?server '([^']+)'/i.exec(command);
      tool = m ? { name: `mcp__${m[2]}__${m[1]}`, kind: 'mcp', server: m[2], tool: m[1] } : { name: 'mcp', kind: 'other' };
      if (command) fields.push({ key: 'input', label: 'Tool', value: command });
    } else if (command) {
      // Whole: in ask mode this card is the only thing between Clark and the command.
      fields.push({ key: 'command', label: 'Command', value: command });
    }
    const requestId = String(data.request_id || '');
    const promise = turn.approve({
      title: approvalTitle(name, tool, 'a tool'),
      detail: clip(echoFree(typeof data.description === 'string' ? data.description : '', fields), 2000),
      fields,
      tool,
      choices,
      key: requestId || null
    });
    const pending = { promise, requestId };
    if (requestId) state.approvals.set(requestId, pending);
    let choice;
    try {
      choice = await promise;
    } finally {
      state.approvals.delete(requestId);
    }
    if (!choice || choice === 'cancel' || pending.expired || state.terminal) return;
    const body = { choice };
    if (requestId) body.request_id = requestId;
    await this.answer(turn, state, body);
  }

  // The user's choice for an approval. The card is gone once the user chose, so a lost answer would leave the run
  // waiting for a choice nobody can make again: no answer or a passing server error is sent again, with the same
  // request_id. An answer that still does not get through stops the run instead.
  async answer(turn, state, body) {
    let failure;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await sleep(this.timing.backoff * 2 ** (attempt - 1), state.controller.signal);
      // Stop wins: an answer sent after the user stopped would let the waiting command go on.
      if (state.terminal || state.stopping || state.controller.signal.aborted) return;
      let res;
      try {
        res = await this.request('POST', `/v1/runs/${encodeURIComponent(state.runId)}/approval`, { body, server: state.server });
      } catch (err) {
        if (!(err instanceof AgentError) || err.code !== 'offline') throw err;
        failure = err;
        continue;
      }
      // 409: the run ended or Hermes already gave up waiting; nothing left to answer.
      if (res.ok || res.status === 409) return;
      failure = httpError(res);
      if (!(res.status >= 500 || res.status === 408 || res.status === 429)) break;
    }
    if (state.terminal || state.stopping) return;
    // Whether Hermes takes the stop is not known yet; stopRun() keeps asking until it does.
    turn.emit({ type: 'error', code: failure.code, detail: `${failure.detail ? `${failure.detail}. ` : ''}Your answer did not reach Hermes, so Rukoo is asking it to stop the run.` });
    this.stopRun(state);
  }

  expire(turn, pending) {
    pending.expired = true;
    const itemId = (pending.promise && pending.promise.itemId) || pending.requestId;
    const cid = turn.conversation && turn.conversation.id;
    if (itemId && cid && this.hub && typeof this.hub.expireApproval === 'function') this.hub.expireApproval(cid, itemId);
  }

  stopRun(state) {
    if (state.stopping) return;
    state.stopping = true;
    this.sendStop(state, CONNECT_TIMEOUT).then((taken) => {
      // The turn ends after STOP_WAIT either way; a run that may still be going is asked again later.
      if (!taken && !state.terminal) this.keepStopping(state);
    });
    // The cancelled event normally follows within a second; do not wait on a server that went away.
    state.stopTimer = setTimeout(() => state.controller.abort(), STOP_WAIT);
  }

  // One stop request. true when Hermes took it or answered that nothing is left to stop: a run that already
  // ended answers 200 with its status, an unknown run 404, a run Hermes no longer holds 409 (run_not_active).
  // Anything else, an auth failure or no answer included, says nothing about the run: false.
  async sendStop(state, timeout = 5000) {
    try {
      const res = await this.request('POST', `/v1/runs/${encodeURIComponent(state.runId)}/stop`, { timeout, server: state.server });
      if (res.ok || res.status === 404 || res.status === 409) return true;
      this.log(`hermes: stopping ${state.runId} failed: HTTP ${res.status}`);
    } catch (err) {
      this.log(`hermes: stopping ${state.runId} failed: ${err.detail || describe(err)}`);
    }
    return false;
  }

  // Sends the stop of a run Rukoo let go of again until Hermes takes it: once the server answers again, an
  // approved action must not go on unseen. The wait doubles from timing.stopRetry up to ten times that.
  // dispose() makes a last try.
  keepStopping(state) {
    if (this.unstopped.has(state.runId)) return;
    this.unstopped.set(state.runId, state);
    let wait = this.timing.stopRetry;
    const schedule = () => {
      state.retryTimer = setTimeout(async () => {
        const taken = await this.sendStop(state);
        if (this.unstopped.get(state.runId) !== state) return;
        if (taken) return this.settleStop(state);
        wait = Math.min(wait * 2, 10 * this.timing.stopRetry);
        schedule();
      }, wait);
      // Never what keeps the app (or a test run) from exiting.
      if (state.retryTimer.unref) state.retryTimer.unref();
    };
    schedule();
  }

  settleStop(state) {
    clearTimeout(state.retryTimer);
    if (this.unstopped.get(state.runId) === state) this.unstopped.delete(state.runId);
  }

  async dispose() {
    // Followed runs and runs whose stop did not go through yet, each once.
    const runs = new Map([...this.unstopped, ...this.runs]);
    for (const state of this.unstopped.values()) clearTimeout(state.retryTimer);
    this.unstopped.clear();
    this.runs.clear();
    // A run outlives our connection on the server, so stop them explicitly (best effort, quickly).
    const stops = [...runs.values()].map((state) => {
      state.stopping = true;
      state.controller.abort();
      return this.sendStop(state, 2000);
    });
    // Runs still being started: within main's 5 seconds for a quit, at most an answer wait and two short requests.
    for (const entry of this.submitting) stops.push(this.stopSubmitted(entry));
    this.submitting.clear();
    await Promise.all(stops);
  }
}

module.exports = { HermesAdapter, missingText, splitModel };
