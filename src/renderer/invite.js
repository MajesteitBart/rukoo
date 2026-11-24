// The card for a calendar invitation: in the reader above an email that carries one, and in a dialog for an .ics file
// opened with Rukoo. Main finds the event in the user's calendars and sends the answer (calendar/invitations.js).
import { t } from './i18n.js';
import { icons } from './icons.js';
import { api, esc, toast, showMenu, dialog, menuCount, closeMenuNumber } from './ui.js';
import { modeShownNow } from './mode-check.js';
import { whenText, titleOf } from './calendar-shared.js';

const RESPONSES = ['accepted', 'tentative', 'declined'];

const who = (p) => (p ? p.name || p.address : '');

// The line above the title: what kind of message this is about the event.
function kindLine(inv) {
  const name = who(inv.organizer);
  if (inv.method === 'REPLY') {
    const guest = (inv.attendees || []).find((a) => a.response !== 'needsAction') || (inv.attendees || [])[0];
    const answer = guest && RESPONSES.includes(guest.response) ? guest.response : 'accepted';
    return t(`invite.card.replied.${answer}`, { name: who(guest) || name });
  }
  if (inv.cancelled) return name ? t('invite.card.cancelledBy', { name }) : t('invite.card.cancelled');
  if (inv.method === 'REQUEST' && name && !inv.organizer.self) return inv.sequence > 0 ? t('invite.card.updatedFrom', { name }) : t('invite.card.from', { name });
  return t('invite.card.event');
}

// Whether the user can answer it: an invitation that asks them, not one they sent or one that was called off. One
// sent to a mailing list names none of the user's addresses; once main knows the account it came to, that account
// answers it. An .ics file that invites none of the user's accounts has none.
const answerable = (inv, state) =>
  inv.method === 'REQUEST' && !inv.cancelled && !(inv.organizer && inv.organizer.self) && Boolean(inv.me || (state && state.account));

// The answer the card shows as chosen: the calendar's, else the one sent by email, else what the invitation says.
function chosen(inv, state) {
  if (state && state.event && state.event.canRespond) return state.event.response;
  return (state && state.answered) || inv.response;
}

// What happens to the answer, or where the event is; empty until main has looked in the calendars.
function note(inv, state) {
  if (!state) return t('invite.card.looking');
  const e = state.event;
  if (e && e.canRespond && answerable(inv, state)) return t('invite.card.viaCalendar');
  if (answerable(inv, state) && inv.organizer && inv.organizer.address) {
    return t(state.answered ? 'invite.card.answeredByEmail' : 'invite.card.byEmail', { address: inv.organizer.address });
  }
  if (e) return t('invite.card.inCalendar');
  if (state.added) return t('invite.card.addedNote');
  return t('invite.card.notInCalendar');
}

// plain: Calendar is turned off (Settings > General > Tabs), so the card shows what the invitation says and leaves
// out everything that goes through the calendar: the answer, Add to calendar, Open in calendar and the note about
// them. The meeting link stays.
export function inviteHtml(inv, state = null, { plain = false } = {}) {
  const guests = inv.attendees || [];
  const rows = [];
  if (inv.meeting && !inv.cancelled) rows.push(`<div class="invite-row">${icons.video}<button class="link-btn" data-invite="join">${esc(t('calendar.event.join'))}</button></div>`);
  if (inv.location) rows.push(`<div class="invite-row">${icons.pin}<span class="sel">${esc(inv.location)}</span></div>`);
  if (guests.length) {
    const names = guests
      .slice(0, 6)
      .map((g) => (g.self ? t('invite.card.you') : who(g)) + (g.organizer ? ` (${t('invite.card.organizer')})` : ''))
      .join(', ');
    const more = guests.length > 6 ? `, ${t('calendar.guests.more', { count: guests.length - 6 })}` : '';
    rows.push(`<div class="invite-row">${icons.people}<span><span class="invite-count">${esc(t('calendar.guests.count', { count: guests.length }))}</span> ${esc(names + more)}</span></div>`);
  }
  const current = chosen(inv, state);
  const rsvp = !plain && answerable(inv, state)
    ? `<div class="invite-rsvp"><span>${esc(t('calendar.rsvp.question'))}</span><div class="filters" role="group" aria-label="${esc(t('calendar.rsvp.question'))}">${RESPONSES.map(
        (r) => `<button class="filter ${current === r ? 'active' : ''}" data-invite-answer="${r}" aria-pressed="${current === r}">${esc(t(`calendar.rsvp.${r}`))}</button>`
      ).join('')}</div></div>`
    : '';
  const event = state && state.event;
  const added = state && !event && state.added;
  const action = plain
    ? ''
    : event || added
      ? `<button class="btn sm" data-invite="open">${icons.calendar}<span>${esc(t('invite.card.open'))}</span></button>`
      : state && !inv.cancelled && inv.method !== 'REPLY' && !(inv.irregular && !Number.isFinite(inv.rid))
        ? `<button class="btn sm" data-invite="add" aria-haspopup="menu">${icons.calendarPlus}<span>${esc(t('invite.card.add'))}</span></button>`
        : '';
  return `<section class="invite ${inv.cancelled ? 'cancelled' : ''}" aria-label="${esc(t('invite.card.label'))}">
    <div class="invite-head">
      <span class="invite-icon">${icons.calendar}</span>
      <div class="invite-titles">
        <div class="invite-kind">${esc(kindLine(inv))}</div>
        <h3 class="invite-title sel">${esc(titleOf(inv))}</h3>
        <div class="invite-when">${esc(whenText(inv))}${inv.series ? ` · ${esc(t('calendar.event.series'))}` : ''}</div>
      </div>
      ${inv.cancelled ? `<span class="pill invite-pill">${esc(t('invite.card.cancelled'))}</span>` : ''}
    </div>
    ${rows.join('')}
    ${rsvp || action ? `<div class="invite-foot">${rsvp}<span class="spacer"></span>${action}</div>` : ''}
    ${plain ? '' : `<div class="invite-note">${esc(note(inv, state))}</div>`}
  </section>`;
}

// Draws the card into el and keeps it current. source: { id } of an email or { file } of an opened file.
// inv: the invitation as the email carries it, to draw before main has looked in the calendars; null asks main first.
// opts.openEvent(id, start): shows an event in the calendar view. opts.onDone: after Open in calendar.
// opts.calendarOn(): whether Calendar shows (Settings > General > Tabs). While it doesn't, the card is plain and main
// isn't asked about the calendars; turned on again (rukoo:modes-changed), the card asks and gets its actions back.
// Turned off, the card's calendar picker closes, and an answer or Add that waited on main asks main again before it
// writes. opts.signal: aborted when the card goes, such as when the reader moves on or the dialog closes; the card
// stops listening then.
export async function mountInvite(el, source, inv, { openEvent, onDone, calendarOn = () => true, signal = null } = {}) {
  let state = null;
  let busy = false;
  // The calendar picker this card opened (menuCount), while it may still be open.
  let picker = 0;
  // The reader may have moved on to another email meanwhile.
  const draw = () => {
    if (el.isConnected) el.innerHTML = inviteHtml(state ? state.invite : inv, state, { plain: !calendarOn() });
  };
  const stop = new AbortController();
  if (signal) signal.addEventListener('abort', () => stop.abort(), { once: true });
  const onModes = () => {
    if (!el.isConnected) return stop.abort();
    if (!calendarOn()) {
      closeMenuNumber(picker);
      picker = 0;
    }
    if (calendarOn() && !state) load().catch(() => draw());
    else draw();
  };
  if (!signal || !signal.aborted) document.addEventListener('rukoo:modes-changed', onModes, { signal: stop.signal });
  // Calendar still shows, here and as main has it now: for a write that comes after an await.
  const stillOn = async () => calendarOn() && (await modeShownNow('calendar')) && calendarOn();
  const load = async () => {
    try {
      state = await api('inviteState', source);
    } catch (err) {
      if (!inv) throw err;
      state = { invite: inv, event: null, answered: null, added: null };
    }
    draw();
  };
  el.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b || busy) return;
    const current = state ? state.invite : inv;
    // A card drawn just before Calendar went off: only the meeting link still works.
    if (!calendarOn() && b.dataset.invite !== 'join') return;
    if (b.dataset.inviteAnswer) {
      busy = true;
      el.querySelectorAll('[data-invite-answer]').forEach((x) => (x.disabled = true));
      try {
        if (!(await stillOn())) return draw();
        const res = await api('inviteAnswer', source, b.dataset.inviteAnswer);
        toast(res.via === 'email' ? t('invite.card.sent', { address: res.to }) : t(`calendar.rsvp.sent.${b.dataset.inviteAnswer}`));
      } catch (err) {
        toast(err.message, 5000);
      } finally {
        busy = false;
      }
      await load().catch(() => draw());
      return;
    }
    if (b.dataset.invite === 'join' && current.meeting) return api('openExternal', current.meeting);
    if (b.dataset.invite === 'open') {
      const target = state.event || state.added;
      onDone && onDone();
      return openEvent && openEvent(target.id, target.start);
    }
    if (b.dataset.invite === 'add') picker = await addMenu(b, source, async () => load(), stillOn);
  });
  if (inv) draw();
  // An email's own invitation is enough while Calendar is off; a file's card needs main (and opens only while
  // Calendar shows, app.js takeInviteFiles).
  if (inv && !calendarOn()) return;
  await load();
}

// The writable calendars to add the event to, by account. stillOn(): whether Calendar still shows, asked after each
// await. Returns the menu's number (menuCount), or 0 when none opened.
async function addMenu(anchor, source, after, stillOn = async () => true) {
  const list = await api('calendarList').catch(() => []);
  if (!(await stillOn())) return 0;
  const items = [];
  for (const acc of list) {
    const cals = (acc.calendars || []).filter((c) => c.writable);
    if (!cals.length) continue;
    items.push({ heading: acc.email });
    for (const c of cals) {
      items.push({
        label: c.name,
        action: async () => {
          if (!(await stillOn())) return;
          try {
            await api('inviteAdd', source, { accountId: acc.id, calendarId: c.id });
            toast(t('invite.card.added', { calendar: c.name }));
          } catch (err) {
            toast(err.message, 5000);
          }
          await after();
        }
      });
    }
  }
  if (!items.length) {
    toast(t('invite.card.noCalendar'));
    return 0;
  }
  showMenu(anchor, items, { align: 'left' });
  return menuCount();
}

// An .ics file opened with Rukoo: its card in a dialog. calendarOn(): whether Calendar shows; the dialog closes when
// Calendar is turned off, and the card stops listening once the dialog is gone.
export function openInviteFile(token, { openEvent, calendarOn = () => true }) {
  let close = null;
  const gone = new AbortController();
  document.addEventListener(
    'rukoo:modes-changed',
    () => {
      if (!calendarOn() && close) close(null);
    },
    { signal: gone.signal }
  );
  dialog({
    title: t('invite.dialog.title'),
    wide: true,
    buttons: [{ get label() { return t('common.actions.close'); }, value: null }],
    render(body, done) {
      close = done;
      body.innerHTML = `<div class="invite-slot"></div>`;
      mountInvite(body.querySelector('.invite-slot'), { file: token }, null, { openEvent, calendarOn, signal: gone.signal, onDone: () => close && close(null) }).catch((err) => {
        done(null);
        toast(err.message, 5000);
      });
    }
  }).then(() => gone.abort());
}
