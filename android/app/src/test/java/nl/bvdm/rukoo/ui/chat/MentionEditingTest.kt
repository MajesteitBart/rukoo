package nl.bvdm.rukoo.ui.chat

import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.TextFieldValue
import nl.bvdm.rukoo.workspaces.Draft
import nl.bvdm.rukoo.workspaces.Member
import nl.bvdm.rukoo.workspaces.Mention
import nl.bvdm.rukoo.workspaces.MentionSpan
import nl.bvdm.rukoo.workspaces.TEXT_BYTES
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Editing text with mentions (android.md "Composer with mentions", contract §3.16, §3.17): finding the mention being
 * typed, picking one, keeping spans in place while the text changes around them, and the wire form at send.
 */
class MentionEditingTest {
    private fun u(name: String) = "u_" + name.padEnd(22, 'x')

    private val zoe = Member(u("zoe"), name = "Zoë de Vries", role = "member", state = "active")
    private val ann = Member(u("ann"), name = "Ann", role = "member", state = "active")

    private fun value(text: String, caret: Int = text.length, spans: List<MentionSpan> = emptyList()) =
        ComposerValue(TextFieldValue(text, TextRange(caret)), spans)

    /** Types [typed] at the caret, as the field reports it: the new text with the caret after it. */
    private fun ComposerValue.type(typed: String): ComposerValue {
        val at = field.selection.start
        val text = this.text.substring(0, at) + typed + this.text.substring(at)
        return MentionEditing.edited(this, TextFieldValue(text, TextRange(at + typed.length)))
    }

    /** Backspace at the caret. */
    private fun ComposerValue.backspace(): ComposerValue {
        val at = field.selection.start
        val text = this.text.removeRange(at - 1, at)
        return MentionEditing.edited(this, TextFieldValue(text, TextRange(at - 1)))
    }

    /** Delete after the caret. */
    private fun ComposerValue.delete(): ComposerValue {
        val at = field.selection.start
        val text = this.text.removeRange(at, at + 1)
        return MentionEditing.edited(this, TextFieldValue(text, TextRange(at)))
    }

    private fun ComposerValue.caret(at: Int) = copy(field = field.copy(selection = TextRange(at)))

    // ---- the mention being typed (mention-match.js mentionToken) ----

    @Test
    fun `an @ at the start of a word opens a mention with what follows it`() {
        assertEquals(MentionToken(0, 3, "zo"), MentionEditing.token("@zo", 3))
        assertEquals(MentionToken(6, 9, "zo"), MentionEditing.token("Hello @zo", 9))
        assertEquals(MentionToken(1, 4, "zo"), MentionEditing.token("(@zo", 4))
        assertEquals(MentionToken(2, 3, ""), MentionEditing.token("a @", 3))
        assertEquals(MentionToken(6, 15, "Zoë de V"), MentionEditing.token("Hello @Zoë de V", 15))
        // At the start of a later line.
        assertEquals(MentionToken(3, 6, "an"), MentionEditing.token("hi\n@an", 6))
    }

    @Test
    fun `an email address, a space after the @, two spaces, a line break or a long text is no mention`() {
        assertNull(MentionEditing.token("mail sanne@example", 18))
        assertNull(MentionEditing.token("@ zo", 4))
        assertNull(MentionEditing.token("@zoe  de", 8))
        assertNull(MentionEditing.token("@zoe\nde", 7))
        assertNull(MentionEditing.token("@" + "x".repeat(41), 42))
        assertNull(MentionEditing.token("no at sign", 10))
        assertNull(MentionEditing.token("@zo", 0))
        // The caret before the @.
        assertNull(MentionEditing.token("hi @zo", 3))
    }

    @Test
    fun `a picked mention is a unit of its own for the next one`() {
        val spans = listOf(MentionSpan(0, 4, ann.id))
        // Right after picking: "@Ann " doesn't reopen the picker for "Ann ".
        assertNull(MentionEditing.token("@Ann ", 5, spans))
        assertNull(MentionEditing.token("@Ann", 4, spans))
        // Inside it neither.
        assertNull(MentionEditing.token("@Ann", 2, spans))
        // A new @ after it does.
        assertEquals(MentionToken(5, 8, "zo"), MentionEditing.token("@Ann @zo", 8, spans))
        // An @ glued to the mention is like one after a letter.
        assertNull(MentionEditing.token("@Ann@zo", 7, spans))
    }

    // ---- picking ----

    @Test
    fun `picking puts in @Name and a space as one mention, with the caret after the space`() {
        val typed = value("Hi @zo")
        val token = MentionEditing.token(typed.text, 6)!!
        val picked = MentionEditing.insert(typed, token, zoe)
        assertEquals("Hi @Zoë de Vries ", picked.text)
        assertEquals(listOf(MentionSpan(3, 16, zoe.id)), picked.spans)
        assertEquals(TextRange(17), picked.field.selection)
    }

    @Test
    fun `picking before text keeps one space and moves the mentions after it`() {
        val start = value("@an then @Zoë de Vries ok", caret = 3, spans = listOf(MentionSpan(9, 22, zoe.id)))
        val picked = MentionEditing.insert(start, MentionEditing.token(start.text, 3, start.spans)!!, ann)
        assertEquals("@Ann then @Zoë de Vries ok", picked.text)
        assertEquals(listOf(MentionSpan(0, 4, ann.id), MentionSpan(10, 23, zoe.id)), picked.spans)
        assertEquals(TextRange(5), picked.field.selection)
    }

    // ---- editing around mentions ----

    @Test
    fun `typing before a mention moves it, typing after it leaves it`() {
        val v = value("@Ann hi", caret = 0, spans = listOf(MentionSpan(0, 4, ann.id)))
        assertEquals(listOf(MentionSpan(3, 7, ann.id)), v.type("Yo ").spans)
        // An @ typed right before "@Ann" is a new character before it, not inside it.
        assertEquals(listOf(MentionSpan(1, 5, ann.id)), v.type("@").spans)
        val end = v.caret(4)
        assertEquals(listOf(MentionSpan(0, 4, ann.id)), end.type("n").spans)
        assertEquals("@Annn hi", end.type("n").text)
        assertEquals(listOf(MentionSpan(0, 4, ann.id)), v.caret(7).type("!").spans)
    }

    @Test
    fun `typing inside a mention leaves its text and drops the mention`() {
        val v = value("@Ann hi", caret = 2, spans = listOf(MentionSpan(0, 4, ann.id)))
        val edited = v.type("x")
        assertEquals("@Axnn hi", edited.text)
        assertTrue(edited.spans.isEmpty())
    }

    @Test
    fun `Backspace at the end of a mention or Delete at its start removes it whole`() {
        val v = value("Hi @Ann ok", spans = listOf(MentionSpan(3, 7, ann.id), MentionSpan(8, 10, u("ok"))))
        val back = v.caret(7).backspace()
        assertEquals("Hi  ok", back.text)
        assertEquals(TextRange(3), back.field.selection)
        assertEquals(listOf(MentionSpan(4, 6, u("ok"))), back.spans)
        val del = v.caret(3).delete()
        assertEquals("Hi  ok", del.text)
        assertEquals(listOf(MentionSpan(4, 6, u("ok"))), del.spans)
    }

    @Test
    fun `Backspace in the middle of a mention leaves the rest as plain text`() {
        val v = value("@Ann", caret = 2, spans = listOf(MentionSpan(0, 4, ann.id)))
        val edited = v.backspace()
        assertEquals("@nn", edited.text)
        assertTrue(edited.spans.isEmpty())
    }

    @Test
    fun `a replaced selection drops the mentions it covers and moves the rest`() {
        val v = ComposerValue(
            TextFieldValue("@Ann and @Zoë de Vries", TextRange(0, 8)),
            listOf(MentionSpan(0, 4, ann.id), MentionSpan(9, 22, zoe.id)),
        )
        val edited = MentionEditing.edited(v, TextFieldValue("Hey @Zoë de Vries", TextRange(3)))
        assertEquals(listOf(MentionSpan(4, 17, zoe.id)), edited.spans)
    }

    @Test
    fun `a change of selection alone keeps everything`() {
        val v = value("@Ann", spans = listOf(MentionSpan(0, 4, ann.id)))
        val moved = MentionEditing.edited(v, TextFieldValue("@Ann", TextRange(1)))
        assertEquals(v.spans, moved.spans)
        assertEquals(TextRange(1), moved.field.selection)
    }

    // ---- the wire form ----

    @Test
    fun `a mention of a name with a diaeresis goes out in UTF-8 bytes`() {
        val typed = value("Hi @zo")
        val picked = MentionEditing.insert(typed, MentionEditing.token(typed.text, 6)!!, zoe)
        val wire = MentionEditing.wire(picked)
        // Trimmed before counting: the space after the mention goes.
        assertEquals("Hi @Zoë de Vries", wire.text)
        // "Hi " is 3 bytes; "@Zoë de Vries" is 14, because ë takes two.
        assertEquals(listOf(Mention(zoe.id, 3, 17)), wire.mentions)
        assertEquals(17, wire.bytes)
        assertTrue(wire.canSend)
    }

    @Test
    fun `leading white space moves the mentions before any offset is counted`() {
        val v = value("  \n @Ann 😀 hi  ", spans = listOf(MentionSpan(4, 8, ann.id)))
        val wire = MentionEditing.wire(v)
        assertEquals("@Ann 😀 hi", wire.text)
        assertEquals(listOf(Mention(ann.id, 0, 4)), wire.mentions)
        // A mention after an emoji: the emoji is four bytes and two UTF-16 units.
        val after = MentionEditing.wire(value("😀 @Ann", spans = listOf(MentionSpan(3, 7, ann.id))))
        assertEquals(listOf(Mention(ann.id, 5, 9)), after.mentions)
    }

    @Test
    fun `blank text, too many bytes or more than 32 mentions can't be sent`() {
        assertFalse(MentionEditing.wire(value("  \n ")).canSend)
        val long = MentionEditing.wire(value("ë".repeat(TEXT_BYTES / 2) + "x"))
        assertTrue(long.tooLong)
        assertFalse(long.canSend)
        assertTrue(MentionEditing.wire(value("ë".repeat(TEXT_BYTES / 2))).canSend)
        val many = (0 until 33).map { "@P$it" }
        var text = ""
        val spans = ArrayList<MentionSpan>()
        for ((i, m) in many.withIndex()) {
            if (text.isNotEmpty()) text += " "
            spans += MentionSpan(text.length, text.length + m.length, u("p$i"))
            text += m
        }
        val wire = MentionEditing.wire(value(text, spans = spans))
        assertTrue(wire.tooManyMentions)
        assertFalse(wire.canSend)
        assertFalse(MentionEditing.wire(value(text, spans = spans.dropLast(1))).tooManyMentions)
    }

    @Test
    fun `typing @Name by hand mentions nobody`() {
        val wire = MentionEditing.wire(value("@Ann hi"))
        assertTrue(wire.mentions.isEmpty())
    }

    // ---- drafts ----

    @Test
    fun `a draft keeps the exact text with byte offsets and comes back with its mentions`() {
        val v = value(" Hi @Zoë de Vries ", spans = listOf(MentionSpan(4, 17, zoe.id)))
        val draft = MentionEditing.toDraft(v)!!
        assertEquals(" Hi @Zoë de Vries ", draft.text)
        assertEquals(listOf(Mention(zoe.id, 4, 18)), draft.mentions)
        val back = MentionEditing.fromDraft(draft)
        assertEquals(v.text, back.text)
        assertEquals(v.spans, back.spans)
        assertEquals(TextRange(draft.text.length), back.field.selection)
        assertNull(MentionEditing.toDraft(value("")))
        assertEquals(ComposerValue(), MentionEditing.fromDraft(null))
        // A range that no longer fits the text shows plain.
        assertTrue(MentionEditing.fromDraft(Draft("Hi", listOf(Mention(zoe.id, 1, 9)))).spans.isEmpty())
    }

    @Test
    fun `a discarded message comes back after what the composer holds, on a new line`() {
        val restored = MentionEditing.append(value("draft"), "@Ann hi", listOf(Mention(ann.id, 0, 4)))
        assertEquals("draft\n@Ann hi", restored.text)
        assertEquals(listOf(MentionSpan(6, 10, ann.id)), restored.spans)
        assertEquals("@Ann hi", MentionEditing.append(ComposerValue(), "@Ann hi", emptyList()).text)
    }
}
