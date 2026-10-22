package nl.bvdm.rukoo.mcp

import kotlinx.serialization.json.Json
import nl.bvdm.rukoo.mcp.tools.DraftHtml
import nl.bvdm.rukoo.mcp.tools.DraftWriter
import nl.bvdm.rukoo.mcp.tools.MailLookup
import nl.bvdm.rukoo.mcp.tools.PlainText
import nl.bvdm.rukoo.mcp.tools.ToolError
import nl.bvdm.rukoo.mcp.tools.ToolList
import nl.bvdm.rukoo.mcp.tools.Validator
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.fail
import org.junit.Test

class ToolHelpersTest {
    private fun validate(tool: String, args: String): String =
        Validator.validate(ToolList.byName(tool)!!.inputSchema, Json.parseToJsonElement(args), "arguments").toString()

    private fun failure(tool: String, args: String): String = try {
        validate(tool, args)
        fail("no error")
        ""
    } catch (e: ToolError) {
        e.message!!
    }

    // desktop validate(): lenient where models slip, strict where the user approves what is shown.
    @Test
    fun validatesLikeDesktop() {
        assertEquals("""{"query":"42","unread":true,"limit":5}""", validate("search_mail", """{"query":42,"unread":"true","limit":"5","extra":1}"""))
        assertEquals("""{"limit":5}""", validate("search_mail", """{"limit":5.0,"query":null}"""))
        assertEquals("arguments.limit must be a whole number.", failure("search_mail", """{"limit":1.5}"""))
        assertEquals("arguments.unread must be true or false.", failure("search_mail", """{"unread":"yes"}"""))
        assertEquals("arguments must be an object.", failure("search_mail", "[]"))
        assertEquals("arguments.message_id is required.", failure("read_message", """{"message_id":""}"""))
        // One id where a list goes, and tags dropped from copied values.
        assertEquals(
            """{"action":"star","message_ids":["demo:INBOX:1"]}""",
            validate("mail_action", """{"action":"star","message_ids":"<unsafe_content>demo:INBOX:1</unsafe_content>"}"""),
        )
        assertEquals("arguments.message_ids needs at least 1 item(s).", failure("mail_action", """{"action":"star","message_ids":[]}"""))
        // A person: a string, or an object with an address.
        assertEquals("""{"to":["a@b.c",{"address":"d@e.f"}],"body":"x"}""", validate("write_draft", """{"to":["a@b.c",{"address":"d@e.f","x":1}],"body":"x"}"""))
        assertEquals("arguments.to[0].address is required.", failure("write_draft", """{"to":[{"name":"No address"}],"body":"x"}"""))
        // Text past maxLength is cut without splitting a tag; the body keeps its tags.
        val long = """{"subject":"${"s".repeat(1005)}","body":"<unsafe_content>quoted</unsafe_content>"}"""
        val out = Json.parseToJsonElement(validate("write_draft", long)) as kotlinx.serialization.json.JsonObject
        assertEquals(1000, (out["subject"] as kotlinx.serialization.json.JsonPrimitive).content.length)
        assertEquals("<unsafe_content>quoted</unsafe_content>", (out["body"] as kotlinx.serialization.json.JsonPrimitive).content)
        assertEquals("arguments.tasks[0].status must be one of: proposed, todo, running, done, failed, skipped.", failure("show_plan", """{"tasks":[{"status":"maybe"}]}"""))
    }

    // Outputs of desktop's markdown.js for the same input.
    @Test
    fun formatsDraftsLikeDesktop() {
        val md = "Hi **Sanne**,\n\nThursday works. See https://example.com/a.\n\n- one\n- two _it_\n\n> quoted *x*\n\n# Head\n\n---\n\n```\ncode <b>\n```\n1. first\n2) second\n[link](https://x.y \"t\") and [bad](javascript:alert(1)) mailto:me@x.nl snake_case_name"
        assertEquals(
            "<div>Hi <b>Sanne</b>,</div><div><br></div><div>Thursday works. See <a href=\"https://example.com/a\">https://example.com/a</a>.</div><div><br></div><ul><li>one</li><li>two <i>it</i></li></ul><div><br></div><blockquote><div>quoted <i>x</i></div></blockquote><div><br></div><div><b>Head</b></div><div><br></div><hr><div><br></div><pre><code>code &lt;b&gt;</code></pre><ol><li>first</li><li>second</li></ol><div><a href=\"https://x.y\">link</a> and bad) <a href=\"mailto:me@x.nl\">me@x.nl</a> snake_case_name</div>",
            DraftHtml.toHtml(md),
        )
        assertEquals("<div>line &lt;1&gt;</div><div><br></div><div>line &quot;2&quot;</div>", DraftHtml.toHtml("line <1>\n\nline \"2\"", "text"))
        assertEquals("<b>raw</b>", DraftHtml.toHtml("<b>raw</b>", "html"))
        assertEquals("Hi Sanne,\n\n * one\n * two\n\n> quoted", PlainText.fromHtml(DraftHtml.toHtml("Hi **Sanne**,\n\n- one\n- two\n\n> quoted")))
    }

    @Test
    fun readsRecipientsAndSubjects() {
        val people = DraftWriter.people(listOf(Json.parseToJsonElement("\"\\\"Last, First\\\" <lf@x.nl>, plain@x.nl\"")), "to")!!
        assertEquals(listOf("Last, First" to "lf@x.nl", "" to "plain@x.nl"), people.map { it.name to it.address })
        assertNull(DraftWriter.people(null, "to"))
        assertEquals("Re: Hello", DraftWriter.prefixed("Hello", "Re"))
        assertEquals("Antw: Hello", DraftWriter.prefixed("Antw: Hello", "Re"))
        assertEquals("Fwd: Re: Hello", DraftWriter.prefixed("Re: Hello", "Fwd"))
        assertEquals("hello world", MailLookup.baseSubject("Re: Fwd [2]: AW:  Hello   World"))
        assertEquals("cafe", MailLookup.fold("Café"))
        assertEquals("2026-10-22T16:00:00.000Z", MailLookup.iso(java.time.Instant.parse("2026-10-22T16:00:00Z").toEpochMilli()))
        assertNull(MailLookup.iso(0))
        assertEquals("<a@b.c>", MailLookup.headerId(" <a@b.c> "))
        assertEquals("<unsafe_content>not an id</unsafe_content>", MailLookup.headerId("not an id"))
    }
}
