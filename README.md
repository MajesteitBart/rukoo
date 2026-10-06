<picture>
  <source media="(prefers-color-scheme: dark)" srcset="src/renderer/assets/rukoo-logo-dark.svg">
  <img src="src/renderer/assets/rukoo-logo.svg" alt="Rukoo Mail" width="240">
</picture>

# Rukoo Mail

Rukoo Mail is an email client for Windows, built with Electron. It uses a tablet-style layout: a drawer with accounts and folders, a message list grouped by day, and a reading pane with an action bar along the bottom. The interface is in Dutch.

![Inbox and reading pane](docs/screenshots/3-reader.png)

## What works

- "Aanmelden met Google" for Gmail and Google Workspace. You sign in in your browser (OAuth 2.0 with PKCE), after which IMAP and SMTP use XOAUTH2. No app password needed.
- IMAP accounts for Yahoo, Outlook, Exchange, Office365 and any other provider, with preset servers per provider and manual IMAP/SMTP settings.
- A demo account with sample mail, so you can try the app without credentials.
- Unified inbox across accounts ("Alle accounts") with unread badges per account.
- Drawer views: Postvak IN, Ongelezen, VIP's, Sterren, Opgeslagen e-mails, Concepten, Verzonden, Prullenbak, plus Spam, Archief and your own folders per account.
- Reading pane with sender chip, "Gegevens" details, attachments (open or save), previous/next navigation and a full-width mode.
- HTML mail renders in a sandboxed frame with scripts stripped. In dark mode HTML mail is recoloured; you can switch that off.
- Compose, reply, reply all and forward, with "Inclusief vorige berichten", recipient autocomplete, Cc/Bcc, attachments by picker or drag and drop, inline images and a formatting toolbar.
- Drafts are saved to the server's Concepten folder; closing an unsaved mail asks whether to keep it.
- Swipe actions with mouse, pen or touch: right marks read or unread, left deletes.
- Search, sorting, mark all as read, empty Prullenbak.
- Settings modelled on "E-mailinstellingen": dark mode, swipe actions, fit content to the window, notifications, taskbar badge, sync interval, signature, spam addresses, VIP's and folder visibility.
- Windows notifications for new mail and a count badge on the taskbar icon.

Keyboard: `Ctrl+N` new mail, `Ctrl+R` reply, `Ctrl+Shift+R` reply all, `Ctrl+F` forward, `Ctrl+E` search, `Delete` delete, `↑`/`↓` previous/next, `F5` sync, `Ctrl+Enter` send.

## Limits

Google sign-in needs an OAuth client of type "Desktop app" from Google Cloud. The client is not in this repository. The app looks for it in this order:

- the `SEM_GOOGLE_CLIENT_ID` and `SEM_GOOGLE_CLIENT_SECRET` environment variables;
- `%APPDATA%\Rukoo Mail\google-oauth.json`, as `{"client_id": ..., "client_secret": ...}` or Google's own download format, which "Google OAuth-client importeren" on the setup screen writes for you.

While the client's consent screen is unverified, Google shows a warning before you can continue. A Workspace admin may also have to trust the app for the `https://mail.google.com/` scope.

Other providers use IMAP and SMTP with a password; Yahoo requires an app password. Microsoft has switched off password sign-in for most Outlook.com and many Microsoft 365 mailboxes, and those need OAuth, which this app does not implement yet. Exchange works when the server offers IMAP and SMTP; Exchange ActiveSync is not supported.

Each folder keeps the newest 300 messages (inbox) or 100 (other folders) locally. Older mail stays on the server.

Passwords and Google refresh tokens are encrypted with Windows DPAPI through Electron's `safeStorage`. Account data and the message cache live in `%APPDATA%\Rukoo Mail\data`. Earlier builds, named "E-mail", used `%APPDATA%\E-mail`; the app moves that folder on first launch.

## Run it

Requires Node.js 20 or newer.

```bash
npm install
npm start
```

`npm start` goes through `scripts/start.js`, which clears `ELECTRON_RUN_AS_NODE`. Terminals that run on Electron (VS Code, T3 Code) export that variable, and it makes `electron.exe` behave like plain Node.

Build a Windows installer and a portable exe in `dist/`:

```bash
npm run dist
```

## Tests

```bash
npm test          # unit tests for the engine and mail parsing, plus a live IMAP test
npm run test:e2e  # Playwright drives the real Electron app
```

The live IMAP tests create a throwaway mailbox on [Ethereal](https://ethereal.email) and skip themselves when it is unreachable.

## How it is built

| Path | Role |
| --- | --- |
| `src/main/engine.js` | Accounts, local cache, sync, flags, moves, sending, drafts, VIP's and spam |
| `src/main/google.js` | Google sign-in: loopback redirect, PKCE, token refresh |
| `src/main/imap.js` | IMAP via [imapflow](https://github.com/postalsys/imapflow), SMTP via nodemailer |
| `src/main/demo.js` | The demo account: same interface as `imap.js`, backed by a local JSON file |
| `src/main/main.js` | Window, IPC table, notifications, taskbar badge |
| `src/renderer/` | Plain HTML, CSS and ES modules, no framework or bundler |

The renderer runs sandboxed with context isolation. It can only call the methods in the IPC table in `main.js`.
