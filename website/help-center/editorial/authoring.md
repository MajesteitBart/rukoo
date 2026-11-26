# Choose the page the reader needs

Ask one question before writing: what is the reader trying to do now?

| Need | Format | Keep it focused |
| --- | --- | --- |
| Learn through a first success | Tutorial | Give one reliable route with prepared starting conditions and a visible result. |
| Finish a task they already understand | How-to | State prerequisites, steps and a success check. |
| Look up an exact fact | Reference | Use repeated fields, exact UI labels and platform/version boundaries. |
| Understand a model or tradeoff | Explanation | Connect ideas and reasons; link to task instructions. |

If a section changes the reader's job, split it and cross-link. Navigation follows product areas and user tasks. Diataxis describes the writing, not the top-level navigation. See https://diataxis.fr/compass/.

## Frontmatter

| Field | Rule |
| --- | --- |
| pageId | Permanent `rk-` ID, lowercase kebab case, unique in the registry. |
| slug | Permanent URL path without surrounding slashes. Home omits it. |
| title / description | Literal task/search wording and a one-sentence summary. |
| docType | tutorial, how-to, reference, explanation; landing only for home. |
| productArea | overview, mail, chat, account, calendar, agents, meetings or platforms. |
| appliesTo | Explicit released product/version/platform strings. |
| reviewed | YYYY-MM-DD of public source review. |
| behaviorChecked | YYYY-MM-DD of the released-build walkthrough, or null until it occurs. |

Use only these fields. Private issue URLs, release mapping, reviewer identities and held changes belong in the separate private source map. Add an exact public source link near the relevant instructions. A release guide can establish a rendering fixture; publishing new instructions requires the product review in review.md.

## Templates

Copy any one file from templates/ to src/content/docs/ and replace the values in double braces. Each file is a complete Markdown page. Register its page ID and URL. Keep titles and UI labels literal. Add the page to navigation only when it answers a distinct user need.

## External guides

Keep help-center articles first in navigation and on landing pages. Group supplemental GitHub guides under "External guides on GitHub" and explain that they leave the help center. Include "GitHub" in each outbound guide label, including sidebar labels. Let the reader choose whether to open a new tab. Preserve stable page IDs, URLs and existing section anchors when changing labels.
