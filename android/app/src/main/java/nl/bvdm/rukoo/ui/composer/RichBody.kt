package nl.bvdm.rukoo.ui.composer

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.relocation.BringIntoViewRequester
import androidx.compose.foundation.relocation.bringIntoViewRequester
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.LocalMinimumInteractiveComponentSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import kotlinx.coroutines.launch
import nl.bvdm.rukoo.R
import nl.bvdm.rukoo.mail.compose.Block
import nl.bvdm.rukoo.mail.compose.Mark
import nl.bvdm.rukoo.mail.compose.RichText
import nl.bvdm.rukoo.ui.ComposerController
import nl.bvdm.rukoo.ui.ComposerState
import nl.bvdm.rukoo.ui.components.RkIconButton
import nl.bvdm.rukoo.ui.components.RkLinkButton
import nl.bvdm.rukoo.ui.components.RkTextField
import nl.bvdm.rukoo.ui.icons.RukooIcons
import nl.bvdm.rukoo.ui.settings.RkDialog
import nl.bvdm.rukoo.ui.theme.Rk

/**
 * The composer's handle on its formatted editor: whether the text has focus (the format row shows then), what the
 * cursor sits in, the link being asked for, and the actions the format row and the link dialog call.
 */
@Stable
class RichBodyState {
    internal var editor: RichEditText? = null
        private set
    var focused by mutableStateOf(false)
        internal set
    var format by mutableStateOf(FormatState())
        internal set
    var link by mutableStateOf<LinkRequest?>(null)
        internal set
    private var focusWanted = false

    internal fun bind(view: RichEditText) {
        editor = view
        if (focusWanted) {
            focusWanted = false
            focus()
        }
    }

    internal fun unbind(view: RichEditText) {
        if (editor === view) editor = null
    }

    /** Puts the cursor in the text and brings up the keyboard; waits for the editor when it isn't there yet. */
    fun focus() {
        val view = editor
        if (view == null) {
            focusWanted = true
            return
        }
        view.post {
            if (view.requestFocus()) view.showKeyboard()
        }
    }

    fun toggle(mark: Mark) {
        editor?.toggleMark(mark)
    }

    fun toggle(block: Block) {
        editor?.toggleBlock(block)
    }

    fun clear() {
        editor?.clearFormatting()
    }

    fun askLink() {
        editor?.requestLink()
    }

    fun applyLink(url: String, words: String?) {
        val request = link ?: return
        link = null
        editor?.applyLink(request, url, words)
        focus()
    }

    fun removeLink() {
        val request = link ?: return
        link = null
        editor?.removeLink(request)
        focus()
    }

    fun dismissLink() {
        link = null
        focus()
    }
}

/**
 * The text of the mail: Rukoo's formatted editor in the composer's scrolling column, 14.5 at line height 1.6,
 * "Write your message" until there is text. It loads what the composer holds and reports each change through
 * [onChange] (plain projection and HTML); a change from elsewhere (an agent's draft, an Undo) replaces the text,
 * while the editor's own changes coming back are recognized and left alone. The cursor's line is kept in view,
 * above the keyboard.
 */
@Composable
internal fun RichBodyField(
    composer: ComposerController,
    d: ComposerState,
    body: RichBodyState,
    readOnly: Boolean,
    onFocus: () -> Unit,
    onChange: (String, String?) -> Unit,
) {
    val c = Rk.colors
    val scope = rememberCoroutineScope()
    val requester = remember { BringIntoViewRequester() }
    val hint = stringResource(R.string.composer_body_placeholder)
    val label = stringResource(R.string.composer_body_label)
    val margin = with(LocalDensity.current) { 24.dp.toPx() }
    AndroidView(
        modifier = Modifier.fillMaxWidth().padding(top = 14.dp).heightIn(min = 120.dp).bringIntoViewRequester(requester),
        factory = { context ->
            RichEditText(context).apply {
                listener = object : RichEditText.Listener {
                    override fun onChanged(text: String, html: String?) = onChange(text, html)

                    override fun onState(state: FormatState) {
                        body.format = state
                    }

                    override fun onCursor(top: Int, bottom: Int) {
                        val w = width.toFloat()
                        scope.launch { runCatching { requester.bringIntoView(Rect(0f, top - margin / 2, w, bottom + margin)) } }
                    }

                    override fun onLink(request: LinkRequest) {
                        body.link = request
                    }

                    override fun onSelection(start: Int, end: Int) {
                        Cursors.put(d.id, start, end)
                    }

                    override fun onFocus(focused: Boolean) {
                        body.focused = focused
                        if (focused) onFocus()
                    }
                }
                val now = composer.current()?.takeIf { it.id == d.id } ?: d
                val (start, end) = Cursors.get(d.id)
                load(now.body, now.bodyHtml, now.richDoc(), start, end)
                contentDescription = label
                body.bind(this)
            }
        },
        update = { view ->
            view.applyTheme(c.text.toArgb(), c.text3.toArgb(), c.accent.toArgb(), c.link.toArgb(), c.text2.toArgb())
            view.locked = readOnly
            if (view.hint?.toString() != hint) view.hint = hint
            if (view.contentDescription?.toString() != label) view.contentDescription = label
        },
        onRelease = { view -> body.unbind(view) },
    )
    // An agent's draft or an Undo changed the text: show it, unless it is what the editor itself reported.
    LaunchedEffect(d.body, d.bodyHtml) {
        val view = body.editor ?: return@LaunchedEffect
        val now = composer.current()?.takeIf { it.id == d.id } ?: return@LaunchedEffect
        if (!view.shows(now.body, now.bodyHtml)) view.load(now.body, now.bodyHtml, now.richDoc())
    }
    // The keyboard coming up shrinks the column: the cursor's line stays in view.
    val ime = WindowInsets.ime.getBottom(LocalDensity.current)
    LaunchedEffect(ime) { if (body.focused) body.editor?.reportCursor() }
}

/**
 * Where the cursor was in each open composer. Folding or unfolding moves the composer to another slot in the same
 * frame, which saved state doesn't survive, so it is kept here for the life of the process; a handful of pairs.
 */
private object Cursors {
    private val map = LinkedHashMap<String, Pair<Int, Int>>()

    @Synchronized
    fun put(id: String, start: Int, end: Int) {
        map.remove(id)
        map[id] = start to end
        while (map.size > 20) map.remove(map.keys.first())
    }

    @Synchronized
    fun get(id: String): Pair<Int, Int> = map[id] ?: (0 to 0)
}

/**
 * The format row (desktop's `.format-row`), shown above the bottom bar while the text has focus, so it sits right
 * above the keyboard: bold, italic, underline, strikethrough, heading, the two lists, link and clear formatting.
 * Buttons are 44dp targets around desktop's 32dp `.icon-btn`, so all nine fit the cover screen's 411dp; a narrower
 * window scrolls the row.
 */
@Composable
internal fun FormatRow(body: RichBodyState, modifier: Modifier = Modifier) {
    val c = Rk.colors
    val f = body.format
    val label = stringResource(R.string.composer_format_label)
    CompositionLocalProvider(LocalMinimumInteractiveComponentSize provides 44.dp) {
        Row(
            modifier
                .fillMaxWidth()
                .heightIn(min = 48.dp)
                .horizontalScroll(rememberScrollState())
                .padding(horizontal = 4.dp)
                .semantics { contentDescription = label },
            verticalAlignment = Alignment.CenterVertically,
        ) {
            FormatButton(RukooIcons.Bold, R.string.composer_format_bold, Mark.BOLD in f.marks) { body.toggle(Mark.BOLD) }
            FormatButton(RukooIcons.Italic, R.string.composer_format_italic, Mark.ITALIC in f.marks) { body.toggle(Mark.ITALIC) }
            FormatButton(RukooIcons.Underline, R.string.composer_format_underline, Mark.UNDERLINE in f.marks) { body.toggle(Mark.UNDERLINE) }
            FormatButton(RukooIcons.Strike, R.string.composer_format_strikethrough, Mark.STRIKE in f.marks) { body.toggle(Mark.STRIKE) }
            Separator()
            FormatButton(RukooIcons.Heading, R.string.composer_format_heading, f.block == Block.HEADING) { body.toggle(Block.HEADING) }
            FormatButton(RukooIcons.Ul, R.string.composer_format_bullets, f.block == Block.BULLET) { body.toggle(Block.BULLET) }
            FormatButton(RukooIcons.Ol, R.string.composer_format_numbered, f.block == Block.NUMBER) { body.toggle(Block.NUMBER) }
            Separator()
            FormatButton(RukooIcons.Link, R.string.composer_format_link, f.link) { body.askLink() }
            FormatButton(RukooIcons.ClearFormat, R.string.composer_format_clear, false) { body.clear() }
        }
    }
}

@Composable
private fun FormatButton(icon: androidx.compose.ui.graphics.vector.ImageVector, label: Int, on: Boolean, onClick: () -> Unit) {
    RkIconButton(icon, stringResource(label), onClick = onClick, selected = on)
}

// `.format-row .sep`: a 1dp hairline, 16dp high.
@Composable
private fun Separator() {
    Box(Modifier.size(width = 1.dp, height = 16.dp).background(Rk.colors.border))
}

/**
 * The link dialog (desktop's insertLink): the address, and for a new link at the cursor the words to show. A link
 * the cursor is in can be changed or removed. An address without a scheme gets https://, an email address mailto:.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
internal fun LinkDialog(body: RichBodyState) {
    val request = body.link ?: return
    var address by remember(request) { mutableStateOf(request.url.removePrefix("mailto:").takeIf { request.url.startsWith("mailto:") } ?: request.url) }
    var words by remember(request) { mutableStateOf("") }
    var tried by remember(request) { mutableStateOf(false) }
    val target = RichText.linkTarget(address)
    val focus = remember { FocusRequester() }
    val confirm = {
        tried = true
        if (target != null) body.applyLink(target, words.takeIf { request.needsText })
    }
    RkDialog(
        title = stringResource(if (request.editing) R.string.composer_link_edit_title else R.string.composer_link_title),
        confirmLabel = stringResource(if (request.editing) R.string.common_actions_save else R.string.composer_link_insert),
        onConfirm = confirm,
        onDismiss = body::dismissLink,
        confirmEnabled = address.isNotBlank(),
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            RkTextField(
                value = address,
                onValueChange = { address = it },
                label = stringResource(R.string.composer_link_address),
                placeholder = "https://",
                error = if (tried && target == null) stringResource(R.string.composer_link_invalid) else null,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = if (request.needsText) ImeAction.Next else ImeAction.Done, autoCorrectEnabled = false),
                keyboardActions = KeyboardActions(onDone = { confirm() }),
                focusRequester = focus,
            )
            if (request.needsText) {
                RkTextField(
                    value = words,
                    onValueChange = { words = it },
                    label = stringResource(R.string.composer_link_text),
                    placeholder = stringResource(R.string.composer_link_text_hint),
                    keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences, imeAction = ImeAction.Done),
                    keyboardActions = KeyboardActions(onDone = { confirm() }),
                )
            }
            if (request.editing) {
                RkLinkButton(stringResource(R.string.composer_link_remove), body::removeLink, style = Rk.type.text12_5, color = Rk.colors.danger)
            }
        }
    }
    LaunchedEffect(request) { runCatching { focus.requestFocus() } }
}
