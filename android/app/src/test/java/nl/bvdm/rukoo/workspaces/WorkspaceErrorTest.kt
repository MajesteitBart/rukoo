package nl.bvdm.rukoo.workspaces

import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Test

/** How a server answer becomes a WorkspaceError (contract §3.15). */
class WorkspaceErrorTest {
    @Test
    fun `a 4xx without a code we know falls back to what its status says`() {
        // A proxy's or Cloudflare's own HTML page: no JSON body at all.
        val limited = WorkspaceError.fromAnswer(429, null, retryAfter = "30")
        assertEquals("rate_limited", limited.code)
        assertEquals(30L, limited.retryAfterS)
        assertEquals("not_found", WorkspaceError.fromAnswer(404, null).code)
        assertEquals("forbidden", WorkspaceError.fromAnswer(403, null).code)
        // A JSON body with a code this build doesn't know.
        assertEquals("rate_limited", WorkspaceError.fromAnswer(429, buildJsonObject { put("error", "slow_down") }).code)
    }

    @Test
    fun `a code the body names wins over the status`() {
        val body = buildJsonObject {
            put("error", "invite_gone")
            put("scope", "workspace")
        }
        val e = WorkspaceError.fromAnswer(404, body)
        assertEquals("invite_gone", e.code)
        assertEquals("workspace", e.scope)
        assertEquals("quota", WorkspaceError.fromAnswer(429, buildJsonObject { put("error", JsonPrimitive("quota")) }).code)
    }

    @Test
    fun `other statuses keep their fixed codes`() {
        assertEquals("signed_out", WorkspaceError.fromAnswer(401, buildJsonObject { put("error", "forbidden") }).code)
        assertEquals("upgrade_required", WorkspaceError.fromAnswer(426, null).code)
        assertEquals("server", WorkspaceError.fromAnswer(503, null).code)
        assertEquals("server", WorkspaceError.fromAnswer(400, null).code)
        assertEquals("server", WorkspaceError.fromAnswer(409, null).code)
    }
}
