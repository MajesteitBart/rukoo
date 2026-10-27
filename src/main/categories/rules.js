'use strict';

// Inbox categories without a model: what the headers, Gmail's tab, the sender and the subject say. These rules only
// know Rukoo's own five categories (the presets); categories people add get mail from Jev or from their own rules.

const PRESETS = ['needs-you', 'to-read', 'money', 'updates', 'promotions'];
const PRESET_COLORS = { 'needs-you': '#ff5d73', 'to-read': '#4a7dff', money: '#2fd6c0', updates: '#f5c542', promotions: '#c56cf0' };

const { siteOf } = require('../logos');

// Senders that are machines by their name before the @.
const MACHINE = /^(no-?reply|do-?not-?reply|donotreply|notifications?|notify|alerts?|mailer(-daemon)?|bounces?|updates?|automated|system|postmaster|security|accounts?)([+._-].*)?$/i;
// Senders that send newsletters and offers by their name before the @.
const MARKETING = /^(news(letter)?s?|nieuwsbrief|marketing|promo(tions?)?|offers?|deals|aanbiedingen|acties)([+._-].*)?$/i;
// Subjects about money, in English and Dutch.
const MONEY = /\b(invoices?|factu(u|)r(en)?|receipts?|kassabon|betaal(verzoek|bewijs)?|betaling(en)?|payments?|paid|betaald|order confirmation|orderbevestiging|bestelbevestiging|bill(ing)?|aanmaning|incasso|refunds?|terugbetaling|(bank)?afschrift|statement|belastingdienst|aangifte|btw|vat|tikkie|declaratie|creditnota|credit note|subscription renew(al|ed)|abonnement verlengd)\b/i;

const localPart = (address) => String(address || '').split('@')[0];
const domainOf = (address) => String(address || '').split('@')[1] || '';
const isMachine = (from) => MACHINE.test(localPart(from && from.address));

// A display name of two or more words whose first or last word is in the address: "Sanne de Vries" <sanne@...>.
function looksLikePerson(from) {
  const words = String((from && from.name) || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/\s+/)
    .filter((w) => /^[a-z][a-z'-]+$/.test(w));
  if (words.length < 2) return false;
  const local = localPart(from.address).toLowerCase();
  return [words[0], words[words.length - 1]].some((w) => w.length >= 3 && local.includes(w));
}

// Whether this account's own address is among the To recipients.
function toMe(m, own) {
  const mine = own.map((a) => a.toLowerCase());
  return (m.to || []).some((a) => mine.includes(String(a.address || '').toLowerCase()));
}

// The preset a message fits, and how sure the rules are: 'strong' when the mail says so itself, 'weak' when it is a
// guess Jev should make instead. own: the account's addresses; vip: whether the sender is a VIP; known: whether the
// sender is someone the person has written to.
function presetFor(m, { own = [], vip = false, known = false } = {}) {
  const s = m.signals || {};
  const tab = m.gmailTab;
  const from = m.from || {};
  const local = localPart(from.address);
  const personal = (strength) => ({ preset: toMe(m, own) ? 'needs-you' : 'to-read', strength });
  if (vip) return { preset: 'needs-you', strength: 'strong' };
  if (s.campaign || tab === 'promotions' || MARKETING.test(local)) return { preset: 'promotions', strength: 'strong' };
  if (MONEY.test(m.subject || '')) return { preset: 'money', strength: 'weak' };
  if (isMachine(from) || s.auto) return { preset: 'updates', strength: 'strong' };
  if (tab === 'social' || tab === 'updates' || tab === 'forums') return { preset: 'updates', strength: 'weak' };
  // Mail with an unsubscribe link: a newsletter, unless it comes from someone you write to (a mailing list).
  if (s.list) return known ? personal('weak') : { preset: 'promotions', strength: 'weak' };
  if (s.bulk) return { preset: 'updates', strength: 'weak' };
  // A person: someone you write to, a colleague, or a name that matches the address.
  const colleague = own.some((a) => domainOf(a).toLowerCase() === domainOf(from.address).toLowerCase());
  if (known || colleague || looksLikePerson(from) || !siteOf(from.address)) return personal('weak');
  // Anything else from a company's own domain is usually a message from its systems.
  return { preset: 'updates', strength: 'weak' };
}

module.exports = { PRESETS, PRESET_COLORS, presetFor, isMachine, looksLikePerson };
