// Settings > Video meetings: Zoom, Microsoft Teams and Jitsi Meet, which give each booking its own meeting link. Main
// keeps the connections (src/main/video/, videoState and the 'video' event); this page turns Jitsi on, signs in to Zoom
// and Teams in the browser, and says plainly when a service has no OAuth client to sign in with. A connected service
// shows up as a meeting type's location on the booking page (booking-settings.js).
import { t, getLocale } from './i18n.js';
import { api, esc, toast, confirmDialog } from './ui.js';

export const VIDEO_VIEWS = ['video'];

// 'Zoom and Jitsi Meet', in the interface language.
export function listText(list) {
  try {
    return new Intl.ListFormat(getLocale(), { type: 'conjunction' }).format(list);
  } catch (_) {
    return list.join(', ');
  }
}

// pages: what settings.js needs. row: its row helper; go and rerender: its navigation; current(): the page on top;
// promptDialog: its text prompt.
export function videoPages({ row, go, rerender, current, promptDialog }) {
  let state = null;
  let failed = null;

  const services = () => (state && Array.isArray(state.services) ? state.services : []);
  const service = (id) => services().find((s) => s.id === id) || null;

  async function prepare(view) {
    if (view !== 'main' && !VIDEO_VIEWS.includes(view)) return;
    try {
      state = await api('videoState');
      failed = null;
    } catch (err) {
      failed = err.message;
    }
  }

  // A sign-in opening or closing, a service connected or lost: the page and the overview's row follow.
  function onState(next) {
    if (!next || typeof next !== 'object') return;
    state = next;
    if (current() === 'video' || current() === 'main') rerender();
  }

  function rowHtml() {
    const on = services().filter((s) => s.status === 'connected').map((s) => s.name);
    return row({ title: esc(t('settings.video.title')), desc: esc(on.length ? t('settings.video.rowConnected', { services: listText(on) }) : t('settings.video.rowNone')), action: 'video-open' });
  }

  // Every row starts with the service's state as a dot, so the names line up; the server row keeps the dot's room.
  const dot = (state) => `<span class="video-dot" data-state="${esc(state)}" aria-hidden="true"></span>`;

  // Jitsi: a switch, and its server while it is on.
  function roomHtml(s) {
    const on = s.status === 'connected';
    const host = String(s.server || '').replace(/^https:\/\//, '');
    return `${row({ title: esc(s.name), desc: esc(t('settings.video.jitsiHelp')), action: `video-room:${s.id}`, toggle: on, lead: dot(s.status) })}
      ${on ? row({ title: esc(t('settings.video.jitsiServer')), value: esc(host), action: `video-server:${s.id}`, lead: dot('spacer') }) : ''}`;
  }

  // Zoom and Teams: what the connection is, and the one or two buttons that change it.
  function accountHtml(s) {
    const id = esc(s.id);
    const pending = state.pending === s.id;
    const who = s.account && (s.account.email || s.account.name);
    const help = { zoom: 'settings.video.zoomHelp', teams: 'settings.video.teamsHelp' }[s.id];
    let desc;
    let buttons;
    if (pending) {
      desc = t('settings.video.pending', { service: s.name });
      buttons = `<button class="btn sm secondary" data-a="video-cancel">${esc(t('common.actions.cancel'))}</button>`;
    } else if (s.status === 'connected') {
      desc = who ? t('settings.video.connectedAs', { account: who }) : t('settings.video.connectedPlain');
      buttons = `<button class="btn sm secondary" data-a="video-disconnect:${id}">${esc(t('settings.video.disconnect'))}</button>`;
    } else if (s.status === 'renew') {
      desc = t('settings.video.renewHelp');
      buttons = `<button class="btn sm secondary" data-a="video-disconnect:${id}">${esc(t('settings.video.disconnect'))}</button><button class="btn sm secondary" data-a="video-connect:${id}">${esc(t('settings.video.renew'))}</button>`;
    } else if (s.status === 'unavailable') {
      desc = t('settings.video.unavailable', { service: s.name });
      buttons = `<button class="btn sm secondary" data-a="video-import:${id}">${esc(t('settings.video.addClient'))}</button>`;
    } else {
      desc = help ? t(help) : '';
      buttons = `<button class="btn sm secondary" data-a="video-connect:${id}">${esc(t('settings.video.connect'))}</button>`;
    }
    const tone = pending ? 'busy' : s.status;
    return `<div class="row static video-service" data-video="${id}">
        ${dot(tone)}
        <div class="text"><div class="title">${esc(s.name)}</div><div class="desc${s.status === 'renew' && !pending ? ' booking-warn' : ''}">${esc(desc)}</div></div>
        <div class="booking-item-actions">${buttons}</div>
      </div>`;
  }

  function view() {
    const title = esc(t('settings.video.title'));
    if (!state) return { title, body: failed ? `<p class="settings-text error">${esc(failed)}</p>` : '' };
    return {
      title,
      body: `<p class="settings-text">${esc(t('settings.video.intro'))}</p>
        <div class="settings-group-title">${esc(t('settings.video.services'))}</div>
        <div class="card video-services">${services()
          .map((s) => (s.kind === 'room' ? roomHtml(s) : accountHtml(s)))
          .join('')}</div>
        <p class="settings-text">${esc(t('settings.video.thisComputer'))}</p>`
    };
  }

  async function run(work, done) {
    try {
      const next = await work();
      if (next && typeof next === 'object' && Array.isArray(next.services)) state = next;
      if (done) toast(done);
    } catch (err) {
      // A sign-in the user cancelled needs no message.
      if (err && err.code !== 'cancelled') toast(err.message, 6000);
    }
    if (current() === 'video' || current() === 'main') await rerender();
  }

  // Handles a data-a action of this page; false when it isn't one.
  async function click(a) {
    if (a === 'video-open') return go('video'), true;
    if (a === 'video-cancel') {
      await api('videoCancel').catch(() => {});
      return true;
    }
    const [name, id] = a.split(':');
    const s = id ? service(id) : null;
    if (!s) return false;
    switch (name) {
      case 'video-room':
        await run(() => api('videoRoom', id, { on: s.status !== 'connected' }));
        return true;
      case 'video-server': {
        const v = await promptDialog(t('settings.video.jitsiServer'), s.customServer ? s.server : '', { placeholder: t('settings.video.jitsiServerHelp') });
        if (v === null) return true;
        await run(() => api('videoRoom', id, { server: v.trim() }), t('settings.video.serverSaved'));
        return true;
      }
      case 'video-connect':
        await run(() => api('videoConnect', id), t('settings.video.connected', { service: s.name }));
        return true;
      case 'video-disconnect': {
        const ok = await confirmDialog(t('settings.video.disconnectTitle', { service: s.name }), t('settings.video.disconnectConfirm', { service: s.name }), t('settings.video.disconnect'), true);
        if (ok) await run(() => api('videoDisconnect', id), t('settings.video.disconnected', { service: s.name }));
        return true;
      }
      case 'video-import': {
        const before = s.status;
        await run(() => api('videoImportClient', id));
        const after = service(id);
        if (after && after.status !== before) toast(t('settings.video.clientAdded'));
        return true;
      }
    }
    return false;
  }

  return { prepare, onState, rowHtml, view, click, state: () => state };
}
