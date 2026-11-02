//! The facade the engine uses: one [`BucketSync`] per data folder.

use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;

use crate::protect::Protector;
use crate::worker::Shared;
use crate::{ScreenFiles, SyncConfig, SyncError, UrlStyle};

/// The worker's clocks, rates and sizes. Tests shorten them.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SyncTiming {
    /// How often meetings that record or haven't synced are scanned.
    pub scan_live: Duration,
    /// How often every meeting is scanned.
    pub scan_all: Duration,
    /// Bytes per second while a meeting records.
    pub live_rate: u64,
    pub backoff_min: Duration,
    pub backoff_max: Duration,
    /// A live meeting's manifest at most this often.
    pub manifest_live: Duration,
    /// The index this long after the last manifest changed.
    pub index_debounce: Duration,
    /// Bucket retention runs this often.
    pub prune_every: Duration,
    pub connect_timeout: Duration,
    pub request_timeout: Duration,
    /// Multipart part size; every part but the last has exactly this size.
    pub part_size: u64,
    /// Larger ciphertexts upload in parts.
    pub single_max: u64,
}

impl Default for SyncTiming {
    fn default() -> SyncTiming {
        SyncTiming {
            scan_live: Duration::from_secs(10),
            scan_all: Duration::from_secs(10 * 60),
            live_rate: 163_840,
            backoff_min: Duration::from_secs(2),
            backoff_max: Duration::from_secs(5 * 60),
            manifest_live: Duration::from_secs(5 * 60),
            index_debounce: Duration::from_secs(60),
            prune_every: Duration::from_secs(24 * 60 * 60),
            connect_timeout: Duration::from_secs(10),
            request_timeout: Duration::from_secs(120),
            part_size: 8 << 20,
            single_max: 16 << 20,
        }
    }
}

#[derive(Clone)]
pub struct SyncOptions {
    /// <data>; sync keeps its files in <data>/sync.
    pub data_dir: PathBuf,
    /// Library::root() (library.rs:168).
    pub meetings_dir: PathBuf,
    pub protector: Arc<dyn Protector>,
    pub screen: Arc<dyn ScreenFiles>,
    /// Wall ms.
    pub now: Arc<dyn Fn() -> u64 + Send + Sync>,
    /// May this many bytes be written now (reserve_ok, contract 2.2).
    pub reserve: Arc<dyn Fn(u64) -> bool + Send + Sync>,
    pub timing: SyncTiming,
    /// Status changed; called at most twice a second.
    pub on_change: Arc<dyn Fn() + Send + Sync>,
}

/// `sync` in Settings' state (voice/ui/API.md). The engine adds `screenRecording`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub available: bool,
    pub state: SyncState,
    pub waiting: u64,
    pub waiting_bytes: u64,
    pub oldest_waiting: Option<u64>,
    pub last_upload: Option<u64>,
    pub last_error: Option<LastError>,
    pub failing_since: Option<u64>,
    /// Files removed locally before they reached the bucket (2.10).
    pub lost: u64,
    pub key: KeyInfo,
    pub restore: RestoreState,
    pub other_keys: u32,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SyncState {
    #[default]
    Off,
    Idle,
    Uploading,
    Live,
    Retrying,
    Failing,
    Key,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct LastError {
    pub at: u64,
    pub code: String,
    pub message: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct KeyInfo {
    pub exists: bool,
    pub id: Option<String>,
    pub exported: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct RestoreState {
    /// idle | listing | available | restoring | done | failed
    pub state: &'static str,
    pub available: u32,
    pub done: u32,
    pub total: u32,
    pub error: Option<String>,
}

impl Default for RestoreState {
    fn default() -> RestoreState {
        RestoreState {
            state: "idle",
            available: 0,
            done: 0,
            total: 0,
            error: None,
        }
    }
}

/// A meeting in the bucket that isn't on this computer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RemoteMeeting {
    pub id: String,
    pub title: String,
    pub started_at: u64,
    pub duration_ms: Option<u64>,
}

/// What a passed Test connection found.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TestReport {
    /// The URL style that worked; the engine stores it as `urlStyle`.
    pub url_style: UrlStyle,
    /// Other encryption keys with meetings in this bucket.
    pub other_keys: u32,
}

pub struct BucketSync {
    shared: Arc<Shared>,
}

impl BucketSync {
    pub fn open(opts: SyncOptions) -> Result<BucketSync, SyncError> {
        let _ = opts;
        todo!()
    }

    /// None turns sync off. Wakes the worker.
    pub fn configure(&self, cfg: Option<SyncConfig>) {
        let _ = (&self.shared, cfg);
        todo!()
    }

    /// Probes `cfg.url_style`, then the other style when the first fails with bucket, not found or
    /// endpoint. Uses the saved secret (NoSecret without one).
    pub fn test(&self, cfg: &SyncConfig) -> Result<TestReport, SyncError> {
        let _ = cfg;
        todo!()
    }

    pub fn save_secret(&self, secret: &str) -> Result<(), SyncError> {
        let _ = secret;
        todo!()
    }

    pub fn remove_secret(&self) -> Result<(), SyncError> {
        todo!()
    }

    pub fn secret_saved(&self) -> bool {
        todo!()
    }

    /// (code, id); creates the key when there is none.
    pub fn show_key(&self) -> Result<(String, String), SyncError> {
        todo!()
    }

    pub fn mark_key_saved(&self) -> Result<(), SyncError> {
        todo!()
    }

    /// Refused with KeyInUse once anything was uploaded with this computer's key and that key
    /// still opens (D5).
    pub fn import_key(&self, code: &str) -> Result<String, SyncError> {
        let _ = code;
        todo!()
    }

    pub fn status(&self) -> SyncStatus {
        todo!()
    }

    /// Look at the meetings now: one stopped or became done.
    pub fn nudge(&self) {
        todo!()
    }

    /// Retention's hold (2.10). `true` on a database error or a poisoned lock: a broken queue never lets media go.
    pub fn holds_media(&self, meeting: &str) -> bool {
        let _ = meeting;
        todo!()
    }

    /// `true` on error, like holds_media.
    pub fn has_waiting(&self, meeting: &str) -> bool {
        let _ = meeting;
        todo!()
    }

    pub fn mark_lost(&self, meeting: &str, kinds: &[&str]) -> u64 {
        let _ = (meeting, kinds);
        todo!()
    }

    /// On, with a readable key and a saved secret.
    pub fn can_fetch(&self) -> bool {
        todo!()
    }

    pub fn in_bucket(&self, meeting: &str, path: &str) -> bool {
        let _ = (meeting, path);
        todo!()
    }

    pub fn ensure_local(
        &self,
        meeting: &str,
        paths: &[String],
        cancel: &AtomicBool,
    ) -> Result<(), SyncError> {
        let _ = (meeting, paths, cancel);
        todo!()
    }

    pub fn remote_meetings(&self) -> Result<Vec<RemoteMeeting>, SyncError> {
        todo!()
    }

    pub fn restore(
        &self,
        ids: Vec<String>,
        on_restored: Box<dyn Fn(&str) + Send>,
    ) -> Result<(), SyncError> {
        let _ = (ids, on_restored);
        todo!()
    }

    pub fn forget_meeting(&self, meeting: &str, delete_objects: bool) -> Result<(), SyncError> {
        let _ = (meeting, delete_objects);
        todo!()
    }

    pub fn shutdown(&self) {
        todo!()
    }
}
