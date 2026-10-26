# Rukoo account

A Rukoo account keeps Rukoo's own data the same on your devices: your inbox categories, the category each email got and the corrections you make. It doesn't hold your mail or your mail passwords. Those stay with your mail provider and on each device, as before.

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
| Whoever runs the server | Your email address, your device names and platforms, when each device last connected, and your records, encrypted |
| The hosting company (Cloudflare for the server in this repository) | The same, plus IP addresses in its request logs |
| Your mail providers | Nothing from the account |
| Anyone else | Nothing. Rukoo uses no analytics, advertising or tracking services |

The server sees how many records you have, how large they are and when they change. It can't see your categories, your corrections, which email went where or anything in your mail.

Cloudflare is a company in the United States. The server in this repository keeps its data in the EU by default (`JURISDICTION` in `server/wrangler.jsonc`), but as a US company Cloudflare falls under US law, also for data stored in the EU. The page in Settings shows where the server you use keeps its data.

**Export my data** saves everything in your account as a readable JSON file. **Delete account** removes the account and everything in it from the server at once. Your devices keep their own copies.

## Signing out

**Sign out** stops this computer from syncing. It keeps its own copy, so your categories keep working. Signing in again brings it back in step.

## The server Rukoo uses

Rukoo uses `https://rukoo-account.bvdm.ai` unless you choose another server. Bart van der Meeren, Rukoo's maintainer, runs it on Cloudflare with the data kept in the EU. Anyone can make an account there. Its privacy statement is at [rukoo-account.bvdm.ai/privacy](https://rukoo-account.bvdm.ai/privacy).

## Running your own server

The server is in [`server/`](../server). [Its README](../server/README.md) explains how to deploy it to your own Cloudflare account.

To use another server, open Settings → Rukoo account while signed out, choose the server row and enter its address. A fork can make its own server the default with `rukoo.accountServer` in `package.json`. During development, `RUKOO_ACCOUNT_SERVER` overrides both.

## How it works

[`server/PROTOCOL.md`](../server/PROTOCOL.md) describes the keys, the encryption and the server's API. In short:

- Your password goes through Argon2id on the device. One key derived from it proves the password to the server; another opens the account's data key.
- The data key encrypts every record with AES-256-GCM. A record's name on the server is an HMAC, so the server can't tell which category or email a record is about.
- The recovery key wraps the same data key, which is why it can set a new password without losing data.

On desktop the code is in `src/main/account/`, and the settings pages are in `src/renderer/rukoo-account.js`. `test/fixtures/account-vectors.json` holds fixed inputs and outputs that every Rukoo app must reproduce.

## Limits

- Rukoo for Android doesn't have the account yet.
- A device uses one server. Moving an account to another server means signing up there again.
- Signing in on another device needs your password; there is no sign-in by QR code yet.
