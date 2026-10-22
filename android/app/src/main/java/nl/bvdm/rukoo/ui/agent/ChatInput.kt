// Ported in part from Beautiful UI (beautifului.dev), MIT License, Copyright (c) 2026 Shane Levine, through
// Rukoo's desktop src/renderer/agent/bui.js (chatComposer) and agent.css.
package nl.bvdm.rukoo.ui.agent

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Text
import androidx.compose.material3.minimumInteractiveComponentSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.isShiftPressed
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.OffsetMapping
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.input.TransformedText
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import nl.bvdm.rukoo.R
import nl.bvdm.rukoo.agents.model.AgentDescriptor
import nl.bvdm.rukoo.agents.model.AgentIds
import nl.bvdm.rukoo.agents.model.AgentState
import nl.bvdm.rukoo.agents.model.MessageRef
import nl.bvdm.rukoo.agents.model.ModelOptions
import nl.bvdm.rukoo.agents.model.OwnSkill
import nl.bvdm.rukoo.agents.model.OwnSkills
import nl.bvdm.rukoo.core.Change
import nl.bvdm.rukoo.ui.components.AddChip
import nl.bvdm.rukoo.ui.components.DotTone
import nl.bvdm.rukoo.ui.components.EntityChip
import nl.bvdm.rukoo.ui.components.Hairline
import nl.bvdm.rukoo.ui.components.RkBottomSheet
import nl.bvdm.rukoo.ui.components.RkDropdownMenu
import nl.bvdm.rukoo.ui.components.RkIcon
import nl.bvdm.rukoo.ui.components.RkMenuItem
import nl.bvdm.rukoo.ui.components.SheetDivider
import nl.bvdm.rukoo.ui.components.SheetHeading
import nl.bvdm.rukoo.ui.components.SheetRow
import nl.bvdm.rukoo.ui.components.SourceBadge
import nl.bvdm.rukoo.ui.components.Spinner
import nl.bvdm.rukoo.ui.components.StatusDot
import nl.bvdm.rukoo.ui.components.popIn
import nl.bvdm.rukoo.ui.components.pressScale
import nl.bvdm.rukoo.ui.components.rkClickable
import nl.bvdm.rukoo.ui.icons.EffortLevels
import nl.bvdm.rukoo.ui.icons.Gauge
import nl.bvdm.rukoo.ui.icons.PanelIcons
import nl.bvdm.rukoo.ui.theme.Rk
import nl.bvdm.rukoo.ui.theme.RukooWeights
import nl.bvdm.rukoo.ui.theme.lineHeight
import nl.bvdm.rukoo.ui.theme.medium
import nl.bvdm.rukoo.ui.theme.panel
import nl.bvdm.rukoo.ui.theme.rkShadow
import nl.bvdm.rukoo.ui.theme.rkSurface
import nl.bvdm.rukoo.ui.theme.tabular

/** The email chip of the input: the chat's own email, the open one (removable before the chat starts), or the add chip. */
@Immutable
sealed interface ContextChip {
    data class Email(val ref: MessageRef, val removable: Boolean) : ContextChip

    /** The user left the open email out; this puts it back. */
    data object Add : ContextChip
}

/** A newer email in the thread the user continued the chat from, while it is open; [pending]: the agent doesn't have it yet. */
@Immutable
data class NewerChip(val ref: MessageRef, val pending: Boolean)

/** Everything the input shows, built by the pane. */
@Immutable
data class InputModel(
    val agentName: String,
    val agentId: String,
    val agents: List<AgentDescriptor>,
    /** Pairing id to computer name, for "Claude Code · on desktop-zolder". */
    val computers: Map<String, String>,
    val context: ContextChip?,
    val newer: NewerChip?,
    val running: Boolean,
    /** Why the agent can't take a message, or null. */
    val blockedNote: Txt?,
    val models: ModelOptions?,
    val modelsLoading: Boolean,
    val model: String?,
    val effort: String?,
    val ownSkills: OwnSkills?,
    val ownSkillsLoading: Boolean,
)

/** What the input asks of the pane. */
class InputActions(
    val onSetUp: () -> Unit,
    val onModelsOpened: () -> Unit,
    val onOwnSkillsOpened: () -> Unit,
    val onFocus: (Boolean) -> Unit,
)

/** The agent menu's dot: ready green, offline or refused red, anything else grey (bui.js DOT_TONES). */
internal fun menuTone(state: AgentState): DotTone = when (state) {
    AgentState.READY -> DotTone.READY
    AgentState.OFFLINE, AgentState.UNAUTHORIZED -> DotTone.OFFLINE
    else -> DotTone.MUTED
}

internal fun AgentDescriptor.effectiveState(): AgentState = if (!enabled) AgentState.DISABLED else status.state

/** The skills the input styles as chips while typing: the agent's own, in the skill color on its tint. */
private class SkillStyling(private val skills: List<OwnSkill>, private val style: SpanStyle) : VisualTransformation {
    override fun filter(text: AnnotatedString): TransformedText {
        val ranges = ChatInputLogic.skillRanges(text.text, skills)
        if (ranges.isEmpty()) return TransformedText(text, OffsetMapping.Identity)
        val styled = buildAnnotatedString {
            append(text)
            ranges.forEach { addStyle(style, it.first, it.last + 1) }
        }
        return TransformedText(styled, OffsetMapping.Identity)
    }

    override fun equals(other: Any?) = other is SkillStyling && other.skills == skills && other.style == style

    override fun hashCode() = skills.hashCode() * 31 + style.hashCode()
}

/**
 * The chat input (bui.js `chatComposer`): the email chip, a growing text field, `/` commands and `$` skills in a
 * menu above it, and a bottom row with the agent, model and effort pickers and Send (Stop while a turn runs).
 * Enter on a hardware keyboard sends; Shift+Enter starts a new line.
 */
@Composable
fun ChatInput(controller: ChatController, model: InputModel, actions: InputActions, placeholder: String, modifier: Modifier = Modifier) {
    val c = Rk.colors
    val value = controller.input.value
    var focused by remember { mutableStateOf(false) }
    var dismissed by remember { mutableStateOf(false) }
    var lastText by remember { mutableStateOf(value.text) }
    if (value.text != lastText) {
        lastText = value.text
        dismissed = false
    }
    val blocked = model.blockedNote != null
    val token = if (blocked || dismissed || !value.selection.collapsed) null else ChatInputLogic.token(value.text, value.selection.start)
    val skills = model.ownSkills?.skills.orEmpty()

    LaunchedEffect(token?.sigil) { if (token?.sigil == '$') actions.onOwnSkillsOpened() }
    if (token != null) BackHandler { dismissed = true }

    fun replaceToken(with: String) {
        val t = token ?: return
        val text = value.text.substring(0, t.start) + with + value.text.substring(t.end)
        controller.input.value = TextFieldValue(text, TextRange(t.start + with.length))
    }

    Column(modifier.fillMaxWidth().padding(start = 10.dp, end = 10.dp, bottom = 10.dp)) {
        if (token != null) {
            CommandMenu(token, controller, model, skills, onPickCommand = { cmd ->
                if (controller.runCommand(cmd)) replaceToken("")
            }, onPickSkill = { skill ->
                val after = value.text.substring(token.end)
                replaceToken("$" + skill.name + if (after.startsWith(" ")) "" else " ")
            })
            Spacer(Modifier.size(6.dp))
        }
        val shape = RoundedCornerShape(14.dp)
        Column(
            Modifier
                .fillMaxWidth()
                .rkShadow(Rk.elevation.card, shape)
                .background(if (blocked) c.inset else c.surface, shape)
                .border(1.dp, if (focused) c.lineStrong else c.line, shape)
                .padding(6.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            ContextChips(controller, model)
            if (blocked) {
                BlockedNote(model, actions.onSetUp)
            } else {
                val skillStyle = SpanStyle(color = lerp(c.ink, c.skill, 0.22f), background = c.skill.copy(alpha = 0.11f), fontWeight = RukooWeights.Medium)
                val transformation = remember(skills, skillStyle) { SkillStyling(skills, skillStyle) }
                BasicTextField(
                    value = value,
                    onValueChange = { controller.input.value = it },
                    textStyle = Rk.type.panelBody.lineHeight(1.38f).copy(color = c.ink),
                    cursorBrush = SolidColor(c.ink),
                    visualTransformation = transformation,
                    keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
                    modifier = Modifier
                        .fillMaxWidth()
                        .heightIn(min = 28.dp, max = 120.dp)
                        .padding(horizontal = 4.dp, vertical = 5.dp)
                        .onFocusChanged {
                            focused = it.isFocused
                            actions.onFocus(it.isFocused)
                        }
                        .onPreviewKeyEvent { e ->
                            if (e.type != KeyEventType.KeyDown || (e.key != Key.Enter && e.key != Key.NumPadEnter) || e.isShiftPressed) return@onPreviewKeyEvent false
                            controller.submit()
                            true
                        }
                        .semantics { contentDescription = placeholder },
                    decorationBox = { inner ->
                        Box {
                            if (value.text.isEmpty()) {
                                Text(placeholder, style = Rk.type.panelBody, color = c.ink3, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            }
                            inner()
                        }
                    },
                )
            }
            BottomRow(controller, model, actions, blocked, value.text.isNotBlank())
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ContextChips(controller: ChatController, model: InputModel) {
    val context = model.context ?: return
    val noSubject = stringResource(R.string.agentui_no_subject)
    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        when (context) {
            is ContextChip.Add -> AddChip(stringResource(R.string.agentui_panel_add_context), controller::attach)
            is ContextChip.Email -> {
                val from = ChatFormat.person(context.ref.from)
                EntityChip(
                    context.ref.subject.ifBlank { noSubject },
                    sub = from.takeIf { it.isNotEmpty() },
                    monogram = from.ifEmpty { "?" },
                    monogramHueKey = context.ref.from?.address?.takeIf { it.isNotBlank() } ?: from,
                    onRemove = if (context.removable) controller::detach else null,
                    removeLabel = stringResource(R.string.agentui_panel_remove_context),
                )
            }
        }
        val newer = model.newer
        if (newer != null) {
            val note = stringResource(if (newer.pending) R.string.agentui_panel_newer_pending else R.string.agentui_panel_newer_sent, model.agentName)
            EntityChip(
                newer.ref.subject.ifBlank { noSubject },
                Modifier.semantics { contentDescription = note },
                sub = stringResource(R.string.agentui_panel_newer_message),
                monogram = null,
                leading = { SourceBadge("", email = true, emailIcon = PanelIcons.Mail, size = 18.dp) },
            )
        }
    }
}

/** Why the input is off, with the way to fix it: "Clark isn't set up yet. Set up Clark". */
@Composable
private fun BlockedNote(model: InputModel, onSetUp: () -> Unit) {
    val c = Rk.colors
    @OptIn(ExperimentalLayoutApi::class)
    FlowRow(
        Modifier.fillMaxWidth().padding(horizontal = 4.dp, vertical = 5.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        itemVerticalAlignment = Alignment.CenterVertically,
    ) {
        Text(model.blockedNote?.text().orEmpty(), style = Rk.type.text12_5.panel, color = c.ink3)
        Text(
            stringResource(R.string.agentui_panel_set_up, model.agentName),
            style = Rk.type.text12_5.medium.panel,
            color = c.link,
            modifier = Modifier.rkClickable(RoundedCornerShape(4.dp), onClick = onSetUp).padding(horizontal = 2.dp),
        )
    }
}

/**
 * The bottom row: agent, model and effort pickers, then Send. In a panel narrower than 330dp the chevrons and the
 * effort name go (agent.css); the row itself is about 30dp narrower than the panel.
 */
@Composable
private fun BottomRow(controller: ChatController, model: InputModel, actions: InputActions, blocked: Boolean, hasText: Boolean) {
    BoxWithConstraints(Modifier.fillMaxWidth()) {
        val narrow = maxWidth < 300.dp
        val agentMax = maxWidth * 0.7f
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Row(Modifier.weight(1f), horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
                AgentPicker(controller, model, Modifier.widthIn(max = agentMax), narrow)
                if (!blocked) {
                    ModelPicker(controller, model, actions, Modifier.weight(1f, fill = false), narrow)
                    EffortPicker(controller, model, narrow)
                }
            }
            SendButton(controller, model.running, enabled = !blocked && hasText)
        }
    }
}

/** A quiet 28dp picker button: content in `ink2` (agent) or `ink3` (model, effort), with a chevron. */
@Composable
private fun PickerButton(
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    strong: Boolean = false,
    chevron: Boolean = true,
    content: @Composable RowScope.() -> Unit,
) {
    val c = Rk.colors
    val shape = Rk.shapes.control
    Row(
        modifier
            .heightIn(min = 32.dp)
            .rkClickable(shape, onClick = onClick)
            .clearAndSetSemantics { contentDescription = label }
            .padding(horizontal = 6.dp),
        horizontalArrangement = Arrangement.spacedBy(5.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        androidx.compose.runtime.CompositionLocalProvider(androidx.compose.material3.LocalContentColor provides if (strong) c.ink2 else c.ink3) {
            content()
            if (chevron) RkIcon(PanelIcons.named("chevron", 2.4f), null, size = 11.dp)
        }
    }
}

@Composable
private fun AgentPicker(controller: ChatController, model: InputModel, modifier: Modifier, narrow: Boolean) {
    val c = Rk.colors
    var open by remember { mutableStateOf(false) }
    val current = model.agents.firstOrNull { it.id == model.agentId }
    Box(modifier) {
        PickerButton(stringResource(R.string.agentui_panel_pick_agent) + ": " + model.agentName, { open = true }, strong = true, chevron = !narrow) {
            StatusDot(menuTone(current?.effectiveState() ?: AgentState.UNKNOWN))
            Text(model.agentName, style = Rk.type.text12.medium.panel, color = c.ink2, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
        }
        RkDropdownMenu(open, { open = false }) {
            model.agents.forEach { agent ->
                RkMenuItem(
                    agent.name,
                    onClick = {
                        open = false
                        controller.pickAgent(agent.id)
                    },
                    leading = { StatusDot(menuTone(agent.effectiveState())) },
                    tag = agentTag(agent, model.computers),
                    checked = agent.id == model.agentId,
                )
            }
        }
    }
}

/**
 * The product when it isn't the agent's name already ("Hermes Agent" for Clark), and for Claude Code and Codex the
 * computer they run on ("on desktop-zolder"). Null when there is nothing to add.
 */
@Composable
internal fun agentTag(agent: AgentDescriptor, computers: Map<String, String>): String? {
    val product = AgentText.product(agent.kind).takeIf { !it.equals(agent.name, ignoreCase = true) }
    val pairing = AgentIds.parseComputer(agent.id)?.first
    val where = pairing?.let { id -> computers[id]?.let { stringResource(R.string.agentui_panel_on_computer, it) } ?: agent.subtitle.takeIf { it.isNotBlank() } }
    return listOfNotNull(product, where).joinToString(" · ").ifEmpty { null }
}

@Composable
private fun ModelPicker(controller: ChatController, model: InputModel, actions: InputActions, modifier: Modifier, narrow: Boolean) {
    val c = Rk.colors
    var open by remember { mutableStateOf(false) }
    val list = model.models
    val shown = ModelMenus.shownModel(list, model.model)
    val text = shown?.let { ModelMenus.modelName(list, it) } ?: stringResource(R.string.agentui_model_default_button)
    PickerButton(stringResource(R.string.agentui_model_button, text), {
        open = true
        actions.onModelsOpened()
    }, modifier, chevron = !narrow) {
        Text(text, style = Rk.type.text12.medium.panel, color = c.ink3, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
    }
    if (open) {
        RkBottomSheet(onDismissRequest = { open = false }, title = stringResource(R.string.agentui_model_title)) {
            val sheet = this
            val fallback = list?.defaultModel?.takeIf { it.isNotBlank() } ?: list?.models?.firstOrNull { it.isDefault }?.id
            SheetRow(
                stringResource(R.string.agentui_model_default),
                onClick = {
                    sheet.dismiss()
                    controller.pickChoice(Change(null), null)
                },
                tag = fallback?.let { ModelMenus.modelName(list, it) },
                checked = model.model == null,
            )
            val rows = list?.models.orEmpty().toMutableList()
            // The chat's model stays in the menu when the list no longer has it (or couldn't load).
            if (model.model != null && rows.none { it.id == model.model }) {
                rows += nl.bvdm.rukoo.agents.model.ModelOption(model.model, ModelMenus.modelName(list, model.model))
            }
            val routes = stringResource(R.string.agentui_model_routes)
            var group: String? = null
            Column(Modifier.heightIn(max = 520.dp).verticalScroll(rememberScrollState())) {
                rows.forEach { m ->
                    val name = if (m.route) routes else m.group.orEmpty()
                    if (name != group) {
                        if (name.isNotEmpty()) SheetHeading(name) else SheetDivider()
                        group = name
                    }
                    SheetRow(
                        m.label,
                        onClick = {
                            sheet.dismiss()
                            controller.pickChoice(Change(m.id), null)
                        },
                        tag = m.tag,
                        checked = m.id == model.model,
                    )
                }
                when {
                    list == null && model.modelsLoading -> SheetRow(stringResource(R.string.agentui_model_loading), onClick = {}, enabled = false)
                    list?.error != null -> {
                        SheetDivider()
                        SheetRow(stringResource(R.string.agentui_model_failed), onClick = {}, enabled = false)
                    }
                }
            }
        }
    }
}

@Composable
private fun EffortPicker(controller: ChatController, model: InputModel, narrow: Boolean) {
    val c = Rk.colors
    val list = model.models
    val levels = ModelMenus.effortsOf(list, model.model).toMutableList()
    if (model.effort != null && model.effort !in levels) levels += model.effort
    // The effort button goes away for a model without effort levels.
    if (model.effort == null && levels.isEmpty()) return
    var open by remember { mutableStateOf(false) }
    val name = model.effort?.let { AgentText.effort(it).text() }
    val label = stringResource(R.string.agentui_effort_button, name ?: stringResource(R.string.agentui_effort_default))
    Box {
        PickerButton(label, { open = true }, chevron = !narrow) {
            Gauge(EffortLevels.levelOf(model.effort), color = c.ink3)
            if (name != null && !narrow) Text(name, style = Rk.type.text12.medium.panel, color = c.ink3, maxLines = 1)
        }
        RkDropdownMenu(open, { open = false }) {
            MenuHeading(stringResource(R.string.agentui_effort_title))
            val own = ModelMenus.defaultEffort(list, model.model)
            RkMenuItem(
                stringResource(R.string.agentui_effort_default),
                onClick = {
                    open = false
                    controller.pickChoice(null, Change(null))
                },
                tag = own?.let { AgentText.effort(it).text() },
                checked = model.effort == null,
            )
            if (levels.isNotEmpty()) Hairline(Modifier.padding(vertical = 4.dp), color = c.line)
            levels.forEach { e ->
                RkMenuItem(
                    AgentText.effort(e).text(),
                    onClick = {
                        open = false
                        controller.pickChoice(null, Change(e))
                    },
                    leading = { Gauge(EffortLevels.levelOf(e), size = 16.dp, color = c.ink2) },
                    checked = e == model.effort,
                )
            }
        }
    }
}

@Composable
private fun MenuHeading(text: String) {
    Text(
        text,
        style = Rk.type.text12.medium.panel,
        color = Rk.colors.ink3,
        maxLines = 1,
        modifier = Modifier.padding(start = 12.dp, end = 12.dp, top = 6.dp, bottom = 4.dp),
    )
}

/** Send: a 32dp square, `ink` filled when there is something to send; Stop while a turn runs, always on. */
@Composable
private fun SendButton(controller: ChatController, running: Boolean, enabled: Boolean) {
    val c = Rk.colors
    val shape = Rk.shapes.control
    val on = running || enabled
    val source = remember { MutableInteractionSource() }
    val label = stringResource(if (running) R.string.agentui_panel_stop else R.string.agentui_panel_send)
    Box(Modifier.minimumInteractiveComponentSize(), contentAlignment = Alignment.Center) {
        Box(
            Modifier
                .pressScale(source, 0.94f)
                .size(32.dp)
                .background(if (on) c.ink else c.lineStrong, shape)
                .rkClickable(shape, enabled = on, interactionSource = source) { if (running) controller.stop() else controller.submit() }
                .semantics { contentDescription = label },
            contentAlignment = Alignment.Center,
        ) {
            RkIcon(
                if (running) PanelIcons.Stop else PanelIcons.named("send", 2.4f),
                null,
                size = 16.dp,
                tint = if (on) c.surface else c.ink2,
            )
        }
    }
}

/**
 * The menu above the input: `/` lists the quick actions and Rukoo's skills, `$` the agent's own skills with a
 * heading. Picking a command runs it; picking a skill puts it in the text as a chip.
 */
@Composable
private fun CommandMenu(
    token: InputToken,
    controller: ChatController,
    model: InputModel,
    skills: List<OwnSkill>,
    onPickCommand: (SlashCommand) -> Unit,
    onPickSkill: (OwnSkill) -> Unit,
) {
    val c = Rk.colors
    val shape = Rk.shapes.card
    val own = token.sigil == '$'
    Column(
        Modifier
            .popIn()
            .fillMaxWidth()
            .heightIn(max = 300.dp)
            .rkSurface(Rk.elevation.raised, shape, c.surface)
            .padding(4.dp),
    ) {
        if (own) {
            Text(
                stringResource(R.string.agentui_panel_skills_of, model.agentName),
                style = Rk.type.text11_5.medium.panel,
                color = c.ink3,
                modifier = Modifier.padding(start = 8.dp, end = 8.dp, top = 4.dp, bottom = 4.dp),
            )
            val matches = ChatInputLogic.skillMatches(skills, token.query)
            val error = model.ownSkills?.error
            when {
                matches.isNotEmpty() -> LazyColumn {
                    itemsIndexed(matches, key = { _, k -> k.name }) { _, skill ->
                        CommandRow("$" + skill.name, skill.description, skill.scope, PanelIcons.Skill) { onPickSkill(skill) }
                    }
                }
                model.ownSkillsLoading && skills.isEmpty() -> MenuEmpty(stringResource(R.string.agentui_panel_skills_loading), busy = true)
                error != null && skills.isEmpty() -> MenuEmpty(
                    if (AgentText.isErrorCode(error.code) && error.code != "unknown") AgentText.error(error.code, model.agentName).text()
                    else stringResource(R.string.agentui_panel_skills_failed, model.agentName),
                )
                skills.isEmpty() -> MenuEmpty(stringResource(R.string.agentui_panel_no_skills))
                else -> MenuEmpty(stringResource(R.string.agentui_panel_no_matches))
            }
        } else {
            val matches = ChatInputLogic.matching(controller.commands(), token.query)
            if (matches.isEmpty()) {
                MenuEmpty(stringResource(R.string.agentui_panel_no_matches))
            } else {
                LazyColumn {
                    itemsIndexed(matches, key = { _, cmd -> cmd.name }) { _, cmd ->
                        // Desktop shows the label and keeps the description in a hover title; touch has no hover,
                        // so the row shows the description (the label is on the chip already).
                        val description = cmd.action?.let { AgentText.actionDescription(it).text() } ?: cmd.description
                        CommandRow("/" + cmd.name, description, null, PanelIcons.named(cmd.icon)) { onPickCommand(cmd) }
                    }
                }
            }
        }
    }
}

@Composable
private fun CommandRow(name: String, description: String, tag: String?, icon: androidx.compose.ui.graphics.vector.ImageVector, onClick: () -> Unit) {
    val c = Rk.colors
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 44.dp)
            .rkClickable(Rk.shapes.chip, onClick = onClick)
            .padding(horizontal = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(22.dp), contentAlignment = Alignment.Center) { RkIcon(icon, null, size = 15.dp, tint = c.ink2) }
        Text(name, style = Rk.type.text12_5.medium.panel, color = c.ink, maxLines = 1)
        Text(description, style = Rk.type.text12.panel, color = c.ink3, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
        if (!tag.isNullOrBlank()) Text(tag, style = Rk.type.text11.panel.tabular, color = c.ink3, maxLines = 1)
    }
}

@Composable
private fun MenuEmpty(text: String, busy: Boolean = false) {
    Row(
        Modifier.fillMaxWidth().heightIn(min = 40.dp).padding(horizontal = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (busy) Spinner()
        Text(text, style = Rk.type.text12_5.panel, color = Rk.colors.ink3)
    }
}
