'use strict';

const { t } = require('../i18n');

// Server presets for the provider tiles on the "E-mail instellen" screen.
const PROVIDERS = {
  google: {
    label: 'Google',
    imap: { host: 'imap.gmail.com', port: 993, secure: true },
    smtp: { host: 'smtp.gmail.com', port: 465, secure: true },
    get note() { return t('setup.providers.google.note'); }
  },
  yahoo: {
    label: 'Yahoo',
    imap: { host: 'imap.mail.yahoo.com', port: 993, secure: true },
    smtp: { host: 'smtp.mail.yahoo.com', port: 465, secure: true },
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
