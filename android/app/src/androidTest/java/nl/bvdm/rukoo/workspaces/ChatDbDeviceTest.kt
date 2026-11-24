package nl.bvdm.rukoo.workspaces

import android.util.Log
import androidx.sqlite.driver.AndroidSQLiteDriver
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * The chat cache on the platform's SQLite through AndroidSQLiteDriver, as the app opens it. JVM tests run the same
 * code on the bundled SQLite 3.4x; Android 12 and 13 ship 3.32, where JSON functions are a build option, and the
 * framework runs BEGIN, COMMIT and ROLLBACK through its own session. Run it on an API 31 emulator:
 * `./gradlew connectedDebugAndroidTest -Pandroid.testInstrumentationRunnerArguments.class=nl.bvdm.rukoo.workspaces.ChatDbDeviceTest`
 * with ANDROID_SERIAL set to that emulator.
 */
class ChatDbDeviceTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    private val dir = File(context.cacheDir, "chat-db-device-test-${System.nanoTime()}")
    private val file = ChatDb.fileIn(dir)
    private val driver = AndroidSQLiteDriver()
    private val opened = mutableListOf<ChatDb>()

    private val ws = "w_" + "A".repeat(22)
    private val c1 = "c_" + "A".repeat(22)
    private val me = "u_" + "M".repeat(22)
    private val olga = "u_" + "O".repeat(22)
    private val sam = "u_" + "S".repeat(22)

    @After
    fun tearDown() = runBlocking {
        opened.forEach { runCatching { it.close() } }
        dir.deleteRecursively()
        Unit
    }

    private suspend fun open(): ChatDb = ChatDb.open(file, driver, Dispatchers.IO).also { opened += it }

    private suspend fun seeded(): WorkspaceStore {
        val store = WorkspaceStore(open()) { 1_763_550_000_000L }
        store.tx {
            insertWs(WsRow(id = ws, name = "Team", role = "owner", me = me, myName = "Me", generation = "gen1"))
            upsertRoom(
                ws,
                Change(
                    conversation = c1, kind = "channel", name = "general", visibility = "workspace", grant = "g_1", role = "member",
                    members = 2, head = 10, floor = 1, lastAt = 1010, read = 0, unread = 0, mentions = 0,
                ),
            )
        }
        return store
    }

    private fun msg(seq: Long, actor: String = olga, mentions: List<Mention> = emptyList()) = WireEvent(
        seq = seq, id = "e_" + seq.toString().padStart(22, '0'), kind = WireEvent.MESSAGE_POSTED, actor = actor, at = 1000L + seq,
        text = "message $seq", mentions = mentions,
    )

    private fun outbox(local: String, createdAt: Long, state: String = "queued", reason: String? = null, generation: String = "gen1") =
        OutboxRow(local = local, ws = ws, room = c1, actor = me, grantId = "g_1", generation = generation, text = "hi $local",
            mentions = listOf(Mention(olga, 0, 2)), root = null, state = state, reason = reason, createdAt = createdAt)

    @Test
    fun opensWithTheSchemaAndPragmasOnThePlatformSqlite() = runBlocking {
        val db = open()
        db.read {
            val version = one("SELECT sqlite_version()") { it.text(0) }
            Log.i("ChatDbDeviceTest", "platform SQLite $version on API ${android.os.Build.VERSION.SDK_INT}")
            assertEquals(ChatDb.SCHEMA_VERSION.toString(), one("SELECT value FROM meta WHERE key = 'schema'") { it.text(0) })
            // The framework adds its own android_metadata table beside the twelve of §3.5.
            assertEquals(12L, long("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name != 'android_metadata'"))
            assertEquals(1L, long("PRAGMA foreign_keys"))
            assertEquals(2000L, long("PRAGMA busy_timeout"))
        }
        assertEquals("wal", db.read { one("PRAGMA journal_mode") { it.text(0) } })
        assertTrue(db.quickCheck())
    }

    @Test
    fun aTransactionCommitsAndAThrowRollsBack() = runBlocking {
        val db = open()
        val changed = db.transaction {
            exec("INSERT INTO meta (key, value) VALUES ('a', '1')")
            exec("INSERT INTO meta (key, value) VALUES ('b', '1')")
            // changes() has to read the connection that just wrote.
            exec("UPDATE meta SET value = '2' WHERE key IN ('a', 'b')")
        }
        assertEquals(2, changed)
        try {
            db.transaction {
                exec("INSERT INTO meta (key, value) VALUES ('c', '1')")
                exec("UPDATE meta SET value = '3' WHERE key = 'a'")
                error("boom")
            }
            fail("the transaction should throw")
        } catch (e: IllegalStateException) {
            assertEquals("boom", e.message)
        }
        db.read {
            assertEquals("2", one("SELECT value FROM meta WHERE key = 'a'") { it.text(0) })
            assertNull(one("SELECT value FROM meta WHERE key = 'c'") { it.text(0) })
        }
        // A SQL failure inside rolls back too, and the connection takes the next transaction.
        try {
            db.transaction {
                exec("INSERT INTO meta (key, value) VALUES ('d', '1')")
                exec("INSERT INTO ws (id, name, role, state) VALUES ('w_x', 'A', 'owner', 'broken')")
            }
            fail("the CHECK should refuse the state")
        } catch (e: WorkspaceError) {
            assertEquals("not_saved", e.code)
        }
        db.transaction { exec("INSERT INTO meta (key, value) VALUES ('e', '1')") }
        db.read {
            assertNull(one("SELECT value FROM meta WHERE key = 'd'") { it.text(0) })
            assertEquals("1", one("SELECT value FROM meta WHERE key = 'e'") { it.text(0) })
        }
    }

    @Test
    fun badgesCountMentionsAndLeaveOutBlockedAuthors() = runBlocking {
        val store = seeded()
        store.tx {
            val toMe = listOf(Mention(me, 0, 3))
            appendEvents(
                ws, c1,
                listOf(
                    msg(1, mentions = toMe),
                    msg(2, mentions = toMe),
                    msg(3, actor = sam, mentions = toMe),
                    msg(4, actor = me),
                    msg(5),
                    msg(6, mentions = toMe),
                ),
            )
            redact(ws, listOf("e_" + "6".padStart(22, '0')))
        }
        assertEquals(Badges(unread = 3, mentions = 2), store.read { countBadges(ws, c1, 1, me, emptyList()) })
        store.tx { replaceBlocks(ws, listOf(Block(sam, 1))) }
        assertEquals(Badges(unread = 3, mentions = 1), store.read { countBadges(ws, c1, 1, me) })
        store.tx { appendEvents(ws, c1, (7L..120L).map { msg(it) }) }
        assertEquals(WorkspaceStore.BADGE_CAP, store.read { countBadges(ws, c1, 0, me) }.unread)
    }

    @Test
    fun markLookupCountsTheRowsItMarks() = runBlocking {
        val store = seeded()
        store.tx {
            insertOutbox(outbox("q", createdAt = 1).copy(nextAt = 99))
            insertOutbox(outbox("s", createdAt = 2, state = "sending"))
            insertOutbox(outbox("h", createdAt = 3, state = "held", reason = "stale_grant"))
            insertOutbox(outbox("u", createdAt = 4, state = "held", reason = "unknown"))
            insertOutbox(outbox("old", createdAt = 6, generation = "gen0"))
        }
        assertEquals(1, store.tx { markLookup(ws, "gen0") })
        assertEquals(4, store.tx { markLookup(ws) })
        store.read {
            for (local in listOf("q", "s", "h", "old")) assertEquals(local, "lookup", getOutbox(local)!!.reason)
            assertEquals("held", getOutbox("u")!!.state)
        }
    }

    @Test
    fun aLockedFileIsKeptAndReopensWithItsOutbox() = runBlocking {
        val store = seeded()
        store.tx { insertOutbox(outbox("q", createdAt = 1)) }
        store.close()
        val holder = driver.open(file.path)
        try {
            holder.prepare("PRAGMA locking_mode = EXCLUSIVE").use { while (it.step()) Unit }
            holder.prepare("BEGIN EXCLUSIVE").use { it.step() }
            holder.prepare("UPDATE meta SET value = value WHERE key = 'schema'").use { it.step() }
            assertNull("busy isn't broken: the file stays", ChatDb.inspect(file, driver))
        } finally {
            runCatching { holder.prepare("ROLLBACK").use { it.step() } }
            holder.close()
        }
        val again = open()
        assertEquals(0, again.lostUnsent)
        assertEquals(1L, again.read { long("SELECT COUNT(*) FROM outbox") })
    }

    @Test
    fun wipeLeavesNoFileBehind() = runBlocking {
        val db = open()
        db.transaction { exec("INSERT INTO meta (key, value) VALUES ('selected', 'w_1')") }
        db.wipe()
        for (suffix in listOf("", "-wal", "-shm", "-journal")) assertFalse(suffix, File(file.path + suffix).exists())
    }
}
