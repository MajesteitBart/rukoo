package nl.bvdm.rukoo.account

import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ProcessLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import nl.bvdm.rukoo.categories.Categories
import nl.bvdm.rukoo.mail.MailEngine

/**
 * When the account syncs without the user asking: when Rukoo comes to the front, every five minutes while it is open
 * (desktop's interval), and after each mail sync, so new mail's categories go up with it. A change made here syncs
 * two seconds later by itself (AccountService), and "Sync now" syncs at once. SyncWorker syncs after its mail sync.
 */
class AccountBackground(private val scope: CoroutineScope, private val account: () -> AccountService, private val mail: () -> MailEngine) {
    fun start() {
        scope.launch(Dispatchers.Main) {
            ProcessLifecycleOwner.get().lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
                while (true) {
                    syncQuietly()
                    delay(AccountService.SYNC_EVERY)
                }
            }
        }
        scope.launch(Dispatchers.Default) {
            mail().sync.map { it.lastSync }.distinctUntilChanged().drop(1).collect { syncQuietly() }
        }
    }

    private suspend fun syncQuietly() {
        try {
            // The first use reads the account's files; never on the main thread.
            withContext(Dispatchers.Default) { account().sync() }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            // Settings shows the account's error; the next sync tries again.
        }
    }

    companion object {
        /** After a background mail sync: what the account holds comes down, the new mail is sorted, and that goes up. */
        suspend fun afterMailSync(account: AccountService, categories: Categories) {
            runCatching { account.sync() }
            runCatching { categories.sort() }
            if (account.status().pending > 0) runCatching { account.sync() }
        }
    }
}
