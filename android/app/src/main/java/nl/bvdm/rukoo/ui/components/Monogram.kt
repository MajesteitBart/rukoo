// Ported in part from Beautiful UI (beautifului.dev), MIT License, Copyright (c) 2026 Shane Levine.
package nl.bvdm.rukoo.ui.components

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.painter.Painter
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import nl.bvdm.rukoo.ui.theme.Rk
import nl.bvdm.rukoo.ui.theme.RukooWeights
import nl.bvdm.rukoo.ui.theme.rukooHue
import nl.bvdm.rukoo.ui.theme.rukooInitials
import nl.bvdm.rukoo.ui.theme.rukooMonogramText

/**
 * Letters inside a badge scale with the badge, not with the user's font size, so they never overflow the
 * circle. Everything outside badges stays in sp.
 */
@Composable
private fun badgeText(size: Dp, ratio: Float) = with(LocalDensity.current) { (size * ratio).toSp() }

/** Avatar sizes: 22 inline, 28 in compact rows and chips, 40 in list rows and the reader on a phone. */
object AvatarSize {
    val Small = 22.dp
    val Medium = 28.dp
    val Large = 40.dp
}

/**
 * A person's avatar (ui.js `avatar`): initials on a hue generated from the address, so a sender has the same
 * color everywhere. With a [logo] (a sender's company icon) it shows that at 70% on white with an 8% ring.
 */
@Composable
fun Avatar(
    name: String?,
    address: String?,
    modifier: Modifier = Modifier,
    size: Dp = AvatarSize.Large,
    logo: Painter? = null,
) {
    if (logo != null) {
        LogoDisc(logo, size, modifier, ratio = 0.7f)
        return
    }
    val c = Rk.colors
    val hue = rukooHue(address?.takeIf { it.isNotBlank() } ?: name)
    Box(
        modifier.size(size).background(c.avatarBackground(hue), CircleShape),
        contentAlignment = Alignment.Center,
    ) {
        // 11.5px on a 32px avatar on desktop: about 36% of the disc.
        Text(
            rukooInitials(name, address),
            color = c.avatarText(hue),
            style = Rk.type.text12.copy(
                fontSize = badgeText(size, 0.36f),
                fontWeight = RukooWeights.Title,
                letterSpacing = 0.01.em,
                lineHeight = 1.em,
            ),
            maxLines = 1,
        )
    }
}

/**
 * The agent panel's monogram (bui.js `monogram`): a disc with one or two letters, 16 by default. [hue]
 * comes from [hueKey] or the label. [agent] uses the accent tint, for the agent itself. Font size is 56% of
 * the disc (24 → 13), weight 600.
 */
@Composable
fun Monogram(
    label: String,
    modifier: Modifier = Modifier,
    size: Dp = 16.dp,
    hueKey: String? = null,
    agent: Boolean = false,
    logo: Painter? = null,
) {
    if (logo != null) {
        LogoDisc(logo, size, modifier, ratio = 0.72f)
        return
    }
    val c = Rk.colors
    val hue = rukooHue(hueKey ?: label)
    val background = if (agent) c.accentTint else c.avatarBackground(hue)
    val content = if (agent) c.accentInk else c.avatarText(hue)
    Box(modifier.size(size).background(background, CircleShape), contentAlignment = Alignment.Center) {
        Text(
            rukooMonogramText(label),
            color = content,
            style = Rk.type.text12.copy(
                fontSize = badgeText(size, 0.56f),
                fontWeight = RukooWeights.Semibold,
                letterSpacing = 0.01.em,
                lineHeight = 1.em,
            ),
            maxLines = 1,
        )
    }
}

/**
 * An account's avatar in the account switcher and Settings: the account color mixed into the panel (24%)
 * and into the text (80%). Without a color it is the neutral "All accounts" disc.
 */
@Composable
fun AccountAvatar(label: String, color: Color?, modifier: Modifier = Modifier, size: Dp = 30.dp) {
    val c = Rk.colors
    val background = color?.let { c.accountBackground(it) } ?: c.chip
    val content = color?.let { c.accountText(it) } ?: c.text2
    Box(modifier.size(size).background(background, CircleShape), contentAlignment = Alignment.Center) {
        Text(
            rukooMonogramText(label).take(2),
            color = content,
            style = Rk.type.text12.copy(fontSize = badgeText(size, 0.4f), fontWeight = RukooWeights.Title, lineHeight = 1.em),
            maxLines = 1,
        )
    }
}

/**
 * The 14dp badge of a source chip: a letter on the hue scheme, or a mail icon on the accent tint for an
 * email source (agent.css:1632-1658).
 */
@Composable
fun SourceBadge(label: String, modifier: Modifier = Modifier, email: Boolean = false, emailIcon: ImageVector? = null, size: Dp = 14.dp) {
    val c = Rk.colors
    val shape = RoundedCornerShape(4.dp)
    if (email) {
        Box(modifier.size(size).background(c.accentTint, shape), contentAlignment = Alignment.Center) {
            if (emailIcon != null) RkIcon(emailIcon, null, size = size * 0.65f, tint = c.accentInk)
        }
        return
    }
    val hue = rukooHue(label)
    Box(modifier.size(size).background(c.sourceBadgeBackground(hue), shape), contentAlignment = Alignment.Center) {
        Text(
            rukooMonogramText(label).take(1),
            color = c.sourceBadgeText(hue),
            style = Rk.type.text12.copy(fontSize = badgeText(size, 0.5f), fontWeight = FontWeight(700), lineHeight = 1.em),
            maxLines = 1,
        )
    }
}

@Composable
private fun LogoDisc(logo: Painter, size: Dp, modifier: Modifier, ratio: Float) {
    val c = Rk.colors
    Box(
        modifier
            .size(size)
            .clip(CircleShape)
            .background(c.logoBackground)
            .border(1.dp, c.logoRing, CircleShape),
        contentAlignment = Alignment.Center,
    ) {
        Image(logo, null, Modifier.fillMaxSize().scale(ratio), contentScale = ContentScale.Fit)
    }
}
