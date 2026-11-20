package nl.bvdm.rukoo.ui.chat

import nl.bvdm.rukoo.ui.chat.ChatTimeline.Message
import nl.bvdm.rukoo.workspaces.Channel
import nl.bvdm.rukoo.workspaces.Event
import nl.bvdm.rukoo.workspaces.Member
import nl.bvdm.rukoo.workspaces.PendingState
import nl.bvdm.rukoo.workspaces.Room
import nl.bvdm.rukoo.workspaces.RoomKind
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * What replaces the composer (contract §5.5 table, §7.4), the actions under unsent messages (§3.8), who may remove a
 * message (§3.14), and the thread's reply count (§3.13).
 */
class ChatComposerRulesTest {
    private fun u(name: String) = "u_" + name.padEnd(22, 'x')

    private val me = u("me")
    private val sanne = u("sanne")

    private fun room(kind: RoomKind = RoomKind.CHANNEL, archived: Boolean = false, closed: String? = null, role: String? = "member") = Room(
        id = "c_1", kind = kind, name = if (kind == RoomKind.DM) null else "plans", visibility = if (kind == RoomKind.DM) "dm" else "workspace",
        archived = archived, closedReason = closed, participants = if (kind == RoomKind.DM) listOf(me, sanne) else null, startedBy = null,
        role = role, members = 2, head = 5, floor = 1, lastAt = null, read = 5, unread = 0, mentions = 0, attention = 0, muted = false, hasCache = true,
    )

    private fun message(actor: String, removed: Boolean = false, pending: PendingState? = null, root: String? = null, replies: Int = 0) = Message(
        key = "e_1", seq = 1, id = if (pending == null) "e_1" else null, local = if (pending != null) "l1" else null, actor = actor, at = 0, root = root,
        reply = root != null, head = true, text = if (removed) null else "hi", mentions = emptyList(), removed = removed, mentionsMe = false,
        blocked = false, pending = pending, reason = null, nextAt = null,
        replies = if (replies > 0) ChatTimeline.Replies(replies, 0, listOf(sanne), false) else null, context = null,
    )

    @Test
    fun `the composer gives way to a bar for a channel not joined, a stopped workspace, an archived channel, a closed DM and a removed root`() {
        val browse = Channel("c_2", "ideas", "workspace", joined = false)
        assertEquals(ComposerSlot.NotJoined(browse), ComposerSlots.of(null, browse, paused = true))
        assertEquals(ComposerSlot.Paused, ComposerSlots.of(room(archived = true), paused = true))
        assertEquals(ComposerSlot.Archived, ComposerSlots.of(room(archived = true)))
        assertEquals(ComposerSlot.Closed("left"), ComposerSlots.of(room(RoomKind.DM, archived = true, closed = "left")))
        assertEquals(ComposerSlot.Closed("closed"), ComposerSlots.of(room(RoomKind.DM, closed = "closed")))
        assertEquals(ComposerSlot.Closed("closed"), ComposerSlots.of(room(RoomKind.DM, archived = true, closed = "closed"), rootRemoved = true))
        assertEquals(ComposerSlot.RootRemoved, ComposerSlots.of(room(), rootRemoved = true))
        assertEquals(ComposerSlot.Composer, ComposerSlots.of(room()))
        assertEquals(ComposerSlot.Composer, ComposerSlots.of(room(RoomKind.DM)))
    }

    @Test
    fun `held and failed sends offer what can still help, and every one of them Discard`() {
        assertEquals(listOf(PendingAction.SEND, PendingAction.DISCARD), MessageRules.pendingActions(PendingState.HELD, "stale_grant"))
        assertEquals(listOf(PendingAction.SEND_AGAIN, PendingAction.DISCARD), MessageRules.pendingActions(PendingState.HELD, "unknown"))
        assertEquals(listOf(PendingAction.RETRY, PendingAction.DISCARD), MessageRules.pendingActions(PendingState.FAILED, "quota"))
        assertEquals(listOf(PendingAction.SEND_WITHOUT_MENTIONS, PendingAction.DISCARD), MessageRules.pendingActions(PendingState.FAILED, "mentions"))
        assertEquals(listOf(PendingAction.COPY, PendingAction.DISCARD), MessageRules.pendingActions(PendingState.FAILED, "conflict"))
        assertEquals(listOf(PendingAction.COPY, PendingAction.DISCARD), MessageRules.pendingActions(PendingState.FAILED, "archived"))
        assertEquals(listOf(PendingAction.DISCARD), MessageRules.pendingActions(PendingState.FAILED, "invalid"))
        assertEquals(listOf(PendingAction.DISCARD), MessageRules.pendingActions(PendingState.FAILED, "no_access"))
        for (s in listOf(PendingState.QUEUED, PendingState.SENDING, PendingState.WAITING)) assertTrue(MessageRules.pendingActions(s, null).isEmpty())
    }

    @Test
    fun `authors remove their own messages anywhere, managers any message in their channel`() {
        assertTrue(MessageRules.canRemove(message(me), me, room()))
        assertTrue(MessageRules.canRemove(message(me), me, room(RoomKind.DM, archived = true, closed = "left")))
        assertFalse(MessageRules.canRemove(message(sanne), me, room()))
        assertTrue(MessageRules.canRemove(message(sanne), me, room(role = "manager")))
        // DM grants are members: only the author.
        assertFalse(MessageRules.canRemove(message(sanne), me, room(RoomKind.DM, role = "manager")))
        assertFalse(MessageRules.canRemove(message(me, removed = true), me, room()))
        assertFalse(MessageRules.canRemove(message(me, pending = PendingState.FAILED), me, room()))
    }

    @Test
    fun `Reply in thread outside a thread for a message whose thread can be read, and Copy text for text`() {
        assertTrue(MessageRules.canReply(message(sanne), inThread = false))
        assertFalse(MessageRules.canReply(message(sanne), inThread = true))
        assertFalse(MessageRules.canReply(message(sanne, removed = true), inThread = false))
        assertTrue(MessageRules.canReply(message(sanne, removed = true, replies = 2), inThread = false))
        assertTrue(MessageRules.canReply(message(sanne, root = "e_0"), inThread = false))
        assertTrue(MessageRules.canCopy(message(sanne)))
        assertFalse(MessageRules.canCopy(message(sanne, removed = true)))
        assertFalse(MessageRules.hasActions(message(sanne, removed = true), me, room(), inThread = true, "guest", member(sanne), emptySet()))
    }

    private fun member(id: String, role: String = "member", state: String = "active") = Member(id = id, name = "Sanne", role = role, state = state)

    @Test
    fun `the message menu offers Block on someone else's message, between Copy and Remove, as long as they can be blocked`() {
        val none = emptySet<String>()
        val sanneMember = member(sanne)
        assertEquals(
            listOf(MessageAction.REPLY, MessageAction.COPY, MessageAction.BLOCK),
            MessageRules.actions(message(sanne), me, room(), inThread = false, "member", sanneMember, none),
        )
        // A manager sees Block before Remove; in a thread, no Reply.
        assertEquals(
            listOf(MessageAction.COPY, MessageAction.BLOCK, MessageAction.REMOVE),
            MessageRules.actions(message(sanne), me, room(role = "manager"), inThread = true, "owner", sanneMember, none),
        )
        // In a DM too, and on a removed message, which then still opens the menu.
        assertEquals(listOf(MessageAction.BLOCK), MessageRules.actions(message(sanne, removed = true), me, room(RoomKind.DM), inThread = true, "admin", sanneMember, none))
        assertTrue(MessageRules.hasActions(message(sanne, removed = true), me, room(), inThread = true, "member", sanneMember, none))
        // Never on your own messages.
        assertEquals(listOf(MessageAction.REPLY, MessageAction.COPY, MessageAction.REMOVE), MessageRules.actions(message(me), me, room(), inThread = false, "member", member(me), none))
        // Not when they're blocked already: the Blocked list unblocks.
        assertEquals(listOf(MessageAction.REPLY, MessageAction.COPY), MessageRules.actions(message(sanne), me, room(), inThread = false, "member", sanneMember, setOf(sanne)))
        // Not for a guest who reads, nor about a guest, a former member or someone unknown.
        assertFalse(MessageAction.BLOCK in MessageRules.actions(message(sanne), me, room(), inThread = false, "guest", sanneMember, none))
        assertFalse(MessageAction.BLOCK in MessageRules.actions(message(sanne), me, room(), inThread = false, "member", member(sanne, role = "guest"), none))
        assertFalse(MessageAction.BLOCK in MessageRules.actions(message(sanne), me, room(), inThread = false, "member", member(sanne, state = "former"), none))
        assertFalse(MessageAction.BLOCK in MessageRules.actions(message(sanne), me, room(), inThread = false, "member", null, none))
        // Not on a message that isn't sent.
        assertFalse(MessageAction.BLOCK in MessageRules.actions(message(sanne, pending = PendingState.FAILED), me, room(), inThread = false, "member", sanneMember, none))
    }

    @Test
    fun `the people who posted lately come latest first, without you`() {
        fun msg(seq: Long, actor: String) = Event(seq, "e_$seq", "message.posted", actor, seq, null, "x", emptyList(), false)
        val events = listOf(msg(1, sanne), msg(2, me), msg(3, u("mila")), msg(4, sanne))
        assertEquals(listOf(sanne, u("mila")), ComposerSlots.recentAuthors(events, me))
        assertEquals(listOf(sanne), ComposerSlots.recentAuthors(events, me, messages = 1))
    }

    @Test
    fun `a thread shows its first message, the reply count, then the replies as a group of their own`() {
        fun msg(seq: Long, actor: String, root: String? = null) = Event(seq, "e_$seq", "message.posted", actor, 1_000L + seq, root, "t$seq", emptyList(), false)
        val rows = ChatTimeline.rows(listOf(msg(1, sanne), msg(2, sanne, "e_1"), msg(3, me, "e_1"), msg(4, me)), me = me, root = "e_1")
        val keys = rows.map { it.key }
        assertEquals(listOf("e_1", "count", "e_2", "e_3"), keys.filter { !it.startsWith("day:") })
        assertEquals(2, rows.filterIsInstance<ChatTimeline.Count>().single().count)
        // Sanne's reply right after her own first message still starts a group.
        assertTrue(rows.filterIsInstance<Message>().first { it.seq == 2L }.head)
        // The main timeline has no count row.
        assertTrue(ChatTimeline.rows(listOf(msg(1, sanne), msg(2, sanne, "e_1")), me = me).none { it is ChatTimeline.Count })
    }
}
