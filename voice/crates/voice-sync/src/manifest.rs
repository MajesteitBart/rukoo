//! A meeting's manifest and a data folder's index, both encrypted as `RKV1` objects (spec 2.6).
//! Readers ignore kinds and fields they don't know.

use serde::{Deserialize, Serialize};

use crate::queue::Queue;
use crate::SyncError;

/// `rkv1/<kid>/m/<M>/manifest`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub v: u32,
    pub meeting: String,
    pub gen: u64,
    /// `live`, `processing`, `done` or `failed`.
    pub state: String,
    pub updated_at: u64,
    pub media_removed_at: Option<u64>,
    pub files: Vec<ManifestFile>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestFile {
    pub path: String,
    /// `meeting`, `audio`, `frame`, `video`, `screen`, `timeline` or `transcript`.
    pub kind: String,
    pub object: String,
    pub size: u64,
    pub sha256: String,
    /// Audio only: from the timeline's `segment` line.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub track: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seq: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub t: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub samples: Option<u64>,
}

/// `rkv1/<kid>/index/<W>`: the meetings one data folder synced.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Index {
    pub v: u32,
    pub writer: String,
    pub updated_at: u64,
    pub meetings: Vec<IndexEntry>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexEntry {
    pub id: String,
    pub m: String,
    pub title: String,
    pub created_at: u64,
    pub duration_ms: Option<u64>,
    pub state: String,
    pub gen: u64,
    pub media_removed_at: Option<u64>,
    pub deleted: bool,
}

pub fn manifest_for(
    queue: &Queue,
    meeting: &str,
    state: &str,
    now: u64,
) -> Result<Manifest, SyncError> {
    let _ = (queue, meeting, state, now);
    todo!()
}

/// Every index under `rkv1/<kid>/index/`, keeping the entry with the highest `gen` per meeting.
pub fn merge_indexes(indexes: Vec<Index>) -> Vec<IndexEntry> {
    let _ = indexes;
    todo!()
}
