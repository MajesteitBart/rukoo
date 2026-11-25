'use strict';

// mailto: links (RFC 6068), from a link in a message, an unsubscribe header, another app or the Windows shell.
// Only the fields a new message starts with are read; anything else, attach= included, is ignored.

const MAX_RECIPIENTS = 100;

function isMailto(url) {
  return /^mailto:/i.test(String(url || ''));
}

// Percent-decoding that keeps a malformed escape as it is instead of dropping the whole link. A "+" stays a plus:
// mailto: is not a form encoding.
function decode(text) {
  try {
    return decodeURIComponent(text);
  } catch (_) {
    return text.replace(/(?:%[0-9a-f]{2})+/gi, (run) => {
      try {
        return decodeURIComponent(run);
      } catch (_) {
        return run;
      }
    });
  }
}

// "a@x.nl, Name <b@x.nl>, \"Last, First\" <c@x.nl>" into { name, address } entries.
function addresses(text) {
  const out = [];
  for (const part of String(text).match(/(?:"[^"]*"|<[^>]*>|[^,])+/g) || []) {
    const item = part.trim();
    if (!item) continue;
    const m = item.match(/^(.*?)<([^>]+)>$/);
    const address = (m ? m[2] : item).trim();
    if (address) out.push({ name: m ? m[1].trim().replace(/^"(.*)"$/, '$1') : '', address });
  }
  return out;
}

// { to, cc, bcc, subject, body } for a new message; empty fields for anything that is not a mailto: link.
function parse(url) {
  const out = { to: [], cc: [], bcc: [], subject: '', body: '' };
  const text = String(url || '');
  if (!isMailto(text)) return out;
  const rest = text.slice('mailto:'.length).split('#')[0];
  const q = rest.indexOf('?');
  out.to.push(...addresses(decode(q < 0 ? rest : rest.slice(0, q))));
  for (const pair of q < 0 ? [] : rest.slice(q + 1).split('&')) {
    const eq = pair.indexOf('=');
    const name = decode(eq < 0 ? pair : pair.slice(0, eq)).toLowerCase();
    const value = decode(eq < 0 ? '' : pair.slice(eq + 1));
    if (name === 'to' || name === 'cc' || name === 'bcc') out[name].push(...addresses(value));
    // The first subject and body count; RFC 6068 leaves repeats undefined.
    else if ((name === 'subject' || name === 'body') && !out[name]) out[name] = value;
  }
  // Line breaks arrive as %0D%0A; the editor breaks lines at \n.
  out.body = out.body.replace(/\r\n?/g, '\n');
  for (const field of ['to', 'cc', 'bcc']) out[field] = out[field].slice(0, MAX_RECIPIENTS);
  return out;
}

// The first mailto: link among command line arguments, as Windows passes one to the app it opens it with.
function fromArgs(args) {
  return (Array.isArray(args) ? args : []).slice(1).find(isMailto) || null;
}

// Email links opened while Mail is turned off (Settings > General > Tabs), each under an id until the notice's Turn on
// takes it (main.js offerHiddenMode, openHeldMailto). A link holds recipients and a body, so it doesn't stay: the
// window drops it when its notice goes, it expires by itself after ttl ms in case the window can't say so, and only
// the last few are kept.
class HeldLinks {
  constructor({ limit = 5, ttl = 120000 } = {}) {
    this.limit = limit;
    this.ttl = ttl;
    this.links = new Map();
    this.seq = 0;
  }

  get size() {
    return this.links.size;
  }

  hold(url) {
    const id = String(++this.seq);
    const timer = setTimeout(() => this.drop(id), this.ttl);
    if (timer.unref) timer.unref();
    this.links.set(id, { url, timer });
    while (this.links.size > this.limit) this.drop(this.links.keys().next().value);
    return id;
  }

  // The link under id, once; null when it went.
  take(id) {
    const entry = this.links.get(String(id));
    if (!entry) return null;
    this.drop(id);
    return entry.url;
  }

  drop(id) {
    const entry = this.links.get(String(id));
    if (!entry) return;
    clearTimeout(entry.timer);
    this.links.delete(String(id));
  }

  clear() {
    for (const id of [...this.links.keys()]) this.drop(id);
  }
}

module.exports = { isMailto, parse, fromArgs, HeldLinks };
