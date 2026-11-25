// node --test scripts/markdown-keys.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { markdownKeys, shortcutKeys, shortcutNodes } from './markdown-keys.mjs';

test('shortcuts are recognised; file names, commands and typed characters are not', () => {
  for (const s of ['Ctrl+N', 'Ctrl+Shift+R', 'Command+Down', 'Control+Space', 'Alt+Enter', 'Shift+Esc', 'Enter', 'Tab', 'Esc', 'F5', 'X', 'A', 'Shift+click', 'Ctrl+click']) {
    assert.ok(shortcutKeys(s), s);
  }
  for (const s of ['@', '/', '$', '.deb', 'SKILL.md', 'PATH', 'name', 'openclaw mcp set', 'click', 'Ctrl+', '+N', 'ctrl+n', ' Enter', 'a', 'Ctrl+click+N']) {
    assert.equal(shortcutKeys(s), null, s);
  }
  assert.deepEqual(shortcutKeys('Ctrl+Shift+R'), ['Ctrl', 'Shift', 'R']);
});

test('one key is a <kbd>; a combination is keys joined by + in a span, with a click as plain text', () => {
  assert.deepEqual(shortcutNodes(['Enter']), { type: 'element', tagName: 'kbd', properties: {}, children: [{ type: 'text', value: 'Enter' }] });
  const combo = shortcutNodes(['Shift', 'click']);
  assert.equal(combo.tagName, 'span');
  assert.deepEqual(combo.properties, { className: ['keys'] });
  assert.deepEqual(combo.children.map((n) => n.tagName ?? n.value), ['kbd', '+', 'click']);
  assert.deepEqual(shortcutNodes(['Ctrl', 'Shift', 'R']).children.map((n) => n.tagName ?? n.value), ['kbd', '+', 'kbd', '+', 'kbd']);
});

test('the plugin replaces shortcut code outside <pre> and leaves the rest', () => {
  const plugin = markdownKeys();
  assert.deepEqual(plugin.element.filter, ['code']);
  const replaced = [];
  const ctx = (parentTag, content) => ({ parent: () => ({ tagName: parentTag }), textContent: () => content, replaceNode: (node, next) => replaced.push(next) });
  plugin.element.visit({}, ctx('p', 'Ctrl+K'));
  plugin.element.visit({}, ctx('p', 'SKILL.md'));
  plugin.element.visit({}, ctx('pre', 'Enter'));
  assert.equal(replaced.length, 1);
  assert.equal(replaced[0].tagName, 'span');
});
