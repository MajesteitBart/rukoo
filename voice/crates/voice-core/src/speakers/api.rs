//! The diarizer interface between the speaker label worker's client (this crate) and the meeting
//! pipeline (voice-meetings). Frozen: the follower, the client and every test fake build on it.

use std::fmt;

use serde::Serialize;

#[cfg(windows)]
pub const SPEAKERS_EXE_NAME: &str = "rukoo-voice-speakers.exe";
#[cfg(not(windows))]
pub const SPEAKERS_EXE_NAME: &str = "rukoo-voice-speakers";
/// The runtime folder next to the exe.
pub const RUNTIME_FOLDER: &str = "nemo_speech";

/// How a worker stream commits audio, in Nemotron 3 Diarization's streaming setup as Ownkey runs
/// it live: a chunk of 38 model frames of 80 ms (3.04 s) once one more frame of right context
/// came in.
pub const CHUNK_FRAMES: u32 = 38;
pub const RIGHT_CONTEXT_FRAMES: u32 = 1;
/// 16 kHz samples per model frame: 80 ms.
pub const MODEL_FRAME_SAMPLES: u64 = 1_280;

/// Frame probabilities a stream committed: `frames` rows of `speakers` values, frame-major.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Probs {
    pub first_frame: u64,
    pub frames: usize,
    pub speakers: usize,
    pub values: Vec<f32>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct StreamGeometry {
    pub speakers: usize,
    pub seconds_per_frame: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DiarErrorKind {
    Cpu,
    Runtime,
    Model,
    Behind,
    Crashed,
    Timeout,
    Failed,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DiarError {
    pub kind: DiarErrorKind,
    pub message: String,
}

impl DiarError {
    pub fn new(kind: DiarErrorKind, message: impl Into<String>) -> DiarError {
        DiarError {
            kind,
            message: message.into(),
        }
    }
}

impl fmt::Display for DiarError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for DiarError {}

/// One diarizer stream, owned by one follower thread.
pub trait DiarStream: Send {
    fn geometry(&self) -> StreamGeometry;
    /// Pushes 16 kHz mono samples; returns the frames committed since the last call.
    fn push(&mut self, pcm: &[i16]) -> Result<Probs, DiarError>;
    /// Flushes the tail. No pushes after it.
    fn finish(&mut self) -> Result<Probs, DiarError>;
    fn worker_pid(&self) -> Option<u32> {
        None
    }
}

/// Opens a fresh stream, in a fresh worker process for the real one.
pub trait Diarizer: Send + Sync {
    fn open(&self) -> Result<Box<dyn DiarStream>, DiarError>;
}
