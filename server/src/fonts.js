// Inter, the typeface Rukoo itself uses, for the booking pages: the same two files as the app and the website, under
// the SIL Open Font License 1.1 (fonts/Inter-LICENSE.txt). wrangler.jsonc bundles them as binary data. At the root of
// BOOKING_ORIGIN the website may answer /assets/fonts/ first, with the same files; this server answers wherever it
// serves the pages itself.

import latinExt from './fonts/inter-latin-ext-opsz-normal.woff2';
import latin from './fonts/inter-latin-opsz-normal.woff2';

export const FONT_FILES = {
  'inter-latin-opsz-normal.woff2': latin,
  'inter-latin-ext-opsz-normal.woff2': latinExt
};

// The file every page uses, preloaded so the first paint is already in Inter.
export const MAIN_FONT = 'inter-latin-opsz-normal.woff2';

const RANGES = {
  'inter-latin-opsz-normal.woff2':
    'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD',
  'inter-latin-ext-opsz-normal.woff2':
    'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF'
};

// The @font-face rules for the files under dir, a path ending in a slash. Text in other scripts falls back to the
// system font in --font.
export function fontFaces(dir) {
  return Object.entries(RANGES)
    .map(([file, range]) => `@font-face{font-family:'Inter';font-style:normal;font-weight:100 900;font-display:swap;src:url('${dir}${file}') format('woff2');unicode-range:${range}}`)
    .join('\n');
}
