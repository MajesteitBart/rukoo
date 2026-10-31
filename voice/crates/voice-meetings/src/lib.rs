//! Meetings in Rukoo Voice: the library of meeting folders, `transcript.db`, live transcription
//! from the recorded files, the events Rukoo gets, and audio retention.
//!
//! The recorder (`rukoo-voice-recorder`) writes each meeting folder; this crate only reads the
//! audio and the timeline, so it can crash or restart while the recording goes on. The folder
//! format is voice/RECORDING.md, the events are voice/PROTOCOL.md.
//!
//! ```no_run
//! # use std::sync::Arc;
//! # use voice_meetings::*;
//! # fn run(data: &std::path::Path, stt: Arc<dyn voice_core::SpeechToText>, args: CreateMeeting) -> std::io::Result<()> {
//! let library = Library::open(data)?;
//! let log = voice_bridge::EventLog::open(data).expect("bridge.db opens");
//! let meeting = library.create(&args)?;
//! // ... start rukoo-voice-recorder on meeting.path() ...
//! let pipeline = Pipeline::start(meeting, log.clone(), PipelineOptions::new(stt));
//! // ... the recorder stops; the pipeline sends processing, then done ...
//! pipeline.shutdown();
//! retention_sweep(&library, &log, |_| Retention::Days7);
//! # Ok(()) }
//! ```

mod library;
mod pipeline;
pub mod reader;
mod retention;
pub mod segmentation;
mod stt;
pub mod transcript;
pub mod watcher;

#[cfg(test)]
mod test_support;

pub use library::{CreateMeeting, Library, MeetingDir, MeetingFile, MEETINGS, MEETING_FILE};
pub use pipeline::{
    speaker_of, ConsentCheck, Pipeline, PipelineHandle, PipelineOptions, PipelineState, Timing,
};
pub use reader::TrackReader;
pub use retention::{retention_sweep, retention_sweep_at, WEEK_MS};
pub use stt::{TimedSpeechToText, TimedText};
pub use transcript::Transcript;
pub use voice_core::config::Retention;
pub use watcher::TimelineWatcher;
