'use strict';

// OpenClaw: the user's own OpenClaw agent, reached through the OpenAI-compatible Chat Completions endpoint of their
// OpenClaw gateway (docs.openclaw.ai/gateway/openai-http-api, checked against openclaw v2026.10.5,
// src/gateway/openai-http.ts and openai-compatible-http.ts).
//
// - The endpoint is off until the gateway config turns on gateway.http.endpoints.chatCompletions.enabled. A gateway
//   without it answers 404, before it checks the token.
// - Every request carries the gateway token or password as a Bearer token.
// - `model` names an OpenClaw agent, not a provider model: openclaw/default (the gateway's default agent) or
//   openclaw/<agentId>. The x-openclaw-model header picks a backend model for that agent.
// - A request with the OpenAI `user` field keeps an agent session: the gateway derives the session key
//   agent:<agentId>:openai-user:<user> from it. Rukoo sends one value per chat and only the new message, because the
//   gateway keeps the transcript itself and turns earlier messages in a request into history text.
// - With stream: true the answer comes as SSE: `data: <chat.completion.chunk>` with text in choices[0].delta.content,
//   a chunk with finish_reason, then `data: [DONE]`. A run that fails part-way sends `data: {"error": {...}}` and
//   [DONE]. The stream carries the agent's text only, not its tool calls or thinking.
// - Closing the connection cancels the agent run. That is how Stop works; there is no stop endpoint for these runs.
//
// Node's fetch, as for Hermes (./http.js): the gateway usually listens on 127.0.0.1:18789, sometimes on a LAN or
// Tailscale address, which ../net.js refuses on purpose. Requests only go to the configured gateway and never follow
// redirects.
const crypto = require('crypto');
const { SseParser, readSse } = require('./sse');
const { AgentError, clip, logger } = require('./proc');
const { CONNECT_TIMEOUT, describe, networkError, readCapped, errorText, httpError, serverBase, serverEndpoint } = require('./http');

const STATUS_TTL = 30000;
// The gateway sends its headers before the run starts (setSseHeaders), but it reads the request body first, for up
// to 60 s.
const HEADERS_TIMEOUT = 30000;
// How long a failed response's body may take.
const ERROR_BODY_MS = 2000;
// The gateway sends no keepalives on this stream, and an agent can work for minutes without text (tool calls don't
// show). Only a silence this long counts as a dead connection; Stop ends a turn at any time.
const SILENCE = 30 * 60 * 1000;
const DEFAULT_AGENT = 'default';
const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

class OpenClawAdapter {
  // timing: test-only overrides of {silence, errorBody}.
  constructor({ id = 'openclaw', config, hub, log, timing } = {}) {
    this.id = id;
    this.timing = { silence: SILENCE, errorBody: ERROR_BODY_MS, ...(timing || {}) };
    this.config = typeof config === 'function' ? config : () => config || {};
    this.hub = hub || null;
    this.log = logger(log);
    this.cache = null;
    this.checking = null;
    this.checks = 0;
    this.cachedCheck = 0;
    // The turns that stream now, so dispose() can close their connections and with that cancel their runs.
    this.running = new Set();
  }

  settings() {
    const c = this.config() || {};
    const agent = String(c.agent || '').trim();
    return {
      enabled: c.enabled !== false,
      name: 'OpenClaw',
      url: String(c.url || '').trim(),
      key: String(c.key || '').trim(),
      agent: AGENT_ID.test(agent) ? agent : '',
      model: String(c.model || '').trim()
    };
  }

  ready(s = this.settings()) {
    if (!s.enabled) throw new AgentError('disabled', 'OpenClaw is turned off');
    if (!s.url || !s.key) throw new AgentError('not-configured', !s.url ? 'No gateway URL' : 'No gateway token');
    serverBase(s.url);
  }

  // A short JSON request to the gateway: {status, ok, data}.
  async request(method, path, { server, timeout = CONNECT_TIMEOUT } = {}) {
    const { url, key } = server || this.settings();
    const { host } = serverBase(url);
    let res;
    try {
      res = await fetch(serverEndpoint(url, path), {
        method,
        headers: { Accept: 'application/json', Authorization: `Bearer ${key}` },
        redirect: 'error',
        signal: AbortSignal.timeout(timeout)
      });
    } catch (err) {
      throw networkError(err, host, timeout);
    }
    let text = '';
    try {
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

  // The model menu: OpenClaw's /v1/models lists agents, not backend models, and the gateway has no list of those
  // over HTTP. So the menu offers Default and the model in Settings (x-openclaw-model). Chat Completions on the
  // gateway takes no reasoning effort, so there is no effort menu.
  async models() {
    this.ready();
    return { models: [], efforts: [], custom: [] };
  }

  // The gateway has no endpoint that lists an agent's skills, so the $ menu has none. OpenClaw still uses its skills
  // on its own.
  async skills() {
    this.ready();
    return [];
  }

  // Cached for 30 s; force (the Test button) skips the cache.
  async status({ force = false } = {}) {
    const s = this.settings();
    if (!s.enabled) return { state: 'disabled', detail: '' };
    if (!s.url) return { state: 'unconfigured', detail: 'No gateway URL' };
    if (!s.key) return { state: 'unconfigured', detail: 'No gateway token' };
    const key = [s.url, s.agent, crypto.createHash('sha256').update(s.key).digest('hex')].join('\0');
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

  // GET /v1/models needs the token, so it checks the address, the token and that the endpoint is on at once; the
  // gateway's /health doesn't check a token. The list also says whether the agent in Settings exists.
  async check(s) {
    try {
      const res = await this.request('GET', '/v1/models', { server: s });
      if (res.status === 401 || res.status === 403) return { state: 'unauthorized', detail: 'The gateway refused the token' };
      if (res.status === 404) return { state: 'unknown', detail: endpointOff().detail };
      if (!res.ok) return { state: res.status >= 500 || res.status === 429 ? 'offline' : 'unknown', detail: httpError(res).detail };
      const list = res.data && Array.isArray(res.data.data) ? res.data.data : null;
      if (!list) return { state: 'unknown', detail: 'The server at this address is not an OpenClaw gateway' };
      const agent = s.agent || DEFAULT_AGENT;
      const ids = new Set(list.map((m) => (m && typeof m.id === 'string' ? m.id.toLowerCase() : '')));
      if (s.agent && !ids.has(`openclaw/${agent.toLowerCase()}`)) return { state: 'unknown', detail: `The gateway has no agent "${agent}"` };
      return { state: 'ready', detail: `OpenClaw gateway, agent ${agent}` };
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
      if (!(err instanceof AgentError)) this.log('openclaw: turn failed', err);
      return { status: 'error', error: { code: e.code, detail: e.detail } };
    }
  }

  async turn(turn) {
    const s = this.settings();
    this.ready(s);
    if (turn.signal && turn.signal.aborted) return { status: 'stopped' };
    const conversation = turn.conversation || {};
    const known = conversation.provider || {};
    // A chat stays with the agent and the session it started with, also when Settings name another agent later: the
    // session key includes the agent.
    const agent = AGENT_ID.test(String(known.agent || '')) ? known.agent : s.agent || DEFAULT_AGENT;
    const user = typeof known.sessionUser === 'string' && known.sessionUser ? known.sessionUser : `rukoo:${conversation.id || crypto.randomUUID()}`;
    if (known.agent !== agent || known.sessionUser !== user) turn.setProvider({ agent, sessionUser: user });

    const messages = [];
    if (turn.instructions) messages.push({ role: 'system', content: turn.instructions });
    messages.push({ role: 'user', content: turn.input });
    const body = { model: `openclaw/${agent}`, user, stream: true, messages };
    const headers = { Accept: 'text/event-stream', 'Content-Type': 'application/json', Authorization: `Bearer ${s.key}` };
    // The chat's own model, else the model in Settings; without either the agent uses its own.
    const model = String(turn.model || '').trim() || s.model;
    if (model) headers['x-openclaw-model'] = model;

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
        res = await fetch(serverEndpoint(s.url, '/v1/chat/completions'), { method: 'POST', headers, body: JSON.stringify(body), redirect: 'error', signal: controller.signal });
      } catch (err) {
        if (turn.signal && turn.signal.aborted) return { status: 'stopped' };
        if (controller.signal.reason && controller.signal.reason.name === 'TimeoutError') throw new AgentError('offline', `No answer from ${host} within ${HEADERS_TIMEOUT / 1000} s`);
        throw networkError(err, host);
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) throw await this.failed(res);
      // The gateway has the message: the next one is not a first turn again, even when this one is stopped now.
      if (typeof turn.accepted === 'function') turn.accepted();
      return await this.follow(turn, res, controller);
    } finally {
      if (turn.signal) turn.signal.removeEventListener('abort', onAbort);
      this.running.delete(entry);
    }
  }

  // An answer other than the event stream, as an error with the gateway's own text.
  async failed(res) {
    const text = await readCapped(res, this.timing.errorBody);
    let data = text;
    try {
      data = JSON.parse(text);
    } catch {}
    // A gateway without the endpoint answers a plain 404 before it looks at the token.
    if (res.status === 404) return endpointOff();
    if (res.status === 409) return new AgentError('unknown', `${errorText(data) || 'OpenClaw archived this chat’s session'}. Restore the session in OpenClaw’s Control UI, or start a new chat.`);
    if (res.status === 503 || res.status === 502 || res.status === 504) return new AgentError('offline', httpError({ status: res.status, data }).detail);
    return httpError({ status: res.status, data });
  }

  // Reads the event stream into the turn until [DONE], an error, or Stop.
  async follow(turn, res, controller) {
    const state = { done: false, finished: false, error: null, text: false };
    const parser = new SseParser((frame) => this.onFrame(turn, state, frame));
    let outcome;
    try {
      outcome = await readSse(res.body, parser, { idleMs: this.timing.silence, signal: controller.signal });
    } catch (err) {
      if (turn.signal && turn.signal.aborted) return { status: 'stopped' };
      throw new AgentError('offline', `The connection to OpenClaw broke off: ${clip(describe(err), 160)}`);
    }
    if (turn.signal && turn.signal.aborted) return { status: 'stopped' };
    if (state.error) {
      turn.emit({ type: 'error', code: state.error.code, detail: state.error.detail });
      return { status: 'error', error: state.error };
    }
    if (outcome === 'idle') {
      // Closing the connection cancels the run on the gateway (readSse cancelled the body).
      throw new AgentError('timeout', `OpenClaw sent nothing for ${Math.round(this.timing.silence / 60000)} minutes; Rukoo closed the connection, which stops the run`);
    }
    // A stream that ended after its finish_reason but without [DONE] still finished.
    if (state.done || state.finished) return { status: 'done' };
    throw new AgentError('offline', 'The connection to OpenClaw closed before the answer was complete');
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
      const detail = clip(errorText(data) || 'OpenClaw reported an error', 200);
      const code = /\b429\b|rate.?limit/i.test(detail) ? 'rate-limited' : 'unknown';
      // An archived session is reported in the stream once it has started.
      state.error = { code, detail: /archiv/i.test(detail) ? `${detail}. Restore the session in OpenClaw’s Control UI, or start a new chat.` : detail };
      return;
    }
    const choice = Array.isArray(data.choices) ? data.choices[0] : null;
    if (!choice) return;
    const delta = choice.delta && typeof choice.delta.content === 'string' ? choice.delta.content : '';
    if (delta) {
      // The first text of an answer can start with the blank lines that separated it in the model's output.
      const text = state.text ? delta : delta.replace(/^\s+/, '');
      if (text) {
        state.text = true;
        turn.emit({ type: 'text', delta: text });
      }
    }
    if (choice.finish_reason) state.finished = true;
  }

  async dispose() {
    // Closing each connection cancels its run on the gateway.
    for (const entry of this.running) entry.controller.abort();
    this.running.clear();
  }
}

function endpointOff() {
  return new AgentError('not-configured', 'The gateway has no Chat Completions endpoint. Turn on gateway.http.endpoints.chatCompletions.enabled in the OpenClaw config');
}

module.exports = { OpenClawAdapter };
