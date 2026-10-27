// What people read on booking pages (design 3.7), in English and Dutch. Agent-facing text (the "For AI assistants"
// section, llms.txt, JSON and MCP messages) stays English and lives in agent-text.js and api.js.
//
// Values are plain text with {name} placeholders. text() fills them in as text; html() escapes the catalog's own text
// and puts in values the caller has already made safe, for the few sentences that hold a link. test/booking-text.test.js
// checks that both languages have the same keys with the same placeholders.

import { escape } from './page.js';

export const LANGUAGES = ['en', 'nl'];
// Each language's name in itself, for the switch at the bottom of every page.
export const LANGUAGE_NAMES = { en: 'English', nl: 'Nederlands' };
// The locale times are written in when the browser names none for the page's language.
export const DEFAULT_LOCALES = { en: 'en-GB', nl: 'nl-NL' };

export const TEXT = {
  en: {
    'page.title': 'Book a meeting with {host}',
    'page.anon': 'Booking page',
    'page.privacy': 'Privacy',
    'page.report': 'Report this page',
    'page.madeBy': 'This page is made by {host}, not by {operator}.',
    'page.operator': 'the operator of this server',
    'page.operatorStart': 'The operator of this server',
    'page.language': 'Language',
    'page.moved': 'This page moved to {url}.',

    'off.host': '{host} isn’t taking bookings through this page right now.',
    'off.anon': 'This page isn’t taking bookings right now.',
    'off.contact': 'A note from {host}:',

    'missing.type': 'There’s no meeting type at this address.',
    'missing.booking': 'There’s no such booking, or the link is incomplete.',
    'missing.allTypes': 'See all meeting types',

    'landing.pick': 'Pick a meeting',
    'landing.next': 'Next open times',
    'landing.all': 'All open times',
    'landing.noTypes': 'This page lists no meeting types. If you were given a link to one, open that link.',
    'landing.noWeek': 'No open times in the next {days} days.',

    'type.minutes': '{n} min',
    'type.approval': '{host} confirms each booking',
    'type.location.googleMeet': 'Google Meet',
    'type.location.phone': 'Phone call',
    'type.location.inPerson': 'In person',
    'type.location.link': 'Online meeting',

    'booker.back': 'All meeting types',
    'booker.prev': 'Previous month',
    'booker.next': 'Next month',
    'booker.days': 'Pick a day',
    'booker.times': 'Pick a time',
    'booker.timesOne': '1 open time on {date}',
    'booker.timesMany': '{count} open times on {date}',
    'booker.noDay': 'No open times on {date}.',
    'booker.noMonth': 'No open times in {month}.',
    'booker.none': 'No open times right now.',
    'booker.open': '{date}, open times',
    'booker.today': 'today',
    'booker.zone': 'Times in {zone} ({offset})',
    'booker.change': 'Change',
    'booker.zoneLabel': 'Time zone',
    'booker.zoneSubmit': 'Show times',
    'booker.clock': 'Clock',
    'booker.clock12': '12 h',
    'booker.clock24': '24 h',

    'form.title': 'Your details',
    'form.filled': 'Your assistant filled this in. Check the details and press Book.',
    'form.when': 'When',
    'form.hostTime': 'For {host}',
    'form.utc': 'In UTC',
    'form.name': 'Your name',
    'form.email': 'Email',
    'form.notes': 'Note (optional)',
    'form.notesHint': 'Anything {host} should know beforehand.',
    'form.via': 'Assistant',
    'form.viaHint': 'The assistant that booked for you. Only {host} sees this.',
    'form.book': 'Book',
    'form.approval': '{host} will confirm or decline. You get an invitation once they confirm.',
    'form.privacy': 'Your name, email and note go to {host}. {operator} keeps this booking on its server until 30 days after the meeting.',
    'form.gone': 'This time isn’t open any more.',
    'form.nearest': 'The nearest open times:',
    'form.noNearest': 'There are no other open times right now.',
    'form.other': 'Pick another time',
    'form.badSlot': 'That time couldn’t be read. Pick a time below.',
    'form.already': 'You already booked this time with {email}. The page you saw after booking has the link to change it, and the invitation comes from {host}’s calendar.',

    'error.name': 'Fill in your name: up to 80 characters, on one line.',
    'error.email': 'Fill in an email address, such as jane@example.com.',
    'error.notes': 'The note can be at most 1000 characters.',
    'error.via': 'The assistant’s name can be at most 80 characters, on one line.',
    'error.start': 'That time couldn’t be read. Pick a time again.',
    'error.slotTaken': 'That time was just taken. Pick one of the nearest open times.',
    'error.slotTakenNone': 'That time was just taken, and there are no other open times right now.',
    'error.limit.network': 'Too many bookings came from your network today. Try again tomorrow, or contact {host} another way.',
    'error.limit.day': 'This page has taken all the bookings it accepts today. Try again tomorrow.',
    'error.limit.future': 'This page has too many upcoming bookings to take more. Contact {host} another way.',
    'error.limit.reschedules': 'A booking can be moved twice. Cancel it and book a new time instead.',
    'error.limit.mail': 'This booking can’t be moved today. Try again tomorrow, or cancel it and book a new time.',
    'error.limit.stale':
      'This booking can’t be moved right now, because {host}’s calendar hasn’t been checked for a while. Try again later, or cancel it and book a new time; that booking waits for {host}’s OK.',
    'error.notActive': 'This booking is cancelled, declined, lapsed or over, so it can’t be changed.',
    'error.idempotency': 'This form was already used for another booking. Open the page again to book.',
    'error.rateLimited': 'Too many tries from your address. Wait a minute and try again.',
    'error.crossSite': 'Booking from another website isn’t allowed. Open the booking page itself.',
    'error.form': 'The form couldn’t be read. Open the page again and try once more.',
    'error.server': 'Something went wrong on the server. Try again in a moment.',

    'manage.title': 'Your booking',
    'manage.with': '{type} with {host}',
    'manage.status.confirmed': 'Booked',
    'manage.status.pending': 'Waiting for {host}',
    'manage.status.cancelled': 'Cancelled',
    'manage.status.declined': 'Declined',
    'manage.status.expired': 'Lapsed',
    'manage.invitation': '{host}’s calendar sends you an invitation, usually within minutes. It can take longer while their computer is off; the booking holds either way.',
    'manage.pending': '{host} will confirm or decline. The invitation follows when they confirm.',
    'manage.lapses': 'If {host} hasn’t confirmed by {time}, this request lapses.',
    'manage.cancelledGuest': 'You cancelled this booking. {host}’s calendar takes the meeting out soon.',
    'manage.cancelledHost': '{host} cancelled this booking.',
    'manage.declined': '{host} declined this request.',
    'manage.expired': 'This request lapsed before {host} confirmed it.',
    'manage.over': 'This meeting is over.',
    'manage.message': 'Message from {host}',
    'manage.yourTime': 'Your time',
    'manage.where': 'Where',
    'manage.ics': 'Add to your calendar (.ics)',
    'manage.keep': 'Keep this page’s address. With it you can move or cancel this booking.',
    'manage.changes': 'Change or cancel',
    'manage.cancel': 'Cancel booking',
    'manage.reschedule': 'Pick another time',
    'manage.noMoves': 'This booking was moved twice. To change it again, cancel it and book a new time.',
    'manage.again': 'Book another time',

    'reschedule.pick': 'Pick a new time for your booking on {time}.',
    'reschedule.confirm': 'Move your booking to this time?',
    'reschedule.now': 'Now',
    'reschedule.new': 'New',
    'reschedule.move': 'Move booking',
    'reschedule.keep': 'Keep the current time'
  },

  nl: {
    'page.title': 'Maak een afspraak met {host}',
    'page.anon': 'Afsprakenpagina',
    'page.privacy': 'Privacy',
    'page.report': 'Pagina melden',
    'page.madeBy': 'Deze pagina is gemaakt door {host}, niet door {operator}.',
    'page.operator': 'de beheerder van deze server',
    'page.operatorStart': 'De beheerder van deze server',
    'page.language': 'Taal',
    'page.moved': 'Deze pagina is verhuisd naar {url}.',

    'off.host': '{host} neemt via deze pagina nu geen afspraken aan.',
    'off.anon': 'Via deze pagina kun je nu geen afspraak maken.',
    'off.contact': 'Een bericht van {host}:',

    'missing.type': 'Op dit adres staat geen soort afspraak.',
    'missing.booking': 'Deze afspraak bestaat niet, of de link is niet compleet.',
    'missing.allTypes': 'Bekijk alle soorten afspraken',

    'landing.pick': 'Kies een afspraak',
    'landing.next': 'Eerstvolgende vrije tijden',
    'landing.all': 'Alle vrije tijden',
    'landing.noTypes': 'Op deze pagina staan geen soorten afspraken. Heb je een link naar een afspraak gekregen? Open dan die link.',
    'landing.noWeek': 'De komende {days} dagen zijn er geen tijden vrij.',

    'type.minutes': '{n} min',
    'type.approval': '{host} bevestigt elke afspraak zelf',
    'type.location.googleMeet': 'Google Meet',
    'type.location.phone': 'Telefoongesprek',
    'type.location.inPerson': 'Op locatie',
    'type.location.link': 'Online gesprek',

    'booker.back': 'Alle soorten afspraken',
    'booker.prev': 'Vorige maand',
    'booker.next': 'Volgende maand',
    'booker.days': 'Kies een dag',
    'booker.times': 'Kies een tijd',
    'booker.timesOne': '1 tijd vrij op {date}',
    'booker.timesMany': '{count} tijden vrij op {date}',
    'booker.noDay': 'Op {date} zijn geen tijden vrij.',
    'booker.noMonth': 'In {month} zijn geen tijden vrij.',
    'booker.none': 'Er zijn nu geen tijden vrij.',
    'booker.open': '{date}, tijden vrij',
    'booker.today': 'vandaag',
    'booker.zone': 'Tijden in {zone} ({offset})',
    'booker.change': 'Wijzigen',
    'booker.zoneLabel': 'Tijdzone',
    'booker.zoneSubmit': 'Tijden tonen',
    'booker.clock': 'Klok',
    'booker.clock12': '12 uur',
    'booker.clock24': '24 uur',

    'form.title': 'Je gegevens',
    'form.filled': 'Je assistent heeft dit ingevuld. Controleer de gegevens en klik op Boeken.',
    'form.when': 'Wanneer',
    'form.hostTime': 'Bij {host}',
    'form.utc': 'In UTC',
    'form.name': 'Je naam',
    'form.email': 'E-mailadres',
    'form.notes': 'Opmerking (optioneel)',
    'form.notesHint': 'Iets wat {host} vooraf moet weten.',
    'form.via': 'Assistent',
    'form.viaHint': 'De assistent die voor je boekt. Alleen {host} ziet dit.',
    'form.book': 'Boeken',
    'form.approval': '{host} bevestigt of weigert. Je krijgt een uitnodiging zodra {host} heeft bevestigd.',
    'form.privacy': 'Je naam, e-mailadres en opmerking gaan naar {host}. {operator} bewaart deze afspraak op de server tot 30 dagen na de afspraak.',
    'form.gone': 'Deze tijd is niet meer vrij.',
    'form.nearest': 'De dichtstbijzijnde vrije tijden:',
    'form.noNearest': 'Er zijn nu geen andere tijden vrij.',
    'form.other': 'Kies een andere tijd',
    'form.badSlot': 'Die tijd kon niet worden gelezen. Kies hieronder een tijd.',
    'form.already': 'Je hebt deze tijd al geboekt met {email}. Op de pagina die je na het boeken zag, staat de link om de afspraak te wijzigen. De uitnodiging komt uit de agenda van {host}.',

    'error.name': 'Vul je naam in: maximaal 80 tekens, op één regel.',
    'error.email': 'Vul een e-mailadres in, zoals jan@voorbeeld.nl.',
    'error.notes': 'De opmerking mag maximaal 1000 tekens lang zijn.',
    'error.via': 'De naam van de assistent mag maximaal 80 tekens lang zijn, op één regel.',
    'error.start': 'Die tijd kon niet worden gelezen. Kies opnieuw een tijd.',
    'error.slotTaken': 'Die tijd is net bezet. Kies een van de dichtstbijzijnde vrije tijden.',
    'error.slotTakenNone': 'Die tijd is net bezet, en er zijn nu geen andere tijden vrij.',
    'error.limit.network': 'Vandaag kwamen er te veel afspraken van jouw netwerk. Probeer het morgen opnieuw, of neem op een andere manier contact op met {host}.',
    'error.limit.day': 'Deze pagina neemt vandaag geen afspraken meer aan. Probeer het morgen opnieuw.',
    'error.limit.future': 'Deze pagina heeft te veel komende afspraken om er nog meer aan te nemen. Neem op een andere manier contact op met {host}.',
    'error.limit.reschedules': 'Een afspraak kun je twee keer verzetten. Annuleer hem en boek een nieuwe tijd.',
    'error.limit.mail': 'Deze afspraak kan vandaag niet meer worden verzet. Probeer het morgen opnieuw, of annuleer hem en boek een nieuwe tijd.',
    'error.limit.stale':
      'Deze afspraak kan nu niet worden verzet, omdat de agenda van {host} al een tijd niet is gecontroleerd. Probeer het later opnieuw, of annuleer hem en boek een nieuwe tijd; die afspraak wacht dan op het akkoord van {host}.',
    'error.notActive': 'Deze afspraak is geannuleerd, afgewezen, verlopen of voorbij, en kan dus niet meer worden gewijzigd.',
    'error.idempotency': 'Dit formulier is al gebruikt voor een andere afspraak. Open de pagina opnieuw om te boeken.',
    'error.rateLimited': 'Te veel pogingen vanaf jouw adres. Wacht een minuut en probeer het opnieuw.',
    'error.crossSite': 'Boeken vanaf een andere website kan niet. Open de afsprakenpagina zelf.',
    'error.form': 'Het formulier kon niet worden gelezen. Open de pagina opnieuw en probeer het nog eens.',
    'error.server': 'Er ging iets mis op de server. Probeer het zo opnieuw.',

    'manage.title': 'Je afspraak',
    'manage.with': '{type} met {host}',
    'manage.status.confirmed': 'Geboekt',
    'manage.status.pending': 'Wacht op {host}',
    'manage.status.cancelled': 'Geannuleerd',
    'manage.status.declined': 'Afgewezen',
    'manage.status.expired': 'Verlopen',
    'manage.invitation': 'Je krijgt een uitnodiging uit de agenda van {host}, meestal binnen een paar minuten. Staat de computer van {host} uit, dan kan het langer duren; de afspraak staat hoe dan ook.',
    'manage.pending': '{host} bevestigt of weigert. De uitnodiging volgt zodra {host} heeft bevestigd.',
    'manage.lapses': 'Als {host} niet vóór {time} heeft bevestigd, vervalt dit verzoek.',
    'manage.cancelledGuest': 'Je hebt deze afspraak geannuleerd. Hij verdwijnt binnenkort uit de agenda van {host}.',
    'manage.cancelledHost': '{host} heeft deze afspraak geannuleerd.',
    'manage.declined': '{host} heeft dit verzoek afgewezen.',
    'manage.expired': 'Dit verzoek is verlopen voordat {host} het bevestigde.',
    'manage.over': 'Deze afspraak is voorbij.',
    'manage.message': 'Bericht van {host}',
    'manage.yourTime': 'Jouw tijd',
    'manage.where': 'Waar',
    'manage.ics': 'Toevoegen aan je agenda (.ics)',
    'manage.keep': 'Bewaar het adres van deze pagina. Daarmee kun je deze afspraak verzetten of annuleren.',
    'manage.changes': 'Wijzigen of annuleren',
    'manage.cancel': 'Afspraak annuleren',
    'manage.reschedule': 'Andere tijd kiezen',
    'manage.noMoves': 'Deze afspraak is al twee keer verzet. Wil je hem nog eens wijzigen? Annuleer hem dan en boek een nieuwe tijd.',
    'manage.again': 'Een nieuwe tijd boeken',

    'reschedule.pick': 'Kies een nieuwe tijd voor je afspraak van {time}.',
    'reschedule.confirm': 'Je afspraak naar deze tijd verzetten?',
    'reschedule.now': 'Nu',
    'reschedule.new': 'Nieuw',
    'reschedule.move': 'Afspraak verzetten',
    'reschedule.keep': 'Huidige tijd houden'
  }
};

// The {name} placeholders in a catalog value, sorted.
export function params(value) {
  return [...new Set([...value.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].sort();
}

function lookup(lang, key) {
  const value = TEXT[lang]?.[key] ?? TEXT.en[key];
  if (value === undefined) throw new Error(`Unknown booking text: ${key}`);
  return value;
}

// Plain text with the values filled in. A missing value stays visible as its placeholder rather than "undefined".
export function text(lang, key, values = {}) {
  return lookup(lang, key).replace(/\{(\w+)\}/g, (m, name) => (name in values ? String(values[name]) : m));
}

// HTML: the catalog's text escaped, values put in as they are. Callers escape values or pass markup they built.
export function html(lang, key, values = {}) {
  return lookup(lang, key)
    .split(/(\{\w+\})/)
    .map((part) => {
      const m = part.match(/^\{(\w+)\}$/);
      return m && m[1] in values ? String(values[m[1]]) : escape(part);
    })
    .join('');
}
