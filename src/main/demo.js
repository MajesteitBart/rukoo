'use strict';

const fs = require('fs');
const path = require('path');
const { simpleParser } = require('mailparser');
const MailComposer = require('nodemailer/lib/mail-composer');
const util = require('./mailutil');

const DEMO_EMAIL = 'demo@example.com';

const FOLDERS = [
  { path: 'INBOX', name: 'INBOX', role: 'inbox' },
  { path: 'Sent', name: 'Sent', role: 'sent' },
  { path: 'Drafts', name: 'Drafts', role: 'drafts' },
  { path: 'Trash', name: 'Trash', role: 'trash' },
  { path: 'Junk', name: 'Junk', role: 'junk' },
  { path: 'Archive', name: 'Archive', role: 'archive' },
  { path: 'Invoices', name: 'Invoices', role: null },
  { path: 'Travel', name: 'Travel', role: null }
];

function newsletter({ brand, color, title, intro, items }) {
  const blocks = items
    .map(
      (i) => `<tr><td style="padding:16px 24px;border-top:1px solid #e6e6e6">
<h3 style="margin:0 0 6px;font:600 18px Arial,sans-serif;color:#111">${i.title}</h3>
<p style="margin:0;font:15px/1.5 Arial,sans-serif;color:#444">${i.text}</p>
<p style="margin:10px 0 0"><a href="https://example.com/${encodeURIComponent(i.title)}" style="color:${color};font:600 14px Arial,sans-serif">Read more</a></p>
</td></tr>`
    )
    .join('');
  return `<!doctype html><html lang="en"><body style="margin:0;background:#f2f2f2">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f2f2f2"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;max-width:600px">
<tr><td style="padding:14px 24px;text-align:right;font:12px Arial,sans-serif"><a href="https://example.com/browser" style="color:#3b78c4">View email in browser</a></td></tr>
<tr><td style="padding:20px 24px;background:${color};color:#fff;font:700 26px Arial,sans-serif">${brand}</td></tr>
<tr><td style="padding:24px"><h1 style="margin:0 0 8px;font:700 26px Arial,sans-serif;color:#111">${title}</h1>
<p style="margin:0;font:16px/1.5 Arial,sans-serif;color:#333">${intro}</p></td></tr>
${blocks}
<tr><td style="padding:20px 24px;background:#fafafa;font:12px Arial,sans-serif;color:#777">You are receiving this email because you subscribed. <a href="https://example.com/unsubscribe" style="color:#777">Unsubscribe</a></td></tr>
</table></td></tr></table></body></html>`;
}

function seed(now = Date.now()) {
  const today = new Date(now);
  const at = (daysAgo, h, m) => {
    const d = new Date(today);
    d.setDate(d.getDate() - daysAgo);
    d.setHours(h, m, 0, 0);
    if (daysAgo > 0) return d.getTime();
    // Today's mail must lie in the past. Before 15:00, when the latest one is due, squeeze all
    // of today into the time since midnight, so the messages keep their order.
    const midnight = new Date(now).setHours(0, 0, 0, 0);
    if (now >= midnight + 15 * 3600000) return d.getTime();
    return midnight + Math.floor(((h * 60 + m) / (15 * 60)) * (now - midnight));
  };
  const me = { name: 'Demo User', address: DEMO_EMAIL };
  const pdf = (name) => ({
    filename: name,
    contentType: 'application/pdf',
    content: Buffer.from(
      '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF'
    ).toString('base64'),
    encoding: 'base64'
  });

  const inbox = [
    {
      from: { name: 'ANWB Newsletter', address: 'newsletter@anwb.nl' },
      subject: 'Traffic fines in 2027: what you will pay',
      date: at(0, 14, 45),
      html: newsletter({
        brand: 'ANWB',
        color: '#0b5cad',
        title: 'Driving in low sun: keep your windows clean',
        intro: 'Follow these tips to improve visibility and avoid dangerous situations.',
        items: [
          { title: 'Top 10 cheapest new cars', text: 'These models cost the least to buy and maintain.' },
          { title: 'Traffic fines in 2027: what you will pay', text: 'An overview of the new fines for each offence.' },
          { title: 'Winter tyres: when should you switch?', text: 'Below 7°C, winter tyres offer better grip than summer tyres.' }
        ]
      }),
      unread: true
    },
    {
      from: { name: 'Forward Future (Matthew Berman)', address: 'newsletter@forwardfuture.ai' },
      subject: 'The music industry can\'t agree on AI',
      date: at(0, 14, 6),
      html: newsletter({
        brand: 'Forward Future',
        color: '#111111',
        title: 'Video: 28 Days of OpenAI',
        intro: 'This week in AI: labels split on licensing, new agent benchmarks and a look back at a busy month.',
        items: [
          { title: 'The music industry can\'t agree on AI', text: 'Two major labels signed deals while a third filed suit.' },
          { title: 'Agents in the enterprise', text: 'Why most pilots stall after the demo, and what the successful ones do differently.' }
        ]
      }),
      unread: true
    },
    {
      from: { name: 'Vandebron', address: 'support@vandebron.nl' },
      subject: 'Here is another copy of your contract',
      date: at(0, 13, 0),
      text: 'Dear Demo User,\n\nCustomer number: 2434702\n\nDo you agree to your new contract? The contract confirmation is attached.\n\nGreen regards,\nVandebron',
      attachments: [pdf('Contract-confirmation.pdf')],
      unread: true
    },
    {
      from: { name: 'Vandebron', address: 'support@vandebron.nl' },
      subject: 'Here is another copy of your contract',
      date: at(0, 12, 54),
      text: 'Dear Demo User,\n\nCustomer number: 2434702\n\nDo you agree to your new contract? The contract confirmation is attached.\n\nGreen regards,\nVandebron',
      attachments: [pdf('Contract-confirmation.pdf')],
      unread: true
    },
    {
      from: { name: 'Vandebron No Reply', address: 'noreply@vandebron.nl' },
      subject: 'Your password has changed',
      date: at(0, 12, 30),
      text: 'Your password has changed.\n\nIf this was not you, contact us immediately.',
      unread: true
    },
    {
      from: { name: 'Vandebron No Reply', address: 'noreply@vandebron.nl' },
      subject: 'Your sign-in details have been updated',
      date: at(0, 12, 30),
      text: 'Your sign-in details have been updated.\n\nYou can now sign in to My Vandebron with your new details.',
      unread: false
    },
    {
      from: { name: 'Vandebron No Reply', address: 'noreply@vandebron.nl' },
      subject: 'How to change your My Vandebron password',
      date: at(0, 12, 29),
      text: 'How to change your My Vandebron password.\n\nClick the link below to set a new password:\nhttps://example.com/password',
      unread: false
    },
    {
      from: { name: 'Vandebron No Reply', address: 'noreply@vandebron.nl' },
      subject: 'Failed sign-in attempt on your My Vandebron account',
      date: at(0, 12, 29),
      text: 'Failed sign-in attempt on your My Vandebron account.\n\nWe noticed a failed sign-in attempt. If this was not you, change your password.',
      unread: false
    },
    {
      from: { name: 'Bencompare', address: 'info@bencompare.nl' },
      subject: 'Sign in to Bencompare',
      date: at(0, 12, 28),
      text: 'Your Bencompare account\n\nSign in using the link below. The link is valid for 15 minutes.\nhttps://example.com/sign-in',
      unread: false
    },
    {
      from: { name: 'Google', address: 'no-reply@accounts.google.com' },
      subject: 'You updated some of your Google Account details',
      date: at(0, 11, 2),
      html: newsletter({
        brand: 'Google',
        color: '#1a73e8',
        title: 'Your Google Account details have been updated',
        intro: 'You updated some of your Google Account details. If this was you, no action is needed.',
        items: [{ title: 'Security check', text: 'Review recent security activity in your Google Account.' }]
      }),
      unread: true
    },
    {
      from: { name: 'Serus', address: 'alerts@serus.example' },
      subject: '5 more exposures ready to review',
      date: at(0, 10, 20),
      html: newsletter({
        brand: 'Serus',
        color: '#7b61ff',
        title: '5 more exposures ready to review',
        intro: 'Your email may be exposed in data breaches. Unlock all now or review the ones below.',
        items: [
          { title: 'Myspace (High)', text: 'Account data exposed in a historic breach.' },
          { title: 'Wbgames (Low)', text: 'Account e-mail address exposed.' },
          { title: 'Adobe (High)', text: 'E-mail address and password hint exposed.' }
        ]
      }),
      unread: false,
      starred: true
    },
    {
      from: { name: 'Sanne de Vries', address: 'sanne@example.com' },
      to: [me],
      cc: [{ name: 'Joris Bakker', address: 'joris@example.com' }],
      subject: 'Call on Thursday',
      date: at(1, 16, 12),
      text: 'Hi!\n\nShall we have a call on Thursday at 10:00 to discuss the proposal? I have attached the latest version.\n\nBest,\nSanne',
      attachments: [pdf('Proposal-v3.pdf')],
      unread: true
    },
    {
      from: { name: 'NS', address: 'noreply@ns.nl' },
      subject: 'Your travel summary for September',
      date: at(1, 9, 3),
      text: 'Your travel summary for September is ready in My NS.\n\nTotal distance travelled: 412 km.',
      unread: false
    },
    {
      from: { name: 'bol', address: 'service@bol.com' },
      subject: 'Your parcel is on its way',
      date: at(2, 18, 40),
      text: 'Good news! Your parcel is on its way and will arrive tomorrow between 13:00 and 16:00.',
      unread: false
    },
    {
      from: { name: 'Joris Bakker', address: 'joris@example.com' },
      to: [me],
      subject: 'Re: Dinner on Saturday',
      date: at(3, 20, 15),
      text: 'Great, I will book a table for 19:30. See you on Saturday!\n\n> Saturday works for me too.',
      unread: false,
      starred: true
    },
    {
      from: { name: 'Dutch Tax Administration', address: 'noreply@belastingdienst.example' },
      subject: 'You have a new message',
      date: at(9, 8, 0),
      text: 'You have a new message in your inbox on MijnOverheid.',
      unread: false
    }
  ];

  const sent = [
    {
      from: me,
      to: [{ name: 'Sanne de Vries', address: 'sanne@example.com' }],
      subject: 'Re: Call on Thursday',
      date: at(1, 17, 2),
      text: 'Thursday at 10:00 works for me. I will call you.\n\nSent from my PC',
      unread: false
    },
    {
      from: me,
      to: [{ name: 'Joris Bakker', address: 'joris@example.com' }],
      subject: 'Dinner on Saturday',
      date: at(3, 19, 50),
      text: 'Saturday works for me too. Could you book a table?',
      unread: false
    },
    {
      from: me,
      to: [{ name: 'Vandebron', address: 'support@vandebron.nl' }],
      subject: 'Question about my contract',
      date: at(4, 10, 30),
      text: 'Good afternoon,\n\nCould you send the contract again? I have not received it.\n\nKind regards,\nDemo User',
      unread: false
    }
  ];

  const drafts = [
    { from: me, to: [{ name: '', address: 'info@example.com' }], subject: 'Quote request', date: at(2, 11, 0), text: 'Hello,\n\nI would like to request a quote for', unread: false },
    { from: me, to: [], subject: 'Holiday ideas', date: at(5, 21, 0), text: 'Lisbon? Porto?', unread: false },
    { from: me, to: [{ name: 'Sanne de Vries', address: 'sanne@example.com' }], subject: 'Notes', date: at(6, 9, 30), text: 'Action items:\n- send the proposal\n- create a schedule', unread: false }
  ];

  const trash = [
    { from: { name: 'Webshop', address: 'promo@webshop.example' }, subject: 'Last chance: 50% off', date: at(4, 7, 0), text: 'Today only: half price.', unread: false }
  ];

  const invoices = [
    {
      from: { name: 'Ziggo', address: 'billing@ziggo.example' },
      subject: 'Your invoice for October',
      date: at(5, 6, 0),
      text: 'Your invoice for October is ready. The amount of €54.95 will be debited around the 28th.',
      attachments: [pdf('Invoice-October.pdf')],
      unread: false
    }
  ];

  const travel = [
    {
      from: { name: 'KLM', address: 'noreply@klm.example' },
      subject: 'Your booking to Lisbon',
      date: at(12, 14, 0),
      text: 'Thank you for your booking. Booking reference: QX7P2L.\nDeparture: 14 November, 07:15 from Amsterdam Schiphol.',
      unread: false
    }
  ];

  const boxes = {};
  let uid = 1;
  const fill = (pathName, list) => {
    boxes[pathName] = {
      uidValidity: '1',
      uidNext: 1,
      messages: list.map((m) => {
        const msg = {
          uid: uid++,
          from: m.from,
          to: m.to || [me],
          cc: m.cc || [],
          subject: m.subject,
          date: m.date,
          html: m.html || null,
          text: m.text || null,
          attachments: m.attachments || [],
          // The newsletters carry an unsubscribe header, like real ones do.
          headers: m.html && m.html.includes('example.com/unsubscribe')
            ? { 'List-Unsubscribe': '<https://example.com/unsubscribe>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' }
            : undefined,
          messageId: `<demo-${uid}@example.com>`,
          flags: [...(m.unread ? [] : ['\\Seen']), ...(m.starred ? ['\\Flagged'] : []), ...(pathName === 'Drafts' ? ['\\Draft'] : [])]
        };
        return msg;
      })
    };
    boxes[pathName].uidNext = uid;
  };
  fill('INBOX', inbox);
  fill('Sent', sent);
  fill('Drafts', drafts);
  fill('Trash', trash);
  fill('Junk', []);
  fill('Archive', []);
  fill('Invoices', invoices);
  fill('Travel', travel);
  return { boxes, nextUid: uid };
}

class DemoAccount {
  constructor(account, file) {
    this.account = account;
    this.file = file;
    this.state = null;
  }

  load() {
    if (this.state) return this.state;
    try {
      this.state = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (_) {
      this.state = seed();
      this.persist();
    }
    return this.state;
  }

  persist() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.state));
  }

  box(p) {
    const box = this.load().boxes[p];
    if (!box) throw new Error(`Map ${p} bestaat niet.`);
    return box;
  }

  find(p, uid) {
    const msg = this.box(p).messages.find((m) => m.uid === Number(uid));
    if (!msg) throw new Error('Bericht niet gevonden.');
    return msg;
  }

  async verify() {}

  async listFolders() {
    const state = this.load();
    const extra = (state.extraFolders || []).map((name) => ({ path: name, name, role: null }));
    return [...FOLDERS, ...extra].map((f) => ({ ...f, delimiter: '/', specialUse: null }));
  }

  async createFolder(name) {
    const state = this.load();
    if (state.boxes[name]) throw new Error('Er is al een map met die naam.');
    state.boxes[name] = { uidValidity: '1', uidNext: 1, messages: [] };
    state.extraFolders = [...(state.extraFolders || []), name];
    this.persist();
    return name;
  }

  async syncFolder(p, { limit = 200 } = {}) {
    const box = this.box(p);
    const list = box.messages.slice(-limit);
    return {
      uidValidity: box.uidValidity,
      exists: box.messages.length,
      messages: list.map((m) => ({
        uid: m.uid,
        messageId: m.messageId,
        inReplyTo: m.inReplyTo || null,
        subject: m.subject,
        from: m.from,
        to: m.to,
        cc: m.cc,
        replyTo: [],
        date: m.date,
        preview: util.makePreview(m.text || (m.html ? util.htmlToPlain(m.html) : '')),
        unread: !m.flags.includes('\\Seen'),
        starred: m.flags.includes('\\Flagged'),
        answered: m.flags.includes('\\Answered'),
        hasAttachments: (m.attachments || []).length > 0,
        size: (m.html || m.text || '').length
      }))
    };
  }

  async fetchSource(p, uid) {
    const m = this.find(p, uid);
    const composer = new MailComposer({
      from: m.from,
      to: m.to,
      cc: m.cc,
      bcc: m.bcc || [],
      subject: m.subject,
      date: new Date(m.date),
      messageId: m.messageId,
      inReplyTo: m.inReplyTo || undefined,
      references: m.references || undefined,
      text: m.text || undefined,
      html: m.html || undefined,
      headers: m.headers || undefined,
      attachments: (m.attachments || []).map((a) => ({ ...a }))
    });
    // Like an IMAP server, return the stored message as it was saved, Bcc included.
    const node = composer.compile();
    node.keepBcc = true;
    return node.build();
  }

  async setFlags(p, uid, { unread, starred, answered }) {
    const m = this.find(p, uid);
    const set = new Set(m.flags);
    if (unread === true) set.delete('\\Seen');
    if (unread === false) set.add('\\Seen');
    if (starred === true) set.add('\\Flagged');
    if (starred === false) set.delete('\\Flagged');
    if (answered === true) set.add('\\Answered');
    m.flags = [...set];
    this.persist();
  }

  async move(p, uid, destination, { expectUidValidity = null } = {}) {
    const src = this.box(p);
    const dest = this.box(destination);
    if (expectUidValidity && String(src.uidValidity) !== String(expectUidValidity)) {
      throw Object.assign(new Error('De map is op de server opnieuw opgebouwd.'), { code: 'UIDVALIDITY' });
    }
    const idx = src.messages.findIndex((m) => m.uid === Number(uid));
    if (idx < 0) throw new Error('Bericht niet gevonden.');
    const [m] = src.messages.splice(idx, 1);
    m.uid = this.state.nextUid++;
    dest.messages.push(m);
    dest.messages.sort((a, b) => a.uid - b.uid);
    this.persist();
    return { uid: m.uid, uidValidity: String(dest.uidValidity) };
  }

  async deleteForever(p, uid) {
    const box = this.box(p);
    box.messages = box.messages.filter((m) => m.uid !== Number(uid));
    this.persist();
  }

  async append(p, raw, flags = []) {
    const parsed = await simpleParser(raw);
    const box = this.box(p);
    const m = {
      uid: this.load().nextUid++,
      from: util.addressFromParsed(parsed.from)[0] || { name: '', address: DEMO_EMAIL },
      to: util.addressFromParsed(parsed.to),
      cc: util.addressFromParsed(parsed.cc),
      bcc: util.addressFromParsed(parsed.bcc),
      subject: parsed.subject || '',
      date: (parsed.date || new Date()).getTime(),
      html: parsed.html || null,
      text: parsed.text || null,
      inReplyTo: parsed.inReplyTo || null,
      references: parsed.references || null,
      attachments: (parsed.attachments || []).map((a) => ({
        filename: a.filename,
        contentType: a.contentType,
        content: a.content.toString('base64'),
        encoding: 'base64',
        cid: a.contentId ? a.contentId.replace(/[<>]/g, '') : undefined
      })),
      messageId: parsed.messageId || `<demo-${Date.now()}@example.com>`,
      flags: [...flags]
    };
    box.messages.push(m);
    this.persist();
    return m.uid;
  }

  async send(mail) {
    const composer = new MailComposer({ ...mail, attachDataUrls: true });
    const raw = await composer.compile().build();
    const recipients = [...(mail.to || []), ...(mail.cc || []), ...(mail.bcc || [])].map((a) =>
      String(a.address || a).toLowerCase()
    );
    // Mail addressed to the demo account itself lands in its inbox, like a real round trip.
    if (recipients.includes(DEMO_EMAIL)) await this.append('INBOX', raw, []);
    return raw;
  }

  savesSentCopy() {
    return false;
  }

  async close() {}
}

module.exports = { DemoAccount, DEMO_EMAIL, seed };
