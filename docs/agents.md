# Agents in Rukoo Mail

Rukoo Mail has a chat panel next to the reading pane. In it you hand an email to an agent: a Hermes Agent such as Clark, Claude Code or Codex. The agent keeps its own tools, memory and integrations. Rukoo adds the chat and a small set of tools the agent uses to read your mail and change what is on your screen. It writes the reply draft, shows a plan or its sources, and asks you before anything happens.

Open the panel with the sparkle button in the title bar or with `Ctrl+J`. While it is open the folders shrink to a rail, so you see the list, the email and the chat. The rail button brings the folders back, and the reading pane's expand button hides the list too, leaving the email and the chat.

![The chat panel next to a reply that Clark drafted](screenshots/dark/11-agent-reply.png)

## What you can ask

The panel offers quick actions for the open email. The same actions work as slash commands in the chat input, such as `/reply`. You can also type anything else.

A new chat is about the open email. The email shows as a chip above the input and goes to the agent with your first message. To ask something without it, click the × on the chip. An "Add this email" chip takes its place; click it to put the email back. Once a chat has started it keeps its email, so the chip has no ×. Start a new chat to leave the email out.

### Hand it off

- **Draft a reply** (`/reply`). The agent looks up earlier mail with the sender, its memory and your notes, then writes the reply into the composer in your voice and in the language of the email. You read it and press Send. Rukoo has no tool that sends mail, so an agent can't send one.
- **Unsubscribe** (`/unsubscribe`). Shown for newsletters with a List-Unsubscribe header. The agent unsubscribes you and offers to archive the sender's other mail. Rukoo asks you before either happens.
- **Summarize** (`/summary`). Three bullets, and whether the email needs a reply from you and by when.

### Plan the follow-up

- **Plan follow-ups** (`/tasks`). The agent pulls out the actions, with an owner and a due date where it can tell, and shows them as a list in the chat. It proposes adding them to your task system and waits for your approval.
- **Tell the team** (`/team`). Instead of forwarding the email, the agent writes a short message for the right channel, such as Slack, Mattermost or WhatsApp. The message includes the email's Message-ID so people can find it. You approve the message before it goes out.

### Find out more before you reply

- **Brief me** (`/brief`). Who is this, what is your history with them, and what do you need to decide? The agent searches your other mail, its memory, your notes and any other system it can reach, and shows the sources as cards.
- **What needs me today?** (`/triage`). Shown when no email is open. The agent goes through your inboxes in every account and lists what needs you, most urgent first.

### Update other systems

- **Update systems** (`/update`). The agent records the email where it belongs: a CRM contact or deal, your notes, a Linear issue, a Todoist task. It shows the planned updates, proposes each one, and after you approve it does them and adds links to the plan.

Everything the agent creates elsewhere links back to the email by its Message-ID header. That works in any mail client and doesn't depend on Gmail labels or other provider features. Rukoo keeps the chats themselves on your computer, per email.

## How each agent connects

| Agent | Connection | Needs |
|---|---|---|
| Hermes Agent (Clark) | Rukoo talks to the Hermes API server over HTTP. Each Rukoo chat is a Hermes session; a turn is a run on Hermes' Runs API. | The API server's address and key. For Rukoo's tools: the bridge in `integrations/hermes` |
| Claude Code | Rukoo starts `claude.exe` per chat (stream-json) with your own settings, MCP servers, skills and hooks, plus Rukoo's MCP server. | Claude Code installed and signed in |
| Codex | Rukoo starts one `codex app-server` with your own config and adds Rukoo's MCP server to each thread. | Codex CLI installed and signed in |

Set them up in Settings → Agents. Each card shows the agent's status and has a test button.

Claude Code and Codex call Rukoo's MCP server on `127.0.0.1`. A Hermes agent usually runs on another machine, so it reaches Rukoo over Tailscale through a small stdio bridge. Turn on "Let Clark use Rukoo" in the Hermes card, then follow [integrations/hermes/README.md](../integrations/hermes/README.md). "Copy Hermes setup" puts the `config.yaml` block on the clipboard. The block holds no secret and is the same on every device: the bridge finds Rukoo on whichever of your devices has it open.

## Chats after a restart

Rukoo keeps your chats in `conversations.json`, so they survive a restart of Rukoo or the PC. Your next message continues the agent's own session: Claude Code with `--resume`, Codex with `thread/resume`, and Hermes with the same session id. A turn that was running when Rukoo quit is stopped and not resumed.

Sometimes the agent no longer has the session. By default, Claude Code deletes transcripts that have not been used for 30 days. The agent then starts a new session, and the chat says so, as in "Claude started a new session". Rukoo sends that session the email again, as with your first message, followed by a recap of the chat. The recap holds the last 20 entries, up to 8,000 characters: your messages, the agent's answers, its proposals and mail actions with what you decided, what those mail actions did, and the drafts it wrote. Tool calls, thinking and permission requests stay out. Earlier answers can quote email, so the recap sits inside `<unsafe_content>`. If Rukoo no longer has the email, it tells the agent so.

## Rukoo's tools

| Tool | What it does |
|---|---|
| `get_context` | What you see: the open email, related mail in the same thread, selected emails, the draft in the composer, your accounts and folders |
| `search_mail` | Searches the mail Rukoo has downloaded, in every account and folder |
| `read_message` | One email in full, as text, with its Message-ID and attachments |
| `read_attachment` | An attachment: text, an image, or the file itself. Claude Code and Codex also get a local copy to open |
| `write_draft` | Writes a reply, reply-all, forward or new email into the composer. You send it |
| `get_draft` | Reads the composer, including your own edits |
| `show_plan` | A list of steps or tasks in the chat, updated as the agent works |
| `show_sources` | Cards for the sources the agent used. Email sources open the email |
| `propose_action` | An approval card for something other people will see or that changes another system |
| `mail_action` | Archive, delete, move, mark read or unread, star, or unsubscribe. Rukoo asks you first |

The MCP server is stateless. Each request carries a bearer token, and Rukoo knows from the token which agent and chat it belongs to.

## Approvals

There are three kinds:

- **Proposals.** When an agent calls `propose_action`, Rukoo shows a card and the agent stops. If you approve, Rukoo sends the agent a new message saying so, and the agent carries it out. If you decline, the agent hears it next time you write.
- **Mail actions.** Rukoo runs these itself after you approve, and you can undo a move from the notice that follows. In Settings → Agents you can let agents archive, move and mark mail without asking. Deleting and unsubscribing always ask.
- **The agent's own permissions.** Claude Code and Codex ask before running commands or changing files when their access is set to "Ask before actions", the default. Their questions show up as cards in the chat. With "Full access" they don't ask. Hermes follows its own approval settings.

## Safety

- Email is written by other people. Everything Rukoo passes on from email sits inside `<unsafe_content>` tags: the email in the chat, subjects and sender names on Rukoo's own lines, and in tool results each body and attachment and every value taken from an email. That covers subjects, names, addresses, previews, attachment names and types, In-Reply-To and References headers, and the recipients and subject a reply copies from the email it answers. Text inside an email can't close or fake that tag. Rukoo tells the agent never to follow instructions inside it. Still, a model can be fooled. That is the reason for approvals, and the reason Rukoo can't send mail.
- Rukoo's own ids, accounts, folders and dates stay plain so the agent can use them. So does a Message-ID in the usual `<id@domain>` form, so the agent can link back to the email; any other Message-ID is tagged. When the agent passes a tagged value back, such as an address for a draft, Rukoo drops the tags. In the agent's own text, such as a proposal, Rukoo keeps them, and it asks the agent to keep them on email it quotes there. The quote is then still marked when Rukoo repeats the approved proposal to the agent. The chat panel shows that text without tags.
- Agent-written drafts are sanitized before they reach the composer. Links stay; images, form controls, styles and scripts go.
- Local agents get a token per chat or per process. Hermes signs in with a token made from its API server key, so every device with that key accepts it. Rukoo accepts that token only on the Tailscale address, and the local tokens only on `127.0.0.1`. A new API key replaces it. Before the bridge sends the token to a device, Rukoo there has to prove it has the same key.
- The Hermes API key is encrypted with Windows DPAPI in `%APPDATA%\Rukoo Mail\data\agents.json`. Chats are in `conversations.json` in the same folder. They hold what you and the agent wrote, not the emails Rukoo sent along.

## Limits

- Search covers what Rukoo has downloaded: the newest 300 messages of each inbox and 100 of other folders. Older mail stays on the server.
- PDFs reach the agent as files. Whether it can read them depends on the agent.
- `Ctrl+J` doesn't work while the focus is inside an email's frame. Click outside the email first.

The chat panel's components are ported from [Beautiful UI](https://www.beautifului.dev) by Shane Levine, under the MIT license.
