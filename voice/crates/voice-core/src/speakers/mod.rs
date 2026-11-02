//! Speaker labels on this computer: NVIDIA Nemotron 3 Diarization in the `rukoo-voice-speakers`
//! worker, whether it can run here, and the client the meeting pipeline talks to.
//!
//! The worker only turns audio into frame probabilities; turning those into speaker turns and
//! stable `call-N` ids happens in voice-meetings.

pub mod api;
mod availability;
mod client;
mod cpu;
mod runtime;

pub use api::*;
pub use availability::{SpeakerLabels, SpeakerOptions, Unavailable};
pub use cpu::{cpu_features, CpuFeatures};
pub use runtime::{locate_runtime, RuntimeInfo, RuntimeLocation};
