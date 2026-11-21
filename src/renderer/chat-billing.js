// The Billing section of Workspace settings as rows and labels (server/WORKSPACES.md, Billing): what chatBilling
// answered, turned into a status, label and value rows, notes and the owner's actions. chat-dialogs.js draws it. No
// DOM and no imports, so the desktop window and the browser app (which reuses this renderer) draw the same thing, and
// node:test covers it (test/chat-billing.test.js).
//
// The monthly total is the seats times the price of one seat, both from the server: the seats Stripe bills once
// billing is set up, else one per member, which is what Checkout will ask for. The price lives in Stripe; the server
// passes it on.

// Statuses Stripe can still charge in; the others mean there is no billing to manage.
const ENDED = new Set(['none', 'canceled', 'incomplete_expired']);
const STATUS = {
  none: ['none', 'muted'],
  incomplete_expired: ['none', 'muted'],
  incomplete: ['incomplete', 'warn'],
  trialing: ['trialing', 'ok'],
  active: ['active', 'ok'],
  past_due: ['pastDue', 'danger'],
  unpaid: ['unpaid', 'danger'],
  paused: ['paused', 'warn'],
  canceled: ['canceled', 'muted']
};

// amount in the currency's smallest unit (cents for euros), as Stripe counts it.
export function money(amount, currency, locale) {
  const code = String(currency || 'eur').toUpperCase();
  let format;
  try {
    format = new Intl.NumberFormat(locale, { style: 'currency', currency: code });
  } catch (_) {
    format = new Intl.NumberFormat(locale, { style: 'currency', currency: 'EUR' });
  }
  const digits = format.resolvedOptions().maximumFractionDigits;
  return format.format(amount / 10 ** digits);
}

const longDate = (ms, locale) => new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(ms));

// Whether the Billing section shows: the server bills workspaces (capability billing) and the caller owns or runs
// this one. Members and guests never see it; the server refuses them too.
export function showsBilling(capabilities, role) {
  return Boolean(capabilities && capabilities.has ? capabilities.has('billing') : Array.isArray(capabilities) && capabilities.includes('billing')) && (role === 'owner' || role === 'admin');
}

// b: chatBilling's billing. role: the caller's role. locale: for numbers and dates. t: the catalog.
// → { status: { label, tone }, rows: [{ label, value }], notes: [text], actions: [{ kind, label, primary }] }
export function billingModel(b, { role, locale, t }) {
  const owner = role === 'owner';
  const live = !ENDED.has(b.status);
  const [statusKey, tone] = STATUS[b.status] || ['unknown', 'muted'];
  const seats = live && Number.isSafeInteger(b.seats) ? b.seats : Math.max(1, b.members);
  const price = b.price;
  const total = money(seats * price.amount, price.currency, locale);
  const each = money(price.amount, price.currency, locale);
  const tax = price.taxBehavior === 'inclusive' ? 'Incl' : price.taxBehavior === 'exclusive' ? 'Excl' : '';
  const per = price.interval === 'month' ? 'Month' : 'Other';

  const rows = [
    { label: t(live ? 'chat.billing.seatsLabel' : 'chat.billing.seatsToBeLabel'), value: String(seats) },
    {
      label: t(live ? 'chat.billing.totalLabel' : 'chat.billing.totalToBeLabel'),
      value: per === 'Month' ? t(`chat.billing.total${tax}`, { amount: total }) : total,
      help: per === 'Month' ? t(`chat.billing.perSeat${tax}`, { amount: each }) : null
    }
  ];
  if (live && Number.isSafeInteger(b.periodEnd)) {
    rows.push({ label: t(b.cancelAtPeriodEnd ? 'chat.billing.endsLabel' : 'chat.billing.renewsLabel'), value: longDate(b.periodEnd, locale) });
  }

  const notes = [];
  if (b.payment === 'failed' && live) notes.push({ text: t(owner ? 'chat.billing.failedOwner' : 'chat.billing.failedAdmin'), tone: 'danger' });
  if (!live) notes.push({ text: t('chat.billing.whoCounts') });
  if (live && Number.isSafeInteger(b.seats) && b.seats > b.members) notes.push({ text: t('chat.billing.vacant', { count: b.seats - b.members }) });
  if (b.pending > 0) notes.push({ text: t('chat.billing.pending', { count: b.pending }) });
  if (b.syncing) notes.push({ text: t('chat.billing.syncing') });
  if (!owner) notes.push({ text: t('chat.billing.ownersOnly') });

  const actions = [];
  if (owner && b.canCheckout) actions.push({ kind: 'checkout', label: t('chat.billing.setUp'), primary: true });
  if (owner && b.canManage) actions.push({ kind: 'portal', label: t('chat.billing.manage'), primary: false });
  return { status: { label: t(`chat.billing.status.${statusKey}`), tone }, rows, notes, actions };
}
