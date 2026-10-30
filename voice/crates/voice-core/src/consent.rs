//! Consent for sending meeting audio to a cloud provider (decision 10).
//!
//! Ownkey asked in its meeting window before the first upload. Voice has no meeting window, so
//! Settings shows the disclosure when the user picks a cloud provider and stores the agreement
//! as `{provider, host}`. Without it a meeting still records; transcription waits.

use serde::Serialize;

use crate::providers::{
    endpoint_host, is_local_host, normalize_provider, ProviderConfig, ProviderId,
};

use crate::config::Consent;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum ConsentState {
    /// Audio stays on this computer: Orukeet, or a server on a local host.
    NotNeeded,
    Granted,
    /// Transcription waits until the user agrees to send audio to this provider and host.
    Required {
        provider: String,
        label: String,
        host: String,
    },
}

/// What Settings shows before the user agrees, adapted from Ownkey's upload disclosure
/// (`meetings/service.py:213-226`). English; the UI may translate from the fields.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Disclosure {
    pub provider: String,
    pub label: String,
    pub model: String,
    pub host: String,
    pub title: String,
    pub intro: String,
    pub sent: Vec<String>,
    pub not_sent: Vec<String>,
    pub retention: String,
    /// The checkbox the user ticks to agree.
    pub agree: String,
}

/// Ownkey's `CLOUD_WINDOW_NOTE`.
pub const CLOUD_WINDOW_NOTE: &str = "windows of up to 28 seconds";

fn cloud_target(cfg: &ProviderConfig) -> Option<(ProviderId, String)> {
    let id = ProviderId::parse(&normalize_provider(&cfg.provider, ""))?;
    if id == ProviderId::Orukeet || !id.supports_audio() {
        return None;
    }
    let host = endpoint_host(&cfg.endpoint);
    if is_local_host(&host) {
        return None;
    }
    Some((id, host))
}

pub fn state(cfg: &ProviderConfig, consent: Option<&Consent>) -> ConsentState {
    let Some((id, host)) = cloud_target(cfg) else {
        return ConsentState::NotNeeded;
    };
    match consent {
        Some(consent) if consent.provider == id.as_str() && consent.host == host => {
            ConsentState::Granted
        }
        _ => ConsentState::Required {
            provider: id.as_str().to_string(),
            label: id.label().to_string(),
            host,
        },
    }
}

pub fn disclosure(cfg: &ProviderConfig) -> Option<Disclosure> {
    let (id, host) = cloud_target(cfg)?;
    let label = id.label();
    Some(Disclosure {
        provider: id.as_str().to_string(),
        label: label.to_string(),
        model: cfg.model.trim().to_string(),
        host: host.clone(),
        title: format!("Voice will send meeting audio to {label}"),
        intro: format!(
            "Voice transcribes a meeting while it records, with the provider you chose in Settings. The recorded tracks go to {label} in {CLOUD_WINDOW_NOTE}, over your own key. Pausing stops sending new audio. Choose On this computer (Orukeet) in Settings > Meetings > Transcription to keep the audio here."
        ),
        sent: vec![format!("Every recorded track, microphone and call audio, as WAV in {CLOUD_WINDOW_NOTE}")],
        not_sent: vec!["Screen recordings".to_string(), "Your notes and agent chats in Rukoo".to_string()],
        retention: "What the provider keeps is set by its data policy; Voice has no control after upload.".to_string(),
        agree: format!("Send meeting audio to {label} at {host}"),
    })
}
