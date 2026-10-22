package nl.bvdm.rukoo.agents

import android.content.Context
import nl.bvdm.rukoo.R
import nl.bvdm.rukoo.agents.model.Conversation
import nl.bvdm.rukoo.agents.model.Item
import nl.bvdm.rukoo.agents.model.TurnStatus

/** Intent extras of the notifications that open a chat. MainActivity (track B) routes on them. */
object AgentIntents {
    /** The chat to open. */
    const val EXTRA_CONVERSATION_ID = "nl.bvdm.rukoo.conversation"

    /** The Rukoo id of the chat's email, when it has one, so the reader can show it next to the chat. */
    const val EXTRA_MESSAGE_ID = "nl.bvdm.rukoo.message"

    /** True on a "draft written" notification: open the composer with the agent's draft. */
    const val EXTRA_OPEN_COMPOSER = "nl.bvdm.rukoo.composer"
}

/**
 * What the hub tells the user about outside the app: a turn that ended while its chat wasn't on screen, an
 * approval card waiting, a draft written in the background. [AgentNotifier] posts them; tests count them.
 */
interface AgentAlerts {
    /** A turn ended with an answer or an error while its chat wasn't on screen. */
    fun replyReady(conversation: Conversation, status: TurnStatus) {}

    fun approvalWaiting(conversation: Conversation, item: Item.Approval) {}

    fun draftWritten(conversation: Conversation, item: Item.Draft) {}

    /** The user has the chat on screen now, or it is gone: its notification can go. */
    fun seen(conversationId: String) {}

    object None : AgentAlerts
}

/** The user-visible words the hub itself puts on agent descriptors. */
interface HubStrings {
    /** "on desktop-zolder": where a computer's Claude Code or Codex runs. */
    fun onComputer(name: String): String

    /** The debug build's scripted agent. */
    val fakeName: String

    object English : HubStrings {
        override fun onComputer(name: String) = "on $name"

        override val fakeName = "Test agent"
    }
}

class AndroidHubStrings(private val context: Context) : HubStrings {
    override fun onComputer(name: String): String = context.getString(R.string.agents_on_computer, name)

    override val fakeName: String get() = context.getString(R.string.agents_fake_name)
}
