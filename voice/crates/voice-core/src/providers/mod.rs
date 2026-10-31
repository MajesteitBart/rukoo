//! Speech-to-text and rewrite providers, ported from Ownkey's `providers.py`.
//!
//! Every request shape, header and response rule follows Ownkey; the places where Voice
//! deliberately differs carry a comment saying so.

mod cloud;
pub(crate) mod http;
mod models;
mod multipart;
mod rewrite;
mod urls;
mod wav;

use std::fmt;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::local::LocalEngine;

pub use models::list_models;
pub use urls::{endpoint_host, endpoint_reachable, is_local_host};
pub use wav::wav_bytes;

/// The model id Ownkey and Voice store for the local Orukeet model.
pub const ORUKEET_MODEL_ID: &str = "orukeet-onnx-int8";

/// Dictation and spoken rewrite instructions (`ownkey.py`, `timeout=30`).
pub const DICTATION_TIMEOUT: Duration = Duration::from_secs(30);
/// Meeting windows of up to 28 seconds (`meetings/service.py:210-211`).
pub const MEETING_TIMEOUT: Duration = Duration::from_secs(180);
/// Model lists in Settings (`list_available_models(..., timeout=15)`).
pub const MODELS_TIMEOUT: Duration = Duration::from_secs(15);
/// How often the app checks that the audio endpoint answers, and how long one check waits
/// (`ownkey.py:235`, `571-581`).
pub const CONNECTION_CHECK_INTERVAL: Duration = Duration::from_secs(12);
pub const CONNECTION_CHECK_TIMEOUT: Duration = Duration::from_millis(1500);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ProviderId {
    OpenAi,
    Anthropic,
    Google,
    Mistral,
    Ollama,
    OpenRouter,
    Custom,
    Orukeet,
}

pub struct Preset {
    pub id: ProviderId,
    pub key: &'static str,
    pub label: &'static str,
    pub audio_endpoints: &'static [&'static str],
    /// The first one is the default.
    pub rewrite_endpoints: &'static [&'static str],
    pub models_endpoint: &'static str,
    pub local_audio: bool,
}

/// The order is significant: it is the order of the provider lists in Settings.
pub const PRESETS: [Preset; 8] = [
    Preset {
        id: ProviderId::OpenAi,
        key: "openai",
        label: "OpenAI",
        audio_endpoints: &["https://api.openai.com/v1/audio/transcriptions"],
        // GPT 5.5 and later only speak the Responses API (Ownkey issue #1), so it comes first.
        rewrite_endpoints: &[
            "https://api.openai.com/v1/responses",
            "https://api.openai.com/v1/chat/completions",
        ],
        models_endpoint: "https://api.openai.com/v1/models",
        local_audio: false,
    },
    Preset {
        id: ProviderId::Anthropic,
        key: "anthropic",
        label: "Anthropic",
        audio_endpoints: &[],
        rewrite_endpoints: &["https://api.anthropic.com/v1/messages"],
        models_endpoint: "https://api.anthropic.com/v1/models",
        local_audio: false,
    },
    Preset {
        id: ProviderId::Google,
        key: "google",
        label: "Google",
        audio_endpoints: &[
            "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
        ],
        rewrite_endpoints: &[
            "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
        ],
        models_endpoint: "https://generativelanguage.googleapis.com/v1beta/models",
        local_audio: false,
    },
    Preset {
        id: ProviderId::Mistral,
        key: "mistral",
        label: "Mistral",
        audio_endpoints: &["https://api.mistral.ai/v1/audio/transcriptions"],
        rewrite_endpoints: &["https://api.mistral.ai/v1/chat/completions"],
        models_endpoint: "https://api.mistral.ai/v1/models",
        local_audio: false,
    },
    Preset {
        id: ProviderId::Ollama,
        key: "ollama",
        label: "Ollama",
        audio_endpoints: &[],
        rewrite_endpoints: &[
            "http://localhost:11434/api/chat",
            "https://ollama.com/api/chat",
        ],
        models_endpoint: "http://localhost:11434/api/tags",
        local_audio: false,
    },
    Preset {
        id: ProviderId::OpenRouter,
        key: "openrouter",
        label: "OpenRouter",
        audio_endpoints: &[],
        rewrite_endpoints: &["https://openrouter.ai/api/v1/chat/completions"],
        models_endpoint: "https://openrouter.ai/api/v1/models",
        local_audio: false,
    },
    Preset {
        id: ProviderId::Custom,
        key: "custom",
        label: "Custom (OpenAI-compatible)",
        audio_endpoints: &["http://localhost:1234/v1/audio/transcriptions"],
        rewrite_endpoints: &["http://localhost:1234/v1/chat/completions"],
        models_endpoint: "http://localhost:1234/v1/models",
        local_audio: false,
    },
    Preset {
        id: ProviderId::Orukeet,
        key: "orukeet",
        label: "Local (Orukeet)",
        audio_endpoints: &[],
        rewrite_endpoints: &[],
        models_endpoint: "",
        local_audio: true,
    },
];

/// Providers with an audio endpoint or a local model, in preset order.
pub const AUDIO_PROVIDER_IDS: [&str; 5] = ["openai", "google", "mistral", "custom", "orukeet"];
/// Providers with a rewrite endpoint, in preset order.
pub const REWRITE_PROVIDER_IDS: [&str; 7] = [
    "openai",
    "anthropic",
    "google",
    "mistral",
    "ollama",
    "openrouter",
    "custom",
];

impl ProviderId {
    pub fn parse(id: &str) -> Option<ProviderId> {
        PRESETS
            .iter()
            .find(|preset| preset.key == id)
            .map(|preset| preset.id)
    }

    pub fn preset(self) -> &'static Preset {
        PRESETS
            .iter()
            .find(|preset| preset.id == self)
            .expect("every id has a preset")
    }

    pub fn as_str(self) -> &'static str {
        self.preset().key
    }

    pub fn label(self) -> &'static str {
        self.preset().label
    }

    pub fn supports_audio(self) -> bool {
        AUDIO_PROVIDER_IDS.contains(&self.as_str())
    }

    pub fn supports_rewrite(self) -> bool {
        REWRITE_PROVIDER_IDS.contains(&self.as_str())
    }
}

impl fmt::Display for ProviderId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Activity {
    Audio,
    Rewrite,
}

/// A provider id from an id or a display label, case-insensitive and trimmed; `fallback` otherwise.
pub fn normalize_provider(value: &str, fallback: &str) -> String {
    let value = value.trim().to_lowercase();
    if let Some(preset) = PRESETS.iter().find(|preset| preset.key == value) {
        return preset.key.to_string();
    }
    if let Some(preset) = PRESETS
        .iter()
        .find(|preset| preset.label.to_lowercase() == value)
    {
        return preset.key.to_string();
    }
    fallback.to_string()
}

/// The label of a provider id or label; unknown values read as Mistral, as in Ownkey.
pub fn provider_label(provider: &str) -> &'static str {
    ProviderId::parse(&normalize_provider(provider, "mistral")).map_or("Mistral", ProviderId::label)
}

pub fn provider_endpoints(provider: &str, activity: Activity) -> &'static [&'static str] {
    let Some(id) = ProviderId::parse(&normalize_provider(provider, "mistral")) else {
        return &[];
    };
    match activity {
        Activity::Audio => id.preset().audio_endpoints,
        Activity::Rewrite => id.preset().rewrite_endpoints,
    }
}

pub fn default_endpoint(provider: &str, activity: Activity) -> &'static str {
    provider_endpoints(provider, activity)
        .first()
        .copied()
        .unwrap_or("")
}

/// The provider an old Ownkey config meant with its single shared endpoint. Only the config
/// migration uses this.
pub fn provider_from_endpoint(endpoint: &str, fallback: &str) -> String {
    let parts = urls::split(endpoint.trim());
    let host = parts.hostname();
    let path = parts.path.trim_end_matches('/').to_lowercase();
    let id = if host.contains("anthropic") {
        "anthropic"
    } else if host.contains("generativelanguage.googleapis") {
        "google"
    } else if host.contains("mistral") {
        "mistral"
    } else if host == "openrouter.ai" {
        "openrouter"
    } else if host.contains("openai") {
        "openai"
    } else if !host.is_empty()
        && ["/chat/completions", "/responses", "/audio/transcriptions"]
            .iter()
            .any(|suffix| path.ends_with(suffix))
    {
        "custom"
    } else if ["localhost", "127.0.0.1", "::1", "ollama.com"].contains(&host.as_str())
        || host.contains("ollama")
    {
        "ollama"
    } else {
        return fallback.to_string();
    };
    id.to_string()
}

/// Whether Voice refuses a request when no API key is set.
pub fn provider_requires_key(provider: &str, endpoint: &str) -> bool {
    match normalize_provider(provider, "mistral").as_str() {
        "custom" | "orukeet" => false,
        "ollama" => endpoint_host(endpoint) == "ollama.com",
        _ => true,
    }
}

/// Auth headers for a provider. An empty or blank key sends none; keys never go into URLs.
pub fn auth_headers(provider: &str, api_key: &str) -> Vec<(&'static str, String)> {
    let key = api_key.trim();
    let mut headers = Vec::new();
    match normalize_provider(provider, "mistral").as_str() {
        "anthropic" => {
            headers.push(("anthropic-version", "2023-06-01".to_string()));
            if !key.is_empty() {
                headers.push(("x-api-key", key.to_string()));
            }
        }
        "google" => {
            if !key.is_empty() {
                headers.push(("x-goog-api-key", key.to_string()));
            }
        }
        _ => {
            if !key.is_empty() {
                headers.push(("Authorization", format!("Bearer {key}")));
            }
        }
    }
    headers
}

/// The Gemini `generateContent` URL for a model.
pub fn model_url(endpoint: &str, model: &str) -> String {
    let model = model.trim();
    let model = model.strip_prefix("models/").unwrap_or(model);
    let encoded = urls::quote(model, "-._:");
    if endpoint.contains("{model}") {
        endpoint.replace("{model}", &encoded)
    } else {
        format!(
            "{}/models/{encoded}:generateContent",
            endpoint.trim_end_matches('/')
        )
    }
}

/// The model-list URL for an activity endpoint, including custom and self-hosted base URLs.
pub fn models_endpoint(provider: &str, activity_endpoint: &str) -> String {
    let id = normalize_provider(provider, "mistral");
    let endpoint = activity_endpoint.trim();
    if endpoint.is_empty() {
        return ProviderId::parse(&id)
            .map_or("", |id| id.preset().models_endpoint)
            .to_string();
    }
    match id.as_str() {
        "openai" | "custom" => urls::replace_path_suffix(
            endpoint,
            &["/audio/transcriptions", "/chat/completions", "/responses"],
            "/models",
        ),
        "mistral" | "openrouter" => urls::replace_path_suffix(
            endpoint,
            &["/audio/transcriptions", "/chat/completions"],
            "/models",
        ),
        "anthropic" => urls::replace_path_suffix(endpoint, &["/messages"], "/models"),
        "google" => {
            let parts = urls::split(endpoint);
            let path = match parts.path.find("/models") {
                Some(at) => format!("{}/models", &parts.path[..at]),
                None => format!("{}/models", parts.path.trim_end_matches('/')),
            };
            parts.with_path(&path)
        }
        _ => urls::replace_path_suffix(endpoint, &["/api/chat"], "/api/tags"),
    }
}

/// Ownkey's `describe_api_error`: keeps the provider's own explanation of a failed request.
/// `status` is None when no response arrived.
pub fn describe_api_error(status: Option<u16>, reason: Option<&str>, body: &str) -> String {
    let Some(status) = status else {
        return "API request failed. No response was received.".to_string();
    };
    let mut message = String::new();
    if let Ok(serde_json::Value::Object(payload)) = serde_json::from_str::<serde_json::Value>(body)
    {
        let detail = match payload.get("error") {
            Some(detail) => detail.clone(),
            None => serde_json::Value::Object(payload.clone()),
        };
        match detail {
            serde_json::Value::Object(detail) => {
                message = match detail.get("message") {
                    Some(serde_json::Value::String(text)) => text.clone(),
                    Some(serde_json::Value::Null) | Some(serde_json::Value::Bool(false)) | None => {
                        String::new()
                    }
                    Some(other) => other.to_string(),
                };
            }
            serde_json::Value::String(text) => message = text,
            _ => {}
        }
    }
    if message.is_empty() {
        message = body.trim().to_string();
    }
    if message.is_empty() {
        message = reason
            .filter(|r| !r.is_empty())
            .unwrap_or("Request rejected")
            .to_string();
    }
    let short: String = crate::cleanup::collapse_whitespace(&message)
        .chars()
        .take(220)
        .collect();
    format!("API error {status}: {short}")
}

/// What kind of failure a provider call had, so the app can tell a missing key from a network
/// problem without reading the message.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorKind {
    Auth,
    Network,
    Timeout,
    Provider,
    Config,
    LocalMissingModel,
}

impl ErrorKind {
    pub fn as_str(self) -> &'static str {
        match self {
            ErrorKind::Auth => "auth",
            ErrorKind::Network => "network",
            ErrorKind::Timeout => "timeout",
            ErrorKind::Provider => "provider",
            ErrorKind::Config => "config",
            ErrorKind::LocalMissingModel => "local_missing_model",
        }
    }
}

/// A failed provider call. `message` is English and fit to show the user as is.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderError {
    pub kind: ErrorKind,
    pub message: String,
}

impl ProviderError {
    pub fn new(kind: ErrorKind, message: impl Into<String>) -> ProviderError {
        ProviderError {
            kind,
            message: message.into(),
        }
    }

    pub fn config(message: impl Into<String>) -> ProviderError {
        ProviderError::new(ErrorKind::Config, message)
    }

    pub fn provider(message: impl Into<String>) -> ProviderError {
        ProviderError::new(ErrorKind::Provider, message)
    }
}

impl fmt::Display for ProviderError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for ProviderError {}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Hints {
    /// Dictionary words the recognizer should prefer.
    pub vocabulary: Vec<String>,
    /// An ISO 639-1 code; None or "auto" lets the provider detect it.
    pub language: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Recognized {
    pub text: String,
    pub language: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RewriteRequest {
    pub system: String,
    pub user: String,
    /// An output budget for long jobs; None keeps the short-rewrite defaults.
    pub max_tokens: Option<u32>,
}

pub trait SpeechToText: Send + Sync {
    /// pcm: 16 kHz mono i16. Returns plain text (may be empty) and an optional language.
    fn transcribe(&self, pcm: &[i16], hints: &Hints) -> Result<Recognized, ProviderError>;
}

pub trait Rewriter: Send + Sync {
    /// The rewritten text; empty when the model returned nothing.
    fn rewrite(&self, req: &RewriteRequest) -> Result<String, ProviderError>;
}

/// Which part of Voice the settings belong to, so errors point at the right Settings page.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Purpose {
    #[default]
    Dictation,
    Meetings,
    Rewrite,
}

/// One provider choice: the provider, its key, endpoint and model.
#[derive(Clone, PartialEq)]
pub struct ProviderConfig {
    pub provider: String,
    pub api_key: String,
    pub endpoint: String,
    pub model: String,
    pub timeout: Duration,
    pub purpose: Purpose,
}

pub type AudioProviderConfig = ProviderConfig;
pub type RewriteProviderConfig = ProviderConfig;

impl Default for ProviderConfig {
    fn default() -> Self {
        ProviderConfig {
            provider: String::new(),
            api_key: String::new(),
            endpoint: String::new(),
            model: String::new(),
            timeout: DICTATION_TIMEOUT,
            purpose: Purpose::Dictation,
        }
    }
}

impl fmt::Debug for ProviderConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ProviderConfig")
            .field("provider", &self.provider)
            .field("api_key", &redacted(&self.api_key))
            .field("endpoint", &self.endpoint)
            .field("model", &self.model)
            .field("timeout", &self.timeout)
            .field("purpose", &self.purpose)
            .finish()
    }
}

pub(crate) fn redacted(key: &str) -> &'static str {
    if key.is_empty() {
        ""
    } else {
        "<redacted>"
    }
}

fn audio_settings_page(purpose: Purpose) -> &'static str {
    match purpose {
        Purpose::Meetings => "Settings > Meetings > Transcription",
        _ => "Settings > Transcription",
    }
}

/// The recognizer for a provider choice. Orukeet runs on `local` and never falls back to a
/// cloud provider; every other choice is checked here, before any audio is recorded or sent.
pub fn speech_to_text(
    cfg: &AudioProviderConfig,
    local: &LocalEngine,
) -> Result<Box<dyn SpeechToText>, ProviderError> {
    let page = audio_settings_page(cfg.purpose);
    // Differs from Ownkey on purpose: an unknown provider is an error, not silently Mistral.
    let Some(id) = ProviderId::parse(&normalize_provider(&cfg.provider, "")) else {
        return Err(ProviderError::config(format!(
            "Choose a transcription provider in {page}."
        )));
    };
    if id == ProviderId::Orukeet {
        return Ok(Box::new(local.clone()));
    }
    if !id.supports_audio() {
        return Err(ProviderError::config(format!(
            "{} does not provide a supported audio transcription API.",
            id.label()
        )));
    }
    if cfg.model.trim().is_empty() {
        return Err(ProviderError::config("Select an audio model in Settings."));
    }
    if cfg.endpoint.trim().is_empty() {
        return Err(ProviderError::config(format!(
            "Choose an audio endpoint in {page}."
        )));
    }
    if provider_requires_key(id.as_str(), &cfg.endpoint) && cfg.api_key.trim().is_empty() {
        let message = match cfg.purpose {
            Purpose::Meetings => {
                format!("No API key set for meeting transcription. Open {page} and add a key.")
            }
            _ => "No audio API key set. Open Settings > Transcription and add a key.".to_string(),
        };
        return Err(ProviderError::new(ErrorKind::Auth, message));
    }
    Ok(Box::new(cloud::CloudSpeech::new(id, cfg)))
}

/// The rewriter for a provider choice, checked before any text is sent.
pub fn rewriter(cfg: &RewriteProviderConfig) -> Result<Box<dyn Rewriter>, ProviderError> {
    // An unknown or retired provider (such as Ownkey's local_rewrite) is refused, never guessed.
    let id = ProviderId::parse(&normalize_provider(&cfg.provider, ""))
        .filter(|id| id.supports_rewrite());
    let Some(id) = id else {
        return Err(ProviderError::config(
            "This provider does not support rewriting.",
        ));
    };
    if cfg.model.trim().is_empty() {
        return Err(ProviderError::config("Select a rewrite model in Settings."));
    }
    if cfg.endpoint.trim().is_empty() {
        return Err(ProviderError::config(
            "Choose a rewrite endpoint in Settings > Rewriting.",
        ));
    }
    // Differs from Ownkey on purpose: auto-rewrite now gets the same key check as a voice edit,
    // instead of sending an unauthenticated request and failing with a 401.
    if provider_requires_key(id.as_str(), &cfg.endpoint) && cfg.api_key.trim().is_empty() {
        return Err(ProviderError::new(
            ErrorKind::Auth,
            "No rewrite API key set. Open Settings > Rewriting and add a key.",
        ));
    }
    Ok(Box::new(rewrite::CloudRewriter::new(id, cfg)))
}
