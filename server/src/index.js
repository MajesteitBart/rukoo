// The Rukoo account server. This Worker checks each request and hands it to the Durable Object of the account it
// belongs to; see PROTOCOL.md for the contract and README.md for running your own.
//
// There is no table of accounts or sessions anywhere. An account's object is found by a name derived from its email
// address and the PEPPER secret, and a session token starts with that name, so every request routes straight to one
// object and only that object knows whether the account or the session exists.

import pkg from '../package.json' with { type: 'json' };
import { hmac, sameBytes, sha256, toBase64url, utf8 } from './bytes.js';
import * as input from './input.js';
import { HttpError, invalid } from './input.js';
import { page } from './page.js';
import { privacy, privacyLanguage } from './privacy.js';

export { Account } from './account.js';

const JURISDICTIONS = ['eu', 'us', 'fedramp'];
const SIGNUP_MODES = ['open', 'invite', 'closed'];
// A shorter pepper is easier to guess, and with it the account name of any address.
const PEPPER_MIN = 16;
const NAME = /^[A-Za-z0-9_-]{43}$/;
const TOKEN = /^Bearer ([A-Za-z0-9_-]{43})\.[A-Za-z0-9_-]{43}$/i;
const DEVICE_PATH = /^\/v1\/devices\/([^/]+)$/;

export default {
  async fetch(request, env) {
    try {
      return await handle(request, env);
    } catch (err) {
      if (err instanceof HttpError) return json(err.status, { error: err.code, message: err.message }, err.headers);
      // Only the error itself is logged: never a body, a token or an address.
      console.error('Request failed:', err?.stack || err);
      return json(500, { error: 'server', message: 'Something went wrong on the server.' });
    }
  }
};

async function handle(request, env) {
  const url = new URL(request.url);
  const { pathname: path } = url;
  const method = request.method;

  const reading = method === 'GET' || method === 'HEAD';
  if (path === '/' && reading) return html(page(config(env, url)), method);
  if (path === '/privacy' && reading) {
    return html(privacy(config(env, url), privacyLanguage(url, request.headers.get('accept-language'))), method);
  }
  if (path === '/v1/info' && method === 'GET') return json(200, info(env, url));
  if (path !== '/v1' && !path.startsWith('/v1/')) throw notFound();

  const problem = configProblem(env);
  if (problem) throw new HttpError(500, 'not_configured', problem);

  const route = `${method} ${path}`;
  switch (route) {
    case 'POST /v1/prelogin':
      return prelogin(request, env);
    case 'POST /v1/signup':
      return signup(request, env);
    case 'POST /v1/login':
      return login(request, env);
    case 'POST /v1/recover/start':
      return recoverStart(request, env);
    case 'POST /v1/recover/finish':
      return recoverFinish(request, env);
    case 'POST /v1/logout': {
      const { stub, token } = session(request, env);
      return send(await stub.logout(token));
    }
    case 'GET /v1/account': {
      const { stub, token } = session(request, env);
      return send(await stub.account(token, limits(env)));
    }
    case 'POST /v1/password':
      return changePassword(request, env);
    case 'POST /v1/recovery':
      return replaceRecovery(request, env);
    case 'DELETE /v1/account':
      return deleteAccount(request, env);
    case 'GET /v1/records':
      return pull(request, env, url);
    case 'POST /v1/records':
      return push(request, env);
  }
  const device = path.match(DEVICE_PATH);
  if (device && method === 'DELETE') {
    const { stub, token } = session(request, env);
    if (!/^[A-Za-z0-9_-]{22}$/.test(device[1])) throw invalid('That is not a device id.');
    return send(await stub.revoke(token, device[1]));
  }
  throw notFound();
}

async function prelogin(request, env) {
  await limitRate(request, env);
  const body = await input.readJson(request);
  const email = input.email(body.email);
  const name = await accountName(env, email);
  const result = await stub(env, name).prelogin();
  if (result.body) return send(result);
  // An address without an account gets the default parameters and a salt that is the same on every call, so this
  // answer can't tell anyone whether an account exists.
  const salt = (await hmac(env.PEPPER, `salt\n${email}`)).slice(0, 16);
  return json(200, { kdf: input.DEFAULT_KDF, salt: toBase64url(salt) });
}

async function signup(request, env) {
  await limitRate(request, env);
  const body = await input.readJson(request);
  const mode = signups(env);
  if (mode === 'closed') throw new HttpError(403, 'signups_closed', 'This server does not take new accounts.');
  if (mode === 'invite' && !(await validInvite(env, body.invite))) {
    throw new HttpError(
      403,
      'invite_required',
      'This server takes new accounts by invitation. The invite code is missing or wrong.'
    );
  }
  const fields = {
    email: input.email(body.email),
    kdf: input.kdf(body.kdf),
    salt: input.key(body.salt, 'salt', 16),
    authKey: input.key(body.authKey, 'authKey', 32),
    wrappedKey: input.sealed(body.wrappedKey, 'wrappedKey'),
    recoveryAuth: input.key(body.recoveryAuth, 'recoveryAuth', 32),
    recoveryWrappedKey: input.sealed(body.recoveryWrappedKey, 'recoveryWrappedKey'),
    device: input.device(body.device)
  };
  const name = await accountName(env, fields.email);
  return send(await stub(env, name).signup(name, fields, limits(env)));
}

async function login(request, env) {
  await limitRate(request, env);
  const body = await input.readJson(request);
  const email = input.email(body.email);
  const fields = { authKey: input.key(body.authKey, 'authKey', 32), device: input.device(body.device) };
  const name = await accountName(env, email);
  return send(await stub(env, name).login(name, fields, limits(env)));
}

async function recoverStart(request, env) {
  await limitRate(request, env);
  const body = await input.readJson(request);
  const email = input.email(body.email);
  const fields = { recoveryAuth: input.key(body.recoveryAuth, 'recoveryAuth', 32) };
  return send(await stub(env, await accountName(env, email)).recoverStart(fields));
}

async function recoverFinish(request, env) {
  await limitRate(request, env);
  const body = await input.readJson(request);
  const email = input.email(body.email);
  const fields = {
    recoveryAuth: input.key(body.recoveryAuth, 'recoveryAuth', 32),
    kdf: input.kdf(body.kdf),
    salt: input.key(body.salt, 'salt', 16),
    authKey: input.key(body.authKey, 'authKey', 32),
    wrappedKey: input.sealed(body.wrappedKey, 'wrappedKey'),
    device: input.device(body.device)
  };
  const name = await accountName(env, email);
  return send(await stub(env, name).recoverFinish(name, fields, limits(env)));
}

async function changePassword(request, env) {
  const { stub, token } = session(request, env);
  const body = await input.readJson(request);
  const fields = {
    authKey: input.key(body.authKey, 'authKey', 32),
    kdf: input.kdf(body.kdf),
    salt: input.key(body.salt, 'salt', 16),
    newAuthKey: input.key(body.newAuthKey, 'newAuthKey', 32),
    wrappedKey: input.sealed(body.wrappedKey, 'wrappedKey')
  };
  return send(await stub.changePassword(token, fields));
}

async function replaceRecovery(request, env) {
  const { stub, token } = session(request, env);
  const body = await input.readJson(request);
  const fields = {
    authKey: input.key(body.authKey, 'authKey', 32),
    recoveryAuth: input.key(body.recoveryAuth, 'recoveryAuth', 32),
    recoveryWrappedKey: input.sealed(body.recoveryWrappedKey, 'recoveryWrappedKey')
  };
  return send(await stub.replaceRecovery(token, fields));
}

async function deleteAccount(request, env) {
  const { stub, token } = session(request, env);
  const body = await input.readJson(request);
  return send(await stub.deleteAccount(token, { authKey: input.key(body.authKey, 'authKey', 32) }));
}

async function pull(request, env, url) {
  const { stub, token } = session(request, env);
  const { since, limit } = input.pullQuery(url);
  return send(await stub.pull(token, since, limit));
}

async function push(request, env) {
  const { stub, token } = session(request, env);
  const body = await input.readPushJson(request);
  return send(await stub.push(token, input.records(body.records), limits(env)));
}

// The account object a bearer token points at. Only the token's shape is checked here; whether it is a live session
// is for the object to say.
function session(request, env) {
  const match = (request.headers.get('authorization') || '').match(TOKEN);
  if (!match) throw new HttpError(401, 'unauthorized', 'Sign in first.');
  return { stub: stub(env, match[1]), token: match[0].slice('Bearer '.length) };
}

async function accountName(env, email) {
  return toBase64url(await hmac(env.PEPPER, `account\n${email}`));
}

function stub(env, name) {
  if (!NAME.test(name)) throw new HttpError(401, 'unauthorized', 'Sign in first.');
  const where = jurisdiction(env);
  const namespace = where ? env.ACCOUNTS.jurisdiction(where) : env.ACCOUNTS;
  return namespace.get(namespace.idFromName(name));
}

// Limits sign-in, sign-up and recovery attempts per client address when the RATE_LIMITER binding exists. IPv6 clients
// usually have a whole /64 to pick addresses from, so they are counted by that.
async function limitRate(request, env) {
  if (!env.RATE_LIMITER) return;
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const { success } = await env.RATE_LIMITER.limit({ key: ip.includes(':') ? ipv6Prefix(ip) : ip });
  if (!success)
    throw new HttpError(429, 'rate_limited', 'Too many requests. Try again in a minute.', { 'retry-after': '60' });
}

function ipv6Prefix(ip) {
  const [head, tail = ''] = ip.toLowerCase().split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = ip.includes('::')
    ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right]
    : left;
  return `${groups
    .slice(0, 4)
    .map((g) => g.replace(/^0+(?=.)/, ''))
    .join(':')}::/64`;
}

// Every listed code works. Each is compared through its hash, so the comparison takes the same time whatever the
// codes' lengths, and every code is compared, so the time doesn't show which one matched.
async function validInvite(env, invite) {
  if (typeof invite !== 'string' || !invite.trim()) return false;
  const codes = String(env.INVITE_CODES || '')
    .split(',')
    .map((code) => code.trim())
    .filter(Boolean);
  const given = await sha256(utf8(invite.trim()));
  let found = false;
  for (const code of codes) {
    if (sameBytes(await sha256(utf8(code)), given)) found = true;
  }
  return found;
}

function configProblem(env) {
  if (typeof env.PEPPER !== 'string' || env.PEPPER.length < PEPPER_MIN) {
    return `This server has no PEPPER secret. Set a random one of at least ${PEPPER_MIN} characters with: npx wrangler secret put PEPPER`;
  }
  const where = String(env.JURISDICTION ?? '')
    .trim()
    .toLowerCase();
  if (where && !JURISDICTIONS.includes(where)) {
    return 'The JURISDICTION variable must be eu, us, fedramp or empty. Fix it in wrangler.jsonc and deploy again.';
  }
  return null;
}

function jurisdiction(env) {
  const where = String(env.JURISDICTION ?? '')
    .trim()
    .toLowerCase();
  return JURISDICTIONS.includes(where) ? where : null;
}

// Missing means invite, the default in wrangler.jsonc. Anything unrecognized means closed, so a typo never opens a
// server that was meant to be private.
function signups(env) {
  if (env.SIGNUPS === undefined) return 'invite';
  const mode = String(env.SIGNUPS).trim().toLowerCase();
  return SIGNUP_MODES.includes(mode) ? mode : 'closed';
}

function limits(env) {
  return {
    records: positive(env.MAX_RECORDS, 250000),
    bytes: positive(env.MAX_BYTES, 104857600),
    recordBytes: input.RECORD_BYTES,
    batch: input.BATCH
  };
}

function positive(value, fallback) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

function text(value) {
  const s = typeof value === 'string' ? value.trim() : '';
  return s || null;
}

// Without a PRIVACY_URL of its own, the server points to the statement it serves itself (privacy.js).
function config(env, url) {
  return {
    operator: {
      name: text(env.OPERATOR_NAME),
      url: text(env.OPERATOR_URL),
      contact: text(env.OPERATOR_CONTACT),
      privacy: text(env.PRIVACY_URL) || `${url.origin}/privacy`
    },
    jurisdiction: jurisdiction(env),
    signups: signups(env)
  };
}

function info(env, url) {
  const { operator, jurisdiction: where, signups: mode } = config(env, url);
  return {
    protocol: 1,
    version: pkg.version,
    operator,
    hosting: { provider: 'Cloudflare', company: 'Cloudflare, Inc.', country: 'US', jurisdiction: where },
    signups: mode,
    limits: limits(env)
  };
}

function notFound() {
  return new HttpError(404, 'not_found', 'There is nothing here.');
}

function send({ status, body, headers }) {
  return status === 204 ? new Response(null, { status, headers: baseHeaders(headers) }) : json(status, body, headers);
}

function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: baseHeaders({ 'content-type': 'application/json; charset=utf-8', ...headers })
  });
}

function html(body, method) {
  return new Response(method === 'HEAD' ? null : body, {
    headers: baseHeaders({
      'content-type': 'text/html; charset=utf-8',
      // The page has no scripts, frames or forms, and its only style is inline.
      'content-security-policy':
        "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
    })
  });
}

function baseHeaders(headers = {}) {
  return { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers };
}
