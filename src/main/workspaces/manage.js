'use strict';

// Workspaces, invitations, members, channels, direct messages and blocks (team chat contract 2.2, 2.3, 2.12, 2.14,
// 3.2, 3.3, 3.12 and the Manage rows of 4.4). The service (index.js) and main.js call the hooks; ipc.js turns METHODS
// into the chat* IPC methods, each as (svc, ...checkedArgs) => result.
//
// Every write that changes shared state is a plain request: a 429 waits Retry-After and tries again, up to three
// times within 30 seconds (svc.call's retry), then fails with rate_limited. Only starting a DM tries again after a
// network error, because the server finds the same DM through its set; making a workspace, channel or invitation
// fails with network, and the next listing or feed shows whether it happened. After each write the service runs the
// workspace's feed, so the feed confirms what changed. Writes whose result the window opens next (a new workspace, a
// joined or left channel, a DM, a block) wait for that run, so the cache already holds it when the call returns.
//
// The routes about one workspace go through svc.call(ws, …), whose 404 with scope workspace runs the removal path.
// Previewing and joining go through svc.call(null, …) with the full route: a wrong secret answers the 404 of a
// workspace that doesn't exist, and that mustn't remove a workspace the person is in.
//
// Decisions where the contract is silent:
// - The pending join is kept for the session it was made in (its tag). Signing out or into another account drops it.
// - A preview of a link to a workspace the person is in falls back to the cached workspace when the server refuses
//   the invitation (used, withdrawn or expired): already is true, issuer.name is '' and expiresAt null.
// - Leaving a workspace, channel or DM the server says the person is no longer in counts as done.
// - Removing yourself through chatRemoveMember or chatRemoveFromChannel is leaving.
const wire = require('./wire');
const sync = require('./sync');

const { ChatError } = wire;

const isGone = (err, scope) => Boolean(err && err.code === 'not_found' && err.scope === scope);

// A Room (contract 4.6) from a DM's feed row, for when the cache can't take it yet (a pass is under way).
function roomOfFeed(dm) {
  return wire.toRoom({
    id: dm.conversation,
    kind: dm.kind,
    name: dm.name,
    visibility: dm.visibility,
    archived: dm.archived ? 1 : 0,
    closedReason: dm.closedReason,
    participants: JSON.stringify(dm.participants || []),
    startedBy: dm.startedBy,
    role: dm.role,
    members: dm.members,
    head: dm.head,
    floor: dm.floor,
    lastAt: dm.lastAt,
    readLocal: dm.read,
    unread: dm.unread,
    mentions: dm.mentions,
    muted: 0,
    lo: null
  });
}

class Manage {
  // The chat* IPC methods this module answers: every Manage row of contract 4.4. The arguments arrive checked by
  // wire.checkArgs.
  static METHODS = {
    chatCreateWorkspace: (svc, input) => svc.manage.createWorkspace(input),
    chatPreviewInvite: (svc, link) => svc.manage.previewInvite(link),
    chatJoin: (svc, input) => svc.manage.join(input),
    chatTakePendingJoin: (svc) => svc.manage.takePendingJoin(),
    chatLeaveWorkspace: (svc, ws) => svc.manage.leaveWorkspace(ws),
    chatDeleteWorkspace: (svc, ws) => svc.manage.deleteWorkspace(ws),
    chatSetMyName: (svc, ws, name) => svc.manage.setMyName(ws, name),
    chatSetRole: (svc, ws, member, role) => svc.manage.setRole(ws, member, role),
    chatRemoveMember: (svc, ws, member) => svc.manage.removeMember(ws, member),
    chatInvites: (svc, ws) => svc.manage.invites(ws),
    chatCreateInvite: (svc, ws, input) => svc.manage.createInvite(ws, input),
    chatWithdrawInvite: (svc, ws, invite) => svc.manage.withdrawInvite(ws, invite),
    chatCreateChannel: (svc, ws, input) => svc.manage.createChannel(ws, input),
    chatRenameChannel: (svc, ws, c, name) => svc.manage.renameChannel(ws, c, name),
    chatArchiveChannel: (svc, ws, c) => svc.manage.archiveChannel(ws, c),
    chatJoinChannel: (svc, ws, c) => svc.manage.joinChannel(ws, c),
    chatAddToChannel: (svc, ws, c, member) => svc.manage.addToChannel(ws, c, member),
    chatSetChannelRole: (svc, ws, c, member, role) => svc.manage.setChannelRole(ws, c, member, role),
    chatRemoveFromChannel: (svc, ws, c, member) => svc.manage.removeFromChannel(ws, c, member),
    chatLeaveChannel: (svc, ws, c, successor) => svc.manage.leaveChannel(ws, c, successor),
    chatStartDm: (svc, ws, members) => svc.manage.startDm(ws, members),
    chatLeaveDm: (svc, ws, c) => svc.manage.leaveDm(ws, c),
    chatBlock: (svc, ws, member) => svc.manage.block(ws, member),
    chatUnblock: (svc, ws, member) => svc.manage.unblock(ws, member)
  };

  constructor(svc) {
    this.svc = svc;
    // The invitation link of a sign-up, until the Chat view takes it: { link, tag } with the session tag it belongs to.
    // Only in memory, so a restart loses it (contract 3.3).
    this.pending = null;
  }

  // ---- hooks ----

  // The invite field of the sign-up form, for main.js accountSignUp (contract 3.3): an invitation link for the
  // configured server becomes workspaceInvite { workspace, invite } and the link to remember; anything else, a link
  // to another server included, stays the operator's invite code.
  splitInvite(text) {
    const raw = typeof text === 'string' ? text : '';
    let found = null;
    try {
      found = wire.parseInviteLink(raw, this.server());
    } catch (_) {
      found = null;
    }
    if (!found) return { invite: raw, workspaceInvite: null, link: null };
    return {
      invite: '',
      workspaceInvite: { workspace: found.workspace, invite: found.secret },
      link: wire.inviteLink(found.server, found.workspace, found.secret)
    };
  }

  // After a sign-up with a link: the Chat view opens the Join dialog with it the next time it shows.
  rememberJoin(link) {
    let found = null;
    try {
      found = wire.parseInviteLink(link, this.server());
    } catch (_) {
      found = null;
    }
    const tag = this.svc.account.sessionTag;
    if (!found || !tag) return;
    this.pending = { link: wire.inviteLink(found.server, found.workspace, found.secret), tag };
    this.svc.stateChanged();
  }

  // Whether a join waits for the Chat view, for ChatState.pendingJoin.
  pendingJoin() {
    return Boolean(this.pending && this.svc.signedIn && this.pending.tag === this.svc.account.sessionTag);
  }

  // After a session's cache was set up: a pending join of another session goes.
  onSignedIn() {
    if (this.pending && this.pending.tag !== this.svc.account.sessionTag) this.pending = null;
  }

  // chatTakePendingJoin: { link } once, then null.
  takePendingJoin() {
    const waiting = this.pendingJoin();
    const link = waiting ? this.pending.link : null;
    if (this.pending) {
      this.pending = null;
      this.svc.stateChanged();
    }
    return link ? { link } : null;
  }

  // ---- helpers ----

  // The configured account server, as serverUrl() writes it: what invitation links are checked against.
  server() {
    const status = this.svc.account && typeof this.svc.account.status === 'function' ? this.svc.account.status() : null;
    return (status && status.server) || this.svc.server || null;
  }

  // An invitation link for this server (contract 3.2), or bad_link or other_server.
  parse(text) {
    return wire.parseInviteLink(text, this.server());
  }

  // The cached workspace row, or the 404 of a workspace that isn't there.
  row(ws) {
    const row = this.svc.store && this.svc.store.getWs(ws);
    if (!row) throw new ChatError('not_found', { scope: 'workspace' });
    return row;
  }

  // A write to ws's routes, with the 429 rule of contract 4.4.
  write(ws, method, route, body, opts = {}) {
    return this.svc.call(ws, method, route, body, { retry: true, ...opts });
  }

  // A run of ws after a write, so the feed confirms it. With wait, resolves when that run ended; a run's failure
  // doesn't fail the write, which the server already took.
  async confirm(epoch, ws, wait = false) {
    const done = this.svc.sync(ws, 'write');
    if (!wait) return;
    await done;
    this.svc.guard(epoch);
  }

  // A workspace the person made or joined, from the answer { workspace, me }: its row, and for a new one its details,
  // so me, the generation and the clock are there before the first run. A row that was there already keeps what it
  // has; its runs check GET / as before.
  adopt(epoch, answer, t0, t1) {
    const svc = this.svc;
    svc.guard(epoch);
    const store = svc.store;
    const { workspace, me } = answer;
    const known = store.getWs(workspace.id);
    store.insertWs({ id: workspace.id, name: workspace.name, role: me.role });
    if (!known || !known.generation) sync.restore(svc, workspace.id, answer, { t0, t1 });
    svc.stateChanged();
    return workspace.id;
  }

  // After making or joining: list the workspaces again, select the new one and wait for its first run.
  async arrive(epoch, ws) {
    const svc = this.svc;
    try {
      await svc.list();
    } catch (err) {
      if (svc.isStale(err)) throw err;
      // A failed listing changes nothing; the row is there.
    }
    svc.guard(epoch);
    if (!svc.store.getWs(ws)) throw new ChatError('not_found', { scope: 'workspace' });
    svc.select(ws);
    await this.confirm(epoch, ws, true);
  }

  // The workspace went because the person left or deleted it: its cache goes, and the list is asked again.
  async gone(epoch, ws, reason) {
    const svc = this.svc;
    svc.guard(epoch);
    svc.removeWorkspace(ws, reason);
    try {
      await svc.list();
    } catch (err) {
      if (svc.isStale(err)) throw err;
    }
    return true;
  }

  // A member row of the directory as the server answered it, when the directory has it. My own role across the guest
  // line marks the channels stale, as sync.js directory() does: the next run then fetches them or clears them.
  updateMember(ws, member) {
    const store = this.svc.store;
    store.tx(() => {
      store.run('UPDATE member SET name = ?, role = ?, state = ? WHERE ws = ? AND id = ?', member.name, member.role, member.state, ws, member.id);
      const row = store.getWs(ws);
      if (row && row.me === member.id) {
        const crossed = (row.role === 'guest') !== (member.role === 'guest');
        store.updateWs(ws, { myName: member.name, role: member.role, ...(crossed ? { channelsStale: 1 } : {}) });
      }
    });
    this.svc.emitChat({ kind: 'directory', ws });
    this.svc.stateChanged();
  }

  // A channel row of the directory as the server answered it.
  putChannel(ws, channel) {
    const store = this.svc.store;
    if (!store.getWs(ws)) return;
    store.run(
      `INSERT INTO channel (ws, id, name, visibility, archived, joined, role, members) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (ws, id) DO UPDATE SET name = excluded.name, visibility = excluded.visibility, archived = excluded.archived,
         joined = excluded.joined, role = excluded.role, members = excluded.members`,
      ws,
      channel.id,
      channel.name,
      channel.visibility,
      channel.archived ? 1 : 0,
      channel.joined ? 1 : 0,
      channel.role ?? null,
      channel.members
    );
    this.svc.emitChat({ kind: 'directory', ws });
  }

  // ---- workspaces ----

  // chatCreateWorkspace: POST /v1/workspaces, then the new workspace is listed, selected and run.
  async createWorkspace({ name, displayName }) {
    const svc = this.svc;
    const epoch = svc.epoch;
    const t0 = svc.now();
    const answer = wire.checkWorkspace(await svc.call(null, 'POST', '/v1/workspaces', { name, displayName }, { retry: true }));
    const t1 = svc.now();
    const ws = this.adopt(epoch, answer, t0, t1);
    await this.arrive(epoch, ws);
    return { ws };
  }

  // chatPreviewInvite: the invitation's card. already says the workspace is in the local list; link is the link as
  // contract 3.2 read it from the text, for the Join field to show in place of a sentence or a link with a full stop.
  async previewInvite(text) {
    const svc = this.svc;
    const epoch = svc.epoch;
    const link = this.parse(text);
    const cleaned = wire.inviteLink(link.server, link.workspace, link.secret);
    const already = Boolean(svc.store.getWs(link.workspace));
    try {
      const preview = wire.checkPreview(
        await svc.call(null, 'POST', `/v1/workspaces/${link.workspace}/invites/preview`, { invite: link.secret }, { retry: true })
      );
      svc.guard(epoch);
      if (preview.workspace.id !== link.workspace) throw new ChatError('server', { where: 'preview.workspace.id' });
      return { ...preview, already: already || Boolean(svc.store.getWs(link.workspace)), link: cleaned };
    } catch (err) {
      if (svc.isStale(err) || !already) throw err;
      svc.guard(epoch);
      // A member's own workspace: the card says so and offers Open, whatever became of the invitation.
      const row = svc.store.getWs(link.workspace);
      if (!row) throw err;
      const channels = svc.store.listRooms(link.workspace).filter((r) => r.kind === 'channel' && !r.archived).length;
      return {
        workspace: { id: row.id, name: row.name },
        role: row.role === 'guest' ? 'guest' : 'member',
        channels,
        issuer: { name: '' },
        expiresAt: null,
        already: true,
        link: cleaned
      };
    }
  }

  // chatJoin: POST /join with the link's secret and the person's name, then the workspace is listed, selected and
  // run (contract 3.3). already: it was in the local list before.
  async join({ link: text, name }) {
    const svc = this.svc;
    const epoch = svc.epoch;
    const link = this.parse(text);
    const already = Boolean(svc.store.getWs(link.workspace));
    const t0 = svc.now();
    const answer = wire.checkWorkspace(
      await svc.call(null, 'POST', `/v1/workspaces/${link.workspace}/join`, { invite: link.secret, name }, { retry: true })
    );
    const t1 = svc.now();
    if (answer.workspace.id !== link.workspace) throw new ChatError('server', { where: 'workspace.workspace.id' });
    const ws = this.adopt(epoch, answer, t0, t1);
    // The link of a sign-up is used now.
    if (this.pending) {
      try {
        if (this.parse(this.pending.link).secret === link.secret) {
          this.pending = null;
          svc.stateChanged();
        }
      } catch (_) {
        this.pending = null;
      }
    }
    await this.arrive(epoch, ws);
    return { ws, already };
  }

  // chatLeaveWorkspace: DELETE /members/me. last_manager names the channels that need a manager first.
  async leaveWorkspace(ws) {
    const epoch = this.svc.epoch;
    this.row(ws);
    try {
      await this.write(ws, 'DELETE', '/members/me', undefined, { goneReason: 'left' });
    } catch (err) {
      if (!isGone(err, 'workspace')) throw err;
    }
    return this.gone(epoch, ws, 'left');
  }

  // chatDeleteWorkspace: DELETE / (contract 2.14), for an owner who is the only member.
  async deleteWorkspace(ws) {
    const epoch = this.svc.epoch;
    this.row(ws);
    try {
      await this.write(ws, 'DELETE', '', undefined, { goneReason: 'deleted' });
    } catch (err) {
      if (!isGone(err, 'workspace')) throw err;
    }
    return this.gone(epoch, ws, 'deleted');
  }

  // ---- members ----

  // chatSetMyName: PATCH /members/me.
  async setMyName(ws, name) {
    const svc = this.svc;
    const epoch = svc.epoch;
    this.row(ws);
    const { me } = wire.checkMe(await this.write(ws, 'PATCH', '/members/me', { name }));
    svc.guard(epoch);
    this.updateMember(ws, me);
    this.confirm(epoch, ws);
    return { me };
  }

  // chatSetRole: PATCH /members/{u}.
  async setRole(ws, member, role) {
    const svc = this.svc;
    const epoch = svc.epoch;
    this.row(ws);
    const answer = wire.checkMemberAnswer(await this.write(ws, 'PATCH', `/members/${member}`, { role }));
    svc.guard(epoch);
    this.updateMember(ws, answer.member);
    await this.confirm(epoch, ws, answer.member.id === this.row(ws).me);
    return { member: answer.member };
  }

  // chatRemoveMember: DELETE /members/{u}. Someone already gone counts as removed; removing yourself is leaving.
  async removeMember(ws, member) {
    const svc = this.svc;
    const epoch = svc.epoch;
    const row = this.row(ws);
    if (member === row.me) return this.leaveWorkspace(ws);
    try {
      await this.write(ws, 'DELETE', `/members/${member}`);
    } catch (err) {
      if (!(err && err.code === 'not_found' && !err.scope)) throw err;
    }
    svc.guard(epoch);
    svc.store.updateWs(ws, { membersStale: 1 });
    this.confirm(epoch, ws);
    return true;
  }

  // ---- invitations ----

  // chatInvites: the open invitations, live (GET /invites).
  async invites(ws) {
    this.row(ws);
    return { invites: wire.checkInvites(await this.svc.call(ws, 'GET', '/invites')).invites };
  }

  // chatCreateInvite: POST /invites, and the link of contract 3.2 with the secret, which the server shows only now.
  async createInvite(ws, { role, channels, expiresIn }) {
    const svc = this.svc;
    const epoch = svc.epoch;
    this.row(ws);
    const made = wire.checkInvite(await this.write(ws, 'POST', '/invites', { role, channels, expiresIn }));
    svc.guard(epoch);
    this.confirm(epoch, ws);
    return { invite: made.invite, link: wire.inviteLink(svc.server, ws, made.secret) };
  }

  // chatWithdrawInvite: DELETE /invites/{i}. Withdrawing twice answers 204 twice.
  async withdrawInvite(ws, invite) {
    const epoch = this.svc.epoch;
    this.row(ws);
    await this.write(ws, 'DELETE', `/invites/${invite}`);
    this.svc.guard(epoch);
    this.confirm(epoch, ws);
    return true;
  }

  // ---- channels ----

  // chatCreateChannel: POST /channels. The maker manages it; the run puts its room in the cache.
  async createChannel(ws, { name, visibility }) {
    const svc = this.svc;
    const epoch = svc.epoch;
    this.row(ws);
    const { channel } = wire.checkChannel(await this.write(ws, 'POST', '/channels', { name, visibility }));
    svc.guard(epoch);
    this.putChannel(ws, channel);
    await this.confirm(epoch, ws, true);
    return { channel };
  }

  // chatRenameChannel: PATCH /channels/{c} with a name.
  async renameChannel(ws, c, name) {
    return this.changeChannel(ws, 'PATCH', `/channels/${c}`, { name });
  }

  // chatArchiveChannel: PATCH /channels/{c} with archived.
  async archiveChannel(ws, c) {
    return this.changeChannel(ws, 'PATCH', `/channels/${c}`, { archived: true });
  }

  // chatJoinChannel: POST /channels/{c}/join, for a channel the workspace can see.
  async joinChannel(ws, c) {
    return this.changeChannel(ws, 'POST', `/channels/${c}/join`);
  }

  async changeChannel(ws, method, route, body) {
    const svc = this.svc;
    const epoch = svc.epoch;
    this.row(ws);
    const { channel } = wire.checkChannel(await this.write(ws, method, route, body));
    svc.guard(epoch);
    this.putChannel(ws, channel);
    await this.confirm(epoch, ws, true);
    return { channel };
  }

  // chatAddToChannel: POST /channels/{c}/members.
  async addToChannel(ws, c, member) {
    const svc = this.svc;
    const epoch = svc.epoch;
    this.row(ws);
    const answer = wire.checkRoomMember(await this.write(ws, 'POST', `/channels/${c}/members`, { member }));
    svc.guard(epoch);
    this.confirm(epoch, ws);
    return answer;
  }

  // chatSetChannelRole: PATCH /channels/{c}/members/{u}.
  async setChannelRole(ws, c, member, role) {
    const svc = this.svc;
    const epoch = svc.epoch;
    const row = this.row(ws);
    const answer = wire.checkRoomMember(await this.write(ws, 'PATCH', `/channels/${c}/members/${member}`, { role }));
    svc.guard(epoch);
    await this.confirm(epoch, ws, member === row.me);
    return answer;
  }

  // chatRemoveFromChannel: DELETE /channels/{c}/members/{u}, for a manager. Removing yourself is leaving.
  async removeFromChannel(ws, c, member) {
    const svc = this.svc;
    const epoch = svc.epoch;
    const row = this.row(ws);
    if (member === row.me) return this.leaveChannel(ws, c, null);
    await this.write(ws, 'DELETE', `/channels/${c}/members/${member}`);
    svc.guard(epoch);
    this.confirm(epoch, ws);
    return true;
  }

  // chatLeaveChannel: DELETE /channels/{c}/members/me, with ?successor= when the only manager passes it on.
  // last_manager when a successor is needed. The run takes the room out of the cache.
  async leaveChannel(ws, c, successor) {
    const svc = this.svc;
    const epoch = svc.epoch;
    this.row(ws);
    const query = successor ? `?successor=${successor}` : '';
    try {
      await this.write(ws, 'DELETE', `/channels/${c}/members/me${query}`);
    } catch (err) {
      if (!isGone(err, 'conversation')) throw err;
    }
    svc.guard(epoch);
    await this.confirm(epoch, ws, true);
    return true;
  }

  // ---- direct messages (contract 3.12) ----

  // chatStartDm: POST /dms with the other people. 201 and 200 alike open the room the server answered with, which goes
  // into the cache at once (it is the room's feed row), unless the cache moved while the POST was on its way: a pass
  // under way or begun, or a feed page applied, may have taken the room out after the server answered (a 200 for a DM
  // left on another device). Then the run decides: the room it brings, or not_found with scope conversation when a
  // run that read the feed to its end left the room out. A reset, restore, Start over or park meanwhile moves the
  // cache revision (contract 3.6) even where cursor and generation end up the same: a 426 that parked the workspace
  // leaves both, and the answer must not write into the parked cache.
  async startDm(ws, members) {
    const svc = this.svc;
    const epoch = svc.epoch;
    const before = this.row(ws);
    const rev = svc.revision(ws);
    let answer;
    for (let attempt = 0; ; attempt++) {
      try {
        answer = wire.checkDm(await this.write(ws, 'POST', '/dms', { members }));
        break;
      } catch (err) {
        // The set finds the same DM, so a start whose answer got lost is safe to send once more.
        if (attempt === 0 && err && err.code === 'network') continue;
        throw err;
      }
    }
    svc.guard(epoch);
    const { dm } = answer;
    const store = svc.store;
    const row = store.getWs(ws);
    const unmoved = Boolean(
      row &&
        svc.revision(ws) === rev &&
        row.state === 'ok' &&
        !before.passing &&
        !row.passing &&
        row.cursor === before.cursor &&
        row.generation === before.generation
    );
    let outcome = null;
    if (unmoved) {
      store.tx(() => {
        store.upsertRoom(ws, dm);
        sync.recount(store, ws, dm.conversation);
      });
      svc.roomsChanged(ws, [dm.conversation]);
      this.confirm(epoch, ws);
    } else {
      outcome = await svc.sync(ws, 'write');
      svc.guard(epoch);
    }
    const cached = svc.store.getRoom(ws, dm.conversation);
    if (cached) return { room: wire.toRoom(cached) };
    const after = svc.store.getWs(ws);
    const complete = outcome && !outcome.error && !outcome.skipped && !outcome.stale && !outcome.more;
    if (complete && after && !after.passing) throw new ChatError('not_found', { scope: 'conversation' });
    return { room: roomOfFeed(dm) };
  }

  // chatLeaveDm: POST /dms/{c}/leave. It closes an open DM for the others; a closed one leaves the list.
  async leaveDm(ws, c) {
    const svc = this.svc;
    const epoch = svc.epoch;
    this.row(ws);
    try {
      await this.write(ws, 'POST', `/dms/${c}/leave`);
    } catch (err) {
      if (!isGone(err, 'conversation')) throw err;
    }
    svc.guard(epoch);
    await this.confirm(epoch, ws, true);
    return true;
  }

  // ---- blocks (contract 2.3) ----

  // chatBlock: POST /blocks. The block list is loaded again (GET /blocks), and the run closes shared DMs.
  async block(ws, member) {
    const svc = this.svc;
    const epoch = svc.epoch;
    this.row(ws);
    const answer = await this.write(ws, 'POST', '/blocks', { member });
    const block = wire.checkBlock(answer && answer.block, 'block.block');
    svc.guard(epoch);
    svc.store.run(
      'INSERT INTO block (ws, member, at) VALUES (?, ?, ?) ON CONFLICT (ws, member) DO UPDATE SET at = excluded.at',
      ws,
      block.member,
      block.at
    );
    return this.afterBlocks(epoch, ws);
  }

  // chatUnblock: DELETE /blocks/{u}. Closed DMs stay closed.
  async unblock(ws, member) {
    const svc = this.svc;
    const epoch = svc.epoch;
    this.row(ws);
    await this.write(ws, 'DELETE', `/blocks/${member}`);
    svc.guard(epoch);
    svc.store.run('DELETE FROM block WHERE ws = ? AND member = ?', ws, member);
    return this.afterBlocks(epoch, ws);
  }

  // The server's block list replaces the cached one; when it can't be loaded now, the row written above stands and
  // the next run loads it.
  async afterBlocks(epoch, ws) {
    const svc = this.svc;
    let replaced = false;
    try {
      replaced = await svc.refreshDirectory(ws, { blocks: true });
    } catch (err) {
      if (svc.isStale(err)) throw err;
    }
    svc.guard(epoch);
    if (!replaced) svc.emitChat({ kind: 'directory', ws });
    await this.confirm(epoch, ws, true);
    return { blocks: svc.store.listBlocks(ws) };
  }
}

module.exports = { Manage };
