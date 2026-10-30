//! The local speech model: the pinned catalog, where the files are, their download, and the
//! client for the `rukoo-voice-local` worker that runs them.

mod disk;
mod download;
mod engine;
#[cfg(windows)]
mod job;
mod registry;

pub use download::{extract, Progress, Stage};
pub use engine::{
    hotword_terms, hotwords_string, LocalEngine, LocalOptions, LocalState, LocalStatus, Timed,
};
pub use registry::{
    files_present, validate, Archive, Located, Location, ModelError, ModelErrorKind, ModelFile,
    ModelRegistry, ModelSpec, Verification,
};
