//! Recognizers for meeting windows.
//!
//! Any [`SpeechToText`] works: a cloud provider gives text, and each window becomes one passage.
//! A recognizer that also times its words, as Orukeet does through
//! [`LocalEngine::transcribe_timed`], gets 0.6 s of context on each side of a window, and its
//! passages split at pauses inside the window and keep their word timings.

use std::sync::Arc;

use voice_core::{Hints, LocalEngine, ProviderError, SpeechToText};

/// Recognized text with the start of every word piece.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct TimedText {
    pub text: String,
    /// Word pieces as the recognizer returns them; a piece that starts with whitespace starts a
    /// word.
    pub tokens: Vec<String>,
    /// The start of each piece in seconds, counted from the first sample passed in.
    pub timestamps: Vec<f64>,
    /// The length of each piece in seconds, when the recognizer gives it; 0.2 s otherwise.
    pub durations: Vec<f64>,
    pub language: Option<String>,
}

/// A recognizer that times its words.
pub trait TimedSpeechToText: Send + Sync {
    /// pcm: 16 kHz mono i16.
    fn transcribe_timed(&self, pcm: &[i16], hints: &Hints) -> Result<TimedText, ProviderError>;
}

impl TimedSpeechToText for LocalEngine {
    fn transcribe_timed(&self, pcm: &[i16], hints: &Hints) -> Result<TimedText, ProviderError> {
        let timed = LocalEngine::transcribe_timed(self, pcm, hints)?;
        Ok(TimedText {
            text: timed.text,
            tokens: timed.tokens,
            timestamps: timed.timestamps,
            durations: timed.durations,
            language: None,
        })
    }
}

/// The recognizer a pipeline uses.
#[derive(Clone)]
pub(crate) enum Recognizer {
    Timed(Arc<dyn TimedSpeechToText>),
    Text(Arc<dyn SpeechToText>),
}

/// What a recognizer made of one window.
pub(crate) enum Heard {
    Timed(TimedText),
    Text(String, Option<String>),
}

impl Recognizer {
    pub(crate) fn is_timed(&self) -> bool {
        matches!(self, Recognizer::Timed(_))
    }

    pub(crate) fn recognize(&self, pcm: &[i16], hints: &Hints) -> Result<Heard, ProviderError> {
        match self {
            Recognizer::Timed(stt) => stt.transcribe_timed(pcm, hints).map(Heard::Timed),
            Recognizer::Text(stt) => stt
                .transcribe(pcm, hints)
                .map(|r| Heard::Text(r.text, r.language)),
        }
    }
}
