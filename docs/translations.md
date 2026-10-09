# Translating Rukoo Mail

English (`en`) is the default interface language. Dutch (`nl`) is also available. The language picker appears on the first-run provider screen and under Settings → General → Language. The preference is saved in `settings.json` and applies immediately to the main window and open compose windows.

## Find a label

Start in `src/i18n/en.js`. Each key contains a `message` and a `description`. The description identifies the screen or control and the source modules and functions that use it. Search the key to find every call site. The matching Dutch text is in `src/i18n/nl.js`.

Keys describe the screen, feature, and purpose, rather than the displayed wording. For example, `settings.general.theme` is the theme setting's title, while `settings.theme.system` is an option in its picker. Keep keys stable when changing the wording.

| Prefix | Location and context |
| --- | --- |
| `setup.*` | First run, provider tiles, credentials, and Google sign-in |
| `mailbox.folders.*` | Built-in folder names; reused where a folder is identified |
| `mailbox.sidebar.*`, `mailbox.layout.*` | Sidebar count badges and pane accessibility labels |
| `mailbox.search.*`, `mailbox.filters.*`, `mailbox.sort.*` | Search scopes, filter controls, and sorting |
| `mailbox.selection.*`, `mailbox.actions.*` | Message list selection and action controls |
| `mailbox.delete.*`, `mailbox.move.*`, `mailbox.undo.*` | Move/delete confirmations and notices |
| `reader.*` | Reading pane, recipient summary, headers, attachments, unsubscribe |
| `composer.*` | Inline and separate compose windows, formatting, drafts, quoted mail |
| `calendar.*` | The Mail and Calendar switch, the calendar view, its sidebar, the event card and the event dialog |
| `settings.*` | General settings, account settings, aliases, signatures, and About |
| `native.*` | Windows file pickers, notifications, taskbar badge, default filenames |
| `errors.*` | Application-owned account, server, Google, and mail errors |
| `common.*` | Shared actions, empty values, and relative dates |

Persistent controls also carry attributes such as `data-i18n="composer.actions.send"` and `data-i18n-title="composer.format.bold"`. Inspecting an element reveals its translation key. These attributes let language changes update an open composer without rebuilding its editor.

## Messages, placeholders, and plurals

The English source entry includes context:

```js
"setup.signIn.title": {
  "message": "Sign in to {provider}",
  "description": "Provider login form heading; provider is a provider display name."
}
```

A translation uses the same key and named placeholder:

```js
"setup.signIn.title": "Aanmelden bij {provider}"
```

Call it with `t('setup.signIn.title', { provider: name })`. Translate the whole sentence so another language can reorder its words. Preserve placeholder names; translate the words around them. Descriptions belong in the English catalog and are never displayed.

Messages that change with a count use plural forms:

```js
"native.notifications.newCount": {
  "one": "{count} new email",
  "other": "{count} new emails"
}
```

In the English catalog this object is the entry's `message`; in another catalog it is the entry itself. Selection uses `Intl.PluralRules` for the active language. Always supply `other`; include any additional categories your language needs, such as `zero`, `two`, `few`, or `many`. Every form preserves the named placeholders. Pass a numeric `count`.

`t()` returns plain text. Use `esc(t(...))` when placing it in an HTML template, and `textContent` or `setAttribute` when updating an existing element. Unknown keys and missing parameters throw errors so mistakes are visible. A missing language-specific entry falls back to English; release checks require complete catalogs.

## Add a language

1. Copy `src/i18n/nl.js` to the new language code, such as `src/i18n/de.js`. Keep the wrapper, change its registry code, and translate each value using the English descriptions. Do not translate keys or placeholders.
2. Register the catalog in `src/i18n/index.js`: add its `require()` to the main-process catalog map, and add an entry to `languages` with its code, native name, `Intl` locale, and text direction. Native names make the picker understandable in every language.
3. Add its catalog script to both `src/renderer/index.html` and `src/renderer/compose.html`, before `../i18n/index.js`. The sandbox loads local scripts and does not fetch translation files. The language pickers populate from the registry automatically.
4. Run `npm run i18n:check`, `npm test`, and `npm run test:e2e`. The catalog check covers registered languages, key completeness, descriptions, plural forms, placeholders, and source references. Add UI assertions for the new language in `test/e2e/i18n.spec.js`.
5. Inspect setup, settings, search, reading, composing, and native dialogs with the new language. Check long labels, dates, counts, and an open draft while switching languages. Right-to-left languages also need a layout review; setting the document direction alone does not prove layout support.

The runtime works in both CommonJS and the sandboxed browser without a framework or build step. Date, time, file size, sender sorting, and plural rules use the registered `Intl` locale.

## Add or change a label

Use an existing key when the meaning and context are shared. Give different meanings separate keys even when their English wording is identical. Add a description naming the screen, control, and purpose, and explain each parameter. Add the value to every registered catalog and keep it out of application code.

Render changing labels when they are needed. A module-level translated string becomes stale after a language switch; use a function or getter instead. For controls that stay mounted, add `data-i18n` or `data-i18n-{attribute}` and call `localize()`. Dynamic labels with parameters must be refreshed by their owning renderer.

Translate application UI, built-in folder display names, and application-owned errors. Email bodies, subjects, personal names, custom folder names, signatures, and server-provided diagnostics remain their original content. Folder roles and server paths stay stable; language changes never rename server folders. Quoted email headers use the compose language when created, and saved quote markers allow drafts to reopen in another language.
