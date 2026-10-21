package nl.bvdm.rukoo.ui.gallery

import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsBottomHeight
import androidx.compose.foundation.layout.windowInsetsTopHeight
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.rememberVectorPainter
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import nl.bvdm.rukoo.R
import nl.bvdm.rukoo.ui.components.AccountAvatar
import nl.bvdm.rukoo.ui.components.AddChip
import nl.bvdm.rukoo.ui.components.Avatar
import nl.bvdm.rukoo.ui.components.AvatarSize
import nl.bvdm.rukoo.ui.components.CollapsibleRail
import nl.bvdm.rukoo.ui.components.ContextCard
import nl.bvdm.rukoo.ui.components.CountPill
import nl.bvdm.rukoo.ui.components.DonePill
import nl.bvdm.rukoo.ui.components.DoneTone
import nl.bvdm.rukoo.ui.components.DotTone
import nl.bvdm.rukoo.ui.components.EmptyState
import nl.bvdm.rukoo.ui.components.EntityChip
import nl.bvdm.rukoo.ui.components.ExpandChevron
import nl.bvdm.rukoo.ui.components.Hairline
import nl.bvdm.rukoo.ui.components.LocalRkToast
import nl.bvdm.rukoo.ui.components.Monogram
import nl.bvdm.rukoo.ui.components.NewsDot
import nl.bvdm.rukoo.ui.components.NewsTone
import nl.bvdm.rukoo.ui.components.OfferRow
import nl.bvdm.rukoo.ui.components.PanelCard
import nl.bvdm.rukoo.ui.components.PanelHeading
import nl.bvdm.rukoo.ui.components.PixelLoader
import nl.bvdm.rukoo.ui.components.QuickFilter
import nl.bvdm.rukoo.ui.components.QuickFilterRow
import nl.bvdm.rukoo.ui.components.RailText
import nl.bvdm.rukoo.ui.components.RkBottomSheet
import nl.bvdm.rukoo.ui.components.RkButton
import nl.bvdm.rukoo.ui.components.RkButtonKind
import nl.bvdm.rukoo.ui.components.RkButtonSize
import nl.bvdm.rukoo.ui.components.RkChipButton
import nl.bvdm.rukoo.ui.components.RkDropdownMenu
import nl.bvdm.rukoo.ui.components.RkIcon
import nl.bvdm.rukoo.ui.components.RkIconButton
import nl.bvdm.rukoo.ui.components.RkIconButtonSize
import nl.bvdm.rukoo.ui.components.RkLinkButton
import nl.bvdm.rukoo.ui.components.RkMenuItem
import nl.bvdm.rukoo.ui.components.RkPillButton
import nl.bvdm.rukoo.ui.components.RkPillKind
import nl.bvdm.rukoo.ui.components.RkPillSize
import nl.bvdm.rukoo.ui.components.RkSearchField
import nl.bvdm.rukoo.ui.components.RkStatus
import nl.bvdm.rukoo.ui.components.RkSwitch
import nl.bvdm.rukoo.ui.components.RkTextField
import nl.bvdm.rukoo.ui.components.RkToastHost
import nl.bvdm.rukoo.ui.components.RkToolbarButton
import nl.bvdm.rukoo.ui.components.RkTopBar
import nl.bvdm.rukoo.ui.components.SectionTitle
import nl.bvdm.rukoo.ui.components.SettingsCard
import nl.bvdm.rukoo.ui.components.SettingsChevron
import nl.bvdm.rukoo.ui.components.SettingsRow
import nl.bvdm.rukoo.ui.components.SettingsSwitchRow
import nl.bvdm.rukoo.ui.components.SettingsTrailingValue
import nl.bvdm.rukoo.ui.components.SheetDivider
import nl.bvdm.rukoo.ui.components.SheetHeading
import nl.bvdm.rukoo.ui.components.SheetRow
import nl.bvdm.rukoo.ui.components.ShimmerText
import nl.bvdm.rukoo.ui.components.SourceBadge
import nl.bvdm.rukoo.ui.components.SourceKind
import nl.bvdm.rukoo.ui.components.Spinner
import nl.bvdm.rukoo.ui.components.StatusDot
import nl.bvdm.rukoo.ui.components.StatusPill
import nl.bvdm.rukoo.ui.components.SuggestionChip
import nl.bvdm.rukoo.ui.components.rememberRkToastState
import nl.bvdm.rukoo.ui.components.rkClickable
import nl.bvdm.rukoo.ui.icons.EffortLevels
import nl.bvdm.rukoo.ui.icons.Gauge
import nl.bvdm.rukoo.ui.icons.PanelIcons
import nl.bvdm.rukoo.ui.icons.ProviderLogos
import nl.bvdm.rukoo.ui.icons.RukooIcons
import nl.bvdm.rukoo.ui.theme.AccountColors
import nl.bvdm.rukoo.ui.theme.Rk
import nl.bvdm.rukoo.ui.theme.RukooTheme
import nl.bvdm.rukoo.ui.theme.ThemeMode
import nl.bvdm.rukoo.ui.theme.rkSurface
import nl.bvdm.rukoo.ui.theme.medium
import nl.bvdm.rukoo.ui.theme.panel
import nl.bvdm.rukoo.ui.theme.semibold
import nl.bvdm.rukoo.ui.theme.tabular
import nl.bvdm.rukoo.ui.theme.title

/**
 * A debug screen with every base component in every state, the type scale, the color tokens and both icon
 * sets, for screenshot review. The sample texts are fixtures, like the demo account's mail, so they are not
 * in the string catalogs; component labels that have catalog strings use them.
 */
@Composable
fun ComponentGallery() {
    var theme by rememberSaveable { mutableStateOf(ThemeMode.SYSTEM) }
    RukooTheme(theme) {
        val toast = rememberRkToastState()
        CompositionLocalProvider(LocalRkToast provides toast) {
            Box(Modifier.fillMaxSize().background(Rk.colors.bg)) {
                Gallery(theme) { theme = it }
                RkToastHost(toast, Modifier.align(Alignment.BottomCenter))
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun Gallery(theme: ThemeMode, onTheme: (ThemeMode) -> Unit) {
    val c = Rk.colors
    val toast = LocalRkToast.current
    val undo = stringResource(R.string.components_undo)
    LaunchedEffect(Unit) { toast.showToast("Moved to Trash", undo) {} }
    LazyColumn(Modifier.fillMaxSize()) {
        item { Spacer(Modifier.windowInsetsTopHeight(WindowInsets.statusBars)) }
        item {
            Column(Modifier.padding(horizontal = 16.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text("Rukoo components", style = Rk.type.pageTitle, color = c.text)
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    for (mode in ThemeMode.entries) {
                        RkButton(
                            mode.name.lowercase().replaceFirstChar { it.uppercase() },
                            onClick = { onTheme(mode) },
                            kind = if (mode == theme) RkButtonKind.PRIMARY else RkButtonKind.DEFAULT,
                            size = RkButtonSize.SMALL,
                        )
                    }
                }
            }
        }
        item { Section("Top bar and quick filters") { BarsDemo() } }
        item { Section("Buttons") { ButtonsDemo() } }
        item { Section("Panel buttons") { PillsDemo() } }
        item { Section("Avatars and chips") { PeopleDemo() } }
        item { Section("Status") { StatusDemo() } }
        item { Section("Agent work") { LiveDemo() } }
        item { Section("Settings") { SettingsDemo() } }
        item { Section("Fields") { FieldsDemo() } }
        item { Section("Menus and sheets") { MenusDemo() } }
        item { Section("Empty state") { EmptyState("No emails match this filter", hint = "Try another search term.", actionLabel = "Show all", onAction = {}) } }
        item { Section("Type") { TypeDemo() } }
        item { Section("Colors") { ColorsDemo() } }
        item { Section("App icons (${RukooIcons.names.size})") { IconGrid(RukooIcons.names.toList()) { RukooIcons.named(it) } } }
        item { Section("Panel icons (${PanelIcons.names.size})") { IconGrid(PanelIcons.names.toList()) { PanelIcons.named(it) } } }
        item {
            Section("Provider logos") {
                FlowRow(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    for (id in listOf("google", "yahoo", "outlook", "exchange", "office365", "other", "demo")) {
                        Column(horizontalAlignment = Alignment.CenterHorizontally) {
                            Image(rememberVectorPainter(ProviderLogos.forProvider(id)), id, Modifier.size(48.dp))
                            Text(id, style = Rk.type.text11, color = c.text3)
                        }
                    }
                }
            }
        }
        item { Section("Launcher icon") { LauncherDemo() } }
        item { Spacer(Modifier.height(96.dp).windowInsetsBottomHeight(WindowInsets.navigationBars)) }
    }
}

@Composable
private fun Section(title: String, content: @Composable ColumnScope.() -> Unit) {
    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp)) {
        SectionTitle(title)
        Column(verticalArrangement = Arrangement.spacedBy(10.dp), content = content)
    }
}

@Composable
private fun Surface(color: Color = Rk.colors.panel, content: @Composable ColumnScope.() -> Unit) {
    Column(
        Modifier
            .fillMaxWidth()
            .background(color, Rk.shapes.panel)
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
        content = content,
    )
}

@Composable
private fun BarsDemo() {
    val c = Rk.colors
    var filter by remember { mutableStateOf("all") }
    Column(Modifier.fillMaxWidth().background(c.panel, Rk.shapes.panel)) {
        RkTopBar(
            title = "Inbox",
            subtitle = "6 unread · demo@example.com",
            titleStyle = Rk.type.pageTitle,
            height = 64.dp,
            windowInsets = WindowInsets(0),
            hairline = false,
            navigation = { RkIconButton(RukooIcons.Menu, "Folders", {}) },
            actions = {
                RkIconButton(RukooIcons.Search, "Search", {})
                RkIconButton(RukooIcons.Sparkle, "Chat with an agent", {}, news = NewsTone.UNREAD)
                RkIconButton(RukooIcons.More, stringResource(R.string.components_more_options), {})
            },
        )
        QuickFilterRow(
            listOf(QuickFilter("all", "All"), QuickFilter("unread", "Unread", 6), QuickFilter("starred", "Starred", 2), QuickFilter("attachments", "Attachments", 3)),
            selectedKey = filter,
            onSelect = { filter = it },
        )
        RkTopBar(
            title = "Call on Thursday",
            windowInsets = WindowInsets(0),
            navigation = { RkIconButton(RukooIcons.Back, stringResource(R.string.components_back), {}) },
            actions = {
                RkIconButton(RukooIcons.Archive, "Archive", {})
                RkIconButton(RukooIcons.Trash, "Delete", {})
                RkIconButton(RukooIcons.MarkUnread, "Mark unread", {})
            },
        )
        Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            RkToolbarButton("Reply", RukooIcons.Reply, {})
            RkToolbarButton("Reply all", RukooIcons.ReplyAll, {}, showLabel = false)
            RkToolbarButton("Forward", RukooIcons.Forward, {}, showLabel = false)
            Spacer(Modifier.weight(1f))
            RkPillButton("Clark", {}, icon = RukooIcons.Sparkle, size = RkPillSize.SM)
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ButtonsDemo() {
    Surface {
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            RkButton("Send", {}, kind = RkButtonKind.PRIMARY, size = RkButtonSize.LARGE, trailingIcon = RukooIcons.Send)
            RkButton("Save", {}, kind = RkButtonKind.PRIMARY)
            RkButton("Test connection", {})
            RkButton("Reset to 100%", {}, kind = RkButtonKind.SECONDARY)
            RkButton("Cancel", {}, kind = RkButtonKind.GHOST)
            RkButton("Don't save", {}, kind = RkButtonKind.QUIET)
            RkButton("Delete", {}, kind = RkButtonKind.DANGER)
            RkButton("Add account", {}, icon = RukooIcons.Plus, size = RkButtonSize.SMALL)
            RkButton("Disabled", {}, kind = RkButtonKind.PRIMARY, enabled = false)
        }
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp), itemVerticalAlignment = Alignment.CenterVertically) {
            RkToolbarButton("Edit", RukooIcons.Edit, {}, primary = true)
            RkToolbarButton("Delete", RukooIcons.Trash, {}, danger = true)
            RkLinkButton("Save all", {}, icon = RukooIcons.Download)
            RkChipButton("Unsubscribe", {}, icon = RukooIcons.Unsubscribe)
        }
        FlowRow(horizontalArrangement = Arrangement.spacedBy(2.dp), itemVerticalAlignment = Alignment.CenterVertically) {
            RkIconButton(RukooIcons.Sync, "Sync", {})
            RkIconButton(RukooIcons.TextFormat, "Formatting", {}, selected = true)
            RkIconButton(RukooIcons.Bell, "Recent chats", {}, size = RkIconButtonSize.SMALL, news = NewsTone.WAITING)
            RkIconButton(RukooIcons.Plus, "New chat", {}, size = RkIconButtonSize.SMALL)
            RkIconButton(RukooIcons.Close, stringResource(R.string.components_close), {}, size = RkIconButtonSize.XS)
            RkIconButton(RukooIcons.Star, "Star", {}, enabled = false)
            RkIconButton(RukooIcons.StarFilled, "Starred", {}, tint = Rk.colors.star)
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun PillsDemo() {
    Surface(Rk.colors.bg) {
        for (size in RkPillSize.entries) {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp), itemVerticalAlignment = Alignment.CenterVertically) {
                RkPillButton("Add tasks", {}, kind = RkPillKind.PRIMARY, size = size)
                RkPillButton("Decline", {}, kind = RkPillKind.SECONDARY, size = size)
                RkPillButton("Show", {}, kind = RkPillKind.GHOST, size = size)
                RkPillButton("Accent", {}, kind = RkPillKind.ACCENT, size = size)
                RkPillButton("Deny", {}, kind = RkPillKind.DANGER, size = size)
                RkPillButton("Undo", {}, kind = RkPillKind.QUIET, size = size)
                RkPillButton("Set up Clark", {}, kind = RkPillKind.LINK, size = size)
            }
        }
        RkPillButton("Disabled", {}, kind = RkPillKind.PRIMARY, enabled = false)
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun PeopleDemo() {
    val c = Rk.colors
    Surface {
        FlowRow(horizontalArrangement = Arrangement.spacedBy(10.dp), itemVerticalAlignment = Alignment.CenterVertically) {
            Avatar("Sanne de Vries", "sanne@example.com", size = AvatarSize.Large)
            Avatar("Bencompare", "info@bencompare.nl", size = AvatarSize.Large)
            Avatar("Serus", "hello@serus.ai", size = AvatarSize.Medium)
            Avatar(null, "joris.bakker@example.com", size = AvatarSize.Small)
            Avatar("Google", "no-reply@accounts.google.com", logo = rememberVectorPainter(ProviderLogos.Google))
            Monogram("Clark", size = 24.dp, agent = true)
            Monogram("Sanne de Vries", hueKey = "sanne@example.com")
            AccountAvatar("demo@example.com", AccountColors.forIndex(0))
            AccountAvatar("work", AccountColors.forIndex(1))
            AccountAvatar("All", null)
            SourceBadge("Todoist")
            SourceBadge("Email", email = true, emailIcon = PanelIcons.Mail)
        }
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp), itemVerticalAlignment = Alignment.CenterVertically) {
            EntityChip("Call on Thursday", sub = "Sanne de Vries", monogram = "Sanne de Vries", monogramHueKey = "sanne@example.com", onRemove = {}, removeLabel = "Leave this email out")
            EntityChip("Clark", agent = true)
            EntityChip(
                "Proposal-v3.pdf",
                sub = "192 B",
                leading = { Box(Modifier.size(18.dp).background(c.ink3.copy(alpha = 0.18f), RoundedCornerShape(5.dp))) },
                pending = true,
            )
            AddChip("Add this email", {})
            SuggestionChip("Draft a reply", {}, icon = PanelIcons.Mail)
            SuggestionChip("Summarize", {}, icon = PanelIcons.Sparkle, delayMs = 40)
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun StatusDemo() {
    Surface(Rk.colors.bg) {
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp), itemVerticalAlignment = Alignment.CenterVertically) {
            StatusPill("Done", RkStatus.DONE)
            StatusPill("In progress", RkStatus.BUSY)
            StatusPill("Failed", RkStatus.FAILED)
            StatusPill("Proposed", RkStatus.PROPOSED)
            StatusPill("Skipped", RkStatus.NEUTRAL)
            StatusPill("Connected", RkStatus.DONE, dot = true)
            DonePill("Approved", DoneTone.APPROVED)
            DonePill("Declined", DoneTone.DECLINED)
            DonePill("Expired", DoneTone.EXPIRED)
        }
        FlowRow(horizontalArrangement = Arrangement.spacedBy(12.dp), itemVerticalAlignment = Alignment.CenterVertically) {
            for (tone in DotTone.entries) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    StatusDot(tone, pulsing = tone == DotTone.WARN)
                    Text(tone.name.lowercase(), style = Rk.type.text11, color = Rk.colors.text3)
                }
            }
            NewsDot(NewsTone.UNREAD, ring = Rk.colors.bg)
            NewsDot(NewsTone.WAITING, ring = Rk.colors.bg)
            CountPill("3")
        }
        PanelHeading("Follow-ups", count = 3)
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun LiveDemo() {
    val c = Rk.colors
    var open by remember { mutableStateOf(true) }
    Surface(c.bg) {
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
            PixelLoader()
            ShimmerText("Clark is working on it...")
            Text("1.4s", style = Rk.type.mono.tabular, color = c.ink3)
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            RkIcon(PanelIcons.Sparkle, null, size = 16.dp, tint = c.ink3)
            Text("Thought for 4s", style = Rk.type.panelBody.medium, color = c.ink2)
            ExpandChevron(open)
            Spacer(Modifier.width(12.dp))
            Spinner()
            for (effort in listOf(null, "low", "medium", "high", "max")) {
                Gauge(EffortLevels.levelOf(effort), color = c.ink3)
            }
        }
        // A tool row with its detail open, as in the transcript.
        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            ToolChipSample("Looked at your screen", PanelIcons.Mail, done = true, accent = true) { open = !open }
            ToolChipSample("Ran a command", PanelIcons.Terminal, done = null) {}
            ToolChipSample("Searched the web ×3", PanelIcons.Globe, done = false) {}
        }
        CollapsibleRail(open) {
            RailText("Get-ChildItem -Path E:\\Development\\rukoo -Filter *.kt", mono = true)
            RailText("Read the open email and the two before it in the thread.")
        }
        ContextCard(
            "Call on Thursday",
            kind = SourceKind.EMAIL,
            host = "Sanne de Vries",
            excerpt = "Shall we have a call on Thursday at 10:00 to discuss the proposal? I have attached the latest version.",
            sourceLabel = "Email",
            onOpen = {},
        )
        ContextCard("Traffic fines in 2027", kind = SourceKind.WEB, host = "anwb.nl", sourceLabel = "anwb.nl", delayMs = 100)
        PanelCard {
            Text("Add 2 tasks to Todoist", style = Rk.type.text14.medium.panel, color = c.ink)
            Text("Review Proposal-v3.pdf (due Wednesday) and send notes to Joris after the call (due Friday).", style = Rk.type.text12_5.panel, color = c.ink2)
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                ShimmerText("Waiting for you", style = Rk.type.text12.medium.panel, modifier = Modifier.weight(1f))
                RkPillButton("Decline", {})
                RkPillButton("Add tasks", {}, kind = RkPillKind.PRIMARY)
            }
        }
        OfferRow("Continue the chat about the earlier message", {}, sub = "Clark · 14:06", leading = { Monogram("Clark", size = 20.dp, agent = true) })
    }
}

@Composable
private fun ToolChipSample(label: String, icon: ImageVector, done: Boolean?, accent: Boolean = false, onClick: () -> Unit) {
    val c = Rk.colors
    val shape = Rk.shapes.chip
    Row(
        Modifier
            .height(28.dp)
            .rkSurface(Rk.elevation.btn, shape, c.surface)
            .rkClickable(shape, onClick = onClick)
            .padding(start = 7.dp, end = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        RkIcon(icon, null, size = 14.dp, tint = if (accent) c.accentInk else c.ink3)
        Text(label, style = Rk.type.text12.medium.panel, color = if (done == null) c.ink2 else c.ink, maxLines = 1, overflow = TextOverflow.Ellipsis)
        when (done) {
            null -> Spinner()
            true -> RkIcon(PanelIcons.named("check", 3f), null, size = 11.dp, tint = c.green)
            false -> RkIcon(PanelIcons.named("x", 3f), null, size = 11.dp, tint = c.red)
        }
    }
}

@Composable
private fun SettingsDemo() {
    var dark by remember { mutableStateOf(true) }
    var swipe by remember { mutableStateOf(false) }
    SettingsCard {
        SettingsRow(
            "demo@example.com (default)",
            description = "Last synced on 09/10/2026 at 17:04",
            leading = { AccountAvatar("demo@example.com", AccountColors.forIndex(0)) },
            onClick = {},
        )
        SettingsRow("Add account", leading = { RkIcon(RukooIcons.Plus, null, size = 18.dp, tint = Rk.colors.ok) }, onClick = {})
    }
    SettingsCard {
        SettingsRow("Language", description = "Choose the language used throughout the app.", value = "English", onClick = {})
        SettingsRow("Manage folders", description = "Show or hide email folders.", trailing = { SettingsChevron() }, onClick = {})
        SettingsSwitchRow("Dark email display", dark, { dark = it }, description = "Adjust HTML email colors in dark mode.")
        SettingsSwitchRow("Touchscreen swipe actions", swipe, { swipe = it }, description = "Swipe right to mark as read or unread, and left to delete.")
        SettingsSwitchRow("Sender logos", true, {}, enabled = false)
        SettingsRow("Sync schedule", trailing = { SettingsTrailingValue("Every 5 minutes") }, onClick = {})
    }
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
        RkSwitch(true, {})
        RkSwitch(false, {})
        RkSwitch(true, {}, enabled = false)
    }
}

@Composable
private fun FieldsDemo() {
    var name by remember { mutableStateOf("Clark") }
    var url by remember { mutableStateOf("") }
    var key by remember { mutableStateOf("sk-hermes-0123456789") }
    var search by remember { mutableStateOf("") }
    var host by remember { mutableStateOf("imap.example") }
    Surface {
        RkSearchField(search, { search = it }, placeholder = "Search in Inbox")
        RkSearchField("proposal", {}, placeholder = "Search in Inbox")
        RkTextField(name, { name = it }, label = "Name")
        RkTextField(url, { url = it }, label = "URL", placeholder = "http://100.91.52.84:8642", help = "The Hermes API server on your tailnet.")
        RkTextField(key, { key = it }, label = "Key", password = true)
        RkTextField(host, { host = it }, label = "IMAP server", error = "Invalid email address", mono = true)
    }
}

@Composable
private fun MenusDemo() {
    val c = Rk.colors
    var sheet by remember { mutableStateOf(false) }
    var menu by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth().background(c.raised, Rk.shapes.card)) {
        SheetHeading("Message")
        SheetRow("Reply", {}, icon = RukooIcons.Reply)
        SheetRow("Add to chat", {}, icon = RukooIcons.Sparkle, hint = "Clark")
        SheetRow("Compact view", {}, icon = RukooIcons.Notes, checked = true)
        SheetDivider()
        SheetRow("Delete", {}, icon = RukooIcons.Trash, danger = true)
        SheetRow("Export as .eml", {}, icon = RukooIcons.Export, enabled = false)
    }
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        RkButton("Open sheet", { sheet = true }, kind = RkButtonKind.SECONDARY)
        Box {
            RkButton("Open menu", { menu = true }, kind = RkButtonKind.SECONDARY)
            RkDropdownMenu(menu, { menu = false }) {
                RkMenuItem("Clark", { menu = false }, leading = { StatusDot(DotTone.READY) }, tag = "Hermes Agent", checked = true)
                RkMenuItem("Claude", { menu = false }, leading = { StatusDot(DotTone.OFFLINE) }, tag = "Claude Code")
                RkMenuItem("Codex", { menu = false }, leading = { StatusDot(DotTone.MUTED) }, tag = "Codex")
            }
        }
    }
    if (sheet) {
        RkBottomSheet(onDismissRequest = { sheet = false }, title = "Recent chats") {
            SheetRow("Call on Thursday", { dismiss() }, hint = "Clark · Reply ready", tag = "14:45")
            SheetRow("Traffic fines in 2027", { dismiss() }, hint = "Clark · Waiting for you", tag = "Yesterday")
            SheetRow("New chat", { dismiss() }, icon = RukooIcons.Plus)
        }
    }
}

@Composable
private fun TypeDemo() {
    val c = Rk.colors
    val t = Rk.type
    Surface {
        Text("Setup title 26/650", style = t.setupTitle, color = c.text)
        Text("Reader subject 20/650", style = t.readerSubject, color = c.text)
        Text("Inbox 18/650", style = t.pageTitle, color = c.text)
        Text("Dialog title 16/650", style = t.dialogTitle, color = c.text)
        Text("Email body 14.5, line height 1.6", style = t.emailBody, color = c.text)
        Text("Body 13: Shall we have a call on Thursday?", style = t.body, color = c.text)
        Text("Unread sender 13/700", style = t.text13.copy(fontWeight = nl.bvdm.rukoo.ui.theme.RukooWeights.Bold), color = c.text)
        Text("Preview 12.5 text3: ANWB Driving in low sun", style = t.text12_5, color = c.text3)
        Text("Meta 11.5 tabular: 14:45 · 8 Oct · 1.4 MB", style = t.meta, color = c.text3)
        Text("Panel prose 13/1.625: I checked your earlier mail with Sanne and kept the reply short.", style = t.panelProse, color = c.ink)
        Text("Section 12/600", style = t.text12.semibold, color = c.text3)
        Text("Title 14/650", style = t.text14.title, color = c.text)
        Text("mono 11.5: Get-ChildItem -Filter *.kt", style = t.mono, color = c.ink2)
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ColorsDemo() {
    val c = Rk.colors
    val swatches = listOf(
        "bg" to c.bg, "panel" to c.panel, "panel2" to c.panel2, "raised" to c.raised, "border" to c.border,
        "borderStrong" to c.borderStrong, "hover" to c.hover, "active" to c.active, "chip" to c.chip, "text" to c.text,
        "text2" to c.text2, "text3" to c.text3, "accent" to c.accent, "accentSoft" to c.accentSoft, "link" to c.link,
        "primary" to c.primary, "danger" to c.danger, "star" to c.star, "ok" to c.ok, "warn" to c.warn,
        "green" to c.green, "greenTint" to c.greenTint, "orange" to c.orange, "orangeTint" to c.orangeTint,
        "red" to c.red, "redTint" to c.redTint, "skill" to c.skill,
    )
    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        for ((name, color) in swatches) {
            Column(Modifier.widthIn(min = 64.dp)) {
                Box(Modifier.size(64.dp, 28.dp).background(color, Rk.shapes.chip))
                Text(name, style = Rk.type.text11, color = c.text3)
            }
        }
    }
    Hairline()
}

/** The adaptive icon's layers under a circle and a rounded-square mask, and the themed (monochrome) layer. */
@Composable
private fun LauncherDemo() {
    val c = Rk.colors
    val background = painterResource(R.drawable.ic_launcher_background)
    val foreground = painterResource(R.drawable.ic_launcher_foreground)
    val mono = painterResource(R.drawable.ic_launcher_monochrome)
    // The launcher shows the inner 72 of the 108dp canvas, so the layers are drawn at 1.5x and clipped.
    val zoom = Modifier.fillMaxSize().graphicsLayer(scaleX = 1.5f, scaleY = 1.5f)
    Row(horizontalArrangement = Arrangement.spacedBy(16.dp), verticalAlignment = Alignment.CenterVertically) {
        for (shape in listOf(CircleShape, RoundedCornerShape(28.dp))) {
            Box(Modifier.size(96.dp).clip(shape)) {
                Image(background, null, zoom)
                Image(foreground, null, zoom)
            }
        }
        Box(Modifier.size(96.dp).clip(CircleShape).background(Color(0xFFD8E2FF))) {
            Image(mono, null, zoom, colorFilter = ColorFilter.tint(Color(0xFF233A6B)))
        }
        Image(foreground, null, Modifier.size(96.dp).background(c.panel2, Rk.shapes.card))
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun IconGrid(names: List<String>, icon: (String) -> ImageVector) {
    val c = Rk.colors
    FlowRow(
        Modifier.fillMaxWidth().background(c.panel, Rk.shapes.panel).padding(8.dp),
        horizontalArrangement = Arrangement.spacedBy(4.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        for (name in names) {
            Column(Modifier.width(64.dp).padding(vertical = 4.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                RkIcon(icon(name), name, size = 22.dp, tint = c.text2)
                Text(name, style = Rk.type.text11, color = c.text3, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
    }
}
