//! The crash-safe upload queue, `<data>/sync/queue.db` (spec 2.7).

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::s3::Part;
use crate::SyncError;

/// The queue's file in `<data>/sync`.
pub const QUEUE_FILE: &str = "queue.db";

pub struct Queue {
    conn: Mutex<rusqlite::Connection>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RowState {
    Waiting,
    Uploading,
    Done,
    Gone,
    Removed,
    Lost,
}

/// A row of `files`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Row {
    pub id: i64,
    pub meeting: String,
    pub path: String,
    pub kind: String,
    pub lane: u8,
    pub size: u64,
    pub sha256: String,
    pub object: String,
    pub header: Option<Vec<u8>>,
    pub source: Option<PathBuf>,
    pub state: RowState,
    pub upload_id: Option<String>,
    pub part_size: Option<u64>,
    pub attempts: u32,
    pub next_at: u64,
}

/// The columns of `files` that a scan fills.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NewRow {
    pub meeting: String,
    pub path: String,
    pub kind: String,
    pub lane: u8,
    pub size: u64,
    pub mtime: Option<u64>,
    pub sha256: String,
    pub object: String,
    pub header: Vec<u8>,
    pub source: Option<PathBuf>,
    pub track: Option<String>,
    pub seq: Option<u64>,
    pub t: Option<u64>,
    pub samples: Option<u64>,
    pub created_at: u64,
}

impl Queue {
    pub fn open(sync_dir: &Path) -> Result<Queue, SyncError> {
        let _ = sync_dir;
        todo!()
    }

    pub fn writer(&self) -> String {
        let _ = &self.conn;
        todo!()
    }

    pub fn ensure_meeting(
        &self,
        id: &str,
        mhash: &str,
        title: &str,
        created_at: u64,
    ) -> Result<(), SyncError> {
        let _ = (id, mhash, title, created_at);
        todo!()
    }

    /// Size, modification time and SHA-256 of the newest row for this file.
    pub fn known(
        &self,
        meeting: &str,
        path: &str,
    ) -> Result<Option<(u64, Option<u64>, String)>, SyncError> {
        let _ = (meeting, path);
        todo!()
    }

    /// INSERT OR IGNORE; true when a row was added.
    pub fn insert(&self, row: NewRow) -> Result<bool, SyncError> {
        let _ = row;
        todo!()
    }

    pub fn next(&self, now: u64, live_only: bool) -> Result<Option<Row>, SyncError> {
        let _ = (now, live_only);
        todo!()
    }

    pub fn set_upload(
        &self,
        file: i64,
        upload_id: Option<&str>,
        part_size: Option<u64>,
    ) -> Result<(), SyncError> {
        let _ = (file, upload_id, part_size);
        todo!()
    }

    pub fn part_done(
        &self,
        file: i64,
        number: u16,
        etag: &str,
        size: u64,
    ) -> Result<(), SyncError> {
        let _ = (file, number, etag, size);
        todo!()
    }

    pub fn replace_parts(&self, file: i64, parts: &[Part]) -> Result<(), SyncError> {
        let _ = (file, parts);
        todo!()
    }

    pub fn parts(&self, file: i64) -> Result<Vec<Part>, SyncError> {
        let _ = file;
        todo!()
    }

    pub fn done(&self, file: i64, now: u64) -> Result<(), SyncError> {
        let _ = (file, now);
        todo!()
    }

    pub fn retry(&self, file: i64, next_at: u64, error: &SyncError) -> Result<(), SyncError> {
        let _ = (file, next_at, error);
        todo!()
    }

    pub fn gone(&self, file: i64) -> Result<(), SyncError> {
        let _ = file;
        todo!()
    }

    /// Whether retention must keep the meeting's media: audio, frames or video waiting (2.10).
    pub fn holds_media(
        &self,
        meeting: &str,
        sync_on: bool,
        has_media: bool,
        now: u64,
    ) -> Result<bool, SyncError> {
        let _ = (meeting, sync_on, has_media, now);
        todo!()
    }

    /// Whether the meeting has rows that never reached the bucket (waiting or uploading).
    pub fn has_waiting(&self, meeting: &str) -> Result<bool, SyncError> {
        let _ = meeting;
        todo!()
    }

    /// Marks the meeting's waiting and uploading rows of these kinds `lost`; how many (2.10).
    pub fn mark_lost(&self, meeting: &str, kinds: &[&str]) -> Result<u64, SyncError> {
        let _ = (meeting, kinds);
        todo!()
    }

    pub fn lost(&self) -> Result<u64, SyncError> {
        todo!()
    }

    /// Files, bytes and the oldest created_at of what waits.
    pub fn waiting(&self) -> Result<(u64, u64, Option<u64>), SyncError> {
        todo!()
    }

    pub fn note_error(&self, at: u64, error: &SyncError) -> Result<(), SyncError> {
        let _ = (at, error);
        todo!()
    }

    pub fn restored(&self, meeting: &str, path: &str, now: u64) -> Result<(), SyncError> {
        let _ = (meeting, path, now);
        todo!()
    }

    /// Whether anything was uploaded with this kid (D5).
    pub fn uploaded_with(&self, kid: &str) -> Result<bool, SyncError> {
        let _ = kid;
        todo!()
    }
}
