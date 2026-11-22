// What keeps verified sign-ups (SIGNUPS on verified, codes.js) from filling the server (README.md, "Limits on verified
// sign-ups"). A code proves only that someone reads an address's mail, and a catch-all domain delivers every name to
// one inbox, so one person could otherwise make an account with every sign-up email the hour allows. Two things limit
// that here, and accounts that are never used expire on their own (account.js, expireUnused):
//
// - A domain makes at most DOMAIN_SIGNUPS_PER_DAY accounts with an emailed code a day, counted under a hash of its
//   registrable domain. Only accounts that were made count, so nobody uses up another domain's sign-ups by asking for
//   codes. Large mail providers, where every address is a mailbox someone signed up for, aren't counted, and neither
//   are the domains the operator lists in SIGNUP_DOMAINS_EXEMPT.
// - The operator hears of it: one email a day at most to OPERATOR_EMAIL, when this hour's sign-ups with an emailed
//   code reach ALERT_SIGNUPS_PER_HOUR or the accounts reach 80% of MAX_ACCOUNTS, and one more naming a domain that
//   made its accounts for the day. The Worker's log names every such domain, once a day each.

import { hmac, toBase64url } from './bytes.js';
import { limit, registryObject } from './config.js';
import { mailbox } from './codes.js';
import { invalid } from './input.js';
import { mailer, sendMail } from './mail.js';
import { escape } from './page.js';

// Accounts a domain may make with an emailed code in a day (UTC), unless DOMAIN_SIGNUPS_PER_DAY says otherwise; 0
// there means no limit. A setting below DOMAIN_SIGNUPS_MIN counts as that: with a cap of one or two, the cap would
// tell whoever reads the sign-ups' answers that someone at a one-person domain made an account today.
export const DOMAIN_SIGNUPS = 20;
export const DOMAIN_SIGNUPS_MIN = 5;
// Sign-ups with an emailed code in an hour that make the server mail its operator, unless ALERT_SIGNUPS_PER_HOUR says
// otherwise; 0 there means only the accounts count.
export const ALERT_SIGNUPS = 20;

// Mail providers that give each person their own mailbox, so a domain-wide limit would only hold back their users, and
// would let anyone with two mailboxes there use up the day's sign-ups for everyone else at the provider. Their own
// limits per address apply as everywhere (codes.js, mailbox). Services that hand out aliases by the dozen, such as
// duck.com, fastmail.com, mozmail.com, simplelogin.com or passmail.net, are not on it. Each entry is its own
// registrable domain (registrableDomain), or it would never match. The operator adds others with
// SIGNUP_DOMAINS_EXEMPT.
export const PUBLIC_PROVIDERS = new Set(
  [
    // Google, Apple, Proton, Zoho and Tuta.
    'gmail.com icloud.com me.com mac.com proton.me protonmail.com protonmail.ch pm.me zoho.com zohomail.com',
    'tutanota.com tutanota.de tutamail.com tuta.io tuta.com keemail.me',
    // Microsoft, and the country domains Outlook.com hands out.
    'outlook.com hotmail.com live.com msn.com passport.com windowslive.com',
    'outlook.at outlook.be outlook.cl outlook.co.id outlook.co.il outlook.co.nz outlook.co.th outlook.com.ar outlook.com.au',
    'outlook.com.br outlook.com.gr outlook.com.pe outlook.com.tr outlook.com.vn outlook.cz outlook.de outlook.dk outlook.es',
    'outlook.fr outlook.hu outlook.ie outlook.in outlook.it outlook.jp outlook.kr outlook.lv outlook.my outlook.nl',
    'outlook.ph outlook.pt outlook.sa outlook.sg outlook.sk',
    'hotmail.be hotmail.ca hotmail.cl hotmail.co.id hotmail.co.il hotmail.co.in hotmail.co.jp hotmail.co.kr hotmail.co.th',
    'hotmail.co.uk hotmail.co.za hotmail.com.ar hotmail.com.au hotmail.com.br hotmail.com.hk hotmail.com.tr hotmail.com.tw',
    'hotmail.com.vn hotmail.cz hotmail.de hotmail.dk hotmail.es hotmail.fi hotmail.fr hotmail.gr hotmail.hu hotmail.it',
    'hotmail.lt hotmail.lv hotmail.my hotmail.nl hotmail.no hotmail.ph hotmail.rs hotmail.se hotmail.sg hotmail.sk',
    'live.at live.be live.ca live.cl live.cn live.co.kr live.co.uk live.co.za live.com.ar live.com.au live.com.mx',
    'live.com.my live.com.ph live.com.pt live.com.sg live.de live.dk live.fi live.fr live.hk live.ie live.in live.it',
    'live.jp live.nl live.no live.ru live.se',
    // Yahoo and AOL.
    'yahoo.com ymail.com rocketmail.com aol.com aim.com aol.co.uk aol.de aol.fr',
    'yahoo.at yahoo.be yahoo.ca yahoo.ch yahoo.co.id yahoo.co.in yahoo.co.jp yahoo.co.nz yahoo.co.th yahoo.co.uk',
    'yahoo.co.za yahoo.com.ar yahoo.com.au yahoo.com.br yahoo.com.hk yahoo.com.mx yahoo.com.my yahoo.com.ph yahoo.com.sg',
    'yahoo.com.tw yahoo.com.vn yahoo.de yahoo.dk yahoo.es yahoo.fi yahoo.fr yahoo.gr yahoo.ie yahoo.in yahoo.it yahoo.no',
    'yahoo.ro yahoo.se',
    // Germany, Austria and Switzerland.
    'gmx.com gmx.net gmx.de gmx.at gmx.ch gmx.fr gmx.es gmx.co.uk gmx.us web.de t-online.de freenet.de arcor.de bluewin.ch',
    // France and Belgium.
    'orange.fr wanadoo.fr free.fr laposte.net sfr.fr neuf.fr bbox.fr telenet.be skynet.be',
    // Italy and Portugal.
    'libero.it virgilio.it alice.it tin.it tiscali.it sapo.pt',
    // The Netherlands.
    'ziggo.nl kpnmail.nl planet.nl home.nl xs4all.nl hetnet.nl',
    // The UK and Ireland.
    'btinternet.com sky.com talktalk.net virginmedia.com blueyonder.co.uk ntlworld.com eircom.net',
    // Central and eastern Europe, and Russia.
    'seznam.cz email.cz centrum.cz wp.pl o2.pl interia.pl onet.pl op.pl freemail.hu abv.bg ukr.net',
    'yandex.ru yandex.com ya.ru mail.ru inbox.ru list.ru bk.ru rambler.ru',
    // The Americas and Australia.
    'comcast.net verizon.net att.net sbcglobal.net bellsouth.net cox.net charter.net earthlink.net shaw.ca rogers.com',
    'sympatico.ca uol.com.br bol.com.br terra.com.br bigpond.com optusnet.com.au',
    // Asia.
    'qq.com foxmail.com 163.com 126.com yeah.net sina.com naver.com daum.net hanmail.net rediffmail.com'
  ].flatMap((line) => line.split(' '))
);

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

// Second labels that country domains keep for registrations, as in example.co.ae, example.com.cy or
// agency.gouv.fr: under a country domain of two letters, one of these counts as a public suffix too, also where the
// list above doesn't name it. Pooling everyone under such a suffix in one count would let one person with a domain
// there use up the day's sign-ups for every company or agency in it. The other way round costs little: someone who
// owns such a name outright counts each subdomain apart, which buys no more than registering more domains would.
const GENERIC_SECOND_LEVEL = new Set(['ac', 'co', 'com', 'edu', 'gob', 'gouv', 'gov', 'govt', 'mil', 'net', 'org']);

// The registrable domain of an address: its domain as mailbox() reads it, in ASCII (an internationalized name as
// punycode) and without a trailing dot, cut to the last two labels, or three under a public suffix of two labels
// (PUBLIC_SECOND_LEVEL, or GENERIC_SECOND_LEVEL under a country domain). Without the whole public suffix list this is
// an estimate. A suffix it doesn't know, such as pvt.k12.ma.us, puts everyone under it in one count (ma.us here).
// What matters is that sub.example.com and other.example.com count as one, so a domain that delivers mail to any
// subdomain is one domain here. null for a domain that isn't a host name, such as one with a zero-width joiner in it:
// counted as it is, each spelling of it would count apart.
export function registrableDomain(email) {
  const box = mailbox(email);
  let domain;
  try {
    domain = new URL(`http://${box.slice(box.lastIndexOf('@') + 1).replace(/\.+$/, '')}/`).hostname;
  } catch {
    return null;
  }
  const labels = domain.split('.').filter(Boolean);
  if (labels.length === 0) return null;
  if (labels.length <= 2) return labels.join('.');
  const [second, top] = labels.slice(-2);
  const suffix = PUBLIC_SECOND_LEVEL.has(`${second}.${top}`) || (/^[a-z]{2}$/.test(top) && GENERIC_SECOND_LEVEL.has(second));
  return labels.slice(suffix ? -3 : -2).join('.');
}

export function domainCap(env) {
  const cap = limit(env.DOMAIN_SIGNUPS_PER_DAY, DOMAIN_SIGNUPS);
  return cap > 0 ? Math.max(cap, DOMAIN_SIGNUPS_MIN) : 0;
}

// SIGNUP_DOMAINS_EXEMPT: domains the operator leaves out of the count, comma-separated, each as its registrable domain,
// so mail.example.org exempts example.org with every subdomain, as the count would have counted them together.
export function exemptDomains(env) {
  return new Set(
    String(env.SIGNUP_DOMAINS_EXEMPT || '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => registrableDomain(`x@${entry.slice(entry.lastIndexOf('@') + 1)}`))
      .filter(Boolean)
  );
}

// What the registry counts a sign-up with an emailed code under (Registry.reserve, issueCode): { domain, cap }, with
// domain the hash of the registrable domain, or null where domains aren't counted: a large mail provider, a domain
// the operator exempted, or no limit. An address whose domain isn't a host name is 400 invalid, as a code can't
// reach it anyway.
export async function verifiedSignup(env, email) {
  const domain = registrableDomain(email);
  if (!domain) throw invalid('email must be an email address.');
  const cap = domainCap(env);
  if (cap === 0 || PUBLIC_PROVIDERS.has(domain) || exemptDomains(env).has(domain)) return { domain: null, cap: 0 };
  return { domain: toBase64url(await hmac(env.PEPPER, `signup domain\n${domain}`)), cap };
}

// The message of the 429 for a sign-up with a code whose domain made its accounts for today. A code request there gets
// the same 202 as anywhere and no email (codes.js, requestCode).
export const DOMAIN_LIMIT = 'Too many accounts were made with addresses at this domain today. Try again tomorrow.';

// Seconds until the next day starts (UTC), when the counts per domain start again: Retry-After for that 429.
export function untilTomorrow(now = Date.now()) {
  const day = 24 * 60 * 60 * 1000;
  return Math.max(1, Math.ceil(((Math.floor(now / day) + 1) * day - now) / 1000));
}

// After an account was made: mails the operator when the registry says it is due (Registry.alertDue). capped: the
// registrable domain whose day's accounts this sign-up completed, or null; the log names it whether or not mail goes,
// so a provider that should be exempt shows up the day it is held back. The rest runs after the answer, so a failure
// here never reaches the device that just made its account. The email needs OPERATOR_EMAIL and mail; without them it
// doesn't even ask.
export function checkAlert(env, ctx, host, capped = null) {
  const max = limit(env.MAX_ACCOUNTS, 0);
  const perHour = limit(env.ALERT_SIGNUPS_PER_HOUR, ALERT_SIGNUPS);
  if (capped) {
    console.error(
      `Sign-ups with an emailed code at ${capped} reached DOMAIN_SIGNUPS_PER_DAY (${domainCap(env)}) today; more wait until midnight UTC. If it is a mail provider whose users each have their own mailbox, add it to SIGNUP_DOMAINS_EXEMPT.`
    );
  }
  const to = operatorEmail(env);
  if (!to || !mailer(env)) return;
  const registry = registryObject(env);
  if (!registry) return;
  ctx.waitUntil(
    (async () => {
      const due = await registry.alertDue({ perHour, max, capped: Boolean(capped) });
      if (!due) return;
      const sent = await sendMail(env, { to, ...alertMail(due, { host, perHour, max, domain: capped, cap: domainCap(env) }) });
      if (sent === 'refused') await registry.alertFailed(due);
    })().catch((err) => console.error('Mailing the operator failed:', err?.stack || err))
  );
}

// OPERATOR_EMAIL when it looks like an address, else null.
export function operatorEmail(env) {
  const value = typeof env.OPERATOR_EMAIL === 'string' ? env.OPERATOR_EMAIL.trim() : '';
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? value : null;
}

// The email to the operator, in English: counts, and the domain that made its accounts for the day when due.domain
// says so, nothing about anyone else. reason is 'signups', 'accounts' or null for an email about the domain alone.
export function alertMail({ reason, domain: capped, signups, accounts }, { host, perHour, max, domain, cap }) {
  const lines = [];
  if (reason === 'signups') {
    lines.push(
      `${signups} accounts were made with an emailed code on ${host} this hour (UTC). That reaches ALERT_SIGNUPS_PER_HOUR, ${perHour}.`,
      `The server holds ${accounts} accounts${max > 0 ? ` of the ${max} MAX_ACCOUNTS allows` : ''}.`
    );
  } else if (reason === 'accounts') {
    lines.push(
      `The server on ${host} holds ${accounts} accounts. That is ${Math.floor((accounts * 100) / max)}% of MAX_ACCOUNTS, ${max}.`,
      'Once it holds MAX_ACCOUNTS, every sign-up gets "This server has no room for new accounts".'
    );
  }
  if (capped && domain) {
    lines.push(
      `The addresses at ${domain} made ${cap} accounts with an emailed code on ${host} today, which DOMAIN_SIGNUPS_PER_DAY allows. Until midnight UTC, nobody else there can make one.`,
      `If ${domain} is a mail provider whose users each have their own mailbox, add it to SIGNUP_DOMAINS_EXEMPT. Domains that reach the limit later today are named in the Worker's log only.`
    );
  }
  if (reason) {
    lines.push(
      'If these are people you expect, raise the limits. If not, lower DOMAIN_SIGNUPS_PER_DAY or EMAIL_CODES_PER_HOUR, set EXPIRE_UNUSED_DAYS, or switch SIGNUPS to "invite" for a while.'
    );
  }
  lines.push(
    'README.md, "Limits on verified sign-ups", has the details. The server sends at most one email a day about the counts, and one naming a domain, to OPERATOR_EMAIL.'
  );
  return {
    subject: `Rukoo account server on ${host}: sign-ups need a look`,
    text: `${lines.join('\n\n')}\n`,
    html: `<!doctype html><html lang="en"><body>${lines.map((line) => `<p>${escape(line)}</p>`).join('')}</body></html>`
  };
}
