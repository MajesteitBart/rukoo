package nl.bvdm.rukoo.workspaces

import androidx.sqlite.SQLiteConnection
import androidx.sqlite.SQLiteDriver
import androidx.sqlite.SQLiteStatement
import java.io.File
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

/**
 * What a committed transaction touched, so the UI's flows query again only when it concerns them. [ws] null means
 * the whole cache (a wipe). [rooms] empty means something of the workspace itself: its row, its directory or its
 * room list.
 */
data class DbChange(val ws: String?, val rooms: Set<String> = emptySet()) {
    fun affects(ws: String): Boolean = this.ws == null || this.ws == ws
    fun affects(ws: String, room: String): Boolean = this.ws == null || (this.ws == ws && (rooms.isEmpty() || room in rooms))
}

/**
 * Plain SQL on the chat cache's one connection, for the length of a transaction. [args] bind in order: a String,
 * a whole number (Int, Long), a Boolean (as 0 or 1), a Double, or null.
 */
class Sql internal constructor(private val conn: SQLiteConnection) {
    internal val touched = LinkedHashMap<String, MutableSet<String>>()
    internal var touchedAll = false

    /** Runs a statement that returns no rows, and gives how many rows it changed. */
    fun exec(sql: String, vararg args: Any?): Int {
        conn.prepare(sql).use { st ->
            bind(st, args)
            while (st.step()) Unit
        }
        return conn.prepare("SELECT changes()").use { st -> st.step(); st.getLong(0).toInt() }
    }

    /** Every row of a query, each read by [row] while the statement is on it. */
    fun <T> query(sql: String, vararg args: Any?, row: (Row) -> T): List<T> = conn.prepare(sql).use { st ->
        bind(st, args)
        val out = ArrayList<T>()
        val r = Row(st)
        while (st.step()) out.add(row(r))
        out
    }

    /** The first row of a query, or null when it has none. */
    fun <T> one(sql: String, vararg args: Any?, row: (Row) -> T): T? = conn.prepare(sql).use { st ->
        bind(st, args)
        if (st.step()) row(Row(st)) else null
    }

    /** A query's single whole number, such as a COUNT. */
    fun long(sql: String, vararg args: Any?): Long = one(sql, *args) { it.long(0) } ?: 0

    /** Records that this transaction changed [ws], and in it [rooms] when given. */
    fun touch(ws: String, vararg rooms: String) {
        val set = touched.getOrPut(ws) { LinkedHashSet() }
        // An empty set stands for the workspace as a whole, which covers its rooms too.
        if (rooms.isEmpty()) touched[ws] = WHOLE else if (set !== WHOLE) set.addAll(rooms)
    }

    /** Records that this transaction changed every workspace. */
    fun touchAll() {
        touchedAll = true
    }

    internal fun drained(): List<DbChange> = when {
        touchedAll -> listOf(DbChange(null))
        else -> touched.map { (ws, rooms) -> DbChange(ws, if (rooms === WHOLE) emptySet() else rooms.toSet()) }
    }.also { touched.clear(); touchedAll = false }

    private fun bind(st: SQLiteStatement, args: Array<out Any?>) {
        args.forEachIndexed { i, value ->
            val at = i + 1
            when (value) {
                null -> st.bindNull(at)
                is String -> st.bindText(at, value)
                is Long -> st.bindLong(at, value)
                is Int -> st.bindLong(at, value.toLong())
                is Boolean -> st.bindLong(at, if (value) 1 else 0)
                is Double -> st.bindDouble(at, value)
                else -> throw IllegalArgumentException("can't bind ${value::class.simpleName}")
            }
        }
    }

    private companion object {
        // A marker set: the whole workspace changed.
        val WHOLE: MutableSet<String> = java.util.Collections.unmodifiableSet(LinkedHashSet<String>())
    }
}

/** One row of a query, read by column index. */
class Row internal constructor(private val st: SQLiteStatement) {
    fun isNull(i: Int): Boolean = st.isNull(i)
    fun text(i: Int): String = st.getText(i)
    fun textOrNull(i: Int): String? = if (st.isNull(i)) null else st.getText(i)
    fun long(i: Int): Long = st.getLong(i)
    fun longOrNull(i: Int): Long? = if (st.isNull(i)) null else st.getLong(i)
    fun int(i: Int): Int = st.getLong(i).toInt()
    fun bool(i: Int): Boolean = st.getLong(i) != 0L
}

/**
 * The team chat cache: the single file `filesDir/chat/chat.db` with the schema both apps share (contract §3.5).
 *
 * One [SQLiteConnection] serves every call, guarded by a [Mutex] and run on [io]. [transaction] runs `BEGIN
 * IMMEDIATE`, the block, then `COMMIT`, or `ROLLBACK` when the block throws, and only after a commit tells [changes]
 * what it touched. The block can't suspend, so a transaction never spans a network call. A write SQLite refuses
 * (a full disk, a read-only file) throws `WorkspaceError("not_saved")`.
 *
 * The app opens the file with AndroidSQLiteDriver (the platform's SQLite, nothing added to the APK). JVM tests open
 * the same code with BundledSQLiteDriver; ChatDbDeviceTest (androidTest) runs it on the platform's SQLite, which on
 * Android 12 and 13 is 3.32.
 */
class ChatDb private constructor(
    val file: File,
    private var conn: SQLiteConnection?,
    private val io: CoroutineDispatcher,
    /** How many unsent messages a broken file held when [open] replaced it; 0 otherwise. */
    val lostUnsent: Int,
) {
    private val mutex = Mutex()

    // Unbounded: a collector that falls behind during a burst (a 50-page pass, a backfill) still hears every room
    // that changed. A bounded buffer that drops the oldest would lose a touch without a signal, and the room's flow
    // would keep showing a removed message. Each entry is a few small objects.
    private val _changes = MutableSharedFlow<DbChange>(extraBufferCapacity = Channel.UNLIMITED)

    /** What each committed transaction touched. No entry is ever dropped. */
    val changes: SharedFlow<DbChange> = _changes.asSharedFlow()

    val isOpen: Boolean get() = conn != null

    /**
     * Runs [block] in one write transaction. Its result is returned after the commit.
     *
     * A `CancellationException` from here means nothing was written: once COMMIT succeeds, the result comes back even
     * when the caller was cancelled meanwhile (the caller's next suspension then throws), so what the person sees as
     * pending matches what is on disk (§3.8). Cancellation while waiting for the connection throws before BEGIN.
     */
    suspend fun <T> transaction(block: Sql.() -> T): T {
        val done = Committed<T>()
        try {
            return withContext(io) {
                mutex.withLock {
                    val c = conn ?: throw WorkspaceError("signed_out", message = "The chat cache is closed.")
                    val sql = Sql(c)
                    run(c, "BEGIN IMMEDIATE")
                    val result = try {
                        sql.block().also { run(c, "COMMIT") }
                    } catch (e: Throwable) {
                        runCatching { run(c, "ROLLBACK") }
                        throw translate(e)
                    }
                    done.set(result)
                    for (change in sql.drained()) _changes.tryEmit(change)
                    result
                }
            }
        } catch (e: CancellationException) {
            // withContext hands its result back to a cancelled caller as a CancellationException; a commit stands.
            if (done.isSet) return done.value
            throw e
        }
    }

    /** A transaction's result once it committed, read back when the caller was cancelled on the way out. */
    private class Committed<T> {
        @Volatile var isSet = false
            private set
        @Suppress("UNCHECKED_CAST")
        val value: T get() = held as T
        private var held: Any? = null

        fun set(result: T) {
            held = result
            isSet = true
        }
    }

    /** Runs [block] in a read transaction: one consistent view of the cache. It must not write. */
    suspend fun <T> read(block: Sql.() -> T): T = withContext(io) {
        mutex.withLock {
            val c = conn ?: throw WorkspaceError("signed_out", message = "The chat cache is closed.")
            run(c, "BEGIN")
            try {
                Sql(c).block().also { run(c, "COMMIT") }
            } catch (e: Throwable) {
                runCatching { run(c, "ROLLBACK") }
                throw translate(e)
            }
        }
    }

    /** `PRAGMA quick_check`: true when SQLite finds the file sound. */
    suspend fun quickCheck(): Boolean = withContext(io) {
        mutex.withLock {
            val c = conn ?: return@withLock false
            runCatching { quickCheck(c) }.getOrDefault(false)
        }
    }

    /** Writes the WAL back into the file and truncates it, so deleted pages don't linger there. */
    suspend fun checkpoint() = withContext(io) {
        mutex.withLock { conn?.let { c -> runCatching { run(c, "PRAGMA wal_checkpoint(TRUNCATE)") } } }
        Unit
    }

    /** Closes the connection. Later calls throw `signed_out`. */
    suspend fun close() = withContext(io) {
        mutex.withLock { closeLocked() }
    }

    /**
     * Ends the cache: closes the connection and deletes the file with its `-wal`, `-shm` and `-journal` files
     * (§3.4). Every flow hears a [DbChange] for the whole cache.
     */
    suspend fun wipe() = withContext(io) {
        mutex.withLock {
            closeLocked()
            deleteFiles(file)
        }
        _changes.tryEmit(DbChange(null))
        Unit
    }

    private fun closeLocked() {
        val c = conn ?: return
        conn = null
        runCatching { c.close() }
    }

    companion object {
        /** The version in `meta.schema` this build writes and reads. */
        const val SCHEMA_VERSION = 1

        const val FILE_NAME = "chat.db"

        /** `filesDir/chat/chat.db`. */
        fun fileIn(filesDir: File): File = File(File(filesDir, "chat"), FILE_NAME)

        /**
         * Opens [file], making it with the §3.5 schema when it is new. A file that fails `quick_check`, has a higher
         * `meta.schema` than this build knows, or isn't a chat cache at all is deleted and made again; when its
         * outbox could still be counted, [lostUnsent] says how many unsent messages went with it.
         */
        suspend fun open(file: File, driver: SQLiteDriver, io: CoroutineDispatcher = Dispatchers.IO): ChatDb = withContext(io) {
            file.parentFile?.mkdirs()
            var lost = 0
            if (file.exists()) {
                val verdict = inspect(file, driver)
                if (verdict != null) {
                    lost = verdict
                    deleteFiles(file)
                }
            }
            val conn = try {
                driver.open(file.path).also { c ->
                    try {
                        pragmas(c)
                        if (!hasTable(c, "meta")) createSchema(c)
                    } catch (e: Throwable) {
                        runCatching { c.close() }
                        throw e
                    }
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: WorkspaceError) {
                throw e
            } catch (e: Throwable) {
                throw WorkspaceError("not_saved", message = "The chat cache can't be opened.", cause = e)
            }
            ChatDb(file, conn, io, lost)
        }

        /** Deletes the cache file and the files SQLite keeps beside it. */
        fun deleteFiles(file: File) {
            for (suffix in listOf("", "-wal", "-shm", "-journal")) File(file.path + suffix).delete()
        }

        /**
         * Whether an existing file can be kept: null when it can, else the number of unsent messages it held (0 when
         * they can't be counted). A file another connection holds locked (one not closed yet, a checkpoint) is kept:
         * busy says nothing about the file, and deleting it would take its unsent messages along.
         */
        internal fun inspect(file: File, driver: SQLiteDriver): Int? {
            val c = try {
                driver.open(file.path)
            } catch (e: Throwable) {
                return if (isBusy(e)) null else 0
            }
            try {
                runCatching { run(c, "PRAGMA busy_timeout = $INSPECT_BUSY_MS") }
                var started = System.nanoTime()
                val sound = try {
                    quickCheck(c)
                } catch (e: Throwable) {
                    if (isBusy(e) || waitedOut(started)) return null
                    false
                }
                started = System.nanoTime()
                val schema = try {
                    schemaOf(c)
                } catch (e: Throwable) {
                    if (isBusy(e) || waitedOut(started)) return null
                    null
                }
                val keep = sound && schema == SCHEMA_VERSION
                // An empty file (or one SQLite made but nobody wrote) has no tables yet and becomes a fresh cache.
                val empty = sound && runCatching { tableCount(c) == 0L }.getOrDefault(false)
                if (keep || empty) return null
                return runCatching { countUnsent(c) }.getOrDefault(0)
            } finally {
                runCatching { c.close() }
            }
        }

        /** How long [inspect] waits for another connection's lock before it gives up and keeps the file. */
        private const val INSPECT_BUSY_MS = 2000

        /**
         * Whether a read that failed spent the busy timeout waiting first. SQLite only waits in its busy handler, so
         * this tells busy apart from a broken file whatever the exception says; under JVM tests the bundled driver's
         * exception arrives without its message.
         */
        private fun waitedOut(startedNs: Long): Boolean = System.nanoTime() - startedNs >= INSPECT_BUSY_MS * 900_000L

        /**
         * SQLITE_BUSY (5) or SQLITE_LOCKED (6), from either driver: BundledSQLiteDriver's `androidx.sqlite.SQLiteException`
         * says "Error code: 5", the platform's `SQLiteDatabaseLockedException` says "(code 5 SQLITE_BUSY)".
         */
        internal fun isBusy(e: Throwable): Boolean {
            var t: Throwable? = e
            var depth = 0
            while (t != null && depth++ < 8) {
                if (t.javaClass.simpleName.let { it.contains("Locked") || it.contains("Busy") }) return true
                val m = t.message.orEmpty()
                if (BUSY_TEXT.any { m.contains(it, ignoreCase = true) }) return true
                if (BUSY_CODE.containsMatchIn(m)) return true
                t = t.cause
            }
            return false
        }

        private val BUSY_TEXT = listOf("SQLITE_BUSY", "SQLITE_LOCKED", "database is locked", "database table is locked")
        private val BUSY_CODE = Regex("""(?i)\b(?:error )?code:? ?(5|6|261|262|517)\b""")

        private fun pragmas(c: SQLiteConnection) {
            for (pragma in PRAGMAS) run(c, pragma)
        }

        private fun createSchema(c: SQLiteConnection) {
            run(c, "BEGIN IMMEDIATE")
            try {
                for (statement in SCHEMA) run(c, statement)
                c.prepare("INSERT INTO meta (key, value) VALUES ('schema', ?)").use { it.bindText(1, SCHEMA_VERSION.toString()); it.step() }
                run(c, "COMMIT")
            } catch (e: Throwable) {
                runCatching { run(c, "ROLLBACK") }
                throw e
            }
        }

        private fun quickCheck(c: SQLiteConnection): Boolean =
            c.prepare("PRAGMA quick_check").use { st -> st.step() && st.getText(0) == "ok" }

        private fun hasTable(c: SQLiteConnection, name: String): Boolean =
            c.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").use { st -> st.bindText(1, name); st.step() }

        private fun tableCount(c: SQLiteConnection): Long =
            c.prepare("SELECT COUNT(*) FROM sqlite_master").use { st -> st.step(); st.getLong(0) }

        private fun schemaOf(c: SQLiteConnection): Int? {
            if (!hasTable(c, "meta")) return null
            return c.prepare("SELECT value FROM meta WHERE key = 'schema'").use { st -> if (st.step()) st.getText(0).toIntOrNull() else null }
        }

        private fun countUnsent(c: SQLiteConnection): Int =
            c.prepare("SELECT COUNT(*) FROM outbox").use { st -> st.step(); st.getLong(0).toInt() }

        private fun run(c: SQLiteConnection, sql: String) {
            c.prepare(sql).use { st -> while (st.step()) Unit }
        }

        private fun translate(e: Throwable): Throwable = when (e) {
            is CancellationException, is WorkspaceError, is Error -> e
            is IllegalArgumentException, is IllegalStateException, is NoSuchElementException,
            is kotlinx.serialization.SerializationException -> e
            // Anything else came from SQLite: a write it couldn't make.
            else -> WorkspaceError("not_saved", message = "Rukoo couldn't save this on the phone.", cause = e)
        }

        internal val PRAGMAS = listOf(
            "PRAGMA journal_mode = WAL",
            "PRAGMA synchronous = NORMAL",
            "PRAGMA foreign_keys = ON",
            "PRAGMA secure_delete = ON",
            "PRAGMA busy_timeout = 2000",
        )

        /** Contract §3.5, statement by statement, the same SQL as desktop's store.js. */
        internal val SCHEMA = listOf(
            "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID",
            """CREATE TABLE ws (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  me TEXT, myName TEXT,
  generation TEXT, keyId TEXT,
  limits TEXT, retention TEXT,
  cursor TEXT,
  passing INTEGER NOT NULL DEFAULT 1,
  fresh INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL DEFAULT 'ok' CHECK (state IN ('ok', 'quarantined', 'upgrade')),
  membersStale INTEGER NOT NULL DEFAULT 1,
  channelsStale INTEGER NOT NULL DEFAULT 1,
  blocksStale INTEGER NOT NULL DEFAULT 1,
  membersMore INTEGER NOT NULL DEFAULT 0,
  syncedAt INTEGER, activeAt INTEGER
) WITHOUT ROWID""",
            """CREATE TABLE room (
  ws TEXT NOT NULL REFERENCES ws(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT, visibility TEXT NOT NULL,
  archived INTEGER NOT NULL, closedReason TEXT,
  participants TEXT, startedBy TEXT,
  grantId TEXT NOT NULL, role TEXT,
  members INTEGER NOT NULL,
  head INTEGER NOT NULL, floor INTEGER NOT NULL, lastAt INTEGER,
  read INTEGER NOT NULL,
  readLocal INTEGER NOT NULL,
  readSent INTEGER NOT NULL,
  unread INTEGER NOT NULL, mentions INTEGER NOT NULL,
  lo INTEGER, hi INTEGER,
  notified INTEGER NOT NULL DEFAULT 0,
  muted INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (ws, id)
) WITHOUT ROWID""",
            """CREATE TABLE pass_room (
  ws TEXT NOT NULL REFERENCES ws(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  row TEXT NOT NULL,
  PRIMARY KEY (ws, id)
) WITHOUT ROWID""",
            """CREATE TABLE event (
  ws TEXT NOT NULL, room TEXT NOT NULL, seq INTEGER NOT NULL,
  id TEXT NOT NULL, kind TEXT NOT NULL, actor TEXT NOT NULL, at INTEGER NOT NULL,
  root TEXT,
  text TEXT,
  mentions TEXT,
  data TEXT,
  redacted INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (ws, room, seq),
  FOREIGN KEY (ws, room) REFERENCES room(ws, id) ON DELETE CASCADE
) WITHOUT ROWID""",
            "CREATE UNIQUE INDEX event_id ON event (ws, id)",
            "CREATE INDEX event_root ON event (ws, room, root, seq) WHERE root IS NOT NULL",
            """CREATE TABLE tombstone (
  ws TEXT NOT NULL REFERENCES ws(id) ON DELETE CASCADE,
  message TEXT NOT NULL, at INTEGER NOT NULL,
  PRIMARY KEY (ws, message)
) WITHOUT ROWID""",
            """CREATE TABLE member (
  ws TEXT NOT NULL REFERENCES ws(id) ON DELETE CASCADE, id TEXT NOT NULL,
  kind TEXT NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL, state TEXT NOT NULL, joinedAt INTEGER NOT NULL,
  PRIMARY KEY (ws, id)
) WITHOUT ROWID""",
            """CREATE TABLE channel (
  ws TEXT NOT NULL REFERENCES ws(id) ON DELETE CASCADE, id TEXT NOT NULL,
  name TEXT NOT NULL, visibility TEXT NOT NULL, archived INTEGER NOT NULL,
  joined INTEGER NOT NULL, role TEXT, members INTEGER NOT NULL,
  PRIMARY KEY (ws, id)
) WITHOUT ROWID""",
            """CREATE TABLE block (
  ws TEXT NOT NULL REFERENCES ws(id) ON DELETE CASCADE, member TEXT NOT NULL, at INTEGER NOT NULL,
  PRIMARY KEY (ws, member)
) WITHOUT ROWID""",
            """CREATE TABLE outbox (
  local TEXT PRIMARY KEY,
  ws TEXT NOT NULL, room TEXT NOT NULL,
  actor TEXT NOT NULL, grantId TEXT NOT NULL, generation TEXT NOT NULL,
  text TEXT NOT NULL, mentions TEXT NOT NULL, root TEXT,
  operationId TEXT UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('queued', 'sending', 'held', 'failed')),
  reason TEXT,
  attempts INTEGER NOT NULL DEFAULT 0, nextAt INTEGER NOT NULL DEFAULT 0, createdAt INTEGER NOT NULL,
  FOREIGN KEY (ws, room) REFERENCES room(ws, id) ON DELETE CASCADE
)""",
            "CREATE INDEX outbox_room ON outbox (ws, room, createdAt)",
            """CREATE TABLE draft (
  ws TEXT NOT NULL, room TEXT NOT NULL, root TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL, mentions TEXT NOT NULL, at INTEGER NOT NULL,
  PRIMARY KEY (ws, room, root),
  FOREIGN KEY (ws, room) REFERENCES room(ws, id) ON DELETE CASCADE
) WITHOUT ROWID""",
            """CREATE TABLE notice (
  ws TEXT NOT NULL, room TEXT NOT NULL, message TEXT NOT NULL, seq INTEGER NOT NULL,
  PRIMARY KEY (ws, room, message),
  FOREIGN KEY (ws, room) REFERENCES room(ws, id) ON DELETE CASCADE
) WITHOUT ROWID""",
        )
    }
}
