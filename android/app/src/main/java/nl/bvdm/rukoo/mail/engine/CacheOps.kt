package nl.bvdm.rukoo.mail.engine

import nl.bvdm.rukoo.mail.model.CachedMessage
import nl.bvdm.rukoo.mail.model.MessageIds
import nl.bvdm.rukoo.mail.session.FolderSync

/** A local change whose server command hasn't finished: flags to keep, or the message gone (spec 4 §1.16). */
data class PendingPatch(
    val unread: Boolean? = null,
    val starred: Boolean? = null,
    val answered: Boolean? = null,
    val removed: Boolean = false,
) {
    fun merge(other: PendingPatch) = PendingPatch(
        other.unread ?: unread,
        other.starred ?: starred,
        other.answered ?: answered,
        removed || other.removed,
    )

    fun applyTo(m: CachedMessage) = m.copy(unread = unread ?: m.unread, starred = starred ?: m.starred, answered = answered ?: m.answered)
}

/** The cache's pure operations: merging a sync result, pending changes and the move log. */
object CacheOps {
    fun pendingKey(accountId: String, folder: String, uid: Long) = "$accountId\n$folder\n$uid"

    /**
     * Re-applies local changes still on their way to the server, so a sync that read the server just
     * before the command ran can't undo them in the cache (engine.js applyPending).
     */
    fun applyPending(accountId: String, folder: String, messages: List<CachedMessage>, pending: Map<String, PendingPatch>): List<CachedMessage> {
        if (pending.isEmpty()) return messages
        return messages.mapNotNull { m ->
            val p = pending[pendingKey(accountId, folder, m.uid)] ?: return@mapNotNull m
            if (p.removed) null else p.applyTo(m)
        }
    }

    /**
     * Inbox mail that arrived since the last sync of [prev]: uids above the highest known one (all of
     * them when UIDVALIDITY changed), unread and not from a spam address. Nothing on the first sync.
     */
    fun freshMail(prev: CachedBox?, res: FolderSync, isInbox: Boolean, isSpam: (CachedMessage) -> Boolean): List<CachedMessage> {
        if (!isInbox || prev == null) return emptyList()
        val sameValidity = prev.uidValidity == res.uidValidity
        val maxKnown = if (sameValidity) prev.messages.maxOfOrNull { it.uid } ?: 0L else Long.MAX_VALUE
        return res.messages.filter { it.uid > maxKnown && it.unread && !isSpam(it) }
    }

    /**
     * Records that the message with [messageId] is now in [folder], having come from [source]. One
     * Message-ID can have several copies (a mail to yourself in Inbox and Sent), so a record is one copy;
     * a move without a source replaces whatever was known (engine.js noteMove).
     */
    fun noteMove(cache: AccountCache, messageId: String?, folder: String, source: String? = null): AccountCache {
        val key = MessageIds.headerKey(messageId)
        if (key.isEmpty()) return cache
        val moves = cache.moves
        val prev = moves.lastOrNull { it.id == key && (source == null || it.folder == source) }
        val past = ((prev?.past ?: emptyList()) + listOfNotNull(source)).filter { it != folder }.takeLast(Limits.MOVE_PAST)
        val rest = moves.filter { !(it.id == key && (source == null || it === prev)) }
        return cache.copy(moves = (rest + MoveNote(key, folder, past)).takeLast(Limits.MOVES_KEPT))
    }

    /** The last move of this Message-ID (through [from] when given), if its folder still exists. */
    fun lastMove(cache: AccountCache, messageId: String, from: String?): MoveNote? {
        val key = MessageIds.headerKey(messageId)
        if (key.isEmpty()) return null
        val last = cache.moves.lastOrNull { it.id == key && (from == null || from in it.past) } ?: return null
        return last.takeIf { cache.folder(it.folder) != null }
    }

    fun uidByMessageId(cache: AccountCache, folder: String, messageId: String?): Long? {
        val want = MessageIds.headerKey(messageId)
        if (want.isEmpty()) return null
        return cache.boxes[folder]?.messages?.firstOrNull { it.messageId != null && MessageIds.headerKey(it.messageId) == want }?.uid
    }

    /** The box with one message less. */
    fun removeMessage(cache: AccountCache, folder: String, uid: Long): AccountCache {
        val box = cache.boxes[folder] ?: return cache
        return cache.copy(boxes = cache.boxes + (folder to box.copy(messages = box.messages.filter { it.uid != uid })))
    }

    fun addMessage(cache: AccountCache, folder: String, m: CachedMessage): AccountCache {
        val box = cache.boxes[folder] ?: return cache
        if (box.messages.any { it.uid == m.uid }) return cache
        return cache.copy(boxes = cache.boxes + (folder to box.copy(messages = box.messages + m)))
    }

    fun updateMessage(cache: AccountCache, folder: String, uid: Long, change: (CachedMessage) -> CachedMessage): AccountCache {
        val box = cache.boxes[folder] ?: return cache
        if (box.messages.none { it.uid == uid }) return cache
        return cache.copy(boxes = cache.boxes + (folder to box.copy(messages = box.messages.map { if (it.uid == uid) change(it) else it })))
    }
}
