package nl.bvdm.rukoo.workspaces

import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.test.runTest
import nl.bvdm.rukoo.core.Clock
import nl.bvdm.rukoo.ui.Screen
import nl.bvdm.rukoo.ui.chat.ChatNames
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The alert rule of contract §3.10 on a real chat cache: DMs with unread messages and channels with mentions alert,
 * past `notified` only; mute, the setting and the room on screen in the resumed app silence them; the pass that first
 * fills a workspace alerts nothing and a later one alerts as usual; three rooms alert and the rest make one summary;
 * and a read here or elsewhere, a removal, an eviction, a reset, the workspace going and the end of the session take
 * alerts back. Desktop's test/chat-notify.test.js covers the same rule.
 */
class ChatAlertRulesTest {
    private val db = TestDb()

    @After
    fun tearDown() = db.close()

    private val ws = Ids.WS

    /** The alerts posted and taken back, and which are on screen now. */
    class RecordingSink : ChatAlertSink {
        val shown = CopyOnWriteArrayList<ChatAlert>()
        val hidden = CopyOnWriteArrayList<String>()
        val cleared = CopyOnWriteArrayList<String>()
        val active = LinkedHashMap<String, ChatAlert>()

        override fun show(alert: ChatAlert) {
            shown += alert
            synchronized(active) { active[alert.key] = alert }
        }

        override fun hide(key: String) {
            hidden += key
            synchronized(active) { active.remove(key) }
        }

        override fun hideAll(prefix: String) {
            cleared += prefix
            synchronized(active) { active.keys.removeAll { it.startsWith(prefix) } }
        }

        override fun active(prefix: String): List<String> = synchronized(active) { active.keys.filter { it.startsWith(prefix) } }

        fun activeKeys(): Set<String> = synchronized(active) { active.keys.toSet() }

        /** An alert with [key] on screen, as one an earlier process posted. */
        fun posted(key: String) = show(
            ChatAlert(key = key, ws = "", room = "", seq = 1, title = "", me = "", group = false, lines = emptyList(), body = ""),
        )
    }

    object Words : ChatAlertWords {
        override val names = ChatNames(
            former = "Former member",
            deleted = "Deleted member",
            others = { n -> " and $n others" },
            list = { names -> names.dropLast(1).joinToString(", ") + " and " + names.last() },
        )
        override fun line(name: String, text: String) = "$name: $text"
        override fun summaryTitle() = "Team chat"
        override fun summaryBody(count: Int) = if (count == 1) "New messages in 1 conversation" else "New messages in $count conversations"
    }

    private class Setup(val store: WorkspaceStore, val sink: RecordingSink, val engine: ChatAlertEngine) {
        var enabled = true
        var screen = Screen()
        val fetched = CopyOnWriteArrayList<String>()
        var pages: Map<String, EventPage> = emptyMap()
    }

    private suspend fun setup(fresh: Boolean = false, workspaces: Int = 1): Setup {
        val store = db.store()
        store.tx {
            insertWs(WsRow(id = ws, name = "Team", role = "member", me = Ids.ME, myName = "Me", generation = Ids.GEN, cursor = "c0", passing = false, fresh = fresh))
            if (workspaces > 1) insertWs(WsRow(id = Ids.WS2, name = "Other", role = "member", me = Ids.ME, passing = false, fresh = false))
            replaceMembers(
                ws,
                listOf(
                    Member(Ids.ME, name = "Me", role = "member", state = "active"),
                    Member(Ids.OLGA, name = "Olga", role = "member", state = "active"),
                    Member(Ids.SAM, name = "Sam", role = "member", state = "active"),
                ),
            )
        }
        lateinit var s: Setup
        val sink = RecordingSink()
        val engine = ChatAlertEngine(sink, { Words }, { s.enabled }, { w, r -> ChatAlertRules.onScreen(s.screen, w, r) })
        s = Setup(store, sink, engine)
        return s
    }

    private suspend fun Setup.run() = engine.afterRun(ws, store) { room ->
        fetched += room.id
        pages[room.id] ?: throw WorkspaceError("network")
    }

    /** A room with [events] cached as its whole range. */
    private suspend fun Setup.room(change: Change, vararg events: WireEvent) {
        store.tx {
            upsertRoom(ws, change)
            if (events.isNotEmpty()) appendEvents(ws, change.conversation, events.toList())
        }
    }

    /** [n] channels that each mention me once, the later ones more recently active. */
    private suspend fun Setup.mentionRooms(n: Int): List<String> {
        val ids = (0 until n).map { Ids.id("c", 11 + it) }
        ids.forEachIndexed { i, id ->
            val head = 10L + i
            room(
                room(id, name = "room$i", head = head, unread = 1, mentions = 1).copy(lastAt = 1_000L + i),
                msg(head, room = 5 + i, mentions = listOf(Mention(Ids.ME, 0, 3))),
            )
        }
        return ids
    }

    /** The room read on this phone up to its head. */
    private suspend fun Setup.readAll(id: String) {
        store.tx { setRoomFields(ws, id, mapOf("readLocal" to getRoom(ws, id)!!.head)) }
    }

    private suspend fun Setup.row(id: String = Ids.GENERAL): RoomRow = store.read { getRoom(ws, id)!! }

    private suspend fun Setup.notices(id: String = Ids.GENERAL): List<Notice> = store.read { noticesForRoom(ws, id) }

    @Test
    fun `a DM with unread messages past notified alerts once, with its newest messages`() = runTest {
        val s = setup()
        s.room(
            room(Ids.DM, dm = true, head = 4, read = 1, unread = 3),
            msg(1, actor = Ids.ME, room = 4),
            msg(2, text = "first", room = 4),
            msg(3, text = "second", room = 4),
            msg(4, text = "third\nline", room = 4),
        )
        s.run()
        assertEquals(1, s.sink.shown.size)
        val alert = s.sink.shown.single()
        assertEquals(ChatAlertRules.roomKey(ws, Ids.DM), alert.key)
        assertEquals("Olga", alert.title)
        assertEquals(listOf("first", "second", "third line"), alert.lines.map { it.text })
        assertEquals("Olga: first\nOlga: second\nOlga: third line", alert.body)
        assertEquals(4L, alert.seq)
        assertEquals("Me", alert.me)
        assertFalse("a one-to-one DM isn't a group conversation", alert.group)
        assertEquals(4L, s.row(Ids.DM).notified)
        assertEquals(listOf(2L, 3L, 4L), s.notices(Ids.DM).map { it.seq })

        s.run()
        assertEquals("nothing new past notified", 1, s.sink.shown.size)
    }

    @Test
    fun `MessagingStyle titles a one-to-one DM with the sender and keeps a group's or channel's title`() = runTest {
        val s = setup(workspaces = 2)
        s.room(room(Ids.DM, dm = true, head = 1, unread = 1), msg(1, text = "hi", room = 4))
        val group = Ids.id("d", 21)
        s.room(room(group, dm = true, head = 1, unread = 1).copy(participants = listOf(Ids.ME, Ids.OLGA, Ids.SAM)), msg(1, text = "all", room = 7))
        s.room(room(head = 1, unread = 1, mentions = 1), msg(1, text = "Me look", mentions = listOf(Mention(Ids.ME, 0, 2))))
        s.run()
        val byRoom = s.sink.shown.associateBy { it.room }

        // Android titles a conversation with a title "title: sender", which read "Olga · Team: Olga" for a DM.
        val dm = ChatAlertStyle.of(byRoom.getValue(Ids.DM))
        assertEquals("a one-to-one DM has no conversation title", null, dm.conversationTitle)
        assertFalse("a one-to-one DM isn't a group conversation", dm.group)
        assertEquals("the workspace's name goes in the header", "Team", dm.subText)

        val groupStyle = ChatAlertStyle.of(byRoom.getValue(group))
        assertEquals(ChatAlertStyle("Olga and Sam · Team", true, null), groupStyle)

        val channel = ChatAlertStyle.of(byRoom.getValue(Ids.GENERAL))
        assertEquals(ChatAlertStyle("#general · Team", true, null), channel)
    }

    @Test
    fun `with one workspace a one-to-one DM's alert has no header text`() {
        val alert = ChatAlert(
            key = "chat:w:d", ws = "w", room = "d", seq = 1, title = "Zoë de Vries", me = "Me", group = false,
            lines = listOf(AlertLine("m", 1, 1, "Zoë de Vries", "hi")), body = "Zoë de Vries: hi",
        )
        assertEquals(ChatAlertStyle(null, false, null), ChatAlertStyle.of(alert))
    }

    @Test
    fun `a channel alerts for mentions of me, not for unread messages alone`() = runTest {
        val s = setup()
        s.room(room(head = 2, unread = 2), msg(1), msg(2))
        s.run()
        assertTrue(s.sink.shown.isEmpty())
        assertEquals("a channel without mentions isn't due", 0L, s.row().notified)

        s.room(room(head = 4, unread = 4, mentions = 1), msg(3), msg(4, text = "Me look", mentions = listOf(Mention(Ids.ME, 0, 2))))
        s.run()
        val alert = s.sink.shown.single()
        assertEquals("#general", alert.title)
        assertEquals("only the message that mentions me shows", "Olga: @Me look", alert.body)
        assertTrue(alert.group)
        assertEquals(listOf(4L), s.notices().map { it.seq })
    }

    @Test
    fun `a muted room never alerts, and counts as notified so unmuting brings nothing back`() = runTest {
        val s = setup()
        s.room(room(Ids.DM, dm = true, head = 2, unread = 2), msg(1, room = 4), msg(2, room = 4))
        s.store.tx { setRoomFields(ws, Ids.DM, mapOf("muted" to true)) }
        s.run()
        assertTrue(s.sink.shown.isEmpty())
        assertEquals(2L, s.row(Ids.DM).notified)
        s.store.tx { setRoomFields(ws, Ids.DM, mapOf("muted" to false)) }
        s.run()
        assertTrue(s.sink.shown.isEmpty())
    }

    @Test
    fun `with team chat notifications off nothing alerts`() = runTest {
        val s = setup()
        s.enabled = false
        s.room(room(Ids.DM, dm = true, head = 1, unread = 1), msg(1, room = 4))
        s.run()
        assertTrue(s.sink.shown.isEmpty())
        assertEquals(1L, s.row(Ids.DM).notified)
    }

    @Test
    fun `the room on screen in the resumed app doesn't alert, but it does from Mail or the background`() = runTest {
        val s = setup()
        s.screen = Screen(foreground = true, chatWorkspace = ws, chatRoom = Ids.DM)
        s.room(room(Ids.DM, dm = true, head = 1, unread = 1), msg(1, room = 4))
        s.run()
        assertTrue(s.sink.shown.isEmpty())

        s.room(room(Ids.DM, dm = true, head = 2, unread = 2), msg(2, room = 4))
        s.screen = Screen(foreground = false, chatWorkspace = ws, chatRoom = Ids.DM)
        s.run()
        assertEquals("in the background the same room alerts", 1, s.sink.shown.size)

        s.room(room(Ids.DM, dm = true, head = 3, unread = 3), msg(3, room = 4))
        s.screen = Screen(foreground = true)
        s.run()
        assertEquals("in Mail, in the foreground, it alerts", 2, s.sink.shown.size)

        assertTrue(ChatAlertRules.onScreen(Screen(foreground = true, chatWorkspace = ws, chatRoom = Ids.DM), ws, Ids.DM))
        assertFalse(ChatAlertRules.onScreen(Screen(foreground = true, chatWorkspace = ws, chatRoom = Ids.GENERAL), ws, Ids.DM))
        assertFalse(ChatAlertRules.onScreen(Screen(foreground = true, chatWorkspace = Ids.WS2, chatRoom = Ids.DM), ws, Ids.DM))
    }

    @Test
    fun `the pass that first fills a workspace alerts nothing, and the next page does`() = runTest {
        val s = setup(fresh = true)
        s.store.tx { updateWs(ws, mapOf("cursor" to null, "passing" to true)) }
        val applier = FeedApplier(s.store, Clock { TestDb.NOW })
        applier.apply(ws, feed(room(Ids.DM, dm = true, head = 5, unread = 5), next = "p1"), sentCursor = null)
        assertEquals("the first pass counts every room as notified", 5L, s.row(Ids.DM).notified)
        s.run()
        assertTrue(s.sink.shown.isEmpty())
        assertTrue("nothing was loaded for it", s.fetched.isEmpty())

        applier.apply(ws, feed(room(Ids.DM, dm = true, head = 6, unread = 6), next = "p2"), sentCursor = "p1")
        s.pages = mapOf(Ids.DM to EventPage((1L..6L).map { msg(it, room = 4) }, head = 6, floor = 1))
        s.run()
        assertEquals(listOf(Ids.DM), s.fetched.toList())
        assertEquals("only the message after notified shows", listOf(6L), s.sink.shown.single().lines.map { it.seq })
    }

    @Test
    fun `a DM's newest message that an alert loaded is kept as its preview, outside the cache`() = runTest {
        val s = setup()
        // Nothing of the DM is cached: its new messages came through the feed only.
        s.room(room(Ids.DM, dm = true, head = 6, read = 4, unread = 2))
        s.pages = mapOf(Ids.DM to EventPage((1L..6L).map { msg(it, room = 4, actor = if (it == 6L) Ids.ME else Ids.OLGA) }, head = 6, floor = 1))
        s.run()
        assertEquals(listOf(Ids.DM), s.fetched.toList())
        val kept = s.engine.fetchedPreview(ws, Ids.DM)!!
        assertEquals(6L, kept.seq)
        assertEquals("message 6", kept.text)
        assertTrue("the room's cache range stays the loader's", s.store.read { eventsFrom(ws, Ids.DM, 0, Int.MAX_VALUE) }.isEmpty())
        assertNull(s.row(Ids.DM).hi)

        // The cache's newest wins once it holds that message; a newer fetched one wins over an older cached one.
        val cached = s.store.read { lastMessage(ws, Ids.DM) }
        assertEquals(kept, newestOf(cached, kept))
        assertEquals(kept, newestOf(kept.copy(seq = 3), kept))
        assertEquals(kept.copy(text = "cached"), newestOf(kept.copy(text = "cached"), kept))

        // The row reads the store's tombstone before the engine hears of the removal (the view can be built first).
        assertEquals(kept, s.store.read { keptPreview(kept) { hasTombstone(ws, it) } })
        s.store.tx { addTombstones(ws, listOf(kept.id)) }
        val gone = s.store.read { keptPreview(kept) { hasTombstone(ws, it) } }!!
        assertTrue(gone.redacted)
        assertNull(gone.text)
        assertTrue(gone.mentions.isEmpty())
        assertEquals(kept.seq, gone.seq)
        assertNull(keptPreview(null) { true })

        // A removal turns it into a removed message; an eviction, the workspace going and the session's end drop it.
        s.engine.onRemoved(ws, Ids.DM, listOf(kept.id), s.store)
        assertTrue(s.engine.fetchedPreview(ws, Ids.DM)!!.redacted)
        assertNull(s.engine.fetchedPreview(ws, Ids.DM)!!.text)
        s.engine.onEvicted(ws, Ids.DM)
        assertNull(s.engine.fetchedPreview(ws, Ids.DM))
    }

    @Test
    fun `an alert's fetch answered after a reset shows nothing, keeps no preview and writes nothing`() = runTest {
        val s = setup()
        s.room(room(Ids.DM, dm = true, head = 3, unread = 1, read = 2))
        val started = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        val alerting = async {
            s.engine.afterRun(ws, s.store) {
                started.complete(Unit)
                release.await()
                EventPage(listOf(msg(3, text = "removed while away", room = 4)), head = 3, floor = 1)
            }
        }
        started.await()
        val reset = FeedApplier(s.store, Clock { TestDb.NOW }).reset(ws)
        s.engine.onPage(ws, reset, s.store)
        release.complete(Unit)
        alerting.await()
        assertTrue("the page belongs to the cache before the reset", s.sink.shown.isEmpty())
        assertNull(s.engine.fetchedPreview(ws, Ids.DM))
        assertTrue(s.notices(Ids.DM).isEmpty())
        assertEquals("the room stays due for a run under the new revision", 0L, s.row(Ids.DM).notified)
    }

    @Test
    fun `a fetch refused after a reset ends the run's alerts`() = runTest {
        val s = setup()
        val other = Ids.id("d", 31)
        s.room(room(Ids.DM, dm = true, head = 3, unread = 1, read = 2).copy(lastAt = 2_000))
        s.room(room(other, dm = true, head = 3, unread = 1, read = 2).copy(lastAt = 1_000))
        val applier = FeedApplier(s.store, Clock { TestDb.NOW })
        s.engine.afterRun(ws, s.store) { r ->
            s.fetched += r.id
            if (r.id == Ids.DM) {
                s.engine.onPage(ws, applier.reset(ws), s.store)
                throw WorkspaceError("network")
            }
            EventPage(listOf(msg(3, text = "old text", room = 31)), head = 3, floor = 1)
        }
        assertEquals("the run stopped at the refusal from before the reset", listOf(Ids.DM), s.fetched.toList())
        assertTrue(s.sink.shown.isEmpty())
        assertEquals(0L, s.row(other).notified)
    }

    @Test
    fun `a room whose cache went whole loses the preview an alert's fetch kept, and the view hears of it`() = runTest {
        val s = setup()
        s.room(room(Ids.DM, dm = true, head = 65, unread = 1, read = 64))
        s.pages = mapOf(Ids.DM to EventPage(listOf(msg(65, text = "body removed last", room = 4)), head = 65, floor = 1))
        val before = s.engine.previews.value
        s.run()
        assertEquals("body removed last", s.engine.fetchedPreview(ws, Ids.DM)?.text)
        assertTrue("keeping a preview ticks the view", s.engine.previews.value > before)
        // Read here: the alert and its notice rows go, so a removal that doesn't list the message can't find it.
        s.readAll(Ids.DM)
        s.engine.onRead(ws, Ids.DM, s.store)
        assertTrue(s.notices(Ids.DM).isEmpty())

        val applier = FeedApplier(s.store, Clock { TestDb.NOW })
        val result = applier.apply(
            ws,
            feed(room(Ids.DM, dm = true, head = 130, read = 65, removed = (1L..64L).map { Ids.event(it, 4) }, removedMore = true), next = "p1"),
            sentCursor = "c0",
        )!!
        assertTrue(Ids.DM in result.cacheDropped)
        assertFalse("the page didn't list the preview", Ids.event(65, 4) in result.removed[Ids.DM].orEmpty())
        val ticked = s.engine.previews.value
        s.engine.onPage(ws, result, s.store)
        assertNull("removedMore may have taken the preview", s.engine.fetchedPreview(ws, Ids.DM))
        assertTrue("the view builds again without it", s.engine.previews.value > ticked)
    }

    @Test
    fun `at the cache's opening, alerts an earlier process left without notice rows go`() = runTest {
        val s = setup()
        val noticed = Ids.id("d", 32)
        s.room(room(Ids.DM, dm = true, head = 1, unread = 1))
        s.room(room(noticed, dm = true, head = 1, unread = 1))
        s.store.tx { addNotices(ws, noticed, listOf(Notice(Ids.event(1, 32), 1))) }
        // What Android still shows after the process died: the reset deleted the DM's notice rows before its
        // cancellation ran; the other workspace left the cache.
        val stale = ChatAlertRules.roomKey(ws, Ids.DM)
        val kept = ChatAlertRules.roomKey(ws, noticed)
        val summary = ChatAlertRules.summaryKey(ws)
        val gone = ChatAlertRules.roomKey(Ids.WS2, Ids.DM)
        val goneSummary = ChatAlertRules.summaryKey(Ids.WS2)
        for (key in listOf(stale, kept, summary, gone, goneSummary)) s.sink.posted(key)

        ChatAlertEngine(s.sink, { Words }, { true }, { _, _ -> false }).reconcile(s.store)
        assertEquals(
            "a room's alert stays only with notice rows; a summary of a cached workspace waits for its own rule",
            setOf(kept, summary),
            s.sink.activeKeys(),
        )
    }

    @Test
    fun `a later pass, after a reset, alerts as usual`() = runTest {
        val s = setup()
        val applier = FeedApplier(s.store, Clock { TestDb.NOW })
        applier.apply(ws, feed(room(Ids.DM, dm = true, head = 2, unread = 0, read = 2), next = "p1"), sentCursor = "c0")
        applier.reset(ws)
        applier.apply(ws, feed(room(Ids.DM, dm = true, head = 4, read = 2, unread = 2), next = "p2"), sentCursor = null)
        assertFalse(s.store.read { getWs(ws)!!.passing })
        s.pages = mapOf(Ids.DM to EventPage((1L..4L).map { msg(it, room = 4) }, head = 4, floor = 1))
        s.run()
        assertEquals(listOf(3L, 4L), s.sink.shown.single().lines.map { it.seq })
    }

    @Test
    fun `a read here to the alert's position takes it back, a smaller one doesn't`() = runTest {
        val s = setup()
        s.room(room(Ids.DM, dm = true, head = 3, unread = 3), msg(1, room = 4), msg(2, room = 4), msg(3, room = 4))
        s.run()
        val key = ChatAlertRules.roomKey(ws, Ids.DM)
        assertEquals(setOf(key), s.sink.activeKeys())

        s.store.tx { setRoomFields(ws, Ids.DM, mapOf("readLocal" to 2L)) }
        s.engine.onRead(ws, Ids.DM, s.store)
        assertEquals(setOf(key), s.sink.activeKeys())

        s.store.tx { setRoomFields(ws, Ids.DM, mapOf("readLocal" to 3L)) }
        s.engine.onRead(ws, Ids.DM, s.store)
        assertTrue(s.sink.activeKeys().isEmpty())
        assertTrue("its notice rows went", s.notices(Ids.DM).isEmpty())
    }

    @Test
    fun `a read on another device, arriving as a feed row, takes the alert back at the end of the run`() = runTest {
        val s = setup()
        s.room(room(Ids.DM, dm = true, head = 2, unread = 2), msg(1, room = 4), msg(2, room = 4))
        s.run()
        assertEquals(1, s.sink.activeKeys().size)
        s.room(room(Ids.DM, dm = true, head = 2, read = 2, unread = 0))
        s.run()
        assertTrue(s.sink.activeKeys().isEmpty())
    }

    @Test
    fun `a removal of a shown message takes the alert back, a removal of another message doesn't`() = runTest {
        val s = setup()
        s.room(
            room(head = 3, unread = 2, mentions = 1),
            msg(1),
            msg(2, text = "Me hey", mentions = listOf(Mention(Ids.ME, 0, 2))),
            msg(3),
        )
        s.run()
        val key = ChatAlertRules.roomKey(ws, Ids.GENERAL)
        assertEquals(setOf(key), s.sink.activeKeys())
        s.engine.onRemoved(ws, Ids.GENERAL, listOf(Ids.event(3)), s.store)
        assertEquals("another message's removal leaves it", setOf(key), s.sink.activeKeys())
        s.engine.onRemoved(ws, Ids.GENERAL, listOf(Ids.event(2)), s.store)
        assertTrue(s.sink.activeKeys().isEmpty())
    }

    @Test
    fun `a removal through the feed takes back the alert that showed it`() = runTest {
        val s = setup()
        s.room(room(Ids.DM, dm = true, head = 2, unread = 2), msg(1, room = 4), msg(2, room = 4))
        s.run()
        val applier = FeedApplier(s.store, Clock { TestDb.NOW })
        val result = applier.apply(ws, feed(room(Ids.DM, dm = true, head = 3, unread = 1, removed = listOf(Ids.event(2, 4))), next = "p1"), sentCursor = "c0")!!
        assertFalse(result.reset)
        s.engine.onPage(ws, result, s.store)
        assertTrue(s.sink.activeKeys().isEmpty())
    }

    @Test
    fun `a reset takes back every alert of the workspace, its summary and those from before a restart included`() = runTest {
        val s = setup()
        s.mentionRooms(5)
        s.run()
        assertEquals("three alerts and a summary", 4, s.sink.activeKeys().size)
        // As after a restart: the engine no longer knows what it showed, and the summary has no notice rows.
        val restarted = ChatAlertEngine(s.sink, { Words }, { true }, { _, _ -> false })
        val result = FeedApplier(s.store, Clock { TestDb.NOW }).reset(ws)
        assertTrue(result.reset)
        restarted.onPage(ws, result, s.store)
        assertTrue(s.sink.activeKeys().isEmpty())
        assertEquals(ChatAlertRules.workspacePrefix(ws), s.sink.cleared.last())
    }

    @Test
    fun `removing messages in the rooms a summary counts leaves the summary, and reading them takes it back`() = runTest {
        val s = setup()
        val ids = s.mentionRooms(5)
        s.run()
        val summary = ChatAlertRules.summaryKey(ws)
        assertTrue(summary in s.sink.activeKeys())
        // The two least recently active rooms are the summary's. Their messages go; the mentions stay unread.
        s.engine.onRemoved(ws, ids[0], listOf(Ids.event(10, 5)), s.store)
        s.engine.onRemoved(ws, ids[1], listOf(Ids.event(11, 6)), s.store)
        assertTrue("a removal doesn't take the summary back", summary in s.sink.activeKeys())

        s.readAll(ids[0])
        s.engine.onRead(ws, ids[0], s.store)
        assertTrue("one of its rooms is still unread", summary in s.sink.activeKeys())
        s.readAll(ids[1])
        s.engine.onRead(ws, ids[1], s.store)
        assertFalse(summary in s.sink.activeKeys())
    }

    @Test
    fun `after a restart, a summary goes once every room that could stand behind it was read`() = runTest {
        val s = setup()
        val ids = s.mentionRooms(5)
        s.run()
        val summary = ChatAlertRules.summaryKey(ws)
        assertTrue(summary in s.sink.activeKeys())
        val restarted = ChatAlertEngine(s.sink, { Words }, { true }, { _, _ -> false })
        val run: suspend () -> Unit = { restarted.afterRun(ws, s.store) { throw WorkspaceError("network") } }

        run()
        assertTrue("its rooms are still unread", summary in s.sink.activeKeys())
        s.readAll(ids[0])
        run()
        assertTrue(summary in s.sink.activeKeys())
        s.readAll(ids[1])
        run()
        assertFalse(summary in s.sink.activeKeys())
        assertEquals(
            "the rooms with an alert of their own keep theirs",
            ids.drop(2).map { ChatAlertRules.roomKey(ws, it) }.toSet(),
            s.sink.activeKeys(),
        )
    }

    @Test
    fun `an eviction, the workspace going and the end of the session take alerts back`() = runTest {
        val s = setup()
        s.room(room(Ids.DM, dm = true, head = 1, unread = 1), msg(1, room = 4))
        s.room(room(Ids.RANDOM, name = "random", head = 1, unread = 1, mentions = 1), msg(1, room = 2, mentions = listOf(Mention(Ids.ME, 0, 3))))
        s.run()
        assertEquals(2, s.sink.activeKeys().size)

        s.store.tx { deleteRoom(ws, Ids.DM) }
        s.engine.onEvicted(ws, Ids.DM)
        assertEquals(setOf(ChatAlertRules.roomKey(ws, Ids.RANDOM)), s.sink.activeKeys())

        s.engine.onWorkspaceGone(ws)
        assertTrue(s.sink.activeKeys().isEmpty())
        assertTrue(ChatAlertRules.workspacePrefix(ws) in s.sink.cleared)

        s.engine.clear()
        assertEquals(ChatAlertRules.PREFIX, s.sink.cleared.last())
    }

    @Test
    fun `three rooms alert, newest first, and a fourth or more make one summary`() = runTest {
        val s = setup(workspaces = 2)
        val ids = s.mentionRooms(5)
        s.run()
        val rooms = s.sink.shown.filter { !it.summary }
        assertEquals("the three most recently active rooms", listOf(ids[4], ids[3], ids[2]), rooms.map { it.room })
        assertEquals("#room4 · Team", rooms.first().title)
        val summary = s.sink.shown.single { it.summary }
        assertEquals(ChatAlertRules.summaryKey(ws), summary.key)
        assertEquals("New messages in 2 conversations", summary.body)
        assertEquals("Team chat · Team", summary.title)
        for (id in ids) assertEquals(s.row(id).head, s.row(id).notified)

        // A summary goes once every room it stands for was read.
        for (id in listOf(ids[0], ids[1])) {
            s.readAll(id)
            s.engine.onRead(ws, id, s.store)
        }
        assertFalse(ChatAlertRules.summaryKey(ws) in s.sink.activeKeys())
    }

    @Test
    fun `rooms the cache can't tell about are loaded, at most three a run, and a failed load leaves the room due`() = runTest {
        val s = setup()
        val ids = (21..25).map { Ids.id("c", it) }
        ids.forEachIndexed { i, id -> s.room(room(id, name = "r$i", head = 5, unread = 1, mentions = 1).copy(lastAt = 2_000L - i)) }
        s.pages = ids.take(2).associateWith { id ->
            EventPage(listOf(msg(5, room = ids.indexOf(id) + 5, mentions = listOf(Mention(Ids.ME, 0, 3)))), head = 5, floor = 1)
        }
        s.run()
        assertEquals("three loads, the third failing", ids.take(3), s.fetched.toList())
        assertEquals(ids.take(2), s.sink.shown.filter { !it.summary }.map { it.room })
        assertEquals("the failed one stays due", 0L, s.row(ids[2]).notified)
        assertEquals("New messages in 2 conversations", s.sink.shown.single { it.summary }.body)
    }

    @Test
    fun `a blocked person's messages and mentions don't alert`() = runTest {
        val s = setup()
        s.store.tx { replaceBlocks(ws, listOf(Block(Ids.OLGA, 1))) }
        s.room(room(head = 1, unread = 1, mentions = 1), msg(1, mentions = listOf(Mention(Ids.ME, 0, 3))))
        s.run()
        assertTrue(s.sink.shown.isEmpty())
        assertEquals("nothing to show: notified anyway", 1L, s.row().notified)
    }

    @Test
    fun `a removed message never shows`() = runTest {
        val s = setup()
        s.room(room(Ids.DM, dm = true, head = 2, unread = 2), msg(1, room = 4, text = "kept"), msg(2, room = 4, redacted = true))
        s.run()
        assertEquals(listOf("kept"), s.sink.shown.single().lines.map { it.text })
    }

    @Test
    fun `the rule itself`() {
        fun row(kind: String, head: Long, notified: Long, unread: Int, mentions: Int, read: Long = 0, readLocal: Long = read) = RoomRow(
            ws, Ids.GENERAL, kind, null, if (kind == "dm") "dm" else "workspace", false, null, null, null, Ids.grant(1), "member", 2,
            head, 1, null, read, readLocal, read, unread, mentions, null, null, notified, false,
        )
        assertTrue(ChatAlertRules.due(row("dm", 5, 4, 1, 0)))
        assertFalse("nothing past notified", ChatAlertRules.due(row("dm", 5, 5, 1, 0)))
        assertFalse("a DM needs unread", ChatAlertRules.due(row("dm", 5, 0, 0, 0)))
        assertTrue(ChatAlertRules.due(row("channel", 5, 0, 0, 1)))
        assertFalse("a channel needs mentions", ChatAlertRules.due(row("channel", 5, 0, 3, 0)))
        assertTrue(ChatAlertRules.silenced(notifyChat = false, muted = false, onScreen = false))
        assertTrue(ChatAlertRules.silenced(notifyChat = true, muted = true, onScreen = false))
        assertTrue(ChatAlertRules.silenced(notifyChat = true, muted = false, onScreen = true))
        assertFalse(ChatAlertRules.silenced(notifyChat = true, muted = false, onScreen = false))
        assertTrue(ChatAlertRules.readTo(row("dm", 5, 4, 1, 0, read = 0, readLocal = 4)))
        assertTrue("a read elsewhere counts", ChatAlertRules.readTo(row("dm", 5, 4, 1, 0, read = 5, readLocal = 0)))
        assertFalse(ChatAlertRules.readTo(row("dm", 5, 4, 1, 0, read = 3)))
    }

    @Test
    fun `an alert line shows mentions with an at sign, one line, cut at 120 characters`() {
        val text = "Zoë and Joël,\n\nplease  look"
        val bytes = "Zoë".toByteArray().size
        val mentions = listOf(Mention(Ids.OLGA, 0, bytes), Mention(Ids.SAM, bytes + " and ".length, bytes + " and ".length + "Joël".toByteArray().size))
        assertEquals("@Zoë and @Joël, please look", ChatAlertRules.alertText(text, mentions))
        assertEquals("@Sam already", ChatAlertRules.alertText("@Sam already", listOf(Mention(Ids.SAM, 0, 4))))
        assertEquals("a range that splits a character stays plain", "Zoë", ChatAlertRules.alertText("Zoë", listOf(Mention(Ids.SAM, 0, 3))))
        val long = "a".repeat(130)
        assertEquals("a".repeat(120) + "…", ChatAlertRules.alertText(long, emptyList()))
        val emoji = "😀".repeat(121)
        assertEquals("characters, not UTF-16 units", "😀".repeat(120) + "…", ChatAlertRules.alertText(emoji, emptyList()))
    }
}
