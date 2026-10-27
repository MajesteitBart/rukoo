# Rukoo Mail for Hermes Agent

Two separate connections link Rukoo and a Hermes agent such as Clark:

- **Rukoo to Hermes.** The chat panel talks to the Hermes API server (`http://<hermes host>:8642`) with the API key from Settings > Agents. This needs nothing on the Hermes side beyond a running API server.
- **Hermes to Rukoo.** Hermes calls Rukoo's MCP tools (`get_context`, `search_mail`, `write_draft`, `show_plan` and the rest) over Tailscale, on whichever of your devices has Rukoo open. This is what `rukoo_bridge.py` is for, and what the steps below set up.

Neither direction uses SSH.

## Why a bridge

Hermes could reach Rukoo's MCP endpoint directly over HTTP. But after a few failed reconnects Hermes parks an HTTP server: it drops the tools and only probes again every five minutes. Rukoo is a desktop app that is closed or asleep for half the day, so the tools would keep disappearing. And a direct connection points at one machine, while you may use Rukoo on several.

`rukoo_bridge.py` is a small stdio MCP server that Hermes starts on its own machine. It answers the MCP handshake itself, serves the tool list from a cache while Rukoo is away, and forwards tool calls to Rukoo. The cache also keeps Rukoo's instructions, which list your [skills](../../docs/agents.md#skills), for the next handshake. When Rukoo can't be reached, the agent gets a normal tool error it can pass on, such as "Rukoo Mail isn't open on any of the user's devices, or can't be reached over Tailscale. Ask the user to open it. Checked: laptop, desk-pc." It needs Python 3.8 or newer and only the standard library. It never uses a proxy from the environment, because a proxy would see the token and can't reach a 100.x address anyway.

It follows the same pattern as `~/.hermes/aight_phone_bridge.py`.

## How it finds Rukoo

- **Which devices.** The bridge runs `tailscale status --json` and tries port 47800 on every online Windows, Linux, Mac and Android device, the Hermes machine itself included. It skips tagged devices, devices shared from another tailnet, and iPhones and iPads, where Rukoo doesn't run. `RUKOO_URL` adds addresses it should try as well. Android reports `localhost` as its host name, so the bridge names a phone by its MagicDNS name, the one the Tailscale app shows.
- **Which key.** Every Rukoo stores the Hermes API key, because it needs the key to chat. The bridge gets the same key from Hermes' `.env` as `RUKOO_KEY`. Both make the MCP token from it, so there is no token to copy, and one setup works for every device.
- **Proof first.** The bridge doesn't send the token to whatever answers on port 47800. It sends a random challenge, and Rukoo answers with a value only a holder of the same key can compute. That value also covers the address Rukoo took the connection on, so a device that passes the challenge on to a real Rukoo elsewhere gets a proof for the wrong address. Tailscale makes sure each address belongs to one device. The token goes only to devices that get it right.
- **Which version.** Rukoo sends its bridge protocol along with the proof, in `X-Rukoo-Bridge-Protocol`. The number covers what the bridge and Rukoo have to agree on: the challenge, the proof, the token and `rukoo/hello`. It goes up only for a change the other side can't follow. When Rukoo's number differs from the bridge's, the bridge sends it no token and reports which of the two is older instead of a wrong key. Bridge version 5 (`serverInfo.version` `bridge-5`) is the first that reads it. A Rukoo from before the header (1.0.0 to 2.0.0) signs the way protocol 2 does.
- **Which device gets a call.** The bridge asks every Rukoo it found whether it has the chat the call is about (`conversation_id`). That device gets the call. A call without a chat, from WhatsApp for instance, goes to the device you used last: the one with the shortest time since its last keyboard or mouse input.
- **When it looks.** At start, and in the background once a minute while calls come in. When no known Rukoo answers, it looks again before giving up.

## Rukoo on an Android phone

[Rukoo for Android](../../docs/android.md) serves the same twelve tools as the desktop app, on the phone's Tailscale address and port 47800, and answers the bridge's challenge the same way. On the phone, enter the same API server key for Clark and turn on "Let agents use Rukoo on this phone"; the bridge then finds the phone like any other device. A Hermes chat started on the phone belongs to the phone, so its tool calls go there. A call without a chat goes to the device you used last; the phone counts as used while Rukoo is in the foreground.

Phones on mobile data often reach the tailnet through a relay. The bridge waits up to 8 seconds for a phone's first answer and its hello, instead of the 4 seconds it gives a computer. Bridge version 4 (`serverInfo.version` `bridge-4`) is the first that looks for phones. With an older bridge, add the phone with `RUKOO_URL=http://<phone's Tailscale IP>:47800/mcp`.

## Setup

1. **Turn it on in Rukoo,** on every device where you use it. Open Settings > Agents and, in the Hermes card, enter the API key and turn on "Let Clark use Rukoo" (the name follows your agent's name). The card shows the address Rukoo listens on, `http://<this PC's Tailscale IP>:47800/mcp`. Rukoo only accepts Clark's token on that address, and only local tokens on 127.0.0.1. Windows asks once whether Rukoo may accept connections; allow it for private networks.
2. **Put the bridge on the Hermes machine.** Take it from the same release as your Rukoo, so the two speak the same bridge protocol. The block from "Copy Hermes setup" (step 3) starts with the command for your version, which downloads the single file from the release tag. You don't need a checkout of the repository:
   ```sh
   curl -fsSL -o ~/.hermes/rukoo_bridge.py https://raw.githubusercontent.com/MajesteitBart/rukoo/v<version>/integrations/hermes/rukoo_bridge.py
   ```
   From a checkout of the same version, copying the file works too:
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
   - `RUKOO_URL`: more Rukoo addresses to try, such as `http://desk.example.ts.net:47800/mcp`, separated by commas. The bridge looks up a host name and connects to its IPv4 address.
   - `RUKOO_DISCOVER`: `0` turns the Tailscale lookup off, so only `RUKOO_URL` is tried.
   - `RUKOO_TAILSCALE`: the `tailscale` command, when it isn't on the PATH.
   - `RUKOO_CACHE`: where the bridge keeps the last tool list and Rukoo's instructions (default: `rukoo_tools.json` next to the script).
4. **Wait a minute.** The gateway runs a reconcile tick every 60 seconds. It starts a newly added, enabled `mcp_servers` entry within about a minute, with no restart needed. The tools show up as `mcp__rukoo__get_context` and so on.
5. **Check it,** with Rukoo open on one of your devices:
   ```sh
   hermes mcp test rukoo
   ```
   It should list Rukoo's twelve tools. `hermes mcp list` shows the entry, and the gateway log has a line like `MCP server 'rukoo' ... registered 12 tool(s)`. Don't use `GET /v1/toolsets` to check: it leaves MCP servers out on purpose.

The first `tools/list` has to reach Rukoo once to fill the cache. After that, Hermes keeps the tools even when Rukoo is closed.

A new device needs only step 1.

## Changing the key

A new API server key locks out Rukoo and the bridge alike until both have it. Enter it in Rukoo on each device. On the Hermes machine, the bridge reads the key when it starts. The reconcile tick compares entry names only, so it won't restart the bridge for a changed key. Send `/reload-mcp` to Clark from WhatsApp or Telegram, or run `hermes gateway restart`.

## Updating Rukoo

Updating Rukoo doesn't update the bridge. Most releases leave the bridge protocol alone, and the bridge you have keeps working. A release that changes it raises the number, and the bridge then says that it is older than that Rukoo. Download the bridge again with the command from "Copy Hermes setup" and send `/reload-mcp`. One bridge speaks one protocol, so with Rukoo on several devices, update Rukoo on all of them.

## Timeouts and approvals

- The bridge waits up to 115 seconds for a tool call, including the time it takes to find the device. `write_draft` waits for Rukoo's composer, which takes at most 20 seconds. Mail actions answer within 90 seconds. Everything else answers in well under a second.
- Choosing a device adds one short request per open Rukoo to each call. Looking for devices takes up to 4 seconds, or 8 when a phone is online, because a Windows PC without Rukoo drops the connection without answering. That happens in the background, except when no known Rukoo answers.
- `timeout: 120` is Hermes' own limit for a call to this server.
- Rukoo's tools don't block while they wait for the user. `propose_action` and `mail_action` put an approval card in Rukoo and return right away. When the user approves, Rukoo sends Clark a new message. So the entry doesn't need `trust: untrusted`, and Hermes' approval timeout doesn't come into play.

## Troubleshooting

| What the agent says or the log shows | What to do |
|---|---|
| "Rukoo Mail isn't open on any of the user's devices" | Open Rukoo. Check that the device is on the tailnet and shows up in the "Checked" list, and that "Let Clark use Rukoo" is on. A device that isn't listed is offline in Tailscale, tagged, shared from another tailnet, or not Windows, Linux, macOS or Android: add it with `RUKOO_URL`. On a phone, also check that Rukoo's tools are turned on in its settings. |
| "Rukoo Mail isn't open on any of the user's devices", from a chat on a phone, with only computers under "Checked" | The bridge is older than `bridge-4` and doesn't look for phones; Rukoo's Settings > Phone tools on the phone says the bridge hasn't reached it. Copy `rukoo_bridge.py` to the Hermes machine again, then send `/reload-mcp` to Clark or run `hermes gateway restart`; Hermes keeps running the old bridge until then. |
| "Rukoo Mail is open on ..., but doesn't have your current API server key" | Enter the API server key from `~/.hermes/.env` in Rukoo under Settings > Agents on that device. A bridge older than `bridge-5` says this for a Rukoo of another bridge protocol as well: if the key is right, download the bridge again (see [Updating Rukoo](#updating-rukoo)). |
| "Rukoo Mail is open on ..., but this Rukoo bridge is older than that Rukoo" | That Rukoo speaks a newer bridge protocol. Download the bridge again with the command from "Copy Hermes setup" in that Rukoo, then send `/reload-mcp` to Clark or run `hermes gateway restart`. |
| "Rukoo Mail is open on ..., but that Rukoo is older than this bridge" | That Rukoo speaks an older bridge protocol. Install the latest Rukoo there. |
| "Rukoo Mail is open on ..., but that version is too old for this bridge" | That device runs a Rukoo from before this bridge, which can't prove it has the key. Install the latest Rukoo there. |
| "Rukoo Mail on ... refused the key" | The key changed in Rukoo while the bridge was using it. Same fix as above. |
| "The Rukoo bridge has no key" | Add `RUKOO_KEY: ${API_SERVER_KEY}` under the entry's `env:` and check that `API_SERVER_KEY` is in `~/.hermes/.env`, then `/reload-mcp`. |
| `hermes mcp test rukoo` lists no tools and the error says "The Rukoo bridge has no tool list yet" | The bridge has never reached Rukoo from this machine. The rest of the message says why, in the words of one of the rows above. Fix that, then test again. |
| The bridge logs "could not get the device list from Tailscale" | `tailscale` isn't on the PATH Hermes gives the bridge. Set `RUKOO_TAILSCALE` to its full path. |

The bridge logs to stderr with the prefix `rukoo-bridge:`, so its lines end up in the gateway log. It logs a line like `Rukoo is open on laptop` whenever the set of devices changes.
