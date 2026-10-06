'use strict';

// Server presets for the provider tiles on the "E-mail instellen" screen.
const PROVIDERS = {
  google: {
    label: 'Google',
    imap: { host: 'imap.gmail.com', port: 993, secure: true },
    smtp: { host: 'smtp.gmail.com', port: 465, secure: true },
    note: 'Gebruik een app-wachtwoord van je Google-account (myaccount.google.com/apppasswords). IMAP moet aan staan in Gmail.'
  },
  yahoo: {
    label: 'Yahoo',
    imap: { host: 'imap.mail.yahoo.com', port: 993, secure: true },
    smtp: { host: 'smtp.mail.yahoo.com', port: 465, secure: true },
    note: 'Yahoo vereist een app-wachtwoord (Accountbeveiliging > App-wachtwoord genereren).'
  },
  outlook: {
    label: 'Outlook',
    imap: { host: 'outlook.office365.com', port: 993, secure: true },
    smtp: { host: 'smtp-mail.outlook.com', port: 587, secure: false },
    note: 'Werkt alleen als je account IMAP met wachtwoord of app-wachtwoord toestaat.'
  },
  exchange: {
    label: 'Exchange',
    imap: { host: '', port: 993, secure: true },
    smtp: { host: '', port: 587, secure: false },
    manual: true,
    note: 'Vul de IMAP- en SMTP-server van je Exchange-omgeving in.'
  },
  office365: {
    label: 'Office365',
    imap: { host: 'outlook.office365.com', port: 993, secure: true },
    smtp: { host: 'smtp.office365.com', port: 587, secure: false },
    note: 'Je beheerder moet IMAP en SMTP AUTH voor je mailbox hebben ingeschakeld.'
  },
  other: {
    label: 'Overige',
    imap: { host: '', port: 993, secure: true },
    smtp: { host: '', port: 465, secure: true },
    note: 'We vullen de servers in op basis van je domein. Pas ze aan als dat nodig is.'
  }
};

// Domains that map to a known provider, so "Overige" still gets correct servers.
const DOMAIN_HINTS = {
  'gmail.com': 'google',
  'googlemail.com': 'google',
  'yahoo.com': 'yahoo',
  'ymail.com': 'yahoo',
  'outlook.com': 'outlook',
  'hotmail.com': 'outlook',
  'live.com': 'outlook',
  'live.nl': 'outlook',
  'hotmail.nl': 'outlook',
  'msn.com': 'outlook'
};

function serverDefaults(providerId, email) {
  const domain = String(email || '').split('@')[1] || '';
  const hinted = DOMAIN_HINTS[domain.toLowerCase()];
  const id = providerId === 'other' && hinted ? hinted : providerId;
  const preset = PROVIDERS[id] || PROVIDERS.other;
  const imap = { ...preset.imap };
  const smtp = { ...preset.smtp };
  if (!imap.host && domain) imap.host = `imap.${domain}`;
  if (!smtp.host && domain) smtp.host = `smtp.${domain}`;
  return { imap, smtp };
}

function publicProviders() {
  return Object.entries(PROVIDERS).map(([id, p]) => ({
    id,
    label: p.label,
    note: p.note,
    manual: Boolean(p.manual),
    imap: p.imap,
    smtp: p.smtp
  }));
}

module.exports = { PROVIDERS, serverDefaults, publicProviders };
