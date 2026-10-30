// The human booking pages (design 1.2 "The web page", 3.7): HTML from plain data, no state of their own. web.js
// gathers the data and answers the requests; this file only writes markup.
//
// Every host and guest string goes through escape(), every link is built here from checked values, and the pages
// work without JavaScript: days, times, the zone and the clock are links and forms. booker.js only
// switches to the browser's zone before times show, remembers the clock and loads days without a full reload.
//
// The look follows Rukoo's design skill (.agents/skills/rukoo-design): the app's colour tokens for both themes, Inter,
// the app's line icons, hairline rings, one ink-coloured primary button, radii by role and a 4px grid. The booker
// is one card in three columns, like the app's event card beside a month: the host and the meeting, the month, and
// the chosen day's times. Nothing is loaded from elsewhere; the font and the tab's icon come from this server (fonts.js,
// icons.js).
//
// Assistants get the page's llms.txt, linked in the head and in the footer; the page itself carries no text for them.

import { LANGUAGES, LANGUAGE_NAMES } from './booking-text.js';
import { MAIN_FONT, fontFaces } from './fonts.js';
import { escape as esc } from './page.js';
import { offsetText, slotParam } from './public.js';
import { addDays, weekday, zonedInstant, zonedParts } from './zone.js';

export const CSS = `
:root{color-scheme:light dark;
--bg:#f3f4f6;--panel:#ffffff;--panel-2:#f8f9fb;--border:#e6e8ec;--border-strong:#d2d6de;--hover:#f2f3f6;--active:#ebedf1;--chip:#eff1f4;--seg:rgba(230,232,236,.7);
--text:#16181d;--text-2:#565c69;--text-3:#868b98;--accent:#2f66d6;--accent-soft:rgba(47,102,214,.1);--link:#2f63c8;--focus:#2f66d6;
--primary:#1c2340;--on-primary:#ffffff;--press:brightness(1.18);--thumb:var(--panel);--danger:#d23b3b;
--green:oklch(.603 .155 150.883);--green-tint:oklch(.958 .017 159.118);--orange:oklch(.689 .179 49.902);--orange-tint:oklch(.964 .021 67.581);
--red:oklch(.621 .192 23.042);--red-tint:oklch(.956 .017 17.462);--red-ring:oklch(.621 .192 23.042/.28);
--avatar-bg:93%;--avatar-ink:32%;--avatar-sat:60%;--avatar-ink-sat:45%;
--shadow-btn:0 0 0 1px var(--border-strong),0 0 4px 0 #0000000a;
--shadow-card:0 0 0 1px var(--border),0 18px 47px 0 #00000008,0 7.5px 19px 0 #00000005,0 4px 10.5px 0 #00000005,0 2.3px 5.8px 0 #00000003,0 1.2px 3.1px 0 #00000003,0 .5px 1.3px 0 #00000003;
--radius:8px;--radius-card:10px;--radius-lg:12px;--ease-out-strong:cubic-bezier(.23,1,.32,1);
--font:'Inter','Segoe UI Variable Text','Segoe UI',system-ui,-apple-system,Roboto,'Helvetica Neue',Arial,sans-serif}
@media (prefers-color-scheme:dark){:root{
--bg:#141519;--panel:#1b1c21;--panel-2:#212228;--border:#2a2c33;--border-strong:#3a3d47;--hover:#23252c;--active:#2c2f38;--chip:#2a2c34;--seg:rgba(42,44,51,.7);
--text:#ecedf1;--text-2:#a7adba;--text-3:#7a808e;--accent:#7aa5f5;--accent-soft:rgba(122,165,245,.15);--link:#8ab0ff;--focus:#7aa5f5;
--primary:#e9ecf5;--on-primary:#15171c;--press:brightness(.92);--thumb:var(--active);--danger:#ff6b6b;
--green:oklch(.705 .154 153.814);--green-tint:oklch(.705 .154 153.814/.14);--orange:oklch(.746 .156 55.642);--orange-tint:oklch(.746 .156 55.642/.14);
--red:oklch(.666 .18 21.433);--red-tint:oklch(.666 .18 21.433/.14);--red-ring:oklch(.666 .18 21.433/.28);
--avatar-bg:27%;--avatar-ink:84%;--avatar-sat:38%;--avatar-ink-sat:70%;
--shadow-btn:0 0 0 1px oklch(1 0 0/.1),0 1px 2px oklch(0 0 0/.3);
--shadow-card:0 0 0 1px oklch(1 0 0/.11),0 1px 2px oklch(0 0 0/.2),0 2px 6px oklch(0 0 0/.2)}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 var(--font);font-feature-settings:'cv11';letter-spacing:-.01em}
.switching body{visibility:hidden}
a{color:var(--link);text-decoration:none;text-underline-offset:2px}
a:hover{text-decoration:underline}
:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
h1,h2,h3{margin:0;text-wrap:balance}
p{margin:0;text-wrap:pretty}
.ic{flex:none;width:16px;height:16px;color:var(--text-3)}
.sr-only{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
.wrap{width:100%;max-width:var(--w);margin:0 auto;padding:16px 12px 24px}
@media (min-width:640px){.wrap{padding:clamp(24px,8vh,72px) 24px 28px}}
.wide{--w:1064px}.mid{--w:860px}.narrow{--w:600px}
.card{background:var(--panel);border-radius:var(--radius-lg);box-shadow:var(--shadow-card)}
.pad{padding:24px 20px}
@media (min-width:640px){.pad{padding:28px}}
.host{display:flex;align-items:center;gap:10px;min-width:0;font-size:13.5px;font-weight:500;color:var(--text-2)}
.host>:last-child{min-width:0;overflow-wrap:anywhere}
.host a{color:inherit}
.avatar{--h:220;flex:none;display:grid;place-items:center;width:28px;height:28px;border-radius:50%;font-size:11px;font-weight:650;letter-spacing:.01em;background:hsl(var(--h) var(--avatar-sat) var(--avatar-bg));color:hsl(var(--h) var(--avatar-ink-sat) var(--avatar-ink))}
.avatar.lg{width:48px;height:48px;font-size:17px}
.info{padding:20px;min-width:0}
@media (min-width:640px){.info{padding:24px}}
.info h1{margin-top:14px;font-size:20px;line-height:1.3;font-weight:650;letter-spacing:-.02em;overflow-wrap:anywhere}
.details{list-style:none;margin:12px 0 0;padding:0;display:grid;gap:8px;font-size:13.5px;color:var(--text-2)}
.details li{display:flex;align-items:flex-start;gap:8px;min-width:0;overflow-wrap:anywhere}
.details .ic{margin-top:2px}
.details.inline{display:flex;flex-wrap:wrap;gap:4px 16px;margin-top:6px;font-size:13px}
.quote{margin:14px 0 0;padding:0 0 0 10px;border-left:2px solid var(--border-strong);color:var(--text-2);font-size:13.5px;white-space:pre-line;overflow-wrap:anywhere}
.intro{margin:10px 0 0;color:var(--text-2);font-size:13.5px;white-space:pre-line;overflow-wrap:anywhere}
.zone{margin-top:20px;padding-top:16px;border-top:1px solid var(--border);font-size:13px;color:var(--text-2)}
.zone summary{display:flex;align-items:flex-start;gap:8px;cursor:pointer;list-style:none}
.zone summary::-webkit-details-marker{display:none}
.zone summary .ic{margin-top:1px}
.zone .change{color:var(--link);white-space:nowrap}
.zone .change::before{content:'\\00b7';display:inline-block;color:var(--text-3);margin:0 6px}
.zone summary:hover .change{text-decoration:underline}
.zone form{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:12px 0 0 24px}
.zone label{width:100%;font-size:12.5px;font-weight:500;color:var(--text-2)}
.zone select{flex:1 1 180px;width:100%;min-width:0}
.nowrap{white-space:nowrap}
.bar{display:flex;flex-wrap:wrap;align-items:flex-start;justify-content:space-between;gap:8px 16px;margin-top:20px;padding-top:16px;border-top:1px solid var(--border)}
.bar .zone{flex:1 1 240px;min-width:0;margin:0;padding:0;border:0}
.bar .zone summary{padding-top:4px}
.seg{display:inline-flex;flex:none;padding:2px;border-radius:9999px;background:var(--seg)}
.seg a{display:inline-flex;align-items:center;height:24px;padding:0 10px;border-radius:9999px;color:var(--text-3);font-size:12px;font-weight:500;white-space:nowrap;transition:color 120ms ease}
.seg a:hover{color:var(--text-2);text-decoration:none}
.seg a[aria-current]{background:var(--thumb);color:var(--text);box-shadow:var(--shadow-btn)}
.booker-card{display:grid;grid-template-columns:minmax(0,1fr)}
.booker-card>.info{border-bottom:1px solid var(--border)}
#booker{display:grid;grid-template-columns:minmax(0,1fr)}
#booker[aria-busy=true]>*{opacity:.55;transition:opacity 120ms ease}
.month{padding:20px;min-width:0}
.month-bar{display:flex;align-items:center;gap:4px;margin-bottom:12px}
.month-bar h2{flex:1;font-size:14px;font-weight:600}
.nav{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:var(--radius);color:var(--text-2)}
.nav .ic{color:inherit}
a.nav:hover{background:var(--hover);color:var(--text)}
span.nav{opacity:.4}
.grid{width:100%;border-collapse:collapse;table-layout:fixed}
.grid th{padding:0 0 8px;font-size:11.5px;font-weight:500;color:var(--text-3)}
.grid td{padding:2px;text-align:center}
.day{position:relative;display:flex;align-items:center;justify-content:center;height:40px;border-radius:var(--radius);font-size:13.5px;font-variant-numeric:tabular-nums;color:var(--text-3)}
a.day{background:var(--chip);color:var(--text);font-weight:600;transition:background-color 120ms ease}
a.day:hover{background:var(--active);text-decoration:none}
a.day:active,.slot:active,.btn:active{scale:.96}
a.day[aria-current]{background:var(--primary);color:var(--on-primary)}
.day.today::after{content:'';position:absolute;bottom:5px;left:50%;width:4px;height:4px;margin-left:-2px;border-radius:50%;background:currentColor}
.times{padding:20px 0;border-top:1px solid var(--border);min-width:0}
.times-head{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px;min-height:28px;padding:0 20px 10px}
.times-head h2{font-size:14px;font-weight:600}
.times-body{padding:0 20px}
.slots{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(92px,1fr));gap:8px}
.slots.wide{grid-template-columns:repeat(auto-fill,minmax(168px,1fr))}
.slot{display:flex;align-items:center;justify-content:center;min-height:40px;padding:4px 10px;border-radius:var(--radius);background:var(--panel);box-shadow:var(--shadow-btn);color:var(--text);font-size:13.5px;font-weight:500;font-variant-numeric:tabular-nums;text-align:center;transition:background-color 120ms ease}
.slot:hover{background:var(--hover);text-decoration:none}
.empty{color:var(--text-2);font-size:13.5px}
[data-swapped] .slots{animation:rise 240ms var(--ease-out-strong)}
@keyframes rise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
@media (min-width:640px){
.month{padding:24px}
.day{height:44px}
#booker{grid-template-columns:minmax(0,1fr) 236px}
.times{contain:size;display:flex;flex-direction:column;padding:24px 0 0;border-top:0;border-left:1px solid var(--border)}
.times-body{flex:1 1 0;min-height:0;overflow-y:auto;padding:4px 20px 32px;scrollbar-width:thin;scrollbar-color:var(--border-strong) transparent;mask-image:linear-gradient(to bottom,#000 calc(100% - 32px),transparent)}
.times .slots{grid-template-columns:minmax(0,1fr)}}
@media (min-width:960px){
.booker-card{grid-template-columns:288px minmax(0,1fr)}
.booker-card>.info{border-bottom:0;border-right:1px solid var(--border)}}
.split{display:grid;grid-template-columns:minmax(0,1fr)}
.split>.info{border-bottom:1px solid var(--border)}
.side{padding:20px;min-width:0}
.side>:first-child{margin-top:0}
@media (min-width:760px){
.split{grid-template-columns:300px minmax(0,1fr)}
.split>.info{border-bottom:0;border-right:1px solid var(--border)}
.side{padding:24px 28px 28px}}
.when{margin-top:16px}
.when-row{display:flex;align-items:flex-start;gap:8px}
.when-row .ic{margin-top:2px}
.when-main{font-size:14px;font-weight:600;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.zone-note{font-size:12.5px;color:var(--text-3)}
.facts{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:4px 16px;margin:12px 0 0;font-size:13.5px}
.facts dt{color:var(--text-2)}
.facts dd{margin:0;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.when .facts{grid-template-columns:minmax(0,1fr);gap:0;margin:10px 0 0 24px;font-size:12.5px}
.when .facts dt{color:var(--text-3)}
.when .facts dd{color:var(--text-2)}
.when .facts dd+dt{margin-top:6px}
.facts.table{gap:0;margin-top:16px}
.facts.table dt,.facts.table dd{padding:10px 0;border-top:1px solid var(--border)}
.facts.table dt{padding-right:16px}
.side h2{font-size:15px;font-weight:600}
.notice+form.book{margin-top:20px}
.field{display:grid;gap:6px;margin-top:16px}
.field label{font-size:13px;font-weight:500}
.hint{font-size:12.5px;color:var(--text-3)}
input[type=text],input[type=email],textarea,select{width:100%;min-height:36px;padding:7px 10px;border:1px solid var(--border-strong);border-radius:var(--radius);background:var(--panel);color:var(--text);font:14px/1.4 var(--font);letter-spacing:-.01em;transition:border-color 120ms ease,box-shadow 120ms ease}
textarea{min-height:96px;resize:vertical}
input:focus-visible,textarea:focus-visible,select:focus-visible{outline:1px solid transparent;border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
input[aria-invalid=true],textarea[aria-invalid=true]{border-color:var(--danger)}
input[aria-invalid=true]:focus-visible,textarea[aria-invalid=true]:focus-visible{border-color:var(--danger);box-shadow:0 0 0 3px var(--red-tint)}
@media (pointer:coarse){input[type=text],input[type=email],textarea,select{min-height:44px;font-size:16px}}
.privacy-line{margin-top:16px;font-size:12.5px;color:var(--text-3)}
.actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:20px}
.side .actions{justify-content:flex-end}
.actions form{margin:0}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:36px;padding:0 14px;border:0;border-radius:var(--radius);font:500 13.5px/1 var(--font);letter-spacing:-.01em;text-decoration:none;white-space:nowrap;cursor:pointer;transition:background-color 120ms ease,filter 120ms ease}
.btn:hover{text-decoration:none}
.btn .ic{color:inherit}
@media (pointer:coarse){.btn{height:44px}}
.btn.primary{background:var(--primary);color:var(--on-primary);box-shadow:inset 0 1px 0 rgba(255,255,255,.14)}
.btn.primary:hover{filter:var(--press)}
.btn.secondary{background:var(--panel);color:var(--text);box-shadow:var(--shadow-btn)}
.btn.secondary:hover{background:var(--hover)}
.btn.ghost{background:transparent;color:var(--text-2)}
.btn.ghost:hover{background:var(--hover);color:var(--text)}
.btn.danger{background:var(--panel);color:var(--danger);box-shadow:0 0 0 1px var(--red-ring)}
.btn.danger:hover{background:var(--red-tint)}
.notice{margin-top:16px;padding:10px 12px;border-radius:var(--radius-card);background:var(--panel-2);box-shadow:0 0 0 1px var(--border);font-size:13.5px}
.notice.error{background:var(--red-tint);box-shadow:none}
.notice.error::before{content:'';display:inline-block;width:8px;height:8px;margin-right:8px;border-radius:50%;background:var(--red);vertical-align:1px}
.notice:focus{outline:none}
.notice p{display:inline}
.notice p+p,.notice ul+p{display:block;margin-top:8px}
.notice .slots{margin-top:12px}
.pill{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 10px;border-radius:9999px;background:var(--chip);color:var(--text-2);font-size:12px;font-weight:500}
.pill::before{content:'';width:6px;height:6px;border-radius:50%;background:currentColor}
.pill.ok{background:var(--green-tint);color:var(--green)}
.pill.wait{background:var(--orange-tint);color:var(--orange)}
.head h1:not(:first-child){margin-top:12px}
.head h1{font-size:20px;line-height:1.3;font-weight:650;letter-spacing:-.02em;overflow-wrap:anywhere}
.lead{margin-top:8px;font-size:14px;color:var(--text-2)}
.small{margin-top:12px;font-size:13px;color:var(--text-2)}
.changes{margin-top:24px;padding-top:20px;border-top:1px solid var(--border)}
.changes h2{font-size:14px;font-weight:600}
.changes .actions{margin-top:12px}
.message{margin:16px 0 0}
.message figcaption{font-size:12.5px;color:var(--text-2)}
.message .quote{margin-top:6px}
.profile{padding:28px 20px 20px}
@media (min-width:640px){.profile{padding:32px 28px 24px}}
.profile h1{margin-top:14px;font-size:22px;line-height:1.25;font-weight:650;letter-spacing:-.02em;overflow-wrap:anywhere}
.types{list-style:none;margin:0;padding:0}
.type{padding:20px;border-top:1px solid var(--border)}
@media (min-width:640px){.type{padding:20px 28px 24px}}
.type h3{font-size:15px;font-weight:600;overflow-wrap:anywhere}
.type h3 a{color:var(--text)}
.label{margin:16px 0 8px;font-size:12px;font-weight:500;color:var(--text-3)}
.more{display:inline-flex;align-items:center;gap:2px;margin-top:14px;font-size:13px;font-weight:500}
.more .ic{width:14px;height:14px;color:inherit}
.foot{width:100%;max-width:var(--w);margin:0 auto;padding:0 16px 32px;font-size:12.5px;color:var(--text-3)}
@media (min-width:640px){.foot{padding:0 28px 40px}}
.foot p{margin-bottom:8px}
.foot-row{display:flex;flex-wrap:wrap;justify-content:space-between;gap:8px 16px}
.foot nav{display:flex;flex-wrap:wrap;gap:4px 16px}
.foot a{display:inline-flex;align-items:center;gap:4px;color:var(--text-2);overflow-wrap:anywhere}
.foot a:hover{color:var(--text)}
.foot a[aria-current]{color:var(--text);font-weight:500;text-decoration:none}
.foot .ic{width:14px;height:14px;color:inherit}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}}
`.trim();

// ---- Icons ----

// Rukoo's own line icons (src/renderer/icons.js): a 24px grid with 1.6px round strokes.
const ICONS = {
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="3"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  globe:
    '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.3 2.4 3.5 5.2 3.5 8.5s-1.2 6.1-3.5 8.5c-2.3-2.4-3.5-5.2-3.5-8.5s1.2-6.1 3.5-8.5z"/>',
  video: '<rect x="3" y="6.5" width="12.5" height="11" rx="2.5"/><path d="m15.5 10.5 5.5-3v9l-5.5-3"/>',
  phone: '<rect x="6.5" y="2.5" width="11" height="19" rx="2.5"/><path d="M10.5 18.5h3"/>',
  pin: '<path d="M12 20.5s-6.5-5.4-6.5-10.5a6.5 6.5 0 0 1 13 0c0 5.1-6.5 10.5-6.5 10.5z"/><circle cx="12" cy="10" r="2.4"/>',
  person: '<circle cx="12" cy="8.5" r="3.8"/><path d="M4.5 20a7.5 7.5 0 0 1 15 0"/>',
  sparkle: '<path d="M10.5 4.5Q11.2 12.3 19 13 11.2 13.7 10.5 21.5 9.8 13.7 2 13 9.8 12.3 10.5 4.5z"/><path d="M18.5 3v4.5M16.25 5.25h4.5"/>',
  prev: '<path d="m14 7-5 5 5 5"/>',
  next: '<path d="m10 7 5 5-5 5"/>'
};

function icon(name) {
  return `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICONS[name]}</svg>`;
}

const LOCATION_ICONS = { googleMeet: 'video', link: 'video', phone: 'phone', inPerson: 'pin' };

// ---- The host's monogram ----

// The app's monogram (src/renderer/ui.js): initials on a tint of a hue that follows from the name.
function hue(text) {
  let h = 7;
  for (const c of String(text || '').toLowerCase()) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

function initials(name) {
  const words = String(name || '?')
    .replace(/\(.*?\)|["'<>[\]]/g, ' ')
    .trim()
    .split(/[\s._-]+/)
    .filter(Boolean);
  const first = [...(words[0] || '?')];
  const last = words.length > 1 ? [...words[words.length - 1]] : [];
  return (first[0] + (last[0] || first[1] || '')).toUpperCase();
}

function avatarHtml(name, size = '') {
  return `<span class="avatar${size}" style="--h:${hue(name)}" aria-hidden="true">${esc(initials(name))}</span>`;
}

// The host's monogram and name; link: the host's landing page, when the name leads back to it.
function hostHtml(profile, link = null) {
  const name = link ? `<a href="${esc(link)}">${esc(profile.name)}</a>` : `<span>${esc(profile.name)}</span>`;
  return `<p class="host">${avatarHtml(profile.name)}${name}</p>`;
}

// ---- Links ----

// A path with query parameters; empty values are left out. Values are percent-encoded as llms.txt tells
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

// ctx: what web.js context() returns. main: the markup in <main>. switchable: a page opened with GET, which booker.js
// may load again in the browser's zone or with the remembered clock. width: 'wide' for the booker, 'mid' for pages
// in two columns or a list, 'narrow' for a single card.
//
// The icons (icons.js): the .ico holds 16 and 32 pixels but says 32x32, because Chromium takes an exact 16x16 for a tab
// over the SVG, which follows the browser's light or dark theme.
export function documentHtml(ctx, { title, main, switchable = false, footer = 'full', width = 'narrow' }) {
  const attrs = [`lang="${ctx.lang}"`, `data-zone="${esc(ctx.zone)}"`, `data-clock="${ctx.clock}"`];
  if (switchable) attrs.push('data-switch');
  if (ctx.zoneAuto) attrs.push('data-auto-zone');
  if (ctx.clockAuto) attrs.push('data-auto-clock');
  const guide = ctx.guide ? `\n<link rel="alternate" type="text/markdown" href="${esc(ctx.guide)}" title="${esc(ctx.T('page.assistants'))}">` : '';
  return `<!doctype html>
<html ${attrs.join(' ')}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="referrer" content="same-origin">
<title>${esc(title)}</title>
<link rel="icon" href="${esc(ctx.icons)}favicon.ico" sizes="32x32">
<link rel="icon" href="${esc(ctx.icons)}favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="${esc(ctx.icons)}apple-touch-icon.png">
<link rel="preload" href="${esc(ctx.fonts)}${MAIN_FONT}" as="font" type="font/woff2" crossorigin>${guide}
<style>${fontFaces(ctx.fonts)}
${CSS}</style>
<script src="${esc(ctx.script)}"></script>
</head>
<body>
<main class="wrap ${width}">
${main}
</main>
${footerHtml(ctx, footer, width)}
<p id="live" class="sr-only" aria-live="polite"></p>
</body>
</html>
`;
}

// footer: 'full' on public pages; 'keyed' on pages whose address holds a manage key, which link nowhere else.
function footerHtml(ctx, footer, width) {
  const out = [`<footer class="foot ${width}">`];
  const links = [];
  if (footer === 'full') {
    // Always shown: the host chooses their own name, so it can't decide whether the page says who made it.
    const operator = ctx.operator.name || ctx.T('page.operator');
    if (ctx.host) out.push(`<p>${ctx.H('page.madeBy', { host: esc(ctx.host), operator: esc(operator) })}</p>`);
    if (ctx.operator.privacy) links.push(`<a href="${esc(ctx.operator.privacy)}" rel="noreferrer">${esc(ctx.T('page.privacy'))}</a>`);
    const report = reportLink(ctx);
    if (report) links.push(`<a href="${esc(report)}" rel="noreferrer">${esc(ctx.T('page.report'))}</a>`);
    // The one thing on the page for assistants: their guide, with the open times and how to book.
    if (ctx.guide) links.push(`<a href="${esc(ctx.guide)}">${icon('sparkle')}${esc(ctx.T('page.assistants'))}</a>`);
  } else if (ctx.operator.privacy && sameOrigin(ctx.operator.privacy, ctx.url)) {
    links.push(`<a href="${esc(ctx.operator.privacy)}">${esc(ctx.T('page.privacy'))}</a>`);
  }
  const langs = LANGUAGES.map((l) => {
    const current = l === ctx.lang ? ' aria-current="true"' : '';
    return `<a href="${esc(ctx.languageLink(l))}" lang="${l}" hreflang="${l}"${current}>${esc(LANGUAGE_NAMES[l])}</a>`;
  });
  out.push('<div class="foot-row">');
  out.push(links.length ? `<nav>${links.join('\n')}</nav>` : '<span></span>');
  out.push(`<nav aria-label="${esc(ctx.T('page.language'))}">${langs.join('\n')}</nav>`);
  out.push('</div>', '</footer>');
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

// A type's length, place and whether the host confirms each booking, each with its icon.
function detailsHtml(ctx, type, approval, { inline = false } = {}) {
  const items = [['clock', ctx.T('type.minutes', { n: type.duration })]];
  const where = locationText(ctx, type.location);
  if (where) items.push([LOCATION_ICONS[type.location.kind] ?? 'pin', where]);
  if (approval) items.push(['person', ctx.T('type.approval', { host: ctx.host })]);
  return `<ul class="details${inline ? ' inline' : ''}">${items.map(([name, text]) => `<li>${icon(name)}<span>${esc(text)}</span></li>`).join('')}</ul>`;
}

function quoteHtml(text) {
  return text ? `<blockquote class="quote">${esc(text)}</blockquote>` : '';
}

// The host's intro, right under their name, so it needs no quote bar to say whose it is.
function introHtml(text) {
  return text ? `<blockquote class="intro">${esc(text)}</blockquote>` : '';
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

// The zone line with its picker; the offset never breaks at its minus. params: the page's own query, kept by the form. booker.js swaps #zone along with
// the booker, so the form keeps the month and day the guest went to.
function zoneHtml(ctx, { path, params, at }) {
  const hidden = hiddenInputs(Object.fromEntries(Object.entries(params).filter(([k]) => k !== 'tz' && k !== 'clock')));
  const clockHidden = hiddenInputs({ clock: params.clock });
  const options = zoneList(ctx.zone)
    .map((z) => `<option value="${esc(z)}"${z === ctx.zone ? ' selected' : ''}>${esc(z.replace(/_/g, ' '))}</option>`)
    .join('');
  return `<details class="zone" id="zone">
<summary>${icon('globe')}<span><span>${ctx.H('booker.zone', { zone: esc(ctx.zone), offset: `<span class="nowrap">${offsetText(at, ctx.zone)}</span>` })}</span><span class="change">${esc(ctx.T('booker.change'))}</span></span></summary>
<form method="get" action="${esc(path)}">
<label for="tz">${esc(ctx.T('booker.zoneLabel'))}</label>
<select id="tz" name="tz">${options}</select>${hidden}${clockHidden}
<button class="btn secondary" type="submit">${esc(ctx.T('booker.zoneSubmit'))}</button>
</form>
</details>`;
}

// The 12/24 h switch, as links that keep the page's own query.
function clockHtml(ctx, { path, params }) {
  const link = (c) => {
    const current = c === ctx.clock ? ' aria-current="true"' : '';
    return `<a href="${esc(href(path, { ...params, clock: c }))}" data-clock="${c}"${current}>${esc(ctx.T(`booker.clock${c}`))}</a>`;
  };
  return `<div class="seg" role="group" aria-label="${esc(ctx.T('booker.clock'))}">${link('24')}${link('12')}</div>`;
}

// The zone and the clock side by side, for pages without a booker.
function barHtml(ctx, { path, params, at }) {
  return `<div class="bar">${zoneHtml(ctx, { path, params, at })}${clockHtml(ctx, { path, params })}</div>`;
}

let ZONES = null;
function zoneList(current) {
  if (!ZONES) {
    const all = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
    ZONES = [...new Set(['UTC', ...all])].sort();
  }
  return ZONES.includes(current) ? ZONES : [current, ...ZONES];
}

// The chosen time in the page's zone, then the host's and UTC where they differ.
function whenHtml(ctx, { start, end, hostZone, host }) {
  const out = ['<section class="when" aria-labelledby="when-title">', `<h2 id="when-title" class="sr-only">${esc(ctx.T('form.when'))}</h2>`];
  out.push(
    `<div class="when-row">${icon('calendar')}<div><p class="when-main">${esc(ctx.f.when(start, end))}</p><p class="zone-note">${esc(zoneText(ctx.zone, start))}</p></div></div>`
  );
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

// The left column of a page about one type: the host, the type, and the chosen time when there is one.
function infoHtml(ctx, { profile, type, back, approval, when = null }) {
  const out = ['<header class="info">', hostHtml(profile, back), `<h1>${esc(type.title)}</h1>`];
  if (when) out.push(whenHtml(ctx, { ...when, hostZone: profile.timeZone, host: profile.name }));
  out.push(detailsHtml(ctx, type, approval), '</header>');
  return out.join('\n');
}

// ---- Pages ----

// The landing page with several visible types (or none): the host, their intro, each type with its next open times.
export function landingHtml(ctx, { profile, types, slots, approval }) {
  const parts = ['<div class="card">', '<header class="profile">', avatarHtml(profile.name, ' lg'), `<h1>${esc(profile.name)}</h1>`, introHtml(profile.intro)];
  if (!types.length) {
    parts.push(noticeHtml([esc(ctx.T('landing.noTypes'))]), '</header>');
  } else {
    parts.push(barHtml(ctx, { path: ctx.base, params: { ...ctx.keep }, at: Date.now() }), '</header>');
    parts.push(`<h2 class="sr-only">${esc(ctx.T('landing.pick'))}</h2>`, '<ul class="types">');
    for (const t of types) {
      const typePath = `${ctx.base}/${t.slug}`;
      const next = (slots[t.slug] ?? []).slice(0, 3);
      parts.push('<li class="type">');
      parts.push(`<h3><a href="${esc(href(typePath, ctx.keep))}">${esc(t.title)}</a></h3>`);
      parts.push(detailsHtml(ctx, t, approval(t), { inline: true }));
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
      parts.push(`<a class="more" href="${esc(href(typePath, ctx.keep))}">${esc(ctx.T('landing.all'))}${icon('next')}</a>`);
      parts.push('</li>');
    }
    parts.push('</ul>');
  }
  parts.push('</div>');
  return documentHtml(ctx, { title: ctx.T('page.title', { host: profile.name }), main: parts.filter(Boolean).join('\n'), switchable: true, width: 'mid' });
}

// The booker: the host and the type, a month with the days that have open times, and the times of the chosen day.
// With one visible type it is the landing page too, with the host's intro. reschedule: { booking, key } while a
// guest picks a new time.
export function bookerHtml(ctx, v) {
  const { profile, type, landing, reschedule } = v;
  // The host's name leads back to the landing page, except on it and while a guest moves a booking.
  const back = landing || reschedule ? null : href(ctx.base, ctx.keep);
  const notices = [];
  if (reschedule) notices.push(esc(ctx.T('reschedule.pick', { time: ctx.f.whenText(reschedule.booking.start, reschedule.booking.end) })));
  if (v.badSlot) notices.push(esc(ctx.T('form.badSlot')));
  const at = v.date ? zonedInstant(v.date, '12:00', ctx.zone) : Date.now();
  const info = [
    '<header class="info">',
    hostHtml(profile, back),
    landing ? introHtml(profile.intro) : '',
    `<h1>${esc(type.title)}</h1>`,
    detailsHtml(ctx, type, v.approval),
    quoteHtml(type.description),
    noticeHtml(notices, { error: Boolean(v.badSlot) }),
    zoneHtml(ctx, { path: v.path, params: { ...v.keep, month: v.month, date: v.date }, at }),
    '</header>'
  ];
  const main = ['<div class="card booker-card">', info.filter(Boolean).join('\n'), `<div id="booker">${bookerBody(ctx, v)}</div>`, '</div>'];
  const title = landing ? ctx.T('page.title', { host: profile.name }) : `${type.title} · ${profile.name}`;
  return documentHtml(ctx, { title, main: main.join('\n'), switchable: true, footer: reschedule ? 'keyed' : 'full', width: 'wide' });
}

// The part of the booker that booker.js swaps when a day or month changes: the month and the day's times.
function bookerBody(ctx, v) {
  const { month, days, date, times, first, prevMonth, nextMonth, path, keep } = v;
  const monthTitle = ctx.f.month(month);
  const nav = (dir, target) => {
    const label = esc(ctx.T(dir === 'prev' ? 'booker.prev' : 'booker.next'));
    if (!target) return `<span class="nav" aria-hidden="true">${icon(dir)}</span>`;
    return `<a class="nav" href="${esc(href(path, { ...keep, month: target }))}" data-swap="${dir}" aria-label="${label}" title="${label}">${icon(dir)}</a>`;
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

  // The day's heading carries the clock switch, which only matters while there are times to read.
  const dayHead = (clock) =>
    `<div class="times-head"><h2 id="times-title">${esc(ctx.f.date(date))}</h2>${clock ? clockHtml(ctx, { path, params: { ...keep, month, date } }) : ''}</div>`;
  let day;
  let status;
  if (first === null) {
    status = ctx.T('booker.none');
    day = `<div class="times-body"><p class="empty">${esc(status)}</p>${contactHtml(ctx, v.profile)}</div>`;
  } else if (!date) {
    status = ctx.T('booker.noMonth', { month: ctx.f.monthText(month) });
    day = `<div class="times-body"><p class="empty">${esc(status)}</p></div>`;
  } else if (!times.length) {
    status = ctx.T('booker.noDay', { date: ctx.f.dateText(date) });
    day = `${dayHead(false)}<div class="times-body"><p class="empty">${esc(status)}</p></div>`;
  } else {
    status = ctx.T(times.length === 1 ? 'booker.timesOne' : 'booker.timesMany', { count: times.length, date: ctx.f.dateText(date) });
    const items = times.map((s) => {
      const link = href(v.slotPath ?? path, { ...keep, slot: slotParam(s) });
      const label = `${ctx.f.date(date)}, ${ctx.f.time(s)}`;
      return `<li><a class="slot" href="${esc(link)}" aria-label="${esc(label)}">${esc(ctx.f.time(s))}</a></li>`;
    });
    day = `${dayHead(true)}<div class="times-body"><ul class="slots" aria-label="${esc(ctx.T('booker.times'))}">${items.join('')}</ul></div>`;
  }
  return `<section class="month" aria-labelledby="month-title">
<div class="month-bar"><h2 id="month-title">${esc(monthTitle)}</h2>${nav('prev', prevMonth)}${nav('next', nextMonth)}</div>
<table class="grid"><caption class="sr-only">${esc(ctx.T('booker.days'))}</caption><thead><tr>${head}</tr></thead><tbody>${rows.join('')}</tbody></table>
</section>
<section class="times" data-status="${esc(status)}">
${day}
</section>`;
}

// The filled-in form for one time (a prepared link, or the form again after a refused booking), or, when the time is
// gone, the nearest open times as links that keep what was filled in.
export function formHtml(ctx, v) {
  const { profile, type, start, end, fields } = v;
  const path = `${ctx.base}/${type.slug}`;
  const info = infoHtml(ctx, { profile, type, back: href(v.multiple ? ctx.base : path, ctx.keep), approval: v.approval, when: { start, end } });
  const side = ['<div class="side">'];
  if (v.filled && v.open && !v.error) side.push(noticeHtml([esc(ctx.T('form.filled'))]));
  // Focus goes to the field that was wrong, or to the notice when no field was.
  const onField = v.open && FIELDS.includes(v.error?.field);
  if (v.error) side.push(noticeHtml([esc(v.error.message)], { error: true, alert: true, id: 'form-error', focus: !onField }));
  const other = href(path, ctx.keep);
  if (!v.open) {
    side.push(alternativesHtml(ctx, { path, alternatives: v.alternatives, params: { ...ctx.keep, ...fieldParams(fields) }, gone: !v.error }));
    side.push(`<p class="small"><a href="${esc(other)}">${esc(ctx.T('form.other'))}</a></p>`);
  } else {
    side.push(bookFormHtml(ctx, v, path, other));
  }
  side.push('</div>');
  const main = ['<div class="card split">', info, side.join('\n'), '</div>'];
  return documentHtml(ctx, { title: `${type.title} · ${profile.name}`, main: main.join('\n'), switchable: v.switchable, width: 'mid' });
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

function bookFormHtml(ctx, v, path, other) {
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
  if (v.approval) out.push(`<p class="small">${esc(ctx.T(v.profile.invites === false ? 'form.approvalNoInvitation' : 'form.approval', { host }))}</p>`);
  out.push(`<p class="privacy-line">${ctx.H('form.privacy', { host: esc(host), operator: esc(operator) })}${privacy}</p>`);
  out.push(
    `<div class="actions"><a class="btn ghost" href="${esc(other)}">${esc(ctx.T('form.other'))}</a><button class="btn primary" type="submit">${esc(ctx.T('form.book'))}</button></div>`,
    '</form>'
  );
  return out.join('\n');
}

// After a booking for the same time and email as an active one: no key comes back, so the page says where it is.
export function alreadyHtml(ctx, { profile, type, start, end, email }) {
  const path = `${ctx.base}/${type.slug}`;
  const main = [
    '<div class="card split">',
    infoHtml(ctx, { profile, type, back: href(ctx.base, ctx.keep), approval: false, when: { start, end } }),
    '<div class="side">',
    noticeHtml([esc(ctx.T(profile.invites === false ? 'form.alreadyNoInvitation' : 'form.already', { email, host: profile.name }))]),
    `<p class="small"><a href="${esc(href(path, ctx.keep))}">${esc(ctx.T('form.other'))}</a></p>`,
    '</div>',
    '</div>'
  ];
  return documentHtml(ctx, { title: `${type.title} · ${profile.name}`, main: main.join('\n'), width: 'mid' });
}

// Moving a booking: the old and the new time, and one button that moves it.
export function rescheduleHtml(ctx, v) {
  const { profile, type, booking, key, start, end } = v;
  const manage = href(`${ctx.base}/booking/${booking.id}`, { k: key, ...ctx.keep });
  const typePath = `${ctx.base}/${type.slug}`;
  const side = ['<div class="side">'];
  if (v.error) side.push(noticeHtml([esc(v.error.message)], { error: true, alert: true, focus: true }));
  if (!v.open) {
    side.push(alternativesHtml(ctx, { path: typePath, alternatives: v.alternatives, params: { ...ctx.keep, reschedule: booking.id, k: key }, gone: !v.error }));
  } else {
    side.push(`<h2 class="when">${esc(ctx.T('reschedule.confirm'))}</h2>`);
    side.push(
      `<dl class="facts table"><dt>${esc(ctx.T('reschedule.now'))}</dt><dd>${esc(ctx.f.when(booking.start, booking.end))}</dd><dt>${esc(ctx.T('reschedule.new'))}</dt><dd><strong>${esc(ctx.f.when(start, end))}</strong></dd></dl>`,
      `<p class="zone-note">${esc(zoneText(ctx.zone, start))}</p>`
    );
    const inputs = hiddenInputs({ k: key, action: 'reschedule', start: slotParam(start), tz: ctx.zone, lang: ctx.keep.lang, clock: ctx.keep.clock });
    side.push(
      `<div class="actions"><a class="btn ghost" href="${esc(manage)}">${esc(ctx.T('reschedule.keep'))}</a><form method="post" action="${esc(`${ctx.base}/booking/${booking.id}`)}">${inputs}<button class="btn primary" type="submit">${esc(ctx.T('reschedule.move'))}</button></form></div>`
    );
  }
  side.push(`<p class="small"><a href="${esc(href(typePath, { ...ctx.keep, reschedule: booking.id, k: key }))}">${esc(ctx.T('form.other'))}</a></p>`, '</div>');
  const main = ['<div class="card split">', infoHtml(ctx, { profile, type, back: null, approval: false }), side.join('\n'), '</div>'];
  return documentHtml(ctx, { title: `${type.title} · ${profile.name}`, main: main.join('\n'), switchable: v.switchable, footer: 'keyed', width: 'mid' });
}

const STATUS_TONE = { confirmed: 'ok', pending: 'wait' };

// invites: false when the host's calendar sends no invitations; this page is then the guest's only record.
function statusLines(ctx, booking, host, over, invites = true) {
  switch (booking.status) {
    case 'confirmed':
      return [over ? ctx.T('manage.over') : ctx.T(invites ? 'manage.invitation' : 'manage.noInvitation', { host })];
    case 'pending': {
      const lines = [ctx.T(invites ? 'manage.pending' : 'manage.pendingNoInvitation', { host })];
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
  const parts = ['<div class="card pad">'];
  if (v.error) parts.push(noticeHtml([esc(v.error.message)], { error: true, alert: true, focus: true }));
  parts.push('<header class="head">');
  parts.push(`<p class="pill ${STATUS_TONE[booking.status] ?? 'gone'}">${esc(ctx.T(`manage.status.${booking.status}`, { host }))}</p>`);
  parts.push(`<h1>${esc(ctx.T('manage.with', { type: type?.title ?? booking.type, host }))}</h1>`);
  parts.push('</header>');
  parts.push(
    statusLines(ctx, booking, host, over, profile?.invites !== false)
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
  parts.push(`<dl class="facts table">${facts.join('')}</dl>`);

  if (booking.message) {
    parts.push(`<figure class="message"><figcaption>${esc(ctx.T('manage.message', { host }))}</figcaption>${quoteHtml(booking.message)}</figure>`);
  }
  if (booking.status === 'confirmed' && !over) {
    parts.push(`<div class="actions"><a class="btn secondary" href="${esc(href(`${path}.ics`, { k: key }))}">${icon('calendar')}${esc(ctx.T('manage.ics'))}</a></div>`);
  }

  if (active && !over) {
    parts.push(`<section class="changes" aria-labelledby="changes-title"><h2 id="changes-title">${esc(ctx.T('manage.changes'))}</h2>`);
    parts.push(`<p class="small">${esc(ctx.T('manage.keep'))}</p>`);
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

// The top of a page with one short message: the host's monogram when there is a host, and the name or the page's.
function plainHead(ctx, profile) {
  return ['<header class="head">', profile ? avatarHtml(profile.name, ' lg') : '', `<h1>${esc(profile ? profile.name : ctx.T('page.anon'))}</h1>`, '</header>']
    .filter(Boolean)
    .join('');
}

// A page that isn't taking bookings: off, or deleted with its handle still reserved. With a profile it names the host
// and shows their contact line.
export function offHtml(ctx, profile) {
  const main = ['<div class="card pad">', plainHead(ctx, profile)];
  main.push(`<p class="lead">${esc(profile ? ctx.T('off.host', { host: profile.name }) : ctx.T('off.anon'))}</p>`, contactHtml(ctx, profile), '</div>');
  return documentHtml(ctx, { title: profile ? profile.name : ctx.T('page.anon'), main: main.filter(Boolean).join('\n') });
}

// A page, type or booking that isn't there. Unknown, reserved and blocked handles all get the same page.
export function missingHtml(ctx, { kind = 'page', profile = null } = {}) {
  const text = { page: 'off.anon', type: 'missing.type', booking: 'missing.booking' }[kind];
  const main = ['<div class="card pad">', plainHead(ctx, profile)];
  main.push(`<p class="lead">${esc(ctx.T(text))}</p>`);
  if (kind === 'type' && profile) main.push(`<p class="small"><a href="${esc(href(ctx.base, ctx.keep))}">${esc(ctx.T('missing.allTypes'))}</a></p>`);
  main.push('</div>');
  return documentHtml(ctx, { title: profile ? profile.name : ctx.T('page.anon'), main: main.join('\n'), footer: kind === 'booking' ? 'keyed' : 'full' });
}

// A form post refused before its page was read: from another website, too big, or the wrong kind of body.
export function refusedHtml(ctx, message) {
  const main = ['<div class="card pad">', plainHead(ctx, null), noticeHtml([esc(message)], { error: true, alert: true, focus: true }), '</div>'];
  return documentHtml(ctx, { title: ctx.T('page.anon'), main: main.join('\n'), footer: 'keyed' });
}

// The body of a page's redirect to its new handle, for clients that show it instead of following.
export function movedHtml(ctx, to) {
  const main = `<div class="card pad"><p class="lead">${ctx.H('page.moved', { url: `<a href="${esc(to)}">${esc(to)}</a>` })}</p></div>`;
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
