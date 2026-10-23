package nl.bvdm.rukoo.desktop

/** The 8-character code desktop Rukoo shows as `XXXX-XXXX` while it pairs a phone (phonehost.js newCode). */
object PairingCode {
    /** Crockford base32 without I, L, O and U, as phonehost.js CODE_ALPHABET. */
    const val ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
    const val LENGTH = 8

    /**
     * The code as the computer compares it (phonehost.js normalizeCode): upper case, without spaces and
     * dashes, O read as 0 and I or L as 1. Null when the result can't be a code, so a typo is caught here
     * instead of costing one of the computer's five tries.
     */
    fun normalize(input: String): String? {
        val code = buildString {
            for (ch in input.uppercase()) {
                when {
                    ch.isWhitespace() || ch == '-' -> Unit
                    ch == 'O' -> append('0')
                    ch == 'I' || ch == 'L' -> append('1')
                    else -> append(ch)
                }
            }
        }
        return code.takeIf { it.length == LENGTH && it.all { c -> c in ALPHABET } }
    }

    /** `K7QM2XPA` as the computer shows it: `K7QM-2XPA`. */
    fun format(code: String): String = if (code.length == LENGTH) code.substring(0, 4) + "-" + code.substring(4) else code
}

/** Where desktop Rukoo listens: a Tailscale IP or MagicDNS name and its port. */
data class DesktopAddress(val host: String, val port: Int = DEFAULT_PORT) {
    /** The base URL the routes hang off, with IPv6 hosts in brackets. */
    val baseUrl: String get() = "http://${if (':' in host) "[$host]" else host}:$port"

    companion object {
        /** Desktop Rukoo's Tailscale listener (agents.json mcp.port). */
        const val DEFAULT_PORT = 47800

        private val HOST_NAME = Regex("^[A-Za-z0-9]([A-Za-z0-9-]{0,62})(\\.[A-Za-z0-9]([A-Za-z0-9-]{0,62}))*\\.?$")
        private val IPV6 = Regex("^[0-9A-Fa-f:.]+$")

        /**
         * Reads what the user typed: `100.101.102.103`, `office-pc`, `office-pc.tail1234.ts.net`,
         * `host:47801`, or the `http://100.101.102.103:47800` the computer's pairing dialog shows (a path such
         * as `/mcp` is dropped). Null when it isn't an address.
         */
        fun parse(input: String): DesktopAddress? {
            var s = input.trim()
            if (s.isEmpty() || s.any { it.isWhitespace() }) return null
            val scheme = s.substringBefore("://", "")
            if (scheme.isNotEmpty()) {
                // The listener speaks plain HTTP; Tailscale encrypts the link.
                if (!scheme.equals("http", ignoreCase = true)) return null
                s = s.substringAfter("://")
            }
            s = s.substringBefore('/').substringBefore('?').substringBefore('#')
            if (s.isEmpty() || '@' in s) return null
            val host: String
            val portText: String?
            if (s.startsWith("[")) {
                val end = s.indexOf(']')
                if (end < 0) return null
                host = s.substring(1, end)
                val rest = s.substring(end + 1)
                portText = if (rest.isEmpty()) null else rest.removePrefix(":").takeIf { rest.startsWith(":") } ?: return null
                if (!IPV6.matches(host)) return null
            } else if (s.count { it == ':' } > 1) {
                // A bare IPv6 address has no room for a port.
                if (!IPV6.matches(s)) return null
                host = s
                portText = null
            } else {
                host = s.substringBefore(':')
                portText = if (':' in s) s.substringAfter(':') else null
                if (!HOST_NAME.matches(host)) return null
            }
            val port = when (portText) {
                null -> DEFAULT_PORT
                else -> portText.toIntOrNull()?.takeIf { it in 1..65535 } ?: return null
            }
            return DesktopAddress(host.trimEnd('.').lowercase(), port)
        }
    }
}
