package nl.bvdm.rukoo.agents

import nl.bvdm.rukoo.agents.model.ApprovalKind
import nl.bvdm.rukoo.agents.model.ApprovalStatus
import nl.bvdm.rukoo.agents.model.AssistantStatus
import nl.bvdm.rukoo.agents.model.ConversationStatus
import nl.bvdm.rukoo.agents.model.Item
import nl.bvdm.rukoo.agents.model.Origin
import nl.bvdm.rukoo.agents.model.ThinkingStatus
import nl.bvdm.rukoo.agents.model.ToolStatus
import nl.bvdm.rukoo.agents.model.Unread
import nl.bvdm.rukoo.core.RukooJson
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Loading conversations.json as desktop's hub writes it (hub.js:427-483). */
class ConversationStoreTest {
    /** A file shaped like desktop's, with what an older Rukoo and a crash leave behind. */
    val desktopFile = """
        {"version":1,"conversations":[
          {"id":"c_mh0abc_aaaaaa","agent":"clark","title":"Call on Thursday",
           "message":{"id":"acc1:INBOX:12","messageId":"<call-13@example.com>","accountId":"acc1","subject":"Call on Thursday",
                      "from":{"name":"Sanne","address":"sanne@example.com"},"date":1761000000000,"unsubscribe":false},
           "origin":"panel","createdAt":1761000000000,"updatedAt":1761000300000,"status":"running","model":"","effort":"turbo",
           "provider":{"sessionId":"s-1","threadId":"t-9","count":3,"nested":{"a":1}},"notes":["one",2,"two"],
           "unread":"reply","continued":[{"id":"acc1:INBOX:14","subject":"Re: Call","at":1761000200000,"pending":"yes"},{"subject":"no id"},"junk"],
           "files":[{"id":"f_1","file":"a.txt","name":"a.txt"},{"id":"f_2"}],
           "items":[
             {"type":"user","id":"i_1","at":1761000000001,"text":"Draft a reply","action":"reply"},
             {"type":"thinking","id":"i_2","at":1761000000002,"text":"hmm","status":"running","startedAt":1761000000002,"endedAt":null},
             {"type":"tool","id":"i_3","at":1761000000003,"name":"search_mail","label":"Searched mail","detail":"","status":"running","startedAt":1761000000003,"endedAt":null,"rukoo":true},
             {"type":"assistant","id":"i_4","at":1761000000004,"text":"Half","status":"streaming","interim":false},
             {"type":"approval","id":"i_5","at":1761000000005,"title":"Run","detail":"","fields":[],"choices":[{"id":"once","label":"Allow once","kind":"primary"}],"status":"pending","decision":null,"source":"clark","kind":"runtime"},
             {"type":"approval","id":"i_6","at":1761000000006,"title":"Post it","detail":"","fields":[],"choices":[{"id":"approve","label":"Approve","kind":"primary"}],"status":"pending","decision":null,"source":"clark","kind":"proposal"},
             {"type":"notice","id":"i_7","at":1761000000007,"text":"Archived 1 email","tone":"success","code":null,"undo":{"kind":"move","ids":["acc1:INBOX:3"]},"mail":{"action":"archive","count":1,"failed":0,"folder":"Archive"}},
             {"type":"future-item","id":"i_8","at":1761000000008},
             {"type":"plan","id":"i_9","at":1761000000009,"planId":"p1","title":"Plan","tasks":[{"id":"t1","title":"A","status":"weird"}]}
           ]},
          {"id":"c_mh0abc_bbbbbb","agent":"claude","items":[]},
          {"id":"c_mh0abc_cccccc","agent":"openclaw","title":"Old","origin":"external","createdAt":5,"updatedAt":6,"unread":false,
           "items":[{"type":"assistant","id":"i_x","at":6,"text":"Hello","status":"done","interim":false}]},
          {"id":42,"agent":"clark","items":[]},
          {"id":"c_mh0abc_dddddd","agent":"clark"}
        ]}
    """.trimIndent()

    @Test
    fun normalizesWhatDesktopNormalizes() {
        val decoded = ConversationStore.decode(desktopFile)
        assertFalse(decoded.unreadable)
        // A claude chat (desktop-only agent), a bad id, a chat without items and an unknown item type.
        assertTrue(decoded.partial)
        assertEquals(listOf("c_mh0abc_aaaaaa", "c_mh0abc_cccccc"), decoded.conversations.map { it.id })
        val c = decoded.conversations[0]
        assertEquals(ConversationStatus.IDLE, c.status)
        assertNull(c.model)
        assertNull(c.effort)
        assertEquals(mapOf("sessionId" to "s-1", "threadId" to "t-9", "count" to "3"), c.provider)
        assertEquals(listOf("one", "two"), c.notes)
        assertEquals(Unread.REPLY, c.unread)
        // delivered was never written: a chat whose agent answered has had its first turn.
        assertTrue(c.delivered)
        assertFalse(c.needsRecap)
        assertEquals(listOf("acc1:INBOX:14"), c.continued.map { it.id })
        assertFalse(c.continued[0].pending)
        assertEquals(listOf("f_1"), c.files.map { it.id })
        val items = c.items.associateBy { it.id }
        assertEquals(8, c.items.size)
        assertEquals(ThinkingStatus.DONE, (items["i_2"] as Item.Thinking).status)
        assertEquals(c.updatedAt, (items["i_2"] as Item.Thinking).endedAt)
        assertEquals(ToolStatus.DONE, (items["i_3"] as Item.Tool).status)
        assertEquals(AssistantStatus.STOPPED, (items["i_4"] as Item.Assistant).status)
        assertEquals(ApprovalStatus.EXPIRED, (items["i_5"] as Item.Approval).status)
        // A proposal can still be decided after a restart.
        val proposal = items["i_6"] as Item.Approval
        assertEquals(ApprovalStatus.PENDING, proposal.status)
        assertEquals(ApprovalKind.PROPOSAL, proposal.kind)
        assertNull((items["i_7"] as Item.Notice).undo)
        val other = decoded.conversations[1]
        assertEquals(Origin.EXTERNAL, other.origin)
        assertEquals(Unread.NONE, other.unread)
        assertTrue(other.delivered)
    }

    @Test
    fun aFileThatIsNotAStoreIsUnreadable() {
        assertTrue(ConversationStore.decode("{not json").unreadable)
        assertTrue(ConversationStore.decode("""{"conversations":null}""").unreadable)
        assertTrue(ConversationStore.decode("[]").unreadable)
        assertFalse(ConversationStore.decode("""{"version":1,"conversations":[]}""").unreadable)
    }

    @Test
    fun writesDesktopsShapeNewestFirst() {
        val decoded = ConversationStore.decode(desktopFile).conversations
        val text = ConversationStore.encode(decoded.reversed())
        val json = RukooJson.parseToJsonElement(text).toString()
        assertTrue(json.startsWith("""{"version":1,"conversations":[{"id":"c_mh0abc_aaaaaa""""))
        assertTrue(json, json.contains(""""unread":"reply""""))
        assertTrue(json, json.contains(""""unread":false"""))
        assertTrue(json, json.contains(""""type":"approval""""))
        assertEquals(decoded, ConversationStore.decode(text).conversations)
    }
}
