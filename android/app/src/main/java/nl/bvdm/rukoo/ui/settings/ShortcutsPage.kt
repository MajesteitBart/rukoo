package nl.bvdm.rukoo.ui.settings

import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.launch
import nl.bvdm.rukoo.R
import nl.bvdm.rukoo.agents.QuickActions
import nl.bvdm.rukoo.agents.model.QuickAction
import nl.bvdm.rukoo.ui.agent.AgentText
import nl.bvdm.rukoo.ui.agent.text
import nl.bvdm.rukoo.ui.components.LocalRkToast
import nl.bvdm.rukoo.ui.components.RkButton
import nl.bvdm.rukoo.ui.components.RkButtonKind
import nl.bvdm.rukoo.ui.components.RkIcon
import nl.bvdm.rukoo.ui.components.RkIconButton
import nl.bvdm.rukoo.ui.components.RkIconButtonSize
import nl.bvdm.rukoo.ui.components.RkSwitch
import nl.bvdm.rukoo.ui.components.RkTextField
import nl.bvdm.rukoo.ui.components.SettingsCard
import nl.bvdm.rukoo.ui.components.SettingsRow
import nl.bvdm.rukoo.ui.components.rkClickable
import nl.bvdm.rukoo.ui.icons.PanelIcons
import nl.bvdm.rukoo.ui.icons.RukooIcons
import nl.bvdm.rukoo.ui.root.AppViewModel
import nl.bvdm.rukoo.ui.theme.Rk
import nl.bvdm.rukoo.ui.theme.medium

/**
 * Shortcuts (settings.js shortcutsHtml): the chat's quick actions in the user's order, each with Up, Down and
 * a switch for new chats, a row to add one, and restoring Rukoo's. A row opens [ShortcutPage].
 */
@Composable
fun ShortcutsPage(app: AppViewModel, nav: SettingsNav) {
    val s = app.services
    val stored by s.agentSettings.settings.collectAsStateWithLifecycle()
    val list = remember(stored.shortcuts) { QuickActions.list(stored.shortcuts) }
    val scope = rememberCoroutineScope()
    val toast = LocalRkToast.current
    var reset by remember { mutableStateOf(false) }
    val tooMany = stringResource(R.string.settings_shortcuts_too_many, QuickActions.MAX)
    val resetDone = stringResource(R.string.settings_shortcuts_reset_done)
    // Each change applies to the list as stored then, so two quick taps don't undo each other.
    fun save(change: (List<QuickAction>) -> List<QuickAction>) {
        scope.launch { if (!s.agentSettings.changeShortcuts(change)) toast.showToast(tooMany) }
    }

    SettingsPageBody {
        SettingsIntro(stringResource(R.string.settings_shortcuts_help))
        SettingsCard {
            list.forEachIndexed { i, a ->
                ShortcutRow(
                    a,
                    first = i == 0,
                    last = i == list.lastIndex,
                    onEdit = { nav.push(SettingsRoutes.SHORTCUT + a.key) },
                    onMove = { by -> save { QuickActions.move(it, a.key, by) } },
                    onShow = { on -> save { QuickActions.change(it, a.key) { x -> x.copy(hidden = !on) } } },
                )
            }
            SettingsRow(
                title = stringResource(R.string.settings_shortcuts_add),
                leading = { AddIcon() },
                onClick = { if (list.size >= QuickActions.MAX) toast.showToast(tooMany) else nav.push(SettingsRoutes.SHORTCUT) },
            )
        }
        Spacer(Modifier.height(16.dp))
        SettingsCard {
            SettingsRow(
                title = stringResource(R.string.settings_shortcuts_reset),
                description = stringResource(R.string.settings_shortcuts_reset_help),
                onClick = { reset = true },
            )
        }
    }

    if (reset) {
        RkDialog(
            title = stringResource(R.string.settings_shortcuts_reset_title),
            text = stringResource(R.string.settings_shortcuts_reset_confirm),
            confirmLabel = stringResource(R.string.settings_shortcuts_reset_ok),
            onDismiss = { reset = false },
            onConfirm = {
                reset = false
                scope.launch {
                    s.agentSettings.update { it.copy(shortcuts = null) }
                    toast.showToast(resetDone)
                }
            },
        )
    }
}

/** One shortcut: its icon, name and "/command · when · Edited", then Up, Down and Show in new chats. */
@Composable
private fun ShortcutRow(a: QuickAction, first: Boolean, last: Boolean, onEdit: () -> Unit, onMove: (Int) -> Unit, onShow: (Boolean) -> Unit) {
    val c = Rk.colors
    val name = AgentText.actionLabel(a).text()
    val desc = listOfNotNull(
        a.slash,
        shortcutWhen(a),
        if (QuickActions.edited(a)) stringResource(R.string.settings_shortcuts_edited) else null,
    ).joinToString(" · ")
    val show = stringResource(R.string.settings_shortcuts_show, name)
    SettingsRow(
        title = name,
        description = desc,
        titleColor = if (a.hidden) c.text3 else c.text,
        leading = { RowIcon(PanelIcons.named(a.icon), tint = if (a.hidden) c.text3 else c.text2) },
        trailing = {
            Row(verticalAlignment = Alignment.CenterVertically) {
                RkIconButton(RukooIcons.Up, stringResource(R.string.settings_shortcuts_move_up, name), onClick = { onMove(-1) }, size = RkIconButtonSize.SMALL, enabled = !first)
                RkIconButton(RukooIcons.Down, stringResource(R.string.settings_shortcuts_move_down, name), onClick = { onMove(1) }, size = RkIconButtonSize.SMALL, enabled = !last)
                Spacer(Modifier.size(8.dp))
                RkSwitch(!a.hidden, onShow, Modifier.semantics { contentDescription = show })
            }
        },
        onClick = onEdit,
    )
}

/** When a shortcut shows in a new chat (settings.js shortcutWhen). */
@Composable
private fun shortcutWhen(a: QuickAction): String = stringResource(
    when {
        a.custom -> if (a.always) R.string.settings_shortcuts_when_always else R.string.settings_shortcuts_when_email
        a.needsUnsubscribe -> R.string.settings_shortcuts_when_newsletter
        a.needsEmail -> R.string.settings_shortcuts_when_email
        else -> R.string.settings_shortcuts_when_no_email
    },
)

private enum class Field { LABEL, KEY, PROMPT }

/**
 * Edits one shortcut, or makes a new one of the user's when [key] is empty (settings.js shortcutDialog, as a
 * page: the instructions want the room). Rukoo's keep their command, icon and when; the user's choose them.
 * The fields are drafts in [model], so folding keeps them; a saved change starts them again.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun ShortcutPage(app: AppViewModel, model: SetupModel, nav: SettingsNav, key: String) {
    val s = app.services
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val toast = LocalRkToast.current
    val stored by s.agentSettings.settings.collectAsStateWithLifecycle()
    val list = remember(stored.shortcuts) { QuickActions.list(stored.shortcuts) }
    val editing = list.firstOrNull { it.key == key }
    val fresh = key.isEmpty()
    // Set while a save leaves the page, which itself renames or deletes the shortcut.
    var leaving by remember { mutableStateOf(false) }
    if (!fresh && editing == null) {
        // Gone while open (Restore Rukoo's shortcuts, an import): back to the list.
        if (!leaving) LaunchedEffect(Unit) { nav.pop() }
        return
    }
    val custom = fresh || editing!!.custom
    val defaultLabel = editing?.takeIf { !it.custom }?.let { QuickActions.labelRes(it.key) }?.let(context::getString)

    val k = DRAFT_SHORTCUT + key + ":"
    // A new shortcut starts again once the list changed (it was added); an edit once its shortcut changed.
    val base = listOf(editing, if (fresh) stored.shortcuts else null)
    remember(base) { model.rebaseDrafts(k, base) }
    var label by rememberDraft(model, k + "label", base) { editing?.let { QuickActions.label(context, it) }.orEmpty() }
    var command by rememberDraft(model, k + "key", base) { editing?.key.orEmpty() }
    var prompt by rememberDraft(model, k + "prompt", base) { editing?.prompt.orEmpty() }
    var icon by rememberDraft(model, k + "icon", base) { editing?.icon ?: "sparkle" }
    var always by rememberDraft(model, k + "always", base) { editing?.always ?: false }
    var error by remember { mutableStateOf<Pair<Field, String>?>(null) }
    var whenSheet by remember { mutableStateOf(false) }

    val needLabel = stringResource(R.string.settings_shortcuts_need_label)
    val needPrompt = stringResource(R.string.settings_shortcuts_need_prompt)
    val badCommand = stringResource(R.string.settings_shortcuts_bad_command)
    val saved = stringResource(R.string.settings_agents_saved)
    val tooMany = stringResource(R.string.settings_shortcuts_too_many, QuickActions.MAX)
    val whenEmail = stringResource(R.string.settings_shortcuts_when_email_option)
    val whenAlways = stringResource(R.string.settings_shortcuts_when_always_option)

    // [change] applies to the list as stored when it is saved, which a quick tap elsewhere may have changed.
    // [taken] names a command that turned out to be in use by then: the page stays, with that error.
    fun finish(change: (List<QuickAction>) -> List<QuickAction>, message: String, taken: () -> String? = { null }) {
        if (leaving) return
        leaving = true
        scope.launch {
            val fits = s.agentSettings.changeShortcuts(change)
            val conflict = taken()
            if (!fits || conflict != null) {
                leaving = false
                if (conflict != null) error = Field.KEY to context.getString(R.string.settings_shortcuts_taken_command, conflict) else toast.showToast(tooMany)
                return@launch
            }
            model.clearDrafts(k)
            toast.showToast(message)
            nav.pop()
        }
    }

    fun submit() {
        val l = label.trim()
        val p = prompt.trim()
        if (l.isEmpty()) return run { error = Field.LABEL to needLabel }
        if (p.isEmpty()) return run { error = Field.PROMPT to needPrompt }
        if (!custom) return finish({ QuickActions.change(it, key) { a -> QuickActions.rewrite(a, l, p, defaultLabel) } }, saved)
        val name = QuickActions.commandOf(command)
        when (QuickActions.commandProblem(name, list, editing?.key)) {
            QuickActions.CommandProblem.BAD -> return run { error = Field.KEY to badCommand }
            QuickActions.CommandProblem.TAKEN -> return run { error = Field.KEY to context.getString(R.string.settings_shortcuts_taken_command, name) }
            null -> Unit
        }
        // A command another shortcut took since the check (an import) leaves the list as it is, and says so.
        var taken = false
        val takenNow = { now: List<QuickAction> -> now.any { it.key == name && it.key != editing?.key }.also { taken = it } }
        if (editing == null) {
            if (list.size >= QuickActions.MAX) return toast.showToast(tooMany)
            finish(
                { now -> if (takenNow(now)) now else now + QuickActions.custom(name, l, p, icon, always) },
                context.getString(R.string.settings_shortcuts_added, l),
            ) { name.takeIf { taken } }
        } else {
            finish(
                { now -> if (takenNow(now)) now else QuickActions.change(now, key) { QuickActions.custom(name, l, p, icon, always, hidden = it.hidden) } },
                saved,
            ) { name.takeIf { taken } }
        }
    }

    fun errorFor(field: Field) = error?.takeIf { it.first == field }?.second

    SettingsPageBody {
        Spacer(Modifier.height(12.dp))
        SettingsCard {
            Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                RkTextField(
                    label,
                    {
                        label = it.take(QuickActions.LABEL_MAX)
                        error = null
                    },
                    label = stringResource(R.string.settings_shortcuts_label),
                    error = errorFor(Field.LABEL),
                    keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
                )
                RkTextField(
                    if (custom) command else "/$command",
                    {
                        command = it.take(QuickActions.KEY_MAX + 1)
                        error = null
                    },
                    label = stringResource(R.string.settings_shortcuts_command),
                    placeholder = stringResource(R.string.settings_shortcuts_command_placeholder),
                    help = stringResource(if (custom) R.string.settings_shortcuts_command_help else R.string.settings_shortcuts_command_fixed),
                    error = errorFor(Field.KEY),
                    mono = true,
                    enabled = custom,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, autoCorrectEnabled = false, capitalization = KeyboardCapitalization.None),
                )
            }
        }
        if (custom) {
            Spacer(Modifier.height(16.dp))
            SettingsCard {
                SettingsRow(
                    title = stringResource(R.string.settings_shortcuts_when),
                    value = if (always) whenAlways else whenEmail,
                    onClick = { whenSheet = true },
                )
                Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text(stringResource(R.string.settings_shortcuts_icon), style = Rk.type.text13_5.medium, color = Rk.colors.text)
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        for (name in QuickActions.ICONS) IconChoice(name, name == icon) { icon = name }
                    }
                }
            }
        }
        Spacer(Modifier.height(16.dp))
        SettingsCard {
            Column(Modifier.fillMaxWidth().padding(16.dp)) {
                RkTextField(
                    prompt,
                    {
                        prompt = it.take(QuickActions.PROMPT_MAX)
                        error = null
                    },
                    label = stringResource(R.string.settings_shortcuts_prompt),
                    help = stringResource(if (custom) R.string.settings_shortcuts_prompt_help else R.string.settings_shortcuts_prompt_help_builtin),
                    error = errorFor(Field.PROMPT),
                    singleLine = false,
                    minLines = 6,
                    keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
                )
            }
        }
        Spacer(Modifier.height(16.dp))
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            when {
                editing != null && editing.custom -> RkButton(
                    stringResource(R.string.common_actions_delete),
                    onClick = { finish({ now -> now.filterNot { it.key == key } }, saved) },
                    kind = RkButtonKind.DANGER,
                )
                editing != null && QuickActions.edited(editing) -> RkButton(
                    stringResource(R.string.settings_shortcuts_restore),
                    onClick = { finish({ QuickActions.change(it, key, QuickActions::restore) }, saved) },
                    kind = RkButtonKind.SECONDARY,
                )
            }
            Spacer(Modifier.weight(1f))
            RkButton(stringResource(if (fresh) R.string.common_actions_add else R.string.common_actions_save), onClick = ::submit, kind = RkButtonKind.PRIMARY)
        }
    }

    if (whenSheet) {
        ChoiceSheet(
            title = stringResource(R.string.settings_shortcuts_when),
            choices = listOf(Choice(false, whenEmail), Choice(true, whenAlways)),
            selected = always,
            onSelect = { always = it },
            onDismiss = { whenSheet = false },
        )
    }
}

/** One icon to choose, a 40dp square with an accent edge on the chosen one (`.shortcut-icon`). */
@Composable
private fun IconChoice(name: String, chosen: Boolean, onClick: () -> Unit) {
    val c = Rk.colors
    val shape = Rk.shapes.control
    Box(
        Modifier
            .size(40.dp)
            .border(if (chosen) 2.dp else 1.dp, if (chosen) c.accent else c.border, shape)
            .rkClickable(shape, role = Role.RadioButton, onClick = onClick)
            .semantics {
                contentDescription = name
                selected = chosen
            },
        contentAlignment = Alignment.Center,
    ) {
        RkIcon(PanelIcons.named(name), null, size = 16.dp, tint = if (chosen) c.accent else c.text2)
    }
}

/** Draft key prefix of the shortcut form, by the shortcut's command (empty for a new one). */
private const val DRAFT_SHORTCUT = "shortcut:"
