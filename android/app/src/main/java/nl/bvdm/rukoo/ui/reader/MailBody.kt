package nl.bvdm.rukoo.ui.reader

import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.graphics.Color as AndroidColor
import android.net.Uri
import android.os.Build
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.browser.customtabs.CustomTabsIntent
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import nl.bvdm.rukoo.ui.theme.Rk

/**
 * An email body (spec 4 §6.5): a WebView with JavaScript, file and content access off, showing
 * [MailFrame.document]. It is as tall as its content, so the header and the body scroll as one page, and
 * mail wider than the phone is zoomed out to fit. A tapped link goes to [onLink], never into the WebView.
 */
@SuppressLint("SetJavaScriptEnabled")
@Composable
fun MailBody(
    html: String,
    isHtml: Boolean,
    light: Boolean,
    darkEmails: Boolean,
    label: String,
    onLink: (Uri) -> Unit,
    modifier: Modifier = Modifier,
) {
    // Parsing a large newsletter takes a moment: off the main thread, with the loading bar meanwhile.
    val doc by produceState(MailFrame.cached(html, isHtml, light, darkEmails), html, isHtml, light, darkEmails) {
        // On a theme change the state still holds the old document: always resolve the current one.
        value = MailFrame.cached(html, isHtml, light, darkEmails)
            ?: withContext(Dispatchers.Default) { MailFrame.documentCached(html, isHtml, light, darkEmails) }
    }
    val fontScale = LocalDensity.current.fontScale
    val current = doc
    if (current == null) {
        LoadingBar(modifier)
        return
    }
    AndroidView(
        modifier = modifier.fillMaxWidth().semantics { contentDescription = label },
        factory = { context -> mailWebView(context) },
        update = { view ->
            view.settings.textZoom = (fontScale * 100).toInt()
            view.webViewClient = LinkClient(onLink)
            if (view.tag != current) {
                view.tag = current
                view.loadDataWithBaseURL(null, current, "text/html", "utf-8", null)
            }
        },
        onRelease = { it.destroy() },
    )
}

private fun mailWebView(context: Context): WebView = WebView(context).apply {
    setBackgroundColor(AndroidColor.TRANSPARENT)
    isVerticalScrollBarEnabled = false
    isHorizontalScrollBarEnabled = false
    settings.apply {
        javaScriptEnabled = false
        allowFileAccess = false
        allowContentAccess = false
        domStorageEnabled = false
        setGeolocationEnabled(false)
        setSupportMultipleWindows(false)
        javaScriptCanOpenWindowsAutomatically = false
        mediaPlaybackRequiresUserGesture = true
        cacheMode = WebSettings.LOAD_DEFAULT
        // Fit wide mail to the phone; mail that fits keeps its size.
        useWideViewPort = true
        loadWithOverviewMode = true
        setSupportZoom(false)
        builtInZoomControls = false
        displayZoomControls = false
        // Rukoo recolors mail for dark mode itself (MailFrame); the WebView's own darkening would stack on it.
        if (Build.VERSION.SDK_INT >= 33) isAlgorithmicDarkeningAllowed = false
    }
}

/** Every navigation is a link the user tapped: it leaves the WebView. */
private class LinkClient(private val onLink: (Uri) -> Unit) : WebViewClient() {
    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
        val url = request.url
        // In-page anchors stay put; the document itself is about:blank.
        if (url.scheme == "about" || (url.scheme == null && url.fragment != null)) return true
        if (request.hasGesture() || request.isForMainFrame) onLink(url)
        return true
    }
}

/**
 * Where a link from mail goes (spec 4 §6.3): mailto opens the composer through [compose]; http and https open
 * in a Custom Tab; anything else is ignored.
 */
fun openMailLink(context: Context, uri: Uri, compose: (String) -> Unit) {
    when (uri.scheme?.lowercase()) {
        "mailto" -> compose(uri.toString())
        "http", "https" -> openInBrowser(context, uri)
    }
}

fun openInBrowser(context: Context, uri: Uri) {
    try {
        CustomTabsIntent.Builder().setShowTitle(true).build().launchUrl(context, uri)
    } catch (_: ActivityNotFoundException) {
        runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
    }
}

/** The loading bar (styles.css:1961-1975): 2dp, an accent gradient sweeping across once a second. */
@Composable
fun LoadingBar(modifier: Modifier = Modifier) {
    val accent = Rk.colors.accent
    val reduced = Rk.motion.reduced
    val sweep by rememberInfiniteTransition(label = "loading").animateFloat(
        initialValue = -0.4f,
        targetValue = 1.4f,
        animationSpec = infiniteRepeatable(tween(1000, easing = LinearEasing), RepeatMode.Restart),
        label = "sweep",
    )
    Box(
        modifier
            .fillMaxWidth()
            .height(2.dp)
            .background(accent.copy(alpha = 0.15f))
            .drawBehind {
                if (reduced) {
                    drawRect(accent.copy(alpha = 0.6f))
                } else {
                    val x = size.width * sweep
                    drawRect(
                        Brush.horizontalGradient(listOf(Color.Transparent, accent, Color.Transparent), startX = x - size.width * 0.3f, endX = x + size.width * 0.3f),
                        topLeft = Offset.Zero,
                    )
                }
            },
    )
}
