// The privacy statement at /privacy, in English or Dutch. It is filled in from the operator's settings, so a fork
// that deploys this server gets one that names it; read it through and change what doesn't fit your setup before
// people sign up. Set PRIVACY_URL to use a statement of your own elsewhere instead.

import { escape, link } from './page.js';

// When the text below last changed in a way that matters to the people it describes.
export const UPDATED = '2026-10-27';
const PROTOCOL_URL = 'https://github.com/MajesteitBart/rukoo/blob/main/server/PROTOCOL.md';

const TEXT = {
  en: {
    title: 'Privacy statement for Rukoo accounts',
    updated: (date) => `Last updated ${date}.`,
    other: '<a href="/privacy?lang=nl">Nederlands</a>',
    who: 'Who is responsible',
    whoText: (op) => `${op} runs this server and decides what it does with your data.`,
    unnamed: 'Whoever runs this server hasn’t filled in their name. They decide what it does with your data.',
    contact: (c) => ` Contact: ${c}.`,
    what: 'What this service is',
    whatText:
      'A Rukoo account keeps your inbox categories, the category each email got and your corrections the same on your devices that use Rukoo, the open-source mail app. Your mail, your mail passwords and your Google sign-ins never pass through this server.',
    data: 'What we keep',
    dataItems: [
      'Your email address, which is your sign-in name. We don’t send mail to it and don’t check it.',
      'A check value derived from your password on your device. It lets the server confirm your password; it isn’t your password, and the server can’t turn it back into one.',
      'Your encrypted records. Your devices encrypt them with a key that only they have, so we can’t read them: not your categories, not your corrections, not which email went where.',
      'Your encrypted data key, wrapped by your password and by your recovery key. We can’t open it.',
      'The names and platforms of your devices, when each one signed in and when it last connected.',
      'How many records you have, how large they are and when they change.',
      'Failed sign-in attempts, to lock an account for 15 minutes after ten of them.'
    ],
    ip: 'Your IP address reaches Cloudflare with every request. The server uses it only to limit how often one address may try to sign in, and doesn’t store it. Cloudflare may keep it in its own logs for a short time.',
    why: 'Why',
    whyText:
      'We use this data to give you the account you asked for: signing in, syncing your devices and showing your devices and usage (the agreement with you, article 6(1)(b) GDPR). Rate limits and the sign-in lock protect your account and the service (a legitimate interest, article 6(1)(f) GDPR). We don’t use it for anything else: no analytics, no advertising, no profiles, and we don’t sell or share it.',
    where: 'Where it is kept, and who helps',
    whereText: (place) =>
      `The server runs on Cloudflare, a service of Cloudflare, Inc. in the United States, which processes the data on our behalf under its data processing terms. ${place} Because Cloudflare is a US company, US law applies to it, also for data kept in the EU. What it could be made to hand over is the list above: your records stay encrypted with a key Cloudflare doesn’t have.`,
    places: {
      eu: 'Accounts are stored and handled in the European Union.',
      us: 'Accounts are stored and handled in the United States.',
      fedramp: 'Accounts are stored and handled in FedRAMP-Moderate data centers in the United States.',
      any: 'Each account is stored in one Cloudflare location, usually near the device that made it.'
    },
    keep: 'How long',
    keepText:
      'We keep your account until you delete it. Delete account in Rukoo (Settings, Rukoo account) removes the account and every record at once. Cloudflare keeps backups of the storage that can bring back its state from up to 30 days before, so deleted data is fully gone after that. Inactive accounts aren’t deleted on their own; ask us if you want yours removed and can no longer sign in.',
    rights: 'Your rights',
    rightsText:
      'You can see what is stored about you on the What’s stored and shared page in Rukoo, export everything with Export my data, change your password and delete your account yourself. For anything else, such as a copy of the data we hold or an objection, contact us. You can also complain to a data protection authority, such as the one in the country where you live.',
    security: 'Security',
    securityText: (protocol) =>
      `Your password goes through Argon2id on your device, and your records are encrypted with AES-256-GCM before they leave it. We can’t reset your password: without your password or your recovery key, nobody can open your data, including us. ${protocol} describes exactly how it works.`,
    protocol: 'The Rukoo account protocol',
    changes: 'Changes',
    changesText: 'When this statement changes in a way that matters to you, the date at the top changes too.'
  },
  nl: {
    title: 'Privacyverklaring voor Rukoo-accounts',
    updated: (date) => `Laatst bijgewerkt op ${date}.`,
    other: '<a href="/privacy?lang=en">English</a>',
    who: 'Wie is verantwoordelijk',
    whoText: (op) => `${op} beheert deze server en bepaalt wat er met je gegevens gebeurt.`,
    unnamed: 'De beheerder van deze server heeft geen naam ingevuld. Die bepaalt wat er met je gegevens gebeurt.',
    contact: (c) => ` Contact: ${c}.`,
    what: 'Wat deze dienst is',
    whatText:
      'Een Rukoo-account houdt je inboxcategorieën, de categorie van elke e-mail en je correcties gelijk op je apparaten met Rukoo, de opensource-mailapp. Je e-mail, je e-mailwachtwoorden en je Google-aanmeldingen gaan nooit door deze server.',
    data: 'Wat we bewaren',
    dataItems: [
      'Je e-mailadres, waarmee je inlogt. We sturen er geen mail naar en controleren het niet.',
      'Een controlewaarde die je apparaat uit je wachtwoord afleidt. Daarmee kan de server je wachtwoord controleren; het is niet je wachtwoord, en de server kan er geen wachtwoord van terugmaken.',
      'Je versleutelde records. Je apparaten versleutelen ze met een sleutel die alleen zij hebben, dus wij kunnen ze niet lezen: niet je categorieën, niet je correcties, niet welke e-mail waar terechtkwam.',
      'Je versleutelde gegevenssleutel, ingepakt met je wachtwoord en met je herstelsleutel. Wij kunnen hem niet openen.',
      'De namen en platforms van je apparaten, wanneer elk ervan inlogde en wanneer het voor het laatst verbinding had.',
      'Hoeveel records je hebt, hoe groot ze zijn en wanneer ze veranderen.',
      'Mislukte inlogpogingen, om een account na tien daarvan 15 minuten te blokkeren.'
    ],
    ip: 'Bij elk verzoek komt je IP-adres bij Cloudflare binnen. De server gebruikt het alleen om te beperken hoe vaak één adres mag proberen in te loggen, en slaat het niet op. Cloudflare kan het kort in zijn eigen logs bewaren.',
    why: 'Waarom',
    whyText:
      'We gebruiken deze gegevens om je het account te geven waar je om vroeg: inloggen, je apparaten synchroniseren en je apparaten en gebruik tonen (de overeenkomst met jou, artikel 6 lid 1 onder b AVG). Snelheidslimieten en de inlogblokkade beschermen je account en de dienst (een gerechtvaardigd belang, artikel 6 lid 1 onder f AVG). We gebruiken ze nergens anders voor: geen analyses, geen advertenties, geen profielen, en we verkopen of delen ze niet.',
    where: 'Waar het staat, en wie helpt',
    whereText: (place) =>
      `De server draait op Cloudflare, een dienst van Cloudflare, Inc. in de Verenigde Staten, dat de gegevens namens ons verwerkt onder zijn verwerkersvoorwaarden. ${place} Omdat Cloudflare een Amerikaans bedrijf is, valt het onder Amerikaans recht, ook voor gegevens in de EU. Wat het zou kunnen moeten afgeven, is de lijst hierboven: je records blijven versleuteld met een sleutel die Cloudflare niet heeft.`,
    places: {
      eu: 'Accounts worden opgeslagen en verwerkt in de Europese Unie.',
      us: 'Accounts worden opgeslagen en verwerkt in de Verenigde Staten.',
      fedramp: 'Accounts worden opgeslagen en verwerkt in FedRAMP-Moderate-datacenters in de Verenigde Staten.',
      any: 'Elk account staat op één Cloudflare-locatie, meestal dicht bij het apparaat dat het maakte.'
    },
    keep: 'Hoe lang',
    keepText:
      'We bewaren je account tot je het verwijdert. Account verwijderen in Rukoo (Instellingen, Rukoo-account) verwijdert het account en alle records in één keer. Cloudflare bewaart back-ups van de opslag waarmee de toestand van tot 30 dagen eerder terug te halen is, dus na die tijd zijn verwijderde gegevens helemaal weg. Inactieve accounts worden niet vanzelf verwijderd; vraag het ons als je het jouwe weg wilt hebben en niet meer kunt inloggen.',
    rights: 'Je rechten',
    rightsText:
      'Je ziet wat er over je is opgeslagen op de pagina Wat er wordt opgeslagen en gedeeld in Rukoo, je exporteert alles met Mijn gegevens exporteren, en je wijzigt je wachtwoord en verwijdert je account zelf. Voor al het andere, zoals een kopie van de gegevens die we hebben of een bezwaar, neem je contact met ons op. Je kunt ook een klacht indienen bij een toezichthouder, zoals de Autoriteit Persoonsgegevens of die in het land waar je woont.',
    security: 'Beveiliging',
    securityText: (protocol) =>
      `Je wachtwoord gaat op je apparaat door Argon2id, en je records worden met AES-256-GCM versleuteld voordat ze het verlaten. We kunnen je wachtwoord niet resetten: zonder je wachtwoord of je herstelsleutel kan niemand je gegevens openen, wij ook niet. ${protocol} beschrijft precies hoe het werkt.`,
    protocol: 'Het Rukoo-accountprotocol',
    changes: 'Wijzigingen',
    changesText: 'Als deze verklaring verandert op een manier die voor jou uitmaakt, verandert de datum bovenaan ook.'
  }
};

// The language asked for with ?lang=, or else the browser's first choice of English and Dutch.
export function privacyLanguage(url, acceptLanguage) {
  const asked = url.searchParams.get('lang');
  if (asked === 'nl' || asked === 'en') return asked;
  for (const part of String(acceptLanguage || '').split(',')) {
    const tag = part.trim().slice(0, 2).toLowerCase();
    if (tag === 'nl' || tag === 'en') return tag;
  }
  return 'en';
}

function contactLink(value) {
  if (!value) return '';
  return /^[^\s@]+@[^\s@]+$/.test(value) ? `<a href="mailto:${escape(value)}">${escape(value)}</a>` : link(value, value);
}

export function privacy({ operator, jurisdiction }, lang = 'en') {
  const T = TEXT[lang] || TEXT.en;
  const who = operator.name ? T.whoText(link(operator.url, operator.name)) : escape(T.unnamed);
  const contact = operator.contact ? T.contact(contactLink(operator.contact)) : '';
  const place = T.places[jurisdiction] || T.places.any;
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(T.title)}</title>
<style>
body { font: 16px/1.55 system-ui, sans-serif; max-width: 40rem; margin: 2.5rem auto; padding: 0 1.25rem; color: #1f2328; }
h1 { font-size: 1.5rem; } h2 { font-size: 1.1rem; margin-top: 2rem; } a { color: #0b62c4; } li { margin: 0.35rem 0; }
@media (prefers-color-scheme: dark) { body { background: #16181c; color: #e6e8eb; } a { color: #6cb0ff; } }
</style>
</head>
<body>
<h1>${escape(T.title)}</h1>
<p>${escape(T.updated(UPDATED))} ${T.other}</p>

<h2>${escape(T.who)}</h2>
<p>${who}${contact}</p>

<h2>${escape(T.what)}</h2>
<p>${escape(T.whatText)}</p>

<h2>${escape(T.data)}</h2>
<ul>
${T.dataItems.map((item) => `<li>${escape(item)}</li>`).join('\n')}
</ul>
<p>${escape(T.ip)}</p>

<h2>${escape(T.why)}</h2>
<p>${escape(T.whyText)}</p>

<h2>${escape(T.where)}</h2>
<p>${escape(T.whereText(place))}</p>

<h2>${escape(T.keep)}</h2>
<p>${escape(T.keepText)}</p>

<h2>${escape(T.rights)}</h2>
<p>${escape(T.rightsText)}</p>

<h2>${escape(T.security)}</h2>
<p>${T.securityText(link(PROTOCOL_URL, T.protocol))}</p>

<h2>${escape(T.changes)}</h2>
<p>${escape(T.changesText)}</p>
</body>
</html>
`;
}
