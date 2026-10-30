package nl.bvdm.rukoo.mcp.tools

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import nl.bvdm.rukoo.agents.model.ApprovalChoice
import nl.bvdm.rukoo.agents.model.ApprovalField
import nl.bvdm.rukoo.agents.model.ApprovalKind
import nl.bvdm.rukoo.agents.model.ApprovalRequest
import nl.bvdm.rukoo.agents.model.ChoiceKind
import nl.bvdm.rukoo.agents.model.MailApproval
import nl.bvdm.rukoo.core.Unsafe
import nl.bvdm.rukoo.mail.model.MessageIds
import nl.bvdm.rukoo.mail.model.MessagePin
import nl.bvdm.rukoo.agents.MailActions as HubMailActions

/**
 * mail_action (tools.js:1250-1525): checks the request and hands it to the hub, which runs every mail action, as
 * desktop's does. Archive, move and mark run at once when the user turned that on; deleting, unsubscribing and a
 * move into Trash or Spam always ask. An approval card returns at once; when the user decides, the hub runs the
 * action on the chat's mail chain and its outcome goes into the agent's next message as a note.
 */
internal class MailActions(private val d: ToolDeps, private val lookup: MailLookup) {
    private val titles = HubMailActions(d.mail)

    suspend fun request(args: JsonObject, call: ToolCall): JsonObject {
        val action = args.str("action").orEmpty()
        val ids = mutableListOf<String>()
        val bad = mutableListOf<String>()
        for (v in args.list("message_ids").orEmpty().map { (it as JsonPrimitive).content }.distinct()) {
            try {
                // mail_action never touches a copy saved on a device.
                ids += lookup.resolveId(v)
            } catch (e: ToolError) {
                // An email in more than one account is not unknown: say which accounts have it.
                if (e.ambiguous) throw e
                bad += v
            }
        }
        if (bad.isNotEmpty()) {
            throw ToolError("Unknown message ids: ${bad.joinToString(", ") { Unsafe.value(it) }}. Ids change when mail moves; use search_mail for current ids.")
        }
        val accounts = ids.mapNotNull { MessageIds.decode(it)?.accountId }.distinct().mapNotNull { lookup.account(it) }
        val folder = args.str("folder")
        if (action == "move") {
            if (folder.isNullOrEmpty()) throw ToolError("folder is required for move.")
            val missing = accounts.filter { lookup.resolveFolder(it, folder) == null }
            if (missing.isNotEmpty()) throw ToolError("No folder ${Unsafe.value(folder)}. Folders: ${lookup.folderList(missing)}.")
        }
        if (action == "archive") {
            val none = accounts.filter { d.mail.archiveFolder(it.id) == null }
            if (none.isNotEmpty()) throw ToolError("${none.joinToString(", ") { it.email }} has no archive folder. Use move instead.")
        }
        val c = ensureConversation(d, lookup, call)
        val spec = MailApproval(action, ids, if (action == "move") folder else null, ids.map { d.mail.pinOf(it) ?: MessagePin() })
        val title = titles.title(spec)
        // The setting covers archive, move and mark, as desktop's Auto does. Deleting and unsubscribing always ask, and
        // so does a move that lands in Trash, which is a delete by another name, or in Spam, which empties itself
        // (Gmail's after 30 days) and learns from the move (permission.js).
        val asks = action == "move" && accounts.any { a ->
            val target = lookup.resolveFolder(a, folder)
            lookup.publicFolders(a.id).any { it.path == target && (it.role == "trash" || it.role == "junk") }
        }
        if (d.agentSettings().autoMailActions && action != "unsubscribe" && action != "trash" && !asks) {
            return runNow(c.id, spec, title)
        }
        val fields = ids.take(6).map { id ->
            val m = d.mail.summary(id)
            ApprovalField(m?.from?.let { it.name.ifEmpty { it.address } }.orEmpty(), m?.subject?.ifEmpty { null } ?: "(no subject)")
        }.toMutableList()
        if (ids.size > 6) fields += ApprovalField("", "and ${ids.size - 6} more")
        val ticket = d.hub.requestApproval(
            c.id,
            ApprovalRequest(
                title = title,
                detail = "",
                fields = fields,
                choices = listOf(ApprovalChoice("approve", HubMailActions.VERBS.getValue(action).first, ChoiceKind.PRIMARY), ApprovalChoice("decline", "Cancel", ChoiceKind.DEFAULT)),
                source = "rukoo",
                kind = ApprovalKind.MAIL,
                mail = spec,
            ),
        )
        return buildJsonObject {
            put("conversation_id", c.id)
            put("proposal_id", ticket.itemId)
            put("status", "waiting_for_user")
            put("note", "Rukoo is asking the user. Do not repeat the request; you will be told the outcome in your next message.")
        }
    }

    /**
     * The call waits for the work, but its client gives up after 120 s and a slow IMAP server can take longer. Then
     * the call answers that the work goes on, and the hub puts the outcome in the agent's next message as a note.
     * The summary can name a sender (an unsubscribe) and an error can quote a server: tagged, as in the notes and in
     * desktop's result (tools.js mailAction).
     */
    private suspend fun runNow(cid: String, spec: MailApproval, title: String): JsonObject {
        val result = d.hub.runMailAction(cid, spec, title, d.mailWaitMs)
            ?: return buildJsonObject {
                put("conversation_id", cid)
                put("status", "in_progress")
                put("note", "Rukoo is still doing this. You will be told the outcome in your next message; do not repeat the request.")
            }
        return buildJsonObject {
            put("conversation_id", cid)
            put("status", "done")
            put("done", result.done.size)
            put(
                "failed",
                buildJsonArray {
                    for ((id, error) in result.failed) {
                        add(
                            buildJsonObject {
                                put("id", id)
                                put("error", Unsafe.inline(error, "mail result"))
                            },
                        )
                    }
                },
            )
            put("undoable", result.undo.isNotEmpty())
            put("summary", Unsafe.inline(result.text, "mail result"))
        }
    }
}
