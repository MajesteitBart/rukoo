package nl.bvdm.rukoo.ui.mail

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBars
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.flowOf
import nl.bvdm.rukoo.R
import nl.bvdm.rukoo.mail.model.FolderRole
import nl.bvdm.rukoo.mail.model.MailCounts
import nl.bvdm.rukoo.mail.model.MailView
import nl.bvdm.rukoo.mail.model.SyncStatus
import nl.bvdm.rukoo.mail.model.ViewKind
import nl.bvdm.rukoo.ui.components.AccountAvatar
import nl.bvdm.rukoo.ui.components.DotTone
import nl.bvdm.rukoo.ui.components.Hairline
import nl.bvdm.rukoo.ui.components.RkBottomSheet
import nl.bvdm.rukoo.ui.components.RkIcon
import nl.bvdm.rukoo.ui.components.RkIconButton
import nl.bvdm.rukoo.ui.components.SheetRow
import nl.bvdm.rukoo.ui.components.StatusDot
import nl.bvdm.rukoo.ui.components.rkClickable
import nl.bvdm.rukoo.ui.icons.RukooIcons
import nl.bvdm.rukoo.ui.root.AppViewModel
import nl.bvdm.rukoo.ui.theme.AccountColors
import nl.bvdm.rukoo.ui.theme.Rk
import nl.bvdm.rukoo.ui.theme.medium
import nl.bvdm.rukoo.ui.theme.semibold
import nl.bvdm.rukoo.ui.theme.tabular
import nl.bvdm.rukoo.ui.theme.weight

/**
 * The folder drawer, the desktop sidebar on a phone (spec 6 §4.3 and §5.2): the account switch, the
 * unified views with their counts, each account's own folders with a color dot, the sync status and
 * Settings. Views keep the account scope the switch chose.
 */
@Composable
fun FolderDrawerContent(app: AppViewModel, modifier: Modifier = Modifier) {
    val c = Rk.colors
    val mail = app.services.mail
    val nav by app.state.collectAsStateWithLifecycle()
    val accounts by mail.accounts.collectAsStateWithLifecycle()
    val folders by mail.folders.collectAsStateWithLifecycle()
    val sync by mail.sync.collectAsStateWithLifecycle()
    val localDrafts by app.services.drafts.drafts.collectAsStateWithLifecycle()
    val scope = nav.view.accountId?.takeIf { id -> accounts.any { it.id == id } }
    val countsFlow = remember(scope) { runCatching { mail.counts(scope) }.getOrElse { flowOf(MailCounts()) } }
    val counts by countsFlow.collectAsStateWithLifecycle(MailCounts())
    val scoped = if (scope == null) accounts else accounts.filter { it.id == scope }
    var switching by remember { mutableStateOf(false) }

    Column(modifier.background(c.bg).windowInsetsPadding(WindowInsets.systemBars)) {
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(horizontal = 10.dp, vertical = 10.dp)) {
            // The account switch (styles.css:655-694).
            val account = scope?.let { id -> accounts.firstOrNull { it.id == id } } ?: accounts.singleOrNull()
            Row(
                Modifier
                    .fillMaxWidth()
                    .heightIn(min = 52.dp)
                    .rkClickable(Rk.shapes.card, enabled = accounts.size > 1) { switching = true }
                    .padding(horizontal = 8.dp, vertical = 6.dp),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                AccountAvatar(account?.name?.ifBlank { account.email } ?: "∗", account?.let { AccountColors.parse(it.color) })
                Column(Modifier.weight(1f)) {
                    Text(
                        account?.name?.ifBlank { account.email } ?: stringResource(R.string.mailbox_search_all_accounts),
                        style = Rk.type.text13.semibold,
                        color = c.text,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    Text(
                        account?.email ?: pluralStringResource(R.plurals.mailbox_sidebar_account_count, accounts.size, accounts.size),
                        style = Rk.type.text11_5,
                        color = c.text3,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
                if (accounts.size > 1) RkIcon(RukooIcons.ChevronUpDown, null, size = 16.dp, tint = c.text3)
            }
            Spacer(Modifier.size(8.dp))

            val hasArchive = scoped.any { mail.archiveFolder(it.id) != null }
            val hasJunk = scoped.any { a -> folders[a.id].orEmpty().any { it.role == FolderRole.JUNK } }
            val localCount = localDrafts.count { scope == null || it.accountId == scope }
            for (kind in VIEWS) {
                if (kind == ViewKind.ARCHIVE && !hasArchive) continue
                if (kind == ViewKind.JUNK && !hasJunk) continue
                val view = MailView(kind, scope)
                val n = (counts.views[kind] ?: 0) + if (kind == ViewKind.DRAFTS) localCount else 0
                NavItem(
                    label = viewTitle(view, folders),
                    icon = viewIcon(kind),
                    selected = nav.view == view,
                    count = n.takeIf { it > 0 && kind in COUNTED },
                    strong = kind == ViewKind.INBOX,
                    onClick = { app.selectView(view) },
                )
            }

            for (a in scoped) {
                val own = folders[a.id].orEmpty().filter { it.role == FolderRole.NONE }.sortedBy { it.name.lowercase() }
                Row(Modifier.fillMaxWidth().padding(start = 10.dp, end = 0.dp, top = 14.dp, bottom = 2.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        if (scoped.size > 1) a.email else stringResource(R.string.mailbox_layout_folders),
                        style = Rk.type.text11_5.semibold,
                        color = c.text3,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f),
                    )
                    // Desktop reveals the + on hover; touch shows it always (spec 6 §5.7).
                    RkIconButton(RukooIcons.Plus, stringResource(R.string.mailbox_folders_new), onClick = { app.mailUi.newFolder(a.id) }, size = nl.bvdm.rukoo.ui.components.RkIconButtonSize.SMALL)
                }
                for (f in own) {
                    val view = MailView.folder(a.id, f.path)
                    NavItem(
                        label = f.name,
                        dot = f.name,
                        selected = nav.view == view,
                        count = f.unread.takeIf { it > 0 },
                        onClick = { app.selectView(view) },
                    )
                }
            }
        }
        Hairline()
        Footer(app, sync, scoped.map { it.id })
    }

    if (switching) {
        RkBottomSheet(onDismissRequest = { switching = false }, title = stringResource(R.string.mail_drawer_accounts)) {
            SheetRow(stringResource(R.string.mailbox_search_all_accounts), checked = scope == null, onClick = {
                app.selectView(nav.view.copy(accountId = null, folder = null, kind = if (nav.view.kind == ViewKind.FOLDER) ViewKind.INBOX else nav.view.kind))
                dismiss()
            })
            for (a in accounts) {
                SheetRow(a.name.ifBlank { a.email }, hint = a.email, checked = scope == a.id, onClick = {
                    app.selectView(if (nav.view.kind == ViewKind.FOLDER) MailView(ViewKind.INBOX, a.id) else nav.view.copy(accountId = a.id))
                    dismiss()
                })
            }
        }
    }
}

// Desktop's sidebar order (app.js:41-51), with Unread from the brief; Saved emails don't exist on the phone.
private val VIEWS = listOf(
    ViewKind.INBOX, ViewKind.UNREAD, ViewKind.VIP, ViewKind.STARRED, ViewKind.DRAFTS,
    ViewKind.SENT, ViewKind.ARCHIVE, ViewKind.JUNK, ViewKind.TRASH,
)

// Which views show a count: inbox strong, the rest muted (styles.css:772-781).
private val COUNTED = setOf(ViewKind.INBOX, ViewKind.UNREAD, ViewKind.VIP, ViewKind.DRAFTS, ViewKind.JUNK)

/** A drawer row (styles.css:718-781): icon or folder dot, the name, a count; the current view is filled. */
@Composable
private fun NavItem(
    label: String,
    selected: Boolean,
    onClick: () -> Unit,
    icon: ImageVector? = null,
    dot: String? = null,
    count: Int? = null,
    strong: Boolean = false,
) {
    val c = Rk.colors
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 44.dp)
            .background(if (selected) c.active else androidx.compose.ui.graphics.Color.Transparent, Rk.shapes.control)
            .rkClickable(Rk.shapes.control, onClick = onClick)
            .padding(start = 10.dp, end = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(20.dp), contentAlignment = Alignment.Center) {
            when {
                icon != null -> RkIcon(icon, null, size = 18.dp, tint = if (selected) c.text2 else c.text3)
                dot != null -> FolderDot(dot)
            }
        }
        Text(
            label,
            style = if (selected) Rk.type.text13.semibold else Rk.type.text13,
            color = if (selected) c.text else c.text2,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        if (count != null) {
            Text(
                count.toString(),
                style = if (strong) Rk.type.text12.weight(650).tabular else Rk.type.text12.medium.tabular,
                color = if (strong) c.text else c.text3,
            )
        }
    }
}

/** Sync status and Settings (styles.css:803-857): a dot (ok, busy pulsing, failed) and when mail last came in. */
@Composable
private fun Footer(app: AppViewModel, sync: SyncStatus, accountIds: List<String>) {
    val c = Rk.colors
    val dates = rememberMailDates()
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(Unit) {
        while (true) {
            delay(30_000)
            now = System.currentTimeMillis()
        }
    }
    val running = accountIds.any { it in sync.running }
    val failed = accountIds.any { it in sync.errors }
    val last = accountIds.mapNotNull { sync.lastSync[it] }.maxOrNull()
    val text = when {
        running -> stringResource(R.string.mailbox_sync_syncing)
        failed -> stringResource(R.string.mailbox_sync_failed)
        last == null -> stringResource(R.string.mailbox_sync_never)
        now - last < 60_000 -> stringResource(R.string.mailbox_sync_just_now)
        now - last < 3_600_000 -> ((now - last) / 60_000).toInt().let { pluralStringResource(R.plurals.mailbox_sync_minutes_ago, it, it) }
        dates.sameDay(last, now) -> stringResource(R.string.mailbox_sync_time, dates.time(last))
        else -> stringResource(R.string.mailbox_sync_date, dates.numericDate(last))
    }
    Row(
        Modifier.fillMaxWidth().heightIn(min = 52.dp).padding(start = 20.dp, end = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        StatusDot(
            when {
                running -> DotTone.WARN
                failed -> DotTone.DANGER
                else -> DotTone.OK
            },
            pulsing = running,
        )
        Text(text, style = Rk.type.text12, color = c.text3, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
        RkIconButton(RukooIcons.Sync, stringResource(R.string.mailbox_actions_sync), onClick = { app.mailUi.refresh() })
        RkIconButton(RukooIcons.Settings, stringResource(R.string.mail_drawer_settings), onClick = {
            app.closeDrawer()
            app.openSettings()
        })
    }
}
