# Rukoo for Android

Rukoo for Android is Rukoo Mail on a phone, built for a foldable first: on a Galaxy Z Fold7 the cover screen shows one thing at a time, and the inner screen shows two columns side by side. The phone does the mail itself, over IMAP and SMTP. The agents are the same ones you use on the computer: Clark (Hermes Agent) and OpenClaw answer the phone directly over Tailscale, and Claude Code and Codex run on your computer while you chat from the phone.

The app's code is in [`android/`](../android). It is a native Kotlin and Jetpack Compose app, separate from the Electron app, that follows the desktop's behavior: the same quick actions, skills, approvals, `<unsafe_content>` rules and MCP tools.

## What it does

- Mail accounts on the phone: Gmail with Google sign-in, other providers with an app password or password, and the demo account. Inbox, folders, unified views, search, swipe actions you choose in Settings > Appearance (read or unread, archive, delete, star, move to a folder or a category), selection actions with Undo, a reader for HTML mail, a composer with formatting for replies, forwards and new mail, drafts saved to the account's Drafts folder, and new-mail notifications.
- The agent chat next to the email, with every desktop quick action and your own shortcuts, `/` skills, `$` agent skills, model and effort menus, files, photos and emails attached to a message, plans, sources, drafts written into the composer, and approval cards for anything other people will see.
- Rukoo's twenty-three MCP tools served by the phone, so an agent can read the phone's mail, write into its composer and ask for approval on its screen. The phone has no calendar yet, so `list_events`, `find_free_time` and `create_event` answer just that, and tell the agent to ask you to use Rukoo on your computer. `get_booking_link` gives the link to your [booking page](booking.md): it reads the page's settings from your Rukoo account when the phone is signed in to it. The phone has no meetings: Rukoo Voice records them on a computer, so the six meeting tools check their arguments and then say so.
- Pairing with Rukoo on your computer, which brings over your accounts and agent settings once and lets the phone use the computer's Claude Code and Codex.
- A [Rukoo account](account.md), end-to-end encrypted, which keeps Rukoo's own data the same on the phone and your computers, and [inbox categories](categories.md): under Inbox in the folder drawer, sorted on the phone.
- [Team chat](#team-chat) with your colleagues: the same workspaces, channels, direct messages and agents as Rukoo on your computer.
- English and Dutch, light and dark.

## Install

You need Android 12 or newer. Install the APK you got from the Rukoo releases page or from a build on your computer (see [Build and develop](#build-and-develop)); Android asks once to allow installs from that source.

Rukoo for Android and the desktop app have separate profiles. The phone keeps its accounts, chats and settings in its own app storage.

## First run

The first screen offers three ways in.

- **Connect to Rukoo on your computer** (recommended). On the computer, open Settings > Agents > Phone, turn on "Let my phone use this computer" and choose "Pair a phone". Enter the address and the 8-character code it shows on the phone. The address is the computer's Tailscale IP or its name in your tailnet. After pairing, the phone offers to bring over your accounts and agent settings: IMAP passwords, Google sign-ins with the Google OAuth client, the Hermes API key and the OpenClaw gateway token. The computer sends them once, within ten minutes of pairing, and only when you chose "Pair and send" there.
- **Add account.** Pick a provider. Google needs the Google OAuth client from the computer or Google's client JSON file; the sign-in opens in the browser and returns to Rukoo. Other providers take your email address and a password or app password, with the servers filled in from the same presets as the desktop.
- **Try the demo account.** The desktop's demo mailbox, without a network.

## Agents on the phone

Settings > Agents has a card per agent with its status and a "Test connection" button.

| Agent | How the phone talks to it | How it uses Rukoo's tools on the phone |
|---|---|---|
| Clark (Hermes Agent) | The Hermes API server over Tailscale, as on desktop: a Rukoo chat is a Hermes session, a turn is a run | Clark's `rukoo_bridge.py` finds the phone on Tailscale, port 47800, and sends the calls of phone chats there |
| OpenClaw | The gateway's OpenAI-compatible endpoint over Tailscale | The two steps from Settings > Phone tools > "Copy OpenClaw setup", [as on the desktop](agents.md#openclaw): a `RUKOO_MCP_TOKEN` line for the gateway's `.env` file and the `openclaw mcp set` command. It replaces the computer's entry, because OpenClaw names one Rukoo. With the same gateway token, the phone's token is the one the computer copies for a gateway on another computer, so switching between those two needs only the command again |
| Claude Code, Codex | Rukoo on your computer runs them, over the computer's Tailscale address | The computer forwards their Rukoo tool calls to the phone |

For Claude Code and Codex, the computer must be on, with Rukoo open (the tray is enough), Tailscale on, and "Let my phone use this computer" on. Their own permission requests ("Claude Code wants to read a file") show as approval cards on the phone. Phone chats always run with "Ask before actions" on the computer. [Rukoo on your phone](agents.md#rukoo-on-your-phone) describes the computer's side.

## Attach files to a chat

The + at the start of the chat input opens a sheet with three choices: Files (the system file picker, any type), Photos (Android's photo picker), and "Add this email" when the email on screen isn't in the chat yet. Rukoo copies a picked file into its own storage right away, so the chat doesn't depend on the other app's permission lasting. Each file shows as a chip above the input, an image with a small picture of itself, and its × takes it off before you send.

Your next message takes the files along, also a quick action or a skill, and a message can be files alone. It takes up to 10 files of up to 10 MB each. Programs, scripts and installers, such as `.exe`, `.js` or `.apk`, stay out. The files show on your message in the chat; tap one to open it in another app. The chat keeps them until you delete it.

Agents get the files as on the desktop. The message lists each file with its `file_id` and its name inside `<unsafe_content>`, with the start of a text file's text, and `read_chat_file` returns the whole file. Clark and OpenClaw read the files from the phone through Rukoo's tools. Claude Code and Codex on your computer get images along with the message; other files they read with `read_chat_file`, which the computer passes on to the phone. The phone has no PDF reader, so a PDF reaches the agent as a file without its text.

## Shortcuts

Settings > Agents > Shortcuts, or the round button after the shortcuts in a new chat, works as on desktop (see [What you can ask](agents.md#what-you-can-ask)). The arrows move a shortcut up or down, and the switch takes it out of new chats while its `/` command keeps working. Tap one of Rukoo's to rename it or rewrite its instructions; "Restore default" undoes that. "Add a shortcut" makes your own, with a name, a command, an icon, the instructions, and whether it shows only with an open email or always.

The phone keeps its own list. An import from your computer replaces it with the computer's, when you changed the list there.

## Let agents use Rukoo on this phone

Settings > Phone tools turns the phone's MCP server on. The phone then listens on its Tailscale address, port 47800, and Android shows a silent notification while it runs. Who can connect follows your settings: Clark while its API key is set, OpenClaw while "Let OpenClaw use Rukoo on this phone" is on, and each paired computer with a token of its own. The tools are the desktop's, with the same names and inputs, so Clark's bridge keeps one tool list for every device.

Clark's bridge needs version `bridge-4` or newer to look for Android devices. Copy `integrations/hermes/rukoo_bridge.py` to the Hermes machine again (see [the bridge's README](../integrations/hermes/README.md)) and send `/reload-mcp` to Clark (or run `hermes gateway restart`); Hermes keeps running the old bridge until then. An older bridge reaches the phone only with `RUKOO_URL=http://<phone's Tailscale IP>:47800/mcp` in its environment. Settings > Phone tools shows when the bridge last reached the phone. If a chat on the phone used Rukoo's tools and that line still says the bridge hasn't reached it, the bridge is out of date: Clark then answers that Rukoo isn't open on any device and lists only computers under "Checked".

Samsung phones stop apps in the background to save battery, and then agents can't reach the phone. Settings > Phone tools > Battery opens the page where you choose Unrestricted. The same row is under Settings > Notifications, below Team chat notifications.

While Phone tools runs, team chat also tries to stay connected in the background, so a direct message or a mention can notify sooner than the next 15-minute check. Android can still hold it back while the phone dozes. See [Team chat in the background](#team-chat-in-the-background).

## On the Galaxy Fold

- Cover screen: the list, the email, the chat and the composer each fill the screen. The chat is a full-screen page with the email as a chip above the input. The folders open from the button in the list's bottom-left corner, across from New message, as a sheet that comes up halfway with the accounts and the inbox views first; drag it up for the rest.
- Inner screen: the same button opens the folders as a drawer from the left.
- In an email, Previous and Next sit in the bottom bar's right corner, next to the agent button. When the bar is short of room (the cover screen in Dutch, a large font), Reply shows only its icon.
- Inner screen: the list next to the email. With the chat open, the email moves left and the chat sits to its right, so you watch an agent write into the composer. Two columns start at 600dp wide, which covers the inner screen in both orientations; a phone in split screen gets them too when it is wide enough.
- Folding and unfolding keeps the open email, chat and draft. The pane you touched last is the one you see after folding.

## Formatting in the composer

The composer writes bold, italic, underline, strikethrough, links, bulleted and numbered lists and one heading level. There are three ways in:

- Select text: the text menu that pops up has B, I and U next to Cut, Copy and Paste, and Link (in its overflow when the screen is narrow).
- While you type in the message, a format row sits above the keyboard: bold, italic, underline, strikethrough, heading, bullets, numbers, link and clear formatting. Its buttons light up for what the cursor is in. With nothing selected, a button applies to what you type next.
- Markdown while you type: `- ` or `* ` at the start of a line starts a bulleted list, `1. ` a numbered one and `# ` a heading; `**bold**`, `*italic*`, `_italic_` and `~~struck~~` format when you type the closing characters.

In a list, Enter starts the next item and Enter on an empty item ends the list. Backspace at the start of an item or heading takes the bullet, number or heading off first. Clear formatting removes bold, italic, underline and strikethrough, as on desktop; links, lists and headings stay. Pasted text arrives without the other app's formatting.

The mail goes out as HTML in the same structure desktop's composer writes (a `<div>` per line, `<ul>`/`<ol>`, `<h2>`, `<b>`, `<i>`, `<u>`, `<s>`, `<a>`), with a plain-text part that writes lists as ` * item` and `1. item` and a link's address in brackets after its text. Drafts keep their formatting on this phone and in the account's Drafts folder, and desktop opens them formatted. A draft written elsewhere opens with what fits this set; other markup, such as colors, font sizes, quotes and images, comes in as plain text. An agent's draft in Markdown or HTML arrives formatted too. Agents still read the text through `get_draft`, as on desktop.

## Sync and notifications

Mail syncs when the app opens, every few minutes while it is open (Settings > Accounts, five minutes by default), and every 15 minutes in the background, which is the shortest interval Android allows. New mail gives one notification per account. A category whose notifications are off on this phone sends none, and while one is off, an email Jev is about to sort waits for its category, at most 20 seconds, as on the computer ([Notifications](categories.md#notifications)). An agent's reply, a waiting approval and a draft an agent wrote while you were elsewhere give a notification that opens the chat.

## Rukoo account

Settings > Rukoo account is the desktop's page on the phone, described in [Rukoo account](account.md): the server with who runs it and where it keeps data, Create an account, Sign in and Forgot your password?, and once signed in Sync now, the devices (choose one to sign it out), Change password, New recovery key, What's stored and shared, Export my data, Sign out and Delete account. The recovery key shows once, in a dialog with Copy; it is copied as sensitive, so Android leaves it out of the clipboard preview. Export my data saves the JSON file where you choose, through Android's file picker.

The phone signs in to the same account as the computer and syncs the same records. It is the phone that encrypts them: the password goes through Argon2id on the phone (Bouncy Castle), and the session and the account's data key are kept encrypted with the Android Keystore, like the mail passwords. The records live on the phone first, so categories work without an account and without a connection. The phone syncs when Rukoo comes to the front, every five minutes while it is open, two seconds after a change, after each mail sync (also the background one every 15 minutes) and on Sync now.

The server is `https://rukoo.io` unless you choose another while signed out; [Rukoo account](account.md#the-server-rukoo-uses) says what that means for an account made at the old address, `https://rukoo-account.bvdm.ai`. A fork sets its own default with `ACCOUNT_SERVER` in `android/app/build.gradle.kts`. Release builds talk to account servers over https only; debug builds also take plain http to the phone itself and to the emulator's host, `http://10.0.2.2:<port>`, so an emulator can use `wrangler dev` on the computer. An account belongs to its server's address, so an account made through `10.0.2.2` doesn't open through `127.0.0.1`.

## Team chat

The phone has the team chat of [Rukoo on your computer](chat.md): workspaces on the server of your Rukoo account, with channels and direct messages, threads, mentions, mute and blocks. A read on one device counts on the other. Mute and drafts stay on the device where you set them.

**Switching to Chat.** The top of the folder drawer, and of the folder sheet on the cover screen, has a Mail and Chat switch. It shows once the server of your Rukoo account has team chat turned on, as the server at rukoo.io has. Chat's half of the switch carries the number of mentions and unread direct messages in all your workspaces, or a dot when only channels have unread messages, and while you're in Mail the folders button in the list's corner gets a dot too. Back at the top of Chat goes to Mail. In Chat the same corner button opens the workspaces, with the switch on top.

**Getting in.** Signed out, Chat offers Create an account and Sign in, which open Settings > Rukoo account. To join a workspace, choose Join with an invitation link in the workspace drawer and paste the link; Rukoo shows who invited you, the role, the channels, until when the link works and who hosts the workspace, and asks the name you want there. A link made on your computer works on the phone and the other way round, as long as both use the same server address. Without an account yet, choose **Join your team's chat** on the first screen (or Join with an invitation link in signed-out Chat), paste the link, then create an account or sign in: Settings closes and Chat opens the Join sheet with the link filled in, also after a restart, until you joined or chose Cancel. Pasting the link in the invite code field of Create an account does the same. Rukoo asks the server whether it has team chat at start, so Chat and that first-screen option show before anyone signs in; when that ask fails, it asks again after 15 seconds, a minute and five minutes, and when the app comes to the foreground or a network comes up. With a Rukoo account but no mail account the app opens in Chat, and once that account is in a workspace Android 13 and later ask, one time, to allow notifications. Links made at rukoo.io and at its former address rukoo-account.bvdm.ai are one server's; the app keeps that list itself, whatever a server says of its home. After the first workspace, the end of the conversation list names Rukoo on the computer once, with a link to rukoo.io. Make a workspace in the same drawer makes your own, with one channel, `general`.

**Channels and direct messages.** The list has the channels you're in by name, Browse channels for the ones you can join, and your direct messages by their last message, with closed ones dimmed at the end. New message in the corner starts a conversation with 1 to 7 people, or opens the one you already have with exactly them. Press and hold a message for Reply in thread, Copy text and Remove message. Replies show only in their thread: the message they answer shows how many there are, with a dot while some came since you last read the conversation, and a pill at the top of the conversation, such as "2 new replies in a thread", opens the thread with the oldest new reply whose line under its first message is out of view. A reply of yours that wasn't sent says so on that line, "1 reply not sent", and a row says "This message is no longer kept" where the server no longer keeps a thread's first message. The (i) button in a conversation's header has Mute and Mark as read, plus Members, Add people, Rename, Archive and Leave for a channel, or Close conversation, which closes it for everyone in it, and, with one other person, Block for a direct message. The workspace drawer has Change your name, Members, Invite people for owners and admins, Blocked people, Leave workspace and, for owners, Delete workspace, which works once the owner is its only member. [Team chat](chat.md) describes the rules, which are the same on both devices.

**Agents.** The phone shows the [agents in channels](chat.md#agents-in-channels) and manages them as the computer does, by the same rules. An Agent tag marks them next to their messages, in the mention list and in a channel's Members, and their avatars are rounded squares. The mention list says when one won't answer you, such as "Answers only Olga". Add people lists the agents you may add under Agents, with the line on what agents pass on; someone who may add only their own agents to a channel gets Add agents instead. A channel's Members and the workspace's Members show who made each agent and whom it answers under its name, such as "Made by Olga · Answers only Olga". The workspace's Members has a group of its own for agents, with Edit agent, New key for its sponsor and Remove agent. An agent has no Make manager in a channel's Members, and never shows in New message, as the one who takes over a channel or with Block. The Agents sheet lists the workspace's agents for owners, admins and members. It adds agents, which start on Only me, edits and removes them, and makes a new key for the agents you sponsor. After adding an agent or making a key, it shows the key once with Copy key, and the runner's config with Copy config. The phone has no "Use one of my agents": fill in the config's backend yourself, or make the agent on the computer.

**Notifications.** A direct message, a mention and a reply to your message ("Olga replied: …") notify you while that conversation isn't on screen, also while you're in Mail; on screen, the dot and the pill for new replies show a reply. That includes the first message of a conversation someone starts with you and a mention in a channel someone adds you to. Tapping one opens the conversation at that message, and a reply in its thread; reading it here or on another device takes the notification back. Which replies notify, and which don't, follows the computer's rules ([Team chat](chat.md#unread-notifications-and-mute)). A muted conversation never notifies. Settings > Notifications > Team chat notifications turns them off. While Rukoo is open, it checks every workspace about every minute and the workspace on screen hears of new messages at once.

A direct message, a mention or a reply can notify within seconds while Rukoo is closed too: the server wakes the phone through a push service ([Team chat in the background](#team-chat-in-the-background)). Delivery is best effort: the push service and the phone's battery settings decide when a wake arrives. On a phone with Google Play services that is Google's Firebase Cloud Messaging, built into Rukoo. With a [UnifiedPush](https://unifiedpush.org/users/distributors/) app such as ntfy on the phone, Rukoo uses that app instead. The Delivery row under Team chat notifications says Instant and names Google Play services or the app, or Every 15 min with the reason: no way to receive wakes, a server that doesn't send them, a push service your Rukoo server doesn't deliver through, or one that couldn't connect. With no way at all, tapping the row opens UnifiedPush's list of apps; with several, it picks which one to use.

Without push, Android runs Rukoo's check every 15 minutes at most, so a message can take that long to notify you. It can take much longer:

- While the phone lies still with its screen off, Android's Doze runs no background work until its next maintenance window, and those windows come further apart the longer the phone lies there.
- Android also spaces the check out for an app you don't open often, and runs it once a day after about eight days without opening Rukoo.
- After Force stop, or while Samsung's battery settings list Rukoo under Deep sleeping apps, nothing runs until you open Rukoo again.

The check survives a restart of the phone and an update of the app. The Battery row under Team chat notifications shows whether Rukoo is Unrestricted or Optimized and opens the page to change it, with the switch on or off, while you're signed in to your Rukoo account. Unrestricted lifts most of these limits; after Force stop the check still waits until you open Rukoo. While [Phone tools](#let-agents-use-rukoo-on-this-phone) runs, a message can notify sooner, and that row says so. With a UnifiedPush app, the row says to set both Rukoo and that app to Unrestricted, because Samsung can put either to sleep.

**What the host can read.** Team chat isn't end-to-end encrypted, unlike the records your Rukoo account syncs. Whoever runs the server can read and change the messages in its workspaces, direct messages included. The Join sheet, the start of each direct message and its header name the host. [What the host can read](chat.md#what-the-host-can-read) has the details.

**On the phone.** Rukoo keeps your workspaces in one file in its private storage, `files/chat/chat.db`, up to 2,000 messages per conversation, so Chat opens at once and works offline; older messages load from the server as you scroll up. A message written without a connection waits and goes out once the phone is back online. Signing out, deleting your account, choosing another server or the server ending your session deletes that file, unsent messages included; the sign-out dialog counts them first.

### Team chat in the background

With Rukoo in the background, `ChatSyncWorker` checks the ten most recently active workspaces every 15 minutes at most, when Android lets it run. Doze, App Standby and Samsung's sleeping apps can hold it back further, and Unrestricted battery use holds it back least.

**Push wakes.** With a push service, a message doesn't wait for that check. The push service is a UnifiedPush distributor: an app on the phone such as ntfy, or the one built into Rukoo, which receives through Google's Firebase Cloud Messaging (FCM). `ChatPush` registers Rukoo with the distributor through UnifiedPush's Android connector, with the server's VAPID key from `GET /v1/info`, and gives the server the endpoint and keys the distributor made (`PUT /v1/push-endpoint`, [server/WORKSPACES.md](../server/WORKSPACES.md#push-wakes)). When something comes that notifies, the server posts an encrypted wake there, which says only that there is something new and in which workspaces, by ID. The distributor hands it to `RukooPushService`, which starts `ChatSyncWorker`'s catch-up at once as expedited work, those workspaces first, also when they aren't among the ten most recently active the periodic check runs. The distributor lifts Rukoo out of the background for a few seconds to allow that, so the notification usually comes within seconds. Delivery is best effort: the push service, Doze and the battery settings of Rukoo and the distributor decide when a wake arrives. A wake the connector can't decrypt with Rukoo's keys isn't from the server and starts nothing.

- A wake never cancels a catch-up that is running. It queues one more run after it, unless a run is already waiting to start, which takes it too, so a steady stream of wakes queues one run. The running one sees the wake as well and runs once more, at most three rounds, so a wake that comes in while Rukoo fetches is never lost.
- A workspace a wake named that the catch-up couldn't fetch, such as one just joined that isn't listed yet, or one whose run failed or ran out of time, comes first at the next catch-ups too: three catch-ups at most, or for a day.

- Rukoo picks the distributor you chose under Delivery; else an app you installed, the one it registered with first; else the one built in. So installing ntfy moves Rukoo off FCM, unless you chose Google Play services under Delivery. It registers again at every start, as UnifiedPush asks, and looks again for a distributor whenever Rukoo comes to the foreground, so one you just installed is found when you come back.
- A registration the distributor refuses or doesn't answer is tried again with a backoff of a minute, doubling to an hour, at the next check after that: a `ChatSyncWorker` run, a process start, Rukoo coming to the foreground or a network coming back. Returning to Rukoo and a network coming back try again after 30 seconds already, which is when a `NETWORK` failure or a distributor that needed you (`ACTION_REQUIRED`) can succeed, as [UnifiedPush's specification](https://unifiedpush.org/developers/spec/android/) suggests. The endpoint the distributor gave before stays in use meanwhile.
- The built-in distributor is UnifiedPush's embedded FCM distributor. It registers with Google Play services under the server's VAPID key and gives an endpoint at `fcm.googleapis.com`, which takes the server's Web Push request as it is. So Rukoo has no Firebase SDK, no Firebase project and no `google-services.json`, and the server needs no Google key. It works only with Google Play services on the phone; without them the phone offers no built-in distributor. Google sees when a wake goes to the phone and the encrypted wake, never what a message says (`/privacy`). The library's repository has the LGPL 2.1 as its license at the tag Rukoo uses, although its Maven POM says Apache 2.0, so Rukoo lists it as LGPL 2.1 under Settings > About, with the license's text and a link to its source.
- A build without Google services, for a store such as F-Droid, leaves the built-in distributor out with `./gradlew assembleRelease -Prukoo.fcm=off`. That build gets wakes only through an app such as ntfy.
- The server keeps the endpoint and keys with the session, and signing in again sends them with the new session. Rukoo sends them again once a day in case the server lost them, at the next `ChatSyncWorker` run, and at once when the distributor gives new keys, also at the same address.
- Turning Team chat notifications off or a server that stops offering wakes unregisters Rukoo from the distributor and takes the endpoint back (`DELETE /v1/push-endpoint`). Until the server confirms that, every later check sends it again while the same session is signed in. Rukoo counts an endpoint as possibly on the server from the moment its `PUT` goes out, so one whose answer got lost is taken back too; only a confirmed `DELETE` or the end of the session clears that.
- A `PUT` or `DELETE` the server can't take now, a `429`, a `503` or no network, goes again after the answer's `Retry-After`, else after a backoff of a minute, doubling to an hour. A WorkManager job with a network of its own runs it then, also before any workspace is cached, and a newer plan replaces the one waiting, so they never pile up. The same job tries a registration again when the distributor hasn't answered.
- Signing out unregisters Rukoo from the distributor. Signing out ends the session on the server, endpoint and all, when the server can be reached. Without a connection the phone signs out on its own: the server keeps that session, and the endpoint, until you sign the phone out from another device, change your password or recover the account, or until wakes to the endpoint have failed for seven days, as they do once the phone let go of it.
- The server sends no wake to a session whose socket to that workspace pinged in the last 75 seconds, as Rukoo's does while it is open, and at most one more per 15 seconds after a wake ([Bursts](../server/WORKSPACES.md#push-wakes)).
- `ChatSyncWorker` keeps its 15-minute schedule throughout, for wakes that get lost and for a distributor that is asleep itself.
- A distributor app needs its own battery exemption: on a Samsung phone, set it to Unrestricted as well, or it can't receive wakes while the phone sleeps. Google Play services needs none: Android exempts it, and FCM delivers a high-priority message during Doze.
- The server delivers only through Google's FCM, ntfy.sh, Mozilla's push service and the push services its operator lists (`WORKSPACE_PUSH_ORIGINS`). An endpoint elsewhere, such as a self-hosted ntfy that rukoo.io doesn't list, is refused (`400 push_not_allowed`): Delivery says your Rukoo server doesn't deliver through that service, and the phone checks every 15 minutes. Choosing another distributor under Delivery registers with it at once. A refused endpoint is sent again when anything about it changes, when the server's version changes, or a day later.

While Phone tools' foreground service runs, Rukoo also tries to keep team chat connected in the background, so a message can notify sooner than the next check:

- The five most recently active workspaces each keep a wake socket open, the connection that tells the app a workspace has something new. While a socket is connected and Android lets Rukoo use the network, a new message runs that workspace's check at once. The server wakes each workspace's sockets on their own, so every workspace needs its own socket. Each one is an open connection with a short ping every 30 seconds while the phone is awake.
- Every workspace runs every 5 minutes, give or take 30 seconds. That catches a wake that got lost, covers the workspaces beyond the five, and keeps the sockets' 15-minute lease from running out. Unsent messages go out as they do with the app open.
- It needs a usable network as Android reports it: a default network with internet that isn't suspended or blocked for Rukoo. Data Saver doesn't block it: Android lets an app with a foreground service use the network. A new default network counts once Android has reported both its capabilities and whether it is blocked. Without one the sockets close and nothing retries. When a network comes back, Rukoo waits until it has been usable for 5 seconds, so a network that comes and goes doesn't reconnect each time, also when the loss and the return come too close together to see apart. When Android brings up a new default network before the old one is gone, as when Wi-Fi comes back while the phone is on mobile data, the open sockets check their connection and every workspace runs once, as soon as the new network has reported itself usable; when it hasn't within 5 seconds, the sockets close. When the old network drops first, as when Wi-Fi goes away and mobile data takes over, Android reports a loss: the sockets close and open again once the new network has been usable for 5 seconds. A metered network counts like any other.
- A socket that fails waits before it tries again: about 1, 2 and 4 seconds and so on, up to a minute, or as long as the server's `Retry-After` says. The wait belongs to the workspace, so a socket that a network change closes and opens again keeps it. When you open a workspace with Rukoo in the foreground, its socket tries at once; opening Rukoo or a network coming back doesn't shorten the waits of the other workspaces' sockets. `Retry-After` holds for all of them.
- It needs Team chat notifications on. Turning them off, turning Phone tools off, Phone tools stopping or signing out closes the sockets and stops the runs. `ChatSyncWorker` keeps its 15-minute schedule throughout.
- What notifies doesn't change: a muted conversation and a blocked person stay silent, the switch in Settings still turns it all off, and with Rukoo in the background no conversation counts as on screen.

Android still decides when Rukoo may use the network and the processor. Its [Doze documentation](https://developer.android.com/training/monitoring-device-state/doze-standby) says that while the phone dozes, Android suspends network access and ignores wake locks, apart from short maintenance windows that come further apart the longer the phone lies still. Its [table of power limits](https://developer.android.com/topic/performance/power/power-details) lists no network restriction for an app that runs a foreground service, and also lists network access as restricted during Doze. So while the phone dozes, a message can wait until the next maintenance window or until the phone wakes. Rukoo holds no wake lock: the pings and the 5-minute runs wait while the processor sleeps, so a connection that dropped without a close is only noticed when the phone wakes. Samsung can also stop Rukoo while its battery use is Optimized, which is why the Battery row points to Unrestricted.

### Push wakes in production

The server posts wakes to FCM's Web Push endpoint directly, so the FCM route needs no gateway at rukoo.io, no Firebase project and no Google key: nothing from the operator beyond the server and a release. In order:

1. Merge the server change, which deploys the account server (`server.yml`). Push wakes are on by default (`WORKSPACE_PUSH`). Check that `https://rukoo.io/v1/info` lists `push-wake` in `workspace.capabilities` and carries `workspace.push.vapid`.
2. Leave `WORKSPACE_PUSH_ORIGINS` empty unless people use a push service besides FCM, ntfy.sh and Mozilla's, such as a self-hosted ntfy; list its https origin there to allow it.
3. Keep `PEPPER` as it is. The VAPID key comes from it, and FCM ties every phone's registration to that key: a new pepper would end them all, besides every sign-in.
4. Release Rukoo for Android as usual. The release build includes the built-in FCM distributor; no Firebase files or secrets are involved.
5. On a phone without ntfy, open Settings > Notifications: Delivery says Instant, through Google Play services. Close Rukoo, send yourself a direct message from the computer and see it notify, usually within seconds; delivery is best effort, so try it also with the phone locked for a while. With ntfy installed and set to Unrestricted, Delivery names ntfy, and the same test should pass.

### Chat on the Fold

- Cover screen: the conversation list, a conversation and a thread each fill the screen, and Back steps from the thread to the conversation, to the list and then to Mail. The workspaces and the sheets (Join, New message, Members and the others) come up from the bottom.
- Inner screen: the list next to the conversation, at the list width you dragged it to. A thread opens to the right of its conversation, which then takes the list's place. The sheets show as dialogs in the middle of the screen.
- Folding and unfolding keeps the open conversation, the thread and what you were typing. Folded, you see the pane you touched last.

## Inbox categories

Settings > Inbox categories turns [inbox categories](categories.md) on. The folder drawer then lists them under Inbox, each with its color; one shows only its mail, under its own name with a dot and a wash of its color at the top, and switching clears a selection. Inbox shows all of it apart from the categories whose Show in Inbox is off, marked with a crossed-out eye; their unread mail leaves Inbox's count and the launcher badge's number, and Mark all as read leaves it alone. A search covers every category, and VIP and Unread still show them. Opening such an email from its notification brings up its category. Each email in Inbox, in search results, VIP and Unread carries a label with its category's color and name, which gives way before the subject on a narrow screen. In a list of several accounts, the account is a dot in its color on the sender's picture, as on the computer. To move an email to another category, press and hold it (or select several) and choose More > Move to category, or use More in the open email; the toast that follows offers Also future mail for its sender.

The settings page has the desktop's parts: the categories with up and down, editing a name, description, color, Show in Inbox and Notifications, adding up to twelve and deleting; When Rukoo isn't sure; Sort with Jev and the TypeSafe API key, which stays on this phone, encrypted like the mail passwords; Sort the inbox again, which counts along while it runs; and the senders with a rule.

While Jev sorts, waits for TypeSafe or can't use its key, the folder drawer says so in a line above the sync status, as the desktop's sidebar does. A tap opens a sheet with the progress, why Jev waits, and its last decisions; tap one to open that email in its category.

The phone sorts like the desktop. During each inbox sync it fetches a few headers of new mail (List-Id, List-Unsubscribe, Precedence, Auto-Submitted, Feedback-ID, X-Campaign and X-Mailer), and for Gmail accounts it asks Gmail which tab each message is in (`X-GM-RAW "category:…"`). The first device to sort an email stores the result in the account, so the phone and the computer show the same.

## Security

- The phone's MCP server only answers connections that arrive on its own Tailscale address, after the same checks as desktop: no `Origin`, the right `Host`, a valid token and size limits. A bridge that probes the phone first proves it has the same Hermes key, as with the desktop.
- Passwords, refresh tokens, the Hermes key, the OpenClaw token, the computer pairing tokens, the Rukoo account's session and data key, and the TypeSafe key are encrypted with a key in the Android Keystore. App backups are off.
- The Rukoo account's records are encrypted on the phone before they go to the server; the server never gets the password or the key ([server/PROTOCOL.md](../server/PROTOCOL.md)).
- The computer accepts phone requests only on its Tailscale address and only while its Phone switch is on. Pairing codes work once, for five minutes, and burn after five wrong tries. A paired phone can only point the computer's tool calls back at its own address.
- Email reaches agents inside `<unsafe_content>`, as on desktop. The reader runs without JavaScript and without file access.
- Files you attach to a chat stay in the app's private storage. Their names and text reach agents inside `<unsafe_content>`, like email. Another app gets a file only when you tap it in the chat, and then only that file, read-only.
- There is no tool that sends mail. Sending is always your tap. Deleting and unsubscribing always ask.

## Limits

- No calendar and no booking page settings on the phone yet.
- The composer has no text color, highlight, indent or inline images, which desktop's composer has. A desktop draft that uses them loses them when it is opened and saved on the phone; its words stay.
- No push (IMAP IDLE): the background sync runs every 15 minutes.
- The phone has no PDF reader, so `read_attachment` and `read_chat_file` give agents a PDF as a file without its text. Clark can read it on its own machine.
- Photos keep the format the camera saved them in. A HEIC photo goes to the agent as a file, not as an image.
- OpenClaw's Rukoo tools point at one device at a time.
- Team chat notifies at once with Rukoo closed only with Google Play services or a UnifiedPush app such as ntfy on the phone. Without either, Android lets Rukoo check for new messages every 15 minutes at most in the background, and much less often while the phone dozes or after days without opening Rukoo, so a notification can come that late ([Notifications](#team-chat)). Open, Rukoo checks about every minute and hears of the workspace on screen at once. While Phone tools runs, a message can notify sooner, and Android can still hold it back while the phone dozes ([Team chat in the background](#team-chat-in-the-background)).
- Team chat uses one host, the server of your Rukoo account. A workspace on another server can't be joined from the phone.
- Team chat on the phone shows no reactions, files, link previews or formatting yet, and neither the phone nor the computer searches messages. [Not in this version](chat.md#not-in-this-version) lists the rest.

## Build and develop

Requirements: JDK 17 and the Android SDK (compile SDK 36). The toolchain versions are pinned in `android/gradle/libs.versions.toml`.

```sh
cd android
./gradlew testDebugUnitTest      # JVM unit tests
./gradlew assembleDebug          # app/build/outputs/apk/debug, package nl.bvdm.rukoo.debug
./gradlew assembleRelease        # needs signing.properties, else falls back to the debug key
```

Release builds read `android/signing.properties` (`storeFile`, `storePassword`, `keyAlias`, `keyPassword`), which Git ignores. Keep the keystore safe: Android only installs an update signed with the same key.

`node android/tools/serve-apk.mjs <this PC's Tailscale IP> 8787` serves the APKs in `android/artifacts/` so a phone on the tailnet can download them.

Debug builds add things for testing that release builds leave out:

- The "Test agent", a scripted agent like desktop's `SEM_AGENT_FAKE=1`, which uses the real tools.
- A loopback listener for the MCP server, and Settings > Phone tools > For testing > "Address for agents", so an emulator behind `adb forward` can play a phone on the tailnet.
- `adb shell am broadcast -n nl.bvdm.rukoo.debug/nl.bvdm.rukoo.mail.sync.DebugSyncReceiver` runs a background sync.
- `adb shell am broadcast -n nl.bvdm.rukoo.debug/nl.bvdm.rukoo.workspaces.DebugChatSyncReceiver` runs team chat's background catch-up, with its notifications, without waiting 15 minutes.
- The Rukoo account may use a server over plain http on the phone or the emulator's host: Settings > Rukoo account > Server, `http://10.0.2.2:8790` for `npx wrangler dev --port 8790` in `server/`.

The account's tests against a real server skip unless `RUKOO_ACCOUNT_TEST_SERVER` is set, for example to `http://127.0.0.1:8790` with `wrangler dev` running. With `RUKOO_ACCOUNT_TEST_NODE` set to a Node.js binary as well, one of them runs desktop Rukoo's account code in Node next to the phone's, so both read each other's records; desktop's dependencies must be installed (or on `NODE_PATH`).

```sh
RUKOO_ACCOUNT_TEST_SERVER=http://127.0.0.1:8790 RUKOO_ACCOUNT_TEST_NODE=$(which node) ./gradlew testDebugUnitTest --tests 'nl.bvdm.rukoo.account.*'
```

Team chat's live test, `WorkspaceLiveTest`, needs a server with team chat on, which `wrangler dev` with the defaults isn't. `test/fixtures/real-server-cli.js` runs one, as CI does; it needs `npm ci --prefix server` once:

```sh
node test/fixtures/real-server-cli.js --port 38850 --ready-file tmp/rukoo-server.json   # from the repository root; delete the file to stop it
RUKOO_ACCOUNT_TEST_SERVER=http://127.0.0.1:38850 RUKOO_ACCOUNT_TEST_INVITE=test-invite ./gradlew testDebugUnitTest
```

The other team chat tests use answers recorded from that server (`app/src/test/resources/workspace/vectors.json`, written by `app/src/test/workspace-fixtures/make-fixtures.js`). For a check by hand on an emulator, `adb reverse tcp:38850 tcp:38850` lets the emulator reach the same server at `http://127.0.0.1:38850`. Choose that address under Settings > Rukoo account > Server, so invitation links made on the computer for `127.0.0.1:38850` work on the phone; with `http://10.0.2.2:38850` they belong to another server.

`app/src/androidTest` holds tests that need Android's own TLS: the account client, Jev, Google sign-in and one-click unsubscribe count each answer's bytes on the plain socket underneath TLS, and only a device shows that Android's TLS reads through that socket. CI doesn't run them. Run them on an emulator of your own after changing how one of those clients connects; `ANDROID_SERIAL` picks the emulator when more than one runs, and leaving the APKs installed keeps the debug app's data:

```sh
ANDROID_SERIAL=emulator-5554 ./gradlew connectedDebugAndroidTest -Pandroid.injected.androidTest.leaveApksInstalledAfterRun=true
```

On an emulator, `adb shell wm size 1080x2520` gives the cover screen's size and `adb shell wm size 1968x2184` with density 420 the inner screen's.

Code map, under `android/app/src/main/java/nl/bvdm/rukoo/`:

| Package | What it holds |
|---|---|
| `mail/` | The mail engine: IMAP and SMTP sessions, the cache, sync, MIME, the reader's HTML, replies and signatures, Google sign-in, the demo account |
| `agents/` | Conversations, turns and approvals (`Hub.kt`), the turn text and `<unsafe_content>` rules, quick actions and skills; `agents/adapters/` has Hermes, OpenClaw, the computer host and the test agent |
| `account/` | The Rukoo account: the keys and sealing of `server/PROTOCOL.md` (`AccountKeys.kt`), the server's HTTP API, and the local-first records and their sync (`AccountService.kt`), a port of desktop's `src/main/account/` |
| `categories/` | Inbox categories: the mail signals, the rules, Jev, and which category each inbox email is in (`Categories.kt`), a port of desktop's `src/main/categories/` |
| `workspaces/` | Team chat's engine, a port of desktop's `src/main/workspaces/`: the cache (`ChatDb.kt`, `WorkspaceStore.kt`), the server's routes (`WorkspaceClient.kt`), the feed, history and reads (`FeedApplier.kt`, `WorkspaceSync.kt`), sending (`Outbox.kt`), the wake socket, the service behind the `Workspaces` interface (`WorkspaceService.kt`), background catch-up (`ChatBackground.kt`, `ChatSyncWorker.kt`), push wakes through UnifiedPush (`ChatPush.kt`, `RukooPushService.kt`) and notifications (`ChatNotifier.kt`) |
| `mcp/` | The phone's MCP server, its tokens and proof, and the twenty-three tools (`tools/BookingLink.kt` has the calendar tools' answers, `tools/McpTools.kt` the meeting tools' `NO_MEETINGS`) |
| `desktop/` | Pairing with a computer, the import and the client of the computer's `/phone/v1` routes |
| `ui/` | Compose screens: `root/` (layout and navigation), `mail/` (with the category sheet), `reader/`, `composer/`, `agent/`, `settings/` (with the Rukoo account's pages and Inbox categories), `onboarding/`, `chat/` (team chat), and the theme, icons and components ported from the desktop |
| `ui/chat/` | Team chat's screens: the Mail and Chat switch (`ModeSwitch.kt`), the one- and two-pane layouts (`ChatLayouts.kt`), the conversation list, a conversation and a thread (`ChatHomePane.kt`, `RoomPane.kt`, `ThreadPane.kt`), the composer with mentions (`ChatComposer.kt`), the workspace drawer (`WorkspaceSheet.kt`) and the sheets (`ChatSheets.kt`), with `ChatUi.kt` for the questions, busy states and error texts |
| `core/` | Storage, the Keystore box, Tailnet checks and the `<unsafe_content>` helpers |
