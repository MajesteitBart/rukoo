package nl.bvdm.rukoo.ui.chat

import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.TextFieldValue
import nl.bvdm.rukoo.workspaces.Draft
import nl.bvdm.rukoo.workspaces.MENTION_LIMIT
import nl.bvdm.rukoo.workspaces.Member
import nl.bvdm.rukoo.workspaces.Mention
import nl.bvdm.rukoo.workspaces.MentionSpan
import nl.bvdm.rukoo.workspaces.TEXT_BYTES
import nl.bvdm.rukoo.workspaces.Utf8Offsets

/** What the composer holds: the field, and the picked mentions as UTF-16 spans of its text, in order. */
data class ComposerValue(val field: TextFieldValue = TextFieldValue(), val spans: List<MentionSpan> = emptyList()) {
    val text: String get() = this.field.text
}

/** A mention being typed: the `@` at [start], the caret at [end], and the [query] between them. */
data class MentionToken(val start: Int, val end: Int, val query: String)

/**
 * The composer's text as it goes on the wire (contract §3.16, §3.17): trimmed, with the mentions in UTF-8 byte offsets
 * of that text. [mentionCount] counts every picked mention, so more than [MENTION_LIMIT] can be refused.
 */
data class WireText(val text: String, val mentions: List<Mention>, val bytes: Int, val mentionCount: Int) {
    val tooLong: Boolean get() = bytes > TEXT_BYTES
    val tooManyMentions: Boolean get() = mentionCount > MENTION_LIMIT
    val canSend: Boolean get() = text.isNotEmpty() && !tooLong && !tooManyMentions
}

/**
 * Editing text with mentions in it (android.md "Composer with mentions"), pure so MentionEditingTest covers it. A
 * picked mention is `@` and the member's name as one unit: an edit elsewhere moves it, Backspace at its end or Delete
 * at its start removes it whole, and any other edit that touches it leaves the text and drops the mention. Typing
 * `@Name` by hand mentions nobody (§3.17). Only here and in [Utf8Offsets] do offsets change units.
 */
object MentionEditing {
    /** A name of a few words fits in this; longer text after an @ is a sentence (mention-match.js MAX_QUERY). */
    const val MAX_QUERY = 40

    // What may come right before the @ of a mention: nothing, white space or an opening bracket or quote. A letter
    // there makes it an email address typed in the text, which never opens the picker.
    private const val OPENERS = "([{\"'“‘«"

    private fun opener(c: Char): Boolean = c.isWhitespace() || c == ' ' || c in OPENERS

    /**
     * The mention being typed at [caret] in [text] (a port of mention-match.js `mentionToken`), or null. Picked
     * mentions in [spans] are units of their own: the `@` has to come after the last of them before the caret, and
     * right after one it doesn't count. The query ends at the caret, starts right after the `@`, stays on one line, has
     * no two spaces in a row and is at most [MAX_QUERY] characters.
     */
    fun token(text: String, caret: Int, spans: List<MentionSpan> = emptyList()): MentionToken? {
        if (caret <= 0 || caret > text.length) return null
        if (spans.any { caret > it.start && caret < it.end }) return null
        val lineStart = text.lastIndexOf('\n', caret - 1) + 1
        // Like desktop's text node: the text between the line's start, or the last picked mention, and the caret.
        val from = maxOf(lineStart, spans.filter { it.end <= caret }.maxOfOrNull { it.end } ?: 0)
        val at = text.lastIndexOf('@', caret - 1)
        if (at < from) return null
        val before = when {
            at > from -> text[at - 1]
            from > lineStart -> text[from - 1]
            else -> null
        }
        if (before != null && !opener(before)) return null
        val query = text.substring(at + 1, caret).replace(' ', ' ')
        if (query.length > MAX_QUERY || '\n' in query) return null
        if (query.firstOrNull()?.isWhitespace() == true) return null
        if (query.zipWithNext().any { (a, b) -> a.isWhitespace() && b.isWhitespace() }) return null
        return MentionToken(at, caret, query)
    }

    /**
     * The value after the field changed to [new]. Spans before the edit stay, spans after it move, and a span the edit
     * touches either goes whole (Backspace at its end, Delete at its start) or leaves its text behind as plain text.
     */
    fun edited(old: ComposerValue, new: TextFieldValue): ComposerValue {
        val before = old.text
        val after = new.text
        if (before == after) return old.copy(field = new)
        val (p, oldEnd, newEnd) = changed(before, after, new.selection)
        // A single character taken off the end or the start of a picked mention takes the mention with it.
        if (newEnd == p && oldEnd - p == 1) {
            val chip = old.spans.firstOrNull { (oldEnd == it.end && p >= it.start) || (p == it.start && oldEnd <= it.end) }
            if (chip != null) {
                val text = before.removeRange(chip.start, chip.end)
                val cut = chip.end - chip.start
                val spans = old.spans.mapNotNull { s ->
                    when {
                        s == chip -> null
                        s.end <= chip.start -> s
                        else -> s.copy(start = s.start - cut, end = s.end - cut)
                    }
                }
                return ComposerValue(TextFieldValue(text, TextRange(chip.start)), spans)
            }
        }
        val delta = (newEnd - p) - (oldEnd - p)
        val spans = old.spans.mapNotNull { s ->
            when {
                s.end <= p -> s
                s.start >= oldEnd -> s.copy(start = s.start + delta, end = s.end + delta)
                else -> null
            }
        }
        return ComposerValue(new, spans)
    }

    /**
     * Where [before] became [after]: the edit replaced `before[p, oldEnd)` with `after[p, newEnd)`. The caret after a
     * typed or deleted character marks the end of the edit, which tells "@" typed before "@Ann" apart from one after
     * it; without a usable caret the longest common start wins.
     */
    private fun changed(before: String, after: String, selection: TextRange): Triple<Int, Int, Int> {
        val caret = selection.end
        if (selection.collapsed && caret in 0..after.length) {
            val tail = after.length - caret
            if (tail <= before.length && before.regionMatches(before.length - tail, after, caret, tail)) {
                val limit = minOf(before.length - tail, caret)
                var p = 0
                while (p < limit && before[p] == after[p]) p++
                return Triple(p, before.length - tail, caret)
            }
        }
        var p = 0
        val limit = minOf(before.length, after.length)
        while (p < limit && before[p] == after[p]) p++
        var s = 0
        while (s < before.length - p && s < after.length - p && before[before.length - 1 - s] == after[after.length - 1 - s]) s++
        return Triple(p, before.length - s, after.length - s)
    }

    /** The text a picked [member] puts in: `@` and their current name. */
    fun label(member: Member): String = "@" + member.name.trim()

    /**
     * Picks [member] for [token]: `@Name` as a mention in place of the typed `@query`, then a space (one that is there
     * already is used), with the caret after it.
     */
    fun insert(value: ComposerValue, token: MentionToken, member: Member): ComposerValue {
        val text = value.text
        val label = label(member)
        val rest = text.substring(token.end)
        val space = if (rest.startsWith(" ")) "" else " "
        val next = text.substring(0, token.start) + label + space + rest
        val delta = label.length + space.length - (token.end - token.start)
        val spans = value.spans.mapNotNull { s ->
            when {
                s.end <= token.start -> s
                s.start >= token.end -> s.copy(start = s.start + delta, end = s.end + delta)
                else -> null
            }
        } + MentionSpan(token.start, token.start + label.length, member.id)
        return ComposerValue(TextFieldValue(next, TextRange(token.start + label.length + 1)), spans.sortedBy { it.start })
    }

    /**
     * The value as it goes on the wire: no-break spaces as spaces, white space trimmed from both ends before any offset
     * is counted (desktop chat-text.js `toWire`), and the mentions in UTF-8 byte offsets of the trimmed text.
     */
    fun wire(value: ComposerValue): WireText {
        val text = value.text.replace(' ', ' ')
        val trimmed = text.trim()
        val lead = text.length - text.trimStart().length
        val spans = value.spans.mapNotNull { s ->
            val start = s.start - lead
            val end = s.end - lead
            if (start < 0 || end > trimmed.length || end <= start) null else MentionSpan(start, end, s.actor)
        }
        return WireText(trimmed, Utf8Offsets.toWire(trimmed, spans), Utf8Offsets.utf8Length(trimmed), spans.size)
    }

    /** The draft the cache keeps (§3.5): the exact text and its mentions in byte offsets, or null when it is empty. */
    fun toDraft(value: ComposerValue): Draft? =
        if (value.text.isEmpty()) null else Draft(value.text, Utf8Offsets.toWire(value.text, value.spans))

    /** A kept draft back in the composer, the caret at its end. A mention that no longer fits shows as plain text. */
    fun fromDraft(draft: Draft?): ComposerValue {
        if (draft == null || draft.text.isEmpty()) return ComposerValue()
        return ComposerValue(TextFieldValue(draft.text, TextRange(draft.text.length)), Utf8Offsets.fromWire(draft.text, draft.mentions))
    }

    /** [text] and [mentions] (a discarded message's) after what [value] holds, on a new line when it holds text. */
    fun append(value: ComposerValue, text: String, mentions: List<Mention>): ComposerValue {
        val glue = if (value.text.isEmpty()) "" else "\n"
        val offset = value.text.length + glue.length
        val next = value.text + glue + text
        val spans = value.spans + Utf8Offsets.fromWire(text, mentions).map { it.copy(start = it.start + offset, end = it.end + offset) }
        return ComposerValue(TextFieldValue(next, TextRange(next.length)), spans)
    }
}
