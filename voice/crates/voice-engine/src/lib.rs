//! Rukoo Voice's behavior behind one API: dictation, the pill's state, Settings and meetings.
//!
//! The Tauri app (`voice-app`) drives it through [`api::EngineApi`] and renders what comes out of
//! [`api::UiSink`]. Nothing in this crate opens a window, so all of it can be tested without one.

pub mod api;

pub use api::{
    Activity, ApiError, Edge, Engine, EngineApi, EngineOptions, Folder, Locale, MeetingPill,
    Notice, Notification, PillPhase, PillSnapshot, StopReason, Theme, TrayState, UiOptions, UiSink,
};
