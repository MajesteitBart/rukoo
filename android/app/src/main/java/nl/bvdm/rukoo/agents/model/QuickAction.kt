package nl.bvdm.rukoo.agents.model

/**
 * A quick action: a chip in the empty chat and a `/key` slash command (src/renderer/agent/actions.js).
 * [label] and [description] are null for Rukoo's own actions, which the UI translates by [key]; the
 * user's shortcuts carry their own. [prompt] is the instruction sent to the agent, English on purpose.
 */
data class QuickAction(
    val key: String,
    val icon: String,
    val prompt: String,
    val label: String? = null,
    val description: String? = null,
    /** Only offered while an email is open. */
    val needsEmail: Boolean = true,
    /** Only offered when the email has a List-Unsubscribe header. */
    val needsUnsubscribe: Boolean = false,
    /** The user's own shortcut (sent with action `shortcut`). */
    val custom: Boolean = false,
    /** Not a chip, but still a slash command. */
    val hidden: Boolean = false,
    /** A custom shortcut with `when: 'always'`. */
    val always: Boolean = false,
) {
    val slash: String get() = "/$key"

    /** The `action` value of the user item this sends. */
    val action: String get() = if (custom) "shortcut" else key

    /** Desktop's applies() (actions.js:136-151). [unsubscribe] says the open email has List-Unsubscribe. */
    fun applies(emailOpen: Boolean, unsubscribe: Boolean): Boolean = when {
        custom -> always || emailOpen
        !emailOpen -> !needsEmail
        needsUnsubscribe -> unsubscribe
        else -> needsEmail
    }

    companion object {
        /** Rukoo's actions in desktop order, prompts verbatim (spec 1 §2.8). */
        val BUILT_IN: List<QuickAction> = listOf(
            QuickAction(
                "reply", "mail",
                "Draft a reply to this email in my voice, in the language of the email. First gather what you need: earlier mail with this person (search_mail), your memory, my notes and any other system you can reach. Then put the reply in the composer with write_draft. Keep it short. Afterwards tell me in one or two sentences what you assumed or left open.",
            ),
            QuickAction(
                "brief", "search",
                "Before I reply: who is this, what is our history and what do I need to know or decide? Search my other mail, your memory, my notes and the other systems you can reach. Show the most useful sources with show_sources, then give me a short brief. Do not change anything.",
            ),
            QuickAction(
                "tasks", "list",
                "Extract the follow-up actions from this email, with owner and due date where you can tell. Show them with show_plan. Then propose adding them to my task system with propose_action. Do not create anything until I approve.",
            ),
            QuickAction(
                "team", "arrow-right",
                "Who on my team should know about this? Instead of forwarding the email, write a short message for the right channel (Slack, Mattermost, WhatsApp, Telegram or whatever you use for them) with the key points and the Message-ID so they can find it. Propose it with propose_action and only send it after I approve.",
            ),
            QuickAction(
                "update", "layers",
                "Record this email where it belongs: CRM contact or deal, my notes, Linear, Todoist or anything else you manage for me. Show the planned updates with show_plan and propose each one with propose_action. After I approve, do it and update the plan with links.",
            ),
            QuickAction(
                "unsubscribe", "x",
                "Unsubscribe me from this sender with mail_action (action \"unsubscribe\"), and propose archiving their other mail in my inbox with mail_action.",
                needsUnsubscribe = true,
            ),
            QuickAction(
                "summary", "sparkle",
                "Summarize this email and its thread in at most three bullets, then tell me whether it needs a reply from me and by when.",
            ),
            QuickAction(
                "triage", "clock",
                "Look at my inbox across all accounts with search_mail and tell me what needs my attention today, most urgent first, with one line per email. Show the emails as sources with show_sources (use the message ids).",
                needsEmail = false,
            ),
        )
    }
}
