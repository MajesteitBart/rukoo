import { t, languages, setLanguage, localize } from './i18n.js';
import { icons } from './icons.js';
import { api, brandLogo, esc, toast, dialog, confirmDialog, choiceDialog, numericDate, hhmm, KEEP_OPEN } from './ui.js';
import { icon as panelIcon } from './agent/bui.js';
import {
  ACTIONS,
  shortcutList,
  storedShortcuts,
  SHORTCUT_ICONS,
  SHORTCUT_NAME,
  SHORTCUT_RESERVED,
  SHORTCUTS_MAX,
  SHORTCUT_LABEL_MAX,
  SHORTCUT_PROMPT_MAX
} from './agent/actions.js';

const THEMES = [
  { value: 'system', get label() { return t('settings.theme.system'); } },
  { value: 'light', get label() { return t('settings.theme.light'); } },
  { value: 'dark', get label() { return t('settings.theme.dark'); } }
];
const DENSITY = [
  { value: 'standard', get label() { return t('settings.density.standard'); }, get hint() { return t('settings.density.standardHint'); } },
  { value: 'compact', get label() { return t('settings.density.compact'); }, get hint() { return t('settings.density.compactHint'); } }
];
const BADGES = [
  { value: 'new', get label() { return t('settings.badge.new'); } },
  { value: 'unread', get label() { return t('settings.badge.unread'); } },
  { value: 'none', get label() { return t('common.values.none'); } }
];
const INTERVALS = [
  { value: 0, get label() { return t('settings.sync.manual'); } },
  { value: 1, get label() { return t('settings.sync.minute'); } },
  { value: 5, get label() { return t('settings.sync.fiveMinutes'); } },
  { value: 15, get label() { return t('settings.sync.fifteenMinutes'); } },
  { value: 30, get label() { return t('settings.sync.thirtyMinutes'); } },
  { value: 60, get label() { return t('settings.sync.hour'); } }
];
const COLORS = [
  { value: '#2fd6c0', get label() { return t('settings.colors.turquoise'); } },
  { value: '#4a7dff', get label() { return t('settings.colors.blue'); } },
  { value: '#ff8a3d', get label() { return t('settings.colors.orange'); } },
  { value: '#c56cf0', get label() { return t('settings.colors.purple'); } },
  { value: '#f5c542', get label() { return t('settings.colors.yellow'); } },
  { value: '#ff5d73', get label() { return t('settings.colors.red'); } },
  { value: '#5ec2ff', get label() { return t('settings.colors.lightBlue'); } }
];
const hideableViews = () => [
  ['vip', t('mailbox.folders.vip')],
  ['starred', t('mailbox.folders.starred')],
  ['saved', t('mailbox.folders.saved')],
  ['drafts', t('mailbox.folders.drafts')],
  ['sent', t('mailbox.folders.sent')],
  ['trash', t('mailbox.folders.trash')],
  ['junk', t('mailbox.folders.junk')],
  ['archive', t('mailbox.folders.archive')]
];

const labelOf = (list, value) => (list.find((x) => x.value === value) || list[0]).label;
const hostOf = (url) => {
  try {
    return new URL(url).host;
  } catch (_) {
    return url;
  }
};

const AGENT_IDS = ['clark', 'claude', 'codex'];
const AGENT_PRODUCTS = { clark: 'Hermes Agent', claude: 'Claude Code', codex: 'Codex' };
const AGENT_STATES = ['starting', 'ready', 'offline', 'unconfigured', 'disabled', 'missing', 'unauthorized', 'unknown'];
const ACCESS = [
  { value: 'ask', get label() { return t('settings.agents.accessAsk'); }, get hint() { return t('settings.agents.accessAskHint'); } },
  { value: 'full', get label() { return t('settings.agents.accessFull'); }, get hint() { return t('settings.agents.accessFullHint'); } }
];
const agentName = (config, id) => (id === 'clark' ? (config && config.clark && config.clark.name) || 'Hermes' : id === 'claude' ? 'Claude' : 'Codex');
const agentStateOf = (status, id) => {
  const s = status && status[id] ? status[id].state : 'starting';
  return AGENT_STATES.includes(s) ? s : 'unknown';
};
const agentDot = (state) => (state === 'ready' ? 'ready' : state === 'offline' || state === 'unauthorized' ? 'offline' : state === 'starting' ? 'starting' : 'unconfigured');

// When a shortcut shows in a new chat, for its row in Settings.
const shortcutWhen = (s) =>
  s.custom
    ? s.when === 'always'
      ? t('settings.shortcuts.whenAlways')
      : t('settings.shortcuts.whenEmail')
    : s.needsUnsubscribe
      ? t('settings.shortcuts.whenNewsletter')
      : s.needsEmail
        ? t('settings.shortcuts.whenEmail')
        : t('settings.shortcuts.whenNoEmail');

// Edits one shortcut, or makes a new one of the user's (s null). list: all shortcuts, to keep commands unique.
// Resolves to {label, prompt, key, icon, when}, 'restore' (back to Rukoo's own), 'delete', or null.
function shortcutDialog(s, list) {
  const fresh = !s;
  const custom = fresh || s.custom;
  let iconName = custom ? (s && s.icon) || 'sparkle' : s.icon;
  let when = custom ? (s && s.when) || 'email' : null;
  const buttons = [];
  if (s && s.custom) buttons.push({ get label() { return t('common.actions.delete'); }, value: 'delete', danger: true });
  if (s && !s.custom && (s.edited.label || s.edited.prompt)) buttons.push({ get label() { return t('settings.shortcuts.restore'); }, value: 'restore', left: true });
  buttons.push({ get label() { return t('common.actions.cancel'); }, value: null });
  buttons.push({
    get label() {
      return fresh ? t('common.actions.add') : t('common.actions.save');
    },
    value: (scrim) => {
      const form = scrim.querySelector('.shortcut-form');
      const error = form.querySelector('[data-error]');
      const field = (name) => form.querySelector(`[name="${name}"]`);
      const fail = (name, message) => {
        error.textContent = message;
        field(name).focus();
        return KEEP_OPEN;
      };
      const label = field('label').value.trim();
      const prompt = field('prompt').value.trim();
      if (!label) return fail('label', t('settings.shortcuts.needLabel'));
      if (!prompt) return fail('prompt', t('settings.shortcuts.needPrompt'));
      if (!custom) return { label, prompt };
      const key = field('key').value.trim().replace(/^\//, '').toLowerCase();
      if (!SHORTCUT_NAME.test(key) || key.length > 40) return fail('key', t('settings.shortcuts.badCommand'));
      const taken = SHORTCUT_RESERVED.has(key) || ACTIONS.some((a) => a.key === key) || list.some((x) => x.key === key && x !== s);
      if (taken) return fail('key', t('settings.shortcuts.takenCommand', { name: key }));
      return { label, prompt, key, icon: iconName, when };
    }
  });
  return dialog({
    title: fresh ? t('settings.shortcuts.newTitle') : t('settings.shortcuts.editTitle'),
    wide: true,
    buttons,
    render(body) {
      const icons = SHORTCUT_ICONS.map(
        (name) =>
          `<button type="button" class="shortcut-icon" role="radio" data-icon="${name}" aria-checked="${name === iconName}" aria-label="${esc(name)}">${panelIcon(name, 15).outerHTML}</button>`
      ).join('');
      const whenRow = (value, label) =>
        `<button type="button" class="radio-row" role="radio" data-when="${value}" aria-checked="${value === when}"><span class="radio ${value === when ? 'on' : ''}"></span><span class="rl">${esc(label)}</span></button>`;
      body.innerHTML = `<div class="form shortcut-form" style="padding:0">
        <label>${esc(t('settings.shortcuts.label'))}<input type="text" name="label" maxlength="${SHORTCUT_LABEL_MAX}" spellcheck="false" autocomplete="off" value="${esc(s ? s.label : '')}"/></label>
        <label>${esc(t('settings.shortcuts.command'))}<span class="shortcut-command"><span aria-hidden="true">/</span><input type="text" name="key" maxlength="40" spellcheck="false" autocomplete="off" value="${esc(s ? s.key : '')}" ${custom ? '' : 'disabled'} placeholder="${esc(t('settings.shortcuts.commandPlaceholder'))}"/></span>
          <span class="field-help">${esc(custom ? t('settings.shortcuts.commandHelp') : t('settings.shortcuts.commandFixed'))}</span></label>
        ${
          custom
            ? `<div class="shortcut-field"><span class="shortcut-field-label" id="shortcut-when">${esc(t('settings.shortcuts.when'))}</span>
          <div class="choices" role="radiogroup" aria-labelledby="shortcut-when">${whenRow('email', t('settings.shortcuts.whenEmailOption'))}${whenRow('always', t('settings.shortcuts.whenAlwaysOption'))}</div></div>
        <div class="shortcut-field"><span class="shortcut-field-label" id="shortcut-icon">${esc(t('settings.shortcuts.icon'))}</span>
          <div class="shortcut-icons" role="radiogroup" aria-labelledby="shortcut-icon">${icons}</div></div>`
            : ''
        }
        <label>${esc(t('settings.shortcuts.prompt'))}<textarea name="prompt" rows="7" maxlength="${SHORTCUT_PROMPT_MAX}" spellcheck="false">${esc(s ? s.prompt : '')}</textarea>
          <span class="field-help">${esc(custom ? t('settings.shortcuts.promptHelp') : t('settings.shortcuts.promptHelpBuiltin'))}</span></label>
        <div class="error" data-error></div>
      </div>`;
      // An error is about what the field held: it goes once the user changes it.
      body.querySelector('.shortcut-form').addEventListener('input', () => (body.querySelector('[data-error]').textContent = ''));
      body.querySelectorAll('[data-when]').forEach((b) =>
        b.addEventListener('click', () => {
          when = b.dataset.when;
          body.querySelectorAll('[data-when]').forEach((x) => {
            x.setAttribute('aria-checked', String(x === b));
            x.querySelector('.radio').classList.toggle('on', x === b);
          });
        })
      );
      body.querySelectorAll('[data-icon]').forEach((b) =>
        b.addEventListener('click', () => {
          iconName = b.dataset.icon;
          body.querySelectorAll('[data-icon]').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
        })
      );
    }
  });
}

export function promptDialog(title, value = '', { multiline = false, placeholder = '' } = {}) {
  return dialog({
    title,
    buttons: [
      { get label() { return t('common.actions.cancel'); }, value: null },
      { get label() { return t('common.actions.save'); }, value: (scrim) => scrim.querySelector('.form-input').value }
    ],
    render(body) {
      body.innerHTML = `<div class="form" style="padding:0">${
        multiline
          ? `<textarea class="form-input" placeholder="${esc(placeholder)}">${esc(value)}</textarea>`
          : `<input class="form-input" type="text" value="${esc(value)}" placeholder="${esc(placeholder)}"/>`
      }</div>`;
    }
  });
}

// view: open straight on one page (the chat panel opens 'agents'); Back still leads to the overview. An account's
// 'server' page needs the account's id, and Back from it leads to that account.
export function openSettings(ctx, { view: start, id = null } = {}) {
  const page = document.createElement('div');
  page.className = 'page settings';
  document.getElementById('overlays').appendChild(page);
  const stack = !start ? ['main'] : start === 'server' ? ['main', 'account', 'server'] : start === 'shortcuts' ? ['main', 'agents', 'shortcuts'] : ['main', start];
  let params = id ? { id } : {};

  // Live status (sync times, errors) matters on the overview pages; forms must not be reset under the user.
  const unsubscribe = window.mail.on(({ type, payload }) => {
    const view = stack[stack.length - 1];
    if (type === 'updated' && (view === 'main' || view === 'account')) setTimeout(render, 80);
    // Agent status changes only touch the status lines, never the fields you are typing in.
    if (type === 'agent' && payload && payload.kind === 'agents' && (view === 'agents' || view === 'main') && agentState) {
      agentState.status = payload.status || agentState.status;
      showAgentStatuses(view);
    }
    // Zoom keys and the wheel work with Settings open; only the zoom row changes.
    if (type === 'zoom') showZoom(payload);
  });

  const close = () => {
    unsubscribe();
    page.remove();
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('focus', showMailto);
  };
  const back = () => {
    if (stack.length > 1) {
      stack.pop();
      render();
    } else close();
  };
  const go = (name, p = {}) => {
    stack.push(name);
    params = p;
    render();
  };
  const onKey = (e) => {
    if (e.key === 'Escape' && !document.querySelector('.scrim')) {
      e.stopPropagation();
      back();
    }
  };
  document.addEventListener('keydown', onKey, true);

  const row = ({ title, desc, value, action, toggle, sep, cls = '', lead = '' }) => `
    <button class="row ${cls}" ${action ? `data-a="${action}"` : ''}>
      ${lead}
      <div class="text"><div class="title ${cls.includes('danger') ? 'danger' : ''}">${title}</div>
      ${desc ? `<div class="desc">${desc}</div>` : ''}${value ? `<div class="value">${value}</div>` : ''}</div>
      ${toggle !== undefined ? `${sep ? '<span class="switch-sep"></span>' : ''}<span class="switch ${toggle ? 'on' : ''}" role="switch" aria-checked="${toggle}"></span>` : ''}
    </button>`;

  // A static row, because the reset button can't sit inside a row button.
  const zoomRow = (level) => `
    <div class="row static" data-zoom>
      <div class="text"><div class="title">${esc(t('settings.general.zoom'))}</div>
        <div class="desc">${esc(t('settings.general.zoomHelp'))}</div>
        <div class="value" data-zoom-value>${esc(t('settings.general.zoomValue', { percent: level }))}</div></div>
      <button class="btn sm secondary" data-a="zoom-reset" ${level === 100 ? 'disabled' : ''}>${esc(t('settings.general.zoomReset'))}</button>
    </div>`;
  const showZoom = (level) => {
    const value = page.querySelector('[data-zoom-value]');
    if (!value || typeof level !== 'number') return;
    value.textContent = t('settings.general.zoomValue', { percent: level });
    page.querySelector('[data-a="zoom-reset"]').disabled = level === 100;
  };

  // Which app opens mailto: links: { available, app, rukoo } from main, or null until Windows has answered.
  let mailtoState = null;
  const mailtoValue = () => {
    if (!mailtoState) return '';
    if (!mailtoState.available) return t(mailtoState.linux ? 'settings.general.mailtoLinuxUnavailable' : 'settings.general.mailtoUnavailable');
    if (mailtoState.rukoo) return t('settings.general.mailtoRukoo');
    return mailtoState.app ? t('settings.general.mailtoHandler', { app: mailtoState.app }) : t('settings.general.mailtoNone');
  };
  const mailtoDisabled = () => !mailtoState || !mailtoState.available || mailtoState.rukoo;
  // A static row like the zoom row. The page draws with the last answer; showMailto() fills in the new one.
  const mailtoRow = () => `
    <div class="row static" data-mailto>
      <div class="text"><div class="title">${esc(t('settings.general.mailto'))}</div>
        <div class="desc" data-mailto-help>${esc(t(mailtoState?.linux ? 'settings.general.mailtoLinuxHelp' : 'settings.general.mailtoHelp'))}</div>
        <div class="value" data-mailto-value>${esc(mailtoValue())}</div></div>
      <button class="btn sm secondary" data-a="mailto-use" ${mailtoDisabled() ? 'disabled' : ''}>${esc(t('settings.general.mailtoUse'))}</button>
    </div>`;
  const showMailto = async () => {
    const next = await api('mailtoStatus').catch(() => null);
    if (!next) return;
    mailtoState = next;
    const value = page.querySelector('[data-mailto-value]');
    if (!value) return;
    value.textContent = mailtoValue();
    page.querySelector('[data-mailto-help]').textContent = t(mailtoState.linux ? 'settings.general.mailtoLinuxHelp' : 'settings.general.mailtoHelp');
    page.querySelector('[data-a="mailto-use"]').disabled = mailtoDisabled();
  };
  // The choice is made in Windows Settings; coming back to Rukoo shows the outcome.
  window.addEventListener('focus', showMailto);

  // ----- agents -----

  // { config, status } as shown on the agents page; config never holds secrets.
  let agentState = null;
  let keyEditing = false;
  // The config is local and quick. Status can wait on the network (an offline Hermes server takes seconds),
  // so pages draw with the last known status and refreshAgentStatus() fills it in afterwards.
  const loadAgents = () =>
    api('agentConfig')
      .then((config) => ({ config, status: (agentState && agentState.status) || null }))
      .catch(() => null);
  const agentsRowDesc = () =>
    t('settings.agents.rowDesc', { name: esc(agentName(agentState.config, agentState.config.defaultAgent)), status: t(`agent.status.${agentStateOf(agentState.status, agentState.config.defaultAgent)}`) });
  const showAgentStatuses = (view) => {
    if (!agentState) return;
    if (view === 'agents') AGENT_IDS.forEach((id) => showAgentStatus(id));
    const desc = view === 'main' && page.querySelector('[data-a="agents"] .desc');
    if (desc) desc.innerHTML = agentsRowDesc();
  };
  const refreshAgentStatus = (view) =>
    api('agentStatus')
      .then((status) => {
        if (!agentState || stack[stack.length - 1] !== view) return;
        agentState.status = status;
        showAgentStatuses(view);
      })
      .catch(() => {});
  // The agent's name appears in several labels; this span lets a rename update them in place.
  const nameSpan = (id) => `<span data-agent-name="${id}">${esc(agentName(agentState.config, id))}</span>`;

  const statusRow = (id) => `
    <div class="row static agent-status" data-agent-status="${id}">
      <span class="agent-dot" aria-hidden="true"></span>
      <div class="text"><div class="title"></div><div class="desc agent-detail"></div></div>
      ${id === 'clark'
        ? `<button class="btn sm secondary" data-a="agent-test:${id}" data-i18n="settings.agents.testConnection">${esc(t('settings.agents.testConnection'))}</button>`
        : `<button class="btn sm secondary" data-a="agent-test:${id}" data-i18n="settings.agents.test">${esc(t('settings.agents.test'))}</button>`}
    </div>`;
  function showAgentStatus(id, override) {
    const el = page.querySelector(`[data-agent-status="${id}"]`);
    if (!el || !agentState) return;
    const s = override || (agentState.status && agentState.status[id]) || {};
    const state = override && override.testing ? 'testing' : agentStateOf(agentState.status, id);
    el.querySelector('.agent-dot').dataset.state = state === 'testing' ? 'starting' : agentDot(state);
    el.querySelector('.title').textContent = state === 'testing' ? t('settings.agents.testing') : t(`agent.status.${state}`);
    el.querySelector('.agent-detail').textContent = state === 'testing' ? '' : String(s.detail || '');
    el.querySelector('button').disabled = state === 'testing';
  }

  const agentField = (id, key, label, value, placeholder) =>
    `<label>${esc(label)}<input type="text" data-agent-field="${id}.${key}" value="${esc(value || '')}" placeholder="${esc(placeholder || '')}" spellcheck="false" autocomplete="off"/></label>`;
  // Where the program was found, when main says so; otherwise what it looks for.
  const exeHint = (id, exe) => {
    const detail = String((agentState.status && agentState.status[id] && agentState.status[id].detail) || '');
    const found = agentState.config[id].detectedExe || (/[\\/].+\.exe$/i.test(detail) ? detail : '');
    return found || t('settings.agents.exeHint', { exe });
  };
  const keyHtml = () => {
    const saved = agentState.config.clark.hasKey;
    if (saved && !keyEditing) {
      return `<div class="agent-key"><span class="agent-key-label">${esc(t('settings.agents.key'))}</span>
        <span class="agent-key-saved">${icons.check}<span>${esc(t('settings.agents.keySaved'))}</span></span>
        <button class="link-btn" data-a="agent-key-replace">${esc(t('settings.agents.keyReplace'))}</button></div>`;
    }
    return `<label>${esc(t('settings.agents.key'))}<span class="pw"><input type="password" data-agent-key autocomplete="off" spellcheck="false" placeholder="${esc(t('settings.agents.keyPlaceholder'))}"/><button class="icon-btn sm" data-a="agent-key-reveal" title="${esc(t('settings.agents.keyShow'))}">${icons.eye}</button></span></label>
      <div class="agent-key-actions"><button class="btn sm" data-a="agent-key-save">${esc(t('settings.agents.keySave'))}</button>${saved ? `<button class="link-btn" data-a="agent-key-cancel">${esc(t('common.actions.cancel'))}</button>` : ''}</div>`;
  };
  // The port the remote listener really got (it moves when the chosen one is taken), the same as in the
  // copied Hermes setup, with main's note about the move. Clark signs in with the API key, so without one it can't.
  const remoteDesc = () => {
    const { mcp = {}, clark = {} } = agentState.config;
    const url = mcp.address ? esc(`http://${mcp.address}:${mcp.remotePort || mcp.port || mcp.localPort}/mcp`) : esc(t('settings.agents.noAddress'));
    const note = mcp.remote && !clark.hasKey ? t('settings.agents.remoteNeedsKey', { name: agentName(agentState.config, 'clark') }) : mcp.note;
    return note ? `${url}<span class="agent-note">${esc(note)}</span>` : url;
  };

  function agentsHtml() {
    const c = agentState.config;
    const accessRow = (id) => row({ title: t('settings.agents.access'), value: esc(labelOf(ACCESS, c[id].access)), action: `agent-access:${id}` });
    // The product beside the name ("Clark  Hermes Agent"), unless they are the same word.
    const head = (id) =>
      `<div class="settings-group-title agent-group">${nameSpan(id)}${AGENT_PRODUCTS[id] !== agentName(c, id) ? `<span class="agent-product">${esc(AGENT_PRODUCTS[id])}</span>` : ''}</div>`;
    return `
      <p class="settings-intro" data-i18n="settings.agents.help">${esc(t('settings.agents.help'))}</p>
      <div class="card">
        ${row({ title: t('settings.agents.default'), value: `<span data-agent-default>${esc(agentName(c, c.defaultAgent))}</span>`, action: 'agent-default' })}
        ${row({ title: t('settings.agents.shortcuts'), desc: t('settings.agents.shortcutsHelp'), action: 'agent-shortcuts' })}
        ${row({ title: t('settings.agents.autoMail'), desc: t('settings.agents.autoMailHelp'), action: 'agent-auto', toggle: Boolean(c.autoMailActions) })}
      </div>
      ${head('clark')}
      <div class="card agent-card">
        ${statusRow('clark')}
        ${row({ title: t('settings.agents.enabled', { name: nameSpan('clark') }), action: 'agent-enabled:clark', toggle: c.clark.enabled !== false })}
        <div class="form agent-form">
          ${agentField('clark', 'name', t('settings.agents.name'), c.clark.name, 'Hermes')}
          ${agentField('clark', 'url', t('settings.agents.url'), c.clark.url, 'http://100.64.0.1:8642')}
          <div class="agent-key-box">${keyHtml()}</div>
          ${agentField('clark', 'model', t('settings.agents.model'), c.clark.model, t('settings.agents.optional'))}
        </div>
        ${row({ title: t('settings.agents.remote', { name: nameSpan('clark') }), desc: `<span data-agent-address>${remoteDesc()}</span>`, action: 'agent-remote', toggle: Boolean(c.mcp && c.mcp.remote) })}
        ${row({ title: t('settings.agents.copySetup'), desc: t('settings.agents.copySetupHelp', { name: nameSpan('clark') }), action: 'agent-copy-setup' })}
      </div>
      ${head('claude')}
      <div class="card agent-card">
        ${statusRow('claude')}
        ${row({ title: t('settings.agents.enabled', { name: 'Claude' }), action: 'agent-enabled:claude', toggle: c.claude.enabled !== false })}
        <div class="form agent-form">
          ${agentField('claude', 'exe', t('settings.agents.exe'), c.claude.exe, exeHint('claude', 'claude.exe'))}
          ${agentField('claude', 'configDir', t('settings.agents.configDir'), c.claude.configDir, t('settings.agents.configDirHint'))}
          ${agentField('claude', 'model', t('settings.agents.model'), c.claude.model, t('settings.agents.modelHint', { example: 'opus' }))}
        </div>
        ${accessRow('claude')}
      </div>
      ${head('codex')}
      <div class="card agent-card">
        ${statusRow('codex')}
        ${row({ title: t('settings.agents.enabled', { name: 'Codex' }), action: 'agent-enabled:codex', toggle: c.codex.enabled !== false })}
        <div class="form agent-form">
          ${agentField('codex', 'exe', t('settings.agents.exe'), c.codex.exe, exeHint('codex', 'codex.exe'))}
          ${agentField('codex', 'model', t('settings.agents.model'), c.codex.model, t('settings.agents.optional'))}
        </div>
        ${accessRow('codex')}
      </div>`;
  }

  // ----- shortcuts -----

  // The quick actions of the chat panel, as the user arranged them (actions.js shortcutList).
  const shortcuts = () => shortcutList(agentState && agentState.config.shortcuts);
  const shortcutRow = (s, i, list) => {
    const label = esc(s.label);
    const desc = [`/${esc(s.key)}`, esc(shortcutWhen(s)), !s.custom && (s.edited.label || s.edited.prompt) ? esc(t('settings.shortcuts.edited')) : ''].filter(Boolean).join(' · ');
    return `<div class="row static shortcut-row ${s.hidden ? 'is-hidden' : ''}" data-shortcut="${esc(s.key)}">
      <button class="shortcut-main" data-a="sc-edit:${esc(s.key)}" title="${esc(t('settings.shortcuts.editTitle'))}">
        <span class="shortcut-lead">${panelIcon(s.icon, 16).outerHTML}</span>
        <div class="text"><div class="title">${label}</div><div class="desc">${desc}</div></div>
      </button>
      <button class="icon-btn sm" data-a="sc-up:${esc(s.key)}" aria-label="${esc(t('settings.shortcuts.moveUp', { name: s.label }))}" title="${esc(t('settings.shortcuts.moveUp', { name: s.label }))}" ${i === 0 ? 'disabled' : ''}>${icons.up}</button>
      <button class="icon-btn sm" data-a="sc-down:${esc(s.key)}" aria-label="${esc(t('settings.shortcuts.moveDown', { name: s.label }))}" title="${esc(t('settings.shortcuts.moveDown', { name: s.label }))}" ${i === list.length - 1 ? 'disabled' : ''}>${icons.down}</button>
      <button class="shortcut-switch" data-a="sc-show:${esc(s.key)}" role="switch" aria-checked="${!s.hidden}" aria-label="${esc(t('settings.shortcuts.show', { name: s.label }))}" title="${esc(t('settings.shortcuts.show', { name: s.label }))}"><span class="switch ${s.hidden ? '' : 'on'}"></span></button>
    </div>`;
  };
  const shortcutRows = () => {
    const list = shortcuts();
    return `${list.map((s, i) => shortcutRow(s, i, list)).join('')}
      ${row({ title: t('settings.shortcuts.add'), action: 'sc-add', lead: `<span class="add-ic">${icons.plus}</span>`, cls: 'indent' })}`;
  };
  function shortcutsHtml() {
    return `
      <p class="settings-intro">${esc(t('settings.shortcuts.help'))}</p>
      <div class="card shortcut-card" data-shortcuts>${shortcutRows()}</div>
      <div class="settings-group-title"></div>
      <div class="card">${row({ title: t('settings.shortcuts.reset'), desc: t('settings.shortcuts.resetHelp'), action: 'sc-reset' })}</div>`;
  }
  // Saves the list and draws the rows again in place, so the page keeps its scroll; focus: the control to give the
  // focus back to, as a data-a value (a move button that is now disabled hands it to the other one).
  async function saveShortcuts(list, focus) {
    if (!(await updateAgents({ shortcuts: storedShortcuts(list) }))) return false;
    const card = page.querySelector('[data-shortcuts]');
    if (!card) return true;
    card.innerHTML = shortcutRows();
    if (focus) {
      let el = card.querySelector(`[data-a="${focus}"]`);
      if (el && el.disabled) el = card.querySelector(`[data-a="${focus.replace(/^sc-(up|down)/, (m, d) => `sc-${d === 'up' ? 'down' : 'up'}`)}"]`);
      el?.focus();
    }
    return true;
  }
  async function shortcutAction(action) {
    const [name, key] = action.split(':');
    const list = shortcuts();
    const i = list.findIndex((s) => s.key === key);
    const s = list[i];
    switch (name) {
      case 'sc-up':
      case 'sc-down': {
        const j = name === 'sc-up' ? i - 1 : i + 1;
        if (!s || j < 0 || j >= list.length) return;
        [list[i], list[j]] = [list[j], list[i]];
        return saveShortcuts(list, action);
      }
      case 'sc-show':
        if (!s) return;
        s.hidden = !s.hidden;
        return saveShortcuts(list, action);
      case 'sc-edit': {
        if (!s) return;
        const v = await shortcutDialog(s, list);
        if (!v) return;
        if (v === 'delete') list.splice(i, 1);
        else if (v === 'restore') s.edited = { label: '', prompt: '' };
        else if (s.custom) list[i] = { ...s, ...v, needsEmail: v.when === 'email', description: v.label };
        else s.edited = { label: v.label === s.defaultLabel ? '' : v.label, prompt: v.prompt === s.defaultPrompt ? '' : v.prompt };
        if (await saveShortcuts(list, v === 'delete' ? 'sc-add' : `sc-edit:${list[i] ? list[i].key : ''}`)) toast(t('settings.agents.saved'), 1400);
        return;
      }
      case 'sc-add': {
        if (list.length >= SHORTCUTS_MAX) return toast(t('settings.shortcuts.tooMany', { count: SHORTCUTS_MAX }), 5000);
        const v = await shortcutDialog(null, list);
        if (!v || typeof v !== 'object') return;
        list.push({ ...v, custom: true, hidden: false, needsEmail: v.when === 'email', description: v.label, action: 'shortcut' });
        if (await saveShortcuts(list, `sc-edit:${v.key}`)) toast(t('settings.shortcuts.added', { name: v.label }), 2400);
        return;
      }
      case 'sc-reset': {
        const ok = await confirmDialog(t('settings.shortcuts.resetTitle'), t('settings.shortcuts.resetConfirm'), t('settings.shortcuts.resetOk'));
        if (!ok) return;
        if (await updateAgents({ shortcuts: null })) {
          const card = page.querySelector('[data-shortcuts]');
          if (card) card.innerHTML = shortcutRows();
          toast(t('settings.shortcuts.resetDone'), 2400);
        }
        return;
      }
    }
  }

  // Saves a patch and reads the config back, so the page shows what main accepted.
  async function updateAgents(patch) {
    try {
      await api('agentUpdateConfig', patch);
      agentState.config = await api('agentConfig');
      return true;
    } catch (err) {
      toast(err.message, 5000);
      return false;
    }
  }
  const flip = (b, on) => {
    const sw = b.querySelector('.switch');
    sw.classList.toggle('on', on);
    sw.setAttribute('aria-checked', String(on));
  };

  async function testAgent(id) {
    showAgentStatus(id, { testing: true });
    try {
      const result = await api('agentTest', id);
      agentState.status = { ...(agentState.status || {}), [id]: result };
    } catch (err) {
      agentState.status = { ...(agentState.status || {}), [id]: { state: 'unknown', detail: err.message } };
    }
    showAgentStatus(id);
  }

  async function agentAction(action, b) {
    if (!agentState) return;
    const [name, id] = action.split(':');
    const c = agentState.config;
    switch (name) {
      case 'agent-shortcuts':
        return go('shortcuts');
      case 'agent-default': {
        const v = await choiceDialog(t('settings.agents.default'), AGENT_IDS.map((x) => ({ value: x, label: agentName(c, x), hint: AGENT_PRODUCTS[x] })), c.defaultAgent);
        if (v && (await updateAgents({ defaultAgent: v }))) b.querySelector('[data-agent-default]').textContent = agentName(agentState.config, v);
        return;
      }
      case 'agent-auto':
        if (await updateAgents({ autoMailActions: !c.autoMailActions })) flip(b, Boolean(agentState.config.autoMailActions));
        return;
      case 'agent-enabled':
        if (await updateAgents({ [id]: { enabled: c[id].enabled === false } })) flip(b, agentState.config[id].enabled !== false);
        return;
      case 'agent-access': {
        const v = await choiceDialog(t('settings.agents.access'), ACCESS, c[id].access);
        if (v && (await updateAgents({ [id]: { access: v } }))) b.querySelector('.value').textContent = labelOf(ACCESS, v);
        return;
      }
      case 'agent-remote':
        if (await updateAgents({ mcp: { remote: !(c.mcp && c.mcp.remote) } })) {
          flip(b, Boolean(agentState.config.mcp.remote));
          b.querySelector('[data-agent-address]').innerHTML = remoteDesc();
        }
        return;
      case 'agent-test':
        return testAgent(id);
      case 'agent-copy-setup':
        try {
          await api('agentCopyHermesSetup');
          toast(t('settings.agents.copied', { name: agentName(c, 'clark') }), 6000);
        } catch (err) {
          toast(err.message, 5000);
        }
        return;
      case 'agent-key-replace':
      case 'agent-key-cancel':
        keyEditing = name === 'agent-key-replace';
        page.querySelector('.agent-key-box').innerHTML = keyHtml();
        page.querySelector('[data-agent-key]')?.focus();
        return;
      case 'agent-key-reveal': {
        const input = page.querySelector('[data-agent-key]');
        const show = input.type === 'password';
        input.type = show ? 'text' : 'password';
        b.innerHTML = show ? icons.eyeOff : icons.eye;
        b.title = show ? t('settings.agents.keyHide') : t('settings.agents.keyShow');
        return;
      }
      case 'agent-key-save': {
        const input = page.querySelector('[data-agent-key]');
        const value = input.value.trim();
        if (!value) return input.focus();
        try {
          await api('agentSetSecret', 'clark', value);
          agentState.config = await api('agentConfig');
        } catch (err) {
          return toast(err.message, 5000);
        }
        keyEditing = false;
        page.querySelector('.agent-key-box').innerHTML = keyHtml();
        const address = page.querySelector('[data-agent-address]');
        if (address) address.innerHTML = remoteDesc();
        toast(t('settings.agents.keyStored'));
        return testAgent('clark');
      }
    }
  }

  async function saveAgentField(input) {
    if (!agentState) return;
    const [id, key] = input.dataset.agentField.split('.');
    const value = input.value.trim();
    if (String(agentState.config[id][key] || '') === value) return;
    if (!(await updateAgents({ [id]: { [key]: value } }))) {
      input.value = agentState.config[id][key] || '';
      return;
    }
    input.value = agentState.config[id][key] || '';
    toast(t('settings.agents.saved'), 1400);
    if (id === 'clark' && key === 'name') {
      page.querySelectorAll('[data-agent-name="clark"]').forEach((el) => (el.textContent = agentName(agentState.config, 'clark')));
      const def = page.querySelector('[data-agent-default]');
      if (def) def.textContent = agentName(agentState.config, agentState.config.defaultAgent);
    }
    if (key === 'url' || key === 'exe') testAgent(id);
  }

  page.addEventListener('change', (e) => {
    const input = e.target.closest && e.target.closest('[data-agent-field]');
    if (input) saveAgentField(input);
  });
  page.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    if (e.target.matches && e.target.matches('[data-agent-field]')) e.target.blur();
    if (e.target.matches && e.target.matches('[data-agent-key]')) page.querySelector('[data-a="agent-key-save"]')?.click();
  });

  async function render() {
    const state = await api('state');
    ctx.S.data = state;
    const s = state.settings;
    setLanguage(s.language);
    localize();
    const view = stack[stack.length - 1];
    let title = t('settings.title');
    let body = '';
    if (view === 'main' || view === 'agents' || view === 'shortcuts') {
      agentState = await loadAgents();
      if (stack[stack.length - 1] !== view) return;
    }

    if (view === 'main') {
      const accounts = state.accounts
        .map((a) => {
          const status = a.syncing
            ? t('mailbox.sync.syncing')
            : a.error
              ? `<span class="error">${esc(a.error)}</span>`
              : a.lastSync
                ? t('settings.account.lastSync', { date: numericDate(a.lastSync), time: hhmm(a.lastSync) })
                : t('mailbox.sync.never');
          return row({
            title: `${esc(a.email)}${a.isDefault ? t('settings.account.defaultSuffix') : ''}`,
            desc: status,
            action: `account:${a.id}`,
            cls: 'indent',
            lead: `<div class="avatar small" style="--accent:${a.color}">${esc((a.name || a.email).trim()[0] || '?').toUpperCase()}</div>`
          });
        })
        .join('');
      body = `
        <div class="settings-group-title" data-i18n="settings.groups.accounts">${esc(t('settings.groups.accounts'))}</div>
        <div class="card">${accounts}
          ${row({ title: t('settings.accounts.add'), action: 'add', cls: 'indent', lead: `<span class="add-ic">${icons.plus}</span>` })}
        </div>
        <div class="settings-group-title" data-i18n="settings.groups.general">${esc(t('settings.groups.general'))}</div>
        <div class="card">
          ${row({ title: t('settings.general.language'), desc: t('settings.general.languageHelp'), value: languages.find((language) => language.code === s.language)?.name || 'English', action: 'language' })}
          ${row({ title: t('settings.general.folders'), desc: t('settings.general.foldersHelp'), action: 'folders' })}
          ${row({ title: t('settings.general.density'), value: labelOf(DENSITY, s.density), action: 'density' })}
          ${row({ title: t('settings.general.theme'), value: labelOf(THEMES, s.theme), action: 'theme' })}
          ${zoomRow(s.zoomLevel)}
          ${row({ title: t('settings.general.darkEmails'), desc: t('settings.general.darkEmailsHelp'), action: 'toggle:darkEmails', toggle: s.darkEmails })}
          ${row({ title: t('settings.general.swipe'), desc: t('settings.general.swipeHelp'), action: 'toggle:swipeActions', toggle: s.swipeActions })}
          ${row({ title: t('settings.general.fit'), desc: t('settings.general.fitHelp'), action: 'toggle:fitContent', toggle: s.fitContent })}
          ${row({ title: t('settings.general.logos'), desc: t('settings.general.logosHelp'), action: 'toggle:senderLogos', toggle: s.senderLogos !== false })}
          ${row({ title: t('settings.general.notifications'), desc: t('settings.general.notificationsHelp'), action: 'toggle:notifications', toggle: s.notifications })}
          ${row({ title: t('settings.general.badge'), value: labelOf(BADGES, s.badge), action: 'badge' })}
          ${row({ title: t('settings.general.sync'), value: labelOf(INTERVALS, Number(s.syncInterval)), action: 'interval' })}
          ${row({ title: t('settings.general.closeToTray'), desc: t('settings.general.closeToTrayHelp'), action: 'toggle:closeToTray', toggle: s.closeToTray })}
          ${row({ title: t('settings.general.minimizeToTray'), desc: t('settings.general.minimizeToTrayHelp'), action: 'toggle:minimizeToTray', toggle: s.minimizeToTray })}
          ${mailtoRow()}
          ${row({ title: t('settings.general.signature'), value: esc(s.signature || t('common.values.none')), action: 'signature' })}
          ${row({ title: t('settings.general.spam'), desc: t('settings.general.spamHelp'), action: 'spam' })}
          ${row({ title: t('mailbox.folders.vip'), desc: t('settings.general.vipHelp'), action: 'vips' })}
        </div>
        <div class="settings-group-title" data-i18n="settings.groups.agents">${esc(t('settings.groups.agents'))}</div>
        <div class="card">${row({
          title: agentState ? t('settings.agents.rowTitle', { name: esc(agentName(agentState.config, 'clark')) }) : t('settings.agents.title'),
          desc: agentState ? agentsRowDesc() : t('settings.agents.unavailable'),
          action: 'agents'
        })}</div>
        <div class="settings-group-title" data-i18n="settings.groups.about">${esc(t('settings.groups.about'))}</div>
        <div class="card">${row({ title: t('settings.about.title'), desc: t('settings.about.help'), action: 'about' })}</div>`;
    }

    if (view === 'account') {
      const a = state.accounts.find((x) => x.id === params.id);
      if (!a) return back();
      title = a.email;
      body = `
        <div class="settings-group-title" data-i18n="settings.groups.account">${esc(t('settings.groups.account'))}</div>
        <div class="card">
          ${row({ title: t('settings.account.name'), value: esc(a.name || ''), action: 'acc-name' })}
          ${row({ title: t('settings.general.signature'), value: esc(a.signature ?? t('settings.signature.generalValue', { signature: s.signature || t('common.values.noneLower') })), action: 'acc-signature' })}
          ${row({ title: t('settings.account.color'), value: labelOf(COLORS, a.color), action: 'acc-color' })}
          ${row({ title: t('settings.account.from'), value: esc(a.defaultFrom), action: 'acc-from' })}
          ${row({ title: t('settings.account.identities'), desc: a.identities.length > 1 ? t('settings.aliases.count', { count: a.identities.length - 1 }) : t('settings.account.noAliases'), action: 'acc-aliases' })}
          ${a.isDefault ? '' : row({ title: t('settings.account.makeDefault'), desc: t('settings.account.makeDefaultHelp'), action: 'acc-default' })}
          ${row({ title: t('settings.account.sync'), desc: a.lastSync ? t('settings.account.lastSync', { date: numericDate(a.lastSync), time: hhmm(a.lastSync) }) : '', action: 'acc-sync' })}
          ${a.provider === 'google' && s && state.googleAvailable ? row({ title: a.auth === 'oauth2' ? t('settings.account.googleReauth') : t('settings.account.googleSwitch'), desc: a.auth === 'oauth2' ? t('settings.account.googleReauthHelp') : t('settings.account.googleSwitchHelp'), action: 'acc-google' }) : ''}
          ${a.type === 'imap' ? row({ title: t('settings.account.server'), desc: [a.imap.host, a.smtp.host, a.caldav && hostOf(a.caldav.url)].filter(Boolean).map(esc).join(' / '), action: 'acc-server' }) : ''}
        </div>
        <div class="settings-group-title"></div>
        <div class="card">${row({ title: t('settings.account.remove'), action: 'acc-remove', cls: 'danger' })}</div>`;
    }

    if (view === 'server') {
      const a = state.accounts.find((x) => x.id === params.id);
      if (!a) return back();
      title = t('settings.account.server');
      body = `<div class="card"><form class="form" data-form="server">
        <label data-i18n="setup.fields.username">${esc(t('setup.fields.username'))}<input type="text" name="user" value="${esc(a.imap.user || a.email)}"/></label>
        ${a.auth === 'oauth2' ? '' : `<label data-i18n="setup.fields.password">${esc(t('setup.fields.password'))}<input type="password" name="password" data-i18n-placeholder="settings.server.passwordHint" placeholder="${esc(t('settings.server.passwordHint'))}"/></label>`}
        <div class="two"><label data-i18n="setup.fields.imap">${esc(t('setup.fields.imap'))}<input type="text" name="imapHost" value="${esc(a.imap.host)}"/></label>
          <label data-i18n="setup.fields.port">${esc(t('setup.fields.port'))}<input type="number" name="imapPort" value="${a.imap.port}"/></label>
          <label class="inline"><input type="checkbox" name="imapSecure" ${a.imap.secure ? 'checked' : ''}/> SSL/TLS</label></div>
        <div class="two"><label data-i18n="setup.fields.smtp">${esc(t('setup.fields.smtp'))}<input type="text" name="smtpHost" value="${esc(a.smtp.host)}"/></label>
          <label data-i18n="setup.fields.port">${esc(t('setup.fields.port'))}<input type="number" name="smtpPort" value="${a.smtp.port}"/></label>
          <label class="inline"><input type="checkbox" name="smtpSecure" ${a.smtp.secure ? 'checked' : ''}/> SSL/TLS</label></div>
        ${
          a.auth === 'oauth2'
            ? ''
            : `<label data-i18n="settings.server.caldav">${esc(t('settings.server.caldav'))}<input type="text" name="caldavUrl" value="${esc(a.caldav ? a.caldav.url : '')}" spellcheck="false" data-i18n-placeholder="settings.server.caldavPlaceholder" placeholder="${esc(t('settings.server.caldavPlaceholder'))}"/>
          <span class="field-help" data-i18n="settings.server.caldavHelp">${esc(t('settings.server.caldavHelp'))}</span></label>`
        }
        <div class="error" data-error></div>
        <div><button class="btn" type="submit" data-i18n="common.actions.save">${esc(t('common.actions.save'))}</button></div>
      </form></div>`;
    }

    if (view === 'aliases') {
      const a = state.accounts.find((x) => x.id === params.id);
      if (!a) return back();
      title = t('settings.account.identities');
      body = `
        <div class="settings-group-title" data-i18n="settings.aliases.sendAs">${esc(t('settings.aliases.sendAs'))}</div>
        <div class="card">
          ${a.identities
            .map((i) =>
              row({
                title: `${esc(i.address)}${i.address === a.defaultFrom ? t('settings.account.defaultSuffix') : ''}`,
                desc: i.primary ? t('settings.aliases.primary') : t('settings.aliases.manageHint'),
                action: i.primary ? `alias-default:${encodeURIComponent(i.address)}` : `alias:${encodeURIComponent(i.address)}`
              })
            )
            .join('')}
          ${row({ title: t('settings.aliases.add'), action: 'alias-add', lead: `<span class="add-ic">${icons.plus}</span>`, cls: 'indent' })}
          ${a.auth === 'oauth2' ? row({ title: t('settings.aliases.fetch'), desc: t('settings.aliases.fetchHelp'), action: 'alias-gmail' }) : ''}
        </div>
        <p class="empty" style="padding:24px 40px;text-align:left" data-i18n="settings.aliases.help">${esc(t('settings.aliases.help'))}</p>`;
    }

    if (view === 'folders') {
      title = t('settings.general.folders');
      const hidden = new Set(s.hiddenViews || []);
      const folderRows = state.accounts.flatMap((a) =>
        a.folders.filter((f) => !f.role).map((f) => [`folder:${f.path}`, `${f.name} (${a.email})`])
      );
      body = `<div class="settings-group-title" data-i18n="settings.folders.show">${esc(t('settings.folders.show'))}</div><div class="card">${[...hideableViews(), ...folderRows]
        .map(([id, label]) => row({ title: esc(label), action: `hide:${id}`, toggle: !hidden.has(id) }))
        .join('')}</div>`;
    }

    if (view === 'spam' || view === 'vips') {
      const key = view === 'spam' ? 'spam' : 'vips';
      title = view === 'spam' ? t('settings.general.spam') : t('mailbox.folders.vip');
      const list = s[key] || [];
      body = `<div class="card">
        ${row({ title: t('common.actions.add'), action: `list-add:${key}`, lead: `<span class="add-ic">${icons.plus}</span>`, cls: 'indent' })}
        ${list.map((addr) => row({ title: esc(addr), desc: t('settings.addresses.removeHint'), action: `list-remove:${key}:${encodeURIComponent(addr)}` })).join('')}
      </div>
      ${list.length ? '' : `<p class="empty">${view === 'spam' ? t('settings.spam.empty') : t('settings.vip.empty')}</p>`}`;
    }

    if (view === 'agents') {
      title = t('settings.agents.title');
      keyEditing = false;
      body = agentState ? agentsHtml() : `<p class="empty">${esc(t('settings.agents.unavailable'))}</p>`;
    }

    if (view === 'shortcuts') {
      title = t('settings.shortcuts.title');
      body = agentState ? shortcutsHtml() : `<p class="empty">${esc(t('settings.agents.unavailable'))}</p>`;
    }

    page.innerHTML = `
      <div class="page-bar"><button class="icon-btn" data-a="back" data-i18n-title="common.actions.back" title="${esc(t('common.actions.back'))}">${icons.back}</button><h1>${title}</h1></div>
      <div class="page-scroll"><div class="page-inner">${body}</div></div>`;
    if (view === 'agents' && agentState) AGENT_IDS.forEach((id) => showAgentStatus(id));
    if ((view === 'main' || view === 'agents') && agentState) refreshAgentStatus(view);
    if (view === 'main') showMailto();
  }

  page.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const f = new FormData(form);
    const err = form.querySelector('[data-error]');
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner"></span>${esc(t('settings.server.checking'))}`;
    err.textContent = '';
    try {
      const acc = ctx.S.data.accounts.find((x) => x.id === params.id);
      const user = f.get('user').trim();
      const imap = { host: f.get('imapHost').trim(), port: Number(f.get('imapPort')), secure: f.get('imapSecure') === 'on', user };
      const smtp = { host: f.get('smtpHost').trim(), port: Number(f.get('smtpPort')), secure: f.get('smtpSecure') === 'on', user };
      const password = f.get('password') || undefined;
      // The mail servers are only checked again when something about them changed, so adding a calendar server
      // doesn't need the mail server to answer too.
      const same = (next, was) => Boolean(was) && next.host === was.host && next.port === Number(was.port) && next.secure === Boolean(was.secure) && next.user === (was.user || acc.email);
      const patch = password || !acc || !same(imap, acc.imap) || !same(smtp, acc.smtp) ? { imap, smtp, password } : {};
      if (f.has('caldavUrl')) patch.caldav = { url: f.get('caldavUrl').trim() };
      await api('updateAccount', params.id, patch);
      toast(t('settings.server.saved'));
      back();
    } catch (ex) {
      err.textContent = ex.message;
      btn.disabled = false;
      btn.textContent = t('common.actions.save');
    }
  });

  page.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-a]');
    if (!b) return;
    const a = b.dataset.a;
    const s = ctx.S.data.settings;
    const set = async (patch) => {
      await api('updateSettings', patch);
      await render();
      ctx.refresh();
    };
    if (a === 'back') return back();
    // Main answers with a 'zoom' event, which updates the row.
    if (a === 'zoom-reset') return api('setZoom', 100);
    if (a === 'mailto-use') {
      b.disabled = true;
      try {
        await api('useForMailto');
      } catch (err) {
        toast(err.message, 5000);
      }
      return showMailto();
    }
    if (a === 'agents') return go('agents');
    if (a.startsWith('agent-')) return agentAction(a, b);
    if (a.startsWith('sc-')) return shortcutAction(a);
    if (a === 'add') {
      close();
      return ctx.openSetup({ first: false });
    }
    if (a.startsWith('account:')) return go('account', { id: a.slice(8) });
    if (a.startsWith('toggle:')) {
      const key = a.slice(7);
      await set({ [key]: !s[key] });
      if (key === 'fitContent' || key === 'darkEmails') ctx.redrawMail();
      return;
    }
    if (a.startsWith('hide:')) {
      const id = a.slice(5);
      const hidden = new Set(s.hiddenViews || []);
      if (hidden.has(id)) hidden.delete(id);
      else hidden.add(id);
      return set({ hiddenViews: [...hidden] });
    }
    if (a.startsWith('alias-default:') || a.startsWith('alias:')) {
      const acc = ctx.S.data.accounts.find((x) => x.id === params.id);
      if (!acc) return;
      const address = decodeURIComponent(a.slice(a.indexOf(':') + 1));
      const setDefault = () => api('updateAccount', acc.id, { defaultFrom: address });
      let choice = 'default';
      if (a.startsWith('alias:')) {
        choice = await dialog({
          title: address,
          buttons: [
            { get label() { return t('common.actions.delete'); }, value: 'remove', danger: true },
            { get label() { return t('common.actions.cancel'); }, value: null },
            { get label() { return t('settings.aliases.makeDefault'); }, value: 'default' }
          ]
        });
      }
      try {
        if (choice === 'default') await setDefault();
        if (choice === 'remove') {
          const rest = acc.identities.filter((i) => !i.primary && i.address !== address).map((i) => ({ address: i.address, name: i.name }));
          await api('updateAccount', acc.id, { aliases: rest });
        }
      } catch (err) {
        toast(err.message, 5000);
      }
      await render();
      return ctx.refresh();
    }
    if (a.startsWith('list-add:')) {
      const key = a.slice(9);
      const v = await promptDialog(key === 'spam' ? t('settings.spam.add') : t('settings.vip.add'), '', { placeholder: t('setup.fields.emailExample') });
      const addr = String(v || '').trim().toLowerCase();
      if (!addr) return;
      if (!/^[^@\s]+@[^@\s]+$/.test(addr)) return toast(t('common.errors.invalidEmail'));
      return set({ [key]: [...new Set([...(s[key] || []), addr])] });
    }
    if (a.startsWith('list-remove:')) {
      const [, key, enc] = a.split(':');
      const addr = decodeURIComponent(enc);
      return set({ [key]: (s[key] || []).filter((x) => x !== addr) });
    }
    switch (a) {
      case 'language': {
        const value = await choiceDialog(t('settings.general.language'), languages.map((language) => ({ value: language.code, label: language.name })), s.language);
        if (value) await set({ language: value });
        return;
      }
      case 'folders':
      case 'spam':
      case 'vips':
        return go(a);
      case 'density': {
        const v = await choiceDialog(t('settings.general.density'), DENSITY, s.density);
        if (v) set({ density: v });
        return;
      }
      case 'theme': {
        const v = await choiceDialog(t('settings.general.theme'), THEMES, s.theme);
        if (v) set({ theme: v });
        return;
      }
      case 'badge': {
        const v = await choiceDialog(t('settings.general.badge'), BADGES, s.badge);
        if (v) set({ badge: v });
        return;
      }
      case 'interval': {
        const v = await choiceDialog(t('settings.general.sync'), INTERVALS, Number(s.syncInterval));
        if (v !== null && v !== undefined) set({ syncInterval: v });
        return;
      }
      case 'signature': {
        const v = await promptDialog(t('settings.general.signature'), s.signature || '', { multiline: true });
        if (v !== null) set({ signature: v });
        return;
      }
      case 'about': {
        const info = await api('appInfo');
        return dialog({
          body: `${brandLogo('about-logo')}<p>${esc(t('settings.about.version', { version: info.version }))}</p><p data-i18n="settings.about.description">${esc(t('settings.about.description'))}<br><code style="user-select:text">${esc(info.dataDir)}</code></p>`
        });
      }
    }
    const acc = ctx.S.data.accounts.find((x) => x.id === params.id);
    if (!acc) return;
    const update = async (patch) => {
      try {
        await api('updateAccount', acc.id, patch);
        await render();
        ctx.refresh();
      } catch (err) {
        toast(err.message, 5000);
      }
    };
    switch (a) {
      case 'acc-name': {
        const v = await promptDialog(t('settings.account.name'), acc.name || '');
        if (v !== null) update({ name: v.trim() });
        return;
      }
      case 'acc-signature': {
        const v = await dialog({
          title: t('settings.general.signature'),
          buttons: [
            { get label() { return t('settings.signature.useGeneral'); }, value: { reset: true } },
            { get label() { return t('common.actions.cancel'); }, value: null },
            { get label() { return t('common.actions.save'); }, value: (scrim) => ({ text: scrim.querySelector('textarea').value }) }
          ],
          render(body) {
            body.innerHTML = `<div class="form" style="padding:0"><textarea>${esc(acc.signature ?? s.signature ?? '')}</textarea></div>`;
          }
        });
        if (!v) return;
        update({ signature: v.reset ? null : v.text });
        return;
      }
      case 'acc-color': {
        const v = await choiceDialog(t('settings.account.color'), COLORS, acc.color);
        if (v) update({ color: v });
        return;
      }
      case 'acc-default':
        return update({ makeDefault: true });
      case 'acc-sync':
        toast(t('mailbox.sync.syncing'));
        try {
          await api('sync', acc.id);
          toast(t('mailbox.sync.done'));
        } catch (err) {
          toast(err.message, 5000);
        }
        return render();
      case 'acc-server':
        return go('server', { id: acc.id });
      case 'acc-aliases':
        return go('aliases', { id: acc.id });
      case 'acc-from': {
        const v = await choiceDialog(
          t('settings.account.from'),
          acc.identities.map((i) => ({ value: i.address, label: i.address })),
          acc.defaultFrom
        );
        if (v) update({ defaultFrom: v });
        return;
      }
      case 'alias-add': {
        const v = await promptDialog(t('settings.aliases.add'), '', { placeholder: t('setup.fields.emailExample') });
        if (!v || !v.trim()) return;
        const aliases = acc.identities.filter((i) => !i.primary).map((i) => ({ address: i.address, name: i.name }));
        update({ aliases: [...aliases, { address: v.trim(), name: acc.name }] });
        return;
      }
      case 'alias-gmail':
        try {
          const updated = await api('fetchGmailAliases', acc.id);
          toast(t('settings.aliases.fetched', { count: updated.identities.length - 1 }));
        } catch (err) {
          toast(err.message, 6000);
        }
        return render();
      case 'acc-google':
        toast(t('setup.google.waitToast'), 60000);
        try {
          await api('googleReauth', acc.id);
          toast(t('setup.google.signedIn'));
        } catch (err) {
          toast(err.message, 6000);
        }
        return render();
      case 'acc-remove': {
        const ok = await confirmDialog(t('settings.account.removeTitle'), t('settings.account.removeHelp', { email: acc.email }), t('common.actions.delete'), true);
        if (!ok) return;
        await api('removeAccount', acc.id);
        toast(t('settings.account.removed'));
        if (ctx.S.scope === acc.id) ctx.S.scope = 'all';
        ctx.closeReader();
        await ctx.refresh();
        if (!ctx.S.data.accounts.length) return close();
        return back();
      }
    }
  });

  render();
}
