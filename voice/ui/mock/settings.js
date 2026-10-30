// Mock of the app's side of Settings, for settings.html?mock=1. Not used inside the app. Paths and versions are
// made up; no real profile is read.
//
// settings.html?mock=1&page=<page>&theme=light|dark&lang=en|nl&scenario=<scenario>&later=1
//   <scenario>: default (set up, imported, Orukeet loaded), fresh (first start), busy (download running, Ownkey on
//   the same keys, Rukoo outdated), cloud (cloud meeting transcription without consent), failed (errors), dev
//   (development copy).

const MB = 1_000_000;
const NOW = Date.UTC(2026, 9, 30, 15, 42);

const PROVIDERS = {
  audio: [
    { id: 'openai', endpoints: ['https://api.openai.com/v1/audio/transcriptions'] },
    { id: 'google', endpoints: ['https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent'] },
    { id: 'mistral', endpoints: ['https://api.mistral.ai/v1/audio/transcriptions'] },
    { id: 'custom', endpoints: ['http://localhost:1234/v1/audio/transcriptions'] },
    { id: 'orukeet', endpoints: [] }
  ],
  rewrite: [
    { id: 'openai', endpoints: ['https://api.openai.com/v1/responses', 'https://api.openai.com/v1/chat/completions'] },
    { id: 'anthropic', endpoints: ['https://api.anthropic.com/v1/messages'] },
    { id: 'google', endpoints: ['https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent'] },
    { id: 'mistral', endpoints: ['https://api.mistral.ai/v1/chat/completions'] },
    { id: 'ollama', endpoints: ['http://localhost:11434/api/chat', 'https://ollama.com/api/chat'] },
    { id: 'openrouter', endpoints: ['https://openrouter.ai/api/v1/chat/completions'] },
    { id: 'custom', endpoints: ['http://localhost:1234/v1/chat/completions'] }
  ]
};

const MODELS = {
  mistral: ['voxtral-mini-latest', 'voxtral-small-latest', 'mistral-small-latest', 'mistral-medium-latest'],
  openai: ['gpt-4o-mini-transcribe', 'gpt-4o-transcribe', 'whisper-1', 'gpt-5.5-mini'],
  google: ['gemini-2.5-flash', 'gemini-2.5-pro'],
  anthropic: ['claude-haiku-4-5', 'claude-sonnet-4-5'],
  openrouter: ['mistralai/mistral-small', 'openai/gpt-4o-mini'],
  ollama: ['llama3.2:3b', 'qwen2.5:7b'],
  custom: []
};

// Ownkey's filler lists and protection table (text_cleanup.py), for a preview close to what the app returns.
const FILLERS = {
  en: ['uh', 'uhh', 'um', 'umm', 'uhm', 'erm', 'er', 'mhm'],
  nl: ['uh', 'uhm', 'eh', 'ehm', 'euh', 'euhm', 'hm'],
  de: ['äh', 'ähm', 'ehm', 'hm', 'mh'],
  fr: ['euh', 'heu', 'hum'],
  es: ['eh', 'em', 'ehm', 'este']
};
const PROTECTED = { en: [], nl: ['er', 'este'], de: ['um', 'er', 'este'], fr: ['este'], es: ['er'] };

function clean(text, { enabled, languages, custom }) {
  if (!enabled) return text;
  const protectedWords = new Set(languages.flatMap((code) => PROTECTED[code] || []));
  const words = new Set();
  for (const code of languages) for (const word of FILLERS[code] || []) if (!protectedWords.has(word)) words.add(word);
  for (const word of String(custom || '').split(/[,\n]/)) if (word.trim()) words.add(word.trim().toLowerCase());
  if (!words.size) return text;
  const alternatives = [...words].map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  let out = text.replace(new RegExp(`(^|[\\s,])(?:${alternatives})(?=[\\s,.!?]|$)[,]?`, 'giu'), '$1');
  out = out.replace(/\s{2,}/g, ' ').replace(/\s+([,.!?])/g, '$1').replace(/^[\s,]+/, '').replace(/,\s*,/g, ',');
  return out.replace(/(^|[.!?]\s+)(\p{Ll})/gu, (_, lead, c) => lead + c.toUpperCase());
}

function baseState() {
  return {
    seq: 1,
    version: '0.1.0',
    devMode: false,
    platform: 'windows',
    theme: 'dark',
    locale: 'en',
    config: {
      dictation: { hotkey: 'right alt', rewriteHotkey: 'right ctrl', pasteMode: true, readyChime: false, startAtLogin: true },
      transcription: { provider: 'orukeet', endpoint: '', model: 'orukeet-onnx-int8', language: 'auto', keySaved: false },
      local: { modelFolder: '', idleMinutes: 20 },
      dictionary: {
        vocabulary: ['Rukoo', 'Orukeet', 'Hermes', 'bvdm.ai', 'Keendoc'],
        corrections: [
          { from: 'rocco', to: 'Rukoo' },
          { from: 'own key', to: 'Ownkey' }
        ]
      },
      fillers: { enabled: true, languages: ['en', 'nl'], custom: '' },
      rewriting: {
        provider: 'mistral',
        endpoint: 'https://api.mistral.ai/v1/chat/completions',
        model: 'mistral-small-latest',
        keySaved: true,
        auto: false,
        tone: 'auto',
        formatting: true,
        instructions: ''
      },
      meetings: {
        provider: 'orukeet',
        endpoint: '',
        model: 'orukeet-onnx-int8',
        keySaved: false,
        consent: null,
        retention: 'days7',
        stopKey: 'off',
        screen: 'off',
        liveSpeakers: false
      },
      ui: { language: 'system', theme: 'system', pillEdge: 'bottom', hidePillFromCapture: true },
      updates: { check: false },
      storage: { sync: { enabled: false, service: 'upcloud', endpoint: '', region: '', bucket: '', prefix: 'meetings/', accessKeyId: '', secret: '' } }
    },
    providers: PROVIDERS,
    dictation: { status: 'ready' },
    rukoo: { state: 'connected', clientVersion: '2.2.0', protocol: 1, port: 49821, discoveryPath: 'C:\\Users\\you\\AppData\\Local\\Rukoo Voice\\bridge.json', behind: 0 },
    models: {
      orukeet: {
        id: 'orukeet',
        name: 'Orukeet',
        sizeBytes: 487 * MB,
        stage: 'installed',
        percent: null,
        location: 'ownkey',
        path: 'C:\\Users\\you\\AppData\\Local\\Ownkey\\models\\orukeet-onnx-int8',
        removable: false,
        active: 'loaded',
        error: null
      },
      nemotron: {
        id: 'nemotron',
        name: 'Nemotron 3 Diarization',
        sizeBytes: 107 * MB,
        stage: 'installed',
        percent: null,
        location: 'ownkey',
        path: 'C:\\Users\\you\\AppData\\Local\\Ownkey\\models\\nemotron-3-diarization',
        removable: false,
        active: null,
        error: null
      }
    },
    storage: { folder: 'C:\\Users\\you\\AppData\\Local\\Rukoo Voice\\meetings', usedBytes: 2.4e9, freeBytes: 182e9 },
    updates: { state: 'idle', version: null },
    ownkey: {
      running: false,
      keys: ['right alt', 'right ctrl'],
      configFound: true,
      configPath: '%APPDATA%\\Ownkey\\config.json',
      lastImport: NOW - 3 * 86_400_000,
      models: [
        { id: 'orukeet', name: 'Orukeet', sizeBytes: 487 * MB },
        { id: 'nemotron', name: 'Nemotron', sizeBytes: 107 * MB }
      ],
      report: {
        hotkeys: { dictation: 'right alt', rewrite: 'right ctrl' },
        transcription: { provider: 'orukeet', model: 'orukeet-onnx-int8', keyImported: false },
        rewriting: { provider: 'mistral', model: 'mistral-small-latest', keyImported: true },
        dictionary: { words: 5, corrections: 2 },
        fillers: { enabled: true, languages: ['en', 'nl'] },
        meetings: { provider: 'orukeet', keyImported: false, retention: 'days7', consent: false },
        skipped: ['summaries']
      }
    },
    sync: { lastUpload: null, waiting: 0 }
  };
}

const SCENARIOS = {
  default: () => {},
  fresh: (s) => {
    s.config.transcription = { provider: 'orukeet', endpoint: '', model: 'orukeet-onnx-int8', language: 'auto', keySaved: false };
    s.config.dictionary = { vocabulary: [], corrections: [] };
    s.config.rewriting.keySaved = false;
    s.dictation.status = 'modelMissing';
    s.rukoo = { ...s.rukoo, state: 'notRunning', clientVersion: null, protocol: null, behind: null };
    Object.assign(s.models.orukeet, { stage: 'missing', location: null, path: null, active: null });
    s.ownkey = { ...s.ownkey, lastImport: null, report: null, models: [] };
  },
  busy: (s) => {
    s.ownkey.running = true;
    s.dictation.status = 'loadingModel';
    s.rukoo = { ...s.rukoo, state: 'rukooOutdated', clientVersion: '2.1.2', protocol: null };
    s.config.local.modelFolder = 'D:\\Models\\Voice';
    Object.assign(s.models.orukeet, { stage: 'downloading', percent: 42, location: 'folder', path: 'D:\\Models\\Voice\\orukeet-onnx-int8', active: null, removable: false });
    s.updates = { state: 'available', version: '0.2.0' };
  },
  cloud: (s) => {
    s.config.transcription = { provider: 'openai', endpoint: 'https://api.openai.com/v1/audio/transcriptions', model: 'gpt-4o-mini-transcribe', language: 'nl', keySaved: true };
    s.config.meetings = { ...s.config.meetings, provider: 'mistral', endpoint: 'https://api.mistral.ai/v1/audio/transcriptions', model: 'voxtral-mini-latest', keySaved: true, consent: null };
    s.config.rewriting.auto = true;
    Object.assign(s.models.orukeet, { active: null });
    s.ownkey.report.meetings = { provider: 'mistral', keyImported: true, retention: 'keep', consent: false };
    s.ownkey.report.transcription = { provider: 'openai', model: 'gpt-4o-mini-transcribe', keyImported: true };
  },
  failed: (s) => {
    s.dictation.status = 'noKey';
    s.rukoo = { ...s.rukoo, state: 'refused', clientVersion: null, protocol: null, behind: null };
    s.config.local.modelFolder = '';
    Object.assign(s.models.orukeet, {
      stage: 'failed',
      percent: null,
      location: null,
      path: null,
      active: null,
      error: 'Checksum mismatch for encoder.int8.onnx: expected 7f3a…c01e, got 0b9d…44a2. The download may be damaged; try again.'
    });
    s.updates = { state: 'failed', version: null };
  },
  dev: (s) => {
    s.devMode = true;
    s.version = '0.1.0-dev';
    s.config.dictation = { ...s.config.dictation, hotkey: 'f13', rewriteHotkey: 'f14', startAtLogin: false };
    s.rukoo.discoveryPath = 'E:\\Development\\rukoo\\tmp\\voice-dev\\bridge.json';
    s.storage.folder = 'E:\\Development\\rukoo\\tmp\\voice-dev\\meetings';
    s.ownkey = { ...s.ownkey, lastImport: null, report: null };
  }
};

export function createMock(params) {
  const state = baseState();
  (SCENARIOS[params.get('scenario')] || SCENARIOS.default)(state);
  if (params.get('sync') === '1') state.config.storage.sync = { ...state.config.storage.sync, enabled: true, endpoint: 'https://example.upcloudobjects.com', region: 'europe-1', bucket: 'my-meetings' };
  const forced = { theme: params.get('theme'), locale: params.get('lang') };
  const handlers = [];
  let downloadTimer = 0;

  const resolve = () => {
    const ui = state.config.ui;
    state.theme = ui.theme === 'system' ? (forced.theme === 'light' ? 'light' : forced.theme === 'dark' ? 'dark' : matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : ui.theme;
    state.locale = ui.language === 'system' ? (forced.locale === 'nl' ? 'nl' : forced.locale === 'en' ? 'en' : navigator.language.startsWith('nl') ? 'nl' : 'en') : ui.language;
  };
  resolve();

  const snapshot = () => structuredClone(state);
  // For dev/check.js: what the app would hold now.
  window.__settingsMockState = snapshot;
  const emit = () => {
    state.seq += 1;
    const copy = snapshot();
    handlers.forEach((handler) => handler(copy));
  };
  const wait = (ms) => new Promise((done) => setTimeout(done, ms));
  // Tauri rejects a failed command with the command's error value; API.md defines it as { code, message }.
  const fail = (code, message) => {
    throw { code, message };
  };
  const setPath = (key, value) => {
    const parts = key.split('.');
    const last = parts.pop();
    parts.reduce((o, p) => o[p], state.config)[last] = value;
  };
  const getPath = (key) => key.split('.').reduce((o, p) => o?.[p], state.config);
  const host = (url) => {
    try {
      return new URL(url).hostname.toLowerCase();
    } catch {
      return '';
    }
  };

  function download(id) {
    const m = state.models[id];
    Object.assign(m, { stage: 'downloading', percent: 0, error: null });
    emit();
    clearInterval(downloadTimer);
    downloadTimer = setInterval(() => {
      if (m.stage === 'downloading') m.percent = Math.min(100, m.percent + 7);
      if (m.stage === 'downloading' && m.percent >= 100) Object.assign(m, { stage: 'verifying', percent: null });
      else if (m.stage === 'verifying') Object.assign(m, { stage: 'extracting', percent: null });
      else if (m.stage === 'extracting') {
        Object.assign(m, { stage: 'installed', percent: null, location: 'voice', removable: true, path: 'C:\\Users\\you\\AppData\\Local\\Rukoo Voice\\models\\orukeet-onnx-int8' });
        if (state.config.transcription.provider === 'orukeet') {
          m.active = 'unloaded';
          state.dictation.status = 'ready';
        }
        clearInterval(downloadTimer);
      }
      emit();
    }, 300);
  }

  const commands = {
    settings_state: () => snapshot(),
    settings_set: ({ key, value }) => {
      const roles = ['dictation.hotkey', 'dictation.rewriteHotkey', 'meetings.stopKey'];
      if (roles.includes(key) && value !== 'off' && roles.some((role) => role !== key && getPath(role) === value)) fail('same_key', `${value} is already in use`);
      if (key === 'dictation.startAtLogin' && state.devMode) fail('dev_mode', 'Autostart is never registered in development mode.');
      setPath(key, value);
      if (key.startsWith('ui.')) resolve();
      emit();
      return null;
    },
    settings_save_provider: async ({ save }) => {
      window.__lastSave = structuredClone(save);
      await wait(save.provider === 'orukeet' ? 1200 : 500);
      if (save.provider !== 'orukeet' && (!save.endpoint || !save.model)) fail('need_endpoint_model', 'Choose an endpoint and model before saving.');
      if (save.provider !== 'orukeet' && save.model === 'fail') fail('failed', 'HTTP 401 from api.mistral.ai: Unauthorized. Check the API key.');
      const target = state.config[save.target];
      const sameProvider = target.provider === save.provider;
      Object.assign(target, { provider: save.provider, endpoint: save.endpoint, model: save.model });
      target.keySaved = save.apiKey === null ? sameProvider && target.keySaved : Boolean(save.apiKey);
      if (save.language) target.language = save.language;
      if (save.target === 'meetings') target.consent = save.consent ? { provider: save.provider, host: host(save.endpoint) } : null;
      if (save.target === 'transcription') {
        state.models.orukeet.active = save.provider === 'orukeet' && state.models.orukeet.stage === 'installed' ? 'loaded' : null;
        state.dictation.status =
          save.provider === 'orukeet' ? (state.models.orukeet.stage === 'installed' ? 'ready' : 'modelMissing') : target.keySaved ? 'ready' : 'noKey';
      }
      emit();
      return null;
    },
    settings_remove_key: ({ target }) => {
      state.config[target].keySaved = false;
      emit();
      return null;
    },
    settings_list_models: async ({ request }) => {
      await wait(700);
      if (!request.endpoint) fail('config', 'Choose an endpoint first.');
      return MODELS[request.provider] || [];
    },
    settings_model: ({ model, action }) => {
      const m = state.models[model];
      if (action === 'download') download(model);
      if (action === 'cancel') {
        clearInterval(downloadTimer);
        Object.assign(m, { stage: 'missing', percent: null });
        emit();
      }
      if (action === 'remove') {
        if (!m.removable) fail('not_removable', 'This model belongs to Ownkey; remove it in Ownkey.');
        Object.assign(m, { stage: 'missing', location: null, path: null, removable: false });
        emit();
      }
      return null;
    },
    settings_choose_folder: ({ purpose }) => {
      if (purpose === 'models') state.config.local.modelFolder = 'D:\\Models\\Voice';
      else state.storage.folder = 'D:\\Meetings';
      emit();
      return purpose === 'models' ? 'D:\\Models\\Voice' : 'D:\\Meetings';
    },
    settings_open_folder: () => null,
    settings_open_link: () => null,
    settings_clean_preview: ({ preview }) => clean(preview.text, preview),
    settings_check_updates: async () => {
      await wait(900);
      state.updates = { state: 'upToDate', version: null };
      emit();
      return structuredClone(state.updates);
    },
    settings_new_token: async () => {
      await wait(300);
      return null;
    },
    settings_import_ownkey: async () => {
      if (state.devMode) fail('dev_mode', 'In development, the import runs only with --import-ownkey <copy>.');
      await wait(600);
      state.ownkey.lastImport = Date.now();
      state.ownkey.report ||= baseState().ownkey.report;
      emit();
      return structuredClone(state.ownkey.report);
    },
    settings_sync_test: async () => {
      await wait(600);
      if (!state.config.storage.sync.bucket) fail('config', 'Fill in the bucket first.');
      return null;
    },
    settings_close: () => null
  };

  return {
    invoke: async (command, args = {}) => {
      if (!(command in commands)) throw { code: 'unknown_command', message: `mock: unknown command ${command}` };
      return commands[command](args);
    },
    listen: async (name, handler) => {
      if (name === 'settings://state') handlers.push(handler);
      return () => {};
    }
  };
}
