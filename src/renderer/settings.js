import { t, languages, setLanguage, localize } from './i18n.js';
import { icons } from './icons.js';
import { api, brandLogo, esc, toast, dialog, confirmDialog, choiceDialog, numericDate, hhmm } from './ui.js';

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

export function openSettings(ctx) {
  const page = document.createElement('div');
  page.className = 'page settings';
  document.getElementById('overlays').appendChild(page);
  const stack = ['main'];
  let params = {};

  // Live status (sync times, errors) matters on the overview pages; forms must not be reset under the user.
  const unsubscribe = window.mail.on(({ type }) => {
    const view = stack[stack.length - 1];
    if (type === 'updated' && (view === 'main' || view === 'account')) setTimeout(render, 80);
  });

  const close = () => {
    unsubscribe();
    page.remove();
    document.removeEventListener('keydown', onKey, true);
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

  async function render() {
    const state = await api('state');
    ctx.S.data = state;
    const s = state.settings;
    setLanguage(s.language);
    localize();
    const view = stack[stack.length - 1];
    let title = t('settings.title');
    let body = '';

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
          ${row({ title: t('settings.general.darkEmails'), desc: t('settings.general.darkEmailsHelp'), action: 'toggle:darkEmails', toggle: s.darkEmails })}
          ${row({ title: t('settings.general.swipe'), desc: t('settings.general.swipeHelp'), action: 'toggle:swipeActions', toggle: s.swipeActions })}
          ${row({ title: t('settings.general.fit'), desc: t('settings.general.fitHelp'), action: 'toggle:fitContent', toggle: s.fitContent })}
          ${row({ title: t('settings.general.logos'), desc: t('settings.general.logosHelp'), action: 'toggle:senderLogos', toggle: s.senderLogos !== false })}
          ${row({ title: t('settings.general.notifications'), desc: t('settings.general.notificationsHelp'), action: 'toggle:notifications', toggle: s.notifications })}
          ${row({ title: t('settings.general.badge'), value: labelOf(BADGES, s.badge), action: 'badge' })}
          ${row({ title: t('settings.general.sync'), value: labelOf(INTERVALS, Number(s.syncInterval)), action: 'interval' })}
          ${row({ title: t('settings.general.signature'), value: esc(s.signature || t('common.values.none')), action: 'signature' })}
          ${row({ title: t('settings.general.spam'), desc: t('settings.general.spamHelp'), action: 'spam' })}
          ${row({ title: t('mailbox.folders.vip'), desc: t('settings.general.vipHelp'), action: 'vips' })}
        </div>
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
          ${a.type === 'imap' ? row({ title: t('settings.account.server'), desc: `${esc(a.imap.host)} / ${esc(a.smtp.host)}`, action: 'acc-server' }) : ''}
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

    page.innerHTML = `
      <div class="page-bar"><button class="icon-btn" data-a="back" data-i18n-title="common.actions.back" title="${esc(t('common.actions.back'))}">${icons.back}</button><h1>${title}</h1></div>
      <div class="page-scroll"><div class="page-inner">${body}</div></div>`;
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
      await api('updateAccount', params.id, {
        imap: { host: f.get('imapHost').trim(), port: Number(f.get('imapPort')), secure: f.get('imapSecure') === 'on', user: f.get('user').trim() },
        smtp: { host: f.get('smtpHost').trim(), port: Number(f.get('smtpPort')), secure: f.get('smtpSecure') === 'on', user: f.get('user').trim() },
        password: f.get('password') || undefined
      });
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
    if (a === 'add') {
      close();
      return ctx.openSetup({ first: false });
    }
    if (a.startsWith('account:')) return go('account', { id: a.slice(8) });
    if (a.startsWith('toggle:')) {
      const key = a.slice(7);
      return set({ [key]: !s[key] });
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
