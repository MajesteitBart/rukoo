// Builds site/changelog/index.html from content/changelog/*.mdx, newest first.
// The file layout and frontmatter follow the PersonalBlog (bvdm.ai) blog:
// one .mdx file per entry, slug from the file name, frontmatter read with
// gray-matter and the YAML core schema so dates stay strings until checked.
// The site itself stays static with no build step on the host: run this
// after editing an entry and commit the generated page with the entry.
// Screenshots: run tools/changelog-images.mjs first. In MDX, write images
// as in the blog, ![alt](/img/changelog/<name>.png), with the caption as
// the next paragraph in italics. The builder turns the pair into a figure
// with responsive AVIF and WebP sources. MDX here is plain markdown: raw
// HTML and components are rejected, so entries stay portable.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import matter from 'gray-matter';
import { CORE_SCHEMA, load as loadYaml } from 'js-yaml';
import { marked } from 'marked';

const CONTENT = 'content/changelog';
const SIZES = JSON.parse(fs.readFileSync('site/img/changelog/sizes.json', 'utf8'));
const OUT = 'site/changelog/index.html';

const FRONTMATTER_OPTIONS = {
  engines: { yaml: (text) => loadYaml(text, { schema: CORE_SCHEMA }) },
};

export const escHtml = (s) =>
  String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

const esc = escHtml;

// Values captured from marked's HTML are already escaped. Decode the
// entities marked emits before escaping for our own markup, or an
// apostrophe reaches the page as the literal text "&#39;".
export const decodeEntities = (s) =>
  String(s)
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&#x27;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');

// Strict ISO date check, as in PersonalBlog's dates helper: an impossible
// calendar date such as 2026-02-30 must fail, not roll over into March.
function parseDate(value, file) {
  const text = String(value ?? '').trim();
  const m = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})Z)?$/);
  if (!m) throw new Error(`${file}: date must be "YYYY-MM-DD" or a full UTC time, got "${value}"`);
  const [, y, mo, d, h = '0', mi = '0', s = '0'] = m;
  const date = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s));
  if (date.getUTCFullYear() !== +y || date.getUTCMonth() !== +mo - 1 || date.getUTCDate() !== +d) {
    throw new Error(`${file}: "${value}" is not a real calendar date`);
  }
  return date;
}

const anchorFor = (version) => {
  const base = String(version).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return /^[0-9]/.test(base) ? `v${base}` : base;
};

const dateLabel = (date) =>
  new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(date);

function loadEntries() {
  const entries = [];
  for (const file of fs.readdirSync(CONTENT).filter((f) => f.endsWith('.mdx')).sort()) {
    const raw = fs.readFileSync(path.join(CONTENT, file), 'utf8');
    const { data, content } = matter(raw, FRONTMATTER_OPTIONS);
    for (const field of ['title', 'description', 'date', 'version', 'release']) {
      if (!data[field]) throw new Error(`${file}: frontmatter misses "${field}"`);
    }
    if (!/^https:\/\/github\.com\/MajesteitBart\/rukoo\/releases\/tag\//.test(data.release)) {
      throw new Error(`${file}: release must be a Rukoo release URL, got "${data.release}"`);
    }
    if (/<[a-zA-Z/]/.test(content)) {
      throw new Error(`${file}: raw HTML is not allowed in changelog MDX; write plain markdown`);
    }
    entries.push({
      file,
      slug: file.replace(/\.mdx$/, ''),
      title: data.title,
      description: data.description,
      date: parseDate(data.date, file),
      version: data.version,
      release: data.release,
      image: data.image || '',
      draft: Boolean(data.draft),
      content,
      anchor: anchorFor(data.version),
    });
  }
  const seen = new Set();
  for (const e of entries) {
    if (seen.has(e.anchor)) throw new Error(`Duplicate anchor #${e.anchor} (${e.file})`);
    seen.add(e.anchor);
  }
  return entries.filter((e) => !e.draft).sort((a, b) => b.date - a.date);
}

function picture(name, alt) {
  const size = SIZES[name];
  if (!size) throw new Error(`No optimized screenshot for "${name}". Run tools/changelog-images.mjs first.`);
  const srcset = (ext) => size.widths.map((w) => `/img/changelog/${name}-${w}.${ext} ${w}w`).join(', ');
  const tall = size.w / size.h < 0.62;
  const full = `/img/changelog/${name}-${Math.max(...size.widths)}.webp`;
  // The frame links to the full-resolution file. changelog.js turns the
  // click into a full-viewport modal; without script the link still works.
  return (
    `<a class="log-zoom" href="${full}"><span class="log-frame${tall ? ' log-frame--tall' : ''}"><picture>` +
    `<source type="image/avif" srcset="${srcset('avif')}" sizes="(min-width: 760px) 720px, 92vw">` +
    `<source type="image/webp" srcset="${srcset('webp')}" sizes="(min-width: 760px) 720px, 92vw">` +
    `<img src="/img/changelog/${name}-${size.widths[size.widths.length - 1]}.webp" width="${size.w}" height="${size.h}" alt="${esc(decodeEntities(alt))}" loading="lazy" decoding="async">` +
    `</picture></span></a>`
  );
}

async function renderBody(entry) {
  let html = await marked.parse(entry.content, { gfm: true });
  // Image paragraph plus italic caption paragraph -> figure. An image
  // without a following caption still becomes a figure.
  html = html.replace(
    /<p><img src="\/img\/changelog\/([^"]+)\.png" alt="([^"]*)"><\/p>\s*(?:<p><em>([\s\S]*?)<\/em><\/p>)?/g,
    (m, name, alt, caption) =>
      `<figure class="log-shot">${picture(name, alt)}${caption ? `<figcaption>${caption}</figcaption>` : ''}</figure>`,
  );
  if (html.includes('<p><img') || html.includes('.png"')) throw new Error(`${entry.file}: an image was not converted; use ![alt](/img/changelog/<name>.png)`);
  if (/&amp;(#\d+;|#x[0-9a-fA-F]+;|[a-z]+;)/.test(html)) throw new Error(`${entry.file}: double-escaped HTML entity in rendered output`);
  return html;
}

const entryHtml = (e, body) => `    <article class="log-entry" id="${e.anchor}">
      <header class="log-head">
        <p class="log-meta"><time datetime="${e.date.toISOString()}">${dateLabel(e.date)}</time><span class="chip log-version">${esc(e.version)}</span></p>
        <h2><a href="#${e.anchor}">${esc(e.title)}</a></h2>
        <p class="log-summary">${esc(e.description)}</p>
      </header>
      <div class="prose">
${body.trim()}
      </div>
      <p class="log-release"><a href="${esc(e.release)}">Release notes for ${esc(e.version)} on GitHub</a></p>
    </article>`;

const pageHtml = (entries, bodies) => `<!doctype html>
<!-- Generated by tools/build-changelog.mjs from content/changelog/*.mdx. Do not edit this file. -->
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Changelog | Rukoo Mail</title>
  <meta name="description" content="What changed in Rukoo Mail, version by version, in plain English with screenshots. Newest first.">
  <link rel="canonical" href="https://rukoo.io/changelog/">
  <meta name="theme-color" content="#08090a">
  <meta name="color-scheme" content="dark">
  <meta property="og:type" content="website">
  <meta property="og:url" content="https://rukoo.io/changelog/">
  <meta property="og:site_name" content="Rukoo Mail">
  <meta property="og:title" content="Rukoo Mail changelog">
  <meta property="og:description" content="What changed in Rukoo Mail, version by version, in plain English with screenshots.">
  <meta property="og:image" content="https://rukoo.io/img/og.png">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta name="twitter:card" content="summary_large_image">
  <link rel="icon" href="/assets/rukoo-icon-dark.svg" type="image/svg+xml">
  <link rel="icon" href="/img/favicon-32.png" sizes="32x32" type="image/png">
  <link rel="apple-touch-icon" href="/img/apple-touch-icon.png">
  <link rel="preload" href="/assets/fonts/inter-latin-opsz-normal.woff2" as="font" type="font/woff2" crossorigin>
  <link rel="stylesheet" href="/styles.css">
  <link rel="stylesheet" href="/changelog.css">
  <script>document.documentElement.classList.add('js')</script>
  <script type="module" src="/app.js"></script>
  <script type="module" src="/changelog.js"></script>
</head>
<body>
  <a class="skip" href="#main">Skip to content</a>

  <header class="nav" data-nav>
    <div class="wrap">
      <a class="brand" href="/" aria-label="Rukoo Mail, home"><img src="/assets/rukoo-logo-dark.svg" width="828" height="268" alt="" style="height:26px;width:auto"></a>
      <ul class="nav-links">
        <li><a href="/#agents">Agents</a></li>
        <li><a href="/#categories">Categories</a></li>
        <li><a href="/#booking">Booking</a></li>
        <li><a href="/#why">Why I built this</a></li>
        <li><a href="/#faq">FAQ</a></li>
        <li><a href="/changelog/" aria-current="page">Changelog</a></li>
      </ul>
      <div class="nav-end">
        <a class="btn btn-ghost btn-sm" href="https://github.com/MajesteitBart/rukoo" aria-label="GitHub"><svg class="icon" aria-hidden="true"><use href="/assets/icons.svg#github-logo"/></svg><span class="label">GitHub</span></a>
        <a class="btn btn-primary btn-sm" href="/#download">Download</a>
      </div>
    </div>
  </header>

  <main id="main" class="log-main">
    <div class="wrap log-wrap">
      <h1>Changelog</h1>
      <p class="lede log-lede">What changed in Rukoo Mail, in plain English.</p>
      <div class="prose log-intro">
        <p>Rukoo Mail is an email app for your computer and phone. You read and write mail in it, see your calendar next to your mail, and can chat with an AI assistant that you connect yourself. This page tells the story version by version, newest first, and shows what each change looks like.</p>
      </div>
      <nav class="log-jump" aria-label="Versions on this page">
        <ul class="chips">
${entries.map((e) => `          <li><a class="chip" href="#${e.anchor}">${esc(e.version)}</a></li>`).join('\n')}
        </ul>
      </nav>

${entries.map((e, i) => entryHtml(e, bodies[i])).join('\n\n')}

      <section class="log-notes" aria-labelledby="good-to-know">
        <h2 id="good-to-know">Good to know</h2>
        <div class="prose">
          <p>The downloads are not signed yet. On Windows, the system warns before the first start of Rukoo and of Rukoo Voice. You choose "More info", then "Run anyway". On Linux, Rukoo needs your key store unlocked to save passwords.</p>
          <p>The phone has no calendar yet, and mail on the phone does not arrive the instant it is sent. It checks every few minutes while open and every 15 minutes in the background. A mail with a large attachment still downloads in full before you can read its text.</p>
          <p>Two keys deserve a safe place outside your computer: the Rukoo account recovery key and the Rukoo Voice recovery code. If you lose your password and the recovery help together, nobody can open that data again, because the key never leaves your devices.</p>
          <p>One batch of screenshots is missing from this page. For a group of changes finished on 29 and 30 October 2026, the screenshots sit in a private work list instead of on GitHub. Those entries describe the change and link the public code, and say so where it happens.</p>
        </div>
      </section>
    </div>
  </main>

  <dialog class="log-dialog" id="log-dialog" aria-label="Screenshot at full size">
    <button class="btn btn-secondary btn-sm log-close" type="button">Close</button>
    <img alt="">
  </dialog>

  <footer class="foot">
    <div class="wrap">
      <a class="brand" href="/" aria-label="Rukoo Mail, home"><img src="/assets/rukoo-logo-dark.svg" width="828" height="268" alt="" style="height:22px;width:auto"></a>
      <p>Built by Bart. Named after a pigeon.</p>
      <nav aria-label="Footer">
        <a href="https://github.com/MajesteitBart/rukoo">GitHub</a>
        <a href="https://github.com/MajesteitBart/rukoo/issues">Issues</a>
        <a href="/changelog/">Changelog</a>
        <a href="https://bvdm.ai">bvdm.ai</a>
      </nav>
    </div>
  </footer>
</body>
</html>
`;

// Run only as a script, so tests can import the helpers above.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const entries = loadEntries();
  const bodies = [];
  for (const e of entries) bodies.push(await renderBody(e));
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, pageHtml(entries, bodies));
  console.log(`${entries.length} entries, newest ${entries[0].version} (${dateLabel(entries[0].date)}) -> ${OUT}`);
}
