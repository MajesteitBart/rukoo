// Shared by the workspace tests: requests with team chat turned on, and the steps most tests start with. Team chat is
// off in wrangler.jsonc, as on a server that hasn't enabled it, so every request here sets WORKSPACE_MODE itself.

import { createExecutionContext, runInDurableObject, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { toBase64url } from '../src/bytes.js';
import worker from '../src/index.js';
import { call, random, randomIp, signup, withVars } from './helpers.js';

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

// A guest who joined with an invitation into channels: { person, me }.
export function guest(ws, displayName = 'Gita Guest', channels = []) {
  return newMember(ws, displayName, { role: 'guest', channels });
}

export async function channels(person, id) {
  return (await api('GET', `/v1/workspaces/${id}/channels`, { token: person.token })).body.channels;
}

// ---- Direct messages and blocks ----

// Starts a DM with members, a list of member ids of the other people. Answers as the route does.
export function startDm(person, id, members) {
  return api('POST', `/v1/workspaces/${id}/dms`, { token: person.token, body: { members } });
}

export function leaveDm(person, id, conversation) {
  return api('POST', `/v1/workspaces/${id}/dms/${conversation}/leave`, { token: person.token });
}

export function block(person, id, member) {
  return api('POST', `/v1/workspaces/${id}/blocks`, { token: person.token, body: { member } });
}

export function unblock(person, id, member) {
  return api('DELETE', `/v1/workspaces/${id}/blocks/${member}`, { token: person.token });
}

export function blocks(person, id) {
  return api('GET', `/v1/workspaces/${id}/blocks`, { token: person.token });
}

// Adds count active full members straight to the database, for limits that need many people: their ids, which a DM
// can name. None of them can sign in.
export async function fillers(id, count) {
  return runInDurableObject(workspaceStub(id), (instance, state) => {
    const ids = [];
    for (let i = 0; i < count; i++) {
      const member = `u_${toBase64url(random(16))}`;
      state.storage.sql.exec(
        "INSERT INTO member (id, incarnation, account, role, state, name, joinedAt) VALUES (?, ?, ?, 'member', 'active', 'Filler', 0)",
        member,
        `filler-${member}`,
        `filler-${member}`
      );
      ids.push(member);
    }
    return ids;
  });
}

// Lets a person start as many DMs at once as a test needs. The dm lane sheds starts in memory, before the daily cap a
// test means to reach, so it is opened here instead of waiting ten seconds a start.
export async function openDmLane(person, id) {
  const name = person.token.slice(0, person.token.indexOf('.'));
  await runInDurableObject(workspaceStub(id), (instance) => {
    const mine = instance.buckets.get(name) ?? {};
    mine.dm = { take: () => 0 };
    instance.buckets.set(name, mine);
  });
}

// What a device knows when it writes a message: the grant it holds in the conversation and the workspace's
// generation, both of which it got from the feed. Read straight from the workspace here, so a test's sends don't
// spend the member's read allowance. Someone without a grant gets one that doesn't exist.
const incarnations = new Map();
export async function access(person, id, conversation) {
  if (!incarnations.has(person.token)) {
    incarnations.set(person.token, (await call('GET', '/v1/account', { token: person.token })).body?.incarnation ?? null);
  }
  const incarnation = incarnations.get(person.token);
  const [grant] = await workspaceSql(
    id,
    `SELECT g.id FROM grants g JOIN member m ON m.n = g.member JOIN conversation c ON c.n = g.conversation
     WHERE m.incarnation = ? AND c.id = ?`,
    incarnation,
    conversation
  ).catch(() => []);
  const [ws] = await workspaceSql(id, 'SELECT generation FROM workspace').catch(() => []);
  return { grant: grant?.id ?? 'g_AAAAAAAAAAAAAAAAAAAAAA', generation: ws?.generation ?? 'AAAAAAAAAAAAAAAAAAAAAA' };
}

// Sends a message. body may leave out grant and generation, which then are the sender's current ones.
export async function send(person, id, conversation, body) {
  const known = body.grant !== undefined && body.generation !== undefined ? {} : await access(person, id, conversation);
  return api('POST', `/v1/workspaces/${id}/conversations/${conversation}/messages`, {
    token: person.token,
    body: { ...known, ...body }
  });
}

export function post(person, id, conversation, text, extra = {}) {
  return send(person, id, conversation, { operationId: uuidv7(), text, ...extra });
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

// ---- Rich messages ----

export function react(person, id, conversation, message, emoji, on = true) {
  return api('POST', `/v1/workspaces/${id}/conversations/${conversation}/messages/${message}/react`, { token: person.token, body: { emoji, on } });
}

export function markUnread(person, id, conversation, message) {
  return api('POST', `/v1/workspaces/${id}/conversations/${conversation}/unread`, { token: person.token, body: { message } });
}

export async function sha256hex(bytes) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Reserves an upload. fields may give anything the route takes; name, type, size and sha256 default to those of bytes.
export async function reserve(person, id, conversation, { bytes = new TextEncoder().encode('hello'), ...fields } = {}, vars = {}) {
  const body = { name: 'hello.txt', type: 'text/plain', size: bytes.length, sha256: await sha256hex(bytes), ...fields };
  return api('POST', `/v1/workspaces/${id}/conversations/${conversation}/uploads`, { token: person.token, body, vars });
}

// A request to a file link, as a device makes it: no Authorization header. It waits until the Worker is done with it.
// A request made here has no Content-Length unless it is given, as a device's would: bytes get theirs, and a stream's
// is length.
export async function fileRequest(url, { method = 'GET', body, length, headers = {}, vars = {} } = {}) {
  const ctx = createExecutionContext();
  const size = length ?? (ArrayBuffer.isView(body) ? body.byteLength : undefined);
  const sized = size === undefined ? {} : { 'content-length': String(size) };
  const request = new Request(url, { method, body, headers: { 'cf-connecting-ip': randomIp(), ...sized, ...headers } });
  const response = await worker.fetch(request, withVars({ ...ON, ...vars }), ctx);
  const bytes = new Uint8Array(await response.arrayBuffer());
  await waitOnExecutionContext(ctx);
  let json = null;
  try {
    json = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    json = null;
  }
  return { status: response.status, headers: response.headers, bytes, body: json };
}

// Reserves and uploads bytes: the reservation's answer, with the PUT's status.
export async function upload(person, id, conversation, { bytes = new TextEncoder().encode('hello'), ...fields } = {}) {
  const reserved = await reserve(person, id, conversation, { bytes, ...fields });
  if (reserved.status !== 201) throw new Error(`Could not reserve: ${reserved.status} ${reserved.text}`);
  const put = await fileRequest(reserved.body.put.url, { method: 'PUT', body: bytes });
  if (put.status !== 200) throw new Error(`Could not upload: ${put.status} ${JSON.stringify(put.body)}`);
  return { id: reserved.body.upload.id, expiresAt: reserved.body.upload.expiresAt, put: reserved.body.put };
}

export function askDownload(person, id, conversation, file, vars = {}) {
  return api('POST', `/v1/workspaces/${id}/conversations/${conversation}/files/${file}/download`, { token: person.token, vars });
}

// Sends a message as send() does and waits for what the Worker does after answering, such as making link cards.
export async function sendAndWait(person, id, conversation, body, vars = {}) {
  const known = await access(person, id, conversation);
  const ctx = createExecutionContext();
  const request = new Request(`${ORIGIN}/v1/workspaces/${id}/conversations/${conversation}/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${person.token}`, 'content-type': 'application/json', 'cf-connecting-ip': randomIp() },
    body: JSON.stringify({ ...known, operationId: uuidv7(), ...body })
  });
  const response = await worker.fetch(request, withVars({ ...ON, ...vars }), ctx);
  const text = await response.text();
  await waitOnExecutionContext(ctx);
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

// Every object in the files bucket under a workspace's prefix.
export async function bucketKeys(id) {
  const keys = [];
  let cursor;
  do {
    const page = await env.WORKSPACE_FILES.list({ prefix: `ws/${id}/`, cursor });
    keys.push(...page.objects.map((object) => object.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return keys;
}

// Waits until check() is true, for what arrives a moment after the request that caused it. check may be async.
export async function until(check, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return Boolean(await check());
}
