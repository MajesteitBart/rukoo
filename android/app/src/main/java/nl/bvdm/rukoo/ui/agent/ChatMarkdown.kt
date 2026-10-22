// Ported from dudan's ui/components/Markdown.kt (MIT, same author), without OpenUI, in Rukoo's style and with
// desktop bui.js's rules: links only for http, https and mailto, headings as bold lines, single line breaks kept.
package nl.bvdm.rukoo.ui.agent

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.InlineTextContent
import androidx.compose.foundation.text.appendInlineContent
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.Placeholder
import androidx.compose.ui.text.PlaceholderVerticalAlign
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import nl.bvdm.rukoo.ui.theme.Rk
import nl.bvdm.rukoo.ui.theme.RukooColors
import nl.bvdm.rukoo.ui.theme.RukooMono
import nl.bvdm.rukoo.ui.theme.RukooWeights
import nl.bvdm.rukoo.ui.theme.lineHeight
import org.commonmark.ext.autolink.AutolinkExtension
import org.commonmark.ext.gfm.strikethrough.Strikethrough
import org.commonmark.ext.gfm.strikethrough.StrikethroughExtension
import org.commonmark.ext.gfm.tables.TableBlock
import org.commonmark.ext.gfm.tables.TableCell
import org.commonmark.ext.gfm.tables.TableHead
import org.commonmark.ext.gfm.tables.TablesExtension
import org.commonmark.node.BlockQuote
import org.commonmark.node.BulletList
import org.commonmark.node.Code
import org.commonmark.node.Document
import org.commonmark.node.Emphasis
import org.commonmark.node.FencedCodeBlock
import org.commonmark.node.HardLineBreak
import org.commonmark.node.Heading
import org.commonmark.node.HtmlBlock
import org.commonmark.node.HtmlInline
import org.commonmark.node.Image
import org.commonmark.node.IndentedCodeBlock
import org.commonmark.node.Link
import org.commonmark.node.ListItem
import org.commonmark.node.Node
import org.commonmark.node.OrderedList
import org.commonmark.node.Paragraph
import org.commonmark.node.SoftLineBreak
import org.commonmark.node.StrongEmphasis
import org.commonmark.node.ThematicBreak
import org.commonmark.parser.Parser
import org.commonmark.node.Text as MdText

private val parser: Parser = Parser.builder()
    .extensions(listOf(TablesExtension.create(), StrikethroughExtension.create(), AutolinkExtension.create()))
    .build()

/** Parses agent Markdown. HTML stays text: the renderer shows it literally and never interprets it. */
fun parseMarkdown(text: String): Document = parser.parse(text) as Document

private fun Node.children(): List<Node> = generateSequence(firstChild) { it.next }.toList()

private const val CARET = "caret"

/** How markdown text looks in the chat: the body style and color, and where links go. */
@Immutable
private class MdStyle(val text: TextStyle, val color: Color, val colors: RukooColors, val onLink: (String) -> Unit)

/**
 * Agent Markdown as Compose text (bui.js blocks): paragraphs with their line breaks, bold, italic, strikethrough,
 * inline and fenced code, lists, headings as bold lines, quotes, rules, tables and links. [caret] puts the 2dp
 * streaming caret after the last character. Every piece of text goes in as text; nothing is rendered as HTML.
 */
@Composable
fun AgentMarkdown(
    document: Document,
    modifier: Modifier = Modifier,
    style: TextStyle = Rk.type.panelProse,
    color: Color = Rk.colors.ink,
    caret: Boolean = false,
    onLink: (String) -> Unit,
) {
    val c = Rk.colors
    val md = remember(style, color, c, onLink) { MdStyle(style, color, c, onLink) }
    val blocks = document.children()
    Column(modifier, verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (blocks.isEmpty() && caret) InlineBlock(AnnotatedString(""), md, caret = true)
        blocks.forEachIndexed { i, node -> Block(node, md, caret && i == blocks.lastIndex, depth = 0) }
    }
}

@Composable
private fun Block(node: Node, md: MdStyle, caret: Boolean, depth: Int) {
    val c = md.colors
    when (node) {
        is Paragraph -> InlineBlock(inline(node, md), md, caret)
        // Desktop shows headings as bold lines, not as large titles: a chat answer stays a chat answer.
        is Heading -> InlineBlock(inline(node, md), md, caret, md.text.copy(fontWeight = RukooWeights.Semibold))
        is BulletList -> ListBlock(node, ordered = false, start = 1, md, caret, depth)
        is OrderedList -> ListBlock(node, ordered = true, start = node.markerStartNumber ?: 1, md, caret, depth)
        is FencedCodeBlock -> CodeBlock(node.literal.trimEnd('\n'), md, caret)
        is IndentedCodeBlock -> CodeBlock(node.literal.trimEnd('\n'), md, caret)
        is BlockQuote -> Row(Modifier.height(IntrinsicSize.Min)) {
            Box(Modifier.width(2.dp).fillMaxHeight().background(c.lineStrong))
            val inner = node.children()
            val quoted = MdStyle(md.text, c.ink2, c, md.onLink)
            Column(Modifier.padding(start = 10.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                inner.forEachIndexed { i, child -> Block(child, quoted, caret && i == inner.lastIndex, depth) }
            }
        }
        is ThematicBreak -> Box(Modifier.fillMaxWidth().padding(vertical = 4.dp).height(1.dp).background(c.line))
        is TableBlock -> TableView(node, md)
        is HtmlBlock -> InlineBlock(AnnotatedString(node.literal.trimEnd()), md, caret)
        else -> {
            val inner = node.children()
            inner.forEachIndexed { i, child -> Block(child, md, caret && i == inner.lastIndex, depth) }
        }
    }
}

@Composable
private fun InlineBlock(text: AnnotatedString, md: MdStyle, caret: Boolean, style: TextStyle = md.text) {
    if (!caret) {
        Text(text, style = style, color = md.color)
        return
    }
    val withCaret = buildAnnotatedString {
        append(text)
        appendInlineContent(CARET, "​")
    }
    val content = remember(md.colors.ink) {
        mapOf(
            CARET to InlineTextContent(Placeholder(0.16.em, 1.05.em, PlaceholderVerticalAlign.TextCenter)) {
                // A solid 2dp bar while text arrives; it goes away when the answer is complete (SKILL.md).
                Box(Modifier.width(2.dp).fillMaxHeight().background(md.colors.ink))
            },
        )
    }
    Text(withCaret, style = style, color = md.color, inlineContent = content)
}

@Composable
private fun ListBlock(node: Node, ordered: Boolean, start: Int, md: MdStyle, caret: Boolean, depth: Int) {
    val items = node.children().filterIsInstance<ListItem>()
    Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
        items.forEachIndexed { index, item ->
            Row {
                val marker = when {
                    ordered -> "${start + index}."
                    depth == 0 -> "•"
                    else -> "◦"
                }
                Text(marker, style = md.text, color = md.colors.ink3, modifier = Modifier.widthIn(min = 20.dp).padding(end = 4.dp))
                val inner = item.children()
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    inner.forEachIndexed { i, child ->
                        Block(child, md, caret && index == items.lastIndex && i == inner.lastIndex, depth + 1)
                    }
                }
            }
        }
    }
}

/** A fenced block: mono 11.5 on `raised` with a hairline (it sits on the chat canvas), scrolling sideways. */
@Composable
private fun CodeBlock(code: String, md: MdStyle, caret: Boolean) {
    val c = md.colors
    val shape = RoundedCornerShape(8.dp)
    Box(
        Modifier
            .fillMaxWidth()
            .background(c.raised, shape)
            .border(1.dp, c.line, shape)
            .horizontalScroll(rememberScrollState())
            .padding(horizontal = 10.dp, vertical = 8.dp),
    ) {
        val style = Rk.type.mono.lineHeight(1.55f)
        InlineBlock(AnnotatedString(code), MdStyle(style, c.ink, c, md.onLink), caret, style)
    }
}

private fun inline(node: Node, md: MdStyle): AnnotatedString = buildAnnotatedString { appendChildren(node, md) }

private fun AnnotatedString.Builder.appendChildren(parent: Node, md: MdStyle) {
    var child = parent.firstChild
    while (child != null) {
        appendInline(child, md)
        child = child.next
    }
}

private fun AnnotatedString.Builder.appendLink(url: String, md: MdStyle, body: AnnotatedString.Builder.() -> Unit) {
    if (!ChatFormat.safeLink(url)) {
        body()
        return
    }
    val styles = TextLinkStyles(SpanStyle(color = md.colors.accentInk, textDecoration = TextDecoration.Underline))
    withLink(LinkAnnotation.Url(url, styles) { md.onLink(url) }) { body() }
}

private fun AnnotatedString.Builder.appendInline(node: Node, md: MdStyle) {
    when (node) {
        is MdText -> append(node.literal)
        is Emphasis -> withStyle(SpanStyle(fontStyle = FontStyle.Italic)) { appendChildren(node, md) }
        is StrongEmphasis -> withStyle(SpanStyle(fontWeight = RukooWeights.Semibold)) { appendChildren(node, md) }
        is Strikethrough -> withStyle(SpanStyle(textDecoration = TextDecoration.LineThrough)) { appendChildren(node, md) }
        is Code -> withStyle(SpanStyle(fontFamily = RukooMono, fontSize = 0.88.em, background = md.colors.raised)) { append(node.literal) }
        is Link -> appendLink(node.destination, md) { if (node.firstChild != null) appendChildren(node, md) else append(node.destination) }
        // Rukoo never loads images from agent text: the alt text stands in, as a link when it is a safe one.
        is Image -> appendLink(node.destination, md) { if (node.firstChild != null) appendChildren(node, md) else append(node.destination) }
        // Desktop keeps a single line break as a line break: agents write lists of lines that way.
        is SoftLineBreak -> append("\n")
        is HardLineBreak -> append("\n")
        is HtmlInline -> append(node.literal)
        else -> appendChildren(node, md)
    }
}

private class TableRowData(val header: Boolean, val cells: List<AnnotatedString>)

@Composable
private fun TableView(node: TableBlock, md: MdStyle) {
    val c = md.colors
    val rows = remember(node, md) {
        node.children().flatMap { section ->
            section.children().map { row -> TableRowData(section is TableHead, row.children().filterIsInstance<TableCell>().map { inline(it, md) }) }
        }
    }
    val columns = rows.maxOfOrNull { it.cells.size } ?: 0
    if (rows.isEmpty() || columns == 0) return
    val cellStyle = Rk.type.text12_5.lineHeight(1.5f)
    val shape = RoundedCornerShape(8.dp)
    val rowBottoms = remember(rows.size) { IntArray(rows.size) }
    val line = c.line
    Box(Modifier.horizontalScroll(rememberScrollState()).border(1.dp, line, shape).background(Color.Transparent, shape)) {
        Layout(
            content = {
                rows.forEach { row ->
                    repeat(columns) { col ->
                        Box(propagateMinConstraints = true) {
                            Text(
                                row.cells.getOrElse(col) { AnnotatedString("") },
                                style = if (row.header) cellStyle.copy(fontWeight = RukooWeights.Semibold) else cellStyle,
                                color = md.color,
                                modifier = Modifier
                                    .fillMaxSize()
                                    .background(if (row.header) c.inset else Color.Transparent)
                                    .padding(horizontal = 10.dp, vertical = 6.dp),
                            )
                        }
                    }
                }
            },
            modifier = Modifier.drawWithContent {
                drawContent()
                val stroke = 1.dp.toPx()
                rowBottoms.dropLast(1).forEach { y -> drawLine(line, Offset(0f, y.toFloat()), Offset(size.width, y.toFloat()), stroke) }
            },
        ) { measurables, _ ->
            // Each column is as wide as its widest cell, between 56 and 240dp; the table scrolls sideways when it
            // doesn't fit. Every cell is then measured at its column's width and its row's height, so a header fill
            // covers the whole cell.
            val maxCell = 240.dp.roundToPx()
            val minCell = 56.dp.roundToPx()
            val widths = IntArray(columns) { col ->
                rows.indices.maxOf { r -> measurables[r * columns + col].maxIntrinsicWidth(Constraints.Infinity) }.coerceIn(minCell, maxCell)
            }
            val heights = IntArray(rows.size) { r -> (0 until columns).maxOf { col -> measurables[r * columns + col].minIntrinsicHeight(widths[col]) } }
            val placeables = measurables.mapIndexed { i, m -> m.measure(Constraints.fixed(widths[i % columns], heights[i / columns])) }
            var y = 0
            heights.forEachIndexed { r, h ->
                y += h
                rowBottoms[r] = y
            }
            layout(widths.sum(), heights.sum()) {
                var top = 0
                rows.indices.forEach { r ->
                    var left = 0
                    repeat(columns) { col ->
                        placeables[r * columns + col].placeRelative(left, top)
                        left += widths[col]
                    }
                    top += heights[r]
                }
            }
        }
    }
}
