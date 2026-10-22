package nl.bvdm.rukoo.ui.mail

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import nl.bvdm.rukoo.R
import nl.bvdm.rukoo.mail.model.Folder
import nl.bvdm.rukoo.mail.model.FolderRole
import nl.bvdm.rukoo.mail.model.MailView
import nl.bvdm.rukoo.mail.model.ViewKind
import nl.bvdm.rukoo.ui.components.RkBottomSheet
import nl.bvdm.rukoo.ui.components.RkButton
import nl.bvdm.rukoo.ui.components.RkButtonKind
import nl.bvdm.rukoo.ui.components.RkIcon
import nl.bvdm.rukoo.ui.components.RkTextField
import nl.bvdm.rukoo.ui.components.SheetRow
import nl.bvdm.rukoo.ui.components.popIn
import nl.bvdm.rukoo.ui.icons.RukooIcons
import nl.bvdm.rukoo.ui.theme.Rk
import nl.bvdm.rukoo.ui.theme.RukooDurations
import nl.bvdm.rukoo.ui.theme.lineHeight
import nl.bvdm.rukoo.ui.theme.rkSurface

/** The interface language's date helpers, with today and yesterday translated. */
@Composable
fun rememberMailDates(): MailDates {
    val locale = LocalConfiguration.current.locales[0]
    val today = stringResource(R.string.common_dates_today)
    val yesterday = stringResource(R.string.common_dates_yesterday)
    return remember(locale, today, yesterday) { MailDates(locale, today = today, yesterday = yesterday) }
}

/** A folder role's name, or null for a user folder (desktop displayFolderName). */
@Composable
fun roleName(role: FolderRole): String? = when (role) {
    FolderRole.INBOX -> stringResource(R.string.mailbox_folders_inbox)
    FolderRole.SENT -> stringResource(R.string.mailbox_folders_sent)
    FolderRole.DRAFTS -> stringResource(R.string.mailbox_folders_drafts)
    FolderRole.TRASH -> stringResource(R.string.mailbox_folders_trash)
    FolderRole.JUNK -> stringResource(R.string.mailbox_folders_junk)
    FolderRole.ARCHIVE, FolderRole.ALL -> stringResource(R.string.mailbox_folders_archive)
    FolderRole.FLAGGED -> stringResource(R.string.mailbox_folders_starred)
    FolderRole.IMPORTANT, FolderRole.NONE -> null
}

@Composable
fun folderName(folder: Folder): String = roleName(folder.role) ?: folder.name

/** The title of a view; a folder shows its name. */
@Composable
fun viewTitle(view: MailView, folders: Map<String, List<Folder>> = emptyMap()): String = when (view.kind) {
    ViewKind.INBOX -> stringResource(R.string.mailbox_folders_inbox)
    ViewKind.UNREAD -> stringResource(R.string.mailbox_filters_unread)
    ViewKind.VIP -> stringResource(R.string.mailbox_folders_vip)
    ViewKind.STARRED -> stringResource(R.string.mailbox_folders_starred)
    ViewKind.DRAFTS -> stringResource(R.string.mailbox_folders_drafts)
    ViewKind.SENT -> stringResource(R.string.mailbox_folders_sent)
    ViewKind.ARCHIVE -> stringResource(R.string.mailbox_folders_archive)
    ViewKind.JUNK -> stringResource(R.string.mailbox_folders_junk)
    ViewKind.TRASH -> stringResource(R.string.mailbox_folders_trash)
    ViewKind.EVERYTHING -> stringResource(R.string.mailbox_folders_everything)
    ViewKind.FOLDER -> folders[view.accountId]?.firstOrNull { it.path == view.folder }?.let { folderName(it) } ?: view.folder.orEmpty()
}

fun viewIcon(kind: ViewKind): ImageVector = when (kind) {
    ViewKind.INBOX -> RukooIcons.Inbox
    ViewKind.UNREAD -> RukooIcons.Unread
    ViewKind.VIP -> RukooIcons.Vip
    ViewKind.STARRED -> RukooIcons.Star
    ViewKind.DRAFTS -> RukooIcons.Drafts
    ViewKind.SENT -> RukooIcons.Sent
    ViewKind.ARCHIVE -> RukooIcons.Archive
    ViewKind.JUNK -> RukooIcons.Junk
    ViewKind.TRASH -> RukooIcons.Trash
    ViewKind.EVERYTHING -> RukooIcons.Folder
    ViewKind.FOLDER -> RukooIcons.Folder
}

fun roleIcon(role: FolderRole?): ImageVector = when (role) {
    FolderRole.INBOX -> RukooIcons.Inbox
    FolderRole.SENT -> RukooIcons.Sent
    FolderRole.DRAFTS -> RukooIcons.Drafts
    FolderRole.TRASH -> RukooIcons.Trash
    FolderRole.JUNK -> RukooIcons.Junk
    FolderRole.ARCHIVE, FolderRole.ALL -> RukooIcons.Archive
    FolderRole.FLAGGED -> RukooIcons.Star
    else -> RukooIcons.Folder
}

/** A folder's color dot (styles.css:763-768): 8dp, 3dp corners, hue from its name. */
@Composable
fun FolderDot(name: String, modifier: Modifier = Modifier) {
    Box(modifier.size(8.dp).background(Rk.colors.folderDot(nl.bvdm.rukoo.ui.theme.rukooHue(name)), RoundedCornerShape(3.dp)))
}

/**
 * The list checkbox (styles.css:1062-1093): 18dp, 5dp corners, a 1.5dp `borderStrong` edge on `panel`; on is
 * `accent` with a white check, [partial] a white bar.
 */
@Composable
fun MailCheckbox(checked: Boolean, modifier: Modifier = Modifier, partial: Boolean = false, description: String? = null) {
    val c = Rk.colors
    val shape = RoundedCornerShape(5.dp)
    val on = checked || partial
    Box(
        modifier
            .size(18.dp)
            .background(if (on) c.accent else c.panel, shape)
            .then(if (on) Modifier else Modifier.border(1.5.dp, c.borderStrong, shape))
            .semantics {
                role = Role.Checkbox
                if (description != null) stateDescription = description
            },
        contentAlignment = Alignment.Center,
    ) {
        when {
            checked -> RkIcon(RukooIcons.named("check", 2.6f), null, size = 13.dp, tint = Color.White)
            partial -> Box(Modifier.size(8.dp, 2.dp).background(Color.White, RoundedCornerShape(1.dp)))
        }
    }
}

/**
 * The app dialog (ui.js dialog; styles.css:2187-2268): `raised` with a hairline, 14dp corners, the title at
 * 16/650, text in `text2`, buttons on the right. The last button is the filled one (red when [DialogRequest.danger]);
 * a third choice ("Don't save") sits on the left.
 */
@Composable
fun MailDialog(request: DialogRequest) {
    val c = Rk.colors
    var text by remember(request) { mutableStateOf(request.input.orEmpty()) }
    val focus = remember(request) { FocusRequester() }
    Dialog(
        onDismissRequest = { request.answer(DialogChoice.CANCEL) },
        properties = DialogProperties(usePlatformDefaultWidth = false),
    ) {
        Column(
            Modifier
                .padding(20.dp)
                .widthIn(max = 420.dp)
                .fillMaxWidth()
                .popIn(RukooDurations.DIALOG, fromScale = 0.97f)
                .rkSurface(Rk.elevation.shadow, Rk.shapes.window, c.raised)
                .border(1.dp, c.border, Rk.shapes.window)
                .padding(start = 20.dp, end = 20.dp, top = 20.dp, bottom = 16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Text(request.title, style = Rk.type.dialogTitle, color = c.text)
            if (request.message != null) {
                Text(
                    request.message,
                    style = Rk.type.text13.lineHeight(1.5f),
                    color = c.text2,
                    modifier = Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState()),
                )
            }
            if (request.input != null) {
                RkTextField(
                    value = text,
                    onValueChange = { text = it },
                    placeholder = request.inputPlaceholder,
                    focusRequester = focus,
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                    keyboardActions = KeyboardActions(onDone = { request.answer(DialogChoice.CONFIRM, text) }),
                )
                LaunchedEffect(request) { runCatching { focus.requestFocus() } }
            }
            Spacer(Modifier.height(4.dp))
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                if (request.otherLabel != null) {
                    RkButton(request.otherLabel, { request.answer(DialogChoice.OTHER, text) }, kind = RkButtonKind.SECONDARY, modifier = Modifier.weight(1f, fill = false))
                }
                Spacer(Modifier.weight(1f))
                RkButton(request.cancelLabel, { request.answer(DialogChoice.CANCEL) }, kind = RkButtonKind.SECONDARY, modifier = Modifier.weight(1f, fill = false))
                RkButton(
                    request.confirmLabel,
                    { request.answer(DialogChoice.CONFIRM, text) },
                    kind = if (request.danger) RkButtonKind.DANGER else RkButtonKind.PRIMARY,
                    modifier = Modifier.weight(1f, fill = false),
                )
            }
        }
    }
}

/** The move picker as a bottom sheet (desktop's choiceDialog in pickFolder). */
@Composable
fun MoveSheet(mailUi: MailUi) {
    val list = mailUi.moving ?: return
    val targets = remember(list) { mailUi.moveTargets(list) }
    RkBottomSheet(
        onDismissRequest = mailUi::closePicker,
        title = if (list.size == 1) stringResource(R.string.mailbox_move_title) else pluralStringResource(R.plurals.mailbox_move_count_title, list.size, list.size),
    ) {
        Column(Modifier.verticalScroll(rememberScrollState())) {
            for (target in targets) {
                SheetRow(label = target.label, icon = roleIcon(target.role), onClick = { mailUi.pick(target) })
            }
        }
    }
}
