//! Settings through the engine API (voice/ui/API.md), on fakes and temp folders.

mod support;

use std::sync::atomic::Ordering;
use std::time::Duration;

use serde_json::{json, Value};
use support::{lock, wait_for, Harness, TempDir};
use voice_core::config::Consent;
use voice_core::{ErrorKind, ProviderError};
use voice_engine::Folder;

const SECRET: &str = "sk-test-0123456789";

fn code(result: Result<impl std::fmt::Debug, voice_engine::ApiError>) -> String {
    result.unwrap_err().code
}

#[test]
fn the_state_has_every_part_api_md_lists() {
    let h = Harness::new("state");
    h.config(json!({"audio_api_key": SECRET}));
    let engine = h.start();
    let state = engine.settings_state();
    for field in [
        "seq",
        "version",
        "devMode",
        "platform",
        "theme",
        "locale",
        "config",
        "providers",
        "dictation",
        "rukoo",
        "models",
        "storage",
        "updates",
        "ownkey",
        "sync",
    ] {
        assert!(state.get(field).is_some(), "{field} is missing");
    }
    assert_eq!(state["devMode"], true);
    assert_eq!(state["version"], "0.1.0-test");
    assert_eq!(state["theme"], "dark");
    assert_eq!(state["config"]["dictation"]["hotkey"], "f13");
    assert_eq!(state["config"]["dictation"]["startAtLogin"], false);
    assert_eq!(state["config"]["transcription"]["provider"], "orukeet");
    let audio: Vec<&str> = state["providers"]["audio"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["id"].as_str().unwrap())
        .collect();
    assert_eq!(audio, ["openai", "google", "mistral", "custom", "orukeet"]);
    assert_eq!(state["providers"]["rewrite"].as_array().unwrap().len(), 7);
    assert_eq!(state["models"]["orukeet"]["stage"], "missing");
    assert_eq!(state["models"]["orukeet"]["removable"], false);
    assert_eq!(state["models"]["orukeet"]["active"], "unloaded");
    assert_eq!(state["models"]["nemotron"]["active"], Value::Null);
    assert_eq!(state["dictation"]["status"], "modelMissing");
    assert_eq!(state["rukoo"]["state"], "notRunning");
    assert!(
        state["rukoo"]["port"].as_u64().is_some(),
        "the bridge listens"
    );
    assert_eq!(
        state["rukoo"]["discoveryPath"],
        h.dir.join("bridge.json").display().to_string()
    );
    assert_eq!(state["updates"], json!({"state": "idle", "version": null}));
    assert_eq!(state["ownkey"]["configFound"], false);
    assert_eq!(state["ownkey"]["report"], Value::Null);
    assert!(
        !state.to_string().contains(SECRET),
        "a key never reaches the page"
    );
    assert_eq!(state["config"]["rewriting"]["keySaved"], false);
    engine.shutdown();
}

#[test]
fn a_setting_is_saved_applied_and_sent() {
    let h = Harness::new("set");
    h.config(json!({}));
    let engine = h.start();
    let before = h.sink.last_settings()["seq"].as_u64().unwrap();
    engine
        .settings_set("dictation.pasteMode", json!(false))
        .unwrap();
    engine
        .settings_set(
            "dictionary.vocabulary",
            json!(["Rukoo", " rukoo ", "Hermes"]),
        )
        .unwrap();
    engine.settings_set("fillers.languages", json!([])).unwrap();
    engine.settings_set("ui.theme", json!("light")).unwrap();
    engine.settings_set("ui.language", json!("nl")).unwrap();
    let state = h.sink.last_settings();
    assert!(state["seq"].as_u64().unwrap() > before);
    assert_eq!(state["config"]["dictation"]["pasteMode"], false);
    assert_eq!(
        state["config"]["dictionary"]["vocabulary"],
        json!(["Rukoo", "Hermes"])
    );
    assert_eq!(state["config"]["fillers"]["languages"], json!([]));
    assert_eq!(
        (state["theme"].as_str(), state["locale"].as_str()),
        (Some("light"), Some("nl"))
    );
    let ui = engine.ui();
    assert_eq!(
        (ui.theme, ui.locale),
        (voice_engine::Theme::Light, voice_engine::Locale::Nl)
    );
    assert!(h.sink.ui_changes.load(Ordering::SeqCst) >= 1);
    // The pill follows at once.
    wait_for("a light pill", || {
        engine.pill_snapshot().theme == voice_engine::Theme::Light
    });
    let saved = h.saved_config();
    assert!(!saved.paste_mode);
    assert_eq!(saved.vocabulary, ["Rukoo", "Hermes"]);
    assert!(saved.filler_languages.is_empty());
    engine.shutdown();
}

#[test]
fn bad_values_same_keys_and_dev_mode_are_refused() {
    let h = Harness::new("refuse");
    h.config(json!({}));
    let engine = h.start();
    assert_eq!(
        code(engine.settings_set("dictation.hotkey", json!("f14"))),
        "same_key"
    );
    assert_eq!(
        code(engine.settings_set("meetings.stopKey", json!("f13"))),
        "same_key"
    );
    assert_eq!(
        code(engine.settings_set("local.idleMinutes", json!(5000))),
        "invalid_value"
    );
    assert_eq!(
        code(engine.settings_set("transcription.provider", json!("openai"))),
        "invalid_value"
    );
    assert_eq!(
        code(engine.settings_set("dictation.startAtLogin", json!(true))),
        "dev_mode"
    );
    assert_eq!(
        h.autostart.writes.load(Ordering::SeqCst),
        0,
        "never touched in dev mode"
    );
    assert_eq!(code(engine.settings_import_ownkey()), "dev_mode");
    assert_eq!(
        code(engine.settings_set_folder("recordings", h.dir.join("x"))),
        "invalid_value"
    );
    assert_eq!(h.saved_config().hotkey, "f13", "nothing was saved");
    engine.shutdown();
}

#[test]
fn start_at_login_writes_the_run_value_only_for_an_installed_copy() {
    let mut h = Harness::new("autostart");
    h.dev_mode = false;
    let engine = h.start();
    // Decision 6: an installed copy is registered on its first start.
    assert!(h.autostart.on.load(Ordering::SeqCst));
    assert_eq!(
        engine.settings_state()["config"]["dictation"]["startAtLogin"],
        true
    );
    engine
        .settings_set("dictation.startAtLogin", json!(false))
        .unwrap();
    assert!(!h.autostart.on.load(Ordering::SeqCst));
    engine.shutdown();
    // A later start never turns it back on.
    let again = h.start();
    assert!(!h.autostart.on.load(Ordering::SeqCst));
    assert_eq!(h.autostart.writes.load(Ordering::SeqCst), 2);
    // The first run picked Orukeet, as Settings promises.
    assert_eq!(
        again.settings_state()["config"]["transcription"]["provider"],
        "orukeet"
    );
    again.shutdown();
}

fn save(engine: &voice_engine::Engine, save: Value) -> Result<(), voice_engine::ApiError> {
    engine.settings_save_provider(save)
}

#[test]
fn a_provider_form_is_checked_and_saved_as_a_whole() {
    let h = Harness::new("provider");
    h.config(json!({}));
    let engine = h.start();
    assert_eq!(
        code(save(
            &engine,
            json!({"target": "transcription", "provider": "openai", "endpoint": "", "model": "", "apiKey": null})
        )),
        "need_endpoint_model"
    );
    assert_eq!(
        code(save(
            &engine,
            json!({"target": "rewriting", "provider": "orukeet", "endpoint": "", "model": "", "apiKey": null})
        )),
        "invalid_value"
    );
    save(
        &engine,
        json!({
            "target": "transcription", "provider": "openai",
            "endpoint": " https://api.openai.com/v1/audio/transcriptions ", "model": "whisper-1",
            "apiKey": SECRET, "language": "nl"
        }),
    )
    .unwrap();
    let cfg = h.saved_config();
    assert_eq!(
        (
            cfg.audio_provider.as_str(),
            cfg.audio_endpoint.as_str(),
            cfg.audio_model.as_str(),
            cfg.language.as_str()
        ),
        (
            "openai",
            "https://api.openai.com/v1/audio/transcriptions",
            "whisper-1",
            "nl"
        )
    );
    assert_eq!(cfg.audio_api_key, SECRET);
    // null keeps the key for the same provider ...
    save(&engine, json!({"target": "transcription", "provider": "openai", "endpoint": "https://api.openai.com/v1/audio/transcriptions", "model": "gpt-4o-mini-transcribe", "apiKey": null})).unwrap();
    assert_eq!(h.saved_config().audio_api_key, SECRET);
    // ... and never carries it to another one.
    save(&engine, json!({"target": "transcription", "provider": "mistral", "endpoint": "https://api.mistral.ai/v1/audio/transcriptions", "model": "voxtral-mini-latest", "apiKey": null})).unwrap();
    assert_eq!(h.saved_config().audio_api_key, "");
    assert_eq!(engine.settings_state()["dictation"]["status"], "noKey");
    save(&engine, json!({"target": "transcription", "provider": "mistral", "endpoint": "https://api.mistral.ai/v1/audio/transcriptions", "model": "voxtral-mini-latest", "apiKey": SECRET})).unwrap();
    engine.settings_remove_key("transcription").unwrap();
    assert_eq!(h.saved_config().audio_api_key, "");
    engine.shutdown();
}

#[test]
fn orukeet_is_loaded_before_it_becomes_the_dictation_provider() {
    let h = Harness::new("orukeet-save");
    h.config(json!({
        "audio_provider": "mistral", "audio_api_key": SECRET,
        "audio_endpoint": "https://api.mistral.ai/v1/audio/transcriptions", "audio_model": "voxtral-mini-latest"
    }));
    *lock(&h.speech.local_load) = Some(ProviderError::new(
        ErrorKind::LocalMissingModel,
        "Model missing. Download it in Settings > Transcription.",
    ));
    let engine = h.start();
    let orukeet = json!({"target": "transcription", "provider": "orukeet", "endpoint": "x", "model": "y", "apiKey": null});
    let error = save(&engine, orukeet.clone()).unwrap_err();
    assert_eq!(error.code, "failed");
    assert_eq!(
        error.message,
        "Model missing. Download it in Settings > Transcription."
    );
    // A failed load keeps the old settings.
    assert_eq!(h.saved_config().audio_provider, "mistral");
    assert_eq!(h.saved_config().audio_api_key, SECRET);
    *lock(&h.speech.local_load) = None;
    save(&engine, orukeet).unwrap();
    let cfg = h.saved_config();
    assert_eq!(
        (
            cfg.audio_provider.as_str(),
            cfg.audio_endpoint.as_str(),
            cfg.audio_model.as_str()
        ),
        ("orukeet", "", "orukeet-onnx-int8")
    );
    assert_eq!(cfg.audio_api_key, "", "Orukeet keeps no key");
    assert_eq!(h.speech.local_loads.load(Ordering::SeqCst), 2);
    engine.shutdown();
}

#[test]
fn a_change_saved_while_orukeet_loads_is_kept() {
    let h = Harness::new("save-during-load");
    h.config(json!({
        "audio_provider": "mistral", "audio_api_key": SECRET,
        "audio_endpoint": "https://api.mistral.ai/v1/audio/transcriptions", "audio_model": "voxtral-mini-latest"
    }));
    // The first load checks the 487 MB model, which takes a while.
    *lock(&h.speech.local_load_delay) = Duration::from_millis(800);
    let engine = h.start();
    let saving = std::thread::spawn({
        let engine = engine.clone();
        move || {
            save(
                &engine,
                json!({"target": "transcription", "provider": "orukeet", "apiKey": null}),
            )
        }
    });
    wait_for("Orukeet to load", || {
        h.speech.local_loads.load(Ordering::SeqCst) == 1
    });
    // Meanwhile the user saves another page and flips a switch.
    let mistral = json!({"target": "meetings", "provider": "mistral", "endpoint": "https://api.mistral.ai/v1/audio/transcriptions", "model": "voxtral-mini-latest", "apiKey": SECRET, "consent": true});
    save(&engine, mistral).unwrap();
    engine
        .settings_set("dictation.pasteMode", json!(false))
        .unwrap();
    saving.join().unwrap().unwrap();
    let cfg = h.saved_config();
    assert_eq!(cfg.audio_provider, "orukeet");
    assert!(
        !cfg.paste_mode,
        "the switch flipped during the load stays off"
    );
    assert_eq!(cfg.meetings_audio_provider, "mistral");
    assert_eq!(cfg.meetings_audio_api_key, SECRET);
    assert!(cfg.meetings_transcription_consent.is_some());
    assert_eq!(
        engine.settings_state()["config"]["dictation"]["pasteMode"],
        false
    );
    engine.shutdown();
}

#[test]
fn every_settings_state_goes_out_with_the_next_seq() {
    let h = Harness::new("seq-order");
    h.config(json!({}));
    let engine = h.start();
    lock(&h.sink.settings).clear();
    // Many threads change Settings' state at once, as a download, a save and Rukoo's watcher do.
    let threads: Vec<_> = (0..8)
        .map(|_| {
            let engine = engine.clone();
            std::thread::spawn(move || {
                for _ in 0..25 {
                    engine.settings_check_updates();
                }
            })
        })
        .collect();
    for thread in threads {
        thread.join().unwrap();
    }
    let seqs: Vec<u64> = lock(&h.sink.settings)
        .iter()
        .map(|state| state["seq"].as_u64().unwrap())
        .collect();
    assert_eq!(seqs.len(), 8 * 25 * 2);
    for pair in seqs.windows(2) {
        assert_eq!(
            pair[1],
            pair[0] + 1,
            "a state went out out of order or with a seq already used"
        );
    }
    engine.shutdown();
}

#[test]
fn meeting_consent_names_the_provider_and_host() {
    let h = Harness::new("consent");
    h.config(json!({}));
    let engine = h.start();
    let mistral = |consent: bool, endpoint: &str| json!({"target": "meetings", "provider": "mistral", "endpoint": endpoint, "model": "voxtral-mini-latest", "apiKey": SECRET, "consent": consent});
    save(
        &engine,
        mistral(false, "https://api.mistral.ai/v1/audio/transcriptions"),
    )
    .unwrap();
    assert_eq!(
        engine.settings_state()["config"]["meetings"]["consent"],
        Value::Null
    );
    save(
        &engine,
        mistral(true, "https://api.mistral.ai/v1/audio/transcriptions"),
    )
    .unwrap();
    assert_eq!(
        engine.settings_state()["config"]["meetings"]["consent"],
        json!({"provider": "mistral", "host": "api.mistral.ai"})
    );
    assert_eq!(
        h.saved_config().meetings_transcription_consent,
        Some(Consent {
            provider: "mistral".into(),
            host: "api.mistral.ai".into()
        })
    );
    // Another host needs consent again; the form carries it only when the box is ticked.
    save(
        &engine,
        mistral(false, "https://eu.example.com/v1/audio/transcriptions"),
    )
    .unwrap();
    assert_eq!(h.saved_config().meetings_transcription_consent, None);
    // A server on this computer needs none, even with the box ticked.
    save(&engine, json!({"target": "meetings", "provider": "custom", "endpoint": "http://localhost:1234/v1/audio/transcriptions", "model": "whisper", "apiKey": "", "consent": true})).unwrap();
    assert_eq!(h.saved_config().meetings_transcription_consent, None);
    engine.shutdown();
}

#[test]
fn model_lists_use_the_saved_key_only_for_the_saved_provider() {
    let h = Harness::new("models");
    h.config(json!({"rewrite_api_key": SECRET}));
    *lock(&h.speech.models) = vec!["b-model".into(), "A-model".into(), "b-model".into()];
    let engine = h.start();
    let list = engine
        .settings_list_models(json!({"target": "rewriting", "provider": "mistral", "endpoint": "https://api.mistral.ai/v1/chat/completions", "apiKey": null}))
        .unwrap();
    assert_eq!(list, ["A-model", "b-model"], "sorted, without duplicates");
    engine
        .settings_list_models(json!({"target": "rewriting", "provider": "openai", "endpoint": "https://api.openai.com/v1/responses", "apiKey": null}))
        .unwrap();
    let requests = lock(&h.speech.model_requests).clone();
    assert_eq!(requests[0].api_key, SECRET);
    assert_eq!(
        requests[1].api_key, "",
        "the Mistral key never goes to OpenAI"
    );
    assert_eq!(
        code(engine.settings_list_models(
            json!({"target": "rewriting", "provider": "openai", "endpoint": "", "apiKey": "x"})
        )),
        "config"
    );
    assert_eq!(
        engine
            .settings_list_models(json!({"target": "transcription", "provider": "orukeet", "endpoint": "", "apiKey": null}))
            .unwrap(),
        ["orukeet-onnx-int8"]
    );
    engine.shutdown();
}

#[test]
fn model_downloads_report_progress_and_failures() {
    let h = Harness::new("download");
    h.config(json!({}));
    let engine = h.start();
    assert_eq!(
        code(engine.settings_model("nemotron", "download")),
        "invalid_value"
    );
    assert_eq!(
        code(engine.settings_model("whisper", "download")),
        "not_found"
    );
    assert_eq!(
        code(engine.settings_model("orukeet", "remove")),
        "not_removable"
    );
    engine.settings_model("orukeet", "download").unwrap();
    wait_for("the failed download", || {
        engine.settings_state()["models"]["orukeet"]["stage"] == "failed"
    });
    let model = engine.settings_state()["models"]["orukeet"].clone();
    assert_eq!(model["error"], "Checksum mismatch for encoder.int8.onnx.");
    let stages: Vec<Value> = lock(&h.sink.settings)
        .iter()
        .map(|s| s["models"]["orukeet"]["stage"].clone())
        .collect();
    assert!(stages.contains(&json!("downloading")), "{stages:?}");
    assert!(stages.contains(&json!("verifying")), "{stages:?}");
    engine.shutdown();
}

#[test]
fn the_filler_preview_runs_the_real_cleanup() {
    let h = Harness::new("preview");
    h.config(json!({}));
    let engine = h.start();
    let sample = "Um, I think, uh, we should ehm ship it on Tuesday. Er is nog één ding.";
    let cleaned = engine
        .settings_clean_preview(
            json!({"text": sample, "enabled": true, "languages": ["en", "nl"], "custom": ""}),
        )
        .unwrap();
    assert_eq!(
        cleaned,
        voice_core::cleanup::clean(
            sample,
            &voice_core::cleanup::CleanupConfig {
                remove_fillers: true,
                filler_languages: vec!["en".into(), "nl".into()],
                custom_fillers: String::new(),
                corrections: Vec::new(),
            }
        )
    );
    assert!(cleaned.starts_with("I think"), "{cleaned}");
    let untouched = engine
        .settings_clean_preview(
            json!({"text": sample, "enabled": false, "languages": [], "custom": ""}),
        )
        .unwrap();
    assert_eq!(untouched, sample);
    assert_eq!(
        h.saved_config().filler_languages,
        ["en", "nl"],
        "a preview saves nothing"
    );
    engine.shutdown();
}

#[test]
fn the_update_check_reports_each_outcome() {
    let h = Harness::new("updates");
    h.config(json!({}));
    {
        let mut answers = lock(&h.updates.0);
        answers.push_back(Ok(Some("0.2.0".into())));
        answers.push_back(Ok(None));
        answers.push_back(Err("offline".into()));
    }
    let engine = h.start();
    assert_eq!(
        engine.settings_check_updates(),
        json!({"state": "available", "version": "0.2.0"})
    );
    assert_eq!(
        engine.settings_check_updates(),
        json!({"state": "upToDate", "version": null})
    );
    assert_eq!(
        engine.settings_check_updates(),
        json!({"state": "failed", "version": null})
    );
    assert_eq!(engine.settings_state()["updates"]["state"], "failed");
    engine.shutdown();
}

#[test]
fn a_new_token_rewrites_the_discovery_file() {
    let h = Harness::new("token");
    h.config(json!({}));
    let engine = h.start();
    let read = || -> Value {
        serde_json::from_slice(&std::fs::read(h.dir.join("bridge.json")).unwrap()).unwrap()
    };
    let before = read();
    assert_eq!(before["voiceVersion"], "0.1.0-test");
    engine.settings_new_token().unwrap();
    let after = read();
    assert_ne!(after["token"], before["token"]);
    assert_eq!(
        after["instance"], before["instance"],
        "the event log is the same"
    );
    assert_eq!(engine.settings_state()["rukoo"]["port"], after["port"]);
    assert_eq!(
        engine.folder_path(Folder::Bridge),
        Some(h.dir.path().to_path_buf())
    );
    engine.shutdown();
    assert!(
        !h.dir.join("bridge.json").exists(),
        "quitting removes the file"
    );
}

fn ownkey_copy(dir: &TempDir) -> std::path::PathBuf {
    let path = dir.join("ownkey-config.json");
    std::fs::write(
        &path,
        json!({
            "hotkey": "right alt", "rewrite_hotkey": "right ctrl",
            "audio_provider": "mistral", "audio_api_key": SECRET,
            "audio_endpoint": "https://api.mistral.ai/v1/audio/transcriptions", "audio_model": "voxtral-mini-latest",
            "vocabulary": ["Rukoo", "Bart"], "corrections": [{"from": "own key", "to": "Ownkey"}],
            "rewrite_provider": "mistral", "rewrite_api_key": SECRET,
            "meetings_live_transcription_policy": "allow",
            "meetings_retention": "keep"
        })
        .to_string(),
    )
    .unwrap();
    path
}

#[test]
fn the_first_start_of_an_installed_copy_imports_ownkey() {
    let mut h = Harness::new("import");
    h.dev_mode = false;
    let source = ownkey_copy(&h.dir);
    h.ownkey_config = Some(source.clone());
    let before = std::fs::read(&source).unwrap();
    let engine = h.start();
    assert_eq!(
        std::fs::read(&source).unwrap(),
        before,
        "Ownkey's file is only read"
    );
    assert_eq!(engine.settings_start_page().as_deref(), Some("import"));
    assert_eq!(engine.settings_start_page(), None, "only once");
    let cfg = h.saved_config();
    assert_eq!(cfg.hotkey, "right alt");
    assert_eq!(cfg.audio_provider, "mistral");
    assert_eq!(cfg.vocabulary, ["Rukoo", "Bart"]);
    // Ownkey's "same as dictation" became the provider it pointed at, consent included.
    assert_eq!(cfg.meetings_audio_provider, "mistral");
    assert_eq!(
        cfg.meetings_transcription_consent,
        Some(Consent {
            provider: "mistral".into(),
            host: "api.mistral.ai".into()
        })
    );
    let state = engine.settings_state();
    let report = &state["ownkey"]["report"];
    assert_eq!(
        report["hotkeys"],
        json!({"dictation": "right alt", "rewrite": "right ctrl"})
    );
    assert_eq!(report["transcription"]["keyImported"], true);
    assert_eq!(report["dictionary"], json!({"words": 2, "corrections": 1}));
    assert_eq!(report["meetings"]["provider"], "mistral");
    assert_eq!(report["meetings"]["consent"], true);
    assert_eq!(report["meetings"]["retention"], "keep");
    assert_eq!(
        report["fillers"],
        Value::Null,
        "Ownkey's file had no filler settings"
    );
    assert_eq!(report["skipped"], json!(["summaries"]));
    assert_eq!(state["ownkey"]["configFound"], true);
    assert_eq!(state["ownkey"]["keys"], json!(["right alt", "right ctrl"]));
    assert!(state["ownkey"]["lastImport"].as_u64().is_some());
    assert!(!state.to_string().contains(SECRET));
    // Importing again from Settings works the same way.
    let again = engine.settings_import_ownkey().unwrap();
    assert_eq!(again["dictionary"]["words"], 2);
    engine.shutdown();
}

#[test]
fn a_development_copy_imports_only_on_request_and_keeps_its_keys() {
    let mut h = Harness::new("import-dev");
    let source = ownkey_copy(&h.dir);
    h.ownkey_config = Some(source.clone());
    let engine = h.start();
    assert_eq!(
        h.saved_config().audio_provider,
        "orukeet",
        "no automatic import in dev mode"
    );
    assert_eq!(engine.settings_start_page(), None);
    engine.shutdown();

    h.import_from = Some(source);
    let engine = h.start();
    let cfg = h.saved_config();
    assert_eq!(cfg.audio_provider, "mistral");
    assert_eq!(
        (cfg.hotkey.as_str(), cfg.rewrite_hotkey.as_str()),
        ("f13", "f14")
    );
    assert_eq!(
        engine.settings_state()["ownkey"]["report"]["hotkeys"],
        Value::Null
    );
    engine.shutdown();
}

#[test]
fn a_missing_ownkey_config_is_not_found() {
    let mut h = Harness::new("import-missing");
    h.dev_mode = false;
    h.ownkey_config = Some(h.dir.join("nope.json"));
    let engine = h.start();
    assert_eq!(code(engine.settings_import_ownkey()), "not_found");
    engine.shutdown();
}

#[test]
fn a_damaged_config_is_kept_aside_and_voice_starts_with_defaults() {
    let h = Harness::new("damaged");
    std::fs::create_dir_all(h.data()).unwrap();
    std::fs::write(h.data().join("config.json"), b"{ not json").unwrap();
    let engine = h.start();
    let note = h.sink.wait_note("app.notify.settings");
    assert!(note.body.contains("damaged"), "{}", note.body);
    assert_eq!(
        engine.settings_state()["config"]["dictation"]["hotkey"],
        "f13"
    );
    let kept = std::fs::read_dir(h.data())
        .unwrap()
        .filter_map(|e| e.ok())
        .any(|e| {
            e.file_name()
                .to_string_lossy()
                .starts_with("config.damaged-")
        });
    assert!(kept);
    engine.shutdown();
}

#[test]
fn folders_point_into_the_data_folder() {
    let h = Harness::new("folders");
    h.config(json!({}));
    let engine = h.start();
    assert_eq!(
        engine.folder_path(Folder::Logs),
        Some(h.data().join("logs"))
    );
    assert_eq!(
        engine.folder_path(Folder::Recordings),
        Some(h.data().join("meetings"))
    );
    assert_eq!(
        engine.folder_path(Folder::Models),
        Some(h.data().join("models"))
    );
    engine
        .settings_set_folder("models", h.dir.join("chosen"))
        .unwrap();
    assert_eq!(
        engine.folder_path(Folder::Models),
        Some(h.dir.join("chosen"))
    );
    assert_eq!(
        engine.settings_state()["config"]["local"]["modelFolder"],
        h.dir.join("chosen").display().to_string()
    );
    engine.shutdown();
}
