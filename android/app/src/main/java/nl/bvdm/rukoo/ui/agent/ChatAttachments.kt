package nl.bvdm.rukoo.ui.agent

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import nl.bvdm.rukoo.agents.AgentException
import nl.bvdm.rukoo.agents.StageResult
import nl.bvdm.rukoo.agents.model.Conversation
import nl.bvdm.rukoo.agents.model.MessageRef
import nl.bvdm.rukoo.core.RukooJson
import nl.bvdm.rukoo.mail.model.Address

/** An email "Add to chat" put on the message being written (panel.js `P.attach.emails`): it goes along with the next send. */
@Serializable
data class PendingEmail(val id: String, val messageId: String? = null, val subject: String = "", val from: Address? = null)

/** A file staged for the message being written (panel.js `P.attach.files`): the hub keeps its copy under [id]. */
@Serializable
data class PendingFile(val id: String, val name: String, val size: Long = 0, val kind: String = "file")

/** A picked file still being copied in (panel.js `P.adding`): a pending chip, and nothing is sent meanwhile. */
data class AddingFile(val name: String, val size: Long?)

/** What adding emails did: the list after, how many were new, how many the chat or the message had already, and whether some didn't fit. */
data class AddedEmails(val emails: List<PendingEmail>, val added: Int, val had: Int, val full: Boolean)

/** The rules for emails added to a chat message (panel.js addEmails, inChat, deliver). */
object ChatAttachments {
    /** One email can be in several folders under several ids, so its Message-ID counts as well (panel.js sameMessageId). */
    fun sameMessageId(a: String?, b: String?): Boolean {
        if (a.isNullOrBlank() || b.isNullOrBlank()) return false
        fun norm(s: String) = s.filterNot { it == '<' || it == '>' || it.isWhitespace() }.lowercase()
        return norm(a) == norm(b)
    }

    fun same(e: PendingEmail, id: String?, messageId: String?): Boolean = e.id == id || sameMessageId(e.messageId, messageId)

    /**
     * Whether the chat has [e] already: a started chat its own email or one it was continued from, a new chat the
     * email it is about ([emailId] while [ref] still loads), unless the user left that one out.
     */
    fun inChat(e: PendingEmail, conversation: Conversation?, emailId: String?, ref: MessageRef?, detached: Boolean): Boolean {
        if (conversation != null) {
            val own = conversation.message
            if (own != null && same(e, own.id, own.messageId)) return true
            return conversation.continued.any { same(e, it.id, it.messageId) }
        }
        if (detached) return false
        return e.id == emailId || (ref != null && same(e, ref.id, ref.messageId))
    }

    /** [offered] added to [current], up to [max]: the chat's own and doubles count as had, the rest as full. */
    fun add(current: List<PendingEmail>, offered: List<PendingEmail>, max: Int, inChat: (PendingEmail) -> Boolean): AddedEmails {
        val out = current.toMutableList()
        var added = 0
        var had = 0
        var full = false
        for (e in offered) {
            if (inChat(e) || out.any { same(it, e.id, e.messageId) }) {
                had++
                continue
            }
            if (out.size >= max) {
                full = true
                continue
            }
            out += e
            added++
        }
        return AddedEmails(out, added, had, full)
    }

    /**
     * The ids of the hub's `email-missing` or `file-missing` refusal ([code]; a JSON array in its detail), or null
     * for any other failure.
     */
    fun missing(e: Throwable, code: String = "email-missing"): Set<String>? {
        val ex = e as? AgentException ?: return null
        if (ex.code != code) return null
        val ids = runCatching { RukooJson.parseToJsonElement(ex.detail) as? JsonArray }.getOrNull() ?: return emptySet()
        return ids.mapNotNull { (it as? JsonPrimitive)?.contentOrNull }.toSet()
    }

    /** A message that didn't go: its emails come back first, before any the user added meanwhile, without the [gone] ones. */
    fun restore(sent: List<PendingEmail>, now: List<PendingEmail>, gone: Set<String>): List<PendingEmail> =
        restoreBy(sent, now, gone) { it.id }

    /** The same for its files: the hub kept them staged, except the [gone] ones it no longer has. */
    fun restoreFiles(sent: List<PendingFile>, now: List<PendingFile>, gone: Set<String>): List<PendingFile> =
        restoreBy(sent, now, gone) { it.id }

    private fun <T> restoreBy(sent: List<T>, now: List<T>, gone: Set<String>, id: (T) -> String): List<T> {
        val back = sent.filter { id(it) !in gone }
        return back + now.filter { n -> back.none { id(it) == id(n) } }
    }

    /**
     * What staging did, for the input (panel.js takeFiles): the files that wait for the message, up to [max] in all;
     * the refused ones, each with why; whether some didn't fit ('too-many', or past [max]); and the staged files past
     * [max], which the hub lets go of.
     */
    data class Taken(val files: List<PendingFile>, val refused: List<StageResult>, val full: Boolean, val dropped: List<String>)

    fun take(current: List<PendingFile>, results: List<StageResult>, max: Int): Taken {
        val files = current.toMutableList()
        val refused = mutableListOf<StageResult>()
        val dropped = mutableListOf<String>()
        var full = false
        for (r in results) {
            val f = r.file
            when {
                r.error == "too-many" -> full = true
                r.error != null || f == null -> refused += r
                files.size >= max -> {
                    full = true
                    dropped += f.id
                }
                else -> files += PendingFile(f.id, f.name, f.size, f.kind)
            }
        }
        return Taken(files, refused, full, dropped)
    }
}
