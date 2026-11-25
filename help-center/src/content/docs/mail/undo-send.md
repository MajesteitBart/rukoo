---
pageId: rk-undo-send
slug: mail/undo-send
title: "Take back an email before it sends"
description: "Use the sending notice to reopen a message during the Undo send delay."
docType: how-to
productArea: mail
appliesTo: ["Mail 2.4.0 desktop"]
reviewed: "2026-11-25"
behaviorChecked: null
---

Rukoo normally waits five seconds after you choose **Send**. During that wait, you can take the email back into the editor.

## Reopen the email

1. Choose **Send** in the message editor.
2. In the main window, find **Sending email…**.
3. Choose **Undo** before the wait ends. You can also press `Ctrl+Z`, or `Command+Z` on macOS.

The editor opens again with your recipients, subject, text and attachments. Edit the message and choose **Send** when it is ready.

## Change the delay

Open **Settings > General > Undo send**. Choose 5, 10, 20 or 30 seconds, or turn the delay off.

Undo send works while the email is waiting in Rukoo. Once it has gone to the mail server, the sending notice can no longer take it back.

## After an interrupted send

Rukoo keeps waiting emails across a crash. At the next start, they reopen unsent in compose windows. If a message had already started going to the server, check **Sent** before sending it again.

Source: [Writing and Undo send](https://github.com/MajesteitBart/rukoo/blob/v2.4.0/docs/mail.md), [Undo send labels](https://github.com/MajesteitBart/rukoo/blob/v2.4.0/src/i18n/en.js), Rukoo Mail 2.4.0.
