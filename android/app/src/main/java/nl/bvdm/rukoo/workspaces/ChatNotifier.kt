package nl.bvdm.rukoo.workspaces

import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.Person
import kotlin.coroutines.cancellation.CancellationException
import nl.bvdm.rukoo.MainActivity
import nl.bvdm.rukoo.R
import nl.bvdm.rukoo.ui.Notifications
import nl.bvdm.rukoo.ui.Screen
import nl.bvdm.rukoo.ui.chat.ChatNames
import nl.bvdm.rukoo.ui.chat.chatNames
import nl.bvdm.rukoo.ui.mail.ResourceStrings
import nl.bvdm.rukoo.ui.settings.NotificationPermission

/**
 * When a room is worth an alert and what one shows (contract §3.10). Pure, so the rule is tested without Android.
 * Desktop's src/main/workspaces/notify.js follows the same rule.
 */
object ChatAlertRules {
    /** Lines of an alert: the newest messages it shows. */
    const val LINES = 3

    /** Each line's text is cut to this many characters. */
    const val BODY_CHARS = 120

    /** `events?before=<head + 1>&limit=20` loads a room's newest messages when the cache doesn't hold them. */
    const val FETCH = 20

    /** §3.19 `NOTIFY_ROOMS`: rooms that get an alert of their own per run; more make one summary. */
    const val NOTIFY_ROOMS = 3

    /** The notification tag of a room's alert, which also names it in [ChatAlertSink]. */
    fun roomKey(ws: String, room: String) = "chat:$ws:$room"

    /** The notification tag of a workspace's summary of the rooms beyond [NOTIFY_ROOMS]. */
    fun summaryKey(ws: String) = "chat:$ws:summary"

    /** What every chat alert's tag starts with, and those of one workspace. */
    const val PREFIX = "chat:"
    fun workspacePrefix(ws: String) = "chat:$ws:"

    /** A room asks for an alert: new messages past what an alert covered, and a DM with unread messages or a channel with mentions. */
    fun due(room: RoomRow): Boolean =
        room.head > room.notified && (if (room.kind == RoomKind.DM.wire) room.unread > 0 else room.mentions > 0)

    /**
     * A due room still stays silent: chat notifications are off (Settings > Notifications), the person muted it, or it
     * is on screen in the resumed app.
     */
    fun silenced(notifyChat: Boolean, muted: Boolean, onScreen: Boolean): Boolean = !notifyChat || muted || onScreen

    /** The room is on screen in the resumed app: Chat shows it in the foreground. Anywhere else, Mail included, it isn't. */
    fun onScreen(screen: Screen, ws: String, room: String): Boolean =
        screen.foreground && screen.chatWorkspace == ws && screen.chatRoom == room

    /** Read on this phone or another one to the position the alert covered, or beyond: the alert goes. */
    fun readTo(room: RoomRow): Boolean = maxOf(room.read, room.readLocal) >= room.notified

    /**
     * A message worth a line: someone else's, not removed, not from a person [blocked], and for a channel one that
     * mentions [me]. Every message of someone else counts in a DM.
     */
    fun qualifies(actor: String, text: String?, mentions: List<Mention>, redacted: Boolean, dm: Boolean, me: String, blocked: Set<String>): Boolean {
        if (actor == me || actor in blocked || redacted || text.isNullOrEmpty()) return false
        return dm || mentions.any { it.actor == me }
    }

    /**
     * A message's text as one line: each mention as the text its author sent, with `@` before it when it lacks one;
     * white space folded; the first [BODY_CHARS] characters, with an ellipsis when cut. A mention that breaks a rule of
     * §3.17 stays plain text.
     */
    fun alertText(text: String, mentions: List<Mention>): String {
        val spans = Utf8Offsets.fromWire(text, mentions).sortedBy { it.start }
        val built = StringBuilder()
        var at = 0
        for (s in spans) {
            built.append(text, at, s.start)
            val part = text.substring(s.start, s.end)
            if (!part.startsWith("@")) built.append('@')
            built.append(part)
            at = s.end
        }
        built.append(text, at, text.length)
        val folded = built.toString().replace(WHITE, " ").trim()
        val points = folded.codePointCount(0, folded.length)
        if (points <= BODY_CHARS) return folded
        return folded.substring(0, folded.offsetByCodePoints(0, BODY_CHARS)).trimEnd() + "…"
    }

    private val WHITE = Regex("\\s+")
}

/** One line of an alert: who wrote it, its text as [ChatAlertRules.alertText] gives it, and when. */
data class AlertLine(val message: String, val seq: Long, val at: Long, val author: String, val text: String)

/**
 * An alert as the engine decided it, worded and ready to post. [key] is its notification tag. A tap opens [room] of
 * [ws] at [seq]. A summary has no [lines]; [body] says how many conversations it stands for.
 */
data class ChatAlert(
    val key: String,
    val ws: String,
    val room: String,
    val seq: Long,
    /** `#channel` or the DM's people, with the workspace's name after it when there are several. */
    val title: String,
    /** The person's own name in the workspace, for MessagingStyle. */
    val me: String,
    /** A channel or a DM of more than two people. */
    val group: Boolean,
    val lines: List<AlertLine>,
    /** The text without MessagingStyle: "Name: text" lines, or the summary's sentence. */
    val body: String,
    val summary: Boolean = false,
    /** The workspace's name when there are several workspaces, which [title] already ends with; else null. */
    val workspace: String? = null,
)

/**
 * How a room's alert sets up MessagingStyle. Android titles a conversation with a title "title: sender", so a
 * one-to-one DM gets no conversation title and isn't a group: Android titles it with the sender, and the workspace's
 * name, when there are several, goes in the header as [subText]. A channel or group DM keeps [ChatAlert.title].
 */
data class ChatAlertStyle(val conversationTitle: String?, val group: Boolean, val subText: String?) {
    companion object {
        fun of(alert: ChatAlert): ChatAlertStyle =
            if (alert.group) ChatAlertStyle(alert.title, true, null) else ChatAlertStyle(null, false, alert.workspace)
    }
}

/** Where alerts go: Android's notifications ([ChatNotifier]), or a recorder in tests. Posting may be refused quietly. */
interface ChatAlertSink {
    fun show(alert: ChatAlert)

    /** The alert with this key goes; nothing happens when there is none. */
    fun hide(key: String)

    /** Every alert whose key starts with [prefix], also those posted before this process started. */
    fun hideAll(prefix: String)
}

/** How alerts word names (desktop `displayName`, `dmTitle`, `chat.notify.*`), from the interface language. */
interface ChatAlertWords {
    val names: ChatNames
    fun line(name: String, text: String): String
    fun summaryTitle(): String
    fun summaryBody(count: Int): String
}

/**
 * Alerts for direct messages and mentions, and taking them back (contract §3.10), as desktop's notify.js does them.
 *
 * After each run, also the first after the app starts, a room is due when its head is above `notified` and it asks
 * for attention. A due room alerts when chat notifications are on, it isn't muted and it isn't on screen in the
 * resumed app. The pass that first fills a workspace sets `notified = head` for every room (FeedApplier), so it
 * alerts nothing; a later pass alerts as usual.
 *
 * An alert shows up to three of the newest messages after `max(read, readLocal, notified)`: for a channel the ones
 * that mention the person, for a DM every message of someone else, never removed ones or those of people the person
 * blocked. The cache gives them when it covers that range, else `events?before=<head + 1>&limit=20` loads them, for
 * at most three rooms per run. Three rooms alert per run, newest activity first; a fourth or more make one summary.
 * After an alert, `notified = head` and a notice row for each message shown, so a read or a removal can take it back.
 *
 * Where the contract is silent this follows desktop: a due room that is silenced, or whose new messages hold nothing
 * to show, gets `notified = head` without an alert, so unmuting doesn't bring old messages back; one whose messages
 * couldn't load stays due for the next run.
 *
 * The summary shows no messages and so has no notice rows: reading every room it counts takes it back, and so do an
 * eviction, a reset, the workspace going and the end of the session; a removed message doesn't. After a restart the
 * engine no longer knows which rooms an earlier summary counted, so that one goes once no room of the workspace could
 * still stand behind it: none unmuted, asking for attention, read to less than `notified`, without an alert of its own.
 */
class ChatAlertEngine(
    private val sink: ChatAlertSink,
    private val words: () -> ChatAlertWords,
    private val enabled: () -> Boolean,
    private val onScreen: (ws: String, room: String) -> Boolean,
    private val notifyRooms: Int = ChatAlertRules.NOTIFY_ROOMS,
) {
    /** What an alert on screen stands for: a room's messages, or the rooms of a summary. */
    private class Shown(val ws: String, val room: String?, val messages: Set<String>, val rooms: MutableSet<String>)

    private val lock = Any()
    private val shown = HashMap<String, Shown>()

    // Workspaces whose summary this process tracks or already settled; any other may still show one from before the
    // process started.
    private val settled = HashSet<String>()

    private class Context(val me: String, val myName: String, val members: Map<String, Member>, val blocked: Set<String>, val suffix: String?)

    // The newest message a fetch for a DM's alert loaded, by "ws/room": the DM row's preview while the cache doesn't
    // hold it yet (§7.4). It stays out of the cache, whose range the room loader owns.
    private val fetchedNewest = HashMap<String, Event>()

    private fun previewKey(ws: String, room: String) = "$ws/$room"

    /** The newest message an alert's fetch loaded for the DM [room] of [ws], for its row's preview; null when none did. */
    fun fetchedPreview(ws: String, room: String): Event? = synchronized(lock) { fetchedNewest[previewKey(ws, room)] }

    /**
     * The end of a run of [ws]: alerts that a read here or elsewhere took back go, then the due rooms alert. [fetch]
     * loads a room's newest events (`events?before=<head + 1>&limit=20`); its failure leaves the room due.
     */
    suspend fun afterRun(ws: String, store: WorkspaceStore, fetch: suspend (RoomRow) -> EventPage) {
        val row = store.read { getWs(ws) } ?: return
        takeBackRead(ws, store)
        settleSummary(ws, store)
        val me = row.me ?: return
        if (row.state != FeedApplier.STATE_OK || row.fresh) return
        val due = store.read { listRooms(ws).filter(ChatAlertRules::due) }
            .sortedWith(compareByDescending<RoomRow> { it.lastAt ?: 0 }.thenByDescending { it.head }.thenBy { it.id })
        if (due.isEmpty()) return
        val ctx = store.read {
            val members = listMembers(ws).associateBy { it.id }
            Context(
                me = me,
                myName = members[me]?.name ?: row.myName.orEmpty(),
                members = members,
                blocked = listBlocks(ws).mapTo(HashSet()) { it.member },
                suffix = if (listWs().size > 1) row.name else null,
            )
        }
        var slots = notifyRooms
        var fetches = notifyRooms
        val rest = ArrayList<RoomRow>()
        for (d in due) {
            var room = store.read { getRoom(ws, d.id) } ?: continue
            if (!ChatAlertRules.due(room)) continue
            if (silenced(ws, room)) {
                mark(store, ws, room.id, room.head)
                continue
            }
            val after = maxOf(room.read, room.readLocal, room.notified)
            // The cache first, also for the rooms beyond three: one it shows to hold nothing new to show isn't due.
            var messages = cached(store, ws, room, after, ctx)
            if (messages != null && messages.isEmpty()) {
                mark(store, ws, room.id, room.head)
                continue
            }
            if (slots <= 0) {
                rest += room
                continue
            }
            if (messages == null) {
                if (fetches <= 0) {
                    rest += room
                    continue
                }
                fetches -= 1
                val page = try {
                    fetch(room)
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    // Not now: the room stays due for the next run.
                    continue
                }
                if (room.kind == RoomKind.DM.wire) keepNewest(store, ws, room, page)
                // Meanwhile the person may have read it, muted it or opened it.
                room = store.read { getRoom(ws, d.id) } ?: continue
                if (!ChatAlertRules.due(room)) continue
                if (silenced(ws, room)) {
                    mark(store, ws, room.id, room.head)
                    continue
                }
                messages = fetched(store, ws, page, room, after, ctx)
                // The page didn't reach back to after + 1 and showed nothing: what's new may be older than the page.
                if (messages == null) {
                    rest += room
                    continue
                }
                if (messages.isEmpty()) {
                    mark(store, ws, room.id, room.head)
                    continue
                }
            }
            alert(store, ws, room, messages, ctx)
            slots -= 1
        }
        if (rest.isNotEmpty()) summarize(store, ws, rest, ctx)
    }

    /** This phone read the room further: its alert goes once the read reaches what the alert covered. */
    suspend fun onRead(ws: String, room: String, store: WorkspaceStore) {
        val row = store.read { getRoom(ws, room) }
        if (row == null || ChatAlertRules.readTo(row)) takeBack(ws, room, store)
    }

    /** What a feed page, a pass install or a reset of [ws] did: a reset takes back every alert, else removals and evictions. */
    suspend fun onPage(ws: String, result: PageResult, store: WorkspaceStore) {
        if (result.reset) {
            onReset(ws)
            return
        }
        for ((room, ids) in result.removed) onRemoved(ws, room, ids, store)
        for (room in result.evicted) onEvicted(ws, room)
    }

    /**
     * Messages of the room were removed (`removed`, `removedMore`, a floor): the room's alert goes when it showed one of
     * them, by its notice rows or what this process showed. The summary showed none, so it keeps counting the room.
     */
    suspend fun onRemoved(ws: String, room: String, ids: Collection<String>, store: WorkspaceStore) {
        if (ids.isEmpty()) return
        // A kept preview that was removed shows as removed, as a cached one does.
        synchronized(lock) {
            val key = previewKey(ws, room)
            fetchedNewest[key]?.takeIf { it.id in ids }?.let { fetchedNewest[key] = it.copy(text = null, mentions = emptyList(), redacted = true) }
        }
        val noticed = store.read { if (getRoom(ws, room) != null) noticesForRoom(ws, room).map { it.message }.toSet() else emptySet() }
        val entry = synchronized(lock) { shown[ChatAlertRules.roomKey(ws, room)] }
        if (ids.any { it in noticed || (entry != null && it in entry.messages) }) takeBack(ws, room, store, summary = false)
    }

    /** The person lost the room: its alert goes, and the summary stops counting it. Its notice rows went with the room. */
    fun onEvicted(ws: String, room: String) {
        synchronized(lock) { fetchedNewest.remove(previewKey(ws, room)) }
        forget(ws, room)
        sink.hide(ChatAlertRules.roomKey(ws, room))
    }

    /**
     * A `410` reset of [ws]: the removals missed before it can't be listed, so every alert of the workspace goes, the
     * summary and those posted before this process started included (§3.10). The reset deleted the notice rows.
     */
    fun onReset(ws: String) = dropWorkspace(ws)

    /** The person lost the workspace: every alert of it goes. */
    fun onWorkspaceGone(ws: String) = dropWorkspace(ws)

    /** The session ended: every chat alert goes. The service deletes the cache with its notice rows. */
    fun clear() {
        synchronized(lock) {
            shown.clear()
            settled.clear()
            fetchedNewest.clear()
        }
        sink.hideAll(ChatAlertRules.PREFIX)
    }

    private fun dropWorkspace(ws: String) {
        synchronized(lock) {
            shown.entries.removeAll { it.value.ws == ws }
            settled += ws
            fetchedNewest.keys.removeAll { it.startsWith(previewKey(ws, "")) }
        }
        sink.hideAll(ChatAlertRules.workspacePrefix(ws))
    }

    // ---- alerts ----

    private fun silenced(ws: String, room: RoomRow) = ChatAlertRules.silenced(enabled(), room.muted, onScreen(ws, room.id))

    private fun qualifies(e: Event, room: RoomRow, ctx: Context) =
        e.isMessage && ChatAlertRules.qualifies(e.actor, e.text, e.mentions, e.redacted, room.kind == RoomKind.DM.wire, ctx.me, ctx.blocked)

    /**
     * The messages to show from the cache: up to three of the newest after [after]; empty when it holds every event
     * after [after] that still exists and none to show; null when it can't tell, because it doesn't reach head, or
     * doesn't reach back to after + 1 (or the floor) and holds none to show.
     */
    private suspend fun cached(store: WorkspaceStore, ws: String, room: RoomRow, after: Long, ctx: Context): List<Event>? {
        val hi = room.hi ?: return null
        if (hi < room.head) return null
        val rows = store.read { eventsFrom(ws, room.id, after + 1, Int.MAX_VALUE) }
            .filter { it.seq <= room.head && qualifies(it, room, ctx) }
        if (rows.isNotEmpty()) return rows.takeLast(ChatAlertRules.LINES)
        val lo = room.lo ?: return null
        return if (lo <= maxOf(after + 1, room.floor)) emptyList() else null
    }

    /**
     * The messages to show from the server's newest events, which this doesn't keep: the room loader owns the cached
     * range. Empty only when the page saw every event after [after]: it held the oldest there are or reached back to
     * after + 1. A full page of other events that stops short of that gives null.
     */
    private suspend fun fetched(store: WorkspaceStore, ws: String, page: EventPage, room: RoomRow, after: Long, ctx: Context): List<Event>? {
        val gone = store.read { page.events.filter { it.isMessage && hasTombstone(ws, it.id) }.mapTo(HashSet()) { it.id } }
        val shownEvents = page.events
            .filter { it.seq > after && it.seq <= room.head && it.id !in gone }
            .map { Event(it.seq, it.id, it.kind, it.actor, it.at, it.root, it.text, it.mentions, it.redacted) }
            .filter { qualifies(it, room, ctx) }
            .takeLast(ChatAlertRules.LINES)
        if (shownEvents.isNotEmpty()) return shownEvents
        val reached = !page.more || (page.events.isNotEmpty() && page.events.first().seq <= after + 1)
        return if (reached) emptyList() else null
    }

    // Keeps the page's newest message that still exists as the DM's preview, when it is newer than the one kept.
    private suspend fun keepNewest(store: WorkspaceStore, ws: String, room: RoomRow, page: EventPage) {
        val newest = page.events.filter { it.kind == WireEvent.MESSAGE_POSTED && it.seq <= room.head }.maxByOrNull { it.seq } ?: return
        if (store.read { hasTombstone(ws, newest.id) }) return
        val event = Event(newest.seq, newest.id, newest.kind, newest.actor, newest.at, newest.root, newest.text, newest.mentions, newest.redacted)
        synchronized(lock) {
            val key = previewKey(ws, room.id)
            val kept = fetchedNewest[key]
            if (kept == null || kept.seq < event.seq) fetchedNewest[key] = event
        }
    }

    private fun title(room: RoomRow, ctx: Context, w: ChatAlertWords): String {
        val base = if (room.kind == RoomKind.DM.wire) w.names.dmTitle(room.participants, ctx.members, ctx.me) else "#${room.name.orEmpty()}"
        return if (ctx.suffix != null) "$base · ${ctx.suffix}" else base
    }

    private suspend fun mark(store: WorkspaceStore, ws: String, room: String, head: Long) {
        store.tx { markNotified(ws, room, head) }
    }

    private fun WorkspaceStore.StoreTx.markNotified(ws: String, room: String, head: Long) {
        val r = getRoom(ws, room) ?: return
        if (r.notified < head) setRoomFields(ws, room, mapOf("notified" to head))
    }

    // One room's alert, which replaces the one it had.
    private suspend fun alert(store: WorkspaceStore, ws: String, room: RoomRow, messages: List<Event>, ctx: Context) {
        val w = words()
        val key = ChatAlertRules.roomKey(ws, room.id)
        store.tx {
            markNotified(ws, room.id, room.head)
            deleteNotices(ws, room.id)
            addNotices(ws, room.id, messages.map { Notice(it.id, it.seq) })
        }
        synchronized(lock) { shown[key] = Shown(ws, room.id, messages.mapTo(HashSet()) { it.id }, HashSet()) }
        val lines = messages.map { m ->
            AlertLine(m.id, m.seq, m.at, w.names.display(ctx.members[m.actor]), ChatAlertRules.alertText(m.text.orEmpty(), m.mentions))
        }
        sink.show(
            ChatAlert(
                key = key,
                ws = ws,
                room = room.id,
                seq = messages.last().seq,
                title = title(room, ctx, w),
                me = ctx.myName,
                group = room.kind != RoomKind.DM.wire || (room.participants?.distinct()?.size ?: 0) > 2,
                lines = lines,
                body = lines.joinToString("\n") { w.line(it.author, it.text) },
                workspace = ctx.suffix,
            ),
        )
    }

    // The rooms beyond three: one alert for the workspace, which counts the rooms it stands for.
    private suspend fun summarize(store: WorkspaceStore, ws: String, rooms: List<RoomRow>, ctx: Context) {
        val w = words()
        val key = ChatAlertRules.summaryKey(ws)
        store.tx { for (r in rooms) markNotified(ws, r.id, r.head) }
        val count = synchronized(lock) {
            val entry = shown.getOrPut(key) { Shown(ws, null, emptySet(), HashSet()) }
            entry.rooms += rooms.map { it.id }
            // This summary replaces one from before the process started, and is tracked from here on.
            settled += ws
            entry.rooms.size
        }
        val title = w.summaryTitle().let { if (ctx.suffix != null) "$it · ${ctx.suffix}" else it }
        sink.show(
            ChatAlert(
                key = key,
                ws = ws,
                room = rooms.first().id,
                seq = rooms.first().head,
                title = title,
                me = ctx.myName,
                group = true,
                lines = emptyList(),
                body = w.summaryBody(count),
                summary = true,
            ),
        )
    }

    // ---- taking back ----

    // Drops the room's own alert from what is on screen and, with [summary], the room from the summary, which goes once
    // it stands for no room. True when the room had an alert of its own here.
    private fun forget(ws: String, room: String, summary: Boolean = true): Boolean {
        var hideSummary = false
        val had = synchronized(lock) {
            val had = shown.remove(ChatAlertRules.roomKey(ws, room)) != null
            val entry = if (summary) shown[ChatAlertRules.summaryKey(ws)] else null
            if (entry != null && entry.rooms.remove(room) && entry.rooms.isEmpty()) {
                shown.remove(ChatAlertRules.summaryKey(ws))
                hideSummary = true
            }
            had
        }
        if (hideSummary) sink.hide(ChatAlertRules.summaryKey(ws))
        return had
    }

    // The room's alert goes, with its notice rows; with [summary] the summary stops counting the room too.
    private suspend fun takeBack(ws: String, room: String, store: WorkspaceStore, force: Boolean = false, summary: Boolean = true) {
        var had = forget(ws, room, summary)
        val deleted = try {
            store.tx { if (getRoom(ws, room) != null) deleteNotices(ws, room).isNotEmpty() else false }
        } catch (e: WorkspaceError) {
            false
        }
        if (deleted) had = true
        if (had || force) sink.hide(ChatAlertRules.roomKey(ws, room))
    }

    // After a run: the rooms with an alert that were read to it, here or on another device, or are gone.
    private suspend fun takeBackRead(ws: String, store: WorkspaceStore) {
        val rooms = LinkedHashSet<String>(store.read { sql.query("SELECT DISTINCT room FROM notice WHERE ws = ?", ws) { it.text(0) } })
        synchronized(lock) {
            for (entry in shown.values) {
                if (entry.ws != ws) continue
                entry.room?.let { rooms += it }
                rooms += entry.rooms
            }
        }
        for (room in rooms) {
            val row = store.read { getRoom(ws, room) }
            if (row == null || ChatAlertRules.readTo(row)) takeBack(ws, room, store, force = row == null)
        }
    }

    // A summary posted before this process started, which nothing here tracks: it goes once no room of the workspace
    // could still stand behind it. Until then each run looks again; a new summary takes its place and is tracked.
    private suspend fun settleSummary(ws: String, store: WorkspaceStore) {
        if (synchronized(lock) { ws in settled }) return
        val waiting = store.read {
            val alerted = sql.query("SELECT DISTINCT room FROM notice WHERE ws = ?", ws) { it.text(0) }.toHashSet()
            listRooms(ws).any { r ->
                r.id !in alerted && !r.muted && !ChatAlertRules.readTo(r) &&
                    (if (r.kind == RoomKind.DM.wire) r.unread > 0 else r.mentions > 0)
            }
        }
        if (waiting) return
        synchronized(lock) {
            if (!settled.add(ws)) return
        }
        sink.hide(ChatAlertRules.summaryKey(ws))
    }
}

/**
 * Posts team chat alerts on the `chat` channel ([Notifications.CHANNEL_CHAT]) with MessagingStyle, and takes them
 * back. Each alert's tag is its key (`chat:<ws>:<room>` or `chat:<ws>:summary`) with one shared id, so a workspace's
 * alerts and the session's can be found again after the process was gone. Each workspace's alerts form a group. A tap
 * opens MainActivity with [MainActivity.EXTRA_WORKSPACE_ID], [MainActivity.EXTRA_ROOM_ID] and [MainActivity.EXTRA_SEQ].
 * Without the notification permission, or with Rukoo's notifications off in Android's settings, nothing is posted.
 */
class ChatNotifier(context: Context) : ChatAlertSink, ChatAlertWords {
    private val context = context.applicationContext

    private fun strings() = ResourceStrings(context.resources)

    override val names: ChatNames get() = chatNames(strings())

    override fun line(name: String, text: String): String = context.getString(R.string.chat_notify_body, name, text)

    override fun summaryTitle(): String = context.getString(R.string.chat_notify_summary_title)

    override fun summaryBody(count: Int): String = context.resources.getQuantityString(R.plurals.chat_notify_summary_body, count, count)

    private fun allowed(): Boolean = NotificationPermission.granted(context) && NotificationManagerCompat.from(context).areNotificationsEnabled()

    override fun show(alert: ChatAlert) {
        if (!allowed()) return
        val open = Intent(context, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            .putExtra(MainActivity.EXTRA_WORKSPACE_ID, alert.ws)
            .putExtra(MainActivity.EXTRA_ROOM_ID, alert.room)
            .putExtra(MainActivity.EXTRA_SEQ, alert.seq)
        val pending = PendingIntent.getActivity(context, alert.key.hashCode(), open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val builder = NotificationCompat.Builder(context, Notifications.CHANNEL_CHAT)
            .setSmallIcon(R.drawable.ic_stat_rukoo)
            .setContentTitle(alert.title)
            .setContentText(alert.body.substringAfterLast('\n'))
            .setContentIntent(pending)
            .setAutoCancel(true)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setGroup(GROUP_PREFIX + alert.ws)
        if (alert.summary || alert.lines.isEmpty()) {
            builder.setStyle(NotificationCompat.BigTextStyle().bigText(alert.body))
        } else {
            val spec = ChatAlertStyle.of(alert)
            val style = NotificationCompat.MessagingStyle(Person.Builder().setName(alert.me.ifEmpty { " " }).build())
                .setConversationTitle(spec.conversationTitle)
                .setGroupConversation(spec.group)
            if (spec.subText != null) builder.setSubText(spec.subText)
            for (l in alert.lines) style.addMessage(l.text, l.at, Person.Builder().setName(l.author).build())
            builder.setStyle(style)
        }
        try {
            NotificationManagerCompat.from(context).notify(alert.key, NOTIFICATION_ID, builder.build())
        } catch (_: SecurityException) {
            // The permission went away between the check and the post.
        }
    }

    override fun hide(key: String) {
        NotificationManagerCompat.from(context).cancel(key, NOTIFICATION_ID)
    }

    override fun hideAll(prefix: String) {
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        val active = try {
            manager.activeNotifications.orEmpty()
        } catch (_: RuntimeException) {
            return
        }
        for (n in active) {
            val tag = n.tag ?: continue
            if (tag.startsWith(prefix) && n.id == NOTIFICATION_ID) manager.cancel(tag, NOTIFICATION_ID)
        }
    }

    companion object {
        /** Every chat alert's notification id; its tag tells them apart. */
        const val NOTIFICATION_ID = 7001

        private const val GROUP_PREFIX = "chat:"
    }
}
