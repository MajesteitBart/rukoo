'use strict';

// Helpers for the agents Rukoo reaches over HTTP: Hermes (hermes.js) and an OpenClaw gateway (openclaw.js).
// Both use Node's fetch, not ../net.js: that module only goes to public addresses, and these servers sit on a
// Tailscale address or on this computer. Requests only ever go to the configured server and never follow redirects.
const { AgentError, clip } = require('./proc');

// How long connecting to a server, or a short request to it, may take.
const CONNECT_TIMEOUT = 8000;

function describe(err) {
  const cause = err && err.cause;
  if (cause && cause.code) return [cause.code, cause.address && `${cause.address}:${cause.port}`].filter(Boolean).join(' ');
  if (cause && cause.message) return cause.message;
  return (err && err.message) || String(err);
}

// fetch() failures: no route, refused, reset, or our own connect timeout.
function networkError(err, host, timeout = CONNECT_TIMEOUT) {
  if (err instanceof AgentError) return err;
  if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) return new AgentError('offline', `No answer from ${host} within ${timeout / 1000} s`);
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

// A server with an optional path prefix (Hermes serves profiles under /p/<name>/).
function serverBase(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new AgentError('not-configured', 'The server URL is not valid');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new AgentError('not-configured', 'The server URL must start with http:// or https://');
  return { origin: parsed.origin, prefix: parsed.pathname.replace(/\/+$/, ''), host: parsed.host };
}

// The URL of path on the server, refusing one that would leave it.
function serverEndpoint(url, path) {
  const { origin, prefix } = serverBase(url);
  const out = new URL(prefix + path, origin);
  if (out.origin !== origin) throw new AgentError('protocol', 'Refusing a request outside the configured server');
  return out;
}

module.exports = { CONNECT_TIMEOUT, describe, networkError, readCapped, errorText, httpError, serverBase, serverEndpoint };
