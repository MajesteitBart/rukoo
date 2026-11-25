// Settings > Meetings: whether Rukoo Voice is connected, hiding Rukoo from screen recordings during a meeting
// (meetingHideWindow) and whether agents can read meetings (meetingAgentsCanRead). Both settings live in main's
// settings and default to on; main hides the windows (main.js protectWindows) and the meeting tools ask it. A line
// under them says that main holds back mail and booking notifications while a meeting records the screen. Your other
// computers shares Rukoo Voice's bucket through the Rukoo account (main's voice/share.js).
import { t } from './i18n.js';
import { api, esc } from './ui.js';

export const MEETING_VIEWS = ['meetings'];

// What the overview row and the page say about Rukoo Voice (voiceState in main.js).
function statusOf(v) {
  if (!v || v.status === 'absent') return { tone: 'off', text: t('settings.meetings.statusAbsent'), help: t('settings.meetings.statusAbsentHelp') };
  if (v.status === 'connected') {
    const text = v.voiceVersion ? t('settings.meetings.statusConnectedVersion', { version: v.voiceVersion }) : t('settings.meetings.statusConnected');
    return { tone: 'ok', text, help: v.recording ? t('settings.meetings.statusRecording') : t('settings.meetings.statusConnectedHelp') };
  }
  if (v.status === 'connecting') return { tone: 'busy', text: t('settings.meetings.statusConnecting'), help: t('settings.meetings.statusConnectingHelp') };
  if (v.status === 'incompatible') return { tone: 'error', text: t('settings.meetings.statusIncompatible'), help: v.older === 'rukoo' ? t('meeting.voice.updateRukoo') : t('meeting.voice.updateVoice') };
  return { tone: 'error', text: t('settings.meetings.statusInsecure'), help: t('meeting.voice.insecure') };
}

// Where hiding works, and what it can't do there.
function hideHelp(platform) {
  if (platform === 'win32') return t('settings.meetings.hideHelpWindows');
  if (platform === 'darwin') return t('settings.meetings.hideHelpMac');
  return t('settings.meetings.hideHelpLinux');
}

// Why using or sharing the other computer's bucket didn't work (voice/share.js error: Voice's code and reason).
function shareError(e) {
  if (!e) return '';
  if (e.reason === 'screen') return t('settings.meetings.others.errorScreen');
  if (e.reason === 'applying') return t('settings.meetings.others.errorApplying');
  if (e.reason === 'key_in_use') return t('settings.meetings.others.errorKeyInUse');
  if (e.reason === 'test') return t('settings.meetings.others.errorTest');
  if (e.reason === 'secret') return t('settings.meetings.others.errorSecret');
  if (e.code === 'unknown_command') return t('settings.meetings.others.errorOld');
  if (e.code === 'offline' || e.code === 'timeout') return t('settings.meetings.others.errorNoAnswer');
  if (e.code === 'sync_off') return t('settings.meetings.others.errorSyncOff');
  return t(e.action === 'share' ? 'settings.meetings.others.errorShare' : 'settings.meetings.others.errorUse');
}

// Settings > Meetings > Your other computers (voice/share.js): share this computer's bucket through the Rukoo
// account, or use the one another computer shares. share: voiceState's share, or null from an older main.
function othersHtml(voice, row) {
  const share = voice && voice.share;
  const text = (key, vars) => `<p class="settings-text">${esc(t(key, vars))}</p>`;
  const card = (inner) => `<div class="card">${inner}</div>`;
  // While sharing is on, the switch stays to turn it off, whatever Voice's state: turning it off needs only the account.
  const shareRow = () => row({ title: esc(t('settings.meetings.others.share')), desc: esc(t('settings.meetings.others.shareHelp')), action: 'mtset-share', toggle: share.share, disabled: share.busy === 'sharing' });
  const onlyOff = () => (share.share ? card(shareRow()) : '');
  let body;
  if (!share || !share.signedIn) body = text('settings.meetings.others.noAccount');
  else if (!share.connected) body = text('settings.meetings.others.noVoice') + onlyOff();
  else if (share.supported === false) body = text('settings.meetings.others.oldVoice') + onlyOff();
  else {
    // The offer and the switch share one card; why one failed and what Rukoo does by itself go under it.
    const rows = [];
    const notes = [];
    const error = share.error ? `<p class="settings-text mtset-share-error" role="alert">${esc(shareError(share.error))}</p>` : '';
    if (share.offer) {
      const applying = share.busy === 'applying';
      const help = share.offer.device ? t('settings.meetings.others.offerHelp', { device: share.offer.device, bucket: share.offer.bucket }) : t('settings.meetings.others.offerHelpNoName', { bucket: share.offer.bucket });
      rows.push(`<div class="row static mtset-offer" data-share-offer>
          <div class="text"><div class="title">${esc(t('settings.meetings.others.offer'))}</div>
          <div class="desc">${esc(help)}${share.syncHere ? ` ${esc(t('settings.meetings.others.offerReplaces'))}` : ''}</div></div>
          <button class="btn sm primary" data-a="mtset-share-use" ${share.busy ? 'disabled' : ''}>${esc(t(applying ? 'settings.meetings.others.using' : 'settings.meetings.others.use'))}</button>
        </div>`);
      if (share.error && share.error.action === 'use') notes.push(error);
    }
    if (share.syncHere || share.share) {
      rows.push(shareRow());
      if (share.error && share.error.action === 'share') notes.push(error);
    }
    if (!share.syncHere && !share.offer && share.syncHere === false) notes.push(text('settings.meetings.others.syncOff'));
    if (share.follow && !share.offer && share.syncHere) notes.push(text('settings.meetings.others.following'));
    body = (rows.length ? card(rows.join('')) : '') + notes.join('');
  }
  return `<div class="settings-group-title">${esc(t('settings.meetings.others'))}</div>${body}`;
}

// pages: what settings.js needs. row: its row helper; go and rerender: its navigation; current(): the page on top.
export function meetingSettingsPages({ row, go, rerender, current }) {
  let voice = null;

  async function prepare() {
    try {
      voice = await api('voiceState');
    } catch (_) {
      voice = null;
    }
  }

  // The row on the Settings overview.
  function rowHtml() {
    return row({ title: esc(t('settings.meetings.title')), desc: esc(statusOf(voice).text), action: 'mtset-open' });
  }

  function view(settings) {
    const s = settings || {};
    const status = statusOf(voice);
    const platform = window.mail.platform;
    const canHide = platform === 'win32' || platform === 'darwin';
    const hide = canHide
      ? row({ title: esc(t('settings.meetings.hide')), desc: esc(hideHelp(platform)), action: 'toggle:meetingHideWindow', toggle: s.meetingHideWindow !== false })
      : `<div class="row static"><div class="text"><div class="title">${esc(t('settings.meetings.hide'))}</div><div class="desc">${esc(hideHelp(platform))}</div></div></div>`;
    const hiddenNow = voice && voice.hidden ? `<p class="settings-text">${esc(t('settings.meetings.hiddenNow'))}</p>` : '';
    return {
      title: esc(t('settings.meetings.title')),
      body: `
        <div class="settings-group-title">${esc(t('settings.meetings.voice'))}</div>
        <div class="card">
          <div class="row static mtset-status">
            <div class="text"><div class="title">${esc(t('settings.meetings.connection'))}</div><div class="desc">${esc(status.help)}</div></div>
            <span class="mtset-pill is-${status.tone}"><i aria-hidden="true"></i>${esc(status.text)}</span>
          </div>
        </div>
        <p class="settings-text">${esc(t('settings.meetings.voiceHelp'))}</p>
        <div class="settings-group-title">${esc(t('settings.meetings.privacy'))}</div>
        <div class="card">
          ${hide}
          ${row({ title: esc(t('settings.meetings.agents')), desc: esc(t('settings.meetings.agentsHelp')), action: 'toggle:meetingAgentsCanRead', toggle: s.meetingAgentsCanRead !== false })}
        </div>
        <p class="settings-text">${esc(t('settings.meetings.notices'))}</p>
        ${hiddenNow}
        ${othersHtml(voice, row)}`
    };
  }

  // Handles a data-a action of this page; false when it isn't one.
  async function click(a) {
    if (a === 'mtset-open') {
      go('meetings');
      return true;
    }
    // The share state comes back with the answer and with main's 'meeting' state event.
    if (a === 'mtset-share' || a === 'mtset-share-use') {
      const on = !(voice && voice.share && voice.share.share);
      try {
        const share = await (a === 'mtset-share' ? api('voiceShareSet', on) : api('voiceShareUse'));
        if (share && voice) voice = { ...voice, share };
      } catch (_) {
        // main's state event says what happened.
      }
      if (current() === 'meetings') rerender();
      return true;
    }
    return false;
  }

  // Main's 'meeting' state event: Voice connected, left or started recording. The overview row and the page follow.
  function onState(state) {
    if (!state) return;
    voice = state;
    const view = current();
    if (view === 'meetings' || view === 'main') rerender();
  }

  return { prepare, rowHtml, view, click, onState };
}
