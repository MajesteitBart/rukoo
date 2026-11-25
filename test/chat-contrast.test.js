'use strict';

// Contrast of team chat's text and of the filled danger button, measured from the tokens in styles.css. Text people
// read needs 4.5:1 (WCAG AA) in both themes. Android draws the same pairs (RukooColors.kt, TypeAndTokensTest).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

// The declarations of every block whose selector list is exactly `selector` (whitespace ignored), merged in order.
function rule(selector) {
  const want = selector.replace(/\s+/g, ' ').trim();
  const out = new Map();
  for (const [, sel, body] of css.matchAll(/(?<=^|[{}])\s*([^{}]+?)\s*\{([^{}]*)\}/g)) {
    if (sel.replace(/\s+/g, ' ').trim() !== want) continue;
    for (const [, name, value] of body.matchAll(/([\w-]+)\s*:\s*([^;]+);/g)) out.set(name, value.trim());
  }
  assert.ok(out.size, `No ${selector} rule`);
  return out;
}

const dark = rule(':root');
const light = rule(':root.light');
const themes = { dark, light: new Map([...dark, ...light]) };

// A color value with var() references resolved against a theme.
function resolve(value, theme) {
  const m = /^var\((--[\w-]+)\)$/.exec(value);
  return m ? resolve(theme.get(m[1]), theme) : value;
}

function luminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [n >> 16, (n >> 8) & 255, n & 255].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(a, b) {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

function atLeast(fg, bg, min, label) {
  const r = ratio(fg, bg);
  assert.ok(r >= min, `${label}: ${fg} on ${bg} is ${r.toFixed(2)}:1, under ${min}:1`);
}

test('the filled danger confirm keeps its label above 4.5:1 in both themes', () => {
  const button = rule('.dialog .buttons button.danger:last-child');
  for (const [name, theme] of Object.entries(themes)) {
    const fill = resolve(button.get('background'), theme);
    const label = resolve(button.get('color'), theme);
    atLeast(label, fill, 4.5, `${name} danger button`);
  }
  // Dark draws the dark ink on its lighter red; light keeps white.
  assert.equal(resolve(button.get('color'), themes.dark), '#15171c');
  assert.equal(resolve(button.get('color'), themes.light), '#ffffff');
});

test("chat's caption grey passes 4.5:1 on the panel, the sidebar and dialogs, and mail keeps --text-3", () => {
  for (const [name, theme] of Object.entries(themes)) {
    const grey = theme.get('--ch-text-3');
    for (const surface of ['--panel', '--bg', '--raised']) atLeast(grey, theme.get(surface), 4.5, `${name} chat caption on ${surface}`);
  }
  assert.equal(themes.light.get('--ch-text-3'), '#666b7a');
  assert.equal(themes.dark.get('--ch-text-3'), '#8a909e');
  // The override is scoped to chat's surfaces, its dialogs and its mention list included (they open on the body,
  // outside .chat); the token blocks keep mail's --text-3.
  assert.equal(rule('.chat, .ch-nav, .ch-ws-switch, .ch-form, .dialog.ch-dialog, .ch-suggest').get('--text-3'), 'var(--ch-text-3)');
  assert.equal(themes.light.get('--text-3'), '#868b98');
  assert.equal(themes.dark.get('--text-3'), '#7a808e');
});

test('information in chat is set in the supporting ink, not the caption grey', () => {
  const lines = {
    '.ch-meta': 'the header line with the DM host disclosure',
    '.ch-removed': '"Message removed"',
    '.ch-group': 'the role headings in Members',
    '.ch-row-quiet': 'Browse channels and the other sidebar actions',
    '.ch-form .field-help': '"You can\'t change this later." and the invitation line',
    '.ch-state': 'the unsent states, "Waits for a connection"',
    '.ch-intro-line': 'the host disclosure at the start of a DM',
  };
  for (const [selector, what] of Object.entries(lines)) assert.equal(rule(selector).get('color'), 'var(--text-2)', `${what} (${selector})`);
  for (const [name, theme] of Object.entries(themes)) {
    for (const surface of ['--panel', '--bg', '--raised', '--chip']) atLeast(theme.get('--text-2'), theme.get(surface), 4.5, `${name} text-2 on ${surface}`);
  }
});

test('text in a message bubble, a reaction chip and a file card reads at 4.5:1 in both themes', () => {
  for (const [name, theme] of Object.entries(themes)) {
    const bubble = theme.get('--ch-bubble');
    assert.ok(bubble, `${name} has --ch-bubble`);
    atLeast(theme.get('--text'), bubble, 4.5, `${name} message text in its bubble`);
    atLeast(theme.get('--text-2'), bubble, 4.5, `${name} quote and reaction count in a bubble`);
    atLeast(theme.get('--ch-text-3'), bubble, 4.5, `${name} file size on a file card`);
    atLeast(theme.get('--link'), bubble, 4.5, `${name} link in a bubble`);
    // The bubble shows on the panel and on the row under the pointer.
    assert.notEqual(bubble, theme.get('--ch-row-hover'));
    assert.notEqual(bubble, theme.get('--panel'));
  }
});

test("the count pill draws its digits in the panel color, readable on the accent in both themes", () => {
  const badge = rule('.ch-badge');
  assert.equal(badge.get('color'), 'var(--panel)');
  for (const [name, theme] of Object.entries(themes)) atLeast(theme.get('--panel'), theme.get('--accent'), 4.5, `${name} count pill`);
});
