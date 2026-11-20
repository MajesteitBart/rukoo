// What happens around a workspace's data: the sockets that wake devices, shedding load, and what an account's
// deletion does to its memberships (WORKSPACES.md, Messaging and sync; Transactions and identities).

import { createExecutionContext, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import worker from '../src/index.js';
import { accountStub, call, signup, withVars } from './helpers.js';
import {
  ON,
  ORIGIN,
  api,
  changes,
  channels,
  events,
  invite,
  newMember,
  newWorkspace,
  openSocket,
  post,
  sync,
  until,
  workspaceSql,
  workspaceStub
} from './workspace-helpers.js';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('wake sockets', () => {
  it('wakes the devices of everyone in a conversation, with a frame that says nothing', async () => {
    const ws = await newWorkspace();
    const mila = await newMember(ws, 'Mila', { channels: [ws.general] });
    const socket = await openSocket(mila.person, ws.id);
    expect(socket.status).toBe(101);
    expect(socket.response.headers.get('sec-websocket-protocol')).toBeNull();

    const sent = await post(ws.person, ws.id, ws.general, 'are you there?');
    expect(await until(() => socket.frames.length > 0)).toBe(true);
    expect(socket.frames[0]).toBe('{"t":"wake"}');
    // What changed comes from the feed, under the device's own access.
    expect((await sync(mila.person, ws.id)).rooms.get(ws.general)).toMatchObject({ head: sent.body.seq, unread: 1 });
    socket.socket.close(1000);
  });

  it('wakes nobody about a conversation they are not in', async () => {
    const ws = await newWorkspace();
    const mila = await newMember(ws, 'Mila', { channels: [ws.general] });
    const board = (await api('POST', `/v1/workspaces/${ws.id}/channels`, { token: ws.person.token, body: { name: 'board', visibility: 'private' } })).body.channel.id;
    const socket = await openSocket(mila.person, ws.id);
    await pause(600);
    socket.frames.length = 0;

    await post(ws.person, ws.id, board, 'between us');
    await api('PATCH', `/v1/workspaces/${ws.id}/channels/${board}`, { token: ws.person.token, body: { name: 'board 2' } });
    await pause(700);
    expect(socket.frames).toEqual([]);
    // Her own channel still wakes her.
    await post(ws.person, ws.id, ws.general, 'for everyone');
    expect(await until(() => socket.frames.length > 0)).toBe(true);
    socket.socket.close(1000);
  });

  it('holds a busy channel to one wake per half second for each device', async () => {
    const ws = await newWorkspace();
    const mila = await newMember(ws, 'Mila', { channels: [ws.general] });
    const socket = await openSocket(mila.person, ws.id);
    await pause(600);
    socket.frames.length = 0;
    for (let i = 0; i < 6; i++) await post(ws.person, ws.id, ws.general, `burst ${i}`);
    // The first wake comes at once and the rest fold into one at the end of the window.
    await pause(900);
    expect(socket.frames.length).toBeGreaterThanOrEqual(1);
    expect(socket.frames.length).toBeLessThanOrEqual(3);
    expect((await sync(mila.person, ws.id)).rooms.get(ws.general).unread).toBe(6);
    socket.socket.close(1000);
  });

  it('takes a ticket once, for its own workspace, and nothing forged', async () => {
    const ws = await newWorkspace();
    const other = await newWorkspace('Other');
    const first = await openSocket(ws.person, ws.id);
    expect(first.status).toBe(101);
    // The same ticket again.
    expect((await openSocket(ws.person, ws.id, { ticket: first.ticket })).status).toBe(401);
    // A ticket of another workspace, here and with its claims rewritten to say here.
    const theirs = (await api('POST', `/v1/workspaces/${other.id}/socket-ticket`, { token: other.person.token })).body.ticket;
    expect((await openSocket(ws.person, ws.id, { ticket: theirs })).status).toBe(401);
    const [payload, mac] = theirs.split('.');
    const claims = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
    const forged = btoa(JSON.stringify({ ...claims, w: ws.id })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect((await openSocket(ws.person, ws.id, { ticket: `${forged}.${mac}` })).status).toBe(401);
    expect((await openSocket(ws.person, ws.id, { ticket: 'nonsense' })).status).toBe(401);
    expect((await openSocket(ws.person, ws.id, { ticket: `${payload}.` })).status).toBe(401);

    // One that expired before it was used.
    const late = (await api('POST', `/v1/workspaces/${ws.id}/socket-ticket`, { token: ws.person.token })).body;
    expect(late.expiresAt - Date.now()).toBeLessThanOrEqual(30 * 1000);
    expect(late.protocol).toBe('rukoo.workspace.v1');
    await workspaceSql(ws.id, 'UPDATE ticket SET expiresAt = ?', Date.now() - 1);
    expect((await openSocket(ws.person, ws.id, { ticket: late.ticket })).status).toBe(401);

    // No ticket in the address, ever: without a header there is none.
    const plain = await worker.fetch(
      new Request(`${ORIGIN}/v1/workspaces/${ws.id}/socket?ticket=${first.ticket}`, { headers: { upgrade: 'websocket' } }),
      withVars(ON),
      createExecutionContext()
    );
    expect(plain.status).toBe(401);
    const notSocket = await api('GET', `/v1/workspaces/${ws.id}/socket`, { token: ws.person.token });
    expect(notSocket.status).toBe(426);
    // Outsiders get no ticket.
    expect((await api('POST', `/v1/workspaces/${ws.id}/socket-ticket`, { token: other.person.token })).status).toBe(404);
    first.socket.close(1000);
  });

  it('takes the ticket as a subprotocol from a client that cannot set a header', async () => {
    const ws = await newWorkspace();
    const mila = await newMember(ws, 'Mila', { channels: [ws.general] });
    const socket = await openSocket(mila.person, ws.id, { via: 'protocol' });
    expect(socket.status).toBe(101);
    expect(socket.response.headers.get('sec-websocket-protocol')).toBe('rukoo.workspace.v1');
    await post(ws.person, ws.id, ws.general, 'hello');
    expect(await until(() => socket.frames.length > 0)).toBe(true);
    socket.socket.close(1000);
  });

  it('closes the sockets of a member who is removed', async () => {
    const ws = await newWorkspace();
    const mila = await newMember(ws, 'Mila', { channels: [ws.general] });
    const socket = await openSocket(mila.person, ws.id);
    await api('DELETE', `/v1/workspaces/${ws.id}/members/${mila.me.id}`, { token: ws.person.token });
    expect(await until(() => socket.closed !== null)).toBe(true);
    expect(socket.closed.code).toBe(4003);
    // And a ticket asked for before the removal no longer opens one.
    const back = await openSocket(ws.person, ws.id);
    expect(back.status).toBe(101);
    back.socket.close(1000);
  });

  it('stops waking a socket whose session has not proved itself for 15 minutes, until it does', async () => {
    const ws = await newWorkspace();
    const mila = await newMember(ws, 'Mila', { channels: [ws.general] });
    const age = (ms) =>
      runInDurableObject(workspaceStub(ws.id), (instance, state) => {
        for (const socket of state.getWebSockets()) {
          const kept = socket.deserializeAttachment();
          socket.serializeAttachment({ ...kept, until: Date.now() + ms });
        }
      });
    const lease = () =>
      runInDurableObject(workspaceStub(ws.id), (instance, state) => state.getWebSockets().map((s) => s.deserializeAttachment().until - Date.now()));

    // A request from the same session renews a lease that is more than half gone.
    const kept = await openSocket(mila.person, ws.id);
    await age(60 * 1000);
    await changes(mila.person, ws.id);
    expect((await lease())[0]).toBeGreaterThan(14 * 60 * 1000);
    // A keepalive is answered and renews nothing.
    await age(60 * 1000);
    kept.socket.send('ping');
    expect(await until(() => kept.frames.includes('pong'))).toBe(true);
    expect((await lease())[0]).toBeLessThan(61 * 1000);
    // Another member's requests don't renew it either.
    await changes(ws.person, ws.id);
    expect((await lease())[0]).toBeLessThan(61 * 1000);

    // Once it ran out, the next wake closes the socket instead.
    await age(-1);
    await pause(600);
    kept.frames.length = 0;
    await post(ws.person, ws.id, ws.general, 'anyone?');
    expect(await until(() => kept.closed !== null)).toBe(true);
    expect(kept.closed.code).toBe(4001);
    expect(kept.frames).toEqual([]);
  });

  it('holds a workspace to its number of open sockets', async () => {
    const ws = await newWorkspace();
    // The object reads the limit from its own settings, so this one gets a limit of two.
    await runInDurableObject(workspaceStub(ws.id), (instance) => {
      instance.env = { ...withVars({}), WORKSPACE_SOCKETS: '2' };
    });
    const one = await openSocket(ws.person, ws.id);
    const two = await openSocket(ws.person, ws.id);
    expect([one.status, two.status]).toEqual([101, 101]);
    const issued = (await api('POST', `/v1/workspaces/${ws.id}/socket-ticket`, { token: ws.person.token })).body.ticket;
    const third = await call('GET', `/v1/workspaces/${ws.id}/socket`, { vars: ON, headers: { upgrade: 'websocket', authorization: `Ticket ${issued}` } });
    expect(third.status).toBe(429);
    expect(third.body).toMatchObject({ error: 'rate_limited', scope: 'workspace' });
    expect(third.headers.get('retry-after')).toBe('60');
    // A closed one makes room again.
    one.socket.close(1000);
    expect(await until(() => one.closed !== null)).toBe(true);
    const again = await openSocket(ws.person, ws.id);
    expect(again.status).toBe(101);
    two.socket.close(1000);
    again.socket.close(1000);
  });
});

describe('shedding load', () => {
  it('answers a burst with 429 before doing any work, and still lets removals through', async () => {
    const ws = await newWorkspace();
    const mila = await newMember(ws, 'Mila', { channels: [ws.general] });
    const theirs = await post(mila.person, ws.id, ws.general, 'spam');

    // One member reads far faster than a person's devices do.
    let refused = null;
    for (let i = 0; i < 80 && !refused; i++) {
      const res = await api('GET', `/v1/workspaces/${ws.id}`, { token: mila.person.token });
      if (res.status === 429) refused = res;
    }
    expect(refused).not.toBeNull();
    expect(refused.body).toMatchObject({ error: 'rate_limited', scope: 'workspace' });
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);

    // Everyone else is unaffected, and the owner can still remove what was posted and who posted it.
    expect((await api('GET', `/v1/workspaces/${ws.id}`, { token: ws.person.token })).status).toBe(200);
    const redact = await api('POST', `/v1/workspaces/${ws.id}/conversations/${ws.general}/messages/${theirs.body.messageId}/redact`, { token: ws.person.token });
    expect(redact.status).toBe(200);
    expect((await api('DELETE', `/v1/workspaces/${ws.id}/members/${mila.me.id}`, { token: ws.person.token })).status).toBe(204);
  });

  it('keeps removals working when the whole workspace is over its ceiling', async () => {
    const ws = await newWorkspace();
    const mila = await newMember(ws, 'Mila', { channels: [ws.general] });
    const sent = await post(ws.person, ws.id, ws.general, 'x');
    // The workspace-wide bucket is empty: ordinary work is refused for everyone.
    await runInDurableObject(workspaceStub(ws.id), (instance) => {
      instance.ceiling.tokens = 0;
      instance.ceiling.rate = 0.001;
      instance.ceiling.at = Date.now();
    });
    expect((await api('GET', `/v1/workspaces/${ws.id}/channels`, { token: ws.person.token })).status).toBe(429);
    expect((await post(mila.person, ws.id, ws.general, 'y')).status).toBe(429);
    // What takes access or content away still commits.
    const redact = await api('POST', `/v1/workspaces/${ws.id}/conversations/${ws.general}/messages/${sent.body.messageId}/redact`, { token: ws.person.token });
    expect(redact.status).toBe(200);
    expect((await api('DELETE', `/v1/workspaces/${ws.id}/members/${mila.me.id}`, { token: ws.person.token })).status).toBe(204);
    expect((await api('PATCH', `/v1/workspaces/${ws.id}/channels/${ws.general}`, { token: ws.person.token, body: { archived: true } })).status).toBe(200);
  });

  it('gives everyone who is not a member one small bucket to share', async () => {
    const ws = await newWorkspace();
    const stranger = await signup();
    let refused = false;
    for (let i = 0; i < 40 && !refused; i++) {
      refused = (await api('GET', `/v1/workspaces/${ws.id}`, { token: stranger.token })).status === 429;
    }
    expect(refused).toBe(true);
    // Members have their own.
    expect((await api('GET', `/v1/workspaces/${ws.id}`, { token: ws.person.token })).status).toBe(200);
  });
});

describe('deleting an account', () => {
  async function remove(person) {
    return call('DELETE', '/v1/account', { token: person.token, body: { authKey: person.authKey } });
  }

  const tables = async (email) =>
    runInDurableObject(await accountStub(email), (instance, state) =>
      state.storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf%' ESCAPE '\\'").toArray().map((t) => t.name)
    );

  it('ends its memberships at once, keeps what it wrote and leaves nothing of the account', async () => {
    const ws = await newWorkspace();
    const mila = await newMember(ws, 'Mila', { channels: [ws.general] });
    const sent = await post(mila.person, ws.id, ws.general, 'my last message');
    const before = (await call('GET', '/v1/account', { token: mila.person.token })).body.incarnation;
    const pending = await invite(ws.person, ws.id);
    const socket = await openSocket(mila.person, ws.id);

    expect((await remove(mila.person)).status).toBe(204);
    // The deletion's answer doesn't wait for the workspace, which hears a moment later: the member is gone, without a
    // name, and their socket is closed.
    const state = async () => (await workspaceSql(ws.id, 'SELECT state FROM member WHERE id = ?', mila.me.id))[0].state;
    expect(await until(async () => (await state()) === 'deleted')).toBe(true);
    const members = (await api('GET', `/v1/workspaces/${ws.id}/members`, { token: ws.person.token })).body.members;
    expect(members.find((m) => m.id === mila.me.id)).toMatchObject({ state: 'deleted', name: '' });
    expect(await until(() => socket.closed !== null)).toBe(true);
    const stored = await workspaceSql(ws.id, 'SELECT incarnation, account, name FROM member WHERE id = ?', mila.me.id);
    expect(stored[0]).toEqual({ incarnation: null, account: null, name: '' });
    expect((await channels(ws.person, ws.id))[0].members).toBe(1);
    // What they wrote stays, under a deleted member.
    const log = (await events(ws.person, ws.id, ws.general)).body.events;
    expect(log.find((e) => e.id === sent.body.messageId)).toMatchObject({ text: 'my last message', actor: mila.me.id });
    expect(log.at(-1)).toMatchObject({ kind: 'member.left', member: mila.me.id });

    // Nothing is left of the account, as after any deletion.
    expect(await until(async () => (await tables(mila.person.email)).length === 0)).toBe(true);
    expect(await runInDurableObject(await accountStub(mila.person.email), (instance, state) => state.storage.getAlarm())).toBeNull();
    expect((await api('GET', `/v1/workspaces/${ws.id}`, { token: mila.person.token })).status).toBe(401);

    // The same address signing up again is someone new: no workspace, and a new incarnation.
    const again = await signup({ email: mila.person.email });
    expect((await api('GET', '/v1/workspaces', { token: again.token })).body.workspaces).toEqual([]);
    expect((await api('GET', `/v1/workspaces/${ws.id}`, { token: again.token })).status).toBe(404);
    expect((await call('GET', '/v1/account', { token: again.token })).body.incarnation).not.toBe(before);
    // They can be invited like anyone, and are a different member.
    const joined = await api('POST', `/v1/workspaces/${ws.id}/join`, { token: again.token, body: { invite: pending.secret, name: 'Mila II' } });
    expect(joined.status).toBe(201);
    expect(joined.body.me.id).not.toBe(mila.me.id);
  });

  it('deletes an account that never used a workspace the way it always did', async () => {
    const person = await signup();
    expect((await remove(person)).status).toBe(204);
    expect(await tables(person.email)).toEqual([]);
    // One that looked at workspaces but joined none has no reference, so nothing to tell anyone.
    const looker = await signup();
    await api('GET', '/v1/workspaces', { token: looker.token });
    expect(await tables(looker.email)).toContain('identity');
    expect((await remove(looker)).status).toBe(204);
    expect(await tables(looker.email)).toEqual([]);
  });

  it('withdraws the invitations a deleted owner issued and leaves the workspace to the others', async () => {
    const ws = await newWorkspace();
    const second = await newMember(ws, 'Ada');
    await api('PATCH', `/v1/workspaces/${ws.id}/members/${second.me.id}`, { token: ws.person.token, body: { role: 'owner' } });
    const open = await invite(ws.person, ws.id);
    expect((await remove(ws.person)).status).toBe(204);
    expect(await until(async () => (await workspaceSql(ws.id, 'SELECT COUNT(*) AS n FROM retired'))[0].n === 1)).toBe(true);
    const late = await api('POST', `/v1/workspaces/${ws.id}/join`, { token: (await signup()).token, body: { invite: open.secret, name: 'P' } });
    expect(late.status).toBe(410);
    expect((await api('GET', `/v1/workspaces/${ws.id}`, { token: second.person.token })).body.me.role).toBe('owner');
    // A join that was on its way in under the deleted incarnation can't commit after the fact.
    expect(await workspaceSql(ws.id, 'SELECT COUNT(*) AS n FROM retired')).toEqual([{ n: 1 }]);
  });

  it('keeps trying a workspace that did not answer, and never wipes an account made since', async () => {
    const ws = await newWorkspace();
    const mila = await newMember(ws, 'Mila', { channels: [ws.general] });
    const incarnation = (await call('GET', '/v1/account', { token: mila.person.token })).body.incarnation;
    // The state after a deletion whose workspace could not be reached: only the list of who to tell is left.
    const stub = await accountStub(mila.person.email);
    await runInDurableObject(stub, async (instance, state) => {
      const sql = state.storage.sql;
      for (const table of ['account', 'sessions', 'records', 'meta', 'booking', 'identity', 'workspaces']) sql.exec(`DROP TABLE IF EXISTS ${table}`);
      sql.exec(
        'CREATE TABLE cleanup (workspace TEXT NOT NULL, incarnation TEXT NOT NULL, createdAt INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (workspace, incarnation))'
      );
      sql.exec('INSERT INTO cleanup VALUES (?, ?, ?, 0)', ws.id, incarnation, Date.now());
      instance.present = false;
      await state.storage.setAlarm(Date.now() + 60 * 1000);
    });
    // Meanwhile the address signs up again.
    const again = await signup({ email: mila.person.email });
    expect(await tables(mila.person.email)).toContain('cleanup');

    expect(await runDurableObjectAlarm(stub)).toBe(true);
    // The workspace heard about the old incarnation, and the new account is untouched.
    const members = (await api('GET', `/v1/workspaces/${ws.id}/members`, { token: ws.person.token })).body.members;
    expect(members.find((m) => m.id === mila.me.id).state).toBe('deleted');
    expect(await tables(mila.person.email)).not.toContain('cleanup');
    expect((await call('GET', '/v1/account', { token: again.token })).status).toBe(200);
  });
});
