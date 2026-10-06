import { icons } from './icons.js';
import { api, esc, $, toast, dialog, confirmDialog, showMenu, person, formatAddress, quoteDate, fileSize } from './ui.js';

let current = null;
let contactsCache = null;

export function composeOpen() {
  return Boolean(current);
}

const FONTS = ['Segoe UI', 'Arial', 'Calibri', 'Georgia', 'Times New Roman', 'Verdana', 'Courier New'];
const SIZES = [10, 11, 12, 14, 16, 18, 20, 24, 28, 36];
const EMAIL_RE = /^[^@\s,;<>]+@[^@\s,;<>]+\.[^@\s,;<>]+$/;

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

// Strip document-level tags so a reopened draft cannot restyle the app.
function cleanDraftHtml(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style\s*>/gi, '')
    .replace(/<\/?(html|head|body|meta|link|title)\b[^>]*>/gi, '');
}

function initialState(ctx, opts) {
  const { S } = ctx;
  const accounts = S.data.accounts;
  const m = opts.message;
  const defaultAcc = accounts.find((a) => a.isDefault) || accounts[0];
  const acc =
    (m && accounts.find((a) => a.id === m.accountId)) ||
    (S.scope !== 'all' && accounts.find((a) => a.id === S.scope)) ||
    defaultAcc;
  const st = {
    mode: opts.mode,
    accountId: acc.id,
    to: opts.to ? [...opts.to] : [],
    cc: [],
    bcc: [],
    showCc: false,
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
    dirty: false
  };
  const signature = acc.signature ?? S.data.settings.signature ?? '';
  const sigHtml = signature ? `<div class="signature">${esc(signature).replace(/\n/g, '<br>')}</div>` : '';
  st.bodyHtml = `<div>${esc(opts.body || '') || '<br>'}</div><div><br></div><div><br></div>${sigHtml}`;

  if (!m) return st;
  const self = acc.email;
  if (opts.mode === 'draft') {
    st.to = m.to || [];
    st.cc = m.cc || [];
    st.bcc = m.bcc || [];
    st.showCc = st.cc.length > 0 || st.bcc.length > 0;
    st.subject = m.subject || '';
    st.bodyHtml = cleanDraftHtml(m.html);
    st.draftId = m.id;
    return st;
  }
  st.original = m;
  if (opts.mode === 'reply' || opts.mode === 'replyAll') {
    const target = (m.replyTo && m.replyTo.length ? m.replyTo : [m.from]).filter(Boolean);
    const fromSelf = sameAddress(m.from && m.from.address, self);
    st.to = fromSelf ? [...(m.to || [])] : target;
    if (opts.mode === 'replyAll') {
      const extra = fromSelf ? [] : (m.to || []).filter((a) => !sameAddress(a.address, self));
      st.to = uniq([...st.to, ...extra]);
      st.cc = uniq((m.cc || []).filter((a) => !sameAddress(a.address, self) && !st.to.some((t) => sameAddress(t.address, a.address))));
      st.showCc = st.cc.length > 0;
    }
    st.subject = prefixed(m.subject, 'Re');
    st.inReplyTo = m.messageId;
    st.references = [...(m.references || []), m.messageId].filter(Boolean);
    st.replyToId = m.id;
  }
  if (opts.mode === 'forward') {
    st.subject = prefixed(m.subject, 'Fwd');
    st.forwardId = m.id;
    st.attachments = (m.attachments || []).map((a) => ({ forwardIndex: a.index, filename: a.filename, size: a.size }));
  }
  return st;
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
        `<span class="recipient ${EMAIL_RE.test(a.address) ? '' : 'invalid'}" title="${esc(a.address)}">${esc(person(a))}<button data-remove="${i}" title="Verwijderen">${icons.close}</button></span>`
    )
    .join('');
}

export async function openCompose(ctx, opts) {
  if (current) {
    toast('Er is al een e-mail geopend in de editor');
    return;
  }
  const st = initialState(ctx, opts);
  const accounts = ctx.S.data.accounts;
  const page = document.createElement('div');
  page.className = 'page compose';
  page.setAttribute('role', 'dialog');
  page.setAttribute('aria-label', 'Opstellen');
  current = { page, st };

  const accountField =
    accounts.length > 1
      ? `<div class="field"><label>Van</label><select data-field="account">${accounts
          .map((a) => `<option value="${esc(a.id)}" ${a.id === st.accountId ? 'selected' : ''}>${esc(a.email)}</option>`)
          .join('')}</select></div>`
      : '';

  page.innerHTML = `
    <div class="page-bar">
      <button class="icon-btn" data-c="close" title="Sluiten">${icons.close}</button>
      <div style="display:flex;gap:6px">
        <button class="icon-btn" data-c="attach" title="Bijvoegen">${icons.clip}</button>
        <button class="icon-btn" data-c="send" title="Verzenden (Ctrl+Enter)">${icons.send}</button>
        <button class="icon-btn" data-c="more" title="Meer opties">${icons.more}</button>
      </div>
    </div>
    <div class="compose-body">
      <div class="compose-fields">
        ${accountField}
        <div class="field" data-rfield="to"><label>Aan</label><div class="recipients"></div>
          <button class="link-btn" data-c="cc" ${st.showCc ? 'hidden' : ''}>Cc/Bcc</button></div>
        <div class="field" data-rfield="cc" ${st.showCc ? '' : 'hidden'}><label>Cc</label><div class="recipients"></div></div>
        <div class="field" data-rfield="bcc" ${st.showCc ? '' : 'hidden'}><label>Bcc</label><div class="recipients"></div></div>
        <div class="field"><label>Onderwerp</label><input data-field="subject" type="text" value="${esc(st.subject)}" placeholder="Onderwerp"/></div>
        <div class="compose-attachments"></div>
      </div>
      <div class="compose-body-inner">
        <div class="editor" contenteditable="true" spellcheck="true" data-placeholder="E-mail opstellen"></div>
        ${
          st.original
            ? `<div class="include-row"><button class="checkbox on" data-c="include" role="checkbox" aria-checked="true">${icons.check}</button><span>Inclusief vorige berichten</span></div>
               <div class="quote"><div class="quote-head">${esc(quoteHeader(st.original))}</div><iframe class="quote-frame" sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox" title="Vorig bericht"></iframe></div>`
            : ''
        }
      </div>
    </div>
    <div class="toolbar" role="toolbar" aria-label="Opmaak">
      <button class="icon-btn" data-cmd="undo" title="Ongedaan maken">${icons.undo}</button>
      <button class="icon-btn" data-cmd="redo" title="Opnieuw">${icons.redo}</button>
      <span class="sep"></span>
      <button class="icon-btn" data-c="image" title="Afbeelding invoegen">${icons.image}</button>
      <select data-tool="font" title="Lettertype">${FONTS.map((f) => `<option ${f === 'Segoe UI' ? 'selected' : ''}>${f}</option>`).join('')}</select>
      <select data-tool="size" title="Tekengrootte">${SIZES.map((s) => `<option ${s === 12 ? 'selected' : ''}>${s}</option>`).join('')}</select>
      <span class="sep"></span>
      <button class="icon-btn" data-cmd="bold" title="Vet (Ctrl+B)">${icons.bold}</button>
      <button class="icon-btn" data-cmd="italic" title="Cursief (Ctrl+I)">${icons.italic}</button>
      <button class="icon-btn" data-cmd="underline" title="Onderstrepen (Ctrl+U)">${icons.underline}</button>
      <button class="icon-btn" data-color="foreColor" title="Tekstkleur">${icons.textColor}</button>
      <button class="icon-btn" data-color="hiliteColor" title="Markeren">${icons.highlight}</button>
      <span class="sep"></span>
      <button class="icon-btn" data-cmd="insertOrderedList" title="Genummerde lijst">${icons.ol}</button>
      <button class="icon-btn" data-cmd="insertUnorderedList" title="Lijst met opsommingstekens">${icons.ul}</button>
      <button class="icon-btn" data-cmd="indent" title="Inspringing vergroten">${icons.indent}</button>
      <button class="icon-btn" data-cmd="outdent" title="Inspringing verkleinen">${icons.outdent}</button>
      <input type="color" class="color-input" value="#e53935"/>
    </div>`;
  document.getElementById('overlays').appendChild(page);

  const editor = $('.editor', page);
  editor.innerHTML = st.bodyHtml;
  document.execCommand('styleWithCSS', false, true);

  const quoteFrame = $('.quote-frame', page);
  if (quoteFrame) ctx.fillFrame(quoteFrame, st.original, { forQuote: true });

  const renderRecipients = (field) => {
    const box = $(`[data-rfield="${field}"] .recipients`, page);
    const draft = box.querySelector('input')?.value || '';
    box.innerHTML = `${recipientsHtml(st[field])}<input type="text" data-rinput="${field}" autocomplete="off" spellcheck="false" ${field === 'to' ? 'placeholder=""' : ''}/>`;
    const input = box.querySelector('input');
    input.value = draft;
    return input;
  };
  ['to', 'cc', 'bcc'].forEach(renderRecipients);

  const renderAttachments = () => {
    $('.compose-attachments', page).innerHTML = st.attachments
      .map(
        (a, i) =>
          `<span class="recipient" title="${esc(a.path || a.filename)}">${icons.clip.replace('width="24" height="24"', 'width="16" height="16"')} ${esc(a.filename)}${a.size ? ` <span style="color:var(--text-3)">${fileSize(a.size)}</span>` : ''}<button data-unattach="${i}" title="Verwijderen">${icons.close}</button></span>`
      )
      .join('');
  };
  renderAttachments();

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
    if (parts.length) st.dirty = true;
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
    suggest.innerHTML = hits
      .map((c, i) => `<button data-i="${i}" class="${i === 0 ? 'active' : ''}"><div>${esc(c.name || c.address)}</div><div class="addr">${esc(c.address)}</div></button>`)
      .join('');
    suggest.hits = hits;
    suggest.input = input;
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
    st.dirty = true;
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
    if (t.dataset.field === 'subject') st.subject = t.value;
    st.dirty = true;
  });
  page.addEventListener('change', (e) => {
    const t = e.target;
    if (t.dataset.field === 'account') {
      st.accountId = t.value;
      st.dirty = true;
    }
    if (t.dataset.tool === 'font') {
      editor.focus();
      document.execCommand('fontName', false, t.value);
    }
    if (t.dataset.tool === 'size') {
      editor.focus();
      setFontSize(editor, Number(t.value));
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
  page.addEventListener('keydown', (e) => {
    const t = e.target;
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      return send();
    }
    if (e.key === 'Escape') {
      if (suggest) return closeSuggest();
      e.preventDefault();
      return close();
    }
    if (t.dataset.rinput) {
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
        renderRecipients(t.dataset.rinput).focus();
      }
    }
  });
  page.addEventListener('mousedown', (e) => {
    // Keep the editor selection when clicking toolbar buttons.
    if (e.target.closest('.toolbar button')) e.preventDefault();
  });
  page.addEventListener('click', async (e) => {
    const field = e.target.closest('.field[data-rfield]');
    if (field && !e.target.closest('button') && !e.target.closest('.suggest')) field.querySelector('input')?.focus();
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.remove !== undefined) {
      const f = b.closest('[data-rfield]').dataset.rfield;
      st[f].splice(Number(b.dataset.remove), 1);
      st.dirty = true;
      return renderRecipients(f);
    }
    if (b.dataset.unattach !== undefined) {
      st.attachments.splice(Number(b.dataset.unattach), 1);
      st.dirty = true;
      return renderAttachments();
    }
    if (b.dataset.cmd) {
      editor.focus();
      document.execCommand(b.dataset.cmd, false, null);
      st.dirty = true;
      return updateToolbar();
    }
    if (b.dataset.color) {
      const input = $('.color-input', page);
      const sel = window.getSelection();
      const range = sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
      input.onchange = () => {
        editor.focus();
        if (range) {
          sel.removeAllRanges();
          sel.addRange(range);
        }
        document.execCommand(b.dataset.color, false, input.value);
        st.dirty = true;
      };
      input.click();
      return;
    }
    switch (b.dataset.c) {
      case 'close':
        return close();
      case 'send':
        return send();
      case 'attach': {
        const files = await api('pickFiles');
        if (files.length) {
          st.attachments.push(...files);
          st.dirty = true;
          renderAttachments();
        }
        return;
      }
      case 'image': {
        const sel = window.getSelection();
        const range = sel.rangeCount && editor.contains(sel.anchorNode) ? sel.getRangeAt(0).cloneRange() : null;
        const url = await api('pickImage');
        if (!url) return;
        editor.focus();
        if (range) {
          sel.removeAllRanges();
          sel.addRange(range);
        }
        document.execCommand('insertImage', false, url);
        st.dirty = true;
        return;
      }
      case 'cc':
        st.showCc = true;
        page.querySelectorAll('[data-rfield="cc"],[data-rfield="bcc"]').forEach((f) => (f.hidden = false));
        b.hidden = true;
        return $('[data-rinput="cc"]', page).focus();
      case 'include':
        st.include = !st.include;
        b.classList.toggle('on', st.include);
        b.setAttribute('aria-checked', st.include);
        b.innerHTML = st.include ? icons.check : '';
        $('.quote', page).style.opacity = st.include ? '1' : '0.35';
        st.dirty = true;
        return;
      case 'more':
        return showMenu(b, [
          { label: 'Opslaan in Concepten', action: () => saveDraft(true) },
          st.showCc ? null : { label: 'Cc/Bcc weergeven', action: () => page.querySelector('[data-c="cc"]').click() },
          { label: 'Verwijderen', action: discard, danger: true }
        ]);
    }
  });

  // Files dropped anywhere on the page become attachments.
  page.addEventListener('dragover', (e) => {
    if ([...e.dataTransfer.types].includes('Files')) e.preventDefault();
  });
  page.addEventListener('drop', (e) => {
    const files = [...(e.dataTransfer.files || [])];
    if (!files.length) return;
    e.preventDefault();
    for (const f of files) {
      const p = window.mail.pathForFile(f);
      if (p) st.attachments.push({ path: p, filename: f.name, size: f.size });
    }
    st.dirty = true;
    renderAttachments();
  });

  const updateToolbar = () => {
    for (const cmd of ['bold', 'italic', 'underline', 'insertOrderedList', 'insertUnorderedList']) {
      const btn = page.querySelector(`[data-cmd="${cmd}"]`);
      if (btn) btn.classList.toggle('on', document.queryCommandState(cmd));
    }
  };
  const onSelection = () => {
    if (document.activeElement === editor) updateToolbar();
  };
  document.addEventListener('selectionchange', onSelection);

  function payload() {
    let html = editor.innerHTML;
    if (st.original && st.include) {
      const head = esc(quoteHeader(st.original)).replace(/\n/g, '<br>');
      html += `<br><div style="font-size:13px;color:#555">${head}</div><br><blockquote style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">${st.original.html || ''}</blockquote>`;
    }
    const attachments = st.attachments.filter((a) => a.path).map((a) => ({ path: a.path, filename: a.filename }));
    const forwardIndexes = st.attachments.filter((a) => a.forwardIndex !== undefined).map((a) => a.forwardIndex);
    return {
      accountId: st.accountId,
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

  function teardown() {
    document.removeEventListener('selectionchange', onSelection);
    page.remove();
    current = null;
  }

  let sending = false;
  async function send() {
    if (sending) return;
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
    sending = true;
    const btn = page.querySelector('[data-c="send"]');
    btn.disabled = true;
    toast('Verzenden...', 20000);
    try {
      await api('send', payload());
      teardown();
      toast('E-mail verzonden');
    } catch (err) {
      toast('Verzenden mislukt', 1500);
      await dialog({ title: 'Verzenden mislukt', body: `<p>${esc(err.message)}</p>` });
    } finally {
      sending = false;
      btn.disabled = false;
    }
  }

  async function saveDraft(closeAfter) {
    flushInputs();
    try {
      const id = await api('saveDraft', payload());
      st.draftId = id;
      st.dirty = false;
      toast('Opgeslagen in Concepten');
      if (closeAfter) teardown();
      return true;
    } catch (err) {
      toast(err.message, 5000);
      return false;
    }
  }

  async function discard() {
    if (st.draftId) await api('discardDraft', st.draftId).catch(() => {});
    teardown();
    toast('Verwijderd');
  }

  async function close() {
    flushInputs();
    if (!st.dirty) return teardown();
    const choice = await dialog({
      title: 'Wijzigingen opslaan?',
      body: '<p>Je kunt deze e-mail opslaan in Concepten en later verder schrijven.</p>',
      buttons: [
        { label: 'Verwijderen', value: 'discard', danger: true },
        { label: 'Annuleren', value: null },
        { label: 'Opslaan', value: 'save' }
      ]
    });
    if (choice === 'save') await saveDraft(true);
    if (choice === 'discard') {
      if (st.draftId && opts.mode !== 'draft') await api('discardDraft', st.draftId).catch(() => {});
      teardown();
    }
  }

  editor.addEventListener('input', () => (st.dirty = true));
  if (st.to.length) {
    editor.focus();
    const range = document.createRange();
    range.setStart(editor.firstChild || editor, 0);
    range.collapse(true);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);
  } else {
    $('[data-rinput="to"]', page).focus();
  }
}

// execCommand only knows sizes 1-7; map to px by tagging and rewriting the font elements.
function setFontSize(editor, px) {
  document.execCommand('styleWithCSS', false, false);
  document.execCommand('fontSize', false, '7');
  editor.querySelectorAll('font[size="7"]').forEach((f) => {
    const span = document.createElement('span');
    span.style.fontSize = `${px}pt`;
    span.innerHTML = f.innerHTML;
    f.replaceWith(span);
  });
  document.execCommand('styleWithCSS', false, true);
}
