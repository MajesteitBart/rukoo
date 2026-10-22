package nl.bvdm.rukoo.ui.agent

import org.commonmark.node.AbstractVisitor
import org.commonmark.node.BlockQuote
import org.commonmark.node.Emphasis
import org.commonmark.node.Link
import org.commonmark.node.Node
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A prompt-injected answer can nest quotes or emphasis thousands deep. Rukoo's own passes over the tree don't recurse
 * per level, the renderer stops recursing at its budgets, and nesting commonmark's parser can't take shows as text.
 */
class ChatMarkdownDepthTest {
    @Test
    fun deeplyNestedQuotesParseAndBecomeTextOnASmallStack() {
        val doc = onSmallStack { parseMarkdown(">".repeat(DEEP) + " deep") }
        assertTrue("the parser kept the quotes instead of falling back to plain text", doc.firstChild is BlockQuote)
        assertEquals("deep", onSmallStack { flatText(doc) })

        // A recursive walk of the same tree overflows this stack, as commonmark's autolink extension did while parsing.
        val walk = onSmallStack { runCatching { doc.accept(object : AbstractVisitor() {}) }.exceptionOrNull() }
        assertTrue(walk is StackOverflowError)
    }

    @Test
    fun deeplyNestedEmphasisBecomesTextOnASmallStack() {
        val doc = onStack(BIG_STACK) { parseMarkdown(DEEP_EMPHASIS) }
        var depth = 0
        var node = doc.firstChild?.firstChild
        while (node is Emphasis) {
            depth++
            node = node.lastChild
        }
        assertEquals(DEEP, depth)
        assertTrue(onSmallStack { flatText(doc) }.endsWith("a x"))
    }

    @Test
    fun nestingTheParserCannotTakeShowsAsPlainText() {
        // commonmark's inline parser merges text recursively, so this overflows a small stack inside the parser.
        val doc = onSmallStack { parseMarkdown(DEEP_EMPHASIS) }
        assertEquals(DEEP_EMPHASIS, flatText(doc))
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

    @Test
    fun bareUrlsAndEmailAddressesBecomeLinks() {
        val text = "Mail bart@example.com or see https://example.com/a?b=1."
        val doc = parseMarkdown(text)
        assertEquals(listOf("mailto:bart@example.com", "https://example.com/a?b=1"), destinations(doc))
        assertEquals(text, flatText(doc))
    }

    @Test
    fun addressesDeepInQuotesListsAndEmphasisAreLinkedToo() {
        assertEquals(listOf("https://e.example"), destinations(parseMarkdown("> - **see https://e.example**")))
    }

    @Test
    fun linksCodeAndBareWwwAddressesStayAsTheyAre() {
        // As with the extension: a link's text isn't linked again, code is code, and www. without a scheme is text.
        val doc = parseMarkdown("[https://a.example](https://b.example), `https://c.example` and www.d.example")
        assertEquals(listOf("https://b.example"), destinations(doc))
    }

    private fun destinations(doc: Node): List<String> {
        val out = ArrayList<String>()
        doc.accept(object : AbstractVisitor() {
            override fun visit(link: Link) {
                out += link.destination
                visitChildren(link)
            }
        })
        return out
    }

    /** Runs [block] on a thread with about the stack an ordinary thread gets on a phone. */
    private fun <T> onSmallStack(block: () -> T): T = onStack(SMALL_STACK, block)

    private fun <T> onStack(size: Long, block: () -> T): T {
        var result: Result<T>? = null
        val thread = Thread(null, { result = runCatching(block) }, "stack-$size", size)
        thread.start()
        thread.join()
        return result!!.getOrThrow()
    }

    private companion object {
        const val DEEP = 20_000
        const val SMALL_STACK = 256 * 1024L
        const val BIG_STACK = 64 * 1024 * 1024L

        // Each "*a " opens an emphasis inside the one before, and the run of asterisks at the end closes them all.
        val DEEP_EMPHASIS = "*a ".repeat(DEEP) + "x" + "*".repeat(DEEP)
    }
}
