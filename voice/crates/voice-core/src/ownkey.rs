//! Read-only import of Ownkey for Windows' settings.
//!
//! Ownkey's `config.json` holds the user's API keys and Ownkey keeps running next to Voice, so the
//! file is only ever opened for reading. The import applies Ownkey's own load-time migrations
//! (legacy shared keys, retired local rewriting, removed pyannote keys) and reports what it took
//! over without ever showing a key.

use std::fmt;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{json, Value};

use crate::config::{Config, Consent, SAME_AS_DICTATION};
use crate::consent::ConsentState;
use crate::fsutil;
use crate::providers::provider_label;

#[derive(Debug)]
pub enum ImportError {
    NotFound(PathBuf),
    Invalid(PathBuf),
    Io(io::Error),
}

impl fmt::Display for ImportError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ImportError::NotFound(path) => {
                write!(f, "Ownkey's settings weren't found at {}.", path.display())
            }
            ImportError::Invalid(path) => write!(
                f,
                "Ownkey's settings at {} aren't valid JSON.",
                path.display()
            ),
            ImportError::Io(error) => write!(f, "Couldn't read Ownkey's settings: {error}"),
        }
    }
}

impl std::error::Error for ImportError {}

/// One row of "What Voice took over" on the import page. `text` never contains a key.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ReportItem {
    /// A stable id for the row, such as "dictionary" or "audio_key".
    pub key: &'static str,
    pub imported: bool,
    pub text: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct ImportReport {
    pub source: String,
    pub items: Vec<ReportItem>,
}

impl ImportReport {
    fn add(&mut self, key: &'static str, imported: bool, text: impl Into<String>) {
        self.items.push(ReportItem {
            key,
            imported,
            text: text.into(),
        });
    }

    pub fn item(&self, key: &str) -> Option<&ReportItem> {
        self.items.iter().find(|item| item.key == key)
    }
}

/// Ownkey's settings, read and migrated, ready to apply to a Voice config.
pub struct ImportResult {
    source: PathBuf,
    settings: Config,
    live_transcription_allowed: bool,
    sample_rate: Option<u64>,
}

impl fmt::Debug for ImportResult {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ImportResult")
            .field("source", &self.source)
            .field("settings", &self.settings)
            .finish()
    }
}

/// Reads Ownkey's settings at `path` without writing anything.
pub fn import(path: &Path) -> Result<ImportResult, ImportError> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Err(ImportError::NotFound(path.to_path_buf()))
        }
        Err(error) => return Err(ImportError::Io(error)),
    };
    let Ok(Value::Object(mut raw)) = serde_json::from_slice::<Value>(&bytes) else {
        return Err(ImportError::Invalid(path.to_path_buf()));
    };
    let live_transcription_allowed = raw
        .get("meetings_live_transcription_policy")
        .and_then(Value::as_str)
        == Some("allow");
    let sample_rate = raw.get("sample_rate").and_then(Value::as_u64);
    // Ownkey's meetings followed the dictation provider unless the user chose otherwise.
    raw.entry("meetings_audio_provider")
        .or_insert_with(|| json!(SAME_AS_DICTATION));
    // Hotkeys are read with installed defaults; apply() decides whether they are used.
    let settings = Config::from_value(&Value::Object(raw), false);
    Ok(ImportResult {
        source: path.to_path_buf(),
        settings,
        live_transcription_allowed,
        sample_rate,
    })
}

fn on_off(flag: bool) -> &'static str {
    if flag {
        "on"
    } else {
        "off"
    }
}

fn plural(count: usize, one: &str, many: &str) -> String {
    format!("{count} {}", if count == 1 { one } else { many })
}

impl ImportResult {
    pub fn source(&self) -> &Path {
        &self.source
    }

    /// Ownkey's settings as Ownkey would load them, as a Voice config with Voice's defaults
    /// for everything Ownkey doesn't have.
    pub fn settings(&self) -> &Config {
        &self.settings
    }

    /// Replaces Voice's settings with Ownkey's. Voice-only settings (theme, language, pill,
    /// updates, screen recording) stay as they are. In development mode the hotkeys stay F13
    /// and F14, so a dev copy never answers the installed Ownkey's keys.
    pub fn apply(&self, cfg: &mut Config, dev_mode: bool) -> ImportReport {
        let ownkey = &self.settings;
        let mut report = ImportReport {
            source: self.source.display().to_string(),
            items: Vec::new(),
        };

        if dev_mode {
            report.add(
                "hotkeys",
                false,
                "Keys: in development, Voice keeps F13 and F14.",
            );
        } else {
            cfg.hotkey = ownkey.hotkey.clone();
            cfg.rewrite_hotkey = ownkey.rewrite_hotkey.clone();
            report.add(
                "hotkeys",
                true,
                format!(
                    "Dictation key {}, rewrite key {}",
                    ownkey.hotkey, ownkey.rewrite_hotkey
                ),
            );
        }
        if cfg.meetings_stop_key == cfg.hotkey || cfg.meetings_stop_key == cfg.rewrite_hotkey {
            cfg.meetings_stop_key = "off".into();
        }

        cfg.paste_mode = ownkey.paste_mode;
        cfg.ready_chime = ownkey.ready_chime;
        report.add(
            "dictation",
            true,
            format!(
                "Paste mode {}, ready chime {}",
                on_off(ownkey.paste_mode),
                on_off(ownkey.ready_chime)
            ),
        );

        cfg.audio_provider = ownkey.audio_provider.clone();
        cfg.audio_api_key = ownkey.audio_api_key.clone();
        cfg.audio_endpoint = ownkey.audio_endpoint.clone();
        cfg.audio_model = ownkey.audio_model.clone();
        cfg.language = ownkey.language.clone();
        cfg.local_model_directory = ownkey.local_model_directory.clone();
        cfg.local_model_idle_timeout_minutes = ownkey.local_model_idle_timeout_minutes;
        let audio_label = provider_label(&ownkey.audio_provider);
        report.add(
            "transcription",
            true,
            format!(
                "{audio_label}, model {}, language {}",
                ownkey.audio_model, ownkey.language
            ),
        );
        if !ownkey.audio_api_key.trim().is_empty() {
            report.add("audio_key", true, format!("{audio_label} key imported"));
        }
        if !ownkey.local_model_directory.is_empty() {
            report.add(
                "model_folder",
                true,
                format!("Model folder {}", ownkey.local_model_directory),
            );
        }

        cfg.vocabulary = ownkey.vocabulary.clone();
        cfg.corrections = ownkey.corrections.clone();
        report.add(
            "dictionary",
            true,
            format!(
                "{}, {}",
                plural(ownkey.vocabulary.len(), "word", "words"),
                plural(ownkey.corrections.len(), "correction", "corrections")
            ),
        );

        cfg.remove_fillers = ownkey.remove_fillers;
        cfg.filler_languages = ownkey.filler_languages.clone();
        cfg.custom_fillers = ownkey.custom_fillers.clone();
        let languages = if ownkey.filler_languages.is_empty() {
            "no languages".to_string()
        } else {
            ownkey.filler_languages.join(", ")
        };
        report.add(
            "fillers",
            true,
            format!(
                "Filler words {}: {languages}",
                on_off(ownkey.remove_fillers)
            ),
        );

        cfg.rewrite_provider = ownkey.rewrite_provider.clone();
        cfg.rewrite_api_key = ownkey.rewrite_api_key.clone();
        cfg.rewrite_endpoint = ownkey.rewrite_endpoint.clone();
        cfg.rewrite_model = ownkey.rewrite_model.clone();
        cfg.auto_rewrite = ownkey.auto_rewrite;
        cfg.rewrite_tone = ownkey.rewrite_tone;
        cfg.rewrite_formatting = ownkey.rewrite_formatting;
        cfg.rewrite_custom_instructions = ownkey.rewrite_custom_instructions.clone();
        let rewrite_label = provider_label(&ownkey.rewrite_provider);
        report.add(
            "rewriting",
            true,
            format!(
                "{rewrite_label}, model {}, auto-rewrite {}",
                ownkey.rewrite_model,
                on_off(ownkey.auto_rewrite)
            ),
        );
        if !ownkey.rewrite_api_key.trim().is_empty() {
            report.add("rewrite_key", true, format!("{rewrite_label} key imported"));
        }

        cfg.meetings_audio_provider = ownkey.meetings_audio_provider.clone();
        cfg.meetings_audio_api_key = ownkey.meetings_audio_api_key.clone();
        cfg.meetings_audio_endpoint = ownkey.meetings_audio_endpoint.clone();
        cfg.meetings_audio_model = ownkey.meetings_audio_model.clone();
        cfg.meetings_retention = ownkey.meetings_retention;
        cfg.meetings_auto_speakers = ownkey.meetings_auto_speakers;
        let meeting_choice = if ownkey.meetings_audio_provider == SAME_AS_DICTATION {
            "same as dictation".to_string()
        } else {
            provider_label(&ownkey.meetings_audio_provider).to_string()
        };
        report.add(
            "meetings",
            true,
            format!(
                "Meeting transcription {meeting_choice}, keep audio {}",
                ownkey.meetings_retention.label().to_lowercase()
            ),
        );
        if ownkey.meetings_audio_provider != SAME_AS_DICTATION
            && !ownkey.meetings_audio_api_key.trim().is_empty()
        {
            report.add(
                "meetings_key",
                true,
                format!(
                    "{} key for meetings imported",
                    provider_label(&ownkey.meetings_audio_provider)
                ),
            );
        }

        // Decision 10: Ownkey's "don't ask again" for live transcription is the only answer that
        // means the same as Voice's consent, so only that one carries over.
        if let ConsentState::Required {
            provider,
            label,
            host,
        } = cfg.meeting_consent()
        {
            if self.live_transcription_allowed {
                cfg.meetings_transcription_consent = Some(Consent {
                    provider,
                    host: host.clone(),
                });
                report.add(
                    "consent",
                    true,
                    format!("Meeting audio may go to {label} at {host}, as Ownkey allowed"),
                );
            } else {
                report.add(
                    "consent",
                    false,
                    format!("Sending meeting audio to {label}: Voice asks in Settings first"),
                );
            }
        }

        report.add(
            "summaries",
            false,
            "Summaries and remote analysis: Rukoo's agent writes meeting notes now, so Voice sends no meeting text to a rewrite provider",
        );
        if let Some(rate) = self.sample_rate.filter(|rate| *rate != 16_000) {
            report.add(
                "sample_rate",
                false,
                format!("Sample rate {rate} Hz: Voice always records at 16 kHz"),
            );
        }

        cfg.ownkey_imported_at = Some(fsutil::now_ms());
        report
    }
}
