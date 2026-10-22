package nl.bvdm.rukoo.mcp.tools

import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.Charset
import java.nio.charset.CodingErrorAction
import java.util.Base64
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import nl.bvdm.rukoo.core.RukooJson
import nl.bvdm.rukoo.core.Unsafe

/** What a tool returns: plain data (sent as text and as structuredContent), or MCP content blocks as they are. */
sealed interface ToolOut {
    data class Data(val value: JsonObject) : ToolOut

    data class Raw(val content: JsonArray, val structured: JsonObject? = null) : ToolOut
}

/**
 * A file as read_attachment and read_chat_file hand it out (tools.js:918-969): text as text, an image as an image,
 * a PDF as a resource, anything else as a resource. Every MCP caller of the phone is remote, so there is never a
 * local_path. The phone has no PDF reader (design.md): a PDF's text is reported as failed and the file goes along
 * as a resource, so an agent with its own reader can still read it.
 */
object FileResults {
    const val ATTACHMENT_MAX = 10 * 1024 * 1024
    private const val ATTACHMENT_TEXT_MAX = 200000
    private const val IMAGE_MAX = 5 * 1024 * 1024

    private val TEXT_TYPES = Regex("^(text/|application/(json|xml|csv|x-yaml|yaml|ics)\\b)")
    private val TEXT_EXT = Regex("\\.(csv|md|markdown|ics|txt|json|xml|yaml|yml|log|vcf)$", RegexOption.IGNORE_CASE)
    private val IMAGE_TYPES = Regex("^image/(png|jpeg|gif|webp)$")
    private val MIME_FORM = Regex("^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$")

    /**
     * Programs and launchers are never handed out from mail (files.js:7). Android adds its own packages
     * (apk, apks, xapk, aab), which spec 2 suggests.
     */
    val RISKY = Regex(
        "\\.(dmg|pkg|mpkg|command|tool|terminal|scpt|scptd|applescript|workflow|app|prefpane|fileloc|inetloc|webloc|exe|bat|cmd|com|scr|pif|lnk|url|hta|js|jse|vbs|vbe|wsf|wsh|ps1|psm1|psd1|msi|msp|mst|reg|cpl|jar|appref-ms|application|gadget|inf|scf|sct|chm|iso|img|vhd|vhdx|msc|xll|library-ms|settingcontent-ms|sh|bash|zsh|fish|ksh|csh|desktop|appimage|run|apk|apks|xapk|aab)$",
        RegexOption.IGNORE_CASE,
    )

    private val UNSAFE_NAME = Regex("[<>:\"|?*\\u0000-\\u001f\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069]")
    private val NAME_EDGES = Regex("^[.\\s]+|[.\\s]+$")

    /** One safe file name: no folders, no bidi tricks (files.js safeName). */
    fun safeName(name: String?): String {
        val flat = name.orEmpty().replace(Regex("[\\\\/]"), "_").replace(UNSAFE_NAME, "_").replace(NAME_EDGES, "")
        return flat.ifEmpty { "attachment" }
    }

    /** The MIME type a sender declared, without parameters, if it has the plain type/subtype form. */
    fun mimeType(v: String?): String {
        val s = v.orEmpty().substringBefore(';').trim().lowercase()
        return if (MIME_FORM.matches(s)) s else "application/octet-stream"
    }

    /** A PDF by its bytes, whatever its name says: the first KB holds `%PDF-`. */
    fun isPdf(bytes: ByteArray): Boolean {
        val head = String(bytes, 0, minOf(bytes.size, 1024), Charsets.ISO_8859_1)
        return head.contains("%PDF-")
    }

    fun sizeText(n: Long): String =
        if (n < 1024 * 1024) "${maxOf(1, Math.round(n / 1024.0))} KB" else String.format(java.util.Locale.ROOT, "%.1f MB", n / 1024.0 / 1024.0)

    /** The charset parameter of a Content-Type value, if any. */
    fun charsetOf(type: String?): String? = Regex("charset=\"?([^\";\\s]+)", RegexOption.IGNORE_CASE).find(type.orEmpty())?.groupValues?.get(1)

    /** Mail text in the charset it declares, as desktop's decodeCharset: UTF-8 when Java doesn't know it. */
    fun decodeCharset(bytes: ByteArray, charset: String?): String {
        val cs = runCatching { Charset.forName(charset.orEmpty().ifEmpty { "utf-8" }.trim()) }.getOrNull() ?: Charsets.UTF_8
        return String(bytes, cs)
    }

    /** A user's text file: UTF-16 or UTF-8 by its byte order mark, else strict UTF-8, else Windows-1252 (chatfiles.js). */
    fun decodeText(bytes: ByteArray): String {
        if (bytes.size >= 2 && bytes[0] == 0xff.toByte() && bytes[1] == 0xfe.toByte()) return String(bytes, 2, bytes.size - 2, Charsets.UTF_16LE)
        if (bytes.size >= 2 && bytes[0] == 0xfe.toByte() && bytes[1] == 0xff.toByte()) return String(bytes, 2, bytes.size - 2, Charsets.UTF_16BE)
        val start = if (bytes.size >= 3 && bytes[0] == 0xef.toByte() && bytes[1] == 0xbb.toByte() && bytes[2] == 0xbf.toByte()) 3 else 0
        return try {
            Charsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(bytes, start, bytes.size - start))
                .toString()
        } catch (_: CharacterCodingException) {
            String(bytes, start, bytes.size - start, Charset.forName("windows-1252"))
        }
    }

    /**
     * [info] is what the result says about the file (its tagged name and type); [name] and [type] are what Rukoo
     * goes by. The text sits inside `<unsafe_content>`; [source] says where it came from.
     */
    suspend fun result(
        info: JsonObject,
        name: String,
        type: String,
        content: ByteArray,
        uri: String,
        source: String,
        decode: (ByteArray) -> String,
    ): ToolOut = withContext(Dispatchers.Default) {
        val pdf = isPdf(content)
        if (!pdf && (TEXT_TYPES.containsMatchIn(type) || TEXT_EXT.containsMatchIn(name))) {
            val text = decode(content).removePrefix("﻿")
            return@withContext ToolOut.Data(
                info.plus(
                    "text" to Unsafe.block(text.take(ATTACHMENT_TEXT_MAX), mapOf("source" to source, "filename" to name)),
                    "truncated" to (text.length > ATTACHMENT_TEXT_MAX),
                ),
            )
        }
        if (IMAGE_TYPES.matches(type) && content.size <= IMAGE_MAX) {
            // No structured result: Codex passes only that on when there is one, and the image would never reach it.
            // The note comes before the image: it cannot carry tags, and its text can be anyone's.
            val note = info.plus("note" to "The image follows. ${Unsafe.IMAGE_DATA}")
            return@withContext ToolOut.Raw(
                JsonArray(
                    listOf(
                        textBlock(note),
                        buildJsonObject {
                            put("type", "image")
                            put("data", Base64.getEncoder().encodeToString(content))
                            put("mimeType", type)
                        },
                    ),
                ),
            )
        }
        val resource = buildJsonObject {
            put("type", "resource")
            put(
                "resource",
                buildJsonObject {
                    put("uri", uri)
                    put("mimeType", type)
                    put("blob", Base64.getEncoder().encodeToString(content))
                },
            )
        }
        if (pdf) {
            // No reader on the phone: the agent gets the file and is told why there is no text.
            val note = "Rukoo could not extract text from this PDF: ${Unsafe.PDF_FAILED_ERROR}. The file itself is attached as a resource. ${Unsafe.FILE_DATA}"
            val full = info.plus("failed" to "error", "note" to note)
            return@withContext ToolOut.Raw(JsonArray(listOf(textBlock(full), resource)), full)
        }
        // An Office file, an archive, or an image too big to show as one: it reaches the agent without tags.
        val full = info.plus("note" to "The file is attached as a resource. ${if (IMAGE_TYPES.matches(type)) Unsafe.IMAGE_DATA else Unsafe.FILE_DATA}")
        ToolOut.Raw(JsonArray(listOf(textBlock(full), resource)), full)
    }

    fun textBlock(data: JsonObject): JsonObject = buildJsonObject {
        put("type", "text")
        put("text", RukooJson.encodeToString(JsonElement.serializer(), data))
    }
}

/** The same object with more keys at the end, in order. */
internal fun JsonObject.plus(vararg entries: Pair<String, Any?>): JsonObject {
    val out = LinkedHashMap<String, JsonElement>(this)
    for ((k, v) in entries) out[k] = toJson(v)
    return JsonObject(out)
}

internal fun toJson(v: Any?): JsonElement = when (v) {
    null -> kotlinx.serialization.json.JsonNull
    is JsonElement -> v
    is String -> kotlinx.serialization.json.JsonPrimitive(v)
    is Boolean -> kotlinx.serialization.json.JsonPrimitive(v)
    is Number -> kotlinx.serialization.json.JsonPrimitive(v)
    else -> kotlinx.serialization.json.JsonPrimitive(v.toString())
}
