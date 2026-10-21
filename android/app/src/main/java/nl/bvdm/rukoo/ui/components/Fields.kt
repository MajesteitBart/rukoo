package nl.bvdm.rukoo.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.dropShadow
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.shadow.Shadow
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import nl.bvdm.rukoo.R
import nl.bvdm.rukoo.ui.icons.RukooIcons
import nl.bvdm.rukoo.ui.theme.Rk
import nl.bvdm.rukoo.ui.theme.RukooMono

/**
 * A form field (`.field`): an optional label in `text2` above an input on `panel` with a 1dp `borderStrong`
 * edge and 8dp corners. Focus turns the edge accent with a 3dp `accentSoft` halo; an [error] turns it
 * `danger` and replaces [help]. A [password] field hides its text and gets an eye button inside.
 */
@Composable
fun RkTextField(
    value: String,
    onValueChange: (String) -> Unit,
    modifier: Modifier = Modifier,
    label: String? = null,
    placeholder: String? = null,
    help: String? = null,
    error: String? = null,
    singleLine: Boolean = true,
    minLines: Int = 1,
    maxLines: Int = if (singleLine) 1 else Int.MAX_VALUE,
    password: Boolean = false,
    showPasswordLabel: String = stringResource(R.string.components_show_password),
    hidePasswordLabel: String = stringResource(R.string.components_hide_password),
    mono: Boolean = false,
    enabled: Boolean = true,
    readOnly: Boolean = false,
    keyboardOptions: KeyboardOptions = KeyboardOptions.Default,
    keyboardActions: KeyboardActions = KeyboardActions.Default,
    focusRequester: FocusRequester? = null,
    trailing: (@Composable () -> Unit)? = null,
) {
    val c = Rk.colors
    val shape = Rk.shapes.control
    val source = remember { MutableInteractionSource() }
    val focused by source.collectIsFocusedAsState()
    var revealed by rememberSaveable { mutableStateOf(false) }
    val edge = when {
        error != null -> c.danger
        focused -> c.accent
        else -> c.borderStrong
    }
    var field = Modifier.fillMaxWidth()
    if (focused) field = field.dropShadow(shape, Shadow(radius = 0.dp, spread = 3.dp, color = if (error != null) c.redTint else c.accentSoft))
    field = field.background(c.panel, shape).border(1.dp, edge, shape)
    val style = Rk.type.text13_5.let { if (mono) it.copy(fontFamily = RukooMono, fontFeatureSettings = null) else it }.copy(color = c.text)
    Column(modifier.alpha(if (enabled) 1f else 0.55f), verticalArrangement = Arrangement.spacedBy(5.dp)) {
        if (label != null) Text(label, style = Rk.type.text12_5, color = c.text2)
        BasicTextField(
            value = value,
            onValueChange = onValueChange,
            modifier = (if (focusRequester != null) Modifier.focusRequester(focusRequester) else Modifier).fillMaxWidth(),
            enabled = enabled,
            readOnly = readOnly,
            textStyle = style,
            singleLine = singleLine,
            minLines = minLines,
            maxLines = maxLines,
            keyboardOptions = if (password) keyboardOptions.copy(keyboardType = KeyboardType.Password, autoCorrectEnabled = false) else keyboardOptions,
            keyboardActions = keyboardActions,
            visualTransformation = if (password && !revealed) PasswordVisualTransformation() else VisualTransformation.None,
            interactionSource = source,
            cursorBrush = SolidColor(c.accent),
            decorationBox = { inner ->
                Row(field.heightIn(min = 44.dp), verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.weight(1f).padding(horizontal = 12.dp, vertical = 10.dp)) {
                        if (value.isEmpty() && placeholder != null) {
                            Text(placeholder, style = style, color = c.text3, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                        inner()
                    }
                    if (password) {
                        RkIconButton(
                            icon = if (revealed) RukooIcons.EyeOff else RukooIcons.Eye,
                            contentDescription = if (revealed) hidePasswordLabel else showPasswordLabel,
                            onClick = { revealed = !revealed },
                            size = RkIconButtonSize.SMALL,
                        )
                    }
                    if (trailing != null) trailing()
                }
            },
        )
        when {
            error != null -> Text(error, style = Rk.type.text13, color = c.danger)
            help != null -> Text(help, style = Rk.type.text12, color = c.text3)
        }
    }
}

/**
 * The search field: a `chip` field with the search icon, a placeholder such as "Search in Inbox" and a
 * clear button once there is text. The keyboard's action key searches.
 */
@Composable
fun RkSearchField(
    value: String,
    onValueChange: (String) -> Unit,
    placeholder: String,
    modifier: Modifier = Modifier,
    onSearch: (() -> Unit)? = null,
    clearLabel: String = stringResource(R.string.components_clear),
    focusRequester: FocusRequester? = null,
) {
    val c = Rk.colors
    val shape = Rk.shapes.control
    val style = Rk.type.text13_5.copy(color = c.text)
    BasicTextField(
        value = value,
        onValueChange = onValueChange,
        modifier = (if (focusRequester != null) modifier.focusRequester(focusRequester) else modifier).fillMaxWidth(),
        textStyle = style,
        singleLine = true,
        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
        keyboardActions = KeyboardActions(onSearch = { onSearch?.invoke() }),
        cursorBrush = SolidColor(c.accent),
        decorationBox = { inner ->
            Row(
                Modifier.fillMaxWidth().heightIn(min = 40.dp).background(c.chip, shape).padding(start = 12.dp, end = 2.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                RkIcon(RukooIcons.Search, null, size = 16.dp, tint = c.text3)
                Box(Modifier.weight(1f).padding(vertical = 8.dp)) {
                    if (value.isEmpty()) Text(placeholder, style = style, color = c.text3, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    inner()
                }
                if (value.isNotEmpty()) {
                    RkIconButton(RukooIcons.Close, clearLabel, onClick = { onValueChange("") }, size = RkIconButtonSize.SMALL)
                }
            }
        },
    )
}
