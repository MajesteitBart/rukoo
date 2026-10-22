package nl.bvdm.rukoo.mcp.tools

import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import nl.bvdm.rukoo.agents.model.Conversation
import nl.bvdm.rukoo.agents.model.DraftMode
import nl.bvdm.rukoo.agents.model.Item
import nl.bvdm.rukoo.agents.model.Origin
import nl.bvdm.rukoo.core.Unsafe
import nl.bvdm.rukoo.mail.model.Address
import nl.bvdm.rukoo.mail.model.FullMessage
import nl.bvdm.rukoo.mail.model.Identity
import nl.bvdm.rukoo.mail.model.OutgoingAttachment
import nl.bvdm.rukoo.mail.model.ReplyKind
import nl.bvdm.rukoo.ui.ComposerState

/** The quote header lines a reply carries, in the user's language (desktop composer.quote.*). */
interface DraftTexts {
    fun marker(): String

    fun from(sender: String): String

    fun date(date: String): String

    fun to(recipients: String): String

    fun subject(subject: String): String

    /** `<date> <HH:mm> (GMT±hh:mm)`, desktop's quoteDate. */
    fun quoteDate(ms: Long, zone: ZoneId): String {
        val at = Instant.ofEpochMilli(ms).atZone(zone)
        val offset = at.offset.id.let { if (it == "Z") "+00:00" else it }
        return "${DateTimeFormatter.ofPattern(datePattern()).format(at)} (GMT$offset)"
    }

    fun datePattern(): String = "dd-MM-yyyy HH:mm"

    /** English, for tests and as the fallback; the app uses its string resources. */
    object English : DraftTexts {
        override fun marker() = "-------- Original message --------"
        override fun from(sender: String) = "From: $sender"
        override fun date(date: String) = "Date: $date"
        override fun to(recipients: String) = "To: $recipients"
        override fun subject(subject: String) = "Subject: $subject"
        override fun datePattern() = "dd/MM/yyyy HH:mm"
    }
}

/** The answer a background chat gets when the composer holds something it may not replace (desktop's `busy`). */
private class ComposerBusy : Exception("The user is writing another email in the composer.")

/**
 * write_draft and get_draft (tools.js:1045-1154) on the phone's single composer. The rules for when a draft may
 * replace what is open are the desktop panel's (panel.js:1939-2029), with the composer state in place of the
 * renderer round trip: a chat that is not on screen never replaces the user's words or a composer that is about
 * something else; the chat on screen may, unless the user or another agent wrote in it. In the background the
 * draft still goes into the composer, and the hub's DraftWritten event lets the user open it from a notification.
 */
internal class DraftWriter(private val d: ToolDeps, private val lookup: MailLookup) {
    private val writes = AtomicInteger()

    suspend fun write(args: JsonObject, call: ToolCall): JsonObject {
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
        // Desktop gives the composer 20 seconds; loading the email can wait for the server, so the same limit holds
        // here, and nothing is written into the composer after it.
        val source = target?.let { id ->
            val loaded = try {
                withTimeoutOrNull(d.draftWaitMs) { d.mail.fullMessage(id) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                throw ToolError("Rukoo could not update the composer: ${e.message ?: e.javaClass.simpleName}")
            }
            loaded ?: throw ToolError("Rukoo did not respond in time, so the draft could not be shown. Check with get_draft before trying again.")
        }
        val agentName = d.hub.agentName(call.agent)
        val shown = try {
            place(c, finalMode, source, agentName, bodyText, to, cc, bcc, subject)
        } catch (_: ComposerBusy) {
            throw ToolError(
                "The user is writing another email in Rukoo's composer, so the draft was not shown. Do not retry on your own: ask the user to finish or close that email, then write the draft again. You can put the text in the chat meanwhile.",
            )
        }
        val key = "${shown.id}:${writes.incrementAndGet()}".take(100)
        d.hub.addItem(
            c.id,
            Item.Draft(
                id = "",
                at = 0,
                mode = DraftMode.entries.first { it.name.lowercase() == finalMode },
                to = shown.to,
                subject = shown.subject,
                summary = bodyText.replace(Regex("\\s+"), " ").take(160),
                messageRef = target,
                composerKey = key,
                undone = false,
            ),
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

    /** Puts the draft in the composer, or throws [ComposerBusy]; returns what the composer holds now. */
    private suspend fun place(
        c: Conversation,
        mode: String,
        source: FullMessage?,
        agentName: String,
        body: String,
        to: List<Address>?,
        cc: List<Address>?,
        bcc: List<Address>?,
        subject: String?,
    ): ComposerState {
        val kind = KINDS.getValue(mode)
        val screen = d.screen.current
        // A chat that is not on screen, or one an agent started from elsewhere, never closes what the user is writing.
        val background = !(screen.foreground && screen.chatConversationId == c.id) || c.origin == Origin.EXTERNAL
        val current = d.composer.current()
        var envelope: Pair<List<Address>, List<Address>>? = null
        if (current != null) {
            // This chat's agent wrote what is there.
            val mine = current.draftedBy != null &&
                (if (current.draftedIn != null) current.draftedIn == c.id else current.draftedBy == agentName)
            // The user's own words: typed since the composer opened, a draft they reopened, or an agent draft they
            // changed (the UI clears draftedBy then).
            val theirs = current.draftedBy == null && (current.dirty || current.body.isNotBlank() || current.replyKind == ReplyKind.DRAFT)
            val fit = fits(current, source, kind, mine, theirs)
            // A reopened draft keeps no record of reply or reply-all: recipients the agent left out follow the mode,
            // so a private reply never keeps the old Cc.
            if (fit && current.replyKind == ReplyKind.DRAFT && source != null && (to == null || cc == null)) {
                envelope = replyEnvelope(d.mail.identities(source.accountId), source, kind)
            }
            // A chat that is not on screen leaves the user's words alone even where it would fit; the chat on screen
            // may rewrite them, because the user just asked it to.
            if (background && theirs) throw ComposerBusy()
            if (fit) {
                val next = current.copy(
                    to = to ?: envelope?.first ?: current.to,
                    cc = cc ?: envelope?.second ?: current.cc,
                    bcc = bcc ?: current.bcc,
                    subject = subject ?: current.subject,
                    body = body,
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
        val fresh = build(kind, source, agentName, c.id, body, to, cc, bcc, subject)
        d.composer.open(fresh)
        return fresh
    }

    // The open composer is the one this write is for: the same email in exactly the same mode, a reopened draft that
    // answers it (for reply or reply-all), or for a new email an open new message that is untouched or this chat's.
    private fun fits(current: ComposerState, source: FullMessage?, kind: ReplyKind, mine: Boolean, theirs: Boolean): Boolean {
        if (source == null) return current.replyKind == ReplyKind.NEW && (mine || !theirs)
        if (current.replyKind == ReplyKind.DRAFT) {
            return (kind == ReplyKind.REPLY || kind == ReplyKind.REPLY_ALL) && !current.inReplyTo.isNullOrEmpty() &&
                MailLookup.normId(current.inReplyTo) == MailLookup.normId(source.messageId)
        }
        return current.sourceMessageId == source.id && current.replyKind == kind
    }

    /** A new composer for [kind], filled in from [source] the way the composer does it (spec 4 §3.6). */
    private fun build(
        kind: ReplyKind,
        source: FullMessage?,
        agentName: String,
        conversationId: String,
        body: String,
        to: List<Address>?,
        cc: List<Address>?,
        bcc: List<Address>?,
        subject: String?,
    ): ComposerState {
        if (source == null) {
            val accountId = d.defaultAccountId()?.takeIf { id -> lookup.accounts().any { it.id == id } } ?: lookup.accounts().firstOrNull()?.id
            val account = lookup.account(accountId)
            val ids = accountId?.let { d.mail.identities(it) }.orEmpty()
            val from = (ids.firstOrNull { it.address.equals(account?.defaultFrom, ignoreCase = true) } ?: ids.firstOrNull { it.primary } ?: ids.firstOrNull())
                ?.let { Address(it.name, it.address) }
            return ComposerState(
                accountId = accountId, from = from, to = to.orEmpty(), cc = cc.orEmpty(), bcc = bcc.orEmpty(),
                subject = subject.orEmpty(), body = body, replyKind = ReplyKind.NEW, draftedBy = agentName, draftedIn = conversationId, dirty = true,
            )
        }
        val ids = d.mail.identities(source.accountId)
        val account = lookup.account(source.accountId)
        val reply = kind == ReplyKind.REPLY || kind == ReplyKind.REPLY_ALL
        val envelope = if (reply) replyEnvelope(ids, source, kind) else emptyList<Address>() to emptyList()
        return ComposerState(
            accountId = source.accountId,
            from = replyFrom(ids, source, account?.defaultFrom)?.let { Address(it.name, it.address) },
            to = to ?: envelope.first,
            cc = cc ?: envelope.second,
            bcc = bcc.orEmpty(),
            subject = subject ?: prefixed(source.subject, if (reply) "Re" else "Fwd"),
            body = body,
            quote = quote(source),
            replyKind = kind,
            sourceMessageId = source.id,
            inReplyTo = if (reply) source.messageId else null,
            references = if (reply) (source.references + listOfNotNull(source.messageId)).filter { it.isNotEmpty() } else emptyList(),
            // A forward takes the attachments along; the engine fetches them from the source when it sends.
            attachments = if (kind == ReplyKind.FORWARD) {
                source.attachments.map { OutgoingAttachment(it.filename, it.contentType, path = "", size = it.size, sourceMessageId = source.id, sourceIndex = it.index) }
            } else {
                emptyList()
            },
            draftedBy = agentName,
            draftedIn = conversationId,
            dirty = true,
        )
    }

    private fun quote(m: FullMessage): String {
        val t = d.texts
        val lines = mutableListOf(
            t.marker(),
            t.from(m.from.display()),
            t.date(t.quoteDate(m.date, d.zone())),
            t.to(m.to.joinToString(", ") { it.display() }),
        )
        if (m.cc.isNotEmpty()) lines += "Cc: ${m.cc.joinToString(", ") { it.display() }}"
        lines += t.subject(m.subject)
        return lines.joinToString("\n") + "\n\n" + m.text
    }

    /** get_draft: the composer now, the user's edits included, or {open: false}. */
    fun current(): JsonObject = d.composer.current()?.let(::view) ?: buildJsonObject { put("open", false) }

    /** The composer as agents see it: a reply's recipients and subject come from the email, so they are tagged. */
    fun view(state: ComposerState): JsonObject {
        val text = state.body
        return buildJsonObject {
            put("open", true)
            put("mode", MODE_NAMES.getValue(state.replyKind))
            put("from", state.from?.address?.ifEmpty { null })
            put("to", MailLookup.people(state.to))
            put("cc", MailLookup.people(state.cc))
            put("bcc", MailLookup.people(state.bcc))
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

        fun prefixed(subject: String, prefix: String): String {
            val re = if (prefix == "Re") Regex("^(re|antw|aw)\\s*:", RegexOption.IGNORE_CASE) else Regex("^(fwd?|doorst)\\s*:", RegexOption.IGNORE_CASE)
            return if (re.containsMatchIn(subject.trim())) subject else "$prefix: $subject"
        }

        private fun same(a: String?, b: String?) = a.orEmpty().trim().equals(b.orEmpty().trim(), ignoreCase = true)

        private fun uniq(list: List<Address>): List<Address> {
            val seen = HashSet<String>()
            return list.filter { it.address.isNotBlank() && seen.add(it.address.trim().lowercase()) }
        }

        /** desktop replyEnvelope (composer.js): who a reply goes to. A reply never fills Cc. */
        fun replyEnvelope(ids: List<Identity>, m: FullMessage, kind: ReplyKind): Pair<List<Address>, List<Address>> {
            fun own(address: String?) = ids.any { same(it.address, address) }
            val fromSelf = own(m.from.address)
            var to = if (fromSelf) m.to else m.replyTo.ifEmpty { listOf(m.from) }.filter { it.address.isNotBlank() }
            var cc = emptyList<Address>()
            if (kind == ReplyKind.REPLY_ALL) {
                val extra = if (fromSelf) emptyList() else m.to.filter { !own(it.address) }
                to = uniq(to + extra)
                cc = uniq(m.cc.filter { a -> !own(a.address) && to.none { same(it.address, a.address) } })
            }
            return to to cc
        }

        /**
         * desktop replyFrom: the identity that sent the original, else the first alias it was sent to, else the
         * account address if it was sent there, else the default From.
         */
        fun replyFrom(ids: List<Identity>, m: FullMessage, defaultFrom: String?): Identity? {
            ids.firstOrNull { same(it.address, m.from.address) }?.let { return it }
            val sentTo = m.to + m.cc
            ids.filter { !it.primary }.firstOrNull { i -> sentTo.any { same(it.address, i.address) } }?.let { return it }
            ids.firstOrNull { i -> i.primary && sentTo.any { same(it.address, i.address) } }?.let { return it }
            return ids.firstOrNull { same(it.address, defaultFrom) } ?: ids.firstOrNull { it.primary } ?: ids.firstOrNull()
        }
    }
}
