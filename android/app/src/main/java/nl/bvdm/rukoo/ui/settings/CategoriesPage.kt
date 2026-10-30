package nl.bvdm.rukoo.ui.settings

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.launch
import nl.bvdm.rukoo.R
import nl.bvdm.rukoo.categories.Categories
import nl.bvdm.rukoo.categories.Category
import nl.bvdm.rukoo.categories.CategoryException
import nl.bvdm.rukoo.categories.TextEdit
import nl.bvdm.rukoo.ui.components.LocalRkToast
import nl.bvdm.rukoo.ui.components.RkButton
import nl.bvdm.rukoo.ui.components.RkButtonKind
import nl.bvdm.rukoo.ui.components.RkIcon
import nl.bvdm.rukoo.ui.components.RkIconButton
import nl.bvdm.rukoo.ui.components.RkLinkButton
import nl.bvdm.rukoo.ui.components.RkSwitch
import nl.bvdm.rukoo.ui.components.RkTextField
import nl.bvdm.rukoo.ui.components.SectionTitle
import nl.bvdm.rukoo.ui.components.SettingsCard
import nl.bvdm.rukoo.ui.components.SettingsRow
import nl.bvdm.rukoo.ui.components.SettingsSwitchRow
import nl.bvdm.rukoo.ui.components.popIn
import nl.bvdm.rukoo.ui.components.rkClickable
import nl.bvdm.rukoo.ui.icons.RukooIcons
import nl.bvdm.rukoo.ui.root.AppViewModel
import nl.bvdm.rukoo.ui.theme.Rk
import nl.bvdm.rukoo.ui.theme.medium
import nl.bvdm.rukoo.ui.theme.rkSurface

/** A category's color as Compose draws it; an unreadable one falls back to the first of the palette. */
fun categoryColor(hex: String): Color = runCatching { Color(android.graphics.Color.parseColor(hex)) }.getOrDefault(Color(0xFFFF5D73))

/** The words for a change the categories refused. */
@Composable
fun categoryErrorText(e: Throwable): String = when ((e as? CategoryException)?.code) {
    "too_many" -> stringResource(R.string.categories_errors_too_many, Categories.MAX_CATEGORIES)
    "need_name" -> stringResource(R.string.categories_errors_need_name)
    "last" -> stringResource(R.string.categories_errors_last)
    else -> stringResource(R.string.settings_error_generic)
}

private fun errorRes(e: Throwable): Int = when ((e as? CategoryException)?.code) {
    "too_many" -> R.string.categories_errors_too_many
    "need_name" -> R.string.categories_errors_need_name
    "last" -> R.string.categories_errors_last
    else -> R.string.settings_error_generic
}

/** A category's dot: its color, 10dp. */
@Composable
fun CategoryDot(color: String, modifier: Modifier = Modifier, size: androidx.compose.ui.unit.Dp = 10.dp) {
    Box(modifier.size(size).background(categoryColor(color), CircleShape))
}

/**
 * Settings > Inbox categories, a port of desktop's src/renderer/categories-settings.js: turning them on, the categories
 * themselves, what gets mail Rukoo isn't sure about, Jev, and the senders with a rule.
 */
@Composable
fun CategoriesPage(app: AppViewModel) {
    val cats = app.services.categories ?: return
    val state by cats.state.collectAsStateWithLifecycle()
    val activity by cats.activity.collectAsStateWithLifecycle()
    val toast = LocalRkToast.current
    val res = LocalContext.current.resources
    val scope = rememberCoroutineScope()
    var editing by remember { mutableStateOf<Category?>(null) }
    var adding by remember { mutableStateOf(false) }
    var unsureSheet by remember { mutableStateOf(false) }
    var keyDialog by remember { mutableStateOf(false) }
    var forget by remember { mutableStateOf<String?>(null) }
    fun attempt(block: () -> Unit) {
        try {
            block()
        } catch (e: Exception) {
            toast.showError(res.getString(errorRes(e), Categories.MAX_CATEGORIES))
        }
    }
    val nameOf = { id: String? -> state.categories.firstOrNull { it.id == id }?.name.orEmpty() }

    SettingsPageBody {
        Spacer(Modifier.height(12.dp))
        SettingsCard {
            SettingsSwitchRow(
                title = stringResource(R.string.settings_categories_on),
                description = stringResource(R.string.settings_categories_on_help),
                checked = state.enabled,
                onCheckedChange = { on -> attempt { cats.setEnabled(on) } },
            )
        }
        PageText(stringResource(if (state.signedIn) R.string.settings_categories_sync else R.string.settings_categories_sync_local))
        if (state.enabled) {
            SectionTitle(stringResource(R.string.settings_categories_list))
            SettingsCard {
                state.categories.forEachIndexed { i, c ->
                    CategoryRow(
                        c,
                        muted = c.id in state.muted,
                        canUp = i > 0,
                        canDown = i < state.categories.size - 1,
                        onEdit = { editing = c },
                        onMove = { by ->
                            val ids = state.categories.map { it.id }.toMutableList()
                            val j = i + by
                            if (j in ids.indices) {
                                ids[i] = ids[j].also { ids[j] = ids[i] }
                                attempt { cats.reorder(ids) }
                            }
                        },
                    )
                }
                if (state.categories.size < state.limit) {
                    SettingsRow(title = stringResource(R.string.settings_categories_add), leading = { AddIcon() }, onClick = { adding = true })
                }
            }
            PageText(stringResource(R.string.settings_categories_list_help))
            Spacer(Modifier.height(10.dp))
            SettingsCard {
                SettingsRow(title = stringResource(R.string.settings_categories_unsure), value = nameOf(state.unsure), onClick = { unsureSheet = true })
            }
            SectionTitle(stringResource(R.string.settings_categories_sorting))
            PageText(stringResource(R.string.settings_categories_rules), top = 0.dp)
            Spacer(Modifier.height(10.dp))
            SettingsCard {
                val error = state.jev.error?.let {
                    stringResource(
                        when (it) {
                            "key" -> R.string.settings_categories_jev_error_key
                            "busy" -> R.string.settings_categories_jev_error_busy
                            else -> R.string.settings_categories_jev_error_network
                        },
                    )
                }
                SettingsSwitchRow(
                    title = stringResource(R.string.settings_categories_jev),
                    description = stringResource(R.string.settings_categories_jev_help) + (error?.let { "\n$it" } ?: ""),
                    checked = state.jev.on,
                    onCheckedChange = { on ->
                        if (on && !state.jev.hasKey) {
                            toast.showToast(res.getString(R.string.settings_categories_need_key))
                            keyDialog = true
                        } else {
                            cats.setJev(on = on)
                        }
                    },
                )
                SettingsRow(
                    title = stringResource(R.string.settings_categories_key),
                    value = stringResource(if (state.jev.hasKey) R.string.settings_categories_key_set else R.string.settings_categories_key_missing),
                    onClick = { keyDialog = true },
                )
            }
            PageText(stringResource(R.string.settings_categories_jev_shares))
            Spacer(Modifier.height(10.dp))
            SettingsCard {
                SettingsRow(
                    title = stringResource(R.string.settings_categories_again),
                    description = if (activity.running) {
                        stringResource(R.string.categories_activity_progress, activity.done, activity.total)
                    } else {
                        stringResource(R.string.settings_categories_again_help)
                    },
                    onClick = {
                        scope.launch {
                            val count = runCatching { cats.sortAgain() }.getOrDefault(0)
                            toast.showToast(res.getQuantityString(R.plurals.settings_categories_again_done, count, count))
                        }
                    },
                )
            }
            if (state.senders.isNotEmpty()) {
                SectionTitle(stringResource(R.string.settings_categories_senders))
                SettingsCard {
                    for (s in state.senders) {
                        SettingsRow(
                            title = s.address,
                            description = stringResource(R.string.settings_categories_sender_help, nameOf(s.category)),
                            onClick = { forget = s.address },
                        )
                    }
                }
            }
        }
    }

    if (adding || editing != null) {
        val c = editing
        // With notifications off for all new mail, a category's switch would change nothing you can see.
        val settings by app.services.settingsSnapshot.collectAsStateWithLifecycle()
        CategoryDialog(
            category = c,
            canDelete = state.categories.size > 1,
            notify = c == null || c.id !in state.muted,
            notifyAllowed = settings.notifyMail,
            onDismiss = {
                adding = false
                editing = null
            },
            onSave = { name, description, color, inbox, notify ->
                // A preset keeps following the language until its text is changed.
                val nameEdit = if (c?.preset != null && name == c.name && !c.customName) TextEdit.Keep else if (name.isEmpty()) TextEdit.Reset else TextEdit.To(name)
                val descriptionEdit = if (c?.preset != null && description == c.description && !c.customDescription) TextEdit.Keep else if (description.isEmpty()) TextEdit.Reset else TextEdit.To(description)
                cats.saveCategory(c?.id, nameEdit, descriptionEdit, color, inbox = inbox, notify = notify)
            },
            // "Use Rukoo's text" keeps what the switches were set to.
            onRestore = { inbox, notify -> c?.let { attempt { cats.saveCategory(it.id, TextEdit.Reset, TextEdit.Reset, inbox = inbox, notify = notify) } } },
            onDelete = { c?.let { attempt { cats.removeCategory(it.id) } } },
        )
    }
    if (unsureSheet) {
        ChoiceSheet(
            title = stringResource(R.string.settings_categories_unsure),
            choices = state.categories.map { Choice(it.id, it.name) },
            selected = state.unsure,
            onSelect = { id -> attempt { cats.setUnsure(id) } },
            onDismiss = { unsureSheet = false },
        )
    }
    if (keyDialog) {
        KeyDialog(
            hasKey = state.jev.hasKey,
            onDismiss = { keyDialog = false },
            onRemove = {
                keyDialog = false
                cats.setJev(on = false, removeKey = true)
            },
            onSave = { key ->
                keyDialog = false
                cats.setJev(on = true, key = key)
            },
        )
    }
    forget?.let { address ->
        RkDialog(
            title = stringResource(R.string.settings_categories_sender_remove, address),
            text = stringResource(R.string.settings_categories_sender_remove_help),
            confirmLabel = stringResource(R.string.common_actions_delete),
            danger = true,
            onDismiss = { forget = null },
            onConfirm = {
                forget = null
                cats.forgetSender(address)
            },
        )
    }
}

/** A paragraph between cards (desktop's `.settings-text`). */
@Composable
private fun PageText(text: String, top: androidx.compose.ui.unit.Dp = 12.dp) {
    Text(text, Modifier.padding(start = 4.dp, end = 4.dp, top = top, bottom = 2.dp), style = Rk.type.text13.copy(lineHeight = Rk.type.text13.fontSize * 1.5f), color = Rk.colors.text2)
}

/** A category: a button to edit it, and buttons to move it up and down. [muted]: its notifications are off here. */
@Composable
private fun CategoryRow(c: Category, muted: Boolean, canUp: Boolean, canDown: Boolean, onEdit: () -> Unit, onMove: (Int) -> Unit) {
    Row(Modifier.fillMaxWidth().heightIn(min = 56.dp).padding(end = 6.dp), verticalAlignment = Alignment.CenterVertically) {
        Row(
            Modifier.weight(1f).heightIn(min = 56.dp).rkClickable(Rk.shapes.control, onClick = onEdit).padding(start = 16.dp, end = 8.dp, top = 10.dp, bottom = 10.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            CategoryDot(c.color)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(c.name, style = Rk.type.text13_5.medium, color = Rk.colors.text, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                    // A category Inbox doesn't show: a crossed-out eye after its name, as in the folder drawer.
                    if (!c.inbox) {
                        Spacer(Modifier.size(6.dp))
                        RkIcon(RukooIcons.EyeOff, stringResource(R.string.mailbox_categories_hidden), size = 14.dp, tint = Rk.colors.text3)
                    }
                }
                if (c.description.isNotEmpty()) Text(c.description, style = Rk.type.text12_5, color = Rk.colors.text2, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
            // Notifications off on this phone: a crossed-out bell at the end of the row (desktop's .cat-muted).
            if (muted) RkIcon(RukooIcons.BellOff, stringResource(R.string.settings_categories_notify_off), size = 16.dp, tint = Rk.colors.text3)
        }
        RkIconButton(RukooIcons.Up, stringResource(R.string.settings_categories_up), onClick = { onMove(-1) }, enabled = canUp)
        RkIconButton(RukooIcons.Down, stringResource(R.string.settings_categories_down), onClick = { onMove(1) }, enabled = canDown)
    }
}

/**
 * Edits a category, or makes a new one ([category] null): name, what belongs there, its color, whether Inbox shows its
 * mail, and whether its new mail notifies on this phone ([notify]). With notifications off for all new mail
 * ([notifyAllowed] false) that switch keeps its state, dimmed, and says why. Delete and "Use Rukoo's text" sit on the
 * left, as on desktop.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun CategoryDialog(
    category: Category?,
    canDelete: Boolean,
    notify: Boolean,
    notifyAllowed: Boolean,
    onDismiss: () -> Unit,
    onSave: (name: String, description: String, color: String, inbox: Boolean, notify: Boolean) -> Unit,
    onRestore: (inbox: Boolean, notify: Boolean) -> Unit,
    onDelete: () -> Unit,
) {
    val c = Rk.colors
    var name by remember { mutableStateOf(category?.name.orEmpty()) }
    var description by remember { mutableStateOf(category?.description.orEmpty()) }
    var color by remember { mutableStateOf(category?.color ?: Categories.COLORS[0]) }
    var inbox by remember { mutableStateOf(category?.inbox != false) }
    var notifies by remember { mutableStateOf(notify) }
    var error by remember { mutableStateOf<Throwable?>(null) }
    var confirmDelete by remember { mutableStateOf(false) }
    val needName = remember { CategoryException("need_name") }
    Dialog(onDismissRequest = onDismiss) {
        val shape = Rk.shapes.window
        Column(
            Modifier
                .popIn(140)
                .widthIn(max = 480.dp)
                .fillMaxWidth()
                .rkSurface(Rk.elevation.overlay, shape, c.raised)
                .border(1.dp, c.border, shape)
                .verticalScroll(rememberScrollState())
                .padding(start = 20.dp, end = 20.dp, top = 20.dp, bottom = 16.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Text(stringResource(if (category != null) R.string.settings_categories_edit_title else R.string.settings_categories_new_title), style = Rk.type.dialogTitle, color = c.text)
            RkTextField(
                value = name,
                onValueChange = { name = it.take(40) },
                label = stringResource(R.string.settings_categories_name),
                keyboardOptions = KeyboardOptions(capitalization = androidx.compose.ui.text.input.KeyboardCapitalization.Sentences),
            )
            RkTextField(
                value = description,
                onValueChange = { description = it.take(400) },
                label = stringResource(R.string.settings_categories_description),
                help = stringResource(R.string.settings_categories_description_help),
                singleLine = false,
                minLines = 3,
                maxLines = 6,
                keyboardOptions = KeyboardOptions(capitalization = androidx.compose.ui.text.input.KeyboardCapitalization.Sentences),
            )
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(stringResource(R.string.settings_categories_color), style = Rk.type.text13, color = c.text2)
                FlowRow(Modifier.selectableGroup(), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    for (value in Categories.COLORS) {
                        val on = value.equals(color, ignoreCase = true)
                        Box(
                            Modifier
                                .size(36.dp)
                                .selectable(on, role = Role.RadioButton, interactionSource = null, indication = null) { color = value }
                                .semantics { contentDescription = value },
                            contentAlignment = Alignment.Center,
                        ) {
                            Box(
                                Modifier
                                    .size(24.dp)
                                    .then(if (on) Modifier.border(2.dp, categoryColor(value), CircleShape) else Modifier.border(1.dp, c.border, CircleShape))
                                    .padding(if (on) 4.dp else 1.dp)
                                    .background(categoryColor(value), CircleShape),
                            )
                        }
                    }
                }
            }
            DialogSwitch(
                title = stringResource(R.string.settings_categories_inbox),
                help = stringResource(R.string.settings_categories_inbox_help),
                checked = inbox,
                onCheckedChange = { inbox = it },
            )
            DialogSwitch(
                title = stringResource(R.string.settings_categories_notify),
                help = stringResource(if (notifyAllowed) R.string.settings_categories_notify_help else R.string.settings_categories_notify_blocked),
                checked = notifies,
                onCheckedChange = { notifies = it },
                enabled = notifyAllowed,
            )
            error?.let { ErrorLine(categoryErrorText(it)) }
            FlowRow(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                // Delete and Use Rukoo's text on the left, as desktop's dialog has them; Delete in red.
                if (category != null && canDelete) RkLinkButton(stringResource(R.string.common_actions_delete), { confirmDelete = true }, color = c.danger)
                if (category?.preset != null && (category.customName || category.customDescription)) {
                    RkLinkButton(stringResource(R.string.settings_categories_restore), {
                        onRestore(inbox, notifies)
                        onDismiss()
                    })
                }
                Spacer(Modifier.weight(1f))
                RkButton(stringResource(R.string.common_actions_cancel), onDismiss, kind = RkButtonKind.SECONDARY)
                RkButton(stringResource(if (category != null) R.string.common_actions_save else R.string.common_actions_add), {
                    if (name.isBlank() && category?.preset == null) {
                        error = needName
                    } else {
                        try {
                            onSave(name.trim(), description.trim(), color, inbox, notifies)
                            onDismiss()
                        } catch (e: Exception) {
                            error = e
                        }
                    }
                }, kind = RkButtonKind.PRIMARY)
            }
        }
    }
    if (confirmDelete && category != null) {
        RkDialog(
            title = stringResource(R.string.settings_categories_delete_title, category.name),
            text = stringResource(R.string.settings_categories_delete_help),
            confirmLabel = stringResource(R.string.common_actions_delete),
            danger = true,
            onDismiss = { confirmDelete = false },
            onConfirm = {
                confirmDelete = false
                onDelete()
                onDismiss()
            },
        )
    }
}

/**
 * A switch in the category dialog (styles.css .cat-inbox, .cat-notify): its label with a line of help under it, and the switch.
 * Disabled, the switch keeps its state, dimmed, and the help says why.
 */
@Composable
private fun DialogSwitch(title: String, help: String, checked: Boolean, onCheckedChange: (Boolean) -> Unit, enabled: Boolean = true) {
    val shape = Rk.shapes.control
    Row(
        Modifier
            .fillMaxWidth()
            .clip(shape)
            .toggleable(value = checked, enabled = enabled, role = Role.Switch, interactionSource = null, indication = Rk.indication(shape), onValueChange = onCheckedChange)
            .padding(vertical = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(title, style = Rk.type.text13_5.medium, color = Rk.colors.text)
            Text(help, style = Rk.type.text12_5, color = Rk.colors.text2)
        }
        RkSwitch(checked, null, enabled = enabled)
    }
}

/** The TypeSafe key: a new one, removing it, or nothing. */
@Composable
private fun KeyDialog(hasKey: Boolean, onDismiss: () -> Unit, onRemove: () -> Unit, onSave: (String) -> Unit) {
    var key by remember { mutableStateOf("") }
    RkDialog(
        title = stringResource(R.string.settings_categories_key_prompt),
        text = stringResource(R.string.settings_categories_jev_shares),
        confirmLabel = stringResource(R.string.common_actions_save),
        confirmEnabled = key.isNotBlank(),
        onDismiss = onDismiss,
        onConfirm = { if (key.isNotBlank()) onSave(key.trim()) },
    ) {
        RkTextField(value = key, onValueChange = { key = it }, password = true, mono = true, keyboardOptions = KeyboardOptions(autoCorrectEnabled = false))
        if (hasKey) {
            Row(Modifier.fillMaxWidth()) {
                RkLinkButton(stringResource(R.string.settings_categories_key_remove), onRemove, color = Rk.colors.danger)
            }
        }
    }
}
