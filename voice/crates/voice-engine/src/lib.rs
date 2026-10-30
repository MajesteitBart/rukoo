//! Rukoo Voice's behavior behind one API: dictation, the pill's state, Settings and meetings.
//!
//! The Tauri app (`voice-app`) drives it through [`api::EngineApi`] and renders what comes out of
//! [`api::UiSink`]. Nothing in this crate opens a window, so all of it can be tested without one.

pub mod api;

pub use api::{
    Activity, ApiError, Edge, Engine, EngineApi, EngineOptions, Folder, Locale, MeetingPill,
    Notice, Notification, PillPhase, PillSnapshot, StopReason, Theme, TrayState, UiOptions, UiSink,
};

/// Starts Voice: loads Settings (running the first-run Ownkey import when it applies), starts the
/// hotkeys, reattaches to a recorder that is still recording, finishes meetings that were cut off,
/// and opens the bridge for Rukoo. Output goes to `sink` from here on.
pub fn start(options: EngineOptions, sink: std::sync::Arc<dyn UiSink>) -> Result<Engine, ApiError> {
    let _ = (options, sink);
    Err(ApiError::new("not_ready", "The engine isn't built yet."))
}
