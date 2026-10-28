package nl.bvdm.rukoo.ui.mail

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.delay
import nl.bvdm.rukoo.R
import nl.bvdm.rukoo.categories.Category
import nl.bvdm.rukoo.categories.SortActivity
import nl.bvdm.rukoo.categories.SortDecision
import nl.bvdm.rukoo.mail.model.MailView
import nl.bvdm.rukoo.mail.model.ViewKind
import nl.bvdm.rukoo.ui.components.RkBottomSheet
import nl.bvdm.rukoo.ui.components.RkButton
import nl.bvdm.rukoo.ui.components.RkButtonKind
import nl.bvdm.rukoo.ui.components.RkButtonSize
import nl.bvdm.rukoo.ui.components.RkIcon
import nl.bvdm.rukoo.ui.components.rkClickable
import nl.bvdm.rukoo.ui.icons.RukooIcons
import nl.bvdm.rukoo.ui.root.AppViewModel
import nl.bvdm.rukoo.ui.settings.CategoryDot
import nl.bvdm.rukoo.ui.settings.SettingsRoutes
import nl.bvdm.rukoo.ui.theme.Rk
import nl.bvdm.rukoo.ui.theme.semibold
import nl.bvdm.rukoo.ui.theme.tabular
import kotlin.math.roundToInt

/*
 * What the inbox sorting is doing, in the folder drawer (desktop's src/renderer/sort-activity.js): a line above the
 * sync status while Jev works through the inbox, waits for TypeSafe or can't use its key, and a sheet with the
 * progress and Jev's last decisions. Categories.activity tells every change.
 */

/** How long "Sorted 48 emails" stays after a sort someone asked for. */
private const val DONE_SHOWS = 6_000L

/** A sort nobody asked for, of new mail, shows once it takes this long; a quick one doesn't flash by. */
private const val QUIET_FOR = 1_500L

enum class SortStatus { SORTING, DONE, WAITING, KEY }

/** What the drawer's line says, or null for nothing to tell. */
fun sortStatus(a: SortActivity, enabled: Boolean, now: Long): SortStatus? = when {
    !enabled -> null
    a.running && (a.user || now - a.startedAt >= QUIET_FOR) -> SortStatus.SORTING
    a.error == "key" -> SortStatus.KEY
    a.error != null && a.waiting > 0 -> SortStatus.WAITING
    !a.running && a.user && a.finishedAt > 0 && now - a.finishedAt < DONE_SHOWS -> SortStatus.DONE
    else -> null
}

/** When the line changes by itself: a quiet sort has taken long enough, or "Sorted" has shown long enough; 0 for never. */
private fun nextChange(a: SortActivity): Long = when {
    a.running && !a.user -> a.startedAt + QUIET_FOR
    !a.running && a.user && a.finishedAt > 0 -> a.finishedAt + DONE_SHOWS
    else -> 0
}

private fun SortActivity.fraction(): Float = if (total > 0) (done.toFloat() / total).coerceIn(0f, 1f) else 0f

/** Before Jev's first answer the ring turns, so the line doesn't look stuck at nothing. */
private fun SortActivity.starting(): Boolean = running && asked > 0 && answered == 0

/** The drawer's line above the sync status; a tap opens the sheet. Nothing without categories or news. */
@Composable
fun SortStatusLine(app: AppViewModel) {
    val categories = app.services.categories ?: return
    val activity by categories.activity.collectAsStateWithLifecycle()
    val state by categories.state.collectAsStateWithLifecycle()
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(activity) {
        now = System.currentTimeMillis()
        val at = nextChange(activity)
        if (at > now) {
            delay(at - now + 20)
            now = System.currentTimeMillis()
        }
    }
    var open by rememberSaveable { mutableStateOf(false) }
    if (open) SortActivitySheet(app, onDismiss = { open = false })
    val status = sortStatus(activity, state.enabled, now) ?: return
    val c = Rk.colors
    val dates = rememberMailDates()
    val text = when (status) {
        SortStatus.SORTING -> stringResource(if (activity.asked > 0) R.string.categories_activity_sorting_jev else R.string.categories_activity_sorting)
        SortStatus.DONE -> if (activity.sorted > 0) pluralStringResource(R.plurals.categories_activity_sorted, activity.sorted, activity.sorted) else stringResource(R.string.categories_activity_nothing)
        SortStatus.WAITING ->
            if (activity.retryAt > 0) stringResource(R.string.categories_activity_waiting_until, dates.time(activity.retryAt)) else stringResource(R.string.categories_activity_waiting_title)
        SortStatus.KEY -> stringResource(R.string.categories_activity_key_refused)
    }
    val count = when (status) {
        SortStatus.SORTING -> "${activity.done}/${activity.total}"
        SortStatus.WAITING -> activity.waiting.toString()
        else -> ""
    }
    Row(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 10.dp, vertical = 4.dp)
            .heightIn(min = 40.dp)
            .rkClickable(Rk.shapes.control, onClickLabel = stringResource(R.string.categories_activity_show)) { open = true }
            .padding(horizontal = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(20.dp), contentAlignment = Alignment.Center) {
            when (status) {
                SortStatus.SORTING -> SortRing(activity.fraction(), activity.starting())
                SortStatus.DONE -> RkIcon(RukooIcons.Check, null, size = 18.dp, tint = c.ok)
                SortStatus.WAITING -> RkIcon(RukooIcons.Clock, null, size = 18.dp, tint = c.warn)
                SortStatus.KEY -> RkIcon(RukooIcons.Info, null, size = 18.dp, tint = c.danger)
            }
        }
        Text(
            text,
            style = Rk.type.text13,
            color = if (status == SortStatus.KEY) c.danger else c.text2,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        if (count.isNotEmpty()) Text(count, style = Rk.type.text12.tabular, color = c.text3)
    }
}

/** How far the sort is, as a ring that fills; while [starting], a quarter of it turns. */
@Composable
private fun SortRing(fraction: Float, starting: Boolean) {
    val c = Rk.colors
    val shown by animateFloatAsState(fraction, tween(400), label = "sort-ring")
    val turn = if (starting) {
        rememberInfiniteTransition(label = "sort-turn").animateFloat(0f, 360f, infiniteRepeatable(tween(1000, easing = LinearEasing), RepeatMode.Restart), label = "turn").value
    } else {
        0f
    }
    Canvas(Modifier.size(16.dp)) {
        val w = 2.dp.toPx()
        val r = (size.minDimension - w) / 2
        val topLeft = Offset(center.x - r, center.y - r)
        val arc = Size(2 * r, 2 * r)
        drawCircle(c.borderStrong, r, style = Stroke(w))
        rotate(turn) { drawArc(c.accent, -90f, if (starting) 90f else 360f * shown, false, topLeft, arc, style = Stroke(w, cap = StrokeCap.Round)) }
    }
}

/** The sheet: how far the sort is or why Jev waits, Jev's last decisions, and the way to Settings > Inbox categories. */
@Composable
private fun SortActivitySheet(app: AppViewModel, onDismiss: () -> Unit) {
    val categories = app.services.categories ?: return
    val a by categories.activity.collectAsStateWithLifecycle()
    val state by categories.state.collectAsStateWithLifecycle()
    val c = Rk.colors
    val dates = rememberMailDates()
    val res = LocalContext.current.resources
    val now = System.currentTimeMillis()
    val status = sortStatus(a, state.enabled, now)
    val byId = state.categories.associateBy { it.id }
    RkBottomSheet(onDismissRequest = onDismiss) {
        val sheet = this
        Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp).padding(top = 4.dp, bottom = 12.dp)) {
            val title = when (status) {
                SortStatus.SORTING -> stringResource(if (a.asked > 0) R.string.categories_activity_title_jev else R.string.categories_activity_title_sorting)
                SortStatus.WAITING -> stringResource(R.string.categories_activity_waiting_title)
                SortStatus.KEY -> stringResource(R.string.categories_activity_key_refused)
                else -> stringResource(R.string.categories_activity_title_done)
            }
            Text(title, style = Rk.type.text14.semibold, color = c.text)
            val lines = when (status) {
                SortStatus.SORTING -> listOf(
                    listOfNotNull(stringResource(R.string.categories_activity_progress, a.done, a.total), minutesLeft(a, now, res)).joinToString(" · "),
                )
                SortStatus.WAITING, SortStatus.KEY -> listOfNotNull(
                    if (status == SortStatus.KEY) {
                        stringResource(R.string.categories_activity_key_text)
                    } else {
                        listOfNotNull(
                            stringResource(if (a.error == "busy") R.string.categories_activity_busy else R.string.categories_activity_network),
                            if (a.retryAt > 0) stringResource(R.string.categories_activity_retry_at, dates.time(a.retryAt)) else null,
                        ).joinToString(" ")
                    },
                    if (a.waiting > 0) pluralStringResource(R.plurals.categories_activity_waiting_count, a.waiting, a.waiting) else null,
                )
                else -> listOf(
                    listOfNotNull(
                        if (a.user && a.finishedAt > 0) {
                            (if (a.sorted > 0) pluralStringResource(R.plurals.categories_activity_sorted, a.sorted, a.sorted) else stringResource(R.string.categories_activity_nothing)) + "."
                        } else {
                            null
                        },
                        stringResource(if (a.jev) R.string.categories_activity_new_mail_jev else R.string.categories_activity_new_mail),
                    ).joinToString(" "),
                )
            }
            for (line in lines) Text(line, style = Rk.type.text12_5, color = c.text2, modifier = Modifier.padding(top = 4.dp))
            if (status == SortStatus.SORTING) {
                val shown by animateFloatAsState(a.fraction(), tween(400), label = "sort-bar")
                Box(Modifier.padding(top = 12.dp).fillMaxWidth().height(4.dp).background(c.hover, Rk.shapes.pill)) {
                    Box(Modifier.fillMaxWidth(shown).fillMaxHeight().background(c.accent, Rk.shapes.pill))
                }
            }
        }
        if (a.recent.isNotEmpty()) {
            Text(
                stringResource(R.string.categories_activity_recent),
                style = Rk.type.text12.semibold,
                color = c.text3,
                modifier = Modifier.padding(start = 20.dp, top = 2.dp, bottom = 4.dp),
            )
            LazyColumn(Modifier.weight(1f, fill = false)) {
                items(a.recent, key = { "${it.id}|${it.at}" }) { d ->
                    DecisionRow(d, byId, Modifier.animateItem()) {
                        sheet.dismiss()
                        openSorted(app, d)
                    }
                }
            }
        }
        Row(
            Modifier.fillMaxWidth().padding(start = 20.dp, end = 12.dp, top = 8.dp, bottom = 4.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (status == SortStatus.SORTING || status == SortStatus.WAITING || status == SortStatus.KEY) {
                Text(stringResource(R.string.categories_activity_meanwhile), style = Rk.type.text12, color = c.text3, modifier = Modifier.weight(1f))
            } else {
                Spacer(Modifier.weight(1f))
            }
            RkButton(
                stringResource(if (status == SortStatus.KEY) R.string.categories_activity_check_key else R.string.categories_activity_settings),
                onClick = {
                    sheet.dismiss()
                    app.closeDrawer()
                    app.openSettings(listOf(SettingsRoutes.CATEGORIES))
                },
                kind = RkButtonKind.GHOST,
                size = RkButtonSize.SMALL,
            )
        }
    }
}

private fun minutesLeft(a: SortActivity, now: Long, res: android.content.res.Resources): String? {
    if (!a.running || a.answered < 6 || now - a.startedAt < 5_000) return null
    val perEmail = (now - a.startedAt).toDouble() / a.answered
    val seconds = (a.asked - a.answered) * perEmail / 1000
    if (seconds < 60) return res.getString(R.string.categories_activity_less_than_minute)
    val minutes = (seconds / 60).roundToInt()
    return res.getQuantityString(R.plurals.categories_activity_minutes_left, minutes, minutes)
}

/** One of Jev's decisions: the subject and where it went, then the sender and how sure Jev was. */
@Composable
private fun DecisionRow(d: SortDecision, byId: Map<String, Category>, modifier: Modifier, onClick: () -> Unit) {
    val c = Rk.colors
    val went = byId[d.category]
    val percent = (d.confidence * 100).roundToInt()
    val how = if (d.sure) {
        stringResource(R.string.categories_activity_sure, percent)
    } else {
        stringResource(R.string.categories_activity_unsure, byId[d.chose]?.name.orEmpty(), percent)
    }
    Column(
        modifier
            .fillMaxWidth()
            .padding(horizontal = 8.dp)
            .rkClickable(Rk.shapes.control, onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 8.dp)
            .semantics(mergeDescendants = true) {},
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(
                d.subject.ifEmpty { stringResource(R.string.mailbox_message_no_subject) },
                style = Rk.type.text13,
                color = c.text,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            if (went != null) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    CategoryDot(went.color, size = 7.dp)
                    Text(went.name, style = Rk.type.text12, color = c.text2, maxLines = 1)
                }
            }
        }
        Text(
            listOf(d.from, how).filter { it.isNotEmpty() }.joinToString(" · "),
            style = Rk.type.text12,
            color = c.text3,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.padding(top = 1.dp),
        )
    }
}

/** An email from Jev's last decisions: the inbox, in the category it went to, with the email open. */
private fun openSorted(app: AppViewModel, d: SortDecision) {
    val scoped = app.state.value.view.accountId
    app.closeDrawer()
    app.selectView(MailView(ViewKind.INBOX, if (scoped == d.accountId) scoped else null))
    app.setCategory(d.category)
    app.openMessage(d.id)
}
