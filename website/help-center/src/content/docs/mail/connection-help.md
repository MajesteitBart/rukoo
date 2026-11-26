---
pageId: "rk-mail-connection-help"
slug: "mail/connection-help"
title: "Fix a mailbox connection"
description: "Check provider authentication, sync and local credential storage."
docType: "how-to"
productArea: "mail"
appliesTo: ["Mail 2.4.0 desktop"]
reviewed: "2026-11-25"
behaviorChecked: null
---

Start with the affected account in the sidebar. Press `F5` to sync. With a manual sync schedule, Rukoo checks only when you ask.

## Check the provider's sign-in method

| Mailbox | Check |
| --- | --- |
| Gmail or Google Workspace | Use [Google sign-in](/mail/google-sign-in/) with an imported Desktop app client, or a Google app password for password-based IMAP. |
| Yahoo | Use an app password. Your usual account password will not work. |
| Outlook.com or Microsoft 365 | Most Outlook.com and many Microsoft 365 mailboxes require Microsoft OAuth. Mail 2.4.0 does not implement that mail sign-in route. Ask your administrator whether this mailbox still allows password-based IMAP and SMTP. |
| Exchange | The server must offer IMAP and SMTP. Check the hostnames, ports and username with its administrator. |
| Other IMAP providers | Compare the settings with the provider's current IMAP and SMTP instructions. [Connect an IMAP mailbox](/mail/connect-account/) shows Rukoo's fields. |

If receiving works but sending fails, check SMTP settings separately from IMAP. A successful connection should load new mail and send a message to a test address you control.

## Rukoo cannot save the password

On macOS, unlock your login Keychain. On Linux, install and unlock GNOME Keyring or KWallet in your desktop session. Rukoo requires that storage to save real account credentials. Sign in again on a new operating system instead of copying encrypted credential files.

## Mail still does not arrive

Check the folder, the account and [category visibility](/mail/category-switches/). Search can find older messages that are still on the server.

For a sync failure, read `data/logs/rukoo.log` under [your profile](/start/platform-help/). Its sync entries include an account ID prefix, timings and short errors such as `auth` or `timeout`. Include the error, app version, operating system and what you tried when reporting the problem. Review any log before sharing it.
