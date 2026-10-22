package nl.bvdm.rukoo.mail.model

import kotlinx.serialization.Serializable

/**
 * The mail parts of desktop's settings.json (spec 4 §1.3) that the engine itself needs: the VIP and
 * spam address lists (lower case) and the general signature, which accounts without their own use.
 * Desktop's export bundle carries these in `settings`; the phone keeps them in the engine's folder.
 */
@Serializable
data class MailPrefs(
    val vips: List<String> = emptyList(),
    val spam: List<String> = emptyList(),
    /** The general signature as text; with [signatureHtml] set, its readable text. */
    val signature: String = "",
    /** The general signature as cleaned HTML, or '' for a plain-text one. */
    val signatureHtml: String = "",
)

/**
 * A signature ready for the composer: [text] goes into the plain-text body, [html] (cleaned, never
 * empty) replaces it in the HTML part while the user left the text as it was.
 */
data class Signature(val text: String, val html: String)
