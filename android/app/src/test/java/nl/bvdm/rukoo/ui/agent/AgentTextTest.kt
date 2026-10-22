package nl.bvdm.rukoo.ui.agent

import nl.bvdm.rukoo.R
import nl.bvdm.rukoo.agents.model.AgentDescriptor
import nl.bvdm.rukoo.agents.model.AgentKind
import nl.bvdm.rukoo.agents.model.AgentState
import nl.bvdm.rukoo.agents.model.ApprovalChoice
import nl.bvdm.rukoo.agents.model.ApprovalField
import nl.bvdm.rukoo.agents.model.ApprovalKind
import nl.bvdm.rukoo.agents.model.ApprovalTool
import nl.bvdm.rukoo.agents.model.ChoiceKind
import nl.bvdm.rukoo.agents.model.Item
import nl.bvdm.rukoo.agents.model.MailApproval
import nl.bvdm.rukoo.agents.model.ModelOption
import nl.bvdm.rukoo.agents.model.ModelOptions
import nl.bvdm.rukoo.agents.model.NoticeMail
import nl.bvdm.rukoo.agents.model.NoticeParams
import nl.bvdm.rukoo.agents.model.QuickAction
import nl.bvdm.rukoo.agents.model.Tone
import nl.bvdm.rukoo.agents.model.ToolKind
import nl.bvdm.rukoo.core.Change
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AgentTextTest {
    private fun notice(text: String = "English text", tone: Tone = Tone.INFO, code: String? = null, mail: NoticeMail? = null, title: String? = null) =
        Item.Notice("i_1", 1, text, tone = tone, code = code, mail = mail, params = title?.let { NoticeParams(it) })

    @Test
    fun errorsAreSaidByCode() {
        assertEquals(Txt.Res(R.string.agentui_errors_offline, listOf("Clark")), AgentText.error("offline", "Clark"))
        assertEquals(Txt.Res(R.string.agentui_errors_unknown), AgentText.error("invalid", "Clark"))
        assertEquals(Txt.Res(R.string.agentui_errors_unknown), AgentText.error(null, "Clark"))
        assertEquals(Txt.Res(R.string.agentui_errors_stopped), AgentText.error("stopped", "Clark"))
    }

    @Test
    fun noticesUseTheirCodeOrMailCounts() {
        assertEquals(
            Txt.Res(R.string.agentui_notices_kept_approval, listOf("Post in #sales", "Clark")),
            AgentText.notice(notice(code = "kept-approval", title = "Post in <unsafe_content>#sales</unsafe_content>"), "Clark"),
        )
        assertEquals(Txt.Res(R.string.agentui_notices_new_session, listOf("Clark")), AgentText.notice(notice(code = "new-session"), "Clark"))
        assertEquals(Txt.Res(R.string.agentui_errors_timeout, listOf("Codex")), AgentText.notice(notice(tone = Tone.ERROR, code = "timeout"), "Codex"))
        // An error notice with a code Rukoo doesn't know still reads as an error.
        assertEquals(Txt.Res(R.string.agentui_errors_unknown), AgentText.notice(notice(tone = Tone.ERROR, code = "weird"), "Codex"))
        assertEquals(Txt.Plural(R.plurals.agentui_mail_archive, 2, listOf(2, "")), AgentText.notice(notice(mail = NoticeMail("archive", count = 2)), "Clark"))
        assertEquals(
            Txt.Plural(R.plurals.agentui_mail_move, 1, listOf(1, "Receipts")),
            AgentText.notice(notice(mail = NoticeMail("move", count = 1, folder = "Receipts")), "Clark"),
        )
        // A move without a folder, a failure or an unknown action keeps the hub's sentence.
        assertEquals(Txt.Raw("English text"), AgentText.notice(notice(mail = NoticeMail("move", count = 1)), "Clark"))
        assertEquals(Txt.Raw("English text"), AgentText.notice(notice(mail = NoticeMail("archive", count = 3, failed = 1)), "Clark"))
        assertEquals(
            Txt.Res(R.string.agentui_mail_unsubscribe_email_one, listOf("leave@example.com")),
            AgentText.notice(notice(mail = NoticeMail("unsubscribe_email", count = 1, mailed = 1, to = "leave@example.com")), "Clark"),
        )
        assertEquals(
            Txt.Res(R.string.agentui_mail_unsubscribe_page_many, listOf(3)),
            AgentText.notice(notice(mail = NoticeMail("unsubscribe_page", count = 3, opened = 3)), "Clark"),
        )
    }

    @Test
    fun runtimeApprovalsAreTitledByToolKind() {
        val item = Item.Approval(
            "i_1", 1, "Run a command", detail = "gcalcli agenda",
            fields = listOf(ApprovalField("Command", "gcalcli agenda", key = "command"), ApprovalField("output_mode", "json")),
            tool = ApprovalTool("Bash", ToolKind.COMMAND),
            choices = listOf(ApprovalChoice("allow", "Allow once", ChoiceKind.PRIMARY), ApprovalChoice("always", "Always allow"), ApprovalChoice("deny", "Deny", ChoiceKind.DANGER)),
            kind = ApprovalKind.RUNTIME,
        )
        val shown = AgentText.approval(item, "Claude Code")
        assertEquals(Txt.Res(R.string.agentui_approval_command, listOf("Claude Code")), shown.title)
        // The detail only repeated the command.
        assertEquals("", shown.detail)
        assertEquals(Txt.Res(R.string.agentui_approval_field_command), shown.fields[0].label)
        assertEquals(Txt.Raw("Output mode"), shown.fields[1].label)
        // Runtime choices are translated by id.
        assertEquals(listOf(Txt.Res(R.string.agentui_choices_allow), Txt.Res(R.string.agentui_choices_always), Txt.Res(R.string.agentui_choices_deny)), shown.choices.map { it.label })
    }

    @Test
    fun mcpAndNamedToolsSayWhichTool() {
        val mcp = Item.Approval("i_1", 1, "Use a tool", tool = ApprovalTool("mcp__strap__search", ToolKind.MCP, server = "strap", tool = "search"))
        assertEquals(Txt.Res(R.string.agentui_approval_tool, listOf("Clark", "strap · search")), AgentText.approval(mcp, "Clark").title)
        val named = Item.Approval("i_1", 1, "Use a tool", tool = ApprovalTool("mcp__todoist__add_task", ToolKind.OTHER))
        assertEquals(Txt.Res(R.string.agentui_approval_tool, listOf("Clark", "todoist: add task")), AgentText.approval(named, "Clark").title)
    }

    @Test
    fun proposalsShowTheAgentsWordsWithoutTags() {
        val item = Item.Approval(
            "i_1", 1, "Post <unsafe_content source=\"email\">Hi</unsafe_content> in #sales", detail = "A short update",
            fields = listOf(ApprovalField("Message", "Quote: <unsafe_content>Hi</unsafe_content>")),
            choices = listOf(ApprovalChoice("approve", "Add tasks", ChoiceKind.PRIMARY), ApprovalChoice("decline", "Decline")),
            kind = ApprovalKind.PROPOSAL,
        )
        val shown = AgentText.approval(item, "Clark")
        assertEquals(Txt.Raw("Post Hi in #sales"), shown.title)
        assertEquals("A short update", shown.detail)
        assertEquals(Txt.Raw("Quote: Hi"), shown.fields.single().value)
        // A label the agent wrote stays; a standard English label is translated.
        assertEquals(listOf(Txt.Raw("Add tasks"), Txt.Res(R.string.agentui_choices_decline)), shown.choices.map { it.label })
    }

    @Test
    fun aRuntimeApprovalShowsItsInputExactly() {
        val item = Item.Approval("i_1", 1, "Run", fields = listOf(ApprovalField("Command", "echo <unsafe_content>x</unsafe_content>", key = "command")), kind = ApprovalKind.RUNTIME)
        assertEquals(Txt.Raw("echo <unsafe_content>x</unsafe_content>"), AgentText.approval(item, "Clark").fields.single().value)
    }

    @Test
    fun toolLabelsAndActions() {
        assertEquals(Txt.Res(R.string.agentui_tools_running_search_mail), AgentText.tool(ToolLabel.Rukoo("search_mail", true)))
        assertEquals(Txt.Res(R.string.agentui_tools_generic_web_search), AgentText.tool(ToolLabel.Generic("webSearch", false)))
        assertEquals(Txt.Raw("strap: search"), AgentText.tool(ToolLabel.Literal("strap: search")))
        assertEquals(Txt.Res(R.string.agentui_tools_running_unknown), AgentText.tool(ToolLabel.Unknown(true)))

        val reply = QuickAction.BUILT_IN.first { it.key == "reply" }
        // The hub's words (strings_agents.xml), not a second list.
        assertEquals(Txt.Res(R.string.agents_action_reply_label), AgentText.actionLabel(reply))
        assertEquals(Txt.Res(R.string.agents_action_reply_description), AgentText.actionDescription(reply))
        // A renamed Rukoo action keeps Rukoo's name under the user's.
        val renamed = reply.copy(label = "Answer Sanne")
        assertEquals(Txt.Raw("Answer Sanne"), AgentText.actionLabel(renamed))
        assertEquals(Txt.Res(R.string.agents_action_reply_label), AgentText.actionDescription(renamed))
        val own = QuickAction("follow-up", "pen", "Follow up", label = "Follow up", custom = true)
        assertEquals(Txt.Raw("Follow up"), AgentText.actionDescription(own))
    }

    @Test
    fun theComputerAndPhoneNoticesAreSaidByCode() {
        assertEquals(Txt.Res(R.string.agentui_notices_no_phone_tools, listOf("Claude Code")), AgentText.notice(notice(code = "no-phone-tools"), "Claude Code"))
        assertEquals(Txt.Res(R.string.agentui_notices_new_thread, listOf("Codex")), AgentText.notice(notice(code = "new-thread"), "Codex"))
        assertEquals(Txt.Res(R.string.agentui_notices_start_over_missed), AgentText.notice(notice(code = "start-over-missed"), "Codex"))
        assertEquals(
            Txt.Res(R.string.agentui_notices_approval_too_long, listOf("Run a long script")),
            AgentText.notice(notice(code = "approval-too-long", title = "Run a long script"), "Claude Code"),
        )
    }

    @Test
    fun aOneClickUnsubscribeIsSaidFromTheHubsSentence() {
        assertEquals(
            Txt.Res(R.string.agentui_mail_unsubscribed_one, listOf("Bol.com")),
            AgentText.notice(notice(text = "Unsubscribed from Bol.com", mail = NoticeMail("unsubscribe", count = 1)), "Clark"),
        )
        assertEquals(
            Txt.Plural(R.plurals.agentui_mail_unsubscribed_senders, 3, listOf(3)),
            AgentText.notice(notice(text = "Unsubscribed from 3 senders", mail = NoticeMail("unsubscribe", count = 4)), "Clark"),
        )
        // With a failure the hub's whole sentence stays, as desktop does.
        val failed = notice(text = "Unsubscribed from Bol.com. 1 failed: gone", mail = NoticeMail("unsubscribe", count = 1, failed = 1))
        assertEquals(Txt.Raw("Unsubscribed from Bol.com. 1 failed: gone"), AgentText.notice(failed, "Clark"))
    }

    // What the mail_action tool writes (mcp/tools/MailActions.kt): an English title, sender and subject rows, Rukoo's choices.
    private fun mailCard(action: String, ids: Int, title: String, folder: String? = null, fields: List<ApprovalField> = emptyList()) = Item.Approval(
        "i_1", 1, title,
        fields = fields,
        choices = listOf(ApprovalChoice("approve", "Archive", ChoiceKind.PRIMARY), ApprovalChoice("decline", "Cancel")),
        source = "rukoo",
        kind = ApprovalKind.MAIL,
        mail = MailApproval(action, List(ids) { "acc:INBOX:${it + 1}" }, folder),
    )

    @Test
    fun mailCardsAreSaidFromWhatTheyDo() {
        val rows = listOf(ApprovalField("Sanne de Vries", "Offerte"), ApprovalField("Bol.com", "(no subject)"), ApprovalField("", "and 3 more"))
        val archive = AgentText.approval(mailCard("archive", 5, "Archive 5 emails", fields = rows), "Clark")
        assertEquals(Txt.Plural(R.plurals.agentui_mail_title_archive, 5, listOf(5)), archive.title)
        assertEquals(listOf(Txt.Res(R.string.agentui_mail_verb_archive), Txt.Res(R.string.agentui_choices_cancel)), archive.choices.map { it.label })
        // The sender and subject are the email's; Rukoo's own words in the rows are translated.
        assertEquals(listOf(Txt.Raw("Sanne de Vries"), Txt.Raw("Bol.com"), Txt.Raw("")), archive.fields.map { it.label })
        assertEquals(listOf(Txt.Raw("Offerte"), Txt.Res(R.string.agentui_no_subject), Txt.Plural(R.plurals.agentui_mail_more, 3, listOf(3))), archive.fields.map { it.value })

        val move = AgentText.approval(mailCard("move", 1, "Move 1 email to Receipts", folder = "Receipts"), "Clark")
        assertEquals(Txt.Plural(R.plurals.agentui_mail_title_move, 1, listOf(1, "Receipts")), move.title)
        assertEquals(Txt.Res(R.string.agentui_mail_verb_move), move.choices.first().label)

        val one = AgentText.approval(mailCard("unsubscribe", 2, "Unsubscribe from Bol.com"), "Clark")
        assertEquals(Txt.Res(R.string.agentui_mail_title_unsubscribe_one, listOf("Bol.com")), one.title)
        assertEquals(Txt.Res(R.string.agentui_mail_verb_unsubscribe), one.choices.first().label)
        val many = AgentText.approval(mailCard("unsubscribe", 3, "Unsubscribe from 2 senders"), "Clark")
        assertEquals(Txt.Plural(R.plurals.agentui_mail_title_unsubscribe_senders, 2, listOf(2)), many.title)

        assertEquals(Txt.Plural(R.plurals.agentui_mail_title_trash, 2, listOf(2)), AgentText.approval(mailCard("trash", 2, "Delete 2 emails"), "Clark").title)
        assertEquals(Txt.Plural(R.plurals.agentui_mail_title_mark_unread, 1, listOf(1)), AgentText.approval(mailCard("mark_unread", 1, "Mark 1 email as unread"), "Clark").title)
    }

    @Test
    fun aMailCardRukooCantWordKeepsTheHubsText() {
        val odd = AgentText.approval(mailCard("snooze", 1, "Snooze 1 email"), "Clark")
        assertEquals(Txt.Raw("Snooze 1 email"), odd.title)
    }

    @Test
    fun computerAgentsSayWhereTheyRunInTheInterfaceLanguage() {
        val claude = AgentDescriptor("computer:ph_1:claude", AgentKind.CLAUDE, "Claude Code", subtitle = "on desktop-zolder")
        assertEquals(Txt.Res(R.string.agentui_panel_on_computer, listOf("desktop-zolder")), AgentText.place(claude, mapOf("ph_1" to "desktop-zolder")))
        // A pairing the settings don't have (yet) falls back to the hub's words.
        assertEquals(Txt.Raw("on desktop-zolder"), AgentText.place(claude, emptyMap()))
        assertNull(AgentText.place(AgentDescriptor("clark", AgentKind.HERMES, "Clark"), mapOf("ph_1" to "desktop-zolder")))
    }

    @Test
    fun statesThatNeedSettings() {
        assertTrue(AgentText.blocked(AgentState.UNCONFIGURED))
        assertTrue(AgentText.blocked(AgentState.UNAUTHORIZED))
        assertFalse(AgentText.blocked(AgentState.OFFLINE))
        assertFalse(AgentText.blocked(AgentState.CHECKING))
        assertNull(AgentText.setup(AgentState.READY, "Clark"))
        assertEquals(Txt.Res(R.string.agentui_setup_missing, listOf("Codex")), AgentText.setup(AgentState.MISSING, "Codex"))
        assertEquals(Txt.Res(R.string.agentui_status_starting), AgentText.status(AgentState.CHECKING))
        assertEquals(Txt.Raw("turbo"), AgentText.effort("turbo"))
        assertEquals(Txt.Res(R.string.agentui_effort_xhigh), AgentText.effort("xhigh"))
    }

    @Test
    fun modelMenus() {
        val list = ModelOptions(
            "clark",
            models = listOf(
                ModelOption("openrouter::gpt-5.5", "GPT-5.5", efforts = listOf("low", "high"), defaultEffort = "low"),
                ModelOption("opus", "Opus", efforts = emptyList(), isDefault = true),
            ),
            efforts = listOf("medium"),
            custom = listOf("minimal"),
            defaultModel = "openrouter::gpt-5.5",
        )
        assertEquals(listOf("medium"), ModelMenus.effortsOf(list, null))
        assertEquals(listOf("low", "high"), ModelMenus.effortsOf(list, "openrouter::gpt-5.5"))
        assertEquals(listOf("minimal"), ModelMenus.effortsOf(list, "typed-by-hand"))
        assertEquals(emptyList<String>(), ModelMenus.effortsOf(null, null))
        assertEquals("GPT-5.5", ModelMenus.modelName(list, "openrouter::gpt-5.5"))
        assertEquals("claude-x", ModelMenus.modelName(list, "anthropic::claude-x"))
        assertEquals("openrouter::gpt-5.5", ModelMenus.shownModel(list, null))
        assertEquals("opus", ModelMenus.shownModel(list.copy(defaultModel = ""), null))
        assertEquals("low", ModelMenus.defaultEffort(list, null))
        assertNull(ModelMenus.defaultEffort(list, "opus"))

        // A pick keeps the other key; an effort the new model doesn't offer goes back to the default.
        val gpt = "openrouter::gpt-5.5"
        assertEquals(gpt to "high", ModelMenus.nextChoice(gpt to "low", null, Change("high"), list))
        assertEquals("opus" to null, ModelMenus.nextChoice(gpt to "high", Change("opus"), null, list))
        assertEquals(null to "medium", ModelMenus.nextChoice(gpt to "medium", Change(null), null, list))
        assertEquals(gpt to null, ModelMenus.nextChoice(gpt to "high", null, Change(null), list))
        // Without a list to go by, the effort stays.
        assertEquals("opus" to "high", ModelMenus.nextChoice(gpt to "high", Change("opus"), null, null))
    }
}
