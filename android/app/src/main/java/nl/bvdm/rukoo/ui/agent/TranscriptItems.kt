// Ported in part from Beautiful UI (beautifului.dev), MIT License, Copyright (c) 2026 Shane Levine, through
// Rukoo's desktop src/renderer/agent/bui.js and agent.css.
package nl.bvdm.rukoo.ui.agent

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
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
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.InlineTextContent
import androidx.compose.foundation.text.appendInlineContent
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.layout.layout
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.Placeholder
import androidx.compose.ui.text.PlaceholderVerticalAlign
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import java.text.NumberFormat
import kotlin.math.max
import kotlinx.coroutines.delay
import nl.bvdm.rukoo.R
import nl.bvdm.rukoo.agents.model.ApprovalStatus
import nl.bvdm.rukoo.agents.model.AssistantStatus
import nl.bvdm.rukoo.agents.model.ChoiceKind
import nl.bvdm.rukoo.agents.model.Item
import nl.bvdm.rukoo.agents.model.OwnSkill
import nl.bvdm.rukoo.agents.model.PlanTask
import nl.bvdm.rukoo.agents.model.SourceRef
import nl.bvdm.rukoo.agents.model.TaskStatus
import nl.bvdm.rukoo.agents.model.ThinkingStatus
import nl.bvdm.rukoo.agents.model.Tone
import nl.bvdm.rukoo.agents.model.ToolStatus
import nl.bvdm.rukoo.core.Unsafe
import nl.bvdm.rukoo.ui.components.CollapsibleRail
import nl.bvdm.rukoo.ui.components.ContextCard
import nl.bvdm.rukoo.ui.components.CountPill
import nl.bvdm.rukoo.ui.components.DonePill
import nl.bvdm.rukoo.ui.components.DoneTone
import nl.bvdm.rukoo.ui.components.EntityChip
import nl.bvdm.rukoo.ui.components.ExpandChevron
import nl.bvdm.rukoo.ui.components.Hairline
import nl.bvdm.rukoo.ui.components.PanelCard
import nl.bvdm.rukoo.ui.components.PanelHeading
import nl.bvdm.rukoo.ui.components.PixelLoader
import nl.bvdm.rukoo.ui.components.RailText
import nl.bvdm.rukoo.ui.components.RkExpandable
import nl.bvdm.rukoo.ui.components.RkIcon
import nl.bvdm.rukoo.ui.components.RkPillButton
import nl.bvdm.rukoo.ui.components.RkPillKind
import nl.bvdm.rukoo.ui.components.RkPillSize
import nl.bvdm.rukoo.ui.components.RkStatus
import nl.bvdm.rukoo.ui.components.ShimmerText
import nl.bvdm.rukoo.ui.components.SourceBadge
import nl.bvdm.rukoo.ui.components.SourceKind
import nl.bvdm.rukoo.ui.components.Spinner
import nl.bvdm.rukoo.ui.components.StatusPill
import nl.bvdm.rukoo.ui.components.fadeUp
import nl.bvdm.rukoo.ui.components.popIn
import nl.bvdm.rukoo.ui.components.rkClickable
import nl.bvdm.rukoo.ui.icons.PanelIcons
import nl.bvdm.rukoo.ui.theme.Rk
import nl.bvdm.rukoo.ui.theme.RukooDurations
import nl.bvdm.rukoo.ui.theme.RukooEasing
import nl.bvdm.rukoo.ui.theme.RukooMono
import nl.bvdm.rukoo.ui.theme.RukooWeights
import nl.bvdm.rukoo.ui.theme.lineHeight
import nl.bvdm.rukoo.ui.theme.medium
import nl.bvdm.rukoo.ui.theme.panel
import nl.bvdm.rukoo.ui.theme.rkShadow
import nl.bvdm.rukoo.ui.theme.rkSurface
import nl.bvdm.rukoo.ui.theme.semibold
import nl.bvdm.rukoo.ui.theme.tabular

/** Lets a row reach [horizontal] past its slot on both sides, so a pressed fill has room while its content stays in line. */
internal fun Modifier.outset(horizontal: Dp): Modifier = layout { measurable, constraints ->
    val extra = horizontal.roundToPx() * 2
    val wide = if (constraints.hasBoundedWidth) constraints.copy(maxWidth = constraints.maxWidth + extra, minWidth = constraints.minWidth + extra) else constraints
    val p = measurable.measure(wide)
    layout(max(0, p.width - extra), p.height) { p.place(-extra / 2, 0) }
}

/** The ticking clock of live work; null with no work running, so idle items don't wake up. */
@Composable
internal fun rememberNow(running: Boolean, everyMs: Long): Long {
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(running, everyMs) {
        now = System.currentTimeMillis()
        while (running) {
            delay(everyMs)
            now = System.currentTimeMillis()
        }
    }
    return now
}

// ---------- user ----------

/**
 * What the user sent: right-aligned on a raised bubble with a hairline (it sits on the chat canvas). The emails
 * that went along show as chips above it. The agent's own skills it names show as the chips they were in the
 * input. An approval or decline taken in the chat is a centred system line instead.
 */
@Composable
fun UserMessage(item: Item.User, skills: List<OwnSkill>, animate: Boolean, modifier: Modifier = Modifier) {
    val c = Rk.colors
    if (item.action == "approved" || item.action == "declined") {
        DecisionLine(item, animate, modifier)
        return
    }
    Column(
        modifier.fillMaxWidth().padding(start = 56.dp).then(if (animate) Modifier.fadeUp(RukooDurations.FADE_UP) else Modifier),
        horizontalAlignment = Alignment.End,
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        val emails = item.emails.orEmpty()
        val files = item.files.orEmpty()
        if (emails.isNotEmpty() || files.isNotEmpty()) {
            @OptIn(ExperimentalLayoutApi::class)
            FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp, Alignment.End), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                val noSubject = stringResource(R.string.agentui_no_subject)
                emails.forEach { m ->
                    EntityChip(
                        m.subject.ifBlank { noSubject },
                        sub = ChatFormat.person(m.from).takeIf { it.isNotEmpty() },
                        leading = { SourceBadge("", email = true, emailIcon = PanelIcons.Mail, size = 16.dp) },
                        animateEntry = false,
                    )
                }
                files.forEach { f ->
                    EntityChip(f.name, leading = { RkIcon(PanelIcons.File, null, size = 14.dp, tint = c.ink3) }, animateEntry = false)
                }
            }
        }
        if (item.text.isNotEmpty() || (emails.isEmpty() && files.isEmpty())) {
            val shape = RoundedCornerShape(12.dp)
            SelectionContainer {
                TextWithSkills(
                    item.text,
                    skills,
                    Rk.type.panelBody.lineHeight(1.4f),
                    c.ink,
                    Modifier.background(c.raised, shape).border(1.dp, c.line, shape).padding(horizontal = 12.dp, vertical = 6.dp),
                )
            }
        }
    }
}

/** "You approved  Add the call to your calendar", centred: the user's decision on a proposal. */
@Composable
private fun DecisionLine(item: Item.User, animate: Boolean, modifier: Modifier) {
    val c = Rk.colors
    val approved = item.action == "approved"
    Row(
        modifier.fillMaxWidth().then(if (animate) Modifier.fadeUp(RukooDurations.FADE_UP) else Modifier).padding(horizontal = 12.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp, Alignment.CenterHorizontally),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(14.dp).background(if (approved) c.green else c.red, CircleShape), contentAlignment = Alignment.Center) {
            RkIcon(PanelIcons.named(if (approved) "check" else "x", 3.5f), null, size = 9.dp, tint = Color.White)
        }
        Text(
            stringResource(if (approved) R.string.agentui_items_you_approved else R.string.agentui_items_you_declined),
            style = Rk.type.text12.panel,
            color = c.ink3,
            maxLines = 1,
        )
        Text(Unsafe.untag(item.text), style = Rk.type.text12.medium.panel, color = c.ink2, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
    }
}

/**
 * Text with the agent's skills it names (`$name`) as inline chips: the box icon and the skill's label, in the
 * skill color. Each chip is measured, so it takes exactly its room; copying it copies `$name`.
 */
@Composable
fun TextWithSkills(text: String, skills: List<OwnSkill>, style: TextStyle, color: Color, modifier: Modifier = Modifier) {
    val parts = remember(text, skills) { ChatInputLogic.skillParts(text, skills) }
    if (parts.none { it is SkillPart.Skill }) {
        Text(text, modifier, style = style, color = color)
        return
    }
    val measurer = rememberTextMeasurer()
    val density = LocalDensity.current
    val chipStyle = style.copy(fontSize = style.fontSize * 0.86f, fontWeight = RukooWeights.Medium, lineHeight = 1.em)
    val annotated = buildAnnotatedString {
        parts.forEachIndexed { i, p ->
            when (p) {
                is SkillPart.Text -> append(p.text)
                is SkillPart.Skill -> appendInlineContent("skill$i", "$${p.skill.name}")
            }
        }
    }
    val inline = parts.mapIndexedNotNull { i, p ->
        val skill = (p as? SkillPart.Skill)?.skill ?: return@mapIndexedNotNull null
        val label = ChatInputLogic.skillLabel(skill.name)
        val labelPx = measurer.measure(AnnotatedString(label), chipStyle).size.width
        val em = with(density) { chipStyle.fontSize.toPx() }
        // bui-skill: padding 0.5em, an icon of 1.17em and a 0.33em gap, in the chip's own 0.86em size.
        val widthPx = labelPx + em * (1.17f + 0.33f + 1f) + 2f
        "skill$i" to InlineTextContent(Placeholder(with(density) { widthPx.toSp() }, 1.41.em, PlaceholderVerticalAlign.TextCenter)) {
            val description = stringResource(R.string.agentui_panel_skill_chip, label)
            SkillChip(label, chipStyle, Modifier.semantics { contentDescription = description })
        }
    }.toMap()
    Text(annotated, modifier, style = style, color = color, inlineContent = inline)
}

/** An agent's own skill inline: box icon and label in the skill color on its tint (agent.css `.bui-skill`). */
@Composable
fun SkillChip(label: String, style: TextStyle, modifier: Modifier = Modifier) {
    val c = Rk.colors
    val shape = RoundedCornerShape(6.dp)
    Row(
        modifier
            .fillMaxSize()
            .background(c.skill.copy(alpha = 0.11f), shape)
            .border(1.dp, lerp(c.lineStrong, c.skill, 0.34f), shape)
            .padding(horizontal = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(3.dp, Alignment.CenterHorizontally),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        val ink = lerp(c.ink, c.skill, 0.22f)
        RkIcon(PanelIcons.Skill, null, size = 12.dp, tint = ink)
        Text(label, style = style, color = ink, maxLines = 1, softWrap = false)
    }
}

// ---------- assistant ----------

/**
 * How much of a streaming answer shows: it reveals at two characters per 9ms tick, faster when a big chunk
 * arrived (bui.js streamText), redrawn every 80ms. A finished or stopped answer shows in full at once, without the
 * caret, and so does every answer when the system removes animations. Saved per item, so an answer that scrolls
 * out of the list and back doesn't stream again.
 */
@Composable
private fun rememberRevealed(id: String, text: String, streaming: Boolean): Int {
    val animated = streaming && !Rk.motion.reduced
    var count by rememberSaveable(id) { mutableIntStateOf(if (animated) 0 else text.length) }
    val latest = rememberUpdatedState(text)
    val live = rememberUpdatedState(animated)
    LaunchedEffect(id) {
        var seen = ""
        snapshotFlow { latest.value to live.value }.collect { (t, s) ->
            // A text that was replaced rather than extended starts over.
            if (!t.startsWith(seen.take(count))) count = 0
            seen = t
            if (!s) {
                count = t.length
                return@collect
            }
            while (count < latest.value.length && live.value) {
                val now = latest.value
                var next = count
                repeat(9) { next = ChatFormat.revealStep(now, next) }
                count = next
                delay(80)
            }
        }
    }
    return if (animated) count.coerceAtMost(text.length) else text.length
}

/**
 * The agent's answer: Markdown at 13/1.625 in `ink`, selectable, with a solid caret while text arrives that goes
 * away when the answer is complete. Interim commentary between tool calls is lighter (12.5 `ink2`); a stopped
 * answer dims to 75%. Finished blocks are parsed once; only the block still growing is parsed again.
 */
@Composable
fun AssistantMessage(item: Item.Assistant, onLink: (String) -> Unit, modifier: Modifier = Modifier) {
    val c = Rk.colors
    val streaming = item.status == AssistantStatus.STREAMING
    val count = rememberRevealed(item.id, item.text, streaming)
    val style = if (item.interim) Rk.type.text12_5.panel.lineHeight(1.625f) else Rk.type.panelProse
    val color = if (item.interim) c.ink2 else c.ink
    val live = streaming || count < item.text.length
    val shownModifier = modifier.fillMaxWidth().alpha(if (item.status == AssistantStatus.STOPPED) 0.75f else 1f)
    SelectionContainer(shownModifier) {
        if (!live) {
            val doc = remember(item.text) { parseMarkdown(item.text) }
            AgentMarkdown(doc, style = style, color = color, onLink = onLink)
        } else {
            val shown = item.text.substring(0, count)
            val cut = ChatFormat.settleCut(shown, 0)
            val settledText = shown.substring(0, cut)
            val settled = remember(settledText) { parseMarkdown(settledText) }
            val tail = shown.substring(cut)
            val growing = remember(tail) { parseMarkdown(ChatFormat.closeOpen(tail)) }
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                if (cut > 0) AgentMarkdown(settled, style = style, color = color, onLink = onLink)
                AgentMarkdown(growing, style = style, color = color, caret = true, onLink = onLink)
            }
        }
    }
}

// ---------- thinking ----------

/**
 * The agent's thinking (bui.js `thinking`): "Thinking" in shimmer with its seconds while it runs, then "Thought for
 * 4s" that fades in. The trace opens by itself while it runs with text and closes when done; a tap toggles it.
 */
@Composable
fun ThinkingBlock(item: Item.Thinking, modifier: Modifier = Modifier) {
    val c = Rk.colors
    val running = item.status == ThinkingStatus.RUNNING
    val hasText = item.text.isNotEmpty()
    var manual by rememberSaveable(item.id) { mutableStateOf<Boolean?>(null) }
    val open = hasText && (manual ?: running)
    val now = rememberNow(running, 500)
    val seconds = ChatFormat.seconds(item.startedAt, item.endedAt ?: if (running) now else item.startedAt)
    val expanded = stringResource(R.string.agentui_a11y_expanded)
    val collapsed = stringResource(R.string.agentui_a11y_collapsed)
    Column(modifier.fillMaxWidth()) {
        Row(
            Modifier
                .outset(6.dp)
                .heightIn(min = 32.dp)
                .rkClickable(Rk.shapes.control, enabled = hasText) { manual = !open }
                .semantics { if (hasText) stateDescription = if (open) expanded else collapsed }
                .padding(horizontal = 6.dp, vertical = 4.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            RkIcon(PanelIcons.Sparkle, null, size = 16.dp, tint = if (running) c.ink2 else c.ink3)
            if (running) {
                ShimmerText(stringResource(R.string.agentui_items_thinking), style = Rk.type.panelBody.medium, periodMs = RukooDurations.SHIMMER_THINKING)
                Text("${seconds}s", style = Rk.type.mono.tabular, color = c.ink3, maxLines = 1)
            } else {
                // "Thought for 4s" fades in when the thinking ends on screen; an older one is simply there.
                val fade = remember(item.id) { Animatable(if (item.endedAt != null && System.currentTimeMillis() - item.endedAt > 1000) 1f else 0f) }
                val spec = Rk.motion.tween<Float>(350, RukooEasing.Out)
                LaunchedEffect(item.id) { fade.animateTo(1f, spec) }
                Text(
                    stringResource(R.string.agentui_items_thought_for, seconds.toInt()),
                    style = Rk.type.panelBody.medium,
                    color = c.ink2,
                    maxLines = 1,
                    modifier = Modifier.graphicsLayer { alpha = fade.value },
                )
            }
            if (hasText) ExpandChevron(open)
        }
        RkExpandable(open) {
            val line = c.line
            SelectionContainer {
                Text(
                    item.text,
                    style = Rk.type.text12_5.panel.lineHeight(1.625f),
                    color = c.ink2,
                    modifier = Modifier
                        .fillMaxWidth()
                        .drawBehind { drawLine(line, Offset(7.5.dp.toPx(), 0f), Offset(7.5.dp.toPx(), size.height), 1.dp.toPx()) }
                        .padding(start = 21.dp, top = 2.dp, bottom = 4.dp),
                )
            }
        }
    }
}

// ---------- tools ----------

/**
 * Consecutive tool calls as one wrapping row of chips. A chip with details opens them under the row, beside a
 * hairline rail; one at a time per row.
 */
@Composable
fun ToolRow(row: TranscriptRow.Tools, animate: Boolean, modifier: Modifier = Modifier) {
    var open by rememberSaveable(row.key) { mutableStateOf<String?>(null) }
    Column(modifier.fillMaxWidth()) {
        @OptIn(ExperimentalLayoutApi::class)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            row.chips.forEach { chip ->
                ToolChip(chip, open == chip.key, animate) { open = if (open == chip.key) null else chip.key }
            }
        }
        row.chips.forEach { chip ->
            if (chip.detail.isNotEmpty()) {
                CollapsibleRail(open == chip.key) { RailText(chip.detail, mono = chip.kind == ToolChipKind.COMMAND) }
            }
        }
    }
}

@Composable
private fun ToolChip(chip: ToolChipModel, open: Boolean, animate: Boolean, onToggle: () -> Unit) {
    val c = Rk.colors
    val shape = Rk.shapes.chip
    val label = AgentText.tool(chip.label).text()
    val status = stringResource(
        when (chip.status) {
            ToolStatus.RUNNING -> R.string.agentui_plan_running
            ToolStatus.DONE -> R.string.agentui_plan_done
            ToolStatus.ERROR -> R.string.agentui_plan_failed
        },
    )
    val hasDetail = chip.detail.isNotEmpty()
    val expanded = stringResource(R.string.agentui_a11y_expanded)
    val collapsed = stringResource(R.string.agentui_a11y_collapsed)
    var m = Modifier
        .then(if (animate) Modifier.popIn(250) else Modifier)
        .heightIn(min = 30.dp)
        .rkSurface(Rk.elevation.btn, shape, if (open) c.hover2 else c.surface)
    if (hasDetail) m = m.rkClickable(shape, onClick = onToggle)
    Row(
        m
            // One description for the whole chip, so TalkBack doesn't read the label twice.
            .clearAndSetSemantics {
                contentDescription = if (chip.count > 1) "$label ×${chip.count}, $status" else "$label, $status"
                if (hasDetail) stateDescription = if (open) expanded else collapsed
            }
            .padding(start = 7.dp, end = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        RkIcon(PanelIcons.named(chip.kind.icon), null, size = 14.dp, tint = if (chip.rukoo) c.accentInk else c.ink3)
        Text(
            label,
            style = Rk.type.text12.medium.panel,
            color = if (chip.status == ToolStatus.RUNNING) c.ink2 else c.ink,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f, fill = false),
        )
        if (chip.count > 1) Text("×${chip.count}", style = Rk.type.text12.medium.panel.tabular, color = c.ink3, maxLines = 1)
        when (chip.status) {
            ToolStatus.RUNNING -> Spinner(size = 12.dp)
            ToolStatus.DONE -> RkIcon(PanelIcons.named("check", 3f), null, size = 11.dp, tint = c.green)
            ToolStatus.ERROR -> RkIcon(PanelIcons.named("x", 3f), null, size = 11.dp, tint = c.red)
        }
    }
}

// ---------- notice ----------

/**
 * A quiet line for what happened (bui.js `noticeLine`): a 16dp mark (minus, green check, red x), the sentence and
 * an optional Undo. An error shows its technical cause under the sentence in small mono type.
 */
@Composable
fun NoticeLine(item: Item.Notice, agentName: String, onUndo: ((failed: () -> Unit) -> Unit)?, animate: Boolean, modifier: Modifier = Modifier) {
    val c = Rk.colors
    val text = AgentText.notice(item, agentName).text()
    var undoing by remember(item.id, item.undo) { mutableStateOf(false) }
    Column(modifier.fillMaxWidth().then(if (animate) Modifier.fadeUp(200) else Modifier)) {
        Row(Modifier.padding(vertical = 2.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            val (background, mark) = when (item.tone) {
                Tone.SUCCESS -> c.green to PanelIcons.named("check", 3.5f)
                Tone.ERROR -> c.red to PanelIcons.named("x", 3.5f)
                Tone.INFO -> c.lineStrong to PanelIcons.named("minus", 3f)
            }
            Box(Modifier.padding(top = 2.dp).size(16.dp).background(background, CircleShape), contentAlignment = Alignment.Center) {
                RkIcon(mark, null, size = 9.dp, tint = if (item.tone == Tone.INFO) c.ink2 else Color.White)
            }
            SelectionContainer(Modifier.weight(1f)) {
                Text(text, style = Rk.type.text12_5.panel, color = if (item.tone == Tone.ERROR) c.ink else c.ink2)
            }
            if (item.undo != null && onUndo != null) {
                Text(
                    stringResource(R.string.common_actions_undo),
                    style = Rk.type.text12.medium.panel,
                    color = c.accentInk,
                    maxLines = 1,
                    modifier = Modifier
                        .alpha(if (undoing) 0.5f else 1f)
                        .rkClickable(RoundedCornerShape(3.dp), enabled = !undoing) {
                            undoing = true
                            onUndo { undoing = false }
                        }
                        .padding(horizontal = 2.dp, vertical = 1.dp),
                )
            }
        }
        val detail = item.detail
        if (item.tone == Tone.ERROR && !detail.isNullOrBlank()) {
            SelectionContainer {
                Text(
                    detail,
                    style = Rk.type.mono.copy(fontSize = Rk.type.text11.fontSize),
                    color = c.text3,
                    modifier = Modifier.padding(start = 24.dp, top = 2.dp),
                )
            }
        }
    }
}

// ---------- approval ----------

// Commands, paths and file contents: monospaced, in a box across the card.
private val CODE_FIELDS = setOf("command", "path", "file", "folder", "pattern", "diff", "content", "before", "after")
private const val LONG_CHARS = 400
private const val LONG_LINES = 6

/**
 * An approval card (bui.js `approvalCard`): the question as the title, a short body and the details as label and
 * value rows. While it waits, "Waiting for you" shimmers on the left and the choices sit on the right (danger,
 * then secondary, then primary); four or more form a 2×2 grid. After the decision the card shrinks to a done pill.
 * A tap disables every choice until the answer arrives.
 */
@Composable
fun ApprovalCard(
    item: Item.Approval,
    agentName: String,
    onChoose: (choiceId: String, failed: () -> Unit) -> Unit,
    animate: Boolean,
    modifier: Modifier = Modifier,
) {
    val c = Rk.colors
    val shown = remember(item, agentName) { AgentText.approval(item, agentName) }
    val pending = item.status == ApprovalStatus.PENDING
    var choosing by remember(item.id, item.status) { mutableStateOf(false) }
    PanelCard(modifier.then(if (animate) Modifier.fadeUp(RukooDurations.CARD) else Modifier), padding = 0.dp) {
        Column(Modifier.fillMaxWidth().padding(12.dp)) {
            Text(
                shown.title.text(),
                style = if (pending) Rk.type.text14.medium.panel.lineHeight(1.4f) else Rk.type.text13.medium.panel,
                color = if (item.status == ApprovalStatus.EXPIRED) c.ink3 else c.ink,
            )
            if (pending && shown.detail.isNotBlank()) {
                SelectionContainer {
                    Text(shown.detail, style = Rk.type.text12_5.panel.lineHeight(1.625f), color = c.ink2, modifier = Modifier.padding(top = 6.dp))
                }
            }
            if (pending && shown.fields.isNotEmpty()) ApprovalFields(shown.fields, Modifier.padding(top = 10.dp))
        }
        val sorted = shown.choices.sortedBy { order(it.kind) }
        BoxWithConstraints(Modifier.fillMaxWidth().padding(start = 12.dp, end = 10.dp, bottom = 10.dp)) {
            val narrow = maxWidth <= 300.dp
            if (!pending) {
                DecidedState(item, shown)
            } else if (sorted.size > 3) {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    ShimmerText(stringResource(R.string.agentui_items_waiting), style = Rk.type.text12.medium.panel)
                    // Four choices (Hermes) don't fit on one row: two by two, so the primary never ends up alone.
                    sorted.chunked(if (narrow) 1 else 2).forEach { pair ->
                        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            pair.forEach { choice ->
                                ChoiceButton(choice, !choosing, Modifier.weight(1f)) {
                                    choosing = true
                                    onChoose(choice.id) { choosing = false }
                                }
                            }
                            if (pair.size == 1 && !narrow) Spacer(Modifier.weight(1f))
                        }
                    }
                }
            } else {
                @OptIn(ExperimentalLayoutApi::class)
                FlowRow(
                    Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                    itemVerticalAlignment = Alignment.CenterVertically,
                ) {
                    ShimmerText(stringResource(R.string.agentui_items_waiting), style = Rk.type.text12.medium.panel, modifier = Modifier.padding(vertical = 6.dp))
                    Row(Modifier.weight(1f), horizontalArrangement = Arrangement.spacedBy(6.dp, Alignment.End)) {
                        sorted.forEach { choice ->
                            ChoiceButton(choice, !choosing) {
                                choosing = true
                                onChoose(choice.id) { choosing = false }
                            }
                        }
                    }
                }
            }
        }
    }
}

private fun order(kind: ChoiceKind) = when (kind) {
    ChoiceKind.DANGER -> 0
    ChoiceKind.DEFAULT -> 1
    ChoiceKind.PRIMARY -> 2
}

@Composable
private fun ChoiceButton(choice: ShownChoice, enabled: Boolean, modifier: Modifier = Modifier, onClick: () -> Unit) {
    RkPillButton(
        choice.label.text(),
        onClick,
        modifier,
        kind = when (choice.kind) {
            ChoiceKind.PRIMARY -> RkPillKind.PRIMARY
            ChoiceKind.DANGER -> RkPillKind.DANGER
            ChoiceKind.DEFAULT -> RkPillKind.SECONDARY
        },
        size = RkPillSize.SM,
        enabled = enabled,
    )
}

@Composable
private fun DecidedState(item: Item.Approval, shown: ShownApproval) {
    val c = Rk.colors
    val (label, tone) = when (item.status) {
        ApprovalStatus.APPROVED -> R.string.agentui_items_approved to DoneTone.APPROVED
        ApprovalStatus.DENIED -> R.string.agentui_items_denied to DoneTone.DECLINED
        else -> R.string.agentui_items_expired to DoneTone.EXPIRED
    }
    val doneLabel = stringResource(label)
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
        DonePill(doneLabel, tone)
        // The chosen option is named only when there were several to choose from ("Approved  Allow for this turn").
        val chosen = if (shown.choices.size > 2) shown.choices.firstOrNull { it.id == item.decision }?.label?.text() else null
        if (chosen != null && chosen != doneLabel) {
            Text(chosen, style = Rk.type.text12_5.panel, color = c.ink2, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}

/**
 * The fields of an approval card: label and value in two columns, labels in `ink3` as wide as the widest (at most
 * 40%). Code-like fields span the card in a mono box. Long values fold to about six lines with "Show all".
 */
@Composable
private fun ApprovalFields(fields: List<ShownField>, modifier: Modifier = Modifier) {
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        var i = 0
        while (i < fields.size) {
            if (fields[i].key in CODE_FIELDS) {
                CodeField(fields[i])
                i++
            } else {
                val start = i
                while (i < fields.size && fields[i].key !in CODE_FIELDS) i++
                FieldGrid(fields.subList(start, i))
            }
        }
    }
}

@Composable
private fun FieldGrid(fields: List<ShownField>) {
    val c = Rk.colors
    val style = Rk.type.text12_5.panel
    Layout(
        content = {
            fields.forEach { f ->
                Text(f.label.text(), style = style, color = c.ink3)
                Column { FoldableValue(f, style, c.ink, code = false) }
            }
        },
    ) { measurables, constraints ->
        val gap = 12.dp.roundToPx()
        val rowGap = 4.dp.roundToPx()
        val labelMax = (constraints.maxWidth * 0.4f).toInt()
        val labels = measurables.filterIndexed { i, _ -> i % 2 == 0 }
        val values = measurables.filterIndexed { i, _ -> i % 2 == 1 }
        val labelWidth = labels.maxOfOrNull { it.maxIntrinsicWidth(Constraints.Infinity) }?.coerceAtMost(labelMax) ?: 0
        val valueWidth = (constraints.maxWidth - labelWidth - gap).coerceAtLeast(0)
        val placedLabels = labels.map { it.measure(Constraints(maxWidth = labelWidth)) }
        val placedValues = values.map { it.measure(Constraints(maxWidth = valueWidth)) }
        val heights = placedLabels.indices.map { max(placedLabels[it].height, placedValues[it].height) }
        val total = heights.sum() + rowGap * (heights.size - 1).coerceAtLeast(0)
        layout(constraints.maxWidth, total) {
            var y = 0
            heights.forEachIndexed { r, h ->
                placedLabels[r].placeRelative(0, y)
                placedValues[r].placeRelative(labelWidth + gap, y)
                y += h + rowGap
            }
        }
    }
}

@Composable
private fun CodeField(f: ShownField) {
    val c = Rk.colors
    val shape = RoundedCornerShape(6.dp)
    Column(Modifier.fillMaxWidth().padding(vertical = 2.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(f.label.text(), style = Rk.type.text12_5.panel, color = c.ink3)
        Column(Modifier.fillMaxWidth().background(c.inset, shape).border(1.dp, c.lineSoft, shape).padding(horizontal = 8.dp, vertical = 6.dp)) {
            FoldableValue(f, Rk.type.mono, c.ink, code = true)
        }
    }
}

/** A value that folds past 400 characters or six lines, with a fade and "Show all" / "Show less". */
@Composable
private fun FoldableValue(f: ShownField, style: TextStyle, color: Color, code: Boolean) {
    val c = Rk.colors
    val value = f.value.text()
    val long = value.length > LONG_CHARS || value.lines().size > LONG_LINES
    var unfolded by rememberSaveable(f.label, value) { mutableStateOf(false) }
    val folded = long && !unfolded
    SelectionContainer {
        Text(
            value,
            style = style,
            color = color,
            maxLines = if (folded) LONG_LINES else Int.MAX_VALUE,
            overflow = TextOverflow.Clip,
            modifier = if (folded) {
                Modifier
                    .graphicsLayer(compositingStrategy = CompositingStrategy.Offscreen)
                    .drawWithContent {
                        drawContent()
                        drawRect(Brush.verticalGradient(0.55f to Color.Black, 1f to Color.Transparent), blendMode = BlendMode.DstIn)
                    }
            } else {
                Modifier
            },
        )
    }
    if (long) {
        Text(
            stringResource(if (unfolded) R.string.agentui_approval_show_less else R.string.agentui_approval_show_all),
            style = Rk.type.text12.medium.panel,
            color = c.accentInk,
            modifier = Modifier.padding(top = 4.dp).rkClickable(RoundedCornerShape(3.dp)) { unfolded = !unfolded },
        )
    }
    if (f.truncated > 0) {
        val shown = NumberFormat.getIntegerInstance().format(f.truncated)
        Text(
            Txt.Plural(R.plurals.agentui_approval_truncated, f.truncated, listOf(shown)).text(),
            style = Rk.type.text12.panel,
            color = c.ink3,
            modifier = Modifier.padding(top = 4.dp),
        )
    }
}

// ---------- plan ----------

/**
 * A plan (bui.js `taskRows`): a heading with the count, then task rows on a card. Each row has a numbered ring
 * (spinning while the task runs) or a badge once it ended, the task, its system, a status pill and, with details,
 * a chevron that opens them.
 */
@Composable
fun PlanBlock(item: Item.Plan, onOpenUrl: (String) -> Unit, animate: Boolean, modifier: Modifier = Modifier) {
    val c = Rk.colors
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        PanelHeading(Unsafe.untag(item.title).ifBlank { stringResource(R.string.agentui_items_plan) }, count = item.tasks.size)
        if (item.tasks.isNotEmpty()) {
            Column(Modifier.fillMaxWidth().rkSurface(Rk.elevation.card, Rk.shapes.card, c.surface)) {
                item.tasks.forEachIndexed { i, task ->
                    if (i > 0) Hairline(color = c.line)
                    TaskRow(task, i, onOpenUrl, animate)
                }
            }
        }
    }
}

@Composable
private fun TaskRow(task: PlanTask, index: Int, onOpenUrl: (String) -> Unit, animate: Boolean) {
    val c = Rk.colors
    val title = Unsafe.untag(task.title)
    val detail = Unsafe.untag(task.detail)
    val system = Unsafe.untag(task.system)
    val owner = Unsafe.untag(task.owner)
    val due = Unsafe.untag(task.due)
    val url = task.url?.takeIf { ChatFormat.openableLink(it) }
    val hasDetail = detail.isNotEmpty() || owner.isNotEmpty() || due.isNotEmpty() || url != null
    var open by rememberSaveable(task.id) { mutableStateOf(false) }
    val expanded = stringResource(R.string.agentui_a11y_expanded)
    val collapsed = stringResource(R.string.agentui_a11y_collapsed)
    Column(Modifier.fillMaxWidth().then(if (animate) Modifier.fadeUp(450, index * RukooDurations.STAGGER) else Modifier)) {
        BoxWithConstraints(Modifier.fillMaxWidth()) {
            val systemMax = maxWidth * 0.3f
            Row(
                Modifier
                    .fillMaxWidth()
                    .heightIn(min = 44.dp)
                    .rkClickable(Rk.shapes.chip, enabled = hasDetail) { open = !open }
                    .semantics { if (hasDetail) stateDescription = if (open) expanded else collapsed }
                    .padding(horizontal = 10.dp, vertical = 8.dp),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                TaskSlot(task.status, index + 1)
                Text(
                    title,
                    style = Rk.type.text13.medium.panel.copy(textDecoration = if (task.status == TaskStatus.SKIPPED) TextDecoration.LineThrough else null),
                    color = if (task.status == TaskStatus.SKIPPED) c.ink3 else c.ink,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                if (system.isNotEmpty()) {
                    Text(system, style = Rk.type.text12_5.panel, color = c.ink2, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.widthIn(max = systemMax))
                }
                val pill = when (task.status) {
                    TaskStatus.DONE -> RkStatus.DONE
                    TaskStatus.FAILED -> RkStatus.FAILED
                    TaskStatus.PROPOSED -> RkStatus.PROPOSED
                    TaskStatus.SKIPPED -> RkStatus.NEUTRAL
                    else -> null
                }
                if (pill != null) StatusPill(AgentText.plan(task.status).text(), pill)
                if (hasDetail) Box(Modifier.size(28.dp), contentAlignment = Alignment.Center) { ExpandChevron(open, size = 15.dp) }
            }
        }
        if (hasDetail) {
            RkExpandable(open) {
                Row(Modifier.fillMaxWidth().padding(start = 10.dp, end = 10.dp, bottom = 10.dp)) {
                    Box(Modifier.width(24.dp).heightIn(min = 16.dp)) {
                        Box(Modifier.align(Alignment.TopCenter).width(1.dp).fillMaxHeight().background(c.line))
                    }
                    Column(Modifier.weight(1f).padding(start = 10.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        if (detail.isNotEmpty()) SelectionContainer { Text(detail, style = Rk.type.text12_5.panel, color = c.ink2) }
                        if (owner.isNotEmpty()) TaskStep(PanelIcons.Person, owner)
                        if (due.isNotEmpty()) TaskStep(PanelIcons.Calendar, due)
                        if (url != null) {
                            Row(
                                Modifier.rkClickable(RoundedCornerShape(4.dp)) { onOpenUrl(url) },
                                horizontalArrangement = Arrangement.spacedBy(4.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Text(ChatFormat.hostOf(url), style = Rk.type.text12.medium.panel, color = c.accentInk, maxLines = 1)
                                RkIcon(PanelIcons.named("arrow-out", 2.5f), null, size = 10.dp, tint = c.accentInk)
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun TaskStep(icon: androidx.compose.ui.graphics.vector.ImageVector, text: String) {
    val c = Rk.colors
    Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
        RkIcon(icon, null, size = 12.dp, tint = c.ink3)
        Text(text, style = Rk.type.text12.panel, color = c.ink2)
    }
}

/** The 24dp slot of a task: a numbered ring, spinning while it runs, or a badge once the task ended. */
@Composable
private fun TaskSlot(status: TaskStatus, number: Int) {
    val c = Rk.colors
    Box(Modifier.size(24.dp), contentAlignment = Alignment.Center) {
        val badge = when (status) {
            TaskStatus.DONE -> Triple(c.green, PanelIcons.named("check", 3.5f), 13.dp)
            TaskStatus.FAILED -> Triple(c.red, PanelIcons.named("x", 3.5f), 12.dp)
            TaskStatus.SKIPPED -> Triple(c.lineStrong, PanelIcons.named("minus", 3f), 12.dp)
            else -> null
        }
        if (badge != null) {
            Box(Modifier.popIn(300).size(22.dp).background(badge.first, CircleShape), contentAlignment = Alignment.Center) {
                RkIcon(badge.second, null, size = badge.third, tint = if (status == TaskStatus.SKIPPED) c.ink2 else Color.White)
            }
        } else {
            val running = status == TaskStatus.RUNNING
            val turn = if (running && !Rk.motion.reduced) {
                rememberInfiniteTransition(label = "ring").animateFloat(0f, 360f, infiniteRepeatable(tween(1100, easing = LinearEasing)), label = "ring").value
            } else {
                0f
            }
            val track = c.line
            val arc = c.ink3
            Canvas(Modifier.size(24.dp)) {
                val w = 2.dp.toPx()
                val r = 11.dp.toPx()
                val topLeft = Offset(center.x - r, center.y - r)
                drawCircle(track, r, style = Stroke(w))
                // CSS: a 19.352 dash on a circle of 69.1, about 101° of arc.
                if (running) rotate(turn) { drawArc(arc, -90f, 100.8f, false, topLeft, Size(2 * r, 2 * r), style = Stroke(w, cap = StrokeCap.Round)) }
            }
            Text(
                number.toString(),
                style = Rk.type.text11.copy(fontSize = Rk.type.text11.fontSize * 0.88f, fontWeight = RukooWeights.Semibold, lineHeight = 1.em),
                color = if (status == TaskStatus.PROPOSED) c.ink3 else c.ink,
                textAlign = TextAlign.Center,
            )
        }
    }
}

// ---------- sources ----------

/** Sources as context cards that name the email or page and open it; an email opens in the reader. */
@Composable
fun SourcesBlock(item: Item.Sources, onOpen: (SourceRef) -> Unit, animate: Boolean, modifier: Modifier = Modifier) {
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        PanelHeading(Unsafe.untag(item.title).ifBlank { stringResource(R.string.agentui_items_sources) }, count = item.sources.size)
        val email = stringResource(R.string.agentui_items_email_source)
        item.sources.forEachIndexed { i, source ->
            val isMail = source.messageId != null
            val url = source.url?.takeIf { ChatFormat.openableLink(it) }
            val host = url?.let { ChatFormat.hostOf(it) }
            val title = Unsafe.untag(source.title).ifBlank { source.source.ifBlank { host.orEmpty() } }
            ContextCard(
                title,
                kind = if (isMail) SourceKind.EMAIL else if (url != null) SourceKind.WEB else SourceKind.OTHER,
                host = host,
                excerpt = Unsafe.untag(source.snippet).takeIf { it.isNotBlank() },
                sourceLabel = source.source.ifBlank { if (isMail) email else host.orEmpty() }.takeIf { it.isNotBlank() },
                onOpen = if (isMail || url != null) ({ onOpen(source) }) else null,
                delayMs = i * 100,
                animateEntry = animate,
            )
        }
    }
}

// ---------- draft ----------

/**
 * The draft card after write_draft: what the agent wrote and to whom, with Show and Undo. Undo is off once that
 * composer is gone; an undone draft greys out with an "Undone" pill.
 */
@Composable
fun DraftCard(item: Item.Draft, canUndo: Boolean, onShow: () -> Unit, onUndo: () -> Unit, animate: Boolean, modifier: Modifier = Modifier) {
    val c = Rk.colors
    val undone = item.undone
    PanelCard(modifier.then(if (animate) Modifier.fadeUp(RukooDurations.CARD) else Modifier), padding = 0.dp) {
        Row(
            Modifier.fillMaxWidth().padding(start = 12.dp, top = 8.dp, end = 8.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(Modifier.size(22.dp).background(if (undone) c.field else c.accentTint, RoundedCornerShape(6.dp)), contentAlignment = Alignment.Center) {
                RkIcon(PanelIcons.named("pen", 2f), null, size = 12.dp, tint = if (undone) c.ink3 else c.accentInk)
            }
            // Two lines: on the cover screen Dutch's "Ongedaan maken" leaves the title little room.
            Text(
                AgentText.draft(item.mode).text(),
                style = Rk.type.text13.medium.panel,
                color = if (undone) c.ink3 else c.ink,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            RkPillButton(stringResource(R.string.agentui_draft_show), onShow, kind = RkPillKind.SECONDARY, size = RkPillSize.XS)
            if (undone) {
                StatusPill(stringResource(R.string.agentui_draft_undone), RkStatus.NEUTRAL)
            } else {
                val cannot = stringResource(R.string.agentui_draft_cannot_undo)
                RkPillButton(
                    stringResource(R.string.common_actions_undo),
                    onUndo,
                    Modifier.semantics { if (!canUndo) stateDescription = cannot },
                    kind = RkPillKind.QUIET,
                    size = RkPillSize.XS,
                    enabled = canUndo,
                )
            }
        }
        val meta = listOf(ChatFormat.people(item.to), item.subject).filter { it.isNotBlank() }.joinToString(" · ")
        if (meta.isNotEmpty()) {
            Text(meta, style = Rk.type.text12.panel, color = c.ink3, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(horizontal = 12.dp))
        }
        if (item.summary.isNotBlank()) {
            SelectionContainer {
                Text(
                    item.summary,
                    style = Rk.type.text12_5.panel,
                    color = if (undone) c.ink3 else c.ink2,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.padding(start = 12.dp, end = 12.dp, top = 4.dp, bottom = 10.dp),
                )
            }
        } else {
            Spacer(Modifier.height(10.dp))
        }
    }
}

// ---------- live work ----------

/** "Clark is working on it..." in shimmer with its seconds, between the user's message and the first output. */
@Composable
fun WorkingLabel(agentName: String, since: Long, modifier: Modifier = Modifier) {
    val now = rememberNow(true, 500)
    val seconds = if (since > 0) max(0L, (now - since) / 1000) else 0L
    Row(modifier, horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
        ShimmerText(stringResource(R.string.agentui_items_working, agentName), style = Rk.type.panelBody.medium, modifier = Modifier.weight(1f, fill = false))
        Text("${seconds}s", style = Rk.type.mono.tabular, color = Rk.colors.ink3, maxLines = 1)
    }
}

/** The pixel loader with a shimmer label and a timer in tenths of a second (bui.js `loadingState`). */
@Composable
fun LoadingState(label: String, modifier: Modifier = Modifier) {
    val started = remember { System.currentTimeMillis() }
    val now = rememberNow(true, 100)
    Row(modifier, horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
        PixelLoader()
        ShimmerText(label, style = Rk.type.panelBody.medium, periodMs = RukooDurations.SHIMMER_THINKING)
        Text(
            ChatFormat.elapsed(now - started),
            style = Rk.type.text12.copy(fontFamily = RukooMono).tabular,
            color = Rk.colors.ink3,
            maxLines = 1,
        )
    }
}

/** The 28dp round "jump to latest" button: raised, small shadow, a down arrow. */
@Composable
fun JumpButton(onClick: () -> Unit, modifier: Modifier = Modifier) {
    val c = Rk.colors
    val label = stringResource(R.string.agentui_panel_jump)
    Box(
        modifier
            .popIn(RukooDurations.POPOVER)
            .size(32.dp)
            .rkShadow(Rk.elevation.shadowSm, CircleShape)
            .background(c.raised, CircleShape)
            .border(1.dp, c.line, CircleShape)
            .rkClickable(CircleShape, onClick = onClick)
            .semantics { contentDescription = label },
        contentAlignment = Alignment.Center,
    ) {
        RkIcon(PanelIcons.Chevron, null, size = 15.dp, tint = c.ink2)
    }
}
