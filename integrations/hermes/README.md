# Rukoo Mail for Hermes Agent

Two separate connections link Rukoo and a Hermes agent such as Clark:

- **Rukoo to Hermes.** The chat panel talks to the Hermes API server (`http://<hermes host>:8642`) with the API key from Settings > Agents. This needs nothing on the Hermes side beyond a running API server.
- **Hermes to Rukoo.** Hermes calls Rukoo's MCP tools (`get_context`, `search_mail`, `write_draft`, `show_plan` and the rest) over Tailscale, on whichever of your devices has Rukoo open. This is what `rukoo_bridge.py` is for, and what the steps below set up.

Neither direction uses SSH.

## Why a bridge

Hermes could reach Rukoo's MCP endpoint directly over HTTP. But after a few failed reconnects Hermes parks an HTTP server: it drops the tools and only probes again every five minutes. Rukoo is a desktop app that is closed or asleep for half the day, so the tools would keep disappearing. And a direct connection points at one machine, while you may use Rukoo on several.

`rukoo_bridge.py` is a small stdio MCP server that Hermes starts on its own machine. It answers the MCP handshake itself, serves the tool list from a cache while Rukoo is away, and forwards tool calls to Rukoo. When Rukoo can't be reached, the agent gets a normal tool error it can pass on, such as "Rukoo Mail isn't open on any of the user's devices, or can't be reached over Tailscale. Ask the user to open it. Checked: laptop, desk-pc." It needs Python 3.8 or newer and only the standard library. It never uses a proxy from the environment, because a proxy would see the token and can't reach a 100.x address anyway.

It follows the same pattern as `~/.hermes/aight_phone_bridge.py`.

## How it finds Rukoo

- **Which devices.** The bridge runs `tailscale status --json` and tries port 47800 on every online Windows and Mac device. It skips Linux machines, phones, tagged devices and devices shared from another tailnet. `RUKOO_URL` adds addresses it should try as well.
- **Which key.** Every Rukoo stores the Hermes API key, because it needs the key to chat. The bridge gets the same key from Hermes' `.env` as `RUKOO_KEY`. Both make the MCP token from it, so there is no token to copy, and one setup works for every device.
- **Proof first.** The bridge doesn't send the token to whatever answers on port 47800. It sends a random challenge, and Rukoo answers with a value only a holder of the same key can compute. The token goes only to devices that get it right.
- **Which device gets a call.** The bridge asks every Rukoo it found whether it has the chat the call is about (`conversation_id`). That device gets the call. A call without a chat, from WhatsApp for instance, goes to the device you used last: the one with the shortest time since its last keyboard or mouse input.
- **When it looks.** At start, and in the background once a minute while calls come in. When no known Rukoo answers, it looks again before giving up.

## Setup

1. **Turn it on in Rukoo,** on every device where you use it. Open Settings > Agents and, in the Hermes card, enter the API key and turn on "Let Clark use Rukoo" (the name follows your agent's name). The card shows the address Rukoo listens on, `http://<this PC's Tailscale IP>:47800/mcp`. Rukoo only accepts Clark's token on that address, and only local tokens on 127.0.0.1. Windows asks once whether Rukoo may accept connections; allow it for private networks.
2. **Copy the bridge to the Hermes machine.**
   ```sh
   scp integrations/hermes/rukoo_bridge.py clarkbox:~/.hermes/rukoo_bridge.py
   ```
3. **Add the config.** Click "Copy Hermes setup" in Rukoo and merge the block into `~/.hermes/config.yaml`. Keep your other `mcp_servers` entries. The block is the same on every device:
   ```yaml
   mcp_servers:
     rukoo:
       command: python3
       args: ["${userHome}/.hermes/rukoo_bridge.py"]
       env:
         RUKOO_KEY: ${API_SERVER_KEY}
       timeout: 120
   ```
   Hermes fills in `${API_SERVER_KEY}` from `~/.hermes/.env`, so the key isn't written into `config.yaml`. Optional settings:
   - `RUKOO_PORT`: the port Rukoo listens on, when it isn't 47800. "Copy Hermes setup" adds it when needed.
   - `RUKOO_URL`: more Rukoo addresses to try, such as `http://desk.example.ts.net:47800/mcp`, separated by commas.
   - `RUKOO_DISCOVER`: `0` turns the Tailscale lookup off, so only `RUKOO_URL` is tried.
   - `RUKOO_TAILSCALE`: the `tailscale` command, when it isn't on the PATH.
   - `RUKOO_CACHE`: where the bridge keeps the last tool list (default: `rukoo_tools.json` next to the script).
4. **Wait a minute.** The gateway runs a reconcile tick every 60 seconds. It starts a newly added, enabled `mcp_servers` entry within about a minute, with no restart needed. The tools show up as `mcp__rukoo__get_context` and so on.
5. **Check it,** with Rukoo open on one of your devices:
   ```sh
   hermes mcp test rukoo
   ```
   It should list Rukoo's ten tools. `hermes mcp list` shows the entry, and the gateway log has a line like `MCP server 'rukoo' ... registered 10 tool(s)`. Don't use `GET /v1/toolsets` to check: it leaves MCP servers out on purpose.

The first `tools/list` has to reach Rukoo once to fill the cache. After that, Hermes keeps the tools even when Rukoo is closed.

A new device needs only step 1.

## Changing the key

A new API server key locks out Rukoo and the bridge alike until both have it. Enter it in Rukoo on each device. On the Hermes machine, the bridge reads the key when it starts. The reconcile tick compares entry names only, so it won't restart the bridge for a changed key. Send `/reload-mcp` to Clark from WhatsApp or Telegram, or run `hermes gateway restart`.

## Timeouts and approvals

- The bridge waits up to 115 seconds for a tool call. `write_draft` waits for Rukoo's composer, which takes at most 20 seconds. Mail actions answer within 90 seconds. Everything else answers in well under a second.
- Choosing a device adds one short request per open Rukoo to each call. Looking for devices takes up to 4 seconds, because a Windows PC without Rukoo drops the connection without answering. That happens in the background, except when no known Rukoo answers.
- `timeout: 120` is Hermes' own limit for a call to this server.
- Rukoo's tools don't block while they wait for the user. `propose_action` and `mail_action` put an approval card in Rukoo and return right away. When the user approves, Rukoo sends Clark a new message. So the entry doesn't need `trust: untrusted`, and Hermes' approval timeout doesn't come into play.

## Troubleshooting

| What the agent says or the log shows | What to do |
|---|---|
| "Rukoo Mail isn't open on any of the user's devices" | Open Rukoo. Check that the device is on the tailnet and shows up in the "Checked" list, and that "Let Clark use Rukoo" is on. A device that isn't listed is offline in Tailscale, or not Windows or macOS: add it with `RUKOO_URL`. |
| "Rukoo Mail is open on ..., but doesn't have your current API server key" | Enter the API server key from `~/.hermes/.env` in Rukoo under Settings > Agents on that device. |
| "Rukoo Mail is open on ..., but that version is too old for this bridge" | That device runs a Rukoo from before this bridge, which can't prove it has the key. Install the latest Rukoo there. |
| "Rukoo Mail on ... refused the key" | The key changed in Rukoo while the bridge was using it. Same fix as above. |
| "The Rukoo bridge has no key" | Add `RUKOO_KEY: ${API_SERVER_KEY}` under the entry's `env:` and check that `API_SERVER_KEY` is in `~/.hermes/.env`, then `/reload-mcp`. |
| `hermes mcp test rukoo` lists no tools and the bridge logs "no tool list is cached yet" | Rukoo has never been reachable from this machine. Open it on one of your devices, then test again. |
| The bridge logs "could not get the device list from Tailscale" | `tailscale` isn't on the PATH Hermes gives the bridge. Set `RUKOO_TAILSCALE` to its full path. |

The bridge logs to stderr with the prefix `rukoo-bridge:`, so its lines end up in the gateway log. It logs a line like `Rukoo is open on laptop` whenever the set of devices changes.
