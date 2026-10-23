package nl.bvdm.rukoo.ui.composer

import nl.bvdm.rukoo.mail.compose.Block
import nl.bvdm.rukoo.mail.compose.Mark

/**
 * The editing rules of the formatted composer, as plain functions over text and offsets so tests reach them
 * without Android: Markdown shortcuts while typing, what Enter and Backspace do in lists and headings, and the
 * arithmetic of mark and paragraph ranges. RichEditText applies them to its spans.
 */
object RichEditing {
    /** The zero-width space that keeps an empty last list item visible (Android draws no bullet on an empty last line). */
    const val MARKER = '​'

    // ---------- Markdown shortcuts ----------

    /** A typed prefix at the start of a paragraph that turns it into [block]; the first [length] characters go. */
    data class BlockShortcut(val block: Block, val length: Int)

    /**
     * The block shortcut [before] makes, [before] being a plain paragraph's text from its start up to the cursor,
     * right after a space was typed: `- ` and `* ` start a bulleted list, `1. ` a numbered one, `# ` (up to three)
     * a heading.
     */
    fun blockShortcut(before: String): BlockShortcut? {
        val text = before.replace(MARKER.toString(), "")
        val lead = before.length - text.length
        return when (text) {
            "- ", "* " -> BlockShortcut(Block.BULLET, lead + 2)
            "1. " -> BlockShortcut(Block.NUMBER, lead + 3)
            "# " -> BlockShortcut(Block.HEADING, lead + 2)
            "## " -> BlockShortcut(Block.HEADING, lead + 3)
            "### " -> BlockShortcut(Block.HEADING, lead + 4)
            else -> null
        }
    }

    /**
     * An inline shortcut that just closed, offsets relative to the text it was found in: the opening delimiter at
     * [open] and the closing one at [close], each [width] long, around the text that gets [mark].
     */
    data class InlineShortcut(val mark: Mark, val open: Int, val close: Int, val width: Int) {
        val innerStart get() = open + width
        val innerEnd get() = close
    }

    // The closing delimiter is the last character typed. The opening one may not follow a letter or the same
    // delimiter, so 2*3*4, snake_case_names and the first star of a closing ** stay as they are.
    private val BOLD = Regex("(?<![*])\\*\\*([^*\\s](?:[^*\\n]*?[^*\\s])?)\\*\\*$")
    private val ITALIC_STAR = Regex("(?<![*\\p{L}\\p{N}])\\*([^*\\s](?:[^*\\n]*?[^*\\s])?)\\*$")
    private val ITALIC_UNDERSCORE = Regex("(?<![_\\p{L}\\p{N}])_([^_\\s](?:[^_\\n]*?[^_\\s])?)_$")
    private val STRIKE = Regex("(?<![~])~~([^~\\s](?:[^~\\n]*?[^~\\s])?)~~$")

    /**
     * The inline shortcut [before] ends with, [before] being the paragraph's text up to the cursor right after `*`,
     * `_` or `~` was typed: `**bold**`, `*italic*`, `_italic_` or `~~struck~~`.
     */
    fun inlineShortcut(before: String): InlineShortcut? {
        if (before.isEmpty()) return null
        val patterns = when (before.last()) {
            '*' -> listOf(BOLD to Mark.BOLD, ITALIC_STAR to Mark.ITALIC)
            '_' -> listOf(ITALIC_UNDERSCORE to Mark.ITALIC)
            '~' -> listOf(STRIKE to Mark.STRIKE)
            else -> return null
        }
        for ((re, mark) in patterns) {
            val m = re.find(before) ?: continue
            val width = if (mark == Mark.BOLD || mark == Mark.STRIKE) 2 else 1
            val inner = m.groups[1]!!.range
            return InlineShortcut(mark, inner.first - width, inner.last + 1, width)
        }
        return null
    }

    // ---------- Enter and Backspace ----------

    /** What Enter did in a paragraph: the list ended (the new line is taken back), or the new paragraph is [block]. */
    sealed interface Enter {
        data object EndList : Enter

        data class Next(val block: Block) : Enter
    }

    /**
     * Enter pressed in a paragraph of [block]. [wasEmpty]: the paragraph held no text; [restEmpty]: no text came
     * after the cursor, so the new paragraph starts empty. Enter continues a list and ends it on an empty item; a
     * heading continues only when Enter split it, so the line after a heading is text.
     */
    fun enter(block: Block, wasEmpty: Boolean, restEmpty: Boolean): Enter = when (block) {
        Block.BULLET, Block.NUMBER -> if (wasEmpty) Enter.EndList else Enter.Next(block)
        Block.HEADING -> Enter.Next(if (restEmpty) Block.TEXT else Block.HEADING)
        Block.TEXT -> Enter.Next(Block.TEXT)
    }

    /** Backspace at the start of a paragraph of [block] takes the bullet, number or heading off before joining lines. */
    fun backspaceRemovesBlock(block: Block): Boolean = block != Block.TEXT

    /** Whether [paragraph] holds no text: nothing but markers. */
    fun isEmptyParagraph(paragraph: CharSequence): Boolean = paragraph.all { it == MARKER }

    // ---------- marks ----------

    /** A range of characters. */
    data class Range(val start: Int, val end: Int)

    /**
     * Whether [ranges] reach every character of [text] between [start] and [end] that is not a line break or
     * marker: the selection is all bold, so Bold takes it off.
     */
    fun covered(text: CharSequence, ranges: List<Range>, start: Int, end: Int): Boolean {
        var any = false
        for (i in start until end) {
            val ch = text[i]
            if (ch == '\n' || ch == MARKER) continue
            any = true
            if (ranges.none { it.start <= i && i < it.end }) return false
        }
        return any
    }

    /** [ranges] with [start] until [end] added, overlapping and touching ranges merged. */
    fun add(ranges: List<Range>, start: Int, end: Int): List<Range> = merge(ranges + Range(start, end))

    /** [ranges] without [start] until [end]: ranges across it are cut in two. */
    fun remove(ranges: List<Range>, start: Int, end: Int): List<Range> {
        val out = ArrayList<Range>()
        for (r in ranges) {
            if (r.end <= start || r.start >= end) {
                out += r
                continue
            }
            if (r.start < start) out += Range(r.start, start)
            if (r.end > end) out += Range(end, r.end)
        }
        return merge(out)
    }

    /** Sorted, without empty ranges, overlapping and touching ones merged. */
    fun merge(ranges: List<Range>): List<Range> {
        val sorted = ranges.filter { it.end > it.start }.sortedBy { it.start }
        val out = ArrayList<Range>()
        for (r in sorted) {
            val last = out.lastOrNull()
            if (last != null && r.start <= last.end) out[out.size - 1] = Range(last.start, maxOf(last.end, r.end)) else out += r
        }
        return out
    }

    /** Whether text typed at [cursor] gets the mark: a range ends at or runs past it (the character before is marked). */
    fun activeAt(ranges: List<Range>, cursor: Int): Boolean = ranges.any { it.start < cursor && cursor <= it.end }

    // ---------- paragraphs ----------

    /** A paragraph span: [block] from [start] to [end]. */
    data class BlockRange(val start: Int, val end: Int, val block: Block)

    /**
     * The block of each paragraph of [text], from the paragraph spans as editing left them: a paragraph is what the
     * span over its first character says, or a span that shrank to nothing at its start (its text was deleted). Text
     * joined onto a paragraph takes that paragraph's block; text typed after a paragraph's line break doesn't.
     */
    fun paragraphBlocks(text: CharSequence, ranges: List<BlockRange>): List<Block> {
        val starts = paragraphStarts(text)
        val blocks = Array(starts.size) { Block.TEXT }
        val rank = LongArray(starts.size) { -1L }
        for (r in ranges) {
            if (r.block == Block.TEXT) continue
            // The first paragraph starting at or after r.start.
            var i = starts.binarySearch(r.start).let { if (it >= 0) it else -it - 1 }
            while (i < starts.size) {
                val s = starts[i]
                val hit = if (r.end > r.start) s >= r.start && s < r.end else s == r.start
                if (!hit) break
                // A span with text beats one that shrank to nothing; between those, the later start wins.
                val score = (if (r.end > r.start) 1L shl 32 else 0L) + r.start
                if (score > rank[i]) {
                    rank[i] = score
                    blocks[i] = r.block
                }
                i++
            }
        }
        return blocks.toList()
    }

    /** Starts of the paragraphs of [text]. */
    fun paragraphStarts(text: CharSequence): IntArray {
        var n = 1
        for (i in 0 until text.length) if (text[i] == '\n') n++
        val out = IntArray(n)
        var k = 1
        for (i in 0 until text.length) if (text[i] == '\n') out[k++] = i + 1
        return out
    }

    /** The number each numbered paragraph shows: consecutive numbered paragraphs count up from 1; others get 0. */
    fun numbers(blocks: List<Block>): IntArray {
        val out = IntArray(blocks.size)
        var n = 0
        for (i in blocks.indices) {
            n = if (blocks[i] == Block.NUMBER) n + 1 else 0
            out[i] = n
        }
        return out
    }

    /** Whether every paragraph from [first] to [last] is [block]: the button is on, and a tap turns it off. */
    fun allBlocks(blocks: List<Block>, first: Int, last: Int, block: Block): Boolean =
        (first..last).all { blocks.getOrNull(it) == block }
}
