---
pageId: rk-write-mail
slug: mail/write
title: "Write, reply to or forward an email"
description: "Choose the right sender and recipients, then send or save a draft."
docType: how-to
productArea: mail
appliesTo: ["Mail 2.4.0 desktop"]
reviewed: "2026-11-25"
behaviorChecked: null
---

Use a [connected mailbox](/mail/connect-account/). These steps use Rukoo's desktop keyboard scheme. You can choose a different scheme in **Settings** > **General** > **Keyboard shortcuts**.

## Start the message

- New mail: press `Ctrl+N`.
- Reply to the open email: press `Ctrl+R`.
- Reply to everyone: press `Ctrl+Shift+R`.
- Forward the open email: press `Ctrl+F`.

On macOS, use Command in place of Ctrl.

## Check and write

1. Check **From**, especially in **All accounts**. A new message there uses the default account.
2. Add the recipients. Open **Cc** or **Bcc** if needed. Drag a recipient between those fields to move them.
3. Enter the subject and message. Select text for formatting, or use `Ctrl+K` to add a link.
4. Check the earlier email behind the **···** pill in a reply. Use **Exclude from message** if it should be left out.
5. Check recipients and [attachments](/mail/attachments/) before selecting **Send**.

A short [Undo send window](/mail/undo-send/) starts after Send, unless you turned it off.

## Save and return later

Drafts save to the server's **Drafts** folder as you write. Use `Ctrl+S` to save. Opening another message leaves your draft in Drafts. Closing with unsaved changes asks whether to keep them.

## Mention someone in the text

Type `@` and their name, then select a suggestion with `Enter` or `Tab`. Rukoo inserts the mention and adds the person to **Cc** if they are not already a recipient. Check the recipient list before sending. Removing the mention from the text leaves the recipient in place.

A mention of someone in Bcc goes out as plain text so their address stays hidden. Set up your [signature](/mail/signatures/) for the sender account before writing regularly.

Read more: [Mail guide (GitHub)](https://github.com/MajesteitBart/rukoo/blob/v2.4.0/docs/mail.md).

## Choose the default sending account

A new message started from All accounts, the tray or an email link uses the default account. **Settings** marks the default beside the accounts and lets you change it. A message started from another account offers **Use as default account** beside **From**. Check From before sending, especially after switching accounts.

For links, select text and use `Ctrl+K` to insert or change the address. On macOS use Command. Pasting a web address over selected words links those words. Check the full host before following a link.
