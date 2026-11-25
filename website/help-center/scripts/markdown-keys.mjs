// The pages write keyboard shortcuts as inline code (`Ctrl+Shift+R`). This Sätteri hast plugin renders those as keys,
// one <kbd> per key, so they look like the keycaps on the rest of rukoo.io. Other inline code, such as file names,
// commands and characters you type (`@`, `/`), stays code.
const MODIFIER = /^(?:Ctrl|Control|Command|Cmd|Shift|Alt|Option)$/;
const NAMED = /^(?:Enter|Return|Esc|Escape|Tab|Space|Up|Down|Left|Right|Delete|Backspace|Home|End|F(?:[1-9]|1[0-2]))$/;
const KEY = (key) => MODIFIER.test(key) || NAMED.test(key) || /^[A-Z0-9]$/.test(key);

/**
 * The keys of a shortcut, or null when the text isn't one. A single key is a named key or a letter (`Enter`, `F5`,
 * `X`); a bare digit could be a value. A combination starts with a modifier (`Ctrl+Shift+R`) and may end in a mouse
 * click (`Shift+click`).
 */
export function shortcutKeys(text) {
  if (typeof text !== 'string' || text !== text.trim() || !text) return null;
  const parts = text.split('+');
  if (parts.length === 1) return NAMED.test(text) || /^[A-Z]$/.test(text) ? parts : null;
  const keys = parts.at(-1) === 'click' ? parts.slice(0, -1) : parts;
  return MODIFIER.test(keys[0]) && keys.every(KEY) ? parts : null;
}

const text = (value) => ({ type: 'text', value });
const kbd = (key) => ({ type: 'element', tagName: 'kbd', properties: {}, children: [text(key)] });

/** The elements that replace a shortcut's <code>: one <kbd>, or keys joined by + in a span that doesn't wrap. */
export function shortcutNodes(parts) {
  if (parts.length === 1) return kbd(parts[0]);
  const children = parts.flatMap((part, i) => [...(i ? [text('+')] : []), part === 'click' ? text('click') : kbd(part)]);
  return { type: 'element', tagName: 'span', properties: { className: ['keys'] }, children };
}

export function markdownKeys() {
  return {
    name: 'rukoo-help-keys',
    element: {
      filter: ['code'],
      visit(node, ctx) {
        if (ctx.parent(node)?.tagName === 'pre') return;
        const parts = shortcutKeys(ctx.textContent(node));
        if (parts) ctx.replaceNode(node, shortcutNodes(parts));
      },
    },
  };
}
