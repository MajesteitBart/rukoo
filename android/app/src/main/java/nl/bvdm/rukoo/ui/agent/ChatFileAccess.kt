package nl.bvdm.rukoo.ui.agent

import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.graphics.BitmapFactory
import android.net.Uri
import android.provider.OpenableColumns
import android.webkit.MimeTypeMap
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.core.content.FileProvider
import java.io.File
import nl.bvdm.rukoo.agents.ChatFiles
import nl.bvdm.rukoo.agents.FileSource
import nl.bvdm.rukoo.core.AppLog

/**
 * The phone's side of a chat's files: what the file and photo pickers return, read through the content resolver, and
 * opening a sent file in another app through the FileProvider. The hub does the rest (ChatFiles).
 */
class ChatFileAccess(private val context: () -> Context) {
    /**
     * The picked files as sources the hub copies in. The provider's name and size are only what it claims: the hub
     * cleans the name and stops reading past 10 MB whatever the size said. A name without an extension gets the one
     * of the type the provider reports, so a photo named "IMG_0042" still goes to the agent as an image. Blocking.
     */
    fun sources(uris: List<Uri>): List<FileSource> {
        // The application's resolver: the copy can outlive the screen that picked the files.
        val resolver = context().applicationContext.contentResolver
        return uris.map { uri ->
            var name: String? = null
            var size: Long? = null
            try {
                resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
                    if (c.moveToFirst()) {
                        if (!c.isNull(0)) name = c.getString(0)
                        if (!c.isNull(1)) size = c.getLong(1).takeIf { it >= 0 }
                    }
                }
            } catch (e: Exception) {
                AppLog.w(TAG, "a picked file has no name", e)
            }
            var shown = name?.takeIf { it.isNotBlank() } ?: uri.lastPathSegment?.substringAfterLast('/')?.takeIf { it.isNotBlank() } ?: "file"
            if (ChatFiles.extname(shown).isEmpty()) {
                val ext = runCatching { MimeTypeMap.getSingleton().getExtensionFromMimeType(resolver.getType(uri)) }.getOrNull()
                if (!ext.isNullOrEmpty()) shown = "$shown.$ext"
            }
            FileSource(shown, size) { resolver.openInputStream(uri) }
        }
    }

    /** Opens a sent file with the app the user picks, read only and under its own name. False when no app takes it. */
    fun open(file: File, name: String, type: String): Boolean {
        val ctx = context()
        val uri = FileProvider.getUriForFile(ctx, "${ctx.packageName}.files", file, name)
        val intent = Intent(Intent.ACTION_VIEW)
            .setDataAndType(uri, type)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        intent.clipData = ClipData.newRawUri(name, uri)
        return try {
            ctx.startActivity(Intent.createChooser(intent, name).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK))
            true
        } catch (_: ActivityNotFoundException) {
            false
        }
    }

    companion object {
        private const val TAG = "ChatFiles"

        // The longest a thumbnail's long side may be, in multiples of its short side, before it is sampled down further: a
        // 128 x 60000 image would otherwise decode at full size for a chip.
        private const val LONG_SIDE = 4

        /**
         * A small picture of an image file, about [px] on its short side and at most [LONG_SIDE] times that on its long
         * side; null when it isn't one Android can decode, or it doesn't fit in memory. Blocking.
         */
        fun thumbnail(file: File, px: Int): ImageBitmap? = try {
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeFile(file.path, bounds)
            val short = minOf(bounds.outWidth, bounds.outHeight)
            val long = maxOf(bounds.outWidth, bounds.outHeight)
            if (short <= 0 || px <= 0) {
                null
            } else {
                var sample = 1
                while (short / (sample * 2) >= px || long / sample > px * LONG_SIDE) sample *= 2
                BitmapFactory.decodeFile(file.path, BitmapFactory.Options().apply { inSampleSize = sample })?.asImageBitmap()
            }
        } catch (e: Exception) {
            null
        } catch (e: OutOfMemoryError) {
            null
        }
    }
}
