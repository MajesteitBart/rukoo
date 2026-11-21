package nl.bvdm.rukoo.ui.settings

import android.content.ContentResolver
import android.net.Uri
import androidx.annotation.StringRes
import androidx.compose.runtime.mutableStateMapOf
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import nl.bvdm.rukoo.AppServices
import nl.bvdm.rukoo.BuildConfig
import nl.bvdm.rukoo.R
import nl.bvdm.rukoo.account.AccountDetails
import nl.bvdm.rukoo.account.AccountError
import nl.bvdm.rukoo.account.AccountService
import nl.bvdm.rukoo.account.ServerInfo
import nl.bvdm.rukoo.core.AppLog
import nl.bvdm.rukoo.workspaces.InviteLink
import nl.bvdm.rukoo.workspaces.Workspaces

/**
 * Settings > Rukoo account's work, a port of desktop's src/renderer/rukoo-account.js. It runs here rather than in a
 * page, so folding or leaving the page doesn't cut a sign-up short. The forms' fields live here too, outside any
 * Bundle, so a password is never saved with the activity's state.
 */
class RukooAccountModel(services: AppServices, private val devHosts: Boolean = BuildConfig.DEBUG) : ViewModel() {
    val account: AccountService? = services.account
    private val workspaces: Workspaces? = services.workspaces

    data class Ui(
        val info: ServerInfo? = null,
        val infoFailed: Boolean = false,
        val details: AccountDetails? = null,
        val detailsFailed: Boolean = false,
        /** A form or an action is on its way. */
        val working: Boolean = false,
        /** The form's error: an [AccountError] code, or one of the form's own checks as a string resource. */
        val formError: FormError? = null,
        /** The recovery key, shown once after a sign-up or a new key. */
        val recoveryKey: String? = null,
        /**
         * The last sign-up used a workspace invitation link (contract §3.3): once its recovery key is saved, Settings
         * closes back to Chat, which opens the Join sheet with the link. A sign-in with a carried link does the same.
         */
        val joinWithLink: Boolean = false,
    )

    sealed interface FormError {
        data class Code(val code: String) : FormError

        data class Text(@StringRes val res: Int) : FormError

        /** An invitation link for a workspace on another server, named by [host]. */
        data class OtherServer(val host: String) : FormError
    }

    /** What the sign-up form's invite field holds (contract §3.3). */
    sealed interface InviteInput {
        /** The operator's invite code, or nothing. */
        data class Code(val code: String) : InviteInput

        /** A workspace invitation link for the configured server, which goes as `workspaceInvite`. */
        data class Link(val link: InviteLink) : InviteInput

        /** A workspace invitation link for another server: refused here, so its secret never leaves the phone. */
        data class OtherServer(val host: String) : InviteInput
    }

    private val _ui = MutableStateFlow(Ui())
    val ui: StateFlow<Ui> = _ui.asStateFlow()

    /** What was typed in the forms, by field. Cleared once a form went through. */
    val fields = mutableStateMapOf<String, String>()

    private var filled: Pair<String, Long>? = null

    init {
        val acc = account
        if (acc != null) {
            // Signing in or out shows another account's devices: what was loaded is dropped.
            viewModelScope.launch {
                acc.status.map { it.signedIn }.distinctUntilChanged().collect {
                    _ui.update { u -> u.copy(details = null, detailsFailed = false) }
                    filled = null
                }
            }
        }
    }

    /**
     * After a page is shown: what needs the server, once per visit, not on every redraw (desktop's fill). Forms get
     * the server's info only, for invite-only and closed servers.
     */
    fun fill(page: String, force: Boolean = false) {
        val acc = account ?: return
        val now = System.currentTimeMillis()
        val last = filled
        if (!force && last != null && last.first == page && now - last.second < FILL_AGAIN_AFTER) return
        filled = page to now
        viewModelScope.launch {
            if (acc.server.isNotEmpty()) {
                try {
                    val info = acc.serverInfo()
                    _ui.update { it.copy(info = info, infoFailed = false) }
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    _ui.update { it.copy(infoFailed = true) }
                }
            }
            if (acc.signedIn && (page == SettingsRoutes.RUKOO || page == SettingsRoutes.RUKOO_PRIVACY)) {
                try {
                    val details = acc.details()
                    _ui.update { it.copy(details = details, detailsFailed = false) }
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    _ui.update { it.copy(detailsFailed = true) }
                }
            }
        }
    }

    /** After an action, what the page shows comes again from the server: a removed device leaves the list at once. */
    private fun refill() {
        val page = filled?.first
        filled = null
        if (page != null) fill(page, force = true)
    }

    fun clearFormError() = _ui.update { it.copy(formError = null) }

    fun recoveryKeyShown() = _ui.update { it.copy(recoveryKey = null) }

    /** Chat took over after a sign-up with an invitation link. */
    fun joinShown() = _ui.update { it.copy(joinWithLink = false) }

    /** The addresses that count as the configured server for invitation links (InviteLink.sameServers). */
    private fun linkServers(acc: AccountService): List<String> =
        InviteLink.sameServers(acc.server, InviteLink.homeOf(acc.status.value.info?.workspace?.home?.origin))

    enum class Form { SIGN_UP, SIGN_IN, RECOVER }

    /**
     * A form's submit (desktop's submit): its own checks first, then the account; [done] gets the toast to show.
     * [carriedLink]: the invitation link onboarding's team chat step checked before this form (RUK-234). A sign-up uses
     * it as the invitation where the invite field is empty, and both sign-up and sign-in leave it as the pending join.
     */
    fun submit(form: Form, carriedLink: InviteLink? = null, done: (Int) -> Unit) {
        val acc = account ?: return
        if (_ui.value.working) return
        val f = fields.toMap()
        val email = f["email"].orEmpty()
        val password = f["password"].orEmpty()
        fun stop(error: FormError) = _ui.update { it.copy(formError = error) }
        if (form != Form.SIGN_IN) {
            if (password.codePointCount(0, password.length) < AccountService.MIN_PASSWORD) return stop(FormError.Code("weak_password"))
            if (password != f["repeat"].orEmpty()) return stop(FormError.Text(R.string.settings_rukoo_mismatch))
        }
        if (form == Form.SIGN_UP && f["understand"] != "on") return stop(FormError.Text(R.string.settings_rukoo_need_understand))
        val servers = linkServers(acc)
        val invite = if (form == Form.SIGN_UP) inviteInput(f["invite"].orEmpty(), servers, devHosts) else null
        if (invite is InviteInput.OtherServer) return stop(FormError.OtherServer(invite.host))
        val carried = carriedLink?.takeIf { it.server in servers && form != Form.RECOVER }
        _ui.update { it.copy(working = true, formError = null) }
        viewModelScope.launch {
            try {
                when (form) {
                    Form.SIGN_UP -> {
                        val res = when {
                            invite is InviteInput.Link -> acc.signUp(email, password, workspaceInvite = invite.link)
                            // The link onboarding carried stands in for an empty invite field.
                            invite is InviteInput.Code && invite.code.isBlank() && carried != null -> acc.signUp(email, password, workspaceInvite = carried)
                            invite is InviteInput.Code -> acc.signUp(email, password, invite.code)
                            else -> acc.signUp(email, password, "")
                        }
                        // Chat opens the Join sheet with the link next time it shows, also after a restart (§3.3).
                        val link = (invite as? InviteInput.Link)?.link ?: carried
                        if (link != null) workspaces?.rememberJoin(link)
                        _ui.update { it.copy(recoveryKey = res.recoveryKey, joinWithLink = link != null) }
                    }
                    Form.SIGN_IN -> {
                        acc.signIn(email, password)
                        if (carried != null) {
                            workspaces?.rememberJoin(carried)
                            _ui.update { it.copy(joinWithLink = true) }
                        }
                    }
                    Form.RECOVER -> acc.recover(email, f["recoveryKey"].orEmpty(), password)
                }
                fields.clear()
                refill()
                done(if (form == Form.SIGN_UP) R.string.settings_rukoo_welcome else R.string.settings_rukoo_signed_in)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                AppLog.w(TAG, "the account form failed", e)
                stop(FormError.Code((e as? AccountError)?.code ?: "server"))
            } finally {
                _ui.update { it.copy(working = false) }
            }
        }
    }

    /**
     * An action of the signed-in page: [work], then the toast [doneText] or the error's code for [failed]. Whatever
     * happens, the page loads what it shows again (desktop's run).
     */
    fun <T> run(work: suspend (AccountService) -> T, failed: (String) -> Unit, done: (T) -> Unit = {}) {
        val acc = account ?: return
        _ui.update { it.copy(working = true) }
        viewModelScope.launch {
            try {
                done(work(acc))
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                AppLog.w(TAG, "an account action failed", e)
                failed((e as? AccountError)?.code ?: "server")
            } finally {
                _ui.update { it.copy(working = false) }
                refill()
            }
        }
    }

    fun setServer(url: String, failed: (String) -> Unit, done: () -> Unit) {
        _ui.update { it.copy(info = null, infoFailed = false) }
        run({ it.setServer(url.trim()) }, failed) { done() }
    }

    fun newRecoveryKey(password: String, failed: (String) -> Unit) =
        run({ it.newRecoveryKey(password) }, failed) { key -> _ui.update { u -> u.copy(recoveryKey = key) } }

    /** Writes "Export my data" into the file the system's picker made; false when it couldn't. */
    @OptIn(ExperimentalSerializationApi::class)
    fun export(resolver: ContentResolver, uri: Uri, done: (Boolean) -> Unit) {
        val acc = account ?: return
        viewModelScope.launch {
            val ok = withContext(Dispatchers.IO) {
                runCatching {
                    val text = PRETTY.encodeToString(JsonObject.serializer(), acc.exportData())
                    resolver.openOutputStream(uri, "wt")!!.use { it.write(text.toByteArray(Charsets.UTF_8)) }
                }.isSuccess
            }
            done(ok)
        }
    }

    companion object {
        private const val FILL_AGAIN_AFTER = 15_000L
        private const val TAG = "RukooAccount"

        /**
         * What [text] in the invite field is (contract §3.2, §3.3): a workspace invitation link for [server], the
         * configured credential URL, goes as `workspaceInvite`; a link for another server is refused; anything else is
         * the operator's invite code, as typed.
         */
        fun inviteInput(text: String, server: String, devHosts: Boolean): InviteInput = inviteInput(text, listOf(server), devHosts)

        /** [inviteInput] against every address that counts as the configured server (InviteLink.sameServers). */
        fun inviteInput(text: String, servers: List<String>, devHosts: Boolean): InviteInput {
            val link = InviteLink.parse(text, devHosts) ?: return InviteInput.Code(text)
            return if (link.server in servers) InviteInput.Link(link) else InviteInput.OtherServer(hostOf(link.server))
        }

        // JSON.stringify(data, null, 2), as desktop writes the export.
        @OptIn(ExperimentalSerializationApi::class)
        private val PRETTY = Json {
            prettyPrint = true
            prettyPrintIndent = "  "
        }
    }
}
