package nl.bvdm.rukoo.ui.agent

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A prompt-injected answer can nest quotes or emphasis thousands deep. The renderer stops recursing at its budgets
 * and shows the rest as text through flatText, which must handle any depth without recursion.
 */
class ChatMarkdownDepthTest {
    @Test
    fun deeplyNestedQuotesBecomeText() {
        val doc = parseMarkdown(">".repeat(5_000) + " deep")
        assertEquals("deep", flatText(doc))
    }

    @Test
    fun deeplyNestedEmphasisBecomesText() {
        val doc = parseMarkdown("*_".repeat(3_000) + "x" + "_*".repeat(3_000))
        assertTrue(flatText(doc).contains("x"))
    }

    @Test
    fun flatTextKeepsTheOrderAndTheLineBreaks() {
        val doc = parseMarkdown("> **One** and `two`\n>\n> - three\n> - four")
        assertEquals("One and two\nthree\nfour", flatText(doc))
    }

    @Test
    fun theBudgetsLeaveOrdinaryAnswersAlone() {
        assertTrue(MAX_BLOCK_NESTING >= 8)
        assertTrue(MAX_INLINE_NESTING >= 16)
    }
}
