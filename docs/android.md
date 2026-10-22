# Rukoo for Android

Rukoo for Android is Rukoo Mail on a phone, built for a foldable first: on a Galaxy Z Fold7 the cover screen shows one thing at a time, and the inner screen shows two columns side by side. The phone does the mail itself, over IMAP and SMTP. The agents are the same ones you use on the computer: Clark (Hermes Agent) and OpenClaw answer the phone directly over Tailscale, and Claude Code and Codex run on your computer while you chat from the phone.

The app's code is in [`android/`](../android). It is a native Kotlin and Jetpack Compose app, separate from the Electron app, that follows the desktop's behavior: the same quick actions, skills, approvals, `<unsafe_content>` rules and MCP tools.

## What it does

- Mail accounts on the phone: Gmail with Google sign-in, other providers with an app password or password, and the demo account. Inbox, folders, unified views, search, swipe and selection actions with Undo, a reader for HTML mail, a composer with formatting for replies, forwards and new mail, drafts saved to the account's Drafts folder, and new-mail notifications.
- The agent chat next to the email, with every desktop quick action, `/` skills, `$` agent skills, model and effort menus, files, photos and emails attached to a message, plans, sources, drafts written into the composer, and approval cards for anything other people will see.
- Rukoo's twelve MCP tools served by the phone, so an agent can read the phone's mail, write into its composer and ask for approval on its screen.
- Pairing with Rukoo on your computer, which brings over your accounts and agent settings once and lets the phone use the computer's Claude Code and Codex.
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
| OpenClaw | The gateway's OpenAI-compatible endpoint over Tailscale | `openclaw mcp set` with the command from Settings > Phone tools > "Copy OpenClaw setup". It replaces the computer's entry, because OpenClaw names one Rukoo |
| Claude Code, Codex | Rukoo on your computer runs them, over the computer's Tailscale address | The computer forwards their Rukoo tool calls to the phone |

For Claude Code and Codex, the computer must be on, with Rukoo open (the tray is enough), Tailscale on, and "Let my phone use this computer" on. Their own permission requests ("Claude Code wants to read a file") show as approval cards on the phone. Phone chats always run with "Ask before actions" on the computer. [Rukoo on your phone](agents.md#rukoo-on-your-phone) describes the computer's side.

## Attach files to a chat

The + at the start of the chat input opens a sheet with three choices: Files (the system file picker, any type), Photos (Android's photo picker), and "Add this email" when the email on screen isn't in the chat yet. Rukoo copies a picked file into its own storage right away, so the chat doesn't depend on the other app's permission lasting. Each file shows as a chip above the input, an image with a small picture of itself, and its × takes it off before you send.

Your next message takes the files along, also a quick action or a skill, and a message can be files alone. It takes up to 10 files of up to 10 MB each. Programs, scripts and installers, such as `.exe`, `.js` or `.apk`, stay out. The files show on your message in the chat; tap one to open it in another app. The chat keeps them until you delete it.

Agents get the files as on the desktop. The message lists each file with its `file_id` and its name inside `<unsafe_content>`, with the start of a text file's text, and `read_chat_file` returns the whole file. Clark and OpenClaw read the files from the phone through Rukoo's tools. Claude Code and Codex on your computer get images along with the message; other files they read with `read_chat_file`, which the computer passes on to the phone. The phone has no PDF reader, so a PDF reaches the agent as a file without its text.

## Let agents use Rukoo on this phone

Settings > Phone tools turns the phone's MCP server on. The phone then listens on its Tailscale address, port 47800, and Android shows a silent notification while it runs. Who can connect follows your settings: Clark while its API key is set, OpenClaw while "Let OpenClaw use Rukoo on this phone" is on, and each paired computer with a token of its own. The tools are the desktop's, with the same names and inputs, so Clark's bridge keeps one tool list for every device.

Clark's bridge needs version `bridge-4` or newer to look for Android devices. Copy `integrations/hermes/rukoo_bridge.py` to the Hermes machine again (see [the bridge's README](../integrations/hermes/README.md)). Until then, add `RUKOO_URL=http://<phone's Tailscale IP>:47800/mcp` to the bridge's environment.

Samsung phones stop apps in the background to save battery, and then agents can't reach the phone. Settings > Phone tools > Battery opens the page where you choose Unrestricted.

## On the Galaxy Fold

- Cover screen: the list, the email, the chat and the composer each fill the screen. The chat is a full-screen page with the email as a chip above the input.
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

Mail syncs when the app opens, every few minutes while it is open (Settings > Accounts, five minutes by default), and every 15 minutes in the background, which is the shortest interval Android allows. New mail gives one notification per account. An agent's reply, a waiting approval and a draft an agent wrote while you were elsewhere give a notification that opens the chat.

## Security

- The phone's MCP server only answers connections that arrive on its own Tailscale address, after the same checks as desktop: no `Origin`, the right `Host`, a valid token and size limits. A bridge that probes the phone first proves it has the same Hermes key, as with the desktop.
- Passwords, refresh tokens, the Hermes key, the OpenClaw token and the computer pairing tokens are encrypted with a key in the Android Keystore. App backups are off.
- The computer accepts phone requests only on its Tailscale address and only while its Phone switch is on. Pairing codes work once, for five minutes, and burn after five wrong tries. A paired phone can only point the computer's tool calls back at its own address.
- Email reaches agents inside `<unsafe_content>`, as on desktop. The reader runs without JavaScript and without file access.
- Files you attach to a chat stay in the app's private storage. Their names and text reach agents inside `<unsafe_content>`, like email. Another app gets a file only when you tap it in the chat, and then only that file, read-only.
- There is no tool that sends mail. Sending is always your tap. Deleting and unsubscribing always ask.

## Limits

- No calendar on the phone yet.
- The composer has no text color, highlight, indent or inline images, which desktop's composer has. A desktop draft that uses them loses them when it is opened and saved on the phone; its words stay.
- No push (IMAP IDLE): the background sync runs every 15 minutes.
- The phone has no PDF reader, so `read_attachment` and `read_chat_file` give agents a PDF as a file without its text. Clark can read it on its own machine.
- Photos keep the format the camera saved them in. A HEIC photo goes to the agent as a file, not as an image.
- OpenClaw's Rukoo tools point at one device at a time.

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

On an emulator, `adb shell wm size 1080x2520` gives the cover screen's size and `adb shell wm size 1968x2184` with density 420 the inner screen's.

Code map, under `android/app/src/main/java/nl/bvdm/rukoo/`:

| Package | What it holds |
|---|---|
| `mail/` | The mail engine: IMAP and SMTP sessions, the cache, sync, MIME, the reader's HTML, replies and signatures, Google sign-in, the demo account |
| `agents/` | Conversations, turns and approvals (`Hub.kt`), the turn text and `<unsafe_content>` rules, quick actions and skills; `agents/adapters/` has Hermes, OpenClaw, the computer host and the test agent |
| `mcp/` | The phone's MCP server, its tokens and proof, and the twelve tools |
| `desktop/` | Pairing with a computer, the import and the client of the computer's `/phone/v1` routes |
| `ui/` | Compose screens: `root/` (layout and navigation), `mail/`, `reader/`, `composer/`, `agent/`, `settings/`, `onboarding/`, and the theme, icons and components ported from the desktop |
| `core/` | Storage, the Keystore box, Tailnet checks and the `<unsafe_content>` helpers |
