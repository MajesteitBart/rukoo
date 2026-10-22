package nl.bvdm.rukoo.agents

import java.io.File
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import nl.bvdm.rukoo.core.RukooJson
import nl.bvdm.rukoo.mail.model.Address
import nl.bvdm.rukoo.mail.model.AttachmentInfo
import nl.bvdm.rukoo.mail.model.FullMessage
import nl.bvdm.rukoo.mail.model.MessageSummary
import nl.bvdm.rukoo.mail.model.Unsubscribe

/**
 * What desktop Rukoo's own code produced, made by src/test/agent-fixtures/make-fixtures.js (it runs context.js,
 * hub.js, skills.js and ownskills.js in Node). The tests feed the same input to the port and compare.
 */
object Fixtures {
    fun json(name: String): JsonObject {
        val stream = requireNotNull(javaClass.getResourceAsStream("/agents/$name")) { "missing fixture $name" }
        return RukooJson.parseToJsonElement(stream.use { it.readBytes().toString(Charsets.UTF_8) }).jsonObject
    }

    fun dir(name: String): File = File(requireNotNull(javaClass.getResource("/agents/$name")).toURI())

    /** The repository's skills/ folder: the skills the APK bundles. */
    val bundledSkills: File = listOf(File("../../skills"), File("../skills"), File("skills")).first { File(it, "data-deletion-request").isDirectory }

    fun str(e: JsonElement?): String? = (e as? JsonPrimitive)?.takeIf { it !is JsonNull }?.content

    fun address(e: JsonElement?): Address? = (e as? JsonObject)?.let { Address(str(it["name"]).orEmpty(), str(it["address"]).orEmpty()) }

    /** Desktop's getMessage() shape as the phone's FullMessage. */
    fun full(e: JsonElement?): FullMessage? {
        val o = e as? JsonObject ?: return null
        val id = str(o["id"])!!
        val from = address(o["from"]) ?: Address()
        val to = o["to"]!!.jsonArray.map { address(it)!! }
        val cc = o["cc"]?.jsonArray?.map { address(it)!! }.orEmpty()
        val summary = MessageSummary(
            id = id, accountId = id.substringBefore(':'), folder = str(o["folder"]).orEmpty(), uid = 1,
            messageId = str(o["messageId"]), subject = str(o["subject"]).orEmpty(), from = from, to = to, cc = cc, date = o["date"]!!.jsonPrimitive.long,
        )
        return FullMessage(
            summary = summary,
            text = str(o["text"]).orEmpty(),
            unsubscribe = if (o["unsubscribe"]?.jsonPrimitive?.booleanOrNull == true) Unsubscribe(url = "https://example.com/unsubscribe") else null,
            attachments = o["attachments"]!!.jsonArray.map {
                val a = it.jsonObject
                AttachmentInfo(a["index"]!!.jsonPrimitive.long.toInt(), str(a["filename"]).orEmpty(), str(a["contentType"]).orEmpty(), a["size"]!!.jsonPrimitive.long)
            },
        )
    }
}
