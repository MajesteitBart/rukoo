package nl.bvdm.rukoo.workspaces

import androidx.sqlite.driver.bundled.BundledSQLiteDriver
import java.io.File
import java.nio.file.Files
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers

/**
 * Chat caches for JVM tests: real SQLite through BundledSQLiteDriver, each in a folder of its own that [close]
 * deletes. The dispatcher defaults to [Dispatchers.Unconfined], so a test under runTest needs no IO thread.
 */
class TestDb(private val io: CoroutineDispatcher = Dispatchers.Unconfined) : AutoCloseable {
    val dir: File = Files.createTempDirectory("rukoo-chat-db-").toFile()
    val file: File = ChatDb.fileIn(dir)
    val driver = BundledSQLiteDriver()
    private val opened = mutableListOf<ChatDb>()

    suspend fun open(): ChatDb = ChatDb.open(file, driver, io).also { opened += it }

    suspend fun store(now: () -> Long = { NOW }): WorkspaceStore = WorkspaceStore(open(), now)


    override fun close() {
        // A ChatDb closes on wipe(); closing it again does nothing. The files go with the folder.
        opened.clear()
        dir.deleteRecursively()
    }

    companion object {
        const val NOW = 1_763_550_000_000L
    }
}
