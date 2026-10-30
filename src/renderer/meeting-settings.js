// Settings > Meetings: whether Rukoo Voice is connected, hiding Rukoo from screen recordings during a meeting
// (meetingHideWindow) and whether agents can read meetings (meetingAgentsCanRead). Both settings live in main's
// settings and default to on; main hides the windows (main.js protectWindows) and the meeting tools ask it.
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
        ${hiddenNow}`
    };
  }

  // Handles a data-a action of this page; false when it isn't one.
  async function click(a) {
    if (a === 'mtset-open') {
      go('meetings');
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
