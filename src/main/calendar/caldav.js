'use strict';

const { t } = require('../../i18n');

// CalDAV calendars (RFC 4791), for accounts with a calendar server in their Server settings. Rukoo signs in with the
// account's own username and password and finds the calendars from the address the user gave (RFC 6764). It reads
// each event whole, as an iCalendar object; ics.js expands a recurring one into its occurrences and makes the changes,
// which go back to the server only over the version the user saw. Guests can be invited where the server sends the
// invitations itself (RFC 6638), as its DAV header says or as the user set in Server settings.
// https://www.rfc-editor.org/rfc/rfc4791 https://www.rfc-editor.org/rfc/rfc6764 https://www.rfc-editor.org/rfc/rfc6638
const crypto = require('crypto');
const { DOMParser } = require('@xmldom/xmldom');
const { calendarError, maybeWritten } = require('./google');
const { isZone, pcZone } = require('./zone');
const ics = require('./ics');

const DAV = 'DAV:';
const CAL = 'urn:ietf:params:xml:ns:caldav';
const APPLE = 'http://apple.com/ns/ical/';
const CS = 'http://calendarserver.org/ns/';
const TIMEOUT = 20000;
const REDIRECTS = 5;
// Requests that follow a redirect. A change only goes to the address it was made for.
const FOLLOW = new Set(['GET', 'PROPFIND', 'REPORT']);
const ICS = 'text/calendar; charset=utf-8';
const XML = 'application/xml; charset=utf-8';

// ---------- addresses ----------

const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|\[::1\])$/i;

// Rukoo only sends a password over an encrypted connection; plain http is for a server on this PC.
function allowed(u) {
  return u.protocol === 'https:' || (u.protocol === 'http:' && LOOPBACK.test(u.hostname));
}

// The address from Server settings: a host name, a host with a path, or a whole URL. Without a scheme it is https.
function serverUrl(text) {
  let s = String(text || '').trim();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  let u;
  try {
    u = new URL(s);
  } catch (_) {
    throw calendarError('invalid_url', t('errors.caldav.invalidUrl'));
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw calendarError('invalid_url', t('errors.caldav.invalidUrl'));
  if (!allowed(u)) throw calendarError('insecure', t('errors.caldav.insecure'));
  u.username = '';
  u.password = '';
  u.hash = '';
  return u.toString();
}

function resolve(href, base) {
  try {
    const u = new URL(href, base);
    u.hash = '';
    return u.toString();
  } catch (_) {
    return null;
  }
}

// A collection's address ends in a slash, so the names of the events in it resolve inside it.
const collection = (url) => (url.endsWith('/') ? url : `${url}/`);

// A file name for an object Rukoo names after a UID it didn't make up itself (a booking's, a split series'): the same
// UID always gives the same name, so a write tried again finds the object it made.
const nameFor = (uid) => crypto.createHash('sha256').update(String(uid)).digest('hex').slice(0, 32);

// ---------- XML ----------

function elements(node) {
  const out = [];
  for (let n = node && node.firstChild; n; n = n.nextSibling) if (n.nodeType === 1) out.push(n);
  return out;
}
const kids = (node, ns, name) => elements(node).filter((n) => n.namespaceURI === ns && n.localName === name);
const kid = (node, ns, name) => kids(node, ns, name)[0] || null;
const textOf = (node) => (node ? String(node.textContent || '').trim() : '');
const okStatus = (status) => /^HTTP\/[\d.]+\s+2\d\d\b/i.test(status);

// The responses in a 207 Multi-Status: each one's address, resolved against the request's, and the properties the
// server could give for it.
function multistatus(text, base) {
  let doc = null;
  try {
    doc = new DOMParser({ onError: () => {} }).parseFromString(String(text || ''), 'application/xml');
  } catch (_) {
    // Not XML; said below.
  }
  const root = doc && doc.documentElement;
  if (!root || root.namespaceURI !== DAV || root.localName !== 'multistatus') throw calendarError('bad_answer', t('errors.caldav.badAnswer'));
  return kids(root, DAV, 'response').map((r) => {
    const props = new Map();
    for (const ps of kids(r, DAV, 'propstat')) {
      if (!okStatus(textOf(kid(ps, DAV, 'status')))) continue;
      for (const p of elements(kid(ps, DAV, 'prop'))) props.set(`${p.namespaceURI} ${p.localName}`, p);
    }
    return { href: resolve(textOf(kid(r, DAV, 'href')), base), props };
  });
}

const prop = (r, ns, name) => r.props.get(`${ns} ${name}`) || null;

// The first address inside a property such as current-user-principal or calendar-home-set.
function hrefIn(r, ns, name, base) {
  const p = prop(r, ns, name);
  const h = p && kid(p, DAV, 'href');
  return h ? resolve(textOf(h), base) : null;
}

const propfind = (props) =>
  `<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:" xmlns:c="${CAL}" xmlns:a="${APPLE}" xmlns:cs="${CS}"><d:prop>${props}</d:prop></d:propfind>`;
const FIND_HOME = propfind('<d:current-user-principal/><c:calendar-home-set/>');
const LIST = propfind(
  '<d:resourcetype/><d:displayname/><c:supported-calendar-component-set/><d:current-user-privilege-set/><a:calendar-order/><a:calendar-color/><c:calendar-timezone/><c:calendar-timezone-id/><cs:shared-url/>'
);

// A calendar's colour as servers keep it for Apple's apps: #RRGGBB, often with an alpha after it (#RRGGBBAA).
function colorOf(r) {
  const m = /^#?([0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(textOf(prop(r, APPLE, 'calendar-color')));
  return m ? `#${m[1].toLowerCase()}` : null;
}

// A calendar's own time zone: its id (RFC 7809), or the TZID of the definition it keeps; only a zone the PC knows.
function zoneOf(r) {
  const id = textOf(prop(r, CAL, 'calendar-timezone-id'));
  if (id && isZone(id)) return id;
  const m = /^TZID[^:\r\n]*:([^\r\n]+)$/im.exec(textOf(prop(r, CAL, 'calendar-timezone')));
  const tzid = m ? m[1].trim() : '';
  return tzid && isZone(tzid) ? tzid : null;
}

// ---------- times ----------

const utcStamp = ics.utcStamp;

// ---------- errors ----------

// Each error keeps the status, so a server error after a write (5xx) can be told from a refusal (4xx).
function httpError(status, { write = false } = {}) {
  const error = (code, message) => calendarError(code, message, { status });
  if (status === 401) return error('password', t('errors.caldav.signIn'));
  if (status === 403 && write) return error('read_only', t('errors.calendar.readOnly'));
  if (status === 404 || status === 410) return error('not_found', t('errors.calendar.notFound'));
  // If-Match failed: the event changed since the version the user saw.
  if (status === 412) return error('changed', t('errors.calendar.changed'));
  if (status === 429 || status === 503) return error('busy', t('errors.caldav.busy'));
  return error('request', t('errors.caldav.request', { reason: status }));
}

const changed = () => calendarError('changed', t('errors.calendar.changed'));
const notFound = () => calendarError('not_found', t('errors.calendar.notFound'));

// ---------- the calendar ----------

class CalDavCalendar {
  // url: the address from Server settings. home: the calendar home found from it before, or null.
  // credentials: () => ({ user, password }). addresses: () => the account's own addresses, to find the user among guests;
  // the first one organizes the meetings the user invites guests to.
  // onHome(home): called when the home had to be found again, so the account remembers it.
  // invites: () => 'provider' | 'none' | null, whether the server sends invitations as the user set it in Server
  // settings; null leaves it to the server's DAV header. timeZone: () => the zone new events are written in.
  constructor({ url, home = null, credentials, addresses = () => [], onHome = () => {}, fetchImpl = (...a) => fetch(...a), invites = () => null, timeZone = () => pcZone() }) {
    this.url = url;
    this.home = home;
    this.credentials = credentials;
    this.addresses = addresses;
    this.onHome = onHome;
    this.fetch = fetchImpl;
    this.invites = invites;
    this.timeZone = timeZone;
    // Every calendar object has an etag, and a change can be made to apply only to that version. A series is one
    // object, so deleting it can be made to apply only to the version the user saw as well.
    this.versioned = true;
    this.versionedSeries = true;
  }

  me() {
    return new Set((this.addresses() || []).map((a) => String(a || '').toLowerCase()).filter(Boolean));
  }

  // The user as the organizer of the meetings they invite guests to.
  organizer() {
    const [address] = this.me();
    return address ? { address, name: '' } : null;
  }

  zone() {
    const zone = this.timeZone();
    return zone === 'UTC' || isZone(zone) ? zone : 'UTC';
  }

  ctx(cal, href, etag) {
    return { cal, href, etag: etag || null, me: this.me() };
  }

  // Rukoo sends the password only to the server from Server settings. A redirect, or an address in an answer, that
  // leads to another host is refused before anything is sent, with that host's name, so the user can enter it in
  // Server settings if they trust it. Whether two hosts belong to one provider can't be told from their names.
  trusts(u) {
    return u.origin === new URL(this.url).origin;
  }

  // etag: change only this version (If-Match). create: only when nothing is there yet (If-None-Match).
  async request(method, url, { body = null, type = XML, depth = null, etag = null, create = false, headers: extra = {} } = {}) {
    let target = url;
    for (let hops = 0; ; hops++) {
      const u = new URL(target);
      if (!allowed(u)) throw calendarError('insecure', t('errors.caldav.insecure'));
      if (!this.trusts(u)) throw calendarError('elsewhere', t('errors.caldav.elsewhere', { host: u.host }));
      const { user, password } = this.credentials();
      const headers = { ...extra, authorization: `Basic ${Buffer.from(`${user}:${password}`, 'utf8').toString('base64')}` };
      if (body !== null) headers['content-type'] = type;
      if (depth !== null) headers.depth = String(depth);
      if (etag) headers['if-match'] = etag;
      if (create) headers['if-none-match'] = '*';
      let res;
      try {
        res = await this.fetch(target, { method, headers, body: body === null ? undefined : body, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT) });
      } catch (_) {
        throw calendarError('network', t('errors.caldav.unreachable'));
      }
      const location = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && location && FOLLOW.has(method) && hops < REDIRECTS) {
        target = resolve(location, target);
        if (!target) throw httpError(res.status);
        continue;
      }
      let data;
      try {
        data = await res.text();
      } catch (_) {
        // A body that stops halfway is a failed request, never an empty answer: an empty list would clear the calendar.
        throw calendarError('network', t('errors.caldav.unreachable'));
      }
      return { status: res.status, ok: res.status >= 200 && res.status < 300, url: target, etag: res.headers.get('etag'), dav: res.headers.get('dav'), body: data };
    }
  }

  async propfind(url, depth, body) {
    const res = await this.request('PROPFIND', url, { body, depth });
    if (!res.ok) throw httpError(res.status);
    return multistatus(res.body, res.url);
  }

  // The calendar home: from the address itself, or from /.well-known/caldav on its host, through the user's principal.
  async discover() {
    const start = new URL(this.url);
    const known = new URL('/.well-known/caldav', start).toString();
    const tries = start.pathname === '/' ? [known, start.toString()] : [start.toString(), known];
    let elsewhere = null;
    for (const url of tries) {
      let home = null;
      try {
        home = await this.homeFrom(url);
      } catch (err) {
        // A wrong password or no connection is the answer; anything else means: not here, try the next.
        if (err.code === 'password' || err.code === 'network' || err.code === 'insecure') throw err;
        if (err.code === 'elsewhere') elsewhere = elsewhere || err;
      }
      if (home) return collection(home);
    }
    throw elsewhere || calendarError('not_caldav', t('errors.caldav.notFound'));
  }

  async homeFrom(url) {
    const [first] = await this.propfind(url, 0, FIND_HOME);
    if (!first) return null;
    let home = hrefIn(first, CAL, 'calendar-home-set', first.href);
    if (!home) {
      const principal = hrefIn(first, DAV, 'current-user-principal', first.href);
      if (!principal) return null;
      const [p] = await this.propfind(principal, 0, FIND_HOME);
      home = p ? hrefIn(p, CAL, 'calendar-home-set', p.href) : null;
    }
    // A home Rukoo wouldn't give the password to is no use; say where it is.
    if (home && !this.trusts(new URL(home))) throw calendarError('elsewhere', t('errors.caldav.elsewhere', { host: new URL(home).host }));
    return home;
  }

  async findHome() {
    this.home = await this.discover();
    this.onHome(this.home);
    return this.home;
  }

  // The calendars that hold events. A home that moved is found again.
  async calendars() {
    if (!this.home) await this.findHome();
    let list;
    try {
      list = await this.propfind(this.home, 1, LIST);
    } catch (err) {
      if (err.code !== 'not_found') throw err;
      list = await this.propfind(await this.findHome(), 1, LIST);
    }
    const calendars = list
      .filter((r) => {
        const type = prop(r, DAV, 'resourcetype');
        if (!type || !kid(type, CAL, 'calendar')) return false;
        const comps = prop(r, CAL, 'supported-calendar-component-set');
        return !comps || kids(comps, CAL, 'comp').some((c) => String(c.getAttribute('name')).toUpperCase() === 'VEVENT');
      })
      .map((r, i) => {
        const privileges = prop(r, DAV, 'current-user-privilege-set');
        const granted = privileges ? kids(privileges, DAV, 'privilege').flatMap((p) => elements(p).map((e) => e.localName)) : null;
        const segment = decodeURIComponent(new URL(r.href).pathname.replace(/\/$/, '').split('/').pop() || '');
        const id = collection(r.href);
        // A server that doesn't say what the user may do is taken at its word when a change fails.
        const writable = !granted || granted.some((g) => ['all', 'write', 'write-content', 'bind'].includes(g));
        return {
          id,
          name: textOf(prop(r, DAV, 'displayname')) || segment,
          primary: false,
          writable,
          selected: true,
          timeZone: zoneOf(r),
          color: colorOf(r),
          conference: false,
          defaultReminders: [],
          // The user's own: in their calendar home, and not one someone else shares with them there.
          owned: writable && id.startsWith(collection(this.home)) && !prop(r, CS, 'shared-url'),
          order: Number(textOf(prop(r, APPLE, 'calendar-order'))) || i + 1000
        };
      })
      .sort((a, b) => a.order - b.order);
    // CalDAV has no primary calendar; new events go to the first one that takes them.
    const first = calendars.find((c) => c.writable);
    if (first) first.primary = true;
    const scheduling = calendars.length ? await this.schedules() : false;
    const chosen = this.invites();
    const invites = chosen === 'provider' || chosen === 'none' ? chosen : scheduling ? 'provider' : 'none';
    return calendars.map(({ order, ...c }) => ({ ...c, scheduling, invites })).sort((a, b) => Number(b.primary) - Number(a.primary));
  }

  // Whether the server tells the organizer when a guest answers in their own calendar, and sends the organizer's
  // invitations (RFC 6638), as its DAV header says. Without that, an answer would stay in the user's calendar and the
  // organizer would never hear it.
  async schedules() {
    try {
      const res = await this.request('OPTIONS', this.home);
      return res.ok && /(^|[\s,])calendar-auto-schedule([\s,]|$)/i.test(String(res.dav || ''));
    } catch (_) {
      return false;
    }
  }

  // The events that overlap start to end. The server picks the calendar objects with an occurrence in that time;
  // their occurrences are worked out here.
  async events(cal, start, end) {
    const body = `<?xml version="1.0" encoding="utf-8"?><c:calendar-query xmlns:d="DAV:" xmlns:c="${CAL}"><d:prop><d:getetag/><c:calendar-data/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="${utcStamp(start)}" end="${utcStamp(end)}"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`;
    const res = await this.request('REPORT', cal.id, { body, depth: 1 });
    if (!res.ok) throw httpError(res.status);
    const out = [];
    for (const r of multistatus(res.body, res.url)) {
      const data = textOf(prop(r, CAL, 'calendar-data'));
      if (!data || !r.href) continue;
      try {
        out.push(...ics.expand(ics.parseObject(data), this.ctx(cal, r.href, textOf(prop(r, DAV, 'getetag'))), start, end));
      } catch (err) {
        // One event Rukoo can't read doesn't take the rest of the calendar with it. A series too long to step
        // through does fail the fetch, so the calendar keeps what it showed instead of losing that series.
        if (err && err.code === 'too_many') throw err;
      }
    }
    return out;
  }

  async load(href) {
    const res = await this.request('GET', href);
    if (!res.ok) throw httpError(res.status);
    let obj;
    try {
      obj = ics.parseObject(res.body);
    } catch (_) {
      throw calendarError('bad_answer', t('errors.caldav.badAnswer'));
    }
    return { obj, etag: res.etag };
  }

  // Writes a calendar object over the version etag, or as a new one (create); returns its new version and the object
  // as written. A new one that is there already, from an earlier try whose answer got lost, is written over when it
  // is the same event (uid) and the user's own. zones: false leaves the zone definitions as they came.
  async write(href, obj, { etag = null, create = false, uid = null, zones = true } = {}) {
    const body = ics.serialize(obj, { zones });
    let res = await this.request('PUT', href, { body, type: ICS, etag: create ? null : etag, create });
    if (res.status === 412 && create && uid) {
      const made = await this.load(href);
      const master = made.obj.master;
      const org = master && master.getFirstProperty('organizer');
      if (!master || String(master.getFirstPropertyValue('uid')) !== uid || (org && !this.me().has(ics.person(org).address))) {
        throw calendarError('conflict', t('errors.calendar.readOnly'));
      }
      res = await this.request('PUT', href, { body, type: ICS, etag: made.etag });
    }
    if (!res.ok) throw httpError(res.status, { write: true });
    return { etag: res.etag || (await this.load(href)).etag, obj: ics.parseObject(body) };
  }

  async get(cal, eventId) {
    const { href, rid } = ics.splitId(eventId);
    const { obj, etag } = await this.load(href);
    const e = ics.pick(obj, this.ctx(cal, href, etag), rid);
    if (!e) throw notFound();
    return e;
  }

  // input.id, when given, names the event: a Save that is tried again after a lost answer finds the event it made
  // the first time (If-None-Match fails) and gives it the latest fields instead of making a second one. uid: a
  // booking's own UID, which names its object the same way. A new series comes back as its first occurrence.
  async create(cal, input, { bookingId = null, uid = null } = {}) {
    const id = input.id || (uid ? nameFor(uid) : crypto.randomUUID());
    const href = new URL(`${encodeURIComponent(id)}.ics`, cal.id).toString();
    const name = uid || id;
    const obj = ics.newObject(input, { uid: name, zone: this.zone(), bookingId, me: this.me(), organizer: this.organizer() });
    const saved = await this.write(href, obj, { create: true, uid: input.id || uid ? name : null });
    const e = ics.pick(saved.obj, this.ctx(cal, href, saved.etag), ics.firstRid(saved.obj));
    if (!e) throw notFound();
    return e;
  }

  // Changes one event; for a series, the occurrence that was opened (scope 'one'), it and every later one
  // ('following') or all of them ('all'). etag is the version the user changed, seriesEtag the series' (every
  // occurrence of a series carries the object's version, so they are the same unless one is out of date); a newer
  // one on the server makes this fail with 'changed'. For 'following' the new series is written first and the old
  // one cut after it; when the server refuses that cut, the new one goes again. Returns the changed occurrence; for a
  // change to a series, null when it can't be named.
  async update(cal, event, input, { etag = null, scope = 'one', seriesEtag = null } = {}) {
    const { href, rid } = ics.splitId(event.eventId);
    const { obj, etag: current } = await this.load(href);
    const whole = Boolean(rid) && (scope === 'following' || scope === 'all');
    const version = whole ? seriesEtag || etag : etag;
    if (version && current && version !== current) throw changed();
    const head = obj.master || obj.exceptions[0];
    const newUid = `${head ? String(head.getFirstPropertyValue('uid') || '') : ''}-R${rid}`;
    const plan = ics.edit(obj, event, input, { rid, scope, me: this.me(), organizer: this.organizer(), zone: this.zone(), newUid });
    if (plan.next) {
      const nextHref = new URL(`${nameFor(newUid)}.ics`, cal.id).toString();
      const made = await this.write(nextHref, plan.next, { create: true, uid: newUid });
      try {
        await this.write(href, obj, { etag: version || current });
      } catch (err) {
        // A cut without an answer, or with a server error, may have been made all the same, and then deleting the new
        // series would take every occurrence from the split on with it. So the old series is read again: a cut that
        // was made finishes the split, and the new one only goes when the old one still runs past the split. When
        // that can't be told, both stay; the error says what went wrong, and a sync shows how the calendar is.
        const held = maybeWritten(err) ? await this.cutHeld(href, rid) : false;
        if (held === null) throw calendarError('unsure', t('errors.calendar.splitUnsure'), { partial: true, reason: err.code || null });
        if (!held) {
          await this.request('DELETE', nextHref, { etag: made.etag }).catch(() => {});
          if (err && err.code === 'changed') throw err;
          throw calendarError('split_failed', t('errors.calendar.splitFailed'));
        }
      }
      return ics.pick(made.obj, this.ctx(cal, nextHref, made.etag), plan.nextRid);
    }
    const saved = await this.write(href, obj, { etag: version || current });
    const e = ics.pick(saved.obj, this.ctx(cal, href, saved.etag), plan.rid);
    if (!e && !whole) throw notFound();
    return e;
  }

  // An event, a whole series, one occurrence, which the series then leaves out (EXDATE), or an occurrence and every
  // later one (the series ends before it); each only on the version the user saw. After an occurrence is left out,
  // returns the object's new version, which every other occurrence of it now has (#53). The older series: true is
  // scope 'all'.
  async remove(cal, event, { scope = null, series = false, etag = null, seriesEtag = null } = {}) {
    const { href, rid } = ics.splitId(event.eventId);
    const which = scope === 'following' || scope === 'all' || scope === 'one' ? scope : series ? 'all' : 'one';
    if (!rid || which === 'all') {
      // The whole series is one calendar object, whose version every occurrence carries: a series changed elsewhere
      // in the meantime is refused (412) rather than deleted.
      const res = await this.request('DELETE', href, { etag: which === 'all' ? seriesEtag || etag : etag });
      if (!res.ok) throw httpError(res.status, { write: true });
      return { etag: null };
    }
    const version = which === 'following' ? seriesEtag || etag : etag;
    const { obj, etag: current } = await this.load(href);
    if (version && current && version !== current) throw changed();
    const empty = which === 'following' ? ics.truncate(obj, rid) : ics.excludeOccurrence(obj, rid);
    if (empty) {
      const res = await this.request('DELETE', href, { etag: version || current });
      if (!res.ok) throw httpError(res.status, { write: true });
      return { etag: null };
    }
    try {
      const saved = await this.write(href, obj, { etag: version || current });
      return { etag: saved.etag };
    } catch (err) {
      // A cut whose answer got lost may have been made: then the deletion is done, as asked.
      const held = which === 'following' && maybeWritten(err) ? await this.cutHeld(href, rid) : false;
      if (held === null) throw calendarError('unsure', t('errors.calendar.splitUnsure'), { partial: true, reason: err.code || null });
      if (!held) throw err;
      return { etag: held.etag };
    }
  }

  // After a cut that may have been made without an answer saying so: { etag } when the series on the server ends
  // before the occurrence now, false when it still runs past it, null when that can't be told (no answer again, or
  // no series there any more).
  async cutHeld(href, rid) {
    try {
      const { obj, etag } = await this.load(href);
      const ends = ics.endsBefore(obj, rid);
      return ends === null ? null : ends && { etag: etag || null };
    } catch (_) {
      return null;
    }
  }

  // An answer to an invitation: only the user's own PARTSTAT changes, in the occurrence or in the whole series. The
  // server sends the organizer the reply (RFC 6638); events only offer this where the server says it does. Returns
  // the object's new version (#53).
  async respond(cal, event, response, { series = false } = {}) {
    const { href, rid } = ics.splitId(event.eventId);
    const { obj, etag } = await this.load(href);
    if (!ics.respond(obj, rid, response, { me: this.me(), series })) throw calendarError('not_invited', t('errors.calendar.notInvited'));
    const saved = await this.write(href, obj, { etag, zones: false });
    return { etag: saved.etag };
  }

  // The series an occurrence belongs to, as the event dialog edits it, with its version.
  async series(cal, event) {
    const { href } = ics.splitId(event.eventId);
    const { obj, etag } = await this.load(href);
    return { ...ics.seriesInfo(obj), etag: etag || null };
  }

  // Moves an event, or a whole series, to another calendar of the account with WebDAV MOVE (RFC 4918), on the version
  // the user saw and never over another object there: the object keeps its UID and what the server knows about its
  // invitations. A server without MOVE gets a copy and a deletion instead, but only for an event without guests: on
  // a server that sends invitations, deleting it would cancel them and the copy would invite everyone anew.
  async move(cal, event, toCal) {
    const { href, rid } = ics.splitId(event.eventId);
    const dest = new URL(href.slice(href.lastIndexOf('/') + 1), collection(toCal.id)).toString();
    const target = new URL(dest);
    if (!this.trusts(target)) throw calendarError('elsewhere', t('errors.caldav.elsewhere', { host: target.host }));
    const res = await this.request('MOVE', href, { etag: event.etag, headers: { destination: dest, overwrite: 'F' } });
    if (res.status === 412) {
      // Either the event changed since the user saw it, or the other calendar has an object by that name.
      const { etag: now } = await this.load(href);
      if (!event.etag || now !== event.etag) throw changed();
      throw calendarError('refused', t('errors.calendar.cannotMove'));
    }
    if ([400, 405, 501, 502].includes(res.status)) await this.copyAway(href, dest, event);
    else if (!res.ok) throw httpError(res.status, { write: true });
    const { obj, etag } = await this.load(dest);
    const e = ics.pick(obj, this.ctx(toCal, dest, etag), rid) || ics.pick(obj, this.ctx(toCal, dest, etag), ics.firstRid(obj));
    if (!e) throw notFound();
    return e;
  }

  async copyAway(href, dest, event) {
    const { obj, etag } = await this.load(href);
    if (event.etag && etag !== event.etag) throw changed();
    if (ics.hasGuests(obj)) throw calendarError('refused', t('errors.calendar.cannotMove'));
    const put = await this.request('PUT', dest, { body: obj.vcal.toString(), type: ICS, create: true });
    if (put.status === 412) throw calendarError('refused', t('errors.calendar.cannotMove'));
    if (!put.ok) throw httpError(put.status, { write: true });
    const del = await this.request('DELETE', href, { etag });
    if (!del.ok && del.status !== 404) {
      // The event stays where it was, and the copy goes again, so it isn't there twice.
      await this.request('DELETE', dest, { etag: put.etag }).catch(() => {});
      throw httpError(del.status, { write: true });
    }
  }
}

// Checks the address from Server settings: finds the calendar home with these credentials and at least one calendar
// with events. Returns the address as Rukoo keeps it and the home.
async function discoverCalDav({ url, user, password, fetchImpl }) {
  const address = serverUrl(url);
  const p = new CalDavCalendar({ url: address, credentials: () => ({ user, password }), fetchImpl });
  await p.findHome();
  const calendars = await p.calendars();
  if (!calendars.length) throw calendarError('no_calendars', t('errors.caldav.noCalendars'));
  return { url: address, home: p.home };
}

module.exports = { CalDavCalendar, discoverCalDav, serverUrl, parseObject: ics.parseObject, expand: ics.expand, instant: ics.instant, utcStamp };
