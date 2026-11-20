import { t } from './i18n.js';
import { icons } from './icons.js';
import { hue, initials } from './ui.js';
import { h } from './agent/bui.js';
import { toWire, sendProblem, byteLength } from './chat-text.js';
import { mentionToken, rankMembers } from './mention-match.js';
import { draftSlotKey, attachDraft, detachDraft, draftWritten, sendStarted, sendSettled } from './chat-drafts.js';

// Team chat's composer (contract 3.16, 3.17, 5.5; desktop-ui 5.5 and 5.6): a plain-text editable with mentions as
// locked chips, the mention picker, Enter to send, the limits line and drafts. chat-view.js mounts one under the log
// and one in the thread panel, and puts a bar in its place when the conversation can't take messages.
//
// The input holds text nodes and chips (span.ch-chip, contenteditable false) and nothing else: whatever the browser
// adds (a <br> or a <div> from a drop) becomes text again in settle(). A chip is { member, label } in the parts model,
// its label "@" and the member's name when it was picked. Positions count the text as it is sent, a chip as its label.
// The parts model and its caret mapping follow bui.js chatComposer, copied rather than shared: that one carries the
// agent's skills, commands and steering, and its undo and IME handling are tested as they are.
//
// toWire() (chat-text.js) turns the parts into the wire's text and UTF-8 byte ranges when the message goes. A draft
// keeps the text untrimmed, with its ranges counted the same way.

// A draft is saved this long after the last change (contract 3.19, DRAFT_SAVE_DELAY).
const DRAFT_DELAY = 500;
// The picker offers at most this many people (rankMembers).
const PICK_LIMIT = 8;
const HISTORY_MAX = 100;
const HISTORY_MERGE_MS = 1000;
const HISTORY_MERGING = new Set(['insertText', 'deleteContentBackward', 'deleteContentForward']);
// Typed right after the space that follows a picked chip, these take the space's place, so "@Zoë!" comes out as
// people write it.
const TIGHT = /^[,.:;!?)]/;

function svg(name) {
  const tpl = document.createElement('template');
  tpl.innerHTML = icons[name] || '';
  return tpl.content.firstElementChild;
}

// ---------- parts ----------

const partText = (p) => (typeof p === 'string' ? p : p.label);
const partsText = (parts) => parts.map(partText).join('');
const partLength = (p) => partText(p).length;
const endsWithBreak = (parts) => typeof parts[parts.length - 1] === 'string' && parts[parts.length - 1].endsWith('\n');

function pushPart(out, p) {
  if (typeof p !== 'string') {
    if (p && p.member && p.label) out.push({ member: p.member, label: p.label });
    return;
  }
  if (!p) return;
  if (typeof out[out.length - 1] === 'string') out[out.length - 1] += p;
  else out.push(p);
}

function mergedParts(list) {
  const out = [];
  for (const p of list) pushPart(out, p);
  return out;
}

const sameParts = (a, b) =>
  a.length === b.length && a.every((p, i) => (typeof p === 'string' ? p === b[i] : typeof b[i] !== 'string' && b[i].member === p.member && b[i].label === p.label));

// The parts from position from to position to. A chip only comes along whole.
function cutParts(parts, from, to) {
  const out = [];
  let at = 0;
  for (const p of parts) {
    const len = partLength(p);
    if (typeof p === 'string') {
      const a = Math.max(from, at);
      const b = Math.min(to, at + len);
      if (b > a) out.push(p.slice(a - at, b - at));
    } else if (at >= from && at + len <= to) out.push(p);
    at += len;
  }
  return out;
}

const spliceParts = (parts, start, end, insert) => mergedParts([...cutParts(parts, 0, start), ...insert, ...cutParts(parts, end, Infinity)]);

// What the editor typed as the wire and the cache want it: a no-break space becomes a space, CRLF or a lone CR an LF.
const normalize = (s) => (typeof s.toWellFormed === 'function' ? s.toWellFormed() : s).replace(/ /g, ' ').replace(/\r\n?/g, '\n');

// The draft of parts: { text, mentions } with the text untrimmed and the mentions in UTF-8 bytes, or null when there is
// nothing but white space.
export function draftOf(parts) {
  let text = '';
  let bytes = 0;
  const mentions = [];
  for (const p of parts) {
    const s = typeof p === 'string' ? normalize(p) : p.label;
    const n = byteLength(s);
    if (typeof p !== 'string') mentions.push({ actor: p.member, start: bytes, end: bytes + n });
    text += s;
    bytes += n;
  }
  return text.trim() ? { text, mentions } : null;
}

const draftKey = (d) => (d ? JSON.stringify(d) : '');

// container: where the composer goes (the view's .ch-compose). opts:
//   placeholder, label     what the empty input says and its accessible name (the label defaults to the placeholder)
//   members()              the people a mention can name: Member[] or a promise of them, without yourself
//   recent()               member IDs of who posted lately, the latest first, for the picker's order
//   onSend(wire)           { text, mentions, bytes } to send; a promise. A rejected one puts the text back.
//   onEscape()             Escape with no picker open; true when it did something
//   onDraft(draft)         { text, mentions } or null, DRAFT_DELAY after the last change
//   draftKey               the draft's workspace, room and thread (draftSlotKey in chat-drafts.js): a send's answer is
//                          reconciled against that draft as every composer for it left it, this one or a later one
//   parts                  what the input starts with
// Returns { el, input, focus, parts, setParts, setMembers, refreshMembers, setBar, setPlaceholder, flush, dispose,
// hasFocus }.
export function mountChatInput(container, opts = {}) {
  let members = opts.members || (() => []);
  const listId = `ch-suggest-${Math.random().toString(36).slice(2)}`;
  const input = h('div', {
    class: 'ch-input sel is-empty',
    contenteditable: 'plaintext-only',
    role: 'textbox',
    'aria-multiline': 'true',
    spellcheck: 'true',
    'aria-haspopup': 'listbox',
    'aria-autocomplete': 'list'
  });
  const limit = h('span', { class: 'ch-limit', role: 'status', hidden: true });
  const send = h('button', { type: 'button', class: 'ch-send', disabled: true }, svg('send'));
  const box = h('div', { class: 'ch-box' }, input, h('div', { class: 'ch-box-row' }, limit, send));
  const bar = h('div', { class: 'ch-bar', hidden: true });
  container.append(box, bar);

  const state = { caret: 0, composing: false, barKey: null, disposed: false };
  // The @ that Escape closed the picker for (its position), so typing on after it doesn't open it again.
  let dismissed = null;
  // The space put in after the last picked chip, while the caret is right after it.
  let spaceAfter = null;
  // The picker on screen: { box, list, at, hits, active }.
  let pick = null;
  let pickSeq = 0;
  let draftTimer = null;
  let savedDraft = '';
  // The saved draft the input was last loaded with (setParts), until the next send.
  let loadedKey = '';
  // The draft's slot in chat-drafts.js, shared with the composers mounted before and after this one for the same
  // workspace, room and thread: its version tells a send in flight whether the draft it left behind is still the one on
  // disk. Without a key the composer has a slot of its own.
  const slotKey = opts.draftKey || draftSlotKey(null, listId, null);
  const history = { list: [{ parts: [], caret: 0 }], at: 0, type: '', last: 0, from: null };

  function setPlaceholder(placeholder, label = placeholder) {
    input.dataset.placeholder = placeholder || '';
    input.setAttribute('aria-label', label || placeholder || '');
    if (placeholder) input.setAttribute('aria-placeholder', placeholder);
    send.setAttribute('aria-label', t('chat.input.send'));
    send.title = t('chat.input.send');
  }
  setPlaceholder(opts.placeholder || '', opts.label || opts.placeholder || '');

  // ---------- the input's text ----------

  const isChip = (n) => n.nodeType === 1 && n.classList.contains('ch-chip');

  function partsOf(node, out = []) {
    // A <div> or <p> is a line of its own: a line break goes before it, unless it comes first, and before what follows.
    let first = true;
    let block = false;
    for (const n of node.childNodes) {
      const isBlock = n.nodeType === 1 && (n.nodeName === 'DIV' || n.nodeName === 'P');
      if ((isBlock && !first) || (block && !isBlock)) pushPart(out, '\n');
      if (n.nodeType === 3) pushPart(out, n.data);
      else if (isChip(n)) pushPart(out, { member: n.dataset.member, label: n.textContent });
      // A <br> that ends its line only holds an empty line open.
      else if (n.nodeName === 'BR' && n !== node.lastChild) pushPart(out, '\n');
      else if (n.nodeType === 1 && n.nodeName !== 'BR') partsOf(n, out);
      first = false;
      block = isBlock;
    }
    return out;
  }
  // What the input holds. A line break that ends the text is there twice on screen, so the empty line after it shows.
  function current() {
    const parts = partsOf(input);
    const last = input.lastChild;
    if (last && last.nodeType === 3 && last.data.endsWith('\n') && endsWithBreak(parts)) {
      parts[parts.length - 1] = parts[parts.length - 1].slice(0, -1);
      return mergedParts(parts);
    }
    return parts;
  }
  const value = () => partsText(current());
  // Read like a textarea's, for the Electron tests.
  Object.defineProperty(input, 'value', { get: value });
  const canonical = () => [...input.childNodes].every((n) => n.nodeType === 3 || isChip(n));

  function offsetAt(node, offset) {
    const r = document.createRange();
    r.setStart(input, 0);
    r.setEnd(node, offset);
    return partsText(partsOf(r.cloneContents())).length;
  }
  function selection() {
    const sel = document.getSelection();
    if (sel && sel.rangeCount && input.contains(sel.anchorNode) && input.contains(sel.focusNode)) {
      const len = value().length;
      const anchor = Math.min(offsetAt(sel.anchorNode, sel.anchorOffset), len);
      const focus = Math.min(offsetAt(sel.focusNode, sel.focusOffset), len);
      state.caret = Math.min(anchor, focus);
      return { start: state.caret, end: Math.max(anchor, focus), anchor, focus };
    }
    const at = Math.min(state.caret, value().length);
    return { start: at, end: at, anchor: at, focus: at };
  }
  // The DOM point for a position: in a text node, or before or after a chip, never inside one.
  function pointAt(at) {
    let left = at;
    const nodes = input.childNodes;
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      const len = n.nodeType === 3 ? n.data.length : isChip(n) ? n.textContent.length : 0;
      if (left <= len) return n.nodeType === 3 ? [n, left] : [input, left === 0 ? i : i + 1];
      left -= len;
    }
    return [input, nodes.length];
  }
  function placeSelection(anchor, focus = anchor) {
    document.getSelection().setBaseAndExtent(...pointAt(anchor), ...pointAt(focus));
  }
  function chipEl(p) {
    return h('span', { class: 'ch-chip', contenteditable: 'false', 'data-member': p.member, text: p.label });
  }
  // Draws parts with the selection from anchor to focus. It only moves when it was in the input.
  function render(parts, anchor, focus = anchor) {
    const sel = document.getSelection();
    const mine = document.activeElement === input || Boolean(sel && sel.rangeCount && input.contains(sel.anchorNode));
    const nodes = parts.map((p) => (typeof p === 'string' ? document.createTextNode(p) : chipEl(p)));
    if (endsWithBreak(parts)) nodes[nodes.length - 1].appendData('\n');
    input.replaceChildren(...nodes);
    const len = partsText(parts).length;
    const clamp = (x) => Math.max(0, Math.min(x, len));
    state.caret = Math.min(clamp(anchor), clamp(focus));
    if (mine) placeSelection(clamp(anchor), clamp(focus));
    input.classList.toggle('is-empty', !parts.length);
  }

  // ---------- undo ----------

  function record(type = '') {
    const snap = { parts: current(), caret: selection().start };
    const top = history.list[history.at];
    const from = history.from;
    history.from = null;
    if (sameParts(top.parts, snap.parts)) {
      top.caret = snap.caret;
      return;
    }
    const now = Date.now();
    const merge = HISTORY_MERGING.has(type) && type === history.type && from === top.caret && now - history.last < HISTORY_MERGE_MS && history.at > 0;
    history.list.length = history.at + 1;
    if (merge) history.list[history.at] = snap;
    else {
      history.list.push(snap);
      history.at += 1;
      if (history.list.length > HISTORY_MAX) {
        history.list.shift();
        history.at -= 1;
      }
    }
    history.type = type;
    history.last = now;
  }
  function resetHistory() {
    history.list = [{ parts: current(), caret: state.caret }];
    history.at = 0;
    history.type = '';
  }
  function undo(step) {
    const i = history.at + step;
    if (i < 0 || i >= history.list.length) return;
    history.at = i;
    history.type = '';
    const snap = history.list[i];
    render(snap.parts, snap.caret);
    changed();
  }

  // ---------- editing ----------

  // After the browser changed the text: anything but text and chips becomes text, and the change is a step to undo.
  function settle(type) {
    if (!canonical()) {
      const { anchor, focus } = selection();
      render(current(), anchor, focus);
    } else input.classList.toggle('is-empty', !current().length);
    record(type);
  }
  // Puts parts in place of the selection, as typing would.
  function insert(list, type) {
    const { start, end } = selection();
    const add = list.map(partText).join('').length;
    render(spliceParts(current(), start, end, list), start + add);
    record(type);
    changed();
  }

  // The limits line and the Send button (contract 3.16): over 16,384 bytes or 32 mentions, Send stays off and the line
  // says why. Nothing shows below the limits.
  function updateSend() {
    const wire = toWire(current());
    const problem = sendProblem(wire);
    const text = problem === 'tooLong' ? t('chat.input.tooLong') : problem === 'tooManyMentions' ? t('chat.input.tooManyMentions') : '';
    if (limit.textContent !== text) limit.textContent = text;
    limit.hidden = !text;
    send.disabled = Boolean(problem);
    input.classList.toggle('is-empty', !current().length);
  }

  function scheduleDraft() {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(flushDraft, DRAFT_DELAY);
  }
  // The draft goes to main now, when it changed since the last one.
  function flushDraft() {
    clearTimeout(draftTimer);
    draftTimer = null;
    const parts = current();
    const d = draftOf(parts);
    const key = draftKey(d);
    if (key === savedDraft) return;
    writeDraft(d ? parts : null);
  }
  function writeDraft(parts) {
    const d = parts ? draftOf(parts) : null;
    savedDraft = draftKey(d);
    draftWritten(slotKey, d ? parts : null);
    if (opts.onDraft) opts.onDraft(d);
  }

  function changed() {
    updateSend();
    scheduleDraft();
    updatePicker();
  }

  // Enter and Ctrl+Enter: the message goes. The input empties at once, and the saved draft stays until main has the
  // message on disk (contract 3.8): then it goes, unless a newer draft was saved meanwhile, by this composer or one
  // mounted for the same draft after it. When main can't take it (it couldn't be saved, say), the text comes back: in
  // the composer on screen for the draft, before what was typed since, or in the saved draft when there is none, so it
  // is never lost (chat-drafts.js sendSettled).
  function submit() {
    if (state.composing || state.disposed) return;
    const parts = current();
    const wire = toWire(parts);
    if (sendProblem(wire)) return updateSend();
    const caret = selection().start;
    closePicker();
    render([], 0);
    resetHistory();
    spaceAfter = null;
    clearTimeout(draftTimer);
    draftTimer = null;
    // An empty input is the draft from now on, so a draft of nothing isn't written; the old one waits for the answer.
    savedDraft = '';
    loadedKey = '';
    updateSend();
    const ticket = sendStarted(slotKey, { from: live, caret });
    // The draft as the send's answer leaves it, written with this composer's onDraft: its workspace, room and thread
    // are the slot's.
    const save = (p) => {
      if (opts.onDraft) opts.onDraft(p ? draftOf(mergedParts(p)) : null);
    };
    Promise.resolve()
      .then(() => opts.onSend && opts.onSend(wire))
      .then(
        () => sendSettled(ticket, true, parts, save),
        () => sendSettled(ticket, false, parts, save)
      );
  }

  // For chat-drafts.js, while this composer is the one on screen for its draft.
  const live = {
    // A refused send's text: before what the input holds, or in place of nothing with the caret where it was sent from.
    // A composer mounted after the send may have loaded it as the draft the send left behind; while the input still
    // starts with it, it is there already.
    takeBack(sent, ticket) {
      const since = current();
      if (loadedKey && loadedKey === draftKey(draftOf(sent)) && partsText(since).startsWith(partsText(sent))) return;
      const back = since.length ? mergedParts([...sent, '\n', ...since]) : mergedParts(sent);
      render(back, since.length || !ticket || ticket.from !== live ? partsText(back).length : ticket.caret);
      resetHistory();
      changed();
    },
    // A send taken after this composer loaded the draft it left behind: that draft is gone from disk now. The input
    // empties when it still holds it unedited; an edited one is saved again like typed text.
    dropSent(sent) {
      const key = draftKey(draftOf(sent));
      if (!key || savedDraft !== key) return;
      savedDraft = '';
      if (draftKey(draftOf(current())) === key) setParts([]);
      else scheduleDraft();
    }
  };
  attachDraft(slotKey, live);

  // Backspace right after a chip and Delete right before one take it off whole.
  function deleteChip(forward) {
    const { start, end } = selection();
    if (start !== end) return false;
    const parts = current();
    let at = 0;
    for (const p of parts) {
      const len = partLength(p);
      if (typeof p !== 'string' && ((!forward && at + len === start) || (forward && at === start))) {
        render(spliceParts(parts, at, at + len, []), at);
        record('chip');
        changed();
        return true;
      }
      at += len;
    }
    return false;
  }

  // ---------- the mention picker ----------

  // The mention being typed at the caret: { node, start, end, query, at } with at the @'s position, or null.
  function caretToken() {
    const sel = document.getSelection();
    if (!sel || !sel.rangeCount || !sel.isCollapsed) return null;
    const node = sel.anchorNode;
    if (!node || node.nodeType !== 3 || node.parentNode !== input) return null;
    const prev = node.previousSibling;
    const before = prev ? (prev.nodeType === 3 ? prev.data : prev.textContent || '').slice(-1) : '';
    const tok = mentionToken(node.data.slice(0, sel.anchorOffset), before);
    if (!tok) return null;
    return { node, start: tok.start, end: sel.anchorOffset, query: tok.query, at: offsetAt(node, tok.start) };
  }

  function closePicker() {
    pickSeq++;
    if (!pick) return;
    pick.box.remove();
    pick = null;
    input.removeAttribute('aria-controls');
    input.removeAttribute('aria-activedescendant');
    input.setAttribute('aria-expanded', 'false');
  }

  const optionId = (i) => `${listId}-${i}`;
  function setActive(i) {
    if (!pick) return;
    pick.active = i;
    const list = pick.list;
    list.querySelectorAll('[role="option"]').forEach((el, j) => {
      el.classList.toggle('active', j === i);
      el.setAttribute('aria-selected', String(j === i));
      if (j !== i) return;
      if (el.offsetTop < list.scrollTop) list.scrollTop = el.offsetTop;
      else if (el.offsetTop + el.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = el.offsetTop + el.offsetHeight - list.clientHeight;
    });
    if (pick.hits.length) input.setAttribute('aria-activedescendant', optionId(i));
    else input.removeAttribute('aria-activedescendant');
  }

  // Under the @, or above it where the window has more room; never wider than 320px or taller than the window.
  function place() {
    if (!pick) return;
    const tok = caretToken();
    if (!tok) return closePicker();
    const r = document.createRange();
    r.setStart(tok.node, tok.start);
    r.setEnd(tok.node, Math.min(tok.start + 1, tok.node.length));
    const at = r.getBoundingClientRect();
    const view = input.getBoundingClientRect();
    if (at.bottom < view.top || at.top > view.bottom) return closePicker();
    const { box: el } = pick;
    const width = Math.min(320, window.innerWidth - 16);
    el.style.width = `${width}px`;
    el.style.left = `${Math.max(8, Math.min(at.left - 10, window.innerWidth - width - 8))}px`;
    el.style.maxHeight = '';
    const full = el.offsetHeight;
    const below = at.bottom + 6;
    const roomBelow = window.innerHeight - 8 - below;
    const roomAbove = at.top - 6 - 8;
    // The composer sits at the bottom of the window, so the list mostly opens upwards.
    const down = roomBelow >= roomAbove;
    const height = Math.min(full, Math.max(48, down ? roomBelow : roomAbove));
    el.style.maxHeight = `${height}px`;
    el.style.top = `${Math.max(8, down ? Math.min(below, window.innerHeight - 8 - height) : at.top - 6 - height)}px`;
    el.style.transformOrigin = down ? 'top left' : 'bottom left';
  }

  function drawPicker(tok, hits) {
    const was = pick && pick.hits[pick.active] ? pick.hits[pick.active].id : null;
    if (!pick) {
      const el = h('div', { class: 'suggest mention-suggest ch-suggest' });
      const list = h('div', { class: 'mention-list', role: 'listbox', id: listId });
      el.append(list);
      // The input keeps the focus and the caret; a click picks.
      el.addEventListener('mousedown', (e) => e.preventDefault());
      list.addEventListener('click', (e) => {
        const o = e.target.closest('[role="option"]');
        if (o && pick && o.dataset.i !== undefined && pick.hits[Number(o.dataset.i)]) choose(pick.hits[Number(o.dataset.i)]);
      });
      list.addEventListener('mousemove', (e) => {
        const o = e.target.closest('[role="option"]');
        if (o && pick && o.dataset.i !== undefined && Number(o.dataset.i) !== pick.active) setActive(Number(o.dataset.i));
      });
      document.body.append(el);
      pick = { box: el, list, at: tok.at, hits, active: 0 };
      input.setAttribute('aria-controls', listId);
      input.setAttribute('aria-expanded', 'true');
    }
    pick.at = tok.at;
    pick.hits = hits;
    pick.list.setAttribute('aria-label', t('chat.mentions.label'));
    pick.list.textContent = '';
    if (!hits.length) {
      pick.list.append(h('div', { class: 'ch-suggest-none', role: 'option', 'aria-disabled': 'true', 'aria-selected': 'false', text: t('chat.mentions.none') }));
    }
    hits.forEach((m, i) => {
      const av = h('span', { class: 'avatar mention-avatar', 'aria-hidden': 'true', text: initials({ name: m.name }) });
      av.style.setProperty('--h', String(hue(m.id)));
      const o = h('div', { role: 'option', id: optionId(i), 'data-i': String(i), 'data-member': m.id, 'aria-selected': 'false' }, av, h('span', { class: 'mention-who' }, h('span', { class: 'mention-name', text: m.name })));
      if (m.role === 'guest') o.append(h('span', { class: 'mention-tag', text: t('chat.roles.guest') }));
      pick.list.append(o);
    });
    const keep = was ? hits.findIndex((m) => m.id === was) : -1;
    setActive(keep >= 0 ? keep : 0);
    place();
  }

  async function updatePicker() {
    const tok = state.composing || !bar.hidden ? null : caretToken();
    if (!tok) dismissed = null;
    if (!tok || tok.at === dismissed) return closePicker();
    const mine = ++pickSeq;
    let list = [];
    try {
      list = (await members()) || [];
    } catch (_) {
      list = [];
    }
    if (mine !== pickSeq || state.disposed) return;
    // The caret may have moved on while the members loaded.
    const now = caretToken();
    if (!now || now.at !== tok.at) return closePicker();
    const recent = opts.recent ? opts.recent() : [];
    drawPicker(now, rankMembers({ query: now.query, members: list, recent, limit: PICK_LIMIT }));
  }

  // The person goes in as a locked chip, "@" and their name, with a space after it unless one follows already.
  function choose(member) {
    const tok = caretToken();
    closePicker();
    if (!tok || !member) return;
    const start = tok.at;
    const end = offsetAt(tok.node, tok.end);
    const parts = current();
    const label = `@${String(member.name || '').trim()}`;
    const spaced = /^\s/.test(partsText(parts).slice(end));
    render(spliceParts(parts, start, end, spaced ? [{ member: member.id, label }] : [{ member: member.id, label }, ' ']), start + label.length + 1);
    spaceAfter = spaced ? null : start + label.length + 1;
    record('pick');
    updateSend();
    scheduleDraft();
  }

  // ---------- events ----------

  input.addEventListener('compositionstart', () => {
    state.composing = true;
    closePicker();
  });
  input.addEventListener('compositionend', () => {
    state.composing = false;
    settle('insertText');
    changed();
  });
  input.addEventListener('beforeinput', (e) => {
    if (e.inputType === 'historyUndo' || e.inputType === 'historyRedo') {
      e.preventDefault();
      undo(e.inputType === 'historyUndo' ? -1 : 1);
      return;
    }
    const { start, end } = selection();
    history.from = start === end ? start : null;
    const s = spaceAfter;
    spaceAfter = null;
    if (s === null || e.inputType !== 'insertText' || !TIGHT.test(e.data || '') || start !== end || start !== s) return;
    const parts = current();
    if (partsText(parts)[s - 1] !== ' ') return;
    e.preventDefault();
    render(spliceParts(parts, s - 1, s, [e.data]), s - 1 + e.data.length);
    record('insertText');
    changed();
  });
  input.addEventListener('input', (e) => {
    if (state.composing || e.isComposing) return;
    settle(e.inputType);
    changed();
  });
  input.addEventListener('paste', (e) => {
    e.preventDefault();
    const text = e.clipboardData ? e.clipboardData.getData('text/plain').replace(/\r\n?/g, '\n') : '';
    if (text) insert([text], 'paste');
  });
  // Dropped text goes in as plain text; dropped files do nothing.
  input.addEventListener('drop', (e) => {
    if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) e.preventDefault();
  });
  input.addEventListener('keydown', (e) => {
    // While an IME composes, Enter, Tab, the arrows and Escape are its keys.
    if (e.isComposing || e.keyCode === 229) return;
    const key = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (key === 'z' || key === 'y')) {
      e.preventDefault();
      undo(key === 'y' || e.shiftKey ? 1 : -1);
      return;
    }
    if (pick) {
      const n = pick.hits.length;
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && n) {
        e.preventDefault();
        e.stopPropagation();
        setActive((pick.active + (e.key === 'ArrowDown' ? 1 : -1) + n) % n);
        return;
      }
      if (((e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) || (e.key === 'Tab' && !e.shiftKey)) && n) {
        e.preventDefault();
        e.stopPropagation();
        choose(pick.hits[pick.active]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        dismissed = pick.at;
        closePicker();
        return;
      }
    }
    if (e.key === 'Enter' && !e.altKey) {
      e.preventDefault();
      e.stopPropagation();
      if (e.shiftKey && !e.ctrlKey && !e.metaKey) insert(['\n'], 'insertLineBreak');
      else submit();
      return;
    }
    if (e.key === 'Escape' && !e.shiftKey && !e.ctrlKey && !e.altKey) {
      if (opts.onEscape && opts.onEscape()) {
        e.preventDefault();
        e.stopPropagation();
      }
      return;
    }
    if ((e.key === 'Backspace' || e.key === 'Delete') && !e.ctrlKey && !e.altKey && !e.metaKey) {
      if (deleteChip(e.key === 'Delete')) e.preventDefault();
    }
  });
  input.addEventListener('blur', () => {
    selection();
    closePicker();
  });
  input.addEventListener('click', () => updatePicker());
  const onSelection = () => {
    if (!pick || document.activeElement !== input) return;
    const tok = caretToken();
    if (!tok || tok.at !== pick.at) return closePicker();
    updatePicker();
  };
  document.addEventListener('selectionchange', onSelection);
  const onResize = () => closePicker();
  window.addEventListener('resize', onResize);
  // Rukoo quitting within DRAFT_DELAY of the last key still keeps the draft.
  const onUnload = () => {
    if (draftTimer) flushDraft();
  };
  window.addEventListener('beforeunload', onUnload);
  input.addEventListener('scroll', () => place(), { passive: true });
  send.addEventListener('click', () => {
    submit();
    input.focus({ preventScroll: true });
  });

  // parts: what the input holds from now on, with the caret at the end. dirty: it isn't the saved draft, so it is
  // saved like typed text.
  function setParts(parts, { dirty = false } = {}) {
    const list = mergedParts(parts || []);
    render(list, partsText(list).length);
    resetHistory();
    if (dirty) scheduleDraft();
    else loadedKey = savedDraft = draftKey(draftOf(list));
    updateSend();
  }

  // bar: { icon, text, actions: [{ id, label, run, primary }] } in place of the input, or null for the input again.
  function setBar(b) {
    const key = b ? JSON.stringify([b.icon, b.text, (b.actions || []).map((a) => [a.id, a.label])]) : null;
    if (key === state.barKey) return;
    const hadFocus = box.contains(document.activeElement) || bar.contains(document.activeElement);
    state.barKey = key;
    closePicker();
    bar.textContent = '';
    box.hidden = Boolean(b);
    bar.hidden = !b;
    if (!b) {
      if (hadFocus) input.focus({ preventScroll: true });
      return;
    }
    bar.append(h('span', { class: 'ch-bar-ic', 'aria-hidden': 'true' }, svg(b.icon || 'info')), h('span', { class: 'ch-bar-text', role: 'status', text: b.text }));
    if (b.actions && b.actions.length) {
      const row = h('span', { class: 'ch-bar-actions' });
      for (const a of b.actions) row.append(h('button', { type: 'button', class: `btn ${a.primary ? 'primary' : 'secondary'} sm`, 'data-ch-bar': a.id, text: a.label, onClick: () => a.run() }));
      bar.append(row);
    }
    if (hadFocus) (bar.querySelector('button') || null)?.focus({ preventScroll: true });
  }

  if (opts.parts && opts.parts.length) setParts(opts.parts);
  else updateSend();

  return {
    el: box,
    input,
    bar,
    focus() {
      if (!bar.hidden) return bar.querySelector('button')?.focus({ preventScroll: true });
      if (document.activeElement === input) return;
      input.focus({ preventScroll: true });
      placeSelection(Math.min(state.caret, value().length));
    },
    hasFocus: () => document.activeElement === input,
    parts: current,
    setParts,
    setMembers(fn) {
      members = typeof fn === 'function' ? fn : () => fn || [];
    },
    // The members changed (the directory came in, someone joined or left): an open picker asks for them again, so one
    // opened before the directory loaded doesn't keep saying nobody is here.
    refreshMembers() {
      if (pick && !state.disposed) updatePicker();
    },
    setBar,
    setPlaceholder,
    flush: flushDraft,
    dispose() {
      if (state.disposed) return;
      if (draftTimer) flushDraft();
      state.disposed = true;
      detachDraft(slotKey, live);
      closePicker();
      document.removeEventListener('selectionchange', onSelection);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('beforeunload', onUnload);
      box.remove();
      bar.remove();
    }
  };
}
