// New mail in the main window (app.js onNewMail): which of it the list on screen shows, what the toast for the rest
// counts, and where the toast's Show goes. No DOM and no imports, so the node tests can load it.

// mails: [{ id, from, subject, category }] from main (main.js showMailNotices). listed: the ids in the list on screen,
// emails folded into a sender stack included; empty while no list is on screen. The list is the cue for the emails
// here; a toast stands in for the desktop notification of the ones elsewhere.
export function splitNewMail(mails, listed) {
  const here = [];
  const elsewhere = [];
  for (const m of mails) (listed.has(m.id) ? here : elsewhere).push(m);
  return { here, elsewhere };
}

// The emails of a toast that is still up, then the new ones it doesn't have yet: mail from the next account in the
// same sync adds to the toast.
export function addToToast(before, mails) {
  const ids = new Set(before.map((m) => m.id));
  const out = [...before];
  for (const m of mails) {
    if (ids.has(m.id)) continue;
    ids.add(m.id);
    out.push(m);
  }
  return out;
}

// Where Show goes for several new emails: null for Inbox, or the id of the category tab that holds the most of them
// when Inbox leaves them out, because their category's Show in Inbox is off. Inbox wins a tie, so mail Inbox shows
// all of goes there; between categories, the one higher in the sidebar does. categories: the window's categories
// state (main.js categoriesState).
export function newMailTab(mails, categories) {
  const list = categories && categories.enabled && Array.isArray(categories.categories) ? categories.categories : [];
  if (!list.length) return null;
  const known = new Map(list.map((c) => [c.id, c]));
  const counts = new Map();
  let inbox = 0;
  for (const m of mails) {
    const c = known.get(m.category);
    if (!c || c.inbox !== false) inbox++;
    if (c) counts.set(c.id, (counts.get(c.id) || 0) + 1);
  }
  let tab = null;
  let most = inbox;
  for (const c of list) {
    const n = counts.get(c.id) || 0;
    if (n > most) {
      tab = c.id;
      most = n;
    }
  }
  return tab;
}
