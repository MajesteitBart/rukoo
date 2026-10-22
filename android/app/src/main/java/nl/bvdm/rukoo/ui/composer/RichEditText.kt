package nl.bvdm.rukoo.ui.composer

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.graphics.fonts.Font
import android.graphics.fonts.FontFamily
import android.graphics.fonts.FontStyle
import android.text.Editable
import android.text.InputFilter
import android.text.InputType
import android.text.Layout
import android.text.SpannableString
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.TextPaint
import android.text.TextWatcher
import android.text.style.AbsoluteSizeSpan
import android.text.style.AlignmentSpan
import android.text.style.BackgroundColorSpan
import android.text.style.BulletSpan as PlatformBulletSpan
import android.text.style.CharacterStyle
import android.text.style.ForegroundColorSpan
import android.text.style.LeadingMarginSpan
import android.text.style.MetricAffectingSpan
import android.text.style.QuoteSpan
import android.text.style.RelativeSizeSpan
import android.text.style.StrikethroughSpan
import android.text.style.StyleSpan
import android.text.style.SubscriptSpan
import android.text.style.SuperscriptSpan
import android.text.style.TextAppearanceSpan
import android.text.style.TypefaceSpan
import android.text.style.URLSpan
import android.text.style.UnderlineSpan
import android.text.style.UpdateAppearance
import android.util.TypedValue
import android.view.ActionMode
import android.view.Gravity
import android.view.KeyEvent
import android.view.Menu
import android.view.MenuItem
import android.view.inputmethod.BaseInputConnection
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import android.view.inputmethod.InputConnectionWrapper
import android.view.inputmethod.InputMethodManager
import android.widget.EditText
import java.util.EnumMap
import nl.bvdm.rukoo.R
import nl.bvdm.rukoo.mail.compose.Block
import nl.bvdm.rukoo.mail.compose.LinkRange
import nl.bvdm.rukoo.mail.compose.Mark
import nl.bvdm.rukoo.mail.compose.MarkRange
import nl.bvdm.rukoo.mail.compose.RichDoc
import nl.bvdm.rukoo.mail.compose.RichText
import nl.bvdm.rukoo.ui.composer.RichEditing.MARKER

/** What the format row and the selection menu show as on: the marks, the paragraph's block, a link. */
data class FormatState(
    val marks: Set<Mark> = emptySet(),
    val block: Block = Block.TEXT,
    val link: Boolean = false,
)

/**
 * A link to add or change: the text from [start] to [end] (equal for the cursor), the [url] it has or the selected
 * text when that looks like one, and whether the cursor is in an existing link ([editing]).
 */
data class LinkRequest(val start: Int, val end: Int, val url: String, val editing: Boolean) {
    /** No text selected and no link to change: the dialog asks for the words too. */
    val needsText: Boolean get() = start == end && !editing
}

/** The colors and sizes the editor's spans draw with, set from Rukoo's theme. */
class RichPalette {
    var link: Int = 0
    var marker: Int = 0

    /** The list indent in px: room for "10." and a gap. */
    var indent: Int = 0
}

/** The editor's spans. Anything else in the text (a paste, an IME's suggestion) is not Rukoo formatting. */
internal sealed interface RichSpan

internal sealed interface MarkSpan : RichSpan {
    val mark: Mark
}

internal sealed interface BlockSpan : RichSpan {
    val block: Block
}

/**
 * Inter at the weights the editor draws: text, heading and bold, all at the text optical size. Loaded once per
 * process ([of]), as every composer and every fold makes a new editor.
 */
internal class RichFonts private constructor(context: Context) {
    companion object {
        @Volatile private var shared: RichFonts? = null

        fun of(context: Context): RichFonts = shared ?: synchronized(this) {
            shared ?: RichFonts(context.applicationContext).also { shared = it }
        }
    }

    private fun make(context: Context, weight: Int): Typeface = runCatching {
        val font = Font.Builder(context.resources, R.font.inter_variable)
            .setFontVariationSettings("'wght' $weight, 'opsz' 14")
            .setWeight(weight)
            .build()
        Typeface.CustomFallbackBuilder(FontFamily.Builder(font).build())
            .setStyle(FontStyle(weight, FontStyle.FONT_SLANT_UPRIGHT))
            .setSystemFallback("sans-serif")
            .build()
    }.getOrElse { Typeface.create(Typeface.SANS_SERIF, weight, false) }

    val regular: Typeface = make(context, 400)
    val title: Typeface = make(context, 650)
    val bold: Typeface = make(context, 700)
}

internal class BoldSpan(private val fonts: RichFonts) : MetricAffectingSpan(), MarkSpan {
    override val mark get() = Mark.BOLD
    override fun updateDrawState(tp: TextPaint) = apply(tp)
    override fun updateMeasureState(tp: TextPaint) = apply(tp)
    private fun apply(tp: TextPaint) {
        tp.typeface = fonts.bold
    }
}

internal class ItalicSpan : MetricAffectingSpan(), MarkSpan {
    override val mark get() = Mark.ITALIC
    override fun updateDrawState(tp: TextPaint) = apply(tp)
    override fun updateMeasureState(tp: TextPaint) = apply(tp)

    // Rukoo bundles Inter upright only; a slant like the browser's synthetic italic.
    private fun apply(tp: TextPaint) {
        tp.textSkewX = -0.22f
    }
}

internal class UnderlineMarkSpan : CharacterStyle(), MarkSpan, UpdateAppearance {
    override val mark get() = Mark.UNDERLINE
    override fun updateDrawState(tp: TextPaint) {
        tp.isUnderlineText = true
    }
}

internal class StrikeSpan : CharacterStyle(), MarkSpan, UpdateAppearance {
    override val mark get() = Mark.STRIKE
    override fun updateDrawState(tp: TextPaint) {
        tp.isStrikeThruText = true
    }
}

internal class LinkSpan(val url: String, private val palette: RichPalette) : CharacterStyle(), RichSpan, UpdateAppearance {
    override fun updateDrawState(tp: TextPaint) {
        tp.color = palette.link
        tp.isUnderlineText = true
    }
}

internal class BulletBlockSpan(private val palette: RichPalette) : LeadingMarginSpan, BlockSpan {
    override val block get() = Block.BULLET
    override fun getLeadingMargin(first: Boolean): Int = palette.indent
    override fun drawLeadingMargin(c: Canvas, p: Paint, x: Int, dir: Int, top: Int, baseline: Int, bottom: Int, text: CharSequence, start: Int, end: Int, first: Boolean, layout: Layout?) {
        if (!first || (text is Spanned && text.getSpanStart(this) != start)) return
        val color = p.color
        val style = p.style
        p.color = palette.marker
        p.style = Paint.Style.FILL
        val r = p.textSize * 0.14f
        val cx = x + dir * palette.indent * 0.45f
        c.drawCircle(cx, baseline - p.textSize * 0.32f, r, p)
        p.color = color
        p.style = style
    }
}

internal class NumberBlockSpan(private val palette: RichPalette) : LeadingMarginSpan, BlockSpan {
    override val block get() = Block.NUMBER
    var number = 1
    override fun getLeadingMargin(first: Boolean): Int = palette.indent
    override fun drawLeadingMargin(c: Canvas, p: Paint, x: Int, dir: Int, top: Int, baseline: Int, bottom: Int, text: CharSequence, start: Int, end: Int, first: Boolean, layout: Layout?) {
        if (!first || (text is Spanned && text.getSpanStart(this) != start)) return
        val color = p.color
        val align = p.textAlign
        p.color = palette.marker
        val label = "$number."
        if (dir >= 0) {
            p.textAlign = Paint.Align.RIGHT
            c.drawText(label, x + palette.indent - p.textSize * 0.45f, baseline.toFloat(), p)
        } else {
            p.textAlign = Paint.Align.LEFT
            c.drawText(label, x - palette.indent + p.textSize * 0.45f, baseline.toFloat(), p)
        }
        p.color = color
        p.textAlign = align
    }
}

internal class HeadingBlockSpan(private val fonts: RichFonts) : MetricAffectingSpan(), BlockSpan {
    override val block get() = Block.HEADING
    override fun updateDrawState(tp: TextPaint) = apply(tp)
    override fun updateMeasureState(tp: TextPaint) = apply(tp)
    private fun apply(tp: TextPaint) {
        tp.textSize *= 1.3f
        if (tp.typeface !== fonts.bold) tp.typeface = fonts.title
    }
}

/**
 * The composer's formatted text editor: a platform EditText, so the phone's keyboard, selection handles and the
 * floating text menu work as everywhere on Android. Formatting lives in Rukoo's own spans: marks extend while you
 * type at their end, a list or heading covers whole paragraphs, links stay put. [RichEditing] decides what typing
 * does (Markdown shortcuts, Enter and Backspace in lists); this class applies it and reports the text as RichText's
 * model through [listener].
 */
@SuppressLint("ViewConstructor", "AppCompatCustomView")
class RichEditText(context: Context) : EditText(context) {
    interface Listener {
        /** The user changed the text: its plain projection and its HTML, null without formatting. */
        fun onChanged(text: String, html: String?)

        fun onState(state: FormatState)

        /** The cursor's line, in px from the top of this view: keep it on screen. */
        fun onCursor(top: Int, bottom: Int)

        fun onLink(request: LinkRequest)

        fun onSelection(start: Int, end: Int)

        fun onFocus(focused: Boolean)
    }

    // Set at the end of init: the platform constructor already calls some of the overrides below.
    private var ready = false

    var listener: Listener? = null
    val palette = RichPalette()
    private val fonts = RichFonts.of(context)

    /** Read-only while the mail goes out: what is sent is what is on screen. */
    var locked = false

    // Above zero while this class changes the text itself; the watcher leaves those changes alone.
    private var internal = 0

    // Marks turned on or off at a collapsed cursor, for the text typed there next.
    private val pending = EnumMap<Mark, Boolean>(Mark::class.java)
    private var pendingAt = -1

    // The body and HTML last reported or loaded: an equal state from outside is this editor's own.
    private var shown: Pair<String, String?>? = null
    private var state = FormatState()

    // The change the watcher is following, from beforeTextChanged.
    private var changeStart = 0
    private var changeRemoved = ""
    private var changeAdded = 0
    private var cursorBefore = -1
    private var enterBlock = Block.TEXT
    private var enterWasEmpty = false
    private var enterRestEmpty = false
    private var joinedBlock = Block.TEXT

    private val watcher = object : TextWatcher {
        override fun beforeTextChanged(s: CharSequence, start: Int, count: Int, after: Int) {
            if (internal > 0) return
            changeStart = start
            changeRemoved = s.subSequence(start, start + count).toString()
            changeAdded = after
            cursorBefore = if (selectionStart == selectionEnd) selectionStart else -1
            val ps = paragraphStart(s, start)
            val pe = RichText.paragraphEnd(s, start)
            enterBlock = blockAt(s, ps)
            enterWasEmpty = RichEditing.isEmptyParagraph(s.subSequence(ps, pe))
            enterRestEmpty = RichEditing.isEmptyParagraph(s.subSequence(minOf(start + count, pe), pe))
            joinedBlock = if (count == 1 && after == 0 && s[start] == '\n') blockAt(s, start + 1) else Block.TEXT
        }

        override fun onTextChanged(s: CharSequence, start: Int, before: Int, count: Int) {
            if (internal > 0) return
            applyPending(start, before, count)
        }

        override fun afterTextChanged(s: Editable) {
            if (internal > 0) return
            internal++
            val restructured = try {
                afterEdit(s)
            } finally {
                internal--
            }
            if (restructured) restartImeIfComposing()
            emit()
            publishState()
            reportCursor()
        }
    }

    // Edits while locked are refused, except this class's own.
    private val lockFilter = InputFilter { _, _, _, dest, dstart, dend -> if (locked && internal == 0) dest.subSequence(dstart, dend) else null }

    private val selectionMenu = object : ActionMode.Callback {
        override fun onCreateActionMode(mode: ActionMode, menu: Menu): Boolean {
            if (locked) return true
            // Before Cut and Copy: what people look for when they select a word in an email.
            addGlyph(menu, ID_BOLD, R.string.composer_format_bold_glyph, R.string.composer_format_bold, StyleSpan(Typeface.BOLD))
            addGlyph(menu, ID_ITALIC, R.string.composer_format_italic_glyph, R.string.composer_format_italic, StyleSpan(Typeface.ITALIC))
            addGlyph(menu, ID_UNDERLINE, R.string.composer_format_underline_glyph, R.string.composer_format_underline, UnderlineSpan())
            menu.add(Menu.NONE, ID_LINK, ORDER, context.getString(R.string.composer_format_link))
            return true
        }

        override fun onPrepareActionMode(mode: ActionMode, menu: Menu): Boolean = false

        override fun onActionItemClicked(mode: ActionMode, item: MenuItem): Boolean {
            when (item.itemId) {
                ID_BOLD -> toggleMark(Mark.BOLD)
                ID_ITALIC -> toggleMark(Mark.ITALIC)
                ID_UNDERLINE -> toggleMark(Mark.UNDERLINE)
                ID_LINK -> {
                    requestLink()
                    mode.finish()
                }
                else -> return false
            }
            return true
        }

        override fun onDestroyActionMode(mode: ActionMode) {}

        private fun addGlyph(menu: Menu, id: Int, glyph: Int, label: Int, style: Any) {
            val title = SpannableString(context.getString(glyph)).apply { setSpan(style, 0, length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE) }
            menu.add(Menu.NONE, id, ORDER, title).contentDescription = context.getString(label)
        }
    }

    init {
        background = null
        setPadding(0, 0, 0, 0)
        includeFontPadding = false
        typeface = fonts.regular
        setTextSize(TypedValue.COMPLEX_UNIT_SP, TEXT_SP)
        lineHeight = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, TEXT_SP * LINE_HEIGHT, resources.displayMetrics).toInt()
        fontFeatureSettings = "cv11"
        inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE or
            InputType.TYPE_TEXT_FLAG_CAP_SENTENCES or InputType.TYPE_TEXT_FLAG_AUTO_CORRECT
        imeOptions = EditorInfo.IME_FLAG_NO_EXTRACT_UI or EditorInfo.IME_FLAG_NO_FULLSCREEN
        gravity = Gravity.TOP or Gravity.START
        minLines = 5
        isVerticalScrollBarEnabled = false
        overScrollMode = OVER_SCROLL_NEVER
        importantForAutofill = IMPORTANT_FOR_AUTOFILL_NO
        palette.indent = (TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, TEXT_SP, resources.displayMetrics) * 1.9f).toInt()
        filters = arrayOf(lockFilter)
        customSelectionActionModeCallback = selectionMenu
        addTextChangedListener(watcher)
        ready = true
    }

    // ---------- theme ----------

    private var themeKey: List<Int>? = null

    /** Rukoo's colors as ARGB ints: text, placeholder, accent (cursor, handles, selection), links and list markers. */
    fun applyTheme(text: Int, hint: Int, accent: Int, link: Int, marker: Int) {
        val key = listOf(text, hint, accent, link, marker)
        if (key == themeKey) return
        themeKey = key
        setTextColor(text)
        setHintTextColor(hint)
        highlightColor = (accent and 0x00FFFFFF) or 0x4D000000
        palette.link = link
        palette.marker = marker
        val density = resources.displayMetrics.density
        textCursorDrawable = GradientDrawable().apply {
            setColor(accent)
            setSize((2 * density).toInt(), TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, TEXT_SP * 1.3f, resources.displayMetrics).toInt())
        }
        textSelectHandle?.mutate()?.setTint(accent)
        textSelectHandleLeft?.mutate()?.setTint(accent)
        textSelectHandleRight?.mutate()?.setTint(accent)
        invalidate()
    }

    // ---------- content ----------

    /**
     * Shows [doc], which is [body] and [html] as the composer holds them, with the cursor at [selectionStart] and
     * [selectionEnd] (clamped; negative puts it at the end). Not a user change: nothing is reported.
     */
    fun load(body: String, html: String?, doc: RichDoc, selectionStart: Int = -1, selectionEnd: Int = selectionStart) {
        val ssb = SpannableStringBuilder(doc.text)
        for (m in doc.marks) if (m.end > m.start && m.end <= doc.text.length) ssb.setSpan(markSpan(m.mark), m.start, m.end, Spanned.SPAN_EXCLUSIVE_INCLUSIVE)
        for (l in doc.links) if (l.end > l.start && l.end <= doc.text.length) ssb.setSpan(LinkSpan(l.url, palette), l.start, l.end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        val starts = RichText.paragraphStarts(doc.text)
        for (i in starts.indices) {
            val block = doc.block(i)
            if (block == Block.TEXT) continue
            val end = if (i + 1 < starts.size) starts[i + 1] else doc.text.length
            ssb.setSpan(blockSpan(block), starts[i], end, Spanned.SPAN_INCLUSIVE_EXCLUSIVE)
        }
        internal++
        try {
            pending.clear()
            setText(ssb)
            val e = text
            syncBlocks(e)
            ensureMarker(e)
            val n = e.length
            val a = if (selectionStart < 0) n else selectionStart.coerceIn(0, n)
            val b = if (selectionStart < 0) n else selectionEnd.coerceIn(0, n)
            setSelection(minOf(a, b), maxOf(a, b))
        } finally {
            internal--
        }
        shown = body to html
        publishState()
    }

    /** Whether the composer's [body] and [html] are what this editor shows: then a state change is its own echo. */
    fun shows(body: String, html: String?): Boolean = shown == (body to html)

    /** The text as RichText's model: markers left out, marks merged, one block per paragraph. */
    fun document(): RichDoc {
        val e = text ?: return RichDoc("")
        val n = e.length
        val map = IntArray(n + 1)
        val sb = StringBuilder(n)
        for (i in 0 until n) {
            map[i] = sb.length
            val ch = e[i]
            if (ch != MARKER) sb.append(ch)
        }
        map[n] = sb.length
        val marks = ArrayList<MarkRange>()
        for (mark in Mark.entries) {
            val ranges = e.getSpans(0, n, MarkSpan::class.java).filter { it.mark == mark }
                .map { RichEditing.Range(map[e.getSpanStart(it)], map[e.getSpanEnd(it)]) }
            for (r in RichEditing.merge(ranges)) marks += MarkRange(r.start, r.end, mark)
        }
        val links = e.getSpans(0, n, LinkSpan::class.java)
            .map { LinkRange(map[e.getSpanStart(it)], map[e.getSpanEnd(it)], it.url) }
            .filter { it.end > it.start }
            .sortedBy { it.start }
        return RichDoc(sb.toString(), marks.sortedWith(compareBy({ it.start }, { it.mark })), links, blocks(e))
    }

    private fun emit() {
        val doc = document()
        val body = RichText.plain(doc)
        val html = if (doc.isPlain) null else RichText.toHtml(doc)
        val key = body to html
        if (key == shown) return
        shown = key
        listener?.onChanged(body, html)
    }

    // ---------- the watcher's rules ----------

    /** Applies Enter, Backspace and the shortcuts to the change just made. True when it restructured the text. */
    private fun afterEdit(e: Editable): Boolean {
        val start = changeStart
        val removed = changeRemoved
        val added = changeAdded
        var restructured = false
        val end = (start + added).coerceAtMost(e.length)
        if (added == 0 && removed == "\n" && cursorBefore == start + 1 && RichEditing.backspaceRemovesBlock(joinedBlock)) {
            // Backspace at the start of a list item or heading: the line break comes back and the block goes.
            e.insert(start, "\n")
            syncBlocks(e)
            setParagraphBlock(e, start + 1, Block.TEXT)
            setSelection(start + 1)
            restructured = true
        } else if (added == 0 && removed == MARKER.toString() && cursorBefore == start + 1) {
            // The same, where an empty last item kept its marker.
            val ps = paragraphStart(e, start)
            syncBlocks(e)
            if (ps == start && blockAt(e, ps) != Block.TEXT) {
                setParagraphBlock(e, ps, Block.TEXT)
                restructured = true
            }
        } else if (removed.contains('\n')) {
            // Lines were deleted or replaced: what is left is one paragraph with the block of the first one, as in
            // word processors. The spans of the deleted paragraphs shrank to nothing there; they go.
            val ps = paragraphStart(e, start)
            for (s in e.getSpans(ps, end, BlockSpan::class.java)) if (e.getSpanStart(s) == e.getSpanEnd(s)) e.removeSpan(s as Any)
            syncBlocks(e)
            setParagraphBlock(e, ps, enterBlock)
        } else if (removed.isEmpty() && added == 1 && end <= e.length && e[start] == '\n') {
            restructured = enter(e, start)
        } else if (added > 0 && selectionStart == selectionEnd && selectionStart == end) {
            restructured = shortcut(e, end)
        }
        syncBlocks(e)
        if (ensureMarker(e)) syncBlocks(e)
        stripForeign(e, start, end)
        dropEmptyMarks(e)
        return restructured
    }

    private fun enter(e: Editable, at: Int): Boolean {
        when (val r = RichEditing.enter(enterBlock, enterWasEmpty, enterRestEmpty)) {
            RichEditing.Enter.EndList -> {
                // Enter on an empty item: the list ends here, on this line.
                e.delete(at, at + 1)
                syncBlocks(e)
                setParagraphBlock(e, paragraphStart(e, at), Block.TEXT)
                setSelection(at.coerceAtMost(e.length))
                return true
            }
            is RichEditing.Enter.Next -> {
                if (enterBlock == Block.TEXT) return false
                syncBlocks(e)
                val ps = paragraphStart(e, at)
                setParagraphBlock(e, ps, enterBlock)
                setParagraphBlock(e, at + 1, r.block)
                return true
            }
        }
    }

    private fun shortcut(e: Editable, cursor: Int): Boolean {
        val last = e[cursor - 1]
        val ps = paragraphStart(e, cursor)
        val before = e.subSequence(ps, cursor).toString()
        if (last == ' ') {
            syncBlocks(e)
            if (blockAt(e, ps) != Block.TEXT) return false
            val hit = RichEditing.blockShortcut(before) ?: return false
            e.delete(ps, ps + hit.length)
            syncBlocks(e)
            setParagraphBlock(e, ps, hit.block)
            return true
        }
        if (last != '*' && last != '_' && last != '~') return false
        val hit = RichEditing.inlineShortcut(before) ?: return false
        // The closing delimiter goes first, so the opening one's offset still holds.
        e.delete(ps + hit.close, ps + hit.close + hit.width)
        e.delete(ps + hit.open, ps + hit.open + hit.width)
        val a = ps + hit.open
        val b = ps + hit.close - hit.width
        setMark(e, hit.mark, a, b, true)
        // What comes next is typed without it, as in chat apps.
        pending[hit.mark] = false
        pendingAt = b
        setSelection(b)
        return true
    }

    // Typing where a mark was turned on or off at the cursor gives the new text that mark, or takes it off.
    private fun applyPending(start: Int, before: Int, count: Int) {
        if (pending.isEmpty() || count == 0) return
        if (pendingAt < start || pendingAt > start + before) return
        val e = text ?: return
        val end = start + count
        internal++
        try {
            for ((mark, on) in pending) setMark(e, mark, start, end, on)
        } finally {
            internal--
        }
        pendingAt = end
    }

    // ---------- marks ----------

    private fun markSpan(mark: Mark): MarkSpan = when (mark) {
        Mark.BOLD -> BoldSpan(fonts)
        Mark.ITALIC -> ItalicSpan()
        Mark.UNDERLINE -> UnderlineMarkSpan()
        Mark.STRIKE -> StrikeSpan()
    }

    private fun ranges(e: Spanned, mark: Mark): List<RichEditing.Range> =
        RichEditing.merge(e.getSpans(0, e.length, MarkSpan::class.java).filter { it.mark == mark }.map { RichEditing.Range(e.getSpanStart(it), e.getSpanEnd(it)) })

    /** Gives [start] until [end] the [mark] or takes it off, touching only the spans around it. */
    private fun setMark(e: Editable, mark: Mark, start: Int, end: Int, on: Boolean) {
        if (start >= end) return
        val near = e.getSpans(start, end, MarkSpan::class.java).filter { it.mark == mark }
        val ranges = near.map { RichEditing.Range(e.getSpanStart(it), e.getSpanEnd(it)) }
        near.forEach { e.removeSpan(it as Any) }
        val next = if (on) RichEditing.add(ranges, start, end) else RichEditing.remove(ranges, start, end)
        for (r in next) e.setSpan(markSpan(mark), r.start, r.end, Spanned.SPAN_EXCLUSIVE_INCLUSIVE)
    }

    private fun dropEmptyMarks(e: Editable) {
        for (s in e.getSpans(0, e.length, MarkSpan::class.java)) if (e.getSpanStart(s) >= e.getSpanEnd(s)) e.removeSpan(s as Any)
    }

    /** Bold, italic, underline or strikethrough on the selection, or for what is typed next at the cursor. */
    fun toggleMark(mark: Mark) {
        if (locked) return
        finishComposing()
        val e = text ?: return
        val (a, b) = selection()
        if (a < 0) return
        if (a == b) {
            val on = pending[mark] ?: RichEditing.activeAt(ranges(e, mark), a)
            pending[mark] = !on
            pendingAt = a
            publishState()
            return
        }
        val on = !RichEditing.covered(e, ranges(e, mark), a, b)
        internal++
        try {
            setMark(e, mark, a, b, on)
        } finally {
            internal--
        }
        emit()
        publishState()
    }

    /**
     * Clear formatting (desktop's removeFormat): bold, italic, underline and strikethrough come off the selection,
     * or off what is typed next at the cursor. Links, lists and headings stay.
     */
    fun clearFormatting() {
        if (locked) return
        finishComposing()
        val e = text ?: return
        val (a, b) = selection()
        if (a < 0) return
        if (a == b) {
            for (mark in Mark.entries) pending[mark] = false
            pendingAt = a
            publishState()
            return
        }
        internal++
        try {
            for (mark in Mark.entries) setMark(e, mark, a, b, false)
        } finally {
            internal--
        }
        emit()
        publishState()
    }

    // ---------- blocks ----------

    private fun blockSpan(block: Block): BlockSpan = when (block) {
        Block.BULLET -> BulletBlockSpan(palette)
        Block.NUMBER -> NumberBlockSpan(palette)
        Block.HEADING -> HeadingBlockSpan(fonts)
        Block.TEXT -> error("A text paragraph has no span")
    }

    private fun blocks(e: Spanned): List<Block> {
        val spans = e.getSpans(0, e.length, BlockSpan::class.java)
        return RichEditing.paragraphBlocks(e, spans.map { RichEditing.BlockRange(e.getSpanStart(it), e.getSpanEnd(it), it.block) })
    }

    /** The block of the paragraph that starts at [paragraphStart]. */
    private fun blockAt(s: CharSequence, paragraphStart: Int): Block {
        if (s !is Spanned) return Block.TEXT
        val p = paragraphStart.coerceIn(0, s.length)
        var best: BlockSpan? = null
        var bestScore = -1
        for (span in s.getSpans(p, p, BlockSpan::class.java)) {
            val st = s.getSpanStart(span)
            val en = s.getSpanEnd(span)
            val hit = if (en > st) st <= p && p < en else st == p
            if (!hit) continue
            val score = if (en > st) 2 else 1
            if (score > bestScore) {
                best = span
                bestScore = score
            }
        }
        return best?.block ?: Block.TEXT
    }

    /**
     * One span per formatted paragraph, exactly over it (its line break included), after an edit moved or joined
     * them; numbers counted again. Spans that are already right stay, so the layout only changes where it must.
     */
    private fun syncBlocks(e: Editable) {
        val n = e.length
        val spans = e.getSpans(0, n, BlockSpan::class.java)
        val blocks = RichEditing.paragraphBlocks(e, spans.map { RichEditing.BlockRange(e.getSpanStart(it), e.getSpanEnd(it), it.block) })
        val starts = RichEditing.paragraphStarts(e)
        val numbers = RichEditing.numbers(blocks)
        val kept = BooleanArray(starts.size)
        var renumbered = false
        fun endOf(i: Int) = if (i + 1 < starts.size) starts[i + 1] else n
        for (s in spans) {
            val st = e.getSpanStart(s)
            val en = e.getSpanEnd(s)
            val i = starts.binarySearch(st)
            if (i >= 0 && !kept[i] && blocks[i] == s.block && en == endOf(i)) {
                kept[i] = true
                if (s is NumberBlockSpan && s.number != numbers[i]) {
                    s.number = numbers[i]
                    renumbered = true
                }
            } else {
                e.removeSpan(s as Any)
            }
        }
        for (i in starts.indices) {
            if (kept[i] || blocks[i] == Block.TEXT) continue
            val span = blockSpan(blocks[i])
            if (span is NumberBlockSpan) span.number = numbers[i]
            e.setSpan(span, starts[i], endOf(i), Spanned.SPAN_INCLUSIVE_EXCLUSIVE)
        }
        if (renumbered) invalidate()
    }

    /** Makes the paragraph starting at [paragraphStart] a [block] paragraph. Spans must be in sync. */
    private fun setParagraphBlock(e: Editable, paragraphStart: Int, block: Block) {
        val p = paragraphStart.coerceIn(0, e.length)
        for (s in e.getSpans(p, p, BlockSpan::class.java)) {
            val st = e.getSpanStart(s)
            val en = e.getSpanEnd(s)
            if (st == p || (st < p && en > p)) e.removeSpan(s as Any)
        }
        if (block != Block.TEXT) {
            val end = RichText.paragraphEnd(e, p).let { if (it < e.length) it + 1 else it }
            e.setSpan(blockSpan(block), p, end, Spanned.SPAN_INCLUSIVE_EXCLUSIVE)
        }
        syncBlocks(e)
    }

    /**
     * Android draws no bullet or number on an empty last line, so an empty last list item holds a zero-width
     * space; a last line that is text again doesn't need it. Returns true when it changed the text.
     */
    private fun ensureMarker(e: Editable): Boolean {
        val n = e.length
        val ps = paragraphStart(e, n)
        val block = blockAt(e, ps)
        val content = e.subSequence(ps, n)
        if (block != Block.TEXT && content.isEmpty()) {
            val cursor = selectionStart == n && selectionEnd == n
            e.insert(n, MARKER.toString())
            if (cursor) setSelection(n + 1)
            return true
        }
        if (block == Block.TEXT && content.isNotEmpty() && content.all { it == MARKER }) {
            e.delete(ps, n)
            return true
        }
        return false
    }

    /** List, numbers or heading for the paragraphs in the selection; off again when they all have it. */
    fun toggleBlock(block: Block) {
        if (locked) return
        finishComposing()
        val e = text ?: return
        val (a0, b0) = selection()
        val a = a0.coerceAtLeast(0)
        val b = b0.coerceAtLeast(a)
        internal++
        try {
            syncBlocks(e)
            val starts = RichEditing.paragraphStarts(e)
            val first = paragraphIndex(starts, a)
            val last = paragraphIndex(starts, b)
            val target = if (RichEditing.allBlocks(blocks(e), first, last, block)) Block.TEXT else block
            for (i in first..last) setParagraphBlock(e, RichEditing.paragraphStarts(e)[i], target)
            if (ensureMarker(e)) syncBlocks(e)
        } finally {
            internal--
        }
        emit()
        publishState()
        reportCursor()
    }

    /** The selection from its first to its last character: a selection made backwards has its anchor at the end. */
    private fun selection(): Pair<Int, Int> = minOf(selectionStart, selectionEnd) to maxOf(selectionStart, selectionEnd)

    private fun paragraphIndex(starts: IntArray, offset: Int): Int {
        val i = starts.binarySearch(offset)
        return if (i >= 0) i else -i - 2
    }

    private fun paragraphStart(s: CharSequence, offset: Int): Int {
        var i = offset.coerceIn(0, s.length)
        while (i > 0 && s[i - 1] != '\n') i--
        return i
    }

    /** Backspace at the start of a list item or heading takes the block off; true when it did. */
    internal fun backspaceAtBlockStart(): Boolean {
        if (!ready || locked) return false
        val e = text ?: return false
        val a = selectionStart
        if (a < 0 || a != selectionEnd) return false
        val ps = paragraphStart(e, a)
        for (i in ps until a) if (e[i] != MARKER) return false
        if (!RichEditing.backspaceRemovesBlock(blockAt(e, ps))) return false
        internal++
        try {
            syncBlocks(e)
            setParagraphBlock(e, ps, Block.TEXT)
            if (ensureMarker(e)) syncBlocks(e)
        } finally {
            internal--
        }
        emit()
        publishState()
        return true
    }

    // ---------- links ----------

    /** Asks the composer for a link: the one the cursor is in, or a new one for the selection or at the cursor. */
    fun requestLink() {
        if (locked) return
        val e = text ?: return
        val (a0, b0) = selection()
        val a = a0.coerceAtLeast(0)
        val b = b0.coerceAtLeast(a)
        val existing = e.getSpans(a, b, LinkSpan::class.java).firstOrNull { link ->
            val st = e.getSpanStart(link)
            val en = e.getSpanEnd(link)
            if (a == b) st < a && a <= en || st == a && en > a else st < b && en > a
        }
        val request = if (existing != null) {
            LinkRequest(e.getSpanStart(existing), e.getSpanEnd(existing), existing.url, editing = true)
        } else {
            val selected = e.subSequence(a, b).toString().trim()
            LinkRequest(a, b, if (RichText.linkTarget(selected) != null && selected.contains('.') && !selected.contains(' ')) selected else "", editing = false)
        }
        listener?.onLink(request)
    }

    /** Puts [url] on the request's text; at a bare cursor it first types [words], or the address. */
    fun applyLink(request: LinkRequest, url: String, words: String?) {
        if (locked) return
        finishComposing()
        val e = text ?: return
        var a = request.start.coerceIn(0, e.length)
        var b = request.end.coerceIn(a, e.length)
        internal++
        try {
            if (a == b) {
                val shown = words?.trim()?.takeIf { it.isNotEmpty() } ?: url.removePrefix("mailto:")
                e.insert(a, shown)
                b = a + shown.length
            }
            removeLinks(e, a, b)
            e.setSpan(LinkSpan(url, palette), a, b, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            setSelection(b)
            syncBlocks(e)
            if (ensureMarker(e)) syncBlocks(e)
        } finally {
            internal--
        }
        emit()
        publishState()
    }

    /** Takes the link off the request's text; the words stay. */
    fun removeLink(request: LinkRequest) {
        if (locked) return
        val e = text ?: return
        val a = request.start.coerceIn(0, e.length)
        val b = request.end.coerceIn(a, e.length)
        internal++
        try {
            removeLinks(e, a, b)
        } finally {
            internal--
        }
        emit()
        publishState()
    }

    private fun removeLinks(e: Editable, a: Int, b: Int) {
        for (link in e.getSpans(a, b, LinkSpan::class.java)) {
            val st = e.getSpanStart(link)
            val en = e.getSpanEnd(link)
            if (en <= a || st >= b) continue
            e.removeSpan(link)
            if (st < a) e.setSpan(LinkSpan(link.url, palette), st, a, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            if (en > b) e.setSpan(LinkSpan(link.url, palette), b, en, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        }
    }

    // ---------- state ----------

    private fun publishState() {
        if (!ready) return
        val e = text ?: return
        val (a, b) = selection()
        if (a < 0) return
        val marks = HashSet<Mark>()
        for (mark in Mark.entries) {
            val on = if (a == b) pending[mark] ?: RichEditing.activeAt(ranges(e, mark), a) else RichEditing.covered(e, ranges(e, mark), a, b)
            if (on) marks += mark
        }
        val starts = RichEditing.paragraphStarts(e)
        val blocks = blocks(e)
        val first = paragraphIndex(starts, a)
        val last = paragraphIndex(starts, b)
        val block = blocks.getOrElse(first) { Block.TEXT }.takeIf { first == last || RichEditing.allBlocks(blocks, first, last, it) } ?: Block.TEXT
        val link = e.getSpans(a, b, LinkSpan::class.java).any { l ->
            val st = e.getSpanStart(l)
            val en = e.getSpanEnd(l)
            if (a == b) st < a && a <= en else st < b && en > a
        }
        val next = FormatState(marks, block, link)
        if (next != state) {
            state = next
            listener?.onState(next)
        }
    }

    /** Reports the cursor's line once the layout has caught up, so the composer can keep it above the keyboard. */
    fun reportCursor() {
        if (!ready || !hasFocus()) return
        post {
            val l = layout ?: return@post
            val offset = selectionEnd.coerceIn(0, text?.length ?: 0)
            val line = l.getLineForOffset(offset)
            listener?.onCursor(l.getLineTop(line) + totalPaddingTop, l.getLineBottom(line) + totalPaddingTop)
        }
    }

    override fun onSelectionChanged(selStart: Int, selEnd: Int) {
        super.onSelectionChanged(selStart, selEnd)
        if (!ready) return
        if (pending.isNotEmpty() && (selStart != selEnd || selStart != pendingAt)) pending.clear()
        if (internal > 0) return
        publishState()
        listener?.onSelection(selStart, selEnd)
        reportCursor()
    }

    override fun onFocusChanged(focused: Boolean, direction: Int, previouslyFocusedRect: android.graphics.Rect?) {
        super.onFocusChanged(focused, direction, previouslyFocusedRect)
        if (!ready) return
        listener?.onFocus(focused)
        if (focused) reportCursor()
    }

    // ---------- keyboard ----------

    override fun onCreateInputConnection(outAttrs: EditorInfo): InputConnection? {
        val base = super.onCreateInputConnection(outAttrs) ?: return null
        return object : InputConnectionWrapper(base, true) {
            override fun deleteSurroundingText(beforeLength: Int, afterLength: Int): Boolean =
                if (beforeLength == 1 && afterLength == 0 && backspaceAtBlockStart()) true else super.deleteSurroundingText(beforeLength, afterLength)

            override fun deleteSurroundingTextInCodePoints(beforeLength: Int, afterLength: Int): Boolean =
                if (beforeLength == 1 && afterLength == 0 && backspaceAtBlockStart()) true else super.deleteSurroundingTextInCodePoints(beforeLength, afterLength)
        }
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
        if (keyCode == KeyEvent.KEYCODE_DEL && backspaceAtBlockStart()) return true
        return super.onKeyDown(keyCode, event)
    }

    // Pasted text comes in plain: another app's colors and sizes are not formatting this composer writes.
    override fun onTextContextMenuItem(id: Int): Boolean = super.onTextContextMenuItem(if (id == android.R.id.paste) android.R.id.pasteAsPlainText else id)

    /** Commits the keyboard's word in progress, so formatting applies to settled text. */
    private fun finishComposing() {
        val e = text ?: return
        if (BaseInputConnection.getComposingSpanStart(e) < 0) return
        BaseInputConnection.removeComposingSpans(e)
        context.getSystemService(InputMethodManager::class.java)?.restartInput(this)
    }

    private fun restartImeIfComposing() {
        val e = text ?: return
        if (BaseInputConnection.getComposingSpanStart(e) < 0) return
        post {
            BaseInputConnection.removeComposingSpans(e)
            context.getSystemService(InputMethodManager::class.java)?.restartInput(this)
        }
    }

    /** Shows the keyboard for this field; call after focusing it. */
    fun showKeyboard() {
        post { context.getSystemService(InputMethodManager::class.java)?.showSoftInput(this, InputMethodManager.SHOW_IMPLICIT) }
    }

    // Formatting another app put on inserted text (a paste, a keyboard's clipboard). The keyboard's own spans, for the
    // word being typed and its suggestions, stay.
    private fun stripForeign(e: Editable, start: Int, end: Int) {
        if (end <= start) return
        for (span in e.getSpans(start, end, Any::class.java)) {
            if (span is RichSpan) continue
            if (e.getSpanFlags(span) and Spanned.SPAN_COMPOSING != 0) continue
            val foreign = span is StyleSpan || span is UnderlineSpan || span is StrikethroughSpan || span is URLSpan ||
                span is ForegroundColorSpan || span is BackgroundColorSpan || span is AbsoluteSizeSpan || span is RelativeSizeSpan ||
                span is TypefaceSpan || span is SubscriptSpan || span is SuperscriptSpan || span is TextAppearanceSpan ||
                span is PlatformBulletSpan || span is QuoteSpan || span is AlignmentSpan || span is LeadingMarginSpan
            if (foreign) e.removeSpan(span)
        }
    }

    private companion object {
        const val TEXT_SP = 14.5f
        const val LINE_HEIGHT = 1.6f
        const val ORDER = 1
        // Menu ids of the selection menu's items; the platform's own are android.R.id values, far from these.
        const val ID_BOLD = 0x52_4B_01
        const val ID_ITALIC = 0x52_4B_02
        const val ID_UNDERLINE = 0x52_4B_03
        const val ID_LINK = 0x52_4B_04
    }
}
