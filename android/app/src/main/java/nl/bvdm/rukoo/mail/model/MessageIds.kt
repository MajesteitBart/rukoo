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

    /** The longest id kept: a header line holds no more (RFC 5322). */
    private const val ID_CHARS = 998

    /**
     * The Message-IDs a References header value names: the last [REFERENCES_KEPT], which a long thread's header has at
     * the end (desktop mailutil.js referenceIds). The ids in angle brackets when the value has any; otherwise the value
     * split on spaces and commas. Ids longer than a header line can be are left out, and so is an id a partial fetch cut
     * off before its `>`.
     */
    fun referenceIds(value: String?): List<String> = ReferenceTail().apply { add(value.orEmpty()) }.ids()

    /**
     * [referenceIds] for a value read in parts (ImapSession): what the whole value would give, keeping only the newest
     * ids of both readings and the unfinished id or word at the end of the last part, so a huge header never sits in
     * memory whole.
     */
    class ReferenceTail {
        // Ids in angle brackets, desktop's <[^<>]*>: an id starts at the last `<` before its `>`.
        private val bracketed = ArrayDeque<String>()
        private var sawBracketed = false
        private var open: StringBuilder? = null
        private var openTooLong = false

        // The words between spaces and commas, for a value without angle brackets.
        private val words = ArrayDeque<String>()
        private val word = StringBuilder()
        private var wordTooLong = false

        fun add(text: String) {
            for (c in text) {
                bracket(c)
                if (c == ' ' || c == ',' || c == '\t' || c == '\r' || c == '\n' || c == '\u000B' || c == '\u000C') endWord()
                else if (!wordTooLong) {
                    if (word.length < ID_CHARS) word.append(c) else {
                        wordTooLong = true
                        word.setLength(0)
                    }
                }
            }
        }

        private fun bracket(c: Char) {
            val o = open
            when {
                c == '<' -> {
                    open = StringBuilder("<")
                    openTooLong = false
                }
                o == null -> Unit
                c == '>' -> {
                    sawBracketed = true
                    if (!openTooLong && o.length < ID_CHARS) keep(bracketed, o.append('>').toString())
                    open = null
                }
                openTooLong -> Unit
                o.length >= ID_CHARS -> {
                    openTooLong = true
                    o.setLength(0)
                }
                else -> o.append(c)
            }
        }

        private fun endWord() {
            if (!wordTooLong && word.isNotEmpty()) keep(words, word.toString())
            word.setLength(0)
            wordTooLong = false
        }

        private fun keep(list: ArrayDeque<String>, id: String) {
            list.addLast(id)
            if (list.size > REFERENCES_KEPT) list.removeFirst()
        }

        /** The ids so far. A value cut off mid-word, by a partial fetch, keeps that word, as the split of a cut value does. */
        fun ids(): List<String> {
            if (sawBracketed) return bracketed.toList()
            val all = if (!wordTooLong && word.isNotEmpty()) words + word.toString() else words.toList()
            return all.takeLast(REFERENCES_KEPT)
        }
    }
}
