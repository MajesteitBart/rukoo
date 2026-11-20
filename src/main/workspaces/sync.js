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
// Given expect (position() of the ws row the request was built from), each returns null instead and changes nothing
// when the row no longer has that position: a Start over, restore or new key outside the run reset it while the page
// was on its way, and the page belongs to the feed position before that reset.
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

// Whether the ws row is still at expect, or there is no expect.
function atPosition(store, ws, expect) {
  if (!expect) return true;
  const row = store.getWs(ws);
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
function applyRemovals(store, ws, room, result, alsoGone = []) {
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
// rules of the store's upsertRoom, then its removals and badges.
function applyRoom(store, ws, room, result) {
  const { dropped } = store.upsertRoom(ws, room);
  applyRemovals(store, ws, room, result, dropped);
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
function applyPage(svc, ws, page, { active = null, expect = null } = {}) {
  const store = svc.store;
  return store.tx(() => {
    if (!atPosition(store, ws, expect)) return null;
    const result = emptyResult();
    const listed = new Set();
    for (const room of page.changes) {
      applyRoom(store, ws, room, result);
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

// A page of a pass that says more: true. Its rooms wait in pass_room; what it removed and the floors already apply
// to cached events, and evictions wait for the install, which deletes every room the pass didn't list.
function applyPassPage(svc, ws, page, { expect = null } = {}) {
  const store = svc.store;
  return store.tx(() => {
    if (!atPosition(store, ws, expect)) return null;
    const result = emptyResult();
    result.partial = true;
    for (const room of page.changes) {
      store.putPassRoom(ws, room);
      if (store.getRoom(ws, room.conversation)) {
        applyRemovals(store, ws, room, result, store.applyFloor(ws, room.conversation, room.floor));
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
function installPass(svc, ws, page, { expect = null } = {}) {
  const store = svc.store;
  return store.tx(() => {
    if (!atPosition(store, ws, expect)) return null;
    const result = emptyResult();
    result.pass = true;
    for (const room of page.changes) store.putPassRoom(ws, room);
    const rooms = store.listPassRooms(ws);
    const keep = new Set(rooms.map((r) => r.conversation));
    for (const r of store.listRooms(ws)) {
      if (keep.has(r.id)) continue;
      result.droppedSends[r.id] = store.deleteRoom(ws, r.id);
      result.evicted.push(r.id);
    }
    for (const room of rooms) applyRoom(store, ws, room, result);
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
      store.run('DELETE FROM notice WHERE ws = ?', ws);
      store.deleteWsEvents(ws);
      store.clearPass(ws);
      store.updateWs(ws, { cursor: null, passing: 1, generation: workspace.generation });
      store.markLookup(ws, row.generation);
    } else if (row.keyId && row.keyId !== workspace.keyId) {
      keyChanged = true;
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
  for (const [room, ids] of Object.entries(result.removed)) {
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
// anything was replaced, after a directory event.
async function directory(svc, ws) {
  const store = svc.store;
  const epoch = svc.epoch;
  let changed = false;
  const load = async (flag, fetch) => {
    const row = store.getWs(ws);
    if (!row || !row[flag]) return;
    try {
      await fetch(row);
      changed = true;
    } catch (err) {
      if (svc.isStale(err)) throw err;
      if (err && err.code === 'not_found' && err.scope === 'workspace') throw err;
    }
  };
  // The caller's own row carries a role or name someone else changed, which GET / would only bring at the next restore
  // check: the ws row takes them, so the workspace summary says the same as the member list. A role across the guest
  // line also marks the channels stale, as the server bumps only the members for a role change: a promoted guest has no
  // channel directory yet and a demoted member one too many. The channels load below reads the row again.
  let meChanged = false;
  await load('membersStale', async () => {
    const res = wire.checkMembers(await svc.call(ws, 'GET', '/members'));
    svc.guard(epoch);
    store.tx(() => {
      const row = store.getWs(ws);
      if (!row) return;
      store.replaceMembers(ws, res.members, res.more);
      const mine = row.me && res.members.find((m) => m.id === row.me);
      if (mine && (mine.role !== row.role || mine.name !== row.myName)) {
        const crossed = (row.role === 'guest') !== (mine.role === 'guest');
        store.updateWs(ws, { role: mine.role, myName: mine.name, ...(crossed ? { channelsStale: 1 } : {}) });
        meChanged = true;
      }
    });
  });
  await load('channelsStale', async (row) => {
    if (row.role === 'guest') {
      store.replaceChannels(ws, []);
      return;
    }
    const res = wire.checkChannels(await svc.call(ws, 'GET', '/channels'));
    svc.guard(epoch);
    if (store.getWs(ws)) store.replaceChannels(ws, res.channels);
  });
  await load('blocksStale', async () => {
    let res;
    try {
      res = wire.checkBlocks(await svc.call(ws, 'GET', '/blocks'));
    } catch (err) {
      if (!(err && err.code === 'not_found' && !err.scope)) throw err;
      res = { blocks: [] };
    }
    svc.guard(epoch);
    if (store.getWs(ws)) store.replaceBlocks(ws, res.blocks);
  });
  if (changed && store.getWs(ws)) svc.emitChat({ kind: 'directory', ws });
  if (meChanged) svc.stateChanged();
  return changed;
}

// One run for one workspace. Returns { changed, pass } when it got through, { more: true } when it stopped after
// PAGES_PER_RUN pages, or { skipped | quarantined | gone | upgrade: true }. Throws a ChatError for the service's
// backoff, or the service's stale marker when the session ended meanwhile.
async function runSync(svc, ws) {
  const store = svc.store;
  const epoch = svc.epoch;
  const runner = svc.runner(ws);
  let row = store.getWs(ws);
  if (!row || row.state !== 'ok' || !svc.live()) return { skipped: true };
  if (!row.generation || runner.detailsDue) {
    runner.detailsDue = false;
    try {
      await svc.details(ws, { inRun: true });
    } catch (err) {
      if (!svc.isStale(err)) runner.detailsDue = true;
      throw err;
    }
    svc.guard(epoch);
  }
  const changed = new Set();
  let installed = false;
  let resets = 0;
  let pages = 0;
  for (;;) {
    row = store.getWs(ws);
    if (!row || row.state !== 'ok') return { skipped: true, changed: [...changed] };
    if (pages >= svc.timing.pagesPerRun) return { more: true, changed: [...changed] };
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
    let page;
    try {
      page = wire.checkChanges(await svc.call(ws, 'GET', `/changes?${query}`));
    } catch (err) {
      if (svc.isStale(err)) throw err;
      const code = err && err.code;
      if (code === 'reset_required') {
        if (resets > 0) throw new ChatError('server', { status: 410 });
        resets += 1;
        reset(svc, ws);
        await hook(svc, () => svc.notifier.onReset(ws));
        await hook(svc, () => svc.history.onReset(ws));
        await svc.details(ws, { inRun: true });
        svc.guard(epoch);
        continue;
      }
      if (code === 'history_regressed') {
        quarantine(svc, ws);
        await hook(svc, () => svc.history.onReset(ws));
        return { quarantined: true };
      }
      // The service's call() ran the removal path, or parked the workspace for an update.
      if (code === 'not_found' && err.scope === 'workspace') return { gone: true };
      if (code === 'upgrade_required') return { upgrade: true };
      throw err;
    }
    svc.guard(epoch);
    if (!store.getWs(ws)) return { gone: true };
    // Only while the row is where the request started from; see atPosition().
    const expect = position(row);
    let result;
    if (!row.passing) result = applyPage(svc, ws, page, { active, expect });
    else if (page.more) result = applyPassPage(svc, ws, page, { expect });
    else result = installPass(svc, ws, page, { expect });
    pages += 1;
    // Reset meanwhile: the page is dropped, and the loop goes on from where the row stands now, a pass from the start.
    if (!result) continue;
    for (const id of result.changed) changed.add(id);
    if (result.pass) installed = true;
    await afterPage(svc, ws, result);
    svc.guard(epoch);
    if (!page.more) break;
  }
  if (installed) svc.stateChanged();
  await directory(svc, ws);
  svc.guard(epoch);
  await hook(svc, () => svc.history.afterRun(ws));
  await hook(svc, () => svc.notifier.afterRun(ws, [...changed], { pass: installed }));
  svc.guard(epoch);
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
