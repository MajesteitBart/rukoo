// Settings > Inbox categories: turning them on, the categories themselves, what gets mail Rukoo isn't sure about,
// Jev, and the senders with a rule. The main process keeps all of it (src/main/categories/).
import { t } from './i18n.js';
import { icons } from './icons.js';
import { api, esc, toast, dialog, confirmDialog, choiceDialog, KEEP_OPEN } from './ui.js';

export const CATEGORY_VIEWS = ['categories'];
const COLORS = ['#ff5d73', '#4a7dff', '#2fd6c0', '#f5c542', '#c56cf0', '#ff8a3d', '#5ec2ff', '#7a808e'];

// Edits a category, or makes a new one (c null). Resolves to { name, description, color, notify }, 'restore', 'delete'
// or null. notify: whether its new mail sends a notification on this computer.
function categoryDialog(c, { canDelete, notify }) {
  let color = (c && c.color) || COLORS[0];
  const buttons = [];
  if (c && canDelete) buttons.push({ get label() { return t('common.actions.delete'); }, value: 'delete', danger: true, left: true });
  if (c && c.preset && (c.custom.name || c.custom.description)) buttons.push({ get label() { return t('settings.categories.restore'); }, value: 'restore', left: true });
  buttons.push({ get label() { return t('common.actions.cancel'); }, value: null });
  buttons.push({
    get label() { return c ? t('common.actions.save') : t('common.actions.add'); },
    value: (scrim) => {
      const name = scrim.querySelector('[name="name"]');
      const description = scrim.querySelector('[name="description"]');
      if (!name.value.trim() && !(c && c.preset)) {
        scrim.querySelector('[data-error]').textContent = t('categories.errors.needName');
        name.focus();
        return KEEP_OPEN;
      }
      return { name: name.value.trim(), description: description.value.trim(), color, notify };
    }
  });
  return dialog({
    title: c ? t('settings.categories.editTitle') : t('settings.categories.newTitle'),
    wide: true,
    buttons,
    render(body) {
      const swatches = COLORS.map(
        (value) => `<button type="button" class="cat-swatch" role="radio" aria-checked="${value === color}" data-color="${value}" style="--cat:${value}" aria-label="${value}"></button>`
      ).join('');
      body.innerHTML = `<div class="form" style="padding:0">
        <label>${esc(t('settings.categories.name'))}<input type="text" name="name" maxlength="40" value="${esc(c ? c.name : '')}"/></label>
        <label>${esc(t('settings.categories.description'))}<textarea name="description" maxlength="400">${esc(c ? c.description : '')}</textarea>
          <span class="field-help">${esc(t('settings.categories.descriptionHelp'))}</span></label>
        <div class="cat-colors"><span>${esc(t('settings.categories.color'))}</span><div role="radiogroup">${swatches}</div></div>
        <button type="button" class="cat-notify" role="switch" aria-checked="${notify}" aria-labelledby="cat-notify-title" aria-describedby="cat-notify-help">
          <span class="text"><span class="title" id="cat-notify-title">${esc(t('settings.categories.notify'))}</span><span class="field-help" id="cat-notify-help">${esc(t('settings.categories.notifyHelp'))}</span></span>
          <span class="switch ${notify ? 'on' : ''}" aria-hidden="true"></span>
        </button>
        <div class="error" data-error></div></div>`;
      body.querySelectorAll('.cat-swatch').forEach((b) =>
        b.addEventListener('click', () => {
          color = b.dataset.color;
          body.querySelectorAll('.cat-swatch').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
        })
      );
      const toggle = body.querySelector('.cat-notify');
      toggle.addEventListener('click', () => {
        notify = !notify;
        toggle.setAttribute('aria-checked', String(notify));
        toggle.querySelector('.switch').classList.toggle('on', notify);
      });
    }
  });
}

// The TypeSafe key: a new one, 'remove', or null.
function keyDialog(hasKey) {
  const buttons = [];
  if (hasKey) buttons.push({ get label() { return t('settings.categories.keyRemove'); }, value: 'remove', danger: true, left: true });
  buttons.push({ get label() { return t('common.actions.cancel'); }, value: null });
  buttons.push({
    get label() { return t('common.actions.save'); },
    value: (scrim) => {
      const input = scrim.querySelector('input');
      if (!input.value.trim()) return input.focus(), KEEP_OPEN;
      return input.value.trim();
    }
  });
  return dialog({
    title: t('settings.categories.keyPrompt'),
    buttons,
    render(body) {
      body.innerHTML = `<div class="form" style="padding:0"><p>${esc(t('settings.categories.jevShares'))}</p>
        <input class="form-input" type="password" autocomplete="off" spellcheck="false"/></div>`;
    }
  });
}

// pages: what settings.js needs. row: its row helper; go and rerender: its navigation; current(): the page on top.
export function categoryPages({ row, go, rerender, current }) {
  let state = null;
  // What the sorting is doing (categories/index.js, activity()): "Sort the inbox again" counts along.
  let activity = null;

  async function prepare() {
    [state, activity] = await Promise.all([api('categoriesState').catch(() => state), api('categoriesActivity').catch(() => activity)]);
  }

  function onState(next) {
    state = next;
    if (current() === 'categories') rerender();
  }

  const againDesc = () => (activity && activity.running ? t('categories.activity.progress', { done: activity.done, total: activity.total }) : t('settings.categories.againHelp'));

  // Many times a second while Jev sorts: only the line under "Sort the inbox again" changes.
  function onActivity(next) {
    activity = next;
    const desc = document.querySelector('.page.settings [data-a="cat-again"] .desc');
    if (desc) desc.textContent = againDesc();
  }

  // The row on the Settings overview.
  function rowHtml() {
    return row({
      title: esc(t('settings.general.categories')),
      value: esc(state && state.enabled ? t('settings.general.categoriesOn') : t('settings.general.categoriesOff')),
      action: 'categories'
    });
  }

  const nameOf = (id) => ((state.categories.find((c) => c.id === id) || {}).name || '');

  function categoryRows() {
    const list = state.categories;
    return list
      .map(
        (c, i) => `
      <div class="row static cat-row">
        <button class="cat-main" data-a="cat-edit:${esc(c.id)}">
          <span class="cat-dot" style="--cat:${esc(c.color)}" aria-hidden="true"></span>
          <span class="text"><span class="title">${esc(c.name)}</span>${c.description ? `<span class="desc">${esc(c.description)}</span>` : ''}</span>
          ${state.muted.includes(c.id) ? `<span class="cat-muted" role="img" title="${esc(t('settings.categories.notifyOff'))}" aria-label="${esc(t('settings.categories.notifyOff'))}">${icons.bellOff}</span>` : ''}
        </button>
        <button class="icon-btn" data-a="cat-up:${esc(c.id)}" ${i === 0 ? 'disabled' : ''} title="${esc(t('settings.categories.up'))}" aria-label="${esc(t('settings.categories.up'))}">${icons.up}</button>
        <button class="icon-btn" data-a="cat-down:${esc(c.id)}" ${i === list.length - 1 ? 'disabled' : ''} title="${esc(t('settings.categories.down'))}" aria-label="${esc(t('settings.categories.down'))}">${icons.down}</button>
      </div>`
      )
      .join('');
  }

  function view() {
    if (!state) return { title: t('settings.categories.title'), body: '' };
    const jevDesc = [esc(t('settings.categories.jevHelp')), state.jev.error ? `<span class="error">${esc(t(`settings.categories.jevError.${state.jev.error}`))}</span>` : ''].filter(Boolean).join('<br>');
    const body = `
      <div class="card">${row({ title: esc(t('settings.categories.on')), desc: esc(t('settings.categories.onHelp')), action: 'cat-toggle', toggle: state.enabled })}</div>
      <p class="settings-text">${esc(t(state.signedIn ? 'settings.categories.sync' : 'settings.categories.syncLocal'))}</p>
      ${
        state.enabled
          ? `<div class="settings-group-title">${esc(t('settings.categories.list'))}</div>
      <div class="card">
        ${categoryRows()}
        ${state.categories.length < state.limit ? row({ title: esc(t('settings.categories.add')), action: 'cat-add', cls: 'indent', lead: `<span class="add-ic">${icons.plus}</span>` }) : ''}
      </div>
      <p class="settings-text">${esc(t('settings.categories.listHelp'))}</p>
      <div class="card">${row({ title: esc(t('settings.categories.unsure')), value: esc(nameOf(state.unsure)), action: 'cat-unsure' })}</div>
      <div class="settings-group-title">${esc(t('settings.categories.sorting'))}</div>
      <p class="settings-text">${esc(t('settings.categories.rules'))}</p>
      <div class="card">
        ${row({ title: esc(t('settings.categories.jev')), desc: jevDesc, action: 'cat-jev', toggle: state.jev.on })}
        ${row({ title: esc(t('settings.categories.key')), value: esc(t(state.jev.hasKey ? 'settings.categories.keySet' : 'settings.categories.keyMissing')), action: 'cat-key' })}
      </div>
      <p class="settings-text">${esc(t('settings.categories.jevShares'))}</p>
      <div class="card">${row({ title: esc(t('settings.categories.again')), desc: esc(againDesc()), action: 'cat-again' })}</div>
      ${
        state.senders.length
          ? `<div class="settings-group-title">${esc(t('settings.categories.senders'))}</div>
      <div class="card">${state.senders
        .map((s) => row({ title: esc(s.address), desc: esc(t('settings.categories.senderHelp', { name: nameOf(s.category) })), action: `cat-sender:${encodeURIComponent(s.address)}` }))
        .join('')}</div>`
          : ''
      }`
          : ''
      }`;
    return { title: t('settings.categories.title'), body };
  }

  const run = async (work, done) => {
    try {
      const res = await work();
      if (res && typeof res === 'object' && Array.isArray(res.categories)) state = res;
      if (done) toast(typeof done === 'function' ? done(res) : done);
    } catch (err) {
      toast(err.message, 6000);
    }
    await prepare();
    rerender();
  };

  const move = (id, by) => {
    const ids = state.categories.map((c) => c.id);
    const i = ids.indexOf(id);
    const j = i + by;
    if (i < 0 || j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    return run(() => api('categoriesReorder', ids));
  };

  async function editCategory(id) {
    const c = id ? state.categories.find((x) => x.id === id) : null;
    const notify = !(c && state.muted.includes(c.id));
    const v = await categoryDialog(c, { canDelete: state.categories.length > 1, notify });
    if (!v) return;
    if (v === 'restore') return run(() => api('categoriesSave', { id, name: null, description: null }));
    if (v === 'delete') {
      const ok = await confirmDialog(t('settings.categories.deleteTitle', { name: c.name }), t('settings.categories.deleteHelp'), t('common.actions.delete'), true);
      if (ok) await run(() => api('categoriesRemove', id));
      return;
    }
    // A preset keeps following the language until its text is changed.
    const name = c && c.preset && v.name === c.name && !c.custom.name ? undefined : v.name || null;
    const description = c && c.preset && v.description === c.description && !c.custom.description ? undefined : v.description || null;
    const before = state.categories.map((x) => x.id);
    return run(async () => {
      const res = await api('categoriesSave', { id: id || null, name, description, color: v.color });
      if (v.notify === notify) return res;
      // Notifications stay on this computer, apart from the category's synced record. A new one is the id that wasn't
      // there before.
      const saved = id || (res.categories.find((x) => !before.includes(x.id)) || {}).id;
      return saved ? api('categoriesSetNotify', saved, v.notify) : res;
    });
  }

  // Handles a data-a action of these pages; false when it isn't one.
  async function click(a) {
    if (a === 'categories') return go('categories'), true;
    if (a.startsWith('cat-edit:')) return editCategory(a.slice(9)), true;
    if (a.startsWith('cat-up:')) return move(a.slice(7), -1), true;
    if (a.startsWith('cat-down:')) return move(a.slice(9), 1), true;
    if (a.startsWith('cat-sender:')) {
      const address = decodeURIComponent(a.slice(11));
      const ok = await confirmDialog(t('settings.categories.senderRemove', { sender: address }), t('settings.categories.senderRemoveHelp'), t('common.actions.delete'), true);
      if (ok) await run(() => api('categoriesForgetSender', address));
      return true;
    }
    switch (a) {
      case 'cat-toggle':
        await run(() => api('categoriesSetEnabled', !state.enabled));
        return true;
      case 'cat-add':
        await editCategory(null);
        return true;
      case 'cat-unsure': {
        const id = await choiceDialog(t('settings.categories.unsure'), state.categories.map((c) => ({ value: c.id, label: c.name })), state.unsure);
        if (id) await run(() => api('categoriesSetUnsure', id));
        return true;
      }
      case 'cat-jev':
        if (!state.jev.on && !state.jev.hasKey) {
          toast(t('settings.categories.needKey'));
          return click('cat-key');
        }
        await run(() => api('categoriesSetJev', { on: !state.jev.on }));
        return true;
      case 'cat-key': {
        const v = await keyDialog(state.jev.hasKey);
        if (v === 'remove') await run(() => api('categoriesSetJev', { key: null, on: false }));
        else if (v) await run(() => api('categoriesSetJev', { key: v, on: true }));
        return true;
      }
      case 'cat-again':
        await run(() => api('categoriesSortAgain'), (count) => t('settings.categories.againDone', { count: Number(count) || 0 }));
        return true;
    }
    return false;
  }

  return { prepare, onState, onActivity, rowHtml, view, click, enabled: () => Boolean(state && state.enabled), jevOn: () => Boolean(state && state.jev.on) };
}
