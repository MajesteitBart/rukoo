---
pageId: "rk-agent-context"
slug: "agents/files-and-emails"
title: "Give an agent files and other emails"
description: "Attach context to a chat and understand what the agent receives."
docType: "how-to"
productArea: "agents"
appliesTo: ["Mail 2.4.0 desktop"]
reviewed: "2026-11-25"
behaviorChecked: null
---

Open the agent panel for the email or meeting you want to discuss.

1. Use the paperclip to choose files, drop files on the panel, or paste a screenshot or copied files.
2. To add another email, drag it from the list onto the panel or choose **Add to chat** in its menu. The same action is available for checked emails.
3. Check the chips beside the email chip. Use a chip's cross to remove it before sending.
4. Write what you want the agent to do and send. The next message takes the chips with it, including when it starts a quick action or skill.

A message accepts up to 10 files and 10 emails. Programs, scripts, folders and files over 10 MB are refused. The chat's own email already goes along.

## What the agent receives

Text files contribute text. PDFs contribute their text layer; a scanned PDF may have none. Images can reach the agent as images. Claude Code and Codex can also use local copies. Remote agents use Rukoo's `read_chat_file` tool for files instead of paths on your computer. Added emails have IDs the agent reads through Rukoo's tools.

Files stay with the chat after restart. Deleting the chat deletes its file copies. Unsent files wait in memory for up to two hours.

A newer reply can offer **Continue the chat about the earlier message**. Picking that offer opens the previous chat and adds a **Newer message** chip for your next message. Check the chip so the agent gets the reply you mean.

For approvals before actions, see [Agent permission levels](/agents/permissions/).
