package nl.bvdm.rukoo.categories

import java.io.IOException
import java.text.Normalizer
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import nl.bvdm.rukoo.core.RukooJson
import nl.bvdm.rukoo.mail.model.MessageSummary
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response

/** Jev's choice for one email. */
data class JevAnswer(val category: String, val confidence: Double, val model: String)

/** A failed Jev call: `key` (TypeSafe refused the key), `busy`, `server`, `network` or `answer` (a choice it didn't offer). */
class JevError(val code: String, val status: Int = 0) : Exception(code)

/** What sorting needs of Jev; tests pass a fake. */
interface JevApi {
    val model: String

    suspend fun classify(key: String, m: MessageSummary, categories: List<Category>, toMe: Boolean): JevAnswer
}

/**
 * Jev, TypeSafe's decision model: one choice question per email, with the person's categories as the options and
 * their descriptions as what each option means (https://docs.typesafe.ai). A port of desktop's
 * src/main/categories/jev.js, with the same request, so both apps sort alike.
 */
class Jev(base: OkHttpClient, private val endpoint: String = ENDPOINT) : JevApi {
    private val client = base.newBuilder()
        .callTimeout(TIMEOUT_S, TimeUnit.SECONDS)
        .readTimeout(TIMEOUT_S, TimeUnit.SECONDS)
        .followRedirects(false)
        .build()

    override val model: String = MODEL

    // The answer is read off the main thread, whoever asks.
    override suspend fun classify(key: String, m: MessageSummary, categories: List<Category>, toMe: Boolean): JevAnswer =
        withContext(Dispatchers.IO) { ask(key, m, categories, toMe) }

    private suspend fun ask(key: String, m: MessageSummary, categories: List<Category>, toMe: Boolean): JevAnswer {
        val names = optionNames(categories)
        val request = Request.Builder().url(endpoint)
            .header("Authorization", "Bearer $key")
            .post(RukooJson.encodeToString(JsonObject.serializer(), body(m, categories, names, toMe)).toRequestBody(JSON))
            .build()
        val response = try {
            client.newCall(request).await()
        } catch (e: IOException) {
            throw JevError("network")
        }
        val json = response.use { res ->
            val text = try {
                val source = res.body?.source()
                if (source == null) {
                    ""
                } else {
                    // An answer takes a few hundred bytes; a larger one isn't read into memory.
                    source.request(MAX_ANSWER + 1)
                    if (source.buffer.size > MAX_ANSWER) throw JevError("server", res.code)
                    source.buffer.readUtf8()
                }
            } catch (e: IOException) {
                throw JevError("network")
            }
            val parsed = runCatching { RukooJson.parseToJsonElement(text) as? JsonObject }.getOrNull()
            if (res.code !in 200..299 || parsed == null) {
                throw JevError(
                    when (res.code) {
                        401, 403 -> "key"
                        429, 529 -> "busy"
                        else -> "server"
                    },
                    res.code,
                )
            }
            parsed
        }
        return answer(json, names)
    }

    private suspend fun Call.await(): Response = suspendCancellableCoroutine { cont ->
        enqueue(
            object : Callback {
                // A response that comes after the caller went away is closed, so its connection isn't held.
                override fun onResponse(call: Call, response: Response) = cont.resume(response) { _, value, _ -> value.close() }

                override fun onFailure(call: Call, e: IOException) {
                    if (!cont.isCancelled) cont.resumeWithException(e)
                }
            },
        )
        cont.invokeOnCancellation { runCatching { cancel() } }
    }

    companion object {
        const val ENDPOINT = "https://api.typesafe.ai/v1/systemone"

        /** A fixed version, so the sorting doesn't change when TypeSafe moves jev-latest. */
        const val MODEL = "jev-1.13.0"

        /** How much of an email's text goes along. */
        const val TEXT_CHARS = 1000
        private const val TIMEOUT_S = 20L

        /** The most of an answer that is read. */
        const val MAX_ANSWER = 1024L * 1024

        /**
         * What a model name the answer gives may look like. It is stored with every classification, so anything else,
         * such as most of a megabyte from a compromised endpoint, is stored as [MODEL] instead.
         */
        private val MODEL_NAME = Regex("[a-z0-9.-]{1,40}")
        private val JSON = "application/json".toMediaType()
        private val MARKS = Regex("[\\u0300-\\u036f]")
        private val NOT_WORD = Regex("[^a-z0-9]+")
        private val EDGES = Regex("^_+|_+$")

        /** An option name for each category id: its name in lowercase words, which the model reads, made unique. */
        fun optionNames(categories: List<Category>): LinkedHashMap<String, String> {
            val names = LinkedHashMap<String, String>()
            val taken = HashSet<String>()
            for (c in categories) {
                val base = EDGES.replace(NOT_WORD.replace(MARKS.replace(Normalizer.normalize(c.name.ifEmpty { c.id }, Normalizer.Form.NFKD), "").lowercase(), "_"), "")
                    .take(40).ifEmpty { "category" }
                var name = base
                var i = 2
                while (name in taken) name = "${base}_${i++}"
                taken += name
                names[c.id] = name
            }
            return names
        }

        /** What Jev reads about one email. Nothing else of the mail leaves the phone. */
        fun emailState(m: MessageSummary, toMe: Boolean): JsonObject {
            val s = m.signals ?: MailSignals()
            return buildJsonObject {
                putJsonObject("from") {
                    put("name", m.from.name)
                    put("address", m.from.address)
                }
                put("addressed_to_me", toMe)
                put("subject", m.subject)
                put("text", m.preview.take(TEXT_CHARS))
                put("has_attachments", m.hasAttachments)
                put("mailing_list", s.list)
                put("sent_in_bulk", s.bulk)
                put("sent_automatically", s.auto)
                put("marketing_software", s.campaign)
                if (!m.gmailTab.isNullOrEmpty()) put("gmail_tab", m.gmailTab)
            }
        }

        fun body(m: MessageSummary, categories: List<Category>, names: Map<String, String>, toMe: Boolean): JsonObject = buildJsonObject {
            put("model", MODEL)
            put("state", emailState(m, toMe))
            putJsonObject("questions") {
                putJsonObject("category") {
                    put("type", "choice")
                    put(
                        "instructions",
                        "Which of these inbox categories does this email belong in? Read each category's description. When more than one fits, choose the one listed first.",
                    )
                    putJsonObject("criteria") {
                        for (c in categories) put(names.getValue(c.id), c.description.ifEmpty { c.name })
                    }
                }
            }
        }

        /** The category id Jev chose, with its confidence and model; [JevError] `answer` for a choice it wasn't offered. */
        fun answer(res: JsonObject, names: Map<String, String>): JevAnswer {
            val answer = (res["answers"] as? JsonObject)?.get("category") as? JsonObject
            val choice = (answer?.get("choice") as? JsonPrimitive)?.content
            val chosen = names.entries.firstOrNull { it.value == choice } ?: throw JevError("answer")
            val confidence = (answer?.get("confidence") as? JsonPrimitive)?.doubleOrNull ?: 0.0
            val model = (res["model"] as? JsonPrimitive)?.takeIf { it.isString }?.content?.takeIf { MODEL_NAME.matches(it) } ?: MODEL
            return JevAnswer(chosen.key, confidence, model)
        }
    }
}
