---
pageId: rk-mail-providers
slug: mail/providers
title: "Mail provider requirements"
description: "Check sign-in methods, app passwords and Microsoft account limits."
docType: reference
productArea: mail
appliesTo: ["Mail 2.4.0 desktop"]
reviewed: "2026-11-25"
behaviorChecked: null
---

Rukoo reads mail over IMAP and sends over SMTP. These requirements apply to Mail 2.4.0 desktop.

| Provider or method | Requirement |
| --- | --- |
| Gmail or Google Workspace with **Sign in with Google** | A Google OAuth client of type **Desktop app**. Released builds do not include one. Import your client with **Import Google OAuth client** on the setup screen. Browser sign-in follows. |
| Gmail with **Use an app password** | An app password from Google. This route connects mail; Google calendars need browser sign-in. |
| Yahoo | An app password from Yahoo. The setup form links to the page where you create it. |
| Outlook.com or Microsoft 365 | IMAP/SMTP password access must be enabled for the mailbox. Microsoft has disabled it for most Outlook.com and many Microsoft 365 mailboxes. Rukoo 2.4.0 does not implement Microsoft OAuth. |
| Exchange | The server must offer IMAP and SMTP. Exchange ActiveSync is unsupported. |
| Other providers | IMAP and SMTP server settings and a password or app password accepted by the provider. |

## Google OAuth client

The [tagged Google sign-in guide](https://github.com/MajesteitBart/rukoo/blob/v2.4.0/docs/mail.md#google-sign-in) describes the client file and environment-variable options. Keep client credentials in your own environment. An unverified Google consent screen can show a warning; a Google Workspace administrator may need to trust the app's mail scope.

## Three separate connections

Your mailbox supplies your email. A [Rukoo account](/account/sync/) syncs Rukoo settings. Team chat uses a workspace on the Rukoo account's server. Connecting one does not supply credentials for the others.

[Connect an IMAP mailbox](/mail/connect-account/) once its sign-in method is ready.

Source: [Mail accounts and Google sign-in](https://github.com/MajesteitBart/rukoo/blob/v2.4.0/docs/mail.md), [Setup labels](https://github.com/MajesteitBart/rukoo/blob/v2.4.0/src/i18n/en.js), Rukoo Mail 2.4.0.

For Google client import, follow [Set up Google sign-in](/mail/google-sign-in/). For a rejected connection, use [Fix a mailbox connection](/mail/connection-help/).
