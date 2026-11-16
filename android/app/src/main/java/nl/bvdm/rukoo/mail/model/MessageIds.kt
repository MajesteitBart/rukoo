package nl.bvdm.rukoo.mail.model

import nl.bvdm.rukoo.core.UriComponent

/** The parts of a Rukoo message id. */
data class MessageKey(val accountId: String, val folder: String, val uid: Long)

/**
 * Rukoo message ids in desktop's format (engine.js:105-112):
 * `[accountId, folder, uid].map(encodeURIComponent).join(':')`. An id therefore always has two `:` and
 * never an `@`, which is how the agent tools tell an id from a Message-ID header. Ids change when a
 * message moves. Build and read ids only through this object.
 */
object MessageIds {
    /** Copies saved on the device use `saved:<uuid>` on desktop; the phone keeps the prefix reserved. */
    const val SAVED_PREFIX = "saved:"

    fun encode(accountId: String, folder: String, uid: Long): String =
        listOf(accountId, folder, uid.toString()).joinToString(":") { UriComponent.encode(it) }

    fun encode(key: MessageKey): String = encode(key.accountId, key.folder, key.uid)

    /** Null for anything that isn't a well-formed id: wrong part count, a broken escape, a uid that isn't a number. */
    fun decode(id: String): MessageKey? {
        if (id.startsWith(SAVED_PREFIX)) return null
        val parts = id.split(':')
        if (parts.size != 3) return null
        val accountId = UriComponent.decode(parts[0]) ?: return null
        val folder = UriComponent.decode(parts[1]) ?: return null
        val uid = UriComponent.decode(parts[2])?.toLongOrNull() ?: return null
        if (accountId.isEmpty() || folder.isEmpty() || uid < 0) return null
        return MessageKey(accountId, folder, uid)
    }

    /**
     * The account part of an id, like desktop's fallback in messageRef (hub.js:831): the first
     * `:`-separated segment, decoded. Null when it can't be read.
     */
    fun accountOf(id: String): String? {
        if (id.startsWith(SAVED_PREFIX)) return null
        val first = id.substringBefore(':', "")
        return UriComponent.decode(first)?.takeIf { it.isNotEmpty() }
    }

    fun isSaved(id: String): Boolean = id.startsWith(SAVED_PREFIX)

    /** A Message-ID header as a comparable key: no angle brackets, lower case (engine.js:123-125). */
    fun headerKey(messageId: String?): String = (messageId ?: "").trim().replace("<", "").replace(">", "").lowercase()

    /** How many References a cached message keeps, the newest (desktop mailutil.js REFERENCES_KEPT, the hub's cap). */
    const val REFERENCES_KEPT = 50

    private val BRACKETED = Regex("<[^<>]*>")
    private val SEPARATORS = Regex("[\\s,]+")

    /**
     * The Message-IDs a References header names, in their <id@domain> form: the last [REFERENCES_KEPT], which a long
     * thread's header has at the end (desktop mailutil.js referenceIds). A header without angle brackets is split on
     * spaces. Ids longer than a header line can be are left out, and so is an id a partial fetch cut off before its `>`.
     */
    fun referenceIds(value: String?): List<String> {
        val text = value.orEmpty()
        val bracketed = BRACKETED.findAll(text).map { it.value }.toList()
        val ids = bracketed.ifEmpty { text.split(SEPARATORS) }
        return ids.map { it.trim() }.filter { it.isNotEmpty() && it.length <= 998 }.takeLast(REFERENCES_KEPT)
    }
}
