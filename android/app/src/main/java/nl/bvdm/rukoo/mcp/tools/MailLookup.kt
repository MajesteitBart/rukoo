package nl.bvdm.rukoo.mcp.tools

import java.text.Normalizer
import java.time.Instant
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import nl.bvdm.rukoo.agents.AgentFolders
import nl.bvdm.rukoo.agents.AmbiguousFolder
import nl.bvdm.rukoo.agents.model.MessageRef
import nl.bvdm.rukoo.core.Unsafe
import nl.bvdm.rukoo.mail.MailEngine
import nl.bvdm.rukoo.mail.model.Account
import nl.bvdm.rukoo.mail.model.Address
import nl.bvdm.rukoo.mail.model.FolderRole
import nl.bvdm.rukoo.mail.model.FullMessage
import nl.bvdm.rukoo.mail.model.MailView
import nl.bvdm.rukoo.mail.model.MessageIds
import nl.bvdm.rukoo.mail.model.MessageSummary
import nl.bvdm.rukoo.mail.model.ViewKind

/** A folder as agents see it (desktop publicAccount): no Starred or Important, and Gmail's All Mail as `archive`. */
data class PublicFolder(val path: String, val name: String, val role: String?)

/**
 * The mail lookups of desktop's tools.js (427-761) over [MailEngine]: ids, accounts, folders, and an email as
 * agents see it. What the sender wrote (people, subject, preview, attachment names) goes inside
 * `<unsafe_content>` value by value; ids, account, folder, date and flags stay plain, and so does a Message-ID
 * in the usual form.
 */
class MailLookup(private val mail: MailEngine) {
    fun accounts(): List<Account> = mail.accounts.value

    fun account(id: String?): Account? = id?.let { a -> accounts().firstOrNull { it.id == a } }

    fun publicFolders(accountId: String): List<PublicFolder> =
        AgentFolders.visible(mail.folders.value[accountId].orEmpty(), mail.archiveFolder(accountId)).map { PublicFolder(it.path, it.name, agentRole(it.role)) }

    /**
     * Turns what an agent passes as message_id into a current Rukoo id: a live id or a Message-ID header. The phone
     * keeps no saved copies, so a `saved:` id from desktop is refused the way desktop refuses one it doesn't have.
     */
    suspend fun resolveId(value: String?): String {
        val v = value.orEmpty().trim()
        if (v.isEmpty()) throw ToolError("message_id is required.")
        if (MessageIds.isSaved(v)) throw ToolError("${Unsafe.value(v)} is a copy saved on this device; it cannot be changed with mail_action.")
        if (mail.summary(v) != null) return v
        if ('@' in v) {
            // The same email can have several live copies: in two accounts, or in two folders of one. A header names
            // none of them, so with more than one only the Rukoo id says which is meant. Gmail's All Mail copy only
            // counts when it is the only one.
            val copies = mail.findByMessageId(v)
            val live = copies.filter { it.role != FolderRole.ALL }
            val accounts = copies.map { it.accountId }.toSet()
            if (live.size > 1 || accounts.size > 1) {
                val where = live.ifEmpty { copies }.joinToString(", ") { "${account(it.accountId)?.email ?: it.accountId} in ${it.folder}" }
                throw ToolError(
                    "More than one copy of the email with Message-ID ${Unsafe.value(v)} is here: $where. Pass the Rukoo id of the copy you mean; search_mail and get_context list them.",
                    ambiguous = true,
                )
            }
            if (copies.isNotEmpty()) return (live.firstOrNull() ?: copies.first()).id
        }
        throw ToolError("No email with id ${Unsafe.value(v)}. Ids change when mail moves; use search_mail or get_context for current ids.")
    }

    fun findAccount(value: String): Account {
        val v = value.trim().lowercase()
        return accounts().firstOrNull { it.id == value || it.email.trim().lowercase() == v || it.label.trim().lowercase() == v }
            ?: throw ToolError(
                "Unknown account ${Unsafe.value(value)}. Accounts: ${accounts().joinToString(", ") { "${it.email} (id ${it.id})" }.ifEmpty { "none" }}.",
            )
    }

    /**
     * The exact path wins. A name, or a path in another case, must belong to one folder only: "2026" can be both
     * Projects/2026 and Archive/2026, and then the call fails and asks for the path. Then the role words.
     */
    fun resolveFolder(acc: Account, value: String?): String? = try {
        // The hub's rule, so a folder the tool accepts is the folder the hub's action moves to.
        AgentFolders.resolve(mail.folders.value[acc.id].orEmpty(), mail.archiveFolder(acc.id), value)
    } catch (e: AmbiguousFolder) {
        throw ToolError(
            "More than one folder in ${acc.email} is called ${Unsafe.value(value.orEmpty().trim())}: ${e.paths.joinToString(", ")}. Pass the full path.",
            ambiguous = true,
        )
    }

    fun folderList(accounts: List<Account>): String =
        accounts.joinToString("; ") { a -> "${a.email}: ${publicFolders(a.id).joinToString(", ") { it.path }}" }

    /** The open email when it is still in the cache. */
    suspend fun live(id: String?): String? = id?.takeIf { it.isNotEmpty() && mail.summary(it) != null }

    /**
     * Where the email a chat is about is now (desktop hub.locate, hub.js:783-806): its id while that still holds the
     * same message, else the copy with its Message-ID in the same folder, else where Rukoo moved it, else the one
     * live copy. Null when it can't be told.
     */
    suspend fun locate(ref: MessageRef): String? {
        val id = ref.id
        val header = ref.messageId.orEmpty()
        val cached = if (id.isNotEmpty()) mail.summary(id) else null
        if (cached != null && (header.isEmpty() || cached.messageId.isNullOrEmpty() || normId(cached.messageId) == normId(header))) return id
        if (header.isEmpty()) return null
        val account = ref.accountId ?: MessageIds.accountOf(id)
        val folder = MessageIds.decode(id)?.folder
        val copies = mail.findByMessageId(header).filter { account == null || it.accountId == account }
        val live = copies.filter { it.role != FolderRole.ALL }
        val same = live.filter { it.folder == folder }
        if (same.size == 1) return same[0].id
        if (account != null) {
            runCatching { mail.findMoved(account, header, folder) }.getOrNull()?.let { return it }
        }
        if (live.size > 1) return null
        return (live.firstOrNull() ?: copies.firstOrNull())?.id
    }

    suspend fun loadMessage(id: String): FullMessage? = runCatching { mail.fullMessage(id) }.getOrNull()

    fun summary(m: MessageSummary): JsonObject = buildJsonObject {
        put("id", m.id)
        m.messageId?.takeIf { it.isNotBlank() }?.let { put("messageId", headerId(it)) }
        put("account", account(m.accountId)?.email ?: m.accountId.ifEmpty { null })
        put("folder", m.folder.ifEmpty { null })
        put("role", agentRole(m.role))
        put("date", iso(m.date))
        put("from", emailAddr(m.from))
        put("to", people(m.to))
        put("cc", people(m.cc))
        put("subject", Unsafe.value(m.subject))
        put("preview", Unsafe.value(m.preview))
        put("unread", m.unread)
        put("starred", m.starred)
        put("has_attachments", m.hasAttachments)
    }

    suspend fun summaryById(id: String): JsonObject? = mail.summary(id)?.let(::summary)

    fun fullView(m: FullMessage, maxChars: Int = TEXT_MAX): JsonObject {
        val text = m.text
        return buildJsonObject {
            put("id", m.id)
            put("message_id_header", headerId(m.messageId))
            put("account", account(m.accountId)?.email ?: m.accountId.ifEmpty { null })
            put("folder", m.folder.ifEmpty { null })
            put("role", agentRole(m.summary.role))
            put("date", iso(m.date))
            put("from", emailAddr(m.from))
            put("to", people(m.to))
            put("cc", people(m.cc))
            put("reply_to", people(m.replyTo))
            put("subject", Unsafe.value(m.subject))
            put("in_reply_to", Unsafe.value(m.inReplyTo).ifEmpty { null })
            put("references", JsonArray(m.references.map(Unsafe::value).filter { it.isNotEmpty() }.map(::JsonPrimitive)))
            put("unread", m.summary.unread)
            put("starred", m.summary.starred)
            // The body is third-party text: inside <unsafe_content>, like everything Rukoo passes on from email.
            put("text", Unsafe.block(text.take(maxChars), mapOf("source" to "email", "message_id" to (m.messageId ?: ""))))
            put("truncated", text.length > maxChars)
            // The sender names an attachment and declares its type; only the index and size are Rukoo's.
            put(
                "attachments",
                buildJsonArray {
                    for (a in m.attachments) {
                        add(
                            buildJsonObject {
                                put("index", a.index)
                                put("filename", Unsafe.value(a.filename))
                                put("content_type", Unsafe.value(a.contentType.ifEmpty { "application/octet-stream" }))
                                put("size", a.size)
                            },
                        )
                    }
                },
            )
            put("unsubscribe", m.unsubscribe != null)
            // The List-Unsubscribe links, for an agent that finishes the page in its own browser. The sender wrote
            // them, so they are tagged like the rest.
            put("unsubscribe_url", Unsafe.value(m.unsubscribe?.url).ifEmpty { null })
            put("unsubscribe_mailto", Unsafe.value(m.unsubscribe?.mail).ifEmpty { null })
            if (m.bcc.isNotEmpty()) put("bcc", people(m.bcc))
        }
    }

    /** Every address of every account: mail between them isn't "someone in common". */
    fun ownAddresses(): Set<String> = accounts().flatMap { a -> mail.identities(a.id).map { it.address.trim().lowercase() } }.toSet()

    /**
     * Related mail (desktop threadOf, tools.js:665-696): linked by Message-ID, In-Reply-To or References, or the same
     * base subject with someone in common other than the user. Gmail's All Mail comes last so the labelled copy wins.
     */
    suspend fun threadOf(m: FullMessage, limit: Int = 10): List<JsonObject> {
        val ids = threadIds(m.messageId, m.inReplyTo, m.references)
        val self = normId(m.messageId)
        val subject = baseSubject(m.subject)
        val own = ownAddresses()
        val theirs = participants(m.from, m.to, m.cc).filter { it !in own }.toSet()
        val all = mail.listMessages(MailView(ViewKind.EVERYTHING)).sortedBy { if (it.role == FolderRole.ALL) 1 else 0 }
        val seen = HashSet<String>()
        val hits = mutableListOf<MessageSummary>()
        for (r in all) {
            val mid = normId(r.messageId)
            if (r.id == m.id || (mid.isNotEmpty() && mid == self)) continue
            val link = linked(ids, r)
            val similar = !link && subject.isNotEmpty() && baseSubject(r.subject) == subject && participants(r.from, r.to, r.cc).any { it in theirs }
            if (!link && !similar) continue
            val key = mid.ifEmpty { r.id }
            if (!seen.add(key)) continue
            hits += r
        }
        return hits.sortedByDescending { it.date }.take(limit).map(::summary)
    }

    private fun linked(ids: Set<String>, r: MessageSummary): Boolean {
        val mid = normId(r.messageId)
        return (mid.isNotEmpty() && mid in ids) || (!r.inReplyTo.isNullOrEmpty() && normId(r.inReplyTo) in ids)
    }

    companion object {
        const val TEXT_MAX = 20000

        private val MESSAGE_ID_FORM = Regex("""^<[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+@[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+>$""")
        private val SUBJECT_PREFIX = Regex("^(?:re|fwd?|fw|antw|aw|doorst)(?:\\s*\\[\\d+\\])?\\s*:\\s*", RegexOption.IGNORE_CASE)
        private val ISO = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(ZoneOffset.UTC)
        private val MARKS = Regex("[\\u0300-\\u036f]")

        // Compiled once: threadOf runs it for every cached email.
        private val SPACES = Regex("\\s+")

        /**
         * A Message-ID is a key agents pass on to link back to the email, so one in the usual <local@domain> form
         * stays plain. Anything else is text the sender wrote and is tagged like the rest.
         */
        fun headerId(v: String?): String? {
            val s = v.orEmpty().trim()
            if (s.isEmpty()) return null
            return if (s.length <= 250 && MESSAGE_ID_FORM.matches(s)) s else Unsafe.value(s)
        }

        /** Gmail's All Mail is `archive` to agents; only the cache keeps `all`. A user folder is null. */
        fun agentRole(role: FolderRole): String? = AgentFolders.role(role)

        /** JS toISOString(): UTC with milliseconds, or null for no date. */
        fun iso(ms: Long): String? = if (ms == 0L) null else ISO.format(Instant.ofEpochMilli(ms))

        fun normId(v: String?): String = v.orEmpty().trim().removePrefix("<").removeSuffix(">").lowercase()

        fun fold(s: String?): String = MARKS.replace(Normalizer.normalize(s.orEmpty(), Normalizer.Form.NFD), "").lowercase()

        fun baseSubject(subject: String?): String {
            var s = subject.orEmpty().trim()
            while (true) {
                val next = SUBJECT_PREFIX.replaceFirst(s, "").trim()
                if (next == s) break
                s = next
            }
            return s.lowercase().replace(SPACES, " ")
        }

        fun threadIds(messageId: String?, inReplyTo: String?, references: List<String>): Set<String> =
            (listOf(messageId, inReplyTo) + references).map(::normId).filter { it.isNotEmpty() }.toSet()

        fun participants(from: Address?, to: List<Address>, cc: List<Address>): List<String> =
            (listOfNotNull(from) + to + cc).map { it.address.trim().lowercase() }.filter { it.isNotEmpty() }

        /** A person as an email names them: the sender wrote both the name and the address. */
        fun emailAddr(a: Address?): JsonObject = buildJsonObject {
            put("name", Unsafe.value(a?.name))
            put("address", Unsafe.value(a?.address))
        }

        fun people(list: List<Address>): JsonArray = JsonArray(list.map(::emailAddr))
    }
}

// Readers for validated arguments: a key that validate() dropped or never had reads as null.
internal fun JsonObject.str(key: String): String? = (this[key] as? JsonPrimitive)?.takeIf { it !is JsonNull && it.isString }?.content

internal fun JsonObject.long(key: String): Long? = (this[key] as? JsonPrimitive)?.takeIf { it !is JsonNull }?.longOrNull

internal fun JsonObject.bool(key: String): Boolean? = (this[key] as? JsonPrimitive)?.takeIf { it !is JsonNull && !it.isString }?.booleanOrNull

internal fun JsonObject.list(key: String): List<JsonElement>? = this[key] as? JsonArray

internal fun JsonObject.has(key: String): Boolean = this[key] != null && this[key] !is JsonNull
