package nl.bvdm.rukoo.agents

import nl.bvdm.rukoo.agents.model.QuickAction
import nl.bvdm.rukoo.agents.model.RukooSkill
import nl.bvdm.rukoo.core.RukooJson
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Desktop actions.js: which quick actions apply, and how the user's shortcuts change the list. */
class QuickActionsTest {
    private val defaults = QuickActions.list(null)
    private fun keys(list: List<QuickAction>) = list.map { it.key }

    @Test
    fun rukoosActionsComeInDesktopOrderWithTheirPrompts() {
        assertEquals(listOf("reply", "brief", "tasks", "team", "update", "unsubscribe", "summary", "triage"), keys(defaults))
        assertTrue(defaults.all { it.label == null && !it.custom })
        assertEquals(
            "Summarize this email and its thread in at most three bullets, then tell me whether it needs a reply from me and by when.",
            defaults.first { it.key == "summary" }.prompt,
        )
        assertEquals("summary", defaults.first { it.key == "summary" }.action)
    }

    @Test
    fun availabilityFollowsTheOpenEmail() {
        // No email: only the inbox overview.
        assertEquals(listOf("triage"), keys(QuickActions.chips(defaults, emailOpen = false, unsubscribe = false)))
        // An email without List-Unsubscribe: every email action except unsubscribe, and no triage chip.
        assertEquals(listOf("reply", "brief", "tasks", "team", "update", "summary"), keys(QuickActions.chips(defaults, emailOpen = true, unsubscribe = false)))
        assertEquals(listOf("reply", "brief", "tasks", "team", "update", "unsubscribe", "summary"), keys(QuickActions.chips(defaults, emailOpen = true, unsubscribe = true)))
        // The slash command for triage is there with an email too.
        assertEquals(listOf("reply", "brief", "tasks", "team", "update", "summary", "triage"), keys(QuickActions.commands(defaults, emailOpen = true, unsubscribe = false)))
        assertEquals(listOf("triage"), keys(QuickActions.commands(defaults, emailOpen = false, unsubscribe = false)))
    }

    @Test
    fun theUsersShortcutsReorderHideEditAndAdd() {
        val stored = RukooJson.parseToJsonElement(
            """[
              {"key":"summary","label":"TL;DR","prompt":"Three bullets."},
              {"key":"brief","hidden":true},
              {"key":"standup","custom":true,"label":"Standup note","prompt":"Write my standup.","icon":"pen","when":"always"},
              {"key":"weekly","custom":true,"label":"Weekly","prompt":"Plan the week.","icon":"bogus"}
            ]""",
        )
        val list = QuickActions.list(stored)
        // Rukoo's own the list doesn't name go after the one before them in Rukoo's order.
        assertEquals(listOf("reply", "summary", "triage", "brief", "tasks", "team", "update", "unsubscribe", "standup", "weekly"), keys(list))
        val summary = list.first { it.key == "summary" }
        assertEquals("TL;DR", summary.label)
        assertEquals("Three bullets.", summary.prompt)
        assertEquals("summary", summary.action)
        val standup = list.first { it.key == "standup" }
        assertEquals("shortcut", standup.action)
        assertTrue(standup.custom && standup.always && !standup.needsEmail)
        assertEquals("pen", standup.icon)
        assertEquals("sparkle", list.first { it.key == "weekly" }.icon)
        // Hidden: no chip, still a command. An always-shortcut works without an email.
        val chips = keys(QuickActions.chips(list, emailOpen = false, unsubscribe = false))
        assertEquals(listOf("triage", "standup"), chips)
        assertTrue("brief" in keys(QuickActions.commands(list, emailOpen = true, unsubscribe = false)))
        assertTrue("brief" !in keys(QuickActions.chips(list, emailOpen = true, unsubscribe = false)))
        assertEquals(listOf("triage", "standup"), keys(QuickActions.commands(list, emailOpen = false, unsubscribe = false)))
    }

    @Test
    fun aListThatBreaksTheRulesGivesWayToTheDefaults() {
        for (bad in listOf(
            """[{"key":"Approved"}]""",
            """[{"key":"approved"}]""",
            """[{"key":"a"},{"key":"a"}]""",
            """[{"key":"x","custom":true,"label":"","prompt":"p"}]""",
            """[{"key":"reply","hidden":"yes"}]""",
            """[{"key":"reply","label":"${"l".repeat(61)}"}]""",
            """{"key":"reply"}""",
        )) {
            assertNull(bad, QuickActions.entries(RukooJson.parseToJsonElement(bad)))
            assertEquals(bad, keys(defaults), keys(QuickActions.list(RukooJson.parseToJsonElement(bad))))
        }
    }

    @Test
    fun skillsBecomeCommandsUnlessAShortcutHasTheName() {
        val skills = listOf(RukooSkill("summary", "d", "user", ""), RukooSkill("data-deletion-request", "d", "rukoo", ""))
        assertEquals(listOf("data-deletion-request"), QuickActions.skillCommands(skills, defaults).map { it.name })
    }

    @Test
    fun onlyAWholeSlashNameRunsACommand() {
        assertEquals("reply", QuickActions.slashName("/Reply"))
        assertEquals("data-deletion-request", QuickActions.slashName("/data-deletion-request"))
        assertNull(QuickActions.slashName("/reply some words"))
        assertNull(QuickActions.slashName("reply"))
    }
}
