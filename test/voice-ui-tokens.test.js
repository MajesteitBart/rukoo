'use strict';

// Rukoo Voice can't load Rukoo's CSS at run time, so voice/ui/tokens.css copies Rukoo's token values. This test
// fails when one of the copies drifts from src/renderer/styles.css or src/renderer/agent.css.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

// Tokens the pill adds on top of Rukoo's. Everything else in tokens.css must be a copy.
const VOICE_ONLY = new Set(['--pill-h', '--pill-bg', '--pill-shadow']);

// The custom properties declared directly in the first block whose selector is exactly `selector`.
function block(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|})\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  assert.ok(match, `No ${selector} block`);
  const tokens = new Map();
  for (const [, name, value] of match[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) tokens.set(name, value.replace(/\s+/g, ' ').trim());
  return tokens;
}

const voice = read('voice/ui/tokens.css');
const styles = read('src/renderer/styles.css');
const agent = read('src/renderer/agent.css');

const voiceDark = block(voice, ':root');
const voiceLight = block(voice, ':root.light');
const rukooDark = [block(styles, ':root'), block(agent, '.bui')];
const rukooLight = [block(styles, ':root.light'), block(agent, ':root.light .bui')];

const lookup = (sources, name) => sources.find((tokens) => tokens.has(name))?.get(name);

test('every dark token in voice/ui/tokens.css has Rukoo\'s value', () => {
  assert.ok(voiceDark.size > 40, 'tokens.css lost its :root block');
  for (const [name, value] of voiceDark) {
    if (VOICE_ONLY.has(name)) continue;
    const rukoo = lookup(rukooDark, name);
    assert.ok(rukoo !== undefined, `${name} is not a Rukoo token; add it to VOICE_ONLY if Voice owns it`);
    assert.equal(value, rukoo, `${name} drifted from Rukoo's dark value`);
  }
});

test('every light token in voice/ui/tokens.css has Rukoo\'s value', () => {
  for (const [name, value] of voiceLight) {
    if (VOICE_ONLY.has(name)) continue;
    const rukoo = lookup(rukooLight, name);
    assert.ok(rukoo !== undefined, `${name} has no light value in Rukoo`);
    assert.equal(value, rukoo, `${name} drifted from Rukoo's light value`);
  }
});

test('a copied token Rukoo changes for light mode is changed in Voice\'s light block too', () => {
  for (const name of voiceDark.keys()) {
    const rukoo = lookup(rukooLight, name);
    if (rukoo === undefined) continue;
    assert.equal(voiceLight.get(name), rukoo, `${name} needs Rukoo's light value in :root.light`);
  }
});

test('light mode only overrides tokens that exist in dark mode', () => {
  for (const name of voiceLight.keys()) assert.ok(voiceDark.has(name), `${name} is light-only`);
  for (const name of VOICE_ONLY) {
    assert.ok(voiceDark.has(name), `${name} is missing from :root`);
  }
  // The pill shadow is the one Voice token whose light value differs; it needs both.
  assert.ok(voiceLight.has('--pill-shadow'));
});

test('the bundled fonts are the ones tokens.css loads, with their licence', () => {
  for (const [, file] of voice.matchAll(/url\(([^)]+)\)/g)) {
    assert.ok(fs.existsSync(path.join(root, 'voice/ui', file)), `${file} is missing`);
    assert.deepEqual(
      fs.readFileSync(path.join(root, 'voice/ui', file)),
      fs.readFileSync(path.join(root, 'src/renderer/assets', file)),
      `${file} differs from Rukoo's copy`
    );
  }
  assert.ok(fs.existsSync(path.join(root, 'voice/ui/fonts/Inter-LICENSE.txt')));
});
