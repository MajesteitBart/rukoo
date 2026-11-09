// Builds one SVG sprite from Phosphor icons (MIT). Use as <svg><use href="/assets/icons.svg#name"/></svg>.
import fs from 'node:fs';
const base = 'node_modules/@phosphor-icons/core/assets';
const icons = {
  regular: ['windows-logo', 'github-logo', 'download-simple', 'arrow-right', 'arrow-up-right', 'sparkle', 'magnifying-glass', 'check', 'x',
    'caret-down', 'caret-up', 'arrow-up', 'clock-counter-clockwise', 'plus', 'paperclip', 'image', 'text-aa', 'trash', 'dots-three-vertical',
    'paper-plane-tilt', 'arrow-bend-up-left', 'arrow-bend-double-up-left', 'archive', 'folder-simple-plus', 'envelope-simple', 'arrows-out-simple',
    'star', 'lock-simple', 'hard-drives', 'eye-slash', 'shield-check', 'keyboard', 'sun', 'moon', 'pencil-simple', 'arrow-counter-clockwise',
    'download', 'list-checks', 'chat-circle-dots', 'arrow-square-out', 'warning-circle', 'package',
    'apple-logo', 'linux-logo', 'android-logo', 'calendar-dots', 'device-mobile', 'bell', 'signature', 'copy'],
  fill: ['play', 'check-circle', 'sparkle', 'pause', 'speaker-high', 'speaker-slash'],
};
// Phosphor's MIT license asks for its notice in every copy, so the sprite carries it.
const license = fs.readFileSync('node_modules/@phosphor-icons/core/LICENSE', 'utf8').trim().replace(/--/g, '- -');
let out = `<svg xmlns="http://www.w3.org/2000/svg" style="display:none">\n<!-- Icons from Phosphor Icons (https://phosphoricons.com)\n\n${license}\n-->\n`;
for (const [weight, names] of Object.entries(icons)) {
  for (const name of names) {
    const file = weight === 'regular' ? `${base}/regular/${name}.svg` : `${base}/${weight}/${name}-${weight}.svg`;
    const svg = fs.readFileSync(file, 'utf8');
    const viewBox = svg.match(/viewBox="([^"]+)"/)[1];
    const inner = svg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
    out += `<symbol id="${weight === 'regular' ? name : `${name}-${weight}`}" viewBox="${viewBox}">${inner}</symbol>\n`;
  }
}
out += '</svg>\n';
fs.writeFileSync('site/assets/icons.svg', out);
console.log('icons.svg', (out.length / 1024).toFixed(1), 'KB');
