//! Mistral's realtime transcription (`voxtral-mini-transcribe-realtime-*`) over a WebSocket.

use std::time::Duration;

use super::stream::{SpeechStream, StreamSession, StreamingSpeech};
use super::{ProviderConfig, ProviderError};

/// A meeting provider config for Mistral's realtime model. The key never appears in `Debug` or
/// in errors.
#[allow(dead_code)] // Read once the client lands.
pub struct MistralRealtime {
    endpoint: String,
    model: String,
    api_key: String,
    connect_timeout: Duration,
}

impl MistralRealtime {
    /// A config error without a key.
    pub fn new(_cfg: &ProviderConfig) -> Result<MistralRealtime, ProviderError> {
        todo!("MistralRealtime::new")
    }
}

impl StreamingSpeech for MistralRealtime {
    fn connect(&self, _session: &StreamSession) -> Result<Box<dyn SpeechStream>, ProviderError> {
        todo!("MistralRealtime::connect")
    }
}

/// The socket URL for a meeting endpoint: `https` becomes `wss`, the path gets `/realtime` and the
/// query `model=<model>`. `ws://` only for a loopback host.
pub fn realtime_url(_endpoint: &str, _model: &str) -> Result<String, ProviderError> {
    todo!("realtime_url")
}
