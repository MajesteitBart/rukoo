// The message editor. It runs inline in the main window's reading pane, or on its own in a
// compose window (compose.js). Either way it saves drafts as you write.
import { icons } from './icons.js';
import { api, esc, $, toast, dialog, confirmDialog, showMenu, person, formatAddress, quoteDate, fileSize, hhmm, isLight } from './ui.js';
import { fillFrame } from './mailframe.js';

const EMAIL_RE = /^[^@\s,;<>]+@[^@\s,;<>]+\.[^@\s,;<>]+$/;
// Autosave this long after the last change.
const AUTOSAVE_MS = 8000;
export const COMPOSE_TITLES = { new: 'Nieuw bericht', reply: 'Beantwoorden', replyAll: 'Allen beantwoorden', forward: 'Doorsturen', draft: 'Concept' };

let contactsCache = null;
let attachmentKey = 0;
const keyed = (a) => ({ ...a, key: ++attachmentKey });

function prefixed(subject, prefix) {
  const s = subject || '';
  const re = prefix === 'Re' ? /^(re|antw|aw)\s*:/i : /^(fwd?|doorst)\s*:/i;
  return re.test(s.trim()) ? s : `${prefix}: ${s}`;
}

function sameAddress(a, b) {
  return String(a || '').toLowerCase() === String(b || '').toLowerCase();
}

function uniq(list) {
  const seen = new Set();
  return list.filter((a) => {
    const k = String(a.address || '').toLowerCase();
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// A reopened draft goes into this document itself, so it is parsed in an inert
// document and reduced to plain content: no style sheets, scripts, app class names
// or fixed positioning that could cover the editor.
function cleanDraftHtml(html) {
  const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
  doc.querySelectorAll('style, link, meta, script, noscript, iframe, frame, object, embed, base, form, title, template').forEach((n) => n.remove());
  for (const el of doc.body.querySelectorAll('*')) {
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on') || name === 'id' || name === 'contenteditable' || name === 'tabindex') el.removeAttribute(attr.name);
      else if (name === 'class' && attr.value !== 'signature') el.removeAttribute(attr.name);
      else if ((name === 'href' || name === 'src') && /^\s*(javascript|vbscript|data:text\/html)/i.test(attr.value)) el.removeAttribute(attr.name);
    }
    if (el.style && /fixed|sticky|absolute/i.test(el.style.position)) el.style.position = '';
  }
  return doc.body.innerHTML;
}

const QUOTE_MARK = '-------- Oorspronkelijk bericht --------';

// A saved reply carries the earlier mail after its own text: a header block, then a blockquote.
// Split that off again, so a reopened draft shows it behind the "···" pill instead of in the text.
function splitQuote(html) {
  const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
  for (const head of doc.body.querySelectorAll('div')) {
    if (!head.textContent.trim().startsWith(QUOTE_MARK)) continue;
    let quote = head.nextElementSibling;
    while (quote && quote.tagName === 'BR') quote = quote.nextElementSibling;
    if (!quote || quote.tagName !== 'BLOCKQUOTE') continue;
    head.querySelectorAll('br').forEach((br) => br.replaceWith('\n'));
    const text = head.textContent.trim();
    const quoteHtml = quote.innerHTML;
    // Remove the line break before the header, the header, the breaks after it and the quote.
    if (head.previousSibling && head.previousSibling.nodeName === 'BR') head.previousSibling.remove();
    let node = head;
    while (node && node !== quote) {
      const next = node.nextSibling;
      node.remove();
      node = next;
    }
    quote.remove();
    return { body: doc.body.innerHTML, quoted: { head: text, html: quoteHtml } };
  }
  return { body: html, quoted: null };
}

function initialState(data, opts, m) {
  const accounts = data.accounts;
  const defaultAcc = accounts.find((a) => a.isDefault) || accounts[0];
  const acc = (m && accounts.find((a) => a.id === m.accountId)) || (opts.accountId && accounts.find((a) => a.id === opts.accountId)) || defaultAcc;
  const s = {
    mode: opts.mode,
    accountId: acc.id,
    from: acc.defaultFrom,
    to: opts.to ? [...opts.to] : [],
    cc: [],
    bcc: [],
    showCc: false,
    showBcc: false,
    subject: opts.subject || '',
    attachments: [],
    include: true,
    quoteOpen: false,
    original: null,
    // The earlier mail of a reopened reply: { head, html }.
    quoted: null,
    inReplyTo: null,
    references: [],
    draftId: null,
    replyToId: null,
    forwardId: null,
    bodyHtml: null,
    dirty: false,
    savedAt: null
  };
  const signature = acc.signature ?? data.settings.signature ?? '';
  const sigHtml = signature ? `<div><br></div><div class="signature">${esc(signature).replace(/\n/g, '<br>')}</div>` : '';
  s.bodyHtml = `<div>${esc(opts.body || '').replace(/\n/g, '<br>') || '<br>'}</div>${sigHtml}`;

  if (!m) return s;
  const own = (address) => acc.identities.some((i) => sameAddress(i.address, address));
  if (opts.mode === 'draft') {
    if (m.from && own(m.from.address)) s.from = acc.identities.find((i) => sameAddress(i.address, m.from.address)).address;
    s.to = m.to || [];
    s.cc = m.cc || [];
    s.bcc = m.bcc || [];
    s.showCc = s.cc.length > 0;
    s.showBcc = s.bcc.length > 0;
    s.subject = m.subject || '';
    // The quote is mail the engine already sanitized for the sandboxed frame; only the text goes into the editor.
    const parts = splitQuote(m.html);
    s.bodyHtml = cleanDraftHtml(parts.body);
    s.quoted = parts.quoted;
    s.draftId = m.id;
    s.savedAt = m.date || null;
    // Attachments stay on the stored draft; they are copied from it when sending or re-saving.
    s.forwardId = m.id;
    s.attachments = (m.attachments || []).map((a) => keyed({ forwardIndex: a.index, filename: a.filename, size: a.size }));
    s.inReplyTo = m.inReplyTo || null;
    s.references = m.references || [];
    return s;
  }
  s.original = m;
  if (opts.mode === 'reply' || opts.mode === 'replyAll') {
    const target = (m.replyTo && m.replyTo.length ? m.replyTo : [m.from]).filter(Boolean);
    const fromSelf = own(m.from && m.from.address);
    s.to = fromSelf ? [...(m.to || [])] : target;
    if (opts.mode === 'replyAll') {
      const extra = fromSelf ? [] : (m.to || []).filter((a) => !own(a.address));
      s.to = uniq([...s.to, ...extra]);
      s.cc = uniq((m.cc || []).filter((a) => !own(a.address) && !s.to.some((t) => sameAddress(t.address, a.address))));
      s.showCc = s.cc.length > 0;
    }
    s.subject = prefixed(m.subject, 'Re');
    s.from = replyFrom(acc, m) || s.from;
    s.inReplyTo = m.messageId;
    s.references = [...(m.references || []), m.messageId].filter(Boolean);
    s.replyToId = m.id;
  }
  if (opts.mode === 'forward') {
    s.subject = prefixed(m.subject, 'Fwd');
    s.from = replyFrom(acc, m) || s.from;
    s.forwardId = m.id;
    s.attachments = (m.attachments || []).map((a) => keyed({ forwardIndex: a.index, filename: a.filename, size: a.size }));
  }
  return s;
}

// Answer from the address the mail was sent to, so mail to an alias is answered from that alias.
function replyFrom(acc, m) {
  if (m.from && acc.identities.some((i) => sameAddress(i.address, m.from.address))) {
    return acc.identities.find((i) => sameAddress(i.address, m.from.address)).address;
  }
  const recipients = [...(m.to || []), ...(m.cc || [])];
  const hit = acc.identities.find((i) => !i.primary && recipients.some((r) => sameAddress(r.address, i.address)));
  if (hit) return hit.address;
  const primary = recipients.some((r) => sameAddress(r.address, acc.email));
  return primary ? acc.email : null;
}

function quoteHeader(m) {
  const lines = [
    '-------- Oorspronkelijk bericht --------',
    `Van: ${formatAddress(m.from)}`,
    `Datum: ${quoteDate(m.date)}`,
    `Aan: ${(m.to || []).map(formatAddress).join(', ')}`
  ];
  if (m.cc && m.cc.length) lines.push(`Cc: ${m.cc.map(formatAddress).join(', ')}`);
  lines.push(`Onderwerp: ${m.subject || ''}`);
  return lines.join('\n');
}

function recipientsHtml(list) {
  return list
    .map(
      (a, i) =>
        `<span class="recipient ${EMAIL_RE.test(a.address) ? '' : 'invalid'}" title="${esc(formatAddress(a))}">${esc(person(a))}<button data-remove="${i}" title="Verwijderen" tabindex="-1">${icons.close}</button></span>`
    )
    .join('');
}

const FORMAT_BUTTONS = `
  <button class="icon-btn sm" data-cmd="bold" title="Vet (Ctrl+B)">${icons.bold}</button>
  <button class="icon-btn sm" data-cmd="italic" title="Cursief (Ctrl+I)">${icons.italic}</button>
  <button class="icon-btn sm" data-cmd="underline" title="Onderstrepen (Ctrl+U)">${icons.underline}</button>
  <span class="sep"></span>
  <button class="icon-btn sm" data-c="link" title="Link (Ctrl+K)">${icons.link}</button>
  <button class="icon-btn sm" data-cmd="insertUnorderedList" title="Opsomming">${icons.ul}</button>
  <button class="icon-btn sm" data-cmd="insertOrderedList" title="Genummerde lijst">${icons.ol}</button>`;

function template(data, st, inline) {
  const accounts = data.accounts;
  // One entry per sending address; with several accounts the addresses are grouped per account.
  const fromOptions = (a) =>
    a.identities
      .map((i) => {
        const key = `${a.id}|${i.address}`;
        const on = a.id === st.accountId && sameAddress(i.address, st.from);
        return `<option value="${esc(key)}" ${on ? 'selected' : ''}>${esc(i.name ? `${i.name} <${i.address}>` : i.address)}</option>`;
      })
      .join('');
  const identityCount = accounts.reduce((n, a) => n + a.identities.length, 0);
  const acc = accounts.find((a) => a.id === st.accountId);
  const me = acc.identities.find((i) => sameAddress(i.address, st.from)) || { address: st.from, name: acc.name };
  const from =
    identityCount > 1
      ? `<select id="from" data-field="account">${
          accounts.length > 1 ? accounts.map((a) => `<optgroup label="${esc(a.email)}">${fromOptions(a)}</optgroup>`).join('') : fromOptions(accounts[0])
        }</select>`
      : `<span class="from-static">${esc(me.name ? `${me.name} <${me.address}>` : me.address)}</span>`;
  const quoteHead = st.original ? quoteHeader(st.original) : st.quoted ? st.quoted.head : '';
  const quote = st.original || st.quoted
    ? `<div class="quote-zone">
        <button class="quote-pill" data-c="quote" title="Vorige berichten tonen" aria-expanded="false">···</button>
        <div class="quote" hidden>
          <div class="quote-bar"><span>Vorig bericht</span><button class="link-btn" data-c="include">Niet meesturen</button></div>
          <div class="quote-head">${esc(quoteHead)}</div>
          <iframe class="quote-frame" sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox" title="Vorig bericht"></iframe>
        </div>
      </div>`
    : '';
  return `
    ${
      inline
        ? `<div class="composer-head">
            <span class="composer-title">${esc(COMPOSE_TITLES[st.mode] || 'Nieuw bericht')}</span>
            <span class="spacer"></span>
            <button class="icon-btn" data-c="popout" title="Openen in een eigen venster">${icons.popOut}</button>
            <button class="icon-btn" data-c="close" title="Sluiten (Esc)">${icons.close}</button>
          </div>`
        : ''
    }
    <div class="composer-scroll">
      <div class="compose-fields">
        <div class="field"><label for="from">Van</label>${from}</div>
        <div class="field" data-rfield="to"><label>Aan</label><div class="recipients"></div>
          <span class="cc-links"><button class="link-btn" data-c="cc" ${st.showCc ? 'hidden' : ''}>Cc</button><button class="link-btn" data-c="bcc" ${st.showBcc ? 'hidden' : ''}>Bcc</button></span></div>
        <div class="field" data-rfield="cc" ${st.showCc ? '' : 'hidden'}><label>Cc</label><div class="recipients"></div></div>
        <div class="field" data-rfield="bcc" ${st.showBcc ? '' : 'hidden'}><label>Bcc</label><div class="recipients"></div></div>
        <div class="field"><label for="subject">Onderwerp</label><input id="subject" data-field="subject" type="text" value="${esc(st.subject)}" autocomplete="off"/></div>
      </div>
      <div class="compose-body">
        <div class="editor" contenteditable="true" spellcheck="true" role="textbox" aria-multiline="true" aria-label="Berichttekst" data-placeholder="Schrijf je bericht"></div>
        ${quote}
      </div>
      <div class="compose-attachments" aria-label="Bijlagen"></div>
    </div>
    <div class="format-row" role="toolbar" aria-label="Opmaak" hidden>
      ${FORMAT_BUTTONS}
      <button class="icon-btn sm" data-cmd="outdent" title="Inspringing verkleinen">${icons.outdent}</button>
      <button class="icon-btn sm" data-cmd="indent" title="Inspringing vergroten">${icons.indent}</button>
      <span class="sep"></span>
      <button class="icon-btn sm" data-color="foreColor" title="Tekstkleur">${icons.textColor}</button>
      <button class="icon-btn sm" data-color="hiliteColor" title="Markeren">${icons.highlight}</button>
      <button class="icon-btn sm" data-cmd="removeFormat" title="Opmaak wissen">${icons.clearFormat}</button>
    </div>
    <div class="composer-bar">
      <button class="icon-btn" data-c="attach" title="Bestanden bijvoegen">${icons.clip}</button>
      <button class="icon-btn" data-c="image" title="Afbeelding invoegen">${icons.image}</button>
      <button class="icon-btn" data-c="format" title="Opmaak" aria-pressed="false">${icons.textFormat}</button>
      <button class="icon-btn" data-c="discard" title="Concept verwijderen">${icons.trash}</button>
      <button class="icon-btn" data-c="more" title="Meer opties" aria-haspopup="menu">${icons.more}</button>
      <span class="spacer"></span>
      <span class="save-state" aria-live="polite"></span>
      <button class="btn primary send-btn" data-c="send" title="Verzenden (Ctrl+Enter)"><span>Verzenden</span>${icons.send}</button>
    </div>
    <div class="float-bar" role="toolbar" aria-label="Opmaak" hidden>${FORMAT_BUTTONS}</div>
    <input type="color" class="color-input" value="#d6336c" tabindex="-1" aria-hidden="true"/>`;
}

// host: the element to render in. Returns a controller the main window uses to leave or close it.
// options: { data, opts, message, inline, onDone(), onPopOut(opts), onTitle(text) }
export function mountComposer(host, { data, opts, message, inline, onDone, onPopOut, onTitle }) {
  const st = initialState(data, opts, message);
  const page = document.createElement('div');
  page.className = `compose composer ${inline ? 'inline' : ''}`;
  page.setAttribute('role', inline ? 'region' : 'main');
  page.setAttribute('aria-label', COMPOSE_TITLES[st.mode] || 'Nieuw bericht');
  page.innerHTML = template(data, st, inline);
  host.appendChild(page);
  // Listeners outside the composer, removed when it closes.
  const cleanups = [];
  const listen = (target, type, fn, opt) => {
    target.addEventListener(type, fn, opt);
    cleanups.push(() => target.removeEventListener(type, fn, opt));
  };
  const keyTarget = inline ? page : document;

  const editor = $('.editor', page);
  editor.innerHTML = st.bodyHtml;
  document.execCommand('styleWithCSS', false, true);

  const title = () => onTitle && onTitle(st.subject.trim() || COMPOSE_TITLES[st.mode] || 'Nieuw bericht');
  title();

  const quoteFrame = $('.quote-frame', page);
  let quoteDrawn = false;
  const drawQuote = () => {
    if (!quoteFrame || !st.quoteOpen) return;
    quoteDrawn = true;
    fillFrame(quoteFrame, st.original || { html: st.quoted.html, isHtml: true }, { light: isLight(), darkEmails: data.settings.darkEmails !== false, forQuote: true });
  };

  // ----- save status -----

  const saveState = $('.save-state', page);
  const showSaveState = (text, tip = '') => {
    saveState.textContent = text;
    saveState.title = tip;
  };
  // Quiet while you write; only a saved draft is worth mentioning.
  const describeSaved = () => {
    page.dataset.dirty = String(st.dirty);
    if (st.saving) return showSaveState('Opslaan...');
    if (!st.dirty && st.savedAt && st.draftId) return showSaveState('Concept opgeslagen', `Opgeslagen om ${hhmm(st.savedAt)}`);
    showSaveState('');
  };
  describeSaved();

  const renderRecipients = (field) => {
    const box = $(`[data-rfield="${field}"] .recipients`, page);
    const draft = box.querySelector('input')?.value || '';
    box.innerHTML = `${recipientsHtml(st[field])}<input type="text" data-rinput="${field}" autocomplete="off" spellcheck="false" aria-label="${field === 'to' ? 'Aan' : field === 'cc' ? 'Cc' : 'Bcc'}"/>`;
    const input = box.querySelector('input');
    input.value = draft;
    return input;
  };
  ['to', 'cc', 'bcc'].forEach(renderRecipients);

  const renderAttachments = () => {
    $('.compose-attachments', page).innerHTML = st.attachments
      .map(
        (a, i) =>
          `<span class="att-chip" title="${esc(a.path || a.filename)}">${icons.clip}<span class="n">${esc(a.filename)}</span>${a.size ? `<span class="s">${fileSize(a.size)}</span>` : ''}<button data-unattach="${i}" title="Verwijderen">${icons.close}</button></span>`
      )
      .join('');
  };
  renderAttachments();

  // ----- dirty tracking and autosave -----

  let autosaveTimer = null;
  let autosave = true;
  // Counts edits, so a save that started before the latest edit leaves the window dirty.
  let editCount = 0;
  const armAutosave = () => {
    clearTimeout(autosaveTimer);
    if (autosave) autosaveTimer = setTimeout(() => saveDraft({ auto: true }), AUTOSAVE_MS);
  };
  const changed = () => {
    editCount++;
    st.dirty = true;
    describeSaved();
    armAutosave();
  };

  const commit = (field, text) => {
    const parts = String(text || '')
      .split(/[,;\n]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    for (const p of parts) {
      const m = p.match(/^(.*)<([^>]+)>$/);
      const entry = m ? { name: m[1].trim().replace(/^"|"$/g, ''), address: m[2].trim() } : { name: '', address: p };
      if (!st[field].some((a) => sameAddress(a.address, entry.address))) st[field].push(entry);
    }
    if (parts.length) changed();
  };

  // Autocomplete from addresses seen in synced mail.
  let suggest = null;
  const closeSuggest = () => {
    suggest?.remove();
    suggest = null;
  };
  const showSuggest = async (input) => {
    const q = input.value.trim().toLowerCase();
    closeSuggest();
    if (q.length < 1) return;
    if (!contactsCache) contactsCache = await api('contacts').catch(() => []);
    const hits = contactsCache.filter((c) => `${c.name} ${c.address}`.toLowerCase().includes(q)).slice(0, 6);
    if (!hits.length || input.value.trim().toLowerCase() !== q) return;
    suggest = document.createElement('div');
    suggest.className = 'suggest';
    suggest.setAttribute('role', 'listbox');
    suggest.innerHTML = hits
      .map((c, i) => `<button data-i="${i}" role="option" class="${i === 0 ? 'active' : ''}"><div>${esc(c.name || c.address)}</div><div class="addr">${esc(c.address)}</div></button>`)
      .join('');
    suggest.hits = hits;
    suggest.addEventListener('mousedown', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      e.preventDefault();
      pick(hits[Number(b.dataset.i)], input);
    });
    input.closest('.field').appendChild(suggest);
  };
  const pick = (contact, input) => {
    const field = input.dataset.rinput;
    if (!st[field].some((a) => sameAddress(a.address, contact.address))) st[field].push({ ...contact });
    input.value = '';
    changed();
    closeSuggest();
    renderRecipients(field).focus();
  };

  page.addEventListener('input', (e) => {
    const t = e.target;
    if (t.dataset.rinput) {
      if (/[,;]/.test(t.value)) {
        commit(t.dataset.rinput, t.value);
        t.value = '';
        renderRecipients(t.dataset.rinput).focus();
        return;
      }
      showSuggest(t);
      return;
    }
    if (t.dataset.field === 'subject') {
      st.subject = t.value;
      title();
    }
    if (t.classList.contains('color-input')) return;
    changed();
  });
  page.addEventListener('change', (e) => {
    const t = e.target;
    if (t.dataset.field === 'account') {
      const [accountId, ...rest] = t.value.split('|');
      st.accountId = accountId;
      st.from = rest.join('|');
      changed();
    }
  });
  page.addEventListener(
    'blur',
    (e) => {
      const t = e.target;
      if (t.dataset && t.dataset.rinput && t.value.trim()) {
        commit(t.dataset.rinput, t.value);
        t.value = '';
        renderRecipients(t.dataset.rinput);
      }
      if (t.dataset && t.dataset.rinput) setTimeout(closeSuggest, 120);
    },
    true
  );

  listen(keyTarget, 'keydown', (e) => {
    if (document.querySelector('.scrim') || closing || closed) return;
    const t = e.target;
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.key === 'Enter') {
      e.preventDefault();
      return send();
    }
    if (ctrl && e.key.toLowerCase() === 's') {
      e.preventDefault();
      return saveDraft({ auto: false });
    }
    if (ctrl && e.key.toLowerCase() === 'k' && editor.contains(t)) {
      e.preventDefault();
      return insertLink();
    }
    if (e.key === 'Escape') {
      if (suggest) return closeSuggest();
      if (document.querySelector('.menu')) return;
      e.preventDefault();
      e.stopPropagation();
      return close();
    }
    if (t.dataset && t.dataset.rinput) {
      if (suggest && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        e.preventDefault();
        const buttons = [...suggest.querySelectorAll('button')];
        const i = buttons.findIndex((b) => b.classList.contains('active'));
        const next = (i + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
        buttons.forEach((b, j) => b.classList.toggle('active', j === next));
        return;
      }
      if (e.key === 'Enter' || (e.key === 'Tab' && t.value.trim())) {
        if (suggest) {
          e.preventDefault();
          const i = [...suggest.querySelectorAll('button')].findIndex((b) => b.classList.contains('active'));
          return pick(suggest.hits[Math.max(0, i)], t);
        }
        if (t.value.trim()) {
          e.preventDefault();
          commit(t.dataset.rinput, t.value);
          t.value = '';
          renderRecipients(t.dataset.rinput).focus();
        }
        return;
      }
      if (e.key === 'Backspace' && !t.value && st[t.dataset.rinput].length) {
        st[t.dataset.rinput].pop();
        changed();
        renderRecipients(t.dataset.rinput).focus();
      }
    }
  });
  page.addEventListener('mousedown', (e) => {
    // Keep the editor selection when clicking formatting buttons.
    if (e.target.closest('.format-row button, .float-bar button')) e.preventDefault();
  });

  const restoreRange = (range) => {
    editor.focus();
    if (!range) return;
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  };
  const editorRange = () => {
    const sel = window.getSelection();
    return sel.rangeCount && editor.contains(sel.anchorNode) ? sel.getRangeAt(0).cloneRange() : null;
  };

  async function insertLink() {
    const range = editorRange();
    const selected = range ? range.toString() : '';
    const url = await dialog({
      title: 'Link invoegen',
      buttons: [
        { label: 'Annuleren', value: null },
        { label: 'Invoegen', value: (scrim) => scrim.querySelector('input').value.trim(), primary: true }
      ],
      render(body) {
        body.innerHTML = `<div class="form" style="padding:0"><label>Adres<input class="form-input" type="text" placeholder="https://" value="${/^https?:\/\//.test(selected) ? esc(selected) : ''}"/></label></div>`;
      }
    });
    if (!url) return restoreRange(range);
    const href = /^(https?:|mailto:)/i.test(url) ? url : `https://${url}`;
    restoreRange(range);
    if (range && !range.collapsed) document.execCommand('createLink', false, href);
    else document.execCommand('insertHTML', false, `<a href="${esc(href)}">${esc(url)}</a>`);
    changed();
  }

  // ----- formatting -----

  const formatRow = $('.format-row', page);
  const formatToggle = $('[data-c="format"]', page);
  const showFormatRow = (on) => {
    formatRow.hidden = !on;
    formatToggle.classList.toggle('on', on);
    formatToggle.setAttribute('aria-pressed', String(on));
    localStorage.setItem('rukoo.formatRow', on ? '1' : '');
  };
  showFormatRow(localStorage.getItem('rukoo.formatRow') === '1');

  // A small toolbar above selected text, as in most current mail apps.
  const floatBar = $('.float-bar', page);
  const placeFloatBar = () => {
    const sel = window.getSelection();
    const range = sel.rangeCount ? sel.getRangeAt(0) : null;
    if (!range || range.collapsed || !editor.contains(range.commonAncestorContainer) || closing || closed) {
      floatBar.hidden = true;
      return;
    }
    const r = range.getBoundingClientRect();
    const box = page.getBoundingClientRect();
    floatBar.hidden = false;
    const w = floatBar.offsetWidth;
    const left = Math.max(8, Math.min(r.left - box.left + r.width / 2 - w / 2, box.width - w - 8));
    const top = r.top - box.top - floatBar.offsetHeight - 8;
    floatBar.style.left = `${left}px`;
    floatBar.style.top = `${top < 4 ? r.bottom - box.top + 8 : top}px`;
  };

  const updateToolbar = () => {
    for (const cmd of ['bold', 'italic', 'underline', 'insertOrderedList', 'insertUnorderedList']) {
      const on = document.queryCommandState(cmd);
      page.querySelectorAll(`[data-cmd="${cmd}"]`).forEach((btn) => {
        btn.classList.toggle('on', on);
        btn.setAttribute('aria-pressed', String(on));
      });
    }
  };
  listen(document, 'selectionchange', () => {
    if (editor.contains(document.activeElement) || document.activeElement === editor) updateToolbar();
    placeFloatBar();
  });
  $('.composer-scroll', page).addEventListener('scroll', () => (floatBar.hidden = true));

  // ----- clicks -----

  page.addEventListener('click', async (e) => {
    const field = e.target.closest('.field[data-rfield]');
    if (field && !e.target.closest('button') && !e.target.closest('.suggest')) field.querySelector('input')?.focus();
    if (e.target.closest('.compose-body') && !e.target.closest('.editor, .quote-zone, button') && e.target === $('.compose-body', page)) editor.focus();
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.remove !== undefined) {
      const f = b.closest('[data-rfield]').dataset.rfield;
      st[f].splice(Number(b.dataset.remove), 1);
      changed();
      return renderRecipients(f).focus();
    }
    if (b.dataset.unattach !== undefined) {
      st.attachments.splice(Number(b.dataset.unattach), 1);
      changed();
      return renderAttachments();
    }
    if (b.dataset.cmd) {
      editor.focus();
      document.execCommand(b.dataset.cmd, false, null);
      changed();
      updateToolbar();
      return placeFloatBar();
    }
    if (b.dataset.color) {
      const input = $('.color-input', page);
      const range = editorRange();
      input.onchange = () => {
        restoreRange(range);
        document.execCommand(b.dataset.color, false, input.value);
        changed();
      };
      input.click();
      return;
    }
    switch (b.dataset.c) {
      case 'send':
        return send();
      case 'attach':
        return attachFiles();
      case 'link':
        return insertLink();
      case 'format':
        return showFormatRow(formatRow.hidden);
      case 'image': {
        const range = editorRange();
        const url = await api('pickImage');
        if (!url) return;
        restoreRange(range);
        document.execCommand('insertImage', false, url);
        changed();
        return;
      }
      case 'cc':
      case 'bcc': {
        const key = b.dataset.c;
        st[key === 'cc' ? 'showCc' : 'showBcc'] = true;
        $(`[data-rfield="${key}"]`, page).hidden = false;
        b.hidden = true;
        return $(`[data-rinput="${key}"]`, page).focus();
      }
      case 'quote': {
        st.quoteOpen = !st.quoteOpen;
        $('.quote', page).hidden = !st.quoteOpen;
        b.setAttribute('aria-expanded', String(st.quoteOpen));
        b.title = st.quoteOpen ? 'Vorige berichten verbergen' : 'Vorige berichten tonen';
        if (st.quoteOpen && !quoteDrawn) drawQuote();
        return;
      }
      case 'include':
        st.include = !st.include;
        b.textContent = st.include ? 'Niet meesturen' : 'Toch meesturen';
        $('.quote', page).classList.toggle('excluded', !st.include);
        $('.quote-pill', page).classList.toggle('excluded', !st.include);
        $('.quote-pill', page).textContent = st.include ? '···' : '··· niet meegestuurd';
        changed();
        return;
      case 'discard':
        return discard();
      case 'close':
        return close();
      case 'popout':
        return popOut();
      case 'more':
        return showMenu(b, [
          { icon: 'saved', label: 'Opslaan in Concepten', shortcut: 'Ctrl+S', action: () => saveDraft({ auto: false }) },
          st.showCc ? null : { icon: 'plus', label: 'Cc toevoegen', action: () => $('[data-c="cc"]', page).click() },
          st.showBcc ? null : { icon: 'plus', label: 'Bcc toevoegen', action: () => $('[data-c="bcc"]', page).click() },
          inline ? { icon: 'popOut', label: 'Openen in een eigen venster', action: popOut } : null,
          { separator: true },
          { icon: 'trash', label: 'Concept verwijderen', action: discard, danger: true }
        ], { above: true });
    }
  });

  async function attachFiles() {
    const files = await api('pickFiles');
    if (files.length) {
      st.attachments.push(...files.map(keyed));
      changed();
      renderAttachments();
    }
  }

  // Files dropped on the editor become attachments.
  const dropTarget = inline ? page : document;
  listen(dropTarget, 'dragover', (e) => {
    if ([...e.dataTransfer.types].includes('Files')) {
      e.preventDefault();
      page.classList.add('drop-files');
    }
  });
  listen(dropTarget, 'dragleave', (e) => {
    if (!e.relatedTarget || !page.contains(e.relatedTarget)) page.classList.remove('drop-files');
  });
  listen(dropTarget, 'drop', (e) => {
    page.classList.remove('drop-files');
    const files = [...(e.dataTransfer.files || [])];
    if (!files.length) return;
    e.preventDefault();
    for (const f of files) {
      const p = window.mail.pathForFile(f);
      if (p) st.attachments.push(keyed({ path: p, filename: f.name, size: f.size }));
    }
    changed();
    renderAttachments();
  });

  // ----- saving, sending, closing -----

  function payload(attachmentList = st.attachments) {
    let html = editor.innerHTML;
    if ((st.original || st.quoted) && st.include) {
      const head = esc(st.original ? quoteHeader(st.original) : st.quoted.head).replace(/\n/g, '<br>');
      const quoted = st.original ? st.original.html || '' : st.quoted.html;
      html += `<br><div style="font-size:13px;color:#555">${head}</div><br><blockquote style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">${quoted}</blockquote>`;
    }
    const attachments = attachmentList.filter((a) => a.path).map((a) => ({ path: a.path, filename: a.filename }));
    const forwardIndexes = attachmentList.filter((a) => a.forwardIndex !== undefined).map((a) => a.forwardIndex);
    return {
      accountId: st.accountId,
      from: st.from,
      to: st.to,
      cc: st.cc,
      bcc: st.bcc,
      subject: st.subject,
      html: `<div style="font-family:'Segoe UI',Arial,sans-serif;font-size:12pt">${html}</div>`,
      attachments,
      forwardId: forwardIndexes.length ? st.forwardId : null,
      forwardIndexes,
      inReplyTo: st.inReplyTo,
      references: st.references,
      draftId: st.draftId,
      replyToId: st.replyToId
    };
  }

  function flushInputs() {
    page.querySelectorAll('[data-rinput]').forEach((input) => {
      if (input.value.trim()) {
        commit(input.dataset.rinput, input.value);
        input.value = '';
        renderRecipients(input.dataset.rinput);
      }
    });
  }

  // A save replaces the stored draft, and with it the source of the attachments copied from it.
  // The new draft holds what the save sent: files from disk first, then copied ones. Point those
  // entries at the new draft; attachments added or removed during the save stay as they are.
  function remapAttachments(sent, saved) {
    const order = [...sent.filter((a) => a.path), ...sent.filter((a) => a.forwardIndex !== undefined)];
    const stored = [...(saved.attachments || [])].sort((a, b) => a.index - b.index);
    const pairs = new Map();
    if (stored.length === order.length) {
      order.forEach((a, i) => pairs.set(a.key, stored[i]));
    } else {
      const free = [...stored];
      for (const a of order) {
        const i = free.findIndex((x) => x.filename === a.filename);
        if (i < 0) return false;
        pairs.set(a.key, free.splice(i, 1)[0]);
      }
    }
    st.attachments = st.attachments.map((a) =>
      pairs.has(a.key) ? { key: a.key, forwardIndex: pairs.get(a.key).index, filename: pairs.get(a.key).filename, size: pairs.get(a.key).size } : a
    );
    return true;
  }

  // Set after a save whose attachments could not be read back yet; settled before the next save or send.
  let pendingRemap = null;
  async function settleAttachments() {
    if (!pendingRemap) return;
    const { id, sent } = pendingRemap;
    const lost = new Error('Het concept staat in Concepten, maar de bijlagen ervan zijn niet terug te vinden. Sluit dit venster en open het concept opnieuw.');
    if (!id) throw lost;
    const saved = await api('get', id);
    if (!remapAttachments(sent, saved)) throw lost;
    st.forwardId = id;
    pendingRemap = null;
    renderAttachments();
  }

  // Saves run one at a time; a save requested during another runs after it.
  let saving = Promise.resolve(true);
  function saveDraft({ auto }) {
    clearTimeout(autosaveTimer);
    saving = saving.then(async () => {
      if (sending || closed) return false;
      if (auto && !st.dirty) return true;
      flushInputs();
      st.saving = true;
      describeSaved();
      const editsBefore = editCount;
      let failed = false;
      try {
        await settleAttachments();
        const sent = st.attachments.slice();
        const id = await api('saveDraft', payload(sent));
        st.draftId = id;
        st.savedAt = Date.now();
        if (editCount === editsBefore) st.dirty = false;
        if (id && !inline) await api('composeDraft', id);
        // Without an id the next save cannot replace this one; stop autosaving rather than pile up drafts.
        if (!id) autosave = false;
        if (sent.length) {
          pendingRemap = { id, sent };
          await settleAttachments().catch(() => {});
        }
        if (!auto) toast('Opgeslagen in Concepten');
        return true;
      } catch (err) {
        failed = true;
        if (!auto) toast(err.message, 5000);
        return false;
      } finally {
        st.saving = false;
        if (failed && auto) showSaveState('Automatisch opslaan mislukt');
        else describeSaved();
      }
    });
    return saving;
  }

  let closed = false;
  let closing = false;
  function finish(message) {
    closed = true;
    clearTimeout(autosaveTimer);
    cleanups.forEach((fn) => fn());
    if (inline) {
      if (message) toast(message);
      page.remove();
      onDone && onDone();
      return;
    }
    if (message) api('toastMain', message).catch(() => {});
    api('composeClose');
  }

  let sending = false;
  async function send() {
    // Taken before anything is awaited, so a second click cannot send the message twice.
    // Nothing is sent once the editor is saving to close.
    if (sending || closing || closed) return;
    sending = true;
    const btn = page.querySelector('[data-c="send"]');
    const label = btn.querySelector('span');
    btn.disabled = true;
    let done = false;
    try {
      flushInputs();
      if (!st.to.length && !st.cc.length && !st.bcc.length) {
        toast('Voeg minstens één ontvanger toe');
        return $('[data-rinput="to"]', page).focus();
      }
      const bad = [...st.to, ...st.cc, ...st.bcc].find((a) => !EMAIL_RE.test(a.address));
      if (bad) return toast(`Ongeldig e-mailadres: ${bad.address}`);
      if (!st.subject.trim()) {
        const ok = await confirmDialog('Geen onderwerp', 'Wil je deze e-mail zonder onderwerp verzenden?', 'Verzenden');
        if (!ok) return;
      }
      clearTimeout(autosaveTimer);
      label.textContent = 'Verzenden...';
      showSaveState('');
      // Nothing typed from here on would make it into the mail, so lock the editor until it is sent.
      page.inert = true;
      await saving;
      await settleAttachments();
      await api('send', payload());
      done = true;
      finish(inline ? 'E-mail verzonden' : null);
    } catch (err) {
      await dialog({ title: 'Verzenden mislukt', body: `<p>${esc(err.message)}</p>` });
    } finally {
      if (!done) {
        sending = false;
        page.inert = false;
        btn.disabled = false;
        label.textContent = 'Verzenden';
        describeSaved();
        if (st.dirty) armAutosave();
      }
    }
  }

  async function discard() {
    if (sending || closing || closed) return;
    const hasContent = st.dirty || st.draftId;
    if (hasContent) {
      const ok = await confirmDialog('Concept verwijderen?', st.draftId ? 'Dit concept wordt ook uit Concepten verwijderd.' : 'Wat je hebt geschreven gaat verloren.', 'Verwijderen', true);
      if (!ok) return;
    }
    clearTimeout(autosaveTimer);
    closed = true;
    await saving;
    if (st.draftId) await api('discardDraft', st.draftId).catch(() => {});
    finish(st.draftId ? 'Concept verwijderd' : null);
  }

  let asking = false;
  async function close() {
    if (asking || closing || closed || sending) return;
    flushInputs();
    if (!st.dirty) return finish(st.draftId && st.mode !== 'draft' ? 'Concept bewaard in Concepten' : null);
    asking = true;
    const choice = await dialog({
      title: 'Concept opslaan?',
      body: '<p>Bewaar dit bericht in Concepten om later verder te schrijven.</p>',
      buttons: [
        { label: st.draftId ? 'Concept verwijderen' : 'Niet opslaan', value: 'discard', danger: true },
        { label: 'Annuleren', value: null },
        { label: 'Opslaan', value: 'save', primary: true }
      ]
    });
    asking = false;
    if (choice === 'save') return saveAndFinish('Opgeslagen in Concepten');
    if (choice === 'discard') {
      closed = true;
      await saving;
      if (st.draftId) await api('discardDraft', st.draftId).catch(() => {});
      finish(st.draftId ? 'Concept verwijderd' : null);
    }
  }

  // Lock the editor while the last save runs, so nothing typed now is left out of it.
  async function saveAndFinish(message) {
    closing = true;
    page.inert = true;
    const ok = await saveDraft({ auto: false });
    if (ok && !st.dirty) {
      finish(message);
      return true;
    }
    closing = false;
    page.inert = false;
    return false;
  }

  // Moving on to another message: keep what was written as a draft without asking.
  async function leave() {
    if (closed) return true;
    if (sending || closing || asking) return false;
    flushInputs();
    if (!st.dirty) {
      finish(st.draftId && st.mode !== 'draft' ? 'Concept bewaard in Concepten' : null);
      return true;
    }
    return saveAndFinish('Concept opgeslagen in Concepten');
  }

  async function popOut() {
    if (sending || closing || closed) return;
    flushInputs();
    if (st.dirty || st.draftId) {
      if (st.dirty && !(await saveAndFinish(null))) return;
      if (!closed) finish(null);
      if (st.draftId) onPopOut && onPopOut({ mode: 'draft', id: st.draftId });
      return;
    }
    finish(null);
    onPopOut && onPopOut(opts);
  }

  if (!inline) {
    // The window's close button: keep the window open while there are unsaved changes and ask instead.
    listen(window, 'beforeunload', (e) => {
      if (closed) return;
      // While sending or saving before closing, the window closes by itself when that is done.
      if (sending || closing) {
        e.preventDefault();
        e.returnValue = false;
        return;
      }
      if (!st.dirty) {
        if (st.draftId && st.mode !== 'draft') api('toastMain', 'Concept bewaard in Concepten').catch(() => {});
        return;
      }
      e.preventDefault();
      e.returnValue = false;
      setTimeout(close, 0);
    });
  }

  editor.addEventListener('input', changed);
  const focusStart = () => {
    if (st.mode === 'forward' || !st.to.length) return $('[data-rinput="to"]', page).focus();
    editor.focus();
    const range = document.createRange();
    range.setStart(editor.firstChild || editor, 0);
    range.collapse(true);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);
  };
  focusStart();

  return {
    el: page,
    opts,
    get draftId() {
      return st.draftId;
    },
    isDirty: () => st.dirty,
    isBusy: () => sending || closing || asking,
    leave,
    close,
    focus: focusStart,
    retheme(next) {
      if (next) data = next;
      if (quoteDrawn) drawQuote();
    }
  };
}
