//! The client for the `rukoo-voice-speakers` worker: one process per stream, in the kill-on-close
//! job, at below-normal priority.

use super::api::{DiarError, DiarStream, Diarizer};
use super::availability::SpeakerLabels;
use super::runtime::RuntimeInfo;
use crate::local::Located;

/// Opens streams in fresh workers with one verified runtime and model.
#[allow(dead_code)] // Built by SpeakerLabels::diarizer once the client lands.
pub(crate) struct WorkerDiarizer {
    pub(crate) labels: SpeakerLabels,
    pub(crate) runtime: RuntimeInfo,
    pub(crate) model: Located,
}

impl Diarizer for WorkerDiarizer {
    fn open(&self) -> Result<Box<dyn DiarStream>, DiarError> {
        todo!("start rukoo-voice-speakers, then ping, load and open")
    }
}
