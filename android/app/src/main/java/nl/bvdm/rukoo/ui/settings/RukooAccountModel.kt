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
import nl.bvdm.rukoo.account.AccountKeys
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
        /** The code step of a form (desktop's email-code.js): a code was emailed, and the form asks for it. */
        val code: CodeStep? = null,
        /** When Send a new code works again (System.currentTimeMillis), after the server's minute between two codes. */
        val resendAt: Long = 0,
    )

    /**
     * A code emailed for [form] to [email]: `signup` for a sign-up on a server that checks addresses, `unlock` for a
     * sign-in or recovery of a locked account. [resent]: Send a new code went through. [inviteFailed]: the server
     * turned down the typed invite code, so the code goes in its place. [notSent]: the server's limit held a new code
     * back, and the step is there for the long code of an earlier email.
     */
    data class CodeStep(val form: Form, val email: String, val resent: Boolean = false, val inviteFailed: Boolean = false, val notSent: Boolean = false)

    sealed interface FormError {
        /** An [AccountError] code; [attemptsLeft] for six digits that didn't match (`code_wrong`). */
        data class Code(val code: String, val attemptsLeft: Int? = null) : FormError

        data class Text(@StringRes val res: Int) : FormError

        /** An invitation link for a workspace on another server, named by [host]. */
        data class OtherServer(val host: String) : FormError

        /** Too many wrong passwords locked the account; the server sends codes to get past the lock (Email me a code). */
        data object Locked : FormError

        /** The server sends a new code only after [seconds]. */
        data class Wait(val seconds: Long) : FormError
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

    /** A form page opened: a code step of another form goes, with what was typed in it. */
    fun opened(form: Form) {
        if (_ui.value.code?.form != form) {
            codeRequests += 1
            fields.remove("emailCode")
            _ui.update { it.copy(code = null) }
        }
    }

    /** The address field changed: a code sent to another address goes, so the next submit sends one to this one. */
    fun emailChanged(value: String) {
        val step = _ui.value.code ?: return
        if (AccountKeys.normalizeEmail(value) != step.email) {
            codeRequests += 1
            fields.remove("emailCode")
            _ui.update { it.copy(code = null) }
        }
    }

    /**
     * Asks the server to email a code for [form] to the address in the form, in [lang], and shows the code step. A
     * refusal shows in the error line: the wait for a new code, or what went wrong. [inviteFailed]: sent because the
     * server turned down the invite code.
     */
    fun sendCode(form: Form, lang: String, inviteFailed: Boolean = false) {
        val acc = account ?: return
        val email = fields["email"].orEmpty()
        val address = AccountKeys.normalizeEmail(email)
        val purpose = if (form == Form.SIGN_UP) "signup" else "unlock"
        val asked = ++codeRequests
        // An answer that comes after the address changed, or after a newer request, changes nothing.
        fun current() = asked == codeRequests && AccountKeys.normalizeEmail(fields["email"].orEmpty()) == address
        _ui.update { it.copy(working = true, formError = null) }
        viewModelScope.launch {
            try {
                val sent = acc.requestCode(email, purpose, lang)
                if (!current()) return@launch
                val was = _ui.value.code
                val again = was != null && was.form == form && was.email == sent.email
                _ui.update {
                    it.copy(
                        code = CodeStep(form, sent.email, resent = again, inviteFailed = inviteFailed && !again),
                        resendAt = System.currentTimeMillis() + CODE_GAP * 1000,
                    )
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                AppLog.w(TAG, "a code by email was not sent", e)
                if (!current()) return@launch
                val err = e as? AccountError
                if (err?.code == "rate_limited") {
                    // The step shows anyway, or stays: the long code of an email sent before works on any device, also
                    // of one a stranger asked for to use up the address's codes (server/PROTOCOL.md, POST /v1/email-code).
                    val wait = err.retryAfter ?: CODE_GAP
                    _ui.update {
                        val step = it.code?.takeIf { s -> s.form == form && s.email == address } ?: CodeStep(form, address, notSent = true)
                        it.copy(code = step, formError = FormError.Wait(wait), resendAt = System.currentTimeMillis() + wait * 1000)
                    }
                } else {
                    _ui.update { it.copy(formError = FormError.Code(err?.code ?: "server")) }
                }
            } finally {
                _ui.update { it.copy(working = false) }
            }
        }
    }

    // Goes up with each request for a code, so only the answer to the newest counts (sendCode).
    private var codeRequests = 0

    fun recoveryKeyShown() = _ui.update { it.copy(recoveryKey = null) }

    /** Chat took over after a sign-up with an invitation link. */
    fun joinShown() = _ui.update { it.copy(joinWithLink = false) }

    /** The addresses that count as the configured server for invitation links (InviteLink.sameServers). */
    private fun linkServers(acc: AccountService): List<String> = InviteLink.sameServers(acc.server)

    enum class Form { SIGN_UP, SIGN_IN, RECOVER }

    /**
     * A form's submit (desktop's submit): its own checks first, then the account; [done] gets the toast to show.
     * [carriedLink]: the invitation link onboarding's team chat step checked before this form (RUK-234). A sign-up uses
     * it as the invitation where the invite field is empty, and both sign-up and sign-in leave it as the pending join.
     *
     * The code step (desktop's email-code.js submit): a sign-up the server answers with `code_required` gets a code by
     * email and waits for it; a sign-in or recovery of a locked account offers one ([FormError.Locked]) where the server
     * sends codes. While the step shows, its field goes with the request. [lang]: the language a code's email is in.
     */
    fun submit(form: Form, carriedLink: InviteLink? = null, lang: String = "en", done: (Int) -> Unit) {
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
        val shown = _ui.value.code?.takeIf { it.form == form }
        val emailCode = if (shown != null) f["emailCode"].orEmpty().trim() else ""
        // The operator's invite code needs no emailed code, so an empty code field doesn't stop it.
        val invited = invite is InviteInput.Code && invite.code.isNotBlank()
        if (shown != null && emailCode.isEmpty() && !invited) return stop(FormError.Text(R.string.settings_rukoo_code_missing))
        _ui.update { it.copy(working = true, formError = null) }
        viewModelScope.launch {
            var codeNext: Boolean? = null
            try {
                when (form) {
                    Form.SIGN_UP -> {
                        val res = when {
                            invite is InviteInput.Link -> acc.signUp(email, password, workspaceInvite = invite.link, emailCode = emailCode)
                            // The link onboarding carried stands in for an empty invite field.
                            invite is InviteInput.Code && invite.code.isBlank() && carried != null ->
                                acc.signUp(email, password, workspaceInvite = carried, emailCode = emailCode)
                            invite is InviteInput.Code -> acc.signUp(email, password, invite.code, emailCode = emailCode)
                            else -> acc.signUp(email, password, "", emailCode = emailCode)
                        }
                        // Chat opens the Join sheet with the link next time it shows, also after a restart (§3.3).
                        val link = (invite as? InviteInput.Link)?.link ?: carried
                        if (link != null) workspaces?.rememberJoin(link)
                        _ui.update { it.copy(recoveryKey = res.recoveryKey, joinWithLink = link != null) }
                    }
                    Form.SIGN_IN -> {
                        acc.signIn(email, password, emailCode)
                        if (carried != null) {
                            workspaces?.rememberJoin(carried)
                            _ui.update { it.copy(joinWithLink = true) }
                        }
                    }
                    Form.RECOVER -> acc.recover(email, f["recoveryKey"].orEmpty(), password, emailCode)
                }
                fields.clear()
                _ui.update { it.copy(code = null) }
                refill()
                done(if (form == Form.SIGN_UP) R.string.settings_rukoo_welcome else R.string.settings_rukoo_signed_in)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                AppLog.w(TAG, "the account form failed", e)
                val err = e as? AccountError
                val code = err?.code ?: "server"
                when {
                    // A code was sent already: the invite code typed since didn't work, and the emailed code still does.
                    form == Form.SIGN_UP && code == "code_required" && shown != null && shown.email == AccountKeys.normalizeEmail(email) ->
                        stop(FormError.Text(R.string.settings_rukoo_code_invite_wrong))
                    // The server checks addresses: a code first, then the same submit again.
                    form == Form.SIGN_UP && code == "code_required" -> codeNext = invited
                    // A locked account, on a server that sends codes to get past the lock.
                    form != Form.SIGN_UP && code == "locked" && shown == null && acc.status.value.info?.codesFor("unlock") == true ->
                        stop(FormError.Locked)
                    else -> stop(FormError.Code(code, err?.attemptsLeft))
                }
            } finally {
                _ui.update { it.copy(working = false) }
            }
            codeNext?.let { inviteFailed -> sendCode(form, lang, inviteFailed) }
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

        /** The server sends an address at most one code of a purpose a minute, in seconds. */
        const val CODE_GAP = 60L

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
