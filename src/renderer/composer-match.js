// Checks the composer (composer.js) makes on plain data, apart from its DOM.

// Pairs the attachments a save sent with the ones the stored draft holds (composer.js remapAttachments). The draft
// holds what the save sent: files from disk first, then copied ones. Returns a Map from each sent attachment's key to
// the stored attachment, or null when they can't be paired: a name the draft lacks, or a name two of its files share,
// as after a late save whose draft the editor that took it over removed one of them from. Either of those could be
// the one, so none is picked.
export function attachmentPairs(sent, stored) {
  const order = [...sent.filter((a) => a.path), ...sent.filter((a) => a.forwardIndex !== undefined)];
  const list = [...(stored || [])].sort((a, b) => a.index - b.index);
  const pairs = new Map();
  if (list.length === order.length) {
    order.forEach((a, i) => pairs.set(a.key, list[i]));
    return pairs;
  }
  const free = [...list];
  for (const a of order) {
    if (list.filter((x) => x.filename === a.filename).length !== 1) return null;
    const i = free.findIndex((x) => x.filename === a.filename);
    if (i < 0) return null;
    pairs.set(a.key, free.splice(i, 1)[0]);
  }
  return pairs;
}

const people = (list) => (Array.isArray(list) ? list.map((a) => [String((a && a.name) || ''), String((a && a.address) || '').toLowerCase()]) : []);

// What an email in an editor says, from its undoState(): the text, subject, sender, recipients, attachments and
// whether the quote goes along. Which draft holds it, or which fields are shown, says nothing about the email, and
// neither does where a copied attachment is read from, which a save moves to the draft it stored.
export function emailContent(snapshot) {
  const s = (snapshot && snapshot.state) || {};
  return JSON.stringify({
    html: String((snapshot && snapshot.html) || ''),
    subject: String(s.subject || ''),
    accountId: s.accountId || null,
    from: String(s.from || '').toLowerCase(),
    to: people(s.to),
    cc: people(s.cc),
    bcc: people(s.bcc),
    attachments: (Array.isArray(s.attachments) ? s.attachments : []).map((a) => [a.filename || '', a.path || null, Number(a.size) || 0]),
    include: s.include !== false
  });
}

// Whether two snapshots of an editor are the same email.
export const sameEmail = (a, b) => emailContent(a) === emailContent(b);
