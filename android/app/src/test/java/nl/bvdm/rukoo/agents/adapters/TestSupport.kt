package nl.bvdm.rukoo.agents.adapters

import java.io.File
import java.util.Locale
import java.util.concurrent.CopyOnWriteArrayList
import javax.xml.parsers.DocumentBuilderFactory
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.delay
import kotlinx.coroutines.withTimeout
import nl.bvdm.rukoo.R
import nl.bvdm.rukoo.agents.McpGrant
import nl.bvdm.rukoo.agents.TurnFile
import nl.bvdm.rukoo.agents.TurnHandle
import nl.bvdm.rukoo.agents.model.AdapterEvent
import nl.bvdm.rukoo.agents.model.ApprovalRequest
import nl.bvdm.rukoo.agents.model.Conversation
import org.w3c.dom.Element

/** The English catalog itself, read from strings_agent_adapters.xml, so tests check the texts users see. */
class XmlTexts(dir: String = "values") : AdapterTexts {
    val strings = HashMap<String, String>()
    val plurals = HashMap<String, Map<String, String>>()

    init {
        val doc = DocumentBuilderFactory.newInstance().newDocumentBuilder().parse(File("src/main/res/$dir/strings_agent_adapters.xml"))
        val s = doc.getElementsByTagName("string")
        for (i in 0 until s.length) {
            val e = s.item(i) as Element
            strings[e.getAttribute("name")] = e.textContent
        }
        val p = doc.getElementsByTagName("plurals")
        for (i in 0 until p.length) {
            val e = p.item(i) as Element
            val items = e.getElementsByTagName("item")
            plurals[e.getAttribute("name")] = (0 until items.length).associate { j ->
                val item = items.item(j) as Element
                item.getAttribute("quantity") to item.textContent
            }
        }
    }

    private fun nameOf(id: Int, cls: Class<*>): String = cls.fields.first { it.getInt(null) == id }.name

    private fun format(pattern: String, args: Array<out Any>) = String.format(Locale.ROOT, pattern.replace("\\'", "'").replace("\\\"", "\""), *args)

    override fun get(id: Int, vararg args: Any): String = format(strings.getValue(nameOf(id, R.string::class.java)), args)

    override fun plural(id: Int, count: Int, vararg args: Any): String {
        val forms = plurals.getValue(nameOf(id, R.plurals::class.java))
        return format(forms[if (count == 1) "one" else "other"] ?: forms.getValue("other"), args)
    }
}

/** The app scope stand-in: supervised, so one failed background job can't take the others down. */
fun testScope() = CoroutineScope(SupervisorJob() + Dispatchers.Default)

/** A turn handle that records what the adapter does with it. */
class RecordingTurn(
    override val conversation: Conversation = Conversation(id = "c_mgx1_abc123", agent = "clark", title = "Invoice"),
    input: String = "[Rukoo conversation c_mgx1_abc123]\n\nhello",
    override val instructions: String = "INSTRUCTIONS",
    override val text: String = "hello",
    override val id: String = "t_abcdefghij",
    override val action: String? = null,
    override val skills: List<String> = emptyList(),
    override val firstTurn: Boolean = true,
    override val model: String? = null,
    override val effort: String? = null,
    override val files: List<TurnFile> = emptyList(),
    override val emails: List<String> = emptyList(),
    override val mcp: McpGrant = McpGrant(),
    /** The user's choice for an approval card; suspends while the card waits. */
    private val choose: suspend (ApprovalRequest) -> String = { "once" },
    private val recap: String = "RECAP INPUT",
) : TurnHandle {
    @Volatile override var input: String = input
        private set

    val events = CopyOnWriteArrayList<AdapterEvent>()
    val providers = CopyOnWriteArrayList<Map<String, String>>()
    val approvals = CopyOnWriteArrayList<ApprovalRequest>()
    val expired = CopyOnWriteArrayList<String>()

    @Volatile var accepted = 0
    @Volatile var startOvers = 0

    /** Cards still waiting, by key, so an expiry can answer them with `cancel` as the hub does. */
    private val waiting = java.util.concurrent.ConcurrentHashMap<String, CompletableDeferred<String>>()

    override fun emit(event: AdapterEvent) {
        events.add(event)
    }

    override suspend fun approve(request: ApprovalRequest): String {
        approvals.add(request)
        val waiter = CompletableDeferred<String>()
        request.key?.let { waiting[it] = waiter }
        // Whichever comes first: the scripted choice or an expiry.
        return coroutineScope {
            val choice = CompletableDeferred<String>()
            val pick = launch { choice.complete(choose(request)) }
            val expire = launch { choice.complete(waiter.await()) }
            val picked = choice.await()
            pick.cancel()
            expire.cancel()
            picked
        }
    }

    override fun expireApproval(itemOrKey: String) {
        expired.add(itemOrKey)
        waiting.remove(itemOrKey)?.complete("cancel")
    }

    override fun setProvider(patch: Map<String, String>) {
        providers.add(patch)
    }

    override fun accepted() {
        accepted++
    }

    override suspend fun startOver(): String {
        startOvers++
        input = recap
        return recap
    }

    fun text(): String = events.filterIsInstance<AdapterEvent.Text>().joinToString("") { it.delta }
}

/** Waits up to [ms] for [condition], polling. */
suspend fun eventually(ms: Long = 5_000, condition: () -> Boolean) {
    withTimeout(ms) {
        while (!condition()) delay(10)
    }
}
