---
name: rukoo-design
description: Rukoo Mail's design language, based on Beautiful UI (beautifului.dev). Use when you add or change anything people see in src/renderer, such as CSS, components, the agent panel, settings, dialogs, menus, icons, motion or the labels on controls. Also use it when you port a Beautiful UI component, or review a UI diff or a screenshot of Rukoo.
---

# Rukoo design

Rukoo Mail should feel calm, dense and exact. People keep it open all day, so the interface stays out of the way: cool neutral surfaces, small type, hairline edges, and color only where something has a state. The content is the email and the agent's work. Everything else is chrome and should look like chrome.

The reference is [Beautiful UI](https://www.beautifului.dev), a set of components for agent interfaces by Shane Levine at the Turbo studio, under the MIT license. Rukoo's agent panel is a port of it: `src/renderer/agent/bui.js` and `src/renderer/agent.css`, scoped under `.bui`. The rest of the app lives in `src/renderer/styles.css`. It predates the port and follows most of the same rules, under its own token names.

Read a reference file when you need the detail:

- [references/tokens.md](references/tokens.md) has every token with its value in both themes, the type scale, radii, shadows, spacing and motion.
- [references/components.md](references/components.md) lists the components that already exist, in the app and in the agent panel, and which Beautiful UI patterns Rukoo has not ported yet.
- [references/beautiful-ui.md](references/beautiful-ui.md) covers Beautiful UI's stated principles, where its source is, and how to port a component to Rukoo.

## Color

Use tokens. Literal colors belong only in the token blocks at the top of `styles.css` and `agent.css`. Outside `.bui` the names are Rukoo's (`--text-2`, `--border`); inside `.bui` they are Beautiful UI's (`--ink-2`, `--line`), mapped onto Rukoo's values. Give a new token a value in both themes. Dark is the default on `:root`; light is `:root.light`.

Text has three levels. `--text` (`--ink`) is for content and names. `--text-2` (`--ink-2`) is for supporting text. `--text-3` (`--ink-3`) is for timestamps, counts, placeholders and captions. Beautiful UI's foundations page says "Secondary gets color, not weight". To make text quieter, move it down the ramp. Don't make it thinner, and don't set readable text below 11px. Only the letters inside monograms and badges go smaller.

Color is a condiment: dots, pills and one primary action. Green means done or ready. Orange means busy, pending or waiting for review. Red means failed or destructive. Accent blue marks unread mail, links, focus and selected text. A selected row is grey (`--sel`), and the active quick filter is filled with the primary ink. A status gets a tint background with saturated text. Neutral states, such as a proposed task, get the field color with a hairline instead. Large areas never get a semantic fill. The only other color in the app is content color: sender logos, monograms, the star, folder colors and the email itself.

Each surface has one filled button at most. The primary button is ink on canvas: near-black in light, near-white in dark (`--primary` with `--on-primary`, or `.bui-btn--primary`). It is not blue. The other actions are secondary (surface with a ring), ghost or quiet.

Borders are solid hairlines. In light mode, depth comes from layered shadows with single-digit opacities; Beautiful UI's foundations page sums them up as "Never harsh." In the agent panel, elevation is a ring plus a blur: `--shadow-hairline`, `--shadow-btn`, `--shadow-card`, `--shadow-raised` and `--shadow-overlay`. A surface that floats higher gets a wider blur. Dark mode needs darker shadows to show at all, from 20% on cards to 34% on menus, and a white ring at 10 to 15 percent that grows with the elevation. Use the elevation tokens rather than writing shadows by hand, so both themes stay right.

## Type

Inter is bundled as a variable font with optical sizes, and the app turns on `cv11` (the panel adds `ss01`). The base size is 13px. The scale is small and uses half pixels: 11, 11.5, 12, 12.5, 13, 13.5 and 14 for the interface. Titles are 16px in dialogs, 18px for the list and Settings pages, 20px for the reader subject and 26px on the setup screen.

Weight 500 is the normal emphasis: controls, card titles, names in chips and labels. Section headings in the agent panel, such as a plan's title or "Sources", use 600. The app's titles use 650 and unread senders use 700. Keep those where they are, but don't add new heavy weights.

Use `font-variant-numeric: tabular-nums` for times, counts, timers and sizes. The mono stack (JetBrains Mono, Cascadia Mono, Consolas) is only for code, commands and file names in tool chips. The panel tracks text at -0.01em; large headings go to -0.02em. Paragraphs and card bodies use `text-wrap: pretty`, headings `text-wrap: balance`.

Labels are in sentence case and short. Buttons are verbs that name the result: "Add tasks", "Save all", "Decline". Finished work is reported in the past tense with a number: "Thought for 4s", "4 tool calls".

## Shape and space

Spacing sits on a 4px grid, with 2px steps inside small controls. The common gaps are 4, 6, 8, 10 and 12. Cards pad 12px, header bars 10px by 12px, footers 10px.

Radii follow the role: 6px for chips and menu rows, 8px for controls (`--radius`), 10px for cards and menus, 12px for large panels (`--radius-lg`), 14px for windows and popovers. Pills use 9999px. That covers buttons in the agent panel, status pills, entity chips and segmented controls.

Corners nest concentrically: the inner radius is the outer radius minus the inset. A menu with a 10px radius and 4px padding has 6px rows. Beautiful UI's selection bar is a 36px pill holding 28px controls at a 4px inset, so the controls are 14px pills.

The usual heights are 32px for toolbar buttons and app buttons, 28px for small and icon buttons, 24px for chips, and 22px for the status pills in task rows and the smallest icon buttons.

A card holds its shape. Reserve room for counters, spinners and streamed text so the layout doesn't jump when the state changes. When a card's height depends on content, measure the content before showing it, so the card doesn't open at the wrong height and then snap.

## Motion

Motion explains a change, and then the interface rests. Things animate once, when they appear or change state. Only live work keeps moving: the shimmer label, the spinner, the pixel loader and the elapsed timer while the agent works.

- Hover and color changes take 100 to 150ms. In `.bui` use `var(--ease-default)` or `var(--ease-out)`. In `styles.css` the convention is `120ms ease`.
- Entries fade up 8px or pop in from scale 0.95, over 160 to 450ms with `var(--ease-out-strong)`. Small things take the short end. App menus and dialogs pop in over 120 to 140ms with `cubic-bezier(0.2, 0.8, 0.2, 1)`.
- Expanding and collapsing animate `grid-template-rows` from `0fr` to `1fr` together with opacity, over 300 to 400ms with `--ease-out-strong`.
- Items that appear together stagger by 80ms, through a `--i` custom property.
- A pressed button scales to 0.96, or 0.98 for large targets. The scale snaps without a transition.
- Exits are faster than entries, or have no animation.
- In a menu, one highlight glides between rows (`glideMenu` in `bui.js`) instead of each row lighting up on its own.
- Every animation has a reduced-motion fallback. `agent.css` covers everything under `.bui` with one rule. In `styles.css`, add a `@media (prefers-reduced-motion: reduce)` rule next to the animation.

For motion with several steps, write the timeline as a comment above the code, the way Beautiful UI's `TaskRows.tsx` does:

```css
/*    0ms  rows enter staggered (80ms apart)
 *  600ms  row 1 ring sweeps 0 → 66%
 * 1500ms  row 1 expands */
```

## Show the agent's work

Beautiful UI exists for this, and Rukoo's chat panel depends on it.

- While the agent works, show that it is working and for how long: a shimmer label with elapsed seconds.
- When it finishes, the trace collapses to one line in the past tense, such as "Thought for 4s", which opens again on a click.
- Tool calls are compact rows: an icon, the label, a count when the same call repeats ("Read a skill ×4") and a status mark that turns green or red. A row opens to show the details beside a hairline rail, in mono for commands.
- Anything that other people will see, or that changes another system, waits for an approval card. The question is the title, followed by a short body and the details as label and value rows. "Waiting for you" sits on the left; a secondary and a primary pill button sit on the right. After the decision the card shrinks to a done pill.
- Inline references stay inline. People, emails and agents are entity chips: a monogram and a name. For dates, counts and amounts, Beautiful UI uses a tinted value pill, which Rukoo hasn't ported yet.
- Sources are context cards that name the email or file they came from and open it.
- Answers stream in. The caret stays solid while text arrives and disappears when the answer is complete. Beautiful UI lets it blink after the end instead, and Rukoo's gallery check (`agent-gallery.js`) asserts that it is gone.

## Rukoo's own constraints

- Check every change in dark and in light.
- Check it in English and in Dutch. Every visible string goes through the catalogs in `src/i18n` (see `src/i18n/AGENTS.md`). Dutch labels are often longer, so let a row truncate with an ellipsis where it can't wrap, and give flex children `min-width: 0`.
- The window can be narrow, and zoom runs from 80 to 200 percent. The sidebar collapses to an icon rail, and the chat panel can narrow until the effort button shows only its dial. Avoid fixed widths around text.
- Every action has a keyboard path. `:focus-visible` draws a 2px `--focus` outline; don't remove it without drawing something in its place.
- Rukoo runs on touch screens, with swipe actions in the list. Anything revealed on hover needs another way in: a context menu, a shortcut, or a visible control on the selected row.
- `body` is `user-select: none`. Turn selection back on for text people copy: the email, addresses, agent answers and drafts.
- Everything clickable gets `cursor: pointer`. Disabled controls drop to 0.35 to 0.55 opacity and stop taking clicks.
- The email is someone else's design. Rukoo only adjusts it as `mailframe.js` does (readable width, dark-mode recoloring, clearing grey canvases). The chrome around it stays neutral, so a newsletter's brand colors don't clash with it.
- In the agent panel, agent and user text enters the DOM through `textContent`, using the `text` prop of `h()`. Never put that text in `innerHTML`. `svgFrom()` is for static icon markup only.

## How to build it

Rukoo uses plain CSS and vanilla ES modules, with no build step. Don't add Tailwind, React or CSS-in-JS. To use a Beautiful UI pattern, translate its Tailwind classes into CSS rules; `references/beautiful-ui.md` has the mapping.

App chrome goes into `styles.css`, in the section it belongs to (buttons, sidebar, list, reader, menus and dialogs, pages, composer, chat panel). Agent panel components go into `agent.css` under `.bui`, with `bui-` class names in the existing block and element style (`bui-task__pill--done`). Their DOM goes into `bui.js` as functions that return elements. Those functions take labels as parameters, and callers pass translated strings.

The two button families stay in their own areas. The app uses rounded rectangles (`.btn`, `.tbtn`, `.icon-btn`), while the agent panel uses pills (`.bui-btn`). Don't mix them on one surface.

The app's icons are in `icons.js`: a 24px grid with 1.6px round strokes. The panel draws its icons with `icon()` from `bui.js`. When an icon is missing, add it to the set you are using, in that set's style. Don't add an icon library.

## Workflow

1. Find the nearest existing pattern in `references/components.md`, then read its CSS and JS. If Beautiful UI has the pattern, read its source too.
2. Build with tokens and existing components. Add a token or a component only when nothing fits.
3. Look at the result in the running app with `npm start`, in both themes, both languages and a narrow window. Theme and language are in Settings, General.
4. For agent panel components, add every state to `src/renderer/agent-gallery.js`. Then run `node scripts/agent-gallery.js <outDir>`, which screenshots the gallery in both themes, and `node scripts/agent-gallery.js --check` for the behavior checks.
5. Run `npm run i18n:check` after label changes, and `npm test` plus `npm run test:e2e` after behavior changes.
6. If a screen shown in the README or `docs/` changed, run `npm run screenshots` to refresh `docs/screenshots`.

## Review checklist

- Only tokens, and every new token has a value in both themes.
- It looks right in dark and in light, and its rings and shadows show in both.
- Quieter text is quieter through the ink ramp, not through a thinner weight.
- The surface has one filled button at most.
- Status color appears only in dots, pills and icons, on tint backgrounds.
- Radii match their role and nest concentrically.
- Sizes are on the 4px grid, and heights come from the usual set.
- Motion is short, eases out strongly, plays once and has a reduced-motion fallback.
- The layout doesn't jump when the state changes.
- New strings have i18n keys with descriptions, and the Dutch labels fit.
- It works by keyboard with a visible focus ring, and hover-only controls have another way in.
- Agent and user text is set with `textContent`.
- New panel components are in the gallery, and documented screenshots are current.

## Known drift

The code doesn't follow these rules everywhere yet. Don't copy the exceptions into new work, and fix them when you work in that area anyway.

- The motion and radius tokens (`--ease-out-strong`, `--radius-card` and the rest) exist only under `.bui`. `styles.css` writes durations and curves inline and uses literal radii such as 5, 7 and 9px.
- The `pop`, `fade`, `slide`, `pulse`, `shimmer` and `spin` animations in `styles.css` have no reduced-motion fallback. Only the agent pane's entry has one.
- `.btn` uses weight 600, where Beautiful UI uses 500 for controls.
- Beautiful UI freezes transitions while the theme switches, so all colors flip in one repaint. Rukoo's `ui.js` toggles `.light` without that, so the 120ms color transitions run during the switch.
