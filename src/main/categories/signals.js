'use strict';

// What kind of mail a message is, from the few headers mailing software adds: the signals inbox categories start
// from (categories/rules.js). Kept small, because every cached inbox message carries them.

// The headers a sync fetches for this (imap.js).
const SIGNAL_HEADERS = ['list-id', 'list-unsubscribe', 'precedence', 'auto-submitted', 'feedback-id', 'x-campaign', 'x-mailer'];

// Mailing services whose X-Mailer gives away a campaign.
const BULK_MAILERS = /mailchimp|sendgrid|mailgun|hubspot|marketo|salesforce|klaviyo|brevo|sendinblue|mailjet|customer\.io|campaign|newsletter|mailerlite|constant ?contact|acoustic|exacttarget|emarsys|selligent|spotler|laposta/i;

// Header names to values, from raw header text (a Buffer from IMAP) or an object of header fields.
function headerMap(raw) {
  const out = {};
  if (!raw) return out;
  if (typeof raw === 'object' && !Buffer.isBuffer(raw)) {
    for (const [k, v] of Object.entries(raw)) out[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v);
    return out;
  }
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
  for (const line of text.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return out;
}

// { list, bulk, auto, campaign }: on a mailing list or with an unsubscribe link; sent in bulk (marked so, or with
// the Feedback-ID large senders add); sent by a machine; sent by campaign software. Only the true ones are kept.
// Notifications from a bank or an app are bulk too; campaign is the one that points to marketing.
function mailSignals(raw) {
  const h = headerMap(raw);
  const out = {};
  if (h['list-id'] || h['list-unsubscribe']) out.list = true;
  if (/^(bulk|list|junk)$/i.test(h.precedence || '') || h['feedback-id']) out.bulk = true;
  if (h['auto-submitted'] && !/^no$/i.test(h['auto-submitted'])) out.auto = true;
  if (h['x-campaign'] || BULK_MAILERS.test(h['x-mailer'] || '')) out.campaign = true;
  return out;
}

module.exports = { SIGNAL_HEADERS, headerMap, mailSignals };
