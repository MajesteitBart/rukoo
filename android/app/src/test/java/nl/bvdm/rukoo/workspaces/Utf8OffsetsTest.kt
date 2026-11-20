package nl.bvdm.rukoo.workspaces

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Mentions between the composer's UTF-16 indices and the wire's UTF-8 bytes (contract §3.17), on the shared vectors. */
class Utf8OffsetsTest {
    private val vectors = ChatVectors.all

    private fun spans(c: ChatVectors.MentionCase) = c.utf16.map { MentionSpan(it.start, it.end, it.actor) }

    @Test
    fun `the vectors are there and cover what the contract lists`() {
        assertTrue("at least 12 mention cases", vectors.mentions.size >= 12)
        assertTrue("at least 8 bad mention cases", vectors.badMentions.size >= 8)
    }

    @Test
    fun `toWire gives every case's byte ranges`() {
        for (c in vectors.mentions) assertEquals(c.name, c.bytes, Utf8Offsets.toWire(c.text, spans(c)))
    }

    @Test
    fun `fromWire gives every case's UTF-16 ranges back`() {
        for (c in vectors.mentions) assertEquals(c.name, spans(c), Utf8Offsets.fromWire(c.text, c.bytes))
    }

    @Test
    fun `every good case breaks no rule`() {
        for (c in vectors.mentions) assertEquals(c.name, emptySet<String>(), Utf8Offsets.violations(c.text, c.bytes))
    }

    @Test
    fun `byte offsets agree with the UTF-8 encoder`() {
        for (c in vectors.mentions) {
            val offsets = Utf8Offsets.byteOffsets(c.text)
            assertEquals(c.name, c.text.toByteArray(Charsets.UTF_8).size, Utf8Offsets.utf8Length(c.text))
            for (i in 0..c.text.length) {
                val inPair = i in 1 until c.text.length && c.text[i - 1].isHighSurrogate() && c.text[i].isLowSurrogate()
                if (inPair) assertEquals("${c.name} at $i", -1, offsets[i])
                else assertEquals("${c.name} at $i", c.text.substring(0, i).toByteArray(Charsets.UTF_8).size, offsets[i])
            }
        }
    }

    @Test
    fun `every bad case breaks exactly the rule it names`() {
        for (c in vectors.badMentions) assertEquals(c.name, setOf(c.rule), Utf8Offsets.violations(c.text, c.bytes))
    }

    @Test
    fun `reading drops what a bad case gets wrong and keeps the rest`() {
        for (c in vectors.badMentions) {
            val kept = Utf8Offsets.fromWire(c.text, c.bytes)
            val expected = when (c.rule) {
                // The first comes first and stays; the later one starts before it, or inside it.
                Utf8Offsets.OUT_OF_ORDER, Utf8Offsets.OVERLAP -> 1
                Utf8Offsets.TOO_MANY -> MENTION_LIMIT
                else -> 0
            }
            assertEquals(c.name, expected, kept.size)
            // Whatever stays is valid on the wire again.
            assertTrue(c.name, Utf8Offsets.isValid(c.text, Utf8Offsets.toWire(c.text, kept)))
        }
    }

    @Test
    fun `toWire sorts, drops overlaps, splits and strangers, and caps at 32`() {
        val ann = "u_TSZouSPGbcL97eX33zpRL2"
        val bob = "u_1Sw3x5RkUNDzTu7h42PrUD"
        val text = "@Ann and @Bob 👍"
        val sorted = Utf8Offsets.toWire(text, listOf(MentionSpan(9, 13, bob), MentionSpan(0, 4, ann)))
        assertEquals(listOf(Mention(ann, 0, 4), Mention(bob, 9, 13)), sorted)
        assertEquals(listOf(Mention(ann, 0, 4)), Utf8Offsets.toWire(text, listOf(MentionSpan(0, 4, ann), MentionSpan(2, 6, bob))))
        // Index 15 lies between the halves of the emoji's surrogate pair.
        assertEquals(emptyList<Mention>(), Utf8Offsets.toWire(text, listOf(MentionSpan(14, 15, ann))))
        assertEquals(emptyList<Mention>(), Utf8Offsets.toWire(text, listOf(MentionSpan(0, 4, "u_short"))))
        assertEquals(emptyList<Mention>(), Utf8Offsets.toWire(text, listOf(MentionSpan(3, 3, ann), MentionSpan(0, 99, ann))))
        val many = (0 until 40).joinToString(" ") { "@a" }
        val spans = (0 until 40).map { MentionSpan(it * 3, it * 3 + 2, ann) }
        assertEquals(MENTION_LIMIT, Utf8Offsets.toWire(many, spans).size)
    }

    @Test
    fun `a lone surrogate counts as the three bytes of its replacement character`() {
        assertEquals(1 + 3 + 1, Utf8Offsets.utf8Length("a\uD83Db"))
    }

    @Test
    fun `text is well formed only when every surrogate has its other half`() {
        for (ok in listOf("", "plain", "é ✓", "a😀b", "😀😀")) assertTrue(ok, Utf8Offsets.isWellFormed(ok))
        for (bad in listOf("a\uD83Db", "\uDE00", "x\uD83D", "\uDE00\uD83D", "\uD83D😀")) assertFalse(bad, Utf8Offsets.isWellFormed(bad))
    }
}
