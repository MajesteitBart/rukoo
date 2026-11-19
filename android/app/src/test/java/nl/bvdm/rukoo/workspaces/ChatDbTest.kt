package nl.bvdm.rukoo.workspaces

import java.io.File
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.yield
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/** The chat cache's file, schema and transactions, on the bundled SQLite (contract §3.5, android.md "Database"). */
class ChatDbTest {
    private val t = TestDb()

    @After
    fun tearDown() = t.close()

    @Test
    fun `opens, writes and reads in a transaction with the bundled driver`() = runTest {
        val db = t.open()
        db.transaction {
            exec("INSERT INTO meta (key, value) VALUES (?, ?)", "selected", "w_AAAAAAAAAAAAAAAAAAAAAA")
        }
        val value = db.read { one("SELECT value FROM meta WHERE key = ?", "selected") { it.text(0) } }
        assertEquals("w_AAAAAAAAAAAAAAAAAAAAAA", value)
        assertTrue(t.file.exists())
        assertEquals(File(File(t.dir, "chat"), "chat.db"), t.file)
    }

    @Test
    fun `makes the shared schema with its pragmas`() = runTest {
        val db = t.open()
        val tables = db.read { query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name") { it.text(0) } }
        assertEquals(
            listOf("block", "channel", "draft", "event", "member", "meta", "notice", "outbox", "pass_room", "room", "tombstone", "ws"),
            tables,
        )
        val indexes = db.read { query("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name") { it.text(0) } }
        assertEquals(listOf("event_id", "event_root", "outbox_room"), indexes)
        db.read {
            assertEquals("1", one("SELECT value FROM meta WHERE key = 'schema'") { it.text(0) })
            assertEquals("wal", one("PRAGMA journal_mode") { it.text(0) })
            assertEquals(1L, long("PRAGMA foreign_keys"))
            assertEquals(1L, long("PRAGMA secure_delete"))
            assertEquals(2000L, long("PRAGMA busy_timeout"))
            // NORMAL is 1.
            assertEquals(1L, long("PRAGMA synchronous"))
            // WITHOUT ROWID everywhere but the outbox, as §3.5 writes it.
            val withoutRowid = query("SELECT name FROM sqlite_master WHERE type = 'table' AND sql LIKE '%WITHOUT ROWID'") { it.text(0) }.toSet()
            assertEquals(tables.toSet() - "outbox", withoutRowid)
        }
    }

    @Test
    fun `a throw rolls the whole transaction back and announces nothing`() = runTest {
        val db = t.open()
        val seen = mutableListOf<DbChange>()
        val job = launch { db.changes.collect { seen += it } }
        yield()
        try {
            db.transaction {
                exec("INSERT INTO meta (key, value) VALUES ('a', '1')")
                touch("w_AAAAAAAAAAAAAAAAAAAAAA")
                error("boom")
            }
            fail("the transaction should throw")
        } catch (e: IllegalStateException) {
            assertEquals("boom", e.message)
        }
        assertNull(db.read { one("SELECT value FROM meta WHERE key = 'a'") { it.text(0) } })
        yield()
        assertTrue(seen.isEmpty())
        job.cancel()
    }

    @Test
    fun `a committed transaction announces what it touched`() = runTest {
        val db = t.open()
        val change = async {
            db.changes.first()
        }
        yield()
        db.transaction {
            touch("w_AAAAAAAAAAAAAAAAAAAAAA", "c_AAAAAAAAAAAAAAAAAAAAAA")
            touch("w_AAAAAAAAAAAAAAAAAAAAAA", "c_BBBBBBBBBBBBBBBBBBBBBB")
        }
        val got = change.await()
        assertEquals("w_AAAAAAAAAAAAAAAAAAAAAA", got.ws)
        assertEquals(setOf("c_AAAAAAAAAAAAAAAAAAAAAA", "c_BBBBBBBBBBBBBBBBBBBBBB"), got.rooms)
        assertTrue(got.affects("w_AAAAAAAAAAAAAAAAAAAAAA", "c_AAAAAAAAAAAAAAAAAAAAAA"))
        assertFalse(got.affects("w_AAAAAAAAAAAAAAAAAAAAAA", "c_CCCCCCCCCCCCCCCCCCCCCC"))
        assertFalse(got.affects("w_BBBBBBBBBBBBBBBBBBBBBB"))
    }

    @Test
    fun `a SQL constraint failure becomes not_saved`() = runTest {
        val db = t.open()
        try {
            db.transaction { exec("INSERT INTO ws (id, name, role, state) VALUES ('w_x', 'A', 'owner', 'broken')") }
            fail("the CHECK should refuse the state")
        } catch (e: WorkspaceError) {
            assertEquals("not_saved", e.code)
        }
    }

    @Test
    fun `the data survives closing and opening the file again`() = runTest {
        val first = t.open()
        first.transaction { exec("INSERT INTO meta (key, value) VALUES ('selected', 'w_1')") }
        first.close()
        val second = t.open()
        assertEquals(0, second.lostUnsent)
        assertEquals("w_1", second.read { one("SELECT value FROM meta WHERE key = 'selected'") { it.text(0) } })
    }

    @Test
    fun `wipe deletes the file and the files beside it, and a closed cache refuses calls`() = runTest {
        val db = t.open()
        db.transaction { exec("INSERT INTO meta (key, value) VALUES ('selected', 'w_1')") }
        assertTrue(File(t.file.path + "-wal").exists())
        db.wipe()
        for (suffix in listOf("", "-wal", "-shm", "-journal")) assertFalse(suffix, File(t.file.path + suffix).exists())
        assertFalse(db.isOpen)
        try {
            db.read { long("SELECT 1") }
            fail("a wiped cache should refuse")
        } catch (e: WorkspaceError) {
            assertEquals("signed_out", e.code)
        }
    }

    @Test
    fun `a file of a newer schema is replaced and its unsent messages counted`() = runTest {
        val db = t.open()
        db.transaction {
            exec("UPDATE meta SET value = '2' WHERE key = 'schema'")
            exec("INSERT INTO ws (id, name, role) VALUES ('w_1', 'Team', 'owner')")
            exec(
                "INSERT INTO room (ws, id, kind, visibility, archived, grantId, members, head, floor, read, readLocal, readSent, unread, mentions) " +
                    "VALUES ('w_1', 'c_1', 'channel', 'workspace', 0, 'g_1', 2, 0, 1, 0, 0, 0, 0, 0)",
            )
            for (local in listOf("l1", "l2", "l3")) {
                exec(
                    "INSERT INTO outbox (local, ws, room, actor, grantId, generation, text, mentions, state, createdAt) " +
                        "VALUES (?, 'w_1', 'c_1', 'u_1', 'g_1', 'gen', 'hi', '[]', 'queued', 1)",
                    local,
                )
            }
        }
        db.close()
        val again = t.open()
        assertEquals(3, again.lostUnsent)
        again.read {
            assertEquals("1", one("SELECT value FROM meta WHERE key = 'schema'") { it.text(0) })
            assertEquals(0L, long("SELECT COUNT(*) FROM ws"))
        }
    }

    @Test
    fun `a file that isn't a database is replaced`() = runTest {
        t.file.parentFile!!.mkdirs()
        t.file.writeBytes(ByteArray(8192) { (it * 31).toByte() })
        val db = t.open()
        assertEquals(0, db.lostUnsent)
        assertTrue(db.quickCheck())
        assertEquals("1", db.read { one("SELECT value FROM meta WHERE key = 'schema'") { it.text(0) } })
    }

    @Test
    fun `an empty file becomes a fresh cache`() = runTest {
        t.file.parentFile!!.mkdirs()
        t.file.createNewFile()
        val db = t.open()
        assertEquals(0, db.lostUnsent)
        assertEquals("1", db.read { one("SELECT value FROM meta WHERE key = 'schema'") { it.text(0) } })
    }

    @Test
    fun `a corrupted page fails quick_check and the file is made again`() = runTest {
        val db = t.open()
        db.transaction {
            exec("INSERT INTO ws (id, name, role) VALUES ('w_1', 'Team', 'owner')")
            for (i in 0 until 400) exec("INSERT INTO meta (key, value) VALUES (?, ?)", "k$i", "x".repeat(200))
        }
        db.checkpoint()
        db.close()
        // Overwrite a page in the middle of the file with garbage: the header still says SQLite, the b-tree doesn't.
        val bytes = t.file.readBytes()
        assertTrue(bytes.size > 4096 * 4)
        for (i in 4096 * 2 until 4096 * 3) bytes[i] = 0x5a
        t.file.writeBytes(bytes)
        val again = t.open()
        assertTrue(again.quickCheck())
        assertEquals(0L, again.read { long("SELECT COUNT(*) FROM ws") })
    }
}
