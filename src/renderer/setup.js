import { t, languages, getLanguage, setLanguage, localize } from './i18n.js';
import { icons, providerLogos } from './icons.js';
import { api, brandLogo, esc, $, toast } from './ui.js';

const ORDER = ['google', 'yahoo', 'outlook', 'exchange', 'office365', 'other'];

export function openSetup(ctx, { first = false } = {}) {
  document.querySelector('.page.setup')?.remove();
  const page = document.createElement('div');
  page.className = 'page setup';
  document.getElementById('overlays').appendChild(page);
  let providers = ctx.S.data.providers;

  const close = () => {
    api('googleCancel').catch(() => {});
    page.remove();
    document.removeEventListener('keydown', onKey, true);
  };
  const onKey = (e) => {
    if (e.key !== 'Escape' || document.querySelector('.scrim')) return;
    e.stopPropagation();
    if (page.querySelector('.login')) showGrid();
    else if (!first) close();
  };
  document.addEventListener('keydown', onKey, true);

  function showGrid() {
    page.innerHTML = `
      ${first ? '' : `<button class="icon-btn setup-back" data-s="close" data-i18n-title="common.actions.back" title="${esc(t('common.actions.back'))}">${icons.back}</button>`}
      <div class="setup-inner">
        ${first ? brandLogo('setup-logo') : ''}
        <h1 data-i18n="setup.title">${esc(t('setup.title'))}</h1>
        <label class="setup-language"><span>${esc(t('setup.language.label'))}</span>
          <select data-s="language" aria-label="${esc(t('setup.language.label'))}">
            ${languages.map((language) => `<option value="${language.code}" ${language.code === getLanguage() ? 'selected' : ''}>${esc(language.name)}</option>`).join('')}
          </select>
        </label>
        <div class="provider-grid">
          ${ORDER.map((id) => {
            const p = providers.find((x) => x.id === id);
            return `<button class="provider" data-provider="${id}"><span class="logo">${providerLogos[id]}</span><span>${esc(p.label)}</span></button>`;
          }).join('')}
        </div>
        <button class="setup-demo" data-s="demo" data-i18n="setup.demo.action">${esc(t('setup.demo.action'))}</button>
        ${ctx.S.data.googleAvailable ? '' : `<button class="setup-demo" style="margin-top:4px" data-s="import-google" data-i18n="setup.google.import">${esc(t('setup.google.import'))}</button>`}
      </div>`;
  }

  // Google accounts sign in through the browser (OAuth); a password form stays available as fallback.
  function showGoogle() {
    page.innerHTML = `
      <button class="icon-btn setup-back" data-s="grid" data-i18n-title="common.actions.back" title="${esc(t('common.actions.back'))}">${icons.back}</button>
      <div class="setup-inner login">
        <div class="login-head"><span class="logo">${providerLogos.google}</span><h2 data-i18n="setup.google.title">${esc(t('setup.google.title'))}</h2></div>
        <p class="note" data-i18n="setup.google.help">${esc(t('setup.google.help'))}</p>
        <div class="error" data-error style="margin-top:14px"></div>
        <div class="actions" style="margin-top:22px">
          <button class="link-btn" data-s="password-mode" data-i18n="setup.google.passwordMode">${esc(t('setup.google.passwordMode'))}</button>
          <button class="btn" data-s="google" data-i18n="setup.google.action">${esc(t('setup.google.action'))}</button>
        </div>
        <div class="google-wait" hidden style="margin-top:22px;display:flex;align-items:center;gap:12px">
          <span class="spinner" style="border-color:rgba(128,128,128,.35);border-top-color:var(--primary)"></span>
          <span style="flex:1" data-i18n="setup.google.wait">${esc(t('setup.google.wait'))}</span>
          <button class="link-btn" data-s="google-cancel" data-i18n="common.actions.cancel">${esc(t('common.actions.cancel'))}</button>
        </div>
      </div>`;
  }

  async function googleSignIn() {
    const btn = page.querySelector('[data-s="google"]');
    const wait = page.querySelector('.google-wait');
    const err = page.querySelector('[data-error]');
    btn.disabled = true;
    wait.hidden = false;
    err.textContent = '';
    try {
      done(await api('googleSignIn'));
    } catch (ex) {
      if (!page.isConnected) return;
      if (!/geannuleerd|cancelled/i.test(ex.message)) err.textContent = ex.message;
      btn.disabled = false;
      wait.hidden = true;
    }
  }

  function showLogin(id, { forcePassword = false } = {}) {
    if (id === 'google' && !forcePassword && ctx.S.data.googleAvailable) return showGoogle();
    const p = providers.find((x) => x.id === id);
    const manual = p.manual;
    page.innerHTML = `
      <button class="icon-btn setup-back" data-s="grid" data-i18n-title="common.actions.back" title="${esc(t('common.actions.back'))}">${icons.back}</button>
      <div class="setup-inner login">
        <div class="login-head"><span class="logo">${providerLogos[id]}</span><h2>${esc(t('setup.signIn.title', { provider: p.label }))}</h2></div>
        <form class="form" autocomplete="off">
          <label data-i18n="setup.fields.email">${esc(t('setup.fields.email'))}<input type="email" name="email" required data-i18n-placeholder="setup.fields.emailExample" placeholder="${esc(t('setup.fields.emailExample'))}" spellcheck="false"/></label>
          <label data-i18n="setup.fields.password">${esc(t('setup.fields.password'))}<span class="pw"><input type="password" name="password" required data-i18n-placeholder="setup.fields.passwordHint" placeholder="${esc(t('setup.fields.passwordHint'))}"/>
            <button type="button" class="icon-btn" data-s="pw" data-i18n-title="setup.fields.showPassword" title="${esc(t('setup.fields.showPassword'))}">${icons.eye}</button></span></label>
          <div class="note">${esc(p.note)}</div>
          <div class="manual" ${manual ? '' : 'hidden'}>
            <div class="form" style="padding:0">
              <label data-i18n="setup.fields.username">${esc(t('setup.fields.username'))}<input type="text" name="user" data-i18n-placeholder="setup.fields.usernameHint" placeholder="${esc(t('setup.fields.usernameHint'))}" spellcheck="false"/></label>
              <div class="two"><label data-i18n="setup.fields.imap">${esc(t('setup.fields.imap'))}<input type="text" name="imapHost" value="${esc(p.imap.host)}"/></label>
                <label data-i18n="setup.fields.port">${esc(t('setup.fields.port'))}<input type="number" name="imapPort" value="${p.imap.port}"/></label>
                <label class="inline"><input type="checkbox" name="imapSecure" ${p.imap.secure ? 'checked' : ''}/> SSL/TLS</label></div>
              <div class="two"><label data-i18n="setup.fields.smtp">${esc(t('setup.fields.smtp'))}<input type="text" name="smtpHost" value="${esc(p.smtp.host)}"/></label>
                <label data-i18n="setup.fields.port">${esc(t('setup.fields.port'))}<input type="number" name="smtpPort" value="${p.smtp.port}"/></label>
                <label class="inline"><input type="checkbox" name="smtpSecure" ${p.smtp.secure ? 'checked' : ''}/> SSL/TLS</label></div>
            </div>
          </div>
          <div class="error" data-error></div>
          <div class="actions">
            <button type="button" class="link-btn" data-s="manual" ${manual ? 'hidden' : ''}>${esc(t('setup.manual.action'))}</button>
            <span></span>
            <button class="btn" type="submit" data-i18n="setup.signIn.action">${esc(t('setup.signIn.action'))}</button>
          </div>
        </form>
      </div>`;
    page.dataset.provider = id;
    const form = $('form', page);
    const email = form.elements.email;
    // For manual setups, suggest servers from the domain as the user types.
    email.addEventListener('input', () => {
      const domain = email.value.split('@')[1];
      if (!domain || (id !== 'other' && id !== 'exchange')) return;
      if (!form.elements.imapHost.dataset.touched) form.elements.imapHost.value = `imap.${domain}`;
      if (!form.elements.smtpHost.dataset.touched) form.elements.smtpHost.value = `smtp.${domain}`;
    });
    form.querySelectorAll('[name=imapHost],[name=smtpHost]').forEach((i) => i.addEventListener('input', () => (i.dataset.touched = '1')));
    email.focus();
  }

  page.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const id = page.dataset.provider;
    const f = new FormData(form);
    const err = form.querySelector('[data-error]');
    const btn = form.querySelector('button[type=submit]');
    const manualShown = !form.querySelector('.manual').hidden;
    const emailValue = String(f.get('email')).trim();
    const input = { provider: id, email: emailValue, password: f.get('password') };
    if (manualShown) {
      const user = String(f.get('user') || '').trim() || emailValue;
      input.imap = { host: String(f.get('imapHost')).trim(), port: Number(f.get('imapPort')), secure: f.get('imapSecure') === 'on', user };
      input.smtp = { host: String(f.get('smtpHost')).trim(), port: Number(f.get('smtpPort')), secure: f.get('smtpSecure') === 'on', user };
    }
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner"></span>${esc(t('setup.signIn.pending'))}`;
    err.textContent = '';
    try {
      const acc = await api('addAccount', input);
      done(acc);
    } catch (ex) {
      err.textContent = ex.message;
      btn.disabled = false;
      btn.textContent = t('setup.signIn.action');
      // A failed automatic setup is usually a server issue; show the manual fields.
      if (!manualShown && /IMAP|SMTP|server|Verbinding|time-out/i.test(ex.message)) {
        form.querySelector('.manual').hidden = false;
        form.querySelector('[data-s="manual"]').hidden = true;
      }
    }
  });

  page.addEventListener('change', async (e) => {
    if (e.target.dataset.s !== 'language') return;
    const select = e.target;
    select.disabled = true;
    try {
      await api('updateSettings', { language: select.value });
      ctx.S.data = await api('state');
      setLanguage(ctx.S.data.settings.language);
      providers = ctx.S.data.providers;
      localize();
      showGrid();
      await ctx.refresh();
    } catch (error) {
      select.disabled = false;
      toast(error.message, 5000);
    }
  });

  async function done(acc) {
    close();
    toast(t('setup.account.added', { email: acc.email }));
    ctx.S.scope = 'all';
    ctx.S.view = 'inbox';
    await ctx.refresh();
  }

  page.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.provider) return showLogin(b.dataset.provider);
    switch (b.dataset.s) {
      case 'close':
        return close();
      case 'grid':
        api('googleCancel').catch(() => {});
        return showGrid();
      case 'google':
        return googleSignIn();
      case 'google-cancel':
        return api('googleCancel');
      case 'password-mode':
        api('googleCancel').catch(() => {});
        return showLogin('google', { forcePassword: true });
      case 'import-google':
        try {
          if (await api('googleImportClient')) {
            ctx.S.data = await api('state');
            toast(t('setup.google.ready'));
            showGrid();
          }
        } catch (ex) {
          toast(ex.message, 5000);
        }
        return;
      case 'manual':
        b.hidden = true;
        page.querySelector('.manual').hidden = false;
        return;
      case 'pw': {
        const input = b.previousElementSibling;
        input.type = input.type === 'password' ? 'text' : 'password';
        b.innerHTML = input.type === 'password' ? icons.eye : icons.eyeOff;
        b.dataset.i18nTitle = input.type === 'password' ? 'setup.fields.showPassword' : 'setup.fields.hidePassword';
        b.title = t(b.dataset.i18nTitle);
        return;
      }
      case 'demo':
        try {
          b.disabled = true;
          const acc = await api('addAccount', { type: 'demo' });
          done(acc);
        } catch (ex) {
          b.disabled = false;
          toast(ex.message, 5000);
        }
    }
  });

  showGrid();
}
