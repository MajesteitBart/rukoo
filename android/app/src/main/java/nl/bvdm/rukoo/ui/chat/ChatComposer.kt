package nl.bvdm.rukoo.ui.chat

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Text
import androidx.compose.material3.minimumInteractiveComponentSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.isShiftPressed
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.OffsetMapping
import androidx.compose.ui.text.input.TransformedText
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import nl.bvdm.rukoo.R
import nl.bvdm.rukoo.ui.components.Avatar
import nl.bvdm.rukoo.ui.components.Hairline
import nl.bvdm.rukoo.ui.components.RkButton
import nl.bvdm.rukoo.ui.components.RkButtonKind
import nl.bvdm.rukoo.ui.components.RkButtonSize
import nl.bvdm.rukoo.ui.components.RkIcon
import nl.bvdm.rukoo.ui.components.popIn
import nl.bvdm.rukoo.ui.components.pressScale
import nl.bvdm.rukoo.ui.components.rkClickable
import nl.bvdm.rukoo.ui.icons.PanelIcons
import nl.bvdm.rukoo.ui.root.AppViewModel
import nl.bvdm.rukoo.ui.root.ChatPane
import nl.bvdm.rukoo.ui.theme.Rk
import nl.bvdm.rukoo.ui.theme.lineHeight
import nl.bvdm.rukoo.ui.theme.medium
import nl.bvdm.rukoo.ui.theme.rkSurface
import nl.bvdm.rukoo.ui.theme.tabular
import nl.bvdm.rukoo.workspaces.Channel
import nl.bvdm.rukoo.workspaces.Draft
import nl.bvdm.rukoo.workspaces.Event
import nl.bvdm.rukoo.workspaces.Member
import nl.bvdm.rukoo.workspaces.MentionSpan
import nl.bvdm.rukoo.workspaces.Room
import nl.bvdm.rukoo.workspaces.RoomKind

/** What sits where the composer goes (contract §5.5 table, §7.4): the composer, or a bar saying why nothing can be sent. */
sealed interface ComposerSlot {
    data object Composer : ComposerSlot

    /** A channel the person isn't in yet, opened before joining. */
    data class NotJoined(val channel: Channel) : ComposerSlot

    data object Archived : ComposerSlot

    /** A closed DM, with its reason (`left`, `ineligible` or `closed`). */
    data class Closed(val reason: String?) : ComposerSlot

    /** The workspace stopped syncing (quarantine); its banner has Start over. */
    data object Paused : ComposerSlot

    /** The server needs a newer Rukoo (426, §3.6): the history stays readable, nothing can be written. */
    data object Upgrade : ComposerSlot

    /** A thread whose first message was removed. */
    data object RootRemoved : ComposerSlot
}

/** The line on a closed DM's bar: you blocked someone in it, or the reason it closed. */
enum class ClosedText { YOU_BLOCKED, LEFT, INELIGIBLE, CLOSED }

/** A closed DM's bar: its line, the person you blocked in it (Unblock), and whether a new conversation can start. */
data class ClosedBar(val text: ClosedText, val blocked: String?, val startNew: Boolean)

/**
 * Which [ComposerSlot] a room or thread gets, pure for the tests. A workspace that needs a newer Rukoo ([upgrade])
 * takes every write away, Join included; a stopped workspace wins over the room's own state and over Join, as its
 * banner offers Start over and nothing else can be written there.
 */
object ComposerSlots {
    fun of(room: Room?, notJoined: Channel? = null, paused: Boolean = false, rootRemoved: Boolean = false, upgrade: Boolean = false): ComposerSlot = when {
        upgrade -> ComposerSlot.Upgrade
        paused -> ComposerSlot.Paused
        room == null && notJoined != null -> ComposerSlot.NotJoined(notJoined)
        room == null -> ComposerSlot.Composer
        room.kind == RoomKind.CHANNEL && room.archived -> ComposerSlot.Archived
        room.kind == RoomKind.DM && (room.closedReason != null || room.archived) -> ComposerSlot.Closed(room.closedReason)
        rootRemoved -> ComposerSlot.RootRemoved
        else -> ComposerSlot.Composer
    }

    /**
     * What a closed DM's bar says and offers (desktop chat-model.js closedBar). [ClosedBar.blocked]: the first person in
     * it that [me] blocked, by name, whose bar says so and offers Unblock. [ClosedBar.startNew]: Start a new conversation,
     * only for a full member when every other person is an active full member nobody here blocked, because the server
     * refuses anything else. A block from the other side keeps the neutral line: the app doesn't know about it.
     */
    fun closedBar(room: Room, me: String?, members: Map<String, Member>, blocked: Set<String>, full: Boolean, compare: Comparator<String> = compareBy { it.lowercase() }): ClosedBar {
        val others = room.participants.orEmpty().distinct().filter { it != me }
        val mine = others.filter { it in blocked }.sortedWith { a, b -> compare.compare(members[a]?.name.orEmpty(), members[b]?.name.orEmpty()) }.firstOrNull()
        val text = when {
            mine != null -> ClosedText.YOU_BLOCKED
            room.closedReason == "left" -> ClosedText.LEFT
            room.closedReason == "ineligible" -> ClosedText.INELIGIBLE
            else -> ClosedText.CLOSED
        }
        val startNew = full && others.isNotEmpty() && others.all { id ->
            val m = members[id]
            m != null && m.state == "active" && ChatListModel.isFullMember(m.role) && id !in blocked
        }
        return ClosedBar(text, mine, startNew)
    }

    /** Who posted lately, the latest first and without [me]: among equal matches the picker offers them first. */
    fun recentAuthors(events: List<Event>, me: String?, messages: Int = RECENT_MESSAGES): List<String> =
        events.asSequence().filter { it.isMessage }.toList().takeLast(messages).asReversed().map { it.actor }.filter { it != me }.distinct()

    // How many of the latest loaded messages count for that order (desktop chat-view.js RECENT_MESSAGES).
    private const val RECENT_MESSAGES = 50
}

/** Picked mentions drawn as chips while typing, like the agent input's skills; the text itself stays as it is. */
private class MentionStyling(private val spans: List<MentionSpan>, private val style: SpanStyle) : VisualTransformation {
    override fun filter(text: AnnotatedString): TransformedText {
        if (spans.isEmpty()) return TransformedText(text, OffsetMapping.Identity)
        val styled = buildAnnotatedString {
            append(text)
            for (s in spans) if (s.end <= text.length) addStyle(style, s.start, s.end)
        }
        return TransformedText(styled, OffsetMapping.Identity)
    }

    override fun equals(other: Any?) = other is MentionStyling && other.spans == spans && other.style == style

    override fun hashCode() = spans.hashCode() * 31 + style.hashCode()
}

/**
 * The composer of a room ([root] null) or a thread (android.md "Composer with mentions", contract §3.8, §3.16, §3.17):
 * a growing field of one to six lines and a round Send button. Typing `@` at the start of a word opens the people of
 * the room above the field; picking one puts in `@Name` as a mention. Enter on a hardware keyboard sends and
 * Shift+Enter starts a new line. The draft is kept 500 ms after the last change and comes back with the room. Send is
 * off for blank text and beyond the byte and mention limits; being offline never stops it, the message queues.
 * [draft] is the cached one, for the first time this composer shows.
 */
@Composable
fun ChatComposer(
    app: AppViewModel,
    ws: String,
    room: Room,
    root: String?,
    draft: Draft?,
    members: Map<String, Member>,
    me: String?,
    recent: List<String>,
    placeholder: String,
    pane: ChatPane,
    modifier: Modifier = Modifier,
) {
    val c = Rk.colors
    val ui = app.chatUi
    val state = remember(ws, room.id, root) { ui.composer(ws, room.id, root) { MentionEditing.fromDraft(draft) } }
    val current = state.value
    val sending = ui.isBusy(ui.sendKey(ws, room.id, root))
    var focused by remember { mutableStateOf(false) }
    // The @ the person closed the picker on, so it stays closed for that mention (mentions.js `dismissed`).
    var dismissed by remember(ws, room.id, root) { mutableStateOf<Int?>(null) }
    val selection = current.field.selection
    val token = if (focused && selection.collapsed) MentionEditing.token(current.text, selection.start, current.spans) else null
    LaunchedEffect(token == null) { if (token == null) dismissed = null }
    val picking = token?.takeIf { it.start != dismissed }
    val open = picking != null
    // Loaded again each time the picker opens, so someone who left or joined the channel meanwhile is (or isn't) offered.
    val ids by produceState<List<String>?>(null, ws, room.id, room.members, room.participants, open) { value = ui.mentionMembers(ws, room, fresh = open) }
    // Offline, a channel's members can't load: the people who wrote in it stand in.
    val people = remember(ids, members, recent) { (ids ?: recent).distinct().mapNotNull { members[it] } }
    val query = picking?.query
    val matches = remember(query, people, recent, me) { if (query == null) emptyList() else MentionMatch.rank(query, people, me, recent) }
    var active by remember(picking) { mutableIntStateOf(0) }
    val wire = remember(current.text, current.spans) { MentionEditing.wire(current) }

    // Always from the state as it is now: two edits can come in before the next composition.
    fun change(next: ComposerValue) {
        val now = state.value
        if (next.text != now.text || next.spans != now.spans) ui.composerChanged(ws, room.id, root, next) else state.value = next
    }

    fun pick(member: Member) {
        val now = state.value
        val selection = now.field.selection
        val t = (if (selection.collapsed) MentionEditing.token(now.text, selection.start, now.spans) else null) ?: return
        change(MentionEditing.insert(now, t, member))
    }

    fun send() {
        if (sending || !MentionEditing.wire(state.value).canSend) return
        dismissed = null
        ui.send(ws, room.id, root)
    }

    if (picking != null) BackHandler { dismissed = picking.start }

    Column(modifier.fillMaxWidth().padding(start = 12.dp, end = 12.dp, top = 4.dp, bottom = 12.dp)) {
        if (open) {
            MentionPicker(matches, active, members, onPick = ::pick)
            Spacer(Modifier.size(6.dp))
        }
        val left = wire.bytesLeft
        if (wire.tooLong || wire.tooManyMentions) {
            Text(
                stringResource(if (wire.tooLong) R.string.chat_input_too_long else R.string.chat_input_too_many_mentions),
                style = Rk.type.text12,
                color = c.danger,
                modifier = Modifier.padding(start = 4.dp, bottom = 6.dp),
            )
        } else if (left != null) {
            Text(
                pluralStringResource(R.plurals.chat_input_bytes_left, left, left),
                style = Rk.type.text12.tabular,
                color = c.text3,
                modifier = Modifier.padding(start = 4.dp, bottom = 6.dp),
            )
        }
        val shape = RoundedCornerShape(14.dp)
        Row(
            Modifier
                .fillMaxWidth()
                .background(c.surface, shape)
                .border(1.dp, if (focused) c.lineStrong else c.line, shape)
                .padding(start = 12.dp, end = 4.dp, top = 4.dp, bottom = 4.dp),
            verticalAlignment = Alignment.Bottom,
        ) {
            val chip = SpanStyle(color = c.link, background = c.accentSoft, fontWeight = FontWeight(500))
            val transformation = remember(current.spans, chip) { MentionStyling(current.spans, chip) }
            BasicTextField(
                value = current.field,
                onValueChange = { change(MentionEditing.edited(state.value, it)) },
                readOnly = sending,
                textStyle = Rk.type.text13_5.lineHeight(1.5f).copy(color = c.text),
                cursorBrush = SolidColor(c.text),
                visualTransformation = transformation,
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
                minLines = 1,
                maxLines = 6,
                modifier = Modifier
                    .weight(1f)
                    .heightIn(min = 40.dp)
                    .padding(vertical = 9.dp)
                    .onFocusChanged {
                        focused = it.isFocused
                        app.chatComposerFocused = if (it.isFocused) pane else app.chatComposerFocused.takeIf { p -> p != pane }
                    }
                    .onPreviewKeyEvent { e ->
                        if (e.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
                        when (e.key) {
                            Key.Enter, Key.NumPadEnter -> when {
                                e.isShiftPressed -> false
                                open && matches.isNotEmpty() -> {
                                    pick(matches[active.coerceIn(0, matches.lastIndex)])
                                    true
                                }
                                else -> {
                                    send()
                                    true
                                }
                            }
                            Key.Tab -> if (open && matches.isNotEmpty()) {
                                pick(matches[active.coerceIn(0, matches.lastIndex)])
                                true
                            } else {
                                false
                            }
                            Key.DirectionDown -> if (open && matches.isNotEmpty()) {
                                active = (active + 1) % matches.size
                                true
                            } else {
                                false
                            }
                            Key.DirectionUp -> if (open && matches.isNotEmpty()) {
                                active = (active - 1 + matches.size) % matches.size
                                true
                            } else {
                                false
                            }
                            Key.Escape -> if (picking != null) {
                                dismissed = picking.start
                                true
                            } else {
                                false
                            }
                            else -> false
                        }
                    }
                    .semantics { contentDescription = placeholder },
                decorationBox = { inner ->
                    Box {
                        if (current.text.isEmpty()) {
                            Text(placeholder, style = Rk.type.text13_5, color = c.text3, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                        inner()
                    }
                },
            )
            SendButton(enabled = wire.canSend && !sending, onClick = ::send)
        }
    }
}

/** Send: a round 36dp button, filled with the primary color when there is something to send. */
@Composable
private fun SendButton(enabled: Boolean, onClick: () -> Unit) {
    val c = Rk.colors
    val source = remember { MutableInteractionSource() }
    val label = stringResource(R.string.chat_input_send)
    Box(Modifier.minimumInteractiveComponentSize(), contentAlignment = Alignment.Center) {
        Box(
            Modifier
                .pressScale(source, 0.94f)
                .size(36.dp)
                .background(if (enabled) c.primary else c.chip, CircleShape)
                .rkClickable(CircleShape, enabled = enabled, interactionSource = source, onClick = onClick)
                .semantics { contentDescription = label },
            contentAlignment = Alignment.Center,
        ) {
            RkIcon(PanelIcons.named("send", 2.4f), null, size = 17.dp, tint = if (enabled) c.onPrimary else c.text3)
        }
    }
}

/** The people to mention, above the field: avatar, name and the Guest tag; "Nobody here by that name" without a match. */
@Composable
private fun MentionPicker(matches: List<Member>, active: Int, members: Map<String, Member>, onPick: (Member) -> Unit) {
    val c = Rk.colors
    val label = stringResource(R.string.chat_mentions_label)
    Column(
        Modifier
            .popIn()
            .fillMaxWidth()
            .rkSurface(Rk.elevation.raised, Rk.shapes.card, c.raised)
            .padding(4.dp)
            .semantics { contentDescription = label },
    ) {
        if (matches.isEmpty()) {
            Text(
                stringResource(R.string.chat_mentions_none),
                style = Rk.type.text12_5,
                color = c.text3,
                modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).padding(horizontal = 10.dp, vertical = 13.dp),
            )
            return@Column
        }
        matches.forEachIndexed { i, m ->
            Row(
                Modifier
                    .fillMaxWidth()
                    .heightIn(min = 48.dp)
                    .background(if (i == active) c.hover else c.raised, Rk.shapes.chip)
                    .rkClickable(Rk.shapes.chip, onClick = { onPick(m) })
                    .padding(horizontal = 8.dp),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Avatar(m.name, m.id, size = 24.dp)
                Text(m.name, style = Rk.type.text13.medium, color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                // Two members with one name: the end of the ID tells them apart (desktop-ui 2).
                if (members.values.count { it.state == "active" && it.name.trim().equals(m.name.trim(), ignoreCase = true) } > 1) {
                    Text(m.id.takeLast(4), style = Rk.type.text12, color = c.text3, maxLines = 1)
                }
                if (m.role == "guest") Text(stringResource(R.string.chat_roles_guest), style = Rk.type.text11.medium, color = c.text2, modifier = Modifier.background(c.chip, Rk.shapes.chip).padding(horizontal = 6.dp, vertical = 1.dp))
            }
        }
    }
}

/**
 * A bar where the composer goes when nothing can be sent here (contract §5.5 table): the reason, and its actions. A
 * channel not joined yet offers Join; a closed DM offers Start a new conversation (full members, with someone to start
 * it with) and Remove from list on the room's own bar.
 */
@Composable
internal fun ComposerBar(app: AppViewModel, ws: String, slot: ComposerSlot, room: Room?, me: String?, workspace: String, inThread: Boolean) {
    val c = Rk.colors
    val ui = app.chatUi
    val chatView by app.chatView.collectAsStateWithLifecycle()
    val chatNow by app.chatState.collectAsStateWithLifecycle()
    val view = chatView?.takeIf { it.ws.id == ws }
    val members = remember(view) { view?.members.orEmpty().associateBy { it.id } }
    val names = rememberChatNames()
    // You blocked someone in a closed DM: say so and offer Unblock. Start a new conversation only where the server takes it.
    val closed = if (slot is ComposerSlot.Closed && room != null) {
        val blocked = remember(view) { view?.blocks.orEmpty().mapTo(HashSet()) { it.member } }
        val collator = remember { java.text.Collator.getInstance().apply { strength = java.text.Collator.PRIMARY } }
        ComposerSlots.closedBar(room, me, members, blocked, full = ChatListModel.isFullMember(view?.me?.role), compare = { a, b -> collator.compare(a, b) })
    } else {
        null
    }
    val text = when (slot) {
        is ComposerSlot.NotJoined -> stringResource(R.string.chat_input_not_joined, slot.channel.name)
        ComposerSlot.Archived -> stringResource(R.string.chat_input_archived, room?.name.orEmpty())
        is ComposerSlot.Closed -> when (closed?.text ?: ClosedText.CLOSED) {
            ClosedText.YOU_BLOCKED -> stringResource(R.string.chat_input_closed_you_blocked, names.display(members[closed?.blocked]))
            ClosedText.LEFT -> stringResource(R.string.chat_input_closed_left)
            ClosedText.INELIGIBLE -> stringResource(R.string.chat_input_closed_ineligible)
            ClosedText.CLOSED -> stringResource(R.string.chat_input_closed_blocked)
        }
        ComposerSlot.Paused -> stringResource(R.string.chat_input_paused, workspace)
        ComposerSlot.Upgrade -> stringResource(R.string.chat_errors_upgrade, chatNow.host)
        ComposerSlot.RootRemoved -> stringResource(R.string.chat_thread_root_removed)
        ComposerSlot.Composer -> return
    }
    Column(Modifier.fillMaxWidth()) {
        Hairline()
        Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(text, style = Rk.type.text12_5.lineHeight(1.4f), color = c.text2)
            when {
                slot is ComposerSlot.NotJoined -> {
                    RkButton(
                        stringResource(R.string.chat_input_join, slot.channel.name),
                        { ui.join(ws, slot.channel.id) },
                        kind = RkButtonKind.PRIMARY,
                        size = RkButtonSize.SMALL,
                        enabled = !ui.isBusy(ui.joinKey(slot.channel.id)),
                    )
                }
                slot is ComposerSlot.Closed && room != null && closed != null && !inThread -> {
                    val others = room.participants.orEmpty().distinct().filter { it != me }
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                        val blocked = closed.blocked
                        if (blocked != null) {
                            RkButton(
                                stringResource(R.string.chat_block_unblock),
                                { ui.unblockMember(ws, blocked, names.display(members[blocked])) },
                                kind = RkButtonKind.SECONDARY,
                                size = RkButtonSize.SMALL,
                                enabled = !ui.isBusy("block:$blocked"),
                            )
                        } else if (closed.startNew) {
                            val key = "startDm:${room.id}"
                            RkButton(
                                stringResource(R.string.chat_input_new_conversation),
                                {
                                    ui.launch(key, ui.context(ws)) {
                                        val id = startDm(ws, others)
                                        app.openRoom(id)
                                    }
                                },
                                kind = RkButtonKind.SECONDARY,
                                size = RkButtonSize.SMALL,
                                enabled = !ui.isBusy(key),
                            )
                        }
                        val key = "leaveDm:${room.id}"
                        RkButton(
                            stringResource(R.string.chat_input_remove_from_list),
                            {
                                ui.launch(key, ui.context(ws)) {
                                    if (ui.confirmRemoveDm()) {
                                        ui.expectGone(room.id)
                                        leaveDm(ws, room.id)
                                    }
                                }
                            },
                            kind = RkButtonKind.QUIET,
                            size = RkButtonSize.SMALL,
                            enabled = !ui.isBusy(key),
                        )
                    }
                }
            }
        }
    }
}
