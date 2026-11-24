package nl.bvdm.rukoo.ui.chat

import java.time.LocalDate
import java.time.ZoneId
import java.time.ZonedDateTime
import java.util.Locale
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

/**
 * A room's timeline (contract §3.13, §3.18): rows, replies that show only in their thread (issue #376) with the
 * summary under their first message and what is new on this visit, the New divider, pending rows, reading.
 */
class ChatTimelineTest {
    private val zone = ZoneId.of("Europe/Amsterdam")
    private val me = u("me")
    private val sanne = u("sanne")
    private val mila = u("mila")

    // 19 November 2026, 10:00 in Amsterdam.
    private val t0 = ZonedDateTime.of(2026, 11, 19, 10, 0, 0, 0, zone).toInstant().toEpochMilli()
    private val minute = 60_000L

    private fun rows(events: List<Event>, pending: List<Pending> = emptyList(), readAtOpen: Long? = null, root: String? = null, floor: Long = 1, hasOlder: Boolean = false, replies: Map<String, ReplySummary> = emptyMap(), blocked: Set<String> = emptySet(), seen: Map<String, Long> = emptyMap()) =
        ChatTimeline.rows(events, pending, me, readAtOpen, root, floor, hasOlder, blocked, replies, zone, seen = seen)

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
    fun `replies stay out of the main timeline, and their first message sums them up (issue 376)`() {
        val events = listOf(
            msg(1, sanne, t0, "Root question"),
            msg(2, mila, t0 + minute, "first reply", root = "e_1"),
            msg(3, me, t0 + 2 * minute, "to one not cached", root = "e_0"),
            msg(4, sanne, t0 + 3 * minute, "later, same author"),
        )
        val r = rows(events, readAtOpen = 1)
        assertEquals(listOf("intro", "day:2026-11-19", "e_1", "new", "e_4"), r.map { it.key })
        assertEquals(1, r.messages().first().replies!!.count)
        assertTrue(r.messages().none { it.root != null })
        // A reply between two messages of one author no longer breaks their group.
        assertFalse(rows(events).messages().last().head)
    }

    @Test
    fun `a summary's dot goes once its thread showed the replies, and comes back with a newer one`() {
        val events = listOf(
            msg(1, sanne, t0, "root"),
            msg(2, mila, t0 + minute, "r1", root = "e_1"),
            msg(3, mila, t0 + 2 * minute, "r2", root = "e_1"),
            msg(4, mila, t0 + 3 * minute, null, root = "e_1", redacted = true),
        )
        fun dot(seen: Map<String, Long>, readAt: Long = 1) = rows(events, readAtOpen = readAt, seen = seen).messages().first().replies!!.hasNew
        assertTrue(dot(emptyMap()))
        assertFalse(dot(mapOf("e_1" to 3L)))
        assertTrue("reply 3 came after", dot(mapOf("e_1" to 2L)))
        assertTrue("another thread showed", dot(mapOf("e_9" to 9L)))
        assertFalse("a removed reply is not new", dot(emptyMap(), readAt = 3))
    }

    @Test
    fun `newReplies lists the threads with replies new on this visit, the oldest new reply first`() {
        val events = listOf(
            msg(1, sanne, t0, "a"),
            msg(2, me, t0 + minute, "b"),
            msg(3, mila, t0 + 2 * minute, "read before the open", root = "e_1"),
            msg(4, sanne, t0 + 3 * minute, "to b", root = "e_2"),
            msg(5, me, t0 + 4 * minute, "mine", root = "e_1"),
            msg(6, mila, t0 + 5 * minute, "to a", root = "e_1"),
            msg(7, sanne, t0 + 6 * minute, "root not loaded", root = "e_0"),
        )
        assertEquals(
            listOf(ChatTimeline.NewReplies("e_2", 1, 4), ChatTimeline.NewReplies("e_1", 1, 6), ChatTimeline.NewReplies("e_0", 1, 7)),
            ChatTimeline.newReplies(events, me, readAtOpen = 3),
        )
        assertEquals(listOf(ChatTimeline.NewReplies("e_0", 1, 7)), ChatTimeline.newReplies(events, me, 3, mapOf("e_2" to 4L, "e_1" to 6L)))
        assertTrue(ChatTimeline.newReplies(events, me, readAtOpen = 7).isEmpty())
        assertTrue(ChatTimeline.newReplies(events, me, readAtOpen = null).isEmpty())
        assertEquals(ChatTimeline.NewReplies("e_1", 2, 3), ChatTimeline.newReplies(events, me, readAtOpen = 0).first())
    }

    @Test
    fun `what a thread showed counts for one opening of one room`() {
        val seen = ThreadsSeen().with("w", "c", 1, "e_1", 5)
        assertEquals(mapOf("e_1" to 5L), seen.of("w", "c", 1))
        assertTrue(seen.of("w", "c", 2).isEmpty())
        assertTrue(seen.of("w", "d", 1).isEmpty())
        assertTrue("an older reply changes nothing", seen.with("w", "c", 1, "e_1", 4) === seen)
        assertEquals(mapOf("e_1" to 6L, "e_2" to 3L), seen.with("w", "c", 1, "e_1", 6).with("w", "c", 1, "e_2", 3).of("w", "c", 1))
        assertEquals("another opening starts afresh", mapOf("e_2" to 3L), seen.with("w", "c", 2, "e_2", 3).of("w", "c", 2))
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
        val root = rows(events, readAtOpen = 2).messages().first { it.id == "e_1" }
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
        // A pending reply waits in its thread only.
        assertEquals(listOf("intro", "day:2026-11-19", "e_1", "e_2", "local:l0", "local:l1", "local:l2"), r.map { it.key })
        val rows = r.messages().associateBy { it.key }
        assertEquals(PendingState.HELD, rows.getValue("local:l0").pending)
        assertEquals("stale_grant", rows.getValue("local:l0").reason)
        assertEquals(me, rows.getValue("local:l1").actor)
        assertNull(rows.getValue("local:l1").seq)
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
        assertEquals("e_1", r.last().root)
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
        // e_2 reads on over the system event after it, which counts for nothing, up to the next message.
        assertEquals(3L, ChatTimeline.readableSeq(r, listOf("e_1", "e_2", "e_3", "local:l1")))
        assertEquals(4L, ChatTimeline.readableSeq(r, setOf("e_4")))
        assertNull(ChatTimeline.readableSeq(r, listOf("e_3", "local:l1", "intro")))
        assertNull(ChatTimeline.readableSeq(r, emptyList()))
        assertEquals(1, ChatTimeline.newSince(r, seenSeq = 1, me = me))
        assertEquals(2, ChatTimeline.newSince(r, seenSeq = 0, me = me))
    }

    @Test
    fun `reading a message reads on over the replies after it, which have no row of their own (issue 376)`() {
        val events = listOf(
            msg(1, sanne, t0, "a"),
            msg(2, mila, t0 + minute, "reply to a", root = "e_1"),
            msg(3, mila, t0 + 2 * minute, "another", root = "e_1"),
            msg(4, sanne, t0 + 3 * minute, "b"),
            msg(5, mila, t0 + 4 * minute, "reply to b", root = "e_4"),
        )
        val r = rows(events)
        assertEquals("up to the next message", 3L, ChatTimeline.readableSeq(r, listOf("e_1"), newest = 5))
        assertEquals("the last one reads to the newest event loaded", 5L, ChatTimeline.readableSeq(r, listOf("e_1", "e_4"), newest = 5))
        assertEquals(4L, ChatTimeline.readableSeq(r, listOf("e_4")))
        // Only replies loaded, their first messages further up: the start of the conversation in view reads them.
        val replies = rows(listOf(msg(6, mila, t0, "r", root = "e_0"), msg(7, mila, t0 + minute, "r2", root = "e_0")))
        assertEquals(7L, ChatTimeline.readableSeq(replies, listOf("intro"), newest = 7))
        assertEquals("the intro reads to the first message, less one", null, ChatTimeline.readableSeq(r, listOf("intro"), newest = 5))
        assertEquals(2L, ChatTimeline.readableSeq(rows(listOf(msg(2, mila, t0, "r", root = "e_0"), msg(3, sanne, t0, "first shown"))), listOf("intro"), newest = 3))
    }

    @Test
    fun `a room opened at a reply goes to its first message when that is loaded`() {
        val events = listOf(msg(1, sanne, t0, "a"), msg(2, mila, t0 + minute, "b"), msg(3, mila, t0 + 2 * minute, "reply", root = "e_1"), msg(4, mila, t0 + 3 * minute, "far", root = "e_0"))
        assertEquals(1L, ChatTimeline.openingSeq(events, 3))
        assertEquals("its first message isn't loaded", 4L, ChatTimeline.openingSeq(events, 4))
        assertEquals(2L, ChatTimeline.openingSeq(events, 2))
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
    fun `a kept scroll position comes back at the row it showed, after rows came while the room was folded`() {
        val events = (1L..6L).map { msg(it, if (it % 2 == 0L) sanne else mila, t0 + it * 10 * minute, "m$it") }
        val before = rows(events, readAtOpen = 6).asReversed().map { it.key }
        // Scrolled up to e_3, 12 pixels into it.
        val i = before.indexOf("e_3")
        val kept = TimelineScroll(opening = 7, key = "e_3", index = i, offset = 12)
        // Folded behind the list: two messages and a pending row came, the next day, so a day divider too.
        val later = events + listOf(msg(7, sanne, t0 + 24 * 60 * minute, "m7"), msg(8, mila, t0 + 24 * 60 * minute + minute, "m8"))
        val pending = listOf(pending("l_1", t0 + 24 * 60 * minute + 2 * minute, PendingState.SENDING))
        val after = rows(later, pending, readAtOpen = 6).asReversed().map { it.key }
        val (index, offset) = kept.restoreIn(after)
        assertEquals("e_3", after[index])
        assertTrue("every index moved, so the saved one would show a newer row", index > i)
        assertEquals(12, offset)
        // A row that went (removed with retention, say) falls back to the saved index.
        assertEquals(i to 12, kept.copy(key = "e_gone").restoreIn(after))
        // At the bottom it stays at the bottom, with what came meanwhile.
        assertEquals(0 to 30, TimelineScroll(7, "e_6", 0, 30).restoreIn(after))
        assertTrue(TimelineScroll(7, "e_6", 0, 30).atBottom)
        assertFalse(kept.atBottom)
    }

    // Review of #376, finding 1: a refused reply holds the sends after it, so it always keeps a way into its thread.
    @Test
    fun `an unsent reply keeps a way into its thread, on its removed first message or in a row of its own`() {
        val failed = pending("l_1", t0 + 2 * minute, PendingState.FAILED, reason = "invalid", root = "e_1")
        val next = pending("l_2", t0 + 3 * minute, PendingState.WAITING)
        // The reviewer's case: the first message was removed while the reply waited, and the server refused it.
        val r = rows(listOf(msg(1, sanne, t0, null, redacted = true), msg(2, sanne, t0 + minute, "later")), pending = listOf(failed, next), hasOlder = true)
        assertEquals(listOf("day:2026-11-19", "e_1", "e_2", "local:l_2"), r.map { it.key })
        val top = r.messages().first { it.id == "e_1" }
        assertTrue(top.removed)
        assertEquals(ChatTimeline.Replies(count = 0, lastAt = null, actors = emptyList(), hasNew = false, unsent = 1, failed = true), top.replies)
        assertTrue("the menu offers the thread", MessageRules.canReply(top, inThread = false))
        // ... where the refused reply shows with its state, so Discard is there.
        val thread = rows(listOf(msg(1, sanne, t0, null, redacted = true)), pending = listOf(failed, next), root = "e_1")
        assertEquals(PendingState.FAILED, thread.messages().single { it.local == "l_1" }.pending)
        // Sending, it says so without the failed look.
        val queued = rows(listOf(msg(1, sanne, t0, "a")), pending = listOf(failed.copy(state = PendingState.QUEUED)), hasOlder = true)
        assertEquals(1 to false, queued.messages().single().replies!!.let { it.unsent to it.failed })
        // The first message further up, not loaded: a row of its own after the sent rows, before the unsent messages.
        val away = rows(listOf(msg(2, sanne, t0 + minute, "later")), pending = listOf(failed, next), hasOlder = true)
        assertEquals(listOf("day:2026-11-19", "e_2", "thread:e_1", "local:l_2"), away.map { it.key })
        val orphan = away[2] as ChatTimeline.Orphan
        assertEquals(false, orphan.gone)
        assertEquals(1 to true, orphan.replies.unsent to orphan.replies.failed)
        assertTrue("nothing waits: no row", rows(listOf(msg(2, sanne, t0, "later")), hasOlder = true).none { it is ChatTimeline.Orphan })
    }

    // Review of #376, finding 3: replies whose first message retention took keep a row where it was.
    @Test
    fun `replies whose first message aged out keep a row where it was, with their summary and its dot`() {
        val events = listOf(msg(11, sanne, t0, "kept"), msg(12, mila, t0 + minute, "still on", root = "e_9"), msg(13, sanne, t0 + 2 * minute, "yes", root = "e_9"))
        val r = rows(events, floor = 11, readAtOpen = 12)
        assertEquals(listOf("floor", "thread:e_9", "day:2026-11-19", "e_11"), r.map { it.key })
        val orphan = r[1] as ChatTimeline.Orphan
        assertTrue(orphan.gone)
        assertEquals(2, orphan.replies.count)
        assertTrue(orphan.replies.hasNew)
        assertFalse(rows(events, floor = 11, readAtOpen = 12, seen = mapOf("e_9" to 13L)).filterIsInstance<ChatTimeline.Orphan>().single().replies.hasNew)
        assertTrue("older messages can still load: the pill says it", rows(events, hasOlder = true).none { it is ChatTimeline.Orphan })
        assertTrue("a thread has none", rows(events, root = "e_9").none { it is ChatTimeline.Orphan })
    }

    // Review of #376, finding 4: the pill goes by the reply line at the bottom of the row, not by the row.
    @Test
    fun `a reply line shows only whole in the view, bottom up as the room lays out`() {
        // A 400px row whose bottom 20px show above the view's bottom edge: its 34px line doesn't show whole.
        assertFalse(ChatTimeline.replyLineShown(offset = -14, size = 400, viewportStart = 0, viewportEnd = 1000, linePx = 34))
        assertTrue(ChatTimeline.replyLineShown(offset = 0, size = 400, viewportStart = 0, viewportEnd = 1000, linePx = 34))
        // Its top past the view's top edge, its line in view.
        assertTrue(ChatTimeline.replyLineShown(offset = 900, size = 400, viewportStart = 0, viewportEnd = 1000, linePx = 34))
        assertFalse(ChatTimeline.replyLineShown(offset = 980, size = 400, viewportStart = 0, viewportEnd = 1000, linePx = 34))
        // Top down, the line is the row's last pixels.
        assertFalse(ChatTimeline.replyLineShown(offset = 900, size = 400, viewportStart = 0, viewportEnd = 1000, linePx = 34, bottomUp = false))
        assertEquals("e_1", ChatTimeline.replyLineRoot("e_1"))
        assertEquals("e_9", ChatTimeline.replyLineRoot("thread:e_9"))
    }

    // Review of #376, finding 5: the visit's seen position follows the replies the thread showed in view.
    @Test
    fun `a thread marks as seen only the replies in view`() {
        val events = listOf(msg(1, me, t0, "q"), msg(2, sanne, t0 + minute, "a1", root = "e_1"), msg(3, mila, t0 + 2 * minute, "a2", root = "e_1"), msg(4, sanne, t0 + 3 * minute, "a3", root = "e_1"))
        val r = rows(events, root = "e_1")
        fun at(key: String, offset: Int) = ChatTimeline.InView(key, offset, 100)
        // Bottom up: e_4 below the view, e_3 half in view, e_2 and the root above it.
        assertEquals(3L, ChatTimeline.seenInThread(r, "e_1", listOf(at("e_4", -80), at("e_3", -50), at("e_2", 60), at("e_1", 160)), 0, 500))
        assertEquals("none in view", null, ChatTimeline.seenInThread(r, "e_1", listOf(at("e_1", 0)), 0, 500))
        assertEquals("a tall reply that fills the view counts", 2L, ChatTimeline.seenInThread(r, "e_1", listOf(ChatTimeline.InView("e_2", -200, 1000)), 0, 500))
    }

    // Review of #376, finding 6: a reply to a first message outside the loaded range adds an event and no row.
    @Test
    fun `an append that leaves the rows as they were still moves what reading the newest row reports`() {
        val events = listOf(msg(1, sanne, t0, "a"), msg(2, mila, t0 + minute, "b"))
        val appended = events + msg(3, mila, t0 + 2 * minute, "reply further up", root = "e_0")
        val before = rows(events, hasOlder = true)
        val after = rows(appended, hasOlder = true)
        assertEquals("the same rows: an effect keyed on them doesn't run again", before, after)
        assertEquals(2L, ChatTimeline.readableSeq(before, listOf("e_2"), newest = 2))
        assertEquals("the newest event, read as its own state, takes the read past the reply", 3L, ChatTimeline.readableSeq(after, listOf("e_2"), newest = 3))
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
