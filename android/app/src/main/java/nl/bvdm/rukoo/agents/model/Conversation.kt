package nl.bvdm.rukoo.agents.model

import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonEncoder
import kotlinx.serialization.json.JsonPrimitive
import nl.bvdm.rukoo.mail.model.Address

/**
 * The email a chat is about (spec 1 §1.3). [id] is the Rukoo id at the time; [messageId] the header,
 * which finds the email again after it moved. [unsubscribe] keeps /unsubscribe offered for the chat.
 */
@Serializable
data class MessageRef(
    val id: String,
    val messageId: String? = null,
    val accountId: String? = null,
    val subject: String = "",
    val from: Address? = null,
    val date: Long? = null,
    val unsubscribe: Boolean = false,
    val inReplyTo: String? = null,
    /** Last 50 References entries, kept once the full message was loaded. */
    val references: List<String>? = null,
)

/**
 * A newer email in the thread the user continued the chat from: a [MessageRef] plus when, and
 * whether the agent still has to get it ([pending]). Same JSON as desktop: the ref's fields, flat.
 */
@Serializable
data class ContinuedRef(
    val id: String,
    val messageId: String? = null,
    val accountId: String? = null,
    val subject: String = "",
    val from: Address? = null,
    val date: Long? = null,
    val unsubscribe: Boolean = false,
    val inReplyTo: String? = null,
    val references: List<String>? = null,
    val at: Long = 0,
    val pending: Boolean = false,
) {
    fun ref() = MessageRef(id, messageId, accountId, subject, from, date, unsubscribe, inReplyTo, references)

    companion object {
        fun of(ref: MessageRef, at: Long, pending: Boolean) =
            ContinuedRef(ref.id, ref.messageId, ref.accountId, ref.subject, ref.from, ref.date, ref.unsubscribe, ref.inReplyTo, ref.references, at, pending)
    }
}

/** A file kept with a chat (chatfiles.js:262). [file] is its path in the app's storage. */
@Serializable
data class ChatFile(
    val id: String,
    val name: String,
    val file: String,
    val size: Long = 0,
    val type: String = "",
    val kind: String = "file",
    val at: Long = 0,
)

@Serializable
enum class ConversationStatus {
    @SerialName("idle") IDLE,
    @SerialName("running") RUNNING,
    @SerialName("error") ERROR,
}

@Serializable
enum class Origin {
    /** Started in the chat UI. */
    @SerialName("panel") PANEL,

    /** Created by a tool call that came in without a chat (Clark on WhatsApp, say). */
    @SerialName("external") EXTERNAL,
}

/** Why a chat shows a dot: a turn ended while it wasn't on screen. NONE is desktop's `false`. */
@Serializable(with = UnreadSerializer::class)
enum class Unread { NONE, REPLY, ERROR }

/** Desktop writes `false` for "nothing new" and `'reply'`/`'error'` otherwise. */
object UnreadSerializer : KSerializer<Unread> {
    override val descriptor = PrimitiveSerialDescriptor("nl.bvdm.rukoo.Unread", PrimitiveKind.STRING)

    override fun serialize(encoder: Encoder, value: Unread) {
        val json = encoder as? JsonEncoder
        when {
            value != Unread.NONE -> encoder.encodeString(value.name.lowercase())
            json != null -> json.encodeJsonElement(JsonPrimitive(false))
            else -> encoder.encodeString("")
        }
    }

    override fun deserialize(decoder: Decoder): Unread {
        val raw = if (decoder is JsonDecoder) {
            val primitive = decoder.decodeJsonElement() as? JsonPrimitive ?: return Unread.NONE
            if (!primitive.isString) return Unread.NONE
            primitive.content
        } else {
            decoder.decodeString()
        }
        return when (raw) {
            "reply" -> Unread.REPLY
            "error" -> Unread.ERROR
            else -> Unread.NONE
        }
    }
}

/**
 * A chat, field for field desktop's conversation (spec 1 §1.2). [agent] is `clark`, `openclaw`,
 * `computer:<pairingId>:claude`, `computer:<pairingId>:codex`, or `fake` in debug builds.
 * [provider] is adapter-owned state: Hermes `{sessionId}`, OpenClaw `{agent, sessionUser}`, a computer
 * host `{sessionId}` or `{threadId}`.
 */
@Serializable
data class Conversation(
    val id: String,
    val agent: String,
    val title: String = "",
    val message: MessageRef? = null,
    val origin: Origin = Origin.PANEL,
    val createdAt: Long = 0,
    val updatedAt: Long = createdAt,
    val status: ConversationStatus = ConversationStatus.IDLE,
    val model: String? = null,
    val effort: String? = null,
    val provider: Map<String, String> = emptyMap(),
    /** Rukoo's lines for the next turn ("Since your last turn: ..."). */
    val notes: List<String> = emptyList(),
    /** A turn reached the agent; until then every message is a first turn with the email. */
    val delivered: Boolean = false,
    /** The agent lost its session; each message carries the email and a recap until one reaches the new one. */
    val needsRecap: Boolean = false,
    val unread: Unread = Unread.NONE,
    val continued: List<ContinuedRef> = emptyList(),
    val files: List<ChatFile> = emptyList(),
    val items: List<Item> = emptyList(),
)

/** conversations.json: `{version: 1, conversations: [...]}`, newest first, as on desktop. */
@Serializable
data class ConversationsFile(val version: Int = 1, val conversations: List<Conversation> = emptyList())

/**
 * A chat-list row (desktop hub.list(), spec 1 §1.5). [lastAt] is the time of the last user, assistant
 * or approval item; [waiting] an approval is pending; [preview] up to 140 characters of the last text.
 */
data class ConversationRow(
    val id: String,
    val agent: String,
    val title: String,
    val message: MessageRef?,
    val origin: Origin,
    val updatedAt: Long,
    val lastAt: Long,
    val status: ConversationStatus,
    val unread: Unread,
    val waiting: Boolean,
    val preview: String,
)

/** An earlier chat in the same thread that the user can continue (desktop relatedFor). */
data class RelatedChat(
    val id: String,
    val agent: String,
    val title: String,
    val updatedAt: Long,
    val subject: String,
    val from: Address?,
    val date: Long?,
)
