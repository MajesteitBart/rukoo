package nl.bvdm.rukoo.mail.google

import java.io.File
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import nl.bvdm.rukoo.core.AppLog
import nl.bvdm.rukoo.core.JsonFiles
import nl.bvdm.rukoo.core.SecretCipher
import nl.bvdm.rukoo.mail.model.GoogleClient

/**
 * The Google OAuth client (Desktop type) Rukoo signs in with. The repository is public, so no client
 * ships with the app: it comes from a JSON file the user picks or from desktop Rukoo's export. The
 * secret is stored encrypted, like every other secret on the phone.
 */
class GoogleClientStore(private val file: File, private val cipher: SecretCipher) {
    @Serializable
    private data class Stored(@SerialName("client_id") val clientId: String, @SerialName("client_secret") val secret: String)

    private val _client = MutableStateFlow(load())
    val client: StateFlow<GoogleClient?> = _client.asStateFlow()

    private fun load(): GoogleClient? {
        val stored = runCatching { JsonFiles.read(file, Stored.serializer(), Stored("", "")) }.getOrNull() ?: return null
        if (stored.clientId.isEmpty()) return null
        val secret = cipher.decrypt(stored.secret)
        if (secret == null) {
            AppLog.w(TAG, "the Google client secret could not be decrypted")
            return null
        }
        return GoogleClient(stored.clientId, secret)
    }

    fun set(client: GoogleClient) {
        JsonFiles.write(file, Stored.serializer(), Stored(client.clientId, cipher.encrypt(client.clientSecret)))
        _client.value = client
    }

    fun clear() {
        file.delete()
        _client.value = null
    }

    private companion object {
        const val TAG = "GoogleClient"
    }
}
