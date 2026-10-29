'use strict';

// Invitations in email and in .ics files: what the reader's card shows, answering them and adding their event to a
// calendar. An answer goes where the organizer hears it once:
// - through the calendar, when one of the user's calendars has the event and can answer it (Google puts invitations
//   into the calendar and emails the organizer; a CalDAV server that schedules sends the reply itself);
// - otherwise by email, an iTIP REPLY from the account the invitation came to (RFC 6047), as other mail apps do.
// Answers given by email are remembered in data/invitations.json, so the card still shows them after a restart.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { t } = require('../../i18n');
const { readInvite, replyText, MAX_TEXT } = require('./invite');

const RESPONSES = new Set(['accepted', 'tentative', 'declined']);
const KEEP = 500;
const FILES = 20;

const keyOf = (inv) => `${inv.uid}\n${Number.isFinite(inv.rid) ? inv.rid : ''}`;
const fail = (key) => Object.assign(new Error(t(key)), { code: 'invite' });

class Invitations {
  // engine: the mail engine; calendars: the calendar store. dataDir: where invitations.json lives.
  constructor({ engine, calendars, dataDir }) {
    this.engine = engine;
    this.calendars = calendars;
    this.file = path.join(dataDir, 'invitations.json');
    // .ics files opened with Rukoo, by token, the latest few.
    this.files = new Map();
    this.memory = null;
  }

  load() {
    if (this.memory) return this.memory;
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.memory = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
    } catch {
      this.memory = {};
    }
    return this.memory;
  }

  remember(inv, patch) {
    const all = this.load();
    all[keyOf(inv)] = { ...(all[keyOf(inv)] || {}), ...patch, sequence: inv.sequence, at: Date.now() };
    const keys = Object.keys(all);
    if (keys.length > KEEP) for (const k of keys.sort((a, b) => all[a].at - all[b].at).slice(0, keys.length - KEEP)) delete all[k];
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(all));
  }

  // An .ics file's text, kept for its card. accountId: the account an attachment came with, else the one whose
  // address the file invites. Returns the token the renderer asks with.
  openText(text, name = '', accountId = null) {
    const s = String(text || '');
    const inv = readInvite(s, { me: this.engine.ownAddresses() });
    if (!inv) throw fail('errors.invite.unreadable');
    const token = crypto.randomUUID();
    const owner = accountId || this.accountFor(inv.me);
    this.files.set(token, { text: s, name: String(name || ''), accountId: owner ? owner.id : null });
    while (this.files.size > FILES) this.files.delete(this.files.keys().next().value);
    return token;
  }

  openFile(file) {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_TEXT) throw fail('errors.invite.unreadable');
    return this.openText(fs.readFileSync(file, 'utf8'), path.basename(file));
  }

  accountFor(address) {
    if (!address) return null;
    const a = String(address).toLowerCase();
    return this.engine.accounts.find((acc) => this.engine.identities(acc).some((i) => i.address.toLowerCase() === a)) || null;
  }

  // source: { id } for an email, { file } for the token of an .ics file.
  async source(source) {
    const s = source && typeof source === 'object' ? source : {};
    if (typeof s.id === 'string' && s.id) {
      const src = await this.engine.inviteSource(s.id);
      if (!src) throw fail('errors.invite.unreadable');
      return { ...src, name: '' };
    }
    const file = typeof s.file === 'string' ? this.files.get(s.file) : null;
    if (!file) throw fail('errors.invite.unreadable');
    return { text: file.text, method: null, accountId: file.accountId, name: file.name };
  }

  async read(source) {
    const src = await this.source(source);
    const inv = readInvite(src.text, { me: this.engine.ownAddresses(src.accountId), method: src.method });
    if (!inv) throw fail('errors.invite.unreadable');
    return { src, inv };
  }

  // The card's state: the invitation, the event in the user's calendars (null when none has it, or none could be
  // read), the answer given by email and the event added from here. The account answers by email go from.
  async state(source) {
    const { src, inv } = await this.read(source);
    const event = await this.calendars.findInvite(inv).catch(() => null);
    const kept = this.load()[keyOf(inv)] || {};
    const acc = this.engine.accounts.find((a) => a.id === src.accountId) || this.accountFor(inv.me);
    return {
      invite: inv,
      name: src.name,
      event,
      answered: kept.response && kept.sequence >= inv.sequence ? kept.response : null,
      added: kept.added || null,
      account: acc ? { id: acc.id, email: acc.email } : null
    };
  }

  async answer(source, response) {
    if (!RESPONSES.has(response)) throw fail('errors.calendar.invalidResponse');
    const { src, inv } = await this.read(source);
    if (inv.method !== 'REQUEST' || inv.cancelled || (inv.organizer && inv.organizer.self)) throw fail('errors.invite.notAnswerable');
    const event = await this.calendars.findInvite(inv).catch(() => null);
    if (event && event.canRespond) {
      await this.calendars.respond(event.id, response, { series: inv.series && !Number.isFinite(inv.rid) });
      return { via: 'calendar', event: this.calendars.event(event.id) || { ...event, response } };
    }
    if (!inv.organizer || !inv.organizer.address) throw fail('errors.invite.noOrganizer');
    const acc = this.engine.accounts.find((a) => a.id === src.accountId) || this.accountFor(inv.me);
    if (!acc) throw fail('errors.invite.noAccount');
    const from = (inv.me && this.engine.identity(acc, inv.me)) || this.engine.identity(acc, null);
    const who = from.name || acc.name || from.address;
    const title = inv.title || t('calendar.event.noTitle');
    const content = replyText(src.text, { address: inv.me || from.address, name: who, response });
    await this.engine.send(
      {
        accountId: acc.id,
        from: from.address,
        to: [{ name: inv.organizer.name || '', address: inv.organizer.address }],
        subject: t(`invite.reply.subject.${response}`, { title }),
        text: t(`invite.reply.body.${response}`, { name: who, title })
      },
      { icalEvent: { method: 'REPLY', content } }
    );
    this.remember(inv, { response });
    return { via: 'email', to: inv.organizer.address };
  }

  // A copy of the event in a calendar of the user's choosing: its title, time, place, description and repeat rule,
  // without guests. The organizer's later changes don't reach the copy.
  async add(source, { accountId, calendarId }) {
    const { inv } = await this.read(source);
    if (inv.cancelled) throw fail('errors.invite.cancelled');
    const input = {
      accountId,
      calendarId,
      title: inv.title,
      location: inv.location,
      description: inv.description,
      allDay: inv.allDay,
      ...(inv.allDay ? { startDate: inv.startDate, endDate: inv.endDate } : { start: inv.start, end: inv.end }),
      ...(inv.timeZone ? { timeZone: inv.timeZone } : {}),
      ...(inv.rule && !Number.isFinite(inv.rid) ? { recurrence: inv.rule } : {})
    };
    const made = await this.calendars.create(input);
    this.remember(inv, { added: { id: made.id, start: made.start } });
    return made;
  }
}

module.exports = { Invitations };
