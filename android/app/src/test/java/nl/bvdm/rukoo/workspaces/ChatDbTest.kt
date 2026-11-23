package nl.bvdm.rukoo.workspaces

import androidx.sqlite.SQLiteConnection
import androidx.sqlite.SQLiteDriver
import androidx.sqlite.SQLiteStatement
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.runCurrent
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
        assertEquals(listOf("event_id", "event_root", "event_roster", "outbox_room"), indexes)
        db.read {
            assertEquals(ChatDb.SCHEMA_VERSION.toString(), one("SELECT value FROM meta WHERE key = 'schema'") { it.text(0) })
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
            exec("UPDATE meta SET value = ? WHERE key = 'schema'", (ChatDb.SCHEMA_VERSION + 1).toString())
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
            assertEquals(ChatDb.SCHEMA_VERSION.toString(), one("SELECT value FROM meta WHERE key = 'schema'") { it.text(0) })
            assertEquals(0L, long("SELECT COUNT(*) FROM ws"))
        }
    }

    // Version 1 as an earlier Rukoo made it: the schema without the columns version 2 added and the index of version 3.
    private fun schemaV1(): List<String> = ChatDb.SCHEMA.filter { it != ChatDb.ROSTER_INDEX }.map {
        it.replace(Regex("\\r?\\n\\s*agent TEXT,"), "").replace(Regex("\\r?\\n\\s*agents INTEGER NOT NULL DEFAULT 0,"), "")
    }

    // Each index with the statement that made it.
    private suspend fun indexes(db: ChatDb): Map<String, String> = db.read {
        query("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL ORDER BY name") { it.text(0) to it.text(1) }.toMap()
    }

    // A version 1 file with a workspace, a person, a room, an unsent message and a draft, written straight through
    // the driver as that Rukoo did.
    private fun writeV1File(file: File, driver: SQLiteDriver, extra: List<String> = emptyList()) {
        file.parentFile!!.mkdirs()
        val c = driver.open(file.path)
        try {
            fun exec(sql: String) = c.prepare(sql).use { st -> st.step() }
            for (pragma in ChatDb.PRAGMAS) exec(pragma)
            for (statement in schemaV1()) exec(statement)
            exec("INSERT INTO meta (key, value) VALUES ('schema', '1')")
            exec("INSERT INTO ws (id, name, role, me, membersStale) VALUES ('w_1', 'Team', 'owner', 'u_1', 0)")
            exec("INSERT INTO member (ws, id, kind, name, role, state, joinedAt) VALUES ('w_1', 'u_1', 'human', 'Sam', 'owner', 'active', 1)")
            exec(
                "INSERT INTO room (ws, id, kind, visibility, archived, grantId, members, head, floor, read, readLocal, readSent, unread, mentions, muted) " +
                    "VALUES ('w_1', 'c_1', 'channel', 'workspace', 0, 'g_1', 2, 7, 1, 5, 5, 5, 2, 1, 1)",
            )
            exec(
                "INSERT INTO outbox (local, ws, room, actor, grantId, generation, text, mentions, state, createdAt) " +
                    "VALUES ('l1', 'w_1', 'c_1', 'u_1', 'g_1', 'gen', 'hi', '[]', 'queued', 1)",
            )
            exec("INSERT INTO draft (ws, room, root, text, mentions, at) VALUES ('w_1', 'c_1', '', 'half a thought', '[]', 1)")
            for (statement in extra) exec(statement)
        } finally {
            c.close()
        }
    }

    // Each table's columns as SQLite reports them: name, type, not null, default, key.
    private suspend fun columns(db: ChatDb): Map<String, List<String>> = db.read {
        val tables = query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name") { it.text(0) }
        tables.associateWith { table ->
            query("PRAGMA table_info($table)") { r -> "${r.text(1)} ${r.text(2)} ${r.long(3)} ${r.textOrNull(4)} ${r.long(5)}" }
        }
    }

    @Test
    fun `a file of version 1 migrates in place, keeps its rows and loads the directory again`() = runTest {
        val v1 = schemaV1().joinToString("\n")
        assertFalse("the version 1 schema lacks what version 2 adds", v1.contains("agent TEXT") || v1.contains("agents INTEGER"))
        assertFalse("the version 1 schema lacks what version 3 adds", v1.contains("event_roster"))
        writeV1File(t.file, t.driver)
        val db = t.open()
        assertEquals("nothing was lost", 0, db.lostUnsent)
        db.read {
            assertEquals(ChatDb.SCHEMA_VERSION.toString(), one("SELECT value FROM meta WHERE key = 'schema'") { it.text(0) })
            assertEquals("the directory loads again, for the agents' settings", 1L, long("SELECT membersStale FROM ws WHERE id = 'w_1'"))
            assertEquals(1L, long("SELECT COUNT(*) FROM outbox"))
            assertEquals("half a thought", one("SELECT text FROM draft") { it.text(0) })
            assertTrue(one("SELECT agent FROM member WHERE id = 'u_1'") { it.isNull(0) }!!)
        }
        val store = WorkspaceStore(db)
        store.read {
            val room = getRoom("w_1", "c_1")!!
            assertEquals(0, room.agents)
            assertEquals(7L, room.head)
            assertEquals(5L, room.readLocal)
            assertTrue(room.muted)
            assertEquals(listOf(Member("u_1", "human", "Sam", "owner", "active", 1)), listMembers("w_1"))
            // The roster queries name the index version 3 makes, so they would fail without it.
            assertEquals(emptyMap<String, Long>(), rosters("w_1"))
            assertEquals(0L, roster("w_1", "c_1"))
        }
        // A migrated file and a new one have the same tables with the same columns in the same order, and the same
        // indexes.
        val fresh = TestDb()
        try {
            val made = fresh.open()
            assertEquals(columns(made), columns(db))
            assertEquals(indexes(made), indexes(db))
        } finally {
            fresh.close()
        }
    }

    @Test
    fun `a migration SQLite refuses rolls back and keeps the file with its unsent messages`() = runTest {
        // A version 1 file that already has the column the migration adds: its ALTER fails half way.
        writeV1File(t.file, t.driver, extra = listOf("ALTER TABLE room ADD COLUMN agents INTEGER NOT NULL DEFAULT 0"))
        try {
            t.open()
            fail("the migration should fail")
        } catch (e: WorkspaceError) {
            assertEquals("not_saved", e.code)
        }
        assertTrue(t.file.exists())
        val c = t.driver.open(t.file.path)
        try {
            assertEquals("1", c.prepare("SELECT value FROM meta WHERE key = 'schema'").use { st -> st.step(); st.getText(0) })
            assertEquals(1L, c.prepare("SELECT COUNT(*) FROM outbox").use { st -> st.step(); st.getLong(0) })
            // The member column of the first statement went with the rollback.
            assertFalse(c.prepare("PRAGMA table_info(member)").use { st -> buildList { while (st.step()) add(st.getText(1)) } }.contains("agent"))
        } finally {
            c.close()
        }
    }

    @Test
    fun `a file that isn't a database is replaced`() = runTest {
        t.file.parentFile!!.mkdirs()
        t.file.writeBytes(ByteArray(8192) { (it * 31).toByte() })
        val db = t.open()
        assertEquals(0, db.lostUnsent)
        assertTrue(db.quickCheck())
        assertEquals(ChatDb.SCHEMA_VERSION.toString(), db.read { one("SELECT value FROM meta WHERE key = 'schema'") { it.text(0) } })
    }

    @Test
    fun `an empty file becomes a fresh cache`() = runTest {
        t.file.parentFile!!.mkdirs()
        t.file.createNewFile()
        val db = t.open()
        assertEquals(0, db.lostUnsent)
        assertEquals(ChatDb.SCHEMA_VERSION.toString(), db.read { one("SELECT value FROM meta WHERE key = 'schema'") { it.text(0) } })
    }

    @Test
    fun `a collector that falls far behind still hears every room`() = runTest {
        val db = t.open()
        val ws = "w_AAAAAAAAAAAAAAAAAAAAAA"
        val gate = CompletableDeferred<Unit>()
        val seen = mutableListOf<DbChange>()
        val job = launch {
            db.changes.collect {
                seen += it
                // The first change parks the collector, as a slow re-query would, while the burst below commits.
                if (seen.size == 1) gate.await()
            }
        }
        runCurrent()
        db.transaction { touch(ws, "c_gate") }
        runCurrent()
        assertEquals(1, seen.size)
        val burst = 200
        repeat(burst) { i -> db.transaction { touch(ws, "c_$i") } }
        gate.complete(Unit)
        runCurrent()
        assertEquals(burst + 1, seen.size)
        assertTrue("the first room of the burst arrived", seen[1].affects(ws, "c_0"))
        assertTrue(seen.last().affects(ws, "c_${burst - 1}"))
        job.cancel()
    }

    @Test
    fun `a committed transaction returns its result to a caller cancelled meanwhile`() = runBlocking {
        val io = Executors.newSingleThreadExecutor().asCoroutineDispatcher()
        val own = TestDb(io)
        try {
            val db = own.open()
            val inside = CountDownLatch(1)
            val release = CountDownLatch(1)
            val got = AtomicReference<String?>()
            val threw = AtomicReference<Throwable?>()
            val caller = launch(Dispatchers.Default) {
                try {
                    got.set(
                        db.transaction {
                            inside.countDown()
                            release.await()
                            exec("INSERT INTO meta (key, value) VALUES ('sent', 'l1')")
                            "l1"
                        },
                    )
                } catch (e: Throwable) {
                    threw.set(e)
                }
            }
            assertTrue(inside.await(10, TimeUnit.SECONDS))
            caller.cancel()
            release.countDown()
            caller.join()
            assertNull(threw.get())
            assertEquals("the caller learns the row is on disk", "l1", got.get())
            assertEquals("l1", db.read { one("SELECT value FROM meta WHERE key = 'sent'") { it.text(0) } })
            db.close()
        } finally {
            own.close()
            io.close()
        }
    }

    @Test
    fun `a caller cancelled while waiting for the connection writes nothing`() = runBlocking {
        val io = Executors.newFixedThreadPool(2).asCoroutineDispatcher()
        val own = TestDb(io)
        try {
            val db = own.open()
            val inside = CountDownLatch(1)
            val release = CountDownLatch(1)
            val first = launch(Dispatchers.Default) {
                db.transaction {
                    inside.countDown()
                    release.await()
                    exec("INSERT INTO meta (key, value) VALUES ('first', '1')")
                }
            }
            assertTrue(inside.await(10, TimeUnit.SECONDS))
            val cancelled = AtomicReference<Throwable?>()
            val second = launch(Dispatchers.Default) {
                try {
                    db.transaction { exec("INSERT INTO meta (key, value) VALUES ('second', '1')") }
                } catch (e: CancellationException) {
                    cancelled.set(e)
                }
            }
            delay(100)
            second.cancel()
            release.countDown()
            first.join()
            second.join()
            assertTrue(cancelled.get() is CancellationException)
            db.read {
                assertEquals("1", one("SELECT value FROM meta WHERE key = 'first'") { it.text(0) })
                assertNull(one("SELECT value FROM meta WHERE key = 'second'") { it.text(0) })
            }
            db.close()
        } finally {
            own.close()
            io.close()
        }
    }

    @Test
    fun `a file another connection holds locked is kept with its unsent messages`() = runTest {
        val db = t.open()
        db.transaction {
            exec("INSERT INTO ws (id, name, role) VALUES ('w_1', 'Team', 'owner')")
            exec(
                "INSERT INTO room (ws, id, kind, visibility, archived, grantId, members, head, floor, read, readLocal, readSent, unread, mentions) " +
                    "VALUES ('w_1', 'c_1', 'channel', 'workspace', 0, 'g_1', 2, 0, 1, 0, 0, 0, 0, 0)",
            )
            for (local in listOf("l1", "l2")) {
                exec(
                    "INSERT INTO outbox (local, ws, room, actor, grantId, generation, text, mentions, state, createdAt) " +
                        "VALUES (?, 'w_1', 'c_1', 'u_1', 'g_1', 'gen', 'hi', '[]', 'queued', 1)",
                    local,
                )
            }
        }
        db.close()
        // Another connection takes the file for itself, as one not closed yet can: every read elsewhere is busy.
        val holder = t.driver.open(t.file.path)
        try {
            holder.prepare("PRAGMA locking_mode = EXCLUSIVE").use { while (it.step()) Unit }
            holder.prepare("BEGIN EXCLUSIVE").use { it.step() }
            holder.prepare("UPDATE meta SET value = value WHERE key = 'schema'").use { it.step() }
            assertNull("busy isn't broken: the file stays", ChatDb.inspect(t.file, t.driver))
            try {
                t.open().close()
            } catch (e: WorkspaceError) {
                assertEquals("not_saved", e.code)
            }
            assertTrue(t.file.exists())
        } finally {
            runCatching { holder.prepare("ROLLBACK").use { it.step() } }
            holder.close()
        }
        val again = t.open()
        assertEquals(0, again.lostUnsent)
        assertEquals(2L, again.read { long("SELECT COUNT(*) FROM outbox") })
    }

    @Test
    fun `an open cancelled after the driver opened the file closes that connection`() = runTest {
        val closed = AtomicReference<Boolean?>(null)
        var caller: Job? = null
        // The caller goes away while the connection is being made: withContext drops the ChatDb on its way back.
        val driver = object : SQLiteDriver {
            override fun open(fileName: String): SQLiteConnection {
                val c = t.driver.open(fileName)
                caller?.cancel()
                closed.set(false)
                return object : SQLiteConnection by c {
                    override fun close() {
                        closed.set(true)
                        c.close()
                    }
                }
            }
        }
        val job = launch { ChatDb.open(t.file, driver, Dispatchers.Unconfined) }
        caller = job
        job.join()
        assertTrue(job.isCancelled)
        assertEquals("the connection nobody received is closed", true, closed.get())
    }

    /** A driver whose connections fail [failing] with [error] while [on] is true, as a passing I/O fault would. */
    private class FlakyDriver(val real: SQLiteDriver, val failing: String, val error: String) : SQLiteDriver {
        @Volatile var on = true
        @Volatile var failOpen = false

        override fun open(fileName: String): SQLiteConnection {
            if (on && failOpen) throw RuntimeException(error)
            val c = real.open(fileName)
            return object : SQLiteConnection by c {
                override fun prepare(sql: String): SQLiteStatement {
                    if (on && sql.startsWith(failing)) throw RuntimeException(error)
                    return c.prepare(sql)
                }
            }
        }
    }

    private suspend fun seedUnsent(count: Int) {
        val db = t.open()
        db.transaction {
            exec("INSERT INTO ws (id, name, role) VALUES ('w_1', 'Team', 'owner')")
            exec(
                "INSERT INTO room (ws, id, kind, visibility, archived, grantId, members, head, floor, read, readLocal, readSent, unread, mentions) " +
                    "VALUES ('w_1', 'c_1', 'channel', 'workspace', 0, 'g_1', 2, 0, 1, 0, 0, 0, 0, 0)",
            )
            for (i in 0 until count) {
                exec(
                    "INSERT INTO outbox (local, ws, room, actor, grantId, generation, text, mentions, state, createdAt) " +
                        "VALUES (?, 'w_1', 'c_1', 'u_1', 'g_1', 'gen', 'hi', '[]', 'queued', 1)",
                    "l$i",
                )
            }
            exec("INSERT INTO draft (ws, room, root, text, mentions, at) VALUES ('w_1', 'c_1', '', 'draft', '[]', 1)")
        }
        db.close()
    }

    @Test
    fun `a passing I-O error while checking the file keeps it with its unsent messages and draft`() = runTest {
        seedUnsent(2)
        for ((failing, error, failOpen) in listOf(
            Triple("PRAGMA quick_check", "Error code: 10, message: disk I/O error", false),
            Triple("SELECT value FROM meta", "Error code: 10, message: disk I/O error", false),
            Triple("", "Error code: 14, message: unable to open database file", true),
        )) {
            val flaky = FlakyDriver(t.driver, failing, error).also { it.failOpen = failOpen }
            assertNull("$error at $failing confirms nothing", ChatDb.inspect(t.file, flaky))
            assertTrue(t.file.exists())
            // The I/O passed: the file opens with everything in it.
            flaky.on = false
            val again = ChatDb.open(t.file, flaky, kotlinx.coroutines.Dispatchers.Unconfined)
            assertEquals(0, again.lostUnsent)
            assertEquals(2L, again.read { long("SELECT COUNT(*) FROM outbox") })
            assertEquals(1L, again.read { long("SELECT COUNT(*) FROM draft") })
            again.close()
        }
    }

    @Test
    fun `passing I-O errors are told apart from a broken file in both drivers' words`() {
        assertTrue(ChatDb.isTransient(RuntimeException("Error code: 10, message: disk I/O error")))
        assertTrue(ChatDb.isTransient(RuntimeException("disk I/O error (code 266 SQLITE_IOERR_READ)")))
        assertTrue(ChatDb.isTransient(IllegalStateException("wrapped", RuntimeException("Error code: 14, message: unable to open database file"))))
        assertTrue(ChatDb.isTransient(RuntimeException("Error code: 13, message: database or disk is full")))
        assertFalse(ChatDb.isTransient(RuntimeException("Error code: 11, message: database disk image is malformed")))
        assertFalse(ChatDb.isTransient(RuntimeException("Error code: 26, message: file is not a database")))
        assertFalse(ChatDb.isTransient(RuntimeException("file is not a database (code 26 SQLITE_NOTADB)")))
        assertFalse(ChatDb.isTransient(RuntimeException("(code 779 SQLITE_CORRUPT_INDEX)")))
        assertFalse(ChatDb.isTransient(RuntimeException()))
    }

    @Test
    fun `busy and locked errors are told apart from a broken file in both drivers' words`() {
        assertTrue(ChatDb.isBusy(RuntimeException("Error code: 5, message: database is locked")))
        assertTrue(ChatDb.isBusy(RuntimeException("Error code: 6, message: database table is locked")))
        assertTrue(ChatDb.isBusy(RuntimeException("database is locked (code 5 SQLITE_BUSY)")))
        assertTrue(ChatDb.isBusy(IllegalStateException("wrapped", RuntimeException("(code 517 SQLITE_BUSY_SNAPSHOT)"))))
        assertFalse(ChatDb.isBusy(RuntimeException("Error code: 11, message: database disk image is malformed")))
        assertFalse(ChatDb.isBusy(RuntimeException("Error code: 26, message: file is not a database")))
        assertFalse(ChatDb.isBusy(RuntimeException("file is not a database (code 26 SQLITE_NOTADB)")))
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
