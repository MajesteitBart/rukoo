# Rukoo components

Reuse these before you build something new. The class names and functions exist in the code today. Read the CSS and JS before you use one, because the details matter more than this summary.

## App chrome (`src/renderer/styles.css`, helpers in `src/renderer/ui.js`)

App code builds HTML in template strings. Every value in them goes through `esc()` from `ui.js`.

### Buttons

| Class | Size | Use |
| --- | --- | --- |
| `.icon-btn` | 32px, 18px icon at stroke 1.7 | Icon-only toolbar actions. `--text-2`, turning `--text` on hover. `.on` marks a toggled state. |
| `.icon-btn.sm` | 28px, 16px icon | Denser toolbars |
| `.icon-btn.xs` | 22px, 14px icon, 6px radius | Inside rows and chips |
| `.tbtn` | 32px, weight 500 | Toolbar button with a label, such as Reply. `.primary` fills it, `.danger` colors it red. |
| `.btn` | 32px, weight 600, `--chip` fill | Buttons in dialogs, pages and setup. `.primary` is the filled action, `.secondary` is a panel with `--shadow-sm`, `.sm` is 30px. |
| `.link-btn` | Inline | Actions that read as links, such as "Save all" above attachments |
| `.chip-btn` | 24px, 12px radius | Small pill actions, such as Unsubscribe next to the date in the reader |

### Lists, avatars and pills

- `.avatar` is a 32px circle with initials. Its color comes from `--h`, set by `avatar()` in `ui.js` through `hue()`: one hue per address, with fixed saturation and lightness per theme. `.avatar.logo` puts a company's own icon on white, the background it was designed for. `.avatar.lg` is 38px. Folder dots (`.ic.fdot`) and the panel's monograms take their color from `--h` the same way. Generate a color for a new kind of item like this, never from a hand-picked palette.
- `.pill` is the small counter pill, such as "+3" on a folded stack. `.pill.vip` marks VIPs.
- `.check` is the list checkbox. `.draft-tag` marks drafts.
- `.item` is a list row. `.item.selected` uses `--sel`, and `.unread-dot` uses `--accent`.
- `.filters` and `.filter` are the quick filters above the list. `.filter.active` is filled with `--primary`, and `.filter .n` is the count.
- `.group-head` is the sticky "Today" or "Yesterday" label.

### Menus, dialogs and notices

- `showMenu(anchor, items, opts)` in `ui.js` opens a `.menu`: 10px radius, 4px padding, 32px rows with 6px corners, `--raised` with `--shadow`, popping in over 120ms. `.menu-heading` and `.menu-sep` group the items.
- `dialog({ title, body, buttons, render })`, `confirmDialog()` and `choiceDialog()` in `ui.js` open a `.dialog` over a `.scrim`. `promptDialog()` in `settings.js` asks for text. Use these instead of building a new modal.
- `toast(message, { action, ms })` in `ui.js` shows the notice at the bottom, with an optional action such as Undo. It stays 2.6s, or 8s with an action. The toast is dark in both themes on purpose, like Beautiful UI's tooltips, so it uses literal colors.

### Pages and forms (Settings, setup)

- `.page`, `.page-bar`, `.page-inner` and `.page-scroll` are the full-window pages.
- `.row` is a settings row: a title on the left, its value or action on the right. This is Beautiful UI's text row.
- `.switch` (with `.on`) is the toggle, `.radio` and `.radio-row` are single choices, and `.field` and `.form` hold inputs.
- `.card`, `.note` and `.error` group content and messages on a page. `.provider` and `.provider-grid` are the account provider picker in setup.
- `.spinner` is the app's loading spinner.

### Icons

`icons.js` exports the app's icons: a 24px grid with 1.6px round strokes, drawn in `currentColor`. `icon(name)` in `ui.js` returns one as markup. Toolbar buttons draw them at 17 or 18px with stroke 1.7.

## Agent panel (`src/renderer/agent/bui.js`, `src/renderer/agent.css`)

`bui.js` builds the DOM with `h(tag, props, ...children)`. Strings become text nodes, and the `text` prop sets `textContent`. Every label is a parameter; `panel.js` passes the translated strings. The panel's own layout lives in `panel.js` and in `styles.css` under "chat panel".

| Function | Beautiful UI original | What it is |
| --- | --- | --- |
| `icon(name, size, stroke)` | Its icon set | Panel icons on a 24px grid. Unknown names fall back to the wrench. `'spinner'` returns `.bui-spin`. |
| `gauge(level)` | Not in Beautiful UI | The effort dial: the needle runs from 0 on the left to 1 on the right |
| `monogram({ label, hue, src, agent })` | `Monogram` | A 16px disc with an initial or a logo |
| `button({ label, kind, size, icon })` | `Button` | Pill button. Kinds: `primary`, `secondary`, `ghost`, `accent`, `quiet`, plus Rukoo's `danger` and `link`. Sizes: `xs` (28px), `sm` (27px), `md`. |
| `entityChip({ label, sub, monogram, onRemove })` | `EntityChip` | A monogram and a name in a field pill, for people, emails and agents. With `onRemove` it gets an ×. |
| `addChip({ label, onClick })` | Not in Beautiful UI | A dashed entity chip that puts something back, such as "Add this email" |
| `shimmer(text)` | `Shimmer` | The label that shows work in progress |
| `loadingState({ label })` | `LoadingState` | The pixel-grid loader with elapsed time |
| `streamText({ interim })` | `StreamText`, `StreamingText` | Streamed markdown answer with the caret |
| `thinking({ labels, startedAt })` | `ThinkingState` | The collapsible trace: "Thinking" with seconds, then a summary |
| `toolChip(item)`, `toolGroup()` | `ToolChips` | One tool call per row. Repeated calls fold into one chip ("Read a skill ×4"). |
| `userBubble({ text, action })` | `ChatComposer` bubble | The user's message, right-aligned on a soft block |
| `noticeLine(item, { onUndo })` | Not in Beautiful UI | A quiet line in the transcript for what happened, such as a mail action, with Undo |
| `approvalCard(item, { labels, onChoose })` | `ApprovalCard` | The approval for a proposal, a mail action or the agent's own permission request. Fields are label and value rows. It collapses into `.bui-donepill` after the decision. |
| `taskRows(item, { labels, onOpen })` | `TaskRows` | The plan. Each row shows a numbered ring, which spins while the step runs, or a check, cross or minus badge once it ends, plus a status pill (done, failed, proposed, skipped). Rows expand to their details. |
| `contextCards(item, { onOpen })` | `ContextCards` | Sources: a title, a short excerpt and the email or file it came from |
| `recommendationCard({ eyebrow, title, body, actions })` | `RecommendationCard` | The empty chat: the agent's name as the eyebrow, what it can do for the open email, or how to set it up |
| `draftCard(item, { onAction })` | Not in Beautiful UI | The reply the agent wrote into the composer, with Undo while the composer still holds it |
| `suggestionChips(list, onPick)` | `StreamingText` follow-ups | The quick actions under the empty chat, such as "Draft a reply" |
| `offerRow({ label, sub, monogram, onClick })` | Not in Beautiful UI | A quiet row offering one thing, such as continuing an earlier chat |
| `glideMenu({ items, anchor, onPick, align })` | `GlideMenu` | A menu on `body` with one highlight that glides between rows |
| `chatComposer(opts, handlers)` | `PromptBar`, `ChatComposer` | The input with the email chip, `/` commands, and the agent, model and effort pickers |

Status in the panel uses `.bui-dot` (6px; `--ready` green, `--busy` orange, `--offline` red), `.bui-badge` (`--green`, `--red`, `--grey`) and `.bui-task__pill` (`--done`, `--failed`, `--proposed`, `--skipped`).

`src/renderer/agent-gallery.html` shows every component in every state, side by side in panel-wide columns. `node scripts/agent-gallery.js <outDir>` screenshots it in both themes, and `--check` runs its behavior checks.

## Beautiful UI patterns Rukoo hasn't ported

These exist in Beautiful UI and fit places where Rukoo may need them. Port one when a feature calls for it, following [beautiful-ui.md](beautiful-ui.md), and add it to the table above.

| Pattern | Where it could fit in Rukoo |
| --- | --- |
| `StatusPill`: a 24px pill with a 6px dot | Account or agent status in Settings, sync state |
| `ValuePill`: a tinted inline value | Dates, counts and amounts inside agent text and approval cards |
| `Chip`: a mono token | Message-IDs, header names, file names in agent text |
| `SegmentedControl`: equal segments with a sliding thumb | Two to four exclusive options in Settings, such as theme or density |
| `ProgressRing`: a 2px ring that fills from 0 to 100% around its content | Sync or download progress. The task rows already have a numbered ring, but it doesn't fill. |
| `SidebarNav`: rail collapse that keeps icons aligned, a gliding highlight | The folder sidebar and its icon rail |
| `SearchList`: command search with live filtering and an empty state | A command palette or the search suggestions |
| `SelectionActions`: AI actions under selected text | The composer's formatting bar, with "Improve" or "Shorten" handed to the agent |
| `CodeBlock`: line numbers, unified diff, copy | Code or headers in agent answers |
| `AgentScreen`: a live view of the agent's screen | Skills that drive a browser, such as unsubscribing through a page |
| `DiffTable`: proposed edits shown row by row | Bulk changes the agent proposes, such as moving or labeling many emails |

Beautiful UI's `RecordsTable`, `FilterTable`, `Flowchart`, `InsightCards` and `FineTuneCard` have no place in Rukoo yet. One detail still applies: `RecordsTable` derives each tag's background, text and border from one base hue with `color-mix()` against the theme tokens. Use that if folders or labels ever need tinted pills instead of dots.
