package nl.bvdm.rukoo.workspaces

/** A mention as the composer holds it: UTF-16 indices into its text. */
data class MentionSpan(val start: Int, val end: Int, val actor: String)

/**
 * Mentions between the composer's UTF-16 indices and the wire's UTF-8 byte offsets (contract §3.17). Everything
 * outside the editor uses byte offsets; only the composer converts, here.
 *
 * A lone surrogate counts as three bytes, the U+FFFD a UTF-8 encoder writes for it, as desktop's TextEncoder does.
 */
object Utf8Offsets {
    /** The rules §3.17 names, as the shared vectors call them. */
    const val SPLIT_CHARACTER = "split_character"
    const val OUT_OF_ORDER = "out_of_order"
    const val OVERLAP = "overlap"
    const val PAST_END = "past_end"
    const val EMPTY = "empty"
    const val TOO_MANY = "too_many"
    const val BAD_ACTOR = "bad_actor"

    /**
     * The byte offset before every UTF-16 index, `text.length + 1` of them. The index between the two halves of a
     * surrogate pair gets -1: no byte offset lies there.
     */
    fun byteOffsets(text: String): IntArray {
        val out = IntArray(text.length + 1)
        var bytes = 0
        var i = 0
        while (i < text.length) {
            out[i] = bytes
            val c = text[i]
            if (c.isHighSurrogate() && i + 1 < text.length && text[i + 1].isLowSurrogate()) {
                out[i + 1] = -1
                bytes += 4
                i += 2
            } else {
                bytes += when {
                    c.code < 0x80 -> 1
                    c.code < 0x800 -> 2
                    else -> 3
                }
                i += 1
            }
        }
        out[text.length] = bytes
        return out
    }

    fun utf8Length(text: String): Int = byteOffsets(text)[text.length]

    /**
     * True when every surrogate in [text] is half of a pair, as JavaScript's `isWellFormed`. Kotlin's UTF-8 encoder
     * writes a lone one as `?`, one byte where [byteOffsets] counts three, so the outbox refuses such text as desktop
     * does, and the counted bytes, the mentions and the wire always agree.
     */
    fun isWellFormed(text: String): Boolean {
        var i = 0
        while (i < text.length) {
            val c = text[i]
            if (c.isHighSurrogate() && i + 1 < text.length && text[i + 1].isLowSurrogate()) {
                i += 2
                continue
            }
            if (c.isSurrogate()) return false
            i += 1
        }
        return true
    }

    /**
     * The composer's spans as wire mentions: sorted by start, and dropping a span that is empty, runs past the text,
     * splits a surrogate pair, overlaps the one before it or names no member. At most [MENTION_LIMIT] remain.
     */
    fun toWire(text: String, spans: List<MentionSpan>): List<Mention> {
        val offsets = byteOffsets(text)
        val out = ArrayList<Mention>()
        var lastEnd = -1
        for (s in spans.sortedWith(compareBy({ it.start }, { it.end }))) {
            if (out.size == MENTION_LIMIT) break
            if (s.start < 0 || s.end <= s.start || s.end > text.length) continue
            if (!WorkspaceIds.isMember(s.actor)) continue
            val start = offsets[s.start]
            val end = offsets[s.end]
            if (start < 0 || end < 0) continue
            if (s.start < lastEnd) continue
            out += Mention(s.actor, start, end)
            lastEnd = s.end
        }
        return out
    }

    /**
     * Wire mentions as spans over [text]. A mention that breaks a rule of §3.17 is dropped and its text shows plain:
     * one that names no member, is empty, runs past the text, starts or ends inside a character, or starts before
     * the previous kept one ends. Only the first [MENTION_LIMIT] count.
     */
    fun fromWire(text: String, mentions: List<Mention>): List<MentionSpan> {
        val offsets = byteOffsets(text)
        val index = byteToIndex(offsets, text.length)
        val out = ArrayList<MentionSpan>()
        var lastEnd = -1
        for (m in mentions.take(MENTION_LIMIT)) {
            if (!WorkspaceIds.isMember(m.actor) || m.end <= m.start || m.start < 0) continue
            val start = index[m.start] ?: continue
            val end = index[m.end] ?: continue
            if (m.start < lastEnd) continue
            out += MentionSpan(start, end, m.actor)
            lastEnd = m.end
        }
        return out
    }

    /** Every rule of §3.17 the list breaks, empty for a valid one. The engines check this before sending. */
    fun violations(text: String, mentions: List<Mention>): Set<String> {
        val offsets = byteOffsets(text)
        val length = offsets[text.length]
        val index = byteToIndex(offsets, text.length)
        val broken = LinkedHashSet<String>()
        if (mentions.size > MENTION_LIMIT) broken += TOO_MANY
        var prev: Mention? = null
        for (m in mentions) {
            if (!WorkspaceIds.isMember(m.actor)) broken += BAD_ACTOR
            if (m.end <= m.start) broken += EMPTY
            if (m.start < 0 || m.end < 0 || m.start > length || m.end > length) broken += PAST_END
            val startOk = m.start !in 0..length || m.start in index
            val endOk = m.end !in 0..length || m.end in index
            if (!startOk || !endOk) broken += SPLIT_CHARACTER
            prev?.let { p ->
                if (m.start < p.start) broken += OUT_OF_ORDER else if (m.start < p.end) broken += OVERLAP
            }
            prev = m
        }
        return broken
    }

    fun isValid(text: String, mentions: List<Mention>): Boolean = violations(text, mentions).isEmpty()

    /** Byte offset to UTF-16 index, for the offsets that lie between code points. */
    private fun byteToIndex(offsets: IntArray, length: Int): Map<Int, Int> {
        val out = HashMap<Int, Int>(length + 1)
        for (i in 0..length) if (offsets[i] >= 0) out[offsets[i]] = i
        return out
    }
}
