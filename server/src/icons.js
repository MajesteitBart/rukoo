// Rukoo's pigeon for the booking pages' browser tab, bookmarks and home-screen shortcuts, made from the app's logo by
// scripts/make-booking-icons.js; wrangler.jsonc bundles the files as binary data. Every page links them (pages.js),
// because a browser only looks for /favicon.ico by itself, and without BOOKING_ORIGIN the pages are under /meet. At the
// root of BOOKING_ORIGIN they are /favicon.svg, /favicon.ico and /apple-touch-icon.png; without it they are under
// /meet/assets/, next to the script.

import touch from './icons/apple-touch-icon.png';
import ico from './icons/favicon.ico';
import svg from './icons/favicon.svg';

export const ICON_FILES = {
  'favicon.ico': { body: ico, type: 'image/x-icon' },
  'favicon.svg': { body: svg, type: 'image/svg+xml' },
  'apple-touch-icon.png': { body: touch, type: 'image/png' }
};
