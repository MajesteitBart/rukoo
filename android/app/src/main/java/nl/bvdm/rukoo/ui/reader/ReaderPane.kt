package nl.bvdm.rukoo.ui.reader

import android.content.ClipData
import android.content.ClipboardManager
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import nl.bvdm.rukoo.R
import nl.bvdm.rukoo.agents.model.Conversation
import nl.bvdm.rukoo.agents.model.MessageRef
import nl.bvdm.rukoo.agents.model.Unread
import nl.bvdm.rukoo.mail.model.Address
import nl.bvdm.rukoo.mail.model.FolderRole
import nl.bvdm.rukoo.mail.model.FullMessage
import nl.bvdm.rukoo.mail.model.MailView
import nl.bvdm.rukoo.mail.model.MessageIds
import nl.bvdm.rukoo.mail.model.MessageSummary
import nl.bvdm.rukoo.mail.model.ReplyKind
import nl.bvdm.rukoo.ui.ComposerState
import nl.bvdm.rukoo.ui.Mailto
import nl.bvdm.rukoo.ui.components.Avatar
import nl.bvdm.rukoo.ui.components.AvatarSize
import nl.bvdm.rukoo.ui.components.EmptyState
import nl.bvdm.rukoo.ui.components.Hairline
import nl.bvdm.rukoo.ui.components.NewsDot
import nl.bvdm.rukoo.ui.components.NewsTone
import nl.bvdm.rukoo.ui.components.RkBottomSheet
import nl.bvdm.rukoo.ui.components.RkChipButton
import nl.bvdm.rukoo.ui.components.RkIcon
import nl.bvdm.rukoo.ui.components.RkIconButton
import nl.bvdm.rukoo.ui.components.RkPillButton
import nl.bvdm.rukoo.ui.components.RkPillKind
import nl.bvdm.rukoo.ui.components.RkToolbarButton
import nl.bvdm.rukoo.ui.components.SheetDivider
import nl.bvdm.rukoo.ui.components.SheetRow
import nl.bvdm.rukoo.ui.components.rkClickable
import nl.bvdm.rukoo.ui.icons.RukooIcons
import nl.bvdm.rukoo.ui.mail.ListModel
import nl.bvdm.rukoo.ui.mail.rememberMailDates
import nl.bvdm.rukoo.ui.root.AppViewModel
import nl.bvdm.rukoo.ui.root.Pane
import nl.bvdm.rukoo.ui.theme.Rk
import nl.bvdm.rukoo.ui.theme.lineHeight
import nl.bvdm.rukoo.ui.theme.medium
import nl.bvdm.rukoo.ui.theme.semibold
import nl.bvdm.rukoo.ui.theme.title
import nl.bvdm.rukoo.ui.theme.weight

private sealed interface Load {
    data object Loading : Load

    data class Ready(val message: FullMessage) : Load

    /** [gone]: the message no longer exists (deleted, moved, a draft replaced by its new copy). */
    data class Failed(val error: String, val gone: Boolean = false) : Load
}

/**
 * The reader (spec 6 §4.4 and §5.2): a top bar with Back, the subject once the header scrolls away, Archive,
 * Delete, Move, Mark unread and More; the header with sender, recipients and the details box; the Unsubscribe
 * chip; attachments; the body in a script-free WebView; and a bottom bar with Reply, Reply all, Forward and
 * the agent pill. With several emails checked on the inner screen it shows what the selection can do.
 */
@Composable
fun ReaderPane(app: AppViewModel, messageId: String?, modifier: Modifier = Modifier) {
    val nav by app.state.collectAsStateWithLifecycle()
    Box(modifier.background(Rk.colors.panel)) {
        when {
            app.twoPane && nav.checked.size > 1 -> MultiSummary(app, nav.checked)
            messageId == null -> EmptyReader()
            else -> key(messageId) { Reader(app, messageId) }
        }
    }
}

@Composable
private fun EmptyReader() {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        EmptyState(stringResource(R.string.reader_empty_title), icon = RukooIcons.MailOpen, modifier = Modifier.alpha(0.85f))
    }
}

@Composable
private fun Reader(app: AppViewModel, id: String) {
    val c = Rk.colors
    val mail = app.services.mail
    val ui = app.mailUi
    val context = LocalContext.current
    val density = LocalDensity.current
    val settings by app.services.settingsSnapshot.collectAsStateWithLifecycle()
    val load by produceState<Load>(Load.Loading, id) {
        value = try {
            Load.Ready(mail.fullMessage(id))
        } catch (e: Exception) {
            Load.Failed(e.message ?: e.javaClass.simpleName, gone = (e as? nl.bvdm.rukoo.mail.MailException)?.code == "missing")
        }
    }
    // A message that isn't there any more closes the reader, as one that leaves while it is open does.
    LaunchedEffect(load) { if ((load as? Load.Failed)?.gone == true) app.messageGone(id) }
    // The row as it is now (star, read), and whether it is still there.
    var seen by remember { mutableStateOf(false) }
    val live by produceState<MessageSummary?>(null, id) {
        val key = MessageIds.decode(id) ?: return@produceState
        mail.messages(MailView.folder(key.accountId, key.folder)).collect { list ->
            value = list.firstOrNull { it.id == id }
            if (value != null) seen = true
        }
    }
    // It moved away (an agent, another device): the reader lets go of it.
    LaunchedEffect(seen, live) { if (seen && live == null) app.messageGone(id) }

    val full = (load as? Load.Ready)?.message
    val m: MessageSummary? = live ?: full?.summary
    val scroll = rememberSaveable(id, saver = androidx.compose.foundation.ScrollState.Saver) { androidx.compose.foundation.ScrollState(0) }
    val scrolled by remember { derivedStateOf { scroll.value > with(density) { 56.dp.toPx() } } }
    var more by remember { mutableStateOf(false) }
    var source by remember { mutableStateOf(false) }
    var person by remember { mutableStateOf<Address?>(null) }
    val draft = m?.role == FolderRole.DRAFTS
    val canArchive = m != null && !draft && m.role != FolderRole.ARCHIVE && m.role != FolderRole.ALL && mail.archiveFolder(m.accountId) != null

    Column(Modifier.fillMaxSize()) {
        // Top bar (readerBar, app.js:1876-1904), 56dp with a hairline.
        Row(Modifier.fillMaxWidth().heightIn(min = 56.dp).padding(horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            if (!app.twoPane) RkIconButton(RukooIcons.Back, stringResource(R.string.reader_navigation_back), onClick = { app.back() })
            val subjectAlpha by animateFloatAsState(if (scrolled) 1f else 0f, Rk.motion.tween(140, nl.bvdm.rukoo.ui.theme.RukooEasing.Css), label = "subject")
            Text(
                m?.subject.orEmpty(),
                style = Rk.type.text14.semibold,
                color = c.text,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f).padding(horizontal = 8.dp).graphicsLayer {
                    alpha = subjectAlpha
                    translationY = (1f - subjectAlpha) * 4.dp.toPx()
                },
            )
            if (m != null) {
                if (draft) {
                    // The draft's From, attachments and quote come along; sending or saving replaces the stored copy.
                    RkToolbarButton(stringResource(R.string.reader_actions_edit), RukooIcons.Edit, primary = true, onClick = { app.editDraft(m.id) })
                    RkIconButton(RukooIcons.Trash, stringResource(R.string.common_actions_delete), onClick = { ui.delete(listOf(m)) })
                } else {
                    if (canArchive) RkIconButton(RukooIcons.Archive, stringResource(R.string.common_actions_archive), onClick = { ui.archive(listOf(m)) })
                    RkIconButton(RukooIcons.Trash, stringResource(R.string.common_actions_delete), onClick = { ui.delete(listOf(m)) })
                    RkIconButton(RukooIcons.Move, stringResource(R.string.common_actions_move), onClick = { ui.pickFolder(listOf(m)) })
                    RkIconButton(RukooIcons.MarkUnread, stringResource(R.string.mailbox_actions_unread), onClick = {
                        ui.setUnread(listOf(m), true)
                        // One pane goes back to the list; beside the list the email stays open, as on desktop.
                        if (!app.twoPane) app.back()
                    })
                }
                RkIconButton(RukooIcons.More, stringResource(R.string.reader_actions_more), onClick = { more = true })
            }
        }
        Hairline()

        Box(Modifier.weight(1f).fillMaxWidth()) {
            when (val l = load) {
                Load.Loading -> LoadingBar()
                is Load.Failed -> Text(l.error, style = Rk.type.text13, color = c.danger, modifier = Modifier.padding(20.dp))
                is Load.Ready -> Column(
                    Modifier.fillMaxSize().verticalScroll(scroll).padding(start = 16.dp, end = 16.dp, top = 16.dp, bottom = 32.dp),
                ) {
                    Header(app, l.message, m ?: l.message.summary, onPerson = { person = it })
                    if (l.message.attachments.isNotEmpty()) {
                        ReaderAttachments(mail, id, l.message.attachments, ui.toasts, Modifier.padding(top = 14.dp))
                    }
                    Spacer(Modifier.height(16.dp))
                    MailBody(
                        html = l.message.html,
                        isHtml = l.message.isHtml,
                        light = !c.isDark,
                        darkEmails = settings.darkEmails,
                        label = stringResource(R.string.reader_content_label),
                        onLink = { uri -> openMailLink(context, uri) { url -> app.newMessage(Mailto.parse(url)) } },
                    )
                }
            }
        }

        if (m != null && !draft) {
            Hairline()
            BottomBar(app, m)
        }
    }

    if (more && m != null) {
        RkBottomSheet(onDismissRequest = { more = false }) {
            if (!draft) {
                SheetRow(
                    stringResource(if (m.starred) R.string.mailbox_actions_unstar else R.string.mailbox_actions_add_star),
                    icon = if (m.starred) RukooIcons.StarFilled else RukooIcons.Star,
                    onClick = {
                        ui.setStarred(listOf(m), !m.starred)
                        dismiss()
                    },
                )
                SheetRow(stringResource(R.string.mail_agent_add_to_chat), icon = RukooIcons.Sparkle, onClick = {
                    dismiss()
                    app.addToChat(listOf(id))
                })
                // Inbox mail while categories are on, as desktop's messageMenu offers it.
                if (remember(m) { ui.categoriesOf(listOf(m)).isNotEmpty() }) {
                    SheetRow(stringResource(R.string.mailbox_categories_move), icon = RukooIcons.Inbox, onClick = {
                        dismiss()
                        ui.pickCategory(listOf(m))
                    })
                }
            } else {
                // A draft has no bottom bar, so its Previous and Next stay here.
                val prev = app.neighbour(id, -1)
                val next = app.neighbour(id, 1)
                SheetRow(stringResource(R.string.reader_navigation_previous), icon = RukooIcons.Up, enabled = prev != null, onClick = {
                    dismiss()
                    prev?.let(app::openMessage)
                })
                SheetRow(stringResource(R.string.reader_navigation_next), icon = RukooIcons.Down, enabled = next != null, onClick = {
                    dismiss()
                    next?.let(app::openMessage)
                })
            }
            SheetRow(stringResource(R.string.reader_source_show), icon = RukooIcons.Code, onClick = {
                dismiss()
                source = true
            })
            SheetDivider()
            SheetRow(stringResource(R.string.common_actions_delete), icon = RukooIcons.Trash, danger = true, onClick = {
                dismiss()
                ui.delete(listOf(m))
            })
        }
    }

    if (source) SourceSheet(app, id) { source = false }

    person?.let { who ->
        RkBottomSheet(onDismissRequest = { person = null }, title = who.display()) {
            SheetRow(stringResource(R.string.composer_titles_new), icon = RukooIcons.Compose, onClick = {
                dismiss()
                val accountId = m?.accountId
                app.openComposer(ComposerState(accountId = accountId, from = accountId?.let(app::defaultFrom), to = listOf(who)))
            })
            SheetRow(stringResource(R.string.reader_address_copy), icon = RukooIcons.Link, onClick = {
                context.getSystemService(ClipboardManager::class.java)?.setPrimaryClip(ClipData.newPlainText(who.address, who.address))
                ui.toasts.showToast(context.getString(R.string.reader_address_copied))
                dismiss()
            })
        }
    }
}

/**
 * The message header (renderReader): the subject with the star, the sender with its avatar and the date, the
 * recipient summary that opens the details box, and the Unsubscribe chip on a line of its own (spec 6 §5.2).
 */
@Composable
private fun Header(app: AppViewModel, full: FullMessage, m: MessageSummary, onPerson: (Address) -> Unit) {
    val c = Rk.colors
    val dates = rememberMailDates()
    val now = remember { System.currentTimeMillis() }
    var details by rememberSaveable(full.id) { mutableStateOf(false) }
    val draft = m.role == FolderRole.DRAFTS
    val accounts by app.services.mail.accounts.collectAsStateWithLifecycle()
    val own = remember(accounts) {
        accounts.flatMap { a -> listOf(a.email) + app.services.mail.identities(a.id).map { it.address } }.map { it.lowercase() }.toSet()
    }
    Column {
        Row(verticalAlignment = Alignment.Top) {
            SelectionContainer(Modifier.weight(1f)) {
                Text(full.subject.ifBlank { stringResource(R.string.mailbox_message_no_subject) }, style = Rk.type.readerSubject, color = c.text)
            }
            if (!draft) {
                RkIconButton(
                    if (m.starred) RukooIcons.StarFilled else RukooIcons.Star,
                    stringResource(if (m.starred) R.string.mailbox_actions_unstar else R.string.mailbox_actions_add_star),
                    onClick = { app.mailUi.setStarred(listOf(m), !m.starred) },
                    tint = if (m.starred) c.star else null,
                    modifier = Modifier.offset(x = 8.dp, y = (-6).dp),
                )
            }
        }
        Row(Modifier.padding(top = 14.dp), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.Top) {
            val who = if (draft) full.to.firstOrNull() ?: full.from else full.from
            Avatar(who.name, who.address, size = AvatarSize.Large)
            Column(Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Row(Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically) {
                        if (draft) {
                            Text(stringResource(R.string.composer_titles_draft), style = Rk.type.text13.semibold, color = c.danger)
                        } else {
                            Text(
                                ListModel.person(full.from).ifEmpty { stringResource(R.string.mailbox_message_unknown_sender) },
                                style = Rk.type.text13_5.title,
                                color = c.text,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                                modifier = Modifier.weight(1f, fill = false).rkClickable(Rk.shapes.chip) { onPerson(full.from) },
                            )
                            if (m.vip) {
                                Spacer(Modifier.width(6.dp))
                                Text(
                                    stringResource(R.string.mailbox_message_vip),
                                    style = Rk.type.text11.weight(650),
                                    color = c.accent,
                                    modifier = Modifier.background(c.accentSoft, RoundedCornerShape(5.dp)).padding(horizontal = 6.dp, vertical = 1.dp),
                                )
                            }
                        }
                    }
                    Text(dates.readerDate(full.date, now), style = Rk.type.text12, color = c.text3, maxLines = 1, modifier = Modifier.padding(start = 8.dp))
                }
                RecipientSummary(full, own, details) { details = !details }
            }
        }
        if (full.unsubscribe != null && !draft) {
            RkChipButton(
                stringResource(R.string.reader_unsubscribe_action),
                icon = RukooIcons.Unsubscribe,
                onClick = { app.mailUi.unsubscribe(m, full.unsubscribe.oneClick || full.unsubscribe.url != null) },
                modifier = Modifier.padding(start = 52.dp, top = 8.dp),
            )
        }
        if (details) Details(full, dates, onPerson, Modifier.padding(top = 10.dp))
        Spacer(Modifier.height(14.dp))
        Hairline()
    }
}

/** "to me, Joris Bakker" with a chevron (app.js recipientsHtml): own addresses become "me", three names at most. */
@Composable
private fun RecipientSummary(full: FullMessage, own: Set<String>, open: Boolean, onToggle: () -> Unit) {
    val c = Rk.colors
    val me = stringResource(R.string.reader_recipients_me)
    val all = full.to + full.cc + full.bcc
    val names = all.map { if (it.address.lowercase() in own) me else ListModel.person(it) }.distinct()
    val others = if (names.size > 3) pluralStringResource(R.plurals.reader_recipients_others, names.size - 3, names.size - 3) else ""
    val text = if (all.isEmpty()) stringResource(R.string.reader_recipients_unknown) else stringResource(R.string.reader_recipients_summary, names.take(3).joinToString(", ") + others)
    val rotation by animateFloatAsState(if (open) 180f else 0f, Rk.motion.tween(300, nl.bvdm.rukoo.ui.theme.RukooEasing.Default), label = "chevron")
    Row(
        Modifier
            .heightIn(min = 32.dp)
            .rkClickable(Rk.shapes.chip, onClickLabel = stringResource(if (open) R.string.reader_details_hide else R.string.reader_details_show), onClick = onToggle)
            .padding(end = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Text(text, style = Rk.type.text12_5, color = c.text2, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
        RkIcon(RukooIcons.ChevronDown, null, Modifier.rotate(rotation), size = 14.dp, tint = c.text3)
    }
}

/** The details box (app.js detailsHtml): From, To, Cc, Bcc, Reply to when it differs, and the long date. */
@Composable
private fun Details(full: FullMessage, dates: nl.bvdm.rukoo.ui.mail.MailDates, onPerson: (Address) -> Unit, modifier: Modifier) {
    val c = Rk.colors
    val replyTo = full.replyTo.filter { !it.address.equals(full.from.address, ignoreCase = true) }
    val rows = buildList {
        add(stringResource(R.string.reader_headers_from) to listOf(full.from))
        if (full.to.isNotEmpty()) add(stringResource(R.string.reader_headers_to) to full.to)
        if (full.cc.isNotEmpty()) add(stringResource(R.string.reader_headers_cc) to full.cc)
        if (full.bcc.isNotEmpty()) add(stringResource(R.string.reader_headers_bcc) to full.bcc)
        if (replyTo.isNotEmpty()) add(stringResource(R.string.reader_headers_reply_to) to replyTo)
    }
    Column(
        modifier.fillMaxWidth().background(c.panel2, Rk.shapes.card).padding(horizontal = 12.dp, vertical = 10.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        for ((label, people) in rows) {
            DetailRow(label) {
                Column {
                    for (a in people) {
                        Text(
                            a.display(),
                            style = Rk.type.text12_5,
                            color = c.text,
                            modifier = Modifier.rkClickable(Rk.shapes.chip) { onPerson(a) },
                        )
                    }
                }
            }
        }
        DetailRow(stringResource(R.string.reader_headers_date)) {
            SelectionContainer { Text(dates.longDate(full.date), style = Rk.type.text12_5, color = c.text) }
        }
    }
}

@Composable
private fun DetailRow(label: String, value: @Composable () -> Unit) {
    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(label, style = Rk.type.text12_5, color = Rk.colors.text3, modifier = Modifier.width(72.dp), maxLines = 1, overflow = TextOverflow.Ellipsis)
        Box(Modifier.weight(1f)) { value() }
    }
}

/**
 * The bottom bar (spec 6 §5.2): Reply with its label, Reply all and Forward, then the agent pill with the
 * agent's name, which opens the chat about this email (the existing one when there is one).
 */
@Composable
private fun BottomBar(app: AppViewModel, m: MessageSummary) {
    val c = Rk.colors
    val hub = app.services.agents
    val agents by hub.agents.collectAsStateWithLifecycle()
    val agentSettings by app.services.agentSettings.settings.collectAsStateWithLifecycle()
    val rows by hub.conversations.collectAsStateWithLifecycle()
    val ref = remember(m.id) { MessageRef(m.id, m.messageId, m.accountId, m.subject, m.from, m.date, inReplyTo = m.inReplyTo) }
    val existing by produceState<Conversation?>(null, m.id, rows) { value = runCatching { hub.findFor(ref) }.getOrNull() }
    val agentId = existing?.agent ?: agentSettings.defaultAgent
    val name = agents.firstOrNull { it.id == agentId }?.name?.ifBlank { null } ?: runCatching { hub.agentName(agentId) }.getOrDefault(agentId)
    val chatAbout = stringResource(R.string.mail_agent_chat_about, name)
    val row = existing?.let { e -> rows.firstOrNull { it.id == e.id } }
    val news = when {
        row == null -> null
        row.waiting -> NewsTone.WAITING
        row.unread != Unread.NONE -> NewsTone.UNREAD
        else -> null
    }
    // The agent button gets at most what is left once the five buttons have their 48dp, so a long agent name or
    // a large font shortens the name instead of taking Reply's icon.
    BoxWithConstraints(Modifier.fillMaxWidth()) {
        val pillMax = (maxWidth - BottomBarReserved).coerceIn(56.dp, 180.dp)
        Row(
            Modifier.fillMaxWidth().heightIn(min = 56.dp).padding(start = 6.dp, end = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            // Measured after the rest of the bar, so on a narrow screen or in a longer language Reply gives up its
            // label before the agent's name gives up room.
            Row(Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically) {
                RkToolbarButton(
                    stringResource(R.string.composer_titles_reply),
                    RukooIcons.Reply,
                    onClick = {
                        app.interacted(Pane.READER)
                        app.reply(m.id, ReplyKind.REPLY)
                    },
                    modifier = Modifier.weight(1f, fill = false),
                    collapsible = true,
                )
                RkIconButton(RukooIcons.ReplyAll, stringResource(R.string.composer_titles_reply_all), onClick = { app.reply(m.id, ReplyKind.REPLY_ALL) })
                RkIconButton(RukooIcons.Forward, stringResource(R.string.composer_titles_forward), onClick = { app.reply(m.id, ReplyKind.FORWARD) })
            }
            // Previous and Next in the corner the thumb reaches, the way the list runs: up is the newer email.
            val prev = app.neighbour(m.id, -1)
            val next = app.neighbour(m.id, 1)
            RkIconButton(RukooIcons.Up, stringResource(R.string.reader_navigation_previous), enabled = prev != null, onClick = { prev?.let(app::openMessage) })
            RkIconButton(RukooIcons.Down, stringResource(R.string.reader_navigation_next), enabled = next != null, onClick = { next?.let(app::openMessage) })
            Spacer(Modifier.width(8.dp))
            Box {
                RkPillButton(
                    name,
                    onClick = { app.openChat(existing?.id, m.id) },
                    kind = RkPillKind.SECONDARY,
                    icon = RukooIcons.Sparkle,
                    modifier = Modifier.widthIn(max = pillMax).semantics { contentDescription = chatAbout },
                )
                if (news != null) NewsDot(news, ring = c.panel, modifier = Modifier.align(Alignment.TopEnd).offset(x = (-6).dp, y = 6.dp))
            }
        }
    }
}

/** The bottom bar's room that isn't the agent button's: its padding, five 48dp buttons and the gap before the button. */
private val BottomBarReserved = 6.dp + 10.dp + 48.dp * 5 + 8.dp

/** The message's own headers, for checking where it came from (instead of desktop's Export as .eml). */
@Composable
private fun SourceSheet(app: AppViewModel, id: String, onDismiss: () -> Unit) {
    val c = Rk.colors
    val text by produceState<String?>(null, id) {
        value = runCatching {
            val raw = app.services.mail.rawSource(id)
            withContext(Dispatchers.Default) {
                val all = String(raw, Charsets.ISO_8859_1)
                val end = all.indexOf("\r\n\r\n").takeIf { it >= 0 } ?: all.indexOf("\n\n").takeIf { it >= 0 } ?: all.length
                all.substring(0, end).take(40_000)
            }
        }.getOrElse { it.message ?: it.javaClass.simpleName }
    }
    RkBottomSheet(onDismissRequest = onDismiss, title = stringResource(R.string.reader_source_show)) {
        Box(Modifier.fillMaxWidth().heightIn(min = 120.dp, max = 520.dp).padding(horizontal = 16.dp, vertical = 8.dp)) {
            val t = text
            if (t == null) {
                LoadingBar()
            } else {
                SelectionContainer(Modifier.verticalScroll(rememberScrollState())) {
                    Text(t, style = Rk.type.mono.lineHeight(1.5f), color = c.text2)
                }
            }
        }
    }
}

/** Several emails checked on the inner screen (app.js:1910-1924): a stack of cards, the count, and what to do. */
@Composable
private fun MultiSummary(app: AppViewModel, checked: List<String>) {
    val c = Rk.colors
    val mail = app.services.mail
    val list by produceState(emptyList<MessageSummary>(), checked) { value = checked.mapNotNull { runCatching { mail.summary(it) }.getOrNull() } }
    val ui = app.mailUi
    val anyUnread = list.any { it.unread }
    val canArchive = list.any { mail.archiveFolder(it.accountId) != null && it.role != FolderRole.ARCHIVE && it.role != FolderRole.ALL }
    Column(Modifier.fillMaxSize().padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
        Box(Modifier.size(width = 72.dp, height = 60.dp)) {
            for (i in 2 downTo 0) {
                Box(
                    Modifier
                        .align(Alignment.Center)
                        .offset(x = (i * 6).dp, y = (-i * 6).dp)
                        .size(width = 56.dp, height = 40.dp)
                        .alpha(1f - i * 0.25f)
                        .background(c.panel2, Rk.shapes.card)
                        .border(1.dp, c.border, Rk.shapes.card),
                )
            }
        }
        Spacer(Modifier.height(14.dp))
        Text(pluralStringResource(R.plurals.mailbox_selection_summary, checked.size, checked.size), style = Rk.type.text14.semibold, color = c.text2)
        Spacer(Modifier.height(14.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            RkToolbarButton(
                stringResource(if (anyUnread) R.string.mailbox_message_read else R.string.mailbox_filters_unread),
                if (anyUnread) RukooIcons.MailOpen else RukooIcons.MarkUnread,
                onClick = { ui.setUnread(list, !anyUnread) },
            )
            RkToolbarButton(stringResource(R.string.common_actions_move), RukooIcons.Move, onClick = { ui.pickFolder(list) })
            if (canArchive) RkToolbarButton(stringResource(R.string.common_actions_archive), RukooIcons.Archive, onClick = { ui.archive(list) })
            RkToolbarButton(stringResource(R.string.common_actions_delete), RukooIcons.Trash, danger = true, onClick = { ui.delete(list) })
        }
        Spacer(Modifier.height(8.dp))
        nl.bvdm.rukoo.ui.components.RkLinkButton(stringResource(R.string.mailbox_selection_clear), onClick = app::clearChecked)
    }
}
