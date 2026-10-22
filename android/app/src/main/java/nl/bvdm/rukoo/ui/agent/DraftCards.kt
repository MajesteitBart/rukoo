package nl.bvdm.rukoo.ui.agent

import nl.bvdm.rukoo.agents.AgentHub
import nl.bvdm.rukoo.agents.model.Item
import nl.bvdm.rukoo.ui.ComposerState

/**
 * Draft cards and the composer they wrote into (panel.js draft cards). A card's composerKey is desktop's
 * `<composer id>:<write>`; a bare composer id names the same composer. Show and Undo act on that composer only.
 */
object DraftCards {
    /** The composer id a card's key names. */
    fun composerOf(key: String?): String? = key?.substringBefore(':')?.takeIf { it.isNotEmpty() }

    /** The open composer the card's write went into, or null when another one (or none) is open. */
    fun composerFor(item: Item.Draft, composer: ComposerState?): ComposerState? {
        val id = composerOf(item.composerKey) ?: return null
        return composer?.takeIf { it.id == id }
    }

    /** Undo is offered while the card's composer is open and still holds an agent's text, edited or not. */
    fun canUndo(item: Item.Draft, composer: ComposerState?): Boolean {
        if (item.undone) return false
        val open = composerFor(item, composer) ?: return false
        return open.draftedBy != null || open.editedAgent != null
    }

    /**
     * After an Undo in [composerId]: its cards written at or after [since] that aren't undone yet say so, in every
     * chat. The composer goes back to before the agent's first write since the user's own text, so those are the
     * writes it took back; an earlier write the user then edited stays (ComposerController.undoAgentDraftSince).
     */
    suspend fun markUndone(hub: AgentHub, composerId: String, since: Long = 0L) {
        for (row in hub.conversations.value) {
            val conversation = hub.get(row.id) ?: continue
            for (item in conversation.items) {
                if (item is Item.Draft && !item.undone && item.at >= since && composerOf(item.composerKey) == composerId) {
                    hub.patchDraft(conversation.id, item.id, undone = true)
                }
            }
        }
    }
}
