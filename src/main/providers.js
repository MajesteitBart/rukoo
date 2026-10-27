'use strict';

const { t } = require('../i18n');

// Server presets for the provider tiles on the "E-mail instellen" screen. appPasswordUrl: the page where the user
// creates an app password, for providers whose mail servers turn down the account's normal password.
const PROVIDERS = {
  google: {
    label: 'Google',
    imap: { host: 'imap.gmail.com', port: 993, secure: true },
    smtp: { host: 'smtp.gmail.com', port: 465, secure: true },
    appPasswordUrl: 'https://myaccount.google.com/apppasswords',
    get note() { return t('setup.providers.google.note'); }
  },
  yahoo: {
    label: 'Yahoo',
    imap: { host: 'imap.mail.yahoo.com', port: 993, secure: true },
    smtp: { host: 'smtp.mail.yahoo.com', port: 465, secure: true },
    appPasswordUrl: 'https://login.yahoo.com/account/security',
    get note() { return t('setup.providers.yahoo.note'); }
  },
  outlook: {
    label: 'Outlook',
    imap: { host: 'outlook.office365.com', port: 993, secure: true },
    smtp: { host: 'smtp-mail.outlook.com', port: 587, secure: false },
    get note() { return t('setup.providers.outlook.note'); }
  },
  exchange: {
    label: 'Exchange',
    imap: { host: '', port: 993, secure: true },
    smtp: { host: '', port: 587, secure: false },
    manual: true,
    get note() { return t('setup.providers.exchange.note'); }
  },
  office365: {
    label: 'Office365',
    imap: { host: 'outlook.office365.com', port: 993, secure: true },
    smtp: { host: 'smtp.office365.com', port: 587, secure: false },
    get note() { return t('setup.providers.office365.note'); }
  },
  other: {
    get label() { return t('setup.providers.other.label'); },
    imap: { host: '', port: 993, secure: true },
    smtp: { host: '', port: 465, secure: true },
    get note() { return t('setup.providers.other.note'); }
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

// The IMAP servers of the providers that only take an app password, for an account added under "Other" with such an
// address (see DOMAIN_HINTS).
const APP_PASSWORD_HOSTS = { google: /(^|\.)(gmail|googlemail)\.com$/i, yahoo: /(^|\.)yahoo\.com$/i };

// 'google' or 'yahoo' when the account signs in with a password to a provider that only accepts an app password,
// otherwise null. A Google account signed in through the browser has no password to get wrong.
function appPasswordProvider(account) {
  if (!account || account.type !== 'imap' || account.auth === 'oauth2') return null;
  const preset = PROVIDERS[account.provider];
  if (preset && preset.appPasswordUrl) return account.provider;
  const host = String((account.imap && account.imap.host) || '');
  return Object.keys(APP_PASSWORD_HOSTS).find((id) => APP_PASSWORD_HOSTS[id].test(host)) || null;
}

function publicProviders() {
  return Object.entries(PROVIDERS).map(([id, p]) => ({
    id,
    label: p.label,
    note: p.note,
    manual: Boolean(p.manual),
    appPasswordUrl: p.appPasswordUrl || null,
    imap: p.imap,
    smtp: p.smtp
  }));
}

module.exports = { PROVIDERS, serverDefaults, publicProviders, appPasswordProvider };
