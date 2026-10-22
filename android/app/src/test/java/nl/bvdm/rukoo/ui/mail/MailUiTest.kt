package nl.bvdm.rukoo.ui.mail

import java.time.ZoneId
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import nl.bvdm.rukoo.R
import nl.bvdm.rukoo.mail.demo.PreviewMailEngine
import nl.bvdm.rukoo.mail.model.FolderRole
import nl.bvdm.rukoo.mail.model.MailView
import nl.bvdm.rukoo.mail.model.ViewKind
import nl.bvdm.rukoo.ui.MailtoFields
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class MailUiTest {
    // Strings as "id|args", so a test can tell which text was chosen.
    private object Fake : UiStrings {
        override fun get(id: Int, vararg args: Any) = (listOf(id) + args).joinToString("|")
        override fun plural(id: Int, count: Int, vararg args: Any) = (listOf(id) + args).joinToString("|")
    }

    private class Host : MailUiHost {
        val detached = mutableListOf<Collection<String>>()
        val reopened = mutableListOf<String>()
        var openWasGone = false

        override fun detach(ids: Collection<String>): Boolean {
            detached += ids
            return openWasGone
        }

        override fun reopen(id: String) {
            reopened += id
        }

        override fun openUrl(url: String) = Unit

        override fun composeMailto(fields: MailtoFields) = Unit

        override fun showFolder(accountId: String, path: String) = Unit
    }

    private fun setup(scope: kotlinx.coroutines.CoroutineScope): Triple<PreviewMailEngine, MailUi, Host> {
        val engine = PreviewMailEngine(zone = ZoneId.of("Europe/Amsterdam"))
        val host = Host()
        val ui = MailUi(engine, scope, host).also { it.strings = Fake }
        return Triple(engine, ui, host)
    }

    @Test
    fun archiveOffersUndoAndUndoRestores() = runTest(UnconfinedTestDispatcher()) {
        val (engine, ui, host) = setup(backgroundScope)
        val m = engine.listMessages(MailView.AllInboxes).first()
        host.openWasGone = true
        ui.archive(listOf(m))
        assertEquals(listOf(listOf(m.id)), host.detached)
        assertTrue(engine.listMessages(MailView.AllInboxes).none { it.id == m.id })
        val toast = ui.toasts.current!!
        assertEquals("${R.string.mailbox_move_one}|${R.string.mailbox_folders_archive}", toast.message)
        assertEquals("${R.string.common_actions_undo}", toast.actionLabel)
        toast.onAction!!.invoke()
        assertEquals(m.messageId, engine.listMessages(MailView.AllInboxes).first { it.subject == m.subject }.messageId)
        assertEquals("${R.string.mailbox_undo_restored}", ui.toasts.current!!.message)
        // It was open, so the restored copy opens again.
        assertEquals(1, host.reopened.size)
    }

    @Test
    fun deleteMovesToTrashAndFromTrashAsksFirst() = runTest(UnconfinedTestDispatcher()) {
        val (engine, ui, _) = setup(backgroundScope)
        val two = engine.listMessages(MailView.AllInboxes).take(2)
        ui.delete(two)
        assertEquals("${R.plurals.mailbox_delete_moved_count}|2", ui.toasts.current!!.message)
        val trash = engine.listMessages(MailView(ViewKind.TRASH))
        assertTrue(trash.size >= 2)
        val inTrash = trash.first()
        ui.delete(listOf(inTrash))
        val ask = ui.dialog!!
        assertEquals("${R.string.mailbox_delete_title}", ask.title)
        assertTrue(ask.danger)
        ask.answer(DialogChoice.CONFIRM)
        assertNull(ui.dialog)
        assertTrue(engine.listMessages(MailView(ViewKind.TRASH)).none { it.id == inTrash.id })
        assertEquals("${R.string.mailbox_delete_deleted_one}", ui.toasts.current!!.message)
    }

    @Test
    fun cancellingThePermanentDeleteKeepsTheMail() = runTest(UnconfinedTestDispatcher()) {
        val (engine, ui, host) = setup(backgroundScope)
        ui.delete(engine.listMessages(MailView.AllInboxes).take(1))
        val inTrash = engine.listMessages(MailView(ViewKind.TRASH)).first()
        host.detached.clear()
        ui.delete(listOf(inTrash))
        ui.dialog!!.answer(DialogChoice.CANCEL)
        assertTrue(host.detached.isEmpty())
        assertTrue(engine.listMessages(MailView(ViewKind.TRASH)).any { it.id == inTrash.id })
    }

    @Test
    fun movingWhereTheMailAlreadyIsSaysSo() = runTest(UnconfinedTestDispatcher()) {
        val (engine, ui, _) = setup(backgroundScope)
        val archived = engine.listMessages(MailView(ViewKind.ARCHIVE)).firstOrNull() ?: run {
            ui.archive(engine.listMessages(MailView.AllInboxes).take(1))
            engine.listMessages(MailView(ViewKind.ARCHIVE)).first()
        }
        ui.archive(listOf(archived))
        assertEquals("${R.string.mailbox_move_no_archive}", ui.toasts.current!!.message)
    }

    @Test
    fun theMoveSheetOffersTheAccountsFoldersButNotDraftsSentOrHere() = runTest(UnconfinedTestDispatcher()) {
        val (engine, ui, _) = setup(backgroundScope)
        val m = engine.listMessages(MailView.AllInboxes).first()
        val targets = ui.moveTargets(listOf(m))
        val paths = targets.map { it.path }
        assertTrue("Archive" in paths && "Trash" in paths && "Invoices" in paths && "Junk" in paths)
        assertTrue("INBOX" !in paths && "Sent" !in paths && "Drafts" !in paths)
        ui.pickFolder(listOf(m))
        ui.pick(targets.first { it.path == "Invoices" })
        assertNull(ui.moving)
        assertEquals("${R.string.mailbox_move_one}|Invoices", ui.toasts.current!!.message)
        assertEquals(FolderRole.NONE, engine.listMessages(MailView.folder("demo", "Invoices")).first { it.messageId == m.messageId }.role)
        // Picking Trash goes through delete.
        val next = engine.listMessages(MailView.AllInboxes).first()
        ui.move(listOf(next), targets.first { it.role == FolderRole.TRASH })
        assertEquals("${R.string.mailbox_delete_moved_one}", ui.toasts.current!!.message)
    }

    @Test
    fun markAllReadCounts() = runTest(UnconfinedTestDispatcher()) {
        val (engine, ui, _) = setup(backgroundScope)
        val unread = engine.listMessages(MailView.AllInboxes).count { it.unread }
        ui.markAllRead(MailView.AllInboxes)
        assertEquals("${R.plurals.mailbox_actions_read_count}|$unread", ui.toasts.current!!.message)
        ui.markAllRead(MailView.AllInboxes)
        assertEquals("${R.string.mailbox_actions_already_read}", ui.toasts.current!!.message)
    }

    @Test
    fun aNewFolderIsMadeAndShown() = runTest(UnconfinedTestDispatcher()) {
        val (engine, ui, _) = setup(backgroundScope)
        ui.newFolder("demo")
        ui.dialog!!.answer(DialogChoice.CONFIRM, "Receipts")
        assertTrue(engine.folders.value["demo"]!!.any { it.path == "Receipts" })
        assertEquals("${R.string.mailbox_folders_created}|Receipts", ui.toasts.current!!.message)
    }
}
