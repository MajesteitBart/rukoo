package nl.bvdm.rukoo.ui.agent

import nl.bvdm.rukoo.agents.model.ApprovalKind
import nl.bvdm.rukoo.agents.model.ApprovalStatus
import nl.bvdm.rukoo.agents.model.Item
import nl.bvdm.rukoo.agents.model.ToolStatus
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class TranscriptModelTest {
    private fun tool(id: String, name: String, status: ToolStatus = ToolStatus.DONE, detail: String = "", at: Long = 10, endedAt: Long? = null) =
        Item.Tool(id, at, name, name, detail, status, at, endedAt, rukoo = name == "search_mail" || name == "write_draft")

    private fun user(id: String, at: Long = 1) = Item.User(id, at, "Hi")

    private fun answer(id: String) = Item.Assistant(id, 20, "Done.")

    private fun approval(id: String, status: ApprovalStatus = ApprovalStatus.PENDING, at: Long = 30, kind: ApprovalKind = ApprovalKind.RUNTIME) =
        Item.Approval(id, at, "Run a command", status = status, kind = kind)

    @Test
    fun consecutiveToolsShareOneRowAndRepeatsFold() {
        val rows = TranscriptModel.rows(
            listOf(
                user("u"),
                tool("t1", "search_mail", detail = "from:sanne"),
                tool("t2", "search_mail", detail = "from:joris"),
                tool("t3", "Bash", detail = "ls"),
                answer("a"),
                tool("t4", "Read"),
            ),
            running = false,
        )
        assertEquals(listOf("u", "tools:t1", "a", "tools:t4"), rows.map { it.key })
        val chips = (rows[1] as TranscriptRow.Tools).chips
        assertEquals(2, chips.size)
        assertEquals(2, chips[0].count)
        assertEquals("from:sanne\nfrom:joris", chips[0].detail)
        assertEquals("t1", chips[0].key)
        assertTrue(chips[0].rukoo)
        assertEquals(ToolLabel.Generic("command", false), chips[1].label)
    }

    @Test
    fun differentStatusesDontFold() {
        val rows = TranscriptModel.rows(listOf(tool("t1", "Read"), tool("t2", "Read", ToolStatus.ERROR), tool("t3", "Read", ToolStatus.RUNNING)), running = true)
        val chips = (rows.single() as TranscriptRow.Tools).chips
        assertEquals(listOf(ToolStatus.DONE, ToolStatus.ERROR, ToolStatus.RUNNING), chips.map { it.status })
    }

    @Test
    fun aSuccessfulCardToolLeavesNoChipAndNoEmptyRow() {
        val rows = TranscriptModel.rows(listOf(user("u"), tool("t1", "write_draft"), answer("a")), running = false)
        assertEquals(listOf("u", "a"), rows.map { it.key })
        val running = TranscriptModel.rows(listOf(tool("t1", "write_draft", ToolStatus.RUNNING)), running = true)
        assertEquals(1, (running.single() as TranscriptRow.Tools).chips.size)
    }

    @Test
    fun aToolWaitingOnTheApprovalUnderItHidesUntilAllowed() {
        val waiting = listOf(user("u"), tool("t1", "Bash", ToolStatus.RUNNING, at = 10), approval("p", at = 30))
        assertEquals(listOf("u", "p"), TranscriptModel.rows(waiting, running = true).map { it.key })
        assertEquals(mapOf("t1" to "p"), TranscriptModel.waitingTools(waiting))

        val allowed = listOf(user("u"), tool("t1", "Bash", ToolStatus.RUNNING), approval("p", ApprovalStatus.APPROVED))
        assertEquals(listOf("u", "tools:t1", "p"), TranscriptModel.rows(allowed, running = true).map { it.key })

        // A tool that ended after the card came is the one that asked.
        val endedLater = listOf(tool("t1", "Bash", ToolStatus.DONE, at = 10, endedAt = 40), approval("p", ApprovalStatus.DENIED, at = 30))
        assertEquals(listOf("p"), TranscriptModel.rows(endedLater, running = false).map { it.key })

        // A tool that ended before the card, or a proposal card, is not.
        val before = listOf(tool("t1", "Bash", ToolStatus.DONE, at = 10, endedAt = 20), approval("p", at = 30))
        assertEquals(listOf("tools:t1", "p"), TranscriptModel.rows(before, running = false).map { it.key })
        val proposal = listOf(tool("t1", "Bash", ToolStatus.RUNNING), approval("p", kind = ApprovalKind.PROPOSAL))
        assertEquals(listOf("tools:t1", "p"), TranscriptModel.rows(proposal, running = true).map { it.key })
    }

    @Test
    fun theWorkingLabelShowsOnlyBetweenTheMessageAndTheFirstOutput() {
        val afterUser = TranscriptModel.rows(listOf(user("u", at = 5)), running = true)
        assertEquals(TranscriptRow.Working(5), afterUser.last())
        assertTrue(TranscriptModel.rows(listOf(user("u"), tool("t", "Read", ToolStatus.RUNNING)), running = true).none { it is TranscriptRow.Working })
        assertTrue(TranscriptModel.rows(listOf(user("u")), running = false).none { it is TranscriptRow.Working })
        assertEquals(listOf("working"), TranscriptModel.rows(emptyList(), running = true).map { it.key })
    }
}
