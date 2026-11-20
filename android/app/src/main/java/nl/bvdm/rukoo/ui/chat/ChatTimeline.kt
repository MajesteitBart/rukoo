package nl.bvdm.rukoo.ui.chat

import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.temporal.ChronoUnit
import java.util.EnumSet
import java.util.Locale
import nl.bvdm.rukoo.workspaces.Event
import nl.bvdm.rukoo.workspaces.Mention
import nl.bvdm.rukoo.workspaces.Pending
import nl.bvdm.rukoo.workspaces.PendingState
import nl.bvdm.rukoo.workspaces.ReplySummary
import nl.bvdm.rukoo.workspaces.Utf8Offsets
import org.nibor.autolink.LinkExtractor
import org.nibor.autolink.LinkType

/**
 * A room's timeline as rows (contract §3.13 and §3.18), a port of desktop chat-model.js `timeline()`, pure so
 * ChatTimelineTest covers it. RoomPane draws the rows bottom up.
 */
object ChatTimeline {
    /** A message group ends after this long without one from the same author (§3.19 `GROUP_GAP`). */
    const val GROUP_MS = 5 * 60 * 1000L

    /** How much of a thread's first message a reply row quotes. */
    const val CONTEXT_CHARS = 120

    enum class SysKind { CREATED, RENAMED, ARCHIVED, JOINED, ADDED, LEFT, REMOVED_BY, DM_STARTED }

    sealed interface Row {
        val key: String
    }

    /** The start of the conversation: `floor` is 1 and nothing older exists. Not in a thread. */
    data object Intro : Row {
        override val key = "intro"
    }

    /** Older messages aged out: `floor` is above 1 and nothing older can load. Not in a thread. */
    data object Floor : Row {
        override val key = "floor"
    }

    /** A divider before the first row of a local day. */
    data class Day(val date: LocalDate, val at: Long) : Row {
        override val key = "day:$date"
    }

    /** Before the first message by someone else after the read position the room had when it opened. */
    data object New : Row {
        override val key = "new"
    }

    /** In a thread, between its first message and the replies: how many replies there are (desktop-ui 5.7). */
    data class Count(val count: Int) : Row {
        override val key = "count"
    }

    /** A system event, such as a join or a rename. */
    data class Sys(
        val id: String,
        val seq: Long,
        val kind: SysKind,
        val actor: String,
        val at: Long,
        /** The member a join or leave is about. */
        val member: String?,
        /** A channel's name, for created and renamed. */
        val name: String?,
    ) : Row {
        override val key = id
    }

    /** A root's replies as its summary shows them: up to three repliers, newest first. */
    data class Replies(val count: Int, val lastAt: Long?, val actors: List<String>, val hasNew: Boolean)

    /** The line above a reply row in the main timeline, about the thread's first message. */
    sealed interface Context {
        val root: String

        data class Quote(override val root: String, val actor: String, val text: String) : Context

        /** The root isn't cached: "replied in a thread". */
        data class Missing(override val root: String) : Context

        /** The root was removed: "replied to a removed message". */
        data class Removed(override val root: String) : Context
    }

    /**
     * A message, a reply row in the main timeline ([reply]), or a send on its way ([pending] set, keyed `local:{id}`).
     * [head] starts a group, with the avatar and the name line. [text] and [mentions] are empty once [removed].
     */
    data class Message(
        override val key: String,
        val seq: Long?,
        val id: String?,
        val local: String?,
        val actor: String,
        val at: Long,
        val root: String?,
        val reply: Boolean,
        val head: Boolean,
        val text: String?,
        val mentions: List<Mention>,
        val removed: Boolean,
        val mentionsMe: Boolean,
        val blocked: Boolean,
        val pending: PendingState?,
        val reason: String?,
        val nextAt: Long?,
        /** A top-level message's thread, when it has replies. */
        val replies: Replies?,
        val context: Context?,
    ) : Row

    private class Counts(var count: Int = 0, var lastAt: Long? = null, var newest: Long = 0, var newestOther: Long = 0, var actors: List<String> = emptyList())

    /**
     * The replies to each thread among [events], by root ID: how many, the newest and the newest by someone other than
     * [me], the latest reply's time and the latest three distinct authors of replies that weren't removed.
     */
    private fun counts(events: List<Event>, me: String?): Map<String, Counts> {
        val out = HashMap<String, Counts>()
        for (e in events) {
            val root = e.root ?: continue
            if (!e.isMessage) continue
            val c = out.getOrPut(root) { Counts() }
            c.count++
            c.newest = e.seq
            if (e.actor != me) c.newestOther = e.seq
            c.lastAt = e.at
            if (!e.redacted && e.text != null) c.actors = (listOf(e.actor) + c.actors.filter { it != e.actor }).take(3)
        }
        return out
    }

    private fun sysKind(e: Event): SysKind? {
        val member = e.data.member
        return when (e.kind) {
            "channel.created" -> SysKind.CREATED
            "channel.renamed" -> SysKind.RENAMED
            "channel.archived" -> SysKind.ARCHIVED
            "member.joined" -> if (member != null && member != e.actor) SysKind.ADDED else SysKind.JOINED
            "member.left" -> if (member != null && member != e.actor) SysKind.REMOVED_BY else SysKind.LEFT
            "dm.started" -> SysKind.DM_STARTED
            // message.redacted shows on its target; a kind this version doesn't know shows nothing.
            else -> null
        }
    }

    /** The start of a message on one line, for a reply row's context. */
    fun snippet(text: String): String {
        val flat = text.replace(Regex("\\s+"), " ").trim()
        val points = flat.codePointCount(0, flat.length)
        if (points <= CONTEXT_CHARS) return flat
        return flat.substring(0, flat.offsetByCodePoints(0, CONTEXT_CHARS)) + "…"
    }

    /** Whether a message by [actor] mentions [me] (§3.17): a valid range names them, from someone not blocked. */
    fun mentionsMe(text: String?, mentions: List<Mention>, actor: String, me: String?, blocked: Boolean): Boolean {
        if (text == null || me == null || actor == me || blocked) return false
        return Utf8Offsets.fromWire(text, mentions).any { it.actor == me }
    }

    /**
     * The rows of a room's main timeline, or of the thread of [root]. [readAtOpen] places the New divider; [replies]
     * is the engine's summary per root, which counts replies outside [events] too; [blocked] holds the people the
     * person blocked, whose mentions don't count. [zone] decides the days.
     */
    fun rows(
        events: List<Event>,
        pending: List<Pending> = emptyList(),
        me: String?,
        readAtOpen: Long? = null,
        root: String? = null,
        floor: Long = 1,
        hasOlder: Boolean = false,
        blocked: Set<String> = emptySet(),
        replies: Map<String, ReplySummary> = emptyMap(),
        zone: ZoneId = ZoneId.systemDefault(),
        groupMs: Long = GROUP_MS,
    ): List<Row> {
        // One row per seq, in seq order: a page loaded twice must not show a message twice.
        val list = events.sortedBy { it.seq }.distinctBy { it.seq }
        val messages = list.filter { it.isMessage }.associateBy { it.id }
        val counts = counts(list, me)
        val shown = if (root != null) list.filter { it.isMessage && (it.id == root || it.root == root) } else list
        val waiting = pending.filter { root == null || it.root == root }.sortedBy { it.createdAt }

        val rows = ArrayList<Row>()
        if (root == null && !hasOlder) rows += if (floor <= 1) Intro else Floor

        val days = HashSet<LocalDate>()
        var lastDay: LocalDate? = null
        var lastAt = Long.MIN_VALUE
        var prev: Message? = null
        var newPlaced = false

        fun dayBefore(at: Long) {
            val day = Instant.ofEpochMilli(at).atZone(zone).toLocalDate()
            if (day == lastDay || day in days) return
            rows += Day(day, day.atStartOfDay(zone).toInstant().toEpochMilli())
            days += day
            lastDay = day
            prev = null
        }

        fun addSys(e: Event, kind: SysKind) {
            dayBefore(e.at)
            lastAt = maxOf(lastAt, e.at)
            rows += Sys(e.id, e.seq, kind, e.actor, e.at, e.data.member, e.data.name)
            prev = null
        }

        fun addMessage(
            key: String, seq: Long?, id: String?, local: String?, actor: String, at: Long, threadOf: String?,
            text: String?, mentions: List<Mention>, removed: Boolean, state: PendingState?, reason: String?, nextAt: Long?,
        ) {
            val isPending = state != null
            // Pending rows come after every sent row, so one written before the last sent row (a held send from
            // yesterday, or a clock behind the server's) takes that row's day instead of a divider running backwards.
            dayBefore(if (isPending) maxOf(at, lastAt) else at)
            lastAt = maxOf(lastAt, at)
            if (root == null && !isPending && !newPlaced && readAtOpen != null && actor != me && seq != null && seq > readAtOpen) {
                rows += New
                newPlaced = true
                prev = null
            }
            val p = prev
            val head = !(p != null && p.actor == actor && at >= p.at && at - p.at < groupMs && !p.removed && !removed && p.root == threadOf)
            val isBlocked = actor in blocked
            val shownText = if (removed) null else text
            val shownMentions = if (removed) emptyList() else mentions
            var summary: Replies? = null
            if (threadOf == null && !isPending && id != null) {
                val c = counts[id]
                val s = replies[id]
                // The engine's summary counts replies outside the events on hand; what is on hand tells whose they are.
                val sNewer = s != null && s.lastSeq > (c?.newest ?: 0) && s.authors.firstOrNull() != me
                val newestOther = maxOf(c?.newestOther ?: 0, if (sNewer) s.lastSeq else 0)
                val count = maxOf(c?.count ?: 0, s?.count ?: 0)
                if (count > 0) {
                    summary = Replies(
                        count = count,
                        lastAt = if (s != null && s.lastSeq >= (c?.newest ?: 0)) s.lastAt else c?.lastAt,
                        actors = s?.authors?.takeIf { it.isNotEmpty() }?.take(3) ?: c?.actors.orEmpty(),
                        // Like the New divider, your own replies are never new to you.
                        hasNew = readAtOpen != null && newestOther > readAtOpen,
                    )
                }
            }
            val context = if (threadOf != null && root == null) {
                val top = messages[threadOf]
                when {
                    top == null -> Context.Missing(threadOf)
                    top.redacted || top.text == null -> Context.Removed(threadOf)
                    else -> Context.Quote(threadOf, top.actor, snippet(top.text))
                }
            } else {
                null
            }
            val row = Message(
                key = key,
                seq = seq,
                id = id,
                local = local,
                actor = actor,
                at = at,
                root = threadOf,
                reply = threadOf != null && root == null,
                head = head,
                text = shownText,
                mentions = shownMentions,
                removed = removed,
                mentionsMe = !removed && mentionsMe(shownText, shownMentions, actor, me, isBlocked),
                blocked = isBlocked,
                pending = state,
                reason = reason,
                nextAt = nextAt,
                replies = summary,
                context = context,
            )
            rows += row
            prev = row
        }

        for (e in shown) {
            if (e.isMessage) {
                addMessage(e.id, e.seq, e.id, null, e.actor, e.at, e.root, e.text, e.mentions, e.redacted || e.text == null, null, null, null)
                // A thread's first message, then how many replies follow; the first reply starts a group of its own.
                if (root != null && e.id == root) {
                    rows += Count(shown.count { it.root == root })
                    prev = null
                }
            } else {
                sysKind(e)?.let { addSys(e, it) }
            }
        }
        for (p in waiting) {
            addMessage("local:${p.local}", null, null, p.local, me.orEmpty(), p.createdAt, p.root, p.text, p.mentions, false, p.state, p.reason, p.nextAt.takeIf { it > 0 })
        }
        return rows
    }

    /**
     * The highest seq of a sent message among the rows whose keys are fully in view: what the main timeline reports as
     * read (§3.9). Pending rows, system rows and dividers don't count. Null when none is in view.
     */
    fun readableSeq(rows: List<Row>, inView: Collection<String>): Long? {
        if (inView.isEmpty()) return null
        val keys = inView as? Set<String> ?: inView.toSet()
        return rows.asSequence().filterIsInstance<Message>().filter { it.pending == null && it.seq != null && it.key in keys }.maxOfOrNull { it.seq!! }
    }

    /** How many messages by others came after [seenSeq]: the count on the Latest pill. */
    fun newSince(rows: List<Row>, seenSeq: Long, me: String?): Int =
        rows.count { it is Message && it.pending == null && (it.seq ?: 0) > seenSeq && it.actor != me }
}

/**
 * A message's text as runs to style (contract §3.17): plain text, mentions (of the person or of someone else) and
 * links. Links are http and https URLs only. Mentions from someone the person blocked render as plain text.
 */
object ChatText {
    enum class Kind { TEXT, MENTION, MENTION_ME, LINK }

    data class Segment(val start: Int, val end: Int, val kind: Kind, val actor: String? = null, val url: String? = null)

    private val extractor = LinkExtractor.builder().linkTypes(EnumSet.of(LinkType.URL)).build()

    fun links(text: String): List<Segment> = extractor.extractLinks(text).mapNotNull { link ->
        val url = text.substring(link.beginIndex, link.endIndex)
        val scheme = url.substringBefore(':', "").lowercase(Locale.ROOT)
        if (scheme != "http" && scheme != "https") null else Segment(link.beginIndex, link.endIndex, Kind.LINK, url = url)
    }

    fun segments(text: String, mentions: List<Mention>, me: String?, blocked: Boolean): List<Segment> {
        val marks = ArrayList<Segment>()
        if (!blocked) {
            for (m in Utf8Offsets.fromWire(text, mentions)) {
                marks += Segment(m.start, m.end, if (m.actor == me) Kind.MENTION_ME else Kind.MENTION, actor = m.actor)
            }
        }
        // A link inside a mention stays the mention.
        for (l in links(text)) if (marks.none { it.kind != Kind.LINK && l.start < it.end && it.start < l.end }) marks += l
        marks.sortBy { it.start }
        val out = ArrayList<Segment>()
        var at = 0
        for (s in marks) {
            if (s.start < at) continue
            if (s.start > at) out += Segment(at, s.start, Kind.TEXT)
            out += s
            at = s.end
        }
        if (at < text.length) out += Segment(at, text.length, Kind.TEXT)
        return out
    }
}

/**
 * The day dividers' labels: Today, Yesterday, the weekday within a week, the day and month this year, and the full
 * date before that. Desktop's groupLabel, with the day for older years too, since a divider names one day.
 */
class ChatDays(
    private val locale: Locale,
    private val today: String,
    private val yesterday: String,
    private val zone: ZoneId = ZoneId.systemDefault(),
) {
    private val weekday = DateTimeFormatter.ofPattern("EEEE", locale)
    private val dayMonth = DateTimeFormatter.ofPattern("d MMMM", locale)
    private val full = DateTimeFormatter.ofPattern("d MMMM yyyy", locale)

    /** A moment's full date, "19 November 2026", as the intro says when a channel was made. */
    fun date(at: Long): String = full.format(Instant.ofEpochMilli(at).atZone(zone))

    fun label(day: LocalDate, now: Long): String {
        val current = Instant.ofEpochMilli(now).atZone(zone).toLocalDate()
        val diff = ChronoUnit.DAYS.between(day, current)
        return when {
            diff <= 0L -> today
            diff == 1L -> yesterday
            diff < 7L -> weekday.format(day).replaceFirstChar { if (it.isLowerCase()) it.titlecase(locale) else it.toString() }
            day.year == current.year -> dayMonth.format(day)
            else -> full.format(day)
        }
    }
}
