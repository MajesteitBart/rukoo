package nl.bvdm.rukoo.workspaces

import java.io.File
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.yield
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/** The store's queries (contract §4.2) on real SQLite, with the cases of desktop's chat-store.test.js that apply. */
class WorkspaceStoreTest {
    private val t = TestDb()

    @After
    fun tearDown() = t.close()

    private val ws = "w_" + "A".repeat(22)
    private val c1 = "c_" + "A".repeat(22)
    private val c2 = "c_" + "B".repeat(22)
    private val me = "u_" + "M".repeat(22)
    private val olga = "u_" + "O".repeat(22)
    private val sam = "u_" + "S".repeat(22)

    private fun change(
        id: String = c1,
        grant: String = "g_1",
        head: Long = 10,
        floor: Long = 1,
        read: Long = 0,
        unread: Int = 0,
        mentions: Int = 0,
        kind: String = "channel",
        removed: List<String> = emptyList(),
    ) = Change(
        conversation = id, kind = kind, name = if (kind == "dm") null else "general", visibility = if (kind == "dm") "dm" else "workspace",
        participants = if (kind == "dm") listOf(me, olga) else null, startedBy = if (kind == "dm") olga else null,
        grant = grant, role = "member", members = 2, head = head, floor = floor, lastAt = 1000L + head, read = read,
        unread = unread, mentions = mentions, removed = removed,
    )

    private fun msg(seq: Long, actor: String = olga, text: String = "message $seq", mentions: List<Mention> = emptyList(), root: String? = null) =
        WireEvent(seq = seq, id = eid(seq), kind = WireEvent.MESSAGE_POSTED, actor = actor, at = 1000L + seq, root = root, text = text, mentions = mentions)

    private fun eid(seq: Long) = "e_" + seq.toString().padStart(22, '0')

    private fun outbox(local: String, room: String = c1, createdAt: Long = 1, state: String = "queued", reason: String? = null, generation: String = "gen1") =
        OutboxRow(local = local, ws = ws, room = room, actor = me, grantId = "g_1", generation = generation, text = "hi $local",
            mentions = listOf(Mention(olga, 0, 2)), root = null, state = state, reason = reason, createdAt = createdAt)

    private suspend fun seeded(): WorkspaceStore {
        val store = t.store()
        store.tx {
            insertWs(WsRow(id = ws, name = "Team", role = "owner", me = me, myName = "Me", generation = "gen1"))
            upsertRoom(ws, change())
        }
        return store
    }

    @Test
    fun `meta and workspace rows round-trip, and only known fields can be set`() = runTest {
        val store = seeded()
        store.tx {
            setMeta("selected", ws)
            setMeta("selected", ws)
            assertEquals(ws, getMeta("selected"))
            deleteMeta("selected")
            assertNull(getMeta("selected"))
            assertTrue(updateWs(ws, mapOf("cursor" to "sealed", "passing" to false, "syncedAt" to 5L)))
            val row = getWs(ws)!!
            assertEquals("sealed", row.cursor)
            assertFalse(row.passing)
            assertTrue(row.fresh)
            assertEquals("ok", row.state)
            assertEquals(5L, row.syncedAt)
            assertEquals(listOf(row), listWs())
            // Inserting again keeps the row and takes the new name and role.
            insertWs(WsRow(id = ws, name = "Team 2", role = "admin"))
            assertEquals("sealed", getWs(ws)!!.cursor)
            assertEquals("Team 2", getWs(ws)!!.name)
        }
        try {
            store.tx { updateWs(ws, mapOf("id; DROP TABLE ws" to 1)) }
            fail("an unknown field should throw")
        } catch (_: IllegalArgumentException) {
        }
    }

    @Test
    fun `a new room comes in uncached with its local read positions at the server's`() = runTest {
        val store = seeded()
        store.tx {
            val r = upsertRoom(ws, change(id = c2, read = 4, unread = 6, kind = "dm"))
            assertTrue(r.inserted)
            assertFalse(r.grantChanged)
            with(r.row) {
                assertEquals(4L, read); assertEquals(4L, readLocal); assertEquals(4L, readSent)
                assertNull(lo); assertNull(hi)
                assertEquals(listOf(me, olga), participants)
                assertEquals(olga, startedBy)
                assertEquals("dm", visibility)
                assertNull(name)
            }
        }
    }

    @Test
    fun `an upsert keeps the outbox, drafts, notices, mute and what this phone read`() = runTest {
        val store = seeded()
        store.tx {
            appendEvents(ws, c1, (1L..10L).map { msg(it) })
            insertOutbox(outbox("l1"))
            putDraft(ws, c1, null, Draft("draft", emptyList()))
            addNotices(ws, c1, listOf(Notice(eid(9), 9)))
            setRoomFields(ws, c1, mapOf("readLocal" to 8L, "readSent" to 6L, "muted" to true, "notified" to 9L))
            val r = upsertRoom(ws, change(head = 11, read = 5, unread = 3))
            assertFalse(r.grantChanged)
            with(r.row) {
                assertEquals(5L, read); assertEquals(8L, readLocal); assertEquals(6L, readSent)
                assertTrue(muted); assertEquals(9L, notified); assertEquals(1L, lo); assertEquals(10L, hi); assertEquals(11L, head)
            }
            assertEquals(1, outboxForRoom(ws, c1).size)
            assertEquals("draft", getDraft(ws, c1, null)!!.text)
            assertEquals(1, noticesForRoom(ws, c1).size)
            // A higher server read wins through the max.
            assertEquals(9L, upsertRoom(ws, change(read = 9)).row.readLocal)
        }
    }

    @Test
    fun `a changed grant empties the cache, keeps the outbox with its old grant, and keepLocal false forgets reads`() = runTest {
        val store = seeded()
        store.tx {
            appendEvents(ws, c1, (1L..10L).map { msg(it) })
            insertOutbox(outbox("l1"))
            setRoomFields(ws, c1, mapOf("readLocal" to 8L))
            val r = upsertRoom(ws, change(grant = "g_2"))
            assertTrue(r.grantChanged)
            assertNull(r.row.lo)
            assertEquals(0L, sql.long("SELECT COUNT(*) FROM event WHERE ws = ? AND room = ?", ws, c1))
            assertEquals("g_1", getOutbox("l1")!!.grantId)
            appendEvents(ws, c1, listOf(msg(10)))
            val fresh = upsertRoom(ws, change(grant = "g_2", read = 2), keepLocal = false)
            assertNull(fresh.row.lo)
            assertEquals(2L, fresh.row.readLocal)
        }
    }

    @Test
    fun `a floor drops older events and reports their messages, and a range below it empties`() = runTest {
        val store = seeded()
        store.tx {
            appendEvents(ws, c1, (1L..10L).map { msg(it) })
            val r = upsertRoom(ws, change(floor = 4))
            assertEquals((1L..3L).map(::eid), r.dropped)
            assertEquals(4L, r.row.lo)
            assertEquals(listOf<String>(), applyFloor(ws, c1, 4))
            assertEquals((4L..10L).map(::eid), applyFloor(ws, c1, 11))
            val room = getRoom(ws, c1)!!
            assertNull(room.lo); assertNull(room.hi)
        }
    }

    @Test
    fun `deleting a room takes its events, sends, drafts and notices and counts the sends`() = runTest {
        val store = seeded()
        store.tx {
            upsertRoom(ws, change(id = c2))
            appendEvents(ws, c1, listOf(msg(1)))
            appendEvents(ws, c2, listOf(msg(1).copy(id = "e_other"), msg(2).copy(id = "e_other2")))
            insertOutbox(outbox("l1")); insertOutbox(outbox("l2")); insertOutbox(outbox("l3", room = c2))
            putDraft(ws, c1, eid(1), Draft("thread draft"))
            addNotices(ws, c1, listOf(Notice(eid(1), 1)))
            assertEquals(2, deleteRoom(ws, c1))
            assertEquals(-1, deleteRoom(ws, c1))
            assertEquals(0L, sql.long("SELECT COUNT(*) FROM event WHERE room = ?", c1))
            assertEquals(0L, sql.long("SELECT COUNT(*) FROM draft"))
            assertEquals(0L, sql.long("SELECT COUNT(*) FROM notice"))
            assertEquals(1, countUnsent())
            assertEquals(2L, sql.long("SELECT COUNT(*) FROM event WHERE room = ?", c2))
        }
    }

    @Test
    fun `deleting a workspace takes everything under it`() = runTest {
        val store = seeded()
        store.tx {
            appendEvents(ws, c1, listOf(msg(1)))
            insertOutbox(outbox("l1"))
            addTombstones(ws, listOf("e_gone"))
            replaceMembers(ws, listOf(Member(me, name = "Me", role = "owner", state = "active")))
            replaceChannels(ws, listOf(Channel(c1, "general", "workspace", joined = true, role = "member", members = 2)))
            replaceBlocks(ws, listOf(Block(sam, 5)))
            putPassRoom(ws, change(id = c2))
            assertTrue(deleteWs(ws))
            for (table in listOf("ws", "room", "pass_room", "event", "tombstone", "member", "channel", "block", "outbox", "draft", "notice")) {
                assertEquals(table, 0L, sql.long("SELECT COUNT(*) FROM $table"))
            }
        }
    }

    @Test
    fun `appending and prepending keep one range, and a room over the cap loses its lowest events`() = runTest {
        val store = seeded()
        store.tx {
            appendEvents(ws, c1, (5L..8L).map { msg(it) })
            prependEvents(ws, c1, (2L..4L).map { msg(it) })
            var room = getRoom(ws, c1)!!
            assertEquals(2L, room.lo); assertEquals(8L, room.hi)
            appendEvents(ws, c1, (9L..12L).map { msg(it) })
            room = getRoom(ws, c1)!!
            assertEquals(12L, room.hi); assertEquals(12L, room.head)
            assertEquals((5L..8L).toList(), eventsBefore(ws, c1, 9, 4).map { it.seq })
            assertEquals((10L..12L).toList(), eventsFrom(ws, c1, 10, 10).map { it.seq })
            assertEquals(3, trimRoom(ws, c1, 8))
            assertEquals(5L, getRoom(ws, c1)!!.lo)
            appendEvents(ws, c1, listOf(msg(13)), max = 4)
            assertEquals(10L, getRoom(ws, c1)!!.lo)
            assertEquals(4L, sql.long("SELECT COUNT(*) FROM event WHERE room = ?", c1))
        }
    }

    @Test
    fun `events keep their mentions in bytes and their other fields as data`() = runTest {
        val store = seeded()
        store.tx {
            val mention = Mention(me, 4, 9)
            appendEvents(
                ws, c1,
                listOf(
                    WireEvent(seq = 1, id = eid(1), kind = "channel.created", actor = olga, at = 1, name = "general", visibility = "workspace"),
                    WireEvent(seq = 2, id = eid(2), kind = "dm.started", actor = olga, at = 2, members = listOf(olga, me)),
                    msg(3, text = "Hoi @Zoë", mentions = listOf(mention)),
                ),
            )
            val created = eventAt(ws, c1, 1)!!
            assertNull(created.text)
            assertEquals(EventData(name = "general", visibility = "workspace"), created.data)
            assertEquals(listOf(olga, me), eventAt(ws, c1, 2)!!.data.members)
            val posted = eventById(ws, eid(3))!!
            assertEquals("Hoi @Zoë", posted.text)
            assertEquals(listOf(mention), posted.mentions)
            assertTrue(posted.isMessage)
            assertEquals(posted, lastMessage(ws, c1))
            assertEquals(c1, roomOfEvent(ws, eid(3)))
        }
    }

    @Test
    fun `a tombstoned or redacted message never gets its text back`() = runTest {
        val store = seeded()
        store.tx {
            appendEvents(ws, c1, (1L..3L).map { msg(it) })
            addTombstones(ws, listOf(eid(2)))
            assertEquals(mapOf(c1 to listOf(eid(2))), redact(ws, listOf(eid(2), "e_unknown")))
            assertEquals(emptyMap<String, List<String>>(), redact(ws, listOf(eid(2))))
            // A slow history page carrying the old body.
            writeEvents(ws, c1, listOf(msg(2)))
            val e = eventAt(ws, c1, 2)!!
            assertTrue(e.redacted); assertNull(e.text); assertEquals(emptyList<Mention>(), e.mentions)
            assertTrue(hasTombstone(ws, eid(2)))
            // A message.redacted event removes and tombstones its target.
            appendEvents(ws, c1, listOf(WireEvent(seq = 4, id = eid(4), kind = WireEvent.MESSAGE_REDACTED, actor = olga, at = 4, target = eid(3), targetSeq = 3)))
            assertTrue(eventAt(ws, c1, 3)!!.redacted)
            assertTrue(hasTombstone(ws, eid(3)))
            // A tombstoned message written fresh is stored removed.
            addTombstones(ws, listOf(eid(5)))
            appendEvents(ws, c1, listOf(msg(5)))
            assertNull(eventAt(ws, c1, 5)!!.text)
        }
    }

    @Test
    fun `tombstones older than a time are pruned`() = runTest {
        val store = seeded()
        store.tx {
            addTombstones(ws, listOf("e_old"), at = 100)
            addTombstones(ws, listOf("e_new"), at = 200)
            assertEquals(1, pruneTombstones(ws, 150))
            assertFalse(hasTombstone(ws, "e_old"))
            assertTrue(hasTombstone(ws, "e_new"))
        }
    }

    @Test
    fun `replies, reply counts and repliers come from the root index`() = runTest {
        val store = seeded()
        store.tx {
            val root = eid(1)
            appendEvents(ws, c1, listOf(msg(1), msg(2, actor = sam, root = root), msg(3), msg(4, actor = olga, root = root), msg(5, actor = sam, root = root)))
            redact(ws, listOf(eid(4)))
            assertEquals(listOf(2L, 4L, 5L), replies(ws, c1, root).map { it.seq })
            assertEquals(mapOf(root to ReplyCount(3, 5, 1005)), replyCounts(ws, c1, listOf(root, eid(3))))
            assertEquals(listOf(sam, olga), repliers(ws, c1, root))
        }
    }

    @Test
    fun `badges count others' messages after a position, and leave out removed ones and blocked authors' mentions`() = runTest {
        val store = seeded()
        store.tx {
            val toMe = listOf(Mention(me, 0, 3))
            appendEvents(
                ws, c1,
                listOf(
                    msg(1, actor = olga, mentions = toMe),
                    msg(2, actor = olga, mentions = toMe),
                    msg(3, actor = sam, mentions = toMe),
                    msg(4, actor = me),
                    msg(5, actor = olga),
                    msg(6, actor = olga, mentions = toMe),
                ),
            )
            redact(ws, listOf(eid(6)))
            assertEquals(Badges(unread = 3, mentions = 2), countBadges(ws, c1, 1, me, emptyList()))
            replaceBlocks(ws, listOf(Block(sam, 1)))
            assertEquals(Badges(unread = 3, mentions = 1), countBadges(ws, c1, 1, me))
            appendEvents(ws, c1, (7L..120L).map { msg(it) })
            assertEquals(WorkspaceStore.BADGE_CAP, countBadges(ws, c1, 0, me).unread)
        }
    }

    @Test
    fun `the pass keeps room rows apart until it installs`() = runTest {
        val store = seeded()
        store.tx {
            putPassRoom(ws, change(id = c2, head = 3))
            putPassRoom(ws, change(id = c2, head = 4))
            putPassRoom(ws, change(id = c1))
            assertEquals(listOf(c1, c2), listPassRooms(ws).map { it.conversation })
            assertEquals(4L, listPassRooms(ws).last().head)
            assertNull(getRoom(ws, c2))
            clearPass(ws)
            assertEquals(emptyList<Change>(), listPassRooms(ws))
        }
    }

    @Test
    fun `deleting the workspace's events empties every range`() = runTest {
        val store = seeded()
        store.tx {
            upsertRoom(ws, change(id = c2))
            appendEvents(ws, c1, listOf(msg(1)))
            appendEvents(ws, c2, listOf(msg(1).copy(id = "e_x")))
            deleteWsEvents(ws)
            assertEquals(0L, sql.long("SELECT COUNT(*) FROM event"))
            assertTrue(listRooms(ws).none { it.hasCache })
        }
    }

    @Test
    fun `directories replace their rows and clear their flags`() = runTest {
        val store = seeded()
        store.tx {
            val members = listOf(Member(me, name = "Me", role = "owner", state = "active", joinedAt = 1), Member(olga, name = "Olga", role = "member", state = "former"))
            replaceMembers(ws, members, more = true)
            replaceMembers(ws, members, more = true)
            assertEquals(members.sortedBy { it.id }, listMembers(ws))
            val channels = listOf(Channel(c1, "general", "workspace", joined = true, role = "manager", members = 3), Channel(c2, "plans", "private", archived = true))
            replaceChannels(ws, channels)
            assertEquals(channels, listChannels(ws))
            replaceBlocks(ws, listOf(Block(olga, 1), Block(sam, 2)))
            assertEquals(listOf(Block(sam, 2), Block(olga, 1)), listBlocks(ws))
            val row = getWs(ws)!!
            assertFalse(row.membersStale); assertFalse(row.channelsStale); assertFalse(row.blocksStale); assertTrue(row.membersMore)
        }
    }

    @Test
    fun `the outbox keeps rows in order and holds a room back behind its first row`() = runTest {
        val store = seeded()
        store.tx {
            upsertRoom(ws, change(id = c2))
            insertOutbox(outbox("a1", createdAt = 1))
            insertOutbox(outbox("a2", createdAt = 2))
            insertOutbox(outbox("b1", room = c2, createdAt = 3))
            assertEquals(listOf("a1", "b1"), nextDue(10, 10).map { it.local })
            assertEquals(listOf("a1"), nextDue(10, 1).map { it.local })
            updateOutbox("a1", mapOf("state" to "held", "reason" to "stale_grant"))
            assertEquals(listOf("b1"), nextDue(10, 10).map { it.local })
            updateOutbox("b1", mapOf("nextAt" to 50L))
            assertEquals(emptyList<String>(), nextDue(10, 10).map { it.local })
            assertEquals(listOf("b1"), nextDue(50, 10).map { it.local })
            assertTrue(deleteOutbox("a1"))
            assertFalse(deleteOutbox("a1"))
            assertEquals(listOf("a2", "b1"), nextDue(50, 10).map { it.local })
            updateWs(ws, mapOf("state" to "quarantined"))
            assertEquals(emptyList<String>(), nextDue(50, 10).map { it.local })
            assertEquals(2, countUnsent())
            assertEquals(listOf("a2", "b1"), outboxForWs(ws).map { it.local })
            val row = getOutbox("a2")!!
            assertEquals(listOf(Mention(olga, 0, 2)), row.mentions)
            updateOutbox("a2", mapOf("mentions" to emptyList<Mention>(), "operationId" to "019a9bc5-7380-7011-a233-445566778899"))
            assertEquals(emptyList<Mention>(), getOutbox("a2")!!.mentions)
        }
    }

    @Test
    fun `an operation ID can be used by one row only`() = runTest {
        val store = seeded()
        val op = "019a9bc5-7380-7011-a233-445566778899"
        store.tx { insertOutbox(outbox("a1").copy(operationId = op)) }
        try {
            store.tx { insertOutbox(outbox("a2").copy(operationId = op)) }
            fail("a second row with the same operation ID should be refused")
        } catch (e: WorkspaceError) {
            assertEquals("not_saved", e.code)
        }
        assertEquals(1, store.read { countUnsent() })
    }

    @Test
    fun `markLookup marks queued, sending and stale_grant rows, of one generation when given`() = runTest {
        val store = seeded()
        store.tx {
            insertOutbox(outbox("q", createdAt = 1).copy(nextAt = 99))
            insertOutbox(outbox("s", createdAt = 2, state = "sending"))
            insertOutbox(outbox("h", createdAt = 3, state = "held", reason = "stale_grant"))
            insertOutbox(outbox("u", createdAt = 4, state = "held", reason = "unknown"))
            insertOutbox(outbox("f", createdAt = 5, state = "failed", reason = "quota"))
            insertOutbox(outbox("old", createdAt = 6, generation = "gen0"))
            assertEquals(1, markLookup(ws, "gen0"))
            assertEquals("lookup", getOutbox("old")!!.reason)
            assertNull(getOutbox("q")!!.reason)
            assertEquals(4, markLookup(ws))
            for (local in listOf("q", "s", "h", "old")) {
                val row = getOutbox(local)!!
                assertEquals(local, "queued", row.state)
                assertEquals(local, "lookup", row.reason)
                assertEquals(local, 0L, row.nextAt)
            }
            assertEquals("held", getOutbox("u")!!.state)
            assertEquals("failed", getOutbox("f")!!.state)
        }
    }

    @Test
    fun `drafts and notices are kept per room and thread`() = runTest {
        val store = seeded()
        store.tx {
            putDraft(ws, c1, null, Draft("main", listOf(Mention(olga, 0, 5))))
            putDraft(ws, c1, eid(1), Draft("thread"))
            putDraft(ws, c1, null, Draft("main 2"))
            assertEquals(Draft("main 2"), getDraft(ws, c1, null)!!.draft)
            assertEquals(TestDb.NOW, getDraft(ws, c1, null)!!.at)
            assertEquals("thread", getDraft(ws, c1, eid(1))!!.text)
            deleteDraft(ws, c1, null)
            assertNull(getDraft(ws, c1, null))
            addNotices(ws, c1, listOf(Notice(eid(2), 2), Notice(eid(1), 1)))
            assertEquals(listOf(Notice(eid(1), 1), Notice(eid(2), 2)), noticesForRoom(ws, c1))
            assertEquals(listOf(Notice(eid(2), 2)), deleteNotices(ws, c1, listOf(eid(2), "e_none")))
            assertEquals(listOf(Notice(eid(1), 1)), deleteNotices(ws, c1))
            assertEquals(emptyList<Notice>(), noticesForRoom(ws, c1))
        }
    }

    @Test
    fun `drafts, mute and the outbox survive closing and opening the cache`() = runTest {
        val store = seeded()
        store.tx {
            putDraft(ws, c1, null, Draft("keep me"))
            setRoomFields(ws, c1, mapOf("muted" to true, "readLocal" to 7L))
            insertOutbox(outbox("l1"))
        }
        store.close()
        val again = t.store()
        again.read {
            assertEquals("keep me", getDraft(ws, c1, null)!!.text)
            assertTrue(getRoom(ws, c1)!!.muted)
            assertEquals(7L, getRoom(ws, c1)!!.readLocal)
            assertEquals(1, countUnsent())
        }
    }

    @Test
    fun `a committed write tells the flows which room changed`() = runTest {
        val store = seeded()
        val next = async { store.changes.first() }
        yield()
        store.tx { putDraft(ws, c1, null, Draft("x")) }
        assertEquals(DbChange(ws, setOf(c1)), next.await())
    }

    @Test
    fun `wipe leaves no file behind`() = runTest {
        val store = seeded()
        store.tx { appendEvents(ws, c1, listOf(msg(1))) }
        store.wipe()
        assertEquals(emptyList<String>(), t.file.parentFile!!.list()!!.toList())
    }

    @Test
    fun `a message's text is gone from the file once its room is deleted and the WAL checkpointed`() = runTest {
        val store = seeded()
        val secret = "zebra-quartz-" + "x".repeat(40)
        store.tx { appendEvents(ws, c1, listOf(msg(1, text = secret))) }
        store.checkpoint()
        assertTrue("the text is in the file first", contains(t.file, secret))
        store.tx { deleteRoom(ws, c1) }
        store.checkpoint()
        for (f in listOf(t.file, File(t.file.path + "-wal"))) assertFalse(f.name, f.exists() && contains(f, secret))
    }

    private fun contains(file: File, text: String): Boolean {
        val needle = text.toByteArray()
        val hay = file.readBytes()
        outer@ for (i in 0..hay.size - needle.size) {
            for (j in needle.indices) if (hay[i + j] != needle[j]) continue@outer
            return true
        }
        return false
    }

    @Test
    fun `the schema matches the contract's SQL statement for statement`() = runTest {
        val store = seeded()
        val stored = store.read {
            sql.query("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY rowid") { it.text(0) }
        }
        val normalize = { s: String -> s.replace(Regex("\\s+"), " ").trim() }
        assertArrayEquals(ChatDb.SCHEMA.map(normalize).toTypedArray(), stored.map(normalize).toTypedArray())
    }
}
