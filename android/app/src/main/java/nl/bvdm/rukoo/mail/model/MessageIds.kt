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
}
