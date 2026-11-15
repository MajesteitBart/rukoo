package nl.bvdm.rukoo.mcp.tools

import nl.bvdm.rukoo.core.Unsafe

/**
 * What a tool that puts something in a chat says when that chat isn't clear (desktop tools.js chatFor, #281). Word for
 * word the desktop's CHAT_UNCLEAR, foreignChat and shownElsewhere; test/agent-tools-android.test.js compares them.
 */
object ChatRoute {
    const val UNCLEAR = "Rukoo showed nothing: more than one of your chats is working right now, so Rukoo can't tell which one this is for. Call again with the conversation_id from the message you are answering."

    fun foreign(id: String, name: String) = "Rukoo showed nothing: conversation $id belongs to another agent, and this call comes with the token Rukoo gave $name. If the user is talking to you in that chat, your Rukoo setup has the wrong token: tell the user to copy your setup from Rukoo's settings again."

    fun elsewhere(title: String?) = "Rukoo showed this in another chat${named(title)}, not in the one you are answering in now, so the user may not see it. Tell the user which chat it is in."

    // A chat about an email has its subject as title, which the sender wrote.
    private fun named(title: String?) = if (title.isNullOrEmpty()) "" else ", " + Unsafe.inline(title, "chat title")
}
