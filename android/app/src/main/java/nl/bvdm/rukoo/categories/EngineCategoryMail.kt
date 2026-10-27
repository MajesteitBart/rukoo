package nl.bvdm.rukoo.categories

import android.content.Context
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import nl.bvdm.rukoo.R
import nl.bvdm.rukoo.mail.MailEngine
import nl.bvdm.rukoo.mail.model.Account
import nl.bvdm.rukoo.mail.model.FolderRole
import nl.bvdm.rukoo.mail.model.MailView
import nl.bvdm.rukoo.mail.model.MessageSummary
import nl.bvdm.rukoo.mail.model.ViewKind

/** The mail engine as the categories see it: each account's inbox, the people written to, and when mail changed. */
class EngineCategoryMail(private val engine: MailEngine, scope: CoroutineScope) : CategoryMail {
    @Volatile
    private var written: Set<String> = emptySet()

    init {
        // Addresses in the Sent folders, worked out again whenever they change (desktop does it at most every 30 s).
        scope.launch {
            engine.messages(MailView(ViewKind.SENT)).collect { list ->
                written = list.asSequence().flatMap { it.to + it.cc }.map { Categories.lower(it.address) }.filter { it.isNotEmpty() }.toHashSet()
            }
        }
    }

    override val accounts: List<Account> get() = engine.accounts.value

    override suspend fun inboxes(): List<Pair<Account, List<MessageSummary>>> = engine.accounts.value.map { acc ->
        val inboxes = engine.folders.value[acc.id].orEmpty().filter { it.role == FolderRole.INBOX }
        acc to inboxes.flatMap { engine.listMessages(MailView.folder(acc.id, it.path)) }
    }

    override fun writtenTo(): Set<String> = written

    // The inbox as it is when the categories start, and every change after, as desktop sorts after each 'updated' of
    // its engine. The first one counts too: a cache loaded before the categories started never changes for them.
    override val changes: Flow<Unit> = engine.messages(MailView.AllInboxes).map { }
}

/** The presets' texts from the app's resources, so they follow the language. */
class ResourceCategoryTexts(private val context: Context) : CategoryTexts {
    override fun presetName(id: String): String = context.resources.getString(
        when (id) {
            "needs-you" -> R.string.categories_presets_needs_you_name
            "to-read" -> R.string.categories_presets_to_read_name
            "money" -> R.string.categories_presets_money_name
            "updates" -> R.string.categories_presets_updates_name
            else -> R.string.categories_presets_promotions_name
        },
    )

    override fun presetDescription(id: String): String = context.resources.getString(
        when (id) {
            "needs-you" -> R.string.categories_presets_needs_you_description
            "to-read" -> R.string.categories_presets_to_read_description
            "money" -> R.string.categories_presets_money_description
            "updates" -> R.string.categories_presets_updates_description
            else -> R.string.categories_presets_promotions_description
        },
    )
}
