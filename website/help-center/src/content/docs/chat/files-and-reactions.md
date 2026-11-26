---
pageId: "rk-chat-rich"
slug: "chat/files-and-reactions"
title: "Share files and react in chat"
description: "Attach files, format messages and use reactions."
docType: "how-to"
productArea: "chat"
appliesTo: ["Mail 2.4.0 desktop", "Browser chat with server file storage"]
reviewed: "2026-11-25"
behaviorChecked: null
---

Use desktop or browser chat for rich messages. Android 0.6.0 shows message text with Markdown markers and does not show files, reactions or link previews.

## Attach a file

The workspace server must support file storage. If the paperclip is absent, check this with its operator.

1. Use the paperclip below the message, drop a file onto the conversation or thread, or paste a copied file or screenshot.
2. Wait for each upload to finish. Use **Retry** on a failed file, or its cross to remove it.
3. Send the message. It can contain files without text.

The default is up to 10 files per message and 25 MiB per file; a server can set other limits. Uploaded draft files last an hour. After that, attach them again.

Click an image for a larger view and **Open** or **Save**. Other files appear as cards. In the browser, Open downloads a non-image file; saving follows browser download behavior.

## React or format text

Point at a message and choose **React**, then an emoji. Click an existing reaction to add or remove yours. Reactions do not notify people or count as unread.

The **Aa** button shows formatting tools. You can also type Markdown such as `**bold**`, `_italic_`, backticks for code, lists or quotes. The smiley below the input opens an emoji picker.

**Remove message** asks for confirmation, then replaces the message with "Message removed" for everyone. Its files, previews and reactions go with it. You can remove your own messages; channel managers can remove other people's messages in their channels.
