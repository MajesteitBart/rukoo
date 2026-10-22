package nl.bvdm.rukoo.agents.adapters

import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import nl.bvdm.rukoo.R
import nl.bvdm.rukoo.agents.AgentException
import nl.bvdm.rukoo.agents.model.ErrorCodes
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class SseAndHttpTest {
    private val texts = XmlTexts()

    private fun frames(vararg chunks: Any): List<SseFrame> {
        val out = mutableListOf<SseFrame>()
        val parser = SseParser { out.add(it) }
        for (c in chunks) {
            when (c) {
                is String -> parser.push(c)
                is ByteArray -> parser.push(c, c.size)
            }
        }
        parser.end()
        return out
    }

    @Test
    fun parsesNamedAndUnnamedFramesWithMultilineDataAndKeepalives() {
        val got = frames(": keepalive\n\nevent: run.completed\ndata: {\"a\":1}\n\ndata: one\ndata: two\nid: 7\n\n")
        assertEquals(listOf(SseFrame("run.completed", "{\"a\":1}"), SseFrame("message", "one\ntwo", "7")), got)
    }

    @Test
    fun handlesChunksSplitInsideLinesCrLfAndUtf8() {
        val euro = "data: €\n\n".toByteArray(Charsets.UTF_8)
        // The euro sign is three bytes; cut it in half, and cut \r\n between chunks.
        val got = frames("data: a\r", "\n\r\n", euro.copyOfRange(0, 7), euro.copyOfRange(7, euro.size), "data: lone\r\rdata: next\r")
        assertEquals(listOf("a", "€", "lone"), got.map { it.data })
    }

    @Test
    fun dropsAnUnterminatedFrameAndIgnoresIdsWithNul() {
        assertEquals(emptyList<SseFrame>(), frames("data: half"))
        assertNull(frames("id: a\u0000b\ndata: x\n\n").single().id)
        // A space after the colon is dropped once; a field without a colon has an empty value.
        assertEquals("  two", frames("data:   two\n\n").single().data)
    }

    @Test
    fun serverBaseKeepsAPrefixAndNormalizesTheAddress() {
        val base = ServerBase.parse("100.91.52.84:8642/p/clark/", texts)
        assertEquals("100.91.52.84:8642", base.host)
        assertEquals("http://100.91.52.84:8642/p/clark/v1/runs/r%201/events?last_seq=3", base.endpoint("/v1/runs/r%201/events?last_seq=3").toString())
        // dudan's rule: a pasted /v1 goes, the paths add it.
        assertEquals("https://h.example/api/sessions", ServerBase.parse("https://h.example/v1/", texts).endpoint("/api/sessions").toString())
        assertEquals("h.example", ServerBase.parse("https://h.example", texts).host)
    }

    @Test
    fun serverBaseRefusesOtherSchemesAndCredentials() {
        for ((url, message) in listOf(
            "ftp://h.example" to "The server URL must start with http:// or https://",
            "http://user:pw@h.example" to "The server URL is not valid",
            "http://" to "The server URL is not valid",
        )) {
            try {
                ServerBase.parse(url, texts)
                fail(url)
            } catch (e: AgentException) {
                assertEquals(ErrorCodes.NOT_CONFIGURED, e.code)
                assertEquals(message, e.detail)
            }
        }
    }

    @Test
    fun errorTextAndHttpErrorFollowDesktop() {
        assertEquals("nope", errorText(JsonPrimitive("  nope ")))
        assertEquals("bad key", errorText(buildJsonObject { putJsonObject("error") { put("message", "bad key") } }))
        assertEquals("flat", errorText(buildJsonObject { put("error", "flat") }))
        assertEquals("from detail", errorText(buildJsonObject { put("detail", "from detail") }))
        assertEquals(200, errorText(JsonPrimitive("x".repeat(500))).length)
        val e401 = httpError(HttpAnswer.of(401, "{\"error\":{\"message\":\"Invalid API key\"}}"))
        assertEquals(ErrorCodes.UNAUTHORIZED to "HTTP 401: Invalid API key", e401.code to e401.detail)
        assertEquals(ErrorCodes.RATE_LIMITED, httpError(HttpAnswer.of(429, "")).code)
        val e500 = httpError(HttpAnswer.of(500, "Internal Server Error"))
        assertEquals(ErrorCodes.PROTOCOL to "HTTP 500: Internal Server Error", e500.code to e500.detail)
        assertEquals("HTTP 502", httpError(HttpAnswer.of(502, "")).detail)
        // JSON.parse('starting') fails on desktop, so the text is the error text; a number or true is JSON.
        assertEquals("HTTP 503: starting", httpError(HttpAnswer.of(503, "starting")).detail)
        assertEquals("HTTP 500", httpError(HttpAnswer.of(500, "42")).detail)
    }

    @Test
    fun clipEndsInAnEllipsisWithinTheLimit() {
        assertEquals("abc", clip("abc", 3))
        assertEquals("ab…", clip("abcd", 3))
    }

    @Test
    fun truthinessIsJavaScripts() {
        assertTrue(JsonPrimitive("x").truthy())
        assertTrue(JsonPrimitive(1).truthy())
        assertTrue(!JsonPrimitive("").truthy() && !JsonPrimitive(0).truthy() && !JsonPrimitive(false).truthy())
        assertTrue(!kotlinx.serialization.json.JsonNull.truthy() && !(null as kotlinx.serialization.json.JsonElement?).truthy())
    }

    @Test
    fun catalogsHaveTheSameEntriesAndPlaceholdersInBothLanguages() {
        val en = XmlTexts("values")
        val nl = XmlTexts("values-nl")
        assertEquals(en.strings.keys, nl.strings.keys)
        assertEquals(en.plurals.keys, nl.plurals.keys)
        val placeholder = Regex("%(\\d+\\$)?[sd]")
        for ((k, v) in en.strings) assertEquals(k, placeholder.findAll(v).map { it.value }.toSet(), placeholder.findAll(nl.strings.getValue(k)).map { it.value }.toSet())
        // Every string the code names exists: the R ids resolve to catalog entries.
        for (f in R.string::class.java.fields.filter { it.name.startsWith("adapters_") }) assertTrue(f.name, f.name in en.strings)
    }
}
