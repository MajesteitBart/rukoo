//! The shared core of Rukoo Voice: where files live, settings and the Ownkey import, text
//! cleanup, speech and rewrite providers, the local model client and the update check.
//!
//! Nothing in here touches the keyboard, the clipboard or audio devices; that is voice-input's
//! and the recorder's job.

pub mod cleanup;
pub mod config;
pub mod consent;
mod fsutil;
pub mod local;
pub mod ownkey;
pub mod paths;
pub mod prompts;
pub mod providers;
pub mod update;

pub use config::Config;
pub use local::{LocalEngine, ModelRegistry};
pub use providers::{
    list_models, rewriter, speech_to_text, Activity, AudioProviderConfig, ErrorKind, Hints,
    ProviderConfig, ProviderError, Recognized, RewriteProviderConfig, RewriteRequest, Rewriter,
    SpeechToText,
};
