# Rukoo design tokens

These are the values in the code as of October 2026. When this file and the CSS disagree, the CSS wins: fix this file.

## App tokens (`src/renderer/styles.css`)

Dark is the default on `:root`. Light overrides it on `:root.light`, which `ui.js` sets from the theme setting.

| Token | Dark | Light | Use |
| --- | --- | --- | --- |
| `--bg` | `#141519` | `#f3f4f6` | Window background behind the panes |
| `--panel` | `#1b1c21` | `#ffffff` | Panes: list, reader, chat panel |
| `--panel-2` | `#212228` | `#f8f9fb` | Secondary panel fill, `kbd` |
| `--raised` | `#25262d` | `#ffffff` | Menus, dialogs, popovers |
| `--border` | `#2a2c33` | `#e6e8ec` | Hairlines between and inside panes |
| `--border-strong` | `#3a3d47` | `#d2d6de` | Checkbox, radio and select borders, the off switch, quote bars |
| `--hover` | `#23252c` | `#f2f3f6` | Hover background |
| `--active` | `#2c2f38` | `#ebedf1` | Pressed and toggled background |
| `--sel` | `#2c2f38` | `#ebedf1` | Selected row in the list |
| `--sel-strong` | `#353946` | `#e1e4ea` | Defined, not used yet |
| `--chip` | `#2a2c34` | `#eff1f4` | Chip and field fill, default `.btn` |
| `--text` | `#ecedf1` | `#16181d` | Content, names, titles |
| `--text-2` | `#a7adba` | `#565c69` | Supporting text, icons in toolbars |
| `--text-3` | `#7a808e` | `#868b98` | Metadata, timestamps, counts, placeholders |
| `--accent` | `#7aa5f5` | `#2f66d6` | Unread dot, unread stack count, accent marks |
| `--accent-soft` | blue at 15% | blue at 10% | Accent tint behind selected or active items |
| `--link` | `#8ab0ff` | `#2f63c8` | Links and link buttons |
| `--primary` | `#e9ecf5` | `#1c2340` | The one filled button, the active quick filter |
| `--on-primary` | `#15171c` | `#ffffff` | Text on `--primary` |
| `--danger` | `#ff6b6b` | `#d23b3b` | Destructive actions and errors |
| `--star` | `#ffc23d` | `#e8a200` | The star |
| `--ok` | `#4ccf8b` | `#1f9d5c` | Success, connected |
| `--warn` | `#f5b84c` | `#c27c00` | Warnings |
| `--focus` | `#7aa5f5` | `#2f66d6` | Focus outline |
| `--shadow` | deep, 45% black | soft, 14% navy | Menus and dialogs |
| `--shadow-sm` | 1px drop plus white ring at 4% | 1px drop plus navy ring at 6% | Secondary buttons, small cards |
| `--radius` | `8px` | | Controls |
| `--radius-lg` | `12px` | | Large panels |
| `--font` | Inter, then Segoe UI Variable Text | | Everything |
| `--font-display` | Inter, then Segoe UI Variable Display | | Large titles |
| `--sidebar-w` | `236px` | | Sidebar width |
| `--list-w` | `400px` | | Default list width (the user can resize it) |

## Agent panel tokens (`src/renderer/agent.css`, under `.bui`)

The panel uses Beautiful UI's token names. Most of them point at the app tokens, so the panel follows Rukoo's palette instead of Beautiful UI's. `--hover` and `--accent` keep Rukoo's values unchanged.

| `.bui` token | Value | Use |
| --- | --- | --- |
| `--page`, `--canvas` | `var(--panel)` | Panel background; text color on primary buttons |
| `--surface` | `var(--raised)` | Cards, secondary buttons, menus |
| `--inset` | `var(--panel-2)` | Recessed areas, hover on secondary buttons |
| `--hover-2` | `var(--active)` | Ghost buttons, stronger hover |
| `--field` | `var(--chip)` | Inputs, entity chips, neutral pills |
| `--ink`, `--ink-2`, `--ink-3` | `var(--text)`, `var(--text-2)`, `var(--text-3)` | The three text levels |
| `--line`, `--line-strong` | `var(--border)`, `var(--border-strong)` | Hairlines |
| `--line-soft` | `--border` at 60% | The faintest dividers |
| `--accent-ink` | `var(--link)` | Accent text, links, hover on accent buttons |
| `--accent-tint` | `var(--accent-soft)` | Accent backgrounds, text selection |
| `--green`, `--orange`, `--red` | Beautiful UI's oklch values per theme | Status: done, busy, failed |
| `--green-tint`, `--orange-tint`, `--red-tint` | 14% alpha in dark, pale solid in light | Status pill backgrounds |
| `--font-mono` | JetBrains Mono, Cascadia Mono, Consolas | Code, commands, file names |

Status pills (`.bui-task__pill`, `.bui-donepill`) put text in the status color on its tint, with no ring: `background: var(--green-tint); color: var(--green)`. Neutral states use `--field` without a ring: a skipped task has `--ink-3` text, a grey done pill `--ink-2`. A proposed task, which still waits for you, is the exception: `--ink-2` text with `--shadow-hairline`. The danger button is the one place a ring of the status color appears: `color-mix(in oklch, var(--red) 28%, transparent)`. Beautiful UI's colored `ValuePill` tones use that same 28% ring, while its neutral tone uses `--shadow-hairline`.

Base text under `.bui` is 13px, line height 1.5, letter-spacing -0.01em, with `font-feature-settings: 'cv11', 'ss01'`.

## Type scale

The app's base is 13px with line height 1.4. Beautiful UI uses the same small sizes with half-pixel steps. On its gallery page the most used sizes, in order, are 13, 12.5, 12, 11.5 and 11px.

| Size | Weight | Where Rukoo uses it |
| --- | --- | --- |
| 26px | 650 | Setup title |
| 20px | 650 | Reader subject, login heading |
| 18px | 650 | List title ("Inbox"), page titles in Settings |
| 16px | 650 | Dialog titles |
| 14px | 500 to 650 | Composer title, empty-state titles, `.bui-btn--md` |
| 13.5px | 400 to 650 | Sender name in the reader, form fields, settings rows |
| 13px | 400 to 500 | Body, menus, buttons, chat text |
| 12.5px | 400 to 500 | Labels, filters, attachment chips, compact list lines |
| 12px | 500 | Chips, counts, dates in the reader, captions, `.bui-btn--xs` |
| 11.5px | 400 to 500 | Metadata, group heads ("Today"), section labels, menu headings |
| 11px | 500 | `kbd`, filter counts, small pills |

Weights: 400 for running text, 500 for controls, card titles and emphasis, 600 for section headings in the agent panel (a plan's title, "Sources") and the dialog and page buttons (`.btn`), 650 for the app's titles, 700 for unread senders only.

## Spacing

Spacing is a 4px grid: 4, 8, 12, 16, 24 and 32px, with 2px half steps (2, 6, 10) inside small controls. Tailwind's spacing unit in Beautiful UI is 4px, so `gap-1.5` is 6px and `h-7` is 28px.

| Element | Spacing |
| --- | --- |
| Card body | 12px padding |
| Card header bar | 10px by 12px |
| Card footer | 10px |
| Table cell | 10px by 12px |
| Menu | 4px padding, 32px rows with 0 10px 0 8px padding |
| Icon button | 28px square with an 8px radius (`.icon-btn.sm`, Beautiful UI's `primitive-icon-button`) |

## Control heights

| Height | Controls |
| --- | --- |
| 32px | `.icon-btn`, `.tbtn`, `.btn`, menu rows |
| 30px | `.btn.sm` |
| 28px | `.icon-btn.sm`, `.bui-btn--xs` |
| 27px | `.bui-btn--sm`, Beautiful UI's standard action pill |
| 24px | `.chip-btn`; Beautiful UI's `StatusPill` |
| 22px | `.icon-btn.xs`, `.bui-task__pill` |

`.bui-btn--md` has no fixed height: 9px by 16px padding at 14px with line height 1, so the top and bottom space stay equal.

## Radii

| Radius | Role | Token |
| --- | --- | --- |
| 6px | Chips, menu rows, `.icon-btn.xs` | `--radius-chip` in `.bui` |
| 8px | Controls: buttons, inputs, icon buttons | `--radius`; `--radius-control` in `.bui` |
| 10px | Cards and menus | `--radius-card` in `.bui` |
| 12px | Large panels | `--radius-lg` |
| 14px | Windows and popovers | `--radius-window` in `.bui` |
| 9999px | Pills: panel buttons, status pills, entity chips, segmented controls, toggles | |
| 50% | Avatars, dots | |

Nested shapes take the outer radius minus the inset. Odd values such as 5, 7 and 9px come from that rule and are fine there. Elsewhere, use the table.

## Shadows

In the app, `--shadow-sm` is for secondary buttons and small cards, and `--shadow` is for menus and dialogs.

In the panel, every elevation is a 1px ring plus a blur:

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--shadow-hairline` | 1px `--line` ring | same | Entity chips, counts, suggestion chips, the offer row, the proposed-task pill, code blocks |
| `--shadow-btn` | `--line-strong` ring with a 4px blur at 4% | white ring at 10%, 1px drop with a 2px blur at 30% | Secondary buttons, tool rows, source chips |
| `--shadow-card` | `--line` ring with six layered blurs from 1 to 47px, each at 1 to 3% | white ring at 11%, two short drops at 20% | Approval, task, source, recommendation and draft cards; the composer box |
| `--shadow-raised` | `--line` ring with a mid blur stack | white ring at 13%, 10px blur at 22% | Panel menus (`.bui-menu`) and the composer's `/` menu |
| `--shadow-overlay` | `--line` ring with the large blur stack (up to 50px) | white ring at 15%, 28px blur at 34% | Defined, not used yet. Beautiful UI uses it for popovers and large overlays. |
| `--shadow-inset-field` | 2px inner shadow at 12% | at 40% | Recessed inputs |

Filled buttons (primary, accent) also get a 1px inner highlight at the top: `inset 0 1px 0 rgba(255, 255, 255, 0.14)`.

## Motion

| Token (`.bui` only) | Curve | Use |
| --- | --- | --- |
| `--ease-out-strong` | `cubic-bezier(0.23, 1, 0.32, 1)` | Entries, expanding, gliding highlights, progress |
| `--ease-in-out-strong` | `cubic-bezier(0.77, 0, 0.175, 1)` | Movement from one place to another |
| `--ease-link` | `cubic-bezier(0.16, 1, 0.3, 1)` | Underlines that draw in |
| `--ease-default` | `cubic-bezier(0.4, 0, 0.2, 1)` | Color and background changes |
| `--ease-out` | `cubic-bezier(0, 0, 0.2, 1)` | Fades, button feedback |

Beautiful UI's foundation file explains why it defines these: "strong curves; built-ins are too weak". `styles.css` has no motion tokens. It uses `120ms ease` for hover and `cubic-bezier(0.2, 0.8, 0.2, 1)` for menus, dialogs and pages.

| What | Duration | Curve |
| --- | --- | --- |
| Hover, color, background | 100 to 150ms | `--ease-default`, or `ease` in `styles.css` |
| Button press | Snaps to `scale: 0.96` | none |
| Menu or dialog entry | 120 to 140ms | `cubic-bezier(0.2, 0.8, 0.2, 1)` |
| Popover entry (`bui-pop-in`, from scale 0.95) | 160 to 260ms | `--ease-out-strong` |
| Card or row entry (`bui-fade-up`, 8px) | 200 to 450ms | `--ease-out-strong` |
| Gliding highlight | 220ms for position, 150ms for opacity | `--ease-out-strong` |
| Expand and collapse (`grid-template-rows`) | 300 to 400ms | `--ease-out-strong` |
| Progress ring sweep | 400ms | `--ease-out-strong` |
| Stagger between items | 80ms | |
| Shimmer label | 1.8s loop | linear |
| Spinner | 700ms loop | linear |

Keyframes in `agent.css`: `bui-shimmer-text`, `bui-fade-up`, `bui-fade-in`, `bui-pop-in`, `bui-spin`, `bui-caret-blink`, `bui-pixel-on`, `bui-eq-bounce`. Keyframes in `styles.css`: `pulse`, `shimmer`, `pop`, `fade`, `slide`, `spin`, `agent-in`. Reuse them before adding a new one.

## Layers

| z-index | Element |
| --- | --- |
| 100 | Title bar |
| 90 | Agent panel menus (`.bui-menu`) |
| 80 | App menus (`.menu`) |
| 70 | Dialog scrim |
| 50 | Drop target over the composer |
| 40 | Full pages (Settings, setup) |
| 30 | Agent pane |
| 20 | Formatting bar above selected text in the composer |
| 2 to 10 | Sticky group heads, the agent divider, suggestions, menu rows above the glide highlight |

Put a new layer into this order instead of picking a large number.
