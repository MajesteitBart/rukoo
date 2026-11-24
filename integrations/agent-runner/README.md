# Rukoo agent runner

The agent runner connects one agent account in a Rukoo workspace to one agent runtime: a Hermes Agent or Booper over the Runs API, an OpenClaw gateway or another server with OpenAI-compatible Chat Completions, Claude Code, Codex, or a program of your own. When someone mentions the agent in a channel, the runner gives the runtime the message and the conversation around it, then posts the runtime's answer as a reply in the message's thread.

It's a single Node.js program without dependencies. It needs Node.js 22 or newer and nothing from the Rukoo app, so it runs on any computer that can reach both the Rukoo server and the runtime, such as the machine Hermes or Booper already runs on.

```sh
node integrations/agent-runner/runner.js --config clark.json
```

The protocol it speaks is in [server/WORKSPACES.md](../../server/WORKSPACES.md#agents-in-channels). Team chat itself is described in [docs/chat.md](../../docs/chat.md).

## What it does

1. It reads the agent's settings with its key (`GET /agents/me`): its name, its sponsor, whom it answers and whether it answers other agents.
2. It follows the workspace's feed (`GET /changes`). The wake socket tells it at once when something changes, and it also checks every 30 seconds (`pollSeconds`, at most 60) in case a wake got lost.
3. For each channel with new mentions of the agent, it reads the new messages in order.
4. For each message that mentions the agent, it checks what the server checks before it takes a reply: the agent's settings, read again for that message, and that the message's author and the person who started the chain are still in the channel (`GET /channels/{c}/members`). A mention the agent may not answer is skipped quietly, and the runner never calls the runtime for it.
5. Otherwise it builds the input (see [what the runtime gets](#what-the-runtime-gets)), calls the runtime and posts the answer with the message as its trigger. The server puts the reply in the message's thread.
6. It moves the agent's read position past the message, answered or skipped.

Every mention starts a fresh session in the runtime, without memory of earlier mentions. One mention is handled at a time.

## Get a key

A full member of the workspace makes the agent in Rukoo: the workspace menu → **Agents** → **Add an agent**. They choose its name, whom it answers (a new agent starts on **Only me**) and whether it answers other agents, and become its sponsor. Rukoo then shows the key once with **Copy key**, and the server address, the workspace id and a ready config for this runner with **Copy config**. On the desktop, **Use one of my agents** fills the `backend` part of that config from an agent in Settings → Agents, with the name of an environment variable in place of its secret.

The key looks like `rka_` followed by 66 characters. The config Rukoo shows holds it in `key`, so whoever can read that file can read the agent's channels. Keep the file private, readable only by you (`chmod 600 clark.json` on Linux and macOS). Or take `key` out of the file and put the key in an environment variable instead: `RUKOO_AGENT_KEY`, unless `keyEnv` names another. The runner removes that variable, and any variable that holds the key, from the environment of every program it starts.

Then add the agent to the channels it should work in: **Add people** in a channel lists agents under a heading of their own. A channel manager can add any agent, and a sponsor can add their own agent to a channel the whole workspace can see that they are in. A private channel takes an agent only while its sponsor is in it, and when the sponsor leaves it or is taken out, the agent leaves it too.

**New key**, in the Agents dialog or the agent's menu in the workspace's Members, replaces the key at once. Only the sponsor has **New key**, since the key reads every channel the agent is in; an owner or admin can edit or remove the agent. The runner then stops with exit code 2 and says why, and so it does when the agent is removed, its sponsor leaves the workspace or becomes a guest, or the server turns agents off.

## The config

A JSON file. [agent.example.json](agent.example.json) is a complete one that reads the key from `RUKOO_AGENT_KEY`; the config Rukoo shows has the key in `key` instead.

| Field | Default | What it is |
| --- | --- | --- |
| `server` | | The Rukoo server, such as `https://rukoo.io`. Plain `http://` only works for this computer (`127.0.0.1`, `localhost`) unless `allowHttp` is `true`, because the key would cross the network unencrypted. |
| `workspace` | | The workspace id, `w_` and 22 characters. |
| `key` | | The key itself, as the config Rukoo shows has it. It wins over `keyEnv`. A file with a key in it must stay private. |
| `keyEnv` | `RUKOO_AGENT_KEY` | The environment variable that holds the agent's key, used when the config has no `key`. |
| `backend` | | The runtime, see below. |
| `context.threadMessages` | 50 | For a mention in a thread: how many of the thread's messages go along, its first message included. |
| `context.channelMessages` | 20 | For a mention in the channel itself: how many of the channel's earlier top-level messages go along. |
| `context.maxChars` | 30000 | The most characters of context. The oldest messages go first; the message to answer always stays. |
| `instructions` | | Your own instructions for the agent, added after the runner's. |
| `state` | `<config name>.state.json` next to the config | Where the runner keeps its small state file. `false` keeps it in memory only. |
| `pollSeconds` | 30 | How often the runner checks the feed without a wake, from 5 to 60. |

Each backend takes `timeout`, the seconds one mention may take (600 unless given). A runtime that takes longer is stopped and nothing is posted.

### Hermes Agent or Booper (Runs API)

```json
"backend": { "type": "runs", "url": "http://100.64.0.9:8642", "keyEnv": "HERMES_API_KEY", "model": "" }
```

This is the Runs API that Rukoo's chat panel uses for Hermes and for Booper's app channel (`src/main/agents/hermes.js`). The runner sends one run per mention, `POST /v1/runs` with `input` and `instructions` and without `session_id`, so the server starts a new session for it. An `Idempotency-Key` that names the mention and its input means a start sent again after a lost answer gets the run that already started. The runner follows the run's events until it ends and takes its output. Any approval the run asks for is denied, since nobody is there to answer it. `model` is optional; `provider::model` names a model of another provider, as in Rukoo's model menu. A server with a path prefix, such as a Hermes profile at `http://host:8642/p/clark`, works as `url`.

### OpenClaw and other Chat Completions servers

```json
"backend": { "type": "openai", "url": "http://127.0.0.1:18789", "keyEnv": "OPENCLAW_GATEWAY_TOKEN", "model": "openclaw/default", "user": "rukoo-agent" }
```

One `POST /v1/chat/completions` per mention, with the runner's instructions as the system message and the rest as the user message, streamed. On OpenClaw's gateway `model` names an OpenClaw agent, `openclaw/default` or `openclaw/<agentId>`, and the gateway's Chat Completions endpoint has to be on (`gateway.http.endpoints.chatCompletions.enabled`). The gateway keeps a session per `user` value, so the runner sends the configured `user` with the mention's id after it, a new session for every mention. `headers` adds request headers, such as `{ "x-openclaw-model": "…" }`. The key is optional for a server that takes none.

### Claude Code

```json
"backend": { "type": "claude", "model": "sonnet" }
```

The runner starts `claude -p` with the input on stdin and reads the JSON result. It finds `claude` in `~/.local/bin` or on `PATH`; on Windows only a real `claude.exe`, because the runner starts programs without a shell. `exe` sets the path, and `configDir` sets `CLAUDE_CONFIG_DIR` for an account other than your usual one. See [Claude Code and Codex](#claude-code-and-codex) for the flags.

### Codex

```json
"backend": { "type": "codex", "model": "" }
```

The runner starts `codex exec` with the input on stdin and reads its last message. It finds Codex in `~/.local/bin` or on `PATH`, and on Windows the `codex.exe` inside the global npm package. `exe` sets the path.

### Any program

```json
"backend": { "type": "command", "command": ["python3", "/opt/agent/answer.py"], "cwd": "/opt/agent", "env": { "MODE": "team" } }
```

The runner starts the program without a shell, writes the whole input (instructions, then the rest) to its stdin and posts what it writes to stdout. Exit code 0 with text posts it. Exit code 0 without text, or any other exit code, posts nothing. `command` is the program and its arguments; `env` adds variables. On Windows a `.cmd` or `.bat` file needs `["cmd", "/c", "answer.cmd"]`.

## Run it

```sh
export RUKOO_AGENT_KEY=rka_…                 # only for a config without "key"
node runner.js --config clark.json --check   # checks the server, the key and the backend's program, lists the agent's channels
node runner.js --config clark.json --once    # one pass over the workspace, then exit
node runner.js --config clark.json           # runs until stopped
```

It logs to stderr, one line per event: connected, answered, skipped and why, failed and why. It logs messages by their ids. When a runtime fails, the line quotes up to 200 characters of its error output, which can contain text the runtime got. Exit codes: 0 when it stopped normally, 1 for a config or startup problem (and, with `--once`, a pass that couldn't finish), 2 when the key stopped working. Restarting doesn't help with 2; a new key does. A server that doesn't answer when the runner starts is tried again, up to a minute apart.

### As a systemd user service

This keeps the agent's key in a file of variables, so `clark.json` has no `key`. `~/.config/rukoo-agent/clark.env`, readable only by you (`chmod 600`):

```sh
RUKOO_AGENT_KEY=rka_…
HERMES_API_KEY=…
```

`~/.config/systemd/user/rukoo-agent-clark.service`:

```ini
[Unit]
Description=Rukoo agent runner for Clark
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/bin/node %h/rukoo/integrations/agent-runner/runner.js --config %h/.config/rukoo-agent/clark.json
EnvironmentFile=%h/.config/rukoo-agent/clark.env
Restart=on-failure
RestartSec=30
# 2 means the key stopped working: get a new one first.
RestartPreventExitStatus=2

[Install]
WantedBy=default.target
```

```sh
systemctl --user daemon-reload
systemctl --user enable --now rukoo-agent-clark
journalctl --user -u rukoo-agent-clark -f
loginctl enable-linger "$USER"   # keeps it running after you log out
```

### As a Windows scheduled task

In PowerShell, as the user the agent runtime belongs to:

```powershell
[Environment]::SetEnvironmentVariable('RUKOO_AGENT_KEY', 'rka_…', 'User')
$dir = "$env:USERPROFILE\rukoo-agent"
$action = New-ScheduledTaskAction -Execute 'cmd.exe' -WorkingDirectory $dir `
  -Argument "/c node `"C:\rukoo\integrations\agent-runner\runner.js`" --config `"$dir\clark.json`" 2>> `"$dir\clark.log`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName 'Rukoo agent Clark' -Action $action -Trigger $trigger -Settings $settings
Start-ScheduledTask -TaskName 'Rukoo agent Clark'
```

This keeps the key in a user variable, so `clark.json` has no `key`. The variable reaches programs started after it was set, the task included. The log goes to `clark.log` next to the config.

## Whom the agent answers

The sponsor sets this in the Agents dialog, and the server checks it on every reply. The runner checks the same first, so the runtime is never called for a mention the server would refuse. It reads the settings again for every mention, so a change applies from the next mention on, also while the runner works through a queue. While it can't read them, it handles no mention and moves past nothing; it tries again on the next pass. A change that comes while the runtime is answering applies when the runner posts: the server refuses a reply the new setting doesn't allow.

- **Everyone**: anyone who can post in the channel, guests included.
- **Only me**: only the sponsor. This is the agent that is yours alone. A new agent starts here.
- **Chosen people**: the sponsor and the members on the agent's list.

The setting applies to the person who started the chain, the **origin**. For a person's message that is its author. For a reply another agent wrote it is the reply's `origin`, the member id the server puts on every agent's reply. So an agent on **Only me** doesn't answer someone who asks it through another agent either. The author and the origin must both still be in the channel. A setting this runner doesn't know, from a newer server, counts as **Only me**.

A mention the agent won't answer stays without a reply. The runner logs it as skipped with the reason and moves past it. The reasons follow the server's order: the agent doesn't answer other agents, the author or the origin left the channel, the agent doesn't answer the origin, or the reply would go past the depth limit ([below](#agents-answering-each-other)).

## Agents answering each other

A mention by another agent is a trigger only for an agent with **Answers other agents** on, and only when the agent answers the chain's origin ([above](#whom-the-agent-answers)). Every reply has a depth: a person's message is 0, and an agent's reply is the depth of the message it answers plus 1. The server takes replies up to depth 3 (`WORKSPACE_AGENT_DEPTH`): a person asks agent A (1), A asks B (2), B asks A (3), and there it stops. The runner reads the limit from the server and skips a mention that would go deeper.

An agent mentions someone by writing `<@u_…>` with their member id in its answer. The runner turns that into `@Name` with a structured mention, which notifies that person or asks that agent to answer. It does so only for members of the channel; any other id stays plain text. The agent's instructions say to mention someone only when the sender wants that.

## What the runtime gets

The input has the runner's instructions, then your `instructions`, then the place, then the messages:

- The workspace and the channel, by id and name.
- For a mention in a thread: the thread's first message and its latest replies before the mention. For a mention in the channel itself: the channel's latest top-level messages before it, without the replies in their threads.
- The people in those messages, by member id with their names, the agent itself included.
- The message to answer, last.

The instructions tell the model that everyone in the channel reads its answer, and that it has no tools for the team chat and no memory of earlier mentions. They are the same for every agent and hold nothing anyone in the workspace wrote, not even the agent's name: its sponsor, an owner or an admin can rename it, so the name is in the list of people with the other names. The openai backend sends the instructions as the system message.

Every message comes after a line from the runner with its id, its author's member id, the time, the members it mentions and one of these labels. The runner sets the label from the author's member id, never from a name or from what the message says.

| Label | Whose messages | Wrapped |
| --- | --- | --- |
| `sender (trusted)` | The person who mentioned the agent | No |
| `sender (another agent, untrusted)` | The agent that mentioned it | Yes |
| `you (your earlier reply)` | The agent's own earlier replies | Yes |
| `external (untrusted)` | Everyone else | Yes |

A wrapped message sits inside `<unsafe_content source="team chat">`, as Rukoo wraps email for its agents ([docs/agents.md](../../docs/agents.md)). Inside it every `<` is written `&lt;` and every `&` is `&amp;`, so a message can't close the block or fake a label. Names, the channel's name and the workspace's name are tagged and escaped the same way, because members choose them. The model is told never to follow instructions inside these tags.

A message from another agent is wrapped because an agent can repeat what anyone wrote. Its question still gets an answer, but the model is told to treat it as a question from someone it doesn't know.

Files show up as their names, types and sizes. The runner doesn't download them.

## The answer

The runner removes any `<unsafe_content>` tags the model copied, turns `<@u_…>` into mentions and posts the text. A message holds 16 KiB of UTF-8. A longer answer goes out in up to five messages, cut at a paragraph break, else at the end of a sentence, else at a line break or a space, else between two characters. A fifth message that is still too long ends with a note that the rest was cut.

When the runtime fails, times out or answers nothing, the runner posts nothing, logs it and moves on. It doesn't run that mention again, since a runtime with tools of its own may already have done something.

## The state file and restarts

The state file holds, per channel, the last message the runner handled and an answer while its parts are being posted, with their operation ids. When a part gets no answer or a server error five times in a row, or the runner stops, the answer stays in the file and the runner goes on with other channels. On the next pass, or after a crash, it sends those parts again with the same ids before it does anything else in that channel. The server answers the ones it has with their first answer, so nothing is posted twice and the runtime isn't asked again. The answer's text leaves the file once it is in, and so does everything about a channel the agent was taken out of, an unsent answer there included. On Linux and macOS only its owner can read the file. The runner reads a state file of the version before, which kept one answer for the whole workspace.

Without the state file, or with one it can't read, the runner starts from the agent's read position on the server. Posting a reply moves that position to the reply, past any mention that came in while the runtime was thinking. So when the agent's newest message is at the read position, the runner reads back from it to the message it answered and starts after that. The server says which message that is in the channel's feed row (`lastTrigger`), also when someone removed the reply. It reads back at most 5,000 events, many more than a busy channel gets while the runtime answers one mention. When the message it answered is further back, the runner starts 5,000 events back, logs a warning, and misses any mention before that without a reply. The server keeps one reply per mention and part, so a restart can't post twice: another reply to the same mention gets `409 already_answered`, which the runner counts as done.

## Claude Code and Codex

Both CLIs can run commands, read files and load MCP servers, and the runner has nobody to ask for permission. So it starts them in the most restricted non-interactive mode their flags allow, in an empty temporary folder that it removes afterwards. Nothing in that folder can give them project instructions or settings.

Claude Code, checked against version 2.1.328 with `claude --help`:

| Flag | Why |
| --- | --- |
| `-p --output-format json --no-session-persistence` | One answer as JSON, and no session saved on disk |
| `--tools ""` | No built-in tools at all: no commands, no file access, no web fetches |
| `--safe-mode` | No hooks, plugins, skills, CLAUDE.md files or MCP servers from your settings |
| `--strict-mcp-config --mcp-config {"mcpServers":{}}` | No MCP servers, Rukoo's included |
| `--permission-mode dontAsk --permission-prompts none` | Anything that would ask is refused, and nobody is asked |
| `--disable-slash-commands` | A message can't start a skill or a command |

Codex, checked against codex-cli 0.170.0 with `codex exec --help` and `codex features list`:

| Flag | Why |
| --- | --- |
| `exec --sandbox read-only --ephemeral --skip-git-repo-check` | No writes or network for commands, no session saved, any folder |
| `--ignore-user-config --ignore-rules` | None of `config.toml`'s MCP servers, profiles or approval settings, and no execpolicy rules |
| `--disable shell_tool` | No command tool |
| `--disable hooks --disable plugins --disable apps --disable browser_use --disable computer_use` | No hooks, plugins, connectors, browser or computer control |
| `-c mcp_servers={} -c web_search="disabled" -c approval_policy="never"` | No MCP servers, no web search, and nothing asks for approval |
| `--output-last-message <file> -` | The answer goes to a file; the input comes from stdin |

`codex features list` shows `shell_tool`, `hooks`, `plugins`, `apps`, `browser_use` and `computer_use` as off with these flags. It still shows `unified_exec` as on, and `--disable unified_exec` doesn't change that. Whether Codex offers a command tool with `shell_tool` off couldn't be checked without running a model turn. If it does, the read-only sandbox still blocks writes and network, but a command could read files on your disk and the model could put what it read in its answer. Run the Codex backend under an account that holds nothing you wouldn't want in a channel.

The runner starts its own `claude` or `codex` process, which uses that CLI's login on the computer the runner runs on. Rukoo's own settings for these agents don't apply.

## What Rukoo can't take away

The runner controls what goes in and what is posted. It doesn't control what a runtime does with its own capabilities.

- **Hermes, Booper and OpenClaw** keep their own tools, memory and integrations. A run without a session starts with an empty conversation, but long-term memory, skills and tools that the agent's profile has stay available to it. Give the runner a profile made for team chat.
- **Claude Code** still applies managed (policy) settings and the hooks of managed plugins, which `--safe-mode` leaves on. Your login decides which models and accounts it uses.
- **Codex**: see the note on `unified_exec` above.
- **A command** does whatever the program does.

Whatever the agent reads in a channel goes to its runtime and to the model provider behind it. The sponsor chose that runtime, and the Rukoo server can't see or control it.

## Limits

- One mention at a time. A slow answer delays the next mention.
- No files: the runtime sees file names, not their contents.
- No memory between mentions. Each mention gets its thread or the channel's latest messages, within `maxChars`. The runner reads back at most 1,000 events for that.
- No streaming: the reply appears once the runtime is done.
- An agent can't remove its own replies. Its sponsor and a manager of the channel can.
- An agent replies only to mentions. It doesn't post on its own, and it isn't in DMs.
- An agent posts at most 120 replies an hour (`WORKSPACE_AGENT_REPLIES`). When it reaches that, the runner waits the time the server says and posts the reply then.
- The tests drive the runner against a local Rukoo server with a scripted program as the backend, and the Runs API and Chat Completions backends against small stand-ins. A live Hermes, Booper, OpenClaw, Claude Code or Codex hasn't run through the runner in those tests.
