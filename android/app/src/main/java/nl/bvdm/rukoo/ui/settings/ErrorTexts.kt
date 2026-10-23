package nl.bvdm.rukoo.ui.settings

import android.content.res.Resources
import androidx.compose.runtime.Composable
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import nl.bvdm.rukoo.R
import nl.bvdm.rukoo.desktop.DesktopErrors
import nl.bvdm.rukoo.desktop.DesktopException
import nl.bvdm.rukoo.mail.MailEngine
import nl.bvdm.rukoo.mail.MailException

/**
 * What to tell the user about a failure: a text per status the computer returns, the mail engine's own
 * (already translated) message, or a general line. [address] is where the phone tried to reach the
 * computer, [name] the computer's name once it is paired.
 */
object ErrorTexts {
    fun of(res: Resources, error: Throwable, address: String? = null, name: String? = null): String {
        val where = address?.takeIf { it.isNotBlank() } ?: name.orEmpty()
        val who = name?.takeIf { it.isNotBlank() } ?: where
        return when (error) {
            is DesktopException -> when (error.code) {
                DesktopErrors.INVALID_ADDRESS -> res.getString(R.string.settings_pair_error_address)
                DesktopErrors.INVALID_CODE -> res.getString(R.string.settings_pair_error_code)
                DesktopErrors.OFFLINE -> res.getString(R.string.settings_pair_error_offline, where)
                DesktopErrors.NOT_ENABLED -> res.getString(R.string.settings_pair_error_not_enabled, where)
                DesktopErrors.WRONG_CODE -> res.getString(R.string.settings_pair_error_wrong_code)
                DesktopErrors.EXPIRED -> res.getString(R.string.settings_pair_error_expired)
                DesktopErrors.FULL -> res.getString(R.string.settings_pair_error_full, who)
                DesktopErrors.RATE_LIMITED -> res.getString(R.string.settings_pair_error_rate_limited)
                DesktopErrors.EXPORT_CLOSED -> res.getString(R.string.settings_pair_error_export_closed, who)
                DesktopErrors.UNAUTHORIZED -> res.getString(R.string.settings_pair_error_unauthorized, who)
                DesktopErrors.UNKNOWN_COMPUTER -> res.getString(R.string.settings_pair_error_unknown_computer)
                DesktopErrors.PROTOCOL -> res.getString(R.string.settings_pair_error_protocol)
                else -> res.getString(R.string.settings_pair_error_unknown)
            }
            is GoogleClientFile.Invalid -> res.getString(R.string.settings_google_invalid_client)
            is MailException -> when (error.code) {
                MailEngine.UNSUPPORTED -> res.getString(R.string.settings_google_unsupported)
                else -> error.message?.takeIf { it.isNotBlank() } ?: res.getString(R.string.settings_error_generic)
            }
            else -> res.getString(R.string.settings_error_generic)
        }
    }
}

@Composable
fun errorText(error: Throwable, address: String? = null, name: String? = null): String {
    // Read so a configuration change (the language) recomposes the text.
    LocalConfiguration.current
    return ErrorTexts.of(LocalContext.current.resources, error, address, name)
}
