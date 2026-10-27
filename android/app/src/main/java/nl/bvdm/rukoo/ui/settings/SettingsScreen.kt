package nl.bvdm.rukoo.ui.settings

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.SaveableStateHolder
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import nl.bvdm.rukoo.BuildConfig
import nl.bvdm.rukoo.R
import nl.bvdm.rukoo.mail.model.MailProviders
import nl.bvdm.rukoo.settings.Language
import nl.bvdm.rukoo.settings.ThemeMode
import nl.bvdm.rukoo.ui.components.Hairline
import nl.bvdm.rukoo.ui.components.LocalRkToast
import nl.bvdm.rukoo.ui.components.RkIconButton
import nl.bvdm.rukoo.ui.components.RkToastHost
import nl.bvdm.rukoo.ui.components.RkTopBar
import nl.bvdm.rukoo.ui.components.SectionTitle
import nl.bvdm.rukoo.ui.components.SettingsCard
import nl.bvdm.rukoo.ui.components.SettingsChevron
import nl.bvdm.rukoo.ui.components.SettingsRow
import nl.bvdm.rukoo.ui.components.rememberRkToastState
import nl.bvdm.rukoo.ui.icons.PanelIcons
import nl.bvdm.rukoo.ui.icons.RukooIcons
import nl.bvdm.rukoo.ui.root.AppViewModel
import nl.bvdm.rukoo.ui.root.Overlay
import nl.bvdm.rukoo.ui.root.TwoPaneMinWidth
import nl.bvdm.rukoo.ui.theme.Rk

/** The pages of Settings. Sub-pages hang off a section and are written `kind:arg` where they take one. */
object SettingsRoutes {
    const val ACCOUNTS = "accounts"
    const val AGENTS = "agents"
    const val PHONE = "phone"
    const val NOTIFICATIONS = "notifications"
    const val APPEARANCE = "appearance"
    const val LANGUAGE = "language"
    const val ABOUT = "about"
    const val ADD_ACCOUNT = "add-account"
    const val GOOGLE = "google"
    const val IMAP = "imap:"
    const val PAIR = "pair"
    const val IMPORT = "import"
    const val SHORTCUTS = "shortcuts"

    /** One shortcut by its command; the bare prefix is a new one. */
    const val SHORTCUT = "shortcut:"
    const val RUKOO = "rukoo"
    const val RUKOO_SIGNUP = "rukoo-signup"
    const val RUKOO_SIGNIN = "rukoo-signin"
    const val RUKOO_RECOVER = "rukoo-recover"
    const val RUKOO_PRIVACY = "rukoo-privacy"
    const val CATEGORIES = "categories"

    val sections = listOf(ACCOUNTS, RUKOO, AGENTS, PHONE, NOTIFICATIONS, APPEARANCE, LANGUAGE, CATEGORIES, ABOUT)
}

/** Moves between Settings pages; [reset] makes a section the only page (a tap in the two-pane list). */
class SettingsNav(val push: (String) -> Unit, val pop: () -> Unit, val reset: (String) -> Unit)

/**
 * Settings, a full-screen route on both widths (spec 6 §4.8): the list of sections, then a section's page.
 * From 600dp the list stays on the left and the page sits next to it. Back pops a page, then leaves.
 */
@Composable
fun SettingsScreen(app: AppViewModel, modifier: Modifier = Modifier) {
    val model: SetupModel = viewModel { SetupModel(app.services) }
    // Opened on a page (the chat's Edit shortcuts): that page, with the way back to its section.
    remember { app.takeSettingsStart()?.let(model::setSettingsStack) }
    val stack by model.settingsStack.collectAsStateWithLifecycle()
    // Each page keeps its fields when the layout moves it between the one- and two-pane branches.
    val pages = rememberSaveableStateHolder()
    val toast = rememberRkToastState()
    val nav = SettingsNav(
        push = { route -> model.setSettingsStack(model.settingsStack.value + route) },
        pop = { model.setSettingsStack(model.settingsStack.value.dropLast(1)) },
        reset = { route -> model.setSettingsStack(listOf(route)) },
    )
    // Folding recreates this screen with Settings still open; closing Settings starts it at the top next time.
    DisposableEffect(Unit) { onDispose { if (app.state.value.overlay != Overlay.SETTINGS) model.settingsClosed() } }
    val add by model.add.collectAsStateWithLifecycle()
    val addedText = add.added?.let { stringResource(R.string.settings_setup_account_added, it.email) }
    val clientText = stringResource(R.string.settings_setup_google_ready)
    LaunchedEffect(add.added, add.clientImported) {
        if (addedText != null) {
            toast.showToast(addedText)
            nav.reset(SettingsRoutes.ACCOUNTS)
        } else if (add.clientImported) {
            toast.showToast(clientText)
        }
        if (add.added != null || add.clientImported) model.consumeAdded()
    }

    CompositionLocalProvider(LocalRkToast provides toast) {
        Box(modifier.background(Rk.colors.bg)) {
            BoxWithConstraints(Modifier.fillMaxSize()) {
                val two = maxWidth >= TwoPaneMinWidth
                BackHandler(enabled = stack.size > 1 || (!two && stack.isNotEmpty())) { nav.pop() }
                if (two) {
                    val route = stack.lastOrNull() ?: SettingsRoutes.ACCOUNTS
                    Row(Modifier.fillMaxSize()) {
                        Column(Modifier.width(300.dp).fillMaxHeight()) {
                            SettingsBar(stringResource(R.string.settings_title_short), onBack = app::closeOverlay)
                            SettingsHome(app, selected = stack.firstOrNull() ?: SettingsRoutes.ACCOUNTS, chevrons = false, onOpen = nav.reset)
                        }
                        Hairline(Modifier.fillMaxHeight(), vertical = true)
                        Column(Modifier.weight(1f).fillMaxHeight()) {
                            SettingsBar(routeTitle(route), onBack = if (stack.size > 1) nav.pop else null)
                            Page(app, model, nav, route, pages)
                        }
                    }
                } else {
                    val route = stack.lastOrNull()
                    Column(Modifier.fillMaxSize()) {
                        if (route == null) {
                            SettingsBar(stringResource(R.string.settings_title_short), onBack = app::closeOverlay)
                            SettingsHome(app, selected = null, chevrons = true, onOpen = nav.push)
                        } else {
                            SettingsBar(routeTitle(route), onBack = nav.pop)
                            Page(app, model, nav, route, pages)
                        }
                    }
                }
            }
            RkToastHost(toast, Modifier.align(Alignment.BottomCenter))
        }
    }
}

@Composable
private fun SettingsBar(title: String, onBack: (() -> Unit)?) {
    RkTopBar(
        title = title,
        titleStyle = Rk.type.pageTitle,
        navigation = onBack?.let { back -> { RkIconButton(RukooIcons.Back, stringResource(R.string.common_actions_back), onClick = back) } },
        background = Rk.colors.bg,
        hairline = false,
    )
}

@Composable
private fun Page(app: AppViewModel, model: SetupModel, nav: SettingsNav, route: String, pages: SaveableStateHolder) {
    val motion = Rk.motion
    AnimatedContent(
        targetState = route,
        transitionSpec = { fadeIn(motion.tween(160)) togetherWith fadeOut(motion.tween(100)) },
        label = "settings page",
    ) { page ->
        pages.SaveableStateProvider(page) { PageContent(app, model, nav, page) }
    }
}

@Composable
private fun PageContent(app: AppViewModel, model: SetupModel, nav: SettingsNav, page: String) {
    when {
        page == SettingsRoutes.ACCOUNTS -> AccountsPage(app, model, nav)
        page == SettingsRoutes.AGENTS -> AgentsPage(app, model, nav)
        page == SettingsRoutes.SHORTCUTS -> ShortcutsPage(app, nav)
        page.startsWith(SettingsRoutes.SHORTCUT) -> ShortcutPage(app, model, nav, page.removePrefix(SettingsRoutes.SHORTCUT))
        page == SettingsRoutes.PHONE -> PhoneToolsPage(app)
        page == SettingsRoutes.NOTIFICATIONS -> NotificationsPage(app)
        page == SettingsRoutes.APPEARANCE -> AppearancePage(app)
        page == SettingsRoutes.LANGUAGE -> LanguagePage(app)
        page == SettingsRoutes.ABOUT -> AboutPage()
        page == SettingsRoutes.RUKOO -> RukooAccountPage(app, nav)
        page == SettingsRoutes.RUKOO_SIGNUP -> RukooFormPage(app, nav, RukooAccountModel.Form.SIGN_UP)
        page == SettingsRoutes.RUKOO_SIGNIN -> RukooFormPage(app, nav, RukooAccountModel.Form.SIGN_IN)
        page == SettingsRoutes.RUKOO_RECOVER -> RukooFormPage(app, nav, RukooAccountModel.Form.RECOVER)
        page == SettingsRoutes.RUKOO_PRIVACY -> RukooPrivacyPage(app)
        page == SettingsRoutes.CATEGORIES -> CategoriesPage(app)
        page == SettingsRoutes.ADD_ACCOUNT -> AddAccountPage(app, model, nav)
        page == SettingsRoutes.GOOGLE -> SettingsPageBody {
            GoogleSetup(
                model,
                onPassword = { nav.push(SettingsRoutes.IMAP + "google") },
                onPair = { pairOrImport(app, model, nav) },
                modifier = Modifier.padding(top = 12.dp),
            )
        }
        page.startsWith(SettingsRoutes.IMAP) -> SettingsPageBody {
            ImapAccountForm(page.removePrefix(SettingsRoutes.IMAP), model, Modifier.padding(top = 12.dp))
        }
        page == SettingsRoutes.PAIR || page == SettingsRoutes.IMPORT -> SettingsPageBody {
            PairComputerFlow(
                model,
                onDone = {
                    val leave = model.importLeavesSettings
                    model.resetPair()
                    // A first-run import that moved on here is done: the inbox comes next.
                    if (leave) app.closeOverlay() else nav.pop()
                },
                modifier = Modifier.padding(top = 12.dp),
            )
        }
        else -> AccountsPage(app, model, nav)
    }
}

/**
 * Bringing accounts over: pairing when no computer is paired yet, else the import offer of the computer
 * paired last.
 */
fun pairOrImport(app: AppViewModel, model: SetupModel, nav: SettingsNav) {
    val computer = app.services.agentSettings.current().computers.maxByOrNull { it.pairedAt }
    if (computer == null) {
        model.resetPair()
        nav.push(SettingsRoutes.PAIR)
    } else {
        model.offerImport(computer)
        nav.push(SettingsRoutes.IMPORT)
    }
}

@Composable
private fun routeTitle(route: String): String = when {
    route == SettingsRoutes.ACCOUNTS -> stringResource(R.string.settings_groups_accounts)
    route == SettingsRoutes.AGENTS -> stringResource(R.string.settings_agents_title)
    route == SettingsRoutes.SHORTCUTS -> stringResource(R.string.settings_agents_shortcuts)
    route == SettingsRoutes.SHORTCUT -> stringResource(R.string.settings_shortcuts_new_title)
    route.startsWith(SettingsRoutes.SHORTCUT) -> stringResource(R.string.settings_shortcuts_edit_title)
    route == SettingsRoutes.PHONE -> stringResource(R.string.settings_phone_tools_title)
    route == SettingsRoutes.NOTIFICATIONS -> stringResource(R.string.settings_general_notifications)
    route == SettingsRoutes.APPEARANCE -> stringResource(R.string.settings_appearance_title)
    route == SettingsRoutes.LANGUAGE -> stringResource(R.string.settings_general_language)
    route == SettingsRoutes.ABOUT -> stringResource(R.string.settings_groups_about)
    route == SettingsRoutes.ADD_ACCOUNT -> stringResource(R.string.settings_accounts_add)
    route == SettingsRoutes.GOOGLE -> stringResource(R.string.settings_setup_google_title)
    route.startsWith(SettingsRoutes.IMAP) -> stringResource(R.string.settings_setup_sign_in_title, providerLabel(MailProviders.preset(route.removePrefix(SettingsRoutes.IMAP))))
    route == SettingsRoutes.PAIR -> stringResource(R.string.settings_pair_title)
    route == SettingsRoutes.IMPORT -> stringResource(R.string.settings_import_title)
    route == SettingsRoutes.RUKOO -> stringResource(R.string.settings_rukoo_title)
    route == SettingsRoutes.RUKOO_SIGNUP -> stringResource(R.string.settings_rukoo_sign_up)
    route == SettingsRoutes.RUKOO_SIGNIN -> stringResource(R.string.settings_rukoo_sign_in)
    route == SettingsRoutes.RUKOO_RECOVER -> stringResource(R.string.settings_rukoo_forgot)
    route == SettingsRoutes.RUKOO_PRIVACY -> stringResource(R.string.settings_rukoo_privacy)
    route == SettingsRoutes.CATEGORIES -> stringResource(R.string.settings_categories_title)
    else -> stringResource(R.string.settings_title_short)
}

/** The section list: Accounts, Agents (with phone tools), General (notifications, appearance, language), About. */
@Composable
private fun SettingsHome(app: AppViewModel, selected: String?, chevrons: Boolean, onOpen: (String) -> Unit) {
    val s = app.services
    val settings by s.settingsSnapshot.collectAsStateWithLifecycle()
    val accounts by s.mail.accounts.collectAsStateWithLifecycle()
    val agentSettings by s.agentSettings.settings.collectAsStateWithLifecycle()
    val agents by s.agents.agents.collectAsStateWithLifecycle()
    val mcp by s.mcp.status.collectAsStateWithLifecycle()

    val accountsSummary = when (accounts.size) {
        1 -> accounts.first().email
        else -> pluralStringResource(R.plurals.settings_accounts_count, accounts.size, accounts.size)
    }
    val default = agents.firstOrNull { it.id == agentSettings.defaultAgent }
    val agentsSummary = default?.let { stringResource(R.string.settings_agents_row_desc, it.name, stringResource(agentStateLabel(it.status.state))) }
    val phoneSummary = when {
        !settings.mcpEnabled -> stringResource(R.string.settings_off)
        mcp.running && mcp.address != null -> stringResource(R.string.settings_phone_tools_on_at, mcp.address!!)
        else -> stringResource(R.string.settings_on)
    }
    val notifySummary = when {
        settings.notifyMail && settings.notifyAgents -> stringResource(R.string.settings_notifications_both)
        settings.notifyMail -> stringResource(R.string.settings_notifications_mail)
        settings.notifyAgents -> stringResource(R.string.settings_notifications_agents)
        else -> stringResource(R.string.settings_off)
    }

    // Desktop's groups (Accounts, Agents, General, About) as separate cards: a title over a single row of the
    // same name would only repeat it.
    SettingsPageBody {
        Spacer(Modifier.height(12.dp))
        SettingsCard {
            HomeRow(SettingsRoutes.ACCOUNTS, stringResource(R.string.settings_groups_accounts), accountsSummary, RukooIcons.People, selected, chevrons, onOpen)
        }
        s.account?.let { account ->
            val status by account.status.collectAsStateWithLifecycle()
            // Desktop's Sync group: the Rukoo account.
            SectionTitle(stringResource(R.string.settings_groups_sync))
            SettingsCard {
                HomeRow(SettingsRoutes.RUKOO, stringResource(R.string.settings_rukoo_title), rukooAccountSummary(status), PanelIcons.Shield, selected, chevrons, onOpen)
            }
        }
        Spacer(Modifier.height(16.dp))
        SettingsCard {
            HomeRow(SettingsRoutes.AGENTS, stringResource(R.string.settings_agents_title), agentsSummary, RukooIcons.Sparkle, selected, chevrons, onOpen)
            HomeRow(SettingsRoutes.PHONE, stringResource(R.string.settings_phone_tools_title), phoneSummary, PanelIcons.Wrench, selected, chevrons, onOpen)
        }
        SectionTitle(stringResource(R.string.settings_groups_general))
        SettingsCard {
            HomeRow(SettingsRoutes.NOTIFICATIONS, stringResource(R.string.settings_general_notifications), notifySummary, RukooIcons.Bell, selected, chevrons, onOpen)
            HomeRow(SettingsRoutes.APPEARANCE, stringResource(R.string.settings_appearance_title), themeLabel(settings.theme), PanelIcons.Sliders, selected, chevrons, onOpen)
            HomeRow(SettingsRoutes.LANGUAGE, stringResource(R.string.settings_general_language), languageLabel(settings.language), PanelIcons.Globe, selected, chevrons, onOpen)
            s.categories?.let { cats ->
                val state by cats.state.collectAsStateWithLifecycle()
                HomeRow(
                    SettingsRoutes.CATEGORIES,
                    stringResource(R.string.settings_general_categories),
                    stringResource(if (state.enabled) R.string.settings_general_categories_on else R.string.settings_general_categories_off),
                    RukooIcons.Inbox,
                    selected,
                    chevrons,
                    onOpen,
                )
            }
        }
        Spacer(Modifier.height(16.dp))
        SettingsCard {
            HomeRow(SettingsRoutes.ABOUT, stringResource(R.string.settings_groups_about), stringResource(R.string.settings_about_version_value, BuildConfig.VERSION_NAME), RukooIcons.Info, selected, chevrons, onOpen)
        }
    }
}

@Composable
private fun HomeRow(route: String, title: String, summary: String?, icon: ImageVector, selected: String?, chevron: Boolean, onOpen: (String) -> Unit) {
    val on = route == selected
    SettingsRow(
        title = title,
        description = summary,
        modifier = Modifier.background(if (on) Rk.colors.sel else Color.Transparent),
        leading = { RowIcon(icon, if (on) Rk.colors.text else Rk.colors.text2) },
        trailing = if (chevron) ({ SettingsChevron() }) else null,
        onClick = { onOpen(route) },
    )
}

@Composable
fun themeLabel(theme: ThemeMode): String = stringResource(
    when (theme) {
        ThemeMode.SYSTEM -> R.string.settings_theme_system
        ThemeMode.LIGHT -> R.string.settings_theme_light
        ThemeMode.DARK -> R.string.settings_theme_dark
    },
)

@Composable
fun languageLabel(language: Language): String = when (language) {
    Language.SYSTEM -> stringResource(R.string.settings_language_system)
    Language.EN -> stringResource(R.string.settings_language_en)
    Language.NL -> stringResource(R.string.settings_language_nl)
}
