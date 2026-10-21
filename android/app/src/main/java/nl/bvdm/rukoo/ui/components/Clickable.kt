package nl.bvdm.rukoo.ui.components

import androidx.compose.foundation.Indication
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Icon
import androidx.compose.material3.LocalContentColor
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import nl.bvdm.rukoo.ui.theme.Rk

/**
 * Click handling the Rukoo way: clipped to [shape], Rukoo's pressed fill instead of a ripple, and an optional
 * long press (touch's way into what desktop shows on hover or right click). Put backgrounds before this
 * modifier so the pressed fill draws over them and under the content.
 */
@Composable
fun Modifier.rkClickable(
    shape: Shape,
    enabled: Boolean = true,
    role: Role? = Role.Button,
    onClickLabel: String? = null,
    indication: Indication? = Rk.indication(shape),
    interactionSource: MutableInteractionSource? = null,
    onLongClickLabel: String? = null,
    onLongClick: (() -> Unit)? = null,
    onClick: () -> Unit,
): Modifier {
    val source = interactionSource ?: remember { MutableInteractionSource() }
    return this
        .clip(shape)
        .combinedClickable(
            interactionSource = source,
            indication = indication,
            enabled = enabled,
            onClickLabel = onClickLabel,
            role = role,
            onLongClickLabel = onLongClickLabel,
            onLongClick = onLongClick,
            onClick = onClick,
        )
}

/**
 * The press scale: it snaps to [scale] while [interactionSource] is pressed, without a transition (agent.css
 * `.bui-btn:active`). 0.96 for buttons, 0.98 large targets, 0.97 chips, 0.94 the send button. Put it first in
 * the chain so the background and shadow scale too.
 */
@Composable
fun Modifier.pressScale(interactionSource: MutableInteractionSource, scale: Float = 0.96f): Modifier {
    val pressed = interactionSource.collectIsPressedAsState()
    return graphicsLayer {
        val s = if (pressed.value) scale else 1f
        scaleX = s
        scaleY = s
    }
}

/** A Rukoo icon in the current content color, the way `currentColor` works on desktop. */
@Composable
fun RkIcon(
    icon: ImageVector,
    contentDescription: String?,
    modifier: Modifier = Modifier,
    size: Dp = 18.dp,
    tint: Color = LocalContentColor.current,
) {
    Icon(icon, contentDescription, modifier.size(size), tint = tint)
}
