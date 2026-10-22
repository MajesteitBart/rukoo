package nl.bvdm.rukoo.agents

import kotlinx.coroutines.runBlocking
import nl.bvdm.rukoo.agents.model.MailApproval
import nl.bvdm.rukoo.core.Clock
import nl.bvdm.rukoo.mail.MailEngine
import nl.bvdm.rukoo.mail.demo.PreviewMailEngine
import nl.bvdm.rukoo.mail.model.Folder
import nl.bvdm.rukoo.mail.model.FolderRole
import nl.bvdm.rukoo.mail.model.MessageIds
import nl.bvdm.rukoo.mail.model.MessagePin
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.fail
import org.junit.Test

class MailActionsTest {
    private fun folder(path: String, role: FolderRole = FolderRole.NONE, name: String = path.substringAfterLast('/')) = Folder("a", path, name, role)

    private val inbox = folder("INBOX", FolderRole.INBOX)
    private val all = folder("[Gmail]/All Mail", FolderRole.ALL)
    private val archief = folder("Archief", FolderRole.ARCHIVE)
    private val starred = folder("[Gmail]/Starred", FolderRole.FLAGGED)

    // Desktop's publicAccount: All Mail is the archive only for an account without an Archive folder of its own.
    @Test
    fun archiveMeansTheArchiveFolderAndAllMailOnlyWithoutOne() {
        for (folders in listOf(listOf(inbox, all, archief), listOf(inbox, archief, all))) {
            assertEquals("Archief", AgentFolders.resolve(folders, "Archief", "archive"))
            assertEquals(listOf("INBOX", "Archief"), AgentFolders.visible(folders, "Archief").map { it.path })
        }
        val gmail = listOf(inbox, all, starred)
        assertEquals("[Gmail]/All Mail", AgentFolders.resolve(gmail, "[Gmail]/All Mail", "archive"))
        assertEquals(listOf("INBOX", "[Gmail]/All Mail"), AgentFolders.visible(gmail, "[Gmail]/All Mail").map { it.path })
        // Starred is a view, never a destination.
        assertNull(AgentFolders.resolve(gmail, "[Gmail]/All Mail", "Starred"))
    }

    @Test
    fun aNameTwoFoldersShareIsAmbiguous() {
        val folders = listOf(inbox, folder("Projects/2026"), folder("Archive/2026"))
        assertEquals("Projects/2026", AgentFolders.resolve(folders, null, "Projects/2026"))
        try {
            AgentFolders.resolve(folders, null, "2026")
            fail("ambiguous")
        } catch (e: AmbiguousFolder) {
            assertEquals(listOf("Projects/2026", "Archive/2026"), e.paths)
        }
    }

    // An approval names the email it was shown for. When the cache can't pin that email any more, it isn't acted on.
    @Test
    fun anEmailThatCantBePinnedAnyMoreIsNotTouched() = runBlocking {
        val demo = PreviewMailEngine(Clock.System)
        val id = MessageIds.encode("demo", "INBOX", 3)
        val unpinned = object : MailEngine by demo {
            override suspend fun pinOf(id: String): MessagePin? = null
        }
        val pinned = MailApproval("star", listOf(id), pins = listOf(MessagePin(uidValidity = "1")))
        val r = MailActions(unpinned).execute(pinned)
        assertEquals("The email is no longer there (it may have moved).", r.failed.single().second)
        // A card made without a pin (an engine that gives none) is no check.
        assertEquals(listOf(id), MailActions(unpinned).execute(pinned.copy(pins = listOf(MessagePin()))).done)
    }
}
