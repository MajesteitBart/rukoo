//! Which files of a meeting may upload now (spec 2.8).

use std::fs;
use std::path::Path;
use std::time::UNIX_EPOCH;

use voice_meetings::transcript;
use voice_protocol::MeetingState;
use voice_recorder::timeline::{self, History};

use crate::manifest::is_meeting_path;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ScreenFileKind {
    Frame,
    Video,
    Journal,
}

/// One file of the meeting's `screen/` folder, relative to the meeting folder with forward slashes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ScreenFile {
    pub path: String,
    pub kind: ScreenFileKind,
    pub closed: bool,
}

/// What RUK-108 recorded of the screen, for sync. `stopped`: the timeline has `stop`.
pub trait ScreenFiles: Send + Sync {
    fn list(&self, meeting_dir: &Path, stopped: bool) -> Vec<ScreenFile>;
}

/// Lists nothing: Voice without screen recording.
pub struct NoScreen;

impl ScreenFiles for NoScreen {
    fn list(&self, _meeting_dir: &Path, _stopped: bool) -> Vec<ScreenFile> {
        Vec::new()
    }
}

/// A file a scan found that may upload now.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Found {
    pub path: String,
    pub kind: &'static str,
    pub lane: u8,
    /// Bytes on disk. For `transcript.db`, the database and its write-ahead log together: the
    /// upload is a snapshot of them.
    pub size: u64,
    /// Modification time in wall ms. For `transcript.db`, the later of the database's and its
    /// write-ahead log's.
    pub mtime: u64,
    pub track: Option<String>,
    pub seq: Option<u64>,
    pub t: Option<u64>,
    pub samples: Option<u64>,
}

/// What a scan of one meeting found.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Scan {
    /// The timeline has no `stop` yet.
    pub live: bool,
    pub found: Vec<Found>,
    /// A file that may upload exists but couldn't be looked at, so `found` lacks it this time.
    pub unreadable: bool,
}

/// The files of one meeting that may upload now (2.8), and whether the meeting is live.
///
/// - `meeting.json` at once: lane 0 during the meeting, else 1.
/// - Audio segments with a `segment_end` line: lane 0.
/// - Frames the screen journal names: lane 0. Closed video, only once the timeline has `stop`:
///   lane 1. The journal once its own `stop` closed it: lane 1.
/// - `timeline.jsonl` once it has `stop`: lane 1.
/// - `transcript.db` once its outcome is `done` or `failed`: lane 1.
///
/// With `backfill` (the meeting existed when sync turned on) every file of a meeting that isn't
/// live goes to lane 2. Files that aren't on disk, `*.tmp` files, clips and `screen.json` never
/// show up; one that is there but can't be looked at sets `unreadable`.
pub fn scan(dir: &voice_meetings::MeetingDir, screen: &dyn ScreenFiles, backfill: bool) -> Scan {
    let root = dir.path();
    let history = History::from_lines(&dir.timeline());
    let live = !history.stopped;
    let lane = |normal: u8| if backfill && !live { 2 } else { normal };
    let mut found = Vec::new();
    let mut unreadable = false;
    let mut push =
        |path: &str, kind: &'static str, lane: u8, audio: Option<(&str, u64, u64, u64)>| {
            if !is_meeting_path(path) {
                return;
            }
            let (size, mtime) = match look(&root.join(path)) {
                Look::File(size, mtime) => (size, mtime),
                Look::Absent => return,
                Look::Unreadable => {
                    unreadable = true;
                    return;
                }
            };
            let (track, seq, t, samples) = match audio {
                Some((track, seq, t, samples)) => {
                    (Some(track.to_owned()), Some(seq), Some(t), Some(samples))
                }
                None => (None, None, None, None),
            };
            found.push(Found {
                path: path.to_owned(),
                kind,
                lane,
                size,
                mtime,
                track,
                seq,
                t,
                samples,
            });
        };

    push(
        voice_meetings::MEETING_FILE,
        "meeting",
        lane(if live { 0 } else { 1 }),
        None,
    );
    for segment in &history.segments {
        if let Some(samples) = segment.ended {
            push(
                &segment.file,
                "audio",
                lane(0),
                Some((&segment.track, segment.seq, segment.t, samples)),
            );
        }
    }
    for file in screen.list(root, history.stopped) {
        if !file.closed {
            continue;
        }
        match file.kind {
            ScreenFileKind::Frame => push(&file.path, "frame", lane(0), None),
            // Before the stop a repair can still truncate an open video file.
            ScreenFileKind::Video if history.stopped => push(&file.path, "video", lane(1), None),
            ScreenFileKind::Video => {}
            ScreenFileKind::Journal => push(&file.path, "screen", lane(1), None),
        }
    }
    if history.stopped {
        push(timeline::FILE_NAME, "timeline", lane(1), None);
    }
    if let Some(outcome) = transcript::stored_outcome(root) {
        if matches!(outcome.state, MeetingState::Done | MeetingState::Failed) {
            if let Some((size, mtime)) = transcript_stamp(root) {
                found.push(Found {
                    path: transcript::FILE_NAME.to_owned(),
                    kind: "transcript",
                    lane: lane(1),
                    size,
                    mtime,
                    track: None,
                    seq: None,
                    t: None,
                    samples: None,
                });
            }
        }
    }
    Scan {
        live,
        found,
        unreadable,
    }
}

enum Look {
    /// Size and modification time in wall ms.
    File(u64, u64),
    Absent,
    /// There, but its metadata can't be read.
    Unreadable,
}

fn look(path: &Path) -> Look {
    match fs::metadata(path) {
        Ok(meta) if meta.is_file() => Look::File(meta.len(), mtime_ms(&meta)),
        Ok(_) => Look::Absent,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Look::Absent,
        Err(_) => Look::Unreadable,
    }
}

/// Size and modification time (wall ms) of a file, `None` when it isn't one.
pub(crate) fn stat(path: &Path) -> Option<(u64, u64)> {
    match look(path) {
        Look::File(size, mtime) => Some((size, mtime)),
        Look::Absent | Look::Unreadable => None,
    }
}

pub(crate) fn mtime_ms(meta: &fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

/// `transcript.db` with its write-ahead log: their sizes added, the later modification time.
pub(crate) fn transcript_stamp(meeting_dir: &Path) -> Option<(u64, u64)> {
    let (size, mtime) = stat(&meeting_dir.join(transcript::FILE_NAME))?;
    let wal = meeting_dir.join(format!("{}-wal", transcript::FILE_NAME));
    Some(match stat(&wal) {
        Some((wal_size, wal_mtime)) => (size + wal_size, mtime.max(wal_mtime)),
        None => (size, mtime),
    })
}
