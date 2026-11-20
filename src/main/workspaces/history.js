'use strict';

// The open room, its history, threads, reads, drafts and mute (team chat contract 3.7, 3.9, 3.13, 4.3 and 4.4). The
// service (index.js) and the sync engine (sync.js) call the hooks; ipc.js turns METHODS into the chat* IPC methods,
// each as (svc, ...checkedArgs) => result.
//
// History. Each room caches one contiguous range [lo, hi] of its events, or nothing. A page from GET /events joins the
// range only when it adjoins or overlaps it, which the request's own bound decides (after=hi, before=lo); anything else
// is answered to the renderer without being kept. An open room's range always ends at head once it has loaded, so the
// reply counts of every root it shows are complete:
// - opening answers at once from the cache, then catches up: an uncached room or one more than FORWARD_GAP_MAX behind
//   loads the newest page (and the renderer replaces what it shows), a room a little behind pages forward to head;
// - opening at a seq (a notification) catches up, then pages back until the cache reaches it, at most BACKFILL_PAGES;
// - older messages come from the cache while it has them, else from the server, prepended;
// - a thread finds its root in the cache, else pages back up to BACKFILL_PAGES per call.
// Every page is applied in one transaction that first checks that the room still has the grant, and the workspace the
// cache revision (svc.revision, contract 3.6), the request started under: a page from before a leave and rejoin, or
// from before a reset, Start over, restore, new key or park, is dropped. Tombstoned messages are stored removed, each
// page raises head and applies floor, and the room keeps at most ROOM_CACHE_MAX events.
//
// Detached events. Pages the cache couldn't take still answer the renderer: a thread keeps them in threadMemory, and
// opening at a seq returns them in its view. They honor the room's floor and the tombstones whenever they are returned,
// and a removal learned later (onRemoved) takes their text out of memory and tells the renderer.
//
// Reads. The renderer reports the highest message it showed (chatRead) or asks for head (chatMarkRead). The room's
// readLocal rises at once, on disk, and its badges are recounted from the cache; POST /read follows at most once per
// READ_FLUSH per room, and a failed one goes again at the end of the next run.
//
// What the service gives this module: svc.store, svc.epoch, svc.call(ws, method, route, body), svc.guard(epoch),
// svc.emitChat(payload), svc.roomsChanged(ws, ids), svc.setActive({ ws, room } | null), svc.active, svc.timing,
// svc.timers, svc.now(), svc.isStale(err), svc.hookFailed(err), svc.outbox and svc.notifier.
const wire = require('./wire');
const { recount } = require('./sync');
const { ROOM_CACHE_MAX } = require('./store');

const { ChatError } = wire;

const keyOf = (ws, room) => `${ws}\n${room}`;
// How many events before the one a notification points at the opened view shows.
const AROUND = 50;
// The most events a thread keeps in memory from pages the cache couldn't take.
const THREAD_EXTRA_MAX = 5000;

// A checked event from a page that isn't cached, in the renderer's shape. removed: tombstoned here.
function detached(e, removed) {
  const message = e.kind === 'message.posted';
  const gone = message && (e.redacted === true || removed);
  const data = {};
  for (const key of ['name', 'visibility', 'member', 'members', 'target', 'targetSeq']) if (e[key] !== undefined) data[key] = e[key];
  return {
    seq: e.seq,
    id: e.id,
    kind: e.kind,
    actor: e.actor,
    at: e.at,
    root: e.root ?? null,
    text: message && !gone ? e.text : null,
    mentions: message && !gone ? e.mentions || [] : [],
    redacted: Boolean(gone),
    data
  };
}

function bySeq(a, b) {
  return a.seq - b.seq;
}

// The badges of a room read to `to` (contract 3.9): none at head; counted from the cache when it covers everything
// after it; else the server's numbers stand until the next page.
function badgesAt(store, ws, c, to) {
  const r = store.getRoom(ws, c);
  if (!r) return;
  if (to >= r.head) {
    if (r.unread || r.mentions) store.setRoomFields(ws, c, { unread: 0, mentions: 0 });
    return;
  }
  const me = store.getWs(ws)?.me;
  const covers = r.lo !== null && r.hi !== null && r.hi >= r.head && r.lo <= to + 1;
  if (covers && me) store.setRoomFields(ws, c, store.countBadges(ws, c, to, me));
}

// A detached event (one held outside SQLite) as it stands now: null below the room's floor, a removed message without
// its text once it has a tombstone or its ID is in removed, else unchanged.
function current(e, floor, gone) {
  if (e.seq < floor) return null;
  if (e.kind !== 'message.posted' || e.redacted || !gone(e.id)) return e;
  return { ...e, text: null, mentions: [], redacted: true };
}

class History {
  static METHODS = {
    chatOpen: (svc, ws, c, opts) => svc.history.openRoom(ws, c, opts),
    chatClose: (svc) => svc.history.closeRoom(),
    chatOlder: (svc, ws, c, before) => svc.history.older(ws, c, before),
    chatThread: (svc, ws, c, root) => svc.history.thread(ws, c, root),
    chatRoomMembers: (svc, ws, c) => svc.history.roomMembers(ws, c),
    chatRead: (svc, ws, c, seq) => svc.history.read(ws, c, seq),
    chatMarkRead: (svc, ws, c) => svc.history.markRead(ws, c),
    chatMute: (svc, ws, c, muted) => svc.history.mute(ws, c, muted),
    chatSaveDraft: (svc, ws, c, root, draft) => svc.history.saveDraft(ws, c, root, draft),
    chatDraft: (svc, ws, c, root) => svc.history.storedDraft(ws, c, root)
  };

  constructor(svc) {
    this.svc = svc;
    // The room on screen as this module knows it: { ws, room, epoch, quiet, lo }. quiet holds back events pushes while
    // chatOpen builds its answer, which then holds everything; lo is the cache's lo when the renderer last heard.
    this.open = null;
    // Catch-ups in flight, per room: { promise, again }.
    this.loads = new Map();
    // Read flushes per room: { epoch, lastStart, timer, inFlight, again }.
    this.flushes = new Map();
    // The thread last asked for: { key, low, extra: Map seq -> Event } for pages the cache couldn't keep.
    this.threadMemory = null;
    this.closed = false;
  }

  // ---- plumbing ----

  get timing() {
    return this.svc.timing;
  }

  get cacheMax() {
    return this.timing.roomCacheMax || ROOM_CACHE_MAX;
  }

  store() {
    if (!this.svc.store) throw new ChatError('signed_out');
    return this.svc.store;
  }

  wsRow(ws) {
    const row = this.store().getWs(ws);
    if (!row) throw new ChatError('not_found', { scope: 'workspace' });
    return row;
  }

  room(ws, c) {
    this.wsRow(ws);
    const row = this.store().getRoom(ws, c);
    if (!row) throw new ChatError('not_found', { scope: 'conversation' });
    return row;
  }

  // Requests to the server wait while the workspace is stopped or parked.
  requireOk(ws) {
    const row = this.wsRow(ws);
    if (row.state === 'quarantined') throw new ChatError('paused');
    if (row.state === 'upgrade') throw new ChatError('upgrade_required');
    return row;
  }

  isOk(ws) {
    const row = this.svc.store && this.svc.store.getWs(ws);
    return Boolean(row && row.state === 'ok' && this.svc.live());
  }

  // Whether the room is the one on screen in this session.
  isOpen(ws, room) {
    const o = this.open;
    const a = this.svc.active;
    return Boolean(o && o.epoch === this.svc.epoch && o.ws === ws && o.room === room && a && a.ws === ws && a.room === room);
  }

  forget(fn) {
    for (const key of [...this.flushes.keys()]) {
      if (!fn(key)) continue;
      const f = this.flushes.get(key);
      if (f.timer) this.svc.timers.clearTimeout(f.timer);
      this.flushes.delete(key);
    }
  }

  close() {
    this.closed = true;
    this.forget(() => true);
    this.open = null;
    this.threadMemory = null;
  }

  // ---- pages ----

  async fetchEvents(ws, c, query) {
    return wire.checkEvents(await this.svc.call(ws, 'GET', `/conversations/${c}/events?${query}`));
  }

  // One page of GET /events, in one transaction. kind 'after' with bound X for ?after=X, 'before' with bound Y for
  // ?before=Y; newest: the page that loads an uncached room, which may start its range. Returns null when the room went,
  // its grant moved since grant or the workspace's cache revision since rev (the page is dropped), else { events,
  // joined, removed, redacted }: events as the renderer gets them, joined whether the cache took them, removed the IDs
  // whose alerts go (floor, redactions), redacted the cached messages that lost their text.
  applyPage(ws, c, page, { grant, rev, kind, bound, newest = false }) {
    const store = this.store();
    const out = store.tx(() => {
      if (this.svc.revision(ws) !== rev) return null;
      let r = store.getRoom(ws, c);
      if (!r || r.grantId !== grant) return null;
      const removed = [];
      const fields = {};
      if (page.head > r.head) fields.head = page.head;
      if (page.floor > r.floor) fields.floor = page.floor;
      if (Object.keys(fields).length) store.setRoomFields(ws, c, fields);
      if (fields.floor !== undefined) removed.push(...store.applyFloor(ws, c, fields.floor));
      r = store.getRoom(ws, c);
      const events = page.events.filter((e) => e.seq >= r.floor);
      // What the request covers: everything after X up to its last event, or everything before Y down to its first.
      const first = events.length ? events[0].seq : null;
      const last = events.length ? events[events.length - 1].seq : null;
      const low = kind === 'after' ? bound + 1 : first ?? bound;
      const high = kind === 'after' ? last ?? bound : bound - 1;
      let joined;
      if (r.lo === null || r.hi === null) joined = newest;
      else joined = low <= r.hi + 1 && high >= r.lo - 1;
      if (!joined && newest && r.lo !== null) {
        // The cache moved away from head meanwhile: the newest page replaces it.
        store.dropRoomCache(ws, c);
        joined = true;
      }
      // Messages a message.redacted in the page removes, which were cached with their text.
      const redacted = [];
      for (const e of events) {
        if (e.kind !== 'message.redacted' || !e.target) continue;
        const target = store.eventById(ws, e.target);
        if (target && target.room === c && !target.redacted) redacted.push(e.target);
      }
      if (joined && events.length) {
        store.writeEvents(ws, c, events);
        store.run(
          'UPDATE room SET lo = MIN(COALESCE(lo, ?), ?), hi = MAX(COALESCE(hi, ?), ?) WHERE ws = ? AND id = ?',
          first,
          first,
          last,
          last,
          ws,
          c
        );
        store.trimRoom(ws, c, this.cacheMax);
      } else if (events.length) {
        // Not kept, but a removal it carries still counts: its target is tombstoned and loses its text if cached.
        const targets = events.filter((e) => e.kind === 'message.redacted' && e.target).map((e) => e.target);
        if (targets.length) {
          store.addTombstones(ws, targets);
          store.redact(ws, targets);
        }
      }
      recount(store, ws, c);
      const shown = events.map((e) => {
        const row = joined ? store.eventAt(ws, c, e.seq) : null;
        return row && row.id === e.id ? wire.toRenderer(row) : detached(e, store.hasTombstone(ws, e.id));
      });
      return { events: shown, joined, removed: [...removed, ...redacted], redacted };
    });
    if (out) this.afterApply(ws, c, out);
    return out;
  }

  afterApply(ws, c, out) {
    const svc = this.svc;
    svc.roomsChanged(ws, [c]);
    if (out.redacted.length) svc.emitChat({ kind: 'redacted', ws, conversation: c, ids: out.redacted });
    if (out.removed.length) {
      svc.hook(() => this.onRemoved(ws, c, out.removed));
      svc.hook(() => svc.notifier.onRemoved(ws, c, out.removed));
    }
  }

  // An events push for the open room (contract 4.5): events that arrived, with the cache's range after them. replace
  // when the renderer must drop what it shows: the cache was dropped and reloaded.
  push(ws, c, events, { replace = false } = {}) {
    if (!this.isOpen(ws, c) || this.open.quiet) return;
    const r = this.svc.store && this.svc.store.getRoom(ws, c);
    if (!r) return;
    if (!events.length && !replace) return;
    if (replace) this.open.detached = null;
    this.heldByRenderer(this.open, events);
    this.open.lo = r.lo;
    this.svc.emitChat({ kind: 'events', ws, conversation: c, events, lo: r.lo, hi: r.hi, head: r.head, floor: r.floor, replace });
  }

  // ---- catching up ----

  // Brings the room's range up to head (contract 3.7), single flight per room. Resolves when it is there or can't get
  // further now; throws ChatError when the server can't be reached, and the stale marker when the session ended.
  catchUp(ws, c) {
    const key = keyOf(ws, c);
    const running = this.loads.get(key);
    if (running && running.epoch === this.svc.epoch) {
      running.again = true;
      return running.promise;
    }
    const entry = { epoch: this.svc.epoch, again: false, promise: null };
    entry.promise = (async () => {
      try {
        do {
          entry.again = false;
          await this.catchUpOnce(ws, c);
        } while (entry.again);
      } finally {
        if (this.loads.get(key) === entry) this.loads.delete(key);
      }
    })();
    this.loads.set(key, entry);
    return entry.promise;
  }

  // The same, for the background: failures wait for the next run, which tries again.
  catchUpLater(ws, c) {
    this.catchUp(ws, c).catch((err) => {
      if (!this.svc.isStale(err) && !(err && err.code)) this.svc.hookFailed(err);
    });
  }

  async catchUpOnce(ws, c) {
    const svc = this.svc;
    const epoch = svc.epoch;
    const t = this.timing;
    const rounds = Math.ceil(t.forwardGapMax / t.eventsPage) + 4;
    for (let i = 0; i < rounds; i++) {
      svc.guard(epoch);
      if (!this.isOk(ws)) return;
      const r = svc.store.getRoom(ws, c);
      if (!r) return;
      if (r.hi !== null && r.hi >= r.head) return;
      const rev = svc.revision(ws);
      if (r.hi === null || r.head - r.hi > t.forwardGapMax) {
        // Nothing cached, or too far behind to page forward: the newest page, and the renderer starts over from it. A
        // cache the page can't join goes in the page's own transaction, so a failed request leaves it as it was.
        const bound = r.head + 1;
        const page = await this.fetchEvents(ws, c, `before=${bound}&limit=${t.eventsNewest}`);
        svc.guard(epoch);
        const out = this.applyPage(ws, c, page, { grant: r.grantId, rev, kind: 'before', bound, newest: true });
        if (!out) continue;
        this.push(ws, c, out.events, { replace: true });
        if (!page.events.length) return;
      } else {
        const page = await this.fetchEvents(ws, c, `after=${r.hi}&limit=${t.eventsPage}`);
        svc.guard(epoch);
        const out = this.applyPage(ws, c, page, { grant: r.grantId, rev, kind: 'after', bound: r.hi });
        if (!out) continue;
        this.push(ws, c, out.events);
        if (!page.events.length) return;
      }
    }
  }

  // Pages back from before (contract 3.7 "Opening at a seq", "Threads"): at most pages pages of EVENTS_PAGE, until
  // done(low) or the floor. Pages that adjoin the cache join it; the others only come back in extra. Returns { low,
  // floor, dropped }: the lowest seq covered, whether nothing older exists, and whether a page was dropped for a moved
  // grant.
  async pageBack(ws, c, before, pages, done, extra) {
    const svc = this.svc;
    const epoch = svc.epoch;
    let bound = before;
    for (let i = 0; i < pages; i++) {
      const r = svc.store.getRoom(ws, c);
      if (!r) return { low: bound, floor: false, dropped: true };
      if (bound <= r.floor || bound <= 1) return { low: bound, floor: true, dropped: false };
      const rev = svc.revision(ws);
      const page = await this.fetchEvents(ws, c, `before=${bound}&limit=${this.timing.eventsPage}`);
      svc.guard(epoch);
      const out = this.applyPage(ws, c, page, { grant: r.grantId, rev, kind: 'before', bound });
      if (!out) return { low: bound, floor: false, dropped: true };
      // What the cache took is read from there; the rest (a page that didn't adjoin it, or one a trim took again).
      for (const e of out.events) {
        const row = e.seq < bound && svc.store.eventAt(ws, c, e.seq);
        if (e.seq < bound && !(row && row.id === e.id)) extra.set(e.seq, e);
      }
      const floor = Math.max(page.floor, r.floor);
      if (!out.events.length || out.events[0].seq <= floor) return { low: out.events.length ? out.events[0].seq : bound, floor: true, dropped: false };
      bound = out.events[0].seq;
      if (done(bound)) break;
    }
    return { low: bound, floor: false, dropped: false };
  }

  // ---- the renderer's views ----

  pending(ws, c) {
    const outbox = this.svc.outbox;
    if (outbox && typeof outbox.pendingFor === 'function') return outbox.pendingFor(ws, c);
    let blocked = false;
    return this.store()
      .outboxForRoom(ws, c)
      .map((row) => {
        const out = wire.toPending(row, { waiting: blocked });
        if (row.state === 'held' || row.state === 'failed') blocked = true;
        return out;
      });
  }

  draft(ws, c, root) {
    const d = this.store().getDraft(ws, c, root);
    return d ? { text: d.text, mentions: d.mentions } : null;
  }

  // RoomView (contract 4.6). Without at: the newest EVENTS_PAGE cached events. With at: from AROUND events before it
  // through hi, as the renderer has no way to ask for newer pages; extra adds events of pages the cache couldn't keep.
  // When at wasn't reached, the view opens at another event instead (complete: false): the oldest loaded one when an
  // online backfill used up its pages (ranOut, contract 3.7), else the newest cached one, as the requests didn't go
  // through (offline, refused, or a workspace that isn't ok) and the cache has nothing nearer to show.
  roomView(ws, c, { at = null, reached = true, ranOut = false, readAtOpen, extra = null }) {
    const store = this.store();
    const r = store.getRoom(ws, c);
    if (!r) throw new ChatError('not_found', { scope: 'conversation' });
    let events = [];
    let target = at;
    if (at === null) {
      if (r.hi !== null) events = store.eventsBefore(ws, c, r.hi + 1, this.timing.eventsPage).map(wire.toRenderer);
    } else {
      const cached = r.lo !== null ? store.eventsFrom(ws, c, r.lo, this.cacheMax).map(wire.toRenderer) : [];
      const merged = new Map();
      if (extra) {
        this.scrub(ws, c, extra);
        for (const [seq, e] of extra) merged.set(seq, e);
      }
      for (const e of cached) merged.set(e.seq, e);
      const all = [...merged.values()].sort(bySeq);
      if (!reached) target = ranOut && all.length ? all[0].seq : r.hi;
      if (target !== null) {
        let index = all.findIndex((e) => e.seq >= target);
        if (index < 0) index = all.length;
        events = all.slice(Math.max(0, index - (this.timing.around || AROUND)));
      }
    }
    const lo = events.length ? events[0].seq : null;
    return {
      room: wire.toRoom(r),
      events,
      lo,
      hi: r.hi,
      hasOlder: lo !== null && lo > r.floor,
      complete: at === null ? true : reached,
      readAtOpen,
      at: target,
      pending: this.pending(ws, c),
      draft: this.draft(ws, c, null)
    };
  }

  // chatOpen: the room becomes the open one, for the feed's inline events and for alerts. Without at, the answer comes
  // from the cache at once and the catch-up follows as events pushes. With at, the answer waits for the catch-up and
  // the backfill to at, unless the cache already holds it up to head.
  async openRoom(ws, c, opts = {}) {
    const svc = this.svc;
    const r = this.room(ws, c);
    const epoch = svc.epoch;
    const readAtOpen = r.readLocal;
    const open = { ws, room: c, epoch, quiet: false, lo: r.lo };
    this.open = open;
    svc.setActive({ ws, room: c });
    if (opts.at === undefined || opts.at === null) {
      const view = this.roomView(ws, c, { readAtOpen });
      open.lo = r.lo;
      if (this.isOk(ws)) this.catchUpLater(ws, c);
      return view;
    }
    const at = Math.min(opts.at, Math.max(r.head, 1));
    if (r.lo !== null && r.lo <= at && r.hi >= r.head) {
      const view = this.roomView(ws, c, { at, readAtOpen });
      this.catchUpLater(ws, c);
      return view;
    }
    const rev = svc.revision(ws);
    const extra = new Map();
    let reached = false;
    // The backfill went through and stopped short of at: its pages ran out (or the floor came first).
    let ranOut = false;
    open.quiet = true;
    try {
      if (this.isOk(ws)) {
        await this.catchUp(ws, c);
        const now = svc.store.getRoom(ws, c);
        if (now && now.lo !== null && now.lo > at) {
          const back = await this.pageBack(ws, c, now.lo, this.timing.backfillPages, (low) => low <= at, extra);
          reached = back.low <= at;
          ranOut = !reached && !back.dropped;
        }
      }
    } catch (err) {
      if (svc.isStale(err)) throw err;
      // Offline or refused: the room opens with what the cache has.
    } finally {
      open.quiet = false;
    }
    svc.guard(epoch);
    // The cache was reset meanwhile: the pages loaded before that belong to the cache as it stood, with removals it
    // can no longer list, and only the cache as it is now opens.
    if (svc.revision(ws) !== rev) {
      extra.clear();
      reached = false;
      ranOut = false;
    }
    // Whether the requests went through or not, a cache that holds at reaches it.
    const now = svc.store.getRoom(ws, c);
    if (now && now.lo !== null && now.lo <= at && at <= now.hi) reached = true;
    const view = this.roomView(ws, c, { at, reached, ranOut, readAtOpen, extra });
    open.lo = svc.store.getRoom(ws, c)?.lo ?? null;
    this.heldByRenderer(open, view.events);
    return view;
  }

  // The renderer now shows events of the open room that aren't cached: a removal learned later tells it by ID
  // (onRemoved), as the store's redact only knows cached ones.
  heldByRenderer(open, events) {
    const store = this.svc.store;
    for (const e of events) {
      if (e.kind !== 'message.posted' || e.redacted) continue;
      const row = store.eventAt(open.ws, open.room, e.seq);
      if (row && row.id === e.id) continue;
      (open.detached ||= new Map()).set(e.id, e.seq);
    }
  }

  // Detached events of room c (a Map seq -> event) as they stand now (see current): those below the floor go, and
  // removed messages lose their text. ids: more message IDs known to be removed. Returns the IDs that lost their text.
  scrub(ws, c, map, ids = null) {
    const store = this.svc.store;
    const r = store && store.getRoom(ws, c);
    const floor = r ? r.floor : Infinity;
    const gone = (id) => Boolean(ids && ids.has(id)) || store.hasTombstone(ws, id);
    const lost = [];
    for (const [seq, e] of [...map]) {
      const now = current(e, floor, gone);
      if (now === e) continue;
      if (now) {
        map.set(seq, now);
        lost.push(e.id);
      } else map.delete(seq);
    }
    return lost;
  }

  // chatClose: no room is open; the feed stops asking for inline events.
  closeRoom() {
    this.open = null;
    this.svc.setActive(null);
    return true;
  }

  // chatOlder: the events before `before`, from the cache while it has them, else from the server (contract 3.7
  // "Older messages"). hasOlder is false at the floor or past the oldest event.
  async older(ws, c, before) {
    const svc = this.svc;
    const r = this.room(ws, c);
    const store = this.store();
    if (r.lo !== null && before > r.lo && before <= r.hi + 1) {
      const events = store.eventsBefore(ws, c, before, this.timing.eventsNewest).map(wire.toRenderer);
      const lo = events[0].seq;
      return { events, lo, hasOlder: lo > r.floor };
    }
    if (before <= r.floor) return { events: [], lo: before, hasOlder: false };
    this.requireOk(ws);
    const epoch = svc.epoch;
    const rev = svc.revision(ws);
    // The grant or the cache revision moved meanwhile: the page is dropped, and the renderer gets the room again
    // through an events push. An error that comes after a reset is dropped the same way.
    const dropped = { events: [], lo: before, hasOlder: true };
    let page;
    try {
      page = await this.fetchEvents(ws, c, `before=${before}&limit=${this.timing.eventsNewest}`);
    } catch (err) {
      svc.guard(epoch);
      if (svc.revision(ws) !== rev) return dropped;
      throw err;
    }
    svc.guard(epoch);
    const out = this.applyPage(ws, c, page, { grant: r.grantId, rev, kind: 'before', bound: before });
    if (!out) return dropped;
    const events = out.events.filter((e) => e.seq < before);
    if (this.isOpen(ws, c)) this.heldByRenderer(this.open, events);
    const floor = Math.max(page.floor, r.floor);
    const lo = events.length ? events[0].seq : before;
    return { events, lo, hasOlder: events.length > 0 && lo > floor };
  }

  // chatThread (contract 3.7 "Threads", 3.13): the root from the cache, else the range pages back for it, at most
  // BACKFILL_PAGES per call. complete is false while the root isn't reached, and each further call pages further;
  // expired when the root is older than the floor.
  async thread(ws, c, rootId) {
    const svc = this.svc;
    const epoch = svc.epoch;
    this.room(ws, c);
    const store = this.store();
    const key = `${ws}\n${c}\n${rootId}`;
    // rev: the cache revision the memory's pages were loaded under. A reset since then leaves them out.
    const fresh = () => ({ key, epoch, rev: svc.revision(ws), low: null, extra: new Map(), floor: false, cacheLo: undefined });
    const m = this.threadMemory;
    if (!m || m.key !== key || m.epoch !== epoch || m.rev !== svc.revision(ws)) this.threadMemory = fresh();
    let memory = this.threadMemory;
    // The memory's events as they stand now (scrub), and the root expired once the floor passed what was searched.
    const settle = () => {
      this.scrub(ws, c, memory.extra);
      const r = store.getRoom(ws, c);
      if (r && memory.low !== null && memory.low < r.floor) memory.floor = true;
    };
    const findRoot = () => {
      const row = store.eventById(ws, rootId);
      if (row && row.room === c) return wire.toRenderer(row);
      for (const e of memory.extra.values()) if (e.id === rootId) return e;
      return null;
    };
    settle();
    let root = findRoot();
    try {
      if (this.isOk(ws)) {
        const r = store.getRoom(ws, c);
        if (r && (r.hi === null || r.hi < r.head)) await this.catchUp(ws, c);
        svc.guard(epoch);
        const now = store.getRoom(ws, c);
        // The earlier call's pages went on from the cache's lo as it was then; a cache dropped or trimmed since breaks
        // that chain, and the search starts again from the cache. So does a reset of the cache.
        if (memory.rev !== svc.revision(ws) || (memory.cacheLo !== undefined && (!now || now.lo !== memory.cacheLo))) {
          memory = this.threadMemory = fresh();
        }
        root = findRoot();
        if (!root && !memory.floor && now && now.lo !== null) {
          const from = memory.low !== null ? Math.min(memory.low, now.lo) : now.lo;
          const back = await this.pageBack(ws, c, from, this.timing.backfillPages, () => Boolean(findRoot()), memory.extra);
          svc.guard(epoch);
          memory.low = back.low;
          memory.floor = back.floor;
          // Only the root and its replies matter once the pages pile up.
          if (memory.extra.size > THREAD_EXTRA_MAX) {
            for (const [seq, e] of memory.extra) if (e.id !== rootId && e.root !== rootId) memory.extra.delete(seq);
          }
        }
      }
    } catch (err) {
      if (svc.isStale(err)) throw err;
      // Offline: the thread shows what the cache has, as incomplete.
    }
    svc.guard(epoch);
    // A reset while the pages were on their way: what they found belongs to the cache as it stood.
    if (memory.rev !== svc.revision(ws)) memory = this.threadMemory = fresh();
    settle();
    root = findRoot();
    memory.cacheLo = store.getRoom(ws, c)?.lo ?? null;
    const replies = new Map();
    for (const e of memory.extra.values()) if (e.root === rootId && e.kind === 'message.posted') replies.set(e.seq, e);
    for (const row of store.replies(ws, c, rootId)) if (row.kind === 'message.posted') replies.set(row.seq, wire.toRenderer(row));
    return {
      root,
      replies: [...replies.values()].sort(bySeq),
      pending: this.pending(ws, c).filter((p) => p.root === rootId),
      complete: Boolean(root),
      expired: !root && memory.floor,
      draft: this.draft(ws, c, rootId)
    };
  }

  // chatRoomMembers: a channel's members as the server has them now; a DM's participants from the cache.
  async roomMembers(ws, c) {
    const r = this.room(ws, c);
    if (r.kind === 'dm') {
      let participants = [];
      try {
        participants = JSON.parse(r.participants || '[]');
      } catch (_) {
        participants = [];
      }
      return { members: (Array.isArray(participants) ? participants : []).map((member) => ({ member, role: 'member' })) };
    }
    this.requireOk(ws);
    return wire.checkRoomMembers(await this.svc.call(ws, 'GET', `/channels/${c}/members`));
  }

  // ---- reads (contract 3.9) ----

  // chatRead: the renderer showed messages up to seq. readLocal rises (never falls), the badges are recounted, and the
  // flush to the server follows.
  read(ws, c, seq) {
    const svc = this.svc;
    const store = this.store();
    this.room(ws, c);
    const moved = store.tx(() => {
      const r = store.getRoom(ws, c);
      const to = Math.min(seq, r.head);
      if (to <= r.readLocal) return false;
      store.setRoomFields(ws, c, { readLocal: to });
      recount(store, ws, c);
      return true;
    });
    if (!moved) return true;
    svc.roomsChanged(ws, [c]);
    svc.hook(() => svc.notifier.onRead(ws, c));
    this.scheduleFlush(ws, c);
    return true;
  }

  // chatMarkRead: everything up to head.
  markRead(ws, c) {
    const r = this.room(ws, c);
    return this.read(ws, c, r.head);
  }

  flushState(ws, c) {
    const key = keyOf(ws, c);
    let f = this.flushes.get(key);
    if (!f || f.epoch !== this.svc.epoch) {
      if (f && f.timer) this.svc.timers.clearTimeout(f.timer);
      f = { epoch: this.svc.epoch, lastStart: -Infinity, timer: null, inFlight: false, again: false };
      this.flushes.set(key, f);
    }
    return f;
  }

  // POST /read at most once per READ_FLUSH per room: now when the last one started long enough ago, else on a timer.
  scheduleFlush(ws, c) {
    if (this.closed) return;
    const f = this.flushState(ws, c);
    if (f.inFlight) {
      f.again = true;
      return;
    }
    const wait = f.lastStart + this.timing.readFlush - this.svc.now();
    if (wait <= 0) {
      if (f.timer) this.svc.timers.clearTimeout(f.timer);
      f.timer = null;
      this.flush(ws, c, f);
      return;
    }
    if (f.timer) return;
    f.timer = this.svc.timers.setTimeout(() => {
      f.timer = null;
      if (this.flushes.get(keyOf(ws, c)) === f) this.flush(ws, c, f);
    }, wait);
  }

  async flush(ws, c, f) {
    const svc = this.svc;
    if (this.closed || f.epoch !== svc.epoch || !svc.store || !this.isOk(ws)) return;
    const r = svc.store.getRoom(ws, c);
    if (!r || r.readLocal <= r.readSent) return;
    f.lastStart = svc.now();
    f.inFlight = true;
    f.again = false;
    const epoch = svc.epoch;
    const rev = svc.revision(ws);
    let ok = false;
    try {
      const answer = wire.checkRead(await svc.call(ws, 'POST', `/conversations/${c}/read`, { seq: r.readLocal }));
      svc.guard(epoch);
      const store = svc.store;
      const changed = store.tx(() => {
        // A reset (a restore forgets the read positions) since the request went: the next pass brings the server's.
        if (svc.revision(ws) !== rev) return false;
        const now = store.getRoom(ws, c);
        if (!now) return false;
        const readLocal = Math.max(now.readLocal, answer.read);
        store.setRoomFields(ws, c, {
          read: Math.max(now.read, answer.read),
          readSent: Math.max(now.readSent, answer.read),
          readLocal
        });
        // The server answers with the position it holds, which another device may have moved past what this one
        // reported: read to head leaves nothing unread, and a cache that covers the rest counts it again.
        if (readLocal > now.readLocal) badgesAt(store, ws, c, readLocal);
        else recount(store, ws, c);
        return true;
      });
      if (changed) {
        svc.roomsChanged(ws, [c]);
        svc.hook(() => svc.notifier.onRead(ws, c));
      }
      ok = true;
    } catch (err) {
      // The next run's end tries again; an ended session drops it.
      if (!svc.isStale(err) && !(err && err.code)) svc.hookFailed(err);
    } finally {
      f.inFlight = false;
      f.again = false;
    }
    // Reads that came while it was on its way go in the next flush, READ_FLUSH after this one started.
    if (!ok || f.epoch !== svc.epoch || !svc.store || this.flushes.get(keyOf(ws, c)) !== f) return;
    const after = svc.store.getRoom(ws, c);
    if (after && after.readLocal > after.readSent) this.scheduleFlush(ws, c);
  }

  // ---- mute and drafts ----

  // chatMute: per room and local to this device (contract 3.10).
  mute(ws, c, muted) {
    this.room(ws, c);
    const store = this.store();
    store.setRoomFields(ws, c, { muted: muted ? 1 : 0 });
    this.svc.roomsChanged(ws, [c]);
    return { room: wire.toRoom(store.getRoom(ws, c)) };
  }

  // chatSaveDraft: the main composer's draft (root null) or a thread's. null or empty text deletes it.
  saveDraft(ws, c, root, draft) {
    this.room(ws, c);
    const store = this.store();
    if (!draft || draft.text === '') store.deleteDraft(ws, c, root);
    else store.putDraft(ws, c, root, { text: draft.text, mentions: draft.mentions });
    return true;
  }

  // chatDraft: the kept draft of a room that isn't open, or null (desktop-ui "Main can take drafts over later with
  // chatDraft()"). Undo of Discard reads it to put the discarded text after it instead of over it.
  storedDraft(ws, c, root) {
    this.room(ws, c);
    return this.draft(ws, c, root);
  }

  // ---- hooks ----

  // The open room's part of a /changes query outside a pass: { active, roomAfter }, or null when no room of ws is
  // open. roomAfter is the room's hi when it has a cache.
  activeQuery(ws) {
    const o = this.open;
    if (!o || !this.isOpen(o.ws, o.room) || o.ws !== ws) return null;
    const r = this.svc.store && this.svc.store.getRoom(ws, o.room);
    if (!r) return null;
    return r.hi !== null ? { active: o.room, roomAfter: r.hi } : { active: o.room };
  }

  // After an incremental page's transaction, and after the one that installs a pass: the open room's inline events go
  // to the renderer, a room whose cache was dropped is shown again from scratch, and one that is behind catches up.
  afterPage(ws, result) {
    const o = this.open;
    if (!o || o.ws !== ws || !this.isOpen(ws, o.room)) return;
    const c = o.room;
    const store = this.svc.store;
    const r = store && store.getRoom(ws, c);
    if (!r) return;
    const dropped = this.cacheDropped(ws, c, r);
    if (dropped) {
      this.showAgain(ws, c);
      return;
    }
    if (result.appended && result.appended.room === c) this.push(ws, c, result.appended.events);
    if (result.pass || result.changed.includes(c)) this.followUp(ws, c);
  }

  // Whether the cache lost the range the renderer was shown: emptied, or started again higher up (a new grant whose
  // inline events refilled it). A trim at ROOM_CACHE_MAX also raises lo, but keeps what the renderer has valid.
  cacheDropped(ws, c, r) {
    const o = this.open;
    if (o.lo === null || o.lo === undefined) return false;
    if (r.lo === null) return true;
    if (r.lo <= o.lo) return false;
    const count = this.svc.store.get('SELECT COUNT(*) AS n FROM event WHERE ws = ? AND room = ?', ws, c).n;
    return count < this.cacheMax;
  }

  // The renderer drops what it shows: the cache as it is now, with replace, then a catch-up when it is behind or empty.
  showAgain(ws, c) {
    const r = this.svc.store.getRoom(ws, c);
    if (!r) return;
    if (r.hi !== null) {
      const events = this.svc.store.eventsBefore(ws, c, r.hi + 1, this.timing.eventsPage).map(wire.toRenderer);
      this.push(ws, c, events, { replace: true });
    } else {
      this.push(ws, c, [], { replace: true });
    }
    this.followUp(ws, c);
  }

  followUp(ws, c) {
    const r = this.svc.store && this.svc.store.getRoom(ws, c);
    if (!r || !this.isOk(ws)) return;
    if (r.hi === null || r.hi < r.head) this.catchUpLater(ws, c);
  }

  // At the end of a run: reads this device made that the server hasn't confirmed go out (each room within its 5 s
  // rule), and the open room catches up if an earlier attempt failed.
  afterRun(ws) {
    const svc = this.svc;
    if (!svc.store || !this.isOk(ws)) return;
    const due = svc.store.all('SELECT id FROM room WHERE ws = ? AND readLocal > readSent', ws);
    for (const { id } of due) this.scheduleFlush(ws, id);
    const o = this.open;
    if (o && o.ws === ws && this.isOpen(ws, o.room)) this.followUp(ws, o.room);
  }

  // After the transaction of a 410, a quarantine, a restore, a new key or Start over. Each deleted the workspace's
  // cached events, so an open room that showed messages shows again from scratch; one that showed none catches up.
  onReset(ws) {
    const o = this.open;
    if (this.threadMemory && this.threadMemory.key.startsWith(`${ws}\n`)) this.threadMemory = null;
    if (!o || o.ws !== ws || !this.isOpen(ws, o.room)) return;
    o.detached = null;
    const r = this.svc.store && this.svc.store.getRoom(ws, o.room);
    if (!r) return;
    if (this.cacheDropped(ws, o.room, r)) this.showAgain(ws, o.room);
    else this.followUp(ws, o.room);
  }

  // Messages of the room were removed (removed, removedMore, a floor, a redaction in a page, this device's Remove): the
  // detached events in memory lose their text or, below the floor, go, and the renderer hears of the ones it shows
  // that the store's redacted didn't cover. A cache dropped for removedMore takes the thread's memory with it, as it
  // can't say which of its events went.
  onRemoved(ws, room, ids) {
    const store = this.svc.store;
    if (!store) return;
    const removed = new Set(Array.isArray(ids) ? ids : []);
    const r = store.getRoom(ws, room);
    const lost = new Set();
    const m = this.threadMemory;
    if (m && m.key.startsWith(`${ws}\n${room}\n`)) {
      if (m.cacheLo !== undefined && (!r || (r.lo === null && m.cacheLo !== null))) this.threadMemory = null;
      else for (const id of this.scrub(ws, room, m.extra, removed)) lost.add(id);
    }
    const o = this.open;
    if (o && o.ws === ws && o.room === room && o.detached) {
      for (const [id, seq] of [...o.detached]) {
        if (r && seq < r.floor) o.detached.delete(id);
        else if (removed.has(id) || store.hasTombstone(ws, id)) {
          o.detached.delete(id);
          if (r) lost.add(id);
        }
      }
    }
    if (lost.size && this.isOpen(ws, room)) this.svc.emitChat({ kind: 'redacted', ws, conversation: room, ids: [...lost] });
  }

  // After the transaction that deleted an evicted room.
  onEvicted(ws, room) {
    const key = keyOf(ws, room);
    this.forget((k) => k === key);
    if (this.threadMemory && this.threadMemory.key.startsWith(`${key}\n`)) this.threadMemory = null;
    const o = this.open;
    if (o && o.ws === ws && o.room === room) {
      this.open = null;
      const a = this.svc.active;
      if (a && a.ws === ws && a.room === room) this.svc.setActive(null);
    }
  }

  // After the transaction that deleted the workspace.
  onWorkspaceGone(ws) {
    this.forget((k) => k.startsWith(`${ws}\n`));
    if (this.threadMemory && this.threadMemory.key.startsWith(`${ws}\n`)) this.threadMemory = null;
    if (this.open && this.open.ws === ws) this.open = null;
  }
}

module.exports = { History };
