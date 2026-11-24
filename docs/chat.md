# Team chat

Team chat lets you talk with your colleagues in Rukoo, next to your mail and calendar. A team gets a **workspace** on the server of your Rukoo account. In it you talk in **channels**, which are named conversations for a topic or a project, and in **direct messages** with one person or a small group. Messages arrive live, on your computer and on your phone.

Open it with the Chat tab in the title bar, or with `Ctrl+4`. Chat shows only when the server of your [Rukoo account](account.md) has team chat turned on, as the server at rukoo.io has, signed in or not: Rukoo asks the server at start and then every hour. When that first ask fails, for example because the network isn't up yet, Rukoo asks again after 15 seconds, a minute and five minutes, and also when the window gets focus, the computer wakes, the network comes back or the setup page opens. On a server you or your team runs yourselves, its operator turns it on ([Running your own server](account.md#running-your-own-server)).

Team chat doesn't need a mail account. With only a Rukoo account, Rukoo opens in Chat; Mail, Calendar and Meet ask you to add a mail account first.

Agents can be in channels too, as accounts of their own that answer when someone mentions them ([Agents in channels](#agents-in-channels)).

**The host can read your messages.** Team chat isn't end-to-end encrypted, unlike the records your Rukoo account syncs. Whoever runs the server can read and change what is written in its workspaces, direct messages included. Rukoo says who hosts a workspace before you join, in the conversation header of every direct message and in Workspace settings. [What the host can read](#what-the-host-can-read) has the details.

## Getting started

Team chat needs a Rukoo account. On the first start, below the mail providers, **Team chat** offers **Join with an invitation link** and **Sign in or create an account**. Signed out, Chat offers the same next to **Create an account** and **Sign in**, which open Settings → Rukoo account.

With an invitation link, Rukoo first checks that the link is for its server, then asks you to create a Rukoo account or sign in to yours. After that Chat opens with the Join dialog for the link. Rukoo keeps the link until you joined, chose **Cancel**, or the server says it no longer works, at most seven days, so a restart in between brings the Join dialog back.

Then either:

- **Make a workspace.** Give it a name, for example your team or company, and the name others see for you. You become its owner, and it starts with one channel, `general`.
- **Join one with an invitation link.** Choose **Join with an invitation link**, paste the link and choose **Continue**. Rukoo shows who invited you, whether as a member or a guest, how many channels you'll be in and until when the link works. Enter your name and choose **Join**. Rukoo opens the workspace's first channel.

You can be in several workspaces. The tile at the top of the sidebar shows the one that's open; click it to switch, or to make or join another.

## Invitation links

Owners and admins invite people with **Invite people** in the workspace menu.

1. Choose **Member** or **Guest**. Members see every channel the workspace can see and can join them. Guests see only the channels you pick.
2. Pick the channels the person joins, from the ones you manage, up to 20. A guest needs at least one. A member also lands in the workspace's default channel, normally `general`. When you manage no channel, Guest offers **New channel** instead.
3. Choose how long the link works: 1, 3 or 7 days. One day is the default.
4. Choose **Make link**, then **Copy link**, and send it to the person yourself, for example by email. The line under the link repeats the role, the channels and the expiry. Rukoo shows the link only this once: closing the dialog before you copied it asks first, and the invitation stays open until it expires or you withdraw it.

A link looks like `https://your-server/join#w=…&i=…` and works once. The part after `#` stays in the browser, so the server never sees it in its logs. **Open invitations** in the same dialog, and in Workspace settings, lists the links that still work, and **Withdraw** stops one.

Rukoo for desktop and Android doesn't open these links itself yet, so a link opens in a browser. What it shows there depends on the server:

- Where the account server runs behind Rukoo's website (`website/`), as rukoo.io does, the website sends the link on to Chat in the browser at `/app/`. The person creates a Rukoo account or signs in there, and the Join dialog opens with the link filled in, without installing anything. [In a browser](account.md#in-a-browser) says what the browser keeps. The website does this only when the account server marks its invitation page with `X-Rukoo-Workspace-Invite`, so an account server deployed before that header keeps showing its own page.
- A server you run from `server/` alone, without the website in front of it, shows a page that explains what to do: install Rukoo, then paste the page's address into Chat's Join dialog.

**A colleague without a Rukoo account** can use the link to sign up, with **Join with an invitation link** on the first start or in Chat. On a server where new accounts need an invite code, an invitation link works as the code, also when pasted into the invite code field of Settings → Rukoo account. Each link makes one account. After the sign-up Chat opens the Join dialog with the link filled in, also after a restart. The server's operator can turn this off, and then only their own invite codes work.

Rukoo joins workspaces only on the server of your own Rukoo account. A link for another server gets "This invitation is for …" and nothing happens. rukoo.io used to be called rukoo-account.bvdm.ai, and both names reach the same server: a link made with either works on a Rukoo that uses the other, and new links use rukoo.io. Rukoo keeps that list of names itself, so another server can't claim rukoo.io's links by naming rukoo.io as its home.

After your first workspace, the bottom of Chat's sidebar names Rukoo's other apps once: Rukoo for Android and Rukoo Voice. Close it with ×; it doesn't come back.

## Channels

The sidebar lists the channels you're in, by name, and below them your direct messages.

- **Make a channel** with the plus next to Channels. Pick who can see it: **Everyone in** the workspace, so members can find it and join, or **Only people you add**, so everyone else can't see its name. You can't change that later. Guests can't make channels.
- **Browse channels** lists the channels you can join, with a search field. Opening one you're not in shows a bar with **Join**. Joining lets you read its earlier messages too.
- Each channel has **managers**. Whoever makes a channel manages it. Managers add people, make others manager, rename the channel, take people out and archive it. An owner or admin who can see a channel can archive it too. Only an owner or admin can add a guest.
- **Leave channel** is in the channel's More menu. A visible channel you can join again from Browse channels; a private one needs someone to add you again, and the agents you sponsor leave it with you. If you're its only manager and others are still in it, Rukoo asks you to pick a new manager first. The last person to leave archives the channel.
- **Archive channel** stops all posting. Its members can still read it until the workspace's retention removes it. You can't undo an archive.

Channel names are 1 to 80 characters on one line, shown as typed with `#` in front. Two visible channels can't share a name, ignoring upper and lower case.

## Direct messages

**New message** in the sidebar, or `Ctrl+N` in Chat, starts a conversation with 1 to 7 other people, so 8 at most with you. Pick them in the To field. If you already have an open conversation with exactly those people, the button says **Open conversation** and opens it. A new conversation opens at once for everyone in it, without a request to accept.

- Direct messages are for owners, admins and members. Guests can't start one or be added to one; they talk in channels.
- A conversation keeps its people. To talk with a different group, start a new one.
- **Close conversation** in the More menu closes it for everyone in it. They can still read it but nobody can post in it again. To stop notifications only, use **Mute**.
- A conversation also closes when someone in it leaves or is removed from the workspace, deletes their Rukoo account or becomes a guest. A closed conversation keeps its history, dimmed at the bottom of the list. Its bar offers **Start a new conversation** with the same people, and **Remove from list**, which takes it off your list; you can't read it after that.
- You can start 20 new conversations a day. Opening one you already have doesn't count.

## Messages, threads and mentions

Type in the box under the conversation and press `Enter` to send. `Shift+Enter` starts a new line. A message can be 16 KiB of text, a few thousand words, and mention 32 people at most.

- **Mentions.** Type `@` and pick a person from the list. They get a notification and the message is marked for them. Typing an `@name` by hand without picking doesn't notify anyone.
- **Threads.** Hover over a message and choose **Reply in thread**. The thread opens beside the conversation, or over it in a narrow window. Replies also show in the conversation itself, with a line saying who they answer; clicking that line opens the thread. A message with replies shows how many and when the last one came.
- **Removing.** You can remove your own messages, also in a closed conversation. A channel manager can remove anyone's message in that channel, and an agent's sponsor the agent's replies. Rukoo asks first. The message is replaced by "Message removed" for everyone, and its files, link previews and reactions go with it.
- **Offline.** Messages you send without a connection wait and go out once Rukoo reconnects. A message that can't be sent says why and offers to try again or discard it. Unsent text stays as a draft in each conversation, also after a restart.

### Message actions

Pointing at a message shows a small bar at its top right with **React**, **Reply in thread** and **More**. More holds **Copy text**, **Mark unread**, **Message** the author in a direct message, **Block** and **Remove message**, as far as they apply. A right click on the message, or `Shift+F10` on a selected one, opens the same menu. With the keyboard, move to a message with the arrow keys and press `Tab` to reach its bar, then its files, previews and reactions.

### Formatting

Messages understand a small set of Markdown, and show it formatted:

| Write | Shows as |
| --- | --- |
| `**bold**` or `__bold__` | **bold** |
| `_italic_` or `*italic*` | *italic* |
| `~~struck~~` | struck through |
| `` `code` `` | inline code |
| `[label](https://…)` | a link named label |
| Lines starting with `- `, `* ` or `+ ` | a bulleted list; indent two spaces to nest, up to three levels |
| Lines starting with `1. ` | a numbered list |
| Lines starting with `> ` | a quote |
| A line of three backticks before and after | a code block |
| `# `, `## ` or `### ` at the start of a line | a heading |

A backslash before a character shows it as typed, so `\*not italic\*` keeps its stars. Addresses in the text become links on their own. The message keeps the markers, so someone on an older Rukoo sees `**bold**` as written.

The **Aa** button under the text shows a formatting bar with the same styles. They also have shortcuts, the same as Slack's: `Ctrl+B` bold, `Ctrl+I` italic, `Ctrl+Shift+X` strikethrough, `Ctrl+E` code, `Ctrl+Shift+U` link, `Ctrl+Shift+8` bulleted list, `Ctrl+Shift+7` numbered list, `Ctrl+Shift+9` quote and `Ctrl+Alt+Shift+C` code block. With text selected they wrap it, or take the style off when it's there already; without a selection they put in the markers with the cursor between.

### Emoji and reactions

The smiley button under the text opens the emoji picker: search by name, pick from Recently used or a group, and choose a skin tone with the hand at the top. The arrow keys move through the emoji and `Enter` picks one. In the text, `:` and two letters of a name, such as `:thu`, open a list of matching emoji; typing a whole code such as `:tada:` turns it into the emoji. Recently used emoji and the skin tone are kept on this computer.

**React** on a message's bar puts an emoji under it. Each emoji shows once with how many people chose it, tinted when yours is among them; pointing at it names who reacted. Clicking it adds or takes back your reaction, and the smiley button after the reactions adds another. A message can hold 20 different emoji. Reactions never notify anyone and don't count as unread.

### Files and images

Attach files with the paperclip under the text, by dropping them on the conversation or the thread, or by pasting a copied file or screenshot. Each file uploads right away and shows above the text with its progress; a file that fails offers **Retry**, and the cross takes a file off. **Send** waits until every file has uploaded, and a message can be just files without text.

- A message holds up to 10 files of at most 25 MiB each, unless the server sets another limit.
- Images show in the message: one at its own shape, two to four in a grid, more with "+n" on the fourth. Clicking one opens it large, with **Open** and **Save**; the arrow keys step through the message's images and `Esc` closes it.
- Other files show as a card with their kind, name and size. Clicking the card opens the file in its app; the download button saves it where you choose. In the browser, **Open** shows an image in a new tab and downloads any other file, and saving is the browser's download ([In a browser](account.md#in-a-browser)).
- A draft keeps its uploaded files for an hour. A draft opened later than that says how many files you need to attach again.

Files need a server that stores them. Without that, the paperclip doesn't show and dropped or pasted files are left alone. The server at rukoo.io doesn't store files yet.

### Link previews

When a message holds a web address, the server fetches the page and adds a preview under the message: the site, the title, a short description and the page's image, for up to three addresses. Clicking the preview opens the page in your browser. The author can remove a preview with the cross on it, and so can an agent's sponsor on the agent's replies. That message gets none again. The server fetches the page, not your computer, so the site sees the server's address instead of yours. On a server that doesn't store files, such as rukoo.io for now, a preview comes without the image.

## Unread, notifications and mute

- A channel with unread messages shows bold with a count. A channel where someone mentioned you, and a direct message with unread messages, shows an accent badge with the count.
- The Chat tab in the title bar shows the number of mentions and unread direct messages in all your workspaces, or a dot when only channels have unread messages. The taskbar badge counts mail only.
- Rukoo marks messages read as you scroll past them while its window has focus. **Mark as read** in the More menu, or `Shift+Esc`, marks the whole conversation read. A read on your phone counts here too.
- **Mark unread** in a message's More menu makes that message and everything after it unread again: the New line moves there and the badge comes back, also on your other devices. The conversation then stops marking messages read until you open it again, so it stays unread while it's on screen.
- Rukoo notifies you of new direct messages and of mentions, unless the conversation is on screen. Clicking a notification opens the conversation at that message. When you read the messages here or on another device, the notification goes away. **Settings → General → Team chat notifications** turns these off.
- **Mute** in a conversation's More menu silences it on this device: no notifications, no badges, and its row is dimmed. Mute isn't synced to your other devices.
- The desktop app notifies only while it runs, also with its window closed to the tray. After a restart nothing notifies until Rukoo runs again, unless **Settings → General → Open when you sign in** is on: then the installed app starts hidden when you sign in to Windows or macOS. It's off by default.

## Blocking someone

In a direct message with one person, or from their menu in **Members**, choose **Block**. After a block:

- that person can't start direct messages with you, and every conversation that includes both of you, group ones too, closes for everyone in it;
- their mentions of you stop notifying you, and earlier ones no longer count as mentions;
- you still see each other's posts in shared channels, and their posts there still count as unread.

The person isn't told, but may notice that a conversation with you closed or that they can't start one. **Workspace settings → Blocked people** lists who you blocked, with **Unblock**. Unblocking doesn't reopen closed conversations; start a new one to talk again. Blocks belong to one workspace.

## Roles, leaving and deleting

A workspace has **owners**, **admins**, **members** and **guests**.

- Owners change anyone's role and remove anyone. Admins invite people, move people between member and guest, and remove members and guests.
- **Members** in the workspace menu lists everyone by role, with Message, Change role, Block and Remove where you may use them. Making someone an owner or a guest asks first. Admin and Member apply at once, with Undo, and so do Make manager and Make member in a channel.
- **Change your name** sets the name others see for you in this workspace.
- **Leave workspace** takes away your access to its channels and direct messages. What you wrote stays, with your name. If you're the only manager of channels other people are in, Rukoo lists them so you can hand each over first. The only owner makes someone else owner first. The agents you sponsor are removed when you leave.
- **Delete workspace** is for an owner who is its only member; agents don't count. It deletes every channel, message and agent at once and can't be undone. With other people still in it, remove them first.

When you're removed from a workspace or a conversation, Rukoo removes its messages from your computer at once and says so.

## Agents in channels

An **agent** is an account in the workspace that a program answers for, such as Clark or another AI assistant. You add it to channels and mention it like a person, and it answers in a thread under the message that mentioned it. A mention is the only thing that makes it post. An **Agent** tag marks it next to its messages, in the mention list and in a channel's Members. Its avatar is a rounded square, where a person's is a circle.

The program doesn't run in Rukoo or on the workspace's server. It runs where the agent's sponsor puts it, for example on the sponsor's own computer, and connects with the agent's key through the same routes the apps use. This repository has a reference runner for that ([The runner](#the-runner)).

### Making an agent

Owners, admins and members make agents with **Agents** in the workspace menu. Guests can't make agents or see the list. Whoever makes an agent is its **sponsor**.

1. Choose **Add an agent** and give it a name.
2. Choose **Who it answers**. A new agent starts on **Only me**.
   - **Everyone**: anyone who can post in the channel, guests included.
   - **Only me**: only you. This makes an agent of your own: others see it in the channel, but it doesn't answer them, also when they ask it through another agent.
   - **Chosen people**: you and the people you pick, up to 50. Until you pick someone, the form says "Pick at least one person." and its button stays off.
3. Turn on **Answers other agents** when a mention by another agent should reach it too ([Agents answering agents](#agents-answering-agents)). It's off unless you turn it on.
4. Choose **Add agent**. Rukoo then shows its key once, with **Copy key**, together with the server's address, the workspace's ID and a ready config for the runner, with **Copy config**.

On the computer, the key step also offers **Use one of my agents**: pick an agent from Settings → Agents (Hermes, OpenClaw, Claude Code, Codex or a custom agent), and the runner's config gets that agent's backend settings, such as its address and model. That agent's own secret, such as the Hermes API key, stays out of the config, which names an environment variable for it instead. The browser and the phone don't have this.

The Agents dialog lists every agent in the workspace with its sponsor, whom it answers, whether it answers other agents and when it was last active. Each agent's menu there, and in the workspace's **Members**, has **Edit agent** for its name and settings, **New key** and **Remove agent**. The sponsor, an owner or an admin can edit or remove an agent. Only its sponsor sees **New key**, because a key reads every channel the agent is in, and an owner or admin isn't in every private channel. A workspace can have 20 agents, unless its server sets another limit.

**The key is a secret like a password.** Whoever has it can read the agent's channels and post in them as the agent, from anywhere. The runner's config holds it, so keep both to yourself. When it may have leaked, its sponsor makes a new key: the old key stops working at once, and the runner needs the new one before it answers again. An owner or admin who suspects a leak removes the agent instead. The server keeps only a hash, so a key you lost can't be shown again, only replaced. A key works only on its own workspace's chat routes. It can't sign in to a Rukoo account, read the account's records or use a booking page.

### Adding an agent to a channel

**Add people** in a channel lists the agents that aren't in it yet under the heading **Agents**. A line under the heading says that agents pass what they read there on to the system that runs them. A channel's managers can add any agent. A sponsor can add their own agent to a channel open to everyone in the workspace, when they're in that channel themselves. For a sponsor who doesn't manage the channel, the menu item and the dialog say **Add agents**, and when all their agents are in already, "All your agents are in #channel already".

In a private channel only its managers add agents, and only agents whose sponsor is in the channel, because whoever holds an agent's key reads what the agent reads. The server refuses any other agent there. The channel shows "Olga added Clark", as it does for a person, and an agent that comes in can read the channel's earlier messages and files, as a person who joins can.

**Members** in a channel shows its agents with their tag, and under each who made it and whom it answers, such as "Made by Olga · Answers only Olga". A manager or the agent's sponsor takes one out with **Remove from #channel**. An agent can't be made manager. In the workspace's **Members**, agents have their own group with the same line under each, and a menu with **Edit agent**, **New key** for its sponsor and **Remove agent**, without Message, Block or a role to change. Agents never show in New message, under Message or Block in a message's menu, or among the people who can take over a channel when you leave it.

### Mentioning an agent

Type `@` and pick the agent from the list, as for a person. An `@name` typed by hand doesn't reach it. When the agent won't answer you, because it answers only its sponsor or chosen people, the list says so, such as "Answers only Olga", or "Answers only the person who made it" when Rukoo doesn't know its sponsor, as for a guest who shares no channel with them. You can still mention it, and the server makes sure it doesn't answer. Asking another agent to mention it doesn't help either, because whom an agent answers is about the person who started the chain ([Agents answering agents](#agents-answering-agents)).

The agent answers in the thread of the message that mentioned it, or starts a thread under it, and answers each mention once. A long answer can come as up to five messages. The server checks every reply before it posts it: the agent is in the channel, the message mentions it and came after the agent was added, its author is still in the channel, and so is the person who started the chain, who must be someone the agent answers. For a message a person wrote, that person is its author. A mention made before the agent came in gets no answer.

An agent's replies carry no files. A channel manager can remove an agent's reply like any other message, and so can the agent's sponsor, also after the agent was removed. The sponsor can take a link preview off a reply too. The agent itself can't remove its replies.

### Agents answering agents

An agent with **Answers other agents** on treats a mention by another agent like a mention by a person. To keep two agents from answering each other forever, every reply counts its distance from the person who started: a person's message is 0, an agent's answer to it 1, another agent's answer to that 2. The server refuses a reply past 3. So a person mentions agent A, A mentions agent B, B mentions A, and A's answer is the last. An operator can set another limit. Each agent also posts at most 120 replies an hour.

Whom an agent answers still applies when another agent mentions it. It counts for the person who started the chain, and every agent's reply carries who that is. So an agent on **Only me** answers another agent only in a chain its sponsor started, and one on **Chosen people** only in a chain that its sponsor or one of its chosen people started. Once that person has left the channel, no agent answers in their chain.

### The runner

[`integrations/agent-runner/`](../integrations/agent-runner/) holds the reference runner: a Node.js program, for Node 22 or newer and without dependencies, that connects one agent to one runtime. Save the config Rukoo showed as `agent.json`. It holds the agent's key in `key`, so keep the file as private as a password, readable only by you. Or take `key` out of it and put the key in the environment variable `RUKOO_AGENT_KEY` instead, or in another one that `keyEnv` names. When the backend needs a secret of its own, such as a Hermes API key, the config names its environment variable; set that first. Then start the runner:

```bash
node integrations/agent-runner/runner.js --config agent.json
```

The runner reads the agent's settings, follows the workspace's changes and its wake socket, and checks again at least once a minute. For each mention, it first checks what the server will check: the agent's settings, and that the author and the person who started the chain are still in the channel. A mention that fails gets no runtime call and no reply. For the others it gathers the thread, or the channel's latest messages for a mention outside a thread, hands them to the runtime and posts the answer. Either way it moves the agent's read position past the mention. The runtime is one of these:

| `backend.type` | What it runs |
| --- | --- |
| `runs` | The Runs API of Hermes Agent and of Booper's app channel, which Rukoo's chat panel uses for Clark |
| `openai` | An OpenAI-compatible Chat Completions endpoint, such as OpenClaw's gateway |
| `claude` | `claude -p`, without Rukoo's MCP server and without running commands |
| `codex` | `codex exec` in its read-only sandbox |
| `command` | Any command, with the prompt on stdin and the answer on stdout |

The runner gives the runtime no Rukoo tools, but a runtime keeps the tools and memory it has of its own. A Hermes agent such as Clark that reaches Rukoo through its bridge can still read your mail while it answers in a channel, and what it reads there can end up in its memory. Give a channel agent a runtime or profile of its own, without your personal tools.

Each mention starts a fresh session, and the runner sends it nothing from earlier mentions. Only a person who mentions the agent counts as trusted. A mention by another agent doesn't, because an agent can repeat what anyone wrote: the model answers its question but doesn't follow its instructions. That agent's messages, the agent's own earlier replies and everyone else's messages reach the model inside `<unsafe_content source="team chat">`, as email does in the chat panel ([Safety](agents.md#safety)), and the model hears that everyone in the channel reads its answer. When the runtime fails, the runner posts nothing and goes on with the next mention; it doesn't try a turn again. Restarting the runner, also without its state file, picks up from the agent's read position on the server, and the server takes one answer per mention, so nothing is posted twice. [`integrations/agent-runner/README.md`](../integrations/agent-runner/README.md) has the config and every option.

Any other program can answer for an agent too, through the routes in [`server/WORKSPACES.md`](../server/WORKSPACES.md#agents-in-channels).

### When an agent goes

Removing an agent stops its key and takes it out of every channel at once. What it wrote stays, like a former member's. When its sponsor leaves the workspace, is removed, becomes a guest or deletes their Rukoo account, their agents are removed too. In a private channel an agent also leaves with its sponsor: when the sponsor leaves the channel or a manager takes them out, their agents there leave at the same moment. A channel open to everyone in the workspace keeps the agent, since its sponsor could join again by themselves. Agents don't count toward the workspace's member limit or as people in a channel: when the last person leaves a channel, it's archived even with agents in it, and an owner alone with agents can delete the workspace.

### What an agent reads

An agent in a channel can read everything posted there, earlier messages and files included, and who is in it, not only the messages that mention it. Whoever holds its key reads the same. That's why only its sponsor can make a new key, and why an agent is in a private channel only while its sponsor is. It passes what it reads to the runtime its sponsor chose, which may send it on to a model provider. The host can't see or control that runtime, and what happens there is up to the sponsor and whoever runs it. Rukoo's note about the host says this too. Check a channel's Members to see which agents are in it.

## What the host can read

The workspace lives on one server, the host: the server of the Rukoo account of whoever made it. The host's operator can read and change every message in it, in channels and direct messages, including its files and link previews, and sees who is in which conversation. That's different from your personal Rukoo account, which encrypts its records on your device ([What's stored and shared](account.md#whats-stored-and-shared)).

Before you make or join a workspace, the dialog names the host. **Workspace settings** shows the host, who runs it, where it stores data, how long it keeps messages and how many members a workspace can have. Every direct message names the host in its header and at its start.

An agent in a channel is a reader outside the host: it passes what it reads to a runtime the host doesn't run ([What an agent reads](#what-an-agent-reads)). The host keeps the agent's name, sponsor and settings, when it was last active and a hash of its key, never the key itself.

The server in this repository runs on Cloudflare, where its operator can restore a workspace's database to any point in the past 30 days. Such a copy holds messages that were removed since.

## Retention and limits

These are the defaults of the server in this repository. An operator can set other values; Workspace settings shows how long yours keeps messages and how many members it takes.

| What | Default |
| --- | --- |
| Messages are kept | 90 days, then removed for everyone |
| Workspaces an account can make | 3 |
| Workspaces an account can be in | 50 |
| Members per workspace | 100 |
| Channels and conversations per workspace, closed ones included | 8,192 |
| Message text stored per workspace | 1 GiB |
| People in a direct message | 2 to 8 |
| New direct messages | 20 per person per day |
| One message | 16 KiB of text, 32 mentions, 10 files |
| One file | 25 MiB |
| Files stored per workspace | 5 GiB |
| Reactions on one message | 20 different emoji |
| Link previews on one message | 3 |
| An invitation link | 1, 3 or 7 days, used once |
| Agents per workspace | 20, not counted as members |
| Agents answering agents | 3 replies deep |
| Replies by one agent | 120 an hour |

A conversation whose history aged out says so at its start. Rukoo keeps up to 2,000 messages per conversation on your computer and loads older ones from the server as you scroll up.

## On your computer

Rukoo keeps a copy of your workspaces on your computer, in `data/chat.db` in your Rukoo profile, so Chat opens at once and works offline. That copy belongs to one sign-in: signing out, deleting your Rukoo account, switching servers or a session ending on the server deletes it, including messages that weren't sent yet. The sign-out dialog says how many those are.

Files you open, save or look at are downloaded into `data/chat-files/`, up to 1 GiB in all; the ones used longest ago go first when it's full. They're deleted with the rest of the copy, and when their message is removed.

When you delete your Rukoo account, what you wrote in team chat stays in each workspace under "Deleted member" until that workspace's retention removes it. Your direct messages close. A workspace where you're the only member stays on the server until retention empties it, so delete it first if you want it gone at once.

The agents in your chat panel don't see team chat. In Chat mode the panel says so, and Rukoo's tools give agents no access to workspaces. To have one of them answer in a channel, make an agent for it in the workspace and run it with the runner ([Agents in channels](#agents-in-channels)).

## On your phone

[Rukoo for Android](android.md) has Chat too, with the same workspaces, channels, direct messages, threads, mentions, mute and blocks. A read on one device counts on the other. Mute and drafts stay on the device where you set them. The phone doesn't show reactions, files, link previews or formatting yet: it shows a message's text with its Markdown markers. It shows agents with their tag and makes and manages them in its Agents sheet, without **Use one of my agents**.

## Not in this version

- Editing and forwarding messages, links to a message, typing indicators and who's online.
- Voice messages, and playing video or audio inside a message. Such files show as cards that open in their app.
- Searching messages, and a quick switcher for conversations.
- Direct messages with guests.
- Workspaces on another Rukoo server than your account's.
- Opening invitation links straight into Rukoo.
- Notifications for replies in a thread you follow.
- Renaming a workspace, and deleting one that still has other members.
- Agents in direct messages, agents posting without a mention, and files in an agent's reply.
- Starting an agent's runner from Rukoo itself.

## How it works

The server side is described in [`server/WORKSPACES.md`](../server/WORKSPACES.md#gate-1-routes), and the plan behind it in [Rukoo workspaces](workspace-architecture.md). On desktop the main process keeps the cache and the connection in `src/main/workspaces/`, with files in `files.js`, and the view is `src/renderer/chat.js` with `chat-view.js`, `chat-input.js` and `chat-dialogs.js`. Rich messages are drawn by `chat-rich.js` (reactions, files, link previews, the image viewer, the emoji picker, the formatting bar and the file tray) from `chat-markdown.js`'s parse of the text; `chat-format.js` holds the formatting commands and `emoji/` the emoji data from [emojibase](https://emojibase.dev) (MIT). Tests run against the real server through `test/fixtures/real-server.js`; `test/e2e/chat*.spec.js` drive the app, `chat-rich.spec.js` the rich messages and `chat-agents.spec.js` the Agents dialog and an agent's reply. Agents use the routes in [Agents in channels](../server/WORKSPACES.md#agents-in-channels); the runner is `integrations/agent-runner/runner.js`, tested by `test/agent-runner.test.js` against the same real server.
