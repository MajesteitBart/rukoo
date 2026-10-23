package nl.bvdm.rukoo.agents.model

import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import nl.bvdm.rukoo.core.RukooJson
import nl.bvdm.rukoo.mail.model.Address
import nl.bvdm.rukoo.mail.model.MessagePin
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ItemSerializationTest {
    private val at = 1761130000000L

    private val everyType: List<Item> = listOf(
        Item.User("i_user000001", at, "Draft a reply", "reply", listOf(ShownFile("f_1", "a.pdf", 10, "application/pdf", "pdf")), listOf(AttachedEmail("demo:INBOX:1", "Hi", Address("A", "a@x.nl")))),
        Item.Assistant("i_assist0001", at, "Hello", AssistantStatus.STREAMING, interim = true),
        Item.Thinking("i_think00001", at, "hmm", ThinkingStatus.DONE, at, at + 4000),
        Item.Tool("i_tool000001", at, "mcp__rukoo__search_mail", "Searched mail", "from:sanne", ToolStatus.ERROR, at, at + 10, rukoo = true),
        Item.Approval(
            "i_approval01", at, "Run a command", "detail",
            listOf(ApprovalField("Command", "ls -la", "command", 12)),
            ApprovalTool("terminal", ToolKind.READ_FILE, "srv", "tool"),
            listOf(ApprovalChoice("once", "Allow once", ChoiceKind.PRIMARY), ApprovalChoice("deny", "Deny", ChoiceKind.DANGER)),
            ApprovalStatus.DENIED, "deny", "rukoo", "clark", ApprovalKind.MAIL,
            MailApproval("move", listOf("demo:INBOX:1"), "Archive", listOf(MessagePin("<a@b>", "1"))),
        ),
        Item.Notice(
            "i_notice0001", at, "Archived 2 emails", "x", Tone.SUCCESS, "kept-approval",
            NoticeUndo("move", listOf("demo:INBOX:1")), NoticeParams("t"), NoticeMail("archive", 2, 0, "Archive", 0, null, 0, null),
        ),
        Item.Draft("i_draft00001", at, DraftMode.REPLY_ALL, listOf(Address("Sanne", "sanne@example.com")), "Re: Call", "Hi Sanne", "demo:INBOX:12", "c1", true, "d1"),
        Item.Plan("i_plan000001", at, "p1", "Follow-ups", TaskStatus.entries.mapIndexed { i, s -> PlanTask("t$i", "Task $i", status = s, url = if (i == 0) "https://x" else null) }),
        Item.Sources("i_source0001", at, "Used", listOf(SourceRef("Call", "Email", "snip", null, "demo:INBOX:12", "<demo-13@example.com>", "demo"))),
    )

    @Test
    fun everyTypeRoundTripsWithItsDesktopName() {
        val names = listOf("user", "assistant", "thinking", "tool", "approval", "notice", "draft", "plan", "sources")
        for ((item, name) in everyType.zip(names)) {
            val json = RukooJson.encodeToString(Item.serializer(), item)
            val obj = RukooJson.parseToJsonElement(json).jsonObject
            assertEquals(json, name, obj["type"]?.jsonPrimitive?.content)
            assertEquals(item, RukooJson.decodeFromString(Item.serializer(), json))
        }
    }

    @Test
    fun enumsUseDesktopsWords() {
        val json = RukooJson.encodeToString(Item.serializer(), everyType[4])
        assertTrue(json, "\"kind\":\"readFile\"" in json)
        assertTrue(json, "\"status\":\"denied\"" in json)
        assertTrue(json, "\"kind\":\"mail\"" in json)
        val draft = RukooJson.encodeToString(Item.serializer(), everyType[6])
        assertTrue(draft, "\"mode\":\"reply_all\"" in draft)
    }

    // A conversation as desktop's hub writes it (spec 1 §1.2-1.4): nulls, `unread: false`, and a field this version doesn't know.
    private val desktopFile = """
        {"version":1,"conversations":[{
          "id":"c_mh1vbwxs_ab12cd","agent":"clark","title":"Call on Thursday",
          "message":{"id":"demo:INBOX:12","messageId":"<demo-13@example.com>","accountId":"demo","subject":"Call on Thursday",
                     "from":{"name":"Sanne de Vries","address":"sanne@example.com"},"date":1761040000000,"unsubscribe":false,
                     "references":["<demo-13@example.com>"]},
          "origin":"panel","createdAt":1761130000000,"updatedAt":1761130060000,"status":"idle",
          "model":null,"effort":"high","provider":{"sessionId":"s-1"},"notes":["The user declined: x."],
          "delivered":true,"needsRecap":false,"unread":false,
          "continued":[{"id":"demo:INBOX:20","messageId":null,"accountId":"demo","subject":"Re: Call","from":null,"date":null,"unsubscribe":false,"at":1761130030000,"pending":true}],
          "files":[{"id":"f_0123456789","name":"a.png","file":"/files/c/f.png","size":5,"type":"image/png","kind":"image","at":1}],
          "somethingNew":42,
          "items":[
            {"type":"user","id":"i_aaaaaaaaaa","at":1761130000000,"text":"Draft a reply","action":"reply"},
            {"id":"i_bbbbbbbbbb","at":1761130001000,"type":"tool","name":"search_mail","label":"Searched mail","detail":"","status":"done","startedAt":1761130001000,"endedAt":null,"rukoo":true},
            {"type":"approval","id":"i_cccccccccc","at":1761130002000,"title":"Post in #sales","detail":"","fields":[{"label":"Channel","value":"#sales"}],
             "choices":[{"id":"approve","label":"Approve","kind":"primary"},{"id":"decline","label":"Decline","kind":"default"}],
             "status":"pending","decision":null,"source":"clark","kind":"proposal"},
            {"type":"plan","id":"i_dddddddddd","at":1761130003000,"planId":"p1","title":"","tasks":[{"id":"t1","title":"Reply","detail":"","system":"","status":"running","url":null,"owner":"","due":""}]},
            {"type":"assistant","id":"i_eeeeeeeeee","at":1761130004000,"text":"Done.","status":"done","interim":false}
          ]}]}
    """.trimIndent()

    @Test
    fun readsDesktopsConversationsFile() {
        val file = RukooJson.decodeFromString(ConversationsFile.serializer(), desktopFile)
        assertEquals(1, file.version)
        val c = file.conversations.single()
        assertEquals("clark", c.agent)
        assertEquals(Unread.NONE, c.unread)
        assertNull(c.model)
        assertEquals("high", c.effort)
        assertEquals("s-1", c.provider["sessionId"])
        assertEquals(listOf("<demo-13@example.com>"), c.message?.references)
        assertTrue(c.continued.single().pending)
        assertEquals(5, c.items.size)
        val approval = c.items[2] as Item.Approval
        assertEquals(ApprovalKind.PROPOSAL, approval.kind)
        assertNull(approval.decision)
        assertEquals(TaskStatus.RUNNING, (c.items[3] as Item.Plan).tasks.single().status)
        // And back: the same data, in the same shape.
        val again = RukooJson.decodeFromString(ConversationsFile.serializer(), RukooJson.encodeToString(ConversationsFile.serializer(), file))
        assertEquals(file, again)
    }

    @Test
    fun unreadIsFalseOrAWord() {
        val base = Conversation("c_1", "clark")
        fun unreadJson(u: Unread) = RukooJson.parseToJsonElement(RukooJson.encodeToString(Conversation.serializer(), base.copy(unread = u))).jsonObject["unread"]
        assertEquals(JsonPrimitive(false), unreadJson(Unread.NONE))
        assertEquals(JsonPrimitive("reply"), unreadJson(Unread.REPLY))
        assertEquals(JsonPrimitive("error"), unreadJson(Unread.ERROR))
        val read = RukooJson.decodeFromString(Conversation.serializer(), """{"id":"c_1","agent":"clark","unread":"error","items":[]}""")
        assertEquals(Unread.ERROR, read.unread)
        val odd = RukooJson.decodeFromString(Conversation.serializer(), """{"id":"c_1","agent":"clark","unread":"maybe"}""")
        assertEquals(Unread.NONE, odd.unread)
    }

    @Test
    fun parsesTheComputerHostStream() {
        val lines = listOf(
            """{"seq":1,"type":"started","turnId":"t_1","conversationId":"c_1","agent":"claude"}""",
            """{"seq":2,"type":"text","delta":"Hel"}""",
            """{"seq":3,"type":"tool-start","key":"k1","name":"Bash","detail":"ls"}""",
            """{"seq":4,"type":"provider","patch":{"sessionId":"abc"}}""",
            """{"seq":5,"type":"approval","approvalId":"a_1","card":{"title":"Run","fields":[{"key":"command","label":"Command","value":"ls"}],"tool":{"name":"Bash","kind":"command"},"choices":[{"id":"allow","label":"Allow","kind":"primary"}],"source":"claude","kind":"runtime"},"status":"pending"}""",
            """{"seq":6,"type":"thinking-done"}""",
            """{"seq":7,"type":"done","status":"error","error":{"code":"offline","detail":"x"}}""",
            """{"type":"ping"}""",
            """{"seq":8,"type":"usage","input_tokens":3}""",
        )
        val parsed = lines.map { HostStream.parse(it) }
        assertEquals(HostEvent.Started("t_1", "c_1", "claude"), parsed[0]?.host)
        assertEquals(AdapterEvent.Text("Hel"), parsed[1]?.event)
        assertEquals(2L, parsed[1]?.seq)
        assertEquals(AdapterEvent.ToolStart("k1", "Bash", "ls"), parsed[2]?.event)
        assertEquals(mapOf("sessionId" to "abc"), (parsed[3]?.host as HostEvent.Provider).patch)
        val approval = parsed[4]?.host as HostEvent.Approval
        assertEquals(ToolKind.COMMAND, approval.card.tool?.kind)
        assertEquals("command", approval.card.fields.single().key)
        assertEquals(AdapterEvent.ThinkingDone, parsed[5]?.event)
        assertEquals(HostEvent.Done(TurnStatus.ERROR, AgentErrorInfo("offline", "x")), parsed[6]?.host)
        assertEquals(HostEvent.Ping, parsed[7]?.host)
        assertNull(parsed[7]?.seq)
        assertEquals(AdapterEvent.Usage, parsed[8]?.event)
        assertNull(HostStream.parse("""{"seq":9,"type":"new-kind"}"""))
        assertNull(HostStream.parse("not json"))
        assertNull(HostStream.parse(""))
    }

    @Test
    fun builtInQuickActionsFollowDesktopRules() {
        val keys = QuickAction.BUILT_IN.map { it.key }
        assertEquals(listOf("reply", "brief", "tasks", "team", "update", "unsubscribe", "summary", "triage"), keys)
        val noEmail = QuickAction.BUILT_IN.filter { it.applies(emailOpen = false, unsubscribe = false) }.map { it.key }
        assertEquals(listOf("triage"), noEmail)
        val newsletter = QuickAction.BUILT_IN.filter { it.applies(emailOpen = true, unsubscribe = true) }.map { it.key }
        assertTrue("unsubscribe" in newsletter && "triage" !in newsletter)
        val plain = QuickAction.BUILT_IN.filter { it.applies(emailOpen = true, unsubscribe = false) }.map { it.key }
        assertTrue("unsubscribe" !in plain)
    }

    @Test
    fun computerAgentIds() {
        val id = AgentIds.computer("ph_k3j9x0m2qa", ComputerProgram.CODEX)
        assertEquals("computer:ph_k3j9x0m2qa:codex", id)
        assertEquals("ph_k3j9x0m2qa" to ComputerProgram.CODEX, AgentIds.parseComputer(id))
        assertNull(AgentIds.parseComputer("computer::claude"))
        assertNull(AgentIds.parseComputer("computer:ph_1:gemini"))
        assertNull(AgentIds.parseComputer("clark"))
        assertTrue(AgentIds.isKnown("openclaw"))
    }
}
