// The 404 page of a former root of the booking pages (BOOKING_FORMER_ROOTS), such as rukoo.io: an address there that
// names no booking page gets this instead of a redirect to the booking pages' own 404 (index.js). It looks like the
// website at rukoo.io, whose 404 it stands in for: dark, Inter, the pigeon and one way back. No scripts, and nothing
// loaded from elsewhere; the font comes from this address, where the website or this server answers it (fonts.js).

import { fontFaces } from './fonts.js';
import { baseHeaders, NOINDEX } from './http.js';
import { escape } from './page.js';

const CSP = "default-src 'none'; style-src 'unsafe-inline'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

// The pigeon from the website's logo, as website/site/404.html draws it, without the eyes that follow the pointer.
const PIGEON = `<svg class="pigeon" viewBox="-6 -6 222 280" aria-hidden="true">
<path fill="#bd2dc4" d="M179.99 123L164 123L129 190L99 268L187.5 268C211.45 220.08 200.2 169.21 179.99 123Z"/>
<path fill="#16f0a3" d="M149.05 63.04L129 95L79 165L59 225L99 250L119.5 231.5C167 197.23 168.99 176.12 179.99 123C170.72 101.79 159.56 81.55 149.05 63.04Z"/>
<path fill="#5a6a96" d="M149.05 63.04C149.68 66.93 150 70.93 150 75C150 132.92 139.21 187.45 77.5 215.5L89 240L54 265L20.32 242.01C24.92 231.19 33.18 220.66 41.24 210.38C58.84 187.95 75.51 166.7 51.4 146.21C41.58 142.96 32.67 137.74 25.12 131.01C9.7 117.26 0 97.26 0 75C0 33.58 33.58 0 75 0C112.35 0 143.32 27.3 149.05 63.04Z"/>
<path fill="#99c5f4" d="M142.46 268L7.54 268C15.13 237.81 42.45 215.45 75 215.45C107.55 215.45 134.87 237.81 142.46 268Z"/>
<path fill="#99c5f4" d="M105.25 110.55L74.56 97.48C66.41 94.01 61.74 85.37 63.3 76.65C64.86 67.93 72.24 61.45 81.08 61.02C89.93 60.59 97.9 66.34 100.29 74.86L109.31 106.98C109.99 109.4 107.56 111.54 105.25 110.55Z"/>
<circle cx="108" cy="36" r="21" fill="#ff7a1a"/><circle cx="108" cy="36" r="10" fill="#10131f"/><circle cx="104.2" cy="32.2" r="3.2" fill="#fff"/>
<circle cx="35" cy="100" r="21" fill="#ff7a1a"/><circle cx="35" cy="100" r="10" fill="#10131f"/><circle cx="31.2" cy="96.2" r="3.2" fill="#fff"/>
</svg>`;

// bookingHost: where the booking pages live now, such as meet.rukoo.io. fonts: the font directory on this address.
export function lostHtml({ bookingHost, fonts }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="theme-color" content="#08090a">
<meta name="color-scheme" content="dark">
<title>Wrong address | Rukoo</title>
<style>
${fontFaces(fonts)}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;text-size-adjust:100%}
body{margin:0;min-height:100dvh;display:grid;place-items:center;padding:40px clamp(20px,4vw,32px);text-align:center;color:#f7f8f8;font:16px/1.5 'Inter','Segoe UI Variable Text','Segoe UI',system-ui,sans-serif;font-feature-settings:'cv11','ss01','ss03';-webkit-font-smoothing:antialiased;
background:radial-gradient(40% 40% at 40% 35%,rgba(22,240,163,.07),transparent 70%),radial-gradient(40% 40% at 62% 40%,rgba(189,45,196,.08),transparent 70%),#08090a}
main{display:grid;justify-items:center;gap:24px;max-width:34rem}
.pigeon{width:150px;height:auto}
h1{margin:0;font-size:clamp(36px,5vw,56px);line-height:1.05;font-weight:620;letter-spacing:-.032em;text-wrap:balance}
p{margin:0;color:#a1a6af;font-size:18px;line-height:1.6;text-wrap:pretty}
.code{font-size:14px;color:#858a93;font-variant-numeric:tabular-nums}
a{color:#f7f8f8;text-underline-offset:3px}
.btn{display:inline-flex;align-items:center;justify-content:center;height:46px;padding:0 20px;border-radius:999px;background:#f7f8f8;color:#0a0b0d;font-size:15px;font-weight:560;letter-spacing:-.01em;text-decoration:none;box-shadow:0 1px 0 rgba(255,255,255,.4) inset,0 6px 24px -10px rgba(255,255,255,.35)}
:focus-visible{outline:2px solid #16f0a3;outline-offset:3px}
</style>
</head>
<body>
<main>
${PIGEON}
<h1>This pigeon has the wrong address.</h1>
<p class="code">404</p>
<p>There’s nothing here. Looking for someone’s booking page? Those are at ${escape(bookingHost)}/<i>name</i>.</p>
<a class="btn" href="/">Back to the home page</a>
</main>
</body>
</html>
`;
}

export function lostPage({ bookingHost, fonts }, method) {
  return new Response(method === 'HEAD' ? null : lostHtml({ bookingHost, fonts }), {
    status: 404,
    headers: baseHeaders({ 'content-type': 'text/html; charset=utf-8', 'content-security-policy': CSP, ...NOINDEX })
  });
}
