// The compose window: one per message being written. It talks to the main process directly;
// the main window hears about sent mail and saved drafts through the engine.
import { icons } from './icons.js';
import { api, esc, $, toast, dialog, confirmDialog, showMenu, person, formatAddress, quoteDate, fileSize, hhmm, applyTheme, onSystemThemeChange, isLight } from './ui.js';
import { fillFrame } from './mailframe.js';

const FONTS = ['Segoe UI', 'Arial', 'Calibri', 'Georgia', 'Times New Roman', 'Verdana', 'Courier New'];
const SIZES = [10, 11, 12, 14, 16, 18, 20, 24, 28, 36];
const EMAIL_RE = /^[^@\s,;<>]+@[^@\s,;<>]+\.[^@\s,;<>]+$/;
// Autosave this long after the last change.
const AUTOSAVE_MS = 8000;
const TITLES = { new: 'Nieuw bericht', reply: 'Beantwoorden', replyAll: 'Allen beantwoorden', forward: 'Doorsturen', draft: 'Concept' };

let data = null;
let st = null;
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

function initialState(opts, m) {
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
    original: null,
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
  s.bodyHtml = `<div>${esc(opts.body || '').replace(/\n/g, '<br>') || '<br>'}</div><div><br></div>${sigHtml}`;

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
    s.bodyHtml = cleanDraftHtml(m.html);
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

function render(page) {
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
  const fromField =
    identityCount > 1
      ? `<div class="field"><label for="from">Van</label><select id="from" data-field="account">${
          accounts.length > 1 ? accounts.map((a) => `<optgroup label="${esc(a.email)}">${fromOptions(a)}</optgroup>`).join('') : fromOptions(accounts[0])
        }</select></div>`
      : '';

  page.innerHTML = `
    <div class="compose-actions" role="toolbar" aria-label="Bericht">
      <button class="btn primary" data-c="send" title="Verzenden (Ctrl+Enter)">${icons.send}<span>Verzenden</span></button>
      <button class="tbtn" data-c="attach" title="Bestanden bijvoegen">${icons.clip}<span>Bijvoegen</span></button>
      <span class="spacer"></span>
      <span class="save-state" aria-live="polite"></span>
      <button class="icon-btn" data-c="discard" title="Concept verwijderen">${icons.trash}</button>
      <button class="icon-btn" data-c="more" title="Meer opties" aria-haspopup="menu">${icons.more}</button>
    </div>
    <div class="compose-fields">
      ${fromField}
      <div class="field" data-rfield="to"><label>Aan</label><div class="recipients"></div>
        <span class="cc-links"><button class="link-btn" data-c="cc" ${st.showCc ? 'hidden' : ''}>Cc</button><button class="link-btn" data-c="bcc" ${st.showBcc ? 'hidden' : ''}>Bcc</button></span></div>
      <div class="field" data-rfield="cc" ${st.showCc ? '' : 'hidden'}><label>Cc</label><div class="recipients"></div></div>
      <div class="field" data-rfield="bcc" ${st.showBcc ? '' : 'hidden'}><label>Bcc</label><div class="recipients"></div></div>
      <div class="field"><label for="subject">Onderwerp</label><input id="subject" data-field="subject" type="text" value="${esc(st.subject)}" autocomplete="off"/></div>
      <div class="compose-attachments" aria-label="Bijlagen"></div>
    </div>
    <div class="toolbar" role="toolbar" aria-label="Opmaak">
      <button class="icon-btn" data-cmd="undo" title="Ongedaan maken (Ctrl+Z)">${icons.undo}</button>
      <button class="icon-btn" data-cmd="redo" title="Opnieuw (Ctrl+Y)">${icons.redo}</button>
      <span class="sep"></span>
      <select data-tool="font" title="Lettertype" aria-label="Lettertype">${FONTS.map((f) => `<option ${f === 'Segoe UI' ? 'selected' : ''}>${f}</option>`).join('')}</select>
      <select data-tool="size" title="Tekengrootte" aria-label="Tekengrootte">${SIZES.map((s) => `<option ${s === 12 ? 'selected' : ''}>${s}</option>`).join('')}</select>
      <span class="sep"></span>
      <button class="icon-btn" data-cmd="bold" title="Vet (Ctrl+B)">${icons.bold}</button>
      <button class="icon-btn" data-cmd="italic" title="Cursief (Ctrl+I)">${icons.italic}</button>
      <button class="icon-btn" data-cmd="underline" title="Onderstrepen (Ctrl+U)">${icons.underline}</button>
      <button class="icon-btn" data-color="foreColor" title="Tekstkleur">${icons.textColor}</button>
      <button class="icon-btn" data-color="hiliteColor" title="Markeren">${icons.highlight}</button>
      <span class="sep"></span>
      <button class="icon-btn" data-cmd="insertUnorderedList" title="Opsomming">${icons.ul}</button>
      <button class="icon-btn" data-cmd="insertOrderedList" title="Genummerde lijst">${icons.ol}</button>
      <button class="icon-btn" data-cmd="outdent" title="Inspringing verkleinen">${icons.outdent}</button>
      <button class="icon-btn" data-cmd="indent" title="Inspringing vergroten">${icons.indent}</button>
      <span class="sep"></span>
      <button class="icon-btn" data-c="link" title="Link invoegen (Ctrl+K)">${icons.link}</button>
      <button class="icon-btn" data-c="image" title="Afbeelding invoegen">${icons.image}</button>
      <button class="icon-btn" data-cmd="removeFormat" title="Opmaak wissen">${icons.clearFormat}</button>
      <input type="color" class="color-input" value="#d6336c" tabindex="-1" aria-hidden="true"/>
    </div>
    <div class="compose-body">
      <div class="compose-body-inner">
        <div class="editor" contenteditable="true" spellcheck="true" role="textbox" aria-multiline="true" aria-label="Berichttekst" data-placeholder="Schrijf je bericht"></div>
        ${
          st.original
            ? `<div class="include-row"><button class="checkbox on" data-c="include" role="checkbox" aria-checked="true">${icons.check}</button><span>Inclusief vorige berichten</span></div>
               <div class="quote"><div class="quote-head">${esc(quoteHeader(st.original))}</div><iframe class="quote-frame" sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox" title="Vorig bericht"></iframe></div>`
            : ''
        }
      </div>
    </div>`;
}

async function init() {
  const page = document.createElement('div');
  page.className = 'compose';
  page.setAttribute('role', 'main');
  document.getElementById('app').appendChild(page);
  const [state, opts] = await Promise.all([api('state'), api('composeInit')]);
  data = state;
  applyTheme(data.settings.theme);
  if (!opts || !data.accounts.length) return api('composeClose');
  let message = null;
  if (opts.id) {
    try {
      message = await api('get', opts.id);
    } catch (err) {
      page.innerHTML = `<div class="compose-error"><p class="error">${esc(err.message)}</p><button class="btn secondary" data-c="close-error">Sluiten</button></div>`;
      page.querySelector('button').addEventListener('click', () => api('composeClose'));
      return;
    }
  }
  st = initialState(opts, message);
  render(page);
  wire(page, opts);
}

function wire(page, opts) {
  const editor = $('.editor', page);
  editor.innerHTML = st.bodyHtml;
  document.execCommand('styleWithCSS', false, true);

  const title = () => {
    const t = st.subject.trim() || TITLES[st.mode] || 'Nieuw bericht';
    document.title = t;
    $('#compose-title').textContent = t;
  };
  title();

  const settings = data.settings;
  const quoteFrame = $('.quote-frame', page);
  const drawQuote = () => quoteFrame && fillFrame(quoteFrame, st.original, { light: isLight(), darkEmails: settings.darkEmails !== false, forQuote: true });
  drawQuote();
  const retheme = async () => {
    data = await api('state');
    applyTheme(data.settings.theme);
    drawQuote();
  };
  window.mail.on(({ type }) => type === 'theme' && retheme());
  onSystemThemeChange(retheme);

  const saveState = $('.save-state', page);
  const showSaveState = (text) => {
    saveState.textContent = text;
  };
  const describeSaved = () => {
    if (st.saving) return showSaveState('Opslaan...');
    if (st.dirty) return showSaveState(st.draftId ? 'Gewijzigd' : 'Niet opgeslagen');
    if (st.savedAt && st.draftId) return showSaveState(`Concept opgeslagen om ${hhmm(st.savedAt)}`);
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
    if (t.dataset.tool === 'font') {
      editor.focus();
      document.execCommand('fontName', false, t.value);
      changed();
    }
    if (t.dataset.tool === 'size') {
      editor.focus();
      setFontSize(editor, Number(t.value));
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

  document.addEventListener('keydown', (e) => {
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
    // Keep the editor selection when clicking toolbar buttons.
    if (e.target.closest('.toolbar button')) e.preventDefault();
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

  page.addEventListener('click', async (e) => {
    const field = e.target.closest('.field[data-rfield]');
    if (field && !e.target.closest('button') && !e.target.closest('.suggest')) field.querySelector('input')?.focus();
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.remove !== undefined) {
      const f = b.closest('[data-rfield]').dataset.rfield;
      st[f].splice(Number(b.dataset.remove), 1);
      changed();
      return renderRecipients(f);
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
      return updateToolbar();
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
      case 'include':
        st.include = !st.include;
        b.classList.toggle('on', st.include);
        b.setAttribute('aria-checked', st.include);
        b.innerHTML = st.include ? icons.check : '';
        $('.quote', page).classList.toggle('excluded', !st.include);
        changed();
        return;
      case 'discard':
        return discard();
      case 'more':
        return showMenu(b, [
          { icon: 'saved', label: 'Opslaan in Concepten', shortcut: 'Ctrl+S', action: () => saveDraft({ auto: false }) },
          st.showCc ? null : { icon: 'plus', label: 'Cc toevoegen', action: () => $('[data-c="cc"]', page).click() },
          st.showBcc ? null : { icon: 'plus', label: 'Bcc toevoegen', action: () => $('[data-c="bcc"]', page).click() },
          { separator: true },
          { icon: 'trash', label: 'Concept verwijderen', action: discard, danger: true }
        ]);
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

  // Files dropped anywhere on the window become attachments.
  document.addEventListener('dragover', (e) => {
    if ([...e.dataTransfer.types].includes('Files')) {
      e.preventDefault();
      document.body.classList.add('drop-files');
    }
  });
  document.addEventListener('dragleave', (e) => {
    if (!e.relatedTarget) document.body.classList.remove('drop-files');
  });
  document.addEventListener('drop', (e) => {
    document.body.classList.remove('drop-files');
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

  const updateToolbar = () => {
    for (const cmd of ['bold', 'italic', 'underline', 'insertOrderedList', 'insertUnorderedList']) {
      const btn = page.querySelector(`[data-cmd="${cmd}"]`);
      if (btn) {
        const on = document.queryCommandState(cmd);
        btn.classList.toggle('on', on);
        btn.setAttribute('aria-pressed', String(on));
      }
    }
  };
  document.addEventListener('selectionchange', () => {
    if (document.activeElement === editor) updateToolbar();
  });

  function payload(attachmentList = st.attachments) {
    let html = editor.innerHTML;
    if (st.original && st.include) {
      const head = esc(quoteHeader(st.original)).replace(/\n/g, '<br>');
      html += `<br><div style="font-size:13px;color:#555">${head}</div><br><blockquote style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">${st.original.html || ''}</blockquote>`;
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
        if (id) await api('composeDraft', id);
        // Without an id the next save cannot replace this one; stop autosaving rather than pile up drafts.
        else autosave = false;
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
  function finish(message) {
    closed = true;
    clearTimeout(autosaveTimer);
    if (message) api('toastMain', message).catch(() => {});
    api('composeClose');
  }

  let sending = false;
  async function send() {
    // Taken before anything is awaited, so a second click cannot send the message twice.
    // Nothing is sent once the window is saving to close.
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
      // Nothing typed from here on would make it into the mail, so lock the window until it is sent.
      page.inert = true;
      await saving;
      await settleAttachments();
      await api('send', payload());
      done = true;
      finish();
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
  let closing = false;
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
    if (choice === 'save') {
      // Lock the window while the last save runs, so nothing typed now is left out of it.
      closing = true;
      page.inert = true;
      const ok = await saveDraft({ auto: false });
      if (ok && !st.dirty) return finish('Opgeslagen in Concepten');
      closing = false;
      page.inert = false;
    }
    if (choice === 'discard') {
      closed = true;
      await saving;
      if (st.draftId) await api('discardDraft', st.draftId).catch(() => {});
      finish(st.draftId ? 'Concept verwijderd' : null);
    }
  }

  // The window's close button: keep the window open while there are unsaved changes and ask instead.
  window.addEventListener('beforeunload', (e) => {
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

  editor.addEventListener('input', changed);
  if (st.to.length || st.mode === 'draft') {
    editor.focus();
    const range = document.createRange();
    range.setStart(editor.firstChild || editor, 0);
    range.collapse(true);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);
  } else {
    $('[data-rinput="to"]', page).focus();
  }
  if (st.mode === 'forward') $('[data-rinput="to"]', page).focus();
}

// execCommand only knows sizes 1-7; map to points by tagging and rewriting the font elements.
function setFontSize(editor, pt) {
  document.execCommand('styleWithCSS', false, false);
  document.execCommand('fontSize', false, '7');
  editor.querySelectorAll('font[size="7"]').forEach((f) => {
    const span = document.createElement('span');
    span.style.fontSize = `${pt}pt`;
    span.innerHTML = f.innerHTML;
    f.replaceWith(span);
  });
  document.execCommand('styleWithCSS', false, true);
}

init().catch((err) => toast(err.message, 6000));
