package nl.bvdm.rukoo.mcp.tools

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import nl.bvdm.rukoo.agents.model.Conversation
import nl.bvdm.rukoo.agents.model.DraftMode
import nl.bvdm.rukoo.agents.model.Item
import nl.bvdm.rukoo.agents.model.Origin
import nl.bvdm.rukoo.core.Unsafe
import nl.bvdm.rukoo.mail.compose.ComposeBody
import nl.bvdm.rukoo.mail.compose.ComposerFields
import nl.bvdm.rukoo.mail.compose.ReplyBuilder
import nl.bvdm.rukoo.mail.model.Address
import nl.bvdm.rukoo.mail.model.ReplyKind
import nl.bvdm.rukoo.ui.ComposerState
import nl.bvdm.rukoo.ui.composer.Recipients

/** The answer a background chat gets when the composer holds something it may not replace (desktop's `busy`). */
private class ComposerBusy : Exception("The user is writing another email in the composer.")

/**
 * write_draft and get_draft (tools.js:1045-1154) on the phone's single composer. The rules for when a draft may
 * replace what is open are the desktop panel's (panel.js:1939-2029), with the composer state in place of the
 * renderer round trip: a chat that is not on screen never replaces the user's words or a composer that is about
 * something else; the chat on screen may, unless the user or another agent wrote in it. In the background the
 * draft still goes into the composer, and the hub's DraftWritten event lets the user open it from a notification.
 *
 * A reply, reply-all or forward starts from what the mail engine gives the composer (recipients, From, subject,
 * quote, signature), so an agent's draft is the same composer the user would have opened. The agent's text goes
 * above the signature, as on desktop.
 */
internal class DraftWriter(private val d: ToolDeps, private val lookup: MailLookup) {
    /**
     * Desktop gives the composer 20 seconds; finding and loading the email can wait for the server, so the whole
     * write has that limit here. The composer is only changed after the last wait, so a write that ran out of time
     * leaves it as it was.
     */
    suspend fun write(args: JsonObject, call: ToolCall): JsonObject =
        withTimeoutOrNull(d.draftWaitMs) { writeNow(args, call) }
            ?: throw ToolError("Rukoo did not respond in time, so the draft could not be shown. Check with get_draft before trying again.")

    private suspend fun writeNow(args: JsonObject, call: ToolCall): JsonObject {
        val bound = call.conversation
        val mode = args.str("mode")
        var messageId: String? = null
        val given = args.str("message_id")?.ifEmpty { null }
        if (given != null) {
            messageId = lookup.resolveId(given)
        } else if (mode != "new") {
            val ref = bound?.message
            if (ref != null) {
                // Never fall back to whatever email is open: the reply would go to someone else.
                messageId = lookup.locate(ref)
                if (d.hub.get(bound.id) == null) throw ToolError("This chat was deleted, so Rukoo did not write the draft.")
                if (messageId == null) {
                    throw ToolError(
                        "Rukoo cannot find the email this chat is about any more (it may have moved to another folder or been deleted). Pass message_id: search_mail with its folder finds the current id.",
                    )
                }
            } else {
                messageId = lookup.live(d.screen.current.openMessageId)
            }
        }
        val finalMode = mode ?: if (messageId != null) "reply" else "new"
        if (finalMode != "new" && messageId == null) throw ToolError("Mode \"$finalMode\" needs an email: pass message_id, or use mode \"new\".")
        // Recipients the agent did not pass stay absent, so the composer keeps its own; an empty list clears the field.
        val to = people(args.list("to"), "to")
        val cc = people(args.list("cc"), "cc")
        val bcc = people(args.list("bcc"), "bcc")
        val subject = if (args.has("subject")) args.str("subject").orEmpty() else null
        val format = args.str("format") ?: "markdown"
        val body = args.str("body").orEmpty()
        val html = DraftHtml.toHtml(body, format)
        // Past this the draft would be cut off mid-way, so it is refused whole, before a chat is made for it.
        if (html.length > DRAFT_HTML_MAX) {
            throw ToolError("The draft is too long for the composer: ${html.length} characters once formatted, the limit is $DRAFT_HTML_MAX. Write a shorter one.")
        }
        val c = ensureConversation(d, lookup, call)
        // The phone's composer is plain text: the body as the user will see it.
        val bodyText = (if (format == "text") body else PlainText.fromHtml(html).replace(Regex("\\n{3,}"), "\n\n")).trim()
        val target = if (finalMode == "new") null else messageId
        val kind = KINDS.getValue(finalMode)
        val fields = target?.let { id ->
            try {
                d.mail.replyFields(id, kind)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                throw ToolError("Rukoo could not update the composer: ${e.message ?: e.javaClass.simpleName}")
            }
        }
        val agentName = d.hub.agentName(call.agent)
        // On the composer's thread, and finished once started: a write the deadline stops halfway would leave a
        // composer changed without its card.
        val shown = withContext(NonCancellable + d.mainContext) {
            val placed = try {
                place(c, kind, fields, agentName, bodyText, to, cc, bcc, subject)
            } catch (_: ComposerBusy) {
                null
            }
            placed?.also { s ->
                d.hub.addItem(
                    c.id,
                    Item.Draft(
                        id = "",
                        at = 0,
                        mode = DraftMode.entries.first { it.name.lowercase() == finalMode },
                        to = s.to,
                        subject = s.subject,
                        summary = bodyText.replace(Regex("\\s+"), " ").take(160),
                        messageRef = target,
                        // The composer that holds this draft. The composer's Undo and the card's Show and Undo compare
                        // it with ComposerState.id.
                        composerKey = s.id,
                        undone = false,
                    ),
                )
            }
        } ?: throw ToolError(
            "The user is writing another email in Rukoo's composer, so the draft was not shown. Do not retry on your own: ask the user to finish or close that email, then write the draft again. You can put the text in the chat meanwhile.",
        )
        // A reply's recipients and subject come from the email, so the agent gets them tagged; the card keeps them plain.
        return buildJsonObject {
            put("ok", true)
            put("conversation_id", c.id)
            put(
                "draft",
                buildJsonObject {
                    put("mode", finalMode)
                    put("to", MailLookup.people(shown.to))
                    put("cc", MailLookup.people(shown.cc))
                    put("subject", Unsafe.value(shown.subject))
                    put("body_text", shown.body.take(MailLookup.TEXT_MAX))
                },
            )
            put("note", "The draft is in the composer. The user reviews and sends it; you cannot send email.")
        }
    }

    /** The signature the composer put at the end of [state]'s text, with the empty line before it, or "". */
    private fun signatureTail(state: ComposerState): String {
        val sig = state.accountId?.let { d.mail.signatureFor(it) }?.text?.trim().orEmpty()
        if (sig.isEmpty() || !state.body.trimEnd().endsWith(sig)) return ""
        return "\n\n" + sig
    }

    /**
     * Puts the draft in the composer, or throws [ComposerBusy]; returns what the composer holds now. Not a suspend
     * function, so nothing can stop it halfway.
     */
    private fun place(
        c: Conversation,
        kind: ReplyKind,
        fields: ComposerFields?,
        agentName: String,
        body: String,
        to: List<Address>?,
        cc: List<Address>?,
        bcc: List<Address>?,
        subject: String?,
    ): ComposerState {
        val screen = d.screen.current
        // A chat that is not on screen, or one an agent started from elsewhere, never closes what the user is writing.
        val background = !(screen.foreground && screen.chatConversationId == c.id) || c.origin == Origin.EXTERNAL
        val current = d.composer.current()
        if (current != null) {
            // This chat's agent wrote what is there.
            val mine = current.draftedBy != null &&
                (if (current.draftedIn != null) current.draftedIn == c.id else current.draftedBy == agentName)
            // The signature the composer started with is not the user's writing; the agent's text goes above it.
            val tail = signatureTail(current)
            val words = if (tail.isNotEmpty()) current.body.trimEnd().removeSuffix(tail.trim()).trimEnd() else current.body
            // The user's own words: typed since the composer opened, a draft they reopened, or an agent draft they
            // changed (the UI clears draftedBy then).
            val theirs = current.draftedBy == null && (current.dirty || words.isNotBlank() || current.replyKind == ReplyKind.DRAFT)
            val fit = fits(current, fields, kind, mine, theirs)
            // A reopened draft keeps no record of reply or reply-all: recipients the agent left out follow the mode,
            // so a private reply never keeps the old Cc.
            val envelope = if (fit && current.replyKind == ReplyKind.DRAFT && fields != null && (to == null || cc == null)) fields.to to fields.cc else null
            // A chat that is not on screen leaves the user's words alone even where it would fit; the chat on screen
            // may rewrite them, because the user just asked it to.
            if (background && theirs) throw ComposerBusy()
            if (fit) {
                val next = current.copy(
                    to = to ?: envelope?.first ?: current.to,
                    cc = cc ?: envelope?.second ?: current.cc,
                    bcc = bcc ?: current.bcc,
                    subject = subject ?: current.subject,
                    body = body + tail,
                    draftedBy = agentName,
                    draftedIn = c.id,
                    dirty = true,
                )
                // The user may have closed or replaced it while the email loaded: only write into the same composer.
                var wrote = false
                d.composer.update { now -> if (now.id == current.id) next.also { wrote = true } else now }
                if (!wrote) throw ComposerBusy()
                return next
            }
            // A chat that is not on screen never replaces what is open; the chat on screen does, unless the user (or
            // another agent) wrote in it.
            if (background || ((current.dirty || theirs) && !mine)) throw ComposerBusy()
        }
        val fresh = build(fields, agentName, c.id, body, to, cc, bcc, subject)
        d.composer.open(fresh)
        return fresh
    }

    // The open composer is the one this write is for: the same email in exactly the same mode, a reopened draft that
    // answers it (for reply or reply-all), or for a new email an open new message that is untouched or this chat's.
    private fun fits(current: ComposerState, fields: ComposerFields?, kind: ReplyKind, mine: Boolean, theirs: Boolean): Boolean {
        if (fields == null) return current.replyKind == ReplyKind.NEW && (mine || !theirs)
        if (current.replyKind == ReplyKind.DRAFT) {
            return (kind == ReplyKind.REPLY || kind == ReplyKind.REPLY_ALL) && !current.inReplyTo.isNullOrEmpty() &&
                MailLookup.normId(current.inReplyTo) == MailLookup.normId(fields.inReplyTo)
        }
        return current.sourceMessageId == fields.sourceMessageId && current.replyKind == kind
    }

    /** A new composer: the engine's reply or forward fields, or a new email from the default account, with the agent's text. */
    private fun build(
        fields: ComposerFields?,
        agentName: String,
        conversationId: String,
        body: String,
        to: List<Address>?,
        cc: List<Address>?,
        bcc: List<Address>?,
        subject: String?,
    ): ComposerState {
        if (fields == null) {
            val accountId = d.defaultAccountId()?.takeIf { id -> lookup.accounts().any { it.id == id } } ?: lookup.accounts().firstOrNull()?.id
            val account = lookup.account(accountId)
            val from = account?.let { ReplyBuilder.defaultIdentity(it, d.mail.identities(it.id)) }?.let { Address(it.name, it.address) }
            val signature = accountId?.let { ComposeBody.initialText(d.mail.signatureFor(it)) }.orEmpty()
            return ComposerState(
                accountId = accountId, from = from, to = to.orEmpty(), cc = cc.orEmpty(), bcc = bcc.orEmpty(),
                subject = subject.orEmpty(), body = body + signature, replyKind = ReplyKind.NEW, draftedBy = agentName, draftedIn = conversationId, dirty = true,
            )
        }
        // fields.body is what the composer starts with: the account's signature after an empty line, or nothing.
        return fields.toComposerState().copy(
            to = to ?: fields.to,
            cc = cc ?: fields.cc,
            bcc = bcc ?: fields.bcc,
            subject = subject ?: fields.subject,
            body = body + fields.body,
            draftedBy = agentName,
            draftedIn = conversationId,
            dirty = true,
        )
    }

    /** get_draft: the composer now, the user's edits included, or {open: false}. */
    fun current(): JsonObject = d.composer.current()?.let(::view) ?: buildJsonObject { put("open", false) }

    /**
     * The composer as agents see it: a reply's recipients and subject come from the email, so they are tagged.
     * Recipient text the user typed but didn't finish counts, as Send would turn it into recipients.
     */
    fun view(state: ComposerState): JsonObject {
        val text = state.body
        fun with(list: List<Address>, field: String) = Recipients.merge(list, Recipients.parse(state.typed[field].orEmpty()))
        return buildJsonObject {
            put("open", true)
            put("mode", MODE_NAMES.getValue(state.replyKind))
            put("from", state.from?.address?.ifEmpty { null })
            put("to", MailLookup.people(with(state.to, "to")))
            put("cc", MailLookup.people(with(state.cc, "cc")))
            put("bcc", MailLookup.people(with(state.bcc, "bcc")))
            put("subject", Unsafe.value(state.subject))
            put("text", text.take(MailLookup.TEXT_MAX))
            put("truncated", text.length > MailLookup.TEXT_MAX)
            put("agent", state.draftedBy)
            put("dirty", state.dirty)
        }
    }

    companion object {
        private const val DRAFT_HTML_MAX = 200000
        private val KINDS = mapOf("reply" to ReplyKind.REPLY, "reply_all" to ReplyKind.REPLY_ALL, "forward" to ReplyKind.FORWARD, "new" to ReplyKind.NEW)

        // The composer's modes as desktop's getDraft names them.
        private val MODE_NAMES = mapOf(
            ReplyKind.REPLY to "reply", ReplyKind.REPLY_ALL to "replyAll", ReplyKind.FORWARD to "forward", ReplyKind.NEW to "new", ReplyKind.DRAFT to "draft",
        )

        private val ADDRESS = Regex("^[^@\\s<>,;]+@[^@\\s<>,;]+$")
        private val SPLIT = Regex("[,;](?=(?:[^\"]*\"[^\"]*\")*[^\"]*$)")
        private val NAMED = Regex("^\\s*\"?([^\"<]*?)\"?\\s*<([^>]+)>\\s*$")

        /** Recipients as an agent passes them: strings ("Name <address>", comma-separated) or {name, address}. */
        fun people(list: List<JsonElement>?, field: String): List<Address>? {
            if (list == null) return null
            val out = mutableListOf<Address>()
            for (v in list) {
                val parts: List<Pair<String, String>> = when (v) {
                    is JsonPrimitive -> v.content.split(SPLIT).map { p ->
                        val m = NAMED.find(p)
                        if (m != null) m.groupValues[1].trim() to m.groupValues[2].trim() else "" to p.trim()
                    }
                    is JsonObject -> listOf(v.str("name").orEmpty().trim() to v.str("address").orEmpty().trim())
                    else -> emptyList()
                }
                for ((name, address) in parts) {
                    if (address.isEmpty()) continue
                    if (!ADDRESS.matches(address)) throw ToolError("$field: ${Unsafe.value(address)} is not an email address.")
                    out += Address(name.take(200), address.take(320))
                }
            }
            return out
        }
    }
}
