'use strict';

// "Aanmelden met Google": OAuth 2.0 for installed apps with a loopback redirect and PKCE.
// https://developers.google.com/identity/protocols/oauth2/native-app
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');

const SCOPES = ['openid', 'email', 'profile', 'https://mail.google.com/'];
const ENDPOINTS = {
  auth: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token'
};
const SIGN_IN_TIMEOUT = 5 * 60 * 1000;

function oauthError(message, code) {
  const err = new Error(message);
  err.oauth = true;
  err.code = code;
  return err;
}

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeJwtPayload(jwt) {
  const part = String(jwt || '').split('.')[1];
  if (!part) return {};
  return JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
}

const PAGE = (title, text) => `<!doctype html><html lang="nl"><meta charset="utf-8"><title>${title}</title>
<body style="font:16px 'Segoe UI',sans-serif;background:#111;color:#eee;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center;max-width:420px"><h1 style="font-weight:600;font-size:24px">${title}</h1><p style="color:#aaa">${text}</p></div></body></html>`;

class GoogleAuth {
  // configPath: JSON with {client_id, client_secret} (gogcli format) or Google's {installed: {...}} download.
  constructor({ configPath, openBrowser, endpoints = ENDPOINTS, fetchImpl = fetch }) {
    this.configPath = configPath;
    this.openBrowser = openBrowser;
    this.endpoints = endpoints;
    this.fetch = fetchImpl;
    this.pending = null;
  }

  client() {
    if (process.env.SEM_GOOGLE_CLIENT_ID && process.env.SEM_GOOGLE_CLIENT_SECRET) {
      return { id: process.env.SEM_GOOGLE_CLIENT_ID, secret: process.env.SEM_GOOGLE_CLIENT_SECRET };
    }
    try {
      const raw = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
      const c = raw.installed || raw.web || raw;
      if (c.client_id && c.client_secret) return { id: c.client_id, secret: c.client_secret };
    } catch (_) {
      // No config file: Google sign-in is unavailable, app passwords still work.
    }
    return null;
  }

  available() {
    return Boolean(this.client());
  }

  // Imports a client file chosen by the user (Google Cloud "OAuth client" JSON download).
  importClient(file) {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const c = raw.installed || raw.web || raw;
    if (!c.client_id || !c.client_secret) throw new Error('Dit bestand bevat geen Google OAuth-client.');
    fs.writeFileSync(this.configPath, JSON.stringify({ client_id: c.client_id, client_secret: c.client_secret }), { mode: 0o600 });
  }

  cancel() {
    if (this.pending) this.pending(oauthError('Aanmelden geannuleerd.', 'cancelled'));
  }

  async signIn(loginHint) {
    const client = this.client();
    if (!client) throw oauthError('Google-aanmelding is niet ingesteld op deze pc.', 'no_client');
    this.cancel();

    const verifier = base64url(crypto.randomBytes(48));
    const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
    const state = base64url(crypto.randomBytes(24));

    const server = http.createServer();
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const redirectUri = `http://127.0.0.1:${server.address().port}/`;

    try {
      const code = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(oauthError('Aanmelden duurde te lang. Probeer het opnieuw.', 'timeout')), SIGN_IN_TIMEOUT);
        this.pending = (err) => {
          clearTimeout(timer);
          reject(err);
        };
        server.on('request', (req, res) => {
          const url = new URL(req.url, redirectUri);
          if (url.pathname !== '/') {
            res.writeHead(404).end();
            return;
          }
          const params = url.searchParams;
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          if (params.get('state') !== state) {
            res.end(PAGE('Aanmelden mislukt', 'Ongeldige aanvraag. Start het aanmelden opnieuw vanuit Rukoo Mail.'));
            return;
          }
          clearTimeout(timer);
          if (params.get('error')) {
            res.end(PAGE('Aanmelden geannuleerd', 'Je kunt dit tabblad sluiten.'));
            reject(oauthError(params.get('error') === 'access_denied' ? 'Je hebt geen toegang gegeven.' : `Google: ${params.get('error')}`, params.get('error')));
            return;
          }
          res.end(PAGE('Je bent aangemeld', 'Je kunt dit tabblad sluiten en teruggaan naar Rukoo Mail.'));
          resolve(params.get('code'));
        });

        const url = new URL(this.endpoints.auth);
        const query = {
          client_id: client.id,
          redirect_uri: redirectUri,
          response_type: 'code',
          scope: SCOPES.join(' '),
          access_type: 'offline',
          prompt: 'consent',
          code_challenge: challenge,
          code_challenge_method: 'S256',
          state
        };
        if (loginHint) query.login_hint = loginHint;
        for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
        Promise.resolve(this.openBrowser(url.toString())).catch(reject);
      });

      const tokens = await this.tokenRequest({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        code_verifier: verifier,
        client_id: client.id,
        client_secret: client.secret
      });
      const granted = String(tokens.scope || '').split(' ');
      if (!granted.includes('https://mail.google.com/')) {
        throw oauthError('Geef Rukoo Mail toegang tot Gmail (vink alle machtigingen aan) en probeer het opnieuw.', 'scope');
      }
      if (!tokens.refresh_token) throw oauthError('Google gaf geen vernieuwingstoken terug. Probeer het opnieuw.', 'no_refresh');
      const profile = decodeJwtPayload(tokens.id_token);
      if (!profile.email) throw oauthError('Google gaf geen e-mailadres terug.', 'no_email');
      return {
        email: profile.email,
        name: profile.name || '',
        refreshToken: tokens.refresh_token,
        accessToken: tokens.access_token,
        expiresAt: Date.now() + (Number(tokens.expires_in) || 3600) * 1000
      };
    } finally {
      this.pending = null;
      server.close();
      server.closeAllConnections?.();
    }
  }

  async refresh(refreshToken) {
    const client = this.client();
    if (!client) throw oauthError('Google-aanmelding is niet ingesteld op deze pc.', 'no_client');
    const tokens = await this.tokenRequest({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: client.id,
      client_secret: client.secret
    });
    return { accessToken: tokens.access_token, expiresAt: Date.now() + (Number(tokens.expires_in) || 3600) * 1000 };
  }

  async tokenRequest(form) {
    let res;
    try {
      res = await this.fetch(this.endpoints.token, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(form).toString(),
        redirect: 'error'
      });
    } catch (_) {
      throw oauthError('Kan Google niet bereiken. Controleer je internetverbinding.', 'network');
    }
    const body = await res.json().catch(() => ({}));
    if (res.ok) return body;
    if (body.error === 'invalid_grant') {
      throw oauthError('Je Google-toegang is verlopen of ingetrokken. Meld je opnieuw aan via Instellingen.', 'invalid_grant');
    }
    throw oauthError(`Google weigerde de aanvraag (${body.error || res.status}).`, body.error || 'token_error');
  }
}

module.exports = { GoogleAuth, SCOPES, decodeJwtPayload };
