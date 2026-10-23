package nl.bvdm.rukoo.ui.composer

import nl.bvdm.rukoo.mail.compose.Block
import nl.bvdm.rukoo.mail.compose.Mark
import nl.bvdm.rukoo.ui.composer.RichEditing.BlockRange
import nl.bvdm.rukoo.ui.composer.RichEditing.BlockShortcut
import nl.bvdm.rukoo.ui.composer.RichEditing.Enter
import nl.bvdm.rukoo.ui.composer.RichEditing.InlineShortcut
import nl.bvdm.rukoo.ui.composer.RichEditing.MARKER
import nl.bvdm.rukoo.ui.composer.RichEditing.Range
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RichEditingTest {
    @Test
    fun `a typed prefix at the start of a line starts a list or heading`() {
        assertEquals(BlockShortcut(Block.BULLET, 2), RichEditing.blockShortcut("- "))
        assertEquals(BlockShortcut(Block.BULLET, 2), RichEditing.blockShortcut("* "))
        assertEquals(BlockShortcut(Block.NUMBER, 3), RichEditing.blockShortcut("1. "))
        assertEquals(BlockShortcut(Block.HEADING, 2), RichEditing.blockShortcut("# "))
        assertEquals(BlockShortcut(Block.HEADING, 3), RichEditing.blockShortcut("## "))
        // A marker left in an empty line goes with the prefix.
        assertEquals(BlockShortcut(Block.BULLET, 3), RichEditing.blockShortcut("$MARKER- "))
        // Only the whole line up to the cursor counts: no shortcut mid-sentence, after other text or for other numbers.
        assertNull(RichEditing.blockShortcut("a - "))
        assertNull(RichEditing.blockShortcut("2. "))
        assertNull(RichEditing.blockShortcut("2020. "))
        assertNull(RichEditing.blockShortcut("#### "))
        assertNull(RichEditing.blockShortcut("-"))
        assertNull(RichEditing.blockShortcut("#hashtag "))
    }

    @Test
    fun `closing delimiters make bold, italic and strikethrough`() {
        assertEquals(InlineShortcut(Mark.BOLD, 4, 15, 2), RichEditing.inlineShortcut("say **very much**"))
        assertEquals(InlineShortcut(Mark.ITALIC, 0, 5, 1), RichEditing.inlineShortcut("*soon*"))
        assertEquals(InlineShortcut(Mark.ITALIC, 3, 9, 1), RichEditing.inlineShortcut("so _truly_"))
        assertEquals(InlineShortcut(Mark.STRIKE, 0, 6, 2), RichEditing.inlineShortcut("~~gone~~"))
        val bold = RichEditing.inlineShortcut("say **very much**")!!
        assertEquals("very much", "say **very much**".substring(bold.innerStart, bold.innerEnd))
        // The first star of a closing ** is not an italic.
        assertNull(RichEditing.inlineShortcut("**bold*"))
        // Arithmetic, snake_case and delimiters around spaces stay as typed.
        assertNull(RichEditing.inlineShortcut("2*3*"))
        assertNull(RichEditing.inlineShortcut("snake_case_"))
        assertNull(RichEditing.inlineShortcut("* not *"))
        assertNull(RichEditing.inlineShortcut("**"))
        assertNull(RichEditing.inlineShortcut("a*"))
        assertNull(RichEditing.inlineShortcut("plain text"))
        // The nearest opening delimiter wins.
        assertEquals(InlineShortcut(Mark.BOLD, 10, 13, 2), RichEditing.inlineShortcut("**a** and **b**"))
    }

    @Test
    fun `enter continues lists, ends them on an empty item, and leaves a heading`() {
        assertEquals(Enter.Next(Block.BULLET), RichEditing.enter(Block.BULLET, wasEmpty = false, restEmpty = true))
        assertEquals(Enter.Next(Block.NUMBER), RichEditing.enter(Block.NUMBER, wasEmpty = false, restEmpty = false))
        assertEquals(Enter.EndList, RichEditing.enter(Block.BULLET, wasEmpty = true, restEmpty = true))
        assertEquals(Enter.EndList, RichEditing.enter(Block.NUMBER, wasEmpty = true, restEmpty = true))
        assertEquals(Enter.Next(Block.TEXT), RichEditing.enter(Block.HEADING, wasEmpty = false, restEmpty = true))
        assertEquals(Enter.Next(Block.HEADING), RichEditing.enter(Block.HEADING, wasEmpty = false, restEmpty = false))
        assertEquals(Enter.Next(Block.TEXT), RichEditing.enter(Block.TEXT, wasEmpty = true, restEmpty = true))
        assertTrue(RichEditing.isEmptyParagraph(""))
        assertTrue(RichEditing.isEmptyParagraph("$MARKER"))
        assertFalse(RichEditing.isEmptyParagraph(" "))
    }

    @Test
    fun `backspace at the start of a formatted paragraph takes the format off first`() {
        assertTrue(RichEditing.backspaceRemovesBlock(Block.BULLET))
        assertTrue(RichEditing.backspaceRemovesBlock(Block.NUMBER))
        assertTrue(RichEditing.backspaceRemovesBlock(Block.HEADING))
        assertFalse(RichEditing.backspaceRemovesBlock(Block.TEXT))
    }

    @Test
    fun `marks are added, cut and merged`() {
        val ranges = listOf(Range(0, 4), Range(10, 14))
        assertEquals(listOf(Range(0, 14)), RichEditing.add(ranges, 3, 11))
        assertEquals(listOf(Range(0, 4), Range(6, 8), Range(10, 14)), RichEditing.add(ranges, 6, 8))
        // Touching ranges become one, so the html gets one tag.
        assertEquals(listOf(Range(0, 6)), RichEditing.add(listOf(Range(0, 4)), 4, 6))
        assertEquals(listOf(Range(0, 2), Range(3, 4), Range(10, 14)), RichEditing.remove(ranges, 2, 3))
        assertEquals(listOf(Range(10, 14)), RichEditing.remove(ranges, 0, 4))
        assertEquals(listOf(Range(0, 3), Range(12, 14)), RichEditing.remove(ranges, 3, 12))
        assertEquals(emptyList<Range>(), RichEditing.merge(listOf(Range(3, 3))))
    }

    @Test
    fun `a selection is covered when every character but line breaks has the mark`() {
        val text = "bold\nbold"
        assertTrue(RichEditing.covered(text, listOf(Range(0, 4), Range(5, 9)), 0, 9))
        assertFalse(RichEditing.covered(text, listOf(Range(0, 4)), 0, 9))
        assertFalse(RichEditing.covered(text, listOf(Range(0, 4)), 4, 5))
        assertTrue(RichEditing.covered("a${MARKER}b", listOf(Range(0, 1), Range(2, 3)), 0, 3))
    }

    @Test
    fun `typing at the end of a mark continues it, at its start it doesn't`() {
        val bold = listOf(Range(4, 8))
        assertTrue(RichEditing.activeAt(bold, 8))
        assertTrue(RichEditing.activeAt(bold, 6))
        assertFalse(RichEditing.activeAt(bold, 4))
        assertFalse(RichEditing.activeAt(bold, 9))
        assertFalse(RichEditing.activeAt(emptyList(), 0))
    }

    @Test
    fun `paragraph blocks follow the spans as editing left them`() {
        // "a\nb\nc": a bullet span over the first two paragraphs after Enter split one item.
        assertEquals(listOf(Block.BULLET, Block.BULLET, Block.TEXT), RichEditing.paragraphBlocks("a\nb\nc", listOf(BlockRange(0, 4, Block.BULLET))))
        // Text typed at the start of the paragraph after an item doesn't join the list: the span ends before it.
        assertEquals(listOf(Block.BULLET, Block.TEXT), RichEditing.paragraphBlocks("a\nxc", listOf(BlockRange(0, 2, Block.BULLET))))
        // A line joined onto an item by Backspace takes the item's block.
        assertEquals(listOf(Block.BULLET), RichEditing.paragraphBlocks("ac", listOf(BlockRange(0, 1, Block.BULLET))))
        // An item whose text was deleted keeps its bullet through the empty span at its start.
        assertEquals(listOf(Block.TEXT, Block.NUMBER), RichEditing.paragraphBlocks("a\n", listOf(BlockRange(2, 2, Block.NUMBER))))
        // A span with text wins over one that shrank to nothing at the same place.
        assertEquals(
            listOf(Block.HEADING),
            RichEditing.paragraphBlocks("x", listOf(BlockRange(0, 0, Block.BULLET), BlockRange(0, 1, Block.HEADING))),
        )
        assertArrayEquals(intArrayOf(0, 2, 4), RichEditing.paragraphStarts("a\nb\nc"))
    }

    @Test
    fun `numbered paragraphs count up and start again after other text`() {
        assertArrayEquals(
            intArrayOf(1, 2, 0, 1, 0, 1),
            RichEditing.numbers(listOf(Block.NUMBER, Block.NUMBER, Block.TEXT, Block.NUMBER, Block.BULLET, Block.NUMBER)),
        )
        assertTrue(RichEditing.allBlocks(listOf(Block.BULLET, Block.BULLET, Block.TEXT), 0, 1, Block.BULLET))
        assertFalse(RichEditing.allBlocks(listOf(Block.BULLET, Block.BULLET, Block.TEXT), 0, 2, Block.BULLET))
    }
}
