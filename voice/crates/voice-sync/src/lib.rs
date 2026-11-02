//! Encrypted sync of meetings to the user's own S3-compatible bucket (voice/README.md, Storage).
pub mod config;
pub mod error;
pub mod format;
pub mod keys;
pub mod manifest;
pub mod names;
pub mod protect;
mod prune;
pub mod queue;
pub mod recovery;
pub mod restore;
pub mod s3;
pub mod scan;
pub mod sync;
mod worker;

pub use config::{BucketRetention, Service, SyncConfig, UrlStyle};
pub use error::{SyncError, SyncErrorKind};
pub use scan::{NoScreen, ScreenFile, ScreenFileKind, ScreenFiles};
pub use sync::{
    BucketSync, KeyInfo, LastError, RemoteMeeting, RestoreState, SyncOptions, SyncState,
    SyncStatus, SyncTiming, TestReport,
};
/// The wrapper the key and the secret come back in, so callers need no `zeroize` dependency.
pub use zeroize::Zeroizing;

/// Sync keeps its files in this folder of Voice's data folder: `<data>/sync`.
pub const SYNC_DIR: &str = "sync";
