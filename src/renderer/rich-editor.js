// Formatting, selection and link editing shared by mail and meeting notes.
import { t } from './i18n.js';
import { icons } from './icons.js';
import { esc, dialog } from './ui.js';

// Shared with the signature editor in Settings (signature.js).
export const formatButtons = () => `
  <button class="icon-btn sm" data-cmd="bold" data-i18n-title="composer.format.bold" title="${esc(t('composer.format.bold'))}">${icons.bold}</button>
  <button class="icon-btn sm" data-cmd="italic" data-i18n-title="composer.format.italic" title="${esc(t('composer.format.italic'))}">${icons.italic}</button>
  <button class="icon-btn sm" data-cmd="underline" data-i18n-title="composer.format.underline" title="${esc(t('composer.format.underline'))}">${icons.underline}</button>
  <span class="sep"></span>
  <button class="icon-btn sm" data-c="link" data-i18n-title="composer.format.link" title="${esc(t('composer.format.link'))}">${icons.link}</button>
  <button class="icon-btn sm" data-cmd="insertUnorderedList" data-i18n-title="composer.format.bullets" title="${esc(t('composer.format.bullets'))}">${icons.ul}</button>
  <button class="icon-btn sm" data-cmd="insertOrderedList" data-i18n-title="composer.format.numbered" title="${esc(t('composer.format.numbered'))}">${icons.ol}</button>`;

export function mountRichEditor(page, editor, { onChange = () => {}, onSelection = () => {}, cssFormatting = true } = {}) {
  const cleanups = [];
  const listen = (el, type, fn) => {
    el.addEventListener(type, fn);
    cleanups.push(() => el.removeEventListener(type, fn));
  };
  // Chromium keeps this flag per document. Switching between mail and notes must restore
  // the editor's own representation: styled spans for email, semantic tags for Markdown.
  listen(editor, 'focus', () => document.execCommand('styleWithCSS', false, cssFormatting));
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
      title: t('composer.link.title'),
      buttons: [
        { get label() { return t('common.actions.cancel'); }, value: null },
        { get label() { return t('composer.link.insert'); }, value: (scrim) => scrim.querySelector('input').value.trim(), primary: true }
      ],
      render(body) {
        body.innerHTML = `<div class="form" style="padding:0"><label data-i18n="composer.link.address">${esc(t('composer.link.address'))}<input class="form-input" type="text" placeholder="https://" value="${/^https?:\/\//.test(selected) ? esc(selected) : ''}"/></label></div>`;
      }
    });
    if (!url) return restoreRange(range);
    const href = /^(https?:|mailto:)/i.test(url) ? url : `https://${url}`;
    restoreRange(range);
    if (range && !range.collapsed) document.execCommand('createLink', false, href);
    else document.execCommand('insertHTML', false, `<a href="${esc(href)}">${esc(url)}</a>`);
    onChange();
  }
  const updateToolbar = () => {
    for (const cmd of ['bold', 'italic', 'underline', 'insertOrderedList', 'insertUnorderedList']) {
      const on = document.queryCommandState(cmd);
      page.querySelectorAll(`[data-cmd="${cmd}"]`).forEach((btn) => {
        btn.classList.toggle('on', on);
        btn.setAttribute('aria-pressed', String(on));
      });
    }
  };

  listen(page, 'mousedown', (e) => {
    if (e.target.closest('[data-cmd], [data-c="link"]') && !editor.contains(e.target)) e.preventDefault();
  });
  listen(page, 'click', (e) => {
    const b = e.target.closest('button');
    if (!b || editor.contains(b)) return;
    if (b.dataset.cmd) {
      editor.focus();
      document.execCommand(b.dataset.cmd, false, b.dataset.value || null);
      onChange();
      updateToolbar();
      onSelection();
    } else if (b.dataset.c === 'link') insertLink();
  });
  listen(editor, 'keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      e.stopPropagation();
      insertLink();
    }
  });
  listen(editor, 'input', onChange);
  listen(document, 'selectionchange', () => {
    if (editor.contains(document.activeElement)) updateToolbar();
  });
  return { editorRange, restoreRange, insertLink, updateToolbar, dispose: () => cleanups.forEach((fn) => fn()) };
}
