package nl.bvdm.rukoo.ui.composer

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import java.io.File
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import nl.bvdm.rukoo.R
import nl.bvdm.rukoo.core.Ids
import nl.bvdm.rukoo.mail.model.Address
import nl.bvdm.rukoo.mail.model.OutgoingAttachment
import nl.bvdm.rukoo.mail.model.ReplyKind
import nl.bvdm.rukoo.ui.ComposerState
import nl.bvdm.rukoo.ui.components.Hairline
import nl.bvdm.rukoo.ui.components.RkBottomSheet
import nl.bvdm.rukoo.ui.components.RkButton
import nl.bvdm.rukoo.ui.components.RkButtonKind
import nl.bvdm.rukoo.ui.components.RkButtonSize
import nl.bvdm.rukoo.ui.components.RkDropdownMenu
import nl.bvdm.rukoo.ui.components.RkIcon
import nl.bvdm.rukoo.ui.components.RkIconButton
import nl.bvdm.rukoo.ui.components.RkLinkButton
import nl.bvdm.rukoo.ui.components.RkMenuItem
import nl.bvdm.rukoo.ui.components.SheetRow
import nl.bvdm.rukoo.ui.components.rkClickable
import nl.bvdm.rukoo.ui.icons.RukooIcons
import nl.bvdm.rukoo.ui.mail.ListModel
import nl.bvdm.rukoo.ui.mail.MailDates
import nl.bvdm.rukoo.ui.mail.rememberMailDates
import nl.bvdm.rukoo.ui.root.AppViewModel
import nl.bvdm.rukoo.ui.root.Pane
import nl.bvdm.rukoo.ui.theme.Rk
import nl.bvdm.rukoo.ui.theme.medium
import nl.bvdm.rukoo.ui.theme.semibold
import nl.bvdm.rukoo.ui.theme.tabular
import nl.bvdm.rukoo.ui.theme.title
import nl.bvdm.rukoo.ui.theme.weight

/**
 * The composer (spec 6 §4.7 and §5.2), on the shared ComposerController: a top bar with Close and the title;
 * From, To, Cc, Bcc and Subject; a plain-text editor; the quoted original behind its "···" pill;
 * attachments from the system picker; and the bottom bar with Attach, Delete, More, the agent's mark and
 * Send. It opens beside the list on the inner screen and full screen on the cover screen.
 */
@Composable
fun ComposerPane(app: AppViewModel, modifier: Modifier = Modifier) {
    val state by app.services.composer.state.collectAsStateWithLifecycle()
    val d = state ?: return
    Column(modifier.background(Rk.colors.panel).onFocusChanged { if (it.hasFocus) app.interacted(Pane.COMPOSER) }) {
        androidx.compose.runtime.key(d.id) { Composer(app, d) }
    }
}

/** A user's change: marks the draft changed, and an agent's draft as edited by the user. */
private fun ComposerState.edited(): ComposerState =
    copy(dirty = true, draftedBy = null, editedAgent = draftedBy ?: editedAgent)

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun androidx.compose.foundation.layout.ColumnScope.Composer(app: AppViewModel, d: ComposerState) {
    val c = Rk.colors
    val composer = app.services.composer
    val mail = app.services.mail
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val edit: ((ComposerState) -> ComposerState) -> Unit = { change -> composer.update { change(it).edited() } }
    val contacts by produceState(emptyList<Address>()) { value = runCatching { mail.contacts() }.getOrDefault(emptyList()) }
    var askedCc by rememberSaveable(d.id) { mutableStateOf(false) }
    var askedBcc by rememberSaveable(d.id) { mutableStateOf(false) }
    val showCc = askedCc || d.cc.isNotEmpty()
    val showBcc = askedBcc || d.bcc.isNotEmpty()
    val toFocus = remember { FocusRequester() }
    val bodyFocus = remember { FocusRequester() }
    var focused by rememberSaveable(d.id) { mutableStateOf(false) }
    val failedAttach = stringResource(R.string.composer_attachments_failed, "%s")
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        if (uris.isEmpty()) return@rememberLauncherForActivityResult
        scope.launch {
            for (uri in uris) {
                val added = withContext(Dispatchers.IO) { runCatching { copyIn(context, uri, d.id) }.getOrNull() }
                if (added == null) app.mailUi.toasts.showError(failedAttach.replace("%s", uri.lastPathSegment ?: ""))
                else edit { it.copy(attachments = it.attachments + added) }
            }
        }
    }

    // Top bar: Close and the title (spec 6 §4.7, "On a phone").
    Row(Modifier.fillMaxWidth().heightIn(min = 56.dp).padding(horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        RkIconButton(RukooIcons.Close, stringResource(R.string.common_actions_close), onClick = app::closeComposer)
        Text(
            stringResource(
                when (d.replyKind) {
                    ReplyKind.REPLY -> R.string.composer_titles_reply
                    ReplyKind.REPLY_ALL -> R.string.composer_titles_reply_all
                    ReplyKind.FORWARD -> R.string.composer_titles_forward
                    ReplyKind.DRAFT -> R.string.composer_titles_draft
                    ReplyKind.NEW -> R.string.composer_titles_new
                },
            ),
            style = Rk.type.text14.title,
            color = c.text,
            maxLines = 1,
            modifier = Modifier.weight(1f).padding(start = 6.dp),
        )
    }
    Hairline()

    Column(Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp)) {
        FromField(app, d)
        RecipientField(
            label = stringResource(R.string.reader_headers_to),
            list = d.to,
            onChange = { list -> edit { it.copy(to = list) } },
            contacts = contacts,
            focusRequester = toFocus,
            trailing = {
                if (!showCc) RkLinkButton(stringResource(R.string.reader_headers_cc), { askedCc = true }, style = Rk.type.text12_5, color = c.text2)
                if (!showBcc) RkLinkButton(stringResource(R.string.reader_headers_bcc), { askedBcc = true }, style = Rk.type.text12_5, color = c.text2)
            },
        )
        if (showCc) RecipientField(stringResource(R.string.reader_headers_cc), d.cc, { list -> edit { it.copy(cc = list) } }, contacts)
        if (showBcc) RecipientField(stringResource(R.string.reader_headers_bcc), d.bcc, { list -> edit { it.copy(bcc = list) } }, contacts)
        SubjectField(d.subject) { text -> edit { it.copy(subject = text) } }

        BodyField(d, bodyFocus) { text -> edit { it.copy(body = text) } }

        if (d.quote.isNotBlank()) Quote(d) { excluded -> composer.update { it.copy(quoteExcluded = excluded, dirty = true) } }

        if (d.attachments.isNotEmpty()) {
            FlowRow(Modifier.padding(top = 12.dp, bottom = 8.dp), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                for (a in d.attachments) AttachmentChip(a) { edit { it.copy(attachments = it.attachments - a) } }
            }
        }
        Spacer(Modifier.heightIn(min = 24.dp))
    }

    Hairline()
    BottomBar(app, d, onAttach = { picker.launch(arrayOf("*/*")) }, onShowCc = { askedCc = true }, onShowBcc = { askedBcc = true })

    // Replies start in the text, a new message or a forward at To; only the first time this draft opens.
    LaunchedEffect(d.id) {
        if (focused) return@LaunchedEffect
        focused = true
        runCatching {
            if (d.to.isEmpty() || d.replyKind == ReplyKind.FORWARD) toFocus.requestFocus() else bodyFocus.requestFocus()
        }
    }
}

/** From: the identity it sends as; with more than one, a tap picks another (composer.js:258-277). */
@Composable
private fun FromField(app: AppViewModel, d: ComposerState) {
    val c = Rk.colors
    val mail = app.services.mail
    val accounts by mail.accounts.collectAsStateWithLifecycle()
    val identities = remember(accounts) { accounts.flatMap { a -> mail.identities(a.id).map { a to it } } }
    var picking by remember { mutableStateOf(false) }
    val from = d.from ?: d.accountId?.let(app::defaultFrom)
    FieldRow(stringResource(R.string.reader_headers_from)) {
        Row(
            Modifier
                .weight(1f)
                .heightIn(min = 40.dp)
                .rkClickable(Rk.shapes.chip, enabled = identities.size > 1) { picking = true },
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(from?.display().orEmpty(), style = Rk.type.text13_5, color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
            if (identities.size > 1) RkIcon(RukooIcons.ChevronDown, null, Modifier.padding(start = 4.dp), size = 14.dp, tint = c.text3)
        }
    }
    if (picking) {
        RkBottomSheet(onDismissRequest = { picking = false }, title = stringResource(R.string.reader_headers_from)) {
            for ((account, identity) in identities) {
                SheetRow(
                    Address(identity.name, identity.address).display(),
                    hint = if (accounts.size > 1) account.email else null,
                    checked = d.accountId == account.id && from?.address.equals(identity.address, ignoreCase = true),
                    onClick = {
                        app.services.composer.update { it.copy(accountId = account.id, from = Address(identity.name, identity.address), dirty = true) }
                        dismiss()
                    },
                )
            }
        }
    }
}

/** A composer field (styles.css:2798-2835): a 76dp label column, then the input, over a hairline. */
@Composable
private fun FieldRow(label: String, content: @Composable androidx.compose.foundation.layout.RowScope.() -> Unit) {
    val c = Rk.colors
    Column {
        Row(Modifier.fillMaxWidth().heightIn(min = 44.dp).padding(vertical = 2.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(label, style = Rk.type.text12_5.medium, color = c.text2, modifier = Modifier.width(64.dp), maxLines = 1, overflow = TextOverflow.Ellipsis)
            content()
        }
        Hairline()
    }
}

/**
 * To, Cc or Bcc: the recipients as chips, then a field. A comma, semicolon or Enter (or a space after a
 * whole address) turns the text into a chip, and so does leaving the field. Suggestions from the contacts
 * show under it while typing.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun RecipientField(
    label: String,
    list: List<Address>,
    onChange: (List<Address>) -> Unit,
    contacts: List<Address>,
    focusRequester: FocusRequester? = null,
    trailing: @Composable () -> Unit = {},
) {
    val c = Rk.colors
    var text by rememberSaveable(label) { mutableStateOf("") }
    var hasFocus by remember { mutableStateOf(false) }
    val suggestions = remember(text, contacts, list) { Recipients.suggest(contacts, text, list) }
    fun commit() {
        val more = Recipients.parse(text)
        if (more.isNotEmpty()) onChange(Recipients.merge(list, more))
        text = ""
    }
    Column {
        Row(Modifier.fillMaxWidth().heightIn(min = 44.dp).padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(label, style = Rk.type.text12_5.medium, color = c.text2, modifier = Modifier.width(64.dp), maxLines = 1)
            FlowRow(
                Modifier.weight(1f),
                horizontalArrangement = Arrangement.spacedBy(4.dp),
                verticalArrangement = Arrangement.spacedBy(4.dp),
                itemVerticalAlignment = Alignment.CenterVertically,
            ) {
                for (a in list) RecipientChip(a) { onChange(list - a) }
                BasicTextField(
                    value = text,
                    onValueChange = { value ->
                        val (done, rest) = Recipients.split(value)
                        if (done.isNotEmpty()) onChange(Recipients.merge(list, done))
                        text = rest
                    },
                    singleLine = true,
                    textStyle = Rk.type.text13_5.copy(color = c.text),
                    cursorBrush = SolidColor(c.accent),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email, imeAction = ImeAction.Next, autoCorrectEnabled = false),
                    keyboardActions = KeyboardActions(onNext = { commit() }),
                    modifier = Modifier
                        .widthIn(min = 80.dp)
                        .heightIn(min = 32.dp)
                        .then(if (focusRequester != null) Modifier.focusRequester(focusRequester) else Modifier)
                        .onFocusChanged {
                            if (hasFocus && !it.isFocused) commit()
                            hasFocus = it.isFocused
                        }
                        .padding(vertical = 6.dp),
                )
            }
            Row(verticalAlignment = Alignment.CenterVertically) { trailing() }
        }
        if (hasFocus && suggestions.isNotEmpty()) {
            Column(
                Modifier
                    .fillMaxWidth()
                    .padding(start = 56.dp, bottom = 6.dp)
                    .background(c.raised, Rk.shapes.card)
                    .border(1.dp, c.border, Rk.shapes.card)
                    .padding(4.dp),
            ) {
                for (s in suggestions) {
                    Column(
                        Modifier
                            .fillMaxWidth()
                            .heightIn(min = 44.dp)
                            .rkClickable(Rk.shapes.chip) {
                                onChange(Recipients.merge(list, listOf(s)))
                                text = ""
                            }
                            .padding(horizontal = 10.dp, vertical = 6.dp),
                    ) {
                        Text(ListModel.person(s), style = Rk.type.text13, color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        if (s.name.isNotBlank()) Text(s.address, style = Rk.type.text12, color = c.text3, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
            }
        }
        Hairline()
    }
}

/** A recipient chip (styles.css:2850-2891): `chip` fill, the name, an x; an invalid address gets a red ring. */
@Composable
private fun RecipientChip(a: Address, onRemove: () -> Unit) {
    val c = Rk.colors
    val shape = RoundedCornerShape(14.dp)
    val valid = Recipients.isValid(a.address)
    Row(
        Modifier
            .heightIn(min = 28.dp)
            .background(c.chip, shape)
            .then(if (valid) Modifier else Modifier.border(1.5.dp, c.danger, shape))
            .padding(start = 10.dp, end = 3.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Text(ListModel.person(a), style = Rk.type.text12_5, color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.widthIn(max = 220.dp))
        val remove = stringResource(R.string.composer_recipient_remove, a.address)
        Box(
            Modifier.size(22.dp).rkClickable(CircleShape, onClick = onRemove).semantics { contentDescription = remove },
            contentAlignment = Alignment.Center,
        ) { RkIcon(RukooIcons.named("close", 2.2f), null, size = 11.dp, tint = c.text3) }
    }
}

@Composable
private fun SubjectField(subject: String, onChange: (String) -> Unit) {
    val c = Rk.colors
    var text by remember { mutableStateOf(subject) }
    // An agent's write lands in the controller; the field follows it.
    LaunchedEffect(subject) { if (subject != text) text = subject }
    FieldRow(stringResource(R.string.reader_headers_subject)) {
        BasicTextField(
            value = text,
            onValueChange = {
                text = it
                onChange(it)
            },
            singleLine = true,
            textStyle = Rk.type.text13_5.copy(color = c.text),
            cursorBrush = SolidColor(c.accent),
            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences, imeAction = ImeAction.Next),
            modifier = Modifier.weight(1f).padding(vertical = 10.dp),
        )
    }
}

/** The editor: 14.5 at line height 1.6, "Write your message" until there is text. */
@Composable
private fun BodyField(d: ComposerState, focus: FocusRequester, onChange: (String) -> Unit) {
    val c = Rk.colors
    var value by remember { mutableStateOf(TextFieldValue(d.body, TextRange(0))) }
    LaunchedEffect(d.body) { if (d.body != value.text) value = TextFieldValue(d.body, TextRange(d.body.length)) }
    val label = stringResource(R.string.composer_body_label)
    Box(Modifier.fillMaxWidth().padding(top = 14.dp)) {
        if (value.text.isEmpty()) Text(stringResource(R.string.composer_body_placeholder), style = Rk.type.emailBody, color = c.text3)
        BasicTextField(
            value = value,
            onValueChange = {
                val changed = it.text != value.text
                value = it
                if (changed) onChange(it.text)
            },
            textStyle = Rk.type.emailBody.copy(color = c.text),
            cursorBrush = SolidColor(c.accent),
            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
            minLines = 5,
            modifier = Modifier.fillMaxWidth().heightIn(min = 120.dp).focusRequester(focus).semantics { contentDescription = label },
        )
    }
}

/**
 * The quoted original (styles.css:2961-3018): behind a "···" pill; opened, it sits by a 2dp rail with
 * "Previous message" and the Exclude or Include link. An excluded quote is struck through on the pill and
 * dimmed when open; it is left out when the mail goes.
 */
@Composable
private fun Quote(d: ComposerState, onExclude: (Boolean) -> Unit) {
    val c = Rk.colors
    var open by rememberSaveable(d.id) { mutableStateOf(false) }
    Column(Modifier.padding(top = 12.dp)) {
        val pill = if (d.quoteExcluded) stringResource(R.string.composer_quote_excluded_pill) else "···"
        val pillLabel = stringResource(if (open) R.string.composer_quote_hide else R.string.composer_quote_show)
        Box(
            Modifier
                .heightIn(min = 24.dp)
                .background(c.chip, RoundedCornerShape(12.dp))
                .rkClickable(RoundedCornerShape(12.dp), onClickLabel = pillLabel) { open = !open }
                .semantics { contentDescription = pillLabel }
                .padding(horizontal = 10.dp),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                pill,
                style = Rk.type.text12.weight(700).copy(letterSpacing = androidx.compose.ui.unit.TextUnit(0.08f, androidx.compose.ui.unit.TextUnitType.Em), textDecoration = if (d.quoteExcluded) TextDecoration.LineThrough else null),
                color = c.text2,
                maxLines = 1,
            )
        }
        if (open) {
            val rail = c.borderStrong
            Column(
                Modifier
                    .padding(top = 10.dp)
                    .drawBehind { drawLine(rail, Offset(1.dp.toPx(), 0f), Offset(1.dp.toPx(), size.height), strokeWidth = 2.dp.toPx()) }
                    .padding(start = 14.dp),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(stringResource(R.string.composer_quote_title), style = Rk.type.text12, color = c.text3, modifier = Modifier.weight(1f))
                    RkLinkButton(
                        stringResource(if (d.quoteExcluded) R.string.composer_quote_include else R.string.composer_quote_exclude),
                        { onExclude(!d.quoteExcluded) },
                        style = Rk.type.text12,
                    )
                }
                androidx.compose.foundation.text.selection.SelectionContainer {
                    Text(
                        d.quote,
                        style = Rk.type.text13,
                        color = c.text2,
                        modifier = Modifier.padding(top = 4.dp).alpha(if (d.quoteExcluded) 0.4f else 1f),
                    )
                }
            }
        }
    }
}

/** An attachment chip (styles.css:3019-3072): clip icon, name, size and a remove button. */
@Composable
private fun AttachmentChip(a: OutgoingAttachment, onRemove: () -> Unit) {
    val c = Rk.colors
    val shape = Rk.shapes.control
    val locale = LocalConfiguration.current.locales[0]
    Row(
        Modifier
            .heightIn(min = 32.dp)
            .widthIn(max = 320.dp)
            .background(c.panel2, shape)
            .border(1.dp, c.border, shape)
            .padding(start = 8.dp, end = 3.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        RkIcon(RukooIcons.Clip, null, size = 14.dp, tint = c.text3)
        Text(a.filename, style = Rk.type.text12_5, color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
        if (a.size > 0) Text(MailDates.fileSize(a.size, locale), style = Rk.type.text11_5.tabular, color = c.text3, maxLines = 1)
        RkIconButton(RukooIcons.Close, stringResource(R.string.composer_attachments_remove, a.filename), onClick = onRemove, size = nl.bvdm.rukoo.ui.components.RkIconButtonSize.XS)
    }
}

/**
 * The bottom bar (composer.js:324-334): Attach files, Delete draft and More, then the agent's mark with its
 * Undo and the save state, then Send. Under 440dp the mark keeps only its sparkle and Undo.
 */
@Composable
private fun BottomBar(app: AppViewModel, d: ComposerState, onAttach: () -> Unit, onShowCc: () -> Unit, onShowBcc: () -> Unit) {
    val c = Rk.colors
    val savedAt by app.services.composer.savedAt.collectAsStateWithLifecycle()
    val dates = rememberMailDates()
    var menu by remember { mutableStateOf(false) }
    BoxWithConstraints(Modifier.fillMaxWidth()) {
        val narrow = maxWidth < 440.dp
        Row(Modifier.fillMaxWidth().heightIn(min = 56.dp).padding(start = 6.dp, end = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            RkIconButton(RukooIcons.Clip, stringResource(R.string.composer_attachments_pick), onClick = onAttach)
            RkIconButton(RukooIcons.Trash, stringResource(R.string.composer_actions_discard), onClick = app::discardDraft)
            Box {
                RkIconButton(RukooIcons.More, stringResource(R.string.common_actions_more_options), onClick = { menu = true })
                RkDropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                    RkMenuItem(stringResource(R.string.composer_actions_save_draft), icon = RukooIcons.Drafts, onClick = {
                        menu = false
                        app.saveDraft()
                    })
                    RkMenuItem(stringResource(R.string.composer_actions_add_cc), icon = RukooIcons.Person, onClick = {
                        menu = false
                        onShowCc()
                    })
                    RkMenuItem(stringResource(R.string.composer_actions_add_bcc), icon = RukooIcons.People, onClick = {
                        menu = false
                        onShowBcc()
                    })
                    RkMenuItem(stringResource(R.string.composer_actions_discard), icon = RukooIcons.Trash, danger = true, onClick = {
                        menu = false
                        app.discardDraft()
                    })
                }
            }
            Row(Modifier.weight(1f).padding(horizontal = 6.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                val agent = d.draftedBy ?: d.editedAgent
                if (agent != null) {
                    RkIcon(RukooIcons.Sparkle, null, size = 14.dp, tint = c.accent)
                    if (!narrow) {
                        Text(
                            stringResource(if (d.draftedBy != null) R.string.composer_agent_drafted else R.string.composer_agent_drafted_edited, agent),
                            style = Rk.type.text12,
                            color = c.text2,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.weight(1f, fill = false),
                        )
                    }
                    RkLinkButton(stringResource(R.string.composer_agent_undo), app::undoAgentDraft, style = Rk.type.text12)
                } else if (savedAt != null && d.dirty) {
                    Text(stringResource(R.string.composer_status_saved_at, dates.time(savedAt!!)), style = Rk.type.text12, color = c.text3, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
            RkButton(
                if (app.sending) stringResource(R.string.composer_status_sending) else stringResource(R.string.composer_actions_send),
                onClick = app::send,
                kind = RkButtonKind.PRIMARY,
                size = RkButtonSize.LARGE,
                trailingIcon = RukooIcons.Send,
                enabled = !app.sending,
            )
        }
    }
}

/** Copies a picked file into the app's storage, where Send (and the FileProvider) can read it. */
private fun copyIn(context: Context, uri: Uri, composerId: String): OutgoingAttachment? {
    val resolver = context.contentResolver
    var name = "file"
    var size = 0L
    resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { cursor ->
        if (cursor.moveToFirst()) {
            cursor.getString(0)?.let { name = it }
            if (!cursor.isNull(1)) size = cursor.getLong(1)
        }
    }
    // A name from another app is a file name here, never a path.
    val safe = name.replace(Regex("[\\\\/:*?\"<>|\\p{Cntrl}]"), "_").trim().ifEmpty { "file" }.take(150)
    val dir = File(context.filesDir, "attachments/compose/$composerId/${Ids.rand(8)}").apply { mkdirs() }
    val file = File(dir, safe)
    resolver.openInputStream(uri)?.use { input -> file.outputStream().use { input.copyTo(it) } } ?: return null
    return OutgoingAttachment(safe, resolver.getType(uri) ?: "application/octet-stream", file.absolutePath, if (size > 0) size else file.length())
}
