// Settings read from the Worker's environment, shared by the account routes, the booking routes and the objects.
// Every Durable Object namespace goes through the configured jurisdiction: an object is found per jurisdiction, so
// one looked up without it would seem not to exist.

import { HttpError } from './input.js';

export const JURISDICTIONS = ['eu', 'us', 'fedramp'];
const SIGNUP_MODES = ['open', 'invite', 'closed'];
// A shorter pepper is easier to guess, and with it the account name of any address.
const PEPPER_MIN = 16;
export const ACCOUNT_NAME = /^[A-Za-z0-9_-]{43}$/;

export function configProblem(env) {
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

export function checkConfig(env) {
  const problem = configProblem(env);
  if (problem) throw new HttpError(500, 'not_configured', problem);
}

export function jurisdiction(env) {
  const where = String(env.JURISDICTION ?? '')
    .trim()
    .toLowerCase();
  return JURISDICTIONS.includes(where) ? where : null;
}

function namespace(env, binding) {
  const where = jurisdiction(env);
  return where ? binding.jurisdiction(where) : binding;
}

// The account object with a routing name. Callers check the name's shape first.
export function accountObject(env, name) {
  const ns = namespace(env, env.ACCOUNTS);
  return ns.get(ns.idFromName(name));
}

// The booking page object for a handle; one per handle. A handle that was never claimed leaves its object empty.
export function bookingObject(env, handle) {
  const ns = namespace(env, env.BOOKINGS);
  return ns.get(ns.idFromName(`booking\n${handle}`));
}

export function registryObject(env) {
  if (!env.REGISTRY) return null;
  const ns = namespace(env, env.REGISTRY);
  return ns.get(ns.idFromName('registry'));
}

// Missing means invite, the default in wrangler.jsonc. Anything unrecognized means closed, so a typo never opens a
// server that was meant to be private.
export function signups(env) {
  if (env.SIGNUPS === undefined) return 'invite';
  const mode = String(env.SIGNUPS).trim().toLowerCase();
  return SIGNUP_MODES.includes(mode) ? mode : 'closed';
}

function text(value) {
  const s = typeof value === 'string' ? value.trim() : '';
  return s || null;
}

// Without a PRIVACY_URL of its own, the server points to the statement it serves itself (privacy.js).
export function config(env, url) {
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

export function positive(value, fallback) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

// Where booking pages live: BOOKING_ORIGIN when the operator set one (a short domain that routes to this Worker),
// else the origin the request came in on.
export function bookingOrigin(env, url) {
  const value = text(env.BOOKING_ORIGIN);
  if (value) {
    try {
      const origin = new URL(value);
      if (origin.protocol === 'https:' || origin.protocol === 'http:') return origin.origin;
    } catch {
      // A broken setting falls back to the request's own origin rather than making links nobody can open.
    }
  }
  return url.origin;
}

// The origins a booking write may come from: the page's own, as served on either address.
export function bookingOrigins(env, url) {
  return new Set([url.origin, bookingOrigin(env, url)]);
}

// The operator's kill switch: handles listed here answer 404 and can't be claimed.
export function blockedHandles(env) {
  return String(env.BLOCKED_HANDLES || '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

// Hours after the last publish when every type needs the host's confirmation, and days after which no times show.
export function bookingTimes(env) {
  return {
    staleMs: positive(env.BOOKING_STALE_HOURS, 24) * 60 * 60 * 1000,
    darkMs: positive(env.BOOKING_DARK_DAYS, 7) * 24 * 60 * 60 * 1000
  };
}

// The client's address, and the network it counts as: IPv6 clients usually have a whole /64 to pick addresses from.
export function clientAddress(request) {
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  return ip.includes(':') ? ipv6Prefix(ip) : ip;
}

// IPv4 per /24, IPv6 per /64: the unit the per-network daily cap counts.
export function clientNetwork(request) {
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  if (ip.includes(':')) return ipv6Prefix(ip);
  const parts = ip.split('.');
  return parts.length === 4 ? `${parts.slice(0, 3).join('.')}.0/24` : ip;
}

export function ipv6Prefix(ip) {
  const [head, tail = ''] = ip.toLowerCase().split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = ip.includes('::') ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right] : left;
  return `${groups
    .slice(0, 4)
    .map((g) => g.replace(/^0+(?=.)/, ''))
    .join(':')}::/64`;
}

// Limits a client address when the limiter binding exists. Without the binding there is no limit.
export async function limitRate(request, limiter) {
  if (!limiter) return;
  const { success } = await limiter.limit({ key: clientAddress(request) });
  if (!success) throw new HttpError(429, 'rate_limited', 'Too many requests. Try again in a minute.', { 'retry-after': '60' });
}
