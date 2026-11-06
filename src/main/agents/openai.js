'use strict';

// A custom agent on a server with an OpenAI-compatible Chat Completions endpoint (config.js, protocol 'openai'). Most
// agent frameworks serve one, and so do model servers such as LiteLLM, vLLM and Ollama.
//
// - Each turn is one POST /v1/chat/completions with stream: true. The answer comes as SSE: `data:
//   <chat.completion.chunk>` with text in choices[0].delta.content, a chunk with finish_reason, then `data: [DONE]`.
//   An error part-way comes as `data: {"error": {...}}`. Tool calls and reasoning in the stream aren't shown.
// - A plain Chat Completions server keeps no conversation. With history on (the default) Rukoo keeps the chat's
//   earlier turns in the chat's provider state and sends them with each message, up to HISTORY_MAX characters, oldest
//   dropped first. A server that keeps the conversation itself, as OpenClaw's gateway does, gets the OpenAI `user`
//   field (`rukoo:<chat id>`) with every request, and history can be turned off for it.
// - The key is optional, for a server on this computer that takes none. With a key, every request carries it as a
//   Bearer token. Requests only go to the configured server and never follow redirects.
// - Closing the connection is how Stop works; there is no stop endpoint for these runs.
//
// Node's fetch, as for Hermes and OpenClaw (./http.js): the server can be on a LAN or Tailscale address.
const crypto = require('crypto');
const { SseParser, readSse } = require('./sse');
const { AgentError, clip, logger } = require('./proc');
const { CONNECT_TIMEOUT, describe, networkError, readCapped, errorText, httpError, serverBase, serverEndpoint } = require('./http');

const STATUS_TTL = 30000;
const HEADERS_TIMEOUT = 60000;
const ERROR_BODY_MS = 2000;
// An agent can work for minutes without text: only this much silence counts as a dead connection.
const SILENCE = 30 * 60 * 1000;
const MAX_MODELS = 300;
// The earlier turns Rukoo keeps per chat, in characters. A first message carries the email, so a few long ones fill it.
const HISTORY_MAX = 200000;

class OpenAiAdapter {
  constructor({ id, config, hub, log, timing } = {}) {
    this.id = id;
    this.timing = { silence: SILENCE, errorBody: ERROR_BODY_MS, ...(timing || {}) };
    this.config = typeof config === 'function' ? config : () => config || {};
    this.hub = hub || null;
    this.log = logger(log);
    this.cache = null;
    this.checking = null;
    this.checks = 0;
    this.cachedCheck = 0;
    this.running = new Set();
  }

  settings() {
    const c = this.config() || {};
    return {
      enabled: c.enabled !== false,
      name: String(c.name || '').trim() || 'Agent',
      url: String(c.url || '').trim(),
      key: String(c.key || '').trim(),
      model: String(c.model || '').trim(),
      history: c.history !== false
    };
  }

  ready(s = this.settings()) {
    if (!s.enabled) throw new AgentError('disabled', `${s.name} is turned off`);
    if (!s.url) throw new AgentError('not-configured', 'No server URL');
    serverBase(s.url);
  }

  headers(key, extra = {}) {
    return { Accept: 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}), ...extra };
  }

  async request(method, path, { server, timeout = CONNECT_TIMEOUT } = {}) {
    const { url, key } = server || this.settings();
    const { host } = serverBase(url);
    let res;
    let text = '';
    try {
      res = await fetch(serverEndpoint(url, path), { method, headers: this.headers(key), redirect: 'error', signal: AbortSignal.timeout(timeout) });
      text = await res.text();
    } catch (err) {
      throw networkError(err, host, timeout);
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
    this.cachedCheck = this.checks;
  }

  configChanged() {
    this.invalidate();
  }

  // The model menu: what GET /v1/models lists. Chat Completions has no common way to pass an effort, so there is no
  // effort menu.
  async models() {
    const s = this.settings();
    this.ready(s);
    const res = await this.request('GET', '/v1/models', { server: s });
    if (res.status === 404) return { models: [], efforts: [], custom: [] };
    if (!res.ok) throw httpError(res);
    const list = res.data && Array.isArray(res.data.data) ? res.data.data : [];
    const models = [];
    for (const m of list) {
      if (models.length >= MAX_MODELS) break;
      const id = m && typeof m.id === 'string' ? m.id.trim() : '';
      if (id && id.length <= 150 && !models.some((x) => x.id === id)) models.push({ id, label: id, efforts: [] });
    }
    return { models, efforts: [], custom: [] };
  }

  // Chat Completions has no list of an agent's skills.
  async skills() {
    this.ready();
    return [];
  }

  async status({ force = false } = {}) {
    const s = this.settings();
    if (!s.enabled) return { state: 'disabled', detail: '' };
    if (!s.url) return { state: 'unconfigured', detail: 'No server URL' };
    const key = [s.url, crypto.createHash('sha256').update(s.key).digest('hex')].join('\0');
    if (!force && this.cache && this.cache.key === key && Date.now() - this.cache.at < STATUS_TTL) return this.cache.value;
    if (!force && this.checking && this.checking.key === key) return this.checking.promise;
    const n = ++this.checks;
    const promise = this.check(s).then((value) => {
      if (this.checking && this.checking.promise === promise) this.checking = null;
      if (n > this.cachedCheck) {
        this.cachedCheck = n;
        this.cache = { key, at: Date.now(), value };
      }
      return value;
    });
    this.checking = { key, promise };
    return promise;
  }

  // GET /v1/models checks the address and the key at once. A server without that route can still chat, so a 404
  // there counts as ready.
  async check(s) {
    try {
      const res = await this.request('GET', '/v1/models', { server: s });
      if (res.status === 401 || res.status === 403) return { state: 'unauthorized', detail: 'The server refused the key' };
      if (res.status === 404) return { state: 'ready', detail: 'The server lists no models' };
      if (!res.ok) return { state: res.status >= 500 || res.status === 429 ? 'offline' : 'unknown', detail: httpError(res).detail };
      const list = res.data && Array.isArray(res.data.data) ? res.data.data : null;
      if (!list) return { state: 'unknown', detail: 'The server at this address is not OpenAI-compatible' };
      return { state: 'ready', detail: `OpenAI-compatible, ${list.length} model${list.length === 1 ? '' : 's'}` };
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
      if (!(err instanceof AgentError)) this.log('openai: turn failed', err);
      return { status: 'error', error: { code: e.code, detail: e.detail } };
    }
  }

  async turn(turn) {
    const s = this.settings();
    this.ready(s);
    if (turn.signal && turn.signal.aborted) return { status: 'stopped' };
    const conversation = turn.conversation || {};
    const known = conversation.provider || {};
    const user = typeof known.sessionUser === 'string' && known.sessionUser ? known.sessionUser : `rukoo:${conversation.id || crypto.randomUUID()}`;
    if (known.sessionUser !== user) turn.setProvider({ sessionUser: user });
    const history = s.history ? cleanHistory(known.history) : [];

    const messages = [];
    if (turn.instructions) messages.push({ role: 'system', content: turn.instructions });
    messages.push(...history, { role: 'user', content: turn.input });
    // The chat's own model, else the model in Settings. A server that serves one agent often ignores it.
    const model = String(turn.model || '').trim() || s.model || 'default';
    const body = { model, user, stream: true, messages };

    const { host } = serverBase(s.url);
    const controller = new AbortController();
    const entry = { controller };
    this.running.add(entry);
    const onAbort = () => controller.abort();
    if (turn.signal) turn.signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(new DOMException('timeout', 'TimeoutError')), HEADERS_TIMEOUT);
    try {
      let res;
      try {
        res = await fetch(serverEndpoint(s.url, '/v1/chat/completions'), {
          method: 'POST',
          headers: this.headers(s.key, { Accept: 'text/event-stream', 'Content-Type': 'application/json' }),
          body: JSON.stringify(body),
          redirect: 'error',
          signal: controller.signal
        });
      } catch (err) {
        if (turn.signal && turn.signal.aborted) return { status: 'stopped' };
        if (controller.signal.reason && controller.signal.reason.name === 'TimeoutError') throw new AgentError('offline', `No answer from ${host} within ${HEADERS_TIMEOUT / 1000} s`);
        throw networkError(err, host);
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) throw await this.failed(res);
      if (typeof turn.accepted === 'function') turn.accepted();
      const state = { done: false, finished: false, error: null, text: '' };
      // The server had the message, so it goes into the history however the turn ends: Rukoo counts it as delivered
      // and won't send the email again. An answer cut off by Stop or a broken connection goes in as far as it came.
      const keep = (complete) => {
        if (!s.history) return;
        const answer = complete || !state.text ? state.text : `${state.text}\n\n[This answer was cut off here.]`;
        turn.setProvider({ history: trimHistory([...history, { role: 'user', content: turn.input }, ...(answer ? [{ role: 'assistant', content: answer }] : [])]) });
      };
      let result;
      try {
        result = await this.follow(turn, res, controller, state, s.name);
      } catch (err) {
        keep(false);
        throw err;
      }
      keep(result.status === 'done');
      return result;
    } finally {
      if (turn.signal) turn.signal.removeEventListener('abort', onAbort);
      this.running.delete(entry);
    }
  }

  async failed(res) {
    const text = await readCapped(res, this.timing.errorBody);
    let data = text;
    try {
      data = JSON.parse(text);
    } catch {}
    if (res.status === 404) return new AgentError('not-configured', 'The server has no /v1/chat/completions endpoint');
    if (res.status === 503 || res.status === 502 || res.status === 504) return new AgentError('offline', httpError({ status: res.status, data }).detail);
    return httpError({ status: res.status, data });
  }

  async follow(turn, res, controller, state, name) {
    const parser = new SseParser((frame) => this.onFrame(turn, state, frame));
    let outcome;
    try {
      outcome = await readSse(res.body, parser, { idleMs: this.timing.silence, signal: controller.signal });
    } catch (err) {
      if (turn.signal && turn.signal.aborted) return { status: 'stopped' };
      throw new AgentError('offline', `The connection to ${name} broke off: ${clip(describe(err), 160)}`);
    }
    if (turn.signal && turn.signal.aborted) return { status: 'stopped' };
    if (state.error) {
      turn.emit({ type: 'error', code: state.error.code, detail: state.error.detail });
      return { status: 'error', error: state.error };
    }
    if (outcome === 'idle') throw new AgentError('timeout', `${name} sent nothing for ${Math.round(this.timing.silence / 60000)} minutes; Rukoo closed the connection`);
    if (state.done || state.finished) return { status: 'done' };
    throw new AgentError('offline', `The connection to ${name} closed before the answer was complete`);
  }

  onFrame(turn, state, frame) {
    const raw = frame.data.trim();
    if (raw === '[DONE]') {
      state.done = true;
      return;
    }
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }
    if (!data || typeof data !== 'object') return;
    if (data.error) {
      const detail = clip(errorText(data) || 'The server reported an error', 200);
      state.error = { code: /\b429\b|rate.?limit/i.test(detail) ? 'rate-limited' : 'unknown', detail };
      return;
    }
    const choice = Array.isArray(data.choices) ? data.choices[0] : null;
    if (!choice) return;
    const delta = choice.delta && typeof choice.delta.content === 'string' ? choice.delta.content : '';
    if (delta) {
      const text = state.text ? delta : delta.replace(/^\s+/, '');
      if (text) {
        state.text += text;
        turn.emit({ type: 'text', delta: text });
      }
    }
    if (choice.finish_reason) state.finished = true;
  }

  async dispose() {
    for (const entry of this.running) entry.controller.abort();
    this.running.clear();
  }
}

// The history as stored: user and assistant messages with text, nothing else.
function cleanHistory(list) {
  return (Array.isArray(list) ? list : []).filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string').map((m) => ({ role: m.role, content: m.content }));
}

// Drops the oldest turns until the history fits, a user message and its answer at a time.
function trimHistory(list) {
  const out = cleanHistory(list);
  let size = out.reduce((n, m) => n + m.content.length, 0);
  while (out.length > 2 && size > HISTORY_MAX) {
    const dropped = out.splice(0, out[1] && out[1].role === 'assistant' ? 2 : 1);
    size -= dropped.reduce((n, m) => n + m.content.length, 0);
  }
  return out;
}

module.exports = { OpenAiAdapter, trimHistory, HISTORY_MAX };
