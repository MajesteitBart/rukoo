// Settings > Rukoo account: signing up and in, the devices, and what the account stores and shares. The main
// process does all key work (src/main/account/); passwords go there once and never come back.
import { t } from './i18n.js';
import { api, esc, toast, dialog, confirmDialog, numericDate, hhmm, fileSize, KEEP_OPEN } from './ui.js';

const PROTOCOL_URL = 'https://github.com/MajesteitBart/rukoo/blob/main/server/PROTOCOL.md';
const SELF_HOST_URL = 'https://github.com/MajesteitBart/rukoo/blob/main/server/README.md';
const MIN_PASSWORD = 12;
// Network lookups for a page run once per visit, not on every redraw the status events cause.
const FILL_AGAIN_AFTER = 15000;

export const ACCOUNT_VIEWS = ['rukoo', 'rukoo-signup', 'rukoo-signin', 'rukoo-recover', 'rukoo-privacy'];
// The pages a status event may redraw. Forms are left alone so nothing typed is lost.
const LIVE_VIEWS = ['main', 'rukoo', 'rukoo-privacy'];

const hostOf = (url) => {
  try {
    return new URL(url).host;
  } catch (_) {
    return url || '';
  }
};
const platformName = (p) => (['win32', 'darwin', 'linux', 'android', 'web'].includes(p) ? t(`settings.rukoo.platform.${p}`) : esc(p || ''));
// Rukoo in a browser (src/web): there the account only signs in to team chat. The page keeps no records to sync, has
// no file to export and talks to the server it came from, so those rows stay out, and the texts about "this computer"
// syncing categories have a web version.
const WEB = () => window.mail?.platform === 'web';
const whereText = (info) => {
  const j = info && info.hosting && info.hosting.jurisdiction;
  return t(`settings.rukoo.where.${['eu', 'us', 'fedramp'].includes(j) ? j : 'any'}`);
};
const staticRow = (title, desc = '') => `
  <div class="row static"><div class="text"><div class="title">${title}</div>${desc ? `<div class="desc">${desc}</div>` : ''}</div></div>`;
// Team chat on the server, from its saved info, as main decides it (contract 3.1), and whether a workspace invitation
// works as an invite code there (contract 2.12).
const chatIn = (info) => Boolean(info && Array.isArray(info.features) && info.features.includes('workspaces-v1') && info.workspace && Array.isArray(info.workspace.versions) && info.workspace.versions.includes(1));
const inviteSignups = (info) => chatIn(info) && Boolean(info.workspace.inviteSignups);
// What team chat says now (contract 4.6), or null where main has none.
const chatState = () => api('chatState').catch(() => null);

function showRecoveryKey(key) {
  return dialog({
    title: t('settings.rukoo.keyTitle'),
    wide: true,
    buttons: [{ get label() { return t('settings.rukoo.keySaved'); }, value: true }],
    render(body) {
      body.innerHTML = `<p>${esc(t('settings.rukoo.keyHelp'))}</p>
        <div class="recovery-key" data-recovery-key>${esc(key)}</div>
        <button type="button" class="btn sm secondary" data-copy>${esc(t('settings.rukoo.copy'))}</button>`;
      body.querySelector('[data-copy]').addEventListener('click', () =>
        navigator.clipboard.writeText(key).then(() => toast(t('settings.rukoo.copied')), () => {})
      );
    }
  });
}

// Asks for the password before something that needs it again; null when cancelled. note: a further paragraph, or a
// list of them, such as what becomes of team chat messages when the account goes.
function passwordDialog(title, help, okLabel = t('settings.rukoo.continue'), danger = false, note = '') {
  const notes = (Array.isArray(note) ? note : [note]).filter(Boolean);
  return dialog({
    title,
    buttons: [
      { get label() { return t('common.actions.cancel'); }, value: null },
      {
        label: okLabel,
        danger,
        value: (scrim) => {
          const input = scrim.querySelector('input[name="password"]');
          if (!input.value) {
            input.focus();
            return KEEP_OPEN;
          }
          return input.value;
        }
      }
    ],
    render(body) {
      body.innerHTML = `<div class="form" style="padding:0">
        ${help ? `<p>${esc(help)}</p>` : ''}
        ${notes.map((n) => `<p data-note>${esc(n)}</p>`).join('')}
        <label>${esc(t('setup.fields.password'))}<input type="password" name="password" autocomplete="current-password"/></label></div>`;
      body.querySelector('input').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') body.closest('.dialog').querySelector('.buttons button:last-child').click();
      });
    }
  });
}

function changePasswordDialog() {
  return dialog({
    title: t('settings.rukoo.changePassword'),
    buttons: [
      { get label() { return t('common.actions.cancel'); }, value: null },
      {
        get label() { return t('settings.rukoo.changePassword'); },
        value: (scrim) => {
          const field = (name) => scrim.querySelector(`[name="${name}"]`);
          const error = scrim.querySelector('[data-error]');
          const current = field('current').value;
          const next = field('next').value;
          if (!current) return field('current').focus(), KEEP_OPEN;
          if ([...next].length < MIN_PASSWORD) {
            error.textContent = t('account.errors.weak_password');
            return field('next').focus(), KEEP_OPEN;
          }
          if (next !== field('repeat').value) {
            error.textContent = t('settings.rukoo.mismatch');
            return field('repeat').focus(), KEEP_OPEN;
          }
          return { current, next };
        }
      }
    ],
    render(body) {
      body.innerHTML = `<div class="form" style="padding:0">
        <p>${esc(t('settings.rukoo.changePasswordHelp'))}</p>
        <label>${esc(t('settings.rukoo.currentPassword'))}<input type="password" name="current" autocomplete="current-password"/></label>
        <label>${esc(t('settings.rukoo.newPassword'))}<input type="password" name="next" autocomplete="new-password"/>
          <span class="field-help">${esc(t('settings.rukoo.passwordHelp'))}</span></label>
        <label>${esc(t('settings.rukoo.repeat'))}<input type="password" name="repeat" autocomplete="new-password"/></label>
        <div class="error" data-error></div></div>`;
    }
  });
}

// pages: what settings.js needs. row: its row helper; go, back, close and rerender: its navigation; current(): the page
// on top; promptDialog: its text prompt; jevOn(): whether this computer sorts mail with Jev, which the privacy page
// names; showChat(): puts team chat on screen once Settings closed.
export function accountPages({ row, go, back, close = back, showChat = () => {}, rerender, current, promptDialog, jevOn = () => false }) {
  let status = null;
  let info = null;
  let infoFailed = false;
  let details = null;
  let detailsFailed = false;
  // Goes up with every change of accountKey, so an answer to an earlier ask is dropped, also one for the same key again.
  let generation = 0;
  let filled = { view: null, at: 0 };
  // What the overview last drew of the status (rowHtml).
  let drawnRow = null;

  const signedIn = () => Boolean(status && status.signedIn);
  // Whose details the pages show: the server, email and session signed in to, or null while signed out. In a browser
  // another tab can sign in to another account, or to another session of this one, without this one signing out first,
  // and the status names the session (src/web/host.js); the devices mark the session as this device. On desktop the
  // status has no session, and the key changes only with a sign-in or a sign-out.
  const accountKey = (s) => (s && s.signedIn ? JSON.stringify([s.server || '', s.email || '', s.session || '']) : null);
  // What the overview shows of the status: its row (who is signed in, an error) and, through chatState, whether the
  // server has team chat. A sync's start and end change only the sync line, which the overview doesn't show.
  const rowShown = (s) => JSON.stringify(s ? [Boolean(s.signedIn), s.email || null, s.error || null, s.errorText || null, chatIn(s.info)] : null);

  // The status from now on. Another account, or none, drops the details of the one before, and whether they failed to
  // load; fill() asks for them again.
  function take(next) {
    const was = accountKey(status);
    status = next;
    if (was !== accountKey(status)) {
      generation += 1;
      details = null;
      detailsFailed = false;
      filled = { view: null, at: 0 };
    }
  }

  async function prepare(view) {
    take(await api('accountStatus').catch(() => status));
    if (status && status.info) info = status.info;
    if (status && !status.server) info = null;
    // The sign-up form depends on the server (invite-only, closed), and a redraw later would lose what was typed.
    if (view === 'rukoo-signup' && status && status.server && !info) {
      info = await api('accountServerInfo').catch(() => null);
      infoFailed = !info;
    }
  }

  // After a page is drawn: what needs the server, then one redraw. Forms get none.
  function fill(view) {
    if (!status || !LIVE_VIEWS.includes(view) || (filled.view === view && Date.now() - filled.at < FILL_AGAIN_AFTER)) return;
    filled = { view, at: Date.now() };
    const jobs = [];
    if (status.server && view !== 'main') {
      jobs.push(
        api('accountServerInfo')
          .then((i) => ((info = i), (infoFailed = false)))
          .catch(() => (infoFailed = true))
      );
    }
    if (signedIn() && (view === 'rukoo' || view === 'rukoo-privacy')) {
      // An answer for a session signed in before is dropped: take() has the pages ask for the one signed in now.
      const asked = generation;
      jobs.push(
        api('accountDetails')
          .then((d) => {
            if (generation !== asked) return;
            details = d;
            detailsFailed = false;
          })
          .catch(() => {
            if (generation === asked) detailsFailed = true;
          })
      );
    }
    if (jobs.length) Promise.all(jobs).then(() => current() === view && rerender());
  }

  function onStatus(next) {
    take(next);
    if (next && next.info) info = next.info;
    // The overview redraws only when its row would change: every sync sends two statuses, and a redraw replaces the
    // row under the pointer and the rows of everything else on it.
    const view = current();
    if (view === 'main') {
      if (rowShown(next) !== drawnRow) rerender();
    } else if (LIVE_VIEWS.includes(view)) rerender();
  }

  const syncLine = () => {
    if (!status) return '';
    if (status.syncing) return esc(t('settings.rukoo.syncing'));
    if (status.error) return `<span class="error">${esc(status.errorText || '')}</span>`;
    const last = status.lastSync ? t('settings.account.lastSync', { date: numericDate(status.lastSync), time: hhmm(status.lastSync) }) : t('settings.rukoo.neverSynced');
    return esc(status.pending ? `${t('settings.rukoo.pending', { count: status.pending })} · ${last}` : last);
  };

  const serverRow = () => {
    const server = status && status.server;
    let desc = '';
    if (server && infoFailed && !info) desc = esc(t('settings.rukoo.serverUnreachable'));
    else if (server && info) desc = esc(`${t('settings.rukoo.serverRunBy', { operator: (info.operator && info.operator.name) || hostOf(server) })} · ${whereText(info)}`);
    return row({ title: esc(server ? hostOf(server) : t('settings.rukoo.serverNone')), desc, action: 'rukoo-server' });
  };

  // The server on the web: the one the page came from, which the page can't change.
  const webServerRow = () => {
    const server = status && status.server;
    let desc = '';
    if (server && infoFailed && !info) desc = esc(t('settings.rukoo.serverUnreachable'));
    else if (server && info) desc = esc(`${t('settings.rukoo.serverRunBy', { operator: (info.operator && info.operator.name) || hostOf(server) })} · ${whereText(info)}`);
    return staticRow(esc(server ? hostOf(server) : t('settings.rukoo.serverNone')), desc);
  };

  // The row on the Settings overview.
  function rowHtml() {
    drawnRow = rowShown(status);
    const desc = signedIn() ? esc(t('settings.rukoo.rowSignedIn', { email: status.email })) : esc(WEB() ? t('settings.rukoo.webRowSignedOut') : t('settings.rukoo.rowSignedOut'));
    const error = signedIn() && status.error ? ` · <span class="error">${esc(status.errorText || '')}</span>` : '';
    return row({ title: esc(t('settings.rukoo.title')), desc: desc + error, action: 'rukoo' });
  }

  function signedOutPage() {
    return `
      <p class="settings-text">${esc(WEB() ? t('settings.rukoo.webIntro') : t('settings.rukoo.intro'))}</p>
      ${status && status.error === 'signed_out' ? `<p class="settings-text error">${esc(status.errorText || '')}</p>` : ''}
      <div class="settings-group-title">${esc(t('settings.rukoo.server'))}</div>
      <div class="card">${WEB() ? webServerRow() : serverRow()}</div>
      <div class="settings-group-title"></div>
      <div class="card">
        ${row({ title: esc(t('settings.rukoo.signUp')), action: 'rukoo-go:rukoo-signup' })}
        ${row({ title: esc(t('settings.rukoo.signIn')), action: 'rukoo-go:rukoo-signin' })}
        ${row({ title: esc(t('settings.rukoo.forgot')), action: 'rukoo-go:rukoo-recover' })}
      </div>
      ${
        WEB()
          ? ''
          : `<div class="settings-group-title"></div>
      <div class="card">${row({ title: esc(t('settings.rukoo.privacy')), desc: esc(t('settings.rukoo.privacyHelp')), action: 'rukoo-go:rukoo-privacy' })}</div>`
      }`;
  }

  function devicesHtml() {
    if (detailsFailed && !details) return staticRow(esc(t('settings.rukoo.devicesUnavailable')));
    if (!details) return staticRow('<span class="spinner"></span>');
    const list = [...(details.devices || [])].sort((a, b) => Number(b.current) - Number(a.current) || (b.lastSeenAt || 0) - (a.lastSeenAt || 0));
    return list
      .map((d) =>
        d.current
          ? staticRow(esc(d.name), `${esc(t('settings.rukoo.thisDevice'))} · ${platformName(d.platform)}`)
          : row({
              title: esc(d.name),
              desc: `${esc(t('settings.rukoo.lastSeen', { date: numericDate(d.lastSeenAt || d.createdAt) }))} · ${platformName(d.platform)}`,
              action: `rukoo-device:${encodeURIComponent(d.id)}`
            })
      )
      .join('');
  }

  function signedInPage() {
    const server = status.server;
    const by = info && info.operator && info.operator.name ? ` · ${t('settings.rukoo.serverRunBy', { operator: info.operator.name })}` : '';
    const web = WEB();
    return `
      <div class="settings-group-title">${esc(t('settings.rukoo.account'))}</div>
      <div class="card">
        ${staticRow(esc(status.email), esc(hostOf(server) + by))}
        ${web ? '' : row({ title: esc(t('settings.rukoo.syncNow')), desc: syncLine(), action: 'rukoo-sync' })}
      </div>
      <div class="settings-group-title">${esc(t('settings.rukoo.devices'))}</div>
      <div class="card">${devicesHtml()}</div>
      ${web ? '' : securityAndData()}
      <div class="settings-group-title"></div>
      <div class="card">
        ${row({ title: esc(t('settings.rukoo.signOut')), desc: esc(web ? t('settings.rukoo.webSignOutHelp') : t('settings.rukoo.signOutHelp')), action: 'rukoo-signout' })}
        ${row({ title: esc(t('settings.rukoo.delete')), desc: esc(t('settings.rukoo.deleteHelp')), action: 'rukoo-delete', cls: 'danger' })}
      </div>`;
  }

  // Security and Your data: change password, a new recovery key, the privacy page and the export. The web leaves them
  // out.
  function securityAndData() {
    return `
      <div class="settings-group-title">${esc(t('settings.rukoo.security'))}</div>
      <div class="card">
        ${row({ title: esc(t('settings.rukoo.changePassword')), desc: esc(t('settings.rukoo.changePasswordHelp')), action: 'rukoo-password' })}
        ${row({ title: esc(t('settings.rukoo.newKey')), desc: esc(t('settings.rukoo.newKeyHelp')), action: 'rukoo-newkey' })}
      </div>
      <div class="settings-group-title">${esc(t('settings.rukoo.yourData'))}</div>
      <div class="card">
        ${row({ title: esc(t('settings.rukoo.privacy')), desc: esc(t('settings.rukoo.privacyHelp')), action: 'rukoo-go:rukoo-privacy' })}
        ${row({ title: esc(t('settings.rukoo.export')), desc: esc(t('settings.rukoo.exportHelp')), action: 'rukoo-export' })}
      </div>`;
  }

  const passwordFields = (label) => `
    <label>${esc(label)}<input type="password" name="password" autocomplete="new-password"/>
      <span class="field-help">${esc(t('settings.rukoo.passwordHelp'))}</span></label>
    <label>${esc(t('settings.rukoo.repeat'))}<input type="password" name="repeat" autocomplete="new-password"/></label>`;
  const submitRow = (label) => `<div class="error" data-error></div><div><button class="btn primary" type="submit">${esc(label)}</button></div>`;
  const emailField = () => `<label>${esc(t('setup.fields.email'))}<input type="email" name="email" autocomplete="username" spellcheck="false"/></label>`;

  function signUpPage() {
    if (info && info.signups === 'closed') return `<p class="settings-text">${esc(WEB() ? t('settings.rukoo.webClosed') : t('settings.rukoo.closed'))}</p>`;
    // A page opened from an invitation link holds it (src/web/join.js, status.invitation), and the bridge signs up
    // with it, so the form says so instead of asking for the link again. A server that needs a code the invitation
    // can't stand in for keeps the field; the field also comes back when the server refuses the invitation (submit).
    const invitation = WEB() && Boolean(status && status.invitation) && !(info && info.signups === 'invite' && !inviteSignups(info));
    return `<div class="card"><form class="form" data-form="rukoo-signup">
      ${emailField()}
      ${passwordFields(t('setup.fields.password'))}
      ${invitation ? `<div class="field-help" data-invitation>${esc(t('settings.rukoo.webInvitation'))}</div>` : ''}
      ${
        info && info.signups === 'invite'
          ? `<label${invitation ? ' hidden data-invite-field' : ''}>${esc(t('settings.rukoo.invite'))}<input type="text" name="invite" spellcheck="false" autocomplete="off"${inviteSignups(info) ? ' aria-describedby="rukoo-invite-help"' : ''}/>${
              inviteSignups(info) ? `<span class="field-help" id="rukoo-invite-help">${esc(t('settings.rukoo.inviteChatHelp'))}</span>` : ''
            }</label>`
          : ''
      }
      <label class="inline"><input type="checkbox" name="understand"/> ${esc(t('settings.rukoo.understand'))}</label>
      ${submitRow(t('settings.rukoo.create'))}
    </form></div>`;
  }

  function signInPage() {
    return `<div class="card"><form class="form" data-form="rukoo-signin">
      ${emailField()}
      <label>${esc(t('setup.fields.password'))}<input type="password" name="password" autocomplete="current-password"/></label>
      ${submitRow(t('settings.rukoo.signIn'))}
    </form></div>`;
  }

  function recoverPage() {
    return `<p class="settings-text">${esc(t('settings.rukoo.recoverHelp'))}</p>
      <div class="card"><form class="form" data-form="rukoo-recover">
      ${emailField()}
      <label>${esc(t('settings.rukoo.recoveryKeyField'))}<input type="text" name="recoveryKey" spellcheck="false" autocomplete="off" placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"/></label>
      ${passwordFields(t('settings.rukoo.newPassword'))}
      ${submitRow(t('settings.rukoo.recoverSubmit'))}
    </form></div>`;
  }

  function privacyPage() {
    const counts = (status && status.counts) || {};
    const corrections = (counts.override || 0) + (counts.sender || 0);
    const operator = info && info.operator && info.operator.name;
    const hosting = (info && info.hosting) || {};
    const country = hosting.country === 'US' ? t('settings.rukoo.country.US') : hosting.country || '';
    const unknown = esc(status && status.server ? t('settings.rukoo.serverUnreachable') : t('settings.rukoo.serverNone'));
    return `
      <div class="settings-group-title">${esc(t(signedIn() ? 'settings.rukoo.stored' : 'settings.rukoo.storedLocal'))}</div>
      <div class="card">
        ${staticRow(esc(t('settings.rukoo.count.category', { count: counts.category || 0 })))}
        ${staticRow(esc(t('settings.rukoo.count.classification', { count: counts.classification || 0 })))}
        ${staticRow(esc(t('settings.rukoo.count.correction', { count: corrections })))}
        ${signedIn() && details && details.usage ? staticRow(esc(t('settings.rukoo.serverUsage', { size: fileSize(details.usage.bytes || 0) }))) : ''}
      </div>
      <p class="settings-text">${esc(t('settings.rukoo.storedHelp'))}</p>
      <div class="settings-group-title">${esc(t('settings.rukoo.canSee'))}</div>
      <div class="card">
        ${staticRow(esc(t('settings.rukoo.see.email')))}
        ${staticRow(esc(t('settings.rukoo.see.devices')))}
        ${staticRow(esc(t('settings.rukoo.see.records')))}
        ${staticRow(esc(t('settings.rukoo.see.ip')))}
        ${staticRow(esc(t('settings.booking.privacyTitle')), esc(t('settings.booking.privacySee')))}
      </div>
      <div class="settings-group-title">${esc(t('settings.rukoo.cantSee'))}</div>
      <div class="card">${staticRow(esc(t('settings.rukoo.cantSeeHelp')))}</div>
      <div class="settings-group-title">${esc(t('settings.rukoo.services'))}</div>
      <div class="card">
        ${info ? staticRow(esc(operator || hostOf(status.server)), esc(t('settings.rukoo.operatorHelp'))) : staticRow(unknown)}
        ${
          info && hosting.company
            ? staticRow(
                esc(hosting.company),
                esc(`${t('settings.rukoo.hostHelp', { country, where: whereText(info) })}${hosting.country === 'US' ? ` ${t('settings.rukoo.usLaw')}` : ''}`)
              )
            : ''
        }
        ${jevOn() ? staticRow(esc(t('settings.rukoo.typesafe')), esc(t('settings.rukoo.typesafeHelp'))) : ''}
        ${staticRow(esc(t('settings.rukoo.mailProviders')), esc(t('settings.rukoo.mailProvidersHelp')))}
        ${staticRow(esc(t('settings.rukoo.nobodyElse')), esc(t('settings.rukoo.nobodyElseHelp')))}
      </div>
      <div class="settings-group-title"></div>
      <div class="card">
        ${info && info.operator && info.operator.privacy ? row({ title: esc(t('settings.rukoo.policy')), desc: esc(t('settings.rukoo.policyHelp', { operator: operator || hostOf(status.server) })), action: 'rukoo-link:policy' }) : ''}
        ${row({ title: esc(t('settings.rukoo.protocol')), desc: esc(t('settings.rukoo.protocolHelp')), action: 'rukoo-link:protocol' })}
        ${row({ title: esc(t('settings.rukoo.selfHost')), desc: esc(t('settings.rukoo.selfHostHelp')), action: 'rukoo-link:selfhost' })}
      </div>`;
  }

  // { title, body } of an account page.
  function view(name) {
    if (name === 'rukoo') return { title: t('settings.rukoo.title'), body: signedIn() ? signedInPage() : signedOutPage() };
    if (name === 'rukoo-signup') return { title: t('settings.rukoo.signUp'), body: signUpPage() };
    if (name === 'rukoo-signin') return { title: t('settings.rukoo.signIn'), body: signInPage() };
    if (name === 'rukoo-recover') return { title: t('settings.rukoo.forgot'), body: recoverPage() };
    return { title: t('settings.rukoo.privacy'), body: privacyPage() };
  }

  async function submit(form) {
    const f = new FormData(form);
    const err = form.querySelector('[data-error]');
    const btn = form.querySelector('button[type=submit]');
    const label = btn.textContent;
    const field = (name) => form.querySelector(`[name="${name}"]`);
    const stop = (message, name) => {
      err.textContent = message;
      if (name) field(name).focus();
    };
    err.textContent = '';
    const kind = form.dataset.form;
    const password = String(f.get('password') || '');
    if (kind !== 'rukoo-signin') {
      if ([...password].length < MIN_PASSWORD) return stop(t('account.errors.weak_password'), 'password');
      if (password !== f.get('repeat')) return stop(t('settings.rukoo.mismatch'), 'repeat');
    }
    if (kind === 'rukoo-signup' && f.get('understand') !== 'on') return stop(t('settings.rukoo.needUnderstand'), 'understand');
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner"></span>${esc(t('settings.rukoo.working'))}`;
    try {
      const email = String(f.get('email') || '');
      if (kind === 'rukoo-signup') {
        const res = await api('accountSignUp', { email, password, invite: String(f.get('invite') || '') });
        await showRecoveryKey(res.recoveryKey);
        toast(WEB() ? t('settings.rukoo.webWelcome') : t('settings.rukoo.welcome'));
      } else if (kind === 'rukoo-signin') {
        await api('accountSignIn', { email, password });
        toast(WEB() ? t('settings.rukoo.webSignedIn') : t('settings.rukoo.signedIn'));
      } else {
        await api('accountRecover', { email, recoveryKey: String(f.get('recoveryKey') || ''), password });
        toast(WEB() ? t('settings.rukoo.webSignedIn') : t('settings.rukoo.signedIn'));
      }
      take(await api('accountStatus').catch(() => status));
      filled = { view: null, at: 0 };
      // A sign-up with an invitation link left a pending join: Settings closes back to Chat, which opens the Join
      // dialog with the link (contract 3.3, 5.10).
      const chat = kind === 'rukoo-signup' ? await chatState() : null;
      if (chat && chat.pendingJoin) {
        close();
        showChat();
        return;
      }
      back();
    } catch (ex) {
      // The server refused the page's invitation (used, expired or withdrawn), which the bridge sends while the invite
      // code field it stands in for is empty: the field shows after all, and the error says the link stopped working
      // instead of asking for a code the person most likely never had. Only the web's account errors carry a code.
      const field = kind === 'rukoo-signup' && ex.code === 'invite_required' ? form.querySelector('[data-invite-field]') : null;
      const refused = Boolean(field) && !String(f.get('invite') || '').trim();
      if (field) {
        field.hidden = false;
        form.querySelector('[data-invitation]')?.remove();
      }
      stop(refused ? t('settings.rukoo.webInvitationGone') : ex.message, field ? 'invite' : undefined);
      btn.disabled = false;
      btn.textContent = label;
    }
  }

  const run = async (work, done) => {
    try {
      const res = await work();
      if (done) toast(done);
      return res;
    } catch (err) {
      toast(err.message, 6000);
      return null;
    } finally {
      filled = { view: null, at: 0 };
      await prepare();
      rerender();
    }
  };

  // Handles a data-a action of these pages; false when it isn't one.
  async function click(a) {
    if (a === 'rukoo') return go('rukoo'), true;
    if (a.startsWith('rukoo-go:')) return go(a.slice(9)), true;
    if (a.startsWith('rukoo-link:')) {
      const which = a.slice(11);
      const url = which === 'policy' ? info && info.operator && info.operator.privacy : which === 'protocol' ? PROTOCOL_URL : SELF_HOST_URL;
      if (url) api('openExternal', url);
      return true;
    }
    if (a.startsWith('rukoo-device:')) {
      const id = decodeURIComponent(a.slice(13));
      const device = details && (details.devices || []).find((d) => d.id === id);
      const name = device ? device.name : id;
      const ok = await confirmDialog(t('settings.rukoo.removeDevice', { name }), t('settings.rukoo.removeDeviceHelp', { name }), t('settings.rukoo.removeDeviceAction'), true);
      if (ok) await run(() => api('accountRemoveDevice', id), t('settings.rukoo.deviceRemoved'));
      return true;
    }
    switch (a) {
      case 'rukoo-server': {
        const v = await promptDialog(t('settings.rukoo.serverPrompt'), (status && status.server) || '', { placeholder: 'https://' });
        if (v === null) return true;
        info = null;
        infoFailed = false;
        await run(() => api('accountSetServer', v.trim()), t('settings.rukoo.serverSaved'));
        return true;
      }
      case 'rukoo-sync':
        await run(() => api('accountSync'), t('settings.rukoo.synced'));
        return true;
      case 'rukoo-password': {
        const v = await changePasswordDialog();
        if (v) await run(() => api('accountChangePassword', v.current, v.next), t('settings.rukoo.passwordChanged'));
        return true;
      }
      case 'rukoo-newkey': {
        const password = await passwordDialog(t('settings.rukoo.newKey'), t('settings.rukoo.newKeyHelp'));
        if (!password) return true;
        const res = await run(() => api('accountNewRecoveryKey', password));
        if (res) await showRecoveryKey(res.recoveryKey);
        return true;
      }
      case 'rukoo-export': {
        const file = await run(() => api('accountExport'));
        if (file) toast(t('settings.rukoo.exported'));
        return true;
      }
      case 'rukoo-signout': {
        // Unsent chat messages live in the chat cache, which goes with the session (contract 3.4). In a browser every
        // tab shares the session, so the messages the other tabs hold (unsentElsewhere, src/web/host.js) go too.
        const chat = await chatState();
        const web = WEB();
        const count = chat ? (Number(chat.unsent) || 0) + (web ? Number(chat.unsentElsewhere) || 0 : 0) : 0;
        const unsent = count > 0 ? ` ${t(web ? 'settings.rukoo.webUnsentChat' : 'settings.rukoo.unsentChat', { count })}` : '';
        // In a browser another tab can sign in to another account while this asks; the bridge then stops instead.
        const expect = web ? [{ email: status && status.email }] : [];
        const ok = await confirmDialog(t('settings.rukoo.signOut'), `${web ? t('settings.rukoo.webSignOutHelp') : t('settings.rukoo.signOutHelp')}${unsent}`, t('settings.rukoo.signOut'));
        if (ok) await run(() => api('accountSignOut', ...expect), t('settings.rukoo.signedOut'));
        return true;
      }
      case 'rukoo-delete': {
        const chat = await chatState();
        // The browser keeps no key for the booking page's handle (docs/account.md, In a browser), so a deletion here
        // also gives the handle up for good; the desktop app keeps one for a new account.
        const note = [chat && chat.available ? t('settings.rukoo.deleteChatNote') : '', WEB() ? t('settings.rukoo.webDeleteBooking') : ''];
        const expect = WEB() ? [{ email: status && status.email }] : [];
        const password = await passwordDialog(t('settings.rukoo.delete'), t('settings.rukoo.deleteHelp'), t('settings.rukoo.delete'), true, note);
        if (password) await run(() => api('accountDelete', password, ...expect), t('settings.rukoo.deleted'));
        return true;
      }
    }
    return false;
  }

  return { prepare, fill, onStatus, rowHtml, view, submit, click };
}
