package nl.bvdm.rukoo.ui.agent

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import nl.bvdm.rukoo.agents.AgentException
import nl.bvdm.rukoo.agents.HubEvent
import nl.bvdm.rukoo.agents.HubKit
import nl.bvdm.rukoo.agents.SendRequest
import nl.bvdm.rukoo.agents.model.ContinuedRef
import nl.bvdm.rukoo.agents.model.Conversation
import nl.bvdm.rukoo.agents.model.DraftMode
import nl.bvdm.rukoo.agents.model.Item
import nl.bvdm.rukoo.agents.model.MessageRef
import nl.bvdm.rukoo.mail.model.MessageIds
import nl.bvdm.rukoo.ui.ComposerController
import nl.bvdm.rukoo.ui.ComposerState
import nl.bvdm.rukoo.ui.Screen
import nl.bvdm.rukoo.ui.settings.NotificationPermission
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/** The chat UI against the real hub and composer: draft cards, added emails, the approval toast. */
@OptIn(ExperimentalCoroutinesApi::class)
class ChatSeamsTest {
    private val sanne = MessageIds.encode("demo", "INBOX", 12)
    private val other = MessageIds.encode("demo", "INBOX", 13)

    private suspend fun TestScope.kit(): HubKit {
        val k = HubKit(this)
        runCurrent()
        k.hub.ready()
        return k
    }

    // ---------- draft cards ----------

    @Test
    fun undoInTheComposerMarksEveryCardOfThatComposerInTheRealHub() = runTest {
        val k = kit()
        val composer = ComposerController()
        val chat = k.hub.create("clark", MessageRef(sanne))
        val elsewhere = k.hub.create("clark", null)
        // The user's own text, then two writes by the agent (desktop keys: "<composer id>:<write>").
        val id = composer.open(ComposerState(subject = "Re: Offerte", body = "Mine", dirty = true))
        composer.update { it.copy(body = "Agent 1", draftedBy = "Clark", draftedIn = chat.id) }
        val first = k.hub.addItem(chat.id, Item.Draft("", 0, DraftMode.REPLY, composerKey = "$id:1")) as Item.Draft
        composer.update { it.copy(body = "Agent 2", draftedBy = "Clark", draftedIn = chat.id) }
        val second = k.hub.addItem(chat.id, Item.Draft("", 0, DraftMode.REPLY, composerKey = "$id:2")) as Item.Draft
        // A bare composer id names the same composer; another composer's card is left alone.
        val bare = k.hub.addItem(elsewhere.id, Item.Draft("", 0, DraftMode.NEW, composerKey = id)) as Item.Draft
        val stranger = k.hub.addItem(chat.id, Item.Draft("", 0, DraftMode.NEW, composerKey = "someone-else:1")) as Item.Draft
        runCurrent()

        assertTrue(DraftCards.canUndo(first, composer.current()))
        assertTrue(DraftCards.canUndo(bare, composer.current()))
        assertFalse(DraftCards.canUndo(stranger, composer.current()))

        assertTrue(composer.undoAgentDraft())
        DraftCards.markUndone(k.hub, id)
        runCurrent()

        // The composer has the user's text back; the cards of both writes and the bare one say Undone.
        assertEquals("Mine", composer.current()!!.body)
        fun undone(c: Conversation, item: Item) = (k.hub.get(c.id)!!.items.first { it.id == item.id } as Item.Draft).undone
        assertTrue(undone(chat, first))
        assertTrue(undone(chat, second))
        assertTrue(undone(elsewhere, bare))
        assertFalse(undone(chat, stranger))
        // Nothing of the agent's is left to take back.
        assertFalse(DraftCards.canUndo(first, composer.current()))
    }

    @Test
    fun anUndoAfterTheUsersEditsMarksEveryWriteItTookBack() = runTest {
        val k = kit()
        val composer = ComposerController()
        val chat = k.hub.create("clark", MessageRef(sanne))
        // The agent opens the composer and writes twice; then the user changes its text (the composer's edit rule).
        val id = composer.open(ComposerState(subject = "Re: Offerte", body = "Agent 1", draftedBy = "Clark", draftedIn = chat.id, dirty = true))
        val first = k.hub.addItem(chat.id, Item.Draft("", 0, DraftMode.REPLY, composerKey = id)) as Item.Draft
        composer.update { it.copy(body = "Agent 2", draftedBy = "Clark") }
        val second = k.hub.addItem(chat.id, Item.Draft("", 0, DraftMode.REPLY, composerKey = id)) as Item.Draft
        composer.update { it.copy(body = "Agent 2, and mine", dirty = true, draftedBy = null, editedAgent = "Clark") }
        runCurrent()
        assertTrue(DraftCards.canUndo(second, composer.current()))

        assertTrue(composer.undoAgentDraft())
        val after = composer.current()!!
        // What the card's Undo waits for before it marks the cards.
        assertTrue(after.id == id && after.draftedBy == null && after.editedAgent == null)
        DraftCards.markUndone(k.hub, id)
        runCurrent()
        val drafts = k.hub.get(chat.id)!!.items.filterIsInstance<Item.Draft>().associateBy { it.id }
        assertTrue(drafts.getValue(first.id).undone)
        assertTrue(drafts.getValue(second.id).undone)
        assertEquals("", after.body)
    }

    @Test
    fun anUndoThatBringsBackAnotherComposerStillMarksTheAgentsCards() = runTest {
        val k = kit()
        val composer = ComposerController()
        val chat = k.hub.create("clark", MessageRef(sanne))
        // An untouched composer is open; the agent's reply goes into a new one that replaces it.
        val mine = composer.open(ComposerState(subject = "Notes"))
        val agents = composer.open(ComposerState(subject = "Re: Offerte", body = "Agent", draftedBy = "Clark", draftedIn = chat.id, dirty = true))
        val card = k.hub.addItem(chat.id, Item.Draft("", 0, DraftMode.REPLY, composerKey = agents)) as Item.Draft
        composer.update { it.copy(body = "Agent, and mine", draftedBy = null, editedAgent = "Clark") }
        runCurrent()

        // The card's Undo: the composer goes back to the user's own, under its own id; the card is marked by the
        // id of the composer the agent wrote into, which the chat took before the Undo.
        assertTrue(DraftCards.canUndo(card, composer.current()))
        assertTrue(composer.undoAgentDraft())
        assertEquals(mine, composer.current()!!.id)
        DraftCards.markUndone(k.hub, agents)
        runCurrent()
        assertTrue((k.hub.get(chat.id)!!.items.first { it.id == card.id } as Item.Draft).undone)
        assertFalse(DraftCards.canUndo(card, composer.current()))
    }

    @Test
    fun undoNeedsTheCardsComposerWithAnAgentsText() {
        val card = Item.Draft("i_1", 1, composerKey = "c-1:3")
        assertEquals("c-1", DraftCards.composerOf(card.composerKey))
        assertNull(DraftCards.composerOf(null))
        assertFalse(DraftCards.canUndo(card, null))
        assertFalse(DraftCards.canUndo(card, ComposerState(id = "c-2", draftedBy = "Clark")))
        // The user's own text in that composer: nothing to undo.
        assertFalse(DraftCards.canUndo(card, ComposerState(id = "c-1")))
        assertTrue(DraftCards.canUndo(card, ComposerState(id = "c-1", draftedBy = "Clark")))
        // Edited after the agent wrote: Undo is still offered (the composer then asks first).
        assertTrue(DraftCards.canUndo(card, ComposerState(id = "c-1", editedAgent = "Clark")))
        assertFalse(DraftCards.canUndo(card.copy(undone = true), ComposerState(id = "c-1", draftedBy = "Clark")))
    }

    // ---------- added emails ----------

    private fun pending(id: String, messageId: String? = null) = PendingEmail(id, messageId, "Subject $id")

    @Test
    fun addedEmailsSkipTheChatsOwnDoublesAndPastTheLimit() {
        val own = MessageRef("a", messageId = "<own@example.com>")
        val conversation = Conversation(id = "c_1", agent = "clark", message = own, continued = listOf(ContinuedRef("n", messageId = "<newer@example.com>")))
        val inChat: (PendingEmail) -> Boolean = { ChatAttachments.inChat(it, conversation, null, null, detached = false) }
        // The chat's own email under another id (same Message-ID in another folder), the email it continued from,
        // and one the message has already.
        val result = ChatAttachments.add(
            listOf(pending("x")),
            listOf(pending("b", "<OWN@example.com>"), pending("n2", "newer@example.com"), pending("x"), pending("c"), pending("d")),
            max = 3,
            inChat = inChat,
        )
        assertEquals(listOf("x", "c", "d"), result.emails.map { it.id })
        assertEquals(2, result.added)
        assertEquals(3, result.had)
        assertFalse(result.full)
        val over = ChatAttachments.add(result.emails, listOf(pending("e")), max = 3, inChat = inChat)
        assertTrue(over.full)
        assertEquals(0, over.added)
    }

    @Test
    fun aNewChatsEmailIsInTheChatWhileItsRefStillLoads() {
        // "Add to chat" opens a new chat about the first email; the second goes along.
        assertTrue(ChatAttachments.inChat(pending("a"), null, emailId = "a", ref = null, detached = false))
        assertFalse(ChatAttachments.inChat(pending("b"), null, emailId = "a", ref = null, detached = false))
        assertTrue(ChatAttachments.inChat(pending("a2", "<a@x>"), null, emailId = "a", ref = MessageRef("a", messageId = "<a@x>"), detached = false))
        // Left out of the chat: it can go along as an added email.
        assertFalse(ChatAttachments.inChat(pending("a"), null, emailId = "a", ref = null, detached = true))
    }

    @Test
    fun theRealHubNamesTheEmailThatIsGoneAndTakesEmailsAlone() = runTest {
        val k = kit()
        val chat = k.hub.create("clark", MessageRef(sanne))
        val gone = MessageIds.encode("demo", "INBOX", 9999)
        try {
            k.hub.send(chat.id, SendRequest(text = "Compare these", emails = listOf(other, gone)))
            fail("expected email-missing")
        } catch (e: AgentException) {
            assertEquals(setOf(gone), ChatAttachments.missing(e))
        }
        // Not sent: the emails come back without the gone one, before any added meanwhile.
        val sent = listOf(pending(other), pending(gone))
        assertEquals(listOf(other, "later"), ChatAttachments.restore(sent, listOf(pending("later"), pending(other)), setOf(gone)).map { it.id })
        assertNull(ChatAttachments.missing(AgentException("busy")))

        // Added emails alone are a message; the hub keeps them on the user's item.
        k.hub.send(chat.id, SendRequest(emails = listOf(other)))
        runCurrent()
        val user = k.hub.get(chat.id)!!.items.filterIsInstance<Item.User>().last()
        assertEquals(listOf(other), user.emails.orEmpty().map { it.id })
    }

    // ---------- the approval toast ----------

    @Test
    fun theApprovalToastIsForTheForegroundAndAnotherChat() {
        val waiting = HubEvent.ApprovalWaiting("c_1", "i_1")
        assertTrue(approvalToast(Screen(foreground = true, chatConversationId = null), waiting))
        assertTrue(approvalToast(Screen(foreground = true, chatConversationId = "c_2"), waiting))
        // The chat on screen shows the card itself; in the background the notification says it.
        assertFalse(approvalToast(Screen(foreground = true, chatConversationId = "c_1"), waiting))
        assertFalse(approvalToast(Screen(foreground = false, chatConversationId = null), waiting))
    }

    @Test
    fun notificationPermissionIsAskedOnAndroid13WhenWanted() {
        assertTrue(NotificationPermission.shouldAsk(sdk = 34, granted = false, wanted = true))
        assertFalse(NotificationPermission.shouldAsk(sdk = 34, granted = true, wanted = true))
        assertFalse(NotificationPermission.shouldAsk(sdk = 34, granted = false, wanted = false))
        assertFalse(NotificationPermission.shouldAsk(sdk = 32, granted = false, wanted = true))
    }
}
