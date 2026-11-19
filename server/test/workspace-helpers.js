// Shared by the workspace tests: requests with team chat turned on, and the steps most tests start with. Team chat is
// off in wrangler.jsonc, as on a server that hasn't enabled it, so every request here sets WORKSPACE_MODE itself.

import { createExecutionContext, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import worker from '../src/index.js';
import { call, random, signup, withVars } from './helpers.js';

export const ON = { WORKSPACE_MODE: 'on' };
export const ORIGIN = 'https://accounts.example';

export function api(method, path, options = {}) {
  return call(method, path, { ...options, vars: { ...ON, ...options.vars } });
}

// A UUIDv7 for a time, as a device makes one before it first sends a message.
export function uuidv7(time = Date.now()) {
  const bytes = random(16);
  let t = BigInt(time);
  for (let i = 5; i >= 0; i--) {
    bytes[i] = Number(t & 0xffn);
    t >>= 8n;
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// An account that made a workspace: { person, id, me, general }.
export async function newWorkspace(name = 'Acme', displayName = 'Olga Owner') {
  const person = await signup();
  const made = await api('POST', '/v1/workspaces', { token: person.token, body: { name, displayName } });
  if (made.status !== 201) throw new Error(`Could not make a workspace: ${made.status} ${made.text}`);
  const id = made.body.workspace.id;
  const general = (await channels(person, id)).find((c) => c.name === 'general');
  return { person, id, me: made.body.me, general: general.id };
}

export async function invite(owner, id, body = { role: 'member' }) {
  const made = await api('POST', `/v1/workspaces/${id}/invites`, { token: owner.token, body });
  if (made.status !== 201) throw new Error(`Could not invite: ${made.status} ${made.text}`);
  return made.body;
}

// A new account that joined a workspace: { person, me }. options.channels: channels the invitation lets them into.
export async function newMember(ws, displayName = 'Mila Member', options = {}) {
  const { secret } = await invite(ws.person, ws.id, { role: options.role ?? 'member', channels: options.channels ?? [] });
  const person = await signup();
  const joined = await api('POST', `/v1/workspaces/${ws.id}/join`, { token: person.token, body: { invite: secret, name: displayName } });
  if (joined.status !== 201) throw new Error(`Could not join: ${joined.status} ${joined.text}`);
  return { person, me: joined.body.me };
}

export async function channels(person, id) {
  return (await api('GET', `/v1/workspaces/${id}/channels`, { token: person.token })).body.channels;
}

export function post(person, id, conversation, text, extra = {}) {
  return api('POST', `/v1/workspaces/${id}/conversations/${conversation}/messages`, {
    token: person.token,
    body: { operationId: uuidv7(), text, ...extra }
  });
}

export function events(person, id, conversation, query = '') {
  return api('GET', `/v1/workspaces/${id}/conversations/${conversation}/events${query}`, { token: person.token });
}

export function changes(person, id, query = '') {
  return api('GET', `/v1/workspaces/${id}/changes${query}`, { token: person.token });
}

// Follows the feed from a cursor (or from the start) until it has nothing more, as a device does.
export async function sync(person, id, after = null, limit = 32) {
  const rooms = new Map();
  const evictions = [];
  let cursor = after;
  let pages = 0;
  for (;;) {
    const page = await changes(person, id, `?limit=${limit}${cursor ? `&after=${cursor}` : ''}`);
    if (page.status !== 200) throw new Error(`Feed failed: ${page.status} ${page.text}`);
    for (const room of page.body.changes) rooms.set(room.conversation, room);
    evictions.push(...page.body.evictions);
    cursor = page.body.next;
    pages += 1;
    if (!page.body.more) return { rooms, evictions, cursor, pages, last: page.body };
  }
}

export function workspaceStub(id) {
  return env.WORKSPACES.get(env.WORKSPACES.idFromName(`workspace\n${id}`));
}

// Runs SQL inside a workspace's object and returns the rows.
export function workspaceSql(id, query, ...args) {
  return runInDurableObject(workspaceStub(id), (instance, state) => state.storage.sql.exec(query, ...args).toArray());
}

// Opens the wake socket as a device does: a ticket over HTTPS, then the upgrade with the ticket in a header.
// Returns { status, socket, frames, closed, response }: frames collects what arrives, closed the close event.
export async function openSocket(person, id, { via = 'header', ticket = null } = {}) {
  let given = ticket;
  if (!given) {
    const issued = await api('POST', `/v1/workspaces/${id}/socket-ticket`, { token: person.token });
    if (issued.status !== 200) throw new Error(`No ticket: ${issued.status} ${issued.text}`);
    given = issued.body.ticket;
  }
  const headers = { upgrade: 'websocket' };
  if (via === 'header') headers.authorization = `Ticket ${given}`;
  else headers['sec-websocket-protocol'] = `rukoo.workspace.v1, rukoo.ticket.${given}`;
  const response = await worker.fetch(
    new Request(`${ORIGIN}/v1/workspaces/${id}/socket`, { headers }),
    withVars(ON),
    createExecutionContext()
  );
  const socket = response.webSocket ?? null;
  const frames = [];
  const state = { status: response.status, socket, frames, closed: null, response, ticket: given };
  if (socket) {
    socket.accept();
    socket.addEventListener('message', (event) => {
      frames.push(event.data);
    });
    socket.addEventListener('close', (event) => {
      state.closed = { code: event.code, reason: event.reason };
    });
  }
  return state;
}

// Waits until check() is true, for what arrives on a socket a moment after the request that caused it.
export async function until(check, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return check();
}
