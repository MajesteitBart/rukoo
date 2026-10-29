'use strict';

// An invitation that came by email (iMIP, RFC 6047) or as an .ics file: the event it is about, as the reader's card
// shows it, and the answer that goes back to the organizer by email (iTIP REPLY, RFC 5546 3.2.3) when none of the
// user's calendars can give it.

const ICAL = require('ical.js');
const ics = require('./ics');

const DAY = 86400000;
const METHODS = new Set(['REQUEST', 'CANCEL', 'REPLY', 'PUBLISH', 'ADD', 'COUNTER', 'REFRESH', 'DECLINECOUNTER']);
const ANSWER = { accepted: 'ACCEPTED', tentative: 'TENTATIVE', declined: 'DECLINED' };
// An .ics file or a calendar part larger than this is not an invitation anyone sends.
const MAX_TEXT = 1024 * 1024;

const isCalendarType = (type) => /^(text\/calendar|application\/ics|text\/x-vcalendar)$/i.test(String(type || '').trim());

// The parts of a parsed email (mailparser's attachments) that carry its invitation: the calendar part of the body
// (text/calendar inside multipart/alternative, which mailparser lists as an attachment) and an .ics attachment.
// Returns { index, method } for the part to read, and the indexes of body parts the reader shouldn't list as
// attachments; a real .ics attachment stays in the list. null when the email has no calendar part.
function calendarPart(attachments) {
  const parts = (attachments || []).map((a, index) => {
    const header = a.headers && typeof a.headers.get === 'function' ? a.headers.get('content-type') : null;
    const method = String((header && header.params && header.params.method) || '').toUpperCase() || null;
    const named = /\.ics$/i.test(String(a.filename || ''));
    return { index, method, calendar: isCalendarType(a.contentType) || named, attached: a.contentDisposition === 'attachment' };
  });
  const found = parts.filter((p) => p.calendar);
  if (!found.length) return null;
  // The body's own part says which method it is (RFC 6047 2.4); Google adds the same object as invite.ics.
  const pick = found.find((p) => p.method) || found.find((p) => !p.attached) || found[0];
  return { index: pick.index, method: pick.method, hidden: found.filter((p) => !p.attached).map((p) => p.index) };
}

function parse(text) {
  const s = String(text || '');
  if (!s.trim() || s.length > MAX_TEXT) return null;
  try {
    return ics.parseObject(s);
  } catch {
    return null;
  }
}

const startOf = (comp) => {
  const prop = comp.getFirstProperty('dtstart');
  return prop ? ics.instant(prop.getFirstValue(), prop.getParameter('tzid') || null) : NaN;
};

// The invitation as the card shows it, or null when the text isn't a calendar with an event.
// me: the addresses of the account it came to (or of every account, for a file). method: the email part's METHOD,
// which wins over the one inside the object.
function readInvite(text, { me = [], method = null } = {}) {
  const obj = parse(text);
  if (!obj) return null;
  const comps = [obj.master, ...obj.exceptions].filter(Boolean);
  const comp = comps[0];
  if (!comp) return null;
  const inner = String(obj.vcal.getFirstPropertyValue('method') || '').toUpperCase();
  const m = String(method || inner || 'PUBLISH').toUpperCase();
  const cancelled = m === 'CANCEL' || comps.some((c) => /^cancelled$/i.test(String(c.getFirstPropertyValue('status') || '')));
  // A cancelled event leaves expand() empty; the card still shows what was cancelled.
  for (const c of comps) c.removeAllProperties('status');
  const mine = new Set(me.map((a) => String(a || '').toLowerCase()).filter(Boolean));
  const ctx = { cal: { id: 'invite', writable: false }, href: 'invite', etag: null, me: mine, local: true };
  const from = startOf(comp);
  if (!Number.isFinite(from)) return null;
  let event = null;
  try {
    // The first occurrence of a series; one event, or one occurrence of a series on its own, as it is.
    const list = ics.recurring(obj.master) ? ics.expand(obj, ctx, from - DAY, from + 366 * DAY) : ics.expand(obj, ctx, -Infinity, Infinity);
    event = list[0] || null;
  } catch {
    event = null;
  }
  if (!event) return null;
  const ridProp = comp.getFirstProperty('recurrence-id');
  const rid = ridProp ? ics.instant(ridProp.getFirstValue(), ridProp.getParameter('tzid') || null) : null;
  const self = (event.attendees || []).find((a) => a.self) || null;
  return {
    method: METHODS.has(m) ? m : 'PUBLISH',
    uid: event.uid,
    // The occurrence this is about, for an invitation to one occurrence of a series (ms); null for the whole event.
    rid,
    sequence: Number(comp.getFirstPropertyValue('sequence')) || 0,
    series: ics.recurring(obj.master),
    // The repeat rule, for a copy added to a calendar (RRULE's value).
    rule: obj.master && obj.master.hasProperty('rrule') ? obj.master.getFirstPropertyValue('rrule').toString() : null,
    cancelled,
    title: event.title,
    location: event.location,
    description: event.description,
    allDay: event.allDay,
    start: event.start,
    end: event.end,
    startDate: event.startDate,
    endDate: event.endDate,
    timeZone: event.timeZone,
    meeting: event.meeting,
    organizer: event.organizer,
    attendees: event.attendees,
    // The user's own place among the guests: their address there and the answer the object holds.
    me: self ? self.address : null,
    response: self ? self.response : null
  };
}

// The REPLY that answers an invitation by email: the event's UID, SEQUENCE, RECURRENCE-ID and times as the
// invitation has them, its organizer, and the user as the one guest, with the answer. address: the user's address
// in the invitation (or the account's, for an invitation sent to a list). Returns the iCalendar text.
function replyText(text, { address, name = '', response, now = Date.now() }) {
  const obj = parse(text);
  const status = ANSWER[response];
  if (!obj || !status || !address) throw new Error('invalid');
  const out = new ICAL.Component(['vcalendar', [], []]);
  out.addPropertyWithValue('prodid', ics.PRODID);
  out.addPropertyWithValue('version', '2.0');
  out.addPropertyWithValue('method', 'REPLY');
  // The zones its times name, so they read the same at the organizer's end.
  for (const zone of obj.vcal.getAllSubcomponents('vtimezone')) out.addSubcomponent(new ICAL.Component(ICAL.helpers.clone(zone.jCal, true)));
  const lower = String(address).toLowerCase();
  for (const comp of [obj.master, ...obj.exceptions].filter(Boolean)) {
    const ev = new ICAL.Component('vevent');
    for (const name of ['uid', 'sequence', 'recurrence-id', 'dtstart', 'dtend', 'duration', 'summary', 'organizer']) {
      const prop = comp.getFirstProperty(name);
      if (prop) ev.addProperty(new ICAL.Property(ICAL.helpers.clone(prop.jCal, true)));
    }
    ev.addPropertyWithValue('dtstamp', ICAL.Time.fromJSDate(new Date(now), true));
    const listed = comp.getAllProperties('attendee').find((p) => String(p.getFirstValue() || '').replace(/^mailto:/i, '').toLowerCase() === lower);
    const me = listed ? new ICAL.Property(ICAL.helpers.clone(listed.jCal, true)) : new ICAL.Property('attendee');
    if (!listed) {
      me.setValue(`mailto:${address}`);
      if (name) me.setParameter('cn', name);
    }
    me.setParameter('partstat', status);
    me.removeParameter('rsvp');
    ev.addProperty(me);
    out.addSubcomponent(ev);
  }
  return out.toString();
}

module.exports = { calendarPart, readInvite, replyText, isCalendarType, MAX_TEXT };
