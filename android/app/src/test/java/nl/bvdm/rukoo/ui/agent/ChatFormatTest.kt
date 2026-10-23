package nl.bvdm.rukoo.ui.agent

import java.time.LocalDateTime
import java.time.ZoneId
import java.util.Locale
import nl.bvdm.rukoo.mail.model.Address
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ChatFormatTest {
    @Test
    fun theStreamRevealsTwoCharactersATickOrCatchesUp() {
        assertEquals(2, ChatFormat.revealStep("Hello there", 0))
        assertEquals(11, ChatFormat.revealStep("Hello there", 10))
        assertEquals(11, ChatFormat.revealStep("Hello there", 11))
        // A big chunk: a 40th of the backlog per tick.
        assertEquals(25, ChatFormat.revealStep("x".repeat(1000), 0))
        // A surrogate pair is never split.
        val text = "ab😀cd"
        assertEquals(3, "ab\uD83D".length)
        assertEquals(4, ChatFormat.revealStep(text, 1))
    }

    @Test
    fun finishedBlocksEndAtTheLastBlankLineOutsideAFence() {
        val text = "First paragraph.\n\nSecond line\n"
        assertEquals(18, ChatFormat.settleCut(text, 0))
        assertEquals("First paragraph.\n\n", text.substring(0, 18))
        val fenced = "Intro\n\n```\ncode\n\nmore\n"
        // The blank line inside the open fence doesn't count.
        assertEquals(7, ChatFormat.settleCut(fenced, 0))
        // The last line can still grow.
        assertEquals(0, ChatFormat.settleCut("Only one line", 0))
    }

    @Test
    fun anOpenMarkerFormatsToTheEnd() {
        assertEquals("Some **bold**", ChatFormat.closeOpen("Some **bold"))
        assertEquals("Some ", ChatFormat.closeOpen("Some **"))
        assertEquals("Run `ls`", ChatFormat.closeOpen("Run `ls"))
        assertEquals("**done** and `x`", ChatFormat.closeOpen("**done** and `x`"))
    }

    @Test
    fun linksAreLimitedToSafeSchemes() {
        assertTrue(ChatFormat.safeLink("https://example.com"))
        assertTrue(ChatFormat.safeLink("mailto:sanne@example.com"))
        assertFalse(ChatFormat.safeLink("javascript:alert(1)"))
        assertFalse(ChatFormat.safeLink("file:///etc/passwd"))
        assertFalse(ChatFormat.safeLink("obsidian://open?vault=x"))
        assertTrue(ChatFormat.openableLink("obsidian://open?vault=x"))
        assertFalse(ChatFormat.openableLink("intent://evil"))
    }

    @Test
    fun timesAndCounts() {
        assertEquals(1, ChatFormat.seconds(1000, 1200))
        assertEquals(4, ChatFormat.seconds(0, 4400))
        assertEquals("0.0s", ChatFormat.elapsed(0))
        assertEquals("12.3s", ChatFormat.elapsed(12_340))
        assertEquals("1m 3.2s", ChatFormat.elapsed(63_200))
    }

    @Test
    fun hostsPeopleAndPreviews() {
        assertEquals("example.com", ChatFormat.hostOf("https://www.example.com/crm/deal"))
        assertEquals("obsidian", ChatFormat.hostOf("obsidian://open?vault=Personal"))
        assertEquals("Sanne de Vries, joris@example.com", ChatFormat.people(listOf(Address("Sanne de Vries", "sanne@example.com"), Address("", "joris@example.com"))))
        assertEquals("Three emails need you", ChatFormat.plainPreview("1. **Three** emails need `you`"))
        assertEquals("Heading", ChatFormat.plainPreview("## Heading"))
    }

    @Test
    fun listTimeIsTheTimeTodayAndTheDateOtherwise() {
        val zone = ZoneId.of("Europe/Amsterdam")
        fun ms(y: Int, mo: Int, d: Int, h: Int, mi: Int) = LocalDateTime.of(y, mo, d, h, mi).atZone(zone).toInstant().toEpochMilli()
        val now = ms(2026, 10, 22, 15, 0)
        assertEquals("09:05", ChatFormat.listTime(ms(2026, 10, 22, 9, 5), now, Locale.forLanguageTag("en-GB"), zone))
        assertEquals("8 Oct", ChatFormat.listTime(ms(2026, 10, 8, 9, 5), now, Locale.forLanguageTag("en-GB"), zone))
        assertEquals("08/10/2025", ChatFormat.listTime(ms(2025, 10, 8, 9, 5), now, Locale.forLanguageTag("en-GB"), zone))
        assertEquals("8 okt", ChatFormat.listTime(ms(2026, 10, 8, 9, 5), now, Locale.forLanguageTag("nl-NL"), zone))
    }
}
