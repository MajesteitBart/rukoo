import { icons } from './icons.js';
import { api, brandLogo, esc, toast, dialog, confirmDialog, choiceDialog, numericDate, hhmm } from './ui.js';

const THEMES = [
  { value: 'system', label: 'Systeeminstelling volgen' },
  { value: 'light', label: 'Licht' },
  { value: 'dark', label: 'Donker' }
];
const DENSITY = [
  { value: 'standard', label: 'Standaard', hint: 'Afzender, onderwerp en voorbeeldtekst' },
  { value: 'compact', label: 'Compact', hint: 'Eén regel per e-mail' }
];
const BADGES = [
  { value: 'new', label: 'Nieuwe e-mails' },
  { value: 'unread', label: 'Ongelezen e-mails' },
  { value: 'none', label: 'Geen' }
];
const INTERVALS = [
  { value: 0, label: 'Handmatig' },
  { value: 1, label: 'Elke minuut' },
  { value: 5, label: 'Elke 5 minuten' },
  { value: 15, label: 'Elke 15 minuten' },
  { value: 30, label: 'Elke 30 minuten' },
  { value: 60, label: 'Elk uur' }
];
const COLORS = [
  { value: '#2fd6c0', label: 'Turquoise' },
  { value: '#4a7dff', label: 'Blauw' },
  { value: '#ff8a3d', label: 'Oranje' },
  { value: '#c56cf0', label: 'Paars' },
  { value: '#f5c542', label: 'Geel' },
  { value: '#ff5d73', label: 'Rood' },
  { value: '#5ec2ff', label: 'Lichtblauw' }
];
const HIDEABLE = [
  ['vip', "VIP's"],
  ['starred', 'Sterren'],
  ['saved', 'Opgeslagen e-mails'],
  ['drafts', 'Concepten'],
  ['sent', 'Verzonden'],
  ['trash', 'Prullenbak'],
  ['junk', 'Spam'],
  ['archive', 'Archief']
];

const labelOf = (list, value) => (list.find((x) => x.value === value) || list[0]).label;

export function promptDialog(title, value = '', { multiline = false, placeholder = '' } = {}) {
  return dialog({
    title,
    buttons: [
      { label: 'Annuleren', value: null },
      { label: 'Opslaan', value: (scrim) => scrim.querySelector('.form-input').value }
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
    const view = stack[stack.length - 1];
    let title = 'E-mailinstellingen';
    let body = '';

    if (view === 'main') {
      const accounts = state.accounts
        .map((a) => {
          const status = a.syncing
            ? 'Synchroniseren...'
            : a.error
              ? `<span class="error">${esc(a.error)}</span>`
              : a.lastSync
                ? `Laatst gesynchroniseerd op ${numericDate(a.lastSync)}  ${hhmm(a.lastSync)}`
                : 'Nog niet gesynchroniseerd';
          return row({
            title: `${esc(a.email)}${a.isDefault ? ' (standaard)' : ''}`,
            desc: status,
            action: `account:${a.id}`,
            cls: 'indent',
            lead: `<div class="avatar small" style="--accent:${a.color}">${esc((a.name || a.email).trim()[0] || '?').toUpperCase()}</div>`
          });
        })
        .join('');
      body = `
        <div class="settings-group-title">Accounts</div>
        <div class="card">${accounts}
          ${row({ title: 'Account toevoegen', action: 'add', cls: 'indent', lead: `<span class="add-ic">${icons.plus}</span>` })}
        </div>
        <div class="settings-group-title">Algemeen</div>
        <div class="card">
          ${row({ title: 'Mappen beheren', desc: 'Geef uw e-mailmappen weer of verberg ze.', action: 'folders' })}
          ${row({ title: 'Lijstweergave', value: labelOf(DENSITY, s.density), action: 'density' })}
          ${row({ title: 'Thema', value: labelOf(THEMES, s.theme), action: 'theme' })}
          ${row({ title: 'E-mails donker weergeven', desc: 'Pas de kleuren van HTML-e-mails aan in de donkere stand.', action: 'toggle:darkEmails', toggle: s.darkEmails })}
          ${row({ title: 'Vegen op aanraakschermen', desc: 'Veeg naar rechts om als (on)gelezen te markeren en naar links om te wissen.', action: 'toggle:swipeActions', toggle: s.swipeActions })}
          ${row({ title: 'Inhoud passend maken', desc: 'Maak e-mailinhoud kleiner zodat deze in het venster past.', action: 'toggle:fitContent', toggle: s.fitContent })}
          ${row({ title: 'Meldingen', desc: 'Toon een Windows-melding bij nieuwe e-mails.', action: 'toggle:notifications', toggle: s.notifications })}
          ${row({ title: 'Tellingen app-pictogrambadge', value: labelOf(BADGES, s.badge), action: 'badge' })}
          ${row({ title: 'Synchronisatieschema', value: labelOf(INTERVALS, Number(s.syncInterval)), action: 'interval' })}
          ${row({ title: 'Handtekening', value: esc(s.signature || 'Geen'), action: 'signature' })}
          ${row({ title: 'Spamadressen', desc: 'Bewerk uw lijst met spamafzenders.', action: 'spam' })}
          ${row({ title: "VIP's", desc: "E-mails van VIP's verschijnen in de map VIP's.", action: 'vips' })}
        </div>
        <div class="settings-group-title">Over</div>
        <div class="card">${row({ title: 'Over Rukoo Mail', desc: 'Versie en opslaglocatie', action: 'about' })}</div>`;
    }

    if (view === 'account') {
      const a = state.accounts.find((x) => x.id === params.id);
      if (!a) return back();
      title = a.email;
      body = `
        <div class="settings-group-title">Account</div>
        <div class="card">
          ${row({ title: 'Weergavenaam', value: esc(a.name || ''), action: 'acc-name' })}
          ${row({ title: 'Handtekening', value: esc(a.signature ?? `Algemeen: ${s.signature || 'geen'}`), action: 'acc-signature' })}
          ${row({ title: 'Accountkleur', value: labelOf(COLORS, a.color), action: 'acc-color' })}
          ${row({ title: 'Standaard afzender', value: esc(a.defaultFrom), action: 'acc-from' })}
          ${row({ title: 'Afzenderadressen', desc: a.identities.length > 1 ? `${a.identities.length - 1} ${a.identities.length === 2 ? 'alias' : 'aliassen'}` : 'Alleen het accountadres', action: 'acc-aliases' })}
          ${a.isDefault ? '' : row({ title: 'Instellen als standaardaccount', desc: 'Nieuwe e-mails worden vanaf dit account verzonden.', action: 'acc-default' })}
          ${row({ title: 'Nu synchroniseren', desc: a.lastSync ? `Laatst gesynchroniseerd op ${numericDate(a.lastSync)}  ${hhmm(a.lastSync)}` : '', action: 'acc-sync' })}
          ${a.provider === 'google' && s && state.googleAvailable ? row({ title: a.auth === 'oauth2' ? 'Opnieuw aanmelden bij Google' : 'Overschakelen naar Google-aanmelding', desc: a.auth === 'oauth2' ? 'Gebruik dit als Google de toegang heeft ingetrokken.' : 'Meld je aan via je browser in plaats van met een app-wachtwoord.', action: 'acc-google' }) : ''}
          ${a.type === 'imap' ? row({ title: 'Serverinstellingen', desc: `${esc(a.imap.host)} / ${esc(a.smtp.host)}`, action: 'acc-server' }) : ''}
        </div>
        <div class="settings-group-title"></div>
        <div class="card">${row({ title: 'Account verwijderen', action: 'acc-remove', cls: 'danger' })}</div>`;
    }

    if (view === 'server') {
      const a = state.accounts.find((x) => x.id === params.id);
      if (!a) return back();
      title = 'Serverinstellingen';
      body = `<div class="card"><form class="form" data-form="server">
        <label>Gebruikersnaam<input type="text" name="user" value="${esc(a.imap.user || a.email)}"/></label>
        ${a.auth === 'oauth2' ? '' : `<label>Wachtwoord<input type="password" name="password" placeholder="Laat leeg om het huidige wachtwoord te houden"/></label>`}
        <div class="two"><label>IMAP-server<input type="text" name="imapHost" value="${esc(a.imap.host)}"/></label>
          <label>Poort<input type="number" name="imapPort" value="${a.imap.port}"/></label>
          <label class="inline"><input type="checkbox" name="imapSecure" ${a.imap.secure ? 'checked' : ''}/> SSL/TLS</label></div>
        <div class="two"><label>SMTP-server<input type="text" name="smtpHost" value="${esc(a.smtp.host)}"/></label>
          <label>Poort<input type="number" name="smtpPort" value="${a.smtp.port}"/></label>
          <label class="inline"><input type="checkbox" name="smtpSecure" ${a.smtp.secure ? 'checked' : ''}/> SSL/TLS</label></div>
        <div class="error" data-error></div>
        <div><button class="btn" type="submit">Opslaan</button></div>
      </form></div>`;
    }

    if (view === 'aliases') {
      const a = state.accounts.find((x) => x.id === params.id);
      if (!a) return back();
      title = 'Afzenderadressen';
      body = `
        <div class="settings-group-title">Verzenden als</div>
        <div class="card">
          ${a.identities
            .map((i) =>
              row({
                title: `${esc(i.address)}${i.address === a.defaultFrom ? ' (standaard)' : ''}`,
                desc: i.primary ? 'Accountadres' : 'Klik om als standaard in te stellen of te verwijderen',
                action: i.primary ? `alias-default:${encodeURIComponent(i.address)}` : `alias:${encodeURIComponent(i.address)}`
              })
            )
            .join('')}
          ${row({ title: 'Alias toevoegen', action: 'alias-add', lead: `<span class="add-ic">${icons.plus}</span>`, cls: 'indent' })}
          ${a.auth === 'oauth2' ? row({ title: 'Ophalen uit Gmail', desc: 'Neemt de geverifieerde adressen over uit "Verzenden als" in Gmail.', action: 'alias-gmail' }) : ''}
        </div>
        <p class="empty" style="padding:24px 40px;text-align:left">De server moet verzenden als dit adres toestaan. In Gmail staat dat onder Instellingen &gt; Accounts &gt; Verzenden als.</p>`;
    }

    if (view === 'folders') {
      title = 'Mappen beheren';
      const hidden = new Set(s.hiddenViews || []);
      const folderRows = state.accounts.flatMap((a) =>
        a.folders.filter((f) => !f.role).map((f) => [`folder:${f.path}`, `${f.name} (${a.email})`])
      );
      body = `<div class="settings-group-title">Weergeven in het menu</div><div class="card">${[...HIDEABLE, ...folderRows]
        .map(([id, label]) => row({ title: esc(label), action: `hide:${id}`, toggle: !hidden.has(id) }))
        .join('')}</div>`;
    }

    if (view === 'spam' || view === 'vips') {
      const key = view === 'spam' ? 'spam' : 'vips';
      title = view === 'spam' ? 'Spamadressen' : "VIP's";
      const list = s[key] || [];
      body = `<div class="card">
        ${row({ title: 'Toevoegen', action: `list-add:${key}`, lead: `<span class="add-ic">${icons.plus}</span>`, cls: 'indent' })}
        ${list.map((addr) => row({ title: esc(addr), desc: 'Klik om te verwijderen', action: `list-remove:${key}:${encodeURIComponent(addr)}` })).join('')}
      </div>
      ${list.length ? '' : `<p class="empty">${view === 'spam' ? 'Geen spamadressen' : "Nog geen VIP's. Voeg een afzender toe via Meer in een e-mail."}</p>`}`;
    }

    page.innerHTML = `
      <div class="page-bar"><button class="icon-btn" data-a="back" title="Terug">${icons.back}</button><h1>${title}</h1></div>
      <div class="page-scroll"><div class="page-inner">${body}</div></div>`;
  }

  page.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const f = new FormData(form);
    const err = form.querySelector('[data-error]');
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>Controleren...';
    err.textContent = '';
    try {
      await api('updateAccount', params.id, {
        imap: { host: f.get('imapHost').trim(), port: Number(f.get('imapPort')), secure: f.get('imapSecure') === 'on', user: f.get('user').trim() },
        smtp: { host: f.get('smtpHost').trim(), port: Number(f.get('smtpPort')), secure: f.get('smtpSecure') === 'on', user: f.get('user').trim() },
        password: f.get('password') || undefined
      });
      toast('Serverinstellingen opgeslagen');
      back();
    } catch (ex) {
      err.textContent = ex.message;
      btn.disabled = false;
      btn.textContent = 'Opslaan';
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
            { label: 'Verwijderen', value: 'remove', danger: true },
            { label: 'Annuleren', value: null },
            { label: 'Standaard maken', value: 'default' }
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
      const v = await promptDialog(key === 'spam' ? 'Spamadres toevoegen' : 'VIP toevoegen', '', { placeholder: 'naam@voorbeeld.nl' });
      const addr = String(v || '').trim().toLowerCase();
      if (!addr) return;
      if (!/^[^@\s]+@[^@\s]+$/.test(addr)) return toast('Ongeldig e-mailadres');
      return set({ [key]: [...new Set([...(s[key] || []), addr])] });
    }
    if (a.startsWith('list-remove:')) {
      const [, key, enc] = a.split(':');
      const addr = decodeURIComponent(enc);
      return set({ [key]: (s[key] || []).filter((x) => x !== addr) });
    }
    switch (a) {
      case 'folders':
      case 'spam':
      case 'vips':
        return go(a);
      case 'density': {
        const v = await choiceDialog('Lijstweergave', DENSITY, s.density);
        if (v) set({ density: v });
        return;
      }
      case 'theme': {
        const v = await choiceDialog('Thema', THEMES, s.theme);
        if (v) set({ theme: v });
        return;
      }
      case 'badge': {
        const v = await choiceDialog('Tellingen app-pictogrambadge', BADGES, s.badge);
        if (v) set({ badge: v });
        return;
      }
      case 'interval': {
        const v = await choiceDialog('Synchronisatieschema', INTERVALS, Number(s.syncInterval));
        if (v !== null && v !== undefined) set({ syncInterval: v });
        return;
      }
      case 'signature': {
        const v = await promptDialog('Handtekening', s.signature || '', { multiline: true });
        if (v !== null) set({ signature: v });
        return;
      }
      case 'about': {
        const info = await api('appInfo');
        return dialog({
          body: `${brandLogo('about-logo')}<p>Versie ${esc(info.version)}</p><p>Een e-mailprogramma voor Windows, gebouwd met Electron. Gegevens staan in:<br><code style="user-select:text">${esc(info.dataDir)}</code></p>`
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
        const v = await promptDialog('Weergavenaam', acc.name || '');
        if (v !== null) update({ name: v.trim() });
        return;
      }
      case 'acc-signature': {
        const v = await dialog({
          title: 'Handtekening',
          buttons: [
            { label: 'Algemene gebruiken', value: { reset: true } },
            { label: 'Annuleren', value: null },
            { label: 'Opslaan', value: (scrim) => ({ text: scrim.querySelector('textarea').value }) }
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
        const v = await choiceDialog('Accountkleur', COLORS, acc.color);
        if (v) update({ color: v });
        return;
      }
      case 'acc-default':
        return update({ makeDefault: true });
      case 'acc-sync':
        toast('Synchroniseren...');
        try {
          await api('sync', acc.id);
          toast('Gesynchroniseerd');
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
          'Standaard afzender',
          acc.identities.map((i) => ({ value: i.address, label: i.address })),
          acc.defaultFrom
        );
        if (v) update({ defaultFrom: v });
        return;
      }
      case 'alias-add': {
        const v = await promptDialog('Alias toevoegen', '', { placeholder: 'naam@voorbeeld.nl' });
        if (!v || !v.trim()) return;
        const aliases = acc.identities.filter((i) => !i.primary).map((i) => ({ address: i.address, name: i.name }));
        update({ aliases: [...aliases, { address: v.trim(), name: acc.name }] });
        return;
      }
      case 'alias-gmail':
        try {
          const updated = await api('fetchGmailAliases', acc.id);
          toast(`${updated.identities.length - 1} aliassen opgehaald uit Gmail`);
        } catch (err) {
          toast(err.message, 6000);
        }
        return render();
      case 'acc-google':
        toast('Meld je aan in je browser...', 60000);
        try {
          await api('googleReauth', acc.id);
          toast('Aangemeld bij Google');
        } catch (err) {
          toast(err.message, 6000);
        }
        return render();
      case 'acc-remove': {
        const ok = await confirmDialog('Account verwijderen?', `${acc.email} en alle lokaal opgeslagen e-mails van dit account worden van deze pc verwijderd. Op de server blijft alles bewaard.`, 'Verwijderen', true);
        if (!ok) return;
        await api('removeAccount', acc.id);
        toast('Account verwijderd');
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
