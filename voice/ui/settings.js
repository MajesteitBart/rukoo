// Rukoo Voice Settings: Rukoo's Settings pattern, a single column of grouped cards where a row changes a value in
// place or opens a sub-page. The app owns every value; this page renders settings_state() and the
// settings://state events and sends changes back (voice/ui/API.md). Secrets never reach this page: a saved API key
// is only a "Key saved" flag.

import { loadCatalogs, setLanguage, language, t, tHtml, esc, localize, list, bytes, dateTime, languageName } from './lib/i18n.js';
import { connect, invoke, listen, params, mocked } from './lib/bridge.js';
import { icons } from './lib/icons.js';

// Rows designed now and hidden in Voice 0.1: screen recording, speaker labels and bucket sync (architecture.md).
// ?later=1 shows them in mock mode, for design review.
const LATER = mocked && params.get('later') === '1';

const HOTKEYS = ['right alt', 'right ctrl', 'right shift', 'f13', 'f14', 'f15', 'pause', 'scroll lock'];
const KEY_NAMES = {
  'right alt': 'settings.keys.rightAlt',
  'right ctrl': 'settings.keys.rightCtrl',
  'right shift': 'settings.keys.rightShift',
  pause: 'settings.keys.pause',
  'scroll lock': 'settings.keys.scrollLock'
};
// The keys a choice can't share, with the hint that says who has it.
const KEY_ROLES = {
  'dictation.hotkey': 'settings.keys.usedDictation',
  'dictation.rewriteHotkey': 'settings.keys.usedRewrite',
  'meetings.stopKey': 'settings.keys.usedStop'
};
const KEY_TITLES = {
  'dictation.hotkey': 'settings.dictation.key',
  'dictation.rewriteHotkey': 'settings.rewriting.key',
  'meetings.stopKey': 'settings.meetings.stopKey'
};

const SPOKEN_LANGUAGES = ['auto', 'en', 'nl', 'de', 'fr', 'es', 'it', 'pt', 'pl', 'ja', 'zh'];
const UI_LANGUAGES = [
  ['en', 'English'],
  ['nl', 'Nederlands']
];
const THEMES = [
  ['system', 'common.system'],
  ['light', 'settings.theme.light'],
  ['dark', 'settings.theme.dark']
];
const EDGES = [
  ['bottom', 'settings.pill.bottom'],
  ['top', 'settings.pill.top']
];
const RETENTION = [
  ['days7', 'settings.retention.days7'],
  ['keep', 'settings.retention.keep'],
  ['after_transcription', 'settings.retention.afterTranscription']
];
const TONES = [
  ['auto', 'settings.tone.auto'],
  ['professional', 'settings.tone.professional'],
  ['casual', 'settings.tone.casual'],
  ['friendly', 'settings.tone.friendly'],
  ['concise', 'settings.tone.concise']
];
const SCREEN = [
  ['off', 'common.off'],
  ['frames', 'settings.meetings.screenFrames'],
  ['video', 'settings.meetings.screenVideo']
];

// Ownkey's filler lists (text_cleanup.py); the real cleanup runs in the app, these only describe each switch.
const FILLER_WORDS = {
  en: ['uh', 'uhh', 'um', 'umm', 'uhm', 'erm', 'er', 'mhm'],
  nl: ['uh', 'uhm', 'eh', 'ehm', 'euh', 'euhm', 'hm'],
  de: ['äh', 'ähm', 'ehm', 'hm', 'mh'],
  fr: ['euh', 'heu', 'hum'],
  es: ['eh', 'em', 'ehm', 'este']
};
const FILLER_SAMPLE = 'Um, I think, uh, we should ehm ship it on Tuesday. Er is nog één ding.';

const BRANDS = { openai: 'OpenAI', anthropic: 'Anthropic', google: 'Google', mistral: 'Mistral', ollama: 'Ollama', openrouter: 'OpenRouter' };
const ORUKEET_MODEL = 'orukeet-onnx-int8';
// Ownkey never asks before sending to these hosts: they are this computer.
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);
const PROVIDER_FORMS = ['transcription', 'rewriting', 'meetings'];
const PAGES = ['main', 'transcription', 'dictionary', 'fillers', 'rewriting', 'meetingTranscription', 'speakers', 'storage', 'rukoo', 'import'];
const GROUP_ANCHORS = ['status', 'dictation', 'meetings', 'general', 'about'];

const page = document.getElementById('page');

let state = null;
let stack = ['main'];
let rendered = new Map();
const drafts = {};
const formStatus = {};
const modelLists = {};
let preview = { text: '', for: '' };
let dictionary = { correcting: false, error: '' };
let tokenDone = false;
let importStatus = null;
let idleError = false;
let syncTest = null;

// ---------- small helpers ----------

const current = () => stack[stack.length - 1];

function getPath(object, key) {
  return key.split('.').reduce((value, part) => (value == null ? undefined : value[part]), object);
}

function setPath(object, key, value) {
  const parts = key.split('.');
  const last = parts.pop();
  const target = parts.reduce((value, part) => (value[part] ??= {}), object);
  target[last] = value;
}

const keyName = (key) => (key === 'off' || !key ? t('common.off') : KEY_NAMES[key] ? t(KEY_NAMES[key]) : key.toUpperCase());
const kbd = (key) => `<kbd>${esc(keyName(key))}</kbd>`;
const labelOf = (pairs, value) => {
  const found = pairs.find(([v]) => v === value);
  return found ? t(found[1]) : String(value ?? '');
};

function providerLabel(id, target) {
  if (id === 'custom') return t('settings.provider.custom');
  if (id === 'orukeet') return t(target === 'meetings' ? 'settings.provider.orukeetMeetings' : 'settings.provider.orukeet');
  return BRANDS[id] || id;
}

function hostOf(endpoint) {
  try {
    return new URL(endpoint).hostname.toLowerCase();
  } catch {
    return '';
  }
}

const cut = (text, n = 180) => (text && text.length > n ? `${text.slice(0, n - 1)}…` : text || '');

function status(tone, text) {
  return `<span class="status" data-tone="${tone}"><span class="dot"></span><span>${esc(text)}</span></span>`;
}

// A settings row. With `action` it is a button; otherwise a static row that may hold its own controls in `side`.
function row({ title, desc, descHtml, value, valueClass = '', action, toggle, lead = '', side = '', cls = '', disabled = false, below = '' }) {
  const text = `<div class="text"><div class="title">${esc(title)}</div>${
    descHtml ? `<div class="desc">${descHtml}</div>` : desc ? `<div class="desc">${esc(desc)}</div>` : ''
  }${value ? `<div class="value ${valueClass}">${esc(value)}</div>` : ''}${below}</div>`;
  const sw = toggle === undefined ? '' : `<span class="switch ${toggle ? 'on' : ''}" aria-hidden="true"></span>`;
  if (!action) return `<div class="row static ${cls}">${lead}${text}${side}</div>`;
  const role = toggle === undefined ? '' : `role="switch" aria-checked="${toggle}"`;
  return `<button class="row ${cls}" data-a="${esc(action)}" ${role} ${disabled ? 'disabled' : ''}>${lead}${text}${side}${sw}</button>`;
}

const groupTitle = (title, id = '') => `<div class="settings-group-title" ${id ? `id="group-${id}"` : ''}>${esc(title || '')}</div>`;
const card = (body, cls = '') => `<div class="card ${cls}">${body}</div>`;
const paragraph = (text) => `<p class="settings-text">${esc(text)}</p>`;
const section = (id, html) => ({ id, html });

// ---------- derived values ----------

function dictionaryCount() {
  const { vocabulary, corrections } = state.config.dictionary;
  if (!vocabulary.length && !corrections.length) return '';
  return `${t('settings.dictionary.words', { count: vocabulary.length })} · ${t('settings.dictionary.corrections', { count: corrections.length })}`;
}

function rewritingValue() {
  const { auto } = state.config.rewriting;
  const edits = state.config.dictation.rewriteHotkey !== 'off';
  if (auto && edits) return t('settings.rewriting.valueBoth');
  if (auto) return t('settings.rewriting.valuePolish');
  if (edits) return t('settings.rewriting.valueEdits');
  return t('common.off');
}

function dictationStatus() {
  switch (state.dictation.status) {
    case 'ready':
      return status('ok', t('settings.status.ready'));
    case 'loadingModel':
      return status('busy', t('settings.status.loadingModel'));
    case 'modelMissing':
      return status('bad', t('settings.status.modelMissing'));
    case 'noKey':
      return status('bad', t('settings.status.noKey'));
    default:
      return status('bad', t('settings.status.noMic'));
  }
}

function rukooStatus() {
  switch (state.rukoo.state) {
    case 'connected':
      return status('ok', t('settings.rukoo.connected'));
    case 'rukooOutdated':
      return status('busy', t('settings.rukoo.rukooOutdated'));
    case 'voiceOutdated':
      return status('busy', t('settings.rukoo.voiceOutdated'));
    case 'refused':
      return status('bad', t('settings.rukoo.refused'));
    default:
      return status('off', t('settings.rukoo.notRunning'));
  }
}

function updatesValue() {
  switch (state.updates.state) {
    case 'checking':
      return t('settings.updates.checking');
    case 'available':
      return t('settings.updates.available', { version: state.updates.version });
    case 'upToDate':
      return t('settings.updates.upToDate');
    case 'failed':
      return t('settings.updates.failed');
    default:
      return '';
  }
}

// The keys Voice listens on that the running Ownkey answers too. Voice never stops Ownkey; it only says so.
function ownkeyConflicts() {
  if (!state.ownkey.running) return [];
  const ours = Object.keys(KEY_ROLES).map((role) => getPath(state.config, role));
  return [...new Set(ours.filter((key) => key && key !== 'off' && state.ownkey.keys.includes(key)))];
}

function consentNeeded(provider, endpoint) {
  if (provider === 'orukeet') return false;
  const host = hostOf(endpoint);
  return !host || !LOCAL_HOSTS.has(host);
}

function savedConsentFor(provider, endpoint) {
  const consent = state.config.meetings.consent;
  return !!consent && consent.provider === provider && consent.host === hostOf(endpoint);
}

function meetingsWaitForConsent() {
  const m = state.config.meetings;
  return consentNeeded(m.provider, m.endpoint) && !savedConsentFor(m.provider, m.endpoint);
}

// ---------- pages ----------

function mainPage() {
  const c = state.config;
  const conflicts = ownkeyConflicts();
  const keysHtml =
    c.dictation.rewriteHotkey === 'off'
      ? tHtml('settings.status.dictationHelpNoRewrite', { key: kbd(c.dictation.hotkey) })
      : tHtml('settings.status.dictationHelp', { key: kbd(c.dictation.hotkey), rewriteKey: kbd(c.dictation.rewriteHotkey) });
  const ready = state.dictation.status === 'ready' || state.dictation.status === 'loadingModel';
  const firstConflictRole = Object.keys(KEY_ROLES).find((role) => conflicts.includes(getPath(c, role)));

  const statusCard = card(
    row({ title: t('settings.status.dictation'), descHtml: keysHtml, side: dictationStatus(), action: ready ? null : 'go:transcription' }) +
      row({ title: t('settings.status.rukoo'), side: rukooStatus(), action: 'go:rukoo' }) +
      (conflicts.length
        ? row({
            lead: `<span class="lead warn top">${icons.warning}</span>`,
            title: t('settings.status.ownkey'),
            desc: t('settings.status.ownkeyHelp', { keys: list(conflicts.map(keyName)) }),
            action: `choose:${firstConflictRole}`
          })
        : '')
  );

  const dictationCard = card(
    row({ title: t('settings.dictation.key'), desc: t('settings.dictation.keyHelp'), value: keyName(c.dictation.hotkey), action: 'choose:dictation.hotkey' }) +
      row({ title: t('settings.dictation.paste'), desc: t('settings.dictation.pasteHelp'), toggle: c.dictation.pasteMode, action: 'toggle:dictation.pasteMode' }) +
      row({ title: t('settings.dictation.chime'), desc: t('settings.dictation.chimeHelp'), toggle: c.dictation.readyChime, action: 'toggle:dictation.readyChime' }) +
      row({
        title: t('settings.dictation.login'),
        desc: state.devMode ? t('settings.dictation.loginDev') : t('settings.dictation.loginHelp'),
        toggle: !state.devMode && c.dictation.startAtLogin,
        action: 'toggle:dictation.startAtLogin',
        disabled: state.devMode
      }) +
      row({ title: t('settings.pill.edge'), value: labelOf(EDGES, c.ui.pillEdge), action: 'choose:ui.pillEdge' }) +
      row({ title: t('settings.pill.hide'), desc: t('settings.pill.hideHelp'), toggle: c.ui.hidePillFromCapture, action: 'toggle:ui.hidePillFromCapture' }) +
      row({ title: t('settings.dictation.transcription'), value: providerLabel(c.transcription.provider, 'transcription'), action: 'go:transcription' }) +
      row({ title: t('settings.dictation.dictionary'), desc: dictionaryCount(), action: 'go:dictionary' }) +
      row({ title: t('settings.dictation.fillers'), value: t(c.fillers.enabled ? 'common.on' : 'common.off'), action: 'go:fillers' }) +
      row({ title: t('settings.dictation.rewriting'), value: rewritingValue(), action: 'go:rewriting' })
  );

  const screenRow = LATER
    ? row({
        title: t('settings.meetings.screen'),
        desc: t('settings.meetings.screenHelp'),
        side: segmented('meetings.screen', SCREEN, c.meetings.screen, t('settings.meetings.screen'))
      })
    : '';
  const meetingsCard = card(
    screenRow +
      row({
        title: t('settings.meetings.transcription'),
        desc: meetingsWaitForConsent() ? t('settings.meetings.consentWaiting') : '',
        value: providerLabel(c.meetings.provider, 'meetings'),
        action: 'go:meetingTranscription'
      }) +
      row({ title: t('settings.meetings.retention'), desc: t('settings.meetings.retentionHelp'), value: labelOf(RETENTION, c.meetings.retention), action: 'choose:meetings.retention' }) +
      row({ title: t('settings.meetings.stopKey'), desc: t('settings.meetings.stopKeyHelp'), value: keyName(c.meetings.stopKey), action: 'choose:meetings.stopKey' }) +
      (LATER ? row({ title: t('settings.meetings.speakers'), value: t(c.meetings.liveSpeakers ? 'common.on' : 'common.off'), action: 'go:speakers' }) : '') +
      row({
        title: t('settings.meetings.storage'),
        value: t('settings.meetings.storageValue', { free: bytes(state.storage.freeBytes), size: bytes(state.storage.usedBytes) }),
        action: 'go:storage'
      })
  );

  const generalCard = card(
    row({
      title: t('settings.general.language'),
      value: c.ui.language === 'system' ? t('common.system') : UI_LANGUAGES.find(([code]) => code === c.ui.language)?.[1] || c.ui.language,
      action: 'choose:ui.language'
    }) + row({ title: t('settings.general.theme'), value: labelOf(THEMES, c.ui.theme), action: 'choose:ui.theme' })
  );

  const aboutCard = card(
    row({ title: t('settings.updates.title'), desc: t('settings.updates.help'), toggle: c.updates.check, action: 'toggle:updates.check' }) +
      row({ title: t('settings.updates.checkNow'), value: updatesValue(), action: 'updates-check', disabled: state.updates.state === 'checking' }) +
      row({
        title: t('settings.about.import'),
        value: state.ownkey.lastImport ? t('settings.about.importedOn', { date: dateTime(state.ownkey.lastImport) }) : t('settings.about.notImported'),
        action: 'go:import'
      }) +
      row({ title: t('settings.about.logs'), action: 'open:logs' }) +
      row({ title: t('settings.about.licenses'), action: 'licenses' }) +
      row({ title: t('settings.about.version'), desc: state.devMode ? t('settings.about.dev') : '', side: `<span class="tail selectable">${esc(state.version)}</span>` })
  );

  return {
    title: t('settings.main.title'),
    sections: [
      section('status', groupTitle('', 'status') + statusCard),
      section('dictation', groupTitle(t('settings.groups.dictation'), 'dictation') + dictationCard),
      section('meetings', groupTitle(t('settings.groups.meetings'), 'meetings') + meetingsCard),
      section('general', groupTitle(t('settings.groups.general'), 'general') + generalCard),
      section('about', groupTitle(t('settings.groups.about'), 'about') + aboutCard)
    ]
  };
}

function segmented(key, options, value, label) {
  const index = Math.max(0, options.findIndex(([v]) => v === value));
  return `<div class="segmented" role="tablist" aria-label="${esc(label)}" style="--n:${options.length};--i:${index}">
    <span class="seg-thumb" aria-hidden="true"></span>${options
      .map(([v, labelKey]) => `<button role="tab" aria-selected="${v === value}" data-a="seg:${esc(key)}:${esc(v)}">${esc(t(labelKey))}</button>`)
      .join('')}</div>`;
}

function transcriptionPage() {
  const provider = formValue('transcription', 'provider');
  const sections = [
    section('intro', paragraph(t('settings.transcription.intro'))),
    section('form', groupTitle(t('settings.transcription.speechToText')) + card(providerForm('transcription')))
  ];
  if (provider === 'orukeet') sections.push(section('orukeet', groupTitle(t('settings.orukeet.title')) + orukeetCard()));
  return { title: t('settings.dictation.transcription'), sections };
}

// The provider form, for transcription, rewriting and meeting transcription. Ownkey's rules: changing the provider
// clears the key, sets the provider's first endpoint and clears the model, because "Credentials are
// provider-specific. Never carry a key into a newly selected provider where it could be sent accidentally."
function providerForm(target) {
  const saved = state.config[target];
  const d = drafts[target] || {};
  const provider = formValue(target, 'provider');
  const local = provider === 'orukeet';
  const ids = providerIds(target);
  const keySaved = saved.keySaved && provider === saved.provider && !d.replacingKey;
  const presets = presetEndpoints(target, provider);
  const models = modelLists[target];
  const fs = formStatus[target];

  const options = ids.map((id) => `<option value="${esc(id)}" ${id === provider ? 'selected' : ''}>${esc(providerLabel(id, target))}</option>`).join('');
  let fields = `<label>${esc(t('settings.provider.provider'))}<select data-field="${target}.provider">${options}</select></label>`;

  if (!local) {
    const keyOptional = provider === 'custom' || provider === 'ollama';
    const key = keySaved
      ? `<div class="field"><span>${esc(t('settings.provider.apiKey'))}</span><div class="key-saved"><span>${icons.check}${esc(t('settings.provider.keySaved'))}</span>
          <button class="btn sm secondary" data-a="replace-key:${target}">${esc(t('common.replace'))}</button>
          <button class="btn sm secondary danger" data-a="remove-key:${target}">${esc(t('common.remove'))}</button></div></div>`
      : `<label>${esc(t('settings.provider.apiKey'))}<input type="password" data-field="${target}.apiKey" autocomplete="off" spellcheck="false" placeholder="${esc(
          t('settings.provider.keyPlaceholder')
        )}" />${keyOptional ? `<span class="field-help">${esc(t('settings.provider.keyOptional'))}</span>` : ''}</label>`;
    const modelHelp = !models
      ? ''
      : models.status === 'failed'
        ? `<span class="field-help bad">${esc(t('settings.provider.modelsFailed', { error: models.error }))}</span>`
        : models.status === 'done'
          ? `<span class="field-help">${esc(models.list.length ? t('settings.provider.modelsFound', { count: models.list.length }) : t('settings.provider.noModels', { provider: providerLabel(provider, target) }))}</span>`
          : '';
    fields += `${key}
      <label>${esc(t('settings.provider.endpoint'))}<input type="text" inputmode="url" list="endpoints-${target}" data-field="${target}.endpoint" spellcheck="false" autocomplete="off" />
        <datalist id="endpoints-${target}">${presets.map((url) => `<option value="${esc(url)}"></option>`).join('')}</datalist></label>
      <label>${esc(t('settings.provider.model'))}<div class="with-btn"><input type="text" list="models-${target}" data-field="${target}.model" spellcheck="false" autocomplete="off" placeholder="${esc(
        t('settings.provider.modelPlaceholder')
      )}" /><button class="btn secondary" data-a="refresh:${target}" ${models?.status === 'loading' ? 'disabled' : ''}>${esc(
        models?.status === 'loading' ? t('common.loading') : t('common.refresh')
      )}</button></div>
        <datalist id="models-${target}">${(models?.list || []).map((id) => `<option value="${esc(id)}"></option>`).join('')}</datalist>${modelHelp}</label>`;
  }

  if (target === 'transcription') {
    const options = SPOKEN_LANGUAGES.map(
      (code) => `<option value="${code}">${esc(code === 'auto' ? t('settings.transcription.languageAuto') : languageName(code))}</option>`
    ).join('');
    fields += `<label>${esc(t('settings.transcription.language'))}<select data-field="transcription.language" ${local ? 'disabled' : ''}>${options}</select>
      <span class="field-help">${esc(local ? t('settings.transcription.languageOrukeet') : t('settings.transcription.languageHelp'))}</span></label>`;
  }

  if (target === 'meetings') fields += consentBlock(provider, formValue('meetings', 'endpoint'), formValue('meetings', 'model'));

  const statusHtml = !fs
    ? ''
    : `<span class="form-status ${fs.kind === 'saved' ? 'ok' : fs.kind === 'failed' || fs.kind === 'invalid' ? 'bad' : ''}">${esc(fs.message)}${
        fs.detail ? ` <button class="link-btn" data-a="details:${target}">${esc(t('common.errorDetails'))}</button>` : ''
      }</span>`;
  const busy = fs && (fs.kind === 'saving' || fs.kind === 'loading');
  fields += `<div class="form-actions">${statusHtml}<button class="btn primary" data-a="save:${target}" ${busy ? 'disabled' : ''}>${esc(t('common.save'))}</button></div>`;
  return `<div class="form" data-form="${target}">${fields}</div>`;
}

// Decision 10: a cloud provider for meetings shows what goes where, with a checkbox. Consent is saved as
// {provider, host}, so another provider or server asks again. Without it a meeting still records and its
// transcription waits.
function consentBlock(provider, endpoint, model) {
  if (!consentNeeded(provider, endpoint)) return '';
  const host = hostOf(endpoint);
  const name = providerLabel(provider, 'meetings');
  const checked = consentValue(provider, endpoint);
  return `<div class="consent">
    <h3>${esc(t('settings.consent.title', { provider: name }))}</h3>
    <p>${esc(t('settings.consent.intro', { provider: name }))}</p>
    <dl class="facts">
      <dt>${esc(t('settings.consent.provider'))}</dt><dd>${esc(model ? `${name} · ${model}` : name)}</dd>
      <dt>${esc(t('settings.consent.server'))}</dt><dd class="mono">${esc(host || '–')}</dd>
      <dt>${esc(t('settings.consent.sent'))}</dt><dd>${esc(t('settings.consent.sentValue'))}</dd>
      <dt>${esc(t('settings.consent.notSent'))}</dt><dd>${esc(t('settings.consent.notSentValue'))}</dd>
      <dt>${esc(t('settings.consent.kept'))}</dt><dd>${esc(t('settings.consent.keptValue'))}</dd>
    </dl>
    <label class="check-row"><input type="checkbox" data-field="meetings.consent" ${checked ? 'checked' : ''} ${host ? '' : 'disabled'} />
      <span>${esc(t('settings.consent.agree', { provider: name, host: host || '–' }))}</span></label>
    <span class="field-help">${esc(checked ? t('settings.consent.again') : t('settings.consent.waiting'))}</span>
  </div>`;
}

function consentValue(provider, endpoint) {
  const d = drafts.meetings;
  const forKey = `${provider}|${hostOf(endpoint)}`;
  if (d && d.consentFor === forKey && typeof d.consent === 'boolean') return d.consent;
  return savedConsentFor(provider, endpoint);
}

function providerIds(target) {
  const kind = target === 'rewriting' ? 'rewrite' : 'audio';
  const ids = state.providers[kind].map((p) => p.id);
  // For meetings, Orukeet comes first: it is the default and keeps the audio on this computer.
  return target === 'meetings' ? ['orukeet', ...ids.filter((id) => id !== 'orukeet')] : ids;
}

function presetEndpoints(target, provider) {
  const kind = target === 'rewriting' ? 'rewrite' : 'audio';
  return state.providers[kind].find((p) => p.id === provider)?.endpoints || [];
}

const MODEL_STAGES = { downloading: 'settings.model.downloading', verifying: 'settings.model.verifying', extracting: 'settings.model.extracting' };
const MODEL_ACTIVE = {
  loaded: 'settings.model.state.loaded',
  unloaded: 'settings.model.state.unloaded',
  loading: 'settings.model.state.loading',
  error: 'settings.model.state.error'
};

function modelStatus(m) {
  if (MODEL_STAGES[m.stage]) {
    const stage = t(MODEL_STAGES[m.stage]);
    return { tone: 'busy', text: Number.isFinite(m.percent) ? t('settings.model.progress', { stage, percent: Math.round(m.percent) }) : stage };
  }
  if (m.stage === 'failed') return { tone: 'bad', text: t('settings.model.failed') };
  if (m.stage === 'missing') return { tone: 'off', text: t('settings.model.missing', { size: bytes(m.sizeBytes) }) };
  if (m.stage === 'unavailable') return { tone: 'bad', text: t('settings.model.unavailable') };
  if (m.active === 'error') return { tone: 'bad', text: t('settings.model.loadFailed') };
  if (m.active === 'loading') return { tone: 'busy', text: t('settings.model.loading') };
  if (m.active) return { tone: m.active === 'loaded' ? 'ok' : 'off', text: t('settings.model.active', { state: t(MODEL_ACTIVE[m.active]) }) };
  return { tone: 'off', text: t('settings.model.installed') };
}

// A model's files, status and actions. "Remove download" only appears for a model in Voice's own folder: Voice
// never deletes anything in Ownkey's folders (architecture.md decision 13).
function modelRows(m) {
  const s = modelStatus(m);
  const busy = Boolean(MODEL_STAGES[m.stage]);
  const progress = busy && Number.isFinite(m.percent) ? `<div class="progress" role="progressbar" aria-valuenow="${Math.round(m.percent)}" aria-valuemin="0" aria-valuemax="100"><span style="--p:${m.percent}"></span></div>` : '';
  // The pill says what state the model is in; the error itself goes on its own line, cut at 180 characters as in
  // Ownkey, with all of it behind Error details.
  const failure = s.tone === 'bad' && m.error ? `<div class="desc">${esc(cut(m.error))}</div>` : '';
  const files = row({
    title: t('settings.model.files'),
    descHtml: m.path ? `<span class="mono selectable">${esc(m.path)}</span>` : '',
    below: progress + failure,
    side: `<span class="model-status">${status(s.tone, s.text)}</span>`
  });
  const actions = [];
  if (busy) actions.push(`<button class="btn sm secondary" data-a="model:${m.id}:cancel">${esc(t('settings.model.cancel'))}</button>`);
  else if (m.stage === 'missing' || m.stage === 'failed') actions.push(`<button class="btn sm primary" data-a="model:${m.id}:download">${icons.download}${esc(t('settings.model.download'))}</button>`);
  if (!busy && m.removable && !m.active && m.stage === 'installed') actions.push(`<button class="btn sm secondary danger" data-a="model:${m.id}:remove">${esc(t('settings.model.remove'))}</button>`);
  if (m.error) actions.push(`<button class="link-btn" data-a="model:${m.id}:details">${esc(t('common.errorDetails'))}</button>`);
  if (m.location === 'ownkey') actions.push(`<span class="model-note">${esc(t('settings.model.inOwnkey'))}</span>`);
  return files + (actions.length ? `<div class="model-actions">${actions.join('')}</div>` : '');
}

function orukeetCard() {
  const m = state.models.orukeet;
  const folder = state.config.local.modelFolder;
  const folderRow = row({
    title: t('settings.model.folder'),
    desc: t('settings.model.folderHelp'),
    below: folder ? `<div class="value plain mono selectable">${esc(folder)}</div>` : `<div class="value plain">${esc(t('settings.model.folderAuto'))}</div>`,
    side: `<div class="side">${folder ? `<button class="btn sm secondary" data-a="folder-reset:models">${esc(t('settings.model.folderReset'))}</button>` : ''}<button class="btn sm secondary" data-a="folder:models">${esc(t('common.browse'))}</button></div>`
  });
  const idleRow = row({
    title: t('settings.model.idle'),
    desc: idleError ? '' : t('settings.model.idleHelp'),
    below: idleError ? `<div class="desc field-error">${esc(t('settings.model.idleInvalid'))}</div>` : '',
    side: `<span class="with-unit"><input class="input" type="number" min="0" max="1440" step="1" data-field="local.idleMinutes" aria-label="${esc(
      t('settings.model.idle')
    )}" /><span>${esc(t('settings.model.minutes'))}</span></span>`
  });
  const foot = `<div class="card-foot">${esc(t('settings.orukeet.licence'))} <button class="link-btn" data-a="link:orukeet">${icons.link}${esc(t('settings.model.page'))}</button></div>`;
  return card(`<p class="settings-text card-text">${esc(t('settings.orukeet.about'))}</p>${modelRows(m)}${folderRow}${idleRow}${foot}`, 'model-card');
}

function dictionaryPage() {
  const { vocabulary, corrections } = state.config.dictionary;
  const correcting = dictionary.correcting;
  const entries = [
    ...vocabulary.map((word) => ({ kind: 'word', sort: word.toLowerCase(), word })),
    ...corrections.map((c) => ({ kind: 'fix', sort: c.to.toLowerCase(), from: c.from, to: c.to }))
  ].sort((a, b) => a.sort.localeCompare(b.sort, language()));
  const fields = correcting
    ? `<label>${esc(t('settings.dictionary.from'))}<input type="text" data-field="dict.from" spellcheck="false" autocomplete="off" /></label>
       <span class="dict-arrow" aria-hidden="true">→</span>
       <label>${esc(t('settings.dictionary.to'))}<input type="text" data-field="dict.to" spellcheck="false" autocomplete="off" /></label>`
    : `<label>${esc(t('settings.dictionary.word'))}<input type="text" data-field="dict.word" spellcheck="false" autocomplete="off" placeholder="${esc(
        t('settings.dictionary.wordPlaceholder')
      )}" /></label>`;
  const add = `<div class="form"><div class="dict-form">${fields}<button class="btn primary" data-a="dict-add">${esc(
    t(correcting ? 'settings.dictionary.addCorrection' : 'settings.dictionary.addWord')
  )}</button></div>${dictionary.error ? `<span class="field-help bad" role="alert">${esc(dictionary.error)}</span>` : ''}</div>`;
  const rows = entries.length
    ? entries
        .map((e) => {
          const label = e.kind === 'word' ? e.word : e.from;
          const title =
            e.kind === 'word'
              ? esc(e.word)
              : `<span>${esc(e.from)}</span><span class="arrow" aria-hidden="true">→</span><span class="to">${esc(e.to)}</span>`;
          return `<div class="row static dict-row"><div class="text"><div class="title">${title}</div></div>
            <span class="tag">${esc(t(e.kind === 'word' ? 'settings.dictionary.hint' : 'settings.dictionary.fix'))}</span>
            <button class="icon-btn sm" data-a="dict-remove:${e.kind}:${esc(encodeURIComponent(label))}" title="${esc(
              t('settings.dictionary.removeEntry', { entry: label })
            )}" aria-label="${esc(t('settings.dictionary.removeEntry', { entry: label }))}">${icons.trash}</button></div>`;
        })
        .join('')
    : `<p class="settings-text card-text">${esc(t('settings.dictionary.empty'))}</p>`;
  return {
    title: t('settings.dictation.dictionary'),
    sections: [
      section('intro', paragraph(t('settings.dictionary.intro'))),
      section(
        'list',
        groupTitle(dictionaryCount() || t('settings.dictionary.vocabulary')) +
          card(row({ title: t('settings.dictionary.correct'), desc: t('settings.dictionary.correctHelp'), toggle: correcting, action: 'dict-mode' }) + add + rows)
      ),
      section('how', groupTitle(t('settings.dictionary.how')) + paragraph(t('settings.dictionary.howWords')) + paragraph(t('settings.dictionary.howCorrections')))
    ]
  };
}

function fillersPage() {
  const f = state.config.fillers;
  const languages = Object.keys(FILLER_WORDS)
    .map((code) =>
      row({
        title: languageName(code),
        desc: FILLER_WORDS[code].join(', '),
        toggle: f.languages.includes(code),
        action: `filler-language:${code}`,
        disabled: !f.enabled
      })
    )
    .join('');
  return {
    title: t('settings.dictation.fillers'),
    sections: [
      section('intro', paragraph(t('settings.fillers.intro'))),
      section('main', groupTitle('') + card(row({ title: t('settings.fillers.remove'), desc: t('settings.fillers.removeHelp'), toggle: f.enabled, action: 'toggle:fillers.enabled' }))),
      section('languages', groupTitle(t('settings.fillers.languages')) + card(languages)),
      section(
        'custom',
        groupTitle('') +
          card(`<div class="form"><label>${esc(t('settings.fillers.custom'))}<input type="text" data-field="fillers.custom" spellcheck="false" autocomplete="off" placeholder="${esc(
            t('settings.fillers.customPlaceholder')
          )}" /><span class="field-help">${esc(t('settings.fillers.customHelp'))}</span></label></div>`)
      ),
      section(
        'preview',
        groupTitle(t('settings.fillers.preview')) +
          card(
            row({ title: t('settings.fillers.heard'), below: `<div class="preview-line heard">${esc(FILLER_SAMPLE)}</div>` }) +
              row({ title: t('settings.fillers.typed'), below: `<div class="preview-line typed">${esc(preview.text || FILLER_SAMPLE)}</div>` })
          )
      )
    ]
  };
}

function rewritingPage() {
  const r = state.config.rewriting;
  return {
    title: t('settings.dictation.rewriting'),
    sections: [
      section('intro', paragraph(t('settings.rewriting.intro'))),
      section('form', groupTitle(t('settings.rewriting.textModel')) + `<p class="settings-text">${esc(t('settings.rewriting.textModelHelp'))}</p>` + card(providerForm('rewriting'))),
      section(
        'polish',
        groupTitle(t('settings.rewriting.polish')) +
          card(
            row({ title: t('settings.rewriting.auto'), desc: t('settings.rewriting.autoHelp'), toggle: r.auto, action: 'toggle:rewriting.auto' }) +
              row({ title: t('settings.rewriting.tone'), value: labelOf(TONES, r.tone), action: 'choose:rewriting.tone' }) +
              row({ title: t('settings.rewriting.formatting'), desc: t('settings.rewriting.formattingHelp'), toggle: r.formatting, action: 'toggle:rewriting.formatting' }) +
              `<div class="form"><label>${esc(t('settings.rewriting.instructions'))}<input type="text" data-field="rewriting.instructions" autocomplete="off" placeholder="${esc(
                t('settings.rewriting.instructionsPlaceholder')
              )}" /></label></div>`
          )
      ),
      section(
        'edits',
        groupTitle(t('settings.rewriting.voiceEdits')) +
          card(row({ title: t('settings.rewriting.key'), desc: t('settings.rewriting.keyHelp'), value: keyName(state.config.dictation.rewriteHotkey), action: 'choose:dictation.rewriteHotkey' }))
      )
    ]
  };
}

function meetingTranscriptionPage() {
  return {
    title: t('settings.meetingTranscription.title'),
    sections: [section('intro', paragraph(t('settings.meetingTranscription.intro'))), section('form', groupTitle('') + card(providerForm('meetings')))]
  };
}

function speakersPage() {
  const m = state.models.nemotron;
  return {
    title: t('settings.meetings.speakers'),
    sections: [
      section(
        'model',
        groupTitle('Nemotron 3 Diarization') +
          card(
            `<p class="settings-text card-text">${esc(t('settings.speakers.about'))}</p>${modelRows(m)}` +
              row({ title: t('settings.speakers.live'), toggle: state.config.meetings.liveSpeakers, action: 'toggle:meetings.liveSpeakers', disabled: m.stage !== 'installed' }) +
              `<div class="card-foot">${esc(t('settings.speakers.licence'))} <button class="link-btn" data-a="link:nemotron">${icons.link}${esc(t('settings.model.page'))}</button></div>`
          )
      )
    ]
  };
}

function storagePage() {
  const s = state.storage;
  const folderRow = row({
    title: t('settings.storage.folder'),
    descHtml: `<span class="mono selectable">${esc(s.folder)}</span>`,
    below: `<div class="desc">${esc(t('settings.storage.usage', { size: bytes(s.usedBytes), free: bytes(s.freeBytes) }))}</div>`,
    // Voice 0.1 keeps meetings in its data folder, so there is no Browse here (API.md, settings_choose_folder).
    side: `<div class="side"><button class="btn sm secondary" data-a="open:recordings">${esc(t('common.openFolder'))}</button></div>`
  });
  const sections = [section('local', groupTitle(t('settings.storage.local')) + card(folderRow) + (LATER ? paragraph(t('settings.storage.disk')) : ''))];
  if (LATER) sections.push(section('sync', syncSection()));
  return { title: t('settings.meetings.storage'), sections };
}

// Bucket sync is designed but not in Voice 0.1; it only renders with ?later=1.
function syncSection() {
  const sync = state.config.storage.sync;
  const field = (name, label, type = 'text') =>
    `<label>${esc(t(label))}<input type="${type}" data-field="storage.sync.${name}" spellcheck="false" autocomplete="off" /></label>`;
  const services = [
    ['upcloud', 'UpCloud Managed Object Storage'],
    ['r2', 'Cloudflare R2'],
    ['other', t('settings.sync.other')]
  ];
  const form = sync.enabled
    ? `<div class="form">
        <label>${esc(t('settings.sync.service'))}<select data-field="storage.sync.service">${services.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('')}</select></label>
        ${field('endpoint', 'settings.sync.endpoint')}${field('region', 'settings.sync.region')}${field('bucket', 'settings.sync.bucket')}${field('prefix', 'settings.sync.prefix')}
        ${field('accessKeyId', 'settings.sync.accessKey')}${field('secret', 'settings.sync.secretKey', 'password')}
        <div class="form-actions">${
          syncTest?.kind === 'ok'
            ? status('ok', t('settings.sync.testOk'))
            : syncTest?.kind === 'failed'
              ? status('bad', cut(syncTest.message, 80))
              : `<span class="form-status">${esc(t('settings.sync.waiting', { count: state.sync?.waiting ?? 0 }))}</span>`
        }<button class="btn secondary" data-a="sync-test" ${syncTest?.kind === 'testing' ? 'disabled' : ''}>${esc(t('settings.sync.test'))}</button></div></div>` +
      row({ title: t('settings.sync.encrypted'), lead: `<span class="lead">${icons.check}</span>` }) +
      row({ title: t('settings.sync.videoAfter'), lead: `<span class="lead">${icons.check}</span>` }) +
      row({ title: t('settings.sync.recovery'), desc: t('settings.sync.recoveryHelp') })
    : '';
  return groupTitle('') + card(row({ title: t('settings.sync.title'), desc: t('settings.sync.help'), toggle: sync.enabled, action: 'toggle:storage.sync.enabled' }) + form);
}

function rukooPage() {
  const r = state.rukoo;
  const help = {
    connected: r.clientVersion ? t('settings.rukoo.version', { version: r.clientVersion, protocol: r.protocol }) : '',
    notRunning: t('settings.rukoo.notRunningHelp'),
    rukooOutdated: t('settings.rukoo.rukooOutdatedHelp'),
    voiceOutdated: t('settings.rukoo.voiceOutdatedHelp'),
    refused: t('settings.rukoo.refusedHelp')
  }[r.state];
  const connection = card(
    row({ title: t('settings.status.rukoo'), desc: help, side: rukooStatus() }) +
      row({ title: t('settings.rukoo.address'), side: `<span class="tail mono selectable">${esc(r.port ? `127.0.0.1:${r.port}` : '–')}</span>` }) +
      row({
        title: t('settings.rukoo.file'),
        descHtml: `<span class="mono selectable">${esc(r.discoveryPath)}</span>`,
        side: `<button class="btn sm secondary" data-a="open:bridge">${esc(t('common.openFolder'))}</button>`
      }) +
      (r.state === 'connected' ? row({ title: t('settings.rukoo.behind'), side: `<span class="tail">${esc(String(r.behind ?? 0))}</span>` }) : '')
  );
  const token = card(
    row({
      title: t('settings.rukoo.token'),
      desc: tokenDone ? t('settings.rukoo.newTokenDone') : t('settings.rukoo.newTokenHelp'),
      side: `<button class="btn sm secondary" data-a="new-token">${esc(t('settings.rukoo.newToken'))}</button>`
    })
  );
  return {
    title: t('settings.status.rukoo'),
    sections: [
      section('connection', groupTitle(t('settings.rukoo.connection')) + connection + paragraph(t('settings.rukoo.about'))),
      section('token', groupTitle('') + token)
    ]
  };
}

function importPage() {
  const o = state.ownkey;
  const report = o.report;
  const modelList = o.models.length ? list(o.models.map((m) => `${m.name} (${bytes(m.sizeBytes)})`)) : t('settings.import.noModels');
  const found = card(
    row({
      title: t('settings.import.config'),
      descHtml: o.configFound ? tHtml('settings.import.found', { path: `<span class="mono selectable">${esc(o.configPath)}</span>` }) : esc(t('settings.import.notFound'))
    }) +
      row({ title: t('settings.import.last'), side: `<span class="tail">${esc(o.lastImport ? dateTime(o.lastImport) : t('settings.import.never'))}</span>` }) +
      row({ title: t('settings.import.models'), desc: `${modelList}. ${o.models.length ? t('settings.import.modelsHelp') : ''}`.trim() })
  );
  const sections = [section('found', groupTitle('') + found)];
  if (report) {
    const area = (title, value, extra) =>
      row({ title, descHtml: value ? esc(value) + (extra ? `<br>${esc(extra)}` : '') : esc(t('settings.import.notSet')) });
    const providerLine = (p, target) => (p ? [providerLabel(p.provider, target), p.model].filter(Boolean).join(' · ') : '');
    const keyLine = (p) => (p?.keyImported ? t('settings.import.keyImported', { provider: providerLabel(p.provider) }) : '');
    const rows =
      area(t('settings.import.keys'), report.hotkeys && t('settings.import.keysValue', { key: keyName(report.hotkeys.dictation), rewriteKey: keyName(report.hotkeys.rewrite) })) +
      area(t('settings.dictation.transcription'), providerLine(report.transcription, 'transcription'), keyLine(report.transcription)) +
      area(t('settings.dictation.rewriting'), providerLine(report.rewriting, 'rewriting'), keyLine(report.rewriting)) +
      area(
        t('settings.dictation.dictionary'),
        report.dictionary &&
          `${t('settings.dictionary.words', { count: report.dictionary.words })} · ${t('settings.dictionary.corrections', { count: report.dictionary.corrections })}`
      ) +
      area(
        t('settings.dictation.fillers'),
        report.fillers && (report.fillers.enabled ? t('settings.import.fillersOn', { languages: list(report.fillers.languages.map(languageName)) }) : t('common.off'))
      ) +
      area(
        t('settings.groups.meetings'),
        report.meetings && `${providerLabel(report.meetings.provider, 'meetings')} · ${t('settings.import.retention', { retention: labelOf(RETENTION, report.meetings.retention) })}`,
        report.meetings && report.meetings.provider !== 'orukeet' ? t(report.meetings.consent ? 'settings.import.consentKept' : 'settings.import.consentAsk') : ''
      );
    sections.push(section('report', groupTitle(t('settings.import.tookOver')) + card(rows)));
    if (report.skipped?.includes('summaries')) {
      sections.push(
        section('skipped', groupTitle(t('settings.about.notImported')) + card(row({ title: t('settings.import.summaries'), desc: t('settings.import.summariesWhy') })))
      );
    }
  }
  const failed = importStatus?.kind === 'failed' ? `<span class="field-error">${esc(t('settings.import.failed', { error: importStatus.message }))}</span>` : '';
  const action = `<div class="page-actions"><p>${esc(state.devMode ? t('settings.import.dev') : t('settings.import.readOnly'))}${failed ? `<br>${failed}` : ''}</p>
    <button class="btn primary" data-a="import" ${state.devMode || !o.configFound || importStatus?.kind === 'running' ? 'disabled' : ''}>${esc(
      t(o.lastImport ? 'settings.import.again' : 'settings.import.run')
    )}</button></div>`;
  sections.push(section('action', action));
  return { title: t('settings.about.import'), sections };
}

const PAGE_BUILDERS = {
  main: mainPage,
  transcription: transcriptionPage,
  dictionary: dictionaryPage,
  fillers: fillersPage,
  rewriting: rewritingPage,
  meetingTranscription: meetingTranscriptionPage,
  speakers: speakersPage,
  storage: storagePage,
  rukoo: rukooPage,
  import: importPage
};

// ---------- rendering ----------

// Builds the current page. A full render replaces everything; an update replaces only the sections whose markup
// changed, so a download's progress doesn't reset the form next to it. Typed text isn't part of the markup: it
// lives in drafts and fill() puts it back, so it survives any re-render.
function render({ full = false } = {}) {
  if (!state) return;
  const view = PAGE_BUILDERS[current()]();
  const top = current() === 'main';
  if (full || !page.querySelector('.page-inner') || page.dataset.view !== current()) {
    page.dataset.view = current();
    page.innerHTML = `<div class="page-bar ${top ? 'top' : ''}">${
      top ? '' : `<button class="icon-btn" data-a="back" title="${esc(t('common.back'))}" aria-label="${esc(t('common.back'))}">${icons.back}</button>`
    }<h1>${esc(view.title)}</h1></div><div class="page-scroll"><div class="page-inner">${view.sections
      .map((s) => `<section data-section="${s.id}">${s.html}</section>`)
      .join('')}</div></div>`;
    rendered = new Map(view.sections.map((s) => [s.id, s.html]));
    fill(page);
    return;
  }
  page.querySelector('.page-bar h1').textContent = view.title;
  const inner = page.querySelector('.page-inner');
  const ids = view.sections.map((s) => s.id);
  // A section that appears or disappears, such as the Orukeet card, rebuilds the list in order.
  if (ids.join() !== [...rendered.keys()].join()) {
    const keep = captureFocus();
    inner.innerHTML = view.sections.map((s) => `<section data-section="${s.id}">${s.html}</section>`).join('');
    rendered = new Map(view.sections.map((s) => [s.id, s.html]));
    fill(inner);
    restoreFocus(keep);
    return;
  }
  for (const s of view.sections) {
    if (rendered.get(s.id) === s.html) continue;
    const node = inner.querySelector(`[data-section="${s.id}"]`);
    const keep = node.contains(document.activeElement) ? captureFocus() : null;
    node.innerHTML = s.html;
    rendered.set(s.id, s.html);
    fill(node);
    if (keep) restoreFocus(keep);
  }
}

function captureFocus() {
  const el = document.activeElement;
  if (!el || el === document.body) return null;
  const selector = el.dataset.field ? `[data-field="${el.dataset.field}"]` : el.dataset.a ? `[data-a="${el.dataset.a}"]` : null;
  if (!selector) return null;
  let selection = null;
  try {
    selection = el.selectionStart != null ? [el.selectionStart, el.selectionEnd] : null;
  } catch {
    selection = null;
  }
  return { selector, selection };
}

function restoreFocus(keep) {
  if (!keep) return;
  const el = page.querySelector(keep.selector);
  if (!el) return;
  el.focus({ preventScroll: true });
  if (keep.selection) {
    try {
      el.setSelectionRange(...keep.selection);
    } catch {
      // number inputs have no selection
    }
  }
}

// The value a form field shows: the user's draft while they edit, otherwise the app's value.
function formValue(form, name) {
  const draft = drafts[form]?.[name];
  if (draft !== undefined) return draft;
  if (PROVIDER_FORMS.includes(form)) {
    if (name === 'apiKey') return '';
    return state.config[form][name] ?? '';
  }
  if (form === 'dict') return '';
  return getPath(state.config, `${form}.${name}`) ?? '';
}

function fill(root) {
  for (const el of root.querySelectorAll('[data-field]')) {
    const [form, ...rest] = el.dataset.field.split('.');
    const name = rest.join('.');
    if (el.type === 'checkbox') continue;
    const value = formValue(form, name);
    if (el.value !== String(value)) el.value = String(value);
  }
}

// ---------- changing values ----------

async function setValue(key, value) {
  const before = getPath(state.config, key);
  setPath(state.config, key, value);
  render();
  try {
    await invoke('settings_set', { key, value });
  } catch (error) {
    setPath(state.config, key, before);
    render();
    await showError(error?.code === 'same_key' ? t('settings.rewriting.sameKey') : t('settings.errors.failed'), error?.message);
  }
}

async function choose({ title, options, current: value, note }) {
  return dialog({
    title,
    body: `${note ? `<p class="note">${esc(note)}</p>` : ''}<div class="choices" role="radiogroup">${options
      .map(
        (o, i) =>
          `<button class="radio-row" role="radio" aria-checked="${o.value === value}" data-i="${i}" ${o.disabled ? 'disabled' : ''}><span class="radio ${
            o.value === value ? 'on' : ''
          }"></span><span class="rt"><span class="rl">${esc(o.label)}</span>${o.hint ? `<span class="rh">${esc(o.hint)}</span>` : ''}</span></button>`
      )
      .join('')}</div>`,
    buttons: [{ label: t('common.cancel'), value: null }],
    onRender(body, done) {
      body.querySelectorAll('.radio-row').forEach((b) => b.addEventListener('click', () => done(options[Number(b.dataset.i)].value)));
      (body.querySelector('.radio.on')?.parentElement || body.querySelector('.radio-row:not(:disabled)'))?.focus();
    }
  });
}

// A key list greys out the keys another Voice key already uses, instead of Ownkey's silent switch to Off, and says
// which keys the running Ownkey answers too.
async function keyChoice(role) {
  const c = state.config;
  const taken = Object.fromEntries(
    Object.keys(KEY_ROLES)
      .filter((other) => other !== role)
      .map((other) => [getPath(c, other), KEY_ROLES[other]])
      .filter(([key]) => key && key !== 'off')
  );
  const ownkeyKeys = state.ownkey.running ? state.ownkey.keys : [];
  const keys = role === 'dictation.hotkey' ? HOTKEYS : ['off', ...HOTKEYS];
  const options = keys.map((key) => ({
    value: key,
    label: keyName(key),
    disabled: Boolean(taken[key]),
    hint: taken[key] ? t(taken[key]) : ownkeyKeys.includes(key) ? t('settings.keys.ownkey') : ''
  }));
  const value = await choose({ title: t(KEY_TITLES[role]), options, current: getPath(c, role), note: state.devMode ? t('settings.keys.dev') : '' });
  if (value != null && value !== getPath(c, role)) setValue(role, value);
}

async function pairChoice(key, title, pairs) {
  const value = await choose({ title, options: pairs.map(([v, label]) => ({ value: v, label: t(label) })), current: getPath(state.config, key) });
  if (value != null && value !== getPath(state.config, key)) setValue(key, value);
}

const CHOICES = {
  'dictation.hotkey': () => keyChoice('dictation.hotkey'),
  'dictation.rewriteHotkey': () => keyChoice('dictation.rewriteHotkey'),
  'meetings.stopKey': () => keyChoice('meetings.stopKey'),
  'ui.pillEdge': () => pairChoice('ui.pillEdge', t('settings.pill.edge'), EDGES),
  'meetings.retention': () => pairChoice('meetings.retention', t('settings.meetings.retention'), RETENTION),
  'rewriting.tone': () => pairChoice('rewriting.tone', t('settings.rewriting.tone'), TONES),
  'ui.theme': () => pairChoice('ui.theme', t('settings.general.theme'), THEMES),
  'ui.language': async () => {
    const options = [{ value: 'system', label: t('common.system') }, ...UI_LANGUAGES.map(([value, label]) => ({ value, label }))];
    const value = await choose({ title: t('settings.general.language'), options, current: state.config.ui.language });
    if (value != null && value !== state.config.ui.language) setValue('ui.language', value);
  }
};

function draft(form) {
  return (drafts[form] ??= {});
}

function providerChanged(target, provider) {
  const d = draft(target);
  d.provider = provider;
  d.apiKey = '';
  d.replacingKey = false;
  d.endpoint = provider === 'orukeet' ? '' : presetEndpoints(target, provider)[0] || '';
  d.model = provider === 'orukeet' ? ORUKEET_MODEL : '';
  delete modelLists[target];
  delete formStatus[target];
  render();
}

function validateProvider(target, values) {
  if (values.provider === 'orukeet') return null;
  if (values.endpoint && values.model) return null;
  return { rewriting: 'settings.provider.needRewrite', meetings: 'settings.provider.needMeeting' }[target] || 'settings.provider.needAudio';
}

async function saveProvider(target) {
  const saved = state.config[target];
  const d = drafts[target] || {};
  const provider = formValue(target, 'provider');
  const local = provider === 'orukeet';
  const values = {
    target,
    provider,
    endpoint: local ? '' : String(formValue(target, 'endpoint')).trim(),
    model: local ? ORUKEET_MODEL : String(formValue(target, 'model')).trim()
  };
  const problem = validateProvider(target, values);
  if (problem) {
    formStatus[target] = { kind: 'invalid', message: t(problem) };
    render();
    return;
  }
  // null keeps the saved key, "" saves none, text replaces it. The app never keeps a key across providers.
  const typed = String(d.apiKey || '').trim();
  const showingSaved = saved.keySaved && provider === saved.provider && !d.replacingKey;
  values.apiKey = local ? '' : typed ? typed : showingSaved || (saved.keySaved && provider === saved.provider) ? null : '';
  if (target === 'transcription') values.language = local ? 'auto' : formValue('transcription', 'language') || 'auto';
  if (target === 'meetings') values.consent = consentNeeded(provider, values.endpoint) ? consentValue(provider, values.endpoint) : false;
  formStatus[target] = { kind: local ? 'loading' : 'saving', message: t(local ? 'settings.provider.loadingOrukeet' : 'settings.provider.saving') };
  render();
  try {
    await invoke('settings_save_provider', { save: values });
    delete drafts[target];
    formStatus[target] = { kind: 'saved', message: t('settings.provider.saved') };
  } catch (error) {
    formStatus[target] = { kind: 'failed', message: t('settings.provider.failed'), detail: error?.message || String(error) };
  }
  render();
}

// Ownkey's rule for Refresh: a list that arrives after the provider, endpoint or key changed is dropped.
async function refreshModels(target) {
  const provider = formValue(target, 'provider');
  const endpoint = String(formValue(target, 'endpoint')).trim();
  const typed = String(drafts[target]?.apiKey || '').trim();
  const asked = `${provider}|${endpoint}|${typed}`;
  modelLists[target] = { status: 'loading', list: modelLists[target]?.list || [], for: asked };
  render();
  const still = () => modelLists[target]?.for === asked && `${formValue(target, 'provider')}|${String(formValue(target, 'endpoint')).trim()}|${String(drafts[target]?.apiKey || '').trim()}` === asked;
  try {
    const models = await invoke('settings_list_models', { request: { target, provider, endpoint, apiKey: typed || null } });
    if (!still()) return;
    modelLists[target] = { status: 'done', list: models, for: asked };
  } catch (error) {
    if (!still()) return;
    modelLists[target] = { status: 'failed', list: [], error: error?.message || String(error), for: asked };
  }
  render();
}

function normalize(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

// Ownkey's dictionary rules: whitespace collapsed, and an entry with the same word or misspelling, ignoring case,
// is replaced rather than duplicated.
function addEntry() {
  const { vocabulary, corrections } = state.config.dictionary;
  const d = draft('dict');
  if (dictionary.correcting) {
    const from = normalize(d.from);
    const to = normalize(d.to);
    if (!from || !to) return dictionaryError('settings.dictionary.needBoth');
    if (from === to) return dictionaryError('settings.dictionary.identical');
    const next = corrections.filter((c) => c.from.toLowerCase() !== from.toLowerCase()).concat({ from, to });
    d.from = '';
    d.to = '';
    dictionary.error = '';
    setValue('dictionary.corrections', next).then(() => focusField('dict.from'));
  } else {
    const word = normalize(d.word);
    if (!word) return dictionaryError('settings.dictionary.needWord');
    const next = vocabulary.filter((w) => w.toLowerCase() !== word.toLowerCase()).concat(word);
    d.word = '';
    dictionary.error = '';
    setValue('dictionary.vocabulary', next).then(() => focusField('dict.word'));
  }
}

function dictionaryError(key) {
  dictionary.error = t(key);
  render();
}

function removeEntry(kind, value) {
  const { vocabulary, corrections } = state.config.dictionary;
  if (kind === 'word') setValue('dictionary.vocabulary', vocabulary.filter((w) => w !== value));
  else setValue('dictionary.corrections', corrections.filter((c) => c.from !== value));
}

function focusField(field) {
  page.querySelector(`[data-field="${field}"]`)?.focus();
}

let previewTimer = 0;
function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(async () => {
    const f = state.config.fillers;
    const custom = formValue('fillers', 'custom');
    const asked = JSON.stringify([f.enabled, f.languages, custom]);
    try {
      const text = await invoke('settings_clean_preview', { preview: { text: FILLER_SAMPLE, enabled: f.enabled, languages: f.languages, custom } });
      if (asked !== JSON.stringify([state.config.fillers.enabled, state.config.fillers.languages, formValue('fillers', 'custom')])) return;
      preview = { text, for: asked };
      render();
    } catch {
      // The preview is a nicety; the saved setting is what counts.
    }
  }, 150);
}

// ---------- actions ----------

async function act(action, button) {
  const [name, ...rest] = action.split(':');
  const arg = rest.join(':');
  switch (name) {
    case 'back':
      return back();
    case 'go':
      return go(arg);
    case 'toggle':
      if (arg === 'fillers.enabled') schedulePreview();
      return setValue(arg, !getPath(state.config, arg));
    case 'choose':
      return CHOICES[arg]?.();
    case 'seg': {
      const at = arg.lastIndexOf(':');
      return setValue(arg.slice(0, at), arg.slice(at + 1));
    }
    case 'filler-language': {
      const languages = state.config.fillers.languages;
      const next = languages.includes(arg) ? languages.filter((code) => code !== arg) : [...languages, arg];
      schedulePreview();
      return setValue('fillers.languages', next);
    }
    case 'save':
      return saveProvider(arg);
    case 'refresh':
      return refreshModels(arg);
    case 'replace-key':
      draft(arg).replacingKey = true;
      render();
      return focusField(`${arg}.apiKey`);
    case 'remove-key':
      try {
        await invoke('settings_remove_key', { target: arg });
        state.config[arg].keySaved = false;
        render();
      } catch (error) {
        await showError(t('settings.errors.failed'), error?.message);
      }
      return;
    case 'details':
      return showError(formStatus[arg]?.message || '', formStatus[arg]?.detail);
    case 'model': {
      const [id, what] = arg.split(':');
      const m = state.models[id];
      if (what === 'details') return showError(modelStatus(m).text, m.error);
      if (what === 'remove') {
        const ok = await dialog({
          title: t('settings.model.removeTitle', { model: m.name }),
          body: `<p>${esc(t('settings.model.removeBody'))}</p>`,
          buttons: [
            { label: t('common.cancel'), value: false },
            { label: t('settings.model.remove'), value: true, primary: true, danger: true }
          ]
        });
        if (!ok) return;
      }
      try {
        await invoke('settings_model', { model: id, action: what });
      } catch (error) {
        await showError(t('settings.errors.failed'), error?.message);
      }
      return;
    }
    case 'folder':
      try {
        await invoke('settings_choose_folder', { purpose: arg });
      } catch (error) {
        await showError(t('settings.errors.failed'), error?.message);
      }
      return;
    case 'folder-reset':
      return setValue('local.modelFolder', '');
    case 'open':
      return invoke('settings_open_folder', { folder: arg }).catch((error) => showError(t('settings.errors.failed'), error?.message));
    case 'link':
      return invoke('settings_open_link', { link: arg }).catch(() => {});
    case 'dict-mode':
      dictionary = { correcting: !dictionary.correcting, error: '' };
      render();
      return focusField(dictionary.correcting ? 'dict.from' : 'dict.word');
    case 'dict-add':
      return addEntry();
    case 'dict-remove': {
      const [kind, value] = arg.split(':');
      return removeEntry(kind, decodeURIComponent(value));
    }
    case 'updates-check':
      state.updates = { ...state.updates, state: 'checking' };
      render();
      try {
        state.updates = await invoke('settings_check_updates');
      } catch {
        state.updates = { state: 'failed', version: null };
      }
      return render();
    case 'new-token':
      button.disabled = true;
      try {
        await invoke('settings_new_token');
        tokenDone = true;
      } catch (error) {
        await showError(t('settings.errors.failed'), error?.message);
      }
      return render();
    case 'import':
      return runImport();
    case 'licenses':
      return licensesDialog();
    case 'sync-test':
      syncTest = { kind: 'testing' };
      render();
      try {
        await invoke('settings_sync_test');
        syncTest = { kind: 'ok' };
      } catch (error) {
        syncTest = { kind: 'failed', message: error?.message || String(error) };
      }
      return render();
  }
  return null;
}

async function runImport() {
  if (state.ownkey.lastImport) {
    const ok = await dialog({
      title: t('settings.import.confirmTitle'),
      body: `<p>${esc(t('settings.import.confirmBody'))}</p><p>${esc(t('settings.import.readOnly'))}</p>`,
      buttons: [
        { label: t('common.cancel'), value: false },
        { label: t('settings.import.again'), value: true, primary: true }
      ]
    });
    if (!ok) return;
  }
  importStatus = { kind: 'running' };
  render();
  try {
    await invoke('settings_import_ownkey');
    importStatus = null;
  } catch (error) {
    importStatus = { kind: 'failed', message: error?.message || String(error) };
  }
  render();
}

function licensesDialog() {
  const items = [
    esc(t('settings.licenses.inter')),
    `${esc(t('settings.licenses.orukeet'))} <button class="link-btn" data-link="orukeet">${icons.link}huggingface.co/oruk/orukeet</button>`,
    LATER ? `${esc(t('settings.licenses.nemotron'))} <button class="link-btn" data-link="nemotron">${icons.link}huggingface.co/nvidia</button>` : '',
    esc(t('settings.licenses.beautifulUi'))
  ].filter(Boolean);
  return dialog({
    title: t('settings.about.licenses'),
    body: `<ul class="license-list">${items.map((item) => `<li>${item}</li>`).join('')}</ul>`,
    buttons: [{ label: t('common.close'), value: true, primary: true }],
    onRender(body) {
      body.querySelectorAll('[data-link]').forEach((b) => b.addEventListener('click', () => invoke('settings_open_link', { link: b.dataset.link }).catch(() => {})));
    }
  });
}

function showError(message, detail) {
  return dialog({
    title: t('common.errorDetails'),
    body: `${message ? `<p>${esc(message)}</p>` : ''}${detail ? `<div class="detail">${esc(detail)}</div>` : ''}`,
    buttons: [{ label: t('common.close'), value: true, primary: true }]
  });
}

// Rukoo's dialog: a scrim, Escape and a click outside cancel, Tab stays inside.
function dialog({ title, body, buttons, onRender }) {
  return new Promise((resolve) => {
    const before = document.activeElement;
    const scrim = document.createElement('div');
    scrim.className = 'scrim';
    scrim.innerHTML = `<div class="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title">
      <h2 id="dialog-title">${esc(title)}</h2><div class="dialog-body">${body}</div>
      <div class="buttons">${buttons
        .map((b, i) => `<button class="btn ${b.primary ? 'primary' : 'secondary'} ${b.danger && !b.primary ? 'danger' : ''}" data-i="${i}">${esc(b.label)}</button>`)
        .join('')}</div></div>`;
    const done = (value) => {
      scrim.remove();
      document.removeEventListener('keydown', onKey, true);
      if (before && document.contains(before)) before.focus();
      resolve(value);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        done(null);
      }
      if (e.key === 'Tab') {
        const items = [...scrim.querySelectorAll('button, input, select')].filter((x) => !x.disabled);
        if (!items.length) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey, true);
    scrim.addEventListener('mousedown', (e) => e.target === scrim && done(null));
    scrim.querySelectorAll('.buttons button').forEach((b) => b.addEventListener('click', () => done(buttons[Number(b.dataset.i)].value)));
    document.body.append(scrim);
    if (onRender) onRender(scrim.querySelector('.dialog-body'), done);
    if (!scrim.contains(document.activeElement)) scrim.querySelector('.buttons .btn.primary, .buttons .btn:last-child')?.focus();
  });
}

// ---------- navigation ----------

function go(name, { anchor } = {}) {
  if (!PAGE_BUILDERS[name]) return;
  if (name !== current()) stack.push(name);
  dictionary.error = '';
  render({ full: true });
  page.classList.remove('entering');
  void page.offsetWidth;
  page.classList.add('entering');
  if (anchor) page.querySelector(`#group-${anchor}`)?.scrollIntoView({ block: 'start' });
}

function back() {
  if (stack.length > 1) {
    // Leaving a provider form without Save discards it, like Ownkey's Cancel.
    const form = { transcription: 'transcription', rewriting: 'rewriting', meetingTranscription: 'meetings' }[stack.pop()];
    if (form) {
      delete drafts[form];
      delete formStatus[form];
      delete modelLists[form];
    }
    render({ full: true });
    return;
  }
  invoke('settings_close').catch(() => {});
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !document.querySelector('.scrim')) {
    e.preventDefault();
    back();
  }
  if (e.key === 'Enter' && e.target.matches?.('[data-field^="dict."]')) {
    e.preventDefault();
    addEntry();
  }
});

page.addEventListener('click', (e) => {
  const target = e.target.closest('[data-a]');
  if (!target || target.disabled || !page.contains(target)) return;
  act(target.dataset.a, target);
});

page.addEventListener('input', (e) => {
  const field = e.target.dataset?.field;
  if (!field) return;
  const [form, ...rest] = field.split('.');
  const name = rest.join('.');
  if (e.target.type === 'checkbox') return;
  draft(form)[name] = e.target.value;
  if (form === 'local' && name === 'idleMinutes') {
    const minutes = Number(e.target.value);
    const bad = e.target.value === '' || !Number.isFinite(minutes) || minutes < 0 || minutes > 1440;
    if (bad !== idleError) {
      idleError = bad;
      render();
    }
  }
  if (form === 'fillers' && name === 'custom') schedulePreview();
});

page.addEventListener('change', (e) => {
  const field = e.target.dataset?.field;
  if (!field) return;
  const [form, ...rest] = field.split('.');
  const name = rest.join('.');
  if (field === 'meetings.consent') {
    const d = draft('meetings');
    d.consent = e.target.checked;
    d.consentFor = `${formValue('meetings', 'provider')}|${hostOf(formValue('meetings', 'endpoint'))}`;
    render();
    return;
  }
  // Fields that save on their own when they lose focus.
  const key = `${form}.${name}`;
  // The bucket secret never goes through settings_set; bucket sync is later than 0.1 and has no secret command yet.
  if (key === 'fillers.custom' || key === 'rewriting.instructions' || (key.startsWith('storage.sync.') && key !== 'storage.sync.secret')) {
    const value = e.target.value;
    delete drafts[form]?.[name];
    return setValue(key, value);
  }
  if (PROVIDER_FORMS.includes(form)) {
    if (name === 'provider') return providerChanged(form, e.target.value);
    draft(form)[name] = e.target.value;
    delete formStatus[form];
    // The consent text names the endpoint's host, so it follows the endpoint.
    return render();
  }
  if (key === 'local.idleMinutes') {
    if (idleError) return;
    delete drafts.local;
    return setValue(key, Math.round(Number(e.target.value)));
  }
});

// ---------- state from the app ----------

function applyState(next, { first = false } = {}) {
  // Each state has a seq of its own (API.md), so one that isn't newer is stale. That holds for the first
  // settings_state answer too: an event can arrive before it, with a newer state.
  if (!next || (state && next.seq <= state.seq)) return;
  // The first state shown, from either, draws the whole page.
  const full = first || !state;
  const relocalize = full || next.locale !== state.locale;
  const retheme = full || next.theme !== state.theme;
  state = next;
  if (retheme) {
    const root = document.documentElement;
    root.classList.add('theme-switching');
    root.classList.toggle('light', next.theme === 'light');
    requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove('theme-switching')));
  }
  if (relocalize) {
    setLanguage(next.locale);
    localize(document);
  }
  render({ full: relocalize });
}

async function start() {
  await connect('settings');
  await loadCatalogs();
  await listen('settings://state', (next) => applyState(next));
  applyState(await invoke('settings_state'), { first: true });
  // ?page=<page> opens a sub-page, ?page=<group> scrolls the top page to a group (status, dictation, meetings,
  // general, about). The app uses it to open Settings at the Ownkey import, for example.
  const wanted = params.get('page');
  if (wanted === 'meetingtranscription' || wanted === 'meeting-transcription') go('meetingTranscription');
  else if (PAGES.includes(wanted) && wanted !== 'main') go(wanted);
  else if (GROUP_ANCHORS.includes(wanted)) page.querySelector(`#group-${wanted}`)?.scrollIntoView({ block: 'start' });
  schedulePreview();
}

start().catch((error) => {
  console.error('settings: failed to start', error);
});
