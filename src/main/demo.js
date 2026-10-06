'use strict';

const fs = require('fs');
const path = require('path');
const { simpleParser } = require('mailparser');
const MailComposer = require('nodemailer/lib/mail-composer');
const util = require('./mailutil');

const DEMO_EMAIL = 'demo@voorbeeld.nl';

const FOLDERS = [
  { path: 'INBOX', name: 'INBOX', role: 'inbox' },
  { path: 'Sent', name: 'Sent', role: 'sent' },
  { path: 'Drafts', name: 'Drafts', role: 'drafts' },
  { path: 'Trash', name: 'Trash', role: 'trash' },
  { path: 'Junk', name: 'Junk', role: 'junk' },
  { path: 'Archive', name: 'Archive', role: 'archive' },
  { path: 'Facturen', name: 'Facturen', role: null },
  { path: 'Reizen', name: 'Reizen', role: null }
];

function newsletter({ brand, color, title, intro, items }) {
  const blocks = items
    .map(
      (i) => `<tr><td style="padding:16px 24px;border-top:1px solid #e6e6e6">
<h3 style="margin:0 0 6px;font:600 18px Arial,sans-serif;color:#111">${i.title}</h3>
<p style="margin:0;font:15px/1.5 Arial,sans-serif;color:#444">${i.text}</p>
<p style="margin:10px 0 0"><a href="https://example.com/${encodeURIComponent(i.title)}" style="color:${color};font:600 14px Arial,sans-serif">Lees meer</a></p>
</td></tr>`
    )
    .join('');
  return `<!doctype html><html><body style="margin:0;background:#f2f2f2">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f2f2f2"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;max-width:600px">
<tr><td style="padding:14px 24px;text-align:right;font:12px Arial,sans-serif"><a href="https://example.com/browser" style="color:#3b78c4">Bekijk e-mail in browser</a></td></tr>
<tr><td style="padding:20px 24px;background:${color};color:#fff;font:700 26px Arial,sans-serif">${brand}</td></tr>
<tr><td style="padding:24px"><h1 style="margin:0 0 8px;font:700 26px Arial,sans-serif;color:#111">${title}</h1>
<p style="margin:0;font:16px/1.5 Arial,sans-serif;color:#333">${intro}</p></td></tr>
${blocks}
<tr><td style="padding:20px 24px;background:#fafafa;font:12px Arial,sans-serif;color:#777">Je ontvangt deze e-mail omdat je je hebt aangemeld. <a href="https://example.com/afmelden" style="color:#777">Afmelden</a></td></tr>
</table></td></tr></table></body></html>`;
}

function seed(now = Date.now()) {
  const today = new Date(now);
  const at = (daysAgo, h, m) => {
    const d = new Date(today);
    d.setDate(d.getDate() - daysAgo);
    d.setHours(h, m, 0, 0);
    // Keep "today" messages in the past relative to now.
    if (daysAgo === 0 && d.getTime() > now) return now - (60 - m) * 60000;
    return d.getTime();
  };
  const me = { name: 'Demo Gebruiker', address: DEMO_EMAIL };
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
      from: { name: 'ANWB Nieuwsbrief', address: 'nieuwsbrieven@anwb.nl' },
      subject: 'Dit kost een verkeersboete in 2027',
      date: at(0, 14, 45),
      html: newsletter({
        brand: 'ANWB',
        color: '#0b5cad',
        title: 'Rijden met laagstaande zon: zorg dat je ruiten schoon zijn',
        intro: 'Volg deze tips en voorkom gevaarlijke situaties. Zo heb je beter zicht.',
        items: [
          { title: 'Top 10 goedkoopste nieuwe auto\'s', text: 'Deze modellen kosten het minst in aanschaf en onderhoud.' },
          { title: 'Dit kost een verkeersboete in 2027', text: 'Een overzicht van de nieuwe tarieven per overtreding.' },
          { title: 'Winterbanden: wanneer wissel je?', text: 'Vanaf 7 graden grijpen winterbanden beter dan zomerbanden.' }
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
      from: { name: 'Vandebron', address: 'klantenservice@vandebron.nl' },
      subject: 'Alsjeblieft, hierbij opnieuw je contract',
      date: at(0, 13, 0),
      text: 'Beste Demo Gebruiker,\n\nKlantnummer: 2434702\n\nGa je akkoord met je nieuwe contract? In de bijlage vind je de contractbevestiging.\n\nGroene groet,\nVandebron',
      attachments: [pdf('Contractbevestiging.pdf')],
      unread: true
    },
    {
      from: { name: 'Vandebron', address: 'klantenservice@vandebron.nl' },
      subject: 'Alsjeblieft, hierbij opnieuw je contract',
      date: at(0, 12, 54),
      text: 'Beste Demo Gebruiker,\n\nKlantnummer: 2434702\n\nGa je akkoord met je nieuwe contract? In de bijlage vind je de contractbevestiging.\n\nGroene groet,\nVandebron',
      attachments: [pdf('Contractbevestiging.pdf')],
      unread: true
    },
    {
      from: { name: 'Vandebron No Reply', address: 'noreply@vandebron.nl' },
      subject: 'Je wachtwoord is gewijzigd',
      date: at(0, 12, 30),
      text: 'Je wachtwoord is gewijzigd.\n\nWas jij dit niet? Neem dan direct contact met ons op.',
      unread: true
    },
    {
      from: { name: 'Vandebron No Reply', address: 'noreply@vandebron.nl' },
      subject: 'Je inloggegevens zijn bijgewerkt',
      date: at(0, 12, 30),
      text: 'Je inloggegevens zijn bijgewerkt.\n\nJe kunt nu inloggen op Mijn Vandebron met je nieuwe gegevens.',
      unread: false
    },
    {
      from: { name: 'Vandebron No Reply', address: 'noreply@vandebron.nl' },
      subject: 'Zo wijzig je je wachtwoord van Mijn Vandebron',
      date: at(0, 12, 29),
      text: 'Zo wijzig je je wachtwoord van Mijn Vandebron.\n\nKlik op de link hieronder om een nieuw wachtwoord in te stellen:\nhttps://example.com/wachtwoord',
      unread: false
    },
    {
      from: { name: 'Vandebron No Reply', address: 'noreply@vandebron.nl' },
      subject: 'Mislukte inlogpoging op je Mijn Vandebron-account',
      date: at(0, 12, 29),
      text: 'Mislukte inlogpoging op je Mijn Vandebron-account.\n\nWe zagen een mislukte inlogpoging. Was jij dit niet? Wijzig dan je wachtwoord.',
      unread: false
    },
    {
      from: { name: 'Bencompare', address: 'info@bencompare.nl' },
      subject: 'Inloggen Bencompare',
      date: at(0, 12, 28),
      text: 'Uw Bencompare account\n\nInloggen kan via de link hieronder. De link is 15 minuten geldig.\nhttps://example.com/inloggen',
      unread: false
    },
    {
      from: { name: 'Google', address: 'no-reply@accounts.google.com' },
      subject: 'Je hebt een deel van je Google-accountgegevens bijgewerkt',
      date: at(0, 11, 2),
      html: newsletter({
        brand: 'Google',
        color: '#1a73e8',
        title: 'Je Google-accountgegevens zijn bijgewerkt',
        intro: 'Je hebt een deel van je Google-accountgegevens bijgewerkt. Als jij dit was, hoef je niets te doen.',
        items: [{ title: 'Beveiligingscheck', text: 'Bekijk je recente beveiligingsactiviteit in je Google-account.' }]
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
      from: { name: 'Sanne de Vries', address: 'sanne@voorbeeld.nl' },
      to: [me],
      cc: [{ name: 'Joris Bakker', address: 'joris@voorbeeld.nl' }],
      subject: 'Afspraak donderdag',
      date: at(1, 16, 12),
      text: 'Hoi!\n\nZullen we donderdag om 10:00 bellen over het voorstel? Ik heb de laatste versie in de bijlage gezet.\n\nGroet,\nSanne',
      attachments: [pdf('Voorstel-v3.pdf')],
      unread: true
    },
    {
      from: { name: 'NS', address: 'noreply@ns.nl' },
      subject: 'Je reisoverzicht van september',
      date: at(1, 9, 3),
      text: 'Je reisoverzicht van september staat klaar in Mijn NS.\n\nTotaal gereisd: 412 km.',
      unread: false
    },
    {
      from: { name: 'bol', address: 'service@bol.com' },
      subject: 'Je pakket is onderweg',
      date: at(2, 18, 40),
      text: 'Goed nieuws! Je pakket is onderweg en wordt morgen tussen 13:00 en 16:00 bezorgd.',
      unread: false
    },
    {
      from: { name: 'Joris Bakker', address: 'joris@voorbeeld.nl' },
      to: [me],
      subject: 'Re: Etentje zaterdag',
      date: at(3, 20, 15),
      text: 'Top, ik reserveer voor 19:30. Tot zaterdag!\n\n> Zaterdag lukt mij ook.',
      unread: false,
      starred: true
    },
    {
      from: { name: 'Belastingdienst', address: 'noreply@belastingdienst.example' },
      subject: 'Er staat een nieuw bericht voor u klaar',
      date: at(9, 8, 0),
      text: 'Er staat een nieuw bericht voor u klaar in uw Berichtenbox op MijnOverheid.',
      unread: false
    }
  ];

  const sent = [
    {
      from: me,
      to: [{ name: 'Sanne de Vries', address: 'sanne@voorbeeld.nl' }],
      subject: 'Re: Afspraak donderdag',
      date: at(1, 17, 2),
      text: 'Donderdag 10:00 is goed. Ik bel je.\n\nVerzonden vanaf mijn pc',
      unread: false
    },
    {
      from: me,
      to: [{ name: 'Joris Bakker', address: 'joris@voorbeeld.nl' }],
      subject: 'Etentje zaterdag',
      date: at(3, 19, 50),
      text: 'Zaterdag lukt mij ook. Reserveer jij?',
      unread: false
    },
    {
      from: me,
      to: [{ name: 'Vandebron', address: 'klantenservice@vandebron.nl' }],
      subject: 'Vraag over mijn contract',
      date: at(4, 10, 30),
      text: 'Goedemiddag,\n\nKunnen jullie het contract opnieuw sturen? Ik heb het niet ontvangen.\n\nMet vriendelijke groet,\nDemo Gebruiker',
      unread: false
    }
  ];

  const drafts = [
    { from: me, to: [{ name: '', address: 'info@voorbeeld.nl' }], subject: 'Offerteaanvraag', date: at(2, 11, 0), text: 'Beste,\n\nGraag ontvang ik een offerte voor', unread: false },
    { from: me, to: [], subject: 'Ideeën voor de vakantie', date: at(5, 21, 0), text: 'Lissabon? Porto?', unread: false },
    { from: me, to: [{ name: 'Sanne de Vries', address: 'sanne@voorbeeld.nl' }], subject: 'Notities', date: at(6, 9, 30), text: 'Actiepunten:\n- voorstel versturen\n- planning maken', unread: false }
  ];

  const trash = [
    { from: { name: 'Webshop', address: 'promo@webshop.example' }, subject: 'Laatste kans: 50% korting', date: at(4, 7, 0), text: 'Alleen vandaag: de helft van de prijs.', unread: false }
  ];

  const facturen = [
    {
      from: { name: 'Ziggo', address: 'facturen@ziggo.example' },
      subject: 'Je factuur van oktober',
      date: at(5, 6, 0),
      text: 'Je factuur van oktober staat klaar. Het bedrag van € 54,95 wordt rond de 28e afgeschreven.',
      attachments: [pdf('Factuur-oktober.pdf')],
      unread: false
    }
  ];

  const reizen = [
    {
      from: { name: 'KLM', address: 'noreply@klm.example' },
      subject: 'Je boeking naar Lissabon',
      date: at(12, 14, 0),
      text: 'Bedankt voor je boeking. Boekingscode: QX7P2L.\nVertrek: 14 november, 07:15 vanaf Amsterdam Schiphol.',
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
          messageId: `<demo-${uid}@voorbeeld.nl>`,
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
  fill('Facturen', facturen);
  fill('Reizen', reizen);
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
    this.load();
    return FOLDERS.map((f) => ({ ...f, delimiter: '/', specialUse: null }));
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
      subject: m.subject,
      date: new Date(m.date),
      messageId: m.messageId,
      inReplyTo: m.inReplyTo || undefined,
      references: m.references || undefined,
      text: m.text || undefined,
      html: m.html || undefined,
      attachments: (m.attachments || []).map((a) => ({ ...a }))
    });
    return composer.compile().build();
  }

  async setFlags(p, uid, { unread, starred }) {
    const m = this.find(p, uid);
    const set = new Set(m.flags);
    if (unread === true) set.delete('\\Seen');
    if (unread === false) set.add('\\Seen');
    if (starred === true) set.add('\\Flagged');
    if (starred === false) set.delete('\\Flagged');
    m.flags = [...set];
    this.persist();
  }

  async move(p, uid, destination) {
    const src = this.box(p);
    const dest = this.box(destination);
    const idx = src.messages.findIndex((m) => m.uid === Number(uid));
    if (idx < 0) throw new Error('Bericht niet gevonden.');
    const [m] = src.messages.splice(idx, 1);
    m.uid = this.state.nextUid++;
    dest.messages.push(m);
    dest.messages.sort((a, b) => a.uid - b.uid);
    this.persist();
    return m.uid;
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
      messageId: parsed.messageId || `<demo-${Date.now()}@voorbeeld.nl>`,
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
