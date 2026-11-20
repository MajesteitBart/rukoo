'use strict';

// Workspaces, invitations, members, channels, DMs and blocks in the main process (src/main/workspaces/manage.js),
// through the chat* IPC table as the window calls it, against the real account server (test/fixtures/real-server.js).
// Contract 8.4 lists the cases for chat-manage: making, previewing (bad_link, other_server, already), joining,
// leaving and deleting workspaces; invitations with the links of 3.2; channels with last_manager; DMs (201 and 200,
// leave, dm_unavailable, blocked, dailyDms); block and unblock; and a sign-up with an invitation link through
// AccountService that leaves a pending join. The 429 rule of 4.4 is here too.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { startRealServer, realServerAvailable, skipWithoutServer } = require('./fixtures/real-server');
const { PASSWORD, attach, newAccount, chatService, settled, watchCalls, until } = require('./fixtures/chat-app');
const { chatApi } = require('../src/main/workspaces/ipc');
const wire = require('../src/main/workspaces/wire');
const { AccountError } = require('../src/main/account/client');

let server;
test.before(async () => {
  if (realServerAvailable() || process.env.CI || process.env.RUKOO_REQUIRE_REAL_SERVER === '1') server = await startRealServer();
});
test.after(() => server?.close());

// A device of person, signed in, with team chat ready, and the chat* methods as the window calls them.
async function device(t, person, options = {}) {
  const { account, dir } = attach(server, person);
  const svc = chatService(account, dir, options);
  t.after(() => {
    svc.close();
    account.close();
  });
  await until(() => svc.live() && Number.isFinite(svc.listedAt), 15000, 'team chat to start');
  return { svc, account, dir, api: chatApi(() => svc) };
}

// An assert.rejects check: the ChatError's code, and any details given.
function fails(code, details = {}) {
  return (err) => {
    assert.equal(err.code, code, `${err.code}: ${err.message}`);
    assert.equal(err.chat, true);
    for (const [key, value] of Object.entries(details)) assert.deepEqual(err[key], value, key);
    return true;
  };
}

const route = (ws, rest = '') => `/v1/workspaces/${ws}${rest}`;
const removedEvents = (svc, ws) => svc.events.filter((e) => e.kind === 'removed' && e.ws === ws);

test('makes a workspace, selects it with its first pass, and deletes it as its only member', async (t) => {
  if (skipWithoutServer(t)) return;
  const bart = await server.seedAccount();
  const olga = await server.seedAccount();
  const { svc, api } = await device(t, bart);
  assert.deepEqual((await api.chatState()).workspaces, []);

  const { ws } = await api.chatCreateWorkspace({ name: '  Studio  ', displayName: 'Bart' });
  assert.match(ws, wire.patterns.WORKSPACE_ID);
  const state = await api.chatState();
  assert.equal(state.selected, ws);
  const summary = state.workspaces.find((w) => w.id === ws);
  assert.equal(summary.name, 'Studio');
  assert.equal(summary.role, 'owner');
  assert.equal(summary.status, 'ok', 'the first pass installed before the call returned');
  assert.deepEqual(svc.me(ws), { id: svc.store.getWs(ws).me, name: 'Bart', role: 'owner' });
  const view = await api.chatView(ws);
  assert.deepEqual(
    view.rooms.map((r) => [r.kind, r.name, r.role]),
    [['channel', 'general', 'manager']]
  );
  const listed = await server.call('GET', '/v1/workspaces', { token: bart.token });
  assert.ok(listed.body.workspaces.some((w) => w.id === ws));
  assert.equal(svc.store.getMeta('selected'), ws);

  // Someone else in it: Delete is refused until they are gone.
  const { secret } = await server.createInvite(bart, ws);
  const joined = await server.call('POST', route(ws, '/join'), { token: olga.token, body: { invite: secret, name: 'Olga' } });
  assert.equal(joined.status, 201);
  await assert.rejects(api.chatDeleteWorkspace(ws), fails('members_remain'));
  assert.ok(svc.store.getWs(ws));
  assert.equal(await api.chatRemoveMember(ws, joined.body.me.id), true);
  // Removing someone twice is no error.
  assert.equal(await api.chatRemoveMember(ws, joined.body.me.id), true);

  assert.equal(await api.chatDeleteWorkspace(ws), true);
  assert.equal(svc.store.getWs(ws), null);
  assert.deepEqual(
    removedEvents(svc, ws).map((e) => e.reason),
    ['deleted']
  );
  const after = await api.chatState();
  assert.deepEqual(after.workspaces, []);
  assert.equal(after.selected, null);
  assert.equal((await server.call('GET', route(ws), { token: bart.token })).status, 404);
  assert.ok(!(await server.call('GET', '/v1/workspaces', { token: bart.token })).body.workspaces.some((w) => w.id === ws));
  // Deleting it again finds nothing to delete.
  await assert.rejects(api.chatDeleteWorkspace(ws), fails('not_found', { scope: 'workspace' }));
});

test('previews and joins with an invitation link: bad_link, other_server and already', async (t) => {
  if (skipWithoutServer(t)) return;
  const olga = await server.seedAccount();
  const bart = await server.seedAccount();
  const mila = await server.seedAccount();
  const ws = await server.seedWorkspace(olga, { name: 'Acme', displayName: 'Olga' });
  const { svc, api } = await device(t, bart);
  const { link, secret } = await server.createInvite(olga, ws.id);
  const calls = watchCalls(svc.account);

  // Links are checked before any request.
  await assert.rejects(api.chatPreviewInvite('no link in here'), fails('bad_link'));
  await assert.rejects(api.chatPreviewInvite(`${server.url}/join#w=${ws.id}&i=short`), fails('bad_link'));
  await assert.rejects(api.chatPreviewInvite(`https://elsewhere.example/join#w=${ws.id}&i=${secret}`), fails('other_server'));
  await assert.rejects(api.chatJoin({ link: 'https://elsewhere.example/join', name: 'Bart' }), fails('bad_link'));
  await assert.rejects(api.chatPreviewInvite(''), fails('invalid', { field: 'link' }));
  assert.deepEqual(calls, []);

  const preview = await api.chatPreviewInvite(`Join us: ${link} `);
  assert.deepEqual(preview.workspace, { id: ws.id, name: 'Acme' });
  assert.equal(preview.role, 'member');
  assert.equal(preview.channels, 1, 'the default channel');
  assert.deepEqual(preview.issuer, { name: 'Olga' });
  assert.ok(preview.expiresAt > Date.now());
  assert.equal(preview.already, false);

  const joined = await api.chatJoin({ link, name: '  Bart  ' });
  assert.deepEqual(joined, { ws: ws.id, already: false });
  const state = await api.chatState();
  assert.equal(state.selected, ws.id);
  assert.equal(state.workspaces.find((w) => w.id === ws.id).status, 'ok');
  assert.deepEqual(svc.me(ws.id).name, 'Bart');
  assert.deepEqual(
    (await api.chatView(ws.id)).rooms.map((r) => r.id),
    [ws.general],
    'the default channel, with the first pass done'
  );

  // The used link: the server refuses the invitation, and the card still says Bart is in.
  const used = await api.chatPreviewInvite(link);
  assert.equal(used.already, true);
  assert.deepEqual(used.workspace, { id: ws.id, name: 'Acme' });
  // A link with a secret nobody has gets the 404 of a missing workspace; the workspace Bart is in stays.
  const wrong = `${server.url}/join#w=${ws.id}&i=${crypto.randomBytes(32).toString('base64url')}`;
  assert.equal((await api.chatPreviewInvite(wrong)).already, true);
  assert.ok(svc.store.getWs(ws.id));
  // A fresh link: the server's card, with already.
  const fresh = await server.createInvite(olga, ws.id);
  const card = await api.chatPreviewInvite(fresh.link);
  assert.equal(card.already, true);
  assert.deepEqual(card.issuer, { name: 'Olga' });
  assert.deepEqual(await api.chatJoin({ link: fresh.link, name: 'Bart' }), { ws: ws.id, already: true });

  // Someone else with the used link learns it is spent.
  const other = await device(t, mila);
  await assert.rejects(other.api.chatPreviewInvite(link), fails('invite_gone'));
  await assert.rejects(other.api.chatPreviewInvite(wrong), fails('not_found', { scope: 'workspace' }));
  await assert.rejects(other.api.chatJoin({ link, name: 'Mila' }), fails('invite_gone'));
  assert.deepEqual((await other.api.chatState()).workspaces, []);
});

test('leaves a workspace once its channels have another manager; only an owner deletes', async (t) => {
  if (skipWithoutServer(t)) return;
  const olga = await server.seedAccount();
  const bart = await server.seedAccount();
  const ws = await server.seedWorkspace(olga, { name: 'Acme', displayName: 'Olga' });
  const bartMe = await server.seedMember(ws, bart, 'Bart');
  const { svc, api } = await device(t, bart);
  await settled(svc, ws.id);

  await assert.rejects(api.chatDeleteWorkspace(ws.id), fails('forbidden'));
  const { channel } = await api.chatCreateChannel(ws.id, { name: 'project', visibility: 'workspace' });
  assert.deepEqual(await api.chatAddToChannel(ws.id, channel.id, ws.me.id), { member: ws.me.id, role: 'member' });
  await assert.rejects(api.chatLeaveWorkspace(ws.id), fails('last_manager', { channels: [channel.id] }));
  assert.ok(svc.store.getWs(ws.id));

  assert.deepEqual(await api.chatSetChannelRole(ws.id, channel.id, ws.me.id, 'manager'), { member: ws.me.id, role: 'manager' });
  assert.equal(await api.chatLeaveWorkspace(ws.id), true);
  assert.equal(svc.store.getWs(ws.id), null);
  assert.deepEqual(
    removedEvents(svc, ws.id).map((e) => e.reason),
    ['left']
  );
  const state = await api.chatState();
  assert.deepEqual(state.workspaces, []);
  assert.equal(state.selected, null);
  const members = await server.call('GET', route(ws.id, '/members'), { token: olga.token });
  assert.equal(members.body.members.find((m) => m.id === bartMe.id).state, 'left');
});

test('makes invitations with the links of contract 3.2, lists and withdraws them', async (t) => {
  if (skipWithoutServer(t)) return;
  const bart = await server.seedAccount();
  const olga = await server.seedAccount();
  const { svc, api } = await device(t, bart);
  const { ws } = await api.chatCreateWorkspace({ name: 'Studio', displayName: 'Bart' });
  const general = (await api.chatView(ws)).rooms[0].id;
  const DAY = 24 * 60 * 60 * 1000;

  const member = await api.chatCreateInvite(ws, { role: 'member' });
  const parsed = wire.parseInviteLink(member.link, server.url);
  assert.equal(member.link, `${server.url}/join#w=${ws}&i=${parsed.secret}`);
  assert.equal(parsed.server, server.url);
  assert.equal(parsed.workspace, ws);
  assert.equal(member.invite.role, 'member');
  assert.equal(member.invite.expiresAt - member.invite.createdAt, DAY, 'one day unless chosen');
  assert.equal(member.invite.channelCount, 1, 'the default channel');

  await assert.rejects(api.chatCreateInvite(ws, { role: 'guest' }), fails('invalid', { field: 'channels' }));
  await assert.rejects(api.chatCreateInvite(ws, { role: 'member', expiresIn: 3600 }), fails('invalid', { field: 'expiresIn' }));
  await assert.rejects(api.chatCreateInvite(ws, { role: 'admin' }), fails('invalid', { field: 'role' }));
  const guest = await api.chatCreateInvite(ws, { role: 'guest', channels: [general], expiresIn: 604800 });
  assert.equal(guest.invite.expiresAt - guest.invite.createdAt, 7 * DAY);
  assert.deepEqual(guest.invite.channels, [general]);
  const three = await api.chatCreateInvite(ws, { role: 'member', expiresIn: 259200 });
  assert.equal(three.invite.expiresAt - three.invite.createdAt, 3 * DAY);

  const listed = (await api.chatInvites(ws)).invites.map((i) => i.id).sort();
  assert.deepEqual(listed, [member.invite.id, guest.invite.id, three.invite.id].sort());
  assert.equal(await api.chatWithdrawInvite(ws, guest.invite.id), true);
  assert.equal(await api.chatWithdrawInvite(ws, guest.invite.id), true, 'withdrawing twice is no error');
  assert.ok(!(await api.chatInvites(ws)).invites.some((i) => i.id === guest.invite.id));

  // The links work for someone else, and the withdrawn one doesn't.
  const card = await server.call('POST', route(ws, '/invites/preview'), { token: olga.token, body: { invite: parsed.secret } });
  assert.equal(card.status, 200);
  assert.equal(card.body.workspace.name, 'Studio');
  const withdrawn = wire.parseInviteLink(guest.link, server.url);
  const gone = await server.call('POST', route(ws, '/invites/preview'), { token: olga.token, body: { invite: withdrawn.secret } });
  assert.equal(gone.status, 410);
  assert.equal(svc.store.getWs(ws).name, 'Studio');
});

test('channels: make, rename, archive, join, add, roles, remove, and leave with last_manager', async (t) => {
  if (skipWithoutServer(t)) return;
  const olga = await server.seedAccount();
  const bart = await server.seedAccount();
  const ws = await server.seedWorkspace(olga, { name: 'Acme', displayName: 'Olga' });
  const bartMe = await server.seedMember(ws, bart, 'Bart');
  const { svc, api } = await device(t, bart);
  await settled(svc, ws.id);

  const { channel } = await api.chatCreateChannel(ws.id, { name: 'design', visibility: 'private' });
  assert.equal(channel.name, 'design');
  assert.equal(channel.visibility, 'private');
  assert.equal(channel.role, 'manager');
  assert.equal(channel.joined, true);
  const room = svc.store.getRoom(ws.id, channel.id);
  assert.equal(room.name, 'design', 'the room is in the cache when the call returns');
  assert.equal(room.role, 'manager');
  assert.ok((await api.chatView(ws.id)).channels.some((c) => c.id === channel.id));
  await assert.rejects(api.chatCreateChannel(ws.id, { name: 'General', visibility: 'workspace' }), fails('name_taken'));
  await assert.rejects(api.chatCreateChannel(ws.id, { name: 'two\nlines', visibility: 'workspace' }), fails('invalid', { field: 'name' }));

  const renamed = await api.chatRenameChannel(ws.id, channel.id, 'design team');
  assert.equal(renamed.channel.name, 'design team');
  assert.equal(svc.store.getRoom(ws.id, channel.id).name, 'design team');
  assert.equal((await api.chatView(ws.id)).channels.find((c) => c.id === channel.id).name, 'design team');

  // Olga's channel, which the workspace can see.
  const ops = await server.seedChannel(olga, ws.id, { name: 'ops' });
  const joined = await api.chatJoinChannel(ws.id, ops.id);
  assert.equal(joined.channel.joined, true);
  assert.equal(joined.channel.role, 'member');
  assert.equal(svc.store.getRoom(ws.id, ops.id).role, 'member');

  // Adding Olga, then leaving: the only manager names a successor first.
  assert.deepEqual(await api.chatAddToChannel(ws.id, channel.id, ws.me.id), { member: ws.me.id, role: 'member' });
  await assert.rejects(api.chatLeaveChannel(ws.id, channel.id, null), fails('last_manager'));
  assert.ok(svc.store.getRoom(ws.id, channel.id));
  assert.equal(await api.chatLeaveChannel(ws.id, channel.id, ws.me.id), true);
  assert.equal(svc.store.getRoom(ws.id, channel.id), null, 'the run took the room out');
  assert.ok(svc.events.some((e) => e.kind === 'evicted' && e.conversation === channel.id));
  const designMembers = await server.call('GET', route(ws.id, `/channels/${channel.id}/members`), { token: olga.token });
  assert.deepEqual(designMembers.body.members, [{ member: ws.me.id, role: 'manager' }]);
  // Leaving again is no error.
  assert.equal(await api.chatLeaveChannel(ws.id, channel.id, null), true);

  // Roles, taking someone out, and archiving.
  const temp = (await api.chatCreateChannel(ws.id, { name: 'temp', visibility: 'workspace' })).channel;
  await api.chatAddToChannel(ws.id, temp.id, ws.me.id);
  assert.deepEqual(await api.chatSetChannelRole(ws.id, temp.id, ws.me.id, 'manager'), { member: ws.me.id, role: 'manager' });
  assert.deepEqual(await api.chatSetChannelRole(ws.id, temp.id, ws.me.id, 'member'), { member: ws.me.id, role: 'member' });
  assert.equal(await api.chatRemoveFromChannel(ws.id, temp.id, ws.me.id), true);
  const tempMembers = await server.call('GET', route(ws.id, `/channels/${temp.id}/members`), { token: bart.token });
  assert.deepEqual(tempMembers.body.members, [{ member: bartMe.id, role: 'manager' }]);
  const archived = await api.chatArchiveChannel(ws.id, temp.id);
  assert.equal(archived.channel.archived, true);
  assert.equal(svc.store.getRoom(ws.id, temp.id).archived, 1);
  // Someone who isn't a manager can't rename.
  await assert.rejects(api.chatRenameChannel(ws.id, ops.id, 'mine'), fails('forbidden'));
});

test('DMs: start (201 and 200), groups, leave, dm_unavailable and blocked; block and unblock refresh blocks', async (t) => {
  if (skipWithoutServer(t)) return;
  const olga = await server.seedAccount();
  const bart = await server.seedAccount();
  const mila = await server.seedAccount();
  const gus = await server.seedAccount();
  const ws = await server.seedWorkspace(olga, { name: 'Acme', displayName: 'Olga' });
  const bartMe = await server.seedMember(ws, bart, 'Bart');
  const milaMe = await server.seedMember(ws, mila, 'Mila');
  const gusMe = await server.seedMember(ws, gus, 'Gus', { role: 'guest', channels: [ws.general] });
  const { svc, api } = await device(t, bart);
  await settled(svc, ws.id);

  const one = await api.chatStartDm(ws.id, [ws.me.id]);
  assert.equal(one.room.kind, 'dm');
  assert.equal(one.room.name, null);
  assert.equal(one.room.visibility, 'dm');
  assert.deepEqual([...one.room.participants].sort(), [ws.me.id, bartMe.id].sort());
  assert.equal(one.room.startedBy, bartMe.id);
  assert.equal(one.room.closedReason, null);
  assert.equal(one.room.members, 2);
  assert.ok(svc.store.getRoom(ws.id, one.room.id), 'in the cache when the call returns');
  await until(() => svc.events.some((e) => e.kind === 'rooms' && e.rooms.some((r) => r.id === one.room.id)), 2000, 'the rooms event');
  // The open DM of the set, whoever starts it.
  assert.equal((await api.chatStartDm(ws.id, [ws.me.id])).room.id, one.room.id);
  assert.equal((await server.seedDm(olga, ws.id, [bartMe.id])).conversation, one.room.id);

  const group = await api.chatStartDm(ws.id, [milaMe.id, ws.me.id]);
  assert.notEqual(group.room.id, one.room.id);
  assert.equal(group.room.participants.length, 3);

  await assert.rejects(api.chatStartDm(ws.id, [gusMe.id]), fails('dm_unavailable', { field: 'members' }));
  await assert.rejects(api.chatStartDm(ws.id, ['u_AAAAAAAAAAAAAAAAAAAAAA']), fails('dm_unavailable'));
  await assert.rejects(api.chatStartDm(ws.id, [bartMe.id]), fails('invalid', { field: 'members' }));
  await assert.rejects(api.chatStartDm(ws.id, []), fails('invalid', { field: 'members' }));

  // Leaving the group, where nobody wrote, deletes it.
  assert.equal(await api.chatLeaveDm(ws.id, group.room.id), true);
  assert.equal(svc.store.getRoom(ws.id, group.room.id), null);
  assert.equal(await api.chatLeaveDm(ws.id, group.room.id), true, 'leaving again is no error');

  // A block closes the 1:1 DM, which has a message, and refuses a new one.
  await server.post(olga, ws.id, one.room.id, 'Hoi Bart');
  const blocked = await api.chatBlock(ws.id, ws.me.id);
  assert.deepEqual(
    blocked.blocks.map((b) => b.member),
    [ws.me.id]
  );
  assert.deepEqual(
    (await api.chatView(ws.id)).blocks.map((b) => b.member),
    [ws.me.id]
  );
  const closed = svc.store.getRoom(ws.id, one.room.id);
  assert.equal(closed.closedReason, 'closed');
  assert.equal(closed.archived, 1);
  await assert.rejects(api.chatStartDm(ws.id, [ws.me.id]), fails('blocked', { member: ws.me.id }));
  // Blocking twice keeps one block.
  assert.equal((await api.chatBlock(ws.id, ws.me.id)).blocks.length, 1);

  const unblocked = await api.chatUnblock(ws.id, ws.me.id);
  assert.deepEqual(unblocked.blocks, []);
  assert.deepEqual((await api.chatView(ws.id)).blocks, []);
  assert.equal(svc.store.getRoom(ws.id, one.room.id).closedReason, 'closed', 'unblocking reopens nothing');
  const again = await api.chatStartDm(ws.id, [ws.me.id]);
  assert.notEqual(again.room.id, one.room.id);
  assert.equal(again.room.closedReason, null);

  // Olga blocks Bart: Bart's start is refused like a start with someone unknown.
  await server.block(olga, ws.id, bartMe.id);
  await assert.rejects(api.chatStartDm(ws.id, [ws.me.id]), fails('dm_unavailable'));
  // A closed DM leaves the list when Bart leaves it.
  assert.equal(await api.chatLeaveDm(ws.id, one.room.id), true);
  assert.equal(svc.store.getRoom(ws.id, one.room.id), null);
});

test('the twenty-first new DM of a day fails with dailyDms, and an open DM still opens', async (t) => {
  if (skipWithoutServer(t)) return;
  const olga = await server.seedAccount();
  const bart = await server.seedAccount();
  const mila = await server.seedAccount();
  const ws = await server.seedWorkspace(olga, { name: 'Acme', displayName: 'Olga' });
  await server.seedMember(ws, bart, 'Bart');
  const milaMe = await server.seedMember(ws, mila, 'Mila');
  // Twenty starts with Olga, each left again so the set is free: a DM nobody wrote in goes when someone leaves it.
  // The dm lane lets ten starts through at once; a restart of the server fills it again, and the day's count stays
  // in its storage.
  let last = null;
  for (let round = 0; round < 2; round++) {
    for (let i = 0; i < 10; i++) {
      const started = await server.call('POST', route(ws.id, '/dms'), { token: bart.token, body: { members: [ws.me.id] } });
      assert.equal(started.status, 201, started.text);
      last = started.body.dm.conversation;
      if (round === 1 && i === 9) break;
      assert.equal((await server.call('POST', route(ws.id, `/dms/${last}/leave`), { token: bart.token })).status, 204);
    }
    await server.stop();
    await server.start();
  }
  const { svc, api } = await device(t, bart);
  await settled(svc, ws.id);
  const calls = watchCalls(svc.account);

  // Reopening the open DM costs nothing.
  assert.equal((await api.chatStartDm(ws.id, [ws.me.id])).room.id, last);
  await assert.rejects(api.chatStartDm(ws.id, [milaMe.id]), (err) => {
    fails('rate_limited', { limit: 'dailyDms' })(err);
    assert.ok(err.retryAfter >= 1 && err.retryAfter <= 3600, String(err.retryAfter));
    return true;
  });
  // Retry-After is far beyond 30 seconds, so the start isn't tried again.
  assert.equal(calls.filter((c) => c.method === 'POST' && c.route.endsWith('/dms')).length, 2);
});

test('a write that gets 429 waits Retry-After and tries again, three times within 30 s at most', async (t) => {
  if (skipWithoutServer(t)) return;
  const olga = await server.seedAccount();
  const bart = await server.seedAccount();
  const ws = await server.seedWorkspace(olga, { name: 'Acme', displayName: 'Olga' });
  await server.seedMember(ws, bart, 'Bart');
  const { svc, api } = await device(t, bart);
  await settled(svc, ws.id);

  // A real 429: the dm lane takes ten starts at once, then asks for about ten seconds. With a window shorter than
  // that, the start fails at once with the server's details.
  for (let i = 0; i < 10; i++) {
    const started = await server.call('POST', route(ws.id, '/dms'), { token: bart.token, body: { members: [ws.me.id] } });
    assert.equal(started.status, 201, started.text);
    await server.call('POST', route(ws.id, `/dms/${started.body.dm.conversation}/leave`), { token: bart.token });
  }
  svc.timing.writeRetryWindow = 2000;
  const lane = watchCalls(svc.account);
  await assert.rejects(api.chatStartDm(ws.id, [ws.me.id]), (err) => {
    fails('rate_limited', { scope: 'workspace' })(err);
    assert.ok(err.retryAfter > 2, String(err.retryAfter));
    return true;
  });
  assert.equal(lane.filter((c) => c.route.endsWith('/dms')).length, 1);
  svc.timing.writeRetryWindow = 30000;

  // A 429 with Retry-After 1 is waited out, and the write goes through.
  let refuse = 1;
  const tries = watchCalls(svc.account, async (method, path) => {
    if (method === 'POST' && (path.endsWith('/channels') || path.endsWith('/invites')) && refuse > 0) {
      refuse -= 1;
      throw new AccountError('rate_limited', 429, 'Too many requests.', { retryAfter: 1, scope: 'workspace' });
    }
    return undefined;
  });
  const started = Date.now();
  const { channel } = await api.chatCreateChannel(ws.id, { name: 'later', visibility: 'workspace' });
  assert.ok(Date.now() - started >= 900, 'it waited Retry-After');
  assert.equal(channel.name, 'later');
  assert.equal(tries.filter((c) => c.method === 'POST' && c.route.endsWith('/channels')).length, 2);

  // Three refusals in a row: rate_limited, without a fourth try.
  refuse = 10;
  await assert.rejects(api.chatCreateInvite(ws.id, { role: 'member' }), fails('rate_limited', { retryAfter: 1 }));
  assert.equal(tries.filter((c) => c.method === 'POST' && c.route.endsWith('/invites')).length, 3);
});

test('a role change by someone else reaches the workspace summary, me() and the view at the next run', async (t) => {
  if (skipWithoutServer(t)) return;
  const olga = await server.seedAccount();
  const bart = await server.seedAccount();
  const ws = await server.seedWorkspace(olga, { name: 'Acme', displayName: 'Olga' });
  const bartMe = await server.seedMember(ws, bart, 'Bart');
  const { svc, api } = await device(t, bart);
  await settled(svc, ws.id);
  const summaryRole = (state) => state.workspaces.find((w) => w.id === ws.id).role;
  assert.equal(summaryRole(await api.chatState()), 'member');

  const roleIs = async (role) => {
    const changed = await server.call('PATCH', route(ws.id, `/members/${bartMe.id}`), { token: olga.token, body: { role } });
    assert.equal(changed.status, 200);
    const sent = svc.events.length;
    await api.chatSync(ws.id);
    assert.equal(summaryRole(await api.chatState()), role, 'the sidebar row');
    assert.equal(svc.me(ws.id).role, role);
    assert.equal((await api.chatView(ws.id)).me.role, role, 'the admin menu');
    assert.equal((await api.chatView(ws.id)).ws.role, role);
    // The window hears of it without asking.
    await until(
      () => svc.events.slice(sent).some((e) => e.kind === 'state' && summaryRole(e.state) === role),
      5000,
      `a state event with ${role}`
    );
  };
  await roleIs('admin');
  await roleIs('member');
});

test('a sign-up with an invitation link sends workspaceInvite and leaves a pending join', async (t) => {
  if (skipWithoutServer(t)) return;
  const olga = await server.seedAccount();
  const ws = await server.seedWorkspace(olga, { name: 'Acme', displayName: 'Olga' });
  const { link, secret } = await server.createInvite(olga, ws.id);
  const { account, dir } = newAccount(server);
  const svc = chatService(account, dir);
  t.after(() => {
    svc.close();
    account.close();
  });
  const hiddenState = () => svc.state().pendingJoin;

  // What main.js accountSignUp does with the invite field: a code stays a code, a link for another server too.
  assert.deepEqual(svc.manage.splitInvite('test-invite'), { invite: 'test-invite', workspaceInvite: null, link: null });
  const elsewhere = `https://elsewhere.example/join#w=${ws.id}&i=${secret}`;
  assert.deepEqual(svc.manage.splitInvite(elsewhere), { invite: elsewhere, workspaceInvite: null, link: null });
  assert.deepEqual(svc.manage.splitInvite(undefined), { invite: '', workspaceInvite: null, link: null });
  const split = svc.manage.splitInvite(`  ${link}\n`);
  assert.deepEqual(split, { invite: '', workspaceInvite: { workspace: ws.id, invite: secret }, link });

  const sent = [];
  const call = account.call.bind(account);
  account.call = (method, path, body, opts) => {
    if (path === '/v1/signup') sent.push(body);
    return call(method, path, body, opts);
  };
  await account.signUp({
    email: `colleague-${crypto.randomBytes(4).toString('hex')}@example.com`,
    password: PASSWORD,
    invite: split.invite,
    workspaceInvite: split.workspaceInvite || undefined
  });
  svc.manage.rememberJoin(split.link);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].workspaceInvite, { workspace: ws.id, invite: secret });
  assert.equal(Object.hasOwn(sent[0], 'invite'), false, 'no invite code goes with it');

  await until(() => svc.live(), 15000, 'team chat after the sign-up');
  assert.equal(hiddenState(), true);
  await until(() => svc.events.some((e) => e.kind === 'state' && e.state.pendingJoin === true), 5000, 'the state event');
  const api = chatApi(() => svc);
  assert.deepEqual(await api.chatTakePendingJoin(), { link });
  assert.equal(await api.chatTakePendingJoin(), null);
  assert.equal(hiddenState(), false);

  // The Join dialog joins with it, as with any link.
  assert.deepEqual(await api.chatJoin({ link, name: 'Colleague' }), { ws: ws.id, already: false });
  assert.equal(svc.me(ws.id).name, 'Colleague');

  // A pending join belongs to its session.
  svc.manage.rememberJoin(link);
  assert.equal(hiddenState(), true);
  await account.signOut();
  assert.equal(hiddenState(), false);
});
