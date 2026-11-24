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
// - The pending join is kept for the session it was made in (its tag), in chat-join.json beside the cache, so a restart
//   between the sign-up and the join offers it again. Joining with it, Cancel in the Join dialog, a link the server
//   no longer takes, seven days (the longest an invitation lasts), signing out or into another account drop it.
// - A preview of a link to a workspace the person is in falls back to the cached workspace when the server refuses
//   the invitation (used, withdrawn or expired): already is true, issuer.name is '' and expiresAt null.
// - Leaving a workspace, channel or DM the server says the person is no longer in counts as done.
// - Removing yourself through chatRemoveMember or chatRemoveFromChannel is leaving.
const fs = require('fs');
const path = require('path');
const wire = require('./wire');
const sync = require('./sync');

const { ChatError } = wire;

// The longest an invitation lasts (the server takes expiresIn up to seven days): a pending join older than this can't
// work any more.
const PENDING_MAX = 7 * 24 * 60 * 60 * 1000;
// A preview of the pending link that fails with one of these means it never will work.
const FAILS_FOR_GOOD = new Set(['invite_gone', 'not_found', 'bad_link', 'other_server']);

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
    agents: dm.agents ?? 0,
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
    chatDropPendingJoin: (svc) => svc.manage.dropPendingJoin(),
    chatCheckLink: (svc, link) => svc.manage.checkLink(link),
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
    chatUnblock: (svc, ws, member) => svc.manage.unblock(ws, member),
    // Agents in channels (server/WORKSPACES.md "Agents").
    chatAgents: (svc, ws) => svc.manage.agents(ws),
    chatCreateAgent: (svc, ws, input) => svc.manage.createAgent(ws, input),
    chatUpdateAgent: (svc, ws, agent, input) => svc.manage.updateAgent(ws, agent, input),
    chatNewAgentKey: (svc, ws, agent) => svc.manage.newAgentKey(ws, agent),
    chatRemoveAgent: (svc, ws, agent) => svc.manage.removeAgent(ws, agent)
  };

  constructor(svc) {
    this.svc = svc;
    // The invitation link of a sign-up or sign-in, until the person joined with it or let it go: { link, tag, at } with
    // the session tag it belongs to and when it was made. Kept in chat-join.json (file()), so a restart keeps it.
    this.pending = null;
    // The Join dialog showed the pending link in this run: ChatState.pendingJoin says false until the next start.
    this.offered = false;
    this.loaded = false;
  }

  // ---- the pending join ----

  file() {
    return path.join(this.svc.dataDir, 'chat-join.json');
  }

  // The pending join on disk, read at the first use. Without keepJoin (the browser) it lives in memory only.
  load() {
    if (this.loaded) return;
    this.loaded = true;
    if (this.svc.keepJoin === false) return;
    let saved = null;
    try {
      saved = JSON.parse(fs.readFileSync(this.file(), 'utf8'));
    } catch (_) {
      saved = null;
    }
    if (saved && typeof saved.link === 'string' && typeof saved.tag === 'string' && Number.isSafeInteger(saved.at)) {
      this.pending = { link: saved.link, tag: saved.tag, at: saved.at };
    }
  }

  save() {
    if (this.svc.keepJoin === false) return;
    try {
      if (!this.pending) {
        fs.rmSync(this.file(), { force: true });
        return;
      }
      fs.mkdirSync(path.dirname(this.file()), { recursive: true });
      const tmp = `${this.file()}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.pending));
      fs.renameSync(tmp, this.file());
    } catch (err) {
      // Kept in memory for this run; only a restart loses it.
      this.svc.hookFailed(err);
    }
  }

  // The pending join goes, from disk too.
  forget() {
    this.load();
    const had = Boolean(this.pending);
    this.pending = null;
    this.offered = false;
    if (had || (this.svc.keepJoin !== false && fs.existsSync(this.file()))) this.save();
    if (had) this.svc.stateChanged();
  }

  // The pending join of the session signed in now, unless it is too old to work: { link, tag, at }, or null.
  current() {
    this.load();
    const p = this.pending;
    if (!p || !this.svc.signedIn || p.tag !== this.svc.account.sessionTag) return null;
    const age = this.svc.now() - p.at;
    if (age > PENDING_MAX || age < -PENDING_MAX) {
      this.forget();
      return null;
    }
    return p;
  }

  // ---- hooks ----

  // The invite field of the sign-up form, for main.js accountSignUp (wire.splitInvite). A link to another server
  // throws ChatError('other_server'), as Android's sign-up form refuses it (RukooAccountModel.inviteInput).
  splitInvite(text) {
    return wire.splitInvite(text, this.servers());
  }

  // After a sign-up or sign-in with a link: the Chat view opens the Join dialog with it the next time it shows, also
  // after a restart.
  rememberJoin(link) {
    let found = null;
    try {
      found = wire.parseInviteLink(link, this.servers());
    } catch (_) {
      found = null;
    }
    const tag = this.svc.account.sessionTag;
    if (!found || !tag) return;
    this.loaded = true;
    this.pending = { link: wire.inviteLink(found.server, found.workspace, found.secret), tag, at: this.svc.now() };
    this.offered = false;
    this.save();
    this.svc.stateChanged();
  }

  // Whether a join waits for the Chat view, for ChatState.pendingJoin: one the Join dialog didn't show yet in this run.
  pendingJoin() {
    return Boolean(this.current() && !this.offered && this.svc.store);
  }

  // After a session's cache was set up: a pending join of another session goes.
  onSignedIn() {
    this.load();
    if (this.pending && this.pending.tag !== this.svc.account.sessionTag) this.forget();
  }

  // Signed out: the pending join goes with the session.
  onSignedOut() {
    this.forget();
  }

  // chatTakePendingJoin: { link } once per run, then null. It stays on disk until the person joined with it, let it go
  // (chatDropPendingJoin) or the server refused it for good, so a restart with the dialog still open offers it again.
  takePendingJoin() {
    const p = this.current();
    // Only once the session's cache is open: the Join dialog previews it at once.
    if (!p || this.offered || !this.svc.store) return null;
    this.offered = true;
    this.svc.stateChanged();
    return { link: p.link };
  }

  // chatDropPendingJoin: Cancel in the Join dialog that showed the pending link.
  dropPendingJoin() {
    this.forget();
    return true;
  }

  // The pending join is over when it holds this secret: joined, or refused for good.
  settled(secret) {
    const p = this.current();
    if (!p) return;
    let same = true;
    try {
      same = wire.parseInviteLink(p.link).secret === secret;
    } catch (_) {
      // A link on disk that doesn't read as one can't be joined either.
    }
    if (same) this.forget();
  }

  // ---- helpers ----

  // The configured account server, as serverUrl() writes it: where every request goes.
  server() {
    const status = this.svc.account && typeof this.svc.account.status === 'function' ? this.svc.account.status() : null;
    return (status && status.server) || this.svc.server || null;
  }

  // The addresses that count as the configured server for invitation links (wire.sameServers): the server and the
  // others the app knows are the same one, never what the server says of itself. Signed out too, for the setup page.
  servers() {
    return wire.sameServers(this.server());
  }

  // An invitation link for this server (contract 3.2), or bad_link or other_server.
  parse(text) {
    return wire.parseInviteLink(text, this.servers());
  }

  // chatCheckLink: whether text holds an invitation link for this server, also before there is an account (the setup
  // page's team chat step): { link, host } with the link as main reads it, or bad_link or other_server.
  checkLink(text) {
    const link = this.parse(text);
    let host = '';
    try {
      host = new URL(link.server).host;
    } catch (_) {
      host = '';
    }
    return { link: wire.inviteLink(link.server, link.workspace, link.secret), host };
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
    let link;
    try {
      link = this.parse(text);
    } catch (err) {
      // The pending link itself no longer reads as this server's (its home changed): it won't after a restart either.
      const p = this.current();
      if (p && typeof text === 'string' && text.trim() === p.link) this.forget();
      throw err;
    }
    const cleaned = wire.inviteLink(link.server, link.workspace, link.secret);
    const already = Boolean(svc.store.getWs(link.workspace));
    try {
      const preview = wire.checkPreview(
        await svc.call(null, 'POST', `/v1/workspaces/${link.workspace}/invites/preview`, { invite: link.secret }, { retry: true })
      );
      svc.guard(epoch);
      if (preview.workspace.id !== link.workspace) throw new ChatError('server', { where: 'preview.workspace.id' });
      const isIn = already || Boolean(svc.store.getWs(link.workspace));
      // A pending join of a workspace the person is in already has nothing left to do.
      if (isIn) this.settled(link.secret);
      return { ...preview, already: isIn, link: cleaned };
    } catch (err) {
      // A pending link the server refuses for good won't work after a restart either.
      if (!svc.isStale(err) && err && FAILS_FOR_GOOD.has(err.code) && err.scope !== 'conversation') this.settled(link.secret);
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
    // The link of a sign-up or sign-in is used now.
    this.settled(link.secret);
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
    // From the server's home, so devices at its former address read the link as theirs too (wire.inviteServer).
    return { invite: made.invite, link: wire.inviteLink(wire.inviteServer(svc.server, svc.info), ws, made.secret) };
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
        // A new grant empties the room's cache and raises the cache revision, as the feed's does (sync.js applyRoom).
        if (store.upsertRoom(ws, dm).grantChanged) svc.bumpRevision(ws);
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

  // ---- agents in channels (server/WORKSPACES.md "Agents") ----
  //
  // An agent is a member with kind agent, made by a full member (its sponsor) and run by its own runtime with a key. A
  // change to one is a change of the directory: each write marks the members stale and waits for the run, so the
  // directory the window reads next (Add people, the mention list, Members) has it.

  // chatAgents: the workspace's active agents, live (GET /agents), for full members.
  async agents(ws) {
    this.row(ws);
    return { agents: wire.checkAgents(await this.svc.call(ws, 'GET', '/agents')).agents };
  }

  // chatCreateAgent: POST /agents. The caller becomes its sponsor. The key is in this answer only.
  async createAgent(ws, { name, answers, members, agents }) {
    const epoch = this.svc.epoch;
    this.row(ws);
    const body = { name, answers, agents, ...(answers === 'members' ? { members } : {}) };
    const made = wire.checkAgentAnswer(await this.write(ws, 'POST', '/agents', body), { key: true });
    await this.agentChanged(epoch, ws);
    return made;
  }

  // chatUpdateAgent: PATCH /agents/{u} with what changes.
  async updateAgent(ws, agent, patch) {
    const epoch = this.svc.epoch;
    this.row(ws);
    const answer = wire.checkAgentAnswer(await this.write(ws, 'PATCH', `/agents/${agent}`, patch));
    await this.agentChanged(epoch, ws);
    return answer;
  }

  // chatNewAgentKey: POST /agents/{u}/key. The old key stops at once; the new one is in this answer only.
  async newAgentKey(ws, agent) {
    const epoch = this.svc.epoch;
    this.row(ws);
    const made = wire.checkAgentAnswer(await this.write(ws, 'POST', `/agents/${agent}/key`), { key: true });
    this.svc.guard(epoch);
    return made;
  }

  // chatRemoveAgent: DELETE /agents/{u}. An agent that is gone already counts as removed.
  async removeAgent(ws, agent) {
    const epoch = this.svc.epoch;
    this.row(ws);
    try {
      await this.write(ws, 'DELETE', `/agents/${agent}`);
    } catch (err) {
      if (!(err && err.code === 'not_found' && !err.scope)) throw err;
    }
    await this.agentChanged(epoch, ws);
    return true;
  }

  // After a write that changed an agent: the directory loads again, and the call returns once it did. A run's failure
  // doesn't fail the write, which the server already took.
  async agentChanged(epoch, ws) {
    const svc = this.svc;
    svc.guard(epoch);
    if (!svc.store.getWs(ws)) return;
    svc.store.updateWs(ws, { membersStale: 1 });
    await this.confirm(epoch, ws, true);
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
