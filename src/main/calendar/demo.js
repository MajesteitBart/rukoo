'use strict';

// The demo account's calendar: a few weeks of sample events around the day it was made, kept in a local JSON file.
// It answers like the Google calendar (google.js), so the calendar view works without credentials.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { dayKey, localDay, calendarError } = require('./google');
const { t } = require('../../i18n');

const ME = { name: 'Demo User', address: 'demo@example.com' };
const SANNE = { name: 'Sanne de Vries', address: 'sanne@example.com' };
const JORIS = { name: 'Joris Bakker', address: 'joris@example.com' };

const CALENDARS = [
  { id: 'personal', primary: true, writable: true },
  { id: 'work', name: 'Work', primary: false, writable: true },
  // Read-only, like Google's birthday and holiday calendars.
  { id: 'birthdays', name: 'Birthdays', primary: false, writable: false }
];

function guests(organizer, list) {
  return list.map(([p, response]) => ({
    ...p,
    response,
    self: p === ME,
    organizer: p === organizer,
    optional: false
  }));
}

function seed(now = Date.now()) {
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
  const events = [];
  const add = (calendarId, e) => {
    const organizer = e.organizer || { ...ME, self: true };
    const own = organizer.self;
    const me = (e.attendees || []).find((a) => a.self);
    events.push({
      calendarId,
      eventId: e.eventId || crypto.randomUUID(),
      seriesId: e.seriesId || null,
      title: e.title,
      location: e.location || '',
      description: e.description || '',
      allDay: Boolean(e.allDay),
      start: e.allDay ? localDay(e.startDate) : e.start,
      end: e.allDay ? localDay(e.endDate) : e.end,
      startDate: e.startDate || null,
      endDate: e.endDate || null,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      status: 'confirmed',
      busy: true,
      response: me && !own ? me.response : null,
      canEdit: calendarId !== 'birthdays' && own,
      canRespond: Boolean(me && !own),
      organizer,
      attendees: e.attendees || [],
      moreAttendees: false,
      link: null,
      meeting: e.meeting || null
    });
  };

  // A stand-up every weekday, organised by Sanne: one series of single instances, as Google returns them.
  for (let week = -2; week <= 5; week++) {
    for (let day = 0; day < 5; day++) {
      const d = week * 7 + day;
      add('work', {
        eventId: `standup_${date(d).replace(/-/g, '')}`,
        seriesId: 'standup',
        title: 'Stand-up',
        start: at(d, 9, 30),
        end: at(d, 9, 45),
        organizer: { ...SANNE, self: false },
        attendees: guests(SANNE, [[SANNE, 'accepted'], [ME, 'accepted'], [JORIS, 'accepted']]),
        meeting: 'https://meet.example.com/standup'
      });
    }
  }
  add('work', { title: 'Roadmap kickoff', start: at(-6, 13), end: at(-6, 14, 30), location: 'Room 4.12' });
  add('personal', { title: 'Dinner with Joris', start: at(-4, 19), end: at(-4, 21, 30), location: 'Restaurant Breda, Amsterdam' });

  add('work', {
    title: 'Roadmap review',
    start: at(0, 11),
    end: at(0, 12),
    attendees: guests(ME, [[ME, 'accepted'], [JORIS, 'accepted']]),
    description: 'Walk through the roadmap for next quarter and agree on the top three priorities.'
  });
  add('work', {
    title: 'Quarterly planning',
    start: at(1, 14),
    end: at(1, 15, 30),
    location: 'Room 4.12',
    organizer: { ...JORIS, self: false },
    attendees: guests(JORIS, [[JORIS, 'accepted'], [ME, 'needsAction'], [SANNE, 'accepted']]),
    meeting: 'https://meet.example.com/quarterly-planning',
    description: 'Planning for the next quarter. Please bring the numbers for your team.\n\nAgenda:\n1. Results this quarter\n2. Budget\n3. Hiring'
  });
  add('work', { title: 'Design review', start: at(2, 10), end: at(2, 11, 30), attendees: guests(ME, [[ME, 'accepted'], [SANNE, 'tentative']]) });
  add('personal', { title: 'Call with Vandebron', start: at(2, 10, 30), end: at(2, 11) });
  add('personal', { title: 'Lunch with Sanne', start: at(2, 12, 30), end: at(2, 13, 30), location: 'Café de Jaren, Nieuwe Doelenstraat 20, Amsterdam' });
  add('personal', { title: 'Dentist', start: at(3, 8, 30), end: at(3, 9, 15) });
  add('work', {
    title: 'Contract review',
    start: at(3, 16),
    end: at(3, 17),
    organizer: { ...JORIS, self: false },
    attendees: guests(JORIS, [[JORIS, 'accepted'], [ME, 'tentative']])
  });
  add('work', {
    title: 'Vendor demo',
    start: at(4, 15),
    end: at(4, 16),
    organizer: { ...JORIS, self: false },
    attendees: guests(JORIS, [[JORIS, 'accepted'], [ME, 'declined'], [SANNE, 'accepted']])
  });
  add('work', { title: 'Team offsite', allDay: true, startDate: date(3), endDate: date(5) });
  add('birthdays', { title: 'Sanne de Vries', allDay: true, startDate: date(5), endDate: date(6), organizer: { name: '', address: '', self: false } });

  add('personal', { title: 'KL1691 Amsterdam to Lisbon', start: at(8, 7, 15), end: at(8, 9, 55), location: 'Amsterdam Airport Schiphol' });
  add('work', { title: 'Quarterly planning follow-up', start: at(10, 11), end: at(10, 11, 30), attendees: guests(ME, [[ME, 'accepted'], [JORIS, 'needsAction']]) });

  return { events };
}

class DemoCalendar {
  constructor(file, account) {
    this.file = file;
    this.account = account;
    this.state = null;
  }

  load() {
    if (this.state) return this.state;
    try {
      this.state = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (_) {
      this.state = seed();
      this.persist();
    }
    return this.state;
  }

  persist() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.state));
  }

  async calendars() {
    return CALENDARS.map((c) => ({ ...c, name: c.name || this.account.name || ME.name, selected: true, timeZone: null }));
  }

  async events(cal, start, end) {
    return this.load()
      .events.filter((e) => e.calendarId === cal.id && e.start < end && e.end > start)
      .map((e) => ({ ...e }));
  }

  find(event) {
    const hit = this.load().events.find((e) => e.calendarId === event.calendarId && e.eventId === event.eventId);
    if (!hit) throw calendarError('not_found', t('errors.calendar.notFound'));
    return hit;
  }

  static apply(target, input) {
    Object.assign(target, {
      title: input.title,
      location: input.location,
      description: input.description,
      allDay: input.allDay,
      start: input.allDay ? localDay(input.startDate) : input.start,
      end: input.allDay ? localDay(input.endDate) : input.end,
      startDate: input.allDay ? input.startDate : null,
      endDate: input.allDay ? input.endDate : null
    });
    return target;
  }

  async create(cal, input) {
    // A Save tried again with the same id finds the event it made, as Google does.
    const made = input.id && this.load().events.find((e) => e.calendarId === cal.id && e.eventId === input.id);
    if (made) return this.update(cal, made, input);
    const e = DemoCalendar.apply(
      {
        calendarId: cal.id,
        eventId: input.id || crypto.randomUUID(),
        seriesId: null,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        status: 'confirmed',
        busy: true,
        response: null,
        canEdit: true,
        canRespond: false,
        organizer: { ...ME, self: true },
        attendees: [],
        moreAttendees: false,
        link: null,
        meeting: null
      },
      input
    );
    this.load().events.push(e);
    this.persist();
    return { ...e };
  }

  async update(cal, event, input) {
    const e = DemoCalendar.apply(this.find(event), input);
    this.persist();
    return { ...e };
  }

  async remove(cal, event, { series = false } = {}) {
    const state = this.load();
    this.find(event);
    state.events = state.events.filter((e) =>
      series && event.seriesId ? !(e.calendarId === event.calendarId && e.seriesId === event.seriesId) : !(e.calendarId === event.calendarId && e.eventId === event.eventId)
    );
    this.persist();
  }

  async respond(cal, event, response, { series = false } = {}) {
    this.find(event);
    for (const e of this.load().events) {
      const hit = e.calendarId === event.calendarId && (series && event.seriesId ? e.seriesId === event.seriesId : e.eventId === event.eventId);
      if (!hit || !e.canRespond) continue;
      e.response = response;
      for (const a of e.attendees) if (a.self) a.response = response;
    }
    this.persist();
  }
}

module.exports = { DemoCalendar, seed };
