//! The bridge's answers to `frame.get` and `clip.get`, and the clip files bucket sync and media
//! links share. Platform-neutral: these read the screen folder and cut clips without encoding.
//!
//! Clips are `screen/clips/c-<start 9>-<end 9>-<seq 6>.mp4`, written as `.mp4.tmp`, synced and
//! renamed under a process-wide lock per clip path, and deleted an hour after their last use.

use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde_json::Value;

use crate::frames::FrameIndex;

/// Why a frame or clip can't be had. The bridge maps these to the error codes of the same name.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MediaError {
    NotFound(String),
    NotAvailable(String),
    Failed(String),
}

/// The largest frame image `frame.get` returns; `IMAGE_MAX` in `src/main/agents/tools.js`.
pub const MAX_FRAME_BYTES: u64 = 5 << 20;

/// `frame.get`: `{ frame: { id, at, width, height, text }, image: { type: "image/jpeg", data } }`
/// for the frame at or before `at`, with the image in standard base64.
pub fn frame_reply(
    meeting: &Path,
    recorded_screen: bool,
    at: u64,
    index: &FrameIndex,
) -> Result<Value, MediaError> {
    let _ = (meeting, recorded_screen, at, index);
    todo!()
}

/// `clip.get`: `{ clips: [{ path, start, end, width, height, bytes }] }` with the clips finished
/// by `wait_until`; `clips: []` when none was finished yet.
pub fn clip_reply(
    meeting: &Path,
    recorded_video: bool,
    start: u64,
    end: u64,
    wait_until: Instant,
) -> Result<Value, MediaError> {
    let _ = (meeting, recorded_video, start, end, wait_until);
    todo!()
}

/// Deletes clips under every meeting whose modification time is over `max_age_ms` old. Returns
/// how many it deleted.
pub fn sweep_clips(meetings_root: &Path, now_wall_ms: u64, max_age_ms: u64) -> usize {
    let _ = (meetings_root, now_wall_ms, max_age_ms);
    todo!()
}

/// A cut clip. `start` and `end` are meeting ms of what it holds.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClipFile {
    pub path: PathBuf,
    pub start: u64,
    pub end: u64,
    pub width: u32,
    pub height: u32,
    pub bytes: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClipCut {
    pub clips: Vec<ClipFile>,
    /// Every stretch of the range is cut.
    pub complete: bool,
}

/// How long a background cut may run.
pub const CLIP_BUDGET: Duration = Duration::from_secs(120);

/// One file per stretch of continuous video in `[start, min(end, start + MAX_CLIP_MS)]`, oldest
/// first; a reused clip gets its modification time set to now. A background thread per
/// (meeting, start, end) cuts each clip to `.mp4.tmp`, syncs and renames it under a per-path
/// lock; this call returns at completion or `wait_until`.
pub fn cut_clips(
    meeting: &Path,
    start: u64,
    end: u64,
    wait_until: Instant,
) -> Result<ClipCut, MediaError> {
    let _ = (meeting, start, end, wait_until);
    todo!()
}

/// Bytes the fragments of `[start, end]` take, an upper bound on the clip's size, for
/// `policy::reserve_ok`.
pub fn clip_input_bytes(meeting: &Path, start: u64, end: u64) -> io::Result<u64> {
    let _ = (meeting, start, end);
    todo!()
}

/// The video files, as relative paths, that a clip of `[start, end]` reads.
pub fn video_inputs(meeting: &Path, start: u64, end: u64) -> io::Result<Vec<String>> {
    let _ = (meeting, start, end);
    todo!()
}

/// (frames, video) from `meeting.json`'s `screen`: `off` (false, false), `frames` (true, false),
/// `video` (true, true).
pub fn recorded(meeting: &Path) -> (bool, bool) {
    let _ = meeting;
    todo!()
}

/// The kind of a closed screen file, for bucket sync.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ScreenFileKind {
    Journal,
    Frame,
    Video,
}

/// Every closed screen file that may sync, as relative paths: a frame once journaled, a video
/// file after its `video_end`, the journal after `stop`; never `clips/`, `screen.json` or
/// `*.tmp`.
pub fn closed_files(meeting: &Path) -> io::Result<Vec<(String, ScreenFileKind)>> {
    let _ = meeting;
    todo!()
}
