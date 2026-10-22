package nl.bvdm.rukoo.mail.session

import jakarta.mail.AuthenticationFailedException
import java.net.ConnectException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.security.cert.CertPathValidatorException
import java.security.cert.CertificateException
import javax.net.ssl.SSLHandshakeException
import javax.net.ssl.SSLPeerUnverifiedException
import nl.bvdm.rukoo.R
import nl.bvdm.rukoo.mail.MailException
import nl.bvdm.rukoo.mail.MailStrings

/** Desktop's friendlyError (imap.js:22-34, spec 4 §2.14) for Java's network and mail exceptions. */
object FriendlyErrors {
    private val AUTH = Regex("AUTHENTICATIONFAILED|Invalid credentials|authentication failed|535|Username and Password not accepted", RegexOption.IGNORE_CASE)
    private val HOST = Regex("ENOTFOUND|EAI_AGAIN|Unable to resolve host|No address associated", RegexOption.IGNORE_CASE)
    private val REFUSED = Regex("ECONNREFUSED|Connection refused", RegexOption.IGNORE_CASE)
    private val TIMEOUT = Regex("ETIMEDOUT|timeout|timed out", RegexOption.IGNORE_CASE)
    private val CERTIFICATE = Regex("certificate|self.signed|CERT_|PKIX|Trust anchor", RegexOption.IGNORE_CASE)

    private fun chain(e: Throwable): Sequence<Throwable> = generateSequence(e) { it.cause?.takeIf { c -> c !== it } }.take(8)

    fun message(e: Throwable, strings: MailStrings): String {
        // Already a text for the user (an OAuth failure, a validation error).
        if (e is MailException) return e.message.orEmpty()
        val all = chain(e).toList()
        all.firstOrNull { it is MailException }?.let { return it.message.orEmpty() }
        if (all.any { it is AuthenticationFailedException }) return strings.get(R.string.engine_errors_connection_auth)
        if (all.any { it is UnknownHostException }) return strings.get(R.string.engine_errors_connection_host)
        if (all.any { it is ConnectException }) return strings.get(R.string.engine_errors_connection_refused)
        if (all.any { it is SocketTimeoutException }) return strings.get(R.string.engine_errors_connection_timeout)
        if (all.any { it is SSLPeerUnverifiedException || it is CertPathValidatorException || it is CertificateException || it is SSLHandshakeException }) {
            return strings.get(R.string.engine_errors_connection_certificate)
        }
        val msg = all.mapNotNull { it.message }.joinToString(" ")
        return when {
            AUTH.containsMatchIn(msg) -> strings.get(R.string.engine_errors_connection_auth)
            HOST.containsMatchIn(msg) -> strings.get(R.string.engine_errors_connection_host)
            REFUSED.containsMatchIn(msg) -> strings.get(R.string.engine_errors_connection_refused)
            TIMEOUT.containsMatchIn(msg) -> strings.get(R.string.engine_errors_connection_timeout)
            CERTIFICATE.containsMatchIn(msg) -> strings.get(R.string.engine_errors_connection_certificate)
            else -> e.message?.takeIf { it.isNotBlank() } ?: e.javaClass.simpleName
        }
    }

    fun wrap(e: Throwable, strings: MailStrings, prefix: String = ""): MailException =
        if (e is MailException && prefix.isEmpty()) e else MailException(prefix + message(e, strings), (e as? MailException)?.code, e)
}
