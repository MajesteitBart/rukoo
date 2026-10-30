'use strict';

// Signing in to a video service: OAuth 2.0 for native apps with a loopback redirect and PKCE (RFC 8252, RFC 7636), the
// way google.js signs in to Google. One flow serves every service; each adapter names its endpoints, scopes and the
// shape of its redirect address, because Zoom matches 127.0.0.1 and Microsoft matches localhost, both ignoring the port.
const http = require('http');
const crypto = require('crypto');
const { t, getLanguage } = require('../../i18n');

const SIGN_IN_TIMEOUT = 5 * 60 * 1000;
// A token request that hangs would hold up the booking behind it.
const TOKEN_TIMEOUT = 30000;

// An error the video services and the booking page act on: code is 'cancelled', 'denied', 'timeout', 'network',
// 'renew' (the stored sign-in no longer works), 'off' (not connected here), 'unavailable' (no OAuth client),
// 'not_found', 'refused' or 'failed'.
function videoError(code, message) {
  const err = new Error(message);
  err.video = true;
  err.code = code;
  return err;
}

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const escHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const PAGE = (title, text) => `<!doctype html><html lang="${getLanguage()}"><meta charset="utf-8"><title>${escHtml(title)}</title>
<body style="font:16px 'Segoe UI',sans-serif;background:#111;color:#eee;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center;max-width:420px"><h1 style="font-weight:600;font-size:24px">${escHtml(title)}</h1><p style="color:#aaa">${escHtml(text)}</p></div></body></html>`;

// Listens on a free port of the loopback address. For 'localhost' it also tries the IPv6 loopback on the same port,
// as a browser may reach localhost there first.
async function listen(host, handler) {
  const servers = [];
  const open = (address, port) =>
    new Promise((resolve, reject) => {
      const s = http.createServer(handler);
      s.once('error', reject);
      s.listen(port, address, () => {
        servers.push(s);
        resolve(s.address().port);
      });
    });
  const port = await open('127.0.0.1', 0);
  if (host === 'localhost') await open('::1', port).catch(() => {});
  const close = () => {
    for (const s of servers) {
      s.close();
      s.closeAllConnections?.();
    }
  };
  return { port, close };
}

class OAuthFlow {
  // openBrowser(url): shows the service's sign-in page; fetchImpl: for tests.
  constructor({ openBrowser, fetchImpl = fetch }) {
    this.openBrowser = openBrowser;
    this.fetch = fetchImpl;
    this.pending = null;
    // Counts sign-ins and cancels, so one cancelled while it still opens its port stops there.
    this.generation = 0;
  }

  cancel() {
    this.generation += 1;
    if (this.pending) this.pending();
  }

  // provider: { name, auth, token, scopes, host, path, params, basicAuth } from an adapter; client: { id, secret }.
  // Returns the token answer, with redirectUri.
  async signIn(provider, client) {
    this.cancel();
    const mine = this.generation;
    const name = provider.name;
    const verifier = base64url(crypto.randomBytes(48));
    const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
    const state = base64url(crypto.randomBytes(24));
    const path = provider.path || '';
    let deliver = () => {};
    // This sign-in's cancel. A newer sign-in replaces it, and this one's end mustn't clear the newer one's.
    let cancelMine = null;
    const loop = await listen(provider.host, (req, res) => deliver(req, res));
    const redirectUri = `http://${provider.host}:${loop.port}${path}`;
    try {
      if (this.generation !== mine) throw videoError('cancelled', t('errors.video.cancelled', { service: name }));
      const code = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(videoError('timeout', t('errors.video.timeout', { service: name }))), SIGN_IN_TIMEOUT);
        cancelMine = () => {
          clearTimeout(timer);
          reject(videoError('cancelled', t('errors.video.cancelled', { service: name })));
        };
        this.pending = cancelMine;
        deliver = (req, res) => {
          const url = new URL(req.url, `http://${provider.host}:${loop.port}`);
          if (url.pathname !== (path || '/')) {
            res.writeHead(404).end();
            return;
          }
          const params = url.searchParams;
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          if (params.get('state') !== state) {
            res.end(PAGE(t('setup.google.failed'), t('setup.google.invalidRequest')));
            return;
          }
          clearTimeout(timer);
          if (params.get('error') || !params.get('code')) {
            res.end(PAGE(t('setup.google.cancelled'), t('setup.google.closeTab')));
            const denied = !params.get('error') || params.get('error') === 'access_denied';
            reject(denied ? videoError('denied', t('errors.video.denied', { service: name })) : videoError('failed', t('errors.video.request', { service: name, reason: params.get('error') })));
            return;
          }
          res.end(PAGE(t('setup.google.success'), t('setup.google.return')));
          resolve(params.get('code'));
        };
        const url = new URL(provider.auth);
        const query = { client_id: client.id, redirect_uri: redirectUri, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', state, ...(provider.params || {}) };
        if (provider.scopes && provider.scopes.length) query.scope = provider.scopes.join(' ');
        for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
        Promise.resolve(this.openBrowser(url.toString())).catch(reject);
      });
      const tokens = await this.token(provider, client, { grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier });
      return { ...tokens, redirectUri };
    } finally {
      if (this.pending === cancelMine) this.pending = null;
      loop.close();
    }
  }

  // A new access token from a refresh token. Any refusal means the stored sign-in no longer works ('renew').
  refresh(provider, client, refreshToken) {
    const form = { grant_type: 'refresh_token', refresh_token: refreshToken };
    if (provider.refreshScopes && provider.scopes) form.scope = provider.scopes.join(' ');
    return this.token(provider, client, form, { refreshing: true });
  }

  // Zoom takes a confidential client's id and secret as Basic authentication; a public client, and Microsoft, send the
  // id in the form.
  async token(provider, client, form, { refreshing = false } = {}) {
    const name = provider.name;
    const headers = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
    const body = { ...form };
    if (client.secret && provider.basicAuth) headers.authorization = `Basic ${Buffer.from(`${client.id}:${client.secret}`).toString('base64')}`;
    else {
      body.client_id = client.id;
      if (client.secret) body.client_secret = client.secret;
    }
    let res;
    try {
      res = await this.fetch(provider.token, { method: 'POST', headers, body: new URLSearchParams(body).toString(), redirect: 'error', signal: AbortSignal.timeout(TOKEN_TIMEOUT) });
    } catch (_) {
      throw videoError('network', t('errors.video.connection', { service: name }));
    }
    let answer = {};
    try {
      answer = await res.json();
    } catch (_) {
      // An answer cut off halfway has no token in it.
      if (res.ok) throw videoError('network', t('errors.video.connection', { service: name }));
    }
    if (res.ok && answer && typeof answer.access_token === 'string') return answer;
    if (res.status >= 500 || res.status === 429) throw videoError('network', t('errors.video.connection', { service: name }));
    if (refreshing || (answer && answer.error === 'invalid_grant')) throw videoError('renew', t('errors.video.expired', { service: name }));
    const reason = (answer && (answer.error_description || answer.reason || answer.error)) || res.status;
    throw videoError('failed', t('errors.video.request', { service: name, reason: String(reason).split(/\r?\n/)[0].slice(0, 200) }));
  }
}

module.exports = { OAuthFlow, videoError, base64url };
