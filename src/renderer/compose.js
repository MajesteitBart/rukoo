// The compose window: the editor from composer.js on its own, for mailto links and for messages
// popped out of the main window. It talks to the main process directly.
import { api, esc, toast, applyTheme, onSystemThemeChange } from './ui.js';
import { mountComposer } from './composer.js';

async function init() {
  const host = document.getElementById('app');
  const [data, opts] = await Promise.all([api('state'), api('composeInit')]);
  applyTheme(data.settings.theme);
  if (!opts || !data.accounts.length) return api('composeClose');
  let message = null;
  if (opts.id) {
    try {
      message = await api('get', opts.id);
    } catch (err) {
      host.innerHTML = `<div class="compose-error"><p class="error">${esc(err.message)}</p><button class="btn secondary">Sluiten</button></div>`;
      host.querySelector('button').addEventListener('click', () => api('composeClose'));
      return;
    }
  }
  const editor = mountComposer(host, {
    data,
    opts,
    message,
    inline: false,
    onTitle: (text) => {
      document.title = text;
      document.getElementById('compose-title').textContent = text;
    }
  });
  const retheme = async () => {
    const next = await api('state');
    applyTheme(next.settings.theme);
    editor.retheme(next);
  };
  window.mail.on(({ type }) => type === 'theme' && retheme());
  onSystemThemeChange(retheme);
}

init().catch((err) => toast(err.message, 6000));
