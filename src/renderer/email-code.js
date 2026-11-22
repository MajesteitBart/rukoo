// The code step of the Rukoo account forms (server/PROTOCOL.md, POST /v1/email-code): Settings > Rukoo account's
// sign-up, sign-in and recovery, the setup page's team chat step and the What's new guide, on desktop and in the
// browser (src/web). A sign-up on a server that checks addresses gets a code before the account is made. A sign-in or
// recovery that the account's lock stops can get one to go past the lock.
//
// The challenge the server answers stays where the account lives (src/main/account/index.js requestCode, and
// src/web/account/service.js): the window sends the address, and later what was typed in the code field, the six
// digits or the long code. Everything else the form holds stays as it was typed while the step shows.
import { t } from './i18n.js';
import { api, esc } from './ui.js';

// The server sends an address at most one code of a purpose a minute.
const GAP = 60;
// Up to this wait the resend button counts down; a longer one (the hourly or daily limit) is said in the error line.
const COUNTDOWN = 90;

// Whether the server mails codes for purpose ('signup' or 'unlock'): email-codes in its features and the purpose in
// emailCodes.purposes. Without both, the forms work as they did before codes.
export const codesFor = (info, purpose) =>
  Boolean(
    info &&
      Array.isArray(info.features) &&
      info.features.includes('email-codes') &&
      info.emailCodes &&
      Array.isArray(info.emailCodes.purposes) &&
      info.emailCodes.purposes.includes(purpose)
  );

const sameAddress = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

// "You can ask for a new code in 5 minutes": seconds as seconds, minutes or hours, rounded up.
export function waitText(seconds) {
  const s = Math.max(1, Math.ceil(Number(seconds) || GAP));
  if (s < 60) return t('settings.rukoo.code.waitSeconds', { count: s });
  if (s < 3600) return t('settings.rukoo.code.waitMinutes', { count: Math.ceil(s / 60) });
  return t('settings.rukoo.code.waitHours', { count: Math.ceil(s / 3600) });
}

// The words for an error of a request that carried a code, or null for one the form words as before. code_wrong says
// how many tries the code has left; after the last, the six digits are done and only a new code or the long code works.
export function codeErrorText(ex) {
  const code = ex && ex.code;
  if (code === 'code_wrong') {
    const left = Number(ex.attemptsLeft);
    return Number.isFinite(left) && left > 0 ? t('settings.rukoo.code.wrong', { count: left }) : t('settings.rukoo.code.wrongLast');
  }
  if (['code_expired', 'code_format', 'code_in_use', 'code_required', 'mail_unavailable'].includes(code)) return t(`account.errors.${code}`);
  return null;
}

// The step inside a form. host: the element it goes into; before: the element it goes in front of (null: at the end).
// purpose: 'signup' or 'unlock'. emailField: the form's address field; changing the address drops the step, so the
// next submit sends a code to the new one. errorEl: the form's error line, which also holds "Email me a code" for a
// locked account. compact: the What's new guide's fields, with placeholders and no labels. onChange(state): called
// with what snapshot() would give each time a code went out or was held back, and with null once the step is gone, so
// a form that draws itself again (the What's new guide) keeps it. It also runs when the step is no longer on screen:
// an answer that comes after the page moved on still counts for the address it went to.
export function codeStep({ host, before = null, purpose, emailField, errorEl, compact = false, onChange = null }) {
  let el = null;
  let sentTo = null;
  let until = 0;
  let timer = null;
  // Goes up with each request for a code and each reset, so only the answer to the newest request counts.
  let requests = 0;
  // Whether the step shows for a code that went out, or for one the server's limit held back.
  let delivered = true;

  // The step as it stands, also while it isn't on screen; null when there is none.
  const state = () => (el ? { email: sentTo, sent: delivered, until } : null);
  const changed = () => {
    if (onChange) onChange(state());
  };

  const input = () => el && el.querySelector('[name="emailCode"]');
  const resendButton = () => el && el.querySelector('[data-code-resend]');
  const active = () => Boolean(el && el.isConnected);
  const value = () => (input() ? String(input().value || '').trim() : '');
  const focus = () => input() && input().focus();

  // The error line: text, and an action as a link button after it.
  function showError(text, action = null) {
    errorEl.textContent = text || '';
    if (!action) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'link-btn code-offer';
    btn.dataset.codeOffer = '';
    btn.textContent = action.label;
    btn.addEventListener('click', () => {
      btn.disabled = true;
      action.run();
    });
    errorEl.append(' ', btn);
  }

  function tick() {
    const btn = resendButton();
    if (!btn || !el.isConnected) {
      clearInterval(timer);
      timer = null;
      return;
    }
    const left = Math.ceil((until - Date.now()) / 1000);
    btn.disabled = left > 0;
    btn.textContent = left > 0 && left <= COUNTDOWN ? t('settings.rukoo.code.resendIn', { count: left }) : t('settings.rukoo.code.resend');
    if (left <= 0) {
      clearInterval(timer);
      timer = null;
    }
  }

  function wait(seconds) {
    until = Date.now() + Math.max(1, seconds) * 1000;
    clearInterval(timer);
    timer = setInterval(tick, 1000);
    tick();
  }

  // sent: false when the server sent no new code (its limit): the line then says an earlier email's long code works.
  function draw(email, { sent = true } = {}) {
    delivered = sent;
    const help = esc(t('settings.rukoo.code.help'));
    const field = compact
      ? `<input class="wn-input wide" name="emailCode" type="text" placeholder="${esc(t('settings.rukoo.code.label'))}" aria-label="${esc(t('settings.rukoo.code.label'))}" autocomplete="one-time-code" spellcheck="false" maxlength="200">
         <span class="code-help wide">${help}</span>`
      : `<label>${esc(t('settings.rukoo.code.label'))}<input type="text" name="emailCode" autocomplete="one-time-code" spellcheck="false" maxlength="200"/>
           <span class="field-help">${help}</span></label>`;
    const html = `<div class="code-step${compact ? ' wide compact' : ''}" data-code-step data-purpose="${esc(purpose)}">
        <p class="code-sent" data-code-sent>${esc(t(sent ? 'settings.rukoo.code.sent' : 'settings.rukoo.code.notSent', { email }))}</p>
        ${field}
        <div class="code-actions"><button type="button" class="link-btn" data-code-resend>${esc(t('settings.rukoo.code.resend'))}</button></div>
      </div>`;
    if (el) el.remove();
    const tpl = document.createElement('template');
    tpl.innerHTML = html.trim();
    el = tpl.content.firstElementChild;
    host.insertBefore(el, before && before.parentNode === host ? before : null);
    resendButton().addEventListener('click', () => resend());
  }

  // Asks for a code for email and shows the step. note: a line said in the error place once it went, such as "That
  // invite code didn't work". false when the server refused: the error line says why. When the server's limit refused
  // it, the step shows anyway, or stays: the long code of an email sent before works on any device, also of one a
  // stranger asked for to use up the address's codes (server/PROTOCOL.md, POST /v1/email-code). An answer that comes
  // after the address changed, or after a newer request, changes nothing.
  async function send(email, { note = '' } = {}) {
    const asked = ++requests;
    const current = () => asked === requests && (!emailField || sameAddress(emailField.value, email));
    const btn = resendButton();
    if (btn) btn.disabled = true;
    try {
      const res = await api('accountEmailCode', { email, purpose });
      if (!current()) return false;
      const address = (res && res.email) || String(email || '').trim().toLowerCase();
      const again = active() && sameAddress(sentTo, address);
      sentTo = address;
      if (!again) draw(address);
      else {
        delivered = true;
        el.querySelector('[data-code-sent]').textContent = t('settings.rukoo.code.resent', { email: address });
      }
      showError(note);
      wait(GAP);
      changed();
      focus();
      return true;
    } catch (ex) {
      if (!current()) return false;
      if (ex && ex.code === 'rate_limited') {
        const seconds = Number(ex.waitSeconds) || Number(ex.retryAfter) || GAP;
        if (!active() || !sameAddress(sentTo, email)) {
          sentTo = String(email || '').trim().toLowerCase();
          draw(sentTo, { sent: false });
        }
        wait(seconds);
        changed();
        showError(waitText(seconds));
        focus();
      } else {
        showError(codeErrorText(ex) || (ex && ex.message) || '');
        if (btn && !timer) btn.disabled = false;
      }
      return false;
    }
  }

  const resend = () => (sentTo ? send(sentTo) : Promise.resolve(false));

  // The step on screen, for restore(): the address, whether a code went out, and when a new one may be asked for.
  const snapshot = () => (active() ? state() : null);

  // The step again from a snapshot(), as the What's new guide draws its page again; no new request.
  function restore({ email, sent = true, until: resendAt = 0 }) {
    sentTo = email;
    draw(email, { sent });
    if (resendAt > Date.now()) wait((resendAt - Date.now()) / 1000);
  }

  function reset() {
    requests += 1;
    clearInterval(timer);
    timer = null;
    const had = Boolean(el);
    if (el) el.remove();
    el = null;
    sentTo = null;
    if (had) changed();
  }

  // One submit of the form. run(emailCode) makes the request with what the code field holds ('' while the step isn't
  // shown) and returns its answer. { done: true, result } once it went through; { done: false } when the form stays,
  // with the step shown or the error line saying what to do. Errors the step has no words for are thrown, for the
  // form to show as before. invited: the form sends the operator's invite code, which needs no emailed code, so an
  // empty code field doesn't stop it, and code_required means that invite code didn't work. An unlock code is needed
  // only while the lock lasts, so an empty field goes too: once the lock is over the sign-in works without one, and
  // while it lasts the server says locked again and the step asks for the code.
  async function submit(email, run, { invited = false } = {}) {
    if (purpose === 'signup' && active() && !value() && !invited) {
      showError(t('settings.rukoo.code.missing'));
      focus();
      return { done: false };
    }
    const shown = active();
    try {
      return { done: true, result: await run(shown ? value() : '') };
    } catch (ex) {
      const code = ex && ex.code;
      // The server checks addresses: a code first, then the same submit again. With a code already sent there, the
      // invite code typed since didn't work, and the emailed code still does.
      if (purpose === 'signup' && code === 'code_required') {
        if (shown && sameAddress(sentTo, email)) {
          showError(t('settings.rukoo.code.inviteWrong'));
          focus();
          return { done: false };
        }
        await send(email, { note: invited ? t('settings.rukoo.code.inviteFailed', { email }) : '' });
        return { done: false };
      }
      // Still locked, and the code went out already: the step asks for it.
      if (purpose === 'unlock' && code === 'locked' && shown) {
        showError(t('settings.rukoo.code.missing'));
        focus();
        return { done: false };
      }
      // Too many wrong passwords locked the account; where the server sends codes, one gets past the lock now.
      if (purpose === 'unlock' && code === 'locked' && !shown) {
        const status = await api('accountStatus').catch(() => null);
        if (codesFor(status && status.info, 'unlock')) {
          const address = () => (emailField ? emailField.value : email);
          showError(t('settings.rukoo.code.locked'), { label: t('settings.rukoo.code.emailMe'), run: () => send(address()) });
          return { done: false };
        }
      }
      const text = shown ? codeErrorText(ex) : null;
      if (text) {
        showError(text);
        focus();
        return { done: false };
      }
      throw ex;
    }
  }

  if (emailField) {
    emailField.addEventListener('input', () => {
      if (el && !sameAddress(emailField.value, sentTo)) reset();
    });
  }

  return {
    get active() {
      return active();
    },
    get email() {
      return sentTo;
    },
    // What was typed in the code field: six digits or the long code.
    value,
    focus,
    send,
    submit,
    snapshot,
    restore,
    reset
  };
}
