package nl.bvdm.rukoo.ui.mail

import androidx.compose.animation.core.animate
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.Orientation
import androidx.compose.foundation.gestures.draggable
import androidx.compose.foundation.gestures.rememberDraggableState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import kotlin.math.abs
import kotlin.math.min
import kotlin.math.roundToInt
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import nl.bvdm.rukoo.R
import nl.bvdm.rukoo.categories.Category
import nl.bvdm.rukoo.mail.model.FolderRole
import nl.bvdm.rukoo.mail.model.MessageSummary
import nl.bvdm.rukoo.settings.SwipeAction
import nl.bvdm.rukoo.ui.ComposerState
import nl.bvdm.rukoo.ui.components.Avatar
import nl.bvdm.rukoo.ui.components.AvatarSize
import nl.bvdm.rukoo.ui.components.RkIcon
import nl.bvdm.rukoo.ui.components.rkClickable
import nl.bvdm.rukoo.ui.icons.RukooIcons
import nl.bvdm.rukoo.ui.settings.categoryColor
import nl.bvdm.rukoo.ui.theme.AccountColors
import nl.bvdm.rukoo.ui.theme.Rk
import nl.bvdm.rukoo.ui.theme.RukooEasing
import nl.bvdm.rukoo.ui.theme.bold
import nl.bvdm.rukoo.ui.theme.medium
import nl.bvdm.rukoo.ui.theme.semibold
import nl.bvdm.rukoo.ui.theme.tabular

import nl.bvdm.rukoo.ui.theme.weight

/** How a row looks besides its message. */
data class RowLook(
    val compact: Boolean,
    val selecting: Boolean,
    val open: Boolean,
    val checked: Boolean,
    /**
     * Several accounts in one list: the account as a dot in [accountColor] on the sender's picture, so it can't be taken
     * for a category's label; the short account label is what a screen reader says for it.
     */
    val accountLabel: String? = null,
    val accountColor: String? = null,
    /** Searching all folders, or Starred: the folder as a pill. */
    val folderLabel: String? = null,
    /** The email's inbox category in a list that mixes them (ListModel.rowCategory): a pill in its color. */
    val category: Category? = null,
)

/** What a swipe does: its [action] (for the color and label behind the row) and the work itself. */
class RowSwipe(val action: SwipeAction, val run: () -> Unit) {
    /** Archive and delete take the email out of the list, so the row flies out; the others spring back. */
    val flies: Boolean get() = action == SwipeAction.ARCHIVE || action == SwipeAction.DELETE
}

/** What a row can do. A swipe right runs [right], a swipe left [left] (Settings > Swipe actions). */
class RowActions(
    val open: () -> Unit,
    val toggleChecked: () -> Unit,
    val right: RowSwipe?,
    val left: RowSwipe?,
    val toggleStack: (() -> Unit)? = null,
)

// Desktop's SWIPE_TRIGGER (app.js:1291).
private val SwipeTrigger = 110.dp

/**
 * A message row (app.js itemHtml; spec 6 §4.2.4 and §5.2): avatar, unread dot in its own gutter, sender and
 * time, subject with pills and the star, a preview line. Rows are inset 6dp with 8dp corners, so the open
 * row is a grey block. A swipe runs the action chosen for its direction; long press or the avatar checks the row.
 */
@Composable
fun MessageRow(
    m: MessageSummary,
    line: String,
    time: String,
    look: RowLook,
    actions: RowActions,
    modifier: Modifier = Modifier,
    stack: StackInfo? = null,
    stacked: Boolean = false,
) {
    val c = Rk.colors
    val density = LocalDensity.current
    val trigger = with(density) { SwipeTrigger.toPx() }
    var dx by remember(m.id) { mutableFloatStateOf(0f) }
    val scope = rememberCoroutineScope()
    val swipe = (actions.right != null || actions.left != null) && !look.selecting
    val shape = RoundedCornerShape(8.dp)

    // A row that flew out but is still here (the delete asked first and was cancelled, or failed) comes back.
    var flown by remember(m.id) { mutableStateOf(false) }
    LaunchedEffect(m.id, flown) {
        if (flown) {
            delay(1500)
            animate(dx, 0f, animationSpec = SwipeSpec) { v, _ -> dx = v }
            flown = false
        }
    }

    BoxWithConstraints(modifier.fillMaxWidth().padding(horizontal = 6.dp)) {
        val width = with(density) { maxWidth.toPx() }
        Column {
            Box(Modifier.fillMaxWidth().clip(shape)) {
                val shown = if (dx > 0) actions.right else if (dx < 0) actions.left else null
                if (shown != null) SwipeBackground(right = dx > 0, action = shown.action, m = m, alpha = min(1f, abs(dx) / trigger), modifier = Modifier.matchParentSize())
                val fill = when {
                    look.checked -> c.accentSoft
                    look.open -> c.sel
                    else -> c.panel
                }
                Row(
                    Modifier
                        .offset { IntOffset(dx.roundToInt(), 0) }
                        .fillMaxWidth()
                        .heightIn(min = if (look.compact) 52.dp else 76.dp)
                        .background(fill, shape)
                        .draggable(
                            orientation = Orientation.Horizontal,
                            enabled = swipe,
                            state = rememberDraggableState { delta ->
                                val next = dx + delta
                                // Only the directions that do something move the row.
                                dx = when {
                                    next > 0 && actions.right == null -> 0f
                                    next < 0 && actions.left == null -> 0f
                                    else -> next
                                }
                            },
                            onDragStopped = {
                                scope.launch {
                                    val done = when {
                                        dx >= trigger -> actions.right
                                        dx <= -trigger -> actions.left
                                        else -> null
                                    }
                                    when {
                                        done == null -> animate(dx, 0f, animationSpec = SwipeSpec) { v, _ -> dx = v }
                                        done.flies -> {
                                            animate(dx, (if (dx > 0) 1 else -1) * width * 1.1f, animationSpec = SwipeSpec) { v, _ -> dx = v }
                                            delay(160)
                                            done.run()
                                            flown = true
                                        }
                                        else -> {
                                            done.run()
                                            animate(dx, 0f, animationSpec = SwipeSpec) { v, _ -> dx = v }
                                        }
                                    }
                                }
                            },
                        )
                        .rkClickable(shape, onLongClick = actions.toggleChecked, onClick = if (look.selecting) actions.toggleChecked else actions.open)
                        .padding(
                            start = if (stacked) 50.dp else if (look.compact) 18.dp else 20.dp,
                            end = 12.dp,
                            top = if (look.compact) 7.dp else 10.dp,
                            bottom = if (look.compact) 7.dp else 10.dp,
                        ),
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                    verticalAlignment = if (look.compact) Alignment.CenterVertically else Alignment.Top,
                ) {
                    Lead(m, look, stacked, actions, ring = fill)
                    Body(m, line, time, look, stack, stacked, actions)
                }
                if (m.unread) {
                    // The unread dot sits in its own gutter: 7dp, accent (styles.css:1285).
                    val top = if (look.compact) null else 26.dp
                    Box(
                        Modifier
                            .offset { IntOffset((dx + with(density) { (if (stacked) 36.dp else 7.dp).toPx() }).roundToInt(), 0) }
                            .then(if (top != null) Modifier.padding(top = top) else Modifier.align(Alignment.CenterStart))
                            .size(7.dp)
                            .background(c.accent, CircleShape),
                    )
                }
                // A stack's other emails have no picture, and the phone has no hover to show it as desktop does: with
                // several accounts, the account dot stands alone in the gutter, on the sender's line.
                val stackedAccount = look.accountLabel?.takeIf { stacked && !look.selecting }
                if (stackedAccount != null) {
                    AccountDot(
                        stackedAccount,
                        look.accountColor,
                        fill,
                        Modifier
                            .offset { IntOffset((dx + with(density) { 18.dp.toPx() }).roundToInt(), 0) }
                            .then(if (look.compact) Modifier.align(Alignment.CenterStart) else Modifier.padding(top = 12.dp)),
                    )
                }
            }
            if (stack != null && !stack.open) PaperEdge()
        }
    }
}

// The row springs back or flies out over 200ms with the app curve (app.js:1336-1340).
private val SwipeSpec = tween<Float>(200, easing = RukooEasing.App)

/** The sender's picture, or the checkbox while selecting. [ring] is the row's fill, which rings the account dot. */
@Composable
private fun Lead(m: MessageSummary, look: RowLook, stacked: Boolean, actions: RowActions, ring: Color) {
    // A stack's other emails: no picture; MessageRow puts the account dot in their gutter.
    if (stacked) return
    val selectLabel = stringResource(R.string.mailbox_message_select)
    val account = look.accountLabel?.takeIf { !look.selecting }
    if (look.compact) {
        when {
            look.selecting -> MailCheckbox(look.checked, Modifier.rkClickable(RoundedCornerShape(5.dp), onClick = actions.toggleChecked), description = selectLabel)
            // Compact rows have no picture (desktop's 18px lead without its avatar): the dot stands alone.
            account != null -> Box(Modifier.size(18.dp), contentAlignment = Alignment.Center) { AccountDot(account, look.accountColor, ring) }
        }
        return
    }
    // Not clipped itself, so the account dot can sit over the picture's edge.
    Box(Modifier.size(AvatarSize.Large)) {
        Box(
            Modifier
                .matchParentSize()
                .rkClickable(CircleShape, onClickLabel = selectLabel, onClick = actions.toggleChecked),
            contentAlignment = Alignment.Center,
        ) {
            if (look.selecting) {
                MailCheckbox(look.checked, description = selectLabel)
            } else {
                val who = ListModel.avatarOf(m)
                Avatar(who.name, who.address, size = AvatarSize.Large)
            }
        }
        // 2dp past the picture's corner, as desktop's right: -2px; bottom: -2px, plus the 2dp ring.
        if (account != null) AccountDot(account, look.accountColor, ring, Modifier.align(Alignment.BottomEnd).offset(4.dp, 4.dp))
    }
}

/**
 * The account of an email in a list of several accounts (styles.css .lead .acc-dot): an 11dp dot in its color, ringed
 * in the row's own fill so it stands apart from the picture in each state of the row.
 */
@Composable
private fun AccountDot(label: String, color: String?, ring: Color, modifier: Modifier = Modifier) {
    val description = stringResource(R.string.mailbox_message_account, label)
    Box(
        modifier
            .size(15.dp)
            .background(ring, CircleShape)
            .padding(2.dp)
            .background(AccountColors.parse(color), CircleShape)
            .semantics { contentDescription = description },
    )
}

@Composable
private fun androidx.compose.foundation.layout.RowScope.Body(
    m: MessageSummary,
    line: String,
    time: String,
    look: RowLook,
    stack: StackInfo?,
    stacked: Boolean,
    actions: RowActions,
) {
    val c = Rk.colors
    val unread = m.unread
    val draft = m.role == FolderRole.DRAFTS
    Column(Modifier.weight(1f)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            if (draft) {
                Text(stringResource(R.string.composer_titles_draft), style = Rk.type.text13.semibold, color = c.danger, maxLines = 1)
                Spacer(Modifier.width(6.dp))
            }
            val senderStyle = when {
                stacked -> if (unread) Rk.type.text13.semibold else Rk.type.text13.medium
                unread -> Rk.type.text13.bold
                else -> Rk.type.text13.medium
            }
            val senderColor = when {
                stacked -> if (unread) c.text2 else c.text3
                else -> c.text
            }
            // The sender takes what it needs and the stack button follows it; the meta keeps to the right.
            Row(Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically) {
                Text(line, style = senderStyle, color = senderColor, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                if (stack != null && !(stack.open && stack.forced)) {
                    Spacer(Modifier.width(6.dp))
                    StackButton(stack, line, actions.toggleStack)
                }
            }
            Spacer(Modifier.width(8.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(5.dp), verticalAlignment = Alignment.CenterVertically) {
                if (m.answered) RkIcon(RukooIcons.Replied, stringResource(R.string.mailbox_message_replied), size = 13.dp, tint = c.text3)
                if (m.hasAttachments) RkIcon(RukooIcons.Clip, stringResource(R.string.mailbox_message_attachment), size = 13.dp, tint = c.text3)
                Text(time, style = Rk.type.meta, color = c.text3, maxLines = 1)
            }
        }
        SubjectLine(m, look)
        if (!look.compact) {
            Text(
                ListModel.cleanPreview(m.preview),
                style = Rk.type.text12_5,
                color = c.text3,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(top = 1.dp),
            )
        }
    }
}

/**
 * The subject, then the pills and the star (app.js itemHtml .line2). The pills give way before the subject does: they
 * shrink, each ending in an ellipsis, and never take more than 60% of the line (styles.css .flags), so a narrow row
 * with VIP, folder and category pills still shows some of the subject. The star keeps its size.
 */
@Composable
private fun SubjectLine(m: MessageSummary, look: RowLook) {
    val c = Rk.colors
    val unread = m.unread
    val pills = buildList<@Composable () -> Unit> {
        if (m.vip) add { Pill(stringResource(R.string.mailbox_message_vip), background = c.accentSoft, color = c.accent, strong = true) }
        look.folderLabel?.let { add { Pill(it) } }
        look.category?.let { cat ->
            add {
                val color = categoryColor(cat.color)
                // The wash is lighter on dark, so the name keeps 4.5:1 (styles.css --cat-tint).
                Pill(cat.name, background = mix(c.chip, color, if (c.isDark) 0.11f else 0.16f), dot = color)
            }
        }
    }
    Layout(
        contents = listOf(
            {
                Text(
                    m.subject.ifBlank { stringResource(R.string.mailbox_message_no_subject) },
                    style = if (unread) Rk.type.text13.semibold else Rk.type.text13,
                    color = if (unread) c.text else c.text2,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            },
            { pills.forEach { it() } },
            { if (m.starred) RkIcon(RukooIcons.StarFilled, stringResource(R.string.mailbox_filters_starred), Modifier.padding(start = 2.dp), size = 15.dp, tint = c.star) },
        ),
    ) { (subjectPart, pillParts, starPart), constraints ->
        val line = constraints.maxWidth
        val gap = 4.dp.roundToPx()
        val star = starPart.firstOrNull()?.measure(Constraints())
        val flags = pillParts.size + (if (star != null) 1 else 0)
        val gaps = gap * (flags - 1).coerceAtLeast(0)
        val room = if (constraints.hasBoundedWidth) (line * 0.6f).toInt() - gaps - (star?.width ?: 0) else Constraints.Infinity
        val widths = ListModel.pillWidths(pillParts.map { it.maxIntrinsicWidth(constraints.maxHeight) }, room.coerceAtLeast(0))
        val placed = pillParts.mapIndexed { i, p -> p.measure(Constraints(maxWidth = widths[i])) }
        val flagsWidth = placed.sumOf { it.width } + (star?.width ?: 0) + gaps
        // The subject fills what is left, as Modifier.weight(1f) did, with a little air before the pills.
        val subjectWidth = (line - flagsWidth - if (flags > 0) 6.dp.roundToPx() else 0).coerceAtLeast(0)
        val subject = subjectPart.first().measure(Constraints.fixedWidth(subjectWidth))
        val height = maxOf(subject.height, placed.maxOfOrNull { it.height } ?: 0, star?.height ?: 0)
        layout(line, height) {
            subject.placeRelative(0, (height - subject.height) / 2)
            var x = line - flagsWidth
            for (p in placed) {
                p.placeRelative(x, (height - p.height) / 2)
                x += p.width + gap
            }
            star?.placeRelative(x, (height - star.height) / 2)
        }
    }
}

/** [over] mixed into [base] by [amount] in sRGB, as CSS color-mix(in srgb, over amount, base) does. */
private fun mix(base: Color, over: Color, amount: Float): Color = Color(
    red = base.red + (over.red - base.red) * amount,
    green = base.green + (over.green - base.green) * amount,
    blue = base.blue + (over.blue - base.blue) * amount,
    alpha = base.alpha + (over.alpha - base.alpha) * amount,
)

/**
 * A list pill (styles.css:1025-1055): 11px, `chip` fill, `text2`, 5dp corners. A category's pill has a dot in its color
 * on a wash of it (.pill.cat).
 */
@Composable
private fun Pill(text: String, background: Color = Rk.colors.chip, color: Color = Rk.colors.text2, strong: Boolean = false, dot: Color? = null) {
    Row(
        Modifier.background(background, RoundedCornerShape(5.dp)).padding(horizontal = 6.dp, vertical = 1.dp).widthIn(max = 110.dp),
        horizontalArrangement = Arrangement.spacedBy(4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (dot != null) Box(Modifier.size(6.dp).background(dot, CircleShape))
        Text(text, style = if (strong) Rk.type.text11.weight(650) else Rk.type.text11.medium, color = color, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

/** The "+N" after a stack head's sender, or the up chevron that folds an open stack (styles.css:1412-1467). */
@Composable
private fun StackButton(stack: StackInfo, sender: String, onClick: (() -> Unit)?) {
    val c = Rk.colors
    val shape = RoundedCornerShape(9.dp)
    val label = if (stack.open) stringResource(R.string.mailbox_message_collapse) else pluralStringResource(R.plurals.mailbox_message_stack, stack.count - 1, stack.count - 1, sender)
    Box(
        Modifier
            .heightIn(min = 20.dp)
            .widthIn(min = 28.dp)
            .background(if (stack.unread && !stack.open) c.accentSoft else c.chip, shape)
            .rkClickable(shape, onClick = { onClick?.invoke() })
            .semantics { contentDescription = label }
            .padding(horizontal = 6.dp),
        contentAlignment = Alignment.Center,
    ) {
        if (stack.open) {
            RkIcon(RukooIcons.Up, null, size = 13.dp, tint = c.text2)
        } else {
            Text("+${stack.count - 1}", style = Rk.type.text11.weight(650).tabular, color = if (stack.unread) c.accent else c.text2, maxLines = 1)
        }
    }
}

/** The paper edge under a folded stack: a hairline card peeking out below, inset 22dp. */
@Composable
private fun PaperEdge() {
    val line = Rk.colors.border
    Box(
        Modifier
            .fillMaxWidth()
            .offset(y = (-1).dp)
            .padding(horizontal = 22.dp)
            .height(4.dp)
            .drawBehind {
                val stroke = 1.dp.toPx()
                val r = 6.dp.toPx()
                val path = Path().apply {
                    moveTo(stroke / 2, 0f)
                    lineTo(stroke / 2, size.height - r)
                    quadraticTo(stroke / 2, size.height - stroke / 2, r, size.height - stroke / 2)
                    lineTo(size.width - r, size.height - stroke / 2)
                    quadraticTo(size.width - stroke / 2, size.height - stroke / 2, size.width - stroke / 2, size.height - r)
                    lineTo(size.width - stroke / 2, 0f)
                }
                drawPath(path, line, style = Stroke(stroke))
            },
    )
}

/** Behind a swiped row: blue "Read"/"Unread" to the right, red "Clear" to the left, fading in over 110dp. */
@Composable
private fun SwipeBackground(right: Boolean, action: SwipeAction, m: MessageSummary, alpha: Float, modifier: Modifier) {
    val c = Rk.colors
    val (color, icon, label) = when (action) {
        SwipeAction.READ -> Triple(c.swipeRead, if (m.unread) RukooIcons.MailOpen else RukooIcons.MarkUnread, if (m.unread) R.string.mailbox_message_read else R.string.mailbox_filters_unread)
        SwipeAction.ARCHIVE -> Triple(c.swipeArchive, RukooIcons.Archive, R.string.common_actions_archive)
        SwipeAction.DELETE -> Triple(c.swipeDelete, RukooIcons.Trash, R.string.common_actions_delete)
        SwipeAction.STAR -> Triple(c.swipeStar, if (m.starred) RukooIcons.StarFilled else RukooIcons.Star, if (m.starred) R.string.mailbox_actions_unstar else R.string.mailbox_actions_star)
        SwipeAction.MOVE -> Triple(c.swipeMove, RukooIcons.Move, R.string.common_actions_move)
        SwipeAction.CATEGORY, SwipeAction.NONE -> Triple(c.swipeCategory, RukooIcons.Inbox, R.string.mailbox_categories_move)
    }
    Row(
        modifier.alpha(alpha).background(color).padding(horizontal = 22.dp),
        horizontalArrangement = if (right) Arrangement.spacedBy(10.dp, Alignment.Start) else Arrangement.spacedBy(10.dp, Alignment.End),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        val style = Rk.type.text13.semibold
        if (right) {
            RkIcon(icon, null, size = 20.dp, tint = Color.White)
            Text(stringResource(label), style = style, color = Color.White)
        } else {
            Text(stringResource(label), style = style, color = Color.White)
            RkIcon(icon, null, size = 20.dp, tint = Color.White)
        }
    }
}

/** A draft kept on this phone, at the top of Drafts: the red tag, its recipients, subject and first words. */
@Composable
fun LocalDraftRow(draft: ComposerState, line: String, time: String, onOpen: () -> Unit, modifier: Modifier = Modifier) {
    val c = Rk.colors
    val shape = RoundedCornerShape(8.dp)
    Row(
        modifier
            .fillMaxWidth()
            .padding(horizontal = 6.dp)
            .heightIn(min = 76.dp)
            .background(c.panel, shape)
            .rkClickable(shape, onClick = onOpen)
            .padding(start = 20.dp, end = 12.dp, top = 10.dp, bottom = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        val who = draft.to.firstOrNull()
        Avatar(who?.name, who?.address, size = AvatarSize.Large)
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(stringResource(R.string.composer_titles_draft), style = Rk.type.text13.semibold, color = c.danger, maxLines = 1)
                Spacer(Modifier.width(6.dp))
                Text(line, style = Rk.type.text13.medium, color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                Text(time, style = Rk.type.meta, color = c.text3, maxLines = 1)
            }
            Text(
                draft.subject.ifBlank { stringResource(R.string.mailbox_message_no_subject) },
                style = Rk.type.text13,
                color = c.text2,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                draft.body.replace(Regex("\\s+"), " ").trim(),
                style = Rk.type.text12_5,
                color = c.text3,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(top = 1.dp),
            )
        }
    }
}
