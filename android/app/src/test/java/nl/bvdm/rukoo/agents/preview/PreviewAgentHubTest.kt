package nl.bvdm.rukoo.agents.preview

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import nl.bvdm.rukoo.agents.AgentException
import nl.bvdm.rukoo.agents.SendRequest
import nl.bvdm.rukoo.agents.model.AgentIds
import nl.bvdm.rukoo.agents.model.ApprovalKind
import nl.bvdm.rukoo.agents.model.ApprovalStatus
import nl.bvdm.rukoo.agents.model.AssistantStatus
import nl.bvdm.rukoo.agents.model.ConversationStatus
import nl.bvdm.rukoo.agents.model.Item
import nl.bvdm.rukoo.agents.model.TaskStatus
import nl.bvdm.rukoo.agents.model.ThinkingStatus
import nl.bvdm.rukoo.agents.model.ToolStatus
import nl.bvdm.rukoo.agents.model.Unread
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class PreviewAgentHubTest {
    private fun TestScope.hub() = PreviewAgentHub(backgroundScope) { 1761130000000 }

    @Test
    fun samplesCoverEveryItemTypeAndState() = runTest {
        val h = hub()
        val items = h.conversations.value.flatMap { requireNotNull(h.get(it.id)).items }
        val types = items.map { it::class }.toSet()
        assertEquals(9, types.size)
        assertTrue(items.any { it is Item.Assistant && it.status == AssistantStatus.STREAMING })
        assertTrue(items.any { it is Item.Assistant && it.interim })
        assertTrue(items.any { it is Item.Thinking && it.status == ThinkingStatus.DONE && it.endedAt == it.startedAt + 4000 })
        assertEquals(setOf(ToolStatus.RUNNING, ToolStatus.DONE, ToolStatus.ERROR), items.filterIsInstance<Item.Tool>().map { it.status }.toSet())
        val approvals = items.filterIsInstance<Item.Approval>()
        assertTrue(approvals.any { it.status == ApprovalStatus.PENDING && it.kind == ApprovalKind.RUNTIME && it.fields.isNotEmpty() })
        assertTrue(approvals.any { it.status == ApprovalStatus.PENDING && it.kind == ApprovalKind.MAIL })
        assertTrue(approvals.any { it.status == ApprovalStatus.APPROVED })
        assertTrue(items.any { it is Item.Notice && it.undo != null })
        assertEquals(TaskStatus.entries.toSet(), items.filterIsInstance<Item.Plan>().flatMap { p -> p.tasks.map { it.status } }.toSet())
        val rows = h.conversations.value
        assertTrue(rows.any { it.waiting })
        assertTrue(rows.any { it.unread == Unread.ERROR })
        assertTrue(rows.any { it.status == ConversationStatus.RUNNING })
    }

    @Test
    fun sendStreamsAnAnswerAndMarksUnreadOffScreen() = runTest {
        val h = hub()
        val c = h.create(AgentIds.CLARK, null)
        h.send(c.id, SendRequest("Hello"))
        try {
            h.send(c.id, SendRequest("Again"))
            fail("a second message while the turn runs must be refused")
        } catch (e: AgentException) {
            assertEquals("busy", e.code)
        }
        // The canned answer runs in the hub's (background) scope; advanceUntilIdle doesn't wait for that.
        advanceTimeBy(10_000)
        runCurrent()
        val done = h.get(c.id)!!
        assertEquals(ConversationStatus.IDLE, done.status)
        assertEquals(Unread.REPLY, done.unread)
        assertTrue(done.items.last() is Item.Assistant)
        h.watch(c.id)
        assertEquals(Unread.NONE, h.get(c.id)!!.unread)
    }

    @Test
    fun decideAnswersAPendingCardOnce() = runTest {
        val h = hub()
        val chat = h.conversations.value.first { it.waiting }
        val card = h.get(chat.id)!!.items.filterIsInstance<Item.Approval>().first { it.status == ApprovalStatus.PENDING }
        val decided = h.decide(chat.id, card.id, card.choices.first().id)
        assertEquals(ApprovalStatus.APPROVED, decided.status)
        assertEquals(decided, h.decide(chat.id, card.id, "deny"))
    }
}
