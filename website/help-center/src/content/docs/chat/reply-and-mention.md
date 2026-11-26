---
pageId: rk-reply-mention
slug: chat/reply-and-mention
title: "Reply in a thread and mention a teammate"
description: "Keep a reply connected to its message and notify a person from the mention picker."
docType: how-to
productArea: chat
appliesTo: ["Mail 2.4.0 desktop"]
reviewed: "2026-11-25"
behaviorChecked: null
---

Use a thread to reply to a particular message. Use a mention when a teammate needs to see your message.

## Reply in a thread

1. Open the channel or direct message in **Chat**.
2. Point at the message you want to answer and choose **Reply in thread**.
3. Type your reply in the thread's message box and press `Enter`.

The thread opens beside the conversation, or over it in a narrow window. In Mail 2.4.0, replies also appear in the conversation with a line identifying the message they answer. Select that line to open the thread.

## Mention a person

1. In your message, type `@`.
2. Pick the person from the list.
3. Finish your message and press `Enter`.

The picked person gets a notification and the message is marked for them. Typing an `@name` without selecting a person from the list does not send a mention notification.

## When the network drops

Messages sent offline wait for Rukoo to reconnect. If a message cannot be sent, it shows a reason and offers to try again or discard it. Unsent text stays as a draft in each conversation, including after a restart.

Source: [Messages, threads and mentions](https://github.com/MajesteitBart/rukoo/blob/v2.4.0/docs/chat.md), [Message actions](https://github.com/MajesteitBart/rukoo/blob/v2.4.0/src/i18n/en.js), Rukoo Mail 2.4.0.
