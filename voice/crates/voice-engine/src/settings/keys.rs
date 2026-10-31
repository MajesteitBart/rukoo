//! The dotted keys of voice/ui/API.md and Ownkey's flat keys in `config.json`.

use serde_json::{json, Value};
use voice_core::cleanup::{self, FILLER_LANGUAGES};
use voice_core::config::{
    Config, PillEdge, Retention, RewriteTone, ScreenMode, Theme, UiLanguage, HOTKEYS,
};

use crate::api::ApiError;

fn invalid(key: &str) -> ApiError {
    ApiError::new("invalid_value", format!("That isn't a value {key} takes."))
}

/// `state.config`: every setting under the key `settings_set` takes for it. Keys never appear;
/// only whether one is saved.
pub fn view(cfg: &Config, start_at_login: bool) -> Value {
    let saved = |key: &str| !key.trim().is_empty();
    let enum_text = |value: Value| value.as_str().unwrap_or_default().to_string();
    let sync = cfg
        .extra
        .get(SYNC_KEY)
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let sync_text = |name: &str| {
        sync.get(name)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    };
    json!({
        "dictation": {
            "hotkey": cfg.hotkey,
            "rewriteHotkey": cfg.rewrite_hotkey,
            "pasteMode": cfg.paste_mode,
            "readyChime": cfg.ready_chime,
            "startAtLogin": start_at_login,
        },
        "transcription": {
            "provider": cfg.audio_provider,
            "endpoint": cfg.audio_endpoint,
            "model": cfg.audio_model,
            "language": cfg.language,
            "keySaved": saved(&cfg.audio_api_key),
        },
        "local": {
            "modelFolder": cfg.local_model_directory,
            "idleMinutes": cfg.local_model_idle_timeout_minutes.round() as u64,
        },
        "dictionary": {
            "vocabulary": cfg.vocabulary,
            "corrections": cfg.corrections.iter().map(|c| json!({"from": c.from, "to": c.to})).collect::<Vec<_>>(),
        },
        "fillers": {
            "enabled": cfg.remove_fillers,
            "languages": cfg.filler_languages,
            "custom": cfg.custom_fillers,
        },
        "rewriting": {
            "provider": cfg.rewrite_provider,
            "endpoint": cfg.rewrite_endpoint,
            "model": cfg.rewrite_model,
            "keySaved": saved(&cfg.rewrite_api_key),
            "auto": cfg.auto_rewrite,
            "tone": enum_text(json!(cfg.rewrite_tone)),
            "formatting": cfg.rewrite_formatting,
            "instructions": cfg.rewrite_custom_instructions,
        },
        "meetings": {
            "provider": cfg.meetings_audio_provider,
            "endpoint": cfg.meetings_audio_endpoint,
            "model": cfg.meetings_audio_model,
            "keySaved": saved(&cfg.meetings_audio_api_key),
            "consent": super::consent_view(cfg.meetings_transcription_consent.as_ref()),
            "retention": enum_text(json!(cfg.meetings_retention)),
            "stopKey": cfg.meetings_stop_key,
            "screen": enum_text(json!(cfg.meetings_screen)),
            "liveSpeakers": cfg.meetings_auto_speakers,
        },
        "ui": {
            "language": enum_text(json!(cfg.ui_language)),
            "theme": enum_text(json!(cfg.ui_theme)),
            "pillEdge": enum_text(json!(cfg.pill_edge)),
            "hidePillFromCapture": cfg.pill_hide_from_capture,
        },
        "updates": { "check": cfg.updates_check },
        "storage": {
            "sync": {
                "enabled": sync.get("enabled").and_then(Value::as_bool).unwrap_or(false),
                "service": sync.get("service").and_then(Value::as_str).unwrap_or("upcloud"),
                "endpoint": sync_text("endpoint"),
                "region": sync_text("region"),
                "bucket": sync_text("bucket"),
                "prefix": sync_text("prefix"),
                "accessKeyId": sync_text("accessKeyId"),
                // The secret never reaches the page.
                "secret": "",
            }
        },
    })
}

/// Bucket sync comes after 0.1; its settings are kept under this key in `config.json`.
const SYNC_KEY: &str = "storage_sync";

fn boolean(key: &str, value: &Value) -> Result<bool, ApiError> {
    value.as_bool().ok_or_else(|| invalid(key))
}

fn string(key: &str, value: &Value) -> Result<String, ApiError> {
    value
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| invalid(key))
}

fn choice<T: serde::de::DeserializeOwned>(key: &str, value: &Value) -> Result<T, ApiError> {
    serde_json::from_value(value.clone()).map_err(|_| invalid(key))
}

/// A key name, or `off` where `allow_off`.
fn hotkey(key: &str, value: &Value, allow_off: bool) -> Result<String, ApiError> {
    let name = value
        .as_str()
        .map(|s| s.trim().to_lowercase())
        .ok_or_else(|| invalid(key))?;
    if (allow_off && name == "off") || HOTKEYS.contains(&name.as_str()) {
        Ok(name)
    } else {
        Err(invalid(key))
    }
}

fn same_key(name: &str) -> ApiError {
    ApiError::new(
        "same_key",
        format!("{name} is already the dictation, rewrite or stop key."),
    )
}

/// `fillers.languages`: a subset of Ownkey's five; an empty list stays empty.
pub fn filler_languages(value: &Value) -> Result<Vec<String>, ApiError> {
    let list = value
        .as_array()
        .ok_or_else(|| invalid("fillers.languages"))?;
    let mut languages: Vec<String> = Vec::new();
    for item in list {
        let code = item
            .as_str()
            .map(|s| s.trim().to_lowercase())
            .ok_or_else(|| invalid("fillers.languages"))?;
        if !FILLER_LANGUAGES.iter().any(|(known, _, _)| *known == code) {
            return Err(invalid("fillers.languages"));
        }
        if !languages.contains(&code) {
            languages.push(code);
        }
    }
    Ok(languages)
}

/// Applies one `settings_set` to the config, or refuses it.
pub fn set(cfg: &mut Config, key: &str, value: Value) -> Result<(), ApiError> {
    match key {
        "dictation.hotkey" => {
            let name = hotkey(key, &value, false)?;
            if name == cfg.rewrite_hotkey || name == cfg.meetings_stop_key {
                return Err(same_key(&name));
            }
            cfg.hotkey = name;
        }
        "dictation.rewriteHotkey" => {
            let name = hotkey(key, &value, true)?;
            if name != "off" && (name == cfg.hotkey || name == cfg.meetings_stop_key) {
                return Err(same_key(&name));
            }
            cfg.rewrite_hotkey = name;
        }
        "meetings.stopKey" => {
            let name = hotkey(key, &value, true)?;
            if name != "off" && (name == cfg.hotkey || name == cfg.rewrite_hotkey) {
                return Err(same_key(&name));
            }
            cfg.meetings_stop_key = name;
        }
        "dictation.pasteMode" => cfg.paste_mode = boolean(key, &value)?,
        "dictation.readyChime" => cfg.ready_chime = boolean(key, &value)?,
        "ui.pillEdge" => cfg.pill_edge = choice::<PillEdge>(key, &value)?,
        "ui.hidePillFromCapture" => cfg.pill_hide_from_capture = boolean(key, &value)?,
        "local.modelFolder" => cfg.local_model_directory = string(key, &value)?.trim().to_string(),
        "local.idleMinutes" => {
            let minutes = value
                .as_u64()
                .filter(|m| *m <= 1440)
                .ok_or_else(|| invalid(key))?;
            cfg.local_model_idle_timeout_minutes = minutes as f64;
        }
        "dictionary.vocabulary" => {
            let list = value.as_array().ok_or_else(|| invalid(key))?;
            let words = list
                .iter()
                .map(|w| w.as_str().map(str::to_string).ok_or_else(|| invalid(key)))
                .collect::<Result<Vec<_>, _>>()?;
            cfg.vocabulary = cleanup::normalize_vocabulary_list(&words);
        }
        "dictionary.corrections" => {
            let list = value.as_array().ok_or_else(|| invalid(key))?;
            if !list
                .iter()
                .all(|c| c["from"].is_string() && c["to"].is_string())
            {
                return Err(invalid(key));
            }
            cfg.corrections = cleanup::normalize_corrections(&value);
        }
        "fillers.enabled" => cfg.remove_fillers = boolean(key, &value)?,
        "fillers.languages" => cfg.filler_languages = filler_languages(&value)?,
        "fillers.custom" => {
            let text = string(key, &value)?;
            cfg.custom_fillers = cleanup::normalize_vocabulary_str(&text).join(", ");
        }
        "rewriting.auto" => cfg.auto_rewrite = boolean(key, &value)?,
        "rewriting.tone" => cfg.rewrite_tone = choice::<RewriteTone>(key, &value)?,
        "rewriting.formatting" => cfg.rewrite_formatting = boolean(key, &value)?,
        "rewriting.instructions" => cfg.rewrite_custom_instructions = string(key, &value)?,
        "meetings.retention" => cfg.meetings_retention = choice::<Retention>(key, &value)?,
        "meetings.screen" => cfg.meetings_screen = choice::<ScreenMode>(key, &value)?,
        "meetings.liveSpeakers" => cfg.meetings_auto_speakers = boolean(key, &value)?,
        "ui.language" => cfg.ui_language = choice::<UiLanguage>(key, &value)?,
        "ui.theme" => cfg.ui_theme = choice::<Theme>(key, &value)?,
        "updates.check" => cfg.updates_check = boolean(key, &value)?,
        _ if key.starts_with("storage.sync.") => {
            let field = &key["storage.sync.".len()..];
            let ok = match field {
                "enabled" => value.is_boolean(),
                "service" | "endpoint" | "region" | "bucket" | "prefix" | "accessKeyId"
                | "secret" => value.is_string(),
                _ => false,
            };
            if !ok {
                return Err(invalid(key));
            }
            let sync = cfg.extra.entry(SYNC_KEY).or_insert_with(|| json!({}));
            if !sync.is_object() {
                *sync = json!({});
            }
            sync[field] = value;
        }
        // transcription.*, rewriting.provider and the other provider fields are saved as a
        // whole with settings_save_provider.
        _ => {
            return Err(ApiError::new(
                "invalid_value",
                format!("{key} can't be set on its own."),
            ))
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_documented_key_round_trips_through_the_view() {
        let mut cfg = Config::defaults(true);
        let cases = [
            ("dictation.hotkey", json!("f15")),
            ("dictation.rewriteHotkey", json!("off")),
            ("dictation.pasteMode", json!(false)),
            ("dictation.readyChime", json!(true)),
            ("ui.pillEdge", json!("top")),
            ("ui.hidePillFromCapture", json!(false)),
            ("local.modelFolder", json!("D:\\Models")),
            ("local.idleMinutes", json!(0)),
            ("dictionary.vocabulary", json!(["Rukoo", "Ownkey"])),
            (
                "dictionary.corrections",
                json!([{"from": "rocco", "to": "Rukoo"}]),
            ),
            ("fillers.enabled", json!(false)),
            ("fillers.languages", json!([])),
            ("fillers.custom", json!("basically")),
            ("rewriting.auto", json!(true)),
            ("rewriting.tone", json!("concise")),
            ("rewriting.formatting", json!(false)),
            ("rewriting.instructions", json!("Keep greetings.")),
            ("meetings.retention", json!("after_transcription")),
            ("meetings.stopKey", json!("pause")),
            ("meetings.screen", json!("off")),
            ("meetings.liveSpeakers", json!(true)),
            ("ui.language", json!("nl")),
            ("ui.theme", json!("dark")),
            ("updates.check", json!(true)),
        ];
        for (key, value) in &cases {
            set(&mut cfg, key, value.clone()).unwrap_or_else(|e| panic!("{key}: {e}"));
        }
        let view = view(&cfg, false);
        for (key, value) in cases {
            let (group, field) = key.split_once('.').unwrap();
            assert_eq!(view[group][field], value, "{key}");
        }
        assert_eq!(cfg.hotkey, "f15");
        assert_eq!(cfg.meetings_retention, Retention::AfterTranscription);
    }

    #[test]
    fn bad_values_and_read_only_keys_are_refused() {
        let mut cfg = Config::defaults(true);
        for (key, value) in [
            ("dictation.hotkey", json!("left alt")),
            ("dictation.hotkey", json!("off")),
            ("dictation.pasteMode", json!("yes")),
            ("local.idleMinutes", json!(1441)),
            ("local.idleMinutes", json!(-1)),
            ("local.idleMinutes", json!(2.5)),
            ("fillers.languages", json!(["en", "xx"])),
            ("rewriting.tone", json!("angry")),
            ("ui.theme", json!("blue")),
            ("meetings.retention", json!("forever")),
            ("dictionary.corrections", json!([{"from": "a"}])),
            ("transcription.provider", json!("openai")),
            ("rewriting.provider", json!("openai")),
            ("nonsense", json!(1)),
        ] {
            let error = set(&mut cfg, key, value).unwrap_err();
            assert_eq!(error.code, "invalid_value", "{key}");
        }
        assert_eq!(cfg, Config::defaults(true), "nothing changed");
    }

    #[test]
    fn a_key_can_only_have_one_role() {
        let mut cfg = Config::defaults(true);
        assert_eq!(
            set(&mut cfg, "dictation.hotkey", json!("f14"))
                .unwrap_err()
                .code,
            "same_key"
        );
        assert_eq!(
            set(&mut cfg, "dictation.rewriteHotkey", json!("f13"))
                .unwrap_err()
                .code,
            "same_key"
        );
        assert_eq!(
            set(&mut cfg, "meetings.stopKey", json!("F14"))
                .unwrap_err()
                .code,
            "same_key"
        );
        set(&mut cfg, "meetings.stopKey", json!("f15")).unwrap();
        assert_eq!(
            set(&mut cfg, "dictation.hotkey", json!("f15"))
                .unwrap_err()
                .code,
            "same_key"
        );
        set(&mut cfg, "dictation.rewriteHotkey", json!("off")).unwrap();
        set(&mut cfg, "dictation.hotkey", json!("f14")).unwrap();
    }

    #[test]
    fn keys_and_the_bucket_secret_never_reach_the_page() {
        let mut cfg = Config::defaults(true);
        cfg.audio_api_key = "sk-secret-audio".into();
        cfg.rewrite_api_key = "sk-secret-rewrite".into();
        set(&mut cfg, "storage.sync.secret", json!("bucket-secret")).unwrap();
        set(&mut cfg, "storage.sync.bucket", json!("meetings")).unwrap();
        let text = view(&cfg, false).to_string();
        for secret in ["sk-secret-audio", "sk-secret-rewrite", "bucket-secret"] {
            assert!(!text.contains(secret), "{secret} leaked");
        }
        let view = view(&cfg, false);
        assert_eq!(view["transcription"]["keySaved"], true);
        assert_eq!(view["storage"]["sync"]["bucket"], "meetings");
    }
}
