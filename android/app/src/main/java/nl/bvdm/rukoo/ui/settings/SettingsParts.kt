package nl.bvdm.rukoo.ui.settings

import android.content.ClipData
import android.content.ClipDescription
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.PersistableBundle
import androidx.annotation.StringRes
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.core.net.toUri
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.util.Locale
import nl.bvdm.rukoo.R
import nl.bvdm.rukoo.agents.model.AgentState
import nl.bvdm.rukoo.ui.components.DotTone
import nl.bvdm.rukoo.ui.components.RkBottomSheet
import nl.bvdm.rukoo.ui.components.RkButton
import nl.bvdm.rukoo.ui.components.RkButtonKind
import nl.bvdm.rukoo.ui.components.RkIcon
import nl.bvdm.rukoo.ui.components.SheetRow
import nl.bvdm.rukoo.ui.components.StatusDot
import nl.bvdm.rukoo.ui.components.popIn
import nl.bvdm.rukoo.ui.icons.PanelIcons
import nl.bvdm.rukoo.ui.icons.RukooIcons
import nl.bvdm.rukoo.ui.theme.Rk
import nl.bvdm.rukoo.ui.theme.rkSurface
import nl.bvdm.rukoo.ui.theme.semibold

/**
 * A settings page body: one scrolling column, at most 720dp wide as on desktop (styles.css settings page),
 * padded 16dp with room at the end.
 */
@Composable
fun SettingsPageBody(modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    Box(modifier.fillMaxSize().verticalScroll(rememberScrollState()), contentAlignment = Alignment.TopCenter) {
        Column(Modifier.widthIn(max = 720.dp).fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 4.dp, bottom = 48.dp)) {
            content()
        }
    }
}

/** An agent's group title, with the product after the name in `text3` at 75% (styles.css:3499-3508). */
@Composable
fun AgentGroupTitle(name: String, product: String?) {
    Row(Modifier.padding(start = 4.dp, top = 18.dp, bottom = 6.dp, end = 4.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(name, style = Rk.type.text12.semibold, color = Rk.colors.text3, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
        if (product != null) Text(product, style = Rk.type.text12, color = Rk.colors.text3.copy(alpha = 0.75f), maxLines = 1)
    }
}

/** Intro text above a page's cards (`.settings-intro`): 12.5 `text2`. */
@Composable
fun SettingsIntro(text: String, modifier: Modifier = Modifier) {
    Text(text, modifier.padding(start = 4.dp, end = 4.dp, top = 10.dp, bottom = 2.dp), style = Rk.type.text12_5, color = Rk.colors.text2)
}

enum class NoteTone { INFO, WARN, OK, ERROR }

/**
 * The note box (`.note`): `chip` fill, 10dp corners, 13px `text2`. A tone puts a status icon in front; the
 * color stays on the icon, as the design wants color only where there is a state.
 */
@Composable
fun NoteBox(text: String, modifier: Modifier = Modifier, tone: NoteTone = NoteTone.INFO, selectable: Boolean = false) {
    val c = Rk.colors
    val (icon, tint) = when (tone) {
        NoteTone.INFO -> PanelIcons.Info to c.text3
        NoteTone.WARN -> PanelIcons.Shield to c.warn
        NoteTone.OK -> PanelIcons.Check to c.ok
        NoteTone.ERROR -> PanelIcons.X to c.danger
    }
    Row(
        modifier.fillMaxWidth().rkSurface(null, Rk.shapes.card, c.chip).padding(horizontal = 12.dp, vertical = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        RkIcon(icon, null, Modifier.padding(top = 1.dp), size = 16.dp, tint = tint)
        val body: @Composable () -> Unit = { Text(text, style = Rk.type.text13, color = if (tone == NoteTone.ERROR) c.text else c.text2) }
        if (selectable) SelectionContainer { body() } else body()
    }
}

/** An error line under a form (`.error`): 13px `danger`. */
@Composable
fun ErrorLine(text: String, modifier: Modifier = Modifier) {
    Text(text, modifier, style = Rk.type.text13, color = Rk.colors.danger)
}

/** A status: 8dp dot and label, and the technical detail in mono 11.5 `text3` (styles.css:3517-3525). */
@Composable
fun StatusLine(label: String, tone: DotTone, modifier: Modifier = Modifier, detail: String? = null, pulsing: Boolean = false) {
    Column(modifier, verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            StatusDot(tone, size = 8.dp, pulsing = pulsing)
            Text(label, style = Rk.type.text13, color = Rk.colors.text, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
        if (!detail.isNullOrBlank()) {
            SelectionContainer {
                Text(detail, Modifier.padding(start = 16.dp), style = Rk.type.mono, color = Rk.colors.text3, maxLines = 3, overflow = TextOverflow.Ellipsis)
            }
        }
    }
}

/**
 * A dialog (ui.js `dialog`): `raised`, a 1dp `border`, 14dp corners, the 16/650 title, text in `text2` and
 * the buttons on the right. The confirm button is the one filled button, red when it destroys something.
 */
@Composable
fun RkDialog(
    title: String,
    confirmLabel: String,
    onConfirm: () -> Unit,
    onDismiss: () -> Unit,
    modifier: Modifier = Modifier,
    text: String? = null,
    dismissLabel: String = stringResource(R.string.common_actions_cancel),
    danger: Boolean = false,
    confirmEnabled: Boolean = true,
    content: (@Composable ColumnScope.() -> Unit)? = null,
) {
    Dialog(onDismissRequest = onDismiss) {
        val c = Rk.colors
        val shape = Rk.shapes.window
        Column(
            modifier
                .popIn(140)
                .widthIn(max = 420.dp)
                .fillMaxWidth()
                .rkSurface(Rk.elevation.overlay, shape, c.raised)
                .border(1.dp, c.border, shape)
                .padding(start = 20.dp, end = 20.dp, top = 20.dp, bottom = 16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Text(title, style = Rk.type.dialogTitle, color = c.text)
            if (text != null) Text(text, style = Rk.type.text13.copy(lineHeight = Rk.type.text13.fontSize * 1.5f), color = c.text2)
            content?.invoke(this)
            Spacer(Modifier.height(6.dp))
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End)) {
                RkButton(dismissLabel, onDismiss, kind = RkButtonKind.SECONDARY)
                RkButton(confirmLabel, onConfirm, kind = if (danger) RkButtonKind.DANGER else RkButtonKind.PRIMARY, enabled = confirmEnabled)
            }
        }
    }
}

/** One choice of a [ChoiceSheet]. */
data class Choice<T>(val value: T, val label: String, val hint: String? = null)

/** A short picker as a bottom sheet (the phone's choice dialog): 48dp rows, the current one checked. */
@Composable
fun <T> ChoiceSheet(title: String, choices: List<Choice<T>>, selected: T?, onSelect: (T) -> Unit, onDismiss: () -> Unit) {
    RkBottomSheet(onDismissRequest = onDismiss, title = title) {
        for (choice in choices) {
            SheetRow(
                label = choice.label,
                hint = choice.hint,
                checked = choice.value == selected,
                onClick = {
                    onSelect(choice.value)
                    dismiss()
                },
            )
        }
    }
}

/** An icon at the start of a settings row: 18dp in `text2`, or [tint]. */
@Composable
fun RowIcon(icon: ImageVector, tint: Color = Rk.colors.text2) {
    RkIcon(icon, null, size = 18.dp, tint = tint)
}

/** The add row's leading plus, in `ok` as on desktop (`.add-ic`). */
@Composable
fun AddIcon() {
    RkIcon(RukooIcons.Plus, null, size = 18.dp, tint = Rk.colors.ok)
}

/** The interface locale, for dates: the app's language, not the system's (spec 6 §5.8). */
@Composable
fun currentLocale(): Locale = LocalConfiguration.current.locales[0] ?: Locale.getDefault()

/** `09/10/2026` and `17:04`: the short date of [locale] and a 24-hour time, as desktop formats them. */
fun formatDate(ms: Long, locale: Locale): String =
    DateTimeFormatter.ofLocalizedDate(FormatStyle.SHORT).withLocale(locale).format(Instant.ofEpochMilli(ms).atZone(ZoneId.systemDefault()))

fun formatTime(ms: Long, locale: Locale): String =
    DateTimeFormatter.ofPattern("HH:mm", locale).format(Instant.ofEpochMilli(ms).atZone(ZoneId.systemDefault()))

/** The label of an agent's state (agent.status.*). */
@StringRes
fun agentStateLabel(state: AgentState): Int = when (state) {
    AgentState.READY -> R.string.settings_agent_status_ready
    AgentState.OFFLINE -> R.string.settings_agent_status_offline
    AgentState.UNCONFIGURED -> R.string.settings_agent_status_unconfigured
    AgentState.DISABLED -> R.string.settings_agent_status_disabled
    AgentState.MISSING -> R.string.settings_agent_status_missing
    AgentState.UNAUTHORIZED -> R.string.settings_agent_status_unauthorized
    AgentState.UNKNOWN -> R.string.settings_agent_status_unknown
    AgentState.CHECKING -> R.string.settings_agent_status_checking
}

fun agentStateTone(state: AgentState): DotTone = when (state) {
    AgentState.READY -> DotTone.READY
    AgentState.CHECKING -> DotTone.BUSY
    AgentState.OFFLINE, AgentState.UNAUTHORIZED -> DotTone.OFFLINE
    else -> DotTone.MUTED
}

/** A state a computer reports in `/hello` (desktop's words), as ours. */
fun hostState(state: String): AgentState = AgentState.entries.firstOrNull { it.name.equals(state.replace("-", ""), ignoreCase = true) } ?: AgentState.UNKNOWN

/**
 * Copies [text] that holds a token: marked sensitive, so Android keeps it out of the clipboard preview and
 * keyboard suggestions (dudan SettingsScreen.kt:680-686).
 */
fun copySensitive(context: Context, label: String, text: String) {
    val clip = ClipData.newPlainText(label, text)
    val key = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) ClipDescription.EXTRA_IS_SENSITIVE else "android.content.extra.IS_SENSITIVE"
    clip.description.extras = PersistableBundle().apply { putBoolean(key, true) }
    context.getSystemService(ClipboardManager::class.java)?.setPrimaryClip(clip)
}

/** Opens a web page in the browser; false when nothing can show it. */
fun openWebPage(context: Context, url: String): Boolean =
    runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, url.toUri()).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }.isSuccess
