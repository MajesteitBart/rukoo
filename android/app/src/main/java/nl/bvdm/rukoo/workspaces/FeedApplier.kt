package nl.bvdm.rukoo.workspaces

import kotlin.math.roundToLong
import nl.bvdm.rukoo.core.Clock
import nl.bvdm.rukoo.core.RukooJson

/**
 * What a feed page, a pass install or a reset did to the cache, for the service's hooks: alerts take back what was
 * removed, an evicted room's alert and socket go, and the outbox hears of dropped sends.
 *
 * - [changed]: rooms whose row changed.
 * - [evicted]: rooms deleted, with [droppedSends] the unsent messages that went with each.
 * - [appendedRoom] and [appended]: the open room's inline events as stored.
 * - [removed]: per room, the message IDs whose alerts go (`removed`, `removedMore`, a floor, a reset).
 * - [redacted]: per room, cached messages that lost their text.
 * - [cacheDropped]: rooms whose cached events went whole, by a new grant (left and joined again) or `removedMore`;
 *   the room loader starts what it knew of them over.
 * - [pass]: a pass installed. [partial]: a page of a pass in progress, whose rooms wait in `pass_room`.
 * - [reset]: a `410` reset, Start over or a new key, which takes back every alert of the workspace (§3.10).
 */
data class PageResult(
    val changed: Set<String> = emptySet(),
    val evicted: List<String> = emptyList(),
    val cacheDropped: Set<String> = emptySet(),
    val droppedSends: Map<String, Int> = emptyMap(),
    val appendedRoom: String? = null,
    val appended: List<Event> = emptyList(),
    val removed: Map<String, List<String>> = emptyMap(),
    val redacted: Map<String, List<String>> = emptyMap(),
    val pass: Boolean = false,
    val partial: Boolean = false,
    val reset: Boolean = false,
)

/**
 * What `GET /` changed: a new [restored] generation or a new key both start a pass; [marked] unsent rows await a lookup.
 * [dropped] is what a new key dropped, a reset for the alerts (null without one).
 */
data class RestoreResult(
    val restored: Boolean,
    val keyChanged: Boolean,
    val marked: Int,
    val dropped: PageResult? = null,
    /** The cache's revision changed while `GET /` was on its way: the answer was dropped, nothing written. */
    val stale: Boolean = false,
    /** The cache's revision the answer was applied under, read in its transaction (after a restore's own bump). */
    val revision: Long? = null,
)

/** What Start over did: [marked] unsent rows await a lookup; [dropped] is the reset the alerts hear. */
data class StartOverResult(val marked: Int, val dropped: PageResult)

/** Where an events page goes in a room's one contiguous range (§3.7). */
enum class HistoryMode {
    /** The newest page replaces the range: a room with no cache, or one too far behind. */
    NEWEST,

    /** A page after `hi`, appended. */
    FORWARD,

    /** A page before `lo`, prepended. */
    BACKWARD,
}

/** An events page that went into the cache: the events as stored, and messages a raised floor took. */
data class HistoryResult(val stored: List<Event>, val removed: List<String>)

/**
 * The feed's and the history's writes to the chat cache (contract §3.6, §3.7, §3.9), each one transaction of
 * [WorkspaceStore]. The engine in WorkspaceSync.kt decides what to fetch; this decides what an answer does to the
 * cache. Nothing here talks to the network.
 *
 * An incremental page goes in together with its cursor, so a crash before the commit fetches the same page again and
 * one after it has already applied the page's removals. A pass collects its rooms in `pass_room` and installs them in
 * the transaction of its last page, so the room list never shows half a pass.
 */
class FeedApplier(
    private val store: WorkspaceStore,
    private val clock: Clock = Clock.System,
    private val timing: SyncTiming = SyncTiming(),
) {
    /**
     * Applies one `GET /changes` answer that the request sent with cursor [sentCursor]: an incremental page, a page of
     * a pass in progress, or the page that installs a pass, as the workspace row says. [active] is the open room the
     * request named, whose inline events the page carries.
     *
     * Returns null, applying nothing, when the workspace is gone, isn't `ok`, its cursor moved since the request went
     * out, or its cache [revision] (recorded before the request; null skips the check) changed: a reset, a restore or
     * Start over came in between, and the answer belongs to a feed that no longer is. The revision catches what the
     * cursor can't: a pass from the start sends no cursor before and after a Start over alike.
     */
    suspend fun apply(ws: String, page: FeedPage, sentCursor: String?, active: String? = null, revision: Long? = null): PageResult? = store.tx {
        val row = getWs(ws) ?: return@tx null
        if (row.state != STATE_OK || row.cursor != sentCursor) return@tx null
        if (revision != null && revision(ws) != revision) return@tx null
        val out = Collect()
        when {
            !row.passing -> incremental(ws, page, active, out)
            page.more -> passPage(ws, page, sentCursor, out)
            else -> install(ws, page, sentCursor, row.fresh, out)
        }
        out.result()
    }

    // §3.6 "An incremental page": rooms, evictions, the open room's inline events, directory flags, the cursor.
    private fun WorkspaceStore.StoreTx.incremental(ws: String, page: FeedPage, active: String?, out: Collect) {
        val listed = HashSet<String>()
        for (c in page.changes) {
            applyRoom(ws, c, out)
            listed += c.conversation
        }
        for (id in page.evictions) {
            if (id in listed) continue
            val sends = deleteRoom(ws, id)
            if (sends < 0) continue
            out.dropped[id] = sends
            out.evicted += id
        }
        appendInline(ws, active, page.inlineEvents, out)
        markStale(ws, page.directory)
        updateWs(ws, mapOf("cursor" to page.next))
    }

    // A page of a pass with more to come. Its rooms wait in pass_room; what it removed and its floors already apply to
    // cached events, because removals are always safe to apply early. Evictions leave the visible room list alone until
    // the install, which deletes every room the pass didn't list; they do take an evicted room out of pass_room, as an
    // earlier page may have staged it and the install would otherwise bring it back past its eviction.
    private fun WorkspaceStore.StoreTx.passPage(ws: String, page: FeedPage, sentCursor: String?, out: Collect) {
        if (sentCursor == null) clearPass(ws)
        dropEvictedPassRooms(ws, page)
        for (c in page.changes) {
            putPassRoom(ws, c)
            if (getRoom(ws, c.conversation) != null) {
                val gone = noticesBelow(ws, c.conversation, c.floor) + applyFloor(ws, c.conversation, c.floor)
                applyRemovals(ws, c, out, gone)
            } else if (c.removed.isNotEmpty()) {
                addTombstones(ws, c.removed)
            }
        }
        markStale(ws, page.directory)
        updateWs(ws, mapOf("cursor" to page.next))
        out.partial = true
    }

    // The page of a pass that says more: false. The pass's rooms replace the workspace's: a room the pass didn't list
    // is deleted, the others are upserted with the rules of an incremental page, keeping notified and muted. The pass
    // that first fills a workspace alerts nothing, so every room counts as notified up to its head. The first install
    // after a restore takes read, readLocal, readSent and notified from the restored feed: the old generation's seqs say
    // nothing about the new one's, and kept they would hide its new messages. Mute and drafts stay.
    private fun WorkspaceStore.StoreTx.install(ws: String, page: FeedPage, sentCursor: String?, fresh: Boolean, out: Collect) {
        if (sentCursor == null) clearPass(ws)
        dropEvictedPassRooms(ws, page)
        for (c in page.changes) putPassRoom(ws, c)
        val rooms = listPassRooms(ws)
        val keep = rooms.mapTo(HashSet()) { it.conversation }
        for (r in listRooms(ws)) {
            if (r.id in keep) continue
            out.dropped[r.id] = deleteRoom(ws, r.id)
            out.evicted += r.id
        }
        val rebase = getMeta(rebaseKey(ws)) != null
        for (c in rooms) {
            applyRoom(ws, c, out)
            // applyRoom recounted the badges from the old readLocal; with readLocal back at read the server's stand.
            if (rebase) {
                setRoomFields(
                    ws, c.conversation,
                    mapOf("readLocal" to c.read, "readSent" to c.read, "notified" to c.read, "unread" to c.unread, "mentions" to c.mentions),
                )
            }
        }
        if (rebase) deleteMeta(rebaseKey(ws))
        if (fresh) {
            for (r in listRooms(ws)) if (r.notified < r.head) setRoomFields(ws, r.id, mapOf("notified" to r.head))
        }
        markStale(ws, page.directory)
        updateWs(ws, mapOf("cursor" to page.next, "passing" to false, "fresh" to false))
        clearPass(ws)
        pruneTombstones(ws, clock.now() - timing.tombstoneMs)
        out.pass = true
    }

    // A pass page's evictions: out of pass_room, unless the same page lists the room again.
    private fun WorkspaceStore.StoreTx.dropEvictedPassRooms(ws: String, page: FeedPage) {
        if (page.evictions.isEmpty()) return
        val listed = page.changes.mapTo(HashSet()) { it.conversation }
        for (id in page.evictions) if (id !in listed) deletePassRoom(ws, id)
    }

    // One room row: the store's grant, field, read and floor rules, then its removals and badges.
    private fun WorkspaceStore.StoreTx.applyRoom(ws: String, c: Change, out: Collect) {
        val below = noticesBelow(ws, c.conversation, c.floor)
        val up = upsertRoom(ws, c)
        if (up.grantChanged) out.cacheDropped += c.conversation
        applyRemovals(ws, c, out, below + up.dropped)
        recount(ws, c.conversation)
        out.changed += c.conversation
    }

    // The IDs in removed get a tombstone and lose their text; removedMore drops the room's cache whole, as more were
    // removed than the feed can list. Alerts for any of them go, and for every alert of the room after removedMore.
    private fun WorkspaceStore.StoreTx.applyRemovals(ws: String, c: Change, out: Collect, alsoGone: List<String>) {
        val room = c.conversation
        val gone = ArrayList(alsoGone)
        if (c.removed.isNotEmpty()) {
            addTombstones(ws, c.removed)
            out.redacted(redact(ws, c.removed))
            gone += c.removed
        }
        if (c.removedMore && getRoom(ws, room) != null) {
            gone += cachedMessages(ws, room)
            gone += noticesForRoom(ws, room).map { it.message }
            dropRoomCache(ws, room)
            out.cacheDropped += room
        }
        out.removed(room, gone)
    }

    // The open room's inline events: appended only when they follow the cached range at once, or fill an uncached
    // room up to its head. Anything else leaves the room behind, and the room loader catches it up. The open room
    // isn't cut back to ROOM_CACHE_MAX while it is open: the loader does that when it leaves the screen.
    private fun WorkspaceStore.StoreTx.appendInline(ws: String, active: String?, events: List<WireEvent>, out: Collect) {
        if (active == null || events.isEmpty()) return
        val room = getRoom(ws, active) ?: return
        val first = events.first().seq
        val last = events.last().seq
        val fits = if (room.hi != null) first == room.hi + 1 else last == room.head
        if (!fits) return
        val stored = appendEvents(ws, active, events, Int.MAX_VALUE)
        val targets = events.filter { it.kind == WireEvent.MESSAGE_REDACTED && it.target != null }.map { it.target!! }
        if (targets.isNotEmpty()) {
            out.redacted(mapOf(active to targets))
            out.removed(active, targets)
        }
        recount(ws, active)
        out.appendedRoom = active
        out.appended = stored
        out.changed += active
    }

    private fun WorkspaceStore.StoreTx.markStale(ws: String, d: Directory) {
        val flags = LinkedHashMap<String, Any?>()
        if (d.members) flags["membersStale"] = true
        if (d.channels) flags["channelsStale"] = true
        if (d.blocks) flags["blocksStale"] = true
        if (flags.isNotEmpty()) updateWs(ws, flags)
    }

    /**
     * `410 reset_required` (§3.6): the workspace's cached events and alert notices go before the rebuild starts, so
     * stale text never shows as current, and the next fetch starts a pass. Rooms, members, drafts, mute and the
     * outbox stay. The result lists every room as changed and, per room, the alerts to take back.
     */
    suspend fun reset(ws: String): PageResult = store.tx {
        bumpRevision(ws)
        val dropped = dropBodies(ws)
        clearPass(ws)
        updateWs(ws, mapOf("cursor" to null, "passing" to true))
        dropped
    }

    // A pass from the start lists no removals (the server answers `removed: []` without a cursor), so before one that
    // follows a 410, Start over or a new key the workspace's cached events and notice rows go: a message removed
    // meanwhile must not keep its text in the timeline, a preview or an alert (§3.6, §3.10, §3.14). Rooms, read
    // positions, drafts, mute and the outbox stay. The result lists every room as changed and, per room, the alerts
    // to take back, as a reset, so the alert engine takes back every alert of the workspace.
    private fun WorkspaceStore.StoreTx.dropBodies(ws: String): PageResult {
        val out = Collect()
        for (r in listRooms(ws)) {
            out.removed(r.id, deleteNotices(ws, r.id).map { it.message })
            out.changed += r.id
        }
        deleteWsEvents(ws)
        return out.result().copy(reset = true)
    }

    /**
     * `409 history_regressed` (§3.6): the workspace is behind what this phone saw. It stops until Start over: cached
     * events go and badges are zeroed. The outbox holds its rows, as it sends only for `ok` workspaces.
     */
    suspend fun quarantine(ws: String): Boolean = store.tx {
        if (getWs(ws) == null) return@tx false
        bumpRevision(ws)
        updateWs(ws, mapOf("state" to STATE_QUARANTINED))
        deleteWsEvents(ws)
        for (r in listRooms(ws)) {
            if (r.unread != 0 || r.mentions != 0) setRoomFields(ws, r.id, mapOf("unread" to 0, "mentions" to 0))
        }
        true
    }

    /**
     * Start over (§3.6, `reload`), in one transaction: back to `ok`, a pass from the start, the cached events and
     * notice rows dropped as for a 410, and every unsent message of the workspace marked for a lookup of its operation
     * before anything else is sent. Returns how many rows it marked and the reset for the alerts. The caller then
     * runs `GET /` and the pass.
     */
    suspend fun startOver(ws: String): StartOverResult = store.tx {
        if (getWs(ws) == null) throw WorkspaceError("not_found", scope = "workspace")
        bumpRevision(ws)
        val dropped = dropBodies(ws)
        updateWs(ws, mapOf("state" to STATE_OK, "cursor" to null, "passing" to true))
        clearPass(ws)
        StartOverResult(markLookup(ws, null), dropped)
    }

    /**
     * Stores the answer of `GET /`, with [t0] and [t1] the local times before and after it (§3.6 "Restore", §3.8 the
     * clock). A generation other than the stored one is a restore: in the same transaction the cached events and notice
     * rows go, as a restored backup may lack messages this phone saw, the next fetch starts a pass, and unsent messages
     * written under the old generation are marked for a lookup. A new `keyId` starts a pass too, as cursors sealed with
     * the old key are no good; that pass lists no removals, so the cached events and notice rows go as for a 410. Either
     * way [RestoreResult.dropped] carries the alerts to take back, and the cache's revision goes up. The clock offset is
     * server time minus local time.
     *
     * With [revision], the one recorded before `GET /` went out, an answer that arrives after the revision changed is
     * dropped ([RestoreResult.stale]): a later answer already installed a restore or a new key, or the workspace was
     * reset, started over or parked, and the old answer would put the previous generation back.
     */
    suspend fun restore(ws: String, details: WorkspaceDetails, t0: Long, t1: Long, revision: Long? = null): RestoreResult = store.tx {
        val row = getWs(ws) ?: return@tx RestoreResult(restored = false, keyChanged = false, marked = 0)
        if (revision != null && revision(ws) != revision) return@tx RestoreResult(restored = false, keyChanged = false, marked = 0, stale = true)
        val w = details.workspace
        val restored = row.generation != null && row.generation != w.generation
        val keyChanged = !restored && row.keyId != null && row.keyId != w.keyId
        var marked = 0
        var dropped: PageResult? = null
        if (restored) {
            bumpRevision(ws)
            dropped = dropBodies(ws)
            clearPass(ws)
            updateWs(ws, mapOf("cursor" to null, "passing" to true, "generation" to w.generation))
            marked = markLookup(ws, row.generation)
            // The old generation's read positions say nothing about the new one's seqs: zeroed here, so ReadFlusher
            // can't report one to the restored server and a staged room's upsert can't keep one, and the pass that
            // installs the restored generation takes them from its feed (install()).
            sql.exec("UPDATE room SET read = 0, readLocal = 0, readSent = 0, notified = 0 WHERE ws = ?", ws)
            setMeta(rebaseKey(ws), "1")
        } else if (keyChanged) {
            bumpRevision(ws)
            dropped = dropBodies(ws)
            clearPass(ws)
            updateWs(ws, mapOf("cursor" to null, "passing" to true))
        }
        updateWs(
            ws,
            mapOf(
                "name" to w.name,
                "role" to details.me.role,
                "me" to details.me.id,
                "myName" to details.me.name,
                "generation" to w.generation,
                "keyId" to w.keyId,
                "limits" to RukooJson.encodeToString(WorkspaceLimits.serializer(), w.limits),
                "retention" to RukooJson.encodeToString(WorkspaceRetention.serializer(), w.retention),
            ),
        )
        setMeta(META_CLOCK_OFFSET, (w.time - (t0 + t1) / 2.0).roundToLong().toString())
        setMeta(META_CLOCK_AT, t1.toString())
        RestoreResult(restored, keyChanged, marked, dropped, revision = revision(ws))
    }

    /**
     * The removal path (`404` with `scope: workspace`): the workspace row goes with everything under it, and the WAL
     * is checkpointed so deleted pages don't linger. Returns whether there was a row.
     */
    suspend fun removeWorkspace(ws: String): Boolean {
        val gone = store.tx {
            bumpRevision(ws)
            deleteMeta(rebaseKey(ws))
            deleteWs(ws)
        }
        if (gone) runCatching { store.checkpoint() }
        return gone
    }

    /** `426 upgrade_required`: the workspace waits, socket parked, until Rukoo is updated. */
    suspend fun park(ws: String): Boolean = store.tx {
        bumpRevision(ws)
        updateWs(ws, mapOf("state" to STATE_UPGRADE))
    }

    /**
     * One events page of [room] into its range, as [mode] says (§3.7), in one transaction that first checks the room's
     * grant is still [grant], the one its request started with, and, with [revision], that the workspace's cache
     * revision is still the one recorded before the request. A page from before a grant change, a reset, a restore,
     * Start over or a new key, or one that no longer joins the range (it moved meanwhile), is discarded: null. The
     * page raises `head`, applies its `floor`, and stores a tombstoned message removed. [max] caps the range on an
     * append.
     */
    suspend fun applyHistory(
        ws: String,
        room: String,
        grant: String,
        page: EventPage,
        mode: HistoryMode,
        max: Int = Int.MAX_VALUE,
        revision: Long? = null,
    ): HistoryResult? = store.tx {
        if (revision != null && revision(ws) != revision) return@tx null
        val r = getRoom(ws, room) ?: return@tx null
        if (r.grantId != grant) return@tx null
        val head = maxOf(r.head, page.head)
        val floor = maxOf(r.floor, page.floor)
        if (head != r.head || floor != r.floor) setRoomFields(ws, room, mapOf("head" to head, "floor" to floor))
        val removed = noticesBelow(ws, room, floor) + applyFloor(ws, room, floor)
        val events = page.events.filter { it.seq >= floor }
        val now = getRoom(ws, room)!!
        val stored: List<Event> = when (mode) {
            HistoryMode.NEWEST -> {
                dropRoomCache(ws, room)
                prependEvents(ws, room, events)
            }
            HistoryMode.FORWARD -> {
                val hi = now.hi ?: return@tx null
                val after = events.filter { it.seq > hi }
                if (after.isNotEmpty() && after.first().seq != hi + 1) return@tx null
                appendEvents(ws, room, after, max)
            }
            HistoryMode.BACKWARD -> {
                val lo = now.lo ?: return@tx null
                val before = events.filter { it.seq < lo }
                if (before.isNotEmpty() && before.last().seq != lo - 1) return@tx null
                prependEvents(ws, room, before)
            }
        }
        recount(ws, room)
        HistoryResult(stored, removed)
    }

    // ---- helpers ----

    private fun WorkspaceStore.StoreTx.cachedMessages(ws: String, room: String): List<String> =
        eventsFrom(ws, room, 0, Int.MAX_VALUE).filter { it.isMessage }.map { it.id }

    // Alerts for messages below a floor, also those whose event was never cached.
    private fun WorkspaceStore.StoreTx.noticesBelow(ws: String, room: String, floor: Long): List<String> =
        noticesForRoom(ws, room).filter { it.seq < floor }.map { it.message }

    private class Collect {
        val changed = LinkedHashSet<String>()
        val evicted = ArrayList<String>()
        val cacheDropped = LinkedHashSet<String>()
        val dropped = LinkedHashMap<String, Int>()
        var appendedRoom: String? = null
        var appended: List<Event> = emptyList()
        private val removed = LinkedHashMap<String, LinkedHashSet<String>>()
        private val redacted = LinkedHashMap<String, LinkedHashSet<String>>()
        var pass = false
        var partial = false

        fun removed(room: String, ids: Collection<String>) {
            if (ids.isNotEmpty()) removed.getOrPut(room) { LinkedHashSet() }.addAll(ids)
        }

        fun redacted(map: Map<String, List<String>>) {
            for ((room, ids) in map) if (ids.isNotEmpty()) redacted.getOrPut(room) { LinkedHashSet() }.addAll(ids)
        }

        fun result() = PageResult(
            changed = changed.toSet(),
            evicted = evicted.toList(),
            cacheDropped = cacheDropped.toSet(),
            droppedSends = dropped.toMap(),
            appendedRoom = appendedRoom,
            appended = appended,
            removed = removed.mapValues { it.value.toList() },
            redacted = redacted.mapValues { it.value.toList() },
            pass = pass,
            partial = partial,
        )
    }

    companion object {
        const val STATE_OK = "ok"
        const val STATE_QUARANTINED = "quarantined"
        const val STATE_UPGRADE = "upgrade"

        /** `meta` keys: server time minus local time in ms, and the local time it was measured (§3.5). */
        const val META_CLOCK_OFFSET = "clockOffset"
        const val META_CLOCK_AT = "clockAt"

        /** `meta` key: a restore waits for its pass to take read positions from the restored feed. */
        fun rebaseKey(ws: String) = "rebase:$ws"

        // ---- Checking answers: the whole answer is refused when one field isn't what the protocol says ----

        // What one answer may hold (server/src/workspace.js): 100 rooms and evictions together, 64 removed IDs per room,
        // 20 inline events, 100 events per page, 8 people in a DM.
        private const val FEED_ROWS = 100
        private const val REMOVED_IDS = 64
        private const val INLINE_EVENTS = 20
        private const val EVENTS_PAGE = 100
        private const val DM_PEOPLE = 8
        private const val BADGE_CAP = 100

        // The server keeps names to 80 code points; 200 UTF-16 units leaves room and refuses nonsense.
        private const val NAME_UNITS = 200
        private val GRANT = Regex("^g_[A-Za-z0-9_-]{22}$")
        private val CURSOR = Regex("^[A-Za-z0-9_-]{1,400}$")
        private val GENERATION = Regex("^[A-Za-z0-9_-]{22}$")
        private val KEY_ID = Regex("^[A-Za-z0-9_-]{1,64}$")
        private val EVENT_KIND = Regex("^[a-z]+(\\.[a-z_]+)+$")
        private val ROOM_ROLES = setOf("manager", "member")
        private val CLOSED_REASONS = setOf("left", "ineligible", "closed")
        private val MEMBER_ROLES = setOf("owner", "admin", "member", "guest")

        private fun refused(where: String): Nothing = throw WorkspaceError("server", message = "the answer is malformed at $where")

        private fun need(ok: Boolean, where: String) {
            if (!ok) refused(where)
        }

        /** No lone surrogate, which no UTF-8 answer can carry. */
        private fun wellFormed(s: String): Boolean {
            var i = 0
            while (i < s.length) {
                val c = s[i]
                if (c.isHighSurrogate()) {
                    if (i + 1 >= s.length || !s[i + 1].isLowSurrogate()) return false
                    i += 2
                } else {
                    if (c.isLowSurrogate()) return false
                    i += 1
                }
            }
            return true
        }

        private fun name(s: String?, where: String) {
            need(s != null && s.isNotEmpty() && s.length <= NAME_UNITS && wellFormed(s), where)
        }

        private fun ids(list: List<String>, pattern: Regex, where: String, max: Int, min: Int = 0) {
            need(list.size in min..max, where)
            need(list.all { pattern.matches(it) }, where)
            need(list.toSet().size == list.size, where)
        }

        /**
         * A `GET /changes` answer, checked as a whole as desktop's `wire.checkChanges` does: IDs of the right kind,
         * numbers in range, lists within the server's bounds, a DM's fields consistent. Throws `server` naming the
         * first bad field, before anything of the answer reaches the cache.
         */
        fun check(page: FeedPage) {
            need(page.changes.size <= FEED_ROWS, "changes.changes")
            ids(page.evictions, WorkspaceIds.CONVERSATION, "changes.evictions", FEED_ROWS)
            need(page.changes.size + page.evictions.size <= FEED_ROWS, "changes.changes")
            need(page.changes.map { it.conversation }.toSet().size == page.changes.size, "changes.changes")
            page.changes.forEachIndexed { i, c -> check(c, "changes.changes[$i]") }
            checkEvents(page.inlineEvents, "changes.inlineEvents", INLINE_EVENTS)
            need(CURSOR.matches(page.next), "changes.next")
        }

        /** One room row of the feed, or the `dm` a `POST /dms` answers (§2.4). */
        fun check(c: Change, where: String = "room") {
            need(WorkspaceIds.isConversation(c.conversation), "$where.conversation")
            need(c.kind == "channel" || c.kind == "dm", "$where.kind")
            if (c.kind == "dm") {
                need(c.name.isNullOrEmpty(), "$where.name")
                need(c.visibility == "dm", "$where.visibility")
                ids(c.participants ?: emptyList(), WorkspaceIds.MEMBER, "$where.participants", DM_PEOPLE, 2)
                need(c.participants != null, "$where.participants")
                need(c.startedBy == null || WorkspaceIds.isMember(c.startedBy), "$where.startedBy")
                need(c.closedReason == null || c.closedReason in CLOSED_REASONS, "$where.closedReason")
                need(c.archived == (c.closedReason != null), "$where.closedReason")
            } else {
                name(c.name, "$where.name")
                need(c.visibility == "workspace" || c.visibility == "private", "$where.visibility")
            }
            need(GRANT.matches(c.grant), "$where.grant")
            need(c.role in ROOM_ROLES, "$where.role")
            need(c.members >= 0, "$where.members")
            need(c.head >= 0, "$where.head")
            need(c.floor >= 0, "$where.floor")
            need(c.lastAt == null || c.lastAt >= 0, "$where.lastAt")
            need(c.read in 0..c.head, "$where.read")
            need(c.unread in 0..BADGE_CAP, "$where.unread")
            need(c.mentions in 0..BADGE_CAP, "$where.mentions")
            ids(c.removed, WorkspaceIds.EVENT, "$where.removed", REMOVED_IDS)
        }

        /** A `GET …/events` answer: at most 100 events in rising order, and its head and floor. */
        fun check(page: EventPage) {
            checkEvents(page.events, "events.events", EVENTS_PAGE)
            need(page.head >= 0, "events.head")
            need(page.floor >= 0, "events.floor")
        }

        /** `GET /` for workspace [ws]: its own ID, a generation and key of the right shape, and the caller. */
        fun check(details: WorkspaceDetails, ws: String) {
            val w = details.workspace
            need(w.id == ws, "workspace.workspace.id")
            name(w.name, "workspace.workspace.name")
            need(GENERATION.matches(w.generation), "workspace.workspace.generation")
            need(w.keyId == null || KEY_ID.matches(w.keyId), "workspace.workspace.keyId")
            need(w.time >= 0, "workspace.workspace.time")
            need(WorkspaceIds.isMember(details.me.id), "workspace.me.id")
            need(details.me.role in MEMBER_ROLES, "workspace.me.role")
        }

        private fun checkEvents(events: List<WireEvent>, where: String, max: Int) {
            need(events.size <= max, where)
            var last = 0L
            events.forEachIndexed { i, e ->
                check(e, "$where[$i]")
                need(e.seq > last, "$where[$i].seq")
                last = e.seq
            }
        }

        /**
         * One event. Kinds this version doesn't know pass with their common fields, so a newer server's event doesn't
         * stop the feed; the timeline shows nothing for them.
         */
        fun check(e: WireEvent, where: String = "event") {
            need(e.kind.length <= 40 && EVENT_KIND.matches(e.kind), "$where.kind")
            need(e.seq >= 1, "$where.seq")
            need(WorkspaceIds.isEvent(e.id), "$where.id")
            need(WorkspaceIds.isMember(e.actor), "$where.actor")
            need(e.at >= 0, "$where.at")
            when (e.kind) {
                WireEvent.MESSAGE_POSTED -> {
                    need(e.root == null || WorkspaceIds.isEvent(e.root), "$where.root")
                    if (e.redacted) {
                        need(e.text == null && e.mentions.isEmpty(), "$where.redacted")
                    } else {
                        val text = e.text
                        need(text != null && text.isNotEmpty() && wellFormed(text) && Utf8Offsets.utf8Length(text) <= TEXT_BYTES, "$where.text")
                        need(Utf8Offsets.isValid(text!!, e.mentions), "$where.mentions")
                    }
                }
                WireEvent.MESSAGE_REDACTED -> {
                    need(WorkspaceIds.isEvent(e.target), "$where.target")
                    need((e.targetSeq ?: 0) >= 1, "$where.targetSeq")
                }
                "channel.created" -> {
                    name(e.name, "$where.name")
                    need(e.visibility == "workspace" || e.visibility == "private", "$where.visibility")
                }
                "channel.renamed" -> name(e.name, "$where.name")
                "member.joined", "member.left" -> need(WorkspaceIds.isMember(e.member), "$where.member")
                "dm.started" -> ids(e.members ?: emptyList(), WorkspaceIds.MEMBER, "$where.members", DM_PEOPLE, 2)
            }
        }
    }
}

/**
 * The badges of a room this phone read further than the server knows (§3.9): none once it read to `head`; a recount
 * from the cache when the cache covers everything after `readLocal`; else the server's numbers stand until the next
 * page. The recount counts the blocked people's posts as unread and leaves their mentions out. Returns whether the
 * badges changed.
 */
internal fun WorkspaceStore.StoreTx.recount(ws: String, room: String): Boolean {
    val r = getRoom(ws, room) ?: return false
    if (r.readLocal <= r.read) return false
    if (r.readLocal >= r.head) {
        if (r.unread == 0 && r.mentions == 0) return false
        setRoomFields(ws, room, mapOf("unread" to 0, "mentions" to 0))
        return true
    }
    val covers = r.lo != null && r.hi != null && r.hi >= r.head && r.lo <= r.readLocal + 1
    val me = getWs(ws)?.me
    if (!covers || me == null) return false
    val badges = countBadges(ws, room, r.readLocal, me)
    if (badges.unread == r.unread && badges.mentions == r.mentions) return false
    setRoomFields(ws, room, mapOf("unread" to badges.unread, "mentions" to badges.mentions))
    return true
}
