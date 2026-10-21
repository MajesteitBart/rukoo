package nl.bvdm.rukoo.mail.model

import nl.bvdm.rukoo.mail.model.FolderRoles.roleFor
import org.junit.Assert.assertEquals
import org.junit.Test

class FolderRolesTest {
    @Test
    fun inboxByPathInAnyCase() {
        assertEquals(FolderRole.INBOX, roleFor("INBOX", "INBOX", null))
        assertEquals(FolderRole.INBOX, roleFor("Inbox", null, null))
        // The path wins even over a contradicting attribute.
        assertEquals(FolderRole.INBOX, roleFor("inbox", "inbox", "\\Sent"))
    }

    @Test
    fun gmailList() {
        // A typical Gmail LIST: special-use attributes arrive as folder flags next to \HasNoChildren.
        val gmail = listOf(
            Triple("[Gmail]/All Mail", "All Mail", listOf("\\HasNoChildren", "\\All")) to FolderRole.ALL,
            Triple("[Gmail]/Drafts", "Drafts", listOf("\\HasNoChildren", "\\Drafts")) to FolderRole.DRAFTS,
            Triple("[Gmail]/Important", "Important", listOf("\\HasNoChildren", "\\Important")) to FolderRole.IMPORTANT,
            Triple("[Gmail]/Sent Mail", "Sent Mail", listOf("\\HasNoChildren", "\\Sent")) to FolderRole.SENT,
            Triple("[Gmail]/Spam", "Spam", listOf("\\HasNoChildren", "\\Junk")) to FolderRole.JUNK,
            Triple("[Gmail]/Starred", "Starred", listOf("\\HasNoChildren", "\\Flagged")) to FolderRole.FLAGGED,
            Triple("[Gmail]/Trash", "Trash", listOf("\\HasNoChildren", "\\Trash")) to FolderRole.TRASH,
            Triple("Receipts", "Receipts", listOf("\\HasNoChildren")) to FolderRole.NONE,
            Triple("Clients/Acme", "Acme", listOf("\\HasNoChildren")) to FolderRole.NONE,
        )
        for ((f, role) in gmail) assertEquals(f.first, role, roleFor(f.first, f.second, null, f.third))
        assertEquals(FolderRole.INBOX, roleFor("INBOX", "INBOX", null, listOf("\\HasNoChildren")))
    }

    @Test
    fun specialUseAttributeComesBeforeFlagsAndNames() {
        assertEquals(FolderRole.ALL, roleFor("Archive", "Archive", "\\All"))
        assertEquals(FolderRole.TRASH, roleFor("Sent", "Sent", null, listOf("\\Trash")))
        assertEquals(FolderRole.SENT, roleFor("Outbox", "Outbox", "\\sent"))
        // An unknown attribute falls through to the name.
        assertEquals(FolderRole.DRAFTS, roleFor("Concepten", "Concepten", "\\Whatever"))
    }

    @Test
    fun namesInEnglishAndDutch() {
        val names = mapOf(
            "Postvak IN" to FolderRole.INBOX,
            "Sent Items" to FolderRole.SENT,
            "sent messages" to FolderRole.SENT,
            "Verzonden items" to FolderRole.SENT,
            "Draft" to FolderRole.DRAFTS,
            "Deleted Messages" to FolderRole.TRASH,
            "Bin" to FolderRole.TRASH,
            "Prullenbak" to FolderRole.TRASH,
            "Verwijderde items" to FolderRole.TRASH,
            "Junk E-mail" to FolderRole.JUNK,
            "Bulk Mail" to FolderRole.JUNK,
            "Ongewenste e-mail" to FolderRole.JUNK,
            "Archives" to FolderRole.ARCHIVE,
            "Archief" to FolderRole.ARCHIVE,
            "Sent stuff" to FolderRole.NONE,
            "My Archive" to FolderRole.NONE,
        )
        for ((name, role) in names) assertEquals(name, role, roleFor("INBOX.$name", name, null))
    }

    @Test
    fun theLeafNameIsTheNameElseThePath() {
        assertEquals(FolderRole.SENT, roleFor("Sent", null, null))
        assertEquals(FolderRole.SENT, roleFor("Sent", "", null))
        assertEquals(FolderRole.TRASH, roleFor("  Trash  ", null, null))
        // Desktop matches the whole name or path, not a path's last segment.
        assertEquals(FolderRole.NONE, roleFor("Work/Sent", null, null))
    }
}
