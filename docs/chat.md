# Team chat

Team chat lets you talk with your colleagues in Rukoo, next to your mail and calendar. A team gets a **workspace** on the server of your Rukoo account. In it you talk in **channels**, which are named conversations for a topic or a project, and in **direct messages** with one person or a small group. Messages arrive live, on your computer and on your phone.

Open it with the Chat tab in the title bar, or with `Ctrl+4`. Chat shows only when the server of your [Rukoo account](account.md) has team chat turned on, as the server at rukoo.io has, signed in or not: Rukoo asks the server at start and then every hour. When that first ask fails, for example because the network isn't up yet, Rukoo asks again after 15 seconds, a minute and five minutes, and also when the window gets focus, the computer wakes, the network comes back or the setup page opens. On a server you or your team runs yourselves, its operator turns it on ([Running your own server](account.md#running-your-own-server)).

Team chat doesn't need a mail account. With only a Rukoo account, Rukoo opens in Chat; Mail, Calendar and Meet ask you to add a mail account first.

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
- **Leave channel** is in the channel's More menu. A visible channel you can join again from Browse channels; a private one needs someone to add you again. If you're its only manager and others are still in it, Rukoo asks you to pick a new manager first. The last person to leave archives the channel.
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
- **Removing.** You can remove your own messages, also in a closed conversation. A channel manager can remove anyone's message in that channel. Rukoo asks first. The message is replaced by "Message removed" for everyone, and its files, link previews and reactions go with it.
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

When a message holds a web address, the server fetches the page and adds a preview under the message: the site, the title, a short description and the page's image, for up to three addresses. Clicking the preview opens the page in your browser. The author can remove a preview with the cross on it, and that message gets none again. The server fetches the page, not your computer, so the site sees the server's address instead of yours. On a server that doesn't store files, such as rukoo.io for now, a preview comes without the image.

## Unread, notifications and mute

- A channel with unread messages shows bold with a count. A channel where someone mentioned you, and a direct message with unread messages, shows an accent badge with the count.
- The Chat tab in the title bar shows the number of mentions and unread direct messages in all your workspaces, or a dot when only channels have unread messages. The taskbar badge counts mail only.
- Rukoo marks messages read as you scroll past them while its window has focus. **Mark as read** in the More menu, or `Shift+Esc`, marks the whole conversation read. A read on your phone counts here too.
- **Mark unread** in a message's More menu makes that message and everything after it unread again: the New line moves there and the badge comes back, also on your other devices. The conversation then stops marking messages read until you open it again, so it stays unread while it's on screen.
- Rukoo notifies you of new direct messages and of mentions, unless the conversation is on screen. Clicking a notification opens the conversation at that message. When you read the messages here or on another device, the notification goes away. **Settings → General → Team chat notifications** turns these off.
- **Mute** in a conversation's More menu silences it on this device: no notifications, no badges, and its row is dimmed. Mute isn't synced to your other devices.

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
- **Leave workspace** takes away your access to its channels and direct messages. What you wrote stays, with your name. If you're the only manager of channels other people are in, Rukoo lists them so you can hand each over first. The only owner makes someone else owner first.
- **Delete workspace** is for an owner who is its only member. It deletes every channel and message at once and can't be undone. With other people still in it, remove them first.

When you're removed from a workspace or a conversation, Rukoo removes its messages from your computer at once and says so.

## What the host can read

The workspace lives on one server, the host: the server of the Rukoo account of whoever made it. The host's operator can read and change every message in it, in channels and direct messages, including its files and link previews, and sees who is in which conversation. That's different from your personal Rukoo account, which encrypts its records on your device ([What's stored and shared](account.md#whats-stored-and-shared)).

Before you make or join a workspace, the dialog names the host. **Workspace settings** shows the host, who runs it, where it stores data, how long it keeps messages and how many members a workspace can have. Every direct message names the host in its header and at its start.

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

A conversation whose history aged out says so at its start. Rukoo keeps up to 2,000 messages per conversation on your computer and loads older ones from the server as you scroll up.

## On your computer

Rukoo keeps a copy of your workspaces on your computer, in `data/chat.db` in your Rukoo profile, so Chat opens at once and works offline. That copy belongs to one sign-in: signing out, deleting your Rukoo account, switching servers or a session ending on the server deletes it, including messages that weren't sent yet. The sign-out dialog says how many those are.

Files you open, save or look at are downloaded into `data/chat-files/`, up to 1 GiB in all; the ones used longest ago go first when it's full. They're deleted with the rest of the copy, and when their message is removed.

When you delete your Rukoo account, what you wrote in team chat stays in each workspace under "Deleted member" until that workspace's retention removes it. Your direct messages close. A workspace where you're the only member stays on the server until retention empties it, so delete it first if you want it gone at once.

Your personal agents in the chat panel don't see team chat. In Chat mode the panel says so, and Rukoo's tools give agents no access to workspaces.

## On your phone

[Rukoo for Android](android.md) has Chat too, with the same workspaces, channels, direct messages, threads, mentions, mute and blocks. A read on one device counts on the other. Mute and drafts stay on the device where you set them. The phone doesn't show reactions, files, link previews or formatting yet: it shows a message's text with its Markdown markers.

## Not in this version

- Editing and forwarding messages, links to a message, typing indicators and who's online.
- Voice messages, and playing video or audio inside a message. Such files show as cards that open in their app.
- Searching messages, and a quick switcher for conversations.
- Direct messages with guests.
- Workspaces on another Rukoo server than your account's.
- Opening invitation links straight into Rukoo.
- Notifications for replies in a thread you follow.
- Renaming a workspace, and deleting one that still has other members.
- Agents in channels.

## How it works

The server side is described in [`server/WORKSPACES.md`](../server/WORKSPACES.md#gate-1-routes), and the plan behind it in [Rukoo workspaces](workspace-architecture.md). On desktop the main process keeps the cache and the connection in `src/main/workspaces/`, with files in `files.js`, and the view is `src/renderer/chat.js` with `chat-view.js`, `chat-input.js` and `chat-dialogs.js`. Rich messages are drawn by `chat-rich.js` (reactions, files, link previews, the image viewer, the emoji picker, the formatting bar and the file tray) from `chat-markdown.js`'s parse of the text; `chat-format.js` holds the formatting commands and `emoji/` the emoji data from [emojibase](https://emojibase.dev) (MIT). Tests run against the real server through `test/fixtures/real-server.js`; `test/e2e/chat*.spec.js` drive the app, `chat-rich.spec.js` the rich messages.
