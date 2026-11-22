import { t, languages, getLanguage, setLanguage, localize } from './i18n.js';
import { icons, providerLogos } from './icons.js';
import { api, brandLogo, esc, $, toast } from './ui.js';
import { showRecoveryKey } from './rukoo-account.js';
import { codeStep, codesFor } from './email-code.js';

const ORDER = ['google', 'yahoo', 'outlook', 'exchange', 'office365', 'other'];
const MIN_PASSWORD = 12;

// The setup page on screen: { page, first, close, chatChanged }, or null.
let current = null;
// The code step of each team chat account form drawn, made at its first submit (submitChatAccount).
const chatSteps = new WeakMap();

// Closes the setup page; firstOnly: only the first-run one, which a Rukoo account alone makes way for (app.js).
export function closeSetup({ firstOnly = false } = {}) {
  if (current && (!firstOnly || current.first)) current.close();
}

// Team chat's state changed: the grid's way in to team chat comes or goes with it.
export function setupChatChanged() {
  current?.chatChanged();
}

// first: the first-run page, without a way back. chat: open straight on team chat's steps, 'link' or 'account', as
// Chat's signed-out state does; back closes the page then. added(): after a mail account was added here.
export function openSetup(ctx, { first = false, chat = null, added = null } = {}) {
  // Without a mail account and outside Chat, the page that replaces a first-run one is first-run too: nothing behind
  // it to go back to.
  if (current && current.first) first = true;
  // Replaced by this one: no setup-closed, the window stays covered.
  current?.close({ quiet: true });
  document.querySelector('.page.setup')?.remove();
  const page = document.createElement('div');
  page.className = 'page setup';
  if (first) page.dataset.first = '1';
  document.getElementById('overlays').appendChild(page);
  let providers = ctx.S.data.providers;
  // The invitation link the team chat steps carry to the account form: { link, host } as main read it.
  let chatLink = null;

  const close = ({ quiet = false } = {}) => {
    api('googleCancel').catch(() => {});
    page.remove();
    document.removeEventListener('keydown', onKey, true);
    if (current && current.page === page) current = null;
    // A pending join that waited for this page goes on (chat.js maybeTakeJoin).
    if (!quiet) document.dispatchEvent(new Event('rukoo:setup-closed'));
  };
  // One step back: the account form goes back to the link it carries, the rest to the grid; a page opened straight on
  // team chat closes from its first step.
  const back = () => {
    const step = page.querySelector('[data-chat-step]')?.dataset.chatStep;
    if (step === 'account' && chatLink) return showChatLink(chatLink.link);
    if (chat && step) return close();
    showGrid();
  };
  const onKey = (e) => {
    if (e.key !== 'Escape' || document.querySelector('.scrim')) return;
    e.stopPropagation();
    if (page.querySelector('.login')) back();
    else if (!first) close();
  };
  document.addEventListener('keydown', onKey, true);
  current = { page, first, close, chatChanged: () => renderChatOffer() };
  // A start without network left team chat hidden here: the page asks again, and the box shows once the server says so.
  if (!ctx.chatOffer()) api('chatRetryInfo').catch(() => {});

  // Team chat without a mail account (RUK-234): on a server that has it, for someone not signed in to Rukoo yet.
  function renderChatOffer() {
    const box = page.querySelector('[data-setup-chat]');
    if (!box) return;
    const on = ctx.chatOffer();
    if (on === !box.hidden && box.childElementCount) return;
    box.hidden = !on;
    box.innerHTML = on
      ? `<span class="setup-chat-ic" aria-hidden="true">${icons.chat}</span>
        <div class="setup-chat-text">
          <h2 id="setup-chat-title">${esc(t('setup.chat.title'))}</h2>
          <p>${esc(t('setup.chat.body'))}</p>
          <div class="setup-chat-actions">
            <button class="btn secondary" data-s="chat-link">${icons.link}<span>${esc(t('chat.workspace.join'))}</span></button>
            <button class="link-btn" data-s="chat-account">${esc(t('setup.chat.account'))}</button>
          </div>
        </div>`
      : '';
  }

  const backButton = (s = 'grid') =>
    `<button class="icon-btn setup-back" data-s="${s}" data-i18n-title="common.actions.back" title="${esc(t('common.actions.back'))}">${icons.back}</button>`;
  const chatHead = (title) => `<div class="login-head"><span class="logo setup-chat-logo">${icons.chat}</span><h2>${esc(title)}</h2></div>`;

  // Team chat, step 1: the invitation link a colleague sent, checked by main before an account exists.
  function showChatLink(value = '') {
    page.innerHTML = `
      ${backButton('chat-back')}
      <div class="setup-inner login" data-chat-step="link">
        ${chatHead(t('setup.chat.linkTitle'))}
        <form class="form" data-form="chat-link" autocomplete="off">
          <p class="setup-chat-lead">${esc(t('setup.chat.linkHelp'))}</p>
          <label>${esc(t('chat.join.link'))}<input type="text" name="link" spellcheck="false" placeholder="https://…/join#w=…" value="${esc(value)}"/></label>
          <div class="error" data-error></div>
          <div class="actions">
            <button type="button" class="link-btn" data-s="chat-nolink">${esc(t('setup.chat.noLink'))}</button>
            <span></span>
            <button class="btn" type="submit">${esc(t('setup.chat.continue'))}</button>
          </div>
        </form>
      </div>`;
    const field = page.querySelector('[name="link"]');
    field.focus();
    if (value) field.select();
  }

  async function checkChatLink(form) {
    const err = form.querySelector('[data-error]');
    const btn = form.querySelector('button[type=submit]');
    const text = String(new FormData(form).get('link') || '').trim();
    err.textContent = '';
    if (!text) {
      err.textContent = t('chat.join.badLink');
      return form.querySelector('[name="link"]').focus();
    }
    btn.disabled = true;
    try {
      chatLink = await api('chatCheckLink', text);
      showChatAccount({ mode: 'signup' });
    } catch (ex) {
      if (!page.isConnected) return;
      btn.disabled = false;
      const own = ctx.chatHost();
      if (ex.code === 'other_server') err.textContent = t('setup.chat.otherServer', { host: linkHost(text) || '?', own });
      else if (ex.code === 'bad_link' || ex.code === 'invalid') err.textContent = t('chat.join.badLink');
      else err.textContent = ex.message;
      form.querySelector('[name="link"]').focus();
    }
  }

  // Team chat, step 2: a Rukoo account, new or existing, which carries the link (main remembers it as a pending join,
  // which Chat opens as soon as it shows, also after a restart).
  async function showChatAccount({ mode = 'signup' } = {}) {
    const status = await api('accountStatus').catch(() => null);
    let info = status && status.info;
    if (!info && status && status.server) info = await api('accountServerInfo').catch(() => null);
    if (!page.isConnected) return;
    const signups = info && info.signups;
    const closed = signups === 'closed';
    const signIn = mode === 'signin' || closed;
    // On an invite-only server an invitation link stands in for the invite code where the server says so (contract
    // 2.12); without one, or where it doesn't, the form asks for the code.
    const linkIsCode = Boolean(chatLink && info && info.workspace && info.workspace.inviteSignups);
    const askCode = !signIn && signups === 'invite' && !linkIsCode;
    // A server that checks addresses takes the invite code as an alternative to a code sent by email.
    const verified = codesFor(info, 'signup');
    const host = ctx.chatHost() || hostOf(status && status.server);
    const lead = chatLink ? t('setup.chat.accountLeadLink', { host }) : t('setup.chat.accountLead', { host });
    page.innerHTML = `
      ${backButton('chat-back')}
      <div class="setup-inner login" data-chat-step="account">
        ${chatHead(signIn ? t('setup.chat.signInTitle') : t('setup.chat.signUpTitle'))}
        <form class="form" data-form="${signIn ? 'chat-signin' : 'chat-signup'}" autocomplete="off">
          <p class="setup-chat-lead">${esc(lead)}</p>
          ${closed && mode !== 'signin' ? `<p class="setup-chat-lead">${esc(t('settings.rukoo.closed'))}</p>` : ''}
          <label>${esc(t('setup.fields.email'))}<input type="email" name="email" autocomplete="username" spellcheck="false" placeholder="${esc(t('setup.fields.emailExample'))}"/></label>
          <label>${esc(t('setup.fields.password'))}<input type="password" name="password" autocomplete="${signIn ? 'current-password' : 'new-password'}"/>
            ${signIn ? '' : `<span class="field-help">${esc(t('settings.rukoo.passwordHelp'))}</span>`}</label>
          ${signIn ? '' : `<label>${esc(t('settings.rukoo.repeat'))}<input type="password" name="repeat" autocomplete="new-password"/></label>`}
          ${
            askCode
              ? verified
                ? `<label>${esc(t('settings.rukoo.inviteOptional'))}<input type="text" name="invite" spellcheck="false" autocomplete="off" aria-describedby="setup-invite-help"/><span class="field-help" id="setup-invite-help">${esc(t('settings.rukoo.inviteOptionalHelp'))}</span></label>`
                : `<label>${esc(t('settings.rukoo.invite'))}<input type="text" name="invite" spellcheck="false" autocomplete="off"/></label>`
              : ''
          }
          ${signIn ? '' : `<label class="inline"><input type="checkbox" name="understand"/> ${esc(t('settings.rukoo.understand'))}</label>`}
          <div class="error" data-error></div>
          <div class="actions">
            ${
              closed
                ? '<span></span>'
                : `<button type="button" class="link-btn" data-s="${signIn ? 'chat-to-signup' : 'chat-to-signin'}">${esc(t(signIn ? 'setup.chat.toSignUp' : 'setup.chat.toSignIn'))}</button>`
            }
            <span></span>
            <button class="btn" type="submit">${esc(signIn ? t('settings.rukoo.signIn') : t('settings.rukoo.create'))}</button>
          </div>
        </form>
      </div>`;
    page.querySelector('[name="email"]').focus();
  }

  async function submitChatAccount(form) {
    const f = new FormData(form);
    const err = form.querySelector('[data-error]');
    const btn = form.querySelector('button[type=submit]');
    const label = btn.textContent;
    const signIn = form.dataset.form === 'chat-signin';
    const email = String(f.get('email') || '').trim();
    const password = String(f.get('password') || '');
    const stop = (message, name) => {
      err.textContent = message;
      if (name) form.querySelector(`[name="${name}"]`)?.focus();
    };
    err.textContent = '';
    if (!email) return stop(t('account.errors.invalid_email'), 'email');
    if (signIn && !password) return stop(t('account.errors.unauthorized'), 'password');
    if (!signIn) {
      if ([...password].length < MIN_PASSWORD) return stop(t('account.errors.weak_password'), 'password');
      if (password !== f.get('repeat')) return stop(t('settings.rukoo.mismatch'), 'repeat');
      if (f.get('understand') !== 'on') return stop(t('settings.rukoo.needUnderstand'), 'understand');
    }
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner"></span>${esc(t('settings.rukoo.working'))}`;
    const join = chatLink ? chatLink.link : '';
    // The code step (email-code.js): a sign-up's on a server that checks addresses, a sign-in's for a locked account.
    let step = chatSteps.get(form);
    if (!step) {
      step = codeStep({ host: form, before: err, purpose: signIn ? 'unlock' : 'signup', emailField: form.querySelector('[name="email"]'), errorEl: err });
      chatSteps.set(form, step);
    }
    try {
      if (signIn) {
        const out = await step.submit(email, (emailCode) => api('accountSignIn', { email, password, join, emailCode }));
        if (!out.done) {
          btn.disabled = false;
          btn.textContent = label;
          return;
        }
        toast(t('settings.rukoo.signedIn'));
      } else {
        const invite = String(f.get('invite') || '').trim();
        const out = await step.submit(email, (emailCode) => api('accountSignUp', { email, password, invite, join, emailCode }), { invited: Boolean(invite) });
        if (!out.done) {
          btn.disabled = false;
          btn.textContent = label;
          return;
        }
        await showRecoveryKey(out.result.recoveryKey);
        toast(t('settings.rukoo.welcome'));
      }
    } catch (ex) {
      if (!page.isConnected) return;
      btn.disabled = false;
      btn.textContent = label;
      return stop(ex.message);
    }
    close();
    // Chat opens, and with a link its Join dialog (chat.js maybeTakeJoin).
    await ctx.enterChat();
  }

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
        <section class="setup-chat" data-setup-chat aria-labelledby="setup-chat-title" hidden></section>
      </div>`;
    renderChatOffer();
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

  // The link to a provider's app password page, for Google and Yahoo. id: the provider whose page it opens.
  const appPasswordLink = (id) =>
    `<button type="button" class="link-btn" data-s="app-password" data-app-password="${esc(id)}" data-i18n="setup.appPassword.create">${esc(t('setup.appPassword.create'))}${icons.popOut}</button>`;
  const appPasswordUrl = (id) => providers.find((x) => x.id === id)?.appPasswordUrl || null;

  function showLogin(id, { forcePassword = false } = {}) {
    if (id === 'google' && !forcePassword && ctx.S.data.googleAvailable) return showGoogle();
    const p = providers.find((x) => x.id === id);
    const manual = p.manual;
    // Google and Yahoo turn a normal password down, so their note comes before the password field, with the link.
    const appPassword = Boolean(p.appPasswordUrl);
    const passwordHint = appPassword ? 'setup.fields.appPasswordHint' : 'setup.fields.passwordHint';
    page.innerHTML = `
      <button class="icon-btn setup-back" data-s="grid" data-i18n-title="common.actions.back" title="${esc(t('common.actions.back'))}">${icons.back}</button>
      <div class="setup-inner login">
        <div class="login-head"><span class="logo">${providerLogos[id]}</span><h2>${esc(t('setup.signIn.title', { provider: p.label }))}</h2></div>
        <form class="form" autocomplete="off">
          <label data-i18n="setup.fields.email">${esc(t('setup.fields.email'))}<input type="email" name="email" required data-i18n-placeholder="setup.fields.emailExample" placeholder="${esc(t('setup.fields.emailExample'))}" spellcheck="false"/></label>
          ${appPassword ? `<div class="setup-callout">${icons.info}<div><p>${esc(p.note)}</p>${appPasswordLink(id)}</div></div>` : ''}
          <label data-i18n="setup.fields.password">${esc(t('setup.fields.password'))}<span class="pw"><input type="password" name="password" required data-i18n-placeholder="${passwordHint}" placeholder="${esc(t(passwordHint))}"/>
            <button type="button" class="icon-btn" data-s="pw" data-i18n-title="setup.fields.showPassword" title="${esc(t('setup.fields.showPassword'))}">${icons.eye}</button></span></label>
          ${appPassword ? '' : `<div class="note">${esc(p.note)}</div>`}
          <div class="manual" ${manual ? '' : 'hidden'}>
            <div class="form" style="padding:0">
              <label data-i18n="setup.fields.username">${esc(t('setup.fields.username'))}<input type="text" name="user" data-i18n-placeholder="setup.fields.usernameHint" placeholder="${esc(t('setup.fields.usernameHint'))}" spellcheck="false"/></label>
              <div class="two"><label data-i18n="setup.fields.imap">${esc(t('setup.fields.imap'))}<input type="text" name="imapHost" value="${esc(p.imap.host)}"/></label>
                <label data-i18n="setup.fields.port">${esc(t('setup.fields.port'))}<input type="number" name="imapPort" value="${p.imap.port}"/></label>
                <label class="inline"><input type="checkbox" name="imapSecure" ${p.imap.secure ? 'checked' : ''}/> SSL/TLS</label></div>
              <div class="two"><label data-i18n="setup.fields.smtp">${esc(t('setup.fields.smtp'))}<input type="text" name="smtpHost" value="${esc(p.smtp.host)}"/></label>
                <label data-i18n="setup.fields.port">${esc(t('setup.fields.port'))}<input type="number" name="smtpPort" value="${p.smtp.port}"/></label>
                <label class="inline"><input type="checkbox" name="smtpSecure" ${p.smtp.secure ? 'checked' : ''}/> SSL/TLS</label></div>
              ${
                // Google's calendar needs browser sign-in; it doesn't take an app password over CalDAV.
                id === 'google'
                  ? ''
                  : `<label data-i18n="settings.server.caldav">${esc(t('settings.server.caldav'))}<input type="text" name="caldavUrl" spellcheck="false" data-i18n-placeholder="settings.server.caldavPlaceholder" placeholder="${esc(t('settings.server.caldavPlaceholder'))}"/>
                <span class="field-help" data-i18n="settings.server.caldavHelp">${esc(t('settings.server.caldavHelp'))}</span></label>`
              }
            </div>
          </div>
          <div class="error" data-error></div>
          <div class="actions">
            <button type="button" class="link-btn" data-s="manual" ${manual ? 'hidden' : ''}>${esc(t('setup.manual.action'))}</button>
            <span></span>
            <button class="btn" type="submit" data-i18n="setup.signIn.action">${esc(t('setup.signIn.action'))}</button>
          </div>
        </form>
        ${
          id === 'google' && !ctx.S.data.googleAvailable
            ? `<div class="setup-foot"><p data-i18n="setup.google.unavailable">${esc(t('setup.google.unavailable'))}</p>
          <button type="button" class="link-btn" data-s="import-google" data-i18n="setup.google.import">${esc(t('setup.google.import'))}</button></div>`
            : ''
        }
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
    if (form.dataset.form === 'chat-link') return checkChatLink(form);
    if (form.dataset.form === 'chat-signup' || form.dataset.form === 'chat-signin') return submitChatAccount(form);
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
      const caldav = String(f.get('caldavUrl') || '').trim();
      if (caldav) input.caldav = { url: caldav };
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
      const refused = ex.code === 'auth';
      // Main names the provider from the tile or, under Other, from the IMAP server, as its message does.
      if (refused && appPasswordUrl(ex.appPasswordProvider)) err.insertAdjacentHTML('beforeend', `<div>${appPasswordLink(ex.appPasswordProvider)}</div>`);
      // A failed automatic setup is usually a server issue; show the manual fields. A refused password is not.
      if (!manualShown && !refused && /IMAP|SMTP|server|Verbinding|time-out/i.test(ex.message)) {
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
    added?.();
  }

  page.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.provider) return showLogin(b.dataset.provider);
    switch (b.dataset.s) {
      case 'close':
        return close();
      case 'chat-link':
        chatLink = null;
        return showChatLink();
      case 'chat-account':
      case 'chat-nolink':
        chatLink = null;
        return showChatAccount({ mode: 'signup' });
      case 'chat-to-signin':
        return showChatAccount({ mode: 'signin' });
      case 'chat-to-signup':
        return showChatAccount({ mode: 'signup' });
      case 'chat-back':
        return back();
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
            // From the Google password form, go on to browser sign-in; from the provider grid, stay there.
            if (b.closest('.login')) showLogin('google');
            else showGrid();
          }
        } catch (ex) {
          toast(ex.message, 5000);
        }
        return;
      case 'app-password': {
        const url = appPasswordUrl(b.dataset.appPassword);
        if (url) api('openExternal', url);
        return;
      }
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

  if (chat === 'link') showChatLink();
  else if (chat === 'account') showChatAccount({ mode: 'signup' });
  else showGrid();
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch (_) {
    return '';
  }
}

// The host of the link in text, for the other-server message; a link pasted without https:// has one too.
function linkHost(text) {
  const s = String(text || '');
  const m = s.match(/https?:\/\/\S+/) || s.match(/[A-Za-z0-9.-]+(?::[0-9]+)?\/\S*join#\S*/);
  if (!m) return '';
  return hostOf(/^https?:\/\//.test(m[0]) ? m[0] : `https://${m[0]}`);
}
