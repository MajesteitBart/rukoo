// The emails that carry a code (codes.js), in English and Dutch: plain text, and the same words as simple HTML.
// signup: the code to make an account. exists: what a sign-up code request sends to an address that already has an
// account, in place of a code. unlock: the code to sign in or recover while the account is locked.

import { escape } from './page.js';

const TEXT = {
  en: {
    signup: {
      subject: 'Your Rukoo sign-up code',
      before: (host) => [`Your code to make a Rukoo account on ${host}:`],
      after: () => [
        'Enter it in Rukoo within 10 minutes.',
        'If you didn’t ask for this code, you can ignore this email. Nobody can make an account with your address without it.'
      ]
    },
    exists: {
      subject: 'You already have a Rukoo account',
      before: (host) => [
        `Someone asked for a code to make a Rukoo account on ${host} with this address. This address already has an account there, so there is no code.`,
        'Sign in with your password instead. If you forgot it, use your recovery key.',
        'If it wasn’t you, you can ignore this email.'
      ],
      after: () => []
    },
    unlock: {
      subject: 'Your Rukoo sign-in code',
      before: (host) => [`Your code to sign in to your Rukoo account on ${host} while it is locked:`],
      after: () => [
        'Enter it in Rukoo within 10 minutes, with your password or your recovery key.',
        'An account locks for 15 minutes after ten wrong passwords. If you didn’t ask for this code, someone else may be trying to sign in. You can ignore this email: without your password or recovery key, the code is no use to anyone.'
      ]
    },
    footer: (host, operator) =>
      operator ? `This email comes from the Rukoo account server at ${host}, run by ${operator}.` : `This email comes from the Rukoo account server at ${host}.`
  },
  nl: {
    signup: {
      subject: 'Je code voor een Rukoo-account',
      before: (host) => [`Je code om een Rukoo-account te maken op ${host}:`],
      after: () => [
        'Vul hem binnen 10 minuten in Rukoo in.',
        'Heb je deze code niet aangevraagd? Dan kun je deze e-mail negeren. Zonder de code kan niemand een account maken met jouw adres.'
      ]
    },
    exists: {
      subject: 'Je hebt al een Rukoo-account',
      before: (host) => [
        `Iemand vroeg een code aan om met dit adres een Rukoo-account te maken op ${host}. Dit adres heeft daar al een account, dus er is geen code.`,
        'Log in met je wachtwoord. Ben je het vergeten, gebruik dan je herstelsleutel.',
        'Was jij het niet? Dan kun je deze e-mail negeren.'
      ],
      after: () => []
    },
    unlock: {
      subject: 'Je Rukoo-inlogcode',
      before: (host) => [`Je code om in te loggen bij je Rukoo-account op ${host} terwijl het geblokkeerd is:`],
      after: () => [
        'Vul hem binnen 10 minuten in Rukoo in, samen met je wachtwoord of je herstelsleutel.',
        'Na tien verkeerde wachtwoorden wordt een account 15 minuten geblokkeerd. Heb je deze code niet aangevraagd? Dan probeert misschien iemand anders in te loggen. Je kunt deze e-mail negeren: zonder je wachtwoord of herstelsleutel heeft niemand iets aan de code.'
      ]
    },
    footer: (host, operator) =>
      operator
        ? `Deze e-mail komt van de Rukoo-accountserver op ${host}, beheerd door ${operator}.`
        : `Deze e-mail komt van de Rukoo-accountserver op ${host}.`
  }
};

// kind: 'signup', 'exists' or 'unlock'. code: the six digits, for signup and unlock. host: the server's address as the
// request reached it. operator: OPERATOR_NAME or null.
export function codeMail(kind, { code = null, host, operator = null, lang = 'en' }) {
  const T = TEXT[lang] || TEXT.en;
  const part = T[kind];
  const before = part.before(host);
  const after = part.after();
  const footer = T.footer(host, operator);
  const text = [...before, ...(code ? [code] : []), ...after, '--', footer].join('\n\n');
  const paragraph = (line) => `<p style="margin:0 0 16px">${escape(line)}</p>`;
  const html = `<!doctype html>
<html lang="${lang === 'nl' ? 'nl' : 'en'}">
<body style="font:16px/1.5 system-ui,sans-serif;color:#1f2328;max-width:32rem;margin:0 auto;padding:24px 16px">
${before.map(paragraph).join('\n')}
${code ? `<p style="margin:0 0 16px;font-size:28px;font-weight:600;letter-spacing:4px">${escape(code)}</p>` : ''}
${after.map(paragraph).join('\n')}
<p style="margin:24px 0 0;font-size:13px;color:#59636e">${escape(footer)}</p>
</body>
</html>
`;
  return { subject: part.subject, text, html };
}
