---
# A fixture for the skill loader: comments, a folded description and fields Rukoo skips.
name: greet-sender
description: >
  Greet the sender of the open email by first name.
  Use when the user wants a friendly hello.
license: MIT
metadata:
  author: Rukoo tests
  version: "1.0"
allowed-tools:
  - Bash
---

Greet the sender warmly by their first name.

1. Call get_context to find the sender.
2. Use the tone in references/tone.md.
