package nl.bvdm.rukoo.ui.chat

import java.time.LocalDate
import java.time.ZoneId
import java.time.ZonedDateTime
import java.util.Locale
import nl.bvdm.rukoo.ui.chat.ChatTimeline.Context
import nl.bvdm.rukoo.ui.chat.ChatTimeline.Message
import nl.bvdm.rukoo.ui.chat.ChatTimeline.Row
import nl.bvdm.rukoo.ui.chat.ChatTimeline.SysKind
import nl.bvdm.rukoo.workspaces.Event
import nl.bvdm.rukoo.workspaces.EventData
import nl.bvdm.rukoo.workspaces.Mention
import nl.bvdm.rukoo.workspaces.Pending
import nl.bvdm.rukoo.workspaces.PendingState
import nl.bvdm.rukoo.workspaces.ReplySummary
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** A room's timeline (contract §3.13, §3.18): rows, reply rows and root summaries, the New divider, pending rows. */
class ChatTimelineTest {
    private val zone = ZoneId.of("Europe/Amsterdam")
    private val me = u("me")
    private val sanne = u("sanne")
    private val mila = u("mila")

    // 19 November 2026, 10:00 in Amsterdam.
    private val t0 = ZonedDateTime.of(2026, 11, 19, 10, 0, 0, 0, zone).toInstant().toEpochMilli()
    private val minute = 60_000L

    private fun rows(events: List<Event>, pending: List<Pending> = emptyList(), readAtOpen: Long? = null, root: String? = null, floor: Long = 1, hasOlder: Boolean = false, replies: Map<String, ReplySummary> = emptyMap(), blocked: Set<String> = emptySet()) =
        ChatTimeline.rows(events, pending, me, readAtOpen, root, floor, hasOlder, blocked, replies, zone)

    private fun List<Row>.messages() = filterIsInstance<Message>()

    @Test
    fun `rows come in seq order with a day divider per day and one row per seq`() {
        val events = listOf(
            msg(3, sanne, t0 + 24 * 60 * minute, "tomorrow"),
            msg(1, sanne, t0, "one"),
            msg(2, mila, t0 + minute, "two"),
            msg(2, mila, t0 + minute, "two again"),
        )
        val r = rows(events)
        assertEquals(
            listOf("intro", "day:2026-11-19", "e_1", "e_2", "day:2026-11-20", "e_3"),
            r.map { it.key },
        )
        assertEquals(LocalDate.of(2026, 11, 20), (r[4] as ChatTimeline.Day).date)
    }

    @Test
    fun `a group continues for the same author within 5 minutes, and breaks otherwise`() {
        val events = listOf(
            msg(1, sanne, t0, "a"),
            msg(2, sanne, t0 + 4 * minute, "b"),
            msg(3, sanne, t0 + 9 * minute + 1, "c"),
            msg(4, mila, t0 + 10 * minute, "d"),
            msg(5, mila, t0 + 11 * minute, null, redacted = true),
            msg(6, mila, t0 + 12 * minute, "f"),
            sys(7, "member.joined", sanne, t0 + 13 * minute, member = sanne),
            msg(8, mila, t0 + 14 * minute, "h"),
        )
        val heads = rows(events).messages().associate { it.seq to it.head }
        assertEquals(mapOf(1L to true, 2L to false, 3L to true, 4L to true, 5L to true, 6L to true, 8L to true), heads)
    }

    @Test
    fun `the New divider goes before the first message by someone else after the read position at open`() {
        val events = listOf(
            msg(1, sanne, t0, "read"),
            msg(2, me, t0 + minute, "mine, unread"),
            msg(3, sanne, t0 + 2 * minute, "new"),
            msg(4, mila, t0 + 3 * minute, "newer"),
        )
        val keys = rows(events, readAtOpen = 1).map { it.key }
        assertEquals(listOf("intro", "day:2026-11-19", "e_1", "e_2", "new", "e_3", "e_4"), keys)
        // The message after the divider starts a group.
        assertTrue(rows(events, readAtOpen = 1).messages().first { it.seq == 3L }.head)
        // Nothing new, nothing unknown: no divider. A thread never has one.
        assertFalse(rows(events, readAtOpen = 4).any { it is ChatTimeline.New })
        assertFalse(rows(events, readAtOpen = null).any { it is ChatTimeline.New })
        assertFalse(rows(events + msg(5, sanne, t0 + 4 * minute, "reply", root = "e_1"), readAtOpen = 1, root = "e_1").any { it is ChatTimeline.New })
    }

    @Test
    fun `replies show in the main timeline as reply rows with their context line`() {
        val long = "x".repeat(130)
        val events = listOf(
            msg(1, sanne, t0, "Root\n question"),
            msg(2, mila, t0 + minute, long),
            msg(3, mila, t0 + 2 * minute, "first reply", root = "e_1"),
            msg(4, mila, t0 + 3 * minute, "second reply", root = "e_1"),
            msg(5, sanne, t0 + 4 * minute, "to the long one", root = "e_2"),
            msg(6, me, t0 + 5 * minute, "to one not cached", root = "e_0"),
            msg(7, mila, t0 + 6 * minute, null, redacted = true),
            msg(8, sanne, t0 + 7 * minute, "to a removed one", root = "e_7"),
        )
        val m = rows(events).messages().associateBy { it.seq }
        assertTrue(m.getValue(3).reply)
        assertEquals(Context.Quote("e_1", sanne, "Root question"), m.getValue(3).context)
        // Consecutive replies to the same root by the same author group, with the context line once.
        assertTrue(m.getValue(3).head)
        assertFalse(m.getValue(4).head)
        assertEquals("x".repeat(120) + "…", (m.getValue(5).context as Context.Quote).text)
        assertEquals(Context.Missing("e_0"), m.getValue(6).context)
        assertEquals(Context.Removed("e_7"), m.getValue(8).context)
        // A reply after a top-level message by the same author starts a group.
        assertTrue(m.getValue(3).head)
        assertFalse(m.getValue(1).reply)
        assertNull(m.getValue(1).context)
    }

    @Test
    fun `a top-level message with replies carries its summary, new only for others' replies after the read position`() {
        val events = listOf(
            msg(1, sanne, t0, "root"),
            msg(2, mila, t0 + minute, "r1", root = "e_1"),
            msg(3, sanne, t0 + 2 * minute, "r2", root = "e_1"),
            msg(4, me, t0 + 3 * minute, "r3", root = "e_1"),
            msg(5, sanne, t0 + 4 * minute, "plain"),
        )
        val root = rows(events, readAtOpen = 2).messages().first { it.seq == 1L }
        val r = root.replies!!
        assertEquals(3, r.count)
        assertEquals(t0 + 3 * minute, r.lastAt)
        assertEquals(listOf(me, sanne, mila), r.actors)
        assertTrue("Sanne's reply at 3 is after the read position 2", r.hasNew)
        // Only your own reply is newer: nothing new for you.
        assertFalse(rows(events, readAtOpen = 3).messages().first { it.seq == 1L }.replies!!.hasNew)
        assertNull(rows(events).messages().first { it.seq == 5L }.replies)
        // Replies outside the events on hand count through the engine's summary.
        val summary = mapOf("e_5" to ReplySummary(count = 12, lastSeq = 90, lastAt = t0 + 50 * minute, authors = listOf(mila, sanne)))
        val far = rows(events, readAtOpen = 4, replies = summary).messages().first { it.seq == 5L }.replies!!
        assertEquals(12, far.count)
        assertEquals(t0 + 50 * minute, far.lastAt)
        assertEquals(listOf(mila, sanne), far.actors)
        assertTrue(far.hasNew)
        // A removed root keeps its summary, so its thread stays reachable.
        val removedRoot = rows(listOf(msg(1, sanne, t0, null, redacted = true), msg(2, mila, t0 + minute, "r", root = "e_1"))).messages().first()
        assertTrue(removedRoot.removed)
        assertEquals(1, removedRoot.replies!!.count)
    }

    @Test
    fun `pending rows come after the sent ones in the order they were written, and never on an earlier day`() {
        val events = listOf(msg(1, sanne, t0, "sent"), msg(2, mila, t0 + 2 * minute, "sent later"))
        val pending = listOf(
            pending("l2", createdAt = t0 + 5 * minute, state = PendingState.QUEUED),
            pending("l1", createdAt = t0 + minute, state = PendingState.SENDING),
            // Written yesterday and held since: it takes today's place after the sent rows.
            pending("l0", createdAt = t0 - 24 * 60 * minute, state = PendingState.HELD, reason = "stale_grant"),
            pending("lr", createdAt = t0 + 6 * minute, state = PendingState.FAILED, reason = "quota", root = "e_1"),
        )
        val r = rows(events, pending)
        assertEquals(listOf("intro", "day:2026-11-19", "e_1", "e_2", "local:l0", "local:l1", "local:l2", "local:lr"), r.map { it.key })
        val rows = r.messages().associateBy { it.key }
        assertEquals(PendingState.HELD, rows.getValue("local:l0").pending)
        assertEquals("stale_grant", rows.getValue("local:l0").reason)
        assertEquals(me, rows.getValue("local:l1").actor)
        assertNull(rows.getValue("local:l1").seq)
        // A pending reply is a reply row too.
        assertTrue(rows.getValue("local:lr").reply)
        // A thread shows only its own pending replies.
        assertEquals(listOf("e_1", "local:lr"), rows(events, pending, root = "e_1").messages().map { it.key })
    }

    @Test
    fun `system rows say who did what, and a removal shows on its target`() {
        val events = listOf(
            sys(1, "channel.created", sanne, t0, name = "plans"),
            sys(2, "member.joined", mila, t0, member = mila),
            sys(3, "member.joined", sanne, t0, member = mila),
            sys(4, "member.left", mila, t0, member = mila),
            sys(5, "member.left", sanne, t0, member = mila),
            sys(6, "channel.renamed", sanne, t0, name = "plans-2"),
            sys(7, "channel.archived", sanne, t0),
            sys(8, "dm.started", sanne, t0),
            sys(9, "message.redacted", sanne, t0),
            sys(10, "member.role", sanne, t0, member = mila),
        )
        val kinds = rows(events).filterIsInstance<ChatTimeline.Sys>().map { it.kind }
        assertEquals(
            listOf(SysKind.CREATED, SysKind.JOINED, SysKind.ADDED, SysKind.LEFT, SysKind.REMOVED_BY, SysKind.RENAMED, SysKind.ARCHIVED, SysKind.DM_STARTED),
            kinds,
        )
        assertEquals("plans", rows(events).filterIsInstance<ChatTimeline.Sys>().first().name)
    }

    @Test
    fun `the start of the conversation or the retention note, only when nothing older can load`() {
        val one = listOf(msg(5, sanne, t0, "hi"))
        assertEquals(ChatTimeline.Intro, rows(one, floor = 1).first())
        assertEquals(ChatTimeline.Floor, rows(one, floor = 4).first())
        assertTrue(rows(one, hasOlder = true).none { it == ChatTimeline.Intro || it == ChatTimeline.Floor })
        assertTrue(rows(one, root = "e_5").none { it == ChatTimeline.Intro || it == ChatTimeline.Floor })
    }

    @Test
    fun `a thread shows its root and replies only`() {
        val events = listOf(
            msg(1, sanne, t0, "root"),
            msg(2, mila, t0 + minute, "other"),
            msg(3, mila, t0 + 2 * minute, "reply", root = "e_1"),
        )
        val r = rows(events, root = "e_1").messages()
        assertEquals(listOf(1L, 3L), r.map { it.seq })
        assertFalse("inside a thread a reply is a plain message", r.last().reply)
        assertNull(r.last().context)
    }

    @Test
    fun `mentions of me count unless their author is blocked`() {
        val text = "Hi @Me and @Mila"
        val mentions = listOf(Mention(me, 3, 6), Mention(mila, 11, 16))
        val events = listOf(Event(1, "e_1", "message.posted", sanne, t0, null, text, mentions, false))
        assertTrue(rows(events).messages().single().mentionsMe)
        assertFalse(rows(events, blocked = setOf(sanne)).messages().single().mentionsMe)
        // Your own message never mentions you, and a broken range counts for nothing.
        assertFalse(ChatTimeline.mentionsMe(text, mentions, me, me, blocked = false))
        assertFalse(ChatTimeline.mentionsMe(text, listOf(Mention(me, 3, 99)), sanne, me, blocked = false))
    }

    @Test
    fun `reading takes the newest sent message fully in view, and the Latest pill counts others' messages`() {
        val events = listOf(msg(1, sanne, t0, "a"), msg(2, me, t0 + minute, "b"), sys(3, "member.joined", mila, t0 + 2 * minute, member = mila), msg(4, mila, t0 + 3 * minute, "c"))
        val r = rows(events, listOf(pending("l1", createdAt = t0 + 4 * minute, state = PendingState.SENDING)))
        assertEquals(2L, ChatTimeline.readableSeq(r, listOf("e_1", "e_2", "e_3", "local:l1")))
        assertEquals(4L, ChatTimeline.readableSeq(r, setOf("e_4")))
        assertNull(ChatTimeline.readableSeq(r, listOf("e_3", "local:l1", "intro")))
        assertNull(ChatTimeline.readableSeq(r, emptyList()))
        assertEquals(1, ChatTimeline.newSince(r, seenSeq = 1, me = me))
        assertEquals(2, ChatTimeline.newSince(r, seenSeq = 0, me = me))
    }

    @Test
    fun `text runs mark mentions, mentions of me and http links`() {
        val text = "See https://rukoo.io/x, @Me and @Mila, not ftp://a.b"
        val mentions = listOf(Mention(me, 24, 27), Mention(mila, 32, 37))
        val s = ChatText.segments(text, mentions, me, blocked = false)
        assertEquals(text, s.joinToString("") { text.substring(it.start, it.end) })
        assertEquals(
            listOf(ChatText.Kind.TEXT, ChatText.Kind.LINK, ChatText.Kind.TEXT, ChatText.Kind.MENTION_ME, ChatText.Kind.TEXT, ChatText.Kind.MENTION, ChatText.Kind.TEXT),
            s.map { it.kind },
        )
        assertEquals("https://rukoo.io/x", s.first { it.kind == ChatText.Kind.LINK }.url)
        // From someone you blocked, mentions are plain text; links stay.
        assertTrue(ChatText.segments(text, mentions, me, blocked = true).none { it.kind == ChatText.Kind.MENTION || it.kind == ChatText.Kind.MENTION_ME })
        // Byte offsets: a mention after an emoji and a diaeresis lands on the right characters.
        val umlaut = "😀 @Zoë!"
        val zoe = u("zoe")
        val m = ChatText.segments(umlaut, listOf(Mention(zoe, 5, 10)), me, blocked = false).single { it.kind == ChatText.Kind.MENTION }
        assertEquals("@Zoë", umlaut.substring(m.start, m.end))
    }

    @Test
    fun `day labels say Today, Yesterday, the weekday, then the date`() {
        val days = ChatDays(Locale.UK, "Today", "Yesterday", zone)
        assertEquals("Today", days.label(LocalDate.of(2026, 11, 19), t0))
        assertEquals("Yesterday", days.label(LocalDate.of(2026, 11, 18), t0))
        assertEquals("Monday", days.label(LocalDate.of(2026, 11, 16), t0))
        assertEquals("12 November", days.label(LocalDate.of(2026, 11, 12), t0))
        assertEquals("3 March 2025", days.label(LocalDate.of(2025, 3, 3), t0))
        assertEquals("19 November 2026", days.date(t0))
        assertEquals("maandag", ChatDays(Locale.forLanguageTag("nl"), "Vandaag", "Gisteren", zone).label(LocalDate.of(2026, 11, 16), t0).lowercase())
    }

    @Test
    fun `snippets flatten white space and stop at 120 characters`() {
        assertEquals("a b c", ChatTimeline.snippet(" a\n b\t c "))
        val emoji = "😀".repeat(121)
        assertEquals("😀".repeat(120) + "…", ChatTimeline.snippet(emoji))
    }

    // ---- helpers ----

    private fun u(name: String) = "u_" + name.padEnd(22, 'x')

    private fun msg(seq: Long, actor: String, at: Long, text: String?, root: String? = null, redacted: Boolean = false) =
        Event(seq, "e_$seq", "message.posted", actor, at, root, if (redacted) null else text, emptyList(), redacted)

    private fun sys(seq: Long, kind: String, actor: String, at: Long, member: String? = null, name: String? = null) =
        Event(seq, "e_$seq", kind, actor, at, null, null, emptyList(), false, EventData(name = name, member = member))

    private fun pending(local: String, createdAt: Long, state: PendingState, reason: String? = null, root: String? = null) =
        Pending(local, "w_1", "c_1", root, "text $local", emptyList(), state, reason, nextAt = 0, createdAt = createdAt)
}
