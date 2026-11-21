package nl.bvdm.rukoo.ui.onboarding

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import kotlinx.coroutines.launch
import nl.bvdm.rukoo.BuildConfig
import nl.bvdm.rukoo.R
import nl.bvdm.rukoo.mail.model.MailProviders
import nl.bvdm.rukoo.settings.Language
import nl.bvdm.rukoo.ui.components.RkChipButton
import nl.bvdm.rukoo.ui.components.RkIconButton
import nl.bvdm.rukoo.ui.components.RkLinkButton
import nl.bvdm.rukoo.ui.components.RkStatus
import nl.bvdm.rukoo.ui.components.SettingsCard
import nl.bvdm.rukoo.ui.components.SettingsChevron
import nl.bvdm.rukoo.ui.components.Spinner
import nl.bvdm.rukoo.ui.components.rkClickable
import nl.bvdm.rukoo.ui.components.settingsDividerInset
import nl.bvdm.rukoo.ui.components.StatusPill
import nl.bvdm.rukoo.ui.icons.PanelIcons
import nl.bvdm.rukoo.ui.icons.RukooIcons
import nl.bvdm.rukoo.ui.root.AppMode
import nl.bvdm.rukoo.ui.root.AppViewModel
import nl.bvdm.rukoo.ui.chat.ChatIcons
import nl.bvdm.rukoo.ui.components.RkButton
import nl.bvdm.rukoo.ui.components.RkButtonKind
import nl.bvdm.rukoo.ui.components.RkTextField
import nl.bvdm.rukoo.ui.settings.SettingsRoutes
import nl.bvdm.rukoo.ui.settings.hostOf
import nl.bvdm.rukoo.workspaces.InviteLink
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.text.input.KeyboardType
import nl.bvdm.rukoo.ui.settings.Choice
import nl.bvdm.rukoo.ui.settings.ChoiceSheet
import nl.bvdm.rukoo.ui.settings.ErrorLine
import nl.bvdm.rukoo.ui.settings.GoogleSetup
import nl.bvdm.rukoo.ui.settings.ImapAccountForm
import nl.bvdm.rukoo.ui.settings.NoteBox
import nl.bvdm.rukoo.ui.settings.NoteTone
import nl.bvdm.rukoo.ui.settings.NotificationPermission
import nl.bvdm.rukoo.ui.settings.PairComputerFlow
import nl.bvdm.rukoo.ui.settings.ProviderGrid
import nl.bvdm.rukoo.ui.settings.RowIcon
import nl.bvdm.rukoo.ui.settings.SetupModel
import nl.bvdm.rukoo.ui.settings.errorText
import nl.bvdm.rukoo.ui.settings.languageLabel
import nl.bvdm.rukoo.ui.settings.providerLabel
import nl.bvdm.rukoo.ui.theme.Rk
import nl.bvdm.rukoo.ui.theme.medium

private const val HOME = "home"
private const val PAIR = "pair"
private const val ADD = "add"
private const val GOOGLE = "google"
private const val IMAP = "imap:"
private const val CHAT = AppViewModel.ONBOARDING_CHAT

/** One step up in the setup flow. */
private fun parent(step: String): String = when {
    step == "${IMAP}google" -> GOOGLE
    step == GOOGLE || step.startsWith(IMAP) -> ADD
    else -> HOME
}

/**
 * First run, while there is no account (desktop's 01-setup, for a phone). The recommended way in is
 * pairing with Rukoo on the computer and bringing its accounts and agents over; an account can also be added
 * here, or the demo tried. The inbox opens by itself once an account exists.
 */
@Composable
fun OnboardingScreen(app: AppViewModel, modifier: Modifier = Modifier) {
    val model: SetupModel = viewModel { SetupModel(app.services) }
    // Chat's Join with an invitation link opens straight on the team chat step.
    var step by rememberSaveable { mutableStateOf(app.takeOnboardingStart() ?: HOME) }
    val context = LocalContext.current
    DisposableEffect(Unit) {
        onDispose {
            // Adding the first account closes this screen; Settings, which shares the model, mustn't announce it later.
            model.consumeAdded()
            // The first imported account opened the inbox while the import still runs: it finishes on Settings'
            // import page, whose summary says what didn't come over. Done there goes on to the inbox.
            val step = model.pair.value.step
            val importing = step == SetupModel.PairStep.IMPORTING || step == SetupModel.PairStep.DONE
            val finished = app.services.mail.accounts.value.isNotEmpty()
            // Setup is over: what was typed into its forms (a pairing code, a password) goes with it.
            if (finished) {
                model.clearDrafts(SetupModel.DRAFT_PAIR)
                model.clearDrafts(SetupModel.DRAFT_IMAP)
                // New mail starts to arrive now, which is when the user can tell why Rukoo asks to notify.
                val settings = app.services.settingsSnapshot.value
                NotificationPermission.ask(context, wanted = settings.notifyMail || settings.notifyAgents)
            }
            if (importing && finished) {
                model.continueImportInSettings()
                app.openSettings()
            }
        }
    }
    BackHandler(enabled = step != HOME) {
        if (step == PAIR) model.resetPair()
        step = parent(step)
    }

    BoxWithConstraints(modifier.fillMaxSize().background(Rk.colors.bg)) {
        val height = maxHeight
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()), horizontalAlignment = Alignment.CenterHorizontally) {
            Column(
                Modifier.widthIn(max = 480.dp).fillMaxWidth().heightIn(min = height).padding(horizontal = 24.dp, vertical = 16.dp),
                verticalArrangement = Arrangement.Center,
            ) {
                TopRow(app, back = if (step == HOME) null else ({
                    if (step == PAIR) model.resetPair()
                    step = parent(step)
                }))
                Spacer(Modifier.height(24.dp))
                Brand()
                Spacer(Modifier.height(20.dp))
                Text(stepTitle(step), style = Rk.type.setupTitle, color = Rk.colors.text)
                Spacer(Modifier.height(20.dp))
                val motion = Rk.motion
                AnimatedContent(
                    targetState = step,
                    transitionSpec = { fadeIn(motion.tween(160)) togetherWith fadeOut(motion.tween(100)) },
                    label = "setup step",
                ) { current ->
                    Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
                        when {
                            current == HOME -> Home(app, model, onPair = { step = PAIR }, onAdd = { step = ADD }, onChat = { step = CHAT })
                            current == CHAT -> ChatStep(app)
                            current == PAIR -> PairComputerFlow(
                                model,
                                onDone = {
                                    model.resetPair()
                                    step = HOME
                                },
                                onAddAccount = {
                                    model.resetPair()
                                    step = ADD
                                },
                            )
                            current == ADD -> AddStep(model, onPick = { id -> step = if (id == "google") GOOGLE else IMAP + id })
                            current == GOOGLE -> GoogleSetup(model, onPassword = { step = "${IMAP}google" }, onPair = { step = PAIR })
                            current.startsWith(IMAP) -> ImapAccountForm(current.removePrefix(IMAP), model)
                        }
                    }
                }
                Spacer(Modifier.height(32.dp))
            }
        }
    }
}

@Composable
private fun stepTitle(step: String): String = when {
    step == PAIR -> stringResource(R.string.onboarding_pair_title)
    step == CHAT -> stringResource(R.string.onboarding_chat)
    step == ADD -> stringResource(R.string.settings_accounts_add)
    step == GOOGLE -> stringResource(R.string.settings_setup_google_title)
    step.startsWith(IMAP) -> stringResource(R.string.settings_setup_sign_in_title, providerLabel(MailProviders.preset(step.removePrefix(IMAP))))
    else -> stringResource(R.string.settings_setup_title)
}

/** Back on the left (in a sub-step), the language on the right, as desktop's setup offers it. */
@Composable
private fun TopRow(app: AppViewModel, back: (() -> Unit)?) {
    val s = app.services
    val scope = rememberCoroutineScope()
    val settings by s.settingsSnapshot.collectAsStateWithLifecycle()
    var sheet by remember { mutableStateOf(false) }
    Row(Modifier.fillMaxWidth().heightIn(min = 48.dp), verticalAlignment = Alignment.CenterVertically) {
        if (back != null) {
            RkIconButton(RukooIcons.Back, stringResource(R.string.common_actions_back), onClick = back, modifier = Modifier.offset(x = (-12).dp))
        }
        Spacer(Modifier.weight(1f))
        Text(stringResource(R.string.settings_general_language), style = Rk.type.text13, color = Rk.colors.text2)
        Spacer(Modifier.size(8.dp))
        RkChipButton(languageLabel(settings.language), { sheet = true }, icon = PanelIcons.Globe)
    }
    if (sheet) {
        ChoiceSheet(
            title = stringResource(R.string.settings_general_language),
            choices = listOf(Language.SYSTEM, Language.EN, Language.NL).map { Choice(it, languageLabel(it)) },
            selected = settings.language,
            onSelect = { language -> scope.launch { s.settings.update { it.copy(language = language) } } },
            onDismiss = { sheet = false },
        )
    }
}

/** Rukoo's pigeon and name, as on the desktop setup screen. */
@Composable
private fun Brand() {
    Row(verticalAlignment = Alignment.CenterVertically) {
        // The launcher's foreground: the pigeon sits in the middle of a 108dp canvas, so it is drawn larger
        // than it shows and pulled in.
        Image(painterResource(R.drawable.ic_launcher_foreground), null, Modifier.size(76.dp).offset(x = (-18).dp))
        Text("rukoo", Modifier.offset(x = (-28).dp), style = Rk.type.text26.copy(fontWeight = Rk.type.setupTitle.fontWeight), color = Rk.colors.text)
    }
}

@Composable
private fun Home(app: AppViewModel, model: SetupModel, onPair: () -> Unit, onAdd: () -> Unit, onChat: () -> Unit) {
    val agentSettings by app.services.agentSettings.settings.collectAsStateWithLifecycle()
    val add by model.add.collectAsStateWithLifecycle()
    val chat by app.chatState.collectAsStateWithLifecycle()
    val paired = agentSettings.computers.maxByOrNull { it.pairedAt }
    if (paired != null) NoteBox(stringResource(R.string.onboarding_paired_note, paired.name), tone = NoteTone.OK)
    SettingsCard {
        Option(
            title = if (paired == null) stringResource(R.string.onboarding_connect) else stringResource(R.string.onboarding_import_from, paired.name),
            description = stringResource(R.string.onboarding_connect_help),
            icon = PanelIcons.Terminal,
            recommended = true,
            onClick = {
                if (paired != null) model.offerImport(paired) else model.resetPair()
                onPair()
            },
        )
        Option(
            title = stringResource(R.string.settings_accounts_add),
            description = stringResource(R.string.onboarding_add_help),
            icon = RukooIcons.Inbox,
            recommended = false,
            onClick = onAdd,
        )
        // Team chat without a mail account (RUK-234), on a server that has it: a link and a Rukoo account are enough.
        if (chat.available) {
            Option(
                title = stringResource(if (chat.signedIn) R.string.onboarding_chat_open else R.string.onboarding_chat),
                description = if (chat.signedIn) stringResource(R.string.onboarding_chat_open_help, chat.host) else stringResource(R.string.onboarding_chat_help),
                icon = ChatIcons.Bubble,
                recommended = false,
                onClick = { if (chat.signedIn) app.setMode(AppMode.CHAT) else onChat() },
            )
        }
    }
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
        if (add.working == SetupModel.AddKind.DEMO) Spinner(size = 14.dp, modifier = Modifier.padding(end = 8.dp))
        RkLinkButton(stringResource(R.string.onboarding_demo), model::addDemo, enabled = add.working == null)
    }
    add.error?.takeIf { add.working == null }?.let { ErrorLine(errorText(it)) }
}

/**
 * Team chat's first step (RUK-234): the invitation link a colleague sent, checked here, then Settings' account form
 * (new or existing) carries it. After it Chat opens with the Join sheet, also after a restart.
 */
@Composable
private fun ChatStep(app: AppViewModel) {
    val chat by app.chatState.collectAsStateWithLifecycle()
    var text by rememberSaveable { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    val badLink = stringResource(R.string.chat_join_bad_link)
    val otherServer = stringResource(R.string.onboarding_chat_other_server)
    // A link for this server, or null with the reason in error.
    fun checked(): InviteLink? {
        val link = InviteLink.parse(text.trim(), BuildConfig.DEBUG)
        error = when {
            link == null -> badLink
            link.server !in chat.linkServers.ifEmpty { listOf(chat.server) } -> otherServer.format(hostOf(link.server), chat.host)
            else -> null
        }
        return link?.takeIf { error == null }
    }
    // Without a link the form opens plain; a link is checked first and carried to it.
    fun go(page: String) {
        if (text.isBlank()) return app.openAccountWithLink(page, null)
        checked()?.let { app.openAccountWithLink(page, it) }
    }
    Text(stringResource(R.string.onboarding_chat_link_help), style = Rk.type.text13, color = Rk.colors.text2)
    RkTextField(
        value = text,
        onValueChange = {
            text = it
            error = null
        },
        label = stringResource(R.string.chat_join_link),
        placeholder = "https://…/join#w=…",
        error = error,
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, autoCorrectEnabled = false),
    )
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End), verticalAlignment = Alignment.CenterVertically) {
        RkButton(stringResource(R.string.onboarding_chat_have_account), { go(SettingsRoutes.RUKOO_SIGNIN) }, kind = RkButtonKind.SECONDARY)
        RkButton(stringResource(R.string.chat_empty_sign_up_action), { go(SettingsRoutes.RUKOO_SIGNUP) }, kind = RkButtonKind.PRIMARY)
    }
}

/**
 * A way in: the settings row's look, with the "Recommended" pill under the title, where it leaves the text
 * the width of a 411dp cover screen.
 */
@Composable
private fun Option(title: String, description: String, icon: ImageVector, recommended: Boolean, onClick: () -> Unit) {
    val c = Rk.colors
    Row(
        Modifier
            .fillMaxWidth()
            .settingsDividerInset(66.dp)
            .rkClickable(RectangleShape, onClick = onClick)
            .heightIn(min = 56.dp)
            .padding(horizontal = 16.dp, vertical = 14.dp),
        horizontalArrangement = Arrangement.spacedBy(14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(36.dp).background(c.chip, Rk.shapes.control), contentAlignment = Alignment.Center) {
            RowIcon(icon, c.text)
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(title, style = Rk.type.text13_5.medium, color = c.text)
            if (recommended) StatusPill(stringResource(R.string.onboarding_recommended), RkStatus.PROPOSED)
            Text(description, style = Rk.type.text12_5, color = c.text2)
        }
        SettingsChevron()
    }
}

@Composable
private fun AddStep(model: SetupModel, onPick: (String) -> Unit) {
    val add by model.add.collectAsStateWithLifecycle()
    ProviderGrid(onPick = onPick)
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
        if (add.working == SetupModel.AddKind.DEMO) Spinner(size = 14.dp, modifier = Modifier.padding(end = 8.dp))
        RkLinkButton(stringResource(R.string.settings_setup_demo_action), model::addDemo, enabled = add.working == null)
    }
}
