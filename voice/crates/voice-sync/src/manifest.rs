//! A meeting's manifest and a data folder's index, both encrypted as `RKV1` objects (spec 2.6).
//! Readers ignore kinds and fields they don't know.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::queue::Queue;
use crate::SyncError;

/// The manifest and index format this version writes.
pub const VERSION: u32 = 1;

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
    #[serde(default)]
    pub title: String,
    pub created_at: u64,
    #[serde(default)]
    pub duration_ms: Option<u64>,
    pub state: String,
    pub gen: u64,
    #[serde(default)]
    pub media_removed_at: Option<u64>,
    #[serde(default)]
    pub deleted: bool,
}

/// The meeting's next manifest: the newest version of each of its files that reached the bucket.
/// Counts the meeting's `gen` up by one, so call it once per version that goes up.
pub fn manifest_for(
    queue: &Queue,
    meeting: &str,
    state: &str,
    now: u64,
) -> Result<Manifest, SyncError> {
    let files = queue.manifest_rows(meeting)?;
    let (gen, media_removed_at) = queue.start_manifest(meeting, now)?;
    Ok(Manifest {
        v: VERSION,
        meeting: meeting.to_owned(),
        gen,
        state: state.to_owned(),
        updated_at: now,
        media_removed_at,
        files,
    })
}

/// Every index under `rkv1/<kid>/index/`, keeping the entry with the highest `gen` per meeting.
/// Sorted by meeting id, newest first.
pub fn merge_indexes(indexes: Vec<Index>) -> Vec<IndexEntry> {
    let mut by_id: BTreeMap<String, IndexEntry> = BTreeMap::new();
    for index in indexes {
        for entry in index.meetings {
            match by_id.get(&entry.id) {
                Some(have) if have.gen > entry.gen => {}
                // An equal gen from another writer: a deletion wins, so a forgotten meeting stays
                // forgotten.
                Some(have) if have.gen == entry.gen && !entry.deleted => {}
                _ => {
                    by_id.insert(entry.id.clone(), entry);
                }
            }
        }
    }
    by_id.into_values().rev().collect()
}

/// Whether `path` is a file of a meeting folder that sync uploads and a restore may write (2.11):
/// `meeting.json`, `timeline.jsonl`, `transcript.db`, `audio/(mic|call)/NNNNNN.wav`,
/// `screen/journal.jsonl`, `screen/frames/f-NNNNNNNNN.jpg` or `screen/video/NNNNNN.mp4`.
pub fn is_meeting_path(path: &str) -> bool {
    match path {
        "meeting.json" | "timeline.jsonl" | "transcript.db" | "screen/journal.jsonl" => true,
        _ => {
            if let Some(rest) = path
                .strip_prefix("audio/mic/")
                .or_else(|| path.strip_prefix("audio/call/"))
            {
                return digits_then(rest, 6, ".wav");
            }
            if let Some(rest) = path.strip_prefix("screen/frames/f-") {
                return digits_then(rest, 9, ".jpg");
            }
            if let Some(rest) = path.strip_prefix("screen/video/") {
                return digits_then(rest, 6, ".mp4");
            }
            false
        }
    }
}

/// `n` ASCII digits followed by exactly `suffix`.
fn digits_then(s: &str, n: usize, suffix: &str) -> bool {
    s.len() == n + suffix.len()
        && s.as_bytes()[..n].iter().all(u8::is_ascii_digit)
        && s.is_char_boundary(n)
        && &s[n..] == suffix
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn meeting_paths_are_checked_exactly() {
        for ok in [
            "meeting.json",
            "timeline.jsonl",
            "transcript.db",
            "audio/mic/000001.wav",
            "audio/call/123456.wav",
            "screen/journal.jsonl",
            "screen/frames/f-000012345.jpg",
            "screen/video/000002.mp4",
        ] {
            assert!(is_meeting_path(ok), "{ok}");
        }
        for bad in [
            "",
            "../meeting.json",
            "../../evil.txt",
            "audio/mic/00001.wav",
            "audio/mic/0000001.wav",
            "audio/other/000001.wav",
            "audio/mic/000001.wav/..",
            "audio\\mic\\000001.wav",
            "screen/frames/f-12345678.jpg",
            "screen/clips/c-000000000-000001000-000001.mp4",
            "screen/screen.json",
            "screen/video/000001.mp4.tmp",
            "/meeting.json",
            "meeting.json ",
            "audio/mic/00000a.wav",
            "audio/mic/00000é.wav",
        ] {
            assert!(!is_meeting_path(bad), "{bad}");
        }
    }

    fn entry(id: &str, gen: u64, deleted: bool) -> IndexEntry {
        IndexEntry {
            id: id.into(),
            m: format!("m{gen}"),
            title: String::new(),
            created_at: 0,
            duration_ms: None,
            state: "done".into(),
            gen,
            media_removed_at: None,
            deleted,
        }
    }

    #[test]
    fn merging_keeps_the_highest_gen() {
        let a = Index {
            v: 1,
            writer: "a".into(),
            updated_at: 0,
            meetings: vec![entry("m-1", 3, false), entry("m-2", 1, false)],
        };
        let b = Index {
            v: 1,
            writer: "b".into(),
            updated_at: 0,
            meetings: vec![
                entry("m-1", 2, false),
                entry("m-2", 4, true),
                entry("m-3", 1, false),
            ],
        };
        let merged = merge_indexes(vec![a, b]);
        let got: Vec<(String, u64, bool)> = merged
            .iter()
            .map(|e| (e.id.clone(), e.gen, e.deleted))
            .collect();
        assert_eq!(
            got,
            vec![
                ("m-3".into(), 1, false),
                ("m-2".into(), 4, true),
                ("m-1".into(), 3, false)
            ]
        );
    }

    #[test]
    fn unknown_fields_and_kinds_are_ignored() {
        let text = r#"{"v":1,"meeting":"m-20261030-171203-4f2a","gen":2,"state":"done","updatedAt":5,
            "mediaRemovedAt":null,"later":true,
            "files":[{"path":"meeting.json","kind":"meeting","object":"o","size":1,"sha256":"s","extra":1},
                     {"path":"x","kind":"hologram","object":"o2","size":2,"sha256":"s2"}]}"#;
        let m: Manifest = serde_json::from_str(text).unwrap();
        assert_eq!(m.files.len(), 2);
        assert_eq!(m.files[1].kind, "hologram");
        let entry: IndexEntry = serde_json::from_str(
            r#"{"id":"m-1","m":"x","createdAt":1,"state":"done","gen":1,"new":"field"}"#,
        )
        .unwrap();
        assert!(!entry.deleted);
    }
}
