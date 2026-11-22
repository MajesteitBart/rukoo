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
// locked account. compact: the What's new guide's fields, with placeholders and no labels.
export function codeStep({ host, before = null, purpose, emailField, errorEl, compact = false }) {
  let el = null;
  let sentTo = null;
  let until = 0;
  let timer = null;

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

  function draw(email) {
    const help = esc(t('settings.rukoo.code.help'));
    const field = compact
      ? `<input class="wn-input wide" name="emailCode" type="text" placeholder="${esc(t('settings.rukoo.code.label'))}" aria-label="${esc(t('settings.rukoo.code.label'))}" autocomplete="one-time-code" spellcheck="false" maxlength="200">
         <span class="code-help wide">${help}</span>`
      : `<label>${esc(t('settings.rukoo.code.label'))}<input type="text" name="emailCode" autocomplete="one-time-code" spellcheck="false" maxlength="200"/>
           <span class="field-help">${help}</span></label>`;
    const html = `<div class="code-step${compact ? ' wide compact' : ''}" data-code-step data-purpose="${esc(purpose)}">
        <p class="code-sent" data-code-sent>${esc(t('settings.rukoo.code.sent', { email }))}</p>
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
  // invite code didn't work". false when the server refused: the error line says why, and the step stays as it was.
  async function send(email, { note = '' } = {}) {
    const btn = resendButton();
    if (btn) btn.disabled = true;
    try {
      const res = await api('accountEmailCode', { email, purpose });
      const address = (res && res.email) || String(email || '').trim().toLowerCase();
      const again = Boolean(el) && sameAddress(sentTo, address);
      sentTo = address;
      if (!again || !el || !el.isConnected) draw(address);
      else el.querySelector('[data-code-sent]').textContent = t('settings.rukoo.code.resent', { email: address });
      showError(note);
      wait(GAP);
      focus();
      return true;
    } catch (ex) {
      if (ex && ex.code === 'rate_limited') {
        const seconds = Number(ex.waitSeconds) || Number(ex.retryAfter) || GAP;
        if (el) wait(seconds);
        showError(waitText(seconds));
      } else showError(codeErrorText(ex) || (ex && ex.message) || '');
      if (btn && !timer) btn.disabled = false;
      return false;
    }
  }

  const resend = () => (sentTo ? send(sentTo) : Promise.resolve(false));

  // The step for an address a code already went to, as the What's new guide draws its page again; no new request.
  function restore(email) {
    sentTo = email;
    draw(email);
    if (until > Date.now()) wait((until - Date.now()) / 1000);
  }

  function reset() {
    clearInterval(timer);
    timer = null;
    if (el) el.remove();
    el = null;
    sentTo = null;
  }

  // One submit of the form. run(emailCode) makes the request with what the code field holds ('' while the step isn't
  // shown) and returns its answer. { done: true, result } once it went through; { done: false } when the form stays,
  // with the step shown or the error line saying what to do. Errors the step has no words for are thrown, for the
  // form to show as before. invited: the form sent an invite code, so code_required means that code didn't work.
  async function submit(email, run, { invited = false } = {}) {
    if (active() && !value()) {
      showError(t('settings.rukoo.code.missing'));
      focus();
      return { done: false };
    }
    const shown = active();
    try {
      return { done: true, result: await run(shown ? value() : '') };
    } catch (ex) {
      const code = ex && ex.code;
      // The server checks addresses: a code first, then the same submit again.
      if (purpose === 'signup' && code === 'code_required') {
        await send(email, { note: invited ? t('settings.rukoo.code.inviteFailed', { email }) : '' });
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
    restore,
    reset
  };
}
