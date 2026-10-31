//! Ownkey in Settings: what Voice finds of it, the read-only import and its report.
//!
//! Nothing here writes to Ownkey's folders: the config is read with voice-core's import, the
//! models are looked at, and the process list is only read.

use std::fs;
use std::path::Path;
use std::sync::Arc;

use serde_json::{json, Map, Value};
use voice_core::config::Config;
use voice_core::local::{files_present, ModelSpec};
use voice_core::ownkey::{import, ImportError, ImportResult};

use crate::api::ApiError;
use crate::engine::Core;

/// The last import's report, in Voice's data folder.
pub const REPORT_FILE: &str = "ownkey-import.json";

/// Shown as is, so the page never shows the user's real profile path.
fn config_path_label() -> &'static str {
    if cfg!(windows) {
        "%APPDATA%\\Ownkey\\config.json"
    } else {
        "~/.config/ownkey/config.json"
    }
}

/// Whether Ownkey's config is there, and the keys it listens on.
pub fn keys(core: &Core) -> (bool, Vec<String>) {
    let Some(path) = core.svc.ownkey_config.as_deref().filter(|p| p.is_file()) else {
        return (false, Vec::new());
    };
    let keys = import(path)
        .map(|result| {
            let settings = result.settings();
            [settings.hotkey.clone(), settings.rewrite_hotkey.clone()]
                .into_iter()
                .filter(|k| k != "off")
                .collect()
        })
        .unwrap_or_default();
    (true, keys)
}

pub fn state(core: &Core, cfg: &Config, keys: &[String], found: bool, running: bool) -> Value {
    let models: Vec<Value> = core
        .svc
        .ownkey_models
        .as_deref()
        .map(|root| {
            [("orukeet", ModelSpec::orukeet()), ("nemotron", ModelSpec::nemotron())]
                .into_iter()
                .filter(|(_, spec)| files_present(spec, &spec.install_dir(root)))
                .map(|(id, spec)| {
                    json!({
                        "id": id,
                        "name": if id == "orukeet" { "Orukeet".to_string() } else { spec.label.clone() },
                        "sizeBytes": spec.archive.as_ref().map_or_else(|| spec.extracted_size(), |a| a.size),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    json!({
        "running": running,
        "keys": keys,
        "configFound": found,
        "configPath": config_path_label(),
        "lastImport": cfg.ownkey_imported_at,
        "models": models,
        "report": load_report(&core.opts.data_dir),
    })
}

pub fn load_report(data_dir: &Path) -> Value {
    fs::read(data_dir.join(REPORT_FILE))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or(Value::Null)
}

pub fn save_report(data_dir: &Path, report: &Value) {
    let tmp = data_dir.join(format!("{REPORT_FILE}.tmp"));
    if fs::write(&tmp, report.to_string()).is_ok() {
        let _ = fs::rename(&tmp, data_dir.join(REPORT_FILE));
    }
}

pub fn import_error(error: ImportError) -> ApiError {
    match error {
        ImportError::NotFound(_) => ApiError::new("not_found", error.to_string()),
        _ => ApiError::new("failed", error.to_string()),
    }
}

/// Reads Ownkey's config at `path` without writing it.
pub fn read(path: &Path) -> Result<(ImportResult, Map<String, Value>), ApiError> {
    let result = import(path).map_err(import_error)?;
    // Which areas Ownkey's file had, so the report can say "not set" for the others.
    let raw = fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    Ok((result, raw))
}

/// Applies an import to `cfg` and returns the report the page shows (API.md `OwnkeyState.report`).
pub fn apply(
    result: &ImportResult,
    raw: &Map<String, Value>,
    cfg: &mut Config,
    dev_mode: bool,
) -> Value {
    let detail = result.apply(cfg, dev_mode);
    let ownkey = result.settings();
    let has = |keys: &[&str]| keys.iter().any(|k| raw.contains_key(*k));
    let area = |present: bool, value: Value| if present { value } else { Value::Null };
    // Decision 10: true only when Ownkey allowed live transcription for a cloud provider.
    let consent_carried = detail.item("consent").is_some_and(|item| item.imported);
    json!({
        "hotkeys": area(has(&["hotkey", "rewrite_hotkey"]) && !dev_mode, json!({
            "dictation": ownkey.hotkey,
            "rewrite": ownkey.rewrite_hotkey,
        })),
        "transcription": area(has(&["audio_provider", "audio_endpoint", "audio_model", "audio_api_key", "endpoint", "model", "api_key"]), json!({
            "provider": cfg.audio_provider,
            "model": cfg.audio_model,
            "keyImported": !ownkey.audio_api_key.trim().is_empty(),
        })),
        "rewriting": area(has(&["rewrite_provider", "rewrite_endpoint", "rewrite_model", "rewrite_api_key", "chat_endpoint", "api_key"]), json!({
            "provider": cfg.rewrite_provider,
            "model": cfg.rewrite_model,
            "keyImported": !ownkey.rewrite_api_key.trim().is_empty(),
        })),
        "dictionary": area(has(&["vocabulary", "corrections"]), json!({
            "words": cfg.vocabulary.len(),
            "corrections": cfg.corrections.len(),
        })),
        "fillers": area(has(&["remove_fillers", "filler_languages", "custom_fillers"]), json!({
            "enabled": cfg.remove_fillers,
            "languages": cfg.filler_languages,
        })),
        "meetings": area(raw.keys().any(|k| k.starts_with("meetings_")), json!({
            "provider": cfg.meetings_audio_provider,
            "keyImported": !cfg.meetings_audio_api_key.trim().is_empty(),
            "retention": json!(cfg.meetings_retention),
            "consent": consent_carried,
        })),
        "skipped": ["summaries"],
    })
}

/// "Import from Ownkey" in Settings: reads, applies, saves and reports.
pub fn import_into(core: &Arc<Core>, path: &Path) -> Result<Value, ApiError> {
    let (result, raw) = read(path)?;
    let dev_mode = core.opts.dev_mode;
    let mut report = Value::Null;
    core.commit(|cfg| {
        report = apply(&result, &raw, cfg, dev_mode);
        Ok(())
    })?;
    save_report(&core.opts.data_dir, &report);
    core.settings.forget_storage();
    core.settings_changed();
    Ok(report)
}
