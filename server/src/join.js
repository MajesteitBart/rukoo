// The page at /join, in English or Dutch. An invitation link to a team chat workspace is this page's address with the
// workspace and the invitation's secret in the fragment (#w=…&i=…), which browsers never send, so the page never sees
// them. It says what the link is and how to use it in Rukoo: the apps don't open these links themselves yet.
//
// No language switch: a link to /join?lang=… would drop the fragment, and with it the invitation.

import { escape, link } from './page.js';

const RUKOO = 'https://rukoo.io';

// The steps read as copy, install, then one of two cases. Copying comes first, and the install link opens in a new tab,
// so following it never takes the invitation away (RUK-228).
const TEXT = {
  en: {
    title: 'Invitation to team chat in Rukoo',
    intro: (host) => `This link invites you into a team chat workspace on the Rukoo server at ${host}.`,
    runBy: (op) => `This server is run by ${op}.`,
    unnamed: 'Whoever runs this server hasn’t filled in their name.',
    steps: 'How to join',
    copy: ['Copy this page’s address', ' from your browser’s address bar. The invitation is in that address, so keep it until you have joined.'],
    install: (rukoo) => `Install Rukoo from ${rukoo} and open it. The link opens in a new tab, so this page stays open.`,
    then: 'Then, in Rukoo:',
    member: 'If you have a Rukoo account on this server: open Chat, choose Join with an invitation link, and paste the address you copied.',
    newWithInvite:
      'If you don’t: open Settings, Rukoo account, Create account, and paste the address you copied where it asks for an invite code. Chat then opens the invitation.',
    newOpen:
      'If you don’t: open Settings, Rukoo account, Create account, and make an account on this server. Then open Chat, choose Join with an invitation link, and paste the address you copied.',
    newClosed:
      'If you don’t: this server makes new accounts only with an invite code from whoever runs it. Ask the person who invited you.',
    newNone: 'If you don’t: this server doesn’t take new accounts. Ask the person who invited you.',
    expiry:
      'An invitation works once and expires within a week, after one day unless the person who invited you chose another time. If it doesn’t work any more, ask for a new one.',
    privacy: 'Privacy statement'
  },
  nl: {
    title: 'Uitnodiging voor teamchat in Rukoo',
    intro: (host) => `Met deze link word je uitgenodigd voor een werkruimte met teamchat op de Rukoo-server op ${host}.`,
    runBy: (op) => `Deze server wordt beheerd door ${op}.`,
    unnamed: 'De beheerder van deze server heeft geen naam ingevuld.',
    steps: 'Zo doe je mee',
    copy: ['Kopieer het adres van deze pagina', ' uit de adresbalk van je browser. De uitnodiging zit in dat adres, dus bewaar het tot je in de werkruimte zit.'],
    install: (rukoo) => `Installeer Rukoo via ${rukoo} en open het. De link opent in een nieuw tabblad, dus deze pagina blijft open.`,
    then: 'Daarna, in Rukoo:',
    member: 'Heb je een Rukoo-account op deze server? Open Chat, kies Deelnemen met een uitnodigingslink en plak het adres dat je kopieerde.',
    newWithInvite:
      'Heb je dat niet? Open Instellingen, Rukoo-account, Account maken, en plak het adres dat je kopieerde waar om een uitnodigingscode wordt gevraagd. Chat opent daarna de uitnodiging.',
    newOpen:
      'Heb je dat niet? Open Instellingen, Rukoo-account, Account maken, en maak een account op deze server. Open daarna Chat, kies Deelnemen met een uitnodigingslink en plak het adres dat je kopieerde.',
    newClosed:
      'Heb je dat niet? Deze server maakt alleen nieuwe accounts met een uitnodigingscode van de beheerder. Vraag het aan degene die je uitnodigde.',
    newNone: 'Heb je dat niet? Deze server neemt geen nieuwe accounts aan. Vraag het aan degene die je uitnodigde.',
    expiry: 'Een uitnodiging werkt één keer en verloopt binnen een week, na één dag als degene die je uitnodigde niets anders koos. Werkt hij niet meer, vraag dan om een nieuwe.',
    privacy: 'Privacyverklaring'
  }
};

// cfg: config() for the request, with host (the address the link points at) and inviteSignups (whether a workspace
// invitation stands in for an invite code here, as GET /v1/info says).
export function joinPage({ operator, signups, host, inviteSignups }, lang = 'en') {
  const T = TEXT[lang] || TEXT.en;
  const runBy = operator.name ? T.runBy(link(operator.url, operator.name)) : escape(T.unnamed);
  const newcomer = inviteSignups
    ? T.newWithInvite
    : signups === 'open'
      ? T.newOpen
      : signups === 'closed'
        ? T.newNone
        : T.newClosed;
  const footer = operator.privacy ? `<p>${link(operator.privacy, T.privacy)}</p>` : '';
  const install = `<a href="${escape(RUKOO)}" target="_blank" rel="noopener">rukoo.io</a>`;
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escape(T.title)}</title>
<style>
body { font: 16px/1.55 system-ui, sans-serif; max-width: 38rem; margin: 2.5rem auto; padding: 0 1.25rem; color: #1f2328; }
h1 { font-size: 1.5rem; } h2 { font-size: 1.1rem; margin-top: 2rem; } a { color: #0b62c4; } li { margin: 0.5rem 0; }
@media (prefers-color-scheme: dark) { body { background: #16181c; color: #e6e8eb; } a { color: #6cb0ff; } }
</style>
</head>
<body>
<h1>${escape(T.title)}</h1>
<p>${escape(T.intro(host))}</p>
<p>${runBy}</p>

<h2>${escape(T.steps)}</h2>
<ol>
<li><strong>${escape(T.copy[0])}</strong>${escape(T.copy[1])}</li>
<li>${T.install(install)}</li>
</ol>
<p>${escape(T.then)}</p>
<ul>
<li>${escape(T.member)}</li>
<li>${escape(newcomer)}</li>
</ul>
<p>${escape(T.expiry)}</p>
${footer}
</body>
</html>
`;
}
