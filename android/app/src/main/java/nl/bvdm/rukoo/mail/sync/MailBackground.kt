package nl.bvdm.rukoo.mail.sync

import android.content.Context
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import nl.bvdm.rukoo.core.AppLog
import nl.bvdm.rukoo.core.Clock
import nl.bvdm.rukoo.mail.MailEngine
import nl.bvdm.rukoo.settings.AppSettings

/**
 * When mail syncs without the user asking (spec 4 §1.13, design.md "Sync"): every `syncMinutes` while
 * Rukoo is visible (the desktop's interval; 0 turns it off), and every 15 minutes in the background
 * through WorkManager, which is as often as Android allows.
 */
class MailBackground(
    private val context: Context,
    private val scope: CoroutineScope,
    private val settings: StateFlow<AppSettings>,
    private val clock: Clock = Clock.System,
) {
    @Volatile
    var foreground: Boolean = false
        private set

    /** Starts or stops the periodic background work, depending on whether there is mail to sync. */
    fun schedule(hasAccounts: Boolean) {
        val work = runCatching { WorkManager.getInstance(context) }.getOrElse {
            AppLog.w(TAG, "WorkManager unavailable", it)
            return
        }
        if (!hasAccounts) {
            work.cancelUniqueWork(WORK_NAME)
            return
        }
        val request = PeriodicWorkRequestBuilder<SyncWorker>(15, TimeUnit.MINUTES)
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .build()
        work.enqueueUniquePeriodicWork(WORK_NAME, ExistingPeriodicWorkPolicy.KEEP, request)
    }

    /** The foreground loop and the visibility flag the notifier reads. */
    fun start(engine: MailEngine, onForeground: () -> Unit) {
        scope.launch(Dispatchers.Main) {
            val lifecycle = ProcessLifecycleOwner.get().lifecycle
            lifecycle.addObserver(
                object : DefaultLifecycleObserver {
                    override fun onStart(owner: LifecycleOwner) {
                        foreground = true
                        onForeground()
                    }

                    override fun onStop(owner: LifecycleOwner) {
                        foreground = false
                    }
                },
            )
            lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
                settings.map { it.syncMinutes }.distinctUntilChanged().collectLatest { minutes ->
                    var first = true
                    while (true) {
                        // Coming to the front syncs right away, unless a sync just finished.
                        val last = engine.sync.value.lastSync.values.maxOrNull() ?: 0L
                        if (!first || clock.now() - last > FRESH_MS) {
                            try {
                                engine.refresh(null)
                            } catch (e: CancellationException) {
                                throw e
                            } catch (e: Exception) {
                                // Shown per account in the app.
                            }
                        }
                        first = false
                        if (minutes <= 0) break
                        delay(minutes * 60_000L)
                    }
                }
            }
        }
    }

    private companion object {
        const val TAG = "MailBackground"
        const val WORK_NAME = "rukoo-mail-sync"
        const val FRESH_MS = 60_000L
    }
}
