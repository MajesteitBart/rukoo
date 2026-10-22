// Ported in part from Beautiful UI (beautifului.dev), MIT License, Copyright (c) 2026 Shane Levine, through
// Rukoo's desktop src/renderer/agent/bui.js (attachmentChip) and agent.css (.bui-entity__badge--file).
package nl.bvdm.rukoo.ui.agent

import android.util.LruCache
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import java.io.File
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import nl.bvdm.rukoo.R
import nl.bvdm.rukoo.ui.components.EntityChip
import nl.bvdm.rukoo.ui.components.RkIcon
import nl.bvdm.rukoo.ui.icons.PanelIcons
import nl.bvdm.rukoo.ui.mail.MailDates
import nl.bvdm.rukoo.ui.theme.Rk

// The icon for each kind of file (panel.js FILE_ICONS).
private val FILE_ICONS = mapOf("pdf" to "file-text", "text" to "file-text", "image" to "image", "file" to "file")

// Thumbnails already made, so a chip that scrolls back into view doesn't decode its image again. Counted in bytes:
// each is small (ChatFileAccess.thumbnail bounds both sides), and together they stay within 8 MB.
private val thumbnails = object : LruCache<String, ImageBitmap>(8 * 1024 * 1024) {
    override fun sizeOf(key: String, value: ImageBitmap): Int = value.asAndroidBitmap().byteCount
}

/**
 * A file's badge in a chip (bui.js attachmentChip, `.bui-entity__badge--file`): the file-type icon in `ink2` on a
 * grey tile with 5dp corners, or a small picture of an image in the same shape.
 */
@Composable
internal fun FileBadge(kind: String, thumb: ImageBitmap?, size: Dp = 18.dp) {
    val c = Rk.colors
    val shape = RoundedCornerShape(5.dp)
    if (thumb != null) {
        Image(thumb, null, Modifier.size(size).clip(shape), contentScale = ContentScale.Crop)
        return
    }
    Box(Modifier.size(size).background(c.ink3.copy(alpha = 0.18f), shape), contentAlignment = Alignment.Center) {
        RkIcon(PanelIcons.named(FILE_ICONS[kind] ?: "file", 2.2f), null, size = size * 0.62f, tint = c.ink2)
    }
}

/** A small picture of an image file, made off the main thread; null for other files, while it loads and when it can't. */
@Composable
internal fun rememberThumbnail(key: String, kind: String, size: Dp, load: suspend () -> File?): ImageBitmap? {
    if (kind != "image") return null
    val px = with(LocalDensity.current) { (size * 2).roundToPx() }
    // Per key: a chip that now shows another file never keeps the picture of the one before.
    val thumb = remember(key) { mutableStateOf(thumbnails.get(key)) }
    LaunchedEffect(key) {
        if (thumb.value != null) return@LaunchedEffect
        thumb.value = withContext(Dispatchers.IO) {
            load()?.let { ChatFileAccess.thumbnail(it, px) }?.also { thumbnails.put(key, it) }
        }
    }
    return thumb.value
}

/**
 * A file attached to a message (bui.js attachmentChip): its badge, its name and its size. Waiting in the input it has
 * an x ([onRemove]); on a sent message a tap opens it ([onClick]).
 */
@Composable
internal fun FileChip(
    name: String,
    size: Long,
    kind: String,
    thumbKey: String,
    load: suspend () -> File?,
    onRemove: (() -> Unit)? = null,
    onClick: (() -> Unit)? = null,
    animateEntry: Boolean = true,
) {
    val locale = LocalConfiguration.current.locales[0]
    val thumb = rememberThumbnail(thumbKey, kind, 18.dp, load)
    EntityChip(
        name,
        sub = MailDates.fileSize(size, locale),
        monogram = null,
        leading = { FileBadge(kind, thumb) },
        onClick = onClick,
        onClickLabel = if (onClick != null) stringResource(R.string.agentui_files_open, name) else null,
        onRemove = onRemove,
        removeLabel = stringResource(R.string.agentui_panel_remove_attachment, name),
        animateEntry = animateEntry,
    )
}

/** A picked file still being copied in: its name shimmers, it has no x yet, and assistive tech hears "Adding …". */
@Composable
internal fun PendingFileChip(file: AddingFile) {
    val locale = LocalConfiguration.current.locales[0]
    val busy = stringResource(R.string.agentui_files_adding, file.name)
    EntityChip(
        file.name,
        Modifier.semantics { contentDescription = busy },
        sub = file.size?.let { MailDates.fileSize(it, locale) },
        monogram = null,
        leading = { FileBadge("file", null) },
        pending = true,
    )
}
