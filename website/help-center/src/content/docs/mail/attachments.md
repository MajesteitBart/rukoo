---
pageId: rk-mail-attachments
slug: mail/attachments
title: "Add attachments and inline images"
description: "Attach a file, resize an image and check a received download."
docType: how-to
productArea: mail
appliesTo: ["Mail 2.4.0 desktop"]
reviewed: "2026-11-25"
behaviorChecked: null
---

These steps apply to the desktop composer and reading pane.

## Attach a file

1. Start a message or reply.
2. Select **Attach files** and choose the file, or drag it into the composer.
3. Check that it appears among the attachments before sending.

Rukoo also accepts a file dragged from a source that has not saved it as a normal disk file, such as an Outlook attachment or a file inside a ZIP, up to 50 MB. Your mail provider can impose a lower message-size limit.

## Resize an inline image

Choose **Insert image** to add an image to the message text, then select it. Drag a corner, or choose **Small**, **Best fit** or **Original size** from the bar below it. The size stays in the draft and goes out with the email. Use Undo if you want to restore the previous size.

Images inserted into the message or signature are sent as inline attachments. Images linked from the web stay web links.

## Save a received attachment

Open the email and select the attachment's save action. **Save all** saves the attachments together.

A large email can show its text and attachment names while the rest downloads. Opening or saving an attachment starts that download immediately. If it fails, use **Retry** under the attachments, or sync after reconnecting and try again.

For files given to an agent, use its panel's paperclip. That route has separate file-type and size limits described in the [agent guide on GitHub](https://github.com/MajesteitBart/rukoo/blob/v2.4.0/docs/agents.md#attach-files-and-other-emails).

Read more: [Mail guide (GitHub)](https://github.com/MajesteitBart/rukoo/blob/v2.4.0/docs/mail.md).
