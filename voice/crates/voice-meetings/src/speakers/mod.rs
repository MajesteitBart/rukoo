//! Speaker labels for a meeting's call track: who the pipeline asks (Nemotron on this computer or
//! Mistral's realtime stream), and what Settings reads back about it. The public types here are
//! frozen; the follower, the binarizer and the matching are private modules of this one.

pub(crate) mod binarizer;
pub(crate) mod clock;
pub(crate) mod follower;
pub(crate) mod matching;
pub(crate) mod stream;
pub(crate) mod turns;

use std::sync::Arc;

use serde::Serialize;
use voice_core::providers::stream::StreamingSpeech;
use voice_core::speakers::Diarizer;

#[derive(Clone)]
pub enum Labels {
    /// The whole call is `call-1`, as in Voice 0.1. `reason` is a Settings reason code, such as
    /// `off`, `cpu` or `runtime`.
    Off { reason: String },
    /// Nemotron on this computer.
    Local { diarizer: Arc<dyn Diarizer> },
}

#[derive(Clone)]
pub struct StreamOptions {
    pub speech: Arc<dyn StreamingSpeech>,
    pub diarize: bool,
    pub delay_ms: u32,
    pub language: Option<String>,
    pub context_bias: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LabelState {
    Off,
    Starting,
    Matching,
    Listening,
    CatchingUp,
    Restarting,
    Finished,
    Failed,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LabelStatus {
    pub mode: String,
    pub state: LabelState,
    pub reason: Option<String>,
    pub epoch: u64,
    pub speakers: u32,
    pub settled_ms: Option<u64>,
    pub worker_pid: Option<u32>,
}
