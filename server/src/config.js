// Settings read from the Worker's environment, shared by the account routes, the booking routes and the objects.
// Every Durable Object namespace goes through the configured jurisdiction: an object is found per jurisdiction, so
// one looked up without it would seem not to exist.

import { hmac, toBase64url } from './bytes.js';
import { fileStore } from './filestore.js';
import { HttpError } from './input.js';
import { mailer } from './mail.js';

export const JURISDICTIONS = ['eu', 'us', 'fedramp'];
const SIGNUP_MODES = ['open', 'verified', 'invite', 'closed'];
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

// The routing name of an address's account object. It never changes for an address: that is how the account is found.
export async function accountName(env, email) {
  return toBase64url(await hmac(env.PEPPER, `account\n${email}`));
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

// The registry object that keeps the sign-in lock of an address (lock.js), by the lock's hash of the address: one of
// 64, named by the hash's first character. Every attempt with every address goes through the lock, so a flood of them
// from many networks, at addresses with an account or without, spreads over these and leaves the server's own
// registry, which keeps the counts and the emailed codes, to everyone else. They are the same class, so they need no
// migration of their own.
export function lockObject(env, address) {
  if (!env.REGISTRY) return null;
  const ns = namespace(env, env.REGISTRY);
  return ns.get(ns.idFromName(`lock\n${address.slice(0, 1)}`));
}

// The object of one workspace (workspace.js). An id nobody made leaves its object empty.
export function workspaceObject(env, id) {
  const ns = namespace(env, env.WORKSPACES);
  return ns.get(ns.idFromName(`workspace
${id}`));
}

// Team chat is off until the operator turns it on, and needs its binding. Turning it on is the last step of a
// rollout: every route of the server must already run a build that knows workspaces (WORKSPACES.md, Conventions).
export function workspacesOn(env) {
  return Boolean(env.WORKSPACES) && String(env.WORKSPACE_MODE ?? '').trim().toLowerCase() === 'on';
}

// What a workspace may hold. textBytes is one message; contentBytes is all the message text a workspace keeps, which
// has to stay well under what one Durable Object stores (10 GB on Workers Paid, 1 GB on Workers Free).
export function workspaceLimits(env) {
  return {
    max: positive(env.MAX_WORKSPACES, 100),
    perAccount: positive(env.MAX_WORKSPACES_PER_ACCOUNT, 3),
    memberships: positive(env.MAX_WORKSPACE_MEMBERSHIPS, 50),
    members: positive(env.WORKSPACE_MEMBERS, 100),
    sockets: positive(env.WORKSPACE_SOCKETS, 200),
    conversations: positive(env.WORKSPACE_CONVERSATIONS, 8192),
    textBytes: 16384,
    contentBytes: positive(env.WORKSPACE_BYTES, 1073741824),
    retentionDays: positive(env.WORKSPACE_RETENTION_DAYS, 90),
    // Files: the largest one, and what a workspace's files may take in its bucket, stored and reserved together.
    // These bytes are counted apart from contentBytes, which stays message text only.
    fileBytes: positive(env.WORKSPACE_FILE_BYTES, 26214400),
    filesBytes: positive(env.WORKSPACE_FILES_BYTES, 5368709120)
  };
}

// Agents (WORKSPACES.md, Agents in channels): accounts a member makes in a workspace, with a key a runtime connects
// with. WORKSPACE_AGENTS is how many active agents a workspace may have, 20 unless set, and 0 or "off" turns them off.
// depth is the longest chain of agents answering agents, a person's message being 0 (WORKSPACE_AGENT_DEPTH), and
// replies how many replies one agent may post in an hour (WORKSPACE_AGENT_REPLIES).
export function agentLimits(env) {
  const raw = String(env.WORKSPACE_AGENTS ?? '')
    .trim()
    .toLowerCase();
  const off = raw === '0' || raw === 'off' || raw === 'false';
  return {
    agents: off ? 0 : positive(raw, 20),
    depth: positive(env.WORKSPACE_AGENT_DEPTH, 3),
    replies: positive(env.WORKSPACE_AGENT_REPLIES, 120)
  };
}

// Whether agents are on: with team chat, unless WORKSPACE_AGENTS turns them off.
export function agentsOn(env) {
  return workspacesOn(env) && agentLimits(env).agents > 0;
}

// WORKSPACE_ORIGIN as an origin, or null: the one address workspaces on this server are known by. Without it, each
// request's own address is.
export function workspaceOrigin(env) {
  return originOf(text(env.WORKSPACE_ORIGIN));
}

// Files in team chat need a store: the WORKSPACE_FILES bucket, or an S3-compatible one (filestore.js). A server
// deployed with neither has no files, and says so.
export function filesOn(env) {
  return fileStore(env) !== null;
}

// Which store holds the files, for the privacy statement (privacy.js): null without one, { store: 'r2' } for the
// WORKSPACE_FILES bucket, else { store: 's3', provider, place }. provider is WORKSPACE_FILES_S3_PROVIDER, the company or
// service that keeps the files, such as "UpCloud", and place is WORKSPACE_FILES_S3_PLACE, where it keeps them, such as
// "Frankfurt am Main". Either may be null. Neither decides whether files are on.
export function filesStorage(env) {
  const store = fileStore(env);
  if (!store) return null;
  if (store.kind === 'r2') return { store: 'r2' };
  return { store: 's3', provider: text(env.WORKSPACE_FILES_S3_PROVIDER), place: text(env.WORKSPACE_FILES_S3_PLACE) };
}

// The origin upload and download links point at: WORKSPACE_FILES_ORIGIN, routed to this Worker by the operator, else the
// workspace's own address.
export function filesOrigin(env, url) {
  return originOf(text(env.WORKSPACE_FILES_ORIGIN)) ?? workspaceOrigin(env) ?? url.origin;
}

// Rukoo in the browser runs on the website in front of this server (website/cloudflare/web-app.js, at /app/), as on
// rukoo.io. Only the operator knows: WEB_APP "on" says so, and the privacy statement then covers the browser too.
// It needs team chat, which is all the browser app does.
export function webAppOn(env) {
  return workspacesOn(env) && String(env.WEB_APP ?? '').trim().toLowerCase() === 'on';
}

// Link cards are made unless WORKSPACE_PREVIEWS is "off".
export function previewsOn(env) {
  return String(env.WORKSPACE_PREVIEWS ?? '').trim().toLowerCase() !== 'off';
}

// WORKSPACE_PREVIEW_HOSTS, for tests only: "host:port" pairs the link fetcher may reach although the address rules
// refuse them, such as a fixture server on 127.0.0.1. Empty in every real deployment.
export function previewHosts(env) {
  return new Set(
    String(env.WORKSPACE_PREVIEW_HOSTS || '')
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean)
  );
}

// The host names of this server's own addresses, which a link card never fetches, on any port.
export function ownHosts(env, url) {
  const hosts = new Set([url.hostname.toLowerCase()]);
  for (const value of [env.WORKSPACE_ORIGIN, env.WORKSPACE_FILES_ORIGIN, env.BOOKING_ORIGIN]) {
    const origin = originOf(text(value));
    if (origin) hosts.add(new URL(origin).hostname.toLowerCase());
  }
  return hosts;
}

// Missing means invite, the default in wrangler.jsonc. Anything unrecognized means closed, so a typo never opens a
// server that was meant to be private. verified takes anyone who proves their address with a code sent there
// (codes.js); a server that can't send codes takes invite codes instead, so losing the mail key never opens it.
export function signups(env) {
  if (env.SIGNUPS === undefined) return 'invite';
  const mode = String(env.SIGNUPS).trim().toLowerCase();
  if (mode === 'verified' && !emailCodesOn(env)) return 'invite';
  return SIGNUP_MODES.includes(mode) ? mode : 'closed';
}

// Codes by email need a way to send mail and the registry, which keeps them.
export function emailCodesOn(env) {
  return Boolean(env.REGISTRY) && mailer(env) !== null;
}

// Whether a workspace invitation may stand in for an invite code when someone signs up (WORKSPACE_SIGNUPS). Only
// "off" turns it off: it counts only with SIGNUPS on invite or verified and team chat on, and each invitation makes
// one account.
export function workspaceSignups(env) {
  return String(env.WORKSPACE_SIGNUPS ?? '').trim().toLowerCase() !== 'off';
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

// A count setting that takes 0 too, for none or off: a whole number, or the fallback when it is unset or isn't one.
export function limit(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : fallback;
}

// The fewest days EXPIRE_UNUSED_DAYS counts as. An account is checked no sooner than a day after its sign-up day, so a
// request that came in on that day, such as a booking page being published, is long finished by then.
export const EXPIRE_MIN_DAYS = 2;

// EXPIRE_UNUSED_DAYS: days after which an account that was never used is deleted (account.js, expireUnused), at
// least EXPIRE_MIN_DAYS. 0, also when unset, keeps every account.
export function expiryDays(env) {
  const days = limit(env.EXPIRE_UNUSED_DAYS, 0);
  return days > 0 ? Math.max(days, EXPIRE_MIN_DAYS) : 0;
}

// An http(s) address as an origin, or null when it is empty or isn't one.
function originOf(value) {
  if (!value) return null;
  try {
    const origin = new URL(value);
    if (origin.protocol === 'https:' || origin.protocol === 'http:') return origin.origin;
  } catch {
    // Not an address.
  }
  return null;
}

// BOOKING_ORIGIN as an origin, or null when it is empty or broken. With one, booking pages live at the root of that
// address (https://meet.rukoo.io/<handle>) and /meet redirects there from every address. Without one they live under
// /meet on every address. A broken setting counts as none rather than making links nobody can open.
export function bookingRoot(env) {
  return originOf(text(env.BOOKING_ORIGIN));
}

// BOOKING_ALIASES: the addresses booking pages used to live at, comma-separated origins. Their /meet/<handle> links
// still name the same pages where a link is read (the MCP link argument). Entries that aren't http(s) are left out.
export function bookingAliases(env) {
  return originList(env.BOOKING_ALIASES);
}

// BOOKING_FORMER_ROOTS: addresses whose root held the booking pages before BOOKING_ORIGIN did, comma-separated origins
// (https://rukoo.io, before https://meet.rukoo.io). Reads of the pages' addresses there redirect to the same path under
// BOOKING_ORIGIN, and other reads get a 404 page of their own (lost.js); the rest is still answered there (index.js),
// and their links still name the same pages. Without a BOOKING_ORIGIN there is nowhere to move to, so there are none.
export function bookingFormerRoots(env) {
  const root = bookingRoot(env);
  if (!root) return new Set();
  const roots = originList(env.BOOKING_FORMER_ROOTS);
  roots.delete(root);
  return roots;
}

function originList(value) {
  return new Set(
    String(value || '')
      .split(',')
      .map((entry) => originOf(entry.trim()))
      .filter(Boolean)
  );
}

// The origin booking pages are shared under: BOOKING_ORIGIN, else the one the request came in on.
export function bookingOrigin(env, url) {
  return bookingRoot(env) ?? url.origin;
}

// The absolute address every booking page's address starts with: https://meet.rukoo.io, or https://<this server>/meet.
export function bookingBase(env, url) {
  return bookingRoot(env) ?? `${url.origin}/meet`;
}

// The same as a path on this request's address, for links inside the pages: '' at the root of BOOKING_ORIGIN or of a
// former root, else '/meet'.
export function bookingPrefix(env, url) {
  return bookingRoot(env) === url.origin || bookingFormerRoots(env).has(url.origin) ? '' : '/meet';
}

// The pages' script: /booker.js at the root (/assets/ belongs to the website there), else /meet/assets/booker.js.
export function bookerPath(env, url) {
  const prefix = bookingPrefix(env, url);
  return prefix ? `${prefix}/assets/booker.js` : '/booker.js';
}

// The pages' fonts (fonts.js): /assets/fonts/ at the root, where the website has the same files, else
// /meet/assets/fonts/.
export function fontDir(env, url) {
  return `${bookingPrefix(env, url)}/assets/fonts/`;
}

// The pages' icons (icons.js), next to the script: the root itself, where browsers look for /favicon.ico, else
// /meet/assets/.
export function iconDir(env, url) {
  const prefix = bookingPrefix(env, url);
  return prefix ? `${prefix}/assets/` : '/';
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
