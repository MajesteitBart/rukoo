// What keeps verified sign-ups (SIGNUPS on verified, codes.js) from filling the server (README.md, "Limits on verified
// sign-ups"). A code proves only that someone reads an address's mail, and a catch-all domain delivers every name to
// one inbox, so one person could otherwise make an account with every sign-up email the hour allows. Two things limit
// that here, and accounts that are never used expire on their own (account.js, expireUnused):
//
// - A domain makes at most DOMAIN_SIGNUPS_PER_DAY accounts with an emailed code a day, counted under a hash of its
//   registrable domain. Only accounts that were made count, so nobody uses up another domain's sign-ups by asking for
//   codes. Large mail providers, where every address is a mailbox someone signed up for, aren't counted.
// - The operator hears of it: one email a day at most to OPERATOR_EMAIL, when this hour's sign-ups with an emailed
//   code reach ALERT_SIGNUPS_PER_HOUR or the accounts reach 80% of MAX_ACCOUNTS.

import { hmac, toBase64url } from './bytes.js';
import { limit, registryObject } from './config.js';
import { mailbox } from './codes.js';
import { mailer, sendMail } from './mail.js';
import { escape } from './page.js';

// Accounts a domain may make with an emailed code in a day (UTC), unless DOMAIN_SIGNUPS_PER_DAY says otherwise; 0
// there means no limit.
export const DOMAIN_SIGNUPS = 20;
// Sign-ups with an emailed code in an hour that make the server mail its operator, unless ALERT_SIGNUPS_PER_HOUR says
// otherwise; 0 there means only the accounts count.
export const ALERT_SIGNUPS = 20;

// Mail providers that give each person their own mailbox, so a domain-wide limit would only hold back their users.
// Their own limits per address apply as everywhere (codes.js, mailbox). Services that hand out aliases by the dozen,
// such as duck.com, fastmail.com or passmail.net, are not on it.
export const PUBLIC_PROVIDERS = new Set([
  'gmail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'msn.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'proton.me',
  'protonmail.com',
  'pm.me',
  'yahoo.com',
  'ymail.com',
  'aol.com',
  'gmx.com',
  'gmx.net',
  'gmx.de',
  'web.de',
  'hotmail.nl',
  'live.nl',
  'outlook.nl',
  'hotmail.co.uk',
  'live.co.uk',
  'yahoo.co.uk',
  'hotmail.de',
  'outlook.de',
  'yahoo.de',
  'hotmail.fr',
  'yahoo.fr',
  'ziggo.nl',
  'kpnmail.nl',
  'planet.nl',
  'home.nl',
  'xs4all.nl',
  'hetnet.nl'
]);

// Public suffixes of two labels that people register names under, as in example.co.uk, example.com.au or
// example.ne.jp, from the ICANN part of the public suffix list (https://publicsuffix.org). Only real suffixes belong
// here: one that isn't would let its owner count each subdomain as a domain of its own.
const PUBLIC_SECOND_LEVEL = new Set(
  [
    'uk: co org me ltd plc net ac gov sch nhs police',
    'au: com net org edu gov asn id',
    'nz: co net org ac govt school geek gen kiwi',
    'jp: co ne or ac ad ed go gr lg',
    'za: co org net gov ac edu web',
    'br: com net org gov edu',
    'mx: com net org gob edu',
    'ar: com net org gob edu',
    'tr: com net org gen edu gov biz info',
    'cn: com net org gov edu ac',
    'hk: com net org edu gov idv',
    'sg: com net org edu gov per',
    'tw: com net org edu gov idv',
    'in: co net org firm gen ind ac edu gov res',
    'kr: co or ne ac go re pe',
    'il: co org net ac gov muni',
    'id: co or web ac go net my biz',
    'my: com net org edu gov',
    'th: co in or ac go net',
    'ph: com net org edu gov',
    'pk: com net org edu gov',
    'ng: com org edu gov net',
    'ke: co or ac go ne',
    'eg: com edu gov net org',
    'sa: com edu gov net org',
    'pl: com net org',
    'at: co or ac gv',
    'es: com org nom edu gob',
    'pt: com org edu gov',
    'gr: com net org edu gov',
    'ua: com net org edu gov',
    'co: com net org edu gov',
    'pe: com net org edu gob',
    'ec: com net org',
    'uy: com net org edu',
    've: com net org',
    'vn: com net org edu gov'
  ].flatMap((line) => {
    const [top, names] = line.split(': ');
    return names.split(' ').map((name) => `${name}.${top}`);
  })
);

// The registrable domain of an address: its domain as mailbox() reads it, in ASCII (an internationalized name as
// punycode) and without a trailing dot, cut to the last two labels, or three under a suffix in PUBLIC_SECOND_LEVEL.
// Without the whole public suffix list this is an estimate, which errs one way only: a suffix it doesn't know, such
// as pvt.k12.ma.us, puts everyone under it in one count (ma.us here), and never splits one domain into several. What
// matters is that sub.example.com and other.example.com count as one, so a domain that delivers mail to any
// subdomain is one domain here.
export function registrableDomain(email) {
  const box = mailbox(email);
  let domain = box.slice(box.lastIndexOf('@') + 1).replace(/\.+$/, '');
  try {
    domain = new URL(`http://${domain}/`).hostname;
  } catch {
    // Not a host name a URL takes; it counts as it is.
  }
  const labels = domain.split('.').filter(Boolean);
  if (labels.length <= 2) return labels.join('.');
  return labels.slice(PUBLIC_SECOND_LEVEL.has(labels.slice(-2).join('.')) ? -3 : -2).join('.');
}

export function domainCap(env) {
  return limit(env.DOMAIN_SIGNUPS_PER_DAY, DOMAIN_SIGNUPS);
}

// What the registry counts a sign-up with an emailed code under (Registry.reserve, issueCode): { domain, cap }, with
// domain the hash of the registrable domain, or null where domains aren't counted: a large mail provider, or no limit.
export async function verifiedSignup(env, email) {
  const cap = domainCap(env);
  const domain = registrableDomain(email);
  if (cap === 0 || PUBLIC_PROVIDERS.has(domain)) return { domain: null, cap: 0 };
  return { domain: toBase64url(await hmac(env.PEPPER, `signup domain\n${domain}`)), cap };
}

// The message of the 429 for an address whose domain made its accounts for today, for a code request and a sign-up.
export const DOMAIN_LIMIT = 'Too many accounts were made with addresses at this domain today. Try again tomorrow.';

// Seconds until the next day starts (UTC), when the counts per domain start again: Retry-After for that 429.
export function untilTomorrow(now = Date.now()) {
  const day = 24 * 60 * 60 * 1000;
  return Math.max(1, Math.ceil(((Math.floor(now / day) + 1) * day - now) / 1000));
}

// After an account was made: mails the operator when the registry says it is due (Registry.alertDue). It runs after
// the answer, so a failure here never reaches the device that just made its account. Needs OPERATOR_EMAIL and mail;
// without them it doesn't even ask.
export function checkAlert(env, ctx, host) {
  const to = operatorEmail(env);
  if (!to || !mailer(env)) return;
  const registry = registryObject(env);
  if (!registry) return;
  const perHour = limit(env.ALERT_SIGNUPS_PER_HOUR, ALERT_SIGNUPS);
  const max = limit(env.MAX_ACCOUNTS, 0);
  ctx.waitUntil(
    (async () => {
      const due = await registry.alertDue({ perHour, max });
      if (!due) return;
      const sent = await sendMail(env, { to, ...alertMail(due, { host, perHour, max }) });
      if (sent === 'refused') await registry.alertFailed(due.day);
    })().catch((err) => console.error('Mailing the operator failed:', err?.stack || err))
  );
}

// OPERATOR_EMAIL when it looks like an address, else null.
export function operatorEmail(env) {
  const value = typeof env.OPERATOR_EMAIL === 'string' ? env.OPERATOR_EMAIL.trim() : '';
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? value : null;
}

// The email to the operator, in English: counts only, nothing about anyone.
export function alertMail({ reason, signups, accounts }, { host, perHour, max }) {
  const lines =
    reason === 'signups'
      ? [
          `${signups} accounts were made with an emailed code on ${host} this hour (UTC). That reaches ALERT_SIGNUPS_PER_HOUR, ${perHour}.`,
          `The server holds ${accounts} accounts${max > 0 ? ` of the ${max} MAX_ACCOUNTS allows` : ''}.`
        ]
      : [
          `The server on ${host} holds ${accounts} accounts. That is ${Math.floor((accounts * 100) / max)}% of MAX_ACCOUNTS, ${max}.`,
          'Once it holds MAX_ACCOUNTS, every sign-up gets "This server has no room for new accounts".'
        ];
  lines.push(
    'If these are people you expect, raise the limits. If not, lower DOMAIN_SIGNUPS_PER_DAY or EMAIL_CODES_PER_HOUR, set EXPIRE_UNUSED_DAYS, or switch SIGNUPS to "invite" for a while. README.md, "Limits on verified sign-ups", has the details.',
    'The server sends at most one of these emails a day, to OPERATOR_EMAIL.'
  );
  return {
    subject: `Rukoo account server on ${host}: sign-ups need a look`,
    text: `${lines.join('\n\n')}\n`,
    html: `<!doctype html><html lang="en"><body>${lines.map((line) => `<p>${escape(line)}</p>`).join('')}</body></html>`
  };
}
