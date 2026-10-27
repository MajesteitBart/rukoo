'use strict';

// The demo account's calendar: a few weeks of sample events around the day it was made, kept in a local JSON file.
// The events are iCalendar objects, read and changed with the same code as a CalDAV calendar's (ics.js), so the
// calendar view, series and reminders work without credentials. Nobody gets invitations: the guests are made up.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ICAL = require('ical.js');
const { calendarError, dayKey } = require('./google');
const { pcZone } = require('./zone');
const ics = require('./ics');
const { t } = require('../../i18n');

const ME = { name: 'Demo User', address: 'demo@example.com' };
const SANNE = { name: 'Sanne de Vries', address: 'sanne@example.com' };
const JORIS = { name: 'Joris Bakker', address: 'joris@example.com' };
const VERSION = 2;
// The demo's meeting links lead nowhere, but show as links to a video call.
const VIDEO = new RegExp(`${ics.VIDEO.source}|^https://meet\\.example\\.com/\\S*$`, 'i');

const CALENDARS = [
  { id: 'personal', primary: true, writable: true, owned: true },
  { id: 'work', name: 'Work', primary: false, writable: true, owned: true },
  // Read-only, like Google's birthday and holiday calendars.
  { id: 'birthdays', name: 'Birthdays', primary: false, writable: false, owned: false }
];

const me = () => new Set([ME.address]);

// The organizer and the guests of a meeting someone set up: [[person, PARTSTAT]].
function people(comp, organizer, list) {
  const o = new ICAL.Property('organizer');
  o.setValue(`mailto:${organizer.address}`);
  o.setParameter('cn', organizer.name);
  comp.addProperty(o);
  for (const [p, partstat] of list) {
    const a = new ICAL.Property('attendee');
    a.setValue(`mailto:${p.address}`);
    a.setParameter('cn', p.name);
    a.setParameter('partstat', partstat);
    comp.addProperty(a);
  }
}

function seed(now = Date.now(), zone = pcZone()) {
  const monday = new Date(now);
  monday.setHours(0, 0, 0, 0);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  const at = (day, h, m = 0) => {
    const d = new Date(monday);
    d.setDate(d.getDate() + day);
    d.setHours(h, m, 0, 0);
    return d.getTime();
  };
  const date = (day) => {
    const d = new Date(monday);
    d.setDate(d.getDate() + day);
    return dayKey(d);
  };
  const objects = [];
  // One event; more(master) adds what the dialog doesn't make, such as someone else as organizer.
  const add = (calendarId, input, { uid = crypto.randomUUID(), more = null } = {}) => {
    let obj = ics.newObject({ location: '', description: '', allDay: false, ...input }, { uid, zone });
    if (more) {
      obj = ics.parseObject(ics.serialize(obj));
      more(obj.master, obj);
    }
    objects.push({ calendarId, uid, data: ics.serialize(obj) });
  };
  const ctx = (calendarId, uid) => ({ cal: { id: calendarId, writable: true }, href: uid, etag: null, me: me(), local: true });

  // A stand-up every weekday, organised by Sanne.
  add(
    'work',
    { title: 'Stand-up', start: at(-14, 9, 30), end: at(-14, 9, 45), recurrence: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;COUNT=40' },
    {
      uid: 'standup',
      more: (comp) => {
        people(comp, SANNE, [[SANNE, 'ACCEPTED'], [ME, 'ACCEPTED'], [JORIS, 'ACCEPTED']]);
        comp.updatePropertyWithValue('url', 'https://meet.example.com/standup');
      }
    }
  );
  add('work', { title: 'Roadmap kickoff', start: at(-6, 13), end: at(-6, 14, 30), location: 'Room 4.12' });
  add('personal', { title: 'Dinner with Joris', start: at(-4, 19), end: at(-4, 21, 30), location: 'Restaurant Breda, Amsterdam' });
  // The user's own lesson every Tuesday, with a reminder an hour before: one week off, and next week's on Wednesday.
  add(
    'personal',
    { title: 'Piano lesson', start: at(-13, 18, 30), end: at(-13, 19, 15), location: 'Muziekschool Amsterdam', recurrence: 'FREQ=WEEKLY;BYDAY=TU', reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 60 }] } },
    {
      uid: 'piano',
      more: (comp, obj) => {
        ics.excludeOccurrence(obj, ics.utcStamp(at(-6, 18, 30)));
        const rid = ics.utcStamp(at(8, 18, 30));
        const occurrence = ics.pick(obj, ctx('personal', 'piano'), rid);
        ics.edit(obj, occurrence, { ...occurrence, start: at(9, 19), end: at(9, 19, 45) }, { rid, scope: 'one', me: me(), organizer: ME, zone });
      }
    }
  );

  add('work', {
    title: 'Roadmap review',
    start: at(0, 11),
    end: at(0, 12),
    description: 'Walk through the roadmap for next quarter and agree on the top three priorities.'
  }, { more: (comp) => people(comp, ME, [[ME, 'ACCEPTED'], [JORIS, 'ACCEPTED']]) });
  add(
    'work',
    {
      title: 'Quarterly planning',
      start: at(1, 14),
      end: at(1, 15, 30),
      location: 'Room 4.12',
      description: 'Planning for the next quarter. Please bring the numbers for your team.\n\nAgenda:\n1. Results this quarter\n2. Budget\n3. Hiring'
    },
    {
      more: (comp) => {
        people(comp, JORIS, [[JORIS, 'ACCEPTED'], [ME, 'NEEDS-ACTION'], [SANNE, 'ACCEPTED']]);
        comp.updatePropertyWithValue('url', 'https://meet.example.com/quarterly-planning');
      }
    }
  );
  add('work', { title: 'Design review', start: at(2, 10), end: at(2, 11, 30) }, { more: (comp) => people(comp, ME, [[ME, 'ACCEPTED'], [SANNE, 'TENTATIVE']]) });
  add('personal', { title: 'Call with Vandebron', start: at(2, 10, 30), end: at(2, 11) });
  add('personal', { title: 'Lunch with Sanne', start: at(2, 12, 30), end: at(2, 13, 30), location: 'Café de Jaren, Nieuwe Doelenstraat 20, Amsterdam' });
  add('personal', { title: 'Dentist', start: at(3, 8, 30), end: at(3, 9, 15) });
  add('work', { title: 'Contract review', start: at(3, 16), end: at(3, 17) }, { more: (comp) => people(comp, JORIS, [[JORIS, 'ACCEPTED'], [ME, 'TENTATIVE']]) });
  add('work', { title: 'Vendor demo', start: at(4, 15), end: at(4, 16) }, { more: (comp) => people(comp, JORIS, [[JORIS, 'ACCEPTED'], [ME, 'DECLINED'], [SANNE, 'ACCEPTED']]) });
  add('work', { title: 'Team offsite', allDay: true, startDate: date(3), endDate: date(5), busy: true });
  add('birthdays', { title: 'Sanne de Vries', allDay: true, startDate: date(5), endDate: date(6) });

  add('personal', { title: 'KL1691 Amsterdam to Lisbon', start: at(8, 7, 15), end: at(8, 9, 55), location: 'Amsterdam Airport Schiphol' });
  add('work', { title: 'Quarterly planning follow-up', start: at(10, 11), end: at(10, 11, 30) }, { more: (comp) => people(comp, ME, [[ME, 'ACCEPTED'], [JORIS, 'NEEDS-ACTION']]) });

  return { v: VERSION, objects };
}

const notFound = () => calendarError('not_found', t('errors.calendar.notFound'));

class DemoCalendar {
  constructor(file, account) {
    this.file = file;
    this.account = account;
    this.state = null;
  }

  // A file from before the events were iCalendar objects held sample events made around the day it was written; it
  // is made again around today.
  load() {
    if (this.state) return this.state;
    try {
      this.state = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (_) {
      this.state = null;
    }
    if (!this.state || this.state.v !== VERSION || !Array.isArray(this.state.objects)) {
      this.state = seed();
      this.persist();
    }
    return this.state;
  }

  persist() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.state));
  }

  ctx(cal, uid) {
    return { cal, href: uid, etag: null, me: me(), local: true, video: VIDEO };
  }

  // The stored object an event belongs to; its UID is the first part of the event's id.
  entry(calendarId, uid) {
    const hit = this.load().objects.find((o) => o.calendarId === calendarId && o.uid === uid);
    if (!hit) throw notFound();
    return hit;
  }

  store(calendarId, uid, obj) {
    const state = this.load();
    const data = ics.serialize(obj);
    const hit = state.objects.find((o) => o.calendarId === calendarId && o.uid === uid);
    if (hit) hit.data = data;
    else state.objects.push({ calendarId, uid, data });
    return ics.parseObject(data);
  }

  async calendars() {
    return CALENDARS.map((c) => ({
      id: c.id,
      name: c.name || this.account.name || ME.name,
      primary: c.primary,
      writable: c.writable,
      selected: true,
      timeZone: null,
      color: null,
      conference: false,
      defaultReminders: [],
      owned: c.owned,
      invites: 'none'
    }));
  }

  async events(cal, start, end) {
    const out = [];
    for (const o of this.load().objects) if (o.calendarId === cal.id) out.push(...ics.expand(ics.parseObject(o.data), this.ctx(cal, o.uid), start, end));
    return out;
  }

  async get(cal, eventId) {
    const { href, rid } = ics.splitId(eventId);
    const e = ics.pick(ics.parseObject(this.entry(cal.id, href).data), this.ctx(cal, href), rid);
    if (!e) throw notFound();
    return e;
  }

  // A Save tried again with the same id finds the event it made, as Google does, and it gets the latest fields.
  async create(cal, input, { bookingId = null, uid = null } = {}) {
    const name = input.id || (uid && !uid.includes('#') ? uid : null) || crypto.randomUUID();
    const obj = ics.newObject(input, { uid: name, zone: pcZone(), bookingId, me: me(), organizer: ME });
    const saved = this.store(cal.id, name, obj);
    this.persist();
    return ics.pick(saved, this.ctx(cal, name), ics.firstRid(saved));
  }

  async update(cal, event, input, { scope = 'one' } = {}) {
    const { href, rid } = ics.splitId(event.eventId);
    const obj = ics.parseObject(this.entry(cal.id, href).data);
    const plan = ics.edit(obj, event, input, { rid, scope, me: me(), organizer: ME, zone: pcZone(), newUid: `${href}-R${rid}` });
    let out;
    if (plan.next) {
      const uid = String(plan.next.master.getFirstPropertyValue('uid'));
      out = ics.pick(this.store(cal.id, uid, plan.next), this.ctx(cal, uid), plan.nextRid);
      this.store(cal.id, href, obj);
    } else {
      out = ics.pick(this.store(cal.id, href, obj), this.ctx(cal, href), plan.rid);
    }
    this.persist();
    if (!out && !(rid && scope !== 'one')) throw notFound();
    return out;
  }

  // An event, one occurrence, an occurrence and every later one, or the whole series (the older series: true).
  async remove(cal, event, { scope = null, series = false } = {}) {
    const { href, rid } = ics.splitId(event.eventId);
    const which = scope === 'following' || scope === 'all' || scope === 'one' ? scope : series ? 'all' : 'one';
    const state = this.load();
    const hit = this.entry(cal.id, href);
    let empty = !rid || which === 'all';
    if (!empty) {
      const obj = ics.parseObject(hit.data);
      empty = which === 'following' ? ics.truncate(obj, rid) : ics.excludeOccurrence(obj, rid);
      if (!empty) this.store(cal.id, href, obj);
    }
    if (empty) state.objects = state.objects.filter((o) => o !== hit);
    this.persist();
  }

  async respond(cal, event, response, { series = false } = {}) {
    const { href, rid } = ics.splitId(event.eventId);
    const obj = ics.parseObject(this.entry(cal.id, href).data);
    if (!ics.respond(obj, rid, response, { me: me(), series })) throw calendarError('not_invited', t('errors.calendar.notInvited'));
    this.store(cal.id, href, obj);
    this.persist();
  }

  async series(cal, event) {
    const { href } = ics.splitId(event.eventId);
    return { ...ics.seriesInfo(ics.parseObject(this.entry(cal.id, href).data)), etag: null };
  }

  // To another of the demo's calendars; a series moves whole.
  async move(cal, event, toCal) {
    const { href, rid } = ics.splitId(event.eventId);
    const hit = this.entry(cal.id, href);
    if (this.load().objects.some((o) => o.calendarId === toCal.id && o.uid === href)) throw calendarError('refused', t('errors.calendar.cannotMove'));
    hit.calendarId = toCal.id;
    this.persist();
    const obj = ics.parseObject(hit.data);
    return ics.pick(obj, this.ctx(toCal, href), rid) || ics.pick(obj, this.ctx(toCal, href), ics.firstRid(obj));
  }
}

module.exports = { DemoCalendar, seed };
