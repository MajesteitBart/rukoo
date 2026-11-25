---
pageId: rk-agent-queue
slug: agents/steer-and-queue
title: "Steer or queue a message while an agent works"
description: "Change direction now or save a follow-up for the next turn."
docType: how-to
productArea: agents
appliesTo: ["Mail 2.4.0 desktop"]
reviewed: "2026-11-25"
behaviorChecked: null
---

You can type in the desktop agent panel while the agent answers. Decide whether the message should change the current task or start the next one.

## Change direction now

Type the correction and press `Enter`, or use **Steer** beside **Stop**. For example: "Use the work account for this draft."

The agent reads the message before its next step when its connection supports steering. Claude Code and Codex support it. Hermes needs a server with steering support. OpenClaw queues the message because its connection cannot accept input during a turn. The panel explains when a message has to queue.

## Save a follow-up

Type the next task and press `Alt+Enter`, or choose **Queue** from the button's menu. The message waits until the current turn ends normally. You can use **Edit**, **Remove** or **Steer now** on a waiting message.

Quick actions, slash-command skills and messages naming an agent skill with `$` always queue while the agent works.

## After Stop or an error

Queued messages wait with **Not sent yet**. Use **Send now** when you want one to run. A new message you type goes first; the queue continues after that turn ends normally.

The queue stays with its chat while you open another email. After a restart, messages still wait for you to send one. A chat holds up to 20 waiting messages.

Android 0.6.0 has no Steer or Queue controls.

Read more: [Agents guide (GitHub)](https://github.com/MajesteitBart/rukoo/blob/v2.4.0/docs/agents.md).
