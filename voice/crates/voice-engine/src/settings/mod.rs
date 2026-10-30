//! Settings as voice/ui/API.md defines it: the `SettingsState` JSON, and every `settings_*`
//! command on top of voice-core's `Config`.
//!
//! The page uses dotted keys (`dictation.hotkey`); `config.json` keeps Ownkey's flat keys
//! (`hotkey`). [`keys`] maps between them and checks every value.

pub mod keys;
pub mod ownkey;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use voice_core::cleanup::{self, CleanupConfig};
use voice_core::config::{provider_form_problem, Config, Consent, LANGUAGES};
use voice_core::local::{self, LocalState, Location, ModelErrorKind, ModelSpec, Stage};
use voice_core::providers::{
    normalize_provider, provider_endpoints, Activity, ProviderConfig, Purpose, AUDIO_PROVIDER_IDS,
    MODELS_TIMEOUT, ORUKEET_MODEL_ID, REWRITE_PROVIDER_IDS,
};
use voice_core::{ErrorKind, ProviderError};

use crate::api::{ApiError, Folder, Locale, Theme};
use crate::engine::{lock, Core};

/// Download progress goes out at most ten times a second (API.md).
const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);
/// Slow parts of the state (folder sizes, Ownkey's files and process) are read this often.
const SLOW_REFRESH: Duration = Duration::from_secs(10);

/// The models Settings shows.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Model {
    Orukeet,
    Nemotron,
}

impl Model {
    pub fn parse(id: &str) -> Option<Model> {
        match id {
            "orukeet" => Some(Model::Orukeet),
            "nemotron" => Some(Model::Nemotron),
            _ => None,
        }
    }

    pub fn id(self) -> &'static str {
        match self {
            Model::Orukeet => "orukeet",
            Model::Nemotron => "nemotron",
        }
    }

    pub fn spec(self) -> ModelSpec {
        match self {
            Model::Orukeet => ModelSpec::orukeet(),
            Model::Nemotron => ModelSpec::nemotron(),
        }
    }
}

#[derive(Default)]
struct Download {
    stage: Option<&'static str>,
    percent: Option<u64>,
    error: Option<String>,
    cancel: Arc<AtomicBool>,
    running: bool,
}

#[derive(Clone)]
struct Slow {
    at: Instant,
    used_bytes: u64,
    ownkey_running: bool,
    ownkey_keys: Vec<String>,
    ownkey_found: bool,
}

/// Settings' state that isn't in `config.json`.
#[derive(Default)]
pub struct SettingsRuntime {
    downloads: Mutex<HashMap<Model, Download>>,
    updates: Mutex<(String, Option<String>)>,
    slow: Mutex<Option<Slow>>,
    start_page: Mutex<Option<String>>,
    last_progress: Mutex<Option<Instant>>,
}

impl SettingsRuntime {
    pub fn new(start_page: Option<String>) -> SettingsRuntime {
        SettingsRuntime {
            updates: Mutex::new(("idle".into(), None)),
            start_page: Mutex::new(start_page),
            ..SettingsRuntime::default()
        }
    }

    /// The page Settings opens at, once: the import after the first start.
    pub fn take_start_page(&self) -> Option<String> {
        lock(&self.start_page).take()
    }

    /// The next state reads folder sizes and Ownkey's files again.
    pub fn forget_storage(&self) {
        lock(&self.slow).take();
    }
}

fn invalid(message: impl Into<String>) -> ApiError {
    ApiError::new("invalid_value", message)
}

pub fn provider_error(error: &ProviderError) -> ApiError {
    let code = match error.kind {
        ErrorKind::Auth => "auth",
        ErrorKind::Network => "network",
        ErrorKind::Timeout => "timeout",
        ErrorKind::Provider => "provider",
        ErrorKind::Config => "config",
        ErrorKind::LocalMissingModel => "failed",
    };
    ApiError::new(code, error.message.clone())
}

// The state --------------------------------------------------------------------------------

pub fn state(core: &Core) -> Value {
    let cfg = core.config();
    let looks = core.looks();
    let start_at_login = !core.opts.dev_mode && core.svc.autostart.is_on();
    let slow = slow(core);
    let (update_state, update_version) = lock(&core.settings.updates).clone();
    json!({
        "seq": core.settings_seq.load(Ordering::SeqCst),
        "version": core.opts.version,
        "devMode": core.opts.dev_mode,
        "platform": platform(),
        "theme": match looks.theme { Theme::Light => "light", Theme::Dark => "dark" },
        "locale": match looks.locale { Locale::En => "en", Locale::Nl => "nl" },
        "config": keys::view(&cfg, start_at_login),
        "providers": providers(),
        "dictation": { "status": dictation_status(core, &cfg) },
        "rukoo": rukoo(core),
        "models": {
            "orukeet": model_state(core, &cfg, Model::Orukeet),
            "nemotron": model_state(core, &cfg, Model::Nemotron),
        },
        "storage": {
            "folder": core.meetings.library().root().display().to_string(),
            "usedBytes": slow.used_bytes,
            "freeBytes": core.svc.system.free_bytes(core.meetings.library().root()).unwrap_or(0),
        },
        "updates": { "state": update_state, "version": update_version },
        "ownkey": ownkey::state(core, &cfg, &slow.ownkey_keys, slow.ownkey_found, slow.ownkey_running),
        "sync": { "lastUpload": null, "waiting": 0 },
    })
}

fn platform() -> &'static str {
    if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    }
}

fn slow(core: &Core) -> Slow {
    let mut cached = lock(&core.settings.slow);
    if let Some(slow) = cached.as_ref().filter(|s| s.at.elapsed() < SLOW_REFRESH) {
        return slow.clone();
    }
    let (ownkey_found, ownkey_keys) = ownkey::keys(core);
    let slow = Slow {
        at: Instant::now(),
        used_bytes: core.meetings.library().usage_bytes(),
        ownkey_running: core.svc.system.ownkey_running(),
        ownkey_keys,
        ownkey_found,
    };
    *cached = Some(slow.clone());
    slow
}

/// voice-core's registry in Ownkey's order (ownkey-providers.md 2).
pub fn providers() -> Value {
    let list = |ids: &[&str], activity: Activity| -> Vec<Value> {
        ids.iter()
            .map(|id| json!({ "id": id, "endpoints": provider_endpoints(id, activity) }))
            .collect()
    };
    json!({
        "audio": list(&AUDIO_PROVIDER_IDS, Activity::Audio),
        "rewrite": list(&REWRITE_PROVIDER_IDS, Activity::Rewrite),
    })
}

fn dictation_status(core: &Core, cfg: &Config) -> &'static str {
    let audio = cfg.dictation_audio();
    if audio.provider == "orukeet" {
        if core.registry(cfg).locate(&ModelSpec::orukeet()).is_none() {
            return "modelMissing";
        }
        if core.svc.speech.local_status().state == LocalState::Loading {
            return "loadingModel";
        }
    } else if voice_core::providers::provider_requires_key(&audio.provider, &audio.endpoint)
        && audio.api_key.trim().is_empty()
    {
        return "noKey";
    }
    if core.dictation.mic_error().is_some() {
        return "noMic";
    }
    "ready"
}

fn rukoo(core: &Core) -> Value {
    let connected = core.meetings.rukoo_connected();
    let bridge = core.meetings.bridge.as_ref();
    json!({
        "state": if connected { "connected" } else { "notRunning" },
        "clientVersion": null,
        "protocol": if connected { json!(voice_protocol::PROTOCOL) } else { Value::Null },
        "port": bridge.and_then(|b| b.port()),
        "discoveryPath": bridge.map(|b| b.discovery_path().display().to_string()),
        "behind": null,
    })
}

fn model_state(core: &Core, cfg: &Config, model: Model) -> Value {
    let spec = model.spec();
    let located = core.registry(cfg).locate(&spec);
    let downloads = lock(&core.settings.downloads);
    let download = downloads.get(&model);
    let active_status = (model == Model::Orukeet && cfg.audio_provider == "orukeet")
        .then(|| core.svc.speech.local_status());
    let stage = match download.and_then(|d| d.stage) {
        Some(stage) => stage,
        None if located.is_some() => "installed",
        None if download.is_some_and(|d| d.error.is_some()) => "failed",
        None => "missing",
    };
    let error = download
        .and_then(|d| d.error.clone())
        .or_else(|| active_status.as_ref().and_then(|s| s.error.clone()));
    json!({
        "id": model.id(),
        "name": if model == Model::Orukeet { "Orukeet" } else { spec.label.as_str() },
        "sizeBytes": spec.archive.as_ref().map_or_else(|| spec.extracted_size(), |a| a.size),
        "stage": stage,
        "percent": download.and_then(|d| d.percent),
        "location": located.as_ref().map(|l| match l.location {
            Location::Custom => "folder",
            Location::Ownkey => "ownkey",
            Location::Voice => "voice",
        }),
        "path": located.as_ref().map(|l| l.dir.display().to_string()),
        "removable": located.as_ref().is_some_and(local::Located::removable),
        "active": active_status.map(|s| match s.state {
            LocalState::Unloaded => "unloaded",
            LocalState::Loading => "loading",
            LocalState::Loaded => "loaded",
            LocalState::Error => "error",
        }),
        "error": error,
    })
}

// Commands ---------------------------------------------------------------------------------

pub fn set(core: &Arc<Core>, key: &str, value: Value) -> Result<(), ApiError> {
    if key == "dictation.startAtLogin" {
        if core.opts.dev_mode {
            return Err(ApiError::new(
                "dev_mode",
                "A development copy never starts at login.",
            ));
        }
        let on = value
            .as_bool()
            .ok_or_else(|| invalid("Start at login takes true or false."))?;
        core.svc
            .autostart
            .set(on)
            .map_err(|e| ApiError::new("failed", e))?;
        core.settings_changed();
        return Ok(());
    }
    core.commit(|cfg| keys::set(cfg, key, value))
}

/// One provider form, checked and saved as a whole (ownkey-dictation.md 13.8).
pub fn save_provider(core: &Arc<Core>, save: Value) -> Result<(), ApiError> {
    let text = |name: &str| save[name].as_str().unwrap_or_default().trim().to_string();
    let target = text("target");
    let (purpose, allowed): (Purpose, &[&str]) = match target.as_str() {
        "transcription" => (Purpose::Dictation, &AUDIO_PROVIDER_IDS),
        "meetings" => (Purpose::Meetings, &AUDIO_PROVIDER_IDS),
        "rewriting" => (Purpose::Rewrite, &REWRITE_PROVIDER_IDS),
        _ => return Err(invalid("target is transcription, rewriting or meetings.")),
    };
    let provider = normalize_provider(&text("provider"), "");
    if !allowed.contains(&provider.as_str()) {
        return Err(invalid(format!("{provider:?} isn't offered here.")));
    }
    let local = provider == "orukeet";
    let (endpoint, model) = if local {
        (String::new(), ORUKEET_MODEL_ID.to_string())
    } else {
        (text("endpoint"), text("model"))
    };
    if let Some(problem) = provider_form_problem(purpose, &provider, &endpoint, &model) {
        return Err(ApiError::new("need_endpoint_model", problem));
    }
    let api_key = match &save["apiKey"] {
        Value::Null => None,
        Value::String(key) => Some(key.trim().to_string()),
        _ => return Err(invalid("apiKey is null or a string.")),
    };
    let language = match save.get("language") {
        Some(Value::String(language)) if purpose == Purpose::Dictation => {
            let language = language.trim().to_lowercase();
            if !LANGUAGES.contains(&language.as_str()) {
                return Err(invalid(format!(
                    "{language:?} isn't a language Voice offers."
                )));
            }
            Some(language)
        }
        _ => None,
    };
    let consent = save["consent"].as_bool().unwrap_or(false);

    let current = core.config();
    let mut next = (*current).clone();
    // A key is never carried to another provider: `null` keeps it only for the same one.
    let keep = |saved_provider: &str, saved_key: &str| match &api_key {
        None if saved_provider == provider => saved_key.to_string(),
        None => String::new(),
        Some(key) => key.clone(),
    };
    match purpose {
        Purpose::Dictation => {
            next.audio_api_key = if local {
                String::new()
            } else {
                keep(&current.audio_provider, &current.audio_api_key)
            };
            next.audio_provider = provider.clone();
            next.audio_endpoint = endpoint.clone();
            next.audio_model = model.clone();
            // Orukeet ignores the language; Ownkey saved it only for a cloud provider.
            if let Some(language) = language.filter(|_| !local) {
                next.language = language;
            }
        }
        Purpose::Rewrite => {
            next.rewrite_api_key = keep(&current.rewrite_provider, &current.rewrite_api_key);
            next.rewrite_provider = provider.clone();
            next.rewrite_endpoint = endpoint.clone();
            next.rewrite_model = model.clone();
        }
        Purpose::Meetings => {
            next.meetings_audio_api_key = if local {
                String::new()
            } else {
                keep(
                    &current.meetings_audio_provider,
                    &current.meetings_audio_api_key,
                )
            };
            next.meetings_audio_provider = provider.clone();
            next.meetings_audio_endpoint = endpoint.clone();
            next.meetings_audio_model = model.clone();
            next.meetings_transcription_consent = None;
            if consent {
                // Stored only where Ownkey's rule asks for it: a cloud provider on another host.
                next.grant_meeting_consent();
            }
        }
    }
    // A broken model never becomes active: Orukeet loads and is checked before the save.
    if purpose == Purpose::Dictation && local {
        core.svc
            .speech
            .local_load(core.registry(&next))
            .map_err(|e| provider_error(&e))?;
    }
    core.commit(move |cfg| {
        *cfg = next;
        Ok(())
    })
}

pub fn remove_key(core: &Arc<Core>, target: &str) -> Result<(), ApiError> {
    core.commit(|cfg| {
        match target {
            "transcription" => cfg.audio_api_key.clear(),
            "rewriting" => cfg.rewrite_api_key.clear(),
            "meetings" => cfg.meetings_audio_api_key.clear(),
            _ => return Err(invalid("target is transcription, rewriting or meetings.")),
        }
        Ok(())
    })
}

pub fn list_models(core: &Arc<Core>, request: Value) -> Result<Vec<String>, ApiError> {
    let text = |name: &str| {
        request[name]
            .as_str()
            .unwrap_or_default()
            .trim()
            .to_string()
    };
    let target = text("target");
    let cfg = core.config();
    let (activity, purpose, saved_provider, saved_key) = match target.as_str() {
        "transcription" => (
            Activity::Audio,
            Purpose::Dictation,
            &cfg.audio_provider,
            &cfg.audio_api_key,
        ),
        "meetings" => (
            Activity::Audio,
            Purpose::Meetings,
            &cfg.meetings_audio_provider,
            &cfg.meetings_audio_api_key,
        ),
        "rewriting" => (
            Activity::Rewrite,
            Purpose::Rewrite,
            &cfg.rewrite_provider,
            &cfg.rewrite_api_key,
        ),
        _ => return Err(invalid("target is transcription, rewriting or meetings.")),
    };
    let provider = normalize_provider(&text("provider"), "");
    if provider == "orukeet" {
        return Ok(vec![ORUKEET_MODEL_ID.to_string()]);
    }
    let endpoint = text("endpoint");
    if endpoint.is_empty() {
        return Err(ApiError::new("config", "Choose an endpoint first."));
    }
    let api_key = match &request["apiKey"] {
        Value::String(key) => key.trim().to_string(),
        _ if *saved_provider == provider => saved_key.clone(),
        _ => String::new(),
    };
    let provider_cfg = ProviderConfig {
        provider,
        api_key,
        endpoint,
        model: String::new(),
        timeout: MODELS_TIMEOUT,
        purpose,
    };
    let mut models = core
        .svc
        .speech
        .list_models(activity, &provider_cfg)
        .map_err(|e| provider_error(&e))?;
    models.sort_by_key(|m| m.to_lowercase());
    models.dedup();
    Ok(models)
}

pub fn model(core: &Arc<Core>, id: &str, action: &str) -> Result<(), ApiError> {
    let model =
        Model::parse(id).ok_or_else(|| ApiError::new("not_found", format!("No model {id:?}.")))?;
    match action {
        "download" => download(core, model),
        "cancel" => {
            if let Some(download) = lock(&core.settings.downloads).get(&model) {
                download.cancel.store(true, Ordering::SeqCst);
            }
            Ok(())
        }
        "remove" => remove(core, model),
        _ => Err(invalid("action is download, cancel or remove.")),
    }
}

fn download(core: &Arc<Core>, model: Model) -> Result<(), ApiError> {
    if model == Model::Nemotron {
        return Err(invalid("Speaker labels come in a later version of Voice."));
    }
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut downloads = lock(&core.settings.downloads);
        let entry = downloads.entry(model).or_default();
        if entry.running {
            return Ok(());
        }
        *entry = Download {
            stage: Some("downloading"),
            percent: Some(0),
            error: None,
            cancel: Arc::clone(&cancel),
            running: true,
        };
    }
    core.settings_changed();
    let core = Arc::clone(core);
    thread::Builder::new()
        .name("model-download".into())
        .spawn(move || {
            let cfg = core.config();
            let registry = core.registry(&cfg);
            let spec = model.spec();
            let mut progress = |p: local::Progress| {
                let stage = match p.stage {
                    Stage::Downloading => "downloading",
                    Stage::Verifying => "verifying",
                    Stage::Extracting => "extracting",
                    Stage::Installed => "installed",
                };
                let percent = p
                    .total
                    .filter(|t| *t > 0)
                    .map(|t| (p.done.min(t) * 100) / t);
                let changed = {
                    let mut downloads = lock(&core.settings.downloads);
                    let entry = downloads.entry(model).or_default();
                    let changed = entry.stage != Some(stage);
                    entry.stage = Some(stage);
                    entry.percent = percent;
                    changed
                };
                let mut last = lock(&core.settings.last_progress);
                if changed || last.is_none_or(|at| at.elapsed() >= PROGRESS_INTERVAL) {
                    *last = Some(Instant::now());
                    drop(last);
                    core.settings_changed();
                }
            };
            let result = core
                .svc
                .speech
                .download(&registry, &spec, &mut progress, &cancel);
            {
                let mut downloads = lock(&core.settings.downloads);
                let entry = downloads.entry(model).or_default();
                entry.running = false;
                entry.stage = None;
                entry.percent = None;
                entry.error = match result {
                    Ok(_) => None,
                    Err(e) if e.kind == ModelErrorKind::Cancelled => None,
                    Err(e) => Some(e.message),
                };
            }
            let cfg = core.config();
            core.svc
                .speech
                .local_configure(core.registry(&cfg), cfg.idle_timeout());
            core.settings_changed();
        })
        .map_err(|e| ApiError::new("failed", e.to_string()))?;
    Ok(())
}

fn remove(core: &Arc<Core>, model: Model) -> Result<(), ApiError> {
    let cfg = core.config();
    let registry = core.registry(&cfg);
    let spec = model.spec();
    let Some(located) = registry.locate(&spec) else {
        return Err(ApiError::new(
            "not_removable",
            "There is no download to remove.",
        ));
    };
    if !located.removable() {
        // Decision 13: Voice never removes anything in Ownkey's folder or a folder the user chose.
        let message = match located.location {
            Location::Ownkey => "This model belongs to Ownkey. Remove it in Ownkey.",
            _ => "This model is in the folder you chose. Voice doesn't remove it.",
        };
        return Err(ApiError::new("not_removable", message));
    }
    if model == Model::Orukeet {
        core.svc.speech.local_unload();
    }
    registry
        .remove(&spec)
        .map_err(|e| ApiError::new("failed", e.message))?;
    core.settings_changed();
    Ok(())
}

pub fn set_folder(core: &Arc<Core>, purpose: &str, path: PathBuf) -> Result<(), ApiError> {
    match purpose {
        "models" => core.commit(|cfg| {
            cfg.local_model_directory = path.display().to_string();
            Ok(())
        }),
        // Meetings live in the data folder (voice/RECORDING.md); voice-meetings opens them there.
        "recordings" => Err(invalid(
            "Meetings are kept in Voice's data folder in this version.",
        )),
        _ => Err(invalid("purpose is models or recordings.")),
    }
}

pub fn clean_preview(core: &Arc<Core>, preview: Value) -> Result<String, ApiError> {
    let text = preview["text"]
        .as_str()
        .ok_or_else(|| invalid("text is a string."))?;
    let languages = keys::filler_languages(&preview["languages"])?;
    let cfg = core.config();
    Ok(cleanup::clean(
        text,
        &CleanupConfig {
            remove_fillers: preview["enabled"].as_bool().unwrap_or(true),
            filler_languages: languages,
            custom_fillers: preview["custom"].as_str().unwrap_or_default().to_string(),
            corrections: cfg.corrections.clone(),
        },
    ))
}

/// Checks now, also when the daily check is off, because the user asked.
pub fn check_updates(core: &Arc<Core>) -> Value {
    *lock(&core.settings.updates) = ("checking".into(), None);
    core.settings_changed();
    let result = core.svc.updates.check(&core.opts.version);
    let next = match result {
        Ok(Some(version)) => ("available".to_string(), Some(version)),
        Ok(None) => ("upToDate".to_string(), None),
        Err(_) => ("failed".to_string(), None),
    };
    *lock(&core.settings.updates) = next.clone();
    core.settings_changed();
    json!({ "state": next.0, "version": next.1 })
}

/// How often the scheduler asks whether the daily check is due.
const UPDATE_SCHEDULE: Duration = Duration::from_secs(60);

/// The opt-in daily check: nothing touches the network unless `updates.check` is on. The last
/// check is kept in memory, so a new start checks once and then daily.
pub fn schedule_updates(core: std::sync::Weak<Core>) {
    let mut last: Option<u64> = None;
    loop {
        let deadline = Instant::now() + UPDATE_SCHEDULE;
        while Instant::now() < deadline {
            thread::sleep(Duration::from_millis(250));
            match core.upgrade() {
                Some(core) if !core.shutting_down() => {}
                _ => return,
            }
        }
        let Some(core) = core.upgrade() else {
            return;
        };
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_millis() as u64);
        if voice_core::update::is_due(&core.config(), last, now) {
            last = Some(now);
            check_updates(&core);
        }
    }
}

pub fn new_token(core: &Arc<Core>) -> Result<(), ApiError> {
    let bridge = core
        .meetings
        .bridge
        .as_ref()
        .ok_or_else(|| ApiError::new("failed", "The bridge for Rukoo isn't running."))?;
    bridge
        .new_token()
        .map_err(|e| ApiError::new("failed", format!("The bridge couldn't restart: {e}")))?;
    core.settings_changed();
    Ok(())
}

pub fn import_ownkey(core: &Arc<Core>) -> Result<Value, ApiError> {
    if core.opts.dev_mode {
        return Err(ApiError::new(
            "dev_mode",
            "A development copy imports Ownkey's settings only with --import-ownkey <copy>.",
        ));
    }
    let path = core
        .svc
        .ownkey_config
        .clone()
        .ok_or_else(|| ApiError::new("not_found", "Ownkey's settings weren't found."))?;
    ownkey::import_into(core, &path)
}

pub fn folder_path(core: &Core, folder: Folder) -> Option<PathBuf> {
    let data = &core.opts.data_dir;
    Some(match folder {
        Folder::Logs => voice_core::paths::logs_dir(data),
        Folder::Recordings => core.meetings.library().root().to_path_buf(),
        Folder::Bridge => core
            .meetings
            .bridge
            .as_ref()?
            .discovery_path()
            .parent()?
            .to_path_buf(),
        Folder::Models => {
            let cfg = core.config();
            let chosen = cfg.local_model_directory.trim();
            if chosen.is_empty() {
                voice_core::paths::models_dir(data)
            } else {
                PathBuf::from(chosen)
            }
        }
    })
}

/// The consent object for the page.
pub fn consent_view(consent: Option<&Consent>) -> Value {
    consent.map_or(
        Value::Null,
        |c| json!({"provider": c.provider, "host": c.host}),
    )
}
