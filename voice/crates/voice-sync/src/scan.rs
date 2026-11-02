//! Which files of a meeting may upload now (spec 2.8).

use std::path::Path;

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
    pub size: u64,
    pub mtime: u64,
    pub track: Option<String>,
    pub seq: Option<u64>,
    pub t: Option<u64>,
    pub samples: Option<u64>,
}

/// The files of one meeting that may upload now (2.8), and whether the meeting is live.
pub fn scan(
    dir: &voice_meetings::MeetingDir,
    screen: &dyn ScreenFiles,
    backfill: bool,
) -> (bool, Vec<Found>) {
    let _ = (dir, screen, backfill);
    todo!()
}
