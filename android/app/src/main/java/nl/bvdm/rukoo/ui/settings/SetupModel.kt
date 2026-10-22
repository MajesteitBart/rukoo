package nl.bvdm.rukoo.ui.settings

import android.content.res.Resources
import androidx.compose.runtime.Composable
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import nl.bvdm.rukoo.AppServices
import nl.bvdm.rukoo.agents.PairedComputer
import nl.bvdm.rukoo.desktop.DesktopErrors
import nl.bvdm.rukoo.desktop.DesktopException
import nl.bvdm.rukoo.desktop.DesktopImport
import nl.bvdm.rukoo.desktop.HelloResponse
import nl.bvdm.rukoo.desktop.ImportResult
import nl.bvdm.rukoo.mail.model.Account
import nl.bvdm.rukoo.mail.model.GoogleClient
import nl.bvdm.rukoo.mail.model.ImapAccountInput

/**
 * Pairing with a computer, importing from it, and adding accounts, for onboarding and Settings alike. The
 * work runs here rather than in a screen: adding the first account closes the setup screen, and a language
 * from the import recreates the activity, and neither may cut the work short. Secrets pass through the
 * calls but are never kept in this state.
 */
class SetupModel(
    private val services: AppServices,
    /** The phone's own language code (`nl`), whatever the app shows: an import keeps System when they match. */
    private val systemLanguage: () -> String? = { runCatching { Resources.getSystem().configuration.locales[0]?.language }.getOrNull() },
) : ViewModel() {
    enum class PairStep { FORM, PAIRING, PAIRED, CHECKING, IMPORTING, DONE }

    data class PairUi(
        val step: PairStep = PairStep.FORM,
        /** What the user typed, for the error texts. */
        val address: String = "",
        val computer: PairedComputer? = null,
        /** The computer lets this phone fetch the accounts now. */
        val exportOpen: Boolean = false,
        val result: ImportResult? = null,
        val error: Throwable? = null,
    )

    /** One computer's `/hello`, or why it failed. */
    data class HelloUi(val loading: Boolean = false, val hello: HelloResponse? = null, val error: Throwable? = null)

    enum class AddKind { IMAP, GOOGLE, DEMO, CLIENT }

    data class AddUi(
        val working: AddKind? = null,
        val error: Throwable? = null,
        /** The account just added, for the toast; cleared by [consumeAdded]. */
        val added: Account? = null,
        val googleClient: GoogleClient? = null,
        val clientLoaded: Boolean = false,
        /** Set when a client file was taken, for its toast. */
        val clientImported: Boolean = false,
    )

    private val _pair = MutableStateFlow(PairUi())
    val pair: StateFlow<PairUi> = _pair.asStateFlow()

    private val _hellos = MutableStateFlow<Map<String, HelloUi>>(emptyMap())
    val hellos: StateFlow<Map<String, HelloUi>> = _hellos.asStateFlow()

    private val _add = MutableStateFlow(AddUi())
    val add: StateFlow<AddUi> = _add.asStateFlow()

    private var addJob: Job? = null

    // ---------- Settings navigation ----------

    private val _settingsStack = MutableStateFlow(emptyList<String>())

    /**
     * The open Settings pages, bottom first. Kept here rather than in the screen, which the root recreates
     * when the window crosses 600dp, so folding keeps the page.
     */
    val settingsStack: StateFlow<List<String>> = _settingsStack.asStateFlow()

    fun setSettingsStack(stack: List<String>) {
        _settingsStack.value = stack
    }

    /** Set when the first-run import moved on to Settings: its Done then leaves Settings for the inbox. */
    var importLeavesSettings: Boolean = false
        private set

    /**
     * The first account of a first-run import closes the setup screen before the import is done. The rest
     * of the import, and its summary with anything that didn't come over, then shows on Settings' import page.
     */
    fun continueImportInSettings() {
        importLeavesSettings = true
        _settingsStack.value = listOf(SettingsRoutes.IMPORT)
    }

    fun settingsClosed() {
        importLeavesSettings = false
        _settingsStack.value = emptyList()
        drafts.clear()
    }

    /**
     * Unfinished form fields by key ([rememberDraft]). The root recreates Settings when the window crosses
     * 600dp, so a field kept in the composition would be lost; kept here it survives. Passwords and keys
     * included: this is memory only, never the activity's saved Bundle.
     */
    internal val drafts = mutableMapOf<String, Any?>()

    fun clearDrafts(prefix: String) {
        drafts.keys.removeAll { it.startsWith(prefix) }
    }

    /**
     * Makes [base] (what a form starts from, as stored) the base of the drafts under [prefix]. When the stored
     * value changed since they were typed, they go: a key typed for one server must not show up for another.
     * Compared with equals, not a hash, so two configurations can't be mistaken for each other.
     */
    fun rebaseDrafts(prefix: String, base: Any) {
        val key = prefix + BASE
        if (drafts[key] != base) {
            clearDrafts(prefix)
            drafts[key] = base
        }
    }

    // ---------- pairing and import ----------

    // Each pairing step bumps this; an answer that arrives after the user moved on (back, another computer) is dropped.
    private var generation = 0L

    private fun next(ui: PairUi): Long {
        _pair.value = ui
        return ++generation
    }

    private fun settle(gen: Long, transform: (PairUi) -> PairUi) {
        if (gen == generation) _pair.update(transform)
    }

    private val importing: Boolean get() = _pair.value.step == PairStep.IMPORTING

    fun pair(address: String, code: String) {
        if (_pair.value.step == PairStep.PAIRING || importing) return
        val typed = address.trim()
        val gen = next(PairUi(step = PairStep.PAIRING, address = typed))
        viewModelScope.launch {
            // Not cancelled when the user leaves: a pairing the computer made is kept, even if nobody looks.
            try {
                val computer = services.desktop.pair(address, code)
                // Only this flow's fields: a newer pairing the user started meanwhile keeps its own.
                if (gen == generation) clearDrafts(DRAFT_PAIR)
                settle(gen) { PairUi(step = PairStep.PAIRED, address = typed, computer = computer, exportOpen = computer.exportUntil != null) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                settle(gen) { PairUi(step = PairStep.FORM, address = typed, error = e) }
            }
        }
    }

    /** Shows the import offer for a computer paired earlier (Settings' computer menu). */
    fun offerImport(computer: PairedComputer) {
        if (importing) return
        next(PairUi(step = PairStep.PAIRED, address = computer.address, computer = computer, exportOpen = computer.exportUntil != null))
        checkExport()
    }

    /** Asks the computer again whether it sends the accounts now (after the user chose "Send again" there). */
    fun checkExport() {
        val computer = _pair.value.computer ?: return
        if (importing) return
        val gen = next(_pair.value.copy(step = PairStep.CHECKING, error = null))
        viewModelScope.launch {
            try {
                val hello = services.desktop.hello(computer.pairingId)
                putHello(computer.pairingId, HelloUi(hello = hello))
                settle(gen) { it.copy(step = PairStep.PAIRED, exportOpen = hello.exportUntil != null) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                settle(gen) { it.copy(step = PairStep.PAIRED, error = e) }
            }
        }
    }

    fun importFrom() {
        val computer = _pair.value.computer ?: return
        if (importing) return
        val gen = next(_pair.value.copy(step = PairStep.IMPORTING, error = null))
        viewModelScope.launch {
            try {
                val bundle = services.desktop.export(computer.pairingId)
                val result = DesktopImport.apply(
                    bundle = bundle,
                    pairingId = computer.pairingId,
                    mail = services.mail,
                    agentStore = services.agentSettings,
                    settingsStore = services.settings,
                    systemLanguage = systemLanguage(),
                )
                // The agent cards start from what came over, also if the page isn't open now.
                clearDrafts(DRAFT_AGENT)
                settle(gen) { it.copy(step = PairStep.DONE, result = result, exportOpen = false) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                val closed = e is DesktopException && e.code == DesktopErrors.EXPORT_CLOSED
                settle(gen) { it.copy(step = PairStep.PAIRED, error = e, exportOpen = if (closed) false else it.exportOpen) }
            }
        }
    }

    /** Back to the empty form. An import that runs can't be left: it finishes and shows what came over. */
    fun resetPair() {
        if (importing) return
        clearDrafts(DRAFT_PAIR)
        next(PairUi())
    }

    // ---------- computers ----------

    fun refreshHello(pairingId: String) {
        if (_hellos.value[pairingId]?.loading == true) return
        putHello(pairingId, (_hellos.value[pairingId] ?: HelloUi()).copy(loading = true, error = null))
        viewModelScope.launch {
            val next = try {
                HelloUi(hello = services.desktop.hello(pairingId))
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                HelloUi(error = e)
            }
            putHello(pairingId, next)
        }
    }

    fun forget(pairingId: String, done: () -> Unit = {}) {
        viewModelScope.launch {
            runCatching { services.desktop.forget(pairingId) }
            _hellos.update { it - pairingId }
            done()
        }
    }

    private fun putHello(pairingId: String, hello: HelloUi) = _hellos.update { it + (pairingId to hello) }

    // ---------- accounts ----------

    // The account menu closes as soon as it is tapped, and its composition scope with it: its actions run here.

    fun syncAccount(id: String) {
        viewModelScope.launch { runCatching { services.mail.refresh(id) } }
    }

    fun setDefaultAccount(id: String) {
        viewModelScope.launch { services.settings.update { it.copy(defaultAccountId = id) } }
    }

    /** Removes an account; [done] gets the failure, or null. */
    fun removeAccount(id: String, done: (Throwable?) -> Unit) {
        viewModelScope.launch {
            val failure = try {
                services.mail.removeAccount(id)
                if (services.settingsSnapshot.value.defaultAccountId == id) services.settings.update { it.copy(defaultAccountId = null) }
                null
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                e
            }
            done(failure)
        }
    }

    fun loadGoogleClient() {
        viewModelScope.launch {
            val client = runCatching { services.mail.googleClient() }.getOrNull()
            _add.update { it.copy(googleClient = client, clientLoaded = true) }
        }
    }

    fun addImap(input: ImapAccountInput) = runAdd(AddKind.IMAP) { services.mail.addImapAccount(input) }

    fun addDemo() = runAdd(AddKind.DEMO) { services.mail.addDemoAccount() }

    /** Google sign-in; [openUrl] opens the consent page. [reauthAccountId] signs an existing account in again. */
    fun signInWithGoogle(openUrl: (String) -> Unit, reauthAccountId: String? = null) =
        runAdd(AddKind.GOOGLE) { services.mail.signInWithGoogle(openUrl, reauthAccountId) }

    /** Takes the client from a Google client file the user picked. */
    fun importClientFile(text: String) {
        if (_add.value.working != null) return
        _add.update { it.copy(working = AddKind.CLIENT, error = null) }
        addJob = viewModelScope.launch {
            try {
                val client = GoogleClientFile.parse(text) ?: throw GoogleClientFile.Invalid()
                services.mail.setGoogleClient(client)
                _add.update { it.copy(working = null, googleClient = client, clientLoaded = true, clientImported = true) }
            } catch (e: CancellationException) {
                _add.update { it.copy(working = null) }
                throw e
            } catch (e: Exception) {
                _add.update { it.copy(working = null, error = e) }
            }
        }
    }

    /** Stops a Google sign-in that is waiting for the browser. */
    fun cancelAdd() {
        addJob?.cancel()
    }

    fun clearAddError() = _add.update { it.copy(error = null) }

    fun consumeAdded() = _add.update { it.copy(added = null, clientImported = false) }

    private fun runAdd(kind: AddKind, block: suspend () -> Account) {
        if (_add.value.working != null) return
        _add.update { it.copy(working = kind, error = null) }
        addJob = viewModelScope.launch {
            try {
                val account = block()
                clearDrafts(DRAFT_IMAP)
                _add.update { it.copy(working = null, added = account) }
            } catch (e: CancellationException) {
                _add.update { it.copy(working = null) }
                throw e
            } catch (e: Exception) {
                _add.update { it.copy(working = null, error = e) }
            }
        }
    }

    companion object {
        /** Draft key prefixes: a form's drafts go once it succeeded. */
        const val DRAFT_IMAP = "imap:"
        const val DRAFT_PAIR = "pair:"
        const val DRAFT_AGENT = "agent:"
        private const val BASE = "\u0000base"
    }
}

/**
 * A form field kept in [SetupModel.drafts] while it is edited, so it outlives the composition (see
 * [SetupModel.drafts]). [key] names the field; [base] is the stored value the form starts from (see
 * [SetupModel.rebaseDrafts]): a new base starts the field again from [initial].
 */
@Composable
fun <T> rememberDraft(model: SetupModel, key: String, base: Any? = null, initial: () -> T): MutableState<T> =
    remember(model, key, base) { DraftState(model.drafts, key, initial) }

private class DraftState<T>(private val drafts: MutableMap<String, Any?>, private val key: String, initial: () -> T) : MutableState<T> {
    @Suppress("UNCHECKED_CAST")
    private val state = mutableStateOf(if (key in drafts) drafts[key] as T else initial())

    override var value: T
        get() = state.value
        set(v) {
            state.value = v
            drafts[key] = v
        }

    override fun component1(): T = value

    override fun component2(): (T) -> Unit = { value = it }
}
