// Ported in part from Beautiful UI (beautifului.dev), MIT License, Copyright (c) 2026 Shane Levine.
package nl.bvdm.rukoo.ui.chat

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import nl.bvdm.rukoo.R
import nl.bvdm.rukoo.ui.components.NewsDot
import nl.bvdm.rukoo.ui.components.NewsTone
import nl.bvdm.rukoo.ui.root.AppMode
import nl.bvdm.rukoo.ui.root.AppViewModel
import nl.bvdm.rukoo.ui.theme.Rk
import nl.bvdm.rukoo.ui.theme.RukooDurations
import nl.bvdm.rukoo.ui.theme.RukooEasing
import nl.bvdm.rukoo.ui.theme.medium
import nl.bvdm.rukoo.ui.theme.rkShadow
import nl.bvdm.rukoo.ui.theme.semibold
import nl.bvdm.rukoo.ui.theme.tabular

/**
 * The switch between Mail and Chat (android.md "Where Chat lives"), at the top of the folder drawer and sheet and of
 * the workspace drawer and sheet. Beautiful UI's SegmentedControl as the desktop draws it (styles.css `.segmented`):
 * equal segments in a pill track, a raised thumb that slides to the chosen one. Chat carries its [chatBadge] (§3.10):
 * an accent count pill, or a dot when only something is unread.
 */
@Composable
fun ModeSwitch(mode: AppMode, chatBadge: ChatBadge?, onSelect: (AppMode) -> Unit, modifier: Modifier = Modifier) {
    val c = Rk.colors
    val track = Rk.shapes.pill
    val label = stringResource(R.string.chat_mode_switch)
    val position by animateFloatAsState(
        if (mode == AppMode.CHAT) 1f else 0f,
        Rk.motion.tween(RukooDurations.SEGMENTED, RukooEasing.OutStrong),
        label = "mode",
    )
    BoxWithConstraints(
        modifier
            .fillMaxWidth()
            .heightIn(min = 48.dp)
            .background(c.border.copy(alpha = c.border.alpha * 0.7f), track)
            .padding(2.dp)
            .semantics { contentDescription = label },
    ) {
        val segment: Dp = maxWidth / 2
        // The thumb: raised with the small shadow in light, the active fill in dark (styles.css .seg-thumb).
        Box(
            Modifier
                .offset(x = segment * position)
                .width(segment)
                .height(44.dp)
                .then(if (c.isDark) Modifier else Modifier.rkShadow(Rk.elevation.shadowSm, track))
                .background(if (c.isDark) c.active else c.raised, track),
        )
        Row(Modifier.fillMaxWidth().height(44.dp).selectableGroup()) {
            Segment(
                text = stringResource(R.string.chat_mode_mail),
                selected = mode == AppMode.MAIL,
                onClick = { onSelect(AppMode.MAIL) },
                modifier = Modifier.weight(1f),
            )
            val badgeLabel = when {
                chatBadge == null -> null
                chatBadge.dot -> stringResource(R.string.chat_mode_badge_unread)
                else -> pluralStringResource(R.plurals.chat_mode_badge_count, chatBadge.count, chatBadge.count)
            }
            Segment(
                text = stringResource(R.string.chat_mode_label),
                selected = mode == AppMode.CHAT,
                onClick = { onSelect(AppMode.CHAT) },
                modifier = Modifier.weight(1f),
                description = badgeLabel,
            ) {
                when {
                    chatBadge == null -> Unit
                    chatBadge.dot -> NewsDot(NewsTone.UNREAD, ring = if (mode == AppMode.CHAT) (if (c.isDark) c.active else c.raised) else c.bg)
                    else -> ChatCountPill(chatBadge.text)
                }
            }
        }
    }
}

@Composable
private fun Segment(
    text: String,
    selected: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    description: String? = null,
    badge: @Composable () -> Unit = {},
) {
    val c = Rk.colors
    Row(
        modifier
            .fillMaxHeight()
            .clip(Rk.shapes.pill)
            .selectable(selected = selected, role = Role.Tab, onClick = onClick)
            .then(if (description != null) Modifier.semantics { contentDescription = description } else Modifier)
            .padding(horizontal = 12.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp, Alignment.CenterHorizontally),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text,
            style = Rk.type.text12_5.medium,
            color = if (selected) c.text else c.text3,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            // With a description, which already names the segment ("Chat, unread messages"), the label isn't read twice.
            modifier = Modifier.weight(1f, fill = false).then(if (description != null) Modifier.clearAndSetSemantics {} else Modifier),
        )
        badge()
    }
}

/**
 * The accent pill with a count (§3.10): on the Chat segment, and on a conversation row with unread messages (a DM) or
 * mentions (a channel). 18dp, accent fill, tabular figures in the panel color (white in light, dark in dark).
 */
@Composable
fun ChatCountPill(text: String, modifier: Modifier = Modifier) {
    val c = Rk.colors
    Box(
        modifier
            .heightIn(min = 18.dp)
            .widthIn(min = 18.dp)
            .background(c.accent, CircleShape)
            .padding(horizontal = 5.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(text, style = Rk.type.text11.semibold.tabular, color = c.onCountPill, maxLines = 1)
    }
}

/**
 * The switch as the drawers show it: only while the configured server has team chat (§3.1), with Chat's badge from
 * the workspace service. Picking a mode closes the drawer.
 */
@Composable
fun AppModeSwitch(app: AppViewModel, modifier: Modifier = Modifier) {
    val chat by app.chatState.collectAsStateWithLifecycle()
    if (!chat.available) return
    val nav by app.state.collectAsStateWithLifecycle()
    ModeSwitch(
        mode = nav.mode,
        chatBadge = ChatBadge.of(chat.attention, chat.unread),
        onSelect = app::setMode,
        modifier = modifier,
    )
}
