//! One API key per provider: the migration from per-feature keys, what each feature then sends,
//! and config files that a Voice from before `api_keys` reads or wrote.

mod support;

use serde_json::{json, Value};
use support::TempDir;
use voice_core::config::Config;
use voice_core::providers::Purpose;

const MISTRAL_AUDIO: &str = "https://api.mistral.ai/v1/audio/transcriptions";
const MISTRAL_CHAT: &str = "https://api.mistral.ai/v1/chat/completions";

fn load(value: Value) -> Config {
    Config::from_value(&value, false)
}

/// All three features on Mistral, with the keys given (dictation, rewriting, meetings).
fn on_mistral(dictation: &str, rewriting: &str, meetings: &str) -> Value {
    json!({
        "audio_provider": "mistral",
        "audio_api_key": dictation,
        "audio_endpoint": MISTRAL_AUDIO,
        "audio_model": "voxtral-mini-latest",
        "rewrite_provider": "mistral",
        "rewrite_api_key": rewriting,
        "rewrite_endpoint": MISTRAL_CHAT,
        "rewrite_model": "mistral-small-latest",
        "meetings_audio_provider": "mistral",
        "meetings_audio_api_key": meetings,
        "meetings_audio_endpoint": MISTRAL_AUDIO,
        "meetings_audio_model": "voxtral-mini-latest"
    })
}

/// The key each feature sends, as the providers get it.
fn sent(cfg: &Config) -> (String, String, String) {
    (
        cfg.dictation_audio().api_key,
        cfg.rewrite().api_key,
        cfg.meeting_audio().api_key,
    )
}

fn sent_by_all(key: &str) -> (String, String, String) {
    (key.into(), key.into(), key.into())
}

#[test]
fn three_copies_of_one_key_become_the_provider_s_key() {
    let cfg = load(on_mistral("sk-same", "sk-same", "sk-same"));
    assert_eq!(cfg.shared_key("mistral"), "sk-same");
    assert_eq!(cfg.api_keys.len(), 1);
    assert_eq!(sent(&cfg), sent_by_all("sk-same"));
    for feature in [Purpose::Dictation, Purpose::Rewrite, Purpose::Meetings] {
        assert!(!cfg.has_own_key(feature), "{feature:?}");
    }
}

#[test]
fn different_keys_for_one_provider_all_keep_working() {
    let mut cfg = load(on_mistral("sk-dictation", "sk-rewriting", "sk-meetings"));
    // Dictation's key becomes Mistral's key; the others keep their own, so nothing is lost and
    // nothing stops working.
    assert_eq!(cfg.shared_key("mistral"), "sk-dictation");
    assert_eq!(
        sent(&cfg),
        (
            "sk-dictation".into(),
            "sk-rewriting".into(),
            "sk-meetings".into()
        )
    );
    assert!(!cfg.has_own_key(Purpose::Dictation));
    assert!(cfg.has_own_key(Purpose::Rewrite));
    assert!(cfg.has_own_key(Purpose::Meetings));

    // A feature can switch to the shared key.
    cfg.drop_own_key(Purpose::Meetings);
    assert_eq!(cfg.meeting_audio().api_key, "sk-dictation");
    assert!(!cfg.has_own_key(Purpose::Meetings));
    assert!(cfg.has_own_key(Purpose::Rewrite));

    // A key saved in Settings > API keys is the one key for Mistral, for every feature.
    assert!(cfg.set_shared_key("mistral", " sk-new "));
    assert_eq!(cfg.shared_key("mistral"), "sk-new");
    assert_eq!(sent(&cfg), sent_by_all("sk-new"));
    assert!(!cfg.has_own_key(Purpose::Rewrite));
}

#[test]
fn a_config_without_keys_stays_without_keys() {
    let cfg = load(on_mistral("", "", ""));
    assert!(cfg.api_keys.is_empty());
    assert_eq!(sent(&cfg), sent_by_all(""));
    let cfg = load(json!({}));
    assert!(cfg.api_keys.is_empty());
    assert_eq!(cfg, Config::defaults(false));
}

#[test]
fn one_feature_s_key_serves_the_others_on_that_provider() {
    // The tester's case: a key entered for one feature, the others on the same provider without.
    let cfg = load(on_mistral("", "", "sk-meetings"));
    assert_eq!(cfg.shared_key("mistral"), "sk-meetings");
    assert_eq!(sent(&cfg), sent_by_all("sk-meetings"));
}

#[test]
fn a_key_never_goes_to_another_provider() {
    let cfg = load(json!({
        "audio_provider": "openai",
        "audio_api_key": "sk-openai",
        "audio_endpoint": "https://api.openai.com/v1/audio/transcriptions",
        "audio_model": "whisper-1",
        "rewrite_provider": "mistral",
        "rewrite_api_key": "",
        "meetings_audio_provider": "orukeet"
    }));
    assert_eq!(cfg.shared_key("openai"), "sk-openai");
    assert_eq!(cfg.shared_key("mistral"), "");
    assert_eq!(cfg.rewrite().api_key, "");
    assert_eq!(cfg.meeting_audio().api_key, "");
}

#[test]
fn custom_servers_keep_a_key_per_feature() {
    let cfg = load(json!({
        "audio_provider": "custom",
        "audio_api_key": "server-a",
        "audio_endpoint": "http://localhost:1234/v1/audio/transcriptions",
        "audio_model": "whisper",
        "rewrite_provider": "custom",
        "rewrite_api_key": "server-b",
        "rewrite_endpoint": "http://example.test/v1/chat/completions",
        "rewrite_model": "llama"
    }));
    assert!(
        cfg.api_keys.is_empty(),
        "a custom server isn't one provider"
    );
    assert_eq!(cfg.dictation_audio().api_key, "server-a");
    assert_eq!(cfg.rewrite().api_key, "server-b");
    assert!(!cfg.has_own_key(Purpose::Dictation));
}

#[test]
fn switching_a_feature_brings_that_provider_s_key() {
    let mut cfg = Config::defaults(false);
    cfg.set_shared_key("openai", "sk-openai");
    cfg.set_shared_key("mistral", "sk-mistral");
    assert_eq!(cfg.dictation_audio().api_key, "sk-mistral");
    cfg.switch_audio_provider("openai");
    assert_eq!(cfg.dictation_audio().api_key, "sk-openai");
    cfg.switch_audio_provider("custom");
    assert_eq!(
        cfg.dictation_audio().api_key,
        "",
        "never carried to a custom server"
    );
    cfg.switch_audio_provider("orukeet");
    assert_eq!(cfg.dictation_audio().api_key, "");
    cfg.switch_meeting_provider("mistral");
    assert_eq!(cfg.meeting_audio().api_key, "sk-mistral");
    // Custom and Orukeet have no key in API keys.
    assert!(!cfg.set_shared_key("custom", "x"));
    assert!(!cfg.set_shared_key("orukeet", "x"));
    assert!(!cfg.api_keys.contains_key("custom"));
}

#[test]
fn removing_a_provider_s_key_removes_it_everywhere_for_good() {
    let dir = TempDir::new("api-keys-remove");
    let mut cfg = load(on_mistral("sk-dictation", "sk-rewriting", ""));
    cfg.set_shared_key("mistral", "");
    assert!(cfg.api_keys.is_empty());
    assert_eq!(sent(&cfg), sent_by_all(""), "own keys go too");
    cfg.save(dir.path()).unwrap();
    let loaded = Config::load_as(dir.path(), false).unwrap();
    assert_eq!(sent(&loaded), sent_by_all(""), "nothing brings it back");
}

#[test]
fn an_older_voice_reads_the_key_each_feature_sends() {
    let dir = TempDir::new("api-keys-old-reader");
    let mut cfg = load(on_mistral("", "", ""));
    cfg.set_shared_key("mistral", "sk-mistral");
    cfg.save(dir.path()).unwrap();
    let raw: Value =
        serde_json::from_slice(&std::fs::read(dir.join("config.json")).unwrap()).unwrap();
    // A Voice from before api_keys reads only these, and finds a working key in each.
    assert_eq!(raw["audio_api_key"], "sk-mistral");
    assert_eq!(raw["rewrite_api_key"], "sk-mistral");
    assert_eq!(raw["meetings_audio_api_key"], "sk-mistral");
    assert_eq!(raw["api_keys"], json!({ "mistral": "sk-mistral" }));
    assert_eq!(raw["version"], 1, "the file stays readable by every Voice");
    assert_eq!(Config::load_as(dir.path(), false).unwrap(), cfg);
}

#[test]
fn what_an_older_voice_wrote_comes_back_without_losing_a_key() {
    // An older Voice keeps api_keys as an unknown key and may have changed a feature's key.
    let mut raw = on_mistral("sk-changed", "sk-mistral", "");
    raw["api_keys"] = json!({ "mistral": "sk-mistral", "newcloud": "sk-from-a-newer-voice" });
    let cfg = load(raw);
    assert_eq!(cfg.dictation_audio().api_key, "sk-changed");
    assert!(cfg.has_own_key(Purpose::Dictation));
    assert_eq!(cfg.rewrite().api_key, "sk-mistral");
    assert_eq!(
        cfg.meeting_audio().api_key,
        "sk-mistral",
        "a feature without a key gets its provider's key"
    );
    // A provider this Voice doesn't know keeps its key through a round trip.
    let dir = TempDir::new("api-keys-unknown-provider");
    cfg.save(dir.path()).unwrap();
    let loaded = Config::load_as(dir.path(), false).unwrap();
    assert_eq!(loaded.shared_key("newcloud"), "sk-from-a-newer-voice");
}

#[test]
fn a_damaged_api_keys_entry_never_costs_the_other_settings() {
    for broken in [json!("oops"), json!(42), json!(["sk"]), json!(null)] {
        let mut raw = on_mistral("sk-dictation", "", "");
        raw["hotkey"] = json!("f15");
        raw["api_keys"] = broken.clone();
        let cfg = load(raw);
        assert_eq!(cfg.hotkey, "f15", "{broken}");
        assert_eq!(cfg.shared_key("mistral"), "sk-dictation", "{broken}");
        assert_eq!(sent(&cfg), sent_by_all("sk-dictation"), "{broken}");
    }
    let cfg = load(json!({
        "api_keys": { "Mistral": 5, "OpenAI": "  sk-openai  ", "google": "", "anthropic": {"k": 1} }
    }));
    assert_eq!(cfg.shared_key("openai"), "sk-openai");
    assert_eq!(cfg.api_keys.len(), 1, "{:?}", cfg.api_keys.keys());
}

#[test]
fn debug_output_never_shows_a_provider_s_key() {
    let mut cfg = Config::defaults(false);
    cfg.set_shared_key("openai", "sk-openai-secret");
    cfg.set_shared_key("mistral", "sk-mistral-secret");
    let text = format!("{cfg:?}");
    assert!(!text.contains("secret"), "{text}");
    assert!(text.contains("\"openai\":\"<redacted>\""), "{text}");
}
