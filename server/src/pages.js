// The human booking pages (design 1.2 "The web page", 3.7): HTML from plain data, no state of their own. web.js
// gathers the data and answers the requests; this file only writes markup.
//
// Every host and guest string goes through escape(), every link is built here from checked values, and the pages
// work without JavaScript: days, times, the zone and the clock are links and forms. /meet/assets/booker.js only
// switches to the browser's zone before times show, remembers the clock and loads days without a full reload.
//
// The look follows Rukoo's design skill (.agents/skills/rukoo-design): its colour tokens for both themes, hairline
// borders, one ink-coloured primary button, radii by role and a 4px grid. Nothing is loaded from elsewhere, fonts
// included.

import { LANGUAGES, LANGUAGE_NAMES } from './booking-text.js';
import { escape as esc } from './page.js';
import { offsetText, slotParam } from './public.js';
import { addDays, weekday, zonedInstant, zonedParts } from './zone.js';

export const CSS = `
:root{color-scheme:light dark;
--bg:#f3f4f6;--panel:#ffffff;--panel-2:#f8f9fb;--border:#e6e8ec;--border-strong:#d2d6de;--hover:#f2f3f6;--chip:#eff1f4;
--text:#16181d;--text-2:#565c69;--text-3:#868b98;--accent:#2f66d6;--accent-soft:rgba(47,102,214,.1);--accent-hover:rgba(47,102,214,.18);
--link:#2f63c8;--primary:#1c2340;--on-primary:#ffffff;--danger:#d23b3b;--ok:#1f9d5c;--warn:#c27c00;--focus:#2f66d6;
--ok-tint:rgba(31,157,92,.12);--warn-tint:rgba(194,124,0,.12);--danger-tint:rgba(210,59,59,.1);--danger-ring:rgba(210,59,59,.35);
--shadow-sm:0 1px 2px rgba(20,24,40,.07),0 0 0 1px rgba(20,24,40,.06);--press:brightness(1.18);
--radius-chip:6px;--radius:8px;--radius-card:10px;--radius-lg:12px;
--font:system-ui,-apple-system,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;--mono:ui-monospace,'Cascadia Mono',Consolas,Menlo,monospace}
@media (prefers-color-scheme:dark){:root{
--bg:#141519;--panel:#1b1c21;--panel-2:#212228;--border:#2a2c33;--border-strong:#3a3d47;--hover:#23252c;--chip:#2a2c34;
--text:#ecedf1;--text-2:#a7adba;--text-3:#7a808e;--accent:#7aa5f5;--accent-soft:rgba(122,165,245,.15);--accent-hover:rgba(122,165,245,.24);
--link:#8ab0ff;--primary:#e9ecf5;--on-primary:#15171c;--danger:#ff6b6b;--ok:#4ccf8b;--warn:#f5b84c;--focus:#7aa5f5;
--ok-tint:rgba(76,207,139,.14);--warn-tint:rgba(245,184,76,.14);--danger-tint:rgba(255,107,107,.14);--danger-ring:rgba(255,107,107,.4);
--shadow-sm:0 1px 2px rgba(0,0,0,.35),0 0 0 1px rgba(255,255,255,.06);--press:brightness(.92)}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 var(--font)}
.switching body{visibility:hidden}
a{color:var(--link);text-underline-offset:2px;text-decoration-thickness:1px}
a:hover{text-decoration-thickness:2px}
:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
h1,h2,h3{margin:0;text-wrap:balance}
p{text-wrap:pretty}
.wrap{max-width:880px;margin:0 auto;padding:16px 12px 24px}
.for-assistants{margin:0 0 12px;padding:0 4px;font-size:12.5px;color:var(--text-2);overflow-wrap:anywhere}
.card{background:var(--panel);border:1px solid var(--border);border-radius:var(--radius-lg);padding:20px 16px}
@media (min-width:640px){.wrap{padding:32px 24px}.card{padding:28px 32px}}
.eyebrow{margin:0 0 6px;font-size:14px;color:var(--text-2)}
.eyebrow a{color:inherit}
.head h1{font-size:22px;line-height:1.25;font-weight:650;letter-spacing:-.02em}
h2{font-size:16px;line-height:1.35;font-weight:650;letter-spacing:-.01em}
.head h2{font-size:18px;margin-top:20px}
.quote{margin:12px 0 0;padding:0 0 0 12px;border-left:2px solid var(--border-strong);color:var(--text-2);white-space:pre-line;overflow-wrap:anywhere}
.meta{display:flex;flex-wrap:wrap;margin:8px 0 0;font-size:14px;color:var(--text-2)}
.meta span+span::before{content:'\\00b7';margin:0 8px;color:var(--text-3)}
.types{list-style:none;margin:16px 0 0;padding:0;display:grid;gap:12px}
.type{border:1px solid var(--border);border-radius:var(--radius-card);padding:16px}
.type h3{font-size:16px;font-weight:600}
.type h3 a{color:var(--text);text-decoration:none}
.type h3 a:hover{text-decoration:underline}
.label{margin:16px 0 8px;font-size:13.5px;color:var(--text-2)}
.more{display:inline-block;margin-top:12px;font-weight:500}
.bar{display:flex;flex-wrap:wrap;align-items:flex-start;justify-content:space-between;gap:8px 16px;margin-top:20px;padding-bottom:12px;border-bottom:1px solid var(--border)}
.zone{flex:1 1 260px;min-width:0}
.zone summary{display:inline;cursor:pointer;list-style:none;font-size:14px;color:var(--text-2);line-height:28px}
.zone summary::-webkit-details-marker{display:none}
.zone .change{color:var(--link);white-space:nowrap}
.zone .change::before{content:'\\00b7';color:var(--text-3);margin:0 6px}
.zone form{display:flex;flex-wrap:wrap;align-items:flex-end;gap:8px;margin-top:10px}
.zone label{width:100%;font-size:14px;font-weight:500}
.zone select{flex:1 1 220px;width:auto}
.seg{display:inline-flex;padding:2px;border-radius:9999px;background:var(--chip)}
.seg a{display:inline-flex;align-items:center;height:28px;padding:0 12px;border-radius:9999px;color:var(--text-2);font-size:13.5px;font-weight:500;text-decoration:none;white-space:nowrap}
.seg a[aria-current]{background:var(--panel);color:var(--text);box-shadow:var(--shadow-sm)}
.booker{display:grid;gap:24px;margin-top:16px}
@media (min-width:760px){.booker{grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:40px}}
.month-bar{display:flex;align-items:center;gap:4px;margin-bottom:8px}
.month-bar h2{flex:1}
.nav{display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;border-radius:var(--radius);color:var(--text-2)}
a.nav:hover{background:var(--hover);color:var(--text)}
span.nav{opacity:.4}
.grid{width:100%;border-collapse:collapse;table-layout:fixed}
.grid th{padding:0 0 6px;font-size:12px;font-weight:500;color:var(--text-3)}
.grid td{padding:2px;text-align:center}
.day{position:relative;display:flex;align-items:center;justify-content:center;height:40px;border-radius:var(--radius);font-size:14.5px;font-variant-numeric:tabular-nums;color:var(--text-3)}
a.day{color:var(--link);background:var(--accent-soft);font-weight:600;text-decoration:none;transition:background-color 120ms ease}
a.day:hover{background:var(--accent-hover)}
a.day[aria-current]{background:var(--primary);color:var(--on-primary)}
.day.today::after{content:'';position:absolute;bottom:5px;left:50%;width:4px;height:4px;margin-left:-2px;border-radius:50%;background:currentColor}
.times h2{margin-bottom:12px}
.slots{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(104px,1fr));gap:8px}
.slots.wide{grid-template-columns:repeat(auto-fill,minmax(168px,1fr))}
.slot{display:flex;align-items:center;justify-content:center;min-height:40px;padding:4px 10px;border:1px solid var(--border-strong);border-radius:var(--radius);background:var(--panel);color:var(--text);font-weight:500;font-variant-numeric:tabular-nums;text-align:center;text-decoration:none;transition:border-color 120ms ease,background-color 120ms ease}
.slot:hover{border-color:var(--text-2);background:var(--hover)}
.empty{margin:0;color:var(--text-2)}
[data-swapped] .slots{animation:rise 200ms cubic-bezier(.23,1,.32,1)}
@keyframes rise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
#booker[aria-busy=true] .booker{opacity:.55;transition:opacity 120ms ease}
.notice{margin:16px 0 0;padding:10px 12px;border:1px solid var(--border);border-radius:var(--radius-card);background:var(--panel-2)}
.notice.error{border-color:transparent;background:var(--danger-tint)}
.notice.error::before{content:'';display:inline-block;width:8px;height:8px;margin-right:8px;border-radius:50%;background:var(--danger);vertical-align:1px}
.notice:focus{outline:none}
.notice p{margin:0;display:inline}
.notice p+p,.notice ul+p{display:block;margin-top:8px}
.notice .slots{margin-top:12px}
.when{margin-top:24px}
.when-main{margin:8px 0 0;font-size:17px;font-weight:600;font-variant-numeric:tabular-nums}
.zone-note{margin:2px 0 0;font-size:14px;color:var(--text-2)}
.facts{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:6px 16px;margin:12px 0 0;font-size:14px}
.facts dt{color:var(--text-2)}
.facts dd{margin:0;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.facts .zone-note{font-size:13px}
form.book{margin-top:24px;padding-top:20px;border-top:1px solid var(--border)}
.field{display:grid;gap:6px;margin-top:16px}
.field label{font-size:14px;font-weight:500}
.hint{margin:0;font-size:13px;color:var(--text-2)}
input[type=text],input[type=email],textarea,select{width:100%;min-height:40px;padding:8px 12px;border:1px solid var(--border-strong);border-radius:var(--radius);background:var(--panel);color:var(--text);font:16px/1.4 var(--font)}
textarea{min-height:96px;resize:vertical}
input:focus-visible,textarea:focus-visible,select:focus-visible{outline:2px solid var(--focus);outline-offset:1px;border-color:transparent}
input[aria-invalid=true],textarea[aria-invalid=true]{border-color:var(--danger)}
input[aria-invalid=true]:focus-visible,textarea[aria-invalid=true]:focus-visible{outline-color:var(--danger);border-color:transparent}
.privacy-line{margin:16px 0 0;font-size:13px;color:var(--text-2)}
.actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;margin-top:20px}
.actions form{margin:0}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:40px;padding:0 18px;border:1px solid transparent;border-radius:var(--radius);font:500 15px/1 var(--font);text-decoration:none;white-space:nowrap;cursor:pointer;transition:filter 120ms ease,background-color 120ms ease}
.btn:active{scale:.98}
.btn.primary{background:var(--primary);color:var(--on-primary);box-shadow:inset 0 1px 0 rgba(255,255,255,.14)}
.btn.primary:hover{filter:var(--press)}
.btn.secondary{border-color:var(--border-strong);background:var(--panel);color:var(--text)}
.btn.secondary:hover{background:var(--hover)}
.btn.danger{border-color:var(--danger-ring);background:var(--panel);color:var(--danger)}
.btn.danger:hover{background:var(--danger-tint)}
.pill{display:inline-flex;align-items:center;height:24px;margin:0 0 10px;padding:0 10px;border-radius:9999px;font-size:12.5px;font-weight:500}
.pill.ok{background:var(--ok-tint);color:var(--ok)}
.pill.wait{background:var(--warn-tint);color:var(--warn)}
.pill.gone{background:var(--chip);color:var(--text-2)}
.lead{margin:12px 0 0;font-size:16px}
.small{margin:12px 0 0;font-size:13.5px;color:var(--text-2)}
.message{margin:16px 0 0}
.message figcaption{font-size:13.5px;color:var(--text-2)}
.message .quote{margin-top:4px}
#for-ai-assistants{margin:28px 4px 0;font-size:13.5px;color:var(--text-2);overflow-wrap:anywhere}
#for-ai-assistants h2{font-size:14px;color:var(--text)}
#for-ai-assistants ul{padding-left:20px}
#for-ai-assistants code{font:12.5px/1.5 var(--mono)}
.foot{max-width:880px;margin:0 auto;padding:0 16px 32px;font-size:13px;color:var(--text-2)}
.foot p{margin:0 0 8px}
.foot nav{display:flex;flex-wrap:wrap;gap:6px 16px}
.foot nav+nav{margin-top:6px}
.foot a{color:var(--text-2);overflow-wrap:anywhere}
.foot a[aria-current]{color:var(--text);font-weight:500;text-decoration:none}
.sr-only{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}}
`.trim();

const CHEVRON = {
  prev: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false"><path d="M15 6l-6 6 6 6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  next: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false"><path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>'
};

// ---- Links ----

// A path with query parameters; empty values are left out. Values are percent-encoded as the agent text tells
// assistants to write them (space %20, @ %40, + %2B), with : and / left readable: slot=2026-11-03T09:00Z,
// tz=Europe/Amsterdam.
export function href(path, params = {}) {
  const parts = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined || v === '') continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v)).replace(/%3A/g, ':').replace(/%2F/g, '/')}`);
  }
  return parts.length ? `${path}?${parts.join('&')}` : path;
}

// The guest's fields as query parameters, for links that keep what was filled in.
function fieldParams(fields) {
  return { name: fields.name, email: fields.email, notes: fields.notes, via: fields.via };
}

function hiddenInputs(values) {
  return Object.entries(values)
    .filter(([, value]) => value !== null && value !== undefined && value !== '')
    .map(([k, value]) => `<input type="hidden" name="${esc(k)}" value="${esc(value)}">`)
    .join('');
}

// ---- Times ----

const formats = new Map();
function dtf(locale, timeZone, options) {
  const key = `${locale}|${timeZone}|${JSON.stringify(options)}`;
  let f = formats.get(key);
  if (!f) {
    if (formats.size > 500) formats.clear();
    f = new Intl.DateTimeFormat(locale, { ...options, timeZone });
    formats.set(key, f);
  }
  return f;
}

function cap(text, locale) {
  return text ? text.charAt(0).toLocaleUpperCase(locale) + text.slice(1) : text;
}

const noon = (date) => Date.parse(`${date}T12:00:00Z`);

// Times written with the page's locale and clock, on the shown zone's wall clock. Dates without a time ('YYYY-MM-DD')
// are written from their noon in UTC, so they never shift a day.
export function formatter(locale, zone, hour12) {
  // 24-hour clocks write 09:00, 12-hour ones 9:00 AM, whatever the locale's own habit.
  const clock = hour12 ? { hour: 'numeric', minute: '2-digit', hourCycle: 'h12' } : { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
  const day = { weekday: 'long', day: 'numeric', month: 'long' };
  // Capitalised for the start of a line or a heading; the *Text forms go inside sentences ("op donderdag 29 oktober").
  const whenText = (a, b, z = zone) => dtf(locale, z, { ...day, year: 'numeric', ...clock }).formatRange(a, b);
  const dateText = (date) => dtf(locale, 'UTC', day).format(noon(date));
  return {
    locale,
    zone,
    time: (ms) => dtf(locale, zone, clock).format(ms),
    when: (a, b, z = zone) => cap(whenText(a, b, z), locale),
    whenText,
    short: (ms) => dtf(locale, zone, { weekday: 'short', day: 'numeric', month: 'short', ...clock }).format(ms),
    momentText: (ms) => dtf(locale, zone, { ...day, ...clock }).format(ms),
    date: (date) => cap(dateText(date), locale),
    dateText,
    month: (month) => cap(dtf(locale, 'UTC', { month: 'long', year: 'numeric' }).format(noon(`${month}-01`)), locale),
    monthText: (month) => dtf(locale, 'UTC', { month: 'long', year: 'numeric' }).format(noon(`${month}-01`)),
    // 2026-01-04 was a Sunday: weekday n is that date plus n days.
    weekday: (n, style) => dtf(locale, 'UTC', { weekday: style }).format(Date.UTC(2026, 0, 4 + n, 12))
  };
}

// The zone with its offset at a moment: 'Europe/Amsterdam (UTC+01:00)'.
function zoneText(zone, ms) {
  return `${zone} (${offsetText(ms, zone)})`;
}

// ---- The page around the content ----

// ctx: what web.js context() returns. main: the markup in <main> after the assistants' line. switchable: a page
// opened with GET, which booker.js may load again in the browser's zone or with the remembered clock.
export function documentHtml(ctx, { title, main, assistantLine = '', switchable = false, footer = 'full' }) {
  const attrs = [`lang="${ctx.lang}"`, `data-zone="${esc(ctx.zone)}"`, `data-clock="${ctx.clock}"`];
  if (switchable) attrs.push('data-switch');
  if (ctx.zoneAuto) attrs.push('data-auto-zone');
  if (ctx.clockAuto) attrs.push('data-auto-clock');
  return `<!doctype html>
<html ${attrs.join(' ')}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="referrer" content="same-origin">
<title>${esc(title)}</title>
<style>${CSS}</style>
<script src="/meet/assets/booker.js"></script>
</head>
<body>
<main class="wrap">
${assistantLine}${main}
</main>
${footerHtml(ctx, footer)}
<p id="live" class="sr-only" aria-live="polite"></p>
</body>
</html>
`;
}

// footer: 'full' on public pages; 'keyed' on pages whose address holds a manage key, which link nowhere else.
function footerHtml(ctx, footer) {
  const out = ['<footer class="foot">'];
  const links = [];
  if (ctx.links) links.push(`<a href="${esc(ctx.links.page)}" rel="noreferrer">${esc(ctx.links.page)}</a>`);
  if (footer === 'full') {
    if (ctx.host) {
      const operator = ctx.operator.name || ctx.T('page.operator');
      out.push(`<p>${ctx.H('page.madeBy', { host: esc(ctx.host), operator: esc(operator) })}</p>`);
    }
    if (ctx.operator.privacy) links.push(`<a href="${esc(ctx.operator.privacy)}" rel="noreferrer">${esc(ctx.T('page.privacy'))}</a>`);
    const report = reportLink(ctx);
    if (report) links.push(`<a href="${esc(report)}" rel="noreferrer">${esc(ctx.T('page.report'))}</a>`);
  } else if (ctx.operator.privacy && sameOrigin(ctx.operator.privacy, ctx.url)) {
    links.push(`<a href="${esc(ctx.operator.privacy)}">${esc(ctx.T('page.privacy'))}</a>`);
  }
  if (links.length) out.push(`<nav>${links.join('\n')}</nav>`);
  const langs = LANGUAGES.map((l) => {
    const current = l === ctx.lang ? ' aria-current="true"' : '';
    return `<a href="${esc(ctx.languageLink(l))}" lang="${l}" hreflang="${l}"${current}>${esc(LANGUAGE_NAMES[l])}</a>`;
  });
  out.push(`<nav aria-label="${esc(ctx.T('page.language'))}">${langs.join('\n')}</nav>`);
  out.push('</footer>');
  return out.join('\n');
}

function sameOrigin(link, url) {
  try {
    return new URL(link, url).origin === url.origin;
  } catch {
    return false;
  }
}

// "Report this page" goes to OPERATOR_CONTACT: a mail with the page's address in the subject, or the contact page.
function reportLink(ctx) {
  const contact = ctx.operator.contact;
  if (!contact || !ctx.links) return null;
  if (/^[^\s@]+@[^\s@]+$/.test(contact)) return `mailto:${contact}?subject=${encodeURIComponent(`Report: ${ctx.links.page}`)}`;
  return /^https?:\/\//i.test(contact) ? contact : null;
}

// ---- Pieces ----

function locationText(ctx, location) {
  const label = location.label || (location.kind === 'none' ? '' : ctx.T(`type.location.${location.kind}`));
  // A public link stays off the page: guests get it with the invitation.
  const value = location.value && location.kind !== 'link' ? location.value : '';
  return [label, value].filter(Boolean).join(', ');
}

function metaHtml(ctx, type, approval) {
  const items = [ctx.T('type.minutes', { n: type.duration })];
  const where = locationText(ctx, type.location);
  if (where) items.push(where);
  if (approval) items.push(ctx.T('type.approval', { host: ctx.host }));
  return `<p class="meta">${items.map((i) => `<span>${esc(i)}</span>`).join('')}</p>`;
}

function quoteHtml(text) {
  return text ? `<blockquote class="quote">${esc(text)}</blockquote>` : '';
}

// lines: markup, each a paragraph unless it is an element already. focus: the page opens with focus on the notice, so
// a screen reader reads it and the keyboard starts there (an alert already in the page at load isn't announced).
function noticeHtml(lines, { error = false, alert = false, id = '', focus = false } = {}) {
  if (!lines.length) return '';
  const attrs = `${alert ? ' role="alert"' : ''}${id ? ` id="${id}"` : ''}${focus ? ' tabindex="-1" autofocus' : ''}`;
  return `<div class="notice${error ? ' error' : ''}"${attrs}>${lines.map((l) => (l.startsWith('<') ? l : `<p>${l}</p>`)).join('')}</div>`;
}

function contactHtml(ctx, profile) {
  if (!profile?.contact) return '';
  return `<figure class="message"><figcaption>${esc(ctx.T('off.contact', { host: profile.name }))}</figcaption>${quoteHtml(profile.contact)}</figure>`;
}

// The zone line with its picker, and the 12/24 h switch. params: the page's own query, kept by both.
function barHtml(ctx, { path, params, at }) {
  const hidden = hiddenInputs(Object.fromEntries(Object.entries(params).filter(([k]) => k !== 'tz' && k !== 'clock')));
  const clockHidden = hiddenInputs({ clock: params.clock });
  const options = zoneList(ctx.zone)
    .map((z) => `<option value="${esc(z)}"${z === ctx.zone ? ' selected' : ''}>${esc(z.replace(/_/g, ' '))}</option>`)
    .join('');
  const clockLink = (c) => {
    const current = c === ctx.clock ? ' aria-current="true"' : '';
    return `<a href="${esc(href(path, { ...params, clock: c }))}" data-clock="${c}"${current}>${esc(ctx.T(`booker.clock${c}`))}</a>`;
  };
  return `<div class="bar">
<details class="zone">
<summary><span>${esc(ctx.T('booker.zone', { zone: ctx.zone, offset: offsetText(at, ctx.zone) }))}</span><span class="change">${esc(ctx.T('booker.change'))}</span></summary>
<form method="get" action="${esc(path)}">
<label for="tz">${esc(ctx.T('booker.zoneLabel'))}</label>
<select id="tz" name="tz">${options}</select>${hidden}${clockHidden}
<button class="btn secondary" type="submit">${esc(ctx.T('booker.zoneSubmit'))}</button>
</form>
</details>
<div class="seg" role="group" aria-label="${esc(ctx.T('booker.clock'))}">${clockLink('24')}${clockLink('12')}</div>
</div>`;
}

let ZONES = null;
function zoneList(current) {
  if (!ZONES) {
    const all = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
    ZONES = [...new Set(['UTC', ...all])].sort();
  }
  return ZONES.includes(current) ? ZONES : [current, ...ZONES];
}

// ---- Pages ----

// The landing page with several visible types (or none): the host, their intro, each type with its next open times.
export function landingHtml(ctx, { profile, types, slots, approval, agentSection, assistantLine }) {
  const parts = ['<div class="card">', '<header class="head">', `<h1>${esc(profile.name)}</h1>`, quoteHtml(profile.intro), '</header>'];
  if (!types.length) {
    parts.push(noticeHtml([esc(ctx.T('landing.noTypes'))]));
  } else {
    parts.push(barHtml(ctx, { path: ctx.base, params: { ...ctx.keep }, at: Date.now() }));
    parts.push(`<h2 class="sr-only">${esc(ctx.T('landing.pick'))}</h2>`, '<ul class="types">');
    for (const t of types) {
      const typePath = `${ctx.base}/${t.slug}`;
      const next = (slots[t.slug] ?? []).slice(0, 3);
      parts.push('<li class="type">');
      parts.push(`<h3><a href="${esc(href(typePath, ctx.keep))}">${esc(t.title)}</a></h3>`);
      parts.push(metaHtml(ctx, t, approval(t)));
      parts.push(quoteHtml(t.description));
      if (next.length) {
        parts.push(`<p class="label">${esc(ctx.T('landing.next'))}</p>`, '<ul class="slots wide">');
        for (const s of next) {
          const link = href(typePath, { ...ctx.keep, slot: slotParam(s) });
          parts.push(`<li><a class="slot" href="${esc(link)}">${esc(ctx.f.short(s))}</a></li>`);
        }
        parts.push('</ul>');
      } else {
        parts.push(`<p class="small">${esc(ctx.T('landing.noWeek', { days: 7 }))}</p>`);
        parts.push(contactHtml(ctx, profile));
      }
      parts.push(`<a class="more" href="${esc(href(typePath, ctx.keep))}">${esc(ctx.T('landing.all'))}</a>`);
      parts.push('</li>');
    }
    parts.push('</ul>');
  }
  parts.push('</div>', agentSection);
  return documentHtml(ctx, { title: ctx.T('page.title', { host: profile.name }), main: parts.filter(Boolean).join('\n'), assistantLine, switchable: true });
}

// The booker: a month with the days that have open times, and the times of the chosen day. With one visible type it
// is the landing page too, under the host's name. reschedule: { booking, key } while a guest picks a new time.
export function bookerHtml(ctx, v) {
  const { profile, type, landing, reschedule } = v;
  const head = ['<header class="head">'];
  if (landing) {
    head.push(`<h1>${esc(profile.name)}</h1>`, quoteHtml(profile.intro), `<h2>${esc(type.title)}</h2>`);
  } else {
    // The host's name leads back to the landing page, except while a guest moves a booking.
    const back = reschedule ? esc(profile.name) : `<a href="${esc(href(ctx.base, ctx.keep))}">${esc(profile.name)}</a>`;
    head.push(`<p class="eyebrow">${back}</p>`, `<h1>${esc(type.title)}</h1>`);
  }
  head.push(metaHtml(ctx, type, v.approval), quoteHtml(type.description), '</header>');
  const notices = [];
  if (reschedule) notices.push(esc(ctx.T('reschedule.pick', { time: ctx.f.whenText(reschedule.booking.start, reschedule.booking.end) })));
  if (v.badSlot) notices.push(esc(ctx.T('form.badSlot')));
  const main = [
    '<div class="card">',
    head.filter(Boolean).join('\n'),
    noticeHtml(notices, { error: Boolean(v.badSlot) }),
    `<div id="booker">${bookerBody(ctx, v)}</div>`,
    '</div>',
    v.agentSection ?? ''
  ];
  const title = landing ? ctx.T('page.title', { host: profile.name }) : `${type.title} · ${profile.name}`;
  return documentHtml(ctx, {
    title,
    main: main.filter(Boolean).join('\n'),
    assistantLine: v.assistantLine ?? '',
    switchable: true,
    footer: reschedule ? 'keyed' : 'full'
  });
}

// The part of the booker that booker.js swaps when a day or month changes: the bar, the month and the day's times.
function bookerBody(ctx, v) {
  const { month, days, date, times, first, prevMonth, nextMonth, path, keep } = v;
  const monthTitle = ctx.f.month(month);
  const nav = (dir, target) => {
    const label = esc(ctx.T(dir === 'prev' ? 'booker.prev' : 'booker.next'));
    if (!target) return `<span class="nav" aria-hidden="true">${CHEVRON[dir]}</span>`;
    return `<a class="nav" href="${esc(href(path, { ...keep, month: target }))}" data-swap="${dir}" aria-label="${label}" title="${label}">${CHEVRON[dir]}</a>`;
  };
  const head = Array.from({ length: 7 }, (_, i) => (v.weekStart + i) % 7)
    .map((d) => `<th scope="col" abbr="${esc(ctx.f.weekday(d, 'long'))}">${esc(ctx.f.weekday(d, 'short'))}</th>`)
    .join('');
  const cells = [];
  const lead = (weekday(`${month}-01`) - v.weekStart + 7) % 7;
  for (let i = 0; i < lead; i++) cells.push('<td></td>');
  for (const d of days) {
    const n = Number(d.date.slice(8));
    const today = d.today ? ' today' : '';
    const label = d.today ? `${ctx.f.date(d.date)}, ${ctx.T('booker.today')}` : ctx.f.date(d.date);
    if (d.open) {
      const current = d.date === date ? ' aria-current="date"' : '';
      const link = href(path, { ...keep, month, date: d.date });
      cells.push(
        `<td><a class="day${today}" href="${esc(link)}" data-swap="${d.date}"${current} aria-label="${esc(ctx.T('booker.open', { date: label }))}">${n}</a></td>`
      );
    } else {
      // A plain span can't carry an aria-label (screen readers skip it), so the full date is hidden text instead.
      cells.push(`<td><span class="day${today}"><span aria-hidden="true">${n}</span><span class="sr-only">${esc(label)}</span></span></td>`);
    }
  }
  while (cells.length % 7) cells.push('<td></td>');
  const rows = [];
  for (let i = 0; i < cells.length; i += 7) rows.push(`<tr>${cells.slice(i, i + 7).join('')}</tr>`);

  let day;
  let status;
  if (first === null) {
    status = ctx.T('booker.none');
    day = `<p class="empty">${esc(status)}</p>${contactHtml(ctx, v.profile)}`;
  } else if (!date) {
    status = ctx.T('booker.noMonth', { month: ctx.f.monthText(month) });
    day = `<p class="empty">${esc(status)}</p>`;
  } else if (!times.length) {
    status = ctx.T('booker.noDay', { date: ctx.f.dateText(date) });
    day = `<h2 id="times-title">${esc(ctx.f.date(date))}</h2><p class="empty">${esc(status)}</p>`;
  } else {
    status = ctx.T(times.length === 1 ? 'booker.timesOne' : 'booker.timesMany', { count: times.length, date: ctx.f.dateText(date) });
    const items = times.map((s) => {
      const link = href(v.slotPath ?? path, { ...keep, slot: slotParam(s) });
      const label = `${ctx.f.date(date)}, ${ctx.f.time(s)}`;
      return `<li><a class="slot" href="${esc(link)}" aria-label="${esc(label)}">${esc(ctx.f.time(s))}</a></li>`;
    });
    day = `<h2 id="times-title">${esc(ctx.f.date(date))}</h2><ul class="slots" aria-label="${esc(ctx.T('booker.times'))}">${items.join('')}</ul>`;
  }
  const at = date ? zonedInstant(date, '12:00', ctx.zone) : Date.now();
  return `${barHtml(ctx, { path, params: { ...keep, month, date }, at })}
<div class="booker">
<section class="month" aria-labelledby="month-title">
<div class="month-bar">${nav('prev', prevMonth)}<h2 id="month-title">${esc(monthTitle)}</h2>${nav('next', nextMonth)}</div>
<table class="grid"><caption class="sr-only">${esc(ctx.T('booker.days'))}</caption><thead><tr>${head}</tr></thead><tbody>${rows.join('')}</tbody></table>
</section>
<section class="times" data-status="${esc(status)}">
${day}
</section>
</div>`;
}

// The filled-in form for one time (a prepared link, or the form again after a refused booking), or, when the time is
// gone, the nearest open times as links that keep what was filled in.
export function formHtml(ctx, v) {
  const { profile, type, start, end, fields } = v;
  const path = `${ctx.base}/${type.slug}`;
  const head = [
    '<header class="head">',
    `<p class="eyebrow"><a href="${esc(href(v.multiple ? ctx.base : path, ctx.keep))}">${esc(profile.name)}</a></p>`,
    `<h1>${esc(type.title)}</h1>`,
    metaHtml(ctx, type, v.approval),
    '</header>'
  ];
  const parts = ['<div class="card">', head.join('\n')];
  if (v.filled && v.open && !v.error) parts.push(noticeHtml([esc(ctx.T('form.filled'))]));
  // Focus goes to the field that was wrong, or to the notice when no field was.
  const onField = v.open && FIELDS.includes(v.error?.field);
  if (v.error) parts.push(noticeHtml([esc(v.error.message)], { error: true, alert: true, id: 'form-error', focus: !onField }));
  parts.push(whenHtml(ctx, { start, end, hostZone: profile.timeZone, host: profile.name }));
  if (!v.open) {
    parts.push(alternativesHtml(ctx, { path, alternatives: v.alternatives, params: { ...ctx.keep, ...fieldParams(fields) }, gone: !v.error }));
  } else {
    parts.push(bookFormHtml(ctx, v, path));
  }
  parts.push(`<p class="small"><a href="${esc(href(path, ctx.keep))}">${esc(ctx.T('form.other'))}</a></p>`, '</div>');
  return documentHtml(ctx, { title: `${type.title} · ${profile.name}`, main: parts.join('\n'), switchable: v.switchable });
}

function whenHtml(ctx, { start, end, hostZone, host }) {
  const out = ['<section class="when" aria-labelledby="when-title">', `<h2 id="when-title">${esc(ctx.T('form.when'))}</h2>`];
  out.push(`<p class="when-main">${esc(ctx.f.when(start, end))}</p>`, `<p class="zone-note">${esc(zoneText(ctx.zone, start))}</p>`);
  const facts = [];
  if (hostZone !== ctx.zone) {
    facts.push(
      `<dt>${esc(ctx.T('form.hostTime', { host }))}</dt><dd>${esc(ctx.f.when(start, end, hostZone))}<div class="zone-note">${esc(zoneText(hostZone, start))}</div></dd>`
    );
  }
  if (ctx.zone !== 'UTC') facts.push(`<dt>${esc(ctx.T('form.utc'))}</dt><dd>${esc(ctx.f.when(start, end, 'UTC'))}</dd>`);
  if (facts.length) out.push(`<dl class="facts">${facts.join('')}</dl>`);
  out.push('</section>');
  return out.join('\n');
}

function alternativesHtml(ctx, { path, alternatives, params, gone }) {
  const lines = [];
  if (gone) lines.push(esc(ctx.T('form.gone')));
  if (alternatives.length) {
    lines.push(esc(ctx.T('form.nearest')));
    const items = alternatives.map((s) => `<li><a class="slot" href="${esc(href(path, { ...params, slot: slotParam(s) }))}">${esc(ctx.f.short(s))}</a></li>`);
    lines.push(`<ul class="slots wide">${items.join('')}</ul>`);
  } else if (gone) {
    lines.push(esc(ctx.T('form.noNearest')));
  }
  return noticeHtml(lines);
}

// The guest's fields on the booking form; an error on one of them puts the focus there.
const FIELDS = ['name', 'email', 'notes', 'via'];

function fieldHtml(v, { name, type = 'text', label, hint, required = false, max, autocomplete, area = false }) {
  const id = `f-${name}`;
  const error = v.error?.field === name;
  const described = [hint ? `${id}-hint` : null, error ? 'form-error' : null].filter(Boolean).join(' ');
  const attrs = [
    `id="${id}"`,
    `name="${name}"`,
    max ? `maxlength="${max}"` : '',
    required ? 'required' : '',
    autocomplete ? `autocomplete="${autocomplete}"` : '',
    described ? `aria-describedby="${described}"` : '',
    error ? 'aria-invalid="true" autofocus' : ''
  ]
    .filter(Boolean)
    .join(' ');
  const value = v.fields[name] ?? '';
  const control = area ? `<textarea ${attrs}>${esc(value)}</textarea>` : `<input type="${type}" ${attrs} value="${esc(value)}">`;
  return `<div class="field"><label for="${id}">${esc(label)}</label>${control}${hint ? `<p class="hint" id="${id}-hint">${esc(hint)}</p>` : ''}</div>`;
}

function bookFormHtml(ctx, v, path) {
  const host = v.profile.name;
  // tz is the zone the guest saw the times in, kept with the booking; booker.js puts the browser's zone there when the
  // page only had the host's.
  const inputs = hiddenInputs({ start: slotParam(v.start), tz: ctx.zone, lang: ctx.keep.lang, clock: ctx.keep.clock, idem: v.idem });
  const operator = ctx.operator.name || ctx.T('page.operatorStart');
  // The server's own statement opens at its part about guests, in the page's language.
  const own = sameOrigin(ctx.operator.privacy, ctx.url) && new URL(ctx.operator.privacy, ctx.url).pathname === '/privacy';
  const privacyHref = own ? `/privacy?lang=${ctx.lang}#booking-pages` : ctx.operator.privacy;
  const privacy = ctx.operator.privacy ? ` <a href="${esc(privacyHref)}" rel="noreferrer">${esc(ctx.T('page.privacy'))}</a>` : '';
  const out = [`<form class="book" method="post" action="${esc(path)}">`, `<h2>${esc(ctx.T('form.title'))}</h2>`, inputs];
  out.push(fieldHtml(v, { name: 'name', label: ctx.T('form.name'), required: true, max: 80, autocomplete: 'name' }));
  out.push(fieldHtml(v, { name: 'email', type: 'email', label: ctx.T('form.email'), required: true, max: 254, autocomplete: 'email' }));
  out.push(fieldHtml(v, { name: 'notes', label: ctx.T('form.notes'), hint: ctx.T('form.notesHint', { host }), max: 1000, area: true }));
  // The assistant's name shows only when an assistant filled it in; people booking themselves don't need the field.
  if (v.fields.via || v.error?.field === 'via') {
    out.push(fieldHtml(v, { name: 'via', label: ctx.T('form.via'), hint: ctx.T('form.viaHint', { host }), max: 80 }));
  }
  if (v.approval) out.push(`<p class="small">${esc(ctx.T('form.approval', { host }))}</p>`);
  out.push(`<p class="privacy-line">${ctx.H('form.privacy', { host: esc(host), operator: esc(operator) })}${privacy}</p>`);
  out.push(`<div class="actions"><button class="btn primary" type="submit">${esc(ctx.T('form.book'))}</button></div>`, '</form>');
  return out.join('\n');
}

// After a booking for the same time and email as an active one: no key comes back, so the page says where it is.
export function alreadyHtml(ctx, { profile, type, start, end, email }) {
  const path = `${ctx.base}/${type.slug}`;
  const main = [
    '<div class="card">',
    `<header class="head"><p class="eyebrow"><a href="${esc(href(ctx.base, ctx.keep))}">${esc(profile.name)}</a></p><h1>${esc(type.title)}</h1></header>`,
    noticeHtml([esc(ctx.T('form.already', { email, host: profile.name }))]),
    whenHtml(ctx, { start, end, hostZone: profile.timeZone, host: profile.name }),
    `<p class="small"><a href="${esc(href(path, ctx.keep))}">${esc(ctx.T('form.other'))}</a></p>`,
    '</div>'
  ];
  return documentHtml(ctx, { title: `${type.title} · ${profile.name}`, main: main.join('\n') });
}

// Moving a booking: the old and the new time, and one button that moves it.
export function rescheduleHtml(ctx, v) {
  const { profile, type, booking, key, start, end } = v;
  const manage = href(`${ctx.base}/booking/${booking.id}`, { k: key, ...ctx.keep });
  const typePath = `${ctx.base}/${type.slug}`;
  const parts = [
    '<div class="card">',
    `<header class="head"><p class="eyebrow">${esc(profile.name)}</p><h1>${esc(type.title)}</h1>${metaHtml(ctx, type, false)}</header>`
  ];
  if (v.error) parts.push(noticeHtml([esc(v.error.message)], { error: true, alert: true, focus: true }));
  if (!v.open) {
    parts.push(alternativesHtml(ctx, { path: typePath, alternatives: v.alternatives, params: { ...ctx.keep, reschedule: booking.id, k: key }, gone: !v.error }));
  } else {
    parts.push(`<h2 class="when">${esc(ctx.T('reschedule.confirm'))}</h2>`);
    parts.push(
      `<dl class="facts"><dt>${esc(ctx.T('reschedule.now'))}</dt><dd>${esc(ctx.f.when(booking.start, booking.end))}</dd><dt>${esc(ctx.T('reschedule.new'))}</dt><dd><strong>${esc(ctx.f.when(start, end))}</strong></dd></dl>`,
      `<p class="zone-note">${esc(zoneText(ctx.zone, start))}</p>`
    );
    const inputs = hiddenInputs({ k: key, action: 'reschedule', start: slotParam(start), tz: ctx.zone, lang: ctx.keep.lang, clock: ctx.keep.clock });
    parts.push(
      `<div class="actions"><form method="post" action="${esc(`${ctx.base}/booking/${booking.id}`)}">${inputs}<button class="btn primary" type="submit">${esc(ctx.T('reschedule.move'))}</button></form><a href="${esc(manage)}">${esc(ctx.T('reschedule.keep'))}</a></div>`
    );
  }
  parts.push(`<p class="small"><a href="${esc(href(typePath, { ...ctx.keep, reschedule: booking.id, k: key }))}">${esc(ctx.T('form.other'))}</a></p>`, '</div>');
  return documentHtml(ctx, { title: `${type.title} · ${profile.name}`, main: parts.join('\n'), switchable: v.switchable, footer: 'keyed' });
}

const STATUS_TONE = { confirmed: 'ok', pending: 'wait' };

function statusLines(ctx, booking, host, over) {
  switch (booking.status) {
    case 'confirmed':
      return [over ? ctx.T('manage.over') : ctx.T('manage.invitation', { host })];
    case 'pending': {
      const lines = [ctx.T('manage.pending', { host })];
      if (booking.expiresAt) lines.push(ctx.T('manage.lapses', { host, time: `${ctx.f.momentText(booking.expiresAt)} (${ctx.zone})` }));
      return lines;
    }
    case 'cancelled':
      return [booking.cancelledBy === 'host' ? ctx.T('manage.cancelledHost', { host }) : ctx.T('manage.cancelledGuest', { host })];
    case 'declined':
      return [ctx.T('manage.declined', { host })];
    default:
      return [ctx.T('manage.expired', { host })];
  }
}

// The guest's own page for a booking: confirmation after booking, and where to move or cancel it.
export function manageHtml(ctx, v) {
  const { profile, booking, type, key, now } = v;
  const host = profile?.name ?? ctx.T('page.anon');
  const path = `${ctx.base}/booking/${booking.id}`;
  const active = booking.status === 'confirmed' || booking.status === 'pending';
  const over = booking.end <= now;
  const parts = ['<div class="card">'];
  if (v.error) parts.push(noticeHtml([esc(v.error.message)], { error: true, alert: true, focus: true }));
  parts.push('<header class="head">');
  parts.push(`<p class="pill ${STATUS_TONE[booking.status] ?? 'gone'}">${esc(ctx.T(`manage.status.${booking.status}`, { host }))}</p>`);
  parts.push(`<h1>${esc(ctx.T('manage.with', { type: type?.title ?? booking.type, host }))}</h1>`);
  parts.push('</header>');
  parts.push(
    statusLines(ctx, booking, host, over)
      .map((l, i) => `<p class="${i ? 'small' : 'lead'}">${esc(l)}</p>`)
      .join('\n')
  );

  parts.push(barHtml(ctx, { path, params: { k: key, ...ctx.keep }, at: booking.start }));
  const facts = [
    `<dt>${esc(ctx.T('manage.yourTime'))}</dt><dd>${esc(ctx.f.when(booking.start, booking.end))}<div class="zone-note">${esc(zoneText(ctx.zone, booking.start))}</div></dd>`
  ];
  if (profile && profile.timeZone !== ctx.zone) {
    facts.push(
      `<dt>${esc(ctx.T('form.hostTime', { host }))}</dt><dd>${esc(ctx.f.when(booking.start, booking.end, profile.timeZone))}<div class="zone-note">${esc(zoneText(profile.timeZone, booking.start))}</div></dd>`
    );
  }
  // The location's name only: this page links nowhere outside the server, a meeting link included.
  const where = type ? locationText(ctx, { ...type.location, value: '' }) : '';
  if (where) facts.push(`<dt>${esc(ctx.T('manage.where'))}</dt><dd>${esc(where)}</dd>`);
  parts.push(`<dl class="facts">${facts.join('')}</dl>`);

  if (booking.message) {
    parts.push(`<figure class="message"><figcaption>${esc(ctx.T('manage.message', { host }))}</figcaption>${quoteHtml(booking.message)}</figure>`);
  }
  if (booking.status === 'confirmed' && !over) {
    parts.push(`<p class="small"><a href="${esc(href(`${path}.ics`, { k: key }))}">${esc(ctx.T('manage.ics'))}</a></p>`);
  }

  if (active && !over) {
    parts.push(`<p class="small">${esc(ctx.T('manage.keep'))}</p>`);
    parts.push(`<section class="when" aria-labelledby="changes-title"><h2 id="changes-title">${esc(ctx.T('manage.changes'))}</h2>`);
    const actions = [];
    if (v.canMove) {
      const link = href(`${ctx.base}/${booking.type}`, { ...ctx.keep, reschedule: booking.id, k: key });
      actions.push(`<a class="btn secondary" href="${esc(link)}">${esc(ctx.T('manage.reschedule'))}</a>`);
    }
    const inputs = hiddenInputs({ k: key, action: 'cancel', tz: ctx.keep.tz, lang: ctx.keep.lang, clock: ctx.keep.clock });
    actions.push(`<form method="post" action="${esc(path)}">${inputs}<button class="btn danger" type="submit">${esc(ctx.T('manage.cancel'))}</button></form>`);
    parts.push(`<div class="actions">${actions.join('')}</div>`);
    if (booking.reschedules >= 2 && booking.start > now) parts.push(`<p class="small">${esc(ctx.T('manage.noMoves'))}</p>`);
    parts.push('</section>');
  } else if (profile) {
    parts.push(`<p class="small"><a href="${esc(href(ctx.base, ctx.keep))}">${esc(ctx.T('manage.again'))}</a></p>`);
  }
  parts.push('</div>');
  return documentHtml(ctx, { title: `${ctx.T('manage.title')} · ${host}`, main: parts.join('\n'), switchable: v.switchable, footer: 'keyed' });
}

// A page that isn't taking bookings: off, or deleted with its handle still reserved. With a profile it names the host
// and shows their contact line.
export function offHtml(ctx, profile) {
  const main = ['<div class="card">', '<header class="head">', `<h1>${esc(profile ? profile.name : ctx.T('page.anon'))}</h1>`, '</header>'];
  main.push(`<p class="lead">${esc(profile ? ctx.T('off.host', { host: profile.name }) : ctx.T('off.anon'))}</p>`, contactHtml(ctx, profile), '</div>');
  return documentHtml(ctx, { title: profile ? profile.name : ctx.T('page.anon'), main: main.filter(Boolean).join('\n') });
}

// A page, type or booking that isn't there. Unknown, reserved and blocked handles all get the same page.
export function missingHtml(ctx, { kind = 'page', profile = null } = {}) {
  const text = { page: 'off.anon', type: 'missing.type', booking: 'missing.booking' }[kind];
  const main = ['<div class="card">', '<header class="head">', `<h1>${esc(profile ? profile.name : ctx.T('page.anon'))}</h1>`, '</header>'];
  main.push(`<p class="lead">${esc(ctx.T(text))}</p>`);
  if (kind === 'type' && profile) main.push(`<p class="small"><a href="${esc(href(ctx.base, ctx.keep))}">${esc(ctx.T('missing.allTypes'))}</a></p>`);
  main.push('</div>');
  return documentHtml(ctx, { title: profile ? profile.name : ctx.T('page.anon'), main: main.join('\n'), footer: kind === 'booking' ? 'keyed' : 'full' });
}

// A form post refused before its page was read: from another website, too big, or the wrong kind of body.
export function refusedHtml(ctx, message) {
  const main = ['<div class="card">', `<header class="head"><h1>${esc(ctx.T('page.anon'))}</h1></header>`, noticeHtml([esc(message)], { error: true, alert: true, focus: true }), '</div>'];
  return documentHtml(ctx, { title: ctx.T('page.anon'), main: main.join('\n'), footer: 'keyed' });
}

// The body of a page's redirect to its new handle, for clients that show it instead of following.
export function movedHtml(ctx, to) {
  const main = `<div class="card"><p class="lead">${ctx.H('page.moved', { url: `<a href="${esc(to)}">${esc(to)}</a>` })}</p></div>`;
  return documentHtml(ctx, { title: ctx.T('page.anon'), main, footer: 'keyed' });
}

// ---- The month ----

// The days of a month for the grid: { date, open, today }.
export function monthDays(month, openDates, today) {
  const out = [];
  for (let date = `${month}-01`; date.startsWith(month); date = addDays(date, 1)) {
    out.push({ date, open: openDates.has(date), today: date === today });
  }
  return out;
}

export function monthOf(ms, zone) {
  return zonedParts(ms, zone).date.slice(0, 7);
}

export function addMonths(month, n) {
  const [y, m] = month.split('-').map(Number);
  const total = y * 12 + (m - 1) + n;
  return `${String(Math.floor(total / 12)).padStart(4, '0')}-${String((total % 12) + 1).padStart(2, '0')}`;
}

export function lastDay(month) {
  return addDays(`${addMonths(month, 1)}-01`, -1);
}
