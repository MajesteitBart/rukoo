package nl.bvdm.rukoo.workspaces

import kotlinx.coroutines.flow.SharedFlow
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.serializer
import nl.bvdm.rukoo.core.RukooJson

/** A workspace row of the cache (§3.5 `ws`). [limits] and [retention] are the JSON `GET /` answered. */
data class WsRow(
    val id: String,
    val name: String,
    val role: String,
    val me: String? = null,
    val myName: String? = null,
    val generation: String? = null,
    val keyId: String? = null,
    val limits: String? = null,
    val retention: String? = null,
    val cursor: String? = null,
    val passing: Boolean = true,
    val fresh: Boolean = true,
    /** ok | quarantined | upgrade */
    val state: String = "ok",
    val membersStale: Boolean = true,
    val channelsStale: Boolean = true,
    val blocksStale: Boolean = true,
    val membersMore: Boolean = false,
    val syncedAt: Long? = null,
    val activeAt: Long? = null,
)

/** A room row of the cache (§3.5 `room`): the feed's fields plus what this phone keeps about it. */
data class RoomRow(
    val ws: String,
    val id: String,
    val kind: String,
    val name: String?,
    val visibility: String,
    val archived: Boolean,
    val closedReason: String?,
    val participants: List<String>?,
    val startedBy: String?,
    val grantId: String,
    val role: String?,
    val members: Int,
    val head: Long,
    val floor: Long,
    val lastAt: Long?,
    val read: Long,
    val readLocal: Long,
    val readSent: Long,
    val unread: Int,
    val mentions: Int,
    val lo: Long?,
    val hi: Long?,
    val notified: Long,
    val muted: Boolean,
    /** How many agents are in the room, from the feed; [members] counts only people. */
    val agents: Int = 0,
) {
    val hasCache: Boolean get() = lo != null && hi != null
}

/** An outbox row (§3.5 `outbox`). [mentions] are exactly what goes on the wire. */
data class OutboxRow(
    val local: String,
    val ws: String,
    val room: String,
    val actor: String,
    val grantId: String,
    val generation: String,
    val text: String,
    val mentions: List<Mention>,
    val root: String?,
    val operationId: String? = null,
    /** queued | sending | held | failed */
    val state: String = "queued",
    val reason: String? = null,
    val attempts: Int = 0,
    val nextAt: Long = 0,
    val createdAt: Long,
)

/** A saved draft with when it was written. */
data class DraftRow(val text: String, val mentions: List<Mention>, val at: Long) {
    val draft: Draft get() = Draft(text, mentions)
}

/** A message an alert on screen shows (§3.5 `notice`). */
data class Notice(val message: String, val seq: Long)

/** What [WorkspaceStore.StoreTx.upsertRoom] did: the row as stored, and the message IDs the floor took. */
data class UpsertResult(val row: RoomRow, val inserted: Boolean, val grantChanged: Boolean, val dropped: List<String>)

/** The badges of the cached messages after a read position (§3.9). */
data class Badges(val unread: Int, val mentions: Int)

/** A root's cached reply count, newest seq and time. */
data class ReplyCount(val count: Int, val lastSeq: Long, val lastAt: Long)

/**
 * The cache's queries, mirroring desktop's store.js (contract §4.2) name for name. Each runs inside [tx] or [read],
 * so the engines put several in one transaction: a feed page and its cursor, a send and its row. The block can't
 * suspend, which keeps a transaction from spanning a network call.
 */
class WorkspaceStore(val db: ChatDb, private val now: () -> Long = System::currentTimeMillis) {
    val changes: SharedFlow<DbChange> get() = db.changes
    val lostUnsent: Int get() = db.lostUnsent

    // Each workspace's cache revision, in memory: a fetch can't outlive the process, so neither need its revision.
    private val revisions = java.util.concurrent.ConcurrentHashMap<String, Long>()

    /**
     * The workspace's cache revision (§3.6). It goes up in the transaction of a `410` reset, Start over, a new key, a
     * restore, a quarantine, a park, the removal and a feed page whose `removedMore` dropped a room's cache. A fetch
     * records it before its request goes out, and its answer or error is dropped (not written, not shown, not
     * alerted) when it changed meanwhile: that answer belongs to a cache that no longer is. Check it again inside the
     * transaction that writes the answer ([StoreTx.revision]).
     */
    fun revision(ws: String): Long = revisions[ws] ?: 0L

    // Workspaces the server said are gone whose rows SQLite hasn't deleted yet: listWs and getWs leave them out, as
    // the desktop's store.hideWs does, so nothing reads their cache meanwhile. In memory: after a restart the next
    // request's 404 removes the workspace again.
    private val hidden: MutableSet<String> = java.util.concurrent.ConcurrentHashMap.newKeySet()

    /**
     * The removal path's first step: [ws] leaves every [StoreTx.listWs] and [StoreTx.getWs] at once, and its revision
     * goes up, so an answer to a request made before is dropped. [deleteHidden] deletes its rows.
     */
    fun hideWs(ws: String) {
        hidden += ws
        revisions.merge(ws, 1L, Long::plus)
    }

    /** Whether a hidden workspace still waits for its rows to go. */
    val hasHidden: Boolean get() = hidden.isNotEmpty()

    /**
     * Deletes the rows of every hidden workspace, each in its own transaction, then checkpoints the WAL so deleted pages
     * don't linger. A workspace SQLite refuses to delete stays hidden for the next try. Returns whether none is left.
     */
    suspend fun deleteHidden(): Boolean {
        var deleted = false
        for (ws in hidden.toList()) {
            try {
                db.transaction {
                    val tx = StoreTx(this, now, revisions)
                    tx.deleteMeta(FeedApplier.rebaseKey(ws))
                    tx.deleteWs(ws)
                }
                hidden -= ws
                deleted = true
            } catch (e: kotlin.coroutines.cancellation.CancellationException) {
                throw e
            } catch (e: Exception) {
                // A full disk or a closed cache: it stays hidden.
            }
        }
        if (deleted) runCatching { checkpoint() }
        return hidden.isEmpty()
    }

    /** One write transaction (`BEGIN IMMEDIATE`); a write SQLite refuses throws `not_saved`. */
    suspend fun <T> tx(block: StoreTx.() -> T): T = db.transaction { StoreTx(this, now, revisions, hidden).block() }

    /** One read transaction: a consistent view. The block must not write. */
    suspend fun <T> read(block: StoreTx.() -> T): T = db.read { StoreTx(this, now, revisions, hidden).block() }

    /** Closes the database and deletes the file with its `-wal` and `-shm` files. */
    suspend fun wipe() = db.wipe()

    suspend fun quickCheck(): Boolean = db.quickCheck()

    /** `PRAGMA wal_checkpoint(TRUNCATE)`, after deleting a workspace. */
    suspend fun checkpoint() = db.checkpoint()

    suspend fun close() = db.close()

    class StoreTx internal constructor(
        val sql: Sql,
        private val now: () -> Long,
        private val revisions: MutableMap<String, Long>,
        private val hidden: Set<String> = emptySet(),
    ) {
        // ---- the cache revision ----

        /** [WorkspaceStore.revision], read where transactions are serialized, so no bump slips in before the write. */
        fun revision(ws: String): Long = revisions[ws] ?: 0L

        /**
         * Raises the workspace's revision, from inside the transaction that resets, restores, re-keys, starts over,
         * quarantines, parks or removes it, or drops a room's cache for `removedMore`. A transaction that rolls back
         * afterwards leaves the bump, which only drops an answer that could have stayed.
         */
        fun bumpRevision(ws: String) {
            revisions.merge(ws, 1L, Long::plus)
        }

        // ---- meta ----

        fun getMeta(key: String): String? = sql.one("SELECT value FROM meta WHERE key = ?", key) { it.text(0) }

        fun setMeta(key: String, value: String) {
            sql.exec("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", key, value)
        }

        fun deleteMeta(key: String) {
            sql.exec("DELETE FROM meta WHERE key = ?", key)
        }

        // ---- ws ----

        /** The workspaces, without those the removal path hid ([WorkspaceStore.hideWs]). */
        fun listWs(): List<WsRow> =
            sql.query("SELECT $WS_COLUMNS FROM ws ORDER BY id", row = ::wsRow).let { rows -> if (hidden.isEmpty()) rows else rows.filter { it.id !in hidden } }

        /** The workspace's row; null for a hidden one ([WorkspaceStore.hideWs]). */
        fun getWs(id: String): WsRow? = if (id in hidden) null else sql.one("SELECT $WS_COLUMNS FROM ws WHERE id = ?", id, row = ::wsRow)

        /** A new workspace row; one that exists keeps its row and gets [row]'s name and role. */
        fun insertWs(row: WsRow): WsRow {
            sql.exec(
                """INSERT INTO ws (id, name, role, me, myName, generation, keyId, limits, retention, cursor, passing, fresh, state,
                     membersStale, channelsStale, blocksStale, membersMore, syncedAt, activeAt)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT (id) DO UPDATE SET name = excluded.name, role = excluded.role""",
                row.id, row.name, row.role, row.me, row.myName, row.generation, row.keyId, row.limits, row.retention, row.cursor,
                row.passing, row.fresh, row.state, row.membersStale, row.channelsStale, row.blocksStale, row.membersMore,
                row.syncedAt, row.activeAt,
            )
            sql.touch(row.id)
            // Not getWs: a hidden workspace the listing names again still has its row.
            return sql.one("SELECT $WS_COLUMNS FROM ws WHERE id = ?", row.id, row = ::wsRow)!!
        }

        /** Sets the named columns of a workspace; a name outside the `ws` table throws. Returns whether it existed. */
        fun updateWs(id: String, fields: Map<String, Any?>): Boolean {
            val changed = setFields("ws", fields, WS_FIELDS, "id = ?", id) > 0
            if (changed) sql.touch(id)
            return changed
        }

        /** The workspace and everything under it. */
        fun deleteWs(id: String): Boolean {
            // Rooms, the pass, tombstones and the directory reference ws; events, the outbox, drafts and notices go with
            // their room.
            val gone = sql.exec("DELETE FROM ws WHERE id = ?", id) > 0
            if (gone) sql.touch(id)
            return gone
        }

        // ---- rooms ----

        fun listRooms(ws: String): List<RoomRow> = sql.query("SELECT $ROOM_COLUMNS FROM room WHERE ws = ? ORDER BY id", ws, row = ::roomRow)

        fun getRoom(ws: String, id: String): RoomRow? = sql.one("SELECT $ROOM_COLUMNS FROM room WHERE ws = ? AND id = ?", ws, id, row = ::roomRow)

        /**
         * A room row from the feed, with the rules of §3.6: a new room comes in uncached with `readLocal` and
         * `readSent` at the server's read; a grant other than the cached one empties the cache first (outbox rows keep
         * the old grant); every field is updated, `readLocal` and `readSent` rise to `read`, and events below `floor`
         * go. [keepLocal] false also forgets what this phone read and cached, as for a new room. `muted` and
         * `notified` always stay. The badges are the server's; the caller recounts them with [countBadges] when
         * `readLocal` is ahead (§3.9).
         */
        fun upsertRoom(ws: String, feed: Change, keepLocal: Boolean = true): UpsertResult {
            val before = getRoom(ws, feed.conversation)
            val grantChanged = before != null && before.grantId != feed.grant
            if (before != null && (grantChanged || !keepLocal)) dropRoomCache(ws, feed.conversation)
            val local = before != null && keepLocal
            val readLocal = if (local) "MAX(room.readLocal, excluded.read)" else "excluded.read"
            val readSent = if (local) "MAX(room.readSent, excluded.read)" else "excluded.read"
            sql.exec(
                """INSERT INTO room (ws, id, kind, name, visibility, archived, closedReason, participants, startedBy, grantId, role,
                     members, head, floor, lastAt, read, readLocal, readSent, unread, mentions, agents)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT (ws, id) DO UPDATE SET
                     kind = excluded.kind, name = excluded.name, visibility = excluded.visibility, archived = excluded.archived,
                     closedReason = excluded.closedReason, participants = excluded.participants, startedBy = excluded.startedBy,
                     grantId = excluded.grantId, role = excluded.role, members = excluded.members, head = excluded.head,
                     floor = excluded.floor, lastAt = excluded.lastAt, read = excluded.read,
                     readLocal = $readLocal, readSent = $readSent,
                     unread = excluded.unread, mentions = excluded.mentions, agents = excluded.agents""",
                ws, feed.conversation, feed.kind, feed.name, feed.visibility, feed.archived, feed.closedReason,
                feed.participants?.let { RukooJson.encodeToString(STRINGS, it) }, feed.startedBy, feed.grant, feed.role,
                feed.members, feed.head, feed.floor, feed.lastAt, feed.read, feed.read, feed.read, feed.unread, feed.mentions,
                feed.agents,
            )
            val dropped = applyFloor(ws, feed.conversation, feed.floor)
            // The workspace's view hears every change in it; the room's own timeline hears this one.
            sql.touch(ws, feed.conversation)
            return UpsertResult(getRoom(ws, feed.conversation)!!, before == null, grantChanged, dropped)
        }

        fun setRoomFields(ws: String, id: String, fields: Map<String, Any?>): Boolean {
            val changed = setFields("room", fields, ROOM_FIELDS, "ws = ? AND id = ?", ws, id) > 0
            if (changed) sql.touch(ws, id)
            return changed
        }

        /**
         * The room and its events, queued sends, drafts and notices. Returns how many unsent messages went with it,
         * for the eviction's report, or -1 when there was no such room.
         */
        fun deleteRoom(ws: String, id: String): Int {
            val sends = sql.long("SELECT COUNT(*) FROM outbox WHERE ws = ? AND room = ?", ws, id).toInt()
            val gone = sql.exec("DELETE FROM room WHERE ws = ? AND id = ?", ws, id) > 0
            if (!gone) return -1
            sql.touch(ws)
            return sends
        }

        /** The room's cached events go and its range empties; the room itself stays. */
        fun dropRoomCache(ws: String, id: String) {
            sql.exec("DELETE FROM event WHERE ws = ? AND room = ?", ws, id)
            sql.exec("UPDATE room SET lo = NULL, hi = NULL WHERE ws = ? AND id = ?", ws, id)
            sql.touch(ws, id)
        }

        // ---- pass ----

        fun putPassRoom(ws: String, row: Change) {
            sql.exec(
                "INSERT INTO pass_room (ws, id, row) VALUES (?, ?, ?) ON CONFLICT (ws, id) DO UPDATE SET row = excluded.row",
                ws, row.conversation, RukooJson.encodeToString(Change.serializer(), row),
            )
        }

        /** A room a later page of the pass evicted: the install must not bring it back. */
        fun deletePassRoom(ws: String, id: String) {
            sql.exec("DELETE FROM pass_room WHERE ws = ? AND id = ?", ws, id)
        }

        fun listPassRooms(ws: String): List<Change> =
            sql.query("SELECT row FROM pass_room WHERE ws = ? ORDER BY id", ws) { RukooJson.decodeFromString(Change.serializer(), it.text(0)) }

        fun clearPass(ws: String) {
            sql.exec("DELETE FROM pass_room WHERE ws = ?", ws)
        }

        // ---- events ----

        /**
         * Writes events as the server sent them and returns them as stored. A tombstoned message is stored removed, a
         * removed one never gets its text back, and a `message.redacted` removes its target and tombstones it. An
         * agent's reply keeps its trigger and depth in `data` until it is removed, as the server drops them then.
         */
        fun writeEvents(ws: String, room: String, events: List<WireEvent>): List<Event> {
            for (e in events) {
                val removed = e.isMessage && (e.redacted || hasTombstone(ws, e.id))
                val keepText = e.isMessage && !removed
                val data = if (e.isMessage && removed) null else e.data()
                sql.exec(
                    """INSERT INTO event (ws, room, seq, id, kind, actor, at, root, text, mentions, data, redacted)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                       ON CONFLICT (ws, room, seq) DO UPDATE SET
                         id = excluded.id, kind = excluded.kind, actor = excluded.actor, at = excluded.at, root = excluded.root,
                         text = CASE WHEN event.redacted = 1 OR excluded.redacted = 1 THEN NULL ELSE excluded.text END,
                         mentions = CASE WHEN event.redacted = 1 OR excluded.redacted = 1 THEN NULL ELSE excluded.mentions END,
                         data = CASE WHEN event.redacted = 1 OR excluded.redacted = 1 THEN NULL ELSE excluded.data END,
                         redacted = MAX(event.redacted, excluded.redacted)""",
                    ws, room, e.seq, e.id, e.kind, e.actor, e.at, e.root,
                    if (keepText) e.text else null,
                    if (keepText) RukooJson.encodeToString(MENTIONS, e.mentions) else null,
                    data?.let { RukooJson.encodeToString(EventData.serializer(), it) },
                    removed,
                )
                if (e.kind == WireEvent.MESSAGE_REDACTED && e.target != null) {
                    addTombstones(ws, listOf(e.target))
                    redact(ws, listOf(e.target))
                }
            }
            sql.touch(ws, room)
            return events.mapNotNull { eventAt(ws, room, it.seq) }
        }

        /**
         * Events after the cached range, ascending: `hi` rises to the last, `lo` is set when the room had no cache,
         * `head` follows, and a room over [max] loses its lowest events. The caller checks they start at `hi + 1`.
         */
        fun appendEvents(ws: String, room: String, events: List<WireEvent>, max: Int = ROOM_CACHE_MAX): List<Event> {
            if (events.isEmpty()) return emptyList()
            val stored = writeEvents(ws, room, events)
            val first = events.first().seq
            val last = events.last().seq
            sql.exec(
                "UPDATE room SET lo = COALESCE(lo, ?), hi = MAX(COALESCE(hi, ?), ?), head = MAX(head, ?) WHERE ws = ? AND id = ?",
                first, last, last, last, ws, room,
            )
            trimRoom(ws, room, max)
            return stored.filter { eventAt(ws, room, it.seq) != null }
        }

        /** Events before the cached range, ascending: `lo` falls to the first, `hi` is set when the room had no cache. */
        fun prependEvents(ws: String, room: String, events: List<WireEvent>): List<Event> {
            if (events.isEmpty()) return emptyList()
            val stored = writeEvents(ws, room, events)
            val first = events.first().seq
            val last = events.last().seq
            sql.exec(
                "UPDATE room SET lo = MIN(COALESCE(lo, ?), ?), hi = COALESCE(hi, ?), head = MAX(head, ?) WHERE ws = ? AND id = ?",
                first, first, last, last, ws, room,
            )
            return stored
        }

        /** The newest [limit] events below [seq], ascending. */
        fun eventsBefore(ws: String, room: String, seq: Long, limit: Int): List<Event> =
            sql.query("SELECT $EVENT_COLUMNS FROM event WHERE ws = ? AND room = ? AND seq < ? ORDER BY seq DESC LIMIT ?", ws, room, seq, limit, row = ::event)
                .asReversed()

        /** [limit] events from [seq] up, ascending. */
        fun eventsFrom(ws: String, room: String, seq: Long, limit: Int): List<Event> =
            sql.query("SELECT $EVENT_COLUMNS FROM event WHERE ws = ? AND room = ? AND seq >= ? ORDER BY seq LIMIT ?", ws, room, seq, limit, row = ::event)

        fun eventById(ws: String, id: String): Event? = sql.one("SELECT $EVENT_COLUMNS FROM event WHERE ws = ? AND id = ?", ws, id, row = ::event)

        /** The room an event is cached in. */
        fun roomOfEvent(ws: String, id: String): String? = sql.one("SELECT room FROM event WHERE ws = ? AND id = ?", ws, id) { it.text(0) }

        fun eventAt(ws: String, room: String, seq: Long): Event? =
            sql.one("SELECT $EVENT_COLUMNS FROM event WHERE ws = ? AND room = ? AND seq = ?", ws, room, seq, row = ::event)

        /** The newest cached message of a room, for a DM row's preview (§7.4). Removed ones count, as their rows do. */
        fun lastMessage(ws: String, room: String): Event? = sql.one(
            "SELECT $EVENT_COLUMNS FROM event WHERE ws = ? AND room = ? AND kind = 'message.posted' ORDER BY seq DESC LIMIT 1",
            ws, room, row = ::event,
        )

        /**
         * Each room's roster revision (`Room.roster`): the seq of the newest join or leave cached for it, a
         * `member.joined` or `member.left`. Rooms without one are left out. Read from the index `event_roster`.
         */
        fun rosters(ws: String): Map<String, Long> = sql.query(
            "SELECT room, MAX(seq) FROM event INDEXED BY event_roster WHERE ws = ? AND ${ChatDb.ROSTER_EVENTS} GROUP BY room",
            ws,
        ) { it.text(0) to it.long(1) }.toMap()

        /** [room]'s roster revision, as in [rosters]; 0 when no join or leave of it is cached. */
        fun roster(ws: String, room: String): Long = sql.one(
            "SELECT MAX(seq) FROM event INDEXED BY event_roster WHERE ws = ? AND room = ? AND ${ChatDb.ROSTER_EVENTS}",
            ws, room,
        ) { it.longOrNull(0) } ?: 0L

        /** The cached replies to a thread root, in order. */
        fun replies(ws: String, room: String, root: String): List<Event> =
            sql.query("SELECT $EVENT_COLUMNS FROM event WHERE ws = ? AND room = ? AND root = ? ORDER BY seq", ws, room, root, row = ::event)

        /**
         * For each root: the count, newest seq and newest time of its cached replies, removed ones included, because a
         * removed reply keeps its row. Roots without replies are left out.
         */
        fun replyCounts(ws: String, room: String, roots: Collection<String>): Map<String, ReplyCount> {
            val out = LinkedHashMap<String, ReplyCount>()
            for (root in roots) {
                val count = sql.one(
                    "SELECT COUNT(*), MAX(seq), MAX(at) FROM event WHERE ws = ? AND room = ? AND root = ? AND kind = 'message.posted'",
                    ws, room, root,
                ) { r -> if (r.long(0) > 0) ReplyCount(r.int(0), r.long(1), r.long(2)) else null }
                if (count != null) out[root] = count
            }
            return out
        }

        /** The newest repliers of a root, distinct, newest first, at most [limit]. */
        fun repliers(ws: String, room: String, root: String, limit: Int = 3): List<String> = sql.query(
            "SELECT actor FROM event WHERE ws = ? AND room = ? AND root = ? AND kind = 'message.posted' GROUP BY actor ORDER BY MAX(seq) DESC LIMIT ?",
            ws, room, root, limit,
        ) { it.text(0) }

        /**
         * Retention's floor: events below it go; `lo` rises to it, or the range empties when `hi` is below it. Returns
         * the IDs of the messages that went, so alerts showing them can be taken back.
         */
        fun applyFloor(ws: String, room: String, floor: Long): List<String> {
            val gone = sql.query("SELECT id FROM event WHERE ws = ? AND room = ? AND seq < ? AND kind = 'message.posted'", ws, room, floor) { it.text(0) }
            val deleted = sql.exec("DELETE FROM event WHERE ws = ? AND room = ? AND seq < ?", ws, room, floor)
            val moved = sql.exec(
                """UPDATE room SET lo = CASE WHEN hi IS NULL OR hi < ? THEN NULL ELSE MAX(lo, ?) END,
                                   hi = CASE WHEN hi IS NULL OR hi < ? THEN NULL ELSE hi END
                   WHERE ws = ? AND id = ? AND (lo IS NOT NULL AND lo < ? OR hi IS NOT NULL AND hi < ?)""",
                floor, floor, floor, ws, room, floor, floor,
            )
            if (deleted > 0 || moved > 0) sql.touch(ws, room)
            return gone
        }

        /**
         * Removed messages lose their text and mentions (and an agent reply its trigger and depth), in any room of the
         * workspace. Returns room to IDs for the ones that were cached with text, for the `redacted` report.
         */
        fun redact(ws: String, ids: Collection<String>): Map<String, List<String>> {
            val out = LinkedHashMap<String, MutableList<String>>()
            for (id in ids) {
                val row = sql.one("SELECT room, redacted FROM event WHERE ws = ? AND id = ?", ws, id) { it.text(0) to it.bool(1) } ?: continue
                sql.exec(
                    "UPDATE event SET text = NULL, mentions = NULL, data = CASE WHEN kind = 'message.posted' THEN NULL ELSE data END, redacted = 1 WHERE ws = ? AND id = ?",
                    ws, id,
                )
                sql.touch(ws, row.first)
                if (!row.second) out.getOrPut(row.first) { ArrayList() } += id
            }
            return out
        }

        /** At most [max] events in the room: the lowest go and `lo` moves up. Returns how many went. */
        fun trimRoom(ws: String, room: String, max: Int = ROOM_CACHE_MAX): Int {
            val count = sql.long("SELECT COUNT(*) FROM event WHERE ws = ? AND room = ?", ws, room)
            if (count <= max) return 0
            val cut = sql.long("SELECT seq FROM event WHERE ws = ? AND room = ? ORDER BY seq DESC LIMIT 1 OFFSET ?", ws, room, max - 1)
            val gone = sql.exec("DELETE FROM event WHERE ws = ? AND room = ? AND seq < ?", ws, room, cut)
            sql.exec("UPDATE room SET lo = ? WHERE ws = ? AND id = ?", cut, ws, room)
            sql.touch(ws, room)
            return gone
        }

        /** Every cached event of the workspace, and every room's range. */
        fun deleteWsEvents(ws: String) {
            sql.exec("DELETE FROM event WHERE ws = ?", ws)
            sql.exec("UPDATE room SET lo = NULL, hi = NULL WHERE ws = ?", ws)
            sql.touch(ws)
        }

        /**
         * The badges of the cached messages after [after] (§3.9): unread counts messages that aren't the person's own
         * and aren't removed; mentions counts the ones of those that name [me], from authors not in [blocked] (the
         * workspace's block rows when null). Each is capped at 100. The caller checks that the cache covers the range.
         *
         * The mention check runs here in Kotlin: Android 12 and 13 ship SQLite 3.32 without the JSON functions, so
         * `json_each` fails there (ChatDbDeviceTest). SQL only narrows the rows to those whose mentions name [me].
         */
        fun countBadges(ws: String, room: String, after: Long, me: String, blocked: Collection<String>? = null): Badges {
            val skip = (blocked ?: listBlocks(ws).map { it.member }).toHashSet()
            val unread = sql.long(
                """SELECT COUNT(*) FROM (SELECT 1 FROM event WHERE ws = ? AND room = ? AND seq > ? AND kind = 'message.posted'
                     AND actor != ? AND redacted = 0 LIMIT $BADGE_CAP)""",
                ws, room, after, me,
            ).toInt()
            val named = sql.query(
                """SELECT actor, mentions FROM event WHERE ws = ? AND room = ? AND seq > ? AND kind = 'message.posted'
                     AND actor != ? AND redacted = 0 AND mentions IS NOT NULL AND instr(mentions, ?) > 0 ORDER BY seq""",
                ws, room, after, me, me,
            ) { it.text(0) to it.text(1) }
            var mentions = 0
            for ((actor, json) in named) {
                if (mentions >= BADGE_CAP) break
                if (actor in skip) continue
                val list = runCatching { RukooJson.decodeFromString(MENTIONS, json) }.getOrNull() ?: continue
                if (list.any { it.actor == me }) mentions++
            }
            return Badges(unread, mentions)
        }

        // ---- tombstones ----

        fun addTombstones(ws: String, ids: Collection<String>, at: Long = now()) {
            for (id in ids) sql.exec("INSERT INTO tombstone (ws, message, at) VALUES (?, ?, ?) ON CONFLICT (ws, message) DO NOTHING", ws, id, at)
        }

        fun hasTombstone(ws: String, id: String): Boolean = sql.one("SELECT 1 FROM tombstone WHERE ws = ? AND message = ?", ws, id) { true } ?: false

        /** Tombstones from before [before] go; a pass that installs prunes those older than 14 days. */
        fun pruneTombstones(ws: String, before: Long): Int = sql.exec("DELETE FROM tombstone WHERE ws = ? AND at < ?", ws, before)

        // ---- directory ----

        /**
         * Each replace swaps the workspace's rows and clears its stale flag. The caller's own row also sets the
         * workspace's role and name, so a role someone else gave me reaches the workspace list before the next `GET /`.
         * A role that crosses the guest line also marks the channels stale: the server bumps only the members for a
         * role change, and a promoted guest has no channel directory yet while a demoted member keeps one too many.
         */
        fun replaceMembers(ws: String, rows: List<Member>, more: Boolean = false) {
            sql.exec("DELETE FROM member WHERE ws = ?", ws)
            for (m in rows) {
                sql.exec(
                    "INSERT INTO member (ws, id, kind, name, role, state, joinedAt, agent) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (ws, id) DO NOTHING",
                    ws, m.id, m.kind, m.name, m.role, m.state, m.joinedAt,
                    m.agent?.let { RukooJson.encodeToString(AgentSettings.serializer(), it) },
                )
            }
            sql.exec("UPDATE ws SET membersStale = 0, membersMore = ? WHERE id = ?", more, ws)
            val row = getWs(ws)
            rows.firstOrNull { it.id == row?.me }?.let {
                val crossed = (row?.role == "guest") != (it.role == "guest")
                sql.exec(
                    "UPDATE ws SET role = ?, myName = ?, channelsStale = CASE WHEN ? THEN 1 ELSE channelsStale END WHERE id = ?",
                    it.role, it.name, crossed, ws,
                )
            }
            sql.touch(ws)
        }

        fun listMembers(ws: String): List<Member> =
            sql.query("SELECT id, kind, name, role, state, joinedAt, agent FROM member WHERE ws = ? ORDER BY id", ws) { r ->
                // Settings this version can't read are left out; the member still shows, as an agent.
                val agent = r.textOrNull(6)?.let { runCatching { RukooJson.decodeFromString(AgentSettings.serializer(), it) }.getOrNull() }
                Member(r.text(0), r.text(1), r.text(2), r.text(3), r.text(4), r.long(5), agent)
            }

        fun replaceChannels(ws: String, rows: List<Channel>) {
            sql.exec("DELETE FROM channel WHERE ws = ?", ws)
            for (c in rows) {
                sql.exec(
                    "INSERT INTO channel (ws, id, name, visibility, archived, joined, role, members) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (ws, id) DO NOTHING",
                    ws, c.id, c.name, c.visibility, c.archived, c.joined, c.role, c.members,
                )
            }
            sql.exec("UPDATE ws SET channelsStale = 0 WHERE id = ?", ws)
            sql.touch(ws)
        }

        fun listChannels(ws: String): List<Channel> =
            sql.query("SELECT id, name, visibility, archived, joined, role, members FROM channel WHERE ws = ? ORDER BY id", ws) { r ->
                Channel(r.text(0), r.text(1), r.text(2), r.bool(3), r.bool(4), r.textOrNull(5), r.int(6))
            }

        fun replaceBlocks(ws: String, rows: List<Block>) {
            sql.exec("DELETE FROM block WHERE ws = ?", ws)
            for (b in rows) sql.exec("INSERT INTO block (ws, member, at) VALUES (?, ?, ?) ON CONFLICT (ws, member) DO NOTHING", ws, b.member, b.at)
            sql.exec("UPDATE ws SET blocksStale = 0 WHERE id = ?", ws)
            sql.touch(ws)
        }

        /** Newest first, as `GET /blocks` lists them. */
        fun listBlocks(ws: String): List<Block> =
            sql.query("SELECT member, at FROM block WHERE ws = ? ORDER BY at DESC, member", ws) { r -> Block(r.text(0), r.long(1)) }

        // ---- outbox ----

        /** A message to send, written before anything goes out (§3.8). */
        fun insertOutbox(row: OutboxRow): OutboxRow {
            sql.exec(
                """INSERT INTO outbox (local, ws, room, actor, grantId, generation, text, mentions, root, operationId, state, reason, attempts, nextAt, createdAt)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                row.local, row.ws, row.room, row.actor, row.grantId, row.generation, row.text,
                RukooJson.encodeToString(MENTIONS, row.mentions), row.root, row.operationId, row.state, row.reason,
                row.attempts, row.nextAt, row.createdAt,
            )
            sql.touch(row.ws, row.room)
            return getOutbox(row.local)!!
        }

        fun getOutbox(local: String): OutboxRow? = sql.one("SELECT $OUTBOX_COLUMNS FROM outbox WHERE local = ?", local, row = ::outboxRow)

        fun updateOutbox(local: String, fields: Map<String, Any?>): Boolean {
            val row = getOutbox(local) ?: return false
            val mapped = fields.mapValues { (k, v) -> if (k == "mentions" && v is List<*>) RukooJson.encodeToString(MENTIONS, v.filterIsInstance<Mention>()) else v }
            val changed = setFields("outbox", mapped, OUTBOX_FIELDS, "local = ?", local) > 0
            if (changed) sql.touch(row.ws, row.room)
            return changed
        }

        fun deleteOutbox(local: String): Boolean {
            val row = getOutbox(local) ?: return false
            sql.exec("DELETE FROM outbox WHERE local = ?", local)
            sql.touch(row.ws, row.room)
            return true
        }

        /** The room's unsent messages, oldest first. */
        fun outboxForRoom(ws: String, room: String): List<OutboxRow> =
            sql.query("SELECT $OUTBOX_COLUMNS FROM outbox WHERE ws = ? AND room = ? ORDER BY createdAt, local", ws, room, row = ::outboxRow)

        fun outboxForWs(ws: String): List<OutboxRow> =
            sql.query("SELECT $OUTBOX_COLUMNS FROM outbox WHERE ws = ? ORDER BY createdAt, local", ws, row = ::outboxRow)

        /**
         * The sends whose turn it is, oldest first, at most [limit]: per room only its oldest row, and only when that
         * row is queued and due. A row sending, held or failed holds back the later rows of its room. Workspaces that
         * aren't `ok` send nothing.
         */
        fun nextDue(now: Long, limit: Int): List<OutboxRow> = sql.query(
            """SELECT ${OUTBOX_COLUMNS.split(", ").joinToString(", ") { "o.$it" }} FROM outbox o JOIN ws w ON w.id = o.ws
               WHERE w.state = 'ok' AND o.state = 'queued' AND o.nextAt <= ?
                 AND NOT EXISTS (SELECT 1 FROM outbox p WHERE p.ws = o.ws AND p.room = o.room
                                 AND (p.createdAt < o.createdAt OR (p.createdAt = o.createdAt AND p.local < o.local)))
               ORDER BY o.createdAt, o.local LIMIT ?""",
            now, limit, row = ::outboxRow,
        )

        fun countUnsent(): Int = sql.long("SELECT COUNT(*) FROM outbox").toInt()

        /**
         * After a restore or Start over: every `queued`, `sending` and `held/stale_grant` row of the workspace, or only
         * those written under [generation] when given, becomes `queued` with `reason = 'lookup'`, so its operation is
         * looked up before anything else (§3.8). Returns how many rows it marked.
         */
        fun markLookup(ws: String, generation: String? = null): Int {
            val one = generation != null
            val marked = sql.exec(
                """UPDATE outbox SET state = 'queued', reason = 'lookup', nextAt = 0
                   WHERE ws = ?${if (one) " AND generation = ?" else ""}
                     AND (state IN ('queued', 'sending') OR (state = 'held' AND reason = 'stale_grant'))""",
                *(if (one) arrayOf(ws, generation) else arrayOf(ws)),
            )
            if (marked > 0) sql.touch(ws)
            return marked
        }

        // ---- drafts ----

        /** [root] null is the room's main composer. */
        fun getDraft(ws: String, room: String, root: String?): DraftRow? =
            sql.one("SELECT text, mentions, at FROM draft WHERE ws = ? AND room = ? AND root = ?", ws, room, root.orEmpty()) { r ->
                DraftRow(r.text(0), RukooJson.decodeFromString(MENTIONS, r.text(1)), r.long(2))
            }

        fun putDraft(ws: String, room: String, root: String?, draft: Draft) {
            sql.exec(
                """INSERT INTO draft (ws, room, root, text, mentions, at) VALUES (?, ?, ?, ?, ?, ?)
                   ON CONFLICT (ws, room, root) DO UPDATE SET text = excluded.text, mentions = excluded.mentions, at = excluded.at""",
                ws, room, root.orEmpty(), draft.text, RukooJson.encodeToString(MENTIONS, draft.mentions), now(),
            )
            sql.touch(ws, room)
        }

        fun deleteDraft(ws: String, room: String, root: String?) {
            if (sql.exec("DELETE FROM draft WHERE ws = ? AND room = ? AND root = ?", ws, room, root.orEmpty()) > 0) sql.touch(ws, room)
        }

        // ---- notices ----

        fun addNotices(ws: String, room: String, rows: List<Notice>) {
            for (n in rows) {
                sql.exec(
                    "INSERT INTO notice (ws, room, message, seq) VALUES (?, ?, ?, ?) ON CONFLICT (ws, room, message) DO UPDATE SET seq = excluded.seq",
                    ws, room, n.message, n.seq,
                )
            }
        }

        fun noticesForRoom(ws: String, room: String): List<Notice> =
            sql.query("SELECT message, seq FROM notice WHERE ws = ? AND room = ? ORDER BY seq", ws, room) { r -> Notice(r.text(0), r.long(1)) }

        /** The room's notices for [messages], or all of them when null. Returns the ones that went. */
        fun deleteNotices(ws: String, room: String, messages: Collection<String>? = null): List<Notice> {
            val rows = noticesForRoom(ws, room).filter { messages == null || it.message in messages }
            for (n in rows) sql.exec("DELETE FROM notice WHERE ws = ? AND room = ? AND message = ?", ws, room, n.message)
            return rows
        }

        // ---- helpers ----

        private fun setFields(table: String, fields: Map<String, Any?>, allowed: Set<String>, where: String, vararg keys: Any?): Int {
            if (fields.isEmpty()) return 0
            for (k in fields.keys) require(k in allowed) { "$table has no field $k" }
            val set = fields.keys.joinToString(", ") { "$it = ?" }
            val args = ArrayList<Any?>(fields.values)
            args.addAll(keys)
            return sql.exec("UPDATE $table SET $set WHERE $where", *args.toTypedArray())
        }

        private fun wsRow(r: Row) = WsRow(
            id = r.text(0), name = r.text(1), role = r.text(2), me = r.textOrNull(3), myName = r.textOrNull(4),
            generation = r.textOrNull(5), keyId = r.textOrNull(6), limits = r.textOrNull(7), retention = r.textOrNull(8),
            cursor = r.textOrNull(9), passing = r.bool(10), fresh = r.bool(11), state = r.text(12), membersStale = r.bool(13),
            channelsStale = r.bool(14), blocksStale = r.bool(15), membersMore = r.bool(16), syncedAt = r.longOrNull(17),
            activeAt = r.longOrNull(18),
        )

        private fun roomRow(r: Row) = RoomRow(
            ws = r.text(0), id = r.text(1), kind = r.text(2), name = r.textOrNull(3), visibility = r.text(4),
            archived = r.bool(5), closedReason = r.textOrNull(6),
            participants = r.textOrNull(7)?.let { RukooJson.decodeFromString(STRINGS, it) }, startedBy = r.textOrNull(8),
            grantId = r.text(9), role = r.textOrNull(10), members = r.int(11), head = r.long(12), floor = r.long(13),
            lastAt = r.longOrNull(14), read = r.long(15), readLocal = r.long(16), readSent = r.long(17), unread = r.int(18),
            mentions = r.int(19), lo = r.longOrNull(20), hi = r.longOrNull(21), notified = r.long(22), muted = r.bool(23),
            agents = r.int(24),
        )

        private fun event(r: Row) = Event(
            seq = r.long(0), id = r.text(1), kind = r.text(2), actor = r.text(3), at = r.long(4), root = r.textOrNull(5),
            text = r.textOrNull(6),
            mentions = r.textOrNull(7)?.let { RukooJson.decodeFromString(MENTIONS, it) } ?: emptyList(),
            redacted = r.bool(9),
            data = r.textOrNull(8)?.let { RukooJson.decodeFromString(EventData.serializer(), it) } ?: EventData(),
        )

        private fun outboxRow(r: Row) = OutboxRow(
            local = r.text(0), ws = r.text(1), room = r.text(2), actor = r.text(3), grantId = r.text(4), generation = r.text(5),
            text = r.text(6), mentions = RukooJson.decodeFromString(MENTIONS, r.text(7)), root = r.textOrNull(8),
            operationId = r.textOrNull(9), state = r.text(10), reason = r.textOrNull(11), attempts = r.int(12),
            nextAt = r.long(13), createdAt = r.long(14),
        )
    }

    companion object {
        /** At most this many events cached per room (§3.19). */
        const val ROOM_CACHE_MAX = 2000

        /** Badges count to this, as the server's do. */
        const val BADGE_CAP = 100

        /** Tombstones older than this go when a pass installs (§3.5). */
        const val TOMBSTONE_MS = 14L * 24 * 60 * 60 * 1000

        private val STRINGS = ListSerializer(String.serializer())
        private val MENTIONS = ListSerializer(Mention.serializer())

        private const val WS_COLUMNS =
            "id, name, role, me, myName, generation, keyId, limits, retention, cursor, passing, fresh, state, membersStale, channelsStale, blocksStale, membersMore, syncedAt, activeAt"
        private const val ROOM_COLUMNS =
            "ws, id, kind, name, visibility, archived, closedReason, participants, startedBy, grantId, role, members, head, floor, lastAt, read, readLocal, readSent, unread, mentions, lo, hi, notified, muted, agents"
        private const val EVENT_COLUMNS = "seq, id, kind, actor, at, root, text, mentions, data, redacted"
        private const val OUTBOX_COLUMNS =
            "local, ws, room, actor, grantId, generation, text, mentions, root, operationId, state, reason, attempts, nextAt, createdAt"

        /** The columns updateWs, setRoomFields and updateOutbox may set. */
        val WS_FIELDS = WS_COLUMNS.split(", ").toSet() - "id"
        val ROOM_FIELDS = ROOM_COLUMNS.split(", ").toSet() - setOf("ws", "id")
        val OUTBOX_FIELDS = setOf("grantId", "generation", "text", "mentions", "root", "operationId", "state", "reason", "attempts", "nextAt")
    }
}
