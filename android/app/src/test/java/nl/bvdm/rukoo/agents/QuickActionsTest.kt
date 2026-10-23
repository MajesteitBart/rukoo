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
    fun editsInSettingsStoreWhatDesktopStores() {
        // Rukoo's own, unchanged or changed back, store as null.
        assertNull(QuickActions.store(defaults))
        assertNull(QuickActions.store(QuickActions.move(QuickActions.move(defaults, "brief", -1), "brief", 1)))
        val summary = defaults.first { it.key == "summary" }
        assertNull(QuickActions.store(QuickActions.change(defaults, "summary") { QuickActions.rewrite(it, "Summarize", summary.prompt, "Summarize") }))

        // Moved, hidden, renamed and an own shortcut: desktop's storedShortcuts shape, and the same list back.
        var list = QuickActions.move(defaults, "summary", -1)
        list = QuickActions.change(list, "brief") { it.copy(hidden = true) }
        list = QuickActions.change(list, "reply") { QuickActions.rewrite(it, "Answer", "Answer briefly.", "Draft a reply") }
        list = list + QuickActions.custom("standup", "Standup note", "Write my standup.", "pen", always = true)
        val stored = QuickActions.store(list)!!
        assertEquals(
            RukooJson.parseToJsonElement(
                """[
                  {"key":"reply","label":"Answer","prompt":"Answer briefly."},
                  {"key":"brief","hidden":true},
                  {"key":"tasks"},{"key":"team"},{"key":"update"},
                  {"key":"summary"},{"key":"unsubscribe"},{"key":"triage"},
                  {"key":"standup","custom":true,"label":"Standup note","prompt":"Write my standup.","icon":"pen","when":"always"}
                ]""",
            ),
            stored,
        )
        assertEquals(list, QuickActions.list(stored))
        assertTrue(QuickActions.edited(list.first { it.key == "reply" }))
        assertTrue(!QuickActions.edited(list.first { it.key == "brief" }))
        assertTrue(!QuickActions.edited(list.first { it.key == "standup" }))

        // Restore default gives Rukoo's name and instructions back, and the order stays the user's.
        val restored = QuickActions.change(list, "reply", QuickActions::restore)
        assertEquals(defaults.first { it.key == "reply" }, restored.first { it.key == "reply" })
        assertEquals(keys(list), keys(restored))
    }

    @Test
    fun aFullListFromTheComputerStillReadsBackAfterAnEdit() {
        // 40 of the user's own and none of Rukoo's: the list shows 48, but an edit must not store 48.
        val own = (1..40).joinToString(",") { """{"key":"s$it","custom":true,"label":"S$it","prompt":"p$it"}""" }
        val imported = QuickActions.list(RukooJson.parseToJsonElement("[$own]"))
        assertEquals(48, imported.size)
        val edited = QuickActions.change(QuickActions.move(imported, "s5", -1), "s7") { it.copy(hidden = true) }
        val stored = QuickActions.store(edited)!!
        assertTrue(QuickActions.fits(stored))
        assertEquals(edited, QuickActions.list(stored))

        // When Rukoo's can't be left out without moving them, the list doesn't fit and isn't to be saved.
        val moved = QuickActions.list(RukooJson.parseToJsonElement("[$own]")).let { list -> list.drop(8) + list.take(8).reversed() }
        assertTrue(!QuickActions.fits(QuickActions.store(moved)))
    }

    @Test
    fun changesInSettingsBuildOnWhatIsStored() = kotlinx.coroutines.runBlocking {
        val dir = java.nio.file.Files.createTempDirectory("shortcuts").toFile()
        try {
            val store = AgentSettingsStore(java.io.File(dir, AgentSettingsStore.FILE_NAME), PlainCipher)
            // Two changes made from the same screen: the second keeps the first.
            assertTrue(store.changeShortcuts { QuickActions.change(it, "brief") { a -> a.copy(hidden = true) } })
            assertTrue(store.changeShortcuts { QuickActions.change(it, "tasks") { a -> a.copy(hidden = true) } })
            assertEquals(listOf("brief", "tasks"), QuickActions.list(store.current().shortcuts).filter { it.hidden }.map { it.key })
            // One that can't be kept saves nothing.
            val before = store.current().shortcuts
            val tooMany = { list: List<QuickAction> -> list + (1..40).map { QuickActions.custom("x$it", "X", "p", "pen", always = false) } }
            assertTrue(!store.changeShortcuts(tooMany))
            assertEquals(before, store.current().shortcuts)
            assertEquals(before, AgentSettingsStore(java.io.File(dir, AgentSettingsStore.FILE_NAME), PlainCipher).current().shortcuts)
        } finally {
            dir.deleteRecursively()
        }
    }

    @Test
    fun movingStopsAtEitherEnd() {
        assertEquals(defaults, QuickActions.move(defaults, "reply", -1))
        assertEquals(defaults, QuickActions.move(defaults, "triage", 1))
        assertEquals(defaults, QuickActions.move(defaults, "nope", 1))
        assertEquals(listOf("brief", "reply"), keys(QuickActions.move(defaults, "reply", 1)).take(2))
    }

    @Test
    fun aNewCommandFollowsTheRulesAndIsntTaken() {
        val list = defaults + QuickActions.custom("standup", "Standup", "p", "pen", always = false)
        assertEquals("follow-up", QuickActions.commandOf("  /Follow-up "))
        assertNull(QuickActions.commandProblem("follow-up", list, null))
        for (bad in listOf("", "-a", "a--b", "a b", "a_b", "x".repeat(41))) {
            assertEquals(bad, QuickActions.CommandProblem.BAD, QuickActions.commandProblem(bad, list, null))
        }
        // Rukoo's commands and message actions, and another shortcut's command, are taken.
        for (taken in listOf("reply", "triage", "approved", "skill", "standup")) {
            assertEquals(taken, QuickActions.CommandProblem.TAKEN, QuickActions.commandProblem(taken, list, null))
        }
        // A shortcut keeps its own command when it is edited.
        assertNull(QuickActions.commandProblem("standup", list, "standup"))
        // An unknown icon becomes the sparkle, as a stored one does.
        assertEquals("sparkle", QuickActions.custom("x", "X", "p", "bogus", always = false).icon)
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
