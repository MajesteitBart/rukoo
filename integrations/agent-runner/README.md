# Rukoo agent runner

The agent runner connects one agent account in a Rukoo workspace to one agent runtime: a Hermes Agent or Booper over the Runs API, an OpenClaw gateway or another server with OpenAI-compatible Chat Completions, Claude Code, Codex, or a program of your own. When someone mentions the agent in a channel, the runner gives the runtime the message and the conversation around it, then posts the runtime's answer as a reply in the message's thread.

It's a small Node.js program without dependencies. It needs Node.js 22 or newer and nothing from the Rukoo app, so it runs on any computer that can reach both the Rukoo server and the runtime, such as the machine Hermes or Booper already runs on.

```sh
node runner.js --config clark.json
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

## Get the runner

Rukoo's desktop app ships this folder and runs it for you: **Run on this computer** in the key step after **Add an agent** starts the agent with one of the agents of Settings → Agents answering, with nothing to install or set ([In Rukoo's desktop app](#in-rukoos-desktop-app)). To run it on another computer, such as the machine Hermes or Booper already runs on, get it from this folder of the Rukoo repository on GitHub. It needs [Node.js](https://nodejs.org) 22 or newer on the computer it runs on (`node --version` says which one you have). `runner.js` loads `rukoo.js`, `backends.js` and `prompt.js` from its own folder and nothing else, so download those four files into one folder:

```sh
mkdir rukoo-agent && cd rukoo-agent
for f in runner.js rukoo.js backends.js prompt.js; do
  curl -fsSLO "https://raw.githubusercontent.com/MajesteitBart/rukoo/main/integrations/agent-runner/$f"
done
```

In PowerShell on Windows:

```powershell
mkdir rukoo-agent; cd rukoo-agent
foreach ($f in 'runner.js', 'rukoo.js', 'backends.js', 'prompt.js') {
  Invoke-WebRequest "https://raw.githubusercontent.com/MajesteitBart/rukoo/main/integrations/agent-runner/$f" -OutFile $f
}
```

A clone of the repository works too: `git clone https://github.com/MajesteitBart/rukoo`, then the folder `rukoo/integrations/agent-runner`. Save the config Rukoo shows next to `runner.js` as `agent.json`, check it, and start it:

```sh
node runner.js --config agent.json --check
node runner.js --config agent.json
```

## Get a key

A full member of the workspace makes the agent in Rukoo: the workspace menu → **Agents** → **Add an agent**. They choose its name, whom it answers (a new agent starts on **Only me**) and whether it answers other agents, and become its sponsor. Rukoo then shows **Connect** for the agent:

1. **Answers with** picks the runtime that answers for the agent. On the desktop it lists the agents of Settings → Agents that can answer, the ones whose status check passed first, so the first ready one is picked; in the browser and on the phone it offers Claude Code and Codex. **A program of my own** comes last and leaves `"command": "my-agent"` in the config for you to replace. An agent with a secret, such as a Hermes API key, gets the name of an environment variable in place of that secret.
2. On the desktop, **Run on this computer** runs the agent there ([In Rukoo's desktop app](#in-rukoos-desktop-app)). The config below is under **Run it on another computer instead**.
3. **Copy config** copies the config for this runner, with the server's address, the workspace id and the agent's key in it; on the desktop **Save config** saves it to a file instead. Rukoo shows the key only this once. Then how to start the runner, as above, with **Get the runner on GitHub**, which opens this section.

After **Add an agent** the step also offers to add the new agent to the channel on screen, when its sponsor may add it there.

The key looks like `rka_` followed by 66 characters. The config Rukoo shows holds it in `key`, so whoever can read that file can read the agent's channels. Keep the file private, readable only by you (`chmod 600 clark.json` on Linux and macOS). Or take `key` out of the file and put the key in an environment variable instead: `RUKOO_AGENT_KEY`, unless `keyEnv` names another. The runner removes that variable, and any variable that holds the key, from the environment of every program it starts.

Then add the agent to the channels it should work in: **Add people** in a channel lists agents under a heading of their own. A channel manager can add any agent, and a sponsor can add their own agent to a channel the whole workspace can see that they are in. A private channel takes an agent only while its sponsor is in it, and when the sponsor leaves it or is taken out, the agent leaves it too.

**New key**, in the Agents dialog or the agent's menu in the workspace's Members, replaces the key at once. Only the sponsor has **New key**, since the key reads every channel the agent is in; an owner or admin can edit or remove the agent. The runner then stops with exit code 2 and says why, and so it does when the agent is removed, its sponsor leaves the workspace or becomes a guest, or the server turns agents off. A runner that Rukoo's desktop app runs takes the new key by itself.

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
| `privateFilesOrigin` | | Only for a Rukoo server on a private network whose file links use an origin of their own (`WORKSPACE_FILES_ORIGIN`), such as `https://files.example.internal`: that one origin may be on a private address. Without it, the runner downloads from a server's files origin only at a public address ([Files](#files)). It takes an origin alone, checked as `server` is: `https`, or plain `http` on this computer or with `allowHttp`. |
| `instructions` | | Your own instructions for the agent, added after the runner's. |
| `state` | `<config name>.state.json` next to the config | Where the runner keeps its small state file. `false` keeps it in memory only. |
| `pollSeconds` | 30 | How often the runner checks the feed without a wake, from 5 to 60. |

Each backend takes `timeout`, the seconds one mention may take (600 unless given). A runtime that takes longer is stopped and nothing is posted.

### Hermes Agent or Booper (Runs API)

```json
"backend": { "type": "runs", "url": "http://100.64.0.9:8642", "keyEnv": "HERMES_API_KEY", "model": "" }
```

This is the Runs API that Rukoo's chat panel uses for Hermes and for Booper's app channel (`src/main/agents/hermes.js`). The runner sends one run per mention, `POST /v1/runs` with `input` and `instructions` and without `session_id`, so the server starts a new session for it. An `Idempotency-Key` that names the mention and its input means a start sent again after a lost answer gets the run that already started. The runner follows the run's events until it ends and takes its output. Any approval the run asks for is denied, since nobody is there to answer it. `model` is optional; `provider::model` names a model of another provider, as in Rukoo's model menu. A server with a path prefix, such as a Hermes profile at `http://host:8642/p/clark`, works as `url`.

`input` is text, so this backend sends no images: the input names each image and says the agent can't see it ([Files](#files)). Rukoo's chat panel sends Hermes and Booper no images with a message either; they open an image with Rukoo's `read_chat_file` tool, which the runner doesn't offer. Booper's app channel keeps only the text parts of an `input` that is a list of messages.

### OpenClaw and other Chat Completions servers

```json
"backend": { "type": "openai", "url": "http://127.0.0.1:18789", "keyEnv": "OPENCLAW_GATEWAY_TOKEN", "model": "openclaw/default", "user": "rukoo-agent" }
```

One `POST /v1/chat/completions` per mention, with the runner's instructions as the system message and the rest as the user message, streamed. On OpenClaw's gateway `model` names an OpenClaw agent, `openclaw/default` or `openclaw/<agentId>`, and the gateway's Chat Completions endpoint has to be on (`gateway.http.endpoints.chatCompletions.enabled`). The gateway keeps a session per `user` value, so the runner sends the configured `user` with the mention's id after it, a new session for every mention. `headers` adds request headers, such as `{ "x-openclaw-model": "…" }`. The key is optional for a server that takes none.

Images go along as `image_url` parts with `data:` URLs, each after a text part that names its file ([Files](#files)). A model or server that takes no images refuses such a request; when it answers 400, 413, 415 or 422, the runner sends the mention once more as text alone, with every image named as one the agent can't see, under a `user` of its own. Both tries share the one `timeout`. A server error (500 and up) isn't tried again: the first try may have run tools before it failed.

### Claude Code

```json
"backend": { "type": "claude", "model": "sonnet" }
```

The runner starts `claude -p` with the input on stdin and reads the JSON result. With images it sends one user message of stream-json instead, with each image as an image block after a text block that names its file, as Rukoo's chat panel sends them. It finds `claude` in `~/.local/bin` or on `PATH`; on Windows only a real `claude.exe`, because the runner starts programs without a shell. `exe` sets the path, and `configDir` sets `CLAUDE_CONFIG_DIR` for an account other than your usual one. See [Claude Code and Codex](#claude-code-and-codex) for the flags.

### Codex

```json
"backend": { "type": "codex", "model": "" }
```

The runner starts `codex exec` with the input on stdin and reads its last message. Images go as files with `--image`: the runner writes them to the run's own temporary folder, outside the empty folder Codex works in, named `image-1.png` and so on, and removes them with that folder. It finds Codex in `~/.local/bin` or on `PATH`, and on Windows the `codex.exe` inside the global npm package. `exe` sets the path.

### Any program

```json
"backend": { "type": "command", "command": ["python3", "/opt/agent/answer.py"], "cwd": "/opt/agent", "env": { "MODE": "team" } }
```

The runner starts the program without a shell, writes the whole input (instructions, then the rest) to its stdin and posts what it writes to stdout. A program gets no images: the input names each image and says the agent can't see it. Exit code 0 with text posts it. Exit code 0 without text, or any other exit code, posts nothing. `command` is the program and its arguments; `env` adds variables. On Windows a `.cmd` or `.bat` file needs `["cmd", "/c", "answer.cmd"]`.

## Run it

```sh
export RUKOO_AGENT_KEY=rka_…                 # only for a config without "key"
node runner.js --config clark.json --check   # checks the backend, the server, the key and the agent's channels
node runner.js --config clark.json --once    # one pass over the workspace, then exit
node runner.js --config clark.json           # runs until stopped
```

`--check` answers one question about the backend: can it answer? It fails, with exit code 1 and a line that says what to do, when it can't: a `command` or `claude` or `codex` program that isn't found where the runner looks for it, on Windows a `.cmd` or `.bat` file named directly (wrap it as above), the placeholder `my-agent` still in `command`, or a `runs` or `openai` server that can't, as the table below says. It also warns, and passes, when the agent is in no channel yet, since no mention can reach it there.

A `runs` or `openai` backend is asked the routes its contract has, in order, with the headers a run sends, the key included. Each route waits up to 5 seconds. A route is required when the backend can't answer without it; `/v1/models` of an OpenAI-compatible server other than OpenClaw isn't, because such a server can chat without it. The check can't tell only on a route that isn't required, and then it passes with a warning that names the route. An `openai` backend is OpenClaw's when its `model` is `openclaw/…` or its `headers` have `x-openclaw-model`, as the config Rukoo gives for OpenClaw has.

| Backend | Route | Answer | Verdict |
| --- | --- | --- | --- |
| `runs` or `openai` | the first route | no connection | Can't answer: nothing answers at the address |
| `runs` or `openai` | the first route | no answer within 5 seconds | Can't answer: nothing answers at the address |
| `runs` (Hermes, Booper) | `GET /health`, required | 2xx with a JSON object | Goes on to `/v1/capabilities` |
| `runs` | `GET /health` | 2xx with anything else, such as an HTML page | Can't answer: not a Runs API server |
| `runs` | `GET /health` | any other status, a redirect or 404 included | Can't answer |
| `runs` | `GET /v1/capabilities`, required | 2xx with a JSON object | Can answer |
| `runs` | `GET /v1/capabilities` | 401 or 403 | Can't answer: the key was refused |
| `runs` | `GET /v1/capabilities` | 404 | Can't answer: the route is missing |
| `runs` | `GET /v1/capabilities` | any other status, or no answer within 5 seconds | Can't answer |
| `runs` | `GET /v1/capabilities` | 2xx with anything but a JSON object, or with `features.run_submission` false | Can't answer |
| `openai` for OpenClaw | `GET /v1/models`, required | 2xx with a JSON object whose `data` is a list | Can answer |
| `openai` for OpenClaw | `GET /v1/models` | 401 or 403 | Can't answer: the token was refused |
| `openai` for OpenClaw | `GET /v1/models` | 404 | Can't answer: the gateway's Chat Completions endpoint is off |
| `openai` for OpenClaw | `GET /v1/models` | any other status | Can't answer |
| `openai` for OpenClaw | `GET /v1/models` | 2xx with anything else | Can't answer |
| `openai`, another server | `GET /v1/models`, not required | 2xx with a JSON object whose `data` is a list | Can answer |
| `openai`, another server | `GET /v1/models` | 2xx with anything else, such as an HTML page | Can't answer |
| `openai`, another server | `GET /v1/models` | 401, 403, 404 or any other status | Couldn't tell: a warning that names `/v1/models` |

401 and 403 mean a refused key where Rukoo's own adapters for these servers read them so (`src/main/agents/hermes.js`, `openclaw.js`). When the variable that `keyEnv` names isn't set, the line for a refused key says to set it; when the server answered without a key, a warning says the runner sends none. The lines name a backend by its address's origin, never its path or query, and never quote what a server answered.

A normal start logs the check's errors and warnings as warnings and runs anyway, because a server can come up later. Stopping the runner while the check or the first connection to the Rukoo server still waits stops it at once.

It logs to stderr, one line per event: connected, answered, skipped and why, failed and why. It logs messages by their ids. When a runtime fails, the line quotes up to 200 characters of its error output, which can contain text the runtime got. Exit codes: 0 when it stopped normally, 1 for a config or startup problem (and, with `--once`, a pass that couldn't finish), 2 when the key stopped working, and 3 when a pinned program is no longer the file that was approved ([In Rukoo's desktop app](#in-rukoos-desktop-app)). Restarting doesn't help with 2; a new key does. A server that doesn't answer when the runner starts is tried again, up to a minute apart.

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

## In Rukoo's desktop app

The desktop app (`src/main/agent-runs.js`) runs the four program files of this folder as they ship inside the app, one process per agent, for as long as Rukoo runs, in the tray too. It needs no Node.js of its own: Electron's utility process runs `src/main/agent-runner-child.js`, which loads `runner.js` from here. [docs/chat.md](../../docs/chat.md#running-it-on-this-computer) describes it from the person's side.

- The backend is one of the agents of Settings → Agents, built from those settings, as the config the key step shows has it. The app never takes a backend from anywhere else, so it never runs a `command` backend. Before it runs one, the app asks the person in a native question. For `claude` and `codex` the question names the program as one absolute, canonical file (links resolved, on Windows an `.exe` named so) and the settings folder as an absolute path; a program or folder that can't be named that way is refused. For a server it names the address of each request as `endpoint()` builds it, and for an OpenClaw gateway the agent there that answers. The app starts the runner only with exactly what was approved and checks that again before each start.
- For `claude` and `codex` the app passes that file as `exe` with `"pin": true`. With `pin`, the runner starts exactly that file and looks for nothing on `PATH`, and before each turn it checks that the path is still absolute, canonical and that file. When it isn't, the runner reports `changed`, stops and exits with code 3, and the app asks again before it runs.
- A backend's own secret goes over plain `http` only to this computer, a private or tailnet address (10/8, 172.16/12, 192.168/16, 100.64/10, fc00::/7) or a `.ts.net` name. The app refuses any other plain `http` address for a backend with a secret; `https` can go anywhere the person approved.
- The app writes no config: it passes the config, the agent's key and the backend's own secret to the runner's process in one first message. The key is kept encrypted with the system's keyring. Neither secret is in that process's environment or on disk in the clear, and the runner keeps both out of every program it starts, by name and by value. What the process writes to stderr is the time, the level and a code or a count, never a log message, which can quote a server or a backend.
- `Runner` takes a `report` function next to `log`; the app uses it for the line it shows under the agent: connected, the channels it is in, the backend's problems from the checks above, a failed answer, a server it can't reach, a key that stopped working. The events carry ids, counts, the runner's codes (a `BackendError`'s `code`, and an HTTP status) and never text that a server, a backend or a message wrote.
- `stop()` lets a turn in flight end for up to 4 seconds before `run()` returns, also in the first pass: a program the backend started ends with what it started, and a Runs API run gets its stop request. A run whose `POST /v1/runs` is still out gets up to a second more to answer its id, which the runner then stops. The runner's reads of the workspace end at once on `stop()`.
- The runner reads at most 8 MiB of an answer from the Rukoo server, 4 MiB of a backend's JSON answer, 1 MiB of a streamed answer and 64 KiB of an error. It counts the bytes of a streamed line and event, line ends included, as they arrive, and stops reading the stream past 1 MiB.
- The runner has no reader for PDFs of its own. In the app, `Runner` takes a `readPdf` function next to `report`: the runner's process sends the PDF to Rukoo's main process, which reads its text layer with the reader of the chat panel (`src/main/pdfread.js`), each PDF in a process of its own with a time limit of 10 seconds and a memory cap, and sends back the text, at most 20,000 characters.
- A runner that ends by itself starts again after 2 seconds, then after longer pauses up to 5 minutes. Exit code 2 keeps it stopped until New key; when the agent turns out to be removed, the app deletes its key and state file. Signing out, leaving the workspace or removing the agent does that too.

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
- After each message, its files ([Files](#files)).
- The message to answer, last.

The instructions tell the model that everyone in the channel reads its answer, and that it has no tools for the team chat and no memory of earlier mentions. They say what it gets of files, that agent keys are taken out, and never to write a key or a config in an answer. They also say how the agent got into the workspace and what to answer when someone asks it to join another one: it can't do that itself, and no agent moves between workspaces, so a full member of the other workspace makes a new agent there with **Agents** → **Add an agent**, which gets a key of its own, and runs it with **Run on this computer** on the desktop or puts the config Rukoo shows into a runner. The instructions are the same for every agent and hold nothing anyone in the workspace wrote, not even the agent's name: its sponsor, an owner or an admin can rename it, so the name is in the list of people with the other names. The openai backend sends the instructions as the system message.

Every message comes after a line from the runner with its id, its author's member id, the time, the members it mentions and one of these labels. The runner sets the label from the author's member id, never from a name or from what the message says.

| Label | Whose messages | Wrapped |
| --- | --- | --- |
| `sender (trusted)` | The person who mentioned the agent | No |
| `sender (another agent, untrusted)` | The agent that mentioned it | Yes |
| `you (your earlier reply)` | The agent's own earlier replies | Yes |
| `external (untrusted)` | Everyone else | Yes |

A wrapped message sits inside `<unsafe_content source="team chat">`, as Rukoo wraps email for its agents ([docs/agents.md](../../docs/agents.md)). Inside it every `<` is written `&lt;` and every `&` is `&amp;`, so a message can't close the block or fake a label. Names, the channel's name and the workspace's name are tagged and escaped the same way, because members choose them. The model is told never to follow instructions inside these tags.

A message from another agent is wrapped because an agent can repeat what anyone wrote. Its question still gets an answer, but the model is told to treat it as a question from someone it doesn't know.

Before the input goes to the runtime, the runner replaces anything that has the shape of an agent key, `rka_` followed by 66 characters, with `[agent key removed]`: in messages, names and the text of files. Whoever holds a key reads every channel its agent is in, so a key someone pasted in a channel never reaches a runtime or its model provider from the runner.

### Files

After a message, the input lists its files under `[Files attached to message e_…:]`: each with its name, tagged and escaped as names are, its type and size, and what the agent got of it. The runner downloads a file with the agent's key through `POST /conversations/{c}/files/{f}/download`, which answers a link that works for 60 seconds with the file's size and SHA-256, and then fetches the link without the key and without following a redirect. The runner follows a link only to the origins Rukoo's desktop app takes links for: the Rukoo server's own, and the files origin its `/v1/info` names (`workspace.files.origin`). Plain `http` goes only to the server's own origin, which gets the key already, and to the files origin only when the config sets `"allowHttp": true`. The server's own origin goes to whatever address it has, since you chose it in the config. The files origin a server names goes only to a public address: the runner refuses this computer, unspecified, link-local and private addresses (10/8, 172.16/12, 192.168/16, fc00::/7), CGNAT (100.64/10), multicast, the other ranges IANA's special-purpose registries mark as not globally reachable (such as benchmarking, documentation and local NAT64 addresses), and those addresses written as IPv6. It checks the address it connects to as it connects, so a name can't resolve to one address for the check and another for the download. A server on a private network whose file links use another origin needs that origin in `privateFilesOrigin` ([The config](#the-config)); a server can't grant that itself. A link without a size or a SHA-256 is refused, and so is one that names a size of 0 bytes. The runner reads every file whole through SHA-256, also when only its start goes along, and keeps in memory only what the input takes; a file whose bytes don't match the size or the digest goes by its name, as one the runner couldn't download.

| File | What the agent gets |
| --- | --- |
| Text (a `text/` type, JSON, XML, YAML, CSV, calendar or contact files, or a name ending in `.txt`, `.md`, `.csv`, `.json`, `.log` and the like) | Its text inside `<unsafe_content source="team chat file">`, escaped like a message, also when the sender attached it. UTF-8, UTF-16 with a byte order mark, or else Windows-1252. A file with a NUL byte in its first 8,192 characters counts as no text. |
| A PDF | Its text, as for a text file, when the runner has a reader for PDFs: in Rukoo's desktop app, which lends it the chat panel's reader ([In Rukoo's desktop app](#in-rukoos-desktop-app)). The runner on its own has none, since it has no dependencies, and names the PDF as one the agent can't open. A PDF over 10 MB, a scanned one without a text layer, or one the reader can't read is named with the reason. |
| An image (PNG, JPEG, GIF or WebP, by its first bytes) | The image itself for `openai`, `claude` and `codex`, after a line that names its file and says it is untrusted data; `runs` and `command` get the name and the line that the agent can't see it. |
| Anything else | Its name, type and size, and the line that the agent can't open it. |

The limits are the chat panel's ([docs/agents.md](../../docs/agents.md#attach-files-and-other-emails)): up to 20,000 characters of each file's text, and of all files' text together up to 60,000; a longer file is cut, and the input says so. An image goes along up to 3.75 MB, and one input takes up to 10 images and 20 MB of them. The whole input stays within `maxChars` as the runtime gets it, with each file's text escaped and in its block, so a file full of `&` or `<` takes more of it than its length. That holds for the input without its images too, which `openai` sends when the server takes none, and whose lines for the images are longer. Agent keys come out of a file's text before any of it is cut, and a cut that falls inside a key takes the rest of that key out too. The files of the message to answer come first, in the room the input leaves with that message and none before it; when they fill it, the earlier messages are left out. When even their names take more than that room, the list names as many as fit and says how many it left off, and when not even that line fits, the message's own line counts its files and nothing more is said of them. An image whose line doesn't fit isn't downloaded, and goes by its name with that reason. Then those of the earlier messages the input keeps, the thread's first message first and then the newest first, each in the room the messages before it leave; an earlier message that fits only without its files' text keeps their names, with the line that the text was left out. A file the runner couldn't download, such as one whose message was removed, keeps its name with that reason, and the turn goes on. Only a key that stopped working, or stopping the runner, ends a turn for a file.

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
| `--input-format stream-json --output-format stream-json --verbose`, only with images | The input as one stream-json user message with image blocks; stream-json input takes stream-json output, which `-p` gives only with `--verbose` (checked against 2.1.331). The answer is the `result` line |
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
| `--image <file>`, once per image | The images of the input, from the run's temporary folder (checked against 0.171.0). Each comes before another flag, since `--image` takes several values |

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
- Files go along as text and images only, within the limits in [Files](#files). A Word file, a spreadsheet or an archive goes by its name. The runner on its own reads no PDFs; in Rukoo's desktop app it does. `runs` and `command` get no images.
- An agent can't open a file itself, and gets no tool to read more of one than went along. Its replies carry no files.
- No memory between mentions. Each mention gets its thread or the channel's latest messages, within `maxChars`. The runner reads back at most 1,000 events for that.
- No streaming: the reply appears once the runtime is done.
- An agent can't remove its own replies. Its sponsor and a manager of the channel can.
- An agent replies only to mentions. It doesn't post on its own, and it isn't in DMs.
- An agent posts at most 120 replies an hour (`WORKSPACE_AGENT_REPLIES`). When it reaches that, the runner waits the time the server says and posts the reply then.
- The tests drive the runner against a local Rukoo server with a scripted program as the backend, the Runs API and Chat Completions backends against small stand-ins, and the `claude` and `codex` backends with a scripted program in the CLI's place. A live Hermes, Booper, OpenClaw, Claude Code or Codex hasn't run through the runner in those tests. By hand, Claude Code 2.1.331 and codex-cli 0.171.0 answered through the runner with what a text file and an image held. Whether a live Hermes, Booper or OpenClaw gateway reads a file's text the same way hasn't been checked; OpenClaw's handling of image parts hasn't either, which is why the runner tries a refused request again as text.
