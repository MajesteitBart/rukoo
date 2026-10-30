import { t } from './i18n.js';
// @-mentions in the composer's text. Typing @ and a name suggests people: those in the thread first, then the address
// book (the addresses in synced mail). Picking one puts "@Name" in the text as a mailto: link, the way Outlook and
// Gmail send mentions, and adds the person to Cc when they aren't on the email yet. Deleting a mention leaves the
// recipients as they are. Both entry points use this through composer.js.
import { api, esc, avatar, toast } from './ui.js';
import { mentionToken, rankPeople, mentionLabel, withoutAddress } from './mention-match.js';

const MENTION = 'a.mention[href^="mailto:" i]';
// Where no mention starts: links (mentions too), quoted mail, the signature and code.
const NO_MENTION = 'a, blockquote, .signature, pre, code, [contenteditable="false"]';
const BLOCK = /^(DIV|P|LI|UL|OL|BLOCKQUOTE|TD|TH|TR|TABLE|H[1-6]|PRE|BR|HR)$/;

// The address book, once per window: the same list the recipient fields suggest from.
let contactsCache = null;

// The address a mention links to, in lower case.
function mentionAddress(a) {
  try {
    return decodeURIComponent(a.getAttribute('href').replace(/^mailto:/i, '').split('?')[0]).trim().toLowerCase();
  } catch (_) {
    return '';
  }
}

// A mention is one piece: the caret steps over it and Backspace takes it off whole. The lock is the editor's own and
// stays out of the mail (outgoingHtml); a reopened draft gets it back here.
export function lockMentions(root) {
  root.querySelectorAll(MENTION).forEach((a) => a.setAttribute('contenteditable', 'false'));
}

// The text as it goes into a draft or the sent mail: the editor's HTML, with the mentions unlocked. sendTo: when
// sending, the addresses in To and Cc. A mention of anyone else (in Bcc, or taken off the email) goes out as plain
// "@Name", without the address in the link or the text, so it doesn't give away an address the recipients can't see.
// Without mentions the HTML is untouched.
export function outgoingHtml(editor, sendTo = null) {
  if (!editor.querySelector('a.mention')) return editor.innerHTML;
  // A copy in a document of its own: exact, and its images don't load again.
  const copy = document.implementation.createHTMLDocument('').importNode(editor, true);
  for (const a of copy.querySelectorAll('a.mention')) {
    a.removeAttribute('contenteditable');
    // The editor keeps the spaces around a mention as no-break spaces; between it and a word an ordinary one looks
    // the same, and the plain-text part and searches read it as a space.
    const prev = a.previousSibling;
    if (prev && prev.nodeType === Node.TEXT_NODE && /\S\u00a0$/.test(prev.data)) prev.data = `${prev.data.slice(0, -1)} `;
    const next = a.nextSibling;
    if (next && next.nodeType === Node.TEXT_NODE && /^\u00a0\S/.test(next.data)) next.data = ` ${next.data.slice(1)}`;
    const address = mentionAddress(a);
    if (sendTo && !sendTo.has(address)) {
      const span = copy.ownerDocument.createElement('span');
      span.className = 'mention';
      span.textContent = withoutAddress(a.textContent, address);
      a.replaceWith(span);
    }
  }
  return copy.innerHTML;
}

// The character before node in its line, for mentionToken(): '' at the start of a line.
function charBefore(node, editor) {
  for (let n = node; n && n !== editor; n = n.parentNode) {
    for (let prev = n.previousSibling; prev; prev = prev.previousSibling) {
      if (prev.nodeType === Node.TEXT_NODE) {
        if (prev.data) return prev.data.slice(-1);
      } else if (prev.nodeType === Node.ELEMENT_NODE) {
        if (BLOCK.test(prev.tagName)) return '';
        if (prev.textContent) return prev.textContent.slice(-1);
      }
    }
    const up = n.parentNode;
    if (!up || up === editor || (up.nodeType === Node.ELEMENT_NODE && BLOCK.test(up.tagName))) return '';
  }
  return '';
}

// editor: the composer's text. st: its state (to, cc, bcc, the message it answers and the thread's Message-IDs).
// getData(): main's state now, for your own addresses. listen(target, type, fn): a listener removed when the composer
// closes; onClose(fn) runs fn then too. addCc(person): adds someone to Cc and shows the field. changed(): the
// composer's edit bookkeeping (dirty, autosave).
export function mountMentions({ editor, st, getData, listen, onClose, addCc, changed }) {
  const listId = `mentions-${crypto.randomUUID()}`;
  // open: { box, list, token, hits, active } while the suggestions show.
  let open = null;
  // The @ that Escape closed the list for; typing on after it doesn't open the list again.
  let dismissed = null;
  let thread = null;
  let seq = 0;
  // The space put in after the last mention, while the caret is right after it: { node, offset }.
  let spaceAfter = null;
  const scroller = editor.closest('.composer-scroll');

  editor.setAttribute('aria-haspopup', 'listbox');
  editor.setAttribute('aria-autocomplete', 'list');
  lockMentions(editor);

  const own = () => (getData().accounts || []).flatMap((a) => (a.identities || []).map((i) => i.address));
  const fieldOf = (address) => ['to', 'cc', 'bcc'].find((f) => st[f].some((a) => String(a.address || '').toLowerCase() === address.toLowerCase())) || null;

  // The Message-IDs of the thread: what the message answered and what this draft answers.
  const threadIds = () => {
    const o = st.original;
    const ids = [...(o ? [...(o.references || []), o.inReplyTo, o.messageId] : []), ...(st.references || []), st.inReplyTo];
    return [...new Set(ids.filter(Boolean))];
  };
  // The thread's people, recipients of this email first, then those on the message it answers, then the rest of the
  // thread as synced, newest first.
  const threadPeople = () => {
    const o = st.original;
    const answered = o ? [o.from, ...(o.replyTo || []), ...(o.to || []), ...(o.cc || [])] : [];
    return [...st.to, ...st.cc, ...st.bcc, ...answered, ...(thread || [])].filter(Boolean);
  };
  const load = async () => {
    if (!contactsCache) contactsCache = await api('contacts').catch(() => []);
    if (!thread) {
      const ids = threadIds();
      // The account the answered message is in, also when From moved to another one.
      const accountId = (st.original && st.original.accountId) || st.accountId;
      thread = ids.length ? await api('threadContacts', accountId, ids).catch(() => []) : [];
    }
  };

  // The mention being typed at the caret: { node, start, end, query }, or null.
  const caretToken = () => {
    const sel = window.getSelection();
    if (!sel.rangeCount || !sel.isCollapsed) return null;
    const node = sel.anchorNode;
    if (!node || node.nodeType !== Node.TEXT_NODE || !editor.contains(node)) return null;
    const blocked = node.parentElement && node.parentElement.closest(NO_MENTION);
    if (blocked && editor.contains(blocked)) return null;
    const tok = mentionToken(node.data.slice(0, sel.anchorOffset), charBefore(node, editor));
    return tok && { node, start: tok.start, end: sel.anchorOffset, query: tok.query };
  };
  const sameAt = (a, b) => Boolean(a && b && a.node === b.node && a.start === b.start);

  function close() {
    seq++;
    if (!open) return;
    open.box.remove();
    open = null;
    editor.removeAttribute('aria-controls');
    editor.removeAttribute('aria-activedescendant');
  }
  onClose(close);

  const optionId = (i) => `${listId}-${i}`;
  const setActive = (i) => {
    if (!open) return;
    open.active = i;
    const list = open.list;
    list.querySelectorAll('[role="option"]').forEach((el, j) => {
      el.classList.toggle('active', j === i);
      el.setAttribute('aria-selected', String(j === i));
      // A list cut short by a low window scrolls the active option into view, and only the list.
      if (j !== i) return;
      if (el.offsetTop < list.scrollTop) list.scrollTop = el.offsetTop;
      else if (el.offsetTop + el.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = el.offsetTop + el.offsetHeight - list.clientHeight;
    });
    editor.setAttribute('aria-activedescendant', optionId(i));
  };

  // Under the @, or above it where the window has more room there; never wider or taller than the window, so a low
  // window or a high zoom gets a list that scrolls.
  const place = () => {
    if (!open) return;
    const { box, token } = open;
    if (!token.node.isConnected) return close();
    const r = document.createRange();
    r.setStart(token.node, token.start);
    r.setEnd(token.node, Math.min(token.start + 1, token.node.length));
    const at = r.getBoundingClientRect();
    // The @ scrolled out of the composer's view.
    const view = scroller ? scroller.getBoundingClientRect() : null;
    if (view && (at.bottom < view.top || at.top > view.bottom)) return close();
    const width = Math.min(320, window.innerWidth - 16);
    box.style.width = `${width}px`;
    box.style.left = `${Math.max(8, Math.min(at.left - 10, window.innerWidth - width - 8))}px`;
    box.style.maxHeight = '';
    const full = box.offsetHeight;
    const below = at.bottom + 6;
    const roomBelow = window.innerHeight - 8 - below;
    const roomAbove = at.top - 6 - 8;
    const down = full <= roomBelow || roomBelow >= roomAbove;
    const height = Math.min(full, Math.max(48, down ? roomBelow : roomAbove));
    box.style.maxHeight = `${height}px`;
    box.style.top = `${Math.max(8, down ? Math.min(below, window.innerHeight - 8 - height) : at.top - 6 - height)}px`;
    if (open.list.children[open.active]) setActive(open.active);
  };

  // Where someone is on the email already, or that picking them adds them to Cc.
  const STATUS = { to: 'composer.mentions.inTo', cc: 'composer.mentions.inCc', bcc: 'composer.mentions.inBcc' };
  const status = (field) => t(field ? STATUS[field] : 'composer.mentions.addsCc');

  function draw(token, hits) {
    const was = open && open.hits[open.active] ? open.hits[open.active].address : null;
    if (!open) {
      const box = document.createElement('div');
      box.className = 'suggest mention-suggest';
      box.innerHTML = `<div class="mention-list" role="listbox" id="${listId}"></div><div class="mention-hint" aria-hidden="true"></div>`;
      const list = box.querySelector('[role="listbox"]');
      // The editor keeps the focus and the caret; a click picks.
      box.addEventListener('mousedown', (e) => e.preventDefault());
      list.addEventListener('click', (e) => {
        const el = e.target.closest('[role="option"]');
        if (el && open) pick(open.hits[Number(el.dataset.i)]);
      });
      list.addEventListener('mousemove', (e) => {
        const el = e.target.closest('[role="option"]');
        if (el && open && Number(el.dataset.i) !== open.active) setActive(Number(el.dataset.i));
      });
      document.body.appendChild(box);
      open = { box, list, token, hits, active: 0 };
      editor.setAttribute('aria-controls', listId);
    }
    open.token = token;
    open.hits = hits;
    open.list.setAttribute('aria-label', t('composer.mentions.label'));
    open.list.innerHTML = hits
      .map((p, i) => {
        const field = fieldOf(p.address);
        const name = p.name || p.address;
        const tag = field ? `<span class="mention-tag" title="${esc(status(field))}">${esc(t(`reader.headers.${field}`))}</span>` : '';
        return `<div role="option" id="${optionId(i)}" data-i="${i}" aria-selected="false" aria-label="${esc(`${name}, ${p.address}, ${status(field)}`)}">${avatar(p, 'mention-avatar')}<span class="mention-who"><span class="mention-name">${esc(name)}</span>${p.name ? `<span class="addr">${esc(p.address)}</span>` : ''}</span>${tag}</div>`;
      })
      .join('');
    // Said once under the list, while picking someone would add them.
    const hint = open.box.querySelector('.mention-hint');
    hint.textContent = t('composer.mentions.hint');
    hint.hidden = hits.every((p) => fieldOf(p.address));
    const keep = was ? hits.findIndex((p) => p.address === was) : -1;
    setActive(keep >= 0 ? keep : 0);
    place();
  }

  async function update() {
    const token = caretToken();
    if (!token) dismissed = null;
    if (!token || sameAt(token, dismissed)) return close();
    dismissed = null;
    const mine = ++seq;
    await load();
    if (mine !== seq) return;
    // The caret may have moved on while the lists loaded.
    const now = caretToken();
    if (!now || !sameAt(now, token)) return close();
    const hits = rankPeople({ query: now.query, thread: threadPeople(), contacts: contactsCache, own: own() });
    if (!hits.length) return close();
    draw(now, hits);
  }

  function pick(person) {
    if (!open || !person) return;
    const token = caretToken();
    close();
    if (!token) return;
    const range = document.createRange();
    range.setStart(token.node, token.start);
    range.setEnd(token.node, token.end);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    const [local, ...domain] = person.address.split('@');
    const href = `mailto:${encodeURIComponent(local)}@${domain.join('@')}`;
    // Through the editing commands, so Ctrl+Z takes the mention back like typing. The space after it keeps the caret
    // outside the link. Locked only once it is in: Chromium puts a locked piece on a line of its own.
    document.execCommand('insertHTML', false, `<a href="${esc(href)}" class="mention">${esc(mentionLabel(person))}</a>&nbsp;`);
    lockMentions(editor);
    const at = window.getSelection();
    spaceAfter = at.anchorNode && at.anchorNode.nodeType === Node.TEXT_NODE ? { node: at.anchorNode, offset: at.anchorOffset } : null;
    if (!fieldOf(person.address)) {
      addCc({ name: person.name || '', address: person.address });
      toast(t('composer.mentions.addedCc', { name: person.name || person.address }));
    }
    changed();
  }

  // A comma, colon or the like typed right after a mention takes the place of the space after it, so "@Bob:" comes
  // out as people write it. Through the editing commands, so Ctrl+Z still works.
  listen(editor, 'beforeinput', (e) => {
    const s = spaceAfter;
    spaceAfter = null;
    if (!s || e.inputType !== 'insertText' || !/^[,.:;!?)]/.test(e.data || '')) return;
    const sel = window.getSelection();
    if (!sel.isCollapsed || sel.anchorNode !== s.node || sel.anchorOffset !== s.offset || s.node.data[s.offset - 1] !== '\u00a0') return;
    e.preventDefault();
    const range = document.createRange();
    range.setStart(s.node, s.offset - 1);
    range.setEnd(s.node, s.offset);
    sel.removeAllRanges();
    sel.addRange(range);
    document.execCommand('insertText', false, e.data);
  });
  listen(editor, 'input', () => {
    update();
  });
  // While the list is open it follows the caret, and closes once the caret leaves the mention.
  listen(document, 'selectionchange', () => {
    if (!open) return;
    const token = caretToken();
    if (!token || !sameAt(token, open.token)) return close();
    if (token.query !== open.token.query) update();
  });
  listen(editor, 'keydown', (e) => {
    if (!open || e.isComposing || ['Control', 'Meta', 'Alt', 'Shift'].includes(e.key)) return;
    // A shortcut such as Ctrl+Enter does what it always does.
    if (e.ctrlKey || e.metaKey || e.altKey) return close();
    const n = open.hits.length;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      setActive((open.active + (e.key === 'ArrowDown' ? 1 : -1) + n) % n);
    } else if (e.key === 'Enter' || (e.key === 'Tab' && !e.shiftKey)) {
      e.preventDefault();
      e.stopPropagation();
      pick(open.hits[open.active]);
    } else if (e.key === 'Escape') {
      // Only the list closes, not the composer.
      e.preventDefault();
      e.stopPropagation();
      dismissed = open.token;
      close();
    }
  });
  listen(editor, 'blur', close);
  listen(editor, 'contextmenu', close);
  listen(window, 'resize', close);
  if (scroller) listen(scroller, 'scroll', place);

  return { close };
}
