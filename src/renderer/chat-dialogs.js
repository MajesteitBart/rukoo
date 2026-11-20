import { t, getLocale } from './i18n.js';
import { icons } from './icons.js';
import { api, esc, toast, showMenu, closeMenu, menuOpen, dialog, confirmDialog, KEEP_OPEN, segmented, setSegmented } from './ui.js';
import { displayName } from './chat-model.js';

// Team chat's dialogs (contract 3.3, 3.12, 5.10; desktop-ui 6): making and joining a workspace, inviting people,
// channels (make, browse, members and roles, rename, archive, leave and the successor), leaving and deleting a
// workspace, its members and settings, New message, blocking, and leaving a conversation. Each is an async function
// that answers with what came of it, or null.
//
// chat.js gives them what they need through bindDialogs(kit) once, so this module never imports chat.js:
//   CH, ctx, errorText(err, context), hostNote(), summary(id?), me(), myRole(), isGuest(), roomName(room),
//   memberAvatar(id, cls), tileHtml(w), selectWorkspace(ws, opts), openRoom(id, opts), openDefault(),
//   previewChannel(channel), expectLeave(roomId), expectGone(ws), reload(), refreshState()
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

// A dialog about the workspace on screen: it closes when that workspace changes or goes (desktop-ui 7.11).
function wsDialog(opts) {
  const gen = K.CH.generation;
  let timer = null;
  return dialog({
    ...opts,
    render(body, done) {
      timer = setInterval(() => {
        if (K.CH.generation !== gen || !body.isConnected) done(null);
      }, 250);
      body.closest('.dialog').classList.add('ch-dialog');
      if (opts.quietClose) body.closest('.dialog').classList.add('ch-quiet-close');
      if (opts.cls) body.closest('.dialog').classList.add(...opts.cls.split(' '));
      if (opts.render) opts.render(body, done);
    }
  }).finally(() => clearInterval(timer));
}

// A person's menu inside a dialog. The dialog takes Escape on the document before the menu sees it, which would close
// both; this listener on the window comes first, so Escape closes only the menu and the focus goes back to its button.
function menuInDialog(anchor, items) {
  showMenu(anchor, items, { align: 'right' });
  const onKey = (e) => {
    if (!menuOpen()) {
      window.removeEventListener('keydown', onKey, true);
      return;
    }
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    window.removeEventListener('keydown', onKey, true);
    closeMenu({ refocus: true });
  };
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
      body.closest('.dialog').classList.add('ch-dialog');
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
      checked = text;
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
      body.closest('.dialog').classList.add('ch-dialog');
      body.innerHTML = `<div class="form ch-form">
        <label>${esc(t('chat.join.link'))}<input type="text" name="link" autocomplete="off" spellcheck="false" placeholder="https://…/join#w=…" value="${esc(link)}"/></label>
        <p class="error" data-error="link" hidden></p>
        <p class="ch-checking" data-checking hidden><span class="spinner"></span><span>${esc(t('chat.join.checking'))}</span></p>
        <div class="ch-card ch-join-preview" data-preview hidden></div>
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

const hostOf = (text) => {
  const m = String(text || '').match(/https?:\/\/\S+/);
  if (!m) return '';
  try {
    return new URL(m[0]).host;
  } catch (_) {
    return '';
  }
};

// ---------- invitations (desktop-ui 6.3) ----------

// The open invitations as list rows, with Withdraw. into: the <ul>; ws: the workspace they belong to.
async function fillInvites(into, ws) {
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
          [t('chat.invite.channelCount', { count: i.channelCount || 0 }), t('chat.invite.until', { date: dateTime(i.expiresAt) }), t('chat.invite.by', { name: nameOf(i.issuer) })].join(' · ')
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
  let busy = false;
  let finish = null;

  const picked = (body) => [...body.querySelectorAll('input[name="channel"]:checked')].map((x) => x.value);
  // A guest needs a channel, and an invitation holds 20 at most (contract 3.16).
  const update = (scrim) => {
    const body = scrim.querySelector('.dialog-body');
    const n = picked(body).length;
    const needs = role === 'guest' && n === 0;
    body.querySelector('[data-guest-need]').hidden = !needs;
    for (const box of body.querySelectorAll('input[name="channel"]')) box.disabled = !box.checked && n >= 20;
    const primary = scrim.querySelector('.buttons button:last-child');
    if (!link) primary.disabled = needs || busy;
  };

  const submit = async (scrim) => {
    if (busy) return;
    if (link) return finish(true);
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
      body.querySelector('[data-step="make"]').hidden = true;
      const out = body.querySelector('[data-step="made"]');
      out.hidden = false;
      const field = out.querySelector('[name="link"]');
      field.value = link;
      out.querySelector('[data-ready]').textContent = t('chat.invite.ready', { date: dateTime(made.invite && made.invite.expiresAt) });
      const [cancel, primary] = scrim.querySelectorAll('.buttons button');
      cancel.hidden = true;
      primary.textContent = t('chat.invite.done');
      field.focus();
      field.select();
      fillInvites(body.querySelector('.ch-invites'), ws);
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
    render(body, done) {
      finish = done;
      const channelRows = managed.length
        ? managed
            .map(
              (r) =>
                `<label class="ch-check-row"><input type="checkbox" name="channel" value="${esc(r.id)}"/><span class="ch-check-ic" aria-hidden="true">${channelIcon(r)}</span><span class="ch-check-label">${esc(r.name || '')}</span></label>`
            )
            .join('')
        : `<p class="field-help">${esc(t('chat.invite.channelsNone'))}</p>`;
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
          <div><button type="button" class="btn secondary sm" data-copy>${icons.copy}<span>${esc(t('chat.invite.copy'))}</span></button></div>
          <p class="field-help" data-ready></p>
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
      body.querySelector('[data-copy]').addEventListener('click', () => {
        if (!link) return;
        navigator.clipboard.writeText(link).then(
          () => toast(t('chat.invite.copied')),
          () => {}
        );
      });
      const open = body.querySelector('.ch-open-invites');
      open.addEventListener('toggle', () => {
        if (open.open && !open.dataset.loaded) {
          open.dataset.loaded = '1';
          fillInvites(open.querySelector('.ch-invites'), ws);
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
  const draw = (body) => {
    const list = (K.CH.view?.channels || []).slice().sort((a, b) => collator().compare(a.name, b.name));
    const q = fold(query.trim());
    const match = (c) => !q || fold(c.name).includes(q);
    const open = list.filter((c) => !c.archived && match(c));
    const archived = list.filter((c) => c.archived && c.joined && match(c));
    const row = (c) => {
      const joined = c.joined && K.CH.rooms.has(c.id);
      const meta = [t('chat.head.members', { count: c.members || 0 }), c.visibility === 'private' ? t('chat.head.private') : ''].filter(Boolean).join(' · ');
      const side = c.archived ? '' : joined ? `<span class="ch-pill">${esc(t('chat.channel.joined'))}</span>` : `<button type="button" class="btn secondary sm" data-join="${esc(c.id)}" data-busy-off>${esc(t('chat.channel.join'))}</button>`;
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
    try {
      await api('chatJoinChannel', ws, id);
      if (await waitForRoom(id)) {
        finish(true);
        K.openRoom(id);
      } else draw(body);
    } catch (err) {
      btn.disabled = false;
      btn.removeAttribute('aria-busy');
      showError(body, '', K.errorText(err));
    }
  };
  return wsDialog({
    title: t('chat.channel.browseTitle', { workspace: wsName() }),
    wide: true,
    quietClose: true,
    buttons: [closeButton()],
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
export async function channelMembers(room, { add = false } = {}) {
  const ws = K.CH.ws;
  if (!ws || !room) return null;
  const channel = room.kind === 'channel';
  const manager = channel && room.role === 'manager' && !room.archived;
  let list = null;
  let query = '';
  let picking = false;
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
    const q = fold(query.trim());
    const byId = new Map(list.map((m) => [m.member, m]));
    const ids = sortByName(list.map((m) => m.member)).filter((id) => !q || fold(nameOf(id)).includes(q));
    ul.innerHTML = ids
      .map((id) => {
        const m = byId.get(id);
        const member = K.CH.members.get(id);
        const mine = id === K.me();
        const label = mine ? t('chat.members.you', { name: nameOf(id) }) : nameOf(id);
        const tags = [member && member.role === 'guest' ? `<span class="ch-tag">${esc(t('chat.roles.guest'))}</span>` : '', m.role === 'manager' && channel ? `<span class="ch-pill">${esc(t('chat.roles.manager'))}</span>` : ''].join('');
        const more =
          manager && !mine
            ? `<button type="button" class="icon-btn xs" data-person="${esc(id)}" aria-haspopup="menu" aria-label="${esc(t('chat.members.more', { name: nameOf(id) }))}" title="${esc(t('chat.members.more', { name: nameOf(id) }))}">${icons.more}</button>`
            : '';
        return `<li class="ch-person">${K.memberAvatar(id, 'ch-av-24')}<span class="ch-person-name">${esc(label)}</span>${tags}${more}</li>`;
      })
      .join('');
    if (!ids.length) ul.innerHTML = `<li class="ch-browse-none">${esc(t('chat.new.none'))}</li>`;
  };
  const candidates = () => {
    const inside = new Set((list || []).map((m) => m.member));
    return activeMembers()
      .filter((m) => !inside.has(m.id))
      .sort((a, b) => collator().compare(displayName(a, t), displayName(b, t)));
  };
  const chosen = new Set();
  const drawPicker = () => {
    const ul = body.querySelector('[data-pick]');
    const q = fold(body.querySelector('[name="pick-search"]').value.trim());
    const rows = candidates().filter((m) => !q || fold(displayName(m, t)).includes(q));
    ul.innerHTML = rows.length
      ? rows
          .map((m) => {
            const guest = m.role === 'guest';
            const locked = guest && !isAdmin();
            return `<li><label class="ch-check-row${locked ? ' is-disabled' : ''}"><input type="checkbox" name="pick" value="${esc(m.id)}"${chosen.has(m.id) ? ' checked' : ''}${locked ? ' disabled' : ''}/>${K.memberAvatar(
              m.id,
              'ch-av-24'
            )}<span class="ch-check-label">${esc(displayName(m, t))}</span>${guest ? `<span class="ch-tag">${esc(t('chat.roles.guest'))}</span>` : ''}${
              locked ? `<span class="field-help ch-check-note">${esc(t('chat.channel.addGuestNeedsAdmin'))}</span>` : ''
            }</label></li>`;
          })
          .join('')
      : `<li class="ch-browse-none">${esc(t('chat.new.none'))}</li>`;
    body.querySelector('[data-add-go]').disabled = !chosen.size;
  };
  const addChosen = async () => {
    const ids = [...chosen];
    if (!ids.length) return;
    const btn = body.querySelector('[data-add-go]');
    btn.disabled = true;
    btn.setAttribute('aria-busy', 'true');
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
    const items = [
      m.role === 'manager'
        ? { icon: 'person', label: t('chat.channel.makeMember'), action: () => setRole(id, 'member') }
        : { icon: 'people', label: t('chat.channel.makeManager'), action: () => setRole(id, 'manager') },
      { separator: true },
      { icon: 'leave', label: t('chat.channel.removeMember', { name: room.name || '' }), danger: true, action: () => removeOne(id) }
    ];
    menuInDialog(btn, items);
  };
  const setRole = async (id, role) => {
    try {
      await api('chatSetChannelRole', ws, room.id, id, role);
      await load();
    } catch (err) {
      showError(body, '', K.errorText(err));
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
    render(b, done) {
      body = b;
      finish = done;
      body.innerHTML = `<div data-view="list">
          <div class="ch-dlg-tools">
            <input type="search" class="ch-search" name="search" placeholder="${esc(t('chat.members.search'))}" aria-label="${esc(t('chat.members.search'))}" autocomplete="off" spellcheck="false"/>
            ${manager ? `<button type="button" class="btn secondary sm" data-add>${icons.userPlus}<span>${esc(t('chat.head.addPeople'))}</span></button>` : ''}
          </div>
          <ul class="ch-people" data-people></ul>
        </div>
        <div data-view="pick" hidden>
          <p class="ch-sub">${esc(t('chat.channel.addTitle', { name: room.name || '' }))}</p>
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
        body.querySelector('[data-add-go]').disabled = !chosen.size;
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
      });
      picking = Boolean(add && manager);
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

// Leave a channel (desktop-ui 6.9): asked first; the only manager picks a successor.
export async function leaveChannel(room) {
  const ws = K.CH.ws;
  if (!ws || !room) return false;
  const body = room.members <= 1 ? t('chat.channel.leaveBodyLast', { name: room.name || '' }) : room.visibility === 'private' ? t('chat.channel.leaveBodyPrivate') : t('chat.channel.leaveBodyPublic');
  const ok = await confirmDialog(t('chat.channel.leaveTitle', { name: room.name || '' }), body, t('chat.channel.leave'), true);
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

async function chooseSuccessor(room) {
  const ws = K.CH.ws;
  let finish = null;
  let busy = false;
  let people = [];
  const submit = async (scrim) => {
    if (busy) return;
    const body = scrim.querySelector('.dialog-body');
    const pick = body.querySelector('[name="successor"]:checked');
    if (!pick) return showError(body, '', t('chat.errors.lastManager'));
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
    title: t('chat.channel.successorTitle', { name: room.name || '' }),
    buttons: [cancelButton(), { label: t('chat.channel.successorSubmit'), value: (scrim) => (submit(scrim), KEEP_OPEN), danger: true }],
    render(body, close) {
      finish = close;
      body.innerHTML = `<p>${esc(t('chat.channel.successorBody'))}</p><div class="ch-successors" aria-busy="true"><span class="spinner"></span></div><p class="error" data-error="" hidden></p>`;
      api('chatRoomMembers', ws, room.id)
        .then((r) => {
          people = ((r && r.members) || [])
            .map((m) => m.member)
            .filter((id) => id !== K.me() && K.CH.members.get(id)?.role !== 'guest' && K.CH.members.get(id)?.state === 'active')
            .sort((a, b) => collator().compare(nameOf(a), nameOf(b)));
          const box = body.querySelector('.ch-successors');
          box.removeAttribute('aria-busy');
          box.innerHTML = people.length
            ? people
                .map(
                  (id, i) =>
                    `<label class="ch-radio-row ch-person-pick"><input type="radio" name="successor" value="${esc(id)}"${i === 0 ? ' checked' : ''}/>${K.memberAvatar(id, 'ch-av-24')}<span class="ch-check-label">${esc(nameOf(id))}</span></label>`
                )
                .join('')
            : `<p class="field-help">${esc(t('chat.new.none'))}</p>`;
          body.querySelector('[name="successor"]')?.focus();
        })
        .catch((err) => showError(body, '', K.errorText(err)));
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

export async function leaveWorkspace() {
  const ws = K.CH.ws;
  if (!ws) return false;
  const name = wsName();
  const ok = await confirmDialog(t('chat.leave.title', { workspace: name }), t('chat.leave.body'), t('chat.leave.submit'), true);
  if (!ok || ws !== K.CH.ws) return false;
  K.expectGone(ws);
  try {
    await api('chatLeaveWorkspace', ws);
    await K.refreshState();
    return true;
  } catch (err) {
    K.cancelGone(ws);
    if (err && err.code === 'last_manager') return managersFirst(err.channels || []);
    if (err && err.code === 'last_owner') return lastOwner();
    toast(K.errorText(err), 5000);
    return false;
  }
}

// The channels the person is the only manager of: each opens its members dialog to hand it over.
async function managersFirst(channelIds) {
  const rooms = channelIds.map((id) => K.CH.rooms.get(id) || (K.CH.view?.channels || []).find((c) => c.id === id)).filter(Boolean);
  const picked = await wsDialog({
    title: t('chat.workspace.leave'),
    buttons: [closeButton()],
    render(body, done) {
      // Each channel with a Members button, which is where a manager hands it over.
      body.innerHTML = `<p>${esc(t('chat.leave.managerFirst'))}</p><ul class="ch-browse">${rooms
        .map(
          (r) =>
            `<li class="ch-browse-row"><span class="ch-browse-open"><span class="ch-browse-ic" aria-hidden="true">${channelIcon(r)}</span><span class="ch-browse-text"><span class="ch-browse-name">${esc(
              r.name || ''
            )}</span></span></span><button type="button" class="btn secondary sm" data-room="${esc(r.id)}" aria-label="${esc(
              t('chat.channel.membersTitle', { name: r.name || '' })
            )}">${icons.people}<span>${esc(t('chat.head.membersButton'))}</span></button></li>`
        )
        .join('')}</ul>`;
      body.addEventListener('click', (e) => {
        const b = e.target.closest('[data-room]');
        if (b) done(b.dataset.room);
      });
    }
  });
  const room = picked && K.CH.rooms.get(picked);
  if (room) {
    K.openRoom(room.id);
    await channelMembers(room);
  }
  return false;
}

// The only owner can't leave. With nobody else left, deleting the workspace is the way out (contract 5.10).
async function lastOwner() {
  const alone = activeMembers().length <= 1;
  const choice = await wsDialog({
    title: t('chat.workspace.leave'),
    buttons: alone
      ? [{ get label() { return t('chat.workspace.delete'); }, value: 'delete', danger: true, left: true }, { get label() { return t('common.actions.ok'); }, value: null }]
      : [{ get label() { return t('common.actions.ok'); }, value: null }],
    render(body) {
      body.innerHTML = `<p>${esc(t('chat.leave.lastOwner'))}</p>${alone ? `<p>${esc(t('chat.leave.deleteInstead', { workspace: wsName() }))}</p>` : ''}`;
    }
  });
  if (choice === 'delete') return deleteWorkspace();
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

// Block someone (desktop-ui 6.13, contract 3.12): what a block does, and that they may notice.
export async function blockMember(member) {
  const ws = K.CH.ws;
  if (!ws || !member || member === K.me()) return false;
  const name = nameOf(member);
  const ok = await confirmDialog(t('chat.block.title', { name }), t('chat.block.body', { name }), t('chat.block.confirm'), true);
  if (!ok || ws !== K.CH.ws) return false;
  try {
    const res = await api('chatBlock', ws, member);
    K.setBlocks(res && res.blocks);
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
  if (!ws || !member) return false;
  const name = nameOf(member);
  try {
    const res = await api('chatUnblock', ws, member);
    K.setBlocks(res && res.blocks);
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
    const groups = ROLES.map((role) => ({ role, people: list.filter((m) => m.role === role) })).filter((g) => g.people.length);
    const row = (m) => {
      const mine = m.id === K.me();
      const label = mine ? t('chat.members.you', { name: displayName(m, t) }) : displayName(m, t);
      const blocked = K.CH.blocks.has(m.id);
      const hasMenu = !mine && menuFor(m).length;
      return `<li class="ch-person">${K.memberAvatar(m.id, 'ch-av-24')}<span class="ch-person-name">${esc(label)}</span>${
        blocked ? `<span class="ch-tag">${esc(t('chat.members.blocked'))}</span>` : ''
      }${
        hasMenu
          ? `<button type="button" class="icon-btn xs" data-person="${esc(m.id)}" aria-haspopup="menu" aria-label="${esc(t('chat.members.more', { name: displayName(m, t) }))}" title="${esc(
              t('chat.members.more', { name: displayName(m, t) })
            )}">${icons.more}</button>`
          : ''
      }</li>`;
    };
    const titles = { owner: 'chat.roles.owners', admin: 'chat.roles.admins', member: 'chat.roles.members', guest: 'chat.roles.guests' };
    body.querySelector('[data-people]').innerHTML = groups.length
      ? groups.map((g) => `<li class="ch-group" role="presentation"><span>${esc(t(titles[g.role]))}</span></li>${g.people.map(row).join('')}`).join('')
      : `<li class="ch-browse-none">${esc(t('chat.new.none'))}</li>`;
  };
  // What may be done to m (desktop-ui 6.15).
  const menuFor = (m) => {
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
  const setRole = async (m, role) => {
    try {
      await api('chatSetRole', ws, m.id, role);
      await K.reload();
      later();
    } catch (err) {
      showError(body, '', K.errorText(err));
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
  const draw = () => {
    if (!body || !body.isConnected) return;
    const me = K.CH.view?.me || { name: nameOf(K.me()), role: K.myRole() };
    const myRole = K.myRole();
    const limits = K.CH.state?.limits;
    const blocks = [...K.CH.blocks].sort((a, b) => collator().compare(nameOf(a), nameOf(b)));
    const alone = activeMembers().length <= 1;
    const section = (title, inner) => `<section class="ch-set"><h3 class="ch-set-title">${esc(title)}</h3>${inner}</section>`;
    const you = section(
      t('chat.settings.you'),
      `<div class="ch-set-row"><span class="ch-set-text"><span class="ch-set-label">${esc(t('chat.name.title', { workspace: wsName() }))}</span><span class="ch-set-value">${esc(me.name || '')}</span></span>
        <button type="button" class="btn secondary sm" data-set="name">${esc(t('chat.workspace.yourName'))}</button></div>
       <div class="ch-set-row"><span class="ch-set-text"><span class="ch-set-label">${esc(t('chat.settings.role'))}</span><span class="ch-set-value">${esc(roleText(myRole))}</span></span></div>`
    );
    const host = section(t('chat.settings.host'), `${K.hostNote()}${limits && limits.members ? `<p class="field-help ch-set-help">${esc(t('chat.settings.limits', { members: limits.members }))}</p>` : ''}`);
    const invites = isAdmin()
      ? section(
          t('chat.settings.invitations'),
          `<details class="ch-open-invites"><summary>${esc(t('chat.invite.open'))}</summary><ul class="ch-invites"></ul></details>
           <div><button type="button" class="btn secondary sm" data-set="invite">${icons.userPlus}<span>${esc(t('chat.workspace.invite'))}</span></button></div>`
        )
      : '';
    const blocked =
      myRole !== 'guest' || blocks.length
        ? section(
            t('chat.block.list'),
            blocks.length
              ? `<ul class="ch-people">${blocks
                  .map(
                    (id) =>
                      `<li class="ch-person">${K.memberAvatar(id, 'ch-av-24')}<span class="ch-person-name">${esc(nameOf(id))}</span><button type="button" class="btn secondary sm" data-unblock="${esc(id)}" data-busy-off>${esc(
                        t('chat.block.unblock')
                      )}</button></li>`
                  )
                  .join('')}</ul>`
              : `<p class="field-help ch-set-help">${esc(t('chat.block.none'))}</p>`
          )
        : '';
    // Leave, and for an owner Delete, side by side at the end; Delete says why it is off while others are in it.
    const del =
      myRole === 'owner'
        ? `<button type="button" class="btn sm ch-danger-btn" data-set="delete"${alone ? '' : ' disabled aria-describedby="ch-delete-why"'}>${icons.trash}<span>${esc(t('chat.delete.submit'))}</span></button>`
        : '';
    const why = myRole === 'owner' && !alone ? `<p class="field-help ch-set-help ch-set-why" id="ch-delete-why">${esc(t('chat.delete.onlyYou'))}</p>` : '';
    const leave = `<section class="ch-set ch-set-leave"><div class="ch-set-row ch-set-end"><button type="button" class="btn sm ch-danger-btn" data-set="leave">${icons.leave}<span>${esc(
      t('chat.workspace.leave')
    )}</span></button>${del}</div>${why}</section>`;
    const openInvites = body.querySelector('.ch-open-invites')?.open;
    body.innerHTML = `${you}${host}${invites}${blocked}${leave}<p class="error" data-error="" hidden></p>`;
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
    render(b, done) {
      body = b;
      closeDialog = done;
      draw();
      body.addEventListener('click', async (e) => {
        const un = e.target.closest('[data-unblock]');
        if (un) {
          un.disabled = true;
          await unblockMember(un.dataset.unblock);
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
  top.push({ icon: 'edit', label: t('chat.workspace.yourName'), action: () => changeName() });
  top.push({ icon: 'settings', label: t('chat.workspace.settings'), action: () => workspaceSettings() });
  const bottom = [{ icon: 'leave', label: t('chat.workspace.leave'), danger: true, action: () => leaveWorkspace() }];
  // Delete only works for an owner who is the only member; while others are in it, Workspace settings says why it's off.
  if (K.myRole() === 'owner' && activeMembers().length <= 1) bottom.push({ icon: 'trash', label: t('chat.workspace.delete'), danger: true, action: () => deleteWorkspace() });
  return { top, bottom };
}

// ---------- direct messages (desktop-ui 6.11, contract 3.12) ----------

const PICK_MAX = 7;

export async function newMessage(prefill = []) {
  const ws = K.CH.ws;
  if (!ws || K.isGuest()) return null;
  const mine = K.me();
  // Active full members, without you and without people you blocked (contract 3.12).
  const people = () =>
    activeMembers()
      .filter((m) => m.id !== mine && m.role !== 'guest' && !K.CH.blocks.has(m.id))
      .sort((a, b) => collator().compare(displayName(a, t), displayName(b, t)));
  const picked = prefill.filter((id) => people().some((m) => m.id === id)).slice(0, PICK_MAX);
  let active = 0;
  let busy = false;
  let finish = null;
  let body = null;
  let scrim = null;

  const shown = () => {
    const q = fold(body.querySelector('[name="to"]').value.trim());
    return people().filter((m) => !picked.includes(m.id) && (!q || fold(displayName(m, t)).includes(q)));
  };
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
    const rows = shown();
    const full = picked.length >= PICK_MAX;
    if (active >= rows.length) active = Math.max(0, rows.length - 1);
    const ul = body.querySelector('[data-list]');
    ul.innerHTML = rows.length
      ? rows
          .map(
            (m, i) =>
              `<li role="option" id="ch-new-opt-${i}" class="ch-new-row${i === active && !full ? ' is-active' : ''}" data-pick="${esc(m.id)}" aria-selected="${i === active && !full}"${full ? ' aria-disabled="true"' : ''}>${K.memberAvatar(
                m.id,
                'ch-av-24'
              )}<span class="ch-person-name">${esc(displayName(m, t))}</span></li>`
          )
          .join('')
      : `<li class="ch-browse-none" role="presentation">${esc(t('chat.new.none'))}</li>`;
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

// Leave a conversation (contract 3.12, 5.10): an open DM closes for everyone in it; a closed one leaves the list.
export async function leaveConversation(room) {
  const ws = K.CH.ws;
  if (!ws || !room) return false;
  const ok = await confirmDialog(t('chat.leaveDm.title'), t(room.closedReason ? 'chat.leaveDm.bodyClosed' : 'chat.leaveDm.body'), t('chat.leaveDm.submit'), true);
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
