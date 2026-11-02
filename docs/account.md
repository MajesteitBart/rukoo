# Rukoo account

A Rukoo account keeps Rukoo's own data the same on your devices: your inbox categories, the category each email got, the corrections you make and the settings of your [booking page](booking.md). A booking page needs an account. The account doesn't hold your mail or your mail passwords. Those stay with your mail provider and on each device, as before.

Rukoo encrypts the account's data on your device before it leaves. The key comes from your password and never reaches the server, so whoever runs the server can't read what you stored.

You find it in Settings → Rukoo account.

## Creating an account

1. Settings → Rukoo account shows which server the app uses, who runs it and where it keeps data. Check that first.
2. Choose **Create an account** and enter your email address and a password of at least 12 characters.
3. Rukoo shows a **recovery key** once: 32 letters and digits in groups of four. Save it in a password manager or write it down. It is the only way back in if you forget your password.

The computer then syncs. Data you already had on this computer goes into the account.

Your email address is your sign-in name. The server doesn't send you mail, so it doesn't check the address.

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

## Signing out

**Sign out** stops this computer from syncing. It keeps its own copy, so your categories keep working. Signing in again brings it back in step.

## The server Rukoo uses

Rukoo uses `https://rukoo.io` unless you choose another server. Bart van der Meeren, Rukoo's maintainer, runs it on Cloudflare with the data kept in the EU. The same address serves Rukoo's website; booking pages are at `meet.rukoo.io`. For now, making an account there needs an invite code from the maintainer. It holds up to 1,000 accounts of 32 MiB each. Its privacy statement is at [rukoo.io/privacy](https://rukoo.io/privacy).

Earlier versions of Rukoo used `https://rukoo-account.bvdm.ai`, which reaches the same server. An account belongs to the address it was made at, because the proof of your password includes the server's address. So a device signed in at the old address keeps using it after an update, until you sign out or delete the account. Then it uses rukoo.io. The same happens when another device ends its session, for example by deleting the account or changing the password. When you sign in again on that device, Rukoo tries the old address too, and stays there when your account still is.

An account made at the old address doesn't sign in at rukoo.io, and the server holds one account per email address for both addresses. To move yours, delete the account on a device that is still signed in at the old address, then create it again at rukoo.io. That device keeps its own copy and sends it to the new account. Deleting also turns your booking page off and deletes its bookings, so turn the page on again afterwards. The handle stays yours when you make the account again on the same computer: that computer keeps a key for it, because anyone could sign up with your email address in between. Your other devices are signed out and now use rukoo.io, so sign them in again with the new account. On any other device, sign in to the old account by choosing the server row while signed out and entering the old address.

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
