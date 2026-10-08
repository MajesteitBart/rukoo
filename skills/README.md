# Rukoo's skills

Each folder here is a skill in the [Agent Skills](https://agentskills.io) format: instructions for an email task that Rukoo offers to every agent in its chat panel. Rukoo ships this folder with the app.

A skill is a folder with a `SKILL.md` and, if it needs them, more files:

```
forward-to-accountant/
  SKILL.md
  references/
    accountant.md
```

`SKILL.md` starts with frontmatter that has a `name` and a `description`, followed by the instructions:

```markdown
---
name: forward-to-accountant
description: Forward an invoice or receipt to the user's accountant. Use when an email has a bill the accountant needs.
---

1. Check that the email has an invoice or receipt attached.
2. Write a short forward with write_draft, addressed as references/accountant.md says.
```

- `name` is the folder name: lowercase letters, digits and single hyphens, at most 64 characters.
- `description` says what the skill does and when to use it, in at most 1024 characters. Agents pick a skill by its description.
- Files next to `SKILL.md`, such as `scripts/` and `references/`, reach the agent through the `read_skill` tool. Keep them small text files.

You can add your own skills in `%APPDATA%\Rukoo Mail\skills`, in the same format. See [docs/agents.md](../docs/agents.md#skills) for how agents get skills, the limits, and how to install these skills into Hermes, Claude Code or Codex for use outside Rukoo.
