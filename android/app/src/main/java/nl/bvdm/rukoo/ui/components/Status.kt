// Ported in part from Beautiful UI (beautifului.dev), MIT License, Copyright (c) 2026 Shane Levine.
package nl.bvdm.rukoo.ui.components

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import nl.bvdm.rukoo.ui.icons.PanelIcons
import nl.bvdm.rukoo.ui.theme.Rk
import nl.bvdm.rukoo.ui.theme.RukooDurations
import nl.bvdm.rukoo.ui.theme.RukooEasing
import nl.bvdm.rukoo.ui.theme.medium
import nl.bvdm.rukoo.ui.theme.tabular

/** Status of a task row, a tool or anything else with a state (agent.css `.bui-task__pill`). */
enum class RkStatus {
    /** Green on green tint. */
    DONE,

    /** Orange on orange tint: running, waiting. */
    BUSY,

    /** Red on red tint. */
    FAILED,

    /** Waits for you: field fill, `ink2` text and a hairline. */
    PROPOSED,

    /** Skipped or idle: field fill, `ink3` text. */
    NEUTRAL,
}

/**
 * A 22dp status pill with tint background and saturated text: color only on pills, dots and icons, never on
 * large areas. [dot] puts Beautiful UI's 6dp status dot before the label, for account or agent status in
 * Settings.
 */
@Composable
fun StatusPill(label: String, status: RkStatus, modifier: Modifier = Modifier, dot: Boolean = false) {
    val c = Rk.colors
    val (background, content) = when (status) {
        RkStatus.DONE -> c.greenTint to c.green
        RkStatus.BUSY -> c.orangeTint to c.orange
        RkStatus.FAILED -> c.redTint to c.red
        RkStatus.PROPOSED -> c.field to c.ink2
        RkStatus.NEUTRAL -> c.field to c.ink3
    }
    val shape = Rk.shapes.pill
    var m = modifier.heightIn(min = 22.dp).background(background, shape)
    if (status == RkStatus.PROPOSED) m = m.border(1.dp, c.line, shape)
    Row(
        m.padding(horizontal = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (dot) Box(Modifier.size(6.dp).background(content, CircleShape))
        Text(label, style = Rk.type.text11_5.medium, color = content, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

/** How a decision ended (agent.css `.bui-donepill`). */
enum class DoneTone { APPROVED, DECLINED, EXPIRED }

/**
 * The pill an approval card shrinks to after the decision: an 18dp circle with a white mark (check, x or
 * minus) and the label. Pops in over 260ms unless [animateEntry] is off.
 */
@Composable
fun DonePill(label: String, tone: DoneTone, modifier: Modifier = Modifier, animateEntry: Boolean = true) {
    val c = Rk.colors
    val (background, content, circle) = when (tone) {
        DoneTone.APPROVED -> Triple(c.greenTint, c.green, c.green)
        DoneTone.DECLINED -> Triple(c.redTint, c.red, c.red)
        DoneTone.EXPIRED -> Triple(c.field, c.ink2, c.ink3)
    }
    val icon = when (tone) {
        DoneTone.APPROVED -> PanelIcons.named("check", 3f)
        DoneTone.DECLINED -> PanelIcons.named("x", 3f)
        DoneTone.EXPIRED -> PanelIcons.named("minus", 3f)
    }
    Row(
        modifier
            .then(if (animateEntry) Modifier.popIn(260) else Modifier)
            .background(background, Rk.shapes.pill)
            .padding(start = 4.dp, top = 4.dp, bottom = 4.dp, end = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(18.dp).background(circle, CircleShape), contentAlignment = Alignment.Center) {
            RkIcon(icon, null, size = 11.dp, tint = Color.White)
        }
        Text(label, style = Rk.type.text12_5.medium, color = content, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

/** Tones of the small status dot. The app and the panel have their own status palettes; both are here. */
enum class DotTone {
    /** Panel: ready (green). */
    READY,

    /** Panel: busy or waiting (orange). */
    BUSY,

    /** Panel: offline, unauthorized, error (red). */
    OFFLINE,

    /** An answer you haven't seen, blue like unread mail. */
    UNREAD,

    /** Anything else: `text3` at 70%. */
    MUTED,

    /** App chrome: sync ok, connected (`ok`). */
    OK,

    /** App chrome: sync busy (`warn`). */
    WARN,

    /** App chrome: sync failed (`danger`). */
    DANGER,

    /** An empty slot that keeps rows aligned with rows that have a dot. */
    NONE,
}

/**
 * A 6dp status dot. [pulsing] fades it 1 → 0.3 → 1 every second, as the busy sync dot and a starting agent
 * do; with reduced motion it stays still.
 */
@Composable
fun StatusDot(tone: DotTone, modifier: Modifier = Modifier, size: Dp = 6.dp, pulsing: Boolean = false) {
    val c = Rk.colors
    val color = when (tone) {
        DotTone.READY -> c.green
        DotTone.BUSY -> c.orange
        DotTone.OFFLINE -> c.red
        DotTone.UNREAD -> c.accent
        DotTone.MUTED -> c.text3.copy(alpha = 0.7f)
        DotTone.OK -> c.ok
        DotTone.WARN -> c.warn
        DotTone.DANGER -> c.danger
        DotTone.NONE -> Color.Transparent
    }
    val alpha = if (pulsing && !Rk.motion.reduced) {
        val transition = rememberInfiniteTransition(label = "pulse")
        transition.animateFloat(
            initialValue = 1f,
            targetValue = 0.3f,
            animationSpec = infiniteRepeatable(tween(RukooDurations.PULSE / 2, easing = RukooEasing.Default), RepeatMode.Reverse),
            label = "pulse",
        )
    } else {
        null
    }
    Box(
        modifier
            .size(size)
            .graphicsLayer { this.alpha = alpha?.value ?: 1f }
            .background(color, CircleShape),
    )
}

/** What a news dot says: an answer you haven't seen (accent), or an approval waiting for you (warn). */
enum class NewsTone { UNREAD, WAITING }

/**
 * The 7dp dot on the agent entry point and the chat bell, with a 2dp ring in the color of the bar it sits on
 * so it reads as cut out of the icon. Pops in over 140ms.
 */
@Composable
fun NewsDot(tone: NewsTone, ring: Color, modifier: Modifier = Modifier) {
    val c = Rk.colors
    Box(
        modifier
            .popIn(RukooDurations.DIALOG)
            .size(11.dp)
            .background(ring, CircleShape)
            .padding(2.dp)
            .background(if (tone == NewsTone.UNREAD) c.accent else c.warn, CircleShape),
    )
}

/** The count next to a panel heading ("Sources 3"): 20dp, 6dp corners, inset fill with a hairline. */
@Composable
fun CountPill(count: String, modifier: Modifier = Modifier) {
    val c = Rk.colors
    val shape = RoundedCornerShape(6.dp)
    Box(
        modifier
            .heightIn(min = 20.dp)
            .widthIn(min = 20.dp)
            .background(c.inset, shape)
            .border(1.dp, c.line, shape)
            .padding(horizontal = 6.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(count, style = Rk.type.text11_5.medium.tabular, color = c.ink2, maxLines = 1)
    }
}

/**
 * The entry pop of small things (`bui-pop-in`): from scale 0.95 and transparent, once, when first composed.
 * Skipped with reduced motion.
 */
@Composable
fun Modifier.popIn(durationMs: Int = RukooDurations.POPOVER, delayMs: Int = 0, fromScale: Float = 0.95f): Modifier {
    if (Rk.motion.reduced) return this
    val progress = remember { Animatable(0f) }
    LaunchedEffect(Unit) {
        progress.animateTo(1f, tween(durationMs, delayMs, RukooEasing.OutStrong))
    }
    return graphicsLayer {
        val p = progress.value
        alpha = p
        val s = fromScale + (1f - fromScale) * p
        scaleX = s
        scaleY = s
    }
}

/**
 * The entry of cards and rows (`bui-fade-up`): from 8dp lower and transparent, once. [delayMs] staggers items
 * that appear together (80ms apart).
 */
@Composable
fun Modifier.fadeUp(durationMs: Int = RukooDurations.FADE_UP, delayMs: Int = 0): Modifier {
    if (Rk.motion.reduced) return this
    val progress = remember { Animatable(0f) }
    LaunchedEffect(Unit) {
        progress.animateTo(1f, tween(durationMs, delayMs, RukooEasing.OutStrong))
    }
    return graphicsLayer {
        val p = progress.value
        alpha = p
        translationY = (1f - p) * 8.dp.toPx()
    }
}
