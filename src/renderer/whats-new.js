// "What's new in Rukoo 2.0": one guided window that explains inbox categories, then sets them up in order: the
// categories, an account to sync them, Jev if wanted, and only then the first sort. Everyone sees it once on the
// first start of 2.0 (main's whatsNewState); Settings > What's new opens it again.
import { t } from './i18n.js';
import { icons } from './icons.js';
import { api, esc, toast } from './ui.js';

const STEPS = ['welcome', 'categories', 'account', 'jev', 'done'];
const MIN_PASSWORD = 12;

let open = null;

// Opens the guide; resolves to true after "Sort my inbox" (or "Done"), else null.
export async function openWhatsNew() {
  if (open) return open;
  open = run().finally(() => (open = null));
  return open;
}

async function run() {
  api('whatsNewDone').catch(() => {});
  const [cats, preview, status, info] = await Promise.all([
    api('categoriesState').catch(() => null),
    api('categoriesPreview').catch(() => []),
    api('accountStatus').catch(() => null),
    api('accountServerInfo').catch(() => null)
  ]);
  const already = Boolean(cats && cats.enabled);
  const st = {
    step: 0,
    // Someone with categories already keeps them as they are; the guide only removes presets nobody used yet.
    fixed: Boolean(cats && cats.categories.length),
    cats: (preview || []).map((c) => ({ ...c, keep: true })),
    unsure: (cats && cats.unsure) || 'to-read',
    signedIn: Boolean(status && status.signedIn),
    email: (status && status.email) || '',
    server: (status && status.server) || '',
    info,
    choice: 'create',
    recoveryKey: null,
    keySaved: false,
    jev: cats && cats.jev.on ? 'use' : 'rules',
    hasKey: Boolean(cats && cats.jev.hasKey),
    jevKey: ''
  };

  return new Promise((resolve) => {
    const before = document.activeElement;
    const scrim = document.createElement('div');
    scrim.className = 'scrim';
    scrim.innerHTML = `<div class="wn" role="dialog" aria-modal="true" aria-labelledby="wn-title">
      <button class="icon-btn wn-close" data-wn="close" title="${esc(t('common.actions.close'))}">${icons.close}</button>
      <div class="wn-body"></div>
      <footer class="wn-foot"></footer>
    </div>`;
    document.body.appendChild(scrim);
    const $ = (sel) => scrim.querySelector(sel);
    let view = null;

    const close = (value = null) => {
      scrim.remove();
      document.removeEventListener('keydown', onKey, true);
      if (before && document.contains(before)) before.focus();
      resolve(value);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
      }
    };
    document.addEventListener('keydown', onKey, true);

    const kept = () => st.cats.filter((c) => c.keep);
    const nameOf = (id) => (st.cats.find((c) => c.id === id) || {}).name || '';
    const host = () => {
      try {
        return new URL(st.server).host;
      } catch (_) {
        return st.server;
      }
    };
    const where = () => {
      const j = st.info && st.info.hosting && st.info.hosting.jurisdiction;
      return t(`settings.rukoo.where.${['eu', 'us', 'fedramp'].includes(j) ? j : 'any'}`);
    };
    const radio = (group, id, on, title, hint, extra = '') => `
      <div class="wn-choice ${on ? 'on' : ''}">
        <button type="button" class="radio-row" role="radio" aria-checked="${on}" data-${group}="${id}"><span class="radio ${on ? 'on' : ''}"></span><span class="rt"><span class="rl">${esc(title)}</span><span class="rh">${esc(hint)}</span></span></button>
        ${on ? extra : ''}
      </div>`;

    // ---- the steps ----

    const steps = {
      welcome: () => {
        const mock = st.cats.slice(0, 5);
        return {
          title: t('whatsNew.welcome.title'),
          lead: t('whatsNew.welcome.lead'),
          html: `
            <div class="wn-hero" aria-hidden="true">
              <div class="wn-mock-side">
                <div class="wn-mock-nav on">${icons.inbox}<span>${esc(t('mailbox.folders.inbox'))}</span></div>
                ${mock.map((c, i) => `<div class="wn-mock-nav sub ${i === 0 ? 'cur' : ''}"><i style="--cat:${esc(c.color)}"></i><span>${esc(c.name)}</span></div>`).join('')}
              </div>
              <div class="wn-mock-list">
                ${[0, 1, 2].map((i) => `<div class="wn-mock-row"><b></b><span style="width:${[62, 48, 55][i]}%"></span><span style="width:${[88, 72, 80][i]}%"></span></div>`).join('')}
              </div>
            </div>
            <div class="wn-features">
              ${[
                ['tabs', 'categories'],
                ['devices', 'sync'],
                ['sparkle', 'jev']
              ]
                .map(([ic, k]) => `<div class="wn-feature"><span class="wn-ic">${icons[ic]}</span><div><b>${esc(t(`whatsNew.welcome.${k}Title`))}</b><p>${esc(t(`whatsNew.welcome.${k}Text`))}</p></div></div>`)
                .join('')}
            </div>`,
          back: { label: t('whatsNew.notNow'), action: () => close() },
          next: { label: t('whatsNew.start'), action: () => go(1) }
        };
      },

      categories: () => {
        const rows = st.cats
          .map(
            (c) => `<button type="button" class="row wn-cat" data-cat="${esc(c.id)}" ${st.fixed ? 'disabled' : ''}>
              <span class="wn-dot" style="--cat:${esc(c.color)}"></span>
              <span class="text"><span class="title">${esc(c.name)}</span><span class="desc">${esc(c.description || '')}</span></span>
              ${st.fixed ? '' : `<span class="switch ${c.keep ? 'on' : ''}" role="switch" aria-checked="${c.keep}"></span>`}
            </button>`
          )
          .join('');
        const options = kept()
          .map((c) => `<option value="${esc(c.id)}" ${c.id === st.unsure ? 'selected' : ''}>${esc(c.name)}</option>`)
          .join('');
        return {
          title: t('whatsNew.categories.title'),
          lead: st.fixed ? t('whatsNew.categories.leadExisting') : t('whatsNew.categories.lead'),
          html: `<div class="card">${rows}</div>
            <div class="card wn-gap"><label class="row static"><span class="text"><span class="title">${esc(t('settings.categories.unsure'))}</span><span class="desc">${esc(t('whatsNew.categories.unsureHelp'))}</span></span><select class="wn-select" data-unsure>${options}</select></label></div>`,
          back: { label: t('common.actions.back'), action: () => go(0) },
          next: { label: t('whatsNew.next'), action: () => (kept().length ? go(2) : toast(t('whatsNew.categories.keepOne'))) }
        };
      },

      account: () => {
        if (st.recoveryKey) return recovery();
        const fields =
          st.choice === 'create'
            ? `<div class="wn-fields">
                <input class="wn-input wide" name="email" type="email" placeholder="${esc(t('whatsNew.account.email'))}" autocomplete="email" value="${esc(st.email)}">
                <input class="wn-input" name="password" type="password" placeholder="${esc(t('whatsNew.account.password'))}" autocomplete="new-password">
                <input class="wn-input" name="invite" type="text" placeholder="${esc(t('settings.rukoo.invite'))}" autocomplete="off" spellcheck="false">
                <label class="wn-tick wide"><input type="checkbox" name="understand"><span>${esc(t('settings.rukoo.understand'))}</span></label>
              </div>`
            : `<div class="wn-fields">
                <input class="wn-input wide" name="email" type="email" placeholder="${esc(t('whatsNew.account.email'))}" autocomplete="email" value="${esc(st.email)}">
                <input class="wn-input wide" name="password" type="password" placeholder="${esc(t('whatsNew.account.passwordSignIn'))}" autocomplete="current-password">
              </div>`;
        const operator = (st.info && st.info.operator && st.info.operator.name) || '';
        const body = st.signedIn
          ? `<div class="card"><div class="row static"><span class="wn-ok">${icons.check}</span><span class="text"><span class="title">${esc(t('settings.rukoo.rowSignedIn', { email: st.email }))}</span><span class="desc">${esc(t('whatsNew.account.signedInHelp'))}</span></span></div></div>`
          : `<form class="choices stacked wn-choices" role="radiogroup" data-wn-form>
              ${radio('choice', 'create', st.choice === 'create', t('whatsNew.account.create'), t('whatsNew.account.createHint'), fields)}
              ${radio('choice', 'signin', st.choice === 'signin', t('whatsNew.account.signIn'), t('whatsNew.account.signInHint'), fields)}
              ${radio('choice', 'local', st.choice === 'local', t('whatsNew.account.local'), t('whatsNew.account.localHint'))}
            </form>
            <div class="wn-error" data-wn-error></div>`;
        return {
          title: t('whatsNew.account.title'),
          lead: t('whatsNew.account.lead'),
          html: `<p class="wn-note">${icons.lock}<span><b>${esc(t('whatsNew.account.e2e'))}</b> ${esc(t('whatsNew.account.e2eText'))}<br><span class="wn-server">${esc(
            [host(), operator && t('settings.rukoo.serverRunBy', { operator }), where()].filter(Boolean).join(' · ')
          )}</span></span></p>${body}`,
          back: { label: t('common.actions.back'), action: () => go(1) },
          next: {
            label: st.signedIn || st.choice === 'local' ? t('whatsNew.next') : st.choice === 'create' ? t('settings.rukoo.create') : t('settings.rukoo.signIn'),
            action: submitAccount
          }
        };
      },

      jev: () => {
        const keyField = `<div class="wn-fields"><input class="wn-input wide" name="jevKey" type="password" autocomplete="off" placeholder="${esc(
          st.hasKey ? t('whatsNew.jev.keySaved') : t('settings.categories.key')
        )}" value="${esc(st.jevKey)}"></div>`;
        return {
          title: t('whatsNew.jev.title'),
          lead: t('whatsNew.jev.lead'),
          html: `<div class="choices stacked wn-choices" role="radiogroup">
              ${radio('jev', 'rules', st.jev === 'rules', t('whatsNew.jev.rules'), t('whatsNew.jev.rulesHint', { name: nameOf(st.unsure) }))}
              ${radio('jev', 'use', st.jev === 'use', t('whatsNew.jev.use'), t('whatsNew.jev.useHint'), keyField)}
            </div>
            <p class="wn-note muted">${icons.info}<span>${esc(t('settings.categories.jevShares'))}</span></p>`,
          back: { label: t('common.actions.back'), action: () => go(2) },
          next: { label: t('whatsNew.next'), action: () => (st.jev === 'use' && !st.jevKey.trim() && !st.hasKey ? toast(t('whatsNew.jev.needKey')) : go(4)) }
        };
      },

      done: () => {
        const names = kept().map((c) => c.name);
        const lines = [
          ['tabs', t('whatsNew.done.categories', { count: names.length }), names.join(', ')],
          ['devices', st.signedIn ? t('whatsNew.done.synced', { email: st.email }) : t('whatsNew.done.local'), st.signedIn ? t('whatsNew.done.syncedHelp') : t('whatsNew.done.localHelp')],
          ['sparkle', st.jev === 'use' ? t('whatsNew.done.jev') : t('whatsNew.done.rules'), st.jev === 'use' ? t('whatsNew.done.jevHelp') : t('whatsNew.jev.rulesHint', { name: nameOf(st.unsure) })]
        ];
        return {
          title: t('whatsNew.done.title'),
          lead: already ? t('whatsNew.done.leadExisting') : t('whatsNew.done.lead'),
          html: `<div class="card">${lines
            .map(([ic, title, desc]) => `<div class="row static"><span class="wn-ic">${icons[ic]}</span><span class="text"><span class="title">${esc(title)}</span><span class="desc">${esc(desc)}</span></span></div>`)
            .join('')}</div>`,
          back: { label: t('common.actions.back'), action: () => go(3) },
          next: { label: already ? t('whatsNew.done.close') : t('whatsNew.done.sort'), action: finish }
        };
      }
    };

    function recovery() {
      return {
        title: t('settings.rukoo.keyTitle'),
        lead: t('settings.rukoo.keyHelp'),
        html: `<div class="wn-key" data-recovery-key>${esc(st.recoveryKey)}</div>
          <div class="wn-key-row"><button type="button" class="btn sm secondary" data-wn="copy">${esc(t('settings.rukoo.copy'))}</button>
          <label class="wn-tick"><input type="checkbox" data-key-saved ${st.keySaved ? 'checked' : ''}><span>${esc(t('settings.rukoo.keySaved'))}</span></label></div>`,
        back: null,
        next: { label: t('whatsNew.next'), action: () => (st.keySaved ? go(3) : toast(t('whatsNew.account.saveKey'))) }
      };
    }

    // ---- actions ----

    // Signing in can bring the account's own categories along: those stay as they are, with the guide's choices
    // made before sign-in set aside, so nothing the other devices have is deleted.
    async function reconcile() {
      if (st.fixed) return;
      const now = await api('categoriesState').catch(() => null);
      if (!now || !now.categories.length) return;
      st.fixed = true;
      st.cats = now.categories.map((c) => ({ ...c, keep: true }));
      if (!now.categories.some((c) => c.id === st.unsure)) st.unsure = now.unsure;
    }

    async function submitAccount() {
      if (st.signedIn || st.choice === 'local') return go(3);
      const err = $('[data-wn-error]');
      const f = new FormData($('[data-wn-form]'));
      const email = String(f.get('email') || '').trim();
      const password = String(f.get('password') || '');
      err.textContent = '';
      if (!email) return (err.textContent = t('account.errors.invalid_email'));
      if (st.choice === 'create') {
        if ([...password].length < MIN_PASSWORD) return (err.textContent = t('account.errors.weak_password'));
        if (f.get('understand') !== 'on') return (err.textContent = t('settings.rukoo.needUnderstand'));
      }
      const btn = $('.wn-foot [data-wn="next"]');
      btn.disabled = true;
      btn.innerHTML = `<span class="spinner"></span>${esc(t('settings.rukoo.working'))}`;
      try {
        if (st.choice === 'create') {
          const res = await api('accountSignUp', { email, password, invite: String(f.get('invite') || '') });
          st.recoveryKey = res.recoveryKey;
        } else {
          await api('accountSignIn', { email, password });
          // The account's records first, so the steps that follow know its categories.
          await api('accountSync').catch(() => {});
          await reconcile();
        }
        st.signedIn = true;
        st.email = email;
        return st.recoveryKey ? render() : go(3);
      } catch (ex) {
        err.textContent = ex.message;
        btn.disabled = false;
        btn.textContent = view.next.label;
      }
    }

    async function finish() {
      const btn = $('.wn-foot [data-wn="next"]');
      btn.disabled = true;
      try {
        // A sync that came in since may have brought the account's categories too.
        if (st.signedIn) await reconcile();
        // The presets are written first, then trimmed to the choice; the first sort runs only once it's all set.
        if (!st.fixed) {
          await api('categoriesSeed');
          for (const c of st.cats.filter((x) => !x.keep)) await api('categoriesRemove', c.id);
        }
        await api('categoriesSetUnsure', st.unsure);
        if (st.jev === 'use') await api('categoriesSetJev', st.jevKey.trim() ? { key: st.jevKey.trim(), on: true } : { on: true });
        else if (cats && cats.jev.on) await api('categoriesSetJev', { on: false });
        if (!already) await api('categoriesSetEnabled', true);
        close(true);
      } catch (ex) {
        toast(ex.message, 6000);
        btn.disabled = false;
      }
    }

    // ---- drawing ----

    function go(i) {
      st.step = i;
      if (i !== 2) st.recoveryKey = null;
      render();
    }

    function render() {
      view = steps[STEPS[st.step]]();
      $('.wn-body').innerHTML = `<h2 id="wn-title">${esc(view.title)}</h2><p class="wn-lead">${esc(view.lead)}</p>${view.html}`;
      const dots = STEPS.map((s, i) => `<span class="${i === st.step ? 'on' : i < st.step ? 'past' : ''}"></span>`).join('');
      $('.wn-foot').innerHTML = `${view.back ? `<button class="btn ghost" data-wn="back">${esc(view.back.label)}</button>` : '<span></span>'}
        <span class="wn-dots" role="img" aria-label="${esc(t('whatsNew.step', { step: st.step + 1, count: STEPS.length }))}">${dots}</span>
        <button class="btn primary" data-wn="next">${esc(view.next.label)}</button>`;
      $('.wn-body').scrollTop = 0;
      const first = $('.wn-body .wn-choice.on input, .wn-body input[name="jevKey"]');
      (first || $('.wn-foot [data-wn="next"]')).focus();
    }

    scrim.addEventListener('mousedown', (e) => {
      if (e.target === scrim) close();
    });
    scrim.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.wn === 'close') return close();
      if (b.dataset.wn === 'back') return view.back.action();
      if (b.dataset.wn === 'next') return view.next.action();
      if (b.dataset.wn === 'copy') return navigator.clipboard.writeText(st.recoveryKey).then(() => toast(t('settings.rukoo.copied')), () => {});
      if (b.dataset.cat && !st.fixed) {
        const c = st.cats.find((x) => x.id === b.dataset.cat);
        c.keep = !c.keep;
        if (!kept().some((x) => x.id === st.unsure) && kept().length) st.unsure = kept()[0].id;
        return render();
      }
      if (b.dataset.choice) {
        st.choice = b.dataset.choice;
        return render();
      }
      if (b.dataset.jev) {
        st.jev = b.dataset.jev;
        return render();
      }
    });
    scrim.addEventListener('change', (e) => {
      if (e.target.dataset.unsure !== undefined) st.unsure = e.target.value;
      if (e.target.dataset.keySaved !== undefined) st.keySaved = e.target.checked;
    });
    scrim.addEventListener('input', (e) => {
      if (e.target.name === 'jevKey') st.jevKey = e.target.value;
      if (e.target.name === 'email') st.email = e.target.value;
    });
    scrim.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.matches('input.wn-input')) {
        e.preventDefault();
        view.next.action();
      }
    });

    // For the design captures: show the recovery key without making an account.
    window.__whatsNewDemoKey = (key) => {
      st.step = 2;
      st.recoveryKey = key;
      st.signedIn = true;
      render();
    };
    render();
  });
}
