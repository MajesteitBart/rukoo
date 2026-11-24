import { t, getLocale } from './i18n.js';
import { icons } from './icons.js';
import { api, esc, toast, showMenu, closeMenu, menuOpen, dialog, confirmDialog, KEEP_OPEN, segmented, setSegmented } from './ui.js';
import {
  displayName,
  onlyOwner,
  sharedManaged,
  soleManager,
  successors,
  handOverReady,
  SUCCESSOR_SEARCH_FROM,
  dmPicker,
  addPeopleEmpty,
  inviteGrant,
  inviteRowChannels,
  isAgent,
  isPerson,
  agentAnswersText,
  agentNote,
  agentFormAnswers,
  agentFormReady,
  AGENT_CHOSEN_MAX,
  canAddAgent,
  canRemoveAgent,
  canManageAgent,
  canRenewAgentKey,
  mayTakeAgents,
  agentsLeavingWith,
  leavingAgentsText
} from './chat-model.js';
import { runnerAgents, runnerConfig, runnerText, runnerEnv, PLACEHOLDER_BACKEND, RUNNER_COMMAND } from './chat-agents.js';

// Team chat's dialogs (contract 3.3, 3.12, 5.10; desktop-ui 6): making and joining a workspace, inviting people,
// channels (make, browse, members and roles, rename, archive, leave and the successor), leaving and deleting a
// workspace, its members and settings, New message, blocking, and leaving a conversation. Each is an async function
// that answers with what came of it, or null.
//
// chat.js gives them what they need through bindDialogs(kit) once, so this module never imports chat.js:
//   CH, ctx, errorText(err, context), hostNote(), summary(id?), me(), myRole(), isGuest(), roomName(room),
//   memberAvatar(id, cls), tileHtml(w), selectWorkspace(ws, opts), openRoom(id, opts), openDefault(),
//   previewChannel(channel), expectLeave(roomId), expectGone(ws), reload(), refreshState(), caps()
//
// Rules every dialog keeps (desktop-ui 6): a server call disables the buttons and marks the primary one aria-busy;
// its error shows under the field err.field names, or above the buttons; an error never closes the dialog. Names
// people typed reach the DOM through esc(). A dialog about a workspace closes when the workspace on screen changes
// (CH.generation), so nothing acts on a workspace that went.

let K = null;

export function bindDialogs(kit) {
  K = kit;
}

// ---------- helpers ----------

// 1 to 80 characters on one line, as the server takes names (contract 3.16).
export const nameOk = (s) => {
  const v = String(s || '').trim();
  return v.length > 0 && [...v].length <= 80 && !/[\r\n]/.test(v);
};
const fold = (s) =>
  String(s || '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLocaleLowerCase();
const collator = () => new Intl.Collator(getLocale(), { sensitivity: 'base', numeric: true });
const dateTime = (ms) =>
  Number.isFinite(ms) ? new Intl.DateTimeFormat(getLocale(), { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms)) : '';
const nameOf = (id) => displayName(K.CH.members.get(id), t);
const isAdmin = () => ['owner', 'admin'].includes(K.myRole());
const wsName = () => K.summary()?.name || K.CH.view?.ws?.name || '';
const roleText = (role) => t(`chat.roles.${['owner', 'admin', 'member', 'guest', 'manager'].includes(role) ? role : 'member'}`);
const activeMembers = () => [...K.CH.members.values()].filter((m) => m.state === 'active');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const channelIcon = (c) => (c.archived ? icons.archive : c.visibility === 'private' ? icons.lock : icons.hash);
// Agents in channels (server/WORKSPACES.md "Agents"), when the server lists them in its capabilities.
const agentsOn = () => Boolean(K.caps && K.caps().has('agents'));
// Whether the person sponsors an active agent they could add to room without managing it: a channel the workspace
// can see. Whether it is in the channel already shows once the channel's members load.
export const sponsorsHere = (room) =>
  agentsOn() && Boolean(room) && room.kind === 'channel' && !room.archived && room.visibility === 'workspace' && activeMembers().some((m) => isAgent(m) && m.agent?.sponsor === K.me());
// Rukoo in a browser (src/web) has no Settings, Agents to take a runner's backend from.
const WEB = window.mail?.platform === 'web';
const listFormat = () => new Intl.ListFormat(getLocale(), { type: 'conjunction' });
const agentTag = () => `<span class="ch-tag ch-agent-tag">${esc(t('chat.roles.agent'))}</span>`;
const byName = (a, b) => collator().compare(displayName(a, t), displayName(b, t));
// "Made by Olga · Answers only Olga" under an agent's name, as a channel's members and Workspace members show it.
const agentLine = (m) => agentNote(m, { members: K.CH.members, t, listFormat: listFormat() });
// A member's name in a list row; an agent's with its line under it.
const personName = (m, label) => {
  const note = isAgent(m) ? agentLine(m) : null;
  return note
    ? `<span class="ch-agent-text"><span class="ch-person-name">${esc(label)}</span><span class="ch-agent-meta">${esc(note)}</span></span>`
    : `<span class="ch-person-name">${esc(label)}</span>`;
};

const cancelButton = () => ({ get label() { return t('common.actions.cancel'); }, value: null });
const closeButton = () => ({ get label() { return t('common.actions.close'); }, value: null });

// Shows text under field (or above the buttons for ''), and hides the other error lines.
function showError(body, field, text) {
  for (const el of body.querySelectorAll('[data-error]')) {
    const mine = el.dataset.error === (field || '');
    el.hidden = !(mine && text);
    if (mine) el.textContent = text || '';
  }
  if (field && text) body.querySelector(`[name="${field}"]`)?.focus();
}
const clearErrors = (body) => showError(body, null, '');

function setBusy(scrim, busy) {
  if (!scrim) return;
  for (const b of scrim.querySelectorAll('.buttons button, .dialog-body [data-busy-off]')) b.disabled = busy;
  const primary = scrim.querySelector('.buttons button:last-child');
  if (primary) primary.toggleAttribute('aria-busy', busy);
}

// Enter in a text field presses the dialog's primary button.
function enterSubmits(body, submit) {
  body.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing && e.target.matches('input[type="text"], input:not([type])')) {
      e.preventDefault();
      submit(body.closest('.scrim'));
    }
  });
}

// The error of a failed call under its field when it names one of fields, else above the buttons.
function fieldOf(err, fields) {
  return err && err.code === 'invalid' && fields.includes(err.field) ? err.field : err && err.code === 'name_taken' && fields.includes('name') ? 'name' : '';
}

// Makes a dialog a chat dialog, whose body scrolls between the title and the buttons. While the body holds more than
// it shows, the dialog gets is-scrollable (a hairline above the buttons) and, while more sits below the visible part,
// has-more (a fade at the body's bottom edge), so a cut between two sections still shows that the dialog goes on. The
// classes follow scrolling, a resized window or zoom, and content that changes, such as a list that loads or a
// section that opens.
function chatDialog(body) {
  const box = body.closest('.dialog');
  box.classList.add('ch-dialog');
  const check = () => {
    const over = body.scrollHeight - body.clientHeight;
    box.classList.toggle('is-scrollable', over > 1);
    box.classList.toggle('has-more', over - body.scrollTop > 1);
  };
  let queued = false;
  const soon = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      check();
    });
  };
  body.addEventListener('scroll', check, { passive: true });
  body.addEventListener('toggle', soon, true);
  new ResizeObserver(soon).observe(body);
  new MutationObserver(soon).observe(body, { childList: true, subtree: true, attributes: true, characterData: true });
  soon();
  return box;
}

// The open dialogs that draw from the directory (members, channels, blocks). Main sends the rooms before the directory,
// so on a slow first sign-in a dialog can open before anyone has a name; chat.js calls directoryChanged() when a view
// it loads changed what they draw from, and each of them draws its lists again.
const followers = new Set();

export function directoryChanged() {
  for (const redraw of [...followers]) {
    try {
      redraw();
    } catch (err) {
      console.error(err);
    }
  }
}

// What finds a focused control again after its list is drawn again: a field by its name (a radio or checkbox also by
// its value), else a button by its first data attribute, such as data-join or data-person.
function focusKey(el) {
  if (el.name) return /^(radio|checkbox)$/.test(el.type) ? `[name="${CSS.escape(el.name)}"][value="${CSS.escape(el.value)}"]` : `[name="${CSS.escape(el.name)}"]`;
  const data = [...el.attributes].find((a) => a.name.startsWith('data-'));
  return data ? `[${data.name}="${CSS.escape(data.value)}"]` : null;
}

// A dialog about the workspace on screen: it closes when that workspace changes or goes (desktop-ui 7.11).
// opts.redraw(body): draws the dialog's lists again when the directory changes, keeping what was typed, picked or
// checked; the focus stays on the same control.
function wsDialog(opts) {
  const gen = K.CH.generation;
  let timer = null;
  let follow = null;
  return dialog({
    ...opts,
    render(body, done) {
      timer = setInterval(() => {
        if (K.CH.generation !== gen || !body.isConnected) done(null);
      }, 250);
      chatDialog(body);
      if (opts.quietClose) body.closest('.dialog').classList.add('ch-quiet-close');
      if (opts.cls) body.closest('.dialog').classList.add(...opts.cls.split(' '));
      if (opts.render) opts.render(body, done);
      if (opts.redraw) {
        follow = () => {
          // A view loaded for another workspace isn't this dialog's: the timer above closes it.
          if (K.CH.generation !== gen || !body.isConnected) return;
          const focused = body.contains(document.activeElement) ? document.activeElement : null;
          const key = focused && focusKey(focused);
          opts.redraw(body);
          if (key && !focused.isConnected) body.querySelector(key)?.focus();
        };
        followers.add(follow);
      }
    }
  }).finally(() => {
    clearInterval(timer);
    followers.delete(follow);
  });
}

// A person's menu inside a dialog. The dialog takes Escape on the document before the menu sees it, which would close
// both; this listener on the window comes first, so Escape closes only the menu and the focus goes back to its button.
// One listener serves the menu on screen: a menu closed by a click leaves its listener until the next key or the next
// menu, which takes its place.
let dialogMenuKey = null;
function menuInDialog(anchor, items) {
  if (dialogMenuKey) window.removeEventListener('keydown', dialogMenuKey, true);
  showMenu(anchor, items, { align: 'right' });
  const onKey = (e) => {
    if (!menuOpen()) {
      stop();
      return;
    }
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    stop();
    closeMenu({ refocus: true });
  };
  const stop = () => {
    window.removeEventListener('keydown', onKey, true);
    if (dialogMenuKey === onKey) dialogMenuKey = null;
  };
  dialogMenuKey = onKey;
  window.addEventListener('keydown', onKey, true);
}

// A room the feed brings after a write (a joined channel, a new one): there, or reloaded once.
async function waitForRoom(id, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (K.CH.rooms.has(id)) return true;
    await sleep(100);
  }
  await K.reload();
  return K.CH.rooms.has(id);
}

// The name a person goes by in a new workspace: the first mail account's display name, else the part of the Rukoo
// account's address before the @ (contract 3.3).
async function defaultName() {
  const acc = K.ctx.S?.data?.accounts?.[0];
  if (acc && String(acc.name || '').trim()) return String(acc.name).trim();
  const status = await api('accountStatus').catch(() => null);
  return status && typeof status.email === 'string' ? status.email.split('@')[0] : '';
}

// ---------- workspaces: make and join (desktop-ui 6.1, 6.2; contract 3.3) ----------

export async function makeWorkspace() {
  if (!K.CH.state || !K.CH.state.signedIn) return null;
  const yourName = await defaultName();
  let finish = null;
  let busy = false;
  const submit = async (scrim) => {
    if (busy) return;
    const body = scrim.querySelector('.dialog-body');
    const name = body.querySelector('[name="name"]').value.trim();
    const displayName = body.querySelector('[name="displayName"]').value.trim();
    if (!nameOk(name)) return showError(body, 'name', t('chat.errors.invalidName'));
    if (!nameOk(displayName)) return showError(body, 'displayName', t('chat.errors.invalidName'));
    clearErrors(body);
    busy = true;
    setBusy(scrim, true);
    try {
      const made = await api('chatCreateWorkspace', { name, displayName });
      K.firstWorkspace?.();
      finish(made && made.ws);
    } catch (err) {
      busy = false;
      setBusy(scrim, false);
      showError(body, fieldOf(err, ['name', 'displayName']), K.errorText(err));
    }
  };
  const ws = await dialog({
    title: t('chat.make.title'),
    buttons: [cancelButton(), { label: t('chat.make.submit'), value: (scrim) => (submit(scrim), KEEP_OPEN) }],
    render(body, done) {
      finish = done;
      chatDialog(body);
      body.innerHTML = `<div class="form ch-form">
        <label>${esc(t('chat.make.name'))}<input type="text" name="name" autocomplete="off" spellcheck="false" maxlength="200" placeholder="${esc(t('chat.make.namePlaceholder'))}"/></label>
        <p class="error" data-error="name" hidden></p>
        <label>${esc(t('chat.make.yourName'))}<input type="text" name="displayName" autocomplete="off" spellcheck="false" maxlength="200" value="${esc(yourName)}"/></label>
        <p class="error" data-error="displayName" hidden></p>
        ${K.hostNote()}
        <p class="error" data-error="" hidden></p>
      </div>`;
      enterSubmits(body, submit);
    }
  });
  if (ws) await K.selectWorkspace(ws);
  return ws || null;
}

// Join with an invitation link (desktop-ui 6.2, contract 3.3 and 5.10): the link, its card, the person's name. A
// link that came with a sign-up loads its card at once.
export async function joinWorkspace(link = '') {
  if (!K.CH.state || !K.CH.state.signedIn) return null;
  const yourName = await defaultName();
  let finish = null;
  let busy = false;
  // The card for the link in the field: null until it was checked.
  let preview = null;
  let checked = '';
  // The link is for another server: the dialog only explains and closes.
  let elsewhere = false;

  const parts = (body) => ({
    link: body.querySelector('[name="link"]'),
    checking: body.querySelector('[data-checking]'),
    card: body.querySelector('[data-preview]'),
    name: body.querySelector('[data-name]'),
    host: body.querySelector('[data-host]'),
    other: body.querySelector('[data-other]')
  });
  const buttons = (scrim) => [...scrim.querySelectorAll('.buttons button')];

  // Back to the first step: the link changed.
  const reset = (scrim) => {
    const body = scrim.querySelector('.dialog-body');
    const p = parts(body);
    preview = null;
    checked = '';
    elsewhere = false;
    p.card.hidden = p.name.hidden = p.host.hidden = p.other.hidden = true;
    const [cancel, primary] = buttons(scrim);
    cancel.hidden = false;
    primary.textContent = t('chat.join.check');
    clearErrors(body);
  };

  const check = async (scrim) => {
    const body = scrim.querySelector('.dialog-body');
    const p = parts(body);
    const text = p.link.value.trim();
    if (!text) return showError(body, 'link', t('chat.join.badLink'));
    clearErrors(body);
    busy = true;
    setBusy(scrim, true);
    p.checking.hidden = false;
    try {
      const card = await api('chatPreviewInvite', text);
      if (!scrim.isConnected || p.link.value.trim() !== text) return;
      preview = card;
      // The field shows the link main read (contract 3.2), in place of a sentence around it or a full stop after it.
      if (card.link && card.link !== text) p.link.value = card.link;
      checked = p.link.value.trim();
      drawCard(scrim, card);
    } catch (err) {
      if (!scrim.isConnected) return;
      const code = err && err.code;
      if (code === 'other_server') {
        elsewhere = true;
        const linkHost = hostOf(text);
        p.other.textContent = t('chat.join.otherHost', { host: linkHost, own: K.CH.state?.host || '' });
        p.other.hidden = false;
        const [cancel, primary] = buttons(scrim);
        cancel.hidden = true;
        primary.textContent = t('common.actions.close');
      } else if (code === 'bad_link' || (code === 'invalid' && ['link', 'invite'].includes(err.field))) {
        showError(body, 'link', t('chat.join.badLink'));
      } else if (code === 'invite_gone' || (code === 'not_found' && err.scope !== 'conversation')) {
        showError(body, 'link', t('chat.errors.inviteGone'));
      } else showError(body, '', K.errorText(err));
    } finally {
      busy = false;
      if (scrim.isConnected) {
        setBusy(scrim, false);
        p.checking.hidden = true;
      }
    }
  };

  const drawCard = (scrim, card) => {
    const body = scrim.querySelector('.dialog-body');
    const p = parts(body);
    const lines = card.already
      ? [t('chat.join.already', { name: card.workspace.name })]
      : [
          card.issuer && card.issuer.name ? t(card.role === 'guest' ? 'chat.join.invitedByGuest' : 'chat.join.invitedBy', { name: card.issuer.name }) : '',
          t('chat.join.channels', { count: Number(card.channels) || 0 }),
          Number.isFinite(card.expiresAt) ? t('chat.join.expires', { date: dateTime(card.expiresAt) }) : '',
          t('chat.join.history')
        ].filter(Boolean);
    p.card.innerHTML = `<div class="ch-join-head">${K.tileHtml({ id: card.workspace.id, name: card.workspace.name })}<p class="ch-join-ws">${esc(card.workspace.name)}</p></div>${lines
      .map((l) => `<p>${esc(l)}</p>`)
      .join('')}`;
    p.card.hidden = false;
    p.name.hidden = Boolean(card.already);
    p.host.hidden = Boolean(card.already);
    const [, primary] = buttons(scrim);
    primary.textContent = card.already ? t('chat.join.open') : t('chat.join.submit', { name: card.workspace.name });
    if (!card.already) {
      const input = body.querySelector('[name="name"]');
      input.focus();
      input.select();
    } else primary.focus();
  };

  const submit = async (scrim) => {
    if (busy) return;
    const body = scrim.querySelector('.dialog-body');
    const p = parts(body);
    if (elsewhere) return finish(null);
    const text = p.link.value.trim();
    if (!preview || text !== checked) return check(scrim);
    if (preview.already) return finish({ ws: preview.workspace.id, already: true, name: preview.workspace.name });
    const name = body.querySelector('[name="name"]').value.trim();
    if (!nameOk(name)) return showError(body, 'name', t('chat.errors.invalidName'));
    clearErrors(body);
    busy = true;
    setBusy(scrim, true);
    try {
      const joined = await api('chatJoin', { link: text, name });
      K.firstWorkspace?.();
      finish({ ...joined, name: preview.workspace.name });
    } catch (err) {
      busy = false;
      setBusy(scrim, false);
      const code = err && err.code;
      if (code === 'invite_gone' || (code === 'not_found' && err.scope !== 'conversation')) showError(body, '', t('chat.errors.inviteGone'));
      else showError(body, fieldOf(err, ['name']), K.errorText(err));
    }
  };

  const joined = await dialog({
    title: t('chat.join.title'),
    buttons: [cancelButton(), { label: t('chat.join.check'), value: (scrim) => (submit(scrim), KEEP_OPEN) }],
    render(body, done) {
      finish = done;
      chatDialog(body);
      body.innerHTML = `<div class="form ch-form">
        <label>${esc(t('chat.join.link'))}<input type="text" name="link" autocomplete="off" spellcheck="false" placeholder="https://…/join#w=…" value="${esc(link)}"/></label>
        <p class="error" data-error="link" hidden></p>
        <p class="ch-checking" data-checking hidden><span class="spinner"></span><span>${esc(t('chat.join.checking'))}</span></p>
        <div class="ch-join-preview" data-preview hidden></div>
        <p class="note ch-other" data-other hidden></p>
        <label data-name hidden>${esc(t('chat.make.yourName'))}<input type="text" name="name" autocomplete="off" spellcheck="false" maxlength="200" value="${esc(yourName)}"/></label>
        <p class="error" data-error="name" hidden></p>
        <div data-host hidden>${K.hostNote()}</div>
        <p class="error" data-error="" hidden></p>
      </div>`;
      const scrim = body.closest('.scrim');
      const field = body.querySelector('[name="link"]');
      field.addEventListener('input', () => {
        if (preview || elsewhere || checked) reset(scrim);
      });
      // A pasted link is checked at once.
      field.addEventListener('paste', () => setTimeout(() => !busy && field.value.trim() && check(scrim), 0));
      enterSubmits(body, submit);
      if (link) setTimeout(() => check(scrim), 0);
    }
  });
  if (joined && joined.ws) {
    if (joined.already) toast(t('chat.join.already', { name: K.summary(joined.ws)?.name || joined.name || '' }));
    await K.selectWorkspace(joined.ws);
  }
  return joined || null;
}

// The host of the link in text, for the other-server note; a link pasted without https:// has one too (contract 3.2).
const hostOf = (text) => {
  const s = String(text || '');
  const m = s.match(/https?:\/\/\S+/) || s.match(/[A-Za-z0-9.-]+(?::[0-9]+)?\/\S*join#\S*/);
  if (!m) return '';
  try {
    return new URL(/^https?:\/\//.test(m[0]) ? m[0] : `https://${m[0]}`).host;
  } catch (_) {
    return '';
  }
};

// ---------- invitations (desktop-ui 6.3) ----------

// A channel's name from the rooms the person is in or the workspace's channel list; '' when neither has it.
const channelName = (id) => K.CH.rooms.get(id)?.name || (K.CH.view?.channels || []).find((c) => c.id === id)?.name || '';

// The open invitations as list rows, with Withdraw. into: the <ul>; ws: the workspace they belong to; onWithdrawn(id)
// after one is withdrawn.
async function fillInvites(into, ws, { onWithdrawn = null } = {}) {
  into.setAttribute('aria-busy', 'true');
  into.innerHTML = '<li class="ch-invites-wait"><span class="spinner"></span></li>';
  let list;
  try {
    list = (await api('chatInvites', ws)).invites || [];
  } catch (err) {
    into.removeAttribute('aria-busy');
    into.innerHTML = `<li class="error">${esc(K.errorText(err))}</li>`;
    return;
  }
  into.removeAttribute('aria-busy');
  if (!list.length) {
    into.innerHTML = `<li class="ch-invites-none">${esc(t('chat.invite.none'))}</li>`;
    return;
  }
  list.sort((a, b) => b.createdAt - a.createdAt);
  into.innerHTML = list
    .map(
      (i) => `<li class="ch-invite" data-invite="${esc(i.id)}">
        <span class="ch-invite-text"><span class="ch-invite-role">${esc(roleText(i.role))}</span><span class="ch-invite-meta">${esc(
          [inviteRowChannels((i.channels || []).map(channelName).filter(Boolean).sort(collator().compare), i.channelCount, t), t('chat.invite.until', { date: dateTime(i.expiresAt) }), t('chat.invite.by', { name: nameOf(i.issuer) })].join(' · ')
        )}</span></span>
        <button type="button" class="link-btn danger" data-withdraw="${esc(i.id)}" data-busy-off>${esc(t('chat.invite.withdraw'))}</button>
      </li>`
    )
    .join('');
  for (const b of into.querySelectorAll('[data-withdraw]')) {
    b.addEventListener('click', async () => {
      b.disabled = true;
      try {
        await api('chatWithdrawInvite', ws, b.dataset.withdraw);
        b.closest('li').remove();
        if (!into.querySelector('.ch-invite')) into.innerHTML = `<li class="ch-invites-none">${esc(t('chat.invite.none'))}</li>`;
        if (onWithdrawn) onWithdrawn(b.dataset.withdraw);
      } catch (err) {
        b.disabled = false;
        toast(K.errorText(err), 5000);
      }
    });
  }
}

export async function invitePeople() {
  const ws = K.CH.ws;
  if (!ws || !isAdmin()) return null;
  const managed = [...K.CH.rooms.values()]
    .filter((r) => r.kind === 'channel' && !r.archived && r.role === 'manager')
    .sort((a, b) => collator().compare(a.name || '', b.name || ''));
  let role = 'member';
  let link = null;
  let inviteId = null;
  // The link shows only this once. Until it is copied or withdrawn, Copy link is the filled button and closing the
  // dialog asks first; the invitation itself stays open on the server either way.
  let kept = false;
  let busy = false;
  let finish = null;

  const picked = (body) => [...body.querySelectorAll('input[name="channel"]:checked')].map((x) => x.value);
  // A guest needs a channel, and an invitation holds 20 at most (contract 3.16). With no channel to pick, Guest says
  // why and offers New channel instead.
  const update = (scrim) => {
    const body = scrim.querySelector('.dialog-body');
    const n = picked(body).length;
    const needs = role === 'guest' && n === 0;
    body.querySelector('[data-guest-need]').hidden = !needs || !managed.length;
    if (!managed.length) {
      body.querySelector('[data-none-member]').hidden = role === 'guest';
      body.querySelector('[data-none-guest]').hidden = role !== 'guest';
    }
    for (const box of body.querySelectorAll('input[name="channel"]')) box.disabled = !box.checked && n >= 20;
    const primary = scrim.querySelector('.buttons button:last-child');
    if (!link) primary.disabled = needs || busy;
  };

  // Copy link is filled until the link is kept; Done is filled after.
  const showKept = (scrim) => {
    const copy = scrim.querySelector('[data-copy]');
    copy.classList.toggle('primary', !kept);
    copy.classList.toggle('secondary', kept);
    scrim.querySelector('.dialog').classList.toggle('ch-quiet-close', !kept);
  };
  const keep = (scrim) => {
    if (!link || kept) return;
    kept = true;
    showKept(scrim);
  };
  // The link was withdrawn under Open invitations: it no longer works, so nothing here copies it.
  const withdrawn = (scrim, id) => {
    if (!link || id !== inviteId) return;
    const out = scrim.querySelector('[data-step="made"]');
    out.querySelector('[name="link"]').disabled = true;
    out.querySelector('[data-copy]').disabled = true;
    out.querySelector('[data-once]').hidden = true;
    out.querySelector('[data-ready]').textContent = t('chat.invite.withdrawn');
    out.classList.add('ch-invite-withdrawn');
    kept = true;
    showKept(scrim);
  };
  // While the link is being made the dialog stays: closed then, the one-time link would come back to nothing while the
  // invitation stays open on the server. Once it shows, closing asks first until it is copied.
  const leaveOk = () => {
    if (busy) return false;
    if (!link || kept) return true;
    return dialog({
      title: t('chat.invite.closeTitle'),
      body: `<p>${esc(t('chat.invite.closeBody'))}</p>`,
      buttons: [
        { label: t('chat.invite.goBack'), value: false },
        { label: t('common.actions.close'), value: true }
      ]
    });
  };

  const submit = async (scrim) => {
    if (busy) return;
    if (link) {
      if (await leaveOk()) finish(true);
      return;
    }
    const body = scrim.querySelector('.dialog-body');
    const channels = picked(body);
    if (role === 'guest' && !channels.length) return update(scrim);
    const days = Number(body.querySelector('[name="expires"]').value) || 1;
    clearErrors(body);
    busy = true;
    setBusy(scrim, true);
    try {
      const made = await api('chatCreateInvite', ws, { role, channels, expiresIn: days * 86400 });
      if (!scrim.isConnected) return;
      link = made.link;
      inviteId = made.invite && made.invite.id;
      body.querySelector('[data-step="make"]').hidden = true;
      const out = body.querySelector('[data-step="made"]');
      out.hidden = false;
      const field = out.querySelector('[name="link"]');
      field.value = link;
      const names = channels.map((id) => managed.find((r) => r.id === id)?.name || channelName(id)).filter(Boolean);
      out.querySelector('[data-ready]').textContent = inviteGrant((made.invite && made.invite.role) || role, names, dateTime(made.invite && made.invite.expiresAt), t);
      const [cancel, primary] = scrim.querySelectorAll('.buttons button');
      cancel.hidden = true;
      primary.textContent = t('chat.invite.done');
      showKept(scrim);
      field.focus();
      field.select();
      fillInvites(body.querySelector('.ch-invites'), ws, { onWithdrawn: (id) => withdrawn(scrim, id) });
    } catch (err) {
      showError(body, '', K.errorText(err));
    } finally {
      busy = false;
      if (scrim.isConnected) {
        setBusy(scrim, false);
        update(scrim);
      }
    }
  };

  return wsDialog({
    title: t('chat.invite.title', { workspace: wsName() }),
    buttons: [cancelButton(), { label: t('chat.invite.make'), value: (scrim) => (submit(scrim), KEEP_OPEN) }],
    beforeClose: () => leaveOk(),
    render(body, done) {
      finish = done;
      const channelRows = managed.length
        ? managed
            .map(
              (r) =>
                `<label class="ch-check-row"><input type="checkbox" name="channel" value="${esc(r.id)}"/><span class="ch-check-ic" aria-hidden="true">${channelIcon(r)}</span><span class="ch-check-label">${esc(r.name || '')}</span></label>`
            )
            .join('')
        : `<p class="field-help" data-none-member>${esc(t('chat.invite.channelsNone'))}</p>
           <div class="ch-invite-none" data-none-guest hidden><p class="field-help">${esc(t('chat.invite.guestNoChannels'))}</p>
             <div><button type="button" class="btn secondary sm" data-new-channel>${icons.plus}<span>${esc(t('chat.invite.newChannel'))}</span></button></div></div>`;
      const days = [1, 3, 7].map((d) => `<option value="${d}">${esc(t('chat.invite.days', { count: d }))}</option>`).join('');
      body.innerHTML = `<div class="form ch-form" data-step="make">
          <div class="ch-field"><span class="ch-label">${esc(t('chat.invite.role'))}</span>
            ${segmented({ name: 'role', label: t('chat.invite.role'), value: role, options: [{ value: 'member', label: t('chat.roles.member') }, { value: 'guest', label: t('chat.roles.guest') }] })}
            <span class="field-help" data-role-hint>${esc(t('chat.invite.memberHint'))}</span></div>
          <fieldset class="ch-field"><legend class="ch-label">${esc(t('chat.invite.channels'))}</legend>
            <div class="ch-checks">${channelRows}</div>
            <p class="field-help ch-warn" data-guest-need hidden>${esc(t('chat.invite.guestNeedsChannel'))}</p></fieldset>
          <label>${esc(t('chat.invite.expires'))}<select name="expires">${days}</select></label>
          <p class="error" data-error="" hidden></p>
        </div>
        <div class="form ch-form" data-step="made" hidden>
          <label>${esc(t('chat.join.link'))}<input type="text" name="link" class="sel ch-link-field" readonly spellcheck="false"/></label>
          <p class="field-help" data-ready></p>
          <div class="ch-invite-copy"><button type="button" class="btn primary sm" data-copy>${icons.copy}<span>${esc(t('chat.invite.copy'))}</span></button>
            <span class="field-help" data-once>${esc(t('chat.invite.once'))}</span></div>
        </div>
        <details class="ch-open-invites"><summary>${esc(t('chat.invite.open'))}</summary><ul class="ch-invites"></ul></details>`;
      const scrim = body.closest('.scrim');
      const seg = body.querySelector('.segmented');
      seg.addEventListener('click', (e) => {
        const b = e.target.closest('[data-role]');
        if (!b) return;
        role = b.dataset.role;
        setSegmented(seg, role);
        body.querySelector('[data-role-hint]').textContent = t(role === 'guest' ? 'chat.invite.guestHint' : 'chat.invite.memberHint');
        update(scrim);
      });
      body.addEventListener('change', () => update(scrim));
      body.querySelector('[data-new-channel]')?.addEventListener('click', () => {
        done(null);
        makeChannel();
      });
      body.querySelector('[data-copy]').addEventListener('click', () => {
        if (!link) return;
        navigator.clipboard.writeText(link).then(
          () => {
            toast(t('chat.invite.copied'));
            keep(scrim);
          },
          () => {}
        );
      });
      // Ctrl+C in the selected field copies it too.
      body.querySelector('[name="link"]').addEventListener('copy', () => keep(scrim));
      const open = body.querySelector('.ch-open-invites');
      open.addEventListener('toggle', () => {
        if (open.open && !open.dataset.loaded) {
          open.dataset.loaded = '1';
          fillInvites(open.querySelector('.ch-invites'), ws, { onWithdrawn: (id) => withdrawn(scrim, id) });
        }
      });
      update(scrim);
      setTimeout(() => seg.querySelector('[aria-selected="true"]')?.focus(), 0);
    }
  });
}

// ---------- channels (desktop-ui 6.4 to 6.9) ----------

// The name field of Make and Rename: # inside the field, saved as typed (contract 3.16).
const channelNameField = (value = '') => `<label>${esc(t('chat.channel.name'))}<span class="ch-hash-field"><span class="ch-hash" aria-hidden="true">#</span><input type="text" name="name" autocomplete="off" spellcheck="false" maxlength="200" value="${esc(value)}"/></span></label>
  <p class="error" data-error="name" hidden></p>`;

export async function makeChannel() {
  const ws = K.CH.ws;
  if (!ws || K.isGuest()) return null;
  let finish = null;
  let busy = false;
  const submit = async (scrim) => {
    if (busy) return;
    const body = scrim.querySelector('.dialog-body');
    const name = body.querySelector('[name="name"]').value.trim();
    const visibility = body.querySelector('[name="visibility"]:checked')?.value === 'private' ? 'private' : 'workspace';
    if (!nameOk(name)) return showError(body, 'name', t('chat.errors.invalidName'));
    clearErrors(body);
    busy = true;
    setBusy(scrim, true);
    try {
      const made = await api('chatCreateChannel', ws, { name, visibility });
      finish(made && made.channel);
    } catch (err) {
      busy = false;
      setBusy(scrim, false);
      showError(body, fieldOf(err, ['name']), K.errorText(err));
    }
  };
  const channel = await wsDialog({
    title: t('chat.channel.makeTitle'),
    buttons: [cancelButton(), { label: t('chat.channel.make'), value: (scrim) => (submit(scrim), KEEP_OPEN) }],
    render(body, done) {
      finish = done;
      body.innerHTML = `<div class="form ch-form">
        ${channelNameField()}
        <fieldset class="ch-field"><legend class="ch-label">${esc(t('chat.channel.who'))}</legend>
          <label class="ch-radio-row"><input type="radio" name="visibility" value="workspace" checked/><span class="ch-radio-text"><span class="ch-radio-label">${icons.hash}${esc(
            t('chat.channel.public', { workspace: wsName() })
          )}</span><span class="field-help">${esc(t('chat.channel.publicHint'))}</span></span></label>
          <label class="ch-radio-row"><input type="radio" name="visibility" value="private"/><span class="ch-radio-text"><span class="ch-radio-label">${icons.lock}${esc(
            t('chat.channel.private')
          )}</span><span class="field-help">${esc(t('chat.channel.privateHint'))}</span></span></label>
          <p class="field-help">${esc(t('chat.channel.fixed'))}</p>
        </fieldset>
        <p class="error" data-error="" hidden></p>
      </div>`;
      enterSubmits(body, submit);
    }
  });
  if (!channel || ws !== K.CH.ws) return null;
  if (await waitForRoom(channel.id)) {
    K.openRoom(channel.id);
    // A private channel has nobody in it yet: Add people comes right after (desktop-ui 6.4).
    if (channel.visibility === 'private') await channelMembers(K.CH.rooms.get(channel.id), { add: true });
  }
  return channel;
}

// Browse channels (desktop-ui 6.5): the workspace's channels with Join, and the archived ones the person was in.
export async function browseChannels() {
  const ws = K.CH.ws;
  if (!ws || K.isGuest()) return null;
  let query = '';
  let finish = null;
  // The channels whose Join is on its way: a redraw meanwhile keeps their button busy.
  const joining = new Set();
  const draw = (body) => {
    const list = (K.CH.view?.channels || []).slice().sort((a, b) => collator().compare(a.name, b.name));
    const q = fold(query.trim());
    const match = (c) => !q || fold(c.name).includes(q);
    const open = list.filter((c) => !c.archived && match(c));
    const archived = list.filter((c) => c.archived && c.joined && match(c));
    const row = (c) => {
      const joined = c.joined && K.CH.rooms.has(c.id);
      const meta = [t('chat.head.members', { count: c.members || 0 }), c.visibility === 'private' ? t('chat.head.private') : ''].filter(Boolean).join(' · ');
      const busy = joining.has(c.id) ? ' disabled aria-busy="true"' : '';
      const side = c.archived ? '' : joined ? `<span class="ch-pill">${esc(t('chat.channel.joined'))}</span>` : `<button type="button" class="btn secondary sm" data-join="${esc(c.id)}" data-busy-off${busy}>${esc(t('chat.channel.join'))}</button>`;
      return `<li class="ch-browse-row"><button type="button" class="ch-browse-open" data-open="${esc(c.id)}"><span class="ch-browse-ic" aria-hidden="true">${channelIcon(c)}</span><span class="ch-browse-text"><span class="ch-browse-name">${esc(
        c.name
      )}</span><span class="ch-browse-meta">${esc(meta)}</span></span></button>${side}</li>`;
    };
    const listEl = body.querySelector('[data-list]');
    listEl.innerHTML = open.length ? open.map(row).join('') : `<li class="ch-browse-none">${esc(t('chat.channel.noneFound'))}</li>`;
    const arch = body.querySelector('[data-archived]');
    arch.hidden = !archived.length;
    const wasOpen = arch.open;
    arch.querySelector('summary').textContent = t('chat.channel.archivedSection', { count: archived.length });
    arch.querySelector('ul').innerHTML = archived.map(row).join('');
    arch.open = wasOpen;
  };
  const opened = async (id) => {
    const c = (K.CH.view?.channels || []).find((x) => x.id === id);
    if (!c) return;
    if (K.CH.rooms.has(id)) {
      finish(true);
      K.openRoom(id);
    } else if (!c.archived) {
      finish(true);
      K.previewChannel(c);
    }
  };
  const join = async (btn, body) => {
    const id = btn.dataset.join;
    btn.disabled = true;
    btn.setAttribute('aria-busy', 'true');
    joining.add(id);
    try {
      await api('chatJoinChannel', ws, id);
      const there = await waitForRoom(id);
      joining.delete(id);
      if (there) {
        finish(true);
        K.openRoom(id);
      } else draw(body);
    } catch (err) {
      joining.delete(id);
      // The button on screen now, as a redraw meanwhile may have replaced the one clicked.
      const now = body.querySelector(`[data-join="${CSS.escape(id)}"]`);
      if (now) {
        now.disabled = false;
        now.removeAttribute('aria-busy');
      }
      showError(body, '', K.errorText(err));
    }
  };
  return wsDialog({
    title: t('chat.channel.browseTitle', { workspace: wsName() }),
    wide: true,
    quietClose: true,
    buttons: [closeButton()],
    redraw: (body) => draw(body),
    render(body, done) {
      finish = done;
      body.innerHTML = `<div class="ch-dlg-tools">
          <input type="search" class="ch-search" name="search" placeholder="${esc(t('chat.channel.search'))}" aria-label="${esc(t('chat.channel.search'))}" autocomplete="off" spellcheck="false"/>
          <button type="button" class="btn primary sm" data-make>${icons.plus}<span>${esc(t('chat.channel.makeTitle'))}</span></button>
        </div>
        <ul class="ch-browse" data-list></ul>
        <details class="ch-browse-archived" data-archived hidden><summary></summary><ul class="ch-browse"></ul></details>
        <p class="error" data-error="" hidden></p>`;
      draw(body);
      const search = body.querySelector('[name="search"]');
      search.addEventListener('input', () => {
        query = search.value;
        draw(body);
      });
      body.addEventListener('click', (e) => {
        const j = e.target.closest('[data-join]');
        if (j) return join(j, body);
        const o = e.target.closest('[data-open]');
        if (o) return opened(o.dataset.open);
        if (e.target.closest('[data-make]')) {
          done(true);
          makeChannel();
        }
      });
    }
  });
}

// A channel's members and roles (desktop-ui 6.6), or a group DM's people. add: open on the Add people picker.
// Agents (server/WORKSPACES.md "Agents") show with the Agent tag. A manager adds people and agents; an agent's sponsor
// adds it to a channel the workspace can see, and takes it out again, also without managing the channel.
export async function channelMembers(room, { add = false } = {}) {
  const ws = K.CH.ws;
  if (!ws || !room) return null;
  const channel = room.kind === 'channel';
  const manager = channel && room.role === 'manager' && !room.archived;
  // Someone who doesn't manage the channel adds only their own agents: the picker is Add agents, and its texts never
  // speak for the people (Android's chat_channel_add_agents).
  const agentsOnly = channel && !manager;
  const addLabel = () => t(agentsOnly ? 'chat.channel.addAgents' : 'chat.head.addPeople');
  // The agents the person may add here that aren't in the channel yet, by name; none before its members load. Into a
  // private channel only those whose sponsor is in it.
  const addableAgents = () => {
    if (!channel || !list || !agentsOn()) return [];
    const inside = new Set(list.map((m) => m.member));
    return activeMembers()
      .filter((m) => !inside.has(m.id) && canAddAgent(m, room, K.me(), inside))
      .sort(byName);
  };
  const canAdd = () => manager || addableAgents().length > 0;
  let list = null;
  let query = '';
  let picking = false;
  let adding = false;
  let finish = null;
  let body = null;
  const title = channel ? t('chat.channel.membersTitle', { name: room.name || '' }) : K.roomName(room);

  const sortByName = (ids) => ids.sort((a, b) => collator().compare(nameOf(a), nameOf(b)));
  const load = async () => {
    const ul = body.querySelector('[data-people]');
    ul.setAttribute('aria-busy', 'true');
    ul.innerHTML = '<li class="ch-invites-wait"><span class="spinner"></span></li>';
    try {
      list = ((await api('chatRoomMembers', ws, room.id)).members || []).slice();
    } catch (err) {
      ul.removeAttribute('aria-busy');
      ul.innerHTML = `<li class="error">${esc(K.errorText(err))}</li>`;
      return;
    }
    if (!body.isConnected) return;
    draw();
  };
  const draw = () => {
    if (!body || !body.isConnected) return;
    body.querySelector('[data-view="list"]').hidden = picking;
    body.querySelector('[data-view="pick"]').hidden = !picking;
    // The picker has its own Back and Add; Leave channel waits for the list.
    const leaveButton = body.closest('.dialog')?.querySelector('.buttons button.left');
    if (leaveButton) leaveButton.hidden = picking;
    if (picking) return drawPicker();
    const ul = body.querySelector('[data-people]');
    ul.removeAttribute('aria-busy');
    if (!list) return;
    const addButton = body.querySelector('[data-add]');
    if (addButton) addButton.hidden = !canAdd();
    const q = fold(query.trim());
    const byId = new Map(list.map((m) => [m.member, m]));
    const ids = sortByName(list.map((m) => m.member)).filter((id) => !q || fold(nameOf(id)).includes(q));
    ul.innerHTML = ids
      .map((id) => {
        const m = byId.get(id);
        const member = K.CH.members.get(id);
        const mine = id === K.me();
        const agent = isAgent(member);
        const label = mine ? t('chat.members.you', { name: nameOf(id) }) : nameOf(id);
        const tags = [
          agent ? agentTag() : member && member.role === 'guest' ? `<span class="ch-tag">${esc(t('chat.roles.guest'))}</span>` : '',
          m.role === 'manager' && channel ? `<span class="ch-pill">${esc(t('chat.roles.manager'))}</span>` : ''
        ].join('');
        // A manager has a menu for everyone else; an agent's sponsor one for their agent, with Remove only. An archived
        // channel keeps only an agent's Remove, for its managers and its sponsor: the agent's key reads the history the
        // channel keeps until it leaves (server/WORKSPACES.md "Channels").
        const menu = !mine && (manager || (agent && canRemoveAgent(member, room, K.me())));
        const more = menu
          ? `<button type="button" class="icon-btn xs" data-person="${esc(id)}" aria-haspopup="menu" aria-label="${esc(t('chat.members.more', { name: nameOf(id) }))}" title="${esc(t('chat.members.more', { name: nameOf(id) }))}">${icons.more}</button>`
          : '';
        // An agent says under its name who made it and whom it answers.
        return `<li class="ch-person${agent ? ' ch-agent-row' : ''}">${K.memberAvatar(id, 'ch-av-24')}${personName(member, label)}${tags}${more}</li>`;
      })
      .join('');
    if (!ids.length) ul.innerHTML = `<li class="ch-browse-none">${esc(t('chat.new.none'))}</li>`;
  };
  // Who Add people offers: the people who aren't in the channel, for a manager, then the agents the person may add.
  const candidates = () => {
    const inside = new Set((list || []).map((m) => m.member));
    const people = manager ? activeMembers().filter((m) => !inside.has(m.id) && isPerson(m)).sort(byName) : [];
    return { people, agents: addableAgents() };
  };
  const chosen = new Set();
  const drawPicker = () => {
    const ul = body.querySelector('[data-pick]');
    const query = body.querySelector('[name="pick-search"]').value.trim();
    const q = fold(query);
    const all = candidates();
    // Someone picked who can't be added any more (an agent whose sponsor left a private channel) is no longer picked.
    const offered = new Set([...all.people, ...all.agents].map((m) => m.id));
    for (const id of [...chosen]) if (!offered.has(id)) chosen.delete(id);
    const fits = (m) => !q || fold(displayName(m, t)).includes(q);
    const people = all.people.filter(fits);
    const agents = all.agents.filter(fits);
    const count = people.length + agents.length;
    // Nobody to add: say whether the workspace has nobody else or everyone is in already, with Invite people. Add agents
    // says only that the person's agents are in already.
    const empty = addPeopleEmpty({
      rows: count,
      candidates: all.people.length + all.agents.length,
      others: activeMembers().filter((m) => m.id !== K.me() && isPerson(m)).length,
      query,
      agentsOnly
    });
    const invite = isAdmin() && !agentsOnly ? `<button type="button" class="btn secondary sm" data-invite>${icons.userPlus}<span>${esc(t('chat.workspace.invite'))}</span></button>` : '';
    const emptyText = () =>
      empty === 'agents'
        ? t('chat.agents.allIn', { name: room.name || '' })
        : empty === 'everyone'
          ? t('chat.channel.addEveryone', { workspace: wsName(), name: room.name || '' })
          : t('chat.new.nobody', { workspace: wsName() });
    const personRow = (m) => {
      const guest = m.role === 'guest';
      const locked = guest && !isAdmin();
      return `<li><label class="ch-check-row${locked ? ' is-disabled' : ''}"><input type="checkbox" name="pick" value="${esc(m.id)}"${chosen.has(m.id) ? ' checked' : ''}${locked ? ' disabled' : ''}/>${K.memberAvatar(
        m.id,
        'ch-av-24'
      )}<span class="ch-check-label">${esc(displayName(m, t))}</span>${guest ? `<span class="ch-tag">${esc(t('chat.roles.guest'))}</span>` : ''}${
        locked ? `<span class="field-help ch-check-note">${esc(t('chat.channel.addGuestNeedsAdmin'))}</span>` : ''
      }</label></li>`;
    };
    // An agent with who it answers under its name ("Answers only Olga"). The Agents heading above says what it is.
    const agentRow = (m) => {
      const note = agentAnswersText(m, { members: K.CH.members, t, listFormat: listFormat() });
      return `<li data-kind="agent"><label class="ch-check-row ch-agent-pick"><input type="checkbox" name="pick" value="${esc(m.id)}"${chosen.has(m.id) ? ' checked' : ''}/>${K.memberAvatar(
        m.id,
        'ch-av-24'
      )}<span class="ch-agent-text"><span class="ch-check-label">${esc(displayName(m, t))}</span>${note ? `<span class="field-help ch-agent-note">${esc(note)}</span>` : ''}</span></label></li>`;
    };
    const group = (title) => `<li class="ch-group" role="presentation"><span>${esc(title)}</span></li>`;
    // A heading over each group only when both show. Under Agents, what adding one means for the channel's messages.
    const both = people.length > 0 && agents.length > 0;
    const html = [
      both ? group(t('chat.channel.peopleGroup')) : '',
      people.map(personRow).join(''),
      agents.length ? `${group(t('chat.roles.agents'))}<li class="field-help ch-agents-read" role="presentation">${esc(t('chat.host.agents'))}</li>` : '',
      agents.map(agentRow).join('')
    ].join('');
    ul.innerHTML = count
      ? html
      : empty === 'none'
        ? `<li class="ch-browse-none">${esc(t('chat.new.none'))}</li>`
        : `<li class="ch-browse-none ch-new-none" data-empty="${empty}"><span>${esc(emptyText())}</span>${invite}</li>`;
    body.querySelector('[data-add-go]').disabled = !chosen.size || adding;
  };
  const addChosen = async () => {
    const ids = [...chosen];
    if (!ids.length) return;
    const btn = body.querySelector('[data-add-go]');
    btn.disabled = true;
    btn.setAttribute('aria-busy', 'true');
    adding = true;
    const failed = [];
    let firstError = null;
    for (const id of ids) {
      try {
        await api('chatAddToChannel', ws, room.id, id);
        chosen.delete(id);
      } catch (err) {
        failed.push(nameOf(id));
        firstError = firstError || err;
      }
    }
    adding = false;
    btn.removeAttribute('aria-busy');
    if (!body.isConnected) return;
    if (failed.length) {
      const names = new Intl.ListFormat(getLocale(), { type: 'conjunction' }).format(failed);
      showError(body, 'pick', `${t('chat.channel.addFailed', { names })} ${K.errorText(firstError)}`);
      await load();
      picking = true;
      draw();
      return;
    }
    clearErrors(body);
    picking = false;
    await load();
  };
  const personMenu = (btn) => {
    const id = btn.dataset.person;
    const m = (list || []).find((x) => x.member === id);
    if (!m) return;
    const remove = { icon: 'leave', label: t('chat.channel.removeMember', { name: room.name || '' }), danger: true, action: () => removeOne(id) };
    // An agent is never a manager: only Remove.
    if (isAgent(K.CH.members.get(id))) return menuInDialog(btn, [remove]);
    const items = [
      m.role === 'manager'
        ? { icon: 'person', label: t('chat.channel.makeMember'), action: () => setRole(id, 'member') }
        : { icon: 'people', label: t('chat.channel.makeManager'), action: () => setRole(id, 'manager') },
      { separator: true },
      remove
    ];
    menuInDialog(btn, items);
  };
  // Manager and member apply at once; the toast's Undo sets the role from before back, without a toast of its own.
  const setRole = async (id, role, undoable = true) => {
    const before = (list || []).find((x) => x.member === id)?.role;
    try {
      await api('chatSetChannelRole', ws, room.id, id, role);
    } catch (err) {
      // Undo can come after the dialog closed.
      if (body.isConnected) showError(body, '', K.errorText(err));
      else toast(K.errorText(err), 5000);
      return;
    }
    if (body.isConnected) await load();
    if (undoable && before && before !== role) {
      toast(t(role === 'manager' ? 'chat.channel.nowManager' : 'chat.channel.nowMember', { name: nameOf(id) }), {
        action: { label: t('common.actions.undo'), run: () => setRole(id, before, false) }
      });
    }
  };
  const removeOne = async (id) => {
    const ok = await confirmDialog(
      t('chat.channel.removeTitle', { member: nameOf(id), name: room.name || '' }),
      t('chat.channel.removeBody', { member: nameOf(id), name: room.name || '' }),
      t('chat.members.removeConfirm'),
      true
    );
    if (!ok) return;
    try {
      await api('chatRemoveFromChannel', ws, room.id, id);
      await load();
    } catch (err) {
      showError(body, '', K.errorText(err));
    }
  };

  const buttons = [closeButton()];
  // Leave channel on the left, for a channel (desktop-ui 6.6).
  if (channel) buttons.unshift({ get label() { return t('chat.head.leave'); }, value: 'leave', danger: true, left: true });
  const result = await wsDialog({
    title,
    quietClose: true,
    buttons,
    // The names, and who can be added, come from the directory; before the channel's members load there is nothing
    // to draw yet.
    redraw: () => {
      if (list) draw();
    },
    render(b, done) {
      body = b;
      finish = done;
      body.innerHTML = `<div data-view="list">
          <div class="ch-dlg-tools">
            <input type="search" class="ch-search" name="search" placeholder="${esc(t('chat.members.search'))}" aria-label="${esc(t('chat.members.search'))}" autocomplete="off" spellcheck="false"/>
            ${
              channel && !room.archived
                ? `<button type="button" class="btn secondary sm" data-add${manager ? '' : ' hidden'}>${icons.userPlus}<span>${esc(addLabel())}</span></button>`
                : ''
            }
          </div>
          <ul class="ch-people" data-people></ul>
        </div>
        <div data-view="pick" hidden>
          <p class="ch-sub">${esc(t(agentsOnly ? 'chat.channel.addAgentsTitle' : 'chat.channel.addTitle', { name: room.name || '' }))}</p>
          <div class="ch-dlg-tools"><input type="search" class="ch-search" name="pick-search" placeholder="${esc(t('chat.members.search'))}" aria-label="${esc(t('chat.members.search'))}" autocomplete="off" spellcheck="false"/></div>
          <ul class="ch-people ch-pick" data-pick></ul>
          <p class="error" data-error="pick" hidden></p>
          <div class="ch-dlg-foot"><button type="button" class="btn secondary sm" data-add-back>${esc(t('common.actions.back'))}</button><button type="button" class="btn primary sm" data-add-go disabled>${esc(t('common.actions.add'))}</button></div>
        </div>
        <p class="error" data-error="" hidden></p>`;
      body.querySelector('[name="search"]').addEventListener('input', (e) => {
        query = e.target.value;
        draw();
      });
      body.querySelector('[name="pick-search"]').addEventListener('input', () => drawPicker());
      body.addEventListener('change', (e) => {
        if (e.target.name !== 'pick') return;
        if (e.target.checked) chosen.add(e.target.value);
        else chosen.delete(e.target.value);
        body.querySelector('[data-add-go]').disabled = !chosen.size || adding;
      });
      body.addEventListener('click', (e) => {
        const person = e.target.closest('[data-person]');
        if (person) return personMenu(person);
        if (e.target.closest('[data-add]')) {
          picking = true;
          clearErrors(body);
          draw();
          body.querySelector('[name="pick-search"]').focus();
          return;
        }
        if (e.target.closest('[data-add-back]')) {
          picking = false;
          clearErrors(body);
          draw();
          return;
        }
        if (e.target.closest('[data-add-go]')) addChosen();
        if (e.target.closest('[data-invite]')) {
          done(null);
          invitePeople();
        }
      });
      // A sponsor who doesn't manage the channel opens on Add people for their own agents.
      picking = Boolean(add && (manager || sponsorsHere(room)));
      load().then(() => {
        if (picking) body.querySelector('[name="pick-search"]')?.focus();
      });
    }
  });
  if (result === 'leave') await leaveChannel(room);
  return result;
}

export async function renameChannel(room) {
  const ws = K.CH.ws;
  if (!ws || !room || room.kind !== 'channel') return null;
  let finish = null;
  let busy = false;
  const submit = async (scrim) => {
    if (busy) return;
    const body = scrim.querySelector('.dialog-body');
    const name = body.querySelector('[name="name"]').value.trim();
    if (!nameOk(name)) return showError(body, 'name', t('chat.errors.invalidName'));
    if (name === room.name) return finish(null);
    clearErrors(body);
    busy = true;
    setBusy(scrim, true);
    try {
      const done = await api('chatRenameChannel', ws, room.id, name);
      finish(done && done.channel);
    } catch (err) {
      busy = false;
      setBusy(scrim, false);
      showError(body, fieldOf(err, ['name']), K.errorText(err));
    }
  };
  return wsDialog({
    title: t('chat.channel.renameTitle', { name: room.name || '' }),
    buttons: [cancelButton(), { get label() { return t('common.actions.save'); }, value: (scrim) => (submit(scrim), KEEP_OPEN) }],
    render(body, done) {
      finish = done;
      body.innerHTML = `<div class="form ch-form">${channelNameField(room.name || '')}<p class="error" data-error="" hidden></p></div>`;
      enterSubmits(body, submit);
      setTimeout(() => body.querySelector('[name="name"]')?.select(), 0);
    }
  });
}

// Archive (desktop-ui 6.8): the feed then brings the archived room, and its bar replaces the composer.
export async function archiveChannel(room) {
  const ws = K.CH.ws;
  if (!ws || !room) return false;
  const ok = await confirmDialog(t('chat.channel.archiveTitle', { name: room.name || '' }), t('chat.channel.archiveBody'), t('chat.channel.archive'), true);
  if (!ok || ws !== K.CH.ws) return false;
  try {
    await api('chatArchiveChannel', ws, room.id);
    return true;
  } catch (err) {
    toast(K.errorText(err), 5000);
    return false;
  }
}

// A channel's members ([{ member, role }]), or null when they don't load; the server's answer to leaving then decides.
async function roomMembersOrNull(ws, id) {
  try {
    const r = await api('chatRoomMembers', ws, id);
    return (r && r.members) || [];
  } catch {
    return null;
  }
}

// Who can take a channel over, from its members.
const successorsFrom = (roomMembers) => successors((roomMembers || []).map((m) => m.member), K.CH.members, K.me(), collator(), t);

// What leaving room says about the person's agents among its members (roomMembers), or null: leaving a private
// channel takes them out of it too.
const leavingAgentsLine = (room, roomMembers) =>
  leavingAgentsText(agentsLeavingWith(room, roomMembers, K.CH.members, K.me(), collator(), t), { t, listFormat: listFormat() });

// A successor picker: a search field above more than six people, then a radio row per person with none checked, so
// nobody gets a channel the person didn't choose. group names the radios, so a dialog can hold one per channel.
function successorPicker(people, group, label) {
  const search =
    people.length > SUCCESSOR_SEARCH_FROM
      ? `<input type="search" class="ch-search ch-successor-search" name="${esc(group)}-search" placeholder="${esc(t('chat.members.search'))}" aria-label="${esc(t('chat.members.search'))}" autocomplete="off" spellcheck="false"/>`
      : '';
  const rows = people
    .map(
      (id) =>
        `<label class="ch-radio-row ch-person-pick" data-name="${esc(fold(nameOf(id)))}"><input type="radio" name="${esc(group)}" value="${esc(id)}"/>${K.memberAvatar(id, 'ch-av-24')}<span class="ch-check-label">${esc(nameOf(id))}</span></label>`
    )
    .join('');
  return `${search}<div class="ch-successors" role="radiogroup" aria-label="${esc(label)}">${rows}<p class="field-help ch-successors-none"${people.length ? ' hidden' : ''}>${esc(t('chat.new.none'))}</p></div>`;
}

// Shows the rows of a picker whose names hold what its search field has.
function filterPicker(field) {
  const box = field.nextElementSibling;
  if (!box) return;
  const q = fold(field.value.trim());
  let shown = 0;
  for (const row of box.querySelectorAll('.ch-person-pick')) {
    row.hidden = Boolean(q) && !row.dataset.name.includes(q);
    if (!row.hidden) shown++;
  }
  box.querySelector('.ch-successors-none').hidden = shown > 0;
}

// Filters each picker's rows in body as its search field is typed in.
function filterPickers(body) {
  body.addEventListener('input', (e) => {
    const field = e.target.closest('.ch-successor-search');
    if (field) filterPicker(field);
  });
}

// Draws box again from html, which holds a successor picker; the person picked stays while they can still take the
// channel over. A search field that was there stays where it is, with its text and the focus, also when fewer people
// come back than it shows for: only what is around it is drawn again.
function redrawPicker(box, html) {
  const picked = box.querySelector('input[type="radio"]:checked')?.value;
  const search = box.querySelector('.ch-successor-search');
  if (search) {
    const fresh = document.createElement('template');
    fresh.innerHTML = html;
    fresh.content.querySelector('.ch-successor-search')?.remove();
    // The search field sits right before the rows.
    const nodes = [...fresh.content.childNodes];
    const rows = Math.max(0, nodes.findIndex((n) => n.classList?.contains('ch-successors')));
    for (const n of [...box.childNodes]) if (n !== search) n.remove();
    search.before(...nodes.slice(0, rows));
    search.after(...nodes.slice(rows));
  } else box.innerHTML = html;
  const radio = [...box.querySelectorAll('input[type="radio"]')].find((r) => r.value === picked);
  if (radio) radio.checked = true;
  if (search) filterPicker(search);
}

// Leave a channel (desktop-ui 6.9). The only manager of a channel with others in it picks a successor at once,
// without a confirmation first; anyone else is asked. When the members don't load, the server's last_manager decides.
// Leaving a private channel takes the person's agents out of it too, and both dialogs name them; the channel's members
// load for that only when the directory holds an agent of theirs.
export async function leaveChannel(room) {
  const ws = K.CH.ws;
  if (!ws || !room) return false;
  const managed = sharedManaged([room]).length > 0;
  let inside = null;
  if (managed || mayTakeAgents(room, K.CH.members, K.me())) {
    inside = await roomMembersOrNull(ws, room.id);
    if (ws !== K.CH.ws) return false;
    if (managed && inside && soleManager(inside, K.me())) {
      K.expectLeave(room.id);
      return chooseSuccessor(room, inside);
    }
  }
  const body = room.members <= 1 ? t('chat.channel.leaveBodyLast', { name: room.name || '' }) : room.visibility === 'private' ? t('chat.channel.leaveBodyPrivate') : t('chat.channel.leaveBodyPublic');
  const agents = leavingAgentsLine(room, inside);
  const ok = await confirmDialog(t('chat.channel.leaveTitle', { name: room.name || '' }), agents ? [body, agents] : body, t('chat.channel.leave'), true);
  if (!ok || ws !== K.CH.ws) return false;
  K.expectLeave(room.id);
  try {
    await api('chatLeaveChannel', ws, room.id, null);
    K.afterLeave(room.id);
    return true;
  } catch (err) {
    if (err && err.code === 'last_manager') return chooseSuccessor(room);
    K.cancelLeave(room.id);
    toast(K.errorText(err), 5000);
    return false;
  }
}

// The successor question. inside: the channel's members ([{ member, role }]), when already loaded; else they load
// here. Who of them can take it over comes from the directory, so the picker draws again when that changes.
async function chooseSuccessor(room, inside = null) {
  const ws = K.CH.ws;
  let finish = null;
  let busy = false;
  const label = t('chat.channel.successorTitle', { name: room.name || '' });
  const primary = (scrim) => scrim?.querySelector('.buttons button:last-child');
  const pickOf = (body) => body.querySelector('[name="successor"]:checked');
  const fill = (body) => {
    const box = body.querySelector('[data-picker]');
    box.removeAttribute('aria-busy');
    box.className = 'ch-picker';
    redrawPicker(box, successorPicker(successorsFrom(inside), 'successor', label));
    const agents = body.querySelector('[data-agents]');
    const line = leavingAgentsLine(room, inside);
    agents.textContent = line || '';
    agents.hidden = !line;
    // The person picked may have gone with the directory.
    if (!busy) primary(body.closest('.scrim')).disabled = !pickOf(body);
  };
  const submit = async (scrim) => {
    if (busy) return;
    const body = scrim.querySelector('.dialog-body');
    const pick = pickOf(body);
    if (!pick) return;
    clearErrors(body);
    busy = true;
    setBusy(scrim, true);
    try {
      await api('chatLeaveChannel', ws, room.id, pick.value);
      finish(true);
    } catch (err) {
      busy = false;
      setBusy(scrim, false);
      showError(body, '', K.errorText(err));
    }
  };
  const done = await wsDialog({
    title: label,
    buttons: [cancelButton(), { label: t('chat.channel.successorSubmit'), value: (scrim) => (submit(scrim), KEEP_OPEN), danger: true }],
    redraw: (body) => {
      if (inside) fill(body);
    },
    render(body, close) {
      finish = close;
      const scrim = body.closest('.scrim');
      // Off until someone is picked.
      primary(scrim).disabled = true;
      body.addEventListener('change', () => {
        if (!busy) primary(scrim).disabled = !pickOf(body);
      });
      filterPickers(body);
      body.innerHTML = `<p>${esc(t('chat.channel.successorBody'))}</p><p data-agents hidden></p><div class="ch-picker ch-successors" data-picker aria-busy="true"><span class="spinner"></span></div><p class="error" data-error="" hidden></p>`;
      if (inside) return fill(body);
      api('chatRoomMembers', ws, room.id)
        .then((r) => {
          inside = (r && r.members) || [];
          fill(body);
        })
        .catch((err) => {
          inside = [];
          fill(body);
          showError(body, '', K.errorText(err));
        });
    }
  });
  if (done) {
    K.afterLeave(room.id);
    return true;
  }
  K.cancelLeave(room.id);
  return false;
}

// ---------- the workspace: leave, delete, name, members, settings (desktop-ui 6.10, 6.15 to 6.17) ----------

// Whether you are the workspace's only owner, as far as the directory knows.
const isOnlyOwner = () => onlyOwner(K.myRole(), K.me(), K.CH.members, K.CH.view?.membersMore);

// Whether the directory has loaded: one that hasn't is empty, as a loaded one holds you.
const directoryKnown = () => K.CH.members.size > 0;

// Whether nobody else is in the workspace, as far as the directory knows. An empty one says nothing, so Delete isn't
// offered and the server's answer to leaving decides.
// Agents don't count: deleting a workspace removes them too (server/WORKSPACES.md "Agents").
const nobodyElse = () => directoryKnown() && activeMembers().filter(isPerson).length <= 1;

// The channels you are the only manager of while others are in them, each with its members and who of them can take
// it over ({ id, name, room, inside, people }), by name; null when a channel's members don't load.
async function soleManaged(ws) {
  const rooms = sharedManaged(K.CH.rooms.values());
  const loaded = await Promise.all(rooms.map((r) => roomMembersOrNull(ws, r.id)));
  if (loaded.some((m) => m === null)) return null;
  return rooms
    .map((r, i) => ({ r, inside: loaded[i] }))
    .filter(({ inside }) => soleManager(inside, K.me()))
    .map(({ r, inside }) => ({ id: r.id, name: r.name || '', room: r, inside, people: successorsFrom(inside) }))
    .sort((a, b) => collator().compare(a.name, b.name));
}

// Leave a workspace (desktop-ui 6.10). What the app knows decides first, before any confirmation: the only owner is
// told to make someone else an owner (or offered Delete with nobody else in it); the only manager of channels with
// others in them picks a successor for each in one dialog, whose button hands them over and leaves. Anyone else
// confirms. The server's last_owner and last_manager lead to the same dialogs when the app couldn't tell.
export async function leaveWorkspace() {
  const ws = K.CH.ws;
  const from = { ws, generation: K.CH.generation };
  if (!ws) return false;
  const name = wsName();
  if (isOnlyOwner()) return lastOwner();
  // An owner with a directory that hasn't loaded may be the only owner, which the server checks before the channels:
  // handing channels over first could end in last_owner, so its answer decides.
  const unknown = K.myRole() === 'owner' && !directoryKnown();
  const mine = unknown ? [] : await soleManaged(ws);
  if (ws !== K.CH.ws) return false;
  if (mine && mine.length) return managersFirst(mine);
  const ok = await confirmDialog(t('chat.leave.title', { workspace: name }), t('chat.leave.body'), t('chat.leave.submit'), true);
  if (!ok || ws !== K.CH.ws) return false;
  K.expectGone(ws);
  try {
    await api('chatLeaveWorkspace', ws);
    await K.refreshState();
    return true;
  } catch (err) {
    K.cancelGone(ws);
    // Their dialogs read the workspace on screen: a late answer for one that went from the screen opens neither.
    const moved = () => from.ws !== K.CH.ws || from.generation !== K.CH.generation;
    if (err && err.code === 'last_manager') {
      if (moved()) return false;
      const named = await namedChannels(ws, err.channels || []);
      return moved() ? false : managersFirst(named);
    }
    if (err && err.code === 'last_owner') return moved() ? false : lastOwner();
    toast(K.errorText(err), 5000);
    return false;
  }
}

// The channels a 409 last_manager named, as managersFirst takes them; their people load here.
async function namedChannels(ws, ids) {
  const rooms = [...new Set(ids)].map((id) => K.CH.rooms.get(id) || (K.CH.view?.channels || []).find((c) => c.id === id)).filter(Boolean);
  const loaded = await Promise.all(rooms.map((r) => roomMembersOrNull(ws, r.id)));
  return rooms.map((r, i) => ({ id: r.id, name: r.name || '', room: r, inside: loaded[i] || [], people: successorsFrom(loaded[i] || []) }));
}

// Leaving as the only manager of channels: a successor picker for each, then one button that makes the picks
// managers and leaves. A last_manager naming channels this dialog didn't hold opens it again with those.
async function managersFirst(channels) {
  const ws = K.CH.ws;
  const generation = K.CH.generation;
  let finish = null;
  let busy = false;
  const group = (c) => `successor-${c.id}`;
  const picks = (body) => Object.fromEntries(channels.map((c) => [c.id, body.querySelector(`[name="${group(c)}"]:checked`)?.value]));
  const primary = (scrim) => scrim?.querySelector('.buttons button:last-child');
  const section = (c) =>
    `<h3 class="ch-handover-name"><span class="ch-browse-ic" aria-hidden="true">${channelIcon(c.room)}</span><span>${esc(c.name)}</span></h3>${successorPicker(
      c.people,
      group(c),
      t('chat.channel.successorTitle', { name: c.name })
    )}`;
  let again = null;
  const submit = async (scrim) => {
    if (busy) return;
    const body = scrim.querySelector('.dialog-body');
    const chosen = picks(body);
    if (!handOverReady(channels, chosen)) return;
    clearErrors(body);
    busy = true;
    setBusy(scrim, true);
    try {
      for (const c of channels) await api('chatSetChannelRole', ws, c.id, chosen[c.id], 'manager');
      K.expectGone(ws);
      try {
        await api('chatLeaveWorkspace', ws);
      } catch (err) {
        K.cancelGone(ws);
        throw err;
      }
      finish(true);
    } catch (err) {
      busy = false;
      setBusy(scrim, false);
      if (err && err.code === 'last_manager') {
        again = err.channels || [];
        return finish(null);
      }
      showError(body, '', K.errorText(err));
    }
  };
  const done = await wsDialog({
    title: t('chat.leave.title', { workspace: wsName() }),
    buttons: [cancelButton(), { label: t('chat.channel.successorSubmit'), value: (scrim) => (submit(scrim), KEEP_OPEN), danger: true }],
    // Who can take each channel over comes from the directory: from the channel's members again when it changes.
    redraw: (body) => {
      for (const c of channels) {
        c.people = successorsFrom(c.inside);
        const box = body.querySelector(`[data-channel="${c.id}"]`);
        if (box) redrawPicker(box, section(c));
      }
      if (!busy) primary(body.closest('.scrim')).disabled = !handOverReady(channels, picks(body));
    },
    render(body, close) {
      finish = close;
      const scrim = body.closest('.scrim');
      body.innerHTML = `<p>${esc(t('chat.leave.managerFirst'))}</p><p>${esc(t('chat.leave.body'))}</p>${channels
        .map((c) => `<section class="ch-handover" data-channel="${esc(c.id)}">${section(c)}</section>`)
        .join('')}<p class="error" data-error="" hidden></p>`;
      filterPickers(body);
      primary(scrim).disabled = true;
      body.addEventListener('change', () => {
        if (!busy) primary(scrim).disabled = !handOverReady(channels, picks(body));
      });
    }
  });
  if (done) {
    await K.refreshState();
    return true;
  }
  // The retry reads the workspace on screen, before and after its channels load: one that went from the screen gets
  // no dialog.
  const moved = () => ws !== K.CH.ws || generation !== K.CH.generation;
  if (!again || moved()) return false;
  const named = await namedChannels(ws, again);
  return moved() ? false : managersFirst(named);
}

// The only owner can't leave: Members, where someone else becomes an owner, or with nobody else left, deleting the
// workspace (contract 5.10).
async function lastOwner() {
  const alone = nobodyElse();
  const choice = await wsDialog({
    title: t('chat.workspace.leave'),
    buttons: alone
      ? [{ get label() { return t('chat.workspace.delete'); }, value: 'delete', danger: true, left: true }, { get label() { return t('common.actions.ok'); }, value: null }]
      : [closeButton(), { get label() { return t('chat.workspace.members'); }, value: 'members' }],
    render(body) {
      body.innerHTML = `<p>${esc(t('chat.leave.lastOwner'))}</p>${alone ? `<p>${esc(t('chat.leave.deleteInstead', { workspace: wsName() }))}</p>` : ''}`;
    }
  });
  if (choice === 'delete') return deleteWorkspace();
  if (choice === 'members') await workspaceMembers();
  return false;
}

// Delete a workspace (contract 2.14): an owner who is its only member.
export async function deleteWorkspace() {
  const ws = K.CH.ws;
  if (!ws || K.myRole() !== 'owner') return false;
  const name = wsName();
  const ok = await confirmDialog(t('chat.delete.title', { workspace: name }), t('chat.delete.body'), t('chat.delete.submit'), true);
  if (!ok || ws !== K.CH.ws) return false;
  K.expectGone(ws);
  try {
    await api('chatDeleteWorkspace', ws);
    toast(t('chat.delete.done', { workspace: name }));
    await K.refreshState();
    return true;
  } catch (err) {
    K.cancelGone(ws);
    toast(K.errorText(err), 5000);
    return false;
  }
}

// Your name in the workspace (desktop-ui 6.16 "You").
export async function changeName() {
  const ws = K.CH.ws;
  if (!ws) return null;
  const current = K.CH.view?.me?.name || nameOf(K.me());
  let finish = null;
  let busy = false;
  const submit = async (scrim) => {
    if (busy) return;
    const body = scrim.querySelector('.dialog-body');
    const name = body.querySelector('[name="name"]').value.trim();
    if (!nameOk(name)) return showError(body, 'name', t('chat.errors.invalidName'));
    if (name === current) return finish(null);
    clearErrors(body);
    busy = true;
    setBusy(scrim, true);
    try {
      const res = await api('chatSetMyName', ws, name);
      finish(res && res.me);
    } catch (err) {
      busy = false;
      setBusy(scrim, false);
      showError(body, fieldOf(err, ['name']), K.errorText(err));
    }
  };
  const me = await wsDialog({
    title: t('chat.name.title', { workspace: wsName() }),
    buttons: [cancelButton(), { get label() { return t('common.actions.save'); }, value: (scrim) => (submit(scrim), KEEP_OPEN) }],
    render(body, done) {
      finish = done;
      body.innerHTML = `<div class="form ch-form">
        <label>${esc(t('chat.make.yourName'))}<input type="text" name="name" autocomplete="off" spellcheck="false" maxlength="200" value="${esc(current)}"/>
          <span class="field-help">${esc(t('chat.name.hint'))}</span></label>
        <p class="error" data-error="name" hidden></p>
        <p class="error" data-error="" hidden></p>
      </div>`;
      enterSubmits(body, submit);
      setTimeout(() => body.querySelector('[name="name"]')?.select(), 0);
    }
  });
  if (me) await K.reload();
  return me;
}

// Block someone (desktop-ui 6.13, contract 3.12): what a block does in this workspace, that the conversations it
// closes stay closed, and where to undo it.
export async function blockMember(member) {
  const ws = K.CH.ws;
  const from = { ws, generation: K.CH.generation };
  if (!ws || !member || member === K.me()) return false;
  const name = nameOf(member);
  const ok = await confirmDialog(t('chat.block.title', { name }), t('chat.block.body', { name, workspace: wsName() }), t('chat.block.confirm'), true);
  if (!ok || ws !== K.CH.ws || from.generation !== K.CH.generation) return false;
  try {
    const res = await api('chatBlock', ws, member);
    K.setBlocks(res && res.blocks, from);
    toast(t('chat.block.done', { name }));
    return true;
  } catch (err) {
    toast(K.errorText(err), 5000);
    return false;
  }
}

// Unblock: no question; closed DMs stay closed.
export async function unblockMember(member) {
  const ws = K.CH.ws;
  const from = { ws, generation: K.CH.generation };
  if (!ws || !member) return false;
  const name = nameOf(member);
  try {
    const res = await api('chatUnblock', ws, member);
    K.setBlocks(res && res.blocks, from);
    toast(t('chat.block.unblocked', { name }));
    return true;
  } catch (err) {
    toast(K.errorText(err), 5000);
    return false;
  }
}

// Message from a member row: the open one-to-one DM, or a new one.
async function messageMember(member) {
  const mine = K.me();
  const open = [...K.CH.rooms.values()].find((r) => r.kind === 'dm' && !r.closedReason && sameSet(r.participants, [mine, member]));
  if (open) return K.openRoom(open.id);
  return startConversation([member]);
}

const sameSet = (a, b) => {
  const x = [...new Set(a || [])].sort();
  const y = [...new Set(b || [])].sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
};

// The open DM whose people are exactly me and others, or undefined.
const openDmFor = (others) => [...K.CH.rooms.values()].find((r) => r.kind === 'dm' && !r.closedReason && sameSet(r.participants, [K.me(), ...others]));

// Start a DM and open it (contract 3.12): 201 and 200 alike. Errors reach a toast here; New message shows its own.
async function startConversation(others) {
  const ws = K.CH.ws;
  try {
    const res = await api('chatStartDm', ws, others);
    if (ws !== K.CH.ws || !res || !res.room) return;
    K.CH.rooms.set(res.room.id, res.room);
    K.openRoom(res.room.id);
  } catch (err) {
    toast(K.errorText(err), 5000);
  }
}

const ROLES = ['owner', 'admin', 'member', 'guest'];

// Workspace members and roles (desktop-ui 6.15): grouped by role, with a menu per person.
export async function workspaceMembers() {
  const ws = K.CH.ws;
  if (!ws) return null;
  let query = '';
  let body = null;
  const myRole = K.myRole();
  const full = myRole !== 'guest';
  const draw = () => {
    if (!body || !body.isConnected) return;
    const q = fold(query.trim());
    const list = activeMembers()
      .filter((m) => !q || fold(displayName(m, t)).includes(q))
      .sort((a, b) => collator().compare(displayName(a, t), displayName(b, t)));
    // People by role, then the agents in a group of their own (server/WORKSPACES.md "Agents").
    const groups = [
      ...ROLES.map((role) => ({ role, people: list.filter((m) => m.role === role && !isAgent(m)) })),
      { role: 'agent', people: list.filter(isAgent) }
    ].filter((g) => g.people.length);
    const row = (m) => {
      const mine = m.id === K.me();
      const label = mine ? t('chat.members.you', { name: displayName(m, t) }) : displayName(m, t);
      const blocked = K.CH.blocks.has(m.id);
      const hasMenu = !mine && menuFor(m).length;
      // An agent says under its name who made it and whom it answers.
      const agent = isAgent(m);
      return `<li class="ch-person${agent ? ' ch-agent-row' : ''}"${agent ? ' data-kind="agent"' : ''}>${K.memberAvatar(m.id, 'ch-av-24')}${personName(m, label)}${
        blocked ? `<span class="ch-tag">${esc(t('chat.members.blocked'))}</span>` : ''
      }${
        hasMenu
          ? `<button type="button" class="icon-btn xs" data-person="${esc(m.id)}" aria-haspopup="menu" aria-label="${esc(t('chat.members.more', { name: displayName(m, t) }))}" title="${esc(
              t('chat.members.more', { name: displayName(m, t) })
            )}">${icons.more}</button>`
          : ''
      }</li>`;
    };
    const titles = { owner: 'chat.roles.owners', admin: 'chat.roles.admins', member: 'chat.roles.members', guest: 'chat.roles.guests', agent: 'chat.roles.agents' };
    body.querySelector('[data-people]').innerHTML = groups.length
      ? groups.map((g) => `<li class="ch-group" role="presentation"><span>${esc(t(titles[g.role]))}</span></li>${g.people.map(row).join('')}`).join('')
      : `<li class="ch-browse-none">${esc(t('chat.new.none'))}</li>`;
  };
  // What may be done to m (desktop-ui 6.15). An agent gets no Message, no Block and no role: its sponsor, an owner or
  // an admin changes or removes it, and its sponsor alone gives it a new key.
  const menuFor = (m) => {
    if (isAgent(m)) return full && agentsOn() ? agentMenu(agentFromDirectory(m), later) : [];
    const items = [];
    const targetFull = m.role !== 'guest';
    if (full && targetFull && !K.CH.blocks.has(m.id)) items.push({ icon: 'chat', label: t('chat.members.message'), action: () => close(() => messageMember(m.id)) });
    const choices = myRole === 'owner' ? ROLES : myRole === 'admin' && ['member', 'guest'].includes(m.role) ? ['member', 'guest'] : [];
    if (choices.length) {
      items.push({ separator: true }, { heading: t('chat.members.changeRole') });
      for (const role of choices) items.push({ label: roleText(role), checked: m.role === role, action: () => (m.role === role ? null : setRole(m, role)) });
    }
    if (full) {
      items.push({ separator: true });
      items.push(K.CH.blocks.has(m.id) ? { icon: 'ban', label: t('chat.block.unblock'), action: () => unblockMember(m.id).then(later) } : { icon: 'ban', label: t('chat.head.block', { name: displayName(m, t) }), action: () => blockMember(m.id).then(later) });
    }
    if (myRole === 'owner' || (myRole === 'admin' && ['member', 'guest'].includes(m.role))) {
      items.push({ separator: true }, { icon: 'leave', label: t('chat.members.remove'), danger: true, action: () => removeMember(m) });
    }
    return items;
  };
  let closeDialog = null;
  const close = (then) => {
    if (closeDialog) closeDialog(null);
    then();
  };
  // A change comes back through the directory, which reloads the view: draw again once it did.
  const later = () => {
    draw();
    setTimeout(draw, 500);
    setTimeout(draw, 1500);
  };
  // Owner and Guest reach past the person, so they ask first: an owner can remove you, and a guest's DMs close for
  // everyone in them. Admin and Member apply at once with Undo, which sets the role from before back.
  const setRole = async (m, role) => {
    const name = displayName(m, t);
    const before = m.role;
    if (role === 'owner' || role === 'guest') {
      const ok = await confirmDialog(
        t(`chat.members.${role}Title`, { name }),
        t(`chat.members.${role}Body`, { name, workspace: wsName() }),
        t(`chat.members.${role}Confirm`),
        role === 'guest'
      );
      if (!ok) return;
    }
    if (!(await applyRole(m.id, role))) return;
    if (role === 'admin' || role === 'member') {
      toast(t(role === 'admin' ? 'chat.members.nowAdmin' : 'chat.members.nowMember', { name }), {
        action: { label: t('common.actions.undo'), run: () => applyRole(m.id, before) }
      });
    }
  };
  const applyRole = async (id, role) => {
    try {
      await api('chatSetRole', ws, id, role);
      await K.reload();
      later();
      return true;
    } catch (err) {
      // Undo can come after the dialog closed.
      if (body.isConnected) showError(body, '', K.errorText(err));
      else toast(K.errorText(err), 5000);
      return false;
    }
  };
  const removeMember = async (m) => {
    const name = displayName(m, t);
    const ok = await confirmDialog(t('chat.members.removeTitle', { name, workspace: wsName() }), t('chat.members.removeBody', { name }), t('chat.members.removeConfirm'), true);
    if (!ok) return;
    try {
      await api('chatRemoveMember', ws, m.id);
      await K.reload();
      later();
    } catch (err) {
      showError(body, '', K.errorText(err));
    }
  };
  return wsDialog({
    title: t('chat.members.title', { workspace: wsName() }),
    wide: true,
    buttons: [closeButton()],
    redraw: () => draw(),
    render(b, done) {
      body = b;
      closeDialog = done;
      body.innerHTML = `<div class="ch-dlg-tools"><input type="search" class="ch-search" name="search" placeholder="${esc(t('chat.members.search'))}" aria-label="${esc(
        t('chat.members.search')
      )}" autocomplete="off" spellcheck="false"/></div><ul class="ch-people" data-people></ul><p class="error" data-error="" hidden></p>`;
      body.querySelector('[name="search"]').addEventListener('input', (e) => {
        query = e.target.value;
        draw();
      });
      body.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-person]');
        if (!btn) return;
        const m = K.CH.members.get(btn.dataset.person);
        if (m) menuInDialog(btn, menuFor(m));
      });
      draw();
    }
  });
}

// Workspace settings (desktop-ui 6.16, contract 5.10): your name and role, the host, invitations, blocked people,
// Delete workspace for an owner, and Leave.
export async function workspaceSettings() {
  const ws = K.CH.ws;
  if (!ws) return null;
  let body = null;
  let closeDialog = null;
  // The people whose Unblock is on its way: a redraw meanwhile keeps their button off.
  const unblocking = new Set();
  // The dialog's sections, each named by data-part.
  const html = () => {
    const me = K.CH.view?.me || { name: nameOf(K.me()), role: K.myRole() };
    const myRole = K.myRole();
    const limits = K.CH.state?.limits;
    const blocks = [...K.CH.blocks].sort((a, b) => collator().compare(nameOf(a), nameOf(b)));
    const alone = nobodyElse();
    const section = (part, title, inner) => `<section class="ch-set" data-part="${part}"><h3 class="ch-set-title">${esc(title)}</h3>${inner}</section>`;
    const you = section(
      'you',
      t('chat.settings.you'),
      `<div class="ch-set-row"><span class="ch-set-text"><span class="ch-set-label">${esc(t('chat.name.title', { workspace: wsName() }))}</span><span class="ch-set-value">${esc(me.name || '')}</span></span>
        <button type="button" class="btn secondary sm" data-set="name">${esc(t('chat.workspace.yourName'))}</button></div>
       <div class="ch-set-row"><span class="ch-set-text"><span class="ch-set-label">${esc(t('chat.settings.role'))}</span><span class="ch-set-value">${esc(roleText(myRole))}</span></span></div>`
    );
    const host = section('host', t('chat.settings.host'), `${K.hostNote()}${limits && limits.members ? `<p class="field-help ch-set-help">${esc(t('chat.settings.limits', { members: limits.members }))}</p>` : ''}`);
    const invites = isAdmin()
      ? section(
          'invites',
          t('chat.settings.invitations'),
          `<details class="ch-open-invites"><summary>${esc(t('chat.invite.open'))}</summary><ul class="ch-invites"></ul></details>
           <div><button type="button" class="btn secondary sm" data-set="invite">${icons.userPlus}<span>${esc(t('chat.workspace.invite'))}</span></button></div>`
        )
      : '';
    const blocked =
      myRole !== 'guest' || blocks.length
        ? section(
            'blocked',
            t('chat.block.list'),
            blocks.length
              ? `<ul class="ch-people">${blocks
                  .map(
                    (id) =>
                      `<li class="ch-person">${K.memberAvatar(id, 'ch-av-24')}<span class="ch-person-name">${esc(nameOf(id))}</span><button type="button" class="btn secondary sm" data-unblock="${esc(id)}" data-busy-off${
                        unblocking.has(id) ? ' disabled' : ''
                      }>${esc(t('chat.block.unblock'))}</button></li>`
                  )
                  .join('')}</ul>`
              : `<p class="field-help ch-set-help">${esc(t('chat.block.none'))}</p>`
          )
        : '';
    // Leave, and for an owner Delete, side by side at the end. Delete is off unless nobody else is in it, and says why
    // when the directory shows others; before it loads, it says nothing.
    const others = directoryKnown() && !alone;
    const del =
      myRole === 'owner'
        ? `<button type="button" class="btn sm ch-danger-btn" data-set="delete"${alone ? '' : others ? ' disabled aria-describedby="ch-delete-why"' : ' disabled'}>${icons.trash}<span>${esc(
            t('chat.delete.submit')
          )}</span></button>`
        : '';
    const why = myRole === 'owner' && others ? `<p class="field-help ch-set-help ch-set-why" id="ch-delete-why">${esc(t('chat.delete.onlyYou'))}</p>` : '';
    // The only owner can't leave; Leave stays on and opens the dialog that says how.
    const onlyOwnerNow = isOnlyOwner();
    const leaveWhy = onlyOwnerNow ? `<p class="field-help ch-set-help ch-set-why" id="ch-leave-why">${esc(t('chat.leave.onlyOwnerHint'))}</p>` : '';
    const leave = `<section class="ch-set ch-set-leave" data-part="leave"><div class="ch-set-row ch-set-end"><button type="button" class="btn sm ch-danger-btn" data-set="leave"${
      onlyOwnerNow ? ' aria-describedby="ch-leave-why"' : ''
    }>${icons.leave}<span>${esc(t('chat.workspace.leave'))}</span></button>${del}</div>${leaveWhy}${why}</section>`;
    return `${you}${host}${invites}${blocked}${leave}<p class="error" data-error="" hidden></p>`;
  };
  const draw = () => {
    if (!body || !body.isConnected) return;
    const openInvites = body.querySelector('.ch-open-invites')?.open;
    body.innerHTML = html();
    const det = body.querySelector('.ch-open-invites');
    if (det) {
      det.addEventListener('toggle', () => {
        if (det.open && !det.dataset.loaded) {
          det.dataset.loaded = '1';
          fillInvites(det.querySelector('.ch-invites'), ws);
        }
      });
      if (openInvites) det.open = true;
    }
  };
  const after = () => {
    draw();
    setTimeout(draw, 500);
  };
  return wsDialog({
    title: t('chat.workspace.settings'),
    wide: true,
    cls: 'ch-settings',
    buttons: [closeButton()],
    // The sections drawn from the directory (you, the people you blocked, Leave and Delete) follow it, each drawn
    // again only when it changed: the other buttons keep the focus and the pointer, and an open list of invitations
    // stays loaded. Sections that come or go with a new role draw it all again.
    redraw: () => {
      const fresh = document.createElement('template');
      fresh.innerHTML = html();
      const was = [...body.children];
      const now = [...fresh.content.children];
      if (was.map((el) => el.dataset.part).join() !== now.map((el) => el.dataset.part).join()) return draw();
      was.forEach((el, i) => {
        if (['you', 'blocked', 'leave'].includes(el.dataset.part) && el.outerHTML !== now[i].outerHTML) el.replaceWith(now[i]);
      });
    },
    render(b, done) {
      body = b;
      closeDialog = done;
      draw();
      body.addEventListener('click', async (e) => {
        const un = e.target.closest('[data-unblock]');
        if (un) {
          const id = un.dataset.unblock;
          un.disabled = true;
          unblocking.add(id);
          await unblockMember(id);
          unblocking.delete(id);
          return after();
        }
        const act = e.target.closest('[data-set]');
        if (!act) return;
        switch (act.dataset.set) {
          case 'name':
            await changeName();
            return after();
          case 'invite':
            await invitePeople();
            return after();
          case 'delete':
            closeDialog(null);
            return deleteWorkspace();
          case 'leave':
            closeDialog(null);
            return leaveWorkspace();
          default:
        }
      });
    }
  });
}

// The workspace menu's items for the workspace on screen (desktop-ui 6.17, contract 5.10): { top, bottom }, around
// Make and Join.
export function workspaceItems() {
  if (!K.CH.ws || !K.CH.view) return { top: [], bottom: [] };
  const top = [];
  if (isAdmin()) top.push({ icon: 'userPlus', label: t('chat.workspace.invite'), action: () => invitePeople() });
  top.push({ icon: 'people', label: t('chat.workspace.members'), action: () => workspaceMembers() });
  // Agents in channels, for full members (server/WORKSPACES.md "Agents").
  if (agentsOn() && !K.isGuest()) top.push({ icon: 'sparkle', label: t('chat.workspace.agents'), action: () => agentsDialog() });
  top.push({ icon: 'edit', label: t('chat.workspace.yourName'), action: () => changeName() });
  top.push({ icon: 'settings', label: t('chat.workspace.settings'), action: () => workspaceSettings() });
  // The only owner can't leave yet: the item says how, and opens the dialog that offers Members.
  const leaveSub = isOnlyOwner() ? t('chat.leave.onlyOwnerHint') : undefined;
  const bottom = [{ icon: 'leave', label: t('chat.workspace.leave'), sub: leaveSub, danger: true, action: () => leaveWorkspace() }];
  // Delete only works for an owner who is the only member; while others are in it, Workspace settings says why it's off.
  if (K.myRole() === 'owner' && nobodyElse()) bottom.push({ icon: 'trash', label: t('chat.workspace.delete'), danger: true, action: () => deleteWorkspace() });
  return { top, bottom };
}

// ---------- agents in channels (server/WORKSPACES.md "Agents") ----------
//
// An agent is a bot account in the workspace: a full member makes it (its sponsor) and gets a key, and the agent's own
// runtime, such as the reference runner in integrations/agent-runner, connects with that key. It answers a mention
// in a channel it was added to, as far as its settings let it. Its sponsor, an owner or an admin changes it.

// An agent as the Agents dialog and the form take it (AgentOut), from its directory row, for Workspace members. A row
// without settings (an older cache, until its directory loads again) has no answers: the form starts on Only me.
const agentFromDirectory = (m) => ({
  id: m.id,
  name: m.name,
  sponsor: m.agent?.sponsor ?? null,
  answers: m.agent?.answers ?? null,
  members: m.agent?.members ?? [],
  agents: Boolean(m.agent?.agents),
  lastSeen: null,
  createdAt: m.joinedAt
});

// The menu of an agent in the Agents dialog and Workspace members, the same on Android: Edit agent and Remove agent
// for its sponsor, an owner or an admin, and New key for its sponsor alone (the server refuses anyone else with 403,
// since the key reads every channel the agent is in). then runs after each, to draw the list again.
function agentMenu(agent, then) {
  if (!canManageAgent(agent, K.me(), K.myRole())) return [];
  const items = [{ icon: 'edit', label: t('chat.agents.edit'), action: () => editAgent(agent).then(then) }];
  if (canRenewAgentKey(agent, K.me())) items.push({ icon: 'sync', label: t('chat.agents.newKey'), action: () => newAgentKey(agent).then(then) });
  items.push({ separator: true }, { icon: 'leave', label: t('chat.agents.remove'), danger: true, action: () => removeAgent(agent).then(then) });
  return items;
}

// The Agents dialog (workspace menu): the workspace's agents with who made them, whom they answer, whether they answer
// other agents and when they were last active; Add an agent, and Edit, New key and Remove for those the person may
// change.
export async function agentsDialog() {
  const ws = K.CH.ws;
  if (!ws || K.isGuest() || !agentsOn()) return null;
  let list = null;
  let failed = null;
  let body = null;
  // The agents of the directory when the list loaded: one made, changed or removed elsewhere loads the list again.
  let loadedFor = '';
  const directoryIds = () =>
    JSON.stringify(
      activeMembers()
        .filter(isAgent)
        .map((m) => [m.id, m.name, m.agent || null])
        .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    );
  const load = async () => {
    loadedFor = directoryIds();
    try {
      const res = await api('chatAgents', ws);
      list = (res && res.agents) || [];
      failed = null;
    } catch (err) {
      failed = err;
    }
    draw();
  };
  // Who made it, whom it answers and whether it answers agents, as in Workspace members, and when it was last active.
  const meta = (a) => [agentLine(a), a.lastSeen ? t('chat.agents.lastActive', { date: dateTime(a.lastSeen) }) : t('chat.agents.neverActive')].filter(Boolean).join(' · ');
  const draw = () => {
    if (!body || !body.isConnected) return;
    const ul = body.querySelector('[data-agents]');
    if (!list) {
      ul.setAttribute('aria-busy', String(!failed));
      ul.innerHTML = failed ? `<li class="error">${esc(K.errorText(failed))}</li>` : '<li class="ch-invites-wait"><span class="spinner"></span></li>';
      return;
    }
    ul.removeAttribute('aria-busy');
    const rows = list.slice().sort((a, b) => collator().compare(a.name, b.name));
    ul.innerHTML = rows.length
      ? rows
          .map((a) => {
            const menu = canManageAgent(a, K.me(), K.myRole())
              ? `<button type="button" class="icon-btn xs" data-agent="${esc(a.id)}" aria-haspopup="menu" aria-label="${esc(t('chat.members.more', { name: a.name }))}" title="${esc(t('chat.members.more', { name: a.name }))}">${icons.more}</button>`
              : '';
            return `<li class="ch-person ch-agent-row" data-agent-row="${esc(a.id)}">${K.memberAvatar(a.id, 'ch-av-24')}<span class="ch-agent-text"><span class="ch-person-name">${esc(
              a.name
            )}</span><span class="ch-agent-meta">${esc(meta(a))}</span></span>${menu}</li>`;
          })
          .join('')
      : `<li class="ch-browse-none ch-agents-none">${esc(t('chat.agents.none'))}</li>`;
    if (failed) toast(K.errorText(failed), 5000);
    failed = null;
  };
  const menu = (btn) => {
    const a = (list || []).find((x) => x.id === btn.dataset.agent);
    if (!a) return;
    menuInDialog(btn, agentMenu(a, load));
  };
  return wsDialog({
    title: t('chat.agents.title', { workspace: wsName() }),
    wide: true,
    quietClose: true,
    buttons: [closeButton()],
    // Names come from the directory; an agent made or removed elsewhere comes with it.
    redraw: () => {
      if (directoryIds() !== loadedFor) load();
      else draw();
    },
    render(b) {
      body = b;
      body.innerHTML = `<p class="ch-agents-intro">${esc(t('chat.agents.intro'))}</p>
        <div class="ch-dlg-tools ch-dlg-tools-end"><button type="button" class="btn primary sm" data-add-agent>${icons.plus}<span>${esc(t('chat.agents.add'))}</span></button></div>
        <ul class="ch-people ch-agents" data-agents aria-busy="true"><li class="ch-invites-wait"><span class="spinner"></span></li></ul>
        <p class="error" data-error="" hidden></p>`;
      body.addEventListener('click', async (e) => {
        const more = e.target.closest('[data-agent]');
        if (more) return menu(more);
        if (e.target.closest('[data-add-agent]')) {
          await addAgent();
          return load();
        }
      });
      load();
    }
  });
}

// Add an agent: the form, then its key once.
export async function addAgent() {
  const made = await agentForm(null);
  if (made && made.key) await showAgentKey(made);
  return made ? made.agent : null;
}

// Edit an agent: its name, whom it answers and whether it answers other agents.
export async function editAgent(agent) {
  const changed = await agentForm(agent);
  return changed ? changed.agent : null;
}

// A new key: the old one stops at once, so the person confirms first; then the new key shows once.
export async function newAgentKey(agent) {
  const ws = K.CH.ws;
  if (!ws || !agent) return null;
  const ok = await confirmDialog(t('chat.agents.newKeyTitle', { name: agent.name }), t('chat.agents.newKeyBody', { name: agent.name }), t('chat.agents.newKeyConfirm'));
  if (!ok || ws !== K.CH.ws) return null;
  try {
    const made = await api('chatNewAgentKey', ws, agent.id);
    if (made && made.key && ws === K.CH.ws) await showAgentKey(made);
    return made ? made.agent : null;
  } catch (err) {
    toast(K.errorText(err), 5000);
    return null;
  }
}

// Remove an agent: it leaves every channel and its key stops; its messages stay, under a former member.
export async function removeAgent(agent) {
  const ws = K.CH.ws;
  if (!ws || !agent) return false;
  const ok = await confirmDialog(t('chat.agents.removeTitle', { name: agent.name }), t('chat.agents.removeBody', { name: agent.name }), t('chat.agents.removeConfirm'), true);
  if (!ok || ws !== K.CH.ws) return false;
  try {
    await api('chatRemoveAgent', ws, agent.id);
    toast(t('chat.agents.removed', { name: agent.name }));
    return true;
  } catch (err) {
    toast(K.errorText(err), 5000);
    return false;
  }
}

// The form of Add an agent and Edit: the name, whom it answers (everyone, only its sponsor, or its sponsor and people
// picked here) and whether it answers other agents. agent: the AgentOut to edit, or null for a new one. Answers what
// the server answered ({ agent, key } for a new one, { agent } for a change), or null.
async function agentForm(agent = null) {
  const ws = K.CH.ws;
  if (!ws || K.isGuest()) return null;
  const editing = Boolean(agent);
  const sponsor = editing ? agent.sponsor : K.me();
  const yours = sponsor === K.me();
  // A new agent starts on Only me, as on Android; one whose choice this version doesn't know too.
  let answers = agentFormAnswers(agent);
  const chosen = new Set(editing && agent.answers === 'members' ? agent.members || [] : []);
  let finish = null;
  let busy = false;
  // The people it may answer besides its sponsor: active people, never an agent.
  const people = () => activeMembers().filter((m) => isPerson(m) && m.id !== sponsor).sort(byName);
  const sponsorName = () => nameOf(sponsor);
  // How many replies a chain of agents answering each other may hold, as the server says (/v1/info).
  const depth = Number.isSafeInteger(K.CH.state?.agents?.depth) && K.CH.state.agents.depth > 0 ? K.CH.state.agents.depth : null;
  // Only people still in the workspace count: someone picked who left meanwhile would be refused.
  const picked = () => {
    const live = new Set(people().map((m) => m.id));
    return [...chosen].filter((id) => live.has(id));
  };
  // Chosen people with nobody picked can't be saved: the button stays off, and the line under the list says why.
  const ready = () => agentFormReady({ answers, chosen: picked().length });
  const showReady = (body) => {
    const primary = body.closest('.dialog')?.querySelector('.buttons button:last-child');
    if (primary && !busy) primary.disabled = !ready();
  };

  const drawPeople = (body) => {
    const box = body.querySelector('[data-people-box]');
    box.hidden = answers !== 'members';
    if (box.hidden) return showReady(body);
    const q = fold(body.querySelector('[name="people-search"]').value.trim());
    const all = people();
    const rows = all.filter((m) => !q || fold(displayName(m, t)).includes(q));
    const full = chosen.size >= AGENT_CHOSEN_MAX;
    body.querySelector('[data-people]').innerHTML = rows.length
      ? rows
          .map((m) => {
            const on = chosen.has(m.id);
            return `<label class="ch-check-row"><input type="checkbox" name="person" value="${esc(m.id)}"${on ? ' checked' : ''}${!on && full ? ' disabled' : ''}/>${K.memberAvatar(
              m.id,
              'ch-av-18'
            )}<span class="ch-check-label">${esc(displayName(m, t))}</span>${m.role === 'guest' ? `<span class="ch-tag">${esc(t('chat.roles.guest'))}</span>` : ''}</label>`;
          })
          .join('')
      : `<p class="field-help">${esc(all.length ? t('chat.new.none') : t('chat.agents.nobodyToPick'))}</p>`;
    countPeople(body);
  };
  // The count under the list, or with nobody picked what Save needs, and the boxes that can't be checked any more at
  // the limit. A checkbox changes only this, so it keeps the focus.
  const countPeople = (body) => {
    const full = chosen.size >= AGENT_CHOSEN_MAX;
    for (const box of body.querySelectorAll('[name="person"]')) box.disabled = !box.checked && full;
    const count = picked().length;
    const line = body.querySelector('[data-people-count]');
    line.textContent = count ? t('chat.agents.chosenCount', { count }) : t('chat.agents.chosenNone');
    line.classList.toggle('ch-warn', !count);
    showReady(body);
  };

  const submit = async (scrim) => {
    if (busy || !ready()) return;
    const body = scrim.querySelector('.dialog-body');
    const name = body.querySelector('[name="name"]').value.trim();
    if (!nameOk(name)) return showError(body, 'name', t('chat.errors.invalidName'));
    const agents = body.querySelector('[name="agents"]').checked;
    const members = answers === 'members' ? picked() : [];
    clearErrors(body);
    busy = true;
    setBusy(scrim, true);
    try {
      const res = editing
        ? await api('chatUpdateAgent', ws, agent.id, { name, answers, agents, ...(answers === 'members' ? { members } : {}) })
        : await api('chatCreateAgent', ws, { name, answers, agents, ...(answers === 'members' ? { members } : {}) });
      finish(res || null);
    } catch (err) {
      busy = false;
      setBusy(scrim, false);
      showReady(body);
      showError(body, fieldOf(err, ['name']), K.errorText(err));
    }
  };

  const option = (value, label, help) =>
    `<label class="ch-radio-row"><input type="radio" name="answers" value="${value}"${answers === value ? ' checked' : ''}/><span class="ch-radio-text"><span class="ch-radio-label">${esc(label)}</span><span class="field-help">${esc(
      help
    )}</span></span></label>`;
  return wsDialog({
    title: editing ? t('chat.agents.editTitle', { name: agent.name }) : t('chat.agents.addTitle'),
    buttons: [cancelButton(), { label: editing ? t('common.actions.save') : t('chat.agents.make'), value: (scrim) => (submit(scrim), KEEP_OPEN) }],
    // Who can be picked comes from the directory: what was typed, picked and checked stays.
    redraw: (body) => drawPeople(body),
    render(body, done) {
      finish = done;
      body.innerHTML = `<div class="form ch-form">
        <label>${esc(t('chat.agents.name'))}<input type="text" name="name" autocomplete="off" spellcheck="false" maxlength="200" placeholder="${esc(t('chat.agents.namePlaceholder'))}" value="${esc(
          editing ? agent.name : ''
        )}"/></label>
        <p class="error" data-error="name" hidden></p>
        <fieldset class="ch-field"><legend class="ch-label">${esc(t('chat.agents.answers'))}</legend>
          ${option('everyone', t('chat.agents.answersEveryoneOption'), t('chat.agents.answersEveryoneHelp'))}
          ${option(
            'sponsor',
            yours ? t('chat.agents.answersMeOption') : t('chat.agents.answersSponsorOption', { name: sponsorName() }),
            t('chat.agents.answersOnlyHelp')
          )}
          ${option('members', t('chat.agents.answersChosenOption'), yours ? t('chat.agents.answersChosenHelp') : t('chat.agents.answersChosenSponsorHelp', { name: sponsorName() }))}
          <div class="ch-agent-people" data-people-box hidden>
            <input type="search" class="ch-search" name="people-search" placeholder="${esc(t('chat.members.search'))}" aria-label="${esc(t('chat.members.search'))}" autocomplete="off" spellcheck="false"/>
            <div class="ch-checks" data-people role="group" aria-label="${esc(t('chat.agents.answersChosenOption'))}"></div>
            <p class="field-help" data-people-count></p>
          </div>
        </fieldset>
        <label class="ch-check-row ch-agent-toggle"><input type="checkbox" name="agents"${editing && agent.agents ? ' checked' : ''}/><span class="ch-radio-text"><span class="ch-radio-label">${esc(
          t('chat.agents.answersAgentsOption')
        )}</span><span class="field-help">${esc(depth ? t('chat.agents.answersAgentsHelp', { count: depth }) : t('chat.agents.answersAgentsHelpPlain'))}</span></span></label>
        ${editing ? '' : `<p class="field-help ch-agent-runs">${esc(t('chat.agents.runsNote'))}</p>`}
        <p class="error" data-error="" hidden></p>
      </div>`;
      body.addEventListener('change', (e) => {
        if (e.target.name === 'answers') {
          answers = e.target.value;
          drawPeople(body);
        } else if (e.target.name === 'person') {
          if (e.target.checked) chosen.add(e.target.value);
          else chosen.delete(e.target.value);
          countPeople(body);
        }
      });
      body.querySelector('[name="people-search"]').addEventListener('input', () => drawPeople(body));
      // Enter in the name field presses the button; in the people search it only filters.
      body.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.isComposing && e.target.matches('[name="name"]')) {
          e.preventDefault();
          submit(body.closest('.scrim'));
        }
      });
      drawPeople(body);
      setTimeout(() => body.querySelector('[name="name"]')?.[editing ? 'select' : 'focus'](), 0);
    }
  });
}

// The key of an agent, shown once after Add an agent and New key: the key with Copy, the server's address and the
// workspace ID, and a ready config for the reference runner with Copy. On desktop the config can take its backend
// from one of the person's agents in Settings, Agents, with an environment variable in place of that agent's own key.
// Closing before anything was copied asks first, as the invitation link does.
async function showAgentKey({ agent, key }) {
  const ws = K.CH.ws;
  if (!ws || !agent || !key) return null;
  const server = K.CH.state?.server || '';
  let backend = PLACEHOLDER_BACKEND;
  let choices = [];
  let kept = false;
  const config = () => runnerConfig({ server, workspace: ws, key, backend });

  const drawConfig = (body) => {
    const cfg = config();
    body.querySelector('[name="config"]').value = runnerText(cfg);
    const env = runnerEnv(cfg);
    const envLine = body.querySelector('[data-env]');
    envLine.hidden = !env.length;
    envLine.textContent = env.length ? t('chat.agents.keyEnv', { name: env[0] }) : '';
    body.querySelector('[data-placeholder]').hidden = cfg.backend.type !== PLACEHOLDER_BACKEND.type || cfg.backend.command !== PLACEHOLDER_BACKEND.command;
  };
  // Copy key is the filled button until something was copied; Done is filled after.
  const showKept = (scrim) => {
    const copyKey = scrim.querySelector('[data-copy-key]');
    copyKey.classList.toggle('primary', !kept);
    copyKey.classList.toggle('secondary', kept);
    scrim.querySelector('.dialog').classList.toggle('ch-quiet-close', !kept);
  };
  const keep = (scrim) => {
    if (kept) return;
    kept = true;
    showKept(scrim);
  };
  const copy = (scrim, value, done) =>
    navigator.clipboard.writeText(value).then(
      () => {
        toast(done);
        keep(scrim);
      },
      () => {}
    );
  const leaveOk = () => {
    if (kept) return true;
    return dialog({
      title: t('chat.agents.closeTitle'),
      body: `<p>${esc(t('chat.agents.closeBody'))}</p>`,
      buttons: [
        { label: t('chat.invite.goBack'), value: false },
        { label: t('common.actions.close'), value: true }
      ]
    });
  };

  return wsDialog({
    title: t('chat.agents.keyTitle', { name: agent.name }),
    wide: true,
    buttons: [{ get label() { return t('chat.invite.done'); }, value: true }],
    beforeClose: () => leaveOk(),
    render(body) {
      const scrim = body.closest('.scrim');
      const fact = (label, value, name) =>
        `<label>${esc(label)}<input type="text" name="${name}" class="sel ch-link-field" readonly spellcheck="false" value="${esc(value)}"/></label>`;
      body.innerHTML = `<div class="form ch-form ch-agent-key">
        <p class="ch-agent-once">${esc(t('chat.agents.keyOnce', { name: agent.name }))}</p>
        <div class="ch-agent-copy-row">${fact(t('chat.agents.key'), key, 'key')}<button type="button" class="btn primary sm" data-copy-key>${icons.copy}<span>${esc(t('chat.agents.copyKey'))}</span></button></div>
        <div class="ch-agent-facts">${fact(t('chat.agents.server'), server, 'server')}${fact(t('chat.agents.workspaceId'), ws, 'workspace')}</div>
        ${
          WEB
            ? ''
            : `<label data-use hidden>${esc(t('chat.agents.useMine'))}<select name="use"><option value="">${esc(t('chat.agents.useNone'))}</option></select>
                 <span class="field-help">${esc(t('chat.agents.useMineHelp'))}</span></label>`
        }
        <label>${esc(t('chat.agents.config'))}<textarea name="config" class="sel ch-agent-config" readonly spellcheck="false" rows="12"></textarea></label>
        <p class="field-help" data-placeholder>${esc(t('chat.agents.configBackend'))}</p>
        <p class="field-help ch-warn" data-env hidden></p>
        <div class="ch-agent-copy-end"><button type="button" class="btn secondary sm" data-copy-config>${icons.copy}<span>${esc(t('chat.agents.copyConfig'))}</span></button></div>
        <p class="field-help">${esc(t('chat.agents.configRun'))} <code class="ch-agent-cmd sel">${esc(RUNNER_COMMAND)}</code></p>
        <p class="note">${esc(t('chat.agents.configPrivate'))}</p>
      </div>`;
      drawConfig(body);
      showKept(scrim);
      body.querySelector('[data-copy-key]').addEventListener('click', () => copy(scrim, key, t('chat.agents.keyCopied')));
      body.querySelector('[data-copy-config]').addEventListener('click', () => copy(scrim, body.querySelector('[name="config"]').value, t('chat.agents.configCopied')));
      // Ctrl+C in the key or the config copies too.
      for (const field of body.querySelectorAll('[name="key"], [name="config"]')) field.addEventListener('copy', () => keep(scrim));
      const use = body.querySelector('[name="use"]');
      if (use) {
        use.addEventListener('change', () => {
          const pick = choices.find((c) => c.id === use.value);
          backend = pick ? pick.backend : PLACEHOLDER_BACKEND;
          drawConfig(body);
        });
        // The agents of Settings, Agents, without their keys (agentConfig never gives one).
        api('agentConfig')
          .then((cfg) => {
            if (!body.isConnected) return;
            choices = runnerAgents(cfg);
            if (!choices.length) return;
            for (const c of choices) {
              const o = document.createElement('option');
              o.value = c.id;
              o.textContent = c.name;
              use.append(o);
            }
            body.querySelector('[data-use]').hidden = false;
          })
          .catch(() => {});
      }
      const field = body.querySelector('[name="key"]');
      field.focus();
      field.select();
    }
  });
}

// ---------- direct messages (desktop-ui 6.11, contract 3.12) ----------

const PICK_MAX = 7;

export async function newMessage(prefill = []) {
  const ws = K.CH.ws;
  if (!ws || K.isGuest()) return null;
  // Active full members, without you and without people you blocked (contract 3.12). Who you are is read at each
  // draw: a view from before the run's first step doesn't know it yet, and the list draws again when it comes.
  const people = () =>
    activeMembers()
      .filter((m) => m.id !== K.me() && m.role !== 'guest' && !isAgent(m) && !K.CH.blocks.has(m.id))
      .sort((a, b) => collator().compare(displayName(a, t), displayName(b, t)));
  const picked = prefill.filter((id) => people().some((m) => m.id === id)).slice(0, PICK_MAX);
  let active = 0;
  let busy = false;
  let finish = null;
  let body = null;
  let scrim = null;

  // Everyone in the directory, so the list can say why a blocked person or a guest can't be picked (contract 3.12).
  const view = () => {
    const query = body.querySelector('[name="to"]').value.trim();
    const q = fold(query);
    const everyone = activeMembers().sort((a, b) => collator().compare(displayName(a, t), displayName(b, t)));
    return dmPicker(everyone, { me: K.me(), blocks: K.CH.blocks, picked, query, matches: (m) => fold(displayName(m, t)).includes(q), membersMore: K.CH.view?.membersMore });
  };
  const shown = () => view().pick;
  const drawChips = () => {
    body.querySelector('[data-chips]').innerHTML = picked
      .map((id) => {
        const name = nameOf(id);
        return `<span class="ch-to-chip">${K.memberAvatar(id, 'ch-av-16')}<span class="ch-to-name">${esc(name)}</span><button type="button" class="ch-to-x" data-unpick="${esc(id)}" aria-label="${esc(
          t('chat.new.removePerson', { name })
        )}" title="${esc(t('chat.new.removePerson', { name }))}">${icons.close}</button></span>`;
      })
      .join('');
  };
  const drawList = () => {
    const v = view();
    const rows = v.pick;
    const full = picked.length >= PICK_MAX;
    if (active >= rows.length) active = Math.max(0, rows.length - 1);
    const ul = body.querySelector('[data-list]');
    ul.innerHTML = rows
      .map(
        (m, i) =>
          `<li role="option" id="ch-new-opt-${i}" class="ch-new-row${i === active && !full ? ' is-active' : ''}" data-pick="${esc(m.id)}" aria-selected="${i === active && !full}"${full ? ' aria-disabled="true"' : ''}>${K.memberAvatar(
            m.id,
            'ch-av-24'
          )}<span class="ch-person-name">${esc(displayName(m, t))}</span></li>`
      )
      .join('');
    ul.hidden = !rows.length;
    // Who can't be picked, and why: off rows outside the listbox, so Unblock is a plain button.
    const off = body.querySelector('[data-off]');
    off.innerHTML = [
      ...v.blocked.map(
        (m) =>
          `<li class="ch-new-row is-off" data-off-row="blocked">${K.memberAvatar(m.id, 'ch-av-24')}<span class="ch-person-name">${esc(t('chat.new.blockedRow', { name: displayName(m, t) }))}</span><button type="button" class="link-btn" data-unblock="${esc(
            m.id
          )}">${esc(t('chat.block.unblock'))}</button></li>`
      ),
      ...v.guests.map(
        (m) =>
          `<li class="ch-new-row is-off" data-off-row="guest">${K.memberAvatar(m.id, 'ch-av-24')}<span class="ch-new-off-text"><span class="ch-person-name">${esc(displayName(m, t))}</span><span class="field-help">${esc(
            t('chat.new.guestRow')
          )}</span></span></li>`
      )
    ].join('');
    off.hidden = !off.children.length;
    const none = body.querySelector('[data-none]');
    none.hidden = !v.empty;
    if (v.empty === 'nobody') {
      none.innerHTML = `<span>${esc(t('chat.new.nobody', { workspace: wsName() }))}</span>${isAdmin() ? `<button type="button" class="btn secondary sm" data-invite>${icons.userPlus}<span>${esc(t('chat.workspace.invite'))}</span></button>` : ''}`;
    } else if (v.empty === 'none') none.textContent = t('chat.new.none');
    ul.classList.toggle('is-full', full);
    body.querySelector('[data-limit]').hidden = !full;
    const input = body.querySelector('[name="to"]');
    if (rows.length && !full) input.setAttribute('aria-activedescendant', `ch-new-opt-${active}`);
    else input.removeAttribute('aria-activedescendant');
    drawButton();
  };
  const drawButton = () => {
    const primary = scrim.querySelector('.buttons button:last-child');
    primary.textContent = picked.length && openDmFor(picked) ? t('chat.new.open') : t('chat.new.start');
    primary.disabled = !picked.length || busy;
  };
  const pick = (id) => {
    if (!id || picked.includes(id) || picked.length >= PICK_MAX) return;
    picked.push(id);
    const input = body.querySelector('[name="to"]');
    input.value = '';
    clearErrors(body);
    drawChips();
    drawList();
    input.focus();
  };
  const unpick = (id) => {
    const i = picked.indexOf(id);
    if (i < 0) return;
    picked.splice(i, 1);
    clearErrors(body);
    drawChips();
    drawList();
    body.querySelector('[name="to"]').focus();
  };
  const showFailure = (err) => {
    const line = body.querySelector('[data-error=""]');
    line.textContent = K.errorText(err);
    line.hidden = false;
    // You blocked someone in the set: Unblock is right there (contract 3.12).
    if (err && err.code === 'blocked' && err.member) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'link-btn';
      b.textContent = t('chat.block.unblock');
      b.addEventListener('click', async () => {
        if (await unblockMember(err.member)) {
          clearErrors(body);
          drawList();
        }
      });
      line.append(' ', b);
    }
  };
  const submit = async () => {
    if (busy || !picked.length) return;
    const existing = openDmFor(picked);
    if (existing) return finish({ room: existing });
    clearErrors(body);
    busy = true;
    setBusy(scrim, true);
    try {
      const res = await api('chatStartDm', ws, picked.slice());
      finish(res);
    } catch (err) {
      busy = false;
      setBusy(scrim, false);
      drawButton();
      showFailure(err);
    }
  };
  const res = await wsDialog({
    title: t('chat.new.title'),
    buttons: [cancelButton(), { label: t('chat.new.start'), value: () => (submit(), KEEP_OPEN) }],
    // The list and the chips' names follow the directory; the search text, the chips and the button stay as they were,
    // and the highlight stays on the person it was on while they are still in the list (Enter picks the highlighted
    // one, and someone new above them would move it to another person).
    redraw: () => {
      const was = body.querySelectorAll('[data-list] [data-pick]')[active]?.dataset.pick;
      drawChips();
      const at = shown().findIndex((m) => m.id === was);
      if (at >= 0) active = at;
      drawList();
    },
    render(b, done) {
      body = b;
      finish = done;
      scrim = body.closest('.scrim');
      const host = K.CH.state?.host || '';
      body.innerHTML = `<div class="form ch-form">
          <div class="ch-to" data-to>
            <span class="ch-to-label" id="ch-new-to">${esc(t('chat.new.to'))}</span>
            <span class="ch-to-chips" data-chips></span>
            <input type="text" name="to" class="ch-to-input" role="combobox" aria-expanded="true" aria-controls="ch-new-list" aria-labelledby="ch-new-to" autocomplete="off" spellcheck="false" placeholder="${esc(
              t('chat.new.search', { workspace: wsName() })
            )}"/>
          </div>
          <ul class="ch-new-list" id="ch-new-list" role="listbox" aria-labelledby="ch-new-to" data-list></ul>
          <ul class="ch-new-list ch-new-off" data-off hidden></ul>
          <div class="ch-browse-none ch-new-none" role="status" data-none hidden></div>
          <p class="field-help ch-warn" data-limit hidden>${esc(t('chat.new.limit'))}</p>
          <p class="note ch-host">${esc(t('chat.new.hostNote', { host }))}</p>
          <p class="error" data-error="" hidden></p>
        </div>`;
      const input = body.querySelector('[name="to"]');
      input.addEventListener('input', () => {
        active = 0;
        drawList();
      });
      input.addEventListener('keydown', (e) => {
        const rows = shown();
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          if (!rows.length) return;
          active = (active + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
          drawList();
          body.querySelector('.ch-new-row.is-active')?.scrollIntoView({ block: 'nearest' });
        } else if (e.key === 'Enter' && !e.isComposing) {
          e.preventDefault();
          if (input.value.trim() && rows[active]) pick(rows[active].id);
          else if (!input.value.trim() && picked.length) submit();
          else if (rows[active]) pick(rows[active].id);
        } else if (e.key === 'Backspace' && !input.value && picked.length) {
          e.preventDefault();
          unpick(picked[picked.length - 1]);
        }
      });
      body.addEventListener('mousedown', (e) => {
        // A click on a row keeps the focus in the input.
        if (e.target.closest('[data-pick]')) e.preventDefault();
      });
      body.addEventListener('click', (e) => {
        const x = e.target.closest('[data-unpick]');
        if (x) return unpick(x.dataset.unpick);
        const row = e.target.closest('[data-pick]');
        if (row && row.getAttribute('aria-disabled') !== 'true') return pick(row.dataset.pick);
        const un = e.target.closest('[data-unblock]');
        if (un) {
          un.disabled = true;
          return unblockMember(un.dataset.unblock).then((ok) => {
            if (!body.isConnected) return;
            if (!ok) un.disabled = false;
            else {
              clearErrors(body);
              drawList();
              input.focus();
            }
          });
        }
        if (e.target.closest('[data-invite]')) {
          done(null);
          return invitePeople();
        }
        if (e.target.closest('[data-to]')) input.focus();
      });
      drawChips();
      drawList();
    }
  });
  if (!res || !res.room || ws !== K.CH.ws) return null;
  K.CH.rooms.set(res.room.id, K.CH.rooms.get(res.room.id) || res.room);
  K.openRoom(res.room.id);
  return res.room;
}

// Leave a conversation (contract 3.12, 5.10): an open DM closes for everyone in it, so its dialog says Close and names
// the others; a closed one leaves the list, so its dialog says Remove.
export async function leaveConversation(room) {
  const ws = K.CH.ws;
  if (!ws || !room) return false;
  const others = [...new Set(room.participants || [])].filter((id) => id !== K.me()).map(nameOf);
  const names = new Intl.ListFormat(getLocale(), { type: 'conjunction' }).format(others);
  const ok = room.closedReason
    ? await confirmDialog(t('chat.leaveDm.removeTitle'), t('chat.leaveDm.bodyClosed'), t('chat.leaveDm.removeSubmit'), true)
    : await confirmDialog(t('chat.leaveDm.title'), t('chat.leaveDm.body', { names }), t('chat.leaveDm.submit'), true);
  if (!ok || ws !== K.CH.ws) return false;
  K.expectLeave(room.id);
  try {
    await api('chatLeaveDm', ws, room.id);
    K.afterLeave(room.id);
    return true;
  } catch (err) {
    K.cancelLeave(room.id);
    toast(K.errorText(err), 5000);
    return false;
  }
}
