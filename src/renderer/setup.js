import { icons, providerLogos } from './icons.js';
import { api, esc, $, toast } from './ui.js';

const ORDER = ['google', 'yahoo', 'outlook', 'exchange', 'office365', 'other'];

export function openSetup(ctx, { first = false } = {}) {
  document.querySelector('.page.setup')?.remove();
  const page = document.createElement('div');
  page.className = 'page setup';
  document.getElementById('overlays').appendChild(page);
  const providers = ctx.S.data.providers;

  const close = () => {
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
      ${first ? '' : `<button class="icon-btn setup-back" data-s="close" title="Terug">${icons.back}</button>`}
      <div class="setup-inner">
        <h1>E-mail instellen</h1>
        <div class="provider-grid">
          ${ORDER.map((id) => {
            const p = providers.find((x) => x.id === id);
            return `<button class="provider" data-provider="${id}"><span class="logo">${providerLogos[id]}</span><span>${esc(p.label)}</span></button>`;
          }).join('')}
        </div>
        <button class="setup-demo" data-s="demo">Probeer het eerst met een demo-account</button>
      </div>`;
  }

  function showLogin(id) {
    const p = providers.find((x) => x.id === id);
    const manual = p.manual;
    page.innerHTML = `
      <button class="icon-btn setup-back" data-s="grid" title="Terug">${icons.back}</button>
      <div class="setup-inner login">
        <div class="login-head"><span class="logo">${providerLogos[id]}</span><h2>Aanmelden bij ${esc(p.label)}</h2></div>
        <form class="form" autocomplete="off">
          <label>E-mailadres<input type="email" name="email" required placeholder="naam@voorbeeld.nl" spellcheck="false"/></label>
          <label>Wachtwoord<span class="pw"><input type="password" name="password" required placeholder="Wachtwoord of app-wachtwoord"/>
            <button type="button" class="icon-btn" data-s="pw" title="Wachtwoord weergeven">${icons.eye}</button></span></label>
          <div class="note">${esc(p.note)}</div>
          <div class="manual" ${manual ? '' : 'hidden'}>
            <div class="form" style="padding:0">
              <label>Gebruikersnaam<input type="text" name="user" placeholder="Meestal je e-mailadres" spellcheck="false"/></label>
              <div class="two"><label>IMAP-server<input type="text" name="imapHost" value="${esc(p.imap.host)}"/></label>
                <label>Poort<input type="number" name="imapPort" value="${p.imap.port}"/></label>
                <label class="inline"><input type="checkbox" name="imapSecure" ${p.imap.secure ? 'checked' : ''}/> SSL/TLS</label></div>
              <div class="two"><label>SMTP-server<input type="text" name="smtpHost" value="${esc(p.smtp.host)}"/></label>
                <label>Poort<input type="number" name="smtpPort" value="${p.smtp.port}"/></label>
                <label class="inline"><input type="checkbox" name="smtpSecure" ${p.smtp.secure ? 'checked' : ''}/> SSL/TLS</label></div>
            </div>
          </div>
          <div class="error" data-error></div>
          <div class="actions">
            <button type="button" class="link-btn" data-s="manual" ${manual ? 'hidden' : ''}>Handmatig instellen</button>
            <span></span>
            <button class="btn" type="submit">Aanmelden</button>
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
    btn.innerHTML = '<span class="spinner"></span>Aanmelden...';
    err.textContent = '';
    try {
      const acc = await api('addAccount', input);
      done(acc);
    } catch (ex) {
      err.textContent = ex.message;
      btn.disabled = false;
      btn.textContent = 'Aanmelden';
      // A failed automatic setup is usually a server issue; show the manual fields.
      if (!manualShown && /IMAP|SMTP|server|Verbinding|time-out/i.test(ex.message)) {
        form.querySelector('.manual').hidden = false;
        form.querySelector('[data-s="manual"]').hidden = true;
      }
    }
  });

  async function done(acc) {
    close();
    toast(`${acc.email} is toegevoegd`);
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
        return showGrid();
      case 'manual':
        b.hidden = true;
        page.querySelector('.manual').hidden = false;
        return;
      case 'pw': {
        const input = b.previousElementSibling;
        input.type = input.type === 'password' ? 'text' : 'password';
        b.innerHTML = input.type === 'password' ? icons.eye : icons.eyeOff;
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
