package nl.bvdm.rukoo.ui.composer

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import java.io.File
import nl.bvdm.rukoo.core.Ids
import nl.bvdm.rukoo.mail.model.OutgoingAttachment

/** Files the composer takes in from other apps. */
object ComposerFiles {
    // Path separators, characters Windows and FAT refuse, and control characters.
    private val UNSAFE = Regex("[\\\\/:*?\"<>|\\p{Cc}]")

    /** A name from another app as a file name here, never a path. */
    fun safeName(name: String): String = name.replace(UNSAFE, "_").trim().trim('.').ifEmpty { "file" }.take(150)

    /**
     * Copies a picked file into the app's storage (files/attachments, which the FileProvider serves), where
     * Send can read it after the picker's grant is gone. Blocking: call it off the main thread.
     */
    fun copyIn(context: Context, uri: Uri, composerId: String): OutgoingAttachment? {
        val resolver = context.contentResolver
        var name = "file"
        var size = 0L
        resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { cursor ->
            if (cursor.moveToFirst()) {
                cursor.getString(0)?.let { name = it }
                if (!cursor.isNull(1)) size = cursor.getLong(1)
            }
        }
        val safe = safeName(name)
        val dir = File(context.filesDir, "attachments/compose/${safeName(composerId)}/${Ids.rand(8)}").apply { mkdirs() }
        val file = File(dir, safe)
        resolver.openInputStream(uri)?.use { input -> file.outputStream().use { input.copyTo(it) } } ?: return null
        return OutgoingAttachment(safe, resolver.getType(uri) ?: "application/octet-stream", file.absolutePath, if (size > 0) size else file.length())
    }
}
