# Translation catalog instructions

Read [the translation guide](../../docs/translations.md) before editing or adding a catalog.

- `en.js` is the English source of truth. Every entry has a stable semantic key, a `message`, and a `description` explaining the screen, control, purpose, and parameters. Include the renderer or main-process source location when useful.
- Other catalogs use the same keys, with translated strings or plural-form objects. Preserve named placeholders and include an `other` plural form. Add plural categories required by the registered locale.
- Search the key in `src/renderer` and `src/main` to understand where it is used. `data-i18n` and `data-i18n-*` attributes identify labels in persistent DOM controls.
- Translate whole sentences. Avoid constructing translated sentences from separately translated fragments.
- Adding a language requires its registry entry in `index.js` and its catalog script in both renderer HTML entry points. See the guide for the exact steps.
- Run `npm run i18n:check` after catalog changes. For behavior changes, run the relevant unit and Electron end-to-end tests; run both full suites when the change affects several parts of the app, as described in the root `AGENTS.md`.
