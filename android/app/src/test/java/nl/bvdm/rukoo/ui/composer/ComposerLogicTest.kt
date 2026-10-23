package nl.bvdm.rukoo.ui.composer

import java.io.File
import java.nio.file.Files
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.runTest
import nl.bvdm.rukoo.mail.model.Address
import nl.bvdm.rukoo.ui.ComposerController
import nl.bvdm.rukoo.ui.ComposerState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class ComposerLogicTest {
    private val sanne = Address("Sanne de Vries", "sanne@studio.nl")
    private val joris = Address("Joris Bakker", "joris@studio.nl")

    @Test
    fun recipientsFromTyping() {
        assertEquals(listOf(Address("Last, First", "a@b.nl"), Address("", "c@d.nl")), Recipients.parse("\"Last, First\" <a@b.nl>; c@d.nl"))
        assertEquals(listOf(Address("", "a@b.nl")) to "jo", Recipients.split("a@b.nl, jo"))
        // A comma inside a quoted name or angle brackets doesn't end the recipient.
        assertEquals(emptyList<Address>() to "\"Last, First\" <a@b.nl>", Recipients.split("\"Last, First\" <a@b.nl>"))
        assertEquals(listOf(Address("Last, First", "a@b.nl")) to "", Recipients.split("\"Last, First\" <a@b.nl>,"))
        assertEquals(emptyList<Address>() to "Odd <a,b@c.nl>", Recipients.split("Odd <a,b@c.nl>"))
        assertEquals(listOf(Address("", "a@b.nl")) to "", Recipients.split("a@b.nl "))
        assertEquals(emptyList<Address>() to "Sanne ", Recipients.split("Sanne "))
        assertTrue(Recipients.isValid("sanne@studio.nl"))
        assertFalse(Recipients.isValid("sanne@studio"))
        assertFalse(Recipients.isValid("san ne@studio.nl"))
        val merged = Recipients.merge(listOf(sanne), listOf(Address("", "SANNE@studio.nl"), joris))
        assertEquals(listOf(sanne, joris), merged)
        val contacts = listOf(sanne, joris, Address("Eva", "eva@x.nl"))
        assertEquals(listOf(joris), Recipients.suggest(contacts, "jor", emptyList()))
        assertEquals(listOf(joris), Recipients.suggest(contacts, "studio", listOf(sanne)))
        assertTrue(Recipients.suggest(contacts, " ", emptyList()).isEmpty())
    }

    @Test
    fun undoingAnAgentsDraftBringsBackWhatWasThere() {
        val composer = ComposerController()
        val mine = composer.open(ComposerState(subject = "Re: Call", body = "my words", dirty = true))
        composer.update { it.copy(body = "agent words", draftedBy = "Clark") }
        assertTrue(composer.undoAgentDraft())
        assertEquals("my words", composer.current()!!.body)
        assertEquals(mine, composer.current()!!.id)
        assertNull(composer.current()!!.draftedBy)
        // The agent opened the composer itself: undo keeps the fields and drops its text.
        composer.close()
        composer.open(ComposerState(to = listOf(sanne), subject = "Re: Call", body = "agent", draftedBy = "Clark"))
        composer.update { it.copy(body = "agent, again") }
        assertTrue(composer.undoAgentDraft())
        assertEquals("", composer.current()!!.body)
        assertEquals(listOf(sanne), composer.current()!!.to)
        assertFalse(composer.undoAgentDraft())
    }

    @Test
    fun anAgentRewritingItsDraftKeepsTheFirstSnapshot() {
        val composer = ComposerController()
        composer.open(ComposerState(body = "mine"))
        composer.update { it.copy(body = "v1", draftedBy = "Clark") }
        composer.update { it.copy(body = "v2", draftedBy = "Clark") }
        assertTrue(composer.undoAgentDraft())
        assertEquals("mine", composer.current()!!.body)
    }

    @Test
    fun draftsKeepTheNewestOnTopAndSurviveARestart() = runTest {
        val dir = Files.createTempDirectory("drafts").toFile()
        val file = File(dir, DraftStore.FILE_NAME)
        var clock = 1000L
        val io = StandardTestDispatcher(testScheduler)
        val store = DraftStore(file, io, now = { clock })
        assertTrue(store.save(ComposerState(id = "a", subject = "A", dirty = true)))
        clock = 2000L
        assertTrue(store.save(ComposerState(id = "b", subject = "B")))
        assertTrue(store.save(ComposerState(id = "a", subject = "A2")))
        assertEquals(listOf("a", "b"), store.drafts.value.map { it.id })
        assertEquals("A2", store.get("a")!!.subject)
        assertFalse(store.get("a")!!.dirty)
        assertEquals(2000L, store.get("a")!!.savedAt)
        assertTrue(store.remove("a"))
        assertEquals(listOf("b"), store.drafts.value.map { it.id })
        // On disk once save returned: a new store (the next process) reads it back.
        assertEquals(listOf("b"), DraftStore(file).drafts.value.map { it.id })
        dir.deleteRecursively()
    }

    @Test
    fun aDraftThatCantBeWrittenIsNotReportedKept() = runTest {
        // A directory where the file should be: the write fails.
        val dir = Files.createTempDirectory("drafts").toFile()
        val blocked = File(dir, DraftStore.FILE_NAME).apply { mkdirs() }
        File(blocked, "x").writeText("keeps the directory non-empty")
        val store = DraftStore(blocked, StandardTestDispatcher(testScheduler))
        assertFalse(store.save(ComposerState(id = "a", body = "words")))
        assertTrue(store.drafts.value.isEmpty())
        dir.deleteRecursively()
    }
}
