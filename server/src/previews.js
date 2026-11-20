// Link cards (WORKSPACES.md, Rich messages): after a message is posted, this Worker fetches up to three of the web
// addresses in it and makes a card of each page's title, description, site and image, which the workspace stores on
// the message and announces with a message.previewed event. The server fetches, not the apps, so every device and
// agent gets the same cards and the linked site never sees a member's own address.
//
// Fetching on behalf of people is a way into places they couldn't reach themselves, so every address is checked
// before it is fetched, the redirects too: http and https on their default ports only, no user names or passwords, no
// local or internal host names, no IP literal in a private, loopback, link-local, shared or multicast range, and none
// of this server's own hosts. WORKSPACE_PREVIEW_HOSTS lets tests reach a fixture server past these rules.

import { filesOn, ownHosts, previewHosts, previewsOn, workspaceObject } from './config.js';

const MOST = 3;
// The longest address a card names, in UTF-16 code units, as the apps measure it: a card's url is the address as
// written, and an app refuses a card with a longer one.
const ADDRESS_LENGTH = 4096;
const TOTAL_TIME = 15000;
const PAGE_TIME = 4000;
const REDIRECTS = 3;
const PAGE_BYTES = 512 * 1024;
const IMAGE_BYTES = 2 * 1024 * 1024;
const AGENT = 'Mozilla/5.0 (compatible; RukooBot/1.0; +https://rukoo.io)';
const IMAGES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

// ---- Which addresses ----

// An address starts with http:// or https://, not in the middle of a word or of another address (as the apps'
// linkify.js has it), and runs to the next white space.
const CANDIDATE = /(?<![\p{L}\p{N}@._/+=:-])https?:\/\/\S+/giu;
const TRAILING = `.,:;!?'"`;
const CLOSERS = { ')': '(', ']': '[', '}': '{', '>': '<' };

// The address without the punctuation after it. A closing bracket stays when the address holds its opening one.
export function trimAddress(text) {
  const count = {};
  for (const ch of text) count[ch] = (count[ch] ?? 0) + 1;
  let end = text.length;
  while (end > 0) {
    const last = text[end - 1];
    const open = CLOSERS[last];
    if (TRAILING.includes(last) || (open && (count[last] ?? 0) > (count[open] ?? 0))) {
      count[last] -= 1;
      end -= 1;
    } else break;
  }
  return text.slice(0, end);
}

// The rules a fetch is held to on this request: { own: host names of this server, exempt: "host:port" pairs }.
export function previewRules(env, url) {
  return { own: ownHosts(env, url), exempt: previewHosts(env) };
}

// Up to three distinct addresses in text that may be fetched, in the order they appear, as written there.
export function previewAddresses(text, rules) {
  const found = [];
  const seen = new Set();
  for (const match of String(text).matchAll(CANDIDATE)) {
    const address = trimAddress(match[0]);
    if (address.length > ADDRESS_LENGTH) continue;
    const parsed = URL.parse(address);
    if (!parsed || seen.has(parsed.href) || !allowed(parsed, rules)) continue;
    seen.add(parsed.href);
    found.push(address);
    if (found.length === MOST) break;
  }
  return found;
}

// Whether the fetcher may go to url.
export function allowed(url, rules) {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  if (rules.exempt.has(`${host}:${port}`)) return true;
  if (url.username || url.password || url.port) return false;
  const name = host.replace(/\.$/, '');
  if (!name || rules.own.has(name) || rules.own.has(host)) return false;
  if (name.startsWith('[')) return publicIpv6(name.slice(1, -1));
  const v4 = ipv4(name);
  if (v4) return publicIpv4(v4);
  if (!name.includes('.')) return false;
  if (name === 'localhost' || /\.(localhost|local|internal)$/.test(name)) return false;
  return true;
}

// The four numbers of a dotted IPv4 address, as the URL parser writes every IPv4 form, or null.
function ipv4(text) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((n) => n <= 255) ? parts : null;
}

function publicIpv4([a, b, c]) {
  if (a === 0 || a === 10 || a === 127) return false; // this network, private, loopback
  if (a === 100 && b >= 64 && b <= 127) return false; // shared address space (CGNAT)
  if (a === 169 && b === 254) return false; // link-local
  if (a === 172 && b >= 16 && b <= 31) return false; // private
  if (a === 192 && b === 168) return false; // private
  if (a === 192 && b === 0 && c === 0) return false; // protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  if (a >= 224) return false; // multicast, reserved and broadcast
  return true;
}

// The eight 16-bit groups of an IPv6 address, or null. The URL parser writes every IPv6 host in hex groups, an
// IPv4-mapped one too (::ffff:7f00:1), so anything else is refused.
function ipv6Groups(text) {
  const halves = text.toLowerCase().split('::');
  if (halves.length > 2) return null;
  const read = (part) => (part ? part.split(':').map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN)) : []);
  const head = read(halves[0]);
  const tail = halves.length === 2 ? read(halves[1]) : [];
  const fill = 8 - head.length - tail.length;
  if (fill < 0 || (halves.length === 1 && fill !== 0)) return null;
  const groups = [...head, ...Array(fill).fill(0), ...tail];
  return groups.every((g) => Number.isInteger(g)) ? groups : null;
}

function publicIpv6(text) {
  const g = ipv6Groups(text);
  if (!g) return false;
  const v4 = (hi, lo) => [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff];
  if (g.slice(0, 7).every((n) => n === 0)) return false; // :: and ::1
  if (g.slice(0, 5).every((n) => n === 0) && (g[5] === 0xffff || g[5] === 0)) return publicIpv4(v4(g[6], g[7])); // mapped and compatible
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((n) => n === 0)) return publicIpv4(v4(g[6], g[7])); // NAT64
  if (g[0] === 0x2002) return publicIpv4(v4(g[1], g[2])); // 6to4
  if ((g[0] & 0xfe00) === 0xfc00) return false; // unique local
  if ((g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xffc0) === 0xfec0) return false; // link-local and site-local
  if ((g[0] & 0xff00) === 0xff00) return false; // multicast
  if (g[0] === 0x100 && g.slice(1, 4).every((n) => n === 0)) return false; // discard
  return true;
}

// ---- Making the cards ----

// Makes the cards of a message that just committed, in ctx.waitUntil of the request that posted it. ids: workspace,
// conversation and message. Best effort: whatever fails leaves the message without that card.
export function schedulePreviews(ctx, env, url, ids, text) {
  if (!ctx || !previewsOn(env)) return;
  const rules = previewRules(env, url);
  const addresses = previewAddresses(text, rules);
  if (!addresses.length) return;
  ctx.waitUntil(
    unfurl(env, ids, addresses, rules).catch((err) => {
      console.error('Could not make link cards:', err?.message || err);
    })
  );
}

export async function unfurl(env, ids, addresses, rules) {
  const stub = workspaceObject(env, ids.workspace);
  const deadline = AbortSignal.timeout(TOTAL_TIME);
  const discard = [];
  const cards = await Promise.all(addresses.map((address) => card(env, stub, ids, address, rules, deadline, discard).catch(() => null)));
  const previews = cards.filter(Boolean);
  if (!previews.length && !discard.length) return;
  const result = await stub.publishPreviews(ids.conversation, ids.message, previews, discard);
  // The workspace went while the cards were made: nobody else will delete their images.
  if (result?.gone && env.WORKSPACE_FILES) {
    const keys = [...discard, ...previews.map((p) => p.image).filter(Boolean)].map((image) => image.key);
    if (keys.length) await env.WORKSPACE_FILES.delete(keys).catch(() => {});
  }
}

async function card(env, stub, ids, address, rules, deadline, discard) {
  const got = await fetchChecked(new URL(address), rules, AbortSignal.any([deadline, AbortSignal.timeout(PAGE_TIME)]), 'text/html,application/xhtml+xml');
  if (!got) return null;
  const { response, url } = got;
  if (response.status < 200 || response.status > 299 || mediaType(response) !== 'text/html') {
    await response.body?.cancel();
    return null;
  }
  const { tags, title: heading, video: hasVideo } = await readMeta(response);
  const title = clean(tags.get('og:title') ?? tags.get('twitter:title') ?? heading, 200);
  if (!title) return null;
  const description = clean(tags.get('og:description') ?? tags.get('twitter:description') ?? tags.get('description') ?? '', 500);
  const site = clean(tags.get('og:site_name') ?? '', 100) || clean(url.hostname.replace(/^www\./i, ''), 100);
  const video = (tags.get('og:type') ?? '').trim().toLowerCase().startsWith('video') || hasVideo;
  const imageAddress = tags.get('og:image') ?? tags.get('og:image:url') ?? tags.get('og:image:secure_url') ?? tags.get('twitter:image') ?? tags.get('twitter:image:src');
  let image = null;
  if (imageAddress && filesOn(env)) {
    const at = URL.parse(decodeEntities(imageAddress).trim(), url);
    if (at) image = await storeImage(env, stub, ids, at, rules, deadline, discard).catch(() => null);
  }
  return { url: address, title, description, site, image, video };
}

// A fetch held to the rules on every hop: redirects are followed by hand, three at most, each to an address that
// passes the rules too. No cookies or credentials go along: a Worker's fetch keeps none.
async function fetchChecked(start, rules, signal, accept) {
  let target = start;
  for (let hop = 0; hop <= REDIRECTS; hop++) {
    if (!allowed(target, rules)) return null;
    const response = await fetch(target.href, { method: 'GET', redirect: 'manual', headers: { accept, 'user-agent': AGENT }, signal });
    const location = response.status >= 300 && response.status < 400 ? response.headers.get('location') : null;
    if (location === null) return { response, url: target };
    await response.body?.cancel();
    target = URL.parse(location, target);
    if (!target) return null;
  }
  return null;
}

function mediaType(response) {
  return (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
}

// At most max bytes of a body; the rest is never read.
function capped(body, max) {
  let seen = 0;
  return body.pipeThrough(
    new TransformStream({
      transform(chunk, controller) {
        const room = max - seen;
        seen += chunk.byteLength;
        controller.enqueue(chunk.byteLength > room ? chunk.slice(0, room) : chunk);
        if (seen >= max) controller.terminate();
      }
    })
  );
}

// The page's title, its meta tags by property or name, the first of each, and whether it has an og:video tag, from its
// first 512 KiB.
async function readMeta(response) {
  const meta = { tags: new Map(), title: '', video: false };
  let titles = 0;
  let inTitle = false;
  const rewriter = new HTMLRewriter()
    .on('title', {
      element(el) {
        inTitle = titles++ === 0;
        if (inTitle) {
          el.onEndTag(() => {
            inTitle = false;
          });
        }
      },
      text(chunk) {
        if (inTitle) meta.title += chunk.text;
      }
    })
    .on('meta', {
      element(el) {
        const key = (el.getAttribute('property') || el.getAttribute('name') || '').trim().toLowerCase();
        const content = el.getAttribute('content');
        if (!key || content === null) return;
        if (key.startsWith('og:video')) meta.video = true;
        if (!meta.tags.has(key)) meta.tags.set(key, content);
      }
    });
  const page = new Response(capped(response.body, PAGE_BYTES), { headers: { 'content-type': response.headers.get('content-type') || 'text/html' } });
  await rewriter.transform(page).body.pipeTo(new WritableStream());
  return meta;
}

// A card's image: fetched by the same rules, 2 MiB at most, PNG, JPEG, GIF or WebP, and written to the bucket under a
// key the workspace recorded first. null when there is no room for it or it isn't one of those.
async function storeImage(env, stub, ids, at, rules, deadline, discard) {
  const got = await fetchChecked(at, rules, AbortSignal.any([deadline, AbortSignal.timeout(PAGE_TIME)]), Object.keys(IMAGES).join(','));
  if (!got) return null;
  const { response } = got;
  if (response.status < 200 || response.status > 299 || !IMAGES[mediaType(response)] || Number(response.headers.get('content-length')) > IMAGE_BYTES) {
    await response.body?.cancel();
    return null;
  }
  const bytes = new Uint8Array(await new Response(capped(response.body, IMAGE_BYTES + 1)).arrayBuffer());
  if (bytes.length === 0 || bytes.length > IMAGE_BYTES) return null;
  const info = imageInfo(bytes);
  if (!info) return null;
  const key = await stub.previewKey(ids.conversation, ids.message, bytes.length);
  if (!key) return null;
  const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const image = { key, type: info.type, ext: IMAGES[info.type], size: bytes.length, sha256, width: info.width, height: info.height };
  try {
    await env.WORKSPACE_FILES.put(key, bytes, { sha256, httpMetadata: { contentType: info.type }, customMetadata: { name: `preview.${image.ext}` } });
  } catch {
    discard.push({ key, size: bytes.length });
    return null;
  }
  return image;
}

// The format of an image from its first bytes, and its width and height when its header gives them.
export function imageInfo(b) {
  const u16be = (i) => (b[i] << 8) | b[i + 1];
  const u16le = (i) => b[i] | (b[i + 1] << 8);
  const u24le = (i) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
  const u32be = (i) => ((b[i] << 24) >>> 0) + ((b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]);
  const size = (width, height) => (width > 0 && height > 0 && width <= 65535 && height <= 65535 ? { width, height } : {});
  if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return { type: 'image/png', ...size(u32be(16), u32be(20)) };
  }
  if (b.length >= 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return { type: 'image/gif', ...size(u16le(6), u16le(8)) };
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    // The first start-of-frame marker holds the size. Markers without a length (RSTn, SOI, TEM) are skipped.
    for (let i = 2; i + 9 < b.length; ) {
      if (b[i] !== 0xff) return { type: 'image/jpeg' };
      const marker = b[i + 1];
      if (marker === 0xff) {
        i += 1;
        continue;
      }
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
        i += 2;
        continue;
      }
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { type: 'image/jpeg', ...size(u16be(i + 7), u16be(i + 5)) };
      }
      i += 2 + u16be(i + 2);
    }
    return { type: 'image/jpeg' };
  }
  const text = (i, n) => String.fromCharCode(...b.subarray(i, i + n));
  if (b.length >= 30 && text(0, 4) === 'RIFF' && text(8, 4) === 'WEBP') {
    const chunk = text(12, 4);
    if (chunk === 'VP8X') return { type: 'image/webp', ...size(u24le(24) + 1, u24le(27) + 1) };
    if (chunk === 'VP8L' && b[20] === 0x2f) {
      const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
      return { type: 'image/webp', ...size((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1) };
    }
    if (chunk === 'VP8 ') return { type: 'image/webp', ...size(u16le(26) & 0x3fff, u16le(28) & 0x3fff) };
    return { type: 'image/webp' };
  }
  return null;
}

// ---- Text ----

const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', trade: '™', hellip: '…',
  mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', sbquo: '‚', ldquo: '“', rdquo: '”', bdquo: '„', laquo: '«',
  raquo: '»', bull: '•', middot: '·', euro: '€', pound: '£', yen: '¥', cent: '¢', deg: '°', times: '×',
  divide: '÷', para: '¶', sect: '§', iexcl: '¡', iquest: '¿', shy: '', zwj: '\u200d', zwnj: '\u200c',
  aacute: 'á', agrave: 'à', acirc: 'â', auml: 'ä', atilde: 'ã', aring: 'å', aelig: 'æ', ccedil: 'ç',
  eacute: 'é', egrave: 'è', ecirc: 'ê', euml: 'ë', iacute: 'í', igrave: 'ì', icirc: 'î', iuml: 'ï',
  ntilde: 'ñ', oacute: 'ó', ograve: 'ò', ocirc: 'ô', ouml: 'ö', otilde: 'õ', oslash: 'ø', szlig: 'ß',
  uacute: 'ú', ugrave: 'ù', ucirc: 'û', uuml: 'ü', yacute: 'ý', yuml: 'ÿ', Aacute: 'Á', Agrave: 'À',
  Auml: 'Ä', Aring: 'Å', Ccedil: 'Ç', Eacute: 'É', Egrave: 'È', Euml: 'Ë', Iuml: 'Ï', Ntilde: 'Ñ',
  Oacute: 'Ó', Ouml: 'Ö', Oslash: 'Ø', Uacute: 'Ú', Uuml: 'Ü'
};

// HTML's character references, as a page's attributes and title hold them. Unknown names stay as written.
export function decodeEntities(text) {
  return String(text).replace(/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z][A-Za-z0-9]{1,31}));/g, (whole, dec, hex, name) => {
    if (name !== undefined) return Object.hasOwn(NAMED, name) ? NAMED[name] : whole;
    const code = dec !== undefined ? Number(dec) : parseInt(hex, 16);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '\ufffd';
  });
}

// Decoded, on one line without control characters, and at most max characters, a cut ending in "…".
export function clean(text, max) {
  const flat = decodeEntities(text ?? '')
    .replace(/\s+/g, ' ')
    .replace(/\p{Cc}/gu, '')
    .trim();
  const chars = Array.from(flat);
  if (chars.length <= max) return flat;
  return `${chars.slice(0, max - 1).join('').trimEnd()}…`;
}
