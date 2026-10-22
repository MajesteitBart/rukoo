package nl.bvdm.rukoo.ui.reader

import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.content.FileProvider
import kotlinx.coroutines.launch
import nl.bvdm.rukoo.R
import nl.bvdm.rukoo.mail.MailEngine
import nl.bvdm.rukoo.mail.model.AttachmentInfo
import nl.bvdm.rukoo.ui.components.ExpandChevron
import nl.bvdm.rukoo.ui.components.RkIconButton
import nl.bvdm.rukoo.ui.components.RkIconButtonSize
import nl.bvdm.rukoo.ui.components.RkToastState
import nl.bvdm.rukoo.ui.components.rkClickable
import nl.bvdm.rukoo.ui.icons.RukooIcons
import nl.bvdm.rukoo.ui.mail.MailDates
import nl.bvdm.rukoo.ui.theme.FileTileColors
import nl.bvdm.rukoo.ui.theme.Rk
import nl.bvdm.rukoo.ui.theme.medium
import nl.bvdm.rukoo.ui.theme.semibold
import nl.bvdm.rukoo.ui.theme.tabular
import nl.bvdm.rukoo.ui.theme.weight

/**
 * The reader's attachments (app.js attachmentsHtml): one is just its card; several get a header with the
 * count and total size that folds them. A card opens the file in another app; its button shares it. Both
 * go through the FileProvider, from the copy the engine writes to the app's cache.
 */
@Composable
fun ReaderAttachments(mail: MailEngine, messageId: String, list: List<AttachmentInfo>, toasts: RkToastState, modifier: Modifier = Modifier) {
    if (list.isEmpty()) return
    val c = Rk.colors
    val context = LocalContext.current
    val locale = LocalConfiguration.current.locales[0]
    val scope = rememberCoroutineScope()
    var open by rememberSaveable(messageId) { mutableStateOf(true) }
    val noApp = stringResource(R.string.reader_attachments_no_app)
    val risky = stringResource(R.string.reader_attachments_risky)

    fun withFile(a: AttachmentInfo, use: (Uri) -> Unit) {
        scope.launch {
            try {
                val file = mail.attachmentFile(messageId, a.index)
                use(FileProvider.getUriForFile(context, "${context.packageName}.files", file))
            } catch (e: Exception) {
                toasts.showError(e.message ?: e.javaClass.simpleName)
            }
        }
    }

    val share: (AttachmentInfo) -> Unit = { a -> withFile(a) { uri -> shareFile(context, uri, a) } }
    val view: (AttachmentInfo) -> Unit = { a ->
        if (Attachments.isRisky(a.filename)) toasts.showError(risky)
        else withFile(a) { uri -> if (!viewFile(context, uri, a)) toasts.showError(noApp) }
    }

    Column(modifier, verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (list.size > 1) {
            Row(
                Modifier.heightIn(min = 40.dp).rkClickable(Rk.shapes.control) { open = !open }.padding(end = 8.dp),
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                ExpandChevron(open, size = 14.dp, tint = c.text3)
                Text(pluralStringResource(R.plurals.reader_attachments_count, list.size, list.size), style = Rk.type.text12_5.semibold, color = c.text2)
                Text(MailDates.fileSize(list.sumOf { it.size }, locale), style = Rk.type.text12_5.tabular, color = c.text3)
            }
        }
        if (open || list.size == 1) {
            BoxWithConstraints(Modifier.fillMaxWidth()) {
                // Cards in columns of at least 230dp (styles.css:1816-1951); one column on the cover screen.
                val columns = (maxWidth / 230.dp).toInt().coerceIn(1, 3)
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    for (rowItems in list.chunked(columns)) {
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            for (a in rowItems) AttachmentCard(a, locale, onOpen = { view(a) }, onShare = { share(a) }, modifier = Modifier.weight(1f))
                            repeat(columns - rowItems.size) { Box(Modifier.weight(1f)) }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun AttachmentCard(a: AttachmentInfo, locale: java.util.Locale, onOpen: () -> Unit, onShare: () -> Unit, modifier: Modifier) {
    val c = Rk.colors
    val shape = Rk.shapes.card
    val kind = Attachments.kindOf(a.filename)
    Row(
        modifier
            .background(c.panel2, shape)
            .border(1.dp, c.border, shape)
            .rkClickable(shape, onClickLabel = stringResource(R.string.reader_attachments_open, a.filename), onClick = onOpen)
            .padding(start = 7.dp, top = 6.dp, bottom = 6.dp, end = 2.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(34.dp).background(tileColor(kind.kind), RoundedCornerShape(7.dp)), contentAlignment = Alignment.Center) {
            Text(kind.label, style = Rk.type.text11.weight(750).copy(fontSize = Rk.type.text11.fontSize * 0.86f), color = Color.White, maxLines = 1)
        }
        Column(Modifier.weight(1f)) {
            Text(a.filename, style = Rk.type.text12_5.medium, color = c.text, maxLines = 2, overflow = TextOverflow.Ellipsis)
            Text(MailDates.fileSize(a.size, locale), style = Rk.type.text11_5.tabular, color = c.text3, maxLines = 1)
        }
        RkIconButton(RukooIcons.Export, stringResource(R.string.reader_attachments_share, a.filename), onClick = onShare, size = RkIconButtonSize.SMALL)
    }
}

private fun tileColor(kind: String): Color = when (kind) {
    "pdf" -> FileTileColors.pdf
    "doc" -> FileTileColors.doc
    "sheet" -> FileTileColors.sheet
    "slides" -> FileTileColors.slides
    "image" -> FileTileColors.image
    "archive" -> FileTileColors.archive
    "cal" -> FileTileColors.calendar
    "mail" -> FileTileColors.mail
    else -> FileTileColors.default
}

/** ACTION_VIEW through a chooser, with read access to that one file. False when no app takes it. */
private fun viewFile(context: Context, uri: Uri, a: AttachmentInfo): Boolean {
    val intent = Intent(Intent.ACTION_VIEW)
        .setDataAndType(uri, Attachments.viewType(a.filename, a.contentType))
        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    return try {
        context.startActivity(Intent.createChooser(intent, a.filename).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION))
        true
    } catch (_: ActivityNotFoundException) {
        false
    }
}

private fun shareFile(context: Context, uri: Uri, a: AttachmentInfo) {
    val intent = Intent(Intent.ACTION_SEND)
        .setType(Attachments.viewType(a.filename, a.contentType))
        .putExtra(Intent.EXTRA_STREAM, uri)
        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    intent.clipData = ClipData.newRawUri(a.filename, uri)
    runCatching { context.startActivity(Intent.createChooser(intent, a.filename)) }
}
