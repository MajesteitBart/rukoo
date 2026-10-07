# Rukoo Mail for Hermes Agent

Two separate connections link Rukoo and a Hermes agent such as Clark:

- **Rukoo to Hermes.** The chat panel talks to the Hermes API server (`http://<hermes host>:8642`) with the API key from Settings > Agents. This needs nothing on the Hermes side beyond a running API server.
- **Hermes to Rukoo.** Hermes calls Rukoo's MCP tools (`get_context`, `search_mail`, `write_draft`, `show_plan` and the rest) on the desktop, over Tailscale. This is what `rukoo_bridge.py` is for, and what the steps below set up.

## Why a bridge

Hermes could reach Rukoo's MCP endpoint directly over HTTP. But after a few failed reconnects Hermes parks an HTTP server: it drops the tools and only probes again every five minutes. Rukoo is a desktop app that is closed or asleep for half the day, so the tools would keep disappearing.

`rukoo_bridge.py` is a small stdio MCP server that Hermes starts on its own machine. It answers the MCP handshake itself, serves the tool list from a cache while Rukoo is away, and forwards tool calls to Rukoo. When Rukoo can't be reached, the agent gets a normal tool error it can pass on: "Rukoo Mail isn't running on the desktop or isn't reachable over Tailscale. Ask the user to open it." It needs Python 3.8 or newer and only the standard library. It never uses a proxy from the environment, because a proxy would see the token and can't reach a 100.x address anyway.

It follows the same pattern as `~/.hermes/aight_phone_bridge.py`.

## Setup

1. **Turn it on in Rukoo.** Open Settings > Agents and, in the Hermes card, turn on "Let Clark use Rukoo" (the name follows your agent's name). The card shows the address Rukoo listens on, `http://<this PC's Tailscale IP>:47800/mcp`. Rukoo only accepts the remote token on that address, and only local tokens on 127.0.0.1.
2. **Copy the bridge to the Hermes machine.**
   ```sh
   scp integrations/hermes/rukoo_bridge.py clarkbox:~/.hermes/rukoo_bridge.py
   ```
3. **Add the config.** Click "Copy Hermes setup" in Rukoo and merge the block into `~/.hermes/config.yaml`. Keep your other `mcp_servers` entries. The block looks like this:
   ```yaml
   mcp_servers:
     rukoo:
       command: python3
       args: ["${userHome}/.hermes/rukoo_bridge.py"]
       env:
         RUKOO_URL: http://<desktop tailscale ip>:47800/mcp
         RUKOO_TOKEN: <remote token>
       timeout: 120
   ```
   `RUKOO_CACHE` is optional. It sets where the bridge keeps the last tool list (default: `rukoo_tools.json` next to the script).
4. **Wait a minute.** The gateway runs a reconcile tick every 60 seconds. It starts a newly added, enabled `mcp_servers` entry within about a minute, with no restart needed. The tools show up as `mcp__rukoo__get_context` and so on.
5. **Check it,** with Rukoo open on the desktop:
   ```sh
   hermes mcp test rukoo
   ```
   It should list Rukoo's ten tools. `hermes mcp list` shows the entry, and the gateway log has a line like `MCP server 'rukoo' ... registered 10 tool(s)`. Don't use `GET /v1/toolsets` to check: it leaves MCP servers out on purpose.

The first `tools/list` has to reach Rukoo once to fill the cache. After that, Hermes keeps the tools even when Rukoo is closed.

## Changing the token or address

"New token" in Rukoo makes the old setup stop working. Copy the Hermes setup again and replace `RUKOO_TOKEN` (and `RUKOO_URL` if the desktop's address changed) in `config.yaml`. The reconcile tick compares entry names only, so it won't restart the bridge for an edited entry. Send `/reload-mcp` to Clark from WhatsApp or Telegram, or run `hermes gateway restart`.

## Timeouts and approvals

- The bridge waits up to 60 seconds for a tool call. `write_draft` waits for Rukoo's composer, which takes at most 20 seconds. Everything else answers in well under a second.
- `timeout: 120` is Hermes' own limit for a call to this server.
- Rukoo's tools don't block while they wait for the user. `propose_action` and `mail_action` put an approval card in Rukoo and return right away. When the user approves, Rukoo sends Clark a new message. So the entry doesn't need `trust: untrusted`, and Hermes' approval timeout doesn't come into play.

## Troubleshooting

| What the agent says or the log shows | What to do |
|---|---|
| "Rukoo Mail isn't running on the desktop or isn't reachable over Tailscale" | Open Rukoo. Check that both machines are on the tailnet and that "Let Clark use Rukoo" is on. |
| "Rukoo Mail refused the token" | Copy the Hermes setup again, update `RUKOO_TOKEN`, then `/reload-mcp`. |
| `hermes mcp test rukoo` lists no tools and the bridge logs "no tool list is cached yet" | Rukoo has never been reachable from this machine. Open it on the desktop, then test again. |
| The bridge logs `RUKOO_URL and RUKOO_TOKEN must be set` | The `env:` block is missing or misspelled in `config.yaml`. |

The bridge logs to stderr with the prefix `rukoo-bridge:`, so its lines end up in the gateway log.

## How Rukoo runs a turn on Hermes (Runs API, not the session stream)

Rukoo's Hermes adapter (`src/main/agents/hermes.js`) keeps one Hermes session per Rukoo conversation. It creates the session with `POST /api/sessions {title: "Rukoo: <subject>"}` and runs each turn with `POST /v1/runs {input, session_id, instructions}`. It then reads `GET /v1/runs/{id}/events`.

Hermes offers two ways to run a turn in a session. Rukoo uses the Runs API, because:

- **A dropped connection doesn't end the turn.** On `POST /api/sessions/{id}/chat/stream`, a client disconnect interrupts the run. A run keeps going on the server, and the event stream can be resumed: Rukoo reconnects with `Last-Event-ID` (and `?last_seq=`) up to five times and skips events it has already seen.
- **Tool results say whether they failed.** On the Runs stream, `tool.completed` carries `duration`, `error` and a `preview`. On the session stream those fields are dropped.
- Approvals (`POST /v1/runs/{id}/approval`) and stop (`POST /v1/runs/{id}/stop`) work the same on both.

The Runs API only works for this if a run with `session_id` reads and writes that session's history. A test against Clark (Hermes 0.21.5, model gpt-6-astra) on 7 October 2026 confirmed it:

1. `POST /api/sessions` created session `api_1791367372_b85f058b`.
2. A run in that session, "Remember the word mango. Reply with just OK.", answered `OK`.
3. A second run in the same session, "Which word did I ask you to remember?", answered `mango`.
4. `GET /api/sessions/{id}/messages` returned all four messages (two user, two assistant) in that session.
5. As a control, the same question in a fresh session answered `NONE`. So the answer came from the session, not from Clark's long-term memory.

The probe sessions were deleted afterwards. `node scripts/agent-smoke.js clark` repeats the continuity check, plus a stop, through the adapter itself. In that run the stop took about 0.3 seconds from `POST /stop` to `run.cancelled`.

Other details the adapter relies on:

- Session titles are unique in Hermes. A second chat about the same email gets the conversation id appended, for example "Rukoo: Call on Thursday (k3x9fa)".
- Before each turn, the adapter checks the stored session with `GET /api/sessions/{id}`. If the session was deleted in Hermes, it starts a new one.
- `reasoning.available` and `tool.progress` repeat the visible answer text, so the adapter ignores them.
- Hermes sends a `: keepalive` comment every 10 seconds. After 45 seconds of silence the adapter treats the connection as dropped and reconnects.
- Requests use Node's `fetch` against the configured origin only, and never follow redirects. Rukoo's `net.js` refuses Tailscale's 100.64.0.0/10 range by design, which is why the adapter doesn't use it.
