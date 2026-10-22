package nl.bvdm.rukoo.ui.agent

import nl.bvdm.rukoo.agents.model.OwnSkill
import nl.bvdm.rukoo.agents.model.QuickAction
import nl.bvdm.rukoo.agents.model.RukooSkill
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ChatInputLogicTest {
    @Test
    fun aTokenSitsAtTheStartOfAWordJustBeforeTheCaret() {
        assertEquals(InputToken('/', "re", 0, 3), ChatInputLogic.token("/re", 3))
        assertEquals(InputToken('$', "todo", 6, 11), ChatInputLogic.token("Add a \$Todo", 11))
        assertEquals(InputToken('/', "", 4, 5), ChatInputLogic.token("Hey /", 5))
        assertNull(ChatInputLogic.token("and/or", 6))
        assertNull(ChatInputLogic.token("/reply now", 10))
        // A $ followed by a digit is an amount.
        assertNull(ChatInputLogic.token("costs \$40", 9))
        // The caret decides, not the end of the text.
        assertEquals(InputToken('/', "su", 0, 3), ChatInputLogic.token("/su and more", 3))
    }

    private val custom = QuickAction("follow-up", "pen", "Follow up", label = "Follow up", custom = true)
    private val always = QuickAction("standup", "clock", "Standup", label = "Standup", custom = true, always = true, needsEmail = false)
    private val hidden = QuickAction.BUILT_IN.first { it.key == "summary" }.copy(hidden = true)
    private val actions = QuickAction.BUILT_IN.filterNot { it.key == "summary" } + hidden + custom + always
    private val skills = listOf(RukooSkill("unsubscribe-via-browser", "Unsubscribe on the page", "rukoo", ""), RukooSkill("reply", "Shadowed", "user", ""))

    @Test
    fun slashCommandsFollowTheEmail() {
        val withEmail = ChatInputLogic.commands(actions, skills, emailOpen = true, unsubscribe = false).map { it.name }
        // Hidden ones are still commands; unsubscribe needs the header; the inbox overview is always there.
        assertEquals(listOf("reply", "brief", "tasks", "team", "update", "triage", "summary", "follow-up", "standup", "unsubscribe-via-browser"), withEmail)
        val newsletter = ChatInputLogic.commands(actions, skills, emailOpen = true, unsubscribe = true).map { it.name }
        assertEquals(true, "unsubscribe" in newsletter)
        val noEmail = ChatInputLogic.commands(actions, skills, emailOpen = false, unsubscribe = false).map { it.name }
        assertEquals(listOf("triage", "standup", "unsubscribe-via-browser"), noEmail)
    }

    @Test
    fun aWholeCommandRunsLikePickingIt() {
        val commands = ChatInputLogic.commands(actions, skills, emailOpen = true, unsubscribe = false)
        assertEquals("summary", ChatInputLogic.wholeCommand("  /Summary ", commands)?.name)
        assertNull(ChatInputLogic.wholeCommand("/summary please", commands))
        assertNull(ChatInputLogic.wholeCommand("/nothing", commands))
        assertEquals(listOf("tasks", "team", "triage"), ChatInputLogic.matching(commands, "t").map { it.name })
    }

    @Test
    fun skillMatchesRankNamesBeforeDescriptions() {
        val own = listOf(OwnSkill("obsidian", "Notes in the vault"), OwnSkill("todoist", "Tasks"), OwnSkill("crm-update", "Update deals"), OwnSkill("notes-to-todo", "x"))
        assertEquals(listOf("todoist", "notes-to-todo"), ChatInputLogic.skillMatches(own, "to").map { it.name })
        assertEquals(listOf("crm-update"), ChatInputLogic.skillMatches(own, "upd").map { it.name })
        assertEquals(listOf("notes-to-todo", "obsidian"), ChatInputLogic.skillMatches(own, "notes").map { it.name })
        assertEquals(own, ChatInputLogic.skillMatches(own, ""))
    }

    @Test
    fun sentTextNamesSkillsAsChips() {
        val own = listOf(OwnSkill("todoist"), OwnSkill("crm:update"))
        val parts = ChatInputLogic.skillParts("Use \$todoist, then \$crm:update. Not \$other or a\$todoist", own)
        assertEquals(
            listOf(
                SkillPart.Text("Use "),
                SkillPart.Skill(own[0]),
                SkillPart.Text(", then "),
                SkillPart.Skill(own[1]),
                SkillPart.Text(". Not \$other or a\$todoist"),
            ),
            parts,
        )
        // While typing, a name at the very end is still being written.
        assertEquals(listOf(SkillPart.Text("Ask \$todoist")), ChatInputLogic.skillParts("Ask \$todoist", own, typing = true))
        assertEquals(listOf(4..11), ChatInputLogic.skillRanges("Ask \$todoist now", own))
        assertEquals(listOf(SkillPart.Text("plain")), ChatInputLogic.skillParts("plain", own))
    }

    @Test
    fun skillLabelsAreTheWordsCapitalized() {
        assertEquals("Crm Update", ChatInputLogic.skillLabel("crm:update"))
        assertEquals("Notes To Todo", ChatInputLogic.skillLabel("notes-to_todo"))
    }
}
