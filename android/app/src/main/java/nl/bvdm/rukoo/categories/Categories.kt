package nl.bvdm.rukoo.categories

import java.io.File
import java.security.MessageDigest
import java.text.Collator
import java.util.Locale
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.put
import nl.bvdm.rukoo.account.AccountService
import nl.bvdm.rukoo.core.AppLog
import nl.bvdm.rukoo.core.Clock
import nl.bvdm.rukoo.core.JsonFiles
import nl.bvdm.rukoo.core.SecretCipher
import nl.bvdm.rukoo.mail.model.Account
import nl.bvdm.rukoo.mail.model.MessageSummary

/** One inbox category as Settings and the tabs show it. A [preset] nobody renamed takes its texts from the translations. */
data class Category(
    val id: String,
    val preset: String?,
    val name: String,
    val description: String,
    val customName: Boolean,
    val customDescription: Boolean,
    val color: String,
    val order: Int,
)

data class JevState(val on: Boolean = false, val hasKey: Boolean = false, val error: String? = null, val model: String = Jev.MODEL)

/** A sender whose mail always goes to one category. */
data class SenderRule(val address: String, val category: String)

/** Everything Settings > Inbox categories and the inbox tabs show (desktop's state()). */
data class CategoriesState(
    val enabled: Boolean = false,
    /** The category for mail Rukoo isn't sure about. */
    val unsure: String? = null,
    val categories: List<Category> = emptyList(),
    val jev: JevState = JevState(),
    val senders: List<SenderRule> = emptyList(),
    val signedIn: Boolean = false,
    val limit: Int = Categories.MAX_CATEGORIES,
)

/** A change Rukoo refuses: `invalid`, `too_many`, `need_name` or `last`; the UI says it in words. */
class CategoryException(val code: String) : Exception(code)

/** A change to a text field of a category: leave it, go back to Rukoo's own (a preset's translation), or this text. */
sealed interface TextEdit {
    data object Keep : TextEdit

    data object Reset : TextEdit

    data class To(val text: String) : TextEdit
}

/** The names and descriptions of the five presets in the app's language. */
interface CategoryTexts {
    fun presetName(id: String): String

    fun presetDescription(id: String): String
}

/** What the categories need from the mail engine; tests pass a fake. */
interface CategoryMail {
    val accounts: List<Account>

    /** Each account's inbox messages, from the cache. */
    suspend fun inboxes(): List<Pair<Account, List<MessageSummary>>>

    /** Addresses the person has written to, lower case, from the Sent folders. */
    fun writtenTo(): Set<String>

    /** Fires when the mail changed, so new mail gets sorted. */
    val changes: Flow<Unit>
}

/** categories.json: what stays on this phone, Jev's switch and key (encrypted like mail passwords). */
@Serializable
data class LocalCategories(val jev: LocalJev? = null)

@Serializable
data class LocalJev(val on: Boolean = false, val key: String? = null, val error: String? = null)

/**
 * Inbox categories: the inbox split into views, like Gmail's tabs, for every kind of account. A port of desktop's
 * src/main/categories/index.js. Nothing is labelled, moved or flagged on the mail server. Which category an email is
 * in lives in the Rukoo account, so every device shows the same: the categories themselves, the category each
 * email got, and the corrections a person makes.
 *
 * An email's category is the first of: a correction for that email, a rule for its sender, the category it got
 * when it was first sorted, and else what the rules say now. The first device to sort an email stores the result;
 * the others use it. Sorting uses the rules (CategoryRules), and Jev where this phone has a TypeSafe key.
 */
class Categories(
    private val account: AccountService,
    private val mail: CategoryMail,
    private val secrets: SecretCipher,
    private val dir: File,
    private val jev: JevApi,
    private val texts: CategoryTexts,
    scope: CoroutineScope,
    private val clock: Clock = Clock.System,
    private val sortAfterMs: Long = SORT_AFTER,
) {
    private val scope = CoroutineScope(scope.coroutineContext + SupervisorJob(scope.coroutineContext[Job]))
    private val lock = Any()
    private var local = LocalCategories()
    private var timer: Job? = null

    /** The sort after TypeSafe was busy, apart from [soon]'s timer, which every mail update moves. */
    internal var retryTimer: Job? = null
    private var sorting: Deferred<Int>? = null

    /** A sort asked for while one runs: null for none, true when any of them asked to sort again. Under [lock]. */
    private var followUp: Boolean? = null
    private val sortLock = Mutex()

    @Volatile
    internal var jevBusyUntil = 0L

    /** Goes up with every change to Jev's settings; what a request made under older settings answers is dropped. */
    @Volatile
    private var jevGeneration = 0

    /**
     * Emails "Sort the inbox again" still has to sort, by key, because Jev was busy or stopped before it got to them.
     * Their older category stays until then. Under [lock].
     */
    internal val redo = HashSet<String>()

    private val _state = MutableStateFlow(CategoriesState())
    val state: StateFlow<CategoriesState> = _state.asStateFlow()

    private val file get() = File(dir, "categories.json")

    init {
        local = runCatching { JsonFiles.read(file, LocalCategories.serializer(), LocalCategories()) }.getOrElse { LocalCategories() }
        _state.value = computeState()
        this.scope.launch {
            account.records.collect { collections -> if (collections.any { it in COLLECTIONS }) changed() }
        }
        this.scope.launch {
            account.status.collect { refresh() }
        }
        this.scope.launch { mail.changes.collect { soon() } }
    }

    private fun saveLocal() {
        runCatching { JsonFiles.write(file, LocalCategories.serializer(), local) }.onFailure { AppLog.w(TAG, "could not save categories.json", it) }
    }

    /** Works the state out again, as after a change of language: the presets' texts follow it. */
    fun refresh() {
        _state.value = computeState()
    }

    private fun changed() = refresh()

    // ---- what the categories are ----

    data class Settings(val enabled: Boolean, val unsure: String, val seeded: Boolean)

    fun settings(): Settings {
        val v = account.get("setting", SETTING) as? JsonObject
        return Settings(
            enabled = v.flag("enabled"),
            unsure = (v?.get("unsure") as? JsonPrimitive)?.takeIf { it.isString }?.content ?: "to-read",
            seeded = v.flag("seeded"),
        )
    }

    private fun putSettings(enabled: Boolean? = null, unsure: String? = null, seeded: Boolean? = null) {
        val s = settings()
        account.put("setting", SETTING, buildJsonObject {
            put("enabled", enabled ?: s.enabled)
            put("unsure", unsure ?: s.unsure)
            put("seeded", seeded ?: s.seeded)
        })
    }

    /**
     * The categories in order, with the names and descriptions people see. A preset nobody renamed takes its name
     * and description from the translations, so it follows the language.
     */
    fun list(): List<Category> {
        val collator = Collator.getInstance(Locale.ROOT)
        return account.list("category").map { (k, value) ->
            val v = value as? JsonObject
            val preset = k.takeIf { it in CategoryRules.PRESETS }
            val name = v.text("name")
            val description = v.text("description")
            Category(
                id = k,
                preset = preset,
                name = name ?: if (preset != null) texts.presetName(preset) else k,
                description = description ?: if (preset != null) texts.presetDescription(preset) else "",
                customName = name != null,
                customDescription = description != null,
                color = v.text("color") ?: CategoryRules.PRESET_COLORS[preset] ?: COLORS[0],
                order = v.number("order")?.toInt() ?: 0,
            )
        }.sortedWith { a, b -> if (a.order != b.order) a.order.compareTo(b.order) else collator.compare(a.id, b.id) }
    }

    /** The five presets, the first time categories are turned on. */
    private fun seed() {
        if (settings().seeded) return
        CategoryRules.PRESETS.forEachIndexed { order, id ->
            if (account.get("category", id) == null) {
                account.put("category", id, buildJsonObject {
                    put("name", JsonNull)
                    put("description", JsonNull)
                    put("color", CategoryRules.PRESET_COLORS.getValue(id))
                    put("order", order)
                })
            }
        }
        putSettings(seeded = true)
    }

    private fun computeState(): CategoriesState {
        val s = settings()
        val list = list()
        val ids = list.map { it.id }.toSet()
        val j = synchronized(lock) { local.jev }
        val collator = Collator.getInstance(Locale.ROOT)
        return CategoriesState(
            enabled = s.enabled,
            unsure = if (s.unsure in ids) s.unsure else list.firstOrNull()?.id,
            categories = list,
            jev = JevState(on = j?.on == true, hasKey = j?.key != null, error = j?.error, model = jev.model),
            // Senders that always go to one category, for Settings.
            senders = account.list("sender")
                .mapNotNull { (k, v) -> (v as? JsonObject).text("category")?.takeIf { it in ids }?.let { SenderRule(k, it) } }
                .sortedWith { a, b -> collator.compare(a.address, b.address) },
            signedIn = account.signedIn,
        )
    }

    fun setEnabled(on: Boolean): CategoriesState {
        if (on) seed()
        putSettings(enabled = on)
        changed()
        if (on) soon(0)
        return state.value
    }

    fun setUnsure(id: String): CategoriesState {
        if (list().none { it.id == id }) throw CategoryException("invalid")
        putSettings(unsure = id)
        changed()
        return state.value
    }

    /** A new category ([id] null) or changes to one. */
    fun saveCategory(id: String? = null, name: TextEdit = TextEdit.Keep, description: TextEdit = TextEdit.Keep, color: String? = null): CategoriesState {
        val list = list()
        val was = id?.let { account.get("category", it) }
        if (id != null && was == null) throw CategoryException("invalid")
        if (id == null && list.size >= MAX_CATEGORIES) throw CategoryException("too_many")
        val key = id ?: "c-${AccountKeysHex.random(5)}"
        val old = was as? JsonObject
        fun clean(edit: TextEdit, max: Int, field: String): String? = when (edit) {
            TextEdit.Keep -> old.text(field)
            TextEdit.Reset -> null
            is TextEdit.To -> edit.text.trim().takeIf { it.isNotEmpty() }?.take(max)
        }
        val newName = clean(name, 40, "name")
        val newDescription = clean(description, 400, "description")
        val newColor = color?.takeIf { COLOR.matches(it) } ?: old.text("color") ?: COLORS[list.size % COLORS.size]
        val order = if (old != null) old.number("order")?.toInt() ?: 0 else maxOf(-1, list.maxOfOrNull { it.order } ?: -1) + 1
        if (key !in CategoryRules.PRESETS && newName == null) throw CategoryException("need_name")
        val value = buildJsonObject {
            // Fields a newer app may have added stay as they were.
            old?.forEach { (k, v) -> if (k !in setOf("name", "description", "color", "order")) put(k, v) }
            put("name", newName?.let(::JsonPrimitive) ?: JsonNull)
            put("description", newDescription?.let(::JsonPrimitive) ?: JsonNull)
            put("color", newColor)
            put("order", order)
        }
        account.put("category", key, value)
        changed()
        return state.value
    }

    fun removeCategory(id: String): CategoriesState {
        val list = list()
        if (list.none { it.id == id }) throw CategoryException("invalid")
        if (list.size <= 1) throw CategoryException("last")
        account.remove("category", id)
        if (settings().unsure == id) putSettings(unsure = list.first { it.id != id }.id)
        changed()
        return state.value
    }

    fun reorder(ids: List<String>): CategoriesState {
        val list = list()
        if (ids.size != list.size || !list.all { it.id in ids }) throw CategoryException("invalid")
        ids.forEachIndexed { order, id ->
            val v = account.get("category", id) as? JsonObject ?: return@forEachIndexed
            if (v.number("order") != order.toDouble()) account.put("category", id, JsonObject(v + ("order" to JsonPrimitive(order))))
        }
        changed()
        return state.value
    }

    // ---- which category an email is in ----

    /** The key an email's records are stored under: the account's address and the email's Message-ID. */
    fun key(acc: Account, m: MessageSummary): String {
        val id = m.messageId?.takeIf { it.isNotEmpty() } ?: "h:" + sha256Hex("${lower(m.from.address)}\n${m.date}\n${m.subject}")
        return "${lower(acc.email)}\n$id"
    }

    fun own(acc: Account): List<String> = (listOf(acc.email) + acc.aliases.map { it.address }).filter { it.isNotEmpty() }

    data class Placed(val category: String, val strength: Strength)

    /**
     * The category the rules give an email, among the ones that exist. [order] is the categories' ids in the person's
     * order, which decides between several rule matches.
     */
    private fun byRules(acc: Account, m: MessageSummary, order: List<String>, unsure: String): Placed {
        val known = lower(m.from.address) in mail.writtenTo()
        val r = CategoryRules.presetFor(m, own(acc), m.vip, known, order)
        return if (r.preset in order) Placed(r.preset, r.strength) else Placed(unsure, Strength.WEAK)
    }

    /** An inbox email's category id, or null when categories are off. */
    fun of(acc: Account, m: MessageSummary): String? = of(listOf(acc), listOf(m))[m.id]

    /** The category of each of [messages] by id (inbox mail only), or nothing when categories are off. */
    fun of(accounts: List<Account>, messages: List<MessageSummary>): Map<String, String> {
        val s = settings()
        if (!s.enabled) return emptyMap()
        val list = list()
        if (list.isEmpty()) return emptyMap()
        val order = list.map { it.id }
        val ids = order.toSet()
        val unsure = if (s.unsure in ids) s.unsure else list[0].id
        val byId = accounts.associateBy { it.id }
        val out = HashMap<String, String>(messages.size * 2)
        for (m in messages) {
            val acc = byId[m.accountId] ?: continue
            val key = key(acc, m)
            val stored = listOf("override" to key, "sender" to lower(m.from.address), "classification" to key).firstNotNullOfOrNull { (collection, k) ->
                (account.get(collection, k) as? JsonObject).text("category")?.takeIf { it in ids }
            }
            out[m.id] = stored ?: byRules(acc, m, order, unsure).category
        }
        return out
    }

    /** Puts emails in a category; with [sender], also every later email from their senders. */
    fun move(messages: List<MessageSummary>, category: String, sender: Boolean = false) {
        if (list().none { it.id == category }) throw CategoryException("invalid")
        val accounts = mail.accounts.associateBy { it.id }
        val senders = LinkedHashSet<String>()
        for (m in messages) {
            val acc = accounts[m.accountId] ?: continue
            account.put("override", key(acc, m), mark(category))
            if (sender && m.from.address.isNotEmpty()) senders += lower(m.from.address)
        }
        for (address in senders) account.put("sender", address, mark(category))
        changed()
    }

    private fun mark(category: String) = buildJsonObject {
        put("category", category)
        put("at", clock.now())
    }

    /** Forgets a sender's rule. */
    fun forgetSender(address: String) {
        account.remove("sender", lower(address))
        changed()
    }

    // ---- sorting ----

    fun soon(delayMs: Long = sortAfterMs) {
        synchronized(lock) {
            timer?.cancel()
            timer = scope.launch {
                delay(delayMs)
                runCatching { sort() }.onFailure { if (it is CancellationException) throw it else AppLog.w(TAG, "sorting failed", it) }
            }
        }
    }

    private class Item(val acc: Account, val m: MessageSummary, val key: String)

    /** Inbox emails nobody has sorted yet, newest first. */
    private suspend fun unsorted(again: Boolean): List<Item> {
        val out = ArrayList<Item>()
        for ((acc, messages) in mail.inboxes()) {
            for (m in messages) {
                val key = key(acc, m)
                if (account.get("override", key) != null) continue
                if (!again && synchronized(lock) { key !in redo } && account.get("classification", key) != null) continue
                out += Item(acc, m, key)
            }
        }
        return out.sortedByDescending { it.m.date }
    }

    /**
     * Whether this phone sorts with Jev: on, with a key. Mail Jev should sort waits for it, also while TypeSafe refuses
     * the key or is busy; the rules show a category for it meanwhile ([of]), without storing one.
     */
    private fun jevWanted(): Boolean = synchronized(lock) { local.jev }?.let { it.on && it.key != null } == true

    /** The key to call Jev with now: none after TypeSafe refused it (until a new one) or while TypeSafe is busy. */
    internal fun jevKey(): String? {
        val j = synchronized(lock) { local.jev } ?: return null
        if (!jevWanted() || j.error == "key" || clock.now() < jevBusyUntil) return null
        return j.key?.let(secrets::decrypt)
    }

    /**
     * Sorts what isn't sorted yet; [again] sorts every inbox email again, apart from the ones people moved themselves.
     * A sort asked for while one runs follows it, sorting again if any of those asks did, so nothing asked for is lost:
     * "Sort the inbox again" during an ordinary sort, or the sort a new Jev key starts. The result covers both.
     */
    suspend fun sort(again: Boolean = false): Int {
        if (!settings().enabled) return 0
        val job = synchronized(lock) {
            sorting?.also { followUp = followUp == true || again } ?: scope.async(start = CoroutineStart.LAZY) {
                var total = 0
                var ask: Boolean? = again
                while (ask != null) {
                    synchronized(lock) { followUp = null }
                    if (!settings().enabled) break
                    total += run(ask)
                    // Finishing and taking a follow-up are one step, so an ask that comes now isn't left behind.
                    ask = synchronized(lock) { followUp.also { if (it == null) sorting = null } }
                }
                total
            }.also { made ->
                sorting = made
                made.invokeOnCompletion { synchronized(lock) { if (sorting === made) sorting = null } }
            }
        }
        job.start()
        return job.await()
    }

    suspend fun sortAgain(): Int = sort(again = true)

    private suspend fun run(again: Boolean): Int = sortLock.withLock {
        val list = list()
        if (list.isEmpty()) return 0
        val ids = list.map { it.id }.toSet()
        val s = settings()
        val unsure = if (s.unsure in ids) s.unsure else list[0].id
        val wanted = jevWanted()
        val key = jevKey()
        val generation = jevGeneration
        // Sorting again replaces what an email had; otherwise the first stored category stays (first write wins).
        fun replace(k: String) = again || synchronized(lock) { k in redo }
        fun store(k: String, value: JsonObject): Boolean {
            val done = if (replace(k)) account.put("classification", k, value) else account.put("classification", k, value, ifAbsent = true)
            synchronized(lock) { redo.remove(k) }
            return done
        }
        fun later(k: String) {
            if (replace(k)) synchronized(lock) { redo.add(k) }
        }
        val forJev = ArrayDeque<Item>()
        var sorted = 0
        val order = list.map { it.id }
        for (item in unsorted(again)) {
            // Cached before Rukoo kept the mail-kind headers: the next sync brings them, and until then the rules would
            // guess with less than they will have. The rules still show a category for it meanwhile.
            if (item.m.signals == null) continue
            val rule = byRules(item.acc, item.m, order, unsure)
            if (rule.strength == Strength.STRONG || !wanted) {
                val value = buildJsonObject {
                    put("category", rule.category)
                    put("source", "rules")
                    put("at", clock.now())
                }
                if (store(item.key, value)) sorted++
            } else if (key != null) {
                forJev += item
            } else {
                later(item.key)
            }
        }
        var stop: Throwable? = null
        // Turning Jev or categories off, or a new key, stops what is still queued: nothing more goes to TypeSafe.
        var cancelled = false
        val queue = Any()
        val asked = forJev.size
        coroutineScope {
            repeat(JEV_AT_ONCE) {
                launch(Dispatchers.IO) {
                    while (true) {
                        val stillWanted = settings().enabled && jevGeneration == generation && jevKey() == key
                        val item = synchronized(queue) {
                            if (stop != null || cancelled) {
                                null
                            } else if (!stillWanted) {
                                cancelled = true
                                null
                            } else {
                                forJev.removeFirstOrNull()
                            }
                        } ?: break
                        try {
                            val own = own(item.acc).map(::lower)
                            val toMe = item.m.to.any { lower(it.address) in own }
                            val res = jev.classify(key!!, item.m, list, toMe)
                            val category = if (res.confidence >= JEV_CONFIDENT) res.category else unsure
                            val value = buildJsonObject {
                                put("category", category)
                                put("source", "jev")
                                put("confidence", res.confidence)
                                put("model", res.model)
                                put("at", clock.now())
                            }
                            if (store(item.key, value)) synchronized(queue) { sorted++ }
                        } catch (e: CancellationException) {
                            throw e
                        } catch (e: Throwable) {
                            later(item.key)
                            synchronized(queue) { if (stop == null) stop = e }
                        }
                    }
                }
            }
        }
        for (item in forJev) later(item.key)
        if (jevGeneration == generation) {
            val failure = stop
            val error = synchronized(lock) { local.jev?.error }
            if (failure != null) {
                jevFailed(failure)
            } else if (asked > 0 && (error == "busy" || error == "network")) {
                // Jev answered again after being busy or out of reach. A refused key only clears with a new key (setJev).
                setJevError(null)
            }
        }
        // Mail waits for Jev while TypeSafe is busy: make sure a sort follows the wait.
        val now = clock.now()
        if (wanted && key == null && now < jevBusyUntil && synchronized(lock) { retryTimer == null }) retryAfter(jevBusyUntil - now + 1000)
        if (sorted > 0) changed()
        sorted
    }

    /**
     * A wrong key waits for a new one; TypeSafe being busy or out of reach waits a few minutes. The rules keep showing
     * a category for every email in the meantime.
     */
    private fun jevFailed(e: Throwable) {
        if ((e as? JevError)?.code == "key") {
            setJevError("key")
        } else {
            jevBusyUntil = clock.now() + JEV_WAIT_MS
            setJevError(if ((e as? JevError)?.code == "busy") "busy" else "network")
            retryAfter(JEV_WAIT_MS + 1000)
        }
    }

    private fun retryAfter(ms: Long) {
        synchronized(lock) {
            retryTimer?.cancel()
            lateinit var job: Job
            job = scope.launch(start = CoroutineStart.LAZY) {
                delay(ms)
                synchronized(lock) { if (retryTimer === job) retryTimer = null }
                runCatching { sort() }.onFailure { if (it is CancellationException) throw it else AppLog.w(TAG, "sorting failed", it) }
            }
            retryTimer = job
            job.start()
        }
    }

    private fun setJevError(code: String?) {
        synchronized(lock) {
            local = local.copy(jev = (local.jev ?: LocalJev()).copy(error = code))
            saveLocal()
        }
        changed()
    }

    /** Jev on this phone: on, off, a new key, or ([removeKey]) none. The key stays here, encrypted like mail passwords. */
    fun setJev(on: Boolean? = null, key: String? = null, removeKey: Boolean = false): CategoriesState {
        val j = synchronized(lock) {
            var j = local.jev ?: LocalJev()
            if (!key.isNullOrBlank()) j = j.copy(key = secrets.encrypt(key.trim()))
            if (removeKey) j = j.copy(key = null)
            if (on != null) j = j.copy(on = on && j.key != null)
            j = j.copy(error = null)
            local = local.copy(jev = j)
            jevBusyUntil = 0
            jevGeneration++
            retryTimer?.cancel()
            retryTimer = null
            saveLocal()
            j
        }
        changed()
        if (j.on) soon(0)
        return state.value
    }

    /** Whether Jev sorts mail on this phone, which the privacy page names. */
    val jevOn: Boolean get() = state.value.jev.on

    fun close() {
        synchronized(lock) {
            timer?.cancel()
            retryTimer?.cancel()
        }
    }

    companion object {
        const val MAX_CATEGORIES = 12
        const val SORT_AFTER = 1500L
        private const val SETTING = "categories"
        private const val JEV_AT_ONCE = 3

        // Below this, Jev's choice is a guess, and the email goes to the category for when Rukoo isn't sure.
        const val JEV_CONFIDENT = 0.5
        private const val JEV_WAIT_MS = 5 * 60 * 1000L
        val COLORS = listOf("#ff5d73", "#4a7dff", "#2fd6c0", "#f5c542", "#c56cf0", "#ff8a3d", "#5ec2ff", "#7a808e")
        private val COLLECTIONS = setOf("category", "classification", "override", "sender", "setting")
        private val COLOR = Regex("#[0-9a-f]{6}", RegexOption.IGNORE_CASE)
        private const val TAG = "Categories"

        fun lower(address: String?): String = address.orEmpty().trim().lowercase()

        private fun sha256Hex(text: String): String =
            MessageDigest.getInstance("SHA-256").digest(text.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }

        private fun JsonObject?.flag(name: String): Boolean = (this?.get(name) as? JsonPrimitive)?.let { !it.isString && it.content == "true" } == true

        /** A string field that JavaScript reads as true: present, a string, not empty. */
        private fun JsonObject?.text(name: String): String? = (this?.get(name) as? JsonPrimitive)?.takeIf { it.isString && it.content.isNotEmpty() }?.content

        /** Number(v.order), or null where JavaScript would get NaN or 0 from nothing. */
        private fun JsonObject?.number(name: String): Double? = (this?.get(name) as? JsonPrimitive)?.let { p -> if (p.isString) p.content.trim().toDoubleOrNull() else p.doubleOrNull }

        private fun Map<String, JsonElement>.plus(pair: Pair<String, JsonElement>): Map<String, JsonElement> = LinkedHashMap(this).also { it[pair.first] = pair.second }
    }
}

/** Random hex for new category ids, like desktop's crypto.randomBytes(5).toString('hex'). */
internal object AccountKeysHex {
    fun random(bytes: Int): String = nl.bvdm.rukoo.account.AccountKeys.randomBytes(bytes).joinToString("") { "%02x".format(it) }
}
