package nl.bvdm.rukoo.mail

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import nl.bvdm.rukoo.mail.engine.AccountCache
import nl.bvdm.rukoo.mail.engine.CacheOps
import nl.bvdm.rukoo.mail.engine.CachedBox
import nl.bvdm.rukoo.mail.engine.PendingPatch
import nl.bvdm.rukoo.mail.model.CachedMessage
import nl.bvdm.rukoo.mail.model.FolderRole
import nl.bvdm.rukoo.mail.session.CopyUid
import nl.bvdm.rukoo.mail.session.FolderRecord
import nl.bvdm.rukoo.mail.session.FolderSync
import nl.bvdm.rukoo.mail.session.ImapSession
import nl.bvdm.rukoo.mail.session.PriorityLock
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class EngineLogicTest {
    @Test
    fun `pending changes survive a sync that read the server just before`() {
        val messages = listOf(CachedMessage(1, unread = true), CachedMessage(2, unread = true), CachedMessage(3))
        val pending = mapOf(
            CacheOps.pendingKey("a", "INBOX", 1) to PendingPatch(unread = false),
            CacheOps.pendingKey("a", "INBOX", 2) to PendingPatch(removed = true),
            CacheOps.pendingKey("a", "Other", 3) to PendingPatch(starred = true),
        )
        val out = CacheOps.applyPending("a", "INBOX", messages, pending)
        assertEquals(listOf(1L, 3L), out.map { it.uid })
        assertEquals(false, out[0].unread)
        assertEquals(false, out[1].starred)
    }

    @Test
    fun `new mail is unread inbox mail above the highest known uid, never on the first sync`() {
        val prev = CachedBox("7", 2, 0, listOf(CachedMessage(5), CachedMessage(8)))
        val res = FolderSync("7", 4, listOf(CachedMessage(5), CachedMessage(8), CachedMessage(9, unread = true), CachedMessage(10, unread = false)))
        assertEquals(listOf(9L), CacheOps.freshMail(prev, res, isInbox = true) { false }.map { it.uid })
        assertEquals(emptyList<Long>(), CacheOps.freshMail(null, res, isInbox = true) { false }.map { it.uid })
        assertEquals(emptyList<Long>(), CacheOps.freshMail(prev, res, isInbox = false) { false }.map { it.uid })
        assertEquals(emptyList<Long>(), CacheOps.freshMail(prev, res, isInbox = true) { it.uid == 9L }.map { it.uid })
        // A rebuilt folder: nothing counts as new.
        assertEquals(emptyList<Long>(), CacheOps.freshMail(prev, res.copy(uidValidity = "8"), isInbox = true) { false }.map { it.uid })
    }

    @Test
    fun `the move log follows a copy through folders`() {
        var cache = AccountCache(folders = listOf(FolderRecord("INBOX", "INBOX", role = FolderRole.INBOX), FolderRecord("Archive", "Archive"), FolderRecord("Trash", "Trash")))
        cache = CacheOps.noteMove(cache, "<A@x>", "Archive", "INBOX")
        cache = CacheOps.noteMove(cache, "<a@X>", "Trash", "Archive")
        assertEquals(1, cache.moves.size)
        assertEquals("Trash", cache.moves[0].folder)
        assertEquals(listOf("INBOX", "Archive"), cache.moves[0].past)
        assertEquals("Trash", CacheOps.lastMove(cache, "a@x", null)?.folder)
        assertEquals("Trash", CacheOps.lastMove(cache, "<a@x>", "INBOX")?.folder)
        assertNull(CacheOps.lastMove(cache, "<a@x>", "Sent"))
        // A second copy of the same Message-ID (a mail to yourself) gets its own record.
        cache = CacheOps.noteMove(cache, "<a@x>", "Archive", "Sent")
        assertEquals(2, cache.moves.size)
        repeat(600) { cache = CacheOps.noteMove(cache, "<m$it@x>", "Archive", "INBOX") }
        assertEquals(500, cache.moves.size)
    }

    @Test
    fun `uid sets use ranges and COPYUID maps old to new uids`() {
        assertEquals("1:3,5,7:8", ImapSession.uidSet(listOf(8, 1, 2, 3, 5, 7)))
        val copy = CopyUid.parse("* OK [COPYUID 38505 304,319:320 3956:3958] Done")!!
        assertEquals("38505", copy.uidValidity)
        assertEquals(mapOf(304L to 3956L, 319L to 3957L, 320L to 3958L), copy.map)
        assertNull(CopyUid.parse("A3 OK MOVE completed"))
    }

    @Test
    fun `waiting user work goes before waiting background work`() = runBlocking {
        val lock = PriorityLock()
        val order = mutableListOf<String>()
        val release = CompletableDeferred<Unit>()
        val first = async { lock.withLock(background = true) { order += "running"; release.await() } }
        yield()
        val later = async { lock.withLock(background = true) { order += "later" } }
        yield()
        val now = async { lock.withLock(background = false) { order += "now" } }
        yield()
        delay(20)
        release.complete(Unit)
        first.await(); later.await(); now.await()
        assertEquals(listOf("running", "now", "later"), order)
    }

    @Test
    fun `provider presets follow the domain for Other`() {
        val (imap, smtp) = Providers.serverDefaults("other", "me@hotmail.com")
        assertEquals("outlook.office365.com", imap.host)
        assertEquals(587, smtp.port)
        assertEquals(false, smtp.secure)
        val (ownImap, ownSmtp) = Providers.serverDefaults("other", "me@bvdm.ai")
        assertEquals("imap.bvdm.ai", ownImap.host)
        assertEquals("smtp.bvdm.ai", ownSmtp.host)
        assertEquals(465, ownSmtp.port)
        assertEquals("imap.bvdm.ai", Providers.serverDefaults("exchange", "me@bvdm.ai").first.host)
        assertEquals(listOf("google", "yahoo", "outlook", "exchange", "office365", "other"), Providers.ALL.map { it.id })
        assertTrue(Providers.byId("exchange").manual)
        assertEquals("other", Providers.byId("nope").id)
    }

    @Test
    fun `attachment names are flattened to one safe file name`() {
        assertEquals("a_b_c.pdf", RukooMailEngine.safeName("a/b\\c.pdf"))
        assertEquals("evil_.pdf", RukooMailEngine.safeName("evil‮.pdf"))
        assertEquals("x", RukooMailEngine.safeName("..x.. "))
        assertEquals("attachment-3", RukooMailEngine.safeName("...", 2))
    }
}
