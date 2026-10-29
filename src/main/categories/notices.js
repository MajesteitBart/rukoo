'use strict';

// Desktop notifications for new inbox mail, by category. A category muted on this computer sends none. An email Jev
// is about to sort, because the rules aren't sure about it, waits for Jev's answer, at most HOLD, and then goes by the
// category it got. With nothing muted, all new mail notifies at once, as without categories.
const { t } = require('../../i18n');

// How long a notification waits for Jev; after that, the category the email has then decides.
const HOLD = 20000;
// Notifications for one batch of new mail; a longer batch adds one that counts it.
const AT_ONCE = 3;

// What to show for new mail: the first few, each opening its email (id), then one that counts them all (id null).
function mailNotices(messages) {
  const list = messages.slice(0, AT_ONCE).map((m) => ({
    id: m.id,
    title: m.from.name || m.from.address,
    body: [m.subject, m.preview].filter(Boolean).join('\n').slice(0, 180)
  }));
  if (messages.length > list.length) list.push({ id: null, title: 'Rukoo Mail', body: t('native.notifications.newCount', { count: messages.length }) });
  return list;
}

class MailNotices {
  // categories: the Categories (index.js). show(notices): puts mailNotices() on screen.
  constructor({ categories, show, hold = HOLD }) {
    this.categories = categories;
    this.show = show;
    this.hold = hold;
    // Batches of new mail waiting for Jev: { messages, timer }.
    this.waiting = new Set();
    // Jev answered, or what it will do changed (turned off, refused, busy, the inbox sorted elsewhere).
    this.recheck = () => {
      for (const batch of [...this.waiting]) this.release(batch);
    };
    categories.on('sorted', this.recheck);
    categories.on('changed', this.recheck);
  }

  // A batch of new inbox mail (the engine's 'new-mail'). What Jev is about to sort waits; the rest is decided now.
  add(messages) {
    if (!this.categories.muted().size) return this.notify(messages);
    const now = [];
    const held = [];
    for (const m of messages) {
      const what = this.categories.notice(m);
      if (what === 'wait') held.push(m);
      else if (what === 'show') now.push(m);
    }
    this.notify(now);
    if (!held.length) return;
    const batch = { messages: held, timer: null };
    batch.timer = setTimeout(() => this.release(batch, { jev: false }), this.hold);
    if (batch.timer.unref) batch.timer.unref();
    this.waiting.add(batch);
  }

  // Shows what of a batch isn't muted, once none of it waits for Jev. jev false: it waits no longer.
  release(batch, { jev = true } = {}) {
    if (!this.waiting.has(batch)) return;
    const what = batch.messages.map((m) => this.categories.notice(m, { jev }));
    if (what.includes('wait')) return;
    this.waiting.delete(batch);
    clearTimeout(batch.timer);
    this.notify(batch.messages.filter((m, i) => what[i] === 'show'));
  }

  notify(messages) {
    if (messages.length) this.show(mailNotices(messages));
  }

  close() {
    for (const batch of this.waiting) clearTimeout(batch.timer);
    this.waiting.clear();
    this.categories.off('sorted', this.recheck);
    this.categories.off('changed', this.recheck);
  }
}

module.exports = { MailNotices, mailNotices, HOLD };
