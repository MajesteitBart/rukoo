'use strict';

// The feed engine (team chat contract 3.6): one run pages GET /changes for one workspace and applies each page in one
// transaction together with its cursor. The service (index.js) decides when a run starts; this file decides what a
// run does. Every answer is checked whole (wire.checkChanges) before anything of it reaches the cache.
//
// A page outside a pass updates the room rows it lists, deletes evicted rooms and appends the open room's inline
// events. A pass (a new workspace, a 410, a new key, a restore, Start over) collects the room rows in pass_room and
// installs them in one transaction with the page that says more: false, so the sidebar never shows half a pass.
//
// applyPage, applyPassPage and installPass return a PageResult:
//   { changed: string[], evicted: string[], appended: { room, events: Event[] } | null, removed: { [room]: string[] },
//     pass: boolean, partial: boolean, droppedSends: { [room]: number }, redacted: { [room]: string[] } }
// changed: the rooms whose rows changed; evicted: rooms deleted; appended: the open room's inline events as stored;
// removed: per room, the message IDs whose alerts go (removed, removedMore, floors); pass: a pass installed; partial: a
// page of a pass in progress; droppedSends: per evicted room, the unsent messages that went with it; redacted: per
// room, cached messages that lost their text.
//
// Given expect (position() of the ws row the request was built from) and rev (svc.revision(ws) when the request went
// out), each returns null instead and changes nothing when the row no longer has that position or the workspace's
// cache revision moved on: a reset, Start over, restore, new key, park, or a room's cache dropped for removedMore or a
// new grant happened while the page was on its way, and the page belongs to the feed as it stood before.
//
// The cache revision (svc.revision(ws), shared with the history, outbox and alert modules): it goes up inside every
// transaction here that resets, restores, starts over, re-keys or quarantines a workspace, or drops a room's cache for
// removedMore or a new grant, and when the service parks or removes one. A fetch records the revision it started
// under; its answer or error is dropped when it changed.
const wire = require('./wire');
const { ChatError } = wire;

const DAY = 24 * 60 * 60 * 1000;

// The fields of a ws row that say where its feed stands.
const POSITION = ['cursor', 'passing', 'generation', 'keyId'];

function position(row) {
  const out = {};
  for (const key of POSITION) out[key] = row[key] ?? null;
  return out;
}

// Whether the ws row is still at expect and the cache revision still rev, or neither is given.
function atPosition(svc, ws, expect, rev = null) {
  if (rev !== null && svc.revision(ws) !== rev) return false;
  if (!expect) return true;
  const row = svc.store.getWs(ws);
  return Boolean(row) && POSITION.every((key) => (row[key] ?? null) === expect[key]);
}

function emptyResult() {
  return { changed: [], evicted: [], appended: null, removed: {}, pass: false, partial: false, droppedSends: {}, redacted: {} };
}

function addRemoved(result, room, ids) {
  if (!ids.length) return;
  const list = result.removed[room] || (result.removed[room] = []);
  for (const id of ids) if (!list.includes(id)) list.push(id);
}

function addRedacted(result, map) {
  for (const [room, ids] of Object.entries(map)) {
    const list = result.redacted[room] || (result.redacted[room] = []);
    for (const id of ids) if (!list.includes(id)) list.push(id);
  }
}

// The cached message IDs of a room, before its cache goes.
function cachedMessages(store, ws, room) {
  return store.all(`SELECT id FROM event WHERE ws = ? AND room = ? AND kind = 'message.posted'`, ws, room).map((r) => r.id);
}

// What a feed row removed from the cache: the IDs in removed get a tombstone and lose their text, and removedMore
// drops the room's cache whole, as more than the feed can list were removed. Alerts for any of them go, and for every
// alert of the room after removedMore.
//
// removedMore also raises the workspace's cache revision in the same transaction: a history page or an alert fetch
// already on its way may carry the text of messages the feed couldn't list, and no tombstone keeps it out. Every fetch
// started before is dropped by its revision check; the run that applies the page reads the revision again before its
// next request.
function applyRemovals(svc, ws, room, result, alsoGone = []) {
  const store = svc.store;
  const id = room.conversation;
  const gone = [...alsoGone];
  if (room.removed.length) {
    store.addTombstones(ws, room.removed);
    addRedacted(result, store.redact(ws, room.removed));
    gone.push(...room.removed);
  }
  if (room.removedMore && store.getRoom(ws, id)) {
    gone.push(...cachedMessages(store, ws, id), ...store.noticesForRoom(ws, id).map((n) => n.message));
    store.dropRoomCache(ws, id);
    svc.bumpRevision(ws);
  }
  addRemoved(result, id, gone);
}

// The badges of a room this device read further than the server knows (contract 3.9): none once it read to head; a
// recount from the cache when the cache covers everything after the local read position; else the server's numbers
// stand until the next page. Exported for the history module's reads.
function recount(store, ws, room) {
  const r = store.getRoom(ws, room);
  if (!r || r.readLocal <= r.read) return false;
  if (r.readLocal >= r.head) {
    if (r.unread === 0 && r.mentions === 0) return false;
    store.setRoomFields(ws, room, { unread: 0, mentions: 0 });
    return true;
  }
  const covers = r.lo !== null && r.hi !== null && r.hi >= r.head && r.lo <= r.readLocal + 1;
  const me = store.getWs(ws)?.me;
  if (!covers || !me) return false;
  const badges = store.countBadges(ws, room, r.readLocal, me);
  if (badges.unread === r.unread && badges.mentions === r.mentions) return false;
  store.setRoomFields(ws, room, badges);
  return true;
}

// One room row from the feed, outside a pass or when a pass installs: the row with the grant, field, read and floor
// rules of the store's upsertRoom, then its removals and badges. A new grant (left and joined again elsewhere) empties
// the cache as removedMore does, as the feed can't list what was removed while the person was out, so it raises the
// cache revision too: pages loaded under the old grant (a thread's memory, an opening's detached events) go with it.
function applyRoom(svc, ws, room, result) {
  const store = svc.store;
  const { dropped, grantChanged } = store.upsertRoom(ws, room);
  if (grantChanged) svc.bumpRevision(ws);
  applyRemovals(svc, ws, room, result, dropped);
  recount(store, ws, room.conversation);
  if (!result.changed.includes(room.conversation)) result.changed.push(room.conversation);
}

// The directory flags of a page mark what the run loads again at its end.
function markStale(store, ws, directory) {
  const flags = {};
  if (directory.members) flags.membersStale = 1;
  if (directory.channels) flags.channelsStale = 1;
  if (directory.blocks) flags.blocksStale = 1;
  if (Object.keys(flags).length) store.updateWs(ws, flags);
}

// The open room's inline events: appended only when they follow the cached range at once, or fill an uncached room
// up to its head. Anything else leaves the room behind, and the history module catches it up.
function appendInline(store, ws, active, events, result) {
  if (!active || !events.length) return;
  const room = store.getRoom(ws, active);
  if (!room) return;
  const first = events[0].seq;
  const last = events[events.length - 1].seq;
  const fits = room.hi !== null ? first === room.hi + 1 : last === room.head;
  if (!fits) return;
  const stored = store.appendEvents(ws, active, events);
  const targets = events.filter((e) => e.kind === 'message.redacted' && e.target).map((e) => e.target);
  if (targets.length) {
    addRedacted(result, { [active]: targets });
    addRemoved(result, active, targets);
  }
  recount(store, ws, active);
  result.appended = { room: active, events: stored.map(wire.toRenderer) };
  if (!result.changed.includes(active)) result.changed.push(active);
}

// A page outside a pass (passing = 0), in one transaction with its cursor.
function applyPage(svc, ws, page, { active = null, expect = null, rev = null } = {}) {
  const store = svc.store;
  return store.tx(() => {
    if (!atPosition(svc, ws, expect, rev)) return null;
    const result = emptyResult();
    const listed = new Set();
    for (const room of page.changes) {
      applyRoom(svc, ws, room, result);
      listed.add(room.conversation);
    }
    for (const id of page.evictions) {
      if (listed.has(id) || !store.getRoom(ws, id)) continue;
      result.droppedSends[id] = store.deleteRoom(ws, id);
      result.evicted.push(id);
    }
    appendInline(store, ws, active, page.inlineEvents, result);
    markStale(store, ws, page.directory);
    store.updateWs(ws, { cursor: page.next });
    return result;
  });
}

// The rooms a page of a pass evicted, and didn't list again, leave pass_room (contract 3.6): a room an earlier page
// staged and the person lost since then must not install. The visible room list waits for the install, which deletes
// every room without a pass_room row.
function dropEvictedFromPass(store, ws, page) {
  const listed = new Set(page.changes.map((room) => room.conversation));
  const evicted = page.evictions.filter((id) => !listed.has(id));
  if (evicted.length) store.deletePassRooms(ws, evicted);
}

// A page of a pass that says more: true. Its rooms wait in pass_room; what it removed and the floors already apply
// to cached events, and its evictions take staged rooms out of pass_room.
function applyPassPage(svc, ws, page, { expect = null, rev = null } = {}) {
  const store = svc.store;
  return store.tx(() => {
    if (!atPosition(svc, ws, expect, rev)) return null;
    const result = emptyResult();
    result.partial = true;
    dropEvictedFromPass(store, ws, page);
    for (const room of page.changes) {
      store.putPassRoom(ws, room);
      if (store.getRoom(ws, room.conversation)) {
        applyRemovals(svc, ws, room, result, store.applyFloor(ws, room.conversation, room.floor));
      } else if (room.removed.length) {
        store.addTombstones(ws, room.removed);
      }
    }
    markStale(store, ws, page.directory);
    store.updateWs(ws, { cursor: page.next });
    return result;
  });
}

// The page of a pass that says more: false: the pass's rooms replace the workspace's in one transaction. A room the
// pass didn't list is deleted; the others are upserted with the rules of an incremental page, keeping notified and
// muted. The pass that first fills a workspace alerts nothing, so every room counts as notified up to its head.
function installPass(svc, ws, page, { expect = null, rev = null } = {}) {
  const store = svc.store;
  return store.tx(() => {
    if (!atPosition(svc, ws, expect, rev)) return null;
    const result = emptyResult();
    result.pass = true;
    dropEvictedFromPass(store, ws, page);
    for (const room of page.changes) store.putPassRoom(ws, room);
    const rooms = store.listPassRooms(ws);
    const keep = new Set(rooms.map((r) => r.conversation));
    for (const r of store.listRooms(ws)) {
      if (keep.has(r.id)) continue;
      result.droppedSends[r.id] = store.deleteRoom(ws, r.id);
      result.evicted.push(r.id);
    }
    for (const room of rooms) applyRoom(svc, ws, room, result);
    const row = store.getWs(ws);
    if (row.fresh) store.run('UPDATE room SET notified = MAX(notified, head) WHERE ws = ?', ws);
    markStale(store, ws, page.directory);
    store.updateWs(ws, { cursor: page.next, passing: 0, fresh: 0 });
    store.clearPass(ws);
    store.pruneTombstones(ws, svc.now() - svc.timing.tombstoneDays * DAY);
    return result;
  });
}

// Every room of a workspace, for a rooms event after something changed them all.
function allRooms(store, ws) {
  return store.listRooms(ws).map((r) => r.id);
}

// 410 reset_required: the cached bodies go before the rebuild starts, so stale text never shows as current. The server
// can no longer list what was removed in the meantime, so the alerts' notice rows go too, and the caller takes every
// alert of the workspace back (contract 3.6 and 3.10).
function reset(svc, ws) {
  const store = svc.store;
  store.tx(() => {
    svc.bumpRevision(ws);
    store.run('DELETE FROM notice WHERE ws = ?', ws);
    store.deleteWsEvents(ws);
    store.clearPass(ws);
    store.updateWs(ws, { cursor: null, passing: 1 });
  });
  svc.roomsChanged(ws, allRooms(store, ws));
}

// 409 history_regressed: the workspace is behind what this device saw. It stops (the UI says so, with Start over):
// cached events and badges go, the socket closes and the outbox holds its rows (store.nextDue sends only for ok).
function quarantine(svc, ws) {
  const store = svc.store;
  store.tx(() => {
    svc.bumpRevision(ws);
    store.updateWs(ws, { state: 'quarantined' });
    store.deleteWsEvents(ws);
    store.run('UPDATE room SET unread = 0, mentions = 0 WHERE ws = ?', ws);
  });
  svc.roomsChanged(ws, allRooms(store, ws));
  svc.updateSockets();
  svc.stateChanged();
}

// Start over (chatReload), after a quarantine or whenever the person asks: a pass from the start, with every unsent
// message of the workspace checked against the server before it is sent again. A pass from the start lists no
// removals, so as with a 410 the cached bodies and the alerts' notice rows go, and the caller takes every alert of the
// workspace back (contract 3.6 and 3.10). Rooms, read positions, drafts, mute and the outbox stay.
function startOver(svc, ws) {
  const store = svc.store;
  store.tx(() => {
    svc.bumpRevision(ws);
    store.run('DELETE FROM notice WHERE ws = ?', ws);
    store.deleteWsEvents(ws);
    store.updateWs(ws, { state: 'ok', cursor: null, passing: 1 });
    store.clearPass(ws);
    store.markLookup(ws, null);
  });
  svc.roomsChanged(ws, allRooms(store, ws));
}

// The answer of GET / (wire.checkWorkspace), with t0 and t1 the local times before and after it. A generation other
// than the stored one is a restore: a pass follows, and unsent messages of the old generation are looked up before
// they are sent again. A new keyId means a pass too, as cursors sealed with the old key are no good. Either pass lists
// no removals, and a restored backup may lack messages this device saw, so the cached events and notice rows go as for
// a 410, and the caller takes the workspace's alerts back. Also measures the clock: server time minus local time.
//
// A restore also forgets where this device read and alerted in the discarded generation (contract 3.6 Restore): the
// restored feed may stand below it, and positions kept from before would hide its unread messages and their alerts.
// read, readLocal, readSent and notified go to 0, so the pass's install takes them from the restored feed (notify.js
// counts alerts from max(read, readLocal, notified)). Mute and drafts stay.
function restore(svc, ws, answer, { t0, t1 }) {
  const store = svc.store;
  const { workspace, me } = answer;
  return store.tx(() => {
    const row = store.getWs(ws);
    if (!row) return { restored: false, keyChanged: false };
    let restored = false;
    let keyChanged = false;
    if (row.generation && row.generation !== workspace.generation) {
      restored = true;
      svc.bumpRevision(ws);
      store.run('DELETE FROM notice WHERE ws = ?', ws);
      store.deleteWsEvents(ws);
      store.clearPass(ws);
      store.run('UPDATE room SET read = 0, readLocal = 0, readSent = 0, notified = 0 WHERE ws = ?', ws);
      store.updateWs(ws, { cursor: null, passing: 1, generation: workspace.generation });
      store.markLookup(ws, row.generation);
    } else if (row.keyId && row.keyId !== workspace.keyId) {
      keyChanged = true;
      svc.bumpRevision(ws);
      store.run('DELETE FROM notice WHERE ws = ?', ws);
      store.deleteWsEvents(ws);
      store.clearPass(ws);
      store.updateWs(ws, { cursor: null, passing: 1 });
    }
    store.updateWs(ws, {
      name: workspace.name,
      role: me.role,
      me: me.id,
      myName: me.name,
      generation: workspace.generation,
      keyId: workspace.keyId,
      limits: workspace.limits,
      retention: workspace.retention
    });
    store.roleChanged(ws, row.role, me.role);
    store.setMeta('clockOffset', String(Math.round(workspace.time - (t0 + t1) / 2)));
    store.setMeta('clockAt', String(t1));
    return { restored, keyChanged };
  });
}

// A hook of another module. Its failure doesn't stop the feed; an answer for an ended session does.
async function hook(svc, fn) {
  try {
    const value = fn();
    if (value && typeof value.then === 'function') await value;
  } catch (err) {
    if (svc.isStale(err)) throw err;
    svc.hookFailed(err);
  }
}

// What follows a page's transaction: the rooms, evicted and redacted events, then the modules' hooks in the order of
// contract 4.3.
async function afterPage(svc, ws, result) {
  if (result.changed.length || result.evicted.length) svc.roomsChanged(ws, result.changed, result.evicted);
  for (const room of result.evicted) {
    svc.emitChat({ kind: 'evicted', ws, conversation: room, droppedSends: result.droppedSends[room] || 0 });
  }
  for (const [room, ids] of Object.entries(result.redacted)) {
    if (ids.length) svc.emitChat({ kind: 'redacted', ws, conversation: room, ids });
  }
  if (!result.partial) await hook(svc, () => svc.history.afterPage(ws, result));
  // Every changed room goes to the history module, also without removed IDs: a page can raise a room's floor past
  // events it holds outside the cache (a thread's memory, an opening's detached events) when no cached event was
  // below it, and those are checked against the floor and the tombstones there.
  for (const room of new Set([...result.changed, ...Object.keys(result.removed)])) {
    const ids = result.removed[room] || [];
    await hook(svc, () => svc.history.onRemoved(ws, room, ids));
    if (ids.length) await hook(svc, () => svc.notifier.onRemoved(ws, room, ids));
  }
  for (const room of result.evicted) {
    await hook(svc, () => svc.notifier.onEvicted(ws, room));
    await hook(svc, () => svc.history.onEvicted(ws, room));
  }
}

// The directories a page marked stale: GET /members, GET /channels (full members only: guests have none) and GET
// /blocks. Each answer replaces that workspace's rows in one transaction and clears its flag. A failure leaves the
// flag for the next run; a server from before blocks (404 without a scope) has none to list. Returns whether
// anything was replaced, after a directory event. guard() throws after an await when the answer no longer counts: by
// default when the session ended, and in a run also when the run was stopped.
async function directory(svc, ws, guard = null) {
  const store = svc.store;
  const epoch = svc.epoch;
  if (!guard) guard = () => svc.guard(epoch);
  let changed = false;
  const load = async (flag, fetch) => {
    const row = store.getWs(ws);
    if (!row || !row[flag]) return;
    try {
      await fetch(row);
      changed = true;
    } catch (err) {
      if (svc.isStale(err)) throw err;
      if (err && err.code === 'not_found' && err.scope === 'workspace' && !err.superseded) throw err;
    }
  };
  // The caller's own row carries a role or name someone else changed, which GET / would only bring at the next restore
  // check: the ws row takes them, so the workspace summary says the same as the member list. A role across the guest
  // line also changes the channel directory, as the server bumps only the members for a role change: a promoted guest
  // has no channel directory yet and a demoted member one too many. The channels load below reads the row again.
  let meChanged = false;
  await load('membersStale', async () => {
    const res = wire.checkMembers(await svc.call(ws, 'GET', '/members'));
    guard();
    store.tx(() => {
      const row = store.getWs(ws);
      if (!row) return;
      store.replaceMembers(ws, res.members, res.more);
      const mine = row.me && res.members.find((m) => m.id === row.me);
      if (mine && (mine.role !== row.role || mine.name !== row.myName)) {
        // store.roleChanged clears the directory of a demoted guest and marks it stale for a promoted one.
        store.updateWs(ws, { role: mine.role, myName: mine.name });
        store.roleChanged(ws, row.role, mine.role);
        meChanged = true;
      }
    });
  });
  await load('channelsStale', async (row) => {
    if (row.role === 'guest') {
      store.replaceChannels(ws, []);
      return;
    }
    const rev = svc.revision(ws);
    const res = wire.checkChannels(await svc.call(ws, 'GET', '/channels'));
    guard();
    // Demoted to guest meanwhile (the listing or GET / cleared the directory), or the cache moved on: the answer is
    // from before, and the flag stays for the next run when it is still set.
    const now = store.getWs(ws);
    if (!now || now.role === 'guest' || svc.revision(ws) !== rev) return;
    store.replaceChannels(ws, res.channels);
  });
  await load('blocksStale', async () => {
    let res;
    try {
      res = wire.checkBlocks(await svc.call(ws, 'GET', '/blocks'));
    } catch (err) {
      if (!(err && err.code === 'not_found' && !err.scope)) throw err;
      res = { blocks: [] };
    }
    guard();
    if (store.getWs(ws)) store.replaceBlocks(ws, res.blocks);
  });
  if (changed && store.getWs(ws)) svc.emitChat({ kind: 'directory', ws });
  if (meChanged) svc.stateChanged();
  return changed;
}

// One run for one workspace. Returns { changed, pass } when it got through, { more: true } when it stopped after
// PAGES_PER_RUN pages, or { skipped | quarantined | gone | upgrade: true }. Throws a ChatError for the service's
// backoff, or the service's stale marker when the session ended or the service stopped the run (Chat turned off)
// meanwhile.
//
// A pass from the start (cursor NULL, passing 1) begins only after a GET / that answered under the current cache
// revision (svc.detailsCurrent): a 410 whose GET / failed, or a restart in the middle, asks again, so a restore the
// server made meanwhile is found before the pass installs.
async function runSync(svc, ws) {
  const store = svc.store;
  const epoch = svc.epoch;
  const runner = svc.runner(ws);
  const stops = runner.stops;
  const guard = () => svc.guard(epoch, { runner, stops });
  let row = store.getWs(ws);
  if (!row || row.state !== 'ok' || !svc.live()) return { skipped: true };
  const changed = new Set();
  let installed = false;
  let resets = 0;
  let pages = 0;
  let asked = 0;
  for (;;) {
    row = store.getWs(ws);
    if (!row || row.state !== 'ok') return { skipped: true, changed: [...changed] };
    if (pages >= svc.timing.pagesPerRun) return { more: true, changed: [...changed] };
    // At most three GET / per run, so answers dropped again and again (the revision kept moving) can't keep it going.
    // A run that used them up without a current answer goes on later (more), as the pass mustn't begin without one.
    const needsDetails = !row.generation || runner.detailsDue || (row.passing && !row.cursor && !svc.detailsCurrent(ws));
    if (needsDetails) {
      if (asked >= 3) return { more: true, changed: [...changed] };
      asked += 1;
      runner.detailsDue = false;
      try {
        // The run's own guard: a run Chat stopped while GET / was on its way doesn't apply the answer.
        await svc.details(ws, { inRun: true, run: { runner, stops } });
      } catch (err) {
        if (!svc.isStale(err)) runner.detailsDue = true;
        // A 404 or 426 that answered after the cache moved on belongs to it as it stood (call() left it alone).
        if (err && err.superseded) {
          guard();
          continue;
        }
        throw err;
      }
      guard();
      continue;
    }
    const query = new URLSearchParams({ limit: String(svc.timing.feedLimit) });
    if (row.cursor) query.set('after', row.cursor);
    else if (row.passing) store.clearPass(ws);
    let active = null;
    if (!row.passing) {
      let open = null;
      try {
        open = svc.history.activeQuery(ws);
      } catch (err) {
        svc.hookFailed(err);
      }
      if (open && typeof open.active === 'string' && wire.patterns.CONVERSATION_ID.test(open.active)) {
        active = open.active;
        query.set('active', active);
        if (Number.isSafeInteger(open.roomAfter) && open.roomAfter >= 0) query.set('roomAfter', String(open.roomAfter));
      }
    }
    // The cache revision this request starts under; see the top of this file.
    const rev = svc.revision(ws);
    let page;
    try {
      page = wire.checkChanges(await svc.call(ws, 'GET', `/changes?${query}`));
    } catch (err) {
      if (svc.isStale(err)) throw err;
      guard();
      const code = err && err.code;
      // The service's call() ran the removal path, or parked the workspace for an update. A superseded one it left
      // alone, as the revision moved: it goes with the other errors from before, below.
      if (code === 'not_found' && err.scope === 'workspace' && !err.superseded) return { gone: true };
      if (code === 'upgrade_required' && !err.superseded) return { upgrade: true };
      // Reset, restored, started over or parked meanwhile: the error belongs to the feed as it stood before, so it
      // neither resets, quarantines nor counts as a failure. The loop goes on from where the row stands now.
      if (svc.revision(ws) !== rev) {
        pages += 1;
        continue;
      }
      if (code === 'reset_required') {
        if (resets > 0) throw new ChatError('server', { status: 410 });
        resets += 1;
        reset(svc, ws);
        await hook(svc, () => svc.notifier.onReset(ws));
        await hook(svc, () => svc.history.onReset(ws));
        // GET / follows at the top of the loop, as the pass from the start needs one under the new revision.
        guard();
        continue;
      }
      if (code === 'history_regressed') {
        quarantine(svc, ws);
        await hook(svc, () => svc.history.onReset(ws));
        return { quarantined: true };
      }
      throw err;
    }
    guard();
    if (!store.getWs(ws)) return { gone: true };
    // Only while the row is where the request started from, under the same cache revision; see atPosition().
    const expect = position(row);
    let result;
    if (!row.passing) result = applyPage(svc, ws, page, { active, expect, rev });
    else if (page.more) result = applyPassPage(svc, ws, page, { expect, rev });
    else result = installPass(svc, ws, page, { expect, rev });
    pages += 1;
    // Reset meanwhile: the page is dropped, and the loop goes on from where the row stands now, a pass from the start.
    if (!result) continue;
    for (const id of result.changed) changed.add(id);
    if (result.pass) installed = true;
    await afterPage(svc, ws, result);
    guard();
    if (!page.more) break;
  }
  if (installed) svc.stateChanged();
  await directory(svc, ws, guard);
  guard();
  await hook(svc, () => svc.history.afterRun(ws));
  await hook(svc, () => svc.notifier.afterRun(ws, [...changed], { pass: installed }));
  guard();
  if (store.getWs(ws)) store.updateWs(ws, { syncedAt: svc.now() });
  await hook(svc, () => svc.outbox.kick(ws));
  return { changed: [...changed], pass: installed };
}

module.exports = {
  runSync,
  applyPage,
  applyPassPage,
  installPass,
  reset,
  quarantine,
  startOver,
  restore,
  directory,
  recount,
  afterPage
};
