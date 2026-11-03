//! Streaming meeting transcription: a provider that takes audio continuously and returns text, and
//! speaker labels when asked, as the meeting records. Only Mistral's realtime model streams.
//! Frozen: the realtime client, the stream follower in voice-meetings and their fakes build on it.

use std::time::Duration;

use super::{ProviderConfig, ProviderError, ProviderId};

pub const REALTIME_MODEL_PREFIX: &str = "voxtral-mini-transcribe-realtime";

/// Whether this meeting provider streams: Mistral with a realtime model.
pub fn streams(cfg: &ProviderConfig) -> bool {
    ProviderId::parse(&super::normalize_provider(&cfg.provider, "")) == Some(ProviderId::Mistral)
        && cfg.model.trim().starts_with(REALTIME_MODEL_PREFIX)
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct StreamSession {
    pub diarize: bool,
    pub language: Option<String>,
    pub context_bias: Vec<String>,
    pub delay_ms: u32,
    /// Name and WAV bytes per known voice, sent as `speaker_references`.
    pub references: Vec<(String, Vec<u8>)>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum StreamEvent {
    Segment {
        text: String,
        speaker: Option<String>,
        start: Option<f64>,
        end: Option<f64>,
    },
    Done,
}

pub trait SpeechStream: Send {
    fn push(&mut self, pcm: &[i16]) -> Result<(), ProviderError>;
    /// Events received so far; waits at most `wait` for the first.
    fn poll(&mut self, wait: Duration) -> Result<Vec<StreamEvent>, ProviderError>;
    fn end(&mut self) -> Result<(), ProviderError>;
}

pub trait StreamingSpeech: Send + Sync {
    fn connect(&self, session: &StreamSession) -> Result<Box<dyn SpeechStream>, ProviderError>;
}
