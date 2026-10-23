package nl.bvdm.rukoo.core

import java.io.File
import java.io.FileOutputStream
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.util.concurrent.ConcurrentHashMap
import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.serializer

/** The JSON settings every file and wire format in the app shares. */
val RukooJson: Json = Json {
    ignoreUnknownKeys = true
    // Desktop writes optional fields as absent or null; both read the same here, and absent is written back.
    explicitNulls = false
    encodeDefaults = true
    // An enum value this version doesn't know falls back to the field's default instead of failing the file.
    coerceInputValues = true
    isLenient = false
}

/**
 * JSON files written atomically: the data goes to a temp file next to the target, is synced, then
 * renamed over it, so a crash leaves the old file or the new one, never half of one (like desktop's
 * write-then-rename, config.js:72-77).
 */
object JsonFiles {
    private val locks = ConcurrentHashMap<String, Any>()

    private fun lockFor(file: File): Any = locks.getOrPut(file.absolutePath) { Any() }

    /**
     * Reads [file], or returns [default] when it is missing. A file that can't be parsed is moved aside
     * as `<name>.bad-<ms>` (desktop does the same with conversations.json, hub.js:424-438), so the next
     * write doesn't destroy what might still be recovered by hand. A file that can't be read, or can't
     * be preserved either way, throws an IOException instead of returning [default], so no caller writes over it.
     */
    fun <T> read(file: File, serializer: KSerializer<T>, default: T, clock: Clock = Clock.System, json: Json = RukooJson): T =
        synchronized(lockFor(file)) {
            if (!file.exists()) return default
            // A file that exists but can't be read throws: returning the default would let the next write replace it.
            val text = file.readText(Charsets.UTF_8)
            runCatching { json.decodeFromString(serializer, text) }.getOrElse {
                AppLog.w(TAG, "${file.name} is not valid, moved aside", it)
                moveAside(file, clock)
                default
            }
        }

    inline fun <reified T> read(file: File, default: T, clock: Clock = Clock.System): T =
        read(file, serializer<T>(), default, clock)

    fun <T> write(file: File, serializer: KSerializer<T>, value: T, json: Json = RukooJson) {
        val text = json.encodeToString(serializer, value)
        synchronized(lockFor(file)) {
            file.parentFile?.mkdirs()
            val tmp = File(file.parentFile, "${file.name}.${Ids.rand(8)}.tmp")
            try {
                FileOutputStream(tmp).use { out ->
                    out.write(text.toByteArray(Charsets.UTF_8))
                    out.fd.sync()
                }
                Files.move(tmp.toPath(), file.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
            } finally {
                if (tmp.exists()) tmp.delete()
            }
        }
    }

    inline fun <reified T> write(file: File, value: T) = write(file, serializer<T>(), value)

    private fun moveAside(file: File, clock: Clock) {
        val bad = File(file.parentFile, "${file.name}.bad-${clock.now()}")
        if (file.renameTo(bad)) return
        // A rename can fail where a copy works (another process holds the file); the copy is the backup then.
        try {
            Files.copy(file.toPath(), bad.toPath(), StandardCopyOption.REPLACE_EXISTING)
            file.delete()
        } catch (e: java.io.IOException) {
            throw java.io.IOException("${file.name} is not valid and could not be moved aside", e)
        }
    }

    private const val TAG = "JsonFiles"
}
