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
import nl.bvdm.rukoo.R
import nl.bvdm.rukoo.account.AccountDetails
import nl.bvdm.rukoo.account.AccountError
import nl.bvdm.rukoo.account.AccountService
import nl.bvdm.rukoo.account.ServerInfo
import nl.bvdm.rukoo.core.AppLog

/**
 * Settings > Rukoo account's work, a port of desktop's src/renderer/rukoo-account.js. It runs here rather than in a
 * page, so folding or leaving the page doesn't cut a sign-up short. The forms' fields live here too, outside any
 * Bundle, so a password is never saved with the activity's state.
 */
class RukooAccountModel(services: AppServices) : ViewModel() {
    val account: AccountService? = services.account

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
    )

    sealed interface FormError {
        data class Code(val code: String) : FormError

        data class Text(@StringRes val res: Int) : FormError
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
    fun fill(page: String) {
        val acc = account ?: return
        val now = System.currentTimeMillis()
        val last = filled
        if (last != null && last.first == page && now - last.second < FILL_AGAIN_AFTER) return
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

    private fun refill() {
        filled = null
    }

    fun clearFormError() = _ui.update { it.copy(formError = null) }

    fun recoveryKeyShown() = _ui.update { it.copy(recoveryKey = null) }

    enum class Form { SIGN_UP, SIGN_IN, RECOVER }

    /** A form's submit (desktop's submit): its own checks first, then the account; [done] gets the toast to show. */
    fun submit(form: Form, done: (Int) -> Unit) {
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
        _ui.update { it.copy(working = true, formError = null) }
        viewModelScope.launch {
            try {
                when (form) {
                    Form.SIGN_UP -> {
                        val res = acc.signUp(email, password, f["invite"].orEmpty())
                        _ui.update { it.copy(recoveryKey = res.recoveryKey) }
                    }
                    Form.SIGN_IN -> acc.signIn(email, password)
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

        // JSON.stringify(data, null, 2), as desktop writes the export.
        @OptIn(ExperimentalSerializationApi::class)
        private val PRETTY = Json {
            prettyPrint = true
            prettyPrintIndent = "  "
        }
    }
}
