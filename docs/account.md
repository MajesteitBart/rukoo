# Rukoo account

A Rukoo account keeps Rukoo's own data the same on your devices: your inbox categories, the category each email got, the corrections you make and the settings of your [booking page](booking.md). A booking page needs an account. The account doesn't hold your mail or your mail passwords. Those stay with your mail provider and on each device, as before.

Rukoo encrypts the account's data on your device before it leaves. The key comes from your password and never reaches the server, so whoever runs the server can't read what you stored.

You find it in Settings → Rukoo account.

## Creating an account

1. Settings → Rukoo account shows which server the app uses, who runs it and where it keeps data. Check that first.
2. Choose **Create an account** and enter your email address and a password of at least 12 characters.
3. Rukoo shows a **recovery key** once: 32 letters and digits in groups of four. Save it in a password manager or write it down. It is the only way back in if you forget your password.

The computer then syncs. Data you already had on this computer goes into the account.

Your email address is your sign-in name. Some servers check it before they make the account: after **Create an account**, the server emails you a code and the form asks for it. Type the six digits, which work on this device for 10 minutes, or paste the long code from the same email, which works once on any device for a day. Five wrong tries end the six digits; **Send a new code** asks for another, at most one a minute. An invite code from the server's operator takes the place of the emailed code there, and an invitation link to a team chat workspace still needs it. When the invite code is wrong or used up, the form emails a code instead, and that code works with the invite code still in its field. A server that doesn't send mail never checks the address.

## A locked account

Ten wrong passwords in 15 minutes lock an account's sign-ins for 15 minutes, also on Forgot your password?, and anyone who knows your address can cause that. Where the server sends mail, the sign-in form then offers **Email me a code**: with the code from that email, your sign-in goes past the lock now. Once the 15 minutes are over, the form signs in without the code. Devices that are already signed in aren't affected.

## Another device

Choose **Sign in** with the same email address and password. The device downloads what the account holds and adds what it had itself. When the same item changed on two devices, the newest change wins.

Each device syncs every five minutes, shortly after you change something, and when you choose **Sync now**. Without a connection everything keeps working on the device, and the changes go up at the next sync.

## Devices, password and recovery key

- **Devices** lists every device signed in to the account. Choose one to sign it out. It keeps its own copy and stops syncing.
- **Change password** signs out your other devices. They need the new password.
- **New recovery key** replaces the old one, which stops working.
- **Forgot your password?** takes your recovery key and a new password. Every device signs out.

Nobody can reset your password for you: the server never has the key that opens your data. If you lose both the password and the recovery key, the data in the account is gone. Rukoo can sort your mail again, but your corrections and your own categories are lost.

## What's stored and shared

Settings → Rukoo account → **What's stored and shared** shows this for the server you use.

| Who | What they get |
| --- | --- |
| Whoever runs the server | Your email address, your device names and platforms, when each device last connected, and your records, encrypted. While your booking page is on, also what the page publishes and the bookings made on it |
| The hosting company (Cloudflare for the server in this repository) | The same, plus IP addresses in its request logs |
| Your mail providers | Nothing from the account. A booking page's events are in your calendar, and they hold the guest's links to move or cancel the booking (see below) |
| Anyone else | Nothing. Rukoo uses no analytics, advertising or tracking services |

The server sees how many records you have, how large they are and when they change. It can't see your categories, your corrections, which email went where or anything in your mail. Your booking page's settings, its key pair and the record of which event each booking became are records too, encrypted like the rest.

Turning a booking page on changes what the server sees, because it has to offer times and take bookings while your computers are off. It then keeps your name, introduction, time zone and meeting types, your open hours and the busy times within them (to the quarter hour, without titles), and each booking's time, type and status, readable. A guest's name, email, note and assistant name pass through the server readable at the moment of booking. The server then seals them to a key only your devices hold and keeps only that sealed copy, so a later leak of its storage doesn't reveal them. The operator, or someone who broke into the server at that moment, could read them then. [Booking page](booking.md#what-the-server-sees-and-keeps) has the details.

Each booking also gives the guest a key to move or cancel it. The server keeps only a hash of it, and your Rukoo account doesn't hold it. Your computer opens it from the sealed details and puts it in the booking's event as two links, so your calendar provider gets it too, and so does everyone who sees the invitation: the guest, people you add to the event later and anyone it is forwarded to. Any of them can move or cancel the booking. [Booking page](booking.md#where-bookings-go) says more.

Cloudflare is a company in the United States. The server in this repository keeps its data in the EU by default (`JURISDICTION` in `server/wrangler.jsonc`), but as a US company Cloudflare falls under US law, also for data stored in the EU. The page in Settings shows where the server you use keeps its data.

**Export my data** saves everything in your account as a readable JSON file, except your booking page's key pair: its private key opens your guests' details. **Delete account** checks your password and turns your booking page off, which deletes the page and its bookings from the server. Then it removes the account and everything in it at once. When the booking page can't be turned off, the account stays. Your devices keep their own copies.

[Team chat](chat.md) works differently. Its messages live in each workspace, readable by whoever runs the server, and they aren't part of your account's encrypted records or of the export. When you delete your account, you leave every workspace you're in: your direct messages close, and the messages you wrote stay in their workspaces under "Deleted member" until each workspace's retention removes them, after 90 days by default. A workspace where you're the only member stays on the server with nobody in it. Retention removes its messages, but the workspace and its name stay, so delete it in Chat first if you want it gone. Each device deletes its copy of team chat when its session ends.

## Signing out

**Sign out** stops this computer from syncing. It keeps its own copy, so your categories keep working. Signing in again brings it back in step.

## The server Rukoo uses

Rukoo uses `https://rukoo.io` unless you choose another server. Bart van der Meeren, Rukoo's maintainer, runs it on Cloudflare with the data kept in the EU. The same address serves Rukoo's website; booking pages are at `meet.rukoo.io`. For now, making an account there needs an invite code from the maintainer or an invitation link to one of its team chat workspaces: paste the link in the **Invite code** field. Each link makes one account ([Invitation links](chat.md#invitation-links)). It sends codes for [a locked account](#a-locked-account). The server holds up to 1,000 accounts of 32 MiB each. Its privacy statement is at [rukoo.io/privacy](https://rukoo.io/privacy).

Earlier versions of Rukoo used `https://rukoo-account.bvdm.ai`, which reaches the same server. An account belongs to the address it was made at, because the proof of your password includes the server's address. So a device signed in at the old address keeps using it after an update, until you sign out or delete the account. Then it uses rukoo.io. The same happens when another device ends its session, for example by deleting the account or changing the password. When you sign in again on that device, Rukoo tries the old address too, and stays there when your account still is.

An account made at the old address doesn't sign in at rukoo.io, and the server holds one account per email address for both addresses. To move yours, delete the account on a device that is still signed in at the old address, then create it again at rukoo.io. That device keeps its own copy and sends it to the new account. Deleting also turns your booking page off and deletes its bookings, so turn the page on again afterwards. The handle stays yours when you make the account again on the same computer: that computer keeps a key for it, because anyone could sign up with your email address in between. Your other devices are signed out and now use rukoo.io, so sign them in again with the new account. On any other device, sign in to the old account by choosing the server row while signed out and entering the old address.

## In a browser

On rukoo.io, a [team chat](chat.md) invitation link opens Chat in the browser at `rukoo.io/app/`, so the person invited can start without installing Rukoo. Chat is the only part of Rukoo there. You sign up or sign in with the same Rukoo account. Once you're signed in, a notice above the page lists the Rukoo apps in the order to get them: the desktop app for mail, calendar and meetings, then Rukoo for Android, then Rukoo Voice for dictation and meeting recording. The desktop step links the download for your system. Close the notice and it stays gone in that browser. [website/README.md](../website/README.md#rukoo-in-the-browser) explains how the page is built and served.

The page needs Chrome or Edge 112, Firefox 119, Safari 17 or a newer version. An older browser lacks what the chat code uses to check emoji and message text, and the page says to update it.

The browser keeps these in the site's storage:

- `rukoo.web.session` in local storage: the server's address, your email address, the session token and when you signed in.
- `rukoo.web.settings` in local storage: the language, the theme and whether chat notifications are on.
- `rukoo.web.layout` in local storage: whether the sidebar is collapsed.
- `rukoo.web.apps` in local storage: `dismissed` once you close the notice about the Rukoo apps, so it doesn't show again in this browser.
- `rukoo.chat.open` in local storage: the IDs of each workspace you're in and of the conversation you last had open there.
- `rukoo.chat.emoji.recent` in local storage: the emoji you used last in reactions and messages, at most 24.
- `rukoo.chat.emoji.skin` in local storage: the skin tone you picked for emoji.
- `rukoo.chat.formatBar` in local storage: whether the formatting bar above the text shows.
- `rukoo.web.unsent.` and a random ID for each open tab, in local storage: how many chat messages that tab still has to send, with a tag of the session (the first 22 characters of a SHA-256 hash of the session token), so that signing out in one tab can count the messages waiting in the others. It holds no message text, and goes when the tab closes or has sent everything.
- `rukoo.web.notifications` in local storage: `unsupported` once the browser refused to show a notification the page made, as Chrome on Android does, so Settings stops offering notifications there.
- `rukoo.web.join` in the tab's session storage: the invitation link the page was opened with, its secret included. Other tabs don't see it. It goes when you join with it, sign out, delete the account or close the tab.

Messages, channels, members and drafts are only in the page's memory. They load from the server again each time you open the page, and messages that haven't been sent yet are lost when the page closes; the browser asks before it closes the page while there are any. The browser doesn't keep your password or the account's data key. At sign-in the page checks that the key the server sent opens with your password, then forgets the key, so the browser never reads or changes your categories or corrections.

Team chat's files work as in the app where the server stores them: attach them, drop them on the conversation or paste them, and images show in the message. A file you pick with the paperclip is read from your disk as it uploads; a dropped or pasted one is copied into the page's memory first. While a file uploads, the tray says so without a percentage: a page learns how much of an upload went only when the server answers. So the page also can't tell a slow upload from one that stalled. It gives the files uploading together the time they take at about 128 kbit/s, plus a minute, and on a slower connection their uploads fail. A picked file that changes on your disk before it is sent can't be read again: remove it and attach it again.

Files waiting under the text are lost with the page, so the browser also asks before it closes the page while there are any. When the page closes anyway, it asks the server to drop their uploads, in requests the browser sends after the page has gone. That is best effort: a browser can leave them unsent, and a file whose reservation the server hadn't answered yet has no upload to name. Such an upload expires on the server an hour after it was reserved, and until then counts against your 20 unsent files.

The files the page downloads to show or save are kept in its memory too: at most 256 MiB of them, the least recently used going first, and they go when the page closes. The limit is on that cache. A download holds its own reference to the file's bytes for 60 seconds, so for that long the bytes stay in memory after the cache let them go. An image opened in a new tab belongs to that tab: it stays there until you close the tab, also after the page closes, while its address stops working after 60 seconds. **Download** saves a copy through the browser, to the place it saves downloads, and that copy stays on your device after the page closes.

A new tab opens signed in, and signing out in one tab signs out every tab. **Sign out** tells the server, then removes the session entry, the invitation link and the session's unsent counts. Its confirmation counts the unsent messages of every tab, and a tab that lost unsent messages to a sign-out in another one says how many. The settings, the sidebar, the formatting bar, the closed apps notice, the recent emoji and the skin tone, and the last open conversations stay. A session that ended elsewhere, for example when another device signs the browser out under **Devices**, is removed the next time the page talks to the server. In a private window, the browser deletes all of it once you close every private window. When the browser blocks site data, the page keeps the sign-in in memory only, until you close or reload the tab.

The server knows the browser's session as one made in a browser, from the moment you sign in ([`server/PROTOCOL.md`](../server/PROTOCOL.md#sessions-made-in-a-browser)). That session can use Chat as you, show the account and its devices, sign devices out and sign out. It can't read or change your encrypted records, and it can't use the booking page: it can't see, change or turn off the page, and can't see or handle its bookings. Deleting the account needs your password too, and deleting it in the browser also deletes your booking page and its bookings, as on any device. Like anything in local storage, a script running on the site could read the token and do what the session can. On a shared computer, sign out when you're done. The browser shows in **Devices** under its name and system, such as "Firefox · Windows".

The page's code comes from the server's site each time you open it. Whoever runs the site, or someone who broke into it, could change that code to capture your password as you type it, and with the password open your encrypted records. The desktop and Android apps run the code you installed. If that risk matters to you, use Chat in one of them.

What the browser leaves out:

- **Change password**, **New recovery key**, **Export my data** and **Sync now**. Use the desktop or Android app for these. The first two need the data key, which the browser doesn't keep.
- **What's stored and shared**, the page about where the account's data lives. This section and [What's stored and shared](#whats-stored-and-shared) cover it. The signed-out page and the sign-up form link the server's privacy statement instead. On a server whose operator sets `WEB_APP` to `on`, as rukoo.io does, the statement has a section on the browser too.
- Opening a chat file in its app. A page can't hand a file to a program on your computer, so **Open** shows an image in a new tab and downloads any other file, and **Save** is the browser's own download. The file cards and the image viewer say **Download** and **Open in a new tab**.
- Files on a server that keeps them at an address of their own (`WORKSPACE_FILES_ORIGIN`). The page may only connect to the address it came from, and the file routes answer no other site, so the paperclip doesn't show there and opening a file says the app can.
- Choosing another server. The server row only shows the server, because the page talks only to the server whose site it came from, so an account made at the former address, `https://rukoo-account.bvdm.ai`, can't sign in from the browser at rukoo.io.
- The key for your booking page's handle. **Delete account** works in the browser, but it keeps no key, so a new account with your email address can't take the handle back. Delete the account on your computer if you want to keep the handle.

## Running your own server

The server is in [`server/`](../server). [Its README](../server/README.md) explains how to deploy it to your own Cloudflare account.

To use another server, open Settings → Rukoo account while signed out, choose the server row and enter its address. A fork can make its own server the default with `rukoo.accountServer` in `package.json`. During development, `RUKOO_ACCOUNT_SERVER` overrides both. Your own server serves booking pages too; [Booking page](booking.md#running-your-own) says where they live.

## How it works

[`server/PROTOCOL.md`](../server/PROTOCOL.md) describes the keys, the encryption and the server's API. In short:

- Your password goes through Argon2id on the device. One key derived from it proves the password to the server; another opens the account's data key.
- The data key encrypts every record with AES-256-GCM. A record's name on the server is an HMAC, so the server can't tell which category or email a record is about.
- The recovery key wraps the same data key, which is why it can set a new password without losing data.
- A booking page has a key pair of its own, kept in the account as a record. The server seals each guest's details to its public key; only your devices hold the private key.

On desktop the code is in `src/main/account/`, and the settings pages are in `src/renderer/rukoo-account.js`. Rukoo for Android has the same in `android/app/src/main/java/nl/bvdm/rukoo/account/` and `ui/settings/RukooAccountPages.kt` ([Rukoo for Android](android.md#rukoo-account)). `test/fixtures/account-vectors.json` holds fixed inputs and outputs that every Rukoo app must reproduce.

## Limits

- A device uses one server. Moving an account to another server means signing up there again. An account also belongs to the address of its server, so an operator who moves the server to a new address has to keep the old one working.
- Signing in on another device needs your password; there is no sign-in by QR code yet.
