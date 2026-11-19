package nl.bvdm.rukoo.workspaces

import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

/**
 * A workspace invitation link: `<credential URL>/join#w=<w_id>&i=<secret>` (contract §3.2). The workspace and the
 * secret sit in the fragment, which a browser never sends to the server. [server] is the credential URL as
 * AccountServers.serverUrl writes it.
 */
data class InviteLink(val server: String, val workspace: String, val secret: String) {
    /** The link as text, to copy or share. */
    val text: String get() = format(server, workspace, secret)

    // The secret lets anyone in; keep it out of logs and crash reports.
    override fun toString(): String = "InviteLink($server, $workspace)"

    companion object {
        /** The emulator's address of the computer it runs on, allowed for http in debug builds. */
        const val EMULATOR_HOST = "10.0.2.2"

        private val LOCAL = setOf("localhost", "127.0.0.1", "::1")

        // JavaScript's \s, so a link ends where desktop's ends.
        private val URL_IN_TEXT = Regex("https?://[^\\t\\n\\u000B\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]+")

        /**
         * The steps of §3.2, one to five: the first http or https URL in the trimmed [text]; http only for local
         * hosts, with [EMULATOR_HOST] added when [devHosts]; no user info; a path ending in `/join`; a fragment of
         * exactly `w` and `i`, in any order, of the right shapes. Null for anything else (`bad_link`).
         */
        fun parse(text: String, devHosts: Boolean): InviteLink? {
            val found = URL_IN_TEXT.find(text.trim())?.value ?: return null
            val url = found.toHttpUrlOrNull() ?: return null
            val host = url.host.lowercase()
            val local = host in LOCAL || (devHosts && host == EMULATOR_HOST)
            if (url.scheme != "https" && !(url.scheme == "http" && local)) return null
            if (url.username.isNotEmpty() || url.password.isNotEmpty()) return null
            val path = url.encodedPath
            if (!path.endsWith("/join")) return null
            val pairs = url.encodedFragment.orEmpty().split('&').map { p ->
                val eq = p.indexOf('=')
                if (eq < 0) p to null else p.substring(0, eq) to p.substring(eq + 1)
            }
            if (pairs.size != 2) return null
            val fragment = pairs.toMap()
            if (fragment.keys != setOf("w", "i")) return null
            val w = fragment["w"]
            val i = fragment["i"]
            if (w == null || !WorkspaceIds.WORKSPACE.matches(w) || i == null || !WorkspaceIds.SECRET.matches(i)) return null
            val defaultPort = if (url.scheme == "https") 443 else 80
            val origin = "${url.scheme}://${if (host.contains(':')) "[$host]" else host}${if (url.port != defaultPort) ":${url.port}" else ""}"
            val server = origin + path.removeSuffix("/join").trimEnd('/')
            return InviteLink(server, w, i)
        }

        /**
         * [parse], then step six: a link for a server other than [configured], the account's credential URL, is
         * `other_server`. Throws [WorkspaceError] with `bad_link` or `other_server`.
         */
        fun check(text: String, configured: String, devHosts: Boolean): InviteLink {
            val link = parse(text, devHosts) ?: throw WorkspaceError("bad_link")
            if (link.server != configured) throw WorkspaceError("other_server")
            return link
        }

        fun format(server: String, workspace: String, secret: String): String = "$server/join#w=$workspace&i=$secret"
    }
}
